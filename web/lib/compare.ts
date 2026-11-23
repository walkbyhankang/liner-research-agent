// 경쟁사 분석 비교 표(screens 4B.2): 우리 회사(합친 회사 값)와 경쟁사(rivals_deep 결과)를 같은 항목 7줄로 나란히 둔다.
// 칸마다 값·기준·상태 낱말·짧은 출처를 붙이고, 값이 없으면 "미확보"와 사유를 둔다.
// 점수·순위·차이·합계는 만들지 않는다(CLAUDE.md 데이터 규칙). 값 크기로 정렬하지 않는다. 화면과 상관없는 순수 함수라 가짜 응답으로 바로 시험한다.
import type { AnalysisJob, FhSummary, RivalDeep, Round, Value } from "./contract.ts";
import type { Edits } from "./company-values.ts";
import { byCurrencyTexts, moneyText, num, stageKo, wonDisplay } from "./format.ts";
import { isTerminal, type Word } from "./view.ts";

export type CompareItem = "founded" | "revenue" | "nps" | "funding" | "latest" | "patents" | "investors";
/**
 * 줄 순서: 앞 4줄은 회사 분석 핵심 값 띠와 같은 매출·국민연금 가입자·누적 투자·국내 특허(core), 뒤 3줄은 최근 라운드·주요 투자자·설립.
 * 좁은 화면은 앞 4줄만 1층에 두고 뒤 3줄은 펼쳐 본다(screens 4B.2)
 */
export const COMPARE_ITEMS: readonly { key: CompareItem; label: string; core: boolean }[] = [
  { key: "revenue", label: "매출", core: true },
  { key: "nps", label: "국민연금 가입자", core: true },
  { key: "funding", label: "누적 투자", core: true },
  { key: "patents", label: "국내 특허", core: true },
  { key: "latest", label: "최근 라운드", core: false },
  { key: "investors", label: "주요 투자자", core: false },
  { key: "founded", label: "설립", core: false },
];

export type Cell =
  /** lines: 값(통화가 여럿이면 여러 줄), basis: 칸 안 기준 글, source: 짧은 출처(기관 이름) */
  | { kind: "value"; lines: string[]; basis: string | null; word: Word; source: string }
  /** 엇갈림: 두 값을 접지 않고 함께(screens 1.3 규칙 3) */
  | { kind: "conflict"; alts: { text: string; source: string }[] }
  | { kind: "missing"; reason: string }
  | { kind: "pending" };

export type CompareColumn = { key: string; name: string; mine: boolean; cells: Record<CompareItem, Cell> };

/** 표 아래 각주(묶음 출처 줄). 칸에는 짧은 출처만 둔다 */
export const COMPARE_SOURCES: readonly string[] = [
  "매출: 금융위원회 요약재무제표 (공공 API). 우리 회사 매출이 웹 조사 값이면 Liner 웹 검색",
  "국민연금 가입자: 국민연금공단 사업장 가입자 (공공 API). 직원 수와 다릅니다",
  "누적 투자·최근 라운드·주요 투자자: People Data Labs (Liner Premium)와 기사",
  "국내 특허: 특허 공개 원문 (Google Patents)",
  "설립: 금융위원회 기업기본정보 (공공 API)",
];

const missing = (reason: string | null | undefined, fallback: string): Cell => ({ kind: "missing", reason: (reason ?? "").trim() || fallback });
const shortSource = (v: Value) => v.source?.org || v.source?.kind || v.source?.name || "";
const edited = (e: Edits | undefined, k: "founded" | "revenue"): Cell | null => {
  const v = e?.[k]?.value?.trim();
  return v ? { kind: "value", lines: [v], basis: null, word: "edited", source: "이 브라우저" } : null;
};

/** 합친 회사 값 하나 → 칸. null 이면 아직 확인 중 */
function fromValue(v: Value | null | undefined, basis: (v: Value) => string | null, fallback: string): Cell {
  if (!v) return { kind: "pending" };
  if (v.status === "unavailable") return missing(v.reason, fallback);
  if (v.status === "conflicting") return { kind: "conflict", alts: (v.values ?? []).map((a) => ({ text: a.display, source: a.source?.org || a.source?.name || "" })) };
  return { kind: "value", lines: [v.display ?? ""], basis: basis(v), word: v.status, source: shortSource(v) };
}

/** 투자 라운드 자료의 출처: Premium 은 People Data Labs, 웹 보완은 기사 */
function fundingSource(rounds: readonly Round[]): string {
  const types = new Set(rounds.flatMap((r) => r.sources.map((s) => s.type)));
  const out = [types.has("Premium") || !types.size ? "People Data Labs" : "", types.has("Web") ? "기사" : ""].filter(Boolean);
  return out.join(", ");
}

function fundingCells(summary: FhSummary, rounds: readonly Round[]): { funding: Cell; latest: Cell } {
  const src = fundingSource(rounds);
  const amounts = byCurrencyTexts(summary.cumulative.byCurrency);
  const funding: Cell = amounts.length
    ? { kind: "value", lines: amounts, basis: summary.cumulative.label || null, word: "reported", source: src }
    : { kind: "value", lines: [`라운드 ${summary.roundCount}건`], basis: "금액 미공개", word: "reported", source: src };
  const l = summary.latest;
  const latest: Cell = l
    ? { kind: "value", lines: [`${stageKo(l.round)} ${l.amount ?? "금액 미공개"}`], basis: l.date ?? "날짜 미상", word: "reported", source: src }
    : missing(null, "최근 라운드 자료 없음");
  return { funding, latest };
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
  const investors: Cell = firm.length
    ? {
        kind: "value",
        lines: [firstNames(firm.map((i) => i.name))],
        basis: null,
        word: shown.every((i) => i.status === "confirmed") ? "confirmed" : "reported",
        source: [...new Set(shown.flatMap((i) => i.sources.map((x) => x.org || x.name)).filter(Boolean))].slice(0, 2).join(", "),
      }
    : !isTerminal(fh) || m.pending.includes("investors.confirmed")
      ? { kind: "pending" }
      : missing(null, "투자기관 이름 자료 없음");

  const reg = s.patents.result?.summary.registered;
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
      patents: fromValue(m.patentCount, () => (typeof reg === "number" ? `등록 ${reg}건` : null), "출원인이 확인된 특허를 찾지 못함"),
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
      patents: !r.patents
        ? missing(r.patentsReason, "특허 자료를 확인하지 못함")
        : r.patents.total > 0
          ? { kind: "value", lines: [`${r.patents.total}건`], basis: `등록 ${r.patents.registered}건`, word: "confirmed", source: "Google Patents" }
          : missing(null, "출원인이 확인된 특허를 찾지 못함"),
      // 라운드는 있는데 투자기관 이름이 없으면 그 사유를 정확히 쓴다(우리 회사 열과 같은 문구)
      investors: f && f.investors.length ? { kind: "value", lines: [firstNames(f.investors)], basis: null, word: "reported", source: fundingSource(f.rounds) } : fc ? missing(null, "투자기관 이름 자료 없음") : noFunding,
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

/** 칸의 글(화면 읽기·복사·시험용 한 줄) */
export function cellText(c: Cell): string {
  if (c.kind === "pending") return "확인 중";
  if (c.kind === "missing") return `미확보: ${c.reason}`;
  if (c.kind === "conflict") return c.alts.map((a, i) => `${i ? "다른 자료: " : ""}${a.text}${a.source ? ` (${a.source})` : ""}`).join(" / ");
  return [c.lines.join(", "), c.basis].filter(Boolean).join(", ");
}
