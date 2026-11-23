// 이름 정규화(계약 1.4 norm_name). 직접 추가한 경쟁사 열쇠("user:" + norm_name)와 해외 기업 한 번 더 거르기에 쓴다.

const LEGAL = /주식회사|유한회사|유한책임회사|\(주\)|\(유\)|inc\.|corp\.|co\., ltd\.|ltd\.|llc/gi;

export function normName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(LEGAL, "")
    .replace(/[\s·.,&()\-_'"]/g, "")
    .toLowerCase();
}

export const userRivalKey = (name: string) => `user:${normName(name)}`;

/** 정규화한 이름이 같은 후보가 2곳 이상일 때 그 후보들의 companyId. 회사 확정 화면은 이 후보에만 사업자번호·전체 주소·이전 이름을 더 보인다 */
export function sameNameIds(cands: { companyId: string; name: string }[]): Set<string> {
  const keys = cands.map((c) => normName(c.name));
  const n = new Map<string, number>();
  for (const k of keys) if (k) n.set(k, (n.get(k) ?? 0) + 1);
  return new Set(cands.filter((_, i) => keys[i] && (n.get(keys[i]) ?? 0) >= 2).map((c) => c.companyId));
}
