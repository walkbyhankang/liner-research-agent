# 성장노트 화면 (Next.js)

회사 이름 하나로 회사를 분석하고 자금 조달, 심사 준비, 판로, 노트로 잇는 화면이다. 구조·문구는 `docs/ux/`, 데이터 모양은 `docs/contract.md`, 시각 계획은 `docs/ux/visual-plan.md`.

```bash
npm ci
npm run build
npm run start -- -p 3100   # http://localhost:3100
npm test                   # lib/*.test.mjs (규칙 단위 시험, 가짜 응답 사용)
```

- 분석 서버 요청은 같은 주소의 `/api/*`로 보내고 `app/api/[...path]/route.ts`가 분석 서버로 넘긴다(계약 2.14). 분석 서버 주소는 `FUNDING_API_ORIGIN`(기본 `http://127.0.0.1:8000`).
- 공고·펀드 목록은 `public/data/`의 스냅샷을 읽는다(`scripts/fetch_public_data.py`가 만든다).
- 고친 값, 담은 항목, 대조 결과, 노트는 브라우저 IndexedDB(`growthnote`)에만 둔다. 저장소를 쓸 수 없으면 메모리에 두고 화면 위 띠로 알린다.

## 가짜 서버로 화면 점검 (개발용)

분석 서버 없이 `fixtures/analysis/`의 가짜 응답(합성 데이터)으로 화면을 띄우고 완료 기준(`docs/ux/acceptance.md`)을 자동으로 점검한다. 가짜 서버는 개발·시험 전용이며 배포 코드에 섞지 않는다.

```bash
node scripts/mock_api.mjs 8200 &
FUNDING_API_ORIGIN=http://127.0.0.1:8200 npx next start -p 3200 &
node scripts/ux-check.mjs [화면 저장 폴더]   # 설치된 Chrome 과 puppeteer-core 사용(CHROME_PATH 로 바꿀 수 있다)
```

- 이미 투자함·경쟁사에 투자·공고문 대조 시험은 점검 스크립트가 가짜 운용사·가짜 공고를 `/data/*.json` 응답에 끼워 넣어 한다(실제 스냅샷 파일은 바꾸지 않는다).
- 점검 스크립트의 브라우저 시계는 가짜 응답 기준일(2026-11-22 21:00, 한국 시간)로 고정한다.
