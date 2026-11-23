import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // 사례 화면은 지웠다(decisions 4). 옛 주소는 시작 화면으로 보낸다
  async redirects() {
    return [
      { source: "/cases", destination: "/", permanent: false },
      { source: "/cases/:path*", destination: "/", permanent: false },
      { source: "/s/:path*", destination: "/", permanent: false },
      // 판로는 2026-11-23 화면 구조 개편으로 자금 조달의 셋째 갈래가 됐다(screens 5.2). 옛 판로 주소가 끊기지 않게 보낸다
      { source: "/c/:id/sales", destination: "/c/:id/funding?lane=sales", permanent: false },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
