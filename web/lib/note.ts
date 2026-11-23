// 노트(screens 8절): 회사 정보 표, 담은 자금 후보 묶음, 텍스트 복사 글, 파일 내보내기·불러오기.
// 노트는 내보내는 문서라 출처를 값 옆에 그대로 쓴다. 복사 글의 출처는 "{기관·자료 이름} ({자료 종류}) · {기준일}" 한 줄(C-09).
import { STATUS_LABEL, sourceLine, type AnalysisJob, type NoticeCompany, type Value } from "./contract.ts";
import { BIZ_LABEL, EDIT_FIELDS, isBizType, type Edits } from "./company-values.ts";
import { ageLabel, byCurrencyTexts, compactDay, fmtMD, fmtTime, todayKST, yearsSince } from "./format.ts";
import type { CheckRecord, Local, SavedItem } from "./local.ts";
import { verdictCounts } from "./review.ts";
import { PATENT_LABEL, wordText, type Word } from "./view.ts";

/**
 * 회사 정보 한 값. tag: 같은 줄에 성격이 다른 값이 함께 있을 때 값 앞에 붙이는 이름(screens 8절, QA 주석22).
 * "공식 자료"(금융위원회 등 공공 원자료 칸), "웹 조사"(웹에서 모은 칸), "다른 자료"(엇갈림의 둘째 값). 없으면 null.
 */
export type NoteValue = { text: string; word: Word; source: string | null; tag: string | null };
/** conflict: 자료끼리 값이 엇갈린 줄. 상태 낱말 "엇갈림"은 항목 이름 옆에 한 번만 쓴다(screens 1.3 규칙 3) */
export type NoteRow = { label: string; values: NoteValue[]; pending: boolean; conflict: boolean };

const v2n = (v: Value, text?: string, tag: string | null = null): NoteValue => ({
  text: text ?? (v.status === "unavailable" ? v.reason ?? "자료 없음" : v.display ?? ""), word: v.status, source: v.source ? sourceLine(v.source) : null, tag,
});
const edited = (text: string): NoteValue => ({ text, word: "edited", source: "이 브라우저에서 고친 값", tag: null });
const row = (label: string, values: NoteValue[], pending = false): NoteRow => ({ label, values, pending, conflict: values.some((v) => v.word === "conflicting") });

