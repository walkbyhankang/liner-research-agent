"""성장노트 서버·화면 데이터 계약(Python 타입과 계약 규칙 함수).

- 본문은 docs/contract.md, 화면 쪽 같은 타입은 web/lib/contract.ts 다. 셋이 다르면 docs/contract.md 를 따른다.
- 타입은 TypedDict 다. 응답은 평범한 dict 로 만들고, 테스트에서 pydantic TypeAdapter 로 모양을 검사한다
  (모든 TypedDict 에 extra="forbid" 를 걸어 계약에 없는 키가 섞이면 실패한다).
- 모든 키는 언제나 들어 있다. 값이 없으면 null(None)이고, 목록은 빈 목록이다. 예외는 GpBrief.model 하나(지금 코드 그대로).
- 이 모듈은 research/ 를 불러오지 않는다.
"""
import hashlib
import re
import unicodedata
from typing import Literal, NotRequired, TypedDict

from pydantic import ConfigDict, with_config

CONTRACT_VERSION = 1

_strict = with_config(ConfigDict(extra="forbid"))

# ---------------------------------------------------------------- 값 목록

Status = Literal["confirmed", "reported", "inferred", "conflicting", "unavailable", "reference"]
STATUSES: tuple[str, ...] = ("confirmed", "reported", "inferred", "conflicting", "unavailable", "reference")
# 화면 낱말(screens.md 1.3). 서버는 쓰지 않고 화면·노트 글로 낼 때 쓴다.
STATUS_LABEL = {"confirmed": "원문 확인", "reported": "보도", "inferred": "추정", "conflicting": "엇갈림",
                "unavailable": "미확보", "reference": "참고"}

SectionKey = Literal["identity", "official", "profile", "facts", "funding_history", "news", "patents", "papers",
                     "rivals_deep", "sales"]
SECTION_KEYS: tuple[str, ...] = ("identity", "official", "profile", "facts", "funding_history", "news", "patents",
                                 "papers", "rivals_deep", "sales")
BASIC_SECTIONS: tuple[str, ...] = ("identity", "official", "profile", "facts", "funding_history", "news", "patents")
ON_DEMAND_SECTIONS: tuple[str, ...] = ("papers", "rivals_deep", "sales")
# 먼저 끝나야(끝 상태: done·partial·unavailable) 시작하는 단락. 앞 단락이 미확보로 끝나도 대체 값으로 시작한다(계약 5.4절).
DEPENDS_ON: dict[str, tuple[str, ...]] = {
    "identity": (), "official": ("identity",), "profile": ("identity",), "facts": (),
    "funding_history": ("profile",), "news": ("profile",), "patents": ("profile",),
    "papers": ("profile",), "rivals_deep": (), "sales": (),
}

SectionStatus = Literal["waiting", "running", "done", "partial", "unavailable", "idle"]
TERMINAL_SECTION_STATUSES: tuple[str, ...] = ("done", "partial", "unavailable")
JobStatus = Literal["running", "done", "interrupted"]

SectionErrorCode = Literal["daily_limit", "section_limit", "no_corp", "no_data", "upstream_error", "timeout",
                           "interrupted", "missing_config"]
SECTION_ERROR_CODES: tuple[str, ...] = ("daily_limit", "section_limit", "no_corp", "no_data", "upstream_error",
                                        "timeout", "interrupted", "missing_config")

ApiErrorCode = Literal["bad_request", "not_found", "conflict", "section_running", "section_not_ready",
                       "example_readonly", "daily_limit", "refresh_limit", "rate_limited", "busy", "missing_config",
                       "upstream_error", "analysis_failed", "not_implemented", "internal"]
API_ERROR_CODES: tuple[str, ...] = ("bad_request", "not_found", "conflict", "section_running", "section_not_ready",
                                    "example_readonly", "daily_limit", "refresh_limit", "rate_limited", "busy",
                                    "missing_config", "upstream_error", "analysis_failed", "not_implemented",
                                    "internal")

NewsCategory = Literal["기술개발", "해외 진출", "사업제휴", "수주·계약", "경영진·인터뷰", "정부 관련", "투자유치",
                       "제품 출시", "매출·실적", "기타 동향"]
NEWS_CATEGORIES: tuple[str, ...] = ("기술개발", "해외 진출", "사업제휴", "수주·계약", "경영진·인터뷰", "정부 관련",
                                    "투자유치", "제품 출시", "매출·실적", "기타 동향")

FundFieldId = Literal["early", "ai", "bio", "content", "mfg", "green", "local", "ip", "impact", "scale"]
# web/lib/finder.ts 의 fundFields 와 같은 id·이름
FUND_FIELD_LABEL = {"early": "창업 초기", "ai": "AI·딥테크·소프트웨어", "bio": "바이오·헬스", "content": "콘텐츠·문화",
                    "mfg": "소재·부품·장비", "green": "환경·에너지", "local": "지방 기업", "ip": "특허·기술사업화",
                    "impact": "소셜임팩트·여성기업", "scale": "스케일업·해외진출"}
