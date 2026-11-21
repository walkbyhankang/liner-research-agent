"use client";

import { useState } from "react";
import { Working } from "@/components/Working";
import { RivalCompare } from "@/components/RivalCompare";
import { API_BASE, companyFilled, useCompany, useHealth, type Analysis, type Verdict } from "@/lib/company";
import { runTask } from "@/lib/tasks";
import { useTask } from "@/lib/useTask";

const verdictStyle: Record<Verdict, string> = {
  충족: "bg-accent-soft text-accent",
  미충족: "bg-warn-soft text-warn",
  "확인 필요": "bg-debt-soft text-debt",
  "판단 대상 아님": "bg-line/70 text-muted",
};
const overallStyle: Record<Analysis["match"]["overall"], string> = {
  "신청 검토 가능": "border-accent bg-accent-soft text-accent",
  "대상 아님": "border-warn/40 bg-warn-soft text-warn",
  "확인 후 판단": "border-debt/40 bg-debt-soft text-debt",
};
const ORDER: Verdict[] = ["미충족", "확인 필요", "충족", "판단 대상 아님"];

/** 공고문을 읽어 자격 조건을 뽑고 회사 정보와 대조한다. 유료 호출이라 버튼을 눌렀을 때만 실행한다. */
export function NoticeCheck({ programId, region, biz }: { programId: string; region: string; biz: string }) {
  const company = useCompany();
  const health = useHealth();
  // 진행 상태와 결과는 카드 밖의 공용 저장소에 입력값(공고, 회사 정보, 지역, 기업 유형)별로 둔다.
  // 카드를 접거나 저장 보기로 옮겨도 남고, 같은 공고가 두 곳에 보이면 같은 결과를 함께 본다. 입력값이 바뀌면 열쇠가 달라져 이전 결과는 쓰이지 않는다.
  const key = JSON.stringify(["notice", programId, region, biz, company]);
  const state = useTask<Analysis>(key);
  const [ranKey, setRanKey] = useState("");
  const stale = ranKey !== "" && ranKey !== key && state.status === "idle";

  if (health.state !== "up" || !health.hasKey) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-card px-3 py-2 text-xs text-muted">
        {health.state === "checking" ? "분석 서버 확인 중…" : "공고문 자격 대조는 분석 서버가 켜져 있을 때 쓸 수 있습니다."}
      </p>
    );
  }

  const run = () => {
    setRanKey(key);
    const payload = JSON.stringify({ programId, company: { ...company, region, biz } });
    // 같은 입력의 대조가 이미 진행 중이면 다시 보내지 않는다. 응답은 누른 때의 입력값 열쇠에 저장된다
    runTask<Analysis>(key, async () => {
      const res = await fetch(`${API_BASE}/api/notice/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `요청 실패(${res.status})`);
      return body as Analysis;
    });
  };

  if (state.status === "idle" || state.status === "error") {
    const filled = companyFilled(company);
    return (
      <div className="rounded-lg border border-accent/30 bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={run} className="inline-flex min-h-10 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-white">
            공고문으로 자격 대조하기
          </button>
          <span className="text-xs text-muted">공고문을 읽어 조건을 뽑고 우리 회사와 견줍니다 · 약 30~50초</span>
        </div>
        {stale && <p className="mt-2 text-xs text-debt">회사 정보나 조건이 바뀌어 이전 결과를 지웠습니다. 다시 대조해 주세요.</p>}
        {filled < 3 && <p className="mt-2 text-xs text-debt">위의 ‘우리 회사 정보’를 채우면 판정이 구체적이 됩니다(지금 {filled}/5 항목).</p>}
        {state.status === "error" && <p className="mt-2 text-xs text-warn">실패: {state.error}</p>}
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <Working
        title="공고문을 내려받아 읽고 있습니다"
        expected="30~50초"
        slowAfter={70}
        steps={["공고문 내려받기", "조건과 근거 문장 추출", "원문 대조", "회사 정보와 견주기"]}
      />
    );
  }

  const { extraction, match } = state.data!;
  const rows = [...match.rows].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  const judged = rows.filter((r) => r.verdict !== "판단 대상 아님");
  const others = rows.filter((r) => r.verdict === "판단 대상 아님");
  return (
    <div className="space-y-3 rounded-lg border border-accent/30 bg-card p-3">
      <div className={`rounded-lg border px-3 py-2 ${overallStyle[match.overall]}`}>
        <p className="text-sm font-bold">{match.overall}</p>
        <p className="mt-0.5 text-sm text-ink">{match.overallReason}</p>
      </div>

      <ul className="space-y-2">
        {judged.map((r, i) => (
          <li key={i} className="text-sm">
            <div className="flex items-start gap-2">
              <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${verdictStyle[r.verdict]}`}>{r.verdict}</span>
              <div className="min-w-0">
                <p>
                  <span className="mr-1 text-xs font-semibold text-muted">{r.field}</span>
                  {r.requirement}
                </p>
                {r.reason && <p className="mt-0.5 text-xs text-muted">{r.reason}</p>}
                <p className="mt-1 border-l-2 border-line pl-2 text-xs text-muted">공고문: “{r.quote}”</p>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {others.length > 0 && (
        <details className="text-sm">
          <summary className="flex min-h-10 cursor-pointer items-center text-xs font-semibold text-muted">신청방법·제출서류 등 {others.length}건</summary>
          <ul className="space-y-1.5">
            {others.map((r, i) => (
              <li key={i}>
                <span className="mr-1 text-xs font-semibold text-muted">{r.field}</span>
                {r.requirement}
                <span className="mt-0.5 block border-l-2 border-line pl-2 text-xs text-muted">공고문: “{r.quote}”</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {match.questions.length > 0 && (
        <div>
          <p className="text-xs font-semibold">담당 기관에 물어볼 것</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4 text-sm">
            {match.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </div>
      )}
      {match.documents.length > 0 && (
        <p className="text-sm">
          <span className="mr-1 text-xs font-semibold">준비자료</span>
          {match.documents.join(" · ")}
        </p>
      )}

      <p className="text-xs text-muted">
        근거 문장이 공고문({extraction.doc.kind.toUpperCase()}
        {extraction.doc.pages ? ` ${extraction.doc.pages}쪽` : ""})에 그대로 있는 조건만 표시했습니다
        {extraction.dropped > 0 ? ` · 근거를 확인하지 못한 ${extraction.dropped}건 제외` : ""}
        {extraction.doc.truncated ? " · 공고문이 길어 앞부분만 분석" : ""}
        {extraction.notStated.length > 0 ? ` · 공고문에 없는 항목: ${extraction.notStated.join(", ")}` : ""}. AI가 읽은 결과이므로 신청 전 공고문을 직접 확인하세요.
      </p>
      <RivalCompare key={key} programId={programId} region={region} biz={biz} need={company.need} mine={state.data!} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          추출 {extraction.model}
          {extraction.cached ? "(저장된 결과 사용)" : ""} · 대조 {match.model}
          {match.elapsedSec ? ` ${match.elapsedSec}초` : ""}
        </p>
        <button onClick={run} className="inline-flex min-h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold hover:border-ink/40">
          다시 대조
        </button>
      </div>
    </div>
  );
}
