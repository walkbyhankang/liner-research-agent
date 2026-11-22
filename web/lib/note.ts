// 노트(screens 8절): 회사 핵심 값 표, 텍스트 복사 글, 파일 내보내기·불러오기.
// 노트는 내보내는 문서라 출처를 값 옆에 그대로 쓴다. 복사 글의 출처는 "{기관·자료 이름} ({자료 종류}) · {기준일}" 한 줄(C-09).
import { STATUS_LABEL, sourceLine, type AnalysisJob, type Value } from "./contract.ts";
import { BIZ_LABEL, isBizType, type Edits } from "./company-values.ts";
import { ageLabel, byCurrencyTexts, compactDay, fmtTime, yearsSince } from "./format.ts";
import type { Local } from "./local.ts";
import { wordText, type Word } from "./view.ts";

export type NoteValue = { text: string; word: Word; source: string | null };
export type NoteRow = { label: string; values: NoteValue[]; pending: boolean };

const v2n = (v: Value, text?: string): NoteValue => ({ text: text ?? (v.status === "unavailable" ? v.reason ?? "자료 없음" : v.display ?? ""), word: v.status, source: v.source ? sourceLine(v.source) : null });
const edited = (text: string): NoteValue => ({ text, word: "edited", source: "이 브라우저에서 고친 값" });

function valueRow(label: string, v: Value | null, edit?: string, show?: (v: Value) => string): NoteRow {
  if (edit) return { label, values: [edited(edit)], pending: false };
  if (!v) return { label, values: [], pending: true };
  if (v.status === "conflicting" && v.values?.length) {
    return { label, values: v.values.map((alt, i) => ({ text: `${i ? "다른 자료: " : ""}${alt.display}`, word: "conflicting" as const, source: sourceLine(alt.source) })), pending: false };
  }
  return { label, values: [v2n(v, show && v.status !== "unavailable" ? show(v) : undefined)], pending: false };
}

export function noteRows(job: AnalysisJob, edits: Edits, today: string): NoteRow[] {
  const m = job.merged;
  const rows: NoteRow[] = [];
  rows.push(valueRow("지역", m.region, edits.region?.value));
  rows.push(
    valueRow("업력(설립일)", m.founded, edits.founded?.value ? `${ageLabel(yearsSince(edits.founded.value, today)) ?? ""} (설립 ${edits.founded.value})` : undefined, (v) => {
      const age = ageLabel(yearsSince(typeof v.raw === "string" ? v.raw : null, today));
      return age ? `${age} (설립 ${v.display})` : v.display ?? "";
    }),
  );
  const b = edits.bizType?.value;
  rows.push(isBizType(b) ? { label: "기업 유형", values: [edited(BIZ_LABEL[b])], pending: false } : { label: "기업 유형", values: [{ text: "근거 자료 없음", word: "unavailable", source: null }], pending: false });
  if (edits.industry?.value) rows.push({ label: "업종", values: [edited(edits.industry.value)], pending: false });
  else {
    const vals = [m.industry.official, m.industry.web].filter((v): v is Value => Boolean(v)).map((v, i) => v2n(v, v.status === "unavailable" ? undefined : `${v.display} (${i === 0 && v === m.industry.official ? "금융위" : "웹 조사"})`));
    rows.push({ label: "업종", values: vals, pending: !m.industry.official && !m.industry.web });
  }
  const rev = valueRow("매출(사업연도·기준)", m.revenue.official, edits.revenue?.value, (v) => `${v.display} (${[v.source?.asOf, v.source?.basis].filter(Boolean).join(", ")})`);
  if (!edits.revenue?.value && m.revenue.web && m.revenue.web.status !== "unavailable") rev.values.push(v2n(m.revenue.web, `웹 조사: ${m.revenue.web.display}`));
  rows.push(rev);
  rows.push(valueRow("국민연금 가입자(월)", m.npsLatest, undefined, (v) => `${v.display} (${v.source?.asOf ?? ""}, 직원 수와 다름)`));
  rows.push(valueRow("직원 수", m.employees, edits.employees?.value));
  const fh = job.sections.funding_history;
  if (fh.status === "waiting" || fh.status === "running") rows.push({ label: "누적 투자", values: [], pending: true });
  else {
    const amounts = byCurrencyTexts(fh.result?.summary.cumulative.byCurrency);
    const label = fh.result?.summary.cumulative.label ?? "";
    rows.push({
      label: "누적 투자",
      values: amounts.length
        ? amounts.map((a) => ({ text: `${a} (${label}, 라운드 ${fh.result?.summary.roundCount ?? 0}건, 투자기관 ${job.merged.investors.length}곳)`, word: "reported" as const, source: label === "People Data Labs 누적액" ? "People Data Labs 회사 카드 (Liner Premium)" : "투자 라운드 금액 합계 (People Data Labs, Liner 검색)" }))
        : [{ text: fh.result?.summary.roundCount ? `라운드 ${fh.result.summary.roundCount}건, 누적액 자료 없음` : "투자 라운드 자료 없음", word: "unavailable", source: null }],
      pending: false,
    });
  }
  rows.push(valueRow("국내 특허", m.patentCount));
  return rows;
}

