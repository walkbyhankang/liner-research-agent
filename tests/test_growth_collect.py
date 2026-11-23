"""growth/ 수집 모듈 테스트(팀원의 통합 분석 프로토타입(커밋 98d8c6c) 시험에서 옮긴 것 + 호출 상한·학술 검색). 실제 API 를 부르지 않는다."""
from __future__ import annotations

import json
import threading
import time
from datetime import date

import httpx
import pytest

from growth import common, company, funding_history as fh, gov, limits as L, news, papers, patents, public_data
from growth.liner import Liner, ScholarClient
from liner_client import LinerClient


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "CACHE_DIR", tmp_path / "cache")
    L._reset_for_tests({})
    yield
    L._reset_for_tests({})


def _client(handler, **limits):
    lim = {"search": 20, "model": 3, "agent": 0, "premium": 12}
    lim.update(limits)
    return LinerClient("k" * 20, "env", transport=httpx.MockTransport(handler), sleep=lambda s: None, limits=lim)


# ---------------------------------------------------------------- 공공 자료·뉴스·나라장터

def test_pick_recent_years_prefers_consolidated_and_computes_ratios():
    rows = [{"연도": "2022", "구분": "별도요약재무제표", "매출액": 100.0, "영업이익": 10.0},
            {"연도": "2023", "구분": "별도요약재무제표", "매출액": 150.0, "영업이익": -30.0},
            {"연도": "2023", "구분": "연결요약재무제표", "매출액": 200.0, "영업이익": 20.0},
            {"연도": "2024", "구분": "별도요약재무제표", "매출액": None, "영업이익": 5.0}]
    out = public_data.pick_recent_years(rows)
    assert [r["연도"] for r in out] == ["2022", "2023", "2024"]
    assert out[1]["구분"].startswith("연결") and out[1]["매출액 증가율(%)"] == 100.0 and out[1]["영업이익률(%)"] == 10.0
    assert out[2]["매출액 증가율(%)"] is None and out[2]["영업이익률(%)"] is None  # 값이 없으면 만들지 않는다
    row = public_data.financial_row(out[1], with_ratios=True)
    assert row["basisShort"] == "연결" and row["revenueGrowthPct"] == 100.0
    assert public_data.financial_row(out[1], with_ratios=False)["revenueGrowthPct"] is None


def test_news_dedup_groups_same_event():
    rows = [{"date": "2026-11-01", "title": "가나다테크, 1000억 투자 유치", "description": "", "url": "https://a.kr/1", "url_key": "a.kr/1", "publisher": "a.kr", "provider": "naver"},
            {"date": "2026-11-02", "title": "[단독] 가나다테크 1000억 투자유치", "description": "", "url": "https://b.kr/2", "url_key": "b.kr/2", "publisher": "b.kr", "provider": "naver"},
            {"date": "2026-06-01", "title": "가나다테크 신제품 공개", "description": "", "url": "https://c.kr/3", "url_key": "c.kr/3", "publisher": "c.kr", "provider": "liner"}]
    out = news.dedup(rows)
    assert len(out) == 2 and out[0]["관련 기사 수"] == 2 and "b.kr" in out[0]["매체"]
    assert "투자유치" in news.classify("가나다테크 투자 유치", "")


def test_gov_windows_never_exceed_seven_days():
    wins = gov._windows(28, date(2026, 11, 22))
    assert all((e - s).days <= 6 for s, e in wins) and wins[-1][0] == date(2026, 10, 26)


def test_former_names_unknown_when_history_exceeds_one_page(monkeypatch):
    """기록이 한 쪽(HISTORY_ROWS)을 넘으면 받은 쪽만으로 '이력 없음([])'을 확정하지 않고 모름(None)으로 둔다"""
    monkeypatch.setattr(common, "env", lambda k: "data-key-1234567890" if k == "DATA_GO_KR_SERVICE_KEY" else "")

    def handler(req):
        crno = req.url.params["crno"]
        rows = [{"crno": crno, "corpNm": "주식회사 가나다", "fstOpegDt": f"2026{(i % 12) + 1:02d}01"} for i in range(public_data.HISTORY_ROWS)]
        total = public_data.HISTORY_ROWS + 1 if crno.endswith("1") else public_data.HISTORY_ROWS
        return httpx.Response(200, json={"response": {"body": {"totalCount": total, "items": {"item": rows}}}})
    monkeypatch.setattr(public_data, "_http", httpx.Client(transport=httpx.MockTransport(handler)))
    out = public_data.former_names([{"crno": "1101110000001", "name": "주식회사 가나다"}, {"crno": "1101110000002", "name": "가나다"}])
    assert out == {"1101110000001": None, "1101110000002": []}  # 넘친 쪽은 모름, 딱 한 쪽이면 조회한 결과


