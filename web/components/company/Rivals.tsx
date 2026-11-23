"use client";

// 경쟁사 분석(screens 4B, 2026-11-23 화면 구조 개편): 회사 분석의 경쟁사 단락(후보 가운데 비교 대상 정하기)과 경쟁사 깊이 비교 결과를 단계 화면으로 옮겨 다시 짰다.
// 용어(2026-11-23 사용자 결정): 경쟁사 후보(분석이 찾은 회사) / 비교 대상(사용자가 비교하기로 한 회사, 최대 MAX_RIVALS 곳) / 포함·제외(후보마다 단추) /
// 경쟁사 직접 추가 / 비교 대상 정하기(펼친 제목)·비교 대상 변경(접힌 줄 단추)
// 새 서버 수집은 없다. 후보는 merged.rivals, 비교 자료는 누를 때만 받는 rivals_deep(유료) 결과다. 점수·순위·종합 판정은 만들지 않는다.
// 배치 둘(screens 4B.0, 2026-11-23 오케스트레이터 검토 반영):
// - 정하기 먼저: 비교 대상이 없거나 비교 자료가 없을 때. 비교 대상 정하기(펼친 채) → 나란히 비교(비교 자료 받기 + 우리 회사 열).
// - 비교 먼저: 비교 대상과 비교 자료가 있을 때. 나란히 비교(머리 아래 "비교 대상 n곳: …" 한 줄을 펼치면 정하기) → 경쟁사별 사업과 최근 변화 → 경쟁사에 투자한 곳.
// 비교 대상이 저장된 비교 자료와 달라도 "바뀌었다" 안내는 띄우지 않는다(사용자 결정 2026-11-23). 표는 저장된 자료의 회사 그대로이고 "비교 자료 다시 받기"로 다시 받는다.
// 배치는 이 화면을 열 때 한 번 정하고 방문 동안 바꾸지 않는다(정하기·받기 중에 덩어리 순서가 바뀌어 화면이 밀리지 않게).
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_ESTIMATES, type AnalysisJob, type RivalDeep, type RivalsDeepResult } from "@/lib/contract";
import { COMPARE_ITEMS, COMPARE_SOURCES, compareColumns, type Cell, type CompareColumn, type CompareItem } from "@/lib/compare";
import { elapsedText, fmtDay, fmtMonthDayTime, fmtTime, shortCompany, todayKST } from "@/lib/format";
import { isExistingInvestor } from "@/lib/finder";
import { addRival, setRivalChoice } from "@/lib/local";
import { userRivalKey } from "@/lib/names";
import { MAX_RIVALS, effectiveRivalChoices, errorSentence, phaseOf, pickedRivals, rivalsCost, visibleRivals, type PickedRival } from "@/lib/view";
import { DetailRow, Disclosure, Placeholder, SourceLine, StatusWord, nb, useMore } from "@/components/kit";
import { FinanceBars, InvestBars, NpsLine, PatentLine, type InvestBar } from "@/components/charts";
import { useCompany, useTicker } from "@/components/company/context";
import { RunningLine } from "@/components/company/Section";
import { RerunDialog } from "@/components/company/Dialogs";
import { usePublicData } from "@/components/funding/Board";

export function RivalsScreen() {
  const c = useCompany();
  const job = c.job;
  const [layout, setLayout] = useState<"pick" | "compare" | null>(null);
  // 회사 분석과 이 브라우저의 비교 대상을 받은 뒤 한 번 정한다(그리는 중 상태 맞추기, 효과 없이)
  if (layout === null && job && c.local.loaded) setLayout(job.sections.rivals_deep.result && pickedRivals(job, c.local.rivalChoices).length > 0 ? "compare" : "pick");
  const head = (
    <>
      <h1 className="text-2xl font-semibold">경쟁사 분석</h1>
      <p className="mt-2 max-w-[680px]">경쟁사 후보 가운데 비교 대상을 정하면, 그 회사들의 재무·고용·투자·특허를 우리 회사와 같은 항목으로 나란히 봅니다.</p>
    </>
  );
  if (!job || !layout) {
    return (
      <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-6 sm:px-6">
        {head}
        {c.phase === "none" && (
          <p className="mt-6 flex flex-wrap items-center gap-x-3">
            아직 분석하지 않은 회사입니다.
            <Link href={`/c/${c.cid}`} className="link">
              회사 분석으로 가기
            </Link>
          </p>
        )}
      </main>
    );
  }
  const result = job.sections.rivals_deep.result;
  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-6 sm:px-6">
      {head}
      {layout === "pick" && <Picker job={job} />}
      <Compare job={job} fold={layout === "compare" ? <PickerFold job={job} /> : null} />
      {result && <RivalNotes job={job} result={result} />}
      {result && <Backers job={job} result={result} />}
      <p className="no-print mt-10 flex max-w-[760px] flex-wrap items-center gap-x-2 border-t border-rule pt-4 text-sm">
        <span>비교 대상 경쟁사는 심사 준비의 &lsquo;경쟁사 조건이라면?&rsquo;에도 씁니다.</span>
        <Link href={`/c/${c.cid}/review`} className="link">
          심사 준비 보기
        </Link>
      </p>
    </main>
  );
}

