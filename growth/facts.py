"""facts 단락: 펀딩노트 회사 조회 엔진(funding.profile.lookup)으로 원문 확인 사실·기존 투자자·엔진 경쟁사를 얻는다(계약 8.4절).

- lookup 에는 단락 예산의 Liner 클라이언트(budget.liner_client())를 넘긴다. 엔진은 search_web·responses·remaining·calls 를 그대로 쓴다.
- 경쟁사 투자 조사(funding/rivals.research)는 하지 않는다(계약 8.4절, 설계 6.3). lookup 안에서 그 조사가 보내는 요청
  (label 이 'rival_' 로 시작)은 보내기 전에 CallLimitExceeded 로 막는다. lookup 은 그 오류를 기록만 하고 결과를 돌려준다.
- 엔진 경쟁사의 국내 판정(domestic)도 여기서 한다(계약 7.9절).
"""
from __future__ import annotations

from typing import Any, Callable

from funding import profile as profile_mod
from growth import common, company, limits, public_data
from liner_client import CallLimitExceeded

_lookup = profile_mod.lookup
ProfileError = profile_mod.ProfileError
FIELD_KEYS = ("founded", "region", "industry", "employees", "revenue")
FACT_STATUSES = ("confirmed", "reported", "inferred", "conflicting")


class NoRivalResearch:
    """facts 단락용 클라이언트 덮개: 경쟁사 투자 조사 요청만 보내지 않고, 나머지는 그대로 넘긴다."""

    def __init__(self, client: Any):
        self._client = client

    @staticmethod
    def _block(label: str | None) -> None:
        if str(label or "").startswith("rival_"):
            raise CallLimitExceeded("facts 단락은 경쟁사 투자 조사를 하지 않습니다", retryable=False)

    def search_web(self, *args, **kwargs):
        self._block(kwargs.get("label"))
        return self._client.search_web(*args, **kwargs)

    def chat_json(self, *args, **kwargs):
        self._block(kwargs.get("label"))
        return self._client.chat_json(*args, **kwargs)

    def __getattr__(self, name: str):
        return getattr(self._client, name)


def lookup(name: str, client: Any, *, homepage: str = "", fetcher=None, progress=None) -> dict:
    """funding.profile.lookup 그대로(경쟁사 투자 조사만 막음). ProfileError·LinerAPIError 는 그대로 올라간다."""
    return _lookup(name, NoRivalResearch(client), homepage=homepage, fetcher=fetcher, progress=progress)


def stage_label(message: str) -> str:
    """엔진 진행 문구 → 화면 단계 이름(api/main.stage_label 과 같은 규칙)."""
    if message.startswith("Search API"):
        return "보도·공식 자료 검색"
    if message.startswith("원문 확인"):
        return "원문 확인"
    if message.startswith("Model API"):
        return "회사 정보·기존 투자자·경쟁사 추출"
    return "조회 중"


def _n(v):
    return common.none_if_empty(v)


def to_contract(out: dict) -> dict:
    """lookup 결과 → FactsResult(domestic 은 아직 False, judge_domestic 이 채운다)."""
    fields = [{"key": f["key"], "label": str(f.get("label") or ""), "value": str(f.get("value") or ""), "status": f["status"],
               "sourceUrl": common.web_url(f.get("sourceUrl")), "evidence": _n(f.get("evidence")), "note": _n(f.get("note"))}
              for f in out.get("fields") or [] if f.get("status") in FACT_STATUSES and f.get("key") in FIELD_KEYS
              and str(f.get("value") or "").strip()]
    investors = [{"name": str(i["name"]), "round": _n(i.get("round")), "date": _n(i.get("date")), "status": i["status"],
                  "sourceUrl": common.web_url(i.get("sourceUrl"))}
                 for i in out.get("investors") or [] if i.get("status") in FACT_STATUSES and str(i.get("name") or "").strip()]
    comps = [{"name": str(c["name"]), "relation": _n(c.get("relation")), "products": _n(c.get("products")),
              "revenue": _n(c.get("revenue")), "employees": _n(c.get("employees")), "funding": _n(c.get("funding")),
              "asOf": _n(c.get("asOf")), "status": c["status"], "sourceUrl": common.web_url(c.get("sourceUrl")), "domestic": False}
             for c in out.get("competitors") or [] if c.get("status") in FACT_STATUSES and str(c.get("name") or "").strip()]
    meta = out.get("meta") or {}
    return {"fields": fields, "investors": investors, "competitors": comps, "searches": int(meta.get("searches") or 0),
            "pagesRead": int(meta.get("pagesRead") or 0)}


def empty_result() -> dict:
    return {"fields": [], "investors": [], "competitors": [], "searches": 0, "pagesRead": 0}


def judge_domestic(comps: list[dict], profile_result: dict | None, target: str, *, use: Callable[[str], None]) -> bool:
    """엔진 경쟁사의 domestic 을 채운다(제자리 수정, 계약 7.9절). 상한에 닿아 다 판정하지 못했으면 False 를 돌려준다.

    ① 이름(norm_name)이 profile 경쟁사의 name·nameEn·registeredNameKo 중 하나와 같으면 국내.
    ② 아니면 금융위 기업기본정보를 그 이름으로 한 번 찾아 정확히 같은 법인이 있고, 관계가 '해외 경쟁사'가 아니고,
       이름·설명에 '한국 지사·한국 법인' 표기가 없으면 국내.
    ③ 그 밖에는 국내가 아니다(화면 어디에도 쓰지 않는다). 판정할 수 없을 때도(키 없음·오류·상한) 국내로 두지 않는다.
    """
    known = set()
    for c in (profile_result or {}).get("competitors") or []:
        for n in (c.get("name"), c.get("nameEn"), c.get("registeredNameKo")):
            if n and common.norm_name(n):
                known.add(common.norm_name(n))
    me = common.norm_name(target)
    complete = True
    for c in comps:
        key = common.norm_name(c["name"])
        if not key or key == me:
            c["domestic"] = False
            continue
        if key in known:
            c["domestic"] = True
            continue
        if c.get("relation") == "해외 경쟁사" or company.branch_mark(f"{c['name']} {c.get('products') or ''}"):
            c["domestic"] = False
            continue
        try:
            corps = public_data.find_corps(c["name"], use=use)
        except limits.LimitReached:
            c["domestic"] = False
            complete = False
            continue
        except public_data.PublicDataError:
            corps = []
        c["domestic"] = any(x["exact"] for x in corps)
    return complete
