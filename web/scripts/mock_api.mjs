// 개발·시험용 가짜 분석 서버. fixtures/analysis 의 가짜 응답(합성 데이터)만 돌려준다. 바깥 API 는 부르지 않는다.
// 배포·운영 코드가 아니다. 화면 서버를 FUNDING_API_ORIGIN=http://127.0.0.1:8200 으로 띄워 이 서버에 붙인다.
//
// 실행: node scripts/mock_api.mjs [포트, 기본 8200]
// 조종(시험 스크립트가 쓴다):
//   POST /__control {scenario, step, corp, example, health, delayMs, notice, noticeDelayMs, gpDelayMs, salesPartial, fail500, stagedRegionLater}
//   GET  /__log      받은 /api 요청 목록
//   POST /__reset    상태와 기록을 처음으로
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 8200);
const DIR = new URL("../../fixtures/analysis/", import.meta.url);
const FIX = Object.fromEntries(
  readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(f, DIR), "utf8"))]),
);
const ARTICLES = FIX["F-FULL.articles"].articles;
const clone = (v) => JSON.parse(JSON.stringify(v));
const ex = (name, pred = () => true) => FIX[name].exchanges.find(pred);
const jobOf = (name, i = 0) => clone(FIX[name].exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[i].response);

const DEFAULT = { scenario: "F-FULL", step: 0, corp: null, example: false, health: "up", delayMs: 0, notice: "ok", noticeDelayMs: 300, gpDelayMs: 200, salesPartial: false, fail500: false, overrides: {}, newsReruns: 0 };
let st = clone(DEFAULT);
let log = [];

