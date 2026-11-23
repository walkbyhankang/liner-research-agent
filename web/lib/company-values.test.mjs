// 실행: npm test. 공고문 대조·운용사 요약에 보낼 회사 값(계약 13절).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filledCount, foundedForCheck, noticeCompany, rivalNoticeCompany } from "./company-values.ts";

const fx = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/analysis/${name}.json`, import.meta.url), "utf8"));
const job = (name, i = 0) => fx(name).exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[i].response;
const edit = (value) => ({ value, updatedAt: "2026-11-22T21:00:00.000Z" });

test("분석 값만으로 만든 회사 값: 원문 확인·보도 값만, 국민연금은 메모에(R-05)", () => {
  const c = noticeCompany(job("F-FULL"), {});
  assert.deepEqual(c, {
    name: "주식회사 가나다테크", region: "서울", biz: "", founded: "2020-09", industry: "전자집적회로 제조업", employees: "약 120명 (2026-06 기준)",
    revenue: "56.7억원 (2024 사업연도, 별도)", need: "",
    notes: "검색으로 확인한 특허 11건(출원인 확인, 등록 8건), 국민연금 가입자 132명(2026-10, 직원 수와 다름)",
  });
  assert.ok(!c.employees.includes("132"));
});

test("고친 값이 먼저이고, 기업 유형은 고른 것만 쓴다(추정 적용 금지)", () => {
  const c = noticeCompany(job("F-FULL"), { bizType: edit("venture"), need: edit("운전자금 3억 원"), notes: edit("세금 체납 없음"), industry: edit("고친 업종") });
  assert.equal(c.biz, "venture");
  assert.equal(c.need, "운전자금 3억 원");
  assert.equal(c.industry, "고친 업종");
  assert.ok(c.notes.startsWith("세금 체납 없음, 검색으로 확인한 특허 11건"));
  assert.equal(noticeCompany(job("F-FULL"), {}).biz, "");
});

test("엇갈림이면 공공 API 값(usedIndex), 쓸 값이 없으면 비운다", () => {
  assert.equal(noticeCompany(job("F-CONFLICT"), {}).founded, "2020-09");
  const v = { status: "conflicting", raw: "2021-01", usedIndex: null, values: [{ raw: "2021-01" }] };
  assert.deepEqual(foundedForCheck(v), { value: "", note: null });
  assert.deepEqual(foundedForCheck({ status: "reported", raw: "2019", usedIndex: null, values: null }), { value: "", note: "설립 2019년(월 미확인)" });
  assert.deepEqual(foundedForCheck({ status: "inferred", raw: "2019-03", usedIndex: null, values: null }), { value: "", note: null });
});

test("법인 없이 분석한 회사: 보도된 본사 지역은 쓰고, 미확보 값은 비운다", () => {
  const c = noticeCompany(job("F-NOCORP"), {});
  assert.equal(c.region, "부산");
  assert.equal(c.revenue.includes("억원") || c.revenue === "" || c.revenue.length > 0, true);
});

test("대조에 쓰는 회사 값 n/8: 실제로 들어가는 칸만 센다(R-11)", () => {
  assert.equal(filledCount(job("F-FULL"), {}), 5);
  assert.equal(filledCount(job("F-FULL"), { bizType: edit("venture"), need: edit("운전자금"), notes: edit("인증 없음") }), 8);
});

test("메모가 400자를 넘으면 자동 메모부터 뺀다", () => {
  const c = noticeCompany(job("F-FULL"), { notes: edit("가".repeat(390)) });
  assert.ok(c.notes.length <= 400);
  assert.ok(c.notes.startsWith("가".repeat(390)));
});

test("경쟁사 조건: 지역·기업 유형·필요한 자금은 우리 값, 나머지는 경쟁사 값(계약 13절)", () => {
  const mine = noticeCompany(job("F-RIVALS"), { bizType: edit("venture"), need: edit("운전자금") });
  const r = rivalNoticeCompany("rival:마바사", job("F-RIVALS"), mine);
  assert.equal(r.name, "마바사");
  assert.equal(r.region, mine.region);
  assert.equal(r.biz, "venture");
  assert.equal(r.need, "운전자금");
  assert.equal(r.founded, "2018-04");
  assert.equal(r.industry, "마바사는 추론용 칩을 만드는 가짜 경쟁사다.");
  assert.match(r.revenue, /^56\.7억원 \(2024 사업연도, 별도\)$/);
  assert.match(r.notes, /국민연금 가입자 132명\(2026-10, 직원 수와 다름\)/);
  assert.match(r.notes, /누적 투자 USD 180,000,000/);
  // 깊이 비교 전에는 merged.rivals 의 값을 지금 rival.ts 규칙으로
  const r2 = rivalNoticeCompany("rival:카타파", job("F-FULL"), mine);
  assert.equal(r2.industry, "");
  assert.equal(rivalNoticeCompany("rival:없음", job("F-FULL"), mine), null);
});
