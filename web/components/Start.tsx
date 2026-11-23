"use client";

// 시작(screens 2절)과 회사 확정(3절, /?name=). 회사 이름 하나로 법인을 찾고 분석을 시작한다.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Corp, CorpSearchResponse, ExampleResponse, HealthResponse, StartAnalysisResponse } from "@/lib/contract";
import { ApiFail, api, apiOrNull } from "@/lib/api";
import { fmtBzno, fmtDay, fmtTime, formerNamesText, isStale } from "@/lib/format";
import { forgetCompany, recentCompanies } from "@/lib/local";
import { sameNameIds } from "@/lib/names";
import { Disclosure } from "@/components/kit";
import { SiteHeader } from "@/components/SiteHeader";
import { setPending } from "@/components/company/context";

// 뒤로 가기로 시작 화면에 돌아오면 넣었던 이름을 다시 채운다(K-09)
let lastName = "";
let lastHomepage = "";
const searchCache = new Map<string, CorpSearchResponse>();

/** 홈페이지 주소에서 호스트 이름만(계약 2.2) */
export function hostOf(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  try {
    const h = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).hostname;
    return /^[A-Za-z0-9.-]{1,100}$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

type Health = "checking" | "up" | "down";
function useHealth(): Health {
  const [h, setH] = useState<Health>("checking");
  useEffect(() => {
    api<HealthResponse>("health")
      .then((r) => setH(r && r.ok !== false ? "up" : "down"))
      .catch(() => setH("down"));
  }, []);
  return h;
}

export function StartScreen() {
  const sp = useSearchParams();
  const name = sp.get("name");
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-16 pt-8 sm:px-6 sm:pt-12">{name ? <Confirm key={name} query={name} /> : <Start />}</main>
    </>
  );
}

// ---------------------------------------------------------------- 시작