BizTypeId = Literal["venture", "sme", "micro"]
BIZ_TYPE_LABEL = {"venture": "창업·벤처기업", "sme": "중소기업", "micro": "소상공인"}
REGIONS: tuple[str, ...] = ("서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남",
                            "전북", "전남", "경북", "경남", "제주")

PendingKey = Literal["employees", "revenue.web", "industry.web", "founded.web", "region.web", "investors.confirmed",
                     "rivals.facts"]
PENDING_KEYS: tuple[str, ...] = ("employees", "revenue.web", "industry.web", "founded.web", "region.web",
                                 "investors.confirmed", "rivals.facts")

# 단락이 보통 끝나는 초(단락 startedAt 기준). 기준 기업 실측(설계 6.5, 합친 서버 facts 약 176초)을 올려 잡은 값. 실측 없는 단락은 None.
EXPECTED_SECONDS: dict[str, int | None] = {
    "identity": 3, "official": 10, "profile": 25, "facts": 180, "funding_history": 30, "news": 45, "patents": 35,
    "papers": None, "rivals_deep": None, "sales": None,
}

# ---------------------------------------------------------------- 출처

@_strict
class Source(TypedDict):
    label: str          # "{org} {name} ({kind})" (org 가 빈 글이면 "{name} ({kind})"). 화면 출처 줄 앞부분
    org: str
    name: str
    kind: str
    asOf: str | None    # 기준일 글. 예: "2026-11-22 조회", "2022 사업연도", "2025-11~2026-10"
    basis: str | None   # 값의 기준. 예: "별도", "연결", "USD"
    url: str | None     # http·https 만


# 출처 목록(계약 6.3절). org/name/kind 는 이 표의 글을 그대로 쓴다. "{host}" "{n}" "{outlet}" 은 채워 넣는다.
SOURCE_CATALOG: dict[str, dict[str, str]] = {
    "fsc_corp": {"org": "금융위원회", "name": "기업기본정보", "kind": "공공 API"},
    "fsc_fin": {"org": "금융위원회", "name": "요약재무제표", "kind": "공공 API"},
    "nps": {"org": "국민연금공단", "name": "사업장 가입자", "kind": "공공 API"},
    "pdl": {"org": "People Data Labs", "name": "회사 카드", "kind": "Liner Premium"},
    "web_page": {"org": "{host}", "name": "웹 문서", "kind": "원문 확인"},
    "web_snippet": {"org": "Liner", "name": "웹 검색", "kind": "검색 결과 발췌"},
    "liner_profile": {"org": "Liner", "name": "웹 검색 자료 {n}건", "kind": "모델 정리"},
    "news_article": {"org": "{outlet}", "name": "기사", "kind": "검색 결과 발췌"},
    "patents": {"org": "", "name": "특허 공개 원문", "kind": "Google Patents"},
    "openalex": {"org": "OpenAlex", "name": "논문 DB", "kind": "공개 API"},
    "liner_scholar": {"org": "Liner", "name": "학술 검색", "kind": "검색 결과 발췌"},
    "g2b": {"org": "조달청", "name": "나라장터 입찰공고", "kind": "공공 API"},
}


def source_label(org: str, name: str, kind: str) -> str:
    """출처 줄 앞부분. 계약 6.3절의 규칙 그대로."""
    head = f"{org} {name}".strip() if org else name
    return f"{head} ({kind})"


def make_source(kind_id: str, *, as_of: str | None = None, basis: str | None = None, url: str | None = None,
                **fill: str) -> "Source":
    """SOURCE_CATALOG 의 한 줄로 Source 를 만든다. fill 은 {host}, {n}, {outlet} 자리를 채운다."""
    row = {k: v.format(**fill) if "{" in v else v for k, v in SOURCE_CATALOG[kind_id].items()}
    safe_url = url if isinstance(url, str) and url.startswith(("http://", "https://")) else None
    return {"label": source_label(row["org"], row["name"], row["kind"]), "org": row["org"], "name": row["name"],
            "kind": row["kind"], "asOf": as_of, "basis": basis, "url": safe_url}


# ---------------------------------------------------------------- 값 하나 (Value)

@_strict
class ValueAlt(TypedDict):
    display: str
    raw: str | int | float | None
    source: Source
    quote: str | None


@_strict
class Value(TypedDict):
    display: str | None             # 화면 글(단위 포함). unavailable 이면 None
    raw: str | int | float | None   # 계산·대조에 쓰는 원래 값. conflicting 이면 values[usedIndex].raw
    status: Status
    source: Source | None
    quote: str | None               # 원문 근거 문장(원문 그대로)
    note: str | None                # 덧붙일 설명
    reason: str | None              # unavailable 일 때 짧은 사유(20자 안팎). 그 밖에는 None
    values: list[ValueAlt] | None   # conflicting 일 때만 목록(1개 이상, 보통 2개). 그 밖에는 None
    usedIndex: int | None           # conflicting 일 때 계산·대조에 쓰는 값의 위치(공공 API 값). 없으면 None


# ---------------------------------------------------------------- 법인 (identity, /api/corp/search)

@_strict
class FormerName(TypedDict):
    name: str               # 그때의 법인 이름(금융위 corpNm 표기 그대로)
    changedOn: str | None   # 다음 이름으로 바뀐 날 YYYY-MM-DD(다음 이름 기록이 처음 시작한 날). 모르면 null


