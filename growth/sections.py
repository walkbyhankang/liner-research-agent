"""단락 실행: 단락 하나를 돌려 계약 모양의 결과(8절)와 끝 상태·오류(5.2·5.3절)를 만든다.

- 단락마다 growth.limits 예산(SectionBudget)을 받아, Liner 요청은 budget.liner_client() 로 만든 클라이언트로만 보내고
  무료 API 는 요청 직전에 budget.use() 로 센다. 끝나면 RunCtx.settle() 이 실제 요청 수로 확정해 봉투의 paid 를 만든다.
- 바깥 자료 글(원문, 모델 답, 검색 결과)은 데이터로만 다룬다(프롬프트의 데이터 취급 규칙은 옮긴 모듈에 그대로 있다).
- 응답 글에는 내부 경로·예외 이름·키 이름을 넣지 않는다. 오류 문장은 5.3절의 기본 문장을 쓴다.
"""
from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

import config
from growth import common, company, facts, funding_history as fh, gov, limits, news, papers, patents, public_data
from growth.contract import NEWS_CATEGORIES
from growth.liner import DATA_RULE, Liner, ScholarClient
from liner_client import LinerAPIError

# 테스트가 가짜 전송을 끼우는 자리(실제 서버에서는 비어 있다). LinerClient·학술 검색 클라이언트에 그대로 넘긴다.
LINER_KWARGS: dict = {}
# facts 단락의 원문 확인기(None 이면 엔진 기본 Fetcher). 테스트가 가짜를 끼운다.
FACTS_FETCHER: Callable[[], Any] | None = None
PROFILE_WAIT_SEC = 120     # facts 가 경쟁사 국내 판정 전에 profile 을 기다리는 최대 시간
MAX_TECH = 6               # 논문을 찾을 기술 분야 수(계약 8.8절)
PAPERS_PER_TOPIC = 12
RIVAL_WORKERS = 3
TECH_WORKERS = 4

MESSAGES = {
    "daily_limit": "오늘 호출 상한에 닿아 이 단락을 확인하지 못했습니다. 내일 0시 이후에 다시 분석할 수 있습니다.",
    "section_limit": "이 단락에 정한 호출 수 안에서 자료를 다 확인하지 못했습니다.",
    "no_corp": "법인이 확인되지 않아 공식 재무·고용 자료가 없습니다.",
    "timeout": "정한 시간 안에 응답이 오지 않았습니다.",
    "interrupted": "분석이 중간에 멈췄습니다.",
    "missing_config": "이 자료를 쓰는 설정이 되어 있지 않습니다.",
    "no_data": "자료를 찾지 못했습니다.",
}
NO_CORP_PICKED = "고른 법인을 금융위원회 자료에서 찾지 못했습니다."
SRC_FSC, SRC_NPS, SRC_LINER, SRC_NAVER, SRC_PATENTS, SRC_OPENALEX, SRC_G2B = (
    "금융위원회", "국민연금공단", "Liner", "NAVER 뉴스", "Google Patents", "OpenAlex", "조달청 나라장터")


def liner_key() -> tuple[str | None, str | None]:
    """Liner 키(값은 응답·파일에 넣지 않는다). 테스트가 바꿔 끼운다."""
    return config.resolve_api_key()


def has_datagokr() -> bool:
    return bool(common.env("DATA_GO_KR_SERVICE_KEY"))


# ---------------------------------------------------------------- 끝 상태 만들기

def error(code: str, message: str | None = None, *, source: str | None = None, retry_at: str | None = None) -> dict:
    if message is None:
        message = f"{source}에서 응답을 받지 못했습니다." if code == "upstream_error" and source else MESSAGES.get(code, MESSAGES["no_data"])
    return {"code": code, "message": message, "source": source, "retryAt": retry_at}


def done(result: dict) -> dict:
    return {"status": "done", "result": result, "error": None}


def partial(result: dict, err: dict) -> dict:
    return {"status": "partial", "result": result, "error": err}


def unavailable(err: dict, result: dict | None = None) -> dict:
    """no_data 일 때만 result 를 둔다(계약 5.2절)."""
    return {"status": "unavailable", "result": result if err["code"] == "no_data" else None, "error": err}


def limit_error(e: limits.LimitReached) -> dict:
    if e.scope == "daily":
        return error("daily_limit", retry_at=e.retry_at_iso)
    return error("section_limit")


# ---------------------------------------------------------------- 실행 맥락

