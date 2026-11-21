"""회사명으로 회사 정보 초안을 만든다. 기존 기업분석 엔진(pipeline)을 필요한 주제만 골라 돌린다.

전체 분석은 검색 18회·모델 6회·3~5분이 걸리므로, 필요한 네 주제만 쓴다:
  identity(개요) → profile, headcount_funding(직원·투자) → finance, vc_existing(기존 투자자) → vc, competitors(경쟁사) → competitors
그 뒤 경쟁사가 받은 투자와 규모를 따로 찾는다(funding/rivals.py, 경쟁사별 검색 2회씩 최대 6회·모델 1회).
결과는 초안이다. 값마다 상태와 출처를 붙여 사용자가 확인한 뒤 쓰게 한다.
"""
from __future__ import annotations

import re
from datetime import date

import fetcher as fetcher_mod
from funding import rivals
from liner_client import LinerAPIError
import pipeline as pl
import planner

COUNTRY = "대한민국"
TOPICS = ("identity", "headcount_funding", "vc_existing", "competitors")
FETCH_PAGES = 8
STATUS_RANK = {"confirmed": 0, "reported": 1, "inferred": 2, "conflicting": 3}
# 자동으로 채워도 되는 상태. 출처가 엇갈리거나(conflicting) 추정(inferred)인 값은 조회 결과에만 보여주고 채우지 않는다.
# 채워 넣으면 자격 대조에서 확정된 사실처럼 쓰이기 때문이다.
AUTOFILL_STATUS = {"confirmed", "reported"}
UNCERTAIN_NOTE = {"conflicting": "출처마다 값이 달라 자동으로 채우지 않았습니다. 확인한 뒤 직접 입력하세요.",
                  "inferred": "추정 값이라 자동으로 채우지 않았습니다. 확인한 뒤 직접 입력하세요."}
REGIONS = {
    "서울": "서울", "부산": "부산", "대구": "대구", "인천": "인천", "광주": "광주", "대전": "대전", "울산": "울산", "세종": "세종",
    "경기": "경기", "강원": "강원", "충청북": "충북", "충북": "충북", "충청남": "충남", "충남": "충남", "전라북": "전북", "전북": "전북",
    "전라남": "전남", "전남": "전남", "경상북": "경북", "경북": "경북", "경상남": "경남", "경남": "경남", "제주": "제주",
}


ALIAS = r"[A-Za-z][A-Za-z0-9 .&'-]{1,28}[A-Za-z0-9]"
# 회사 이름이 아니라 설명으로 괄호에 들어가는 낱말. 이런 것을 이름으로 쓰면 거의 모든 자료가 관련 있다고 판정된다
ALIAS_STOP = {"ai", "inc", "corp", "co", "ltd", "llc", "ipo", "ceo", "cto", "cfo", "vc", "b2b", "b2c", "saas", "the", "llm", "it", "ir", "api", "sw", "esg", "mou"}
GENERIC_SUFFIX = {"technologies", "technology", "tech", "inc", "inc.", "corp", "corp.", "co", "co.", "ltd", "ltd.", "labs", "lab", "ai", "korea", "global", "group", "company"}


def find_aliases(name: str, results: list[dict], limit: int = 3) -> list[str]:
    """검색 결과에서 '회사명(English Name)' 또는 'English Name(회사명)' 꼴로 두 건 이상 나온 영문 이름을 찾는다.

    기존 엔진은 제목·발췌에 회사 이름이 없으면 자료를 버리는데, 한글 이름만 알면 영문 자료가 모두 버려진다.
    추측으로 이름을 만들지 않고, 검색 결과가 직접 짝지어 보여준 표기만 쓴다.
    """
    if not name.strip():
        return []
    n = re.escape(name.strip())
    patterns = [re.compile(n + r"[가-힣]{0,12}\s*[\(（]\s*(" + ALIAS + r")\s*[\)）]"),
                re.compile(r"(" + ALIAS + r")\s*[\(（]\s*" + n)]
    seen: dict[str, tuple[int, str]] = {}
    for r in results:
        text = f"{r.get('title') or ''} {r.get('description') or ''}"
        found = {m.group(1).strip() for pat in patterns for m in pat.finditer(text)}
        for alias in found:
            key = alias.lower()
            if key in ALIAS_STOP or len(alias) < 3:
                continue
            count, first = seen.get(key, (0, alias))
            seen[key] = (count + 1, first)
    out: list[str] = []
    for key, (count, alias) in sorted(seen.items(), key=lambda kv: -kv[1][0]):
        if count < 2:
            continue
        out.append(alias)
        words = alias.split()
        # 'Wrtn Technologies' 처럼 뒤가 일반 낱말이면 앞 낱말만으로도 불리므로 함께 넣는다
        if len(words) > 1 and len(words[0]) >= 4 and all(w.lower() in GENERIC_SUFFIX for w in words[1:]) and words[0].lower() not in ALIAS_STOP:
            out.append(words[0])
    uniq = list(dict.fromkeys(out))
    return uniq[:limit]


