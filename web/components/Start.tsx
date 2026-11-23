"use client";

// 시작(screens 2절)과 회사 확정(3절, /?name=). 회사 이름 하나로 법인을 찾고 분석을 시작한다.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Corp, CorpSearchResponse, ExampleResponse, HealthResponse, StartAnalysisResponse } from "@/lib/contract";
import { api, apiOrNull, isUpstreamFailure } from "@/lib/api";
import { fmtBzno, fmtDay, fmtTime, formerNamesText, isStale } from "@/lib/format";
import { forgetCompany, recentCompanies } from "@/lib/local";
import { normName, sameNameIds } from "@/lib/names";
import { Disclosure } from "@/components/kit";
import { SiteHeader } from "@/components/SiteHeader";
import { setPending } from "@/components/company/context";

// 뒤로 가기로 시작 화면에 돌아오면 넣었던 이름을 다시 채운다(K-09)
// 홈페이지 주소 입력은 2026-11-24 화면에서 뺐다(qa-report HOME-03·주석5). 분석 요청의 homepage 는 계약상 선택 칸이라 보내지 않는다
let lastName = "";
const searchCache = new Map<string, CorpSearchResponse>();

const SHORT_NAME = "회사 이름을 2글자 이상 넣어 주세요.";
/** 법인 없이 분석할 때 무엇이 빠지는지(목록에 없음, 후보 0곳, 조회 실패에서 같은 문장) */
const PUBLIC_ONLY_NOTE = "법인 정보 없이 분석합니다. 공식 재무·고용 자료는 포함되지 않습니다.";
/** 금융위원회 법인 조회가 바깥 연결 문제로 실패했는가(다시 시도하거나 공개 자료만으로 분석할 수 있다). 판단은 lib/api.ts isUpstreamFailure */
const isUpstream = isUpstreamFailure;

/**
 * 법인 없이 공개 자료만으로 분석을 시작한다. stillHere: 요청이 끝났을 때 시작한 화면에 아직 있는가.
 * 요청 중에 로고·뒤로 가기로 떠났으면 시작된 분석은 그대로 두고(setPending) 화면만 옮기지 않는다(리뷰 P2)
 */
async function startPublicOnly(router: ReturnType<typeof useRouter>, name: string, stillHere: () => boolean = () => true) {
  if (!stillHere()) return; // 떠나는 중이면 유료 분석을 시작하지 않는다
  const res = await api<StartAnalysisResponse>("analysis", { method: "POST", body: { name } });
  setPending(res.companyId, { name, crno: null, homepage: null, jobId: res.jobId });
  if (stillHere()) router.push(`/c/${res.companyId}`);
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

/**
 * 요청마다 "그 요청이 진행되는 동안 이 화면을 떠나기 시작했는가"를 본다(분석 시작 요청이 끝났을 때 옮겨도 되는가, 리뷰 P2).
 * 떠남: 같은 탭에서 다른 주소로 가는 링크를 누름, 뒤로·앞으로 가기, 화면이 닫힘. 새 탭·다른 사이트·같은 주소 링크는 떠남이 아니다.
 * 떠남은 그 순간 진행 중이던 요청만 취소한다. 주소만 바뀌고 이 화면이 그대로 남으면(예: 옛 주소 /?homepage= 에서 로고) 다음 요청은 정상이다.
 * 쓰는 법: const ok = begin(); … if (!ok()) 취소. 화면이 남아 있으면 취소 뒤 busy 를 푼다
 */
function useLeaveGuard(onLeave?: () => void): () => () => boolean {
  const epoch = useRef(0);
  const mounted = useRef(true);
  // 떠나는 순간 부를 일(예: 단추 풀기). 화면이 남는 경우(옛 주소에서 로고)에도 버려진 요청이 끝날 때까지 단추가 막혀 있지 않게(리뷰 P2)
  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  });
  useEffect(() => {
    mounted.current = true;
    const bump = () => {
      epoch.current += 1;
    };
    const leave = () => {
      bump();
      onLeaveRef.current?.();
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      leave();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", leave);
    return () => {
      mounted.current = false;
      bump();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", leave);
    };
  }, []);
  return useCallback(() => {
    const at = epoch.current;
    return () => mounted.current && epoch.current === at;
  }, []);
}

