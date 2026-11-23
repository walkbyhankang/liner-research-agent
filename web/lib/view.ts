// 작업 응답(AnalysisJob)을 화면 단락과 글로 바꾸는 규칙(screens.md 1.5, 4절, 계약 9절).
// 화면 상태와 상관없는 순수 함수라 가짜 응답(fixtures/analysis)으로 바로 시험한다.
import {
  STATUS_LABEL, TERMINAL_SECTION_STATUSES,
  type AnalysisJob, type Merged, type SectionEnvelope, type SectionError, type SectionKey, type Status, type Value,
} from "./contract.ts";
import { byCurrencyTexts, signed, stageKo } from "./format.ts";
import { normName } from "./names.ts";

// ---------------------------------------------------------------- 단락

export type ScreenKey = "overview" | "finance" | "investment" | "news" | "tech";
export type ScreenSection = { key: ScreenKey; label: string; primary: SectionKey };
/**
 * 단락 순서는 언제나 이 순서다(C-14). 주된 서버 단락은 screens 4.0.1.
 * 경쟁사는 2026-11-23 화면 구조 개편으로 단락이 아니라 경쟁사 분석 화면(/c/[id]/rivals, screens 4B)이다
 */
export const SCREEN_SECTIONS: readonly ScreenSection[] = [
  { key: "overview", label: "개요", primary: "profile" },
  { key: "finance", label: "재무·고용", primary: "official" },
  { key: "investment", label: "투자", primary: "funding_history" },
  { key: "news", label: "최근 동향", primary: "news" },
  { key: "tech", label: "기술", primary: "patents" },
];
export const screenLabel = (k: ScreenKey) => SCREEN_SECTIONS.find((s) => s.key === k)!.label;

export type Phase = "loading" | "done" | "partial" | "unavailable" | "idle";
type AnyEnv = SectionEnvelope<unknown>;

export const isTerminal = (env: AnyEnv | null | undefined) => Boolean(env && TERMINAL_SECTION_STATUSES.includes(env.status));

export function phaseOf(env: AnyEnv | null | undefined): Phase {
  if (!env) return "loading";
  if (env.status === "waiting" || env.status === "running") return "loading";
  return env.status;
}

/** 단락 목차 줄의 상태 글(screens 4.0) */
export const TOC_TEXT: Record<Phase, string> = { loading: "확인 중", done: "준비됨", partial: "일부 미확보", unavailable: "미확보", idle: "준비됨" };

/** 진행 중 경과가 예상의 2배를 넘었는가(A-20) */
export const isSlow = (env: AnyEnv | null | undefined, extra = 0) =>
  Boolean(env && env.expectedSeconds && env.seconds !== null && env.seconds + extra > env.expectedSeconds * 2);

/** 비교 대상 경쟁사 상한. 서버 계약 2.4 `rivals_deep` 요청 1~5곳과 같다. 경쟁사 분석에서 포함·직접 추가를 이 수에서 막는다(screens 4B.1) */
export const MAX_RIVALS = 5;

/**
 * 경쟁사 비교 자료(rivals_deep) 비용 줄. 서버 예상값은 5곳 기준 호출 수(liner)와 한 곳당 호출 수(perRival)다.
 * 비교 대상 수(1~5)로 바꿔 "Liner 약 {m}회 (비교 대상 {k}곳 기준, 한 곳당 약 {p}회)"로 쓴다. 한 곳당 값이 없으면 5곳 기준 그대로.
 */
export function rivalsCost(est: { liner: number; perRival: number | null }, picked: number): { liner: number; text: string } {
  const k = Math.min(5, Math.max(1, picked));
  if (!est.perRival) return { liner: est.liner, text: `Liner 약 ${est.liner}회 (경쟁사 5곳 기준)` };
  const m = Math.max(0, est.liner - est.perRival * (5 - k));
  return { liner: m, text: `Liner 약 ${m}회 (비교 대상 ${k}곳 기준, 한 곳당 약 ${est.perRival}회)` };
}

/** 미확보 사유 문장(screens 1.5). 코드에 맞는 문장이 없을 때만 서버 문장을 쓴다 */
export function errorSentence(err: SectionError | null | undefined): string {
  if (!err) return "";
  switch (err.code) {
    case "daily_limit": return "오늘 호출 상한에 닿아 이 단락을 확인하지 못했습니다. 내일 0시 이후에 다시 분석할 수 있습니다.";
    case "section_limit": return "이 단락에 정한 호출 수 안에서 자료를 다 확인하지 못했습니다.";
    case "no_corp": return "법인이 확인되지 않아 공식 재무·고용 자료가 없습니다.";
    case "upstream_error": return `${err.source || "바깥 자료"}에서 응답을 받지 못했습니다.`;
    case "timeout": return "정한 시간 안에 응답이 오지 않았습니다.";
    case "interrupted": return "분석이 중간에 멈췄습니다.";
    case "missing_config": return "이 자료를 쓰는 설정이 되어 있지 않습니다.";
    case "no_data": return err.message;
    default: return err.message;
  }
}

