// 경쟁사 분석 비교 표(screens 4B.2): 우리 회사(합친 회사 값)와 경쟁사(rivals_deep 결과)를 같은 항목 7줄로 나란히 둔다.
// 칸마다 값·기준·상태 낱말·짧은 출처를 붙이고, 값이 없으면 "미확보"와 사유를 둔다.
// 점수·순위·차이·합계는 만들지 않는다(CLAUDE.md 데이터 규칙). 값 크기로 정렬하지 않는다. 화면과 상관없는 순수 함수라 가짜 응답으로 바로 시험한다.
// 칸의 원문 링크(screens 4B.2, 2026-11-23): 받은 자료에 http·https 주소가 있는 칸만 links 를 갖는다. 주소를 만들어 내지 않는다.
import type { AnalysisJob, FhSummary, MergedInvestor, Patent, RivalDeep, RivalPatent, Round, Value } from "./contract.ts";
import type { Edits } from "./company-values.ts";
import { byCurrencyTexts, moneyText, num, safeUrl, stageKo, wonDisplay } from "./format.ts";
import { PATENT_LABEL, isTerminal, type Word } from "./view.ts";

export type CompareItem = "founded" | "revenue" | "nps" | "funding" | "latest" | "patents" | "investors";
/**
 * 줄 순서: 앞 4줄은 회사 분석 핵심 값 띠와 같은 매출·국민연금 가입자·누적 투자·검색으로 확인한 특허(core), 뒤 3줄은 최근 라운드·주요 투자자·설립.
 * 좁은 화면은 앞 4줄만 1층에 두고 뒤 3줄은 펼쳐 본다(screens 4B.2)
 */
export const COMPARE_ITEMS: readonly { key: CompareItem; label: string; core: boolean }[] = [
  { key: "revenue", label: "매출", core: true },
  { key: "nps", label: "국민연금 가입자", core: true },
  { key: "funding", label: "누적 투자", core: true },
  { key: "patents", label: PATENT_LABEL, core: true },
  { key: "latest", label: "최근 라운드", core: false },
  { key: "investors", label: "주요 투자자", core: false },
  { key: "founded", label: "설립", core: false },
];

/** 칸의 원문 한 건. url 은 safeUrl 을 거친 http·https 주소. title: 표 아래 목록의 링크 글, note: 그 뒤 작은 기준 글 */
export type CellLink = { url: string; title: string; note: string | null };

export type Cell =
  /** lines: 값(통화가 여럿이면 여러 줄), basis: 칸 안 기준 글, source: 짧은 출처(기관 이름), links: 원문(주소가 있을 때만 키가 있다) */
  | { kind: "value"; lines: string[]; basis: string | null; word: Word; source: string; links?: CellLink[] }
  /** 엇갈림: 두 값을 접지 않고 함께(screens 1.3 규칙 3). 주소가 있는 값만 link 키가 있다 */
  | { kind: "conflict"; alts: { text: string; source: string; link?: CellLink }[] }
  | { kind: "missing"; reason: string }
  | { kind: "pending" };

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};
/** 원문 후보 → 링크 목록: http·https 가 아닌 주소는 버리고, 같은 주소는 한 번만(처음 것) */
function linksOf(items: readonly { url: string | null | undefined; title: string | null | undefined; note?: string | null }[]): CellLink[] {
  const seen = new Set<string>();
  const out: CellLink[] = [];
  for (const it of items) {
    const url = safeUrl(it.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: (it.title ?? "").trim() || hostOf(url), note: it.note?.trim() || null });
  }
  return out;
}
/** 값 칸에 링크를 붙인다(없으면 칸 그대로, 키도 더하지 않는다) */
const withLinks = (c: Cell, links: CellLink[]): Cell => (c.kind === "value" && links.length ? { ...c, links } : c);
/** 칸이 가진 원문 전부(엇갈림이면 값마다의 원문). 표 아래 목록과 시험이 쓴다 */
export const cellLinks = (c: Cell): CellLink[] =>
  c.kind === "value" ? c.links ?? [] : c.kind === "conflict" ? c.alts.flatMap((a) => (a.link ? [a.link] : [])) : [];

