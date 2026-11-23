// 실행: npm test. 작업 응답 → 화면 단락·핵심 값·알림 규칙을 가짜 응답(fixtures/analysis)으로 시험한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SCREEN_SECTIONS, TOC_TEXT, announcements, errorSentence, isSlow, keyTiles, overlay, phaseOf, retryState, rivalsCost, stillChecking, summaryLine, unavailableScreens, visibleRivals } from "./view.ts";
import { DEFAULT_ESTIMATES } from "./contract.ts";
import { noticeCompany } from "./company-values.ts";

const fx = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/analysis/${name}.json`, import.meta.url), "utf8"));
const job = (name, i = 0) => fx(name).exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[i].response;
const staged = fx("F-STAGED").exchanges.map((e) => e.response);

test("단락 순서는 개요, 재무·고용, 투자, 최근 동향, 기술이고 주된 서버 단락이 정해져 있다(C-14, 경쟁사는 경쟁사 분석 화면)", () => {
  assert.deepEqual(SCREEN_SECTIONS.map((s) => s.label), ["개요", "재무·고용", "투자", "최근 동향", "기술"]);
  assert.deepEqual(SCREEN_SECTIONS.map((s) => s.primary), ["profile", "official", "funding_history", "news", "patents"]);
});

test("핵심 값은 네 칸이고 기준이 숫자에 붙는다(A-14, D-03)", () => {
  const t = keyTiles(job("F-FULL"));
  // 특허 칸 이름은 전체 보유 수로 읽히지 않게 "검색으로 확인한 특허"(2026-11-23 사용자 지시, 비교 표 줄 이름과 같음)
  assert.deepEqual(t.map((x) => x.label), ["매출", "국민연금 가입자", "누적 투자", "검색으로 확인한 특허"]);
  assert.deepEqual(t[0].big, ["56.7억원"]);
  assert.equal(t[0].basis[0], "2024 사업연도, 별도");
  assert.equal(t[0].extra, "웹 조사: 약 100억원 (2025, 별도)");
  assert.equal(t[0].extraWord, "reported");
  assert.equal(t[1].basis[0], "2026-10, 12개월 전보다 +28명");
  assert.equal(t[1].word, "reference");
  assert.deepEqual(t[2].big, ["$250.0M"]);
  assert.equal(t[3].basis[0], "출원인 확인, 등록 8건");
});

test("누적 투자는 통화마다 따로 보이고 더하지 않는다(IN-06, D-02)", () => {
  const t = keyTiles(job("F-MONEY"))[2];
  assert.deepEqual(t.big, ["$250.0M", "300억원"]);
});

test("값이 없으면 미확보와 사유를 쓰고, 단락이 끝나기 전에는 확인 중이다(C-06, A-01)", () => {
  const empty = keyTiles(job("F-EMPTY"));
  assert.equal(empty[2].missing, "미확보: 투자 라운드 자료 없음");
  assert.equal(empty[3].missing, "미확보: 출원인이 확인된 특허를 검색에서 찾지 못함");
  assert.ok(keyTiles(staged[0]).every((t) => t.loading));
  const t1 = keyTiles(staged[1]);
  assert.deepEqual(t1.map((t) => t.loading), [false, false, true, true]);
});

test("단락 상태 글: 확인 중, 준비됨, 일부 미확보, 미확보", () => {
  assert.equal(TOC_TEXT[phaseOf(staged[0].sections.profile)], "확인 중");
  assert.equal(TOC_TEXT[phaseOf(job("F-FULL").sections.profile)], "준비됨");
  assert.equal(TOC_TEXT[phaseOf(job("F-LIMIT-NEWS").sections.news)], "미확보");
});

test("미확보 사유는 오류 코드로 문장을 고르고, 상한이면 다시 분석 단추를 비활성으로 둔다(A-17)", () => {
  const news = job("F-LIMIT-NEWS").sections.news;
  assert.match(errorSentence(news.error), /^오늘 호출 상한에 닿아/);
  assert.deepEqual(retryState(news), { kind: "disabled", note: "내일 다시 시도할 수 있습니다" });
  assert.equal(errorSentence(job("F-NOCORP").sections.official.error), "법인이 확인되지 않아 공식 재무·고용 자료가 없습니다.");
  assert.equal(errorSentence({ code: "upstream_error", message: "", source: "NAVER 뉴스", retryAt: null }), "NAVER 뉴스에서 응답을 받지 못했습니다.");
  assert.deepEqual(unavailableScreens(job("F-LIMIT-NEWS")).map((s) => s.key), ["news"]);
});

test("경과가 예상의 2배를 넘으면 오래 걸린다고 본다(A-20)", () => {
  assert.equal(isSlow({ expectedSeconds: 10, seconds: 21 }), true);
  assert.equal(isSlow({ expectedSeconds: 10, seconds: 19 }), false);
  assert.equal(isSlow({ expectedSeconds: null, seconds: 999 }), false);
});

test("단락 완료 알림은 단락마다 한 번, 끝나면 '회사 분석이 끝났습니다.'(C-21)", () => {
  const msgs = [];
  for (let i = 1; i < staged.length; i++) msgs.push(...announcements(staged[i - 1], staged[i]));
  assert.deepEqual(msgs, ["재무·고용 단락이 준비됐습니다.", "개요 단락이 준비됐습니다.", "투자 단락이 준비됐습니다.", "기술 단락이 준비됐습니다.", "최근 동향 단락이 준비됐습니다.", "회사 분석이 끝났습니다."]);
  assert.deepEqual(announcements(null, staged[6]), []);
});

test("진행 줄의 '아직 확인 중'은 끝나지 않은 단락과 facts 가 채울 부분이다", () => {
  const s = stillChecking(staged[5]);
  assert.ok(s.includes("개요(직원 수)") && s.includes("투자(원문 확인 투자자)"));
  assert.deepEqual(stillChecking(staged[6]), []);
  assert.ok(!stillChecking(staged[0]).includes("개요(직원 수)"));
});

test("한 줄 요약은 빈 값이 있으면 그 부분만 뺀다", () => {
  const j = job("F-FULL");
  assert.equal(summaryLine(j, "finance"), "매출 2024 사업연도 56.7억원(별도), 국민연금 가입자 2026-10 132명(12개월 +28명)");
  assert.equal(summaryLine(j, "news"), "최근 12개월 중요 사건 14개, 기사 693건");
  assert.equal(summaryLine(j, "tech"), "검색으로 확인한 특허 11건 (출원인 확인, 등록 8건)");
  assert.equal(summaryLine(job("F-EMPTY"), "investment"), null);
});

test("해외 기업은 경쟁사 후보에 나오지 않는다(RI-01)", () => {
  const names = visibleRivals(job("F-FULL")).map((r) => r.name);
  assert.ok(!names.includes("해외갑") && !names.includes("해외을"));
  assert.equal(names.length, 4);
});

test("새로 분석 중에는 이전 결과를 두고, 끝난 단락만 바꾼다(계약 9절)", () => {
  const base = job("F-FULL");
  const live = { ...staged[1], jobId: "f".repeat(32) };
  const o = overlay(base, live);
  assert.equal(o.job.sections.official, live.sections.official);
  assert.equal(o.job.sections.news, base.sections.news);
  assert.ok(o.refreshing.has("news") && !o.refreshing.has("official"));
  assert.equal(o.job.merged.employees, base.merged.employees);
  const lost = { ...live, sections: { ...live.sections, official: { ...live.sections.official, status: "unavailable", error: { code: "timeout", message: "", source: null, retryAt: null } } } };
  const o2 = overlay(base, lost);
  assert.equal(o2.job.sections.official, base.sections.official);
  assert.equal(o2.kept.get("official").reason, "정한 시간 안에 응답이 오지 않았습니다.");
});

test("새로 분석에서 단락이 미확보로 끝나면 합친 값도 이전 값을 두어 핵심 값 칸·공고문 대조 입력이 미확보로 바뀌지 않는다", () => {
  const base = job("F-FULL");
  const miss = (reason) => ({ display: null, raw: null, status: "unavailable", source: null, quote: null, note: null, reason, values: null, usedIndex: null });
  const err = { code: "timeout", message: "", source: null, retryAt: null };
  const done = staged[6];
  const live = {
    ...done, jobId: "e".repeat(32), status: "running", busy: true,
    sections: {
      ...done.sections,
      official: { ...done.sections.official, status: "unavailable", result: null, error: err },
      facts: { ...done.sections.facts, status: "unavailable", result: null, error: err },
      profile: { ...done.sections.profile, status: "unavailable", result: null, error: err },
    },
    merged: {
      ...done.merged,
      revenue: { official: miss("정한 시간 안에 응답이 오지 않음"), web: miss("매출 보도 없음") },
      industry: { official: done.merged.industry.official, web: miss("업종 자료 없음") },
      npsLatest: miss("정한 시간 안에 응답이 오지 않음"),
      employees: miss("직원 수 자료 없음"),
      founded: miss("설립 자료 없음"),
      bizType: miss("근거 자료 없음"),
      investors: [], rivals: [], techKeywords: [], programKeywords: [], bidKeywords: [], pending: [],
    },
  };
  const o = overlay(base, live);
  assert.ok(o.kept.has("official") && o.kept.has("facts") && o.kept.has("profile"));
  const m = o.job.merged;
  assert.equal(m.revenue.official, base.merged.revenue.official);
  assert.equal(m.revenue.web, base.merged.revenue.web);
  assert.equal(m.industry.web, base.merged.industry.web);
  assert.equal(m.industry.official, live.merged.industry.official); // 새 값이 있으면 새 값
  assert.equal(m.npsLatest, base.merged.npsLatest);
  assert.equal(m.employees, base.merged.employees);
  assert.equal(m.bizType, live.merged.bizType); // 둘 다 미확보면 새 값
  assert.equal(m.investors, base.merged.investors);
  assert.equal(m.rivals, base.merged.rivals);
  assert.equal(m.programKeywords, base.merged.programKeywords);
  // 핵심 값 칸과 공고문 대조 입력은 이전 값 그대로
  assert.deepEqual(keyTiles(o.job)[0].big, keyTiles(base)[0].big);
  assert.equal(keyTiles(o.job)[1].missing, null);
  assert.deepEqual(noticeCompany(o.job, {}), noticeCompany(base, {}));
  // 이전 값도 미확보였으면 새 미확보 값을 쓴다
  const baseMiss = { ...base, merged: { ...base.merged, npsLatest: miss("국민연금 사업장을 찾지 못함") } };
  assert.equal(overlay(baseMiss, live).job.merged.npsLatest, live.merged.npsLatest);
});

test("깊이 비교 비용 줄은 고른 곳 수 기준이고, 5곳 기준 값은 서버 상한(고정 4 + 한 곳당 6)과 맞는다", () => {
  const est = DEFAULT_ESTIMATES.sections.rivals_deep;
  assert.deepEqual(rivalsCost(est, 5), { liner: 34, text: "Liner 약 34회 (비교 대상 5곳 기준, 한 곳당 약 6회)" });
  assert.equal(rivalsCost(est, 2).liner, 16); // growth.limits.section_caps("rivals_deep", rivals=2) 의 Liner 합
  assert.equal(rivalsCost(est, 1).liner, 10);
  assert.equal(rivalsCost(est, 9).liner, 34); // 서버는 5곳까지만 받는다
  assert.equal(rivalsCost({ liner: 34, perRival: null }, 2).text, "Liner 약 34회 (경쟁사 5곳 기준)");
});

test("처음 고르기: 아무것도 고르지 않았고 비교 자료가 있으면 그 자료의 경쟁사를 고른 것으로 본다(screens 4B.1)", async () => {
  const { effectiveRivalChoices, pickedRivals } = await import("./view.ts");
  const j = job("F-RIVALS");
  const empty = { choices: {}, added: [] };
  const e = effectiveRivalChoices(j, empty);
  assert.equal(e.implicit, true);
  assert.deepEqual(e.choices, { "rival:마바사": "yes", "rival:하하테크": "yes" });
  assert.deepEqual(pickedRivals(j, empty).map((r) => r.key), ["rival:마바사", "rival:하하테크"]);
  // 하나라도 고르면 저장된 고르기만 쓴다
  const mine = { choices: { "rival:카타파": "no" }, added: [] };
  assert.equal(effectiveRivalChoices(j, mine).implicit, false);
  assert.deepEqual(pickedRivals(j, mine), []);
  // 비교 자료의 rivalSet 에 후보 밖 열쇠(직접 넣은 회사 "user:…")가 있으면 그 이름으로 직접 넣은 회사에 두고 "맞음"(가짜 서버 deep: "five" 와 같은 모양)
  const five = structuredClone(j);
  const extra = { ...structuredClone(five.sections.rivals_deep.result.rivals[0]), key: "user:가상다섯째", name: "가상다섯째", nameEn: null };
  five.sections.rivals_deep.result.rivals.push(extra);
  five.sections.rivals_deep.result.rivalSet.push("user:가상다섯째");
  const e5 = effectiveRivalChoices(five, empty);
  assert.deepEqual(e5.added, [{ key: "user:가상다섯째", name: "가상다섯째" }]);
  assert.equal(e5.choices["user:가상다섯째"], "yes");
  assert.deepEqual(pickedRivals(five, empty).map((r) => r.key), ["rival:마바사", "rival:하하테크", "user:가상다섯째"]);
  // 후보 목록에서 빠진 자동 후보("rival:…")는 직접 추가로 보이지 않게 처음 비교 대상에서 뺀다(비교 표에는 남는다)
  const gone = structuredClone(j);
  gone.sections.rivals_deep.result.rivals.push({ ...structuredClone(gone.sections.rivals_deep.result.rivals[0]), key: "rival:빠진후보", name: "빠진후보", nameEn: null });
  gone.sections.rivals_deep.result.rivalSet.push("rival:빠진후보");
  const eg = effectiveRivalChoices(gone, empty);
  assert.deepEqual(eg.added, []);
  assert.equal(eg.choices["rival:빠진후보"], undefined);
  assert.deepEqual(pickedRivals(gone, empty).map((r) => r.key), ["rival:마바사", "rival:하하테크"]);
  // 처음 비교 대상은 최대 5곳(서버 상한상 넘지 않지만 넘으면 앞 5곳)
  const six = structuredClone(five);
  for (const n of ["여섯째", "일곱째"]) {
    six.sections.rivals_deep.result.rivals.push({ ...structuredClone(extra), key: `user:${n}`, name: n });
    six.sections.rivals_deep.result.rivalSet.push(`user:${n}`);
  }
  six.sections.rivals_deep.result.rivalSet.unshift("rival:아자차랩스", "rival:카타파");
  assert.equal(pickedRivals(six, empty).length, 5);
  // 고른 것을 모두 다시 풀었으면(touched) 처음 고르기로 돌아가지 않는다
  assert.deepEqual(pickedRivals(j, { choices: {}, added: [], touched: true }), []);
  // 비교 자료가 없으면 처음 고르기도 없다
  assert.equal(effectiveRivalChoices(job("F-FULL"), empty).implicit, false);
  // 직접 넣은 회사는 후보 다음, 넣은 순서
  const added = { choices: { "rival:마바사": "yes", "user:가나": "yes" }, added: [{ key: "user:가나", name: "가나" }] };
  assert.deepEqual(pickedRivals(j, added).map((r) => r.name), ["마바사", "가나"]);
});
