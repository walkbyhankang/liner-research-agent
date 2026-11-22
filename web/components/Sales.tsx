"use client";

// 판로(screens 7절): 나라장터 입찰공고(열 때 무료 조회)와 판로 지원사업(기업마당, 화면에서 거름).
import { useEffect, useMemo, useState } from "react";
import type { Bid } from "@/lib/contract";
import { matchProgram, notExpired, withStatus, type Profile, type Program } from "@/lib/finder";
import { initialConditions, relatedTo } from "@/lib/funding";
import { elapsedText, fmtDay } from "@/lib/format";
import { isSaved, reviewCount, saveSalesKeywords, setEdit, toggleSaved } from "@/lib/local";
import { bidDeadline, sortBids } from "@/lib/review";
import { phaseOf } from "@/lib/view";
import { BIZ_LABEL } from "@/lib/company-values";
import { DetailRow, Disclosure, ExtLink, MoreButton, Placeholder, SourceLine, StatusWord, useMore } from "@/components/kit";
import { useCompany, useTicker } from "@/components/company/context";
import { BizPicker } from "@/components/company/Shell";
import { CardList, LoadError, ProgramCard, SavedBar, usePublicData, useToday } from "@/components/funding/Board";

/** 같은 방문에서 같은 검색어로 다시 열면 다시 묻지 않는다(P-01) */
const posted = new Set<string>();

export function SalesScreen() {
  const c = useCompany();
  const job = c.job;
  const today = useToday();
  const env = job?.sections.sales;
  const profileDone = job ? phaseOf(job.sections.profile) !== "loading" : false;
  const kwKey = (c.local.salesKeywords ?? job?.merged.bidKeywords ?? []).slice(0, 6).join("|");
  const keywords = useMemo(() => (kwKey ? kwKey.split("|") : []), [kwKey]);
  const [err, setErr] = useState<string | null>(null);
  const running = env ? env.status === "running" || env.status === "waiting" || env.rerun?.status === "running" : false;
  const tick = useTicker(running, c.receivedAt);

  const search = async (kw: string[]) => {
    if (!job || !kw.length) return;
    posted.add(`${job.jobId}|${kw.join("|")}`);
    const r = await c.runSection("sales", { keywords: kw });
    setErr(r.ok ? null : r.message);
  };

  useEffect(() => {
    if (!job || !env || !c.local.loaded || !keywords.length || running) return;
    const key = `${job.jobId}|${keywords.join("|")}`;
    if (posted.has(key)) return;
    const same = env.result && env.result.keywords.join("|") === keywords.join("|");
    if (same || (env.status === "unavailable" && env.error?.code === "daily_limit")) {
      posted.add(key);
      return;
    }
    if (!env.retryable && env.status !== "idle") return;
    // 화면을 처음 열 때 한 번 조회한다(무료). 결과 글은 응답이 온 뒤에만 바꾼다
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void search(keywords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, env?.status, c.local.loaded, keywords]);

  const r = env?.result ?? null;
  const items = useMemo(() => (r ? sortBids(r.items) : []), [r]);
  const mr = useMore(items.length, 5, 10);
  const open = items.filter((b) => b.status === "open").length;

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 pb-24 pt-6 sm:px-6">
      <h1 className="text-2xl font-semibold">판로</h1>

      <section aria-labelledby="bid-h" className="mt-6 max-w-[760px]">
        <h2 id="bid-h" className="flex flex-wrap items-center gap-2 text-xl font-semibold">
          공공 조달 입찰공고
          {env?.status === "unavailable" && <StatusWord w="unavailable" />}
        </h2>
        <p className="text-sm text-sub">조달청 나라장터, 최근 28일</p>
        {/* 검색어는 누르는 것이 아니라 테두리 없이 따옴표로 보인다. 고치기는 아래 "검색어 고치기"에서 */}
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm text-sub">검색어</span>
          {keywords.length ? (
            keywords.map((k) => (
              <span key={k} data-keyword className="text-sm font-medium">
                &lsquo;{k}&rsquo;
              </span>
            ))
          ) : (
            <span className="text-sm">{profileDone ? "검색어 없음" : "회사 분석에서 기술 낱말을 받으면 찾습니다."}</span>
          )}
        </div>
        <KeywordEditor key={kwKey} initial={keywords} onSearch={(kw) => {
          if (job) saveSalesKeywords(c.cid, kw);
          void search(kw);
        }} />

        <div className="mt-4">
          {!job ? null : running ? (
            <div className="space-y-3" aria-busy="true">
              <p className="text-sub">
                나라장터에서 입찰공고를 찾고 있습니다 <span className="num">({elapsedText((env?.seconds ?? 0) + tick)})</span>
              </p>
              <Placeholder h={16} />
              <Placeholder h={16} w="80%" />
            </div>
          ) : env?.status === "unavailable" ? (
            env.error?.code === "daily_limit" ? (
              <p className="text-lg">오늘 호출 상한에 닿아 입찰공고를 찾지 못했습니다. 내일 0시 이후에 다시 찾을 수 있습니다.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-lg">나라장터에서 응답을 받지 못했습니다.</p>
                <button type="button" className="btn" onClick={() => void search(keywords)}>
                  다시 찾기
                </button>
              </div>
            )
          ) : r ? (
            <>
              <p className="text-lg">
                입찰공고 {items.length}건 (최근 28일, 공고명에 검색어가 들어간 것). 진행 중 {open}건.
              </p>
              {env?.status === "partial" && <p className="mt-1 text-sm font-medium text-amber">일부 기간 조회에 실패했습니다 ({r.errorCount}건). 빠진 공고가 있을 수 있습니다.</p>}
              {items.length === 0 ? (
                <p className="mt-3">최근 28일 동안 검색어가 들어간 입찰공고가 없습니다. 검색어를 바꿔 보세요.</p>
              ) : (
                <>
                  <ul id={mr.listId} className="mt-3 divide-y divide-rule border-y border-rule" data-bids>
                    {items.slice(0, mr.count).map((b, i) => (
                      <li key={b.id} data-item={i}>
                        <BidRow b={b} today={today} />
                      </li>
                    ))}
                  </ul>
                  <MoreButton left={mr.left} step={10} onClick={mr.more} />
                </>
              )}
              <p className="mt-3">입찰 참가 자격(지역 제한, 업종 등록 등)은 공고문에서 확인하세요.</p>
              <SourceLine word="confirmed" label="조달청 나라장터 입찰공고 (공공 API)" detail={`${r.period} 조회`} />
              <Disclosure text="이 목록의 한계" memoryKey={`${c.cid}:sa:limits`} className="mt-3">
                <ul className="list-disc space-y-1 py-2 pl-5 text-sm">
                  <li>참가 자격은 확인하지 않았습니다.</li>
                  <li>공고명에 낱말이 들어간 공고를 찾아 관계없는 공고가 섞일 수 있습니다.</li>
                  <li>최근 28일 공고만 찾습니다.</li>
                </ul>
              </Disclosure>
            </>
          ) : null}
          {err && (
            <p role="alert" className="mt-2 text-sm font-medium text-amber">
              {err}
            </p>
          )}
        </div>
      </section>

      <SalesPrograms />
      <SavedBar n={reviewCount(c.local)} href={`/c/${c.cid}/review`} />
    </main>
  );
}

