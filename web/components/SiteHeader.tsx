import Link from "next/link";
import type { ReactNode } from "react";

/** 서비스 이름 글자표. 누르면 시작 화면 */
export function Wordmark() {
  return (
    <Link href="/" className="inline-flex min-h-11 items-center gap-2 text-lg font-bold tracking-tight text-ink">
      <svg aria-hidden width="18" height="18" viewBox="0 0 18 18">
        <rect x="1" y="10" width="4" height="7" fill="var(--color-ink)" />
        <rect x="7" y="6" width="4" height="11" fill="var(--color-ink)" />
        <rect x="13" y="1" width="4" height="16" fill="var(--color-ledger)" />
      </svg>
      성장노트
    </Link>
  );
}

/** 회사가 없는 화면(/, /funding)의 머리줄 */
export function SiteHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="no-print border-b border-rule bg-paper">
      <div className="mx-auto flex min-h-14 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
        <Wordmark />
        {right}
      </div>
    </header>
  );
}
