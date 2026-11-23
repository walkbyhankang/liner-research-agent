// 투자 미팅 예상 질문(19개)과 실사 대비 자료(26개) 목록.
//
// 원본: anthropics/financial-services (Apache License 2.0, https://github.com/anthropics/financial-services, 커밋 3e32c22)
//   - 예상 질문: dd-meeting-prep 스킬
//   - 실사 대비 자료: dd-checklist 스킬
// 변경함: 한국어로 다시 썼고, 투자자가 아니라 회사가 준비하는 쪽으로 바꿨다. 미국·EU 규제 항목, 진행 단계(요청됨·받음·검토 중),
// 우선순위, 위험 등급을 뺐고, 성장노트 회사 분석에서 관련 자료를 붙이는 칸을 더했다. 자세한 고지는 저장소 루트 THIRD_PARTY_NOTICES.md.
//
// 문구는 docs/ux/screens.md 6.2절 그대로다. 판정·합계·비율을 만들지 않는다(사용자가 누르는 "준비함"만 있다).
import type { AnalysisJob } from "./contract.ts";
import type { ScreenKey } from "./view.ts";

/** 관련 자료 한 줄. to 가 있으면 누르면 그 단락(회사 분석)이나 경쟁사 분석 화면("rivals")으로 간다 */
export type Related = { text: string; to: ScreenKey | "rivals" | null };
/** 관련 자료 링크 주소. 경쟁사는 2026-11-23부터 회사 분석 단락이 아니라 경쟁사 분석 화면이다(screens 4B) */
export const relatedHref = (cid: string, to: ScreenKey | "rivals") => (to === "rivals" ? `/c/${cid}/rivals` : `/c/${cid}#${to}`);
export type PrepContext = { job: AnalysisJob; confirmedRivals: number; deepDone: boolean; papersDone: boolean };
type Resolver = (c: PrepContext) => Related[];

export type Question = { id: string; group: string; text: string; related: Resolver };
export type DdItem = { id: string; group: string; text: string; related: Resolver };

const fin = (c: PrepContext) => c.job.sections.official.result?.financials ?? [];
const years = (c: PrepContext) => {
  const f = fin(c);
  return f.length ? `${f[0].year}~${f[f.length - 1].year}` : "";
};
const rounds = (c: PrepContext) => c.job.sections.funding_history.result?.summary.roundCount ?? 0;
const events = (c: PrepContext) => c.job.sections.news.result?.events.length ?? 0;
const contractNews = (c: PrepContext) => c.job.sections.news.result?.categoryCounts.find((x) => x.category === "수주·계약")?.count ?? 0;
const patents = (c: PrepContext) => (typeof c.job.merged.patentCount?.raw === "number" ? c.job.merged.patentCount.raw : 0);
const coreTech = (c: PrepContext) => c.job.sections.profile.result?.coreTech.length ?? 0;
const none: Resolver = () => [];

export const QUESTION_GROUPS = ["사업 개요", "매출과 성장", "경쟁", "팀과 운영", "재무", "앞으로의 계획"] as const;

