"use client";

// 회사 분석 단락 틀(screens 1.5): 머리(이름, 상태, 단락 메뉴) → 한 줄 요약 또는 진행 문구 → 1층 → 바닥(묶음 출처 줄, 이어지는 곳).
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { SectionEnvelope, SectionKey } from "@/lib/contract";
import { elapsedText, fmtMonthDayTime, fmtTime } from "@/lib/format";
import { errorSentence, isSlow, phaseOf, retryState, type ScreenKey } from "@/lib/view";
import { StatusWord, nb } from "@/components/kit";
import { useCompany, useTicker } from "@/components/company/context";
import { SectionDialog } from "@/components/company/Dialogs";

type AnyEnv = SectionEnvelope<unknown>;

export function SectionFrame({
  id, label, env, envKey, summary, children, footer, menu, partialNote = true, unavailableBody, twoLineSummary = false,
}: {
  id: ScreenKey;
  label: string;
  env: AnyEnv;
  envKey: SectionKey;
  summary: string | null;
  children: ReactNode;
  footer?: ReactNode;
  menu?: ReactNode;
  partialNote?: boolean;
  /** 미확보일 때 사유 문장 아래 더 보일 것(웹 조사 매출 등) */
  unavailableBody?: ReactNode;
  /** 넓은 화면에서 한 줄 요약 자리를 진행 중·끝난 뒤 모두 두 줄로 잡고 두 줄로 자른다(개요: facts 가 오며 업종 글이 길어져도 아래가 밀리지 않게) */
  twoLineSummary?: boolean;
}) {
  const summaryBox = twoLineSummary ? "md:min-h-[2lh]" : "";
  const c = useCompany();
  const phase = phaseOf(env);
  const refreshing = c.view?.refreshing.has(envKey) || env.rerun?.status === "running";
  const liveEnv = c.live?.sections[envKey];
  const ticking = phase === "loading" || Boolean(refreshing);
  const tick = useTicker(ticking, c.receivedAt);
  const rerunSecs = env.rerun?.status === "running" ? (env.rerun.seconds ?? 0) : refreshing && liveEnv ? (liveEnv.seconds ?? 0) : 0;
  const kept = c.view?.kept.get(envKey);
  const job = c.job!;
  const fresh = env.analyzedAt && job.analyzedAt && env.analyzedAt > job.analyzedAt && phase !== "loading";

  return (
    // 단락 경계는 잉크색 1px 머리줄과 넉넉한 위 여백으로, 단락 안의 펼치기 줄·목록 선(회색 1px)과 구분한다.
    // 단락 이름은 18px 굵게(이정표), 바로 아래 한 줄 요약은 21px(첫인상). 굵은 2px 선은 핵심 값 띠에만 쓴다
    <section id={id} aria-labelledby={`h-${id}`} aria-busy={phase === "loading" || undefined} className="anchor border-t border-ink pb-10 pt-6 sm:pt-8">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={`h-${id}`} data-anchor tabIndex={-1} className="flex flex-wrap items-center gap-2 text-lg font-bold leading-snug">
            {label}
            {phase === "unavailable" && <StatusWord w="unavailable" />}
          </h2>
        </div>
        {menu && <div className="no-print flex flex-wrap items-center gap-2">{menu}</div>}
      </div>

      {phase === "loading" ? (
        <div className="mt-1">
          {/* 끝나면 이 자리에 한 줄 요약이 온다. "보통 n초"를 같은 줄에 두어 높이를 요약 한 줄과 같게 한다(도착할 때 아래가 밀리지 않게) */}
          <p className={`text-xl text-sub ${summaryBox}`}>
            확인 중 <span className="num">({elapsedText((env.seconds ?? 0) + tick)})</span>
            {env.expectedSeconds ? <span className="ml-2 text-sm">보통 {elapsedText(env.expectedSeconds)} 안에 끝납니다</span> : null}
          </p>
          {isSlow(env, tick) && <p className="text-sm font-medium text-amber">평소보다 오래 걸립니다. 다른 단락을 먼저 보셔도 됩니다.</p>}
        </div>
      ) : phase === "unavailable" ? (
        <UnavailableHead env={env} envKey={envKey} label={label} />
      ) : (
        <div className="mt-1">
          {twoLineSummary ? (
            <p className={`text-xl font-medium md:line-clamp-2 ${summaryBox}`}>{summary ? nb(summary) : ""}</p>
          ) : (
            summary && <p className="text-xl font-medium">{nb(summary)}</p>
          )}
          {phase === "partial" && partialNote && env.error && <p className="mt-1 text-sm font-medium text-amber">일부 자료를 얻지 못했습니다: {errorSentence(env.error)}</p>}
          {refreshing && (
            <p className="mt-1 text-sm text-sub">
              새로 확인 중 <span className="num">({elapsedText(rerunSecs + tick)})</span>
            </p>
          )}
        </div>
      )}

      <div className="mt-4">{phase === "unavailable" ? unavailableBody : children}</div>

      {(footer || kept || env.rerun?.status === "failed" || fresh) && (
        <div className="mt-4 space-y-2">
          {footer}
          {kept && (
            <p className="text-sm text-sub">
              이 단락은 {fmtTime(kept.at)} 분석 결과입니다. 새 분석에서는 {kept.reason}
            </p>
          )}
          {env.rerun?.status === "failed" && (
            <p className="text-sm text-sub">
              이 단락은 {fmtTime(env.analyzedAt)} 분석 결과입니다. 새 분석에서는 {errorSentence(env.rerun.error)}
            </p>
          )}
          {fresh && <p className="num text-sm text-sub">{fmtMonthDayTime(env.analyzedAt)}에 새로 받음</p>}
        </div>
      )}
    </section>
  );
}

