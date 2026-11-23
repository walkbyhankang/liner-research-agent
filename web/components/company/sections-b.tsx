"use client";

// 회사 분석 단락: 최근 동향(4.4), 기술(4.5, 논문 열 때 실행 포함). 경쟁사는 2026-11-23부터 경쟁사 분석 화면(components/company/Rivals.tsx, screens 4B).
import { useEffect, useState, useSyncExternalStore } from "react";
import { DEFAULT_ESTIMATES, type AnalysisJob, type Article, type NewsCategory, type NewsPage, type Paper } from "@/lib/contract";
import { api } from "@/lib/api";
import { elapsedText, fmtDay, fmtMonthDayTime, num, todayKST } from "@/lib/format";
import { PATENT_LABEL, PATENT_SCOPE, phaseOf, retryState, summaryLine } from "@/lib/view";
import { DetailRow, Disclosure, ExtLink, MoreButton, Placeholder, SourceLine, StatusWord, useMore } from "@/components/kit";
import { PatentLine } from "@/components/charts";
import { useCompany } from "@/components/company/context";
import { NextLine, RunningLine, SectionFrame } from "@/components/company/Section";
import { RerunDialog, SectionDialog } from "@/components/company/Dialogs";

const Lines = ({ n = 3 }: { n?: number }) => (
  <span className="block space-y-2">
    {Array.from({ length: n }, (_, i) => (
      <Placeholder key={i} h={16} w={i === n - 1 ? "60%" : "100%"} />
    ))}
  </span>
);

// ---------------------------------------------------------------- 기사 나눠 받기(계약 2.5)

type Pages = { items: Article[]; total: number; counts: { category: NewsCategory; count: number }[]; loading: boolean; error: string | null };
const pageCache = new Map<string, Pages>();
const pageListeners = new Set<() => void>();
const setPages = (key: string, p: Pages) => {
  pageCache.set(key, p);
  pageListeners.forEach((l) => l());
};

/**
 * 기사 목록 캐시 열쇠: 작업 id, 뉴스 단락 결과의 판(analyzedAt), 고른 분류. 같은 작업에서 뉴스만 새로 받으면 판이 바뀌어
 * 옛 쪽·분류 건수를 다시 쓰거나 더 보기에서 옛 기사와 새 기사가 섞이지 않는다.
 */
const newsKey = (jobId: string, version: string, cats: readonly NewsCategory[]) => `${jobId}@${version}|${cats.join(",")}`;

async function fetchPage(jobId: string, version: string, cats: NewsCategory[], offset: number) {
  const key = newsKey(jobId, version, cats);
  // 같은 작업의 옛 판 기사 목록은 버린다
  for (const k of [...pageCache.keys()]) if (k.startsWith(`${jobId}@`) && !k.startsWith(`${jobId}@${version}|`)) pageCache.delete(k);
  const cur = pageCache.get(key);
  if (cur?.loading) return;
  setPages(key, { items: cur?.items ?? [], total: cur?.total ?? 0, counts: cur?.counts ?? [], loading: true, error: null });
  const q = new URLSearchParams({ offset: String(offset), limit: "20" });
  for (const cat of cats) q.append("category", cat);
  try {
    const page = await api<NewsPage>(`analysis/${jobId}/news?${q.toString()}`);
    const prev = pageCache.get(key)?.items ?? [];
    setPages(key, { items: [...prev.slice(0, offset), ...page.items], total: page.total, counts: page.categoryCounts, loading: false, error: null });
  } catch (e) {
    setPages(key, { items: cur?.items ?? [], total: cur?.total ?? 0, counts: cur?.counts ?? [], loading: false, error: e instanceof Error ? e.message : "기사 목록을 받지 못했습니다." });
  }
}

function newsJobId(c: ReturnType<typeof useCompany>) {
  const live = c.live;
  return live && c.job && c.job.sections.news === live.sections.news ? live.jobId : c.job!.jobId;
}

