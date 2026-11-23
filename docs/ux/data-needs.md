# 화면이 받아야 하는 데이터

> 2026-11-22. 서버·화면 사이 데이터 계약을 만들기 위한 바탕. 단락 키는 설계 문서 6.2·6.3절 그대로(`identity`, `official`, `profile`, `facts`, `funding_history`, `news`, `patents`, `papers`, `rivals_deep`, `sales`).

## 0. 읽는 법

- **지금 키**: 기준 기업 기본 분석 실측 결과(scratchpad의 `basic-ReferenceCo.json`, 저장소에 넣지 않음)와 지금 코드(`app.py`, `web/lib/company.ts`, `web/lib/finder.ts`, `research/gov.py`)에서 확인한 키다. `papers`, `rivals_deep`, `sales`는 기본 분석에서 돌리지 않아 `app.py`·`research/gov.py`가 읽는 키를 적었다(실측하지 않음).
- **제안**: 지금 결과에 없어 화면이 새로 필요로 하는 것. 이름은 서버 담당이 정해도 되지만 뜻은 지킨다.
- **예시**는 모두 가짜 값이다(회사 "가나다테크", 숫자는 임의).
- **1층 / 펼치면**: `screens.md`의 층(1층 처음 보임, 2층 펼치기 줄, 3층 줄 자세히)과 같다. "안 씀"은 화면에 보이지 않는 필드다.
- **한글 키**: 지금 결과에는 한글 키가 섞여 있다(`연도`, `매출액`, `가입자 수`, `투자기관`, `관련 기사 수`, `매체`, `분류`, `기사 제목` 등). 계약을 만들 때 API 경계에서 영문 키로 한 번 바꿀지 정한다(8절에 바꿀 이름 제안). 화면 코드는 계약에 정한 이름만 쓴다.

---

## 1. 작업과 단락 봉투

### 1.1 `GET /api/analysis/{jobId}` (설계 문서 6.2) 와 저장된 분석

화면은 1~2초마다 이 주소를 묻는다. 저장된 분석(스냅샷)을 열 때도 같은 모양을 받는다(1.3절).

| 필드 | 뜻 | 예시 | 지금/제안 |
|---|---|---|---|
| `jobId` | 작업 번호 | `"j_8f2c"` | 지금 |
| `companyId` | 회사 번호. 법인등록번호, 없으면 이름 기반 값 | `"1101110000000"` | 지금 |
| `company.name` | 표시할 회사 이름 | `"주식회사 가나다테크"` | 제안 |
| `company.crno` | 법인등록번호. 법인 없이 분석하면 `null` | `"1101110000000"` | 제안 |
| `status` | 작업 전체 상태: `running` / `done` / `interrupted` | `"running"` | 제안 |
| `startedAt` | 시작 시각(한국 시간, ISO) | `"2026-11-22T20:44:00+09:00"` | 제안 |
| `analyzedAt` | 이 분석의 시각. 화면의 "{YYYY-MM-DD HH:mm} 분석"과 30일 판정에 쓴다 | `"2026-11-22T20:46:24+09:00"` | 제안 |
| `isExample` | 예시 회사인가. 참이면 "새로 분석"을 숨긴다 | `false` | 제안 |
| `sections` | 단락 키 → 단락 봉투(1.2절) | | 지금 |
| `merged` | 단락을 합친 회사 값(3절) | | 제안 |
| `paid.liner` | 이 분석에 쓴 Liner 호출 수, 종류별 | `{"search": 11, "premium": 2, "model": 6, "scholar": 0}` | 지금(`paid`) |
| `estimates` | 확인 창과 열 때 실행 단추 옆에 쓰는 예상값(1.4절) | | 제안 |
| `refresh.remainingToday` | 이 회사를 오늘 더 새로 분석할 수 있는 횟수 | `2` | 제안 |

### 1.2 단락 봉투 (`sections.{key}`)

| 필드 | 뜻 | 예시 | 지금/제안 |
|---|---|---|---|
| `status` | `waiting`(앞 단락 기다림) / `running` / `done` / `partial`(일부만) / `unavailable`(미확보) / `idle`(열 때 실행, 아직 안 함) | `"running"` | 지금(값 목록은 제안) |
| `stage` | 서버가 알려 준 지금 단계. 서버가 준 것만 보인다(추측해 쓰지 않음) | `"원문 확인"` | 지금 |
| `seconds` | 경과 초 | `14.2` | 지금 |
| `expectedSeconds` | 보통 걸리는 초. "보통 {예상} 안에 끝납니다"와 "평소보다 오래" 판정 | `40` | 제안 |
| `analyzedAt` | 이 단락 결과의 시각. 단락만 새로 받으면 회사 분석 시각과 달라진다 | `"2026-11-22T20:45:04+09:00"` | 제안 |
| `result` | 단락 결과(4절) | | 지금 |
| `error.code` | 미확보·일부 사유 코드: `daily_limit`, `section_limit`, `no_corp`, `no_data`, `upstream_error`, `timeout`, `interrupted`, `missing_config` | `"daily_limit"` | 제안(지금은 `error` 문자열) |
| `error.message` | 사용자에게 보여도 되는 한 줄. 내부 경로·예외·키 이름 없음 | `"오늘 호출 상한에 닿았습니다"` | 제안 |
| `error.source` | 실패한 자료 이름(`upstream_error`일 때 문장에 넣음) | `"국민연금공단"` | 제안 |
| `error.retryAt` | 다시 할 수 있는 시각(`daily_limit`이면 다음 날 0시) | `"2026-11-23T00:00:00+09:00"` | 제안 |
| `retryable` | "이 단락 다시 분석"을 보여도 되는가 | `true` | 제안 |

화면의 미확보 문장은 `error.code`로 고른다(`screens.md` 1.5절). `error.message`는 코드에 맞는 문장이 없을 때만 쓴다.

**보통 걸리는 시간 기본값**(서버가 `expectedSeconds`를 주지 않을 때, 기준 기업 실측을 올려 잡은 값): `official` 10초, `profile` 25초, `funding_history` 30초, `patents` 35초, `news` 45초, `facts` 180초. `papers`, `rivals_deep`, `sales`는 실측이 없어 시간을 쓰지 않는다.

### 1.3 저장된 분석 찾기 (제안)

