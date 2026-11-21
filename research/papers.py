"""기술동향: OpenAlex(연도별 발표량·주요 기관·논문 메타데이터) + Liner Scholar(추가 논문) + 경쟁사 소속 논문.

OpenAlex 요청 형식은 261117_Liner/05_scholar_api_benchmark/collect.py 와 같다(키는 Authorization 헤더로만 전송).
논문을 하나씩 모델에 보내지 않고, 기술별 상위 논문을 묶어 한 번에 요약한다.
"""
from __future__ import annotations

import re
import time
from datetime import date

import httpx

from research import common
from research.liner import DATA_RULE, Liner

OA = "https://api.openalex.org"
CACHE_HOURS = 72
TYPES = "article|preprint|conference-paper|review"
SEL = ("id,doi,display_name,publication_year,publication_date,primary_location,authorships,cited_by_count,"
       "abstract_inverted_index")
_http = httpx.Client(timeout=60)


def _oa(path: str, params: dict) -> dict:
    hit = common.cache_get("openalex", {"p": path, **params}, CACHE_HOURS)
    if hit is not None:
        return hit
    headers = {"User-Agent": "liner-research-agent/0.3"}
    key = common.env("OPENALEX_API_KEY")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    for attempt in range(2):
        try:
            r = _http.get(OA + path, params=params, headers=headers)
        except httpx.HTTPError as e:
            if attempt:
                raise RuntimeError(f"OpenAlex 네트워크 오류({type(e).__name__})") from None
            time.sleep(2)
            continue
        if r.status_code in (429, 500, 502, 503, 504) and not attempt:
            time.sleep(min(float(r.headers.get("retry-after") or 3), 20))
            continue
        if r.status_code != 200:
            raise RuntimeError(common.scrub_text(f"OpenAlex HTTP {r.status_code}: {r.text[:150]}"))
        data = r.json()
        common.cache_put("openalex", {"p": path, **params}, data)
        time.sleep(0.12)
        return data
    raise RuntimeError("OpenAlex 호출 실패")


def _abstract(inv: dict | None) -> str:
    if not inv:
        return ""
    pos = sorted((p, w) for w, ps in inv.items() for p in ps)
    return " ".join(w for _, w in pos)


def _work(w: dict) -> dict:
    loc = w.get("primary_location") or {}
    authors, insts = [], []
    for a in w.get("authorships") or []:
        authors.append((a.get("author") or {}).get("display_name") or "")
        insts += [i.get("display_name") or "" for i in a.get("institutions") or []]
    url = w.get("doi") or loc.get("landing_page_url") or w.get("id") or ""
    return {"제목": w.get("display_name") or "", "연도": w.get("publication_year") or "", "발표일": w.get("publication_date") or "",
            "저자": "; ".join(a for a in authors[:6] if a) + (" 외" if len(authors) > 6 else ""),
            "소속": "; ".join(list(dict.fromkeys(i for i in insts if i))[:5]),
            "학술지·학회": ((loc.get("source") or {}).get("display_name")) or "", "피인용": w.get("cited_by_count") or 0,
            "초록": _abstract(w.get("abstract_inverted_index"))[:1500], "링크": url, "출처": "OpenAlex",
            "_raw_aff": " ".join(s for a in w.get("authorships") or [] for s in (a.get("raw_affiliation_strings") or []))}


def _flt(since: str) -> str:
    return f"type:{TYPES},from_publication_date:{since}"


def topic_trend(keyword_en: str, years: int = 5) -> dict:
    """기술 한 분야: 연도별 발표량, 주요 연구기관, 최근 논문(관련도순), 영향력 논문(피인용순)."""
    start_year = date.today().year - years
    since = f"{start_year}-01-01"
    out = {"keyword": keyword_en, "by_year": {}, "institutions": [], "recent": [], "cited": [], "errors": []}
    try:
        g = _oa("/works", {"search": keyword_en, "filter": _flt(since), "group_by": "publication_year"})
        out["by_year"] = {int(x["key"]): x["count"] for x in g.get("group_by") or [] if str(x.get("key")).isdigit()}
    except RuntimeError as e:
        out["errors"].append(str(e))
    try:
        recent_since = f"{date.today().year - 2}-01-01"
        g = _oa("/works", {"search": keyword_en, "filter": _flt(recent_since), "group_by": "authorships.institutions.id"})
        out["institutions"] = [{"기관": x.get("key_display_name"), "논문 수": x.get("count")} for x in (g.get("group_by") or [])[:10]
                               if x.get("key_display_name") and x.get("key_display_name") != "unknown"]
    except RuntimeError as e:
        out["errors"].append(str(e))
    try:
        d = _oa("/works", {"search": keyword_en, "filter": _flt(f"{date.today().year - 2}-01-01"), "per_page": 12, "select": SEL})
        out["recent"] = [_work(w) for w in d.get("results") or []]
        d = _oa("/works", {"search": keyword_en, "filter": _flt(since), "sort": "cited_by_count:desc", "per_page": 6, "select": SEL})
        out["cited"] = [_work(w) for w in d.get("results") or []]
    except RuntimeError as e:
        out["errors"].append(str(e))
    return out


def trend_label(by_year: dict[int, int]) -> str:
    """최근 2개 완결 연도 대비 증가/감소(올해는 진행 중이라 비교에서 뺀다)."""
    this = date.today().year
    a, b = by_year.get(this - 2), by_year.get(this - 1)
    if not a or b is None:
        return "판단 자료 부족"
    pct = (b - a) / a * 100
    return f"{'증가' if pct > 5 else '감소' if pct < -5 else '정체'} ({this - 2}→{this - 1}: {pct:+.0f}%)"