class ProfileError(Exception):
    pass


def _value(fact: dict) -> str:
    v = str(fact.get("value") or "").strip()
    unit = str(fact.get("unit") or "").strip()
    return f"{v}{unit}" if unit and unit not in v else v


def _best(facts: list[dict], category: str, include: tuple[str, ...], exclude: tuple[str, ...] = ()) -> dict | None:
    """항목 이름에 include 낱말이 든 사실 가운데 값이 있고 상태가 가장 좋은 것. 엔진의 항목 이름은 자유 문자열이다."""
    hits = [f for f in facts
            if f.get("category") == category and str(f.get("value") or "").strip() and f.get("status") in STATUS_RANK
            and any(k in str(f.get("item") or "") for k in include)
            and not any(k in str(f.get("item") or "") for k in exclude)]
    return min(hits, key=lambda f: STATUS_RANK[f["status"]]) if hits else None


UNKNOWN_WORDS = {"unknown", "n/a", "na", "-", "미확인", "확인 불가", "알 수 없음", "none", "null"}
REVENUE_MAX = 60  # api.main.Company.revenue 와 web/lib/company.ts 의 길이 제한과 같다


def format_revenue(row: dict) -> str:
    """매출 한 줄: 금액, 단위, 통화, 회계연도, 연결/별도 기준을 모두 남긴다. 원화는 단위에 '원'이 있으면 따로 적지 않는다."""
    amount = f"{row.get('value')}{str(row.get('unit') or '').strip()}"
    currency = str(row.get("currency") or "").strip()
    if currency and currency.upper() not in amount.upper() and not (currency.upper() in ("KRW", "원") and "원" in amount):
        amount = f"{amount} {currency}"
    basis = str(row.get("basis") or "").strip()
    if basis.lower() in UNKNOWN_WORDS:  # 엔진이 기준을 알 수 없을 때 넣는 값. 그대로 보여주면 기준처럼 읽힌다
        basis = ""
    detail = ", ".join(x for x in (str(row.get("year") or "").strip(), basis) if x)
    return f"{amount} ({detail})" if detail else amount


def parse_founded(text: str) -> tuple[str, str]:
    """('YYYY-MM', '') 또는 ('', 'YYYY'). 월을 알 수 없으면 지어내지 않고 연도만 돌려준다."""
    m = re.search(r"((?:19|20)\d{2})\s*[년.\-/]\s*(\d{1,2})\s*(?:월|[.\-/]|$)", text)
    if m and 1 <= int(m.group(2)) <= 12:
        return f"{m.group(1)}-{int(m.group(2)):02d}", ""
    y = re.search(r"(?:19|20)\d{2}", text)
    return "", (y.group(0) if y else "")


def parse_region(text: str) -> str:
    for key, label in REGIONS.items():
        if key in text[:12]:
            return label
    return ""


def _field(key: str, label: str, value: str, fact: dict | None, note: str = "") -> dict:
    return {"key": key, "label": label, "value": value, "status": (fact or {}).get("status") or "",
            "sourceUrl": (fact or {}).get("source_url") or "", "evidence": str((fact or {}).get("evidence") or "")[:200], "note": note}


# 엔진이 쓰는 경쟁 관계 코드를 화면에 보일 말로 바꾼다
RELATION_LABEL = {"direct": "직접 경쟁", "similar_tech": "유사 기술", "same_market": "같은 시장", "global": "해외 경쟁사"}


