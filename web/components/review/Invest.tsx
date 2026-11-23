"use client";

// 심사 준비 > 투자(screens 6.2): 담은 운용사(운용사 요약) → 미팅 근거 묶음 → 투자 미팅 예상 질문 → 실사 대비 자료.
// 예상 질문·실사 대비 자료는 고정 목록(lib/prep.ts, anthropics/financial-services 를 다시 쓴 것)이고 판정·합계가 없다.
import Link from "next/link";
import { useRef, useState } from "react";
import type { AnalysisJob, GpBrief } from "@/lib/contract";
import { ApiFail, api } from "@/lib/api";
import { noticeCompany } from "@/lib/company-values";
import { elapsedText, fmtTime, isStale, stageKo, todayKST } from "@/lib/format";
import { rivalBackers } from "@/lib/funding";
import { putBrief, setPrep, toggleSaved, type SavedItem } from "@/lib/local";
import { DD_GROUPS, DD_ITEMS, QUESTIONS, QUESTION_GROUPS, groupCounts, relatedHref, type PrepContext, type Related } from "@/lib/prep";
import { pickedRivals } from "@/lib/view";
import { evidenceFinance, evidenceFunding, evidenceNews, evidencePatents, openValues } from "@/lib/review";
import { runTask } from "@/lib/tasks";
import { useTask } from "@/lib/useTask";
import { DetailRow, Disclosure, ExtLink, SourceLine, StatusWord, useNow } from "@/components/kit";
import { FinanceBars, NpsLine, PatentLine } from "@/components/charts";
import { useCompany } from "@/components/company/context";
import { ConflictLines, Quote } from "@/components/company/values";

const LIMIT_TEXT = "오늘 호출 상한에 닿아 요약하지 못했습니다. 내일 0시 이후에 다시 할 수 있습니다.";