const roundLinks = (rounds: readonly Round[]) =>
  linksOf(rounds.flatMap((r) => r.sources.map((s) => ({ url: s.url, title: s.label, note: [r.round ? stageKo(r.round) : null, r.date].filter(Boolean).join(" ") }))));
const patentLinks = (pats: readonly (Patent | RivalPatent)[]) =>
  linksOf(pats.map((p) => ({ url: p.url, title: p.title, note: [p.registrationNo ?? p.publicationNo, p.filingDate ? `${p.filingDate} 출원` : null, p.registrationNo ? "등록" : "공개"].filter(Boolean).join(", ") })));
const sourceNote = (s: { asOf: string | null; basis: string | null } | null | undefined) => [s?.asOf, s?.basis].filter(Boolean).join(", ") || null;
const valueLinks = (v: Value | null | undefined) => linksOf(v?.source ? [{ url: v.source.url, title: v.source.label, note: sourceNote(v.source) }] : []);
const investorLinks = (shown: readonly MergedInvestor[]) => linksOf(shown.flatMap((i) => i.sources.map((s) => ({ url: s.url, title: i.name, note: s.label }))));

export type CompareColumn = { key: string; name: string; mine: boolean; cells: Record<CompareItem, Cell> };

/** 표 아래 각주(묶음 출처 줄). 칸에는 짧은 출처만 둔다. 어디서 왔는지만 쓰고, 읽을 때 주의할 점은 COMPARE_LIMITS 로 따로 둔다 */
export const COMPARE_SOURCES: readonly string[] = [
  "매출: 금융위원회 요약재무제표 (공공 API). 우리 회사 매출이 웹 조사 값이면 Liner 웹 검색",
  "국민연금 가입자: 국민연금공단 사업장 가입자 (공공 API)",
  "누적 투자·최근 라운드·주요 투자자: People Data Labs (Liner Premium)와 기사",
  `${PATENT_LABEL}: 특허 공개 원문 (Google Patents). 후보 문서는 Liner 웹 검색`,
  "설립: 금융위원회 기업기본정보 (공공 API)",
];

/**
 * 표 아래 "항목별 한계"(screens 4B.2, 2026-11-23 사용자 지시): 숫자를 읽을 때 알아야 할 한계를 출처와 따로 둔다.
 * 항목과 순서는 COMPARE_SOURCES 와 같다. 근거는 코드로 확인되는 사실만:
 * - 매출: 회사마다 매출이 있는 마지막 사업연도(growth/merge.py revenue.official, 위 rivalColumn), 같은 해 연결·별도가 모두 있으면 연결
 *   (growth/public_data.py pick_recent_years), 우리 회사 금융위원회 재무가 없으면 웹 조사 값(myColumn revenue)
 * - 국민연금 가입자: 상시근로자 수와 다름(계약 7.6 note), 사업장이 여럿이면 한 곳(public_data.nps_monthly), 가입자 수가 있는 마지막 달
 * - 투자: People Data Labs 회사 카드와 기사 라운드(growth/funding_history.py 머리 주석), 라운드 합산은 금액이 있는 라운드만·통화 환산 없음(cumulative)
 * - 특허: 회사마다 검색 2회·원문 최대 30건·출원인 확인(growth/patents.py), 미공개 출원(약 18개월)·검색에 걸리지 않은 특허는 빠짐.
 *   다시 받으면 달라짐은 예시 회사 경쟁사 한 곳이 다시 받았을 때 5건 → 6건(사용자 확인, 2026-11-23)
 * - 설립: 금융위원회 기업기본정보 법인 설립일(public_data enpEstbDt). 우리 회사만 웹 조사 값과 견줘 다르면 엇갈림이고, 금융위원회 설립일이 없으면
 *   (법인 없음 등) facts 가 끝난 뒤 웹 조사 값만 둔다(growth/merge.py 설립 7.3, _web_value). 경쟁사는 금융위원회 값만(rivalColumn founded).
 *   합병 뒤 존속법인은 법인 설립일과 창업 시점이 다르다(예시 회사, docs/submission/demo-video-script.md)
 * - 직접 입력: 우리 회사 매출·설립 칸은 이 브라우저에서 고친 값이면 그 값과 "직접 입력"이다(edited, 출처 "이 브라우저"). 자료 값이 아니므로
 *   매출·설립 줄 끝에 같은 꼬리 문장으로 적는다
 */
