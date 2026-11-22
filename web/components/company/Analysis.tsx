"use client";

// 회사 분석 화면(screens 4절): 진행 줄 → 핵심 값 네 칸(재무제표식 숫자 띠) → 자금 후보 줄 → 상태 표시 안내 → 단락 6개.
// 단락은 정해진 순서로 자리를 잡고 도착하는 대로 그 자리만 채운다. 전체를 덮는 대기 화면은 없다.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_ESTIMATES, type AnalysisJob } from "@/lib/contract";
import { elapsedText } from "@/lib/format";
import { SCREEN_SECTIONS, TOC_TEXT, isTerminal, keyTiles, phaseOf, stillChecking, unavailableScreens, type ScreenKey, type Tile, type Word } from "@/lib/view";
import { Disclosure, Placeholder, StatusWord, nb } from "@/components/kit";
import { restoreAnchor, useCompany, useTicker } from "@/components/company/context";
import { WORD_MEANING } from "@/components/company/values";
import { Finance, Investment, Overview } from "@/components/company/sections-a";
import { News, Rivals, Tech } from "@/components/company/sections-b";

/** 단락으로 옮기고 제목에 초점(A-15). 주소 조각은 기록에 쌓지 않는다 */
export function goSection(key: ScreenKey) {
  const el = document.getElementById(key);
  if (!el) return;
  el.scrollIntoView({ block: "start" });
  history.replaceState(null, "", `#${key}`);
  document.getElementById(`h-${key}`)?.focus({ preventScroll: true });
}

