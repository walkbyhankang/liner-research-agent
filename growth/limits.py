"""성장노트 호출 상한(계약 docs/contract.md 14절). 분석 코드(③)는 이 모듈의 공개 함수·클래스만 부른다.

세 겹으로 막는다.
1. 단락별 상한(SECTION_CAPS): 단락 한 번 실행 안에서 API별 최대 요청 수.
2. API별 하루 상한(DAILY_LIMITS): 서버 전체, 한국 시간 0시에 0부터 다시 센다.
3. 동시 요청 상한(CONCURRENCY): slot(api) 로 묶는다.

하루 사용량은 results/usage/<YYYY-MM-DD>.json(한국 날짜, 계약 12.2절)에 원자적 교체로 저장하고, 서버를 다시 시작하면 그날 파일에서
이어 센다. 예약 중인 수(held)는 저장하지 않는다(다시 시작하면 사라진다). 서버 프로세스 하나가 이 파일을 쓴다는 전제다
(uvicorn 을 --workers 여러 개로 띄우면 프로세스끼리 숫자를 나누지 않는다).
공개 이름(상수, LimitReached, LinerSectionLimit, reserve, reserve_many, reserve_section, SectionBudget, GuardedLinerClient, use, liner_used,
usage_today, remaining, next_reset, refresh_remaining, take_refresh, worst_case, slot)과 인자·예외는 바꾸지 않는다.

Liner 요청은 '최악의 경우'(자동 재시도까지 간 수, worst_case)만큼 미리 잡고, 끝나면 실제로 보낸 요청 수로 확정한다
(공고문 대조·운용사 요약·회사 조회도 api/main.py 에서 같은 방식으로 쓴다). 무료 API 는 요청을 보내기 직전에 use() 로 하나씩 센다.
"""
import json
import logging
import os
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config
from liner_client import MAX_AUTO_RETRIES, CallLimitExceeded, LinerClient

KST = timezone(timedelta(hours=9), "KST")
USAGE_DIR = config.RESULTS_DIR / "usage"   # 하루 사용량 파일 폴더(results/ 는 Git 에서 제외)
_log = logging.getLogger(__name__)

# ---------------------------------------------------------------- API 이름

LINER_SEARCH = "liner.search"          # 일반 웹 검색(include_knowledge=false)
LINER_PREMIUM = "liner.premium"        # Premium 검색(include_knowledge=true). liner.search 에는 세지 않는다
LINER_MODEL = "liner.model"
LINER_SCHOLAR = "liner.scholar"        # 학술 검색(growth 안의 자체 호출, 계약 16절)
DATAGOKR_FSC_CORP = "datagokr.fsc_corp"  # 금융위 기업기본정보
DATAGOKR_FSC_FIN = "datagokr.fsc_fin"    # 금융위 요약재무제표
DATAGOKR_NPS = "datagokr.nps"            # 국민연금 사업장(검색·상세·기간별 모두)
DATAGOKR_G2B = "datagokr.g2b"            # 조달청 나라장터 입찰공고
NAVER_NEWS = "naver.news"
OPENALEX = "openalex"
PATENTS_PAGE = "patents.page"            # Google Patents 공개 원문 한 쪽

API_NAMES: tuple[str, ...] = (LINER_SEARCH, LINER_PREMIUM, LINER_MODEL, LINER_SCHOLAR, DATAGOKR_FSC_CORP,
                              DATAGOKR_FSC_FIN, DATAGOKR_NPS, DATAGOKR_G2B, NAVER_NEWS, OPENALEX, PATENTS_PAGE)
LINER_APIS: tuple[str, ...] = (LINER_SEARCH, LINER_PREMIUM, LINER_MODEL, LINER_SCHOLAR)
REFRESH = "growth.refresh"               # 회사별 하루 새로 분석 횟수(LimitReached.api 에만 쓰는 이름)

# ---------------------------------------------------------------- 정책 표