@_strict
class Corp(TypedDict):
    companyId: str          # 이 법인으로 분석할 때의 회사 id(= crno)
    crno: str               # 법인등록번호 13자리
    bzno: str | None        # 사업자등록번호 10자리
    name: str
    names: list[str]        # 금융위에 있는 다른 표기들
    # 이전 이름(옛 상호), 최근에 바뀐 것 먼저. 표기 차이("(주)"·"주식회사"·띄어쓰기)와 영문명 변경은 넣지 않는다.
    # /api/corp/search 에서 정규화한 이름이 같은 후보가 2곳 이상일 때 그 후보만 조회한다(2.1절): 이력이 없으면 [].
    # null = 조회하지 않음(이름이 겹치지 않는 후보, identity·rivals_deep) 또는 조회 실패·상한. 옛 스냅샷은 읽을 때 null 로 채운다(12.1절)
    formerNames: list[FormerName] | None
    nameEn: str | None
    ceo: str | None
    founded: str | None     # YYYY-MM-DD
    address: str | None
    region: str | None      # 시·도(REGIONS 중 하나)
    district: str | None    # 시·군·구(예: "강남구", "성남시 분당구")
    homepage: str | None
    industry: str | None    # 금융위 업종(sicNm)
    mainBiz: str | None
    market: str | None      # 상장 구분
    updated: str | None     # 금융위 자료 갱신일 YYYY-MM-DD
    exact: bool             # 넣은 이름과 정확히 같은가
    snapshotAt: str | None  # 이 법인으로 서버에 저장된 가장 최근 분석의 analyzedAt


@_strict
class CorpSearchResponse(TypedDict):
    query: str
    candidates: list[Corp]  # 최대 20곳. exact 먼저, 그다음 updated 최근순
    queriedAt: str


@_strict
class IdentityResult(TypedDict):
    corp: Corp
    otherCorps: list[Corp]  # 같은 이름으로 찾은 다른 법인(고른 법인 제외, 최대 7곳)
    queriedAt: str


# ---------------------------------------------------------------- official

@_strict
class FinancialRow(TypedDict):
    year: str                 # 사업연도 YYYY
    periodEnd: str | None     # 결산 기준일 YYYY-MM-DD
    basis: str                # 원래 표기. 예: "별도요약재무제표"
    basisShort: Literal["연결", "별도"] | None
    currency: str             # 예: "KRW"
    revenue: float | None     # 이하 금액은 원 단위(통화 currency)
    operatingIncome: float | None
    pretaxIncome: float | None
    netIncome: float | None
    totalAssets: float | None
    totalLiabilities: float | None
    totalEquity: float | None
    capital: float | None
    debtRatioPct: float | None
    revenueGrowthPct: float | None     # financialsAll 에서는 언제나 None
    operatingMarginPct: float | None   # financialsAll 에서는 언제나 None


@_strict
class NpsMonth(TypedDict):
    month: str                # YYYY-MM
    members: int | None       # 가입자 수
    joined: int | None        # 신규 취득
    left: int | None          # 상실
    change: int | None        # 전월 대비(첫 달 None)


@_strict
class NpsSummary(TypedDict):
    first: int
    latest: int
    change: int
    changePct: float | None
    period: str               # "YYYY-MM ~ YYYY-MM"
    joinedTotal: int
    leftTotal: int


@_strict
class NpsWorkplace(TypedDict):
    name: str
    bznoMasked: str
    industry: str | None
    address: str | None


@_strict
class Nps(TypedDict):
    monthly: list[NpsMonth]   # 최대 12개월, 오래된 달부터
    summary: NpsSummary | None   # 가입자 수가 있는 달이 2개 미만이면 None
    workplace: NpsWorkplace
    note: str


@_strict
class OfficialResult(TypedDict):
    crno: str
    financials: list[FinancialRow]     # 최근 3개 사업연도, 오래된 해부터. 같은 해에 연결·별도가 있으면 연결
    financialsAll: list[FinancialRow]  # 전체 연도·전체 기준, 연도 오름차순
    financialsReason: str | None       # financials 가 비었을 때 사유. 예: "금융위원회 재무 자료 없음"
    nps: Nps | None
    npsReason: str | None              # nps 가 None 일 때 사유. 예: "국민연금 사업장을 찾지 못함"
    queriedAt: str


# ---------------------------------------------------------------- profile

@_strict
class Product(TypedDict):
    name: str
    desc: str | None


@_strict
class TechKeyword(TypedDict):
    ko: str
    en: str | None


@_strict
class ProfileCompetitor(TypedDict):
    name: str
    nameEn: str | None
    registeredNameKo: str | None
    relation: str | None      # "직접 경쟁" / "대체 기술" / "유사 사업모델"
    reason: str | None


@_strict
class SourceDoc(TypedDict):
    title: str
    url: str | None
    date: str | None


