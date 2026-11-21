"""공공 API(기업마당 지원사업정보, 한국벤처투자 펀드현황)를 받아 웹 화면용 스냅샷으로 정리한다.

실행: python3 scripts/fetch_public_data.py
필요: 저장소 루트 .env 의 BIZINFO_API_KEY, KVIC_API_KEY (키는 출력·저장하지 않는다)
출력: web/public/data/programs.json, funds.json, meta.json (화면이 정적 파일로 읽는다)

두 API 모두 무료다. 응답에 없는 값은 만들지 않고 비워 둔다.
"""
from __future__ import annotations

import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "data"
BIZINFO_URL = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do"
KVIC_URL = "https://www.kvic.or.kr/api/fundType"
REGIONS = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원",
           "충북", "충남", "전북", "전남", "경북", "경남", "제주", "전남광주"]
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
DATE_RANGE = re.compile(r"^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$")


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get_json(url: str, params: dict, secret: str) -> dict:
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}",
                                 headers={"User-Agent": "funding-note/0.1", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {url}") from None
    except Exception as e:  # 키가 URL 에 있으므로 원래 예외 메시지를 그대로 내보내지 않는다
        raise SystemExit(f"{type(e).__name__}: {url}") from None
    try:
        return json.loads(raw)
    except ValueError:
        raise SystemExit(f"JSON 이 아닌 응답: {url} · {raw.replace(secret, '***')[:200]}") from None


HOSTLIKE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}([/?#].*)?$")


def safe_url(value) -> str:
    """화면에서 링크로 쓸 주소만 남긴다. http·https 가 아니면 버리고, 'www.example.kr' 처럼 스킴만 빠진 주소는 https 를 붙인다."""
    v = str(value or "").strip()
    if not v or any(c.isspace() for c in v):
        return ""
    if v.lower().startswith(("http://", "https://")):
        return v
    return f"https://{v}" if HOSTLIKE.match(v) else ""


def clean_text(s: str | None) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s).replace("\xa0", " ")).strip()


def split_summary(raw: str | None) -> tuple[str, list[str]]:
    """사업개요를 머리말과 '☞' 항목으로 나눈다. 항목은 보통 지원대상, 지원내용 순서다."""
    parts = [p.strip() for p in clean_text(raw).split("☞")]
    points = [p[:220] for p in parts[1:] if p][:4]
    # 머리말은 대부분 공고 인사말이라 항목이 없을 때만 남긴다
    return ("" if points else parts[0][:300]), points


LOCAL_AGENCY = {
    "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구", "인천광역시": "인천", "광주광역시": "광주",
    "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종", "경기도": "경기", "강원특별자치도": "강원",
    "충청북도": "충북", "충청남도": "충남", "전북특별자치도": "전북", "전라남도": "전남", "경상북도": "경북",
    "경상남도": "경남", "제주특별자치도": "제주", "전남광주통합특별시": "전남광주",
}


def program_regions(title: str, tags: list[str], agency: str) -> list[str]:
    """제목 머리표, 해시태그, 소관기관 순으로 지역을 정한다. 어느 것으로도 좁혀지지 않으면 전국으로 둔다."""
    m = re.match(r"^\[([^\]]+)\]", title)
    if m and m.group(1) in REGIONS:
        return [m.group(1)]
    found = [t for t in tags if t in REGIONS]
    if len(found) >= 15:
        return ["전국"]
    if found:
        return found
    # 지역 태그가 없는 지방자치단체 공고는 그 지역 공고로 본다
    return [LOCAL_AGENCY[agency]] if agency in LOCAL_AGENCY else ["전국"]


def period(raw: str, today: date) -> dict:
    raw = (raw or "").strip()
    m = DATE_RANGE.match(raw)
    if not m:
        return {"raw": raw, "start": None, "end": None, "status": "수시" if raw else "미기재"}
    start, end = m.group(1), m.group(2)
    if date.fromisoformat(start) > today:
        status = "접수 예정"
    elif date.fromisoformat(end) < today:
        status = "마감"
    else:
        status = "접수 중"
    return {"raw": raw, "start": start, "end": end, "status": status}


