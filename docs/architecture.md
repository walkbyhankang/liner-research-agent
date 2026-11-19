# 아키텍처: 현재 구조와 웹서비스 전환 계획

> 이 문서는 **계획**이다. 현재 코드는 flat 구조의 Streamlit 프로토타입이며, 아래 분리는 아직 수행하지 않았다.

## 1. 현재 구조 (v0.2)

```
app.py (Streamlit UI) ──┐
run_probe.py (CLI) ─────┼─▶ pipeline.py ─▶ planner / sources / fetcher / categories / integrate / analysis
                        │          └────────▶ liner_client.py ─▶ Liner API (Search · Agent · Responses)
tests/ ─────────────────┘                     config.py
```

흐름: 검색 계획(`planner`) → Search API → (선택) Search Agent → 출처 병합·기업 식별(`sources`) → 원문 확인(`fetcher`) → 카테고리별 Model(`categories`) → Search/Agent 통합(`integrate`) → 품질 지표·결과 저장(`pipeline`).

### 현재 결합도 문제 (분리 시 해결 대상)
- `pipeline.py`가 분석 흐름, 품질 지표, 파일 저장을 모두 담당한다.
- `pipeline.run_analysis()`가 동기 호출이며 진행 상황을 `progress` 콜백으로만 전달한다.
- `app.py`가 `st.session_state`에 `run` dict를 보관한다. 분석 결과 스키마가 dict 관례로만 존재하고 타입 정의가 없다.
- `config.py`가 전역 상수로 한도를 갖고, API 키를 환경변수·`.env`에서 직접 읽는다.
- 결과 저장소가 `results/<실행ID>/` 파일시스템뿐이다.

## 2. 목표 구조

| 계층 | 역할 | 기술 |
|---|---|---|
| **Core** | 검색·통합·검증·분석 엔진. UI·HTTP 프레임워크에 의존하지 않음 | Python |
| **Streamlit** | 내부 검증·디버깅용 UI. Core를 직접 호출 | Streamlit |
| **API** | Core를 HTTP로 노출. 작업 생성·진행 조회·결과 조회 | FastAPI |
| **Web** | 사용자 웹 UI | React / Next.js |

```
Web (Next.js) ──HTTP/SSE──▶ API (FastAPI) ──▶ Core ──▶ Liner API
Streamlit ───────────────────────────────────▶ Core
```

### 목표 디렉터리 (제안)
```
liner-research-agent/
├─ core/              # 현재 Python 모듈을 이동 (config, liner_client, planner, sources, fetcher, categories, integrate, analysis, pipeline)
├─ apps/
│  ├─ streamlit/app.py
│  ├─ api/            # FastAPI
│  └─ web/            # Next.js
├─ tests/
├─ docs/
└─ results/           # (Git 제외) → 이후 DB/오브젝트 스토리지
```

## 3. 단계별 계획

각 단계는 **기존 테스트(현재 61개)가 계속 통과**하는 것을 완료 조건으로 한다.

1. **Core 분리** — 모듈을 `core/`로 이동하고 import 경로만 변경한다. 동작 변경 없음.
2. **저장 계층 분리** — `pipeline.save_results`와 품질 지표 계산을 분리해 저장소 인터페이스(`ResultStore`)를 둔다. 기본 구현은 현재 파일시스템.
3. **결과 스키마 타입화** — `run` dict를 Pydantic 모델로 정의한다(`pydantic`은 이미 의존성에 있음). API 응답 스키마의 기반이 된다.
4. **설정 주입** — 전역 상수·키 탐색을 `Settings` 객체로 주입하게 바꾼다. 사용자별 키·한도 지원의 전제 조건이다.
5. **진행 이벤트화** — `progress` 콜백을 이벤트 스트림(단계, 호출 수, 오류)으로 일반화한다. SSE의 기반이 된다.
6. **FastAPI** — 아래 엔드포인트를 제공한다. 분석은 수 분이 걸리므로 비동기 작업으로 실행한다.
7. **Next.js** — 현재 Streamlit의 8개 탭을 대응하는 화면으로 구현한다. Plotly 대신 웹 차트 라이브러리를 선택한다.

### API 초안
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/runs` | 분석 작업 생성(회사명·국가·옵션) → `run_id` |
| GET | `/runs/{id}` | 상태·진행·오류 |
| GET | `/runs/{id}/events` | 진행 이벤트(SSE) |
| GET | `/runs/{id}/result` | 분석 결과(카테고리별) |
| POST | `/runs/{id}/premium-compare` | Premium 비교(유료 1회) |
| GET | `/runs/{id}/files/{name}` | 결과 파일·ZIP 다운로드 |
| GET | `/usage` | 호출 한도·사용량 |

## 4. 웹서비스 전환 시 반드시 결정할 사항 (미결정)

- **인증·사용자 관리**: 현재 범위 밖(P2). 다중 사용자를 받으려면 필요하다.
- **API 키 관리**: 서버 단일 키 vs 사용자별 키. 서버에 보관한다면 비밀 저장소와 한도·비용 정책이 필요하다.
- **작업 실행 방식**: 프로세스 내 백그라운드 vs 작업 큐. 분석 1회가 약 3~5분(검증 실행 기준 246초)이다.
- **결과 저장소**: 파일시스템 → DB/오브젝트 스토리지. 결과에는 제3자 기사 발췌가 포함되어 보관·재배포 범위를 검토해야 한다.
- **원문 수집(`fetcher`)의 서버 운영**: robots.txt 준수 정책, 요청 빈도 제한, 서버 IP 차단 가능성.
- **비용 상한**: 요청 단위 한도 외에 사용자·기간별 상한.

## 5. 유지해야 할 원칙 (분리 후에도 동일)

- `confirmed`는 원문 대조로만 부여한다. 충돌은 하나를 고르지 않고 보존한다.
- 유료 호출은 한도 내에서만, 524/429/5xx는 최대 1회 재시도한다.
- 결과·로그에 키를 남기지 않는다(`scrub`, `find_secret_leaks`).
- 외부 웹 콘텐츠는 데이터로만 취급한다.

## 6. 알려진 기술 부채 (전환 전 해소 권장)

- 신규 VC 후보 0건의 원인 미확인(모델 응답 원문 미저장).
- 기존 투자자 이름 병합 없음.
- Agent 사실 추출이 마크다운 형식에 의존한다(`integrate.agent_facts`).
- 사실 대조·충돌 탐지가 토큰 기반 휴리스틱이라 연결/별도 구분 오탐이 있을 수 있다.