/** 덩어리 틀: 잉크 1px 윗줄 아래 제목(h2 18px 굵게) → (있으면) 한 줄 요약(21px). 회사 분석 단락 경계와 같은 모양 */
function Block({ id, title, summary, right, children, maxWidth = "760px" }: { id: string; title: string; summary?: ReactNode; right?: ReactNode; children: ReactNode; maxWidth?: string }) {
  return (
    <section id={id} aria-labelledby={`h-${id}`} className="mt-8 border-t border-ink pt-6 sm:pt-8" style={{ maxWidth }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`h-${id}`} className="text-lg font-bold leading-snug">
          {title}
        </h2>
        {right}
      </div>
      {summary && <p className="mt-1 text-xl font-medium">{summary}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Lines = ({ n = 4 }: { n?: number }) => (
  <span className="block space-y-2">
    {Array.from({ length: n }, (_, i) => (
      <Placeholder key={i} h={16} w={i === n - 1 ? "60%" : "100%"} />
    ))}
  </span>
);

// ---------------------------------------------------------------- 비교 대상 정하기(4B.1, 옛 경쟁사 단락)

/** 정하기 먼저 배치: 덩어리 "비교 대상 정하기"(펼친 채) */
function Picker({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const phase = phaseOf(job.sections.profile);
  // "후보 n곳 중 k곳"은 후보에서 포함한 수다. 직접 추가한 회사가 있으면 "중"이 틀리지 않게 나눠 쓴다
  const n = visibleRivals(job).length;
  const picked = pickedRivals(job, c.local.rivalChoices);
  const added = picked.filter((p) => p.key.startsWith("user:")).length;
  const summary = added
    ? `비교 대상 ${picked.length}곳(경쟁사 후보 ${n}곳 중 ${picked.length - added}곳, 직접 추가 ${added}곳)`
    : `경쟁사 후보 ${n}곳 중 비교 대상 ${picked.length}곳`;
  return (
    <Block id="pick" title="비교 대상 정하기" summary={phase === "loading" ? null : summary}>
      <PickerBody job={job} compact={false} />
    </Block>
  );
}

/**
 * 비교 먼저 배치: "나란히 비교" 머리 아래 한 줄 "비교 대상 n곳: …"과 "비교 대상 변경". 펼치면 정하기 본문(compact).
 * 펼친 안에는 더 여는 것을 두지 않는다(0절 깊이 규칙: 이 줄 → 후보 줄 자세히까지)
 */
function PickerFold({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const picked = pickedRivals(job, c.local.rivalChoices);
  const text = picked.length ? `비교 대상 ${picked.length}곳: ${picked.map((p) => p.name).join(", ")}` : "비교 대상 없음";
  return (
    <Disclosure
      text="비교 대상 정하기"
      memoryKey={`${c.cid}:rv:fold`}
      className="mb-3"
      label={<span className="font-medium" data-picked-summary>{text}</span>}
      right={<span className="whitespace-nowrap text-sm font-medium">비교 대상 변경</span>}
    >
      <div className="py-2" data-picker-fold>
        <PickerBody job={job} compact />
      </div>
    </Disclosure>
  );
}

function PickerBody({ job, compact }: { job: AnalysisJob; compact: boolean }) {
  const c = useCompany();
  const env = job.sections.profile;
  const phase = phaseOf(env);
  const tick = useTicker(phase === "loading", c.receivedAt);
  const k = (s: string) => `${c.cid}:ri:${s}`;
  // 처음 비교 대상: 아무것도 정하지 않았고 비교 자료가 있으면 그 자료가 비교한 곳을 포함한 것으로 보인다. 처음 바꿀 때 그것을 먼저 저장한다
  const eff = effectiveRivalChoices(job, c.local.rivalChoices);
  const seed = eff.implicit ? { choices: eff.choices, added: eff.added } : undefined;
  const candidates = visibleRivals(job);
  const shown = candidates.filter((r) => eff.choices[r.key] !== "no");
  const noList = candidates.filter((r) => eff.choices[r.key] === "no");
  const [name, setName] = useState("");
  const pendingFacts = job.merged.pending.includes("rivals.facts");
  const choose = (key: string, v: "yes" | "no" | null) => setRivalChoice(c.cid, key, v, seed);
  // 비교 대상은 최대 MAX_RIVALS 곳(서버 계약 2.4). 다 차면 아직 포함하지 않은 후보의 "포함"과 직접 추가를 막는다(포함한 곳의 "제외"는 된다)
  const full = pickedRivals(job, c.local.rivalChoices).length >= MAX_RIVALS;

  const row = (r: (typeof candidates)[number], memo: string) => (
    <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-start">
      <DetailRow
        className="min-w-0 flex-1"
        memoryKey={memo}
        head={
          <span className="block">
            <span className="font-medium">{r.name}</span>
            {r.nameEn && <span className="ml-2 text-sm text-sub">{r.nameEn}</span>}
            <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
              {r.relation && <span className="text-sub">{r.relation}</span>}
              <StatusWord w={r.status} />
            </span>
            {r.reason && <span className="block truncate text-sm">{r.reason}</span>}
          </span>
        }
      >
        {r.reason && <p>{r.reason}</p>}
        {r.products && <p className="text-sm">제품: {r.products}</p>}
        {r.sources.map((s, i) => (
          <SourceLine key={i} source={s} />
        ))}
      </DetailRow>
      <YesNo name={r.name} value={eff.choices[r.key]} onSet={(v) => choose(r.key, v)} full={full} />
    </div>
  );

  const addForm = (
    <form
      className="flex flex-wrap items-end gap-2 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        if (n.length < 2 || full) return;
        addRival(c.cid, userRivalKey(n), n, seed);
        setName("");
      }}
    >
      <label className="min-w-0 flex-1 text-sm">
        회사 이름
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          disabled={full}
          aria-describedby={full ? `${c.cid}-rival-max` : undefined}
          className="mt-1 block min-h-11 w-full rounded-md border border-edge bg-paper px-3 text-base outline-none focus:border-ledger disabled:bg-wash"
        />
      </label>
      <button type="submit" className="btn" disabled={full}>
        추가
      </button>
    </form>
  );
  // 펼친 줄 안(compact)에서는 후보를 모두 보이고, 제외한 후보·직접 추가도 더 접지 않고 이어서 둔다
  const firstN = compact ? shown.length : 5;

  return (
    <>
      {phase === "loading" ? (
        <div aria-busy="true" className="space-y-3">
          <p className="text-sub">
            회사 분석에서 경쟁사 후보를 찾고 있습니다 <span className="num">({elapsedText((env.seconds ?? 0) + tick)})</span>
          </p>
          <Lines n={4} />
        </div>
      ) : (
        <>
          <p className="text-sm">비교 대상에 포함한 경쟁사는 나란히 비교와 심사 준비의 &lsquo;경쟁사 조건이라면?&rsquo;에 씁니다. 국내 기업만 후보로 보여 줍니다.</p>
          {phase === "unavailable" && (
            <p className="mt-2 flex flex-wrap items-center gap-2">
              <StatusWord w="unavailable" />
              <span>경쟁사 후보를 찾지 못했습니다.</span>
            </p>
          )}
          {(shown.length > 0 || eff.added.length > 0) && (
            <ul className="mt-2 divide-y divide-rule border-y border-rule" data-candidates>
              {shown.slice(0, firstN).map((r) => (
                <li key={r.key}>{row(r, k(r.key))}</li>
              ))}
              {eff.added.map((a) => (
                <li key={a.key} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-2">
                    <span className="font-medium">{a.name}</span>
                    <StatusWord w="edited" />
                  </span>
                  <YesNo name={a.name} value={eff.choices[a.key]} onSet={(v) => choose(a.key, v)} full={full} />
                </li>
              ))}
            </ul>
          )}
          {full && (
            <p id={`${c.cid}-rival-max`} className="mt-2 text-sm font-medium" data-rival-max>
              비교 대상은 최대 {MAX_RIVALS}곳입니다.
            </p>
          )}
          {pendingFacts && <p className="mt-2 text-sm text-sub">후보를 더 찾고 있습니다 (보통 3분 안에 끝남)</p>}
          {compact ? (
            <div className="mt-3 space-y-3">
              {noList.length > 0 && (
                <div>
                  <p className="text-sm font-semibold">제외한 후보 {noList.length}곳</p>
                  <ul className="mt-1 divide-y divide-rule border-y border-rule">
                    {noList.map((r) => (
                      <li key={r.key}>{row(r, k(`n-${r.key}`))}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <p className="text-sm font-semibold">경쟁사 직접 추가</p>
                {addForm}
              </div>
            </div>
          ) : (
          <div className="mt-3">
            {shown.length > 5 && (
              <Disclosure text={`후보 ${shown.length - 5}곳 더 보기`} memoryKey={k("more")}>
                <ul className="divide-y divide-rule">
                  {shown.slice(5).map((r) => (
                    <li key={r.key}>{row(r, k(`m-${r.key}`))}</li>
                  ))}
                </ul>
              </Disclosure>
            )}
            {noList.length > 0 && (
              <Disclosure text={`제외한 후보 ${noList.length}곳`} memoryKey={k("no")}>
                <ul className="divide-y divide-rule">
                  {noList.map((r) => (
                    <li key={r.key}>{row(r, k(`n-${r.key}`))}</li>
                  ))}
                </ul>
              </Disclosure>
            )}
            <Disclosure text="경쟁사 직접 추가" memoryKey={k("add")}>
              {addForm}
            </Disclosure>
          </div>
          )}
        </>
      )}
    </>
  );
}

/** 후보마다 "포함"/"제외"(저장값 yes/no). 비교 대상이 다 찼으면(full) 아직 포함하지 않은 곳의 "포함"을 막는다 */
function YesNo({ name, value, onSet, full = false }: { name: string; value: "yes" | "no" | undefined; onSet: (v: "yes" | "no" | null) => void; full?: boolean }) {
  return (
    // 넓은 화면에서는 세로선으로 줄 자세히(꺾쇠)와 떼어, 누르는 곳 셋이 한 덩어리로 보이지 않게 한다
    <div role="group" aria-label={`${name} 비교 대상`} className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0 sm:self-center sm:border-l sm:border-rule sm:pl-4">
      <button type="button" className={`btn ${value === "yes" ? "btn-pressed" : ""}`} aria-pressed={value === "yes"} disabled={full && value !== "yes"} onClick={() => onSet(value === "yes" ? null : "yes")}>
        포함
      </button>
      <button type="button" className={`btn ${value === "no" ? "btn-pressed" : ""}`} aria-pressed={value === "no"} onClick={() => onSet(value === "no" ? null : "no")}>
        제외
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- 나란히 비교(4B.2)

function Compare({ job, fold }: { job: AnalysisJob; fold: ReactNode }) {
  const c = useCompany();
  const env = job.sections.rivals_deep;
  const result = env.result;
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const picked = pickedRivals(job, c.local.rivalChoices);
  // 비교 대상은 정할 때 MAX_RIVALS 곳에서 막는다. 요청 본문 자르기는 옛 기록(상한 전)에 대한 방어로만 남긴다
  const sent = picked.slice(0, MAX_RIVALS);
  const est = job.estimates?.sections?.rivals_deep ?? DEFAULT_ESTIMATES.sections.rivals_deep;
  const running = env.status === "running" || env.status === "waiting" || env.rerun?.status === "running";
  const cost = rivalsCost(est, picked.length);
  const canRun = !job.isExample && env.retryable && sent.length > 0;
  const cols = useMemo(() => compareColumns(job, c.local.edits), [job, c.local.edits]);
  // 덩어리 폭은 비교 표 폭에 맞춘다(열이 적으면 다른 덩어리처럼 760px, 많으면 화면 폭까지). 머리 오른쪽 "실행" 시각이 표 끝에 온다
  const tableW = `${7.5 + cols.length * 15}em`;
  const run = async () => {
    setErr(null);
    const r = await c.runSection("rivals_deep", { rivals: sent.map((p: PickedRival) => ({ key: p.key, name: p.name, ...(p.nameEn ? { nameEn: p.nameEn } : {}) })) });
    if (!r.ok) setErr(r.message);
    return r;
  };
  const exampleNote = (
    <p className="flex flex-wrap items-center gap-x-3 text-sm">
      <span>예시 회사는 비교 자료를 새로 받을 수 없습니다. 우리 회사 이름을 넣으면 받을 수 있습니다.</span>
      <Link href="/" className="link">
        회사 이름 넣기
      </Link>
    </p>
  );

  return (
    <Block
      id="compare"
      title="나란히 비교"
      maxWidth={`max(760px, calc(${tableW} * 15 / 16))`}
      right={result && env.analyzedAt ? <span className="num text-sm text-sub">{fmtMonthDayTime(env.analyzedAt)} 실행</span> : null}
    >
      {/* 비교 먼저 배치: 머리 바로 아래 비교 대상 한 줄(펼치면 정하기). 그 아래 다시 받기(지금 비교 대상으로, 유료라 누를 때만) */}
      {fold && <div className="max-w-[760px]">{fold}</div>}
      <div className="max-w-[760px] space-y-3">
        {running ? (
          <RunningLine text="비교 자료를 받고 있습니다" env={env} />
        ) : result ? (
          // 저장된 비교 자료가 있으면 표는 그 회사들 그대로. 지금 비교 대상으로 다시 받을 수 있게 단추와 비용만 둔다(안내 띠 없음)
          canRun && (
            <div className="flex flex-wrap items-center gap-3" data-rerun>
              <button type="button" className="btn" onClick={() => setAsk(true)}>
                비교 자료 다시 받기
              </button>
              <span className="text-sm text-sub">{cost.text}</span>
            </div>
          )
        ) : (
          <>
            {env.status === "unavailable" && env.error && <p className="font-medium text-amber">비교 자료를 받지 못했습니다: {errorSentence(env.error)}</p>}
            <p>
              {picked.length
                ? `비교 대상 ${sent.length}곳의 법인, 재무, 국민연금, 투자, 특허, 최근 기사를 받아 아래 표에 채웁니다.`
                : "비교 대상을 정하면 재무, 고용, 투자, 특허를 받아 우리 회사와 나란히 봅니다."}
            </p>
            {!job.isExample && (
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className="btn btn-primary" disabled={!canRun} onClick={() => void run()}>
                  비교 자료 받기
                </button>
                {picked.length > 0 && <span className="text-sm text-sub">{cost.text}</span>}
              </div>
            )}
          </>
        )}
        {/* 다시 받기가 실패하면 지금 표(이전 결과)를 그대로 두고 사유를 쓴다(screens 1.7 단락 새로 받기와 같은 규칙) */}
        {!running && result && env.rerun?.status === "failed" && (
          <p className="text-sm text-sub">
            이 표는 {fmtTime(env.analyzedAt)}에 받은 것입니다. 다시 받기에서는 {errorSentence(env.rerun.error)}
          </p>
        )}
        {job.isExample && exampleNote}
        {err && (
          <p role="alert" className="text-sm font-medium text-amber">
            {err}
          </p>
        )}
      </div>

      <CompareTable cols={cols} />
      {/* 칸마다 상태 낱말과 짧은 출처가 있으므로 기관·자료 이름 전체는 펼쳐 본다. 기준 시각 한 줄은 늘 보인다 */}
      <div className="mt-3 max-w-[760px]">
        <p className="source">
          <span className="text-sub">
            우리 회사 {fmtTime(job.analyzedAt) || "분석 중"} 분석{result ? `, 경쟁사 ${fmtTime(result.queriedAt)} 조회` : ""}. 회사마다 기준 연도가 다를 수 있습니다.
          </span>
        </p>
        <Disclosure text={`항목별 출처 ${COMPARE_SOURCES.length}줄 보기`} memoryKey={`${c.cid}:cmp:sources`} className="mt-2">
          <div className="py-2">
            {COMPARE_SOURCES.map((s, i) => (
              <SourceLine key={s} label={s} detail={null} className={i ? "mt-1 before:hidden" : ""} />
            ))}
          </div>
        </Disclosure>
      </div>
      {result && (
        <div className="max-w-[760px]">
          <Disclosure text="그림으로 보기" memoryKey={`${c.cid}:cmp:charts`}>
            <Charts job={job} rivals={result.rivals} />
          </Disclosure>
        </div>
      )}
      <RerunDialog open={ask} onClose={() => setAsk(false)} title="경쟁사 비교 자료" liner={cost.liner} onConfirm={run} />
    </Block>
  );
}

/**
 * 비교 표. 640px 이상은 표(열 = 회사, 줄 = 항목, 첫 열은 옆으로 밀어도 붙음), 640px 미만은 항목마다 한 덩어리(회사마다 한 줄).
 * 같은 항목끼리 견주는 표의 뜻을 휴대폰에서도 지킨다. 값 크기로 다시 정렬하지 않고, 차이·합계·순위 줄을 두지 않는다.
 */
function CompareTable({ cols }: { cols: CompareColumn[] }) {
  const c = useCompany();
  // 열이 적을 때(받기 전 우리 회사 열 하나 등) 표가 덩어리 폭으로 늘어나 칸이 휑하지 않게, 열 수에 맞춘 최대 폭(항목 열 7.5em + 회사 열 15em씩)
  const maxW = `${7.5 + cols.length * 15}em`;
  // 표 상자 안에서 옆으로 밀리는지(820 폭에 경쟁사 4곳 이상 등). 밀리면 표 아래에 한 줄로 알린다(잘린 열만으로는 더 있다는 것을 놓치기 쉽다)
  const box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setOver(el.scrollWidth - el.clientWidth > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols.length]);
  return (
    <>
      <div className="mt-5 hidden sm:block">
        <div ref={box} role="region" aria-label="비교 표, 옆으로 밀어 볼 수 있습니다" tabIndex={0} className="cmp-scroll overflow-x-auto" data-compare-scroll>
          <table className="cmp num w-full border-t-2 border-ink text-sm" style={{ maxWidth: maxW }} data-compare="table">
            <caption className="sr-only">우리 회사와 비교 대상 경쟁사 나란히 비교</caption>
            <thead>
              <tr className="border-b border-rule bg-wash text-left align-bottom">
                <th scope="col" className="cmp-item py-2 pl-2 pr-3 font-medium text-sub">
                  항목
                </th>
                {cols.map((col) => (
                  <th key={col.key} scope="col" className="cmp-col py-2 pl-3 pr-3 text-base font-bold text-ink">
                    {col.name}
                    {col.mine && <span className="block text-xs font-medium text-sub">우리 회사</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ITEMS.map((it) => (
                <tr key={it.key} className="border-b border-rule align-top" data-item-row={it.key}>
                  <th scope="row" className="cmp-item py-3 pl-2 pr-3 text-left font-semibold">
                    {it.label}
                  </th>
                  {cols.map((col) => (
                    <td key={col.key} className="cmp-col py-3 pl-3 pr-3">
                      <CellView c={col.cells[it.key]} item={it.key} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {over && (
          <p className="mt-1 text-xs text-sub" data-compare-more>
            표를 옆으로 밀면 나머지 경쟁사가 보입니다.
          </p>
        )}
      </div>
      {/* 좁은 화면: 앞 4줄(핵심 값과 같은 항목)만 1층, 뒤 3줄은 펼쳐 본다(쪽 길이를 줄이려고, 오케스트레이터 검토 2026-11-23) */}
      <div className="mt-5 border-t-2 border-ink sm:hidden" data-compare="items">
        {COMPARE_ITEMS.filter((it) => it.core).map((it) => (
          <ItemBlock key={it.key} label={it.label} item={it.key} cols={cols} />
        ))}
        <Disclosure text={`${COMPARE_ITEMS.filter((it) => !it.core).map((it) => it.label).join(", ")} 보기`} memoryKey={`${c.cid}:cmp:items-rest`}>
          {COMPARE_ITEMS.filter((it) => !it.core).map((it) => (
            <ItemBlock key={it.key} label={it.label} item={it.key} cols={cols} />
          ))}
        </Disclosure>
      </div>
    </>
  );
}

/** 좁은 화면의 항목 한 덩어리: 항목 이름 아래 회사마다 한 줄(우리 회사 맨 위) */
function ItemBlock({ label, item, cols }: { label: string; item: CompareItem; cols: CompareColumn[] }) {
  return (
    <div className="border-b border-rule py-3" data-item-block={item}>
      <h3 className="text-base font-semibold">{label}</h3>
      <ul className="mt-1 space-y-1">
        {cols.map((col) => (
          <li key={col.key} className="grid grid-cols-[minmax(0,6.5em)_minmax(0,1fr)] items-start gap-x-3 py-1.5" data-company={col.name}>
            <span className={`text-sm ${col.mine ? "font-bold" : "font-medium"}`}>
              {shortCompany(col.name)}
              {col.mine && <span className="block text-xs font-medium text-sub">우리 회사</span>}
            </span>
            <CellView c={col.cells[item]} item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 칸 하나: 값(16px) → 기준(13px 보조) → 상태 낱말 + 짧은 출처. 미확보는 낱말과 사유, 엇갈림은 두 값 */
function CellView({ c, item }: { c: Cell; item: CompareItem }) {
  if (c.kind === "pending") return <span className="text-sub">확인 중</span>;
  if (c.kind === "missing")
    return (
      <span className="block">
        <StatusWord w="unavailable" />
        <span className="mt-1 block text-sm">{c.reason}</span>
      </span>
    );
  if (c.kind === "conflict")
    return (
      <span className="block">
        <StatusWord w="conflicting" />
        {c.alts.map((a, i) => (
          <span key={i} className="mt-1 block">
            {i > 0 && <span className="text-sub">다른 자료: </span>}
            <span className="font-medium">{nb(a.text)}</span> {a.source && <span className="text-xs text-sub">({a.source})</span>}
          </span>
        ))}
      </span>
    );
  return (
    <span className="block">
      {c.lines.map((l) => (
        <span key={l} className={`block ${item === "investors" ? "text-sm" : "text-base font-semibold"}`}>
          {nb(l)}
        </span>
      ))}
      {c.basis && <span className="block text-xs text-sub">{nb(c.basis)}</span>}
      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <StatusWord w={c.word} />
        {c.source && <span className="text-xs text-sub">{c.source}</span>}
      </span>
    </span>
  );
}

/** 2층 "그림으로 보기": 누적 투자 막대(통화마다 따로)와 특허 연도 선 */
function Charts({ job, rivals }: { job: AnalysisJob; rivals: RivalDeep[] }) {
  const byCur = new Map<string, InvestBar[]>();
  const noAmount: string[] = [];
  const add = (name: string, by: Record<string, number> | undefined, basis: string, mine: boolean) => {
    const e = Object.entries(by ?? {});
    if (!e.length) noAmount.push(name);
    for (const [cur, v] of e) byCur.set(cur, [...(byCur.get(cur) ?? []), { name, amount: v, basis, mine }]);
  };
  const cum = job.sections.funding_history.result?.summary.cumulative;
  add(job.company.name, cum?.byCurrency, cum?.label ?? "", true);
  for (const r of rivals) add(r.name, r.funding?.summary.cumulative.byCurrency, r.funding?.summary.cumulative.label ?? "", false);
  return (
    <div className="space-y-5 py-2">
      <div className="space-y-3">
        <p className="text-sm font-semibold">누적 투자 (통화마다 따로)</p>
        {[...byCur.entries()].map(([cur, bars]) => (
          <figure key={cur} className="max-w-[460px]">
            <figcaption className="text-xs text-sub">{cur}</figcaption>
            <InvestBars currency={cur} bars={bars} />
          </figure>
        ))}
        {noAmount.length > 0 && <p className="text-sm">금액 미확보: {noAmount.join(", ")}</p>}
      </div>
      <div>
        <p className="text-sm font-semibold">출원연도별 국내 특허</p>
        <div className="max-w-[460px]">
          <PatentLine
            endYear={Number(todayKST().slice(0, 4))}
            series={[{ name: job.company.name, byYear: job.sections.patents.result?.summary.byYear ?? {}, mine: true }, ...rivals.map((r) => ({ name: r.name, byYear: r.patents?.byYear ?? {}, mine: false }))]}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 경쟁사별 사업과 최근 변화(4B.3)

function RivalNotes({ job, result }: { job: AnalysisJob; result: RivalsDeepResult }) {
  const c = useCompany();
  const relation = new Map(job.merged.rivals.map((r) => [r.key, r.relation]));
  return (
    <Block id="notes" title="경쟁사별 사업과 최근 변화">
      <div data-rival-notes>
        {result.rivals.map((r) => {
          const s = r.summary;
          const n = s?.recentChanges.length ?? 0;
          const rel = relation.get(r.key);
          return (
            <Disclosure
              key={r.key}
              text={`${r.name} 자세히`}
              memoryKey={`${c.cid}:rn:${r.key}`}
              label={
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="font-semibold">{r.name}</span>
                  {rel && <span className="text-sm text-sub">{rel}</span>}
                  {n > 0 && <span className="text-sm text-sub">최근 변화 {Math.min(5, n)}줄</span>}
                </span>
              }
            >
              <div className="space-y-3 py-2">
                {s ? (
                  <>
                    <div>
                      <p className="text-sm font-semibold">사업</p>
                      <p>{s.business ?? "미확보: 사업 설명을 받지 못했습니다."}</p>
                    </div>
                    {s.productsTech && (
                      <div>
                        <p className="text-sm font-semibold">제품·기술</p>
                        <p>{s.productsTech}</p>
                      </div>
                    )}
                    {n > 0 && (
                      <div>
                        <p className="text-sm font-semibold">최근 변화</p>
                        <ul className="list-disc space-y-0.5 pl-5">
                          {s.recentChanges.slice(0, 5).map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <SourceLine word="inferred" label="경쟁사 기사를 모델이 정리 (NAVER 뉴스 검색, Liner 검색)" detail={`${fmtDay(result.queriedAt)} 조회`} />
                  </>
                ) : (
                  <p className="flex flex-wrap items-center gap-2">
                    <StatusWord w="unavailable" />
                    사업 요약을 받지 못했습니다.
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {r.financials.length > 0 ? (
                    <FinanceBars small rows={r.financials.map((f) => ({ year: f.year, revenue: f.revenue, operatingIncome: f.operatingIncome }))} label={`${r.name} 매출과 영업이익`} />
                  ) : (
                    <p className="text-sm">미확보: {r.financialsReason ?? "재무 자료 없음"}</p>
                  )}
                  {r.nps ? <NpsLine small points={r.nps.monthly} /> : <p className="text-sm">미확보: {r.npsReason ?? "국민연금 자료 없음"}</p>}
                </div>
                {r.funding && r.funding.rounds.length > 0 && (
                  <div>
                    <p className="text-sm font-semibold">최근 라운드</p>
                    <ul className="text-sm">
                      {r.funding.rounds.slice(0, 3).map((x) => (
                        <li key={x.id} className="num">
                          {x.date ?? x.reportedDate ?? "날짜 미상"} {x.round ?? ""} {x.amount ?? "미공개"}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.errors.length > 0 && <p className="text-sm">미확보 사유: {r.errors.join(" ")}</p>}
              </div>
            </Disclosure>
          );
        })}
      </div>
    </Block>
  );
}

// ---------------------------------------------------------------- 경쟁사에 투자한 곳(4B.4)

function Backers({ job, result }: { job: AnalysisJob; result: RivalsDeepResult }) {
  const c = useCompany();
  const { data } = usePublicData();
  const gps = useMemo(() => [...new Set((data?.funds ?? []).map((f) => f.gp))], [data]);
  // 우리 회사 투자기관(원문 확인·보도만, 자금 조달 "이미 투자함"과 같은 기준)
  const ours = job.merged.investors.filter((i) => i.status === "confirmed" || i.status === "reported").flatMap((i) => [i.name, ...i.aliases]);
  return (
    <Block id="backers" title="경쟁사에 투자한 곳">
      <p className="flex flex-wrap items-center gap-x-2">
        <span>비교 대상 경쟁사의 투자 라운드 자료에 나온 투자기관입니다. 자금 조달 투자받는 돈에서 이름이 같은 모태펀드 운용사에 &lsquo;경쟁사에 투자&rsquo;를 붙입니다.</span>
        <Link href={`/c/${c.cid}/funding?lane=invest`} className="link">
          투자받는 돈에서 보기
        </Link>
      </p>
      <p className="mt-1 text-sm text-sub">새로 찾아볼 운용사 목록이 아닙니다. 직접 경쟁사에 투자한 곳은 이해충돌로 투자를 피할 수 있습니다.</p>
      {result.rivalInvestors.length ? (
        <div className="mt-3 space-y-4" data-backers>
          {result.rivalInvestors.map((r) => (
            <BackerGroup key={r.rivalKey} name={r.rivalName} investors={r.investors} isGp={(n) => gps.some((gp) => isExistingInvestor(gp, [n]))} isOurs={(n) => isExistingInvestor(n, ours)} />
          ))}
        </div>
      ) : (
        <p className="mt-3">비교 대상 경쟁사의 투자 라운드 자료에서 투자기관을 찾지 못했습니다.</p>
      )}
      <SourceLine word="reported" label="People Data Labs (Liner Premium) 투자 라운드" detail={`${fmtDay(result.queriedAt)} 조회`} />
    </Block>
  );
}

function BackerGroup({ name, investors, isGp, isOurs }: { name: string; investors: string[]; isGp: (n: string) => boolean; isOurs: (n: string) => boolean }) {
  const mr = useMore(investors.length, 5, investors.length);
  return (
    <div data-backer={name}>
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-semibold">{name}</span>
        <span className="num text-sm text-sub">투자기관 {investors.length}곳</span>
      </p>
      {/* 누르는 것이 아니라 이름 목록이라 한 줄에 이어 둔다(44px 줄로 세우면 좁은 화면에서 쪽이 길어진다) */}
      <ul id={mr.listId} className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
        {investors.slice(0, mr.count).map((n, i) => (
          <li key={n} data-item={i} className="inline-flex flex-wrap items-center gap-x-2">
            <span>{n}</span>
            {isGp(n) && <span className="tag">모태펀드 운용사</span>}
            {isOurs(n) && <span className="tag">이미 투자함</span>}
          </li>
        ))}
      </ul>
      {mr.left > 0 && (
        <button type="button" className="btn mt-2 w-full font-medium" onClick={mr.more}>
          투자기관 {investors.length}곳 모두 보기
        </button>
      )}
    </div>
  );
}