| 엔드포인트 | 하는 일 | 응답 |
|---|---|---|
| `GET /api/company/{companyId}/analysis` | 그 회사의 가장 최근 저장된 분석 | 1.1절과 같은 모양(`jobId`는 그 분석을 만든 작업). 없으면 404 |
| `GET /api/company/{companyId}/job` | 그 회사의 진행 중 작업 | `{jobId}` 또는 404 |
| `GET /api/example` | 예시 회사 | `{companyId, name, analyzedAt}`. 예시 분석 파일이 없으면 404(시작 화면에서 링크를 숨김) |
| `POST /api/analysis` | 분석 시작 `{name, crno?, homepage?, refresh?}`. `refresh: true`는 [새로 분석] | 202 `{jobId, companyId}`. 하루 새로 분석 횟수를 넘으면 429와 사용자용 문장 |
| `POST /api/analysis/{jobId}/sections/{key}` | 열 때 실행(`papers`, `rivals_deep`, `sales`)과 단락만 새로(`news`, 미확보로 끝난 기본 단락) | 202. 상태는 1.1절로 묻는다 |

- `POST /api/analysis/{jobId}/sections/{key}`를 기본 단락에도 쓰는 것은 설계 문서에 없는 확장이다(설계 문서는 열 때 실행 단락만). 지원하지 않으면 화면은 `retryable: false`로 보고 "이 단락 다시 분석"을 숨긴다.
- 열 때 실행 단락의 요청 본문: `rivals_deep` `{rivals: [{name, nameEn?, crno?}]}`(사용자가 "포함"한 비교 대상 경쟁사, 최대 5곳), `sales` `{keywords: ["…"]}`(최대 6개), `papers` 본문 없음.

### 1.4 예상값 (`estimates`, 제안)

| 키 | 뜻 | 예시 | 서버가 안 주면 |
|---|---|---|---|
| `full.seconds`, `full.liner` | 새로 분석 전체 | `180`, `19` | 3분 안팎, 약 19회 |
| `sections.news.seconds`, `.liner` | 뉴스만 새로 | `20`, `3` | 20초 안팎, 약 3회 |
| `sections.papers.liner` | 논문 분석 | `7` | 학술 검색 6회와 모델 1회 |
| `sections.rivals_deep.liner`, `.perRival` | 경쟁사 깊이 비교 | `34`, `6` | "경쟁사 5곳 기준 약 34회"(고른 곳 수로 바꿔 씀: 34 − 6 × (5 − 고른 곳 수)) |

시간을 실측하지 않은 단락은 `seconds`를 `null`로 두고 화면은 호출 수만 쓴다.

---

## 2. 값 하나의 모양 (`Value`, 제안)

회사 표시줄, 핵심 값, 개요의 기업 사실, 노트의 회사 핵심 값처럼 **값마다 상태·출처를 따로 보이는 곳**에 쓴다. 표·차트·목록처럼 묶음으로 보이는 값은 단락 결과의 원래 모양을 쓰고, 묶음 출처는 단락마다 정한 `source`를 쓴다(4절).

```json
{
  "display": "2020-09-15",
  "raw": "2020-09-15",
  "status": "confirmed",
  "source": {
    "org": "금융위원회",
    "name": "기업기본정보",
    "kind": "공공 API",
    "asOf": "2026-11-22 조회",
    "basis": null,
    "url": null
  },
  "quote": null,
  "note": null,
  "reason": null
}
```

| 필드 | 뜻 |
|---|---|
| `display` | 화면에 쓰는 글(단위 포함). 화면은 다시 꾸미지 않는다 |
| `raw` | 원래 값(숫자·날짜). 업력 계산과 대조 요청에 쓴다 |
| `status` | `confirmed` / `reported` / `inferred` / `conflicting` / `unavailable` / `reference` |
| `source` | 출처. 화면에는 "{org}{name} ({kind})"와 "{asOf}{, basis}"로 나눠 쓰고, 글로 낼 때는 "{기관·자료 이름} ({자료 종류}) · {기준일}" 한 줄 |
| `source.basis` | 연결/별도, 통화처럼 값의 기준 |
| `source.url` | 원문 주소(`http`·`https`만). 없으면 `null` |
| `quote` | 원문 근거 문장(원문 그대로) |
| `note` | 덧붙일 설명. 예: "국민연금 가입자 수는 상시근로자 수와 다릅니다." |
| `reason` | `unavailable`일 때 짧은 사유. 예: "공식 재무 자료 없음" |

**엇갈림**: `status: "conflicting"`이면 `values` 배열에 두 개 이상의 `{display, raw, source, quote}`를 넣고, `usedIndex`에 업력 계산·자격 대조에 쓰는 값의 위치(설계 문서 4.1: 공공 API 값)를 넣는다. 화면은 `values`를 모두 보이고 어느 쪽이 맞다고 쓰지 않는다.

```json
{
  "status": "conflicting",
  "values": [
    {"display": "2020-09-15", "raw": "2020-09-15", "source": {"org": "금융위원회", "name": "기업기본정보", "kind": "공공 API", "asOf": "2026-11-22 조회"}},
    {"display": "2021-01", "raw": "2021-01", "source": {"org": "가나다일보", "name": "기사", "kind": "원문 확인", "asOf": "2025-03-02", "url": "https://example.com/a"}, "quote": "가나다테크는 2021년 1월 설립된…"}
  ],
  "usedIndex": 0
}
```

---

## 3. 합친 회사 값 (`merged`, 제안)

설계 문서 4.1의 "값마다 출처 하나로" 규칙은 여러 단락을 합쳐야 나온다. 화면마다 따로 합치면 화면끼리 값이 달라지므로(작업 3의 기준 "화면마다 경쟁사·투자자가 같음") 서버가 합쳐 한 번 준다. 단락이 하나 끝날 때마다 다시 계산한다.

