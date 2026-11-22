// 화면 글 만들기(시각·날짜·금액·단계 이름). 화면 상태와 상관없는 순수 함수라 node --test 로 바로 시험한다.
// 서버 시각은 언제나 한국 시간(+09:00) ISO 글이라, 시간대를 바꾸지 않고 글자를 잘라 쓴다.

/** "2026-11-22T20:46:24+09:00" → "2026-11-22 20:46" */
export const fmtTime = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "");
/** → "2026-11-22" */
export const fmtDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
/** → "11-22 20:46" */
export const fmtMonthDayTime = (iso: string | null | undefined) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : "");
/** "2026-11-22" → "11.22" (앞 0 없이) */
export const fmtMD = (day: string | null | undefined) => (day && day.length >= 10 ? `${Number(day.slice(5, 7))}.${Number(day.slice(8, 10))}` : "");

/** 오늘 날짜(한국 시간) "YYYY-MM-DD". 테스트는 now 를 넘긴다. */
export function todayKST(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 9 * 3600_000);
  return t.toISOString().slice(0, 10);
}

/** 분석 시각부터 지금까지 지난 날 수(내림). */
export function daysSince(iso: string, now: Date = new Date()): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.floor((now.getTime() - t) / 86_400_000);
}
export const STALE_DAYS = 30;
export const isStale = (iso: string | null | undefined, now: Date = new Date()) => Boolean(iso) && daysSince(iso as string, now) > STALE_DAYS;

/** 설립일("YYYY-MM-DD" 또는 "YYYY-MM")부터 오늘까지 만 연수. 날짜가 아니면 null. */
export function yearsSince(founded: string | null | undefined, today: string): number | null {
  if (!founded || !/^\d{4}-\d{2}/.test(founded)) return null;
  const [fy, fm, fd = 1] = founded.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let years = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) years -= 1;
  return years < 0 ? null : years;
}
export const ageLabel = (years: number | null) => (years === null ? null : years < 1 ? "업력 1년 미만" : `업력 ${years}년`);

const one = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
/** 원 → 억원 숫자 글(소수 첫째 자리). 5,670,000,000 → "56.7" */
export const eok = (won: number) => one.format(won / 1e8);
/** 끝의 ".0" 을 뗀 억원 글. 30,000,000,000 → "300" */
const eokTrim = (won: number) => eok(won).replace(/\.0$/, "");

/** 계약 7.5 won_display: 1천만 원 이상은 "56.7억원", 미만은 "300만원" */
export function wonDisplay(won: number): string {
  if (Math.abs(won) >= 1e7) return `${eok(won)}억원`;
  return `${whole.format(won / 1e4)}만원`;
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", JPY: "¥", GBP: "£", CNY: "CN¥" };
/** 통화별 금액(통화를 바꾸지 않는다). USD 250,000,000 → "$250.0M", KRW 30,000,000,000 → "300억원" */
export function moneyText(amount: number, currency: string): string {
  if (currency === "KRW") return Math.abs(amount) >= 1e7 ? `${eokTrim(amount)}억원` : `${whole.format(amount / 1e4)}만원`;
  const sym = SYMBOL[currency] ?? `${currency} `;
  if (Math.abs(amount) >= 1e9) return `${sym}${(amount / 1e9).toFixed(1)}B`;
  if (Math.abs(amount) >= 1e6) return `${sym}${(amount / 1e6).toFixed(1)}M`;
  return `${sym}${whole.format(amount)}`;
}
/** 통화별 합을 통화마다 따로 글로. 더하지 않는다. */
export const byCurrencyTexts = (byCurrency: Record<string, number> | null | undefined) =>
  Object.entries(byCurrency ?? {}).map(([cur, v]) => moneyText(v, cur));

/** 투자 단계 원래 표기 → 우리말(screens 4.3). 표에 없는 표기는 그대로 */
export function stageKo(round: string | null | undefined): string {
  if (!round) return "단계 미공개";
  const r = round.trim();
  const low = r.toLowerCase();
  if (low === "seed") return "시드";
  if (low === "pre-seed" || low === "pre seed") return "프리시드";
  const series = /^series\s+([a-z])$/i.exec(r);
  if (series) return `시리즈 ${series[1].toUpperCase()}`;
  if (low === "corporate round") return "기업 투자";
  if (low === "undisclosed series" || low === "undisclosed") return "단계 미공개";
  return r;
}

/** 오늘부터 그날까지 남은 날 수. */
export const daysUntil = (day: string, today: string) => Math.round((Date.parse(day.slice(0, 10)) - Date.parse(today)) / 86_400_000);

/** http·https 주소만 링크로 쓴다(G-12). 그 밖이면 null */
export const safeUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\/[^\s]+$/i.test(u.trim()) ? u.trim() : null);

/** 경과 초 → "14초" / "1분 12초" */
export function elapsedText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}초`;
  return `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ""}`;
}

/** 부호를 붙인 증감. 28 → "+28", -3 → "−3" */
export const signed = (n: number) => (n > 0 ? `+${whole.format(n)}` : n < 0 ? `−${whole.format(Math.abs(n))}` : "0");
export const num = (n: number) => whole.format(n);

/** "YYYY-MM-DD" → "YYYYMMDD" */
export const compactDay = (day: string) => day.replace(/-/g, "").slice(0, 8);