export const COMPARE_LIMITS: readonly { label: string; text: string }[] = [
  {
    label: "매출",
    text: "회사마다 매출이 있는 가장 최근 사업연도를 써서 연도가 다를 수 있습니다(칸에 연도). 같은 해에 연결·별도가 모두 있으면 연결을 씁니다. 우리 회사에 금융위원회 재무가 없으면 웹 조사 값이라 공식 재무제표 값이 아닙니다. 우리 회사 칸이 ‘직접 입력’이면 이 브라우저에서 고친 값입니다.",
  },
  {
    label: "국민연금 가입자",
    text: "국민연금 가입자 수라서 직원 수(상시근로자 수)와 다릅니다. 사업장이 여럿이면(지점 등) 한 곳 자료만 씁니다. 회사마다 가입자 수가 있는 마지막 달을 써서 달이 다를 수 있습니다(칸에 달).",
  },
  {
    label: "누적 투자·최근 라운드·주요 투자자",
    text: "People Data Labs와 기사에 공개된 라운드만 봅니다. 빠진 라운드가 있을 수 있습니다. 라운드 금액을 더한 누적은 금액이 공개된 라운드만 더합니다(칸 기준에 표시). 통화는 바꾸지 않고 통화마다 따로 씁니다.",
  },
  {
    label: PATENT_LABEL,
    text: "회사마다 Liner 웹 검색 2회로 찾은 Google Patents 공개 문서를 원문으로 최대 30건 열어, 출원인이 그 회사로 확인된 것만 셉니다. 회사가 가진 전체 특허 수가 아닙니다. 출원 뒤 약 18개월 동안 공개되지 않은 출원과 검색에 걸리지 않은 특허는 빠지고, 다시 받으면 수가 달라질 수 있습니다.",
  },
  {
    label: "설립",
    text: "금융위원회 기업기본정보의 법인 설립일입니다. 합병·법인 전환 등이 있으면 실제 창업 시점과 다를 수 있습니다. 우리 회사는 웹 조사 값이 다르면 두 값을 함께 두고(엇갈림), 금융위원회 설립일이 없으면 웹 조사 값입니다. 경쟁사는 금융위원회 값만 봅니다. 우리 회사 칸이 ‘직접 입력’이면 이 브라우저에서 고친 값입니다.",
  },
];

const missing = (reason: string | null | undefined, fallback: string): Cell => ({ kind: "missing", reason: (reason ?? "").trim() || fallback });
/** 특허 칸 기준 글: 무엇을 센 수인지("출원인 확인")와 등록 건수(등록 수를 모르면 앞부분만) */
const patentBasis = (registered: number | null | undefined) => `출원인 확인${typeof registered === "number" ? `, 등록 ${registered}건` : ""}`;
const shortSource = (v: Value) => v.source?.org || v.source?.kind || v.source?.name || "";
const edited = (e: Edits | undefined, k: "founded" | "revenue"): Cell | null => {
  const v = e?.[k]?.value?.trim();
  return v ? { kind: "value", lines: [v], basis: null, word: "edited", source: "이 브라우저" } : null;
};