function Start() {
  const router = useRouter();
  const health = useHealth();
  const [name, setName] = useState(lastName);
  const [busy, setBusy] = useState(false);
  // 오류는 제출한 뒤에만 생긴다. 입력 중에는 새 오류를 만들지 않고, 2글자 조건을 채우면 그 오류만 지운다(HOME-02)
  const [err, setErr] = useState<{ text: string; short: boolean } | null>(null);
  const [fscDown, setFscDown] = useState(false);
  const [example, setExample] = useState<ExampleResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errId = useId();
  // 이 시작 화면에 아직 머무는가. 조회·분석 시작 요청 중에 다른 화면으로 떠나기 시작했으면(링크 누름, 뒤로 가기) 분석을 시작하지도, 옮기지도 않는다(리뷰 P2)
  // 떠나면 그때 진행 중이던 요청을 버리고 단추를 바로 푼다. 버려진 요청은 끝나도 단추·오류를 건드리지 않는다(새 제출의 상태를 지키려고)
  const begin = useLeaveGuard(() => setBusy(false));

  useEffect(() => {
    if (health !== "up") return;
    apiOrNull<ExampleResponse>("example").then(setExample).catch(() => setExample(null));
  }, [health]);

  const onPublicOnly = async () => {
    const stillHere = begin();
    setBusy(true);
    try {
      await startPublicOnly(router, name.trim(), stillHere);
    } catch (e) {
      // 떠난 뒤 끝난 요청은 성공이든 실패든 화면을 건드리지 않는다(단추는 떠날 때 이미 풀었다. 지금 입력과 다른 회사의 오류·대안을 보이지 않게, 리뷰 P2)
      if (!stillHere()) return;
      setBusy(false);
      setErr({ text: e instanceof Error ? e.message : "분석을 시작하지 못했습니다.", short: false });
    }
  };

  const submit = async () => {
    const n = name.trim();
    setFscDown(false);
    if (n.length < 2) {
      setErr({ text: SHORT_NAME, short: true });
      inputRef.current?.focus();
      return;
    }
    setErr(null);
    lastName = n;
    const stillHere = begin();
    setBusy(true);
    try {
      const res = await api<CorpSearchResponse>(`corp/search?name=${encodeURIComponent(n)}`);
      // 조회하는 동안 떠났으면 분석을 시작하지도, 화면을 옮기지도, 캐시에 쓰지도 않는다(리뷰 P2)
      if (!stillHere()) return;
      searchCache.set(n, res);
      const exact = res.candidates.filter((c) => c.exact);
      if (res.candidates.length === 1 && exact.length === 1) {
        await go(router, exact[0], n, stillHere);
        return;
      }
      router.push(`/?name=${encodeURIComponent(n)}`);
    } catch (e) {
      // 떠난 뒤 끝난 요청은 화면을 건드리지 않는다(단추는 떠날 때 이미 풀었다)
      if (!stillHere()) return;
      setBusy(false);
      if (isUpstream(e)) setFscDown(true);
      else setErr({ text: e instanceof Error ? e.message : "법인을 찾지 못했습니다.", short: false });
    }
  };

  return (
    <div className="max-w-[680px]">
      <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">우리 회사를 분석하고 경쟁사와 비교하세요.</h1>
      <p className="mt-3 text-lg">
        회사 이름을 입력하면 공공 자료와 공개 보도를 바탕으로 우리 회사의 현황을 분석하고 경쟁사와 비교할 수 있습니다. 분석 결과를 바탕으로 자금과 판로를 찾고, 지원사업 심사와 투자 미팅을 준비할 수 있습니다.
      </p>

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
            onChange={(e) => {
              setName(e.target.value);
              if (err?.short && e.target.value.trim().length >= 2) setErr(null);
            }}
            placeholder="예: 주식회사 가나다"
            maxLength={60}
            autoComplete="organization"
            aria-describedby={err ? errId : undefined}
            aria-invalid={err?.short || undefined}
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
            {err.text}
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
              <button type="button" className="btn" onClick={() => void onPublicOnly()}>
                공개 자료만으로 분석
              </button>
            </div>
          </div>
        )}
        <p className="mt-3 text-sm">분석은 약 3분 걸립니다. 준비된 자료부터 차례로 보여드립니다.</p>
      </form>

      <Recent />

      {/* 예시 보기는 보조(테두리) 단추, 회사 없이 둘러보기는 글 링크로 한 단계 낮춘다(HOME-06) */}
      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2">
        {example && health === "up" && (
          <Link href={`/c/${example.companyId}`} className="btn">
            예시 회사로 보기
          </Link>
        )}
        <Link href="/funding" className="link">
          회사 없이 자금만 둘러보기
        </Link>
      </div>

      {/* 펼칠 줄이 하나뿐이라 위 구분선 대신 여백으로 앞 단추와 나눈다(qa-report 주석2). 펼침 표시·줄 전체 누르기·초점 표시는 그대로 */}
      <Disclosure text="분석에 쓰는 자료" className="mt-12 [&>.disclosure]:border-t-0" memoryKey="start:sources">
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 py-3" data-sources>
          {SOURCES.map(([kind, from]) => (
            <div key={kind} className="contents">
              <dt className="font-semibold">{kind}</dt>
              <dd>{from}</dd>
            </div>
          ))}
        </dl>
        <p>회사 소개·투자 이력·경쟁사처럼 공공 자료에 없는 내용은 Liner로 공개된 웹 자료를 검색해 정리합니다.</p>
        <p className="mt-3 text-sm">분석 결과에서 자료의 출처와 확인 여부를 볼 수 있습니다. 근거가 없는 값은 만들지 않고 &lsquo;미확보&rsquo;로 둡니다.</p>
      </Disclosure>
    </div>
  );
}

