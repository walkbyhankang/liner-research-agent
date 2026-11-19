"""검색 결과 전처리: URL 정규화, 중복 제거, 기업 식별(유사 상호 제외), 출처 유형/신뢰도, 동일 사건 묶기."""
from __future__ import annotations

import re
from datetime import date, datetime
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

TRACKING_PARAMS = {"fbclid", "gclid", "srsltid", "ref", "spm", "igshid"}
# 회사명 뒤에 붙으면 별개 법인일 가능성이 큰 접미어 (예: 당근푸드, 당근건설)
CONFUSABLE_SUFFIXES = ("푸드", "식품", "산업", "건설", "전자", "유통", "물산", "제약", "약품", "농장", "축산",
                       "공업", "상사", "무역", "에너지", "화학", "금속", "인쇄", "여행사", "학원")

GOV_HOST_HINTS = (".go.kr", ".gov", ".gov.", "kised.or.kr", "k-startup.go.kr", "nipa.kr", "iitp.kr", "keit.re.kr",
                  "ntis.go.kr", "g2b.go.kr", "kosmes.or.kr", "kodit.co.kr", "kotra.or.kr", "kibo.or.kr",
                  "smtech.go.kr", "bizinfo.go.kr", "sba.seoul.kr", "kstartup.go.kr")
DISCLOSURE_HOSTS = ("dart.fss.or.kr", "kind.krx.co.kr", "sec.gov", "opendart.fss.or.kr")
DATABASE_HOSTS = ("thevc.kr", "rocketpunch.com", "innoforest.co.kr", "wikipedia.org", "namu.wiki", "crunchbase.com",
                  "pitchbook.com", "saramin.co.kr", "jobplanet.co.kr", "jobkorea.co.kr", "catch.co.kr",
                  "app.rndcircle.io", "nicebizinfo.com", "kreditjob.com", "wanted.co.kr", "linkedin.com",
                  "smes.go.kr", "venturesquare.net")
NEWS_HOSTS = ("chosun.com", "joongang.co.kr", "donga.com", "hani.co.kr", "khan.co.kr", "mk.co.kr", "hankyung.com",
              "sedaily.com", "edaily.co.kr", "etnews.com", "zdnet.co.kr", "platum.kr", "dealsite.co.kr", "bloter.net",
              "yna.co.kr", "newsis.com", "news1.kr", "mt.co.kr", "fnnews.com", "inews24.com", "topdaily.kr",
              "techcrunch.com", "reuters.com", "bloomberg.com", "thebell.co.kr", "outstanding.kr", "byline.network",
              "venturesquare.net", "biz.chosun.com", "heraldcorp.com", "asiae.co.kr", "ytn.co.kr", "sbs.co.kr",
              "kbs.co.kr", "mbc.co.kr", "ajunews.com", "m-i.kr", "apparelnews.co.kr", "dt.co.kr")
VC_HOSTS = ("altos.vc", "kakaoventures.com", "softbank.com", "strongventures.com", "sequoiacap.com", "a16z.com")
COMMUNITY_HINTS = ("blog.naver.com", "tistory.com", "brunch.co.kr", "cafe.naver.com", "velog.io", "medium.com",
                   "post.naver.com", "daangn.com/kr/local-profile", "youtube.com", "reddit.com", "namu.wiki")

TRUST = {"official": 1.0, "government": 0.95, "disclosure": 0.95, "news": 0.7, "vc": 0.7,
         "database": 0.55, "other": 0.4, "community": 0.25}
# 원문 확인 우선순위(작을수록 먼저)
FETCH_PRIORITY = {"official": 0, "government": 1, "disclosure": 2, "news": 3, "vc": 4, "database": 5,
                  "other": 6, "community": 7}


def norm_host(url: str) -> str:
    try:
        h = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    return re.sub(r"^(www|m|mobile)\.", "", h)


def normalize_url(url: str) -> str:
    """중복 판정용 URL 키: 호스트 정규화, 추적 파라미터/프래그먼트/말미 슬래시 제거."""
    try:
        p = urlparse((url or "").strip())
    except ValueError:
        return (url or "").strip()
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
         if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS]
    path = p.path.rstrip("/") or "/"
    return urlunparse(("https", norm_host(url), path, "", urlencode(q), ""))


def classify_source(url: str, official_hosts: list[str] | None = None) -> str:
    host = norm_host(url)
    full = (url or "").lower()
    for oh in official_hosts or []:
        oh = norm_host(oh if "//" in oh else "https://" + oh)
        if oh and (host == oh or host.endswith("." + oh)):
            return "official"
    if any(h in host or h in full for h in COMMUNITY_HINTS if h not in ("namu.wiki",)):
        return "community"
    if any(host == d or host.endswith("." + d) for d in DISCLOSURE_HOSTS):
        return "disclosure"
    if host.endswith(".go.kr") or host.endswith(".gov") or ".gov." in host or any(
            host == g or host.endswith("." + g) for g in GOV_HOST_HINTS if not g.startswith(".")):
        return "government"
    if any(host == d or host.endswith("." + d) for d in VC_HOSTS):
        return "vc"
    if any(host == d or host.endswith("." + d) for d in NEWS_HOSTS):
        return "news"
    if any(host == d or host.endswith("." + d) for d in DATABASE_HOSTS):
        return "database"
    return "other"


