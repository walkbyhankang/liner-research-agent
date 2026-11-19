"""분야별 검색 계획: 기본식별 → 주제별 세분 검색 → 경쟁사 후속 검색. 호출 한도(budget) 안에서만 계획한다."""
from __future__ import annotations

import re

import config

CATEGORIES = ("profile", "finance", "competitors", "news", "vc", "support")
CATEGORY_LABELS = {"profile": "기업 기본정보", "finance": "재무·고용", "competitors": "경쟁사",
                   "news": "뉴스·사업활동", "vc": "VC·투자", "support": "정부지원·사업기회"}

# (key, category, 우선순위 그룹, date_range) — 한국어/영어 문구는 아래 템플릿
# 그룹 "core": 기본 한도에서도 수행. "ext": 확장 한도에서만 수행.
# 기업명이 본문에 없어도 관련 있는 시장 공통 주제(지원사업·조달·신규 VC 탐색)
MARKET_TOPICS = {"vc_new", "support_open", "procurement", "fund_formation", "support_export"}

_TOPICS_KO = [
    ("identity", "profile", "core", None, "{c} 회사 개요 정식 법인명 설립일 창업자 대표이사 본사 연혁 공식 홈페이지"),
    ("products_tech", "profile", "core", None, "{c} 주요 제품 서비스 핵심 기술 특허 사업지역"),
    ("finance", "finance", "core", None, "{c} 매출액 영업이익 순이익 최근 3개년 연결 별도 재무제표 감사보고서"),
    ("headcount_funding", "finance", "core", None, "{c} 직원수 변화 누적 투자유치 금액 투자 라운드 자금조달"),
    ("competitors", "competitors", "core", None, "{c} 직접 경쟁사 유사 서비스 기업 동일 시장 해외 경쟁사"),
    ("news_business", "news", "core", "past_year", "{c} 신제품 출시 투자유치 설비투자 해외 진출 사업전략"),
    ("news_contracts", "news", "core", "past_year", "{c} 공급계약 MOU 사업제휴 기술개발 상용화 정부 연구개발 과제"),
    ("vc_existing", "vc", "core", None, "{c} 기존 투자자 투자사 시리즈 투자 라운드 참여 VC"),
    ("vc_new", "vc", "core", None, "{ind} 스타트업 투자 VC 신규 펀드 조성 투자 포트폴리오 {tech}"),
    ("support_open", "support", "core", "past_year",
     "{ind} 중소기업 스타트업 정부지원사업 모집중 공고 신청 접수 R&D 기술사업화 {year}"),
    ("procurement", "support", "ext", "past_year", "{ind} 공공입찰 조달 발주계획 실증사업 PoC 공모 {year}"),
    ("news_interview", "news", "ext", "past_year", "{c} 대표 인터뷰 임직원 인터뷰 사업전략"),
    ("fund_formation", "vc", "ext", "past_year", "{ind} {tech} 분야 신규 펀드 결성 투자목적 벤처캐피탈 {year}"),
    ("competitor_vc", "vc", "ext", None, "{c} 경쟁사 투자 이력 투자자 {rivals}"),
    ("finance_basis", "finance", "ext", None, "{c} 연결 별도 기준 매출 영업이익 전년 대비 공시 사업보고서"),
    ("support_export", "support", "ext", "past_year", "{ind} 수출 판로개척 해외진출 정책금융 보증 인건비 고용지원 {year}"),
]
_TOPICS_EN = [
    ("identity", "profile", "core", None, "{c} company overview legal name founded founders CEO headquarters history website"),
    ("products_tech", "profile", "core", None, "{c} products services core technology patents markets"),
    ("finance", "finance", "core", None, "{c} revenue operating income net income last three years annual report financials"),
    ("headcount_funding", "finance", "core", None, "{c} employee count headcount total funding raised funding rounds"),
    ("competitors", "competitors", "core", None, "{c} direct competitors similar companies same market global competitors"),
    ("news_business", "news", "core", "past_year", "{c} product launch funding capex expansion overseas strategy"),
    ("news_contracts", "news", "core", "past_year", "{c} supply contract partnership MOU commercialization government R&D grant"),
    ("vc_existing", "vc", "core", None, "{c} existing investors funding rounds led by venture capital"),
    ("vc_new", "vc", "core", None, "{ind} startup investors venture capital new fund portfolio {tech}"),
    ("support_open", "support", "core", "past_year", "{ind} startup grants open call SBIR R&D funding application deadline {year}"),
    ("procurement", "support", "ext", "past_year", "{ind} public procurement tender pilot program open call {year}"),
    ("news_interview", "news", "ext", "past_year", "{c} CEO interview strategy"),
    ("fund_formation", "vc", "ext", "past_year", "{ind} {tech} new fund closes venture capital thesis {year}"),
    ("competitor_vc", "vc", "ext", None, "{c} competitors investors funding history {rivals}"),
    ("finance_basis", "finance", "ext", None, "{c} consolidated standalone revenue operating profit filing"),
    ("support_export", "support", "ext", "past_year", "{ind} export support policy finance guarantee hiring subsidy {year}"),
]


