"""국내 특허 출원 동향(팀원의 통합 분석 프로토타입(커밋 98d8c6c)에서 옮김): Liner 웹 검색으로 공개 특허(Google Patents KR 문서) 후보를 찾고,
공개 원문에서 서지사항을 확인한다.

- Liner 공식 문서(2026-11 확인)에는 특허 전용 API·도메인 필터가 없다. 그래서 Liner Web Search 질의에 'site:patents.google.com'을
  넣어 후보를 찾는다(기업당 2회).
- 검색 결과(제목·발췌)만으로는 출원인·출원일을 알 수 없고, 다른 회사 특허가 대상 회사 특허를 '인용'한 문서도 섞인다.
  그래서 후보 KR 문서의 공개 원문(기존 fetcher: robots.txt 준수)을 열어 출원인·출원번호·출원일·공개/등록 번호·CPC·요약을 읽는다.
  원문에서 출원인이 대상 회사로 확인된 것만 '출원 특허'로 센다. 나머지(회사 이름만 언급된 문서)는 '언급 문서'로 따로 둔다.
- 확인한 특허 원문의 인용·피인용·패밀리 목록에 같은 출원인 이름으로 나온 KR 번호를 후보로 더한다(추가 Liner 호출 없음).
- 같은 출원번호(공개 A·등록 B 문서)는 한 건으로 합친다. 연도 집계는 출원일만 쓰고, 출원일이 없으면 공개·등록일로 대신하지 않는다.
검색으로 확인된 공개 특허일 뿐 전체 출원 내역이 아니다(미공개 출원·검색에 걸리지 않은 특허는 빠진다).

옮기며 바꾼 것: 원문 한 쪽을 받기 직전에 use(patents.page)를 부르고(캐시 적중은 세지 않음), 동시 요청은 limits.slot 으로 묶는다.
상한에 닿으면 원문 확인을 멈추고 limit 에 남긴다.
"""
from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Callable

import fetcher as fetcher_mod
from growth import common, limits
from growth.liner import Liner

PAGE_CACHE_HOURS = 24 * 7      # 특허 원문 서지사항은 자주 바뀌지 않는다
MAX_PAGES_PER_COMPANY = limits.PATENT_PAGES_PER_COMPANY  # 기업당 원문 확인 상한(30)
FETCH_CONCURRENCY = 4
SEARCH_RESULTS = 20
YEARS = 5
GP = "https://patents.google.com/patent/{}/ko"
KR_NO = re.compile(r"\bKR(\d{8,13})([AB]\d?)\b")
BASIS = "Liner 웹 검색으로 찾은 Google Patents 공개 문서 중 원문에서 출원인이 확인된 KR 특허"
NOTE = ("검색으로 확인된 공개 특허(Google Patents KR 문서, 출원인 원문 확인)입니다. 미공개 출원(출원 후 약 18개월)·"
        "검색에 걸리지 않은 특허는 빠지므로 전체 출원 건수가 아닙니다.")
_fx: fetcher_mod.Fetcher | None = None
_fx_lock = threading.Lock()


def _fetcher() -> fetcher_mod.Fetcher:
    global _fx
    with _fx_lock:
        if _fx is None:
            _fx = fetcher_mod.Fetcher(max_pages=10 ** 6)  # 상한은 기업별로 이 모듈이 센다
        return _fx


# ---------------- 원문 파싱 ----------------
def fmt_app_no(raw: str) -> str:
    """KR1020230179893A → 10-2023-0179893. 형식이 다르면 원문 그대로."""
    m = re.fullmatch(r"KR(\d{2})(\d{4})(\d{7})[A-Z]?\d?", raw or "")
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else (raw or "")


