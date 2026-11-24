// 개발·시험용 가짜 분석 서버. fixtures/analysis 의 가짜 응답(합성 데이터)만 돌려준다. 바깥 API 는 부르지 않는다.
// 배포·운영 코드가 아니다. 화면 서버를 FUNDING_API_ORIGIN=http://127.0.0.1:8200 으로 띄워 이 서버에 붙인다.
//
// 실행: node scripts/mock_api.mjs [포트, 기본 8200]
// 조종(시험 스크립트가 쓴다):
//   POST /__control {scenario, step, corp, formerNamesUnknown, example, health, delayMs, notice, noticeDelayMs, gpDelayMs, salesPartial, fail500, stagedRegionLater, overrides, newerSaved, deep}
//     formerNamesUnknown: true 면 법인 후보의 formerNames 를 모두 null 로(서버의 이름 이력 조회가 실패·상한에 걸린 경우, 계약 2.1)
//     deep: "two" 면 F-RIVALS 의 경쟁사 비교 자료(2곳), "four" 면 후보 4곳 모두(가상, 투자기관 포함), "five" 면 가상 경쟁사 5곳 자료를 지금 시나리오에 얹는다
//           (예시 회사에 저장된 비교 자료, 820 폭 표 밀기 시험. 예시 회사면 retryable=false — 서버가 유료 단락을 막는 것과 같다, 계약 2.4)
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
/** 뉴스만 새로 받기가 끝난 뒤에 주는 기사 목록(앞 30건이 빠진 새 판). ux-check NE-10 이 같은 값으로 견준다 */
const NEWS_REFRESH_DROP = 30;
const clone = (v) => JSON.parse(JSON.stringify(v));
const ex = (name, pred = () => true) => FIX[name].exchanges.find(pred);
const jobOf = (name, i = 0) => clone(FIX[name].exchanges.filter((e) => e.method === "GET" && /^\/api\/(analysis\/[0-9a-f]{32}|company\/[^/]+\/analysis)$/.test(e.path))[i].response);

const DEFAULT = { scenario: "F-FULL", step: 0, corp: null, formerNamesUnknown: false, example: false, health: "up", delayMs: 0, notice: "ok", noticeDelayMs: 300, gpDelayMs: 200, salesPartial: false, fail500: false, overrides: {}, newsReruns: 0, newsVersion: 0, deep: null };
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

/** 새로 분석 작업(refreshJob). 지금 시나리오의 결과를 바탕으로, refreshDone 전에는 facts 가 진행 중, 뒤에는 다 끝남(더 새 analyzedAt) */
const REFRESH_ID = "c".repeat(32);
function refreshJobView() {
  const j = jobOf(st.scenario);
  j.jobId = REFRESH_ID;
  if (st.refreshDone) {
    j.analyzedAt = "2026-11-22T21:30:00+09:00";
    j.busy = false;
    return j;
  }
  j.status = "running";
  j.analyzedAt = null;
  j.busy = true;
  j.sections.facts = { ...j.sections.facts, status: "running", stage: null, result: null, error: null, analyzedAt: null, seconds: 5, retryable: false };
  return j;
}

/**
 * 경쟁사 비교 자료 봉투. four: 후보 4곳(마바사·하하테크에 아자차랩스·카타파 사본, 투자기관 포함) — 실제 예시 회사처럼 고른 4곳을 모두 받은 모양.
 * five: 마바사·하하테크에 가상 경쟁사 3곳(이름·열쇠만 바꾼 사본)을 더한 5곳
 */
function deepEnv(kind) {
  const env = jobOf("F-RIVALS").sections.rivals_deep;
  if (kind === "four") {
    const [a, b] = env.result.rivals;
    const more = [["rival:아자차랩스", "아자차랩스", a], ["rival:카타파", "카타파", a]].map(([key, name, src]) => ({ ...clone(src), key, name, nameEn: null }));
    env.result.rivals = [a, more[0], more[1], b];
    env.result.rivalSet = env.result.rivals.map((r) => r.key);
    env.result.rivalInvestors = env.result.rivals.filter((r) => r.funding?.investors.length).map((r) => ({ rivalKey: r.key, rivalName: r.name, investors: r.funding.investors }));
    return env;
  }
  if (kind !== "five") return env;
  const [a, b] = env.result.rivals;
  const extra = [["rival:아자차랩스", "아자차랩스"], ["rival:카타파", "카타파"], ["user:가상다섯째", "가상다섯째"]].map(([key, name], i) => ({ ...clone(i % 2 ? b : a), key, name, nameEn: null }));
  env.result.rivals = [a, b, ...extra];
  env.result.rivalSet = env.result.rivals.map((r) => r.key);
  return env;
}