function valueRow(label: string, v: Value | null, edit?: string, show?: (v: Value) => string, tag: string | null = null): NoteRow {
  if (edit) return row(label, [edited(edit)]);
  if (!v) return row(label, [], true);
  if (v.status === "conflicting" && v.values?.length) {
    return row(label, v.values.map((alt, i) => ({ text: alt.display, word: "conflicting" as const, source: sourceLine(alt.source), tag: i ? "다른 자료" : tag })));
  }
  return row(label, [v2n(v, show && v.status !== "unavailable" ? show(v) : undefined, tag)]);
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
  rows.push(row("기업 유형", [isBizType(b) ? edited(BIZ_LABEL[b]) : { text: "근거 자료 없음", word: "unavailable", source: null, tag: null }]));
  if (edits.industry?.value) rows.push(row("업종", [edited(edits.industry.value)]));
  else {
    // 공공 원자료 칸(금융위원회)과 웹 조사 칸을 따로 둔다. 어느 쪽이든 없으면 그 칸만 빠진다
    const vals = [
      ...(m.industry.official ? valueRow("", m.industry.official, undefined, undefined, "공식 자료").values : []),
      ...(m.industry.web ? valueRow("", m.industry.web, undefined, undefined, "웹 조사").values : []),
    ];
    rows.push(row("업종", vals, !m.industry.official && !m.industry.web));
  }
  const rev = valueRow("매출(사업연도·기준)", m.revenue.official, edits.revenue?.value, (v) => `${v.display} (${[v.source?.asOf, v.source?.basis].filter(Boolean).join(", ")})`, "공식 자료");
  // 웹 조사 매출도 업종 줄처럼 붙이고(엇갈리면 값마다 따로), "엇갈림" 표시는 두 칸을 다 모은 뒤 정한다(항목 이름 옆에 한 번)
  const revWeb = !edits.revenue?.value && m.revenue.web && m.revenue.web.status !== "unavailable" ? valueRow("", m.revenue.web, undefined, undefined, "웹 조사").values : [];
  rows.push(row(rev.label, [...rev.values, ...revWeb], rev.pending));
  rows.push(valueRow("국민연금 가입자(월)", m.npsLatest, undefined, (v) => `${v.display} (${v.source?.asOf ?? ""}, 직원 수와 다름)`));
  rows.push(valueRow("직원 수", m.employees, edits.employees?.value));
  const fh = job.sections.funding_history;
  if (fh.status === "waiting" || fh.status === "running") rows.push(row("누적 투자", [], true));
  else {
    const amounts = byCurrencyTexts(fh.result?.summary.cumulative.byCurrency);
    const label = fh.result?.summary.cumulative.label ?? "";
    rows.push(
      row(
        "누적 투자",
        amounts.length
          ? amounts.map((a) => ({ text: `${a} (${label}, 라운드 ${fh.result?.summary.roundCount ?? 0}건, 투자기관 ${job.merged.investors.length}곳)`, word: "reported" as const, source: label === "People Data Labs 누적액" ? "People Data Labs 회사 카드 (Liner Premium)" : "투자 라운드 금액 합계 (People Data Labs, Liner 검색)", tag: null }))
          : [{ text: fh.result?.summary.roundCount ? `라운드 ${fh.result.summary.roundCount}건, 누적액 자료 없음` : "투자 라운드 자료 없음", word: "unavailable", source: null, tag: null }],
      ),
    );
  }
  rows.push(valueRow(PATENT_LABEL, m.patentCount));
  return rows;
}

// ---------------------------------------------------------------- 담은 자금 후보(QA 주석23)

/**
 * 공고 전체 상태. 서버 종합 문구 셋과 "대조 전"(대조 결과가 없음).
 * 노트에서 묶는 순서: 신청을 검토할 것 → 기관에 확인할 것 → 아직 대조하지 않은 것 → 대상이 아닌 것.
 */
export const NOTICE_STATES = ["신청 검토 가능", "확인 후 판단", "대조 전", "대상 아님"] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];
/** 공고에서 다음에 볼 조건(미충족·확인 필요). 판정 순서대로 묶는다 */
export type NoteCondition = { verdict: "미충족" | "확인 필요"; requirement: string };
export type NoteNotice = {
  key: string;
  title: string;
  /** 공고 기관(담을 때 저장한 meta.agency). 기관에 물어볼 때 쓰려고 마감 옆에 둔다. 없으면 null */
  agency: string | null;
  /** 마감일(noticeEnd: 지금 공고 자료 먼저, 없으면 담을 때 저장값). 없으면 null */
  end: string | null;
  state: NoticeState;
  counts: { met: number; unmet: number; check: number } | null;
  /** 서버가 준 종합 문구의 이유 한 문장(대조 전이면 빈 글) */
  reason: string;
  conditions: { verdict: NoteCondition["verdict"]; items: string[] }[];
  /** 근거 줄: 공고문 종류·대조한 날, 이전 회사 값으로 한 대조인지. 대조 전이면 null */
  basis: string | null;
};
export const NOT_CHECKED_TEXT = "자격 대조 전입니다. 심사 준비에서 공고문과 대조할 수 있습니다.";

