// 사례 체험(라이너 세 시점)용 고정 데이터.
// 기업 수치와 투자사 명단은 팀 기획 대화에서 가져온 값으로, 아직 원문 대조를 거치지 않았다(status "대조 전").
// "(가상)"으로 시작하는 상품·펀드·운용사는 화면 확인용으로 만든 가상 데이터다.

export type Lane = "debt" | "equity";
export type Verdict = "match" | "check" | "excluded";
export type FactStatus = "대조 전" | "미공개" | "시연 가정" | "가상";

export type Fact = { label: string; value: string; source: string; status: FactStatus };

export type Priority = { id: string; label: string; hint: string; first: Lane };

export type Candidate = {
  id: string;
  lane: Lane;
  kind: "은행대출" | "보증" | "정책융자" | "펀드" | "운용사" | "기존 투자사";
  name: string;
  provider: string;
  relation?: "existing" | "new";
  verdict: Verdict;
  rank: [number, number]; // 우선순위 0번, 1번에서의 레인 내 순서
  reasons: string[];
  checks: string[];
  excludedWhy?: string;
  questions: [string[], string[]]; // 우선순위별 첫 상담 질문
  documents: string[];
  contact: string;
  sample: boolean; // 가상 데이터 여부
};

export type Party = { name: string; role: "투자 주도" | "투자 참여" | "후속 투자" | "보증부 대출"; note: string };

export type Scenario = {
  id: "a" | "b" | "c";
  round: string;
  when: string;
  cardTitle: string;
  cardQuestion: string;
  founderQuestion: string;
  deliverable: string;
  deliverableDesc: string;
  company: Fact[];
  market: string[];
  assumption: { purpose: string; amount: string };
  priorities: [Priority, Priority];
  candidates: Candidate[];
  actual: { headline: string; parties: Party[]; undisclosed: string[]; cautions: string[] };
  quiz?: { question: string; options: string[]; answer: string };
};

const DEBT_DOCS = [
  "최근 3개년 재무제표(또는 결산 자료)",
  "자금 사용 계획서(용도별 금액)",
  "기술·사업 소개서",
  "상환 재원 설명 자료",
];
const EQUITY_DOCS = [
  "IR 자료(성장 지표 포함)",
  "핵심 지표 정의서(MAU·매출 산정 기준)",
  "자금 사용 계획과 다음 라운드 목표",
  "주주명부와 기존 투자 계약 요약",
];
const CONTACT_TBD = "공식 상담 경로: 원문 확인 후 연결";