class RunCtx:
    """단락 한 번 실행의 맥락. 작업(job)에서 앞 단락 결과를 읽고, 예산으로 클라이언트를 만든다."""

    def __init__(self, job: Any, key: str, budget: limits.SectionBudget, *, fresh: bool = False, body: dict | None = None):
        self.job, self.key, self.budget, self.fresh, self.body = job, key, budget, fresh, body or {}
        self.started_ts = time.time()
        self.clients: list[Any] = []
        self.scholars: list[ScholarClient] = []

    # 앞 단락
    def result(self, key: str) -> dict | None:
        return self.job.result(key)

    def section(self, key: str) -> dict:
        return self.job.section(key)

    def stage(self, text: str) -> None:
        self.job.set_stage(self.key, text)

    @property
    def corp(self) -> dict | None:
        r = self.result("identity")
        return r["corp"] if r else None

    @property
    def search_name(self) -> str:
        return common.strip_corp(self.job.query) or self.job.query

    def aliases(self) -> list[str]:
        p = self.result("profile") or {}
        prof = {"name_ko": p.get("nameKo"), "name_en": p.get("nameEn"), "aliases": p.get("aliases") or []}
        c = self.corp
        corp = {"names": c.get("names") or [], "name_en": c.get("nameEn") or ""} if c else None
        return company.aliases(prof, corp) or [self.search_name]

    def name_en(self) -> str:
        p, c = self.result("profile") or {}, self.corp or {}
        return p.get("nameEn") or c.get("nameEn") or ""

    def homepage(self) -> str:
        return self.job.homepage or (self.corp or {}).get("homepage") or ""

    # 예산
    def use(self, api: str) -> None:
        self.budget.use(api)

    def fresh_since(self) -> float | None:
        return self.started_ts if self.fresh else None

    def liner_client(self):
        key, source = liner_key()
        client = self.budget.liner_client(key, source, **LINER_KWARGS)
        self.clients.append(client)
        return client

    def liner(self, *, scholar: bool = False) -> Liner:
        key, _ = liner_key()
        if not key:
            return Liner(None, fresh=self.fresh)
        sc = None
        if scholar:
            sc = ScholarClient(key, self.budget, **{k: v for k, v in LINER_KWARGS.items() if k in ("transport", "sleep")})
            self.scholars.append(sc)
        return Liner(self.liner_client(), scholar=sc, fresh=self.fresh)

    def settle(self) -> dict:
        """실제로 보낸 Liner 요청 수로 예산을 확정하고 봉투 paid 를 돌려준다(성공·실패 모두 한 번)."""
        calls = [c for client in self.clients for c in client.calls]
        used = limits.liner_used(calls)
        used[limits.LINER_SCHOLAR] = sum(s.requests for s in self.scholars)
        paid = self.budget.settle(used)
        for c in self.clients:
            c.close()
        for s in self.scholars:
            s.close()
        return paid

    def queried_at(self) -> str:
        return common.iso(common.now())


# ---------------------------------------------------------------- identity (8.1)

def run_identity(ctx: RunCtx) -> dict:
    crno = ctx.job.crno
    if not crno:
        return unavailable(error("no_corp"))
    if not has_datagokr():
        return unavailable(error("missing_config"))
    ctx.stage("법인 찾기")
    names = list(dict.fromkeys(n for n in (ctx.search_name, ctx.job.query) if n))
    found, cands = None, []
    try:
        for n in names:
            cands = public_data.find_corps(n, use=ctx.use)
            found = next((c for c in cands if c["crno"] == crno), None)
            if found:
                break
    except limits.LimitReached as e:
        return unavailable(limit_error(e))
    except public_data.MissingKey:
        return unavailable(error("missing_config"))
    except public_data.PublicDataError:
        return unavailable(error("upstream_error", source=SRC_FSC))
    if not found:
        return unavailable(error("no_corp", NO_CORP_PICKED))
    snap = ctx.job.snapshot_at
    corp = public_data.corp_contract(found, snapshot_at=snap(found["crno"]))
    others = [public_data.corp_contract(c, snapshot_at=snap(c["crno"])) for c in cands if c["crno"] != crno][:7]
    return done({"corp": corp, "otherCorps": others, "queriedAt": ctx.queried_at()})


# ---------------------------------------------------------------- official (8.2)

FIN_NONE = "금융위원회 재무 자료 없음"
NPS_NONE = "국민연금 사업장을 찾지 못함"
NPS_NO_CORP = "법인 정보를 확인하지 못해 찾지 않음"


def run_official(ctx: RunCtx) -> dict:
    ident = ctx.section("identity")
    if (ident.get("error") or {}).get("code") == "no_corp" or not ctx.job.crno:
        return unavailable(error("no_corp", (ident.get("error") or {}).get("message")))
    if not has_datagokr():
        return unavailable(error("missing_config"))
    crno, corp = ctx.job.crno, ctx.corp
    problems: list[dict] = []
    ctx.stage("재무 조회")
    fin_rows: list[dict] = []
    try:
        fin_rows = public_data.financials(crno, use=ctx.use)
    except limits.LimitReached as e:
        problems.append(limit_error(e))
    except public_data.PublicDataError:
        problems.append(error("upstream_error", source=SRC_FSC))
    nps_raw: dict = {}
    nps_reason = NPS_NONE
    if corp:
        ctx.stage("국민연금 조회")
        try:
            nps_raw = public_data.nps_for_corp(corp, ctx.search_name, use=ctx.use)
        except limits.LimitReached as e:
            problems.append(limit_error(e))
        except (public_data.PublicDataError, ET.ParseError):
            problems.append(error("upstream_error", source=SRC_NPS))
    else:
        nps_reason = NPS_NO_CORP
    financials = [public_data.financial_row(r, with_ratios=True) for r in public_data.pick_recent_years(fin_rows)]
    nps = public_data.nps_contract(nps_raw)
    result = {"crno": crno, "financials": financials,
              "financialsAll": [public_data.financial_row(r, with_ratios=False) for r in fin_rows],
              "financialsReason": None if financials else FIN_NONE, "nps": nps, "npsReason": None if nps else nps_reason,
              "queriedAt": ctx.queried_at()}
    if financials and nps:
        return done(result)
    if financials or nps:
        err = problems[0] if problems else error("no_data", result["npsReason"] if financials else FIN_NONE)
        return partial(result, err)
    if problems:
        return unavailable(problems[0])
    return unavailable(error("no_data", "공식 재무·고용 자료를 찾지 못했습니다."), result)