@_strict
class ProfileResult(TypedDict):
    nameKo: str | None
    nameEn: str | None
    aliases: list[str]
    industry: str | None
    business: str | None
    products: list[Product]
    coreTech: list[str]
    statusNotes: list[str]
    techKeywords: list[TechKeyword]
    govKeywords: list[str]
    bidKeywords: list[str]
    fundField: FundFieldId | None
    stage: str | None                    # 화면에 쓰지 않는다(OV-05)
    competitors: list[ProfileCompetitor]  # 국내 기업만(해외·외국 기업 한국 지사는 서버가 뺐다), 최대 5
    sourceCount: int                     # = len(sources)
    sources: list[SourceDoc]


# ---------------------------------------------------------------- facts

FactStatus = Literal["confirmed", "reported", "inferred", "conflicting"]


@_strict
class FactsField(TypedDict):
    key: Literal["founded", "region", "industry", "employees", "revenue"]
    label: str
    value: str
    status: FactStatus
    sourceUrl: str | None
    evidence: str | None
    note: str | None


@_strict
class FactsInvestor(TypedDict):
    name: str
    round: str | None
    date: str | None
    status: FactStatus
    sourceUrl: str | None


@_strict
class FactsCompetitor(TypedDict):
    name: str
    relation: str | None
    products: str | None
    revenue: str | None
    employees: str | None
    funding: str | None
    asOf: str | None
    status: FactStatus
    sourceUrl: str | None
    domestic: bool            # 국내 기업으로 확인됐나(계약 7.9절). false 는 화면 어디에도 쓰지 않는다


@_strict
class FactsResult(TypedDict):
    fields: list[FactsField]
    investors: list[FactsInvestor]
    competitors: list[FactsCompetitor]
    searches: int
    pagesRead: int


# ---------------------------------------------------------------- funding_history

@_strict
class RoundSource(TypedDict):
    type: Literal["Premium", "Web"]
    label: str
    url: str | None


@_strict
class Round(TypedDict):
    id: str                       # "r1", "r2" … (이 결과 안에서만 고유)
    date: str | None              # YYYY / YYYY-MM / YYYY-MM-DD
    reportedDate: str | None      # 날짜가 없을 때 보도일 YYYY-MM-DD
    round: str | None             # 원래 표기. 예: "Series B"
    amount: str | None            # 원래 표기. 예: "$100.0M"
    amountValue: float | None     # amount 를 숫자로(통화 currency)
    currency: str | None          # "USD", "KRW" …
    otherAmounts: list[str]       # 다른 출처의 다른 금액(원래 표기)
    investors: list[str]
    lead: list[str]
    entity: str | None            # 자료에 적힌 투자 대상 법인
    entityMatch: Literal["exact", "web"]
    sourceType: str               # "premium_structured" / "web_reported" / 둘을 "+"로 이은 것
    sources: list[RoundSource]
    raw: str | None
    summary: str | None


@_strict
class FhInvestor(TypedDict):
    name: str
    roundCount: int
    roundLabels: list[str]        # 예: "Series B 2025-09"
    lastDate: str | None
    lead: bool


@_strict
class LatestRound(TypedDict):
    date: str | None
    round: str | None
    amount: str | None


@_strict
class Cumulative(TypedDict):
    basis: Literal["pdl_total", "rounds_sum", "rounds_partial_sum", "none"]
    label: str                    # 화면 글 그대로(계약 8.5절)
    byCurrency: dict[str, float]  # 통화별 합. 통화를 바꾸지 않는다
    roundsWithAmount: int | None
    roundsTotal: int
    entity: str | None
    note: str | None


@_strict
class FhSummary(TypedDict):
    roundCount: int
    investorCount: int
    latest: LatestRound | None
    cumulative: Cumulative


@_strict
class RelatedEntity(TypedDict):
    name: str
    website: str | None
    location: str | None
    totalRaised: str | None
    fundingStage: str | None
    roundCount: int


@_strict
class FundingHistoryResult(TypedDict):
    company: str
    nameEn: str | None
    rounds: list[Round]               # 이 회사 라운드만(entityMatch exact·web), 최근순
    investors: list[FhInvestor]       # rounds 에서 센 투자기관(참여 라운드 많은 순, 같으면 최근 참여순)
    summary: FhSummary
    relatedEntities: list[RelatedEntity]  # 이름만 비슷한 다른 법인 카드. 투자자 판정에 쓰지 않는다
    webUsed: bool
    queriedAt: str


# ---------------------------------------------------------------- news

@_strict
class Article(TypedDict):
    id: str                       # "a1" … (이 분석 안에서 고유, 최신순 번호)
    date: str | None              # YYYY-MM-DD
    title: str                    # 글 그대로. HTML 로 해석하지 않는다
    description: str | None       # 짧은 발췌
    outlet: str | None            # 매체(최대 4곳을 ", "로 이은 글)
    url: str | None
    naverUrl: str | None
    categories: list[NewsCategory]
    relatedCount: int             # 묶인 같은 기사 수(1 이상)


@_strict
class CategoryCount(TypedDict):
    category: NewsCategory
    count: int


@_strict
class NewsEvent(TypedDict):
    date: str | None              # 모델이 쓴 날짜(YYYY-MM 또는 YYYY-MM-DD)
    category: str                 # 모델이 쓴 자유 글
    title: str
    detail: str | None
    articleId: str | None         # 근거 기사의 Article.id
    articleTitle: str | None
    articleUrl: str | None
    outlet: str | None
    articleDate: str | None


