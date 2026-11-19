"""단위 테스트: 실제 API를 호출하지 않는다 (httpx.MockTransport 사용)."""
import csv
import json
import sys
import zipfile
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import analysis as an  # noqa: E402
import config  # noqa: E402
import pipeline as pl  # noqa: E402
from liner_client import CallLimitExceeded, LinerAPIError, LinerClient, extract_output_text  # noqa: E402

KEY = "sk-test-SECRET-1234567890"
URL1 = "https://example.com/a"
SEARCH_OK = {"requestId": "r1", "totalCount": 1, "results": [
    {"title": "Acme 회사 개요", "url": URL1, "hostname": "example.com", "description": "Acme 설립 2015", "date": "2026-01-01"}]}


def make_client(handler, **kw):
    return LinerClient(KEY, "env", transport=httpx.MockTransport(handler), sleep=lambda s: None, **kw)


def model_response(obj):
    return {"id": "resp_1", "model": "gpt-6-luna", "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(obj)}]}],
            "usage": {"input_tokens": 1000, "output_tokens": 500, "total_tokens": 1500,
                      "input_tokens_details": {"cached_tokens": 0}}}


MODEL_OBJ = {
    "company_name": "Acme",
    "facts": [
        {"category": "profile", "item": "설립연도", "value": "2015", "source_url": URL1, "status": "confirmed"},
        {"category": "finance", "item": "매출", "value": "100억", "source_url": "https://fake.example/x", "status": "reported"},
        {"category": "finance", "item": "영업이익", "value": None, "status": "reported"},
    ],
    "financials": [
        {"metric": "revenue", "year": 2024, "value": 100, "unit": "억원", "source_url": URL1, "status": "reported"},
        {"metric": "revenue", "year": 2023, "value": 80, "unit": "억원", "source_url": "https://fake.example/x"},
        {"metric": "employees", "year": 2024, "value": None, "source_url": URL1},
    ],
    "competitors": [{"name": f"C{i}", "source_urls": [URL1]} for i in range(5)],
    "news": [{"title": "Big Deal!", "published_date": "2026-02-01", "commitment_level": "MOU", "source_urls": [URL1]},
             {"title": "big deal", "source_urls": [URL1]}],
    "vcs": [], "support": [{"name": "과제", "url": URL1}],
}


# ---------- config ----------
def test_resolve_api_key_priority(tmp_path):
    envf = tmp_path / ".env"
    envf.write_text("LINER_API_KEY=fromfile\n")
    assert config.resolve_api_key({"LINER_API_KEY": "fromenv"}, envf) == ("fromenv", "env")
    assert config.resolve_api_key({}, envf) == ("fromfile", "dotenv")
    assert config.resolve_api_key({"ANTHROPIC_AUTH_TOKEN": "t", "ANTHROPIC_BASE_URL": "https://platform.liner.com/x"},
                                  tmp_path / "none") == ("t", "claude_code")
    assert config.resolve_api_key({"ANTHROPIC_AUTH_TOKEN": "t", "ANTHROPIC_BASE_URL": "https://evil.com"},
                                  tmp_path / "none") == (None, None)


# ---------- analysis ----------
def test_search_plan_within_limit():
    for country in config.COUNTRIES:
        plan = an.build_search_plan("Acme", country)
        assert len(plan) <= 5 and all("Acme" in p["query"] for p in plan)  # 1차 호환용 계획 함수 유지


def test_parse_model_json_variants():
    assert an.parse_model_json('{"a":1}') == {"a": 1}
    assert an.parse_model_json('```json\n{"a":1}\n```') == {"a": 1}
    assert an.parse_model_json('설명 {"a":1} 끝') == {"a": 1}
    for bad in ("", "no json", "[1]"):
        with pytest.raises(ValueError):
            an.parse_model_json(bad)


def test_normalize_demotes_unsupported_facts():
    out = an.normalize_analysis(MODEL_OBJ, {"profile": SEARCH_OK})
    f = {x["item"]: x for x in out["facts"]}
    assert f["설립연도"]["status"] == "reported"          # confirmed 는 요약 기반이므로 강등
    assert f["매출"]["status"] == "inferred" and f["매출"]["source_url"] is None  # 모르는 URL
    assert f["영업이익"]["status"] == "unavailable"
    assert [x["year"] for x in out["financials"]] == [2024]  # 출처 없음/값 없음 제외
    assert len(out["competitors"]) == 3
    assert len(out["news"]) == 1                           # 중복 보도 병합
    assert out["support"][0]["period"] == "미확인"