function Start() {
  const router = useRouter();
  const health = useHealth();
  const [name, setName] = useState(lastName);
  const [home, setHome] = useState(lastHomepage);
  const [showHome, setShowHome] = useState(Boolean(lastHomepage));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fscDown, setFscDown] = useState(false);
  const [example, setExample] = useState<ExampleResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errId = useId();

  useEffect(() => {
    if (health !== "up") return;
    apiOrNull<ExampleResponse>("example").then(setExample).catch(() => setExample(null));
  }, [health]);

  const startPublicOnly = async () => {
    setBusy(true);
    try {
      const res = await api<StartAnalysisResponse>("analysis", { method: "POST", body: { name: name.trim(), homepage: hostOf(home) } });
      setPending(res.companyId, { name: name.trim(), crno: null, homepage: hostOf(home), jobId: res.jobId });
      router.push(`/c/${res.companyId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "분석을 시작하지 못했습니다.");
      setBusy(false);
    }
  };

  const submit = async () => {
    const n = name.trim();
    setFscDown(false);
    if (n.length < 2) {
      setErr("회사 이름을 2글자 이상 넣어 주세요.");
      inputRef.current?.focus();
      return;
    }
    setErr(null);
    lastName = n;
    lastHomepage = home;
    setBusy(true);
    try {
      const res = await api<CorpSearchResponse>(`corp/search?name=${encodeURIComponent(n)}`);
      searchCache.set(n, res);
      const exact = res.candidates.filter((c) => c.exact);
      if (res.candidates.length === 1 && exact.length === 1) {
        await go(router, exact[0], hostOf(home), n);
        return;
      }
      router.push(`/?name=${encodeURIComponent(n)}`);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiFail && (e.code === "upstream_error" || e.status === 502 || e.status === 504)) setFscDown(true);
      else setErr(e instanceof Error ? e.message : "법인을 찾지 못했습니다.");
    }
  };

  return (
    <div className="max-w-[680px]">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">우리 회사를 객관적으로 분석합니다</h1>
      <p className="mt-3 text-lg">회사 이름 하나로 공공 자료와 공개 보도를 모아 분석하고, 받을 수 있는 자금, 심사 준비, 판로까지 잇습니다.</p>

      <form
        className="mt-8"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="company-name" className="block text-sm font-semibold">
          회사 이름
        </label>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row">
          <input
            id="company-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 주식회사 가나다"
            maxLength={60}
            autoComplete="organization"
            aria-describedby={err ? errId : undefined}
            aria-invalid={Boolean(err) || undefined}
            className="min-h-12 flex-1 rounded-md border border-ink/40 px-4 text-lg outline-none focus:border-ledger"
          />
          <button type="submit" className="btn btn-primary min-h-12 px-6 text-base" disabled={busy || health === "down"}>
            {busy ? "법인 찾는 중" : "분석 시작"}
          </button>
        </div>
        <p aria-live="polite" className="sr-only">
          {busy ? "법인 찾는 중" : ""}
        </p>
        {err && (
          <p id={errId} role="alert" className="mt-2 font-medium text-amber">
            {err}
          </p>
        )}
        {health === "down" && <p className="mt-2 font-medium text-amber">지금은 분석 서버에 연결할 수 없습니다. 잠시 뒤 다시 시도하세요. 자금 둘러보기는 그대로 쓸 수 있습니다.</p>}
        {fscDown && (
          <div className="mt-2" role="alert">
            <p className="font-medium text-amber">금융위원회 자료에 연결하지 못했습니다. 다시 시도하거나, 법인 확인 없이 공개 자료만으로 분석할 수 있습니다.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn" onClick={() => void submit()}>
                다시 시도
              </button>
              <button type="button" className="btn" onClick={() => void startPublicOnly()}>
                공개 자료만으로 분석
              </button>
            </div>
          </div>
        )}
        {showHome ? (
          <div className="mt-4">
            <label htmlFor="company-home" className="block text-sm font-semibold">
              홈페이지 (선택)
            </label>
            <input
              id="company-home"
              value={home}
              onChange={(e) => setHome(e.target.value)}
              placeholder="예: https://example.co.kr"
              inputMode="url"
              aria-describedby="company-home-help"
              className="mt-1 min-h-11 w-full rounded-md border border-edge px-3 outline-none focus:border-ledger"
            />
            <p id="company-home-help" className="mt-1 text-sm text-sub">
              같은 이름의 다른 회사와 구별하는 데 씁니다.
            </p>
          </div>
        ) : (
          <button type="button" className="btn btn-quiet -ml-2.5 mt-2 text-sm" onClick={() => setShowHome(true)}>
            홈페이지 주소도 넣기 (선택)
          </button>
        )}
        <p className="mt-3 text-sm">공식 자료는 10초 안에 보이고, 나머지는 준비되는 대로 채웁니다. 전체는 3분 안팎입니다.</p>
      </form>

      <Recent />

      <div className="mt-8 flex flex-wrap gap-2">
        {example && health === "up" && (
          <Link href={`/c/${example.companyId}`} className="btn">
            예시 회사로 보기
          </Link>
        )}
        <Link href="/funding" className="btn">
          회사 없이 자금만 둘러보기
        </Link>
      </div>

      <Disclosure text="어떤 자료로 분석하나요?" className="mt-8" memoryKey="start:sources">
        <ul className="list-disc space-y-1 py-2 pl-5">
          <li>금융위원회 기업기본정보, 요약재무제표 (공공 API)</li>
          <li>국민연금공단 사업장 가입자 (공공 API)</li>
          <li>기업마당 지원사업 (공공 API)</li>
          <li>한국벤처투자 모태펀드 현황 (공공 API)</li>
          <li>조달청 나라장터 입찰공고 (공공 API)</li>
          <li>특허 공개 원문 (Google Patents)</li>
          <li>뉴스 (NAVER 뉴스 검색)</li>
          <li>Liner 검색과 모델</li>
        </ul>
        <p className="text-sm">근거가 없는 값은 만들지 않고 &lsquo;미확보&rsquo;로 둡니다.</p>
      </Disclosure>
    </div>
  );
}

async function go(router: ReturnType<typeof useRouter>, corp: Corp, homepage: string | null, query: string) {
  if (corp.snapshotAt) {
    setPending(corp.companyId, { name: query, crno: corp.crno, homepage });
    router.push(`/c/${corp.companyId}`);
    return;
  }
  const res = await api<StartAnalysisResponse>("analysis", { method: "POST", body: { name: corp.name, crno: corp.crno, homepage } });
  setPending(res.companyId, { name: corp.name, crno: corp.crno, homepage, jobId: res.jobId });
  router.push(`/c/${res.companyId}`);
}

type Row = Awaited<ReturnType<typeof recentCompanies>>[number];

function Recent() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  useEffect(() => {
    recentCompanies().then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows || rows.length === 0) return null;
  const line = (r: Row, removable: boolean) => (
    <li key={r.companyId} className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center">
      <Link href={`/c/${r.companyId}`} className="flex min-h-12 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5 rounded-md px-2 hover:bg-wash">
        <span className="font-semibold">{r.name}</span>
        <span className="num text-sm text-sub">{r.analyzedAt ? (isStale(r.analyzedAt) ? `${fmtDay(r.analyzedAt)} 분석, 오래된 분석` : `${fmtTime(r.analyzedAt)} 분석`) : "분석 중"}</span>
        {r.saved > 0 && <span className="text-sm">담은 항목 {r.saved}개</span>}
      </Link>
      {removable &&
        (ask === r.companyId ? (
          <span className="flex flex-col gap-2 rounded-md bg-wash p-3 text-sm sm:max-w-[360px]" role="alert">
            이 회사의 고친 값, 담은 항목, 노트를 이 브라우저에서 지울까요? 서버에 있는 분석은 남습니다.
            <span className="flex gap-2">
              <button type="button" className="btn" onClick={() => setAsk(null)}>
                취소
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await forgetCompany(r.companyId);
                  setAsk(null);
                  setRows(await recentCompanies());
                }}
              >
                지우기
              </button>
            </span>
          </span>
        ) : (
          <button type="button" className="btn btn-quiet" onClick={() => setAsk(r.companyId)}>
            지우기
          </button>
        ))}
    </li>
  );
  return (
    <section className="mt-10" aria-labelledby="recent-h">
      <h2 id="recent-h" className="text-base font-bold">
        이어서 보기
      </h2>
      <ul className="mt-2 divide-y divide-rule border-y border-rule">{rows.slice(0, 3).map((r) => line(r, false))}</ul>
      {rows.length > 3 && (
        <Disclosure text={`모두 보기 (${rows.length})`} openText={`모두 보기 (${rows.length}) 접기`} memoryKey="start:recent">
          <ul className="divide-y divide-rule">{rows.slice(0, 20).map((r) => line(r, true))}</ul>
        </Disclosure>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 회사 확정

const NONE = "__none__";

function Confirm({ query }: { query: string }) {
  const router = useRouter();
  const [res, setRes] = useState<CorpSearchResponse | null>(searchCache.get(query) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [pickedState, setPicked] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const titleId = useId();
  const optRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    lastName = query;
    if (res) return;
    api<CorpSearchResponse>(`corp/search?name=${encodeURIComponent(query)}`)
      .then((r) => {
        searchCache.set(query, r);
        setRes(r);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "법인을 찾지 못했습니다."));
  }, [query, res]);


  if (err) {
    return (
      <div className="max-w-[640px]">
        <h1 className="text-2xl font-semibold">어느 회사인가요?</h1>
        <p role="alert" className="mt-3 font-medium text-amber">
          {err}
        </p>
        <Link href="/" className="btn mt-4">
          이름 다시 넣기
        </Link>
      </div>
    );
  }
  if (!res) return <p className="text-sub">법인 찾는 중</p>;

  const backToStart = () => router.push("/");
  const startNone = async () => {
    setBusy(true);
    setStartErr(null);
    try {
      const r = await api<StartAnalysisResponse>("analysis", { method: "POST", body: { name: query, homepage: hostOf(lastHomepage) } });
      setPending(r.companyId, { name: query, crno: null, homepage: hostOf(lastHomepage), jobId: r.jobId });
      router.push(`/c/${r.companyId}`);
    } catch (e) {
      setStartErr(e instanceof Error ? e.message : "분석을 시작하지 못했습니다.");
      setBusy(false);
    }
  };

  if (res.candidates.length === 0) {
    return (
      <div className="max-w-[640px]">
        <h1 className="text-2xl font-semibold">법인을 찾지 못했습니다</h1>
        <p className="mt-3">&lsquo;{query}&rsquo; 이름의 법인이 금융위원회 기업기본정보에 없습니다. 이름이 다르면(주식회사 포함, 영문 이름 등) 다시 넣어 보세요.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void startNone()}>
            {busy ? "분석을 시작하는 중" : "공개 자료만으로 분석"}
          </button>
          <button type="button" className="btn" onClick={backToStart}>
            이름 다시 넣기
          </button>
        </div>
        {startErr && (
          <p role="alert" className="mt-2 font-medium text-amber">
            {startErr}
          </p>
        )}
      </div>
    );
  }

  // 이름이 정확히 같은 후보가 1곳이면 미리 고른다. 2곳 이상이면 미리 고르지 않는다(K-03, K-04)
  const exactOnes = res.candidates.filter((c) => c.exact);
  const picked = pickedState ?? (exactOnes.length === 1 ? exactOnes[0].companyId : null);
  const twins = sameNameIds(res.candidates);
  const list = all ? res.candidates : res.candidates.slice(0, 5);
  const options = [...list.map((c) => c.companyId), NONE];
  const chosen = res.candidates.find((c) => c.companyId === picked) ?? null;
  const move = (i: number, d: number) => {
    const next = (i + d + options.length) % options.length;
    setPicked(options[next]);
    optRefs.current[next]?.focus();
  };
  const submit = async () => {
    if (!picked) return;
    if (picked === NONE) return startNone();
    setBusy(true);
    setStartErr(null);
    try {
      await go(router, chosen!, hostOf(lastHomepage), query);
    } catch (e) {
      setStartErr(e instanceof Error ? e.message : "분석을 시작하지 못했습니다.");
      setBusy(false);
    }
  };
  const focusIdx = Math.max(0, options.indexOf(picked ?? options[0]));

  return (
    <div className="max-w-[640px] pb-24 sm:pb-0">
      <h1 id={titleId} className="text-2xl font-semibold">
        어느 회사인가요?
      </h1>
      <p className="mt-2">금융위원회 기업기본정보에서 찾은 법인 {res.candidates.length}곳입니다. 분석할 회사를 고르세요.</p>
      <div role="radiogroup" aria-labelledby={titleId} className="mt-5 divide-y divide-rule border-y border-rule">
        {list.map((c, i) => {
          const on = picked === c.companyId;
          // 이름이 같은 후보끼리는 대표·설립·시군구만으로 못 가를 수 있어 사업자번호·건물까지 나온 주소·이전 이름을 더 보인다(K-10)
          const twin = twins.has(c.companyId);
          const short = [c.region, c.district].filter(Boolean).join(" ") || "미확보";
          const hq = twin ? (c.address ?? short) : short;
          const bzno = twin ? (fmtBzno(c.bzno) ?? "미확보") : null;
          const former = twin ? formerNamesText(c.formerNames) : null;
          const label = [c.name, `대표 ${c.ceo ?? "미확보"}`, `설립 ${c.founded ?? "미확보"}`, bzno && `사업자번호 ${bzno}`, `본사 ${hq}`,
            former && `이전 이름 ${formerNamesText(c.formerNames, ", ")}`].filter(Boolean).join(", ");
          return (
            <div
              key={c.companyId}
              ref={(el) => void (optRefs.current[i] = el)}
              role="radio"
              aria-checked={on}
              tabIndex={i === focusIdx ? 0 : -1}
              aria-label={label}
              onClick={() => setPicked(c.companyId)}
              onKeyDown={(e) => keyNav(e, i, move, () => setPicked(c.companyId))}
              className={`flex min-h-14 cursor-pointer gap-3 px-3 py-3 ${on ? "bg-ledger-soft" : "hover:bg-wash"}`}
            >
              <Dot on={on} />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{c.name}</span>
                  {c.exact && <span className="tag">이름이 같음</span>}
                  {c.snapshotAt && <span className="tag">저장된 분석 있음 ({fmtDay(c.snapshotAt)})</span>}
                </span>
                <span className="num mt-0.5 flex flex-wrap gap-x-4 text-sm">
                  <span>
                    <span className="text-sub">대표 </span>
                    {c.ceo ?? "미확보"}
                  </span>
                  <span>
                    <span className="text-sub">설립 </span>
                    {c.founded ?? "미확보"}
                  </span>
                  {bzno ? (
                    <span data-twin="bzno">
                      <span className="text-sub">사업자번호 </span>
                      {bzno}
                    </span>
                  ) : (
                    <span>
                      <span className="text-sub">본사 </span>
                      {short}
                    </span>
                  )}
                </span>
                {twin && (
                  <span data-twin="address" className="mt-0.5 block text-sm break-words">
                    <span className="text-sub">본사 </span>
                    {hq}
                  </span>
                )}
                {former && (
                  <span data-twin="former" className="mt-0.5 block text-sm break-words">
                    <span className="text-sub">이전 이름 </span>
                    {former}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        <div
          ref={(el) => void (optRefs.current[list.length] = el)}
          role="radio"
          aria-checked={picked === NONE}
          tabIndex={focusIdx === list.length ? 0 : -1}
          onClick={() => setPicked(NONE)}
          onKeyDown={(e) => keyNav(e, list.length, move, () => setPicked(NONE))}
          className={`flex min-h-14 cursor-pointer gap-3 px-3 py-3 ${picked === NONE ? "bg-ledger-soft" : "hover:bg-wash"}`}
        >
          <Dot on={picked === NONE} />
          <span>
            <span className="font-bold">목록에 없음</span>
            <span className="block text-sm">법인 등록 전이거나 이름이 다른 경우입니다. 공식 재무·고용 자료 없이 공개 자료로만 분석합니다.</span>
          </span>
        </div>
      </div>
      {res.candidates.length > 5 && !all && (
        <button type="button" className="disclosure border-t-0" aria-expanded={false} onClick={() => setAll(true)}>
          <span>후보 {res.candidates.length - 5}곳 더 보기</span>
        </button>
      )}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-rule bg-paper p-3 sm:static sm:mt-5 sm:border-0 sm:p-0">
        <button type="button" className="btn btn-primary flex-1 sm:flex-none" disabled={!picked || busy} onClick={() => void submit()}>
          {busy ? "분석을 시작하는 중" : chosen?.snapshotAt ? "저장된 분석 보기" : "이 회사로 분석"}
        </button>
        <button type="button" className="btn" onClick={backToStart}>
          이름 다시 넣기
        </button>
      </div>
      {startErr && (
        <p role="alert" className="mt-2 font-medium text-amber">
          {startErr}
        </p>
      )}
    </div>
  );
}

function keyNav(e: KeyboardEvent, i: number, move: (i: number, d: number) => void, pick: () => void) {
  if (e.key === "ArrowDown" || e.key === "ArrowRight") {
    e.preventDefault();
    move(i, 1);
  } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
    e.preventDefault();
    move(i, -1);
  } else if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    pick();
  }
}

function Dot({ on }: { on: boolean }) {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 20 20" className="mt-0.5 shrink-0">
      <circle cx="10" cy="10" r="8" fill="none" stroke={on ? "var(--color-ledger)" : "var(--color-sub)"} strokeWidth="1.6" />
      {on && <circle cx="10" cy="10" r="4.5" fill="var(--color-ledger)" />}
    </svg>
  );
}
