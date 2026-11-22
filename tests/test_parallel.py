"""병렬 실행·국내 경쟁사·누적 투자액·논문 집계 테스트. 실제 API 를 부르지 않는다."""
from __future__ import annotations

import threading
import time

import httpx
import pytest

from liner_client import LinerClient
from research import common, company, controller, funding_history as fh, papers
from research.liner import Liner


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "CACHE_DIR", tmp_path / "cache")


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


def test_cumulative_prefers_pdl_then_sums_rounds_by_currency():
    card = [{"name": "Upstage", "match": "exact", "total_raised": "704872215.0"}]
    r = lambda amt, cur, v=None: {"amount": amt, "currency": cur, "amount_value": v, "round": "", "raw": amt}  # noqa: E731
    assert fh.cumulative(card, [r("$1M", "USD", 1e6)])["by_currency"] == {"USD": 704872215.0}
    full = fh.cumulative([], [r("100억원", "KRW"), r("$5M", "USD", 5e6)])
    assert full["basis"] == "rounds_sum" and full["by_currency"] == {"KRW": 1e10, "USD": 5e6}  # 통화를 섞지 않는다
    part = fh.cumulative([], [r("100억원", "KRW"), r("", "")])
    assert part["label"] == "확인된 투자유치 금액 합계" and part["rounds_with_amount"] == 1
    assert fh.cumulative([], [r("", "")])["label"] == "미확보" and fh.cumulative([], [r("수백억원", "KRW")])["by_currency"] == {}
    related_only = [{"name": "Upstage Labs", "match": "related", "total_raised": "1"}]
    assert fh.cumulative(related_only, [])["basis"] == "none"  # 유사 이름 카드의 누적액은 대상의 누적액으로 쓰지 않는다


def test_single_flight_calls_api_once_under_concurrency():
    n = {"calls": 0}

    def handler(req):
        n["calls"] += 1
        time.sleep(0.05)
        return httpx.Response(200, json={"results": [{"title": "t", "url": "https://x"}]})
    lw = Liner(LinerClient("k" * 20, "env", transport=httpx.MockTransport(handler), sleep=lambda s: None,
                           limits={"search": 20, "model": 1, "scholar": 1}))
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


def test_mark_important_uses_only_openalex_metrics():
    ps = papers.mark_important([{"FWCI": 3.2, "상위 10%": False}, {"FWCI": 0.5, "상위 10%": True}, {"FWCI": None}, {}])
    assert ps[0]["주요 논문"] == "FWCI 3.2" and "상위 10%" in ps[1]["주요 논문"] and ps[2]["주요 논문"] == "" and ps[3]["주요 논문"] == ""
    rows = papers.dedup_ids([{"doi": "https://doi.org/1"}, {"doi": "https://doi.org/1"}, {"id": "W2"}, {"id": "W2"}, {}])
    assert len(rows) == 3


def _mock_controller(monkeypatch, rivals, slow=0.3):
    monkeypatch.setattr(controller.Liner, "from_env", classmethod(lambda cls: Liner(None)))
    prof = {"name_ko": "테스트", "competitors": rivals, "tech_keywords": [{"ko": "a", "en": "a"}, {"ko": "b", "en": "b"}]}
    monkeypatch.setattr(controller.company, "analyze", lambda *a, **k: {"profile": prof, "corp": None, "errors": []})
    threads = set()

    def slow_news(name, *a, **k):
        threads.add(threading.current_thread().name)
        time.sleep(slow)
        if name == "고장":
            raise RuntimeError("뉴스 API 오류")
        return {"articles": [{"title": name, "date": "", "description": "", "url": "", "매체": "", "분류": [], "관련 기사 수": 1}],
                "raw_count": 1, "api_counts": {"naver": 1, "liner": 0}, "errors": []}
    monkeypatch.setattr(controller.news, "collect", slow_news)
    monkeypatch.setattr(controller.public_data, "company_bundle", lambda name, *a, **k: {"name": name, "nps": {}, "errors": []})
    monkeypatch.setattr(controller.papers, "topic_trend", lambda *a, **k: (time.sleep(slow), {"recent": [], "cited": [], "by_year": {}})[1])
    monkeypatch.setattr(controller.papers, "company_papers", lambda c, *a, **k: {"company": c, "works": []})
    monkeypatch.setattr(controller.gov, "g2b_search", lambda *a, **k: (time.sleep(slow), {"items": [], "calls": 0, "errors": []})[1])
    monkeypatch.setattr(controller.funding_view, "company_lookup", lambda *a, **k: (time.sleep(slow * 2), {"investors": []})[1])
    return threads


def test_controller_runs_steps_in_parallel_keeps_order_and_isolates_failures(monkeypatch):
    rivals = [{"name": n, "is_korean": True, "country": "한국"} for n in ("가", "고장", "다", "라")]
    threads = _mock_controller(monkeypatch, rivals)
    main = threading.get_ident()
    cb_threads, done, msgs = set(), [], []
    t = time.time()
    R = controller.run("테스트", progress=lambda m: (cb_threads.add(threading.get_ident()), msgs.append(m)),
                       step_done=lambda k, s, i: (cb_threads.add(threading.get_ident()), done.append((k, s))))
    elapsed = time.time() - t
    assert cb_threads == {main}  # 콜백(화면 갱신)은 메인 스레드에서만
    assert sorted(k for k, _ in done) == sorted(k for k, _ in controller.STEPS) and all(s == "완료" for _, s in done)
    assert [r["info"]["name"] for r in R["rivals"]] == ["가", "고장", "다", "라"]  # 원래 경쟁사 순서 유지
    assert R["rivals"][0]["news"]["articles"][0]["title"] == "가" and R["rivals"][2]["public"]["name"] == "다"  # 데이터 혼합 없음
    assert R["rivals"][1]["news"] is None and R["rivals"][1]["errors"]  # 한 곳 실패가 다른 경쟁사에 영향 없음
    assert R["funding"]["lookup"] == {"investors": []} and "policy" in R["funding"]
    assert len({n for n in threads if n.startswith("rival")}) >= 2  # 경쟁사 수집이 여러 스레드에서
    # 직렬이면 ②뉴스0.3 + ③경쟁사 4×0.3 + ④키워드 2×0.3 + ⑤0.3 = 2.4초 이상
    assert elapsed < 1.5 and R["parallel"]["overlap_sec"] > 0
    assert R["steps"]["funding"]["start_offset_sec"] == 0.0


def test_controller_lookup_failure_does_not_stop_others(monkeypatch):
    _mock_controller(monkeypatch, [], slow=0.01)
    monkeypatch.setattr(controller.funding_view, "company_lookup", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no key")))
    monkeypatch.setattr(controller.papers, "topic_trend", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("openalex down")))
    R = controller.run("테스트")
    assert R["steps"]["funding"]["status"] == "완료" and R["funding"]["errors"]
    assert R["steps"]["tech"]["status"] == "실패" and R["steps"]["gov"]["status"] == "완료" and "target" in R
