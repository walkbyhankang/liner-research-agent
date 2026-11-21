# liner-research-agent

Liner API(Search / Model / Search Agent)로 스타트업 기업정보를 수집·분석하고, 출처와 원문 검증 상태를 함께 보여주는 Streamlit 프로토타입입니다. 핵심 Python 분석 엔진을 유지한 채 FastAPI + React/Next.js 웹서비스로 전환하는 것이 향후 목표입니다(`docs/architecture.md` 참고).

> 현재 상태: 프로토타입. 대규모 수집·DB 구축·Deep Research는 하지 않습니다.

## 펀딩노트: 중소·벤처기업 자금 찾기 (라이너 해커톤 출품작)

중소·벤처기업이 신청할 수 있는 정책자금 공고와 접촉할 벤처캐피탈 운용사를 한곳에서 찾고, 공고문을 읽어 우리 회사 조건과 대조해 주는 웹 서비스입니다.

| 기능 | 하는 일 | 쓰는 것 |
|---|---|---|
| 자금 찾기 | 지역·기업 유형·지원 종류로 공고와 운용사를 거르고, 제외 사유와 확인할 점을 보여준다 | 기업마당 지원사업정보 API, 한국벤처투자 펀드현황 API |
| 공고문 자격 대조 | 공고문(PDF·HWPX)에서 조건을 근거 문장과 함께 뽑고, 근거가 원문에 있는 것만 남겨 회사 조건과 견준다 | Liner 게이트웨이(Model API) |
| 회사명으로 채우기 | 공개자료에서 설립일·사업·직원 수·기존 투자자·경쟁사를 찾아 출처와 함께 보여준다 | Liner Search API, Liner Model API, 기존 기업분석 엔진 |
| 경쟁사 조건이라면? | 같은 공고를 경쟁사 조건으로 다시 대조해 갖추면 열리는 요건을 보여준다 | Liner 게이트웨이 |
| 운용사 요약 | 운용사를 대신 검색해 확인되는 사실과 회사와 맞닿는 점을 한 줄씩 정리한다 | Liner Search API, Liner 게이트웨이 |

### 실행
```bash
# 1) 키: 저장소 루트 .env 에 LINER_API_KEY, BIZINFO_API_KEY, KVIC_API_KEY
# 2) Python 환경. 예전에 만든 .venv 가 있으면 뒤의 pip install 만 다시 실행한다(pypdf, fastapi, uvicorn 이 추가됐다)
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
# 3) 공공 데이터 스냅샷(무료 API). web/public/data/ 에 저장소에 포함된 스냅샷이 있어 생략할 수 있다
.venv/bin/python scripts/fetch_public_data.py
# 4) 분석 서버(자격 대조·회사 조회·운용사 요약). 유료 호출은 서버 실행당 FUNDING_MAX_PAID_CALLS(기본 60)회까지
.venv/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
# 5) 화면
npm --prefix web install && npm --prefix web run build && npm --prefix web run start -- -p 3100
```
`http://localhost:3100` 에서 엽니다. 분석 서버 없이도 자금 찾기(목록·필터·저장)는 동작합니다.

위 4)·5)는 스크립트 하나로 할 수 있습니다.
```bash
scripts/run_local.sh fundingnote   # 펀딩노트만: 화면 3100, 분석 서버 8000
scripts/run_local.sh streamlit     # 기존 Streamlit 프로토타입만: 8501
scripts/run_local.sh               # 둘 다(비교용)
```
스크립트는 필요한 Python 패키지가 빠져 있으면 서버를 띄우기 전에 무엇을 설치하라고 알리고 멈춥니다. 포트는 `FUNDING_WEB_PORT`, `FUNDING_API_PORT`, `STREAMLIT_PORT`로 바꿉니다. 두 화면은 서로 독립이라 한쪽만 띄워도 되고, 같은 `.env`와 `results/`를 씁니다.

회사명 조회는 2분 넘게 걸리고 실행마다 결과가 달라집니다. 그래서 미리 조회해 저장해 둔 결과를 `web/public/data/sample-company.json`에 두면 "우리 회사 정보"에 **예시 회사로 체험** 단추가 나오고, 누르면 그 결과가 바로 채워집니다(화면에 조회한 날짜를 표시). 이 파일은 실제 기업의 조회 결과라 **저장소에 넣지 않았습니다**(`.gitignore`). 파일이 없으면 단추가 보이지 않고, 나머지 기능은 그대로 동작합니다. 파일을 새로 두었으면 화면 서버를 다시 실행해야 보입니다.

