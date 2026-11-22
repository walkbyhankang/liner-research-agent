"""공공데이터포털: 금융위 기업기본정보·요약재무제표, 국민연금 사업장 가입자(research/public_data.py 에서 옮김).

엔드포인트·파라미터·응답 필드는 261117_Liner/04_public_company_data_probe 에서 실제 호출로 확인한 것과 같다.
무료 API 이지만 같은 요청은 파일 캐시(24시간)로 다시 쓴다.

옮기며 바꾼 것
- 요청을 보내기 직전(재시도 포함)마다 use(API 이름)를 부른다. 단락에서는 budget.use, 단락 밖에서는 limits.use 를 넘긴다.
  상한에 닿으면 growth.limits.LimitReached 가 그대로 올라간다(PublicDataError 로 바꾸지 않는다).
- 동시 요청 수는 limits.slot() 의 공공데이터포털 묶음(6)으로 묶는다.
- 키가 없으면 MissingKey(PublicDataError 의 한 종류)를 낸다(단락은 missing_config).
- company_bundle(같은 이름의 다른 법인으로 바꾸기)은 옮기지 않았다. 계약은 고른 법인(crno)만 조회한다(계약 8.2절, 15절).
"""
from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import httpx

from growth import common, limits
from growth.contract import split_address

CORP_URL = "https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2"
FIN_URL = "https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2"
NPS = "https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/"
CACHE_HOURS = 24
NPS_WORKERS = 4
TIMEOUT = 30
API_OF = {"fsc_corp": limits.DATAGOKR_FSC_CORP, "fsc_fin": limits.DATAGOKR_FSC_FIN, "nps": limits.DATAGOKR_NPS}

ACCT = {"enpSaleAmt": "매출액", "enpBzopPft": "영업이익", "iclsPalClcAmt": "법인세차감전순이익", "enpCrtmNpf": "당기순이익",
        "enpTastAmt": "자산총계", "enpTdbtAmt": "부채총계", "enpTcptAmt": "자본총계", "enpCptlAmt": "자본금", "fnclDebtRto": "부채비율(%)"}

Use = Callable[[str], None]


class PublicDataError(Exception):
    pass


class MissingKey(PublicDataError):
    pass


_http = httpx.Client(timeout=TIMEOUT, headers={"User-Agent": "liner-research-agent/0.3"})
_sleep = time.sleep


def _no_use(api: str) -> None:
    return None


def _get(kind: str, url: str, params: dict, *, xml: bool = False, use: Use | None = None):
    """GET. 성공 응답만 캐시. 같은 요청은 열쇠별 잠금으로 한 번만 부르고, 공공데이터포털 동시 요청 수를 제한한다."""
    ident = {"url": url, "params": params}
    hit = common.cache_get(kind, ident, CACHE_HOURS)
    if hit is not None:
        return hit
    with common.key_lock(kind, ident):
        hit = common.cache_get(kind, ident, CACHE_HOURS)
        if hit is not None:
            return hit
        with limits.slot(API_OF[kind]):
            return _get_raw(kind, ident, url, params, xml, use or _no_use)


def _get_raw(kind: str, ident: dict, url: str, params: dict, xml: bool, use: Use):
    """5xx/429/네트워크 오류는 1회만 재시도. 오류 메시지에서 키를 지운다."""
    key = common.env("DATA_GO_KR_SERVICE_KEY")
    if not key:
        raise MissingKey("공공데이터 키가 설정되어 있지 않습니다")
    err = ""
    for attempt in range(2):
        use(API_OF[kind])  # 요청 직전마다(재시도도) 센다
        try:
            r = _http.get(url, params={**params, "serviceKey": key})
        except httpx.HTTPError as e:
            err = f"{type(e).__name__}"
            _sleep(1.5)
            continue
        if r.status_code >= 500 or r.status_code == 429:
            err = f"HTTP {r.status_code}"
            _sleep(1.5)
            continue
        if r.status_code != 200:
            raise PublicDataError(common.scrub_text(f"HTTP {r.status_code}: {r.text[:150]}"))
        if xml:
            if "<resultCode>00</resultCode>" not in r.text:
                raise PublicDataError(common.scrub_text(f"응답 오류: {r.text[:200]}"))
            data = r.text
        else:
            try:
                data = r.json()
            except ValueError:
                raise PublicDataError(common.scrub_text(f"JSON 아닌 응답: {r.text[:200]}")) from None
        common.cache_put(kind, ident, data)
        return data
    raise PublicDataError(common.scrub_text(f"호출 실패: {err}"))


def _items(d: dict) -> tuple[int, list[dict]]:
    body = ((d or {}).get("response") or {}).get("body") or {}
    it = (body.get("items") or {}).get("item") if isinstance(body.get("items"), dict) else None
    it = it or []
    return int(body.get("totalCount") or 0), (it if isinstance(it, list) else [it])


