// 화면 완료 기준(docs/ux/acceptance.md) 자동 점검. 가짜 분석 서버(scripts/mock_api.mjs)와 빌드한 화면을 띄운 뒤 실행한다.
//   node scripts/mock_api.mjs 8200 &
//   FUNDING_API_ORIGIN=http://127.0.0.1:8200 npx next start -p 3200 &
//   node scripts/ux-check.mjs [화면 저장 폴더]
// 설치된 Chrome 과 puppeteer-core 를 쓴다(CHROME_PATH 로 바꿀 수 있다). 실제 유료 호출은 하지 않는다.
// 이미 투자함·경쟁사에 투자 시험은 가짜 운용사(fixtures/analysis/README.md)를 /data/funds.json 에 끼워 넣어 한다.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE ?? "http://127.0.0.1:3200";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:8200";
const OUT = process.argv[2] ?? null;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXED = Date.parse("2026-11-22T21:00:00+09:00");
const CID = "0000000000001";
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

// ---------------------------------------------------------------- 가짜 공고·운용사
const programs = JSON.parse(readFileSync(new URL("../public/data/programs.json", import.meta.url), "utf8"));
const funds = JSON.parse(readFileSync(new URL("../public/data/funds.json", import.meta.url), "utf8"));
const fakeProgram = (id, title, end) => ({
  id, title, category: "금융", sub: "융자", target: "창업벤처", agency: "가나다시청", operator: "", regions: ["서울"], agencyRegion: "서울",
  period: { raw: `2026-11-10 ~ ${end}`, start: "2026-11-10", end, status: "접수 중" }, intro: "가짜 공고 소개", points: ["창업·벤처기업", "운전자금 융자"], tags: ["운전자금"],
  url: `https://example.com/program/${id}`, applyUrl: "", applyMethod: "", contact: "", docUrl: "", created: "2026-11-10",
});
const PROGRAMS = JSON.stringify([fakeProgram("PBLN_000000000000001", "가나다시 반도체 기업 운전자금 가짜 공고", "2026-12-05"), fakeProgram("PBLN_000000000000002", "가나다시 창업기업 운전자금 가짜 공고", "2026-11-30"), ...programs]);
const fakeFund = (gp, name) => ({ name, gp, field: "AI", year: 2026, maturity: "2034-12-31", commitRaw: 1 });
const FUNDS = JSON.stringify([fakeFund("가나다벤처스", "가나다벤처스 AI 가짜 투자조합"), fakeFund("타파하인베스트", "타파하인베스트 AI 가짜 펀드"), fakeFund("나다라파트너스", "나다라파트너스 AI 가짜 펀드"), ...funds]);
const NEWS_ARTICLES = JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-FULL.articles.json", import.meta.url), "utf8")).articles;
const NEWS_REFRESH_DROP = 30; // scripts/mock_api.mjs 와 같은 값: 뉴스만 새로 받기 뒤 새 판은 앞 30건이 빠진 목록

// ---------------------------------------------------------------- 도구
// F-16: 목록 줄(공고·운용사 카드)의 오른쪽 끝 칸(기한·표시)이 카드마다 같은 오른쪽 위치에 있다(screens 1.12)
const dueAlign = (pg) =>
  pg.$$eval("[data-program], [data-gp]", (cards) =>
    cards
      .filter((c) => c.getBoundingClientRect().height > 0)
      .map((c) => {
        const e = c.querySelector(".lrow-end");
        if (!e) return "없음";
        return Math.round(c.getBoundingClientRect().right - e.getBoundingClientRect().right);
      }),
  );
const results = [];
const check = (id, ok, note = "") => {
  results.push({ id, ok: Boolean(ok), note });
  console.log(`${ok ? "통과" : "실패"} ${id}${note ? `  ${note}` : ""}`);
};
const ctl = (o) => fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(o) });
const reset = async (o = {}) => {
  await fetch(`${MOCK}/__reset`, { method: "POST" });
  if (Object.keys(o).length) await ctl(o);
};
const getLog = async () => (await fetch(`${MOCK}/__log`)).json();
const count = (log, method, re) => log.filter((x) => x.method === method && re.test(x.path)).length;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const heightFor = (w) => (w < 640 ? 844 : w === 820 ? 1180 : w === 1180 ? 820 : 800);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

// programs: /data/programs.json 대신 줄 공고 목록(JSON 글), dataDelay: 그 응답을 늦추는 ms(공고 목록을 받는 중 화면 점검, A-33)
async function open(path, { width = 1180, ctx = null, reduced = false, blockData = false, fonts = false, programs: programsBody = null, dataDelay = 0 } = {}) {
  const context = ctx ?? (await browser.createBrowserContext());
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("dialog", (d) => d.dismiss());
  await page.emulateTimezone("Asia/Seoul");
  await page.evaluateOnNewDocument((fixed) => {
    const N = Date.now.bind(Date);
    const off = fixed - N();
    const D = Date;
    class FakeDate extends D {
      constructor(...a) {
        super(...(a.length ? a : [N() + off]));
      }
      static now() {
        return N() + off;
      }
    }
    globalThis.Date = FakeDate;
    window.__copied = [];
    window.__alerts = 0;
    window.alert = () => (window.__alerts += 1);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => void window.__copied.push(t) }, configurable: true });
    window.__downloads = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (b) => {
      window.__lastBlob = b;
      return origCreate(b);
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__downloads.push(this.download);
      else origClick.call(this);
    };
    window.print = () => (window.__printed = (window.__printed ?? 0) + 1);
  }, FIXED);
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname === "/data/programs.json") {
      if (blockData) return req.respond({ status: 404, body: "" });
      const send = () => req.respond({ status: 200, contentType: "application/json", body: programsBody ?? PROGRAMS });
      return dataDelay ? void setTimeout(send, dataDelay) : send();
    }
    if (u.pathname === "/data/funds.json") return blockData ? req.respond({ status: 404, body: "" }) : req.respond({ status: 200, contentType: "application/json", body: FUNDS });
    if (!fonts && /fonts\.(googleapis|gstatic)\.com/.test(u.host)) return req.abort();
    return req.continue();
  });
  await page.setViewport({ width, height: heightFor(width) });
  if (reduced) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  return page;
}
const text = (page, sel = "body") => page.$eval(sel, (e) => e.innerText).catch(() => "");
const waitText = (page, t, timeout = 8000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, t).then(() => true).catch(() => false);
/** 보이는 누를 것 중 글이 맞는 첫 것을 누른다 */
async function click(page, t, { exact = false, within = "body", nth = 0 } = {}) {
  const ok = await page.evaluate(
    (t, exact, within, nth) => {
      const root = document.querySelector(within) ?? document.body;
      const els = [...root.querySelectorAll("button, a, [role=radio], [role=tab], [role=link]")].filter((e) => {
        const r = e.getBoundingClientRect();
        const s = e.textContent.replace(/\s+/g, " ").trim();
        return r.width > 0 && r.height > 0 && (exact ? s === t : s.startsWith(t));
      });
      const el = els[nth];
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    },
    t, exact, within, nth,
  );
  await wait(250);
  return ok;
}
const attr = (page, sel, a) => page.$eval(sel, (e, a) => e.getAttribute(a), a).catch(() => null);
const disclosure = (page, label) =>
  page.evaluate((label) => {
    const b = [...document.querySelectorAll("button.disclosure")].find((e) => e.textContent.trim().startsWith(label) && e.getBoundingClientRect().height > 0);
    return b ? b.getAttribute("aria-expanded") : null;
  }, label);
async function openDisclosure(page, label, within = "body") {
  await page.evaluate(
    (label, within) => {
      const b = [...(document.querySelector(within) ?? document).querySelectorAll("button.disclosure")].find((e) => e.textContent.trim().startsWith(label) && e.getBoundingClientRect().height > 0);
      if (b && b.getAttribute("aria-expanded") !== "true") b.click();
    },
    label, within,
  );
  await wait(300);
}
const idbCount = (page, store) =>
  page.evaluate(
    (store) =>
      new Promise((res) => {
        const r = indexedDB.open("growthnote", 1);
        r.onsuccess = () => {
          const q = r.result.transaction(store, "readonly").objectStore(store).count();
          q.onsuccess = () => res(q.result);
          q.onerror = () => res(-1);
        };
        r.onerror = () => res(-1);
      }),
    store,
  );
const idbGet = (page, store, key) =>
  page.evaluate(
    (store, key) =>
      new Promise((res) => {
        const r = indexedDB.open("growthnote", 1);
        r.onsuccess = () => {
          const q = r.result.transaction(store, "readonly").objectStore(store).get(key);
          q.onsuccess = () => res(q.result ?? null);
          q.onerror = () => res(null);
        };
        r.onerror = () => res(null);
      }),
    store, key,
  );

/** G-20: 화면 읽기 알림 영역(aria-live, role=status/alert/log, output)의 글을 n번 표본으로 모은다.
 *  아무것도 도착하지 않는 동안 글이 바뀌면(경과 초 등) 화면 읽기 프로그램이 그때마다 읽는다 */
async function liveSamples(page, n = 4, gap = 700) {
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    seen.add(
      await page.evaluate(() =>
        [...document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], output')]
          .map((e) => e.textContent.replace(/\s+/g, " ").trim())
          .join(" | "),
      ),
    );
    if (i < n - 1) await wait(gap);
  }
  return [...seen];
}

/** 모든 화면 공통 점검(G-01~G-08, G-12, G-17~G-19). 실패만 모은다 */
const globalFails = {};
async function globalChecks(page, label) {
  const g = await page.evaluate(() => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden";
    };
    const body = document.body.innerText;
    const thirdParty = [...document.querySelectorAll("[data-program] h3, [data-program] p, [data-program] li")].map((e) => e.innerText).join("\n");
    const ctrls = [...document.querySelectorAll("button, a[href], input:not([type=hidden]):not([type=file]), select, textarea, [role=button], summary")]
      .filter(vis)
      .filter((e) => !e.hasAttribute("data-inline"));
    const small = ctrls
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.height < 43.5 || r.width < 43.5;
      })
      .map((e) => `${e.tagName}:${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 16)}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
    // G-08: 가장 작은 글은 13px(visual-plan 5절, 2026-11-23 가독성 조정에서 12px → 13px)
    const tiny = [...document.querySelectorAll("body *")]
      .filter((e) => !(e instanceof SVGElement) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && vis(e) && parseFloat(getComputedStyle(e).fontSize) < 13)
      .map((e) => e.textContent.trim().slice(0, 16));
    const ext = [...document.querySelectorAll("a[href]")].filter((a) => /^https?:/i.test(a.getAttribute("href")) && new URL(a.href).origin !== location.origin);
    const badLinks = ext.filter((a) => a.target !== "_blank" || !(a.rel || "").includes("noreferrer")).map((a) => a.href);
    const nonHttp = [...document.querySelectorAll("a[href]")].filter((a) => /^(javascript|data|vbscript):/i.test(a.getAttribute("href").trim())).length;
    const arrows = [...document.querySelectorAll("button, a")].filter(vis).map((b) => b.textContent.trim()).filter((t) => /[→↗]$/.test(t));
    const prototypes = [...document.querySelectorAll("[aria-label='자주 찾는 낱말'] button")].filter((b) => b.textContent.includes("시제품")).length;
    // 다른 화면에서 돌아올 때 Next 가 이전 화면을 숨긴 채 남겨 두므로 보이는 것만 센다
    const h1 = [...document.querySelectorAll("h1")].filter(vis).length;
    return { body, thirdParty, small, tiny, badLinks, nonHttp, arrows, prototypes, h1, lang: document.documentElement.lang, hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, footer: document.querySelector("body > footer")?.innerText.trim() };
  });
  const fail = (id, why) => (globalFails[id] ??= []).push(`${label}: ${why}`);
  for (const w of ["POC", "프로토타입", "가상 데이터", "(가상)", "시연 가정"]) if (g.body.includes(w)) fail("G-01", w);
  const proto = (g.body.match(/시제품/g) ?? []).length;
  if (proto > g.prototypes) fail("G-02", `시제품 ${proto}회`);
  const own = g.body.replace(g.thirdParty, "").replace("점수나 선정 확률은 만들지 않습니다.", "");
  for (const w of ["점수", "확률", "가능성", "추천", "등급", "합격", "탈락"]) if (own.includes(w)) fail("G-03", w);
  if (g.footer !== "점수나 선정 확률은 만들지 않습니다. 값마다 확인 상태와 출처를 붙입니다.") fail("G-04", g.footer ?? "없음");
  if (g.hscroll > 1) fail("G-06", `${g.hscroll}px`);
  if (g.small.length) fail("G-07", g.small.slice(0, 4).join(", "));
  if (g.tiny.length) fail("G-08", g.tiny.slice(0, 3).join(", "));
  if (g.badLinks.length || g.nonHttp) fail("G-12", g.badLinks.slice(0, 2).join(", "));
  if (g.lang !== "ko" || g.h1 !== 1) fail("G-17", `lang=${g.lang} h1=${g.h1}`);
  if (g.arrows.length) fail("G-18", g.arrows[0]);
  if (/[★☆]/.test(g.body)) fail("G-19", "별");
  for (const w of ["해외갑", "해외을"]) if (g.body.includes(w)) fail("RI-01", w);
  return g;
}

const sh = async (page, name, full = false) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
};
const run = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await fn();
  } catch (e) {
    check(`${name} (실행 오류)`, false, e.message.split("\n")[0]);
  }
};

// ================================================================ 시작(S), 회사 확정(K)
await run("start", async () => {
  await reset({ scenario: "F-FULL" });
  let page = await open("/");
  await page.waitForSelector("#company-name");
  await wait(500);
  check("S-01", (await text(page, "h1")) === "우리 회사를 객관적으로 분석합니다");
  check("S-02", (await text(page, "label[for=company-name]")) === "회사 이름");
  check("S-07", !(await text(page)).includes("이어서 보기"));
  check("S-08 (404)", !(await text(page)).includes("예시 회사로 보기"));
  const noHome = !(await page.$("#company-home"));
  await click(page, "홈페이지 주소도 넣기 (선택)");
  check("S-05", noHome && Boolean(await page.$("#company-home")));
  const before = await disclosure(page, "어떤 자료로 분석하나요?");
  await openDisclosure(page, "어떤 자료로 분석하나요?");
  const items = await page.evaluate(() => [...document.querySelectorAll("[role=region][aria-label='어떤 자료로 분석하나요?'] li")].length);
  check("S-10", before === "false" && items === 8, `${items}줄`);
  await globalChecks(page, "시작 1180");
  await page.type("#company-name", "가");
  await click(page, "분석 시작");
  await wait(300);
  check("S-03", (await text(page)).includes("회사 이름을 2글자 이상 넣어 주세요.") && count(await getLog(), "GET", /corp\/search/) === 0);
  await ctl({ delayMs: 1200 });
  await page.$eval("#company-name", (e) => (e.value = ""));
  await page.type("#company-name", "가나다테크");
  await click(page, "분석 시작");
  await wait(300);
  const busyBtn = await page.$eval("form button[type=submit]", (b) => ({ t: b.textContent.trim(), d: b.disabled }));
  await page.waitForFunction(() => location.pathname.startsWith("/c/"), { timeout: 10000 }).catch(() => {});
  check("S-04", busyBtn.t === "법인 찾는 중" && busyBtn.d && count(await getLog(), "GET", /corp\/search/) === 1);
  check("K-02", new URL(page.url()).pathname === `/c/${CID}`, page.url());
  await ctl({ delayMs: 0, example: true });
  page = await open("/");
  check("S-08 (200)", await waitText(page, "예시 회사로 보기"));
  await ctl({ health: "down" });
  page = await open("/");
  await waitText(page, "지금은 분석 서버에 연결할 수 없습니다");
  const t = await text(page);
  check("S-09", (await page.$eval("form button[type=submit]", (b) => b.disabled)) && t.includes("지금은 분석 서버에 연결할 수 없습니다") && !t.includes("예시 회사로 보기") && t.includes("회사 없이 자금만 둘러보기"));
  await ctl({ health: "up", example: false });
  // 이어서 보기 5곳
  page = await open("/");
  await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open("growthnote", 1);
        r.onupgradeneeded = () => {
          for (const s of ["companies", "snapshots", "jobs", "edits", "saved", "checks", "rivalChecks", "briefs", "rivalChoices", "prep", "notes", "salesKeywords"]) r.result.createObjectStore(s);
        };
        r.onsuccess = () => {
          const tx = r.result.transaction("companies", "readwrite");
          for (let i = 1; i <= 5; i++) tx.objectStore("companies").put({ name: `가짜회사${i}`, lastOpenedAt: `2026-11-2${i}T10:00:00+09:00`, analyzedAt: "2026-11-20T10:00:00+09:00", isExample: false }, `000000000000${i + 1}`.slice(-13));
          tx.oncomplete = () => res(true);
        };
      }),
  );
  page = await open("/", { ctx: page.browserContext() });
  await waitText(page, "이어서 보기");
  const rows = await page.$$eval("[aria-labelledby=recent-h] > ul > li", (l) => l.length);
  check("S-06", rows === 3 && (await text(page)).includes("모두 보기 (5)"), `${rows}줄`);
  await openDisclosure(page, "모두 보기 (5)");
  const n0 = (await getLog()).length;
  await click(page, "지우기", { exact: true, within: "[role=region]" });
  const asked = (await text(page)).includes("이 회사의 고친 값, 담은 항목, 노트를 이 브라우저에서 지울까요? 서버에 있는 분석은 남습니다.");
  await page.evaluate(() => [...document.querySelectorAll("[role=alert] button")].find((b) => b.textContent.trim() === "지우기")?.click());
  await wait(500);
  check("S-11", asked && (await idbCount(page, "companies")) === 4 && (await getLog()).length === n0);
});

await run("confirm", async () => {
  await reset({ scenario: "F-FULL", corp: "F-CORP-7" });
  let page = await open(`/?name=${encodeURIComponent("가나다테크")}`);
  await page.waitForSelector("[role=radio]");
  let t = await text(page);
  const radios = await page.$$eval("[role=radio]", (l) => l.length);
  check("K-01", radios === 6 && t.includes("후보 2곳 더 보기") && t.includes("목록에 없음"), `${radios}개`);
  check("K-04", (await page.$eval("[role=radio][aria-checked=true]", (e) => e.innerText).catch(() => "")).startsWith("주식회사 가나다테크"));
  check("K-05", t.includes("대표") && t.includes("설립") && t.includes("본사") && t.includes("부산 해운대구") && !t.includes("예시로") && !t.includes("사업자번호") && !t.includes("이전 이름"));
  check("K-08 radiogroup", Boolean(await page.$("[role=radiogroup]")));
  await page.focus("[role=radio][aria-checked=true]");
  await page.keyboard.press("ArrowDown");
  await wait(200);
  check("K-08", (await page.$eval("[role=radio][aria-checked=true]", (e) => e.innerText).catch(() => "")).startsWith("가나다테크놀로지"));
  await globalChecks(page, "회사 확정 1180");
  await sh(page, "confirm-1180");
  await click(page, "가나다테크솔루션");
  t = await text(page);
  const btn = await page.$eval("button.btn-primary", (b) => b.textContent.trim());
  await click(page, "저장된 분석 보기");
  await page.waitForFunction(() => location.pathname.startsWith("/c/"), { timeout: 5000 }).catch(() => {});
  check("K-06", t.includes("저장된 분석 있음") && btn === "저장된 분석 보기" && page.url().includes("/c/0000000000003") && count(await getLog(), "POST", /\/api\/analysis$/) === 0);
  await ctl({ corp: "F-CORP-2" });
  page = await open(`/?name=${encodeURIComponent("가나다테크")}`);
  await page.waitForSelector("[role=radio]");
  check("K-03", !(await page.$("[role=radio][aria-checked=true]")) && (await page.$eval("button.btn-primary", (b) => b.disabled)));
  // K-10: 이름이 같은 2곳은 사업자번호·건물까지 나온 주소·이전 이름(있는 곳만)으로 가른다. 390px 에서 긴 주소는 줄을 바꾸고 넘치지 않는다
  for (const w of [1180, 390]) {
    const p = w === 1180 ? page : await open(`/?name=${encodeURIComponent("가나다테크")}`, { width: w });
    await p.waitForSelector("[role=radio]");
    const rows = await p.$$eval("[role=radiogroup] [role=radio]", (l) =>
      l.slice(0, 2).map((e) => {
        const a = e.querySelector("[data-twin=address]");
        return { text: e.innerText.replace(/\s+/g, " "), label: e.getAttribute("aria-label") ?? "", over: e.scrollWidth - e.clientWidth, lines: a ? Math.round(a.getBoundingClientRect().height / parseFloat(getComputedStyle(a).lineHeight)) : 0 };
      }),
    );
    const [r1, r2] = rows;
    const shown =
      r1.text.includes("사업자번호 000-00-00001") && r1.text.includes("본사 경기도 성남시 분당구 예시로 239 (예시동, 가나다타워) 102동 8층") && r1.text.includes("이전 이름 주식회사 라마바코리아 · 2024-12 변경") &&
      r2.text.includes("사업자번호 000-00-00002") && r2.text.includes("본사 경기도 성남시 분당구 예시로 3") && !r2.text.includes("이전 이름");
    const labels =
      r1.label.includes("사업자번호 000-00-00001") && r1.label.includes("본사 경기도 성남시 분당구 예시로 239 (예시동, 가나다타워) 102동 8층") && r1.label.includes("이전 이름 주식회사 라마바코리아, 2024-12 변경") &&
      r2.label.includes("사업자번호 000-00-00002") && !r2.label.includes("이전 이름");
    const g = await globalChecks(p, `회사 확정 이름 같음 ${w}`);
    const wrap = w === 390 ? r1.lines >= 2 : true;
    check(`K-10 (${w})`, shown && labels && g.hscroll <= 1 && r1.over <= 1 && r2.over <= 1 && wrap, `줄 ${r1.lines}, 넘침 ${g.hscroll}px`);
    await sh(p, `confirm-twins-${w}`);
  }
  // 서버가 이름 이력을 확인하지 못하면(formerNames null) 이전 이름 줄만 없고 사업자번호·전체 주소는 그대로 보인다
  await ctl({ formerNamesUnknown: true });
  page = await open(`/?name=${encodeURIComponent("가나다테크")}`);
  await page.waitForSelector("[role=radio]");
  t = await text(page, "[role=radiogroup]");
  check("K-10 (이력 모름)", t.includes("사업자번호 000-00-00001") && t.includes("102동 8층") && !t.includes("이전 이름"));
  await ctl({ formerNamesUnknown: false, corp: "F-CORP-0" });
  page = await open(`/?name=${encodeURIComponent("없는회사")}`);
  await waitText(page, "법인을 찾지 못했습니다");
  t = await text(page);
  check("K-07", (await text(page, "h1")) === "법인을 찾지 못했습니다" && t.includes("공개 자료만으로 분석") && t.includes("이름 다시 넣기"));
  await ctl({ corp: "F-CORP-2" });
  page = await open("/");
  await page.waitForSelector("#company-name");
  await page.type("#company-name", "가나다테크");
  await click(page, "분석 시작");
  await page.waitForFunction(() => location.search.includes("name="), { timeout: 5000 }).catch(() => {});
  await page.waitForSelector("[role=radio]");
  await page.goBack();
  await page.waitForSelector("#company-name");
  await wait(300);
  check("K-09", (await page.$eval("#company-name", (e) => e.value)) === "가나다테크");
});

// ================================================================ 회사 분석 진행(F-STAGED)
await run("staged", async () => {
  await reset({ scenario: "F-STAGED", step: 0 });
  const page = await open(`/c/${CID}`);
  await waitText(page, "분석 중");
  await wait(600);
  const secText = (k) => text(page, `#${k}`);
  // 회사 분석 단락은 5개(경쟁사는 2026-11-23부터 경쟁사 분석 화면)
  const all5 = async (word) => {
    let ok = 0;
    for (const k of ["overview", "finance", "investment", "news", "tech"]) if ((await secText(k)).includes(word)) ok += 1;
    return ok;
  };
  const busyTiles = await page.$$eval("ul[aria-label='핵심 값'] a[aria-busy=true]", (l) => l.length);
  check("A-01", (await all5("확인 중")) === 5 && busyTiles === 4 && (await text(page)).includes("분석 중") && !(await page.$("#rivals")));
  const fund = await page.$eval("nav[aria-label=단계] [aria-disabled=true]", (e) => e.innerText).catch(() => "");
  check("A-02", fund.includes("자금·판로") && fund.includes("준비 중"));
  const overlay = await page.evaluate(() => [...document.querySelectorAll("body *")].some((e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.position === "fixed" && r.width * r.height > innerWidth * innerHeight * 0.5 && s.display !== "none"; }));
  await openDisclosure(page, "상태 표시 안내");
  check("G-05", !overlay && (await disclosure(page, "상태 표시 안내")) === "true" && !(await page.$eval("button.btn", (b) => b.disabled).catch(() => true)));
  await sh(page, "staged-t0-1180");
  await ctl({ step: 1 });
  await wait(2600);
  const finSvg = await page.$$eval("#finance svg[role=img]", (l) => l.length);
  const others = (await all5("확인 중")) === 4;
  check("A-03", finSvg === 2 && Boolean(await page.$(`nav[aria-label=단계] a[href="/c/${CID}/funding"]`)) && others);
  const ov = await secText("overview");
  check("A-04", ov.includes("홍길동") && ov.includes("2020-09-15") && ov.includes("서울 강남구") && Boolean(await page.$("#overview .ph")) && !ov.includes("더 읽기"));
  check("TE-07", (await text(page, "#tech")).includes("회사 기술 분야를 받으면 실행할 수 있습니다.") && (await page.evaluate(() => [...document.querySelectorAll("#tech button")].find((b) => b.textContent.includes("논문 분석하기"))?.disabled)));
  // 기술 낱말을 받기 전에는 분야 수·학술 검색 수를 "0개", "0회"로 단정하지 않는다(실제 서버 검증에서 찾음)
  const te07 = await text(page, "#tech");
  check("TE-07 (수 단정 안 함)", !/기술 분야 0개|학술 검색 0회/.test(te07) && te07.includes("Liner 학술 검색 최대 6회"));
  await sh(page, "staged-t1-390");
  await ctl({ step: 2 });
  await wait(1800);
  await ctl({ step: 3 });
  await wait(2200);
  // 맨 아래 단락(기술) 머리를 화면 가운데 쪽에 둔다(옛 경쟁사 단락 자리)
  const top0 = await page.evaluate(() => {
    const h = document.getElementById("h-tech");
    window.scrollTo(0, h.getBoundingClientRect().top + scrollY - innerHeight / 2);
    return document.getElementById("h-tech").getBoundingClientRect().top;
  });
  await ctl({ step: 4 });
  await wait(2000);
  await ctl({ step: 5 });
  await wait(2200);
  const top1 = await page.$eval("#h-tech", (h) => h.getBoundingClientRect().top);
  check("A-07", Math.abs(top1 - top0) <= 8, `${Math.round(top0)}→${Math.round(top1)}`);
  check("A-05 (t5)", (await secText("overview")).includes("직원 수") && /직원 수\s*확인 중/.test(await secText("overview")));
  check("A-06 (t5)", (await secText("investment")).includes("원문에서 투자자를 더 확인하고 있습니다"));
  await openDisclosure(page, "투자기관", "#investment");
  const openedLabel = await page.evaluate(() => [...document.querySelectorAll("#investment button.disclosure")].find((b) => b.textContent.includes("투자기관"))?.getAttribute("aria-expanded"));
  await ctl({ step: 6 });
  await wait(2600);
  const ov6 = await secText("overview");
  check("A-05", /약 120명/.test(ov6) && /직원 수[\s\S]*보도/.test(ov6));
  check("A-06", !(await secText("investment")).includes("원문에서 투자자를 더 확인하고 있습니다"));
  check("A-08", openedLabel === "true" && (await page.evaluate(() => [...document.querySelectorAll("#investment button.disclosure")].find((b) => b.textContent.includes("투자기관"))?.getAttribute("aria-expanded"))) === "true");
  check("A-09", !(await text(page)).includes("분석 중") && (await text(page, "section[aria-label=회사]")).includes("2026-11-22 20:46 분석"));
  const live = await page.$$eval("[data-live] p", (l) => l.map((p) => p.textContent));
  const want = ["재무·고용 단락이 준비됐습니다.", "개요 단락이 준비됐습니다.", "투자 단락이 준비됐습니다.", "기술 단락이 준비됐습니다.", "최근 동향 단락이 준비됐습니다.", "회사 분석이 끝났습니다."];
  check("C-21", want.every((w) => live.filter((x) => x === w).length === 1) && live.length === want.length, live.join(" / "));
  // A-29: 분석이 엇갈린 값을 가진 채 끝나도, 끝나는 순간 "지금 확인할 것"이 생기며 아래(자금·판로 줄·개요 제목)를 밀지 않는다(첫 화면, 1180·390)
  for (const w of [1180, 390]) {
    await reset({ scenario: "F-STAGED", step: 5, stagedConflict: true });
    const pa = await open(`/c/${CID}`, { width: w });
    await waitText(pa, "분석 중");
    await wait(800);
    const pos = () => pa.evaluate(() => ({ fund: Math.round([...document.querySelectorAll("a,span")].find((e) => e.textContent.trim() === "자금·판로 보기" || e.textContent.trim().startsWith("자금·판로 준비"))?.getBoundingClientRect().top ?? -1), ov: Math.round(document.getElementById("h-overview")?.getBoundingClientRect().top ?? -1), y: scrollY, ck: document.querySelector("[data-checknow]")?.getBoundingClientRect().height.toFixed(1), band: document.querySelector("ul[aria-label='핵심 값']")?.getBoundingClientRect().bottom.toFixed(1) }));
    const before = await pos();
    const frame0 = await text(pa, "[data-checknow]");
    // A-32: 항목 줄이 옆으로 넘쳐도 스크롤 막대가 높이를 차지하지 않는다(일반 스크롤 막대 환경에서 넘침이 생기고 사라질 때 아래가 밀리지 않게)
    if (w === 390) {
      const sb = await pa.evaluate(() => {
        const sec = document.querySelector("[data-checknow]");
        const ul = sec.querySelector("ul");
        const h0 = sec.getBoundingClientRect().height;
        const li = document.createElement("li");
        li.style.flex = "0 0 900px";
        li.textContent = "넘침 시험";
        ul.appendChild(li);
        const over = ul.scrollWidth > ul.clientWidth;
        const bar = ul.offsetHeight - ul.clientHeight;
        const h1 = sec.getBoundingClientRect().height;
        li.remove();
        // 시험 브라우저는 스크롤 막대를 숨긴 채 떠서(--hide-scrollbars) 막대 높이만으로는 못 가린다. 줄 자체가 막대를 끄는지도 본다
        return { over, bar, h0: +h0.toFixed(1), h1: +h1.toFixed(1), sbw: getComputedStyle(ul).scrollbarWidth };
      });
      check("A-32 (390)", sb.over && sb.bar === 0 && sb.h0 === sb.h1 && sb.sbw === "none", JSON.stringify(sb));
    }
    await ctl({ step: 6 });
    // "엇갈림"은 다른 곳(상태 안내 등)에도 있어 묶음 안에서 기다린다
    await pa.waitForFunction(() => /엇갈림\s*값 1개/.test(document.querySelector("[data-checknow]")?.innerText ?? ""), { timeout: 8000 }).catch(() => null);
    await wait(400);
    const after = await pos();
    const frame1 = await text(pa, "[data-checknow]");
    // 묶음 높이는 그대로여야 한다. 개요 제목은 핵심 값 띠의 소수점 차이(끝날 때 약 1px, 이 묶음과 무관)까지만 허용한다
    check(`A-29 (${w})`, before.y === 0 && after.y === 0 && before.ck === after.ck && Math.abs(before.ov - after.ov) <= 2 && frame0.includes("분석이 끝나면 셉니다") && /엇갈림\s*값 1개/.test(frame1), `개요 제목 ${before.ov}→${after.ov}, 자금 후보 ${before.fund}→${after.fund}, 묶음 높이 ${before.ck}→${after.ck}, 핵심 값 바닥 ${before.band}→${after.band}, y ${before.y}/${after.y} |${frame0.replace(/\n/g, " ")} → ${frame1.replace(/\n/g, " ")}`);
    await pa.close();
  }
  // A-20: 경과가 예상의 2배를 넘으면
  await reset({ scenario: "F-STAGED", step: 0, slow: true });
  const p2 = await open(`/c/${CID}`);
  check("A-20", await waitText(p2, "평소보다 오래 걸립니다."));
  // P-10: 기술 낱말 전 판로(옛 판로 주소로 열면 자금 조달 판로 갈래로 간다)
  await reset({ scenario: "F-STAGED", step: 1 });
  const p3 = await open(`/c/${CID}/sales`);
  check("P-10", await waitText(p3, "회사 분석에서 기술 낱말을 받으면 찾습니다."));
  await openDisclosure(p3, "검색어 고치기");
  await p3.type("input[placeholder='검색어 더하기']", "직접낱말");
  await click(p3, "더하기", { exact: true });
  await click(p3, "다시 찾기", { exact: true });
  await wait(800);
  const lg = await getLog();
  check("P-10 (직접 찾기)", lg.some((x) => x.method === "POST" && /sections\/sales/.test(x.path) && x.body?.keywords?.includes("직접낱말")));
});