/** 단락 다시 분석 단추 모양(계약 5.5): 보임 / 비활성(상한) / 숨김 */
export type RetryState = { kind: "show" } | { kind: "disabled"; note: string } | { kind: "hidden" };
export function retryState(env: AnyEnv | null | undefined): RetryState {
  if (!env) return { kind: "hidden" };
  if (env.retryable) return { kind: "show" };
  const code = env.error?.code ?? env.rerun?.error?.code;
  if (code === "daily_limit") return { kind: "disabled", note: "내일 다시 시도할 수 있습니다" };
  return { kind: "hidden" };
}

// ---------------------------------------------------------------- 값

export type Word = Status | "edited";
export const wordText = (w: Word) => (w === "edited" ? "직접 입력" : STATUS_LABEL[w]);

/** 엇갈림이면 계산·대조에 쓰는 값(없으면 null), 아니면 raw */
export function usedRaw(v: Value | null | undefined): string | number | null {
  if (!v || v.status === "unavailable" || v.status === "inferred") return null;
  if (v.status === "conflicting") return v.usedIndex === null ? null : v.values?.[v.usedIndex]?.raw ?? null;
  return v.raw;
}
export const firmStatus = (v: Value | null | undefined) => Boolean(v && (v.status === "confirmed" || v.status === "reported"));

// ---------------------------------------------------------------- 핵심 값 네 칸

export type Tile = {
  key: "revenue" | "nps" | "invest" | "patents";
  label: string;
  anchor: ScreenKey;
  loading: boolean;
  /** 큰 값(통화가 여럿이면 여러 줄) */
  big: string[];
  /** 기준 글 */
  basis: string[];
  word: Word | null;
  /** 미확보 사유(있으면 큰 값 대신) */
  missing: string | null;
  extra: string | null;
  /** extra 뒤에 붙일 상태 낱말 */
  extraWord?: Word | null;
};

const revenueBasis = (v: Value) => [v.source?.asOf, v.source?.basis].filter(Boolean).join(", ");

export function keyTiles(job: AnalysisJob): Tile[] {
  const m = job.merged;
  const s = job.sections;
  const tiles: Tile[] = [];

  // 매출: 공식 값 → 없으면 웹 조사 값
  const off = m.revenue.official;
  const web = m.revenue.web;
  if (!off) tiles.push(blank("revenue", "매출", "finance", true));
  else if (off.status !== "unavailable") {
    tiles.push({
      key: "revenue", label: "매출", anchor: "finance", loading: false, big: [off.display ?? ""], basis: [revenueBasis(off)], word: off.status, missing: null,
      extra: web && web.status !== "unavailable" ? `웹 조사: ${web.display}` : null,
      extraWord: web && web.status !== "unavailable" ? web.status : null,
    });
  } else if (web && web.status !== "unavailable") {
    tiles.push({ key: "revenue", label: "매출", anchor: "finance", loading: false, big: [web.display ?? ""], basis: [web.source?.asOf ?? ""].filter(Boolean), word: web.status, missing: null, extra: null });
  } else {
    tiles.push({ ...blank("revenue", "매출", "finance", false), missing: `미확보: ${off.reason ?? "공식 재무 자료 없음"}`, extra: web === null ? "웹 조사 확인 중" : null });
  }

  // 국민연금 가입자
  const nps = m.npsLatest;
  if (!nps) tiles.push(blank("nps", "국민연금 가입자", "finance", true));
  else if (nps.status === "unavailable") tiles.push({ ...blank("nps", "국민연금 가입자", "finance", false), missing: `미확보: ${nps.reason ?? "국민연금 사업장을 찾지 못함"}` });
  else {
    const change = s.official.result?.nps?.summary?.change;
    const month = nps.source?.asOf ?? "";
    tiles.push({
      key: "nps", label: "국민연금 가입자", anchor: "finance", loading: false, big: [nps.display ?? ""],
      basis: [typeof change === "number" ? `${month}, 12개월 전보다 ${signed(change)}명` : month], word: nps.status, missing: null, extra: null,
    });
  }

  // 누적 투자: 통화마다 따로, 더하지 않는다
  const fh = s.funding_history;
  if (!isTerminal(fh)) tiles.push(blank("invest", "누적 투자", "investment", true));
  else {
    const r = fh.result;
    const rounds = r?.summary.roundCount ?? 0;
    if (!r || rounds === 0) tiles.push({ ...blank("invest", "누적 투자", "investment", false), missing: "미확보: 투자 라운드 자료 없음" });
    else {
      const amounts = byCurrencyTexts(r.summary.cumulative.byCurrency);
      const latest = r.summary.latest;
      const latestText = latest ? `최근 ${(latest.date ?? "").slice(0, 7)} ${stageKo(latest.round)}`.trim() : "";
      tiles.push({
        key: "invest", label: "누적 투자", anchor: "investment", loading: false,
        big: amounts.length ? amounts : [`라운드 ${rounds}건`],
        basis: [amounts.length ? `라운드 ${rounds}건${latestText ? `, ${latestText}` : ""}` : latestText].filter(Boolean),
        word: "reported", missing: null, extra: null,
      });
    }
  }

  // 국내 특허
  const pc = m.patentCount;
  if (!pc) tiles.push(blank("patents", "국내 특허", "tech", true));
  else if (pc.status === "unavailable") tiles.push({ ...blank("patents", "국내 특허", "tech", false), missing: `미확보: ${pc.reason ?? "출원인이 확인된 특허를 찾지 못함"}` });
  else {
    const reg = s.patents.result?.summary.registered;
    tiles.push({ key: "patents", label: "국내 특허", anchor: "tech", loading: false, big: [pc.display ?? ""], basis: [`출원인 확인${typeof reg === "number" ? `, 등록 ${reg}건` : ""}`], word: pc.status, missing: null, extra: null });
  }
  return tiles;
}