/** 합친 회사 값 하나 → 칸. null 이면 아직 확인 중. links 를 주면 값의 출처 주소 대신 그 원문을 단다(검색으로 확인한 특허: 특허 낱건) */
function fromValue(v: Value | null | undefined, basis: (v: Value) => string | null, fallback: string, links?: CellLink[]): Cell {
  if (!v) return { kind: "pending" };
  if (v.status === "unavailable") return missing(v.reason, fallback);
  if (v.status === "conflicting")
    return {
      kind: "conflict",
      alts: (v.values ?? []).map((a) => {
        const [link] = linksOf(a.source ? [{ url: a.source.url, title: a.source.label, note: sourceNote(a.source) }] : []);
        return { text: a.display, source: a.source?.org || a.source?.name || "", ...(link ? { link } : {}) };
      }),
    };
  return withLinks({ kind: "value", lines: [v.display ?? ""], basis: basis(v), word: v.status, source: shortSource(v) }, links ?? valueLinks(v));
}

/** 투자 라운드 자료의 출처: Premium 은 People Data Labs, 웹 보완은 기사 */
function fundingSource(rounds: readonly Round[]): string {
  const types = new Set(rounds.flatMap((r) => r.sources.map((s) => s.type)));
  const out = [types.has("Premium") || !types.size ? "People Data Labs" : "", types.has("Web") ? "기사" : ""].filter(Boolean);
  return out.join(", ");
}

/**
 * 투자 칸 하나의 짧은 출처 글과 원문 링크를 **같은 라운드 묶음**에서 만든다(screens 4B.2 "투자 칸의 짧은 출처는 원문 링크와 같은 라운드에서", 2026-11-23 사용자 지시).
 * 전에는 출처 글이 그 회사의 모든 라운드 출처를 합쳐, 다른 라운드의 기사 때문에 "기사"가 붙고 그 칸에는 기사 링크가 없었다.
 * 짝이 되는 라운드가 없으면(part 가 빔) 출처 글은 그 회사 라운드 전체 기준(전과 같은 규칙)으로 두고 링크는 달지 않는다
 */
const roundsSourced = (c: Cell, part: readonly Round[], all: readonly Round[]): Cell =>
  c.kind === "value" ? withLinks({ ...c, source: fundingSource(part.length ? part : all) }, roundLinks(part)) : c;

/** 빈 글·없음을 null 하나로(라운드와 summary.latest 의 날짜·단계를 견줄 때) */
const blank = (s: string | null | undefined) => (s ?? "").trim() || null;
/**
 * summary.latest 가 가리키는 라운드인가: 날짜(없으면 보도 날짜)와 단계가 같다. 서버의 latest.date 는 date or reported_date 라서
 * (growth/funding_history.summarize) 날짜 없이 보도 날짜만 있는 라운드도 보도 날짜로 짝을 맞춘다
 */
export const isLatestRound = (r: Round, l: { date: string | null; round: string | null }) =>
  blank(blank(r.date) ?? r.reportedDate) === blank(l.date) && blank(r.round) === blank(l.round);

/**
 * 누적 투자 칸은 라운드 전체, 최근 라운드 칸은 summary.latest 가 가리키는 라운드(isLatestRound)에서 출처 글과 원문을 함께 만든다
 * (roundsSourced: 같은 라운드가 없으면 출처 글은 전체 라운드 기준, 링크 없음). 우리 회사 열과 경쟁사 열이 같이 쓴다
 */
