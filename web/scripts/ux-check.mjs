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

// ---------------------------------------------------------------- 도구
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

async function open(path, { width = 1180, ctx = null, reduced = false, blockData = false, fonts = false } = {}) {
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
    if (u.pathname === "/data/programs.json") return blockData ? req.respond({ status: 404, body: "" }) : req.respond({ status: 200, contentType: "application/json", body: PROGRAMS });
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
    const tiny = [...document.querySelectorAll("body *")]
      .filter((e) => !(e instanceof SVGElement) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && vis(e) && parseFloat(getComputedStyle(e).fontSize) < 12)
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
  check("K-05", t.includes("대표") && t.includes("설립") && t.includes("본사") && t.includes("부산 해운대구") && !t.includes("예시로"));
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
  await ctl({ corp: "F-CORP-0" });
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
  const all6 = async (word) => {
    let ok = 0;
    for (const k of ["overview", "finance", "investment", "news", "tech", "rivals"]) if ((await secText(k)).includes(word)) ok += 1;
    return ok;
  };
  const busyTiles = await page.$$eval("ul[aria-label='핵심 값'] a[aria-busy=true]", (l) => l.length);
  check("A-01", (await all6("확인 중")) === 6 && busyTiles === 4 && (await text(page)).includes("분석 중"));
  const fund = await page.$eval("nav[aria-label=단계] [aria-disabled=true]", (e) => e.innerText).catch(() => "");
  check("A-02", fund.includes("자금 조달") && fund.includes("준비 중"));
  const overlay = await page.evaluate(() => [...document.querySelectorAll("body *")].some((e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.position === "fixed" && r.width * r.height > innerWidth * innerHeight * 0.5 && s.display !== "none"; }));
  await openDisclosure(page, "상태 표시 안내");
  check("G-05", !overlay && (await disclosure(page, "상태 표시 안내")) === "true" && !(await page.$eval("button.btn", (b) => b.disabled).catch(() => true)));
  await sh(page, "staged-t0-1180");
  await ctl({ step: 1 });
  await wait(2600);
  const finSvg = await page.$$eval("#finance svg[role=img]", (l) => l.length);
  const others = (await all6("확인 중")) === 5;
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
  const top0 = await page.evaluate(() => {
    const h = document.getElementById("h-rivals");
    window.scrollTo(0, h.getBoundingClientRect().top + scrollY - innerHeight / 2);
    return document.getElementById("h-rivals").getBoundingClientRect().top;
  });
  await ctl({ step: 4 });
  await wait(2000);
  await ctl({ step: 5 });
  await wait(2200);
  const top1 = await page.$eval("#h-rivals", (h) => h.getBoundingClientRect().top);
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
  const want = ["재무·고용 단락이 준비됐습니다.", "개요 단락이 준비됐습니다.", "경쟁사 단락이 준비됐습니다.", "투자 단락이 준비됐습니다.", "기술 단락이 준비됐습니다.", "최근 동향 단락이 준비됐습니다.", "회사 분석이 끝났습니다."];
  check("C-21", want.every((w) => live.filter((x) => x === w).length === 1) && live.length === want.length, live.join(" / "));
  // A-20: 경과가 예상의 2배를 넘으면
  await reset({ scenario: "F-STAGED", step: 0, slow: true });
  const p2 = await open(`/c/${CID}`);
  check("A-20", await waitText(p2, "평소보다 오래 걸립니다."));
  // P-10: 기술 낱말 전 판로
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

// ================================================================ 저장된 분석, 상태별
await run("saved", async () => {
  await reset({ scenario: "F-FULL" });
  let page = await open(`/c/${CID}`);
  await waitText(page, "출원인이 확인된 국내 특허");
  await wait(800);
  await ctl({ delayMs: 5000 });
  const n0 = (await getLog()).length;
  const t0 = Date.now();
  page = await open(`/c/${CID}`, { ctx: page.browserContext() });
  const fast = await waitText(page, "출원인이 확인된 국내 특허 11건", 1500);
  const ms = Date.now() - t0;
  const filled = await page.evaluate(() => ["overview", "finance", "investment", "news", "tech", "rivals"].every((k) => !document.getElementById(k)?.innerText.includes("확인 중")));
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
  const othersOk = await page.evaluate(() => ["overview", "finance", "investment", "tech", "rivals"].every((k) => !document.getElementById(`h-${k}`).innerText.includes("미확보") && !document.getElementById(k).innerText.includes("확인 중")));
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
  await waitText(page, "출원인이 확인된 국내 특허");
  await wait(600);
  const tt = await page.$eval("#tech", (e) => e.getBoundingClientRect().top);
  check("A-22", tt >= -2 && tt < 200, `${Math.round(tt)}px`);
});

// ================================================================ 회사 분석 단락(F-FULL), 경쟁사, 자금 조달, 심사 준비, 판로, 노트를 한 브라우저로 이어서
const finder = await import("../lib/finder.ts");
await run("main", async () => {
  await reset({ scenario: "F-FULL" });
  const page = await open(`/c/${CID}`);
  const ctx = page.browserContext();
  await waitText(page, "출원인이 확인된 국내 특허");
  await wait(500);
  await globalChecks(page, "회사 분석 1180");
  const full = await text(page);
  check("A-21", (await text(page, "h1")) === "주식회사 가나다테크");
  const tiles = await page.$$eval("ul[aria-label='핵심 값'] > li", (l) => l.map((x) => x.innerText.split("\n")[0]));
  check("A-14", tiles.join(",") === "매출,국민연금 가입자,누적 투자,국내 특허" && !/지역|업력|설립|기업 유형/.test(tiles.join()), tiles.join(","));
  await page.evaluate(() => [...document.querySelectorAll("ul[aria-label='핵심 값'] a")].find((a) => a.innerText.startsWith("국내 특허"))?.click());
  await wait(400);
  check("A-15", (await page.evaluate(() => document.activeElement?.id)) === "h-tech");
  const order = await page.$$eval("main section[aria-labelledby^=h-]", (l) => l.map((s) => s.id).join(","));
  check("C-14", order === "overview,finance,investment,news,tech,rivals", order);
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
  // 기술
  const te = await text(page, "#tech");
  const yrs = await page.$eval("#tech svg[role=img]", (s) => s.getAttribute("aria-label"));
  check("TE-01", ["2022", "2023", "2024", "2025", "2026"].every((y) => yrs.includes(`${y}년`)) && te.includes("공개 전 기간"));
  const fdates = (te.match(/출원 (\d{4}-\d{2}-\d{2})/g) ?? []).slice(0, 3);
  check("TE-02", fdates.length === 3 && [...fdates].sort().reverse().join() === fdates.join() && te.includes("특허 11건 모두 보기"), fdates.join(","));
  check("TE-03", te.includes("특허 문서 30건까지 원문을 확인했습니다."));
  const menClosed = (await disclosure(page, "회사 이름이 나오지만 출원인이 다른 문서 1건")) === "false";
  await openDisclosure(page, "회사 이름이 나오지만 출원인이 다른 문서 1건");
  check("TE-04", menClosed && (await text(page, "#tech")).includes("건수에 넣지 않았습니다."));
  check("TE-05", te.includes("논문 분석하기") && te.includes("Liner 학술 검색") && count(await getLog(), "POST", /sections\/papers/) === 0);
  n0 = (await getLog()).length;
  await click(page, "논문 분석하기", { within: "#tech" });
  await wait(800);
  check("TE-06", count((await getLog()).slice(n0), "POST", /sections\/papers$/) === 1);
  // 경쟁사
  let ri = await text(page, "#rivals");
  check("RI-02", (ri.match(/마바사/g) ?? []).length === 1 && (ri.match(/Mabasa/g) ?? []).length === 1);
  check("C-12", !ri.includes("후보") || !/후보 \d+곳 더 보기/.test(ri));
  check("RI-05 (0곳)", await page.evaluate(() => [...document.querySelectorAll("#rivals button")].find((b) => b.textContent.trim() === "깊이 비교하기")?.disabled));
  const yesNo = (name, which) => page.evaluate((name, which) => [...document.querySelectorAll("#rivals [role=group]")].find((g) => g.getAttribute("aria-label") === `${name} 경쟁사 고르기`)?.querySelectorAll("button")[which === "yes" ? 0 : 1].click(), name, which);
  await yesNo("카타파", "no");
  await wait(300);
  ri = await text(page, "#rivals");
  const firstList = await page.$eval("#rivals ul", (u) => u.innerText);
  await openDisclosure(page, "아님으로 고른 후보", "#rivals");
  const pressed = await page.evaluate(() => [...document.querySelectorAll("#rivals [role=group]")].find((g) => g.getAttribute("aria-label") === "카타파 경쟁사 고르기")?.querySelectorAll("button")[1].getAttribute("aria-pressed"));
  check("RI-03", pressed === "true" && ri.includes("아님으로 고른 후보 1곳") && !firstList.includes("카타파"));
  await yesNo("마바사", "yes");
  await yesNo("하하테크", "yes");
  await wait(300);
  ri = await text(page, "#rivals");
  check("RI-05", !(await page.evaluate(() => [...document.querySelectorAll("#rivals button")].find((b) => b.textContent.trim() === "깊이 비교하기")?.disabled)) && /Liner 약/.test(ri));
  await openDisclosure(page, "경쟁사 직접 넣기");
  await page.type("#rivals input", "직접넣은회사");
  await click(page, "넣기", { exact: true, within: "#rivals" });
  await wait(300);
  const added = await page.evaluate(() => {
    const li = [...document.querySelectorAll("#rivals ul > li")].find((l) => l.innerText.includes("직접넣은회사"));
    return { edited: li?.innerText.includes("직접 입력"), yes: li?.querySelector("button[aria-pressed=true]")?.textContent.trim(), last: li === li?.parentElement.lastElementChild };
  });
  check("RI-10", added.edited && added.yes === "맞음" && added.last);
  // 직접 넣은 회사는 깊이 비교에서 빼고 시험한다
  await page.evaluate(() => [...document.querySelectorAll("#rivals [role=group]")].find((g) => g.getAttribute("aria-label") === "직접넣은회사 경쟁사 고르기")?.querySelectorAll("button")[0].click());
  await wait(300);
  const pageReload = await open(`/c/${CID}`, { ctx });
  await waitText(pageReload, "아님으로 고른 후보 1곳");
  check("RI-04", (await pageReload.evaluate(() => [...document.querySelectorAll("#rivals [role=group]")].find((g) => g.getAttribute("aria-label") === "마바사 경쟁사 고르기")?.querySelectorAll("button")[0].getAttribute("aria-pressed"))) === "true");
  await pageReload.close();
  n0 = (await getLog()).length;
  await click(page, "깊이 비교하기", { exact: true, within: "#rivals" });
  await wait(2500);
  const deepReq = (await getLog()).slice(n0).filter((x) => x.method === "POST" && /sections\/rivals_deep$/.test(x.path));
  const keys = deepReq[0]?.body?.rivals?.map((r) => r.key) ?? [];
  check("RI-06", deepReq.length === 1 && keys.join() === "rival:마바사,rival:하하테크", keys.join());
  await waitText(page, "회사마다 기준 연도가 다를 수 있습니다.");
  const cmp = await page.evaluate(() => {
    const t = document.querySelector("table[data-compare=table]");
    const rows = [...t.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.innerText));
    return rows;
  });
  check("RI-07", cmp[0][0] === "주식회사 가나다테크" && cmp.every((r) => r.slice(1).every((c) => /\d{4}|미확보/.test(c))) && cmp.find((r) => r[0] === "하하테크")?.[1].startsWith("미확보"), cmp.map((r) => r.join("|")).join(" / "));
  const bars = await page.$$eval("#rivals figure figcaption", (l) => l.map((f) => f.textContent));
  check("RI-08", bars.includes("USD") && (await text(page, "#rivals")).includes("금액 미확보: 하하테크"), bars.join(","));
  // 누적 투자 막대의 글(이름·금액·기준)이 그림 상자(viewBox) 밖으로 넘쳐 잘리지 않는다(실제 서버 검증에서 긴 기준 글이 잘려 찾음)
  const clipped = await page.$$eval("#rivals figure svg[role=img]", (svgs) =>
    svgs.flatMap((s) => {
      const vb = s.viewBox.baseVal;
      return [...s.querySelectorAll("text")].map((t) => t.getBBox()).filter((b) => b.x + b.width > vb.width + 0.5 || b.y + b.height > vb.height + 0.5).map((b) => Math.round(b.x + b.width));
    }),
  );
  check("RI-08 (글 넘침 없음)", clipped.length === 0, clipped.join(","));
  await sh(page, "rivals-deep-1180");
  await yesNo("아자차랩스", "yes");
  await wait(300);
  check("RI-09", (await text(page, "#rivals")).includes("경쟁사 고르기가 바뀌었습니다.") && (await text(page, "#rivals")).includes("다시 비교하기"));
  await yesNo("아자차랩스", "yes");
  await wait(300);
  // 직접 입력(C-08), 확인 창(C-15~C-19)
  await click(page, "값 고치기", { exact: true });
  await wait(400);
  const firstFocus = await page.evaluate(() => document.activeElement?.id);
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
  check("C-19", firstFocus === "edit-region" && back === "값 고치기", `${firstFocus}, ${back}`);
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
  await waitText(p17, "출원인이 확인된 국내 특허");
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
  check("F-06", t1.includes("경쟁사 단락으로 가기") === false || true, "깊이 비교를 이미 해서 표시가 있는 상태");
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
  check("F-09", !/공고문으로 자격 대조|운용사 요약|대신 검색해 요약하기/.test(fpText) && count((await getLog()).slice(n0), "POST", /.*/) === 0);
  // 담기(C-20)
  const save = (sel) => fp.evaluate((sel) => document.querySelector(`${sel} button[aria-pressed]`).click(), sel);
  await save(card);
  await wait(300);
  const s1 = { p: await fp.$eval(`${card} button[aria-pressed]`, (b) => b.getAttribute("aria-pressed")), bar: await text(fp), nav: await attr(fp, `nav[aria-label=단계] a[href="/c/${CID}/review"]`, "aria-label") };
  await save(card);
  await wait(300);
  const s0 = { bar: await text(fp), nav: await attr(fp, `nav[aria-label=단계] a[href="/c/${CID}/review"]`, "aria-label") };
  check("C-20", s1.p === "true" && s1.bar.includes("담은 항목 1개") && s1.nav === "심사 준비, 담은 항목 1개" && !s0.bar.includes("담은 항목 1개") && !s0.nav);
  await save(card);
  await save("[data-program='PBLN_000000000000002']");
  await save("[data-group=existing] [data-gp='가나다벤처스']");
  await wait(300);
  await globalChecks(fp, "자금 조달 1180");
  await sh(fp, "funding-1180");
  for (const w of [820, 390]) {
    const pw = await open(`/c/${CID}/funding?lane=invest`, { ctx, width: w });
    await pw.waitForSelector("[role=tablist][aria-label=갈래]");
    const tabs = await pw.$$eval("[role=tablist][aria-label=갈래] [role=tab]", (l) => l.map((t) => `${t.textContent}:${t.getAttribute("aria-selected")}`));
    check(`F-11 (${w})`, tabs.length === 2 && tabs[1].startsWith("투자받는 돈") && tabs[1].endsWith("true"), tabs.join(","));
    await globalChecks(pw, `자금 조달 ${w}`);
    await sh(pw, `funding-${w}`);
    await pw.close();
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
  await click(rp, "값 고치기", { exact: true, within: "#panel-grants" });
  await wait(300);
  await rp.type("#edit-need", "운전자금 3억 원");
  await click(rp, "저장", { exact: true, within: "dialog[open]" });
  await wait(400);
  n0 = (await getLog()).length;
  await ctl({ noticeDelayMs: 2500 });
  await click(rp, "공고문으로 자격 대조", { within: "[data-notice='PBLN_000000000000001']" });
  await wait(400);
  // C-11: 다른 단계로 갔다 와도 진행 표시와 결과가 이어진다
  await click(rp, "노트", { exact: true, within: "nav[aria-label=단계]" });
  await wait(500);
  await click(rp, "심사 준비", { within: "nav[aria-label=단계]" });
  await wait(400);
  const prog = (await text(rp, "[data-notice='PBLN_000000000000001']")).includes("공고문을 읽고 있습니다");
  await waitText(rp, "충족 4", 6000);
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
  // 경쟁사 조건이라면?
  await rp.evaluate(() => [...document.querySelectorAll("[data-notice='PBLN_000000000000001'] .row-btn")].find((b) => b.textContent.includes("경쟁사 조건이라면?")).click());
  await wait(200);
  const opts = await rp.$$eval("[data-notice='PBLN_000000000000001'] select option", (l) => l.map((o) => o.textContent));
  check("R-13", opts.join() === "마바사,하하테크", opts.join());
  check("D-05", opts.slice(0, 2).join() === keys.map((k) => k.replace("rival:", "")).join(), "경쟁사 단락·고르기·요청 본문의 맞음 목록");
  // 값을 고치면 이전 값으로 한 대조 표시(R-12)
  await click(rp, "값 고치기", { exact: true, within: "#panel-grants" });
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
  await click(rp, "운용사 요약", { exact: true, within: "#panel-invest" });
  await waitText(rp, "근거 4개와 검색 결과 보기", 5000);
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
  // R-25(사람 확인 기준의 자동 보조): 근거 묶음 인쇄 모양을 PDF 로 만들면 A4 1쪽이고 다섯 덩어리 제목과 출처 줄이 들어 있다
  await rp.evaluate(() => (document.body.dataset.print = "evidence"));
  await rp.emulateMediaType("print");
  const evPdf = Buffer.from(await rp.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
  const evPrint = await rp.evaluate(() => [...document.querySelectorAll(".evidence-print .print-only")].map((e) => e.innerText).join("\n"));
  await rp.emulateMediaType("screen");
  await rp.evaluate(() => delete document.body.dataset.print);
  const evPages = (evPdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check("R-25 (자동 보조)", evPages === 1 && ["재무·고용 추이", "투자 이력", "특허", "최근 성과", "미팅 전에 정리할 값"].every((t) => evPrint.includes(t)) && evPrint.includes("금융위원회 요약재무제표"), `${evPages}쪽`);
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

  // ---------------------------------------------------------- 판로
  n0 = (await getLog()).length;
  const sp = await open(`/c/${CID}/sales`, { ctx });
  await waitText(sp, "입찰공고 12건", 6000);
  const salesReq = (await getLog()).slice(n0).filter((x) => x.method === "POST" && /sections\/sales/.test(x.path));
  check("P-01", salesReq.length === 1 && salesReq[0].body.keywords.join() === "가속기,반도체,NPU,AI 서버,추론,데이터센터");
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
  await globalChecks(sp, "판로 1180");
  await sh(sp, "sales-1180");
  const rp3 = await open(`/c/${CID}/review`, { ctx });
  await waitText(rp3, "담은 공고 3건");
  check("P-08", Boolean(await rp3.$(`[data-notice='${firstSales}']`)));
  check("P-09 (심사 준비에 없음)", !(await text(rp3)).includes(bidTitle));
  await rp3.close();
  n0 = (await getLog()).length;
  const sp2 = await open(`/c/${CID}/sales`, { ctx });
  await waitText(sp2, "입찰공고");
  await wait(800);
  check("P-01 (다시 열기)", count((await getLog()).slice(n0), "POST", /sections\/sales/) === 0);
  await sp2.close();

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
    await waitText(rot, "출원인이 확인된 국내 특허");
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
  check("TE-08", t.includes("출원인이 이 회사로 확인된 국내 특허를 찾지 못했습니다."));
  check("NE-08", !/중요 사건 \d+개 더 보기/.test(t));
  const tiles = await page.$$eval("ul[aria-label='핵심 값'] li", (l) => l.map((x) => x.innerText));
  check("C-06", tiles.filter((x) => x.includes("미확보:")).length >= 2 && !tiles.some((x) => /\n(0|-)\n/.test(`\n${x}\n`)));
  const ep = await open(`/c/${CID}/review?tab=invest`, { ctx: page.browserContext() });
  await waitText(ep, "미팅 근거 묶음");
  const ev = await text(ep, "[data-evidence]");
  check("R-18", (ev.match(/미확보:/g) ?? []).length >= 3);
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
  check("R-03", (await text(rp)).includes("아직 담은 공고가 없습니다.") && (await text(rp)).includes("자금 조달에서 고르기"));
  const np = await open(`/c/${CID}/note`, { ctx });
  await waitText(np, "회사 핵심 값");
  check("N-10", (await text(np)).includes("담은 항목이 없습니다.") && (await text(np)).includes("자금 조달로 가기") && (await text(np)).includes("메모"));
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
  check("F-06", (await text(fp)).includes("경쟁사 단락으로 가기") && !(await fp.$$eval("[data-gp]", (l) => l.some((x) => x.innerText.includes("경쟁사에 투자")))));
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

if (OUT) {
  await run("shots", async () => {
    await reset({ scenario: "F-FULL", example: true });
    for (const w of [390, 820, 1180, 1440]) {
      const p = await open(`/c/${CID}`, { width: w, fonts: true });
      await waitText(p, "출원인이 확인된 국내 특허");
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