function blank(key: Tile["key"], label: string, anchor: ScreenKey, loading: boolean): Tile {
  return { key, label, anchor, loading, big: [], basis: [], word: null, missing: null, extra: null };
}

// ---------------------------------------------------------------- 단락 한 줄 요약

export function summaryLine(job: AnalysisJob, key: ScreenKey): string | null {
  const m = job.merged;
  const s = job.sections;
  switch (key) {
    case "overview":
      return m.industry.web?.display ?? m.industry.official?.display ?? null;
    case "finance": {
      const parts: string[] = [];
      const off = m.revenue.official;
      if (off && off.status !== "unavailable") parts.push(`매출 ${off.source?.asOf ?? ""} ${off.display}${off.source?.basis ? `(${off.source.basis})` : ""}`.replace(/\s+/g, " "));
      const nps = m.npsLatest;
      const change = s.official.result?.nps?.summary?.change;
      if (nps && nps.status !== "unavailable") parts.push(`국민연금 가입자 ${nps.source?.asOf ?? ""} ${nps.display}${typeof change === "number" ? `(12개월 ${signed(change)}명)` : ""}`);
      return parts.length ? parts.join(", ") : null;
    }
    case "investment": {
      const r = s.funding_history.result;
      if (!r || !r.summary.roundCount) return null;
      const latest = r.summary.latest;
      const head = `투자 라운드 ${r.summary.roundCount}건${latest ? `, 최근 ${(latest.date ?? "").slice(0, 7)} ${stageKo(latest.round)}` : ""}`;
      const amounts = byCurrencyTexts(r.summary.cumulative.byCurrency);
      return amounts.length ? `${head}. 누적 ${amounts.join(", ")} (${r.summary.cumulative.label})` : head;
    }
    case "news": {
      const r = s.news.result;
      if (!r || !r.articleTotal) return null;
      return `최근 12개월 중요 사건 ${r.events.length}개, 기사 ${r.articleTotal}건`;
    }
    case "tech": {
      const r = s.patents.result;
      if (!r || !r.summary.total) return null;
      return `출원인이 확인된 국내 특허 ${r.summary.total}건 (등록 ${r.summary.registered}건)`;
    }
  }
}

// ---------------------------------------------------------------- 경쟁사

/**
 * 화면에 보일 경쟁사 후보. merged.rivals 는 서버가 국내 기업만 넣었고, 화면은 facts 의 국외 판정 이름을 한 번 더 뺀다(RI-01).
 */
export function visibleRivals(job: AnalysisJob) {
  const foreign = new Set((job.sections.facts.result?.competitors ?? []).filter((c) => !c.domestic).map((c) => normName(c.name)));
  return job.merged.rivals.filter((r) => !foreign.has(normName(r.name)) && !(r.nameEn && foreign.has(normName(r.nameEn))));
}

