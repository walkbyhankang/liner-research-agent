// 회사마다 이 브라우저에 두는 것(고친 값, 담은 항목, 대조 결과, 요약, 경쟁사 비교 대상, 준비함, 메모, 판로 검색어)을
// 메모리에 올려 두고 바뀔 때 화면에 알린다. 저장은 store.ts(IndexedDB, 안 되면 메모리)로 한다.
// 서버로 보내는 것은 공고문 대조·운용사 요약 요청의 company 뿐이다(D-07).
import type { AnalysisJob, GpBrief, NoticeAnalysis, NoticeCompany } from "./contract.ts";
import type { Edits } from "./company-values.ts";
import * as store from "./store.ts";

export type SavedKind = "program" | "gp" | "salesProgram" | "bid";
export type SavedItem = {
  kind: SavedKind;
  itemId: string;
  title: string;
  savedAt: string;
  /** 담을 때의 사본: 공고 마감일·기관, 운용사 펀드 수, 입찰공고 정보. 목록에서 사라져도 노트에 남기려고 둔다 */
  meta: Record<string, string | number | boolean | null>;
};
export type CheckRecord = { programId: string; result: NoticeAnalysis | null; error: { code: string; message: string } | null; ranAt: string; company: NoticeCompany };
export type RivalCheckRecord = { programId: string; rivalKey: string; result: NoticeAnalysis | null; error: { code: string; message: string } | null; ranAt: string; company: NoticeCompany };
export type BriefRecord = { gp: string; result: GpBrief | null; error: { code: string; message: string } | null; ranAt: string; company: NoticeCompany };
/** 경쟁사 비교 대상(포함 yes·제외 no, 직접 추가). touched: 이 브라우저에서 한 번이라도 정한 적이 있다(모두 다시 풀어도 "처음 비교 대상"으로 돌아가지 않게, screens 4B.1) */
export type RivalChoices = { choices: Record<string, "yes" | "no">; added: { key: string; name: string }[]; touched?: boolean };
export type Prep = { questions: Record<string, { ready: boolean; memo: string }>; dd: Record<string, boolean> };
export type NoteMemo = { memo: string; updatedAt: string };

export type Local = {
  loaded: boolean;
  edits: Edits;
  saved: SavedItem[];
  checks: Record<string, CheckRecord>;
  rivalChecks: Record<string, RivalCheckRecord>;
  briefs: Record<string, BriefRecord>;
  rivalChoices: RivalChoices;
  prep: Prep;
  notes: NoteMemo | null;
  salesKeywords: string[] | null;
};

export const EMPTY_LOCAL: Local = {
  loaded: false, edits: {}, saved: [], checks: {}, rivalChecks: {}, briefs: {}, rivalChoices: { choices: {}, added: [] }, prep: { questions: {}, dd: {} }, notes: null, salesKeywords: null,
};

const cache = new Map<string, Local>();
const loading = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const emit = (cid: string) => listeners.get(cid)?.forEach((l) => l());
const now = () => new Date().toISOString();

const rivalKeyText = (programId: string, rivalKey: string) => `${programId}|${rivalKey}`;

async function load(cid: string) {
  const [edits, saved, checks, rivalChecks, briefs, rivalChoices, prep, notes, salesKeywords] = await Promise.all([
    store.get<Edits>("edits", cid),
    store.all<SavedItem>("saved", cid),
    store.all<CheckRecord>("checks", cid),
    store.all<RivalCheckRecord>("rivalChecks", cid),
    store.all<BriefRecord>("briefs", cid),
    store.get<RivalChoices>("rivalChoices", cid),
    store.get<Prep>("prep", cid),
    store.get<NoteMemo>("notes", cid),
    store.get<string[]>("salesKeywords", cid),
  ]);
  // 불러오는 사이 화면에서 바뀐 값이 있으면 그것을 지킨다(먼저 쓴 쪽이 이긴다)
  const cur = cache.get(cid);
  const base: Local = {
    loaded: true,
    edits: edits ?? {},
    saved: saved.map((r) => r.value).sort((a, b) => a.savedAt.localeCompare(b.savedAt)),
    checks: Object.fromEntries(checks.map((r) => [r.value.programId, r.value])),
    rivalChecks: Object.fromEntries(rivalChecks.map((r) => [rivalKeyText(r.value.programId, r.value.rivalKey), r.value])),
    briefs: Object.fromEntries(briefs.map((r) => [r.value.gp, r.value])),
    rivalChoices: rivalChoices ?? { choices: {}, added: [] },
    prep: prep ?? { questions: {}, dd: {} },
    notes: notes ?? null,
    salesKeywords: salesKeywords ?? null,
  };
  cache.set(cid, cur && cur.loaded ? cur : base);
  emit(cid);
}