export const scenarios: Scenario[] = [
  {
    id: "a",
    round: "시리즈 A",
    when: "2020년 8월",
    cardTitle: "해외 사용자가 늘기 시작했다",
    cardQuestion: "첫 기관투자 미팅에서 무엇을 증명해야 할까?",
    founderQuestion: "해외 사용자가 85%인데, 첫 기관투자 미팅에서 무엇을 증명해야 할까?",
    deliverable: "첫 투자 미팅 준비표",
    deliverableDesc: "근거가 있는 지표는 출처와 함께 제시하고, 유료 전환율·재방문율·매출 절대액은 창업자가 채울 항목으로 남깁니다.",
    company: [
      { label: "제품", value: "웹페이지·PDF에 밑줄과 메모를 남기는 하이라이팅 도구", source: "venturesquare.net 보도", status: "대조 전" },
      { label: "주요 사용자", value: "대학원생·전문직", source: "venturesquare.net 보도", status: "대조 전" },
      { label: "해외 사용자 비중", value: "85% 이상", source: "venturesquare.net 보도", status: "대조 전" },
      { label: "월 매출 성장", value: "2020년 상반기 4배 이상(회사 발표)", source: "venturesquare.net 보도", status: "대조 전" },
      { label: "매출 절대액", value: "공개자료에서 확인되지 않음", source: "—", status: "미공개" },
    ],
    market: [
      "같은 해 4월 Notion이 5,000만 달러를 유치하는 등 글로벌 생산성 소프트웨어에 투자가 이어졌습니다.",
      "투자자에게 설명할 고유 자산은 사용자가 웹에서 직접 중요하다고 표시한 하이라이트 데이터였습니다.",
    ],
    assumption: { purpose: "추천·검색 기능 개발과 해외 사용자 확대", amount: "50억 원 안팎" },
    priorities: [
      { id: "first-vc", label: "첫 기관투자 유치", hint: "성장 지표를 근거로 투자자를 먼저 만납니다", first: "equity" },
      { id: "dilution", label: "지분 희석 최소화", hint: "창업기업 보증·대출 경로를 먼저 봅니다", first: "debt" },
    ],
    candidates: [
      {
        id: "a-fund1", lane: "equity", kind: "펀드", name: "(가상) 초기기업 시리즈A 펀드", provider: "(가상) 운용사 A", relation: "new",
        verdict: "match", rank: [1, 1],
        reasons: ["공식 투자 단계: 초기·시리즈 A — 단계 일치", "소프트웨어·플랫폼 분야 출자 — 분야 일치"],
        checks: ["약정액은 펀드 전체 규모이며 기업당 투자금 범위는 미공개", "현재 신규 투자 집행 여부 확인"],
        questions: [
          ["해외 사용자 비중 85%를 어떤 지표와 함께 보여주면 성장성으로 인정되나요?", "유료 전환 전 단계 서비스에 투자할 때 주로 확인하는 지표는 무엇인가요?", "현재 신규 투자를 집행하는 펀드가 있나요?"],
          ["지분 희석을 줄이기 위해 투자금 일부를 보증·대출로 대체한 사례가 있나요?", "기업당 투자 금액 범위는 어느 정도인가요?"],
        ],
        documents: EQUITY_DOCS, contact: CONTACT_TBD, sample: true,
      },
      {
        id: "a-gp2", lane: "equity", kind: "운용사", name: "(가상) 글로벌 소프트웨어 투자 운용사 B", provider: "운용사 단위 정보", relation: "new",
        verdict: "check", rank: [2, 2],
        reasons: ["해외 사용자 중심 소프트웨어 기업 투자 사례 — 운용사 단위로 확인"],
        checks: ["사례가 어느 펀드에서 집행됐는지 확인되지 않아 펀드와 연결하지 않음"],
        questions: [
          ["해외 사용자 중심 서비스에 투자한 사례에서 어떤 지원을 하셨나요?", "투자 검토에 걸리는 기간과 절차는 어떻게 되나요?"],
          ["소액 투자와 후속 투자 약정을 나눠 진행한 사례가 있나요?"],
        ],
        documents: EQUITY_DOCS, contact: CONTACT_TBD, sample: true,
      },
      {
        id: "a-fund3", lane: "equity", kind: "펀드", name: "(가상) 소재·부품·장비 특화 펀드", provider: "(가상) 운용사 C", relation: "new",
        verdict: "excluded", rank: [3, 3], reasons: [], checks: [],
        excludedWhy: "공식 출자 분야가 소재·부품·장비 — 소프트웨어 서비스와 분야 불일치",
        questions: [[], []], documents: [], contact: CONTACT_TBD, sample: true,
      },
      {
        id: "a-kibo", lane: "debt", kind: "보증", name: "기술창업기업 특례보증", provider: "기술보증기금",
        verdict: "check", rank: [1, 1],
        reasons: ["창업기업 대상 보증 제도 — 업력 조건에 해당할 가능성", "기술 기반 서비스 — 기술평가 대상"],
        checks: ["보증 대상·보증료·한도는 기업별 심사 사항", "보증서 발급 후 대출을 실행할 은행 상담 필요"],
        questions: [
          ["투자 유치와 병행할 때 보증 심사에 영향을 주는 요소가 있나요?", "기술평가에 필요한 자료와 심사 기간은 어떻게 되나요?"],
          ["기능 개발비 중 어떤 항목이 보증 대상 자금 용도로 인정되나요?", "보증료율과 보증 비율은 어떻게 정해지나요?", "보증서 발급 후 어느 은행과 대출을 진행할 수 있나요?"],
        ],
        documents: DEBT_DOCS, contact: CONTACT_TBD, sample: false,
      },
      {
        id: "a-ibk", lane: "debt", kind: "은행대출", name: "IBK성공창업대출", provider: "IBK기업은행",
        verdict: "check", rank: [2, 2],
        reasons: ["창업기업 대상 상품 — 업력 조건에 해당할 가능성"],
        checks: ["대상 업력과 자금 용도는 상품 원문에서 확인", "금리 산정 방식과 한도는 상담에서 확인"],
        questions: [
          ["창업 몇 년 차까지 신청할 수 있나요?", "운영자금과 개발비 중 어떤 용도가 인정되나요?"],
          ["매출 규모가 작은 창업기업의 한도는 어떻게 산정되나요?", "보증서 없이 신청할 수 있는 경우가 있나요?"],
        ],
        documents: DEBT_DOCS, contact: CONTACT_TBD, sample: false,
      },
    ],
    actual: {
      headline: "50억 원 투자 유치",
      parties: [
        { name: "KB인베스트먼트", role: "투자 주도", note: "라운드 주도" },
        { name: "SL인베스트먼트", role: "투자 참여", note: "라운드 참여" },
        { name: "캡스톤파트너스", role: "투자 참여", note: "라운드 참여" },
      ],
      undisclosed: ["기관별 투자 금액", "투자에 사용된 개별 펀드명"],
      cautions: ["운용사 이름만 확인됐으므로 특정 펀드의 투자 실적으로 연결하지 않습니다."],
    },
  },
  {
    id: "b",
    round: "시리즈 B",
    when: "2022년 9월",
    cardTitle: "이용자가 급증했다",
    cardQuestion: "투자와 대출을 어떻게 조합할까?",
    founderQuestion: "추천 기술 개발과 운영비가 동시에 필요하다. 어떤 비용을 투자자와 논의하고, 어떤 비용을 보증·대출 상담에 가져갈까?",
    deliverable: "두 갈래 상담표",
    deliverableDesc: "투자 쪽에는 성장 지표와 수익모델 검증 계획을, 보증·대출 쪽에는 기술 설명·자금 용도·상환 재원 질문을 준비합니다.",
    company: [
      { label: "제품", value: "하이라이팅에서 개인화 추천·검색·커뮤니티로 확장", source: "liner.com 회사 연혁", status: "대조 전" },
      { label: "월간 활성 사용자", value: "1,000만 명(2022년 4월)", source: "liner.com 회사 연혁", status: "대조 전" },
      { label: "성장 속도", value: "1년간 MAU 33배 이상(라운드 당시 보도)", source: "edaily.co.kr 보도", status: "대조 전" },
      { label: "수익모델", value: "유료 큐레이션·광고를 검증하는 단계", source: "edaily.co.kr 보도", status: "대조 전" },
      { label: "기존 기관투자사", value: "KB인베스트먼트, SL인베스트먼트, 캡스톤파트너스(시리즈 A)", source: "venturesquare.net 보도", status: "대조 전" },
    ],
    market: [
      "같은 해 Brave Search가 출시 첫해 검색 25억 건을 발표했습니다. 검색 결과를 어떤 기준으로 골라 보여줄지가 차별점이던 시기입니다.",
      "당시 투자사는 글로벌 콘텐츠 큐레이션과 소규모 팀의 운영 효율을 평가 이유로 들었습니다.",
    ],
    assumption: { purpose: "추천 기술 개발비와 서비스 운영비", amount: "100억 원 안팎" },
    priorities: [
      { id: "dilution", label: "지분 희석 최소화", hint: "개발비는 보증·대출로 먼저 검토합니다", first: "debt" },
      { id: "growth", label: "성장을 도울 투자자 찾기", hint: "성장 지표를 근거로 투자자를 먼저 만납니다", first: "equity" },
    ],
    candidates: [
      {
        id: "b-kibo", lane: "debt", kind: "보증", name: "기술보증(기술평가 기반)", provider: "기술보증기금",
        verdict: "match", rank: [1, 1],
        reasons: ["자금 용도 일치: 추천 기술 개발비", "기술 기반 서비스 기업 — 기술평가 대상"],
        checks: ["보증 한도와 보증료는 기업별 심사 사항", "보증서 발급 후 대출을 실행할 협약 은행 확인"],
        questions: [
          ["추천 기술 개발비 중 어떤 항목이 보증 대상 자금 용도로 인정되나요?", "기술평가에 어떤 자료가 필요하고 심사 기간은 얼마나 걸리나요?", "보증서 발급 후 어느 은행과 대출을 진행할 수 있나요?"],
          ["투자 유치와 병행할 때 보증 심사에 영향을 주는 요소가 있나요?", "투자 유치 직후 재무구조가 바뀌면 보증 한도를 다시 산정하나요?"],
        ],
        documents: DEBT_DOCS, contact: CONTACT_TBD, sample: false,
      },
      {
        id: "b-ibk-tech", lane: "debt", kind: "은행대출", name: "기술평가기반무보증신용대출", provider: "IBK기업은행",
        verdict: "check", rank: [2, 2],
        reasons: ["운영자금 용도로 검토 가능", "기술평가 기반 — 담보·보증 없이 검토하는 상품군"],
        checks: ["금리 산정 방식과 한도는 상담에서 확인", "매출이 작은 성장 단계 기업의 상환 재원 설명 방법"],
        questions: [
          ["서비스 운영비 중 어떤 지출이 운전자금으로 인정되나요?", "기술평가 등급에 따라 한도와 금리가 어떻게 달라지나요?", "상환 재원으로 투자 유치 계획을 설명해도 되나요?"],
          ["투자 유치가 확정되면 대출 조건이 달라지나요?"],
        ],
        documents: DEBT_DOCS, contact: CONTACT_TBD, sample: false,
      },
      {
        id: "b-kosme", lane: "debt", kind: "정책융자", name: "(가상) 혁신성장 분야 정책자금 융자", provider: "중소벤처기업진흥공단",
        verdict: "check", rank: [3, 3],
        reasons: ["정책 목적: 혁신성장 분야 — 분야 일치 가능"],
        checks: ["접수 상태(마감 여부) 확인", "업력·업종 요건은 최신 변경공고 기준으로 대조"],
        questions: [
          ["현재 접수 중인 자금과 다음 접수 일정은 어떻게 되나요?", "소프트웨어 서비스 기업이 신청할 수 있는 세부 자금은 무엇인가요?"],
          ["투자 유치 기업에 대한 우대나 제한이 있나요?"],
        ],
        documents: DEBT_DOCS, contact: CONTACT_TBD, sample: true,
      },
      {
        id: "b-ibk-startup", lane: "debt", kind: "은행대출", name: "IBK성공창업대출", provider: "IBK기업은행",
        verdict: "excluded", rank: [4, 4], reasons: [], checks: [],
        excludedWhy: "창업 초기 기업 대상 상품 — 업력 조건 불일치(예시 판정, 원문 대조 전)",
        questions: [[], []], documents: [], contact: CONTACT_TBD, sample: false,
      },
      {
        id: "b-existing", lane: "equity", kind: "기존 투자사", name: "KB인베스트먼트 · SL인베스트먼트 · 캡스톤파트너스", provider: "시리즈 A 참여(2020)", relation: "existing",
        verdict: "match", rank: [1, 1],
        reasons: ["이미 주주 — 후속 투자와 신규 투자자 소개를 먼저 요청할 대상", "신규 후보로 추천하지 않고 따로 구분"],
        checks: ["후속 투자 여력(펀드 잔여 재원)은 비공개 — 직접 확인"],
        questions: [
          ["이번 라운드에서 후속 투자가 가능한가요, 가능하다면 어느 규모인가요?", "보증·대출을 병행하는 계획에 대한 의견은 어떤가요?"],
          ["후속 투자 의향과 함께 소개해 줄 수 있는 성장 단계 투자자가 있나요?", "수익모델 검증 계획에서 보완할 점은 무엇인가요?"],
        ],
        documents: EQUITY_DOCS, contact: "기존 주주 담당 심사역", sample: false,
      },
      {
        id: "b-fund1", lane: "equity", kind: "펀드", name: "(가상) 콘텐츠·플랫폼 스케일업 펀드", provider: "(가상) 운용사 A", relation: "new",
        verdict: "match", rank: [2, 2],
        reasons: ["공식 투자 분야: 콘텐츠·플랫폼 — 분야 일치", "성장 단계(시리즈 B) 투자 사례 공개"],
        checks: ["약정액은 펀드 전체 규모 — 기업당 투자금 범위 미공개", "현재 신규 투자 집행 여부 확인"],
        questions: [
          ["기업당 투자 금액 범위와 지분율 기준은 어떻게 되나요?", "투자금 일부를 대출로 대체하는 구조에 대한 의견은 어떤가요?"],
          ["현재 신규 투자를 집행하는 펀드가 있나요?", "MAU 성장 외에 어떤 수익 지표를 확인하시나요?", "글로벌 사용자 기반 서비스를 지원한 사례가 있나요?"],
        ],
        documents: EQUITY_DOCS, contact: CONTACT_TBD, sample: true,
      },
      {
        id: "b-gp2", lane: "equity", kind: "운용사", name: "(가상) 운용사 B", provider: "운용사 단위 정보", relation: "new",
        verdict: "check", rank: [3, 3],
        reasons: ["유사 기업(글로벌 소비자 소프트웨어) 투자 사례 — 운용사 단위로만 확인"],
        checks: ["사례가 어느 펀드에서 집행됐는지 확인되지 않아 펀드와 연결하지 않음"],
        questions: [
          ["해당 투자 사례는 어느 펀드에서 집행됐고, 그 펀드는 지금도 투자 중인가요?"],
          ["유사 기업에 투자한 뒤 어떤 지원을 하셨나요?", "투자 검토 절차와 기간은 어떻게 되나요?"],
        ],
        documents: EQUITY_DOCS, contact: CONTACT_TBD, sample: true,
      },
      {
        id: "b-fund3", lane: "equity", kind: "펀드", name: "(가상) 지역혁신 벤처펀드", provider: "(가상) 운용사 C", relation: "new",
        verdict: "excluded", rank: [4, 4], reasons: [], checks: [],
        excludedWhy: "지역 제한(특정 권역 소재 기업 대상) — 본사 소재지 불일치",
        questions: [[], []], documents: [], contact: CONTACT_TBD, sample: true,
      },
    ],
    actual: {
      headline: "총 110억 원 조달",
      parties: [
        { name: "CJ인베스트먼트", role: "투자 주도", note: "VC 투자를 주도" },
        { name: "IBK기업은행", role: "투자 참여", note: "신규 투자사로 참여 — 대출 거래가 아님" },
        { name: "기술보증기금", role: "보증부 대출", note: "기술보증기금을 통한 대출이 조달액에 포함" },
      ],
      undisclosed: ["투자금과 대출금 각각의 금액", "대출을 실행한 은행"],
      cautions: [
        "은행 이름이 나왔다고 대출로 분류하지 않습니다. IBK기업은행은 이 라운드에서 투자사였습니다.",
        "조달 총액 110억 원을 전부 투자금으로 집계하지 않습니다.",
      ],
    },
    quiz: {
      question: "라이너가 조달한 110억 원은 전부 투자금이었을까요?",
      options: ["전부 투자금이다", "투자와 대출이 섞여 있다", "전부 대출이다"],
      answer: "투자와 대출이 섞여 있다",
    },
  },
  {
    id: "c",
    round: "시리즈 C",
    when: "2026년 8월",
    cardTitle: "해외 기업 고객을 확보했다",
    cardQuestion: "기존 투자사와 신규 투자사에 각각 무엇을 요청할까?",
    founderQuestion: "다음 해외 고객을 확보하려면 기존 투자사와 신규 투자사 중 누구에게 어떤 도움을 요청할까?",
    deliverable: "투자자 접촉 계획",
    deliverableDesc: "기존 투자사에는 후속 투자와 소개 요청을, 신규 후보에는 해외 B2B 지원 사례와 투자 규모 확인 질문을 준비합니다.",
    company: [
      { label: "제품", value: "개인용 AI 검색과 기업용 검색엔진 공급", source: "liner.com 발표", status: "대조 전" },
      { label: "사용자", value: "220여 개국 1,400만 명(회사 발표, 누적 기준)", source: "liner.com 발표", status: "대조 전" },
      { label: "해외 기업 고객", value: "사우디 AI 플랫폼 '휴메인 원'에 검색엔진 공급", source: "liner.com 발표", status: "대조 전" },
      { label: "직전 라운드", value: "2024년 시리즈 B2 270억 원", source: "liner.com 발표", status: "대조 전" },
      { label: "이번 검토", value: "해외 B2B 사업 확대 운영자금 10억 원", source: "사용자 입력", status: "시연 가정" },
    ],
    market: [
      "OpenAI·구글·퍼플렉시티가 경쟁하는 AI 검색 시장에서 라이너가 내세운 근거는 검색 정확성과 기업 고객 공급 실적이었습니다.",
      "B의 1,000만은 월간 활성 사용자, C의 1,400만은 회사가 발표한 사용자 수라 하나의 성장 그래프로 잇지 않습니다.",
    ],
    assumption: { purpose: "해외 B2B 사업 확대 운영자금", amount: "10억 원" },
    priorities: [
      { id: "dilution", label: "지분 희석 최소화", hint: "운영자금 대출·보증 경로를 먼저 봅니다", first: "debt" },
      { id: "global", label: "해외 진출을 도울 투자자 찾기", hint: "기존·신규 투자사를 구분해 접촉합니다", first: "equity" },
    ],
    candidates: [
      {
        id: "c-bank", lane: "debt", kind: "은행대출", name: "(가상) 해외사업 운전자금 대출", provider: "시중은행·국책은행",
        verdict: "check", rank: [1, 1],
        reasons: ["자금 용도 일치: 해외 사업 확대 운영자금"],
        checks: ["기업별 한도와 보증 필요 여부는 상담 확인 항목", "KDB산업은행 등 투자 참여 기관을 대출 거래처로 가정하지 않음"],
        questions: [
          ["해외 사업 확대 비용 중 어떤 지출이 운전자금으로 인정되며, 한도 검토에 어떤 자료가 필요한가요?", "해외 매출 계약을 상환 재원으로 설명할 수 있나요?"],
          ["투자 유치 일정과 겹칠 때 대출 실행 시점을 조정할 수 있나요?"],
        ],
        documents: DEBT_DOCS, contact: CONTACT_TBD, sample: true,
      },
      {
        id: "c-guarantee", lane: "debt", kind: "보증", name: "(가상) 해외진출 기업 보증", provider: "보증기관",
        verdict: "check", rank: [2, 2],
        reasons: ["해외 매출이 있는 기술기업 대상 보증 — 대상 가능"],
        checks: ["업력 제한이 있는 창업기업 전용 제도인지 확인", "보증료와 보증 비율"],
        questions: [
          ["해외 기업 고객 공급 계약이 보증 심사에서 어떻게 평가되나요?", "보증 한도 산정에 해외 매출이 반영되나요?"],
          ["투자 유치 기업도 같은 조건으로 신청할 수 있나요?"],
        ],
        documents: DEBT_DOCS, contact: CONTACT_TBD, sample: true,
      },
      {
        id: "c-existing", lane: "equity", kind: "기존 투자사", name: "CJ인베스트먼트 · 에이티넘인베스트먼트 등", provider: "이전 라운드 참여", relation: "existing",
        verdict: "match", rank: [1, 1],
        reasons: ["이미 주주 — 후속 투자와 해외 네트워크 소개를 먼저 요청", "신규 후보 목록에서 제외해 중복 추천을 막음"],
        checks: ["후속 투자 여력은 비공개 — 직접 확인"],
        questions: [
          ["운영자금 10억 원을 대출로 조달하는 계획에 대한 의견은 어떤가요?"],
          ["후속 투자가 가능한가요, 해외 B2B 판로를 소개해 줄 포트폴리오사나 파트너가 있나요?", "이번 라운드에 함께할 신규 투자자를 소개해 주실 수 있나요?"],
        ],
        documents: EQUITY_DOCS, contact: "기존 주주 담당 심사역", sample: false,
      },
      {
        id: "c-fund1", lane: "equity", kind: "펀드", name: "(가상) 글로벌 진출 스케일업 펀드", provider: "(가상) 운용사 A", relation: "new",
        verdict: "match", rank: [2, 2],
        reasons: ["공식 투자 분야: AI·소프트웨어 해외 진출 — 분야 일치", "성장 단계 투자 — 단계 일치"],
        checks: ["약정액은 펀드 전체 규모 — 기업당 투자금 범위 미공개", "현재 신규 투자를 집행하는지 확인"],
        questions: [
          ["소규모 브리지 투자도 검토하시나요?"],
          ["현재 신규 투자를 집행하는 펀드가 있나요?", "해외 B2B 판로를 지원한 사례가 있나요?", "기업당 투자 규모는 어느 정도인가요?"],
        ],
        documents: EQUITY_DOCS, contact: CONTACT_TBD, sample: true,
      },
      {
        id: "c-ibk", lane: "equity", kind: "운용사", name: "IBK기업은행", provider: "시리즈 B 투자 참여 기관", relation: "existing",
        verdict: "excluded", rank: [3, 3], reasons: [], checks: [],
        excludedWhy: "신규 후보에서 제외 — 시리즈 B에 투자사로 참여한 기존 관계 기관",
        questions: [[], []], documents: [], contact: CONTACT_TBD, sample: false,
      },
    ],
    actual: {
      headline: "500억 원 투자 유치 · 누적 약 940억 원",
      parties: [
        { name: "LB인베스트먼트", role: "투자 주도", note: "라운드 주도" },
        { name: "에이티넘인베스트먼트", role: "후속 투자", note: "기존 투자사의 후속 투자" },
        { name: "CJ인베스트먼트", role: "후속 투자", note: "기존 투자사의 후속 투자" },
        { name: "KDB산업은행", role: "투자 참여", note: "신규 투자사로 참여 — 대출 거래가 아님" },
        { name: "스틱벤처스", role: "투자 참여", note: "신규 투자사로 참여" },
      ],
      undisclosed: ["기관별 투자 금액", "투자에 사용된 개별 펀드명"],
      cautions: [
        "KDB산업은행은 투자 참여 이력으로 분류합니다. 대출 거래 이력을 붙이면 오류입니다.",
        "운용사가 확인돼도 개별 펀드명이 확인될 때만 펀드와 연결합니다.",
      ],
    },
  },
];

