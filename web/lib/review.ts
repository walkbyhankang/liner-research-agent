// 심사 준비 화면 규칙(screens 6절): 부족한 요건 모으기, 대조 결과 정렬, 미팅 근거 묶음 한 줄, 판로 입찰공고 정렬.
import type { AnalysisJob, Bid, NoticeAnalysis, Value, Verdict } from "./contract.ts";
import { byCurrencyTexts, daysUntil, eok, fmtMD, signed, stageKo } from "./format.ts";
import { isTerminal } from "./view.ts";

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

export function evidencePatents(job: AnalysisJob): EvidenceLine {
  const p = job.sections.patents;
  if (!isTerminal(p)) return { pending: true, text: "회사 분석에서 확인 중" };
  const r = p.result;
  if (!r || !r.summary.total) return { pending: false, text: "미확보: 출원인이 이 회사로 확인된 국내 특허를 찾지 못했습니다" };
  return { pending: false, text: `출원인이 확인된 국내 특허 ${r.summary.total}건 (등록 ${r.summary.registered}건)` };
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
    ["직원 수", m.employees], ["매출(공식)", m.revenue.official], ["매출(웹 조사)", m.revenue.web], ["국민연금 가입자", m.npsLatest], ["국내 특허", m.patentCount],
  ];
  const out: OpenValue[] = [];
  for (const [label, v] of items) {
    if (!v) continue;
    if (v.status === "conflicting") out.push({ label, value: v, kind: "conflict" });
    else if (v.status === "unavailable") out.push({ label, value: v, kind: "missing" });
  }
  return out;
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