function fundingCells(summary: FhSummary, rounds: readonly Round[]): { funding: Cell; latest: Cell } {
  const amounts = byCurrencyTexts(summary.cumulative.byCurrency);
  const funding: Cell = amounts.length
    ? { kind: "value", lines: amounts, basis: summary.cumulative.label || null, word: "reported", source: "" }
    : { kind: "value", lines: [`라운드 ${summary.roundCount}건`], basis: "금액 미공개", word: "reported", source: "" };
  const l = summary.latest;
  const latest: Cell = l
    ? roundsSourced(
        { kind: "value", lines: [`${stageKo(l.round)} ${l.amount ?? "금액 미공개"}`], basis: l.date ?? "날짜 미상", word: "reported", source: "" },
        rounds.filter((r) => isLatestRound(r, l)),
        rounds,
      )
    : missing(null, "최근 라운드 자료 없음");
  return { funding: roundsSourced(funding, rounds, rounds), latest };
}

/** 이름 앞 3곳 + "외 n곳" */
const firstNames = (names: readonly string[]) => `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` 외 ${names.length - 3}곳` : ""}`;

/** 우리 회사 열. 회사 분석이 아직 그 값을 확인 중이면 "확인 중" 칸 */
export function myColumn(job: AnalysisJob, edits?: Edits): CompareColumn {
  const m = job.merged;
  const s = job.sections;
  const off = m.revenue.official;
  const web = m.revenue.web;
  const revenue: Cell =
    edited(edits, "revenue") ??
    (!off
      ? { kind: "pending" }
      : off.status !== "unavailable"
        ? fromValue(off, (v) => [v.source?.asOf, v.source?.basis].filter(Boolean).join(", ") || null, "공식 재무 자료 없음")
        : web && web.status !== "unavailable"
          ? fromValue(web, () => null, "재무 자료 없음")
          : web === null
            ? { kind: "pending" }
            : missing(off.reason, "공식 재무 자료 없음"));

  const fh = s.funding_history;
  let funding: Cell = { kind: "pending" };
  let latest: Cell = { kind: "pending" };
  if (isTerminal(fh)) {
    const r = fh.result;
    if (!r || !r.summary.roundCount) funding = latest = missing(null, "투자 라운드 자료 없음");
    else ({ funding, latest } = fundingCells(r.summary, r.rounds));
  }

  const firm = m.investors.filter((i) => i.status === "confirmed" || i.status === "reported");
  const shown = firm.slice(0, 3);
  // 주요 투자자 칸의 원문은 칸에 보인 앞 3곳의 출처 주소만(상태 낱말·짧은 출처와 같은 범위)
  const investors: Cell = firm.length
    ? withLinks(
        {
          kind: "value",
          lines: [firstNames(firm.map((i) => i.name))],
          basis: null,
          word: shown.every((i) => i.status === "confirmed") ? "confirmed" : "reported",
          source: [...new Set(shown.flatMap((i) => i.sources.map((x) => x.org || x.name)).filter(Boolean))].slice(0, 2).join(", "),
        },
        investorLinks(shown),
      )
    : !isTerminal(fh) || m.pending.includes("investors.confirmed")
      ? { kind: "pending" }
      : missing(null, "투자기관 이름 자료 없음");

  const reg = s.patents.result?.summary.registered;
  // 검색으로 확인한 특허 칸의 원문은 patents 단락 낱건(출원인 원문 확인 특허)의 주소. 합친 값 자체의 출처 주소는 쓰지 않는다.
  // 기준 글은 핵심 값 칸(view.ts)과 같은 "출원인 확인, 등록 {r}건"(복사·화면 읽기 한 줄 글에도 무엇을 센 수인지 남게)
  const patents = fromValue(m.patentCount, () => patentBasis(reg), "출원인이 확인된 특허를 찾지 못함", patentLinks(s.patents.result?.patents ?? []));
  return {
    key: "mine",
    name: job.company.name,
    mine: true,
    cells: {
      founded: edited(edits, "founded") ?? fromValue(m.founded, () => null, "설립일 자료 없음"),
      revenue,
      nps: fromValue(m.npsLatest, (v) => v.source?.asOf ?? null, "국민연금 사업장을 찾지 못함"),
      funding,
      latest,
      patents,
      investors,
    },
  };
}

