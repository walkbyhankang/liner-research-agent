"""정부지원사업(기업마당) + 나라장터 입찰공고.

- 기업마당: 펀딩노트가 쓰는 스냅샷(web/public/data/programs.json, scripts/fetch_public_data.py 가 공공 API에서 생성)을
  그대로 읽는다. 추가 호출 없음. 스냅샷에는 마감 지난 공고가 없으므로 현재 모집·예정·수시 공고가 대상이다.
- 나라장터: 261117_Liner/06_procurement_venture_probe 와 같은 엔드포인트·파라미터(공고명 서버측 부분일치, 물품/용역).
  조회기간은 7일 이하만 허용된다(실측: 8일 이상은 resultCode 07). 그래서 최근 기간을 7일 구간으로 나눠 부른다.
관련성은 정렬·분류용이며 공고를 제외하는 데 쓰지 않는다.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx

import config
from research import common

PROGRAMS = config.BASE_DIR / "web" / "public" / "data" / "programs.json"
G2B = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService02/"
OPS = {"물품": "getBidPblancListInfoThngPPSSrch02", "용역": "getBidPblancListInfoServcPPSSrch02"}
CACHE_HOURS = 12
G2B_WORKERS = 6
_http = httpx.Client(timeout=30)


def load_programs() -> tuple[list[dict], str]:
    if not PROGRAMS.is_file():
        return [], ""
    meta = PROGRAMS.parent / "meta.json"
    as_of = json.loads(meta.read_text(encoding="utf-8")).get("asOf", "") if meta.is_file() else ""
    return json.loads(PROGRAMS.read_text(encoding="utf-8")), as_of


def _hits(text: str, keywords: list[str]) -> list[str]:
    low = text.lower()
    return [k for k in keywords if k and k.lower().replace(" ", "") in low.replace(" ", "")]


def match_programs(keywords: list[str], broad: list[str], today: date | None = None) -> list[dict]:
    """기업마당 공고 중 기술·인접 키워드가 제목·요약·태그에 들어간 것. 관련성 높음(제목) > 보통(본문) > 참고(인접어)."""
    today = today or date.today()
    progs, _ = load_programs()
    out = []
    for p in progs:
        end = (p.get("period") or {}).get("end")
        if end and end < today.isoformat():
            continue
        title = p.get("title") or ""
        body = " ".join([p.get("intro") or "", " ".join(p.get("points") or []), " ".join(p.get("tags") or [])])
        t_hits, b_hits, a_hits = _hits(title, keywords), _hits(body, keywords), _hits(f"{title} {body}", broad)
        if not (t_hits or b_hits or a_hits):
            continue
        rel = "높음" if t_hits else "보통" if b_hits else "참고"
        per = p.get("period") or {}
        status = per.get("status") or ""
        if per.get("start") and per.get("start") > today.isoformat():
            status = "접수 예정"
        out.append({"구분": "정부지원사업", "공고명": title, "기관": " / ".join(x for x in (p.get("agency"), p.get("operator")) if x),
                    "분야": f"{p.get('category') or ''}·{p.get('sub') or ''}", "지원대상": p.get("target") or "",
                    "사업 내용": " / ".join(p.get("points") or []) or p.get("intro") or "", "금액": "공고문 확인",
                    "기간": per.get("raw") or "", "마감": per.get("end") or "", "상태": status,
                    "신청조건": f"지원대상 {p.get('target') or '-'}, 지역 {', '.join(p.get('regions') or [])}",
                    "관련성": rel, "관련 키워드": ", ".join(dict.fromkeys(t_hits + b_hits + a_hits)),
                    "링크": p.get("url") or "", "_key": re.sub(r"\W", "", title)[:40]})
    return out


def _windows(days: int, today: date) -> list[tuple[date, date]]:
    out, end = [], today
    start_all = today - timedelta(days=days - 1)
    while end >= start_all:
        s = max(start_all, end - timedelta(days=6))
        out.append((s, end))
        end = s - timedelta(days=1)
    return out


def _g2b(op: str, params: dict) -> list[dict]:
    hit = common.cache_get("g2b", {"op": op, **params}, CACHE_HOURS)
    if hit is not None:
        return hit
    with common.key_lock("g2b", {"op": op, **params}):
        hit = common.cache_get("g2b", {"op": op, **params}, CACHE_HOURS)
        if hit is not None:
            return hit
        with common.limit("data_go_kr"):
            return _g2b_raw(op, params)


def _g2b_raw(op: str, params: dict) -> list[dict]:
    key = common.env("DATA_GO_KR_SERVICE_KEY")
    if not key:
        raise RuntimeError("DATA_GO_KR_SERVICE_KEY 가 .env 에 없습니다")
    for attempt in range(2):
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


def g2b_search(keywords: list[str], strong: list[str], *, days: int = 28, max_calls: int = 64, progress=None) -> dict:
    """키워드 × 물품/용역 × 7일 구간. 같은 공고는 공고번호로 한 건. 호출 수 상한을 둔다(무료지만 과도한 반복 방지)."""
    say = progress or (lambda m: None)
    today = date.today()
    wins = _windows(days, today)
    rows: dict[str, dict] = {}
    calls, errors, skipped = 0, [], 0
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
        try:
            return _g2b(op, params), None
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
                        "_key": re.sub(r"\W", "", title)[:40], "공고일": (it.get("bidNtceDt") or "")[:10]}
    say(f"나라장터 검색 {calls}회 완료, 공고 {len(rows)}건")
    out = []
    for r in rows.values():
        r["관련 키워드"] = ", ".join(sorted(r.pop("_kws")))
        out.append(r)
    return {"items": out, "calls": calls, "errors": errors[:10], "error_count": len(errors), "skipped": skipped,
            "period": f"{wins[-1][0]} ~ {wins[0][1]}"}


STATUS_ORDER = {"접수 중": 0, "입찰 진행 중": 0, "접수 예정": 1, "입찰 예정": 1, "수시": 2, "미기재": 3, "상태 확인 불가": 3, "입찰 마감": 4}
REL_ORDER = {"높음": 0, "보통": 1, "참고": 2}


def merge_sort(*lists: list[dict]) -> list[dict]:
    """같은 사업이 여러 소스에 있으면(제목 정규화 일치) 한 건으로. 모집 중 → 관련성 → 마감 임박 순."""
    seen: dict[str, dict] = {}
    for lst in lists:
        for r in lst:
            k = r.get("_key") or r["공고명"]
            if k in seen:
                if r["구분"] not in seen[k]["구분"]:
                    seen[k]["구분"] += f" + {r['구분']}"
                continue
            seen[k] = dict(r)
    out = list(seen.values())
    out.sort(key=lambda r: (STATUS_ORDER.get(r["상태"], 3), REL_ORDER.get(r["관련성"], 3), r.get("마감") or "9999"))
    for r in out:
        r.pop("_key", None)
    return out