export function ensureLocal(cid: string): Promise<void> {
  if (!loading.has(cid)) loading.set(cid, load(cid));
  return loading.get(cid)!;
}

export function getLocal(cid: string): Local {
  return cache.get(cid) ?? EMPTY_LOCAL;
}

export function subscribeLocal(cid: string, cb: () => void) {
  if (!listeners.has(cid)) listeners.set(cid, new Set());
  listeners.get(cid)!.add(cb);
  void ensureLocal(cid);
  return () => void listeners.get(cid)?.delete(cb);
}

function update(cid: string, fn: (l: Local) => Local) {
  const cur = cache.get(cid) ?? { ...EMPTY_LOCAL, loaded: true };
  cache.set(cid, fn(cur));
  emit(cid);
}

// ---------------------------------------------------------------- 고친 값

export function saveEdits(cid: string, edits: Edits) {
  update(cid, (l) => ({ ...l, edits }));
  void store.put("edits", cid, edits);
}

export function setEdit(cid: string, field: keyof Edits, value: string | null) {
  const cur = getLocal(cid).edits;
  const next: Edits = { ...cur };
  if (value === null || !value.trim()) delete next[field];
  else next[field] = { value: value.trim(), updatedAt: now() };
  saveEdits(cid, next);
}

// ---------------------------------------------------------------- 담기

export const savedKey = (cid: string, kind: SavedKind, itemId: string) => [cid, kind, itemId];
export const isSaved = (l: Local, kind: SavedKind, itemId: string) => l.saved.some((s) => s.kind === kind && s.itemId === itemId);
/** 심사 준비로 가는 담은 항목 수(공고, 운용사, 판로 지원사업). 입찰공고는 노트에만 담긴다 */
/**
 * 담은 공고(자금·판로 빌리는 돈에서 담은 공고 + 판로 지원사업). 수출·내수 공고는 두 화면에 모두 나와 같은 공고를 두 번 담을 수 있으므로
 * 공고 id 로 하나로 센다. 나중에 담은 쪽을 남긴다(같은 시각이면 빌리는 돈 쪽). 마감일은 지금 공고 자료가 먼저이고(review.ts noticeEnd),
 * 자료를 못 받았거나 자료에 그 공고·마감일이 없을 때만 담을 때 저장한 마감일을 쓴다. 그때도 나중에 담은 쪽의 저장값이 더 새것이라 마감 연장이 반영된다.
 * 심사 준비 목록·개수와 "확인이 필요한 정보"가 같은 셈을 쓴다.
 */
export function savedNotices(saved: readonly SavedItem[]): SavedItem[] {
  const out = new Map<string, SavedItem>();
  for (const s of saved) {
    if (s.kind !== "program" && s.kind !== "salesProgram") continue;
    const prev = out.get(s.itemId);
    if (!prev || s.savedAt > prev.savedAt || (s.savedAt === prev.savedAt && s.kind === "program")) out.set(s.itemId, s);
  }
  return [...out.values()];
}
export const reviewCount = (l: Pick<Local, "saved">) => savedNotices(l.saved).length + l.saved.filter((s) => s.kind === "gp").length;
/** 자금·판로 단계 옆 개수(screens 1.1): 그 화면에서 담은 것 전체. 심사 준비 개수에 노트에만 담는 입찰공고를 더한 수 */
export const fundingCount = (l: Pick<Local, "saved">) => reviewCount(l) + l.saved.filter((s) => s.kind === "bid").length;
/** 자금·판로 화면에서 이 공고를 담았는가. 빌리는 돈(program)과 판로 갈래(salesProgram)의 같은 공고는 담기 상태가 하나다(screens 5절) */
export const isNoticeSaved = (l: Local, itemId: string) => isSaved(l, "program", itemId) || isSaved(l, "salesProgram", itemId);

export function toggleSaved(cid: string, item: Omit<SavedItem, "savedAt">): boolean {
  const on = !isSaved(getLocal(cid), item.kind, item.itemId);
  update(cid, (l) => ({
    ...l,
    saved: on ? [...l.saved, { ...item, savedAt: now() }] : l.saved.filter((s) => !(s.kind === item.kind && s.itemId === item.itemId)),
  }));
  if (on) void store.put("saved", savedKey(cid, item.kind, item.itemId), { ...item, savedAt: now() });
  else void store.del("saved", savedKey(cid, item.kind, item.itemId));
  return on;
}

/**
 * 공고를 뺀다(두 종류 program·salesProgram 을 한 번에). 심사 준비는 빌리는 돈·판로 갈래에서 담은 같은 공고를 하나로 보이므로(savedNotices)
 * 빼기도 두 종류를 함께 지운다. 자금·판로 화면의 담기 단추도 2026-11-23부터 같은 공고의 담기 상태를 하나로 다루어, 뺄 때 이 함수를 쓴다
 * (funding/Board.tsx noticeSave). 담을 때만 그 갈래의 종류 하나를 저장한다(toggleSaved). 실패하면 false — 부르는 쪽이 다시 누르라고 알린다.
 */
