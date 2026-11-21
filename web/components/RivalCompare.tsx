"use client";

import { useState } from "react";
import { Working } from "@/components/Working";
import { API_BASE, useLookup, type Analysis } from "@/lib/company";
import { rivalCompany, usableRival } from "@/lib/rival";
import { runTask } from "@/lib/tasks";
import { useTask } from "@/lib/useTask";

const rowKey = (r: { field: string; quote: string }) => `${r.field}|${r.quote}`;

/**
 * 같은 공고를 경쟁사 조건으로 다시 대조해, 지금은 충족하지 못하지만 경쟁사 수준이면 충족되는 조건을 보여준다.
 * 지역·기업 유형·필요 자금은 우리 회사 값을 그대로 쓰고, 업종·설립 시기·직원 수·매출·투자 이력만 경쟁사 값으로 바꾼다.
 * 경쟁사 목록은 회사명 조회 결과에서 온다. 조회 결과가 없으면 아무것도 그리지 않는다.
 */
export function RivalCompare({ programId, region, biz, need, mine }: { programId: string; region: string; biz: string; need: string; mine: Analysis }) {
  const found = useLookup();
  const rivals = found?.competitors ?? [];
  const [name, setName] = useState("");
  const picked = rivals.find((r) => r.name === name) ?? rivals[0];
  // 추정이거나 출처가 엇갈리는 경쟁사 값은 rivalCompany 가 비워서 보낸다
  const payload = picked ? JSON.stringify({ programId, company: rivalCompany(picked, { region, biz, need }) }) : "";
  // 결과는 공용 저장소에 '공고 + 보낸 경쟁사 조건'별로 둔다. 다른 경쟁사를 고르면 열쇠가 달라 그 경쟁사의 결과만 보인다
  const state = useTask<Analysis>(JSON.stringify(["rival", payload]));
  if (!picked) return null;

  const run = () => {
    runTask<Analysis>(JSON.stringify(["rival", payload]), async () => {
      const res = await fetch(`${API_BASE}/api/notice/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `요청 실패(${res.status})`);
      return body as Analysis;
    });
  };

  const theirs = new Map((state.data?.match.rows ?? []).map((r) => [rowKey(r), r]));
  const pairs = mine.match.rows.filter((r) => r.verdict !== "판단 대상 아님").map((r) => ({ mine: r, theirs: theirs.get(rowKey(r)) }));
  const gained = pairs.filter((p) => p.theirs?.verdict === "충족" && p.mine.verdict !== "충족");
  // 경쟁사가 분명히 못 미치는 조건과, 경쟁사 정보가 없어 판단하지 못한 조건은 다른 이야기라 따로 센다
  const lost = pairs.filter((p) => p.mine.verdict === "충족" && p.theirs?.verdict === "미충족");
  const unknown = pairs.filter((p) => p.mine.verdict === "충족" && p.theirs && p.theirs.verdict !== "충족" && p.theirs.verdict !== "미충족");

  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <p className="text-sm font-semibold">경쟁사 조건이라면?</p>
      <p className="mt-0.5 text-xs text-muted">
        우리 회사의 지역·기업 유형·필요 자금은 그대로 두고, 업종·설립 시기·직원 수·매출·투자 이력만 경쟁사 값으로 바꿔 같은 공고를 대조합니다. 지금 부족한 요건이 무엇인지 볼 수 있습니다.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="경쟁사 선택"
          value={picked.name}
          onChange={(e) => setName(e.target.value)}
          className="min-h-10 min-w-0 max-w-full rounded-lg border border-line bg-card px-2 text-sm outline-none focus:border-ink/50"
        >
          {rivals.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        <button onClick={run} disabled={state.status === "loading"} className="inline-flex min-h-10 items-center rounded-lg bg-ink px-3 text-sm font-semibold text-white disabled:opacity-40">
          이 조건으로 대조
        </button>
      </div>
      {!usableRival(picked) && (
        <p className="mt-2 text-xs text-debt">
          {picked.name}의 공개 정보는 추정이거나 출처가 엇갈려 대조에 넣지 않습니다. 이 경쟁사로 대조하면 대부분 ‘확인 필요’로 나옵니다.
        </p>
      )}
      {state.status === "error" && <p className="mt-2 text-xs text-warn">실패: {state.error}</p>}
      {state.status === "loading" && (
        <div className="mt-2">
          <Working title={`${picked.name} 조건으로 대조하고 있습니다`} expected="20~30초" slowAfter={60} steps={["저장된 공고 조건 불러오기", "경쟁사 조건과 견주기"]} />
        </div>
      )}
      {state.status === "done" && state.data && (
        <div className="mt-3 space-y-2 text-sm">
          <p>
            <span className="font-semibold">
              {picked.name} 조건의 종합 판정: {state.data.match.overall}
            </span>
            <span className="ml-1.5 text-xs text-muted">(우리 회사: {mine.match.overall})</span>
          </p>
          {gained.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-accent">경쟁사 조건이면 충족되는 조건 {gained.length}건 — 갖추면 열리는 요건</p>
              <ul className="mt-1 space-y-1.5">
                {gained.map((p) => (
                  <li key={rowKey(p.mine)}>
                    <p>
                      <span className="mr-1 text-xs font-semibold text-muted">{p.mine.field}</span>
                      {p.mine.requirement}
                    </p>
                    <p className="text-xs text-muted">
                      우리 회사 {p.mine.verdict} → 경쟁사 충족{p.theirs?.reason ? ` · ${p.theirs.reason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted">경쟁사 조건으로 바꿔도 새로 충족되는 조건이 없습니다. 공개된 경쟁사 정보가 적으면 차이가 드러나지 않습니다.</p>
          )}
          {lost.length > 0 && <p className="text-xs text-muted">반대로 우리 회사는 충족하지만 경쟁사 조건으로는 충족하지 못하는 조건이 {lost.length}건 있습니다.</p>}
          {unknown.length > 0 && (
            <p className="text-xs text-muted">우리 회사는 충족하지만 경쟁사는 공개 정보가 없어 판단하지 못한 조건이 {unknown.length}건 있습니다. 경쟁사가 못 미친다는 뜻은 아닙니다.</p>
          )}
          <p className="text-xs text-muted">
            경쟁사의 인증, 체납·대출 여부처럼 공개 자료에서 확인하지 못한 값은 ‘확인 필요’로 남습니다. 경쟁사가 이 자금을 실제로 받았다는 뜻이 아닙니다.
          </p>
        </div>
      )}
    </div>
  );
}