| 필드 | 뜻 | 모양 | 예시(가짜) | 쓰는 곳 | 출처 규칙(설계 문서 4.1) |
|---|---|---|---|---|---|
| `region` | 시·도 | `Value` | "서울" | 표시줄, 자금 조달 조건 | 금융위 주소 → 없으면 `facts` 본사 소재지 |
| `district` | 시·군·구 | 글 | "강남구" | 개요 "본사", 회사 확정 | 금융위 주소 |
| `founded` | 설립일 | `Value`(엇갈림 가능) | "2020-09-15" | 표시줄 업력, 개요 | 금융위 → 웹 값은 엇갈림으로 나란히 |
| `bizType` | 기업 유형: `venture` / `sme` / `micro` | `Value` | "창업·벤처기업"(추정) | 표시줄, 자금 조달 조건 | **정해진 규칙 없음. 9절 질문** |
| `industry` | 업종 | `{official: Value, web: Value}` | 금융위 "미확보", 웹 "AI 반도체 설계"(보도) | 개요, 대조 | 둘 다 표시 |
| `employees` | 직원 수 | `Value` | "120명"(보도) | 개요, 대조 | 웹 조사. 국민연금은 여기 넣지 않음 |
| `revenue` | 매출 | `{official: Value, web: Value}` | 공식 "56.7억원, 2022 사업연도, 별도", 웹 "약 100억원"(보도) | 핵심 값, 대조 | 금융위 최근 연도(연결 우선) + 웹 값 나란히 |
| `npsLatest` | 국민연금 가입자 최근 값 | `Value`(`reference`) | "118명, 2026-10" | 핵심 값, 대조 메모 | 국민연금 |
| `patentCount` | 출원인 확인 국내 특허 수 | `Value` | "11건, 등록 8건" | 핵심 값, 대조 메모 | 특허 공개 원문 |
| `investors` | 합친 투자기관 목록 | 배열(아래) | | 투자 단락, 자금 조달 "이미 투자함" | 엔진 투자자 + Premium 카드(이름·도메인 일치만) + 웹 보완 |
| `rivals` | 합친 국내 경쟁사 후보 | 배열(아래) | | 경쟁사 단락, 심사 준비 | `profile` 국내 경쟁사 + `facts` 경쟁사, 국내만, 한글·영문 같은 회사는 하나로 |
| `techKeywords` | 기술 낱말 | `[{ko, en}]` | `[{"ko": "신경망 가속기", "en": "NPU"}]` | 자금 조달 "회사 사업과 관련", 논문 검색어 | `profile` |
| `fundField` | 관심 투자 분야 id(`web/lib/finder.ts`의 `fundFields`) | `Value` | `"ai"`(추정) | 자금 조달 조건 | `profile.fund_field`를 id로 바꿈 |
| `bidKeywords` | 나라장터 검색어 | 글 배열(최대 6) | `["가속기", "반도체"]` | 판로 | `profile.bid_keywords` |
| `pending` | 아직 확인 중인 부분 | 글 배열 | `["investors.confirmed", "employees"]` | 진행 줄 "아직 확인 중", 단락 안 "확인 중" 줄 | |

**`investors[]`**

| 필드 | 뜻 | 예시 |
|---|---|---|
| `name` | 표시 이름 | `"가나다벤처스"` |
| `aliases` | 다른 표기(영문 등) | `["Ganada Ventures"]` |
| `status` | `confirmed`(원문 확인 기록이 하나라도 있음) / `reported` | `"confirmed"` |
| `rounds` | 참여 라운드 수 | `2` |
| `lastDate` | 최근 참여 | `"2025-09-30"` |
| `lead` | 리드·주요 투자자 표기가 있었나 | `true` |
| `sources` | 출처 목록 `[{org, name, kind, url}]` | |

- 기존 투자자 판정(자금 조달 "이미 투자함")은 `status`가 `confirmed`·`reported`인 것만 쓴다(지금 `splitInvestors` 규칙). 이름만 비슷한 "관련 법인" 카드의 투자자는 넣지 않는다.

**`rivals[]`**

| 필드 | 뜻 | 예시 |
|---|---|---|
| `key` | 같은 회사를 묶은 열쇠(사용자 고르기 저장에 씀) | `"rival:마바사"` |
| `name`, `nameEn` | 이름 | `"마바사"`, `"Mabasa"` |
| `relation` | 관계 짧은 낱말 | `"직접 경쟁"` |
| `reason` | 이유 한 줄 | `"같은 추론용 칩 시장에서 경쟁"` |
| `status` | 후보의 상태(대개 `inferred`, `facts`가 낸 것은 `reported`) | `"inferred"` |
| `from` | 어느 단락이 냈나: `["profile"]`, `["facts"]`, 둘 다 | `["profile", "facts"]` |
| `products`, `employees`, `revenue`, `funding` | `facts`가 준 규모 값(있으면, 근거 확인된 것만) | `""` |
| `sources` | 출처 목록 | |

- 해외 기업(`is_korean: false`, 외국 기업의 한국 지사)은 넣지 않는다. 화면도 한 번 더 거른다.
- 정렬: `from`이 둘인 후보 먼저, 그다음 `profile` 순서.

---

## 4. 단락별 데이터

### 4.1 `identity` — 법인 식별 (기본, 무료)

회사 확정 화면은 `GET /api/corp/search?name=`의 응답을 쓴다. 분석 결과의 `identity.result`는 고른 법인 하나다.

| 지금 키 | 뜻 | 예시 | 1층 | 펼치면 |
|---|---|---|---|---|
| `corp.name` | 법인 이름 | "주식회사 가나다테크" | 회사 확정 후보 줄, 표시줄 | |
| `corp.names` | 다른 이름들 | `["가나다테크"]` | 안 씀 | |
| `corp.name_en` | 영문 이름 | "GANADA TECH" | | 개요 "기업 정보 더 보기" |
| `corp.crno` | 법인등록번호 | "1101110000000" | | 개요 2층 |
| `corp.bzno` | 사업자등록번호 | "1234567890" | | 개요 2층 |
| `corp.ceo` | 대표 | "홍길동" | 회사 확정 후보, 개요 "대표" | |
| `corp.founded` | 설립일 | "2020-09-15" | 회사 확정 후보, 업력, 개요 "설립" | |
| `corp.address` | 주소 | "서울특별시 강남구 …" | 시·도와 시·군·구만(`merged.region`, `district`) | 개요 2층에 전체 |
| `corp.homepage` | 홈페이지 | "www.example.co.kr" | | 개요 2층 |
| `corp.industry`, `main_biz` | 업종, 주요 사업(비어 있을 수 있음, 실측에서 빈 값) | "" | | 개요 2층 "업종(금융위)" |
| `corp.sme` | 중소기업 여부(실측에서 빈 값) | "" | 안 씀 | |
| `corp.market` | 상장 구분 | "기타" | | 개요 2층 |
| `corp.employees_fsc` | 금융위 직원 수 칸(실측에서 한 글자) | "" | 안 씀(뜻 확인 필요) | |
| `corp.updated` | 금융위 자료 갱신일 | "2026-05-01" | | 개요 2층 |
| `corp.exact` | 넣은 이름과 정확히 같나 | `true` | "이름이 같음", 미리 고르기·건너뛰기 판정 | |
| `corp_candidates[]` | 같은 이름의 법인 후보(위와 같은 모양) | 실측 2곳 | 회사 확정 최대 5곳 | 개요 2층 "같은 이름의 다른 법인 {n}곳" |
| (제안) `candidates[].snapshotAt` | 서버에 저장된 분석 시각 | "2026-11-22T20:46:24+09:00" | 회사 확정 "저장된 분석 있음" | |
| (제안) `candidates[].region`, `district` | 시·도, 시·군·구 | "서울", "강남구" | 회사 확정 "본사" | |

