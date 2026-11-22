// 실행: npm test. 작업 응답 → 화면 단락·핵심 값·알림 규칙을 가짜 응답(fixtures/analysis)으로 시험한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SCREEN_SECTIONS, TOC_TEXT, announcements, errorSentence, isSlow, keyTiles, overlay, phaseOf, retryState, rivalsCost, stillChecking, summaryLine, unavailableScreens, visibleRivals } from "./view.ts";
import { DEFAULT_ESTIMATES } from "./contract.ts";

const fx = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/analysis/${name}.json`, import.meta.url), "utf8"));
const job = (name, i = 0) => fx(name).exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[i].response;
const staged = fx("F-STAGED").exchanges.map((e) => e.response);

test("단락 순서는 개요, 재무·고용, 투자, 최근 동향, 기술, 경쟁사이고 주된 서버 단락이 정해져 있다(C-14)", () => {
  assert.deepEqual(SCREEN_SECTIONS.map((s) => s.label), ["개요", "재무·고용", "투자", "최근 동향", "기술", "경쟁사"]);
  assert.deepEqual(SCREEN_SECTIONS.map((s) => s.primary), ["profile", "official", "funding_history", "news", "patents", "profile"]);
});

test("핵심 값은 네 칸이고 기준이 숫자에 붙는다(A-14, D-03)", () => {
  const t = keyTiles(job("F-FULL"));
  assert.deepEqual(t.map((x) => x.label), ["매출", "국민연금 가입자", "누적 투자", "국내 특허"]);
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
  assert.equal(empty[3].missing, "미확보: 출원인이 확인된 특허를 찾지 못함");
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
  assert.deepEqual(msgs, ["재무·고용 단락이 준비됐습니다.", "개요 단락이 준비됐습니다.", "경쟁사 단락이 준비됐습니다.", "투자 단락이 준비됐습니다.", "기술 단락이 준비됐습니다.", "최근 동향 단락이 준비됐습니다.", "회사 분석이 끝났습니다."]);
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
  assert.equal(summaryLine(j, "tech"), "출원인이 확인된 국내 특허 11건 (등록 8건)");
  assert.equal(summaryLine(j, "rivals", 2), "국내 경쟁사 후보 4곳, 확정 2곳");
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

test("깊이 비교 비용 줄은 고른 곳 수 기준이고, 5곳 기준 값은 서버 상한(고정 4 + 한 곳당 6)과 맞는다", () => {
  const est = DEFAULT_ESTIMATES.sections.rivals_deep;
  assert.deepEqual(rivalsCost(est, 5), { liner: 34, text: "Liner 약 34회 (고른 5곳 기준, 한 곳당 약 6회)" });
  assert.equal(rivalsCost(est, 2).liner, 16); // growth.limits.section_caps("rivals_deep", rivals=2) 의 Liner 합
  assert.equal(rivalsCost(est, 1).liner, 10);
  assert.equal(rivalsCost(est, 9).liner, 34); // 서버는 5곳까지만 받는다
  assert.equal(rivalsCost({ liner: 34, perRival: null }, 2).text, "Liner 약 34회 (경쟁사 5곳 기준)");
});