export const QUESTIONS: Question[] = [
  { id: "q1", group: "사업 개요", text: "회사를 세운 계기와 지금까지의 주요 이정표를 설명해 주세요.", related: (c) => [
    ...(c.job.merged.founded?.display ? [{ text: `설립 ${c.job.merged.founded.display}`, to: "overview" as const }] : []),
    ...(rounds(c) ? [{ text: `투자 라운드 ${rounds(c)}건`, to: "investment" as const }] : []),
    ...(events(c) ? [{ text: `중요 사건 ${events(c)}개`, to: "news" as const }] : []),
  ] },
  { id: "q2", group: "사업 개요", text: "이 분야를 처음 듣는 사람에게 사업을 어떻게 설명하나요?", related: (c) => (c.job.sections.profile.result?.business ? [{ text: "개요 사업 설명", to: "overview" }] : []) },
  { id: "q3", group: "매출과 성장", text: "매출을 고객, 제품, 지역별로 나누면 어떻게 되나요?", related: (c) => [
    ...(fin(c).length ? [{ text: `매출 ${fin(c).length}개 사업연도`, to: "finance" as const }] : []),
    { text: "고객·제품별 매출은 공개 자료에 없습니다", to: null },
  ] },
  { id: "q4", group: "매출과 성장", text: "성장을 이끄는 것은 가격, 판매량, 새 고객 중 무엇인가요?", related: (c) => (fin(c).length ? [{ text: `매출 ${fin(c).length}개 사업연도`, to: "finance" }] : []) },
  { id: "q5", group: "매출과 성장", text: "영업은 어떤 과정을 거치고 얼마나 걸리나요? 계약 성사 비율은 어떻게 바뀌어 왔나요?", related: (c) => (contractNews(c) ? [{ text: `"수주·계약" 분류 기사 ${contractNews(c)}건`, to: "news" }] : []) },
  { id: "q6", group: "매출과 성장", text: "앞으로 3~5년 동안 가장 큰 성장 기회는 어디인가요?", related: none },
  { id: "q7", group: "경쟁", text: "어떤 회사에 계약을 놓치고, 그 이유는 무엇인가요?", related: (c) => (c.confirmedRivals ? [{ text: `고른 경쟁사 ${c.confirmedRivals}곳`, to: "rivals" }] : []) },
  { id: "q8", group: "경쟁", text: "다른 회사가 쉽게 따라 하기 어려운 강점은 무엇인가요?", related: (c) => [
    ...(patents(c) ? [{ text: `확인된 특허 ${patents(c)}건`, to: "tech" as const }] : []),
    ...(coreTech(c) ? [{ text: "핵심 기술", to: "overview" as const }] : []),
  ] },
  { id: "q9", group: "경쟁", text: "고객은 우리 회사와 다른 선택지를 어떤 기준으로 비교하나요?", related: (c) => (c.deepDone ? [{ text: "경쟁사 비교 자료", to: "rivals" }] : []) },
  { id: "q10", group: "팀과 운영", text: "핵심 인력은 누구이고, 조직은 어떻게 짜여 있나요?", related: (c) => [
    ...(c.job.sections.official.result?.nps ? [{ text: "국민연금 가입자 12개월 (참고)", to: "finance" as const }] : []),
    ...(c.job.merged.employees?.display ? [{ text: `직원 수 ${c.job.merged.employees.display} (보도)`, to: "overview" as const }] : []),
  ] },
  { id: "q11", group: "팀과 운영", text: "지금 뽑고 있는 자리는 무엇이고, 가장 뽑기 어려운 자리는 어디인가요?", related: (c) => {
    const s = c.job.sections.official.result?.nps?.summary;
    return s ? [{ text: `국민연금 신규 취득 ${s.joinedTotal}명, 상실 ${s.leftTotal}명 12개월 합계 (참고)`, to: "finance" }] : [];
  } },
  { id: "q12", group: "팀과 운영", text: "운영에서 가장 걱정되는 점은 무엇인가요?", related: none },
  { id: "q13", group: "재무", text: "이익률이 바뀐 이유는 무엇인가요?", related: (c) => (fin(c).length ? [{ text: `영업이익 ${fin(c).length}개 사업연도`, to: "finance" }] : []) },
  { id: "q14", group: "재무", text: "한 번만 생긴 수익이나 비용이 있나요?", related: none },
  { id: "q15", group: "재무", text: "운전자금이 계절에 따라 달라지나요? 설비 투자는 유지용과 성장용으로 어떻게 나뉘나요?", related: (c) => (fin(c).length ? [{ text: `부채총계, 자본총계 ${fin(c).length}개 사업연도`, to: "finance" }] : []) },
  { id: "q16", group: "앞으로의 계획", text: "내년 사업 계획은 무엇이고, 그 계획의 전제는 무엇인가요?", related: none },
  { id: "q17", group: "앞으로의 계획", text: "그 전제 가운데 가장 자신 있는 것과 자신 없는 것은 무엇인가요?", related: none },
  { id: "q18", group: "앞으로의 계획", text: "계획보다 크게 잘되거나 못 되려면 무엇이 달라져야 하나요?", related: none },
  { id: "q19", group: "앞으로의 계획", text: "이번 투자금은 어디에 쓰고, 그 결과로 무엇이 달라지나요?", related: (c) => (rounds(c) ? [{ text: "누적 투자, 최근 라운드", to: "investment" }] : []) },
];

export const DD_GROUPS = ["재무", "사업", "법무", "운영", "인사", "IT", "ESG"] as const;