// ================================================================ 새로 분석 중 펼친 값 목록
// A-30: "지금 확인할 것"의 엇갈림 목록을 펼친 채 새로 분석을 시작하면 목록이 닫히고, 새로 분석이 끝나도 닫힌 채라 아래(개요 제목)가 밀리지 않는다
await run("refresh-list", async () => {
  await reset({ scenario: "F-CONFLICT", refreshJob: true });
  const pr = await open(`/c/${CID}`, { width: 1180 });
  await waitText(pr, "다른 자료:");
  const btn = "[data-checknow] button[aria-controls=checknow-list]";
  await pr.evaluate((b) => document.querySelector(b)?.click(), btn);
  await wait(250);
  const opened = await attr(pr, btn, "aria-expanded");
  await click(pr, "새로 분석", { exact: true });
  await wait(300);
  await click(pr, "새로 분석", { exact: true, within: "dialog[open]" });
  await pr.waitForFunction(() => (document.querySelector("[data-checknow]")?.innerText ?? "").includes("분석이 끝나면 셉니다"), { timeout: 8000 }).catch(() => null);
  await wait(400);
  const pos = () => pr.evaluate(() => ({ ov: Math.round((document.getElementById("h-overview")?.getBoundingClientRect().top ?? 0) + scrollY), list: !document.getElementById("checknow-list")?.classList.contains("hidden") }));
  const during = await pos();
  await ctl({ refreshDone: true });
  await pr.waitForFunction(() => /엇갈림\s*값 1개/.test(document.querySelector("[data-checknow]")?.innerText ?? ""), { timeout: 8000 }).catch(() => null);
  await wait(500);
  const after = await pos();
  const expandedAfter = await attr(pr, btn, "aria-expanded");
  check("A-30", opened === "true" && !during.list && !after.list && expandedAfter === "false" && Math.abs(during.ov - after.ov) <= 2, `펼침 ${opened}→${expandedAfter}, 개요 제목 ${during.ov}→${after.ov}`);
  await pr.close();
});

// ================================================================ 저장된 분석, 상태별
await run("saved", async () => {
  await reset({ scenario: "F-FULL" });
  let page = await open(`/c/${CID}`);
  await waitText(page, "검색으로 확인한 특허 11건");
  await wait(800);
  await ctl({ delayMs: 5000 });
  const n0 = (await getLog()).length;
  const t0 = Date.now();
  page = await open(`/c/${CID}`, { ctx: page.browserContext() });
  const fast = await waitText(page, "검색으로 확인한 특허 11건", 1500);
  const ms = Date.now() - t0;
  const filled = await page.evaluate(() => ["overview", "finance", "investment", "news", "tech"].every((k) => !document.getElementById(k)?.innerText.includes("확인 중")));
  const posts = count((await getLog()).slice(n0), "POST", /\/api\/analysis$/);
  check("A-10", fast && filled && posts === 0 && !(await text(page)).includes("분석 중"), `${ms}ms`);
  await ctl({ delayMs: 0 });
  await reset({ scenario: "F-FULL" });
  page = await open("/c/0000000000009");
  await waitText(page, "아직 분석하지 않은 회사입니다.");
  check("A-11", (await text(page)).includes("분석 시작") && count(await getLog(), "POST", /\/api\/analysis$/) === 0);
  await reset({ scenario: "F-STALE" });
  page = await open(`/c/${CID}`);
  await waitText(page, "오래된 분석입니다");
  check("A-12", (await text(page)).includes("45일 전 분석입니다.") && count(await getLog(), "POST", /\/api\/analysis$/) === 0);
  await reset({ scenario: "F-EXAMPLE" });
  page = await open(`/c/${CID}`);
  await waitText(page, "저장해 둔 예시 분석입니다.");
  check("A-13", (await text(page)).includes("예시 회사") && !(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "새로 분석"))));
  await reset({ scenario: "F-LIMIT-NEWS" });
  page = await open(`/c/${CID}`);
  await waitText(page, "준비됨");
  const news = await text(page, "#news");
  const disabled = await page.evaluate(() => [...document.querySelectorAll("#news button")].find((b) => b.textContent.trim() === "이 단락 다시 분석")?.disabled);
  const othersOk = await page.evaluate(() => ["overview", "finance", "investment", "tech"].every((k) => !document.getElementById(`h-${k}`).innerText.includes("미확보") && !document.getElementById(k).innerText.includes("확인 중")));
  check("A-17", news.includes("미확보") && news.includes("오늘 호출 상한에 닿아") && disabled === true && news.includes("내일 다시 시도할 수 있습니다") && othersOk);
  const line = await text(page);
  await click(page, "분석이 끝났습니다. 미확보 단락 1개");
  await wait(300);
  const top = await page.$eval("#news", (e) => e.getBoundingClientRect().top);
  check("A-18", line.includes("분석이 끝났습니다. 미확보 단락 1개") && top < 200 && page.url().endsWith("#news"), `${Math.round(top)} ${page.url()}`);
  await reset({ scenario: "F-INTERRUPTED" });
  page = await open(`/c/${CID}`);
  await waitText(page, "분석이 중간에 멈췄습니다. 받은 단락은 그대로 두었습니다.");
  check("A-19", (await page.$$eval("#finance svg[role=img]", (l) => l.length)) === 2 && (await text(page, "#overview")).includes("데이터센터") && (await text(page, "#investment")).includes("시리즈 C"));
  await reset({ scenario: "F-FULL" });
  page = await open(`/c/${CID}#tech`);
  await waitText(page, "검색으로 확인한 특허 11건");
  await wait(600);
  const tt = await page.$eval("#tech", (e) => e.getBoundingClientRect().top);
  check("A-22", tt >= -2 && tt < 200, `${Math.round(tt)}px`);
});

// 시작 화면이 넘긴 작업 id(세션 값 pending.jobId)는 한 번만 쓴다. 끝났거나 서버에 없는 작업 id 가 남아 있어도 그 회사의
// 진행 중 작업과 최신 저장 분석을 찾는다(같은 탭에서 나중에 새로 분석한 뒤 새로고침한 경우)
await run("resume", async () => {
  const OLD = "a".repeat(32); // 가짜 서버에 없는 옛 작업
  const RUNNING = "5a1c0e7b9d3f4a2e8b6c1d0f9e8a7b6c";
  const withPending = async (jobId = OLD) => {
    const page = await open("/");
    await page.evaluate((cid, id) => sessionStorage.setItem(`growthnote.pending.${cid}`, JSON.stringify({ name: "가나다테크", crno: null, homepage: null, jobId: id })), CID, jobId);
    // 앞 점검에서 열어 둔 화면도 같은 작업 id 를 묻으므로, 이 화면이 보낸 요청만 센다
    page.apiPaths = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/")) page.apiPaths.push(u.pathname.slice(5));
    });
    await page.goto(`${BASE}/c/${CID}`, { waitUntil: "domcontentloaded" });
    return page;
  };
  const pendingJob = (page) => page.evaluate((cid) => JSON.parse(sessionStorage.getItem(`growthnote.pending.${cid}`) ?? "{}").jobId ?? null, CID);
  const sent = (page, path) => page.apiPaths.filter((p) => p === path).length;
  /** 이 화면이 그 주소로 보낸 요청이 n회가 될 때까지(최대 timeout) 기다려 그 수를 돌려준다 */
  const waitSent = async (page, path, n, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end && sent(page, path) < n) await wait(250);
    return sent(page, path);
  };
  const polled = `analysis/${RUNNING}`;
  const savedPath = `company/${CID}/analysis`;
  await reset({ scenario: "F-FULL" });
  let page = await withPending();
  const shown = await waitText(page, "검색으로 확인한 특허 11건");
  check("A-24 (끝난 작업 id)", shown && !(await text(page)).includes("아직 분석하지 않은 회사입니다.") && sent(page, `analysis/${OLD}`) === 1 && sent(page, savedPath) >= 1 && (await pendingJob(page)) === null);
  await page.browserContext().close();
  await reset({ scenario: "F-STAGED", step: 2 });
  page = await withPending();
  const runPolls = await waitSent(page, polled, 2);
  check("A-24 (진행 중 작업)", sent(page, `company/${CID}/job`) >= 1 && runPolls >= 2 && sent(page, `analysis/${OLD}`) === 1 && (await pendingJob(page)) === null, `폴링 ${runPolls}회`);
  await page.browserContext().close();
  // 기억한 작업이 끝났지만 단락 다시 실행 중(done + busy)이고 더 새 저장 분석이 있어도, 그 작업을 계속 묻는다
  const news = JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-FULL.json", import.meta.url), "utf8")).exchanges.find((e) => e.method === "GET" && /^\/api\/analysis\/[0-9a-f]{32}$/.test(e.path)).response.sections.news;
  await reset({ scenario: "F-FULL", newerSaved: true, overrides: { news: { ...news, retryable: false, rerun: { status: "running", startedAt: "2026-11-22T20:59:00+09:00", seconds: 1, error: null } } } });
  page = await withPending(RUNNING);
  const rerunPolls = await waitSent(page, polled, 3); // 처음 확인 1회 + 폴링 2회 이상
  check("A-24 (단락 다시 실행 중)", rerunPolls >= 3 && sent(page, savedPath) === 0 && (await text(page, "#news")).includes("새로 확인 중"), `폴링 ${rerunPolls}회, 저장 분석 조회 ${sent(page, savedPath)}회`);
  await page.browserContext().close();
});

