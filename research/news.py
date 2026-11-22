"""뉴스: NAVER 뉴스 검색 API(중심) + Liner 웹 검색(보완), 중복 기사 정리, 주제 분류, Liner 요약 1회.

NAVER 요청 형식은 261117_Liner/03_news_api_benchmark/newsbench/clients.py 와 같다(무료, 키는 헤더로만 전송).
기사를 하나씩 모델에 보내지 않고 정리된 목록을 한 번에 묶어 요약한다.
"""
from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

import httpx

from research import common
from research.liner import DATA_RULE, Liner, numbered

NAVER_URL = "https://openapi.naver.com/v1/search/news.json"
_NAVER = httpx.Client(timeout=30)  # 연결 재사용(httpx.Client 는 스레드 안전)
CACHE_HOURS = 6
NAVER_WORKERS = 3
TOPICS = {
    "투자유치": r"투자\s*유치|시리즈\s*[A-Z]|펀딩|프리\s*IPO|상장|IPO|증자|밸류|기업가치|funding|raises",
    "매출·실적": r"매출|실적|영업이익|흑자|적자|revenue",
    "제품 출시": r"출시|공개|선보|론칭|양산|신제품|launch|unveil",
    "기술개발": r"개발|기술|특허|논문|성능|칩|아키텍처|벤치마크",
    "수주·계약": r"수주|계약|공급|납품|구매|deal|contract",
    "사업제휴": r"협력|제휴|MOU|업무협약|파트너|맞손|partnership",
    "해외 진출": r"해외|글로벌|미국|일본|중동|사우디|유럽|진출|global",
    "정부 관련": r"정부|과기정통부|산업부|중기부|국책|공공|지원사업|과제|조달",
    "경영진·인터뷰": r"대표|CEO|인터뷰|대담|기고|임원|영입|선임",
}


