import assert from "node:assert/strict";
import test from "node:test";
import { appliedFrom, clearAutofill, clearStale, draftPatch, sameCompany, staleAutofill } from "./draft.ts";

const empty = { name: "가나다", founded: "", industry: "", employees: "", revenue: "", need: "", notes: "" };
const draft = { name: "주식회사 가나다", founded: "2019-03", foundedYear: "", region: "대전", industry: "기업용 SaaS", employees: "12명", revenue: "8억원" };

test("빈칸만 채운다", () => {
  assert.deepEqual(draftPatch(empty, draft, "가나다"), { founded: "2019-03", industry: "기업용 SaaS", employees: "12명", revenue: "8억원" });
});

test("조회를 기다리는 동안 사용자가 적은 값은 덮어쓰지 않는다", () => {
  const edited = { ...empty, industry: "직접 적은 업종", employees: "15명" };
  assert.deepEqual(draftPatch(edited, draft, "가나다"), { founded: "2019-03", revenue: "8억원" });
});

test("조회 중 회사명을 바꿨으면 이전 회사의 결과를 반영하지 않는다", () => {
  assert.equal(draftPatch({ ...empty, name: "라마바" }, draft, "가나다"), null);
  assert.equal(draftPatch({ ...empty, name: "" }, draft, "가나다"), null);
  assert.notEqual(draftPatch({ ...empty, name: " 가나다 " }, draft, "가나다"), null);
});

test("설립 월을 모르면 연도만 그 밖의 사항에 적는다", () => {
  const yearOnly = { ...draft, founded: "", foundedYear: "2015" };
  assert.equal(draftPatch({ ...empty, notes: "벤처기업 확인" }, yearOnly, "가나다").notes, "벤처기업 확인, 설립 2015년(월 미확인)");
  assert.equal(draftPatch({ ...empty, notes: "설립 2015년(월 미확인)" }, yearOnly, "가나다").notes, undefined);
  assert.equal(draftPatch({ ...empty, founded: "2015-04" }, yearOnly, "가나다").notes, undefined);
});

test("조회 결과는 회사명이 같을 때만 그 회사의 것으로 본다", () => {
  assert.equal(sameCompany("라이너", " 라이너 "), true);
  assert.equal(sameCompany("라이너", "가나다"), false);
  assert.equal(sameCompany("라이너", ""), false);
  assert.equal(sameCompany("", ""), false);
});

test("회사 A 를 조회한 뒤 회사 B 를 조회하면 A 의 값이 B 에 남지 않는다", () => {
  const afterA = { ...empty, name: "가나다", ...draftPatch(empty, draft, "가나다") };
  assert.equal(afterA.industry, "기업용 SaaS");
  const typingB = { ...afterA, name: "라마바", need: "운전자금 1억" };
  const draftB = { name: "라마바", founded: "2021-05", foundedYear: "", region: "서울", industry: "제조업", employees: "", revenue: "" };
  const patch = draftPatch(typingB, draftB, "라마바", { query: "가나다", draft });
  assert.deepEqual(patch, { founded: "2021-05", industry: "제조업", employees: "", revenue: "" });
  assert.equal({ ...typingB, ...patch }.need, "운전자금 1억");
});

test("사용자가 직접 고친 값은 다른 회사 조회에서도 지우지 않는다", () => {
  const current = { ...empty, name: "라마바", founded: "2019-03", industry: "직접 고친 업종" };
  assert.deepEqual(staleAutofill(current, { query: "가나다", draft }), ["founded"]);
  const patch = draftPatch(current, { ...draft, name: "라마바", founded: "", industry: "제조업" }, "라마바", { query: "가나다", draft });
  assert.equal(patch.founded, "");
  assert.equal(patch.industry, undefined);
});

test("같은 회사를 다시 조회할 때는 이전 값을 지우지 않는다", () => {
  const current = { ...empty, founded: "2019-03" };
  assert.deepEqual(staleAutofill(current, { query: "가나다", draft }), []);
  assert.deepEqual(clearStale(current, { query: "가나다", draft }), {});
  assert.deepEqual(staleAutofill(current, null), []);
});

test("이전 회사의 설립연도 메모도 지운다", () => {
  const prev = { query: "가나다", draft: { ...draft, founded: "", foundedYear: "2015" } };
  const current = { ...empty, name: "라마바", notes: "벤처기업 확인, 설립 2015년(월 미확인)" };
  assert.deepEqual(clearStale(current, prev), { notes: "벤처기업 확인" });
});

test("조회 결과를 지우면 그 조회로 채운 값도 지워져 다음 회사에 남지 않는다", () => {
  // A 조회 → 값이 채워짐. 그중 업종은 사용자가 고침
  const afterA = { ...empty, ...draftPatch(empty, draft, "가나다"), industry: "직접 고친 업종" };
  // '조회 결과 지우기': 조회로 채워진 채 그대로인 칸만 지운다
  const cleared = { ...afterA, ...clearAutofill(afterA, { query: "가나다", draft }) };
  assert.deepEqual({ founded: cleared.founded, industry: cleared.industry, employees: cleared.employees, revenue: cleared.revenue },
    { founded: "", industry: "직접 고친 업종", employees: "", revenue: "" });
  // 회사명을 B 로 바꾸고 B 조회(이전 조회 정보 없음): A 의 값이 남아 있지 않으므로 B 의 값이 들어간다
  const draftB = { name: "라마바", founded: "2021-05", foundedYear: "", region: "서울", industry: "제조업", employees: "30명", revenue: "" };
  const patch = draftPatch({ ...cleared, name: "라마바" }, draftB, "라마바", null);
  assert.deepEqual(patch, { founded: "2021-05", employees: "30명" });
});

