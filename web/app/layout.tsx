import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "성장노트", template: "%s | 성장노트" },
  description: "회사 이름 하나로 공공 자료와 공개 보도를 모아 회사를 분석하고, 받을 수 있는 자금, 심사 준비, 판로까지 잇습니다.",
  applicationName: "성장노트",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // 글자 다듬기(-webkit-font-smoothing: antialiased)를 쓰지 않는다. macOS 에서 획이 가늘어져 Plex 400 본문이 옅게 보였다(visual-plan 5절)
    <html lang="ko" className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="flex min-h-full flex-col">
        {children}
        <footer className="mt-auto border-t border-rule">
          <p className="mx-auto max-w-[1200px] px-4 py-5 text-sm text-sub sm:px-6">점수나 선정 확률은 만들지 않습니다. 값마다 확인 상태와 출처를 붙입니다.</p>
        </footer>
      </body>
    </html>
  );
}
