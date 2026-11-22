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
