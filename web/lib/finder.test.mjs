// 실행: npm test (Node 의 타입 제거 기능으로 finder.ts 를 직접 불러온다)
import assert from "node:assert/strict";
import test from "node:test";
import { dday, fundAlive, gpKey, groupFunds, isExistingInvestor, splitInvestors, inNeed, isSoon, matchProgram, notExpired, sorter, withStatus } from "./finder.ts";

const program = (over = {}) => ({
  id: "P1", title: "공고", category: "금융", sub: "융자", target: "중소기업", agency: "중소벤처기업부", operator: "", regions: ["전국"],
  agencyRegion: null, period: { raw: "", start: null, end: null, status: "수시" }, intro: "", points: [], tags: [], url: "", applyUrl: "",
  applyMethod: "", contact: "", docUrl: "", created: "2026-11-01", ...over,
});
const dated = (start, end, status) => program({ period: { raw: `${start} ~ ${end}`, start, end, status } });
const venture = { region: "대전", biz: "venture", need: "loan", field: "ai" };
/** 화면이 스냅샷을 읽을 때와 같은 순서: 마감된 공고를 빼고 상태를 다시 정한다. */
const live = (p, today) => (notExpired(p, today) ? withStatus(p, today) : null);

test("접수 예정 공고는 시작일이 되면 접수 중으로 바뀐다", () => {
  const p = dated("2026-11-23", "2026-12-11", "접수 예정");
  assert.equal(live(p, "2026-11-22").period.status, "접수 예정");
  assert.equal(live(p, "2026-11-23").period.status, "접수 중");
  assert.equal(live(p, "2026-12-11").period.status, "접수 중");
});

test("마감일이 지난 공고는 저장된 상태와 상관없이 빠진다", () => {
  assert.equal(live(dated("2026-11-23", "2026-11-23", "접수 예정"), "2026-11-24"), null);
  assert.equal(live(dated("2026-11-01", "2026-11-20", "접수 중"), "2026-11-21"), null);
  assert.notEqual(live(dated("2026-11-01", "2026-11-21", "접수 중"), "2026-11-21"), null);
});

test("접수 예정이던 공고도 접수가 시작되면 마감 임박에 잡힌다", () => {
  const scheduled = dated("2026-11-23", "2026-11-30", "접수 예정");
  assert.equal(isSoon(live(scheduled, "2026-11-21"), "2026-11-21"), false);
  assert.equal(isSoon(live(scheduled, "2026-11-25"), "2026-11-25"), true);
});

test("날짜가 없는 공고는 그대로 둔다", () => {
  const p = program({ period: { raw: "예산 소진시까지", start: null, end: null, status: "수시" } });
  assert.equal(live(p, "2030-01-01"), p);
});

test("남은 날 계산", () => {
  assert.equal(dday("2026-11-30", "2026-11-21"), 9);
  assert.equal(dday("2026-11-21", "2026-11-21"), 0);
  assert.equal(dday(null, "2026-11-21"), null);
});

test("지역과 지원대상 대조", () => {
  assert.equal(matchProgram(program({ regions: ["경기"] }), venture).excluded, "지역");
  assert.equal(matchProgram(program({ target: "소상공인" }), venture).excluded, "대상");
  const loose = matchProgram(program(), venture);
  assert.equal(loose.ok, true);
  assert.equal(loose.exact, false);
  assert.equal(loose.checks.length > 0, true);
  assert.equal(matchProgram(program({ target: "창업벤처", regions: ["대전"] }), venture).local, true);
  assert.equal(matchProgram(program({ regions: ["전남광주"] }), { ...venture, region: "광주" }).ok, true);
});

test("다른 지역 지자체 공고가 전국으로 분류되면 확인 항목으로 표시한다", () => {
  const m = matchProgram(program({ agency: "충청북도", agencyRegion: "충북" }), venture);
  assert.equal(m.ok, true);
  assert.equal(m.doubt, true);
  assert.equal(matchProgram(program({ agency: "대전광역시", agencyRegion: "대전" }), venture).local, true);
});