def test_facts_table_marks_unavailable():
    out = an.normalize_analysis(MODEL_OBJ, {"profile": SEARCH_OK})
    rows = an.build_facts_table(out)
    assert any(r["value"] == an.UNKNOWN and r["status"] == "unavailable" for r in rows)


def test_scrub_removes_secrets():
    data = {"headers": {"x-api-key": KEY}, "msg": f"failed with {KEY}", "h": "Bearer abcdefghijkl", "n": [KEY]}
    s = json.dumps(an.scrub(data, [KEY]))
    assert KEY not in s and "abcdefghijkl" not in s and "x-api-key" not in s


# ---------- client ----------
def test_search_success_and_record():
    seen = {}

    def h(req):
        seen["body"] = json.loads(req.content)
        seen["key"] = req.headers.get("x-api-key")
        return httpx.Response(200, json=SEARCH_OK)

    c = make_client(h)
    data, rec = c.search_web("q", country_code="kr")
    assert data["results"][0]["url"] == URL1 and rec["ok"] and rec["est_cost_usd"] == 0.001
    assert seen["body"]["max_results"] == 15 and seen["body"]["include_knowledge"] is False
    assert seen["key"] == KEY and KEY not in json.dumps(c.calls)


def test_retry_once_on_524_then_fail():
    n = {"c": 0}

    def h(req):
        n["c"] += 1
        return httpx.Response(524, text="<html>timeout</html>")

    c = make_client(h)
    with pytest.raises(LinerAPIError) as e:
        c.search_web("q")
    assert n["c"] == 2 and e.value.status == 524 and e.value.retryable  # 원호출 + 재시도 1회
    assert [r["http_status"] for r in c.calls] == [524, 524]


def test_retry_after_header_respected():
    waits = []
    n = {"c": 0}

    def h(req):
        n["c"] += 1
        if n["c"] == 1:
            return httpx.Response(429, headers={"retry-after": "7"}, json={"error": {"message": "slow", "code": "RATE_LIMITED"}})
        return httpx.Response(200, json=SEARCH_OK)

    c = LinerClient(KEY, transport=httpx.MockTransport(h), sleep=waits.append)
    data, _ = c.search_web("q")
    assert waits == [7.0] and data["totalCount"] == 1


def test_no_retry_on_401_and_timeout_not_retried():
    n = {"c": 0}

    def h401(req):
        n["c"] += 1
        return httpx.Response(401, json={"error": {"message": "bad key", "code": "UNAUTHORIZED"}})

    with pytest.raises(LinerAPIError) as e:
        make_client(h401).search_web("q")
    assert n["c"] == 1 and e.value.status == 401

    def hto(req):
        n["c"] += 1
        raise httpx.ReadTimeout("t")

    n["c"] = 0
    with pytest.raises(LinerAPIError):
        make_client(hto).search_web("q")
    assert n["c"] == 1


def test_call_limit_enforced():
    c = make_client(lambda r: httpx.Response(200, json=SEARCH_OK), limits={"search": 2, "model": 1, "agent": 1})
    c.search_web("a"), c.search_web("b")
    with pytest.raises(CallLimitExceeded):
        c.search_web("c")
    assert len(c.calls) == 2


def test_extract_output_text_and_cost():
    d = model_response({"x": 1})
    assert json.loads(extract_output_text(d)) == {"x": 1}
    from liner_client import estimate_cost_usd
    assert estimate_cost_usd("model", d) == round((1000 * 0.10 + 500 * 0.50) / 1e6, 6)


# ---------- pipeline ----------
def routing_handler(req):
    if req.url.path == config.SEARCH_WEB_PATH:
        return httpx.Response(200, json=SEARCH_OK)
    if req.url.path == config.RESPONSES_PATH:
        return httpx.Response(200, json=model_response(MODEL_OBJ))
    if req.url.path == config.SEARCH_AGENT_PATH:
        return httpx.Response(200, json={"answer": "답변", "references": [{"title": "t", "url": URL1, "hostname": "example.com"}]})
    return httpx.Response(404)


