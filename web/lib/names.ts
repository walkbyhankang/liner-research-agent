// 이름 정규화(계약 1.4 norm_name). 직접 넣은 경쟁사 열쇠("user:" + norm_name)와 해외 기업 한 번 더 거르기에 쓴다.

const LEGAL = /주식회사|유한회사|유한책임회사|\(주\)|\(유\)|inc\.|corp\.|co\., ltd\.|ltd\.|llc/gi;

export function normName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(LEGAL, "")
    .replace(/[\s·.,&()\-_'"]/g, "")
    .toLowerCase();
}

export const userRivalKey = (name: string) => `user:${normName(name)}`;