// ================================================================ 회사 분석 단락(F-FULL), 경쟁사, 자금·판로(판로 갈래 포함), 심사 준비, 노트를 한 브라우저로 이어서
const finder = await import("../lib/finder.ts");
await run("main", async () => {
  await reset({ scenario: "F-FULL" });
  const page = await open(`/c/${CID}`);
  const ctx = page.browserContext();
  await waitText(page, "검색으로 확인한 특허 11건");
  await wait(500);
  await globalChecks(page, "회사 분석 1180");
  const full = await text(page);
  check("A-21", (await text(page, "h1")) === "주식회사 가나다테크");
  const tiles = await page.$$eval("ul[aria-label='핵심 값'] > li", (l) => l.map((x) => x.innerText.split("\n")[0]));
  check("A-14", tiles.join(",") === "매출,국민연금 가입자,누적 투자,검색으로 확인한 특허" && !/지역|업력|설립|기업 유형/.test(tiles.join()), tiles.join(","));
  // A-25: 엇갈림·미확보 값도, 담은 공고도 없으면 "지금 확인할 것" 묶음을 그리지 않는다(F-FULL)
  check("A-25 (모두 0)", !(await page.$("[data-checknow]")));
  await page.evaluate(() => [...document.querySelectorAll("ul[aria-label='핵심 값'] a")].find((a) => a.innerText.startsWith("검색으로 확인한 특허"))?.click());
  await wait(400);
  check("A-15", (await page.evaluate(() => document.activeElement?.id)) === "h-tech");
  const order = await page.$$eval("main section[aria-labelledby^=h-]", (l) => l.map((s) => s.id).join(","));
  check("C-14", order === "overview,finance,investment,news,tech", order);
  const tocDir = await page.$eval("nav[aria-label='단락 목차'] ol", (e) => getComputedStyle(e).flexDirection);
  // 개요
  const ov = await text(page, "#overview");
  const clamp = await page.$eval("#overview .clamp-2", (e) => e.scrollHeight > e.clientHeight).catch(() => false);
  await click(page, "더 읽기", { exact: true, within: "#overview" });
  const unclamped = !(await page.$("#overview p.clamp-2"));
  check("OV-01", clamp && unclamped && ov.includes("공개 자료 25건을 정리한 요약"), "decisions 1번에 따라 '추정' 대신 고정 문구");
  check("OV-02", ["대표", "설립", "본사", "직원 수"].every((w) => ov.includes(w)));
  check("OV-03", ov.includes("가나다 칩 A1, 가나다 칩 A2, 가나다 칩 A3") && ov.includes("제품·서비스 6개 모두 보기") && !ov.includes("추론용 신경망 가속 칩 1세대"));
  const techWords = await page.$$eval("#overview ul li.rounded", (l) => l.filter((x) => x.getBoundingClientRect().height > 0).length);
  check("OV-04", techWords === 4 && ov.includes("핵심 기술 6개 모두 보기"));
  const stageVal = JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-FULL.json", import.meta.url), "utf8")).exchanges[0].response.sections.profile.result.stage;
  check("OV-05", !full.includes("가짜낱말") && (!stageVal || !full.includes(stageVal)), `stage=${stageVal}`);
  check("OV-07", (await disclosure(page, "근거 자료 25건 보기")) === "false");
  await openDisclosure(page, "기업 정보 더 보기");
  const corp = await text(page, "#overview");
  check("OV-06", corp.includes("업종(금융위)") && corp.includes("업종(웹 조사)") && corp.includes("전자집적회로 제조업") && corp.includes("AI 반도체 설계"));
  // OV-08: "기업 정보 더 보기"에서 링크가 든 홈페이지 행도 다른 한 줄 행과 높이(행 사이 선 1px 제외)가 같고, 링크의 누르는 영역은 44px 이상이며 행 밖으로 나가지 않는다
  const pairs = await page.$$eval("#overview [data-pair]", (rows) =>
    rows.map((r) => {
      const dd = r.querySelector("dd");
      const a = r.querySelector("a");
      const rr = r.getBoundingClientRect();
      const ar = a?.getBoundingClientRect();
      return { k: r.dataset.pair, h: r.clientHeight, oneLine: dd.getBoundingClientRect().height < 30, link: ar ? { h: Math.round(ar.height), inside: ar.top >= rr.top - 0.5 && ar.bottom <= rr.bottom + 0.5 } : null };
    }),
  );
  const oneLineHeights = [...new Set(pairs.filter((p) => p.oneLine).map((p) => p.h))];
  const home = pairs.find((p) => p.k === "홈페이지");
  check("OV-08", oneLineHeights.length === 1 && home?.oneLine && home.link && home.link.h >= 44 && home.link.inside, pairs.map((p) => `${p.k}:${p.h}${p.link ? `(링크 ${p.link.h})` : ""}`).join(", "));
  // C-02: 대표 줄
  const rowHidden = await page.evaluate(() => {
    const b = [...document.querySelectorAll("#overview .row-btn")].find((x) => x.innerText.startsWith("대표"));
    const body = document.getElementById(b.getAttribute("aria-controls"));
    const before = body.getBoundingClientRect().height === 0;
    const words = b.querySelectorAll(".word").length;
    b.click();
    return { before, words, id: b.getAttribute("aria-controls") };
  });
  await wait(200);
  const srcShown = await page.$eval(`#${CSS_escape(rowHidden.id)}`, (e) => e.innerText).catch(() => "");
  check("C-02", rowHidden.before && rowHidden.words === 1 && srcShown.includes("금융위원회 기업기본정보 (공공 API)"));
  // 재무
  const fi = await text(page, "#finance");
  const labels = await page.$$eval("#finance svg[role=img]", (l) => l.map((s) => s.getAttribute("aria-label")));
  check("FI-01", labels.length === 2 && labels.every((l) => /\d/.test(l)));
  check("FI-02", fi.includes("원문 확인") && fi.includes("금융위원회 요약재무제표 (공공 API)") && fi.includes("2022~2024 사업연도") && fi.includes("별도"));
  check("FI-03", fi.includes("국민연금 가입자 수 (직원 수와 다릅니다)") && /참고\s*국민연금공단/.test(fi));
  check("FI-06", fi.includes("웹 조사 매출:") && /웹 조사 매출:[^\n]*\n?\s*보도/.test(fi));
  const tableClosed = (await disclosure(page, "재무 표 보기")) === "false";
  await openDisclosure(page, "재무 표 보기");
  const tbl = await page.evaluate(() => {
    const t = [...document.querySelectorAll("#finance table")].find((x) => x.getBoundingClientRect().height > 0);
    return { cols: t.querySelectorAll("thead th").length, rows: t.querySelectorAll("tbody tr").length, txt: t.innerText, words: t.querySelectorAll(".word").length, srcAfter: t.closest(".panel").querySelectorAll(".source").length };
  });
  check("FI-04", tableClosed && tbl.cols === 4 && tbl.rows === 7 && tbl.txt.includes("—"));
  check("FI-05", tbl.txt.includes("56.7"));
  check("C-03", tbl.words === 0 && tbl.srcAfter === 1);
  // 투자
  const inv = await text(page, "#investment");
  const dates = await page.$$eval("#investment > div > ul:first-of-type > li", (l) => l.map((x) => x.innerText.split("\n")[0]));
  check("IN-01", dates.length === 3 && [...dates].sort().reverse().join() === dates.join() && inv.includes("라운드 10건 모두 보기"), dates.join(","));
  check("IN-03", inv.includes("다른 자료 금액: $55M") && /다른 자료 금액[^\n]*\n?\s*엇갈림/.test(inv));
  const names = inv.split("투자기관 35곳")[1]?.split("\n").find((x) => x.includes(",")) ?? "";
  check("IN-04", names.split(", ").length === 5 && names.startsWith("가나다벤처스"), names);
  check("IN-05", !/VC·재무적|전략적|정책금융/.test(full));
  await openDisclosure(page, "라운드 10건 모두 보기");
  await page.evaluate(() => document.querySelector("#investment .row-btn")?.click());
  await wait(200);
  const inv2 = await text(page, "#investment");
  check("IN-02", inv2.includes("시리즈 B") && inv2.includes("시드") && inv2.includes("자료의 원래 표기: Series C"));
  const relClosed = (await disclosure(page, "이름이 비슷한 다른 법인 자료 1건")) === "false";
  await openDisclosure(page, "이름이 비슷한 다른 법인 자료 1건");
  check("IN-07", relClosed && (await text(page, "#investment")).includes("기존 투자자 판정에 쓰지 않습니다."));
  check("D-04 (투자 단락)", inv.includes("투자기관 35곳"));
  // 최근 동향
  const ne = await text(page, "#news");
  check("NE-01", (await page.$$eval("#news > div > ul:first-of-type > li", (l) => l.length)) === 3 && ne.includes("중요 사건 11개 더 보기") && ne.includes("기사 693건 보기") && !ne.includes("실적 발표 소식 1"));
  check("NE-05", !full.includes("긴요약표지"));
  check("NE-09", ne.includes("2025-11-22 ~ 2026-11-22") && ne.includes("중복 정리 후 693건") && ne.includes("수집 1,400건"));
  const trClosed = (await disclosure(page, "흐름 요약 보기")) === "false";
  await openDisclosure(page, "흐름 요약 보기");
  const trends = await page.evaluate(() => [...document.querySelectorAll("#news [role=region]")].find((r) => r.getAttribute("aria-label") === "흐름 요약 보기")?.querySelectorAll("li").length);
  check("NE-06", trClosed && trends > 0 && trends <= 5, `${trends}줄`);
  let n0 = (await getLog()).length;
  await openDisclosure(page, "기사 693건 보기");
  await waitText(page, "20건 더 보기 (673건 남음)");
  const items = await page.$$eval("#news [data-item]", (l) => l.filter((x) => x.getBoundingClientRect().height > 0).length);
  const req1 = count((await getLog()).slice(n0), "GET", /\/news$/);
  await page.evaluate(() => [...document.querySelectorAll("#news button.disclosure")].find((b) => b.textContent.startsWith("기사"))?.click());
  await wait(200);
  await page.evaluate(() => [...document.querySelectorAll("#news button.disclosure")].find((b) => b.textContent.startsWith("기사"))?.click());
  await wait(500);
  check("NE-02", req1 === 1 && items === 20 && count((await getLog()).slice(n0), "GET", /\/news$/) === 1, `요청 ${req1}, ${items}줄`);
  await click(page, "20건 더 보기", { within: "#news" });
  await wait(1200);
  const focus = await page.evaluate(() => document.activeElement?.closest("[data-item]")?.getAttribute("data-item"));
  check("C-13", focus === "20" && (await text(page, "#news")).includes("20건 더 보기 (653건 남음)"), `초점 ${focus}`);
  await click(page, "수주·계약", { within: "#news" });
  await wait(1200);
  check("NE-03", (await text(page, "#news")).includes("수주·계약 기사 122건") && (await page.$$eval("#news [data-item]", (l) => l.filter((x) => x.getBoundingClientRect().height > 0).length)) === 20);
  await page.evaluate(() => document.querySelector("#news [data-item] .row-btn")?.click());
  await wait(300);
  check("NE-04", /가짜 기사 발췌[\s\S]*기사 열기/.test(await text(page, "#news")));
  n0 = (await getLog()).length;
  await click(page, "뉴스만 새로 받기");
  await wait(300);
  await click(page, "뉴스 새로 받기", { exact: true, within: "dialog[open]" });
  await wait(1000);
  const lg = (await getLog()).slice(n0);
  check("NE-07", count(lg, "POST", /sections\/news$/) === 1 && count(lg, "POST", /sections\/(?!news)/) === 0);
  // 뉴스만 새로 받기가 끝나면(결과 판이 바뀌면) 펼친 기사 목록을 첫 쪽부터 새로 받는다. 옛 쪽·건수가 남거나 더 보기에서 섞이지 않는다
  const freshDeals = NEWS_ARTICLES.slice(NEWS_REFRESH_DROP).filter((a) => a.categories.includes("수주·계약"));
  const refreshed = await waitText(page, `수주·계약 기사 ${freshDeals.length}건`, 12000);
  await wait(300);
  const refetched = (await getLog()).slice(n0).filter((x) => x.method === "GET" && /\/news$/.test(x.path) && /offset=0/.test(x.query)).length;
  const firstTitle = await page.$eval("#news [data-item='0']", (e) => e.innerText.split("\n")[0].trim()).catch(() => "");
  const shown = await page.$$eval("#news [data-item]", (l) => l.filter((x) => x.getBoundingClientRect().height > 0).length);
  check("NE-10", refreshed && refetched >= 1 && firstTitle === freshDeals[0].title && shown === 20, `${firstTitle} / ${shown}줄 / 다시 받기 ${refetched}`);
  // 기술
  const te = await text(page, "#tech");
  const yrs = await page.$eval("#tech svg[role=img]", (s) => s.getAttribute("aria-label"));
  check("TE-01", ["2022", "2023", "2024", "2025", "2026"].every((y) => yrs.includes(`${y}년`)) && te.includes("공개 전 기간"));
  const fdates = (te.match(/출원 (\d{4}-\d{2}-\d{2})/g) ?? []).slice(0, 3);
  check("TE-02", fdates.length === 3 && [...fdates].sort().reverse().join() === fdates.join() && te.includes("특허 11건 모두 보기"), fdates.join(","));
  check("TE-03", te.includes("특허 문서 30건까지 원문을 확인했습니다."));
  // TE-08(출처 범위): 묶음 출처 줄 기준은 값 이름과 헷갈리지 않는 범위 글이고, 기술 단락에 옛 이름 "국내 특허"가 없다(2026-11-23)
  check("TE-08 (출처 범위)", te.includes("조회, 검색으로 찾은 문서 중 출원인이 이 회사인 한국 특허만") && !te.includes("국내 특허"), te.match(/조회, [^\n]*특허만/)?.[0] ?? "");
  const menClosed = (await disclosure(page, "회사 이름이 나오지만 출원인이 다른 문서 1건")) === "false";
  await openDisclosure(page, "회사 이름이 나오지만 출원인이 다른 문서 1건");
  check("TE-04", menClosed && (await text(page, "#tech")).includes("건수에 넣지 않았습니다."));
  check("TE-05", te.includes("논문 분석하기") && te.includes("Liner 학술 검색") && count(await getLog(), "POST", /sections\/papers/) === 0);
  n0 = (await getLog()).length;
  await click(page, "논문 분석하기", { within: "#tech" });
  await wait(800);
  check("TE-06", count((await getLog()).slice(n0), "POST", /sections\/papers$/) === 1);
  // ---------------------------------------------------------- 경쟁사 분석(screens 4B, 2026-11-23 회사 분석 경쟁사 단락에서 옮김)
  const rvLog0 = (await getLog()).length;
  const rv = await open(`/c/${CID}/rivals`, { ctx });
  await waitText(rv, "경쟁사 후보 4곳 중 비교 대상");
  let ri = await text(rv, "#pick");
  check("RI-02", (ri.match(/마바사/g) ?? []).length === 1 && (ri.match(/Mabasa/g) ?? []).length === 1);
  check("C-12", !/후보 \d+곳 더 보기/.test(ri));
  const deepDisabled = () => rv.evaluate(() => [...document.querySelectorAll("#compare button")].find((b) => b.textContent.trim() === "비교 자료 받기")?.disabled);
  check("RI-05 (0곳)", await deepDisabled());
  const yesNo = (name, which) => rv.evaluate((name, which) => [...document.querySelectorAll("#pick [role=group]")].find((g) => g.getAttribute("aria-label") === `${name} 비교 대상`)?.querySelectorAll("button")[which === "yes" ? 0 : 1].click(), name, which);
  await yesNo("카타파", "no");
  await wait(300);
  ri = await text(rv, "#pick");
  const firstList = await rv.$eval("#pick [data-candidates]", (u) => u.innerText);
  await openDisclosure(rv, "제외한 후보", "#pick");
  const pressed = await rv.evaluate(() => [...document.querySelectorAll("#pick [role=group]")].find((g) => g.getAttribute("aria-label") === "카타파 비교 대상")?.querySelectorAll("button")[1].getAttribute("aria-pressed"));
  check("RI-03", pressed === "true" && ri.includes("제외한 후보 1곳") && !firstList.includes("카타파"));
  await yesNo("마바사", "yes");
  await yesNo("하하테크", "yes");
  await wait(300);
  check("RI-05", !(await deepDisabled()) && /Liner 약/.test(await text(rv, "#compare")));
  check("C-23 (경쟁사)", (await attr(rv, `nav[aria-label=단계] a[href="/c/${CID}/rivals"]`, "aria-label")) === "경쟁사 분석, 비교 대상 2곳" && (await text(rv, "#pick")).includes("경쟁사 후보 4곳 중 비교 대상 2곳"));
  await openDisclosure(rv, "경쟁사 직접 추가", "#pick");
  await rv.type("#pick input", "직접넣은회사");
  await click(rv, "추가", { exact: true, within: "#pick" });
  await wait(300);
  const added = await rv.evaluate(() => {
    const li = [...document.querySelectorAll("#pick [data-candidates] > li")].find((l) => l.innerText.includes("직접넣은회사"));
    return { edited: li?.innerText.includes("직접 입력"), yes: li?.querySelector("button[aria-pressed=true]")?.textContent.trim(), last: li === li?.parentElement.lastElementChild };
  });
  check("RI-10", added.edited && added.yes === "포함" && added.last);
  // 직접 추가한 회사는 비교 자료 요청에서 빼고 시험한다
  await rv.evaluate(() => [...document.querySelectorAll("#pick [role=group]")].find((g) => g.getAttribute("aria-label") === "직접넣은회사 비교 대상")?.querySelectorAll("button")[0].click());
  await wait(300);
  const rvReload = await open(`/c/${CID}/rivals`, { ctx });
  await waitText(rvReload, "제외한 후보 1곳");
  check("RI-04", (await rvReload.evaluate(() => [...document.querySelectorAll("#pick [role=group]")].find((g) => g.getAttribute("aria-label") === "마바사 비교 대상")?.querySelectorAll("button")[0].getAttribute("aria-pressed"))) === "true");
  await rvReload.close();
  const before = count((await getLog()).slice(rvLog0), "POST", /sections\/rivals_deep$/);
  n0 = (await getLog()).length;
  await click(rv, "비교 자료 받기", { exact: true, within: "#compare" });
  await rv.waitForFunction(() => document.querySelectorAll("table[data-compare=table] thead th").length === 4, { timeout: 8000 }).catch(() => null);
  await wait(400);
  const deepReq = (await getLog()).slice(n0).filter((x) => x.method === "POST" && /sections\/rivals_deep$/.test(x.path));
  const keys = deepReq[0]?.body?.rivals?.map((r) => r.key) ?? [];
  check("RI-06", before === 0 && deepReq.length === 1 && keys.join() === "rival:마바사,rival:하하테크", `열고 고르는 동안 ${before}회, 누른 뒤 ${deepReq.length}회: ${keys.join()}`);
  const cmp = await rv.evaluate(() => {
    const t = document.querySelector("table[data-compare=table]");
    const heads = [...t.querySelectorAll("thead th")].map((c) => c.innerText.split("\n")[0].trim());
    const rows = [...t.querySelectorAll("tbody tr")].map((r) => ({ label: r.querySelector("th").innerText.trim(), cells: [...r.querySelectorAll("td")].map((c) => ({ t: c.innerText, words: c.querySelectorAll(".word").length })) }));
    return { heads, rows };
  });
  const cellOf = (label, i) => cmp.rows.find((r) => r.label === label)?.cells[i]?.t ?? "";
  const everyCellHasWord = cmp.rows.every((r) => r.cells.every((c) => c.words >= 1));
  check(
    "RI-07",
    cmp.heads.join() === "항목,주식회사 가나다테크,마바사,하하테크" && cmp.rows.map((r) => r.label).join() === "매출,국민연금 가입자,누적 투자,검색으로 확인한 특허,최근 라운드,주요 투자자,설립" && everyCellHasWord &&
      cellOf("매출", 1).includes("2024 사업연도, 별도") && cellOf("매출", 1).includes("금융위원회") && /\d{4}-\d{2}/.test(cellOf("국민연금 가입자", 1)) && cellOf("매출", 2).startsWith("미확보") && cellOf("매출", 2).includes("금융위원회 재무 자료 없음"),
    cmp.rows.map((r) => `${r.label}:${r.cells.map((c) => c.t.replace(/\n/g, " ")).join(" | ")}`).join(" / ").slice(0, 400),
  );
  await openDisclosure(rv, "그림으로 보기", "#compare");
  const bars = await rv.$$eval("#compare figure figcaption", (l) => l.map((f) => f.textContent));
  check("RI-08", bars.includes("USD") && (await text(rv, "#compare")).includes("금액 미확보: 하하테크"), bars.join(","));
  // 누적 투자 막대의 글(이름·금액·기준)이 그림 상자(viewBox) 밖으로 넘쳐 잘리지 않는다(실제 서버 검증에서 긴 기준 글이 잘려 찾음)
  const clipped = await rv.$$eval("#compare figure svg[role=img]", (svgs) =>
    svgs.flatMap((s) => {
      const vb = s.viewBox.baseVal;
      return [...s.querySelectorAll("text")].map((t) => t.getBBox()).filter((b) => b.x + b.width > vb.width + 0.5 || b.y + b.height > vb.height + 0.5).map((b) => Math.round(b.x + b.width));
    }),
  );
  check("RI-08 (글 넘침 없음)", clipped.length === 0, clipped.join(","));
  // RI-13: 경쟁사별 펼치기 줄은 모두 접혀 있고, 펼치면 사업·제품·기술·최근 변화와 "추정" 출처 줄
  const notes0 = await rv.$$eval("[data-rival-notes] button.disclosure", (l) => l.map((b) => b.getAttribute("aria-expanded")));
  await openDisclosure(rv, "마바사", "[data-rival-notes]");
  const note = await rv.evaluate(() => [...document.querySelectorAll("[data-rival-notes] [role=region]")].find((r) => r.getAttribute("aria-label") === "마바사 자세히")?.innerText ?? "");
  check("RI-13", notes0.length === 2 && notes0.every((e) => e === "false") && ["사업", "제품·기술", "최근 변화", "가짜 변화 3", "추정", "경쟁사 기사를 모델이 정리"].every((w) => note.includes(w)), `${notes0.join(",")} | ${note.replace(/\n/g, " ").slice(0, 160)}`);
  // RI-14: 경쟁사에 투자한 곳(가짜 운용사 "타파하인베스트"는 자금 조달 운용사 목록에 끼워 넣은 이름)
  const bk = await rv.evaluate(() => ({
    t: document.querySelector("#backers")?.innerText ?? "",
    tapa: [...document.querySelectorAll("[data-backer] li")].find((l) => l.innerText.startsWith("타파하인베스트"))?.innerText ?? "",
    href: [...document.querySelectorAll("#backers a")].find((a) => a.textContent.includes("투자받는 돈에서 보기"))?.getAttribute("href"),
  }));
  check("RI-14", bk.t.includes("마바사") && bk.tapa.includes("모태펀드 운용사") && bk.href === `/c/${CID}/funding?lane=invest`, `${bk.tapa.replace(/\n/g, " ")} ${bk.href}`);
  check("RI-17", !/순위|우세|열세|\d+위\b|±/.test(await text(rv, "main")));
  await globalChecks(rv, "경쟁사 분석 1180");
  await sh(rv, "rivals-deep-1180", true);
  await yesNo("아자차랩스", "yes");
  await wait(300);
  // RI-09: 비교 대상을 바꿔도 "바뀌었다" 안내는 없고(사용자 결정), 표는 저장된 비교 자료 그대로, 다시 받기 단추와 지금 비교 대상 수 기준 비용 줄
  {
    const t9 = await text(rv, "#compare");
    const heads = await rv.$$eval("table[data-compare=table] thead th", (l) => l.map((x) => x.innerText.split("\n")[0].trim()));
    check("RI-09", !t9.includes("바뀌었습니다") && !(await rv.$("[data-changed]")) && heads.join() === "항목,주식회사 가나다테크,마바사,하하테크" && t9.includes("비교 자료 다시 받기") && t9.includes("비교 대상 3곳 기준"), `${heads.join()} | ${t9.includes("비교 대상 3곳 기준")}`);
  }
  await yesNo("아자차랩스", "yes");
  await wait(300);
  // RI-11: 390 폭에서는 표 대신 항목마다 한 덩어리(회사마다 한 줄, 우리 회사가 맨 위). 1층은 핵심 값과 같은 4항목, 나머지 3항목은 펼쳐 본다
  {
    const r390 = await open(`/c/${CID}/rivals`, { ctx, width: 390 });
    await r390.waitForSelector("[data-compare=items]");
    await wait(400);
    const blocks = () =>
      r390.evaluate(() =>
        [...document.querySelectorAll("[data-compare=items] [data-item-block]")].filter((b) => b.getBoundingClientRect().height > 0).map((b) => ({ h: b.querySelector("h3")?.textContent, first: b.querySelector("li")?.getAttribute("data-company"), n: b.querySelectorAll("li").length })),
      );
    const b0 = await blocks();
    const table0 = await r390.evaluate(() => document.querySelector("table[data-compare=table]")?.getBoundingClientRect().height ?? 0);
    const restClosed = (await disclosure(r390, "최근 라운드, 주요 투자자, 설립 보기")) === "false";
    await openDisclosure(r390, "최근 라운드, 주요 투자자, 설립 보기", "[data-compare=items]");
    const b1 = await blocks();
    check(
      "RI-11",
      table0 === 0 && b0.map((b) => b.h).join() === "매출,국민연금 가입자,누적 투자,검색으로 확인한 특허" && restClosed && b1.length === 7 && b1.every((b) => b.first === "주식회사 가나다테크" && b.n === 3),
      `${b0.map((b) => b.h).join()} → ${b1.length}덩어리`,
    );
    await globalChecks(r390, "경쟁사 분석 390");
    await sh(r390, "rivals-deep-390", true);
    await r390.close();
  }
  // RI-12: 회사 분석에는 경쟁사 단락이 없고 경쟁사 분석으로 가는 한 줄이 있다. 옛 #rivals 주소는 경쟁사 분석으로 간다
  {
    const an = await open(`/c/${CID}`, { ctx });
    await waitText(an, "검색으로 확인한 특허 11건");
    await wait(400);
    const line = await an.evaluate(() => ({ t: document.querySelector("[data-rivals-line]")?.innerText ?? "", href: document.querySelector("[data-rivals-line] a")?.getAttribute("href"), sec: Boolean(document.getElementById("rivals")), toc: [...document.querySelectorAll("nav[aria-label='단락 목차'] a")].map((a) => a.textContent) }));
    const old = await open(`/c/${CID}#rivals`, { ctx });
    const moved = await old.waitForFunction(() => location.pathname.endsWith("/rivals"), { timeout: 8000 }).then(() => true).catch(() => false);
    check("RI-12", !line.sec && !line.toc.some((t) => t.startsWith("경쟁사")) && line.t.includes("경쟁사 후보 4곳, 비교 대상 2곳") && line.href === `/c/${CID}/rivals` && moved, `${line.t.replace(/\n/g, " ")} ${line.href} 옛 주소 ${moved}`);
    await an.close();
    await old.close();
  }
  // 직접 입력(C-08), 확인 창(C-15~C-19)
  await click(page, "회사 정보 수정", { exact: true });
  await wait(400);
  const firstFocus = await page.evaluate(() => document.activeElement?.id);
  const sheetHead = await page.evaluate(() => document.querySelector("dialog[open] h2")?.parentElement?.innerText ?? "");
  await page.$eval("#edit-industry", (e) => e.focus());
  await page.evaluate(() => {
    const i = document.getElementById("edit-industry");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(i, "고친 업종");
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait(200);
  const editsBefore = await idbGet(page, "edits", CID);
  check("C-18", !editsBefore?.industry && count(await getLog(), "POST", /notice|gp\/brief/) === 0);
  await click(page, "저장", { exact: true, within: "dialog[open]" });
  await wait(500);
  const back = await page.evaluate(() => document.activeElement?.textContent.trim());
  check("C-19", firstFocus === "edit-region" && back === "회사 정보 수정", `${firstFocus}, ${back}`);
  check(
    "C-22",
    sheetHead.startsWith("회사 정보 수정") && sheetHead.includes("자격 대조와 운용사 요약에 쓰는 정보입니다.") && (await text(page)).includes("회사 정보를 저장했습니다."),
    sheetHead.split("\n")[0],
  );
  await openDisclosure(page, "기업 정보 더 보기");
  const indRow = await page.evaluate(() => {
    const b = [...document.querySelectorAll("#overview .row-btn")].find((x) => x.innerText.startsWith("업종") && x.innerText.includes("고친 업종"));
    if (!b) return null;
    b.click();
    return b.getAttribute("aria-controls");
  });
  await wait(200);
  const indBody = indRow ? await page.$eval(`#${CSS_escape(indRow)}`, (e) => e.innerText) : "";
  check("C-08", Boolean(indRow) && indBody.includes("원래 분석 값") && indBody.includes("분석 값으로 되돌리기") && (await text(page, "#overview")).includes("직접 입력"));
  n0 = (await getLog()).length;
  await click(page, "새로 분석", { exact: true });
  await wait(400);
  const dlg = await text(page, "dialog[open]");
  const fFocus = await page.evaluate(() => document.activeElement?.textContent.trim());
  await page.keyboard.press("Escape");
  await wait(300);
  const closed = !(await page.$("dialog[open]"));
  check("C-15", fFocus === "취소" && closed && ["걸리는 시간", "Liner 호출", "지우지 않고 남깁니다", "그대로 둡니다"].every((w) => dlg.includes(w)));
  await click(page, "새로 분석", { exact: true });
  await wait(300);
  await click(page, "취소", { exact: true, within: "dialog[open]" });
  await wait(300);
  const c0 = count((await getLog()).slice(n0), "POST", /\/api\/analysis$/);
  await click(page, "새로 분석", { exact: true });
  await wait(300);
  await click(page, "새로 분석", { exact: true, within: "dialog[open]" });
  await wait(800);
  const posts = (await getLog()).slice(n0).filter((x) => x.method === "POST" && /\/api\/analysis$/.test(x.path));
  check("C-16", c0 === 0 && posts.length === 1 && posts[0].body?.refresh === true);
  await ctl({ refreshRemaining: 0 });
  const p17 = await open(`/c/${CID}`, { ctx });
  await waitText(p17, "검색으로 확인한 특허 11건");
  await click(p17, "새로 분석", { exact: true });
  await wait(300);
  check("C-17", (await p17.evaluate(() => [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.trim() === "새로 분석")?.disabled)) && (await text(p17, "dialog[open]")).includes("다 썼습니다"));
  await p17.close();
  await ctl({ refreshRemaining: null });
  // C-10: 펼치기 줄 키보드
  const kb = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button.disclosure")].find((x) => x.textContent.startsWith("상태 표시 안내"));
    b.focus();
    return b.getAttribute("aria-expanded");
  });
  await page.keyboard.press("Enter");
  await wait(200);
  const kb2 = await page.evaluate(() => ({ e: document.activeElement.getAttribute("aria-expanded"), t: document.activeElement.textContent }));
  await page.keyboard.press("Space");
  await wait(200);
  const kb3 = await page.evaluate(() => ({ e: document.activeElement.getAttribute("aria-expanded"), t: document.activeElement.textContent }));
  check("C-10", kb === "false" && kb2.e === "true" && kb3.e === "false" && kb3.t.startsWith("상태 표시 안내") && Boolean(await page.$("button.disclosure[aria-controls]")));
  // C-01: 상태 낱말
  const words = await page.evaluate(() => Object.fromEntries(["confirmed", "reported", "inferred", "unavailable", "reference", "edited"].map((w) => [w, [...new Set([...document.querySelectorAll(`.word-${w}`)].map((e) => e.textContent.trim()))]])));
  check("C-01", words.confirmed.join() === "원문 확인" && words.reported.join() === "보도" && words.inferred.join() === "추정" && words.reference.join() === "참고" && words.unavailable.join() === "미확보" && words.edited.join() === "직접 입력", JSON.stringify(words));
  check("C-07", full.includes("국민연금 가입자") && !/직원 수\s*132명/.test(full));
  check("C-05", !/맞는 값|정확한 값|올바른/.test(full));

  // ---------------------------------------------------------- 자금 조달
  n0 = (await getLog()).length;
  const fp = await open(`/c/${CID}/funding`, { ctx });
  await waitText(fp, "회사 분석 값으로 채운 조건");
  const chips = await fp.$$eval("label.chip select", (l) => l.map((s) => s.options[s.selectedIndex]?.text));
  const gate = (await text(fp)).includes("기업 유형을 골라 주세요") && (await text(fp)).includes("창업·벤처기업으로 보입니다");
  check("F-01", chips[0] === "서울" && chips[1] === "골라 주세요" && chips[2] === "융자·보증" && chips[3] === "AI·딥테크·소프트웨어" && gate, `${chips.join(",")} (기업 유형은 decisions 2번대로 자동으로 채우지 않고 고르기를 먼저 보인다)`);
  await click(fp, "창업·벤처기업", { exact: true });
  await wait(400);
  await openDisclosure(fp, "조건은 어디서 왔나요?");
  const from = await fp.evaluate(() => [...document.querySelectorAll("[role=region]")].find((r) => r.getAttribute("aria-label") === "조건은 어디서 왔나요?")?.innerText.split("\n").filter(Boolean));
  check("F-02", from?.length === 4 && from[3].includes("추정"), from?.join(" / "));
  await fp.waitForSelector("[data-program]");
  const debtCards = await fp.$$eval("section[aria-label='빌리는 돈'] [data-program]", (l) => l.length);
  const debtMore = await text(fp, "section[aria-label='빌리는 돈']");
  check("F-03", debtCards === 5 && /10건 더 보기 \(\d+건 남음\)/.test(debtMore));
  check("F-15", (await text(fp)).includes("기업마당 분류값으로 거른 목록입니다.") && !(await text(fp)).includes("POC"));
  await openDisclosure(fp, "이미 투자한 운용사");
  const existing = await fp.evaluate(() => ({
    inGroup: [...document.querySelectorAll("[data-group=existing] [data-gp]")].map((e) => e.getAttribute("data-gp")),
    all: [...document.querySelectorAll("[data-gp='가나다벤처스']")].length,
  }));
  check("F-04", existing.inGroup.includes("가나다벤처스") && existing.all === 1, existing.inGroup.join(","));
  const t1 = await text(fp);
  check("F-06 (비교 자료 뒤)", !t1.includes("경쟁사 분석으로 가기"), "비교 자료를 이미 받아 표시가 있는 상태");
  await openDisclosure(fp, "거르기와 정렬");
  await click(fp, "운전자금", { exact: true });
  await wait(300);
  check("F-12", (await fp.evaluate(() => [...document.querySelectorAll("button.disclosure")].find((b) => b.textContent.startsWith("거르기와 정렬"))?.textContent)).includes("낱말: 운전자금"));
  await click(fp, "운전자금", { exact: true });
  await fp.$eval("input[placeholder='결과 안에서 찾기']", (e) => e.focus());
  await fp.keyboard.type("파트너스");
  await wait(500);
  const nadara = await fp.$eval("[data-gp='나다라파트너스']", (e) => e.innerText).catch(() => "");
  check("F-05", nadara.includes("나다라파트너스") && !nadara.includes("이미 투자함"));
  await fp.$eval("input[placeholder='결과 안에서 찾기']", (e) => e.select());
  await fp.keyboard.press("Backspace");
  await fp.keyboard.type("타파하");
  await wait(500);
  const tapa = await fp.$eval("[data-gp='타파하인베스트']", (e) => e.innerText).catch(() => "");
  check("F-07", tapa.includes("경쟁사에 투자") && tapa.includes("마바사에 투자한 곳입니다."));
  await fp.$eval("input[placeholder='결과 안에서 찾기']", (e) => e.select());
  await fp.keyboard.press("Backspace");
  await wait(400);
  const card = "[data-program='PBLN_000000000000001']";
  const cardText = await text(fp, card);
  check("F-10", cardText.includes("회사 사업과 관련") && (await fp.$$eval("section[aria-label='빌리는 돈'] [data-program]", (l) => l.some((c) => !c.innerText.includes("회사 사업과 관련")))));
  const closedCard = !cardText.includes("맞는 점");
  await click(fp, "자세히", { within: card });
  check("F-08", closedCard && (await text(fp, card)).includes("맞는 점"));
  const fpText = await text(fp);
  // 판로 갈래의 나라장터 조회(sections/sales)는 무료라 세지 않는다(F-09, 2026-11-23)
  check("F-09", !/공고문으로 자격 대조|운용사 요약|대신 검색해 요약하기/.test(fpText) && count((await getLog()).slice(n0), "POST", /^(?!.*\/sections\/sales$)/) === 0);
  // 담기(C-20)
  const save = (sel) => fp.evaluate((sel) => document.querySelector(`${sel} button[aria-pressed]`).click(), sel);
  await save(card);
  await wait(300);
  const s1 = { p: await fp.$eval(`${card} button[aria-pressed]`, (b) => b.getAttribute("aria-pressed")), bar: await text(fp), nav: await attr(fp, `nav[aria-label=단계] a[href="/c/${CID}/review"]`, "aria-label") };
  await save(card);
  await wait(300);
  const s0 = { bar: await text(fp), nav: await attr(fp, `nav[aria-label=단계] a[href="/c/${CID}/review"]`, "aria-label") };
  check("C-20", s1.p === "true" && s1.bar.includes("담은 항목 1개") && s1.nav === "심사 준비, 담은 항목 1개" && !s0.bar.includes("담은 항목 1개") && s0.nav === "심사 준비", `${s1.nav} → ${s0.nav}`);
  await save(card);
  await save("[data-program='PBLN_000000000000002']");
  await save("[data-group=existing] [data-gp='가나다벤처스']");
  await wait(300);
  // C-23: 단계 메뉴 옆 개수(screens 1.1). 자금 조달 = 거기서 담은 공고·운용사, 심사 준비 = 담은 항목, 0이면 붙이지 않음
  const navNames = await fp.$$eval("nav[aria-label=단계] a", (l) => l.map((a) => a.getAttribute("aria-label") || a.innerText.trim()));
  check("C-23", navNames.join(" / ") === "회사 분석 / 경쟁사 분석, 비교 대상 2곳 / 자금·판로, 담은 후보 3개 / 심사 준비, 담은 항목 3개 / 노트", navNames.join(" / "));
  // C-24: 단계 메뉴 다섯(판로 없음). 넓은 화면은 전체 이름, 390 폭은 짧은 이름이 한 줄에 다 보인다(메뉴 안 가로 밀림 없음)
  {
    const wide = await fp.$$eval("nav[aria-label=단계] li", (l) => l.map((x) => x.innerText.replace(/\d+/g, "").trim()));
    const n390 = await open(`/c/${CID}/funding`, { ctx, width: 390 });
    await n390.waitForSelector("nav[aria-label=단계] li");
    const narrow = await n390.evaluate(() => {
      const nav = document.querySelector("nav[aria-label=단계]");
      return { texts: [...nav.querySelectorAll("li")].map((x) => x.innerText.replace(/\d+/g, "").trim()), over: nav.scrollWidth - nav.clientWidth, names: [...nav.querySelectorAll("li > a, li > [role=link]")].map((x) => x.getAttribute("aria-label")) };
    });
    check("C-24", wide.join() === "회사 분석,경쟁사 분석,자금·판로,심사 준비,노트" && narrow.texts.join() === "회사,경쟁사,자금·판로,심사,노트" && narrow.over <= 0 && narrow.names.every((n, i) => n?.startsWith(wide[i])), `${wide.join()} | ${narrow.texts.join()} 넘침 ${narrow.over}px`);
    await n390.close();
  }
  await globalChecks(fp, "자금·판로 1180");
  {
    const off = await dueAlign(fp);
    check("F-16 (1180)", off.length >= 5 && new Set(off).size === 1 && off[0] >= 0, off.join(","));
  }
  await sh(fp, "funding-1180");
  for (const w of [820, 390]) {
    const pw = await open(`/c/${CID}/funding?lane=invest`, { ctx, width: w });
    await pw.waitForSelector("[role=tablist][aria-label=갈래]");
    const tabs = await pw.$$eval("[role=tablist][aria-label=갈래] [role=tab]", (l) => l.map((t) => `${t.textContent}:${t.getAttribute("aria-selected")}`));
    check(`F-11 (${w})`, tabs.length === 3 && tabs[1].startsWith("투자받는 돈") && tabs[1].endsWith("true") && tabs[2] === "판로:false", tabs.join(","));
    await globalChecks(pw, `자금·판로 ${w}`);
    {
      const off = await dueAlign(pw);
      check(`F-16 (${w})`, off.length >= 5 && new Set(off).size === 1 && off[0] >= 0, off.join(","));
    }
    await sh(pw, `funding-${w}`);
    await pw.close();
  }
  // F-17: 지역이 여럿인 공고(실제 자료에 10개 시·도 공고가 있다)의 지역 꼬리표는 좁은 카드에서도 오른쪽 기한 칸을 덮지 않고 줄을 바꾼다
  for (const w of [390, 820]) {
    const pl = await open(`/c/${CID}/funding`, { ctx, width: w });
    await pl.waitForSelector("[data-program] .lrow-end");
    const r = await pl.evaluate(() => {
      const card = [...document.querySelectorAll("[data-program]")].find((c) => c.querySelector(".lrow-end") && c.querySelectorAll(".lrow-meta > span").length >= 2);
      if (!card) return null;
      const reg = card.querySelectorAll(".lrow-meta > span")[1];
      reg.textContent = "부산, 전남광주, 세종, 강원, 충북, 충남, 전북, 경북, 경남, 제주";
      const a = reg.getBoundingClientRect();
      const e = card.querySelector(".lrow-end").getBoundingClientRect();
      const m = card.querySelector(".lrow-meta").getBoundingClientRect();
      return { overlap: a.right > e.left + 0.5 && a.bottom > e.top && a.top < e.bottom, inMeta: a.right <= m.right + 0.5, h: Math.round(a.height) };
    });
    check(`F-17 (${w})`, Boolean(r && !r.overlap && r.inMeta), JSON.stringify(r));
    // F-19: 신청기간 원문(수시 공고 등, 길이 제한 없음)은 오른쪽 칸 안에서 줄을 바꾸고 카드 밖으로 넘치지 않는다
    const r19 = await pl.evaluate(() => {
      const raw = document.querySelector("[data-program] [data-due-raw]");
      if (!raw) return null;
      raw.textContent = "2020.01.01 ~ 2026.12.31 (예산 소진 시 조기 마감, 세부 일정은 공고문 참조)";
      const card = raw.closest("[data-program]").getBoundingClientRect();
      const end = raw.closest(".lrow-end").getBoundingClientRect();
      const a = raw.getBoundingClientRect();
      return { inCard: a.left >= card.left - 0.5 && a.right <= card.right + 0.5, inEnd: a.right <= end.right + 0.5 && a.left >= end.left - 0.5, lines: Math.round(a.height / 19), pageW: document.documentElement.scrollWidth <= innerWidth };
    });
    check(`F-19 (${w})`, Boolean(r19 && r19.inCard && r19.inEnd && r19.pageW), JSON.stringify(r19));
    await pl.close();
  }
  // F-18: 이미 투자한 운용사가 경쟁사에도 투자했으면 오른쪽 칸에 표시 둘(이미 투자함·경쟁사에 투자)과 결성 연도가 함께 온다.
  // 390 폭, 펼친 "이미 투자한 운용사" 안(좌우 덧댐으로 더 좁음)에서도 왼쪽 "펀드 N개"와 오른쪽 칸이 겹치지 않고 카드 밖으로 넘치지 않는다
  {
    const pg = await open(`/c/${CID}/funding?lane=invest`, { ctx, width: 390 });
    await pg.waitForSelector("[role=tablist][aria-label=갈래]");
    await openDisclosure(pg, "이미 투자한 운용사");
    await pg.waitForSelector("[data-group=existing] [data-gp] .lrow-end");
    const r = await pg.evaluate(() => {
      const card = document.querySelector("[data-group=existing] [data-gp]");
      const end = card.querySelector(".lrow-end");
      if (![...end.querySelectorAll(".tag")].some((t) => t.textContent.includes("경쟁사에 투자"))) {
        const t = document.createElement("span");
        t.className = "tag";
        t.textContent = "경쟁사에 투자";
        end.insertBefore(t, end.lastElementChild);
      }
      const fund = card.querySelector(".lrow-meta > span").getBoundingClientRect();
      const box = card.getBoundingClientRect();
      const parts = [...end.children].map((e) => e.getBoundingClientRect());
      const hit = parts.some((p) => p.left < fund.right - 0.5 && p.right > fund.left + 0.5 && p.top < fund.bottom - 0.5 && p.bottom > fund.top + 0.5);
      const out = [fund, ...parts].some((p) => p.left < box.left - 0.5 || p.right > box.right + 0.5);
      return { tags: end.querySelectorAll(".tag").length, hit, out, fundW: Math.round(fund.width) };
    });
    check("F-18 (390)", Boolean(r && r.tags === 2 && !r.hit && !r.out), JSON.stringify(r));
    await pg.close();
  }

  // F-20: 1180 폭에서 판로는 두 갈래 아래 단이고, 판로 단이 화면에 들어오기 전에는 나라장터를 부르지 않는다(무료지만 열 때만)
  {
    const l0 = (await getLog()).length;
    const pf = await open(`/c/${CID}/funding`, { ctx });
    await pf.waitForSelector("[data-program]");
    await wait(2500);
    const lay = await pf.evaluate(() => {
      const d = document.querySelector("section[aria-label='빌리는 돈']").getBoundingClientRect();
      const e = document.querySelector("section[aria-label='투자받는 돈']").getBoundingClientRect();
      const s = document.getElementById("lane-sales").getBoundingClientRect();
      return { side: Math.abs(d.top - e.top) < 2 && e.left > d.right, below: s.top >= Math.max(d.bottom, e.bottom), line: getComputedStyle(document.querySelector("#lane-sales .lane-sales")).boxShadow.includes("107, 78, 138") };
    });
    const pre = count((await getLog()).slice(l0), "POST", /sections\/sales$/);
    // 판로 단이 화면에 들어오면 1회 부르는 것은 아래 P-01(옛 판로 주소로 열면 판로 단으로 스크롤한다)에서 본다
    check("F-20", lay.side && lay.below && lay.line && pre === 0, `${JSON.stringify(lay)} 판로 단이 보이기 전 나라장터 요청 ${pre}회`);
    await globalChecks(pf, "자금·판로 판로 단 1180");
    await pf.close();
  }
  // ---------------------------------------------------------- 심사 준비
  const rp = await open(`/c/${CID}/review`, { ctx });
  await waitText(rp, "담은 공고 2건");
  check("R-01", (await attr(rp, "#tab-grants", "aria-selected")) === "true");
  const orderIds = await rp.$$eval("[data-notice]", (l) => l.map((x) => x.getAttribute("data-notice")));
  const g0 = await text(rp, "#panel-grants");
  check("R-04", orderIds.join() === "PBLN_000000000000002,PBLN_000000000000001" && g0.includes("공고문으로 자격 대조") && g0.includes("보통 30~50초"));
  check("R-11", g0.includes("6/8개 채움") && !g0.includes("대부분 '확인 필요'"), "지역·기업 유형·설립·업종·직원 수·매출 6칸(필요한 자금·그 밖의 사항은 비어 있음)");
  // 필요한 자금을 넣고 대조
  await click(rp, "회사 정보 수정", { exact: true, within: "#panel-grants" });
  await wait(300);
  await rp.type("#edit-need", "운전자금 3억 원");
  await click(rp, "저장", { exact: true, within: "dialog[open]" });
  await wait(400);
  n0 = (await getLog()).length;
  await ctl({ noticeDelayMs: 5000 });
  await click(rp, "공고문으로 자격 대조", { within: "[data-notice='PBLN_000000000000001']" });
  await wait(400);
  // G-20: 대조가 도는 동안 카드의 경과 초가 매초 바뀌어도 알림 영역 글은 그대로다
  const liveNotice = await liveSamples(rp, 3, 700);
  check("G-20 (공고문 대조 중)", liveNotice.length === 1 && liveNotice[0].includes("공고문을 읽고 있습니다"), liveNotice.join(" // ").slice(0, 200));
  // C-11: 다른 단계로 갔다 와도 진행 표시와 결과가 이어진다
  await click(rp, "노트", { exact: true, within: "nav[aria-label=단계]" });
  await wait(500);
  await click(rp, "심사 준비", { within: "nav[aria-label=단계]" });
  await wait(400);
  const prog = (await text(rp, "[data-notice='PBLN_000000000000001']")).includes("공고문을 읽고 있습니다");
  await waitText(rp, "충족 4", 9000);
  const notices = (await getLog()).slice(n0).filter((x) => x.method === "POST" && /notice\/analyze/.test(x.path));
  check("C-11", prog && notices.length === 1, `진행 표시 ${prog}, 요청 ${notices.length}`);
  check("R-05", notices[0]?.body?.company?.need === "운전자금 3억 원" && /특허/.test(notices[0]?.body?.company?.notes) && /직원 수와 다름/.test(notices[0]?.body?.company?.notes) && notices[0]?.body?.company?.industry === "고친 업종");
  await ctl({ noticeDelayMs: 200 });
  const c1 = await text(rp, "[data-notice='PBLN_000000000000001']");
  check("R-06", c1.includes("대상 아님") && c1.includes("충족 4") && c1.includes("미충족 1") && c1.includes("확인 필요 2"));
  await click(rp, "자세히", { exact: true, within: "[data-notice='PBLN_000000000000001']" });
  const rowsV = await rp.$$eval("[data-notice='PBLN_000000000000001'] [data-rows] > li", (l) => l.map((x) => x.innerText.split("\n")[0].trim().split(" ")[0]));
  const c1o = await text(rp, "[data-notice='PBLN_000000000000001']");
  check("R-07", rowsV.length === 7 && rowsV.join() === "미충족,확인,확인,충족,충족,충족,충족" && c1o.includes("신청 방법·제출 서류 등 2건"), rowsV.join(","));
  await rp.evaluate(() => document.querySelector("[data-notice='PBLN_000000000000001'] [data-rows] .row-btn").click());
  await wait(200);
  check("R-08", (await text(rp, "[data-notice='PBLN_000000000000001']")).includes("“체납 사실이 있는 기업은 제외한다”"));
  const qs = await rp.$$eval("[data-notice='PBLN_000000000000001'] ol > li", (l) => l.length);
  const innerDisc = await rp.$$eval("[data-notice] button.disclosure", (l) => l.length);
  check("R-09", qs === 5 && innerDisc === 0);
  await click(rp, "공고문으로 자격 대조", { within: "[data-notice='PBLN_000000000000002']" });
  await waitText(rp, "대조한 공고 2건", 5000);
  const gl = await text(rp, "#panel-grants");
  await openDisclosure(rp, "부족한 요건");
  const groups = await rp.$$eval("[data-gap-group]", (l) => l.length);
  check("R-10", gl.includes("미충족 2개, 확인 필요 4개 (대조한 공고 2건)") && groups >= 2, `${groups}묶음`);
  // A-25: 담은 공고 중 14일 안 마감(가짜 공고 D-8, D-13)과 대조한 공고의 미충족 요건(2개)을 회사 분석 "지금 확인할 것"에 센다
  {
    const cp = await open(`/c/${CID}`, { ctx: rp.browserContext() });
    await waitText(cp, "지금 확인할 것");
    // 새 페이지라 공고 목록을 받는 동안은 "마감 임박은 공고 목록을 받으면 셉니다"(A-33). 받은 뒤의 개수를 본다
    await cp.waitForFunction(() => (document.querySelector("[data-checknow]")?.innerText ?? "").includes("마감 임박 담은 공고"), { timeout: 8000 }).catch(() => null);
    const ck = await text(cp, "[data-checknow]");
    check("A-25", ck.includes("마감 임박 담은 공고 2건") && ck.includes("D-8") && /미충족\s*요건\s*2개/.test(ck) && !ck.includes("엇갈림") && !ck.includes("미확보"), ck.replace(/\n/g, " "));
    // A-31: 한 화면 안에서(새로고침 없이) 심사 준비 투자 갈래를 본 뒤 회사 분석으로 돌아와 "마감 임박 담은 공고"를 누르면
    // 정책자금·지원사업 갈래가 열린다(Next 가 살려 둔 심사 준비 화면의 예전 갈래가 이기지 않는다)
    await cp.evaluate((cid) => document.querySelector(`nav[aria-label=단계] a[href="/c/${cid}/review"]`)?.click(), CID);
    await cp.waitForSelector("#tab-invest");
    await cp.evaluate(() => document.getElementById("tab-invest")?.click());
    await wait(400);
    const investOn = await attr(cp, "#tab-invest", "aria-selected");
    await cp.evaluate((cid) => document.querySelector(`nav[aria-label=단계] a[href="/c/${cid}"]`)?.click(), CID);
    await cp.waitForSelector("[data-checknow]");
    await wait(300);
    await cp.evaluate(() => [...document.querySelectorAll("[data-checknow] a")].find((a) => a.textContent.includes("마감 임박"))?.click());
    await cp.waitForFunction(() => location.pathname.endsWith("/review"), { timeout: 8000 }).catch(() => null);
    await wait(600);
    const a31 = await cp.evaluate(() => ({ grants: document.getElementById("tab-grants")?.getAttribute("aria-selected"), url: location.search }));
    check("A-31", investOn === "true" && a31.grants === "true" && a31.url === "?tab=grants", `투자 ${investOn} → 정책자금 ${a31.grants}, ${a31.url}`);
    await cp.close();
  }
  // 경쟁사 조건이라면?
  await rp.evaluate(() => [...document.querySelectorAll("[data-notice='PBLN_000000000000001'] .row-btn")].find((b) => b.textContent.includes("경쟁사 조건이라면?")).click());
  await wait(200);
  const opts = await rp.$$eval("[data-notice='PBLN_000000000000001'] select option", (l) => l.map((o) => o.textContent));
  check("R-13", opts.join() === "마바사,하하테크", opts.join());
  check("D-05", opts.slice(0, 2).join() === keys.map((k) => k.replace("rival:", "")).join(), "경쟁사 분석 비교 대상·심사 준비 고르기·요청 본문의 포함 목록");
  // 값을 고치면 이전 값으로 한 대조 표시(R-12)
  await click(rp, "회사 정보 수정", { exact: true, within: "#panel-grants" });
  await wait(300);
  await rp.$eval("#edit-need", (e) => e.select());
  await rp.keyboard.type("운전자금 5억 원");
  await click(rp, "저장", { exact: true, within: "dialog[open]" });
  await wait(500);
  const c12 = await text(rp, "[data-notice='PBLN_000000000000001']");
  check("R-12", c12.includes("이전 회사 값으로 한 대조입니다") && c12.includes("다시 대조") && c12.includes("충족 4"));
  // 상한 도달(R-26)
  await ctl({ notice: "limit" });
  await click(rp, "다시 대조", { exact: true, within: "[data-notice='PBLN_000000000000002']" });
  await wait(800);
  const lim2 = await text(rp, "[data-notice='PBLN_000000000000002']");
  const lim1 = await text(rp, "[data-notice='PBLN_000000000000001']");
  check("R-26", lim2.includes("오늘 호출 상한에 닿아 대조하지 못했습니다.") && !lim1.includes("오늘 호출 상한") && lim1.includes("충족 4"));
  await ctl({ notice: "ok" });
  await globalChecks(rp, "심사 준비 1180");
  await sh(rp, "review-grants-1180");
  // 투자 갈래
  await click(rp, "투자", { within: "[role=tablist]" });
  await wait(300);
  const inv0 = await text(rp, "#panel-invest");
  check("R-16", inv0.includes("이미 투자한 곳입니다."));
  check("R-15 (요약 전)", inv0.includes("운용사 요약") && inv0.includes("보통 10~20초"));
  await ctl({ gpDelayMs: 2600 });
  await click(rp, "운용사 요약", { exact: true, within: "#panel-invest" });
  await wait(300);
  const liveGp = await liveSamples(rp, 3, 700);
  check("G-20 (운용사 요약 중)", liveGp.length === 1 && liveGp[0].includes("자료를 검색하고 있습니다"), liveGp.join(" // ").slice(0, 200));
  await ctl({ gpDelayMs: 200 });
  await waitText(rp, "근거 4개와 검색 결과 보기", 6000);
  const inv1 = await text(rp, "#panel-invest");
  check("R-15", /맞닿는 점[\s\S]*회사 분야와 투자 분야가 맞닿음[\s\S]*회사 단계와 투자 단계가 맞닿음/.test(inv1) && inv1.includes("가짜 질문 2") && (await disclosure(rp, "근거 4개와 검색 결과 보기")) === "false");
  n0 = (await getLog()).length;
  const blocks = await rp.$$eval("[data-evidence] button.disclosure", (l) => l.length);
  for (const t of ["재무·고용 추이", "투자 이력", "특허", "최근 성과", "미팅 전에 정리할 값"]) await openDisclosure(rp, t, "[data-evidence]");
  const lines = await rp.$$eval("[data-evidence] button.disclosure", (l) => l.map((b) => b.innerText.split("\n").filter(Boolean).length));
  const evReq = (await getLog()).slice(n0).filter((x) => !(x.method === "GET" && /^\/api\/analysis\/[0-9a-f]{32}$/.test(x.path)));
  check("R-17", blocks === 5 && lines.every((n) => n === 2) && evReq.length === 0, `${blocks}덩어리 ${lines.join(",")} 요청 ${evReq.map((x) => x.path).join(",")}`);
  const ev = await text(rp, "#evidence");
  check("D-03 (근거 묶음)", /사업연도[^\n]*\(별도\)/.test(ev));
  // R-25(사람 확인 기준의 자동 보조): 근거 묶음 인쇄 모양을 PDF 로 만들면 A4 2쪽 이내이고 다섯 덩어리 제목과 출처 줄이 들어 있다
  // (처음 기준은 1쪽. 차트 글 7pt 이상(PR-06)으로 하며 2쪽 이내로 바꿨다)
  await rp.evaluate(() => (document.body.dataset.print = "evidence"));
  await rp.emulateMediaType("print");
  const evPdf = Buffer.from(await rp.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
  const evPrint = await rp.evaluate(() => [...document.querySelectorAll(".evidence-print .print-only")].map((e) => e.innerText).join("\n"));
  await rp.emulateMediaType("screen");
  await rp.evaluate(() => delete document.body.dataset.print);
  const evPages = (evPdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check("R-25 (자동 보조)", evPages >= 1 && evPages <= 2 && ["재무·고용 추이", "투자 이력", "특허", "최근 성과", "미팅 전에 정리할 값"].every((t) => evPrint.includes(t)) && evPrint.includes("금융위원회 요약재무제표"), `${evPages}쪽`);
  const qGroups = await rp.$$eval("[data-questions] button.disclosure", (l) => l.map((b) => `${b.textContent.trim()}:${b.getAttribute("aria-expanded")}`));
  check("R-20", qGroups.join() === "사업 개요 2:false,매출과 성장 4:false,경쟁 3:false,팀과 운영 3:false,재무 3:false,앞으로의 계획 4:false", qGroups.join());
  const ddGroups = await rp.$$eval("[data-dd] button.disclosure", (l) => l.map((b) => b.textContent.trim()));
  for (const t of ddGroups) await openDisclosure(rp, t, "[data-dd]");
  const ddN = await rp.$$eval("[data-dd-item]", (l) => l.length);
  const ddT = await text(rp, "[data-dd]");
  check("R-23", ddGroups.join() === "재무 5,사업 5,법무 5,운영 3,인사 3,IT 3,ESG 2" && ddN === 26 && !/우선순위|진행 단계|위험/.test(ddT), ddGroups.join());
  check("D-04 (실사 자료)", ddT.includes("투자기관 35곳 (보도)"));
  await openDisclosure(rp, "사업 개요 2", "[data-questions]");
  await rp.evaluate(() => document.querySelector("[data-question=q1] button[aria-pressed]").click());
  await rp.evaluate(() => document.querySelector("[data-question=q1] .row-btn").click());
  await wait(200);
  await rp.type("[data-question=q1] textarea", "메모시험");
  await wait(1200);
  const invAll = await text(rp, "#panel-invest");
  check("R-24", !/통과|탈락|위험도|판정/.test(invAll));
  const rp2 = await open(`/c/${CID}/review?tab=invest`, { ctx });
  if (!(await waitText(rp2, "투자 미팅 예상 질문"))) console.log("R-02 화면:", (await text(rp2)).slice(0, 400), rp2.errors, rp2.url());
  check("R-02", !(await rp2.$eval("#panel-invest", (e) => e.hidden)));
  await openDisclosure(rp2, "사업 개요 2", "[data-questions]");
  await rp2.evaluate(() => document.querySelector("[data-question=q1] .row-btn").click());
  await wait(200);
  check("R-21", (await attr(rp2, "[data-question=q1] button[aria-pressed]", "aria-pressed")) === "true" && !/준비함 \d|\d+\s*\/\s*19|%/.test(await text(rp2, "#panel-invest")));
  const memo = await rp2.$eval("[data-question=q1] textarea", (e) => e.value);
  n0 = (await getLog()).length;
  await click(rp2, "정책자금", { within: "[role=tablist]" });
  await wait(300);
  const kept = await text(rp2, "#panel-grants");
  check("R-14", kept.includes("충족 4") && count((await getLog()).slice(n0), "POST", /notice|brief/) === 0 && (await text(rp2)).length > 0);
  await rp2.close();

  // ---------------------------------------------------------- 자금 조달 판로 갈래(옛 판로 화면, 옛 주소로 열어 넓은 화면에서 판로 단으로 간다)
  n0 = (await getLog()).length;
  const sp = await open(`/c/${CID}/sales`, { ctx });
  await waitText(sp, "입찰공고 12건", 6000);
  // 판로는 자금 조달의 갈래라, 앞의 자금 조달 점검(넓은 화면에서 거르기로 목록이 줄어 판로 단이 화면에 들어옴)에서 먼저 조회됐을 수 있다.
  // 이 방문 전체(main 시작에 기록을 비웠다)에서 처음 검색어로 간 요청이 1회뿐이면 된다
  const salesReq = (await getLog()).filter((x) => x.method === "POST" && /sections\/sales/.test(x.path));
  check("P-01", salesReq.length === 1 && salesReq[0].body.keywords.join() === "가속기,반도체,NPU,AI 서버,추론,데이터센터", `요청 ${salesReq.length}회 ${salesReq.map((x) => x.body?.keywords?.join("/")).join(" | ")}`);
  const bidRows = await sp.$$eval("[data-bids] > li", (l) => l.map((x) => x.innerText));
  const fx = JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-SALES.json", import.meta.url), "utf8")).exchanges[1].response.sections.sales.result.items;
  const rank = { open: 0, upcoming: 1, unknown: 2, closed: 3 };
  const exp = [...fx].sort((a, b) => rank[a.status] - rank[b.status] || (b.relevance === "high") - (a.relevance === "high") || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")).slice(0, 5);
  check("P-03", bidRows.length === 5 && exp.every((b, i) => bidRows[i].includes(b.title)));
  const highs = exp.filter((b) => b.relevance === "high").length;
  const marks = bidRows.filter((r) => r.includes("핵심 낱말 일치")).length;
  const st = await text(sp);
  check("P-04", marks === highs && !/높음|보통/.test(st), `${marks}/${highs}`);
  const limClosed = (await disclosure(sp, "이 목록의 한계")) === "false";
  await openDisclosure(sp, "이 목록의 한계");
  check("P-05", st.includes("입찰 참가 자격(지역 제한, 업종 등록 등)은 공고문에서 확인하세요.") && limClosed && (await sp.evaluate(() => [...document.querySelectorAll("[role=region]")].find((r) => r.getAttribute("aria-label") === "이 목록의 한계")?.querySelectorAll("li").length)) === 3);
  const chipsN = await sp.$$eval("[data-keyword]", (l) => l.length);
  await openDisclosure(sp, "검색어 고치기");
  await sp.evaluate(() => document.querySelector("button[aria-label='검색어 빼기: 가속기']").click());
  n0 = (await getLog()).length;
  await click(sp, "다시 찾기", { exact: true });
  await wait(1000);
  const re2 = (await getLog()).slice(n0).filter((x) => x.method === "POST" && /sections\/sales/.test(x.path));
  check("P-02", chipsN <= 6 && re2.length === 1 && re2[0].body.keywords.join() === "반도체,NPU,AI 서버,추론,데이터센터", `${chipsN}개, 요청 ${re2.map((x) => x.body?.keywords?.join("/")).join(" | ")}`);
  // 판로 지원사업 개수(P-07)
  const today = "2026-11-22";
  const live = JSON.parse(PROGRAMS).filter((p) => finder.notExpired(p, today)).map((p) => finder.withStatus(p, today));
  const prof = { region: "서울", biz: "venture", need: "all", field: "ai" };
  const expCount = (k) => live.filter((p) => p.category === k).map((p) => finder.matchProgram(p, prof)).filter((m) => m.ok).length;
  const tabs = await sp.$$eval("[aria-label='판로 지원사업 갈래'] [role=tab]", (l) => l.map((t) => t.textContent.trim()));
  const salesCards = await sp.$$eval("#sp-h ~ div [data-program]", (l) => l.length);
  check("P-07", tabs[0] === `내수 ${expCount("내수")}` && tabs[1] === `수출 ${expCount("수출")}` && salesCards === Math.min(5, expCount("내수")), `${tabs.join(",")} 카드 ${salesCards}`);
  const firstSales = await sp.$eval("#sp-h ~ div [data-program]", (e) => e.getAttribute("data-program"));
  await sp.evaluate(() => document.querySelector("#sp-h ~ div [data-program] button[aria-pressed]").click());
  await sp.evaluate(() => document.querySelector("[data-bids] .row-btn").click());
  await wait(200);
  const bidTitle = await sp.$eval("[data-bids] > li", (e) => e.innerText.split("\n").find((l) => l.includes("가짜 공고")));
  await click(sp, "노트에 담기", { within: "[data-bids]" });
  await wait(300);
  // C-23: 판로 갈래에서 판로 지원사업 1건과 입찰공고 1건을 더 담으면 자금 조달 5개(입찰공고 포함), 심사 준비 4개(입찰공고 제외)
  check(
    "C-23 (판로)",
    (await attr(sp, `nav[aria-label=단계] a[href="/c/${CID}/funding"]`, "aria-label")) === "자금·판로, 담은 후보 5개" && (await attr(sp, `nav[aria-label=단계] a[href="/c/${CID}/review"]`, "aria-label")) === "심사 준비, 담은 항목 4개",
  );
  await globalChecks(sp, "자금·판로 판로 1180");
  await sh(sp, "sales-1180");
  const rp3 = await open(`/c/${CID}/review`, { ctx });
  await waitText(rp3, "담은 공고 3건");
  check("P-08", Boolean(await rp3.$(`[data-notice='${firstSales}']`)));
  check("P-09 (심사 준비에 없음)", !(await text(rp3)).includes(bidTitle));
  await rp3.close();
  n0 = (await getLog()).length;
  const sp2 = await open(`/c/${CID}/sales`, { ctx });
  await waitText(sp2, "입찰공고");
  // 판로 단이 실제로 화면에 들어온 뒤(조회 조건이 갖춰진 뒤)까지 기다려 센다. 글만 보고 바로 세면 목록을 받기 전이라 요청이 나가기 전에 셀 수 있다
  await sp2.waitForFunction(() => { const r = document.getElementById("lane-sales")?.getBoundingClientRect(); return r && r.top < innerHeight && r.bottom > 0; }, { timeout: 8000 }).catch(() => null);
  await wait(1500);
  check("P-01 (다시 열기)", count((await getLog()).slice(n0), "POST", /sections\/sales/) === 0, `요청 ${count((await getLog()).slice(n0), "POST", /sections\/sales/)}회`);
  await sp2.close();

  // F-11(판로): 820·390 폭 ?lane=sales 로 열면 판로 탭이 골라져 있다. 판로 탭은 나라장터를 부르므로 위 P-01 뒤에 본다
  for (const w of [820, 390]) {
    const ps = await open(`/c/${CID}/funding?lane=sales`, { ctx, width: w });
    await ps.waitForSelector("[role=tablist][aria-label=갈래]");
    const stabs = await ps.$$eval("[role=tablist][aria-label=갈래] [role=tab]", (l) => l.map((t) => `${t.textContent}:${t.getAttribute("aria-selected")}`));
    await waitText(ps, "입찰공고");
    await globalChecks(ps, `자금·판로 판로 ${w}`);
    await sh(ps, `funding-sales-${w}`);
    check(`F-11 (판로 ${w})`, stabs.length === 3 && stabs[2] === "판로:true", stabs.join(","));
    await ps.close();
  }
  // F-21: 옛 판로 주소는 자금 조달 판로 갈래로 간다(820 폭: 판로 탭)
  {
    const po = await open(`/c/${CID}/sales`, { ctx, width: 820 });
    await po.waitForSelector("[role=tablist][aria-label=갈래]");
    const r = await po.evaluate(() => ({ path: location.pathname, q: location.search, sel: [...document.querySelectorAll("[role=tablist][aria-label=갈래] [role=tab]")].find((t) => t.getAttribute("aria-selected") === "true")?.textContent }));
    check("F-21", r.path === `/c/${CID}/funding` && r.q.includes("lane=sales") && r.sel === "판로", JSON.stringify(r));
    await po.close();
  }
  // F-23: 390 폭 판로 탭에서는 빠른 거르기·거르기와 정렬이 없고, 탭을 바꿔도 탭 줄이 움직이지 않는다
  {
    const pt = await open(`/c/${CID}/funding?lane=sales`, { ctx, width: 390 });
    await pt.waitForSelector("[role=tablist][aria-label=갈래]");
    await wait(800);
    const st = () => pt.evaluate(() => ({ tabs: Math.round(document.querySelector("[role=tablist][aria-label=갈래]").getBoundingClientRect().top + scrollY), quick: document.querySelector("[aria-label='빠른 거르기']")?.getBoundingClientRect().height ?? 0 }));
    const a = await st();
    await click(pt, "빌리는 돈", { within: "[role=tablist][aria-label=갈래]" });
    await pt.evaluate(() => window.scrollTo(0, 0));
    await wait(300);
    const b = await st();
    check("F-23", a.quick === 0 && b.quick > 0 && a.tabs === b.tabs, `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    await pt.close();
  }

  // ---------------------------------------------------------- 노트
  const np = await open(`/c/${CID}/note`, { ctx });
  await waitText(np, "회사 핵심 값");
  await wait(500);
  const parts = await np.$$eval("[data-note] [data-part]", (l) => l.map((x) => x.getAttribute("data-part")));
  check("N-01", parts.join() === "head,values,programs,gps,sales,todo,memo,foot", parts.join());
  const vrows = await np.$$eval("[data-part=values] tbody tr", (l) => l.map((r) => ({ w: r.querySelectorAll(".word").length, src: r.querySelectorAll(".text-xs").length, t: r.innerText })));
  check("N-02", vrows.length === 9 && vrows.every((r) => r.w >= 1) && vrows.filter((r) => !r.t.includes("미확보")).every((r) => r.src >= 1));
  check("P-09", (await text(np, "[data-part=sales]")).includes(bidTitle));
  check("R-22", (await text(np, "[data-part=todo]")).includes("메모시험") && memo === "메모시험");
  const lists = await np.evaluate(() => [...document.querySelectorAll("[data-note-list]")].map((u) => ({ n: u.children.length, more: u.nextElementSibling?.textContent ?? "" })));
  check("N-04", lists.every((l) => l.n <= 5) && lists.some((l) => /\d+개 더 보기/.test(l.more)));
  check("N-11", (await text(np, "[data-part=foot]")).includes("회사 분석에 쓴 Liner 호출 19회"));
  check("D-04 (노트)", (await text(np, "[data-part=values]")).includes("투자기관 35곳"));
  check("D-03 (노트)", /매출[^\n]*\n?[^\n]*사업연도, 별도/.test(await text(np, "[data-part=values]")));
  await np.focus("#note-memo");
  await np.keyboard.type("노트 메모 시험");
  const savedShown = await waitText(np, "저장됨", 3000);
  await click(np, "텍스트 복사", { exact: true });
  await wait(300);
  const copied = await np.evaluate(() => window.__copied.at(-1) ?? "");
  check("N-06", copied.split("\n")[0].includes("주식회사 가나다테크") && copied.split("\n")[0].includes("2026-11-22 20:46") && !/<[a-z]/i.test(copied));
  check("C-09", copied.includes("금융위원회 기업기본정보 (공공 API) · 2026-11-22 조회"));
  await click(np, "더 보기", { exact: true });
  await click(np, "회사 분석 주소 복사", { exact: true });
  check("N-07", await waitText(np, "주소를 복사했습니다. 담은 항목과 메모는 주소에 들어가지 않습니다.", 2000));
  await click(np, "더 보기", { exact: true });
  await click(np, "파일로 내보내기", { exact: true });
  await wait(300);
  const dl = await np.evaluate(async () => ({ name: window.__downloads.at(-1), body: window.__lastBlob ? await window.__lastBlob.text() : "" }));
  const ef = JSON.parse(dl.body || "{}");
  check("N-08", dl.name === "성장노트-주식회사 가나다테크-20261122.json" && ef.companyId === CID && ef.edits?.industry && ef.saved?.length >= 3 && Object.keys(ef.checks ?? {}).length >= 1 && ef.notes?.memo?.includes("노트 메모 시험") && !("snapshots" in ef) && !("job" in ef), dl.name);
  const other = `${OUT ?? "/tmp"}/other-company-note.json`;
  writeFileSync(other, JSON.stringify({ ...ef, companyId: "0000000000099", name: "다른가짜회사" }));
  const input = await np.$("input[type=file]");
  await input.uploadFile(other);
  await wait(500);
  check("N-09", (await text(np)).includes("다른 회사(다른가짜회사)의 파일입니다.") && !(await np.$("dialog[open]")));
  // 모양이 어긋난 파일(담은 항목에 null)은 거절하고, 지금 담은 항목·메모를 지우지 않는다
  const savedBefore = await idbCount(np, "saved");
  const broken = `${OUT ?? "/tmp"}/broken-note.json`;
  writeFileSync(broken, JSON.stringify({ ...ef, saved: [null] }));
  await input.uploadFile(broken);
  await wait(500);
  check("N-13", (await text(np)).includes("성장노트에서 내보낸 파일이 아닙니다.") && !(await np.$("dialog[open]")) && savedBefore >= 3 && (await idbCount(np, "saved")) === savedBefore && (await np.$eval("#note-memo", (e) => e.value)) === "노트 메모 시험", `담은 항목 ${savedBefore}`);
  const npr = await open(`/c/${CID}/note`, { ctx });
  await waitText(npr, "회사 핵심 값");
  await wait(500);
  check("N-05", savedShown && (await npr.$eval("#note-memo", (e) => e.value)) === "노트 메모 시험");
  await globalChecks(npr, "노트 1180");
  await sh(npr, "note-1180", true);
  await npr.emulateMediaType("print");
  const printView = await npr.evaluate(() => ({
    hidden: ["header:not([data-part])", "nav[aria-label=단계]", "button.disclosure", "button", "a.btn"].every((s) => [...document.querySelectorAll(s)].every((e) => e.getBoundingClientRect().height === 0)),
    lists: [...document.querySelectorAll("[data-note] ul.print-only")].map((u) => ({ n: u.children.length, last: u.lastElementChild?.textContent ?? "" })),
  }));
  check("PR-01", printView.hidden);
  check("PR-02", printView.lists.every((l) => l.n <= 11) && printView.lists.some((l) => /^외 \d+개$/.test(l.last) || l.n > 5));
  // PR-04(사람 확인 기준의 자동 보조): 노트 인쇄 PDF 가 A4 2쪽 이하. 사이트 바닥글은 인쇄하지 않는다(노트 바닥에 같은 문장이 있어 두 번 나왔다)
  const notePdf = Buffer.from(await npr.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
  const notePages = (notePdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const siteFoot = await npr.evaluate(() => document.querySelector("body > footer")?.getBoundingClientRect().height ?? 0);
  check("PR-04 (자동 보조)", notePages >= 1 && notePages <= 2, `${notePages}쪽, 담은 항목 ${ef.saved?.length ?? 0}개, 대조 ${Object.keys(ef.checks ?? {}).length}건`);
  check("PR-01 (바닥 문장 한 번)", siteFoot === 0 && (await npr.evaluate(() => (document.querySelector("[data-note]")?.innerText.match(/점수나 선정 확률은 만들지 않습니다/g) ?? []).length)) === 1);
  await npr.emulateMediaType("screen");
  const n390 = await open(`/c/${CID}/note`, { ctx, width: 390 });
  await waitText(n390, "회사 핵심 값");
  const btns = await n390.$$eval("main > div.no-print button", (l) => l.filter((b) => b.getBoundingClientRect().height > 0).map((b) => b.textContent.trim()));
  check("N-12", btns.join() === "인쇄·PDF 저장,더 보기", btns.join());
  await globalChecks(n390, "노트 390");
  await sh(n390, "note-390");
  // D-07: 브라우저 자료가 대조·요약 밖의 요청에 실리지 않는다
  const lgAll = await getLog();
  const leaks = lgAll.filter((x) => !/notice\/analyze|gp\/brief/.test(x.path) && JSON.stringify(x.body ?? "").match(/운전자금 [35]억|고친 업종|노트 메모|메모시험/));
  check("D-07", leaks.length === 0, leaks.map((x) => x.path).join(","));
  // G-15: 회전해도 펼친 채
  const rot = await open(`/c/${CID}`, { ctx, width: 820 });
  await waitText(rot, "재무 표 보기");
  await openDisclosure(rot, "재무 표 보기");
  await rot.setViewport({ width: 1180, height: 820 });
  await wait(300);
  const e1 = await disclosure(rot, "재무 표");
  await rot.setViewport({ width: 820, height: 1180 });
  await wait(300);
  check("G-15", e1 === "true" && (await disclosure(rot, "재무 표")) === "true");
  for (const w of [820, 390]) {
    await rot.setViewport({ width: w, height: heightFor(w) });
    await wait(300);
    const d = await rot.$eval("nav[aria-label='단락 목차'] ol", (e) => getComputedStyle(e).flexDirection);
    const stick = await rot.$eval("nav[aria-label='단락 목차']", (e) => getComputedStyle(e).position);
    check(`A-16 (${w})`, d === "row" && stick === "sticky");
  }
  check("A-16 (1180)", tocDir === "column");
  for (const w of [390, 820, 1280]) {
    await rot.setViewport({ width: w, height: heightFor(w) });
    await rot.goto(`${BASE}/c/${CID}`, { waitUntil: "domcontentloaded" });
    await waitText(rot, "검색으로 확인한 특허 11건");
    await wait(400);
    await globalChecks(rot, `회사 분석 ${w}`);
  }
  await ctx.close();
});

// ================================================================ 다른 가짜 응답
await run("variants", async () => {
  await reset({ scenario: "F-CONFLICT" });
  let page = await open(`/c/${CID}`);
  await waitText(page, "다른 자료:");
  const row = await page.evaluate(() => [...document.querySelectorAll("#overview .row-btn")].find((b) => b.innerText.startsWith("설립"))?.innerText ?? "");
  check("C-04", row.includes("2020-09-15") && row.includes("다른 자료: 2021-01") && (row.match(/엇갈림/g) ?? []).length === 1, row.replace(/\n/g, " "));
  // A-26: 엇갈린 값 1개(설립)가 "지금 확인할 것"에 있고, 누르면 두 값과 "개요 단락에서 보기"가 펼쳐지며 링크는 개요 제목으로 간다
  {
    const ck0 = await text(page, "[data-checknow]");
    await page.evaluate(() => document.querySelector("[data-checknow] button[aria-controls=checknow-list]")?.click());
    await wait(200);
    const expanded = await attr(page, "[data-checknow] button[aria-controls=checknow-list]", "aria-expanded");
    const ckList = await text(page, "#checknow-list");
    await page.evaluate(() => document.querySelector("#checknow-list a")?.click());
    await wait(300);
    const focusId = await page.evaluate(() => document.activeElement?.id);
    check("A-26", /엇갈림\s*값 1개/.test(ck0) && !ck0.includes("미확보") && expanded === "true" && ckList.includes("설립") && ckList.includes("2020-09-15") && ckList.includes("다른 자료: 2021-01") && ckList.includes("개요 단락에서 보기") && focusId === "h-overview", `${ck0.replace(/\n/g, " ")} | ${focusId}`);
  }
  check("D-06 (회사 분석)", (await text(page, "#overview")).includes("2021-01"));
  const rp = await open(`/c/${CID}/review?tab=invest`, { ctx: page.browserContext() });
  await waitText(rp, "미팅 전에 정리할 값");
  await openDisclosure(rp, "미팅 전에 정리할 값", "[data-evidence]");
  const ov = await rp.$eval("[data-open-values]", (e) => e.innerText).catch(() => "");
  check("R-19", /설립[\s\S]*2020-09-15[\s\S]*다른 자료: 2021-01/.test(ov));
  const np = await open(`/c/${CID}/note`, { ctx: page.browserContext() });
  await waitText(np, "회사 핵심 값");
  const fr = await np.evaluate(() => [...document.querySelectorAll("[data-part=values] tr")].find((r) => r.innerText.startsWith("업력"))?.innerText ?? "");
  check("N-03", fr.includes("2020-09-15") && fr.includes("2021-01"));
  check("D-06 (노트, 근거 묶음)", fr.includes("2021-01") && ov.includes("2021-01"));
  await reset({ scenario: "F-MONEY" });
  page = await open(`/c/${CID}`);
  await waitText(page, "300억원");
  const tile = await page.evaluate(() => [...document.querySelectorAll("ul[aria-label='핵심 값'] li")].find((l) => l.innerText.startsWith("누적 투자"))?.innerText ?? "");
  check("IN-06", tile.includes("$250.0M") && tile.includes("300억원") && !/\$[\d.]+[MB]\s*\+|합계/.test(tile), tile.replace(/\n/g, " "));
  check("D-02", !(await text(page)).match(/₩|원\s*\(\$|\$[\d.,]+억/));
  // FI-08(사람 확인 기준의 자동 보조): 음수 영업이익 막대가 기준선 아래로 그려지고, 막대 값 글이 연도 글과 겹치지 않는다
  const fi08 = await page.evaluate(() => {
    const svg = document.querySelector("#finance svg[role=img]");
    if (!svg) return null;
    const base = Number(svg.querySelector("line")?.getAttribute("y1"));
    const rects = [...svg.querySelectorAll("rect")].filter((r) => Number(r.getAttribute("width")) > 10 && r.getAttribute("y") !== "4");
    const below = rects.filter((r) => Number(r.getAttribute("y")) >= base - 0.5 && Number(r.getAttribute("height")) > 1).length;
    const box = (t) => t.getBBox();
    const years = [...svg.querySelectorAll("text")].filter((t) => /^\d{4}$/.test(t.textContent.trim())).map(box);
    const values = [...svg.querySelectorAll("text.num")].map(box);
    const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    return { below, overlaps: values.filter((v) => years.some((y) => hit(v, y))).length };
  });
  check("FI-08 (자동 보조)", fi08 && fi08.below >= 1 && fi08.overlaps === 0, JSON.stringify(fi08));
  await sh(page, "money-1180");
  await reset({ scenario: "F-EMPTY" });
  page = await open(`/c/${CID}`);
  const in08 = await waitText(page, "투자 라운드 자료를 찾지 못했습니다. 투자 이력이 없다는 뜻은 아닙니다.");
  const t = await text(page);
  check("IN-08", in08);
  // TE-08: 같은 미확보 상태가 화면마다 같은 말: 기술 단락은 서버 no_data 문장, 핵심 값 칸은 같은 말의 짧은 꼴(2026-11-23 새 이름 기준)
  const te08tile = await page.evaluate(() => [...document.querySelectorAll("ul[aria-label='핵심 값'] li")].find((l) => l.innerText.startsWith("검색으로 확인한 특허"))?.innerText.replace(/\s+/g, " ") ?? "");
  check(
    "TE-08",
    (await text(page, "#tech")).includes("출원인이 이 회사로 확인된 특허를 검색에서 찾지 못했습니다. 검색에 걸리지 않은 특허는 빠집니다.") &&
      te08tile.includes("미확보: 출원인이 확인된 특허를 검색에서 찾지 못함") && !t.includes("국내 특허"),
    te08tile,
  );
  check("NE-08", !/중요 사건 \d+개 더 보기/.test(t));
  const tiles = await page.$$eval("ul[aria-label='핵심 값'] li", (l) => l.map((x) => x.innerText));
  check("C-06", tiles.filter((x) => x.includes("미확보:")).length >= 2 && !tiles.some((x) => /\n(0|-)\n/.test(`\n${x}\n`)));
  // A-35: 특허 값 이름("검색으로 확인한 특허", 2026-11-23)을 바꾼 뒤에도 "지금 확인할 것" 미확보 값의 특허 줄이 기술 단락으로 간다
  // (review.ts openValues 라벨과 Analysis.tsx VALUE_SECTION 키가 같은 PATENT_LABEL)
  {
    await page.evaluate(() => [...document.querySelectorAll("[data-checknow] button[aria-controls=checknow-list]")].find((b) => b.innerText.includes("미확보"))?.click());
    await wait(200);
    const li35 = await page.evaluate(() => {
      const l = [...document.querySelectorAll("#checknow-list li")].find((x) => x.querySelector("span")?.textContent === "검색으로 확인한 특허");
      const a = l?.querySelector("a");
      a?.click();
      return { t: l?.innerText.replace(/\s+/g, " ") ?? "", link: a?.textContent.trim() ?? "" };
    });
    await wait(300);
    const focus35 = await page.evaluate(() => document.activeElement?.id);
    const old35 = await page.evaluate(() => [...document.querySelectorAll("#checknow-list li > span:first-child")].some((s) => s.textContent === "국내 특허"));
    check("A-35", li35.link === "기술 단락에서 보기" && li35.t.includes("미확보:") && focus35 === "h-tech" && !old35, `${li35.t} | ${focus35}`);
  }
  const ep = await open(`/c/${CID}/review?tab=invest`, { ctx: page.browserContext() });
  await waitText(ep, "미팅 근거 묶음");
  const ev = await text(ep, "[data-evidence]");
  check("R-18", (ev.match(/미확보:/g) ?? []).length >= 3);
  // R-18(특허 이름): 미팅 근거 묶음 특허 줄의 미확보 글도 새 이름 기준(옛 "국내 특허" 없음)
  check("R-18 (특허 이름)", ev.includes("미확보: 출원인이 이 회사로 확인된 특허를 검색에서 찾지 못했습니다") && !ev.includes("국내 특허"), ev.replace(/\n/g, " ").slice(0, 200));
  await reset({ scenario: "F-STALE" });
  page = await open(`/c/${CID}/review?tab=invest`);
  await waitText(page, "미팅 근거 묶음");
  check("R-27", (await text(page, "#evidence")).includes("회사 분석 2026-10-08 20:46 기준, 오래된 분석"));
  await reset({ scenario: "F-NOCORP" });
  page = await open("/c/n-d8839daa56981b49");
  await waitText(page, "법인이 확인되지 않아 공식 재무·고용 자료가 없습니다.");
  const fi = await text(page, "#finance");
  check("FI-07", fi.includes("미확보") && fi.includes("법인 다시 고르기"));
  await reset({ scenario: "F-NOCORP", nocorpPhase: 0 });
  page = await open("/c/n-d8839daa56981b49/funding");
  await waitText(page, "회사 분석 값으로 채운 조건");
  const r0 = await page.$eval("label.chip select", (s) => s.value);
  await ctl({ nocorpPhase: 1 });
  const asked = await waitText(page, "조건을 바꿀까요?", 6000);
  const r1 = await page.$eval("label.chip select", (s) => s.value);
  await click(page, "바꾸기", { exact: true });
  await wait(300);
  const r2 = await page.$eval("label.chip select", (s) => s.value);
  check("F-13", r0 === "" && asked && r1 === "" && r2 === "부산", `${r0}→${r1}→${r2}`);
  // F-24: 넓은 화면에서 옛 판로 주소로 새로(새 페이지·새 컨텍스트) 열면 판로 단이 화면 안으로 스크롤되고, 그 방문에서 나라장터 조회가 1회 나간다.
  // (판로 단은 공고 목록을 받은 뒤에 그려져, 첫 그림에서 한 번만 스크롤하면 실패했다. 리뷰 P2)
  {
    await reset({ scenario: "F-FULL" });
    const s0 = (await getLog()).length;
    const ps = await open(`/c/${CID}/sales`, { width: 1180 });
    await ps.waitForSelector("#lane-sales", { timeout: 8000 }).catch(() => null);
    await ps.waitForFunction(() => document.body.innerText.includes("입찰공고 12건"), { timeout: 8000 }).catch(() => null);
    await wait(600);
    const pos = await ps.evaluate(() => {
      const r = document.getElementById("lane-sales")?.getBoundingClientRect();
      return { top: Math.round(r?.top ?? -1), y: Math.round(scrollY), vh: innerHeight, url: location.pathname + location.search };
    });
    const posts = count((await getLog()).slice(s0), "POST", /sections\/sales$/);
    check("F-24", pos.y > 0 && pos.top >= 0 && pos.top < pos.vh && posts === 1 && pos.url.includes("lane=sales"), `${JSON.stringify(pos)} 나라장터 요청 ${posts}회`);
    await ps.browserContext().close();
  }
  await reset({ scenario: "F-FULL", salesPartial: true });
  page = await open(`/c/${CID}/sales`);
  check("P-06", await waitText(page, "일부 기간 조회에 실패했습니다 (2건).", 6000));
  await reset({ scenario: "F-FULL", salesLimit: true });
  page = await open(`/c/${CID}/sales`);
  await waitText(page, "오늘 호출 상한에 닿아 입찰공고를 찾지 못했습니다.", 6000);
  await click(page, "창업·벤처기업", { exact: true });
  await page.waitForSelector("#sp-h ~ div [data-program]", { timeout: 5000 }).catch(() => {});
  check("P-11", (await text(page)).includes("오늘 호출 상한에 닿아 입찰공고를 찾지 못했습니다.") && (await page.$$eval("#sp-h ~ div [data-program], #sp-h ~ div [role=tab]", (l) => l.length)) > 0);
  await reset({ scenario: "F-HTML" });
  page = await open(`/c/${CID}`);
  await waitText(page, "기사");
  await openDisclosure(page, "기사", "#news");
  await waitText(page, "<b>굵게</b>", 5000);
  await openDisclosure(page, "특허", "#tech");
  await page.evaluate(() => document.querySelectorAll("#tech .row-btn").forEach((b) => b.click()));
  await wait(400);
  check("G-13", (await text(page)).includes("<b>굵게</b>") && (await page.evaluate(() => window.__alerts)) === 0 && (await page.$$eval("#tech img, #news b", (l) => l.length)) === 0);
  await reset({ scenario: "F-FULL", fail500: true });
  page = await open("/");
  await page.waitForSelector("#company-name");
  await page.type("#company-name", "가나다테크");
  await click(page, "분석 시작");
  await wait(1000);
  const p2 = await open(`/c/${CID}`, { ctx: page.browserContext() });
  await wait(1500);
  const bad = [await text(page), await text(p2)].join("\n");
  check("G-14", !/Traceback|\/Users\/|API_KEY|\.py\b|KeyError/.test(bad));
  // G-10: 움직임 줄이기
  await reset({ scenario: "F-STAGED", step: 0 });
  page = await open(`/c/${CID}`, { reduced: true });
  await waitText(page, "분석 중");
  const motion = await page.evaluate(() => [...document.querySelectorAll(".chev, .animate-pulse, [class*=animate]")].map((e) => { const s = getComputedStyle(e); return `${s.animationName}|${s.transitionDuration}`; }));
  check("G-10", motion.every((m) => m.startsWith("none|") && (m.endsWith("0s") || m.endsWith("0s, 0s"))), [...new Set(motion)].join(","));
  // RI-15: 예시 회사에 저장된 비교 자료가 있으면 표가 보이고, 받기·다시 받기 단추 대신 안내. 처음 비교 대상으로 비교한 후보가 "포함"이고 "바뀌었습니다"가 없다. 옛 용어(맞음·아님·고른 경쟁사·고르기)가 없다(RI-22)
  {
    await reset({ scenario: "F-EXAMPLE", deep: "two" });
    const ex = await open(`/c/${CID}/rivals`);
    await ex.waitForFunction(() => document.querySelectorAll("table[data-compare=table] thead th").length === 4, { timeout: 8000 }).catch(() => null);
    await wait(500);
    // 비교 자료가 있으면 비교가 먼저이고 비교 대상 정하기는 "비교 대상 n곳" 한 줄로 접혀 있다(RI-19). 펼쳐서 포함이 눌린 후보를 본다
    const summary = await text(ex, "[data-picked-summary]");
    await openDisclosure(ex, "비교 대상", "#compare");
    const r = await ex.evaluate(() => ({
      t: document.querySelector("main")?.innerText ?? "",
      btns: [...document.querySelectorAll("#compare button:not([aria-pressed])")].map((b) => b.textContent.trim()),
      yes: [...document.querySelectorAll("[data-picker-fold] [role=group]")].filter((g) => g.querySelector("button")?.getAttribute("aria-pressed") === "true").map((g) => g.getAttribute("aria-label")),
      nav: document.querySelector('nav[aria-label=단계] a[href$="/rivals"]')?.getAttribute("aria-label"),
    }));
    const posts = count(await getLog(), "POST", /sections\/rivals_deep$/);
    check(
      "RI-15",
      r.t.includes("예시 회사는 비교 자료를 새로 받을 수 없습니다.") && !r.btns.some((b) => b === "비교 자료 받기" || b === "비교 자료 다시 받기") && !r.t.includes("바뀌었습니다") &&
        r.yes.join() === "마바사 비교 대상,하하테크 비교 대상" && r.nav === "경쟁사 분석, 비교 대상 2곳" && posts === 0 && summary === "비교 대상 2곳: 마바사, 하하테크" && !/맞음|아님|고른 경쟁사|고르기|직접 넣기/.test(r.t),
      `${summary} | ${r.btns.join(",")} | ${r.yes.join(",")} | ${r.nav} | 요청 ${posts}회`,
    );
    await sh(ex, "rivals-example-1180");
    await ex.close();
  }
  // RI-19: 비교 대상과 비교 자료가 있으면 "나란히 비교"가 맨 위(첫 화면)이고 비교 대상 정하기는 한 줄로 접힌다. 펼친 안에는 더 여는 것이 없고,
  // 고르기를 바꾸면 그 줄 아래·표 위에 안내가 오며 배치는 바뀌지 않는다. 비교 자료가 없으면 고르기가 먼저 펼쳐져 있다
  {
    await reset({ scenario: "F-FULL", deep: "four" });
    const lens = {};
    for (const w of [390, 1280]) {
      const pg = await open(`/c/${CID}/rivals`, { width: w });
      await pg.waitForSelector("#h-compare");
      await wait(600);
      lens[w] = await pg.evaluate(() => ({ len: document.documentElement.scrollHeight, top: Math.round(document.getElementById("h-compare").getBoundingClientRect().top), pick: Boolean(document.getElementById("pick")), vh: innerHeight }));
      if (w === 1280) {
        const sum = await text(pg, "[data-picked-summary]");
        const closed = (await disclosure(pg, "비교 대상")) === "false";
        await openDisclosure(pg, "비교 대상", "#compare");
        const inner = await pg.evaluate(() => ({ nested: document.querySelectorAll("[data-picker-fold] button.disclosure").length, input: Boolean(document.querySelector("[data-picker-fold] input")), cands: document.querySelectorAll("[data-picker-fold] [role=group]").length }));
        const h0 = lens[w].top;
        await pg.evaluate(() => [...document.querySelectorAll("[data-picker-fold] [role=group]")].find((g) => g.getAttribute("aria-label") === "카타파 비교 대상")?.querySelectorAll("button")[1].click());
        await wait(400);
        const after = await pg.evaluate(() => {
          const fold = document.querySelector("[data-picker-fold]").getBoundingClientRect();
          const rerun = document.querySelector("[data-rerun]")?.getBoundingClientRect();
          const table = document.querySelector("table[data-compare=table]").getBoundingClientRect();
          return { band: Boolean(document.querySelector("[data-changed]")) || document.getElementById("compare").innerText.includes("바뀌었습니다"), between: Boolean(rerun && rerun.top >= fold.bottom - 1 && rerun.bottom <= table.top + 1), top: Math.round(document.getElementById("h-compare").getBoundingClientRect().top), pick: Boolean(document.getElementById("pick")), again: [...document.querySelectorAll("[data-rerun] button")].some((b) => b.textContent.trim() === "비교 자료 다시 받기"), cols: document.querySelectorAll("table[data-compare=table] thead th").length };
        });
        check(
          "RI-19 (비교 먼저)",
          !lens[w].pick && lens[w].top < lens[w].vh && closed && sum === "비교 대상 4곳: 마바사, 아자차랩스, 카타파, 하하테크" && inner.nested === 0 && inner.input && inner.cands === 4 && !after.band && after.between && after.again && after.cols === 6 && after.top === h0 && !after.pick,
          `${JSON.stringify(lens[w])} ${sum} ${JSON.stringify(inner)} ${JSON.stringify(after)}`,
        );
        await globalChecks(pg, "경쟁사 분석 비교 먼저 1280");
      } else {
        // 390 쪽 길이: 같은 가짜 자료(경쟁사 4곳)로 바꾸기 전 6,574px
        check("RI-19 (390 쪽 길이)", !lens[w].pick && lens[w].top < lens[w].vh && lens[w].len <= 4500, JSON.stringify(lens[w]));
        await globalChecks(pg, "경쟁사 분석 비교 먼저 390");
      }
      await pg.close();
    }
    await reset({ scenario: "F-FULL" });
    const pp = await open(`/c/${CID}/rivals`);
    await pp.waitForSelector("#h-compare");
    const order = await pp.evaluate(() => ({ pick: document.getElementById("h-pick")?.getBoundingClientRect().top ?? 1e9, cmp: document.getElementById("h-compare").getBoundingClientRect().top, fold: Boolean(document.querySelector("[data-picked-summary]")) }));
    check("RI-19 (고르기 먼저)", order.pick < order.cmp && !order.fold, JSON.stringify(order));
    await pp.close();
  }
  // RI-20: 비교 자료의 rivalSet 에 후보 밖 열쇠(user:가상다섯째)가 있어도 처음 연 사람의 비교 대상·단계 메뉴 개수·표 열이 비교 자료와 같다
  {
    await reset({ scenario: "F-FULL", deep: "five" });
    const p20 = await open(`/c/${CID}/rivals`);
    await p20.waitForSelector("table[data-compare=table]");
    await wait(500);
    const sum20 = await text(p20, "[data-picked-summary]");
    await openDisclosure(p20, "비교 대상", "#compare");
    const r20 = await p20.evaluate(() => ({
      nav: document.querySelector('nav[aria-label=단계] a[href$="/rivals"]')?.getAttribute("aria-label"),
      cols: document.querySelectorAll("table[data-compare=table] thead th").length - 1,
      extra: [...document.querySelectorAll("[data-picker-fold] li")].find((l) => l.innerText.includes("가상다섯째"))?.innerText ?? "",
      extraYes: [...document.querySelectorAll("[data-picker-fold] [role=group]")].find((g) => g.getAttribute("aria-label") === "가상다섯째 비교 대상")?.querySelector("button")?.getAttribute("aria-pressed"),
    }));
    check("RI-20", sum20.startsWith("비교 대상 5곳:") && sum20.includes("가상다섯째") && r20.nav === "경쟁사 분석, 비교 대상 5곳" && r20.cols === 6 && r20.extra.includes("직접 입력") && r20.extraYes === "true", `${sum20} | ${JSON.stringify(r20)}`);
    await p20.close();
  }
  // RI-21: 비교 대상은 최대 5곳. 다 차면 포함하지 않은 후보의 "포함"과 직접 추가가 막히고 "비교 대상은 최대 5곳입니다."가 보이며, 포함한 곳의 "제외"는 된다.
  // RI-22: 경쟁사 분석 화면 글에 옛 용어(맞음·아님·고른 경쟁사·고른 곳·고르기·직접 넣기)가 없다
  {
    await reset({ scenario: "F-FULL" });
    const pm = await open(`/c/${CID}/rivals`);
    await waitText(pm, "경쟁사 후보 4곳 중 비교 대상 0곳");
    const press = (name, which) => pm.evaluate((name, which) => [...document.querySelectorAll("#pick [role=group]")].find((g) => g.getAttribute("aria-label") === `${name} 비교 대상`)?.querySelectorAll("button")[which === "in" ? 0 : 1].click(), name, which);
    const addOne = async (n) => {
      await pm.evaluate((n) => {
        const i = document.querySelector("#pick form input");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, n);
        i.dispatchEvent(new Event("input", { bubbles: true }));
      }, n);
      await wait(100);
      await click(pm, "추가", { exact: true, within: "#pick" });
    };
    for (const n of ["마바사", "아자차랩스", "카타파", "하하테크"]) await press(n, "in");
    await wait(300);
    await openDisclosure(pm, "경쟁사 직접 추가", "#pick");
    await addOne("가상추가하나");
    await wait(300);
    const st = () => pm.evaluate(() => ({
      // 상한 안내 줄은 늘 있고(role=status, 빈 채) 다 찼을 때만 글이 들어간다. 글이 없으면 null
      max: document.querySelector("[data-rival-max]")?.textContent.trim() || null,
      live: document.querySelector("[data-rival-max]")?.getAttribute("role") ?? null,
      input: document.querySelector("#pick form input")?.disabled,
      add: [...document.querySelectorAll("#pick form button")].find((b) => b.textContent.trim() === "추가")?.disabled,
      nav: document.querySelector('nav[aria-label=단계] a[href$="/rivals"]')?.getAttribute("aria-label"),
      groups: Object.fromEntries([...document.querySelectorAll("#pick [role=group]")].filter((g) => g.getBoundingClientRect().height > 0).map((g) => [g.getAttribute("aria-label"), [...g.querySelectorAll("button")].map((b) => `${b.textContent.trim()}:${b.getAttribute("aria-pressed")}:${b.disabled ? "막힘" : "됨"}`).join("/")])),
      cost: document.getElementById("compare")?.innerText.includes("비교 대상 5곳 기준"),
      t: document.querySelector("main").innerText,
    }));
    const full1 = await st();
    await press("카타파", "out");
    await wait(300);
    const four = await st();
    // RI-23: 키보드로(입력에 쓰고 Enter) 다섯째를 직접 추가하면 입력이 막혀도 초점이 상한 안내 줄로 간다(사라지지 않는다)
    await pm.focus("#pick form input");
    await pm.keyboard.type("가상추가둘");
    await pm.keyboard.press("Enter");
    await wait(400);
    const kb = await pm.evaluate(() => ({ max: document.activeElement?.hasAttribute("data-rival-max") ?? false, role: document.querySelector("[data-rival-max]")?.getAttribute("role"), body: document.activeElement === document.body }));
    check("RI-23", kb.max && kb.role === "status" && !kb.body, JSON.stringify(kb));
    await openDisclosure(pm, "제외한 후보", "#pick");
    const full2 = await st();
    const kata = full2.groups["카타파 비교 대상"] ?? "";
    check(
      "RI-21",
      full1.max === "비교 대상은 최대 5곳입니다." && full1.input && full1.add && full1.nav === "경쟁사 분석, 비교 대상 5곳" && full1.cost &&
        four.max === null && four.live === "status" && !four.input && !four.add &&
        full2.max === "비교 대상은 최대 5곳입니다." && kata === "포함:false:막힘/제외:true:됨" && full2.groups["마바사 비교 대상"] === "포함:true:됨/제외:false:됨" && !full2.t.includes("앞의 5곳만"),
      `${JSON.stringify({ max: full1.max, input: full1.input, add: full1.add, nav: full1.nav })} | 4곳 ${four.max} | ${kata} | ${full2.groups["마바사 비교 대상"]}`,
    );
    const old = ["맞음", "아님", "고른 경쟁사", "고른 곳", "고르기", "직접 넣기"].filter((w) => full2.t.includes(w));
    check("RI-22", old.length === 0 && full2.t.includes("비교 대상 정하기") && full2.t.includes("경쟁사 직접 추가") && full2.t.includes("비교 대상 5곳(경쟁사 후보 4곳 중 3곳, 직접 추가 2곳)"), old.join(",") || "옛 용어 없음");
    await globalChecks(pm, "경쟁사 분석 비교 대상 5곳 1180");
    await sh(pm, "rivals-max-1180", true);
    // RI-24: 이미 직접 추가한 이름을 다시 넣어(아무것도 늘지 않음) 초점 옮김 표시가 남지 않는다 → 그 뒤 후보 "포함"으로 상한이 차도 누른 단추의 초점을 빼앗지 않는다
    await press("마바사", "in"); // 포함을 다시 눌러 풀기 → 4곳(마바사는 아직 안 정함, 같은 목록에 남는다)
    await wait(300);
    await pm.focus("#pick form input");
    await pm.keyboard.type("가상추가하나");
    await pm.keyboard.press("Enter");
    await wait(300);
    const dup = await st();
    await pm.evaluate(() => [...document.querySelectorAll("#pick [role=group]")].find((g) => g.getAttribute("aria-label") === "마바사 비교 대상")?.querySelectorAll("button")[0].focus());
    await pm.keyboard.press("Enter");
    await wait(400);
    const keep = await pm.evaluate(() => {
      const a = document.activeElement;
      return { group: a?.closest("[role=group]")?.getAttribute("aria-label") ?? null, text: a?.textContent.trim() ?? null, pressed: a?.getAttribute("aria-pressed") ?? null, note: a?.hasAttribute("data-rival-max") ?? false, max: document.querySelector("[data-rival-max]")?.textContent.trim() || null };
    });
    check(
      "RI-24",
      dup.max === null && !dup.input && keep.group === "마바사 비교 대상" && keep.text === "포함" && keep.pressed === "true" && !keep.note && keep.max === "비교 대상은 최대 5곳입니다.",
      `같은 이름 다시 추가 후 ${dup.max} | ${JSON.stringify(keep)}`,
    );
    await pm.close();
  }
  // RI-16: 경쟁사 5곳 비교 표. 820 폭은 표 상자 안에서만 옆으로 밀리고 첫 열이 붙어 있으며, 모든 폭에서 문서 가로 넘침·작은 누르는 곳이 없다
  {
    await reset({ scenario: "F-FULL", deep: "five" });
    for (const w of [390, 820, 1180, 1280]) {
      const r5 = await open(`/c/${CID}/rivals`, { width: w });
      await r5.waitForFunction(() => document.querySelector("[data-compare=items] li, table[data-compare=table] td"), { timeout: 8000 }).catch(() => null);
      await wait(500);
      await globalChecks(r5, `경쟁사 분석 5곳 ${w}`);
      if (w === 820) {
        const sc = await r5.evaluate(async () => {
          const box = document.querySelector("[data-compare-scroll]");
          const over = box.scrollWidth - box.clientWidth;
          box.scrollLeft = 240;
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          const first = box.querySelector("tbody th").getBoundingClientRect().left - box.getBoundingClientRect().left;
          return { over, first: Math.round(first), page: document.documentElement.scrollWidth - document.documentElement.clientWidth, focusable: box.tabIndex === 0, hint: Boolean(document.querySelector("[data-compare-more]")) };
        });
        check("RI-16 (820 표 밀기)", sc.over > 0 && Math.abs(sc.first) <= 1 && sc.page <= 1 && sc.focusable && sc.hint, JSON.stringify(sc));
        await sh(r5, "rivals-five-820", true);
      }
      if (w === 1280) {
        const fit = await r5.evaluate(() => {
          const box = document.querySelector("[data-compare-scroll]");
          return box.scrollWidth - box.clientWidth;
        });
        check("RI-16 (1280 5곳 한 화면)", fit <= 1 && !(await r5.$("[data-compare-more]")), `${fit}px`);
      }
      await r5.close();
    }
  }
  // RI-25~RI-29: 나란히 비교 칸의 원문 링크(screens 4B.2). 받은 주소가 있는 칸만, http·https 만, 링크 이름에 회사·항목, "원문 n건"은 표 아래 목록으로
  {
    /** 표 칸마다 링크(보이는 글은 화면 읽기 전용 글을 뺀 것) */
    const cellLinksOf = (pg) =>
      pg.evaluate(() => {
        const vis = (a) => {
          const c = a.cloneNode(true);
          c.querySelectorAll(".sr-only").forEach((x) => x.remove());
          return c.textContent.replace(/\s+/g, " ").trim();
        };
        const t = document.querySelector("table[data-compare=table]");
        const heads = [...t.querySelectorAll("thead th")].map((c) => c.innerText.split("\n")[0].trim());
        return [...t.querySelectorAll("tbody tr")].flatMap((r) =>
          [...r.querySelectorAll("td")].map((td, i) => ({
            row: r.querySelector("th").innerText.trim(),
            col: heads[i + 1],
            text: td.innerText,
            links: [...td.querySelectorAll("a")].map((a) => ({ vis: vis(a), name: a.textContent.replace(/\s+/g, " ").trim(), href: a.getAttribute("href"), target: a.target, rel: a.rel, line: a.closest("span.block")?.innerText ?? "" })),
          })),
        );
      });
    const linkMap = (cells) => cells.filter((c) => c.links.length).map((c) => `${c.col}/${c.row}:${c.links.map((l) => l.vis).join("+")}`).sort().join(" | ");
    const waitTable = (pg) => pg.waitForFunction(() => document.querySelector("table[data-compare=table] td"), { timeout: 8000 }).catch(() => null);

    await reset({ scenario: "F-FULL", deep: "two" });
    const lp = await open(`/c/${CID}/rivals`, { width: 1180 });
    await waitTable(lp);
    await wait(400);
    const cells = await cellLinksOf(lp);
    const want = [
      "마바사/검색으로 확인한 특허:원문 6건", "마바사/누적 투자:원문 2건", "마바사/주요 투자자:원문 2건", "마바사/최근 라운드:원문 열기",
      "주식회사 가나다테크/검색으로 확인한 특허:원문 11건", "주식회사 가나다테크/주요 투자자:원문 3건",
    ].sort().join(" | ");
    const ext = cells.flatMap((c) => c.links).filter((l) => /^https?:/.test(l.href ?? ""));
    check(
      "RI-25",
      linkMap(cells) === want && cells.every((c) => c.links.length <= 1) && ext.length === 1 && ext.every((l) => l.target === "_blank" && l.rel.includes("noopener") && l.rel.includes("noreferrer")),
      linkMap(cells),
    );
    // RI-26: 링크 이름, "원문 6건" → 접힌 "칸별 원문 25건 보기"가 펼쳐지고 초점이 그 칸 목록 머리로
    const names = cells.flatMap((c) => c.links.map((l) => l.name));
    const before26 = await disclosure(lp, "칸별 원문 25건 보기");
    await lp.evaluate(() => [...document.querySelectorAll("table[data-compare=table] a")].find((a) => a.textContent.startsWith("마바사 검색으로 확인한 특허"))?.click());
    await wait(400);
    const j26 = await lp.evaluate(() => {
      const h = document.activeElement;
      const r = h?.getBoundingClientRect();
      const list = h?.closest("[data-links-item]")?.querySelectorAll("ul a") ?? [];
      return { id: h?.id, t: h?.textContent.replace(/\s+/g, " ").trim(), top: Math.round(r?.top ?? -1), bottom: Math.round(r?.bottom ?? -1), vh: innerHeight, n: list.length, blank: [...list].every((a) => a.target === "_blank" && /^https:\/\//.test(a.getAttribute("href"))) };
    });
    const after26 = await disclosure(lp, "칸별 원문 25건");
    // 머리 옆 "표로 돌아가기" → 누른 칸 링크로 초점이 돌아온다
    await lp.evaluate(() => document.querySelector("[data-back-to-table]")?.click());
    await wait(400);
    const b26 = await lp.evaluate(() => {
      const a = document.activeElement;
      const r = a?.getBoundingClientRect();
      return { t: a?.textContent.replace(/\s+/g, " ").trim().slice(0, 20), inView: Boolean(r && r.top >= 49 && r.bottom <= innerHeight), btn: Boolean(document.querySelector("[data-back-to-table]")) };
    });
    check(
      "RI-26",
      names.includes("마바사 검색으로 확인한 특허 원문 6건, 표 아래 목록으로 이동") && names.some((n) => /^마바사 최근 라운드 원문 열기 ?\(새 창\)$/.test(n)) &&
        before26 === "false" && after26 === "true" && j26.id === "cmp-src-1-patents" && j26.t.startsWith("마바사 검색으로 확인한 특허 원문 6건") && j26.top >= 49 && j26.bottom <= j26.vh && j26.n === 6 && j26.blank &&
        b26.t.startsWith("마바사 검색으로 확인한 특허") && b26.inView && !b26.btn,
      `${before26}→${after26} ${JSON.stringify(j26)} 돌아가기 ${JSON.stringify(b26)}`,
    );
    await globalChecks(lp, "경쟁사 분석 원문 목록 1180");
    await lp.close();

    // RI-27: http·https 가 아닌 주소와 원문 링크 칸 전(patents.items 없음) 비교 자료 → 링크 없음, 값은 그대로
    const fxR = JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-RIVALS.json", import.meta.url), "utf8")).exchanges.find((e) => e.method === "GET").response.sections.rivals_deep;
    const env27 = structuredClone(fxR);
    const [m27] = env27.result.rivals;
    m27.patents.items[0].url = "javascript:alert(1)";
    m27.patents.items[1].url = "data:text/html,x";
    m27.funding.rounds[0].sources[1].url = "javascript:alert(2)"; // 최근 라운드(시리즈 C)의 기사 주소
    const oldRival = { ...structuredClone(m27), key: "rival:카타파", name: "카타파", nameEn: null };
    delete oldRival.patents.items;
    delete oldRival.summary.inputArticles;
    env27.result.rivals = [m27, oldRival];
    env27.result.rivalSet = ["rival:마바사", "rival:카타파"];
    await reset({ scenario: "F-FULL", overrides: { rivals_deep: env27 } });
    const lp27 = await open(`/c/${CID}/rivals`, { width: 1180 });
    await waitTable(lp27);
    await wait(400);
    const c27 = await cellLinksOf(lp27);
    const at = (col, row) => c27.find((c) => c.col === col && c.row === row) ?? { links: [], text: "" };
    const bad27 = await lp27.evaluate(() => [...document.querySelectorAll("a[href]")].filter((a) => /^(javascript|data):/i.test(a.getAttribute("href").trim())).length);
    check(
      "RI-27",
      bad27 === 0 && at("마바사", "검색으로 확인한 특허").links.map((l) => l.vis).join() === "원문 4건" && at("마바사", "최근 라운드").links.length === 0 &&
        at("마바사", "누적 투자").links.map((l) => `${l.vis}@${l.href}`).join() === "원문 열기@https://example.com/news/rival/round/m2" &&
        at("카타파", "검색으로 확인한 특허").links.length === 0 && at("카타파", "검색으로 확인한 특허").text.includes("6건") && at("카타파", "검색으로 확인한 특허").text.includes("Google Patents") && at("카타파", "누적 투자").links.length === 1,
      linkMap(c27),
    );
    await lp27.close();

    // RI-28: 엇갈린 설립 칸은 주소가 있는 값(기사 2021-01) 줄에만 "원문 열기"
    await reset({ scenario: "F-CONFLICT", deep: "two" });
    const lp28 = await open(`/c/${CID}/rivals`, { width: 1180 });
    await waitTable(lp28);
    await wait(400);
    const f28 = (await cellLinksOf(lp28)).find((c) => c.col === "주식회사 가나다테크" && c.row === "설립") ?? { links: [], text: "" };
    check("RI-28", f28.text.includes("2020-09-15") && f28.links.length === 1 && f28.links[0].vis === "원문 열기" && f28.links[0].line.includes("2021-01") && !f28.links[0].line.includes("2020-09-15"), JSON.stringify(f28.links));
    await lp28.close();

    // RI-29: 390 항목 덩어리에도 같은 링크. 인쇄에서는 칸 링크를 숨기고, 끌어 복사해도 링크 글은 따라가지 않는다
    await reset({ scenario: "F-FULL", deep: "two" });
    const lp29 = await open(`/c/${CID}/rivals`, { width: 390 });
    await lp29.waitForSelector("[data-compare=items]");
    await wait(400);
    const blk = await lp29.evaluate(() => {
      const li = (n) => [...document.querySelectorAll("[data-item-block=patents] li")].find((l) => l.getAttribute("data-company") === n);
      const vis = (a) => {
        if (!a) return null;
        const c = a.cloneNode(true);
        c.querySelectorAll(".sr-only").forEach((x) => x.remove());
        return c.textContent.replace(/\s+/g, " ").trim();
      };
      const a = li("마바사")?.querySelector("a");
      return { mine: vis(li("주식회사 가나다테크")?.querySelector("a")), rival: vis(a), select: a ? getComputedStyle(a).userSelect : null };
    });
    await globalChecks(lp29, "경쟁사 분석 원문 링크 390");
    await lp29.emulateMediaType("print");
    const pr = await lp29.evaluate(() => ({
      shown: [...document.querySelectorAll("#compare a.cell-link")].filter((a) => getComputedStyle(a).display !== "none").length,
      value: document.querySelector("[data-item-block=patents]")?.innerText.includes("6건") ?? false,
    }));
    await lp29.emulateMediaType(null);
    check("RI-29", blk.mine === "원문 11건" && blk.rival === "원문 6건" && blk.select === "none" && pr.shown === 0 && pr.value, `${JSON.stringify(blk)} 인쇄 ${JSON.stringify(pr)}`);
    await sh(lp29, "rivals-links-390", true);
    await lp29.close();
  }
  // RI-30~RI-32: 특허 줄 이름 "검색으로 확인한 특허"와 표 아래 "항목별 한계"(screens 4B.2, 2026-11-23 사용자 지시)
  {
    const LIMITS = ["매출", "국민연금 가입자", "누적 투자·최근 라운드·주요 투자자", "검색으로 확인한 특허", "설립"];
    const waitTable = (pg) => pg.waitForFunction(() => document.querySelector("table[data-compare=table] td"), { timeout: 8000 }).catch(() => null);
    /** 표(640 이상) 또는 항목 덩어리(640 미만) 뒤의 보이는 펼치기 줄 글(순서대로)과, 표 끝에서 첫 펼치기 줄까지 거리 */
    const below = (pg) =>
      pg.evaluate(() => {
        const vis = (e) => e.getBoundingClientRect().height > 0;
        const anchor = [document.querySelector("[data-compare-scroll]"), document.querySelector("[data-compare=items]")].find((e) => e && vis(e));
        const after = [...document.querySelectorAll("#compare button.disclosure")].filter(
          (b) => vis(b) && !anchor.contains(b) && anchor.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
        const base = document.querySelector("#compare p.source");
        return {
          texts: after.map((b) => b.textContent.trim()),
          limitsOpen: after[0]?.getAttribute("aria-expanded"),
          gap: Math.round((after[0]?.getBoundingClientRect().top ?? 0) - anchor.getBoundingClientRect().bottom),
          baseBetween: Boolean(base && anchor.compareDocumentPosition(base) & Node.DOCUMENT_POSITION_FOLLOWING && base.compareDocumentPosition(after[0]) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      });
    /** 펼친 한계 목록: 항목 이름(dt), 한 줄 글(끌어 복사와 같은 글), 선택해 복사한 글 */
    const limitsOf = (pg, sel) =>
      pg.evaluate((sel) => {
        const box = document.querySelector(sel);
        const items = [...(box?.querySelectorAll("[data-limit]") ?? [])].filter((e) => e.getBoundingClientRect().height > 0);
        const dl = box?.querySelector("dl");
        let copied = "";
        if (dl && items.length) {
          const r = document.createRange();
          r.selectNodeContents(dl);
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(r);
          copied = s.toString();
          s.removeAllRanges();
        }
        return { labels: items.map((e) => e.querySelector("dt").textContent), lines: items.map((e) => e.innerText), copied, font: items[0] ? parseFloat(getComputedStyle(items[0]).fontSize) : 0 };
      }, sel);
    /** 글 줄 수(줄 상자 top 이 다른 수) */
    const lineCount = (pg, sel) =>
      pg.evaluate((sel) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().height > 0);
        if (!el) return -1;
        const r = document.createRange();
        r.selectNodeContents(el);
        return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
      }, sel);

    await reset({ scenario: "F-FULL", deep: "two" });
    const lw = await open(`/c/${CID}/rivals`, { width: 1180 });
    await waitTable(lw);
    await wait(400);
    // RI-30: 줄 이름·칸 기준 글·원문 목록 머리·출처 줄·그림 제목이 모두 새 이름이고, "국내 특허"가 화면에 남지 않는다
    const row30 = await lw.evaluate(() => {
      const tr = document.querySelector("table[data-compare=table] tr[data-item-row=patents]");
      return { head: tr?.querySelector("th").innerText.trim(), mine: tr?.querySelectorAll("td")[0]?.innerText ?? "", rival: tr?.querySelectorAll("td")[1]?.innerText ?? "", third: tr?.querySelectorAll("td")[2]?.innerText ?? "" };
    });
    for (const t of ["항목별 한계", "칸별 원문", "항목별 출처", "그림으로 보기"]) await openDisclosure(lw, t, "#compare");
    const all30 = await text(lw, "#compare");
    const listHead = await lw.$eval("#cmp-src-0-patents", (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
    check(
      "RI-30",
      row30.head === "검색으로 확인한 특허" && row30.mine.includes("11건") && row30.mine.includes("출원인 확인, 등록 8건") && row30.rival.includes("6건") && /출원인 확인, 등록 \d+건/.test(row30.rival) &&
        row30.third.includes("출원인이 확인된 특허를 검색에서 찾지 못함") && !/\b0건/.test(row30.third) && listHead.startsWith("주식회사 가나다테크 검색으로 확인한 특허 원문 11건") &&
        all30.includes("검색으로 확인한 특허: 특허 공개 원문 (Google Patents)") && all30.includes("출원연도별 검색으로 확인한 특허") && !all30.includes("국내 특허"),
      `${JSON.stringify(row30).replace(/\\n/g, " ")} | ${listHead}`,
    );
    // RI-31(1180): 표 아래 첫 펼치기 줄이 한계(접힘)이고 그다음 칸별 원문·출처. 한계 다섯 항목, 출처 다섯 줄에는 한계 문구가 없다
    await lw.close();
    const l31 = await open(`/c/${CID}/rivals`, { width: 1180 });
    await waitTable(l31);
    await wait(400);
    const b31 = await below(l31);
    await openDisclosure(l31, "항목별 한계", "#compare");
    const lim31 = await limitsOf(l31, "[data-compare-limits]");
    await openDisclosure(l31, "항목별 출처", "#compare");
    const src31 = await l31.evaluate(() => {
      const b = [...document.querySelectorAll("#compare button.disclosure")].find((x) => x.textContent.trim().startsWith("항목별 출처"));
      return [...document.getElementById(b.getAttribute("aria-controls")).querySelectorAll(".source")].map((e) => e.innerText.trim());
    });
    const limitWords = /직원 수|다를 수|아닙니다|빠지|달라질/;
    check(
      "RI-31",
      b31.texts.join("|") === "항목별 한계 5줄 보기|칸별 원문 25건 보기|항목별 출처 5줄 보기|그림으로 보기" && b31.limitsOpen === "false" && b31.baseBetween && b31.gap <= 120 &&
        lim31.labels.join("|") === LIMITS.join("|") && lim31.lines.every((l, i) => !l.includes("\n") && l.startsWith(`${LIMITS[i]} `)) && lim31.font >= 15 &&
        lim31.lines[1].includes("직원 수(상시근로자 수)와 다릅니다") && lim31.lines[3].includes("전체 특허 수가 아닙니다") &&
        src31.length === 5 && src31.every((s) => !limitWords.test(s)),
      `${b31.texts.join("|")} 거리 ${b31.gap}px | ${lim31.labels.join(",")} | 출처 ${src31.length}줄`,
    );
    await globalChecks(l31, "경쟁사 분석 한계 1180");
    await sh(l31, "rivals-limits-1180", false);
    // RI-32: 끌어 복사하면 한계가 항목마다 "{항목} {한계}" 한 줄. 인쇄에서는 접혀 있어도 한계 다섯 항목이 한 번만 찍히고 펼치기 줄은 없다
    const copied = lim31.copied.split("\n").map((x) => x.trim()).filter(Boolean);
    const printed = async (pg) => {
      await pg.emulateMediaType("print");
      const r = await pg.evaluate(() => {
        const shown = (e) => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== "hidden";
        return {
          items: [...document.querySelectorAll("#compare [data-limit]")].filter(shown).map((e) => e.querySelector("dt").textContent),
          head: [...document.querySelectorAll("[data-compare-limits-print] p")].filter(shown).map((e) => e.textContent).join(),
          button: [...document.querySelectorAll("#compare button.disclosure")].filter((b) => shown(b) && b.textContent.includes("한계")).length,
          table: Boolean(document.querySelector("table[data-compare=table]")?.getBoundingClientRect().height),
        };
      });
      await pg.emulateMediaType(null);
      return r;
    };
    const pOpen = await printed(l31);
    await l31.close();
    const l32 = await open(`/c/${CID}/rivals`, { width: 1180 });
    await waitTable(l32);
    await wait(400);
    const pClosed = await printed(l32);
    const onScreen = await l32.evaluate(() => [...document.querySelectorAll("[data-compare-limits-print]")].every((e) => getComputedStyle(e).display === "none"));
    await l32.close();
    const okPrint = (p) => p.items.join("|") === LIMITS.join("|") && p.head === "항목별 한계" && p.button === 0 && p.table;
    check(
      "RI-32",
      copied.length === 5 && copied.every((l, i) => l.startsWith(`${LIMITS[i]} `)) && okPrint(pClosed) && okPrint(pOpen) && onScreen,
      `복사 ${copied.length}줄 | 인쇄(접힘) ${JSON.stringify(pClosed)} | 인쇄(펼침) ${JSON.stringify(pOpen)}`,
    );
    // RI-30(좁은 폭 줄 이름): 820 표의 붙은 첫 열에서 "검색으로 확인한 특허"는 두 줄 이하(옆 "국민연금 가입자"와 같은 줄 수), 390 항목 덩어리 제목은 한 줄.
    // RI-31(390): 항목 덩어리 아래 첫 펼치기 줄이 한계
    const l820 = await open(`/c/${CID}/rivals`, { width: 820 });
    await waitTable(l820);
    await wait(400);
    const n820 = { pat: await lineCount(l820, "tr[data-item-row=patents] th"), nps: await lineCount(l820, "tr[data-item-row=nps] th") };
    await globalChecks(l820, "경쟁사 분석 한계 820");
    await l820.close();
    const l390 = await open(`/c/${CID}/rivals`, { width: 390 });
    await l390.waitForSelector("[data-compare=items]");
    await wait(400);
    const n390 = await lineCount(l390, "[data-item-block=patents] h3");
    const b390 = await below(l390);
    await openDisclosure(l390, "항목별 한계", "#compare");
    const lim390 = await limitsOf(l390, "[data-compare-limits]");
    await globalChecks(l390, "경쟁사 분석 한계 390");
    await sh(l390, "rivals-limits-390", true);
    await l390.close();
    check(
      "RI-30 (좁은 폭 줄 이름)",
      n820.pat >= 1 && n820.pat <= 2 && n820.pat <= n820.nps && n390 === 1,
      `820 표 첫 열 ${n820.pat}줄(국민연금 가입자 ${n820.nps}줄), 390 덩어리 제목 ${n390}줄`,
    );
    check(
      "RI-31 (390)",
      b390.texts[0] === "항목별 한계 5줄 보기" && b390.limitsOpen === "false" && b390.baseBetween && b390.gap <= 120 && lim390.labels.join("|") === LIMITS.join("|"),
      `${b390.texts.join("|")} 거리 ${b390.gap}px`,
    );

    // RI-33: 투자 칸의 짧은 출처 글은 그 칸 원문 링크와 같은 라운드에서 만든다(2026-11-23 사용자 지시, 공개 서버 예시 회사에서 찾음).
    // 마바사 최근 라운드(시리즈 C)와 보인 투자기관이 든 라운드는 People Data Labs 만, 기사는 다른 라운드(시리즈 B)에만 둔다
    const env33 = structuredClone(JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-RIVALS.json", import.meta.url), "utf8")).exchanges.find((e) => e.method === "GET").response.sections.rivals_deep);
    const [r0, r1] = env33.result.rivals[0].funding.rounds;
    r0.sources = r0.sources.filter((x) => x.type === "Premium");
    r1.investors = ["다른 가짜 투자사"];
    await reset({ scenario: "F-FULL", overrides: { rivals_deep: env33 } });
    const l33 = await open(`/c/${CID}/rivals`, { width: 1180 });
    await waitTable(l33);
    await wait(400);
    const c33 = await l33.evaluate(() =>
      Object.fromEntries(
        ["funding", "latest", "investors"].map((k) => {
          const td = document.querySelectorAll(`table[data-compare=table] tr[data-item-row=${k}] td`)[1];
          const src = [...(td?.querySelectorAll(".text-xs.text-sub") ?? [])].map((e) => e.textContent).find((t) => /People Data Labs|기사/.test(t)) ?? "";
          return [k, { src, links: td?.querySelectorAll("a").length ?? -1 }];
        }),
      ),
    );
    await l33.close();
    check(
      "RI-33",
      c33.latest.src === "People Data Labs" && c33.latest.links === 0 && c33.investors.src === "People Data Labs" && c33.investors.links === 0 &&
        c33.funding.src === "People Data Labs, 기사" && c33.funding.links === 1,
      JSON.stringify(c33),
    );
  }
  // F-22: 같은 수출 공고가 빌리는 돈(필요한 지원: 수출·해외진출 지원)과 판로 갈래 수출에 함께 나올 때 담기 상태가 하나다
  {
    await reset({ scenario: "F-FULL" });
    const fs = await open(`/c/${CID}/funding`);
    await waitText(fs, "기업 유형을 골라 주세요");
    await click(fs, "창업·벤처기업", { exact: true });
    await fs.waitForSelector("[data-program]");
    await fs.evaluate(() => {
      const sel = [...document.querySelectorAll("label.chip select")].find((x) => x.getAttribute("aria-label") === "필요한 지원");
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      set.call(sel, "export");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait(400);
    await fs.evaluate(() => document.getElementById("lane-sales").scrollIntoView());
    await click(fs, "수출", { within: "#lane-sales [aria-label='판로 지원사업 갈래']" });
    await wait(400);
    const target = await fs.evaluate(() => {
      const debt = new Set([...document.querySelectorAll("section[aria-label='빌리는 돈'] [data-program]")].map((e) => e.getAttribute("data-program")));
      const sales = [...document.querySelectorAll("#lane-sales [data-program]")].map((e) => ({ id: e.getAttribute("data-program"), title: e.querySelector("h3").textContent }));
      return sales.find((x) => debt.has(x.id)) ?? sales[0] ?? null;
    });
    if (target && !(await fs.$(`section[aria-label='빌리는 돈'] [data-program='${target.id}']`))) {
      // 빌리는 돈 첫 5장에 없으면 결과 안에서 찾기로 그 공고를 앞으로 꺼낸다
      await openDisclosure(fs, "거르기와 정렬");
      await fs.type("input[placeholder='결과 안에서 찾기']", target.title.slice(0, 12));
      await wait(500);
    }
    const st = () => fs.evaluate((id) => [...document.querySelectorAll(`[data-program='${id}'] button[aria-pressed]`)].map((b) => b.getAttribute("aria-pressed")), target?.id);
    const navReview = () => attr(fs, `nav[aria-label=단계] a[href="/c/${CID}/review"]`, "aria-label");
    await fs.evaluate((id) => document.querySelector(`section[aria-label='빌리는 돈'] [data-program='${id}'] button[aria-pressed]`)?.click(), target?.id);
    await wait(400);
    const on = { s: await st(), nav: await navReview() };
    await fs.evaluate((id) => document.querySelector(`#lane-sales [data-program='${id}'] button[aria-pressed]`)?.click(), target?.id);
    await wait(600);
    const off = { s: await st(), nav: await navReview() };
    check("F-22", Boolean(target) && on.s.length === 2 && on.s.every((x) => x === "true") && on.nav === "심사 준비, 담은 항목 1개" && off.s.every((x) => x === "false") && !off.nav?.includes("개"), `${target?.id} ${JSON.stringify(on)} → ${JSON.stringify(off)}`);
    await fs.close();
  }
  // 시작·/funding·확정 화면 폭별 공통 점검
  await reset({ scenario: "F-FULL", example: true });
  for (const w of [390, 820, 1180, 1280]) {
    const sp = await open("/", { width: w });
    await waitText(sp, "예시 회사로 보기");
    await globalChecks(sp, `시작 ${w}`);
    const fp = await open("/funding", { width: w, ctx: sp.browserContext() });
    await fp.waitForSelector("[data-program]");
    await globalChecks(fp, `자금 둘러보기 ${w}`);
    await sp.browserContext().close();
  }
});

// ================================================================ 회사 없이 자금 둘러보기(F0), 빈 상태
await run("browse", async () => {
  await reset({ scenario: "F-FULL" });
  const ctx = await browser.createBrowserContext();
  let page = await open("/funding", { ctx });
  await page.waitForSelector("[data-program]");
  const t = await text(page);
  check("F0-01", !(await page.$("nav[aria-label=단계]")) && !(await page.$("section[aria-label=회사]")) && t.includes("에 있는") && t.includes("분야를 봅니다") && t.includes("회사 이름을 넣으면 조건을 채우고, 공고문 자격 대조까지 이어집니다."));
  const first = await page.$eval("[data-program]", (e) => ({ id: e.getAttribute("data-program"), title: e.querySelector("h3").textContent }));
  const b0 = await page.$eval("[data-program] button[aria-pressed]", (b) => b.textContent.trim());
  await page.evaluate(() => document.querySelector("[data-program] button[aria-pressed]").click());
  await wait(300);
  const b1 = await page.$eval(`[data-program='${first.id}'] button[aria-pressed]`, (b) => b.textContent.trim());
  await click(page, "목록 복사해서 공유");
  await wait(300);
  const copied = await page.evaluate(() => window.__copied.at(-1) ?? "");
  check("F0-02", b0 === "저장" && b1 === "저장함" && copied.includes(first.title));
  check("F0-03", count(await getLog(), "POST", /.*/) === 0 && !t.includes("공고문으로 자격 대조"));
  await sh(page, "browse-1180");
  const rp = await open(`/c/${CID}/review`, { ctx });
  await waitText(rp, "담은 공고");
  check("F0-04", (await text(rp)).includes("담은 공고 0건"));
  check("R-03", (await text(rp)).includes("아직 담은 공고가 없습니다.") && (await text(rp)).includes("자금·판로에서 고르기"));
  const np = await open(`/c/${CID}/note`, { ctx });
  await waitText(np, "회사 핵심 값");
  check("N-10", (await text(np)).includes("담은 항목이 없습니다.") && (await text(np)).includes("자금·판로로 가기") && (await text(np)).includes("메모"));
  // 운용사만 담았으면 투자 갈래(R-01)
  const fp = await open(`/c/${CID}/funding?lane=invest`, { ctx });
  await waitText(fp, "기업 유형을 골라 주세요");
  await click(fp, "창업·벤처기업", { exact: true });
  await fp.waitForSelector("[data-gp]");
  await fp.evaluate(() => [...document.querySelectorAll("[data-gp] button[aria-pressed]")].find((b) => b.getBoundingClientRect().height > 0)?.click());
  await wait(300);
  const rp2 = await open(`/c/${CID}/review`, { ctx });
  await waitText(rp2, "담은 운용사");
  check("R-01 (운용사만)", (await attr(rp2, "#tab-invest", "aria-selected")) === "true");
  page = await open("/funding", { blockData: true });
  await waitText(page, "공고와 펀드 목록을 불러오지 못했습니다.");
  check("F-14", !/python3|scripts\//.test(await text(page)));
  // F-06: 깊이 비교 전
  check("F-06", (await text(fp)).includes("경쟁사 분석으로 가기") && (await attr(fp, `a[href="/c/${CID}/rivals"].link`, "href")) === `/c/${CID}/rivals` && !(await fp.$$eval("[data-gp]", (l) => l.some((x) => x.innerText.includes("경쟁사에 투자")))));
  await ctx.close();
});

// ================================================================ 사례 화면 주소, 화면 찍기
await run("redirect", async () => {
  const page = await open("/cases");
  await page.waitForSelector("#company-name");
  const p2 = await open("/s/b");
  await p2.waitForSelector("#company-name");
  check("사례 주소 → /", new URL(page.url()).pathname === "/" && new URL(p2.url()).pathname === "/");
});

// ================================================================ 실제 서버 검증에서 더한 점검(docs/verification.md)
// G-20: 분석 진행 중·열 때 실행 중에 화면 읽기 알림 영역 글이 경과 초 때문에 바뀌지 않는다
await run("live-regions", async () => {
  await reset({ scenario: "F-STAGED", step: 0 });
  const page = await open(`/c/${CID}`);
  await waitText(page, "분석 중");
  await wait(1500);
  const a = await liveSamples(page, 4, 700);
  check("G-20 (분석 진행 중)", a.length === 1 && !/\d+초/.test(a[0]), a.join(" // ").slice(0, 200));
  await reset({ scenario: "F-FULL" });
  const p2 = await open(`/c/${CID}#tech`);
  await waitText(p2, "논문 분석하기");
  await click(p2, "논문 분석하기", { exact: true, within: "#tech" });
  await waitText(p2, "논문을 찾고 있습니다");
  await wait(400);
  const b = await liveSamples(p2, 4, 700);
  check("G-20 (열 때 실행 중)", b.length === 1 && b[0].includes("논문을 찾고 있습니다") && !/\d+초/.test(b[0]), b.join(" // ").slice(0, 200));
  // RI-18: 경쟁사 비교 자료를 받는 동안에도 알림 영역 글이 경과 초 때문에 바뀌지 않는다
  const fx = JSON.parse(readFileSync(new URL("../../fixtures/analysis/F-FULL.json", import.meta.url), "utf8")).exchanges[0].response.sections.rivals_deep;
  await reset({ scenario: "F-FULL", overrides: { rivals_deep: { ...fx, status: "running", startedAt: "2026-11-22T20:59:00+09:00", seconds: 3, result: null, retryable: false } } });
  const p3 = await open(`/c/${CID}/rivals`);
  await waitText(p3, "비교 자료를 받고 있습니다");
  await wait(400);
  const c3 = await liveSamples(p3, 4, 700);
  check("RI-18", c3.length === 1 && c3[0].includes("비교 자료를 받고 있습니다") && !/\d+초/.test(c3[0]), c3.join(" // ").slice(0, 200));
});

// A-23: 단락이 도착하는 동안(F-STAGED t0→t6) 첫 화면에서 이미 보이던 요소가 8px 넘게 움직이지 않는다(브라우저 layout-shift 기록)
await run("first-screen-shift", async () => {
  for (const w of [1180, 820, 390]) {
    await reset({ scenario: "F-STAGED", step: 0 });
    const page = await open(`/c/${CID}`, { width: w });
    await waitText(page, "분석 중");
    await wait(2500);
    await page.evaluate(() => {
      window.__ls = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          if (!e.hadRecentInput)
            for (const s of e.sources || []) window.__ls.push({ dy: Math.round(s.currentRect.y - s.previousRect.y), y: Math.round(s.previousRect.y), what: (s.node?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24) });
      }).observe({ type: "layout-shift" });
    });
    for (let s = 1; s <= 6; s++) {
      await ctl({ step: s });
      await wait(2200);
    }
    const vh = heightFor(w);
    const moved = (await page.evaluate(() => window.__ls)).filter((x) => x.y <= vh && x.dy !== 0);
    const worst = moved.sort((p, q) => Math.abs(q.dy) - Math.abs(p.dy))[0];
    check(`A-23 (첫 화면 밀림 ${w})`, !worst || Math.abs(worst.dy) <= 8, worst ? `${worst.dy}px ${worst.what}` : "0px");
    await page.browserContext().close();
  }
});

// L-01·L-02: 넓은 화면(1024 이상) 가로 폭 규칙(visual-plan 7절, screens 1.13). 다섯 단계 화면에서
// - 내용 첫 줄(h1, 회사 분석은 본문 첫 덩어리) 왼쪽 끝 = 회사 이름 줄 왼쪽 끝
// - 넓은 곳([data-wide]: 경쟁사 비교 표 덩어리, 자금·판로의 두 갈래 나란히) 밖의 p·li·h2 오른쪽 끝 ≤ 왼쪽 + 760(+1)
// - 넓은 곳은 경쟁사 분석(비교 자료 있음)과 자금·판로에 있다. 회사 분석 목차는 본문 오른쪽(간격 48 이상)이고 틀(1152) 안이다
await run("layout-width", async () => {
  await reset({ scenario: "F-FULL", deep: "two" });
  const ctx = await browser.createBrowserContext();
  const fs0 = await open(`/c/${CID}/funding`, { ctx });
  await waitText(fs0, "기업 유형을 골라 주세요");
  await click(fs0, "창업·벤처기업", { exact: true });
  await wait(500);
  await fs0.close();
  const screens = [["회사 분석", ""], ["경쟁사 분석", "/rivals"], ["자금·판로", "/funding"], ["심사 준비", "/review"], ["노트", "/note"]];
  const fails = [];
  const notes = [];
  for (const w of [1024, 1280, 1440]) {
    for (const [name, path] of screens) {
      const pg = await open(`/c/${CID}${path}`, { ctx, width: w });
      await pg.waitForSelector("main h1, main > *", { timeout: 8000 }).catch(() => null);
      await wait(1500);
      const m = await pg.evaluate(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
        const nameEl = document.querySelector("section[aria-label=회사]")?.querySelector("h1, span.text-lg");
        const main = document.querySelector("main");
        const h1 = main.querySelector("h1");
        const first = h1 && vis(h1) ? h1 : [...main.children].find(vis);
        const left = first.getBoundingClientRect().left;
        const inFixed = (e) => { for (let x = e; x; x = x.parentElement) if (getComputedStyle(x).position === "fixed") return true; return false; };
        let worst = { rel: 0, text: "" };
        for (const e of main.querySelectorAll("p, li, h2")) {
          if (!vis(e) || e.closest("[data-wide]") || inFixed(e)) continue;
          const rel = e.getBoundingClientRect().right - left;
          if (rel > worst.rel) worst = { rel: Math.round(rel), text: e.innerText.replace(/\s+/g, " ").slice(0, 24) };
        }
        const wide = [...main.querySelectorAll("[data-wide]")].filter(vis).map((e) => Math.round(e.getBoundingClientRect().width));
        const toc = document.querySelector("nav[aria-label='단락 목차']");
        const tr = toc ? toc.getBoundingClientRect() : null;
        return { name: nameEl ? nameEl.getBoundingClientRect().left : null, left, worst, wide, toc: tr ? { l: tr.left, r: tr.right } : null, mainR: main.getBoundingClientRect().right, hs: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      const tag = `${name} ${w}`;
      if (m.name === null || Math.abs(m.name - m.left) > 1) fails.push(`${tag} 왼쪽 ${Math.round(m.left)}≠이름 ${m.name === null ? "없음" : Math.round(m.name)}`);
      if (m.worst.rel > 761) fails.push(`${tag} 글 오른쪽 +${m.worst.rel}(${m.worst.text})`);
      if (m.hs > 1) fails.push(`${tag} 가로 넘침 ${m.hs}`);
      if ((path === "/rivals" || path === "/funding") && !m.wide.length) fails.push(`${tag} 넓은 곳 없음`);
      if (path === "" && (!m.toc || m.toc.l < m.mainR + 47 || m.toc.r > m.name + 1152 + 1)) fails.push(`${tag} 목차 ${m.toc ? `${Math.round(m.toc.l)}-${Math.round(m.toc.r)}` : "없음"}, 본문 끝 ${Math.round(m.mainR)}`);
      notes.push(`${tag}: +${m.worst.rel}${m.wide.length ? ` 넓은 곳 ${m.wide.join("/")}` : ""}`);
      if (OUT && w >= 1280) await sh(pg, `layout-${path.replace("/", "") || "analysis"}-${w}`, true);
      await pg.close();
    }
  }
  check("L-01 (넓은 화면 왼쪽 선·글 폭 760·넓은 곳)", fails.length === 0, fails.slice(0, 4).join(" | ") || notes.filter((n) => n.includes("1280")).join(" · "));
  await ctx.close();
});

// L-02: 머리줄 높이는 모든 화면 48 + 선 1(screens 1.1). 1280 폭에서 로고의 왼쪽·위 위치도 같다. /funding 오른쪽 링크는 머리줄 안에서 44px 이상
await run("header-height", async () => {
  await reset({ scenario: "F-FULL" });
  const ctx = await browser.createBrowserContext();
  const fails = [];
  const seen = {};
  for (const w of [1280, 390, 360]) {
    for (const path of ["/", "/funding", `/c/${CID}`, `/c/${CID}/rivals`]) {
      const pg = await open(path, { ctx, width: w });
      await pg.waitForSelector("header", { timeout: 8000 }).catch(() => null);
      await wait(600);
      const m = await pg.evaluate(() => {
        const h = document.querySelector("header");
        const hr = h.getBoundingClientRect();
        const logo = [...document.querySelectorAll('a[href="/"]')].find((a) => a.textContent.includes("성장노트") && a.getBoundingClientRect().height > 0)?.getBoundingClientRect();
        const right = [...h.querySelectorAll("a")].filter((a) => a.textContent.includes("회사 분석 시작")).map((a) => { const r = a.getBoundingClientRect(); return { h: r.height, w: r.width, inside: r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5 }; });
        return { h: Math.round(hr.height), logo: logo ? { x: Math.round(logo.left), y: Math.round(logo.top) } : null, right };
      });
      if (w !== 360 && m.h !== 49) fails.push(`${path} ${w} 머리줄 ${m.h}`);
      if (w === 1280) (seen.logo ??= []).push(`${path} ${m.logo ? `${m.logo.x},${m.logo.y}` : "없음"}`);
      for (const r of m.right) if (r.h < 43.5 || r.w < 43.5 || !r.inside) fails.push(`${path} ${w} 회사 분석 시작 ${Math.round(r.w)}x${Math.round(r.h)} 안 ${r.inside}`);
      await pg.close();
    }
  }
  await ctx.close();
  const logos = new Set((seen.logo ?? []).map((x) => x.split(" ").pop()));
  if (logos.size !== 1) fails.push(`1280 로고 위치 ${seen.logo.join(" | ")}`);
  check("L-02 (머리줄 높이 49·로고 위치)", fails.length === 0, fails.slice(0, 4).join(" | ") || (seen.logo ?? []).join(" · "));
});

// A-33·D-08: 담은 공고 마감일은 지금 공고 자료 먼저, 없으면 담을 때 저장값(lib/review.ts noticeEnd). "지금 확인할 것"·심사 준비·노트가 같은 날짜다.
// 공고 목록을 받는 동안은 마감 임박 개수를 보이지 않고(저장값으로 셌다가 바뀌지 않게), 담은 공고가 있으면 틀을 먼저 두어 아래가 밀리지 않는다.
// A-34: 이 묶음은 목록을 5초만 기다리고 저장값으로 센다. 공용 요청은 끊지 않아 늦게 오면 지금 자료로 다시 센다(위치 그대로)
await run("deadline-basis", async () => {
  await reset({ scenario: "F-FULL" }); // 엇갈림·미확보 0: "지금 확인할 것"에는 담은 공고 항목만 나온다
  const ctx = await browser.createBrowserContext();
  const P3 = "PBLN_000000000000003";
  const P4 = "PBLN_000000000000004";
  const title = (id) => `가나다시 마감 확인 가짜 공고 ${id.slice(-1)}`;
  const list = (ends) => JSON.stringify([...Object.entries(ends).map(([id, end]) => fakeProgram(id, title(id), end)), ...programs]);
  // 담기를 브라우저 저장소에 바로 쓴다(담을 때 저장한 마감일 meta.end 를 지금 자료와 다르게 두려고)
  const putSaved = (pg, id, end) =>
    pg.evaluate(
      (cid, id, end, t) =>
        new Promise((res) => {
          const r = indexedDB.open("growthnote", 1);
          r.onupgradeneeded = () => {
            for (const s of ["companies", "snapshots", "jobs", "edits", "saved", "checks", "rivalChecks", "briefs", "rivalChoices", "prep", "notes", "salesKeywords"]) r.result.createObjectStore(s);
          };
          r.onsuccess = () => {
            const tx = r.result.transaction("saved", "readwrite");
            tx.objectStore("saved").put({ kind: "program", itemId: id, title: t, savedAt: "2026-11-20T10:00:00+09:00", meta: { end, agency: "가나다시청", url: `https://example.com/program/${id}` } }, [cid, "program", id]);
            tx.oncomplete = () => res(true);
          };
        }),
      CID, id, end, title(id),
    );
  const seed = await open("/", { ctx });
  await seed.waitForSelector("#company-name");
  await putSaved(seed, P3, "2026-12-07"); // 담을 때 마감 15일 뒤(2026-11-22 기준)
  await seed.close();
  const shown = (pg, sel, t) => pg.waitForFunction((sel, t) => (document.querySelector(sel)?.innerText ?? "").includes(t), { timeout: 8000 }, sel, t).catch(() => null);

  // 1) 지금 자료 마감 5일 뒤(마감이 당겨짐) → 세 화면 모두 11.27(D-5)
  const early = list({ [P3]: "2026-11-27" });
  const a1 = await open(`/c/${CID}`, { ctx, programs: early });
  await shown(a1, "[data-checknow]", "마감 임박 담은 공고");
  const ck1 = await text(a1, "[data-checknow]");
  await a1.close();
  const r1 = await open(`/c/${CID}/review`, { ctx, programs: early });
  await shown(r1, `[data-notice='${P3}']`, "11.27 마감");
  // 카드 마감 칸은 큰 줄 "D-5"와 작은 줄 "11.27 마감"으로 나뉜다(화면 읽기는 "D-5, 11.27 마감" 한 덩어리). 글 전체(textContent)로 본다
  const due = (pg) => pg.$eval(`[data-notice='${P3}'] .lrow-end`, (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "카드 없음");
  const card1 = await due(r1);
  await r1.close();
  const n1 = await open(`/c/${CID}/note`, { ctx, programs: early });
  await shown(n1, "[data-part=programs]", "11.27 마감");
  const note1 = await text(n1, "[data-part=programs]");
  await n1.close();
  check("A-33 (지금 자료 우선)", ck1.includes("마감 임박 담은 공고 1건") && ck1.includes("D-5"), ck1.replace(/\n/g, " "));
  check("D-08 (세 화면 같은 마감일)", ck1.includes("D-5") && card1.includes("D-5, 11.27 마감") && note1.includes("11.27 마감") && !note1.includes("12.7"), `${card1} | ${note1.split("\n").find((l) => l.includes("마감")) ?? "노트 없음"}`);

  // 2) 공고 목록을 받지 못함 → 세 화면 모두 저장값(12.7, D-15). 지금 확인할 것에는 마감 임박이 없다
  //    (F-FULL 이라 다른 항목도 없다. 오류 전 받는 동안 틀을 잡았으면 "지금 확인할 것이 없습니다"로 남는다)
  const a2 = await open(`/c/${CID}`, { ctx, blockData: true });
  await a2.waitForSelector("#h-overview", { timeout: 8000 }).catch(() => null);
  await wait(1500);
  const ck2 = await text(a2, "[data-checknow]");
  await a2.close();
  const r2 = await open(`/c/${CID}/review`, { ctx, blockData: true });
  await shown(r2, `[data-notice='${P3}']`, "마감");
  await wait(800);
  const card2 = await due(r2);
  await r2.close();
  const n2 = await open(`/c/${CID}/note`, { ctx, blockData: true });
  await shown(n2, "[data-part=programs]", "마감");
  await wait(800);
  const note2 = await text(n2, "[data-part=programs]");
  await n2.close();
  check("A-33 (목록 못 받음 → 저장값)", !ck2.includes("마감 임박 담은 공고") && (ck2 === "" || ck2.includes("지금 확인할 것이 없습니다")) && card2.includes("D-15, 12.7 마감") && note2.includes("12.7 마감"), `묶음 "${ck2.replace(/\n/g, " ") || "없음"}" | ${card2} | ${note2.split("\n").find((l) => l.includes("마감")) ?? "노트 없음"}`);

  // 화면 기록: 개요 제목이 그려진 뒤 40ms 마다 "지금 확인할 것" 글(없으면 null)과 개요 제목 위치
  const record = (pg, ms = 3800) =>
    pg.evaluate((ms) => {
      window.__ck = [];
      const t = setInterval(() => {
        const ov = document.getElementById("h-overview");
        if (!ov) return;
        const s = document.querySelector("[data-checknow]");
        window.__ck.push({ t: s ? s.innerText.replace(/\s+/g, " ") : null, ov: Math.round(ov.getBoundingClientRect().top + scrollY) });
      }, 40);
      setTimeout(() => clearInterval(t), ms);
    }, ms);
  const HOLD = "마감 임박은 공고 목록을 받으면 셉니다";
  // 3) 저장값으로는 마감 임박이 아닌 공고(P3, 15일 뒤 → 지금 5일 뒤) 하나만 담았고 다른 항목이 없다. 목록이 1.5초 늦게 와도
  //    개요 제목이 그려진 처음부터 틀과 대기 줄이 있고, 목록이 오면 같은 자리에 "1건 D-5"가 들어와 개요 제목이 그대로다
  for (const w of [1180, 390]) {
    const pd = await open(`/c/${CID}`, { ctx, width: w, programs: early, dataDelay: 1500 });
    await record(pd);
    await wait(4000);
    const seen = await pd.evaluate(() => window.__ck);
    await pd.close();
    const ovs = [...new Set(seen.map((x) => x.ov))];
    const last = seen.at(-1)?.t ?? "";
    const ok = seen.length > 0 && seen.every((x) => x.t !== null) && seen[0].t.includes(HOLD) && last.includes("마감 임박 담은 공고 1건") && last.includes("D-5") && ovs.length === 1;
    check(`A-33 (저장값으로는 임박 아님, 받는 중 ${w})`, ok, `처음 "${seen[0]?.t ?? "없음"}" → 끝 "${last}", 틀 없던 기록 ${seen.filter((x) => x.t === null).length}, 개요 제목 위치 ${ovs.join("/")}`);
  }

  // 4) 공고 목록이 1.5초 늦게 온다. P4 는 저장값으로 마감 임박(5일 뒤), P3 는 저장값 15일 뒤.
  //    받는 중: 틀 + "마감 임박은 공고 목록을 받으면 셉니다"(저장값 개수 "1건"은 한 번도 보이지 않는다). 받은 뒤: 같은 자리에 지금 자료 개수, 개요 제목 그대로
  const seed2 = await open("/", { ctx });
  await seed2.waitForSelector("#company-name");
  await putSaved(seed2, P4, "2026-11-27");
  await seed2.close();
  for (const w of [1180, 390]) {
    const pd = await open(`/c/${CID}`, { ctx, width: w, programs: list({ [P3]: "2026-11-27", [P4]: "2026-11-27" }), dataDelay: 1500 });
    await record(pd);
    await wait(4000);
    const seen = await pd.evaluate(() => window.__ck);
    await pd.close();
    const ovs = [...new Set(seen.map((x) => x.ov))];
    const last = seen.at(-1)?.t ?? "";
    const ok = seen.length > 0 && seen.every((x) => x.t !== null) && seen[0].t.includes(HOLD) && !seen.some((x) => /마감 임박 담은 공고 1건/.test(x.t)) && last.includes("마감 임박 담은 공고 2건") && last.includes("D-5") && ovs.length === 1;
    check(`A-33 (받는 중 ${w})`, ok, `처음 "${seen[0]?.t ?? "없음"}" → 끝 "${last}", 개요 제목 위치 ${ovs.join("/")}`);
  }
  // 받은 뒤 마감 임박이 없으면(둘 다 마감이 늘어남) 틀은 이 방문 동안 "지금 확인할 것이 없습니다"로 남는다(아래가 다시 밀리지 않게)
  {
    const pd = await open(`/c/${CID}`, { ctx, programs: list({ [P3]: "2026-12-30", [P4]: "2026-12-30" }), dataDelay: 1500 });
    await record(pd);
    await wait(4000);
    const seen = await pd.evaluate(() => window.__ck);
    await pd.close();
    const ovs = [...new Set(seen.map((x) => x.ov))];
    const last = seen.at(-1)?.t ?? "";
    check("A-33 (받는 중 → 마감 임박 없음)", seen.length > 0 && seen.every((x) => x.t !== null) && seen[0].t.includes(HOLD) && !seen.some((x) => x.t.includes("마감 임박 담은 공고")) && last.includes("지금 확인할 것이 없습니다") && ovs.length === 1, `처음 "${seen[0]?.t ?? "없음"}" → 끝 "${last}", 개요 제목 위치 ${ovs.join("/")}`);
  }
  // A-34: 목록이 기다림 시간(5초)보다 늦게(7초) 온다. 대기 줄 → 5초 뒤 저장값 개수(P4 만 임박 "1건") → 목록이 오면 지금 자료 개수("2건").
  //       개요 제목은 처음부터 끝까지 같은 자리. 공용 요청은 끊지 않으므로 같은 페이지에서 심사 준비로 가면 지금 자료 마감이 보인다
  {
    const pd = await open(`/c/${CID}`, { ctx, programs: list({ [P3]: "2026-11-27", [P4]: "2026-11-27" }), dataDelay: 7000 });
    await record(pd, 8800);
    await wait(9000);
    const seen = await pd.evaluate(() => window.__ck);
    const ovs = [...new Set(seen.map((x) => x.ov))];
    const kind = (t) => (t === null ? "없음" : t.includes(HOLD) ? "대기" : /마감 임박 담은 공고 1건/.test(t) ? "저장값" : /마감 임박 담은 공고 2건/.test(t) ? "지금 자료" : `기타(${t})`);
    const order = seen.map((x) => kind(x.t)).filter((k, i, a) => i === 0 || a[i - 1] !== k); // 바뀐 차례만
    const savedAt = seen.findIndex((x) => kind(x.t) === "저장값") * 40; // 기록 시작부터 대략 ms
    await pd.evaluate((cid) => document.querySelector(`nav[aria-label=단계] a[href="/c/${cid}/review"]`)?.click(), CID);
    await shown(pd, `[data-notice='${P3}']`, "11.27 마감");
    const card = await due(pd).catch(() => "카드 없음");
    await pd.close();
    check(
      "A-34 (기다림 5초 → 저장값 → 지금 자료)",
      order.join(">") === "대기>저장값>지금 자료" && savedAt >= 4000 && ovs.length === 1 && card.includes("D-5, 11.27 마감"),
      `${order.join(" → ")}, 저장값으로 바뀐 때 약 ${savedAt}ms, 개요 제목 위치 ${ovs.join("/")}, 심사 준비 ${card}`,
    );
  }
  await ctx.close();
});

// P-12: 판로 머리의 "위 빠른 거르기는 걸리지 않습니다."는 빠른 거르기 줄이 실제로 위에 보일 때만(1180). 820·390 판로 탭에서는 없다
await run("sales-head", async () => {
  await reset({ scenario: "F-FULL" });
  const ctx = await browser.createBrowserContext();
  const S = "위 빠른 거르기는 걸리지 않습니다.";
  const head = (pg) =>
    pg.evaluate(() => ({
      head: document.querySelector("#lane-sales .lane-sales p")?.innerText ?? null,
      quick: [...document.querySelectorAll("[aria-label='빠른 거르기']")].some((e) => e.getBoundingClientRect().height > 0),
    }));
  const pg = await open(`/c/${CID}/funding?lane=sales`, { ctx });
  await waitText(pg, "기업 유형을 골라 주세요");
  await pg.waitForSelector("#lane-sales");
  await wait(300);
  const before = await head(pg);
  await click(pg, "창업·벤처기업", { exact: true });
  await pg.waitForSelector("[aria-label='빠른 거르기']", { timeout: 8000 }).catch(() => null);
  await wait(300);
  const after = await head(pg);
  await globalChecks(pg, "자금·판로 판로 머리 1180");
  await pg.close();
  const narrow = [];
  for (const w of [820, 390]) {
    const pn = await open(`/c/${CID}/funding?lane=sales`, { ctx, width: w });
    await pn.waitForSelector("#lane-sales");
    await wait(500);
    narrow.push({ w, ...(await head(pn)) });
    await pn.close();
  }
  check(
    "P-12",
    before.head !== null && !before.quick && !before.head.includes(S) && after.quick && after.head?.includes(S) && narrow.every((n) => n.head !== null && !n.head.includes(S)),
    JSON.stringify({ before, after, narrow }),
  );
  await ctx.close();
});

// PR-06: 인쇄한 차트 안 글이 7pt(9.33px) 이상이다. 근거 묶음 인쇄 모양을 A4 본문 폭(182mm = 688px)으로 그려 잰다
await run("print-chart-text", async () => {
  await reset({ scenario: "F-FULL" });
  const page = await open(`/c/${CID}/review?tab=invest`, { width: 688 });
  await waitText(page, "미팅 근거 묶음");
  await page.evaluate(() => (document.body.dataset.print = "evidence"));
  await page.emulateMediaType("print");
  await wait(300);
  const sizes = await page.$$eval(".evidence-print .print-only svg[role=img]", (svgs) =>
    svgs.map((s) => {
      const k = s.getBoundingClientRect().width / s.viewBox.baseVal.width;
      return Math.min(...[...s.querySelectorAll("text")].map((t) => parseFloat(t.getAttribute("font-size") || getComputedStyle(t).fontSize) * k));
    }),
  );
  await page.emulateMediaType("screen");
  const min = Math.min(...sizes);
  check("PR-06 (자동 보조)", sizes.length >= 2 && min >= 9.33, `차트 ${sizes.length}개, 가장 작은 글 ${min.toFixed(1)}px(${((min * 72) / 96).toFixed(1)}pt)`);
});

if (OUT) {
  await run("shots", async () => {
    await reset({ scenario: "F-FULL", example: true });
    for (const w of [390, 820, 1180, 1440]) {
      const p = await open(`/c/${CID}`, { width: w, fonts: true });
      await waitText(p, "검색으로 확인한 특허 11건");
      await wait(1200);
      await sh(p, `analysis-${w}`);
      await sh(p, `analysis-${w}-full`, true);
      const s = await open("/", { width: w, fonts: true, ctx: p.browserContext() });
      await waitText(s, "예시 회사로 보기");
      await wait(800);
      await sh(s, `start-${w}`);
      await p.browserContext().close();
    }
  });
}

// ---------------------------------------------------------------- 결과
for (const [id, list] of Object.entries(globalFails)) check(id, false, list.slice(0, 3).join(" | "));
const globalIds = ["G-01", "G-02", "G-03", "G-04", "G-06", "G-07", "G-08", "G-12", "G-17", "G-18", "G-19", "RI-01"];
for (const id of globalIds) if (!globalFails[id]) check(id, true, "모든 점검 화면");
const failed = results.filter((r) => !r.ok);
console.log(`\n합계 ${results.length}건, 통과 ${results.length - failed.length}, 실패 ${failed.length}`);
if (OUT) writeFileSync(`${OUT}/ux-check-result.json`, JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);

function CSS_escape(s) {
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
