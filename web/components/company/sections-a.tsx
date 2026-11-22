"use client";

// 회사 분석 단락: 개요(4.1), 재무·고용(4.2), 투자(4.3).
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { FinancialRow, MergedInvestor, Round, Value } from "@/lib/contract";
import { normName } from "@/lib/names";
import { eok, fmtDay, num, stageKo } from "@/lib/format";
import { setEdit } from "@/lib/local";
import { phaseOf, summaryLine } from "@/lib/view";
import { DetailRow, Disclosure, ExtLink, MoreButton, Placeholder, SourceLine, StatusWord, useMore } from "@/components/kit";
import { FinanceBars, NpsLine } from "@/components/charts";
import { useCompany } from "@/components/company/context";
import { FactRow, ValueBox } from "@/components/company/values";
import { NextLine, SectionFrame } from "@/components/company/Section";
import { NewsList } from "@/components/company/sections-b";

const Lines = ({ n = 3 }: { n?: number }) => (
  <span className="block space-y-2">
    {Array.from({ length: n }, (_, i) => (
      <Placeholder key={i} h={16} w={i === n - 1 ? "60%" : "100%"} />
    ))}
  </span>
);

// ---------------------------------------------------------------- 개요

export function Overview() {
  const c = useCompany();
  const job = c.job!;
  const env = job.sections.profile;
  const p = env.result;
  const m = job.merged;
  const e = c.local.edits;
  const corp = job.sections.identity.result?.corp ?? null;
  const others = job.sections.identity.result?.otherCorps ?? [];
  const loading = phaseOf(env) === "loading";
  const [more, setMore] = useState(false);
  const k = (s: string) => `${c.cid}:ov:${s}`;

  // 처음(법인 확인)부터 정해지는 대표·본사를 위에, facts 가 오며 바뀌는 설립(웹 값과 엇갈리면 두 값)·직원 수를 아래에 둔다.
  // 늦게 길어지는 줄이 이미 보이던 줄을 밀지 않게(실제 서버 검증에서 설립 엇갈림이 본사 줄을 108px 밀었다)
  const facts = (
    <div className="divide-y divide-rule border-y border-rule">
      <FactRow label="대표" v={m.ceo} memoryKey={k("ceo")} />
      <FactRow label="본사" v={m.headquarters} memoryKey={k("hq")} />
      <FactRow label="설립" v={m.founded} edit={e.founded?.value} onRevert={() => setEdit(c.cid, "founded", null)} memoryKey={k("founded")} />
      <FactRow label="직원 수" v={m.employees} edit={e.employees?.value} onRevert={() => setEdit(c.cid, "employees", null)} memoryKey={k("emp")} />
    </div>
  );

  // 자리 표시는 끝난 모양과 같은 높이로 잡는다(설명 두 줄 + "더 읽기" 단추, 제품 한 줄, 기술 낱말 한 줄). 도착할 때 아래가 밀리지 않게
  const business = loading ? (
    <div className="min-h-[99px] pt-1">
      <Lines n={2} />
    </div>
  ) : p?.business ? (
    <div>
      <p className={more ? "" : "clamp-2"}>{p.business}</p>
      {!more && (
        <button type="button" className="btn btn-quiet -ml-2.5" onClick={() => setMore(true)}>
          더 읽기
        </button>
      )}
    </div>
  ) : (
    <p className="font-medium">미확보: 사업 설명 자료를 찾지 못했습니다.</p>
  );

  const products = p?.products ?? [];
  const tech = p?.coreTech ?? [];
  const industryEdit = e.industry?.value;

  return (
    <SectionFrame
      id="overview"
      label="개요"
      env={env}
      envKey="profile"
      summary={summaryLine(job, "overview")}
      twoLineSummary
      unavailableBody={<div className="max-w-[340px]">{facts}</div>}
      footer={
        p && p.sourceCount > 0 ? (
          <div className="source">
            <p className="text-sub">공개 자료 {p.sourceCount}건을 정리한 요약</p>
          </div>
        ) : null
      }
    >
      {/* 넓은 화면(820·1180)에서는 개요가 첫 화면 안이다. 개요·facts 가 오며 설명·기술 낱말·사실 표(직원 수, 설립 엇갈림)가 길어져도
          아래 줄이 밀리지 않게 격자 높이를 진행 중·끝난 뒤 모두 같은 최소값으로 잡는다(실측 끝난 높이 291~327px, 2026-11-23) */}
      <div className="grid gap-6 md:min-h-[336px] md:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <div className="min-w-0 space-y-4">
          {business}
          <div>
            <p className="text-sm text-sub">제품·서비스 {loading ? "" : `${products.length}개`}</p>
            {loading ? (
              <div className="flex h-[27px] items-center">
                <Placeholder h={16} w="60%" />
              </div>
            ) : products.length ? <p className="font-medium">{products.slice(0, 3).map((x) => x.name).join(", ")}</p> : <p className="text-sub">미확보: 제품 자료 없음</p>}
          </div>
          <div>
            <p className="text-sm text-sub">핵심 기술</p>
            {loading ? (
              <div className="mt-1 flex h-[29px] items-center">
                <Placeholder h={16} w="60%" />
              </div>
            ) : tech.length ? (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {tech.slice(0, 4).map((t) => (
                  <li key={t} className="rounded border border-rule px-2 py-0.5 text-sm">
                    {t}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sub">미확보: 기술 자료 없음</p>
            )}
          </div>
        </div>
        {facts}
      </div>

      {/* 처음부터 있는 "기업 정보 더 보기"를 맨 앞에 둔다. 개요가 도착하며 생기는 펼치기 줄은 그 뒤에 붙어, 이미 보이던 줄을 밀지 않는다 */}
      <div className="mt-4">
        <Disclosure text="기업 정보 더 보기" openText="기업 정보 접기" memoryKey={k("corp")}>
          <dl className="divide-y divide-rule text-sm">
            {corp ? (
              <>
                <Pair k="법인 이름" v={corp.name} />
                <Pair k="영문 이름" v={corp.nameEn} />
                <Pair k="법인등록번호" v={corp.crno} />
                <Pair k="사업자등록번호" v={corp.bzno} />
                <div className="grid grid-cols-[8em_1fr] gap-3 py-2">
                  <dt className="text-sub">홈페이지</dt>
                  <dd>{corp.homepage ? <ExtLink href={/^https?:/.test(corp.homepage) ? corp.homepage : `https://${corp.homepage}`}>{corp.homepage}</ExtLink> : "미확보: 공공 자료에 없음"}</dd>
                </div>
                <Pair k="상장 구분" v={corp.market} />
              </>
            ) : (
              <Pair k="법인" v="법인 확인 안 함" />
            )}
            {industryEdit ? (
              <div className="py-1">
                <FactRow label="업종" v={m.industry.official ?? m.industry.web} edit={industryEdit} onRevert={() => setEdit(c.cid, "industry", null)} memoryKey={k("ind-edit")} />
                <p className="px-2 pb-2 text-xs text-sub">원래 분석 값: 금융위 {m.industry.official?.display ?? "미확보"}, 웹 조사 {m.industry.web?.display ?? "미확보"}</p>
              </div>
            ) : (
              <>
                <IndustryRow label="업종(금융위)" v={m.industry.official} memoryKey={k("ind-off")} />
                <IndustryRow label="업종(웹 조사)" v={m.industry.web} memoryKey={k("ind-web")} />
              </>
            )}
            {corp && <Pair k="주소 전체" v={corp.address} />}
            {corp && <Pair k="금융위 자료 갱신일" v={corp.updated} />}
          </dl>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-sm">같은 이름의 다른 법인 {others.length}곳</span>
            <Link href={`/?name=${encodeURIComponent(job.query)}`} className="btn">
              다른 법인으로 바꾸기
            </Link>
          </div>
        </Disclosure>
        {products.length > 3 && (
          <Disclosure text={`제품·서비스 ${products.length}개 모두 보기`} memoryKey={k("products")}>
            <ul className="space-y-2 py-2">
              {products.map((x) => (
                <li key={x.name}>
                  <span className="font-medium">{x.name}</span>
                  {x.desc && <span className="block text-sm text-sub">{x.desc}</span>}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {tech.length > 4 && (
          <Disclosure text={`핵심 기술 ${tech.length}개 모두 보기`} memoryKey={k("tech")}>
            <ul className="flex flex-wrap gap-1.5 py-2">
              {tech.map((t) => (
                <li key={t} className="rounded border border-rule px-2 py-0.5 text-sm">
                  {t}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {p && p.statusNotes.length > 0 && (
          <Disclosure text={`회사 현황 메모 ${p.statusNotes.length}개 보기`} memoryKey={k("notes")}>
            <ul className="list-disc space-y-1 py-2 pl-5">
              {p.statusNotes.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </Disclosure>
        )}
        {p && p.sources.length > 0 && (
          <Disclosure text={`근거 자료 ${p.sources.length}건 보기`} memoryKey={k("sources")}>
            <SourceDocs docs={p.sources} />
          </Disclosure>
        )}
      </div>
    </SectionFrame>
  );
}

function SourceDocs({ docs }: { docs: { title: string; url: string | null; date: string | null }[] }) {
  const mr = useMore(docs.length, 10, 10);
  return (
    <div>
      <ul id={mr.listId} className="divide-y divide-rule">
        {docs.slice(0, mr.count).map((d, i) => (
          <li key={i} data-item={i} className="flex flex-wrap items-center justify-between gap-x-3 py-1 text-sm">
            <span className="min-w-0 flex-1">
              {d.title}
              {d.date && <span className="num ml-2 text-xs text-sub">{d.date}</span>}
            </span>
            <ExtLink href={d.url} className="link text-sm">
              원문 열기
            </ExtLink>
          </li>
        ))}
      </ul>
      <MoreButton left={mr.left} step={mr.step} onClick={mr.more} />
    </div>
  );
}

function Pair({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div className="grid grid-cols-[8em_1fr] gap-3 py-2">
      <dt className="text-sub">{k}</dt>
      <dd className="num">{v || "미확보: 공공 자료에 없음"}</dd>
    </div>
  );
}

function IndustryRow({ label, v, memoryKey }: { label: string; v: Value | null; memoryKey: string }) {
  return <FactRow label={label} v={v ?? null} memoryKey={memoryKey} pendingText="확인 중" />;
}

// ---------------------------------------------------------------- 재무·고용

const eokCell = (v: number | null) => (v === null ? "—" : eok(v));
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

function FinanceTable({ rows }: { rows: FinancialRow[] }) {
  const lines: { label: string; cell: (r: FinancialRow) => ReactNode }[] = [
    { label: "매출액", cell: (r) => <>{eokCell(r.revenue)}<span className="block text-xs text-sub">증가율 {pct(r.revenueGrowthPct)}</span></> },
    { label: "영업이익", cell: (r) => <>{eokCell(r.operatingIncome)}<span className="block text-xs text-sub">이익률 {pct(r.operatingMarginPct)}</span></> },
    { label: "당기순이익", cell: (r) => eokCell(r.netIncome) },
    { label: "자산총계", cell: (r) => eokCell(r.totalAssets) },
    { label: "부채총계", cell: (r) => eokCell(r.totalLiabilities) },
    { label: "자본총계", cell: (r) => eokCell(r.totalEquity) },
    { label: "부채비율", cell: (r) => pct(r.debtRatioPct) },
  ];
  return (
    <div className="overflow-x-auto">
      <p className="text-right text-xs text-sub">(단위: 억원)</p>
      <table className="num w-full min-w-[420px] border-t-2 border-ink text-sm">
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className="py-2 text-left font-medium text-sub">
              항목
            </th>
            {rows.map((r) => (
              <th key={r.year} scope="col" className="py-2 text-right font-semibold">
                {r.year}
                <span className="block text-xs font-normal text-sub">{r.basisShort ?? r.basis}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.label} className="border-b border-rule">
              <th scope="row" className="py-2 text-left font-normal">
                {l.label}
              </th>
              {rows.map((r) => (
                <td key={r.year} className="py-2 text-right">
                  {l.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Finance() {
  const c = useCompany();
  const job = c.job!;
  const env = job.sections.official;
  const r = env.result;
  const loading = phaseOf(env) === "loading";
  const fin = r?.financials ?? [];
  const nps = r?.nps ?? null;
  const web = job.merged.revenue.web;
  const k = (s: string) => `${c.cid}:fi:${s}`;
  const basis = fin.length ? `${fin[0].year}~${fin[fin.length - 1].year} 사업연도, ${fin[fin.length - 1].basisShort ?? fin[fin.length - 1].basis}` : "";

  const webLine =
    web && web.status !== "unavailable" ? (
      <DetailRow memoryKey={k("web")} head={<span className="flex flex-wrap items-center gap-2"><span>웹 조사 매출: {web.display}</span><StatusWord w={web.status} /></span>}>
        <ValueBox v={web} />
      </DetailRow>
    ) : null;

  return (
    <SectionFrame
      id="finance"
      label="재무·고용"
      env={env}
      envKey="official"
      summary={summaryLine(job, "finance")}
      unavailableBody={webLine}
    >
      {/* 재무가 미확보면 그 사유를 한 줄로 먼저 두고, 국민연금 차트가 빈 반쪽 옆에 끼지 않게 한 단으로 둔다 */}
      <div className={!loading && !fin.length ? "space-y-6" : "grid gap-8 md:grid-cols-2"}>
        <figure>
          <figcaption className="mb-2 text-sm font-semibold">매출과 영업이익</figcaption>
          {loading ? (
            <Placeholder h={180} />
          ) : fin.length ? (
            <>
              <FinanceBars rows={fin.map((f) => ({ year: f.year, revenue: f.revenue, operatingIncome: f.operatingIncome }))} />
              <SourceLine word="confirmed" label="금융위원회 요약재무제표 (공공 API)" detail={basis} />
            </>
          ) : (
            <p className="rounded-md bg-wash px-4 py-3 font-medium">미확보: {r?.financialsReason ?? "금융위원회 재무 자료 없음"}</p>
          )}
        </figure>
        <figure className={!loading && !fin.length ? "max-w-[360px]" : ""}>
          <figcaption className="mb-2 text-sm font-semibold">국민연금 가입자 수 (직원 수와 다릅니다)</figcaption>
          {loading ? (
            <Placeholder h={170} />
          ) : nps ? (
            <>
              <NpsLine points={nps.monthly} />
              <SourceLine word="reference" label="국민연금공단 사업장 가입자 (공공 API)" detail={nps.summary?.period ?? `${nps.monthly[0]?.month ?? ""}~${nps.monthly.at(-1)?.month ?? ""}`} />
            </>
          ) : (
            <p className="rounded-md bg-wash p-4 font-medium">미확보: {r?.npsReason ?? "국민연금 사업장을 찾지 못함"}</p>
          )}
        </figure>
      </div>
      {webLine && <div className="mt-3">{webLine}</div>}
      {!loading && (
        <div className="mt-4">
          {fin.length > 0 && (
            <Disclosure text="재무 표 보기" memoryKey={k("table")}>
              <FinanceTable rows={fin} />
              <SourceLine word="confirmed" label="금융위원회 요약재무제표 (공공 API)" detail={basis} />
            </Disclosure>
          )}
          {nps && (
            <Disclosure text="월별 가입자 표 보기" memoryKey={k("nps")}>
              <div className="overflow-x-auto">
                <table className="num w-full min-w-[380px] border-t-2 border-ink text-sm">
                  <thead>
                    <tr className="border-b border-rule text-sub">
                      {["월", "가입자 수", "신규 취득", "상실", "전월 대비"].map((h) => (
                        <th key={h} scope="col" className={`py-2 font-medium ${h === "월" ? "text-left" : "text-right"}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {nps.monthly.map((x) => (
                      <tr key={x.month} className="border-b border-rule">
                        <th scope="row" className="py-1.5 text-left font-normal">
                          {x.month}
                        </th>
                        <td className="text-right">{x.members === null ? "—" : num(x.members)}</td>
                        <td className="text-right">{x.joined === null ? "—" : num(x.joined)}</td>
                        <td className="text-right">{x.left === null ? "—" : num(x.left)}</td>
                        <td className="text-right">{x.change === null ? "—" : x.change > 0 ? `+${x.change}` : x.change}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <SourceLine word="reference" label="국민연금공단 사업장 가입자 (공공 API)" detail={nps.summary?.period ?? ""} />
            </Disclosure>
          )}
          {nps && (
            <Disclosure text="어느 사업장 자료인가요?" memoryKey={k("work")}>
              <dl className="space-y-1 py-2 text-sm">
                <div className="flex gap-3">
                  <dt className="text-sub">사업장</dt>
                  <dd>{nps.workplace.name}</dd>
                </div>
                <div className="flex gap-3">
                  <dt className="text-sub">사업자번호</dt>
                  <dd className="num">{nps.workplace.bznoMasked}</dd>
                </div>
              </dl>
              <p className="text-sm">{nps.note}</p>
              <p className="mt-1 text-sm">국민연금 가입자 수는 상시근로자 수와 다릅니다.</p>
            </Disclosure>
          )}
          {(r?.financialsAll.length ?? 0) > 3 && (
            <Disclosure text={`전체 연도 재무 ${r!.financialsAll.length}행 보기`} memoryKey={k("all")}>
              <FinanceTable rows={r!.financialsAll} />
            </Disclosure>
          )}
        </div>
      )}
    </SectionFrame>
  );
}

// ---------------------------------------------------------------- 투자

export function Investment() {
  const c = useCompany();
  const job = c.job!;
  const env = job.sections.funding_history;
  const r = env.result;
  const loading = phaseOf(env) === "loading";
  const investors = job.merged.investors;
  const rounds = r?.rounds ?? [];
  const pendingFacts = job.merged.pending.includes("investors.confirmed");
  const confirmedCount = investors.filter((i) => i.status === "confirmed").length;
  const k = (s: string) => `${c.cid}:in:${s}`;
  const investArticles = job.sections.news.result?.categoryCounts.find((x) => x.category === "투자유치")?.count ?? 0;

  const limits = (
    <Disclosure text="이 자료의 한계" memoryKey={k("limits")}>
      <ul className="list-disc space-y-1 py-2 pl-5 text-sm">
        <li>투자 DB와 기사에 실린 라운드만 보입니다. 결과가 적다고 투자 이력이 없다는 뜻은 아닙니다.</li>
        <li>금액은 통화를 바꾸지 않고 자료에 적힌 그대로 보여 줍니다.</li>
        <li>투자기관 이름이 영문이면 자금 조달의 모태펀드 운용사(한글 이름)와 맞춰 보지 못할 수 있습니다.</li>
      </ul>
    </Disclosure>
  );
  const related = r && r.relatedEntities.length > 0 && (
    <Disclosure text={`이름이 비슷한 다른 법인 자료 ${r.relatedEntities.length}건`} memoryKey={k("related")}>
      <ul className="space-y-1 py-2 text-sm">
        {r.relatedEntities.map((x) => (
          <li key={x.name}>
            {x.name}
            {x.location && <span className="ml-2 text-sub">{x.location}</span>}
          </li>
        ))}
      </ul>
      <p className="text-sm text-sub">기존 투자자 판정에 쓰지 않습니다.</p>
    </Disclosure>
  );

  return (
    <SectionFrame
      id="investment"
      label="투자"
      env={env}
      envKey="funding_history"
      summary={summaryLine(job, "investment")}
      unavailableBody={<div>{related}{limits}</div>}
      footer={
        !loading && r ? (
          <>
            <SourceLine word="reported" label="People Data Labs 회사 카드 (Liner Premium)" detail={`${fmtDay(r.queriedAt)} 조회`} />
            {!pendingFacts && confirmedCount > 0 && <p className="text-xs text-sub">원문 확인 {confirmedCount}곳. 기사·공식 자료 원문 (Liner 검색)</p>}
            <NextLine text="투자기관은 자금 조달의 운용사 목록에서 '이미 투자한 곳'으로 따로 표시합니다." href={`/c/${c.cid}/funding?lane=invest`} linkText="운용사 목록 보기" />
          </>
        ) : null
      }
    >
      {loading ? (
        <Lines n={4} />
      ) : (
        <>
          <p className="text-sm text-sub">최근 라운드</p>
          <ul className="divide-y divide-rule border-y border-rule">
            {rounds.slice(0, 3).map((x) => (
              <li key={x.id}>
                <RoundRow x={x} memoryKey={k(`r-${x.id}`)} />
              </li>
            ))}
          </ul>
          <div className="mt-5">
            <p className="text-sm text-sub">투자기관 {investors.length}곳</p>
            <p className="font-medium">{investors.slice(0, 5).map((i) => i.name).join(", ")}</p>
            {pendingFacts && <p className="mt-1 text-sm text-sub">원문에서 투자자를 더 확인하고 있습니다 (보통 3분 안에 끝남)</p>}
          </div>
          <div className="mt-4">
            {rounds.length > 3 && (
              <Disclosure text={`라운드 ${rounds.length}건 모두 보기`} memoryKey={k("rounds")}>
                <ul className="divide-y divide-rule">
                  {rounds.map((x) => (
                    <li key={x.id}>
                      <RoundRow x={x} memoryKey={k(`ra-${x.id}`)} />
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
            {investors.length > 5 && (
              <Disclosure text={`투자기관 ${investors.length}곳 모두 보기`} memoryKey={k("investors")}>
                <InvestorTable investors={investors} />
              </Disclosure>
            )}
            {related}
            {investArticles > 0 && (
              <Disclosure text={`투자 관련 기사 ${investArticles}건 보기`} memoryKey={k("news")}>
                <NewsList fixed={["투자유치"]} />
              </Disclosure>
            )}
            {limits}
          </div>
        </>
      )}
    </SectionFrame>
  );
}

function InvestorTable({ investors }: { investors: MergedInvestor[] }) {
  const mr = useMore(investors.length, 20, 20);
  return (
    <div>
      <ul id={mr.listId} className="divide-y divide-rule text-sm">
        {investors.slice(0, mr.count).map((i, idx) => (
          <li key={i.key} data-item={idx} tabIndex={-1} className="grid grid-cols-[1fr_auto] items-center gap-2 py-2 sm:grid-cols-[1fr_7em_7em_auto]">
            <span className="font-medium">
              {i.name}
              {i.lead && <span className="ml-2 text-xs text-sub">리드</span>}
            </span>
            <span className="num hidden text-sub sm:block">라운드 {i.roundCount}건</span>
            <span className="num hidden text-sub sm:block">{i.lastDate ?? "날짜 미상"}</span>
            <StatusWord w={i.status} />
          </li>
        ))}
      </ul>
      <MoreButton left={mr.left} step={mr.step} onClick={mr.more} />
    </div>
  );
}

function RoundRow({ x, memoryKey }: { x: Round; memoryKey: string }) {
  const c = useCompany();
  const corp = c.job!.sections.identity.result?.corp;
  const known = [c.job!.company.name, corp?.nameEn ?? "", ...(corp?.names ?? [])].map(normName);
  const date = x.date ?? (x.reportedDate ? `보도 ${x.reportedDate}` : "날짜 미상");
  const head = (
    <span className="block">
      <span className="grid grid-cols-[6.5em_1fr] items-baseline gap-x-3 sm:grid-cols-[7em_7em_1fr_auto]">
        <span className="num text-sm text-sub">{date}</span>
        <span className="font-medium">{stageKo(x.round)}</span>
        <span className="num col-start-2 font-semibold sm:col-start-auto">{x.amount ?? "미공개"}</span>
        <span className="col-start-2 text-sm text-sub sm:col-start-auto">투자기관 {x.investors.length}곳</span>
      </span>
      {x.otherAmounts.length > 0 && (
        <span className="mt-1 flex flex-wrap items-center gap-2 text-sm sm:ml-[14em]">
          <span>다른 자료 금액: {x.otherAmounts.join(", ")}</span>
          <StatusWord w="conflicting" />
        </span>
      )}
    </span>
  );
  return (
    <DetailRow head={head} memoryKey={memoryKey}>
      <div className="space-y-2">
        <p>
          <span className="text-sub">투자기관 </span>
          {x.investors.map((n, i) => (
            <span key={n}>
              {i > 0 && ", "}
              {n}
              {x.lead.includes(n) && <span className="text-xs text-sub"> (리드)</span>}
            </span>
          ))}
        </p>
        {x.entity && (
          <p>
            투자 대상: {x.entity}
            {!known.includes(normName(x.entity)) && " (이름이 다름)"}
          </p>
        )}
        <p className="text-sm">
          <span className="text-sub">자료의 원래 표기: </span>
          {x.round ?? "단계 미공개"}
          {x.raw ? `, ${x.raw}` : ""}
        </p>
        {x.sources.map((s, i) => (
          <SourceLine key={i} label={s.type === "Premium" ? `${s.label} (Liner Premium)` : `${s.label} (Liner 검색)`} detail={null} url={s.url} word="reported" />
        ))}
      </div>
    </DetailRow>
  );
}
