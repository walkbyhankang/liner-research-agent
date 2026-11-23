// 심사 준비 화면 규칙(screens 6절): 부족한 요건 모으기, 대조 결과 정렬, 미팅 근거 묶음 한 줄, 판로 입찰공고 정렬.
import type { AnalysisJob, Bid, NoticeAnalysis, Value, Verdict } from "./contract.ts";
import { byCurrencyTexts, daysUntil, eok, fmtMD, signed, stageKo } from "./format.ts";
import { PATENT_LABEL, isTerminal } from "./view.ts";
import { SOON_DAYS, dday, type Program } from "./finder.ts";
import { savedNotices, type CheckRecord, type SavedItem } from "./local.ts";

/**
 * 담은 공고의 마감일(screens 4.0.3·6.1·8절). 회사 분석 "확인이 필요한 정보", 심사 준비 카드·정렬, 노트가 이 함수 하나를 쓴다.
 * 지금 공고 자료(/data/programs.json, 자금·판로 목록과 같은 사본)에 그 공고가 있고 마감일이 있으면 그것을 먼저 쓴다(마감이 당겨지거나 늘어난 것이 반영된다).
 * 자료를 아직 못 받았거나(null) 자료에서 공고가 빠졌거나 마감일이 비었으면 담을 때 저장한 마감일(meta.end)을 쓴다. 둘 다 없으면 null.
 */
export function noticeEnd(item: Pick<SavedItem, "itemId" | "meta">, programs: readonly Program[] | null | undefined): string | null {
  const now = programs?.find((p) => p.id === item.itemId)?.period.end;
  return now ?? (typeof item.meta.end === "string" ? item.meta.end : null);
}

export const VERDICT_ORDER: Verdict[] = ["미충족", "확인 필요", "충족", "판단 대상 아님"];
export const sortRows = (rows: NoticeAnalysis["match"]["rows"]) => [...rows].sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict));
export function verdictCounts(a: NoticeAnalysis) {
  const n = (v: Verdict) => a.match.rows.filter((r) => r.verdict === v).length;
  return { met: n("충족"), unmet: n("미충족"), check: n("확인 필요"), other: n("판단 대상 아님") };
}

export type Gap = { verdict: "미충족" | "확인 필요"; requirement: string; quote: string; reason: string; programId: string; programTitle: string };
/** 대조한 모든 공고의 미충족·확인 필요를 조건 분야로 묶는다 */
export function gaps(results: { programId: string; programTitle: string; result: NoticeAnalysis }[]) {
  const byField = new Map<string, Gap[]>();
  let unmet = 0;
  let check = 0;
  for (const { programId, programTitle, result } of results) {
    for (const r of result.match.rows) {
      if (r.verdict !== "미충족" && r.verdict !== "확인 필요") continue;
      if (r.verdict === "미충족") unmet += 1;
      else check += 1;
      const list = byField.get(r.field) ?? [];
      list.push({ verdict: r.verdict, requirement: r.requirement, quote: r.quote, reason: r.reason, programId, programTitle });
      byField.set(r.field, list);
    }
  }
  const groups = [...byField.entries()].map(([field, items]) => ({ field, items: items.sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict)) }));
  groups.sort((a, b) => Number(b.items.some((i) => i.verdict === "미충족")) - Number(a.items.some((i) => i.verdict === "미충족")));
  return { unmet, check, checked: results.length, groups };
}

// ---------------------------------------------------------------- 미팅 근거 묶음

export type EvidenceLine = { pending: boolean; text: string };

export function evidenceFinance(job: AnalysisJob): EvidenceLine {
  const off = job.sections.official;
  if (!isTerminal(off)) return { pending: true, text: "회사 분석에서 확인 중" };
  const f = off.result?.financials ?? [];
  const nps = off.result?.nps?.summary;
  const parts: string[] = [];
  if (f.length) {
    const a = f[0];
    const b = f[f.length - 1];
    if (a.revenue !== null && b.revenue !== null) parts.push(`매출 ${a.year} 사업연도 ${eok(a.revenue)}억원 → ${b.year} 사업연도 ${eok(b.revenue)}억원 (${b.basisShort ?? b.basis})`);
  }
  if (nps) {
    const months = off.result!.nps!.monthly.filter((m) => m.members !== null);
    parts.push(`국민연금 가입자 ${months[0]?.month ?? ""} ${nps.first}명 → ${months.at(-1)?.month ?? ""} ${nps.latest}명`);
  }
  if (!parts.length) return { pending: false, text: `미확보: ${off.result?.financialsReason ?? off.error?.message ?? "공식 재무·고용 자료 없음"}` };
  return { pending: false, text: parts.join(". ") };
}

export function evidenceFunding(job: AnalysisJob): EvidenceLine {
  const fh = job.sections.funding_history;
  if (!isTerminal(fh)) return { pending: true, text: "회사 분석에서 확인 중" };
  const r = fh.result;
  if (!r || !r.summary.roundCount) return { pending: false, text: "미확보: 투자 라운드 자료를 찾지 못했습니다" };
  const l = r.summary.latest;
  return { pending: false, text: `라운드 ${r.summary.roundCount}건${l ? `, 최근 ${(l.date ?? "").slice(0, 7)} ${stageKo(l.round)} ${l.amount ?? "금액 미공개"}` : ""}` };
}

/** 미팅 근거 묶음 특허 줄이 비었을 때(묶음 머리 줄·펼친 안 같은 글) */
export const PATENT_MISSING = "미확보: 출원인이 이 회사로 확인된 특허를 검색에서 찾지 못했습니다";

