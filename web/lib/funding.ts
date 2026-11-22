// 자금 조달 화면 규칙(screens 5절). 지금 finder.ts 의 대조 규칙(matchProgram, groupFunds, gpKey …)을 그대로 쓰고,
// 회사 분석 값으로 조건을 채우는 것, 이미 투자한 운용사를 따로 묶는 것, "회사 사업과 관련" 표시만 더한다.
import type { BizTypeId, FundFieldId, Merged, MergedInvestor, RivalsDeepResult } from "./contract.ts";
import { fundFields, isExistingInvestor, regionOptions, sorter, type GpGroup, type Program, type ProgramMatch, type SortMode } from "./finder.ts";
import type { Edits } from "./company-values.ts";
import { firmStatus } from "./view.ts";

export type Conditions = { region: string | null; biz: BizTypeId | null; need: "loan" | "startup" | "tech" | "export" | "all"; field: FundFieldId | null };
export type ConditionSource = { region: "edit" | "analysis" | null; biz: "edit" | null; field: "analysis" | null };

/** 회사 값으로 처음 조건을 채운다. 기업 유형은 사용자가 고른 것만 쓴다(자동 적용 금지, decisions 2) */
export function initialConditions(merged: Merged | null, edits: Edits): { cond: Conditions; from: ConditionSource } {
  const er = edits.region?.value;
  const ar = merged?.region && firmStatus(merged.region) && typeof merged.region.raw === "string" ? merged.region.raw : null;
  const region = er && regionOptions.includes(er) ? er : ar && regionOptions.includes(ar) ? ar : null;
  const eb = edits.bizType?.value;
  const biz = eb === "venture" || eb === "sme" || eb === "micro" ? eb : null;
  const fr = merged?.fundField?.raw;
  const field = typeof fr === "string" && fundFields.some((f) => f.id === fr) ? (fr as FundFieldId) : null;
  return {
    cond: { region, biz, need: "loan", field },
    from: { region: er && region === er ? "edit" : region ? "analysis" : null, biz: biz ? "edit" : null, field: field ? "analysis" : null },
  };
}

/** 공고 제목·요약·태그에 회사 기술 낱말이 들어 있는가. 표시와 순서에만 쓰고 공고를 빼지 않는다 */
export function relatedTo(p: Program, keywords: readonly string[]): boolean {
  const hay = `${p.title} ${p.intro} ${p.points.join(" ")} ${p.tags.join(" ")}`.toLowerCase();
  return keywords.some((k) => k.trim().length >= 2 && hay.includes(k.trim().toLowerCase()));
}

/** "우리 지역·마감순"에서 회사 사업과 관련된 공고를 같은 지역 안에서 앞으로 */
export function programSorter(mode: SortMode, related: (p: Program) => boolean) {
  const base = sorter(mode);
  if (mode !== "rec") return base;
  return (a: ProgramMatch, b: ProgramMatch) =>
    Number(b.local) - Number(a.local) || Number(related(b.program)) - Number(related(a.program)) || base(a, b);
}

/** 이미 투자한 운용사(합친 투자기관과 이름이 같은 곳)를 새 후보와 나눈다. 원문 확인·보도 기록만 쓴다(F-05) */
export function splitExisting(groups: GpGroup[], investors: readonly MergedInvestor[]) {
  const names = investors.filter((i) => i.status === "confirmed" || i.status === "reported").flatMap((i) => [i.name, ...i.aliases]);
  const existing = groups.filter((g) => isExistingInvestor(g.gp, names));
  return { existing, fresh: groups.filter((g) => !existing.includes(g)), names };
}

/** 깊이 비교를 했을 때 운용사 → 그 운용사가 투자한 경쟁사 이름들 */
export function rivalBackers(deep: RivalsDeepResult | null | undefined) {
  return (gp: string): string[] => {
    if (!deep) return [];
    return deep.rivalInvestors.filter((r) => isExistingInvestor(gp, r.investors)).map((r) => r.rivalName);
  };
}

export const NEED_LABEL: Record<Conditions["need"], string> = { loan: "융자·보증", startup: "창업 사업화 지원", tech: "기술개발·사업화 지원", export: "수출·해외진출 지원", all: "모든 지원사업" };
