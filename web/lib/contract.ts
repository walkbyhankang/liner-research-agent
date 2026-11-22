// 성장노트 서버·화면 데이터 계약(TypeScript 타입). 본문은 docs/contract.md, 서버 쪽 같은 타입은 growth/contract.py.
// 셋이 다르면 docs/contract.md 를 따른다. 화면 코드는 이 파일의 이름만 쓴다(한글 키 없음).
//
// 규칙(계약 1절): 모든 키는 언제나 들어 있다. 값이 없으면 null, 목록은 [] 이다(예외: GpBrief.model).
// 글은 모두 평문이다. HTML 로 해석하지 않는다. url 은 http·https 이거나 null 이다(화면도 한 번 더 확인한다).
// 시각은 한국 시간 ISO 8601("2026-11-22T20:46:24+09:00"), 날짜는 "YYYY-MM-DD", 달은 "YYYY-MM".

export const CONTRACT_VERSION = 1;

// ---------------------------------------------------------------- 값 목록

export const STATUSES = ["confirmed", "reported", "inferred", "conflicting", "unavailable", "reference"] as const;
export type Status = (typeof STATUSES)[number];
/** 화면 낱말(screens.md 1.3). 브라우저에서 고친 값은 따로 "직접 입력". */
export const STATUS_LABEL: Record<Status, string> = {
  confirmed: "원문 확인", reported: "보도", inferred: "추정", conflicting: "엇갈림", unavailable: "미확보", reference: "참고",
};
export const EDITED_LABEL = "직접 입력";