def company_papers(company: str, english: str, keywords_en: list[str], years: int = 5) -> dict:
    """경쟁사(또는 대상기업)가 저자 소속으로 직접 참여한 논문. 원문 소속 문자열을 재확인한 것만 '직접 참여'로 둔다."""
    since = f"{date.today().year - years}-01-01"
    out = {"company": company, "mode": "", "works": [], "error": ""}
    names = [n for n in dict.fromkeys([english, company]) if n and len(n) >= 3]
    if not names:
        return out
    tokens = [common.norm_name(n) for n in names]
    try:
        inst_ids = []
        for n in names[:1]:
            res = _oa("/institutions", {"search": n, "per_page": 5, "select": "id,display_name,type,country_code"}).get("results") or []
            inst_ids += [i["id"].rsplit("/", 1)[-1] for i in res
                         if i.get("type") == "company" and common.norm_name(i.get("display_name") or "").startswith(tokens[0])]
        works = []
        if inst_ids:
            out["mode"] = "OpenAlex 기관 ID"
            f = f"authorships.institutions.id:{'|'.join(inst_ids[:3])},from_publication_date:{since}"
            q = " OR ".join(f'"{k}"' for k in keywords_en[:6])
            d = _oa("/works", {"filter": f, "search": q, "per_page": 15, "select": SEL})
            works = d.get("results") or []
            if not works:
                d = _oa("/works", {"filter": f, "sort": "publication_date:desc", "per_page": 15, "select": SEL})
                works = d.get("results") or []
            rows = [_work(w) for w in works]
        else:
            out["mode"] = "원문 소속 문자열 검색"
            f = f'raw_affiliation_strings.search:"{names[0]}",from_publication_date:{since}'
            d = _oa("/works", {"filter": f, "sort": "publication_date:desc", "per_page": 20, "select": SEL + ",authorships"})
            rows = [_work(w) for w in d.get("results") or []]
            rows = [r for r in rows if any(t in common.norm_name(r["_raw_aff"] + " " + r["소속"]) for t in tokens)]
        for r in rows:
            r["경쟁사"] = company
            r["직접 참여"] = "소속 확인"
        out["works"] = rows
    except RuntimeError as e:
        out["error"] = str(e)
    return out


def scholar_extra(liner: Liner, keyword_en: str, keyword_ko: str = "") -> list[dict]:
    rows = []
    for q, lang in ((keyword_en, "en"), (keyword_ko, "ko")):
        if not q:
            continue
        for r in liner.scholar(q, lang=lang, max_results=10, label="tech_scholar"):
            rows.append({"제목": r.get("title") or "", "연도": str(r.get("date") or "")[:4], "발표일": r.get("date") or "",
                         "저자": "; ".join((r.get("authors") or [])[:6]), "소속": "", "학술지·학회": r.get("journal") or "",
                         "피인용": r.get("citationCount") or 0, "초록": str(r.get("description") or "")[:1500],
                         "링크": r.get("url") or "", "출처": "Liner Scholar"})
    return rows


def merge_unique(*lists: list[dict]) -> list[dict]:
    seen, out = set(), []
    for lst in lists:
        for r in lst:
            k = re.sub(r"[^0-9a-z가-힣]", "", (r.get("제목") or "").lower())[:80]
            if not k or k in seen:
                continue
            seen.add(k)
            out.append(r)
    return out


SUMMARY_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["topics"],
    "properties": {"topics": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["topic", "research_summary", "relevance", "key_papers"],
        "properties": {
            "topic": {"type": "string"},
            "research_summary": {"type": "string", "description": "이 기술의 최근 연구 흐름 3~4문장(자료 근거)"},
            "relevance": {"type": "string", "description": "대상 기업 기술·제품과의 관련성 1~2문장"},
            "key_papers": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["index", "point"],
                "properties": {"index": {"type": "integer", "description": "논문 번호"},
                               "point": {"type": "string", "description": "핵심 연구내용 한 문장(한국어)"}}}},
        }}}},
}


def summarize(company: str, business: str, topics: list[dict], liner: Liner) -> dict:
    """기술별 상위 논문(제목+초록 일부)을 묶어 모델 1회로 연구 흐름·관련성·핵심 논문 요지를 뽑는다."""
    if not liner.ok or not topics:
        return {}
    blocks, index = [], []
    for t in topics:
        lines = [f"## 기술: {t['name']} (연도별 논문 수 {t['trend'].get('by_year')})"]
        for p in t["papers"][:6]:
            index.append((t["name"], p))
            lines.append(f"[{len(index) - 1}] {p['제목']} ({p['연도']}) — {p['초록'][:260]}")
        blocks.append("\n".join(lines))
    system = (f"당신은 기술 동향 분석가입니다. {DATA_RULE}\n기술별로 최근 연구 흐름, 대상 기업과의 관련성, 핵심 논문 2~3편의 요지를 한국어로 씁니다.")
    out = liner.json(system, f"대상 기업: {company}\n사업: {business}\n\n<자료>\n" + "\n\n".join(blocks) + "\n</자료>",
                     SUMMARY_SCHEMA, name="paper_summary", max_tokens=6000)
    res = {}
    for t in (out or {}).get("topics") or []:
        keys = []
        for kp in t.get("key_papers") or []:
            i = kp.get("index")
            if isinstance(i, int) and 0 <= i < len(index):
                keys.append({"제목": index[i][1]["제목"], "요지": kp.get("point") or "", "링크": index[i][1]["링크"]})
        res[t.get("topic") or ""] = {"summary": t.get("research_summary") or "", "relevance": t.get("relevance") or "", "key_papers": keys}
    return res
