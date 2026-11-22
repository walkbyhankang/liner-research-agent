"use client";

// 새로 분석 확인 창, 단락만 새로 받기, 열 때 실행 다시 실행(screens 1.7). 유료 호출은 여기서 "확인"을 눌렀을 때만 보낸다.
import { useState } from "react";
import { DEFAULT_ESTIMATES, type SectionKey } from "@/lib/contract";
import { elapsedText, fmtTime } from "@/lib/format";
import { Dialog } from "@/components/kit";
import { useCompany, type RunResult } from "@/components/company/context";

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<RunResult>, onDone: () => void) => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.message);
  };
  return { busy, error, run, reset: () => setError(null) };
}

export function RefreshDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { job, start } = useCompany();
  const { busy, error, run, reset } = useRun();
  if (!job) return null;
  const est = job.estimates?.full ?? DEFAULT_ESTIMATES.full;
  const left = job.refresh?.remainingToday;
  const spent = left === 0;
  const close = () => {
    reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      title="새로 분석할까요?"
      onClose={close}
      actions={
        <>
          <button type="button" className="btn" data-autofocus onClick={close}>
            {spent ? "닫기" : "취소"}
          </button>
          <button type="button" className="btn btn-primary" disabled={spent || busy} onClick={() => run(() => start(true), close)}>
            {busy ? "요청하는 중" : "새로 분석"}
          </button>
        </>
      }
    >
      <ul className="list-disc space-y-1.5 pl-5">
        <li>{spent ? "이 회사는 오늘 새로 분석할 수 있는 횟수를 다 썼습니다. 내일 다시 시도하세요." : `${job.company.name} 분석을 처음부터 다시 합니다.`}</li>
        <li>걸리는 시간: {est.seconds ? `${elapsedText(est.seconds)} 안팎` : "실측 전"} (공식 자료는 10초 안에 먼저 보입니다)</li>
        <li>Liner 호출: 약 {est.liner}회 (검색, 모델 같은 유료 호출)</li>
        <li>지금 분석({fmtTime(job.analyzedAt)})은 지우지 않고 남깁니다.</li>
        <li>고친 값, 담은 항목, 노트는 그대로 둡니다.</li>
        {typeof left === "number" && left > 0 && <li>이 회사는 오늘 {left}번 더 새로 분석할 수 있습니다.</li>}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-amber">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** 단락만 새로(뉴스, 미확보로 끝난 단락) */
export function SectionDialog({ open, onClose, sectionKey, label, news = false }: { open: boolean; onClose: () => void; sectionKey: SectionKey; label: string; news?: boolean }) {
  const { job, runSection } = useCompany();
  const { busy, error, run, reset } = useRun();
  if (!job) return null;
  const est = job.estimates?.sections?.[sectionKey] ?? DEFAULT_ESTIMATES.sections[sectionKey];
  const close = () => {
    reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={news ? "뉴스만 새로 받을까요?" : `${label}만 새로 받을까요?`}
      onClose={close}
      actions={
        <>
          <button type="button" className="btn" data-autofocus onClick={close}>
            취소
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => runSection(sectionKey), close)}>
            {news ? "뉴스 새로 받기" : `${label} 새로 받기`}
          </button>
        </>
      }
    >
      <ul className="list-disc space-y-1.5 pl-5">
        {est.seconds ? <li>걸리는 시간: {elapsedText(est.seconds)} 안팎</li> : null}
        <li>Liner 호출: 약 {est.liner}회</li>
        <li>다른 단락은 그대로 둡니다.</li>
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-amber">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** 열 때 실행 블록 다시 실행 */
export function RerunDialog({ open, onClose, title, liner, onConfirm }: { open: boolean; onClose: () => void; title: string; liner: number; onConfirm: () => Promise<RunResult> }) {
  const { busy, error, run, reset } = useRun();
  const close = () => {
    reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={`${title} 다시 실행`}
      onClose={close}
      actions={
        <>
          <button type="button" className="btn" data-autofocus onClick={close}>
            취소
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(onConfirm, close)}>
            다시 실행
          </button>
        </>
      }
    >
      <p>Liner 약 {liner}회를 다시 씁니다. 지금 결과는 새 결과로 바뀝니다.</p>
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-amber">
          {error}
        </p>
      )}
    </Dialog>
  );
}