export const DD_ITEMS: DdItem[] = [
  { id: "d1", group: "재무", text: "최근 3개 사업연도 재무제표 (감사보고서가 있으면 함께)", related: (c) => (fin(c).length ? [{ text: `공식 재무 ${years(c)} 사업연도. 그 뒤 연도는 직접 준비`, to: "finance" }] : []) },
  { id: "d2", group: "재무", text: "최근 12개월 월별 손익", related: none },
  { id: "d3", group: "재무", text: "차입금과 보증 내역", related: (c) => {
    const f = fin(c);
    return f.length ? [{ text: `부채총계 ${f[f.length - 1].year} 사업연도`, to: "finance" }] : [];
  } },
  { id: "d4", group: "재무", text: "세금 신고와 납부 내역", related: none },
  { id: "d5", group: "재무", text: "한 번만 생긴 수익과 비용 설명", related: none },
  { id: "d6", group: "사업", text: "고객별, 제품별 매출 구성", related: none },
  { id: "d7", group: "사업", text: "주요 계약서 (고객, 공급, 제휴)", related: (c) => (contractNews(c) ? [{ text: `'수주·계약' 분류 기사 ${contractNews(c)}건`, to: "news" }] : []) },
  { id: "d8", group: "사업", text: "영업 진행 현황 (수주 잔고 등)", related: none },
  { id: "d9", group: "사업", text: "시장 규모와 그 근거 자료", related: none },
  { id: "d10", group: "사업", text: "경쟁사 비교 자료", related: (c) => [{ text: `고른 경쟁사 ${c.confirmedRivals}곳, 비교 자료 ${c.deepDone ? "받음" : "안 받음"}`, to: "rivals" }] },
  { id: "d11", group: "법무", text: "법인 등기부등본", related: (c) => (c.job.company.crno ? [{ text: "법인등록번호 확인 (금융위원회)", to: "overview" }] : []) },
  { id: "d12", group: "법무", text: "주주명부와 지분 구조 (투자 계약서 포함)", related: (c) => (rounds(c) ? [{ text: `투자 라운드 ${rounds(c)}건, 투자기관 ${c.job.merged.investors.length}곳 (보도)`, to: "investment" }] : []) },
  { id: "d13", group: "법무", text: "진행 중인 소송과 분쟁 내역", related: none },
  { id: "d14", group: "법무", text: "지식재산권 목록 (특허, 상표)", related: (c) => (patents(c) ? [{ text: `확인된 국내 특허 ${patents(c)}건`, to: "tech" }] : []) },
  { id: "d15", group: "법무", text: "인허가와 인증 내역", related: none },
  { id: "d16", group: "운영", text: "주요 공급처와 외주 의존 현황", related: none },
  { id: "d17", group: "운영", text: "사업장과 설비 현황", related: (c) => (c.job.merged.headquarters?.display ? [{ text: `본사 ${c.job.merged.headquarters.display}`, to: "overview" }] : []) },
  { id: "d18", group: "운영", text: "보험 가입 내역", related: none },
  { id: "d19", group: "인사", text: "조직도와 인원 추이", related: (c) => (c.job.sections.official.result?.nps ? [{ text: "국민연금 가입자 12개월 (참고)", to: "finance" }] : []) },
  { id: "d20", group: "인사", text: "핵심 인력 보상 구조 (스톡옵션 포함)", related: none },
  { id: "d21", group: "인사", text: "근로계약과 경업 금지 약정", related: none },
  { id: "d22", group: "IT", text: "기술 구조 설명", related: (c) => (coreTech(c) ? [{ text: `핵심 기술 ${coreTech(c)}개 (추정)`, to: "overview" }] : []) },
  { id: "d23", group: "IT", text: "정보보호와 개인정보 보호 체계", related: none },
  { id: "d24", group: "IT", text: "제품 개발 계획과 연구개발비", related: (c) => (c.papersDone ? [{ text: "논문 동향", to: "tech" }] : []) },
  { id: "d25", group: "ESG", text: "환경 관련 의무와 이행 내역 (해당하는 경우)", related: none },
  { id: "d26", group: "ESG", text: "법규 위반과 제재 이력", related: none },
];

export const groupCounts = <T extends { group: string }>(items: T[], groups: readonly string[]) => groups.map((g) => ({ group: g, items: items.filter((i) => i.group === g) }));
