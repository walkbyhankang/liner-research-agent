# 가짜 응답 (테스트·개발 전용)

이 폴더의 JSON 은 **테스트와 개발에만 쓰는 합성 데이터**다. 가상의 회사 "가나다테크"와 지어낸 경쟁사·투자기관·기사·특허로 만들었고, 실제 회사·기사·투자자 자료는 없다. 모양은 `docs/contract.md`(계약) 그대로다.

## 지킬 것

- **화면에 "예시"로 보이면 안 된다.** 시작 화면의 "예시 회사로 보기"는 서버에 저장된 실제 분석(`GET /api/example`)만 연다. 이 파일을 `web/public/`, `results/analysis/` 같은 실제 서비스가 읽는 곳에 복사하지 않는다. 화면 코드는 이 폴더를 테스트(`*.test.mjs`, 화면 자동 점검의 가짜 서버)에서만 읽는다.
- 기준일은 **2026-11-22(한국 시간)**이다. 시각이 들어간 기준(30일 넘은 분석, D-n, "오늘 상한")을 시험할 때는 테스트의 "오늘"을 이 날로 고정한다(예: `F-STALE` 은 이 날보다 45일 전 분석).
- 주소는 모두 `https://example.com/…` 이다. 실제 페이지로 가지 않는다.
- 운용사 이름과 맞추는 시험(이미 투자함, 경쟁사에 투자)은 화면 테스트가 **가짜 운용사 목록을 따로 만들어** 쓴다. 예: 운용사 `가나다벤처스`(합친 투자기관에 있음, 원문 확인), `타파하인베스트`(`F-RIVALS` 의 경쟁사 투자기관), `나다라파트너스`(`facts.result.investors` 에만 `inferred` 로 있고 `merged.investors` 에는 없음, 이미 투자함으로 보이면 안 됨). 실제 `web/public/data/funds.json` 의 운용사 이름과 겹치는 가짜 이름은 없다(`tests/test_growth_contract.py` 가 검사).

## 파일 모양

```json
{
  "fixture": "F-FULL",
  "description": "…",
  "baseDate": "2026-11-22",
  "exchanges": [
    {"label": null, "method": "GET", "path": "/api/analysis/5a1c…", "query": null, "request": null, "status": 200, "response": {…}}
  ]
}
```

- `exchanges` 는 가짜 서버가 돌려줄 요청·응답 쌍이다. `query` 는 주소의 물음표 뒤 값(목록이면 같은 이름을 여러 번), `request` 는 POST 본문이다.
- `F-STAGED` 는 같은 주소에 차례로 돌려줄 응답 7개(`label` t0~t6)다.
- `F-FULL.articles.json` 은 `F-FULL` 기사 693건 전체(`articles`)다. `GET /api/analysis/{jobId}/news` 가짜 서버가 이 목록을 `offset`·`limit`·`category` 로 잘라 돌려준다(작업 응답에는 최신 20건만 있다).
- 큰 파일은 한 줄로 저장했다(읽을 때는 `python -m json.tool` 등으로 펴서 본다). `F-FULL` 과 작은 파일만 들여 썼다.

## 목록 (`docs/ux/acceptance.md` 0절)

| 파일 | 내용 |
|---|---|
| `F-FULL` | 기본 단락 7개 done. 재무 3행, 국민연금 12개월, 제품 6, 핵심 기술 6, 근거 자료 25, 라운드 10(1건 `otherAmounts`), 합친 투자기관 35, 중요 사건 14, 기사 693(분류 10종), 흐름 5, 특허 11(등록 8, `pagesChecked` 30 = 한도), 언급 문서 1, 국내 경쟁사 후보 4(마바사는 한글·영문 두 표기), `facts` 경쟁사에 해외 기업 "해외갑"·"해외을", 기술 낱말 "가짜낱말", 긴 뉴스 요약 "긴요약표지". 기사 나눠 받기 응답 3개, 시작·단락 실행 응답, 확장된 `/api/health` |
| `F-STAGED` | 폴링 7단계(t0 모두 확인 중 → t6 `facts` 끝) |
| `F-LIMIT-NEWS` | `news` 만 `unavailable`(`daily_limit`, `retryable: false`) |
| `F-NOCORP` | 법인 없이 분석(이름 기반 `companyId`), `identity`·`official` 은 `no_corp`, `facts` 가 본사 "부산"(보도) |
| `F-CONFLICT` | `merged.founded` 엇갈림(공공 API 2020-09-15, 기사 2021-01) |
| `F-STALE` | 기준일보다 45일 전 분석 |
| `F-EXAMPLE` | `isExample: true`, `GET /api/example`, 새로 분석 거절(409) |
| `F-EMPTY` | 라운드 0, 특허 0, 중요 사건 0, 기사 0(`no_data`) |
| `F-MONEY` | 누적 투자 USD·KRW 따로, 영업이익 음수 1개 연도 |
| `F-CORP-0`, `-1`, `-2`, `-7` | 법인 후보 0 / 1(이름 같음) / 2(둘 다 이름 같음, 대표·시군구도 같고 설립일·사업자번호·건물 주소가 다름. 1곳은 `formerNames` "주식회사 라마바코리아"(2024-12-11 변경), 다른 곳은 `[]`, 긴 주소 1개) / 7(이름 같은 1곳, 3번째에 `snapshotAt`, 이름이 겹치지 않아 `formerNames` 모두 `null`) |
| `F-DOWN` | `/api/health` 502 |
| `F-INTERRUPTED` | 작업 `interrupted`, `official`·`profile`·`funding_history` done(그리고 `identity`) |
| `F-NOTICE` | 공고문 대조: 충족 4, 미충족 1, 확인 필요 2, 판단 대상 아님 2, 질문 5, 준비 자료 3. 상한 도달(429) 응답 포함 |
| `F-BRIEF` | 운용사 요약: 사실 4, 맞닿는 점 2, 물어볼 것 2, 검색 결과 6 (지금 코드의 상한이 맞닿는 점·물어볼 것 각 2라서 acceptance.md 의 3·4 대신 2·2) |
| `F-RIVALS` | `rivals_deep` done: 경쟁사 2곳(하하테크는 재무 미확보), `rivalInvestors` 에 "타파하인베스트" |
| `F-SALES`, `F-SALES-PARTIAL` | 입찰공고 12건(진행 중 7, 예정 2, 마감 3, 관련성 high 4) / 같은 것에 `errorCount` 2, `partial` |
| `F-HTML` | 기사 제목 `<b>굵게</b>`, 특허 요약 `<img src=x onerror=alert(1)>` (글자 그대로 보여야 한다) |

## 다시 만들기

```bash
/Users/pynance/workspace/liner-research-agent/.venv/bin/python scripts/build_growth_fixtures.py
/Users/pynance/workspace/liner-research-agent/.venv/bin/python -m pytest -q tests/test_growth_contract.py
```

생성기는 만든 응답을 `growth/contract.py` 타입으로 검사하고, 맞지 않으면 파일을 쓰지 않는다. 손으로 고친 파일도 `tests/test_growth_contract.py` 가 같은 검사를 한다.
