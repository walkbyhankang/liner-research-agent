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

// ---------------------------------------------------------------- 심사 준비 조건의 "관련 있을 수 있는 회사 정보"

/** 조건 분야 → 관련 있을 수 있는 회사 정보 칸. 제외 대상(체납·휴폐업 등)은 회사 정보 칸에 없는 사실이라 칸을 잇지 않는다("대상"이 들어 있어도 기업 유형이 아니다) */
export function conditionField(field: string): keyof NoticeCompany | null {
  if (/제외/.test(field)) return null;
  if (/지역|소재/.test(field)) return "region";
  if (/업력|설립/.test(field)) return "founded";
  if (/업종|업태/.test(field)) return "industry";
  if (/규모|직원|인원|근로자/.test(field)) return "employees";
  if (/매출|실적/.test(field)) return "revenue";
  if (/자금|용도/.test(field)) return "need";
  if (/유형|대상/.test(field)) return "biz";
  return null;
}
export const COMPANY_FIELD_LABEL: Record<keyof NoticeCompany, string> = {
  name: "회사 이름", region: EDIT_LABEL.region, biz: EDIT_LABEL.bizType, founded: EDIT_LABEL.founded, industry: EDIT_LABEL.industry, employees: EDIT_LABEL.employees,
  revenue: EDIT_LABEL.revenue, need: EDIT_LABEL.need, notes: EDIT_LABEL.notes,
};

/** 회사 정보 칸 값을 사람이 읽는 글로(기업 유형은 id 대신 이름, 빈 칸은 "비어 있음") */
export function companyFieldText(k: keyof NoticeCompany, company: NoticeCompany): string {
  const v = company[k];
  if (!v) return "비어 있음";
  return k === "biz" && isBizType(v) ? BIZ_LABEL[v] : v;
}

/**
 * 펼친 조건의 "관련 있을 수 있는 회사 정보" 한 줄. 조건 분야에 맞는 회사 정보 칸이 있으면 그 칸과 값(그 값을 판단에 썼다고 단정하지 않는다. 응답은 조건마다 쓴 입력을 알려 주지 않는다, 리뷰 P2).
 * 제외 대상(체납·휴폐업 등)은 맞는 칸이 없다. 대조에는 "그 밖의 사항"(사용자 글 + 자동 메모: 특허·국민연금 수치 등)도 함께 넘기지만,
 * 서버 응답은 어느 입력이 판정을 뒷받침했는지 알려 주지 않으므로 그 내용을 판단 근거처럼 보이지 않고 중립 문장만 쓴다(리뷰 P2)
 */
export function conditionCompanyLine(field: string, company: NoticeCompany): string {
  const k = conditionField(field);
  if (k) return `${COMPANY_FIELD_LABEL[k]} ${companyFieldText(k, company)}`;
  // 제외 대상·그 밖의 조건은 어느 칸과 맞닿는지 정하지 않는다(예: 금융업 제외는 업종으로 판단될 수 있다). 무엇을 넘겼는지만 중립으로 쓴다
  return `이 조건에 맞는 회사 정보 칸을 따로 정하지 않았습니다. 대조에는 회사 정보 전체와 '${COMPANY_FIELD_LABEL.notes}'을 함께 넘겼습니다.`;
}
