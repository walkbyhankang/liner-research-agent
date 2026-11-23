"use client";

// 심사 준비 > 정책자금·지원사업(screens 6.1): 부족한 요건, 대조에 쓰는 회사 값, 담은 공고 카드(공고문 자격 대조).
// 대조는 유료라 단추를 눌렀을 때만 한다. 결과는 브라우저에 저장하고 회사 값이 바뀌어도 지우지 않는다(R-12).
import Link from "next/link";
import { useState } from "react";
import type { NoticeAnalysis, NoticeCompany, Verdict } from "@/lib/contract";
import { ApiFail, api } from "@/lib/api";
import { EDIT_LABEL, filledCount, noticeCompany, rivalNoticeCompany } from "@/lib/company-values";
import { dday, shortDate, type Program } from "@/lib/finder";
import { putCheck, putRivalCheck, removeNotice, rivalCheckOf, savedNotices, type CheckRecord, type SavedItem } from "@/lib/local";
import { gaps, sortRows, verdictCounts } from "@/lib/review";
import { pickedRivals } from "@/lib/view";
import { runTask } from "@/lib/tasks";
import { useTask } from "@/lib/useTask";
import { elapsedText } from "@/lib/format";
import { DetailRow, Disclosure, ExtLink, StatusWord, VerdictMark, useNow } from "@/components/kit";
import { useCompany } from "@/components/company/context";
import { useShell } from "@/components/company/Shell";
import { Quote } from "@/components/company/values";
import { DueText, usePublicData, useToday } from "@/components/funding/Board";

const LIMIT_TEXT = "오늘 호출 상한에 닿아 대조하지 못했습니다. 내일 0시 이후에 다시 대조할 수 있습니다.";

/** 조건 분야 → 대조에 쓴 회사 값 칸 */
function fieldKey(field: string): keyof NoticeCompany | null {
  if (/지역|소재/.test(field)) return "region";
  if (/업력|설립/.test(field)) return "founded";
  if (/업종|업태/.test(field)) return "industry";
  if (/규모|직원|인원|근로자/.test(field)) return "employees";
  if (/매출|실적/.test(field)) return "revenue";
  if (/자금|용도/.test(field)) return "need";
  if (/유형|대상/.test(field)) return "biz";
  return null;
}
const companyLabel: Record<keyof NoticeCompany, string> = {
  name: "회사 이름", region: EDIT_LABEL.region, biz: EDIT_LABEL.bizType, founded: EDIT_LABEL.founded, industry: EDIT_LABEL.industry, employees: EDIT_LABEL.employees,
  revenue: EDIT_LABEL.revenue, need: EDIT_LABEL.need, notes: EDIT_LABEL.notes,
};

function UsedValue({ field, company }: { field: string; company: NoticeCompany }) {
  const k = fieldKey(field);
  if (!k) return <p className="text-sm">대조에 쓴 회사 값: 이 조건에 맞는 회사 값 칸이 없습니다.</p>;
  return (
    <p className="text-sm">
      <span className="text-sub">대조에 쓴 회사 값: </span>
      {companyLabel[k]} {company[k] ? company[k] : "비어 있음"}
    </p>
  );
}

export type SavedProgram = { item: SavedItem; program: Program | null };

