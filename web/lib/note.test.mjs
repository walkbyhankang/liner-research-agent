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
  assert.deepEqual(rows.map((r) => r.label), ["지역", "업력(설립일)", "기업 유형", "업종", "매출(사업연도·기준)", "국민연금 가입자(월)", "직원 수", "누적 투자", "검색으로 확인한 특허"]);
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

// 파일 불러오기 모양 검사와 지우기 전 검증(가져오기 파일이 잘못되면 지금 자료를 지우지 않는다)
const CID = "0000000000001";
const company = { name: "가", region: "서울", biz: "", founded: "2020-09", industry: "AI", employees: "", revenue: "", need: "", notes: "" };
const fullLocal = {
  ...local,
  saved: [{ kind: "program", itemId: "PBLN_1", title: "공고 1", savedAt: "2026-11-20T00:00:00Z", meta: { deadline: "2026-12-01", agency: "기관", funds: 2, open: true, extra: null } }],
  checks: { PBLN_1: { programId: "PBLN_1", ranAt: "x", company, error: null, result: { program: { id: "PBLN_1", title: "t", url: "u", docUrl: "d" }, extraction: { summary: "" }, match: { overall: "확인 후 판단", overallReason: "", rows: [{ field: "업력" }], questions: ["질문"], documents: ["서류"] } } } },
  rivalChecks: { "PBLN_1|rival:가": { programId: "PBLN_1", rivalKey: "rival:가", ranAt: "x", company, error: { code: "upstream_error", message: "실패" }, result: null } },
  briefs: { 가나벤처스: { gp: "가나벤처스", ranAt: "x", company, error: null, result: { gp: "가나벤처스", facts: [], fit: [], questions: ["q"], sources: [], searched: 0 } } },
  rivalChoices: { choices: { "rival:가": "yes" }, added: [{ key: "user:나", name: "나" }] },
  prep: { questions: { q1: { ready: true, memo: "m" } }, dd: { d1: false } },
  salesKeywords: ["AI 서버"],
};

test("불러오기: 모든 칸과 목록 항목의 모양을 검사해, 하나라도 어긋나면 파일 전체를 거절한다", () => {
  const good = exportFile(CID, "가", fullLocal, "2026-11-22T00:00:00Z");
  const ok = parseImport(JSON.stringify(good), CID);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data.saved, fullLocal.saved);
  const bad = (patch) => parseImport(JSON.stringify({ ...good, ...patch }), CID);
  const NOT = { ok: false, message: "성장노트에서 내보낸 파일이 아닙니다." };
  const cases = [
    { saved: [null] }, { saved: [{ ...fullLocal.saved[0], kind: "other" }] }, { saved: [{ ...fullLocal.saved[0], meta: { a: {} } }] }, { saved: {} },
    { edits: null }, { edits: [] }, { edits: { industry: "글" } }, { edits: { unknown: { value: "x", updatedAt: "x" } } },
    { checks: { PBLN_1: null } }, { checks: { PBLN_1: { ...fullLocal.checks.PBLN_1, result: { match: null } } } }, { checks: [] },
    { rivalChecks: { a: { ...fullLocal.checks.PBLN_1 } } }, // rivalKey 없음
    { briefs: { a: { ...fullLocal.briefs.가나벤처스, result: { gp: "가", facts: null } } } },
    { rivalChoices: { choices: { a: "maybe" }, added: [] } }, { rivalChoices: { choices: {}, added: [null] } },
    { prep: { questions: { q1: { ready: "yes", memo: "" } }, dd: {} } }, { prep: { questions: {} } },
    { notes: "메모" }, { notes: { memo: 1, updatedAt: "x" } }, { salesKeywords: [1] }, { exportedAt: 3 },
  ];
  for (const c of cases) assert.deepEqual(bad(c), NOT, JSON.stringify(c));
  // 없어도 되는 칸은 빈 값으로 채운다(이전 파일과 호환)
  const { checks: _c, rivalChecks: _r, briefs: _b, rivalChoices: _rc, prep: _p, notes: _n, salesKeywords: _s, ...minimal } = good;
  const m = parseImport(JSON.stringify(minimal), CID);
  assert.equal(m.ok, true);
  assert.deepEqual([m.data.checks, m.data.notes, m.data.salesKeywords], [{}, null, null]);
});

