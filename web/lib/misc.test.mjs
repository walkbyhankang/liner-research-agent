// 실행: npm test. 글 만들기(format), 이름 정규화(names), 자금 조달(funding), 심사 준비·판로(review), 브라우저 저장(store), 화면 문구 점검.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { ageLabel, byCurrencyTexts, daysSince, elapsedText, eok, fmtTime, isStale, moneyText, safeUrl, stageKo, wonDisplay, yearsSince } from "./format.ts";
import { normName, userRivalKey } from "./names.ts";
import { initialConditions, relatedTo, rivalBackers, splitExisting } from "./funding.ts";
import { bidDeadline, gaps, sortBids, sortRows, verdictCounts } from "./review.ts";
import { memoryBackend } from "./store.ts";
import { createHash } from "node:crypto";

const fx = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/analysis/${name}.json`, import.meta.url), "utf8"));
const job = (name, i = 0) => fx(name).exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[i].response;

test("억원은 소수 첫째 자리(FI-05), 금액은 통화를 바꾸지 않는다", () => {
  assert.equal(eok(5_670_000_000), "56.7");
  assert.equal(eok(-2_100_000_000), "-21.0");
  assert.equal(wonDisplay(5_670_000_000), "56.7억원");
  assert.equal(wonDisplay(3_000_000), "300만원");
  assert.equal(moneyText(250_000_000, "USD"), "$250.0M");
  assert.equal(moneyText(30_000_000_000, "KRW"), "300억원");
  assert.deepEqual(byCurrencyTexts({ USD: 2.5e8, KRW: 3e10 }), ["$250.0M", "300억원"]);
});

test("투자 단계 우리말(IN-02)", () => {
  assert.equal(stageKo("Series B"), "시리즈 B");
  assert.equal(stageKo("Seed"), "시드");
  assert.equal(stageKo("Corporate round"), "기업 투자");
  assert.equal(stageKo("Undisclosed series"), "단계 미공개");
  assert.equal(stageKo("Bridge"), "Bridge");
});

test("시각·업력·오래된 분석", () => {
  assert.equal(fmtTime("2026-11-22T20:46:24+09:00"), "2026-11-22 20:46");
  assert.equal(yearsSince("2020-09-15", "2026-11-22"), 6);
  assert.equal(yearsSince("2026-03-01", "2026-11-22"), 0);
  assert.equal(ageLabel(0), "업력 1년 미만");
  const now = new Date("2026-11-22T21:00:00+09:00");
  assert.equal(daysSince("2026-10-08T20:46:24+09:00", now), 45);
  assert.equal(isStale("2026-10-08T20:46:24+09:00", now), true);
  assert.equal(isStale("2026-11-22T20:46:24+09:00", now), false);
  assert.equal(elapsedText(72), "1분 12초");
});

test("http·https 가 아닌 주소는 링크로 만들지 않는다(G-12)", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,x"), null);
  assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
});

test("이름 정규화는 계약 1.4와 같고, 이름 기반 회사 id 가 가짜 응답과 맞는다", () => {
  assert.equal(normName("㈜ 가나다 테크"), "가나다테크");
  assert.equal(normName("GANADA TECH Inc."), "ganadatech");
  assert.equal(userRivalKey("직접 넣은 회사"), "user:직접넣은회사");
  const id = `n-${createHash("sha256").update(normName("가나다테크")).digest("hex").slice(0, 16)}`;
  assert.equal(id, job("F-NOCORP").companyId);
});

test("자금 조달 조건: 원문 확인·보도 지역과 분석 관심 분야를 채우고, 기업 유형은 고른 것만(F-01, decisions 2)", () => {
  assert.deepEqual(initialConditions(job("F-FULL").merged, {}).cond, { region: "서울", biz: null, need: "loan", field: "ai" });
  assert.equal(initialConditions(job("F-FULL").merged, { bizType: { value: "venture", updatedAt: "x" } }).cond.biz, "venture");
  assert.equal(initialConditions(job("F-NOCORP").merged, {}).cond.region, "부산");
  const stagedT0 = fx("F-STAGED").exchanges[0].response;
  assert.equal(initialConditions(stagedT0.merged, {}).cond.region, null);
});

test("이미 투자한 운용사는 따로 묶고, 추정 기록의 운용사는 넣지 않는다(F-04, F-05)", () => {
  const gps = ["가나다벤처스", "나다라파트너스", "새운용사"].map((gp) => ({ gp, funds: [], latestYear: 2026 }));
  const { existing, fresh } = splitExisting(gps, job("F-FULL").merged.investors);
  assert.deepEqual(existing.map((g) => g.gp), ["가나다벤처스"]);
  assert.deepEqual(fresh.map((g) => g.gp), ["나다라파트너스", "새운용사"]);
});

test("경쟁사에 투자: 깊이 비교 결과의 투자기관과 같은 이름(F-07)", () => {
  const f = rivalBackers(job("F-RIVALS").sections.rivals_deep.result);
  assert.deepEqual(f("타파하인베스트"), ["마바사"]);
  assert.deepEqual(f("가나다벤처스"), []);
  assert.deepEqual(rivalBackers(null)("타파하인베스트"), []);
});

test("회사 사업과 관련: 제목·요약·태그에 기술 낱말(F-10)", () => {
  const p = { title: "반도체 기업 지원", intro: "", points: [], tags: [] };
  assert.equal(relatedTo(p, ["반도체"]), true);
  assert.equal(relatedTo({ ...p, title: "일반 공고" }, ["반도체", "가"]), false);
});

test("대조 결과: 미충족·확인 필요·충족 순, 개수, 부족한 요건 묶기(R-07, R-10)", () => {
  const a = fx("F-NOTICE").exchanges[0].response;
  assert.deepEqual(verdictCounts(a), { met: 4, unmet: 1, check: 2, other: 2 });
  assert.deepEqual(sortRows(a.match.rows).map((r) => r.verdict).slice(0, 3), ["미충족", "확인 필요", "확인 필요"]);
  const g = gaps([{ programId: "a", programTitle: "공고 가", result: a }, { programId: "b", programTitle: "공고 나", result: a }]);
  assert.deepEqual([g.unmet, g.check, g.checked], [2, 4, 2]);
  assert.equal(g.groups[0].field, "제외대상");
  assert.equal(g.groups[0].items.length, 2);
});

test("입찰공고: 진행 중 → 핵심 낱말 일치 → 마감 가까운 순(P-03), 마감 글", () => {
  const items = fx("F-SALES").exchanges[1].response.sections.sales.result.items;
  const s = sortBids(items);
  const rank = { open: 0, upcoming: 1, unknown: 2, closed: 3 };
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1];
    const b = s[i];
    assert.ok(rank[a.status] < rank[b.status] || (rank[a.status] === rank[b.status] && ((a.relevance === "high") > (b.relevance === "high") || ((a.relevance === "high") === (b.relevance === "high") && (a.deadline ?? "9") <= (b.deadline ?? "9")))));
  }
  assert.equal(bidDeadline(s[0], "2026-11-22"), "D-3, 11.25 마감");
  assert.equal(bidDeadline({ ...s[0], status: "closed" }, "2026-11-22"), "입찰 마감");
});

test("메모리 저장소: 회사 열쇠와 [회사, …] 배열 열쇠로 그 회사 것만 꺼낸다", async () => {
  const b = memoryBackend();
  await b.put("saved", ["c1", "program", "p1"], { a: 1 });
  await b.put("saved", ["c2", "program", "p1"], { a: 2 });
  await b.put("edits", "c1", { x: 1 });
  assert.equal((await b.all("saved", "c1")).length, 1);
  assert.deepEqual(await b.get("edits", "c1"), { x: 1 });
  await b.del("saved", ["c1", "program", "p1"]);
  assert.equal((await b.all("saved", "c1")).length, 0);
  assert.equal((await b.all("saved")).length, 1);
});

// 화면 코드 문구 점검(G-01, G-19, 10.2): 화면 소스에 시제품 단계 문구와 별 기호가 없다
const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = new URL(f, dir);
  return statSync(p).isDirectory() ? files(new URL(`${f}/`, dir)) : /\.(tsx?|css)$/.test(f) ? [p] : [];
});
test("화면 코드에 시제품 단계 문구, 가상 데이터, 별 기호가 없다(G-01, G-19)", () => {
  const src = [...files(new URL("../app/", import.meta.url)), ...files(new URL("../components/", import.meta.url)), ...files(new URL("./", import.meta.url))]
    .filter((p) => !p.pathname.endsWith(".test.mjs"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  for (const w of ["POC", "프로토타입", "가상 데이터", "(가상)", "시연 가정", "펀딩노트 —", "★", "☆", "✓"]) assert.ok(!src.includes(w), w);
  assert.equal((src.match(/시제품/g) ?? []).length, 1); // 지원사업 낱말 칩(finder.ts needChips.tech) 하나
});