def test_error_envelope_with_http_200_is_not_read_as_empty_or_cached(monkeypatch):
    """HTTP 200 이어도 결과 코드가 00 이 아니면 오류다: 이전 이름은 모름(None), 캐시하지 않아 다음 요청은 다시 묻는다"""
    monkeypatch.setattr(common, "env", lambda k: "data-key-1234567890" if k == "DATA_GO_KR_SERVICE_KEY" else "")
    calls = []

    def handler(req):
        calls.append(req.url.params.get("crno"))
        return httpx.Response(200, json={"response": {"header": {"resultCode": "22", "resultMsg": "LIMITED NUMBER OF SERVICE REQUESTS EXCEEDS ERROR."}}})
    monkeypatch.setattr(public_data, "_http", httpx.Client(transport=httpx.MockTransport(handler)))
    corps = [{"crno": "1101110000001", "name": "주식회사 가나다"}, {"crno": "1101110000002", "name": "가나다"}]
    assert public_data.former_names(corps) == {"1101110000001": None, "1101110000002": None}
    with pytest.raises(public_data.PublicDataError):
        public_data.find_corps("가나다")
    n = len(calls)
    assert public_data.former_names(corps) == {"1101110000001": None, "1101110000002": None} and len(calls) == n + 2  # 캐시 안 됨


def test_find_corps_counts_each_attempt_and_stops_at_section_cap(monkeypatch):
    monkeypatch.setattr(common, "env", lambda k: "data-key-1234567890" if k == "DATA_GO_KR_SERVICE_KEY" else "")
    monkeypatch.setattr(public_data, "_sleep", lambda s: None)
    seen = []

    def handler(req):
        seen.append(req.url.params["corpNm"])
        if len(seen) == 1:
            return httpx.Response(503)  # 첫 시도 실패 → 1회 재시도(이것도 센다)
        item = {"crno": "1101110000001", "corpNm": "주식회사 가나다", "bzno": "1234567890", "lastOpegDt": "20260101"}
        return httpx.Response(200, json={"response": {"body": {"totalCount": 1, "items": {"item": [item]}}}})
    monkeypatch.setattr(public_data, "_http", httpx.Client(transport=httpx.MockTransport(handler)))
    b = L.reserve_section("identity")
    out = public_data.find_corps("가나다", use=b.use)  # 질의 하나(공백 없음): 시도 2회
    assert [c["crno"] for c in out] == ["1101110000001"] and out[0]["exact"] and len(seen) == 2
    assert public_data.find_corps("가나다", use=b.use)[0]["crno"] == "1101110000001" and len(seen) == 2  # 캐시 적중은 세지 않는다
    public_data.find_corps("가 나 다 라", use=b.use)  # 질의 둘(그대로, 공백 뺀 것): 4회째
    with pytest.raises(L.LimitReached) as e:  # identity 단락 상한 fsc_corp 4
        public_data.find_corps("마바사", use=b.use)
    assert e.value.scope == "section" and len(seen) == 4
    b.settle({})
    assert "data-key" not in json.dumps(out)


def test_former_names_only_for_same_names_and_capped_per_search(monkeypatch):
    monkeypatch.setattr(common, "env", lambda k: "data-key-1234567890" if k == "DATA_GO_KR_SERVICE_KEY" else "")
    monkeypatch.setattr(public_data, "_sleep", lambda s: None)
    asked = []

    def handler(req):
        crno = req.url.params["crno"]
        asked.append(crno)
        items = [{"crno": crno, "corpNm": "주식회사 라마바", "fstOpegDt": "20200101", "lastOpegDt": "20231231"},
                 {"crno": crno, "corpNm": "가나다 주식회사", "fstOpegDt": "20240102", "lastOpegDt": "20261121"},
                 {"crno": crno, "corpNm": "(주)가나다", "fstOpegDt": "20250101", "lastOpegDt": "20250105"}]
        return httpx.Response(200, json={"response": {"body": {"totalCount": 3, "items": {"item": items}}}})
    monkeypatch.setattr(public_data, "_http", httpx.Client(transport=httpx.MockTransport(handler)))
    # 이름이 겹치지 않으면 한 번도 부르지 않는다
    assert public_data.former_names([{"crno": "1101110000001", "name": "주식회사 가나다"}, {"crno": "1101110000002", "name": "가나다랩"}]) == {}
    assert asked == []
    # 이름이 같은 후보 10곳: 기본 상한 8회까지만 부르고 나머지는 모름(None). 다른 이름(가나다랩)은 결과에 없다
    corps = [{"crno": f"11011100000{i:02d}", "name": "주식회사 가나다" if i % 2 else "가나다 주식회사"} for i in range(1, 11)]
    used = []
    out = public_data.former_names(corps + [{"crno": "1101110000099", "name": "가나다랩"}], use=used.append)
    assert public_data.HISTORY_CALLS_PER_SEARCH == 8 and len(asked) == 8 and used == [L.DATAGOKR_FSC_CORP] * 8
    assert set(out) == {c["crno"] for c in corps} and [out[c["crno"]] for c in corps[8:]] == [None, None]
    assert out[corps[0]["crno"]] == [{"name": "주식회사 라마바", "changedOn": "2024-01-02"}]
    # 단락 예산(identity fsc_corp 4)으로 세면 상한을 넘는 요청은 보내지 않고 모름(None)으로 둔다
    asked.clear()
    b = L.reserve_section("identity")
    out = public_data.former_names([{"crno": f"22011100000{i:02d}", "name": "가나다"} for i in range(1, 7)], use=b.use)
    assert len(asked) == 4 and sum(v is None for v in out.values()) == 2
    b.settle({})