export function evidencePatents(job: AnalysisJob): EvidenceLine {
  const p = job.sections.patents;
  if (!isTerminal(p)) return { pending: true, text: "회사 분석에서 확인 중" };
  const r = p.result;
  if (!r || !r.summary.total) return { pending: false, text: PATENT_MISSING };
  // 기술 단락 요약(view.ts summaryLine tech)과 같은 글
  return { pending: false, text: `${PATENT_LABEL} ${r.summary.total}건 (출원인 확인, 등록 ${r.summary.registered}건)` };
}

export function evidenceNews(job: AnalysisJob): EvidenceLine {
  const n = job.sections.news;
  if (!isTerminal(n)) return { pending: true, text: "회사 분석에서 확인 중" };
  const ev = n.result?.events ?? [];
  if (!ev.length) return { pending: false, text: `미확보: ${n.status === "unavailable" && n.error?.code !== "no_data" ? "뉴스 단락을 확인하지 못했습니다" : "최근 12개월 중요 사건을 찾지 못했습니다"}` };
  return { pending: false, text: `중요 사건 ${ev.length}개 중 최근 ${Math.min(5, ev.length)}개` };
}

/** "미팅 전에 정리할 값": 엇갈림 값과 미확보 값 */
export type OpenValue = { label: string; value: Value; kind: "conflict" | "missing" };
export function openValues(job: AnalysisJob): OpenValue[] {
  const m = job.merged;
  const items: [string, Value | null][] = [
    ["지역", m.region], ["본사", m.headquarters], ["대표", m.ceo], ["설립", m.founded], ["업종(금융위)", m.industry.official], ["업종(웹 조사)", m.industry.web],
    ["직원 수", m.employees], ["매출(공식)", m.revenue.official], ["매출(웹 조사)", m.revenue.web], ["국민연금 가입자", m.npsLatest], [PATENT_LABEL, m.patentCount],
  ];
  const out: OpenValue[] = [];
  for (const [label, v] of items) {
    if (!v) continue;
    if (v.status === "conflicting") out.push({ label, value: v, kind: "conflict" });
    else if (v.status === "unavailable") out.push({ label, value: v, kind: "missing" });
  }
  return out;
}

/**
 * 회사 분석 "확인이 필요한 정보"(screens 4.0.3)의 개수. 사실을 센 것만 둔다(점수·확률 없음).
 * - 엇갈린 값·미확보 값: 분석이 진행 중이면 세지 않는다. 새로 분석 중에는 보이는 job 이 저장된 분석(done) 위에 새 결과를 얹은 것이라
 *   진행 중 작업(live)의 상태로도 본다(새 결과가 오는 동안 개수가 흔들리지 않게).
 * - 마감 임박·미충족 요건: 담은 공고(savedNotices, 두 화면에서 담은 같은 공고는 하나)로 센다. 분석 진행과 상관없다.
 *   마감 임박은 마감일이 14일 안이면 아직 접수 전이어도 센다(screens 4.0.3: 자금·판로 거르기 isSoon 은 접수 중 목록을 줄이는 것이고,
 *   여기는 이미 담은 공고를 놓치지 않게 하는 것이라 일부러 다르다). 마감일은 심사 준비·노트와 같은 noticeEnd(지금 공고 자료 먼저, 없으면 저장값).
 *   current 는 지금 공고 자료의 공고 목록. null 이면(받는 중·받지 못함·기다림 시간 초과) 저장한 마감일로 센다. 받는 중에 어떻게 보일지는 화면(Analysis.tsx CheckNow)이 정한다.
 */
export function checkNowCounts(
  job: AnalysisJob, live: AnalysisJob | null, saved: readonly SavedItem[], checks: Record<string, CheckRecord>, today: string | null, current: readonly Program[] | null = null,
) {
  const running = job.status === "running" || live?.status === "running";
  const values = running ? [] : openValues(job);
  const programs = savedNotices(saved);
  const soon = today
    ? programs.map((s) => dday(noticeEnd(s, current), today)).filter((d): d is number => d !== null && d >= 0 && d <= SOON_DAYS)
    : [];
  const checked = programs.map((s) => checks[s.itemId]).filter((r): r is CheckRecord => Boolean(r?.result));
  const unmet = gaps(checked.map((r) => ({ programId: r.programId, programTitle: "", result: r.result! }))).unmet;
  // notices: 담은 공고 수(같은 공고는 하나). 화면이 공고 목록을 받는 동안 틀을 미리 둘지 정하는 데 쓴다
  return { conflicts: values.filter((o) => o.kind === "conflict"), missing: values.filter((o) => o.kind === "missing"), soon, unmet, notices: programs.length };
}

export const npsChangeText = (job: AnalysisJob) => {
  const c = job.sections.official.result?.nps?.summary?.change;
  return typeof c === "number" ? signed(c) : "";
};
export const cumulativeTexts = (job: AnalysisJob) => byCurrencyTexts(job.sections.funding_history.result?.summary.cumulative.byCurrency);

// ---------------------------------------------------------------- 판로 입찰공고

const STATUS_RANK: Record<Bid["status"], number> = { open: 0, upcoming: 1, unknown: 2, closed: 3 };
/** 진행 중 먼저 → 핵심 낱말 일치 → 마감 가까운 순(P-03) */
export function sortBids(items: Bid[]): Bid[] {
  return [...items].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      Number(b.relevance === "high") - Number(a.relevance === "high") ||
      (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"),
  );
}
export function bidDeadline(b: Bid, today: string): string {
  if (b.status === "open" && b.deadline) {
    const d = daysUntil(b.deadline, today);
    return `D-${Math.max(0, d)}, ${fmtMD(b.deadline)} 마감`;
  }
  if (b.status === "upcoming") return `입찰 예정 ${fmtMD(b.bidBegin ?? b.deadline)}`;
  if (b.status === "closed") return "입찰 마감";
  return "마감 공고문 확인";
}