export const WORD_LEGEND = "원문 확인: 원문이나 공공 원자료에서 확인 / 보도: 기사·자료·투자 DB에 적힘 / 추정: 모델 판단이나 간접 근거 / 엇갈림: 자료마다 값이 다름 / 미확보: 자료를 얻지 못함 / 참고: 대신 볼 수 있는 값 / 직접 입력: 이 브라우저에서 고친 값";

export type NoteText = {
  name: string;
  analyzedAt: string | null;
  stale: boolean;
  today: string;
  rows: NoteRow[];
  programs: string[];
  gps: string[];
  sales: string[];
  todo: { title: string; items: string[] }[];
  memo: string;
  liner: number;
};

/** 노트 전체를 글로(HTML 없음). 첫 줄에 회사 이름과 분석 시각(N-06) */
export function noteText(n: NoteText): string {
  const lines: string[] = [];
  lines.push(`${n.name} 성장노트 (${n.today} 작성, 회사 분석 ${n.analyzedAt ? fmtTime(n.analyzedAt) : "진행 중"}${n.stale ? ", 오래된 분석" : ""})`);
  lines.push("", "[회사 핵심 값]");
  for (const r of n.rows) {
    if (r.pending) lines.push(`- ${r.label}: 확인 중`);
    for (const v of r.values) lines.push(`- ${r.label}: ${v.text} (${wordText(v.word)})${v.source ? ` 출처: ${v.source}` : ""}`);
  }
  const block = (title: string, items: string[]) => {
    lines.push("", `[${title}]`);
    if (!items.length) lines.push("- 없음");
    for (const i of items) lines.push(`- ${i}`);
  };
  block("담은 자금 후보", n.programs);
  block("운용사", n.gps);
  block("판로 후보", n.sales);
  lines.push("", "[다음 할 일]");
  for (const t of n.todo) {
    lines.push(`${t.title}`);
    if (!t.items.length) lines.push("- 없음");
    for (const i of t.items) lines.push(`- ${i}`);
  }
  lines.push("", "[메모]", n.memo.trim() || "(없음)");
  lines.push("", `회사 분석에 쓴 Liner 호출 ${n.liner}회`, WORD_LEGEND, "점수나 선정 확률은 만들지 않습니다. 값마다 확인 상태와 출처를 붙입니다.");
  return lines.join("\n");
}

export const linerTotal = (job: AnalysisJob) => {
  const p = job.paid.liner;
  return p.search + p.premium + p.model + p.scholar;
};

// ---------------------------------------------------------------- 파일 내보내기·불러오기

export type ExportFile = { version: 1; companyId: string; name: string; exportedAt: string } & Omit<Local, "loaded">;

export function exportName(name: string, today: string) {
  return `성장노트-${name.replace(/[\\/:*?"<>|]/g, "")}-${compactDay(today)}.json`;
}

export function exportFile(companyId: string, name: string, local: Local, exportedAt: string): ExportFile {
  const { loaded: _loaded, ...rest } = local;
  void _loaded;
  return { version: 1, companyId, name, exportedAt, ...rest };
}

export type ImportResult = { ok: true; data: ExportFile } | { ok: false; message: string };
export function parseImport(text: string, companyId: string): ImportResult {
  let d: ExportFile;
  try {
    d = JSON.parse(text);
  } catch {
    return { ok: false, message: "성장노트에서 내보낸 파일이 아닙니다." };
  }
  if (!d || d.version !== 1 || typeof d.companyId !== "string" || typeof d.name !== "string" || typeof d.edits !== "object" || !Array.isArray(d.saved)) {
    return { ok: false, message: "성장노트에서 내보낸 파일이 아닙니다." };
  }
  if (d.companyId !== companyId) return { ok: false, message: `다른 회사(${d.name})의 파일입니다. 이 회사 노트로 불러올 수 없습니다.` };
  return {
    ok: true,
    data: {
      ...d,
      checks: d.checks ?? {}, rivalChecks: d.rivalChecks ?? {}, briefs: d.briefs ?? {}, rivalChoices: d.rivalChoices ?? { choices: {}, added: [] },
      prep: d.prep ?? { questions: {}, dd: {} }, notes: d.notes ?? null, salesKeywords: d.salesKeywords ?? null,
    },
  };
}

export { STATUS_LABEL };