def test_public_data_missing_key_is_reported(monkeypatch):
    monkeypatch.setattr(common, "env", lambda k: "")
    with pytest.raises(public_data.MissingKey):
        public_data.find_corps("가나다")


def test_g2b_search_marks_limit_and_converts_rows(monkeypatch):
    monkeypatch.setattr(common, "env", lambda k: "data-key-1234567890")
    item = {"bidNtceNo": "R26BK0001", "bidNtceOrd": "000", "bidNtceNm": "AI 서버 구매", "ntceInsttNm": "가나다시청",
            "bidBeginDt": "2026-11-20 10:00:00", "bidClseDt": "2099-12-01 18:00:00", "asignBdgtAmt": "320000000",
            "bidMethdNm": "전자입찰", "cntrctCnclsMthdNm": "일반경쟁", "bidNtceDtlUrl": "https://example.com/bid/1", "bidNtceDt": "2026-11-19 09:00:00"}
    body = {"response": {"header": {"resultCode": "00"}, "body": {"items": [item]}}}
    monkeypatch.setattr(gov, "_http", httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=body))))
    b = L.reserve_section("sales")
    g = gov.g2b_search(["AI 서버"], ["AI 서버"], days=28, use=b.use)
    assert g["calls"] == 8 and g["error_count"] == 0 and g["limit"] is None
    bid = gov.bid_contract(g["items"][0])
    assert (bid["id"], bid["status"], bid["relevance"], bid["amount"], bid["kind"]) == ("R26BK0001-000", "open", "high", "3.20억원", "물품")
    assert bid["bidBegin"] == "2026-11-20 10:00" and bid["keywords"] == ["AI 서버"]
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_DATAGOKR_G2B": "3"})
    common.CACHE_DIR = common.CACHE_DIR / "fresh"
    b = L.reserve_section("sales")
    g = gov.g2b_search(["반도체"], [], days=28, use=b.use)
    assert g["limit"] is not None and g["limit"].scope == "daily" and g["error_count"] >= 5


def test_core_keyword_match_does_not_cross_word_boundaries_for_latin_keywords():
    """'핵심 낱말 일치'는 공고명에 그 낱말이 실제로 있을 때만. 영문 낱말은 공백을 지운 채 견주지 않는다(실제 서버 검증에서 찾음)."""
    assert gov._hits("[시험분석] single cell multiome 시험분석 용역", ["LLM"]) == []
    assert gov._hits("INfusion PUmp 구매", ["NPU"]) == []
    assert gov._hits("반도체 현장 특화 SLLM 개발 용역", ["LLM"]) == ["LLM"]  # 낱말 안에 그대로 있으면 일치
    assert gov._hits("AI OCR 솔루션 도입", ["ocr"]) == ["ocr"]
    assert gov._hits("생성형AI 플랫폼 구축", ["생성형 AI"]) == ["생성형 AI"]  # 한글이 든 낱말은 띄어쓰기를 무시
    assert gov._hits("문서인식 시스템", ["문서 인식"]) == ["문서 인식"]
    assert gov._hits("machine  learning 과제", ["Machine Learning"]) == ["Machine Learning"]
    assert gov._hits("아무 공고", ["", "  "]) == []


# ---------------------------------------------------------------- Liner 래퍼·학술 검색

def test_liner_wrapper_caches_and_swallows_errors():
    n = {"calls": 0}

    def handler(req):
        n["calls"] += 1
        if "chat/completions" in req.url.path:
            return httpx.Response(500, json={"error": {"message": "boom"}})
        return httpx.Response(200, json={"results": [{"title": "t", "url": "https://x", "description": "d"}]})
    lw = Liner(_client(handler, model=2))
    assert lw.search("q")[0]["title"] == "t" and lw.search("q")[0]["title"] == "t"
    assert n["calls"] == 1 and lw.cache_hits == 1 and lw.succeeded == 2  # 같은 검색은 다시 부르지 않는다
    assert lw.json("s", "u", {"type": "object"}, name="x") is None and lw.errors and lw.failures == 1  # 모델 실패는 None + 기록
    fresh = Liner(_client(handler), fresh=True)
    fresh.search("q")
    assert n["calls"] == 4  # 새로 분석은 캐시를 건너뛴다(모델 2회 = 500 재시도 포함)


