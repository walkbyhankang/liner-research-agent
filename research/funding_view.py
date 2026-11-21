"""⑥ 펀딩: 펀딩노트의 기존 기능을 그대로 연결한다.

- 정책상품(융자·보증) 후보: web/lib/finder.ts 의 matchProgram·sortMatches·inNeed 규칙을 그대로 옮긴 것(새 규칙 없음).
- VC 후보: finder.ts 의 groupFunds(모태펀드 자펀드 출자분야 낱말 일치, 최근 결성 순)·isExistingInvestor 를 옮긴 것.
- 기존 투자자·경쟁사 투자 이력: funding/profile.lookup(펀딩노트 '회사 조회' 백엔드)을 그대로 호출한다.
데이터는 펀딩노트가 쓰는 공공 API 스냅샷(web/public/data)을 읽는다. 기존 투자자는 신규 후보에서 뺀다.
"""
from __future__ import annotations

import json
import re
from datetime import date

import config
from funding import profile as fn_profile
from liner_client import LinerAPIError, LinerClient
from research import common

DATA = config.BASE_DIR / "web" / "public" / "data"
# finder.ts fundFields
FUND_FIELDS = {
    "early": ("창업 초기", ["창업초기", "청년창업", "대학창업", "기술지주", "엔젤", "첫걸음", "스타트업", "창업사업화", "창업기업"]),
    "ai": ("AI·딥테크·소프트웨어", ["AI", "초격차", "딥테크", "SaaS", "사이버보안", "4차", "DNA", "신기술", "비대면", "디지털", "메타버스", "5G", "가상"]),
    "bio": ("바이오·헬스", ["바이오", "백신", "제약", "보건"]),
    "content": ("콘텐츠·문화", ["콘텐츠", "영화", "문화", "게임", "애니", "드라마", "공연", "방송", "스포츠", "관광"]),
    "mfg": ("소재·부품·장비", ["소재부품장비", "스마트공장"]),
    "green": ("환경·에너지", ["그린", "환경", "미세먼지", "ESG", "해양"]),
    "local": ("지방 기업", ["지방", "지역", "규제자유특구", "영·호남", "인구활력"]),
    "ip": ("특허·기술사업화", ["특허", "IP", "기술사업화", "공공기술", "R&D"]),
    "impact": ("소셜임팩트·여성기업", ["소셜임팩트", "임팩트", "사회적기업", "여성기업", "사회서비스"]),
    "scale": ("스케일업·해외진출", ["스케일업", "해외", "글로벌", "수출", "유니콘", "K-밸류"]),
}
# finder.ts targetRule
TARGET_RULE = {"venture": (["창업벤처"], ["중소기업"]), "sme": (["중소기업"], []), "micro": (["소상공인"], ["중소기업"])}
LETTERS = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", ["에이", "비", "씨", "디", "이", "에프", "지", "에이치", "아이", "제이", "케이", "엘", "엠",
                                                 "엔", "오", "피", "큐", "알", "에스", "티", "유", "브이", "더블유", "엑스", "와이", "제트"]))


def _region_hit(regions: list[str], region: str) -> bool:
    return region in regions or (region in ("광주", "전남") and "전남광주" in regions)


def match_program(p: dict, region: str, biz: str) -> dict | None:
    """finder.ts matchProgram. 대상이 아니면 None."""
    reasons, checks = [], []
    nationwide = "전국" in p["regions"]
    agency_here = _region_hit([p["agencyRegion"]], region) if p.get("agencyRegion") else False
    local = agency_here if nationwide else _region_hit(p["regions"], region)
    if not nationwide and not local:
        return None
    doubt = nationwide and bool(p.get("agencyRegion")) and not agency_here
    if doubt:
        checks.append(f"{p['agency']} 공고인데 전국으로 분류됨 — 다른 지역 기업도 신청할 수 있는지 확인")
    else:
        reasons.append(("{} 공고".format(p["agency"]) if agency_here else "전국 대상") if nationwide else f"지역 대상: {'·'.join(p['regions'])}")
    exact_t, loose_t = TARGET_RULE[biz]
    exact = p["target"] in exact_t
    if not exact and p["target"] not in loose_t:
        return None
    if exact:
        reasons.append(f"지원대상: {p['target']}")
    else:
        checks.append(f"지원대상이 '{p['target']}'으로 분류된 공고 — 우리 회사가 해당하는지 공고문 확인")
    st = p["period"]["status"]
    if st == "수시":
        checks.append(f"신청기간 '{p['period']['raw']}' — 지금 접수하는지 확인")
    if st == "접수 예정":
        checks.append(f"접수 시작 전({p['period']['start']}부터)")
    return {"program": p, "reasons": reasons, "checks": checks, "local": local, "exact": exact, "doubt": doubt}