export function Invest() {
  const c = useCompany();
  const gps = c.local.saved.filter((s) => s.kind === "gp");
  return (
    <div className="space-y-10">
      <section aria-labelledby="gp-h">
        <h2 id="gp-h" className="text-base font-bold">
          담은 운용사
        </h2>
        {gps.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-rule p-5">
            <p>담은 운용사가 없습니다. 자금·판로에서 운용사를 담으면 여기서 요약을 볼 수 있습니다.</p>
            <Link href={`/c/${c.cid}/funding?lane=invest`} className="btn mt-3">
              운용사 고르기
            </Link>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {gps.map((g) => (
              <li key={g.itemId}>
                <GpReviewCard item={g} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {c.job && <Evidence job={c.job} />}
      {c.job && <Questions job={c.job} />}
      {c.job && <DueDiligence job={c.job} />}
    </div>
  );
}

// ---------------------------------------------------------------- 운용사 요약


function GpReviewCard({ item }: { item: SavedItem }) {
  const c = useCompany();
  const job = c.job;
  const gp = item.itemId;
  const tkey = `brief:${c.cid}:${gp}`;
  const task = useTask<GpBrief>(tkey);
  const rec = c.local.briefs[gp];
  const loading = task.status === "loading";
  const now = useNow(loading);
  const secs = loading && task.startedAt ? Math.max(0, (now - task.startedAt) / 1000) : 0;
  const limit = task.status === "error" && task.error === LIMIT_TEXT;
  const existing = Boolean(item.meta.existing);
  const rivals = rivalBackers(job?.sections.rivals_deep.result)(gp);
  const searchUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(`${gp} 투자 문의`)}`;
  const run = () => {
    if (!job) return;
    const company = noticeCompany(job, c.local.edits);
    runTask<GpBrief>(tkey, async () => {
      try {
        const result = await api<GpBrief>("gp/brief", { method: "POST", body: { gp, company } });
        putBrief(c.cid, { gp, result, error: null, ranAt: new Date().toISOString(), company });
        return result;
      } catch (e) {
        if (e instanceof ApiFail && e.code === "daily_limit") throw new Error(LIMIT_TEXT);
        throw e;
      }
    });
  };
  const b = rec?.result ?? null;
  const fact = (kind: string) => b?.facts.find((f) => f.kind === kind)?.text ?? null;
  const web = (
    <ExtLink href={searchUrl} className="btn">
      웹에서 찾기
    </ExtLink>
  );

  return (
    <article className="card p-4" data-gp-review={gp}>
      {existing && <p className="mb-2 text-sm font-medium">이미 투자한 곳입니다. 후속 투자나 소개를 부탁할 때 쓰세요.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{gp}</h3>
        {existing && <span className="tag">이미 투자함</span>}
        {rivals.length > 0 && <span className="tag">경쟁사에 투자</span>}
      </div>
      <p className="num text-sm text-sub">
        펀드 {String(item.meta.funds ?? "")}개, 최근 결성 {String(item.meta.latestYear ?? "")}년
      </p>
      <div className="mt-3">
        {loading ? (
          // 화면 읽기 알림에는 바뀌지 않는 글만, 매초 바뀌는 경과 초는 알림 영역 밖에
          <p className="text-sub">
            <span role="status">{gp} 자료를 검색하고 있습니다</span> <span className="num">({elapsedText(secs)})</span>
          </p>
        ) : b ? (
          b.facts.length === 0 ? (
            <div className="space-y-2">
              <p>검색 결과 {b.searched}건에서 이 운용사에 대해 확인되는 내용을 찾지 못했습니다.</p>
              {web}
            </div>
          ) : (
            <div className="space-y-3">
              <dl className="grid grid-cols-[5.5em_1fr] gap-x-3 gap-y-1">
                <dt className="text-sub">투자 분야</dt>
                <dd>{fact("투자 분야") ?? "미확보"}</dd>
                <dt className="text-sub">투자 단계</dt>
                <dd>{fact("투자 단계") ?? "미확보"}</dd>
              </dl>
              {b.fit.length > 0 && (
                <div>
                  <p className="text-sm font-semibold">맞닿는 점</p>
                  <ul className="list-disc pl-5">
                    {b.fit.slice(0, 2).map((f, i) => (
                      <li key={i}>{f.text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {b.questions.length > 0 && (
                <div>
                  <p className="text-sm font-semibold">물어볼 것</p>
                  <ul className="list-disc pl-5">
                    {b.questions.slice(0, 2).map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Disclosure text={`근거 ${b.facts.length}개와 검색 결과 보기`} memoryKey={`${c.cid}:gp:${gp}`}>
                <ul className="space-y-3 py-2">
                  {b.facts.map((f, i) => (
                    <li key={i}>
                      <p>
                        <span className="mr-2 text-sm text-sub">{f.kind}</span>
                        {f.text}
                      </p>
                      <Quote text={f.quote} />
                      <ExtLink href={f.sourceUrl} className="link text-sm">
                        {f.sourceHost || "출처"}
                      </ExtLink>
                    </li>
                  ))}
                  {b.fit.slice(2).map((f, i) => (
                    <li key={`f${i}`}>맞닿는 점: {f.text}</li>
                  ))}
                  {b.questions.slice(2).map((q) => (
                    <li key={q}>물어볼 것: {q}</li>
                  ))}
                </ul>
                <p className="text-sm font-semibold">검색 결과 {b.sources.length}건</p>
                <ul className="divide-y divide-rule text-sm">
                  {b.sources.map((s) => (
                    <li key={s.url} className="flex flex-wrap items-center justify-between gap-2 py-1">
                      <span>
                        {s.title} <span className="text-sub">{s.host}</span>
                      </span>
                      <ExtLink href={s.url} className="link text-sm">
                        원문 열기
                      </ExtLink>
                    </li>
                  ))}
                </ul>
              </Disclosure>
              <p className="text-sm text-sub">검색 결과의 제목과 발췌에서 그대로 확인되는 내용만 적었습니다. 원문 전체를 읽은 것은 아닙니다.</p>
            </div>
          )
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" onClick={run} disabled={!job || limit}>
              운용사 요약
            </button>
            <span className="text-sm text-sub">보통 10~20초</span>
            {web}
          </div>
        )}
        {task.status === "error" && <p className="mt-2 text-sm font-medium text-amber">{limit ? LIMIT_TEXT : `요약하지 못했습니다: ${task.error}`}</p>}
      </div>
      <div className="no-print mt-3 flex flex-wrap gap-2 border-t border-rule pt-3">
        {b && (
          <>
            <button type="button" className="btn" onClick={run} disabled={loading || limit}>
              다시 요약
            </button>
            {web}
          </>
        )}
        <button type="button" className="btn btn-quiet ml-auto" onClick={() => toggleSaved(c.cid, { kind: "gp", itemId: gp, title: gp, meta: item.meta })}>
          담은 운용사에서 빼기
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- 미팅 근거 묶음

function EvidenceBody({ job, which }: { job: AnalysisJob; which: "finance" | "funding" | "patents" | "news" | "open" }) {
  const s = job.sections;
  if (which === "finance") {
    const f = s.official.result?.financials ?? [];
    const nps = s.official.result?.nps;
    return (
      <div className="grid gap-6 py-2 md:grid-cols-2">
        {f.length > 0 ? (
          <div>
            <FinanceBars rows={f.map((x) => ({ year: x.year, revenue: x.revenue, operatingIncome: x.operatingIncome }))} />
            <SourceLine word="confirmed" label="금융위원회 요약재무제표 (공공 API)" detail={`${f[0].year}~${f[f.length - 1].year} 사업연도, ${f[f.length - 1].basisShort ?? f[f.length - 1].basis}`} />
          </div>
        ) : (
          <p>미확보: {s.official.result?.financialsReason ?? "공식 재무 자료 없음"}</p>
        )}
        {nps ? (
          <div>
            <NpsLine points={nps.monthly} />
            <SourceLine word="reference" label="국민연금공단 사업장 가입자 (공공 API)" detail={nps.summary?.period ?? ""} />
          </div>
        ) : (
          <p>미확보: {s.official.result?.npsReason ?? "국민연금 사업장을 찾지 못함"}</p>
        )}
      </div>
    );
  }
  if (which === "funding") {
    const r = s.funding_history.result;
    if (!r || !r.rounds.length) return <p className="py-2">미확보: 투자 라운드 자료를 찾지 못했습니다</p>;
    return (
      <div className="py-2">
        <table className="num w-full border-t-2 border-ink text-sm">
          <thead>
            <tr className="border-b border-rule bg-wash text-left text-sub">
              {["날짜", "단계", "금액", "투자기관 수"].map((h) => (
                <th key={h} scope="col" className="px-2 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.rounds.slice(0, 5).map((x) => (
              <tr key={x.id} className="border-b border-rule">
                <td className="px-2 py-1.5">{x.date ?? (x.reportedDate ? `보도 ${x.reportedDate}` : "날짜 미상")}</td>
                <td className="px-2">{stageKo(x.round)}</td>
                <td className="px-2">{x.amount ?? "미공개"}</td>
                <td className="px-2">{x.investors.length}곳</td>
              </tr>
            ))}
          </tbody>
        </table>
        <SourceLine word="reported" label="People Data Labs 회사 카드 (Liner Premium)" detail={`${r.queriedAt.slice(0, 10)} 조회`} />
      </div>
    );
  }
  if (which === "patents") {
    const r = s.patents.result;
    if (!r || !r.summary.total) return <p className="py-2">미확보: 출원인이 이 회사로 확인된 국내 특허를 찾지 못했습니다</p>;
    return (
      <div className="py-2" data-ev="patents">
        <div className="max-w-[420px]">
          <PatentLine series={[{ name: job.company.name, byYear: r.summary.byYear, mine: true }]} endYear={Number(todayKST().slice(0, 4))} />
        </div>
        <ul className="mt-2 text-sm">
          {r.patents.slice(0, 5).map((p) => (
            <li key={p.id} className="num">
              {p.title} <span className="text-sub">출원 {p.filingDate ?? "미상"}</span>
            </li>
          ))}
        </ul>
        <SourceLine word="confirmed" label="특허 공개 원문 (Google Patents)" detail={`${r.queriedAt.slice(0, 10)} 조회, 출원인이 이 회사인 국내 특허만`} />
      </div>
    );
  }
  if (which === "news") {
    const ev = s.news.result?.events ?? [];
    if (!ev.length) return <p className="py-2">미확보: 최근 12개월 중요 사건을 찾지 못했습니다</p>;
    return (
      <ul className="divide-y divide-rule py-2 text-sm">
        {ev.slice(0, 5).map((e, i) => (
          <li key={i} className="py-1.5">
            <span className="num text-sub">{e.date ?? "날짜 미상"}</span> <span className="text-sub">{e.category}</span> {e.title} <span className="text-sub">({e.outlet ?? "매체 미상"})</span>
          </li>
        ))}
      </ul>
    );
  }
  const open = openValues(job);
  if (!open.length) return <p className="py-2">자료끼리 다른 값과 비어 있는 값이 없습니다.</p>;
  return (
    <ul className="divide-y divide-rule py-2" data-open-values>
      {open.map((o) => (
        <li key={o.label} className="py-2">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{o.label}</span>
            <StatusWord w={o.value.status} />
          </p>
          {o.kind === "conflict" ? <ConflictLines v={o.value} /> : <p>미확보: {o.value.reason}</p>}
          <p className="text-sm text-sub">투자자가 물을 수 있습니다</p>
        </li>
      ))}
    </ul>
  );
}

const BLOCKS = [
  { key: "finance", title: "재무·고용 추이", line: evidenceFinance },
  { key: "funding", title: "투자 이력", line: evidenceFunding },
  { key: "patents", title: "특허", line: evidencePatents },
  { key: "news", title: "최근 성과", line: evidenceNews },
] as const;

function Evidence({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const open = openValues(job);
  const conflicts = open.filter((o) => o.kind === "conflict").length;
  const missing = open.length - conflicts;
  const printing = useRef(false);
  const print = () => {
    printing.current = true;
    document.body.dataset.print = "evidence";
    const done = () => {
      delete document.body.dataset.print;
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  };
  const stale = job.analyzedAt && isStale(job.analyzedAt);
  const head = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="evidence-h" className="text-xl font-semibold">
            미팅 근거 묶음
          </h2>
          <p>투자 미팅에 가져갈 근거를 회사 분석 결과에서 모았습니다. 새로 조회하지 않습니다.</p>
          <p className="num text-sm text-sub">
            회사 분석 {job.analyzedAt ? fmtTime(job.analyzedAt) : "진행 중"} 기준{stale ? ", 오래된 분석" : ""}
          </p>
        </div>
        <button type="button" className="btn no-print" onClick={print}>
          미팅 근거 묶음 인쇄
        </button>
      </div>
    </>
  );
  const lines = [...BLOCKS.map((b) => ({ key: b.key, title: b.title, line: b.line(job) })), {
    key: "open" as const, title: "미팅 전에 정리할 값", line: { pending: job.status === "running", text: job.status === "running" ? "회사 분석에서 확인 중" : `자료끼리 다른 값 ${conflicts}개, 비어 있는 값 ${missing}개` },
  }];
  return (
    <section id="evidence" aria-labelledby="evidence-h" className="anchor evidence-print border-t border-rule pt-6">
      {head}
      <div className="no-print mt-3" data-evidence>
        {lines.map((b) => (
          <Disclosure
            key={b.key}
            text={b.title}
            memoryKey={`${c.cid}:ev:${b.key}`}
            label={
              <span className="block">
                <span className="block font-semibold">{b.title}</span>
                <span className={`block text-sm ${b.line.pending ? "text-sub" : ""}`}>{b.line.text}</span>
              </span>
            }
          >
            <EvidenceBody job={job} which={b.key} />
          </Disclosure>
        ))}
      </div>
      {/* 인쇄 모양: 다섯 덩어리를 모두 펼친 채 A4 한 장 */}
      <div className="print-only">
        {lines.map((b) => (
          <div key={b.key} className="mt-3 break-inside-avoid">
            <p className="font-semibold">{b.title}</p>
            <p className="text-sm">{b.line.text}</p>
            <EvidenceBody job={job} which={b.key} />
          </div>
        ))}
        <p className="mt-3 text-xs">점수나 선정 확률은 만들지 않습니다. 값마다 확인 상태와 출처를 붙입니다.</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 예상 질문, 실사 대비 자료

function RelatedList({ items }: { items: Related[] }) {
  const c = useCompany();
  return (
    // 링크가 든 줄과 글만 있는 줄의 높이를 같게(.link-fit). 줄 높이 44px 이상이라 이웃 줄의 누르는 영역과 겹치지 않는다
    <ul>
      {items.map((r) => (
        <li key={r.text} className="py-2.5">
          {r.to ? (
            <Link href={relatedHref(c.cid, r.to)} className="link link-fit">
              {r.text}
            </Link>
          ) : (
            <span>{r.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function prepCtx(c: ReturnType<typeof useCompany>, job: AnalysisJob): PrepContext {
  // 비교 대상 경쟁사 수는 경쟁사 분석 화면과 같은 셈(처음 비교 대상 포함, screens 4B.1)
  const confirmedRivals = pickedRivals(job, c.local.rivalChoices).length;
  return { job, confirmedRivals, deepDone: Boolean(job.sections.rivals_deep.result), papersDone: Boolean(job.sections.papers.result) };
}

function ReadyButton({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`btn shrink-0 ${on ? "btn-pressed" : ""}`} aria-pressed={on} aria-label={`준비함: ${label}`} onClick={onClick}>
      준비함
    </button>
  );
}

function Questions({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const ctx = prepCtx(c, job);
  const q = c.local.prep.questions;
  return (
    <section aria-labelledby="q-h" className="border-t border-rule pt-6">
      <h2 id="q-h" className="text-xl font-semibold">
        투자 미팅 예상 질문 {QUESTIONS.length}개
      </h2>
      <p>투자자가 흔히 묻는 질문입니다. 답을 준비했으면 &lsquo;준비함&rsquo;을 눌러 두세요. 이 브라우저에만 저장됩니다.</p>
      <div className="mt-3" data-questions>
        {groupCounts(QUESTIONS, QUESTION_GROUPS).map((g) => (
          <Disclosure key={g.group} text={`${g.group} ${g.items.length}`} openText={`${g.group} ${g.items.length}`} memoryKey={`${c.cid}:q:${g.group}`}>
            <ul className="divide-y divide-rule">
              {g.items.map((item) => {
                const st = q[item.id] ?? { ready: false, memo: "" };
                const rel = item.related(ctx);
                return (
                  <li key={item.id} className="flex items-start gap-2 py-1" data-question={item.id}>
                    <DetailRow className="min-w-0 flex-1" head={<span>{item.text}</span>}>
                      <p className="text-sm font-semibold">분석에 있는 관련 자료</p>
                      {rel.length ? <RelatedList items={rel} /> : <p className="text-sm">공개 자료로는 준비할 수 없는 질문입니다. 회사 내부 자료로 준비하세요.</p>}
                      <label className="mt-3 block text-sm font-semibold">
                        메모
                        <MemoBox
                          value={st.memo}
                          onSave={(memo) => setPrep(c.cid, (p) => ({ ...p, questions: { ...p.questions, [item.id]: { ready: p.questions[item.id]?.ready ?? false, memo } } }))}
                        />
                      </label>
                    </DetailRow>
                    <ReadyButton
                      on={st.ready}
                      label={item.text}
                      onClick={() => setPrep(c.cid, (p) => ({ ...p, questions: { ...p.questions, [item.id]: { memo: p.questions[item.id]?.memo ?? "", ready: !st.ready } } }))}
                    />
                  </li>
                );
              })}
            </ul>
          </Disclosure>
        ))}
      </div>
    </section>
  );
}

function MemoBox({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <textarea
      rows={3}
      value={v}
      maxLength={1000}
      onChange={(e) => {
        setV(e.target.value);
        if (timer.current) clearTimeout(timer.current);
        const next = e.target.value;
        timer.current = setTimeout(() => onSave(next), 600);
      }}
      onBlur={() => onSave(v)}
      className="mt-1 block w-full rounded-md border border-edge bg-paper p-2 text-base font-normal outline-none focus:border-ledger"
    />
  );
}

function DueDiligence({ job }: { job: AnalysisJob }) {
  const c = useCompany();
  const ctx = prepCtx(c, job);
  const dd = c.local.prep.dd;
  return (
    <section aria-labelledby="dd-h" className="border-t border-rule pt-6">
      <h2 id="dd-h" className="text-xl font-semibold">
        실사 대비 자료 {DD_ITEMS.length}개
      </h2>
      <p>투자 심사에서 흔히 요청하는 자료입니다. 회사 분석에 관련 자료가 있으면 함께 적었습니다.</p>
      <div className="mt-3" data-dd>
        {groupCounts(DD_ITEMS, DD_GROUPS).map((g) => (
          <Disclosure key={g.group} text={`${g.group} ${g.items.length}`} openText={`${g.group} ${g.items.length}`} memoryKey={`${c.cid}:dd:${g.group}`}>
            <ul className="divide-y divide-rule">
              {g.items.map((item) => {
                const rel = item.related(ctx);
                return (
                  <li key={item.id} className="flex items-start justify-between gap-3 py-2.5" data-dd-item={item.id}>
                    <div className="min-w-0">
                      <p>{item.text}</p>
                      {rel.map((r) =>
                        r.to ? (
                          <p key={r.text} className="mt-1 text-sm">
                            <Link href={relatedHref(c.cid, r.to)} className="link link-fit">
                              분석에 있음: {r.text}
                            </Link>
                          </p>
                        ) : (
                          <p key={r.text} className="mt-1 text-sm text-sub">
                            분석에 있음: {r.text}
                          </p>
                        ),
                      )}
                    </div>
                    <ReadyButton on={Boolean(dd[item.id])} label={item.text} onClick={() => setPrep(c.cid, (p) => ({ ...p, dd: { ...p.dd, [item.id]: !p.dd[item.id] } }))} />
                  </li>
                );
              })}
            </ul>
          </Disclosure>
        ))}
      </div>
    </section>
  );
}