def test_single_flight_calls_api_once_under_concurrency():
    n = {"calls": 0}

    def handler(req):
        n["calls"] += 1
        time.sleep(0.05)
        return httpx.Response(200, json={"results": [{"title": "t", "url": "https://x"}]})
    lw = Liner(_client(handler))
    out = []
    ts = [threading.Thread(target=lambda: out.append(lw.search("같은 질의"))) for _ in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert n["calls"] == 1 and len(out) == 8 and lw.cache_hits == 7  # 동시에 같은 질의 8번 → 유료 호출 1회


def test_cache_put_is_safe_under_concurrent_writes():
    def w(i):
        for _ in range(20):
            common.cache_put("t", {"k": 1}, {"v": i})
    ts = [threading.Thread(target=w, args=(i,)) for i in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert common.cache_get("t", {"k": 1}, 1)["v"] in range(6)  # 손상 없이 읽힌다


def test_cache_layout_keeps_existing_cache_folder():
    """같은 폴더·열쇠 규칙(results/cache/research/<종류>/<sha1(ident)[:20]>.json)이라 쌓인 캐시를 그대로 쓴다."""
    import hashlib
    ident = {"q": "가나다", "lang": "ko", "c": "kr", "n": 10, "d": None}
    h = hashlib.sha1(json.dumps(ident, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:20]
    assert common._cache_path("liner_search", ident) == common.CACHE_DIR / "liner_search" / f"{h}.json"


def test_scholar_client_takes_budget_retries_once_and_counts_attempts():
    sent = []

    def handler(req):
        sent.append(json.loads(req.content))
        assert req.url.path == "/api/v1/tools/search/scholar" and req.headers["x-api-key"] == "k" * 20
        if len(sent) == 1:
            return httpx.Response(524, headers={"retry-after": "1"})
        return httpx.Response(200, json={"results": [{"title": "논문", "url": "https://example.com/p", "date": "2025-01-02",
                                                      "authors": ["갑", "을"], "journal": "J", "citationCount": 4}]})
    waits = []
    b = L.reserve_section("papers")
    sc = ScholarClient("k" * 20, b, transport=httpx.MockTransport(handler), sleep=waits.append)
    lw = Liner(None, scholar=sc)
    rows = papers.scholar_extra(lw, "neural accelerator")
    assert rows[0]["저자"] == "갑; 을" and rows[0]["출처"] == "Liner Scholar" and rows[0]["연도"] == "2025"
    assert sent[0] == {"query": "neural accelerator", "max_results": 10, "lang": "en"} and waits == [1.0] and sc.requests == 2
    assert b.liner_remaining(L.LINER_SCHOLAR) == 11  # 논리 호출 1회만 단락 상한에서 뺀다
    for i in range(11):
        sc.search(f"q{i}")
    with pytest.raises(L.LimitReached):
        sc.search("넘침")
    assert b.settle({L.LINER_SCHOLAR: sc.requests}) == {"search": 0, "premium": 0, "model": 0, "scholar": 13}
    sc.close()


def test_scholar_client_does_not_retry_timeouts():
    n = {"calls": 0}

    def handler(req):
        n["calls"] += 1
        raise httpx.ReadTimeout("slow", request=req)
    b = L.reserve_section("papers")
    sc = ScholarClient("k" * 20, b, transport=httpx.MockTransport(handler), sleep=lambda s: None)
    assert Liner(None, scholar=sc).scholar("q") == [] and n["calls"] == 1
    b.settle({L.LINER_SCHOLAR: sc.requests})


# ---------------------------------------------------------------- 회사 프로필

def test_domestic_only_drops_foreign_branch_self_and_duplicates():
    comps = [{"name": "퓨리오사AI", "is_korean": True, "country": "한국"},
             {"name": "엔비디아", "is_korean": False, "country": "미국"},
             {"name": "AWS코리아", "is_korean": True, "country": "한국", "reason": "아마존의 한국 법인"},
             {"name": "기준 기업", "is_korean": True, "country": "대한민국"},
             {"name": "퓨리오사 AI", "is_korean": True, "country": "South Korea"},
             {"name": "딥엑스", "is_korean": True, "country": "Korea"},
             {"name": "현대코리아", "is_korean": True, "country": "한국"}]  # '코리아' 이름만으로는 빼지 않는다
    keep, drop = company.domestic_only(comps, "기준 기업", "ReferenceCo")
    assert [c["name"] for c in keep] == ["퓨리오사AI", "딥엑스", "현대코리아"]
    assert {d["name"] for d in drop} == {"엔비디아", "AWS코리아", "기준 기업", "퓨리오사 AI"}
    assert len(company.domestic_only([{"name": f"국내{i}", "is_korean": True, "country": "한국"} for i in range(8)], "x")[0]) == 5


def test_profile_skips_model_when_search_finds_nothing():
    seen = []

    def handler(req):
        seen.append(req.url.path)
        return httpx.Response(200, json={"results": []})
    out = company.analyze("가나다", Liner(_client(handler)))
    assert out["sources"] == [] and out["profile"] == {} and seen.count("/api/v1/tools/search/web") == 3
    assert not any("chat" in p for p in seen)  # 자료가 없으면 모델을 부르지 않는다


# ---------------------------------------------------------------- 투자 이력

COLS = ["name", "status", "funding_stage", "total_raised", "location", "website", "funding_round_count", "funding_rounds", "also_known_as", "sources"]
REB = ["Ganada Tech", "", "Series C", "932981469.0", "Seoul, Korea", "ganada.example.com", "3",
       "Seed, 2020-11-23: $4M (가나다벤처스, Test Capital Co., Ltd., 서울대학교기술지주  SNU Tech Holdings); "
       "Series A, 2022-06-02: $70M (Test Investment Corp., 라마바인베스트, 산업은행); Corporate round, 2025-07-29", "가나다테크", "People Data Labs"]
SAP = ["Ganada Technology Holdings", "", "Series A", "106987540.0", "San Jose", "holdings.example.com", "2",
       "Series A, 2023-04-12: $45.3M (사아자파트너스, Test Ventures Z); Corporate round, 2022-06-22: $61.6M", "", "People Data Labs"]
OTHER = ["Ganad Defense", "", "Series B", "1", "US", "defense.example.com", "1", "Series B, 2021-09-01: $150M (Test Partners)", "", "PDL"]


def test_parse_funding_rounds_keeps_investors_and_unparsed_fragments():
    rs = fh.parse_funding_rounds(REB[7])
    assert [r["round"] for r in rs] == ["Seed", "Series A", "Corporate round"]
    assert rs[0]["amount_value"] == 4e6 and rs[0]["currency"] == "USD"
    assert "Test Capital Co., Ltd." in rs[0]["investors"] and len(rs[0]["investors"]) == 3
    assert rs[2]["amount"] == "" and rs[2]["investors"] == []  # 금액·투자자 없는 라운드도 버리지 않는다


def test_related_entity_rounds_are_kept_apart_from_this_company():
    """계약 8.5절·18절 9번: 이름만 비슷한 법인 카드의 라운드는 라운드·투자기관·누적액에서 빼고 relatedEntities 로."""
    data = {"knowledge": [{"title": "Companies matching", "columns": COLS, "rows": [REB, SAP, OTHER], "sources": ["People Data Labs"]}]}
    cards, rounds = fh.from_premium(data, ["가나다테크", "Ganada Tech"], "ganada.example.com", "q")
    assert {c["name"]: c["match"] for c in cards} == {"Ganada Tech": "exact", "Ganada Technology Holdings": "related"}
    assert all(r["entity"] != "Ganad Defense" for r in rounds)  # 이름만 닮은 다른 회사는 라운드에도 넣지 않는다
    assert any(r["entity"] == "Ganada Technology Holdings" and r["round"] == "Series A" for r in rounds)  # 투자대상 법인명 보존
    item = {"company": "가나다테크", "name_en": "Ganada Tech", "cards": cards, "rounds": fh.merge_rounds(rounds), "web_used": False}
    out = fh.to_contract(item, "2026-11-22T20:00:00+09:00")
    assert [r["round"] for r in out["rounds"]] == ["Corporate round", "Series A", "Seed"] and [r["id"] for r in out["rounds"]] == ["r1", "r2", "r3"]
    names = {i["name"] for i in out["investors"]}
    assert "가나다벤처스" in names and "사아자파트너스" not in names and "Test Ventures Z" not in names
    assert out["relatedEntities"] == [{"name": "Ganada Technology Holdings", "website": "holdings.example.com", "location": "San Jose",
                                       "totalRaised": "106987540.0", "fundingStage": "Series A", "roundCount": 2}]
    cum = out["summary"]["cumulative"]
    assert cum["basis"] == "pdl_total" and cum["label"] == "People Data Labs 누적액" and cum["byCurrency"] == {"USD": 932981469.0}
    assert out["summary"]["roundCount"] == 3 and out["summary"]["latest"]["round"] == "Corporate round"


def test_merge_only_obvious_duplicates_and_keep_amount_conflicts():
    prem = [{"raw": "a", "round": "Series A", "date": "2022-06-02", "amount": "$70M", "amount_value": 7e7, "currency": "USD",
             "investors": ["KT Investment"], "lead": [], "entity": "Ganada", "summary": "", "source_type": "premium_structured", "sources": [{"type": "Premium", "url": ""}]}]
    web = [{"raw": "b", "round": "시리즈 A", "date": "2022-06", "amount": "620억원", "amount_value": None, "currency": "KRW",
            "investors": ["KT", "KT Investment"], "lead": ["KT"], "entity": "가나다", "summary": "시리즈A 620억 유치", "source_type": "web_reported",
            "sources": [{"type": "Web", "url": "https://n.kr/1"}]},
           {"raw": "c", "round": "시리즈 B", "date": "2024-01", "amount": "", "amount_value": None, "currency": "",
            "investors": ["산업은행"], "lead": [], "entity": "가나다", "summary": "", "source_type": "web_reported", "sources": [{"type": "Web", "url": "https://n.kr/2"}]}]
    out = fh.merge_rounds(prem + web)
    assert len(out) == 2
    a = next(r for r in out if r["round"] == "Series A")
    assert a["amount"] == "$70M" and a["other_amounts"] == ["620억원"]  # 금액 차이는 지우지 않는다
    assert a["investors"] == ["KT Investment", "KT"] and a["source_type"] == "premium_structured+web_reported"
    inv = fh.investor_table(out)
    assert {i["투자기관"] for i in inv} == {"KT Investment", "KT", "산업은행"}
    assert next(i for i in inv if i["투자기관"] == "산업은행")["유형(이름 기반 추정)"].startswith("정책금융")  # 이름 기반 추정


def test_clean_web_keeps_only_quoted_facts():
    results = [{"title": "가나다테크, 시리즈B 1000억 유치", "description": "가나다테크가 산업은행 등에서 1000억원 규모 시리즈B 투자를 유치했다.",
                "url": "https://n.kr/1", "date": "2024-01-30"}]
    raw = {"rounds": [{"company": "가나다테크", "entity": "가나다테크", "date": "2024", "round": "시리즈B", "amount": "1000억원",
                       "investors": ["산업은행", "삼성전자"], "lead_investors": [], "summary": "s", "source": 0,
                       "quote": "산업은행 등에서 1000억원 규모 시리즈B 투자를 유치했다"},
                      {"company": "가나다테크", "entity": "", "date": "", "round": "", "amount": "", "investors": [], "lead_investors": [],
                       "summary": "", "source": 0, "quote": "자료에 없는 문장입니다"}]}
    out = fh.clean_web(raw, [fh.company_entry("가나다테크", "Ganada")], results)
    assert len(out) == 1 and out[0]["investors"] == ["산업은행"]  # 자료에 없는 투자사(삼성전자)는 뺀다
    assert out[0]["date"] == "" and out[0]["reported_date"] == "2024-01-30" and out[0]["currency"] == "KRW"


def test_collect_uses_premium_first_and_supplements_with_web():
    seen = []

    def handler(req):
        body = json.loads(req.content or b"{}")
        if "chat/completions" in req.url.path:
            seen.append(("model", ""))
            ans = {"rounds": [{"company": "다라마", "entity": "다라마", "date": "2024", "round": "시리즈 C", "amount": "1100억원",
                               "investors": ["카타파캐피탈"], "lead_investors": ["카타파캐피탈"], "summary": "시리즈C", "source": 0,
                               "quote": "다라마가 카타파캐피탈 주도로 1100억원 시리즈 C 투자를 유치"}]}
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(ans, ensure_ascii=False)}}], "usage": {}})
        seen.append(("premium" if body.get("include_knowledge") else "search", body["query"]))
        if body.get("include_knowledge"):
            if "Ganada Tech" in body["query"]:
                return httpx.Response(200, json={"results": [], "knowledge": [{"title": "Ganada", "columns": COLS, "rows": [REB], "sources": ["People Data Labs"]}]})
            return httpx.Response(200, json={"results": [], "knowledge": []})
        return httpx.Response(200, json={"results": [{"title": "다라마 시리즈C", "description": "다라마가 카타파캐피탈 주도로 1100억원 시리즈 C 투자를 유치했다",
                                                      "url": "https://n.kr/9", "date": "2024-03-01"}]})
    lw = Liner(_client(handler))
    cos = [fh.company_entry("가나다테크", "Ganada Tech", homepage="ganada.example.com"), fh.company_entry("다라마", "DARAMA")]
    news_by = {"가나다테크": {"articles": [{"date": "2026-01-01", "title": "가나다테크 투자 유치", "description": "", "url": "https://x",
                                         "매체": "x", "분류": ["투자유치"]}]}}
    out = fh.collect(lw, cos, news_by)
    gd, dx = out["by_company"]["가나다테크"], out["by_company"]["다라마"]
    assert gd["summary"]["rounds"] == 3 and gd["summary"]["total_raised"] == 932981469.0 and not gd["web_used"]
    assert gd["articles"] and gd["articles"][0]["제목"] == "가나다테크 투자 유치" and dx["articles"] == []
    assert dx["web_used"] and dx["rounds"][0]["amount"] == "1100억원" and dx["rounds"][0]["lead"] == ["카타파캐피탈"]
    assert any(c["api"] == "Liner Web Search" for c in dx["calls"])
    assert [k for k, _ in seen].count("premium") == 3 and [k for k, _ in seen].count("search") == 1 and [k for k, _ in seen].count("model") == 1
    fh.collect(lw, cos)  # 두 번째 실행은 캐시 재사용
    assert len(seen) == 5


