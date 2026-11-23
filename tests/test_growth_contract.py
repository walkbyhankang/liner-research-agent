"""성장노트 계약 검사: 가짜 응답이 growth/contract.py 타입과 맞는지, 한글 키·점수 필드·실제 회사 이름이 없는지,
growth/·api/ 가 research/ 를 불러오지 않는지, 호출 상한 인터페이스가 계약대로 움직이는지. 실제 API 는 부르지 않는다."""
import ast
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest
from pydantic import TypeAdapter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from growth import contract as C  # noqa: E402
from growth import limits as L  # noqa: E402
from liner_client import MAX_AUTO_RETRIES, CallLimitExceeded, LinerClient  # noqa: E402

FIX = ROOT / "fixtures" / "analysis"
FILES = sorted(FIX.glob("*.json"))
DATA = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in FILES}
EXPECTED_FIXTURES = {"F-FULL", "F-FULL.articles", "F-STAGED", "F-LIMIT-NEWS", "F-NOCORP", "F-CONFLICT", "F-STALE", "F-EXAMPLE",
                     "F-EMPTY", "F-MONEY", "F-CORP-0", "F-CORP-1", "F-CORP-2", "F-CORP-7", "F-DOWN", "F-INTERRUPTED",
                     "F-NOTICE", "F-BRIEF", "F-RIVALS", "F-SALES", "F-SALES-PARTIAL", "F-HTML"}

A = {
    "job": TypeAdapter(C.AnalysisJob), "news": TypeAdapter(C.NewsPage), "corp": TypeAdapter(C.CorpSearchResponse),
    "example": TypeAdapter(C.ExampleResponse), "health": TypeAdapter(C.HealthResponse), "notice": TypeAdapter(C.NoticeAnalysis),
    "gp": TypeAdapter(C.GpBrief), "start": TypeAdapter(C.StartAnalysisResponse), "run": TypeAdapter(C.RunSectionResponse),
    "companyJob": TypeAdapter(C.CompanyJobResponse), "error": TypeAdapter(C.ApiError),
}
REQ = {"start": TypeAdapter(C.StartAnalysisRequest), "rivals": TypeAdapter(C.RivalsDeepRequest), "sales": TypeAdapter(C.SalesRequest),
       "company": TypeAdapter(C.NoticeCompany)}


def kind_of(method: str, path: str, status: int) -> str:
    if status >= 400:
        return "error"
    if method == "GET" and path.endswith("/news"):
        return "news"
    if method == "GET" and (path.startswith("/api/analysis/") or path.endswith("/analysis")):
        return "job"
    if method == "GET" and path.endswith("/job"):
        return "companyJob"
    if method == "POST" and "/sections/" in path:
        return "run"
    return {("GET", "/api/corp/search"): "corp", ("GET", "/api/example"): "example", ("GET", "/api/health"): "health",
            ("POST", "/api/notice/analyze"): "notice", ("POST", "/api/gp/brief"): "gp", ("POST", "/api/analysis"): "start"}[(method, path)]


def exchanges():
    for name, f in DATA.items():
        for ex in f.get("exchanges", []):
            yield name, ex


def jobs():
    for name, ex in exchanges():
        if kind_of(ex["method"], ex["path"], ex["status"]) == "job":
            yield name, ex["response"]