export type RivalChoiceMap = Record<string, "yes" | "no">;
export type RivalChoicesLike = { choices: RivalChoiceMap; added: { key: string; name: string }[]; touched?: boolean };

/**
 * 이 브라우저의 비교 대상(screens 4B.1 "처음 비교 대상"). 아직 한 번도 정하지 않았고(포함·제외·직접 추가 모두 없음, touched 아님)
 * 받아 둔 비교 자료가 있으면, 그 자료가 비교한 경쟁사(rivalSet)를 비교 대상에 포함한 것으로 본다(최대 MAX_RIVALS 곳).
 * 처음 연 사람의 비교 대상·단계 메뉴 개수가 저장된 비교 자료와 같게 한다. implicit 이면 저장된 비교 대상이 아니다.
 */
export function effectiveRivalChoices(job: AnalysisJob | null, rc: RivalChoicesLike): RivalChoicesLike & { implicit: boolean } {
  const untouched = !rc.touched && Object.keys(rc.choices).length === 0 && rc.added.length === 0;
  const deep = job?.sections.rivals_deep.result;
  const set = deep?.rivalSet ?? [];
  if (!job || !deep || !untouched || !set.length) return { ...rc, implicit: false };
  // 직접 추가한 회사 열쇠("user:…")만 비교 자료의 이름으로 직접 추가한 회사에 둔다. 후보 목록에서 빠진 자동 후보("rival:…")는
  // 직접 입력처럼 보이면 안 되므로 처음 비교 대상에서 뺀다(비교 표는 저장된 비교 자료의 회사를 그대로 보여 표에는 남는다)
  const known = new Set(visibleRivals(job).map((r) => r.key));
  const names = new Map(deep.rivals.map((r) => [r.key, r.name]));
  const keys = set.filter((k) => known.has(k) || (k.startsWith("user:") && names.has(k))).slice(0, MAX_RIVALS);
  const choices: RivalChoiceMap = Object.fromEntries(keys.map((k) => [k, "yes" as const]));
  const added = keys.filter((k) => !known.has(k)).map((k) => ({ key: k, name: names.get(k)! }));
  return { choices, added, implicit: keys.length > 0 };
}

export type PickedRival = { key: string; name: string; nameEn: string | null };
/** 비교 대상(포함한 경쟁사)을 보이는 순서로: 후보 목록 순서, 그다음 직접 추가한 회사. 비교 자료 요청 본문·심사 준비·단계 메뉴가 같은 목록을 쓴다(D-05) */
export function pickedRivals(job: AnalysisJob | null, rc: RivalChoicesLike): PickedRival[] {
  const eff = effectiveRivalChoices(job, rc);
  const yes = (k: string) => eff.choices[k] === "yes";
  const cands = job ? visibleRivals(job) : [];
  return [
    ...cands.filter((r) => yes(r.key)).map((r) => ({ key: r.key, name: r.name, nameEn: r.nameEn })),
    ...eff.added.filter((a) => yes(a.key)).map((a) => ({ key: a.key, name: a.name, nameEn: null })),
  ];
}

// ---------------------------------------------------------------- 진행 줄과 알림

const PENDING_TEXT: Record<string, string> = {
  employees: "개요(직원 수)",
  "industry.web": "개요(웹 조사 업종)",
  "founded.web": "개요(설립일 대조)",
  "region.web": "개요(본사 지역)",
  "revenue.web": "재무·고용(웹 조사 매출)",
  "investors.confirmed": "투자(원문 확인 투자자)",
  "rivals.facts": "경쟁사 분석(후보 추가)",
};

/** 진행 줄 둘째 줄의 "아직 확인 중" 목록 */
export function stillChecking(job: AnalysisJob): string[] {
  const out: string[] = [];
  for (const sec of SCREEN_SECTIONS) if (!isTerminal(job.sections[sec.primary]) && !out.includes(sec.label)) out.push(sec.label);
  // 단락 전체가 확인 중이면 그 단락의 부분(직원 수 등)은 따로 적지 않는다
  for (const p of job.merged.pending) {
    const t = PENDING_TEXT[p];
    if (t && !out.includes(t) && !out.includes(t.split("(")[0])) out.push(t);
  }
  return out;
}

