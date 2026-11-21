"use client";

import { useEffect, useState } from "react";

/** 돌아가는 원. 움직임 줄이기를 켠 사용자에게는 멈춘 원으로 보인다. */
export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 rounded-full border-2 border-current/25 border-t-current motion-safe:animate-spin ${className}`} />;
}

/**
 * 오래 걸리는 작업이 진행 중임을 알린다. 경과 시간과 작업 순서를 보여주고,
 * 서버가 현재 단계를 알려주는 작업(회사 조회)에서는 그 단계도 보여준다. 단계를 추측해 표시하지는 않는다.
 */
export function Working({ title, expected, steps, slowAfter, current }: { title: string; expected: string; steps: string[]; slowAfter: number; current?: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-start gap-3 rounded-lg border border-accent/30 bg-card p-3 text-sm" role="status" aria-live="polite">
      <span className="mt-0.5 text-accent">
        <Spinner />
      </span>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 text-xs text-muted">
          <span className="tabular-nums">{seconds}초</span> 지남 · 보통 {expected}
        </p>
        {/* current 는 서버가 실제로 알려준 단계일 때만 넘긴다 */}
        {current && <p className="mt-1 text-xs font-semibold text-accent">지금: {current}</p>}
        <p className="mt-1 text-xs text-muted">{steps.join(" → ")}</p>
        {seconds >= slowAfter && <p className="mt-1 text-xs text-debt">평소보다 오래 걸리고 있습니다. 창을 닫지 말고 조금만 더 기다려 주세요.</p>}
      </div>
    </div>
  );
}
