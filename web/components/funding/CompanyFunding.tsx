"use client";

// 자금·판로(screens 5절, 2026-11-23 "자금 조달"에서 이름을 바꿈): 회사 분석 값으로 조건을 채우고 공고·운용사·판로 기회를 고르고 담는다. 유료 호출 없음(판로 갈래의 나라장터 조회는 무료).
// 갈래 셋(2026-11-23 화면 구조 개편): 빌리는 돈 / 투자받는 돈 / 판로. 넓은 화면은 앞 둘을 나란히, 판로는 그 아래 단. 중간·좁은 화면은 탭 셋.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { STATUS_LABEL, type BizTypeId, type Merged, type Status } from "@/lib/contract";
import { bizTypes, fundFields, needs, regionOptions, type Only, type Profile, type Program, type SortMode } from "@/lib/finder";
import { initialConditions, relatedTo, rivalBackers, splitExisting, type ConditionSource, type Conditions } from "@/lib/funding";
import { isSaved, reviewCount, savedNotices, setEdit, toggleSaved } from "@/lib/local";
import { isTerminal } from "@/lib/view";
import { BIZ_LABEL } from "@/lib/company-values";
import { Disclosure, StatusWord } from "@/components/kit";
import { useCompany } from "@/components/company/context";
import {
  BoardFoot, CardList, FilterPanel, GpCard, LaneHead, LaneTabs, LoadError, ProgramCard, QuickFilters, SavedBar, TermList, fieldLabel, needLabel, noticeSave, useBoard, usePublicData, useToday, type Lane,
} from "@/components/funding/Board";
import { SalesLane } from "@/components/Sales";

const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | null => (v && allowed.includes(v as T) ? (v as T) : null);

export function CompanyFunding() {
  const c = useCompany();
  // 회사 값과 이 브라우저 자료를 받은 뒤에 조건을 정한다. 그 뒤 회사 값이 바뀌어도 사용자가 본 조건은 자동으로 바꾸지 않는다(F-13)
  if (c.phase === "loading" || !c.local.loaded) return <main className="mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6"><h1 className="text-2xl font-semibold">자금·판로</h1></main>;
  return <FundingInner />;
}

