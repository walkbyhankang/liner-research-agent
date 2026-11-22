"""성장노트 분석 서버. 실행: .venv/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8000

화면(web)이 이 서버에 공고 자격 대조·운용사 요약·회사 분석을 요청한다. API 키는 서버에만 있고 응답에 넣지 않는다.
유료 호출은 growth.limits 의 API별 하루 상한(results/usage/<한국 날짜>.json 에 이어 셈)을 넘지 않는다.
요청마다 최악의 경우(자동 재시도까지 간 수)만큼 미리 잡고, 끝나면 실제로 보낸 요청 수(재시도 포함)로 확정한다.
접속 주소별 요청 제한(계약 2.12)과 오류 본문 모양(계약 3절)도 여기서 맞춘다.
"""
from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import dotenv_values
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
from funding import company as company_mod  # noqa: E402
from funding import gp as gp_mod  # noqa: E402
from funding import profile as profile_mod  # noqa: E402
from funding import service  # noqa: E402
from growth import limits  # noqa: E402
from growth.contract import CONTRACT_VERSION  # noqa: E402
from liner_client import CallLimitExceeded, LinerAPIError, LinerClient  # noqa: E402
from api.analysis import router as analysis_router  # noqa: E402
from api.analysis import error  # noqa: E402

SNAPSHOT = ROOT / "web" / "public" / "data" / "programs.json"
FUNDS_SNAPSHOT = ROOT / "web" / "public" / "data" / "funds.json"
CACHE_DIR = config.RESULTS_DIR / "cache" / "notice"
_log = logging.getLogger(__name__)

app = FastAPI(title="성장노트 API")
# 화면을 띄우는 주소. 기본은 Next.js 기본 포트(3000)와 이 프로젝트에서 쓰는 3100 이고, FUNDING_WEB_ORIGINS 로 바꿀 수 있다.
WEB_ORIGINS = [o.strip() for o in os.environ.get(
    "FUNDING_WEB_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3100,http://127.0.0.1:3100").split(",") if o.strip()]


# ---------------------------------------------------------------- 접속 주소별 요청 제한 (계약 2.12)

RATE_LIMITED_POSTS = re.compile(r"^/api/(analysis|analysis/[^/]+/sections/[^/]+|notice/analyze|gp/brief)/?$")
RATE_WINDOW_SEC = 60.0
RATE_LIMIT_MESSAGE = "요청이 잠시 많았습니다. 1분 뒤 다시 눌러 주세요."


def _rate_limit_from_env() -> int:
    raw = os.environ.get("GROWTH_RATE_LIMIT_PER_MINUTE", "").strip()
    return int(raw) if raw.isdigit() else limits.RATE_LIMIT_PER_MINUTE


class _RateLimiter:
    """접속 주소마다 최근 60초 안에 받아들인 요청 시각을 센다. 거절한 요청은 세지 않는다."""

    def __init__(self, per_minute: int, clock=time.monotonic):
        self.per_minute = per_minute
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> bool:
        now = self._clock()
        with self._lock:
            if len(self._hits) > 1000:  # 오래된 주소를 지워 메모리가 끝없이 늘지 않게 한다
                for k in [k for k, q in self._hits.items() if not q or q[-1] <= now - RATE_WINDOW_SEC]:
                    del self._hits[k]
            q = self._hits.setdefault(key, deque())
            while q and q[0] <= now - RATE_WINDOW_SEC:
                q.popleft()
            if len(q) >= self.per_minute:
                return False
            q.append(now)
            return True

    def reset(self, per_minute: int | None = None, clock=None) -> None:
        """기록을 지운다(테스트용). per_minute 가 None 이면 환경변수·기본값을 다시 읽는다."""
        with self._lock:
            self._hits.clear()
            self.per_minute = _rate_limit_from_env() if per_minute is None else per_minute
            self._clock = clock or time.monotonic


_rate_limiter = _RateLimiter(_rate_limit_from_env())