test("마감 임박순 정렬은 날짜가 있는 접수 중 공고를 먼저 둔다", () => {
  const list = [program({ id: "수시" }), dated("2026-11-01", "2026-12-31", "접수 중"), dated("2026-11-01", "2026-11-30", "접수 중")].map((p) => matchProgram(p, venture));
  assert.deepEqual(list.sort(sorter("deadline")).map((m) => m.program.period.end), ["2026-11-30", "2026-12-31", null]);
});

test("펀드는 분야 낱말로 걸러 운용사별로 묶는다", () => {
  const fund = (name, gp, field, year) => ({ name, gp, field, year, maturity: "2033-01-01", commitRaw: null });
  const groups = groupFunds([fund("A1", "가", "초격차", 2023), fund("A2", "가", "AI", 2025), fund("B1", "나", "바이오", 2025), fund("C1", "다", "딥테크", 2024)], "ai", "");
  assert.deepEqual(groups.map((g) => [g.gp, g.funds.length, g.latestYear]), [["가", 2, 2025], ["다", 1, 2024]]);
});

test("융자·보증에는 보험과 펀드/투자 공고가 섞이지 않는다", () => {
  const loan = program({ sub: "융자" });
  const guarantee = program({ sub: "보증" });
  const insurance = program({ sub: "보험(수출+무역)" });
  const fund = program({ sub: "펀드/투자" });
  assert.deepEqual([loan, guarantee, insurance, fund].map((p) => inNeed(p, "loan")), [true, true, false, false]);
  assert.deepEqual([loan, guarantee, insurance, fund].map((p) => inNeed(p, "all")), [true, true, true, true]);
  assert.equal(inNeed(program({ category: "창업", sub: "사업화지원" }), "startup"), true);
  assert.equal(inNeed(program({ category: "창업", sub: "사업화지원" }), "loan"), false);
});

test("만기가 지난 펀드는 빠지고 만기일 당일은 남는다", () => {
  const fund = (maturity) => ({ name: "F", gp: "가", field: "AI", year: 2020, maturity, commitRaw: null });
  assert.equal(fundAlive(fund("2026-11-20"), "2026-11-21"), false);
  assert.equal(fundAlive(fund("2026-11-21"), "2026-11-21"), true);
  assert.equal(fundAlive(fund("2033-01-01"), "2026-11-21"), true);
  assert.equal(fundAlive(fund(null), "2026-11-21"), false);
});

test("기존 투자자는 표기가 달라도 같은 운용사로 알아본다", () => {
  assert.equal(gpKey("KB인베스트먼트"), gpKey("케이비인베스트먼트"));
  assert.equal(gpKey("(주)에스엘인베스트먼트"), gpKey("SL 인베스트먼트"));
  const investors = ["LB인베스트먼트", "CJ인베스트먼트", "IBK기업은행"];
  assert.equal(isExistingInvestor("엘비인베스트먼트", investors), true);
  assert.equal(isExistingInvestor("씨제이인베스트먼트 주식회사", investors), true);
  assert.equal(isExistingInvestor("엘비세미콘", investors), false);
  assert.equal(isExistingInvestor("인베스트먼트", investors), false);
  assert.equal(isExistingInvestor("케이비인베스트먼트", []), false);
});

test("확인되거나 보도된 투자자만 기존 투자자로 분류한다", () => {
  const investors = [
    { name: "LB인베스트먼트", status: "confirmed" }, { name: "캡스톤파트너스", status: "reported" },
    { name: "KB인베스트먼트", status: "inferred" }, { name: "SL인베스트먼트", status: "conflicting" }, { name: "미상벤처스", status: "" },
  ];
  const { established, uncertain } = splitInvestors(investors);
  assert.deepEqual(established.map((i) => i.name), ["LB인베스트먼트", "캡스톤파트너스"]);
  assert.deepEqual(uncertain.map((i) => i.name), ["KB인베스트먼트", "SL인베스트먼트", "미상벤처스"]);
  // 추정 기록만 있는 운용사는 기존 투자자로 표시되지 않는다
  const names = established.map((i) => i.name);
  assert.equal(isExistingInvestor("케이비인베스트먼트", names), false);
  assert.equal(isExistingInvestor("엘비인베스트먼트", names), true);
  assert.deepEqual(splitInvestors([]), { established: [], uncertain: [] });
});