def test_collect_never_raises_on_api_failure():
    lw = Liner(_client(lambda req: httpx.Response(503, json={"error": {"message": "down"}})))
    out = fh.collect(lw, [fh.company_entry("가나다테크", "Ganada Tech")])
    item = out["by_company"]["가나다테크"]
    assert item["rounds"] == [] and item["summary"]["rounds"] == 0 and lw.errors and lw.failures and not lw.succeeded
    out = fh.collect(Liner(None), [fh.company_entry("가나다테크")])
    assert out["by_company"]["가나다테크"]["errors"]


def test_cumulative_prefers_pdl_then_sums_rounds_by_currency():
    card = [{"name": "Upstage", "match": "exact", "total_raised": "704872215.0"}]
    r = lambda amt, cur, v=None: {"amount": amt, "currency": cur, "amount_value": v, "round": "", "raw": amt}  # noqa: E731
    assert fh.cumulative(card, [r("$1M", "USD", 1e6)])["by_currency"] == {"USD": 704872215.0}
    full = fh.cumulative([], [r("100억원", "KRW"), r("$5M", "USD", 5e6)])
    assert full["basis"] == "rounds_sum" and full["by_currency"] == {"KRW": 1e10, "USD": 5e6}  # 통화를 섞지 않는다
    part = fh.cumulative([], [r("100억원", "KRW"), r("", "")])
    assert fh.cumulative_contract(part)["label"] == "라운드 금액 합계 (금액이 있는 라운드 1건만 더함)"
    assert fh.cumulative([], [r("", "")])["label"] == "미확보" and fh.cumulative([], [r("수백억원", "KRW")])["by_currency"] == {}
    related_only = [{"name": "Upstage Labs", "match": "related", "total_raised": "1"}]
    assert fh.cumulative(related_only, [])["basis"] == "none"  # 유사 이름 카드의 누적액은 대상의 누적액으로 쓰지 않는다


