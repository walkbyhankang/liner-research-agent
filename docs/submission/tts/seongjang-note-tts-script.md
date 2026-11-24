# 성장노트 데모 영상 음성 대본 (Google TTS용)

> 스토리보드 개정안(`seongjang-note-video-storyboard.md`, 4분 42초)의 내레이션 29줄을 음성 합성용으로 옮긴 대본입니다.
> 줄마다 어조(`style`)와 쉼 태그를 붙였고, 숫자와 영문은 소리 나는 대로 적었습니다. 같은 내용을 생성 스크립트가 읽는 `seongjang-note-tts-lines.json`에도 담았습니다.

## 설정

| 항목 | 값 |
|---|---|
| 모델 | Gemini API `gemini-3.8-flash-tts`. 예비로 Cloud TTS `gemini-3.1-flash-tts-preview`, Chirp 3: HD |
| 어조 | 줄마다 `speech_metadata.style`로 보냅니다. 모든 줄 앞부분은 같은 기본 어조이고, 뒤에 그 줄의 변화만 붙입니다 |
| 기본 어조 | `calm, clear Korean product-demo narrator, warm and professional` (차분하고 또렷한 제품 시연 내레이터, 따뜻하고 단정하게) |
| 쉼 | 대본 안의 `<short pause>`(약 0.25초), `<long pause>`(1초 이상). 나머지는 문장부호로 쉽니다 |
| 음성 | 기본 `ko-kr-storyteller-4`(확장 음성 목록의 한국어 전용 음성, 서울말·여성·중간 음높이). 목록은 `GET /v1beta/voices?language_code=ko-KR`로 받습니다. 샘플 비교 목록(`sample_voices`)은 이 음성과 기본 음성 Kore, Charon, Sulafat, Achernar, Iapetus, Sadaltager입니다. 다른 음성을 골랐다면 2)·3)의 `--voice`에 같은 이름을 넣습니다 |
| 최대 길이 | 다음 내레이션이나 장 제목이 시작되기 0.2초 전까지입니다. 마지막 줄은 로고를 3초 이상 보여 주도록 잡았습니다 |

- 어조와 태그는 영어로 적었습니다. Google 안내에서 태그는 영어로 쓰라고 하고, 어조 예시도 모두 영어이기 때문입니다.
- 예상 길이는 지금 영상 음성의 말 빠르기로 계산한 값입니다. Google 음성은 빠르기가 다를 수 있으니, 만든 뒤 `report`로 최대 길이와 비교합니다.

## 대본

### 티저

| 번호 | 시작(분:초) | 최대(초) | 예상(초) | 의도 | 어조(style 뒷부분) | 음성 대본 |
|---|---|---:|---:|---|---|---|
| T01 | 0:00.3 | 5.4 | 5.1 | 궁금증을 여는 질문 | curious, inviting opening questions, natural rising intonation | 우리 회사는 지금 어디쯤 와 있을까요? 받을 수 있는 자금은 무엇일까요? |
| T02 | 0:05.9 | 4.2 | 3.5 | 제품 이름을 또렷하게 | confident and warm, gently emphasize 성장노트 | 회사 이름 하나면 됩니다. `<short pause>` 성장노트입니다. |
| T03 | 0:10.3 | 6.2 | 5.0 | 가볍고 시원하게 | bright and confident, brisk but clear | 이름을 넣으면 공공 자료와 공개 보도를 모아, 바로 분석을 시작합니다. |
| T04 | 0:16.7 | 15.7 | 6.0 | 항목을 하나씩 짚기 | bright and confident, each list item spoken distinctly | 매출, `<short pause>` 고용, `<short pause>` 투자, `<short pause>` 특허. 값마다 확인 상태와 출처를 함께 보여 줍니다. |
| T05 | 0:32.6 | 5.5 | 4.5 | 티저 마무리 | confident, satisfying wrap-up | 경쟁사 비교부터 자금, 심사 준비까지, 노트 한 장에 담습니다. |

### 01 해결하려는 문제

| 번호 | 시작(분:초) | 최대(초) | 예상(초) | 의도 | 어조(style 뒷부분) | 음성 대본 |
|---|---|---:|---:|---|---|---|
| P01 | 0:41.2 | 11.4 | 11.0 | 공감하며 문제 제기 | measured and empathetic, describing a familiar problem | 자금이 필요한 회사는, 먼저 회사 현황부터 정리해야 합니다. 그런데 재무, 고용, 투자, 특허 자료는 기관마다 흩어져 있고, 자료끼리 값이 다르기도 합니다. |
| P02 | 0:52.8 | 12.9 | 12.6 | 숫자를 또박또박 | measured and clear, slight emphasis on each number | 접수 중인 공고는 천삼백삼 건입니다. `<short pause>` 신청기간의 칠십일 퍼센트는 날짜가 아니라, 예산 소진 시까지 같은 문구이고, 세부 자격은 사십칠 쪽짜리 공고문을 읽어야 알 수 있습니다. |
| P03 | 1:05.9 | 6.1 | 5.9 | 핵심을 단호하게 | slower and firm, this is the key point | 목록은 이미 있습니다. 없는 것은, 우리 회사가 대상인지, 그리고 그 근거입니다. |

