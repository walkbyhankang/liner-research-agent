"""합친 회사 값(merged, 계약 7절). 단락 결과만 보고 다시 계산한다(순수 함수).

규칙 요약
- 값마다 출처 하나. 공공 API 원자료 값은 confirmed, 국민연금 가입자 수는 reference, 웹 값은 facts 상태 그대로.
- 출처끼리 엇갈리면 하나를 고르지 않고 conflicting 으로 두고 values 에 모두 넣는다(공공 API 값 위치가 usedIndex).
- 값이 None 이면 '그 값을 채울 단락이 아직 끝나지 않음'. 끝났는데 값이 없으면 unavailable 과 짧은 사유.
- 서술(profile 사업 설명 등)은 Value 가 아니다(계약 6.4절). 기업 유형은 자동으로 채우지 않는다(bizTypeHint 만).
- 투자자는 confirmed·reported 기록만 넣고, 이름만 비슷한 다른 법인의 투자기관은 넣지 않는다(투자 이력 단락이 이미 뺐다).
- 경쟁사는 국내 기업만. 한글·영문 표기가 같은 회사는 profile 후보의 name·nameEn·registeredNameKo 로 맞춰 한 줄로 묶는다.
"""
from __future__ import annotations

import re

from growth.common import host_of, norm_name
from growth.contract import FUND_FIELD_LABEL, PENDING_KEYS, TERMINAL_SECTION_STATUSES, make_source, split_address, won_display

INTERRUPTED = "분석이 중간에 멈춤"
WEB_OK = ("confirmed", "reported")


def value(display, raw, status, source, *, quote=None, note=None) -> dict:
    return {"display": display, "raw": raw, "status": status, "source": source, "quote": quote, "note": note,
            "reason": None, "values": None, "usedIndex": None}


def missing(reason: str, source=None) -> dict:
    return {"display": None, "raw": None, "status": "unavailable", "source": source, "quote": None, "note": None,
            "reason": reason, "values": None, "usedIndex": None}


def conflicting(alts: list[dict], used: int | None, note: str | None = None) -> dict:
    top = alts[used if used is not None else 0]
    return {"display": top["display"], "raw": top["raw"], "status": "conflicting", "source": top["source"], "quote": top["quote"],
            "note": note, "reason": None, "values": alts, "usedIndex": used}


class _View:
    """단락 봉투 묶음을 읽기 쉽게."""

    def __init__(self, sections: dict):
        self.s = sections

    def terminal(self, key: str) -> bool:
        return self.s[key]["status"] in TERMINAL_SECTION_STATUSES

    def result(self, key: str) -> dict | None:
        """다시 실행 중이어도 이전 결과를 그대로 쓴다(계약 5.6절)."""
        return self.s[key]["result"]

    def code(self, key: str) -> str | None:
        return (self.s[key].get("error") or {}).get("code")

    def day(self, key: str) -> str:
        """그 단락이 끝난 날(출처의 '{조회일} 조회')."""
        return (self.s[key].get("analyzedAt") or "")[:10]

    def asof(self, key: str) -> str:
        return f"{self.day(key)} 조회"

    def why(self, key: str, default: str) -> str:
        """단락이 결과 없이 끝났을 때의 짧은 사유."""
        return {"interrupted": INTERRUPTED, "daily_limit": "오늘 호출 상한 도달", "upstream_error": "자료를 받지 못함",
                "timeout": "자료를 받지 못함", "missing_config": "설정이 되어 있지 않음",
                "section_limit": "호출 상한 안에서 확인 못 함"}.get(self.code(key) or "", default)


def _web_source(v: _View, field: dict, key: str = "facts") -> dict:
    url = field.get("sourceUrl")
    if field["status"] == "confirmed" and url:
        return make_source("web_page", as_of=v.asof(key), url=url, host=host_of(url) or "웹 문서")
    return make_source("web_snippet", as_of=v.asof(key), url=url)


def _web_value(v: _View, field: dict, display: str | None = None, raw=None) -> dict:
    """facts 필드 하나 → Value(상태 그대로). conflicting 이면 값 하나짜리 엇갈림(계약 6.2절)."""
    src = _web_source(v, field)
    disp = display or field["value"]
    if field["status"] == "conflicting":
        alt = {"display": disp, "raw": raw if raw is not None else field["value"], "source": src, "quote": field.get("evidence")}
        return conflicting([alt], None, "다른 자료의 값은 이 분석에 남지 않았습니다.")
    return value(disp, raw if raw is not None else field["value"], field["status"], src, quote=field.get("evidence"))


