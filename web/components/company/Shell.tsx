"use client";

// 회사 화면 틀: 머리줄과 단계 메뉴(screens 1.1), 회사 표시줄(1.2), 화면 위 띠(1.10), 값 고치기 창과 새로 분석 확인 창.
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { createContext, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BIZ_LABEL, isBizType } from "@/lib/company-values";
import { ageLabel, daysSince, elapsedText, fmtDay, fmtTime, isStale, yearsSince } from "@/lib/format";
import { reviewCount, setEdit } from "@/lib/local";
import { onStorageChange, quotaExceeded, storageState } from "@/lib/store";
import { isTerminal, usedRaw } from "@/lib/view";
import type { BizTypeId, Value } from "@/lib/contract";
import { Banner, LiveRegion, SourceLine, StatusWord, Toast } from "@/components/kit";
import { Wordmark } from "@/components/SiteHeader";
import { CompanyProvider, useCompany, useTicker } from "@/components/company/context";
import { EditSheet } from "@/components/company/EditSheet";
import { RefreshDialog } from "@/components/company/Dialogs";
import { ValueBox, WORD_MEANING } from "@/components/company/values";

type ShellCtx = { openEdit: (from?: HTMLElement | null) => void; openRefresh: () => void };
const ShellContext = createContext<ShellCtx>({ openEdit: () => {}, openRefresh: () => {} });
export const useShell = () => useContext(ShellContext);

export function CompanyShell({ children }: { children: ReactNode }) {
  const params = useParams<{ id: string }>();
  const cid = decodeURIComponent(String(params.id ?? ""));
  return (
    <CompanyProvider key={cid} cid={cid}>
      <ShellBody>{children}</ShellBody>
    </CompanyProvider>
  );
}

let storageBannerClosed = false;
let quotaBannerClosed = false;

