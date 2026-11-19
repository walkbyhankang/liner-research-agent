"""검색 쿼리 구성, 모델 프롬프트, 모델 JSON 정규화, 사실(fact) 추출, 마스킹."""
from __future__ import annotations

import json
import re
from typing import Any

import config

STATUSES = ("confirmed", "reported", "inferred", "conflicting", "unavailable")
STATUS_LABELS = {
    "confirmed": "원문 직접 확인", "reported": "발표·보도 기반", "inferred": "AI 해석",
    "conflicting": "출처 간 불일치", "unavailable": "자료 확보 불가",
}
SOURCE_TYPES = ("official", "news", "database", "government", "search_summary", "other")
UNKNOWN = "자료 확보 불가"


# ---------- 검색 쿼리 ----------
def build_search_plan(company: str, country: str) -> list[dict]:
    """Search API 5회 이내의 쿼리 계획. 결과는 여러 분석 항목에서 재활용한다."""
    c = config.COUNTRIES.get(country, config.COUNTRIES["기타(영어 검색)"])
    ko = c["lang"] == "ko"
    if ko:
        qs = [
            ("profile", f"{company} 기업 개요 설립 대표 창업자 본사 주요 제품 기술 연혁"),
            ("finance", f"{company} 매출 영업이익 순이익 직원수 누적 투자유치 금액"),
            ("competitors", f"{company} 경쟁사 유사 기업 비교"),
            ("news", f"{company} 공급계약 MOU 투자유치 설비투자 상용화 인터뷰"),
            ("vc_support", f"{company} 투자사 VC 벤처캐피탈 정부지원 R&D 과제 창업지원"),
        ]
    else:
        qs = [
            ("profile", f"{company} company overview founded headquarters founders CEO products technology history"),
            ("finance", f"{company} revenue operating income net income employees total funding raised"),
            ("competitors", f"{company} competitors alternatives comparison"),
            ("news", f"{company} contract partnership MOU funding round investment commercialization interview"),
            ("vc_support", f"{company} investors venture capital government grant R&D funding support"),
        ]
    plan = [{"key": k, "query": q, "country_code": c["code"], "lang": c["lang"]} for k, q in qs]
    return plan[: config.MAX_SEARCH_CALLS]


def build_agent_question(company: str, country: str) -> str:
    ko = config.COUNTRIES.get(country, {}).get("lang") == "ko"
    if ko:
        return (f"{company}에 대해 정식 회사명, 설립연도, 본사, 대표자, 주요 제품, 최근 매출·영업이익·직원수, "
                f"누적 투자유치, 경쟁사 3곳, 최근 주요 뉴스, 주요 투자사, 관련 정부지원 사업을 출처와 함께 정리해 주세요. "
                f"확인되지 않은 항목은 '확인 불가'로 표시하세요.")
    return (f"Summarize {company}: official name, founding year, HQ, founders/CEO, products, latest revenue, "
            f"operating income, headcount, total funding, 3 competitors, recent news, key investors and relevant "
            f"government support, with sources. Mark unverified items as 'unavailable'.")


