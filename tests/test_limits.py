"""호출 상한(growth/limits.py) 파일 저장·날짜 넘김·재시작 복원·동시성, /api/health 사용량. 실제 API 는 부르지 않는다."""
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from growth import contract as C  # noqa: E402
from growth import limits as L  # noqa: E402

DAY1 = datetime(2026, 11, 22, 23, 59, 30, tzinfo=L.KST)
DAY2 = DAY1 + timedelta(minutes=2)  # 한국 시간 자정을 넘김


@pytest.fixture
def usage_dir(tmp_path):
    d = tmp_path / "usage"
    L._reset_for_tests({}, usage_dir=d)
    return d


def restart(usage_dir, env=None):
    """서버를 다시 시작한 것처럼 메모리를 비우고 같은 폴더에서 다시 읽는다."""
    L._reset_for_tests(env or {}, usage_dir=usage_dir)


def read(usage_dir, day="2026-11-22"):
    return json.loads((usage_dir / f"{day}.json").read_text(encoding="utf-8"))


def test_usage_file_shape_and_restore_after_restart(usage_dir):
    r = L.reserve_many({L.LINER_SEARCH: 4, L.LINER_MODEL: 2}, now=DAY1)
    assert not (usage_dir / "2026-11-22.json").exists()  # 예약만으로는 쓰지 않는다
    r.settle({L.LINER_SEARCH: 3, L.LINER_MODEL: 1})
    L.use(L.NAVER_NEWS, 5, now=DAY1)
    L.take_refresh("1101110000000", now=DAY1)
    data = read(usage_dir)
    assert data["date"] == "2026-11-22" and set(data) == {"date", "apis", "refresh"}
    assert set(data["apis"]) == set(L.API_NAMES)  # 계약 12.2: {"apis": {이름: {"used": n}}}
    assert data["apis"][L.LINER_SEARCH] == {"used": 3} and data["apis"][L.NAVER_NEWS] == {"used": 5}
    assert data["refresh"] == {"1101110000000": 1}
    assert list(usage_dir.iterdir()) == [usage_dir / "2026-11-22.json"]  # 임시 파일이 남지 않는다

    held = L.reserve(L.LINER_MODEL, 10, now=DAY1)  # 예약 중인 수는 저장하지 않는다(재시작하면 사라진다)
    assert L.remaining(L.LINER_MODEL, now=DAY1) == 200 - 1 - 10
    restart(usage_dir)
    apis = L.usage_today(now=DAY1)["apis"]
    assert apis[L.LINER_SEARCH] == {"used": 3, "limit": 500, "remaining": 497}
    assert apis[L.LINER_MODEL] == {"used": 1, "limit": 200, "remaining": 199}
    assert apis[L.NAVER_NEWS]["used"] == 5 and L.refresh_remaining("1101110000000", now=DAY1) == 2
    L.use(L.NAVER_NEWS, now=DAY1)  # 이어서 센다
    assert read(usage_dir)["apis"][L.NAVER_NEWS] == {"used": 6}
    held.settle({})  # 이전 프로세스의 예약은 새 저장소에 영향이 없다(실제로는 사라지는 값)


def test_day_rolls_over_at_kst_midnight_and_keeps_yesterday_file(usage_dir):
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_LINER_PREMIUM": "2"}, usage_dir=usage_dir)
    L.reserve(L.LINER_PREMIUM, 2, now=DAY1).settle({L.LINER_PREMIUM: 2})
    with pytest.raises(L.LimitReached) as e:
        L.reserve(L.LINER_PREMIUM, 1, now=DAY1)
    assert e.value.retry_at_iso == "2026-11-23T00:00:00+09:00"
    # 한국 시간 0시를 넘기면 새 날: 0부터 센다. UTC 로는 아직 같은 날(15시)이어도 한국 날짜를 쓴다
    assert DAY2.astimezone(L.timezone.utc).date().isoformat() == "2026-11-22"
    assert L.usage_today(now=DAY2)["date"] == "2026-11-23" and L.remaining(L.LINER_PREMIUM, now=DAY2) == 2
    L.reserve(L.LINER_PREMIUM, 1, now=DAY2).settle({L.LINER_PREMIUM: 1})
    assert read(usage_dir)["apis"][L.LINER_PREMIUM] == {"used": 2}
    assert read(usage_dir, "2026-11-23")["apis"][L.LINER_PREMIUM] == {"used": 1}
    restart(usage_dir, {"GROWTH_DAILY_LIMIT_LINER_PREMIUM": "2"})
    assert L.remaining(L.LINER_PREMIUM, now=DAY1) == 0 and L.remaining(L.LINER_PREMIUM, now=DAY2) == 1


