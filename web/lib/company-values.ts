// 회사 값: 분석 값(merged)과 이 브라우저에서 고친 값(edits)을 합쳐, 공고문 대조·운용사 요약에 보낼 회사 값을 만든다(계약 13절).
// 추정·엇갈림(쓸 값 없음)·미확보 값은 자동으로 채우지 않고 비워 보낸다. 국민연금 가입자 수는 직원 수 칸에 넣지 않는다.
import { NOTICE_COMPANY_LIMITS, type AnalysisJob, type BizTypeId, type NoticeCompany, type RivalsDeepResult, type Value } from "./contract.ts";
import { wonDisplay } from "./format.ts";
import { rivalCompany } from "./rival.ts";
import { PATENT_LABEL, firmStatus } from "./view.ts";

export const EDIT_FIELDS = ["region", "bizType", "founded", "industry", "employees", "revenue", "need", "notes"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];
export type Edit = { value: string; updatedAt: string };
export type Edits = Partial<Record<EditField, Edit>>;

export const BIZ_LABEL: Record<BizTypeId, string> = { venture: "창업·벤처기업", sme: "중소기업", micro: "소상공인" };
export const isBizType = (v: unknown): v is BizTypeId => v === "venture" || v === "sme" || v === "micro";

/** 회사 정보 수정 창의 칸 이름(screens 1.8) */
export const EDIT_LABEL: Record<EditField, string> = {
  region: "지역", bizType: "기업 유형", founded: "설립 연월", industry: "업종", employees: "직원 수", revenue: "최근 연매출", need: "필요한 자금", notes: "그 밖의 사항",
};

const edited = (e: Edits, k: EditField) => (e[k]?.value ?? "").trim();
const clip = (s: string, k: keyof NoticeCompany) => s.slice(0, NOTICE_COMPANY_LIMITS[k]);

/** 설립 값 → 대조에 쓸 "YYYY-MM"과, 연도만 있을 때 메모 */
export function foundedForCheck(v: Value | null): { value: string; note: string | null } {
  if (!v || v.status === "inferred" || v.status === "unavailable") return { value: "", note: null };
  let raw: string | number | null = v.raw;
  if (v.status === "conflicting") {
    if (v.usedIndex === null) return { value: "", note: null };
    raw = v.values?.[v.usedIndex]?.raw ?? null;
  }
  const s = typeof raw === "string" ? raw : raw === null ? "" : String(raw);
  if (/^\d{4}-\d{2}/.test(s)) return { value: s.slice(0, 7), note: null };
  if (/^\d{4}$/.test(s)) return { value: "", note: `설립 ${s}년(월 미확인)` };
  return { value: "", note: null };
}

type JobLike = Pick<AnalysisJob, "company" | "merged" | "sections">;

/** 자동 메모: 검색으로 확인한 특허 수, 국민연금 가입자 수(직원 수와 다르다는 말 포함) */
export function autoNotes(job: JobLike): string[] {
  const out: string[] = [];
  const pc = job.merged.patentCount;
  const reg = job.sections.patents.result?.summary.registered;
  if (pc && pc.status !== "unavailable" && typeof pc.raw === "number" && pc.raw > 0) out.push(`${PATENT_LABEL} ${pc.raw}건(출원인 확인, 등록 ${reg ?? 0}건)`);
  const nps = job.merged.npsLatest;
  if (nps && nps.status !== "unavailable" && typeof nps.raw === "number") out.push(`국민연금 가입자 ${nps.raw}명(${nps.source?.asOf ?? ""}, 직원 수와 다름)`);
  return out;
}

