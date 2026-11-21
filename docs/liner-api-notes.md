# Liner Platform API 조사 메모

> 2026-11-21 공식 문서(liner.com/ko/developers/docs) 기준. **키가 없어 실제 호출로 검증한 항목은 없다.**
> "문서 기재"와 "실측 필요"를 구분해 적는다.

## 결론

- **검색은 Liner Search API, 판단·작성은 게이트웨이로 부른 프런티어 모델**로 나눈다.
- 게이트웨이는 모델의 서버 측 웹 검색 도구(`web_search`)를 **무시**한다. 따라서 어떤 모델을 쓰든 웹 검색 경로는 Liner Search뿐이고, 이것이 대회 요건(Search 또는 Model을 핵심 기능에 사용)을 자연스럽게 채운다.
- 대회 공고는 Model API를 "같은 키로 500여 종의 모델을 호출"하는 것으로 설명하므로 게이트웨이로 Claude를 부르는 것도 Model API 사용에 해당한다. 다만 심사 문구가 "Liner Model과 Liner Search를 핵심 기능에 알맞게"이므로 Search 비중을 낮추지 않는다.
- "Liner 자체 모델 성능이 낮다"는 평가는 문서로 확인할 수 없다. 키를 받은 뒤 같은 입력으로 비교 측정한다(아래 실측 항목).

## 쓸 것

| 용도 | API | 문서 기재 |
|---|---|---|
| 웹 검색 | `POST /api/v1/tools/search/web` | $1/1,000건(`include_knowledge: false`, snake_case 필수). 기본값은 true로 $2. 초당 한도 없음 |
| 역할 분류·조건 추출·상담 질문 작성 | 게이트웨이 `anthropic/claude-opus-5.5` 등 | Messages·Chat Completions·Responses 호환. 입력 $4 / 출력 $20 (1M 토큰) |
| 학술 검색(필요 시) | `POST /api/v1/tools/search/scholar` | $0.3/1,000건, 초당 2회 |
| 잔액·사용량 | `GET /api/v1/credits/balance`, `/usage` | 무료 |

직접 지정 가능한 모델 ID(문서 표기): `anthropic/claude-fable-5.2`($8/$40), `anthropic/claude-opus-5.5`($4/$20), `anthropic/claude-sonnet-5.5`($2/$10), `anthropic/claude-haiku-5.5`($0.1/$0.5), `openai/gpt-6.2-astra`($8/$40), `openai/gpt-6.2-sol`($2/$10). 라우터(`liner-claude-router` 등)는 요청마다 모델을 자동 선택하므로 결과 재현이 필요한 추출 단계에는 쓰지 않는다.

## 쓰지 않거나 최소화할 것

| API | 이유 |
|---|---|
| Search Agent | $20/1,000건, 중앙값 약 30초·p99 약 100초(문서 관측값). 검색과 추출을 직접 제어하는 편이 빠르고 근거 추적이 쉽다 |
| Deep Research Agent | $200/1,000건, 수 분 소요. 사용하지 않는다 |
| Visual Answer / Visualization | $150·$10/1,000건. 화면은 직접 그린다 |
| Premium Data(`include_knowledge`) | 제공처가 해외 중심이라 한국 비상장사 데이터 깊이가 확인되지 않음 |
| `liner-mark`, 라우터 | 품질 미검증. 비교 측정 후 가벼운 작업(검색어 생성 등)에 쓸지 결정 |

## 설계에 반영할 제약(문서 기재)

- **약 125초 무응답 시 524(HTML)**: 호출을 단계별로 나누고 출력 길이를 제한한다. 스트리밍 유지 여부는 문서 간 설명이 달라 실측한다.
- **Claude 계열에서 강제 도구 호출(`tool_choice` any/required/특정 함수)은 400**: 도구 호출 루프 대신 "검색은 코드가 실행하고 모델은 JSON만 반환"하는 구조로 간다.
- **구조화 출력**: Chat Completions의 `response_format: json_schema`, Responses의 `text.format: json_schema`. Messages 형식에는 문서가 없다 → 추출 단계는 Chat Completions 또는 Responses로 호출한다.
- **Messages의 `thinking`·`temperature`는 무시**, 추론 강도는 Chat/Responses의 `reasoning_effort`로만 조절.
- **스트림 실패는 HTTP 200 본문의 `data-error`**로 온다. 200을 성공으로 단정하지 않는다.
- 402(크레딧 부족)는 재시도하지 않는다. 429는 `Retry-After`를 따른다.

## 키를 받은 뒤 먼저 측정할 것(소액 유료 호출)

1. `anthropic/claude-opus-5.5`를 Chat Completions + `json_schema`로 호출했을 때 스키마 준수 여부와 지연.
2. 같은 추출 과제(라이너 시리즈 B 보도 → 기관별 역할)를 `liner-mark`, `liner-claude-router`, `anthropic/claude-opus-5.5`, `openai/gpt-6.2-sol`로 돌려 정확도·지연·비용 비교.
3. Liner Search의 한국어 질의 품질: 은행 상품·보증 제도·운용사 포트폴리오 질의 10개에서 공식 원문이 상위 10건에 들어오는 비율.
4. `GET /api/v1/models`가 게이트웨이 ID를 반환하는지.

## 기존 코드에서 살릴 것

| 모듈 | 판단 |
|---|---|
| `liner_client.py` | 유지. 검색·호출 한도·재시도·비용 기록이 문서 규칙과 일치. 게이트웨이용 Chat Completions 호출 메서드 추가 필요 |
| `fetcher.py` | 유지. 원문 확인과 값 대조는 "확인됨" 판정의 근거 |
| `sources.py` | 유지. URL 정규화·기업 식별·출처 신뢰도 |
| `analysis.py`의 `scrub`, `pipeline.find_secret_leaks` | 유지. 키 누출 방지 |
| `categories.py`의 적격성 판정 | 규칙 대조 엔진의 출발점으로 재사용 |
| `pipeline.py`, `app.py`, `planner.py`, `integrate.py` | 기업분석용 흐름·Streamlit UI라 새 흐름으로 대체. 필요한 함수만 가져온다 |