### 테스트
```bash
.venv/bin/python -m pytest -q tests   # 실제 API 를 호출하지 않는다
npm --prefix web test
```

### 기존 코드와 해커톤 기간에 새로 만든 것
| 구분 | 경로 | 내용 |
|---|---|---|
| 기존(해커톤 이전 프로토타입) | `app.py`, `pipeline.py`, `planner.py`, `sources.py`, `fetcher.py`, `categories.py`, `integrate.py`, `analysis.py`, `run_probe.py`, `tests/test_core.py`, `tests/test_v2.py` | 회사명으로 기업 정보를 수집·검증하는 Streamlit 프로토타입. 변경 없음 |
| 기존 파일에 추가 | `liner_client.py`, `config.py`, `requirements.txt` | 게이트웨이 JSON 호출(`chat_json`), 경로 상수, 의존성(`pypdf`, `fastapi`, `uvicorn`) |
| 신규 | `funding/` | 공고문 추출·검증·대조, 회사 조회(기존 엔진 재사용), 경쟁사 투자 이력, 운용사 요약 |
| 신규 | `api/` | FastAPI 분석 서버 |
| 신규 | `web/` | Next.js 화면 |
| 신규 | `scripts/` | 공공 데이터 수집, 공고문 대조 실험 |
| 신규 | `tests/test_fetch_public_data.py`, `tests/test_funding_*.py`, `web/lib/*.test.mjs` | 테스트 |
| 신규 | `docs/` (`architecture.md` 제외) | 계획, API 조사, 실험 결과, 사용자 경험 체크리스트, 제출물 초안(`docs/submission/`) |

### 알아 둘 한계
- 자금 찾기 목록은 공공 API 의 분류값으로만 거른다. 세부 자격은 공고문 자격 대조로 확인한다.
- 회사 조회와 운용사 요약은 초안이다. 값마다 출처와 확인 상태를 붙이고, 출처가 엇갈리거나 추정인 값은 자동으로 채우지 않는다.
- 점수나 선정 확률은 계산하지 않는다.
- 자세한 내용: `docs/public-data-notes.md`, `docs/notice-analysis-results.md`, `docs/streamlit-intent-and-integration.md`, `docs/ux-checklist.md`

## 구성
| 파일 | 역할 |
|---|---|
| `config.py` | 설정, 호출 한도, 가격표, API 키 탐색 |
| `liner_client.py` | HTTP 클라이언트(호출 한도, 524/429/5xx 재시도 1회, 호출 기록) |
| `analysis.py` | 모델 출력 정규화, 사실 상태 부여, 비밀값 제거 |
| `pipeline.py` | 분석 실행(검색 → Agent → 원문 확인 → 카테고리별 Model), Premium 비교, 결과 14종 저장 |
| `planner.py` | 분야별(6개) 검색어 계획, 경쟁사 후속 검색, 호출 한도 관리 |
| `sources.py` | URL 정규화·중복 제거, 기업 식별(유사 상호 제외), 출처 유형·신뢰도 |
| `fetcher.py` | 공개 원문 확인(robots.txt 준수, 차단·유료 우회 금지), 값 대조 |
| `categories.py` | 카테고리별 Model 프롬프트·JSON 스키마·검증, 정부지원 적격성 판정 |
| `integrate.py` | Search API ↔ Agent 사실 통합·충돌 탐지, Premium(knowledge) 정규화·비교 |
| `app.py` | Streamlit 대시보드(8개 탭) |
| `run_probe.py` | CLI 실행기 |
| `tests/` | 단위·통합 테스트(실제 API 호출 없음, `httpx.MockTransport` 사용) |

## 설치
Python 3.12에서 개발·검증했습니다.

```bash
git clone <저장소 주소> liner-research-agent
cd liner-research-agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Windows(PowerShell):
```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## 환경변수 (API 키)
키는 다음 순서로 탐색합니다. 키는 로그·결과 파일에 저장하지 않습니다.

1. 환경변수 `LINER_API_KEY`
2. 프로젝트 루트의 `.env` 파일 (`cp .env.example .env` 후 키 입력)
3. Claude Code 환경의 `ANTHROPIC_AUTH_TOKEN` (`ANTHROPIC_BASE_URL`이 `platform.liner.com`일 때만, 메모리에서만 사용)

