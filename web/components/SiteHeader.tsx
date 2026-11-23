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

/**
 * 회사가 없는 화면(/, /funding)의 머리줄. 높이는 회사 화면 머리줄과 같은 48px + 아래 선 1px(screens 1.1, 2026-11-23 맞춤).
 * 오른쪽 내용이 좁은 폭에서 줄을 바꾸면 최소 높이라 늘어날 수 있다. 이 머리줄은 위에 붙지 않는다(회사 화면 머리줄은 붙는다)
 */
export function SiteHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="no-print border-b border-rule bg-paper">
      <div className="mx-auto flex min-h-12 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
        <Wordmark />
        {right}
      </div>
    </header>
  );
}