# ---------------------------------------------------------------- 특허

PAGE_B = ("KR102867987B1 - 모델 세트 성능 평가 방법 및 시스템 Info Publication number KR102867987B1 Application number KR1020230179893A "
          "Other languages English ( en ) Inventor 홍길동 Original Assignee 주식회사 가나다테크 Priority date 2022-12-23 Filing date 2023-12-12 "
          "Publication date 2025-10-13 2023-12-12 Application filed by 주식회사 가나다테크 filed Critical 주식회사 가나다테크 "
          "2024-07-02 Publication of KR20240101389A publication Critical 2025-10-13 Application granted 2025-10-13 Publication of KR102867987B1 "
          "Status Active legal-status\n Classifications \n G — PHYSICS \n G06V — IMAGE OR VIDEO RECOGNITION OR UNDERSTANDING \n G06V30/00 — Character recognition \n"
          "Abstract 본 개시는 문자 인식과 연관된 모델 세트 성능을 평가하는 방법을 제공한다. Description\n"
          "Family Applications After (1) KR1020230179503A Active KR102775032B1 ( ko ) 라벨링 작업 관리 방법\n Country Status (1)\n"
          "Cited By (1) KR20990000001A ( ko ) 2020-01-01 주식회사 다른회사 무관한 특허\n")
