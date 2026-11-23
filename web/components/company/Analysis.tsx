"use client";

// 회사 분석 화면(screens 4절): 진행 줄 → 핵심 값 네 칸(재무제표식 숫자 띠) → 자금·판로 줄 → 상태 표시 안내 → 단락 5개 → 경쟁사 분석 줄.
// 경쟁사는 2026-11-23 화면 구조 개편으로 단락이 아니라 경쟁사 분석 화면(/c/[id]/rivals)이다. 여기에는 그 입구 한 줄만 둔다.
// 단락은 정해진 순서로 자리를 잡고 도착하는 대로 그 자리만 채운다. 전체를 덮는 대기 화면은 없다.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_ESTIMATES, type AnalysisJob } from "@/lib/contract";
import { elapsedText } from "@/lib/format";
import { SCREEN_SECTIONS, TOC_TEXT, PATENT_LABEL, keyTiles, phaseOf, pickedRivals, stillChecking, unavailableScreens, visibleRivals, type ScreenKey, type Tile, type Word } from "@/lib/view";
import { checkNowCounts, type OpenValue } from "@/lib/review";
import { Chevron, Disclosure, Placeholder, StatusWord, VerdictMark, nb, useOpen } from "@/components/kit";
import { restoreAnchor, useCompany, useTicker } from "@/components/company/context";
import { ConflictLines, WORD_MEANING } from "@/components/company/values";
import { usePublicData, useToday } from "@/components/funding/Board";
import { Finance, Investment, Overview } from "@/components/company/sections-a";
import { News, Tech } from "@/components/company/sections-b";

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
  const router = useRouter();
  const job = c.job;
  const hashDone = useRef(false);

  // 옛 경쟁사 단락 주소(#rivals)는 경쟁사 분석 화면으로 보낸다(기록에 쌓지 않는다, screens 4.0)
  useEffect(() => {
    if (window.location.hash === "#rivals") router.replace(`/c/${c.cid}/rivals`);
  }, [router, c.cid]);

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
    // 넓은 화면(1024px 이상): 본문 760 + 간격 48 + 목차 184. 본문이 회사 이름 줄과 같은 왼쪽 선에서 시작하고 목차는 본문 오른쪽에 붙는다
    // (2026-11-23 가로 폭 정리, visual-plan 7절). 목차는 DOM 에서 본문 앞에 둔다: 좁은 화면에서는 단계 메뉴 아래 붙는 가로 줄로 본문 위에 보이고,
    // 넓은 화면에서도 단락으로 건너뛰는 길잡이라 키보드·화면 읽기가 본문보다 먼저 만나는 것이 자연스럽다. 넓은 화면의 오른쪽 자리는 격자 칸으로만 옮긴다
    <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:grid lg:grid-cols-[minmax(0,760px)_184px] lg:gap-12">
      <Toc job={job} />
      <main className="min-w-0 max-w-[760px] pb-10 lg:col-start-1 lg:row-start-1">
        <ProgressLine job={job} />
        <KeyStrip job={job} />
        <CheckNow job={job} />
        {/* 핵심 값 아래 "자금·판로 보기" 줄은 2026-11-24 뺐다(qa-report 3절 주석 2): 단계 메뉴로 바로 가고, 본문 끝의 다음 단계는 경쟁사 분석이다 */}
        <Disclosure text="상태 표시 안내" memoryKey={`${c.cid}:legend`} className="mt-4">
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
          <RivalsNext job={job} />
        </div>
      </main>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6" aria-busy="true">
      <p className="sr-only">분석을 불러오는 중입니다</p>
      {/* 불러오는 중 뼈대도 본문과 같은 자리(회사 이름 줄과 같은 왼쪽 선, 폭 760) */}
      <div className="max-w-[760px]">
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
  // 지금 단락: 위에 붙은 줄 바로 아래(약 140px)를 지난 마지막 단락. 맨 위면 개요, 맨 아래면 기술
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
    <nav aria-label="단락 목차" className="no-print sticky top-[49px] z-20 -mx-4 border-b border-rule bg-paper px-4 sm:-mx-6 sm:px-6 lg:col-start-2 lg:row-start-1 lg:top-[65px] lg:mx-0 lg:mt-6 lg:self-start lg:border-b-0 lg:px-0">
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
              className={`flex min-h-12 items-center gap-2 whitespace-nowrap px-3 text-sm text-ink lg:min-h-11 lg:justify-between lg:border-l-2 lg:px-3 ${
                current === s.key ? "font-semibold shadow-[inset_0_-3px_0_var(--color-ledger)] lg:border-ledger lg:shadow-none" : "lg:border-rule"
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
/** 이 방문에서 진행 중인 모습을 본 작업. 끝난 뒤에도 진행 줄 자리를 같은 높이로 남긴다 */
const seenRunning = new Set<string>();

/**
 * 진행 줄(screens 4절). 첫 화면 맨 위라 높이가 바뀌면 아래 전체가 밀린다(실제 서버 검증에서 +22px, 끝날 때 −96px).
 * - 진행 중: 두 줄 고정 높이. "아직 확인 중" 목록은 한 줄로 자르고(넘치면 말줄임) 줄 수가 바뀌지 않게 한다. 각 단락의 "확인 중"에 같은 내용이 있다.
 * - 끝남: 이 방문에서 진행을 봤으면 같은 자리·같은 최소 높이에 "분석이 끝났습니다…"를 남긴다(닫기는 사용자가 누를 때만).
 * - 화면 읽기 알림(aria-live)에는 넣지 않는다. 매초 바뀌는 경과 초를 읽지 않게 하고, 단락 준비·분석 끝 알림은 LiveRegion 이 한 번씩 한다.
 */
function ProgressLine({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const running = job.status === "running";
  const tick = useTicker(running, c.receivedAt);
  const [, force] = useState(0);
  useEffect(() => {
    if (running) seenRunning.add(job.jobId);
  }, [running, job.jobId]);
  // 진행 중 높이: 첫 줄(27.2px, 좁은 화면에서는 두 줄) + "아직 확인 중" 한 줄(22.4px). 끝난 줄도 같은 최소 높이
  const slot = "mt-6 min-h-[78px] border-l-2 pl-4 sm:min-h-[50px]";
  if (running) {
    const still = stillChecking(job);
    const secs = Math.max(...Object.values(job.sections).map((s) => s.seconds ?? 0));
    return (
      <div className={`${slot} border-ledger`} data-progress="running">
        <p>
          분석 중 <span className="num">({elapsedText(secs + tick)})</span>. 다른 화면으로 가도 분석은 계속됩니다.
        </p>
        {/* p 가 아니라 div: 전역 p 규칙(text-wrap: pretty)이 truncate 의 줄바꿈 금지를 덮어써 줄 수가 바뀌었다 */}
        <div className="truncate text-sm text-sub">{still.length ? `아직 확인 중: ${still.join(", ")}` : "마무리하는 중"}</div>
      </div>
    );
  }
  const missing = job.status === "done" ? unavailableScreens(job) : [];
  const seen = seenRunning.has(job.jobId);
  if (doneLineClosed.has(job.jobId) || (!missing.length && !seen)) return null;
  const close = (
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
  );
  return (
    <div className={`${seen ? slot : "mt-6"} flex flex-wrap content-start items-center gap-2 ${missing.length ? "border-amber" : "border-ledger"} border-l-2 pl-4`} data-progress="done">
      {/* 글 줄 높이를 닫기 단추(44px)와 같게 해 진행 줄 자리 맨 위에 붙인다(끝날 때 글이 아래로 움직이지 않게) */}
      {missing.length ? (
        <a
          href={`#${missing[0].key}`}
          className="link leading-[44px]"
          onClick={(e) => {
            e.preventDefault();
            goSection(missing[0].key);
          }}
        >
          분석이 끝났습니다. 미확보 단락 {missing.length}개
        </a>
      ) : (
        <p className="leading-[44px]">{job.status === "done" ? "분석이 끝났습니다." : "분석이 중간에 멈췄습니다."}</p>
      )}
      {close}
    </div>
  );
}

