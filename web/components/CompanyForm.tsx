"use client";

import { useState } from "react";
import { Spinner, Working } from "@/components/Working";
import { splitInvestors } from "@/lib/finder";
import { API_BASE, applyDraft, companyFilled, isLookupResponse, removeLookup, resetCompany, useLeftover, setCompany, setLookup, statusLabel, useCompany, useHealth, useLookup, type Company } from "@/lib/company";

const fields: { key: keyof Company; label: string; placeholder: string; type?: string; wide?: boolean }[] = [
  { key: "founded", label: "설립 연월", placeholder: "", type: "month" },
  { key: "industry", label: "업종", placeholder: "예: 소프트웨어 개발 및 공급업(SaaS)" },
  { key: "employees", label: "상시근로자 수", placeholder: "예: 12명" },
  { key: "revenue", label: "최근 연매출", placeholder: "예: 8억 원" },
  { key: "need", label: "필요한 자금", placeholder: "예: 운전자금 3억 원(인건비)" },
  { key: "notes", label: "그 밖의 사항", placeholder: "예: 벤처기업 확인, 기존 대출 없음, 세금 체납 없음", wide: true },
];
const inputClass = "mt-1 block min-h-10 w-full rounded-lg border border-line bg-card px-3 text-sm font-normal text-ink outline-none focus:border-ink/50";