def _ip_key(raw: str) -> str | None:
    """주소 글을 비교용 열쇠로. IPv4 대응 IPv6 는 IPv4 로, IPv6 는 /64 로 묶는다(한 가입자가 주소를 바꿔 가며 넘지 못하게)."""
    s = raw.strip().strip('"')
    if s.startswith("[") and "]" in s:      # [2001:db8::1]:1234
        s = s[1:s.index("]")]
    elif s.count(":") == 1:                  # 1.2.3.4:5678
        s = s.split(":", 1)[0]
    try:
        ip = ipaddress.ip_address(s)
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip.version == 6:
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def client_key(headers, client_host: str | None) -> str:
    """접속 주소: x-forwarded-for 의 맨 뒤 값(믿을 수 있는 마지막 프록시가 붙인 값), 없거나 주소 모양이 아니면 연결 주소.
    맨 앞 값은 접속자가 머리글을 직접 넣어 속일 수 있으므로 쓰지 않는다(계약 2.12)."""
    values = [v.strip() for h in headers.getlist("x-forwarded-for") for v in h.split(",") if v.strip()]
    if values:
        key = _ip_key(values[-1])
        if key:
            return key
    return _ip_key(client_host or "") or (client_host or "unknown")


class RateLimitMiddleware:
    """네 POST 경로(분석 시작, 단락 실행, 공고문 대조, 운용사 요약)를 합쳐 주소마다 분당 횟수를 넘으면 429 rate_limited.
    요청 본문 검사(422)·다른 판정보다 먼저 한다(계약 2.2 표 1번)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] == "POST" and RATE_LIMITED_POSTS.match(scope["path"]):
            req = Request(scope)
            if not _rate_limiter.hit(client_key(req.headers, req.client.host if req.client else None)):
                retry = (datetime.now(limits.KST) + timedelta(seconds=RATE_WINDOW_SEC)).isoformat(timespec="seconds")
                res = error(429, "rate_limited", RATE_LIMIT_MESSAGE, retry)
                res.headers["Retry-After"] = str(int(RATE_WINDOW_SEC))
                await res(scope, receive, send)
                return
        await self.app(scope, receive, send)


# 나중에 더한 미들웨어가 바깥에 선다. CORS 가 가장 바깥이어야 429 응답에도 CORS 머리글이 붙는다.
app.add_middleware(RateLimitMiddleware)
app.add_middleware(CORSMiddleware, allow_origins=WEB_ORIGINS,
                   allow_methods=["GET", "POST"], allow_headers=["content-type"])
app.include_router(analysis_router)


# ---------------------------------------------------------------- 오류 본문 (계약 3절)

HTTP_CODES = {400: "bad_request", 404: "not_found", 405: "not_found", 409: "conflict", 413: "bad_request",
              429: "rate_limited", 501: "not_implemented", 502: "upstream_error", 503: "missing_config",
              504: "upstream_error"}
DEFAULT_DETAIL = {"bad_request": "요청이 올바르지 않습니다", "not_found": "없는 경로입니다", "conflict": "지금은 처리할 수 없는 요청입니다",
                  "rate_limited": RATE_LIMIT_MESSAGE, "not_implemented": "아직 준비되지 않은 기능입니다",
                  "upstream_error": "바깥 자료에 연결하지 못했습니다", "missing_config": "서버 설정이 되어 있지 않습니다",
                  "internal": "서버에서 오류가 났습니다. 잠시 뒤 다시 시도해 주세요."}


@app.exception_handler(StarletteHTTPException)
async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """HTTPException 도 {detail, code, retryAt} 모양으로. FastAPI 기본 영어 문구(Not Found 등)는 우리말 기본 문장으로 바꾼다."""
    code = HTTP_CODES.get(exc.status_code, "internal" if exc.status_code >= 500 else "bad_request")
    detail = exc.detail if isinstance(exc.detail, str) and re.search(r"[가-힣]", exc.detail) else DEFAULT_DETAIL[code]
    res = error(exc.status_code, code, detail)
    for k, v in (getattr(exc, "headers", None) or {}).items():
        res.headers[k] = v
    return res


@app.exception_handler(Exception)
async def _internal_error(request: Request, exc: Exception) -> JSONResponse:
    """잡지 못한 오류. 예외 이름·내용·경로는 응답에 넣지 않는다(서버 로그에만 남는다)."""
    _log.error("처리하지 못한 오류(%s %s): %s", request.method, request.url.path, type(exc).__name__)
    return error(500, "internal", DEFAULT_DETAIL["internal"])


def _limit_error(e: limits.LimitReached) -> JSONResponse:
    """하루 상한에 닿음 → 429 daily_limit, retryAt 다음 날 0시(한국 시간)."""
    return error(429, "daily_limit", e.message, e.retry_at_iso)


def _upstream_error(e: LinerAPIError) -> JSONResponse:
    """Liner 응답 실패 → 502. 바깥 응답 글·예외 이름은 넣지 않고 HTTP 상태만 덧붙인다."""
    status = f"(HTTP {e.status})" if isinstance(e.status, int) else ""
    return error(502, "upstream_error", f"Liner에서 응답을 받지 못했습니다{status}. 잠시 뒤 다시 시도해 주세요.")


NO_LINER_KEY = "서버에 Liner 설정이 되어 있지 않습니다"


# ---------------------------------------------------------------- 공고문 대조

_lock = threading.Lock()
_programs: dict[str, dict] | None = None
_funds_by_gp: dict[str, list[dict]] | None = None


class Company(BaseModel):
    name: str = Field("", max_length=60)
    region: str = Field("", max_length=20)
    biz: str = Field("", max_length=20)
    founded: str = Field("", max_length=7, pattern=r"^(\d{4}-\d{2})?$")
    industry: str = Field("", max_length=80)
    employees: str = Field("", max_length=30)
    revenue: str = Field("", max_length=60)
    need: str = Field("", max_length=120)
    notes: str = Field("", max_length=400)


class AnalyzeRequest(BaseModel):
    programId: str = Field(pattern=r"^[A-Za-z0-9_]{6,40}$")
    company: Company


def programs() -> dict[str, dict]:
    global _programs
    if _programs is None:
        _programs = {p["id"]: p for p in json.loads(SNAPSHOT.read_text(encoding="utf-8"))}
    return _programs


def paid_used(client: LinerClient) -> dict[str, int]:
    """이 클라이언트가 실제로 보낸 Liner 요청 수(자동 재시도 포함) → 하루 상한에 확정할 값."""
    return limits.liner_used(client.calls)


def _env_present(*names: str) -> bool:
    """키가 있는지만 본다(값은 응답에 넣지 않는다). 환경변수 → 이 프로젝트 .env 순서."""
    file_env = dotenv_values(config.ENV_FILE) if config.ENV_FILE.is_file() else {}
    return all((os.environ.get(n) or file_env.get(n) or "").strip() for n in names)


def _running_analyses() -> int:
    """진행 중 분석 작업 수(계약 2.11 analysis.running). 작업 저장소는 ③ 담당이라, api.analysis 가 running_count() 를 내놓으면 그 값을 쓴다."""
    import api.analysis as analysis_mod

    counter = getattr(analysis_mod, "running_count", None)
    try:
        return max(0, int(counter())) if callable(counter) else 0
    except Exception:  # 상태 확인이 서버 상태 응답을 깨뜨리지 않게
        return 0


@app.get("/api/health")
def health() -> dict:
    """서버 상태와 오늘 사용량(계약 2.11). paidUsed·paidLimit 는 Liner 4종(검색·Premium·모델·학술)의 오늘 확정 사용 합·하루 상한 합."""
    key, _ = config.resolve_api_key()
    usage = limits.usage_today()
    liner = [usage["apis"][api] for api in limits.LINER_APIS]
    return {"ok": True, "hasKey": bool(key),
            "paidUsed": sum(u["used"] for u in liner),
            "paidLimit": sum(u["limit"] for u in liner if u["limit"] is not None),  # 상한 없음(none)인 종류는 합에서 뺀다
            "extractModel": service.EXTRACT_MODEL, "matchModel": service.MATCH_MODEL,
            "keys": {"liner": bool(key), "dataGoKr": _env_present("DATA_GO_KR_SERVICE_KEY"),
                     "naver": _env_present("NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"), "openalex": _env_present("OPENALEX_API_KEY")},
            "usage": usage,
            "analysis": {"running": _running_analyses(), "maxRunning": limits.MAX_RUNNING_ANALYSES},
            "contractVersion": CONTRACT_VERSION}


@app.post("/api/notice/analyze", response_model=None)
def analyze(req: AnalyzeRequest) -> dict | JSONResponse:
    """공고문 자격 대조(계약 2.9). 모델 호출만 쓴다: 저장된 추출이 있으면 1회(대조), 없으면 2회(추출·대조)."""
    program = programs().get(req.programId)
    if program is None:
        return error(404, "not_found", "스냅샷에 없는 공고입니다")
    key, source = config.resolve_api_key()
    if not key:
        return error(503, "missing_config", NO_LINER_KEY)
    cached = service.load_extraction(CACHE_DIR, program) is not None
    planned = 1 if cached else 2
    try:
        reservation = limits.reserve(limits.LINER_MODEL, limits.worst_case(planned))
    except limits.LimitReached as e:
        return _limit_error(e)
    with reservation:  # 클라이언트를 만들다 실패하면 잡은 수를 모두 쓴 것으로 센다(덜 세지 않게)
        client = LinerClient(key, source, limits={"model": planned, "search": 0, "agent": 0, "premium": 0})
        try:
            extraction = service.extract_notice(program, client, CACHE_DIR)
            match = service.match_company(extraction, company_mod.describe(req.company.model_dump()), client)
        except service.AnalysisError as e:
            return error(422, "analysis_failed", str(e))
        except CallLimitExceeded:  # 이 요청에 잡은 호출 수를 넘으려 함(정상 흐름에서는 일어나지 않음). 하루 상한과는 다르다
            return error(500, "internal", "정한 호출 수 안에서 대조를 끝내지 못했습니다. 다시 시도해 주세요.")
        except LinerAPIError as e:
            return _upstream_error(e)
        finally:
            reservation.settle(paid_used(client))
            client.close()
    return {
        "program": {"id": program["id"], "title": program["title"], "url": program["url"], "docUrl": program["docUrl"]},
        "extraction": {k: extraction[k] for k in ("summary", "notStated", "doc", "model", "extractedAt", "dropped", "cached")},
        "match": match,
    }


class LookupRequest(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    homepage: str = Field("", max_length=100, pattern=r"^[A-Za-z0-9.\-]*$")


LOOKUP_SEARCHES, LOOKUP_MODELS = 10, 5  # 엔진 검색 4·모델 4, 경쟁사 조사 검색 6(경쟁사 3곳 × 투자·규모)·모델 1


# 회사 조회는 2분 넘게 걸린다. 요청을 붙잡아 두지 않고 작업을 시작해 번호를 돌려준 뒤, 화면이 진행 상황을 묻게 한다.
# 연결이 끊겨도 이미 쓴 유료 호출의 결과가 버려지지 않는다. 작업 기록은 서버 메모리에만 있고 일정 시간 뒤 지운다.
JOB_TTL_SEC = 15 * 60
MAX_RUNNING_LOOKUPS = 2
_jobs: dict[str, dict] = {}


def stage_label(message: str) -> str:
    """엔진이 알려주는 진행 문구를 화면용 단계 이름으로 바꾼다."""
    if message.startswith("Search API"):
        return "보도·공식 자료 검색"
    if message.startswith("원문 확인"):
        return "원문 확인"
    if message.startswith("Model API"):
        return "회사 정보·기존 투자자·경쟁사 추출"
    if message.startswith("경쟁사 투자"):
        return "경쟁사 투자 이력·규모 조회"
    return "조회 중"


def _prune_jobs(now: float) -> None:
    for job_id in [k for k, j in _jobs.items() if j["finishedAt"] and now - j["finishedAt"] > JOB_TTL_SEC]:
        del _jobs[job_id]


def _run_lookup(job: dict, name: str, homepage: str, key: str, source: str | None,
                reservation: limits.Reservation) -> None:
    with reservation:
        client = LinerClient(key, source, limits={"search": LOOKUP_SEARCHES, "model": LOOKUP_MODELS, "agent": 0, "premium": 0})
        try:
            out = profile_mod.lookup(name, client, homepage=homepage, progress=lambda msg: job.update(stage=stage_label(msg)))
            elapsed = round(sum(c.get("elapsed_sec") or 0 for c in client.calls), 1)
            job.update(status="done", result={**out, "query": name, "apiSeconds": elapsed})
        except profile_mod.ProfileError as e:
            job.update(status="error", error=str(e))
        except LinerAPIError as e:
            status = f"(HTTP {e.status})" if isinstance(e.status, int) else ""
            job.update(status="error", error=f"Liner에서 응답을 받지 못했습니다{status}. 잠시 뒤 다시 시도해 주세요.")
        except Exception:  # 작업 스레드에서 난 오류는 요청으로 올라가지 않으므로 여기서 상태로 남긴다(예외 이름·내용은 넣지 않는다)
            _log.exception("회사 조회 작업 오류")
            job.update(status="error", error="조회 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.")
        finally:
            reservation.settle(paid_used(client))
            client.close()
            job["finishedAt"] = time.time()


@app.post("/api/company/lookup", status_code=202, response_model=None)
def lookup(req: LookupRequest) -> dict | JSONResponse:
    """회사명으로 회사 정보 초안, 기존 투자자, 경쟁사를 찾는 작업을 시작한다. 결과는 GET /api/company/lookup/{jobId} 로 받는다.
    이행 기간에만 남기는 경로(계약 2.13). 하루 상한은 검색 worst_case(10)·모델 worst_case(5)를 잡는다."""
    key, source = config.resolve_api_key()
    if not key:
        return error(503, "missing_config", NO_LINER_KEY)
    job_id = uuid.uuid4().hex
    job = {"status": "running", "stage": "보도·공식 자료 검색", "result": None, "error": "", "startedAt": time.time(), "finishedAt": None}
    # 동시 실행 수 확인, 호출 횟수 잡기, 작업 등록을 한 번에 한다. 나눠서 하면 동시에 들어온 요청이 모두 빈자리를 보고 통과한다
    with _lock:
        _prune_jobs(time.time())
        if sum(1 for j in _jobs.values() if j["status"] == "running") >= MAX_RUNNING_LOOKUPS:
            return error(429, "busy", "다른 회사 조회가 진행 중입니다. 잠시 뒤 다시 시도해 주세요.")
        try:
            reservation = limits.reserve_many({limits.LINER_SEARCH: limits.worst_case(LOOKUP_SEARCHES),
                                               limits.LINER_MODEL: limits.worst_case(LOOKUP_MODELS)})
        except limits.LimitReached as e:
            return _limit_error(e)
        _jobs[job_id] = job
    thread = threading.Thread(target=_run_lookup, args=(job, req.name.strip(), req.homepage.strip(), key, source, reservation), daemon=True)
    job["thread"] = thread
    thread.start()
    return {"jobId": job_id}


@app.get("/api/company/lookup/{job_id}", response_model=None)
def lookup_status(job_id: str) -> dict | JSONResponse:
    job = _jobs.get(job_id)
    if job is None:
        return error(404, "not_found", "조회 작업을 찾을 수 없습니다. 서버가 다시 시작됐거나 시간이 지나 지워졌습니다.")
    out = {"status": job["status"], "stage": job["stage"], "seconds": round((job["finishedAt"] or time.time()) - job["startedAt"])}
    if job["status"] == "done":
        out["result"] = job["result"]
    if job["status"] == "error":
        out["error"] = job["error"]
    return out


def funds_by_gp() -> dict[str, list[dict]]:
    global _funds_by_gp
    if _funds_by_gp is None:
        grouped: dict[str, list[dict]] = {}
        for f in json.loads(FUNDS_SNAPSHOT.read_text(encoding="utf-8")):
            grouped.setdefault(f["gp"], []).append(f)
        for rows in grouped.values():
            rows.sort(key=lambda f: f.get("year") or 0, reverse=True)
        _funds_by_gp = grouped
    return _funds_by_gp


class GpBriefRequest(BaseModel):
    gp: str = Field(min_length=2, max_length=60)
    company: Company


@app.post("/api/gp/brief", response_model=None)
def gp_brief(req: GpBriefRequest) -> dict | JSONResponse:
    """운용사 한 곳을 검색해 확인되는 사실과 회사 조건과 맞닿는 점을 짧게 정리한다. 스냅샷에 있는 운용사만 받는다.
    하루 상한은 일반 검색 worst_case(1)·모델 worst_case(1)을 잡는다(계약 2.10)."""
    funds = funds_by_gp().get(req.gp)
    if funds is None:
        return error(404, "not_found", "운용사 목록에 없는 이름입니다")
    key, source = config.resolve_api_key()
    if not key:
        return error(503, "missing_config", NO_LINER_KEY)
    try:
        reservation = limits.reserve_many({limits.LINER_SEARCH: limits.worst_case(1), limits.LINER_MODEL: limits.worst_case(1)})
    except limits.LimitReached as e:
        return _limit_error(e)
    with reservation:
        client = LinerClient(key, source, limits={"search": 1, "model": 1, "agent": 0, "premium": 0})
        try:
            return gp_mod.brief(req.gp, funds, company_mod.describe(req.company.model_dump()), client)
        except LinerAPIError as e:
            return _upstream_error(e)
        finally:
            reservation.settle(paid_used(client))
            client.close()
