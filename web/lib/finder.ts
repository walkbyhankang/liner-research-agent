// 자금 찾기 화면의 데이터 형식과 대조 규칙.
// 데이터는 scripts/fetch_public_data.py 가 공공 API 에서 받아 만든 스냅샷이다.

export type Program = {
  id: string;
  title: string;
  category: string;
  sub: string;
  target: string;
  agency: string;
  operator: string;
  regions: string[];
  agencyRegion: string | null;
  period: { raw: string; start: string | null; end: string | null; status: "접수 중" | "접수 예정" | "수시" | "미기재" };
  intro: string;
  points: string[];
  tags: string[];
  url: string;
  applyUrl: string;
  applyMethod: string;
  contact: string;
  docUrl: string;
  created: string;
};

export type Fund = { name: string; gp: string; field: string; year: number | null; maturity: string | null; commitRaw: number | null };

export type Meta = {
  asOf: string;
  programs: { total: number; byCategory: Record<string, number> };
  funds: { total: number; beforeMaturity: number; listed: number; latestYear: number | null };
};

export const regionOptions = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];

export const bizTypes = [
  { id: "venture", label: "창업·벤처기업" },
  { id: "sme", label: "중소기업" },
  { id: "micro", label: "소상공인" },
] as const;
export type BizType = (typeof bizTypes)[number]["id"];

// 필요한 지원 종류 → 기업마당 지원분야(대분류)
// subs 가 있으면 대분류 안에서 그 중분류만 포함한다. '금융'에는 보험·펀드/투자 공고도 있어 융자·보증만 고른다.
export const needs = [
  { id: "loan", label: "융자·보증", categories: ["금융"], subs: ["융자", "보증"] },
  { id: "startup", label: "창업 사업화 지원", categories: ["창업"], subs: [] as string[] },
  { id: "tech", label: "기술개발·사업화 지원", categories: ["기술"], subs: [] as string[] },
  { id: "export", label: "수출·해외진출 지원", categories: ["수출"], subs: [] as string[] },
  { id: "all", label: "모든 지원사업", categories: [] as string[], subs: [] as string[] },
] as const;
export type NeedId = (typeof needs)[number]["id"];

/** 공고가 고른 지원 종류에 속하는지. */
export function inNeed(p: Pick<Program, "category" | "sub">, needId: NeedId): boolean {
  const need = needs.find((n) => n.id === needId);
  if (!need) return false;
  const cats: readonly string[] = need.categories;
  const subs: readonly string[] = need.subs;
  return (cats.length === 0 || cats.includes(p.category)) && (subs.length === 0 || subs.includes(p.sub));
}

// 관심 투자 분야 → 모태펀드 출자분야 이름에 들어 있는 낱말
export const fundFields = [
  { id: "early", label: "창업 초기", kw: ["창업초기", "청년창업", "대학창업", "기술지주", "엔젤", "첫걸음", "스타트업", "창업사업화", "창업기업"] },
  { id: "ai", label: "AI·딥테크·소프트웨어", kw: ["AI", "초격차", "딥테크", "SaaS", "사이버보안", "4차", "DNA", "신기술", "비대면", "디지털", "메타버스", "5G", "가상"] },
  { id: "bio", label: "바이오·헬스", kw: ["바이오", "백신", "제약", "보건"] },
  { id: "content", label: "콘텐츠·문화", kw: ["콘텐츠", "영화", "문화", "게임", "애니", "드라마", "공연", "방송", "스포츠", "관광"] },
  { id: "mfg", label: "소재·부품·장비", kw: ["소재부품장비", "스마트공장"] },
  { id: "green", label: "환경·에너지", kw: ["그린", "환경", "미세먼지", "ESG", "해양"] },
  { id: "local", label: "지방 기업", kw: ["지방", "지역", "규제자유특구", "영·호남", "인구활력"] },
  { id: "ip", label: "특허·기술사업화", kw: ["특허", "IP", "기술사업화", "공공기술", "R&D"] },
  { id: "impact", label: "소셜임팩트·여성기업", kw: ["소셜임팩트", "임팩트", "사회적기업", "여성기업", "사회서비스"] },
  { id: "scale", label: "스케일업·해외진출", kw: ["스케일업", "해외", "글로벌", "수출", "유니콘", "K-밸류"] },
] as const;
export type FundFieldId = (typeof fundFields)[number]["id"];

export type Profile = { region: string; biz: BizType; need: NeedId; field: FundFieldId };

const regionHit = (regions: string[], region: string) =>
  regions.includes(region) || ((region === "광주" || region === "전남") && regions.includes("전남광주"));

