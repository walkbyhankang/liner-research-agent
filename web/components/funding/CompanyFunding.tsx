"use client";

// 자금 조달(screens 5절): 회사 분석 값으로 조건을 채우고 공고·운용사를 고르고 담는다. 유료 호출 없음.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { STATUS_LABEL, type BizTypeId, type Status } from "@/lib/contract";
import { bizTypes, fundFields, needs, regionOptions, type Only, type Profile, type Program, type SortMode } from "@/lib/finder";
import { initialConditions, relatedTo, rivalBackers, splitExisting, type Conditions } from "@/lib/funding";
import { isSaved, reviewCount, setEdit, toggleSaved } from "@/lib/local";
import { isTerminal } from "@/lib/view";
import { Disclosure, StatusWord } from "@/components/kit";
import { useCompany } from "@/components/company/context";
import { BizPicker } from "@/components/company/Shell";
import {
  BoardFoot, CardList, FilterPanel, GpCard, LaneHead, LaneTabs, LoadError, ProgramCard, QuickFilters, SavedBar, fieldLabel, needLabel, useBoard, usePublicData, useToday,
} from "@/components/funding/Board";

const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | null => (v && allowed.includes(v as T) ? (v as T) : null);

export function CompanyFunding() {
  const c = useCompany();
  // 회사 값과 이 브라우저 자료를 받은 뒤에 조건을 정한다. 그 뒤 회사 값이 바뀌어도 사용자가 본 조건은 자동으로 바꾸지 않는다(F-13)
  if (c.phase === "loading" || !c.local.loaded) return <main className="mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6"><h1 className="text-2xl font-semibold">자금 조달</h1></main>;
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
  const [cond0, setCond] = useState<Conditions>(() => ({
    region: oneOf(sp.get("r"), regionOptions) ?? init.cond.region,
    biz: oneOf(sp.get("b"), bizTypes.map((b) => b.id)),
    need: oneOf(sp.get("n"), needs.map((n) => n.id)) ?? "loan",
    field: oneOf(sp.get("f"), fundFields.map((f) => f.id)),
  }));
  const [chosen, setChosen] = useState<Partial<Record<keyof Conditions, true>>>(() => ({
    ...(sp.get("r") ? { region: true } : {}), ...(sp.get("b") ? { biz: true } : {}), ...(sp.get("n") ? { need: true } : {}), ...(sp.get("f") ? { field: true } : {}),
  }));
  // 기업 유형은 사용자가 고른 것(값 고치기·표시줄에서 고른 것 포함), 관심 분야는 회사 분석 값을 따라간다
  const cond: Conditions = { ...cond0, biz: cond0.biz ?? init.cond.biz, field: cond0.field ?? init.cond.field };
  const [seenRegion, setSeenRegion] = useState<string | null>(() => cond0.region);

  const [q, setQ] = useState(sp.get("q") ?? "");
  const [sort, setSort] = useState<SortMode>(oneOf(sp.get("s"), ["rec", "deadline", "new"] as const) ?? "rec");
  const [only, setOnly] = useState<Only>(oneOf(sp.get("o"), ["all", "soon", "local"] as const) ?? "all");
  const [lane, setLane] = useState<"debt" | "equity">(sp.get("lane") === "invest" ? "equity" : "debt");

  // 사용자가 바꾼 조건만 주소에 남긴다
  const urlKey = [lane, chosen.region && cond.region, chosen.biz && cond.biz, chosen.need && cond.need, chosen.field && cond.field, q.trim(), sort, only].join("|");
  useEffect(() => {
    const u = new URLSearchParams();
    if (lane === "equity") u.set("lane", "invest");
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
  const savedPrograms = c.local.saved.filter((s) => s.kind === "program").length;
  const savedGps = c.local.saved.filter((s) => s.kind === "gp").length;
  const goTab = savedPrograms === 0 && savedGps > 0 ? "?tab=invest" : "";

  const saveProgram = (p: Program) => ({
    on: isSaved(c.local, "program", p.id),
    toggle: () => toggleSaved(c.cid, { kind: "program", itemId: p.id, title: p.title, meta: { end: p.period.end, agency: p.agency, url: p.url } }),
    onText: "담음", offText: "담기", sr: `심사 준비로 담기: ${p.title}`,
  });
  const saveGp = (gp: string, existing: boolean, funds: number, year: number) => ({
    on: isSaved(c.local, "gp", gp),
    toggle: () => toggleSaved(c.cid, { kind: "gp", itemId: gp, title: gp, meta: { existing, funds, latestYear: year } }),
    onText: "담음", offText: "담기", sr: `심사 준비로 담기: ${gp}`,
  });

  const m = job?.merged;
  const regionWord = chosen.region ? null : m?.region && m.region.status !== "unavailable" && cond?.region === m.region.raw ? m.region.status : null;

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 pb-24 pt-6 sm:px-6">
      <h1 className="text-2xl font-semibold">자금 조달</h1>
      {(!job || !ready) && <p className="mt-2 text-sub">회사 값을 받는 중입니다. 조건을 직접 골라도 됩니다.</p>}

      {cond && (
        <div className="mt-4">
          <p className="text-sm font-semibold">회사 분석 값으로 채운 조건</p>
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
          <p className="mt-3 text-sm text-sub">기업마당 분류값으로 거른 목록입니다. 세부 자격은 담은 뒤 심사 준비에서 공고문으로 대조합니다.</p>
        </div>
      )}

      {cond && !cond.biz && (
        <div className="mt-5 rounded-lg border border-rule p-4">
          <p className="font-semibold">기업 유형을 골라 주세요</p>
          <p className="mt-1 text-sm text-sub">공공 자료에 기업 유형 근거가 없어 자동으로 채우지 않습니다. 한 번 고르면 바로 목록이 나옵니다.</p>
          <div className="mt-3">
            <BizPicker current={null} onPick={(b) => set("biz", b)} hint={m?.bizTypeHint ?? null} />
          </div>
        </div>
      )}
      {cond && cond.biz && (!cond.region || !cond.field) && (
        <p className="mt-5 rounded-md bg-wash p-4">지역과 관심 투자 분야를 고르면 목록이 나옵니다.</p>
      )}

      {error && <LoadError />}
      {!data && !error && prof && <p className="mt-6 text-sub">공고와 펀드 목록을 불러오는 중입니다</p>}

      {result && split && prof && data && (
        <>
          <div className="mt-4">
            <QuickFilters only={only} setOnly={(o) => setOnly(o)} counts={result.counts} region={prof.region} />
          </div>
          {/* 찾기·정렬은 목록 앞에 둔다(카드를 다 지나야 닿지 않게) */}
          <div className="mt-2">
            <FilterPanel need={prof.need} q={q} setQ={setQ} sort={sort} setSort={setSort} memoryKey={`${c.cid}:fu:filter`} />
          </div>
          <LaneTabs lane={lane} setLane={setLane} debt={result.list.length} equity={result.gps.length} />
          <div className="mt-4 grid gap-8 lg:grid-cols-2">
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
                <p className="mt-4 flex flex-wrap items-center gap-x-2 text-sm text-sub">
                  경쟁사에 투자한 운용사를 보려면 회사 분석에서 경쟁사 깊이 비교를 하세요.
                  <Link href={`/c/${c.cid}#rivals`} className="link">
                    경쟁사 단락으로 가기
                  </Link>
                </p>
              )}
            </section>
          </div>

          <div className="mt-8">
            <Disclosure text="조건은 어디서 왔나요?" memoryKey={`${c.cid}:fu:from`}>
              <ul className="space-y-1 py-2 text-sm">
                <li>
                  지역: {chosen.region ? "직접 고름" : m?.region && m.region.status !== "unavailable" ? `${m.region.source?.org || m.region.source?.name || "회사 분석"}, ${STATUS_LABEL[m.region.status]}` : "직접 고름"}
                </li>
                <li>기업 유형: {c.local.edits.bizType || chosen.biz ? "직접 고름(공공 자료에 근거 없음)" : "근거 자료 없음"}</li>
                <li>필요한 지원: 직접 고름</li>
                <li>관심 투자 분야: {chosen.field ? "직접 고름" : "회사 분석의 사업 내용으로 고름, 추정"}</li>
              </ul>
            </Disclosure>
            <Disclosure text="표시의 뜻" memoryKey={`${c.cid}:fu:marks`}>
              <ul className="space-y-1 py-2 text-sm">
                <li>회사 사업과 관련: 회사 기술 낱말이 공고 제목·요약·태그에 있습니다. 순서에만 쓰고 공고를 빼지 않습니다.</li>
                <li>이미 투자함: 회사의 투자기관 이름과 운용사 이름이 같습니다.</li>
                <li>경쟁사에 투자: 확정한 국내 경쟁사에 투자한 기록이 있습니다. 이 업종을 아는 곳이지만, 직접 경쟁사에 투자한 곳은 이해충돌로 투자를 피할 수 있습니다.</li>
              </ul>
            </Disclosure>
            <BoardFoot meta={data.meta} memoryKey={`${c.cid}:fu`} />
          </div>
        </>
      )}
      <SavedBar n={n} href={`/c/${c.cid}/review${goTab}`} />
    </main>
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

