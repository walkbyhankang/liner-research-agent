"""국내 특허(research/patents) 테스트. 실제 API·웹을 부르지 않는다."""
from __future__ import annotations

import httpx
import pytest

from liner_client import LinerClient
from research import common, controller, patents
from research.liner import Liner

# 실제 Google Patents 원문(KR102867987B1)에서 추출한 텍스트 형식을 줄인 것
PAGE_B = ("KR102867987B1 - 모델 세트 성능 평가 방법 및 시스템 Info Publication number KR102867987B1 Application number KR1020230179893A "
          "Other languages English ( en ) Inventor 이활석 Original Assignee 주식회사 업스테이지 Priority date 2022-12-23 Filing date 2023-12-12 "
          "Publication date 2025-10-13 2023-12-12 Application filed by 주식회사 업스테이지 filed Critical 주식회사 업스테이지 "
          "2024-07-02 Publication of KR20240101389A publication Critical 2025-10-13 Application granted 2025-10-13 Publication of KR102867987B1 "
          "Status Active legal-status\n Classifications \n G — PHYSICS \n G06V — IMAGE OR VIDEO RECOGNITION OR UNDERSTANDING \n G06V30/00 — Character recognition \n"
          "Abstract 본 개시는 문자 인식과 연관된 모델 세트 성능을 평가하는 방법을 제공한다. Description\n"
          "Family Applications After (1) KR1020230179503A Active KR102775032B1 ( ko ) 라벨링 작업 관리 방법\n Country Status (1)\n"
          "Cited By (1) KR20990000001A ( ko ) 2020-01-01 주식회사 다른회사 무관한 특허\n")
PAGE_A = PAGE_B.replace("Publication number KR102867987B1", "Publication number KR20240101389A")  # 같은 출원의 공개 문서
PAGE_OTHER = ("KR102000000B1 - 다른 발명 Application number KR1020200000001A Original Assignee 주식회사 남의회사 Filing date 2020-05-05 "
              "Application filed by 주식회사 남의회사 filed Critical 주식회사 남의회사 Status Active\n Cited By 업스테이지 언급\n")
PAGE_NODATE = "KR102775032B1 - 라벨링 작업 관리 방법 Application number KR1020230179503A Original Assignee 주식회사 업스테이지 Status Active\n"


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "CACHE_DIR", tmp_path / "cache")


def test_parse_page_reads_bibliographic_fields():
    p = patents.parse_page(PAGE_B, "KR102867987B1 - 모델 세트 성능 평가 방법 및 시스템 - Google Patents", "KR102867987B1")
    assert p["assignee"] == "주식회사 업스테이지" and p["application_no"] == "10-2023-0179893" and p["filing_date"] == "2023-12-12"
    assert p["publication_no"] == "KR20240101389A" and p["publication_date"] == "2024-07-02"
    assert p["registration_no"] == "KR102867987B1" and p["title"] == "모델 세트 성능 평가 방법 및 시스템"
    assert p["cpc"][0] == "G06V30/00" and p["abstract"].startswith("본 개시는")
    assert patents.parse_page(PAGE_NODATE, "", "KR102775032B1")["filing_date"] == ""  # 없는 값은 만들지 않는다


def test_harvest_family_and_name_lines_only():
    got = patents.harvest(PAGE_B, ["업스테이지"])
    assert "KR102775032B1" in got and "KR20990000001A" not in got  # 무관한 피인용 특허는 후보로 넣지 않는다


