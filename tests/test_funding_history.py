"""투자유치 이력(research/funding_history) 테스트. 실제 API 를 부르지 않는다(httpx.MockTransport)."""
from __future__ import annotations

import json

import httpx
import pytest

from liner_client import LinerClient
from research import common, controller, funding_history as fh
from research.liner import Liner

COLS = ["name", "status", "funding_stage", "total_raised", "location", "website", "funding_round_count", "funding_rounds", "also_known_as", "sources"]
REB = ["ReferenceCo", "", "Series C", "932981469.0", "Seoul, Korea", "example.com", "3",
       "Seed, 2020-11-23: $4M (Kakao Ventures, Shinhan Capital Co., Ltd., 서울대학교기술지주  Seoul National University Tech Holdings); "
       "Series A, 2022-06-02: $70M (IMM Investment Corp., KT Investment, Korea Development Bank); Corporate round, 2025-07-29", "기준 기업", "People Data Labs"]
SAP = ["FormerCo Inc.", "", "Series A", "106987540.0", "San Jose", "FormerCo.com", "2",
       "Series A, 2023-04-12: $45.3M (GS E&C, WE Ventures); Corporate round, 2022-06-22: $61.6M", "FormerCo korea inc.; FormerCo", "People Data Labs"]
OTHER = ["Rebellion Defense", "", "Series B", "1", "US", "rebelliondefense.com", "1", "Series B, 2021-09-01: $150M (Insight Partners)", "", "PDL"]


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "CACHE_DIR", tmp_path / "cache")


def test_parse_funding_rounds_keeps_investors_and_unparsed_fragments():
    rs = fh.parse_funding_rounds(REB[7])
    assert [r["round"] for r in rs] == ["Seed", "Series A", "Corporate round"]
    assert rs[0]["amount_value"] == 4e6 and rs[0]["currency"] == "USD"
    assert "Shinhan Capital Co., Ltd." in rs[0]["investors"] and len(rs[0]["investors"]) == 3
    assert rs[2]["amount"] == "" and rs[2]["investors"] == []  # 금액·투자자 없는 라운드도 버리지 않는다


def test_from_premium_includes_related_entity_but_not_unrelated():
    data = {"knowledge": [{"title": "Companies matching", "columns": COLS, "rows": [REB, SAP, OTHER], "sources": ["People Data Labs"]}]}
    names = ["기준 기업", "ReferenceCo", "FormerCo"]  # 합병 법인 이름이 별칭에 있으면 포함
    cards, rounds = fh.from_premium(data, names, "example.com", "q")
    assert {c["name"] for c in cards} == {"ReferenceCo", "FormerCo Inc."}
    assert all(r["entity"] != "Rebellion Defense" for r in rounds)  # 다른 회사(단수형 이름)는 제외
    assert any(r["entity"] == "FormerCo Inc." and r["round"] == "Series A" for r in rounds)  # 투자대상 법인명 보존


def test_merge_only_obvious_duplicates_and_keep_amount_conflicts():
    prem = [{"raw": "a", "round": "Series A", "date": "2022-06-02", "amount": "$70M", "amount_value": 7e7, "currency": "USD",
             "investors": ["KT Investment"], "lead": [], "entity": "ReferenceCo", "summary": "", "source_type": "premium_structured", "sources": [{"type": "Premium", "url": ""}]}]
    web = [{"raw": "b", "round": "시리즈 A", "date": "2022-06", "amount": "620억원", "amount_value": None, "currency": "KRW",
            "investors": ["KT", "KT Investment"], "lead": ["KT"], "entity": "기준 기업", "summary": "시리즈A 620억 유치", "source_type": "web_reported",
            "sources": [{"type": "Web", "url": "https://n.kr/1"}]},
           {"raw": "c", "round": "시리즈 B", "date": "2024-01", "amount": "", "amount_value": None, "currency": "",
            "investors": ["산업은행"], "lead": [], "entity": "기준 기업", "summary": "", "source_type": "web_reported", "sources": [{"type": "Web", "url": "https://n.kr/2"}]}]
    out = fh.merge_rounds(prem + web)
    assert len(out) == 2
    a = next(r for r in out if r["round"] == "Series A")
    assert a["amount"] == "$70M" and a["other_amounts"] == ["620억원"]  # 금액 차이는 지우지 않는다
    assert a["investors"] == ["KT Investment", "KT"] and a["source_type"] == "premium_structured+web_reported"
    inv = fh.investor_table(out)
    assert {i["투자기관"] for i in inv} == {"KT Investment", "KT", "산업은행"}
    assert next(i for i in inv if i["투자기관"] == "산업은행")["유형(이름 기반 추정)"].startswith("정책금융")


def test_clean_web_keeps_only_quoted_facts():
    results = [{"title": "기준 기업, 시리즈B 1000억 유치", "description": "기준 기업이 산업은행 등에서 1000억원 규모 시리즈B 투자를 유치했다.",
                "url": "https://n.kr/1", "date": "2024-01-30"}]
    raw = {"rounds": [{"company": "기준 기업", "entity": "기준 기업", "date": "2024", "round": "시리즈B", "amount": "1000억원",
                       "investors": ["산업은행", "삼성전자"], "lead_investors": [], "summary": "s", "source": 0,
                       "quote": "산업은행 등에서 1000억원 규모 시리즈B 투자를 유치했다"},
                      {"company": "기준 기업", "entity": "", "date": "", "round": "", "amount": "", "investors": [], "lead_investors": [],
                       "summary": "", "source": 0, "quote": "자료에 없는 문장입니다"}]}
    cos = [fh.company_entry("기준 기업", "ReferenceCo")]
    out = fh.clean_web(raw, cos, results)
    assert len(out) == 1 and out[0]["investors"] == ["산업은행"]  # 자료에 없는 투자사(삼성전자)는 뺀다
    assert out[0]["date"] == "" and out[0]["reported_date"] == "2024-01-30" and out[0]["currency"] == "KRW"


