"""공공데이터포털: 금융위 기업기본정보·요약재무제표, 국민연금 사업장 가입자.

엔드포인트·파라미터·응답 필드는 261117_Liner/04_public_company_data_probe 에서 실제 호출로 확인한 것과 같다.
무료 API 이지만 같은 요청은 파일 캐시(기본 24시간)로 재사용한다.
"""
from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import httpx

from research import common

CORP_URL = "https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2"
FIN_URL = "https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2"
NPS = "https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2/"
CACHE_HOURS = 24
NPS_WORKERS = 4
TIMEOUT = 30

ACCT = {"enpSaleAmt": "매출액", "enpBzopPft": "영업이익", "iclsPalClcAmt": "법인세차감전순이익", "enpCrtmNpf": "당기순이익",
        "enpTastAmt": "자산총계", "enpTdbtAmt": "부채총계", "enpTcptAmt": "자본총계", "enpCptlAmt": "자본금", "fnclDebtRto": "부채비율(%)"}


class PublicDataError(Exception):
    pass


_http = httpx.Client(timeout=TIMEOUT, headers={"User-Agent": "liner-research-agent/0.3"})


def _get(kind: str, url: str, params: dict, *, xml: bool = False):
    """GET. 성공 응답만 캐시. 같은 요청은 키별 잠금으로 한 번만 부르고, 공공데이터포털 동시 요청 수를 제한한다."""
    ident = {"url": url, "params": params}
    hit = common.cache_get(kind, ident, CACHE_HOURS)
    if hit is not None:
        return hit
    with common.key_lock(kind, ident):
        hit = common.cache_get(kind, ident, CACHE_HOURS)
        if hit is not None:
            return hit
        with common.limit("data_go_kr"):
            return _get_raw(kind, ident, url, params, xml)


def _get_raw(kind: str, ident: dict, url: str, params: dict, xml: bool):
    """5xx/429/네트워크 오류는 1회만 재시도. 오류 메시지에서 키를 지운다."""
    key = common.env("DATA_GO_KR_SERVICE_KEY")
    if not key:
        raise PublicDataError("DATA_GO_KR_SERVICE_KEY 가 .env 에 없습니다")
    err = ""
    for attempt in range(2):
        try:
            r = _http.get(url, params={**params, "serviceKey": key})
        except httpx.HTTPError as e:
            err = f"{type(e).__name__}"
            time.sleep(1.5)
            continue
        if r.status_code >= 500 or r.status_code == 429:
            err = f"HTTP {r.status_code}"
            time.sleep(1.5)
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
def find_corps(name: str, english: str = "") -> list[dict]:
    """회사명으로 법인 후보를 찾는다. 같은 법인등록번호의 여러 스냅샷은 최신 것 하나로 합친다."""
    queries = list(dict.fromkeys(q for q in (name.strip(), re.sub(r"\s+", "", name)) if q))
    seen: dict[str, dict] = {}
    key = common.norm_name(name)
    eng = common.norm_name(english)
    for q in queries:
        _, items = _items(_get("fsc_corp", CORP_URL, {"corpNm": q, "pageNo": 1, "numOfRows": 100, "resultType": "json"}))
        for i in items:
            nm = common.norm_name(i.get("corpNm") or "")
            pb = common.norm_name(i.get("enpPbanCmpyNm") or "")
            en = common.norm_name(i.get("corpEnsnNm") or "")
            exact = key and (nm == key or pb == key or (eng and en == eng))
            if not exact and key not in nm:
                continue
            crno = i.get("crno") or ""
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
            "crno": crno, "bzno": i.get("bzno") or "", "name": i.get("corpNm") or "", "names": sorted(e["names"]),
            "name_en": i.get("corpEnsnNm") or "", "ceo": i.get("enpRprFnm") or "", "founded": _fmt_date(i.get("enpEstbDt")),
            "address": i.get("enpBsadr") or "", "homepage": i.get("enpHmpgUrl") or "", "industry": i.get("sicNm") or "",
            "main_biz": i.get("enpMainBizNm") or "", "sme": i.get("smenpYn") or "", "market": i.get("corpRegMrktDcdNm") or "",
            "employees_fsc": i.get("enpEmpeCnt") or "", "updated": _fmt_date(i.get("lastOpegDt")), "exact": e["exact"],
        })
    # 정확히 일치하는 이름, 최근 갱신 순
    out.sort(key=lambda c: (not c["exact"], -int(re.sub(r"\D", "", c["updated"]) or 0)))
    return out


def financials(crno: str) -> list[dict]:
    """요약재무제표 전 연도. 연도·기준(연결/별도)별 한 행. 금액 단위는 원(KRW, 응답 curCd 를 함께 남김)."""
    _, items = _items(_get("fsc_fin", FIN_URL, {"crno": crno, "pageNo": 1, "numOfRows": 100, "resultType": "json"}))
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
    prev = None
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