def test_company_patents_dedups_by_application_and_separates_mentions(monkeypatch):
    pages = {"KR102867987B1": PAGE_B, "KR20240101389A": PAGE_A, "KR102000000B1": PAGE_OTHER, "KR102775032B1": PAGE_NODATE}
    fetched = []

    def fake_fetch(pub):
        fetched.append(pub)
        return patents.parse_page(pages[pub], f"{pub} - 제목 - Google Patents", pub) | {"_harvest_text": pages[pub]} if pub in pages else None
    monkeypatch.setattr(patents, "fetch_patent", fake_fetch)
    n = {"search": 0}

    def handler(req):
        n["search"] += 1
        return httpx.Response(200, json={"results": [
            {"title": "KR102867987B1 - 모델 세트", "url": "https://patents.google.com/patent/KR102867987B1/ko", "description": "Application filed by 주식회사 업스테이지"},
            {"title": "KR20240101389A", "url": "https://patents.google.com/patent/KR20240101389A/ko", "description": ""},
            {"title": "다른 발명", "url": "https://patents.google.com/patent/KR102000000B1/ko", "description": "업스테이지 인용"}]})
    lw = Liner(LinerClient("k" * 20, "env", transport=httpx.MockTransport(handler), sleep=lambda s: None, limits={"search": 10, "model": 0, "scholar": 0}))
    res = patents.collect(lw, [patents.entry("업스테이지", "Upstage", is_self=True)])
    c = res["companies"][0]
    assert n["search"] == 2  # 기업당 Liner 검색 2회
    apps = [p["application_no"] for p in c["patents"]]
    assert apps == ["10-2023-0179893", "10-2023-0179503"]  # A·B 문서는 한 출원으로 합치고, 패밀리 후보(KR102775032B1)는 원문 확인 후 추가
    assert c["patents"][0]["publication_no"] == "KR20240101389A" and c["patents"][0]["registration_no"] == "KR102867987B1"
    assert [m["pub_no"] for m in c["mentions"]] == ["KR102000000B1"]  # 출원인이 다르면 언급 문서로만
    s = c["summary"]
    assert s["total"] == 2 and s["by_year"] == {2023: 1} and s["no_filing_date"] == 1  # 출원일 없는 건은 연도 집계에서 뺀다
    patents.collect(lw, [patents.entry("업스테이지", "Upstage", is_self=True)])
    assert n["search"] == 2  # 두 번째는 검색 캐시 재사용


def test_entry_uses_korean_names_only():
    e = patents.entry("업스테이지", "Upstage", registered="주식회사 업스테이지", aliases=["Upstage AI", "솔라"])
    assert e["names"] == ["업스테이지", "솔라"] and e["registered"] == "업스테이지"


def test_collect_never_raises_and_controller_continues(monkeypatch):
    out = patents.collect(Liner(None), [patents.entry("업스테이지")])
    assert out["companies"][0]["errors"] and out["companies"][0]["patents"] == []
    monkeypatch.setattr(patents, "company_patents", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    lw = Liner(LinerClient("k" * 20, "env", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})), limits={"search": 1}))
    assert "boom" in patents.collect(lw, [patents.entry("업스테이지")])["companies"][0]["errors"][0]
    # 컨트롤러: 특허 수집이 실패해도 ④ 논문 결과와 다른 단계는 유지된다
    monkeypatch.setattr(controller.Liner, "from_env", classmethod(lambda cls: Liner(None)))
    prof = {"name_ko": "테스트", "competitors": [{"name": "경쟁A", "is_korean": True, "country": "한국"}], "tech_keywords": [{"ko": "a", "en": "a"}]}
    monkeypatch.setattr(controller.company, "analyze", lambda *a, **k: {"profile": prof, "corp": None, "errors": []})
    monkeypatch.setattr(controller.news, "collect", lambda *a, **k: {"articles": [], "raw_count": 0, "api_counts": {"naver": 0, "liner": 0}, "errors": []})
    monkeypatch.setattr(controller.public_data, "company_bundle", lambda *a, **k: {"nps": {}, "errors": []})
    monkeypatch.setattr(controller.papers, "topic_trend", lambda *a, **k: {"recent": [{"제목": "p", "링크": "", "id": "W1"}], "cited": [], "by_year": {}})
    monkeypatch.setattr(controller.papers, "company_papers", lambda c, *a, **k: {"company": c, "works": []})
    monkeypatch.setattr(controller.gov, "g2b_search", lambda *a, **k: {"items": [], "calls": 0, "errors": []})
    monkeypatch.setattr(controller.funding_view, "company_lookup", lambda *a, **k: {})
    monkeypatch.setattr(controller.patents, "collect", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("patent down")))
    R = controller.run("테스트")
    assert R["steps"]["tech"]["status"] == "완료" and R["tech"]["topics"][0]["papers"] and R["tech"]["patents"]["companies"] == []
    assert any("특허" in e and "patent down" in e for e in R["errors"]) and R["steps"]["gov"]["status"] == "완료"
