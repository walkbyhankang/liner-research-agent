# 성장노트 데모 영상 음성 대본 (Google TTS용, 개정 2)

> 스토리보드 개정 2의 내레이션 35줄을 음성 합성용으로 옮긴 대본입니다. 줄마다 어조(`style`)와 쉼 태그를 붙였고, 숫자와 영문은 소리 나는 대로 적었습니다. 같은 내용을 생성 스크립트가 읽는 `seongjang-note-tts-lines.json`에도 담았습니다.
> 내레이션은 처음부터 끝까지 이어집니다. 장면 길이는 음성 길이에 맞춰 정하므로, 줄마다 정해진 '최대 길이'는 없습니다. 대신 전체 합계를 지킵니다(아래).

## 설정

| 항목 | 값 |
|---|---|
| 모델 | Gemini API `gemini-3.8-flash-tts` (예비: Cloud TTS `gemini-3.1-flash-tts-preview`, Chirp 3: HD) |
| 음성 | 기본 `ko-kr-storyteller-4`(확장 음성 목록의 한국어 전용 음성, 서울말·여성·중간 음높이). 목록은 `GET /v1beta/voices?language_code=ko-KR`로 받습니다. Cloud TTS·Chirp는 `Kore`(`cloud_voice`). 샘플 비교 목록(`sample_voices`)은 이 음성과 Kore, Charon, Sulafat, Achernar, Iapetus, Sadaltager입니다 |
| 어조 | 줄마다 `speech_metadata.style`로 보냅니다: `calm, clear Korean product-demo narrator, warm and professional` + 줄별 변화 + 속도 지시 |
| 속도 | 모든 줄 `style` 끝에 `; speak at a brisk, noticeably faster-than-normal pace with short pauses`(json의 `defaults.pace`). 이 지시 없이 만들면 개정 1의 29줄 중 27줄이 길이를 넘었습니다 |
| 쉼 | `<short pause>`(약 0.25초). 나머지는 문장부호로 쉼 |
| 길이 | 내레이션 합계 예상 261.9초. **합계가 277초를 넘으면 영상이 5분을 넘습니다.** 줄마다 예상보다 15% 넘게 길면(`max_seconds`) 다시 만듭니다 |
| 줄 안의 쉼 | 0.7초가 넘는 쉼이 생기면 그 줄을 다시 만듭니다 |

## 대본

### 티저

| 번호 | 예상(초) | 의도 | 어조(style 가운데 부분) | 음성 대본 |
|---|---:|---|---|---|
| T01 | 4.9 | 궁금증을 여는 질문 | curious, inviting opening questions, natural rising intonation | 우리 회사는 지금 어디쯤 와 있을까요? 받을 수 있는 자금은 무엇일까요? |
| T02 | 3.3 | 질문에 답하며 이름 소개 | confident and warm, gently emphasize 성장노트 | 그 답, 회사 이름 하나면 됩니다. `<short pause>` 성장노트입니다. |
| T03 | 4.7 | 가볍고 시원하게 | bright and confident, brisk but clear | 이름을 넣으면, 공공 자료와 인터넷 자료를 한 번에 모아 분석합니다. |
| T04 | 5.6 | 항목을 하나씩 짚기 | bright and confident, each list item spoken distinctly | 매출, `<short pause>` 고용, `<short pause>` 투자, `<short pause>` 특허. 값마다 얼마나 확인됐는지, 어디서 왔는지 함께 보여 줍니다. |
| T06 | 4.5 | 몽타주 리듬으로 | bright and confident, brisk, montage rhythm | 경쟁사와도 나란히 비교하고, 받을 수 있는 자금까지 찾아 줍니다. |
| T05 | 5.0 | 티저 마무리 | confident, satisfying wrap-up of the teaser | 찾은 공고는 조건과 하나씩 맞춰 보고, 모든 결과를 노트 한 장에 담습니다. |

### 01 해결하려는 문제

| 번호 | 예상(초) | 의도 | 어조(style 가운데 부분) | 음성 대본 |
|---|---:|---|---|---|
| C01 | 6.1 | 장 전환, 카드 세 장을 가리키며 | inviting transition, natural rising intonation on the question | 그럼 성장노트가 해결하려는 문제가 무엇인지, 살펴볼까요? `<short pause>` 문제는 크게 세 가지입니다. |
| P01 | 10.6 | 공감하며 첫째 문제 | measured and empathetic, describing a familiar problem | 자금을 받으려면, 먼저 우리 회사 자료를 정리해야 합니다. 그런데 재무, 고용, 투자, 특허 자료는 기관마다 흩어져 있습니다. 자료끼리 값이 다르기도 합니다. |
| P02a | 5.7 | 둘째 문제, 공고가 많음 | measured and empathetic; light emphasis on 천 건이 넘습니다 | 우리 회사에 맞는 공고를 찾기도 쉽지 않습니다. 접수 중인 공고만, 천 건이 넘습니다. |
| P02c | 5.6 | 셋째 문제, 공고문이 김 | measured and empathetic | 공고문 한 건이 수십 쪽이나 되기도 해서, 지원할 수 있는지 확인하기 어렵습니다. |
| P03 | 6.8 | 목적을 단호하게 | slower and firm, this is the key point | 공고 목록은 이미 있습니다. `<short pause>` 필요한 건, 우리 회사가 대상인지 판단할 근거를, 빠르게 찾는 일입니다. |