- 출처: "금융위원회 기업기본정보 (공공 API)", 기준 "{조회일} 조회", 상태 `confirmed`.

### 4.2 `official` — 재무 3년, 국민연금 12개월 (기본, 무료, 실측 10.4초)

| 지금 키 | 뜻 | 예시 | 1층 | 펼치면 |
|---|---|---|---|---|
| `financials[]` | 최근 3개 사업연도(실측 3행) | | 재무 막대: `연도`, `매출액`, `영업이익` | "재무 표 보기": 아래 모든 칸 |
| `financials[].연도` | 사업연도 | "2022" | 막대 가로축 | 표 열 머리 |
| `financials[].기준일` | 결산일 | "2022-12-31" | 묶음 출처 줄 | |
| `financials[].구분` | 연결·별도 | "별도요약재무제표" | "별도"로 줄여 핵심 값·출처 줄 | 표 열 머리 |
| `financials[].통화` | 통화 | "KRW" | 억원 바꾸기 판단 | |
| `매출액`, `영업이익`, `당기순이익`, `자산총계`, `부채총계`, `자본총계`, `자본금` | 원 단위 금액 | `5670000000` | 매출액·영업이익 | 표(억원, 소수 첫째 자리) |
| `법인세차감전순이익` | 원 단위 | | 안 씀 | 표에 넣지 않음 |
| `부채비율(%)` | 서버 계산값 | `48.2` | | 표 |
| `매출액 증가율(%)`, `영업이익률(%)` | 서버 계산값(실측 3행 모두 `null`) | `null` | | 표, `null`이면 "—" |
| `financials_all[]` | 전체 연도(실측 3행) | | | 3행보다 많을 때만 "전체 연도 재무" |
| `nps.monthly[]` | 12개월 | | 국민연금 선: `월`, `가입자 수` | "월별 가입자 표" |
| `nps.monthly[].월` | 월 | "2026-10" | 선 가로축 | 표 |
| `nps.monthly[].가입자 수`, `신규 취득`, `상실` | 명 | `118`, `5`, `2` | 가입자 수 | 표 |
| `nps.monthly[].전월 대비` | 서버 계산값(첫 달 `null`) | `3` | | 표 |
| `nps.monthly[].업종`, `주소` | 매달 같은 값 | | 안 씀 | "어느 사업장 자료인가요?"에 한 번 |
| `nps.summary` | `시작`, `최근`, `증감`, `증가율(%)`, `기간`, `신규 취득 합계`, `상실 합계` | `{"최근": 118, "증감": 14, …}` | 핵심 값 "12개월 전보다 {증감}명", 머리 요약 | 질문 3층(신규 취득·상실 합계) |
| `nps.matched[]` | 맞춘 사업장 `{사업장명, 사업자번호(마스킹)}`(실측 1곳) | | | "어느 사업장 자료인가요?" |
| `nps.note` | 서버 설명 문장(실측 108자) | | | 같은 곳 |
| `errors[]` | 일부 실패 사유 | `[]` | `partial` 사유 | |
| `financials_crno` | 재무를 찾은 법인등록번호 | | 안 씀(다르면 서버가 `partial`로) | |

- 묶음 출처: 재무 "금융위원회 요약재무제표 (공공 API)" + "{첫 연도}~{끝 연도} 사업연도, {연결/별도}", 상태 `confirmed`. 국민연금 "국민연금공단 사업장 가입자 (공공 API)" + "{첫 월}~{끝 월}", 상태 `reference`.
- 같은 연도에 연결·별도가 모두 있으면 연결을 쓴다(지금 서버 규칙). 화면은 `구분`을 그대로 보인다.

### 4.3 `profile` — 사업·제품·기술, 경쟁사 후보, 기술 낱말 (기본, 실측 22.3초)

| 지금 키 | 뜻 | 예시 | 1층 | 펼치면 |
|---|---|---|---|---|
| `profile.industry` | 업종 한 줄(웹) | "AI 반도체 설계" | 개요 머리 요약 | 개요 2층 "업종(웹 조사)" |
| `profile.business` | 사업 설명(실측 227자) | "가나다테크는 …" | 처음 2줄 | "더 읽기"로 전체 |
| `profile.products[]` | `{name, desc}`(실측 6개) | `{"name": "가나다 칩", "desc": "추론용 …"}` | 이름 3개 | 이름과 설명 모두 |
| `profile.core_tech[]` | 핵심 기술 낱말(실측 6개) | "저전력 설계" | 4개 | 모두 |
| `profile.status_notes[]` | 회사 현황 문장(실측 7개, 41~104자) | | | "회사 현황 메모" |
| `profile.competitors[]` | `{name, name_en, registered_name_ko, country, is_korean, relation, reason}`(실측 국내 3곳) | | `merged.rivals`로 | |
| `profile.tech_keywords[]` | `{ko, en}`(실측 9개) | | 안 보임(`merged.techKeywords`) | |
| `profile.gov_keywords[]` | 지원사업 낱말(실측 14개) | | 안 보임("회사 사업과 관련" 판정) | |
| `profile.bid_keywords[]` | 나라장터 낱말(실측 6개) | | 판로 검색어 칩 | |
| `profile.fund_field` | 관심 투자 분야(실측 "AI") | "AI" | 자금 조달 조건(`merged.fundField`) | |
| `profile.stage` | 기업 단계 추정 | "후기·상장 준비" | 안 씀 | |
| `profile.name_ko`, `name_en`, `aliases[]`, `is_korean`, `founders` | 이름, 별칭 | | 안 씀 | |
| `sources[]` | `{title, url, date}`(실측 25건) | | 묶음 출처 줄 "{n}건" | "근거 자료 {n}건 보기" |
| `excluded_competitors[]` | 국내가 아니라 뺀 경쟁사 | | 안 씀(해외 기업은 보여 주지 않음) | |
| `corp`, `corp_candidates` | `identity`와 같음 | | 안 씀(중복) | |

- 묶음 출처: "Liner 웹 검색 자료 {n}건을 모델이 정리", 상태 `inferred`(9절 질문 1).

### 4.4 `facts` — 원문 확인 사실, 기존 투자자, 엔진 경쟁사 (기본, 실측 143.5초·합친 서버 약 176초, 맨 나중)