function FundingInner() {
  const c = useCompany();
  const job = c.job;
  const sp = useSearchParams();
  const path = usePathname();
  const { data, error } = usePublicData();
  const today = useToday();
  const ready = !job || isTerminal(job.sections.official);

  // 조건: 주소(사용자가 바꾼 것) → 회사 값
  const init = initialConditions(job?.merged ?? null, c.local.edits);
  // 주소의 조건은 한 번만 검사해 그 값으로 조건·"직접 고름" 표시·출처를 모두 정한다. 틀린 값(예: ?r=invalid)은 없는 것으로 본다(리뷰 P3)
  const [urlCond] = useState(() => ({
    region: oneOf(sp.get("r"), regionOptions),
    biz: oneOf(sp.get("b"), bizTypes.map((b) => b.id)),
    need: oneOf(sp.get("n"), needs.map((n) => n.id)),
    field: oneOf(sp.get("f"), fundFields.map((f) => f.id)),
  }));
  const [cond0, setCond] = useState<Conditions>(() => ({
    region: urlCond.region ?? init.cond.region,
    biz: urlCond.biz,
    need: urlCond.need ?? "loan",
    field: urlCond.field,
  }));
  const [chosen, setChosen] = useState<Partial<Record<keyof Conditions, true>>>(() => ({
    ...(urlCond.region ? { region: true } : {}), ...(urlCond.biz ? { biz: true } : {}), ...(urlCond.need ? { need: true } : {}), ...(urlCond.field ? { field: true } : {}),
  }));
  // 기업 유형은 사용자가 고른 것(회사 정보 수정·표시줄에서 고른 것 포함), 관심 분야는 회사 분석 값을 따라간다
  const cond: Conditions = { ...cond0, biz: cond0.biz ?? init.cond.biz, field: cond0.field ?? init.cond.field };
  const [seenRegion, setSeenRegion] = useState<string | null>(() => cond0.region);
  // 지금 지역 조건이 어디서 왔는가(도움말 "자료 출처"·조건 칩 상태 낱말). 처음 연 때 한 번 정하고, 분석 결과 지역을 받아들이거나
  // 직접 고를 때만 바꾼다. 다시 분석해 회사 분석의 지역이 바뀌어도 사용자가 그대로 둔 조건의 출처는 처음 그대로다(리뷰 P2)
  const [regionSrc, setRegionSrc] = useState<RegionSource>(() => regionSourceOf(urlCond.region ? null : init.from.region, job?.merged ?? null));
  // 이 방문에서 기업 유형 상자에서 골랐는가. 고른 뒤에도 상자를 남겨 고른 것을 보이고(누른 자리가 사라져 화면이 올라붙지 않게), 다음 방문부터는 조건 칩에만 보인다
  const [bizHere, setBizHere] = useState(false);

  const [q, setQ] = useState(sp.get("q") ?? "");
  const [sort, setSort] = useState<SortMode>(oneOf(sp.get("s"), ["rec", "deadline", "new"] as const) ?? "rec");
  const [only, setOnly] = useState<Only>(oneOf(sp.get("o"), ["all", "soon", "local"] as const) ?? "all");
  const [lane, setLane] = useState<Lane>(sp.get("lane") === "invest" ? "equity" : sp.get("lane") === "sales" ? "sales" : "debt");
  // 넓은 화면에서 판로 갈래로 열면(옛 판로 주소 포함) 판로 단으로 한 번 스크롤한다. 좁은 화면은 판로 탭이 골라진 채 열린다.
  // 판로 단은 공고·펀드 목록을 받은 뒤에 그리므로(아래 salesShown) 그때 스크롤한다. 첫 그림에는 #lane-sales 가 없어
  // 처음 한 번만 돌면 스크롤하지 못하고, 판로 단이 화면에 들어오지 않아 나라장터 조회도 나가지 않았다(리뷰 P2, F-24)
  const salesShown = Boolean(data || error);
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || lane !== "sales" || !salesShown || !window.matchMedia("(min-width: 1024px)").matches) return;
    scrolled.current = true;
    requestAnimationFrame(() => document.getElementById("lane-sales")?.scrollIntoView({ block: "start" }));
  }, [lane, salesShown]);

  // 사용자가 바꾼 조건만 주소에 남긴다
  const urlKey = [lane, chosen.region && cond.region, chosen.biz && cond.biz, chosen.need && cond.need, chosen.field && cond.field, q.trim(), sort, only].join("|");
  useEffect(() => {
    const u = new URLSearchParams();
    if (lane === "equity") u.set("lane", "invest");
    if (lane === "sales") u.set("lane", "sales");
    if (chosen.region && cond.region) u.set("r", cond.region);
    if (chosen.biz && cond.biz) u.set("b", cond.biz);
    if (chosen.need) u.set("n", cond.need);
    if (chosen.field && cond.field) u.set("f", cond.field);
    if (q.trim()) u.set("q", q.trim());
    if (sort !== "rec") u.set("s", sort);
    if (only !== "all") u.set("o", only);
    const s = u.toString();
    window.history.replaceState(window.history.state, "", `${path}${s ? `?${s}` : ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey, path]);

  // 법인 없이 분석해 facts 가 나중에 본사 지역을 주면 묻는다(F-13). 묻기만 하고 바꾸지 않는다
  const laterRegion = job?.merged.region && (job.merged.region.status === "confirmed" || job.merged.region.status === "reported") ? String(job.merged.region.raw) : null;
  const regionAsk = !chosen.region && laterRegion && regionOptions.includes(laterRegion) && laterRegion !== cond.region && laterRegion !== seenRegion ? laterRegion : null;

  const keywords = useMemo(() => job?.merged.programKeywords ?? [], [job?.merged.programKeywords]);
  const related = useCallback((p: Program) => relatedTo(p, keywords), [keywords]);
  const prof: Profile | null = cond && cond.region && cond.biz && cond.field ? { region: cond.region, biz: cond.biz, need: cond.need, field: cond.field } : null;
  const result = useBoard(data, prof, today, q, sort, only, related);
  const investors = job?.merged.investors;
  const split = useMemo(() => (result ? splitExisting(result.gps, investors ?? []) : null), [result, investors]);
  const backers = useMemo(() => rivalBackers(job?.sections.rivals_deep.result), [job?.sections.rivals_deep.result]);
  const deepDone = Boolean(job?.sections.rivals_deep.result);

  const set = <K extends keyof Conditions>(k: K, v: Conditions[K]) => {
    setCond((cur) => ({ ...cur, [k]: v }));
    setChosen((ch) => ({ ...ch, [k]: true }));
    if (k === "need") setQ("");
    if (k === "biz" && v) setEdit(c.cid, "bizType", v as string);
  };

  const n = reviewCount(c.local);
  const savedPrograms = savedNotices(c.local.saved).length;
  const savedGps = c.local.saved.filter((s) => s.kind === "gp").length;
  const goTab = savedPrograms === 0 && savedGps > 0 ? "?tab=invest" : "";

  // 같은 공고가 빌리는 돈과 판로 갈래에 함께 나와도 담기 상태는 하나다(screens 5절)
  const saveProgram = (p: Program) => noticeSave(c.cid, c.local, p, "program");
  const saveGp = (gp: string, existing: boolean, funds: number, year: number) => ({
    on: isSaved(c.local, "gp", gp),
    toggle: () => toggleSaved(c.cid, { kind: "gp", itemId: gp, title: gp, meta: { existing, funds, latestYear: year } }),
    onText: "담음", offText: "담기", sr: `심사 준비로 담기: ${gp}`,
  });

  const m = job?.merged;
  const regionWord = !chosen.region && regionSrc?.kind === "analysis" ? regionSrc.word : null;

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 pb-24 pt-6 sm:px-6">
      <h1 className="text-2xl font-semibold">자금·판로</h1>
      {(!job || !ready) && <p className="mt-2 lg:max-w-[760px]">회사 분석 결과를 받는 중입니다. 조건을 직접 골라도 됩니다.</p>}

      {/* 넓은 화면 가로 폭(visual-plan 7절): 조건·안내·거르기·바닥 글은 글 폭 760, 두 갈래 나란히(data-wide)만 틀 전체(내용 1152).
          1024 미만은 지금 배치 그대로(모든 폭 제한에 lg: 를 붙였다) */}
      {cond && (
        <div className="mt-4 lg:max-w-[760px]">
          <p className="text-sm font-semibold">회사 분석 결과로 채운 조건</p>
          {/* 휴대폰에서는 조건 칩 4개를 한 줄로 두고 가로로 밀어 본다(4줄로 쌓여 목록이 밀리지 않게) */}
          <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 py-1.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&>*]:shrink-0">
            <CondSelect label="지역" value={cond.region} options={regionOptions.map((r) => ({ id: r, label: r }))} onChange={(v) => set("region", v)} chosen={chosen.region} word={regionWord} />
            <CondSelect label="기업 유형" value={cond.biz} options={bizTypes} onChange={(v) => set("biz", v as BizTypeId)} chosen={chosen.biz ?? Boolean(c.local.edits.bizType)} />
            <CondSelect label="필요한 지원" value={cond.need} options={needs} onChange={(v) => set("need", v as Conditions["need"])} chosen={chosen.need} />
            <CondSelect label="관심 투자 분야" value={cond.field} options={fundFields} onChange={(v) => set("field", v as Conditions["field"])} chosen={chosen.field} word={chosen.field ? null : cond.field && m?.fundField ? m.fundField.status : null} />
          </div>
          {regionAsk && (
            <div className="mt-3 rounded-md bg-amber-soft p-3 text-amber" role="status">
              <p className="font-medium">
                회사 분석에서 본사 지역({regionAsk}, {m?.region ? STATUS_LABEL[m.region.status] : ""})을 찾았습니다. 조건을 바꿀까요?
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setCond((cur) => ({ ...cur, region: regionAsk }));
                    setSeenRegion(regionAsk);
                    setRegionSrc(regionSourceOf("analysis", m ?? null));
                  }}
                >
                  바꾸기
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setSeenRegion(regionAsk)}
                >
                  그대로 두기
                </button>
              </div>
            </div>
          )}
          <p className="mt-3 text-sm">기업마당 분류값으로 거른 목록입니다. 세부 자격은 담은 뒤 심사 준비에서 공고문으로 대조합니다.</p>
        </div>
      )}

      {cond && (!cond.biz || bizHere) && (
        <BizStep
          current={cond.biz}
          hint={m?.bizTypeHint ?? null}
          onPick={(b) => {
            set("biz", b);
            setBizHere(true);
          }}
        />
      )}
      {cond && cond.biz && (!cond.region || !cond.field) && (
        <p className="mt-5 rounded-md bg-wash p-4 lg:max-w-[760px]">지역과 관심 투자 분야를 고르면 목록이 나옵니다.</p>
      )}

      {error && (
        <div className="lg:max-w-[760px]">
          <LoadError />
        </div>
      )}
      {!data && !error && prof && <p className="mt-6 text-sub lg:max-w-[760px]">공고와 펀드 목록을 불러오는 중입니다</p>}

      {/* 갈래 탭(중간·좁은 화면)은 기업 유형을 고르기 전에도 둔다. 판로 갈래의 입찰공고는 기업 유형 없이 찾는다 */}
      {cond && <LaneTabs lane={lane} setLane={setLane} debt={result ? result.list.length : null} equity={result ? result.gps.length : null} />}

      {result && split && prof && data && (
        <>
          {/* 빠른 필터·필터 및 정렬은 빌리는 돈·투자받는 돈에만 걸린다. 좁은 화면은 탭 아래에 두어 판로 탭으로 바꿀 때 탭 위 내용이 바뀌지 않게 한다 */}
          <div className={`lg:max-w-[760px] ${lane === "sales" ? "hidden lg:block" : ""}`}>
            <div className="mt-4">
              <QuickFilters only={only} setOnly={(o) => setOnly(o)} counts={result.counts} region={prof.region} />
            </div>
            {/* 찾기·정렬은 목록 앞에 둔다(카드를 다 지나야 닿지 않게) */}
            <div className="mt-2">
              <FilterPanel need={prof.need} q={q} setQ={setQ} sort={sort} setSort={setSort} memoryKey={`${c.cid}:fu:filter`} />
            </div>
          </div>
          <div className={`mt-4 grid gap-8 lg:grid-cols-2 ${lane === "sales" ? "hidden lg:grid" : ""}`} data-wide>
            <section aria-label="빌리는 돈" className={lane === "debt" ? "" : "hidden lg:block"}>
              <LaneHead lane="debt" title={`빌리는 돈 ${result.list.length}건`} line={`${needLabel(prof.need)} ${result.scoped}건 중 다른 지역 ${result.byRegion}건, 대상 아님 ${result.byTarget}건 제외`} />
              <CardList
                items={result.list}
                keyOf={(m2) => m2.program.id}
                empty={only !== "all" ? "이 조건에 해당하는 공고가 없습니다. '전체'를 누르면 다른 공고가 보입니다." : q ? `'${q}'에 해당하는 공고가 없습니다. 낱말을 지우거나 지원 종류를 바꿔 보세요.` : "조건에 맞는 공고가 없습니다. 지원 종류나 지역을 바꿔 보세요."}
                render={(m2) => (
                  <ProgramCard m={m2} today={today} related={related(m2.program)} save={saveProgram(m2.program)} foot={<p className="text-sm">공고문 자격 대조는 담은 뒤 심사 준비에서 합니다.</p>} />
                )}
              />
            </section>
            <section aria-label="투자받는 돈" className={lane === "equity" ? "" : "hidden lg:block"}>
              <LaneHead lane="equity" title={`투자받는 돈 ${result.gps.length}곳`} line={`'${fieldLabel(prof.field)}' 분야 모태 자펀드를 운용 중인 곳`} />
              <ExistingGroup groups={split.existing} render={(g) => <GpCard g={g} existing rivals={backers(g.gp)} save={saveGp(g.gp, true, g.funds.length, g.latestYear)} />} />
              <p className="mt-4 font-semibold">새로 찾아볼 운용사 {split.fresh.length}곳</p>
              <CardList
                items={split.fresh}
                keyOf={(g) => g.gp}
                empty={q ? `'${q}'에 해당하는 운용사나 펀드가 없습니다.` : "해당 분야 이름의 펀드가 없습니다. 관심 분야를 바꿔 보세요."}
                render={(g) => <GpCard g={g} existing={false} rivals={backers(g.gp)} save={saveGp(g.gp, false, g.funds.length, g.latestYear)} />}
              />
              {!deepDone && (
                <p className="mt-4 flex flex-wrap items-center gap-x-2 text-sm">
                  경쟁사에 투자한 운용사를 보려면 경쟁사 분석에서 비교 자료를 받으세요.
                  <Link href={`/c/${c.cid}/rivals`} className="link">
                    경쟁사 분석으로 가기
                  </Link>
                </p>
              )}
            </section>
          </div>
        </>
      )}

      {/* 판로 갈래(screens 5.2): 넓은 화면은 두 갈래 아래 화면 폭 단, 중간·좁은 화면은 판로 탭에서만.
          공고·펀드 목록을 받은 뒤에 그린다: 그 전에 그리면 넓은 화면에서 판로 단이 잠깐 첫 화면에 보였다가 아래로 밀리며
          "화면에 들어옴"으로 잡혀 사용자가 보지 않은 나라장터 조회가 나간다(F-20) */}
      {salesShown && <SalesLane region={cond.region} biz={cond.biz} filtersAbove={Boolean(result && split && prof && data)} className={`${lane === "sales" ? "mt-4" : "hidden"} lg:mt-10 lg:block`} />}

      {result && split && prof && data && (
        // 도움말(2026-11-24 UX 점검 주석15–18): 매칭에 쓴 조건(자료 출처)·표시 설명(상태 표시 안내)·용어 풀이·판단 범위를 한 구역에 모으고, 기준일·출처는 맨 아래 보조 문단
        <div className="mt-10 lg:max-w-[760px]">
          <BoardFoot meta={data.meta} memoryKey={`${c.cid}:fu`}>
            <Disclosure text="자료 출처" memoryKey={`${c.cid}:fu:from`}>
              <ConditionSources rows={conditionRows({ cond, chosen, regionSrc, merged: m ?? null })} />
            </Disclosure>
            <Disclosure text="상태 표시 안내" memoryKey={`${c.cid}:fu:marks`}>
              <TermList
                items={[
                  { key: "related", term: <span className="tag">회사 사업과 관련</span>, desc: "회사 기술 낱말이 공고 제목·요약·태그에 있습니다. 순서에만 쓰고 공고를 빼지 않습니다." },
                  { key: "existing", term: <span className="tag">이미 투자함</span>, desc: "회사의 투자기관 이름과 운용사 이름이 같습니다." },
                  {
                    key: "rival",
                    term: <span className="tag">경쟁사에 투자</span>,
                    desc: "비교 대상 경쟁사에 투자한 기록이 있습니다(경쟁사 분석의 비교 자료). 이 업종을 아는 곳이지만, 직접 경쟁사에 투자한 곳은 이해충돌로 투자를 피할 수 있습니다.",
                  },
                ]}
              />
            </Disclosure>
          </BoardFoot>
        </div>
      )}
      <SavedBar
        n={n}
        href={`/c/${c.cid}/review${goTab}`}
        detail={[savedPrograms ? `공고 ${savedPrograms}건` : "", savedGps ? `운용사 ${savedGps}곳` : ""].filter(Boolean).join(", ")}
        next="심사 준비에서 공고문 자격 대조와 운용사 요약을 합니다"
      />
    </main>
  );
}

type CondRow = { key: string; label: string; value: string; how: string; word?: Status | null; from: "user" | "data" };

type RegionSource = { kind: "edit" } | { kind: "analysis"; how: string; word: Status | null } | null;
/** 지역 조건의 출처. edit: 회사 정보 수정에서 입력, analysis: 회사 분석 결과(그때의 출처 이름과 상태), null: 직접 고름 또는 없음 */
function regionSourceOf(from: ConditionSource["region"], merged: Merged | null): RegionSource {
  if (from === "edit") return { kind: "edit" };
  if (from === "analysis" && merged?.region && merged.region.status !== "unavailable") {
    return { kind: "analysis", how: merged.region.source?.org || merged.region.source?.name || "회사 분석", word: merged.region.status };
  }
  return null;
}

/**
 * "자료 출처"의 조건 줄(2026-11-24 UX 점검 주석16): 사용자가 고른 조건과 회사 분석 결과에서 가져온 조건을 나눈다.
 * 지역은 지금 값과 최신 분석 값을 견주지 않고 regionSrc(그 조건이 실제로 어디서 왔는지)를 쓴다
 */
function conditionRows({ cond, chosen, regionSrc, merged }: { cond: Conditions; chosen: Partial<Record<keyof Conditions, true>>; regionSrc: RegionSource; merged: Merged | null }): CondRow[] {
  const region = cond.region ?? "";
  const src = chosen.region ? null : regionSrc;
  return [
    src?.kind === "analysis"
      ? { key: "region", label: "지역", value: region, how: src.how, word: src.word, from: "data" }
      : { key: "region", label: "지역", value: region, how: src?.kind === "edit" ? "회사 정보 수정에서 직접 입력" : "직접 고름", from: "user" },
    { key: "biz", label: "기업 유형", value: cond.biz ? BIZ_LABEL[cond.biz] : "", how: "직접 고름. 공공 자료에 기업 유형 근거가 없어 자동으로 채우지 않습니다", from: "user" },
    { key: "need", label: "필요한 지원", value: needLabel(cond.need), how: chosen.need ? "직접 고름" : "처음 값. 위 조건에서 바꿀 수 있습니다", from: "user" },
    chosen.field || !cond.field
      ? { key: "field", label: "관심 투자 분야", value: cond.field ? fieldLabel(cond.field) : "", how: "직접 고름", from: "user" }
      : { key: "field", label: "관심 투자 분야", value: fieldLabel(cond.field), how: "회사 분석의 사업 내용으로 고름", word: merged?.fundField?.status ?? "inferred", from: "data" },
  ];
}

function ConditionSources({ rows }: { rows: CondRow[] }) {
  const groups = [
    { title: "회사 분석 결과에서 가져온 조건", rows: rows.filter((r) => r.from === "data"), key: "data" },
    { title: "직접 고르는 조건", rows: rows.filter((r) => r.from === "user"), key: "user" },
  ].filter((g) => g.rows.length);
  return (
    <div className="space-y-3 py-2 text-sm">
      {groups.map((g) => (
        <div key={g.key} data-cond-group={g.key}>
          <p className="font-semibold">{g.title}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {g.rows.map((r) => (
              <li key={r.key} data-cond={r.key}>
                <span className="font-medium">{r.label}</span> {r.value}
                <span className="text-sub"> ({r.how})</span>
                {r.word && (
                  <>
                    {" "}
                    <StatusWord w={r.word} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * 기업 유형 고르기(2026-11-24 UX 점검 주석13·4절): 목록을 보기 전에 할 일이라 옅은 회색 상자(회사 분석 "확인이 필요한 정보"과 같은 칠)에 둔다.
 * 질문(제목과 이유) → 선택지(단추 셋) → 추정 안내, 세 단계. 고른 유형은 눌린 단추 모양(녹색 테두리·칠)과 확인 표시, 그리고 글("{유형}을 골랐습니다")로 구별한다.
 * 고른 글 줄은 늘 빈 채로 두는 role=status 라 고를 때 화면 읽기가 알린다
 */
function BizStep({ current, onPick, hint }: { current: BizTypeId | null; onPick: (b: BizTypeId) => void; hint: { id: BizTypeId; reason: string } | null }) {
  return (
    <section aria-labelledby="biz-step-h" className="mt-5 rounded-lg bg-wash p-4 sm:p-5 lg:max-w-[760px]" data-biz-step>
      <h2 id="biz-step-h" className="text-lg font-bold leading-snug">
        {current ? "기업 유형" : "목록을 보려면 먼저 기업 유형을 골라 주세요"}
      </h2>
      <p className="mt-1 text-sm">
        {current ? "공공 자료에 기업 유형 근거가 없어 직접 고른 값을 씁니다. 다른 유형을 누르면 바뀝니다." : "공공 자료에 기업 유형 근거가 없어 자동으로 채우지 않습니다. 한 번 고르면 바로 목록이 나옵니다."}
      </p>
      <div role="group" aria-labelledby="biz-step-h" className="mt-3 flex flex-wrap gap-2">
        {(Object.keys(BIZ_LABEL) as BizTypeId[]).map((b) => (
          <button key={b} type="button" className={`btn ${current === b ? "btn-pressed" : ""}`} aria-pressed={current === b} onClick={() => onPick(b)}>
            {current === b && (
              <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" className="shrink-0">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {BIZ_LABEL[b]}
          </button>
        ))}
      </div>
      {!current && hint && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-biz-hint>
          <span>{BIZ_LABEL[hint.id]}으로 보입니다</span>
          <StatusWord w="inferred" />
          <span className="text-sub">{hint.reason}</span>
        </p>
      )}
      <p role="status" className={current ? "mt-3 text-sm font-medium" : undefined}>
        {/* 고른 것만 알린다. "목록에 반영"은 보이는 갈래(좁은 화면의 판로 탭 등)에 따라 맞지 않을 수 있어 말하지 않는다(리뷰 P3) */}
        {current ? `${BIZ_LABEL[current]}을 골랐습니다.` : null}
      </p>
    </section>
  );
}

function ExistingGroup({ groups, render }: { groups: Parameters<typeof GpCard>[0]["g"][]; render: (g: Parameters<typeof GpCard>[0]["g"]) => ReactNode }) {
  const c = useCompany();
  if (!groups.length) {
    return (
      <div className="mt-4 border-t border-rule py-3">
        <p className="font-semibold">이미 투자한 운용사로 확인된 곳 없음</p>
        <p className="text-sm text-sub">투자자 이름이 영문인 자료는 운용사와 맞춰 보지 못할 수 있습니다.</p>
      </div>
    );
  }
  return (
    <div className="mt-4">
      <Disclosure text={`이미 투자한 운용사 ${groups.length}곳`} openText={`이미 투자한 운용사 ${groups.length}곳 접기`} memoryKey={`${c.cid}:fu:existing`}>
        <p className="pt-1 text-sm">새 후보가 아니라 후속 투자나 소개를 부탁할 곳입니다.</p>
        <p className="text-sm text-sub">투자자 이름이 영문인 자료는 운용사와 맞춰 보지 못할 수 있습니다.</p>
        <div className="mt-2 space-y-3" data-group="existing">
          {groups.map((g) => (
            <div key={g.gp}>{render(g)}</div>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

function CondSelect({ label, value, options, onChange, chosen, word }: {
  label: string; value: string | null; options: readonly { id: string; label: string }[]; onChange: (v: string) => void; chosen?: boolean; word?: Status | null;
}) {
  return (
    <label className={`chip relative pr-9 ${value ? "" : "border-dashed"}`}>
      <span className="text-sub">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 min-w-11 cursor-pointer appearance-none bg-transparent font-semibold outline-none [field-sizing:content]"
        aria-label={label}
      >
        {!value && <option value="">골라 주세요</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <svg aria-hidden width="16" height="16" viewBox="0 0 20 20" className="pointer-events-none absolute right-3 text-ledger">
        <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {chosen ? <span className="text-xs text-sub">직접 고름</span> : word ? <StatusWord w={word} /> : null}
    </label>
  );
}