@_strict
class NewsResult(TypedDict):
    period: str                   # "YYYY-MM-DD ~ YYYY-MM-DD"
    rawCount: int                 # 중복 정리 전 수집 건수
    apiCounts: dict[str, int]     # {"naver": n, "liner": m}
    articleTotal: int             # 중복 정리 후 전체 기사 수
    categoryCounts: list[CategoryCount]  # 10개 분류가 모두 있다(0 포함). 건수 많은 순, 같으면 NEWS_CATEGORIES 순
    articles: list[Article]       # 작업 응답에는 최신 20건, 스냅샷 파일에는 전체
    events: list[NewsEvent]       # 최신순, 최대 15
    trends: list[str]             # 최대 5
    longSummary: str | None       # 화면에 쓰지 않는다(NE-05)
    errors: list[str]             # 사용자에게 보여도 되는 짧은 글


@_strict
class NewsPage(TypedDict):
    jobId: str
    offset: int
    limit: int
    categories: list[NewsCategory]  # 적용한 분류(비면 전체)
    total: int                      # 거른 뒤 전체 건수
    articleTotal: int               # 거르기 전 전체 건수
    categoryCounts: list[CategoryCount]  # 거르기 전 분류별 건수(NewsResult 와 같은 모양)
    items: list[Article]


# ---------------------------------------------------------------- patents

@_strict
class Patent(TypedDict):
    id: str                       # 출원번호(없으면 공개번호)
    title: str
    assignee: str | None
    applicationNo: str | None     # 10-2025-0000000
    filingDate: str | None
    publicationNo: str | None
    publicationDate: str | None
    registrationNo: str | None    # 있으면 "등록", 없으면 "공개"
    registrationDate: str | None
    legalStatus: str | None       # 원문 상태 글(화면 판정에 쓰지 않음)
    cpc: list[str]
    techFields: list[str]
    abstract: str | None
    url: str | None


@_strict
class PatentMention(TypedDict):
    pubNo: str
    title: str
    assignee: str | None
    filingDate: str | None
    url: str | None


@_strict
class PatentSummary(TypedDict):
    total: int
    registered: int
    recent5: int
    byYear: dict[str, int]        # 출원연도 "YYYY" → 건수(없는 해는 키가 없다)
    withFilingDate: int
    noFilingDate: int


@_strict
class PatentsResult(TypedDict):
    summary: PatentSummary
    patents: list[Patent]         # 출원일 최근순
    mentions: list[PatentMention]
    pagesChecked: int
    pagesLimit: int               # 원문 확인 한도(30)
    candidatesLeft: int
    basis: str
    note: str
    errors: list[str]
    queriedAt: str


# ---------------------------------------------------------------- papers

@_strict
class Paper(TypedDict):
    id: str
    title: str
    year: int | None
    date: str | None
    authors: str | None
    affiliations: str | None
    venue: str | None             # 학술지·학회
    citations: int
    url: str | None
    source: Literal["OpenAlex", "Liner Scholar"]
    important: str | None         # OpenAlex 지표로 붙인 "주요 논문" 이유. 없으면 None


@_strict
class Institution(TypedDict):
    name: str
    count: int


@_strict
class KeyPaper(TypedDict):
    title: str
    point: str
    url: str | None


@_strict
class PaperTopic(TypedDict):
    name: str                     # 기술 분야(한글)
    en: str | None
    byYear: dict[str, int]
    trend: str                    # 예: "증가 (2024→2025: +12%)" / "판단 자료 부족"
    institutions: list[Institution]
    papers: list[Paper]           # 분야마다 최대 12
    summary: str | None
    relevance: str | None
    keyPapers: list[KeyPaper]


@_strict
class CompanyPapers(TypedDict):
    mode: str                     # "OpenAlex 기관 ID" / "원문 소속 문자열 검색" / ""
    direct: bool
    countBasis: str | None
    works: list[Paper]            # 저자 소속으로 확인한 논문
    byYear: dict[str, int]
    mentionByYear: dict[str, int]
    error: str | None


@_strict
class PapersResult(TypedDict):
    keywordsUsed: list[str]
    topics: list[PaperTopic]
    company: CompanyPapers
    queriedAt: str


# ---------------------------------------------------------------- rivals_deep

@_strict
class RivalPatents(TypedDict):
    total: int
    registered: int
    byYear: dict[str, int]


@_strict
class RivalFunding(TypedDict):
    rounds: list[Round]           # 최근순
    summary: FhSummary
    investors: list[str]          # 투자기관 이름(자금 조달 "경쟁사에 투자" 판정용)


@_strict
class RivalSummary(TypedDict):
    business: str | None
    productsTech: str | None
    recentChanges: list[str]      # 최대 5


@_strict
class RivalDeep(TypedDict):
    key: str
    name: str
    nameEn: str | None
    corp: Corp | None
    financials: list[FinancialRow]
    financialsReason: str | None
    nps: Nps | None
    npsReason: str | None
    funding: RivalFunding | None
    fundingReason: str | None
    patents: RivalPatents | None
    patentsReason: str | None
    summary: RivalSummary | None
    errors: list[str]


