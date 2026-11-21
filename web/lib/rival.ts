// "경쟁사 조건이라면?" 대조에 보낼 회사 정보를 만든다. 화면 상태와 무관한 순수 함수.

export type RivalInfo = { name: string; relation: string; products: string; revenue: string; employees: string; funding: string; status: string; figuresStatus?: string; founded?: string };

/**
 * 경쟁사의 수치를 대조에 써도 되는지. 두 경우에만 쓴다.
 * - 수치를 검색 결과에서 근거 문장과 함께 확인한 경우(figuresStatus 가 reported). 이때 서버는 확인되지 않은 수치를 이미 지웠다.
 * - 경쟁사 기록 자체가 확인되거나 보도된 경우.
 * 추정(inferred)이나 출처 간 불일치(conflicting)뿐인 수치는 사실처럼 넘기지 않는다.
 */
export const usableRival = (r: Pick<RivalInfo, "status" | "figuresStatus">) =>
  r.figuresStatus === "reported" || r.status === "confirmed" || r.status === "reported";

/**
 * 지역·기업 유형·필요 자금은 우리 회사 값을 두고, 업종·설립 시기·직원 수·매출·투자 이력만 경쟁사 값으로 바꾼다.
 * 설립 시기는 연도만 확인되는 경우가 많아 설립 연월 칸이 아니라 메모로 보낸다(달을 지어내지 않는다).
 * 경쟁사 정보가 불확실하면 그 값들을 비워 보낸다. 비운 항목은 대조에서 '확인 필요'로 남는다.
 */
export function rivalCompany(r: RivalInfo, mine: { region: string; biz: string; need: string }) {
  // 수치(직원 수·매출·투자)와 기록의 나머지(사업 내용·관계)는 근거가 다르므로 따로 판단한다
  const figuresOk = usableRival(r);
  const recordOk = r.status === "confirmed" || r.status === "reported";
  const notes = [recordOk && r.relation && `관계: ${r.relation}`, figuresOk && r.founded && `설립: ${r.founded}`, figuresOk && r.funding && `투자 유치: ${r.funding}`]
    .filter(Boolean)
    .join(", ");
  return {
    name: r.name.slice(0, 60),
    region: mine.region,
    biz: mine.biz,
    founded: "",
    industry: recordOk ? r.products.slice(0, 80) : "",
    employees: figuresOk ? r.employees.slice(0, 30) : "",
    revenue: figuresOk ? r.revenue.slice(0, 60) : "",
    need: mine.need,
    notes: notes.slice(0, 400),
  };
}
