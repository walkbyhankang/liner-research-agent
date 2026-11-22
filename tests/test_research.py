"""통합 분석(research/) 단위 테스트. 실제 API 를 부르지 않는다."""
from __future__ import annotations

import httpx
import pytest

from liner_client import LinerClient
from research import common, controller, funding_view, gov, news, public_data
from research.liner import Liner


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "CACHE_DIR", tmp_path / "cache")


def test_pick_recent_years_prefers_consolidated_and_computes_ratios():
    rows = [{"연도": "2022", "구분": "별도요약재무제표", "매출액": 100.0, "영업이익": 10.0},
            {"연도": "2023", "구분": "별도요약재무제표", "매출액": 150.0, "영업이익": -30.0},
            {"연도": "2023", "구분": "연결요약재무제표", "매출액": 200.0, "영업이익": 20.0},
            {"연도": "2024", "구분": "별도요약재무제표", "매출액": None, "영업이익": 5.0}]
    out = public_data.pick_recent_years(rows)
    assert [r["연도"] for r in out] == ["2022", "2023", "2024"]
    assert out[1]["구분"].startswith("연결") and out[1]["매출액 증가율(%)"] == 100.0 and out[1]["영업이익률(%)"] == 10.0
    assert out[2]["매출액 증가율(%)"] is None and out[2]["영업이익률(%)"] is None  # 값이 없으면 만들지 않는다


def test_news_dedup_groups_same_event():
    rows = [{"date": "2026-11-01", "title": "기준 기업, 1000억 투자 유치", "description": "", "url": "https://a.kr/1", "url_key": "a.kr/1", "publisher": "a.kr", "provider": "naver"},
            {"date": "2026-11-02", "title": "[단독] 기준 기업 1000억 투자유치", "description": "", "url": "https://b.kr/2", "url_key": "b.kr/2", "publisher": "b.kr", "provider": "naver"},
            {"date": "2026-06-01", "title": "기준 기업 신제품 공개", "description": "", "url": "https://c.kr/3", "url_key": "c.kr/3", "publisher": "c.kr", "provider": "liner"}]
    out = news.dedup(rows)
    assert len(out) == 2 and out[0]["관련 기사 수"] == 2 and "b.kr" in out[0]["매체"]
    assert "투자유치" in news.classify("기준 기업 투자 유치", "")


def test_gov_windows_never_exceed_seven_days():
    from datetime import date
    wins = gov._windows(28, date(2026, 11, 22))
    assert all((e - s).days <= 6 for s, e in wins) and wins[-1][0] == date(2026, 10, 26)


def test_merge_sort_dedups_and_puts_open_first():
    a = [{"구분": "정부지원사업", "공고명": "AI 반도체 실증", "상태": "접수 예정", "관련성": "높음", "마감": "2026-12-01", "_key": "AI반도체실증"}]
    b = [{"구분": "나라장터(용역)", "공고명": "AI 반도체 실증", "상태": "입찰 진행 중", "관련성": "높음", "마감": "", "_key": "AI반도체실증"},
         {"구분": "나라장터(물품)", "공고명": "GPU 서버", "상태": "입찰 진행 중", "관련성": "보통", "마감": "2026-11-30", "_key": "GPU서버"}]
    out = gov.merge_sort(a, b)
    assert len(out) == 2 and out[0]["공고명"] == "GPU 서버"  # 진행 중 공고가 먼저
    assert out[1]["구분"] == "정부지원사업 + 나라장터(용역)"  # 같은 사업은 한 건으로 합친다


def test_vc_candidates_excludes_existing_investor():
    new, old = funding_view.vc_candidates("ai", ["카카오벤처스"], today="2026-11-22")
    assert all(r["운용사"] != "카카오벤처스" for r in new)
    assert funding_view.gp_key("KB인베스트먼트(주)") == funding_view.gp_key("케이비인베스트먼트")


def test_liner_wrapper_caches_and_swallows_errors():
    n = {"calls": 0}

    def handler(req):
        n["calls"] += 1
        if "chat/completions" in req.url.path:
            return httpx.Response(500, json={"error": {"message": "boom"}})
        return httpx.Response(200, json={"results": [{"title": "t", "url": "https://x", "description": "d"}]})
    client = LinerClient("k" * 20, "env", transport=httpx.MockTransport(handler), sleep=lambda s: None,
                         limits={"search": 5, "model": 2, "scholar": 2})
    lw = Liner(client)
    assert lw.search("q")[0]["title"] == "t" and lw.search("q")[0]["title"] == "t"
    assert n["calls"] == 1 and lw.cache_hits == 1  # 같은 검색은 다시 부르지 않는다
    assert lw.scholar("paper")[0]["url"] == "https://x"
    assert lw.json("s", "u", {"type": "object"}, name="x") is None and lw.errors  # 모델 실패는 None + 기록


def test_controller_continues_when_steps_fail(monkeypatch):
    monkeypatch.setattr(controller.Liner, "from_env", classmethod(lambda cls: Liner(None)))
    monkeypatch.setattr(controller.company, "analyze", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(controller.news, "collect", lambda *a, **k: {"articles": [], "raw_count": 0, "api_counts": {"naver": 0, "liner": 0}, "errors": []})
    monkeypatch.setattr(controller.public_data, "company_bundle", lambda *a, **k: {"nps": {}, "errors": []})
    monkeypatch.setattr(controller.gov, "g2b_search", lambda *a, **k: {"items": [], "calls": 0, "errors": []})
    monkeypatch.setattr(controller.funding_view, "company_lookup", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no key")))
    done = []
    R = controller.run("테스트", step_done=lambda k, s, i: done.append((k, s)))
    # 병렬 실행이라 완료 알림은 끝나는 순서대로 온다. ①이 먼저, 6단계 모두 정확히 한 번씩
    assert done[0][0] == "profile" and sorted(k for k, _ in done) == sorted(k for k, _ in controller.STEPS)
    assert dict(done)["profile"] == "실패" and dict(done)["funding"] == "완료"
    assert "policy" in R["funding"] and any("down" in e for e in R["errors"])
