"""성장노트 분석 엔드포인트(계약 docs/contract.md 2절). 지금은 자리만 있고 모두 501 을 돌려준다. ③이 본문을 채운다.

- 요청 모양 검사(길이·형식)는 여기 선언한 대로 FastAPI 가 한다(어기면 422, 본문은 FastAPI 기본 모양).
- 그 밖의 오류는 error() 로 {"detail", "code", "retryAt"} 를 돌려준다(계약 3절).
- 이 파일과 growth/ 는 research/ 를 불러오지 않는다.
"""
from typing import Annotated

from fastapi import APIRouter, Path, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from growth.contract import NewsCategory, SectionKey

router = APIRouter(prefix="/api")

JOB_ID = r"^[0-9a-f]{32}$"
COMPANY_ID = r"^(\d{13}|n-[0-9a-f]{16})$"
CRNO = r"^\d{13}$"

JobId = Annotated[str, Path(pattern=JOB_ID)]
CompanyId = Annotated[str, Path(pattern=COMPANY_ID)]


def error(status: int, code: str, detail: str, retry_at: str | None = None) -> JSONResponse:
    """계약 3절의 오류 본문. detail 은 사용자에게 보여도 되는 한 줄(내부 경로·예외·키 이름 없음)."""
    return JSONResponse({"detail": detail, "code": code, "retryAt": retry_at}, status_code=status)


def _todo() -> JSONResponse:
    return error(501, "not_implemented", "아직 준비되지 않은 기능입니다")


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
    return _todo()


@router.post("/analysis")
def start_analysis(body: StartAnalysisBody):
    """분석 시작 → 202 StartAnalysisResponse(started=true) / 200(started=false, 진행 중 작업이나 저장된 분석)."""
    return _todo()


@router.get("/analysis/{job_id}")
def get_analysis(job_id: JobId):
    """작업 상태와 단락 결과 → AnalysisJob(기사는 최신 20건만)."""
    return _todo()


@router.post("/analysis/{job_id}/sections/{key}")
def run_section(job_id: JobId, key: SectionKey, body: SectionRunBody | None = None):
    """열 때 실행(papers, rivals_deep, sales)과 단락 다시 실행 → 202 RunSectionResponse."""
    return _todo()


@router.get("/analysis/{job_id}/news")
def news_page(job_id: JobId,
              offset: Annotated[int, Query(ge=0)] = 0,
              limit: Annotated[int, Query(ge=1, le=100)] = 20,
              category: Annotated[list[NewsCategory] | None, Query()] = None):
    """기사 나눠 받기 → NewsPage. category 는 여러 번 줄 수 있다(하나라도 걸리면 포함)."""
    return _todo()


@router.get("/company/{company_id}/analysis")
def company_analysis(company_id: CompanyId):
    """그 회사의 가장 최근 저장된 분석 → AnalysisJob. 없으면 404."""
    return _todo()


@router.get("/company/{company_id}/job")
def company_job(company_id: CompanyId):
    """그 회사의 진행 중 작업 → CompanyJobResponse. 없으면 404."""
    return _todo()


@router.get("/example")
def example():
    """예시 회사 → ExampleResponse. 없으면 404."""
    return _todo()
