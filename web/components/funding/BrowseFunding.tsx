"use client";

// 회사 없이 자금 둘러보기(/funding, screens 5.1). 펀딩노트의 문장형 조건과 저장·공유 방식을 그대로 쓰고,
// 유료 기능(공고문 자격 대조, 운용사 요약, 우리 회사 정보 입력)은 두지 않는다(F0-03). 저장은 localStorage fundingnote.* 그대로.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { bizTypes, fundFields, matchProgram, needs, regionOptions, type GpGroup, type Only, type Profile, type SortMode } from "@/lib/finder";
import { BoardFoot, CardList, FilterPanel, GpCard, LaneHead, LaneTabs, LoadError, ProgramCard, QuickFilters, fieldLabel, needLabel, useBoard, usePublicData, useToday } from "@/components/funding/Board";
import { SiteHeader } from "@/components/SiteHeader";

type Saved = { programs: string[]; gps: string[] };
const DEFAULT: Profile = { region: "서울", biz: "venture", need: "loan", field: "ai" };
const PROFILE_KEY = "fundingnote.profile.v1";
const SAVED_KEY = "fundingnote.saved.v1";
const oneOf = <T extends string>(v: string | null | undefined, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

function readInitial() {
  const sp = new URLSearchParams(window.location.search);
  let stored: Partial<Profile> = {};
  let saved: Saved = { programs: [], gps: [] };
  try {
    stored = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "{}") ?? {};
    const s = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "{}") ?? {};
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    saved = { programs: strings(s.programs), gps: strings(s.gps) };
  } catch {
    // 저장소를 쓸 수 없거나 값이 깨져 있으면 기본값으로 시작한다
  }
  return {
    prof: {
      region: oneOf(sp.get("r") ?? stored.region, regionOptions, DEFAULT.region),
      biz: oneOf(sp.get("b") ?? stored.biz, bizTypes.map((b) => b.id), DEFAULT.biz),
      need: oneOf(sp.get("n") ?? stored.need, needs.map((n) => n.id), DEFAULT.need),
      field: oneOf(sp.get("f") ?? stored.field, fundFields.map((f) => f.id), DEFAULT.field),
    } as Profile,
    saved,
    q: sp.get("q") ?? "",
    sort: oneOf<SortMode>(sp.get("s"), ["rec", "deadline", "new"], "rec"),
    only: oneOf<Only>(sp.get("o"), ["all", "soon", "local"], "all"),
    lane: sp.get("lane") === "invest" ? ("equity" as const) : ("debt" as const),
  };
}