def _fmt_date(s: str | None) -> str:
    s = re.sub(r"\D", "", s or "")
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 else ""


# ---------------- 금융위 기업기본정보 ----------------
def find_corps(name: str, english: str = "", *, use: Use | None = None) -> list[dict]:
    """회사명으로 법인 후보를 찾는다. 같은 법인등록번호의 여러 스냅샷은 최신 것 하나로 합친다(다른 표기는 names 에)."""
    queries = list(dict.fromkeys(q for q in (name.strip(), re.sub(r"\s+", "", name)) if q))
    seen: dict[str, dict] = {}
    key = common.norm_name(name)
    eng = common.norm_name(english)
    for q in queries:
        _, items = _items(_get("fsc_corp", CORP_URL, {"corpNm": q, "pageNo": 1, "numOfRows": 100, "resultType": "json"}, use=use))
        for i in items:
            nm = common.norm_name(i.get("corpNm") or "")
            pb = common.norm_name(i.get("enpPbanCmpyNm") or "")
            en = common.norm_name(i.get("corpEnsnNm") or "")
            exact = key and (nm == key or pb == key or (eng and en == eng))
            if not exact and key not in nm:
                continue
            crno = re.sub(r"\D", "", i.get("crno") or "")
            if len(crno) != 13:  # 회사 id 가 될 수 없는 값은 후보로 두지 않는다(계약 1.4절)
                continue
            prev = seen.get(crno)
            if prev is None or (i.get("lastOpegDt") or "") > (prev["raw"].get("lastOpegDt") or ""):
                names = (prev or {}).get("names", set()) | {i.get("corpNm") or ""}
                seen[crno] = {"raw": i, "names": names, "exact": bool(exact) or (prev or {}).get("exact", False)}
            else:
                prev["names"].add(i.get("corpNm") or "")
                prev["exact"] = prev["exact"] or bool(exact)
    out = []
    for crno, e in seen.items():
        i = e["raw"]
        out.append({
            "crno": crno, "bzno": i.get("bzno") or "", "name": i.get("corpNm") or "",
            "names": sorted(n for n in e["names"] if n),
            "name_en": i.get("corpEnsnNm") or "", "ceo": i.get("enpRprFnm") or "", "founded": _fmt_date(i.get("enpEstbDt")),
            "address": i.get("enpBsadr") or "", "homepage": i.get("enpHmpgUrl") or "", "industry": i.get("sicNm") or "",
            "main_biz": i.get("enpMainBizNm") or "", "market": i.get("corpRegMrktDcdNm") or "",
            "updated": _fmt_date(i.get("lastOpegDt")), "exact": e["exact"],
        })
    # 정확히 일치하는 이름, 최근 갱신 순
    out.sort(key=lambda c: (not c["exact"], -int(re.sub(r"\D", "", c["updated"]) or 0)))
    return out


def corp_contract(c: dict, *, snapshot_at: str | None = None) -> dict:
    """find_corps 한 줄 → 계약 Corp(8.1절)."""
    region, district = split_address(c.get("address"))
    n = common.none_if_empty
    return {"companyId": c["crno"], "crno": c["crno"], "bzno": n(c.get("bzno")), "name": c.get("name") or c["crno"],
            "names": list(c.get("names") or []), "nameEn": n(c.get("name_en")), "ceo": n(c.get("ceo")),
            "founded": n(c.get("founded")), "address": n(c.get("address")), "region": region, "district": district,
            "homepage": n(c.get("homepage")), "industry": n(c.get("industry")), "mainBiz": n(c.get("main_biz")),
            "market": n(c.get("market")), "updated": n(c.get("updated")), "exact": bool(c.get("exact")),
            "snapshotAt": snapshot_at}


def financials(crno: str, *, use: Use | None = None) -> list[dict]:
    """요약재무제표 전 연도. 연도·기준(연결/별도)별 한 행. 금액 단위는 원(KRW, 응답 curCd 를 함께 남김)."""
    _, items = _items(_get("fsc_fin", FIN_URL, {"crno": crno, "pageNo": 1, "numOfRows": 100, "resultType": "json"}, use=use))
    rows = []
    for i in items:
        row = {"연도": i.get("bizYear") or "", "기준일": _fmt_date(i.get("basDt")), "구분": i.get("fnclDcdNm") or "",
               "통화": i.get("curCd") or ""}
        for k, label in ACCT.items():
            v = i.get(k)
            try:
                row[label] = float(v) if v not in (None, "") else None
            except ValueError:
                row[label] = None
        rows.append(row)
    rows.sort(key=lambda r: (r["연도"], r["구분"]))
    return rows