export const SECTION_KEYS = ["identity", "official", "profile", "facts", "funding_history", "news", "patents", "papers", "rivals_deep", "sales"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export const BASIC_SECTIONS = ["identity", "official", "profile", "facts", "funding_history", "news", "patents"] as const;
export const ON_DEMAND_SECTIONS = ["papers", "rivals_deep", "sales"] as const;

export type SectionStatus = "waiting" | "running" | "done" | "partial" | "unavailable" | "idle";
export const TERMINAL_SECTION_STATUSES: readonly SectionStatus[] = ["done", "partial", "unavailable"];
export type JobStatus = "running" | "done" | "interrupted";

export const SECTION_ERROR_CODES = ["daily_limit", "section_limit", "no_corp", "no_data", "upstream_error", "timeout", "interrupted", "missing_config"] as const;
export type SectionErrorCode = (typeof SECTION_ERROR_CODES)[number];

export const API_ERROR_CODES = [
  "bad_request", "not_found", "conflict", "section_running", "section_not_ready", "example_readonly", "daily_limit", "refresh_limit",
  "rate_limited", "busy", "missing_config", "upstream_error", "analysis_failed", "not_implemented", "internal",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const NEWS_CATEGORIES = ["기술개발", "해외 진출", "사업제휴", "수주·계약", "경영진·인터뷰", "정부 관련", "투자유치", "제품 출시", "매출·실적", "기타 동향"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export type FundFieldId = "early" | "ai" | "bio" | "content" | "mfg" | "green" | "local" | "ip" | "impact" | "scale";
export type BizTypeId = "venture" | "sme" | "micro";

export const PENDING_KEYS = ["employees", "revenue.web", "industry.web", "founded.web", "region.web", "investors.confirmed", "rivals.facts"] as const;
export type PendingKey = (typeof PENDING_KEYS)[number];

/** 서버가 expectedSeconds 를 주지 않을 때 쓰는 값(단락 startedAt 기준 초). null 이면 시간을 쓰지 않는다. */
export const EXPECTED_SECONDS: Record<SectionKey, number | null> = {
  identity: 3, official: 10, profile: 25, facts: 150, funding_history: 30, news: 45, patents: 35, papers: null, rivals_deep: null, sales: null,
};

export const JOB_ID_RE = /^[0-9a-f]{32}$/;
export const COMPANY_ID_RE = /^(\d{13}|n-[0-9a-f]{16})$/;

// ---------------------------------------------------------------- 출처와 값

export type Source = {
  /** "{org} {name} ({kind})". 화면 출처 줄 앞부분에 그대로 쓴다 */
  label: string;
  org: string;
  name: string;
  kind: string;
  /** 기준일 글. 예: "2026-11-22 조회", "2022 사업연도" */
  asOf: string | null;
  /** 값의 기준. 예: "별도", "연결" */
  basis: string | null;
  url: string | null;
};

/** 복사·인쇄·화면 읽기용 한 줄: "{label} · {asOf}, {basis}" */
export const sourceLine = (s: Source) => [s.label, [s.asOf, s.basis].filter(Boolean).join(", ")].filter(Boolean).join(" · ");

export type ValueAlt = { display: string; raw: string | number | null; source: Source; quote: string | null };

export type Value = {
  /** 화면 글(단위 포함). unavailable 이면 null */
  display: string | null;
  /** 계산·대조에 쓰는 값. conflicting 이면 values[usedIndex].raw */
  raw: string | number | null;
  status: Status;
  source: Source | null;
  quote: string | null;
  note: string | null;
  /** unavailable 일 때 짧은 사유 */
  reason: string | null;
  /** conflicting 일 때만 목록. 화면은 모두 보이고 어느 쪽이 맞다고 쓰지 않는다 */
  values: ValueAlt[] | null;
  /** conflicting 일 때 업력 계산·자격 대조에 쓰는 값의 위치. 없으면 null(계산·대조에 쓰지 않는다) */
  usedIndex: number | null;
};

// ---------------------------------------------------------------- 법인

export type Corp = {
  companyId: string;
  crno: string;
  bzno: string | null;
  name: string;
  names: string[];
  nameEn: string | null;
  ceo: string | null;
  founded: string | null;
  address: string | null;
  region: string | null;
  district: string | null;
  homepage: string | null;
  industry: string | null;
  mainBiz: string | null;
  market: string | null;
  updated: string | null;
  exact: boolean;
  snapshotAt: string | null;
};

export type CorpSearchResponse = { query: string; candidates: Corp[]; queriedAt: string };
export type IdentityResult = { corp: Corp; otherCorps: Corp[]; queriedAt: string };

// ---------------------------------------------------------------- official

export type FinancialRow = {
  year: string;
  periodEnd: string | null;
  basis: string;
  basisShort: "연결" | "별도" | null;
  currency: string;
  /** 금액은 원 단위 */
  revenue: number | null;
  operatingIncome: number | null;
  pretaxIncome: number | null;
  netIncome: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  capital: number | null;
  debtRatioPct: number | null;
  revenueGrowthPct: number | null;
  operatingMarginPct: number | null;
};

export type NpsMonth = { month: string; members: number | null; joined: number | null; left: number | null; change: number | null };
export type NpsSummary = { first: number; latest: number; change: number; changePct: number | null; period: string; joinedTotal: number; leftTotal: number };
export type Nps = {
  monthly: NpsMonth[];
  summary: NpsSummary | null;
  workplace: { name: string; bznoMasked: string; industry: string | null; address: string | null };
  note: string;
};

export type OfficialResult = {
  crno: string;
  financials: FinancialRow[];
  financialsAll: FinancialRow[];
  financialsReason: string | null;
  nps: Nps | null;
  npsReason: string | null;
  queriedAt: string;
};

// ---------------------------------------------------------------- profile

export type TechKeyword = { ko: string; en: string | null };
export type ProfileCompetitor = { name: string; nameEn: string | null; registeredNameKo: string | null; relation: string | null; reason: string | null };
export type SourceDoc = { title: string; url: string | null; date: string | null };

export type ProfileResult = {
  nameKo: string | null;
  nameEn: string | null;
  aliases: string[];
  industry: string | null;
  business: string | null;
  products: { name: string; desc: string | null }[];
  coreTech: string[];
  statusNotes: string[];
  techKeywords: TechKeyword[];
  govKeywords: string[];
  bidKeywords: string[];
  fundField: FundFieldId | null;
  /** 화면에 쓰지 않는다 */
  stage: string | null;
  competitors: ProfileCompetitor[];
  sourceCount: number;
  sources: SourceDoc[];
};

// ---------------------------------------------------------------- facts

export type FactStatus = "confirmed" | "reported" | "inferred" | "conflicting";
export type FactsResult = {
  fields: { key: "founded" | "region" | "industry" | "employees" | "revenue"; label: string; value: string; status: FactStatus; sourceUrl: string | null; evidence: string | null; note: string | null }[];
  investors: { name: string; round: string | null; date: string | null; status: FactStatus; sourceUrl: string | null }[];
  /** domestic=false 인 것은 화면 어디에도 쓰지 않는다. 경쟁사는 merged.rivals 만 쓴다 */
  competitors: { name: string; relation: string | null; products: string | null; revenue: string | null; employees: string | null; funding: string | null; asOf: string | null; status: FactStatus; sourceUrl: string | null; domestic: boolean }[];
  searches: number;
  pagesRead: number;
};

// ---------------------------------------------------------------- funding_history

export type Round = {
  id: string;
  date: string | null;
  reportedDate: string | null;
  round: string | null;
  amount: string | null;
  amountValue: number | null;
  currency: string | null;
  otherAmounts: string[];
  investors: string[];
  lead: string[];
  entity: string | null;
  entityMatch: "exact" | "web";
  sourceType: string;
  sources: { type: "Premium" | "Web"; label: string; url: string | null }[];
  raw: string | null;
  summary: string | null;
};
export type Cumulative = {
  basis: "pdl_total" | "rounds_sum" | "rounds_partial_sum" | "none";
  label: string;
  /** 통화별 합. 통화를 바꾸거나 더하지 않는다 */
  byCurrency: Record<string, number>;
  roundsWithAmount: number | null;
  roundsTotal: number;
  entity: string | null;
  note: string | null;
};
export type FhSummary = {
  roundCount: number;
  investorCount: number;
  latest: { date: string | null; round: string | null; amount: string | null } | null;
  cumulative: Cumulative;
};
export type FundingHistoryResult = {
  company: string;
  nameEn: string | null;
  rounds: Round[];
  investors: { name: string; roundCount: number; roundLabels: string[]; lastDate: string | null; lead: boolean }[];
  summary: FhSummary;
  /** 이름만 비슷한 다른 법인. 투자자 판정에 쓰지 않는다 */
  relatedEntities: { name: string; website: string | null; location: string | null; totalRaised: string | null; fundingStage: string | null; roundCount: number }[];
  webUsed: boolean;
  queriedAt: string;
};

// ---------------------------------------------------------------- news

export type Article = {
  id: string;
  date: string | null;
  title: string;
  description: string | null;
  outlet: string | null;
  url: string | null;
  naverUrl: string | null;
  categories: NewsCategory[];
  relatedCount: number;
};
/** 10개 분류가 모두 있다(0 포함). 건수 많은 순, 같으면 NEWS_CATEGORIES 순 */
export type CategoryCount = { category: NewsCategory; count: number };
export type NewsEvent = {
  date: string | null;
  category: string;
  title: string;
  detail: string | null;
  articleId: string | null;
  articleTitle: string | null;
  articleUrl: string | null;
  outlet: string | null;
  articleDate: string | null;
};
export type NewsResult = {
  period: string;
  rawCount: number;
  apiCounts: Record<string, number>;
  articleTotal: number;
  categoryCounts: CategoryCount[];
  /** 작업 응답에는 최신 20건. 나머지는 GET /api/analysis/{jobId}/news */
  articles: Article[];
  events: NewsEvent[];
  trends: string[];
  /** 화면에 쓰지 않는다 */
  longSummary: string | null;
  errors: string[];
};
export type NewsPage = {
  jobId: string;
  offset: number;
  limit: number;
  categories: NewsCategory[];
  total: number;
  articleTotal: number;
  categoryCounts: CategoryCount[];
  items: Article[];
};

// ---------------------------------------------------------------- patents

export type Patent = {
  id: string;
  title: string;
  assignee: string | null;
  applicationNo: string | null;
  filingDate: string | null;
  publicationNo: string | null;
  publicationDate: string | null;
  registrationNo: string | null;
  registrationDate: string | null;
  legalStatus: string | null;
  cpc: string[];
  techFields: string[];
  abstract: string | null;
  url: string | null;
};
export type PatentsResult = {
  summary: { total: number; registered: number; recent5: number; byYear: Record<string, number>; withFilingDate: number; noFilingDate: number };
  patents: Patent[];
  mentions: { pubNo: string; title: string; assignee: string | null; filingDate: string | null; url: string | null }[];
  pagesChecked: number;
  pagesLimit: number;
  candidatesLeft: number;
  basis: string;
  note: string;
  errors: string[];
  queriedAt: string;
};

// ---------------------------------------------------------------- papers

export type Paper = {
  id: string;
  title: string;
  year: number | null;
  date: string | null;
  authors: string | null;
  affiliations: string | null;
  venue: string | null;
  citations: number;
  url: string | null;
  source: "OpenAlex" | "Liner Scholar";
  important: string | null;
};
export type PapersResult = {
  keywordsUsed: string[];
  topics: {
    name: string;
    en: string | null;
    byYear: Record<string, number>;
    trend: string;
    institutions: { name: string; count: number }[];
    papers: Paper[];
    summary: string | null;
    relevance: string | null;
    keyPapers: { title: string; point: string; url: string | null }[];
  }[];
  company: { mode: string; direct: boolean; countBasis: string | null; works: Paper[]; byYear: Record<string, number>; mentionByYear: Record<string, number>; error: string | null };
  queriedAt: string;
};

// ---------------------------------------------------------------- rivals_deep

export type RivalDeep = {
  key: string;
  name: string;
  nameEn: string | null;
  corp: Corp | null;
  financials: FinancialRow[];
  financialsReason: string | null;
  nps: Nps | null;
  npsReason: string | null;
  funding: { rounds: Round[]; summary: FhSummary; investors: string[] } | null;
  fundingReason: string | null;
  patents: { total: number; registered: number; byYear: Record<string, number> } | null;
  patentsReason: string | null;
  summary: { business: string | null; productsTech: string | null; recentChanges: string[] } | null;
  errors: string[];
};
export type RivalsDeepResult = {
  rivalSet: string[];
  rivals: RivalDeep[];
  rivalInvestors: { rivalKey: string; rivalName: string; investors: string[] }[];
  queriedAt: string;
};

// ---------------------------------------------------------------- sales

export type Bid = {
  id: string;
  title: string;
  agency: string;
  kind: "물품" | "용역";
  summary: string | null;
  amount: string;
  period: string;
  bidBegin: string | null;
  bidClose: string | null;
  deadline: string | null;
  status: "open" | "upcoming" | "closed" | "unknown";
  condition: string;
  /** "high" 는 핵심 낱말 일치. 이 값의 글자는 화면에 쓰지 않는다 */
  relevance: "high" | "normal";
  keywords: string[];
  url: string | null;
  noticeDate: string | null;
};
export type SalesResult = {
  keywords: string[];
  strongKeywords: string[];
  period: string;
  items: Bid[];
  calls: number;
  errorCount: number;
  skipped: number;
  errors: string[];
  queriedAt: string;
};

// ---------------------------------------------------------------- 단락 봉투

export type SectionError = { code: SectionErrorCode; message: string; source: string | null; retryAt: string | null };
export type SectionPaid = { search: number; premium: number; model: number; scholar: number };
export type Rerun = { status: "running" | "failed"; startedAt: string; seconds: number | null; error: SectionError | null };

export type SectionEnvelope<R> = {
  key: SectionKey;
  status: SectionStatus;
  stage: string | null;
  startedAt: string | null;
  seconds: number | null;
  expectedSeconds: number | null;
  analyzedAt: string | null;
  /** done·partial 은 값이 있다. unavailable 은 no_data 일 때만 값이 있다(빈 목록과 기간 등). 다시 실행 중에는 이전 결과 */
  result: R | null;
  error: SectionError | null;
  /** 지금 POST …/sections/{key} 를 보내도 되는가. false 이고 error.code 가 daily_limit 이면 단추를 비활성으로 보인다 */
  retryable: boolean;
  waitingFor: SectionKey[];
  rerun: Rerun | null;
  paid: SectionPaid;
};

export type Sections = {
  identity: SectionEnvelope<IdentityResult>;
  official: SectionEnvelope<OfficialResult>;
  profile: SectionEnvelope<ProfileResult>;
  facts: SectionEnvelope<FactsResult>;
  funding_history: SectionEnvelope<FundingHistoryResult>;
  news: SectionEnvelope<NewsResult>;
  patents: SectionEnvelope<PatentsResult>;
  papers: SectionEnvelope<PapersResult>;
  rivals_deep: SectionEnvelope<RivalsDeepResult>;
  sales: SectionEnvelope<SalesResult>;
};

// ---------------------------------------------------------------- merged

export type TwoValues = { official: Value | null; web: Value | null };
export type MergedInvestor = {
  key: string;
  name: string;
  aliases: string[];
  /** "이미 투자함" 판정은 이 목록만 쓴다(confirmed·reported 만 들어 있다) */
  status: "confirmed" | "reported";
  roundCount: number;
  roundLabels: string[];
  lastDate: string | null;
  lead: boolean;
  foundIn: ("funding_history" | "facts")[];
  sources: Source[];
};
export type MergedRival = {
  key: string;
  name: string;
  nameEn: string | null;
  registeredNameKo: string | null;
  relation: string | null;
  reason: string | null;
  status: "confirmed" | "reported" | "inferred";
  foundIn: ("profile" | "facts")[];
  products: string | null;
  employees: string | null;
  revenue: string | null;
  funding: string | null;
  sources: Source[];
};
/** null 인 값은 그 값을 채울 단락이 아직 끝나지 않았다는 뜻("확인 중"). 끝났는데 없으면 status "unavailable" 인 Value */
export type Merged = {
  region: Value | null;
  district: string | null;
  headquarters: Value | null;
  ceo: Value | null;
  founded: Value | null;
  bizType: Value;
  bizTypeHint: { id: BizTypeId; reason: string } | null;
  industry: TwoValues;
  employees: Value | null;
  revenue: TwoValues;
  npsLatest: Value | null;
  patentCount: Value | null;
  investors: MergedInvestor[];
  rivals: MergedRival[];
  techKeywords: TechKeyword[];
  programKeywords: string[];
  fundField: Value | null;
  bidKeywords: string[];
  pending: PendingKey[];
};

// ---------------------------------------------------------------- 작업 응답

export type Estimate = { seconds: number | null; liner: number; perRival: number | null };
export type AnalysisJob = {
  contractVersion: number;
  jobId: string;
  companyId: string;
  query: string;
  company: { name: string; crno: string | null };
  status: JobStatus;
  /** 작업이 진행 중이거나 어느 단락·다시 실행이 진행 중이면 true. true 인 동안 1.5초마다 다시 묻는다 */
  busy: boolean;
  startedAt: string;
  analyzedAt: string | null;
  isExample: boolean;
  sections: Sections;
  merged: Merged;
  paid: { liner: SectionPaid };
  estimates: { full: Estimate; sections: Record<SectionKey, Estimate> };
  refresh: { remainingToday: number; limitPerDay: number };
};

/** 서버가 estimates 를 주지 않을 때(이 값은 growth/contract.py ESTIMATES 와 같다) */
export const DEFAULT_ESTIMATES: AnalysisJob["estimates"] = {
  full: { seconds: 150, liner: 19, perRival: null },
  sections: {
    identity: { seconds: 3, liner: 0, perRival: null },
    official: { seconds: 10, liner: 0, perRival: null },
    profile: { seconds: 25, liner: 4, perRival: null },
    facts: { seconds: 150, liner: 8, perRival: null },
    funding_history: { seconds: 10, liner: 2, perRival: null },
    news: { seconds: 20, liner: 3, perRival: null },
    patents: { seconds: 15, liner: 2, perRival: null },
    papers: { seconds: null, liner: 7, perRival: null },
    rivals_deep: { seconds: null, liner: 34, perRival: 7 },
    sales: { seconds: null, liner: 0, perRival: null },
  },
};

// ---------------------------------------------------------------- 요청과 짧은 응답

export type StartAnalysisRequest = { name: string; crno?: string | null; homepage?: string | null; refresh?: boolean };
export type StartAnalysisResponse = { jobId: string; companyId: string; started: boolean };
export type RivalPick = { key: string; name: string; nameEn?: string | null; crno?: string | null };
export type RivalsDeepRequest = { rivals: RivalPick[] };
export type SalesRequest = { keywords: string[] };
export type RunSectionResponse = { jobId: string; key: SectionKey; started: boolean };
export type CompanyJobResponse = { jobId: string; companyId: string; startedAt: string; status: "running" };
export type ExampleResponse = { companyId: string; jobId: string; name: string; analyzedAt: string };

/** 오류 본문. 단, 요청 모양이 틀린 422 는 FastAPI 기본 모양({detail: [...]})이라 detail 이 글이 아니다 */
export type ApiError = { detail: string; code: ApiErrorCode; retryAt: string | null };

export type ApiUsage = { used: number; limit: number | null; remaining: number | null };
export type HealthResponse = {
  ok: boolean;
  hasKey: boolean;
  paidUsed: number;
  paidLimit: number;
  extractModel: string;
  matchModel: string;
  keys: { liner: boolean; dataGoKr: boolean; naver: boolean; openalex: boolean };
  usage: { date: string; resetAt: string; apis: Record<string, ApiUsage> };
  analysis: { running: number; maxRunning: number };
  contractVersion: number;
};

// ---------------------------------------------------------------- 유지하는 엔드포인트(지금 코드의 모양)

/** POST /api/notice/analyze, /api/gp/brief 의 company(api/main.py Company). 만드는 법은 계약 13절 */
export type NoticeCompany = { name: string; region: string; biz: string; founded: string; industry: string; employees: string; revenue: string; need: string; notes: string };
export const NOTICE_COMPANY_LIMITS: Record<keyof NoticeCompany, number> = { name: 60, region: 20, biz: 20, founded: 7, industry: 80, employees: 30, revenue: 60, need: 120, notes: 400 };

export type Verdict = "충족" | "미충족" | "확인 필요" | "판단 대상 아님";
export type NoticeAnalysis = {
  program: { id: string; title: string; url: string; docUrl: string };
  extraction: { summary: string; notStated: string[]; doc: { kind: string; pages: number | null; chars: number; truncated: boolean }; model: string; extractedAt: string; dropped: number; cached: boolean };
  match: {
    overall: "신청 검토 가능" | "대상 아님" | "확인 후 판단";
    overallReason: string;
    adjusted: boolean;
    rows: { field: string; requirement: string; quote: string; verdict: Verdict; reason: string }[];
    questions: string[];
    documents: string[];
    model: string;
    costUsd: number | null;
    elapsedSec: number | null;
  };
};

export type GpFactKind = "투자 분야" | "투자 단계" | "투자 사례" | "펀드 결성" | "제안 경로" | "기타";
export type GpBrief = {
  gp: string;
  facts: { kind: GpFactKind; text: string; quote: string; sourceUrl: string; sourceHost: string }[];
  fit: { text: string; fact: number }[];
  questions: string[];
  sources: { title: string; url: string; host: string }[];
  searched: number;
  /** 검색 결과가 0건이면 없다 */
  model?: string;
};

// ---------------------------------------------------------------- 작은 확인 함수

/** 받은 본문이 이 계약의 작업 응답처럼 보이는지(버전·id·단락 10개). 깊은 검사는 하지 않는다. */
export function isAnalysisJob(v: unknown): v is AnalysisJob {
  const o = v as AnalysisJob | null;
  return Boolean(
    o && o.contractVersion === CONTRACT_VERSION && typeof o.jobId === "string" && JOB_ID_RE.test(o.jobId) &&
      typeof o.companyId === "string" && COMPANY_ID_RE.test(o.companyId) && o.sections && o.merged &&
      SECTION_KEYS.every((k) => o.sections[k] && o.sections[k].key === k),
  );
}

/** 오류 본문에서 화면에 보일 글을 고른다. 글이 아니면(422 등) 대신 쓸 글을 돌려준다. */
export function errorDetail(body: unknown, fallback: string): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}