// ---------------------------------------------------------------- 핵심 값 네 칸

function KeyStrip({ job }: { job: AnalysisJob }) {
  const tiles = keyTiles(job);
  return (
    // 재무제표식 숫자 띠: 굵은 잉크 윗줄과 가는 잉크 아랫줄(화면에서 굵은 선은 여기 한 곳)
    <div className="mt-6 border-t-2 border-b border-ink">
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

/**
 * 칸 안의 상태(qa-report 3절 주석 1, 2026-11-24): 이름과 숫자를 먼저 읽게 이름 옆 상태 낱말을 뺐다.
 * 숫자의 해석을 바꾸는 상태(보도·추정·엇갈림·참고)만 기준 글 아래 보조 크기로 남기고, "원문 확인"과 나머지 출처는 각 단락의
 * 묶음 출처 줄·3층 상세에 있다(매출 "금융위원회 요약재무제표", 특허 "특허 공개 원문"). 참고(국민연금)는 낱말 뜻 "직원 수와 다름"을 함께 쓴다
 */
const TILE_NOTE: Partial<Record<Word, string>> = { reference: "직원 수와 다름" };

function TileCell({ t }: { t: Tile }) {
  // 칸 높이는 값이 다 왔을 때(기준 줄 2줄 + 나중에 오는 "웹 조사" 줄)에 맞춰 미리 잡는다. 늦게 오는 줄이 띠 높이를 바꿔 아래가 밀리지 않게.
  // 실측(업스테이지·기준 기업, 2026-11-23): 끝난 칸 내용 높이 최대 1180 폭 167px, 820 폭 140px, 390 폭 162px.
  // 글 크기 조정(숫자 32~36px, 이름표·기준 15px) 뒤 다시 잼: 기준 기업·가짜 F-FULL 최대 1180 폭 165px, 820 폭 141px, 390 폭 161px
  // 이름표 줄(2026-11-24): 이름 옆 상태 낱말(52px)을 뺐으므로 "검색으로 확인한 특허"(실제 글꼴 128px)가 360px 이상 모든 폭의 칸 안쪽(139px 이상)에
  // 한 줄로 든다. 그래서 2026-11-23의 이름표 두 줄 예약(48px)을 풀었다. 이름표 글은 확인 중·끝남이 같아 꺾이는 줄 수가 상태에 따라 바뀌지 않는다(A-23).
  // 360px 미만은 이름이 두 줄로 꺾여(상태와 무관하게 같음) 그만큼 최소 높이를 올린다.
  // 다시 잰 끝난 칸 내용 높이(가짜 F-FULL·F-STAGED t6, 이름 줄 예약 없음, 상태 줄 포함): 1024 이상 165px, 640~1023 141px, 360~639 161px, 확인 중 120px
  // → 최소 높이 168 / 144 / 164(360 미만 188). 누적 투자가 두 통화(F-MONEY)면 큰 값이 두 줄이라 이보다 높다(전에도 같음)
  const word = t.word && t.word !== "confirmed" ? t.word : null;
  return (
    <a
      href={`#${t.anchor}`}
      onClick={(e) => {
        e.preventDefault();
        goSection(t.anchor);
      }}
      aria-busy={t.loading || undefined}
      className="block h-full min-h-[164px] px-3 py-3 hover:bg-wash max-[359px]:min-h-[188px] sm:min-h-[144px] sm:px-4 lg:min-h-[168px]"
    >
      {/* 위계: 이름표(15 굵게) → 숫자(32~36 가장 굵게, 단위는 18로 붙임) → 기준(15 보조 글, 숫자 바로 밑) → 해석을 바꾸는 상태(13 낱말 + 뜻) */}
      <span className="block" data-tile-head>
        <span className="text-sm font-semibold">{t.label}</span>
      </span>
      {t.loading ? (
        <span className="mt-1 block space-y-2">
          <Placeholder h={36} w="70%" />
          <span className="block text-sm text-sub">확인 중</span>
        </span>
      ) : t.missing ? (
        <span className="mt-1 block text-base font-semibold leading-snug">{t.missing}</span>
      ) : (
        <span className="mt-0.5 block">
          {t.big.map((b) => (
            <span key={b} className="num block text-[32px] font-bold leading-[1.15] tracking-tight lg:text-[36px]">
              <BigNumber text={b} />
            </span>
          ))}
          {t.basis.map((b) => (
            <span key={b} className="num mt-1 block text-sm leading-snug text-sub">
              {nb(b)}
            </span>
          ))}
          {word && (
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm leading-snug" data-tile-word>
              <StatusWord w={word} />
              {TILE_NOTE[word] && <span>{TILE_NOTE[word]}</span>}
            </span>
          )}
        </span>
      )}
      {t.extra && (
        <span className="mt-1 block text-sm leading-snug">
          {/* 칸 안 상태는 해석을 바꾸는 것만(A-37): 덧붙는 웹 조사 값도 "원문 확인"은 빼고 보도·추정 등만 둔다 */}
          {nb(t.extra)} {t.extraWord && t.extraWord !== "confirmed" && <StatusWord w={t.extraWord} />}
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
      <span className="ml-0.5 text-lg font-semibold tracking-normal">{m[2]}</span>
      {m[3] && <span className="mt-1 block text-sm font-medium tracking-normal text-sub">{m[3].trim()}</span>}
    </>
  );
}

// ---------------------------------------------------------------- 확인이 필요한 정보(옛 이름 "지금 확인할 것")

/** 회사 값 이름 → 그 값이 보이는 단락(openValues 의 이름표) */
const VALUE_SECTION: Record<string, ScreenKey> = {
  지역: "overview", 본사: "overview", 대표: "overview", 설립: "overview", "업종(금융위)": "overview", "업종(웹 조사)": "overview", "직원 수": "overview",
  "매출(공식)": "finance", "매출(웹 조사)": "finance", "국민연금 가입자": "finance", [PATENT_LABEL]: "tech",
};

/**
 * "확인이 필요한 정보"가 공고 목록(/data/programs.json)을 기다리는 시간(screens 4.0.3 "오래 걸림"). 지나면 저장한 마감일로 센다.
 * 근거: 목록은 압축 전송 약 485KB. Chrome 개발 도구 "Fast 3G"(약 1.44Mbps, 왕복 약 0.56초)에서 약 4초에 오므로 여유를 둔 5초.
 */
const CHECKNOW_WAIT_MS = 5000;

/**
 * "확인이 필요한 정보"(screens 4.0.3, 2026-11-24 "지금 확인할 것"에서 이름을 바꿈. 제목만 읽어도 목적이 드러나게): 사실을 센 개수만 둔다(점수·확률 없음). 0인 항목은 숨기고, 끝난 분석을 열었을 때 모두 0이면 묶음을 그리지 않는다.
 * 이 방문에서 분석이 진행되는 것을 봤으면 틀을 끝까지 두고 항목은 한 줄로 둔다(끝나는 순간 아래가 밀리지 않게).
 * - 엇갈린 값·미확보 값: 합친 회사 값(merged)의 상태로 센다. 미팅 근거 묶음 "미팅 전에 정리할 값"과 같은 셈(openValues). 분석이 진행 중이면(새로 분석 포함) 세지 않는다.
 * 셈 자체는 lib/review.ts checkNowCounts(단위 시험이 있다).
 * - 마감 임박 담은 공고: 이 브라우저에 담은 공고(판로 지원사업 포함) 가운데 마감이 오늘부터 14일 안(자금·판로 "마감 임박"과 같은 날 수).
 *   마감일은 심사 준비·노트와 같은 기준(lib/review.ts noticeEnd: 지금 공고 자료 먼저, 없으면 담을 때 저장값). 지금 공고 자료는 자금·판로와 같은
 *   정적 파일(/data/programs.json, 유료 호출 없음, 한 방문에 한 번 받아 여러 화면이 나눠 쓴다). 받는 중에는 마감 임박을 세지 않고(저장값으로 먼저 셌다가
 *   받은 뒤 숫자가 바뀌지 않게), 담은 공고가 하나라도 있으면 틀과 "마감 임박은 공고 목록을 받으면 셉니다"를 먼저 둔다(받은 뒤 같은 자리에 들어와 아래가 밀리지 않게.
 *   저장값으로는 임박이 아니어도 마감이 앞당겨졌을 수 있다). 받지 못하면, 또는 CHECKNOW_WAIT_MS 가 지나도 오지 않으면 저장한 마감일로 센다.
 *   기다림 시간 제한은 이 묶음만의 것이다. 공용 요청은 끊지 않으므로 늦게라도 오면 지금 자료로 다시 센다(틀이 있어 위치는 그대로).
 * - 미충족 요건: 공고문 자격 대조를 한 담은 공고의 "미충족" 요건 수(심사 준비 "부족한 요건"과 같은 셈). 대조한 것이 없으면 없음.
 * 값 항목은 누르면 아래에 목록이 펼쳐지고(값마다 그 단락으로 가는 링크), 공고 항목은 심사 준비로 간다.
 */
function CheckNow({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const today = useToday();
  // 펼친 목록은 같은 방문 안에서 다른 단계에 다녀와도 유지한다(screens 1.4). 한 번에 한 항목만 열린다
  const [openConflict, setOpenConflict] = useOpen(`${c.cid}:ck:conflict`);
  const [openMissing, setOpenMissing] = useOpen(`${c.cid}:ck:missing`);
  const open: OpenValue["kind"] | null = openConflict ? "conflict" : openMissing ? "missing" : null;
  const running = job.status === "running" || c.live?.status === "running";
  // 이 방문에서 분석(새로 분석 포함)이 진행되는 것을 봤으면 묶음 틀을 끝까지 둔다. 끝나는 순간 묶음이 새로 생기거나 사라지면
  // 그 아래(자금·판로 줄·단락)가 밀리기 때문이다. 처음부터 끝난 분석을 열었고 셀 것이 없으면 묶음을 그리지 않는다
  const [seenRunning, setSeenRunning] = useState(running);
  if (running && !seenRunning) setSeenRunning(true); // 그리는 중 상태 맞추기(React 권장 방식, 효과 없이)
  // 분석이 진행되는 동안에는 펼친 값 목록을 닫는다. 열어 둔 채면 끝나는 순간 목록이 다시 펼쳐지며 아래를 민다(사용자가 다시 열면 된다)
  if (running && (openConflict || openMissing)) {
    setOpenConflict(false);
    setOpenMissing(false);
  }
  const pub = usePublicData();
  const loading = !pub.data && !pub.error; // 지금 공고 자료를 받는 중. 받지 못하면(error) 아래 셈이 저장한 마감일로 센다
  // 이 묶음만의 기다림 시간 제한. 지나면 저장값으로 센다(공용 요청은 그대로 두어 자금·판로·심사 준비·노트는 늦게라도 받는다)
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!loading || gaveUp) return;
    const t = setTimeout(() => setGaveUp(true), CHECKNOW_WAIT_MS);
    return () => clearTimeout(t);
  }, [loading, gaveUp]);
  const waiting = loading && !gaveUp;
  const { conflicts, missing, soon: counted, unmet, notices } = checkNowCounts(job, c.live, c.local.saved, c.local.checks, today, pub.data?.programs ?? null);
  // 받는 중(waiting)에는 마감 임박을 보이지 않고, 담은 공고가 있으면 틀을 잡는다. 틀을 한 번 잡았으면 이 방문 동안 둔다(seenRunning 과 같은 까닭)
  const soon = waiting ? [] : counted;
  const holdSoon = waiting && notices > 0;
  const [seenHold, setSeenHold] = useState(holdSoon);
  if (holdSoon && !seenHold) setSeenHold(true);
  const any = conflicts.length > 0 || missing.length > 0 || soon.length > 0 || unmet > 0;
  if (!any && !running && !seenRunning && !holdSoon && !seenHold) return null;

  const listed = open === "conflict" ? conflicts : open === "missing" ? missing : [];
  const toggle = (k: OpenValue["kind"]) => {
    setOpenConflict(k === "conflict" && open !== "conflict");
    setOpenMissing(k === "missing" && open !== "missing");
  };
  const valueButton = (k: OpenValue["kind"], n: number) => (
    <button type="button" className="btn gap-2 px-3 font-medium" aria-expanded={open === k} aria-controls="checknow-list" onClick={() => toggle(k)}>
      <StatusWord w={k === "conflict" ? "conflicting" : "unavailable"} />
      <span>
        값 <span className="num font-semibold">{n}</span>개
      </span>
      <Chevron className={`text-ledger transition-transform duration-150 ${open === k ? "rotate-180" : ""}`} />
    </button>
  );
  return (
    <section aria-labelledby="checknow-h" className="no-print mt-4 bg-wash px-3 py-3 sm:px-4" data-checknow>
      <h2 id="checknow-h" className="text-sm font-semibold">
        확인이 필요한 정보
      </h2>
      {/* 항목은 늘 한 줄(넘치면 옆으로 밀어 보기): 항목 수가 바뀌어도 묶음 높이가 같아 아래가 밀리지 않는다. 초점 테두리가 잘리지 않게 덧댐을 둔다 */}
      <ul className="scroll-row -mx-1.5 mt-1.5 flex gap-2 overflow-x-auto p-1.5">
        {running && (
          <li className="flex min-h-11 shrink-0 items-center text-sm text-sub">엇갈린 값·미확보 값은 분석이 끝나면 셉니다</li>
        )}
        {!running && !any && !holdSoon && <li className="flex min-h-11 shrink-0 items-center text-sm text-sub">확인이 필요한 정보가 없습니다</li>}
        {conflicts.length > 0 && <li>{valueButton("conflict", conflicts.length)}</li>}
        {missing.length > 0 && <li>{valueButton("missing", missing.length)}</li>}
        {/* 마감 임박 자리: 공고 목록을 받으면 같은 자리에 개수가 들어온다 */}
        {holdSoon && <li className="flex min-h-11 shrink-0 items-center text-sm text-sub">마감 임박은 공고 목록을 받으면 셉니다</li>}
        {soon.length > 0 && (
          <li>
            <Link href={`/c/${c.cid}/review?tab=grants`} className="btn gap-2 px-3 font-medium">
              <span>
                마감 임박 담은 공고 <span className="num font-semibold">{soon.length}</span>건
              </span>
              <span className="num font-bold">{Math.min(...soon) === 0 ? "오늘 마감" : `D-${Math.min(...soon)}`}</span>
            </Link>
          </li>
        )}
        {unmet > 0 && (
          <li>
            <Link href={`/c/${c.cid}/review?tab=grants`} className="btn gap-2 px-3 font-medium">
              <VerdictMark v="미충족" />
              <span>
                요건 <span className="num font-semibold">{unmet}</span>개
              </span>
            </Link>
          </li>
        )}
      </ul>
      <div id="checknow-list" role="region" aria-label={open === "conflict" ? "엇갈린 값" : "미확보 값"} className={listed.length ? "mt-2" : "hidden"}>
        <ul className="divide-y divide-rule bg-paper px-3">
          {listed.map((o) => {
            const key = VALUE_SECTION[o.label] ?? "overview";
            const label = SCREEN_SECTIONS.find((s) => s.key === key)?.label ?? "";
            return (
              <li key={o.label} className="grid items-start gap-x-4 py-2 sm:grid-cols-[8em_minmax(0,1fr)_auto]">
                <span className="font-semibold">{o.label}</span>
                <span className="min-w-0">{o.kind === "conflict" ? <ConflictLines v={o.value} /> : <>미확보: {o.value.reason ?? "자료 없음"}</>}</span>
                {o.label === "지역" ? (
                  // 지역은 단락이 아니라 회사 표시줄의 지역 칩에 있다(누르면 값과 출처, 미확보면 회사 정보 수정 창)
                  <button
                    type="button"
                    className="link text-sm"
                    onClick={() => {
                      const chip = document.querySelector<HTMLElement>("[data-chip=region]");
                      chip?.scrollIntoView({ block: "center" });
                      chip?.focus({ preventScroll: true });
                    }}
                  >
                    회사 표시줄에서 보기
                  </button>
                ) : (
                  <a
                    href={`#${key}`}
                    className="link text-sm"
                    onClick={(e) => {
                      e.preventDefault();
                      goSection(key);
                    }}
                  >
                    {label} 단락에서 보기
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * 본문 끝 다음 단계(screens 4.0, qa-report 3절 주석 10·4절 "행동", 2026-11-24): 도착 화면을 밝힌 주 단추 "경쟁사 분석 보기"와
 * 옆의 보조 글(경쟁사 후보 수, 비교 대상 수). 경쟁사 분석 끝 "자금·판로 보기", 자금·판로 "심사 준비로 가기"와 같은 모양(btn btn-primary)이다.
 * 후보를 받기 전·뒤 모두 한 줄이라 profile 이 와도 높이가 바뀌지 않는다. 후보 확인 중에도 경쟁사 분석으로 갈 수 있다(그 화면도 확인 중을 보인다)
 */
function RivalsNext({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const phase = phaseOf(job.sections.profile);
  const text =
    phase === "loading" ? "경쟁사 후보 확인 중" : phase === "unavailable" ? "경쟁사 후보 미확보" : `경쟁사 후보 ${visibleRivals(job).length}곳, 비교 대상 ${pickedRivals(job, c.local.rivalChoices).length}곳`;
  return (
    <div className="no-print flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink pt-8" data-rivals-line>
      <Link href={`/c/${c.cid}/rivals`} className="btn btn-primary">
        경쟁사 분석 보기
      </Link>
      <p className="text-sm text-sub">{text}</p>
    </div>
  );
}
