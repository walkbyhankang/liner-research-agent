"use client";

// 회사 화면(/c/[id]/…) 전체가 함께 쓰는 상태: 보이는 분석(브라우저 사본 → 진행 중 작업 → 서버 저장 분석 순서, 계약 2.7),
// 진행 중 작업 폴링(1.5초, busy 가 false 가 되면 멈춤), 새로 분석·단락 실행, 이 브라우저의 회사 자료.
// 단계를 옮겨도 이 상태는 레이아웃에 남아 분석이 계속 채워진다. 분석한 적 없는 회사는 자동으로 분석하지 않는다(A-11).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { COMPANY_ID_RE, isAnalysisJob, type AnalysisJob, type CompanyJobResponse, type SectionKey, type StartAnalysisResponse } from "@/lib/contract";
import { ApiFail, api, apiOrNull } from "@/lib/api";
import { todayKST } from "@/lib/format";
import {
  EMPTY_LOCAL, forgetJob, getLocal, loadSnapshot, recallJob, rememberJob, saveSnapshot, shouldReplace, subscribeLocal, touchCompany, type Local,
} from "@/lib/local";
import { announcements, overlay, type Overlay } from "@/lib/view";
import { announce } from "@/components/kit";

const POLL_MS = 1500;
const SLOW_POLL_MS = 5000;