def test_reservation_made_before_midnight_settles_on_its_own_day(usage_dir):
    r = L.reserve(L.LINER_MODEL, 4, now=DAY1)
    assert L.remaining(L.LINER_MODEL, now=DAY2) == 200  # 새 날에는 어제 예약이 없다
    assert L.remaining(L.LINER_MODEL, now=DAY1) == 196  # 날이 바뀌어도 예약이 남은 날은 메모리에 남는다
    r.settle({L.LINER_MODEL: 3})  # 자정을 넘겨 끝나도 예약한 날에 센다
    assert read(usage_dir)["apis"][L.LINER_MODEL] == {"used": 3}
    assert not (usage_dir / "2026-11-23.json").exists()
    assert L.usage_today(now=DAY1)["apis"][L.LINER_MODEL] == {"used": 3, "limit": 200, "remaining": 197}


def test_reserve_settle_returns_unused_and_with_block_counts_everything(usage_dir):
    r = L.reserve_many({L.LINER_SEARCH: L.worst_case(2), L.LINER_MODEL: L.worst_case(1)}, now=DAY1)
    assert L.remaining(L.LINER_SEARCH, now=DAY1) == 496 and L.remaining(L.LINER_MODEL, now=DAY1) == 198
    r.settle({L.LINER_SEARCH: 1})
    assert L.remaining(L.LINER_SEARCH, now=DAY1) == 499 and L.remaining(L.LINER_MODEL, now=DAY1) == 200
    with L.reserve(L.LINER_SCHOLAR, 3, now=DAY1):
        pass  # 확정하지 않고 끝나면 잡은 수를 모두 쓴 것으로 센다
    assert read(usage_dir)["apis"][L.LINER_SCHOLAR] == {"used": 3}


def test_env_override_zero_blocks_and_none_unlimits(usage_dir):
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_LINER_MODEL": "0", "GROWTH_DAILY_LIMIT_OPENALEX": "none",
                        "GROWTH_DAILY_LIMIT_LINER_SEARCH": "abc"}, usage_dir=usage_dir)
    with pytest.raises(L.LimitReached):
        L.reserve(L.LINER_MODEL, 1, now=DAY1)
    for _ in range(3):
        L.use(L.OPENALEX, 1000, now=DAY1)
    apis = L.usage_today(now=DAY1)["apis"]
    assert apis[L.OPENALEX] == {"used": 3000, "limit": None, "remaining": None}
    assert apis[L.LINER_SEARCH]["limit"] == 500  # 읽지 못한 값은 기본 상한


def test_broken_usage_file_is_kept_aside_not_deleted(usage_dir):
    usage_dir.mkdir(parents=True)
    (usage_dir / "2026-11-22.json").write_text("{깨진", encoding="utf-8")
    assert L.remaining(L.LINER_SEARCH, now=DAY1) == 500
    L.use(L.NAVER_NEWS, now=DAY1)
    names = sorted(p.name for p in usage_dir.iterdir())
    assert names[0] == "2026-11-22.json" and names[1].startswith("2026-11-22.json.broken-")
    assert (usage_dir / names[1]).read_text(encoding="utf-8") == "{깨진"


def test_bad_values_in_file_are_ignored(usage_dir):
    usage_dir.mkdir(parents=True)
    (usage_dir / "2026-11-22.json").write_text(json.dumps({"date": "2026-11-22", "apis": {
        L.LINER_SEARCH: {"used": -5}, L.LINER_MODEL: {"used": "9"}, L.LINER_PREMIUM: {"used": True}, L.NAVER_NEWS: {"used": 7},
        "future.api": {"used": 2}}, "refresh": {"n-0123456789abcdef": 2, "x": -1}}), encoding="utf-8")
    apis = L.usage_today(now=DAY1)["apis"]
    assert [apis[a]["used"] for a in (L.LINER_SEARCH, L.LINER_MODEL, L.LINER_PREMIUM, L.NAVER_NEWS)] == [0, 0, 0, 7]
    assert L.refresh_remaining("n-0123456789abcdef", now=DAY1) == 1
    L.use(L.NAVER_NEWS, now=DAY1)
    assert read(usage_dir)["apis"]["future.api"] == {"used": 2}  # 모르는 이름도 지우지 않는다


def test_write_failure_keeps_counting_in_memory(usage_dir, monkeypatch):
    monkeypatch.setattr(L.os, "replace", lambda a, b: (_ for _ in ()).throw(OSError("disk")))
    L.use(L.NAVER_NEWS, 2, now=DAY1)
    assert L.usage_today(now=DAY1)["apis"][L.NAVER_NEWS]["used"] == 2
    assert not list(usage_dir.glob("*.tmp")) and not (usage_dir / "2026-11-22.json").exists()
    monkeypatch.undo()
    L.use(L.NAVER_NEWS, now=DAY1)  # 다음 쓰기에 전체를 쓰므로 빠짐이 없다
    assert read(usage_dir)["apis"][L.NAVER_NEWS] == {"used": 3}


