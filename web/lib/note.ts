// 노트(screens 8절): 회사 핵심 값 표, 텍스트 복사 글, 파일 내보내기·불러오기.
// 노트는 내보내는 문서라 출처를 값 옆에 그대로 쓴다. 복사 글의 출처는 "{기관·자료 이름} ({자료 종류}) · {기준일}" 한 줄(C-09).
import { STATUS_LABEL, sourceLine, type AnalysisJob, type Value } from "./contract.ts";
import { BIZ_LABEL, EDIT_FIELDS, isBizType, type Edits } from "./company-values.ts";
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
export const NOT_EXPORT_FILE = "성장노트에서 내보낸 파일이 아닙니다.";

// 불러올 파일의 모양 검사. 하나라도 어긋나면 파일 전체를 거절한다(지금 브라우저 자료를 지우기 전에 판단한다)
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStrList = (x: unknown) => Array.isArray(x) && x.every(isStr);
const isObjList = (x: unknown) => Array.isArray(x) && x.every(isObj);
const values = (x: unknown, ok: (v: unknown) => boolean) => isObj(x) && Object.values(x).every(ok);
const SAVED_KINDS = new Set(["program", "gp", "salesProgram", "bid"]);
const isEdits = (x: unknown) =>
  isObj(x) && Object.entries(x).every(([k, v]) => (EDIT_FIELDS as readonly string[]).includes(k) && isObj(v) && isStr(v.value) && isStr(v.updatedAt));
const isSaved = (x: unknown) =>
  isObj(x) && isStr(x.kind) && SAVED_KINDS.has(x.kind) && isStr(x.itemId) && isStr(x.title) && isStr(x.savedAt) &&
  values(x.meta, (v) => v === null || isStr(v) || isNum(v) || typeof v === "boolean");
const isError = (x: unknown) => x === null || (isObj(x) && isStr(x.code) && isStr(x.message));
const isCompany = (x: unknown) => values(x, isStr);
const isNoticeResult = (x: unknown) =>
  x === null ||
  (isObj(x) && isObj(x.program) && isStr(x.program.id) && isObj(x.extraction) && isObj(x.match) && isStr(x.match.overall) &&
    isObjList(x.match.rows) && isStrList(x.match.questions) && isStrList(x.match.documents));
const isGpResult = (x: unknown) =>
  x === null || (isObj(x) && isStr(x.gp) && isObjList(x.facts) && isObjList(x.fit) && isStrList(x.questions) && isObjList(x.sources));
const isCheck = (x: unknown) => isObj(x) && isStr(x.programId) && isStr(x.ranAt) && isCompany(x.company) && isError(x.error) && isNoticeResult(x.result);
const isRivalCheck = (x: unknown) => isCheck(x) && isStr((x as Obj).rivalKey);
const isBrief = (x: unknown) => isObj(x) && isStr(x.gp) && isStr(x.ranAt) && isCompany(x.company) && isError(x.error) && isGpResult(x.result);
const isRivalChoices = (x: unknown) =>
  isObj(x) && values(x.choices, (v) => v === "yes" || v === "no") && Array.isArray(x.added) && x.added.every((a) => isObj(a) && isStr(a.key) && isStr(a.name));
const isPrep = (x: unknown) =>
  isObj(x) && values(x.questions, (q) => isObj(q) && typeof q.ready === "boolean" && isStr(q.memo)) && values(x.dd, (v) => typeof v === "boolean");
const isMemo = (x: unknown) => x === null || (isObj(x) && isStr(x.memo) && isStr(x.updatedAt));
/** 없어도 되는 칸(없으면 빈 값으로 채운다). 있으면 모양이 맞아야 한다 */
const optional = (x: unknown, ok: (v: unknown) => boolean) => x === undefined || ok(x);

export function parseImport(text: string, companyId: string): ImportResult {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return { ok: false, message: NOT_EXPORT_FILE };
  }
  if (!isObj(d) || d.version !== 1 || !isStr(d.companyId) || !isStr(d.name) || !optional(d.exportedAt, isStr)) return { ok: false, message: NOT_EXPORT_FILE };
  if (d.companyId !== companyId) return { ok: false, message: `다른 회사(${d.name})의 파일입니다. 이 회사 노트로 불러올 수 없습니다.` };
  const shapeOk =
    isEdits(d.edits) && Array.isArray(d.saved) && d.saved.every(isSaved) &&
    optional(d.checks, (x) => values(x, isCheck)) && optional(d.rivalChecks, (x) => values(x, isRivalCheck)) && optional(d.briefs, (x) => values(x, isBrief)) &&
    optional(d.rivalChoices, isRivalChoices) && optional(d.prep, isPrep) && optional(d.notes, isMemo) && optional(d.salesKeywords, (x) => x === null || isStrList(x));
  if (!shapeOk) return { ok: false, message: NOT_EXPORT_FILE };
  const f = d as unknown as ExportFile;
  return {
    ok: true,
    data: {
      ...f,
      checks: f.checks ?? {}, rivalChecks: f.rivalChecks ?? {}, briefs: f.briefs ?? {}, rivalChoices: f.rivalChoices ?? { choices: {}, added: [] },
      prep: f.prep ?? { questions: {}, dd: {} }, notes: f.notes ?? null, salesKeywords: f.salesKeywords ?? null,
    },
  };
}

export { STATUS_LABEL };