export function noteNotice(item: Pick<SavedItem, "itemId" | "title"> & { meta?: SavedItem["meta"] }, rec: CheckRecord | undefined, end: string | null, current: NoticeCompany | null): NoteNotice {
  const agency = typeof item.meta?.agency === "string" && item.meta.agency.trim() ? item.meta.agency.trim() : null;
  const r = rec?.result ?? null;
  if (!r) return { key: item.itemId, title: item.title, agency, end, state: "대조 전", counts: null, reason: "", conditions: [], basis: null };
  const c = verdictCounts(r);
  const conditions = (["미충족", "확인 필요"] as const)
    .map((v) => ({ verdict: v, items: r.match.rows.filter((x) => x.verdict === v).map((x) => x.requirement).filter((t): t is string => typeof t === "string" && t.length > 0) }))
    .filter((g) => g.items.length);
  // 가져오기 파일(parseImport)·옛 기록에는 공고문 정보나 올바른 대조 시각이 없을 수 있다. 없으면 그 부분만 빼고 노트는 그린다
  const doc = r.extraction?.doc;
  const docText = typeof doc?.kind === "string" && doc.kind ? `공고문(${doc.kind.toUpperCase()}${typeof doc.pages === "number" && doc.pages > 0 ? ` ${doc.pages}쪽` : ""})` : "공고문";
  // 대조 시각을 한국 날짜로 못 바꾸면(형식이 틀리거나 날짜 범위 끝이라 +9시간에서 넘침) 날짜만 뺀다
  let ranText = "";
  try {
    const ran = new Date(rec!.ranAt);
    if (!Number.isNaN(ran.getTime())) ranText = ` ${todayKST(ran)} 대조.`;
  } catch {
    ranText = "";
  }
  const stale = Boolean(current && JSON.stringify(rec!.company) !== JSON.stringify(current));
  // 읽은 범위의 한계도 함께 둔다(심사 준비 카드와 같은 문장): 근거를 확인하지 못해 뺀 조건 수, 공고문이 길어 앞부분만 읽음
  const dropped = typeof r.extraction?.dropped === "number" && r.extraction.dropped > 0 ? ` 근거를 확인하지 못한 ${r.extraction.dropped}건은 뺐습니다.` : "";
  const truncated = doc?.truncated === true ? " 공고문이 길어 앞부분만 읽었습니다." : "";
  const basis = `근거: ${docText}에 근거 문장이 있는 조건만 판단했습니다.${dropped}${truncated}${ranText}${stale ? " 이전 회사 값으로 한 대조입니다." : ""}`;
  // 이미 저장된 옛 기록에 알 수 없는 판정 값이 있어도 노트에서 빠지지 않게 가장 조심스러운 "확인 후 판단" 묶음에 둔다
  // 판정 결과가 있으면 서버가 만드는 세 판정만 쓴다. "대조 전"은 결과가 없을 때만이다(불러온 파일에 그 글이 있어도 판정 묶음으로)
  const state: NoticeState = r.match.overall === "신청 검토 가능" || r.match.overall === "대상 아님" || r.match.overall === "확인 후 판단" ? r.match.overall : "확인 후 판단";
  return { key: item.itemId, title: item.title, agency, end, state, counts: { met: c.met, unmet: c.unmet, check: c.check }, reason: typeof r.match.overallReason === "string" ? r.match.overallReason : "", conditions, basis };
}

/** 공고 전체 상태로 묶고(NOTICE_STATES 순서), 묶음 안은 마감 가까운 순(마감일 없음은 뒤). 빈 묶음은 뺀다 */
export function noticeGroups<T extends { state: NoticeState; end: string | null }>(items: readonly T[]): { state: NoticeState; items: T[] }[] {
  return NOTICE_STATES.map((state) => ({
    state,
    items: items.filter((x) => x.state === state).sort((a, b) => (a.end ?? "9999-12-31").localeCompare(b.end ?? "9999-12-31")),
  })).filter((g) => g.items.length);
}