# ---------------- 국민연금 ----------------
def _xml_items(text: str) -> list[dict]:
    root = ET.fromstring(text.encode("utf-8"))
    return [{c.tag: c.text for c in it} for it in root.iter("item")]


def nps_monthly(name: str, bzno: str | list[str] = "", months: int = 12) -> dict:
    """사업장명 검색 → 월별 스냅샷(seq) → 가입자 수(상세)·신규취득/상실(기간별 현황).

    매칭: 사업장명에 회사명이 들어가고, 금융위 사업자번호가 있으면 앞 6자리도 일치(응답은 뒤 4자리 마스킹).
    가입자 수는 전체 임직원 수와 같지 않다(외국인·임원·단기근로자 등).
    """
    key = common.norm_name(name)
    prefixes = {b[:6] for b in ([bzno] if isinstance(bzno, str) else bzno) if b}
    cand: dict[str, dict] = {}
    queries = list(dict.fromkeys([name.strip(), re.sub(r"\s+", "", name)]))
    for q in queries:
        text = _get("nps", NPS + "getBassInfoSearchV2", {"wkplNm": q, "pageNo": 1, "numOfRows": 100}, xml=True)
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
            det = (_xml_items(_get("nps", NPS + "getDetailInfoSearchV2", {"seq": i["seq"], "pageNo": 1, "numOfRows": 10}, xml=True)) or [{}])[0]
            pd_ = (_xml_items(_get("nps", NPS + "getPdAcctoSttusInfoSearchV2", {"seq": i["seq"], "pageNo": 1, "numOfRows": 10}, xml=True)) or [{}])[0]
        except (PublicDataError, ET.ParseError):
            det, pd_ = {}, {}
        return det, pd_
    # 월별 조회는 서로 독립이라 병렬로(동시 요청 수는 common.limit('data_go_kr') 가 묶는다). 결과 순서는 월 순서 그대로
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


def company_bundle(name: str, english: str = "", progress=None) -> dict:
    """국내 기업 한 곳의 공공 자료: 법인 식별, 3개년 재무, 12개월 고용. 실패는 errors 에 남기고 계속한다."""
    say = progress or (lambda m: None)
    out: dict = {"name": name, "corp": None, "corp_candidates": [], "financials_all": [], "financials": [],
                 "nps": {}, "errors": []}
    try:
        corps = find_corps(name, english)
        out["corp_candidates"] = corps[:8]
        out["corp"] = corps[0] if corps else None
        if not corps:
            out["errors"].append("금융위 기업기본정보에서 법인을 찾지 못했습니다.")
    except PublicDataError as e:
        out["errors"].append(f"금융위 기업기본정보 오류: {e}")
    corp = out["corp"]
    if corp:
        say(f"{name}: 재무실적 수집 중...")
        # 같은 이름 법인이 여럿이면(합병·법인 전환 등) 최근 사업연도 재무가 있는 법인을 대표로 쓴다
        best = None
        for c in [corp] + [x for x in out["corp_candidates"][1:4] if x["exact"]]:
            try:
                rows = financials(c["crno"])
            except PublicDataError as e:
                out["errors"].append(f"금융위 재무정보 오류: {e}")
                break
            if rows and (best is None or max(r["연도"] for r in rows) > max(r["연도"] for r in best[1])):
                best = (c, rows)
        if best:
            out["corp"] = corp = best[0]
            out["financials_all"] = best[1]
            out["financials"] = pick_recent_years(best[1])
            out["financials_crno"] = best[0]["crno"]
        else:
            out["errors"].append("금융위 요약재무제표에 자료가 없습니다(비공개·미제출 가능).")
    say(f"{name}: 국민연금 가입자 수집 중...")
    try:
        bznos = [c["bzno"] for c in out["corp_candidates"] if c["exact"]] or ([corp["bzno"]] if corp else [])
        out["nps"] = nps_monthly(name, bznos)
        if not out["nps"]["monthly"] and corp:
            for alt in corp["names"]:  # '기준 기업' 처럼 등록된 다른 표기로 한 번 더
                alt_core = re.sub(r"주식회사|\(주\)|㈜", "", alt).strip()
                if alt_core and alt_core != name:
                    out["nps"] = nps_monthly(alt_core, bznos)
                    if out["nps"]["monthly"]:
                        break
    except (PublicDataError, ET.ParseError) as e:
        out["errors"].append(f"국민연금 API 오류: {e}")
    return out


def age_years(founded: str) -> float | None:
    try:
        d = date.fromisoformat(founded)
    except (TypeError, ValueError):
        return None
    return round((date.today() - d).days / 365.25, 1)