function scenarioJob() {
  let job;
  if (st.scenario === "F-STAGED") job = clone(FIX["F-STAGED"].exchanges[Math.min(st.step, 6)].response);
  else job = jobOf(st.scenario);
  // stagedConflict: 단계별 분석이 끝날 때 설립이 엇갈린 채로 끝난다(ux-check A-29: 끝나는 순간 "확인이 필요한 정보"가 아래를 밀지 않는지)
  if (st.scenario === "F-STAGED" && st.stagedConflict && job.status !== "running") job.merged.founded = jobOf("F-CONFLICT").merged.founded;
  if (st.deep) job.sections.rivals_deep = { ...deepEnv(st.deep), retryable: !job.isExample };
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
    if (st.newsReruns === 0) {
      // 다시 받기가 끝남: 결과의 판(analyzedAt)이 바뀌고, 기사 목록도 새 판으로 준다
      st.overrides.news = { ...st.overrides.news, rerun: null, retryable: true, analyzedAt: "2026-11-22T20:59:00+09:00" };
      st.newsVersion += 1;
      job.sections.news = clone(st.overrides.news);
    }
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
    if (fx === "off") return err(res, 503, "missing_config", "공공데이터 설정이 되어 있지 않습니다");
    const body = { ...clone(ex(fx).response), query: name };
    if (st.formerNamesUnknown) for (const c of body.candidates) c.formerNames = null;
    return send(res, 200, body);
  }
  if (p === "analysis" && req.method === "POST") {
    const cid = companyIdFor(body?.name ?? "", body?.crno);
    const job = scenarioJob();
    if (body?.refresh && job.isExample) return send(res, 409, ex("F-EXAMPLE", (e) => e.method === "POST").response);
    // refreshJob: 새로 분석이 다른 작업 id(REFRESH_ID)로 시작한다. 저장된 분석 위에 진행 중 작업이 얹히는 모양(ux-check A-30)
    if (body?.refresh && st.refreshJob) {
      st.refreshStarted = true;
      return send(res, 202, { jobId: REFRESH_ID, companyId: cid, started: true });
    }
    if (cid === job.companyId && !body?.refresh) return send(res, job.status === "running" ? 200 : 200, { jobId: job.jobId, companyId: cid, started: false });
    return send(res, 202, { jobId: job.jobId, companyId: cid, started: true });
  }
  let m = /^company\/([^/]+)\/(analysis|job)$/.exec(p);
  if (m) {
    const job = scenarioJob();
    if (m[1] !== job.companyId) return err(res, 404, "not_found", "저장된 분석이 없습니다");
    if (m[2] === "job") return job.status === "running" ? send(res, 200, { jobId: job.jobId, companyId: job.companyId, startedAt: job.startedAt, status: "running" }) : err(res, 404, "not_found", "진행 중인 작업이 없습니다");
    if (job.status === "running") return err(res, 404, "not_found", "저장된 분석이 없습니다");
    // newerSaved: 이 회사에 더 새 저장 분석(다른 jobId, 다 끝남)이 있는 것처럼 준다(ux-check A-24)
    if (st.newerSaved) {
      for (const env of Object.values(job.sections)) env.rerun = null;
      return send(res, 200, { ...job, jobId: "b".repeat(32), analyzedAt: "2026-11-22T20:58:00+09:00", busy: false });
    }
    return send(res, 200, job);
  }
  m = /^analysis\/([0-9a-f]{32})\/news$/.exec(p);
  if (m) {
    const own = FIX[st.scenario]?.exchanges?.find((e) => e.path.endsWith("/news"));
    if (st.scenario === "F-EMPTY" || st.scenario === "F-HTML") return send(res, 200, own.response);
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 20);
    const cats = q.getAll("category");
    const all = st.newsVersion ? ARTICLES.slice(NEWS_REFRESH_DROP) : ARTICLES;
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
      // 실제 서버는 실행·다시 실행마다 단락 analyzedAt 을 끝난 시각으로 바꾼다(growth/jobs.py _finish). 가짜 서버도 실행마다 1분씩 늦은 시각을 준다.
      // 같은 시각을 그대로 주면 화면이 "바뀐 것 없음"으로 보고 브라우저 사본을 갱신하지 않아, 다시 열 때 옛 검색어 결과로 다시 조회했다(P-01 다시 열기)
      st.salesRuns = (st.salesRuns ?? 0) + 1;
      const t = new Date(Date.parse(st.overrides.sales.analyzedAt ?? "2026-11-22T20:49:06+09:00") + st.salesRuns * 60000 + 9 * 3600000);
      st.overrides.sales.analyzedAt = t.toISOString().replace(/\.\d{3}Z$/, "+09:00");
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
  if (m && st.refreshJob && st.refreshStarted && m[1] === REFRESH_ID) return send(res, 200, refreshJobView());
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