# ---------- 기업 식별 ----------
def _compact(s: str) -> str:
    return re.sub(r"\s+", "", (s or "").lower())


def build_identity(company: str, hints: dict | None = None, profile_results: list[dict] | None = None) -> dict:
    """회사명/별칭/제외 상호/공식 도메인을 정리한다. 별칭은 사용자 힌트 + 검색결과의 '주식회사 X' 표기에서 얻는다."""
    hints = hints or {}
    names = [company.strip()]
    for a in re.split(r"[,/;]", hints.get("aliases") or ""):
        if a.strip():
            names.append(a.strip())
    for r in profile_results or []:
        txt = f"{r.get('title') or ''} {r.get('description') or ''}"
        for m in re.finditer(r"(?:주식회사|\(주\)|㈜)\s*([가-힣A-Za-z0-9]{2,20})", txt):
            n = m.group(1)
            if _compact(company) in _compact(n) or _compact(n) in _compact(company):
                names.append(n)
    seen, uniq = set(), []
    for n in names:
        if _compact(n) not in seen:
            seen.add(_compact(n))
            uniq.append(n)
    excl = [e.strip() for e in re.split(r"[,/;]", hints.get("exclude") or "") if e.strip()]
    home = (hints.get("homepage") or "").strip()
    return {"company": company.strip(), "names": uniq, "exclude_names": excl,
            "official_hosts": [norm_host(home if "//" in home else "https://" + home)] if home else [],
            "legal_name": hints.get("legal_name") or "", "english_name": hints.get("english_name") or "",
            "founded_year": hints.get("founded_year") or None, "industry": hints.get("industry") or "",
            "size": hints.get("size") or ""}


def relevance(title: str, description: str, url: str, identity: dict) -> tuple[float, str]:
    """(관련도 0~1, 제외 사유). 0이면 제외. 당근푸드처럼 접미어가 붙은 유사 상호는 제외한다."""
    text = f"{title or ''} {description or ''}"
    low = text.lower()
    for ex in identity.get("exclude_names", []):
        if ex and ex.lower() in low:
            return 0.0, f"제외 상호 '{ex}' 언급"
    names = [n for n in identity.get("names", []) if len(n) >= 2]
    cleaned = low
    similar = None
    for n in names:
        for m in re.finditer(re.escape(n.lower()) + r"(" + "|".join(CONFUSABLE_SUFFIXES) + r")", cleaned):
            full = m.group(0)
            if not any(full == k.lower() or k.lower().startswith(full) for k in names):
                similar = similar or full
        cleaned = re.sub(re.escape(n.lower()) + r"(" + "|".join(CONFUSABLE_SUFFIXES) + r")", " ", cleaned)
    title_l = (title or "").lower()
    in_title = any(n.lower() in re.sub(re.escape(n.lower()) + r"(" + "|".join(CONFUSABLE_SUFFIXES) + r")", " ",
                                       title_l) for n in names)
    in_text = any(n.lower() in cleaned for n in names)
    in_host = any(re.sub(r"[^a-z0-9]", "", n.lower()) and re.sub(r"[^a-z0-9]", "", n.lower()) in norm_host(url)
                  for n in names)
    if in_title:
        return 1.0, ""
    if in_text or in_host:
        return 0.6, ""
    if similar:
        return 0.0, f"유사 상호 의심('{similar}')"
    return 0.0, "분석대상 기업명 미언급"


def parse_date(s) -> date | None:
    if not s:
        return None
    if isinstance(s, (date, datetime)):
        return s.date() if isinstance(s, datetime) else s
    m = re.search(r"(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})", str(s))
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    m = re.search(r"(\d{4})[-./년\s]+(\d{1,2})", str(s))
    if m:
        try:
            return date(int(m[1]), int(m[2]), 1)
        except ValueError:
            return None
    return None


def title_key(title: str) -> str:
    t = re.sub(r"\s*[-|·–]\s*[^-|·–]{2,20}$", "", title or "")  # 말미 언론사 표기 제거
    return re.sub(r"[^0-9a-z가-힣]", "", t.lower())


def _tokens(title: str) -> set[str]:
    return {t for t in re.findall(r"[0-9a-z가-힣]{2,}", (title or "").lower())}