def to_draft(run: dict) -> dict:
    """엔진 실행 결과를 화면의 회사 정보 형식으로 바꾼다."""
    analysis = run.get("analysis") or {}
    facts = analysis.get("facts") or []
    fields: list[dict] = []

    name = str(analysis.get("company_name") or "").strip()
    # 다른 법인의 설립을 가리키는 항목만 뺀다. 회사 자신의 '법인 설립일'은 설립일이다
    founded_fact = _best(facts, "profile", ("설립",), ("자회사", "지사", "해외법인", "해외 법인", "현지법인", "현지 법인", "합작", "재단"))
    founded, year_only = parse_founded(_value(founded_fact)) if founded_fact else ("", "")
    if founded_fact and (founded or year_only):
        fields.append(_field("founded", "설립", founded or f"{year_only}년", founded_fact, "" if founded else "설립 월을 찾지 못해 연도만 표시합니다"))

    hq = _best(facts, "profile", ("본사", "소재지"))
    region = parse_region(_value(hq)) if hq else ""
    if hq:
        fields.append(_field("region", "본사 소재지", _value(hq)[:60], hq))

    # 항목 이름이 구체적인 것부터 찾는다. '서비스'만 들어간 항목은 이용 현황 같은 다른 사실일 수 있어 쓰지 않는다
    industry = next((f for f in (_best(facts, "profile", (k,)) for k in ("주요 제품", "제품·서비스", "주요 서비스", "사업 분야", "주요 사업", "제품")) if f), None)
    if industry:
        fields.append(_field("industry", "주요 사업", _value(industry)[:80], industry))

    employees = _best(facts, "finance", ("직원", "임직원", "인원"))
    if employees:
        as_of = str(employees.get("as_of") or "").strip()
        fields.append(_field("employees", "직원 수", (_value(employees) + (f" ({as_of} 기준)" if as_of else ""))[:30], employees))

    revenue = None
    rows = [r for r in analysis.get("financials") or [] if r.get("metric") == "revenue" and r.get("value") not in (None, "")]
    if rows:
        revenue = max(rows, key=lambda r: str(r.get("year") or ""))
        text = format_revenue(revenue)
        fits = len(text) <= REVENUE_MAX
        fields.append({"key": "revenue", "label": "매출", "value": text, "status": revenue.get("status") or "",
                       "sourceUrl": revenue.get("source_url") or "", "evidence": str(revenue.get("evidence") or "")[:200],
                       "note": "" if fits else "값이 길어 자동으로 채우지 않았습니다. 확인한 뒤 직접 입력하세요."})

    investors = []
    for inv in analysis.get("existing_investors") or []:
        nm = str(inv.get("name") or "").strip()
        if nm and nm not in [i["name"] for i in investors]:
            urls = inv.get("source_urls") or []
            investors.append({"name": nm[:60], "round": str(inv.get("round") or "")[:30], "date": str(inv.get("date") or "")[:20],
                              "status": inv.get("status") or "", "sourceUrl": urls[0] if urls else ""})

    competitors = []
    for c in analysis.get("competitors") or []:
        nm = str(c.get("name") or "").strip()
        if not nm or nm in [x["name"] for x in competitors]:
            continue
        urls = c.get("source_urls") or []
        text = lambda k, n: str(c.get(k) or "").strip()[:n]  # noqa: E731
        competitors.append({"name": nm[:60], "relation": RELATION_LABEL.get(text("relation", 60), text("relation", 60)), "products": text("products", 120),
                            "revenue": text("revenue", 60), "employees": text("employees", 40), "funding": text("funding", 120),
                            "asOf": text("as_of", 20), "status": c.get("status") or "", "sourceUrl": urls[0] if urls else ""})

    for f in fields:
        if f["status"] not in AUTOFILL_STATUS and not f["note"]:
            f["note"] = UNCERTAIN_NOTE.get(f["status"], "확인 상태를 알 수 없어 자동으로 채우지 않았습니다.")
    by_key = {f["key"]: f["value"] for f in fields if f["status"] in AUTOFILL_STATUS}
    if "founded" not in by_key:
        founded, year_only = "", ""
    if "region" not in by_key:
        region = ""
    draft = {"name": name, "founded": founded, "foundedYear": year_only, "region": region,
             "industry": by_key.get("industry", ""), "employees": by_key.get("employees", ""),
             # 잘라서 넣으면 통화·연도·기준이 사라질 수 있으므로, 칸에 다 들어가지 않으면 채우지 않는다
             "revenue": by_key.get("revenue", "") if len(by_key.get("revenue", "")) <= REVENUE_MAX else ""}
    return {"draft": draft, "fields": fields, "investors": investors[:20], "competitors": competitors[:6], "rivalFunding": []}


