"use client";

import { useEffect, useMemo, useState } from "react";
import {
  SOON_DAYS, bizTypes, dday, fundAlive, fundFields, glossary, groupFunds, inNeed, isExistingInvestor, isSoon, splitInvestors, matchProgram, needChips, needs, notExpired, programHaystack, withStatus,
  regionOptions, shortDate, sorter,
  type Fund, type GpGroup, type Meta, type Only, type Profile, type Program, type ProgramMatch, type SortMode,
} from "@/lib/finder";
import { CompanyForm } from "@/components/CompanyForm";
import { GpBrief } from "@/components/GpBrief";
import { NoticeCheck } from "@/components/NoticeCheck";
import { useLookup } from "@/lib/company";
import { Card, Tag } from "@/components/ui";

type Data = { programs: Program[]; funds: Fund[]; meta: Meta };
type Saved = { programs: string[]; gps: string[] };
type View = "programs" | "gps" | "saved";

const PAGE = 10;
const DEFAULT: Profile = { region: "대전", biz: "venture", need: "loan", field: "ai" };
const PROFILE_KEY = "fundingnote.profile.v1";
const SAVED_KEY = "fundingnote.saved.v1";

const oneOf = <T extends string>(v: string | null | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** 주소 → 저장된 조건 → 기본값 순으로 처음 조건을 정한다. */
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
  const prof: Profile = {
    region: oneOf(sp.get("r") ?? stored.region, regionOptions, DEFAULT.region),
    biz: oneOf(sp.get("b") ?? stored.biz, bizTypes.map((b) => b.id), DEFAULT.biz),
    need: oneOf(sp.get("n") ?? stored.need, needs.map((n) => n.id), DEFAULT.need),
    field: oneOf(sp.get("f") ?? stored.field, fundFields.map((f) => f.id), DEFAULT.field),
  };
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    prof,
    saved,
    today,
    q: sp.get("q") ?? "",
    sort: oneOf<SortMode>(sp.get("s"), ["rec", "deadline", "new"], "rec"),
    only: oneOf<Only>(sp.get("o"), ["all", "soon", "local"], "all"),
  };
}