/** 계약 13절 표 그대로 */
export function noticeCompany(job: JobLike, edits: Edits): NoticeCompany {
  const m = job.merged;
  const region = edited(edits, "region") || (m.region && firmStatus(m.region) && typeof m.region.raw === "string" ? m.region.raw : "");
  const biz = edited(edits, "bizType");
  const f = foundedForCheck(m.founded);
  const founded = edited(edits, "founded") || f.value;
  const industry = edited(edits, "industry") || (firmStatus(m.industry.official) ? m.industry.official!.display ?? "" : firmStatus(m.industry.web) ? m.industry.web!.display ?? "" : "");
  const emp = m.employees && firmStatus(m.employees) && (m.employees.display ?? "").length <= 30 ? m.employees.display ?? "" : "";
  const employees = edited(edits, "employees") || emp;
  let rev = "";
  const off = m.revenue.official;
  const web = m.revenue.web;
  if (off && firmStatus(off)) {
    const basis = [off.source?.asOf, off.source?.basis].filter(Boolean).join(", ");
    const t = basis ? `${off.display} (${basis})` : off.display ?? "";
    if (t.length <= 60) rev = t;
  }
  if (!rev && web && firmStatus(web) && (web.display ?? "").length <= 60) rev = web.display ?? "";
  const revenue = edited(edits, "revenue") || rev;

  const userNotes = edited(edits, "notes");
  const autos = [...(edited(edits, "founded") ? [] : f.note ? [f.note] : []), ...autoNotes(job)];
  let notes = [userNotes, ...autos].filter(Boolean).join(", ");
  while (notes.length > NOTICE_COMPANY_LIMITS.notes && autos.length) {
    autos.pop();
    notes = [userNotes, ...autos].filter(Boolean).join(", ");
  }
  return {
    name: clip(job.company.name, "name"),
    region: clip(region, "region"),
    biz: clip(biz, "biz"),
    founded: clip(founded, "founded"),
    industry: clip(industry, "industry"),
    employees: clip(employees, "employees"),
    revenue: clip(revenue, "revenue"),
    need: clip(edited(edits, "need"), "need"),
    notes: clip(notes, "notes"),
  };
}

/** "대조에 쓰는 회사 값 {n}/8개 채움": 회사 정보 수정 창 8칸이 대조에 실제로 들어가는 값으로 채워졌는가 */
export function filledCount(job: JobLike, edits: Edits): number {
  const c = noticeCompany(job, edits);
  return [c.region, c.biz, c.founded, c.industry, c.employees, c.revenue, c.need, edited(edits, "notes")].filter((v) => v.trim()).length;
}

/** 경쟁사 조건으로 바꾼 회사 값(계약 13절 "경쟁사 조건이라면?") */
export function rivalNoticeCompany(rivalKey: string, job: JobLike & { sections: AnalysisJob["sections"] }, mine: NoticeCompany): NoticeCompany | null {
  const deep: RivalsDeepResult | null = job.sections.rivals_deep.result;
  const d = deep?.rivals.find((r) => r.key === rivalKey);
  const keep = { region: mine.region, biz: mine.biz, need: mine.need };
  if (d) {
    const last = d.financials[d.financials.length - 1];
    const notes: string[] = [];
    const nps = d.nps?.monthly.filter((x) => x.members !== null).at(-1);
    if (nps) notes.push(`국민연금 가입자 ${nps.members}명(${nps.month}, 직원 수와 다름)`);
    const amounts = Object.entries(d.funding?.summary.cumulative.byCurrency ?? {});
    if (amounts.length) notes.push(`누적 투자 ${amounts.map(([cur, v]) => (cur === "KRW" ? wonDisplay(v) : `${cur} ${v.toLocaleString("en-US")}`)).join(", ")}`);
    const rel = job.merged.rivals.find((r) => r.key === rivalKey)?.relation;
    if (rel) notes.push(`관계: ${rel}`);
    const first = (d.summary?.business ?? "").split(/(?<=[.다])\s/)[0] ?? "";
    return {
      name: clip(d.name, "name"), ...keep,
      founded: clip(d.corp?.founded ? d.corp.founded.slice(0, 7) : "", "founded"),
      industry: clip(first, "industry"),
      employees: "",
      revenue: clip(last && last.revenue !== null ? `${wonDisplay(last.revenue)} (${last.year} 사업연도${last.basisShort ? `, ${last.basisShort}` : ""})` : "", "revenue"),
      notes: clip(notes.join(", "), "notes"),
    } as NoticeCompany;
  }
  const r = job.merged.rivals.find((x) => x.key === rivalKey);
  if (!r) return null;
  const c = rivalCompany(
    { name: r.name, relation: r.relation ?? "", products: r.products ?? "", revenue: r.revenue ?? "", employees: r.employees ?? "", funding: r.funding ?? "", status: r.status },
    keep,
  );
  return c as NoticeCompany;
}
