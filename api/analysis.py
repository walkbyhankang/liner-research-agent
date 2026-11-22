"""성장노트 분석 엔드포인트(계약 docs/contract.md 2절). 작업·단락·스냅샷은 growth.jobs.Manager 가 맡는다.

- 요청 모양 검사(길이·형식)는 여기 선언한 대로 FastAPI 가 한다(어기면 422, 본문은 FastAPI 기본 모양).
- 그 밖의 오류는 error() 로 {"detail", "code", "retryAt"} 를 돌려준다(계약 3절). 글에는 내부 경로·예외·키 이름을 넣지 않는다.
- 접속 주소별 요청 제한(2.12절)은 ② 담당이다(이 파일의 POST 경로가 대상).
- 이 파일과 growth/ 는 research/ 를 불러오지 않는다.
"""
import logging
from typing import Annotated

from fastapi import APIRouter, Path, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from growth.contract import NewsCategory, SectionKey
from growth.jobs import ApiFailure, Manager

router = APIRouter(prefix="/api")
log = logging.getLogger("growth")

JOB_ID = r"^[0-9a-f]{32}$"
COMPANY_ID = r"^(\d{13}|n-[0-9a-f]{16})$"
CRNO = r"^\d{13}$"

JobId = Annotated[str, Path(pattern=JOB_ID)]
CompanyId = Annotated[str, Path(pattern=COMPANY_ID)]

manager = Manager()


def running_count() -> int:
    """지금 진행 중인(status running) 분석 작업 수. ②의 /api/health 가 analysis.running 으로 읽는다(계약 2.11절)."""
    return manager.running_count()


def error(status: int, code: str, detail: str, retry_at: str | None = None) -> JSONResponse:
    """계약 3절의 오류 본문. detail 은 사용자에게 보여도 되는 한 줄(내부 경로·예외·키 이름 없음)."""
    return JSONResponse({"detail": detail, "code": code, "retryAt": retry_at}, status_code=status)


def _call(fn, *args, status: int = 200, **kwargs):
    """Manager 호출을 감싸 ApiFailure 는 계약 오류 본문으로, 예상하지 못한 오류는 500 internal 로 바꾼다."""
    try:
        out = fn(*args, **kwargs)
    except ApiFailure as e:
        return error(e.status, e.code, e.detail, e.retry_at)
    except Exception as e:  # 내용은 응답에 넣지 않는다
        log.error("분석 엔드포인트 오류: %s", type(e).__name__)
        return error(500, "internal", "서버에서 오류가 났습니다")
    if isinstance(out, tuple):
        status, out = out
    return JSONResponse(out, status_code=status)


class StartAnalysisBody(BaseModel):
    """POST /api/analysis 본문(계약 2.2절)."""
    name: str = Field(min_length=2, max_length=60)
    crno: str | None = Field(None, pattern=CRNO)
    homepage: str | None = Field(None, max_length=100, pattern=r"^[A-Za-z0-9.\-]*$")  # 호스트 이름만
    refresh: bool = False


class RivalPickBody(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=60)
    nameEn: str | None = Field(None, max_length=80)
    crno: str | None = Field(None, pattern=CRNO)


class SectionRunBody(BaseModel):
    """POST /api/analysis/{jobId}/sections/{key} 본문(계약 2.4절). rivals 는 rivals_deep, keywords 는 sales 에만 넣는다."""
    rivals: list[RivalPickBody] | None = Field(None, min_length=1, max_length=5)
    keywords: list[Annotated[str, Field(min_length=1, max_length=20)]] | None = Field(None, min_length=1, max_length=6)


@router.get("/corp/search")
def corp_search(name: Annotated[str, Query(min_length=2, max_length=60)]):
    """금융위 법인 후보 → CorpSearchResponse."""
    return _call(manager.corp_search, name)


@router.post("/analysis")
def start_analysis(body: StartAnalysisBody):
    """분석 시작 → 202 StartAnalysisResponse(started=true) / 200(started=false, 진행 중 작업이나 저장된 분석)."""
    return _call(manager.start, body.name, body.crno, body.homepage, body.refresh)


@router.get("/analysis/{job_id}")
def get_analysis(job_id: JobId):
    """작업 상태와 단락 결과 → AnalysisJob(기사는 최신 20건만)."""
    def view():
        job = manager.get(job_id)
        if job is None:
            raise ApiFailure(404, "not_found", "분석 작업을 찾을 수 없습니다")
        return job.view()
    return _call(view)


@router.post("/analysis/{job_id}/sections/{key}")
def run_section(job_id: JobId, key: SectionKey, body: SectionRunBody | None = None):
    """열 때 실행(papers, rivals_deep, sales)과 단락 다시 실행 → 202 RunSectionResponse."""
    rivals = [r.model_dump() for r in body.rivals] if body and body.rivals is not None else None
    keywords = list(body.keywords) if body and body.keywords is not None else None
    return _call(manager.run_section, job_id, key, rivals, keywords, status=202)


@router.get("/analysis/{job_id}/news")
def news_page(job_id: JobId,
              offset: Annotated[int, Query(ge=0)] = 0,
              limit: Annotated[int, Query(ge=1, le=100)] = 20,
              category: Annotated[list[NewsCategory] | None, Query()] = None):
    """기사 나눠 받기 → NewsPage. category 는 여러 번 줄 수 있다(하나라도 걸리면 포함)."""
    return _call(manager.news_page, job_id, offset, limit, list(category or []))


@router.get("/company/{company_id}/analysis")
def company_analysis(company_id: CompanyId):
    """그 회사의 가장 최근 저장된 분석 → AnalysisJob. 없으면 404."""
    return _call(manager.company_analysis, company_id)


@router.get("/company/{company_id}/job")
def company_job(company_id: CompanyId):
    """그 회사의 진행 중 작업 → CompanyJobResponse. 없으면 404."""
    return _call(manager.company_job, company_id)


@router.get("/example")
def example():
    """예시 회사 → ExampleResponse. 없으면 404."""
    return _call(manager.example)
