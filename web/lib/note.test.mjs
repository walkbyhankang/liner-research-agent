// 실행: npm test. 노트 핵심 값 표, 텍스트 복사, 파일 내보내기·불러오기(screens 8절).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { exportFile, exportName, linerTotal, noteRows, noteText, parseImport } from "./note.ts";

const fx = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/analysis/${name}.json`, import.meta.url), "utf8"));
const job = (name) => fx(name).exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[0].response;
const local = { loaded: true, edits: { industry: { value: "고친 업종", updatedAt: "x" } }, saved: [], checks: {}, rivalChecks: {}, briefs: {}, rivalChoices: { choices: {}, added: [] }, prep: { questions: {}, dd: {} }, notes: { memo: "메모", updatedAt: "x" }, salesKeywords: null };

test("회사 핵심 값은 9줄, 줄마다 상태 낱말과 출처(N-02), 고친 값은 직접 입력", () => {
  const rows = noteRows(job("F-FULL"), local.edits, "2026-11-22");
  assert.deepEqual(rows.map((r) => r.label), ["지역", "업력(설립일)", "기업 유형", "업종", "매출(사업연도·기준)", "국민연금 가입자(월)", "직원 수", "누적 투자", "국내 특허"]);
  assert.equal(rows[1].values[0].text, "업력 6년 (설립 2020-09-15)");
  assert.equal(rows[3].values[0].word, "edited");
  assert.equal(rows[4].values[0].text, "56.7억원 (2024 사업연도, 별도)");
  assert.match(rows[7].values[0].text, /투자기관 35곳/);
  assert.equal(rows[2].values[0].word, "unavailable");
});

test("엇갈림은 두 값을 모두 남긴다(N-03, D-06)", () => {
  const rows = noteRows(job("F-CONFLICT"), {}, "2026-11-22");
  const f = rows.find((r) => r.label === "업력(설립일)");
  assert.deepEqual(f.values.map((v) => v.text), ["2020-09-15", "다른 자료: 2021-01"]);
});

test("텍스트 복사: 첫 줄에 회사 이름과 분석 시각, 출처는 '{자료} ({종류}) · {기준일}'(N-06, C-09)", () => {
  const j = job("F-FULL");
  const t = noteText({ name: j.company.name, analyzedAt: j.analyzedAt, stale: false, today: "2026-11-22", rows: noteRows(j, {}, "2026-11-22"), programs: [], gps: [], sales: [], todo: [{ title: "기관에 물을 질문", items: [] }], memo: "", liner: linerTotal(j) });
  assert.equal(t.split("\n")[0], "주식회사 가나다테크 성장노트 (2026-11-22 작성, 회사 분석 2026-11-22 20:46)");
  assert.match(t, /금융위원회 기업기본정보 \(공공 API\) · 2026-11-22 조회/);
  assert.match(t, /금융위원회 요약재무제표 \(공공 API\) · 2024 사업연도, 별도/);
  assert.match(t, /회사 분석에 쓴 Liner 호출 19회/);
  assert.doesNotMatch(t, /<[a-z]/i);
});

test("파일 내보내기: 이름과 내용(분석 사본 없음, N-08)", () => {
  assert.equal(exportName("주식회사 가나다테크", "2026-11-22"), "성장노트-주식회사 가나다테크-20261122.json");
  const f = exportFile("0000000000001", "주식회사 가나다테크", local, "2026-11-22T12:00:00Z");
  assert.equal(f.companyId, "0000000000001");
  assert.equal(f.version, 1);
  assert.ok(f.edits && f.saved && f.checks && f.notes);
  assert.ok(!("loaded" in f) && !("snapshots" in f) && !("jobs" in f));
});

test("다른 회사 파일은 불러오지 않는다(N-09)", () => {
  const f = exportFile("0000000000099", "다른회사", local, "x");
  const r = parseImport(JSON.stringify(f), "0000000000001");
  assert.deepEqual(r, { ok: false, message: "다른 회사(다른회사)의 파일입니다. 이 회사 노트로 불러올 수 없습니다." });
  assert.equal(parseImport("{", "0000000000001").ok, false);
  assert.equal(parseImport(JSON.stringify(exportFile("0000000000001", "가", local, "x")), "0000000000001").ok, true);
});