export function Grants() {
  const c = useCompany();
  const job = c.job;
  const { openEdit } = useShell();
  const { data } = usePublicData();
  const items: SavedProgram[] = savedNotices(c.local.saved) // 두 화면에서 담은 같은 공고는 하나로
    .map((item) => ({ item, program: data?.programs.find((p) => p.id === item.itemId) ?? null }));
  const end = (x: SavedProgram) => x.program?.period.end ?? (typeof x.item.meta.end === "string" ? x.item.meta.end : "9999-12-31");
  items.sort((a, b) => end(a).localeCompare(end(b)));
  const done = items.map((x) => ({ x, rec: c.local.checks[x.item.itemId] })).filter((y) => y.rec?.result);
  const g = gaps(done.map((y) => ({ programId: y.x.item.itemId, programTitle: y.x.item.title, result: y.rec!.result! })));
  const filled = job ? filledCount(job, c.local.edits) : 0;
  const company = job ? noticeCompany(job, c.local.edits) : null;

  return (
    <div className="space-y-6">
      <p className="text-lg">
        담은 공고 {items.length}건, 자격 대조 {done.length}건 완료.
      </p>

      {done.length > 0 && (
        <div>
          <h2 className="text-base font-bold">부족한 요건</h2>
          <p>
            미충족 {g.unmet}개, 확인 필요 {g.check}개 (대조한 공고 {g.checked}건)
          </p>
          {g.unmet + g.check > 0 && (
            <Disclosure text={`부족한 요건 ${g.unmet + g.check}개 보기`} memoryKey={`${c.cid}:rv:gaps`} className="mt-2">
              <div className="space-y-4 py-2">
                {g.groups.map((grp) => (
                  <div key={grp.field} data-gap-group={grp.field}>
                    <p className="text-sm font-semibold">{grp.field}</p>
                    <ul className="divide-y divide-rule">
                      {grp.items.map((it, i) => (
                        <li key={i}>
                          <DetailRow
                            head={
                              <span className="block">
                                <span className="flex flex-wrap items-center gap-2">
                                  <VerdictMark v={it.verdict} />
                                  <span className="clamp-2">{it.requirement}</span>
                                </span>
                                <span className="block text-xs text-sub">{it.programTitle}</span>
                              </span>
                            }
                          >
                            <Quote text={it.quote} />
                            {it.reason && <p className="mt-1 text-sm">판단 이유: {it.reason}</p>}
                            {c.local.checks[it.programId] && <UsedValue field={grp.field} company={c.local.checks[it.programId].company} />}
                          </DetailRow>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Disclosure>
          )}
        </div>
      )}

      {job && company && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              대조에 쓰는 회사 값 <span className="num">{filled}/8</span>개 채움
            </p>
            <button type="button" className="btn" onClick={(e) => openEdit(e.currentTarget)}>
              회사 정보 수정
            </button>
          </div>
          {filled < 3 && <p className="text-sm text-amber">회사 값이 비어 있으면 대부분 &lsquo;확인 필요&rsquo;로 나옵니다.</p>}
          {job.status === "running" && <p className="text-sm text-sub">회사 분석이 끝나지 않아 일부 값이 비어 있습니다</p>}
          <Disclosure text="회사 값 보기" memoryKey={`${c.cid}:rv:values`} className="mt-2">
            <dl className="divide-y divide-rule text-sm">
              {(["region", "biz", "founded", "industry", "employees", "revenue", "need"] as const).map((k) => (
                <div key={k} className="grid grid-cols-[7em_1fr] gap-3 py-2">
                  <dt className="text-sub">{companyLabel[k]}</dt>
                  <dd>{company[k] || "비어 있음"}</dd>
                </div>
              ))}
              <div className="grid grid-cols-[7em_1fr] gap-3 py-2">
                <dt className="text-sub">그 밖의 사항</dt>
                <dd>{c.local.edits.notes?.value || "비어 있음"}</dd>
              </div>
            </dl>
            <p className="mt-2 text-sm font-semibold">함께 보내는 값</p>
            <ul className="text-sm">
              {typeof job.merged.patentCount?.raw === "number" && (
                <li className="flex flex-wrap items-center gap-2">
                  확인된 특허 {job.merged.patentCount.raw}건 <StatusWord w="confirmed" />
                </li>
              )}
              {typeof job.merged.npsLatest?.raw === "number" && (
                <li className="flex flex-wrap items-center gap-2">
                  국민연금 가입자 {job.merged.npsLatest.raw}명 <StatusWord w="reference" /> 직원 수와 다름
                </li>
              )}
            </ul>
          </Disclosure>
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-rule p-5">
          <p>아직 담은 공고가 없습니다. 자금·판로에서 공고나 판로 지원사업을 담으면 여기서 공고문과 자격을 대조합니다.</p>
          <Link href={`/c/${c.cid}/funding`} className="btn btn-primary mt-3">
            자금·판로에서 고르기
          </Link>
        </div>
      ) : (
        <ul className="space-y-3" aria-label="담은 공고">
          {items.map((x) => (
            <li key={x.item.itemId}>
              <NoticeCard x={x} company={company} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 공고 카드

const taskKey = (cid: string, programId: string) => `notice:${cid}:${programId}`;

export function runNoticeCheck(cid: string, programId: string, company: NoticeCompany) {
  return runTask<NoticeAnalysis>(taskKey(cid, programId), async () => {
    try {
      const result = await api<NoticeAnalysis>("notice/analyze", { method: "POST", body: { programId, company } });
      putCheck(cid, { programId, result, error: null, ranAt: new Date().toISOString(), company });
      return result;
    } catch (e) {
      if (e instanceof ApiFail && e.code === "daily_limit") throw new Error(LIMIT_TEXT);
      throw e;
    }
  });
}


function NoticeCard({ x, company }: { x: SavedProgram; company: NoticeCompany | null }) {
  const c = useCompany();
  const today = useToday();
  const id = x.item.itemId;
  const task = useTask<NoticeAnalysis>(taskKey(c.cid, id));
  const rec: CheckRecord | undefined = c.local.checks[id];
  const [open, setOpen] = useState(false);
  const loading = task.status === "loading";
  const now = useNow(loading);
  const secs = loading && task.startedAt ? Math.max(0, (now - task.startedAt) / 1000) : 0;
  const stale = Boolean(rec?.result && company && JSON.stringify(rec.company) !== JSON.stringify(company));
  const limit = task.status === "error" && task.error === LIMIT_TEXT;
  const run = () => company && runNoticeCheck(c.cid, id, company);
  const p = x.program;
  const endDay = p?.period.end ?? (typeof x.item.meta.end === "string" ? x.item.meta.end : null);
  const d = endDay && today ? dday(endDay, today) : null;
  const url = p?.url ?? (typeof x.item.meta.url === "string" ? x.item.meta.url : null);
  const result = rec?.result ?? null;
  const counts = result ? verdictCounts(result) : null;

  return (
    <article className="card p-4" data-notice={id}>
      {/* 목록 줄(screens 1.12): 오른쪽 끝에 기한. 휴대폰에서는 기한을 제목 위 한 줄 끝으로 올려 제목이 전체 폭을 쓰게 한다 */}
      <div className="lrow">
        <div className="lrow-meta">{x.item.kind === "salesProgram" && <span className="meta">판로 지원사업</span>}</div>
        <DueText text={endDay ? (d !== null && d >= 0 ? `D-${d}, ${shortDate(endDay)} 마감` : `${shortDate(endDay)} 마감`) : "신청기간 미기재"} />
        <h3 className="lrow-main clamp-2 text-lg font-semibold leading-snug">{x.item.title}</h3>
      </div>

      {/* 화면 읽기 알림: 시작·끝·실패처럼 뜻 있는 변화만. 보이는 진행 글의 경과 초는 알림 영역 밖에 두어 매초 읽지 않게 한다 */}
      <p className="sr-only" role="status">
        {loading ? "공고문을 읽고 있습니다" : task.status === "error" ? "대조하지 못했습니다" : result && counts ? `대조가 끝났습니다. ${result.match.overall}, 충족 ${counts.met}, 미충족 ${counts.unmet}, 확인 필요 ${counts.check}` : ""}
      </p>
      <div className="mt-3">
        {loading ? (
          <p className="text-sub">
            공고문을 읽고 있습니다 <span className="num">({elapsedText(secs)})</span>
          </p>
        ) : result && counts ? (
          <div className="space-y-2">
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold">{result.match.overall}</span>
              <VerdictMark v="충족" count={counts.met} />
              <VerdictMark v="미충족" count={counts.unmet} />
              <VerdictMark v="확인 필요" count={counts.check} />
            </p>
            {stale && (
              <p className="flex flex-wrap items-center gap-2 text-sm text-amber">
                이전 회사 값으로 한 대조입니다
                <button type="button" className="btn" onClick={run}>
                  다시 대조
                </button>
              </p>
            )}
            {task.status === "error" && <p className="text-sm font-medium text-amber">{limit ? LIMIT_TEXT : `대조하지 못했습니다: ${task.error}`}</p>}
          </div>
        ) : task.status === "error" ? (
          <div className="space-y-2">
            <p className="font-medium text-amber">{limit ? LIMIT_TEXT : `대조하지 못했습니다: ${task.error}`}</p>
            <button type="button" className="btn" onClick={run} disabled={limit || !company}>
              {limit ? "공고문으로 자격 대조" : "다시 대조"}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" onClick={run} disabled={!company}>
              공고문으로 자격 대조
            </button>
            <span className="text-sm text-sub">보통 30~50초</span>
          </div>
        )}
      </div>

      <div className="no-print mt-3 flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        {result && (
          <button type="button" className="btn btn-quiet -ml-2.5" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "접기" : "자세히"}
          </button>
        )}
        <span className="ml-auto flex gap-2">
          <ExtLink href={url} className="btn">
            공고 원문
          </ExtLink>
        </span>
      </div>

      {result && (
        <div className={open ? "mt-3 space-y-4" : "hidden"}>
          <NoticeDetail cid={c.cid} programId={id} result={result} rec={rec!} onRerun={run} url={url} onRemove={() => removeNotice(c.cid, id)} />
        </div>
      )}
    </article>
  );
}

const VERDICTS: Verdict[] = ["미충족", "확인 필요", "충족"];

function NoticeDetail({ cid, programId, result, rec, onRerun, url, onRemove }: { cid: string; programId: string; result: NoticeAnalysis; rec: CheckRecord; onRerun: () => void; url: string | null; onRemove: () => Promise<boolean> }) {
  const [removeFailed, setRemoveFailed] = useState(false);
  const rows = sortRows(result.match.rows);
  const judged = rows.filter((r) => VERDICTS.includes(r.verdict));
  const others = rows.filter((r) => r.verdict === "판단 대상 아님");
  const ex = result.extraction;
  return (
    <>
      <div>
        <p className="font-semibold">{result.match.overall}</p>
        <p className="text-sm">{result.match.overallReason}</p>
      </div>
      <ul className="divide-y divide-rule border-y border-rule" data-rows>
        {judged.map((r, i) => (
          <li key={i} className={r.verdict === "충족" ? "text-sub" : ""}>
            <DetailRow
              head={
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <VerdictMark v={r.verdict} />
                  <span className="text-sm text-sub">{r.field}</span>
                  <span className="clamp-2 min-w-0 basis-full sm:basis-auto">{r.requirement}</span>
                </span>
              }
            >
              <Quote text={r.quote} />
              {r.reason && <p className="mt-1 text-sm">판단 이유: {r.reason}</p>}
              <UsedValue field={r.field} company={rec.company} />
            </DetailRow>
          </li>
        ))}
      </ul>
      {result.match.questions.length > 0 && (
        <div>
          <p className="font-semibold">기관에 물어볼 것</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            {result.match.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </div>
      )}
      <div className="divide-y divide-rule border-y border-rule">
        {result.match.documents.length > 0 && (
          <DetailRow head={<span>준비 자료 {result.match.documents.length}개</span>}>
            <ul className="list-disc pl-5">
              {result.match.documents.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </DetailRow>
        )}
        {others.length > 0 && (
          <DetailRow head={<span>신청 방법·제출 서류 등 {others.length}건</span>}>
            <ul className="space-y-2">
              {others.map((r, i) => (
                <li key={i}>
                  <span className="text-sm text-sub">{r.field} </span>
                  {r.requirement}
                  <Quote text={r.quote} />
                </li>
              ))}
            </ul>
          </DetailRow>
        )}
        <DetailRow head={<span>경쟁사 조건이라면?</span>}>
          <RivalCheck cid={cid} programId={programId} mine={result} company={rec.company} />
        </DetailRow>
      </div>
      <p className="text-sm text-sub">
        근거 문장이 공고문({ex.doc.kind.toUpperCase()}
        {ex.doc.pages ? ` ${ex.doc.pages}쪽` : ""})에 그대로 있는 조건만 표시했습니다
        {ex.dropped > 0 ? `. 근거를 확인하지 못한 ${ex.dropped}건은 뺐습니다` : ""}
        {ex.doc.truncated ? ". 공고문이 길어 앞부분만 읽었습니다" : ""}
        {ex.notStated.length > 0 ? `. 공고문에 없는 항목: ${ex.notStated.join(", ")}` : ""}. 모델이 읽은 결과이므로 신청 전 공고문을 직접 확인하세요.
      </p>
      {/* 호출이 드는 "다시 대조"는 걸리는 시간과 묶어 왼쪽에, 링크·빼기는 오른쪽에 떼어 둔다 */}
      <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn" onClick={onRerun}>
            다시 대조
          </button>
          <span className="text-sm text-sub">보통 30~50초</span>
        </span>
        <span className="flex flex-wrap gap-2 sm:ml-auto">
          <ExtLink href={url} className="btn">
            공고 원문
          </ExtLink>
          <button type="button" className="btn btn-quiet" onClick={() => void onRemove().then((ok) => setRemoveFailed(!ok))}>
            담은 공고에서 빼기
          </button>
        </span>
      </div>
      {removeFailed && (
        <p role="alert" className="text-sm font-medium text-amber">
          브라우저에 저장된 목록에서 빼지 못했습니다. 다시 눌러 주세요.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 경쟁사 조건이라면?

const rowKey = (r: { field: string; quote: string }) => `${r.field}|${r.quote}`;

function RivalCheck({ cid, programId, mine, company }: { cid: string; programId: string; mine: NoticeAnalysis; company: NoticeCompany }) {
  const c = useCompany();
  const job = c.job;
  // 경쟁사 분석 화면의 비교 대상과 같은 목록(처음 비교 대상 포함, screens 4B.1·D-05)
  const rivals = pickedRivals(job, c.local.rivalChoices);
  const [pick, setPick] = useState(rivals[0]?.key ?? "");
  const key = rivals.some((r) => r.key === pick) ? pick : rivals[0]?.key ?? "";
  const tkey = `rival:${cid}:${programId}:${key}`;
  const task = useTask<NoticeAnalysis>(tkey);
  const rec = key ? rivalCheckOf(c.local, programId, key) : null;
  if (!rivals.length) {
    return (
      <div className="space-y-2">
        <p>경쟁사 분석에서 비교 대상을 정하면 쓸 수 있습니다.</p>
        <Link href={`/c/${cid}/rivals`} className="link">
          비교 대상 정하러 가기
        </Link>
      </div>
    );
  }
  const rival = rivals.find((r) => r.key === key)!;
  const run = () => {
    if (!job) return;
    const rc = rivalNoticeCompany(key, job, company) ?? { ...company, name: rival.name, founded: "", industry: "", employees: "", revenue: "", notes: "" };
    runTask<NoticeAnalysis>(tkey, async () => {
      const result = await api<NoticeAnalysis>("notice/analyze", { method: "POST", body: { programId, company: rc } });
      putRivalCheck(cid, { programId, rivalKey: key, result, error: null, ranAt: new Date().toISOString(), company: rc });
      return result;
    });
  };
  const theirs = new Map((rec?.result?.match.rows ?? []).map((r) => [rowKey(r), r]));
  const pairs = mine.match.rows.filter((r) => r.verdict !== "판단 대상 아님").map((r) => ({ mine: r, theirs: theirs.get(rowKey(r)) }));
  const gained = pairs.filter((p) => p.theirs?.verdict === "충족" && p.mine.verdict !== "충족");
  const lost = pairs.filter((p) => p.mine.verdict === "충족" && p.theirs?.verdict === "미충족");
  const unknown = pairs.filter((p) => p.mine.verdict === "충족" && p.theirs && p.theirs.verdict !== "충족" && p.theirs.verdict !== "미충족");

  return (
    <div className="space-y-3">
      <p className="text-sm">우리 회사의 지역·기업 유형·필요 자금은 그대로 두고, 나머지만 경쟁사 값으로 바꿔 같은 공고를 대조합니다.</p>
      {!job?.sections.rivals_deep.result && <p className="text-sm">경쟁사 분석에서 비교 자료를 받으면 경쟁사 값이 채워져 결과가 구체적이 됩니다.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">
          <span className="sr-only">경쟁사</span>
          <select value={key} onChange={(e) => setPick(e.target.value)} className="min-h-11 rounded-md border border-edge bg-paper px-2 text-base">
            {rivals.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" disabled={task.status === "loading"} onClick={run}>
          이 경쟁사 조건으로 대조
        </button>
        <span className="text-sm text-sub">보통 20~30초</span>
      </div>
      {task.status === "loading" && <p className="text-sub">{rival.name} 조건으로 대조하고 있습니다</p>}
      {task.status === "error" && <p className="text-sm font-medium text-amber">대조하지 못했습니다: {task.error}</p>}
      {rec?.result && (
        <div className="space-y-2 text-sm">
          <p>
            <span className="font-semibold">
              {rival.name} 조건의 종합 문구: {rec.result.match.overall}
            </span>{" "}
            <span>(우리 회사: {mine.match.overall})</span>
          </p>
          {gained.length > 0 ? (
            <div>
              <p className="font-semibold">경쟁사 조건이면 충족되는 조건 {gained.length}건 (갖추면 열리는 요건)</p>
              <ul className="mt-1 space-y-1">
                {gained.map((p) => (
                  <li key={rowKey(p.mine)}>
                    <span className="text-sub">{p.mine.field} </span>
                    {p.mine.requirement}
                    <span className="block text-xs text-sub">
                      우리 회사 {p.mine.verdict}, 경쟁사 충족{p.theirs?.reason ? `. ${p.theirs.reason}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>경쟁사 조건으로 바꿔도 새로 충족되는 조건이 없습니다. 공개된 경쟁사 정보가 적으면 차이가 드러나지 않습니다.</p>
          )}
          {lost.length > 0 && <p>반대로 우리 회사는 충족하지만 경쟁사 조건으로는 충족하지 못하는 조건이 {lost.length}건 있습니다.</p>}
          {unknown.length > 0 && <p>우리 회사는 충족하지만 경쟁사는 공개 정보가 없어 판단하지 못한 조건이 {unknown.length}건 있습니다. 경쟁사가 못 미친다는 뜻은 아닙니다.</p>}
          <p className="text-sub">경쟁사의 인증, 체납·대출 여부처럼 공개 자료에서 확인하지 못한 값은 &lsquo;확인 필요&rsquo;로 남습니다. 경쟁사가 이 자금을 실제로 받았다는 뜻이 아닙니다.</p>
        </div>
      )}
    </div>
  );
}