/** 미확보 머리: 사유 문장 + 행동(법인 다시 고르기, 이 단락 다시 분석) */
function UnavailableHead({ env, envKey, label }: { env: AnyEnv; envKey: SectionKey; label: string }) {
  const c = useCompany();
  const [open, setOpen] = useState(false);
  const r = retryState(env);
  const job = c.job!;
  return (
    <div className="mt-2 space-y-3" id={env.error?.code === "interrupted" ? "first-stopped" : undefined}>
      <p className="max-w-[680px] text-lg">{errorSentence(env.error)}</p>
      <div className="no-print flex flex-wrap items-center gap-2">
        {env.error?.code === "no_corp" && (
          <Link href={`/?name=${encodeURIComponent(job.query)}`} className="btn">
            법인 다시 고르기
          </Link>
        )}
        {r.kind === "show" && !job.isExample && (
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            이 단락 다시 분석
          </button>
        )}
        {r.kind === "disabled" && (
          <>
            <button type="button" className="btn" disabled>
              이 단락 다시 분석
            </button>
            <span className="text-sm text-sub">{r.note}</span>
          </>
        )}
      </div>
      <SectionDialog open={open} onClose={() => setOpen(false)} sectionKey={envKey} label={label} />
    </div>
  );
}

/** 단락 바닥의 이어지는 곳 한 줄 */
export function NextLine({ text, href, linkText }: { text: string; href: string; linkText: string }) {
  return (
    <p className="no-print flex flex-wrap items-center gap-x-2 text-sm">
      <span>{text}</span>
      <Link href={href} className="link">
        {linkText}
      </Link>
    </p>
  );
}

/** 열 때 실행 블록의 진행 글. 화면 읽기 알림에는 바뀌지 않는 글만 두고, 매초 바뀌는 경과 초는 알림 영역 밖에 둔다 */
export function RunningLine({ text, env }: { text: string; env: AnyEnv }) {
  const c = useCompany();
  const tick = useTicker(true, c.receivedAt);
  const secs = env.rerun?.status === "running" ? env.rerun.seconds ?? 0 : env.seconds ?? 0;
  return (
    <p className="text-base text-sub">
      <span role="status">{text}</span> <span className="num">({elapsedText(secs + tick)})</span>
    </p>
  );
}