test("불러오기: 넣을 레코드를 다 만들기 전에는 지금 브라우저 자료(담은 항목·메모)를 지우지 않는다", async () => {
  const store = await import("./store.ts");
  store.setBackendForTest(store.memoryBackend());
  const { replaceLocal, getLocal } = await import("./local.ts");
  const keep = { kind: "gp", itemId: "가나벤처스", title: "가나벤처스", savedAt: "2026-11-01T00:00:00Z", meta: {} };
  await store.put("saved", [CID, "gp", "가나벤처스"], keep);
  await store.put("notes", CID, { memo: "지우면 안 되는 메모", updatedAt: "x" });
  const { loaded: _l, ...data } = fullLocal;
  await assert.rejects(replaceLocal(CID, { ...data, saved: [null] }));
  await assert.rejects(replaceLocal(CID, { ...data, checks: { a: null } }));
  assert.deepEqual((await store.all("saved", CID)).map((r) => r.value), [keep]);
  assert.equal((await store.get("notes", CID)).memo, "지우면 안 되는 메모");
  // 맞는 자료면 바꾼다(지금 자료는 지우고 파일 내용으로)
  await replaceLocal(CID, data);
  assert.deepEqual((await store.all("saved", CID)).map((r) => r.value), fullLocal.saved);
  assert.equal((await store.get("notes", CID)).memo, "메모");
  assert.deepEqual((await store.all("rivalChecks", CID))[0].key, [CID, "PBLN_1", "rival:가"]);
  assert.deepEqual(getLocal(CID).saved, fullLocal.saved);
  assert.equal(getLocal(CID).briefs.가나벤처스.gp, "가나벤처스");
});

test("심사 준비에서 공고 빼기: 자금 조달·판로 두 화면에서 담은 같은 공고를 함께 뺀다(담기 단추는 자기 종류만)", async () => {
  const store = await import("./store.ts");
  store.setBackendForTest(store.memoryBackend());
  const { ensureLocal, getLocal, toggleSaved, removeNotice, reviewCount } = await import("./local.ts");
  const cid = "0000000000002";
  await ensureLocal(cid);
  const item = (kind) => ({ kind, itemId: "PBLN_X", title: "수출 공고", meta: { end: "2026-12-01" } });
  toggleSaved(cid, item("program"));
  toggleSaved(cid, item("salesProgram"));
  toggleSaved(cid, { kind: "gp", itemId: "가나벤처스", title: "가나벤처스", meta: {} });
  assert.equal(reviewCount(getLocal(cid)), 2);
  toggleSaved(cid, item("salesProgram")); // 판로 화면의 담기 단추: 자기 종류만
  assert.deepEqual(getLocal(cid).saved.map((s) => s.kind).sort(), ["gp", "program"]);
  toggleSaved(cid, item("salesProgram"));
  await new Promise((r) => setTimeout(r, 0));
  // 저장소 지우기가 실패하면 화면에서도 빼지 않고 false(두 종류 모두 그대로)
  const mem = store.memoryBackend();
  for (const s of await store.all("saved", cid)) await mem.put("saved", s.key, s.value);
  store.setBackendForTest({ ...mem, delMany: async () => { throw new Error("abort"); } });
  assert.equal(await removeNotice(cid, "PBLN_X"), false);
  assert.deepEqual(getLocal(cid).saved.map((s) => s.kind).sort(), ["gp", "program", "salesProgram"]);
  store.setBackendForTest(mem);
  assert.equal(await removeNotice(cid, "PBLN_X"), true); // 심사 준비의 빼기: 두 종류 모두
  assert.deepEqual(getLocal(cid).saved.map((s) => s.kind), ["gp"]);
  assert.equal(reviewCount(getLocal(cid)), 1);
  assert.deepEqual((await store.all("saved", cid)).map((r) => r.value.kind), ["gp"]);
});