### 02 에이전트 동작 화면

| 번호 | 예상(초) | 의도 | 어조(style 가운데 부분) | 음성 대본 |
|---|---:|---|---|---|
| C02 | 4.9 | 장 전환 | calm, clear transition into the next section | 이제 성장노트가 이 근거를 어떻게 찾는지, 실제 화면으로 보겠습니다. |
| G01 | 9.2 | 화면 설명 | clear and steady, explaining what is on screen | 회사 이름을 넣으면, 금융위원회 자료에서 같은 이름의 회사를 찾아 보여 줍니다. 우리 회사를 고르면, 다른 회사 자료는 섞지 않습니다. |
| G02 | 8.9 | 화면 설명 | clear and steady, slightly brisk | 고른 회사는 개요, 재무와 고용, 투자, 최근 동향, 기술, 다섯 주제로 나눠, 한꺼번에 조사합니다. 값은 도착하는 대로 바로 채워집니다. |
| G03 | 9.9 | 화면 설명 | clear and steady, explaining what is on screen | 도착한 값마다 확인 상태와 출처를 붙입니다. 자료끼리 값이 다르면, 두 값을 모두 보여 줍니다. 찾지 못한 값은 미확보로 적고, 그 이유를 남깁니다. |
| G04 | 7.3 | 끝 문장을 단호하게 | clear and steady, firm on the last sentence | 이어서 경쟁사를 정하면, 우리 회사와 같은 항목으로 나란히 비교합니다. `<short pause>` 점수나 순위는 매기지 않습니다. |
| G05 | 7.5 | 화면 설명 | clear and steady, explaining what is on screen | 이렇게 모은 분석 결과로, 빌릴 수 있는 정책자금과, 투자받을 운용사, 제품을 팔 수 있는 입찰공고를 거릅니다. |
| G06 | 10.1 | 화면 설명 | clear and steady, explaining what is on screen | 그중 담은 공고는, 공고문에서 조건을 뽑아 우리 회사 정보와 하나씩 맞춰 봅니다. 조건마다 충족, 미충족, 확인 필요를, 근거 문장과 함께 보여 줍니다. |
| G07 | 8.2 | 흐름 마무리 | clear and steady, light sense of completion | 투자 미팅 준비도 돕습니다. 운용사 요약과 예상 질문, 챙길 자료 목록까지 만듭니다. 모든 결과는 노트 한 장에 모입니다. |
| G08 | 6.2 | 담담하게 결과 보고 | confident and matter-of-fact | 이 모든 기능은, 자동 테스트 오백이십사 개와, 화면 점검 삼백칠십 건을 모두 통과했습니다. |

### 03 Liner API 활용 지점

| 번호 | 예상(초) | 의도 | 어조(style 가운데 부분) | 음성 대본 |
|---|---:|---|---|---|
| C03 | 4.3 | 장 전환 질문 | inviting transition, natural rising intonation on the question | 이 과정에서 라이너 에이피아이는, 어디에, 어떻게 쓰였을까요? |
| L01 | 6.6 | 질문에 답하며 세 역할 | clear and confident; three parallel phrases with equal weight | 역할을 셋으로 나눴습니다. `<short pause>` 검색은 라이너가, 판단은 에이아이 모델이, 확인은 코드가 맡습니다. |
| L02 | 9.9 | 기술 용어를 쉽게 | clear and explanatory, steady pace for technical terms | 검색과 판단에 쓰는 라이너 에이피아이는, 다섯 가지입니다. 검색 세 가지와, 에이아이 모델을 부르는 방식 두 가지를, 아홉 개 기능에 나눠 씁니다. |
| L03 | 10.2 | 쓰임새 첫째 | clear and explanatory, steady pace | 먼저 회사 분석에서는, 웹 검색으로 회사 소개와 매출 같은 사실, 특허 후보를 찾습니다. 투자 기록은 프리미엄 검색의 회사 정보 카드에서 가져옵니다. |
| L04 | 7.8 | 문제와 해법의 대비 | clear, slight emphasis on 얻을 수 없습니다 and 라이너로 | 경쟁사의 투자 기록과 특허는, 공공기관 자료로는 얻을 수 없습니다. `<short pause>` 그래서 경쟁사마다 라이너로 따로 찾습니다. |
| L05 | 10.6 | 단계 설명 | clear and explanatory, steady pace | 다만 라이너에는 특허 전용 검색이 없어서, 검색어에 특허 사이트를 넣어 후보를 찾습니다. 그다음 특허 문서를 열어, 특허를 낸 곳이 그 회사인 것만 셉니다. |
| L06 | 15.3 | 둘째 역할 | clear and steady, slightly brisk | 판단은 라이너로 부르는 에이아이 모델이 맡습니다. 같은 공고로 모델 네 개를 비교해, 조건 뽑기에는 지피티를, 회사 정보와 맞춰 보기에는 클로드를 골랐습니다. 라이너 자체 모델도 품질은 비슷했지만, `<short pause>` 답이 더 느렸습니다. |
| L07 | 10.9 | 셋째 역할, 끝을 단호하게 | clear, firm on the final phrase 없으면 버립니다 | 확인은 코드가 맡습니다. 모델은 직접 검색하지 않고, 코드가 찾은 자료만 받습니다. 모델이 근거로 든 문장은, 코드가 원래 문서에서 찾아보고, `<short pause>` 없으면 버립니다. |
| L08 | 12.7 | 숫자에 힘을 주어 | clear and confident, slight emphasis on 열아홉 번 | 비용도 아꼈습니다. 회사 한 곳을 분석할 때는, 꼭 필요한 요청만 넣어 라이너를 열아홉 번 불렀습니다. 비용이 큰 기능은 사용자가 원할 때만 씁니다. 요청 횟수에는, 세 겹의 한도도 둡니다. |

