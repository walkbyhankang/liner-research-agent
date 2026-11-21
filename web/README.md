# 펀딩노트 화면 (Next.js)

저장소 루트 `README.md` 의 "펀딩노트" 절에 전체 실행 방법이 있다.

```bash
npm install
npm run build
npm run start -- -p 3100   # http://localhost:3100
npm test                   # lib/*.test.mjs
```

- 공고·펀드 목록은 `public/data/` 의 스냅샷을 읽는다(`scripts/fetch_public_data.py` 가 만든다).
- 자격 대조·회사 조회·운용사 요약은 같은 주소의 `/api/*` 로 요청하고, `app/api/[...path]/route.ts` 가 분석 서버로 넘긴다.
  분석 서버 주소는 `FUNDING_API_ORIGIN`(기본 `http://127.0.0.1:8000`)이다.
- 화면 측정 스크립트: `scripts/ux-audit.mjs`, `scripts/ux-scenarios.mjs` (설치된 Chrome 과 `puppeteer-core` 사용).