| 지금 키 | 뜻 | 예시 | 1층 | 펼치면 |
|---|---|---|---|---|
| `fields[]` | `{key, label, value, status, sourceUrl, evidence, note}`(실측 5개: `founded`, `region`, `industry`, `employees`, `revenue`) | `{"key": "employees", "value": "약 120명", "status": "reported", …}` | `merged`의 `employees`, `revenue.web`, `founded`(엇갈림 쪽), `industry.web` | 3층: `evidence`를 근거 문장, `sourceUrl`을 원문 열기 |
| `investors[]` | `{name, round, date, status, sourceUrl}`(실측 20곳, 모두 `confirmed`) | | `merged.investors`로 | |
| `competitors[]` | `{name, relation, products, revenue, employees, funding, asOf, status, sourceUrl, figuresStatus?, figuresUrl?, founded?}`(실측 6곳, 해외 포함) | | `merged.rivals`로(국내만) | |
| `rivalFunding[]` | 경쟁사 투자(설계상 `facts`는 경쟁사 조사를 빼므로 비어 있음) | `[]` | 안 씀(경쟁사 투자는 `rivals_deep`에서) | |
| `draft` | 회사 정보 초안 | | 안 씀(`merged`가 대신) | |
| `meta` | 검색 수, 읽은 쪽 수 등 | | 안 씀 | |

### 4.5 `funding_history` — 투자 라운드·투자기관 (기본, 실측 4.2초, `profile` 뒤)

지금 결과는 `by_company.{회사 이름}` 아래에 있다. 대상 회사 하나만 돌리므로 계약에서는 한 단계 걷어 내기를 제안한다.

| 지금 키 | 뜻 | 예시 | 1층 | 펼치면 |
|---|---|---|---|---|
| `rounds[]` | 라운드(실측 10건) | | 최근 3건 | "라운드 {n}건 모두 보기" |
| `rounds[].date` | 날짜 | "2025-09-30" | 줄 첫 칸 | |
| `rounds[].reported_date` | 보도일(날짜 없을 때) | | "보도 {날짜}" | |
| `rounds[].round` | 단계(원래 표기) | "Series B" | 우리말로 바꿔 보임 | 3층 원래 표기 |
| `rounds[].amount`, `amount_value`, `currency` | 금액 글, 숫자, 통화 | "$100.0M", `100000000`, "USD" | 금액(통화 그대로), 없으면 "미공개" | |
| `rounds[].other_amounts[]` | 다른 출처 금액 | `["$90M"]` | "다른 자료 금액"과 "엇갈림"(1층) | |
| `rounds[].investors[]` | 투자기관 이름(실측 1~17곳) | | "투자기관 {k}곳" | 3층 모두 |
| `rounds[].lead[]` | 리드 표기 | | | 3층 |
| `rounds[].entity`, `entity_match` | 투자 대상 법인, 이름 일치 방식 | "가나다테크", "exact" | | 3층 "투자 대상"(다를 때) |
| `rounds[].source_type`, `sources[]` | `premium_structured` 등, `{type, label, url}` | | 묶음 출처 | 3층 출처 줄 |
| `rounds[].raw`, `summary` | 원래 글, 요약 | | | 3층 |
| `investors[]` | `{투자기관, 유형(이름 기반 추정), 참여 라운드 수, 참여 라운드[], 최근 참여, 리드·주요 투자자 표기}`(실측 31곳) | | `merged.investors`로. `유형`은 안 씀 | |
| `summary.rounds`, `summary.latest{date, round, amount}` | 라운드 수, 최근 라운드 | | 머리 요약, 핵심 값 작은 글 | |
| `summary.cumulative{basis, label, by_currency{}, rounds_with_amount, rounds_total, entity, note}` | 누적 투자(통화별) | `{"label": "누적 투자유치(PDL)", "by_currency": {"USD": 2.5e8}}` | 핵심 값 큰 값, 머리 요약 | |
| `summary.total_raised*`, `funding_stage`, `funding_round_count_pdl`, `disclosed_amounts[]`, `vc_like` | PDL 카드 값 | | 안 씀(`cumulative`가 대신) | |
| `cards[]` | PDL 회사 카드 `{name, match, …}`(실측 1장, 일치) | | | 이름만 비슷한 카드(`match`가 일치 아님)만 "이름이 비슷한 다른 법인 자료" |
| `articles[]` | 투자 관련 기사(실측 0건) | | | "투자 관련 기사 {n}건" |
| `errors[]` | 실패 사유 | | `partial` 사유 | |

- 묶음 출처: "People Data Labs 회사 카드 (Liner Premium)" + "{조회일}", 상태 `reported`. 웹 보완 라운드는 "Liner 웹 검색 (검색 결과 발췌)".
- 누적 기준 이름(제안): `cumulative.label`을 화면 문구로 바꿔 준다. "People Data Labs 누적액" / "라운드 금액 합계 (금액이 있는 라운드 {k}건만 더함)".
- `cards[].match` 값은 실측에서 `exact`만 보였다. 이름만 비슷한 카드의 값(예: `similar`)은 확인 필요.

### 4.6 `news` — 뉴스, 중요 사건 (기본, 실측 17.9초, `profile` 뒤)

| 지금 키 | 뜻 | 예시 | 1층 | 펼치면 |
|---|---|---|---|---|
| `summary.events[]` | 중요 사건(실측 14개) | | 최신 3개 | "중요 사건 {n}개 더 보기" |
| `events[].date` | 날짜(월까지만 있는 것도 있음) | "2026-06" | 줄 첫 칸 | |
| `events[].category` | 분류(모델이 쓴 자유 글, 실측 14개 모두 다름) | "해외 진출" | 줄 | |
| `events[].title` | 제목(실측 18~34자) | | 줄 | |
| `events[].detail` | 설명(실측 38~89자) | | | 3층 |
| `events[].source` | 근거 기사 위치(실측 정수). 기사 목록의 순번인지 확인 필요 | `12` | | 3층 근거 기사 |
| `events[].url`, `기사 제목` | 근거 기사 주소, 제목 | | | 3층 "기사 열기" |
| `summary.trends[]` | 흐름 문장(실측 5개, 44~64자) | | | "흐름 요약 보기" |
| `summary.summary` | 긴 요약 문단(실측 523자) | | 안 씀 | |
| `collect.articles[]` | 기사(실측 693건, 건당 약 0.8KB) | | 건수만 | "기사 {m}건 보기": 20건씩 |
| `articles[].date`, `title`, `매체` | 날짜, 제목, 매체 | | | 줄 |
| `articles[].description` | 발췌(평균 약 127자) | | | 3층(3줄까지) |
| `articles[].url`, `naver_url` | 원문, 네이버 주소 | | | 3층 "기사 열기"(원문 우선) |
| `articles[].분류[]` | 분류(고정 10종, 기사당 1~5개) | `["수주·계약", "해외 진출"]` | | 분류 칩, 3층 |
| `articles[].관련 기사 수` | 묶인 같은 기사 수 | `3` | | "비슷한 기사 {k}건"(2 이상) |
| `articles[].publisher`, `provider`, `url_key`, `source_api` | 내부 값 | | 안 씀 | |
| `collect.raw_count`, `api_counts{naver, liner}`, `period` | 수집 건수, 기간 | `1300`, `"2025-11-22 ~ 2026-11-22"` | 묶음 출처 줄 | |
| `collect.errors[]` | 실패 사유 | | `partial` 사유 | |
| (제안) `categoryCounts` | 분류별 건수 | `{"기술개발": 301, …}` | | 분류 칩 숫자 |