function Pick({ label, value, options, onChange }: { label: string; value: string; options: readonly { id: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mx-1 my-0.5 min-h-10 cursor-pointer appearance-none rounded-md [field-sizing:content] border-b-2 border-accent bg-accent-soft px-2 font-bold text-accent outline-none focus:ring-2 focus:ring-accent/40"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Finder() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [prof, setProf] = useState<Profile>(DEFAULT);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortMode>("rec");
  const [only, setOnly] = useState<Only>("all");
  const [today, setToday] = useState("");
  const [saved, setSaved] = useState<Saved>({ programs: [], gps: [] });
  const [view, setView] = useState<View>("programs");
  const [shown, setShown] = useState({ programs: PAGE, gps: PAGE });
  const [copied, setCopied] = useState(false);
  const found = useLookup();
  // 확인되거나 보도된 투자자만 기존 투자자로 본다. 추정이나 출처가 엇갈리는 기록으로 '이미 투자한 곳'이라고 표시하지 않는다
  const investorNames = useMemo(() => splitInvestors(found?.investors ?? []).established.map((i) => i.name), [found]);
  // 경쟁사에 투자한 곳: 이 업종을 아는 운용사라는 정보로만 보여주고 순서는 바꾸지 않는다
  const rivalBackers = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of found?.rivalFunding ?? []) for (const inv of r.investors) map.set(inv, [...new Set([...(map.get(inv) ?? []), r.company])]);
    return map;
  }, [found]);
  const backedRivals = (gp: string) => [...rivalBackers.entries()].filter(([inv]) => isExistingInvestor(gp, [inv])).flatMap(([, companies]) => companies);

  useEffect(() => {
    let alive = true;
    Promise.all(["programs", "funds", "meta"].map((n) => fetch(`/data/${n}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(n))))))
      .then(([programs, funds, meta]) => {
        if (!alive) return;
        const init = readInitial();
        setProf(init.prof);
        setQ(init.q);
        setSort(init.sort);
        setOnly(init.only);
        setSaved(init.saved);
        setToday(init.today);
        setData({ programs, funds, meta });
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  // 조건을 주소와 브라우저에 남겨, 링크로 공유하거나 다시 열었을 때 이어서 볼 수 있게 한다
  useEffect(() => {
    if (!data) return;
    const sp = new URLSearchParams({ r: prof.region, b: prof.biz, n: prof.need, f: prof.field });
    if (q.trim()) sp.set("q", q.trim());
    if (sort !== "rec") sp.set("s", sort);
    if (only !== "all") sp.set("o", only);
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(prof));
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    } catch {
      // 저장하지 못해도 화면은 그대로 동작한다
    }
  }, [data, prof, q, sort, only, saved]);

  const resetPaging = () => setShown({ programs: PAGE, gps: PAGE });
  const setField = <K extends keyof Profile>(k: K, v: Profile[K]) => {
    setProf((p) => ({ ...p, [k]: v }));
    if (k === "need") setQ("");
    resetPaging();
  };
  const changeQuery = (v: string) => {
    setQ(v);
    resetPaging();
  };
  const toggleSave = (kind: keyof Saved, id: string) =>
    setSaved((s) => ({ ...s, [kind]: s[kind].includes(id) ? s[kind].filter((x) => x !== id) : [...s[kind], id] }));

  const result = useMemo(() => {
    if (!data || !today) return null;
    const query = q.trim();
    const funds = data.funds.filter((f) => fundAlive(f, today));
    const live = data.programs.filter((p) => notExpired(p, today)).map((p) => withStatus(p, today));
    const scoped = live.filter((p) => inNeed(p, prof.need) && (!query || programHaystack(p).includes(query)));
    const matches = scoped.map((p) => matchProgram(p, prof));
    const ok = matches.filter((m) => m.ok);
    const soon = ok.filter((m) => isSoon(m.program, today));
    const local = ok.filter((m) => m.local);
    const list = (only === "soon" ? soon : only === "local" ? local : ok).slice().sort(sorter(only === "soon" && sort === "rec" ? "deadline" : sort));
    // 저장한 항목은 지금 조건과 상관없이 보여준다
    const savedPrograms = live.filter((p) => saved.programs.includes(p.id)).map((p) => matchProgram(p, prof));
    const byGp = new Map<string, Fund[]>();
    for (const f of funds) if (saved.gps.includes(f.gp)) byGp.set(f.gp, [...(byGp.get(f.gp) ?? []), f]);
    const savedGps: GpGroup[] = [...byGp.entries()].map(([gp, funds]) => {
      const sorted = [...funds].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      return { gp, funds: sorted, latestYear: sorted[0].year ?? 0 };
    });
    return {
      scoped: scoped.length,
      list,
      counts: { all: ok.length, soon: soon.length, local: local.length },
      byRegion: matches.filter((m) => m.excluded === "지역").length,
      byTarget: matches.filter((m) => m.excluded === "대상").length,
      // 자주 찾는 낱말은 공고용이라 운용사 목록에는 적용하지 않는다. 직접 입력한 낱말만 양쪽에 적용한다
      gps: groupFunds(funds, prof.field, needChips[prof.need].includes(query) ? "" : query),
      savedPrograms,
      savedGps,
    };
  }, [data, today, prof, q, sort, only, saved]);

  const needLabel = needs.find((n) => n.id === prof.need)?.label ?? "";
  const fieldLabel = fundFields.find((f) => f.id === prof.field)?.label ?? "";
  const bizLabel = bizTypes.find((b) => b.id === prof.biz)?.label ?? "";
  const savedCount = result ? result.savedPrograms.length + result.savedGps.length : 0;

  const copySaved = async () => {
    if (!result || !data) return;
    const lines = [
      `[펀딩노트] 저장한 자금 후보 (${today} 조회, 데이터 기준일 ${data.meta.asOf})`,
      `조건: ${prof.region} · ${bizLabel}`,
      "",
      "■ 정책자금·지원사업",
      ...result.savedPrograms.flatMap((m, i) => [
        `${i + 1}. ${m.program.title}`,
        `   신청기간: ${deadlineText(m.program, today)}`,
        ...(m.program.points[1] ? [`   내용: ${m.program.points[1]}`] : []),
        ...(m.ok ? [] : [`   주의: 지금 조건(${prof.region} · ${bizLabel})에서는 ${m.excluded === "지역" ? "다른 지역 공고" : "지원대상이 다른 공고"}로 분류됨`]),
        ...(m.checks.length ? [`   확인할 점: ${m.checks.join(" / ")}`] : []),
        `   원문: ${m.program.url}`,
      ]),
      "",
      "■ 투자 운용사",
      ...result.savedGps.map((g, i) => `${i + 1}. ${g.gp} — ${g.funds.slice(0, 2).map((f) => `${f.name}(${f.field}, ${f.year}년 결성)`).join(", ")}`),
      "",
      "※ 공공 API의 분류값으로 거른 목록입니다. 세부 자격과 접수 여부는 공고문과 운용사에 확인하세요.",
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const quick: { id: Only; label: string; n: number }[] = result
    ? [
        { id: "all", label: "전체", n: result.counts.all },
        { id: "soon", label: `마감 임박(${SOON_DAYS}일 내)`, n: result.counts.soon },
        { id: "local", label: `${prof.region} 공고`, n: result.counts.local },
      ]
    : [];

  return (
    <div>
      <Card className="p-4 sm:p-5">
        <p className="text-base leading-relaxed sm:text-xl">
          <Pick label="지역" value={prof.region} options={regionOptions.map((r) => ({ id: r, label: r }))} onChange={(v) => setField("region", v)} />
          에 있는
          <Pick label="기업 유형" value={prof.biz} options={bizTypes} onChange={(v) => setField("biz", v as Profile["biz"])} />
          입니다.{" "}
          <span className="whitespace-nowrap">
            <Pick label="필요한 지원" value={prof.need} options={needs} onChange={(v) => setField("need", v as Profile["need"])} />을 찾고,
          </span>{" "}
          <span className="whitespace-nowrap">
            투자는
            <Pick label="관심 투자 분야" value={prof.field} options={fundFields} onChange={(v) => setField("field", v as Profile["field"])} />
          </span>
          분야를 봅니다.
        </p>
        <CompanyForm />

        {result && (
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="빠른 필터">
                {quick.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setOnly(c.id);
                      setView("programs");
                      resetPaging();
                    }}
                    aria-pressed={only === c.id}
                    className={`min-h-10 whitespace-nowrap rounded-full border px-3 text-sm font-semibold ${
                      only === c.id ? "border-ink bg-ink text-white" : "border-line bg-card text-ink hover:border-ink/40"
                    }`}
                  >
                    {c.label} <span className={only === c.id ? "text-white/80" : "text-muted"}>{c.n}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setView(view === "saved" ? "programs" : "saved")}
                aria-pressed={view === "saved"}
                className={`ml-auto hidden min-h-10 rounded-full border px-3 text-sm font-semibold lg:inline-flex lg:items-center ${
                  view === "saved" ? "border-accent bg-accent text-white" : "border-line bg-card hover:border-ink/40"
                }`}
              >
                ★ 저장한 항목 {savedCount}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex max-w-full gap-1.5 overflow-x-auto" role="group" aria-label="자주 찾는 낱말">
                {needChips[prof.need].map((k) => (
                  <button
                    key={k}
                    onClick={() => changeQuery(q === k ? "" : k)}
                    aria-pressed={q === k}
                    className={`min-h-10 whitespace-nowrap rounded-full border px-3 text-sm ${
                      q === k ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-paper text-muted hover:text-ink"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <input
                value={q}
                onChange={(e) => changeQuery(e.target.value)}
                aria-label="결과 안에서 찾기"
                placeholder="결과 안에서 찾기"
                className="min-h-10 min-w-32 flex-1 rounded-lg border border-line bg-paper px-3 text-sm outline-none focus:border-ink/50"
              />
              <select
                aria-label="정렬"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortMode)}
                className="min-h-10 rounded-lg border border-line bg-card px-2 text-sm outline-none focus:border-ink/50"
              >
                <option value="rec">우리 지역·마감순</option>
                <option value="deadline">마감 임박순</option>
                <option value="new">최신 등록순</option>
              </select>
            </div>
          </div>
        )}
      </Card>

      {error && <Card className="mt-4 p-6 text-sm text-warn">데이터를 불러오지 못했습니다. `python3 scripts/fetch_public_data.py`로 스냅샷을 만든 뒤 다시 열어 주세요.</Card>}
      {!data && !error && <Card className="mt-4 p-6 text-sm text-muted">공고와 펀드 목록을 불러오는 중입니다…</Card>}

      {result && data && (
        <>
          <div className="sticky top-14 z-10 -mx-4 mt-3 flex border-b border-line bg-paper px-4 lg:hidden" role="tablist">
            {(
              [
                { id: "programs", label: "정책자금", n: result.list.length },
                { id: "gps", label: "투자 운용사", n: result.gps.length },
                { id: "saved", label: "★ 저장", n: savedCount },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={view === t.id}
                onClick={() => setView(t.id)}
                className={`-mb-px min-h-11 flex-1 border-b-2 text-sm font-semibold ${view === t.id ? "border-ink text-ink" : "border-transparent text-muted"}`}
              >
                {t.label} {t.n}
              </button>
            ))}
          </div>

          {/* 두 보기를 모두 화면에 둔 채 하나만 보이게 한다. 떼어 내면 카드 안의 진행 중인 대조·요약과 받은 결과가 사라진다 */}
          <section className={view === "saved" ? "mt-4" : "hidden"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold">저장한 항목 {savedCount}건</h2>
                {savedCount > 0 && (
                  <button onClick={copySaved} className="min-h-10 rounded-lg bg-ink px-4 text-sm font-semibold text-white">
                    {copied ? "복사됨 ✓" : "목록 복사해서 공유"}
                  </button>
                )}
              </div>
              {savedCount === 0 ? (
                <Empty text="아직 저장한 항목이 없습니다. 카드의 ‘저장’을 누르면 여기에 모이고, 목록을 복사해 팀에 공유할 수 있습니다." />
              ) : (
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {result.savedPrograms.map((m) => (
                    <ProgramCard key={m.program.id} m={m} today={today} region={prof.region} biz={prof.biz} saved onSave={() => toggleSave("programs", m.program.id)} />
                  ))}
                  {result.savedGps.map((g) => (
                    <GpCard key={g.gp} g={g} region={prof.region} biz={prof.biz} existing={isExistingInvestor(g.gp, investorNames)} rivals={backedRivals(g.gp)} saved onSave={() => toggleSave("gps", g.gp)} />
                  ))}
                </div>
              )}
            </section>
            <div className={view === "saved" ? "hidden" : "mt-4 grid gap-6 lg:grid-cols-2"}>
              <section className={view === "programs" ? "" : "hidden lg:block"} aria-label="정책자금·지원사업">
                <div className="rounded-t-xl bg-debt-soft px-4 py-1.5 lg:py-2.5">
                  <h2 className="hidden font-bold text-debt lg:block">
                    정책자금·지원사업 <span className="text-sm">{result.list.length}건</span>
                  </h2>
                  <p className="text-xs text-muted">
                    {needLabel} {result.scoped}건 중 · 다른 지역 {result.byRegion}건, 대상 아님 {result.byTarget}건 제외
                  </p>
                </div>
                <div className="h-1 bg-debt" />
                <div className="mt-3 space-y-3">
                  {result.list.slice(0, shown.programs).map((m) => (
                    <ProgramCard
                      key={m.program.id}
                      m={m}
                      today={today}
                      region={prof.region}
                      biz={prof.biz}
                      saved={saved.programs.includes(m.program.id)}
                      onSave={() => toggleSave("programs", m.program.id)}
                    />
                  ))}
                  {result.list.length === 0 && (
                    <Empty
                      text={
                        only !== "all"
                          ? "이 조건에 해당하는 공고가 없습니다. ‘전체’를 누르면 다른 공고가 보입니다."
                          : q
                            ? `‘${q}’에 해당하는 공고가 없습니다. 낱말을 지우거나 지원 종류를 바꿔 보세요.`
                            : "조건에 맞는 공고가 없습니다. 지원 종류나 지역을 바꿔 보세요."
                      }
                    />
                  )}
                  {result.list.length > shown.programs && (
                    <More onClick={() => setShown((s) => ({ ...s, programs: s.programs + PAGE }))} rest={result.list.length - shown.programs} />
                  )}
                </div>
              </section>

              <section className={view === "gps" ? "" : "hidden lg:block"} aria-label="투자 운용사">
                <div className="rounded-t-xl bg-equity-soft px-4 py-1.5 lg:py-2.5">
                  <h2 className="hidden font-bold text-equity lg:block">
                    투자 운용사 <span className="text-sm">{result.gps.length}곳</span>
                  </h2>
                  <p className="text-xs text-muted">‘{fieldLabel}’ 분야 모태 자펀드를 운용 중인 곳 · 투자 집행 여부와 금액은 운용사에 확인</p>
                </div>
                <div className="h-1 bg-equity" />
                <div className="mt-3 space-y-3">
                  {[...result.gps.filter((g) => isExistingInvestor(g.gp, investorNames)), ...result.gps.filter((g) => !isExistingInvestor(g.gp, investorNames))]
                    .slice(0, shown.gps)
                    .map((g) => (
                      <GpCard key={g.gp} g={g} region={prof.region} biz={prof.biz} existing={isExistingInvestor(g.gp, investorNames)} rivals={backedRivals(g.gp)} saved={saved.gps.includes(g.gp)} onSave={() => toggleSave("gps", g.gp)} />
                    ))}
                  {result.gps.length === 0 && <Empty text={q ? `‘${q}’에 해당하는 운용사나 펀드가 없습니다.` : "해당 분야 이름의 펀드가 없습니다. 관심 분야를 바꿔 보세요."} />}
                  {result.gps.length > shown.gps && <More onClick={() => setShown((s) => ({ ...s, gps: s.gps + PAGE }))} rest={result.gps.length - shown.gps} />}
                </div>
              </section>
            </div>

          <div className="mt-6 space-y-3 text-sm text-muted">
            <p className="text-xs">
              데이터 기준일 {data.meta.asOf} · 출처 기업마당 지원사업정보(접수 가능 {data.meta.programs.total.toLocaleString()}건), 한국벤처투자 펀드현황(만기 전 모태 자펀드{" "}
              {data.meta.funds.listed.toLocaleString()}개, {data.meta.funds.latestYear}년 결성분까지)
            </p>
            <details className="rounded-xl border border-line bg-card px-4 py-1">
              <summary className="flex min-h-10 cursor-pointer items-center font-semibold text-ink">용어 풀이</summary>
              <dl className="mb-3 mt-1 space-y-2">
                {glossary.map((g) => (
                  <div key={g.term}>
                    <dt className="inline font-semibold text-ink">{g.term}</dt> <dd className="inline">{g.desc}</dd>
                  </div>
                ))}
              </dl>
            </details>
            <details className="rounded-xl border border-dashed border-line bg-card px-4 py-1">
              <summary className="flex min-h-10 cursor-pointer items-center font-semibold text-ink">이 목록이 판단하는 것과 하지 않는 것</summary>
              <ul className="mb-3 mt-1 list-disc space-y-1 pl-4">
                <li>공고는 기업마당이 분류한 지역·지원대상·지원분야로만 걸렀습니다. 업력, 업종, 매출 같은 세부 자격은 공고문에 있고 아직 대조하지 않습니다.</li>
                <li>펀드는 한국모태펀드가 출자한 자펀드만 있습니다. 출자 분야 이름으로 분류했으며 투자 대상의 정확한 정의는 운용사와 출자 공고에서 확인해야 합니다.</li>
                <li>점수나 선정 확률은 계산하지 않습니다.</li>
              </ul>
            </details>
          </div>
        </>
      )}
    </div>
  );
}

function deadlineText(p: Program, today: string) {
  const pd = p.period;
  if (pd.status === "접수 중") {
    const d = dday(pd.end, today);
    return `${pd.end} 마감${d === null ? "" : d === 0 ? " (오늘 마감)" : ` (D-${d})`}`;
  }
  if (pd.status === "접수 예정") return `${pd.start}부터 접수`;
  return pd.raw || "미기재";
}

function Deadline({ p, today }: { p: Program; today: string }) {
  const pd = p.period;
  const base = "shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold";
  if (pd.status === "접수 중") {
    const d = dday(pd.end, today) ?? 0;
    return (
      <span className={`${base} ${d <= 7 ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent"}`}>
        {d === 0 ? "오늘 마감" : `D-${d}`} · {shortDate(pd.end)} 마감
      </span>
    );
  }
  if (pd.status === "접수 예정") return <span className={`${base} bg-equity-soft text-equity`}>{shortDate(pd.start)} 접수 시작</span>;
  return <span className={`${base} bg-line/70 text-muted`}>{pd.raw || "신청기간 미기재"}</span>;
}

const actionBtn = "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg px-2.5 text-sm font-semibold";

function ProgramCard({ m, today, region, biz, saved, onSave }: { m: ProgramMatch; today: string; region: string; biz: string; saved: boolean; onSave: () => void }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const p = m.program;
  const benefit = p.points[1] ?? p.points[0] ?? p.intro;
  return (
    <Card className={`p-4 ${saved ? "ring-2 ring-accent" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag>{p.sub || p.category}</Tag>
        <Tag className={m.local ? "border-accent/40 font-semibold text-accent" : ""}>{m.local && p.regions.includes("전국") ? p.agencyRegion : p.regions.join("·")}</Tag>
        {!m.ok && <Tag className="border-warn/40 text-warn">{m.excluded === "지역" ? "지금 조건과 다른 지역" : "지금 조건과 다른 대상"}</Tag>}
        <span className="ml-auto">
          <Deadline p={p} today={today} />
        </span>
      </div>
      <h3 className="mt-1 font-bold leading-snug">
        <a href={p.url} target="_blank" rel="noreferrer" className="flex min-h-10 items-center hover:underline">
          <span className="line-clamp-2">{p.title}</span>
        </a>
      </h3>
      {benefit && <p className="line-clamp-2 text-sm">{benefit}</p>}
      <p className="mt-1 truncate text-xs text-muted">
        {p.agency}
        {p.operator && p.operator !== p.agency ? ` · ${p.operator}` : ""}
      </p>
      <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
        <button
          onClick={() => {
            setOpen((o) => !o);
            setEverOpened(true);
          }}
          aria-expanded={open}
          className={`${actionBtn} text-ink hover:bg-paper`}
        >
          {open ? "접기 ▴" : "자세히 ▾"}
          {!open && m.checks.length > 0 && <span className="ml-1.5 rounded-full bg-debt-soft px-1.5 text-xs text-debt">확인 {m.checks.length}</span>}
        </button>
        <button onClick={onSave} aria-pressed={saved} className={`${actionBtn} ml-auto ${saved ? "bg-accent text-white" : "border border-line hover:border-ink/40"}`}>
          {saved ? "★ 저장됨" : "☆ 저장"}
        </button>
        <a href={p.url} target="_blank" rel="noreferrer" className={`${actionBtn} bg-ink text-white`}>
          공고 원문 ↗
        </a>
      </div>
      {/* 한 번 펼친 뒤에는 접어도 화면에서 숨기기만 한다. 떼어 내면 진행 중인 대조나 받은 결과가 사라져 유료 호출을 다시 해야 한다 */}
      {everOpened && (
        <div className={open ? "mt-2 space-y-3 rounded-lg bg-paper p-3 text-sm" : "hidden"}>
          <NoticeCheck programId={p.id} region={region} biz={biz} />
          {p.points[0] && (
            <p>
              <span className="mr-1.5 text-xs font-semibold text-muted">대상</span>
              {p.points[0]}
            </p>
          )}
          <div className="space-y-1">
            {m.reasons.map((r) => (
              <p key={r} className="flex gap-1.5">
                <span className="text-accent">✓</span>
                <span>{r}</span>
              </p>
            ))}
            {m.checks.map((r) => (
              <p key={r} className="flex gap-1.5">
                <span className="text-debt">?</span>
                <span>{r}</span>
              </p>
            ))}
          </div>
          {(p.docUrl || p.applyUrl) && (
            <div className="flex flex-wrap items-center gap-1">
              {p.docUrl && (
                <a href={p.docUrl} target="_blank" rel="noreferrer" className={`${actionBtn} border border-line bg-card text-accent`}>
                  공고문 파일 ↗
                </a>
              )}
              {p.applyUrl && (
                <a href={p.applyUrl} target="_blank" rel="noreferrer" className={`${actionBtn} border border-line bg-card text-accent`}>
                  신청 페이지 ↗
                </a>
              )}
            </div>
          )}
          {p.contact && <p className="text-xs text-muted">문의 {p.contact}</p>}
          <p className="text-xs text-muted">등록 {p.created} · 출처 기업마당</p>
        </div>
      )}
    </Card>
  );
}

function GpCard({ g, region, biz, existing, rivals, saved, onSave }: { g: GpGroup; region: string; biz: string; existing: boolean; rivals: string[]; saved: boolean; onSave: () => void }) {
  const [open, setOpen] = useState(false);
  const first = g.funds[0];
  return (
    <Card className={`p-4 ${saved ? "ring-2 ring-accent" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag>운용사</Tag>
        {existing && <Tag className="border-equity/40 font-semibold text-equity">기존 투자자</Tag>}
        {rivals.length > 0 && <Tag className="border-debt/40 font-semibold text-debt">경쟁사 투자 이력</Tag>}
        <Tag>펀드 {g.funds.length}개</Tag>
        <span className="ml-auto shrink-0 rounded-full bg-equity-soft px-2 py-0.5 text-xs font-semibold text-equity">최근 결성 {g.latestYear}년</span>
      </div>
      <h3 className="mt-2 font-bold">{g.gp}</h3>
      {existing && <p className="text-xs text-equity">이미 투자한 곳입니다. 신규 후보가 아니라 후속 투자·소개를 요청할 대상입니다.</p>}
      {rivals.length > 0 && (
        <p className="text-xs text-debt">
          {rivals.join(", ")}에 투자한 곳입니다. 이 업종을 아는 운용사이지만, 직접 경쟁사에 투자한 곳은 이해충돌로 투자를 피할 수 있습니다.
        </p>
      )}
      <p className="mt-1 line-clamp-1 text-sm">{first.name}</p>
      <p className="text-xs text-muted">
        출자 분야 {first.field} · 만기 {first.maturity}
      </p>
      <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
        {g.funds.length > 1 && (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${actionBtn} text-ink hover:bg-paper`}>
            {open ? "접기 ▴" : `펀드 ${g.funds.length}개 ▾`}
          </button>
        )}
        <button onClick={onSave} aria-pressed={saved} className={`${actionBtn} ml-auto ${saved ? "bg-accent text-white" : "border border-line hover:border-ink/40"}`}>
          {saved ? "★ 저장됨" : "☆ 저장"}
        </button>
      </div>
      <div className="mt-2">
        <GpBrief gp={g.gp} region={region} biz={biz} />
      </div>
      {open && (
        <ul className="mt-2 divide-y divide-line rounded-lg bg-paper px-3 text-sm">
          {g.funds.map((f) => (
            <li key={f.name} className="py-2">
              <p className="font-medium">{f.name}</p>
              <p className="text-xs text-muted">
                출자 분야 {f.field} · {f.year}년 결성 · 만기 {f.maturity}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="mt-3 rounded-xl border border-dashed border-line p-5 text-sm text-muted">{text}</p>;
}

function More({ onClick, rest }: { onClick: () => void; rest: number }) {
  return (
    <button onClick={onClick} className="min-h-11 w-full rounded-xl border border-line bg-card text-sm font-semibold text-muted hover:text-ink">
      더 보기 ({rest}건 남음)
    </button>
  );
}
