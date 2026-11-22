"""자금 찾기 백엔드. 실행: .venv/bin/python -m uvicorn api.main:app --port 8000

화면(web)이 이 서버에 공고 자격 대조를 요청한다. Liner API 키는 서버에만 있고 응답에 넣지 않는다.
유료 호출은 서버 실행당 횟수 상한(FUNDING_MAX_PAID_CALLS, 기본 60)을 넘지 않는다. 자동 재시도로 나가는 요청도 센다.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
from funding import company as company_mod  # noqa: E402
from funding import gp as gp_mod  # noqa: E402
from funding import profile as profile_mod  # noqa: E402
from funding import service  # noqa: E402
from liner_client import MAX_AUTO_RETRIES, CallLimitExceeded, LinerAPIError, LinerClient  # noqa: E402
from api.analysis import router as analysis_router  # noqa: E402

SNAPSHOT = ROOT / "web" / "public" / "data" / "programs.json"
FUNDS_SNAPSHOT = ROOT / "web" / "public" / "data" / "funds.json"
CACHE_DIR = config.RESULTS_DIR / "cache" / "notice"
MAX_PAID_CALLS = int(os.environ.get("FUNDING_MAX_PAID_CALLS", "60"))

app = FastAPI(title="펀딩노트 API")
# 화면을 띄우는 주소. 기본은 Next.js 기본 포트(3000)와 이 프로젝트에서 쓰는 3100 이고, FUNDING_WEB_ORIGINS 로 바꿀 수 있다.
WEB_ORIGINS = [o.strip() for o in os.environ.get(
    "FUNDING_WEB_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3100,http://127.0.0.1:3100").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=WEB_ORIGINS,
                   allow_methods=["GET", "POST"], allow_headers=["content-type"])
app.include_router(analysis_router)

_lock = threading.Lock()
_paid_used = 0
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


def reserve_paid(n: int) -> None:
    """유료 호출 n회를 미리 잡는다. 상한을 넘으면 호출하지 않고 거절한다."""
    with _lock:
        _reserve_locked(n)


def _reserve_locked(n: int) -> None:
    """_lock 을 잡은 상태에서만 부른다."""
    global _paid_used
    if _paid_used + n > MAX_PAID_CALLS:
        raise HTTPException(429, "이 서버의 유료 호출 상한에 도달했습니다. 서버를 다시 시작하거나 상한을 조정하세요.")
    _paid_used += n


def worst_case(planned: int) -> int:
    """계획한 호출이 모두 자동 재시도까지 갔을 때 실제로 나가는 요청 수. 상한은 이 수를 기준으로 미리 잡는다."""
    return planned * (1 + MAX_AUTO_RETRIES)


def requests_sent(client: LinerClient) -> int:
    """실제로 보낸 요청 수. 자동 재시도도 한 번씩 센다."""
    return len(client.calls)


def release_paid(n: int) -> None:
    global _paid_used
    with _lock:
        _paid_used = max(0, _paid_used - n)


@app.get("/api/health")
def health() -> dict:
    key, _ = config.resolve_api_key()
    return {"ok": True, "hasKey": bool(key), "paidUsed": _paid_used, "paidLimit": MAX_PAID_CALLS,
            "extractModel": service.EXTRACT_MODEL, "matchModel": service.MATCH_MODEL}


@app.post("/api/notice/analyze")
def analyze(req: AnalyzeRequest) -> dict:
    program = programs().get(req.programId)
    if program is None:
        raise HTTPException(404, "스냅샷에 없는 공고입니다")
    key, source = config.resolve_api_key()
    if not key:
        raise HTTPException(503, "서버에 LINER_API_KEY 가 없습니다")
    cached = service.load_extraction(CACHE_DIR, program) is not None
    planned = 1 if cached else 2
    reserved = worst_case(planned)
    reserve_paid(reserved)
    client = LinerClient(key, source, limits={"model": planned, "search": 0, "agent": 0, "premium": 0})
    try:
        extraction = service.extract_notice(program, client, CACHE_DIR)
        match = service.match_company(extraction, company_mod.describe(req.company.model_dump()), client)
    except service.AnalysisError as e:
        raise HTTPException(422, str(e)) from e
    except CallLimitExceeded as e:
        raise HTTPException(429, str(e)) from e
    except LinerAPIError as e:
        raise HTTPException(502, f"Liner API 오류: {str(e)[:200]}") from e
    finally:
        release_paid(reserved - requests_sent(client))
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


def _run_lookup(job: dict, name: str, homepage: str, key: str, source: str | None, reserved: int) -> None:
    client = LinerClient(key, source, limits={"search": LOOKUP_SEARCHES, "model": LOOKUP_MODELS, "agent": 0, "premium": 0})
    try:
        out = profile_mod.lookup(name, client, homepage=homepage, progress=lambda msg: job.update(stage=stage_label(msg)))
        elapsed = round(sum(c.get("elapsed_sec") or 0 for c in client.calls), 1)
        job.update(status="done", result={**out, "query": name, "apiSeconds": elapsed})
    except profile_mod.ProfileError as e:
        job.update(status="error", error=str(e))
    except LinerAPIError as e:
        job.update(status="error", error=f"Liner API 오류: {str(e)[:200]}")
    except Exception as e:  # 작업 스레드에서 난 오류는 요청으로 올라가지 않으므로 여기서 상태로 남긴다
        job.update(status="error", error=f"조회 중 오류가 발생했습니다({type(e).__name__})")
    finally:
        release_paid(reserved - requests_sent(client))
        client.close()
        job["finishedAt"] = time.time()


@app.post("/api/company/lookup", status_code=202)
def lookup(req: LookupRequest) -> dict:
    """회사명으로 회사 정보 초안, 기존 투자자, 경쟁사를 찾는 작업을 시작한다. 결과는 GET /api/company/lookup/{jobId} 로 받는다."""
    key, source = config.resolve_api_key()
    if not key:
        raise HTTPException(503, "서버에 LINER_API_KEY 가 없습니다")
    reserved = worst_case(LOOKUP_SEARCHES + LOOKUP_MODELS)
    job_id = uuid.uuid4().hex
    job = {"status": "running", "stage": "보도·공식 자료 검색", "result": None, "error": "", "startedAt": time.time(), "finishedAt": None}
    # 동시 실행 수 확인, 호출 횟수 잡기, 작업 등록을 한 번에 한다. 나눠서 하면 동시에 들어온 요청이 모두 빈자리를 보고 통과한다
    with _lock:
        _prune_jobs(time.time())
        if sum(1 for j in _jobs.values() if j["status"] == "running") >= MAX_RUNNING_LOOKUPS:
            raise HTTPException(429, "다른 회사 조회가 진행 중입니다. 잠시 뒤 다시 시도해 주세요.")
        _reserve_locked(reserved)
        _jobs[job_id] = job
    thread = threading.Thread(target=_run_lookup, args=(job, req.name.strip(), req.homepage.strip(), key, source, reserved), daemon=True)
    job["thread"] = thread
    thread.start()
    return {"jobId": job_id}


@app.get("/api/company/lookup/{job_id}")
def lookup_status(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "조회 작업을 찾을 수 없습니다. 서버가 다시 시작됐거나 시간이 지나 지워졌습니다.")
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


@app.post("/api/gp/brief")
def gp_brief(req: GpBriefRequest) -> dict:
    """운용사 한 곳을 검색해 확인되는 사실과 회사 조건과 맞닿는 점을 짧게 정리한다. 스냅샷에 있는 운용사만 받는다."""
    funds = funds_by_gp().get(req.gp)
    if funds is None:
        raise HTTPException(404, "운용사 목록에 없는 이름입니다")
    key, source = config.resolve_api_key()
    if not key:
        raise HTTPException(503, "서버에 LINER_API_KEY 가 없습니다")
    reserved = worst_case(2)
    reserve_paid(reserved)
    client = LinerClient(key, source, limits={"search": 1, "model": 1, "agent": 0, "premium": 0})
    try:
        return gp_mod.brief(req.gp, funds, company_mod.describe(req.company.model_dump()), client)
    except LinerAPIError as e:
        raise HTTPException(502, f"Liner API 오류: {str(e)[:200]}") from e
    finally:
        release_paid(reserved - requests_sent(client))
        client.close()
