# liner-research-agent

Liner API(Search / Model / Search Agent)로 스타트업 기업정보를 수집·분석하고, 출처와 원문 검증 상태를 함께 보여주는 Streamlit 프로토타입입니다. 핵심 Python 분석 엔진을 유지한 채 FastAPI + React/Next.js 웹서비스로 전환하는 것이 향후 목표입니다(`docs/architecture.md` 참고).

> 현재 상태: 프로토타입. 대규모 수집·DB 구축·Deep Research는 하지 않습니다.

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