def _naver(query: str, start: int = 1, display: int = 100, sort: str = "date") -> list[dict]:
    cid, sec = common.env("NAVER_CLIENT_ID"), common.env("NAVER_CLIENT_SECRET")
    if not (cid and sec):
        raise RuntimeError("NAVER_CLIENT_ID/SECRET 이 .env 에 없습니다")
    params = {"query": query, "display": display, "start": start, "sort": sort}
    hit = common.cache_get("naver_news", params, CACHE_HOURS)
    if hit is not None:
        return hit
    with common.key_lock("naver_news", params):  # 같은 검색은 한 번만(병렬 실행 시 중복 호출 방지)
        hit = common.cache_get("naver_news", params, CACHE_HOURS)
        if hit is not None:
            return hit
        with common.limit("naver"):
            r = _NAVER.get(NAVER_URL, params=params, headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": sec})
            if r.status_code == 429:  # 초당 한도 초과: 1회만 짧게 기다려 재시도
                time.sleep(1.0)
                r = _NAVER.get(NAVER_URL, params=params, headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": sec})
        if r.status_code != 200:
            raise RuntimeError(common.scrub_text(f"NAVER HTTP {r.status_code}: {r.text[:150]}"))
        items = r.json().get("items") or []
        common.cache_put("naver_news", params, items)
        return items


def _date_naver(s: str) -> str:
    try:
        return parsedate_to_datetime(s).date().isoformat()
    except (TypeError, ValueError):
        return ""


def _host(url: str) -> str:
    try:
        h = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    return re.sub(r"^(www|m|mobile)\.", "", h)


def _norm_title(t: str) -> str:
    t = re.sub(r"^\s*(\[[^\]]{1,20}\]|【[^】]{1,20}】)\s*", "", t or "")
    return re.sub(r"[^0-9a-z가-힣]", "", t.lower())


def _bigrams(s: str) -> set[str]:
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}


def _sim(a: str, b: str) -> float:
    A, B = _bigrams(a), _bigrams(b)
    return len(A & B) / max(1, min(len(A), len(B)))


def dedup(rows: list[dict], threshold: float = 0.72, max_days: int = 3) -> list[dict]:
    """같은 사건을 다룬 중복 기사를 묶는다(제목 유사도 + 날짜 근접). 대표 기사에 묶인 기사 수를 남긴다."""
    out: list[dict] = []
    for r in sorted(rows, key=lambda x: x.get("date") or "", reverse=True):
        nt = _norm_title(r["title"])
        dup = None
        for o in out:
            if r["url_key"] == o["url_key"]:
                dup = o
                break
            if _sim(nt, o["_nt"]) >= threshold:
                try:
                    gap = abs((date.fromisoformat(r["date"]) - date.fromisoformat(o["date"])).days)
                except ValueError:
                    gap = 0
                if gap <= max_days:
                    dup = o
                    break
        if dup:
            dup["관련 기사 수"] += 1
            if r["publisher"] not in dup["_pubs"]:
                dup["_pubs"].append(r["publisher"])
            if r["provider"] not in dup["source_api"]:
                dup["source_api"] += f"+{r['provider']}"
        else:
            out.append({**r, "_nt": nt, "관련 기사 수": 1, "_pubs": [r["publisher"]], "source_api": r["provider"]})
    for o in out:
        o["매체"] = ", ".join(o.pop("_pubs")[:4])
        o.pop("_nt", None)
    return out


def classify(title: str, desc: str) -> list[str]:
    text = f"{title} {desc}"
    tags = [k for k, p in TOPICS.items() if re.search(p, text, re.I)]
    return tags or ["기타 동향"]


def collect(name: str, aliases: list[str] | None = None, liner: Liner | None = None, *, extra_queries: list[str] | None = None,
            months: int = 12, naver_pages: int = 3, liner_queries: int = 2) -> dict:
    """기업 뉴스 수집. 회사 이름이 제목·요약에 없는 기사만 제외한다(엄격한 관련성 필터는 하지 않음)."""
    aliases = [a for a in dict.fromkeys([name] + (aliases or [])) if a and len(a) >= 2]
    since = (date.today() - timedelta(days=int(months * 30.5))).isoformat()
    name_pat = re.compile("|".join(re.escape(a) for a in aliases), re.I)
    rows, errors, counts = [], [], {"naver": 0, "liner": 0}
    # 날짜순 검색은 최근 몇 주에 몰리므로, 정확도순(sim) 검색과 주제별 검색으로 12개월을 넓게 덮는다
    topics = extra_queries or ["투자 유치", "매출 실적", "계약 수주", "출시 공개", "협력 MOU", "해외 진출", "정부 과제", "대표 인터뷰"]
    plan = [(name, "date", naver_pages), (name, "sim", naver_pages)] + [(f"{name} {q}", "sim", 1) for q in topics]
    def pages_of(job):
        """검색어 하나의 페이지들(다음 페이지 여부가 앞 페이지에 달려 있어 검색어 안에서는 순서대로)."""
        q, sort, pages = job
        got, errs = [], []
        for p in range(pages):
            try:
                items = _naver(q, start=1 + p * 100, sort=sort)
            except (RuntimeError, httpx.HTTPError, ValueError) as e:
                errs.append(common.scrub_text(f"NAVER 뉴스 실패({q}): {str(e)[:120]}"))
                break
            got.append(items)
            old_hit = any((_date_naver(it.get("pubDate") or "") or "9") < since for it in items)
            if (old_hit and sort == "date") or len(items) < 100:
                break
        return got, errs
    # 검색어끼리는 독립이라 병렬로 부르고(동시 수는 common.limit('naver')), 결과는 원래 계획 순서대로 합친다
    with ThreadPoolExecutor(max_workers=NAVER_WORKERS, thread_name_prefix="naver") as ex:
        fetched = list(ex.map(pages_of, plan))
    for (q, sort, pages), (got, errs) in zip(plan, fetched):
        errors += errs
        for items in got:
            counts["naver"] += len(items)
            stop = False
            for it in items:
                title, desc = common.clean_html(it.get("title")), common.clean_html(it.get("description"))
                d = _date_naver(it.get("pubDate") or "")
                if d and d < since:
                    stop = True
                    continue
                if not name_pat.search(f"{title} {desc}"):
                    continue
                url = it.get("originallink") or it.get("link") or ""
                rows.append({"date": d, "title": title, "description": desc, "url": url, "naver_url": it.get("link") or "",
                             "publisher": _host(url), "provider": "naver", "url_key": re.sub(r"^https?://(www\.|m\.)?", "", url).rstrip("/")})
    if liner and liner.ok:
        en = next((a for a in aliases if re.fullmatch(r"[A-Za-z0-9 .&'-]+", a)), "")
        lq = [(f"{name} 최근 뉴스 투자 계약 협력", "ko", "kr")]
        if en:
            lq.append((f"{en} news funding partnership", "en", ""))
        for q, lang, cc in lq[:liner_queries]:
            for r in liner.search(q, lang=lang, country=cc, max_results=15, date_range="past_year", label="news_search"):
                title, desc = str(r.get("title") or ""), str(r.get("description") or "")
                if not name_pat.search(f"{title} {desc}"):
                    continue
                url = str(r.get("url") or "")
                d = str(r.get("date") or "")[:10]
                counts["liner"] += 1
                rows.append({"date": d, "title": title, "description": desc[:400], "url": url, "naver_url": "",
                             "publisher": _host(url), "provider": "liner", "url_key": re.sub(r"^https?://(www\.|m\.)?", "", url).rstrip("/")})
    articles = dedup(rows)
    for a in articles:
        a["분류"] = classify(a["title"], a["description"])
    return {"articles": articles, "raw_count": len(rows), "api_counts": counts, "errors": errors,
            "period": f"{since} ~ {date.today().isoformat()}"}


SUMMARY_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["summary", "events", "trends"],
    "properties": {
        "summary": {"type": "string", "description": "최근 1년 기업 동향 요약. 5~8문장"},
        "events": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["date", "category", "title", "detail", "source"],
            "properties": {"date": {"type": "string"}, "category": {"type": "string"},
                           "title": {"type": "string", "description": "사건 한 줄"},
                           "detail": {"type": "string", "description": "내용 1~2문장. 금액·상대방은 자료에 적힌 것만"},
                           "source": {"type": "integer", "description": "근거 기사 번호"}}}},
        "trends": {"type": "array", "items": {"type": "string"}, "description": "최근 사업 변화·흐름 3~5개"},
    },
}