# 조회한 회사 이름이 제목·발췌에 없어도 쓰는 주제. 경쟁사를 다룬 자료나 영문 자료는 회사 이름이 안 나오는 경우가 많다.
# 엔진이 지원사업·신규 VC 탐색에 쓰는 것과 같은 처리(관련도 0.5)다. 유사 상호 제외는 그대로 적용된다.
# 기존 투자자 주제에는 쓰지 않는다. 다른 회사의 투자 기사를 이 회사의 투자자로 읽을 위험이 있기 때문이다.
NAME_OPTIONAL_TOPICS = {"competitors"}


def search_plan(name: str) -> list[dict]:
    plan = [s for s in planner.build_search_plan(name, COUNTRY, year=date.today().year) if s["key"] in TOPICS]
    return [{**s, "market": True} if s["key"] in NAME_OPTIONAL_TOPICS else s for s in plan]


def lookup(name: str, client, *, homepage: str = "", fetcher: fetcher_mod.Fetcher | None = None, progress=None) -> dict:
    """유료 호출: 검색 최대 10회, 모델 최대 5회. 인증·크레딧 오류는 LinerAPIError 로 올라온다."""
    say = progress or (lambda m: None)
    opts = pl.default_options(use_agent=False, fetch_pages=FETCH_PAGES, reserve_premium=False,
                              hints={"homepage": homepage, "aliases": "", "exclude": ""})
    run = pl.new_run(name, COUNTRY, opts)
    plan = search_plan(name)
    run["search_plan"] = plan
    for step in plan:
        pl._do_search(run, client, step, say)
    if not run["searches"]:
        raise ProfileError("검색 결과를 받지 못했습니다")
    # 검색 결과가 짝지어 보여준 영문 이름을 별칭으로 넘겨, 영문 자료가 '회사 이름 없음'으로 버려지지 않게 한다
    results = [r for data in run["searches"].values() for r in (data or {}).get("results") or [] if isinstance(r, dict)]
    aliases = find_aliases(name, results)
    run["options"]["hints"]["aliases"] = ",".join(aliases)
    pl.rebuild_sources(run)
    say("원문 확인")
    fx = fetcher or fetcher_mod.Fetcher(max_pages=FETCH_PAGES)
    try:
        for s in fetcher_mod.prioritize(run["sources"])[: FETCH_PAGES * 3]:
            if fx.fetched >= fx.max_pages:
                break
            run["fetched"][s["url_key"]] = fx.fetch(s["url"])
    finally:
        if fetcher is None:
            fx.close()
    pl.run_models(run, client, say)
    # 엔진은 분야별 모델 실패를 삼키고 기록만 한다. 하나도 성공하지 못했으면 빈 결과를 성공처럼 돌려주지 않는다
    runs = run["category_runs"]
    if any(r.get("status") == "failed" for r in runs.values()) and not any(r.get("status") == "success" for r in runs.values()):
        first = next(str(r.get("error") or "") for r in runs.values() if r.get("status") == "failed")
        raise ProfileError(f"회사 정보를 추출하지 못했습니다(모델 호출 실패). {first[:120]}".strip())
    out = to_draft(run)
    rival_error = ""
    say("경쟁사 투자 이력 조회")  # 경쟁사 규모(직원 수·매출)도 이 단계에서 함께 찾는다
    try:
        found = rivals.research([c["name"] for c in out["competitors"]], client)
        out["rivalFunding"] = found["rounds"]
        rivals.apply_figures(out["competitors"], found)
    except LinerAPIError as e:  # 회사 정보는 얻었으므로 경쟁사 투자 조회 실패는 알리기만 한다
        rival_error = str(e)[:120]
    out["meta"] = {"searches": len(run["searches"]), "pagesRead": len(run["fetched"]), "aliases": aliases,
                   "profileItems": [str(f.get("item") or "")[:30] for f in run["analysis"].get("facts") or [] if f.get("category") == "profile"][:20],
                   "categories": {k: v.get("status") for k, v in run["category_runs"].items()},
                   "errors": [e.get("stage") for e in run["errors"]][:5], "rivalError": rival_error}
    return out