/** 경쟁사 열(rivals_deep 결과 한 곳) */
export function rivalColumn(r: RivalDeep): CompareColumn {
  const fin = [...r.financials].reverse().find((f) => f.revenue !== null);
  const nps = r.nps?.monthly.filter((x) => x.members !== null).at(-1);
  const f = r.funding;
  const fc = f && f.summary.roundCount ? fundingCells(f.summary, f.rounds) : null;
  const noFunding = missing(r.fundingReason, "투자 라운드 자료 없음");
  return {
    key: r.key,
    name: r.name,
    mine: false,
    cells: {
      founded: !r.corp ? missing(null, "법인이 확인되지 않음") : r.corp.founded ? { kind: "value", lines: [r.corp.founded], basis: null, word: "confirmed", source: "금융위원회" } : missing(null, "설립일 자료 없음"),
      revenue: fin
        ? {
            kind: "value",
            lines: [!fin.currency || fin.currency === "KRW" ? wonDisplay(fin.revenue!) : moneyText(fin.revenue!, fin.currency)],
            basis: `${fin.year} 사업연도${fin.basisShort ? `, ${fin.basisShort}` : ""}`,
            word: "confirmed",
            source: "금융위원회",
          }
        : missing(r.financialsReason, "재무 자료 없음"),
      nps: nps ? { kind: "value", lines: [`${num(nps.members!)}명`], basis: nps.month, word: "reference", source: "국민연금공단" } : missing(r.npsReason, "국민연금 자료 없음"),
      funding: fc ? fc.funding : noFunding,
      latest: fc ? fc.latest : noFunding,
      // 특허 낱건(items)은 원문 링크 기록 전에 받은 비교 자료에는 없다(null·키 없음) → 링크 없음
      patents: !r.patents
        ? missing(r.patentsReason, "특허 자료를 확인하지 못함")
        : r.patents.total > 0
          ? withLinks({ kind: "value", lines: [`${r.patents.total}건`], basis: patentBasis(r.patents.registered), word: "confirmed", source: "Google Patents" }, patentLinks(r.patents.items ?? []))
          : missing(null, "출원인이 확인된 특허를 찾지 못함"),
      // 라운드는 있는데 투자기관 이름이 없으면 그 사유를 정확히 쓴다(우리 회사 열과 같은 문구). 출처 글과 원문은 칸에 보인 앞 3곳이 든 라운드에서(roundsSourced)
      investors:
        f && f.investors.length
          ? roundsSourced(
              { kind: "value", lines: [firstNames(f.investors)], basis: null, word: "reported", source: "" },
              f.rounds.filter((x) => x.investors.some((n) => f.investors.slice(0, 3).includes(n))),
              f.rounds,
            )
          : fc
            ? missing(null, "투자기관 이름 자료 없음")
            : noFunding,
    },
  };
}

/** 표 열: 우리 회사 → 비교한 경쟁사(rivalSet 순서, 고른 순서). 값 크기로 다시 정렬하지 않는다 */
export function compareColumns(job: AnalysisJob, edits?: Edits): CompareColumn[] {
  const deep = job.sections.rivals_deep.result;
  const mine = myColumn(job, edits);
  if (!deep) return [mine];
  const order = new Map(deep.rivalSet.map((k, i) => [k, i]));
  const rivals = [...deep.rivals].sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
  return [mine, ...rivals.map(rivalColumn)];
}

/** 칸의 글(화면 읽기·복사·시험용 한 줄). 원문 링크는 넣지 않는다(값만, screens 4B.2) */
export function cellText(c: Cell): string {
  if (c.kind === "pending") return "확인 중";
  if (c.kind === "missing") return `미확보: ${c.reason}`;
  if (c.kind === "conflict") return c.alts.map((a, i) => `${i ? "다른 자료: " : ""}${a.text}${a.source ? ` (${a.source})` : ""}`).join(" / ");
  return [c.lines.join(", "), c.basis].filter(Boolean).join(", ");
}