def walk(obj, path=""):
    """(경로, 키 또는 None, 값)을 모두 돈다."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield path, k, v
            yield from walk(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, f"{path}[{i}]")


def values_in(merged: dict):
    """merged 안의 Value 모양 객체."""
    for _, _, v in walk(merged):
        if isinstance(v, dict) and "usedIndex" in v and "status" in v:
            yield v


# ---------------------------------------------------------------- 모양

def test_all_fixtures_exist():
    assert set(DATA) == EXPECTED_FIXTURES


@pytest.mark.parametrize("name", sorted(EXPECTED_FIXTURES - {"F-FULL.articles"}))
def test_fixture_responses_match_contract_types(name):
    f = DATA[name]
    assert f["baseDate"] == "2026-11-22" and f["fixture"] == name and f["exchanges"]
    for ex in f["exchanges"]:
        A[kind_of(ex["method"], ex["path"], ex["status"])].validate_python(ex["response"], strict=True)
        body, path = ex["request"], ex["path"]
        if ex["method"] == "POST":
            if path == "/api/analysis":
                REQ["start"].validate_python(body, strict=True)
            elif path.endswith("/sections/rivals_deep"):
                REQ["rivals"].validate_python(body, strict=True)
            elif path.endswith("/sections/sales"):
                REQ["sales"].validate_python(body, strict=True)
            elif "/sections/" in path:
                assert body == {}
            else:  # 공고문 대조·운용사 요약
                REQ["company"].validate_python(body["company"], strict=True)
                assert set(body) in ({"programId", "company"}, {"gp", "company"})


def test_articles_file_matches_contract():
    f = DATA["F-FULL.articles"]
    TypeAdapter(list[C.Article]).validate_python(f["articles"], strict=True)
    full = DATA["F-FULL"]["exchanges"][0]["response"]
    assert f["jobId"] == full["jobId"] and len(f["articles"]) == full["sections"]["news"]["result"]["articleTotal"] == 693
    assert full["sections"]["news"]["result"]["articles"] == f["articles"][:20]
    assert [a["id"] for a in f["articles"]] == [f"a{i}" for i in range(1, 694)]
    dates = [a["date"] for a in f["articles"]]
    assert dates == sorted(dates, reverse=True)


def test_no_korean_keys_anywhere():
    hangul = re.compile(r"[가-힣]")
    bad = [(name, p, k) for name, f in DATA.items() for p, k, _ in walk(f) if hangul.search(k)]
    assert bad == []


def test_no_score_or_probability_fields():
    banned_parts = {"score", "scores", "prob", "probability", "likelihood", "rating", "grade", "rank", "ranking", "chance",
                    "percentile", "fwci", "confidence"}
    banned_words = ("점수", "확률", "가능성", "추천", "등급", "합격", "탈락")
    parts = lambda k: {w.lower() for w in re.findall(r"[a-z]+|[A-Z][a-z]*", k)}  # noqa: E731  camelCase 낱말로 나눈다
    bad_keys = [(name, p, k) for name, f in DATA.items() for p, k, _ in walk(f) if parts(k) & banned_parts]
    bad_text = [(name, p, k) for name, f in DATA.items() for p, k, v in walk(f)
                if isinstance(v, str) and any(w in v for w in banned_words)]
    assert bad_keys == [] and bad_text == []


def test_no_real_company_data():
    text = "\n".join(p.read_text(encoding="utf-8") for p in FILES)
    for real in ("기준 기업", "ReferenceCo", "합병 전 법인", "FormerCo", "퓨리오사", "Furiosa", "딥엑스", "DeepX", "모빌린트", "Mobilint", "NVIDIA", "엔비디아",
                 "Qualcomm", "Groq", "뤼튼", "Wrtn", "업스테이지", "Upstage", "People Data Labs 회사 카드 (Liner Premium) ·"):
        assert real not in text, real
    urls = [v for _, f in DATA.items() for _, k, v in walk(f) if isinstance(v, str) and re.search(r"(?i)url$", k) and v]
    assert urls and all(u.startswith("https://example.com/") for u in urls)


LETTERS = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", ["에이", "비", "씨", "디", "이", "에프", "지", "에이치", "아이", "제이", "케이", "엘", "엠",
                                                 "엔", "오", "피", "큐", "알", "에스", "티", "유", "브이", "더블유", "엑스", "와이", "제트"]))


def gp_key(name: str) -> str:
    """web/lib/finder.ts gpKey 와 같은 규칙."""
    s = re.sub(r"주식회사|유한회사|유한책임회사|\(주\)|\(유\)|㈜", "", name)
    s = re.sub(r"[\s·.,&()\-]", "", s)
    return re.sub(r"[A-Z]", lambda m: LETTERS[m.group(0)], s).lower()


def test_fake_investors_do_not_match_real_fund_managers():
    gps = {gp_key(f["gp"]) for f in json.loads((ROOT / "web" / "public" / "data" / "funds.json").read_text(encoding="utf-8"))}
    names = set()
    for _, job in jobs():
        names |= {i["name"] for i in job["merged"]["investors"]}
        for s in ("facts",):
            r = job["sections"][s]["result"]
            names |= {i["name"] for i in (r or {}).get("investors", [])}
        rd = job["sections"]["rivals_deep"]["result"]
        names |= {n for x in (rd or {}).get("rivalInvestors", []) for n in x["investors"]}
    assert names and not {n for n in names if gp_key(n) in gps}


# ---------------------------------------------------------------- 규칙

def test_job_envelope_rules():
    for name, job in jobs():
        sec = job["sections"]
        assert list(sec) == list(C.SECTION_KEYS), name
        assert job["companyId"] == C.company_id_for(job["query"], job["company"]["crno"]), name
        assert job["paid"]["liner"] == {k: sum(s["paid"][k] for s in sec.values()) for k in ("search", "premium", "model", "scholar")}, name
        assert job["estimates"] == C.ESTIMATES
        if job["status"] == "running":
            assert job["busy"] and job["analyzedAt"] is None, name
        else:
            assert job["analyzedAt"] is not None and job["merged"]["pending"] == [], name
        for key, s in sec.items():
            assert s["key"] == key and s["expectedSeconds"] == C.EXPECTED_SECONDS[key], (name, key)
            st, res, err = s["status"], s["result"], s["error"]
            if st == "done":
                assert res is not None and err is None, (name, key)
            elif st == "partial":
                assert res is not None and err is not None, (name, key)
            elif st == "unavailable":
                assert err is not None and (res is not None) == (err["code"] == "no_data"), (name, key)
            else:
                assert res is None and err is None and s["analyzedAt"] is None, (name, key)
            if st in C.TERMINAL_SECTION_STATUSES:
                assert s["analyzedAt"] and s["startedAt"] and s["seconds"] is not None, (name, key)
            if st == "waiting":
                assert s["waitingFor"], (name, key)
            if err and err["code"] == "daily_limit":
                assert err["retryAt"] and not s["retryable"], (name, key)
            if job["isExample"] and key != "sales":
                assert not s["retryable"], (name, key)
        news = sec["news"]["result"]
        if news:
            assert len(news["articles"]) <= 20 and news["articleTotal"] >= len(news["articles"])
            assert [c["category"] for c in news["categoryCounts"]] and {c["category"] for c in news["categoryCounts"]} == set(C.NEWS_CATEGORIES)
            counts = [c["count"] for c in news["categoryCounts"]]
            assert counts == sorted(counts, reverse=True)


def test_value_rules():
    for name, job in jobs():
        for v in values_in(job["merged"]):
            if v["status"] == "unavailable":
                assert v["display"] is None and v["reason"] and v["values"] is None, name
            elif v["status"] == "conflicting":
                assert v["values"] and (v["usedIndex"] is None or v["raw"] == v["values"][v["usedIndex"]]["raw"]), name
            else:
                assert v["display"] and v["reason"] is None and v["values"] is None and v["usedIndex"] is None, name
            s = v["source"]
            if s:
                assert s["label"] == C.source_label(s["org"], s["name"], s["kind"]), name


def test_merged_rules():
    for name, job in jobs():
        m, sec = job["merged"], job["sections"]
        assert all(i["status"] in ("confirmed", "reported") for i in m["investors"]), name
        foreign = {c["name"] for c in ((sec["facts"]["result"] or {}).get("competitors") or []) if not c["domestic"]}
        assert not foreign & {r["name"] for r in m["rivals"]}, name
        assert len({r["key"] for r in m["rivals"]}) == len(m["rivals"]) and all(r["key"].startswith("rival:") for r in m["rivals"])
        both = [len(r["foundIn"]) == 2 for r in m["rivals"]]
        assert both == sorted(both, reverse=True), name  # 두 단락이 모두 낸 후보가 먼저
        assert set(m["pending"]) <= set(C.PENDING_KEYS) and len(m["bidKeywords"]) <= 6
        if m["fundField"] and m["fundField"]["status"] != "unavailable":
            assert m["fundField"]["display"] == C.FUND_FIELD_LABEL[m["fundField"]["raw"]]
        if sec["facts"]["status"] not in C.TERMINAL_SECTION_STATUSES:
            assert m["employees"] is None and "employees" in m["pending"], name


def test_full_fixture_counts_follow_acceptance():
    job = DATA["F-FULL"]["exchanges"][0]["response"]
    s, m = job["sections"], job["merged"]
    o, p, fh, n, pt = (s[k]["result"] for k in ("official", "profile", "funding_history", "news", "patents"))
    assert (len(o["financials"]), len(o["nps"]["monthly"]), len(p["products"]), len(p["coreTech"]), p["sourceCount"]) == (3, 12, 6, 6, 25)
    assert len(fh["rounds"]) == 10 and sum(1 for r in fh["rounds"] if r["otherAmounts"]) == 1 and len(fh["investors"]) == 31
    assert len(m["investors"]) == 35 and len(n["events"]) == 14 and n["articleTotal"] == 693 and len(n["trends"]) == 5
    assert (pt["summary"]["total"], pt["summary"]["registered"], pt["pagesChecked"], pt["pagesLimit"], len(pt["mentions"])) == (11, 8, 30, 30, 1)
    assert len(m["rivals"]) == 4 and any(r["nameEn"] and len(r["foundIn"]) == 2 for r in m["rivals"])
    assert {"해외갑", "해외을"} <= {c["name"] for c in s["facts"]["result"]["competitors"]}
    assert "가짜낱말" in [k["ko"] for k in m["techKeywords"]] and "긴요약표지" in n["longSummary"]
    assert job["paid"]["liner"] == {"search": 11, "premium": 2, "model": 6, "scholar": 0}  # 기본 분석 19회(설계 6.5)


def test_variant_fixtures():
    get = lambda name, i=0: DATA[name]["exchanges"][i]["response"]  # noqa: E731
    steps = DATA["F-STAGED"]["exchanges"]
    assert [e["label"] for e in steps] == [f"t{i}" for i in range(7)]
    order = ["official", "profile", "funding_history", "patents", "news", "facts"]
    for i, e in enumerate(steps):
        sec = e["response"]["sections"]
        assert all((sec[k]["status"] == "done") == (j < i) for j, k in enumerate(order)), i
    assert get("F-LIMIT-NEWS")["sections"]["news"]["error"]["code"] == "daily_limit"
    noc = get("F-NOCORP")
    assert noc["company"]["crno"] is None and noc["companyId"].startswith("n-")
    assert noc["sections"]["official"]["error"]["code"] == "no_corp" and noc["merged"]["region"]["status"] == "reported"
    f = get("F-CONFLICT")["merged"]["founded"]
    assert f["status"] == "conflicting" and [v["display"] for v in f["values"]] == ["2020-09-15", "2021-01"] and f["usedIndex"] == 0
    stale = datetime.fromisoformat(get("F-STALE")["analyzedAt"])
    assert (datetime(2026, 11, 22, 21, 0, tzinfo=L.KST) - stale).days == 45
    assert get("F-EXAMPLE", 1)["isExample"] and get("F-EXAMPLE", 2)["code"] == "example_readonly"
    emp = get("F-EMPTY")["sections"]
    assert all(emp[k]["error"]["code"] == "no_data" for k in ("funding_history", "news", "patents"))
    cum = get("F-MONEY")["sections"]["funding_history"]["result"]["summary"]["cumulative"]
    assert cum["byCurrency"] == {"USD": 2.5e8, "KRW": 3.0e10}
    assert sum(1 for r in get("F-MONEY")["sections"]["official"]["result"]["financials"] if r["operatingIncome"] < 0) == 1
    corp7 = get("F-CORP-7")["candidates"]
    assert len(corp7) == 7 and sum(c["exact"] for c in corp7) == 1 and sum(bool(c["snapshotAt"]) for c in corp7) == 1
    assert [len(get(f"F-CORP-{k}")["candidates"]) for k in "012"] == [0, 1, 2] and all(c["exact"] for c in get("F-CORP-2")["candidates"])
    # 이름이 같은 2곳만 이전 이름을 조회한다(한 곳은 있음, 다른 곳은 이력 없음 []). 이름이 겹치지 않는 후보는 null
    corp2 = get("F-CORP-2")["candidates"]
    assert [c["formerNames"] for c in corp2] == [[{"name": "주식회사 라마바코리아", "changedOn": "2024-12-11"}], []]
    assert len({(c["ceo"], c["region"], c["district"]) for c in corp2}) == 1 and len({c["bzno"] for c in corp2}) == 2
    assert all(c["formerNames"] is None for c in corp7 + get("F-CORP-1")["candidates"])
    assert DATA["F-DOWN"]["exchanges"][0]["status"] >= 500
    intr = get("F-INTERRUPTED")
    assert intr["status"] == "interrupted" and sum(intr["sections"][k]["status"] == "done" for k in ("official", "profile", "funding_history")) == 3
    rows = get("F-NOTICE")["match"]["rows"]
    assert [sum(r["verdict"] == v for r in rows) for v in ("충족", "미충족", "확인 필요", "판단 대상 아님")] == [4, 1, 2, 2]
    b = get("F-BRIEF")
    assert (len(b["facts"]), len(b["fit"]), len(b["questions"]), len(b["sources"])) == (4, 2, 2, 6)
    rd = get("F-RIVALS", 1)["sections"]["rivals_deep"]["result"]
    assert len(rd["rivals"]) == 2 and any(r["financials"] == [] and r["financialsReason"] for r in rd["rivals"])
    # 원문 링크 기록(계약 8.9): 특허 낱건 수 = 건수(등록 = registrationNo 있는 낱건), 요약에 넘긴 기사. 하하테크는 둘 다 빈 목록
    assert [(len(r["patents"]["items"]), len(r["summary"]["inputArticles"])) for r in rd["rivals"]] == [(6, 4), (0, 0)]
    for r in rd["rivals"]:
        items = r["patents"]["items"]
        assert len(items) == r["patents"]["total"] <= L.PATENT_PAGES_PER_COMPANY
        assert sum(1 for p in items if p["registrationNo"]) == r["patents"]["registered"]
        assert [p["filingDate"] for p in items] == sorted((p["filingDate"] for p in items), reverse=True)
    items = get("F-SALES", 1)["sections"]["sales"]["result"]["items"]
    assert [sum(i["status"] == s for i in items) for s in ("open", "upcoming", "closed")] == [7, 2, 3]
    assert sum(i["relevance"] == "high" for i in items) == 4
    assert get("F-SALES-PARTIAL")["sections"]["sales"]["status"] == "partial"
    h = get("F-HTML")
    assert h["sections"]["news"]["result"]["articles"][0]["title"] == "<b>굵게</b>"
    assert h["sections"]["patents"]["result"]["patents"][0]["abstract"] == "<img src=x onerror=alert(1)>"


def test_news_pages_slice_the_full_list():
    articles = DATA["F-FULL.articles"]["articles"]
    for ex in DATA["F-FULL"]["exchanges"]:
        if ex["method"] != "GET" or not ex["path"].endswith("/news"):
            continue
        page, q = ex["response"], ex["query"]
        pool = [a for a in articles if not page["categories"] or set(a["categories"]) & set(page["categories"])]
        assert page["total"] == len(pool) and page["items"] == pool[q["offset"]:q["offset"] + q["limit"]]
        assert page["articleTotal"] == 693


# ---------------------------------------------------------------- 계약 규칙 함수

def test_company_id_rules():
    assert C.company_id_for("아무 이름", "000000-0000001") == "0000000000001"
    a = C.company_id_for("주식회사 가나다테크")
    assert a == C.company_id_for("(주) 가나다 테크") == C.company_id_for("㈜가나다테크") and C.COMPANY_ID_RE.fullmatch(a)
    assert C.company_id_for("가나다테크", "12345") == a  # 13자리가 아니면 이름 기반
    with pytest.raises(ValueError):
        C.company_id_for("(주)")


def test_address_and_money_rules():
    assert C.split_address("서울특별시 강남구 예시로 1") == ("서울", "강남구")
    assert C.split_address("경기도 성남시 분당구 예시로 1") == ("경기", "성남시 분당구")
    assert C.split_address("세종특별자치시 예시로 1") == ("세종", None)
    assert C.split_address("전북특별자치도 전주시 완산구 예시로") == ("전북", "전주시 완산구")
    assert C.split_address("경기도 광주시 예시로") == ("경기", "광주시")
    assert C.split_address("") == (None, None)
    assert C.won_display(5_670_000_000) == "56.7억원" and C.won_display(-2.1e9) == "-21.0억원" and C.won_display(3_000_000) == "300만원"


def test_ts_contract_constants_match_python():
    ts = (ROOT / "web" / "lib" / "contract.ts").read_text(encoding="utf-8")

    def arr(name):
        m = re.search(rf"export const {name} = \[(.*?)\] as const;", ts, re.S)
        return tuple(re.findall(r'"([^"]+)"', m.group(1)))
    assert arr("STATUSES") == C.STATUSES and arr("SECTION_KEYS") == C.SECTION_KEYS
    assert arr("BASIC_SECTIONS") == C.BASIC_SECTIONS and arr("ON_DEMAND_SECTIONS") == C.ON_DEMAND_SECTIONS
    assert arr("SECTION_ERROR_CODES") == C.SECTION_ERROR_CODES and arr("API_ERROR_CODES") == C.API_ERROR_CODES
    assert arr("NEWS_CATEGORIES") == C.NEWS_CATEGORIES and arr("PENDING_KEYS") == C.PENDING_KEYS
    assert f"CONTRACT_VERSION = {C.CONTRACT_VERSION};" in ts
    for key, sec in C.EXPECTED_SECONDS.items():
        assert f"{key}: {'null' if sec is None else sec}" in ts.split("EXPECTED_SECONDS")[1].split("};")[0]
    est = ts.split("DEFAULT_ESTIMATES")[1].split("};")[0]
    for key, e in C.ESTIMATES["sections"].items():
        seconds = "null" if e["seconds"] is None else e["seconds"]
        per = "null" if e["perRival"] is None else e["perRival"]
        assert f"{key}: {{ seconds: {seconds}, liner: {e['liner']}, perRival: {per} }}" in est, key
    full = C.ESTIMATES["full"]
    assert f"full: {{ seconds: {full['seconds']}, liner: {full['liner']}, perRival: null }}" in est


def test_rivals_deep_estimate_matches_section_caps():
    """깊이 비교 예상값(5곳 기준 liner, 한 곳당 perRival)은 단락 Liner 상한 식과 같다(실제 서버 검증에서 7 → 6으로 바로잡음)."""
    liner_sum = lambda n: sum(v for k, v in L.section_caps("rivals_deep", rivals=n).items() if k in L.LINER_APIS)  # noqa: E731
    est = C.ESTIMATES["sections"]["rivals_deep"]
    assert est["liner"] == liner_sum(L.MAX_RIVALS) == liner_sum(5)
    assert all(liner_sum(n + 1) - liner_sum(n) == est["perRival"] for n in range(1, 5))


# ---------------------------------------------------------------- research/ 를 불러오지 않음

@pytest.mark.parametrize("path", sorted((ROOT / "growth").glob("*.py")) + sorted((ROOT / "api").glob("*.py")), ids=lambda p: p.name)
def test_growth_and_api_do_not_import_research(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    mods = [a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names]
    mods += [n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert not [m for m in mods if m == "research" or m.startswith("research.")]
    src = path.read_text(encoding="utf-8")
    if path.parent.name == "growth":  # 팀원이 공용 파일에 더한 학술 검색에 기대지 않는다(계약 16절)
        assert not re.search(r"\bsearch_scholar\b|SEARCH_SCHOLAR_PATH|MAX_SCHOLAR_CALLS", src)


def test_analysis_router_declares_contract_endpoints():
    import api.main as api_main
    routes = {(m.upper(), path) for path, ops in api_main.app.openapi()["paths"].items() for m in ops}
    for want in [("GET", "/api/corp/search"), ("POST", "/api/analysis"), ("GET", "/api/analysis/{job_id}"),
                 ("POST", "/api/analysis/{job_id}/sections/{key}"), ("GET", "/api/analysis/{job_id}/news"),
                 ("GET", "/api/company/{company_id}/analysis"), ("GET", "/api/company/{company_id}/job"), ("GET", "/api/example"),
                 ("GET", "/api/health"), ("POST", "/api/notice/analyze"), ("POST", "/api/gp/brief")]:
        assert want in routes, want


# ---------------------------------------------------------------- 호출 상한 인터페이스

NOW = datetime(2026, 11, 22, 23, 59, 0, tzinfo=L.KST)


@pytest.fixture(autouse=True)
def fresh_limits():
    L._reset_for_tests({})
    yield
    L._reset_for_tests({})


def test_api_names_and_tables_are_complete():
    assert set(L.DAILY_LIMITS) == set(L.API_NAMES)
    assert (L.DAILY_LIMITS[L.LINER_SEARCH], L.DAILY_LIMITS[L.LINER_PREMIUM], L.DAILY_LIMITS[L.LINER_MODEL], L.DAILY_LIMITS[L.LINER_SCHOLAR]) == (500, 100, 200, 200)
    assert set(L.SECTION_CAPS) == set(C.SECTION_KEYS)
    assert all(api in L.API_NAMES for caps in [*L.SECTION_CAPS.values(), L.RIVAL_CAPS] for api in caps)
    liner_cap = lambda s, **kw: sum(n for api, n in L.section_caps(s, **kw).items() if api in L.LINER_APIS)  # noqa: E731
    assert [liner_cap(s) for s in ("profile", "facts", "funding_history", "news", "patents")] == [4, 8, 4, 3, 2]
    assert liner_cap("rivals_deep", rivals=5) == 34 and L.section_caps("papers")[L.LINER_SCHOLAR] == 12
    assert L.PATENT_PAGES_PER_COMPANY == 30 and L.CONCURRENCY[L.PATENTS_PAGE] == 4
    assert L.worst_case(3) == 3 * (1 + MAX_AUTO_RETRIES)


def test_section_budget_reserves_worst_case_and_settles_actual():
    b = L.reserve_section("news", now=NOW)
    assert b.liner_client_limits() == {"search": 2, "premium": 0, "model": 1, "agent": 0}
    held = L.usage_today(now=NOW)["apis"][L.LINER_SEARCH]
    assert held == {"used": 0, "limit": 500, "remaining": 500 - L.worst_case(2)}
    calls = [{"kind": "search", "include_knowledge": False}, {"kind": "search", "include_knowledge": False}, {"kind": "model"}]
    assert b.settle(L.liner_used(calls)) == {"search": 2, "premium": 0, "model": 1, "scholar": 0}
    assert L.usage_today(now=NOW)["apis"][L.LINER_SEARCH] == {"used": 2, "limit": 500, "remaining": 498}
    b.settle({L.LINER_SEARCH: 99})  # 두 번째 settle 은 무시
    assert L.usage_today(now=NOW)["apis"][L.LINER_SEARCH]["used"] == 2


def test_premium_counts_in_linerclient_search_limit():
    b = L.reserve_section("funding_history", now=NOW)
    lim = b.liner_client_limits()
    assert lim == {"search": 3, "premium": 2, "model": 1, "agent": 0}
    client = LinerClient("test-key", limits=lim)  # 원래 LinerClient 키만 쓴다(학술 검색 키 없음)
    assert {k: v["limit"] for k, v in client.usage().items() if k in lim} == lim
    client.close()
    used = L.liner_used([{"kind": "search", "include_knowledge": True}, {"kind": "search", "include_knowledge": True}])
    assert used == {L.LINER_SEARCH: 0, L.LINER_PREMIUM: 2, L.LINER_MODEL: 0}
    b.settle(used)


def test_plain_search_cannot_use_premium_share():
    """funding_history(일반 검색 1, Premium 2): Premium 여유가 남아 있어도 두 번째 일반 검색은 보내지 않는다."""
    sent = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        sent.append("premium" if body.get("include_knowledge") else ("model" if "messages" in body else "search"))
        if "messages" in body:
            return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}], "usage": {}})
        return httpx.Response(200, json={"results": []})

    b = L.reserve_section("funding_history", now=NOW)
    client = b.liner_client("test-key", transport=httpx.MockTransport(handler))
    client.search_web("일반 검색 1")
    assert client.remaining("search") == 0 and client.remaining("premium") == 2
    with pytest.raises(L.LimitReached) as e:
        client.search_web("일반 검색 2")
    assert (e.value.api, e.value.scope, e.value.limit) == (L.LINER_SEARCH, "section", 1)
    assert isinstance(e.value, CallLimitExceeded)  # 기존 엔진(pipeline)은 자체 한도처럼 기록하고 계속한다
    client.search_web("Premium 1", include_knowledge=True)
    client.search_web("Premium 2", include_knowledge=True)
    with pytest.raises(L.LimitReached) as e:
        client.search_web("Premium 3", include_knowledge=True)
    assert e.value.api == L.LINER_PREMIUM
    client.chat_json("m", "s", "u", schema={"type": "object"})
    with pytest.raises(L.LimitReached):
        client.responses("i", "u")
    assert sent == ["search", "premium", "premium", "model"]  # 거절한 요청은 나가지 않았다
    paid = b.settle(L.liner_used(client.calls))
    client.close()
    assert paid == {"search": 1, "premium": 2, "model": 1, "scholar": 0}
    assert L.usage_today(now=NOW)["apis"][L.LINER_SEARCH] == {"used": 1, "limit": 500, "remaining": 499}
    with pytest.raises(ValueError):
        b.take_liner(L.NAVER_NEWS)


def test_engine_records_section_limit_and_continues():
    """facts 처럼 기존 엔진에 넘겨도, 단락 상한에 닿은 검색은 오류로 기록되고 실행은 이어진다."""
    import pipeline as pl
    b = L.reserve_section("profile", now=NOW)
    client = b.liner_client("test-key", transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"results": []})))
    run = pl.new_run("가나다테크", "대한민국", pl.default_options(use_agent=False))
    steps = [{"key": f"k{i}", "query": f"q{i}", "country_code": "kr", "lang": "ko", "category": "profile"} for i in range(4)]
    assert [pl._do_search(run, client, s, lambda m: None) for s in steps] == [True, True, True, False]
    assert len(client.calls) == 3 and client.remaining("search") == 0
    b.settle(L.liner_used(client.calls))
    client.close()


def test_daily_limit_raises_with_next_midnight_and_reserves_nothing():
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_LINER_SEARCH": "5", "GROWTH_DAILY_LIMIT_NAVER_NEWS": "none"})
    assert L.usage_today(now=NOW)["apis"][L.NAVER_NEWS]["limit"] is None
    with pytest.raises(L.LimitReached) as e:
        L.reserve_section("facts", now=NOW)  # 검색 worst_case(4)=8 > 5
    err = e.value
    assert (err.api, err.scope, err.limit) == (L.LINER_SEARCH, "daily", 5)
    assert err.retry_at == datetime(2026, 11, 23, tzinfo=L.KST) and err.retry_at_iso == "2026-11-23T00:00:00+09:00"
    assert "LINER" not in err.message and "liner" not in err.message
    assert L.usage_today(now=NOW)["apis"][L.LINER_MODEL]["remaining"] == 200  # 하나라도 넘으면 아무것도 잡지 않는다
    assert L.remaining(L.LINER_SEARCH, now=NOW + timedelta(minutes=2)) == 5  # 다음 날은 0부터


def test_free_api_section_cap_and_daily_cap():
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_PATENTS_PAGE": "31"})
    b = L.reserve_section("patents", now=NOW)
    for _ in range(30):
        b.use(L.PATENTS_PAGE, now=NOW)
    with pytest.raises(L.LimitReached) as e:
        b.use(L.PATENTS_PAGE, now=NOW)
    assert e.value.scope == "section" and e.value.retry_at is None
    with pytest.raises(L.LimitReached):
        b.use(L.NAVER_NEWS, now=NOW)  # 이 단락 표에 없는 API 는 0
    L.use(L.PATENTS_PAGE, now=NOW)
    with pytest.raises(L.LimitReached) as e:
        L.use(L.PATENTS_PAGE, now=NOW)
    assert e.value.scope == "daily"
    with pytest.raises(ValueError):
        b.use(L.LINER_SEARCH, now=NOW)
    b.settle({})


def test_reservation_context_counts_unsettled_as_used():
    with L.reserve(L.LINER_MODEL, 2, now=NOW):
        pass
    assert L.usage_today(now=NOW)["apis"][L.LINER_MODEL]["used"] == 2
    r = L.reserve(L.LINER_MODEL, 4, now=NOW)
    r.release()
    assert L.usage_today(now=NOW)["apis"][L.LINER_MODEL] == {"used": 2, "limit": 200, "remaining": 198}


def test_refresh_limit_per_company():
    cid = "0000000000001"
    for i in range(L.REFRESH_PER_COMPANY_PER_DAY):
        assert L.refresh_remaining(cid, now=NOW) == L.REFRESH_PER_COMPANY_PER_DAY - i
        L.take_refresh(cid, now=NOW)
    with pytest.raises(L.LimitReached) as e:
        L.take_refresh(cid, now=NOW)
    assert (e.value.api, e.value.scope) == (L.REFRESH, "refresh") and L.refresh_remaining("n-0123456789abcdef", now=NOW) == 3


def test_usage_today_matches_health_contract():
    TypeAdapter(C.UsageToday).validate_python(L.usage_today(now=NOW), strict=True)
    assert set(L.usage_today(now=NOW)["apis"]) == set(L.API_NAMES)
    with L.slot(L.DATAGOKR_NPS), L.slot(L.DATAGOKR_G2B):  # 공공데이터포털은 한 묶음
        assert L.slot(L.DATAGOKR_FSC_CORP) is L.slot(L.DATAGOKR_NPS)