# ---------------------------------------------------------------- profile (8.3)

def _corp_raw(c: dict | None) -> dict | None:
    if not c:
        return None
    return {"name": c["name"], "name_en": c.get("nameEn") or "", "ceo": c.get("ceo") or "", "founded": c.get("founded") or "",
            "address": c.get("address") or "", "main_biz": c.get("mainBiz") or "", "industry": c.get("industry") or "",
            "names": c.get("names") or []}


def _strs(v: Any, limit: int | None = None) -> list[str]:
    out = [str(x).strip() for x in (v or []) if isinstance(x, str) and str(x).strip()]
    return out[:limit] if limit else out


def profile_contract(prof: dict, sources: list[dict]) -> dict:
    n = common.none_if_empty
    srcs = [{"title": str(s.get("title") or s.get("url") or ""), "url": common.web_url(s.get("url")), "date": n(s.get("date"))}
            for s in sources]
    tech = []
    for k in prof.get("tech_keywords") or []:
        if isinstance(k, dict) and (str(k.get("ko") or "").strip() or str(k.get("en") or "").strip()):
            ko = str(k.get("ko") or "").strip() or str(k.get("en")).strip()
            tech.append({"ko": ko, "en": n(k.get("en"))})
    ff = prof.get("fund_field")
    return {
        "nameKo": n(prof.get("name_ko")), "nameEn": n(prof.get("name_en")), "aliases": _strs(prof.get("aliases")),
        "industry": n(prof.get("industry")), "business": n(prof.get("business")),
        "products": [{"name": str(p["name"]).strip(), "desc": n(p.get("desc"))} for p in prof.get("products") or []
                     if isinstance(p, dict) and str(p.get("name") or "").strip()],
        "coreTech": _strs(prof.get("core_tech")), "statusNotes": _strs(prof.get("status_notes")), "techKeywords": tech,
        "govKeywords": _strs(prof.get("gov_keywords")), "bidKeywords": _strs(prof.get("bid_keywords")),
        "fundField": ff if ff in company.FUND_FIELDS else None, "stage": n(prof.get("stage")),
        "competitors": [{"name": str(c["name"]).strip(), "nameEn": n(c.get("name_en")), "registeredNameKo": n(c.get("registered_name_ko")),
                         "relation": n(c.get("relation")), "reason": n(c.get("reason"))}
                        for c in (prof.get("competitors") or [])[:5] if isinstance(c, dict) and str(c.get("name") or "").strip()],
        "sourceCount": len(srcs), "sources": srcs,
    }


def run_profile(ctx: RunCtx) -> dict:
    key, _ = liner_key()
    if not key:
        return unavailable(error("missing_config"))
    liner = ctx.liner()
    out = company.analyze(ctx.search_name, liner, _corp_raw(ctx.corp), progress=ctx.stage)
    if not out["sources"]:
        if liner.limit is not None:
            return unavailable(limit_error(liner.limit))
        if liner.failures and not liner.succeeded:
            return unavailable(error("upstream_error", source=SRC_LINER))
        return unavailable(error("no_data", "사업 설명 자료를 찾지 못했습니다."), profile_contract({}, []))
    if out["model_failed"]:
        return unavailable(limit_error(liner.limit) if liner.limit else error("upstream_error", source=SRC_LINER))
    return done(profile_contract(out["profile"], out["sources"]))


# ---------------------------------------------------------------- facts (8.4)

def run_facts(ctx: RunCtx) -> dict:
    key, _ = liner_key()
    if not key:
        return unavailable(error("missing_config"))
    client = ctx.liner_client()
    ctx.stage("보도·공식 자료 검색")
    try:
        out = facts.lookup(ctx.search_name, client, homepage=ctx.homepage(),
                           fetcher=FACTS_FETCHER() if FACTS_FETCHER else None,
                           progress=lambda m: ctx.stage(facts.stage_label(m)))
    except facts.ProfileError as e:
        sent = [c for c in client.calls if c.get("kind") == "search"]
        if "검색 결과를 받지 못했습니다" in str(e) and not (sent and not any(c.get("ok") for c in sent)):
            return unavailable(error("no_data", "공개 자료에서 회사 사실을 찾지 못했습니다."), facts.empty_result())
        return unavailable(error("upstream_error", source=SRC_LINER))
    except LinerAPIError:
        return unavailable(error("upstream_error", source=SRC_LINER))
    result = facts.to_contract(out)
    ctx.stage("경쟁사 국내 확인")
    ctx.job.wait_terminal("profile", PROFILE_WAIT_SEC)
    complete = facts.judge_domestic(result["competitors"], ctx.result("profile"), ctx.search_name, use=ctx.use)
    return done(result) if complete else partial(result, error("section_limit"))