def parse_page(text: str, title: str, pub_no: str) -> dict:
    """Google Patents 원문 텍스트 → 서지사항. 원문에 없는 값은 빈 문자열."""
    t = re.sub(r"[ \t]+", " ", text)
    flat = t.replace("\n", " ")
    head = flat[:6000]  # 서지 정보는 앞부분에 있다(뒤쪽 인용 목록의 다른 특허 값과 섞이지 않게)
    m = re.search(r"Application number (KR\d{10,13}[A-Z]?)", head)
    app_raw = m.group(1) if m else ""
    m = re.search(r"Original Assignee (.{2,80}?) (?:Current Assignee|Priority date|Inventor|Filing date|Application filed|Publication date|Status|Info)\b", head)
    assignee = (m.group(1).strip() if m else "")
    m = re.search(r"Application filed by (.+?) filed Critical", head)
    filed_by = m.group(1).strip() if m else ""
    m = re.search(r"Filing date (\d{4}-\d{2}-\d{2})", head)
    filing = m.group(1) if m else ""
    events = re.findall(r"(\d{4}-\d{2}-\d{2}) Publication of (KR\w+)", head)
    pubs = [{"no": n, "date": d} for d, n in events]
    unexam = next((p for p in pubs if re.search(r"A\d?$", p["no"])), None)
    grant = next((p for p in pubs if re.search(r"B\d?$", p["no"])), None)
    m = re.search(r"Status (\w+)", head)
    status = m.group(1) if m else ""
    name = re.sub(r"\s*-\s*Google Patents\s*$", "", (title or "").strip())
    name = re.sub(r"^KR\w+\s*-\s*", "", name).strip()
    abstract = ""
    m = re.search(r"\bAbstract\s+(.{20,900}?)(?:\s+Description|\s+Claims|\s+Images|$)", flat)
    if m:
        abstract = m.group(1).strip()
    cls_sec = flat[flat.find("Classifications"): flat.find("Classifications") + 3000] if "Classifications" in flat else ""
    cpc = list(dict.fromkeys(re.findall(r"\b([A-HY]\d{2}[A-Z]\s?\d{1,4}/\d{2,6})\b", cls_sec)))[:8]
    fields = list(dict.fromkeys(f"{a} {b.strip()}" for a, b in re.findall(r"\b([A-H]\d{2}[A-Z]) — ([^|]{3,80}?)(?= [A-H]\d{2}[A-Z]?\d|\s{2}|$)", cls_sec)))[:3]
    # 출원인: 'Application filed by' 표기를 우선(Original Assignee 는 뒤 문구가 붙어 읽히는 경우가 있음)
    return {"pub_no": pub_no, "title": name, "assignee": filed_by or assignee, "filed_by": filed_by, "application_no_raw": app_raw,
            "application_no": fmt_app_no(app_raw), "filing_date": filing,
            "publication_no": unexam["no"] if unexam else "", "publication_date": unexam["date"] if unexam else "",
            "registration_no": grant["no"] if grant else "", "registration_date": grant["date"] if grant else "",
            "status": status, "cpc": cpc, "tech_fields": fields, "abstract": abstract[:600], "url": GP.format(pub_no)}


def harvest(text: str, tokens: list[str]) -> list[str]:
    """같은 출원인 특허 후보 KR 번호: ① 대상 회사 이름이 들어간 줄(인용·피인용 목록) ② 'Family Applications'·'Also Published As' 구간.

    후보일 뿐이며, 각 후보는 자기 원문에서 출원인을 다시 확인한 뒤에만 출원 특허로 센다.
    """
    out = []
    for line in re.split(r"\n|\s\|\s", text or ""):
        if any(t in common.norm_name(line) for t in tokens):
            out += [f"KR{a}{b}" for a, b in KR_NO.findall(line)]
    t = text or ""
    for start, end in (("Family Applications", "Country Status"), ("Also Published As", "Similar Documents")):
        i = t.find(start)
        if i >= 0:
            j = t.find(end, i)
            out += [f"KR{a}{b}" for a, b in KR_NO.findall(t[i: j if j > i else i + 4000])]
    return list(dict.fromkeys(out))


def is_applicant(p: dict, tokens: list[str]) -> bool:
    who = common.norm_name(f"{p.get('assignee') or ''} {p.get('filed_by') or ''}")
    return bool(who) and any(t and t in who for t in tokens)


def fetch_patent(pub_no: str, *, use: Callable[[str], None] | None = None) -> dict | None:
    """KR 특허 원문 1건(캐시 7일, 같은 번호 동시 요청은 한 번만). 실패하면 None. 상한에 닿으면 LimitReached."""
    ident = {"pub": pub_no}
    hit = common.cache_get("patent_page", ident, PAGE_CACHE_HOURS)
    if hit is not None:
        return hit
    with common.key_lock("patent_page", ident):
        hit = common.cache_get("patent_page", ident, PAGE_CACHE_HOURS)
        if hit is not None:
            return hit
        with limits.slot(limits.PATENTS_PAGE):
            if use:
                use(limits.PATENTS_PAGE)
            rec = _fetcher().fetch(GP.format(pub_no))
        if not rec.get("ok"):
            return None
        out = parse_page(rec.get("text") or "", rec.get("title") or "", pub_no)
        out["_harvest_text"] = (rec.get("text") or "")[:120000]
        common.cache_put("patent_page", ident, out)
        return out


# ---------------- 기업 단위 ----------------
def queries(co: dict) -> list[tuple[str, str, str]]:
    name = co["name"]
    reg = co.get("registered") or name
    return [(f'site:patents.google.com "주식회사 {reg}"', "ko", "kr"), (f"site:patents.google.com {name} 특허 출원", "ko", "kr")]