`.env`는 `.gitignore`로 제외되어 있습니다. 절대 커밋하지 마세요.

## 실행
```bash
# Streamlit 대시보드 (http://localhost:8501)
.venv/bin/python -m streamlit run app.py

# CLI (실제 API 호출, 유료)
.venv/bin/python run_probe.py "회사명" 대한민국 --alias 별칭 --budget 20 --results 15 --premium
#   --no-agent  Search Agent 생략   --budget N  검색 한도   --results {5,10,15,20}
#   --premium   Premium Data 비교(유료 1회 추가)   --homepage 도메인   --exclude 유사상호
```
Windows는 `.venv\Scripts\python`을 사용합니다.

## 테스트
```bash
.venv/bin/python -m pytest -q tests
```
실제 API를 호출하지 않으므로 키 없이 실행됩니다.

## 호출 한도와 비용
- 검색: 기본 최대 50회(UI에서 12/20/50 선택). 경쟁사 후속 검색과 Premium 비교 1회가 한도에 포함됩니다. 결과 수는 5/10/15/20(기본 15, 공식 최대 20).
- Model: 최대 6회(카테고리당 1회, 출처 없는 카테고리는 생략). Search Agent: 1회(UI에서 선택). Premium 비교: 별도 버튼으로 1회.
- `include_knowledge`의 공식 기본값은 true(요청당 $2/1,000)이므로 기본 검색은 항상 `false`를 명시 전송($1/1,000)하고 Premium 비교에서만 true를 사용합니다.
- 524/429/5xx는 `Retry-After`(없으면 5초) 후 **최대 1회**만 재시도합니다. 네트워크 타임아웃은 중복 과금을 막기 위해 재시도하지 않습니다.
- 표시되는 비용은 공식 단가 기반 추정치입니다. 실제 청구액은 크레딧 잔액으로 확인하세요.

## 결과 파일
`results/<실행ID>/`에 `raw_api_responses.json`, `company_profile.json`, `news_events.csv`, `competitors.csv`, `vc_and_support.csv`, `extracted_facts.csv`, `api_calls.csv`, `quality_report.md`, `run_manifest.json`, `search_comparison.csv`, `source_verification.csv`, `coverage_report.json`, `improvement_comparison.md`, `analysis_bundle.zip`이 저장됩니다(UTF-8, CSV는 Excel용 BOM 포함). 실행 ID별 폴더라 이전 결과를 덮어쓰지 않습니다.

`results/`의 실행 결과는 제3자 기사 발췌 등을 포함하므로 Git에서 제외됩니다(`results/.gitkeep`만 추적).

`improvement_comparison.md`는 1차 테스트 `results/20261118_002846_9604`를 기준으로 비교합니다. 이 폴더가 없으면 "기준자료 없음"으로 표시됩니다.

## 데이터 품질 원칙
- 상태: `confirmed` / `reported` / `inferred` / `conflicting` / `unavailable`.
- `confirmed`는 원문 페이지를 실제로 읽고 값이 본문에서 확인된 경우에만 부여합니다. 접근 차단·유료·robots 금지·본문 추출 실패는 우회하지 않고 사유를 `source_verification.csv`에 기록합니다.
- 검색 결과에 없는 URL을 근거로 든 사실은 `inferred`로 강등하고, 출처·값이 없는 재무 수치는 그래프에서 제외합니다.
- 수치가 없으면 그래프 대신 `자료 확보 불가`를 표시합니다.

## 알려진 한계
- 신규 VC 후보가 실제 테스트(당근마켓)에서 0건이었습니다. 원인은 미확인입니다(모델 응답 원문을 저장하지 않음).
- 기존 투자자 이름 병합(중복·표기 차이)이 없습니다.
- 경쟁사 정량정보(매출·직원수·투자)는 대부분 비어 있습니다.
- Premium Data는 당근마켓 1개 질의에서 `knowledge`를 반환하지 않았습니다(일반화 불가).
- 공공 API는 연동하지 않았습니다. 지원사업 신청 가능 여부는 공고에 적힌 조건만으로 판정하며 정보가 없으면 확정하지 않습니다.
- Search Agent 근거 구절(`referenceChunks`)은 공식 스펙상 스트리밍 엔드포인트에만 문서화되어 있어, 현재 비스트리밍 엔드포인트의 제공 여부는 미확인입니다.
- 저장된 결과 폴더를 Streamlit 화면에 불러오는 기능이 없습니다.
