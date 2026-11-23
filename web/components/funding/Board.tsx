"use client";

// 자금 조달 목록(빌리는 돈 / 투자받는 돈)과 카드. 대조 규칙은 lib/finder.ts 그대로 쓴다.
// 이 화면은 유료 호출을 하지 않는다(F-09). 자격 대조·운용사 요약은 심사 준비에서 한다.
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  SOON_DAYS, dday, fundAlive, fundFields, glossary, groupFunds, inNeed, isSoon, matchProgram, needChips, needs, notExpired, programHaystack, shortDate, withStatus,
  type Fund, type GpGroup, type Meta, type Only, type Profile, type Program, type ProgramMatch, type SortMode,
} from "@/lib/finder";
import { programSorter } from "@/lib/funding";
import { msToNextKstMidnight, todayKST } from "@/lib/format";
import { Disclosure, ExtLink, useMore } from "@/components/kit";

// ---------------------------------------------------------------- 공고·펀드 목록(정적 파일, 한 번만 받는다)

export type PublicData = { programs: Program[]; funds: Fund[]; meta: Meta };
let dataState: { data: PublicData | null; error: boolean; started: boolean } = { data: null, error: false, started: false };
const dataListeners = new Set<() => void>();
function loadData() {
  if (dataState.started) return;
  dataState = { ...dataState, started: true };
  Promise.all(["programs", "funds", "meta"].map((n) => fetch(`/data/${n}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(n))))))
    .then(([programs, funds, meta]) => (dataState = { data: { programs, funds, meta }, error: false, started: true }))
    .catch(() => (dataState = { data: null, error: true, started: true }))
    .finally(() => dataListeners.forEach((l) => l()));
}
export function usePublicData() {
  return useSyncExternalStore(
    (cb) => {
      dataListeners.add(cb);
      loadData();
      return () => void dataListeners.delete(cb);
    },
    () => dataState,
    () => dataState,
  );
}

export const LoadError = () => <p className="mt-4 rounded-md bg-wash p-4 font-medium">공고와 펀드 목록을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>;

// ---------------------------------------------------------------- 계산

export type BoardResult = {
  list: ProgramMatch[];
  scoped: number;
  counts: { all: number; soon: number; local: number };
  byRegion: number;
  byTarget: number;
  gps: GpGroup[];
  live: Program[];
  funds: Fund[];
};

export function computeBoard(data: PublicData, prof: Profile, today: string, q: string, sort: SortMode, only: Only, related: (p: Program) => boolean): BoardResult {
  const query = q.trim();
  const funds = data.funds.filter((f) => fundAlive(f, today));
  const live = data.programs.filter((p) => notExpired(p, today)).map((p) => withStatus(p, today));
  const scoped = live.filter((p) => inNeed(p, prof.need) && (!query || programHaystack(p).includes(query)));
  const matches = scoped.map((p) => matchProgram(p, prof));
  const ok = matches.filter((m) => m.ok);
  const soon = ok.filter((m) => isSoon(m.program, today));
  const local = ok.filter((m) => m.local);
  const list = (only === "soon" ? soon : only === "local" ? local : ok).slice().sort(programSorter(only === "soon" && sort === "rec" ? "deadline" : sort, related));
  return {
    list, scoped: scoped.length, counts: { all: ok.length, soon: soon.length, local: local.length },
    byRegion: matches.filter((m) => m.excluded === "지역").length, byTarget: matches.filter((m) => m.excluded === "대상").length,
    // 자주 찾는 낱말은 공고용이라 운용사 목록에는 적용하지 않는다. 직접 입력한 낱말만 양쪽에 적용한다
    gps: groupFunds(funds, prof.field, needChips[prof.need].includes(query) ? "" : query), live, funds,
  };
}

// ---------------------------------------------------------------- 카드

/**
 * 목록 줄 오른쪽 끝 칸(screens 1.12): 큰 줄(D-12, 이미 투자함)과 작은 줄(12.31 마감). 좁은 화면은 한 줄로 이어진다.
 * 화면 읽기에는 지금처럼 "D-12, 12.31 마감" 한 덩어리로 읽힌다.
 */
export function Due({ main, sub, strong = false }: { main: ReactNode; sub?: ReactNode; strong?: boolean }) {
  return (
    <span className="lrow-end">
      <span className={`due-main num ${strong ? "font-bold" : ""}`}>{main}</span>
      {sub && (
        <>
          <span className="sr-only">, </span>
          <span className="due-sub num">{sub}</span>
        </>
      )}
    </span>
  );
}

/** "D-12, 12.31 마감" 같은 기한 글을 큰 줄과 작은 줄로 나눈다(쉼표 앞이 큰 줄). 7일 안 마감(D-0~D-7, 오늘 마감)은 더 굵게 */
export function DueText({ text }: { text: string }) {
  const i = text.indexOf(", ");
  const main = i < 0 ? text : text.slice(0, i);
  const d = /^D-(\d+)$/.exec(main);
  // 남은 날이 있는 기한만 큰 줄로. "입찰 예정 12.5", "신청기간 미기재" 같은 글은 보통 크기 한 줄
  if (!d && main !== "오늘 마감")
    return (
      <span className="lrow-end">
        <span className="num whitespace-nowrap text-sm">{text}</span>
      </span>
    );
  const strong = main === "오늘 마감" || Number(d![1]) <= 7;
  return i < 0 ? <Due main={main} strong={strong} /> : <Due main={main} sub={text.slice(i + 2)} strong={strong} />;
}

function Deadline({ p, today }: { p: Program; today: string }) {
  const pd = p.period;
  if (pd.status === "접수 중") {
    const d = dday(pd.end, today) ?? 0;
    // 7일 안 마감은 더 굵게만. 호박색은 엇갈림·확인 필요에만 쓴다
    return <Due main={d === 0 ? "오늘 마감" : `D-${d}`} sub={`${shortDate(pd.end)} 마감`} strong={d <= 7} />;
  }
  if (pd.status === "접수 예정") return <Due main={shortDate(pd.start)} sub="접수 시작" />;
  return (
    <span className="lrow-end">
      {/* 기간 원문은 길이가 정해져 있지 않아(예: "2020.01.01 ~ 2026.12.31", "예산 소진 시까지") 칸 안에서 줄을 바꾼다. 짧은 날짜 글만 한 줄로 둔다 */}
      <span className="due-sub whitespace-normal" data-due-raw>
        {pd.raw || "신청기간 미기재"}
      </span>
    </span>
  );
}

/** 분류·지역·개수 꼬리표. 상태 낱말과 섞이지 않게 테두리 없는 보조 글(globals.css .meta) */
const mark = "meta";

export type SaveSpec = { on: boolean; toggle: () => void; onText: string; offText: string; sr: string };

function SaveButton({ s }: { s: SaveSpec }) {
  return (
    <button type="button" className={`btn ${s.on ? "btn-pressed" : ""}`} aria-pressed={s.on} aria-label={s.sr} onClick={s.toggle}>
      {s.on ? s.onText : s.offText}
    </button>
  );
}

export function ProgramCard({ m, today, related, save, foot }: { m: ProgramMatch; today: string; related: boolean; save: SaveSpec; foot?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [ever, setEver] = useState(false);
  const p = m.program;
  const benefit = p.points[1] ?? p.points[0] ?? p.intro;
  const region = m.local && p.regions.includes("전국") ? p.agencyRegion ?? "전국" : p.regions.join(", ");
  return (
    <article className={`card p-4 ${save.on ? "border-ledger" : ""}`} data-program={p.id}>
      {/* 목록 줄: 왼쪽 분류·제목·지원 내용·기관, 오른쪽 끝 기한(좁은 화면은 분류 줄 끝) */}
      <div className="lrow">
        <div className="lrow-meta flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={mark}>{p.sub || p.category}</span>
          {/* 지역이 여럿인 공고(예: 10개 시·도)는 글이 길어 칸 안에서 줄을 바꾼다. 안 그러면 좁은 화면에서 오른쪽 기한 칸을 덮는다 */}
          <span className={`${mark} whitespace-normal`}>{region}</span>
          {related && <span className="tag">회사 사업과 관련</span>}
          {!m.ok && <span className="tag">{m.excluded === "지역" ? "지금 조건과 다른 지역" : "지금 조건과 다른 대상"}</span>}
        </div>
        <Deadline p={p} today={today} />
        <div className="lrow-main">
          <h3 className="clamp-2 mt-1 text-lg font-semibold leading-snug">{p.title}</h3>
          {benefit && <p className="clamp-2 mt-1 text-sm">{benefit}</p>}
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-sub">
            <span>{p.agency}</span>
            {p.operator && p.operator !== p.agency && <span>운영 {p.operator}</span>}
          </p>
        </div>
      </div>
      <div className="no-print mt-3 flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <button
          type="button"
          className="btn btn-quiet -ml-2.5"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setEver(true);
          }}
        >
          {open ? "접기" : "자세히"}
          {!open && m.checks.length > 0 && <span className="num text-xs font-medium text-sub">확인 {m.checks.length}</span>}
        </button>
        <span className="ml-auto flex gap-2">
          <SaveButton s={save} />
          <ExtLink href={p.url} className="btn">
            공고 원문
          </ExtLink>
        </span>
      </div>
      {ever && (
        <div className={open ? "mt-3 space-y-3 rounded-md bg-wash p-3 text-sm" : "hidden"}>
          {p.points[0] && (
            <p>
              <span className="mr-2 font-semibold text-sub">대상</span>
              {p.points[0]}
            </p>
          )}
          {m.reasons.length > 0 && (
            <div>
              <p className="font-semibold">맞는 점</p>
              <ul className="list-disc pl-5">
                {m.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {m.checks.length > 0 && (
            <div>
              <p className="font-semibold">확인할 점</p>
              <ul className="list-disc pl-5">
                {m.checks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {p.docUrl && (
              <ExtLink href={p.docUrl} className="btn">
                공고문 파일
              </ExtLink>
            )}
            {p.applyUrl && (
              <ExtLink href={p.applyUrl} className="btn">
                신청 페이지
              </ExtLink>
            )}
          </div>
          {p.contact && <p>문의 {p.contact}</p>}
          <p className="num text-xs text-sub">등록 {p.created}, 출처 기업마당</p>
          {foot}
        </div>
      )}
    </article>
  );
}

export function GpCard({ g, existing, rivals, save, showBadges = true }: { g: GpGroup; existing: boolean; rivals: string[]; save: SaveSpec; showBadges?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = g.funds[0];
  return (
    <article className={`card p-4 ${save.on ? "border-ledger" : ""}`} data-gp={g.gp}>
      {/* 목록 줄: 왼쪽 펀드 수·운용사 이름·대표 펀드, 오른쪽 끝 표시(이미 투자함·경쟁사에 투자)와 최근 결성 연도 */}
      <div className="lrow">
        <div className="lrow-meta flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={mark}>펀드 {g.funds.length}개</span>
        </div>
        <span className="lrow-end">
          {showBadges && existing && <span className="tag">이미 투자함</span>}
          {showBadges && rivals.length > 0 && <span className="tag">경쟁사에 투자</span>}
          <span className="num whitespace-nowrap text-sm">최근 결성 {g.latestYear}년</span>
        </span>
        <div className="lrow-main">
          <h3 className="mt-1 text-lg font-semibold leading-snug">{g.gp}</h3>
          {rivals.length > 0 && <p className="text-sm">{rivals.join(", ")}에 투자한 곳입니다.</p>}
          <p className="clamp-2 mt-1 text-sm">{first.name}</p>
          <p className="num text-xs text-sub">
            출자 분야 {first.field}, 만기 {first.maturity}
          </p>
        </div>
      </div>
      <div className="no-print mt-3 flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        {g.funds.length > 1 && (
          <button type="button" className="btn btn-quiet -ml-2.5" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "접기" : `펀드 ${g.funds.length}개 보기`}
          </button>
        )}
        <span className="ml-auto flex gap-2">
          <SaveButton s={save} />
          <ExtLink href={`https://search.naver.com/search.naver?query=${encodeURIComponent(`${g.gp} 투자 문의`)}`} className="btn">
            웹에서 찾기
          </ExtLink>
        </span>
      </div>
      {open && (
        <ul className="mt-3 divide-y divide-rule rounded-md bg-wash px-3 text-sm">
          {g.funds.map((f) => (
            <li key={f.name} className="py-2">
              <p className="font-medium">{f.name}</p>
              <p className="num text-xs text-sub">
                출자 분야 {f.field}, {f.year}년 결성, 만기 {f.maturity}
              </p>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- 갈래

/** 처음 5장, 그다음 10장씩(F-03) */
export function CardList<T>({ items, render, empty, keyOf, listClass = "mt-3 space-y-3" }: { items: T[]; render: (t: T) => ReactNode; empty: string; keyOf: (t: T) => string; listClass?: string }) {
  const mr = useMore(items.length, 5, 10);
  const { reset } = mr;
  useEffect(() => reset(), [items, reset]);
  if (!items.length) return <p className="mt-3 rounded-md border border-dashed border-edge p-5 text-sm">{empty}</p>;
  return (
    <div>
      <div id={mr.listId} className={listClass}>
        {items.slice(0, mr.count).map((t, i) => (
          <div key={keyOf(t)} data-item={i}>
            {render(t)}
          </div>
        ))}
      </div>
      {mr.left > 0 && (
        <button type="button" className="btn mt-3 w-full font-medium" onClick={mr.more}>
          10건 더 보기 ({mr.left}건 남음)
        </button>
      )}
    </div>
  );
}

export function LaneHead({ lane, title, line }: { lane: "debt" | "equity"; title: string; line: string }) {
  return (
    <div className={`${lane === "debt" ? "lane-debt" : "lane-equity"} pt-3`}>
      {/* 좁은 화면은 갈래 탭이 제목을 대신 보인다. 제목 순서(h1 → h2 → h3)는 화면 읽기에 남긴다 */}
      <h2 className="sr-only text-lg font-bold lg:not-sr-only">{title}</h2>
      <p className="text-sm">{line}</p>
    </div>
  );
}

/** 중간·좁은 화면의 갈래 탭(단계 메뉴 아래 붙는다) */
export function LaneTabs({ lane, setLane, debt, equity }: { lane: "debt" | "equity"; setLane: (l: "debt" | "equity") => void; debt: number; equity: number }) {
  return (
    <div role="tablist" aria-label="갈래" className="no-print sticky top-[49px] z-20 -mx-4 mt-4 flex border-b border-rule bg-paper px-4 sm:-mx-6 sm:px-6 lg:hidden">
      {(
        [
          ["debt", "빌리는 돈", debt],
          ["equity", "투자받는 돈", equity],
        ] as const
      ).map(([id, label, n]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={lane === id}
          onClick={() => setLane(id)}
          className={`min-h-12 flex-1 text-[15px] ${lane === id ? `font-semibold text-ink ${id === "debt" ? "shadow-[inset_0_-3px_0_var(--color-debt)]" : "shadow-[inset_0_-3px_0_var(--color-equity)]"}` : "text-ink"}`}
        >
          {label} <span className="num">{n}</span>
        </button>
      ))}
    </div>
  );
}

/** 빠른 거르기 3개 */
export function QuickFilters({ only, setOnly, counts, region }: { only: Only; setOnly: (o: Only) => void; counts: BoardResult["counts"]; region: string }) {
  const quick: { id: Only; label: string; n: number }[] = [
    { id: "all", label: "전체", n: counts.all },
    { id: "soon", label: `마감 임박(${SOON_DAYS}일 내)`, n: counts.soon },
    { id: "local", label: `${region} 공고`, n: counts.local },
  ];
  return (
    <div role="group" aria-label="빠른 거르기" className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1">
      {quick.map((c) => (
        <button key={c.id} type="button" className="chip" aria-pressed={only === c.id} onClick={() => setOnly(c.id)}>
          {c.label} <span className="num">{c.n}</span>
        </button>
      ))}
    </div>
  );
}

const SORT_TEXT: Record<SortMode, string> = { rec: "우리 지역·마감순", deadline: "마감 임박순", new: "최신 등록순" };

/** 2층 "거르기와 정렬". 걸린 거르기가 있으면 접힌 줄에 요약 */
export function FilterPanel({ need, q, setQ, sort, setSort, memoryKey }: { need: Profile["need"]; q: string; setQ: (v: string) => void; sort: SortMode; setSort: (s: SortMode) => void; memoryKey: string }) {
  const parts = [q.trim() ? `낱말: ${q.trim()}` : "", sort !== "rec" ? SORT_TEXT[sort] : ""].filter(Boolean);
  const text = parts.length ? `거르기와 정렬 (${parts.join(", ")})` : "거르기와 정렬";
  return (
    <Disclosure text={text} openText={text} memoryKey={memoryKey}>
      <div className="space-y-3 py-2">
        <div role="group" aria-label="자주 찾는 낱말" className="-mx-1 flex gap-2 overflow-x-auto px-1">
          {needChips[need].map((k) => (
            <button key={k} type="button" className="chip" aria-pressed={q === k} onClick={() => setQ(q === k ? "" : k)}>
              {k}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="min-w-0 flex-1 text-sm">
            <span className="sr-only">결과 안에서 찾기</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="결과 안에서 찾기" className="min-h-11 w-full rounded-md border border-edge bg-paper px-3 text-base outline-none focus:border-ledger" />
          </label>
          <label className="text-sm">
            <span className="sr-only">정렬</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} className="min-h-11 rounded-md border border-edge bg-paper px-2 text-base outline-none focus:border-ledger">
              {(Object.keys(SORT_TEXT) as SortMode[]).map((s) => (
                <option key={s} value={s}>
                  {SORT_TEXT[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </Disclosure>
  );
}

/** 바닥: 기준일·출처, 용어 풀이, 이 목록이 판단하는 것과 하지 않는 것 */
export function BoardFoot({ meta, memoryKey }: { meta: Meta; memoryKey: string }) {
  return (
    <div className="mt-8 space-y-1">
      <div className="source">
        <p className="num">
          데이터 기준일 {meta.asOf}. 출처 기업마당 지원사업정보(접수 가능 {meta.programs.total.toLocaleString()}건), 한국벤처투자 펀드현황(만기 전 모태 자펀드 {meta.funds.listed.toLocaleString()}개,{" "}
          {meta.funds.latestYear}년 결성분까지)
        </p>
      </div>
      <Disclosure text="용어 풀이" memoryKey={`${memoryKey}:glossary`}>
        <dl className="space-y-2 py-2 text-sm">
          {glossary.map((g) => (
            <div key={g.term}>
              <dt className="inline font-semibold">{g.term}</dt> <dd className="inline">{g.desc}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
      <Disclosure text="이 목록이 판단하는 것과 하지 않는 것" memoryKey={`${memoryKey}:scope`}>
        <ul className="list-disc space-y-1 py-2 pl-5 text-sm">
          <li>공고는 기업마당이 분류한 지역·지원대상·지원분야로만 걸렀습니다. 업력, 업종, 매출 같은 세부 자격은 공고문에 있고 여기서는 대조하지 않습니다.</li>
          <li>펀드는 한국모태펀드가 출자한 자펀드만 있습니다. 출자 분야 이름으로 분류했으며 투자 대상의 정확한 정의는 운용사와 출자 공고에서 확인해야 합니다.</li>
        </ul>
      </Disclosure>
    </div>
  );
}

/** 담은 항목 막대(screens 1.9) */
export function SavedBar({ n, href, label = "심사 준비로 가기" }: { n: number; href: string; label?: string }) {
  if (n <= 0) return null;
  return (
    <div className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-ledger bg-ledger-soft">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-3 px-4 py-2 sm:px-6">
        <p className="num font-semibold text-ledger">담은 항목 {n}개</p>
        <Link href={href} className="btn btn-primary">
          {label}
        </Link>
      </div>
    </div>
  );
}

export const needLabel = (id: Profile["need"]) => needs.find((n) => n.id === id)?.label ?? "";
export const fieldLabel = (id: Profile["field"]) => fundFields.find((f) => f.id === id)?.label ?? "";

/** 오늘(한국 시간). 서버에서 그릴 때는 빈 글이라 날짜에 기대는 목록은 브라우저에서만 만든다 */
/**
 * 오늘 날짜(서울)를 쓰는 화면이 날이 바뀌면 다시 그리게 한다: 서울 자정에 한 번, 그리고 잠들었던 탭이 다시 보일 때.
 * 그래야 열어 둔 채 자정을 넘긴 화면이 어제 기준 "오늘 마감"·마감 임박 개수를 계속 보이지 않는다.
 */
function subscribeToday(cb: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      cb();
      arm();
    }, msToNextKstMidnight(Date.now()));
  };
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    cb();
    arm();
  };
  arm();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
export function useToday() {
  return useSyncExternalStore(subscribeToday, () => todayKST(), () => "");
}

export function useBoard(data: PublicData | null, prof: Profile | null, today: string, q: string, sort: SortMode, only: Only, related: (p: Program) => boolean) {
  return useMemo(() => (data && prof && today ? computeBoard(data, prof, today, q, sort, only, related) : null), [data, prof, today, q, sort, only, related]);
}