export async function removeNotice(cid: string, itemId: string): Promise<boolean> {
  const kinds: SavedKind[] = ["program", "salesProgram"];
  // 저장소에서는 두 종류 열쇠를 모두 트랜잭션 하나로 지운다(다른 탭이 담아 이 탭 메모리에 없는 사본까지).
  // 화면(메모리)에서는 빼기를 시작할 때 있던 항목만 뺀다: IndexedDB 는 같은 저장소의 쓰기 트랜잭션을 만든 순서대로 처리하므로,
  // 빼기를 시작한 뒤 이 탭에서 새로 담은 것은 지우기 다음에 쓰여 저장소에도 화면에도 남는다.
  // 지워진 뒤에만 화면에서 뺀다. 실패하면(모두 남음) 화면도 그대로 두고 false 를 돌려 부르는 쪽이 다시 누르라고 알린다
  const target = getLocal(cid).saved.filter((s) => s.itemId === itemId && kinds.includes(s.kind));
  const ok = await store.delMany("saved", kinds.map((k) => savedKey(cid, k, itemId)));
  if (ok) update(cid, (l) => ({ ...l, saved: l.saved.filter((s) => !target.includes(s)) }));
  return ok;
}

// ---------------------------------------------------------------- 대조·요약 결과

export function putCheck(cid: string, rec: CheckRecord) {
  update(cid, (l) => ({ ...l, checks: { ...l.checks, [rec.programId]: rec } }));
  void store.put("checks", [cid, rec.programId], rec);
}
export function putRivalCheck(cid: string, rec: RivalCheckRecord) {
  update(cid, (l) => ({ ...l, rivalChecks: { ...l.rivalChecks, [rivalKeyText(rec.programId, rec.rivalKey)]: rec } }));
  void store.put("rivalChecks", [cid, rec.programId, rec.rivalKey], rec);
}
export const rivalCheckOf = (l: Local, programId: string, rivalKey: string) => l.rivalChecks[rivalKeyText(programId, rivalKey)] ?? null;
export function putBrief(cid: string, rec: BriefRecord) {
  update(cid, (l) => ({ ...l, briefs: { ...l.briefs, [rec.gp]: rec } }));
  void store.put("briefs", [cid, rec.gp], rec);
}

// ---------------------------------------------------------------- 경쟁사 비교 대상

/**
 * seed: 화면이 "처음 비교 대상"(screens 4B.1, 비교 자료가 비교한 곳과 그 자료의 직접 추가한 회사)을 보이고 있었다면 그것.
 * 저장된 비교 대상이 비어 있을 때만 그것을 먼저 저장하고 그 위에 바꾼다(보이던 "포함"이 사용자가 누른 순간 사라지지 않게)
 */
export type RivalSeed = Pick<RivalChoices, "choices" | "added">;
const seeded = (cur: RivalChoices, seed?: RivalSeed): RivalChoices =>
  seed && !cur.touched && Object.keys(cur.choices).length === 0 && cur.added.length === 0 ? { choices: { ...seed.choices }, added: [...seed.added] } : cur;

export function setRivalChoice(cid: string, key: string, choice: "yes" | "no" | null, seed?: RivalSeed) {
  const cur = seeded(getLocal(cid).rivalChoices, seed);
  const choices = { ...cur.choices };
  if (choice === null) delete choices[key];
  else choices[key] = choice;
  const next = { ...cur, choices, touched: true };
  update(cid, (l) => ({ ...l, rivalChoices: next }));
  void store.put("rivalChoices", cid, next);
}
export function addRival(cid: string, key: string, name: string, seed?: RivalSeed) {
  const cur = seeded(getLocal(cid).rivalChoices, seed);
  if (cur.added.some((a) => a.key === key)) return;
  const next = { choices: { ...cur.choices, [key]: "yes" as const }, added: [...cur.added, { key, name }], touched: true };
  update(cid, (l) => ({ ...l, rivalChoices: next }));
  void store.put("rivalChoices", cid, next);
}

// ---------------------------------------------------------------- 준비함, 메모, 판로 검색어

export function setPrep(cid: string, fn: (p: Prep) => Prep) {
  const next = fn(getLocal(cid).prep);
  update(cid, (l) => ({ ...l, prep: next }));
  void store.put("prep", cid, next);
}
export function saveMemo(cid: string, memo: string): Promise<boolean> {
  const rec = { memo, updatedAt: now() };
  update(cid, (l) => ({ ...l, notes: rec }));
  return store.put("notes", cid, rec);
}
export function saveSalesKeywords(cid: string, keywords: string[]) {
  update(cid, (l) => ({ ...l, salesKeywords: keywords }));
  void store.put("salesKeywords", cid, keywords);
}

