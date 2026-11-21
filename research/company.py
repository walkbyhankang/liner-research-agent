"""① 기업 식별·사업내용·핵심 기술·경쟁사 분석.

식별번호·설립일·대표자는 금융위 기업기본정보 API 값을 쓰고(국내 법인일 때), 사업·제품·기술·경쟁사·검색 키워드는
Liner 웹 검색 결과를 모델 1회로 정리한다. 모델에는 검색 결과의 제목·발췌만 넘기고 자료에 없는 값은 비우게 한다.
"""
from __future__ import annotations

from research import public_data
from research.liner import DATA_RULE, Liner, numbered

FUND_FIELDS = ["early", "ai", "bio", "content", "mfg", "green", "local", "ip", "impact", "scale"]  # web/lib/finder.ts fundFields id

SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["name_ko", "name_en", "aliases", "is_korean", "founders", "industry", "business", "products", "core_tech",
                 "status_notes", "stage", "fund_field", "competitors", "tech_keywords", "gov_keywords", "bid_keywords"],
    "properties": {
        "name_ko": {"type": "string", "description": "정확한 한글 기업명(자료 표기). 해외 기업이면 통용 한글 표기 또는 빈 문자열"},
        "name_en": {"type": "string", "description": "영문 기업명. 자료에 없으면 빈 문자열"},
        "aliases": {"type": "array", "items": {"type": "string"}, "description": "자료에 나온 다른 표기·브랜드명. 최대 4개"},
        "is_korean": {"type": "boolean", "description": "한국 법인 여부"},
        "founders": {"type": "string", "description": "대표자·창업자(자료 표기). 없으면 빈 문자열"},
        "industry": {"type": "string"},
        "business": {"type": "string", "description": "주요 사업내용 3~5문장"},
        "products": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["name", "desc"],
                                                 "properties": {"name": {"type": "string"}, "desc": {"type": "string"}}}},
        "core_tech": {"type": "array", "items": {"type": "string"}, "description": "핵심 기술 3~8개"},
        "status_notes": {"type": "array", "items": {"type": "string"}, "description": "기타 중요한 기업 현황(투자·상장·합병·고객 등) 최대 8개, 자료 근거만"},
        "stage": {"type": "string", "enum": ["예비·초기", "성장", "후기·상장 준비", "상장사·대기업", "판단 불가"]},
        "fund_field": {"type": "string", "enum": FUND_FIELDS,
                       "description": "모태펀드 출자분야 중 가장 가까운 것: early 창업초기, ai AI·딥테크·SW, bio 바이오, content 콘텐츠, mfg 소부장, green 환경에너지, local 지방, ip 특허·기술사업화, impact 소셜임팩트, scale 스케일업·해외"},
        "competitors": {"type": "array", "description": "대표 경쟁사 5개. 직접 경쟁제품·대체기술·유사 사업모델 포함, 국내외 모두",
                        "items": {"type": "object", "additionalProperties": False,
                                  "required": ["name", "name_en", "registered_name_ko", "country", "is_korean", "relation", "reason"],
                                  "properties": {"name": {"type": "string"}, "name_en": {"type": "string"},
                                                 "registered_name_ko": {"type": "string", "description": "한국 법인이면 등기상 한글 상호(예: 퓨리오사에이아이). 모르면 빈 문자열"},
                                                 "country": {"type": "string"}, "is_korean": {"type": "boolean"},
                                                 "relation": {"type": "string", "enum": ["직접 경쟁", "대체 기술", "유사 사업모델", "해외 경쟁사"]},
                                                 "reason": {"type": "string", "description": "경쟁 관계 한 문장"}}}},
        "tech_keywords": {"type": "array", "description": "논문·정부사업 검색용 주요 기술 분야 5~10개",
                          "items": {"type": "object", "additionalProperties": False, "required": ["ko", "en"],
                                    "properties": {"ko": {"type": "string", "description": "한국어 기술 분야명"},
                                                   "en": {"type": "string", "description": "논문 검색용 영어 검색어(3~6단어)"}}}},
        "gov_keywords": {"type": "array", "items": {"type": "string"},
                         "description": "정부지원사업 검색어 10~15개. 직접 사업뿐 아니라 인접 기술, 관련 인프라, 수요 시장 포함. 2~6자 한국어 짧은 낱말"},
        "bid_keywords": {"type": "array", "items": {"type": "string"},
                         "description": "나라장터 공고명 부분일치 검색어 4~6개. 공고명에 실제로 쓰일 짧은 낱말(예: NPU, 반도체, AI 서버)"},
    },
}

QUERIES = ["{n} 기업 개요 설립 대표 주요 사업", "{n} 제품 서비스 핵심 기술", "{n} 경쟁사 경쟁 업체 비교"]


def analyze(name: str, liner: Liner, progress=None) -> dict:
    say = progress or (lambda m: None)
    out: dict = {"input": name, "corp": None, "corp_candidates": [], "profile": {}, "sources": [], "errors": []}
    say("기업 식별 중(금융위 기업기본정보)...")
    try:
        cands = public_data.find_corps(name)
        out["corp_candidates"] = cands[:8]
        out["corp"] = next((c for c in cands if c["exact"]), None)
    except public_data.PublicDataError as e:
        out["errors"].append(f"금융위 기업기본정보: {e}")
    say("사업내용·핵심 기술·경쟁사 검색 중(Liner Web Search)...")
    results = []
    for q in QUERIES:
        results += liner.search(q.format(n=name), max_results=10, label="profile_search")
    seen, uniq = set(), []
    for r in results:
        u = r.get("url")
        if u and u not in seen:
            seen.add(u)
            uniq.append(r)
    out["sources"] = [{"title": r.get("title"), "url": r.get("url"), "date": r.get("date")} for r in uniq]
    corp = out["corp"]
    corp_txt = (f"금융위 기업기본정보: 상호 {corp['name']}, 영문 {corp['name_en']}, 대표 {corp['ceo']}, 설립 {corp['founded']}, "
                f"주소 {corp['address']}, 주요사업 {corp['main_biz'] or '-'}, 업종 {corp['industry'] or '-'}") if corp else "금융위 기업기본정보: 일치 법인 없음"
    say("기업 프로필·경쟁사 5개·기술 키워드 도출 중(Liner Model)...")
    system = (f"당신은 기업 분석가입니다. {DATA_RULE}\n"
              "검색 자료와 공공 API 값을 바탕으로 기업 프로필을 만듭니다. 사실(설립·대표·제품·현황)은 자료에 있는 것만 쓰고 없으면 비웁니다. "
              "경쟁사·기술 키워드·검색어는 자료와 업계 지식을 바탕으로 폭넓게 제시해도 됩니다. 투자 가능성이나 점수는 쓰지 않습니다.")
    user = f"대상 기업: {name}\n{corp_txt}\n\n<자료>\n{numbered(uniq[:30], 280)}\n</자료>"
    prof = liner.json(system, user, SCHEMA, name="company_profile", max_tokens=5000)
    if prof is None:
        out["errors"].append("기업 프로필 모델 분석 실패 — 검색 결과 목록만 표시합니다.")
        prof = {}
    out["profile"] = prof
    comps = (prof.get("competitors") or [])[:5]
    say(f"경쟁사 {len(comps)}개 선정 완료")
    return out