# ---------------------------------------------------------------- funding_history (8.5)

def fh_entry(ctx: RunCtx) -> dict:
    return fh.company_entry(ctx.search_name, ctx.name_en(), aliases=ctx.aliases(), homepage=ctx.homepage(), is_korean=True)


def run_funding_history(ctx: RunCtx) -> dict:
    key, _ = liner_key()
    if not key:
        return unavailable(error("missing_config"))
    liner = ctx.liner()
    ctx.stage("투자 DB 조회")
    entry = fh_entry(ctx)
    out = fh.collect(liner, [entry])
    item = out["by_company"][entry["name"]]
    result = fh.to_contract(item, ctx.queried_at())
    if result["rounds"]:
        return done(result)
    if liner.failures and not liner.succeeded:
        return unavailable(error("upstream_error", source=SRC_LINER))
    if liner.limit is not None and not liner.succeeded:
        return unavailable(limit_error(liner.limit))
    return unavailable(error("no_data", "투자 라운드 자료를 찾지 못했습니다. 투자 이력이 없다는 뜻은 아닙니다."), result)


# ---------------------------------------------------------------- news (8.6)

def category_counts(articles: list[dict]) -> list[dict]:
    counts = {c: 0 for c in NEWS_CATEGORIES}
    for a in articles:
        for c in a["categories"]:
            if c in counts:
                counts[c] += 1
    order = {c: i for i, c in enumerate(NEWS_CATEGORIES)}
    return [{"category": c, "count": v} for c, v in sorted(counts.items(), key=lambda kv: (-kv[1], order[kv[0]]))]


def news_contract(col: dict, summary: dict | None) -> dict:
    n = common.none_if_empty
    arts, by_key = [], {}
    for i, a in enumerate(col["articles"]):
        art = {"id": f"a{i + 1}", "date": n(a.get("date")), "title": str(a.get("title") or ""), "description": n(a.get("description")),
               "outlet": n(a.get("매체")), "url": common.web_url(a.get("url")), "naverUrl": common.web_url(a.get("naver_url")),
               "categories": [c for c in a.get("분류") or [] if c in NEWS_CATEGORIES] or ["기타 동향"],
               "relatedCount": int(a.get("관련 기사 수") or 1)}
        arts.append(art)
        if a.get("url_key"):
            by_key.setdefault(a["url_key"], art)
    events = []
    for e in (summary or {}).get("events") or []:
        hit = by_key.get(e.get("url_key") or "")
        events.append({"date": n(str(e.get("date") or "")), "category": str(e.get("category") or ""), "title": str(e.get("title") or ""),
                       "detail": n(str(e.get("detail") or "")), "articleId": hit["id"] if hit else None,
                       "articleTitle": hit["title"] if hit else None, "articleUrl": hit["url"] if hit else None,
                       "outlet": hit["outlet"] if hit else None, "articleDate": hit["date"] if hit else None})
    events.sort(key=lambda e: e["date"] or "", reverse=True)
    errs = []
    if col.get("naver_failed"):
        errs.append(f"NAVER 뉴스 검색 {col['naver_failed']}건을 받지 못했습니다.")
    if col.get("limit") is not None:
        errs.append("호출 상한에 닿아 뉴스 검색을 일부만 했습니다.")
    return {"period": col.get("period") or "", "rawCount": int(col.get("raw_count") or 0),
            "apiCounts": {k: int(v) for k, v in (col.get("api_counts") or {}).items()}, "articleTotal": len(arts),
            "categoryCounts": category_counts(arts), "articles": arts, "events": events[:15],
            "trends": _strs((summary or {}).get("trends"), 5), "longSummary": n((summary or {}).get("summary")), "errors": errs}


def run_news(ctx: RunCtx) -> dict:
    if not news.has_keys():
        return unavailable(error("missing_config"))
    liner = ctx.liner()
    ctx.stage("뉴스 수집")
    col = news.collect(ctx.search_name, ctx.aliases(), liner, use=ctx.use, fresh_since=ctx.fresh_since())
    if not col["articles"]:
        if col.get("limit") is not None:
            return unavailable(limit_error(col["limit"]))
        if col["naver_failed"] and col["naver_failed"] >= col["naver_queries"]:
            return unavailable(error("upstream_error", source=SRC_NAVER))
        return unavailable(error("no_data", "최근 12개월 기사를 찾지 못했습니다."), news_contract(col, None))
    ctx.stage("중요 사건 정리")
    summary = news.summarize(ctx.search_name, col["articles"], liner) if liner.ok else None
    result = news_contract(col, summary)
    if col.get("limit") is not None:
        return partial(result, limit_error(col["limit"]))
    if col["naver_failed"]:
        return partial(result, error("upstream_error", f"일부 뉴스 검색에 실패했습니다 ({col['naver_failed']}건).", source=SRC_NAVER))
    if summary is None:
        if not liner.ok:
            return partial(result, error("missing_config"))
        return partial(result, limit_error(liner.limit) if liner.limit else error("upstream_error", source=SRC_LINER))
    return done(result)


# ---------------------------------------------------------------- patents (8.7)

