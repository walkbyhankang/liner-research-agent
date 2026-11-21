// 자금 찾기 화면의 사용자 경험 지표를 브라우저로 측정한다.
// 실행: node scripts/ux-audit.mjs [기준 주소] (기본 http://localhost:3100, 서버가 떠 있어야 한다)
// 크롬 경로는 CHROME_PATH 로 바꿀 수 있다.
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:3100";
const executablePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath, headless: true });

async function measure(label, viewport) {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewport(viewport);
  const t0 = Date.now();
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main h3", { timeout: 15000 });
  const msToFirstResult = Date.now() - t0;
  await wait(400);
  const m = await page.evaluate(() => {
    const vh = window.innerHeight;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const cards = [...document.querySelectorAll("main h3")].filter(visible);
    const cardBox = (h) => (h.closest("section") ?? h.parentElement).getBoundingClientRect();
    const heights = cards.slice(0, 8).map((h) => Math.round(cardBox(h).height));
    const fund = [...document.querySelectorAll("main h2, main button, main [role=tab]")].filter(visible).find((e) => e.textContent.includes("투자 운용사"));
    const controls = [...document.querySelectorAll("main a, main button, main select, main input, main summary, header a")].filter(visible);
    const small = controls.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.height < 40;
    });
    const text = document.querySelector("main").innerText;
    const tiny = [...document.querySelectorAll("main p, main span, main li, main a, main button")].filter((e) => visible(e) && parseFloat(getComputedStyle(e).fontSize) < 12).length;
    return {
      firstResultTop: Math.round(cards[0].getBoundingClientRect().top),
      resultsFullyInFirstView: cards.filter((h) => cardBox(h).bottom <= vh).length,
      resultsStartedInFirstView: cards.filter((h) => h.getBoundingClientRect().top < vh).length,
      medianCardHeight: heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)],
      fundSectionScreensAway: fund ? Math.round((fund.getBoundingClientRect().top / vh) * 10) / 10 : null,
      controls: controls.length,
      controlsUnder40px: small.length,
      textUnder12px: tiny,
      dDayBadges: (text.match(/D-\d+|오늘 마감/g) ?? []).length,
      hasDeadlineFilter: /마감 임박/.test(text),
      hasSave: [...document.querySelectorAll("main button")].some((b) => /저장/.test(b.textContent)),
      hasGlossary: /용어 풀이/.test(text),
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  // 조건을 바꾼 뒤 주소로 공유되는지, 새로 열어도 유지되는지
  const firstSelect = await page.$("main select");
  await firstSelect.select("서울");
  await wait(400);
  m.urlCarriesCondition = decodeURIComponent(page.url()).includes("서울");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("main h3", { timeout: 15000 });
  await wait(300);
  m.conditionKeptAfterReload = (await page.$eval("main select", (s) => s.value)) === "서울";
  m.msToFirstResult = msToFirstResult;
  m.consoleErrors = errors.length;
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.close();
  return { label, viewport: `${viewport.width}x${viewport.height}`, ...m };
}

const out = [await measure("desktop", { width: 1280, height: 800 }), await measure("mobile", { width: 390, height: 844, isMobile: true, hasTouch: true })];
console.log(JSON.stringify(out, null, 2));
await browser.close();
