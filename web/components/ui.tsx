import type { ReactNode } from "react";
import type { FactStatus, Lane, Verdict } from "@/lib/data";

const statusStyle: Record<FactStatus, string> = {
  "대조 전": "border-line bg-paper text-muted",
  미공개: "border-warn/30 bg-warn-soft text-warn",
  "시연 가정": "border-dashed border-ink/40 bg-card text-ink",
  가상: "border-dashed border-muted/60 bg-card text-muted",
};

export function StatusBadge({ status }: { status: FactStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusStyle[status]}`}>
      {status === "대조 전" ? "원문 대조 전" : status}
    </span>
  );
}

const verdictText: Record<Verdict, string> = { match: "조건 일치", check: "추가 확인 필요", excluded: "제외" };
const verdictStyle: Record<Verdict, string> = {
  match: "bg-accent-soft text-accent",
  check: "bg-debt-soft text-debt",
  excluded: "bg-line/70 text-muted",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${verdictStyle[verdict]}`}>
      {verdictText[verdict]}
    </span>
  );
}

export const laneName: Record<Lane, string> = { debt: "빌리기", equity: "투자받기" };
export const laneDesc: Record<Lane, string> = { debt: "은행대출 · 보증 · 정책자금", equity: "펀드 · 운용사 · 기존 투자사" };
export const laneColor: Record<Lane, string> = { debt: "text-debt", equity: "text-equity" };
export const laneSoft: Record<Lane, string> = { debt: "bg-debt-soft", equity: "bg-equity-soft" };
export const laneBar: Record<Lane, string> = { debt: "bg-debt", equity: "bg-equity" };

export function Tag({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded border border-line bg-card px-1.5 py-0.5 text-xs text-muted ${className}`}>
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-card ${className}`}>{children}</section>;
}

export function SectionTitle({ kicker, title, desc }: { kicker?: string; title: string; desc?: string }) {
  return (
    <div className="mb-4">
      {kicker && <p className="text-xs font-semibold tracking-wide text-accent">{kicker}</p>}
      <h2 className="mt-0.5 text-xl font-bold tracking-tight">{title}</h2>
      {desc && <p className="mt-1 text-sm text-muted">{desc}</p>}
    </div>
  );
}
