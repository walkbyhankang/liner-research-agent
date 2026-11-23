"use client";

// 화면 어디서나 같은 모양으로 쓰는 작은 부품(screens 1.3·1.4, visual-plan 3.4).
// 펼치기 장치는 세 가지뿐이다: 펼치기 줄(Disclosure), 더 보기(MoreButton), 줄 자세히(DetailRow).
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Source } from "@/lib/contract";
import { safeUrl } from "@/lib/format";
import { wordText, type Word } from "@/lib/view";

// ---------------------------------------------------------------- 아이콘

export function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 20 20" className={`chev ${className}`}>
      <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function NewWindowIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
      <path d="M8 2h4v4M12 2L6.5 7.5M10.5 8.5V12h-8.5V3.5H6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/** 이 쪽 아래로 옮기는 링크(비교 표 "원문 n건" → 표 아래 목록). 새 창 아이콘과 같은 크기·굵기 */
export function DownIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
      <path d="M7 2.5v8M3.5 7.5L7 11l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PenIcon() {
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 12 12">
      <path d="M8.5 1.5l2 2L4 10H2v-2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- 상태 낱말

export function StatusWord({ w, className = "" }: { w: Word; className?: string }) {
  return (
    <span className={`word word-${w} ${className}`}>
      {w === "edited" && <PenIcon />}
      {wordText(w)}
    </span>
  );
}