def _same_founded(official: str, web: str) -> bool:
    """금융위 설립일(YYYY-MM-DD)과 웹 값이 같은가(계약 7.3). 웹 값이 YYYY-MM-DD 면 10자 전체, YYYY-MM 이면 앞 7자,
    YYYY 이면 앞 4자를 견준다(일까지 적힌 웹 값이 하루라도 다르면 엇갈림)."""
    m = re.match(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?", web or "")
    if not m:
        return False
    if m.group(3):
        return official[:10] == f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if m.group(2):
        return official[:7] == f"{m.group(1)}-{m.group(2)}"
    return official[:4] == m.group(1)


def merged(sections: dict, *, query: str, crno: str | None, job_running: bool) -> dict:
    v = _View(sections)
    ident = v.result("identity") if v.terminal("identity") else None
    corp = (ident or {}).get("corp")
    no_corp = not crno or (v.terminal("identity") and corp is None)
    corp_src = make_source("fsc_corp", as_of=v.asof("identity")) if corp else None
    facts_done = v.terminal("facts")
    f = v.result("facts") if facts_done else None
    fields = {x["key"]: x for x in (f or {}).get("fields") or []}
    prof = v.result("profile") if v.terminal("profile") else None

    m: dict = {"region": None, "district": None, "headquarters": None, "ceo": None, "founded": None,
               "bizType": missing("근거 자료 없음"), "bizTypeHint": None, "industry": {"official": None, "web": None},
               "employees": None, "revenue": {"official": None, "web": None}, "npsLatest": None, "patentCount": None,
               "investors": [], "rivals": [], "techKeywords": [], "programKeywords": [], "fundField": None, "bidKeywords": [],
               "pending": []}

    # 지역·본사(7.2)
    sido, district = split_address((corp or {}).get("address"))
    if corp and sido:
        m["region"] = value(sido, sido, "confirmed", corp_src)
        m["district"] = district
        m["headquarters"] = value(f"{sido} {district}" if district else sido, corp["address"], "confirmed", corp_src)
    elif v.terminal("identity") and (no_corp or not sido):
        if facts_done and "region" in fields:
            fld = fields["region"]
            r, d = split_address(fld["value"])
            hq = _web_value(v, fld, f"{r} {d}" if r and d else (r or fld["value"]), fld["value"])
            m["headquarters"] = hq
            if r:
                m["region"] = {**hq, "display": r, "raw": r} if hq["status"] != "conflicting" else _web_value(v, fld, r, r)
                m["district"] = d
            else:
                m["region"] = missing("지역 자료 없음")
        elif facts_done:
            reason = v.why("facts", "지역 자료 없음")
            m["region"], m["headquarters"] = missing(reason), missing(reason)

    # 대표(7.3)
    if v.terminal("identity"):
        if corp:
            m["ceo"] = value(corp["ceo"], corp["ceo"], "confirmed", corp_src) if corp.get("ceo") else missing("공공 자료에 대표 없음")
        else:
            m["ceo"] = missing("법인 확인 안 함" if no_corp else v.why("identity", "법인 확인 안 함"))

    # 설립(7.3)
    web_f = fields.get("founded")
    if corp and corp.get("founded"):
        off = value(corp["founded"], corp["founded"], "confirmed", corp_src)
        if web_f and web_f["status"] in ("confirmed", "reported", "conflicting") and not _same_founded(corp["founded"], web_f["value"]):
            m["founded"] = conflicting([
                {"display": off["display"], "raw": off["raw"], "source": corp_src, "quote": None},
                {"display": web_f["value"], "raw": web_f["value"], "source": _web_source(v, web_f), "quote": web_f.get("evidence")},
            ], 0)
        else:
            m["founded"] = off
    elif v.terminal("identity") and facts_done:
        m["founded"] = _web_value(v, web_f) if web_f else missing(v.why("facts", "설립 자료 없음"))

    # 업종(7.5)
    if v.terminal("identity"):
        if corp:
            m["industry"]["official"] = (value(corp["industry"], corp["industry"], "confirmed", corp_src) if corp.get("industry")
                                         else missing("공공 자료에 업종 없음", corp_src))
        else:
            m["industry"]["official"] = missing("법인 확인 안 함" if no_corp else v.why("identity", "법인 확인 안 함"))
    prof_src = make_source("liner_profile", as_of=v.asof("profile"), n=str((prof or {}).get("sourceCount") or 0)) if prof else None
    prof_industry = value(prof["industry"], prof["industry"], "inferred", prof_src) if prof and prof.get("industry") else None
    if facts_done and "industry" in fields:
        m["industry"]["web"] = _web_value(v, fields["industry"])
    elif prof_industry:
        m["industry"]["web"] = prof_industry
    elif facts_done and v.terminal("profile"):
        m["industry"]["web"] = missing(v.why("facts", "업종 자료 없음"))

    # 직원 수·매출(7.5)
    if facts_done:
        m["employees"] = _web_value(v, fields["employees"]) if "employees" in fields else missing(v.why("facts", "직원 수 자료 없음"))
        m["revenue"]["web"] = _web_value(v, fields["revenue"]) if "revenue" in fields else missing(v.why("facts", "매출 보도 없음"))
    if v.terminal("official"):
        o = v.result("official")
        rows = [r for r in (o or {}).get("financials") or [] if r.get("revenue") is not None]
        if rows:
            last = rows[-1]
            m["revenue"]["official"] = value(won_display(last["revenue"]), last["revenue"], "confirmed",
                                             make_source("fsc_fin", as_of=f"{last['year']} 사업연도", basis=last["basisShort"]))
        else:
            m["revenue"]["official"] = missing("법인 확인 안 함" if no_corp else v.why("official", "공식 재무 자료 없음"))
        # 국민연금(7.6)
        months = [x for x in ((o or {}).get("nps") or {}).get("monthly") or [] if x.get("members") is not None]
        if months:
            mon = months[-1]
            m["npsLatest"] = value(f"{mon['members']}명", mon["members"], "reference", make_source("nps", as_of=mon["month"]),
                                   note="국민연금 가입자 수는 상시근로자 수와 다릅니다.")
        else:
            m["npsLatest"] = missing("법인 확인 안 함" if no_corp else v.why("official", "국민연금 사업장을 찾지 못함"))

    # 특허(7.6)
    if v.terminal("patents"):
        p = v.result("patents")
        total = ((p or {}).get("summary") or {}).get("total") or 0
        m["patentCount"] = (value(f"{total}건", total, "confirmed", make_source("patents", as_of=v.asof("patents")))
                            if total else missing(v.why("patents", "출원인이 확인된 특허를 검색에서 찾지 못함")))

    # 낱말·투자 분야(7.7)
    if prof:
        tech = list(prof.get("techKeywords") or [])
        m["techKeywords"] = tech
        prog: list[str] = []
        for w in list(prof.get("govKeywords") or []) + [k["ko"] for k in tech] + list(prof.get("coreTech") or []):
            w = (w or "").strip()
            if w and w not in prog:
                prog.append(w)
        m["programKeywords"] = prog[:30]
        bid = [w for w in (prof.get("bidKeywords") or []) if w][:6]
        m["bidKeywords"] = bid or [w for w in m["programKeywords"] if len(w) <= 6][:5]
        ff = prof.get("fundField")
        m["fundField"] = (value(FUND_FIELD_LABEL[ff], ff, "inferred", prof_src) if ff in FUND_FIELD_LABEL
                          else missing("투자 분야 자료 없음"))
    elif v.terminal("profile"):
        m["fundField"] = missing(v.why("profile", "투자 분야 자료 없음"))

    # 기업 유형 추정(7.4)
    fh = v.result("funding_history") if v.terminal("funding_history") else None
    rounds = (fh or {}).get("rounds") or []
    fv = m["founded"]
    if fv and fv["status"] != "unavailable" and fv["raw"] and rounds:
        m["bizTypeHint"] = {"id": "venture", "reason": f"설립 {str(fv['raw'])[:7]}, 투자 라운드 {len(rounds)}건"}

    m["investors"] = _investors(v, fh, f)
    m["rivals"] = _rivals(v, prof, f, query)

    if job_running and not facts_done:
        want = {"employees", "revenue.web", "industry.web", "founded.web", "investors.confirmed", "rivals.facts"}
        if no_corp:
            want.add("region.web")
        m["pending"] = [k for k in PENDING_KEYS if k in want]
    return m


def _investors(v: _View, fh: dict | None, f: dict | None) -> list[dict]:
    rows: dict[str, dict] = {}
    pdl = make_source("pdl", as_of=v.asof("funding_history")) if fh else None
    for x in (fh or {}).get("investors") or []:
        k = norm_name(x["name"])
        if not k:
            continue
        if k in rows:
            if x["name"] != rows[k]["name"] and x["name"] not in rows[k]["aliases"]:
                rows[k]["aliases"].append(x["name"])
            continue
        rows[k] = {"key": k, "name": x["name"], "aliases": [], "status": "reported", "roundCount": x["roundCount"],
                   "roundLabels": list(x["roundLabels"]), "lastDate": x["lastDate"], "lead": bool(x["lead"]),
                   "foundIn": ["funding_history"], "sources": [pdl]}
    facts_only: dict[str, int] = {}   # 투자 이력에 없고 facts 에만 있는 투자자의 기록 수
    for x in (f or {}).get("investors") or []:
        if x["status"] not in WEB_OK:  # inferred·conflicting 기록은 넣지 않는다(계약 7.8절)
            continue
        k = norm_name(x["name"])
        if not k:
            continue
        row = rows.get(k)
        if row is None:
            row = rows[k] = {"key": k, "name": x["name"], "aliases": [], "status": "reported", "roundCount": 0, "roundLabels": [],
                             "lastDate": None, "lead": False, "foundIn": ["facts"], "sources": []}
            facts_only[k] = 0
        elif x["name"] != row["name"] and x["name"] not in row["aliases"]:
            row["aliases"].append(x["name"])
        if "facts" not in row["foundIn"]:
            row["foundIn"].append("facts")
        if x["status"] == "confirmed":
            row["status"] = "confirmed"
        if k in facts_only:
            facts_only[k] += 1
            row["roundCount"] = facts_only[k]
            label = f"{x.get('round') or '라운드 미상'} {(x.get('date') or '')[:7]}".strip()
            if label not in row["roundLabels"]:
                row["roundLabels"].append(label)
            if x.get("date") and (row["lastDate"] or "") < x["date"]:
                row["lastDate"] = x["date"]
        src = _web_source(v, x)
        if src not in row["sources"]:
            row["sources"].append(src)
    out = list(rows.values())
    out.sort(key=lambda r: r["lastDate"] or "", reverse=True)
    out.sort(key=lambda r: (not r["lead"], -r["roundCount"]))
    return out


def _rivals(v: _View, prof: dict | None, f: dict | None, query: str) -> list[dict]:
    rows: list[dict] = []
    by_name: dict[str, dict] = {}
    prof_src = make_source("liner_profile", as_of=v.asof("profile"), n=str((prof or {}).get("sourceCount") or 0)) if prof else None
    for c in (prof or {}).get("competitors") or []:
        key = "rival:" + norm_name(c.get("registeredNameKo") or c["name"])
        if key == "rival:" or any(r["key"] == key for r in rows):
            continue
        r = {"key": key, "name": c["name"], "nameEn": c.get("nameEn"), "registeredNameKo": c.get("registeredNameKo"),
             "relation": c.get("relation"), "reason": c.get("reason"), "status": "inferred", "foundIn": ["profile"],
             "products": None, "employees": None, "revenue": None, "funding": None, "sources": [prof_src]}
        rows.append(r)
        for n in (c["name"], c.get("nameEn"), c.get("registeredNameKo")):
            if n and norm_name(n):
                by_name.setdefault(norm_name(n), r)
    extra: list[dict] = []
    me = norm_name(query)
    for x in (f or {}).get("competitors") or []:
        if not x.get("domestic"):
            continue
        k = norm_name(x["name"])
        if not k or k == me:
            continue
        src = _web_source(v, x)
        hit = by_name.get(k)
        if hit and "profile" in hit["foundIn"] and "facts" not in hit["foundIn"]:
            hit["foundIn"] = ["profile", "facts"]
            if x["status"] in WEB_OK:
                hit["status"] = x["status"]
            hit.update(products=x.get("products"), employees=x.get("employees"), revenue=x.get("revenue"), funding=x.get("funding"))
            hit["sources"] = hit["sources"] + [src]
            continue
        key = "rival:" + k
        if hit or any(r["key"] == key for r in rows + extra):
            continue
        extra.append({"key": key, "name": x["name"], "nameEn": None, "registeredNameKo": None, "relation": x.get("relation"),
                      "reason": None, "status": x["status"] if x["status"] in WEB_OK else "inferred", "foundIn": ["facts"],
                      "products": x.get("products"), "employees": x.get("employees"), "revenue": x.get("revenue"),
                      "funding": x.get("funding"), "sources": [src]})
    both = [r for r in rows if len(r["foundIn"]) == 2]
    only = [r for r in rows if len(r["foundIn"]) == 1]
    return both + only + extra