def test_concurrent_reservations_never_exceed_daily_limit(usage_dir):
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_LINER_SEARCH": "50", "GROWTH_DAILY_LIMIT_NAVER_NEWS": "100"}, usage_dir=usage_dir)
    barrier = threading.Barrier(16)

    def work(i):
        barrier.wait()
        out = []
        for _ in range(10):
            try:
                r = L.reserve(L.LINER_SEARCH, 2, now=DAY1)
            except L.LimitReached:
                out.append("search-denied")
            else:
                r.settle({L.LINER_SEARCH: 1 + i % 2})  # 1 또는 2회 실제 사용
                out.append("search")
            try:
                L.use(L.NAVER_NEWS, now=DAY1)
                out.append("naver")
            except L.LimitReached:
                out.append("naver-denied")
        return out

    with ThreadPoolExecutor(16) as pool:
        results = [x for xs in pool.map(work, range(16)) for x in xs]
    apis = L.usage_today(now=DAY1)["apis"]
    assert apis[L.NAVER_NEWS]["used"] == 100 and results.count("naver") == 100  # 정확히 상한까지만
    assert apis[L.LINER_SEARCH]["used"] <= 50 and apis[L.LINER_SEARCH]["remaining"] == 50 - apis[L.LINER_SEARCH]["used"]
    restart(usage_dir, {"GROWTH_DAILY_LIMIT_LINER_SEARCH": "50"})  # 파일 값과 메모리 값이 같다
    assert L.usage_today(now=DAY1)["apis"][L.LINER_SEARCH]["used"] == apis[L.LINER_SEARCH]["used"]
    assert L.usage_today(now=DAY1)["apis"][L.NAVER_NEWS]["used"] == 100


def test_section_caps_stay_separate_for_search_and_premium(usage_dir):
    b = L.reserve_section("funding_history", now=DAY1)
    assert L.remaining(L.LINER_PREMIUM, now=DAY1) == 100 - L.worst_case(2)
    b.take_liner(L.LINER_SEARCH)
    with pytest.raises(L.LinerSectionLimit):
        b.take_liner(L.LINER_SEARCH)  # Premium 몫이 남아 있어도 일반 검색은 1회
    b.take_liner(L.LINER_PREMIUM, 2)
    assert b.settle({L.LINER_SEARCH: 1, L.LINER_PREMIUM: 3}) == {"search": 1, "premium": 3, "model": 0, "scholar": 0}
    assert read(usage_dir)["apis"][L.LINER_PREMIUM] == {"used": 3} and L.remaining(L.LINER_PREMIUM, now=DAY1) == 97


# ---------------------------------------------------------------- /api/health

def test_health_reports_usage_keys_and_contract_shape(usage_dir, monkeypatch):
    import api.main as api_main

    for k in ("DATA_GO_KR_SERVICE_KEY", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET", "OPENALEX_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(api_main.config, "ENV_FILE", usage_dir / "없는.env")
    monkeypatch.setattr(api_main.config, "resolve_api_key", lambda: ("secret-key-value-123", "env"))
    monkeypatch.setenv("DATA_GO_KR_SERVICE_KEY", "data-secret-value-456")
    monkeypatch.setenv("NAVER_CLIENT_ID", "naver-id-value")  # 비밀 값이 없으면 false
    L.reserve(L.LINER_SEARCH, 4).settle({L.LINER_SEARCH: 3})
    L.reserve(L.LINER_MODEL, 2).settle({L.LINER_MODEL: 1})
    L.use(L.NAVER_NEWS, 7)
    L.reserve(L.LINER_PREMIUM, 6)  # 예약 중은 remaining 에서만 빠진다
    res = TestClient(api_main.app).get("/api/health")
    body = res.json()
    TypeAdapter(C.HealthResponse).validate_python(body, strict=True)
    assert body["paidUsed"] == 4 and body["paidLimit"] == 1000
    assert body["keys"] == {"liner": True, "dataGoKr": True, "naver": False, "openalex": False}
    assert body["usage"]["apis"][L.NAVER_NEWS] == {"used": 7, "limit": 20000, "remaining": 19993}
    assert body["usage"]["apis"][L.LINER_PREMIUM] == {"used": 0, "limit": 100, "remaining": 94}
    assert body["analysis"] == {"running": 0, "maxRunning": 2} and body["contractVersion"] == 1
    assert "secret-key-value-123" not in res.text and "data-secret-value-456" not in res.text


def test_health_uses_analysis_running_count_when_provided(monkeypatch):
    import api.analysis as analysis_mod
    import api.main as api_main

    monkeypatch.setattr(analysis_mod, "running_count", lambda: 2, raising=False)
    assert TestClient(api_main.app).get("/api/health").json()["analysis"] == {"running": 2, "maxRunning": 2}
    monkeypatch.setattr(analysis_mod, "running_count", lambda: 1 / 0, raising=False)
    assert TestClient(api_main.app).get("/api/health").json()["analysis"]["running"] == 0