def similar_titles(a: str, b: str, thr: float = 0.7) -> bool:
    ka, kb = title_key(a), title_key(b)
    if ka and ka == kb:
        return True
    ta, tb = _tokens(a), _tokens(b)
    return bool(ta and tb) and len(ta & tb) / len(ta | tb) >= thr


def build_sources(search_runs: list[dict], agent_refs: list[dict], identity: dict) -> list[dict]:
    """모든 검색/Agent 결과를 URL 기준 단일 레코드로 병합한다.

    search_runs: [{"key","category","topic","query","results":[...]}]
    반환: 관련성·신뢰도·출처 유형·검색어별 출처를 보존한 소스 목록(제외 항목도 사유와 함께 유지).
    """
    by_url: dict[str, dict] = {}

    def add(r: dict, origin: str, key: str, category: str, query: str, rank: int, market: bool = False) -> None:
        url = r.get("url")
        if not url:
            return
        nk = normalize_url(url)
        rel, why = relevance(r.get("title"), r.get("description"), url, identity)
        if market and rel == 0.0 and why == "분석대상 기업명 미언급":  # 시장 공통 공고·VC 탐색: 기업명 없어도 유효(유사 상호 제외는 유지)
            rel, why = 0.5, ""
        rec = by_url.get(nk)
        if rec is None:
            rec = {"url": url, "url_key": nk, "title": r.get("title") or "", "description": r.get("description") or "",
                   "date": r.get("date"), "hostname": r.get("hostname") or norm_host(url),
                   "source_type": classify_source(url, identity.get("official_hosts")),
                   "relevance": rel, "excluded_reason": why, "origins": [], "queries": [], "categories": [],
                   "duplicate_of_count": 0, "duplicates": []}
            rec["trust"] = TRUST.get(rec["source_type"], 0.4)
            by_url[nk] = rec
        else:
            rec["duplicate_of_count"] += 1
            if url != rec["url"]:
                rec["duplicates"].append(url)
            if len(r.get("description") or "") > len(rec["description"]):
                rec["description"] = r["description"]
            rec["date"] = rec["date"] or r.get("date")
            if rel > rec["relevance"]:
                rec["relevance"], rec["excluded_reason"] = rel, why
        if origin not in rec["origins"]:
            rec["origins"].append(origin)
        rec["queries"].append({"key": key, "query": query, "rank": rank, "origin": origin})
        if category not in rec["categories"]:
            rec["categories"].append(category)

    for sr in search_runs:
        for i, r in enumerate((sr.get("results") or []), 1):
            add(r, "search", sr["key"], sr["category"], sr.get("query", ""), i, bool(sr.get("market")))
    for i, r in enumerate(agent_refs or [], 1):
        if isinstance(r, dict):
            add(r, "agent", "agent", "all", "search_agent", i)

    out = list(by_url.values())
    # 동일 기사 중복(서로 다른 URL, 같은 제목) 표시: 신뢰도/최신 우선 대표만 relevant 로 유지
    groups: list[list[dict]] = []
    for rec in sorted(out, key=lambda x: (-x["trust"], str(x.get("date") or ""))):
        for g in groups:
            if similar_titles(rec["title"], g[0]["title"], 0.8) and rec["source_type"] in ("news", "other", "database"):
                g.append(rec)
                break
        else:
            groups.append([rec])
    for g in groups:
        for dup in g[1:]:
            dup["duplicate_article_of"] = g[0]["url"]
    for rec in out:
        rec["use"] = rec["relevance"] > 0 and not rec.get("duplicate_article_of")
        if rec.get("duplicate_article_of") and not rec["excluded_reason"]:
            rec["excluded_reason"] = "동일 기사 중복"
    return out


def rank_sources(sources: list[dict]) -> list[dict]:
    """공식·신뢰도 높은 자료와 최근 자료를 우선하도록 정렬한다."""
    def k(s):
        d = parse_date(s.get("date"))
        return (-s["trust"], -(d.toordinal() if d else 0), -s["relevance"])
    return sorted([s for s in sources if s.get("use")], key=k)


def same_event(a: dict, b: dict) -> bool:
    """동일 사건 판정: 제목 유사 또는 (사건 유형 동일 + 같은 달 + 금액/고유 숫자 공유)."""
    if similar_titles(a.get("title", ""), b.get("title", ""), 0.6):
        return True
    da = parse_date(a.get("event_date") or a.get("published_date"))
    db = parse_date(b.get("event_date") or b.get("published_date"))
    if da and db and a.get("event_type") and a.get("event_type") == b.get("event_type") \
            and abs((da - db).days) <= 31:
        na = set(re.findall(r"\d[\d,\.]*", f"{a.get('title','')} {a.get('summary','')}"))
        nb = set(re.findall(r"\d[\d,\.]*", f"{b.get('title','')} {b.get('summary','')}"))
        na = {x for x in na if len(x) >= 3}
        return bool(na & nb)
    return False