PAGE_A = PAGE_B.replace("Publication number KR102867987B1", "Publication number KR20240101389A")
PAGE_OTHER = ("KR102000000B1 - 다른 발명 Application number KR1020200000001A Original Assignee 주식회사 남의회사 Filing date 2020-05-05 "
              "Application filed by 주식회사 남의회사 filed Critical 주식회사 남의회사 Status Active\n Cited By 가나다테크 언급\n")
PAGE_NODATE = "KR102775032B1 - 라벨링 작업 관리 방법 Application number KR1020230179503A Original Assignee 주식회사 가나다테크 Status Active\n"
PAGES = {"KR102867987B1": PAGE_B, "KR20240101389A": PAGE_A, "KR102000000B1": PAGE_OTHER, "KR102775032B1": PAGE_NODATE}


class FakeFetcher:
    def __init__(self):
        self.urls = []

    def fetch(self, url):
        self.urls.append(url)
        pub = url.split("/patent/")[1].split("/")[0]
        if pub not in PAGES:
            return {"ok": False}
        return {"ok": True, "text": PAGES[pub], "title": f"{pub} - 제목 - Google Patents"}


def test_parse_page_reads_bibliographic_fields():
    p = patents.parse_page(PAGE_B, "KR102867987B1 - 모델 세트 성능 평가 방법 및 시스템 - Google Patents", "KR102867987B1")
    assert p["assignee"] == "주식회사 가나다테크" and p["application_no"] == "10-2023-0179893" and p["filing_date"] == "2023-12-12"
    assert p["publication_no"] == "KR20240101389A" and p["publication_date"] == "2024-07-02"
    assert p["registration_no"] == "KR102867987B1" and p["title"] == "모델 세트 성능 평가 방법 및 시스템"
    assert p["cpc"][0] == "G06V30/00" and p["abstract"].startswith("본 개시는")
    assert patents.parse_page(PAGE_NODATE, "", "KR102775032B1")["filing_date"] == ""  # 없는 값은 만들지 않는다