- **기사 목록은 따로 받는다(제안)**: `GET /api/analysis/{jobId}/news/articles?offset=0&limit=20&category=수주·계약` → `{total, items[]}`. 서버 분석 결과에는 기사 전체가 있지만, 화면이 처음 받는 응답과 브라우저 사본에는 최근 20건만 넣는다(설계 문서 4.3). 따로 받지 않기로 하면 처음 응답에 전체를 넣고 화면이 나눠 보인다.
- 분류 고정 10종(실측): 기술개발, 해외 진출, 사업제휴, 수주·계약, 경영진·인터뷰, 정부 관련, 투자유치, 제품 출시, 매출·실적, 기타 동향.
- 묶음 출처: "NAVER 뉴스 검색, Liner 검색" + "{period}, 중복 정리 후 {m}건 (수집 {raw_count}건)", 상태 `reported`.

### 4.7 `patents` — 국내 특허 (기본, 실측 8.6초, `profile` 뒤)

지금 결과는 `companies[]`(대상 회사 1곳, `self: true`)다.

| 지금 키 | 뜻 | 예시 | 1층 | 펼치면 |
|---|---|---|---|---|
| `summary.total`, `registered`, `recent5` | 확인 특허 수, 등록 수, 최근 5년 출원 | `11`, `8`, `9` | 머리 요약, 핵심 값 | |
| `summary.by_year{}` | 출원연도별(실측 5개 연도) | `{"2025": 3, "2024": 1}` | 특허 연도 선(없는 연도는 0) | |
| `summary.top_fields[]` | 주요 기술 분야 | | 안 씀 | |
| `patents[]` | 특허(실측 11건) | | 최근 출원 3건 | "특허 {n}건 모두 보기" |
| `patents[].title`, `filing_date` | 발명의 명칭, 출원일 | | 줄 | |
| `patents[].registration_no` | 등록번호(있으면 "등록", 없으면 "공개") | | 줄 | 3층 |
| `patents[].status` | 상태 글(값 목록 확인 필요) | | 안 씀(등록번호로 판정) | |
| `patents[].abstract` | 요약(실측 0~520자) | | | 3층 전체 |
| `patents[].application_no`, `publication_no`, `cpc[]`, `url` | 번호, 분류, 원문 | | | 3층 |
| `mentions[]` | 출원인이 다른 언급 문서 `{pub_no, title, assignee, filing_date, url}`(실측 1건) | | | "출원인이 다른 문서 {k}건" |
| `pages_checked`, `candidates_left` | 원문 확인한 문서 수, 남은 후보(실측 30, 71) | | 한도에 닿았을 때 1줄 | |
| (제안) `pages_limit` | 원문 확인 한도(지금 30) | `30` | "한도에 닿음" 판정(`pages_checked >= pages_limit`) | |
| `note`, `basis` | 설명 문장 | | | "이 숫자의 한계" |
| `errors[]` | 실패 사유 | | `partial` 사유 | |

- 묶음 출처: "특허 공개 원문 (Google Patents)" + "{조회일}, 출원인이 이 회사인 국내 특허만", 상태 `confirmed`.

### 4.8 `papers` — 논문 동향 (열 때, 실측 안 함)

`app.py`의 `R["tech"]`에서 읽은 키다.

| 지금 키 | 뜻 | 1층(실행 후) | 펼치면 |
|---|---|---|---|
| `company_papers[]` | 회사별 직접 참여 논문 `{company, self, works[], by_year, count_basis, mention_by_year, mode, error, direct}` | 대상 회사(`self`)의 `works` 수와 3건 | "직접 참여 논문 {n}건 모두 보기" |
| `works[]` | `{제목, 연도, 저자, 소속, 피인용, 주요 논문, 링크}` | 제목, 연도, 학술지·학회 | 3층 저자, 소속, 피인용, 논문 열기 |
| `topics[]` | 기술 분야 `{name, en, trend{by_year, institutions[]}, papers[]}` | | "분야별 발표 추이와 주요 논문" |
| `topics[].papers[]` | `{제목, 링크, 연도, 출처, 피인용, 저자, 소속, 학술지·학회, 초록, 주요 논문}` | | 분야마다 3건(초록은 안 씀) |
| `summary.{분야}` | `{summary, relevance, key_papers[]}` | | 연구 흐름 2줄 |

- `works[]`에 학술지·학회 칸이 있는지 확인 필요(`topics[].papers[]`에는 있음). 없으면 1층 줄에서 뺀다.
- 묶음 출처: "OpenAlex 논문 DB (공개 API)" + "{조회일}", 상태 `reported`(9절 질문 2).

### 4.9 `rivals_deep` — 경쟁사 깊이 비교 (열 때, 실측 안 함)

`app.py`의 `R["rivals"]`, `R["rivals_summary"]`에서 읽은 키다. 요청 본문은 1.3절.