def pick_recent_years(rows: list[dict], n: int = 3) -> list[dict]:
    """최근 n개 사업연도. 같은 연도에 연결·별도가 모두 있으면 연결을 쓰고, 기준은 '구분' 열에 남는다.
    매출액 증가율·영업이익률은 그 표의 값으로만 계산한다(값이 없으면 비움)."""
    by_year: dict[str, dict] = {}
    for r in rows:
        y = r["연도"]
        if not y:
            continue
        cur = by_year.get(y)
        if cur is None or ("연결" in r["구분"] and "연결" not in cur["구분"]):
            by_year[y] = r
    years = sorted(by_year)[-n:]
    out = []
    allrows = sorted(by_year)
    for y in years:
        r = dict(by_year[y])
        idx = allrows.index(y)
        prev = by_year[allrows[idx - 1]] if idx > 0 else None
        sale, op = r.get("매출액"), r.get("영업이익")
        ps = prev.get("매출액") if prev else None
        r["매출액 증가율(%)"] = round((sale - ps) / abs(ps) * 100, 1) if sale is not None and ps not in (None, 0) else None
        r["영업이익률(%)"] = round(op / sale * 100, 1) if op is not None and sale not in (None, 0) else None
        out.append(r)
    return out


def financial_row(r: dict, *, with_ratios: bool) -> dict:
    """research 재무 행(한글 키) → 계약 FinancialRow(8.2절)."""
    basis = r.get("구분") or ""
    short = "연결" if "연결" in basis else ("별도" if "별도" in basis else None)
    g = lambda k: (float(r[k]) if r.get(k) is not None else None)  # noqa: E731
    return {"year": r.get("연도") or "", "periodEnd": common.none_if_empty(r.get("기준일")), "basis": basis, "basisShort": short,
            "currency": r.get("통화") or "", "revenue": g("매출액"), "operatingIncome": g("영업이익"),
            "pretaxIncome": g("법인세차감전순이익"), "netIncome": g("당기순이익"), "totalAssets": g("자산총계"),
            "totalLiabilities": g("부채총계"), "totalEquity": g("자본총계"), "capital": g("자본금"),
            "debtRatioPct": g("부채비율(%)"),
            "revenueGrowthPct": g("매출액 증가율(%)") if with_ratios else None,
            "operatingMarginPct": g("영업이익률(%)") if with_ratios else None}


# ---------------- 국민연금 ----------------
def _xml_items(text: str) -> list[dict]:
    root = ET.fromstring(text.encode("utf-8"))
    return [{c.tag: c.text for c in it} for it in root.iter("item")]