# 하루 상한(초기값). None 은 상한 없음. Liner 값은 설계 6.4 확정값.
# 무료 API 값은 제공자 일일 한도를 확인하지 못해(계약 20절) 넉넉하게 잡은 값이다. 제공자 한도를 확인하면 그 이하로 내린다.
DAILY_LIMITS: dict[str, int | None] = {
    LINER_SEARCH: 500, LINER_PREMIUM: 100, LINER_MODEL: 200, LINER_SCHOLAR: 200,
    DATAGOKR_FSC_CORP: 9000, DATAGOKR_FSC_FIN: 9000, DATAGOKR_NPS: 9000, DATAGOKR_G2B: 9000,
    NAVER_NEWS: 20000, OPENALEX: 50000, PATENTS_PAGE: 3000,
}
# 환경변수로 덮어쓴다: GROWTH_DAILY_LIMIT_<API 이름을 대문자로, '.'은 '_'로> = 정수 또는 none
# 예: GROWTH_DAILY_LIMIT_LINER_SEARCH=300, GROWTH_DAILY_LIMIT_DATAGOKR_NPS=none, 0 이면 그 API 를 막는다.
ENV_PREFIX = "GROWTH_DAILY_LIMIT_"

# 단락 한 번 실행의 상한(요청 수). 여기 없는 API 는 0(그 단락에서 쓰지 못함). 무료 API 값은 자동 재시도까지 센 값이다.
SECTION_CAPS: dict[str, dict[str, int]] = {
    "identity": {DATAGOKR_FSC_CORP: 4},
    "official": {DATAGOKR_FSC_FIN: 4, DATAGOKR_NPS: 80},
    "profile": {LINER_SEARCH: 3, LINER_MODEL: 1},
    "facts": {LINER_SEARCH: 4, LINER_MODEL: 4, DATAGOKR_FSC_CORP: 12},
    "funding_history": {LINER_PREMIUM: 2, LINER_SEARCH: 1, LINER_MODEL: 1},
    "news": {LINER_SEARCH: 2, LINER_MODEL: 1, NAVER_NEWS: 40},
    "patents": {LINER_SEARCH: 2, PATENTS_PAGE: 30},
    "papers": {LINER_SCHOLAR: 12, LINER_MODEL: 1, OPENALEX: 60},
    "rivals_deep": {LINER_SEARCH: 1, LINER_MODEL: 3},   # 여기에 RIVAL_CAPS × 경쟁사 수를 더한다
    "sales": {DATAGOKR_G2B: 128},
}
# rivals_deep 의 경쟁사 한 곳당 더하는 상한. 5곳이면 Liner 검색 21·Premium 10·모델 3 = 34(설계 6.3)
RIVAL_CAPS: dict[str, int] = {LINER_SEARCH: 4, LINER_PREMIUM: 2, DATAGOKR_FSC_CORP: 4, DATAGOKR_FSC_FIN: 4,
                              DATAGOKR_NPS: 80, NAVER_NEWS: 6, PATENTS_PAGE: 30}
MAX_RIVALS = 5
PATENT_PAGES_PER_COMPANY = 30            # 특허 원문 확인 한도(회사 한 곳당)

# 동시 요청 상한(설계 6.4 3겹, 지금 research/common.LIMITS·research/liner.CONCURRENCY 값). 공공데이터포털 API 는 한 묶음으로 센다
CONCURRENCY: dict[str, int] = {"datagokr": 6, NAVER_NEWS: 3, OPENALEX: 3, LINER_SEARCH: 4, LINER_PREMIUM: 3,
                               LINER_SCHOLAR: 4, LINER_MODEL: 3, PATENTS_PAGE: 4}

REFRESH_PER_COMPANY_PER_DAY = 3          # 같은 회사 [새로 분석] 하루 횟수
MAX_RUNNING_ANALYSES = 2                 # 서버 전체 동시 분석 작업 수(설계 6.7)
RATE_LIMIT_PER_MINUTE = 6                # 접속 주소별 분당 요청 수(② 담당, 계약 2.12절)