| 지금 키 | 뜻 | 1층(실행 후) | 펼치면 |
|---|---|---|---|
| `rivals[].info{name, country, relation, reason}` | 경쟁사 | 비교 표 줄 이름 | |
| `rivals[].public.financials[]` | 재무(4.2절과 같은 모양) | 최근 연도 매출과 연도 | "{이름} 자세히" 재무 막대 |
| `rivals[].public.nps{monthly, summary}` | 국민연금 | 최근 가입자와 월 | 국민연금 선 |
| `rivals[].public.corp` | 법인 | | 자세히 |
| `rivals[].funding_history` | 4.5절과 같은 모양 | 누적 투자(통화별) → 누적 투자 막대 | 최근 라운드 3건 |
| `rivals[].errors[]`, `public.errors[]` | 미확보 사유 | 칸 "미확보" | 자세히 사유 |
| `rivals[].news` | 경쟁사 뉴스 | 안 씀 | 안 씀 |
| `rivals_summary.{이름}{business, products_tech, recent_changes[]}` | 경쟁사 요약 | | 사업 2줄, 제품·기술 1줄, 변화 3줄 |
| (제안) 경쟁사 특허 `{name, total, by_year}` | 4.7절 요약만 | 확인된 특허 | "특허 연도 비교 보기" |
| (제안) `rivalInvestors[]` `{rival, investors[]}` | 경쟁사 투자기관 이름 | 자금 조달 "경쟁사에 투자" 판정 | |
| (제안) `rivalSet` | 이 결과를 만든 경쟁사 열쇠 목록 | 고르기가 바뀌었는지 판정 | |

**경쟁사 조건이라면?에 넘기는 값**(제안): 업종 = 경쟁사 요약의 사업 한 줄, 설립 = 금융위 설립일, 매출 = 금융위 최근 연도 매출(연도 포함), 투자 이력 = 누적 투자(통화 그대로). 국민연금 가입자 수는 직원 수 칸에 넣지 않고 메모에 "국민연금 가입자 {n}명(직원 수와 다름)"으로 넣는다. 추정·엇갈림 값은 비워 보낸다(지금 `rivalCompany` 규칙).

### 4.10 `sales` — 나라장터 입찰공고 (열 때, 무료, 실측 안 함)

`research/gov.py`의 `g2b_search` 반환 모양이다.

| 지금 키 | 뜻 | 예시 | 1층 | 펼치면 |
|---|---|---|---|---|
| `items[]` | 입찰공고 | | 5건 | "10건 더 보기" |
| `공고명` | 공고 이름 | "가속기 실증 장비 구매" | 줄 | |
| `기관` | 공고·수요기관 | "가나다시청" | 줄 | |
| `금액` | 배정예산 또는 추정가격, 없으면 "공고문 확인" | "3.2억원" | 줄 | |
| `마감`, `기간` | 마감일, 입찰 기간 | "2026-12-01", "… ~ …" | 마감(D-n) | 3층 기간 |
| `상태` | "입찰 진행 중" / "입찰 예정" / "입찰 마감" / "상태 확인 불가" | | 정렬, 마감 표시 | |
| `관련성` | "높음"(핵심 낱말 일치) / "보통" | | "핵심 낱말 일치" 표시(높음만), 정렬 | |
| `분야` | 물품/용역 | | | 3층 구분 |
| `사업 내용` | 입찰 방식, 계약 방법 | | | 3층 입찰 방식 |
| `신청조건` | "참가자격은 공고문 확인" / "물품분류 제한" | | | 3층 |
| `관련 키워드` | 일치한 검색어 | | | 3층 |
| `링크`, `공고일` | 공고 주소, 공고일 | | | 3층 "공고 열기" |
| `calls`, `errors[]`, `error_count`, `skipped`, `period` | 호출 수, 실패, 기간 | | 요약·묶음 출처 줄, `partial` 사유 "{error_count}건" | |

- 판로 지원사업은 서버를 부르지 않는다. 자금 조달과 같은 `/data/programs.json`에서 `category`가 "내수"(실측 스냅샷 83건), "수출"(138건)인 공고를 같은 지역·대상 규칙(`matchProgram`)으로 거른다.
- 묶음 출처: "조달청 나라장터 입찰공고 (공공 API)" + "{period} 조회", 상태 `confirmed`.

---

## 5. 단락 밖 데이터 (지금 그대로 쓰는 것)

| 데이터 | 어디서 | 화면 | 바뀌는 점 |
|---|---|---|---|
| 기업마당 공고 `Program` | `/data/programs.json` | 자금 조달, 판로 | 없음 |
| 모태 자펀드 `Fund` | `/data/funds.json` | 자금 조달 | 없음 |
| 기준일 `Meta` | `/data/meta.json` | 자금 조달 바닥 | 없음 |
| 공고문 자격 대조 `Analysis` | `POST /api/notice/analyze` `{programId, company}` | 심사 준비 | `company`에 `merged` 값과 고친 값을 넣고, 메모(`notes`)에 특허 수와 국민연금 가입자 수(직원 수와 다르다는 말 포함)를 넣는다(설계 문서 3.5) |
| 운용사 요약 `Brief` | `POST /api/gp/brief` `{gp, company}` | 심사 준비 | 없음. `facts[].kind` 값 목록 확인 필요(9절 질문 4) |
| 서버 상태 | `GET /api/health` | 시작 화면 "분석 시작" 활성 여부 | 없음 |

---

## 6. 브라우저 저장 (IndexedDB)

로그인이 없으므로 사용자의 것은 브라우저 저장소(IndexedDB)에 둔다(설계 문서 4.3). 서버로 보내지 않는다(대조·요약을 실행할 때 필요한 값만 요청에 실어 보낸다).

| 저장 칸 | 열쇠 | 내용 | 쓰는 화면 |
|---|---|---|---|
| `companies` | `companyId` | `{name, lastOpenedAt, analyzedAt, isExample}` | 시작 "이어서 보기" |
| `snapshots` | `companyId` | 받은 분석 사본. 기사는 최근 20건만, 나머지 단락은 그대로 | 회사 분석 바로 열기 |
| `jobs` | `companyId` | `{jobId, startedAt}` 진행 중 작업 | 다시 들어왔을 때 이어 받기 |
| `edits` | `companyId` | 고친 값 8칸 `{region, bizType, founded, industry, employees, revenue, need, notes}`, 칸마다 `updatedAt` | 표시줄, 값 고치기, 대조 |
| `saved` | `[companyId, kind, itemId]` | 담은 항목. `kind`: `program`, `gp`, `salesProgram`, `bid` | 심사 준비, 노트, 메뉴 숫자 |
| `checks` | `[companyId, programId]` | 대조 결과 `Analysis` + `ranAt` + 대조에 쓴 회사 값 사본(바뀌었는지 판정) | 심사 준비, 노트 |
| `rivalChecks` | `[companyId, programId, rivalKey]` | 경쟁사 조건 대조 결과 | 심사 준비 |
| `briefs` | `[companyId, gp]` | 운용사 요약 `Brief` + `ranAt` + 회사 값 사본 | 심사 준비, 노트 |
| `rivalChoices` | `companyId` | `{choices: {rivalKey: "yes" \| "no"}, added: [{name}]}` | 경쟁사, 심사 준비 |
| `prep` | `companyId` | `{questions: {id: {ready, memo}}, dd: {id: ready}}` | 심사 준비 투자 |
| `notes` | `companyId` | `{memo, updatedAt}` | 노트 |
| `salesKeywords` | `companyId` | 고친 나라장터 검색어 | 판로 |