def fetch_programs(key: str, today: date) -> list[dict]:
    rows: list[dict] = []
    page = 1
    while True:
        data = get_json(BIZINFO_URL, {"crtfcKey": key, "dataType": "json", "pageUnit": 100, "pageIndex": page}, key)
        if data.get("reqErr"):
            raise SystemExit(f"기업마당 오류: {data['reqErr']}")
        arr = data.get("jsonArray") or []
        if not arr:
            break
        rows.extend(arr)
        if len(rows) >= int(arr[0].get("totCnt") or 0) or page >= 50:
            break
        page += 1
    out = []
    for x in rows:
        title = clean_text(x.get("pblancNm"))
        tags = [t.strip() for t in str(x.get("hashtags") or "").split(",") if t.strip()]
        intro, points = split_summary(x.get("bsnsSumryCn"))
        contact = re.sub(r"\s*,\s*$", "", re.sub(r"\s+", " ", EMAIL.sub("", clean_text(x.get("refrncNm")))).strip())
        out.append({
            "id": x.get("pblancId"),
            "title": title,
            "category": x.get("pldirSportRealmLclasCodeNm") or "",
            "sub": x.get("pldirSportRealmMlsfcCodeNm") or "",
            "target": x.get("trgetNm") or "",
            "agency": x.get("jrsdInsttNm") or "",
            "operator": x.get("excInsttNm") or "",
            "regions": program_regions(title, tags, str(x.get("jrsdInsttNm") or "")),
            # 지방자치단체 공고인데 전 지역 태그가 붙은 경우가 있어, 화면에서 확인 항목으로 알리기 위해 남긴다
            "agencyRegion": LOCAL_AGENCY.get(str(x.get("jrsdInsttNm") or "")),
            "period": period(str(x.get("reqstBeginEndDe") or ""), today),
            "intro": intro,
            "points": points,
            "tags": [t for t in tags if t not in REGIONS][:12],
            "url": safe_url(x.get("pblancUrl")),
            "applyUrl": safe_url(x.get("rceptEngnHmpgUrl")),
            "applyMethod": clean_text(x.get("reqstMthPapersCn"))[:120],
            "contact": contact[:120],
            "docUrl": safe_url(x.get("printFlpthNm")),
            "created": str(x.get("creatPnttm") or "")[:10],
        })
    return [p for p in out if p["id"] and p["period"]["status"] != "마감"]


def fetch_funds(key: str, today: date) -> tuple[list[dict], dict]:
    data = get_json(KVIC_URL, {"fundType": 7, "of": 1, "key": key}, key)
    rows = data.get("result_7") or []
    if not rows:
        raise SystemExit(f"한국벤처투자 응답에 자료가 없습니다(code={data.get('code')})")
    out = []
    for r in rows:
        exp = str(r.get("exp") or "")
        year = re.sub(r"\D", "", str(r.get("year") or ""))
        ca = str(r.get("ca") or "").replace(",", "")
        out.append({
            "name": clean_text(r.get("asn")),
            "gp": clean_text(r.get("mng")),
            "field": clean_text(r.get("fd")),
            "year": int(year) if year else None,
            "maturity": exp or None,
            # API 의 약정액(ca) 원값. 단위와 기준(펀드 총액인지 모태 약정액인지)은 문서에 없어 화면에서 주석과 함께 보여준다.
            "commitRaw": int(float(ca)) if re.fullmatch(r"\d+(\.\d+)?", ca) else None,
        })
    alive = [f for f in out if f["maturity"] and f["maturity"] >= today.isoformat()]
    direct = [f for f in alive if f["gp"] != "한국벤처투자"]
    stats = {"total": len(out), "beforeMaturity": len(alive), "listed": len(direct),
             "latestYear": max((f["year"] for f in out if f["year"]), default=None)}
    return direct, stats


def main() -> None:
    env = load_env(ROOT / ".env")
    biz, kvic = env.get("BIZINFO_API_KEY", ""), env.get("KVIC_API_KEY", "")
    if not biz or not kvic:
        raise SystemExit("저장소 루트 .env 에 BIZINFO_API_KEY, KVIC_API_KEY 가 필요합니다.")
    today = date.today()
    programs = fetch_programs(biz, today)
    funds, fund_stats = fetch_funds(kvic, today)
    by_cat: dict[str, int] = {}
    for p in programs:
        by_cat[p["category"]] = by_cat.get(p["category"], 0) + 1
    meta = {
        "fetchedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "asOf": today.isoformat(),
        "programs": {"total": len(programs), "byCategory": by_cat, "source": "기업마당 지원사업정보 API"},
        "funds": {**fund_stats, "source": "한국벤처투자 펀드현황 Open API(한국모태펀드 자펀드)"},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for name, obj in (("programs.json", programs), ("funds.json", funds), ("meta.json", meta)):
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) if name != "meta.json" else json.dumps(obj, ensure_ascii=False, indent=2)
        if biz in text or kvic in text:
            raise SystemExit(f"{name} 에 키 값이 포함되어 저장을 중단합니다.")
        (OUT / name).write_text(text + "\n", encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print(e.code, file=sys.stderr)
            sys.exit(1)