def worst_case(planned: int) -> int:
    """계획한 요청이 모두 자동 재시도까지 갔을 때 실제로 나가는 요청 수."""
    return planned * (1 + MAX_AUTO_RETRIES)


def next_reset(now: datetime | None = None) -> datetime:
    """다음 하루 상한 초기화 시각(한국 시간 다음 날 0시)."""
    now = (now or datetime.now(KST)).astimezone(KST)
    return datetime(now.year, now.month, now.day, tzinfo=KST) + timedelta(days=1)


def _day(now: datetime | None) -> str:
    return (now or datetime.now(KST)).astimezone(KST).date().isoformat()


class LimitReached(Exception):
    """호출 상한에 닿아 요청하지 않았다.

    api: API 이름(API_NAMES 중 하나, 또는 REFRESH). scope: "daily"(하루 상한) / "section"(단락 상한) / "refresh"(새로 분석 횟수).
    limit·used: 그 상한과 그때까지 쓴 수(예약 포함). retry_at: 다시 할 수 있는 시각(daily·refresh 는 다음 날 0시, section 은 None).
    """

    def __init__(self, api: str, scope: str, limit: int, used: int, retry_at: datetime | None):
        self.api, self.scope, self.limit, self.used, self.retry_at = api, scope, limit, used, retry_at
        super().__init__(self.message)

    @property
    def message(self) -> str:
        """사용자에게 보여도 되는 문장(내부 이름·숫자 없음)."""
        if self.scope == "daily":
            return "오늘 호출 상한에 닿았습니다. 내일 0시 이후에 다시 할 수 있습니다."
        if self.scope == "refresh":
            return "이 회사는 오늘 새로 분석할 수 있는 횟수를 다 썼습니다. 내일 다시 시도하세요."
        return "이 단락에 정한 호출 수에 닿았습니다."

    @property
    def retry_at_iso(self) -> str | None:
        return self.retry_at.isoformat(timespec="seconds") if self.retry_at else None


class LinerSectionLimit(LimitReached, CallLimitExceeded):
    """Liner 요청이 단락 상한(scope="section")에 닿았다. take_liner() 가 낸다.

    LimitReached 이면서 liner_client.CallLimitExceeded 이기도 하다. 그래서 기존 엔진(pipeline, funding/)이
    LinerClient 자체 한도에 닿았을 때와 똑같이 기록만 하고 계속하며, growth 코드는 LimitReached 로 잡을 수 있다.
    """


def _env_limits(environ: dict | None) -> dict[str, int | None]:
    """DAILY_LIMITS 에 환경변수 덮어쓰기를 얹는다. 정수(0 이면 막음) 또는 none(상한 없음)만 받고, 그 밖의 값은 무시한다."""
    limits = dict(DAILY_LIMITS)
    env = os.environ if environ is None else environ
    for api in API_NAMES:
        name = ENV_PREFIX + api.upper().replace(".", "_")
        raw = str(env.get(name, "")).strip().lower()
        if raw == "none":
            limits[api] = None
        elif raw.isdigit():
            limits[api] = int(raw)
        elif raw:
            _log.warning("%s 값을 읽지 못해 기본 상한을 씁니다(정수 또는 none)", name)
    return limits