- 펼침 상태는 저장하지 않는다(같은 방문 안의 메모리에만).
- "파일로 내보내기"는 `snapshots`, `jobs`를 뺀 그 회사의 모든 칸 + `{version, companyId, name, exportedAt}`.
- `/funding`(회사 없이)의 조건과 저장 목록은 지금 펀딩노트 방식(localStorage `fundingnote.*`)을 그대로 쓴다.
- 대조 결과의 열쇠에서 회사 값을 뺐다(지금 코드는 회사 값까지 열쇠에 넣어, 값이 바뀌면 결과가 사라진다). 대신 회사 값 사본을 함께 두고, 지금 값과 다르면 "이전 회사 값으로 한 대조입니다"를 보인다.

---

## 7. 서버에 새로 필요한 것 모음

| # | 무엇 | 왜 | 없으면 화면은 |
|---|---|---|---|
| 1 | 단락 상태 값 목록(`waiting`~`idle`)과 `error.code` | 미확보 사유별 문장과 행동 | `error` 문자열을 그대로 보인다(문장 품질이 떨어짐) |
| 2 | `expectedSeconds`, `estimates` | "보통 … 안에 끝납니다", 확인 창 | 1.2·1.4절 기본값 |
| 3 | `analyzedAt`(작업과 단락) | 분석 시각, 오래됨, 단락만 새로 받은 시각 | 화면이 받은 시각을 쓴다(부정확) |
| 4 | `merged`(3절) | 화면마다 같은 회사 값·투자자·경쟁사 | 화면마다 합치게 되어 값이 달라질 수 있다 |
| 5 | 저장된 분석 찾기, 진행 중 작업 찾기, 예시 회사(1.3절) | 다시 열기, 다른 사람이 같은 회사 열기, 예시 회사 | 이어서 보기는 브라우저 사본만 된다 |
| 6 | 회사 후보의 `snapshotAt`, `region`, `district` | 회사 확정 "저장된 분석 있음", "본사" | 표시를 뺀다. 주소 글에서 시·군·구를 화면이 잘라야 한다 |
| 7 | 기본 단락 다시 실행(`sections/{key}`) | 뉴스만 새로, 미확보 단락 다시 분석 | 뉴스만 새로와 다시 분석 단추를 숨긴다 |
| 8 | 기사 나눠 받기, `categoryCounts` | 기사 693건을 한 번에 받지 않기 | 처음 응답에 전체를 넣는다 |
| 9 | `refresh.remainingToday` | 확인 창의 남은 횟수 | 줄을 뺀다 |
| 10 | `rivalInvestors`, `rivalSet`, 경쟁사 특허 요약 | 경쟁사에 투자 표시, 고르기 바뀜 판정, 특허 비교 | 표시와 비교를 뺀다 |
| 11 | `pages_limit` | 특허 원문 한도 문장 | 문장을 뺀다 |

---

## 8. 한글 키를 영문으로 바꿀 때 (제안)

| 지금 | 제안 |
|---|---|
| `financials[].연도`, `기준일`, `구분`, `통화` | `year`, `periodEnd`, `basis`, `currency` |
| `매출액`, `영업이익`, `당기순이익`, `자산총계`, `부채총계`, `자본총계`, `자본금`, `법인세차감전순이익` | `revenue`, `operatingIncome`, `netIncome`, `totalAssets`, `totalLiabilities`, `totalEquity`, `capital`, `pretaxIncome` |
| `부채비율(%)`, `매출액 증가율(%)`, `영업이익률(%)` | `debtRatioPct`, `revenueGrowthPct`, `operatingMarginPct` |
| `nps.monthly[].월`, `가입자 수`, `신규 취득`, `상실`, `전월 대비`, `업종`, `주소` | `month`, `members`, `joined`, `left`, `change`, `industry`, `address` |
| `nps.summary.시작`, `최근`, `증감`, `증가율(%)`, `기간`, `신규 취득 합계`, `상실 합계` | `first`, `latest`, `change`, `changePct`, `period`, `joinedTotal`, `leftTotal` |
| `nps.matched[].사업장명`, `사업자번호(마스킹)` | `name`, `bznoMasked` |
| `funding_history.investors[].투자기관`, `참여 라운드 수`, `참여 라운드`, `최근 참여`, `리드·주요 투자자 표기`, `유형(이름 기반 추정)` | `name`, `roundCount`, `rounds`, `lastDate`, `lead`, (`type`은 화면에서 안 씀) |
| `news.articles[].관련 기사 수`, `매체`, `분류`, `events[].기사 제목` | `relatedCount`, `outlet`, `categories`, `articleTitle` |
| `sales.items[]` 한글 키 전부 | `title`, `agency`, `kind`, `summary`, `amount`, `period`, `deadline`, `status`, `condition`, `relevance`, `keywords`, `url`, `noticeDate` |

---

## 9. 확인이 필요한 데이터 질문

1. `profile`의 사업 설명·제품·핵심 기술은 상태를 무엇으로 둘까. 이 문서는 "추정"(검색 자료를 모델이 정리, 원문 확인 안 함)으로 두었다.
2. OpenAlex 논문 값의 상태를 "보도"(DB에 적힌 값)로 둘까, 공공 API처럼 "원문 확인"으로 둘까. OpenAlex는 공공기관 원자료가 아니라서 "보도"로 두었다.
3. 기업 유형(`bizType`)을 무엇으로 정할까. 금융위 `sme` 칸은 실측에서 비어 있었다. 업력 7년 같은 규칙은 근거가 없어 정하지 않았다. 정하지 못하면 "미확보"로 두고 사용자가 고른다.
4. 운용사 요약 `facts[].kind`에 "투자 분야", "투자 단계" 같은 값이 오는지. 오지 않으면 심사 준비 카드의 1층 두 줄은 빼고 맞닿는 점·물어볼 것만 보인다.
5. `news.summary.events[].source`(정수)가 `collect.articles[]`의 순번인지.
6. `funding_history.cards[].match`에서 이름만 비슷한 카드의 값.
7. `corp.employees_fsc`의 뜻(실측 한 글자).