test("여러 열쇠 지우기(delMany)는 한 번에: 실패하면 아무것도 지우지 않는다", async () => {
  const store = await import("./store.ts");
  const mem = store.memoryBackend();
  store.setBackendForTest(mem);
  await store.put("saved", ["c1", "program", "P"], { k: 1 });
  await store.put("saved", ["c1", "salesProgram", "P"], { k: 2 });
  assert.equal(await store.delMany("saved", [["c1", "program", "P"], ["c1", "salesProgram", "P"]]), true);
  assert.deepEqual(await store.all("saved", "c1"), []);
  store.setBackendForTest({ ...mem, delMany: async () => { throw new Error("abort"); } });
  await store.put("saved", ["c1", "program", "Q"], { k: 3 });
  assert.equal(await store.delMany("saved", [["c1", "program", "Q"]]), false);
  assert.equal((await store.all("saved", "c1")).length, 1);
});

/** IndexedDB 처럼 쓰기를 부른 순서대로 하나씩 처리하는 시험용 저장소. delMany 는 gate 가 열릴 때까지 기다린다 */
function orderedBackend(mem, gate) {
  let q = Promise.resolve();
  const seq = (fn) => (q = q.then(fn, fn));
  return { ...mem, put: (s, k, v) => seq(() => mem.put(s, k, v)), del: (s, k) => seq(() => mem.del(s, k)), delMany: (s, ks) => seq(async () => { await gate; return mem.delMany(s, ks); }) };
}

test("빼는 동안 이 탭에서 같은 공고를 새로 담으면 그 새 항목은 남는다(화면과 저장소가 같다)", async () => {
  const store = await import("./store.ts");
  const mem = store.memoryBackend();
  let release;
  const gate = new Promise((r) => (release = r));
  store.setBackendForTest(orderedBackend(mem, gate));
  const { ensureLocal, getLocal, toggleSaved, removeNotice } = await import("./local.ts");
  const cid = "0000000000003";
  await ensureLocal(cid);
  const item = (kind) => ({ kind, itemId: "PBLN_Y", title: "수출 공고", meta: { end: "2026-12-01" } });
  toggleSaved(cid, item("program"));
  await new Promise((r) => setTimeout(r, 0));
  const pending = removeNotice(cid, "PBLN_Y"); // 지우기가 끝나기 전에
  toggleSaved(cid, item("salesProgram")); // 판로에서 같은 공고를 새로 담음
  await new Promise((r) => setTimeout(r, 0));
  release();
  assert.equal(await pending, true);
  assert.deepEqual(getLocal(cid).saved.map((s) => s.kind), ["salesProgram"]);
  assert.deepEqual((await store.all("saved", cid)).map((r) => r.value.kind), ["salesProgram"]);
});

test("다른 탭이 담아 이 탭 메모리에 없는 사본도 빼기에서 함께 지워진다(새로고침해도 되살아나지 않는다)", async () => {
  const store = await import("./store.ts");
  store.setBackendForTest(store.memoryBackend());
  const tabA = await import("./local.ts?tab=a"); // 탭 둘: 메모리는 따로, 저장소는 같이
  const tabB = await import("./local.ts?tab=b");
  const cid = "0000000000004";
  const item = (kind) => ({ kind, itemId: "PBLN_Z", title: "수출 공고", meta: { end: "2026-12-01" } });
  await tabA.ensureLocal(cid);
  tabA.toggleSaved(cid, item("program")); // 탭 A: 자금 조달에서 담음
  await new Promise((r) => setTimeout(r, 0));
  await tabB.ensureLocal(cid);
  tabB.toggleSaved(cid, item("salesProgram")); // 탭 B: 판로에서 담음(탭 A 메모리에는 없음)
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(tabA.getLocal(cid).saved.map((s) => s.kind), ["program"]);
  assert.equal(await tabA.removeNotice(cid, "PBLN_Z"), true); // 탭 A 심사 준비에서 빼기
  assert.deepEqual(tabA.getLocal(cid).saved, []);
  assert.deepEqual(await store.all("saved", cid), []); // 저장소에도 없다 → 새로고침해도 되살아나지 않는다
  const reload = await import("./local.ts?tab=reload");
  await reload.ensureLocal(cid);
  assert.deepEqual(reload.getLocal(cid).saved, []);
});