# ---------- 모델 입력 ----------
def compact_search_results(searches: dict[str, dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for key, resp in searches.items():
        rows = []
        for r in (resp or {}).get("results") or []:
            rows.append({"title": r.get("title"), "url": r.get("url"),
                         "description": r.get("description"), "date": r.get("date")})
        out[key] = rows
    return out


SYSTEM_PROMPT = """너는 스타트업 기업정보 정리 분석가다. 아래 '검색 결과'에 실제로 있는 내용만 사용한다.
규칙:
- 검색 결과에 없는 사실·재무 수치·직원수·투자금액은 만들지 않는다. 없으면 value는 null, status는 "unavailable".
- 모든 사실에는 근거가 된 검색 결과의 url을 그대로 넣는다. 검색 결과에 없는 url은 쓰지 않는다.
- 검색 결과는 요약(description)만 보았으므로 status는 "reported"(기업 발표/언론 보도), "inferred"(네 해석), "conflicting"(출처 불일치), "unavailable" 중에서 고른다.
- 투자 가능성 확률, 매출 추정치 등을 임의로 계산하지 않는다.
- 뉴스는 발행일(published_date)과 실제 사건일(event_date, 모르면 null)을 구분하고, commitment_level은 contract/MOU/plan/executed/other 중 하나로 구분한다. 중복 보도는 하나로 합치고 source_urls에 모두 넣는다.
- 경쟁사 최대 3, 뉴스 최대 5, VC 최대 3, 정부지원 사업 최대 3개. 접수기간·자격을 모르면 "미확인".
- 반드시 JSON 객체 하나만 출력한다 (JSON).
스키마:
{
 "company_name": str|null,
 "facts": [{"category":"profile|finance|funding|employees","item":str,"value":str|null,"as_of":str|null,"source_url":str|null,"source_type":"official|news|database|government|search_summary|other","status":str}],
 "financials": [{"metric":"revenue|operating_profit|net_profit|employees","year":int,"value":number,"unit":str,"currency":str|null,"source_url":str,"status":str}],
 "competitors": [{"name":str,"products":str|null,"reason":str|null,"financials":str|null,"employees":str|null,"funding":str|null,"source_urls":[str],"status":str}],
 "news": [{"title":str,"published_date":str|null,"event_date":str|null,"event_type":str,"commitment_level":str,"summary":str,"source_urls":[str],"status":str}],
 "vcs": [{"name":str,"focus":str|null,"funds":str|null,"portfolio":str|null,"relevance":str|null,"competitor_investments":str|null,"source_urls":[str],"status":str}],
 "support": [{"name":str,"type":str,"agency":str|null,"country":str|null,"period":str,"eligibility":str,"url":str|null,"status":str}]
}
profile 항목(item)에는 정식 회사명, 설립연도, 본사 소재지, 창업자/대표자, 주요 연혁, 주요 사업·제품, 핵심 기술, 사업화 단계를, finance/funding/employees에는 영업이익·순이익·누적 투자유치·직원수 등을 가능한 만큼 넣는다."""


def build_model_input(company: str, country: str, searches: dict[str, dict]) -> str:
    payload = {"company": company, "country": country, "검색 결과": compact_search_results(searches)}
    return "다음 데이터를 분석해 JSON으로 답하라.\n" + json.dumps(payload, ensure_ascii=False)


# ---------- 파싱/정규화 ----------
def parse_model_json(text: str) -> dict:
    """모델 출력에서 JSON 객체를 추출한다. 실패 시 ValueError."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.S)
    try:
        obj = json.loads(t)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", t, flags=re.S)
        if not m:
            raise ValueError("모델 출력에서 JSON을 찾지 못했습니다.")
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError as exc:
            raise ValueError(f"모델 출력 JSON 파싱 실패: {exc}") from exc
    if not isinstance(obj, dict):
        raise ValueError("모델 출력이 JSON 객체가 아닙니다.")
    return obj


def known_urls(searches: dict[str, dict]) -> set[str]:
    return {r.get("url") for resp in searches.values() for r in (resp or {}).get("results") or [] if r.get("url")}


def _status(s: Any, has_value: bool = True) -> str:
    s = str(s or "").lower()
    if s == "confirmed":  # 검색 요약만 보았으므로 원문 직접 확인으로 인정하지 않는다
        s = "reported"
    if s not in STATUSES:
        s = "inferred"
    if not has_value:
        s = "unavailable"
    return s


def _urls(item: dict, urls: set[str], single: str | None = None, plural: str | None = None) -> tuple[list[str], bool]:
    """(검증된 URL 목록, 미검증 URL 존재 여부)."""
    raw: list = []
    if single and item.get(single):
        raw.append(item[single])
    if plural and isinstance(item.get(plural), list):
        raw.extend(item[plural])
    raw = [u for u in raw if isinstance(u, str) and u]
    good = [u for u in raw if u in urls]
    return good, len(good) != len(raw)


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace(",", ""))
        except ValueError:
            return None
    return None


def _txt(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def normalize_analysis(raw: dict, searches: dict[str, dict]) -> dict:
    """모델 출력의 형식을 보정하고 근거 없는 항목을 강등한다."""
    urls = known_urls(searches)
    notes: list[str] = []
    out: dict[str, Any] = {"company_name": _txt(raw.get("company_name")), "facts": [], "financials": [],
                           "competitors": [], "news": [], "vcs": [], "support": [], "notes": notes}

    for f in raw.get("facts") or []:
        if not isinstance(f, dict):
            continue
        val = _txt(f.get("value"))
        src, bad = _urls(f, urls, single="source_url")
        st = _status(f.get("status"), val is not None)
        if val is not None and not src:
            st = "inferred"
            notes.append(f"근거 URL 없는 사실 강등: {f.get('item')}")
        elif bad and st != "unavailable":
            st = "inferred"
        out["facts"].append({
            "category": _txt(f.get("category")) or "profile", "item": _txt(f.get("item")) or "",
            "value": val, "as_of": _txt(f.get("as_of")), "source_url": src[0] if src else None,
            "source_type": f.get("source_type") if f.get("source_type") in SOURCE_TYPES else "search_summary",
            "status": st})

    for f in raw.get("financials") or []:
        if not isinstance(f, dict):
            continue
        v, yr = _num(f.get("value")), _num(f.get("year"))
        src, _ = _urls(f, urls, single="source_url")
        if v is None or yr is None or not src:
            notes.append(f"재무 수치 제외(값/연도/출처 검증 실패): {f.get('metric')} {f.get('year')}")
            continue
        out["financials"].append({
            "metric": _txt(f.get("metric")) or "", "year": int(yr), "value": v, "unit": _txt(f.get("unit")) or "",
            "currency": _txt(f.get("currency")), "source_url": src[0], "status": _status(f.get("status"))})

    for c in (raw.get("competitors") or [])[:3]:
        if isinstance(c, dict) and _txt(c.get("name")):
            src, _ = _urls(c, urls, plural="source_urls")
            out["competitors"].append({
                "name": _txt(c["name"]), "products": _txt(c.get("products")), "reason": _txt(c.get("reason")),
                "financials": _txt(c.get("financials")), "employees": _txt(c.get("employees")),
                "funding": _txt(c.get("funding")), "source_urls": src,
                "status": _status(c.get("status")) if src else "inferred"})

    seen: set[str] = set()
    for n in raw.get("news") or []:
        if not isinstance(n, dict) or not _txt(n.get("title")):
            continue
        key = re.sub(r"\W+", "", n["title"].lower())
        if key in seen:
            continue
        seen.add(key)
        src, _ = _urls(n, urls, plural="source_urls")
        lvl = str(n.get("commitment_level") or "other")
        out["news"].append({
            "title": _txt(n["title"]), "published_date": _txt(n.get("published_date")),
            "event_date": _txt(n.get("event_date")), "event_type": _txt(n.get("event_type")) or "",
            "commitment_level": lvl if lvl in ("contract", "MOU", "plan", "executed", "other") else "other",
            "summary": _txt(n.get("summary")) or "", "source_urls": src,
            "status": _status(n.get("status")) if src else "inferred"})
    out["news"] = out["news"][:5]

    for v in (raw.get("vcs") or [])[:3]:
        if isinstance(v, dict) and _txt(v.get("name")):
            src, _ = _urls(v, urls, plural="source_urls")
            out["vcs"].append({
                "name": _txt(v["name"]), "focus": _txt(v.get("focus")), "funds": _txt(v.get("funds")),
                "portfolio": _txt(v.get("portfolio")), "relevance": _txt(v.get("relevance")),
                "competitor_investments": _txt(v.get("competitor_investments")), "source_urls": src,
                "status": _status(v.get("status")) if src else "inferred"})

    for s in (raw.get("support") or [])[:3]:
        if isinstance(s, dict) and _txt(s.get("name")):
            src, _ = _urls(s, urls, single="url")
            out["support"].append({
                "name": _txt(s["name"]), "type": _txt(s.get("type")) or "", "agency": _txt(s.get("agency")),
                "country": _txt(s.get("country")), "period": _txt(s.get("period")) or "미확인",
                "eligibility": _txt(s.get("eligibility")) or "미확인", "url": src[0] if src else None,
                "status": _status(s.get("status")) if src else "inferred"})
    return out


def empty_analysis(note: str) -> dict:
    return {"company_name": None, "facts": [], "financials": [], "competitors": [], "news": [],
            "vcs": [], "support": [], "notes": [note]}


# ---------- 사실 목록 ----------
def build_facts_table(analysis: dict, source: str = "model") -> list[dict]:
    """모든 주요 사실을 (수집항목, 값, 기준일, 출처URL, 출처유형, 상태) 행으로 평탄화한다."""
    rows: list[dict] = []

    def add(cat, item, value, as_of, url, stype, status):
        rows.append({"category": cat, "item": item, "value": value if value is not None else UNKNOWN,
                     "as_of": as_of or "", "source_url": url or "", "source_type": stype,
                     "status": status, "status_label": STATUS_LABELS.get(status, status), "origin": source})

    for f in analysis.get("facts", []):
        add(f["category"], f["item"], f["value"], f["as_of"], f["source_url"], f["source_type"], f["status"])
    for f in analysis.get("financials", []):
        add("finance", f"{f['metric']} {f['year']}", f"{f['value']:g} {f['unit']} {f['currency'] or ''}".strip(),
            str(f["year"]), f["source_url"], "search_summary", f["status"])
    for c in analysis.get("competitors", []):
        add("competitor", c["name"], c.get("products"), "", (c["source_urls"] or [""])[0], "search_summary", c["status"])
    for n in analysis.get("news", []):
        add("news", n["title"], n["summary"], n.get("event_date") or n.get("published_date"),
            (n["source_urls"] or [""])[0], "news", n["status"])
    for v in analysis.get("vcs", []):
        add("vc", v["name"], v.get("focus"), "", (v["source_urls"] or [""])[0], "search_summary", v["status"])
    for s in analysis.get("support", []):
        add("support", s["name"], f"기간: {s['period']} / 자격: {s['eligibility']}", "", s.get("url"),
            "government", s["status"])
    return rows


# ---------- 보안: 마스킹 ----------
_SECRET_PATTERNS = [re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}"),
                    re.compile(r"(?i)(x-api-key['\"]?\s*[:=]\s*['\"]?)[A-Za-z0-9._\-]{8,}")]


def scrub(obj: Any, secrets: list[str]) -> Any:
    """결과 파일에 쓰기 전에 키/토큰 문자열을 제거한다."""
    secrets = [s for s in secrets if s]
    if isinstance(obj, str):
        for s in secrets:
            obj = obj.replace(s, "***")
        for p in _SECRET_PATTERNS:
            obj = p.sub(r"\1***", obj)
        return obj
    if isinstance(obj, dict):
        return {k: scrub(v, secrets) for k, v in obj.items()
                if str(k).lower() not in ("authorization", "x-api-key", "api_key")}
    if isinstance(obj, list):
        return [scrub(v, secrets) for v in obj]
    return obj
