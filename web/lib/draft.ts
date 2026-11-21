// 회사명 조회 결과(초안)를 회사 정보에 반영하는 규칙. 화면 상태와 무관한 순수 함수라 따로 둔다.

export type CompanyValues = { name: string; founded: string; industry: string; employees: string; revenue: string; need: string; notes: string };
export type Draft = { name: string; founded: string; foundedYear: string; region: string; industry: string; employees: string; revenue: string };

/**
 * 직전 조회의 기록. draft 에는 조회 응답 전체가 아니라 **그 조회가 실제로 칸에 채운 값**만 넣는다(appliedFrom 의 결과).
 * 사용자가 먼저 적어 둔 값이 조회 결과와 우연히 같더라도 조회가 채운 값으로 취급하지 않기 위해서다.
 */
export type Previous = { query: string; draft: Draft } | null;
export const EMPTY_DRAFT: Draft = { name: "", founded: "", foundedYear: "", region: "", industry: "", employees: "", revenue: "" };
const AUTO_KEYS = ["founded", "industry", "employees", "revenue"] as const;
const yearNote = (year: string) => `설립 ${year}년(월 미확인)`;

/**
 * 다른 회사를 조회해서 채운 값이 그대로 남아 있는 칸. 회사명이 그 조회와 다를 때만 해당한다.
 * 사용자가 고친 값은 조회 값과 달라지므로 여기에 들지 않는다.
 */
export function staleAutofill(current: CompanyValues, previous: Previous): string[] {
  if (!previous || sameCompany(previous.query, current.name)) return [];
  const keys: string[] = AUTO_KEYS.filter((k) => current[k].trim() !== "" && current[k].trim() === previous.draft[k]);
  // 설립 월을 몰라 '그 밖의 사항'에 적어 둔 설립연도도 이전 회사의 값이다
  if (previous.draft.foundedYear && current.notes.includes(yearNote(previous.draft.foundedYear))) keys.push("notes");
  return keys;
}

/** 이번 조회가 실제로 칸에 채운 값만 추린다. 다음 조회나 지우기에서 '조회가 채운 값'을 가려내는 기준이 된다. */
export function appliedFrom(patch: Partial<CompanyValues>, draft: Draft): Draft {
  const applied: Draft = { ...EMPTY_DRAFT };
  for (const k of AUTO_KEYS) applied[k] = patch[k] ?? "";
  if (draft.foundedYear && (patch.notes ?? "").includes(yearNote(draft.foundedYear))) applied.foundedYear = draft.foundedYear;
  return applied;
}

/**
 * 조회 결과를 지울 때 함께 지울 값. 그 조회로 채워진 뒤 바뀌지 않은 칸만 지운다(회사명이 같아도 지운다).
 * 조회 결과만 지우고 값을 남기면 그 값이 어느 회사 것인지 알 수 없게 되기 때문이다.
 */
export function clearAutofill(current: CompanyValues, previous: Previous): Partial<CompanyValues> {
  if (!previous) return {};
  const patch: Partial<CompanyValues> = {};
  for (const k of AUTO_KEYS) {
    if (current[k].trim() !== "" && current[k].trim() === previous.draft[k]) patch[k] = "";
  }
  const note = previous.draft.foundedYear ? yearNote(previous.draft.foundedYear) : "";
  if (note && current.notes.includes(note)) {
    patch.notes = current.notes.split(",").map((x) => x.trim()).filter((x) => x && x !== note).join(", ");
  }
  return patch;
}

/** 이전 회사 조회로 채운 값을 지우는 변경분. */
export function clearStale(current: CompanyValues, previous: Previous): Partial<CompanyValues> {
  const patch: Partial<CompanyValues> = {};
  const stale = staleAutofill(current, previous);
  for (const k of AUTO_KEYS) if (stale.includes(k)) patch[k] = "";
  const note = previous && !sameCompany(previous.query, current.name) && previous.draft.foundedYear ? yearNote(previous.draft.foundedYear) : "";
  if (note && current.notes.includes(note)) {
    patch.notes = current.notes.split(",").map((x) => x.trim()).filter((x) => x && x !== note).join(", ");
  }
  return patch;
}

/**
 * 조회 결과에서 반영할 값만 고른다.
 * - 조회를 요청한 회사명과 지금 입력된 회사명이 다르면 아무것도 반영하지 않는다(null). 조회에 1~2분이 걸려 그 사이 회사를 바꿨을 수 있다.
 * - 지금 비어 있는 칸만 채운다. 조회를 기다리는 동안 사용자가 적은 값도 그대로 둔다.
 * - 직전 조회(previous)로 채워진 뒤 손대지 않은 값은 빈칸으로 보고 새 값으로 바꾸거나 지운다. 같은 회사를 다시 조회할 때도 그렇다.
 *   이렇게 해야 '조회로 채워진 값 = 저장된 조회 결과의 값'이 항상 성립해, 나중에 회사를 바꿀 때 남은 값을 가려낼 수 있다.
 */
export function draftPatch(current: CompanyValues, draft: Draft, requestedName: string, previous: Previous = null): Partial<CompanyValues> | null {
  if (current.name.trim() !== requestedName.trim()) return null;
  const cleared = clearAutofill(current, previous);
  const base: CompanyValues = { ...current, ...cleared };
  const patch: Partial<CompanyValues> = { ...cleared };
  for (const k of AUTO_KEYS) {
    if (!base[k].trim() && draft[k]) patch[k] = draft[k];
  }
  // 설립 월을 모르면 연도만 '그 밖의 사항'에 적는다. 월을 지어내지 않는다
  if (!base.founded.trim() && !draft.founded && draft.foundedYear && !base.notes.includes("설립")) {
    patch.notes = [base.notes.trim(), yearNote(draft.foundedYear)].filter(Boolean).join(", ");
  }
  return patch;
}

/** 조회 결과가 지금 입력된 회사의 것인지. 회사명을 바꾸면 이전 회사의 조회 결과(기존 투자자 등)를 쓰지 않는다. */
export const sameCompany = (lookupQuery: string, currentName: string) => currentName.trim() !== "" && lookupQuery.trim() === currentName.trim();