// 기업 유형별로 신청 대상이 될 수 있는 기업마당 지원대상 분류. exact 는 그대로 일치, loose 는 포함 관계라 공고문 확인이 필요하다.
const targetRule: Record<BizType, { exact: string[]; loose: string[] }> = {
  venture: { exact: ["창업벤처"], loose: ["중소기업"] },
  sme: { exact: ["중소기업"], loose: [] },
  micro: { exact: ["소상공인"], loose: ["중소기업"] },
};

export type ProgramMatch = {
  program: Program;
  ok: boolean;
  excluded: "지역" | "대상" | null;
  reasons: string[];
  checks: string[];
  local: boolean;
  exact: boolean;
  doubt: boolean; // 다른 지역 지자체 공고인데 전국으로 분류된 경우
};

export function matchProgram(p: Program, prof: Profile): ProgramMatch {
  const reasons: string[] = [];
  const checks: string[] = [];
  const nationwide = p.regions.includes("전국");
  const agencyHere = p.agencyRegion ? regionHit([p.agencyRegion], prof.region) : false;
  const local = nationwide ? agencyHere : regionHit(p.regions, prof.region);
  const base = { program: p, reasons, checks, local, exact: false, doubt: false };
  if (!nationwide && !local) return { ...base, ok: false, excluded: "지역" };
  const doubt = nationwide && Boolean(p.agencyRegion) && !agencyHere;
  if (doubt) checks.push(`${p.agency} 공고인데 전국으로 분류됨 — 다른 지역 기업도 신청할 수 있는지 확인`);
  else reasons.push(nationwide ? (agencyHere ? `${p.agency} 공고` : "전국 대상") : `지역 대상: ${p.regions.join("·")}`);

  const rule = targetRule[prof.biz];
  const exact = rule.exact.includes(p.target);
  if (!exact && !rule.loose.includes(p.target)) return { ...base, ok: false, excluded: "대상" };
  if (exact) reasons.push(`지원대상: ${p.target}`);
  else checks.push(`지원대상이 '${p.target}'으로 분류된 공고 — 우리 회사가 해당하는지 공고문 확인`);

  if (p.period.status === "수시") checks.push(`신청기간 '${p.period.raw}' — 지금 접수하는지 확인`);
  if (p.period.status === "접수 예정") checks.push(`접수 시작 전(${p.period.start}부터)`);
  return { ...base, ok: true, excluded: null, exact, doubt };
}

const endKey = (p: Program) => (p.period.status === "접수 중" && p.period.end ? p.period.end : "9999-99-99");

export function sortMatches(a: ProgramMatch, b: ProgramMatch) {
  return (
    Number(b.local) - Number(a.local) ||
    Number(a.doubt) - Number(b.doubt) ||
    Number(b.exact) - Number(a.exact) ||
    endKey(a.program).localeCompare(endKey(b.program)) ||
    b.program.created.localeCompare(a.program.created)
  );
}

export type GpGroup = { gp: string; funds: Fund[]; latestYear: number };

/** 스냅샷을 만든 뒤 만기가 지난 펀드는 뺀다. 만기일 당일은 남긴다(스냅샷 생성 스크립트와 같은 기준). */
export const fundAlive = (f: Fund, today: string) => Boolean(f.maturity) && (f.maturity as string) >= today;

export function groupFunds(funds: Fund[], fieldId: FundFieldId, q: string): GpGroup[] {
  const kw = fundFields.find((f) => f.id === fieldId)?.kw ?? [];
  const query = q.trim();
  const map = new Map<string, Fund[]>();
  for (const f of funds) {
    if (!kw.some((k) => f.field.includes(k))) continue;
    if (query && !`${f.name} ${f.gp} ${f.field}`.includes(query)) continue;
    map.set(f.gp, [...(map.get(f.gp) ?? []), f]);
  }
  return [...map.entries()]
    .map(([gp, list]) => {
      const sorted = [...list].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      return { gp, funds: sorted, latestYear: sorted[0].year ?? 0 };
    })
    .sort((a, b) => b.latestYear - a.latestYear || b.funds.length - a.funds.length || a.gp.localeCompare(b.gp));
}

