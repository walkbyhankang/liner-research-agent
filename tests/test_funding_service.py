"""자격 대조 서비스와 API 테스트. 실제 API 는 호출하지 않는다."""
import json
import sys
from datetime import date
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api.main as api_main  # noqa: E402
from funding import company, notice, service  # noqa: E402
from growth import limits as L  # noqa: E402
from liner_client import LinerClient  # noqa: E402
from tests.test_funding_notice import make_hwpx  # noqa: E402

PROGRAM = {"id": "PBLN_000000000000001", "title": "대전 지원자금 공고", "url": "https://www.bizinfo.go.kr/p",
           "docUrl": "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=F1&fileSn=0"}
EXTRACT_ANSWER = {"summary": "대전 기업 융자", "not_stated": ["업력", "없는항목"], "conditions": [
    {"field": "지원한도", "requirement": "업체당 5억원 이내", "quote": "지원규모 : 업체당 5억원 이내"},
    {"field": "제외대상", "requirement": "체납 기업 제외", "quote": "신청일 현재 지방세, 국세 체납 사실이 있는 기업은 제외한다."},
    {"field": "업력", "requirement": "7년 미만", "quote": "업력 7년 미만 기업만 신청할 수 있다"},
]}
MATCH_ANSWER = {"overall": "확인 후 판단", "overall_reason": "한도는 맞음", "checks": [{"index": 0, "verdict": "충족", "reason": "3억 필요"}],
                "questions": ["체납 확인 서류는?"], "documents": ["납세증명서"]}


def chat_client(answers: list[dict], seen: list[dict]) -> LinerClient:
    queue = list(answers)

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"model": "test-model", "choices": [{"message": {"content": json.dumps(queue.pop(0), ensure_ascii=False)}}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.001}})

    return LinerClient("k", transport=httpx.MockTransport(handler))


def test_business_age_and_describe():
    assert company.business_age("2023-09", date(2026, 11, 21)) == "업력 3년 2개월"
    assert company.business_age("2026-11", date(2026, 11, 21)) == "업력 0년 0개월"
    assert company.business_age("2027-01", date(2026, 11, 21)) is None
    assert company.business_age("없음") is None and company.business_age("") is None
    text = company.describe({"region": "대전", "biz": "venture", "founded": "2023-09", "industry": "SaaS"}, date(2026, 11, 21))
    assert "본사 소재지: 대전" in text and "창업·벤처기업" in text and "2023-09 (업력 3년 2개월)" in text
    assert "상시근로자 수: 정보 없음" in text and "회사명: 정보 없음" in text


def test_extract_keeps_only_quotes_found_in_document_and_caches(tmp_path):
    seen: list[dict] = []
    client = chat_client([EXTRACT_ANSWER], seen)
    fetched = []
    fetch = lambda url: fetched.append(url) or make_hwpx()  # noqa: E731
    out = service.extract_notice(PROGRAM, client, tmp_path, fetch=fetch)
    assert out["cached"] is False and out["dropped"] == 1
    assert [c["field"] for c in out["conditions"]] == ["지원한도", "제외대상"]
    assert out["notStated"] == ["업력"] and out["doc"]["kind"] == "hwpx"
    assert "<공고문>" in seen[0]["messages"][1]["content"] and seen[0]["model"] == service.EXTRACT_MODEL

    again = service.extract_notice(PROGRAM, client, tmp_path, fetch=fetch)
    assert again["cached"] is True and again["conditions"] == out["conditions"]
    assert len(seen) == 1 and len(fetched) == 1  # 저장본을 쓰면 내려받기도 모델 호출도 하지 않는다


def test_cache_is_ignored_when_document_changes_or_id_is_unsafe(tmp_path):
    client = chat_client([EXTRACT_ANSWER], [])
    service.extract_notice(PROGRAM, client, tmp_path, fetch=lambda url: make_hwpx())
    assert service.load_extraction(tmp_path, PROGRAM) is not None
    assert service.load_extraction(tmp_path, {**PROGRAM, "docUrl": PROGRAM["docUrl"] + "9"}) is None
    with pytest.raises(service.AnalysisError):
        service.load_extraction(tmp_path, {**PROGRAM, "id": "../../etc/passwd"})


def test_extract_reports_unreadable_document_without_calling_model(tmp_path):
    seen: list[dict] = []
    with pytest.raises(service.AnalysisError):
        service.extract_notice(PROGRAM, chat_client([], seen), tmp_path, fetch=lambda url: b"<html>")
    assert seen == [] and not list(tmp_path.iterdir())


def test_match_fills_unjudged_conditions_as_needs_check():
    extraction = {"conditions": [{"field": "지원한도", "requirement": "5억 이내", "quote": "q1"}, {"field": "제외대상", "requirement": "체납 제외", "quote": "q2"}]}
    seen: list[dict] = []
    out = service.match_company(extraction, "- 회사명: 가", chat_client([MATCH_ANSWER], seen))
    assert out["overall"] == "확인 후 판단"
    assert [(r["field"], r["verdict"]) for r in out["rows"]] == [("지원한도", "충족"), ("제외대상", "확인 필요")]
    assert "<회사>" in seen[0]["messages"][1]["content"] and "0. [지원한도]" in seen[0]["messages"][1]["content"]
    with pytest.raises(service.AnalysisError):
        service.match_company({"conditions": []}, "회사", chat_client([], []))


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.setattr(api_main, "_programs", {PROGRAM["id"]: PROGRAM})
    monkeypatch.setattr(api_main, "CACHE_DIR", tmp_path)  # 하루 사용량은 tests/conftest.py 가 테스트마다 새로 시작한다
    monkeypatch.setattr(api_main.config, "resolve_api_key", lambda: ("secret-key-xyz", "env"))
    seen: list[dict] = []
    monkeypatch.setattr(api_main, "LinerClient", lambda key, source, limits: _limited(chat_client([EXTRACT_ANSWER, MATCH_ANSWER], seen), limits))
    monkeypatch.setattr(service.docs, "fetch_document", lambda url: make_hwpx())
    return TestClient(api_main.app), seen


def _limited(client: LinerClient, limits: dict) -> LinerClient:
    client._limits.update(limits)
    return client


def liner_used() -> int:
    """오늘 하루 상한에 확정된 Liner 요청 수(4종 합)."""
    apis = L.usage_today()["apis"]
    return sum(apis[a]["used"] for a in L.LINER_APIS)


def remaining(api: str) -> int:
    """하루 상한 − 확정 − 예약 중."""
    return L.usage_today()["apis"][api]["remaining"]


def daily_limits(**caps: int) -> None:
    """하루 상한을 낮춰 새로 시작한다. 예: daily_limits(LINER_MODEL=3)"""
    L._reset_for_tests({L.ENV_PREFIX + k: str(v) for k, v in caps.items()})


BODY = {"programId": PROGRAM["id"], "company": {"region": "대전", "biz": "venture", "founded": "2023-09", "need": "운전자금 3억"}}


def test_api_analyze_returns_match_without_leaking_key(api):
    client, seen = api
    res = client.post("/api/notice/analyze", json=BODY)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["match"]["overall"] == "확인 후 판단" and body["extraction"]["cached"] is False
    assert [r["verdict"] for r in body["match"]["rows"]] == ["충족", "확인 필요"]
    assert "secret-key-xyz" not in res.text and len(seen) == 2
    assert "본사 소재지: 대전" in seen[1]["messages"][1]["content"]
    assert client.get("/api/health").json()["paidUsed"] == 2


def test_api_rejects_bad_input_and_unknown_program(api):
    client, seen = api
    assert client.post("/api/notice/analyze", json={**BODY, "programId": "../x"}).status_code == 422
    assert client.post("/api/notice/analyze", json={**BODY, "programId": "PBLN_999999"}).status_code == 404
    assert client.post("/api/notice/analyze", json={**BODY, "company": {"founded": "2023년"}}).status_code == 422
    assert client.post("/api/notice/analyze", json={**BODY, "company": {"notes": "가" * 401}}).status_code == 422
    assert seen == []