### 04 확장 계획

| 번호 | 예상(초) | 의도 | 어조(style 가운데 부분) | 음성 대본 |
|---|---:|---|---|---|
| C04 | 3.8 | 마지막 장 알림 | calm, clear transition into the next section | 마지막으로, 성장노트를 어떻게 넓혀 갈지 보겠습니다. |
| E01 | 10.2 | 결론 먼저, 이유 뒤에 | calm and forward-looking | 사용자가 늘어도, 비용이 그만큼 늘지는 않습니다. 분석 결과를 저장해, 여러 사람이 다시 보기 때문입니다. 공고문 조건도 공고마다 한 번만 뽑습니다. |
| E02 | 8.5 | 분야 확대 | calm and forward-looking | 같은 방식은 기술, 수출, 인력 지원사업으로도 넓힐 수 있습니다. 지원기관과 투자 담당자가, 미리 살펴볼 때도 쓸 수 있습니다. |
| E03 | 6.1 | 담담하게 | calm and matter-of-fact | 다음 과제는, 맞는 새 공고가 열리면 알려 주는 기능과, 로그인을 갖춘 서비스 공개입니다. |

### 마무리

| 번호 | 예상(초) | 의도 | 어조(style 가운데 부분) | 음성 대본 |
|---|---:|---|---|---|
| F01 | 6.9 | 전체 정리 | warm and confident, summarizing | 정리하면, 성장노트는 공고 목록에서 멈추지 않습니다. 우리 회사가 대상인지, 근거와 함께 답합니다. |
| F02 | 3.1 | 마지막 한마디, 천천히 | slower, warm and memorable closing line, emphasize 성장노트 | 점수 대신 출처로 말하는 회사 분석. `<short pause>` 성장노트. |

## 음성 만들기

```
# 1) 35줄 전체 생성 → 줄별 길이 판정표(report.csv)와 합계
python docs/submission/tts/synthesize.py lines --voice ko-kr-storyteller-4 --tag fast

# 2) 길게 나온 줄만 다른 꼬리표로 다시 생성 → 두 결과를 비교
python docs/submission/tts/synthesize.py lines --voice ko-kr-storyteller-4 --tag fast-retry --only L06

# 3) 판정표만 다시 보기
python docs/submission/tts/synthesize.py report --voice ko-kr-storyteller-4 --tag fast
```

- 새로 넣은 줄(T06, C01~C04, P02a, P02c)과 문구가 바뀐 줄을 모두 다시 만듭니다. 문구가 그대로인 줄은 T01 하나뿐입니다.
- 판정표의 '넘침'은 예상 길이보다 15% 넘게 길다는 뜻입니다. 장면은 음성 길이에 맞추므로 한 줄이 조금 넘는 것은 괜찮지만, **합계가 277초를 넘으면 영상이 5분을 넘습니다.**
- `--tag`는 결과 폴더를 `<음성>-<꼬리표>`로 나눠, 어조를 바꿔 다시 만들 때 이전 결과를 덮어쓰지 않게 합니다. 꼬리표는 영문·숫자·`_`·`-`만 받습니다.
- 길게 나온 줄은 2)처럼 꼬리표를 바꿔 다시 만들고, `<음성>-fast/report.csv`와 `<음성>-fast-retry/report.csv`를 비교하고 들어 본 뒤 고른 파일만 씁니다. 줄 안에 0.7초가 넘는 쉼이 생긴 줄도 다시 만듭니다.