function Pick({ label, value, options, onChange }: { label: string; value: string; options: readonly { id: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="pick mx-1 my-1 min-h-11 cursor-pointer appearance-none rounded-none border-b-2 border-ledger bg-ledger-soft pl-2 font-semibold text-ledger outline-none [field-sizing:content]"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const noRelated = () => false;

export function BrowseFunding() {
  const { data, error } = usePublicData();
  const today = useToday();
  const [prof, setProf] = useState<Profile | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortMode>("rec");
  const [only, setOnly] = useState<Only>("all");
  const [lane, setLane] = useState<"debt" | "equity">("debt");
  const [saved, setSaved] = useState<Saved>({ programs: [], gps: [] });
  const [copied, setCopied] = useState(false);

  // 주소·브라우저 저장소는 브라우저에서만 읽을 수 있어 화면이 붙은 뒤 한 번 읽는다
  useEffect(() => {
    const init = readInitial();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProf(init.prof);
    setSaved(init.saved);
    setQ(init.q);
    setSort(init.sort);
    setOnly(init.only);
    setLane(init.lane);
  }, []);

  // 조건을 주소와 브라우저에 남겨, 링크로 공유하거나 다시 열었을 때 이어서 볼 수 있게 한다
  useEffect(() => {
    if (!prof) return;
    const sp = new URLSearchParams({ r: prof.region, b: prof.biz, n: prof.need, f: prof.field });
    if (q.trim()) sp.set("q", q.trim());
    if (sort !== "rec") sp.set("s", sort);
    if (only !== "all") sp.set("o", only);
    if (lane === "equity") sp.set("lane", "invest");
    window.history.replaceState(null, "", `/funding?${sp.toString()}`);
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(prof));
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    } catch {
      // 저장하지 못해도 화면은 그대로 동작한다
    }
  }, [prof, q, sort, only, saved, lane]);

  const result = useBoard(data, prof, today, q, sort, only, noRelated);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => {
    setProf((p) => (p ? { ...p, [k]: v } : p));
    if (k === "need") setQ("");
  };
  const toggle = useCallback((kind: keyof Saved, id: string) => setSaved((s) => ({ ...s, [kind]: s[kind].includes(id) ? s[kind].filter((x) => x !== id) : [...s[kind], id] })), []);

  const savedLists = useMemo(() => {
    if (!result || !prof) return null;
    const programs = result.live.filter((p) => saved.programs.includes(p.id)).map((p) => matchProgram(p, prof));
    const byGp = new Map<string, GpGroup["funds"]>();
    for (const f of result.funds) if (saved.gps.includes(f.gp)) byGp.set(f.gp, [...(byGp.get(f.gp) ?? []), f]);
    const gps: GpGroup[] = [...byGp.entries()].map(([gp, funds]) => {
      const sorted = [...funds].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      return { gp, funds: sorted, latestYear: sorted[0].year ?? 0 };
    });
    return { programs, gps };
  }, [result, prof, saved]);

  const copy = async () => {
    if (!savedLists || !data || !prof) return;
    const bizLabel = bizTypes.find((b) => b.id === prof.biz)?.label ?? "";
    const lines = [
      `[성장노트] 저장한 자금 후보 (${today} 조회, 데이터 기준일 ${data.meta.asOf})`,
      `조건: ${prof.region}, ${bizLabel}`,
      "",
      "[정책자금·지원사업]",
      ...savedLists.programs.flatMap((m, i) => [
        `${i + 1}. ${m.program.title}`,
        `   신청기간: ${m.program.period.end ? `${m.program.period.end} 마감` : m.program.period.raw || "미기재"}`,
        ...(m.checks.length ? [`   확인할 점: ${m.checks.join(" / ")}`] : []),
        `   원문: ${m.program.url}`,
      ]),
      "",
      "[투자 운용사]",
      ...savedLists.gps.map((g, i) => `${i + 1}. ${g.gp}: ${g.funds.slice(0, 2).map((f) => `${f.name}(${f.field}, ${f.year}년 결성)`).join(", ")}`),
      "",
      "공공 API의 분류값으로 거른 목록입니다. 세부 자격과 접수 여부는 공고문과 운용사에 확인하세요.",
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const savedCount = saved.programs.length + saved.gps.length;
  const saveSpec = (kind: keyof Saved, id: string, title: string) => ({
    on: saved[kind].includes(id), toggle: () => toggle(kind, id), onText: "저장함", offText: "저장", sr: `저장: ${title}`,
  });

  return (
    <>
      <SiteHeader
        right={
          <Link href="/" className="link">
            회사 분석 시작
          </Link>
        }
      />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-16 pt-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-edge px-4 py-3">
          <p>회사 이름을 넣으면 조건을 채우고, 공고문 자격 대조까지 이어집니다.</p>
          <Link href="/" className="btn btn-primary">
            회사 분석 시작
          </Link>
        </div>
        <h1 className="mt-6 text-2xl font-semibold">자금 둘러보기</h1>
        {prof && (
          <p className="mt-3 max-w-[760px] text-lg leading-loose sm:text-xl">
            <Pick label="지역" value={prof.region} options={regionOptions.map((r) => ({ id: r, label: r }))} onChange={(v) => set("region", v)} />
            에 있는
            <Pick label="기업 유형" value={prof.biz} options={bizTypes} onChange={(v) => set("biz", v as Profile["biz"])} />
            입니다. <Pick label="필요한 지원" value={prof.need} options={needs} onChange={(v) => set("need", v as Profile["need"])} />을 찾고, 투자는
            <Pick label="관심 투자 분야" value={prof.field} options={fundFields} onChange={(v) => set("field", v as Profile["field"])} />
            분야를 봅니다.
          </p>
        )}
        <p className="mt-2 text-sm">기업마당 분류값으로 거른 목록입니다. 세부 자격은 공고문에서 확인하세요.</p>

        {error && <LoadError />}
        {!data && !error && <p className="mt-6 text-sub">공고와 펀드 목록을 불러오는 중입니다</p>}

        {result && prof && data && savedLists && (
          <>
            <div className="mt-4">
              <QuickFilters only={only} setOnly={setOnly} counts={result.counts} region={prof.region} />
            </div>
            {/* 찾기·정렬은 목록 앞에 둔다(카드를 다 지나야 닿지 않게) */}
            <div className="mt-2">
              <FilterPanel need={prof.need} q={q} setQ={setQ} sort={sort} setSort={setSort} memoryKey="browse:filter" />
            </div>
            <LaneTabs lane={lane} setLane={(l) => l !== "sales" && setLane(l)} debt={result.list.length} equity={result.gps.length} withSales={false} />
            <div className="mt-4 grid gap-8 lg:grid-cols-2">
              <section aria-label="빌리는 돈" className={lane === "debt" ? "" : "hidden lg:block"}>
                <LaneHead lane="debt" title={`빌리는 돈 ${result.list.length}건`} line={`${needLabel(prof.need)} ${result.scoped}건 중 다른 지역 ${result.byRegion}건, 대상 아님 ${result.byTarget}건 제외`} />
                <CardList
                  items={result.list}
                  keyOf={(m) => m.program.id}
                  empty="조건에 맞는 공고가 없습니다. 지원 종류나 지역을 바꿔 보세요."
                  render={(m) => <ProgramCard m={m} today={today} related={false} save={saveSpec("programs", m.program.id, m.program.title)} />}
                />
              </section>
              <section aria-label="투자받는 돈" className={lane === "equity" ? "" : "hidden lg:block"}>
                <LaneHead lane="equity" title={`투자받는 돈 ${result.gps.length}곳`} line={`'${fieldLabel(prof.field)}' 분야 모태 자펀드를 운용 중인 곳`} />
                <CardList
                  items={result.gps}
                  keyOf={(g) => g.gp}
                  empty="해당 분야 이름의 펀드가 없습니다. 관심 분야를 바꿔 보세요."
                  render={(g) => <GpCard g={g} existing={false} rivals={[]} save={saveSpec("gps", g.gp, g.gp)} showBadges={false} />}
                />
              </section>
            </div>

            <section className="mt-10 border-t border-rule pt-6" aria-labelledby="saved-h">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="saved-h" className="text-lg font-bold">
                  저장한 항목 {savedCount}건
                </h2>
                {savedCount > 0 && (
                  <button type="button" className="btn btn-primary" onClick={() => void copy()}>
                    {copied ? "복사했습니다" : "목록 복사해서 공유"}
                  </button>
                )}
              </div>
              {savedCount === 0 ? (
                <p className="mt-3 text-sm">카드의 &lsquo;저장&rsquo;을 누르면 여기에 모이고, 목록을 복사해 팀에 공유할 수 있습니다.</p>
              ) : (
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {savedLists.programs.map((m) => (
                    <ProgramCard key={m.program.id} m={m} today={today} related={false} save={saveSpec("programs", m.program.id, m.program.title)} />
                  ))}
                  {savedLists.gps.map((g) => (
                    <GpCard key={g.gp} g={g} existing={false} rivals={[]} save={saveSpec("gps", g.gp, g.gp)} showBadges={false} />
                  ))}
                </div>
              )}
            </section>

            <div className="mt-6">
              <BoardFoot meta={data.meta} memoryKey="browse" />
            </div>
          </>
        )}
      </main>
    </>
  );
}