// 계약 1.4 norm_name, company_id_for
const LEGAL = /주식회사|유한회사|유한책임회사|\(주\)|\(유\)|inc\.|corp\.|co\., ltd\.|ltd\.|llc/gi;
const normName = (n) => n.normalize("NFKC").replace(LEGAL, "").replace(/[\s·.,&()\-_'"]/g, "").toLowerCase();
const companyIdFor = (name, crno) => {
  const d = String(crno ?? "").replace(/\D/g, "");
  if (d.length === 13) return d;
  return `n-${createHash("sha256").update(normName(name)).digest("hex").slice(0, 16)}`;
};

function scenarioJob() {
  let job;
  if (st.scenario === "F-STAGED") job = clone(FIX["F-STAGED"].exchanges[Math.min(st.step, 6)].response);
  else job = jobOf(st.scenario);
  for (const [k, env] of Object.entries(st.overrides)) job.sections[k] = clone(env);
  if (typeof st.refreshRemaining === "number") job.refresh.remainingToday = st.refreshRemaining;
  // 경과가 예상의 2배를 넘은 단락(A-20)
  if (st.slow) for (const env of Object.values(job.sections)) if ((env.status === "running" || env.status === "waiting") && env.expectedSeconds) env.seconds = env.expectedSeconds * 2 + 5;
  // 법인 없이 분석: facts 가 끝나기 전(본사 지역 없음)과 뒤를 나눠 보인다(F-13)
  if (st.scenario === "F-NOCORP" && st.nocorpPhase === 0) {
    job.status = "running";
    job.analyzedAt = null;
    job.merged.region = null;
    job.merged.headquarters = null;
    job.merged.pending = ["region.web"];
    job.sections.facts = { ...job.sections.facts, status: "running", result: null, analyzedAt: null };
  }
  if (st.newsReruns > 0 && job.sections.news.rerun) {
    st.newsReruns -= 1;
    if (st.newsReruns === 0) job.sections.news.rerun = null;
  }
  job.busy = job.status === "running" || Object.values(job.sections).some((s) => s.status === "waiting" || s.status === "running" || s.rerun?.status === "running");
  return job;
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const err = (res, status, code, detail, retryAt = null) => send(res, status, { detail, code, retryAt });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(req, res, url, body) {
  const p = url.pathname.replace(/^\/api\//, "");
  const q = url.searchParams;
  if (st.fail500 && p !== "health") return send(res, 500, { detail: "Traceback (most recent call last): File \"/Users/someone/api/analysis.py\", line 3, KeyError: 'LINER_API_KEY'" });
  if (p === "health") {
    if (st.health === "down") return send(res, ex("F-DOWN").status, ex("F-DOWN").response);
    return send(res, 200, ex("F-FULL", (e) => e.path === "/api/health").response);
  }
  if (p === "example") {
    if (!st.example) return err(res, 404, "not_found", "예시 회사가 없습니다");
    return send(res, 200, ex("F-EXAMPLE", (e) => e.path === "/api/example").response);
  }
  if (p === "corp/search") {
    const name = (q.get("name") ?? "").trim();
    if (name.length < 2) return err(res, 400, "bad_request", "이름을 2글자 이상 넣어 주세요");
    const fx = st.corp ?? (name === "없는회사" ? "F-CORP-0" : "F-CORP-1");
    if (fx === "down") return err(res, 502, "upstream_error", "금융위원회 자료에 연결하지 못했습니다");
    return send(res, 200, { ...ex(fx).response, query: name });
  }
  if (p === "analysis" && req.method === "POST") {
    const cid = companyIdFor(body?.name ?? "", body?.crno);
    const job = scenarioJob();
    if (body?.refresh && job.isExample) return send(res, 409, ex("F-EXAMPLE", (e) => e.method === "POST").response);
    if (cid === job.companyId && !body?.refresh) return send(res, job.status === "running" ? 200 : 200, { jobId: job.jobId, companyId: cid, started: false });
    return send(res, 202, { jobId: job.jobId, companyId: cid, started: true });
  }
  let m = /^company\/([^/]+)\/(analysis|job)$/.exec(p);
  if (m) {
    const job = scenarioJob();
    if (m[1] !== job.companyId) return err(res, 404, "not_found", "저장된 분석이 없습니다");
    if (m[2] === "job") return job.status === "running" ? send(res, 200, { jobId: job.jobId, companyId: job.companyId, startedAt: job.startedAt, status: "running" }) : err(res, 404, "not_found", "진행 중인 작업이 없습니다");
    if (job.status === "running") return err(res, 404, "not_found", "저장된 분석이 없습니다");
    return send(res, 200, job);
  }
  m = /^analysis\/([0-9a-f]{32})\/news$/.exec(p);
  if (m) {
    const own = FIX[st.scenario]?.exchanges?.find((e) => e.path.endsWith("/news"));
    if (st.scenario === "F-EMPTY" || st.scenario === "F-HTML") return send(res, 200, own.response);
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 20);
    const cats = q.getAll("category");
    const all = ARTICLES;
    const filtered = cats.length ? all.filter((a) => a.categories.some((c) => cats.includes(c))) : all;
    const job = scenarioJob();
    return send(res, 200, { jobId: m[1], offset, limit, categories: cats, total: filtered.length, articleTotal: all.length, categoryCounts: job.sections.news.result?.categoryCounts ?? [], items: filtered.slice(offset, offset + limit) });
  }
  m = /^analysis\/([0-9a-f]{32})\/sections\/([a-z_]+)$/.exec(p);
  if (m && req.method === "POST") {
    const key = m[2];
    const job = scenarioJob();
    if (job.isExample && key !== "sales") return err(res, 409, "example_readonly", "예시 회사는 새로 분석할 수 없습니다");
    if (key === "rivals_deep") st.overrides.rivals_deep = jobOf("F-RIVALS").sections.rivals_deep;
    else if (key === "sales" && st.salesLimit) {
      st.overrides.sales = { ...job.sections.sales, status: "unavailable", result: null, retryable: false, analyzedAt: job.analyzedAt, startedAt: job.analyzedAt, seconds: 0.5,
        error: { code: "daily_limit", message: "오늘 호출 상한에 닿아 이 단락을 확인하지 못했습니다. 내일 0시 이후에 다시 분석할 수 있습니다.", source: null, retryAt: "2026-11-23T00:00:00+09:00" } };
    } else if (key === "sales") {
      st.overrides.sales = jobOf(st.salesPartial ? "F-SALES-PARTIAL" : "F-SALES").sections.sales;
      if (Array.isArray(body?.keywords)) st.overrides.sales.result.keywords = body.keywords;
    }
    else if (key === "papers") st.overrides.papers = { ...job.sections.papers, status: "running", startedAt: job.analyzedAt, seconds: 2, retryable: false, waitingFor: [] };
    else if (key === "news") {
      st.overrides.news = { ...job.sections.news, rerun: { status: "running", startedAt: job.analyzedAt, seconds: 1, error: null }, retryable: false };
      st.newsReruns = 3;
    } else {
      const done = jobOf("F-FULL").sections[key];
      if (done) st.overrides[key] = done;
    }
    return send(res, 202, { jobId: m[1], key, started: true });
  }
  m = /^analysis\/([0-9a-f]{32})$/.exec(p);
  if (m) {
    const job = scenarioJob();
    if (m[1] !== job.jobId) return err(res, 404, "not_found", "분석 작업을 찾을 수 없습니다");
    if (st.scenario === "F-STAGED" && st.autoStep && st.step < 6) st.step += 1;
    return send(res, 200, job);
  }
  if (p === "notice/analyze") {
    await sleep(st.noticeDelayMs);
    if (st.notice === "limit") return send(res, 429, ex("F-NOTICE", (e) => e.status === 429).response);
    const r = clone(ex("F-NOTICE", (e) => e.status === 200).response);
    r.program.id = body?.programId ?? r.program.id;
    return send(res, 200, r);
  }
  if (p === "gp/brief") {
    await sleep(st.gpDelayMs);
    const r = clone(ex("F-BRIEF").response);
    r.gp = body?.gp ?? r.gp;
    return send(res, 200, r);
  }
  return err(res, 404, "not_found", "없는 경로입니다");
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (url.pathname === "/__control") {
      if (body?.scenario && body.scenario !== st.scenario) st.overrides = {};
      st = { ...st, ...body };
      if (body?.scenario === "F-EXAMPLE") st.example = true;
      return send(res, 200, st);
    }
    if (url.pathname === "/__reset") {
      st = clone(DEFAULT);
      log = [];
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__log") return send(res, 200, log);
    if (!url.pathname.startsWith("/api/")) return err(res, 404, "not_found", "없는 경로입니다");
    log.push({ method: req.method, path: url.pathname, query: url.search, body, xff: req.headers["x-forwarded-for"] ?? null });
    if (st.delayMs) await sleep(st.delayMs);
    try {
      await api(req, res, url, body);
    } catch (e) {
      send(res, 500, { detail: "가짜 서버 오류", code: "internal", retryAt: null });
      console.error(e);
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`가짜 분석 서버: http://127.0.0.1:${PORT}`));