def test_api_stops_at_paid_call_cap_and_without_key(api, monkeypatch):
    client, seen = api
    daily_limits(LINER_MODEL=3)  # 추출·대조 2회가 재시도까지 가면 4회 → 3회만 남았으면 보내지 않는다
    res = client.post("/api/notice/analyze", json=BODY)
    assert res.status_code == 429 and res.json()["code"] == "daily_limit" and res.json()["retryAt"].endswith("T00:00:00+09:00")
    assert seen == [] and liner_used() == 0 and remaining(L.LINER_MODEL) == 3  # 거절하면 아무것도 잡지 않는다
    monkeypatch.setattr(api_main.config, "resolve_api_key", lambda: (None, None))
    res = client.post("/api/notice/analyze", json=BODY)
    assert res.status_code == 503 and res.json()["code"] == "missing_config" and "LINER_API_KEY" not in res.text
    assert client.get("/api/health").json()["hasKey"] is False


CONDS = {"conditions": [{"field": "업종", "requirement": "콘텐츠 업종", "quote": "q1"}, {"field": "지역", "requirement": "대전", "quote": "q2"},
                        {"field": "제출서류", "requirement": "신청서", "quote": "q3"}]}


def run_match(answer: dict) -> dict:
    return service.match_company(CONDS, "회사", chat_client([answer], []))


def test_overall_follows_condition_verdicts_not_the_model_claim():
    ok = {"index": 1, "verdict": "충족", "reason": "대전"}
    na = {"index": 2, "verdict": "판단 대상 아님", "reason": ""}
    # 판정이 하나도 없는데 신청 가능이라고 한 답: 전부 확인 필요가 되므로 확인 후 판단
    out = run_match({"overall": "신청 검토 가능", "overall_reason": "신청 가능합니다", "checks": [], "questions": [], "documents": []})
    assert out["overall"] == "확인 후 판단" and out["adjusted"] is True and "신청 가능" not in out["overallReason"]
    # 미충족이 있는데 신청 가능이라고 한 답: 대상 아님
    out = run_match({"overall": "신청 검토 가능", "overall_reason": "가능", "questions": [], "documents": [],
                     "checks": [{"index": 0, "verdict": "미충족", "reason": "SaaS"}, ok, na]})
    assert out["overall"] == "대상 아님" and out["adjusted"] is True and "미충족 1건" in out["overallReason"]
    # 자격 조건이 모두 충족이면 신청 검토 가능, 모델 설명을 그대로 쓴다
    out = run_match({"overall": "신청 검토 가능", "overall_reason": "모두 충족", "questions": [], "documents": [],
                     "checks": [{"index": 0, "verdict": "충족", "reason": ""}, ok, na]})
    assert out["overall"] == "신청 검토 가능" and out["adjusted"] is False and out["overallReason"] == "모두 충족"
    # 미충족이 없는데 대상 아님이라고 한 답: 조건별 판정을 따른다
    out = run_match({"overall": "대상 아님", "overall_reason": "안 됨", "questions": [], "documents": [],
                     "checks": [{"index": 0, "verdict": "확인 필요", "reason": ""}, ok, na]})
    assert out["overall"] == "확인 후 판단" and out["adjusted"] is True


def test_overall_is_not_positive_when_only_procedural_conditions_exist():
    rows = [{"verdict": "판단 대상 아님"}, {"verdict": "판단 대상 아님"}]
    assert service.overall_from_rows(rows) == "확인 후 판단"
    assert service.overall_from_rows([]) == "확인 후 판단"


def test_cors_allows_default_and_project_ports():
    for origin in ("http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3100"):
        res = TestClient(api_main.app).get("/api/health", headers={"origin": origin})
        assert res.headers.get("access-control-allow-origin") == origin
    res = TestClient(api_main.app).get("/api/health", headers={"origin": "https://evil.example"})
    assert "access-control-allow-origin" not in res.headers


from funding import profile  # noqa: E402


def fact(category, item, value, status="reported", **kw):
    return {"category": category, "item": item, "value": value, "status": status, "source_url": "https://example.kr/a", "evidence": "근거", **kw}


def test_parse_founded_never_invents_a_month():
    assert profile.parse_founded("2023년 9월 설립") == ("2023-09", "")
    assert profile.parse_founded("2012.09.") == ("2012-09", "")
    assert profile.parse_founded("2015년") == ("", "2015")
    assert profile.parse_founded("2015년 13월") == ("", "2015")
    assert profile.parse_founded("미상") == ("", "")


def test_parse_region_maps_address_to_province():
    assert profile.parse_region("대한민국 서울특별시 마포구") == "서울"
    assert profile.parse_region("충청북도 청주시") == "충북"
    assert profile.parse_region("대전광역시 유성구") == "대전"
    assert profile.parse_region("미국 캘리포니아") == ""


def test_to_draft_picks_best_status_and_keeps_sources():
    run = {"analysis": {"company_name": "주식회사 가나다", "facts": [
        fact("profile", "자회사 설립", "2021년"),
        fact("profile", "설립일", "2019년", status="inferred"),
        fact("profile", "설립일", "2019년 3월", status="confirmed"),
        fact("profile", "본사", "대전광역시 유성구", status="confirmed"),
        fact("profile", "서비스 이용 현황", "미국 대학가에서 이용"),
        fact("profile", "주요 제품·서비스", "기업용 SaaS"),
        fact("profile", "핵심 기술", "", status="unavailable"),
        fact("finance", "직원수", "12", unit="명", as_of="2026-06"),
    ], "financials": [{"metric": "revenue", "year": "2024", "value": "5", "unit": "억원", "status": "reported", "source_url": "u"},
                      {"metric": "revenue", "year": "2025", "value": "8", "unit": "억원", "basis": "별도", "status": "confirmed", "source_url": "u2"},
                      {"metric": "employees", "year": "2025", "value": "12"}],
        "existing_investors": [{"name": "KB인베스트먼트", "round": "시리즈 A", "status": "confirmed", "source_urls": ["https://n.kr/1"]},
                               {"name": "KB인베스트먼트", "round": "시리즈 B"}, {"name": ""}]}}
    out = profile.to_draft(run)
    assert out["draft"] == {"name": "주식회사 가나다", "founded": "2019-03", "foundedYear": "", "region": "대전",
                            "industry": "기업용 SaaS", "employees": "12명 (2026-06 기준)", "revenue": "8억원 (2025, 별도)"}
    founded = next(f for f in out["fields"] if f["key"] == "founded")
    assert founded["status"] == "confirmed" and founded["sourceUrl"] == "https://example.kr/a"
    assert out["investors"] == [{"name": "KB인베스트먼트", "round": "시리즈 A", "date": "", "status": "confirmed", "sourceUrl": "https://n.kr/1"}]
    assert out["competitors"] == [] and out["rivalFunding"] == []


def test_to_draft_leaves_unknown_fields_empty():
    out = profile.to_draft({"analysis": {"facts": [fact("profile", "설립연도", "2015년")]}})
    assert out["draft"]["founded"] == "" and out["draft"]["foundedYear"] == "2015" and out["draft"]["industry"] == ""
    assert out["fields"][0]["note"] and out["investors"] == []
    assert profile.to_draft({})["fields"] == []