def nps_monthly(name: str, bzno: str | list[str] = "", months: int = 12, *, use: Use | None = None) -> dict:
    """사업장명 검색 → 월별 스냅샷(seq) → 가입자 수(상세)·신규취득/상실(기간별 현황).

    매칭: 사업장명에 회사명이 들어가고, 금융위 사업자번호가 있으면 앞 6자리도 일치(응답은 뒤 4자리 마스킹).
    가입자 수는 전체 임직원 수와 같지 않다(외국인·임원·단기근로자 등).
    """
    key = common.norm_name(name)
    prefixes = {b[:6] for b in ([bzno] if isinstance(bzno, str) else bzno) if b}
    cand: dict[str, dict] = {}
    queries = list(dict.fromkeys([name.strip(), re.sub(r"\s+", "", name)]))
    for q in queries:
        text = _get("nps", NPS + "getBassInfoSearchV2", {"wkplNm": q, "pageNo": 1, "numOfRows": 100}, xml=True, use=use)
        for i in _xml_items(text):
            wn = common.norm_name(i.get("wkplNm") or "")
            if key not in wn:
                continue
            if prefixes and (i.get("bzowrRgstNo") or "")[:6] not in prefixes:
                continue
            cand[i["seq"]] = i
    if not cand:
        return {"matched": [], "monthly": [], "note": "국민연금 사업장 검색에서 일치하는 사업장을 찾지 못했습니다."}
    # 같은 달에 사업장이 여럿이면(지점 등) 사업자번호 기준 가장 많이 나온 사업장 하나만 쓴다
    by_wk: dict[tuple, list[dict]] = {}
    for i in cand.values():
        by_wk.setdefault((i.get("wkplNm"), i.get("bzowrRgstNo")), []).append(i)
    main_key = max(by_wk, key=lambda k: len(by_wk[k]))
    snaps = sorted(by_wk[main_key], key=lambda i: i.get("dataCrtYm") or "")[-months:]

    def month(i: dict) -> tuple[dict, dict]:
        try:
            det = (_xml_items(_get("nps", NPS + "getDetailInfoSearchV2", {"seq": i["seq"], "pageNo": 1, "numOfRows": 10}, xml=True, use=use)) or [{}])[0]
            pd_ = (_xml_items(_get("nps", NPS + "getPdAcctoSttusInfoSearchV2", {"seq": i["seq"], "pageNo": 1, "numOfRows": 10}, xml=True, use=use)) or [{}])[0]
        except (PublicDataError, ET.ParseError):
            det, pd_ = {}, {}
        return det, pd_
    # 월별 조회는 서로 독립이라 병렬로(동시 요청 수는 limits.slot 이 묶는다). 결과 순서는 월 순서 그대로
    with ThreadPoolExecutor(max_workers=NPS_WORKERS, thread_name_prefix="nps") as ex:
        details = list(ex.map(month, snaps))
    monthly = []
    for i, (det, pd_) in zip(snaps, details):
        ym = i.get("dataCrtYm") or ""
        monthly.append({"월": f"{ym[:4]}-{ym[4:6]}" if len(ym) == 6 else ym,
                        "가입자 수": int(det["jnngpCnt"]) if det.get("jnngpCnt") else None,
                        "신규 취득": int(pd_["nwAcqzrCnt"]) if pd_.get("nwAcqzrCnt") else None,
                        "상실": int(pd_["lssJnngpCnt"]) if pd_.get("lssJnngpCnt") else None,
                        "업종": det.get("vldtVlKrnNm") or "", "주소": i.get("wkplRoadNmDtlAddr") or ""})
    prev = None
    for m in monthly:
        m["전월 대비"] = (m["가입자 수"] - prev) if m["가입자 수"] is not None and prev is not None else None
        prev = m["가입자 수"] if m["가입자 수"] is not None else prev
    vals = [m["가입자 수"] for m in monthly if m["가입자 수"] is not None]
    summary = {}
    if len(vals) >= 2:
        summary = {"시작": vals[0], "최근": vals[-1], "증감": vals[-1] - vals[0],
                   "증가율(%)": round((vals[-1] - vals[0]) / vals[0] * 100, 1) if vals[0] else None,
                   "기간": f"{monthly[0]['월']} ~ {monthly[-1]['월']}",
                   "신규 취득 합계": sum(m["신규 취득"] or 0 for m in monthly), "상실 합계": sum(m["상실"] or 0 for m in monthly)}
    return {"matched": [{"사업장명": main_key[0], "사업자번호(마스킹)": main_key[1]}], "monthly": monthly, "summary": summary,
            "note": "국민연금 가입자 수는 전체 임직원 수와 같지 않습니다(외국인·임원·단기근로자 등 차이). "
                    "신규 취득·상실은 기간별 현황 API의 각 월 기준값입니다. API가 제공하는 최근 월까지만 표시합니다."}


def nps_contract(n: dict) -> dict | None:
    """nps_monthly 결과 → 계약 Nps(8.2절). 사업장을 못 찾았으면 None."""
    if not n or not n.get("monthly") or not n.get("matched"):
        return None
    monthly = [{"month": m["월"], "members": m["가입자 수"], "joined": m["신규 취득"], "left": m["상실"], "change": m["전월 대비"]}
               for m in n["monthly"]]
    s = n.get("summary") or {}
    summary = ({"first": s["시작"], "latest": s["최근"], "change": s["증감"], "changePct": s["증가율(%)"], "period": s["기간"],
                "joinedTotal": s["신규 취득 합계"], "leftTotal": s["상실 합계"]} if s else None)
    last = n["monthly"][-1]
    m0 = n["matched"][0]
    return {"monthly": monthly, "summary": summary,
            "workplace": {"name": m0.get("사업장명") or "", "bznoMasked": m0.get("사업자번호(마스킹)") or "",
                          "industry": common.none_if_empty(last.get("업종")), "address": common.none_if_empty(last.get("주소"))},
            "note": n.get("note") or ""}


def nps_for_corp(corp: dict, query: str, *, use: Use | None = None) -> dict:
    """고른 법인의 국민연금: 넣은 이름 → 금융위에 등록된 다른 표기 순으로 찾고, 사업자번호 앞 6자리가 같은 사업장만 쓴다.
    사업자번호가 없으면 찾지 않는다(이름만으로는 다른 회사가 걸릴 수 있다)."""
    bzno = corp.get("bzno") or ""
    if not bzno:
        return {"matched": [], "monthly": [], "note": ""}
    names = [query] + [common.strip_corp(n) for n in corp.get("names") or []] + [common.strip_corp(corp.get("name"))]
    out: dict = {"matched": [], "monthly": [], "note": ""}
    for n in dict.fromkeys(x for x in names if x and len(x) >= 2):
        out = nps_monthly(n, [bzno], use=use)
        if out["monthly"]:
            break
    return out
