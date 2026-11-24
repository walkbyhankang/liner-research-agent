# 개발 범위와 한계

## 해커톤 기간에 만든 것

모든 코드와 문서는 대회 기간(2026-11-12~25)에 만들었습니다. 아래는 만든 순서입니다. 날짜와 커밋은 Git 기록 기준입니다.

| 단계 | 경로 | 성장노트와의 관계 |
|---|---|---|
| **기업분석 엔진** (2026-11-20, 첫 커밋 `f84dfed`) | 기업분석 엔진 `pipeline.py`, `planner.py`, `sources.py`, `fetcher.py`, `categories.py`, `integrate.py`, `analysis.py`, `liner_client.py`, `config.py`와 CLI `run_probe.py`, `tests/test_core.py`, `tests/test_v2.py`, `docs/architecture.md`. 엔진을 확인하던 8개 탭 검증 화면도 이때 만들었고, 제출 저장소에서는 지웠다(원본: 커밋 `f84dfed`) | `facts` 단락이 이 엔진을 `funding/profile.py`를 거쳐 그대로 쓴다. 스냅샷 키 지우기(`analysis.scrub`)도 이 엔진의 것 |
| 엔진 파일에 뒤에 더한 것 | `liner_client.py`(게이트웨이 JSON 호출 `chat_json`, 학술 검색 `search_scholar`), `config.py`(경로·한도 상수), `fetcher.py`(내부망 차단), `requirements.txt`(`pypdf`, `fastapi`, `uvicorn`) | 엔진의 원래 동작은 바꾸지 않았다 |
| **펀딩노트** (2026-11-21) | `funding/`, `api/main.py`, `web/`(첫 화면), `web/public/data/`, `scripts/fetch_public_data.py`, `scripts/analyze_notice.py`, `scripts/run_local.sh`, `tests/test_fetch_public_data.py`, `tests/test_funding_notice.py`, `tests/test_funding_service.py`, `docs/`의 계획·조사·실험·제출물 초안 | 성장노트가 이어 쓴다: 공고문 대조·운용사 요약(`funding/`, 엔드포인트), 자금·판로 대조 규칙(`web/lib/finder.ts`), 공공 데이터 스냅샷. 펀딩노트 화면 부품(`Finder`, `NoticeCheck` 등)과 가상 데이터가 든 사례 화면은 지웠다 |
| **팀원의 통합 분석 프로토타입** (2026-11-22, 커밋 `88c19bf`·`98d8c6c`) | 회사 이름 하나로 회사 프로필·공공 자료·뉴스·특허·논문·투자 이력·나라장터를 모아 6개 탭으로 보이던 화면, 그 수집·분석 모듈, 시험, 실행 시간 진단 스크립트. 제출 저장소에서는 지웠다(원본: 커밋 `98d8c6c`) | 성장노트가 쓰는 수집 기능은 `growth/`로 옮겨 고쳤다(파일 머리에 원본 커밋 표시). 시험도 `tests/test_growth_collect.py`, `tests/test_growth_jobs.py`로 옮겼다 |
| **성장노트 통합** (2026-11-22~24) | `growth/`, `api/analysis.py`, `api/main.py`(하루 상한·요청 제한·오류 모양), `web/`(화면 다시 만듦: `app/c/[id]/`, `components/`, `lib/`의 새 파일, `scripts/mock_api.mjs`, `scripts/ux-check.mjs`), `fixtures/analysis/`, `scripts/build_growth_fixtures.py`, `tests/conftest.py`, `tests/test_growth_*.py`, `tests/test_limits.py`, `tests/test_security.py`, `docs/integration-design.md`, `docs/ux/`, `docs/contract.md`, `THIRD_PARTY_NOTICES.md` | — |

심사 준비의 투자 미팅 예상 질문과 실사 대비 자료는 `anthropics/financial-services`(Apache-2.0)의 목록을 한국어로 다시 쓴 것입니다(`THIRD_PARTY_NOTICES.md`).

## 알아 둘 한계

**확인한 한계**

- 같은 회사도 분석할 때마다 결과가 달라질 수 있습니다(검색·모델 응답이 바뀜).
- 같은 이름의 법인이 여럿일 수 있습니다. 성장노트는 고른 법인의 자료만 쓰므로, 고른 법인에 금융위 재무가 없으면 공식 재무는 "미확보"로 둡니다.
- 금융위 재무는 제출된 연도까지만 있습니다. 국민연금 가입자 수는 직원 수와 달라 "참고"로 둡니다.
- 자금·판로 목록은 공공 API의 분류값으로만 거릅니다. 세부 자격은 공고문 자격 대조로 확인합니다.
- 표가 많은 공고문은 표 구조가 풀려 근거 문장이 일부만 잡힙니다.
- 운용사 요약은 검색 결과의 제목과 발췌만 읽습니다. 한국벤처투자 자료에는 기업당 투자 금액이 없어 금액을 쓰지 않습니다.
- 특허는 Liner 검색에 걸린 공개 특허만 셉니다(회사당 원문 30쪽 상한, 출원 뒤 약 18개월은 공개되지 않음).
- 나라장터는 최근 28일만 찾고, 공고명 낱말 일치라 관계없는 공고가 섞일 수 있으며, 참가 자격은 확인하지 않습니다.
- 고친 값·담은 항목·노트는 브라우저에만 있어, 사이트 데이터를 지우면 사라집니다(노트의 "파일로 내보내기"로 남깁니다).

**확인하지 못한 것**

- `facts` 단락 모델 호출(Responses)의 회당 비용, Liner 학술 검색 가격.
- 공공데이터포털·NAVER·OpenAlex의 제공자 하루 한도(그래서 무료 API의 하루 상한은 넉넉하게 잡았습니다).
- Safari(iPad)·실제 터치·화면 읽기 프로그램·실제 프린터로의 확인(인쇄 쪽수는 Chrome PDF A4 기준).
- 실제 사용자(대표·재무 담당자) 대상 검증.