def _count(value) -> int | None:
    """파일에서 읽은 횟수. 0 이상의 정수만 받는다(bool 은 정수로 치지 않는다)."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


class _Day:
    """하루치 사용량. used(확정)·refresh(새로 분석 횟수)는 파일에 남기고, held(예약 중)는 메모리에만 둔다."""

    __slots__ = ("used", "held", "refresh")

    def __init__(self, used: dict[str, int] | None = None, refresh: dict[str, int] | None = None):
        self.used: dict[str, int] = dict(used or {})
        self.held: dict[str, int] = {}
        self.refresh: dict[str, int] = dict(refresh or {})


class _Limiter:
    """하루 사용량 저장소. 날짜(한국 시간)별로 used(확정)·held(예약 중)·refresh 를 센다.

    usage_dir 가 있으면 그날 파일(<usage_dir>/<YYYY-MM-DD>.json)에서 처음 읽어 이어 세고, used·refresh 가 바뀔 때마다
    파일 전체를 임시 파일에 쓴 뒤 os.replace 로 바꾼다(원자적 교체, 읽는 쪽이 쓰다 만 파일을 보지 않는다).
    usage_dir 가 None 이면 메모리에만 센다(테스트용). 모든 읽기·쓰기는 _lock 안에서 해서 동시 요청에서도 숫자가 어긋나지 않는다.
    """

    def __init__(self, environ: dict | None = None, usage_dir: Path | None = None):
        self._lock = threading.Lock()
        self._days: dict[str, _Day] = {}
        self.usage_dir = Path(usage_dir) if usage_dir is not None else None
        self.limits = _env_limits(environ)

    # ---------------------------------------------------------------- 파일

    def _path(self, day: str) -> Path:
        return self.usage_dir / f"{day}.json"

    def _load(self, day: str) -> _Day:
        """그날 파일을 읽는다. 없으면 0부터. 깨진 파일은 지우지 않고 옆으로 옮겨 두고 0부터 센다(경고를 남긴다)."""
        if self.usage_dir is None:
            return _Day()
        path = self._path(day)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return _Day()
        except (OSError, ValueError):
            data = None
        if not isinstance(data, dict) or data.get("date") != day:
            aside = path.with_name(f"{path.name}.broken-{datetime.now(KST):%H%M%S}")
            try:
                os.replace(path, aside)
            except OSError:
                pass
            _log.warning("하루 사용량 파일을 읽지 못해 옆으로 옮기고 0부터 셉니다: %s", aside.name)
            return _Day()
        apis = data.get("apis") if isinstance(data.get("apis"), dict) else {}
        used = {str(k): n for k, v in apis.items() if isinstance(v, dict) and (n := _count(v.get("used"))) is not None}
        refresh = data.get("refresh") if isinstance(data.get("refresh"), dict) else {}
        return _Day(used, {str(k): n for k, v in refresh.items() if (n := _count(v)) is not None})

    def _save(self, day: str) -> None:
        """_lock 을 잡은 상태에서만 부른다. 실패해도 메모리 숫자는 그대로 두고 다음 쓰기에서 다시 쓴다(전체를 쓰므로 빠짐이 없다)."""
        if self.usage_dir is None:
            return
        st = self._days[day]
        names = list(API_NAMES) + sorted(set(st.used) - set(API_NAMES))   # 모르는 이름도 지우지 않고 남긴다
        body = {"date": day, "apis": {api: {"used": st.used.get(api, 0)} for api in names},
                "refresh": dict(sorted(st.refresh.items()))}
        path = self._path(day)
        tmp = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(body, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, path)
            tmp = None
        except OSError:
            _log.warning("하루 사용량 파일을 쓰지 못했습니다(메모리 숫자로 계속 셉니다): %s", path.name)
        finally:
            if tmp is not None and os.path.exists(tmp):
                os.unlink(tmp)

    def _state(self, day: str) -> _Day:
        """_lock 을 잡은 상태에서만 부른다. 그날 상태가 메모리에 없으면 파일에서 읽는다.
        파일에 저장할 때는 예약이 남지 않은 다른 날 상태를 메모리에서 내린다(파일이 기준이라 다시 필요하면 다시 읽는다)."""
        st = self._days.get(day)
        if st is None:
            st = self._days[day] = self._load(day)
            if self.usage_dir is not None:
                for other in [d for d, s in self._days.items() if d != day and not any(s.held.values())]:
                    del self._days[other]
        return st

    # ---------------------------------------------------------------- 세기

    def _check(self, st: _Day, api: str, n: int, now: datetime | None) -> None:
        """_lock 을 잡은 상태에서만 부른다."""
        limit = self.limits.get(api)
        if limit is None:
            return
        taken = st.used.get(api, 0) + st.held.get(api, 0)
        if taken + n > limit:
            raise LimitReached(api, "daily", limit, taken, next_reset(now))

    def hold(self, plan: dict[str, int], now: datetime | None) -> str:
        """plan 의 API별 수를 한 번에 잡는다. 하나라도 넘으면 아무것도 잡지 않고 LimitReached. 예약은 파일에 쓰지 않는다."""
        day = _day(now)
        with self._lock:
            st = self._state(day)
            for api, n in plan.items():
                if n > 0:
                    self._check(st, api, n, now)
            for api, n in plan.items():
                if n > 0:
                    st.held[api] = st.held.get(api, 0) + n
        return day

    def settle(self, day: str, plan: dict[str, int], used: dict[str, int]) -> None:
        """예약한 날(day)의 예약을 풀고 실제 수를 확정한다. 자정을 넘겨 확정해도 예약한 날에 센다(그날 몫으로 잡아 둔 수다)."""
        with self._lock:
            st = self._state(day)
            for api, n in plan.items():
                if n > 0:
                    st.held[api] = max(0, st.held.get(api, 0) - n)
            changed = False
            for api, n in used.items():
                if n > 0:
                    st.used[api] = st.used.get(api, 0) + n
                    changed = True
            if changed:
                self._save(day)

    def use(self, api: str, n: int, now: datetime | None) -> None:
        day = _day(now)
        with self._lock:
            st = self._state(day)
            self._check(st, api, n, now)
            if n > 0:
                st.used[api] = st.used.get(api, 0) + n
                self._save(day)

    def usage(self, now: datetime | None) -> dict:
        day = _day(now)
        with self._lock:
            st = self._state(day)
            apis = {}
            for api in API_NAMES:
                used, held, limit = st.used.get(api, 0), st.held.get(api, 0), self.limits.get(api)
                apis[api] = {"used": used, "limit": limit, "remaining": None if limit is None else max(0, limit - used - held)}
        return {"date": day, "resetAt": next_reset(now).isoformat(timespec="seconds"), "apis": apis}

    def remaining(self, api: str, now: datetime | None) -> int | None:
        return self.usage(now)["apis"][api]["remaining"]

    def refresh_used(self, company_id: str, now: datetime | None) -> int:
        with self._lock:
            return self._state(_day(now)).refresh.get(company_id, 0)

    def take_refresh(self, company_id: str, now: datetime | None) -> None:
        day = _day(now)
        with self._lock:
            st = self._state(day)
            n = st.refresh.get(company_id, 0)
            if n >= REFRESH_PER_COMPANY_PER_DAY:
                raise LimitReached(REFRESH, "refresh", REFRESH_PER_COMPANY_PER_DAY, n, next_reset(now))
            st.refresh[company_id] = n + 1
            self._save(day)


_limiter = _Limiter(usage_dir=USAGE_DIR)
_slots = {k: threading.BoundedSemaphore(v) for k, v in CONCURRENCY.items()}


class Reservation:
    """미리 잡은 요청 수. settle(used) 로 실제 수를 확정하면 남은 예약은 돌려준다. 두 번째 settle 은 무시한다.

    with 문으로 쓰면, settle 하지 않고 끝났을 때 잡은 수를 모두 쓴 것으로 확정한다(덜 세는 일이 없게).
    """

    def __init__(self, plan: dict[str, int], day: str):
        self.plan = {k: v for k, v in plan.items() if v > 0}
        self.day = day
        self.settled = False

    def settle(self, used: dict[str, int]) -> None:
        """used: API 이름 → 실제로 보낸 요청 수. 예약하지 않은 API 의 수도 사용량에 더한다(덜 세지 않게)."""
        if self.settled:
            return
        self.settled = True
        bad = set(used) - set(API_NAMES)
        if bad:
            raise ValueError(f"모르는 API: {sorted(bad)}")
        _limiter.settle(self.day, self.plan, {k: int(v) for k, v in used.items()})

    def release(self) -> None:
        """하나도 보내지 않았을 때."""
        self.settle({})

    def __enter__(self) -> "Reservation":
        return self

    def __exit__(self, *exc) -> None:
        if not self.settled:
            self.settle(dict(self.plan))


def reserve(api: str, n: int, *, now: datetime | None = None) -> Reservation:
    """API 하나에 n회를 미리 잡는다(n 은 보통 worst_case(계획 수)). 하루 상한을 넘으면 LimitReached(scope="daily")."""
    return reserve_many({api: n}, now=now)


def reserve_many(plan: dict[str, int], *, now: datetime | None = None) -> Reservation:
    """여러 API 를 한 번에 잡는다. 하나라도 넘으면 아무것도 잡지 않는다."""
    bad = set(plan) - set(API_NAMES)
    if bad:
        raise ValueError(f"모르는 API: {sorted(bad)}")
    day = _limiter.hold(plan, now)
    return Reservation(plan, day)


def use(api: str, n: int = 1, *, now: datetime | None = None) -> None:
    """요청을 보내기 직전에 하루 사용량을 n 늘린다(무료 API 용). 넘으면 늘리지 않고 LimitReached(scope="daily")."""
    if api not in API_NAMES:
        raise ValueError(f"모르는 API: {api}")
    _limiter.use(api, n, now)


def section_caps(section: str, *, rivals: int = 0) -> dict[str, int]:
    """단락 한 번 실행의 API별 상한. rivals_deep 은 경쟁사 수(1~5)만큼 RIVAL_CAPS 를 더한다."""
    caps = dict(SECTION_CAPS[section])
    if section == "rivals_deep":
        if not 1 <= rivals <= MAX_RIVALS:
            raise ValueError("경쟁사는 1~5곳")
        for api, n in RIVAL_CAPS.items():
            caps[api] = caps.get(api, 0) + n * rivals
    return caps


class SectionBudget:
    """단락 한 번 실행의 예산. reserve_section() 으로 만든다.

    - Liner(검색·Premium·모델·학술)는 만들 때 worst_case(상한)만큼 하루 사용량에 잡아 둔다.
    - Liner 요청은 budget.liner_client(key, source) 로 만든 클라이언트로 보낸다. 요청마다 take_liner() 가 API별 단락 상한
      (일반 검색과 Premium 을 따로)을 세고, LinerClient 한도는 뒷받침으로 둔다. 학술 검색은 요청마다 take_liner(LINER_SCHOLAR).
    - 무료 API 는 요청 직전에 budget.use(api) 를 부른다(단락 상한과 하루 상한을 함께 센다).
    - 끝나면(성공·실패 모두) settle(liner_used(client.calls) | {LINER_SCHOLAR: 학술 요청 수}) 를 한 번 부른다.
    """

    def __init__(self, section: str, caps: dict[str, int], reservation: Reservation):
        self.section = section
        self.caps = caps
        self.reservation = reservation
        self._free_used: dict[str, int] = {}
        self._liner_taken: dict[str, int] = {}
        self._lock = threading.Lock()

    def liner_client_limits(self) -> dict[str, int]:
        """LinerClient(limits=...) 에 넘길 값(뒷받침용). LinerClient 는 Premium 을 검색 한도에도 세므로 search 에 premium 을 더한다.
        이 값만으로는 일반 검색이 Premium 몫까지 쓸 수 있으므로, API별 단락 상한은 take_liner() 가 따로 센다(liner_client() 가 대신 부른다).
        원래 LinerClient 의 키(search, model, agent, premium)만 쓴다(학술 검색 키는 넣지 않는다, 계약 16절)."""
        p = self.caps.get(LINER_PREMIUM, 0)
        return {"search": self.caps.get(LINER_SEARCH, 0) + p, "premium": p, "model": self.caps.get(LINER_MODEL, 0), "agent": 0}

    def scholar_limit(self) -> int:
        return self.caps.get(LINER_SCHOLAR, 0)

    def take_liner(self, api: str, n: int = 1) -> None:
        """Liner 요청 하나(논리 호출 하나, 자동 재시도는 그 안에서 센다)를 보내기 직전에 부른다.

        API별 단락 상한(일반 검색과 Premium 을 따로)을 넘으면 보내지 않고 LinerSectionLimit(LimitReached·CallLimitExceeded, scope="section").
        liner_client() 로 만든 클라이언트는 search_web·chat_json·responses 앞에서 스스로 부른다.
        growth 의 학술 검색 클라이언트는 요청마다 take_liner(LINER_SCHOLAR) 를 부른다.
        """
        if api not in LINER_APIS:
            raise ValueError("무료 API 는 use() 로 센다")
        with self._lock:
            cap, done = self.caps.get(api, 0), self._liner_taken.get(api, 0)
            if done + n > cap:
                raise LinerSectionLimit(api, "section", cap, done, None)
            self._liner_taken[api] = done + n

    def liner_remaining(self, api: str) -> int:
        """이 단락에서 그 Liner API 를 더 부를 수 있는 논리 호출 수."""
        with self._lock:
            return max(0, self.caps.get(api, 0) - self._liner_taken.get(api, 0))

    def liner_client(self, api_key: str, key_source: str | None = None, **kwargs) -> "GuardedLinerClient":
        """이 단락용 LinerClient. 단락의 Liner 요청은 모두 이것으로 보낸다(계약 14.3절).
        kwargs 는 LinerClient 에 그대로 넘긴다(테스트의 transport 등). limits 는 이 예산이 정한다."""
        return GuardedLinerClient(LinerClient(api_key, key_source, limits=self.liner_client_limits(), **kwargs), self)

    def use(self, api: str, n: int = 1, *, now: datetime | None = None) -> None:
        """무료 API 요청 직전에 부른다. 단락 상한을 넘으면 LimitReached(scope="section"), 하루 상한이면 scope="daily"."""
        if api in LINER_APIS:
            raise ValueError("Liner 요청은 take_liner()·settle() 로 센다")
        with self._lock:
            cap, done = self.caps.get(api, 0), self._free_used.get(api, 0)
            if done + n > cap:
                raise LimitReached(api, "section", cap, done, None)
            use(api, n, now=now)
            self._free_used[api] = done + n

    def settle(self, used: dict[str, int]) -> dict[str, int]:
        """Liner 실제 요청 수로 확정하고, 단락 봉투의 paid 값({"search","premium","model","scholar"})을 돌려준다."""
        bad = set(used) - set(LINER_APIS)
        if bad:
            raise ValueError(f"settle 에는 Liner API 만 넣는다: {sorted(bad)}")
        liner = {api: int(used.get(api, 0)) for api in LINER_APIS}
        self.reservation.settle(liner)
        return {"search": liner[LINER_SEARCH], "premium": liner[LINER_PREMIUM], "model": liner[LINER_MODEL],
                "scholar": liner[LINER_SCHOLAR]}

    def __enter__(self) -> "SectionBudget":
        return self

    def __exit__(self, *exc) -> None:
        self.reservation.__exit__(*exc)


class GuardedLinerClient:
    """LinerClient 를 감싸 요청마다 SectionBudget.take_liner() 를 먼저 부른다. 나머지(calls, usage, close …)는 그대로 넘긴다.

    remaining(kind) 은 LinerClient 의 남은 수와 이 단락의 API별 남은 수 중 작은 값이다(pipeline 이 검색 계획에 쓴다).
    """

    def __init__(self, client: LinerClient, budget: SectionBudget):
        self._client = client
        self._budget = budget

    def search_web(self, query: str, *, include_knowledge: bool | None = None, **kwargs):
        premium = config.INCLUDE_KNOWLEDGE if include_knowledge is None else bool(include_knowledge)
        self._budget.take_liner(LINER_PREMIUM if premium else LINER_SEARCH)
        return self._client.search_web(query, include_knowledge=include_knowledge, **kwargs)

    def chat_json(self, *args, **kwargs):
        self._budget.take_liner(LINER_MODEL)
        return self._client.chat_json(*args, **kwargs)

    def responses(self, *args, **kwargs):
        self._budget.take_liner(LINER_MODEL)
        return self._client.responses(*args, **kwargs)

    def remaining(self, kind: str) -> int:
        api = {"search": LINER_SEARCH, "premium": LINER_PREMIUM, "model": LINER_MODEL}.get(kind)
        left = self._client.remaining(kind)
        return left if api is None else min(left, self._budget.liner_remaining(api))

    def __getattr__(self, name: str):
        return getattr(self._client, name)


def reserve_section(section: str, *, rivals: int = 0, now: datetime | None = None) -> SectionBudget:
    """단락을 시작하기 전에 부른다. Liner 하루 상한이 모자라면 LimitReached(scope="daily") — 단락을 미확보(daily_limit)로 끝낸다."""
    caps = section_caps(section, rivals=rivals)
    plan = {api: worst_case(caps[api]) for api in LINER_APIS if caps.get(api, 0) > 0}
    return SectionBudget(section, caps, reserve_many(plan, now=now))


def liner_used(calls: list[dict]) -> dict[str, int]:
    """LinerClient.calls(시도마다 한 줄, 자동 재시도 포함) → {LINER_SEARCH, LINER_PREMIUM, LINER_MODEL: 요청 수}."""
    out = {LINER_SEARCH: 0, LINER_PREMIUM: 0, LINER_MODEL: 0}
    for c in calls:
        kind = c.get("kind")
        if kind == "search":
            out[LINER_PREMIUM if c.get("include_knowledge") else LINER_SEARCH] += 1
        elif kind == "model":
            out[LINER_MODEL] += 1
    return out


def usage_today(*, now: datetime | None = None) -> dict:
    """GET /api/health 의 usage 값(계약 2.11절): {"date", "resetAt", "apis": {api: {"used", "limit", "remaining"}}}.
    used 는 확정된 수, remaining 은 상한 − 확정 − 예약 중인 수(상한이 없으면 None)."""
    return _limiter.usage(now)


def remaining(api: str, *, now: datetime | None = None) -> int | None:
    return _limiter.remaining(api, now)


def refresh_remaining(company_id: str, *, now: datetime | None = None) -> int:
    """이 회사를 오늘 더 새로 분석할 수 있는 횟수(작업 응답 refresh.remainingToday)."""
    return max(0, REFRESH_PER_COMPANY_PER_DAY - _limiter.refresh_used(company_id, now))


def take_refresh(company_id: str, *, now: datetime | None = None) -> None:
    """[새로 분석] 한 번을 센다. 다 썼으면 LimitReached(api=REFRESH, scope="refresh") — POST /api/analysis 가 429 refresh_limit."""
    _limiter.take_refresh(company_id, now)


def slot(api: str) -> threading.BoundedSemaphore:
    """동시 요청 상한. with limits.slot(limits.NAVER_NEWS): ... 공공데이터포털 API 는 모두 같은 묶음("datagokr")."""
    return _slots["datagokr" if api.startswith("datagokr.") else api]


def _reset_for_tests(environ: dict | None = None, *, usage_dir: Path | None = None) -> None:
    """테스트용: 사용량을 모두 지우고 환경변수 덮어쓰기를 다시 읽는다.
    usage_dir 를 주면 그 폴더의 파일에 이어 세고(재시작 흉내), 주지 않으면 메모리에만 센다(실제 results/usage 를 건드리지 않는다)."""
    global _limiter
    _limiter = _Limiter(environ, usage_dir=usage_dir)