def patent_contract(p: dict) -> dict:
    n = common.none_if_empty
    return {"id": p.get("application_no") or p["pub_no"], "title": str(p.get("title") or p["pub_no"]), "assignee": n(p.get("assignee")),
            "applicationNo": n(p.get("application_no")), "filingDate": n(p.get("filing_date")), "publicationNo": n(p.get("publication_no")),
            "publicationDate": n(p.get("publication_date")), "registrationNo": n(p.get("registration_no")),
            "registrationDate": n(p.get("registration_date")), "legalStatus": n(p.get("status")), "cpc": list(p.get("cpc") or []),
            "techFields": list(p.get("tech_fields") or []), "abstract": n(p.get("abstract")), "url": common.web_url(p.get("url"))}


def patents_contract(r: dict, queried_at: str) -> dict:
    n = common.none_if_empty
    errs = []
    if r.get("limit") is not None:
        errs.append("호출 상한에 닿아 특허 원문 확인을 멈췄습니다.")
    return {"summary": patents.summary_contract(r["summary"]), "patents": [patent_contract(p) for p in r["patents"]],
            "mentions": [{"pubNo": m["pub_no"], "title": str(m.get("title") or m["pub_no"]), "assignee": n(m.get("assignee")),
                          "filingDate": n(m.get("filing_date")), "url": common.web_url(m.get("url"))} for m in r["mentions"]],
            "pagesChecked": int(r.get("pages_checked") or 0), "pagesLimit": limits.PATENT_PAGES_PER_COMPANY,
            "candidatesLeft": int(r.get("candidates_left") or 0), "basis": r.get("basis") or patents.BASIS, "note": patents.NOTE,
            "errors": errs, "queriedAt": queried_at}


def patent_entry(ctx: RunCtx, *, is_self: bool = True) -> dict:
    corp = ctx.corp or {}
    return patents.entry(ctx.search_name, ctx.name_en(), registered=common.strip_corp(corp.get("name")), aliases=ctx.aliases(),
                         is_self=is_self)


def run_patents(ctx: RunCtx) -> dict:
    key, _ = liner_key()
    if not key:
        return unavailable(error("missing_config"))
    liner = ctx.liner()
    ctx.stage("특허 원문 확인")
    r = patents.company_patents(liner, patent_entry(ctx), use=ctx.use)
    result = patents_contract(r, ctx.queried_at())
    lim = r.get("limit") or liner.limit
    if r["patents"]:
        return partial(result, limit_error(lim)) if lim is not None else done(result)
    if not r["search_ok"] and liner.failures:
        return unavailable(error("upstream_error", source=SRC_LINER))
    if lim is not None and not r["pages_checked"]:
        return unavailable(limit_error(lim))
    # 화면 이름 "검색으로 확인한 특허"(계약 8.7, 2026-11-23)와 같은 말. 짧은 사유는 merge.py 의 patentCount 기본값(같은 말의 짧은 꼴)
    return unavailable(error("no_data", "출원인이 이 회사로 확인된 특허를 검색에서 찾지 못했습니다. 검색에 걸리지 않은 특허는 빠집니다."), result)


# ---------------------------------------------------------------- papers (8.8)

def paper_contract(p: dict, fallback: str) -> dict:
    n = common.none_if_empty
    y = p.get("연도")
    year = int(y) if isinstance(y, int) or (isinstance(y, str) and y.isdigit()) else None
    try:
        cites = int(p.get("피인용") or 0)
    except (TypeError, ValueError):
        cites = 0
    return {"id": str(p.get("id") or p.get("doi") or p.get("링크") or fallback), "title": str(p.get("제목") or ""), "year": year,
            "date": n(p.get("발표일")), "authors": n(p.get("저자")), "affiliations": n(p.get("소속")), "venue": n(p.get("학술지·학회")),
            "citations": cites, "url": common.web_url(p.get("링크")),
            "source": "Liner Scholar" if p.get("출처") == "Liner Scholar" else "OpenAlex", "important": n(p.get("주요 논문"))}