def test_harvest_family_and_name_lines_only():
    got = patents.harvest(PAGE_B, ["가나다테크"])
    assert "KR102775032B1" in got and "KR20990000001A" not in got  # 무관한 피인용 특허는 후보로 넣지 않는다


def test_company_patents_dedups_by_application_and_counts_pages(monkeypatch):
    fx = FakeFetcher()
    monkeypatch.setattr(patents, "_fetcher", lambda: fx)
    n = {"search": 0}

    def handler(req):
        n["search"] += 1
        return httpx.Response(200, json={"results": [
            {"title": "KR102867987B1 - 모델 세트", "url": "https://patents.google.com/patent/KR102867987B1/ko", "description": "Application filed by 주식회사 가나다테크"},
            {"title": "KR20240101389A", "url": "https://patents.google.com/patent/KR20240101389A/ko", "description": ""},
            {"title": "다른 발명", "url": "https://patents.google.com/patent/KR102000000B1/ko", "description": "가나다테크 인용"}]})
    b = L.reserve_section("patents")
    lw = Liner(b.liner_client("k" * 20, "env", transport=httpx.MockTransport(handler), sleep=lambda s: None))
    c = patents.company_patents(lw, patents.entry("가나다테크", "Ganada", is_self=True), use=b.use)
    assert n["search"] == 2  # 기업당 Liner 검색 2회
    assert [p["application_no"] for p in c["patents"]] == ["10-2023-0179893", "10-2023-0179503"]
    assert c["patents"][0]["publication_no"] == "KR20240101389A" and c["patents"][0]["registration_no"] == "KR102867987B1"  # A·B 문서를 한 출원으로
    assert [m["pub_no"] for m in c["mentions"]] == ["KR102000000B1"]  # 출원인이 다르면 언급 문서로만
    s = patents.summary_contract(c["summary"])
    assert s["total"] == 2 and s["byYear"] == {"2023": 1} and s["noFilingDate"] == 1  # 출원일 없는 건은 연도 집계에서 뺀다
    pages = len(fx.urls)
    assert pages == c["pages_checked"] and b.liner_remaining(L.LINER_SEARCH) == 0
    for _ in range(L.PATENT_PAGES_PER_COMPANY - pages):  # 원문을 받은 쪽 수만큼 단락 상한(30)에서 빠졌다
        b.use(L.PATENTS_PAGE)
    with pytest.raises(L.LimitReached):
        b.use(L.PATENTS_PAGE)
    patents.company_patents(lw, patents.entry("가나다테크", "Ganada", is_self=True), use=b.use)  # 원문은 캐시: 세지 않는다
    b.settle(L.liner_used(lw.client.calls))


def test_entry_uses_korean_names_only():
    e = patents.entry("가나다테크", "Ganada", registered="주식회사 가나다테크", aliases=["Ganada AI", "가나"])
    assert e["names"] == ["가나다테크", "가나"] and e["registered"] == "가나다테크"


def test_mark_important_uses_only_openalex_metrics():
    ps = papers.mark_important([{"FWCI": 3.2, "상위 10%": False}, {"FWCI": 0.5, "상위 10%": True}, {"FWCI": None}, {}])
    assert ps[0]["주요 논문"] == "FWCI 3.2" and "상위 10%" in ps[1]["주요 논문"] and ps[2]["주요 논문"] == "" and ps[3]["주요 논문"] == ""
    rows = papers.dedup_ids([{"doi": "https://doi.org/1"}, {"doi": "https://doi.org/1"}, {"id": "W2"}, {"id": "W2"}, {}])
    assert len(rows) == 3


def test_topic_trend_keeps_failures_independent(monkeypatch):
    calls = []

    def fake(path, params, *, use=None):
        calls.append(params.get("group_by") or params.get("sort") or "recent")
        if params.get("group_by") == "publication_year":
            raise RuntimeError("OpenAlex HTTP 500")
        return {"group_by": [], "results": []}
    monkeypatch.setattr(papers, "_oa", fake)
    out = papers.topic_trend("x")
    assert len(calls) == 4 and out["errors"] == ["OpenAlex HTTP 500"]  # 첫 묶음이 실패해도 나머지는 부른다