def _end_key(p: dict) -> str:
    return p["period"]["end"] if p["period"]["status"] == "접수 중" and p["period"].get("end") else "9999-99-99"


def policy_products(region: str, biz: str, today: str | None = None) -> list[dict]:
    """finder.ts '융자·보증'(금융 › 융자·보증) 공고 후보. 마감 지난 공고 제외, 정렬은 sortMatches."""
    today = today or date.today().isoformat()
    progs = json.loads((DATA / "programs.json").read_text(encoding="utf-8"))
    ms = []
    for p in progs:
        if p["period"].get("end") and p["period"]["end"] < today:
            continue
        if p["category"] != "금융" or p["sub"] not in ("융자", "보증"):
            continue
        m = match_program(p, region, biz)
        if m:
            ms.append(m)
    ms.sort(key=lambda m: m["program"].get("created") or "", reverse=True)  # 마지막 기준(최근 등록)부터 안정 정렬
    ms.sort(key=lambda m: (-m["local"], m["doubt"], -m["exact"], _end_key(m["program"])))
    return [{"상품·공고": m["program"]["title"], "종류": m["program"]["sub"], "기관": " / ".join(x for x in (m["program"]["agency"], m["program"]["operator"]) if x),
             "기간": m["program"]["period"]["raw"], "상태": m["program"]["period"]["status"], "맞는 점": " · ".join(m["reasons"]),
             "확인할 점": " · ".join(m["checks"]), "링크": m["program"]["url"]} for m in ms]


def gp_key(name: str) -> str:
    s = re.sub(r"주식회사|유한회사|유한책임회사|\(주\)|\(유\)|㈜", "", name)
    s = re.sub(r"[\s·.,&()\-]", "", s)
    return re.sub(r"[A-Z]", lambda m: LETTERS[m.group(0)], s).lower()


def vc_candidates(field_id: str, existing: list[str], today: str | None = None) -> tuple[list[dict], list[dict]]:
    """finder.ts groupFunds(만기 전 펀드, 출자분야 낱말 일치) → (신규 후보 운용사, 이미 투자한 운용사)."""
    today = today or date.today().isoformat()
    kw = FUND_FIELDS.get(field_id, FUND_FIELDS["ai"])[1]
    funds = json.loads((DATA / "funds.json").read_text(encoding="utf-8"))
    groups: dict[str, list[dict]] = {}
    for f in funds:
        if not (f.get("maturity") and f["maturity"] >= today):
            continue
        if not any(k in f["field"] for k in kw):
            continue
        groups.setdefault(f["gp"], []).append(f)
    rows = []
    for gp, lst in groups.items():
        lst.sort(key=lambda f: f.get("year") or 0, reverse=True)
        rows.append({"운용사": gp, "최근 결성": lst[0].get("year") or 0, "펀드 수": len(lst),
                     "펀드(출자분야·결성연도)": "; ".join(f"{f['name']}({f['field']}, {f['year']})" for f in lst[:3])})
    rows.sort(key=lambda r: (-r["최근 결성"], -r["펀드 수"], r["운용사"]))
    keys = {gp_key(n) for n in existing if len(gp_key(n)) >= 2}
    new = [r for r in rows if gp_key(r["운용사"]) not in keys]
    old = [r for r in rows if gp_key(r["운용사"]) in keys]
    return new, old


def company_lookup(name: str, progress=None) -> dict:
    """펀딩노트 회사 조회(funding/profile.lookup). 유료(검색 최대 10, 모델 최대 5)라 결과를 24시간 캐시한다."""
    ident = {"name": name, "v": 1}
    hit = common.cache_get("funding_lookup", ident, 24)
    if hit is not None:
        return {**hit, "cached": True}
    key, source = config.resolve_api_key()
    if not key:
        raise LinerAPIError("LINER_API_KEY 가 없습니다")
    client = LinerClient(key, source, limits={"search": 10, "model": 5, "agent": 0, "premium": 0})
    try:
        out = fn_profile.lookup(name, client, progress=progress)
    finally:
        client.close()
    common.cache_put("funding_lookup", ident, out)
    return {**out, "cached": False}


def biz_type(stage: str, sme_flag: str = "") -> str:
    """펀딩노트 기업 유형(창업·벤처 / 중소기업). 대기업·상장사도 화면 규칙상 중소기업 기준으로만 대조한다."""
    return "venture" if stage in ("예비·초기", "성장", "후기·상장 준비") else "sme"