def test_concurrent_extractions_of_one_notice_call_the_model_once(tmp_path):
    import threading
    import time

    seen: list[dict] = []
    client = chat_client([EXTRACT_ANSWER, EXTRACT_ANSWER, EXTRACT_ANSWER], seen)

    def slow_fetch(url):
        time.sleep(0.05)
        return make_hwpx()

    results: list[dict] = []
    threads = [threading.Thread(target=lambda: results.append(service.extract_notice(PROGRAM, client, tmp_path, fetch=slow_fetch))) for _ in range(3)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert len(seen) == 1 and sorted(r["cached"] for r in results) == [False, True, True]
    assert [p.name for p in tmp_path.iterdir()] == [f"{PROGRAM['id']}.json"]  # 임시 파일이 남지 않는다
    assert json.loads((tmp_path / f"{PROGRAM['id']}.json").read_text(encoding="utf-8"))["id"] == PROGRAM["id"]


def test_failed_write_leaves_no_partial_cache_file(tmp_path, monkeypatch):
    monkeypatch.setattr(service.os, "replace", lambda a, b: (_ for _ in ()).throw(OSError("disk")))
    with pytest.raises(OSError):
        service.extract_notice(PROGRAM, chat_client([EXTRACT_ANSWER], []), tmp_path, fetch=lambda url: make_hwpx())
    assert list(tmp_path.iterdir()) == []


def test_api_counts_automatic_retries_against_the_cap(api, monkeypatch):
    client, _ = api
    answers = [httpx.Response(500, json={"error": {"message": "upstream"}})] + [
        httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": json.dumps(a, ensure_ascii=False)}}], "usage": {"cost": 0.001}})
        for a in (EXTRACT_ANSWER, MATCH_ANSWER)]
    flaky = LinerClient("k", transport=httpx.MockTransport(lambda req: answers.pop(0)), sleep=lambda s: None)
    monkeypatch.setattr(api_main, "LinerClient", lambda key, source, limits: _limited(flaky, limits))
    assert client.post("/api/notice/analyze", json=BODY).status_code == 200
    assert liner_used() == 3 and remaining(L.LINER_MODEL) == 197  # 실패한 첫 요청, 재시도, 대조. 남은 예약은 돌려준다


def test_api_reserves_room_for_retries_before_sending(api, monkeypatch):
    client, seen = api
    # 재시도까지 가면 4회가 나갈 수 있으므로, 3회만 남았으면 보내지 않는다
    daily_limits(LINER_MODEL=3)
    assert client.post("/api/notice/analyze", json=BODY).status_code == 429 and seen == []
    daily_limits(LINER_MODEL=4)
    assert client.post("/api/notice/analyze", json=BODY).status_code == 200
    assert liner_used() == 2 and remaining(L.LINER_MODEL) == 2


def test_api_reports_document_outage_as_handled_error(api, monkeypatch):
    client, seen = api

    def down(url):
        raise service.docs.DocumentError("공고문 서버에 연결하지 못했습니다(ConnectError)")

    monkeypatch.setattr(service.docs, "fetch_document", down)
    res = client.post("/api/notice/analyze", json=BODY)
    assert res.status_code == 422 and "공고문" in res.json()["detail"] and res.json()["code"] == "analysis_failed"
    assert seen == [] and liner_used() == 0 and remaining(L.LINER_MODEL) == 200


ALL_MET = {"overall": "신청 검토 가능", "overall_reason": "모두 충족", "questions": [], "documents": [],
           "checks": [{"index": 0, "verdict": "충족", "reason": ""}, {"index": 1, "verdict": "충족", "reason": ""},
                      {"index": 2, "verdict": "판단 대상 아님", "reason": ""}]}


def test_incomplete_notice_analysis_never_yields_a_positive_verdict():
    complete = service.match_company({**CONDS, "dropped": 0, "doc": {"truncated": False}}, "회사", chat_client([ALL_MET], []))
    assert complete["overall"] == "신청 검토 가능"

    dropped = service.match_company({**CONDS, "dropped": 2, "doc": {"truncated": False}}, "회사", chat_client([ALL_MET], []))
    assert dropped["overall"] == "확인 후 판단" and "2건" in dropped["overallReason"]

    truncated = service.match_company({**CONDS, "dropped": 0, "doc": {"truncated": True}}, "회사", chat_client([ALL_MET], []))
    assert truncated["overall"] == "확인 후 판단" and "앞부분만" in truncated["overallReason"]


def test_incomplete_analysis_keeps_a_clear_failure():
    failing = {**ALL_MET, "overall": "대상 아님", "overall_reason": "업종 불일치",
               "checks": [{"index": 0, "verdict": "미충족", "reason": "SaaS"}, {"index": 1, "verdict": "충족", "reason": ""}]}
    out = service.match_company({**CONDS, "dropped": 3, "doc": {"truncated": True}}, "회사", chat_client([failing], []))
    assert out["overall"] == "대상 아님" and out["overallReason"] == "업종 불일치"


NO_QUOTES = {"summary": "요약", "not_stated": [], "conditions": [{"field": "업력", "requirement": "7년 미만", "quote": "공고문에 없는 문장입니다"}]}


def test_unusable_extraction_is_not_cached_so_a_retry_can_succeed(tmp_path):
    seen: list[dict] = []
    client = chat_client([NO_QUOTES, {"summary": "", "not_stated": [], "conditions": []}, EXTRACT_ANSWER], seen)
    fetch = lambda url: make_hwpx()  # noqa: E731
    for _ in range(2):  # 근거가 모두 틀린 답, 조건이 없는 답
        with pytest.raises(service.AnalysisError):
            service.extract_notice(PROGRAM, client, tmp_path, fetch=fetch)
        assert list(tmp_path.iterdir()) == []
    out = service.extract_notice(PROGRAM, client, tmp_path, fetch=fetch)
    assert out["cached"] is False and len(out["conditions"]) == 2 and len(seen) == 3


def test_cached_extraction_without_conditions_is_treated_as_missing(tmp_path):
    client = chat_client([EXTRACT_ANSWER, EXTRACT_ANSWER], [])
    service.extract_notice(PROGRAM, client, tmp_path, fetch=lambda url: make_hwpx())
    path = tmp_path / f"{PROGRAM['id']}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps({**data, "conditions": []}), encoding="utf-8")
    assert service.load_extraction(tmp_path, PROGRAM) is None
    again = service.extract_notice(PROGRAM, client, tmp_path, fetch=lambda url: make_hwpx())
    assert again["cached"] is False and len(again["conditions"]) == 2


def test_revenue_keeps_currency_year_and_basis():
    assert profile.format_revenue({"value": "8", "unit": "억원", "currency": "KRW", "year": "2025", "basis": "별도"}) == "8억원 (2025, 별도)"
    assert profile.format_revenue({"value": "12.5", "unit": "million", "currency": "USD", "year": "2025", "basis": "연결"}) == "12.5million USD (2025, 연결)"
    assert profile.format_revenue({"value": "300", "unit": "백만", "currency": "KRW", "year": "2024"}) == "300백만 KRW (2024)"
    assert profile.format_revenue({"value": "5", "unit": "USD million", "currency": "USD"}) == "5USD million"
    run = {"analysis": {"financials": [{"metric": "revenue", "year": "2025", "value": "12.5", "unit": "million", "currency": "USD",
                                        "basis": "연결", "status": "reported", "source_url": "https://x.kr"}]}}
    out = profile.to_draft(run)
    assert out["draft"]["revenue"] == "12.5million USD (2025, 연결)" and out["fields"][0]["note"] == ""


def test_revenue_too_long_for_the_field_is_shown_but_not_autofilled():
    long_value = "약 1,234억 5천만 원으로 추정되며 전년 대비 큰 폭으로 증가한 것으로 여러 매체에서 보도되었고 회사는 확인하지 않음"
    assert len(long_value) > profile.REVENUE_MAX
    run = {"analysis": {"financials": [{"metric": "revenue", "year": "2025", "value": long_value, "unit": "", "currency": "KRW", "basis": "연결"}]}}
    out = profile.to_draft(run)
    field = out["fields"][0]
    assert out["draft"]["revenue"] == "" and field["value"].startswith(long_value) and "(2025, 연결)" in field["value"] and field["note"]


def test_api_accepts_revenue_with_currency_and_basis(api):
    client, seen = api
    body = {**BODY, "company": {**BODY["company"], "revenue": "12.5million USD (2025, 연결)"}}
    assert client.post("/api/notice/analyze", json=body).status_code == 200
    assert "12.5million USD (2025, 연결)" in seen[1]["messages"][1]["content"]
    assert client.post("/api/notice/analyze", json={**BODY, "company": {"revenue": "가" * 61}}).status_code == 422


from funding import rivals  # noqa: E402

RESULTS = [
    {"title": "나다라, 시리즈 B 300억 유치", "description": "나다라는 케이비인베스트먼트와 SL인베스트먼트로부터 300억 원을 투자받았다.", "url": "https://news.kr/1"},
    {"title": "마바사 실적", "description": "마바사는 올해 매출이 늘었다.", "url": "javascript:alert(1)"},
]


def test_rival_rounds_keep_only_what_the_source_says():
    raw = {"rounds": [
        {"company": "나다라", "round": "시리즈 B", "amount": "300억 원", "date": "", "investors": ["케이비인베스트먼트", "SL인베스트먼트", "지어낸벤처스"],
         "source": 0, "quote": "케이비인베스트먼트와 SL인베스트먼트로부터 300억 원을 투자받았다"},
        {"company": "나다라", "round": "시리즈 C", "amount": "", "date": "", "investors": [], "source": 0, "quote": "자료에 없는 문장입니다"},
        {"company": "모르는회사", "round": "", "amount": "", "date": "", "investors": [], "source": 0, "quote": "나다라는 케이비인베스트먼트와"},
        {"company": "마바사", "round": "", "amount": "", "date": "", "investors": [], "source": 9, "quote": "마바사는 올해 매출이 늘었다"},
        {"company": "나다라", "round": "", "amount": "", "date": "", "investors": [], "source": 1, "quote": "마바사는 올해 매출이 늘었다"},
    ]}
    out = rivals.clean_rounds(raw, ["나다라", "마바사"], RESULTS)
    assert len(out) == 1
    assert out[0]["company"] == "나다라" and out[0]["investors"] == ["케이비인베스트먼트", "SL인베스트먼트"] and out[0]["sourceUrl"] == "https://news.kr/1"
    assert rivals.clean_rounds(None, ["나다라"], RESULTS) == []


def test_rival_source_url_must_be_web_address():
    raw = {"rounds": [{"company": "마바사", "round": "", "amount": "", "date": "", "investors": [], "source": 1, "quote": "마바사는 올해 매출이 늘었다"}]}
    assert rivals.clean_rounds(raw, ["마바사"], RESULTS)[0]["sourceUrl"] == ""


def test_find_funding_makes_no_call_without_competitors():
    seen: list[dict] = []
    assert rivals.find_funding([], chat_client([], seen)) == [] and seen == []


def test_lookup_fails_loudly_when_every_model_call_fails(monkeypatch):
    def fake_search(run, client, step, say):
        run["searches"][step["key"]] = {"results": []}
        return True

    def fake_models(run, client, say):  # 엔진이 실패를 삼키고 기록만 남기는 상황
        run["category_runs"] = {"profile": {"status": "failed", "error": "HTTP 401: invalid key"}, "news": {"status": "skipped"}}
        run["analysis"] = {"facts": []}

    monkeypatch.setattr(profile.pl, "_do_search", fake_search)
    monkeypatch.setattr(profile.pl, "rebuild_sources", lambda run: run.update(sources=[]))
    monkeypatch.setattr(profile.pl, "run_models", fake_models)

    class NoFetch:
        fetched, max_pages = 0, 0

    with pytest.raises(profile.ProfileError) as e:
        profile.lookup("가나다", chat_client([], []), fetcher=NoFetch())
    assert "모델 호출 실패" in str(e.value) and "401" in str(e.value)


def test_lookup_returns_empty_draft_when_nothing_was_found(monkeypatch):
    def fake_search(run, client, step, say):
        run["searches"][step["key"]] = {"results": []}
        return True

    def fake_models(run, client, say):  # 출처가 없어 모델을 부르지 않은 경우는 실패가 아니다
        run["category_runs"] = {"profile": {"status": "skipped"}}
        run["analysis"] = {"facts": []}

    monkeypatch.setattr(profile.pl, "_do_search", fake_search)
    monkeypatch.setattr(profile.pl, "rebuild_sources", lambda run: run.update(sources=[]))
    monkeypatch.setattr(profile.pl, "run_models", fake_models)

    class NoFetch:
        fetched, max_pages = 0, 0

    out = profile.lookup("가나다", chat_client([], []), fetcher=NoFetch())
    assert out["fields"] == [] and out["competitors"] == [] and out["rivalFunding"] == []


from funding import gp as gp_mod  # noqa: E402

GP_RESULTS = [
    {"title": "가나벤처스, AI 스타트업 다라에 30억 투자", "description": "가나벤처스는 초기 단계 AI 소프트웨어 기업에 주로 투자한다고 밝혔다.", "url": "https://news.kr/a", "hostname": "news.kr"},
    {"title": "가나전자 실적 발표", "description": "가나전자는 반도체 매출이 늘었다.", "url": "javascript:alert(1)", "hostname": "x"},
]
GP_ANSWER = {"facts": [
    {"kind": "투자 분야", "text": "초기 단계 AI 소프트웨어 기업에 주로 투자", "source": 0, "quote": "초기 단계 AI 소프트웨어 기업에 주로 투자한다"},
    {"kind": "투자 사례", "text": "지어낸 사례", "source": 0, "quote": "자료에 없는 문장입니다"},
    {"kind": "없는종류", "text": "다라에 30억 투자", "source": 0, "quote": "AI 스타트업 다라에 30억 투자"},
    {"kind": "기타", "text": "범위 밖", "source": 7, "quote": "가나전자는 반도체 매출이 늘었다"},
], "fit": [{"text": "AI 소프트웨어 분야가 겹친다", "fact": 0}, {"text": "지어낸 사례와 비슷하다", "fact": 1}, {"text": "투자 규모가 맞는다", "fact": 2}],
    "questions": ["지금 신규 투자를 집행하나요?", "", "기업당 투자금은?", "셋째 질문"]}


def test_gp_brief_keeps_only_facts_found_in_search_results():
    out = gp_mod.clean_brief(GP_ANSWER, GP_RESULTS)
    assert [f["text"] for f in out["facts"]] == ["초기 단계 AI 소프트웨어 기업에 주로 투자", "다라에 30억 투자"]
    assert out["facts"][1]["kind"] == "기타" and out["facts"][0]["sourceUrl"] == "https://news.kr/a"
    # 버려진 사실에 기댄 '맞는 점'은 함께 버리고, 남은 사실의 순번은 다시 매긴다
    assert out["fit"] == [{"text": "AI 소프트웨어 분야가 겹친다", "fact": 0}, {"text": "투자 규모가 맞는다", "fact": 1}]
    assert out["questions"] == ["지금 신규 투자를 집행하나요?", "기업당 투자금은?"]
    assert gp_mod.clean_brief(None, GP_RESULTS) == {"facts": [], "fit": [], "questions": []}


def test_gp_brief_skips_model_when_search_finds_nothing():
    calls = []

    def handler(req):
        calls.append(req.url.path)
        return httpx.Response(200, json={"results": []})

    client = LinerClient("k", transport=httpx.MockTransport(handler))
    out = gp_mod.brief("가나벤처스", [], "회사", client)
    assert out["facts"] == [] and out["searched"] == 0 and len(calls) == 1


def test_gp_brief_passes_funds_and_company_as_data():
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        if req.url.path.endswith("/search/web"):
            return httpx.Response(200, json={"results": GP_RESULTS})
        return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": json.dumps(GP_ANSWER, ensure_ascii=False)}}], "usage": {}})

    client = LinerClient("k", transport=httpx.MockTransport(handler))
    out = gp_mod.brief("가나벤처스", [{"name": "가나 1호 펀드", "field": "창업초기", "year": 2024}], "- 업종: SaaS", client)
    assert seen[0]["include_knowledge"] is False and "가나벤처스" in seen[0]["query"]
    user = seen[1]["messages"][1]["content"]
    assert "가나 1호 펀드" in user and "<회사>" in user and "[0] 가나벤처스, AI 스타트업" in user
    assert len(out["facts"]) == 2 and out["sources"] == [{"title": GP_RESULTS[0]["title"], "url": "https://news.kr/a", "host": "news.kr"}]


def test_api_gp_brief_only_accepts_listed_managers(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(api_main, "_funds_by_gp", {"가나벤처스": [{"name": "가나 1호", "field": "AI", "year": 2024}]})
    calls = []
    monkeypatch.setattr(api_main.gp_mod, "brief", lambda gp, funds, text, c: calls.append((gp, len(funds))) or {"gp": gp, "facts": []})
    body = {"gp": "가나벤처스", "company": {"region": "대전"}}
    assert client.post("/api/gp/brief", json=body).json() == {"gp": "가나벤처스", "facts": []}
    assert calls == [("가나벤처스", 1)] and liner_used() == 0 and remaining(L.LINER_SEARCH) == 500
    res = client.post("/api/gp/brief", json={**body, "gp": "아무 검색어나 넣기"})
    assert res.status_code == 404 and res.json()["code"] == "not_found"
    assert client.post("/api/gp/brief", json={**body, "gp": "가"}).status_code == 422
    daily_limits(LINER_SEARCH=1)  # 검색 1회가 재시도까지 가면 2회
    res = client.post("/api/gp/brief", json=body)
    assert res.status_code == 429 and res.json()["code"] == "daily_limit" and len(calls) == 1


def test_revenue_omits_basis_when_the_engine_does_not_know_it():
    assert profile.format_revenue({"value": "248.01", "unit": "억 원", "currency": "KRW", "year": "2025", "basis": "unknown"}) == "248.01억 원 (2025)"
    assert profile.format_revenue({"value": "5", "unit": "억원", "year": "2024", "basis": "미확인"}) == "5억원 (2024)"
    assert profile.format_revenue({"value": "5", "unit": "억원", "year": "2024", "basis": "연결"}) == "5억원 (2024, 연결)"


def test_conflicting_or_inferred_values_are_shown_but_never_autofilled():
    run = {"analysis": {"facts": [
        fact("profile", "설립일", "2012년 9월", status="conflicting"),
        fact("profile", "본사", "서울특별시 마포구", status="inferred"),
        fact("profile", "주요 제품", "AI 검색", status="confirmed"),
        fact("finance", "직원수", "77", unit="명", status="inferred"),
    ], "financials": [{"metric": "revenue", "year": "2025", "value": "8", "unit": "억원", "status": "conflicting", "source_url": "u"}]}}
    out = profile.to_draft(run)
    # 자격 대조에 들어가는 초안에는 확인되거나 보도된 값만 남는다
    assert out["draft"] == {"name": "", "founded": "", "foundedYear": "", "region": "", "industry": "AI 검색", "employees": "", "revenue": ""}
    # 조회 결과에는 값과 상태, 채우지 않은 이유가 그대로 보인다
    shown = {f["key"]: f for f in out["fields"]}
    assert shown["founded"]["value"] == "2012-09" and shown["founded"]["status"] == "conflicting" and "출처마다" in shown["founded"]["note"]
    assert shown["employees"]["value"] == "77명" and "추정" in shown["employees"]["note"]
    assert "출처마다" in shown["revenue"]["note"] and shown["industry"]["note"] == ""


def test_conflicting_founding_year_is_not_written_into_notes():
    out = profile.to_draft({"analysis": {"facts": [fact("profile", "설립연도", "2015년", status="conflicting")]}})
    assert out["draft"]["foundedYear"] == "" and out["fields"][0]["value"] == "2015년"
    assert "연도만" in out["fields"][0]["note"]  # 월을 찾지 못했다는 기존 안내는 유지한다


def test_own_incorporation_date_is_used_but_other_entities_are_not():
    own = profile.to_draft({"analysis": {"facts": [fact("profile", "법인 설립일", "2019년 3월", status="confirmed")]}})
    assert own["draft"]["founded"] == "2019-03"
    for label in ("자회사 설립", "미국 현지법인 설립", "해외법인 설립일", "일본 지사 설립", "합작법인 설립"):
        other = profile.to_draft({"analysis": {"facts": [fact("profile", label, "2021년 5월", status="confirmed")]}})
        assert other["draft"]["founded"] == "" and other["fields"] == [], label
    both = profile.to_draft({"analysis": {"facts": [fact("profile", "자회사 설립", "2021년 5월", status="confirmed"),
                                                   fact("profile", "법인 설립일", "2019년 3월", status="confirmed")]}})
    assert both["draft"]["founded"] == "2019-03"


def res(title, description=""):
    return {"title": title, "description": description}


def test_find_aliases_uses_only_names_paired_in_search_results():
    results = [
        res("업스테이지(Upstage), 시리즈 B 투자 유치", "AI 스타트업 업스테이지(Upstage)는..."),
        res("Upstage(업스테이지) 솔라 출시"),
        res("업스테이지(AI) 스타트업 소식", "업스테이지(AI) 기업"),
        res("업스테이지(AI) 관련 기사"),
        res("업스테이지(Solar LLM) 공개"),
    ]
    assert profile.find_aliases("업스테이지", results) == ["Upstage"]  # 'AI'는 설명이라 제외, 한 번만 나온 표기도 제외


def test_find_aliases_adds_short_form_when_suffix_is_generic():
    results = [res("뤼튼테크놀로지스(Wrtn Technologies) 투자 유치"), res("뤼튼(Wrtn Technologies), 일본 진출"), res("뤼튼 (Liner Search) 비교")]
    assert profile.find_aliases("뤼튼", results) == ["Wrtn Technologies", "Wrtn"]


def test_find_aliases_returns_nothing_without_evidence():
    assert profile.find_aliases("가나다", [res("가나다 소식"), res("ABC Corp 실적")]) == []
    assert profile.find_aliases("", [res("(Upstage)")]) == []
    assert profile.find_aliases("가나다", []) == []


def test_lookup_passes_detected_alias_to_the_engine(monkeypatch):
    seen = {}

    def fake_search(run, client, step, say):
        run["searches"][step["key"]] = {"results": [res("가나다(Ganada Labs) 투자 유치"), res("Ganada Labs(가나다) 소개")]}
        return True

    def fake_rebuild(run):
        seen["aliases"] = run["options"]["hints"]["aliases"]
        run["sources"] = []

    def fake_models(run, client, say):
        run["category_runs"] = {"profile": {"status": "skipped"}}
        run["analysis"] = {"facts": []}

    monkeypatch.setattr(profile.pl, "_do_search", fake_search)
    monkeypatch.setattr(profile.pl, "rebuild_sources", fake_rebuild)
    monkeypatch.setattr(profile.pl, "run_models", fake_models)

    class NoFetch:
        fetched, max_pages = 0, 0

    out = profile.lookup("가나다", chat_client([], []), fetcher=NoFetch())
    assert seen["aliases"] == "Ganada Labs,Ganada" and out["meta"]["aliases"] == ["Ganada Labs", "Ganada"]


def test_search_plan_relaxes_name_requirement_only_for_competitors():
    plan = {s["key"]: s for s in profile.search_plan("가나다")}
    assert set(plan) == set(profile.TOPICS)
    assert plan["competitors"]["market"] is True
    assert all(not plan[k]["market"] for k in ("identity", "headcount_funding", "vc_existing"))


def test_competitor_sources_without_company_name_are_usable_but_investor_sources_are_not():
    import sources as src

    identity = src.build_identity("가나다", {"aliases": "", "exclude": "", "homepage": ""}, [])
    runs = [
        {"key": "competitors", "category": "competitors", "query": "q", "market": True,
         "results": [{"title": "Ganada beats rivals in benchmark", "description": "English article", "url": "https://a.kr/1"}]},
        {"key": "vc_existing", "category": "vc", "query": "q", "market": False,
         "results": [{"title": "스타트업 투자 라운드 총정리", "description": "시리즈 A 설명", "url": "https://a.kr/2"}]},
    ]
    by_cat = {s["categories"][0]: s for s in src.build_sources(runs, [], identity)}
    assert by_cat["competitors"]["use"] is True and by_cat["competitors"]["relevance"] == 0.5
    assert by_cat["vc"]["use"] is False and by_cat["vc"]["excluded_reason"] == "분석대상 기업명 미언급"


def test_rival_funding_searches_each_competitor_and_merges_results():
    queries, prompts = [], []

    def handler(req):
        body = json.loads(req.content)
        if req.url.path.endswith("/search/web"):
            queries.append(body["query"])
            who = body["query"].split()[0]
            shared = {"title": "AI 검색 시장 정리", "description": "여러 회사 소개", "url": "https://news.kr/shared"}
            return httpx.Response(200, json={"results": [
                {"title": f"{who}, 시리즈 B 투자 유치", "description": f"{who}는 케이비인베스트먼트로부터 100억 원을 투자받았다.", "url": f"https://news.kr/{len(queries)}"}, shared]})
        prompts.append(body["messages"][1]["content"])
        answer = {"rounds": [{"company": "라마바", "round": "시리즈 B", "amount": "100억 원", "date": "", "investors": ["케이비인베스트먼트"], "source": 2,
                              "quote": "라마바는 케이비인베스트먼트로부터 100억 원을 투자받았다"}]}
        return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}], "usage": {}})

    client = LinerClient("k", transport=httpx.MockTransport(handler))
    out = rivals.find_funding(["나다라", "라마바", "나다라", "사아자", "넷째는제외"], client)
    assert queries == ["나다라 투자 유치 투자사 시리즈", "라마바 투자 유치 투자사 시리즈", "사아자 투자 유치 투자사 시리즈"]
    # 세 검색의 결과를 주소 기준으로 합쳐 한 번만 모델에 보낸다(겹치는 자료는 한 번만)
    assert len(prompts) == 1 and prompts[0].count("AI 검색 시장 정리") == 1 and "[3] 사아자, 시리즈 B" in prompts[0]
    assert out == [{"company": "라마바", "round": "시리즈 B", "amount": "100억 원", "date": "", "investors": ["케이비인베스트먼트"],
                    "quote": "라마바는 케이비인베스트먼트로부터 100억 원을 투자받았다", "sourceUrl": "https://news.kr/2"}]


