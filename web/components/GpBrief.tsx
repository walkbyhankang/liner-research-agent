"use client";

import { useState } from "react";
import { Working } from "@/components/Working";
import { API_BASE, useCompany, useHealth } from "@/lib/company";
import { runTask } from "@/lib/tasks";
import { useTask } from "@/lib/useTask";

type Fact = { kind: string; text: string; quote: string; sourceUrl: string; sourceHost: string };
type Brief = { gp: string; facts: Fact[]; fit: { text: string; fact: number }[]; questions: string[]; sources: { title: string; url: string; host: string }[]; searched: number };

const isBrief = (v: unknown): v is Brief => {
  const o = v as Brief;
  return Boolean(o && Array.isArray(o.facts) && Array.isArray(o.fit) && Array.isArray(o.questions) && Array.isArray(o.sources));
};
const webUrl = (u: string) => /^https?:\/\//.test(u);

/**
 * 운용사 한 곳을 대신 검색해 확인되는 사실을 한 줄씩 보여주고, 회사 조건과 맞닿는 점을 그 사실에 근거해 적는다.
 * 유료 호출(검색 1회, 모델 1회)이라 버튼을 눌렀을 때만 실행한다. 더 찾아보려는 사람을 위해 웹 검색 링크도 남긴다.
 */
export function GpBrief({ gp, region, biz }: { gp: string; region: string; biz: string }) {
  const company = useCompany();
  const health = useHealth();
  // 진행 상태와 결과는 카드 밖의 공용 저장소에 운용사·회사 정보별로 둔다. 저장 보기로 옮기거나 필터를 바꿔도 남는다.
  // 회사 정보가 바뀌면 '맞닿는 점'이 달라지므로 열쇠가 달라져 이전 결과는 쓰이지 않는다
  const key = JSON.stringify(["gp", gp, region, biz, company]);
  const state = useTask<Brief>(key);
  const [ranKey, setRanKey] = useState("");
  const stale = ranKey !== "" && ranKey !== key && state.status === "idle";
  const searchUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(`${gp} 투자 문의`)}`;
  const available = health.state === "up" && health.hasKey;

  const run = () => {
    setRanKey(key);
    const payload = JSON.stringify({ gp, company: { ...company, region, biz } });
    runTask<Brief>(key, async () => {
      const res = await fetch(`${API_BASE}/api/gp/brief`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `요청 실패(${res.status})`);
      if (!isBrief(body)) throw new Error("결과 형식이 올바르지 않습니다");
      return body;
    });
  };

  const more = (
    <a href={searchUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-lg border border-line px-2.5 text-sm font-semibold text-ink hover:border-ink/40">
      웹에서 더 찾기 ↗
    </a>
  );

  if (state.status === "loading") {
    return <Working title={`${gp} 관련 자료를 검색하고 있습니다`} expected="10~20초" slowAfter={45} steps={["웹 검색(8건 이내)", "확인되는 사실 추리기", "회사 조건과 견주기"]} />;
  }

  if (state.status !== "done" || !state.data) {
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {available && (
            <button onClick={run} className="inline-flex min-h-10 items-center rounded-lg bg-ink px-3 text-sm font-semibold text-white">
              대신 검색해 요약하기
            </button>
          )}
          {more}
        </div>
        {available && <p className="text-xs text-muted">검색 결과 8건 이내에서 투자 분야·사례·제안 경로를 찾아 한 줄씩 정리합니다.</p>}
        {stale && <p className="text-xs text-debt">회사 정보가 바뀌어 이전 요약을 지웠습니다.</p>}
        {state.status === "error" && <p className="text-xs text-warn">실패: {state.error}</p>}
      </div>
    );
  }

  const { facts, fit, questions, sources, searched } = state.data;
  return (
    <div className="space-y-3 rounded-lg bg-paper p-3 text-sm">
      {facts.length === 0 ? (
        <p className="text-muted">검색 결과 {searched}건에서 이 운용사에 대해 확인되는 내용을 찾지 못했습니다.</p>
      ) : (
        <ul className="space-y-2">
          {facts.map((f, i) => (
            <li key={i}>
              <p>
                <span className="mr-1.5 rounded bg-equity-soft px-1.5 py-0.5 text-xs font-semibold text-equity">{f.kind}</span>
                {f.text}
              </p>
              <p className="mt-0.5 border-l-2 border-line pl-2 text-xs text-muted">
                “{f.quote}”{" "}
                {webUrl(f.sourceUrl) && (
                  <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">
                    {f.sourceHost || "출처"} ↗
                  </a>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}

      {fit.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-accent">우리 회사와 맞닿는 점</p>
          <ul className="mt-1 space-y-1">
            {fit.map((x, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-accent">✓</span>
                <span>
                  {x.text} <span className="text-xs text-muted">(근거: {facts[x.fact]?.kind})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {questions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-debt">운용사에 확인할 것</p>
          <ul className="mt-1 space-y-1">
            {questions.map((q) => (
              <li key={q} className="flex gap-1.5">
                <span className="text-debt">?</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sources.length > 0 && (
        <details>
          <summary className="flex min-h-10 cursor-pointer items-center text-xs font-semibold text-muted">검색 결과 {sources.length}건 보기</summary>
          <ul className="space-y-1">
            {sources.filter((s) => webUrl(s.url)).map((s) => (
              <li key={s.url} className="truncate text-xs">
                <a href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {s.title || s.url}
                </a>
                <span className="ml-1 text-muted">{s.host}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-xs text-muted">
        검색 결과의 제목과 발췌에서 문장이 그대로 확인되는 내용만 적었습니다. 원문 전체를 읽은 것이 아니고, 투자 가능성을 판단한 것도 아닙니다.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {more}
        <button onClick={run} className="inline-flex min-h-10 items-center rounded-lg border border-line px-2.5 text-sm font-semibold hover:border-ink/40">
          다시 검색
        </button>
      </div>
    </div>
  );
}
