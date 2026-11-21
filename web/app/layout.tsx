import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NavLinks } from "@/components/NavLinks";
import "./globals.css";

export const metadata: Metadata = {
  title: "펀딩노트 — 중소·벤처기업 자금 찾기",
  description: "흩어진 정책자금 공고와 벤처펀드 정보를 한곳에서 우리 회사 조건과 대조합니다.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-full flex flex-col">
        <header className="no-print sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
            <Link href="/" className="flex min-h-10 items-center gap-2">
              <span className="text-lg font-bold tracking-tight">펀딩노트</span>
              <span className="hidden text-xs text-muted sm:inline">중소·벤처기업 자금 찾기</span>
            </Link>
            <Suspense fallback={null}>
              <NavLinks />
            </Suspense>
          </div>
        </header>
        <div className="no-print border-b border-line bg-warn-soft">
          <p className="mx-auto max-w-6xl px-4 py-1 text-xs text-warn">
            POC · 분류값으로 거른 결과입니다. 세부 자격은 공고문에서 확인하세요.
          </p>
        </div>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-3 sm:py-6">{children}</main>
        <footer className="no-print border-t border-line">
          <p className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted">
            투자 확률이나 점수는 계산하지 않습니다. 후보마다 맞는 이유와 추가로 확인할 점을 보여줍니다.
          </p>
        </footer>
      </body>
    </html>
  );
}