test("조회 결과가 없으면 지울 값도 없다", () => {
  assert.deepEqual(clearAutofill({ ...empty, founded: "2019-03" }, null), {});
  const prev = { query: "가나다", draft: { ...draft, founded: "", foundedYear: "2015" } };
  assert.deepEqual(clearAutofill({ ...empty, notes: "설립 2015년(월 미확인)" }, prev), { notes: "" });
});

test("같은 회사를 다시 조회해 값이 달라져도, 이후 회사를 바꾸면 그 값을 가려낸다", () => {
  // 1) A 첫 조회: 직원 12명이 채워짐
  const first = { ...draft, employees: "12명" };
  let form = { ...empty, ...draftPatch(empty, first, "가나다") };
  assert.equal(form.employees, "12명");
  // 2) A 다시 조회: 15명으로 나옴 → 손대지 않은 자동 입력값은 새 값으로 바뀐다
  const second = { ...draft, employees: "15명" };
  form = { ...form, ...draftPatch(form, second, "가나다", { query: "가나다", draft: first }) };
  assert.equal(form.employees, "15명");
  // 3) 회사명을 B 로 바꾸면 남은 값이 경고 대상으로 잡히고, 지우기와 B 조회 모두 그 값을 없앤다
  const asB = { ...form, name: "라마바" };
  const stored = { query: "가나다", draft: second };
  assert.equal(staleAutofill(asB, stored).includes("employees"), true);
  assert.equal(clearAutofill(asB, stored).employees, "");
  const draftB = { name: "라마바", founded: "", foundedYear: "", region: "", industry: "", employees: "", revenue: "" };
  assert.equal(draftPatch(asB, draftB, "라마바", stored).employees, "");
});

test("다시 조회했을 때 사용자가 고친 값은 그대로 두고, 새 조회에 없는 자동 입력값은 지운다", () => {
  const first = { ...draft, employees: "12명", revenue: "8억원" };
  const form = { ...empty, ...draftPatch(empty, first, "가나다"), industry: "직접 고친 업종" };
  const second = { ...draft, employees: "", revenue: "9억원", industry: "새로 찾은 업종" };
  const patch = draftPatch(form, second, "가나다", { query: "가나다", draft: first });
  assert.equal(patch.employees, "");
  assert.equal(patch.revenue, "9억원");
  assert.equal(patch.industry, undefined);
});

test("사용자가 먼저 적은 값이 조회 결과와 같아도 조회가 채운 값으로 보지 않는다", () => {
  // 직원 수를 직접 적어 둔 상태에서 조회 결과도 12명
  const typed = { ...empty, employees: "12명" };
  const found = { ...draft, employees: "12명" };
  const patch = draftPatch(typed, found, "가나다");
  assert.equal(patch.employees, undefined);
  const applied = appliedFrom(patch, found);
  assert.equal(applied.employees, "");
  assert.equal(applied.industry, "기업용 SaaS");
  const form = { ...typed, ...patch };
  const stored = { query: "가나다", draft: applied };
  // 조회 결과 지우기: 조회가 채운 업종은 지워지고 직접 적은 직원 수는 남는다
  const cleared = clearAutofill(form, stored);
  assert.equal(cleared.employees, undefined);
  assert.equal(cleared.industry, "");
  // 다시 조회해 직원 수가 다르게 나와도 직접 적은 값은 바뀌지 않는다
  assert.equal(draftPatch(form, { ...draft, employees: "20명" }, "가나다", stored).employees, undefined);
  // 회사를 바꿔도 직접 적은 값은 '이전 회사 조회 값'으로 잡히지 않는다
  assert.equal(staleAutofill({ ...form, name: "라마바" }, stored).includes("employees"), false);
});

test("설립연도 메모만 남아 있어도 회사를 바꾸면 이전 회사 값으로 잡힌다", () => {
  const yearOnly = { ...draft, founded: "", foundedYear: "2015", industry: "", employees: "", revenue: "" };
  const patch = draftPatch(empty, yearOnly, "가나다");
  assert.deepEqual(patch, { notes: "설립 2015년(월 미확인)" });
  const applied = appliedFrom(patch, yearOnly);
  assert.equal(applied.foundedYear, "2015");
  const asB = { ...empty, ...patch, name: "라마바" };
  const stored = { query: "가나다", draft: applied };
  assert.deepEqual(staleAutofill(asB, stored), ["notes"]);
  assert.deepEqual(clearAutofill(asB, stored), { notes: "" });
  assert.deepEqual(clearStale(asB, stored), { notes: "" });
  // 같은 회사일 때는 경고 대상이 아니다
  assert.deepEqual(staleAutofill({ ...asB, name: "가나다" }, stored), []);
});

test("사용자가 이미 적어 둔 설립 메모가 있으면 연도 메모를 채운 것으로 기록하지 않는다", () => {
  const yearOnly = { ...draft, founded: "", foundedYear: "2015" };
  const typed = { ...empty, notes: "설립 2015년(월 미확인)" };
  const patch = draftPatch(typed, yearOnly, "가나다");
  assert.equal(patch.notes, undefined);
  assert.equal(appliedFrom(patch, yearOnly).foundedYear, "");
});

test("예시 회사는 아무것도 적지 않았을 때만 불러온다", async () => {
  const { isBlankCompany } = await import("./draft.ts");
  const blank = { name: "", founded: "", industry: "", employees: "", revenue: "", need: "", notes: "" };
  assert.equal(isBlankCompany(blank), true);
  assert.equal(isBlankCompany({ ...blank, name: "  " }), true);
  for (const key of Object.keys(blank)) assert.equal(isBlankCompany({ ...blank, [key]: "값" }), false, key);
});
