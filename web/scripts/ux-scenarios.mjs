// 경영자 시나리오 네 가지를 실제 화면에서 따라 하며, 필요한 조작 횟수와 결과를 기록하고 화면을 찍는다.
// 실행: node scripts/ux-scenarios.mjs <스크린샷 폴더> [기준 주소]
import puppeteer from "puppeteer-core";

const out = process.argv[2] ?? ".";
const base = process.argv[3] ?? "http://localhost:3100";
const executablePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath, headless: true });
const report = [];

async function open(viewport, path = "/") {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewport(viewport);
  await page.goto(base + path, { waitUntil: "networkidle0" });
  await page.waitForSelector("main h3");
  await wait(300);
  let actions = 0;
  const pick = async (label, value) => {
    await page.select(`main select[aria-label="${label}"]`, value);
    actions += 1;
    await wait(250);
  };
  const tap = async (text, scope = "main") => {
    const ok = await page.evaluate(
      (t, sc) => {
        const visible = (e) => e.getBoundingClientRect().width > 0;
        const el = [...document.querySelectorAll(`${sc} button, ${sc} [role=tab]`)].filter(visible).find((e) => e.textContent.trim().startsWith(t));
        if (el) el.click();
        return Boolean(el);
      },
      text,
      scope,
    );
    if (!ok) errors.push(`누를 수 없음: ${text}`);
    actions += 1;
    await wait(250);
  };
  const state = () =>
    page.evaluate(() => {
      const visible = (e) => e.getBoundingClientRect().width > 0;
      const cards = [...document.querySelectorAll("main h3")].filter(visible);
      return {
        cards: cards.length,
        first: cards[0]?.innerText ?? null,
        firstDeadline: cards[0]?.closest("section")?.querySelector("span.rounded-full")?.innerText ?? null,
        firstCardTop: cards[0] ? Math.round(cards[0].getBoundingClientRect().top) : null,
        url: decodeURIComponent(location.search),
      };
    });
  return { ctx, page, errors, pick, tap, state, actions: () => actions };
}

const mobile = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const desktop = { width: 1280, height: 800 };

// 1. 이동 중인 대표: 서울 창업기업, 곧 마감되는 융자·보증이 있는지
{
  const s = await open(mobile);
  await s.pick("지역", "서울");
  await s.tap("마감 임박");
  const found = await s.state();
  await s.page.screenshot({ path: `${out}/s1-mobile-closing-soon.png` });
  await s.tap("자세히");
  await s.tap("☆ 저장");
  await s.page.evaluate(() => window.scrollTo(0, 250));
  await wait(200);
  await s.page.screenshot({ path: `${out}/s1-mobile-detail-saved.png` });
  report.push({ scenario: "1. 모바일 · 서울 창업기업 · 곧 마감되는 융자·보증", actionsToAnswer: 2, actionsTotal: s.actions(), ...found, errors: s.errors });
  await s.ctx.close();
}

// 2. 투자 유치 준비: 경기 AI 스타트업, 연락할 운용사를 골라 팀에 공유
{
  const s = await open(desktop);
  await s.pick("지역", "경기");
  const found = await s.state();
  await s.tap("펀드 ");
  const saves = await s.page.$$('section[aria-label="투자 운용사"] button[aria-pressed="false"]');
  await saves[0].click();
  await saves[1].click();
  await wait(200);
  await s.page.screenshot({ path: `${out}/s2-desktop-gp-list.png` });
  await s.tap("★ 저장한 항목");
  await s.page.evaluate(() => {
    window.__copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => (window.__copied = t) } });
  });
  await s.tap("목록 복사");
  const copied = await s.page.evaluate(() => window.__copied);
  await s.page.screenshot({ path: `${out}/s2-desktop-saved.png` });
  const gpCount = await s.page.evaluate(() => document.body.innerText.match(/저장한 항목 (\d+)건/)?.[1]);
  report.push({
    scenario: "2. 데스크톱 · 경기 AI 스타트업 · 운용사 골라 공유",
    actionsToAnswer: 1, actionsTotal: s.actions() + 2, gpListVisibleWithoutScroll: true, savedShown: gpCount,
    copiedLines: copied.split("\n").length, copiedHasNotice: copied.includes("세부 자격과 접수 여부"), first: found.first, errors: s.errors,
  });
  await s.ctx.close();
}

// 3. 제조 중소기업 재무 담당: 경남, 시설자금 융자를 마감 순으로
let shareUrl = "";
{
  const s = await open(desktop);
  await s.pick("지역", "경남");
  await s.pick("기업 유형", "sme");
  await s.tap("시설자금");
  await s.pick("정렬", "deadline");
  const found = await s.state();
  shareUrl = s.page.url();
  await s.page.screenshot({ path: `${out}/s3-desktop-facility-loan.png` });
  report.push({ scenario: "3. 데스크톱 · 경남 중소기업 · 시설자금 마감순", actionsToAnswer: 3, actionsTotal: s.actions(), ...found, errors: s.errors });
  await s.ctx.close();
}

// 4. 공유받은 링크를 다른 사람이 모바일에서 열기: 같은 조건이 그대로 보이는지
{
  const s = await open(mobile, shareUrl.replace(base, ""));
  const found = await s.state();
  const region = await s.page.$eval('main select[aria-label="지역"]', (e) => e.value);
  const chipOn = await s.page.evaluate(() => [...document.querySelectorAll('main button[aria-pressed="true"]')].map((b) => b.innerText));
  await s.page.screenshot({ path: `${out}/s4-mobile-shared-link.png` });
  await s.tap("투자 운용사");
  await s.page.screenshot({ path: `${out}/s4-mobile-gp-tab.png` });
  report.push({ scenario: "4. 모바일 · 공유 링크 열기", actionsToAnswer: 0, regionRestored: region, activeFilters: chipOn, ...found, errors: s.errors });
  await s.ctx.close();
}

console.log(JSON.stringify(report, null, 2));
await browser.close();