### 02 에이전트 동작 화면

| 번호 | 시작(분:초) | 최대(초) | 예상(초) | 의도 | 어조(style 뒷부분) | 음성 대본 |
|---|---|---:|---:|---|---|---|
| G01 | 1:15.1 | 9.4 | 9.2 | 화면 설명 | clear and steady, explaining what is on screen | 회사 이름을 넣으면, 금융위원회 자료로 법인 후보를 보여 줍니다. 법인을 고르면, 이름이 같은 다른 법인의 자료는 섞지 않습니다. |
| G02 | 1:24.7 | 12.0 | 11.6 | 화면 설명, 조금 빠르게 | clear and steady, slightly brisk | 분석은 개요, 재무와 고용, 투자, 최근 동향, 기술, 이렇게 다섯 단락으로 나눠 동시에 조사합니다. 공식 자료가 먼저 도착하고, 오래 걸리는 단락은 따로 이어집니다. |
| G03 | 1:36.9 | 9.6 | 9.2 | 화면 설명 | clear and steady, explaining what is on screen | 값마다 확인 상태와 출처를 표시합니다. 자료끼리 값이 다르면 두 값을 모두 보여 주고, 찾지 못한 값은 미확보와 그 이유를 남깁니다. |
| G04 | 1:46.7 | 7.2 | 7.1 | 끝 문장을 단호하게 | clear and steady, firm on the last sentence | 경쟁사를 고르면, 우리 회사와 같은 항목으로 나란히 비교합니다. 점수나 순위는 매기지 않습니다. |
| G05 | 1:54.1 | 6.8 | 6.6 | 화면 설명 | clear and steady, explaining what is on screen | 분석 결과로 조건을 채워, 정책자금 공고와 모태펀드 운용사, 나라장터 입찰공고를 거릅니다. |
| G06 | 2:01.1 | 10.4 | 10.1 | 화면 설명 | clear and steady, explaining what is on screen | 담은 공고는 공고문에서 조건을 뽑아, 우리 회사 정보와 하나씩 맞춰 봅니다. 조건마다 충족, 미충족, 확인 필요를 근거 문장과 함께 보여 줍니다. |
| G07 | 2:11.7 | 7.2 | 6.8 | 흐름 마무리 | clear and steady, light sense of completion | 운용사 요약과 투자 미팅 예상 질문, 실사 자료까지 준비하고, 결과를 노트 한 장으로 정리합니다. |
| G08 | 2:19.1 | 5.5 | 5.5 | 담담하게 결과 보고 | confident and matter-of-fact, brisk | 자동 테스트 오백이십사 개와, 화면 점검 삼백오십이 건을 모두 통과했습니다. |

### 03 Liner API 활용 지점

| 번호 | 시작(분:초) | 최대(초) | 예상(초) | 의도 | 어조(style 뒷부분) | 음성 대본 |
|---|---|---:|---:|---|---|---|
| L01 | 2:27.9 | 9.1 | 8.9 | 장을 여는 말, 세 구절을 같은 무게로 | clear and confident, opening a key section; three parallel phrases with equal weight | 이제 라이너 에이피아이를 어디에 쓰는지 보겠습니다. `<short pause>` 검색은 라이너가 하고, 판단은 모델이 하며, 확인은 코드가 합니다. |
| L02 | 2:37.2 | 10.4 | 10.1 | 기술 용어를 또렷하게 | clear and explanatory, steady pace for technical terms | 웹 검색, 프리미엄 검색, 학술 검색, 그리고 게이트웨이와 리스폰스로 부르는 모델까지. 라이너 에이피아이 다섯 가지를 아홉 개 기능에 씁니다. |
| L03 | 2:47.8 | 11.4 | 10.8 | 설명 | clear and explanatory, steady pace | 기본 분석에서는 웹 검색으로 회사 개요와 원문 확인 사실, 특허 후보를 찾고, 뉴스를 보완합니다. 투자 라운드와 투자기관은 프리미엄 검색으로 받습니다. |
| L04 | 2:59.4 | 8.2 | 8.1 | 문제와 해법의 대비 | clear, slight emphasis on 얻을 수 없습니다 and 라이너로 | 경쟁사의 투자 라운드와 특허는 공공 에이피아이로 얻을 수 없습니다. `<short pause>` 그래서 경쟁사마다 라이너로 찾습니다. |
| L05 | 3:07.8 | 10.6 | 10.3 | 단계 설명 | clear and explanatory, steady pace | 라이너에는 특허 전용 검색이 없어, 검색어에 특허 사이트를 지정해 후보를 찾습니다. 그다음 공개 원문을 열어, 출원인이 그 회사인 특허만 셉니다. |
| L06 | 3:18.6 | 16.6 | 16.1 | 가장 긴 줄, 조금 빠르게 | clear and steady, slightly brisk to fit a tight slot | 판단은 라이너 게이트웨이로 부른 모델이 합니다. 같은 공고문으로 모델 네 종을 비교해, 조건 추출에는 지피티를, 회사 정보 대조에는 클로드를 골랐습니다. 라이너 자체 모델도 품질은 비슷했지만, 응답이 느려 지피티를 썼습니다. |
| L07 | 3:35.4 | 10.6 | 10.3 | 끝 구절을 단호하게 | clear, firm on the final phrase 원문에 없으면 버립니다 | 모델에는 검색 도구를 주지 않고, 코드가 검색한 결과만 넘깁니다. 모델이 낸 근거 문장은 코드가 원문과 다시 대조하고, `<short pause>` 원문에 없으면 버립니다. |
| L08 | 3:46.2 | 12.9 | 12.5 | 숫자에 힘을 주어 | clear and confident, slight emphasis on 열아홉 번 | 회사 한 곳의 기본 분석에 쓴 라이너 요청은, 실제로 열아홉 번이었습니다. 비용이 큰 호출은 사용자가 요청할 때만 보내고, 호출 상한도 단락별, 하루, 동시 요청, 세 단계로 둡니다. |