def _ctx(company: str, identity: dict | None, rivals: list[str] | None, year: int | None) -> dict:
    identity = identity or {}
    return {"c": company, "ind": (identity.get("industry") or "").strip(), "tech": (identity.get("tech") or "").strip(),
            "year": str(year or ""), "rivals": " ".join(rivals or [])}


def _fill(tpl: str, ctx: dict, company: str) -> str:
    if not ctx["ind"]:  # 업종을 모르면 회사명으로 대체
        tpl = tpl.replace("{ind}", "{c}")
    return re.sub(r"\s+", " ", tpl.format(**ctx)).strip()


def build_search_plan(company: str, country: str, *, budget: int | None = None, identity: dict | None = None,
                      competitors: list[str] | None = None, year: int | None = None,
                      date_ranges: bool = True) -> list[dict]:
    """budget 이내의 검색 계획. core 주제 → (경쟁사 후속) → ext 주제 순. 반환 항목 priority 순."""
    budget = config.MAX_SEARCH_CALLS if budget is None else budget
    c = config.COUNTRIES.get(country, config.COUNTRIES["기타(영어 검색)"])
    topics = _TOPICS_KO if c["lang"] == "ko" else _TOPICS_EN
    ctx = _ctx(company, identity, competitors, year)
    plan: list[dict] = []
    for key, cat, grp, dr, tpl in topics:
        if key == "competitor_vc" and not competitors:
            continue
        plan.append({"key": key, "category": cat, "group": grp, "topic": key,
                     "query": _fill(tpl, ctx, company), "country_code": c["code"], "lang": c["lang"],
                     "date_range": dr if date_ranges else None, "kind": "topic",
                     "market": key in MARKET_TOPICS})
    core = [p for p in plan if p["group"] == "core"]
    ext = [p for p in plan if p["group"] == "ext"]
    follow = build_followups(company, country, competitors or [])
    ordered = core + follow[:1] + ext[:2] + follow[1:3] + ext[2:] + follow[3:]
    return ordered[:max(budget, 0)]


def build_followups(company: str, country: str, competitors: list[str]) -> list[dict]:
    c = config.COUNTRIES.get(country, config.COUNTRIES["기타(영어 검색)"])
    ko = c["lang"] == "ko"
    out = []
    for name in competitors:
        q = (f"{name} 매출 직원수 투자유치 현황" if ko else f"{name} revenue employees funding")
        out.append({"key": f"competitor:{name}", "category": "competitors", "group": "followup", "topic": "competitor_followup",
                    "query": q, "country_code": c["code"], "lang": c["lang"], "date_range": None,
                    "kind": "followup", "competitor": name})
    return out


# ---------- 경쟁사 이름 추출 (모델 호출 없이) ----------
_STOP = {"네이버", "구글", "카카오"}  # 대기업도 경쟁사일 수 있으므로 제외하지 않음 — 빈 집합 취급 (아래 필터는 일반명사만)
_NOISE = re.compile(r"^(경쟁|유사|기업|서비스|플랫폼|시장|국내|해외|주요|대표|업체|회사|비교|분석|등|및|또는|확인 불가)$")


def extract_competitor_names(texts: list[str], company: str, hints: list[str] | None = None, limit: int = 5) -> list[str]:
    """경쟁사 후보 이름을 Agent 답변의 '경쟁사' 구간(굵은 글씨/번호 목록)과 검색 제목에서 추출한다. 사용자 힌트 우선."""
    names: list[str] = [h.strip() for h in (hints or []) if h and h.strip()]
    comp_l = re.sub(r"\s", "", company.lower())
    for t in texts:
        if not t:
            continue
        for sec in re.split(r"\n(?=#{1,4}\s)", t):
            head = sec.splitlines()[0] if sec.strip() else ""
            if not re.search(r"경쟁|competitor|alternative", head, re.I):
                continue
            for m in re.finditer(r"\*\*([^*\n]{2,30})\*\*", sec):
                names.append(m.group(1).strip(" :"))
            for m in re.finditer(r"^\|\s*([A-Za-z0-9가-힣][^|\n]{1,28}?)\s*\|", sec, re.M):
                cell = m.group(1).strip()
                if not re.fullmatch(r"[-: ]+", cell) and cell not in ("경쟁사", "항목", "기업", "기업명", "회사", "구분", "이름"):
                    names.append(cell.replace("**", ""))
            for m in re.finditer(r"^\s*(?:\d+[.)]|[-•])\s*([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .&\-]{1,25}?)\s*(?:[:：(]|$)", sec, re.M):
                names.append(m.group(1).strip())
    out, seen = [], set()
    for n in names:
        k = re.sub(r"\s", "", n.lower())
        if not k or k in seen or comp_l in k or k in comp_l or _NOISE.match(n.strip()) or len(n) > 30:
            continue
        seen.add(k)
        out.append(n)
    return out[:limit]


def estimate_unsearched(plan_all: list[dict], executed_keys: set[str]) -> list[dict]:
    """한도 초과로 수행하지 못한 항목."""
    return [p for p in plan_all if p["key"] not in executed_keys]