/** 조건 묶음에서 앞에서부터 n개만 남긴다(판정 순서 그대로). more: 남기지 못한 개수 */
export function capConditions(conditions: NoteNotice["conditions"], n: number) {
  const shown = conditions
    .map((g, i) => {
      const before = conditions.slice(0, i).reduce((s, x) => s + x.items.length, 0);
      return { ...g, total: g.items.length, items: g.items.slice(0, Math.max(0, n - before)) };
    })
    .filter((g) => g.items.length);
  const all = conditions.reduce((s, g) => s + g.items.length, 0);
  return { shown, more: all - shown.reduce((s, g) => s + g.items.length, 0) };
}

/** 묶음 목록에 묶음을 건너 이어지는 순번(0부터)을 붙인다. 화면 5건·인쇄 10건 자르기에 쓴다 */
export function numberGroups<T>(groups: { state: NoticeState; items: T[] }[]) {
  return groups.map((g, gi) => {
    const start = groups.slice(0, gi).reduce((s, x) => s + x.items.length, 0);
    return { state: g.state, items: g.items.map((x, i) => ({ x, i: start + i })) };
  });
}

/** 공고 하나의 마감 글: "12.5 마감" / "신청기간 미기재" */
export const noticeDue = (end: string | null) => (end ? `${fmtMD(end)} 마감` : "신청기간 미기재");
export const noticeCountsText = (c: NonNullable<NoteNotice["counts"]>) => `충족 ${c.met}, 미충족 ${c.unmet}, 확인 필요 ${c.check}`;

export const WORD_LEGEND = "원문 확인: 원문이나 공공 원자료에서 확인 / 보도: 기사·자료·투자 DB에 적힘 / 추정: 모델 판단이나 간접 근거 / 엇갈림: 자료마다 값이 다름 / 미확보: 자료를 얻지 못함 / 참고: 대신 볼 수 있는 값 / 직접 입력: 이 브라우저에서 고친 값";

export type NoteText = {
  name: string;
  analyzedAt: string | null;
  stale: boolean;
  today: string;
  rows: NoteRow[];
  notices: NoteNotice[];
  gps: string[];
  sales: string[];
  todo: { title: string; items: string[] }[];
  memo: string;
  liner: number;
};

/** 공고 하나를 글로: 제목·마감·판정 요약 → 미충족·확인 필요 조건 → 근거 줄(화면·인쇄와 같은 순서) */
export function noticeLines(x: NoteNotice): string[] {
  const head = `- ${x.title} (${x.agency ? `${x.agency}, ` : ""}${noticeDue(x.end)}) ${x.counts ? `${noticeCountsText(x.counts)}.${x.reason ? ` ${x.reason}` : ""}` : NOT_CHECKED_TEXT}`;
  const out = [head];
  for (const g of x.conditions) for (const i of g.items) out.push(`  ${g.verdict}: ${i}`);
  if (x.basis) out.push(`  ${x.basis}`);
  return out;
}

/** 노트 전체를 글로(HTML 없음). 첫 줄에 회사 이름과 분석 시각(N-06) */
export function noteText(n: NoteText): string {
  const lines: string[] = [];
  lines.push(`${n.name} 성장노트 (${n.today} 작성, 회사 분석 ${n.analyzedAt ? fmtTime(n.analyzedAt) : "진행 중"}${n.stale ? ", 오래된 분석" : ""})`);
  lines.push("", "[회사 정보]");
  for (const r of n.rows) {
    if (r.pending) lines.push(`- ${r.label}: 확인 중`);
    for (const v of r.values) lines.push(`- ${r.label}${v.tag ? ` (${v.tag})` : ""}: ${v.text} (${wordText(v.word)})${v.source ? ` 출처: ${v.source}` : ""}`);
  }
  const block = (title: string, items: string[]) => {
    lines.push("", `[${title}]`);
    if (!items.length) lines.push("- 없음");
    for (const i of items) lines.push(`- ${i}`);
  };
  lines.push("", "[담은 자금 후보]");
  if (!n.notices.length) lines.push("- 없음");
  for (const g of noticeGroups(n.notices)) {
    lines.push(`${g.state} ${g.items.length}건`);
    for (const x of g.items) lines.push(...noticeLines(x));
  }
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