### 04 확장 계획

| 번호 | 시작(분:초) | 최대(초) | 예상(초) | 의도 | 어조(style 뒷부분) | 음성 대본 |
|---|---|---:|---:|---|---|---|
| E01 | 4:02.2 | 10.2 | 10.0 | 앞을 내다보며 차분하게 | calm and forward-looking | 분석 결과는 저장해 여러 사람이 다시 쓰고, 공고문 추출은 공고마다 한 번만 합니다. 그래서 비용은 사용자 수보다, 회사 수에 따라 늘어납니다. |
| E02 | 4:12.6 | 8.4 | 8.0 | 앞을 내다보며 차분하게 | calm and forward-looking | 같은 구조를 기술, 수출, 인력 지원사업으로 넓힐 수 있고, 지원기관과 투자 담당자의 사전 검토에도 쓸 수 있습니다. |
| E03 | 4:21.2 | 5.5 | 5.3 | 담담하게 | calm and matter-of-fact | 다음 과제는 새 공고 알림, 이단계 추출, 그리고 배포와 사용자 인증입니다. |

### 마무리

| 번호 | 시작(분:초) | 최대(초) | 예상(초) | 의도 | 어조(style 뒷부분) | 음성 대본 |
|---|---|---:|---:|---|---|---|
| F01 | 4:27.2 | 6.6 | 6.3 | 정리하며 따뜻하게 | warm and confident, summarizing | 성장노트는 공고를 찾는 데서 그치지 않고, 우리 회사가 대상인지, 근거와 함께 답합니다. |
| F02 | 4:34.0 | 4.7 | 3.8 | 마지막 한마디, 천천히 | slower, warm and memorable closing line, emphasize 성장노트 | 점수 대신 출처로 말하는 회사 분석. `<short pause>` 성장노트. |

## 음성 만들기

Google 계정의 API 키나 인증이 있어야 음성을 만들 수 있습니다. 결과는 `results/tts/` 아래에 저장되며, 이 폴더는 커밋하지 않습니다.

```
pip install "google-genai>=2.25.0"
export GEMINI_API_KEY=...   # Google AI Studio에서 발급

# 1) 샘플: L01을 기본 음성 ko-kr-storyteller-4와 후보 6개로 만들어 비교
python docs/submission/tts/synthesize.py samples --line L01

# 2) 고른 음성으로 29줄 전체 생성 → 줄별 길이 판정표(report.csv)
python docs/submission/tts/synthesize.py lines --voice ko-kr-storyteller-4

# 3) 넘친 줄만 다시 생성
python docs/submission/tts/synthesize.py lines --voice ko-kr-storyteller-4 --only L06
```

- `--dry-run`을 붙이면 API를 부르지 않고 보낼 어조와 대본만 출력합니다.
- 넘친 줄은 json의 `style` 끝에 `slightly faster`를 붙이거나 다른 결과를 고릅니다. 그래도 넘치면 스토리보드의 장면 길이를 늘립니다.

## 다른 Google 모델을 쓸 때

| 백엔드 | 모델·음성 | 어조 | 쉼 태그 | 인증 |
|---|---|---|---|---|
| `gemini` (기본) | `gemini-3.8-flash-tts`, 음성 이름 그대로 | `speech_metadata.style` | `<short pause>` | `GEMINI_API_KEY` |
| `cloud` | `gemini-3.1-flash-tts-preview`(미리보기) | `prompt` 필드 | `[short pause]` | gcloud 기본 인증 |
| `chirp` | `ko-KR-Chirp3-HD-<음성>` | 없음, `--rate`로 속도만 | `[pause short]` | gcloud 기본 인증 |

- 스크립트가 쉼 태그를 백엔드에 맞게 바꿔 보냅니다.
- 한국어 Chirp 3: HD 음성은 쉼표에서 쉬지 않는다는 보고가 있습니다. 그럴 때는 `--comma-pause`로 쉼표마다 쉼 태그를 넣습니다.