def summarize(name: str, articles: list[dict], liner: Liner, *, max_items: int = 80) -> dict | None:
    """정리된 기사 목록(제목+요약)을 한 번에 보내 중요 사건과 동향을 뽑는다. 모델 1회."""
    if not articles or not liner.ok:
        return None
    pick = sorted(articles, key=lambda a: (-a["관련 기사 수"], a["date"]), reverse=False)[:max_items]
    pick.sort(key=lambda a: a["date"] or "", reverse=True)
    system = (f"당신은 기업 동향 분석가입니다. {DATA_RULE}\n"
              "기사 목록에서 대상 기업의 중요한 사건(투자유치, 실적, 제품 출시, 기술개발, 수주·계약, 제휴, 해외 진출, 정부 사업, 경영진 변화)을 "
              "최신순으로 최대 15개 뽑고, 최근 동향을 요약합니다. 같은 사건은 한 번만 씁니다. 금액·상대방은 기사에 적힌 것만 씁니다.")
    out = liner.json(system, f"대상 기업: {name}\n\n<자료>\n{numbered(pick, 200)}\n</자료>", SUMMARY_SCHEMA, name="news_summary")
    if not out:
        return None
    events = []
    for e in out.get("events") or []:
        s = e.get("source")
        if isinstance(s, int) and 0 <= s < len(pick):
            events.append({**e, "url": pick[s]["url"], "기사 제목": pick[s]["title"]})
    return {"summary": out.get("summary") or "", "events": events, "trends": out.get("trends") or []}