def run_papers(ctx: RunCtx) -> dict:
    prof = ctx.result("profile") or {}
    kws = (prof.get("techKeywords") or [])[:MAX_TECH]
    if not kws:
        return unavailable(error("no_data", "논문을 찾을 기술 낱말이 없습니다."),
                           {"keywordsUsed": [], "topics": [], "company": _empty_company(), "queriedAt": ctx.queried_at()})
    liner = ctx.liner(scholar=True)
    ctx.stage("논문 검색")

    def topic_one(k: dict) -> dict:
        tr = papers.topic_trend(k.get("en") or k["ko"], use=ctx.use)
        extra = papers.scholar_extra(liner, k.get("en") or "", "") if liner.ok else []
        ps = papers.mark_important(papers.merge_unique(tr["recent"], extra, tr["cited"]))
        return {"name": k["ko"], "en": k.get("en"), "trend": tr, "papers": ps}
    en_kws = [k["en"] for k in kws if k.get("en")]
    with ThreadPoolExecutor(max_workers=TECH_WORKERS, thread_name_prefix="tech") as ex:
        f_topics = [ex.submit(topic_one, k) for k in kws]
        f_comp = ex.submit(papers.company_papers, ctx.search_name, ctx.name_en(), en_kws, use=ctx.use)
        topics = [f.result() for f in f_topics]
        comp = f_comp.result()
    papers.mark_important(comp.get("works") or [])
    ctx.stage("논문 요약")
    summ = papers.summarize(ctx.search_name, prof.get("business") or "", topics, liner) if liner.ok else {}
    out_topics = []
    for t in topics:
        s = summ.get(t["name"]) or {}
        out_topics.append({
            "name": t["name"], "en": common.none_if_empty(t.get("en")),
            "byYear": {str(y): int(v) for y, v in sorted((t["trend"].get("by_year") or {}).items())},
            "trend": papers.trend_label(t["trend"].get("by_year") or {}),
            "institutions": [{"name": str(i["기관"]), "count": int(i.get("논문 수") or 0)} for i in t["trend"].get("institutions") or []],
            "papers": [paper_contract(p, f"{t['name']}-{j}") for j, p in enumerate(t["papers"][:PAPERS_PER_TOPIC])],
            "summary": common.none_if_empty(s.get("summary")), "relevance": common.none_if_empty(s.get("relevance")),
            "keyPapers": [{"title": str(k["제목"]), "point": str(k.get("요지") or ""), "url": common.web_url(k.get("링크"))}
                          for k in s.get("key_papers") or []]})
    company_out = {"mode": comp.get("mode") or "", "direct": bool(comp.get("direct")), "countBasis": common.none_if_empty(comp.get("count_basis")),
                   "works": [paper_contract(p, f"self-{j}") for j, p in enumerate(comp.get("works") or [])],
                   "byYear": {str(y): int(v) for y, v in sorted((comp.get("by_year") or {}).items())},
                   "mentionByYear": {str(y): int(v) for y, v in sorted((comp.get("mention_by_year") or {}).items())},
                   "error": "OpenAlex에서 회사 논문을 받지 못했습니다." if comp.get("error") else None}
    result = {"keywordsUsed": [t["name"] for t in topics], "topics": out_topics, "company": company_out, "queriedAt": ctx.queried_at()}
    oa_limit = next((t["trend"]["limit"] for t in topics if t["trend"].get("limit") is not None), None) or comp.get("limit")
    oa_failed = all(t["trend"].get("errors") and not t["papers"] for t in topics)
    if oa_failed and not any(t["papers"] for t in topics):
        return unavailable(limit_error(oa_limit) if oa_limit else error("upstream_error", source=SRC_OPENALEX))
    if oa_limit is not None or liner.limit is not None:
        return partial(result, limit_error(oa_limit or liner.limit))
    if any(t["trend"].get("errors") for t in topics) or comp.get("error"):
        return partial(result, error("upstream_error", source=SRC_OPENALEX))
    if not liner.ok:
        return partial(result, error("missing_config"))
    if liner.failures:
        return partial(result, error("upstream_error", source=SRC_LINER))
    return done(result)


def _empty_company() -> dict:
    return {"mode": "", "direct": False, "countBasis": None, "works": [], "byYear": {}, "mentionByYear": {}, "error": None}


# ---------------------------------------------------------------- rivals_deep (8.9)

RIVAL_SUMMARY_ARTICLES = 15   # 경쟁사마다 요약 모델에 넘기는 기사 수(그 경쟁사 뉴스의 최신순 앞부분)
# 경쟁사 특허 낱건 상한(계약 8.9). 원문 확인 상한(한 곳 30쪽)과 같다: 원문 한 쪽이 특허 한 건 이하라 확인된 특허가 잘리지 않는다
RIVAL_PATENT_ITEMS = limits.PATENT_PAGES_PER_COMPANY
_RIVAL_PATENT_KEYS = ("id", "title", "assignee", "applicationNo", "filingDate", "publicationNo", "registrationNo", "url")


def summary_articles(row: dict) -> list[dict]:
    """경쟁사 한 곳에서 요약 모델에 넘기는 기사. 넘긴 목록과 결과에 남기는 목록(inputArticles)이 같도록 여기서만 정한다."""
    return ((row.get("news") or {}).get("articles") or [])[:RIVAL_SUMMARY_ARTICLES]


def summary_inputs(arts: list[dict]) -> list[dict]:
    """요약 모델에 넘긴 기사 → 계약 RivalSummaryInput(받은 값만 옮긴다. http·https 가 아닌 주소는 None, 발췌 글은 넣지 않는다)."""
    n = common.none_if_empty
    return [{"title": str(a.get("title") or ""), "url": common.web_url(a.get("url")), "naverUrl": common.web_url(a.get("naver_url")),
             "date": n(a.get("date")), "outlet": n(a.get("매체"))} for a in arts]


def rival_patent_items(pats: list[dict]) -> list[dict]:
    """출원인이 원문에서 확인된 경쟁사 특허(company_patents 의 patents, 출원일 최근순) → 계약 RivalPatent(Patent 의 일부 칸)."""
    return [{k: c[k] for k in _RIVAL_PATENT_KEYS} for c in map(patent_contract, pats[:RIVAL_PATENT_ITEMS])]


