// 실행: npm test. 가짜 응답(fixtures/analysis)이 화면 쪽 계약(contract.ts)의 필수 필드를 갖췄는지 확인한다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  COMPANY_ID_RE, CONTRACT_VERSION, DEFAULT_ESTIMATES, EXPECTED_SECONDS, NEWS_CATEGORIES, PENDING_KEYS, SECTION_KEYS, STATUSES, STATUS_LABEL,
  errorDetail, isAnalysisJob, sourceLine,
} from "./contract.ts";

const DIR = new URL("../../fixtures/analysis/", import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(f, DIR), "utf8"))]),
);
const exchanges = Object.entries(fixtures).flatMap(([name, f]) => (f.exchanges ?? []).map((x) => ({ name, ...x })));
const isJobPath = (x) => x.method === "GET" && x.status === 200 && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(x.path);
const jobs = exchanges.filter(isJobPath).map((x) => ({ name: x.name, job: x.response }));

const ENVELOPE_KEYS = ["key", "status", "stage", "startedAt", "seconds", "expectedSeconds", "analyzedAt", "result", "error", "retryable", "waitingFor", "rerun", "paid"];
const VALUE_KEYS = ["display", "raw", "status", "source", "quote", "note", "reason", "values", "usedIndex"];
const MERGED_KEYS = ["region", "district", "headquarters", "ceo", "founded", "bizType", "bizTypeHint", "industry", "employees", "revenue", "npsLatest",
  "patentCount", "investors", "rivals", "techKeywords", "programKeywords", "fundField", "bidKeywords", "pending"];
const hasKeys = (o, keys) => keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

test("가짜 응답의 작업 응답은 모두 계약 모양이다", () => {
  assert.ok(jobs.length >= 20);
  for (const { name, job } of jobs) {
    assert.ok(isAnalysisJob(job), name);
    assert.equal(job.contractVersion, CONTRACT_VERSION);
    assert.ok(COMPANY_ID_RE.test(job.companyId), name);
    assert.deepEqual(Object.keys(job.sections), [...SECTION_KEYS], name);
    for (const key of SECTION_KEYS) assert.ok(hasKeys(job.sections[key], ENVELOPE_KEYS), `${name} ${key}`);
    assert.ok(hasKeys(job.merged, MERGED_KEYS), name);
    assert.ok(job.merged.pending.every((p) => PENDING_KEYS.includes(p)), name);
  }
});

test("merged 의 값(Value)은 9개 칸이 모두 있고 상태 낱말로 바꿀 수 있다", () => {
  for (const { name, job } of jobs) {
    const m = job.merged;
    const vals = [m.region, m.headquarters, m.ceo, m.founded, m.bizType, m.industry.official, m.industry.web, m.employees, m.revenue.official,
      m.revenue.web, m.npsLatest, m.patentCount, m.fundField].filter(Boolean);
    for (const v of vals) {
      assert.ok(hasKeys(v, VALUE_KEYS), name);
      assert.ok(STATUS_LABEL[v.status], name);
      if (v.status === "unavailable") assert.ok(v.display === null && v.reason, name);
      if (v.status === "conflicting") assert.ok(Array.isArray(v.values) && v.values.length >= 1, name);
      if (v.source) assert.ok(sourceLine(v.source).startsWith(v.source.label), name);
    }
  }
});

test("F-FULL 은 화면 1층 개수를 시험할 만큼 들어 있다", () => {
  const job = fixtures["F-FULL"].exchanges[0].response;
  const { official, profile, funding_history: fh, news, patents } = job.sections;
  assert.equal(official.result.financials.length, 3);
  assert.equal(official.result.nps.monthly.length, 12);
  assert.equal(profile.result.products.length, 6);
  assert.equal(profile.result.coreTech.length, 6);
  assert.equal(profile.result.sources.length, 25);
  assert.equal(fh.result.rounds.length, 10);
  assert.equal(job.merged.investors.length, 35);
  assert.equal(news.result.events.length, 14);
  assert.equal(news.result.articles.length, 20);
  assert.equal(news.result.articleTotal, 693);
  assert.deepEqual(news.result.categoryCounts.map((c) => c.category).sort(), [...NEWS_CATEGORIES].sort());
  assert.equal(patents.result.patents.length, 11);
  assert.equal(job.merged.rivals.length, 4);
  // 해외 기업은 합친 경쟁사 목록에 없다
  assert.ok(!job.merged.rivals.some((r) => ["해외갑", "해외을"].includes(r.name)));
  // "이미 투자함" 판정에 쓰는 목록에는 확인·보도 기록만 있다
  assert.ok(job.merged.investors.every((i) => i.status === "confirmed" || i.status === "reported"));
  const paid = job.paid.liner;
  assert.equal(paid.search + paid.premium + paid.model + paid.scholar, DEFAULT_ESTIMATES.full.liner);
});

test("기사 나눠 받기 응답은 전체 목록을 잘라 준다", () => {
  const all = fixtures["F-FULL.articles"].articles;
  assert.equal(all.length, 693);
  const pages = fixtures["F-FULL"].exchanges.filter((x) => x.method === "GET" && x.path.endsWith("/news"));
  assert.equal(pages.length, 3);
  for (const { query, response: page } of pages) {
    const pool = all.filter((a) => page.categories.length === 0 || a.categories.some((c) => page.categories.includes(c)));
    assert.equal(page.total, pool.length);
    assert.deepEqual(page.items.map((a) => a.id), pool.slice(query.offset, query.offset + query.limit).map((a) => a.id));
    assert.ok(page.items.length <= page.limit);
  }
});

test("F-STAGED 는 t0~t6 순서로 단락이 하나씩 끝난다", () => {
  const steps = fixtures["F-STAGED"].exchanges;
  assert.deepEqual(steps.map((s) => s.label), ["t0", "t1", "t2", "t3", "t4", "t5", "t6"]);
  const order = ["official", "profile", "funding_history", "patents", "news", "facts"];
  steps.forEach((s, i) => order.forEach((k, j) => assert.equal(s.response.sections[k].status === "done", j < i, `t${i} ${k}`)));
  assert.equal(steps[5].response.merged.employees, null); // facts 전에는 "확인 중"
  assert.ok(steps[5].response.merged.pending.includes("investors.confirmed"));
  assert.equal(steps[6].response.busy, false);
});

test("오류 본문과 상태 낱말", () => {
  assert.equal(errorDetail({ detail: "오늘 호출 상한에 닿았습니다." }, "실패"), "오늘 호출 상한에 닿았습니다.");
  assert.equal(errorDetail({ detail: [{ loc: ["body", "name"], msg: "short" }] }, "요청 형식이 올바르지 않습니다."), "요청 형식이 올바르지 않습니다.");
  assert.equal(errorDetail(null, "실패"), "실패");
  assert.deepEqual(STATUSES.map((s) => STATUS_LABEL[s]), ["원문 확인", "보도", "추정", "엇갈림", "미확보", "참고"]);
  const limit = fixtures["F-LIMIT-NEWS"].exchanges[0].response.sections.news;
  assert.equal(limit.error.code, "daily_limit");
  assert.equal(limit.retryable, false);
  assert.equal(limit.expectedSeconds, EXPECTED_SECONDS.news);
});

test("글은 평문이다(HTML 로 해석하지 않을 값이 그대로 온다)", () => {
  const job = fixtures["F-HTML"].exchanges[0].response;
  assert.equal(job.sections.news.result.articles[0].title, "<b>굵게</b>");
  assert.equal(job.sections.patents.result.patents[0].abstract, "<img src=x onerror=alert(1)>");
});