const POLL_MS = 2000;
const MAX_WAIT_MS = 40 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 조회 작업이 끝날 때까지 2초마다 상태를 묻는다. 잠깐의 연결 오류는 몇 번까지 넘어간다. */
async function waitForLookup(jobId: string, onStage: (stage: string) => void): Promise<unknown> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let failures = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/company/lookup/${jobId}`);
    } catch {
      if (++failures > 5) throw new Error("분석 서버와 연결이 끊겼습니다");
      continue;
    }
    const body = await res.json().catch(() => null);
    if (res.status === 404) throw new Error(typeof body?.detail === "string" ? body.detail : "조회 작업을 찾을 수 없습니다");
    if (!res.ok || !body) {
      if (++failures > 5) throw new Error(`진행 상황을 확인하지 못했습니다(${res.status})`);
      continue;
    }
    failures = 0;
    if (body.status === "done") return body.result;
    if (body.status === "error") throw new Error(typeof body.error === "string" ? body.error : "조회에 실패했습니다");
    if (typeof body.stage === "string") onStage(body.stage);
  }
  throw new Error("조회가 너무 오래 걸려 기다리기를 멈췄습니다");
}

/** 공고문 자격 대조에 쓰는 회사 정보. 이 브라우저에만 저장된다. 회사명으로 공개자료를 조회해 초안을 채울 수 있다. */
export function CompanyForm() {
  const company = useCompany();
  const found = useLookup();
  const health = useHealth();
  const leftover = useLeftover();
  const investors = splitInvestors(found?.investors ?? []);
  const [state, setState] = useState<{ status: "idle" | "loading" | "error"; error?: string; stage?: string }>({ status: "idle" });
  const filled = companyFilled(company);
  const canLookup = health.state === "up" && health.hasKey && company.name.trim().length >= 2 && state.status !== "loading";

  const runLookup = async () => {
    const name = company.name.trim();
    setState({ status: "loading" });
    try {
      // 조회는 2분 넘게 걸린다. 작업을 시작해 번호를 받고, 끝날 때까지 진행 상황을 묻는다
      const started = await fetch(`${API_BASE}/api/company/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const startBody = await started.json().catch(() => null);
      if (!started.ok || typeof startBody?.jobId !== "string") throw new Error(typeof startBody?.detail === "string" ? startBody.detail : `요청 실패(${started.status})`);
      const body = await waitForLookup(startBody.jobId, (stage) => setState({ status: "loading", stage }));
      if (!isLookupResponse(body)) throw new Error("조회 결과 형식이 올바르지 않습니다");
      // 응답이 온 시점의 회사 정보에 반영한다. 기다리는 동안 회사명을 바꿨으면 결과를 버린다
      const applied = applyDraft(body.draft, name);
      if (applied === null) {
        setState({ status: "error", error: "조회하는 동안 회사명이 바뀌어 결과를 반영하지 않았습니다. 다시 눌러 주세요." });
        return;
      }
      // 이번 조회가 실제로 채운 값을 함께 남긴다. 나중에 지우거나 회사를 바꿀 때 이 값만 정리한다
      setLookup({ ...body, applied });
      setState({ status: "idle" });
    } catch (e) {
      setState({ status: "error", error: e instanceof Error ? e.message : "요청 실패" });
    }
  };

  return (
    <details className="mt-3 rounded-lg border border-line bg-paper px-3">
      <summary className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold">
        우리 회사 정보
        <span className={`rounded-full px-2 py-0.5 text-xs ${filled >= 3 ? "bg-accent-soft text-accent" : "bg-line/70 text-muted"}`}>{filled}/5 입력</span>
        <span className="hidden text-xs font-normal text-muted sm:inline">공고문 자격 대조에 쓰입니다</span>
      </summary>
      <div className="grid gap-3 pb-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="sm:col-span-2 lg:col-span-3">
          <label className="block text-xs font-semibold text-muted">
            회사명
            <span className="flex gap-2">
              <input value={company.name} placeholder="예: 주식회사 가나다" onChange={(e) => setCompany({ name: e.target.value })} className={inputClass} />
              <button
                type="button"
                onClick={runLookup}
                disabled={!canLookup}
                className="mt-1 inline-flex min-h-10 shrink-0 items-center rounded-lg bg-ink px-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                {state.status === "loading" ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" />
                    찾는 중
                  </>
                ) : (
                  "공개자료로 채우기"
                )}
              </button>
            </span>
          </label>
          {state.status === "loading" && (
            <div className="mt-2">
              <Working
                title="공개자료에서 회사 정보를 찾고 있습니다"
                expected="2~3분"
                slowAfter={240}
                current={state.stage}
                steps={["보도·공식 자료 검색", "원문 확인", "회사 정보·기존 투자자·경쟁사 추출", "경쟁사 투자 이력 조회"]}
              />
            </div>
          )}
          <p className="mt-1 text-xs font-normal text-muted" role={state.status === "error" ? "alert" : undefined}>
            {state.status === "loading"
              ? "찾는 동안 다른 칸을 먼저 채워도 됩니다. 직접 적거나 고친 값은 바뀌지 않고, 이전 조회로 채워진 값만 새 결과로 바뀝니다."
              : state.status === "error"
                ? `조회 실패: ${state.error}`
                : health.state === "up" && health.hasKey
                  ? "회사명을 넣고 누르면 설립일·사업·직원 수·기존 투자자와 경쟁사를 공개자료에서 찾고, 회사 정보는 빈칸에 채웁니다."
                  : "공개자료 조회는 분석 서버가 켜져 있을 때 쓸 수 있습니다."}
          </p>
        </div>

        {leftover && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm sm:col-span-2 lg:col-span-3" role="alert">
            <p className="text-warn">
              아래 {leftover.count}개 항목은 ‘{leftover.from}’ 조회에서 채운 값입니다. 다른 회사라면 지운 뒤 진행하세요.
            </p>
            <button type="button" onClick={removeLookup} className="inline-flex min-h-10 items-center rounded-lg bg-warn px-3 text-xs font-semibold text-white">
              이전 회사 값 지우기
            </button>
          </div>
        )}

        {found && (
          <div className="rounded-lg border border-line bg-card p-3 text-sm sm:col-span-2 lg:col-span-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">
                ‘{found.query}’ 공개자료 조회 결과 <span className="text-xs font-normal text-muted">초안입니다. 값을 확인한 뒤 쓰세요.</span>
              </p>
              <button type="button" onClick={removeLookup} className="inline-flex min-h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold">
                조회 결과와 채운 값 지우기
              </button>
            </div>
            {found.fields.length === 0 && <p className="mt-1 text-muted">공개자료에서 회사 정보를 찾지 못했습니다.</p>}
            <ul className="mt-1 divide-y divide-line">
              {found.fields.map((f) => (
                <li key={f.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
                  <span className="w-20 shrink-0 text-xs font-semibold text-muted">{f.label}</span>
                  <span className="min-w-0 flex-1">{f.value}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${f.status === "confirmed" ? "bg-accent-soft text-accent" : f.status === "conflicting" ? "bg-warn-soft text-warn" : "bg-line/70 text-muted"}`}>
                    {statusLabel[f.status] ?? "상태 미상"}
                  </span>
                  {/^https?:\/\//.test(f.sourceUrl) && (
                    <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-accent hover:underline">
                      출처 ↗
                    </a>
                  )}
                  {f.note && <span className="w-full text-xs text-debt">{f.note}</span>}
                </li>
              ))}
            </ul>
            {(found.competitors?.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-line pt-2">
                <p className="text-xs font-semibold text-muted">경쟁사 {found.competitors!.length}곳</p>
                <ul className="mt-1 divide-y divide-line">
                  {found.competitors!.map((c) => (
                    <li key={c.name} className="py-1.5">
                      <p>
                        <span className="font-semibold">{c.name}</span>
                        {c.relation && <span className="ml-1.5 text-xs text-muted">{c.relation}</span>}
                        {/^https?:\/\//.test(c.sourceUrl) && (
                          <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="ml-1.5 text-xs font-semibold text-accent hover:underline">
                            출처 ↗
                          </a>
                        )}
                      </p>
                      <p className="text-xs text-muted">
                        {[c.products, c.employees && `직원 ${c.employees}`, c.revenue && `매출 ${c.revenue}`, c.funding && `투자 ${c.funding}`].filter(Boolean).join(" · ") || "공개된 수치 없음"}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(found.rivalFunding?.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-line pt-2">
                <p className="text-xs font-semibold text-muted">경쟁사가 받은 투자 {found.rivalFunding!.length}건</p>
                <ul className="mt-1 divide-y divide-line">
                  {found.rivalFunding!.map((r, i) => (
                    <li key={i} className="py-1.5">
                      <p>
                        <span className="font-semibold">{r.company}</span>
                        <span className="ml-1.5">{[r.round, r.amount, r.date].filter(Boolean).join(" · ")}</span>
                        {/^https?:\/\//.test(r.sourceUrl) && (
                          <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="ml-1.5 text-xs font-semibold text-accent hover:underline">
                            출처 ↗
                          </a>
                        )}
                      </p>
                      {r.investors.length > 0 && <p className="text-xs">투자사: {r.investors.join(", ")}</p>}
                      <p className="border-l-2 border-line pl-2 text-xs text-muted">검색 결과: “{r.quote}”</p>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted">투자 유치만 찾습니다. 경쟁사가 받은 융자·보증은 대부분 공개되지 않습니다.</p>
              </div>
            )}
            {investors.established.length > 0 && (
              <p className="mt-2 text-sm">
                <span className="mr-1 text-xs font-semibold text-muted">기존 투자자 {investors.established.length}곳</span>
                {investors.established.map((i) => i.name).join(" · ")}
                <span className="mt-0.5 block text-xs text-muted">아래 운용사 목록에서 기존 투자자로 따로 표시합니다.</span>
              </p>
            )}
            {investors.uncertain.length > 0 && (
              <p className="mt-2 text-sm">
                <span className="mr-1 text-xs font-semibold text-debt">확인되지 않은 투자자 후보 {investors.uncertain.length}곳</span>
                {investors.uncertain.map((i) => `${i.name}(${statusLabel[i.status] ?? "상태 미상"})`).join(" · ")}
                <span className="mt-0.5 block text-xs text-muted">추정이거나 출처가 엇갈려 기존 투자자로 표시하지 않습니다. 실제 주주인지 확인하세요.</span>
              </p>
            )}
          </div>
        )}

        {fields.map((f) => (
          <label key={f.key} className={`block text-xs font-semibold text-muted ${f.wide ? "sm:col-span-2 lg:col-span-3" : ""}`}>
            {f.label}
            <input type={f.type ?? "text"} value={company[f.key]} placeholder={f.placeholder} onChange={(e) => setCompany({ [f.key]: e.target.value })} className={inputClass} />
          </label>
        ))}
        <div className="sm:col-span-2 lg:col-span-3">
          <button type="button" onClick={resetCompany} className="inline-flex min-h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold hover:border-ink/40">
            회사 정보 모두 비우기
          </button>
        </div>
        <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">
          입력한 값은 이 브라우저에만 저장되고, 조회나 자격 대조를 실행할 때만 분석 서버로 전송됩니다. 비워 둔 항목은 ‘확인 필요’로 판정됩니다.
        </p>
      </div>
    </details>
  );
}