METRIC_RESULTS = [
    {"title": "나다라, 직원 188명으로 늘어", "description": "나다라는 2025년 매출 248억 원을 기록했고 직원은 188명이다.", "url": "https://news.kr/m1"},
    {"title": "마바사 기업가치 1조", "description": "마바사는 기업가치 1조 원을 인정받았다.", "url": "https://news.kr/m2"},
]


def test_rival_metrics_require_the_number_in_the_quoted_sentence():
    raw = {"metrics": [
        {"company": "나다라", "kind": "직원 수", "value": "188명", "as_of": "", "source": 0, "quote": "직원은 188명이다"},
        {"company": "나다라", "kind": "매출", "value": "248억 원", "as_of": "2025년", "source": 0, "quote": "2025년 매출 248억 원을 기록했고"},
        {"company": "나다라", "kind": "매출", "value": "300억 원", "as_of": "", "source": 0, "quote": "2025년 매출 248억 원을 기록했고"},   # 같은 종류는 하나만
        {"company": "나다라", "kind": "누적 투자", "value": "500억 원", "as_of": "", "source": 0, "quote": "나다라는 2025년 매출 248억 원을 기록했고"},  # 숫자가 문장에 없음
        {"company": "마바사", "kind": "매출", "value": "1조 원", "as_of": "", "source": 0, "quote": "직원은 188명이다"},        # 그 자료가 마바사를 다루지 않음
        {"company": "마바사", "kind": "기업가치", "value": "1조 원", "as_of": "", "source": 1, "quote": "기업가치 1조 원을 인정받았다"},  # 허용하지 않는 종류
        {"company": "마바사", "kind": "직원 수", "value": "많음", "as_of": "", "source": 1, "quote": "마바사는 기업가치 1조 원을 인정받았다"},  # 숫자 없음
    ]}
    out = rivals.clean_metrics(raw, ["나다라", "마바사"], METRIC_RESULTS)
    assert [(m["company"], m["kind"], m["value"], m["asOf"]) for m in out] == [("나다라", "직원 수", "188명", ""), ("나다라", "매출", "248억 원", "2025년")]
    assert out[0]["sourceUrl"] == "https://news.kr/m1"
    assert rivals.clean_metrics(None, ["나다라"], METRIC_RESULTS) == []