@_strict
class RivalInvestors(TypedDict):
    rivalKey: str
    rivalName: str
    investors: list[str]


@_strict
class RivalsDeepResult(TypedDict):
    rivalSet: list[str]           # 이 결과를 만든 경쟁사 key(요청 순서)
    rivals: list[RivalDeep]
    rivalInvestors: list[RivalInvestors]
    queriedAt: str


# ---------------------------------------------------------------- sales

@_strict
class Bid(TypedDict):
    id: str                       # "{공고번호}-{차수}"
    title: str
    agency: str
    kind: Literal["물품", "용역"]
    summary: str | None           # 입찰 방식 · 계약 방법
    amount: str                   # "3.20억원" / "4,500만원" / "공고문 확인"
    period: str                   # "YYYY-MM-DD HH:mm ~ YYYY-MM-DD HH:mm"
    bidBegin: str | None          # YYYY-MM-DD HH:mm
    bidClose: str | None          # YYYY-MM-DD HH:mm
    deadline: str | None          # YYYY-MM-DD
    status: Literal["open", "upcoming", "closed", "unknown"]
    condition: str                # "참가자격은 공고문 확인" / "물품분류 제한"
    relevance: Literal["high", "normal"]
    keywords: list[str]           # 걸린 검색어
    url: str | None
    noticeDate: str | None


@_strict
class SalesResult(TypedDict):
    keywords: list[str]
    strongKeywords: list[str]
    period: str
    items: list[Bid]
    calls: int
    errorCount: int
    skipped: int
    errors: list[str]
    queriedAt: str


# ---------------------------------------------------------------- 단락 봉투

@_strict
class SectionError(TypedDict):
    code: SectionErrorCode
    message: str                  # 사용자에게 보여도 되는 한 줄(내부 경로·예외·키 이름 없음)
    source: str | None            # 실패한 자료 이름(upstream_error 일 때)
    retryAt: str | None           # daily_limit 이면 다음 날 0시(한국 시간)


@_strict
class SectionPaid(TypedDict):
    search: int
    premium: int
    model: int
    scholar: int


@_strict
class Rerun(TypedDict):
    status: Literal["running", "failed"]
    startedAt: str
    seconds: float | None
    error: SectionError | None    # failed 일 때만


@_strict
class _Envelope(TypedDict):
    key: SectionKey
    status: SectionStatus
    stage: str | None
    startedAt: str | None
    seconds: float | None
    expectedSeconds: int | None
    analyzedAt: str | None
    error: SectionError | None
    retryable: bool
    waitingFor: list[SectionKey]
    rerun: Rerun | None
    paid: SectionPaid


@_strict
class IdentitySection(_Envelope):
    result: IdentityResult | None


@_strict
class OfficialSection(_Envelope):
    result: OfficialResult | None


@_strict
class ProfileSection(_Envelope):
    result: ProfileResult | None


@_strict
class FactsSection(_Envelope):
    result: FactsResult | None


@_strict
class FundingHistorySection(_Envelope):
    result: FundingHistoryResult | None


@_strict
class NewsSection(_Envelope):
    result: NewsResult | None


@_strict
class PatentsSection(_Envelope):
    result: PatentsResult | None


@_strict
class PapersSection(_Envelope):
    result: PapersResult | None


@_strict
class RivalsDeepSection(_Envelope):
    result: RivalsDeepResult | None


@_strict
class SalesSection(_Envelope):
    result: SalesResult | None


@_strict
class Sections(TypedDict):
    identity: IdentitySection
    official: OfficialSection
    profile: ProfileSection
    facts: FactsSection
    funding_history: FundingHistorySection
    news: NewsSection
    patents: PatentsSection
    papers: PapersSection
    rivals_deep: RivalsDeepSection
    sales: SalesSection


# ---------------------------------------------------------------- merged

@_strict
class TwoValues(TypedDict):
    official: Value | None
    web: Value | None


@_strict
class BizTypeHint(TypedDict):
    id: BizTypeId
    reason: str


@_strict
class MergedInvestor(TypedDict):
    key: str                      # norm_name(name)
    name: str
    aliases: list[str]
    status: Literal["confirmed", "reported"]
    roundCount: int
    roundLabels: list[str]
    lastDate: str | None
    lead: bool
    foundIn: list[Literal["funding_history", "facts"]]
    sources: list[Source]


@_strict
class MergedRival(TypedDict):
    key: str                      # "rival:" + norm_name(…)
    name: str
    nameEn: str | None
    registeredNameKo: str | None
    relation: str | None
    reason: str | None
    status: Literal["confirmed", "reported", "inferred"]
    foundIn: list[Literal["profile", "facts"]]
    products: str | None
    employees: str | None
    revenue: str | None
    funding: str | None
    sources: list[Source]


@_strict
class Merged(TypedDict):
    region: Value | None
    district: str | None
    headquarters: Value | None
    ceo: Value | None
    founded: Value | None
    bizType: Value
    bizTypeHint: BizTypeHint | None
    industry: TwoValues
    employees: Value | None
    revenue: TwoValues
    npsLatest: Value | None
    patentCount: Value | None
    investors: list[MergedInvestor]
    rivals: list[MergedRival]
    techKeywords: list[TechKeyword]
    programKeywords: list[str]
    fundField: Value | None
    bidKeywords: list[str]
    pending: list[PendingKey]