function ShellBody({ children }: { children: ReactNode }) {
  const c = useCompany();
  const [editOpen, setEditOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const editFrom = useRef<HTMLElement | null>(null);
  const storage = useSyncExternalStore(onStorageChange, () => `${storageState()}|${quotaExceeded()}`, () => "pending|false");
  const [, force] = useState(0);
  const [interruptedClosed, setInterruptedClosed] = useState(false);

  const openEdit = (from?: HTMLElement | null) => {
    editFrom.current = from ?? (document.activeElement as HTMLElement | null);
    setEditOpen(true);
  };
  const closeEdit = () => {
    setEditOpen(false);
    // 창이 닫히면 초점을 "값 고치기" 단추로 돌린다(C-19)
    setTimeout(() => editFrom.current?.focus(), 0);
  };

  if (c.phase === "invalid") {
    return (
      <>
        <CompanyHeader />
        <main className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6">
          <h1 className="text-2xl font-semibold">회사 주소가 올바르지 않습니다</h1>
          <p className="mt-2 text-sub">주소의 회사 번호를 확인하거나 시작 화면에서 회사 이름을 넣어 주세요.</p>
          <Link href="/" className="btn btn-primary mt-4">
            회사 이름 넣기
          </Link>
        </main>
      </>
    );
  }

  const interrupted = c.job?.status === "interrupted" || c.lostJob;
  const [st, quota] = storage.split("|");
  return (
    <ShellContext.Provider value={{ openEdit, openRefresh: () => setRefreshOpen(true) }}>
      <CompanyHeader />
      {c.connLost && (
        <Banner
          action={
            <button type="button" className="btn" onClick={c.reconnect}>
              다시 연결
            </button>
          }
        >
          분석 서버와 연결이 끊겼습니다. 다시 연결되면 이어서 받습니다.
        </Banner>
      )}
      {interrupted && !interruptedClosed && (
        <Banner
          onClose={() => setInterruptedClosed(true)}
          action={
            <a href="#first-stopped" className="btn">
              멈춘 단락 다시 분석
            </a>
          }
        >
          분석이 중간에 멈췄습니다. 받은 단락은 그대로 두었습니다.
        </Banner>
      )}
      {st === "memory" && !storageBannerClosed && (
        <Banner
          onClose={() => {
            storageBannerClosed = true;
            force((n) => n + 1);
          }}
        >
          이 브라우저에서는 고친 값과 담은 항목을 저장할 수 없습니다. 창을 닫으면 사라집니다.
        </Banner>
      )}
      {quota === "true" && !quotaBannerClosed && (
        <Banner
          onClose={() => {
            quotaBannerClosed = true;
            force((n) => n + 1);
          }}
        >
          브라우저 저장 공간이 부족해 이 회사 사본을 저장하지 못했습니다. 분석 결과는 서버에서 다시 받을 수 있습니다.
        </Banner>
      )}
      <CompanyBar />
      <div className="flex-1">{children}</div>
      <EditSheet open={editOpen} onClose={closeEdit} />
      <RefreshDialog open={refreshOpen} onClose={() => setRefreshOpen(false)} />
      <Toast />
      <LiveRegion />
    </ShellContext.Provider>
  );
}

// ---------------------------------------------------------------- 머리줄과 단계 메뉴

function CompanyHeader() {
  return (
    <>
      <div className="no-print border-b border-rule bg-paper sm:hidden">
        <div className="mx-auto flex min-h-12 max-w-[1200px] items-center px-4">
          <Wordmark />
        </div>
      </div>
      <header className="no-print sticky top-0 z-30 border-b border-rule bg-paper">
        <div className="mx-auto flex max-w-[1200px] items-stretch gap-6 px-0 sm:px-6">
          <span className="hidden items-center sm:flex">
            <Wordmark />
          </span>
          <StepNav />
        </div>
      </header>
    </>
  );
}

function StepNav() {
  const c = useCompany();
  const path = usePathname();
  const base = `/c/${c.cid}`;
  const job = c.job;
  const officialReady = !job || isTerminal(job.sections.official);
  const running = Boolean(job && job.status === "running");
  const n = reviewCount(c.local);
  const items = [
    { href: base, label: "회사 분석", current: path === base, disabled: false },
    { href: `${base}/funding`, label: "자금 조달", current: path.startsWith(`${base}/funding`), disabled: !officialReady },
    { href: `${base}/review`, label: "심사 준비", current: path.startsWith(`${base}/review`), disabled: false },
    { href: `${base}/sales`, label: "판로", current: path.startsWith(`${base}/sales`), disabled: false },
    { href: `${base}/note`, label: "노트", current: path.startsWith(`${base}/note`), disabled: false },
  ];
  return (
    <nav aria-label="단계" className="min-w-0 flex-1 overflow-x-auto">
      <ol className="flex min-w-max items-stretch sm:gap-4">
        {items.map((it, i) => (
          <li key={it.href} className="relative flex flex-1 items-stretch sm:flex-none">
            {i > 0 && <span aria-hidden className="absolute left-0 top-1/2 hidden h-px w-3 -translate-x-full bg-rule sm:block" />}
            {it.disabled ? (
              <span
                role="link"
                aria-disabled="true"
                aria-describedby="funding-wait"
                className="flex min-h-12 w-full flex-col items-center justify-center px-2 text-center text-sm text-sub sm:px-3"
              >
                <span>{it.label}</span>
                <span className="text-xs">준비 중</span>
                <span id="funding-wait" className="sr-only">
                  공식 자료를 받으면 열립니다
                </span>
              </span>
            ) : (
              <Link
                href={it.href}
                aria-current={it.current ? "page" : undefined}
                aria-label={it.label === "심사 준비" && n > 0 ? `심사 준비, 담은 항목 ${n}개` : undefined}
                className={`flex min-h-12 w-full items-center justify-center gap-1.5 whitespace-nowrap px-2 text-sm sm:px-3 sm:text-[15px] ${
                  it.current ? "font-semibold text-ink shadow-[inset_0_-3px_0_var(--color-ledger)]" : "text-sub hover:text-ink"
                }`}
              >
                {it.label}
                {it.label === "회사 분석" && running && (
                  <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-ledger motion-safe:animate-pulse" />
                )}
                {it.label === "심사 준비" && n > 0 && <span className="num rounded-full bg-ledger-soft px-1.5 text-xs font-semibold text-ledger">{n}</span>}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------- 회사 표시줄

type ChipKey = "region" | "age" | "biz";

function CompanyBar() {
  const c = useCompany();
  const path = usePathname();
  const { openEdit, openRefresh } = useShell();
  const [chipState, setChipState] = useState<{ path: string; key: ChipKey } | null>(null);
  const openChip = chipState && chipState.path === path ? chipState.key : null;
  const setOpenChip = (k: ChipKey | null) => setChipState(k ? { path, key: k } : null);
  const job = c.job;
  const running = Boolean(c.live && c.live.status === "running");
  const tick = useTicker(running, c.receivedAt);
  const isAnalysis = path === `/c/${c.cid}`;
  const name = job?.company.name ?? c.knownName ?? "회사";
  const edits = c.local.edits;
  const editBtn = useRef<HTMLButtonElement>(null);

  const m = job?.merged;
  const regionEdit = edits.region?.value;
  const foundedEdit = edits.founded?.value;
  const bizEdit = edits.bizType?.value;
  const foundedRaw = foundedEdit ?? usedRaw(m?.founded);
  const age = ageLabel(yearsSince(typeof foundedRaw === "string" ? foundedRaw : null, c.today));
  const foundedConflict = !foundedEdit && m?.founded?.status === "conflicting";

  const timeText = (() => {
    if (!job) return c.phase === "none" ? "아직 분석하지 않음" : "";
    if (running) return `분석 중 (${elapsedText((c.live!.sections.facts.seconds ?? 0) + tick)})`;
    if (!job.analyzedAt) return "";
    return isStale(job.analyzedAt) ? `${fmtDay(job.analyzedAt)} 분석, 오래된 분석입니다` : `${fmtTime(job.analyzedAt)} 분석`;
  })();

  const chip = (key: ChipKey, text: string, word: ReactNode) => (
    <button
      type="button"
      className="chip"
      aria-expanded={openChip === key}
      aria-controls="company-chip-box"
      onClick={() => {
        const missing = key === "region" ? !regionEdit && (!m?.region || m.region.status === "unavailable") : false;
        if (missing && m?.region) {
          openEdit(editBtn.current);
          return;
        }
        setOpenChip(openChip === key ? null : key);
      }}
    >
      <span>{text}</span>
      {word}
    </button>
  );

  return (
    <section aria-label="회사" className="no-print border-b border-rule">
      <div className="mx-auto max-w-[1200px] px-4 py-4 sm:px-6">
        <div className="cbar">
          <div className="cbar-name flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {isAnalysis ? <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">{name}</h1> : <p className="text-xl font-semibold">{name}</p>}
            {job?.isExample && <span className="tag text-sm">예시 회사</span>}
          </div>
          <div className="cbar-chips flex flex-wrap gap-2">
            {chip("region", regionEdit ?? (m?.region && m.region.status !== "unavailable" ? String(m.region.display) : m?.region ? "지역 미확보" : "지역 확인 중"), regionEdit ? <StatusWord w="edited" /> : null)}
            {chip("age", foundedConflict && m?.founded?.usedIndex === null ? "업력 엇갈림" : age ?? (m?.founded ? "업력 미확보" : "업력 확인 중"), foundedEdit ? <StatusWord w="edited" /> : foundedConflict ? <StatusWord w="conflicting" /> : null)}
            {chip("biz", isBizType(bizEdit) ? BIZ_LABEL[bizEdit] : "기업 유형 미확보", isBizType(bizEdit) ? <StatusWord w="edited" /> : null)}
          </div>
          <p className="cbar-time num whitespace-nowrap text-sm text-sub" aria-live="off">
            {timeText}
          </p>
          <div className="cbar-btns no-print flex gap-2">
            <button type="button" ref={editBtn} className="btn px-3 sm:px-4" onClick={(e) => openEdit(e.currentTarget)} disabled={!job}>
              값 고치기
            </button>
            {job && !job.isExample && (
              <button type="button" className="btn px-3 sm:px-4" onClick={openRefresh} disabled={running}>
                새로 분석
              </button>
            )}
          </div>
        </div>
        <div id="company-chip-box" className={openChip ? "mt-3 max-w-[680px] rounded-md bg-wash p-4 text-sm" : "hidden"}>
          {openChip === "region" && (
            <ValueBox v={m?.region} edit={regionEdit} onRevert={() => setEdit(c.cid, "region", null)} />
          )}
          {openChip === "age" && <AgeBox v={m?.founded ?? null} edit={foundedEdit} onRevert={() => setEdit(c.cid, "founded", null)} />}
          {openChip === "biz" && <BizBox onPick={(b) => setEdit(c.cid, "bizType", b)} current={isBizType(bizEdit) ? bizEdit : null} onRevert={() => setEdit(c.cid, "bizType", null)} />}
        </div>
        {job?.isExample && (
          <p className="mt-3 text-sm">
            저장해 둔 예시 분석입니다. 우리 회사를 보려면 회사 이름을 넣으세요.{" "}
            <Link href="/" className="link">
              회사 이름 넣기
            </Link>
          </p>
        )}
        {job?.analyzedAt && isStale(job.analyzedAt) && !running && (
          <p className="mt-3 text-sm font-medium text-amber">{daysSince(job.analyzedAt)}일 전 분석입니다. 최근 자료를 보려면 새로 분석하세요.</p>
        )}
      </div>
    </section>
  );
}

function AgeBox({ v, edit, onRevert }: { v: Value | null; edit?: string; onRevert: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sub">업력은 설립일부터 오늘까지 만 연수입니다.</p>
      <p>
        <span className="text-sub">설립 </span>
        {edit ?? (v ? (v.status === "unavailable" ? `미확보: ${v.reason}` : v.status === "conflicting" ? "" : v.display) : "확인 중")}
      </p>
      <ValueBox v={v} edit={edit} onRevert={onRevert} />
    </div>
  );
}

function BizBox({ current, onPick, onRevert }: { current: BizTypeId | null; onPick: (b: BizTypeId) => void; onRevert: () => void }) {
  const c = useCompany();
  const hint = c.job?.merged.bizTypeHint;
  return (
    <div className="space-y-2">
      {current ? (
        <p className="flex flex-wrap items-center gap-2">
          <StatusWord w="edited" />
          {WORD_MEANING.edited}
        </p>
      ) : (
        <p>
          <StatusWord w="unavailable" /> 근거 자료 없음. 기업 유형을 골라 주세요.
        </p>
      )}
      <BizPicker current={current} onPick={onPick} hint={hint ?? null} />
      {current && (
        <button type="button" className="btn btn-quiet" onClick={onRevert}>
          고른 기업 유형 지우기
        </button>
      )}
      {c.job?.merged.bizType.source && <SourceLine source={c.job.merged.bizType.source} />}
    </div>
  );
}

/** 기업 유형 고르기(decisions 2). 추정은 보이기만 하고 누를 때만 적용한다 */
export function BizPicker({ current, onPick, hint }: { current: BizTypeId | null; onPick: (b: BizTypeId) => void; hint: { id: BizTypeId; reason: string } | null }) {
  return (
    <div>
      <div role="group" aria-label="기업 유형" className="flex flex-wrap gap-2">
        {(Object.keys(BIZ_LABEL) as BizTypeId[]).map((b) => (
          <button key={b} type="button" className="chip" aria-pressed={current === b} onClick={() => onPick(b)}>
            {BIZ_LABEL[b]}
          </button>
        ))}
      </div>
      {hint && !current && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>{BIZ_LABEL[hint.id]}으로 보입니다</span>
          <StatusWord w="inferred" />
          <span className="text-sub">{hint.reason}</span>
        </p>
      )}
    </div>
  );
}
