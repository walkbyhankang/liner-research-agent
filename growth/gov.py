"""나라장터 입찰공고(팀원의 통합 분석 프로토타입(커밋 97c93ce)의 나라장터 부분을 옮김).

261117_Liner/06_procurement_venture_probe 와 같은 엔드포인트·파라미터(공고명 서버측 부분일치, 물품/용역).
조회기간은 7일 이하만 허용된다(실측: 8일 이상은 resultCode 07). 그래서 최근 기간을 7일 구간으로 나눠 부른다.
관련성은 정렬·분류용이며 공고를 제외하는 데 쓰지 않는다.
판로 지원사업(기업마당)은 화면이 스냅샷(/data/programs.json)으로 거르므로 옮기지 않았다(계약 8.10절).

옮기며 바꾼 것: 요청 직전(재시도 포함)마다 use(datagokr.g2b)를 부르고, 동시 요청은 limits.slot 으로 묶는다.
상한에 닿은 구간은 그 자리에서 멈추고 limit 에 남긴다. 결과 행에 원래 입찰 시각(_begin, _close)을 함께 둔다.
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Callable

import httpx

from growth import common, limits

G2B = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService02/"
OPS = {"물품": "getBidPblancListInfoThngPPSSrch02", "용역": "getBidPblancListInfoServcPPSSrch02"}
CACHE_HOURS = 12
G2B_WORKERS = 6
_http = httpx.Client(timeout=30)


class MissingKey(RuntimeError):
    pass


_ASCII_WORD = re.compile(r"[a-z0-9 .+#&/\-]+")


def _hits(text: str, keywords: list[str]) -> list[str]:
    """공고명에 핵심 낱말이 들어 있는가("핵심 낱말 일치"의 근거).
    한글이 든 낱말은 띄어쓰기를 무시하고 견준다("문서 인식" = "문서인식").
    영문·숫자로만 된 낱말은 공백을 지우지 않고 견준다. 지우면 낱말 경계를 넘어 엉뚱하게 걸린다
    (실제 서버 검증에서 찾음: "single cell multiome" → "LLM", "infusion pump" → "NPU")."""
    low = re.sub(r"\s+", " ", text.lower())
    flat = low.replace(" ", "")
    out = []
    for k in keywords:
        kl = re.sub(r"\s+", " ", (k or "").lower()).strip()
        if not kl:
            continue
        if _ASCII_WORD.fullmatch(kl):
            if kl in low:
                out.append(k)
        elif kl.replace(" ", "") in flat:
            out.append(k)
    return out


def _windows(days: int, today: date) -> list[tuple[date, date]]:
    out, end = [], today
    start_all = today - timedelta(days=days - 1)
    while end >= start_all:
        s = max(start_all, end - timedelta(days=6))
        out.append((s, end))
        end = s - timedelta(days=1)
    return out


def _g2b(op: str, params: dict, *, use: Callable[[str], None] | None = None) -> list[dict]:
    ident = {"op": op, **params}
    hit = common.cache_get("g2b", ident, CACHE_HOURS)
    if hit is not None:
        return hit
    with common.key_lock("g2b", ident):
        hit = common.cache_get("g2b", ident, CACHE_HOURS)
        if hit is not None:
            return hit
        with limits.slot(limits.DATAGOKR_G2B):
            return _g2b_raw(op, params, use or (lambda api: None))


def _g2b_raw(op: str, params: dict, use: Callable[[str], None]) -> list[dict]:
    key = common.env("DATA_GO_KR_SERVICE_KEY")
    if not key:
        raise MissingKey("공공데이터 키가 설정되어 있지 않습니다")
    for attempt in range(2):
        use(limits.DATAGOKR_G2B)
        try:
            r = _http.get(G2B + op, params={**params, "serviceKey": key})
        except httpx.HTTPError as e:
            if attempt:
                raise RuntimeError(f"나라장터 네트워크 오류({type(e).__name__})") from None
            continue
        if r.status_code >= 500 and not attempt:
            continue
        try:
            data = r.json()
        except ValueError:
            raise RuntimeError(common.scrub_text(f"나라장터 응답 오류 HTTP {r.status_code}: {r.text[:120]}")) from None
        resp = data.get("response") or {}
        code = (resp.get("header") or {}).get("resultCode")
        if code != "00":
            err = data.get("nkoneps.com.response.ResponseError", {}).get("header", {}) or resp.get("header", {})
            raise RuntimeError(f"나라장터 resultCode={err.get('resultCode')} {err.get('resultMsg')}")
        items = (resp.get("body") or {}).get("items") or []
        if isinstance(items, dict):
            items = items.get("item") or []
        items = items if isinstance(items, list) else [items]
        slim = [{k: it.get(k) for k in ("bidNtceNo", "bidNtceOrd", "bidNtceNm", "ntceInsttNm", "dminsttNm", "bidNtceDt",
                                        "bidBeginDt", "bidClseDt", "opengDt", "asignBdgtAmt", "presmptPrce", "bidMethdNm",
                                        "cntrctCnclsMthdNm", "bidNtceDtlUrl", "bidNtceUrl", "prdctClsfcLmtYn", "ntceKindNm")}
                for it in items]
        common.cache_put("g2b", {"op": op, **params}, slim)
        return slim
    raise RuntimeError("나라장터 호출 실패")


def _won(v) -> str:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return ""
    if n <= 1:
        return ""
    return f"{n / 1e8:,.2f}억원" if n >= 1e8 else f"{n / 1e4:,.0f}만원"


def _bid_status(it: dict) -> str:
    def p(x):
        try:
            return datetime.strptime(x, "%Y-%m-%d %H:%M:%S") if x else None
        except ValueError:
            return None
    now = datetime.now()
    b, c = p(it.get("bidBeginDt")), p(it.get("bidClseDt"))
    if c is None:
        return "상태 확인 불가"
    if now > c:
        return "입찰 마감"
    if b and now < b:
        return "입찰 예정"
    return "입찰 진행 중"


def g2b_search(keywords: list[str], strong: list[str], *, days: int = 28, max_calls: int = 64, progress=None,
               use: Callable[[str], None] | None = None) -> dict:
    """키워드 × 물품/용역 × 7일 구간. 같은 공고는 공고번호로 한 건. 호출 수 상한을 둔다(무료지만 과도한 반복 방지)."""
    say = progress or (lambda m: None)
    today = date.today()
    wins = _windows(days, today)
    rows: dict[str, dict] = {}
    errors, skipped = [], 0
    state: dict = {"limit": None, "missing": False}
    jobs = []
    for kw in keywords:
        for kind, op in OPS.items():
            for s, e in wins:
                if len(jobs) >= max_calls:
                    skipped += 1
                    continue
                params = {"pageNo": 1, "numOfRows": 999, "type": "json", "inqryDiv": 1,
                          "inqryBgnDt": f"{s:%Y%m%d}0000", "inqryEndDt": f"{e:%Y%m%d}2359", "bidNtceNm": kw}
                jobs.append((kw, kind, op, s, e, params))

    def fetch(job):
        kw, kind, op, s, e, params = job
        if state["limit"] is not None:
            return None, f"{kw}/{kind} {s:%m%d}-{e:%m%d}: 호출 상한"
        try:
            return _g2b(op, params, use=use), None
        except MissingKey as ex:
            state["missing"] = True
            return None, f"{kw}/{kind} {s:%m%d}-{e:%m%d}: {ex}"
        except limits.LimitReached as ex:
            state["limit"] = state["limit"] or ex
            return None, f"{kw}/{kind} {s:%m%d}-{e:%m%d}: 호출 상한"
        except RuntimeError as ex:
            return None, f"{kw}/{kind} {s:%m%d}-{e:%m%d}: {ex}"
    # 조회 조건(키워드×종류×구간)은 모두 달라 중복 요청이 없다. 서로 독립이라 병렬로 부르고, 결과는 원래 순서대로 합친다
    with ThreadPoolExecutor(max_workers=G2B_WORKERS, thread_name_prefix="g2b") as pool:
        results = list(pool.map(fetch, jobs))
    calls = len(jobs)
    for (kw, kind, op, s, e, params), (items, err) in zip(jobs, results):
        if err:
            errors.append(err)
            continue
        for it in items:
            no = f"{it.get('bidNtceNo')}-{it.get('bidNtceOrd')}"
            title = it.get("bidNtceNm") or ""
            if no in rows:
                rows[no]["_kws"].add(kw)
                continue
            amt = _won(it.get("asignBdgtAmt")) or _won(it.get("presmptPrce"))
            rel = "높음" if _hits(title, strong) else "보통"
            rows[no] = {"구분": f"나라장터({kind})", "공고명": title,
                        "기관": " / ".join(dict.fromkeys(x for x in (it.get("ntceInsttNm"), it.get("dminsttNm")) if x)),
                        "분야": kind, "지원대상": "", "사업 내용": f"{it.get('bidMethdNm') or ''} · {it.get('cntrctCnclsMthdNm') or ''}",
                        "금액": amt or "공고문 확인", "기간": f"{(it.get('bidBeginDt') or '')[:16]} ~ {(it.get('bidClseDt') or '')[:16]}",
                        "마감": (it.get("bidClseDt") or "")[:10], "상태": _bid_status(it),
                        "신청조건": "물품분류 제한" if it.get("prdctClsfcLmtYn") == "Y" else "참가자격은 공고문 확인",
                        "관련성": rel, "_kws": {kw}, "링크": it.get("bidNtceDtlUrl") or it.get("bidNtceUrl") or "",
                        "_key": re.sub(r"\W", "", title)[:40], "공고일": (it.get("bidNtceDt") or "")[:10],
                        "_no": no, "_begin": (it.get("bidBeginDt") or "")[:16], "_close": (it.get("bidClseDt") or "")[:16]}
    say(f"나라장터 검색 {calls}회 완료, 공고 {len(rows)}건")
    out = []
    for r in rows.values():
        r["관련 키워드"] = ", ".join(sorted(r.pop("_kws")))
        out.append(r)
    return {"items": out, "calls": calls, "errors": errors[:10], "error_count": len(errors), "skipped": skipped,
            "period": f"{wins[-1][0]} ~ {wins[0][1]}", "limit": state["limit"], "missing_key": state["missing"]}


_STATUS = {"입찰 진행 중": "open", "입찰 예정": "upcoming", "입찰 마감": "closed"}


def bid_contract(r: dict) -> dict:
    """g2b_search 한 줄 → 계약 Bid(8.10절)."""
    n = common.none_if_empty
    return {"id": r["_no"], "title": r["공고명"], "agency": r["기관"], "kind": r["분야"] if r["분야"] in ("물품", "용역") else "물품",
            "summary": n(r["사업 내용"].strip(" ·")), "amount": r["금액"], "period": r["기간"], "bidBegin": n(r["_begin"]),
            "bidClose": n(r["_close"]), "deadline": n(r["마감"]), "status": _STATUS.get(r["상태"], "unknown"),
            "condition": r["신청조건"], "relevance": "high" if r["관련성"] == "높음" else "normal",
            "keywords": [k for k in r["관련 키워드"].split(", ") if k], "url": common.web_url(r["링크"]), "noticeDate": n(r["공고일"])}