# ---------------------------------------------------------------- 작업 응답

@_strict
class CompanyRef(TypedDict):
    name: str
    crno: str | None


@_strict
class LinerPaid(TypedDict):
    search: int
    premium: int
    model: int
    scholar: int


@_strict
class Paid(TypedDict):
    liner: LinerPaid


@_strict
class Estimate(TypedDict):
    seconds: int | None
    liner: int
    perRival: int | None


@_strict
class SectionEstimates(TypedDict):
    identity: Estimate
    official: Estimate
    profile: Estimate
    facts: Estimate
    funding_history: Estimate
    news: Estimate
    patents: Estimate
    papers: Estimate
    rivals_deep: Estimate
    sales: Estimate


@_strict
class Estimates(TypedDict):
    full: Estimate
    sections: SectionEstimates


@_strict
class RefreshInfo(TypedDict):
    remainingToday: int
    limitPerDay: int


@_strict
class AnalysisJob(TypedDict):
    contractVersion: int
    jobId: str
    companyId: str
    query: str
    company: CompanyRef
    status: JobStatus
    busy: bool
    startedAt: str
    analyzedAt: str | None
    isExample: bool
    sections: Sections
    merged: Merged
    paid: Paid
    estimates: Estimates
    refresh: RefreshInfo


# 예상값(계약 10절). 서버는 실측으로 바꾸기 전까지 이 값을 그대로 보낸다.
ESTIMATES: Estimates = {
    "full": {"seconds": 180, "liner": 19, "perRival": None},
    "sections": {
        "identity": {"seconds": 3, "liner": 0, "perRival": None},
        "official": {"seconds": 10, "liner": 0, "perRival": None},
        "profile": {"seconds": 25, "liner": 4, "perRival": None},
        "facts": {"seconds": 180, "liner": 8, "perRival": None},
        "funding_history": {"seconds": 10, "liner": 2, "perRival": None},
        "news": {"seconds": 20, "liner": 3, "perRival": None},
        "patents": {"seconds": 15, "liner": 2, "perRival": None},
        "papers": {"seconds": 30, "liner": 7, "perRival": None},
        "rivals_deep": {"seconds": None, "liner": 34, "perRival": 6},
        "sales": {"seconds": 10, "liner": 0, "perRival": None},
    },
}

# ---------------------------------------------------------------- 요청·짧은 응답

@_strict
class StartAnalysisRequest(TypedDict):
    name: str
    crno: NotRequired[str | None]
    homepage: NotRequired[str | None]
    refresh: NotRequired[bool]


@_strict
class StartAnalysisResponse(TypedDict):
    jobId: str
    companyId: str
    started: bool


@_strict
class RivalPick(TypedDict):
    key: str
    name: str
    nameEn: NotRequired[str | None]
    crno: NotRequired[str | None]


@_strict
class RivalsDeepRequest(TypedDict):
    rivals: list[RivalPick]


@_strict
class SalesRequest(TypedDict):
    keywords: list[str]


@_strict
class RunSectionResponse(TypedDict):
    jobId: str
    key: SectionKey
    started: bool


@_strict
class CompanyJobResponse(TypedDict):
    jobId: str
    companyId: str
    startedAt: str
    status: Literal["running"]


@_strict
class ExampleResponse(TypedDict):
    companyId: str
    jobId: str
    name: str
    analyzedAt: str


@_strict
class ApiError(TypedDict):
    detail: str
    code: ApiErrorCode
    retryAt: str | None


@_strict
class ApiUsage(TypedDict):
    used: int
    limit: int | None
    remaining: int | None


@_strict
class UsageToday(TypedDict):
    date: str                     # YYYY-MM-DD (한국 시간)
    resetAt: str                  # 다음 날 0시(한국 시간)
    apis: dict[str, ApiUsage]     # growth.limits.API_NAMES 의 모든 이름


@_strict
class HealthKeys(TypedDict):
    liner: bool
    dataGoKr: bool
    naver: bool
    openalex: bool


@_strict
class HealthAnalysis(TypedDict):
    running: int
    maxRunning: int


@_strict
class HealthResponse(TypedDict):
    ok: bool
    hasKey: bool
    paidUsed: int
    paidLimit: int
    extractModel: str
    matchModel: str
    keys: HealthKeys
    usage: UsageToday
    analysis: HealthAnalysis
    contractVersion: int


# ---------------------------------------------------------------- 유지하는 엔드포인트(모양은 지금 코드 그대로)

@_strict
class NoticeCompany(TypedDict):
    """POST /api/notice/analyze, /api/gp/brief 의 company. api/main.py Company 와 같은 칸·길이 제한."""
    name: str
    region: str
    biz: str
    founded: str
    industry: str
    employees: str
    revenue: str
    need: str
    notes: str


Verdict = Literal["충족", "미충족", "확인 필요", "판단 대상 아님"]


@_strict
class NoticeProgram(TypedDict):
    id: str
    title: str
    url: str
    docUrl: str