export const shortDate = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}.${Number(iso.slice(8, 10))}` : "");

// ---------- 마감, 빠른 필터, 정렬 ----------

export type Only = "all" | "soon" | "local";
export type SortMode = "rec" | "deadline" | "new";
export const SOON_DAYS = 14;

/** 오늘부터 마감일까지 남은 날 수. 날짜가 없으면 null. */
export const dday = (end: string | null, today: string) => (end ? Math.round((Date.parse(end) - Date.parse(today)) / 86400000) : null);

export const isSoon = (p: Program, today: string) => {
  const d = p.period.status === "접수 중" ? dday(p.period.end, today) : null;
  return d !== null && d >= 0 && d <= SOON_DAYS;
};

/** 스냅샷을 만든 뒤 날짜가 지나 이미 마감된 공고는 뺀다. 스냅샷 당시 상태와 관계없이 마감일로 판단한다. */
export const notExpired = (p: Program, today: string) => !(p.period.end && p.period.end < today);

/** 스냅샷 당시 상태 대신 오늘 날짜로 접수 상태를 다시 정한다. 마감된 공고는 notExpired 로 먼저 걸러야 한다. */
export function withStatus(p: Program, today: string): Program {
  const { start, end, status } = p.period;
  if (!start || !end) return p;
  const next = start > today ? "접수 예정" : "접수 중";
  return next === status ? p : { ...p, period: { ...p.period, status: next } };
}

const statusOrder = { "접수 중": 0, "접수 예정": 1, 수시: 2, 미기재: 3 } as const;

export function sorter(mode: SortMode): (a: ProgramMatch, b: ProgramMatch) => number {
  if (mode === "new") return (a, b) => b.program.created.localeCompare(a.program.created);
  if (mode === "deadline")
    return (a, b) =>
      statusOrder[a.program.period.status] - statusOrder[b.program.period.status] ||
      endKey(a.program).localeCompare(endKey(b.program)) ||
      b.program.created.localeCompare(a.program.created);
  return sortMatches;
}

// 지원 종류별로 자주 쓰이는 낱말(기업마당 해시태그 빈도 기준). 누르면 결과 안에서 찾는다.
export const needChips: Record<NeedId, string[]> = {
  loan: ["운전자금", "시설자금", "이차보전", "특례보증", "창업자금"],
  startup: ["예비창업자", "사업화", "멘토링", "TIPS", "청년"],
  tech: ["인증", "시제품", "지식재산", "기술이전", "실증"],
  export: ["물류비", "해외인증", "전시회", "해외지사화", "통역"],
  all: ["운전자금", "인증", "컨설팅", "물류비", "창업"],
};

export const glossary = [
  { term: "융자", desc: "정책기관이나 은행이 정책 목적에 따라 빌려주는 자금. 갚아야 하는 돈입니다." },
  { term: "보증", desc: "담보가 부족할 때 보증기관이 보증서를 발급해 은행 대출을 받을 수 있게 하는 제도입니다." },
  { term: "이차보전", desc: "은행 대출 이자의 일부를 지자체나 기관이 대신 부담해 주는 지원입니다." },
  { term: "모태펀드 자펀드", desc: "정부 재원인 한국모태펀드가 출자해 민간 운용사가 운용하는 벤처펀드입니다." },
  { term: "운용사", desc: "펀드를 맡아 투자 대상을 고르고 투자하는 회사입니다. 투자 제안은 펀드가 아니라 운용사에 합니다." },
];

export const programHaystack = (p: Program) => `${p.title} ${p.agency} ${p.operator} ${p.sub} ${p.tags.join(" ")}`;

// ---------- 기존 투자자 표시 ----------

const LETTERS: Record<string, string> = {
  A: "에이", B: "비", C: "씨", D: "디", E: "이", F: "에프", G: "지", H: "에이치", I: "아이", J: "제이", K: "케이", L: "엘", M: "엠",
  N: "엔", O: "오", P: "피", Q: "큐", R: "알", S: "에스", T: "티", U: "유", V: "브이", W: "더블유", X: "엑스", Y: "와이", Z: "제트",
};

/** 운용사 이름을 견주기 위한 열쇠. 법인 표기와 공백을 빼고, 'KB'처럼 대문자 약어는 한글 표기('케이비')로 바꾼다. */
export function gpKey(name: string): string {
  return name
    .replace(/주식회사|유한회사|유한책임회사|\(주\)|\(유\)|㈜/g, "")
    .replace(/[\s·.,&()\-]/g, "")
    .replace(/[A-Z]/g, (ch) => LETTERS[ch])
    .toLowerCase();
}

/** 모태펀드 운용사 이름이 회사의 기존 투자자 목록에 있는지. 이름이 같을 때만 일치로 본다. */
export function isExistingInvestor(gp: string, investors: readonly string[]): boolean {
  const key = gpKey(gp);
  return key.length >= 2 && investors.some((n) => gpKey(n) === key);
}

/**
 * 기존 투자자로 분류해도 되는 기록만 고른다. 원문에서 확인됐거나 보도·자료에 기재된 것만 해당한다.
 * 추정(inferred)이나 출처 간 불일치(conflicting) 기록으로 '이미 투자한 곳'이라고 단정하지 않는다.
 */
export function splitInvestors<T extends { name: string; status: string }>(investors: readonly T[]): { established: T[]; uncertain: T[] } {
  const established = investors.filter((i) => i.status === "confirmed" || i.status === "reported");
  return { established, uncertain: investors.filter((i) => !established.includes(i)) };
}