/** 이전 응답과 새 응답을 견줘 화면 읽기 알림 문장을 만든다(C-21). 처음 받은 응답(prev 없음)은 알리지 않는다 */
export function announcements(prev: AnalysisJob | null, next: AnalysisJob): string[] {
  if (!prev) return [];
  const out: string[] = [];
  for (const sec of SCREEN_SECTIONS) {
    const a = prev.sections[sec.primary];
    const b = next.sections[sec.primary];
    if (!isTerminal(a) && isTerminal(b)) out.push(b.status === "unavailable" ? `${sec.label} 단락은 미확보로 끝났습니다.` : `${sec.label} 단락이 준비됐습니다.`);
  }
  if (prev.status === "running" && next.status !== "running") out.push("회사 분석이 끝났습니다.");
  return out;
}

/** 끝났을 때 미확보로 끝난 화면 단락 */
export const unavailableScreens = (job: AnalysisJob) => SCREEN_SECTIONS.filter((s) => job.sections[s.primary].status === "unavailable");

// ---------------------------------------------------------------- 새로 분석 중 합치기(계약 9절 끝)

/**
 * 저장된 분석(base) 위에 진행 중인 새 작업(live)을 얹는다. 새 단락이 끝 상태이고 결과가 있으면 그 단락만 바꾼다.
 * 새 단락이 미확보이고 이전 결과가 있으면 이전 결과를 두고 fallbackNote 를 남긴다.
 * 합친 값(merged)도 같다: 새 값이 미확보인데 이전 값은 미확보가 아니면 이전 값을 둔다(핵심 값 칸·공고문 대조 입력이 미확보로 바뀌지 않게).
 */
export type Overlay = { job: AnalysisJob; refreshing: Set<SectionKey>; kept: Map<SectionKey, { at: string | null; reason: string }> };
export function overlay(base: AnalysisJob | null, live: AnalysisJob | null): Overlay | null {
  if (!base && !live) return null;
  if (!base) return { job: live!, refreshing: new Set(), kept: new Map() };
  if (!live || live.jobId === base.jobId) return { job: live ?? base, refreshing: new Set(), kept: new Map() };
  const sections = { ...base.sections } as AnalysisJob["sections"];
  const refreshing = new Set<SectionKey>();
  const kept = new Map<SectionKey, { at: string | null; reason: string }>();
  for (const key of Object.keys(base.sections) as SectionKey[]) {
    const nb = live.sections[key];
    const ob = base.sections[key];
    if (!isTerminal(nb)) {
      if (nb.status !== "idle") refreshing.add(key);
      continue;
    }
    if (nb.status === "unavailable" && ob.result) kept.set(key, { at: ob.analyzedAt, reason: errorSentence(nb.error) });
    else (sections as Record<string, unknown>)[key] = nb;
  }
  const merged = mergeFallback(base.merged, live.merged, kept);
  return { job: { ...base, sections, merged, busy: live.busy, paid: live.paid, estimates: live.estimates, refresh: live.refresh }, refreshing, kept };
}

const isValueLike = (x: unknown): x is Value => Boolean(x && typeof x === "object" && !Array.isArray(x) && typeof (x as Value).status === "string");
/** 새 값이 아직 없거나(확인 중), 미확보인데 이전 값은 미확보가 아니면 이전 값. 그 밖에는 새 값 */
function keepValue(nv: unknown, ov: unknown): unknown {
  if (nv === null || nv === undefined) return ov;
  if (isValueLike(nv) && nv.status === "unavailable" && isValueLike(ov) && ov.status !== "unavailable") return ov;
  return nv;
}

function mergeFallback(base: Merged, live: Merged, kept: ReadonlyMap<SectionKey, unknown>): Merged {
  const out = { ...live } as Record<string, unknown>;
  for (const [k, v] of Object.entries(live)) {
    const b = (base as Record<string, unknown>)[k];
    if (k === "industry" || k === "revenue") {
      const tv = v as { official: unknown; web: unknown };
      const tb = (b ?? {}) as { official?: unknown; web?: unknown };
      out[k] = { official: keepValue(tv.official, tb.official), web: keepValue(tv.web, tb.web) };
    } else out[k] = keepValue(v, b);
  }
  // 값 모양이 아닌 목록은, 그 목록을 채우는 단락을 이전 결과로 두었으면(kept) 이전 목록을 쓴다
  const keptAny = (...keys: SectionKey[]) => keys.some((key) => kept.has(key));
  if (live.pending.includes("investors.confirmed") || keptAny("funding_history", "facts")) out.investors = base.investors;
  if (live.pending.includes("rivals.facts") || keptAny("profile", "facts")) out.rivals = base.rivals;
  if (kept.has("profile")) {
    out.techKeywords = base.techKeywords;
    out.programKeywords = base.programKeywords;
    out.bidKeywords = base.bidKeywords;
  }
  return out as Merged;
}