def test_apply_figures_replaces_unverified_numbers_and_marks_provenance():
    competitors = [
        {"name": "나다라", "status": "inferred", "employees": "약 50명(추정)", "revenue": "", "funding": "추정 100억"},
        {"name": "마바사", "status": "reported", "employees": "30명", "revenue": "", "funding": ""},
        {"name": "사아자", "status": "inferred", "employees": "", "revenue": "", "funding": ""},
    ]
    found = {"metrics": [{"company": "나다라", "kind": "직원 수", "value": "188명", "asOf": "2025", "quote": "q", "sourceUrl": "https://news.kr/m1"}],
             "rounds": [{"company": "마바사", "round": "시리즈 B", "amount": "300억 원", "date": "2025년", "investors": [], "quote": "q", "sourceUrl": "https://news.kr/r"}]}
    rivals.apply_figures(competitors, found)
    # 추정 기록이던 경쟁사: 엔진의 추정 수치는 지우고 확인된 것만 남긴다
    assert competitors[0] == {"name": "나다라", "status": "inferred", "employees": "188명 (2025)", "revenue": "", "funding": "",
                              "figuresStatus": "reported", "figuresUrl": "https://news.kr/m1"}
    # 보도 기록이던 경쟁사: 기존 값은 두고, 누적 투자액이 없으면 확인된 라운드로 적는다
    assert competitors[1]["employees"] == "30명" and competitors[1]["funding"] == "시리즈 B 300억 원 (2025년)" and competitors[1]["figuresStatus"] == "reported"
    # 찾지 못한 경쟁사는 그대로
    assert "figuresStatus" not in competitors[2]