/** 시작·회사 확정 화면이 알려 준 것(이름, 법인등록번호, 방금 시작한 작업). 새로고침에도 남게 세션 저장소에도 둔다 */
type Pending = { name: string; crno: string | null; homepage: string | null; jobId?: string };
const pendingMem = new Map<string, Pending>();
export function setPending(cid: string, p: Pending) {
  pendingMem.set(cid, p);
  try {
    sessionStorage.setItem(`growthnote.pending.${cid}`, JSON.stringify(p));
  } catch {
    // 세션 저장소를 못 써도 이번 화면에서는 메모리 값으로 간다
  }
}
function getPending(cid: string): Pending | null {
  if (pendingMem.has(cid)) return pendingMem.get(cid)!;
  try {
    const raw = sessionStorage.getItem(`growthnote.pending.${cid}`);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

export type Phase = "loading" | "ready" | "none" | "invalid";
export type RunResult = { ok: true } | { ok: false; code: string | null; message: string };

type Ctx = {
  cid: string;
  phase: Phase;
  view: Overlay | null;
  job: AnalysisJob | null;
  live: AnalysisJob | null;
  base: AnalysisJob | null;
  local: Local;
  today: string;
  /** 마지막 응답을 받은 때(ms). 진행 중 경과를 화면에서 이어 세는 기준 */
  receivedAt: number;
  connLost: boolean;
  lostJob: boolean;
  knownName: string | null;
  start: (refresh: boolean) => Promise<RunResult>;
  runSection: (key: SectionKey, body?: unknown) => Promise<RunResult>;
  reconnect: () => void;
};

const CompanyContext = createContext<Ctx | null>(null);

export function useCompany(): Ctx {
  const c = useContext(CompanyContext);
  if (!c) throw new Error("CompanyProvider 밖에서 썼습니다");
  return c;
}

export function useLocalData(cid: string): Local {
  return useSyncExternalStore(
    (cb) => subscribeLocal(cid, cb),
    () => getLocal(cid),
    () => EMPTY_LOCAL,
  );
}

export function CompanyProvider({ cid, children }: { cid: string; children: ReactNode }) {
  const valid = COMPANY_ID_RE.test(cid);
  const [phase, setPhase] = useState<Phase>(valid ? "loading" : "invalid");
  const [base, setBase] = useState<AnalysisJob | null>(null);
  const [live, setLive] = useState<AnalysisJob | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [connLost, setConnLost] = useState(false);
  const [lostJob, setLostJob] = useState(false);
  const [knownName, setKnownName] = useState<string | null>(null);
  const local = useLocalData(cid);
  const pollRef = useRef<{ jobId: string; timer: ReturnType<typeof setTimeout> | null; failures: number } | null>(null);
  const liveRef = useRef<AnalysisJob | null>(null);
  const baseRef = useRef<AnalysisJob | null>(null);
  const alive = useRef(true);

  const accept = useCallback(
    (next: AnalysisJob) => {
      rememberAnchor();
      const prev = liveRef.current && liveRef.current.jobId === next.jobId ? liveRef.current : baseRef.current && baseRef.current.jobId === next.jobId ? baseRef.current : null;
      for (const m of announcements(prev, next)) announce(m);
      liveRef.current = next;
      setLive(next);
      setReceivedAt(Date.now());
      const b = baseRef.current;
      // 끝난 작업이거나 보이던 분석이 없으면 이것이 보이는 분석이 된다. 새로 분석 중에는 이전 분석을 두고 위에 얹는다
      if (!b || b.jobId === next.jobId || next.status !== "running") {
        if (!b || shouldReplace(b, next)) {
          baseRef.current = next;
          setBase(next);
          void saveSnapshot(next);
        }
      }
      if (next.status !== "running") void forgetJob(next.companyId);
      setPhase("ready");
      touchCompany(next.companyId, next);
    },
    [],
  );

  const stopPoll = useCallback(() => {
    if (pollRef.current?.timer) clearTimeout(pollRef.current.timer);
    pollRef.current = null;
  }, []);

  const poll = useCallback(
    (jobId: string) => {
      if (pollRef.current?.jobId === jobId) return;
      stopPoll();
      const me = { jobId, timer: null as ReturnType<typeof setTimeout> | null, failures: 0 };
      pollRef.current = me;
      const tick = async () => {
        if (!alive.current || pollRef.current !== me) return;
        try {
          const j = await api<AnalysisJob>(`analysis/${jobId}`);
          if (pollRef.current !== me) return;
          me.failures = 0;
          setConnLost(false);
          if (isAnalysisJob(j)) accept(j);
          if (!j.busy) {
            stopPoll();
            return;
          }
        } catch (e) {
          if (pollRef.current !== me) return;
          if (e instanceof ApiFail && e.status === 404) {
            if (baseRef.current) setLostJob(true);
            else setPhase("none");
            stopPoll();
            return;
          }
          me.failures += 1;
          if (me.failures >= 5) setConnLost(true);
        }
        me.timer = setTimeout(tick, me.failures >= 5 ? SLOW_POLL_MS : POLL_MS);
      };
      void tick();
    },
    [accept, stopPoll],
  );

  useEffect(() => {
    alive.current = true;
    if (!valid) return;
    let cancelled = false;
    (async () => {
      const pending = getPending(cid);
      if (pending) setKnownName(pending.name);
      const snap = await loadSnapshot(cid);
      if (cancelled) return;
      if (snap?.job && isAnalysisJob(snap.job)) {
        baseRef.current = snap.job;
        setBase(snap.job);
        setKnownName(snap.job.query);
        setPhase("ready");
        touchCompany(cid, snap.job);
      }
      // 방금 시작한 작업이 있으면 그것부터 묻는다
      const started = pending?.jobId ?? (await recallJob(cid))?.jobId;
      if (started) {
        poll(started);
        return;
      }
      try {
        const running = await apiOrNull<CompanyJobResponse>(`company/${cid}/job`);
        if (cancelled) return;
        if (running?.jobId) {
          poll(running.jobId);
          return;
        }
        const saved = await apiOrNull<AnalysisJob>(`company/${cid}/analysis`);
        if (cancelled) return;
        if (saved && isAnalysisJob(saved)) {
          if (!baseRef.current || shouldReplace(baseRef.current, saved)) accept(saved);
          if (saved.busy) poll(saved.jobId);
        } else if (!baseRef.current) setPhase("none");
        else if (baseRef.current.busy) poll(baseRef.current.jobId);
      } catch {
        if (!baseRef.current) setPhase("none");
        setConnLost(true);
      }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      stopPoll();
    };
  }, [cid, valid, poll, accept, stopPoll]);

  const start = useCallback(
    async (refresh: boolean): Promise<RunResult> => {
      const b = baseRef.current;
      const p = getPending(cid);
      const name = b?.query ?? p?.name;
      if (!name) return { ok: false, code: "no_name", message: "회사 이름을 알 수 없습니다. 시작 화면에서 회사 이름을 넣어 주세요." };
      try {
        const res = await api<StartAnalysisResponse>("analysis", {
          method: "POST",
          body: { name, crno: b?.company.crno ?? p?.crno ?? null, homepage: p?.homepage ?? null, refresh },
        });
        void rememberJob(cid, res.jobId);
        stopPoll();
        poll(res.jobId);
        return { ok: true };
      } catch (e) {
        return { ok: false, code: e instanceof ApiFail ? e.code : null, message: e instanceof Error ? e.message : "요청하지 못했습니다." };
      }
    },
    [cid, poll, stopPoll],
  );

  const runSection = useCallback(
    async (key: SectionKey, body?: unknown): Promise<RunResult> => {
      const target = liveRef.current ?? baseRef.current;
      if (!target) return { ok: false, code: null, message: "분석이 아직 없습니다." };
      try {
        await api(`analysis/${target.jobId}/sections/${key}`, { method: "POST", body: body ?? {} });
        stopPoll();
        poll(target.jobId);
        return { ok: true };
      } catch (e) {
        if (e instanceof ApiFail && e.code === "section_running") {
          poll(target.jobId);
          return { ok: true };
        }
        return { ok: false, code: e instanceof ApiFail ? e.code : null, message: e instanceof Error ? e.message : "요청하지 못했습니다." };
      }
    },
    [poll, stopPoll],
  );

  const reconnect = useCallback(() => {
    const id = pollRef.current?.jobId ?? liveRef.current?.jobId ?? baseRef.current?.jobId;
    if (!id) return;
    stopPoll();
    setConnLost(false);
    poll(id);
  }, [poll, stopPoll]);

  const view = useMemo(() => overlay(base, live), [base, live]);
  const today = todayKST();
  const value: Ctx = {
    cid, phase, view, job: view?.job ?? null, live, base, local, today, receivedAt, connLost, lostJob, knownName: knownName ?? base?.query ?? null, start, runSection, reconnect,
  };
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

/**
 * 단락이 채워져 위쪽 높이가 바뀌어도 읽던 자리가 밀리지 않게 한다(A-07). 브라우저의 스크롤 고정은 iPad Safari 에 없고,
 * 자리 표시가 통째로 바뀌면 Chrome 도 고정을 놓치므로, 새 응답을 받기 직전에 화면 가운데에 가까운 단락 제목 위치를 적어 두고
 * 그린 뒤 같은 자리로 되돌린다.
 */
let anchor: { id: string; top: number } | null = null;
function rememberAnchor() {
  if (typeof document === "undefined") return;
  const target = window.innerHeight * 0.4;
  let best: { id: string; top: number; d: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>("[data-anchor]")) {
    const top = el.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight) continue;
    const d = Math.abs(top - target);
    if (!best || d < best.d) best = { id: el.id, top, d };
  }
  anchor = best && window.scrollY > 0 ? { id: best.id, top: best.top } : null;
}
export function restoreAnchor() {
  if (!anchor) return;
  const el = document.getElementById(anchor.id);
  if (el) {
    const diff = el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(diff) >= 1) window.scrollBy(0, diff);
  }
  anchor = null;
}

/** 진행 중 단락의 경과 초: 서버가 준 seconds 에 받은 뒤 지난 시간을 더한다 */
export function useTicker(active: boolean, receivedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active && receivedAt ? Math.max(0, (now - receivedAt) / 1000) : 0;
}
