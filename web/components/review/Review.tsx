"use client";

// 심사 준비(screens 6절). 갈래 둘(정책자금·지원사업 / 투자)은 탭 목록이고 주소 ?tab= 에 남긴다. 모든 폭에서 한 단.
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useCompany } from "@/components/company/context";
import { Grants } from "@/components/review/Grants";
import { Invest } from "@/components/review/Invest";
import { savedNotices } from "@/lib/local";

type Tab = "grants" | "invest";

export function ReviewScreen() {
  const c = useCompany();
  const sp = useSearchParams();
  const path = usePathname();
  const grants = savedNotices(c.local.saved).length;
  const gps = c.local.saved.filter((s) => s.kind === "gp").length;
  const fromUrl = sp.get("tab");
  const urlTab: Tab | null = fromUrl === "invest" ? "invest" : fromUrl === "grants" ? "grants" : null;
  const [tab, setTab] = useState<Tab | null>(urlTab);
  // 주소의 ?tab= 이 바뀌면 그것을 따른다. Next 가 지나온 화면을 살려 두므로(next.config cacheComponents) 처음 값만 읽으면,
  // 투자 갈래를 보다 회사 분석의 "마감 임박 담은 공고" 링크(?tab=grants)로 돌아와도 투자 갈래가 남는다
  const [urlSeen, setUrlSeen] = useState(fromUrl);
  if (fromUrl !== urlSeen) {
    setUrlSeen(fromUrl);
    if (urlTab) setTab(urlTab);
  }
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  // 처음 갈래: 담은 공고가 있으면 정책자금·지원사업, 없고 담은 운용사가 있으면 투자(R-01)
  const current: Tab = tab ?? (c.local.loaded && grants === 0 && gps > 0 ? "invest" : "grants");

  useEffect(() => {
    if (!tab) return;
    window.history.replaceState(window.history.state, "", `${path}?tab=${tab}${window.location.hash}`);
  }, [tab, path]);

  useEffect(() => {
    if (current === "invest" && window.location.hash === "#evidence" && c.job) requestAnimationFrame(() => document.getElementById("evidence")?.scrollIntoView({ block: "start" }));
  }, [current, c.job]);

  const items: [Tab, string, number][] = [
    ["grants", "정책자금·지원사업", grants],
    ["invest", "투자", gps],
  ];
  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-6 sm:px-6">
      {/* 넓은 화면 글 폭 760(모든 단계 화면 같은 규칙, visual-plan 7절). 1024 미만은 지금 그대로 720 */}
      <div className="max-w-[720px] lg:max-w-[760px]">
        <h1 className="text-2xl font-semibold">심사 준비</h1>
        <div role="tablist" aria-label="심사 준비 갈래" className="no-print sticky top-[49px] z-20 -mx-4 mt-4 flex border-b border-rule bg-paper px-4 sm:static sm:mx-0 sm:px-0">
          {items.map(([id, label, n], i) => (
            <button
              key={id}
              ref={(el) => void (tabs.current[i] = el)}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={current === id}
              aria-controls={`panel-${id}`}
              tabIndex={current === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const next = items[(i + 1) % 2][0];
                setTab(next);
                tabs.current[(i + 1) % 2]?.focus();
              }}
              className={`min-h-12 flex-1 px-4 text-[15px] sm:flex-none ${current === id ? "font-semibold text-ink shadow-[inset_0_-3px_0_var(--color-ledger)]" : "text-ink"}`}
            >
              {label} <span className="num">{n}</span>
            </button>
          ))}
        </div>
        <div className="mt-6">
          <div role="tabpanel" id="panel-grants" aria-labelledby="tab-grants" hidden={current !== "grants"}>
            <Grants />
          </div>
          <div role="tabpanel" id="panel-invest" aria-labelledby="tab-invest" hidden={current !== "invest"}>
            <Invest />
          </div>
        </div>
      </div>
    </main>
  );
}