def test_rival_research_runs_two_searches_per_competitor_and_one_model_call():
    queries, schemas = [], []

    def handler(req):
        body = json.loads(req.content)
        if req.url.path.endswith("/search/web"):
            queries.append(body["query"])
            return httpx.Response(200, json={"results": [{"title": f"자료 {len(queries)}", "description": "나다라는 직원이 188명이다.", "url": f"https://news.kr/{len(queries)}"}]})
        schemas.append(body["response_format"]["json_schema"]["name"])
        answer = {"rounds": [], "metrics": [{"company": "나다라", "kind": "직원 수", "value": "188명", "as_of": "", "source": 0, "quote": "나다라는 직원이 188명이다"}]}
        return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}], "usage": {}})

    client = LinerClient("k", transport=httpx.MockTransport(handler))
    out = rivals.research(["나다라", "라마바"], client)
    assert queries == ["나다라 투자 유치 투자사 시리즈", "나다라 설립 매출 직원수 현황", "라마바 투자 유치 투자사 시리즈", "라마바 설립 매출 직원수 현황"]
    assert schemas == ["rival_research"] and out["rounds"] == [] and out["metrics"][0]["value"] == "188명"
    assert rivals.research([], client) == {"rounds": [], "metrics": []} and len(queries) == 4


def test_rival_metrics_keep_as_of_only_with_a_year_and_founding_needs_a_year():
    results = [{"title": "나다라 소개", "description": "나다라는 2015년 설립됐다. 누적 투자금은 440억원이다. 설립 10주년을 맞았다.", "url": "https://news.kr/f"}]
    raw = {"metrics": [
        {"company": "나다라", "kind": "누적 투자", "value": "440억원", "as_of": "시리즈 B2", "source": 0, "quote": "누적 투자금은 440억원이다"},
        {"company": "나다라", "kind": "설립 시기", "value": "2015년", "as_of": "2015년", "source": 0, "quote": "나다라는 2015년 설립됐다"},
    ]}
    out = rivals.clean_metrics(raw, ["나다라"], results)
    assert [(m["kind"], m["value"], m["asOf"]) for m in out] == [("누적 투자", "440억원", ""), ("설립 시기", "2015년", "")]
    no_year = {"metrics": [{"company": "나다라", "kind": "설립 시기", "value": "10주년", "as_of": "", "source": 0, "quote": "설립 10주년을 맞았다"}]}
    assert rivals.clean_metrics(no_year, ["나다라"], results) == []
    competitors = [{"name": "나다라", "status": "reported", "employees": "", "revenue": "", "funding": ""}]
    rivals.apply_figures(competitors, {"metrics": out, "rounds": []})
    assert competitors[0]["founded"] == "2015년" and competitors[0]["funding"] == "누적 440억원"


def test_competitor_relation_codes_are_shown_in_korean():
    assert profile.RELATION_LABEL == {"direct": "직접 경쟁", "similar_tech": "유사 기술", "same_market": "같은 시장", "global": "해외 경쟁사"}


def test_rival_metric_value_must_appear_whole_in_the_quote():
    ok = rivals.quantity_in_quote
    q = ("나다라는 2025년 매출 248억 원을 기록했다")
    assert ok("248억 원", q) and ok("248억원", q) and ok("2025년", q)
    # 숫자 조각만 맞는 값, 단위나 통화가 바뀐 값은 통과하지 못한다
    for bad in ("24억 원", "48억 원", "248조 원", "248억 달러", "248만 원", "248억", "248", "약 248억 원", ""):
        assert not ok(bad, q), bad
    # 쉼표와 공백만 무시한다
    assert ok("32억 6,456만원", ("매출액. 32억 6,456만 원")) and ok("1300억 원", ("누적 1,300억 원 유치"))
    # 수량의 앞부분만 옮기거나 통화를 뺀 값도 받지 않는다
    assert not ok("32억", ("매출 32억 6천만 원")) and not ok("15억", ("총 15억 달러를 조달")) and not ok("5억 달러", ("총 15억 달러를 조달"))
    assert ok("15억 달러", ("총 15억 달러를 조달")) and ok("77명", ("임직원 수는 77명입니다")) and ok("2012-09-27", ("설립일자2012-09-27"))
    # 같은 숫자가 앞에서 잘린 꼴로 먼저 나와도, 뒤에 온전한 표기가 있으면 인정한다
    assert ok("48억 원", ("248억 원에서 48억 원으로 줄었다"))


