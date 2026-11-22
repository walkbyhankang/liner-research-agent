"use client";

// 심사 준비(screens 6절). 갈래 둘(정책자금·지원사업 / 투자)은 탭 목록이고 주소 ?tab= 에 남긴다. 모든 폭에서 한 단.
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useCompany } from "@/components/company/context";
import { Grants } from "@/components/review/Grants";
import { Invest } from "@/components/review/Invest";

type Tab = "grants" | "invest";

export function ReviewScreen() {
  const c = useCompany();
  const sp = useSearchParams();
  const path = usePathname();
  const grants = c.local.saved.filter((s) => s.kind === "program" || s.kind === "salesProgram").length;
  const gps = c.local.saved.filter((s) => s.kind === "gp").length;
  const fromUrl = sp.get("tab");
  const [tab, setTab] = useState<Tab | null>(fromUrl === "invest" ? "invest" : fromUrl === "grants" ? "grants" : null);
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
      <div className="max-w-[720px]">
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
              className={`min-h-12 flex-1 px-4 text-[15px] sm:flex-none ${current === id ? "font-semibold text-ink shadow-[inset_0_-3px_0_var(--color-ledger)]" : "text-sub"}`}
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