RIVAL_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["rivals"],
    "properties": {"rivals": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["name", "business", "products_tech", "recent_changes"],
        "properties": {"name": {"type": "string"}, "business": {"type": "string", "description": "주요 사업 2~3문장"},
                       "products_tech": {"type": "string", "description": "주요 제품·기술"},
                       "recent_changes": {"type": "array", "items": {"type": "string"}, "description": "최근 사업 변화 최대 5개(자료 근거)"}}}}},
}


def summarize_rivals(target: str, rows: list[dict], liner: Liner) -> dict:
    """경쟁사별 상위 뉴스 제목·요약을 묶어 모델 1회로 사업·제품·최근 변화를 정리한다(팀원의 통합 분석 프로토타입(커밋 97c93ce)에서 옮김)."""
    blocks = []
    for r in rows:
        arts = summary_articles(r)
        lines = "\n".join(f"- ({a['date']}) {a['title']} — {a['description'][:150]}" for a in arts) or "- 뉴스 없음"
        c = r["info"]
        blocks.append(f"## {c.get('name')} ({c.get('country') or '한국'}, {c.get('relation')}: {c.get('reason')})\n{lines}")
    system = (f"당신은 경쟁사 분석가입니다. {DATA_RULE}\n경쟁사마다 주요 사업, 주요 제품·기술, 최근 사업 변화를 한국어로 정리합니다. "
              "뉴스가 없으면 일반적으로 알려진 사업 개요만 짧게 쓰고 최근 변화는 비웁니다.")
    out = liner.json(system, f"대상 기업: {target}\n\n<자료>\n" + "\n\n".join(blocks) + "\n</자료>", RIVAL_SCHEMA, name="rival_summary")
    return {x.get("name"): x for x in (out or {}).get("rivals") or []}


def _rival_public(ctx: RunCtx, pick: dict, info: dict) -> dict:
    """경쟁사 한 곳의 법인·재무·국민연금(무료)."""
    out: dict = {"corp": None, "financials": [], "financialsReason": "법인이 확인되지 않아 재무 자료가 없습니다.",
                 "nps": None, "npsReason": "법인이 확인되지 않아 국민연금 자료가 없습니다.", "errors": []}
    if not has_datagokr():
        out["errors"].append("공공데이터 설정이 되어 있지 않습니다.")
        return out
    names = list(dict.fromkeys(n for n in (info.get("registeredNameKo"), pick["name"]) if n))
    try:
        found = None
        for n in names:
            cands = public_data.find_corps(n, pick.get("nameEn") or "", use=ctx.use)
            found = (next((c for c in cands if c["crno"] == pick.get("crno")), None) if pick.get("crno")
                     else next((c for c in cands if c["exact"]), None))
            if found:
                break
        if not found:
            return out
        out["corp"] = public_data.corp_contract(found, snapshot_at=ctx.job.snapshot_at(found["crno"]))
        rows = public_data.financials(found["crno"], use=ctx.use)
        out["financials"] = [public_data.financial_row(r, with_ratios=True) for r in public_data.pick_recent_years(rows)]
        out["financialsReason"] = None if out["financials"] else FIN_NONE
        nps = public_data.nps_contract(public_data.nps_for_corp(out["corp"], pick["name"], use=ctx.use))
        out["nps"], out["npsReason"] = nps, (None if nps else NPS_NONE)
    except limits.LimitReached:
        out["errors"].append("호출 상한에 닿아 공식 자료를 일부만 확인했습니다.")
    except (public_data.PublicDataError, ET.ParseError):
        out["errors"].append("금융위원회·국민연금공단 자료를 받지 못했습니다.")
    return out