const LOCAL_STORES = ["edits", "saved", "checks", "rivalChecks", "briefs", "rivalChoices", "prep", "notes", "salesKeywords"] as const;

/**
 * 파일에서 불러온 내용으로 이 회사의 브라우저 자료를 바꾼다. 넣을 레코드와 화면 값을 먼저 모두 만든 뒤에 지우고 쓴다:
 * 만드는 중에 어긋난 항목이 있으면 예외가 나고, 그때 지금 자료는 하나도 지우지 않는다(파일 모양 검사는 note.parseImport).
 */
export async function replaceLocal(cid: string, data: Omit<Local, "loaded">) {
  const rows: [store.StoreName, store.Key, unknown][] = [["edits", cid, data.edits]];
  for (const s of data.saved) rows.push(["saved", savedKey(cid, s.kind, s.itemId), s]);
  for (const c of Object.values(data.checks)) rows.push(["checks", [cid, c.programId], c]);
  for (const c of Object.values(data.rivalChecks)) rows.push(["rivalChecks", [cid, c.programId, c.rivalKey], c]);
  for (const b of Object.values(data.briefs)) rows.push(["briefs", [cid, b.gp], b]);
  rows.push(["rivalChoices", cid, data.rivalChoices], ["prep", cid, data.prep]);
  if (data.notes) rows.push(["notes", cid, data.notes]);
  if (data.salesKeywords) rows.push(["salesKeywords", cid, data.salesKeywords]);
  const next: Local = {
    ...data,
    loaded: true,
    saved: [...data.saved].sort((a, b) => a.savedAt.localeCompare(b.savedAt)),
    checks: Object.fromEntries(Object.values(data.checks).map((c) => [c.programId, c])),
    rivalChecks: Object.fromEntries(Object.values(data.rivalChecks).map((c) => [rivalKeyText(c.programId, c.rivalKey), c])),
    briefs: Object.fromEntries(Object.values(data.briefs).map((b) => [b.gp, b])),
  };

  for (const s of LOCAL_STORES) {
    for (const r of await store.all(s, cid)) await store.del(s, r.key);
  }
  for (const [s, key, value] of rows) await store.put(s, key, value);
  cache.set(cid, next);
  emit(cid);
}

export async function forgetCompany(cid: string) {
  await store.clearCompany(cid);
  cache.delete(cid);
  loading.delete(cid);
  emit(cid);
}

// ---------------------------------------------------------------- 회사 목록, 분석 사본, 진행 중 작업

export type CompanyRow = { name: string; lastOpenedAt: string; analyzedAt: string | null; isExample: boolean };
export type SnapshotRow = { job: AnalysisJob; savedAt: string };
export type JobRow = { jobId: string; startedAt: string };

export async function recentCompanies(): Promise<({ companyId: string; saved: number } & CompanyRow)[]> {
  const [rows, saved] = await Promise.all([store.all<CompanyRow>("companies"), store.all<SavedItem>("saved")]);
  return rows
    .map((r) => ({ companyId: r.key as string, ...r.value, saved: saved.filter((s) => Array.isArray(s.key) && s.key[0] === r.key && s.value.kind !== "bid").length }))
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export function touchCompany(cid: string, job: AnalysisJob) {
  void store.put("companies", cid, { name: job.company.name, lastOpenedAt: now(), analyzedAt: job.analyzedAt, isExample: job.isExample } satisfies CompanyRow);
}

export const loadSnapshot = (cid: string) => store.get<SnapshotRow>("snapshots", cid);

/** 같은 회사의 새 응답이 이전 사본보다 새것이면 바꾼다(계약 12.3) */
export function shouldReplace(prev: AnalysisJob | null | undefined, next: AnalysisJob): boolean {
  if (!prev) return true;
  if (prev.jobId !== next.jobId) return prev.status === "running" || (next.status !== "running" && (next.analyzedAt ?? "") >= (prev.analyzedAt ?? ""));
  if ((next.analyzedAt ?? "") !== (prev.analyzedAt ?? "")) return true;
  return (Object.keys(next.sections) as (keyof AnalysisJob["sections"])[]).some(
    (k) => next.sections[k].analyzedAt !== prev.sections[k].analyzedAt || next.sections[k].status !== prev.sections[k].status || next.sections[k].rerun?.status !== prev.sections[k].rerun?.status,
  );
}

export const saveSnapshot = (job: AnalysisJob) => store.put("snapshots", job.companyId, { job, savedAt: now() } satisfies SnapshotRow);
export const rememberJob = (cid: string, jobId: string) => store.put("jobs", cid, { jobId, startedAt: now() } satisfies JobRow);
export const recallJob = (cid: string) => store.get<JobRow>("jobs", cid);
export const forgetJob = (cid: string) => store.del("jobs", cid);