/** 분석에 쓰는 자료(README 3절과 같은 기관·자료). 정보 종류별로 묶는다(HOME-05) */
const SOURCES: [string, string][] = [
  ["기업·재무", "금융위원회 기업기본정보·요약재무제표"],
  ["고용", "국민연금공단 사업장 가입자"],
  ["자금·판로", "기업마당 지원사업, 한국벤처투자 모태펀드, 조달청 나라장터 입찰공고"],
  ["특허·뉴스", "Google Patents 특허 공개 원문, NAVER 뉴스"],
];

async function go(router: ReturnType<typeof useRouter>, corp: Corp, query: string, stillHere: () => boolean = () => true) {
  if (corp.snapshotAt) {
    setPending(corp.companyId, { name: query, crno: corp.crno, homepage: null });
    router.push(`/c/${corp.companyId}`);
    return;
  }
  if (!stillHere()) return; // 떠나는 중이면 유료 분석을 시작하지 않는다
  const res = await api<StartAnalysisResponse>("analysis", { method: "POST", body: { name: corp.name, crno: corp.crno } });
  setPending(res.companyId, { name: corp.name, crno: corp.crno, homepage: null, jobId: res.jobId });
  if (stillHere()) router.push(`/c/${res.companyId}`);
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

/** 회사 확정의 모든 상태(찾는 중·후보·0곳·조회 실패)에서 같은 자리에 넣은 이름을 보인다(CONFIRM-03) */
function ConfirmHead({ title, titleId, children }: { title: string; titleId?: string; children: ReactNode }) {
  return (
    <>
      <h1 id={titleId} className="text-2xl font-semibold">
        {title}
      </h1>
      <div className="mt-2 space-y-2">{children}</div>
    </>
  );
}

function Confirm({ query }: { query: string }) {
  const router = useRouter();
  const [res, setRes] = useState<CorpSearchResponse | null>(searchCache.get(query) ?? null);
  const [err, setErr] = useState<{ text: string; upstream: boolean } | null>(null);
  const [tries, setTries] = useState(0);
  const [pickedState, setPicked] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const titleId = useId();
  const noteId = useId();
  const optRefs = useRef<(HTMLDivElement | null)[]>([]);
  const q = <>&lsquo;{query}&rsquo;</>;
  // 분석 시작 요청이 끝났을 때 이 확정 화면(같은 이름)이 아직 열려 있는가. 떠났으면 화면을 옮기지 않는다
  const begin = useLeaveGuard(() => setBusy(false));
  const live = useRef({ mounted: true, query });
  useEffect(() => {
    live.current.query = query;
  }, [query]);
  useEffect(() => {
    const l = live.current;
    l.mounted = true;
    return () => {
      l.mounted = false;
    };
  }, []);
  const stillHere = (q0: string) => {
    const ok = begin();
    return () => ok() && live.current.mounted && live.current.query === q0;
  };

  useEffect(() => {
    lastName = query;
    if (res) return;
    // 이 조회가 대체되면(다시 조회, 이름 바뀜, Strict Mode 의 두 번 실행, 화면 닫힘) 늦게 온 응답은 무시한다.
    // 그래야 늦은 실패가 성공한 재시도를 덮어 오류 화면으로 되돌리지 않는다(리뷰 P2). 성공하면 남은 오류도 지운다
    let current = true;
    api<CorpSearchResponse>(`corp/search?name=${encodeURIComponent(query)}`)
      .then((r) => {
        // 대체된 조회는 캐시에도 쓰지 않는다(늦게 온 옛 결과가 더 새 결과를 덮지 않게, 리뷰 P2)
        if (!current) return;
        searchCache.set(query, r);
        setErr(null);
        setRes(r);
      })
      .catch((e) => {
        if (current) setErr({ text: e instanceof Error ? e.message : "법인을 찾지 못했습니다.", upstream: isUpstream(e) });
      });
    return () => {
      current = false;
    };
  }, [query, res, tries]);

  // 분석 시작 요청이 끝나기 전에 처음으로 돌아가면, 요청이 끝날 때 그 분석으로 옮겨 가 버린다. 그래서 요청 중(busy)에는 이 단추도 막는다(리뷰 P2)
  const backToStart = () => router.push("/");
  const startNone = async () => {
    setBusy(true);
    setStartErr(null);
    const ok = stillHere(query);
    try {
      await startPublicOnly(router, query, ok);
    } catch (e) {
      // 떠난 뒤 끝난 요청은 화면을 건드리지 않는다(단추는 떠날 때 이미 풀었다. 지금 입력과 다른 회사의 오류를 보이지 않게, 리뷰 P2)
      if (!ok()) return;
      setBusy(false);
      setStartErr(e instanceof Error ? e.message : "분석을 시작하지 못했습니다.");
    }
  };
  const startErrLine = startErr && (
    <p role="alert" className="mt-2 font-medium text-amber">
      {startErr}
    </p>
  );

  // 조회 실패: 실패를 제목으로 밝히고, 같은 이름으로 다시 조회하기와 이름 고치기를 나눈다(CONFIRM-03)
  if (err) {
    return (
      <div className="max-w-[640px]">
        <ConfirmHead title="법인을 조회하지 못했습니다">
          {err.upstream ? (
            <p role="alert">{q} 이름으로 금융위원회 기업기본정보에 연결하지 못했습니다.</p>
          ) : (
            <>
              <p>{q} 이름으로 법인을 조회하지 못했습니다.</p>
              <p role="alert" className="font-medium text-amber">
                {err.text}
              </p>
            </>
          )}
          <p className="text-sm text-sub">이름이 맞으면 잠시 뒤 같은 이름으로 다시 조회하고, 이름을 잘못 넣었으면 이름을 다시 넣으세요.</p>
        </ConfirmHead>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              // 다시 조회할 때 앞서 실패한 분석 시작 오류도 지운다(후보 화면에 옛 오류가 남지 않게)
              setErr(null);
              setStartErr(null);
              setTries((t) => t + 1);
            }}
          >
            같은 이름으로 다시 조회
          </button>
          {err.upstream && (
            <button type="button" className="btn" disabled={busy} aria-describedby={noteId} onClick={() => void startNone()}>
              {busy ? "분석을 시작하는 중" : "공개 자료만으로 분석"}
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={backToStart}>
            이름 다시 넣기
          </button>
        </div>
        {err.upstream && (
          <p id={noteId} className="mt-2 text-sm text-sub">
            {PUBLIC_ONLY_NOTE}
          </p>
        )}
        {startErrLine}
      </div>
    );
  }
  if (!res) {
    return (
      <div className="max-w-[640px]">
        <ConfirmHead title="어느 회사인가요?">
          <p aria-live="polite">{q} 이름으로 금융위원회 기업기본정보에서 법인을 찾는 중입니다.</p>
        </ConfirmHead>
      </div>
    );
  }

  if (res.candidates.length === 0) {
    return (
      <div className="max-w-[640px]">
        <ConfirmHead title="법인을 찾지 못했습니다">
          <p>{q} 이름의 법인이 금융위원회 기업기본정보에 없습니다. 이름이 다르면(주식회사 포함, 영문 이름 등) 다시 넣어 보세요.</p>
        </ConfirmHead>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={busy} aria-describedby={noteId} onClick={() => void startNone()}>
            {busy ? "분석을 시작하는 중" : "공개 자료만으로 분석"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={backToStart}>
            이름 다시 넣기
          </button>
        </div>
        <p id={noteId} className="mt-2 text-sm text-sub">
          {PUBLIC_ONLY_NOTE}
        </p>
        {startErrLine}
      </div>
    );
  }

  // 이름이 정확히 같은 후보가 1곳이면 미리 고른다. 2곳 이상이면 미리 고르지 않는다(K-03, K-04)
  const exactOnes = res.candidates.filter((c) => c.exact);
  const picked = pickedState ?? (exactOnes.length === 1 ? exactOnes[0].companyId : null);
  const twins = sameNameIds(res.candidates);
  // 이름이 같은 묶음이 여럿이면(예: A 2곳, B 2곳) 합친 수 "4곳"은 틀리게 읽힌다. 묶음이 하나일 때만 수를 쓴다(리뷰 P3)
  const twinGroups = new Set(res.candidates.filter((c) => twins.has(c.companyId)).map((c) => normName(c.name))).size;
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
    const ok = stillHere(query);
    try {
      await go(router, chosen!, query, ok);
    } catch (e) {
      // 떠난 뒤 끝난 요청은 화면을 건드리지 않는다(단추는 떠날 때 이미 풀었다. 지금 입력과 다른 회사의 오류를 보이지 않게, 리뷰 P2)
      if (!ok()) return;
      setBusy(false);
      setStartErr(e instanceof Error ? e.message : "분석을 시작하지 못했습니다.");
    }
  };
  const focusIdx = Math.max(0, options.indexOf(picked ?? options[0]));
  const primary = busy ? "분석을 시작하는 중" : picked === NONE ? "공개 자료만으로 분석" : chosen?.snapshotAt ? "저장된 분석 보기" : "이 회사로 분석";

  return (
    <div className="max-w-[640px] pb-24 sm:pb-0">
      <ConfirmHead title="어느 회사인가요?" titleId={titleId}>
        <p>
          {q} 이름으로 금융위원회 기업기본정보에서 찾은 법인 {res.candidates.length}곳입니다.{twins.size >= 2 ? "" : " 분석할 회사를 고르세요."}
        </p>
        {/* 이름이 같은 법인이 여럿이면 줄마다 "이름이 같음"을 되풀이하지 않고 위에서 한 번 알린다(CONFIRM-01) */}
        {twins.size >= 2 && (
          <p className="font-semibold" data-twins-note>
            {twinGroups > 1 ? "이름이 같은 법인이 여러 묶음 있어요." : `이름이 같은 법인 ${twins.size}곳을 찾았어요.`} 사업자번호나 설립일을 확인해 주세요.
          </p>
        )}
      </ConfirmHead>
      {/* 후보 사이에만 선을 두고 목록 위아래 선은 여백으로 바꾼다. "목록에 없음"은 같은 고르기 묶음 안 맨 끝의 보조 길이다(CONFIRM-04) */}
      <div role="radiogroup" aria-labelledby={titleId} className="mt-6">
        <div className="divide-y divide-rule">
          {list.map((c, i) => {
            const on = picked === c.companyId;
            // 이름이 같은 후보끼리는 대표·설립·시군구만으로 못 가를 수 있어 사업자번호·설립을 맨 앞 같은 자리에 두고, 이전 이름을 굵게, 건물까지 나온 주소를 더 보인다(K-10)
            const twin = twins.has(c.companyId);
            const short = [c.region, c.district].filter(Boolean).join(" ") || "미확보";
            const hq = twin ? (c.address ?? short) : short;
            const bzno = twin ? (fmtBzno(c.bzno) ?? "미확보") : null;
            const former = twin ? formerNamesText(c.formerNames) : null;
            const saved = c.snapshotAt ? `저장된 분석 있음 (${fmtDay(c.snapshotAt)})` : null;
            const sameAsInput = c.exact && !twin;
            const label = (
              twin
                ? [c.name, `사업자번호 ${bzno}`, `설립 ${c.founded ?? "미확보"}`, former && `이전 이름 ${formerNamesText(c.formerNames, ", ")}`, `대표 ${c.ceo ?? "미확보"}`, `본사 ${hq}`, saved]
                : [c.name, sameAsInput && "입력한 이름과 같음", `대표 ${c.ceo ?? "미확보"}`, `설립 ${c.founded ?? "미확보"}`, `본사 ${hq}`, saved]
            )
              .filter(Boolean)
              .join(", ");
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
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span className="font-bold">{c.name}</span>
                    {sameAsInput && <span className="tag">입력한 이름과 같음</span>}
                    {saved && <span className="tag">{saved}</span>}
                  </span>
                  {twin ? (
                    <>
                      <span className="num mt-0.5 flex flex-wrap gap-x-4 text-sm">
                        <span data-twin="bzno" className="sm:min-w-[11.5rem]">
                          <span className="text-sub">사업자번호 </span>
                          {bzno}
                        </span>
                        <span data-twin="founded">
                          <span className="text-sub">설립 </span>
                          {c.founded ?? "미확보"}
                        </span>
                      </span>
                      {former && (
                        <span data-twin="former" className="mt-0.5 block text-sm break-words">
                          <span className="text-sub">이전 이름 </span>
                          <span className="font-semibold">{former}</span>
                        </span>
                      )}
                      <span className="mt-0.5 flex flex-wrap gap-x-4 text-sm">
                        <span>
                          <span className="text-sub">대표 </span>
                          {c.ceo ?? "미확보"}
                        </span>
                        <span data-twin="address" className="break-words">
                          <span className="text-sub">본사 </span>
                          {hq}
                        </span>
                      </span>
                    </>
                  ) : (
                    <span className="num mt-0.5 flex flex-wrap gap-x-4 text-sm">
                      <span>
                        <span className="text-sub">대표 </span>
                        {c.ceo ?? "미확보"}
                      </span>
                      <span>
                        <span className="text-sub">설립 </span>
                        {c.founded ?? "미확보"}
                      </span>
                      <span>
                        <span className="text-sub">본사 </span>
                        {short}
                      </span>
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {res.candidates.length > 5 && !all && (
          // 글 왼쪽을 후보 이름 줄(줄 안쪽 12 + 동그라미 20 + 간격 12)에 맞춘다. 단추 안쪽 10px 만큼 당긴다
          <button type="button" className="btn btn-quiet mt-1 ml-[34px]" aria-expanded={false} onClick={() => setAll(true)}>
            후보 {res.candidates.length - 5}곳 더 보기
          </button>
        )}
        <div
          ref={(el) => void (optRefs.current[list.length] = el)}
          role="radio"
          aria-checked={picked === NONE}
          tabIndex={focusIdx === list.length ? 0 : -1}
          aria-label={`목록에 없음, ${PUBLIC_ONLY_NOTE}`}
          onClick={() => setPicked(NONE)}
          onKeyDown={(e) => keyNav(e, list.length, move, () => setPicked(NONE))}
          className={`mt-4 flex min-h-14 cursor-pointer gap-3 rounded-md px-3 py-3 ${picked === NONE ? "bg-ledger-soft" : "hover:bg-wash"}`}
        >
          <Dot on={picked === NONE} />
          <span>
            <span className="font-semibold">목록에 없음</span>
            <span className="block text-sm text-sub">{PUBLIC_ONLY_NOTE}</span>
          </span>
        </div>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-rule bg-paper p-3 sm:static sm:mt-6 sm:border-0 sm:p-0">
        <button type="button" className="btn btn-primary flex-1 sm:flex-none" disabled={!picked || busy} onClick={() => void submit()}>
          {primary}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={backToStart}>
          이름 다시 넣기
        </button>
      </div>
      {startErrLine}
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