/** 기사 목록(2층). 처음 펼칠 때 서버에서 받고, 받은 쪽은 이번 방문 동안 다시 묻지 않는다(NE-02) */
export function NewsList({ fixed }: { fixed?: NewsCategory[] }) {
  const c = useCompany();
  const jobId = newsJobId(c);
  const version = c.job!.sections.news.analyzedAt ?? "";
  const [cats, setCats] = useState<NewsCategory[]>(fixed ?? []);
  const key = newsKey(jobId, version, cats);
  const pages = useSyncExternalStore(
    (cb) => {
      pageListeners.add(cb);
      return () => void pageListeners.delete(cb);
    },
    () => pageCache.get(key),
    () => undefined,
  );
  useEffect(() => {
    if (!pageCache.has(key)) void fetchPage(jobId, version, cats, 0);
  }, [key, jobId, version, cats]);
  const all = c.job!.sections.news.result;
  const counts = (pageCache.get(newsKey(jobId, version, []))?.counts ?? all?.categoryCounts ?? []).filter((x) => x.count > 0);
  const items = pages?.items ?? [];
  const total = pages?.total ?? 0;
  const mr = useMore(Math.max(total, items.length), 20, 20, items.length);
  const resetMore = mr.reset;
  useEffect(() => resetMore(), [key, resetMore]); // 분류를 바꾸거나 뉴스를 새로 받으면 첫 쪽부터 보인다
  const toggle = (cat: NewsCategory) => setCats((cs) => (cs.includes(cat) ? cs.filter((x) => x !== cat) : [...cs, cat]));

  return (
    <div className="py-2">
      {!fixed && (
        <div role="group" aria-label="기사 분류" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
          <button type="button" className="chip" aria-pressed={cats.length === 0} onClick={() => setCats([])}>
            전체 <span className="num">{all?.articleTotal ?? 0}</span>
          </button>
          {counts.map((x) => (
            <button key={x.category} type="button" className="chip" aria-pressed={cats.includes(x.category)} onClick={() => toggle(x.category)}>
              {x.category} <span className="num">{x.count}</span>
            </button>
          ))}
        </div>
      )}
      {!pages || (pages.loading && !items.length) ? (
        <div className="space-y-3 py-2" aria-busy="true">
          <p className="text-sm text-sub">기사 목록을 받는 중입니다</p>
          <Lines n={4} />
        </div>
      ) : pages.error && !items.length ? (
        <p className="text-sm font-medium text-amber">{pages.error}</p>
      ) : (
        <>
          <p className="num text-sm font-semibold">
            {cats.length ? `${cats.join(", ")} 기사` : "기사"} {total}건
          </p>
          <ul id={mr.listId} className="divide-y divide-rule">
            {items.slice(0, mr.count).map((a, i) => (
              <li key={a.id} data-item={i}>
                <DetailRow
                  head={
                    <span className="block">
                      <span className="clamp-2 font-medium">{a.title}</span>
                      <span className="num mt-0.5 flex flex-wrap gap-x-3 text-sm text-sub">
                        <span>{a.date ?? "날짜 미상"}</span>
                        {a.outlet && <span>{a.outlet}</span>}
                        {a.relatedCount >= 2 && <span>비슷한 기사 {a.relatedCount}건</span>}
                      </span>
                    </span>
                  }
                >
                  {a.description && <p className="clamp-3">{a.description}</p>}
                  <p className="mt-1 text-sm text-sub">분류: {a.categories.join(", ") || "없음"}</p>
                  <ExtLink href={a.url ?? a.naverUrl}>기사 열기</ExtLink>
                </DetailRow>
              </li>
            ))}
          </ul>
          <MoreButton
            left={Math.max(0, total - mr.count)}
            step={20}
            onClick={() => {
              if (items.length < mr.count + 20 && items.length < total) void fetchPage(jobId, version, cats, items.length);
              mr.more();
            }}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 최근 동향

export function News() {
  const c = useCompany();
  const job = c.job!;
  const env = job.sections.news;
  const r = env.result;
  const loading = phaseOf(env) === "loading";
  const [ask, setAsk] = useState(false);
  const k = (s: string) => `${c.cid}:ne:${s}`;
  const rs = retryState(env);
  const events = r?.events ?? [];
  const showMenu = !job.isExample && !loading && env.status !== "unavailable" && (rs.kind === "show" || rs.kind === "disabled");

  return (
    <SectionFrame
      id="news"
      label="최근 동향"
      env={env}
      envKey="news"
      summary={summaryLine(job, "news")}
      menu={
        showMenu ? (
          <>
            <button type="button" className="btn text-sm" disabled={rs.kind === "disabled" || env.rerun?.status === "running"} onClick={() => setAsk(true)}>
              뉴스만 새로 받기
            </button>
            {rs.kind === "disabled" && <span className="text-sm text-sub">{rs.note}</span>}
            <SectionDialog open={ask} onClose={() => setAsk(false)} sectionKey="news" label="최근 동향" news />
          </>
        ) : null
      }
      footer={
        !loading && r && r.articleTotal > 0 ? (
          <>
            <SourceLine word="reported" label="NAVER 뉴스 검색, Liner 검색" detail={`${r.period}, 중복 정리 후 ${num(r.articleTotal)}건 (수집 ${num(r.rawCount)}건)`} />
            <p className="text-xs text-sub">중요 사건은 기사 제목과 발췌를 모델이 골라 정리했습니다. 내용은 기사 원문에서 확인하세요.</p>
            <NextLine text="중요 사건은 심사 준비의 미팅 근거 묶음에 '최근 성과'로 들어갑니다." href={`/c/${c.cid}/review?tab=invest#evidence`} linkText="미팅 근거 묶음 보기" />
          </>
        ) : null
      }
    >
      {loading ? (
        <Lines n={3} />
      ) : (
        <>
          {events.length > 0 ? (
            <ul className="divide-y divide-rule border-y border-rule">
              {events.slice(0, 3).map((e, i) => (
                <li key={i}>
                  <EventRow e={e} memoryKey={k(`e${i}`)} />
                </li>
              ))}
            </ul>
          ) : (
            <p>중요 사건으로 정리된 것이 없습니다.</p>
          )}
          <div className="mt-4">
            {events.length > 3 && (
              <Disclosure text={`중요 사건 ${events.length - 3}개 더 보기`} openText={`중요 사건 ${events.length - 3}개 접기`} memoryKey={k("events")}>
                <ul className="divide-y divide-rule">
                  {events.slice(3).map((e, i) => (
                    <li key={i}>
                      <EventRow e={e} memoryKey={k(`e${i + 3}`)} />
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
            {r && r.articleTotal > 0 && (
              <Disclosure text={`기사 ${num(r.articleTotal)}건 보기`} memoryKey={k("articles")}>
                <NewsList />
              </Disclosure>
            )}
            {r && r.trends.length > 0 && (
              <Disclosure text="흐름 요약 보기" memoryKey={k("trends")}>
                <ul className="list-disc space-y-1 py-2 pl-5">
                  {r.trends.slice(0, 5).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </div>
        </>
      )}
    </SectionFrame>
  );
}

function EventRow({ e, memoryKey }: { e: NonNullable<AnalysisJob["sections"]["news"]["result"]>["events"][number]; memoryKey: string }) {
  return (
    <DetailRow
      memoryKey={memoryKey}
      head={
        // 휴대폰에서는 날짜를 분류와 한 줄에 두고 제목은 전체 폭을 쓴다(날짜 칸 때문에 제목이 3줄로 꺾이지 않게)
        <span className="block sm:grid sm:grid-cols-[6.5em_1fr] sm:gap-x-3">
          <span className="num text-sm text-sub max-sm:mr-2">{e.date ?? "날짜 미상"}</span>
          <span className="max-sm:contents">
            <span className="text-sm text-sub">{e.category}</span>
            <span className="clamp-2 block font-medium">{e.title}</span>
          </span>
        </span>
      }
    >
      {e.detail && <p>{e.detail}</p>}
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <StatusWord w="reported" />
        <span className="text-sub">
          근거 기사: {e.outlet ?? "매체 미상"}
          {e.articleDate ? `, ${e.articleDate}` : ""}
        </span>
      </p>
      <ExtLink href={e.articleUrl}>기사 열기</ExtLink>
    </DetailRow>
  );
}

// ---------------------------------------------------------------- 기술

export function Tech() {
  const c = useCompany();
  const job = c.job!;
  const env = job.sections.patents;
  const r = env.result;
  const loading = phaseOf(env) === "loading";
  const k = (s: string) => `${c.cid}:te:${s}`;
  const endYear = Number(todayKST().slice(0, 4));
  // 출원일 최근순(서버도 그렇게 주지만 화면에서 한 번 더 맞춘다)
  const patents = [...(r?.patents ?? [])].sort((a, b) => (b.filingDate ?? "").localeCompare(a.filingDate ?? ""));
  const limitHit = r && r.pagesChecked >= r.pagesLimit && r.candidatesLeft > 0;

  return (
    <SectionFrame
      id="tech"
      label="기술"
      env={env}
      envKey="patents"
      summary={summaryLine(job, "tech")}
      unavailableBody={<Papers />}
      footer={
        !loading ? (
          <NextLine text="특허와 논문은 심사 준비에서 기술 요건이 있는 공고의 근거와 미팅 근거 묶음에 씁니다." href={`/c/${c.cid}/review`} linkText="심사 준비 보기" />
        ) : null
      }
    >
      {loading ? (
        <div className="space-y-4">
          <Placeholder h={170} />
          <Lines n={3} />
        </div>
      ) : (
        <>
          <figure>
            <figcaption className="subhead">출원연도별 {PATENT_LABEL} (최근 5년)</figcaption>
            <div className="max-w-[360px]">
              <PatentLine series={[{ name: job.company.name, byYear: r?.summary.byYear ?? {}, mine: true }]} endYear={endYear} />
            </div>
            <p className="mt-1 text-xs text-sub">공개 전 기간이라 적게 보일 수 있습니다.</p>
            <SourceLine word="confirmed" label="특허 공개 원문 (Google Patents)" detail={`${fmtDay(r?.queriedAt)} 조회, ${PATENT_SCOPE}`} />
          </figure>
          <p className="subhead mt-6">주요 특허</p>
          <ul className="divide-y divide-rule border-y border-rule">
            {patents.slice(0, 3).map((p) => (
              <li key={p.id}>
                <PatentRow p={p} memoryKey={k(p.id)} />
              </li>
            ))}
          </ul>
          {limitHit && (
            <p className="mt-3 text-sm">
              특허 문서 {r!.pagesLimit}건까지 원문을 확인했습니다. 확인하지 못한 후보 {r!.candidatesLeft}건이 있어 실제보다 적을 수 있습니다.
            </p>
          )}
          <div className="mt-4">
            {patents.length > 3 && (
              <Disclosure text={`특허 ${patents.length}건 모두 보기`} memoryKey={k("all")}>
                <ul className="divide-y divide-rule">
                  {patents.map((p) => (
                    <li key={p.id}>
                      <PatentRow p={p} memoryKey={k(`a-${p.id}`)} />
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
            {r && r.mentions.length > 0 && (
              <Disclosure text={`회사 이름이 나오지만 출원인이 다른 문서 ${r.mentions.length}건`} memoryKey={k("mentions")}>
                <ul className="space-y-1 py-2 text-sm">
                  {r.mentions.map((m) => (
                    <li key={m.pubNo}>
                      {m.title} <span className="text-sub">({m.assignee ?? "출원인 미상"})</span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm">건수에 넣지 않았습니다.</p>
              </Disclosure>
            )}
            <Disclosure text="이 숫자의 한계" memoryKey={k("limits")}>
              <p className="py-2 text-sm">검색으로 찾은 공개 특허만 셉니다. 출원 뒤 약 18개월은 공개되지 않아 최근 연도는 적게 보입니다. 같은 출원의 공개·등록 문서는 한 건으로 셉니다.</p>
            </Disclosure>
          </div>
        </>
      )}
      <Papers />
    </SectionFrame>
  );
}

function PatentRow({ p, memoryKey }: { p: NonNullable<AnalysisJob["sections"]["patents"]["result"]>["patents"][number]; memoryKey: string }) {
  return (
    <DetailRow
      memoryKey={memoryKey}
      head={
        <span className="block">
          <span className="clamp-2 font-medium">{p.title}</span>
          <span className="num mt-0.5 flex gap-3 text-sm text-sub">
            <span>출원 {p.filingDate ?? "날짜 미상"}</span>
            <span>{p.registrationNo ? "등록" : "공개"}</span>
          </span>
        </span>
      }
    >
      {p.abstract && <p>{p.abstract}</p>}
      <dl className="num mt-2 grid grid-cols-[6em_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-sub">출원번호</dt>
        <dd>{p.applicationNo ?? "—"}</dd>
        <dt className="text-sub">공개번호</dt>
        <dd>{p.publicationNo ?? "—"}</dd>
        <dt className="text-sub">등록번호</dt>
        <dd>{p.registrationNo ?? "—"}</dd>
        <dt className="text-sub">기술 분류</dt>
        <dd>{p.techFields.slice(0, 3).join(", ") || "—"}</dd>
      </dl>
      <ExtLink href={p.url}>특허 원문 열기</ExtLink>
    </DetailRow>
  );
}

/** 논문(열 때 실행 블록, screens 1.6·4.5). 단추를 누를 때만 부른다(TE-05) */
function Papers() {
  const c = useCompany();
  const job = c.job!;
  const env = job.sections.papers;
  const [rerun, setRerun] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const profileDone = phaseOf(job.sections.profile) !== "loading";
  const kw = Math.min(6, job.merged.techKeywords.length);
  const est = job.estimates?.sections?.papers ?? DEFAULT_ESTIMATES.sections.papers;
  const running = env.status === "running" || env.status === "waiting" || env.rerun?.status === "running";
  const k = (s: string) => `${c.cid}:pa:${s}`;
  const hiddenIdle = env.status === "idle" && profileDone && !env.retryable;
  if (job.isExample && env.status === "idle") return null;
  if (hiddenIdle) return null;
  const run = async () => {
    setErr(null);
    const r = await c.runSection("papers");
    if (!r.ok) setErr(r.message);
  };
  const result = env.result;
  const works = result?.company.works ?? [];

  return (
    <div className="mt-8 rounded-lg border border-rule p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold">논문 동향</h3>
        {env.analyzedAt && result && <span className="num text-sm text-sub">{fmtMonthDayTime(env.analyzedAt)} 실행</span>}
      </div>
      {running ? (
        <div className="mt-2">
          <RunningLine text="논문을 찾고 있습니다" env={env} />
        </div>
      ) : result ? (
        <div className="mt-2">
          {works.length ? (
            <>
              <p className="font-medium">회사가 직접 참여한 논문 {works.length}건 (저자 소속 확인)</p>
              <ul className="mt-2 divide-y divide-rule border-y border-rule">
                {works.slice(0, 3).map((w) => (
                  <li key={w.id}>
                    <PaperRow w={w} memoryKey={k(w.id)} />
                  </li>
                ))}
              </ul>
              {works.length > 3 && (
                <Disclosure text={`직접 참여 논문 ${works.length}건 모두 보기`} memoryKey={k("all")} className="mt-3">
                  <ul className="divide-y divide-rule">
                    {works.map((w) => (
                      <li key={w.id}>
                        <PaperRow w={w} memoryKey={k(`a-${w.id}`)} />
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </>
          ) : (
            <p>회사가 저자 소속으로 확인되는 논문을 찾지 못했습니다.</p>
          )}
          {result.topics.length > 0 && (
            <Disclosure text="분야별 발표 추이와 주요 논문 보기" memoryKey={k("topics")} className="mt-3">
              <div className="space-y-5 py-2">
                <div className="max-w-[420px]">
                  <PatentLine series={result.topics.slice(0, 4).map((t, i) => ({ name: t.name, byYear: t.byYear, mine: i === 0 }))} endYear={Number(todayKST().slice(0, 4))} />
                </div>
                {result.topics.map((t) => (
                  <div key={t.name}>
                    <p className="font-semibold">{t.name}</p>
                    {t.summary && <p className="text-sm">{t.summary}</p>}
                    {t.institutions.length > 0 && <p className="text-sm">주요 연구기관: {t.institutions.slice(0, 3).map((x) => x.name).join(", ")}</p>}
                    <ul className="mt-1 space-y-1 text-sm">
                      {t.keyPapers.slice(0, 3).map((p) => (
                        <li key={p.title}>
                          <ExtLink href={p.url} className="link text-sm" inline>
                            {p.title}
                          </ExtLink>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Disclosure>
          )}
          <SourceLine word="reported" label="OpenAlex 논문 DB (공개 API)" detail={`${fmtDay(result.queriedAt)}. 회사 이름이 언급만 된 논문은 직접 참여에 넣지 않습니다.`} />
          {env.retryable && !job.isExample && (
            <>
              <button type="button" className="btn mt-3" onClick={() => setRerun(true)}>
                다시 실행
              </button>
              <RerunDialog open={rerun} onClose={() => setRerun(false)} title="논문 동향" liner={est.liner} onConfirm={() => c.runSection("papers")} />
            </>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-3">
          {/* 개요(profile) 전에는 기술 분야 수를 모른다. "0개", "0회"로 단정하지 않는다 */}
          <p>회사 기술 분야{profileDone ? ` ${kw}개` : ""}의 논문 발표 추이와 회사가 직접 참여한 논문을 찾습니다.</p>
          {env.status === "unavailable" && env.error && <p className="text-sm font-medium text-amber">{env.error.message}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" disabled={!profileDone || !env.retryable} onClick={run}>
              논문 분석하기
            </button>
            <span className="text-sm text-sub">
              {est.seconds ? `보통 ${elapsedText(est.seconds)}, ` : ""}Liner 학술 검색 {profileDone ? `${kw}회` : "최대 6회"}, 모델 1회
            </span>
          </div>
          {!profileDone && <p className="text-sm">회사 기술 분야를 받으면 실행할 수 있습니다.</p>}
          {err && (
            <p role="alert" className="text-sm font-medium text-amber">
              {err}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PaperRow({ w, memoryKey }: { w: Paper; memoryKey: string }) {
  return (
    <DetailRow
      memoryKey={memoryKey}
      head={
        <span className="block">
          <span className="clamp-2 font-medium">{w.title}</span>
          <span className="num text-sm text-sub">
            {w.year ?? "연도 미상"}
            {w.venue ? `, ${w.venue}` : ""}
          </span>
        </span>
      }
    >
      <p className="text-sm">저자: {w.authors ?? "미상"}</p>
      <p className="text-sm">소속: {w.affiliations ?? "미상"}</p>
      <p className="num text-sm">피인용 {w.citations}회</p>
      <ExtLink href={w.url}>논문 열기</ExtLink>
    </DetailRow>
  );
}
