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
from funding import company, service  # noqa: E402
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
    monkeypatch.setattr(api_main, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(api_main, "_paid_used", 0)
    monkeypatch.setattr(api_main.config, "resolve_api_key", lambda: ("secret-key-xyz", "env"))
    seen: list[dict] = []
    monkeypatch.setattr(api_main, "LinerClient", lambda key, source, limits: _limited(chat_client([EXTRACT_ANSWER, MATCH_ANSWER], seen), limits))
    monkeypatch.setattr(service.docs, "fetch_document", lambda url: make_hwpx())
    return TestClient(api_main.app), seen


def _limited(client: LinerClient, limits: dict) -> LinerClient:
    client._limits.update(limits)
    return client


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
    monkeypatch.setattr(api_main, "_paid_used", api_main.MAX_PAID_CALLS - 1)
    assert client.post("/api/notice/analyze", json=BODY).status_code == 429
    assert seen == [] and api_main._paid_used == api_main.MAX_PAID_CALLS - 1
    monkeypatch.setattr(api_main.config, "resolve_api_key", lambda: (None, None))
    assert client.post("/api/notice/analyze", json=BODY).status_code == 503
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


def wait_job(client, job_id, tries=200):
    import time

    for _ in range(tries):
        body = client.get(f"/api/company/lookup/{job_id}").json()
        if body["status"] != "running":
            return body
        time.sleep(0.01)
    raise AssertionError("조회 작업이 끝나지 않음")


def test_api_lookup_runs_as_a_job_and_releases_unused_calls(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(api_main, "_jobs", {})
    calls = []

    def fake(name, c, homepage="", progress=None):
        progress("Model API [기업 개요] 3개 출처")
        calls.append((name, homepage))
        return {"draft": {"name": name}, "fields": [], "investors": []}

    monkeypatch.setattr(api_main.profile_mod, "lookup", fake)
    res = client.post("/api/company/lookup", json={"name": " 가나다 ", "homepage": "example.kr"})
    assert res.status_code == 202 and len(res.json()["jobId"]) == 32
    body = wait_job(client, res.json()["jobId"])
    assert body["status"] == "done" and body["result"]["draft"]["name"] == "가나다" and body["result"]["query"] == "가나다"
    assert body["stage"] == "회사 정보·기존 투자자·경쟁사 추출" and calls == [("가나다", "example.kr")]
    assert api_main._paid_used == 0  # 실제로 나간 호출이 없으면 잡아 둔 횟수를 돌려준다
    assert client.post("/api/company/lookup", json={"name": "가"}).status_code == 422
    assert client.post("/api/company/lookup", json={"name": "가나다", "homepage": "https://x.kr/a?b"}).status_code == 422
    assert client.get("/api/company/lookup/" + "0" * 32).status_code == 404
    monkeypatch.setattr(api_main, "_paid_used", api_main.MAX_PAID_CALLS - 5)
    assert client.post("/api/company/lookup", json={"name": "가나다"}).status_code == 429 and len(calls) == 1


def test_api_lookup_job_reports_failures_and_limits_concurrency(api, monkeypatch):
    import threading

    client, _ = api
    monkeypatch.setattr(api_main, "_jobs", {})
    gate = threading.Event()

    def slow(name, c, homepage="", progress=None):
        gate.wait(2)
        if name == "실패":
            raise api_main.profile_mod.ProfileError("회사 정보를 추출하지 못했습니다(모델 호출 실패).")
        if name == "예외":
            raise RuntimeError("secret detail")
        return {"draft": {"name": name}, "fields": [], "investors": []}

    monkeypatch.setattr(api_main.profile_mod, "lookup", slow)
    first = client.post("/api/company/lookup", json={"name": "실패"}).json()["jobId"]
    second = client.post("/api/company/lookup", json={"name": "예외"}).json()["jobId"]
    assert client.get(f"/api/company/lookup/{first}").json()["status"] == "running"
    assert client.post("/api/company/lookup", json={"name": "세번째"}).status_code == 429  # 동시에 두 건까지만
    gate.set()
    a, b = wait_job(client, first), wait_job(client, second)
    assert a["status"] == "error" and "모델 호출 실패" in a["error"] and "result" not in a
    assert b["status"] == "error" and "RuntimeError" in b["error"] and "secret detail" not in b["error"]
    assert api_main._paid_used == 0
    assert client.post("/api/company/lookup", json={"name": "네번째"}).status_code == 202


def test_stage_label_maps_engine_messages():
    assert api_main.stage_label("Search API [identity] 가나다 회사 개요") == "보도·공식 자료 검색"
    assert api_main.stage_label("원문 확인") == "원문 확인"
    assert api_main.stage_label("경쟁사 투자 이력 조회") == "경쟁사 투자 이력 조회"
    assert api_main.stage_label("알 수 없는 문구") == "조회 중"



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
    assert api_main._paid_used == 3  # 실패한 첫 요청, 재시도, 대조


def test_api_reserves_room_for_retries_before_sending(api, monkeypatch):
    client, seen = api
    # 재시도까지 가면 4회가 나갈 수 있으므로, 3회만 남았으면 보내지 않는다
    monkeypatch.setattr(api_main, "_paid_used", api_main.MAX_PAID_CALLS - 3)
    assert client.post("/api/notice/analyze", json=BODY).status_code == 429 and seen == []
    monkeypatch.setattr(api_main, "_paid_used", api_main.MAX_PAID_CALLS - 4)
    assert client.post("/api/notice/analyze", json=BODY).status_code == 200
    assert api_main._paid_used == api_main.MAX_PAID_CALLS - 2


def test_api_reports_document_outage_as_handled_error(api, monkeypatch):
    client, seen = api

    def down(url):
        raise service.docs.DocumentError("공고문 서버에 연결하지 못했습니다(ConnectError)")

    monkeypatch.setattr(service.docs, "fetch_document", down)
    res = client.post("/api/notice/analyze", json=BODY)
    assert res.status_code == 422 and "공고문" in res.json()["detail"]
    assert seen == [] and api_main._paid_used == 0


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
    assert calls == [("가나벤처스", 1)] and api_main._paid_used == 0
    assert client.post("/api/gp/brief", json={**body, "gp": "아무 검색어나 넣기"}).status_code == 404
    assert client.post("/api/gp/brief", json={**body, "gp": "가"}).status_code == 422
    monkeypatch.setattr(api_main, "_paid_used", api_main.MAX_PAID_CALLS - 3)
    assert client.post("/api/gp/brief", json=body).status_code == 429 and len(calls) == 1


def test_revenue_omits_basis_when_the_engine_does_not_know_it():
    assert profile.format_revenue({"value": "248.01", "unit": "억 원", "currency": "KRW", "year": "2025", "basis": "unknown"}) == "248.01억 원 (2025)"
    assert profile.format_revenue({"value": "5", "unit": "억원", "year": "2024", "basis": "미확인"}) == "5억원 (2024)"
    assert profile.format_revenue({"value": "5", "unit": "억원", "year": "2024", "basis": "연결"}) == "5억원 (2024, 연결)"


def test_api_lookup_admission_is_atomic_under_concurrent_requests(api, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    client, _ = api
    monkeypatch.setattr(api_main, "_jobs", {})
    gate = threading.Event()
    monkeypatch.setattr(api_main.profile_mod, "lookup", lambda name, c, homepage="", progress=None: gate.wait(3) and {"draft": {"name": name}, "fields": [], "investors": []})
    barrier = threading.Barrier(8)

    def start(i):
        barrier.wait()
        return client.post("/api/company/lookup", json={"name": f"회사{i}"}).status_code

    with ThreadPoolExecutor(8) as pool:
        codes = sorted(pool.map(start, range(8)))
    try:
        assert codes == [202, 202] + [429] * 6
        running = [j for j in api_main._jobs.values() if j["status"] == "running"]
        assert len(running) == api_main.MAX_RUNNING_LOOKUPS
        assert api_main._paid_used == 2 * api_main.worst_case(api_main.LOOKUP_SEARCHES + api_main.LOOKUP_MODELS)
    finally:
        gate.set()
        for j in list(api_main._jobs.values()):
            j["thread"].join(3)
    assert api_main._paid_used == 0


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