export function AnalysisScreen() {
  const c = useCompany();
  const job = c.job;
  const hashDone = useRef(false);

  useLayoutEffect(() => restoreAnchor(), [job]);

  useEffect(() => {
    if (!job || hashDone.current) return;
    hashDone.current = true;
    const h = window.location.hash.slice(1);
    if (SCREEN_SECTIONS.some((s) => s.key === h)) requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView({ block: "start" }));
  }, [job]);

  if (c.phase === "loading" && !job) return <LoadingSkeleton />;
  if (c.phase === "none" && !job) return <NotAnalyzed />;
  if (!job) return <LoadingSkeleton />;

  return (
    <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:grid lg:grid-cols-[184px_minmax(0,1fr)] lg:gap-12">
      <Toc job={job} />
      <main className="min-w-0 max-w-[760px] pb-10">
        <ProgressLine job={job} />
        <KeyStrip job={job} />
        <FundingRow job={job} />
        <Disclosure text="상태 표시 안내" memoryKey={`${c.cid}:legend`} className="mt-2">
          <dl className="space-y-2 py-2">
            {(["confirmed", "reported", "inferred", "conflicting", "unavailable", "reference", "edited"] as Word[]).map((w) => (
              <div key={w} className="grid grid-cols-[6.5em_1fr] items-start gap-3">
                <dt>
                  <StatusWord w={w} />
                </dt>
                <dd className="text-sm">{WORD_MEANING[w]}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
        <div className="mt-6">
          <Overview />
          <Finance />
          <Investment />
          <News />
          <Tech />
          <Rivals />
        </div>
      </main>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6" aria-busy="true">
      <p className="sr-only">분석을 불러오는 중입니다</p>
      <div className="max-w-[760px] lg:ml-[232px]">
        <Placeholder h={120} />
        <div className="mt-6 space-y-3">
          <Placeholder h={20} w="40%" />
          <Placeholder h={16} />
          <Placeholder h={16} w="80%" />
        </div>
      </div>
    </div>
  );
}

function NotAnalyzed() {
  const c = useCompany();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const est = DEFAULT_ESTIMATES.full;
  return (
    <main className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6">
      <div className="max-w-[640px] rounded-lg border border-rule p-5">
        <p className="text-xl font-medium">아직 분석하지 않은 회사입니다.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              if (!c.knownName) {
                router.push("/");
                return;
              }
              setBusy(true);
              const r = await c.start(false);
              setBusy(false);
              if (!r.ok) setErr(r.message);
            }}
          >
            {busy ? "분석을 시작하는 중" : "분석 시작"}
          </button>
          <span className="text-sm text-sub">
            보통 {elapsedText(est.seconds ?? 180)}, Liner 약 {est.liner}회
          </span>
        </div>
        {err && (
          <p role="alert" className="mt-3 text-sm font-medium text-amber">
            {err}
          </p>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- 목차

function Toc({ job }: { job: AnalysisJob }) {
  const [current, setCurrent] = useState<ScreenKey>("overview");
  const listRef = useRef<HTMLOListElement>(null);
  // 지금 단락: 위에 붙은 줄 바로 아래(약 140px)를 지난 마지막 단락. 맨 위면 개요, 맨 아래면 경쟁사
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let cur: ScreenKey = SCREEN_SECTIONS[0].key;
      for (const s of SCREEN_SECTIONS) {
        const el = document.getElementById(s.key);
        if (el && (atEnd || el.getBoundingClientRect().top <= 140)) cur = s.key;
      }
      setCurrent(cur);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [job.jobId]);
  // 좁은 화면의 가로 목차는 지금 단락이 보이게 따라 민다(세로 스크롤은 건드리지 않는다)
  useEffect(() => {
    const ol = listRef.current;
    const a = ol?.querySelector<HTMLElement>("[aria-current=location]");
    if (!ol || !a || ol.scrollWidth <= ol.clientWidth) return;
    const r = a.getBoundingClientRect();
    const o = ol.getBoundingClientRect();
    if (r.left < o.left || r.right > o.right) ol.scrollBy({ left: r.left - o.left - 16 });
  }, [current]);
  const items = SCREEN_SECTIONS.map((s) => ({ ...s, text: TOC_TEXT[phaseOf(job.sections[s.primary])] }));
  return (
    <nav aria-label="단락 목차" className="no-print sticky top-[49px] z-20 -mx-4 border-b border-rule bg-paper px-4 sm:-mx-6 sm:px-6 lg:top-[65px] lg:mx-0 lg:mt-6 lg:self-start lg:border-b-0 lg:px-0">
      <ol ref={listRef} className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0 lg:overflow-visible">
        {items.map((s) => (
          <li key={s.key} className="shrink-0">
            <a
              href={`#${s.key}`}
              aria-current={current === s.key ? "location" : undefined}
              aria-label={`${s.label}, ${s.text}`}
              onClick={(e) => {
                e.preventDefault();
                goSection(s.key);
              }}
              className={`flex min-h-12 items-center gap-2 whitespace-nowrap px-3 text-sm lg:min-h-11 lg:justify-between lg:border-l-2 lg:px-3 ${
                current === s.key ? "font-semibold text-ink shadow-[inset_0_-3px_0_var(--color-ledger)] lg:border-ledger lg:shadow-none" : "text-sub lg:border-rule"
              }`}
            >
              <span>{s.label}</span>
              {/* 좁은 화면에서는 끝난 단락의 "준비됨"을 빼고 확인 중·미확보만 글로 보인다. 화면 읽기 이름에는 늘 있다 */}
              <span aria-hidden className={`text-xs ${s.text === "미확보" || s.text === "일부 미확보" ? "font-semibold text-amber" : "text-sub"} ${s.text === "준비됨" ? "hidden lg:inline" : ""}`}>
                {s.text}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------- 진행 줄

let doneLineClosed = new Set<string>();

function ProgressLine({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const running = job.status === "running";
  const tick = useTicker(running, c.receivedAt);
  const [, force] = useState(0);
  if (running) {
    const still = stillChecking(job);
    const secs = Math.max(...Object.values(job.sections).map((s) => s.seconds ?? 0));
    return (
      <div className="mt-6 border-l-2 border-ledger pl-4" role="status">
        <p>
          분석 중 <span className="num">({elapsedText(secs + tick)})</span>. 다른 화면으로 가도 분석은 계속됩니다.
        </p>
        {still.length > 0 && <p className="text-sm text-sub">아직 확인 중: {still.join(", ")}</p>}
      </div>
    );
  }
  const missing = unavailableScreens(job);
  if (job.status === "done" && missing.length && !doneLineClosed.has(job.jobId)) {
    return (
      <div className="mt-6 flex flex-wrap items-center gap-2 border-l-2 border-amber pl-4">
        <a
          href={`#${missing[0].key}`}
          className="link"
          onClick={(e) => {
            e.preventDefault();
            goSection(missing[0].key);
          }}
        >
          분석이 끝났습니다. 미확보 단락 {missing.length}개
        </a>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            doneLineClosed = new Set(doneLineClosed).add(job.jobId);
            force((n) => n + 1);
          }}
        >
          닫기
        </button>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------- 핵심 값 네 칸

function KeyStrip({ job }: { job: AnalysisJob }) {
  const tiles = keyTiles(job);
  return (
    <div className="mt-6 border-t-2 border-b border-t-ink border-b-rule">
      <ul className="grid grid-cols-2 gap-px bg-rule lg:grid-cols-4" aria-label="핵심 값">
        {tiles.map((t) => (
          <li key={t.key} className="bg-paper">
            <TileCell t={t} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TileCell({ t }: { t: Tile }) {
  return (
    <a
      href={`#${t.anchor}`}
      onClick={(e) => {
        e.preventDefault();
        goSection(t.anchor);
      }}
      aria-busy={t.loading || undefined}
      className="block h-full min-h-[132px] px-3 py-3 hover:bg-wash sm:px-4"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="text-sm text-sub">{t.label}</span>
        {t.word && <StatusWord w={t.word} />}
      </span>
      {t.loading ? (
        <span className="mt-2 block space-y-2">
          <Placeholder h={30} w="70%" />
          <span className="block text-sm text-sub">확인 중</span>
        </span>
      ) : t.missing ? (
        <span className="mt-2 block text-base font-semibold leading-snug">{t.missing}</span>
      ) : (
        <span className="mt-1 block">
          {t.big.map((b) => (
            <span key={b} className="num block text-2xl font-semibold leading-tight tracking-tight lg:text-[32px]">
              <BigNumber text={b} />
            </span>
          ))}
          {t.basis.map((b) => (
            <span key={b} className="num mt-1 block text-sm text-sub">
              {nb(b)}
            </span>
          ))}
        </span>
      )}
      {t.extra && (
        <span className="mt-1 block text-sm text-sub">
          {nb(t.extra)} {t.extraWord && <StatusWord w={t.extraWord} />}
        </span>
      )}
    </a>
  );
}

/**
 * "56.7억원"에서 단위를 한 단계 작게: 숫자와 단위는 붙여 둔다.
 * 웹 조사 값의 "(2025)" 같은 뒤 괄호는 큰 글로 꺾이지 않게 숫자 바로 밑 기준 줄 크기로 내린다(값 글은 그대로)
 */
function BigNumber({ text }: { text: string }) {
  const m = /^([^\d]*[\d.,]+)(\D*?)(\s*\([^)]*\))?$/.exec(text);
  if (!m || (!m[2] && !m[3])) return <>{text}</>;
  return (
    <>
      {m[1]}
      <span className="text-lg font-medium">{m[2]}</span>
      {m[3] && <span className="mt-1 block text-sm font-medium tracking-normal text-sub">{m[3].trim()}</span>}
    </>
  );
}

function FundingRow({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const ready = isTerminal(job.sections.official);
  return (
    <div className="no-print mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p>이 회사 값으로 받을 수 있는 자금 후보를 찾습니다.</p>
      {ready ? (
        <Link href={`/c/${c.cid}/funding`} className="btn btn-primary">
          자금 후보 보기
        </Link>
      ) : (
        <span className="flex items-center gap-2">
          <button type="button" className="btn" disabled>
            자금 후보 보기
          </button>
          <span className="text-sm text-sub">공식 자료를 받으면 열립니다</span>
        </span>
      )}
    </div>
  );
}