def cat_model_handler(req):
    """카테고리별 모델 호출 모의 응답: 입력 JSON에서 카테고리를 instructions 로 판별."""
    body = json.loads(req.content)
    ins = body["instructions"]
    if "카테고리: 기업 기본정보" in ins:
        obj = {"facts": [{"item": "설립연도", "value": "2015", "source_url": URL1, "status": "confirmed"}]}
    elif "카테고리: 재무" in ins:
        obj = {"facts": [], "financials": [{"metric": "revenue", "fiscal_year": 2024, "basis": "consolidated",
                                            "value": 100, "unit": "억원", "currency": "KRW", "source_url": URL1}]}
    else:
        obj = {"competitors": [], "events": [], "existing_investors": [], "candidates": [], "programs": [], "procurement": []}
    return httpx.Response(200, json=model_response(obj))


def routing_handler2(req):
    if req.url.path == config.RESPONSES_PATH:
        return cat_model_handler(req)
    return routing_handler(req)


FAST = {"fetch_pages": 0}


def test_full_pipeline_and_files(tmp_path):
    c = make_client(routing_handler2, limits={"search": 12, "model": 6, "agent": 1})
    run = pl.run_analysis("Acme", "미국", c, options=FAST)
    assert run["status"]["search"] in ("success", "partial") and run["status"]["agent"] == "success"
    n_search = sum(1 for x in run["calls"] if x["kind"] == "search")
    assert n_search <= 12
    assert sum(1 for x in run["calls"] if x["kind"] == "model") <= 6
    pl.run_agent(run, c)  # 같은 실행에서 Agent 중복 호출 금지
    assert sum(1 for x in run["calls"] if x["kind"] == "agent") == 1

    out = pl.save_results(run, c.secrets, tmp_path)
    names = {p.name for p in out.iterdir()}
    required = {"raw_api_responses.json", "company_profile.json", "news_events.csv", "competitors.csv",
                "vc_and_support.csv", "extracted_facts.csv", "api_calls.csv", "quality_report.md", "run_manifest.json",
                "analysis_bundle.zip", "search_comparison.csv", "source_verification.csv", "coverage_report.json",
                "improvement_comparison.md"}
    assert names == required
    with zipfile.ZipFile(out / "analysis_bundle.zip") as z:
        assert set(z.namelist()) == required - {"analysis_bundle.zip"}
    rows = list(csv.DictReader((out / "api_calls.csv").open(encoding="utf-8-sig")))
    assert len(rows) == len(run["calls"]) and rows[0]["http_status"] == "200" and rows[0]["max_results"] == "15"
    assert run["secret_leaks"] == []
    for p in out.iterdir():
        if p.suffix != ".zip":
            assert KEY not in p.read_text(encoding="utf-8")
    assert json.loads((out / "run_manifest.json").read_text(encoding="utf-8"))["status"]["agent"] == "success"


def test_pipeline_search_failure_keeps_empty_structure(tmp_path):
    c = make_client(lambda r: httpx.Response(401, json={"error": {"message": "bad", "code": "UNAUTHORIZED"}}))
    run = pl.run_analysis("Acme", "대한민국", c, options=FAST)
    assert run["status"]["search"] == "failed" and run["status"]["model"] == "not_run"
    assert len(run["calls"]) == 1  # 401 이후 중단
    out = pl.save_results(run, c.secrets, tmp_path)
    assert (out / "analysis_bundle.zip").exists()
    assert json.loads((out / "run_manifest.json").read_text(encoding="utf-8"))["errors"]


def test_pipeline_model_failure_keeps_search(tmp_path):
    def h(req):
        if req.url.path == config.RESPONSES_PATH:
            return httpx.Response(524, text="timeout")
        return routing_handler(req)

    c = make_client(h, limits={"search": 12, "model": 6, "agent": 1})
    run = pl.run_analysis("Acme", "미국", c, options=dict(FAST, use_agent=False))
    assert run["status"]["search"] in ("success", "partial") and run["status"]["model"] == "failed"
    assert run["searches"]
    # 카테고리마다 524 → 원호출 + 자동 재시도 1회(총 2회씩). 한도 6회(시도 기준)까지만 호출
    model_calls = [x for x in run["calls"] if x["kind"] == "model"]
    assert model_calls and all(x["http_status"] == 524 for x in model_calls)
    assert len({x["label"] for x in model_calls}) <= 6


def test_pipeline_bad_model_json():
    def h(req):
        if req.url.path == config.RESPONSES_PATH:
            d = model_response({})
            d["output"][0]["content"][0]["text"] = "not json"
            return httpx.Response(200, json=d)
        return httpx.Response(200, json=SEARCH_OK)

    run = pl.run_analysis("Acme", "미국", make_client(h), options=dict(FAST, use_agent=False))
    assert run["status"]["model"] == "failed" and run["analysis"]["facts"] == []