function KeywordEditor({ initial, onSearch }: { initial: string[]; onSearch: (kw: string[]) => void }) {
  const [kw, setKw] = useState(initial);
  const [add, setAdd] = useState("");
  return (
    <Disclosure text="검색어 고치기" memoryKey="sales:kw" className="mt-2">
      <div className="space-y-3 py-2">
        <ul className="flex flex-wrap gap-2">
          {kw.map((k) => (
            <li key={k}>
              <button type="button" className="chip" aria-label={`검색어 빼기: ${k}`} onClick={() => setKw(kw.filter((x) => x !== k))}>
                {k}
                <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const t = add.trim().slice(0, 20);
            if (t && !kw.includes(t) && kw.length < 6) setKw([...kw, t]);
            setAdd("");
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="sr-only">검색어 더하기</span>
            <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="검색어 더하기" maxLength={20} className="min-h-11 w-full rounded-md border border-rule px-3 outline-none focus:border-ledger" />
          </label>
          <button type="submit" className="btn" disabled={kw.length >= 6}>
            더하기
          </button>
          <button type="button" className="btn btn-primary" disabled={!kw.length} onClick={() => onSearch(kw)}>
            다시 찾기
          </button>
        </form>
        <p className="text-sm text-sub">검색어는 6개까지 넣을 수 있고, 이 브라우저에 저장합니다. 나라장터 조회는 무료입니다.</p>
      </div>
    </Disclosure>
  );
}

function BidRow({ b, today }: { b: Bid; today: string }) {
  const c = useCompany();
  const on = isSaved(c.local, "bid", b.id);
  return (
    <DetailRow
      head={
        <span className="block">
          <span className="flex flex-wrap items-center gap-2">
            {b.relevance === "high" && <span className="tag">핵심 낱말 일치</span>}
            <span className="num text-sm">{today ? bidDeadline(b, today) : ""}</span>
          </span>
          <span className="clamp-2 mt-0.5 font-medium">{b.title}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-sub">
            <span>{b.agency}</span>
            <span className="num">{b.amount || "공고문 확인"}</span>
          </span>
        </span>
      }
    >
      <dl className="grid grid-cols-[6em_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-sub">구분</dt>
        <dd>{b.kind}</dd>
        <dt className="text-sub">입찰 방식</dt>
        <dd>{b.summary ?? "공고문 확인"}</dd>
        <dt className="text-sub">기간</dt>
        <dd className="num">{b.period}</dd>
        <dt className="text-sub">신청 조건</dt>
        <dd>{b.condition === "물품분류 제한" ? "물품분류 제한" : "참가자격은 공고문 확인"}</dd>
        <dt className="text-sub">일치한 검색어</dt>
        <dd>{b.keywords.join(", ") || "없음"}</dd>
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        <ExtLink href={b.url} className="btn">
          공고 열기
        </ExtLink>
        <button
          type="button"
          className={`btn ${on ? "btn-pressed" : ""}`}
          aria-pressed={on}
          aria-label={`노트에 담기: ${b.title}`}
          onClick={() => toggleSaved(c.cid, { kind: "bid", itemId: b.id, title: b.title, meta: { agency: b.agency, deadline: b.deadline, url: b.url, status: b.status } })}
        >
          {on ? "노트에 담음" : "노트에 담기"}
        </button>
      </div>
    </DetailRow>
  );
}

function SalesPrograms() {
  const c = useCompany();
  const { data, error } = usePublicData();
  const today = useToday();
  const [cat, setCat] = useState<"내수" | "수출">("내수");
  const cond = initialConditions(c.job?.merged ?? null, c.local.edits).cond;
  const prof: Profile | null = cond.region && cond.biz ? { region: cond.region, biz: cond.biz, need: "all", field: cond.field ?? "ai" } : null;
  const keywords = c.job?.merged.programKeywords ?? [];
  const lists = useMemo(() => {
    if (!data || !prof || !today) return null;
    const live = data.programs.filter((p) => notExpired(p, today)).map((p) => withStatus(p, today));
    const by = (k: string) => live.filter((p) => p.category === k).map((p) => matchProgram(p, prof)).filter((m) => m.ok);
    return { 내수: by("내수"), 수출: by("수출") };
  }, [data, prof?.region, prof?.biz, today]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section aria-labelledby="sp-h" className="mt-12 border-t border-rule pt-6">
      <h2 id="sp-h" className="text-xl font-semibold">
        판로 지원사업
      </h2>
      {error && <LoadError />}
      {!prof ? (
        <div className="mt-3 max-w-[680px]">
          <p>{cond.region ? "기업 유형을 골라 주세요." : "지역과 기업 유형을 고르면 자금 조달과 같은 조건으로 거릅니다."}</p>
          {!cond.biz && (
            <div className="mt-2">
              <BizPicker current={null} onPick={(b) => setEdit(c.cid, "bizType", b)} hint={c.job?.merged.bizTypeHint ?? null} />
            </div>
          )}
        </div>
      ) : lists ? (
        <>
          <div role="tablist" aria-label="판로 지원사업 갈래" className="mt-3 flex gap-2">
            {(["내수", "수출"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={cat === k} className="chip" onClick={() => setCat(k)}>
                {k} <span className="num">{lists[k].length}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-sub">
            자금 조달과 같은 조건({prof.region}, {BIZ_LABEL[prof.biz]})으로 거릅니다.
          </p>
          <div>
            <CardList
              key={cat}
              listClass="mt-3 grid gap-3 lg:grid-cols-2"
              items={lists[cat]}
              keyOf={(m) => m.program.id}
              empty="이 조건에 맞는 판로 지원사업이 없습니다."
              render={(m) => <ProgramCard m={m} today={today} related={relatedTo(m.program, keywords)} save={saveSales(c.cid, c.local, m.program)} />}
            />
          </div>
        </>
      ) : !error ? (
        <p className="mt-3 text-sub">공고 목록을 불러오는 중입니다</p>
      ) : null}
      <p className="mt-4 text-xs text-sub">판로 지원사업 출처: 기업마당 지원사업정보 {data ? `(${fmtDay(data.meta.asOf)} 기준)` : ""}</p>
    </section>
  );
}

function saveSales(cid: string, local: ReturnType<typeof useCompany>["local"], p: Program) {
  return {
    on: isSaved(local, "salesProgram", p.id),
    toggle: () => toggleSaved(cid, { kind: "salesProgram", itemId: p.id, title: p.title, meta: { end: p.period.end, agency: p.agency, url: p.url } }),
    onText: "담음", offText: "담기", sr: `심사 준비로 담기: ${p.title}`,
  };
}