def test_rival_metrics_reject_changed_units_and_unsupported_as_of():
    results = [{"title": "나다라 실적", "description": "나다라는 2025년 매출 248억 원을 기록했고 직원은 188명이다.", "url": "https://news.kr/q"}]
    row = lambda kind, value, as_of, quote: {"company": "나다라", "kind": kind, "value": value, "as_of": as_of, "source": 0, "quote": quote}  # noqa: E731
    quote = "2025년 매출 248억 원을 기록했고"
    for bad in ("24억 원", "248조 원", "248억 달러"):
        assert rivals.clean_metrics({"metrics": [row("매출", bad, "", quote)]}, ["나다라"], results) == [], bad
    out = rivals.clean_metrics({"metrics": [row("매출", "248억 원", "2025년", quote), row("직원 수", "188명", "2024년 말", "직원은 188명이다")]}, ["나다라"], results)
    # 자료에 적힌 기준 시점은 남기고, 자료에 없는 기준 시점은 비운다
    assert [(m["value"], m["asOf"]) for m in out] == [("248억 원", "2025년"), ("188명", "")]


def test_rival_round_amount_name_and_date_must_be_written_in_the_source():
    results = [{"title": "나다라, 시리즈 B 투자 유치", "description": "나다라는 2025년 3월 케이비인베스트먼트로부터 300억 원을 투자받았다.", "url": "https://news.kr/r"}]
    row = lambda rnd, amount, when: {"company": "나다라", "round": rnd, "amount": amount, "date": when, "investors": ["케이비인베스트먼트"], "source": 0,  # noqa: E731
                                     "quote": "케이비인베스트먼트로부터 300억 원을 투자받았다"}
    good = rivals.clean_rounds({"rounds": [row("시리즈 B", "300억 원", "2025년 3월")]}, ["나다라"], results)[0]
    assert (good["round"], good["amount"], good["date"]) == ("시리즈 B", "300억 원", "2025년 3월")
    # 자료와 다른 금액·단위·라운드·시기는 비운다. 근거가 확인된 투자 사실과 투자사는 남는다
    for amount in ("30억 원", "300조 원", "300억 달러", "300억"):
        bad = rivals.clean_rounds({"rounds": [row("시리즈 C", amount, "2024년")]}, ["나다라"], results)[0]
        assert (bad["round"], bad["amount"], bad["date"], bad["investors"]) == ("", "", "", ["케이비인베스트먼트"]), amount


def test_rival_metric_boundaries_are_checked_in_the_source_not_only_the_quote():
    ok = rivals.quantity_in_quote
    # 인용문이 통화 앞에서 끊겨도, 자료에서 뒤에 통화가 이어지면 받지 않는다
    src = ("나다라는 매출 248억 달러를 기록했다")
    assert ok("248억", ("나다라는 매출 248억")) and not ok("248억", ("나다라는 매출 248억"), src)
    assert ok("248억 달러", ("나다라는 매출 248억 달러"), src)
    # 인용문이 복합 금액의 앞부분에서 끊긴 경우
    src = ("나다라의 매출은 32억 6,456만 원이다")
    assert not ok("32억", ("나다라의 매출은 32억"), src) and ok("32억 6,456만 원", ("매출은 32억 6,456만 원"), src)
    # 인용문이 숫자 중간에서 시작한 경우
    src = ("나다라의 직원은 1,188명이다")
    assert not ok("188명", ("188명이다"), src) and ok("1,188명", ("직원은 1,188명"), src)
    # 인용문이 자료에 두 번 나오면 온전한 쪽이 하나라도 있을 때 인정한다. 자료에 없는 인용문은 인정하지 않는다
    assert ok("48억 원", ("48억 원"), ("매출 248억 원, 영업이익 48억 원")) and not ok("48억 원", ("48억 원"), ("매출 248억 원"))
    assert not ok("248억 원", ("매출 248억 원"), ("다른 글"))


def test_rival_metrics_reject_a_quote_cut_before_the_currency():
    results = [{"title": "나다라 실적", "description": "나다라는 매출 248억 달러를 기록했다. 누적 투자는 32억 6,456만 원이다.", "url": "https://news.kr/c"}]
    row = lambda kind, value, quote: {"company": "나다라", "kind": kind, "value": value, "as_of": "", "source": 0, "quote": quote}  # noqa: E731
    assert rivals.clean_metrics({"metrics": [row("매출", "248억", "나다라는 매출 248억"), row("누적 투자", "32억", "누적 투자는 32억")]}, ["나다라"], results) == []
    out = rivals.clean_metrics({"metrics": [row("매출", "248억 달러", "나다라는 매출 248억 달러를 기록했다")]}, ["나다라"], results)
    assert [m["value"] for m in out] == ["248억 달러"]


def test_rival_round_name_must_not_be_part_of_another_round_name():
    def name_of(title, rnd):
        results = [{"title": title, "description": "나다라는 케이비인베스트먼트로부터 300억 원을 투자받았다.", "url": "https://news.kr/n"}]
        raw = {"rounds": [{"company": "나다라", "round": rnd, "amount": "300억 원", "date": "", "investors": [], "source": 0, "quote": "케이비인베스트먼트로부터 300억 원을 투자받았다"}]}
        return rivals.clean_rounds(raw, ["나다라"], results)[0]["round"]

    assert name_of("나다라, 시리즈 B2 투자 유치", "시리즈 B") == "" and name_of("나다라, 시리즈 B2 투자 유치", "시리즈 B2") == "시리즈 B2"
    assert name_of("나다라, 프리 시리즈 A 투자 유치", "시리즈 A") == "" and name_of("나다라, 프리 시리즈 A 투자 유치", "프리 시리즈 A") == "프리 시리즈 A"
    assert name_of("나다라, Pre-Series A 유치", "Series A") == "" and name_of("나다라, 시리즈 B 투자 유치", "시리즈 B") == "시리즈 B"


def test_apply_figures_keeps_trusted_funding_and_ignores_rounds_with_nothing_to_show():
    rnd = lambda company, name, amount: {"company": company, "round": name, "amount": amount, "date": "", "investors": [], "quote": "q", "sourceUrl": "https://news.kr/r"}  # noqa: E731
    competitors = [
        {"name": "나다라", "status": "reported", "employees": "", "revenue": "", "funding": "누적 940억원"},   # 이미 보도된 누적 금액이 있다
        {"name": "마바사", "status": "reported", "employees": "", "revenue": "", "funding": ""},              # 이름·금액 없는 라운드뿐
        {"name": "사아자", "status": "inferred", "employees": "약 50명(추정)", "revenue": "", "funding": "추정 100억"},  # 추정 기록 + 내용 없는 라운드
        {"name": "차카타", "status": "inferred", "employees": "", "revenue": "", "funding": "추정 100억"},     # 추정 기록 + 확인된 라운드
    ]
    found = {"metrics": [], "rounds": [rnd("나다라", "시리즈 C", "500억 원"), rnd("마바사", "", ""), rnd("사아자", "", ""), rnd("차카타", "", ""), rnd("차카타", "시리즈 A", "50억 원")]}
    rivals.apply_figures(competitors, found)
    # 알려진 누적 금액을 라운드 한 건으로 바꾸지 않는다. 넣은 값이 없으므로 표시도 붙지 않는다
    assert competitors[0] == {"name": "나다라", "status": "reported", "employees": "", "revenue": "", "funding": "누적 940억원"}
    # 적을 내용이 없는 라운드는 값을 지우지도, 확인 표시를 붙이지도 않는다
    assert competitors[1] == {"name": "마바사", "status": "reported", "employees": "", "revenue": "", "funding": ""}
    assert competitors[2] == {"name": "사아자", "status": "inferred", "employees": "약 50명(추정)", "revenue": "", "funding": "추정 100억"}
    # 추정 기록은 확인된 라운드가 있으면 추정 수치를 지우고 그 라운드로 적는다(내용 없는 라운드는 건너뛴다)
    assert competitors[3] == {"name": "차카타", "status": "inferred", "employees": "", "revenue": "", "funding": "시리즈 A 50억 원",
                              "figuresStatus": "reported", "figuresUrl": "https://news.kr/r"}
    # 누적 투자액을 새로 찾았으면 그 값으로 갱신한다
    metric = {"company": "나다라", "kind": "누적 투자", "value": "1,440억 원", "asOf": "2026년", "quote": "q", "sourceUrl": "https://news.kr/m"}
    rivals.apply_figures(competitors, {"metrics": [metric], "rounds": []})
    assert competitors[0]["funding"] == "누적 1,440억 원 (2026년)" and competitors[0]["figuresUrl"] == "https://news.kr/m"