export const getScenario = (id: string) => scenarios.find((s) => s.id === id);

export type ResearchStep = { title: string; tool: string; engine: "search" | "model" | "fetch" | "public" | "rule"; output: string; usedFor: string };

// 조사 과정 설계(2단계에서 실제 호출 기록으로 대체)
export const researchSteps: ResearchStep[] = [
  { title: "기업 공개자료 찾기", tool: "Liner Search API", engine: "search", output: "공식 발표·보도 후보 목록(제목, 발췌, URL, 발행일)", usedFor: "회사 상태와 과거 조달 이력의 출처 확보" },
  { title: "원문 확인", tool: "자체 원문 수집기", engine: "fetch", output: "원문 본문과 근거 문장, 확인 일시", usedFor: "값이 원문에 실제로 있는 경우에만 '확인됨' 부여" },
  { title: "기관별 역할 분류", tool: "Liner Gateway → Claude", engine: "model", output: "기관 · 역할(투자 주도/참여/대출/보증) · 근거 문장", usedFor: "투자 참여와 대출 거래를 구분" },
  { title: "대출·보증·정책자금 후보", tool: "기업마당 API + Liner Search", engine: "public", output: "공고명, 소관기관, 신청기간, 지원대상, 원문 URL", usedFor: "용도·업력·접수 상태 대조" },
  { title: "펀드·운용사 후보", tool: "한국벤처투자 API + Liner Search", engine: "public", output: "조합명, 운용사, 출자 분야, 약정액, 만기", usedFor: "분야·단계 대조, 운용사와 펀드 구분" },
  { title: "조건 대조", tool: "규칙 엔진(점수 없음)", engine: "rule", output: "맞는 이유 · 추가 확인할 점 · 제외 사유", usedFor: "후보 순서와 제외 판단" },
  { title: "상담 질문·메모 작성", tool: "Liner Gateway → Claude", engine: "model", output: "후보별 첫 상담 질문, 준비자료, 출처", usedFor: "최종 결과물" },
];