def _client(handler, premium=12):
    return LinerClient("k" * 20, "env", transport=httpx.MockTransport(handler), sleep=lambda s: None,
                       limits={"search": 20, "model": 3, "scholar": 0, "premium": premium})


def test_collect_uses_premium_first_and_supplements_with_web():
    seen = []

    def handler(req):
        body = json.loads(req.content or b"{}")
        if "chat/completions" in req.url.path:
            seen.append(("model", ""))
            ans = {"rounds": [{"company": "딥엑스", "entity": "딥엑스", "date": "2024", "round": "시리즈 C", "amount": "1100억원",
                               "investors": ["스카이레이크"], "lead_investors": ["스카이레이크"], "summary": "시리즈C", "source": 0,
                               "quote": "딥엑스가 스카이레이크 주도로 1100억원 시리즈 C 투자를 유치"}]}
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(ans, ensure_ascii=False)}}], "usage": {}})
        seen.append(("premium" if body.get("include_knowledge") else "search", body["query"]))
        if body.get("include_knowledge"):
            if "ReferenceCo" in body["query"]:
                return httpx.Response(200, json={"results": [], "knowledge": [{"title": "ReferenceCo", "columns": COLS, "rows": [REB], "sources": ["People Data Labs"]}]})
            return httpx.Response(200, json={"results": [], "knowledge": []})
        return httpx.Response(200, json={"results": [{"title": "딥엑스 시리즈C", "description": "딥엑스가 스카이레이크 주도로 1100억원 시리즈 C 투자를 유치했다",
                                                      "url": "https://n.kr/9", "date": "2024-03-01"}]})
    lw = Liner(_client(handler))
    cos = [fh.company_entry("기준 기업", "ReferenceCo", homepage="example.com"), fh.company_entry("딥엑스", "DEEPX")]
    news = {"기준 기업": {"articles": [{"date": "2026-01-01", "title": "기준 기업 투자 유치", "description": "", "url": "https://x", "매체": "x", "분류": ["투자유치"]}]}}
    out = fh.collect(lw, cos, news)
    reb, dx = out["by_company"]["기준 기업"], out["by_company"]["딥엑스"]
    assert reb["summary"]["rounds"] == 3 and reb["summary"]["total_raised"] == 932981469.0 and not reb["web_used"]
    assert reb["articles"] and reb["articles"][0]["제목"] == "기준 기업 투자 유치"
    assert dx["web_used"] and dx["rounds"][0]["amount"] == "1100억원" and dx["rounds"][0]["lead"] == ["스카이레이크"]
    # 호출: 기준 기업 Premium 1회(카드 확보로 중단), 딥엑스 Premium 2회 + 웹 1회, 모델 1회
    assert [k for k, _ in seen].count("premium") == 3 and [k for k, _ in seen].count("search") == 1 and [k for k, _ in seen].count("model") == 1
    assert any(c["api"] == "Liner Web Search" for c in dx["calls"])
    fh.collect(lw, cos, news)  # 두 번째 실행은 캐시 재사용
    assert len(seen) == 5


def test_collect_never_raises_on_api_failure():
    lw = Liner(_client(lambda req: httpx.Response(503, json={"error": {"message": "down"}})))
    out = fh.collect(lw, [fh.company_entry("기준 기업", "ReferenceCo")])
    item = out["by_company"]["기준 기업"]
    assert item["rounds"] == [] and item["summary"]["rounds"] == 0 and lw.errors
    out = fh.collect(Liner(None), [fh.company_entry("기준 기업")])
    assert out["by_company"]["기준 기업"]["errors"]


def test_controller_attaches_funding_history_and_survives_failure(monkeypatch):
    monkeypatch.setattr(controller.Liner, "from_env", classmethod(lambda cls: Liner(None)))
    prof = {"name_ko": "테스트", "competitors": [{"name": "경쟁A", "name_en": "RivalA", "is_korean": False, "country": "미국", "relation": "해외 경쟁사", "reason": ""}]}
    monkeypatch.setattr(controller.company, "analyze", lambda *a, **k: {"profile": prof, "corp": None, "errors": []})
    monkeypatch.setattr(controller.news, "collect", lambda *a, **k: {"articles": [], "raw_count": 0, "api_counts": {"naver": 0, "liner": 0}, "errors": []})
    monkeypatch.setattr(controller.public_data, "company_bundle", lambda *a, **k: {"nps": {}, "errors": []})
    monkeypatch.setattr(controller.papers, "topic_trend", lambda *a, **k: {"recent": [], "cited": [], "by_year": {}})
    monkeypatch.setattr(controller.papers, "company_papers", lambda *a, **k: {"works": []})
    monkeypatch.setattr(controller.gov, "g2b_search", lambda *a, **k: {"items": [], "calls": 0, "errors": []})
    monkeypatch.setattr(controller.funding_view, "company_lookup", lambda *a, **k: {})
    R = controller.run("테스트")
    assert R["steps"]["target"]["status"] == "완료" and R["steps"]["rivals"]["status"] == "완료"
    assert R["target"]["funding_history"]["company"] == "테스트" and R["rivals"][0]["funding_history"]["company"] == "경쟁A"
    monkeypatch.setattr(controller.funding_history, "collect", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    R = controller.run("테스트")
    assert R["steps"]["target"]["status"] == "완료" and R["target"]["funding_history"] is None
    assert any("투자유치 이력" in e and "boom" in e for e in R["errors"])
