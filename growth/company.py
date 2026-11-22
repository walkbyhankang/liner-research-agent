"""회사 프로필: 사업내용·제품·핵심 기술·국내 경쟁사·검색 낱말(research/company.py 에서 옮김).

Liner 웹 검색 3회 결과를 모델 1회로 정리한다. 모델에는 검색 결과의 제목·발췌만 넘기고 자료에 없는 값은 비우게 한다.
옮기며 바꾼 것: 법인 식별(find_corps)은 identity 단락이 하므로 여기서는 하지 않고 받은 법인만 쓴다.
검색 결과가 0건이면 모델을 부르지 않는다(계약 8.3절: unavailable no_data).
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor

from growth import common
from growth.liner import DATA_RULE, Liner, numbered

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
        "competitors": {"type": "array", "description": "국내(한국 본사) 경쟁사 최대 5개. 직접 경쟁제품·유사 기술·유사 사업모델 기준, 상장·비상장 모두. "
                                                       "외국 기업과 외국 기업의 한국 지사·법인은 넣지 않는다. 적합한 국내 기업이 5개 미만이면 그만큼만",
                        "items": {"type": "object", "additionalProperties": False,
                                  "required": ["name", "name_en", "registered_name_ko", "country", "is_korean", "relation", "reason"],
                                  "properties": {"name": {"type": "string"}, "name_en": {"type": "string"},
                                                 "registered_name_ko": {"type": "string", "description": "한국 법인이면 등기상 한글 상호(예: 퓨리오사에이아이). 모르면 빈 문자열"},
                                                 "country": {"type": "string"}, "is_korean": {"type": "boolean"},
                                                 "relation": {"type": "string", "enum": ["직접 경쟁", "대체 기술", "유사 사업모델"]},
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


def analyze(name: str, liner: Liner, corp: dict | None = None, progress=None) -> dict:
    """{'profile': 모델 답(없으면 {}), 'sources': [...], 'errors': [...], 'excluded_competitors': [...], 'model_failed': bool}"""
    say = progress or (lambda m: None)
    out: dict = {"input": name, "profile": {}, "sources": [], "errors": [], "excluded_competitors": [], "model_failed": False}
    say("회사 자료 검색")
    # 검색 3회는 서로 독립이라 동시에 부른다. 결과는 원래 질의 순서대로 합친다
    with ThreadPoolExecutor(max_workers=len(QUERIES), thread_name_prefix="profile") as ex:
        results = [r for rs in ex.map(lambda q: liner.search(q.format(n=name), max_results=10, label="profile_search"), QUERIES) for r in rs]
    seen, uniq = set(), []
    for r in results:
        u = r.get("url")
        if u and u not in seen:
            seen.add(u)
            uniq.append(r)
    out["sources"] = [{"title": r.get("title"), "url": r.get("url"), "date": r.get("date")} for r in uniq]
    if not uniq:
        return out
    corp_txt = (f"금융위 기업기본정보: 상호 {corp['name']}, 영문 {corp['name_en']}, 대표 {corp['ceo']}, 설립 {corp['founded']}, "
                f"주소 {corp['address']}, 주요사업 {corp['main_biz'] or '-'}, 업종 {corp['industry'] or '-'}") if corp else "금융위 기업기본정보: 일치 법인 없음"
    say("사업·기술·경쟁사 정리")
    system = (f"당신은 기업 분석가입니다. {DATA_RULE}\n"
              "검색 자료와 공공 API 값을 바탕으로 기업 프로필을 만듭니다. 사실(설립·대표·제품·현황)은 자료에 있는 것만 쓰고 없으면 비웁니다. "
              "경쟁사·기술 키워드·검색어는 자료와 업계 지식을 바탕으로 폭넓게 제시해도 됩니다. 투자 가능성이나 점수는 쓰지 않습니다.\n"
              "경쟁사는 한국에 본사를 둔 국내 기업만 고릅니다(상장·비상장 모두). 외국 기업과 외국 기업의 한국 지사·한국 법인은 제외하고, "
              "국내 기업이 5개 미만이면 해외 기업으로 채우지 말고 찾은 만큼만 씁니다. 대상 기업 자신은 경쟁사에 넣지 않습니다.")
    user = f"대상 기업: {name}\n{corp_txt}\n\n<자료>\n{numbered(uniq[:30], 280)}\n</자료>"
    prof = liner.json(system, user, SCHEMA, name="company_profile", max_tokens=5000)
    if prof is None:
        out["errors"].append("기업 프로필 모델 분석 실패")
        out["model_failed"] = True
        prof = {}
    if prof.get("competitors") is not None:
        prof["competitors"], out["excluded_competitors"] = domestic_only(prof.get("competitors") or [], name, prof.get("name_en") or "")
    out["profile"] = prof
    return out


KOREA = {"한국", "대한민국", "korea", "southkorea", "republicofkorea", "kr", "kor"}
_BRANCH = re.compile(r"한국\s*지사|한국\s*법인|한국\s*지점|korea\s*branch|국내\s*법인을\s*둔\s*(해외|외국)", re.I)


def domestic_only(comps: list[dict], target: str, target_en: str = "") -> tuple[list[dict], list[dict]]:
    """모델이 고른 경쟁사 후처리: 한국 본사 기업만 남기고(최대 5), 해외 기업·한국 지사·대상기업 자신·중복은 뺀다.

    판단 근거는 모델 답의 is_korean·country 와 상호·설명 표기뿐이다(추가 검색 없음). 뺀 기업은 사유와 함께 돌려준다.
    '코리아'로 끝나는 이름은 국내 기업에도 흔해 그것만으로는 빼지 않는다.
    """
    keep, drop = [], []
    seen = {common.norm_name(target), common.norm_name(target_en)} - {""}
    for c in comps:
        nm = str(c.get("name") or "").strip()
        key = common.norm_name(nm)
        country = common.norm_name(str(c.get("country") or ""))
        if not nm or key in seen:
            drop.append({**c, "excluded_reason": "대상기업 자신 또는 중복"})
        elif not c.get("is_korean") or (country and country not in KOREA):
            drop.append({**c, "excluded_reason": f"해외 기업(국가: {c.get('country') or '미기재'})"})
        elif branch_mark(f"{nm} {c.get('registered_name_ko') or ''} {c.get('reason') or ''}"):
            drop.append({**c, "excluded_reason": "외국 기업의 한국 지사·법인"})
        else:
            seen.add(key)
            keep.append(c)
    return keep[:5], drop


def branch_mark(text: str) -> bool:
    """'한국 지사·한국 법인' 같은 외국 기업 지사 표기가 있는가."""
    return bool(_BRANCH.search(text or ""))


def aliases(prof: dict, corp: dict | None) -> list[str]:
    """뉴스·특허 이름 맞추기에 쓰는 다른 이름(research/controller._aliases 그대로)."""
    out = [prof.get("name_ko") or "", prof.get("name_en") or "", *(prof.get("aliases") or [])]
    if corp:
        out += [re.sub(r"주식회사|\(주\)|㈜", "", n).strip() for n in corp.get("names") or []]
        out.append(corp.get("name_en") or "")
    # 너무 일반적인 짧은 영문(AI 등)은 뉴스 매칭에 쓰지 않는다
    return [a for a in dict.fromkeys(a.strip() for a in out) if len(a) >= 2 and a.lower() not in ("ai", "inc", "inc.")]