@_strict
class NoticeDoc(TypedDict):
    kind: str
    pages: int | None
    chars: int
    truncated: bool


@_strict
class NoticeExtraction(TypedDict):
    summary: str
    notStated: list[str]
    doc: NoticeDoc
    model: str
    extractedAt: str
    dropped: int
    cached: bool


@_strict
class CheckRow(TypedDict):
    field: str
    requirement: str
    quote: str
    verdict: Verdict
    reason: str


@_strict
class NoticeMatch(TypedDict):
    overall: Literal["신청 검토 가능", "대상 아님", "확인 후 판단"]
    overallReason: str
    adjusted: bool
    rows: list[CheckRow]
    questions: list[str]          # 최대 5
    documents: list[str]          # 최대 8
    model: str
    costUsd: float | None
    elapsedSec: float | None


@_strict
class NoticeAnalysis(TypedDict):
    program: NoticeProgram
    extraction: NoticeExtraction
    match: NoticeMatch


GpFactKind = Literal["투자 분야", "투자 단계", "투자 사례", "펀드 결성", "제안 경로", "기타"]


@_strict
class GpFact(TypedDict):
    kind: GpFactKind
    text: str
    quote: str
    sourceUrl: str
    sourceHost: str


@_strict
class GpFit(TypedDict):
    text: str
    fact: int                     # facts 의 순번(0부터)


@_strict
class GpSource(TypedDict):
    title: str
    url: str
    host: str


@_strict
class GpBrief(TypedDict):
    gp: str
    facts: list[GpFact]           # 최대 4
    fit: list[GpFit]              # 최대 2
    questions: list[str]          # 최대 2
    sources: list[GpSource]
    searched: int
    model: NotRequired[str]       # 검색 결과가 0건이면 없다(지금 코드)


# ---------------------------------------------------------------- 계약 규칙 함수(계약 1.4·7절)

_CORP_WORDS = re.compile(r"주식회사|유한회사|유한책임회사|\(주\)|\(유\)|inc\.?|corp\.?|co\.,?\s*ltd\.?|ltd\.?|llc", re.I)
_PUNCT = re.compile(r"[\s·.,&()\-_'\"]")
CRNO_RE = re.compile(r"^\d{13}$")
COMPANY_ID_RE = re.compile(r"^(\d{13}|n-[0-9a-f]{16})$")
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def norm_name(s: str | None) -> str:
    """회사·투자기관 이름 견주기용 열쇠. NFKC → 법인 표기 제거 → 공백·문장부호 제거 → 소문자."""
    t = unicodedata.normalize("NFKC", s or "")
    t = _CORP_WORDS.sub("", t)
    return _PUNCT.sub("", t).lower()


def company_id_for(name: str, crno: str | None = None) -> str:
    """회사 id. 법인등록번호(숫자 13자리)가 있으면 그것, 없으면 "n-" + sha256(norm_name(name)) 앞 16자.

    이름을 정규화한 결과가 빈 글이면 ValueError(엔드포인트는 400 bad_request).
    """
    digits = re.sub(r"\D", "", crno or "")
    if CRNO_RE.fullmatch(digits):
        return digits
    key = norm_name(name)
    if not key:
        raise ValueError("회사 이름이 비어 있습니다")
    return "n-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


_SIDO_PREFIX = (("서울", "서울"), ("부산", "부산"), ("대구", "대구"), ("인천", "인천"), ("광주", "광주"), ("대전", "대전"),
                ("울산", "울산"), ("세종", "세종"), ("경기", "경기"), ("강원", "강원"), ("충청북", "충북"), ("충북", "충북"),
                ("충청남", "충남"), ("충남", "충남"), ("전라북", "전북"), ("전북", "전북"), ("전라남", "전남"), ("전남", "전남"),
                ("경상북", "경북"), ("경북", "경북"), ("경상남", "경남"), ("경남", "경남"), ("제주", "제주"))


def split_address(address: str | None) -> tuple[str | None, str | None]:
    """주소 → (시·도, 시·군·구). 첫 낱말의 앞부분으로 시·도를 정하고, 이어지는 '시·군·구'로 끝나는 낱말(최대 2개)을 붙인다.

    예: "서울특별시 강남구 테헤란로 1" → ("서울", "강남구"), "경기도 성남시 분당구 판교로" → ("경기", "성남시 분당구"),
    "세종특별자치시 한누리대로 1" → ("세종", None). 시·도를 못 찾으면 (None, None).
    """
    words = (address or "").split()
    if not words:
        return None, None
    region = next((short for prefix, short in _SIDO_PREFIX if words[0].startswith(prefix)), None)
    if region is None:
        return None, None
    parts = []
    for w in words[1:3]:
        if w[-1:] in ("시", "군", "구"):
            parts.append(w)
        else:
            break
    return region, (" ".join(parts) or None)


def won_display(value: float | None) -> str | None:
    """원 단위 금액 → Value.display 글. 1천만 원 이상은 억원 소수 첫째 자리, 미만은 만원 정수(천 단위 쉼표)."""
    if value is None:
        return None
    if abs(value) >= 1e7:
        return f"{value / 1e8:,.1f}억원"
    return f"{value / 1e4:,.0f}만원"
