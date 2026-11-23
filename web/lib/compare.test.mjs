// 실행: npm test. 경쟁사 분석 비교 표(screens 4B.2, RI-07)를 가짜 응답(F-RIVALS, F-CONFLICT, F-STAGED)으로 시험한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COMPARE_ITEMS, cellText, compareColumns, myColumn, rivalColumn } from "./compare.ts";

const fx = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/analysis/${name}.json`, import.meta.url), "utf8"));
const job = (name) => fx(name).exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[0].response;

test("항목은 7줄이고 우리 회사가 첫 열, 그다음 비교한 순서(rivalSet)다", () => {
  assert.deepEqual(COMPARE_ITEMS.map((i) => i.label), ["매출", "국민연금 가입자", "누적 투자", "국내 특허", "최근 라운드", "주요 투자자", "설립"]);
  // 앞 4줄은 회사 분석 핵심 값 띠와 같은 항목(좁은 화면 1층)
  assert.deepEqual(COMPARE_ITEMS.filter((i) => i.core).map((i) => i.key), ["revenue", "nps", "funding", "patents"]);
  const j = job("F-RIVALS");
  const cols = compareColumns(j);
  assert.deepEqual(cols.map((c) => c.name), ["주식회사 가나다테크", "마바사", "하하테크"]);
  assert.equal(cols[0].mine, true);
  // 비교 자료가 없으면 우리 회사 열만
  assert.equal(compareColumns(job("F-FULL")).length, 1);
});

test("값이 있는 칸은 기준·상태 낱말·짧은 출처를 갖고, 연결/별도·통화를 그대로 둔다", () => {
  const mine = myColumn(job("F-RIVALS")).cells;
  assert.deepEqual(mine.revenue, { kind: "value", lines: ["56.7억원"], basis: "2024 사업연도, 별도", word: "confirmed", source: "금융위원회" });
  assert.equal(mine.nps.word, "reference");
  assert.equal(mine.nps.basis, "2026-10");
  assert.deepEqual(mine.funding.lines, ["$250.0M"]);
  assert.equal(mine.funding.basis, "People Data Labs 누적액");
  assert.equal(mine.patents.basis, "등록 8건");
  assert.equal(mine.patents.source, "Google Patents");
  assert.match(mine.investors.lines[0], /외 \d+곳$/);
  const r = rivalColumn(job("F-RIVALS").sections.rivals_deep.result.rivals[0]).cells;
  assert.deepEqual(r.revenue, { kind: "value", lines: ["56.7억원"], basis: "2024 사업연도, 별도", word: "confirmed", source: "금융위원회" });
  assert.deepEqual(r.nps.lines, ["132명"]);
  assert.equal(r.founded.lines[0], "2018-04-02");
  assert.deepEqual(r.funding.lines, ["$180.0M"]);
  assert.match(r.funding.basis, /라운드 금액 합계/);
  assert.equal(r.latest.lines[0], "시리즈 C $120.0M");
  assert.equal(r.patents.lines[0], "6건");
  assert.equal(r.investors.lines[0], "타파하인베스트, Test Ventures X, Test Ventures Y");
  for (const c of Object.values(r)) if (c.kind === "value") assert.ok(c.word && c.source, JSON.stringify(c));
});

test("자료가 없는 경쟁사 칸은 미확보와 사유이고 빈칸·0·- 을 쓰지 않는다", () => {
  const h = rivalColumn(job("F-RIVALS").sections.rivals_deep.result.rivals[1]).cells;
  for (const k of ["founded", "revenue", "nps", "funding", "latest", "patents", "investors"]) {
    assert.equal(h[k].kind, "missing", k);
    assert.ok(h[k].reason.length >= 4, `${k}: ${h[k].reason}`);
    assert.doesNotMatch(cellText(h[k]), /^(0|-|—)?$/);
  }
  assert.equal(h.founded.reason, "법인이 확인되지 않음");
  assert.equal(h.revenue.reason, "금융위원회 재무 자료 없음");
  assert.equal(h.patents.reason, "출원인이 확인된 특허를 찾지 못함");
});

test("경쟁사에 투자 라운드는 있는데 투자기관 이름이 없으면 그 사유를 정확히 쓴다", () => {
  const r = structuredClone(job("F-RIVALS").sections.rivals_deep.result.rivals[0]);
  r.funding.investors = [];
  const cells = rivalColumn(r).cells;
  assert.equal(cells.funding.kind, "value");
  assert.deepEqual(cells.investors, { kind: "missing", reason: "투자기관 이름 자료 없음" });
  // 투자 라운드 자체가 없으면 서버 사유 그대로
  assert.equal(rivalColumn(job("F-RIVALS").sections.rivals_deep.result.rivals[1]).cells.investors.reason, "투자 라운드 자료 없음");
});

test("엇갈린 우리 회사 값은 두 값을 함께 두고, 고친 값은 직접 입력이며, 확인 중인 값은 확인 중이다", () => {
  const c = myColumn(job("F-CONFLICT")).cells.founded;
  assert.equal(c.kind, "conflict");
  assert.equal(c.alts.length, 2);
  assert.match(cellText(c), /다른 자료: 2021-01/);
  const e = myColumn(job("F-RIVALS"), { revenue: { value: "8억 원", updatedAt: "x" } }).cells.revenue;
  assert.deepEqual([e.word, e.lines[0]], ["edited", "8억 원"]);
  const staged = fx("F-STAGED").exchanges[0].response;
  const t0 = myColumn(staged).cells;
  assert.equal(t0.funding.kind, "pending");
  assert.equal(cellText(t0.funding), "확인 중");
});

test("표 글에 순위·차이·합계·판정 낱말이 없다(RI-17)", () => {
  const all = compareColumns(job("F-RIVALS")).flatMap((c) => Object.values(c.cells).map(cellText)).join("\n");
  assert.doesNotMatch(all, /위\b|순위|우세|열세|점수|확률|합계 차이|±|최고|최저/);
});