/** 판정 낱말(자격 대조에만): 낱말 앞의 작은 원. 상태 낱말과 다른 모양 */
export function VerdictMark({ v, count }: { v: "충족" | "미충족" | "확인 필요" | "판단 대상 아님"; count?: number }) {
  const mark =
    v === "충족" ? <circle cx="7" cy="7" r="5" fill="var(--color-ledger)" /> :
    v === "미충족" ? <circle cx="7" cy="7" r="4.4" fill="none" stroke="var(--color-ink)" strokeWidth="1.6" /> :
    v === "확인 필요" ? (
      <>
        <circle cx="7" cy="7" r="4.4" fill="none" stroke="var(--color-amber)" strokeWidth="1.6" />
        <path d="M7 2.6a4.4 4.4 0 010 8.8z" fill="var(--color-amber)" />
      </>
    ) : <path d="M3 7h8" stroke="var(--color-sub)" strokeWidth="1.6" strokeLinecap="round" />;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold ${v === "충족" ? "text-ledger" : v === "확인 필요" ? "text-amber" : v === "판단 대상 아님" ? "text-sub" : "text-ink"}`}>
      <svg aria-hidden width="14" height="14" viewBox="0 0 14 14">{mark}</svg>
      {count === undefined ? v : `${v} ${count}`}
    </span>
  );
}

/** 글 안의 날짜·시각(2026-03, 2026-11-22 20:46)이 줄 끝에서 쪼개지지 않게 묶는다 */
export function nb(text: string | null | undefined): ReactNode {
  if (!text) return text ?? null;
  const parts = text.split(/(\d{4}-\d{2}(?:-\d{2})?(?: \d{2}:\d{2})?(?: ?~ ?\d{4}-\d{2}(?:-\d{2})?)?)/);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 ? <span key={i} className="whitespace-nowrap">{p}</span> : p));
}

// ---------------------------------------------------------------- 링크와 출처

/** 바깥 주소는 새 창, http·https 가 아니면 링크로 만들지 않는다(G-12) */
export function ExtLink({ href, children, className = "link", inline = false }: { href: string | null | undefined; children: ReactNode; className?: string; inline?: boolean }) {
  const url = safeUrl(href);
  if (!url) return <span className={inline ? "" : "text-sub"}>{children}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={className} data-inline={inline || undefined}>
      {children}
      <NewWindowIcon />
      <span className="sr-only">(새 창)</span>
    </a>
  );
}

/**
 * 출처 줄. 화면에는 두 부분({label} / 작게 {기준일}, {기준}), 화면 읽기·복사에는 한 줄.
 * word 를 주면 묶음 출처 줄(앞에 상태 낱말)이다.
 */
export function SourceLine({ source, label, detail, word, url, className = "" }: { source?: Source | null; label?: string; detail?: string | null; word?: Word; url?: string | null; className?: string }) {
  const main = label ?? source?.label ?? "";
  const tail = detail ?? [source?.asOf, source?.basis].filter(Boolean).join(", ");
  const link = url ?? source?.url ?? null;
  return (
    <div className={`source ${className}`}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {word && <StatusWord w={word} />}
        <span className="text-sub">{main}</span>
        {tail && <span className="num text-sub">{tail}</span>}
        {safeUrl(link) && (
          <ExtLink href={link} className="link text-xs">
            원문 열기
          </ExtLink>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- 펼치기 줄

/** 같은 방문 안에서 펼친 상태를 기억한다(새로고침하면 처음 상태) */
const openMemory = new Map<string, boolean>();

export function useOpen(key: string | null, initial = false): [boolean, (v: boolean) => void] {
  const [open, setOpenState] = useState(() => (key && openMemory.has(key) ? openMemory.get(key)! : initial));
  const setOpen = (v: boolean) => {
    if (key) openMemory.set(key, v);
    setOpenState(v);
  };
  return [open, setOpen];
}

/** open·onOpenChange 를 주면 바깥이 펼침 상태를 쥔다(다른 곳의 링크가 이 줄을 펼칠 때, 예: 비교 표의 "원문 n건"). 그때 memoryKey 는 바깥 useOpen 에 준다 */
export function Disclosure({
  text, openText, children, memoryKey, onFirstOpen, className = "", right, label, open: openProp, onOpenChange,
}: { text: string; openText?: string; children: ReactNode; memoryKey?: string; onFirstOpen?: () => void; className?: string; right?: ReactNode; label?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const id = useId();
  const [selfOpen, setSelfOpen] = useOpen(openProp === undefined ? memoryKey ?? null : null);
  const open = openProp ?? selfOpen;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setSelfOpen(v));
  const [ever, setEver] = useState(open);
  const shownText = open ? openText ?? (text.endsWith(" 보기") ? `${text.slice(0, -3)} 접기` : text) : text;
  return (
    <div className={className}>
      <button
        type="button"
        className="disclosure"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (!open && !ever) onFirstOpen?.();
          setOpen(!open);
          setEver(true);
        }}
      >
        <span className="min-w-0">{label ?? shownText}</span>
        <span className="flex items-center gap-2">
          {right}
          <Chevron />
        </span>
      </button>
      {/* 한 번 펼친 내용은 접어도 지우지 않는다. 진행 중인 유료 작업과 받은 결과를 지키기 위해서다 */}
      <div id={id} className={open ? "panel" : "hidden print-open"} role="region" aria-label={text}>
        {(ever || open) && children}
      </div>
    </div>
  );
}

/** 줄 자세히(3층): 줄 전체가 단추이고 아래에 열린다 */
export function DetailRow({ head, children, className = "", memoryKey }: { head: ReactNode; children: ReactNode; className?: string; memoryKey?: string }) {
  const id = useId();
  const [open, setOpen] = useOpen(memoryKey ?? null);
  return (
    <div className={className}>
      <button type="button" className="row-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="min-w-0 flex-1">{head}</span>
        <Chevron className="mt-0.5 text-sub" />
      </button>
      <div id={id} className={open ? "row-body" : "hidden"}>
        {children}
      </div>
    </div>
  );
}

/** 2층 안의 이어 보기. 누르면 새로 나온 첫 항목으로 초점을 옮긴다(C-13). 목록 요소에 id={listId}, 항목에 data-item={순번} */
export function useMore(total: number, first: number, step: number, rendered?: number) {
  const listId = useId();
  const [count, setCount] = useState(first);
  const [focusFrom, setFocusFrom] = useState<number | null>(null);
  const focused = useRef<number | null>(null);
  // 항목을 서버에서 받아 오는 목록(기사)은 그려진 뒤에 초점을 옮긴다
  useEffect(() => {
    if (focusFrom === null || focused.current === focusFrom) return;
    const el = document.getElementById(listId)?.querySelector<HTMLElement>(`[data-item="${focusFrom}"]`);
    if (!el) return;
    const target = el.matches("button, a") ? el : el.querySelector<HTMLElement>("button, a") ?? el;
    if (!target.matches("button, a, input, [tabindex]")) target.tabIndex = -1;
    target.focus();
    focused.current = focusFrom;
  }, [focusFrom, listId, rendered]);
  const more = () => {
    setFocusFrom(count);
    setCount((c) => Math.min(total, c + step));
  };
  const reset = useCallback(() => setCount(first), [first]);
  return { count: Math.min(count, total), more, reset, listId, left: Math.max(0, total - count), step };
}

export function MoreButton({ left, step, onClick }: { left: number; step: number; onClick: () => void }) {
  if (left <= 0) return null;
  return (
    <button type="button" className="btn mt-2 w-full font-medium" onClick={onClick}>
      {Math.min(step, left)}건 더 보기 ({left}건 남음)
    </button>
  );
}

/** 진행 중인 동안 1초마다 바뀌는 지금 시각(ms) */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// ---------------------------------------------------------------- 자리 표시, 알림

export function Placeholder({ h = 16, w = "100%", className = "" }: { h?: number; w?: string | number; className?: string }) {
  return <span aria-hidden className={`ph block ${className}`} style={{ height: h, width: w }} />;
}

/** 화면 읽기 알림(화면에 하나). announce() 로 보낸 문장을 차례로 붙인다 */
const liveMessages: string[] = [];
const liveListeners = new Set<() => void>();
let liveSnapshot: string[] = [];
export function announce(msg: string) {
  liveMessages.push(msg);
  liveSnapshot = liveMessages.slice(-20);
  liveListeners.forEach((l) => l());
}
export function LiveRegion() {
  const msgs = useSyncExternalStore(
    (cb) => {
      liveListeners.add(cb);
      return () => void liveListeners.delete(cb);
    },
    () => liveSnapshot,
    () => liveSnapshot,
  );
  return (
    <div className="sr-only" aria-live="polite" data-live>
      {msgs.map((m, i) => (
        <p key={i}>{m}</p>
      ))}
    </div>
  );
}

/** 잠깐 보이는 알림(저장했습니다 등) */
let toastText: { text: string; at: number } | null = null;
const toastListeners = new Set<() => void>();
export function toast(text: string) {
  toastText = { text, at: Date.now() };
  toastListeners.forEach((l) => l());
}
export function Toast() {
  const t = useSyncExternalStore(
    (cb) => {
      toastListeners.add(cb);
      return () => void toastListeners.delete(cb);
    },
    () => toastText,
    () => null,
  );
  const [hidden, setHidden] = useState<number | null>(null);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setHidden(t.at), 5000);
    return () => clearTimeout(id);
  }, [t]);
  const show = t && hidden !== t.at;
  return (
    <div role="status" aria-live="polite" className="no-print pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4">
      {show && <p className="pointer-events-auto max-w-[560px] whitespace-pre-line rounded-md bg-ink px-4 py-3 text-sm text-white">{t.text}</p>}
    </div>
  );
}

/** 화면 위 띠(연결 끊김, 저장소 못 씀 등). 칠한 면이라 정말 알릴 때만 쓴다 */
export function Banner({ children, action, onClose }: { children: ReactNode; action?: ReactNode; onClose?: () => void }) {
  return (
    <div className="no-print border-b border-rule bg-amber-soft" role="status">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-sm text-amber sm:px-6">
        <p className="min-w-0 flex-1 py-2 font-medium">{children}</p>
        {action}
        {onClose && (
          <button type="button" className="btn btn-quiet text-amber" onClick={onClose}>
            닫기
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 확인 창, 옆 패널

/** 확인 창. 열리면 초점은 첫 단추(보통 "취소"), Esc 는 취소(C-15) */
export function Dialog({ open, title, onClose, children, actions, focusFirst = true, wide = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; actions: ReactNode; focusFirst?: boolean; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      if (focusFirst) d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && d.open) d.close();
  }, [open, focusFirst]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`m-auto w-[calc(100%-32px)] ${wide ? "max-w-[640px]" : "max-w-[480px]"} rounded-lg border border-rule bg-paper p-0 text-ink backdrop:bg-ink/40`}
    >
      {open && (
        <div className="p-5 sm:p-6">
          <h2 id={titleId} className="text-xl font-semibold">
            {title}
          </h2>
          <div className="mt-3 text-base">{children}</div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div>
        </div>
      )}
    </dialog>
  );
}
