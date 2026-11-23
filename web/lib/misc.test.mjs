// 실행: npm test. 글 만들기(format), 이름 정규화(names), 자금 조달(funding), 심사 준비·판로(review), 브라우저 저장(store), 화면 문구 점검.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { ageLabel, byCurrencyTexts, daysSince, elapsedText, eok, fmtBzno, fmtTime, formerNamesText, isStale, moneyText, msToNextKstMidnight, safeUrl, shortCompany, stageKo, todayKST, wonDisplay, wrapSvgText, yearsSince } from "./format.ts";
import { normName, sameNameIds, userRivalKey } from "./names.ts";
import { initialConditions, relatedTo, rivalBackers, splitExisting } from "./funding.ts";
import { bidDeadline, checkNowCounts, gaps, noticeEnd, sortBids, sortRows, verdictCounts } from "./review.ts";
import { fundingCount, reviewCount, savedNotices } from "./local.ts";
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

test("누적 투자 막대의 기준 글은 그림 폭 안에서 줄을 나누고, 이름표는 법인 형태를 뗀다(실제 서버 검증에서 찾음)", () => {
  const basis = "라운드 금액 합계 (금액이 있는 라운드 1건만 더함)";
  const lines = wrapSvgText(basis, 214);
  assert.ok(lines.length >= 2, lines.join("|"));
  assert.equal(lines.join(" "), basis); // 글을 버리지 않는다
  assert.deepEqual(wrapSvgText("People Data Labs 누적액", 214), ["People Data Labs 누적액"]);
  assert.equal(shortCompany("주식회사 가나다테크"), "가나다테크");
  assert.equal(shortCompany("가나다테크 주식회사"), "가나다테크");
  assert.equal(shortCompany("(주)가나다"), "가나다");
  assert.equal(shortCompany("주식회사"), "주식회사");
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

test("회사 확정: 이름이 같은 후보만 사업자번호·전체 주소·이전 이름을 더 보인다(K-10)", () => {
  const cands = (name) => fx(name).exchanges[0].response.candidates;
  // "주식회사 가나다테크" 와 "가나다테크 주식회사" 는 같은 이름, 가나다테크놀로지 등은 다른 이름
  assert.deepEqual([...sameNameIds(cands("F-CORP-2"))], ["0000000000001", "0000000000002"]);
  assert.equal(sameNameIds(cands("F-CORP-7")).size, 0);
  assert.equal(sameNameIds(cands("F-CORP-1")).size, 0);
  assert.deepEqual([...sameNameIds([{ companyId: "a", name: "(주)라마바" }, { companyId: "b", name: "라마바 주식회사" }, { companyId: "c", name: "라마바랩" }])], ["a", "b"]);
  assert.equal(fmtBzno("1234567890"), "123-45-67890"); // 가상 번호(실제 회사 번호는 저장소에 넣지 않는다)
  assert.equal(fmtBzno("123-45-67890"), "123-45-67890");
  assert.equal(fmtBzno("12345"), "12345");
  assert.equal(fmtBzno(null), null);
  const [renamed, plain] = cands("F-CORP-2");
  assert.equal(formerNamesText(renamed.formerNames), "주식회사 라마바코리아 · 2024-12 변경");
  assert.equal(formerNamesText(renamed.formerNames, ", "), "주식회사 라마바코리아, 2024-12 변경");
  assert.equal(formerNamesText(plain.formerNames), null); // 이력 없음 []
  assert.equal(formerNamesText(null), null); // 모름
  assert.equal(formerNamesText([{ name: "다", changedOn: "2025-03-02" }, { name: "나", changedOn: null }]), "다 · 2025-03 변경, 나");
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

test("지금 확인할 것: 새로 분석이 진행 중이면 값 개수를 세지 않고, 두 화면에서 담은 같은 공고는 한 번만 센다", () => {
  const saved = job("F-CONFLICT"); // 설립이 엇갈린 저장된 분석(done)
  assert.equal(saved.status, "done");
  assert.equal(checkNowCounts(saved, null, [], {}, "2026-11-22").conflicts.length, 1);
  // 새로 분석 중: 보이는 job 은 저장된 분석(done) 위에 얹은 것이고, 진행 중 작업(live)은 running
  const live = { ...saved, jobId: "c".repeat(32), status: "running", analyzedAt: null };
  const during = checkNowCounts(saved, live, [], {}, "2026-11-22");
  assert.deepEqual([during.conflicts.length, during.missing.length], [0, 0]);
  // 같은 수출 공고를 자금 조달(program)과 판로(salesProgram)에서 모두 담음: 마감 임박 1건, 미충족 요건은 대조 1건 몫만
  const a = fx("F-NOTICE").exchanges[0].response;
  const item = (kind) => ({ kind, itemId: "P1", title: "수출 공고", meta: { end: "2026-11-30" }, savedAt: "2026-11-22T10:00:00+09:00" });
  const items = [item("program"), item("salesProgram"), { kind: "gp", itemId: "G1", title: "운용사", meta: {}, savedAt: "x" }];
  const checks = { P1: { programId: "P1", result: a } };
  const c2 = checkNowCounts(saved, live, items, checks, "2026-11-22");
  assert.deepEqual([c2.soon, c2.unmet], [[8], verdictCounts(a).unmet]);
  assert.deepEqual(savedNotices(items).map((s) => s.kind), ["program"]);
  assert.equal(reviewCount({ saved: items }), 2); // 공고 1 + 운용사 1
  // 자금 조달 단계 개수(screens 1.1): 같은 공고는 하나, 노트에 담은 입찰공고는 더한다
  const bid = { kind: "bid", itemId: "B1", title: "입찰", meta: {}, savedAt: "x" };
  assert.equal(fundingCount({ saved: items }), 2);
  assert.equal(fundingCount({ saved: [...items, bid] }), 3);
  assert.equal(reviewCount({ saved: [...items, bid] }), 2);
  // 마감이 연장된 뒤 판로에서 다시 담음: 나중에 담은 쪽(새 마감일)을 쓴다. 옛 마감(이미 지남)에 가려 마감 임박에서 빠지지 않는다
  const old = { ...item("program"), meta: { end: "2026-11-20" }, savedAt: "2026-11-01T10:00:00+09:00" };
  const fresh = { ...item("salesProgram"), meta: { end: "2026-11-29" }, savedAt: "2026-11-21T10:00:00+09:00" };
  for (const order of [[old, fresh], [fresh, old]]) {
    assert.deepEqual(savedNotices(order).map((s) => s.meta.end), ["2026-11-29"]);
    assert.deepEqual(checkNowCounts(saved, null, order, {}, "2026-11-22").soon, [7]);
  }
});

test("담은 공고 마감일은 지금 공고 자료 먼저, 없으면 담을 때 저장값: 지금 확인할 것·심사 준비·노트가 같은 기준(D-08, A-27)", () => {
  const saved = job("F-FULL"); // 엇갈림·미확보 0
  const prog = (id, end) => ({ id, period: { raw: "", start: null, end, status: end ? "접수 중" : "수시" } });
  const item = (id, end, kind = "program") => ({ kind, itemId: id, title: id, meta: end === undefined ? {} : { end }, savedAt: "2026-11-22T10:00:00+09:00" });
  // 저장한 마감은 15일 뒤, 지금 자료는 5일 뒤(마감이 당겨짐) → 지금 자료로 마감 임박
  const early = [item("P1", "2026-12-07")];
  const now1 = [prog("P1", "2026-11-27")];
  assert.equal(noticeEnd(early[0], now1), "2026-11-27");
  assert.deepEqual(checkNowCounts(saved, null, early, {}, "2026-11-22", now1).soon, [5]);
  // 자료를 아직 못 받았거나 받지 못했으면(null) 저장값으로 센다: 15일 뒤라 마감 임박이 아니다
  assert.equal(noticeEnd(early[0], null), "2026-12-07");
  assert.deepEqual(checkNowCounts(saved, null, early, {}, "2026-11-22", null).soon, []);
  assert.deepEqual(checkNowCounts(saved, null, early, {}, "2026-11-22").soon, []); // 인자를 빼면 null 과 같다
  // 반대로 저장값은 5일 뒤인데 지금 자료가 15일 뒤(마감 연장) → 지금 자료로 빠진다
  const late = [item("P2", "2026-11-27")];
  const now2 = [prog("P2", "2026-12-07")];
  assert.deepEqual(checkNowCounts(saved, null, late, {}, "2026-11-22", now2).soon, []);
  assert.deepEqual(checkNowCounts(saved, null, late, {}, "2026-11-22", null).soon, [5]);
  // 지금 자료에 그 공고가 없거나(목록에서 빠짐) 마감일이 비었으면(수시로 바뀜) 저장값
  assert.equal(noticeEnd(item("P3", "2026-11-30"), now1), "2026-11-30");
  assert.equal(noticeEnd(item("P1", "2026-11-30"), [prog("P1", null)]), "2026-11-30");
  // 둘 다 없으면 null(화면은 "신청기간 미기재"), 셈에서 빠진다
  assert.equal(noticeEnd(item("P4", undefined), [prog("P4", null)]), null);
  assert.deepEqual(checkNowCounts(saved, null, [item("P4", undefined)], {}, "2026-11-22", [prog("P4", null)]).soon, []);
  // 두 화면에서 담은 같은 공고(저장값이 서로 달라도)는 한 건이고, 지금 자료가 있으면 그 마감 하나로 센다
  const both = [item("P1", "2026-12-07"), { ...item("P1", "2026-12-20", "salesProgram"), savedAt: "2026-11-22T11:00:00+09:00" }];
  assert.deepEqual(checkNowCounts(saved, null, both, {}, "2026-11-22", now1).soon, [5]);
  assert.deepEqual(checkNowCounts(saved, null, both, {}, "2026-11-22", null).soon, []);
  // 담은 공고 수(같은 공고는 하나, 운용사 빼고): 목록을 받는 동안 틀을 둘지 화면이 정한다(저장값으로 임박이 아니어도 담은 공고가 있으면 둔다)
  assert.equal(checkNowCounts(saved, null, [...both, { kind: "gp", itemId: "G1", title: "운용사", meta: {}, savedAt: "x" }], {}, "2026-11-22", null).notices, 1);
  assert.equal(checkNowCounts(saved, null, [], {}, "2026-11-22", null).notices, 0);
  // 접수 전(접수 예정)이어도 14일 안이면 센다(기존 결정 그대로)
  const upcoming = [{ id: "P5", period: { raw: "", start: "2026-11-25", end: "2026-11-28", status: "접수 예정" } }];
  assert.deepEqual(checkNowCounts(saved, null, [item("P5", "2026-12-30")], {}, "2026-11-22", upcoming).soon, [6]);
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

test("날이 바뀌면(서울 자정) 오늘 날짜와 마감 임박 셈이 바뀐다: 자정 시각 계산, 창에 들어오고 나가는 공고", () => {
  // 2026-11-22 23:59:30 서울 = 14:59:30Z → 다음 자정까지 30초(+1초 여유)
  const t = Date.parse("2026-11-22T14:59:30Z");
  assert.equal(todayKST(new Date(t)), "2026-11-22");
  assert.equal(msToNextKstMidnight(t), 31_000);
  assert.equal(todayKST(new Date(t + msToNextKstMidnight(t))), "2026-11-23");
  const saved = job("F-FULL");
  const s = (end) => [{ kind: "program", itemId: end, title: end, meta: { end }, savedAt: "x" }];
  // 마감 당일은 "오늘 마감"(0), 다음 날은 빠진다
  assert.deepEqual(checkNowCounts(saved, null, s("2026-11-22"), {}, "2026-11-22").soon, [0]);
  assert.deepEqual(checkNowCounts(saved, null, s("2026-11-22"), {}, "2026-11-23").soon, []);
  // 15일 남은 공고는 다음 날 14일 창에 들어온다
  assert.deepEqual(checkNowCounts(saved, null, s("2026-12-07"), {}, "2026-11-22").soon, []);
  assert.deepEqual(checkNowCounts(saved, null, s("2026-12-07"), {}, "2026-11-23").soon, [14]);
});