def run_rivals_deep(ctx: RunCtx) -> dict:
    picks = ctx.body.get("rivals") or []
    merged = {r["key"]: r for r in ctx.job.merged_rivals()}
    liner = ctx.liner()
    ctx.stage("경쟁사 자료 수집")

    def one(pick: dict) -> dict:
        info = merged.get(pick["key"]) or {}
        row: dict = {"pick": pick, "info": {"name": pick["name"], "relation": info.get("relation"), "reason": info.get("reason")},
                     "public": _rival_public(ctx, pick, info), "news": None, "patents": None, "errors": []}
        try:
            if news.has_keys():
                al = [a for a in (pick["name"], pick.get("nameEn"), info.get("registeredNameKo")) if a]
                row["news"] = news.collect(pick["name"], al, None, extra_queries=["투자", "계약", "출시"], naver_pages=1, liner_queries=1,
                                           use=ctx.use, fresh_since=ctx.fresh_since())
        except Exception:  # 경쟁사 뉴스 실패가 다른 자료를 멈추지 않게 한다
            row["errors"].append("경쟁사 뉴스를 받지 못했습니다.")
        if liner.ok:
            try:
                ent = patents.entry(pick["name"], pick.get("nameEn") or "", registered=info.get("registeredNameKo") or "")
                row["patents"] = patents.company_patents(liner, ent, use=ctx.use)
            except Exception:
                row["errors"].append("경쟁사 특허를 확인하지 못했습니다.")
        return row
    with ThreadPoolExecutor(max_workers=RIVAL_WORKERS, thread_name_prefix="rival") as ex:
        rows = list(ex.map(one, picks))
    fh_out: dict = {}
    summ: dict = {}
    if liner.ok:
        ctx.stage("경쟁사 투자 이력·요약")
        entries = [fh.company_entry(r["pick"]["name"], r["pick"].get("nameEn") or "",
                                    registered=(merged.get(r["pick"]["key"]) or {}).get("registeredNameKo") or "",
                                    homepage=((r["public"].get("corp") or {}).get("homepage")) or "", is_korean=True) for r in rows]
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="rivalsum") as ex:
            f_fh = ex.submit(fh.collect, liner, entries)
            f_sum = ex.submit(summarize_rivals, ctx.search_name, rows, liner)
            fh_out = (f_fh.result() or {}).get("by_company") or {}
            summ = f_sum.result()
    out_rivals, inv_rows, any_ok = [], [], False
    for r in rows:
        pick, pub = r["pick"], r["public"]
        item = fh_out.get(pick["name"])
        funding = None
        reason = "Liner 설정이 되어 있지 않습니다." if not liner.ok else "투자 라운드 자료 없음"
        if item:
            rounds = fh.self_rounds(item)
            if rounds:
                investors, summary = fh.summary_contract(item.get("cards") or [], rounds)
                funding = {"rounds": [fh.round_contract(x, f"r{i + 1}") for i, x in enumerate(rounds)], "summary": summary,
                           "investors": [i["name"] for i in investors]}
        pt = r["patents"]
        pat = ({"total": pt["summary"]["total"], "registered": pt["summary"]["registered"],
                "byYear": patents.summary_contract(pt["summary"])["byYear"], "items": rival_patent_items(pt["patents"])} if pt else None)
        s = summ.get(pick["name"])
        summary_out = ({"business": common.none_if_empty(s.get("business")), "productsTech": common.none_if_empty(s.get("products_tech")),
                        "recentChanges": _strs(s.get("recent_changes"), 5), "inputArticles": summary_inputs(summary_articles(r))}
                       if s else None)
        errors = list(dict.fromkeys(pub["errors"] + r["errors"]))
        out_rivals.append({"key": pick["key"], "name": pick["name"], "nameEn": common.none_if_empty(pick.get("nameEn")),
                           "corp": pub["corp"], "financials": pub["financials"], "financialsReason": pub["financialsReason"],
                           "nps": pub["nps"], "npsReason": pub["npsReason"], "funding": funding,
                           "fundingReason": None if funding else reason, "patents": pat,
                           "patentsReason": None if pat else "특허 자료를 확인하지 못했습니다.", "summary": summary_out, "errors": errors})
        any_ok = any_ok or bool(pub["corp"] or funding or pat or summary_out)
        if funding and funding["investors"]:
            inv_rows.append({"rivalKey": pick["key"], "rivalName": pick["name"], "investors": funding["investors"]})
    result = {"rivalSet": [p["key"] for p in picks], "rivals": out_rivals, "rivalInvestors": inv_rows, "queriedAt": ctx.queried_at()}
    if not any_ok:
        return unavailable(limit_error(liner.limit) if liner.limit else error("upstream_error", source=SRC_LINER if liner.ok else SRC_FSC))
    return done(result)


# ---------------------------------------------------------------- sales (8.10)

def run_sales(ctx: RunCtx) -> dict:
    if not has_datagokr():
        return unavailable(error("missing_config"))
    kws = ctx.body.get("keywords") or []
    tech_ko = [k["ko"] for k in (ctx.result("profile") or {}).get("techKeywords") or []][:3]
    ctx.stage("입찰공고 검색")
    g = gov.g2b_search(kws, kws[:3] + tech_ko, days=28, use=ctx.use)
    result = {"keywords": kws, "strongKeywords": kws[:3] + tech_ko, "period": g["period"], "items": [gov.bid_contract(r) for r in g["items"]],
              "calls": int(g["calls"]), "errorCount": int(g["error_count"]), "skipped": int(g["skipped"]),
              "errors": [_short_bid_error(e) for e in g["errors"]], "queriedAt": ctx.queried_at()}
    if g.get("missing_key"):
        return unavailable(error("missing_config"))
    lim = g.get("limit")
    if g["error_count"] and g["error_count"] >= g["calls"]:
        return unavailable(limit_error(lim) if lim else error("upstream_error", source=SRC_G2B))
    if lim is not None:
        return partial(result, limit_error(lim))
    if g["error_count"]:
        return partial(result, error("upstream_error", f"일부 기간 조회에 실패했습니다 ({g['error_count']}건).", source=SRC_G2B))
    return done(result)


def _short_bid_error(e: str) -> str:
    """'낱말/종류 MMDD-MMDD: 내부 사유' → '낱말/종류 MMDD-MMDD 구간: 나라장터 응답 오류'(내부 사유를 보이지 않는다)."""
    head = re.split(r":\s", e, maxsplit=1)[0]
    return f"{head} 구간: {'호출 상한' if '상한' in e else '나라장터 응답 오류'}"


RUNNERS: dict[str, Callable[[RunCtx], dict]] = {
    "identity": run_identity, "official": run_official, "profile": run_profile, "facts": run_facts,
    "funding_history": run_funding_history, "news": run_news, "patents": run_patents, "papers": run_papers,
    "rivals_deep": run_rivals_deep, "sales": run_sales,
}


def rival_count(body: dict | None) -> int:
    return len((body or {}).get("rivals") or [])
