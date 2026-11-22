// 실행: npm test. 예상 질문 19개(6갈래)·실사 대비 자료 26개(7갈래) 고정 목록(R-20, R-23).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DD_GROUPS, DD_ITEMS, QUESTIONS, QUESTION_GROUPS, groupCounts } from "./prep.ts";

const job = JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-FULL.json", import.meta.url), "utf8")).exchanges[0].response;
const empty = JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-EMPTY.json", import.meta.url), "utf8")).exchanges[0].response;

test("예상 질문은 19개, 갈래별 2·4·3·3·3·4", () => {
  assert.equal(QUESTIONS.length, 19);
  assert.deepEqual(groupCounts(QUESTIONS, QUESTION_GROUPS).map((g) => g.items.length), [2, 4, 3, 3, 3, 4]);
  assert.equal(new Set(QUESTIONS.map((q) => q.id)).size, 19);
});

test("실사 대비 자료는 26개, 갈래별 5·5·5·3·3·3·2이고 등급·우선순위가 없다", () => {
  assert.equal(DD_ITEMS.length, 26);
  assert.deepEqual(groupCounts(DD_ITEMS, DD_GROUPS).map((g) => g.items.length), [5, 5, 5, 3, 3, 3, 2]);
  for (const d of DD_ITEMS) assert.deepEqual(Object.keys(d).sort(), ["group", "id", "related", "text"]);
});

test("관련 자료는 분석에 있는 값만 붙이고, 없으면 빈 목록이다", () => {
  const ctx = { job, confirmedRivals: 2, deepDone: false, papersDone: false };
  const rel = (id) => QUESTIONS.find((q) => q.id === id).related(ctx).map((r) => r.text);
  assert.deepEqual(rel("q1"), ["설립 2020-09-15", "투자 라운드 10건", "중요 사건 14개"]);
  assert.deepEqual(rel("q6"), []);
  assert.deepEqual(rel("q7"), ["확정한 경쟁사 2곳"]);
  const d12 = DD_ITEMS.find((d) => d.id === "d12").related(ctx)[0].text;
  assert.equal(d12, `투자 라운드 10건, 투자기관 ${job.merged.investors.length}곳 (보도)`);
  const ectx = { job: empty, confirmedRivals: 0, deepDone: false, papersDone: false };
  assert.deepEqual(DD_ITEMS.find((d) => d.id === "d14").related(ectx), []);
});

test("목록 글에 판정·점수 낱말이 없다", () => {
  const all = [...QUESTIONS, ...DD_ITEMS].map((x) => x.text).join("\n");
  assert.doesNotMatch(all, /점수|확률|등급|합격|탈락|추천|통과|위험도|판정|가능성/);
});

test("원본(anthropics/financial-services, Apache-2.0)과 변경 고지가 파일 머리에 있다", () => {
  const src = readFileSync(new URL("./prep.ts", import.meta.url), "utf8").slice(0, 800);
  assert.match(src, /anthropics\/financial-services/);
  assert.match(src, /Apache License 2\.0/);
  assert.match(src, /dd-meeting-prep/);
  assert.match(src, /dd-checklist/);
  assert.match(src, /변경함/);
});
