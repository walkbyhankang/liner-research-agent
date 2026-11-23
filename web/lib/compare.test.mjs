// 실행: npm test. 경쟁사 분석 비교 표(screens 4B.2, RI-07)를 가짜 응답(F-RIVALS, F-CONFLICT, F-STAGED)으로 시험한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COMPARE_ITEMS, COMPARE_LIMITS, COMPARE_SOURCES, cellLinks, cellText, compareColumns, myColumn, rivalColumn } from "./compare.ts";

const fx = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/analysis/${name}.json`, import.meta.url), "utf8"));
const job = (name) => fx(name).exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[0].response;

test("항목은 7줄이고 우리 회사가 첫 열, 그다음 비교한 순서(rivalSet)다", () => {
  assert.deepEqual(COMPARE_ITEMS.map((i) => i.label), ["매출", "국민연금 가입자", "누적 투자", "검색으로 확인한 특허", "최근 라운드", "주요 투자자", "설립"]);
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
  assert.equal(mine.patents.basis, "출원인 확인, 등록 8건");
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
  assert.equal(r.patents.basis, `출원인 확인, 등록 ${job("F-RIVALS").sections.rivals_deep.result.rivals[0].patents.registered}건`);
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

/** 칸에서 링크만 뺀 모양(값·기준·상태·출처 비교용) */
const noLinks = (cols) =>
  cols.map((c) => ({ ...c, cells: Object.fromEntries(Object.entries(c.cells).map(([k, x]) => [k, x.kind === "value" ? { ...x, links: undefined } : x.kind === "conflict" ? { ...x, alts: x.alts.map((a) => ({ text: a.text, source: a.source })) } : x])) }));
/** 칸마다 원문 링크 수(0 이면 빈 칸) */
const linkCounts = (cols) => cols.map((c) => Object.fromEntries(COMPARE_ITEMS.map((it) => [it.key, cellLinks(c.cells[it.key]).length])));

test("원문 링크 칸(patents.items, summary.inputArticles)이 없거나 null 인 옛 응답도 비교 표 값이 같고, 경쟁사 특허 칸에만 링크가 없다(계약 8.9)", () => {
  const j = job("F-RIVALS");
  const absent = structuredClone(j); // 브라우저에 저장된 옛 응답: 키 자체가 없다
  const nulls = structuredClone(j); // 서버가 옛 스냅샷을 읽어 null 로 채운 응답
  for (const r of absent.sections.rivals_deep.result.rivals) {
    delete r.patents.items;
    delete r.summary.inputArticles;
  }
  for (const r of nulls.sections.rivals_deep.result.rivals) {
    r.patents.items = null;
    r.summary.inputArticles = null;
  }
  for (const old of [absent, nulls]) {
    assert.deepEqual(noLinks(compareColumns(old)), noLinks(compareColumns(j)));
    const cols = compareColumns(old);
    assert.equal(cellLinks(cols[1].cells.patents).length, 0);
    assert.equal(cols[1].cells.patents.links, undefined); // 링크가 없으면 키도 없다
    assert.equal(cellLinks(cols[1].cells.funding).length, 2); // 다른 칸 링크는 그대로
  }
});

test("칸의 원문 링크는 받은 주소가 있는 칸에만 있다(screens 4B.2, RI-25)", () => {
  const cols = compareColumns(job("F-RIVALS"));
  const z = { founded: 0, revenue: 0, nps: 0, funding: 0, latest: 0, patents: 0, investors: 0 };
  assert.deepEqual(linkCounts(cols), [
    { ...z, patents: 11, investors: 3 }, // 우리 회사: 특허 낱건 11, 보인 투자기관 3곳의 원문. 매출(공식)·설립·국민연금은 주소 없음
    { ...z, funding: 2, latest: 1, patents: 6, investors: 2 }, // 마바사: 라운드 기사 2(최근 라운드는 그중 1), 특허 낱건 6
    z, // 하하테크: 주소 없음
  ]);
  const pt = cellLinks(cols[1].cells.patents);
  assert.deepEqual(pt[0], { url: "https://example.com/patent/rival/m1", title: "추론 칩 메모리 배치 방법 1", note: "KR20258888801A, 2025-09-20 출원, 공개" });
  assert.equal(pt[1].note, "KR20248888802B1, 2024-08-21 출원, 등록");
  assert.deepEqual(cellLinks(cols[1].cells.latest), [{ url: "https://example.com/news/rival/round/m1", title: "마바사 시리즈 C 투자 유치 기사", note: "시리즈 C 2026-03-10" }]);
  assert.ok(cellLinks(cols[0].cells.investors).every((l) => l.url.startsWith("https://example.com/facts/investor/")));
  // 복사·화면 읽기용 한 줄 글에는 링크 글이 없다(RI-29)
  for (const c of cols) for (const x of Object.values(c.cells)) assert.doesNotMatch(cellText(x), /원문|https?:/);
});

test("http·https 가 아닌 주소는 링크가 되지 않고, 같은 주소는 한 칸에 한 번이다(RI-27)", () => {
  const j = job("F-RIVALS");
  const r = j.sections.rivals_deep.result.rivals[0];
  r.patents.items[0].url = "javascript:alert(1)";
  r.patents.items[1].url = "data:text/html,x";
  r.patents.items[2].url = "ftp://example.com/x";
  r.patents.items[3].url = null;
  r.funding.rounds[1].sources[1].url = r.funding.rounds[0].sources[1].url; // 두 라운드가 같은 기사
  const cols = compareColumns(j);
  assert.deepEqual(cellLinks(cols[1].cells.patents).map((l) => l.title), ["추론 칩 메모리 배치 방법 5", "추론 칩 메모리 배치 방법 6"]);
  assert.equal(cellLinks(cols[1].cells.funding).length, 1);
  assert.equal(cols[1].cells.patents.lines[0], "6건"); // 값은 그대로
});

test("최근 라운드 칸: 날짜 없이 보도 날짜만 있는 라운드도 summary.latest(date or reported_date)와 짝이 맞아 원문이 붙는다", () => {
  // 경쟁사 열: 시리즈 C(기사 주소 m1)의 날짜가 없고 보도 날짜만 있다. 서버 latest.date 는 그 보도 날짜다
  const j = job("F-RIVALS");
  const f = j.sections.rivals_deep.result.rivals[0].funding;
  Object.assign(f.rounds[0], { date: null, reportedDate: "2026-03-12" });
  f.summary.latest = { ...f.summary.latest, date: "2026-03-12" };
  const m1 = "https://example.com/news/rival/round/m1";
  const rc = rivalColumn(j.sections.rivals_deep.result.rivals[0]).cells;
  assert.deepEqual(cellLinks(rc.latest).map((l) => l.url), [m1]);
  assert.ok(cellLinks(rc.funding).some((l) => l.url === m1)); // 누적 투자 칸과 같은 주소
  assert.equal(rc.latest.basis, "2026-03-12");
  // 날짜가 빈 글("")이어도 보도 날짜로 맞춘다. 단계가 다르면 짝이 아니다(링크 없음)
  f.rounds[0].date = "";
  assert.deepEqual(cellLinks(rivalColumn(j.sections.rivals_deep.result.rivals[0]).cells.latest).map((l) => l.url), [m1]);
  f.summary.latest = { ...f.summary.latest, round: "Series B" };
  assert.equal(cellLinks(rivalColumn(j.sections.rivals_deep.result.rivals[0]).cells.latest).length, 0);

  // 우리 회사 열도 같은 함수(fundingCells)를 쓴다: 최근 라운드에 기사 주소가 있고 날짜 없이 보도 날짜만 있을 때
  const mineJob = job("F-RIVALS");
  const fh = mineJob.sections.funding_history.result;
  const url = "https://example.com/news/mine/round/1";
  Object.assign(fh.rounds[0], { date: null, reportedDate: "2026-03-11", sources: [...fh.rounds[0].sources, { type: "Web", label: "가나다테크 투자 기사", url }] });
  fh.summary.latest = { ...fh.summary.latest, date: "2026-03-11" };
  const mc = myColumn(mineJob).cells;
  assert.deepEqual(cellLinks(mc.latest).map((l) => l.url), [url]);
  assert.deepEqual(cellLinks(mc.funding).map((l) => l.url), [url]);
});

test("엇갈린 설립 칸은 주소가 있는 값에만 원문이 붙는다(RI-28)", () => {
  const c = myColumn(job("F-CONFLICT")).cells.founded;
  assert.equal(c.kind, "conflict");
  assert.deepEqual(c.alts.map((a) => a.link?.url ?? null), [null, "https://example.com/facts/founded"]);
  assert.equal(cellLinks(c).length, 1);
  // 직접 입력한 값에는 링크가 없다
  const e = myColumn(job("F-CONFLICT"), { founded: { value: "2020-09", updatedAt: "x" } }).cells.founded;
  assert.deepEqual([e.word, cellLinks(e).length], ["edited", 0]);
});

test("표 글에 순위·차이·합계·판정 낱말이 없다(RI-17)", () => {
  const all = compareColumns(job("F-RIVALS")).flatMap((c) => Object.values(c.cells).map(cellText)).join("\n");
  assert.doesNotMatch(all, /위\b|순위|우세|열세|점수|확률|합계 차이|±|최고|최저/);
});

test("특허 줄은 전체 보유 수로 읽히지 않게 '검색으로 확인한 특허'이고, 칸 한 줄 글에 무엇을 센 수인지 남는다(RI-30)", () => {
  const cols = compareColumns(job("F-RIVALS"));
  assert.equal(COMPARE_ITEMS.find((i) => i.key === "patents").label, "검색으로 확인한 특허");
  assert.equal(cellText(cols[0].cells.patents), "11건, 출원인 확인, 등록 8건");
  assert.match(cellText(cols[1].cells.patents), /^6건, 출원인 확인, 등록 \d+건$/);
  // 0건(찾지 못함)은 0건이 아니라 미확보
  assert.equal(cellText(cols[2].cells.patents), "미확보: 출원인이 확인된 특허를 찾지 못함");
  const r = structuredClone(job("F-RIVALS").sections.rivals_deep.result.rivals[0]);
  r.patents = { ...r.patents, total: 0, registered: 0, items: [] };
  assert.deepEqual(rivalColumn(r).cells.patents, { kind: "missing", reason: "출원인이 확인된 특허를 찾지 못함" });
  // 우리 회사 등록 수를 모르면(patents 결과 없음) 기준은 "출원인 확인"만
  const j = job("F-RIVALS");
  j.sections.patents.result = null;
  assert.equal(myColumn(j).cells.patents.basis, "출원인 확인");
});

test("표 아래 한계는 출처와 따로 다섯 항목이고, 출처 줄에는 한계 문구가 없다(RI-31)", () => {
  // 한계와 출처는 같은 항목 순서(표 줄 이름을 쓴다)
  const head = (s) => s.split(": ")[0];
  assert.deepEqual(COMPARE_LIMITS.map((l) => l.label), ["매출", "국민연금 가입자", "누적 투자·최근 라운드·주요 투자자", "검색으로 확인한 특허", "설립"]);
  assert.deepEqual(COMPARE_SOURCES.map(head), COMPARE_LIMITS.map((l) => l.label));
  const items = new Set(COMPARE_ITEMS.map((i) => i.label));
  for (const l of COMPARE_LIMITS) for (const part of l.label.split("·")) assert.ok(items.has(part), part);
  // 출처 줄은 출처만: 한계 문구(직원 수와 다름, 다를 수 있음, 아님, 빠짐)는 한계로 옮겼다
  for (const s of COMPARE_SOURCES) assert.doesNotMatch(s, /직원 수|다를 수|아닙니다|빠지|달라질/, s);
  const byLabel = Object.fromEntries(COMPARE_LIMITS.map((l) => [l.label, l.text]));
  assert.match(byLabel["국민연금 가입자"], /직원 수\(상시근로자 수\)와 다릅니다/);
  assert.match(byLabel["검색으로 확인한 특허"], /전체 특허 수가 아닙니다/);
  assert.match(byLabel["검색으로 확인한 특허"], /최대 30건/);
  assert.match(byLabel["매출"], /연결/);
  assert.match(byLabel["설립"], /법인 설립일/);
  // 우리 회사 설립·매출 칸이 금융위원회 값이 아닐 수 있는 경우(웹 조사 값만, 직접 입력)를 같은 꼬리로 적는다
  assert.match(byLabel["설립"], /금융위원회 설립일이 없으면 웹 조사 값/);
  for (const k of ["매출", "설립"]) assert.match(byLabel[k], /‘직접 입력’이면 이 브라우저에서 고친 값입니다\.$/, k);
  // 실제로 그런 칸이 나온다: 법인 설립일이 없으면 웹 조사 값 하나, 고친 값은 직접 입력(이 브라우저)
  const nc = myColumn(job("F-NOCORP")).cells.founded;
  assert.deepEqual([nc.kind, nc.lines?.[0], nc.source], ["value", "2020-09", "example.com"]); // F-NOCORP: 법인 없음 → 웹 문서 값
  const ed = myColumn(job("F-RIVALS"), { founded: { value: "2019-05", updatedAt: "x" } }).cells.founded;
  assert.deepEqual([ed.word, ed.source], ["edited", "이 브라우저"]);
  // 한계 문장에도 점수·확률·판정 낱말을 쓰지 않는다(G-03)
  for (const l of COMPARE_LIMITS) assert.doesNotMatch(l.text, /점수|확률|가능성|추천|등급|합격|탈락|우세|열세/);
});

test("투자 칸의 출처 글은 그 칸의 원문 링크와 같은 라운드 묶음에서 만든다: 다른 라운드에만 기사가 있으면 '기사'도 링크도 없다(RI-33)", () => {
  const PDL = { type: "Premium", label: "People Data Labs", url: null };
  const web = (url) => ({ type: "Web", label: "투자 기사", url });
  // 경쟁사 열: 최근 라운드(시리즈 C)와 보인 투자기관이 든 라운드는 Premium 만, 기사는 다른 라운드(시리즈 B)에만
  const j = job("F-RIVALS");
  const r = j.sections.rivals_deep.result.rivals[0];
  const [c, b, corp] = r.funding.rounds;
  c.sources = [PDL];
  b.sources = [PDL, web("https://example.com/news/other-round")];
  b.investors = ["다른 투자사"];
  corp.investors = ["다른 투자사"];
  const rc = rivalColumn(r).cells;
  assert.equal(rc.latest.source, "People Data Labs");
  assert.equal(cellLinks(rc.latest).length, 0);
  assert.equal(rc.investors.source, "People Data Labs");
  assert.equal(cellLinks(rc.investors).length, 0);
  // 누적 투자는 라운드 전체라 기사와 그 링크가 함께 있다
  assert.equal(rc.funding.source, "People Data Labs, 기사");
  assert.deepEqual(cellLinks(rc.funding).map((l) => l.url), ["https://example.com/news/other-round"]);

  // 그 라운드에 기사가 있으면 출처 글의 "기사"와 링크가 함께 생긴다
  c.sources = [PDL, web("https://example.com/news/this-round")];
  const rc2 = rivalColumn(r).cells;
  assert.equal(rc2.latest.source, "People Data Labs, 기사");
  assert.deepEqual(cellLinks(rc2.latest).map((l) => l.url), ["https://example.com/news/this-round"]);
  assert.equal(rc2.investors.source, "People Data Labs, 기사");
  assert.deepEqual(cellLinks(rc2.investors).map((l) => l.url), ["https://example.com/news/this-round"]);

  // 짝이 되는 라운드가 없으면 출처 글은 라운드 전체 기준(비지 않음), 링크는 없다
  r.funding.summary.latest = { ...r.funding.summary.latest, round: "Series Z" };
  r.funding.investors = ["어느 라운드에도 없는 이름"];
  const rc3 = rivalColumn(r).cells;
  assert.equal(rc3.latest.source, "People Data Labs, 기사");
  assert.equal(cellLinks(rc3.latest).length, 0);
  assert.equal(rc3.investors.source, "People Data Labs, 기사");
  assert.equal(cellLinks(rc3.investors).length, 0);

  // 우리 회사 열도 같은 함수(fundingCells): 다른 라운드에만 기사가 있으면 최근 라운드 칸에 "기사"·링크가 없다
  const mj = job("F-RIVALS");
  const fh = mj.sections.funding_history.result;
  fh.rounds[1].sources = [PDL, web("https://example.com/news/mine/other")];
  const mc = myColumn(mj).cells;
  assert.equal(mc.latest.source, "People Data Labs");
  assert.equal(cellLinks(mc.latest).length, 0);
  assert.equal(mc.funding.source, "People Data Labs, 기사");
  // 우리 회사 주요 투자자 칸은 합친 투자기관의 출처(보인 앞 3곳)에서 글과 링크를 함께 만든다(라운드가 아니라 투자기관 단위)
  const inv = mc.investors;
  const shownUrls = mj.merged.investors.filter((i) => i.status === "confirmed" || i.status === "reported").slice(0, 3).flatMap((i) => i.sources.map((s) => s.url)).filter(Boolean);
  assert.deepEqual(cellLinks(inv).map((l) => l.url), [...new Set(shownUrls)]);
});
