// 실행: npm test. 노트 핵심 값 표, 텍스트 복사, 파일 내보내기·불러오기(screens 8절).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { capConditions, exportFile, exportName, linerTotal, noteNotice, noteRows, noteText, noticeGroups, numberGroups, parseImport } from "./note.ts";

const fx = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/analysis/${name}.json`, import.meta.url), "utf8"));
const job = (name) => fx(name).exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[0].response;
const local = { loaded: true, edits: { industry: { value: "고친 업종", updatedAt: "x" } }, saved: [], checks: {}, rivalChecks: {}, briefs: {}, rivalChoices: { choices: {}, added: [] }, prep: { questions: {}, dd: {} }, notes: { memo: "메모", updatedAt: "x" }, salesKeywords: null };

test("회사 정보는 9줄, 줄마다 상태 낱말과 출처(N-02), 고친 값은 직접 입력", () => {
  const rows = noteRows(job("F-FULL"), local.edits, "2026-11-22");
  assert.deepEqual(rows.map((r) => r.label), ["지역", "업력(설립일)", "기업 유형", "업종", "매출(사업연도·기준)", "국민연금 가입자(월)", "직원 수", "누적 투자", "검색으로 확인한 특허"]);
  assert.equal(rows[1].values[0].text, "업력 6년 (설립 2020-09-15)");
  assert.equal(rows[3].values[0].word, "edited");
  assert.equal(rows[4].values[0].text, "56.7억원 (2024 사업연도, 별도)");
  assert.match(rows[7].values[0].text, /투자기관 35곳/);
  assert.equal(rows[2].values[0].word, "unavailable");
  assert.ok(rows.every((r) => !r.conflict));
});

test("공식 자료 칸과 웹 조사 칸은 값 앞 이름으로 가른다(QA 주석22). 고친 값과 하나뿐인 값에는 붙이지 않는다", () => {
  const rows = noteRows(job("F-FULL"), {}, "2026-11-22");
  const ind = rows.find((r) => r.label === "업종");
  assert.deepEqual(ind.values.map((v) => [v.tag, v.text]), [["공식 자료", "전자집적회로 제조업"], ["웹 조사", "AI 반도체 설계"]]);
  const rev = rows.find((r) => r.label === "매출(사업연도·기준)");
  assert.deepEqual(rev.values.map((v) => [v.tag, v.word]), [["공식 자료", "confirmed"], ["웹 조사", "reported"]]);
  assert.equal(rows.find((r) => r.label === "지역").values[0].tag, null);
  assert.equal(noteRows(job("F-FULL"), local.edits, "2026-11-22")[3].values[0].tag, null);
});

test("엇갈림은 두 값을 모두 남기고 둘째 값에 '다른 자료'를 붙인다(N-03, D-06)", () => {
  const rows = noteRows(job("F-CONFLICT"), {}, "2026-11-22");
  const f = rows.find((r) => r.label === "업력(설립일)");
  assert.deepEqual(f.values.map((v) => v.text), ["2020-09-15", "2021-01"]);
  assert.deepEqual(f.values.map((v) => v.tag), [null, "다른 자료"]);
  assert.equal(f.conflict, true);
  assert.ok(f.values.every((v) => v.source));
});

const notice = fx("F-NOTICE").exchanges[0];
const rec = (result, company = notice.request.company) => ({ programId: result.program.id, result, error: null, ranAt: "2026-11-22T11:00:00.000Z", company });

test("담은 공고: 대조 결과에서 개수·이유·미충족과 확인 필요 조건(판정 순서)·근거 줄을 만든다(QA 주석23)", () => {
  const n = noteNotice({ itemId: "P1", title: "공고 1" }, rec(notice.response), "2026-12-05", notice.request.company);
  assert.equal(n.state, "대상 아님");
  assert.deepEqual(n.counts, { met: 4, unmet: 1, check: 2 });
  assert.deepEqual(n.conditions.map((g) => [g.verdict, g.items.length]), [["미충족", 1], ["확인 필요", 2]]);
  assert.equal(n.basis, "근거: 공고문(HWPX)에 근거 문장이 있는 조건만 판단했습니다. 2026-11-22 대조.");
  // 대조한 뒤 회사 값이 바뀌었으면 근거 줄에 남긴다(R-12와 같은 뜻)
  assert.match(noteNotice({ itemId: "P1", title: "공고 1" }, rec(notice.response), null, { ...notice.request.company, need: "다른 값" }).basis, /2026-11-22 대조\. 이전 회사 값으로 한 대조입니다\.$/);
  const none = noteNotice({ itemId: "P2", title: "공고 2" }, undefined, null, null);
  assert.deepEqual([none.state, none.counts, none.basis, none.conditions], ["대조 전", null, null, []]);
});

test("담은 공고 묶음: 신청 검토 가능 → 확인 후 판단 → 대조 전 → 대상 아님, 묶음 안은 마감 가까운 순(마감일 없음은 뒤)", () => {
  const it = (key, state, end) => ({ key, state, end });
  const g = noticeGroups([it("a", "대상 아님", "2026-12-01"), it("b", "대조 전", null), it("c", "대조 전", "2026-11-30"), it("d", "확인 후 판단", "2026-12-20"), it("e", "신청 검토 가능", null)]);
  assert.deepEqual(g.map((x) => [x.state, x.items.map((i) => i.key).join("")]), [["신청 검토 가능", "e"], ["확인 후 판단", "d"], ["대조 전", "cb"], ["대상 아님", "a"]]);
});

test("공고 하나의 조건은 판정 순서대로 앞 5개만(묶음별 전체 개수는 남긴다), 공고 순번은 묶음을 건너 이어진다", () => {
  const conds = [{ verdict: "미충족", items: ["a", "b"] }, { verdict: "확인 필요", items: ["c", "d", "e", "f"] }];
  const { shown, more } = capConditions(conds, 5);
  assert.deepEqual(shown.map((g) => [g.verdict, g.items.join(""), g.total]), [["미충족", "ab", 2], ["확인 필요", "cde", 4]]);
  assert.equal(more, 1);
  assert.deepEqual(capConditions(conds, 2).shown.map((g) => g.verdict), ["미충족"]);
  const n = numberGroups([{ state: "확인 후 판단", items: ["x", "y"] }, { state: "대조 전", items: ["z"] }]);
  assert.deepEqual(n.map((g) => g.items.map((i) => `${i.x}${i.i}`).join()), ["x0,y1", "z2"]);
});

test("텍스트 복사: 첫 줄에 회사 이름과 분석 시각, 출처는 '{자료} ({종류}) · {기준일}'(N-06, C-09)", () => {
  const j = job("F-FULL");
  const notices = [noteNotice({ itemId: "P1", title: "공고 1" }, rec(notice.response), "2026-12-05", null), noteNotice({ itemId: "P2", title: "공고 2" }, undefined, null, null)];
  const t = noteText({ name: j.company.name, analyzedAt: j.analyzedAt, stale: false, today: "2026-11-22", rows: noteRows(j, {}, "2026-11-22"), notices, gps: [], sales: [], todo: [{ title: "기관에 물을 질문", items: [] }], memo: "", liner: linerTotal(j) });
  assert.equal(t.split("\n")[0], "주식회사 가나다테크 성장노트 (2026-11-22 작성, 회사 분석 2026-11-22 20:46)");
  assert.match(t, /\[회사 정보\]/);
  assert.match(t, /금융위원회 기업기본정보 \(공공 API\) · 2026-11-22 조회/);
  assert.match(t, /금융위원회 요약재무제표 \(공공 API\) · 2024 사업연도, 별도/);
  assert.match(t, /- 업종 \(웹 조사\): AI 반도체 설계 \(원문 확인\)/);
  // 화면·인쇄와 같은 순서: 묶음 → 공고(제목·마감·판정 요약) → 조건 → 근거
  assert.match(t, /\[담은 자금 후보\]\n대조 전 1건\n- 공고 2 \(신청기간 미기재\) 자격 대조 전입니다\.[^\n]*\n대상 아님 1건\n- 공고 1 \(12\.5 마감\) 충족 4, 미충족 1, 확인 필요 2\. [^\n]+\n  미충족: 체납 기업 제외\n  확인 필요: [^\n]+\n  확인 필요: [^\n]+\n  근거: /);
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
  // 받아들인 파일의 대조 기록은 공고문 정보(extraction.doc)와 올바른 대조 시각(ranAt "x")이 없어도 노트 줄로 그려진다(멈추지 않는다)
  const drawn = noteNotice({ itemId: "PBLN_1", title: "공고 1" }, ok.data.checks.PBLN_1, null, null);
  assert.equal(drawn.state, "확인 후 판단");
  assert.equal(drawn.basis, "근거: 공고문에 근거 문장이 있는 조건만 판단했습니다.");
  const withDoc = { ...ok.data.checks.PBLN_1, result: { ...ok.data.checks.PBLN_1.result, extraction: { summary: "", doc: { kind: "pdf", pages: 3 } } } };
  assert.equal(noteNotice({ itemId: "PBLN_1", title: "공고 1" }, withDoc, null, null).basis, "근거: 공고문(PDF 3쪽)에 근거 문장이 있는 조건만 판단했습니다.");
  // 알 수 없는 공고 판정 값: 예전에 내보낸 파일(version 1)도 그대로 불러오고(백업을 잃지 않게), 노트에서는 "확인 후 판단" 묶음에 보인다
  const odd = { ...ok.data.checks.PBLN_1, result: { ...ok.data.checks.PBLN_1.result, match: { ...ok.data.checks.PBLN_1.result.match, overall: "모름" } } };
  const oddNotice = noteNotice({ itemId: "PBLN_1", title: "공고 1" }, odd, null, null);
  assert.equal(oddNotice.state, "확인 후 판단");
  assert.deepEqual(noticeGroups([oddNotice]).map((g) => [g.state, g.items.length]), [["확인 후 판단", 1]]);
  const oddFile = parseImport(JSON.stringify({ ...good, checks: { PBLN_1: odd } }), CID);
  assert.equal(oddFile.ok, true);
  assert.equal(noteNotice({ itemId: "PBLN_1", title: "공고 1" }, oddFile.data.checks.PBLN_1, null, null).state, "확인 후 판단");
  // 불러온 값이 이상한 모양이어도(쪽수·조건 문장·판정 이유가 글·숫자가 아님) 노트 줄은 멈추지 않고 그 값만 뺀다
  const weird = { ...ok.data.checks.PBLN_1, result: { ...ok.data.checks.PBLN_1.result, extraction: { summary: "", doc: { kind: "pdf", pages: JSON.parse('{"toString":1}') } }, match: { ...ok.data.checks.PBLN_1.result.match, overallReason: { a: 1 }, rows: [{ verdict: "미충족", requirement: { a: 1 } }, { verdict: "미충족", requirement: "업력 7년 이내" }] } } };
  const w = noteNotice({ itemId: "PBLN_1", title: "공고 1" }, weird, null, null);
  assert.equal(w.basis, "근거: 공고문(PDF)에 근거 문장이 있는 조건만 판단했습니다.");
  assert.equal(w.reason, "");
  assert.deepEqual(w.conditions, [{ verdict: "미충족", items: ["업력 7년 이내"] }]);
  // 대조 시각이 날짜 범위 끝이라 한국 날짜로 못 바꿔도(+9시간에서 넘침) 노트 줄은 그려지고 날짜만 빠진다
  const edge = { ...ok.data.checks.PBLN_1, ranAt: "+275760-09-13T00:00:00.000Z" };
  assert.equal(parseImport(JSON.stringify({ ...good, checks: { PBLN_1: edge } }), CID).ok, true);
  assert.equal(noteNotice({ itemId: "PBLN_1", title: "공고 1" }, edge, null, null).basis, "근거: 공고문에 근거 문장이 있는 조건만 판단했습니다.");
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

test("판정 묶음 공고는 담을 때 저장한 기관을 마감 옆에 보인다(판로에서 담은 지원사업도 기관을 잃지 않음)", () => {
  const n = noteNotice({ itemId: "S_1", title: "판로 지원", meta: { agency: "가나시 진흥원" } }, undefined, "2026-12-01", null);
  assert.equal(n.agency, "가나시 진흥원");
  assert.equal(noteNotice({ itemId: "S_2", title: "기관 없음" }, undefined, null, null).agency, null);
  const text = noteText({ name: "가", analyzedAt: null, stale: false, today: "2026-11-24", rows: [], notices: [n], gps: [], sales: [], todo: [], memo: "", liner: 0 });
  assert.ok(text.includes("- 판로 지원 (가나시 진흥원, 12.1 마감)"), text);
});

test("매출 줄: 공식 매출이 확인됐고 웹 조사 매출끼리 엇갈리면 '엇갈림'은 줄(항목 이름 옆)에 서고 공식 값은 제 상태를 지킨다", () => {
  const j = structuredClone(job("F-FULL"));
  const src = (org) => ({ label: org, org, name: org, kind: "웹", asOf: null, basis: null, url: null });
  j.merged.revenue.web = { status: "conflicting", display: null, raw: null, source: src("기사"), reason: null, values: [
    { display: "50억원", raw: 50, source: src("기사 A"), quote: null }, { display: "70억원", raw: 70, source: src("기사 B"), quote: null }] };
  const r = noteRows(j, {}, "2026-11-22").find((x) => x.label === "매출(사업연도·기준)");
  assert.equal(r.conflict, true);
  assert.equal(r.values[0].tag, "공식 자료");
  assert.notEqual(r.values[0].word, "conflicting");
  assert.deepEqual(r.values.slice(1).map((v) => [v.tag, v.text, v.word]), [["웹 조사", "50억원", "conflicting"], ["다른 자료", "70억원", "conflicting"]]);
});

test("노트 근거 줄은 읽은 범위의 한계(뺀 조건 수, 공고문 앞부분만 읽음)를 함께 쓴다(심사 준비 카드와 같은 문장)", () => {
  const base = { program: { id: "P", title: "t", url: "u", docUrl: "d" }, match: { overall: "확인 후 판단", overallReason: "", rows: [], questions: [], documents: [] } };
  const rec = (extraction) => ({ programId: "P", ranAt: "2026-11-22T11:00:00Z", company: {}, error: null, result: { ...base, extraction } });
  const n = noteNotice({ itemId: "P", title: "t" }, rec({ summary: "", dropped: 2, doc: { kind: "pdf", pages: 40, chars: 1, truncated: true } }), null, null);
  assert.equal(n.basis, "근거: 공고문(PDF 40쪽)에 근거 문장이 있는 조건만 판단했습니다. 근거를 확인하지 못한 2건은 뺐습니다. 공고문이 길어 앞부분만 읽었습니다. 2026-11-22 대조.");
  const plain = noteNotice({ itemId: "P", title: "t" }, rec({ summary: "", dropped: 0, doc: { kind: "pdf", pages: 3, chars: 1, truncated: false } }), null, null);
  assert.equal(plain.basis, "근거: 공고문(PDF 3쪽)에 근거 문장이 있는 조건만 판단했습니다. 2026-11-22 대조.");
});

test("판정 결과가 있는데 판정 글이 '대조 전'이면(불러온 파일) '대조 전' 묶음이 아니라 '확인 후 판단'으로 둔다", () => {
  const result = { program: { id: "P", title: "t", url: "u", docUrl: "d" }, extraction: { summary: "" }, match: { overall: "대조 전", overallReason: "", rows: [], questions: [], documents: [] } };
  const n = noteNotice({ itemId: "P", title: "t" }, { programId: "P", ranAt: "2026-11-22T11:00:00Z", company: {}, error: null, result }, null, null);
  assert.equal(n.state, "확인 후 판단");
  assert.ok(n.counts);
});
