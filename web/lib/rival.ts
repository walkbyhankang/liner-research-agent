// "경쟁사 조건이라면?" 대조에 보낼 회사 정보를 만든다. 화면 상태와 무관한 순수 함수.

export type RivalInfo = { name: string; relation: string; products: string; revenue: string; employees: string; funding: string; status: string };

/** 대조에 써도 되는 상태. 추정(inferred)이나 출처 간 불일치(conflicting)인 경쟁사 수치는 사실처럼 넘기지 않는다. */
export const usableRival = (r: Pick<RivalInfo, "status">) => r.status === "confirmed" || r.status === "reported";

/**
 * 지역·기업 유형·필요 자금은 우리 회사 값을 두고, 업종·직원 수·매출·투자 이력만 경쟁사 값으로 바꾼다.
 * 경쟁사 정보가 불확실하면 그 값들을 비워 보낸다. 비운 항목은 대조에서 '확인 필요'로 남는다.
 */
export function rivalCompany(r: RivalInfo, mine: { region: string; biz: string; need: string }) {
  const ok = usableRival(r);
  const notes = ok ? [r.relation && `관계: ${r.relation}`, r.funding && `투자 유치: ${r.funding}`].filter(Boolean).join(", ") : "";
  return {
    name: r.name.slice(0, 60),
    region: mine.region,
    biz: mine.biz,
    founded: "",
    industry: ok ? r.products.slice(0, 80) : "",
    employees: ok ? r.employees.slice(0, 30) : "",
    revenue: ok ? r.revenue.slice(0, 60) : "",
    need: mine.need,
    notes: notes.slice(0, 400),
  };
}