def test_rival_metric_rejects_the_tail_of_a_compound_amount_and_other_fragments():
    ok = rivals.quantity_in_quote
    # 복합 금액의 뒷부분만 옮긴 값
    assert not ok("500만 원", ("누적 투자는 3억 500만 원이다")) and ok("3억 500만 원", ("누적 투자는 3억 500만 원이다"))
    assert not ok("248억 원", ("매출은 1조 248억 원이다")) and ok("1조 248억 원", ("매출은 1조 248억 원이다"))
    assert not ok("500원", ("단가는 3천만 500원이다")) and not ok("6,456만원", ("매출액. 32억 6,456만원"))
    # 통화 기호·코드가 앞에 붙은 금액에서 통화를 뺀 값
    assert not ok("15억", ("US$ 15억을 조달")) and not ok("15억", ("USD 15억 조달")) and not ok("15억", ("총 15억 불을 조달")) and not ok("15억", ("총 15억 USD 조달"))
    assert ok("USD 15억", ("USD 15억 조달")) and ok("$15억", "미화 $15억을 조달")
    # 범위의 한쪽 끝, 한계를 뜻하는 표현, 어림 표현에서 잘라 낸 값
    assert not ok("200명", ("직원은 100~200명이다")) and not ok("100명", ("직원은 100명~200명이다")) and not ok("09-27", ("설립일자2012-09-27"))
    assert not ok("100억 원", ("매출 100억 원 미만 기업")) and not ok("50명", ("상시근로자 50명 이상")) and not ok("248억", ("매출 248억여 원"))
    # 라운드 이름이나 문장부호 뒤에 온 온전한 값은 그대로 인정한다
    assert ok("300억 원", ("시리즈 B 300억 원 투자 유치")) and ok("300억 원", ("Series B 300억 원 투자")) and ok("32억 6천만 원", ("매출. 32억 6천만 원 (2025)"))
    assert ok("32억 원", ("매출 - 32억 원")) and ok("77명", ("2026년 9월 기준 임직원 수는 77명입니다")) and ok("15억 달러", ("2022년 창업 이후 총 15억 달러를 조달했다"))


def test_rival_metrics_and_rounds_reject_the_tail_of_a_compound_amount():
    results = [{"title": "나다라 실적", "description": "나다라의 누적 투자는 3억 500만 원이다. 매출은 1조 248억 원이다.", "url": "https://news.kr/t"}]
    row = lambda kind, value, quote: {"company": "나다라", "kind": kind, "value": value, "as_of": "", "source": 0, "quote": quote}  # noqa: E731
    raw = {"metrics": [row("누적 투자", "500만 원", "누적 투자는 3억 500만 원이다"), row("매출", "248억 원", "매출은 1조 248억 원이다")],
           "rounds": [{"company": "나다라", "round": "", "amount": "500만 원", "date": "", "investors": [], "source": 0, "quote": "누적 투자는 3억 500만 원이다"}]}
    assert rivals.clean_metrics(raw, ["나다라"], results) == []
    assert rivals.clean_rounds(raw, ["나다라"], results)[0]["amount"] == ""
    good = {"metrics": [row("누적 투자", "3억 500만 원", "누적 투자는 3억 500만 원이다"), row("매출", "1조 248억 원", "매출은 1조 248억 원이다")]}
    assert [m["value"] for m in rivals.clean_metrics(good, ["나다라"], results)] == ["3억 500만 원", "1조 248억 원"]


def test_rival_metric_spacing_decides_whether_a_leading_digit_belongs_to_the_number():
    ok = rivals.quantity_in_quote
    # 띄어 쓴 앞 낱말의 숫자는 값의 일부가 아니다
    assert ok("270억원", "라이너는 시리즈 B2 270억원을 유치했다") and ok("32억 원", "2025 매출 32억 원")
    # 붙여 쓴 숫자는 같은 숫자다
    assert not ok("270억원", "매출 1270억원") and not ok("5억 원", "매출 1.5억 원") and not ok("188명", "직원 1,188명")
    # 복합 금액·통화·범위는 띄어 써도 한 수량이다
    assert not ok("500만 원", "3억 500만 원") and not ok("15억", "USD 15억") and not ok("200명", "100 ~ 200명") and not ok("32억", "32억 6천만 원")
    results = [{"title": "라마바, 시리즈 B2 270억원 유치", "description": "라마바는 케이비인베스트먼트로부터 투자를 받았다.", "url": "https://news.kr/s"}]
    raw = {"rounds": [{"company": "라마바", "round": "시리즈 B2", "amount": "270억원", "date": "", "investors": [], "source": 0, "quote": "라마바, 시리즈 B2 270억원 유치"}]}
    got = rivals.clean_rounds(raw, ["라마바"], results)[0]
    assert (got["round"], got["amount"]) == ("시리즈 B2", "270억원")


def test_rival_metric_rejects_range_endpoints_even_when_both_ends_carry_units():
    ok = rivals.quantity_in_quote
    for value, text in (("200명", "직원은 100명~200명이다"), ("100명", "직원은 100명~200명이다"), ("200억 원", "매출 100억 원~200억 원"),
                        ("200억 원", "매출 100억 원 ~ 200억 원"), ("100억 원", "매출 100억 원~200억 원"), ("200명", "직원 100명-200명"), ("200명", "직원 100~200명")):
        assert not ok(value, text), (value, text)
    # 구분 기호로 쓴 줄표 뒤의 값, 범위가 아닌 값은 그대로 인정한다
    assert ok("32억 원", "매출 - 32억 원") and ok("200명", "직원은 200명이다") and ok("2012-09-27", "설립일자 2012-09-27")
    results = [{"title": "나다라 현황", "description": "나다라의 직원은 100명~200명이다. 매출은 100억 원~200억 원이다.", "url": "https://news.kr/g"}]
    row = lambda kind, value, quote: {"company": "나다라", "kind": kind, "value": value, "as_of": "", "source": 0, "quote": quote}  # noqa: E731
    raw = {"metrics": [row("직원 수", "200명", "직원은 100명~200명이다"), row("매출", "200억 원", "매출은 100억 원~200억 원이다")]}
    assert rivals.clean_metrics(raw, ["나다라"], results) == []


def test_rival_metric_rejects_both_ends_of_a_hyphenated_range():
    ok = rivals.quantity_in_quote
    for value, text in (("100명", "직원 100명-200명"), ("200명", "직원 100명-200명"), ("100명", "직원 100명 - 200명"), ("200명", "직원 100명 - 200명"),
                        ("100억 원", "매출 100억 원 - 200억 원"), ("200억 원", "매출 100억 원 - 200억 원"), ("200억 원", "매출 100억-200억 원"),
                        ("200명", "직원 100 - 200명"), ("2012", "설립일자 2012-09-27"), ("27", "설립일자 2012-09-27")):
        assert not ok(value, text), (value, text)
    # 낱말 뒤의 줄표는 구분 기호다. 온전한 날짜와 범위가 아닌 값은 그대로 인정한다
    assert ok("32억 원", "매출 - 32억 원") and ok("32억 원", "2025년 매출 - 32억 원") and ok("2012-09-27", "설립일자 2012-09-27")
    assert ok("77명", "직원 수 - 77명 (2026년 9월 기준)") and ok("300억 원", "시리즈 B 300억 원 투자 유치")
    results = [{"title": "나다라 현황", "description": "나다라의 직원은 100명 - 200명이다.", "url": "https://news.kr/h"}]
    raw = {"metrics": [{"company": "나다라", "kind": "직원 수", "value": v, "as_of": "", "source": 0, "quote": "직원은 100명 - 200명이다"} for v in ("100명", "200명")]}
    assert rivals.clean_metrics(raw, ["나다라"], results) == []