def company_patents(liner: Liner, co: dict, *, max_pages: int = MAX_PAGES_PER_COMPANY,
                    use: Callable[[str], None] | None = None) -> dict:
    """기업 한 곳: Liner 검색 2회 → 후보 KR 문서 원문 확인(상한 max_pages) → 출원인 일치 특허·언급 문서 분리."""
    t0 = time.perf_counter()
    tokens = [t for t in dict.fromkeys(common.norm_name(n) for n in co["names"]) if len(t) >= 2]
    out = {"company": co["name"], "self": co.get("self", False), "patents": [], "mentions": [], "searches": [], "pages_checked": 0,
           "errors": [], "basis": BASIS, "limit": None, "search_ok": 0}
    cands: list[str] = []
    for q, lang, cc in queries(co):
        fails0 = liner.failures
        rs = liner.search(q, lang=lang, country=cc, max_results=SEARCH_RESULTS, label="patent_search")
        out["searches"].append({"query": q, "results": len(rs)})
        if liner.failures == fails0 and liner.limit is None:
            out["search_ok"] += 1
        for r in rs:
            u = str(r.get("url") or "")
            m = re.search(r"patents\.google\.com/patent/(KR\d{8,13}[AB]\d?)", u)
            if m:
                cands.append(m.group(1))
            cands += harvest(f"{r.get('title') or ''}\n{r.get('description') or ''}", tokens)
    queue = list(dict.fromkeys(cands))
    seen: set[str] = set()
    by_app: dict[str, dict] = {}
    mentions: list[dict] = []

    def one(n: str) -> dict | None:
        if out["limit"] is not None:
            return None
        try:
            return fetch_patent(n, use=use)
        except limits.LimitReached as e:
            out["limit"] = out["limit"] or e
            return None

    while queue and len(seen) < max_pages and out["limit"] is None:
        batch = []
        while queue and len(seen) + len(batch) < max_pages:
            n = queue.pop(0)
            if n not in seen and n not in batch:
                batch.append(n)
        seen.update(batch)
        with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY, thread_name_prefix="patent") as ex:
            pages = list(ex.map(one, batch))
        for n, p in zip(batch, pages):
            if not p:
                continue
            if not is_applicant(p, tokens):
                # 기업명이 본문·인용 목록에만 나온 다른 출원인 문서. 원문에 기업명이 실제로 있는 것만 '언급 문서'로 남긴다
                if any(t in common.norm_name(p.get("_harvest_text") or "") for t in tokens):
                    mentions.append({k: p.get(k) for k in ("pub_no", "title", "assignee", "filing_date", "url")})
                continue
            key = p.get("application_no_raw") or p["pub_no"]
            cur = by_app.get(key)
            if cur is None:
                by_app[key] = {k: v for k, v in p.items() if not k.startswith("_")}
            else:  # 같은 출원의 공개(A)·등록(B) 문서: 빈 값만 채운다
                for k, v in p.items():
                    if not k.startswith("_") and v and not cur.get(k):
                        cur[k] = v
            # 같은 출원인의 다른 특허 후보(인용·패밀리 목록)
            queue += [x for x in harvest(p.get("_harvest_text") or "", tokens) if x not in seen and x not in queue]
    out["pages_checked"] = len(seen)
    out["candidates_left"] = len(queue)
    pats = sorted(by_app.values(), key=lambda p: p.get("filing_date") or "", reverse=True)
    for p in pats:
        p["company"] = co["name"]
    out["patents"] = pats
    out["mentions"] = mentions
    out["summary"] = summarize(pats)
    out["sec"] = round(time.perf_counter() - t0, 2)
    return out


def summarize(pats: list[dict]) -> dict:
    this = date.today().year
    by_year: dict[int, int] = {}
    for p in pats:
        y = (p.get("filing_date") or "")[:4]
        if y.isdigit():
            by_year[int(y)] = by_year.get(int(y), 0) + 1
    fields: dict[str, int] = {}
    for p in pats:
        for f in p.get("tech_fields") or [p["cpc"][0][:4]] if p.get("cpc") or p.get("tech_fields") else []:
            fields[f] = fields.get(f, 0) + 1
    return {"total": len(pats), "with_filing_date": sum(by_year.values()), "no_filing_date": len(pats) - sum(by_year.values()),
            "by_year": by_year, "recent5": sum(v for y, v in by_year.items() if y > this - YEARS),
            "registered": sum(1 for p in pats if p.get("registration_no")),
            "top_fields": [k for k, _ in sorted(fields.items(), key=lambda kv: -kv[1])[:3]]}


def entry(name: str, name_en: str = "", *, registered: str = "", aliases: list[str] | None = None, is_self: bool = False) -> dict:
    """특허 검색 대상 기업. 영문명은 KR 출원인 표기와 거의 맞지 않아 매칭 이름에서 뺀다(오탐 방지): 한글명·등기 상호·한글 별칭만."""
    ko = [n for n in dict.fromkeys([name, registered, *(aliases or [])]) if n and re.search(r"[가-힣]", n)]
    names = [re.sub(r"주식회사|\(주\)|㈜", "", n).strip() for n in ko] or [name]
    return {"name": name, "name_en": name_en, "registered": re.sub(r"주식회사|\(주\)|㈜", "", registered or "").strip() or name,
            "names": [n for n in dict.fromkeys(names) if len(n) >= 2], "self": is_self}


def summary_contract(s: dict) -> dict:
    """summarize() → 계약 PatentSummary(연도 키는 'YYYY' 글)."""
    return {"total": s["total"], "registered": s["registered"], "recent5": s["recent5"],
            "byYear": {str(y): n for y, n in sorted(s["by_year"].items())}, "withFilingDate": s["with_filing_date"],
            "noFilingDate": s["no_filing_date"]}
