"""분석 실행 파이프라인과 결과 파일 저장."""
from __future__ import annotations

import csv
import hashlib
import json
import platform
import re
import sys
import time
import uuid
import zipfile
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable

import analysis as an
import categories as cat
import config
import fetcher as fetcher_mod
import integrate
import planner
import sources as src
from liner_client import CallLimitExceeded, LinerAPIError, LinerClient, extract_output_text
from planner import CATEGORIES, CATEGORY_LABELS

Progress = Callable[[str], None]


def new_run_id() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]


def default_options(**kw) -> dict:
    o = {"search_budget": config.MAX_SEARCH_CALLS, "max_results": config.SEARCH_MAX_RESULTS, "use_agent": True,
         "fetch_pages": config.FETCH_MAX_PAGES, "model": config.DEFAULT_MODEL, "hints": {}, "date_ranges": True,
         "reserve_premium": True}  # Premium 비교용 검색 1회를 한도 안에 미리 확보
    o.update(kw)
    return o


def cache_key(company: str, country: str, options: dict) -> str:
    """검색 설정이 바뀌면 키가 달라져 이전 결과와 구분된다. 검색 로직 버전 포함."""
    o = {k: options.get(k) for k in ("search_budget", "max_results", "use_agent", "model", "fetch_pages", "date_ranges")}
    o["hints"] = options.get("hints") or {}
    raw = json.dumps([company.strip(), country, o, config.LOGIC_VERSION], sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def new_run(company: str, country: str, options: dict | None = None) -> dict:
    options = options or default_options()
    return {
        "run_id": new_run_id(), "company": company, "country": country,
        "started_at": now_iso(), "finished_at": None, "is_mock": False, "options": options,
        "logic_version": config.LOGIC_VERSION, "cache_key": cache_key(company, country, options),
        "last_search_at": None, "searches": {}, "search_plan": [], "search_meta": {}, "unsearched": [],
        "model_response": None, "category_runs": {},
        "agent": {"status": "not_run", "answer": "", "references": [], "chunks": [], "elapsed_sec": None, "error": ""},
        "premium": {"status": "not_run"},
        "identity": {}, "sources": [], "fetched": {}, "verification": [], "recon": {},
        "analysis": an.empty_analysis("아직 분석되지 않음"),
        "status": {"search": "not_run", "model": "not_run", "agent": "not_run", "premium": "not_run"},
        "errors": [], "calls": [],
    }


def _record_error(run: dict, stage: str, e: Exception) -> None:
    run["errors"].append({"stage": stage, "message": str(e), "status": getattr(e, "status", None),
                          "at": now_iso()})


def _do_search(run: dict, client: LinerClient, step: dict, say: Progress) -> bool:
    say(f"Search API [{step['key']}] {step['query'][:50]}")
    try:
        data, rec = client.search_web(
            step["query"], country_code=step["country_code"], lang=step["lang"], date_range=step.get("date_range"),
            label=f"search:{step['key']}", max_results=run["options"]["max_results"],
            meta={"topic": step["key"], "category": step["category"]})
        run["searches"][step["key"]] = data
        run["search_meta"][step["key"]] = {"category": step["category"], "query": step["query"],
                                           "date_range": step.get("date_range"), "kind": step.get("kind"),
                                           "market": bool(step.get("market"))}
        run["last_search_at"] = now_iso()
        return True
    except CallLimitExceeded as e:
        _record_error(run, f"search:{step['key']}", e)
        return False
    except LinerAPIError as e:
        _record_error(run, f"search:{step['key']}", e)
        if e.status in (401, 402):
            raise
        return False


def search_runs(run: dict) -> list[dict]:
    out = []
    for key, resp in run["searches"].items():
        m = run["search_meta"].get(key, {})
        out.append({"key": key, "category": m.get("category", "profile"), "query": m.get("query", ""),
                    "results": (resp or {}).get("results") or [], "market": m.get("market", False)})
    return out


def rebuild_sources(run: dict) -> None:
    """검색·Agent 결과를 URL 기준으로 병합하고 관련 없는 자료/유사 상호/중복 기사를 제외 표시한다."""
    prof = [r for sr in search_runs(run) if sr["category"] == "profile" for r in sr["results"]]
    ident = src.build_identity(run["company"], run["options"].get("hints"), prof)
    run["identity"] = ident
    run["sources"] = src.build_sources(search_runs(run), run["agent"].get("references") or [], ident)


def run_analysis(company: str, country: str, client: LinerClient, progress: Progress | None = None,
                 options: dict | None = None, fetcher: fetcher_mod.Fetcher | None = None) -> dict:
    """Search(분야별, 한도 내) → Agent(선택, 1회) → 출처 통합 → 원문 확인 → 카테고리별 Model(최대 6회) → 통합."""
    say = progress or (lambda m: None)
    opts = default_options(**(options or {}))
    run = new_run(company, country, opts)
    t_start = time.perf_counter()
    reserve = 1 if opts.get("reserve_premium", True) else 0
    budget = max(min(opts["search_budget"], client.remaining("search")) - reserve, 0)
    core = [p for p in planner.build_search_plan(company, country, budget=budget, year=date.today().year,
                                                 date_ranges=opts["date_ranges"]) if p["group"] == "core"]
    run["search_plan"] = list(core)
    done: set[str] = set()
    own_fetcher = fetcher is None
    try:
        # 1) 핵심 주제 검색
        for step in core:
            if client.remaining("search") <= reserve:
                break
            if _do_search(run, client, step, say):
                done.add(step["key"])
        ok = len(run["searches"])
        rebuild_sources(run)
        ident = run["identity"]

        # 2) Search Agent (선택, 1회)
        if opts["use_agent"] and ok:
            run_agent(run, client, progress)
            rebuild_sources(run)

        # 3) 경쟁사 후속 + 확장 검색 (남은 한도 내)
        names = planner.extract_competitor_names([run["agent"].get("answer") or ""], company,
                                                 (opts["hints"].get("competitors") or "").replace("/", ",").split(","))
        run["competitor_names"] = names
        full = planner.build_search_plan(company, country, budget=budget, competitors=names, year=date.today().year,
                                         date_ranges=opts["date_ranges"], identity={**ident, "industry": opts["hints"].get("industry", ""),
                                                                                    "tech": opts["hints"].get("tech", "")})
        run["search_plan"] = full
        for step in full:
            if step["key"] in done:
                continue
            if client.remaining("search") <= reserve:
                break
            if _do_search(run, client, step, say):
                done.add(step["key"])
        all_plan = planner.build_search_plan(company, country, budget=max(budget, config.SEARCH_LIMIT_CHOICES[1]) + 10, competitors=names,
                                             year=date.today().year)
        run["unsearched"] = [{"key": p["key"], "category": p["category"], "query": p["query"],
                              "reason": "검색 호출 한도 도달로 미조사"} for p in all_plan if p["key"] not in run["searches"]]
        ok = len(run["searches"])
        total = max(len(run["search_plan"]), 1)
        run["status"]["search"] = "success" if ok and ok >= len(run["search_plan"]) else "partial" if ok else "failed"
        rebuild_sources(run)

        if ok:
            # 4) 원문 확인
            if opts["fetch_pages"] > 0:
                say("원문 확인 (공개 페이지, robots.txt 준수)")
                fx = fetcher or fetcher_mod.Fetcher(max_pages=opts["fetch_pages"])
                try:
                    for s_ in fetcher_mod.prioritize(run["sources"])[: max(opts["fetch_pages"] * 3, 0)]:
                        if fx.fetched >= fx.max_pages:
                            break
                        run["fetched"][s_["url_key"]] = fx.fetch(s_["url"])
                finally:
                    if own_fetcher:
                        fx.close()
            # 5) 카테고리별 Model + 통합
            run_models(run, client, say)
    except LinerAPIError as e:  # 인증/크레딧 문제: 이후 호출도 모두 실패하므로 중단
        if run["status"]["search"] == "not_run":
            run["status"]["search"] = "partial" if run["searches"] else "failed"
    except Exception as e:  # UI 안정성: 예상치 못한 오류도 기록 후 결과 유지
        run["errors"].append({"stage": "unexpected", "message": f"{type(e).__name__}: {e}", "status": None, "at": now_iso()})
    finally:
        run["calls"] = list(client.calls)
        run["elapsed_total_sec"] = round(time.perf_counter() - t_start, 2)
        run["finished_at"] = now_iso()
    return run


# ---------- 카테고리별 Model ----------
def run_models(run: dict, client: LinerClient, say: Progress) -> None:
    srcs = run["sources"]
    fetched = run["fetched"]
    agent_text, _ = cat.resolve_agent_citations(run["agent"].get("answer") or "", run["agent"].get("references") or [])
    outputs: dict[str, dict] = {}
    notes: list[str] = []
    ok_count = 0
    for c in CATEGORIES:
        usable = cat.sources_for_category(c, srcs)
        own = [s for s in usable if c in s["categories"]]
        if not own:
            run["category_runs"][c] = {"status": "skipped", "reason": f"{CATEGORY_LABELS[c]}: 관련 출처 없음 — 모델 호출 생략"}
            notes.append(f"{CATEGORY_LABELS[c]}: 자료 확보 불가(출처 없음, 모델 호출 생략)")
            continue
        if client.remaining("model") <= 0:
            run["category_runs"][c] = {"status": "skipped", "reason": "Model API 호출 한도 도달"}
            notes.append(f"{CATEGORY_LABELS[c]}: 추가 조사 필요(Model 호출 한도)")
            continue
        extra = {}
        if c == "vc":
            extra = {"경쟁사 후보": run.get("competitor_names") or [],
                     "기존 투자자 후보(앞선 자료)": "자료에서 직접 판단"}
        if c == "support":
            extra = {"오늘 날짜": date.today().isoformat(), "기업 업종/설립/소재": run["options"].get("hints", {})}
        say(f"Model API [{CATEGORY_LABELS[c]}] {len(usable)}개 출처")
        rec_run = {"status": "failed", "model": run["options"]["model"], "category": c, "sources_used": len(usable)}
        run["category_runs"][c] = rec_run
        try:
            data, call = client.responses(cat.build_instructions(c),
                                          cat.build_category_input(c, run["company"], run["country"], run["identity"],
                                                                   srcs, fetched, agent_text, extra),
                                          model=run["options"]["model"], label=f"model:{c}")
            text = extract_output_text(data)
            rec_run.update(model_id=data.get("model"), usage=data.get("usage"), elapsed_sec=call["elapsed_sec"],
                           est_cost_usd=call.get("est_cost_usd"), response_status=data.get("status"))
            if data.get("status") == "incomplete":
                raise ValueError("모델 응답이 max_output_tokens에서 잘렸습니다.")
            raw = an.parse_model_json(text)
            out, n = cat.normalize_category(c, raw, srcs)
            notes += n
            outputs[c] = out
            rec_run["status"] = "success"
            ok_count += 1
        except LinerAPIError as e:
            rec_run["error"] = str(e)
            _record_error(run, f"model:{c}", e)
            notes.append(f"{CATEGORY_LABELS[c]}: 모델 호출 실패 — 추가 조사 필요")
            if e.status in (401, 402):
                break
        except ValueError as e:  # JSON 파싱 실패: 임의 보완 금지
            rec_run["error"] = str(e)
            run["errors"].append({"stage": f"model_parse:{c}", "message": str(e), "status": None, "at": now_iso()})
            notes.append(f"{CATEGORY_LABELS[c]}: 모델 출력 JSON 오류 — 정보를 채우지 않음")
    run["status"]["model"] = ("success" if ok_count == len([r for r in run["category_runs"].values() if r["status"] != "skipped"])
                              and ok_count else "partial" if ok_count else "failed")
    if not run["category_runs"] or all(r["status"] == "skipped" for r in run["category_runs"].values()):
        run["status"]["model"] = "not_run"
    run["analysis"] = assemble(run, outputs, notes)
    run["model_response"] = {"categories": {c: {k: v for k, v in r.items()} for c, r in run["category_runs"].items()}}


def assemble(run: dict, outputs: dict[str, dict], notes: list[str]) -> dict:
    """카테고리 결과를 기존 분석 형식(+신규 필드)으로 통합하고 원문 검증/적격성/Agent 통합을 적용한다."""
    srcs, fetched = run["sources"], run["fetched"]
    verification: list[dict] = []
    for c, out in outputs.items():
        verification += cat.apply_verification(out, srcs, fetched)
    run["verification"] = verification

    facts = (outputs.get("profile", {}).get("facts", []) + outputs.get("finance", {}).get("facts", []))
    # Agent 통합
    a_facts = integrate.agent_facts(run["agent"].get("answer") or "", run["agent"].get("references") or []) \
        if run["agent"].get("status") == "success" else []
    by_origin = {s["url"]: s["origins"] for s in srcs}
    search_side = [f for f in facts if f.get("source_url") and "search" in by_origin.get(f["source_url"], ["search"])]
    recon = integrate.reconcile(search_side, a_facts)
    # 모델이 이미 반영한 Agent 사실은 중복 추가하지 않는다
    existing = {re.sub(r"\W", "", (f.get("value") or "").lower()) for f in facts}
    recon["agent_only_facts"] = [f for f in recon["agent_only_facts"]
                                 if re.sub(r"\W", "", f["value"].lower()) not in existing]
    recon["agent_only"] = len(recon["agent_only_facts"])
    added = integrate.merge_agent_only(facts, recon)
    facts = facts + added
    for f in facts:
        f.setdefault("origin", "model")
    for conf in recon["conflicts"]:  # 충돌 상태 유지: 관련 항목을 conflicting 으로 표시
        key = re.sub(r"[^0-9a-z가-힣]", "", (conf["item"] or "").lower())
        for f in facts:
            if re.sub(r"[^0-9a-z가-힣]", "", (f["item"] or "").lower()) == key and f["status"] != "unavailable":
                f["status"] = "conflicting"
    run["recon"] = recon
    out = {"company_name": next((f["value"] for f in facts if "법인명" in (f["item"] or "") and f["value"]), None),
           "facts": facts, "financials": outputs.get("finance", {}).get("financials", []),
           "competitors": [], "news": [], "vcs": [], "support": [], "notes": notes,
           "existing_investors": [], "vc_candidates": [], "programs": [], "procurement": []}
    for c in outputs.get("competitors", {}).get("competitors", []):
        out["competitors"].append({**c, "reason": c.get("relation"), "financials": c.get("revenue")})
    out["news"] = sorted(outputs.get("news", {}).get("events", []),
                         key=lambda n: str(src.parse_date(n.get("event_date") or n.get("published_date")) or ""), reverse=True)
    vc = outputs.get("vc", {})
    out["existing_investors"], out["vc_candidates"] = vc.get("existing_investors", []), vc.get("candidates", [])
    out["vcs"] = ([{"kind": "existing", "name": v["name"], "focus": v.get("fund"), "funds": v.get("fund"),
                    "portfolio": run["company"], "relevance": f"{v.get('round') or ''} {v.get('date') or ''}".strip(),
                    "competitor_investments": None, "source_urls": v["source_urls"], "status": v["status"]}
                   for v in out["existing_investors"]] +
                  [{"kind": "candidate", "name": v["name"], "focus": v.get("focus"), "funds": v.get("fund"),
                    "portfolio": v.get("similar_investments"), "relevance": v.get("fit"),
                    "competitor_investments": v.get("competitor_investment_detail"), "source_urls": v["source_urls"],
                    "status": v["status"]} for v in out["vc_candidates"]])
    prof = cat.company_profile_for_eligibility(facts, run["country"], run["options"].get("hints"))
    progs = outputs.get("support", {}).get("programs", [])
    cat.apply_eligibility(progs, prof)
    out["programs"], out["procurement"] = progs, outputs.get("support", {}).get("procurement", [])
    out["support"] = [{"name": p["name"], "type": p.get("purpose") or "", "agency": p.get("agency"),
                       "country": run["country"], "period": f"{p.get('start_date') or '?'} ~ {p.get('end_date') or '?'}",
                       "eligibility": p["eligibility"], "url": p.get("url"), "status": p["status"]} for p in progs]
    out["eligibility_profile"] = prof
    if not progs:
        notes.append("현재 신청 가능한 정부지원 공고가 검색되지 않았습니다(결과 없음).")
    return out


# ---------- Search Agent ----------
def run_agent(run: dict, client: LinerClient, progress: Progress | None = None) -> dict:
    """Search Agent (1회). 이미 실행했거나 시도했다면 재호출하지 않는다."""
    if run["status"]["agent"] in ("success", "failed"):
        return run
    (progress or (lambda m: None))("Search Agent API 실행 중 (최대 수 분 소요)")
    lang = config.COUNTRIES.get(run["country"], {"lang": "en"})["lang"]
    try:
        data, rec = client.agent_search(an.build_agent_question(run["company"], run["country"]), lang=lang)
        chunks = data.get("referenceChunks") or data.get("chunks") or []  # 공식 스트리밍 스펙의 근거 구절 필드(이 엔드포인트의 존재 여부는 응답으로 확인)
        run["agent"] = {"status": "success", "answer": data.get("answer") or "",
                        "references": data.get("references") or [], "chunks": chunks,
                        "elapsed_sec": rec["elapsed_sec"], "error": "", "started_at": rec["started_at"],
                        "finished_at": rec.get("finished_at")}
        run["status"]["agent"] = "success"
    except LinerAPIError as e:
        run["agent"]["status"] = "failed"
        run["agent"]["error"] = str(e)
        run["status"]["agent"] = "failed"
        _record_error(run, "agent", e)
    run["calls"] = list(client.calls)
    return run


# ---------- Premium Data 비교 ----------
def run_premium_compare(run: dict, client: LinerClient, progress: Progress | None = None) -> dict:
    """동일 검색어·동일 결과 수로 일반 1회 + Premium 1회. 기존 일반 결과가 있으면 재사용한다."""
    say = progress or (lambda m: None)
    if run["status"].get("premium") in ("success", "failed"):
        return run
    plan = [p for p in run["search_plan"] if p["key"] in run["searches"]] or run["search_plan"]
    step = next((p for p in plan if p["key"] == "finance"), plan[0] if plan else None)
    if step is None:
        run["premium"] = {"status": "failed", "error": "비교할 검색어가 없습니다."}
        return run
    n = run["options"]["max_results"]
    normal = run["searches"].get(step["key"])
    normal_call = next((c for c in run["calls"] if c.get("label") == f"search:{step['key']}" and c.get("ok")), None)
    reused = normal is not None
    try:
        if not reused:
            say("일반 검색 (비교 기준)")
            normal, normal_call = client.search_web(step["query"], country_code=step["country_code"], lang=step["lang"],
                                                    date_range=step.get("date_range"), label=f"search:{step['key']}",
                                                    max_results=n, include_knowledge=False,
                                                    meta={"topic": step["key"], "category": step["category"]})
            run["searches"][step["key"]] = normal
        say("Premium Data 검색 (include_knowledge=true)")
        prem, prem_call = client.search_web(step["query"], country_code=step["country_code"], lang=step["lang"],
                                            date_range=step.get("date_range"), label=f"premium:{step['key']}",
                                            max_results=n, include_knowledge=True,
                                            meta={"topic": step["key"], "category": step["category"]})
        cmp_ = integrate.compare_premium(normal, prem, run["identity"] or {"names": [run["company"]]},
                                         normal_call, prem_call, reused)
        run["premium"] = {"status": "success", "query": step["query"], "topic": step["key"], "max_results": n,
                          "response": prem, "comparison": cmp_}
        run["status"]["premium"] = "success"
    except LinerAPIError as e:
        run["premium"] = {"status": "failed", "error": str(e)}
        run["status"]["premium"] = "failed"
        _record_error(run, "premium", e)
    run["calls"] = list(client.calls)
    return run


# ---------- 품질 지표 ----------
def _ratio(n: int, d: int) -> float | None:
    return round(n / d, 3) if d else None


def _is_recent(d: str | None, days: int = 365) -> bool:
    x = src.parse_date(d)
    return bool(x) and 0 <= (date.today() - x).days <= days


def quality_metrics(run: dict) -> dict:
    results = [r for sr in search_runs(run) for r in sr["results"]]
    urls = [r.get("url") for r in results if r.get("url")]
    srcs = run.get("sources") or []
    used = [s_ for s_ in srcs if s_.get("use")]
    a = run["analysis"]
    facts = an.build_facts_table(a)
    by_status: dict[str, int] = {}
    for f in facts:
        by_status[f["status"]] = by_status.get(f["status"], 0) + 1
    agent_refs = run["agent"].get("references") or []
    s_hosts = {r.get("hostname") for r in results if r.get("hostname")}
    a_hosts = {r.get("hostname") for r in agent_refs if isinstance(r, dict) and r.get("hostname")}
    calls = run.get("calls", [])
    ok_calls = [c for c in calls if c.get("ok")]
    fetched = list((run.get("fetched") or {}).values())
    fetched_ok = [f for f in fetched if f.get("ok")]
    vr = run.get("verification") or []
    years = sorted({f["year"] for f in a["financials"] if f["metric"] == "revenue"})
    comps = a.get("competitors") or []
    quant = [c for c in comps if c.get("revenue") or c.get("employees") or c.get("funding")]
    news_recent = [n for n in a.get("news", []) if _is_recent(n.get("event_date") or n.get("published_date"))]
    open_progs = [p for p in a.get("programs", []) if p.get("eligibility") in ("신청 가능 확인", "조건부 가능", "자격 확인 필요")]
    cats = {}
    for c in CATEGORIES:
        rows = [f for f in facts if f["category"] == {"competitors": "competitor", "vc": "vc", "support": "support"}.get(c, c)
                or (c == "finance" and f["category"] in ("finance", "funding", "employees"))]
        if c == "news":
            rows = [f for f in facts if f["category"] == "news"]
        have = [f for f in rows if f["status"] != "unavailable"]
        cats[c] = {"label": CATEGORY_LABELS[c], "items": len(rows), "obtained": len(have), "rate": _ratio(len(have), len(rows))}
    rec = run.get("recon") or {}
    cost_by_kind: dict[str, float] = {}
    for c in ok_calls:
        k = "premium" if c.get("include_knowledge") else c["kind"]
        cost_by_kind[k] = round(cost_by_kind.get(k, 0) + (c.get("est_cost_usd") or 0), 6)
    return {
        "search_result_count": len(results), "unique_urls": len(set(urls)),
        "unique_urls_after_dedupe": len(srcs), "relevant_sources": len(used),
        "relevant_ratio": _ratio(len(used), len(srcs)),
        "excluded_sources": [{"url": s_["url"], "reason": s_["excluded_reason"]} for s_ in srcs if not s_.get("use")][:50],
        "results_with_date": sum(1 for r in results if r.get("date")),
        "facts_total": len(facts), "facts_by_status": by_status,
        "facts_with_source": sum(1 for f in facts if f["source_url"]),
        "facts_unavailable": by_status.get("unavailable", 0),
        "facts_confirmed": by_status.get("confirmed", 0),
        "financial_points": len(a["financials"]), "financial_years": years, "financial_year_count": len(years),
        "fetch_attempted": len(fetched), "fetch_ok": len(fetched_ok),
        "verified_ratio": _ratio(sum(1 for v in vr if v["verified"]), len(vr)),
        "verified_items": sum(1 for v in vr if v["verified"]), "verification_items": len(vr),
        "conflict_count": len(rec.get("conflicts") or []) + by_status.get("conflicting", 0),
        "recent_news_count": len(news_recent), "news_total": len(a.get("news", [])),
        "competitor_count": len(comps), "competitors_with_quant": len(quant),
        "competitor_quant_ratio": _ratio(len(quant), len(comps)),
        "existing_investor_count": len(a.get("existing_investors", [])),
        "new_vc_candidates": len(a.get("vc_candidates", [])),
        "open_support_programs": len(open_progs), "procurement_count": len(a.get("procurement", [])),
        "category_coverage": cats,
        "agent_answer_chars": len(run["agent"].get("answer") or ""),
        "agent_reference_count": len(agent_refs), "agent_unique_hosts": len(a_hosts), "search_unique_hosts": len(s_hosts),
        "integration": {"search_unique_facts": rec.get("search_unique"), "agent_unique_facts": rec.get("agent_unique"),
                        "common_facts": rec.get("common"), "agent_only_facts": rec.get("agent_only"),
                        "conflicting_facts": len(rec.get("conflicts") or []), "final_facts": len(facts)},
        "call_counts": {k: sum(1 for c in calls if c["kind"] == k) for k in ("search", "model", "agent")},
        "premium_calls": sum(1 for c in calls if c.get("include_knowledge")),
        "total_elapsed_sec": run.get("elapsed_total_sec") or round(sum(c.get("elapsed_sec") or 0 for c in calls), 2),
        "api_elapsed_sec": round(sum(c.get("elapsed_sec") or 0 for c in calls), 2),
        "total_est_cost_usd": round(sum(c.get("est_cost_usd") or 0 for c in ok_calls), 6),
        "est_cost_by_kind": cost_by_kind,
    }


# ---------- 저장 ----------
def _write_csv(path: Path, rows: list[dict], columns: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as f:  # Excel 한글 호환 BOM
        w = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: (";".join(map(str, v)) if isinstance(v, list) else v) for k, v in r.items()})


def _write_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def search_comparison_rows(run: dict) -> list[dict]:
    """검색어별 일반 Search / Premium / Search Agent 비교."""
    rows = []
    agent_urls = {s_["url_key"] for s_ in run.get("sources", []) if "agent" in s_["origins"]}
    seen_before: set[str] = set()
    for sr in search_runs(run):
        keys = [src.normalize_url(r.get("url", "")) for r in sr["results"] if r.get("url")]
        rel = [k for k in keys if any(s_["url_key"] == k and s_.get("use") for s_ in run.get("sources", []))]
        new = [k for k in keys if k not in seen_before]
        seen_before |= set(keys)
        prem = run.get("premium", {}) if run.get("premium", {}).get("topic") == sr["key"] else {}
        pc = prem.get("comparison") or {}
        rows.append({"topic": sr["key"], "category": sr["category"], "query": sr["query"], "api": "search",
                     "result_count": len(keys), "relevant_count": len(rel), "relevance_ratio": _ratio(len(rel), len(keys)),
                     "new_urls": len(new), "agent_overlap_urls": len(set(keys) & agent_urls),
                     "premium_result_count": pc.get("premium_result_count", ""),
                     "premium_knowledge_tables": pc.get("knowledge_tables", ""),
                     "premium_new_sources": pc.get("new_source_count", ""), "premium_verdict": pc.get("verdict", "")})
    ag = run.get("agent", {})
    if ag.get("status") == "success":
        rec = run.get("recon") or {}
        rows.append({"topic": "agent", "category": "all", "query": "search_agent(종합 질의)", "api": "agent",
                     "result_count": len(ag.get("references") or []), "relevant_count": len(agent_urls),
                     "relevance_ratio": "", "new_urls": len([s_ for s_ in run.get("sources", [])
                                                             if s_["origins"] == ["agent"]]),
                     "agent_overlap_urls": "", "premium_result_count": "", "premium_knowledge_tables": "",
                     "premium_new_sources": "", "premium_verdict": f"Agent 단독 신규 사실 {rec.get('agent_only', 0)}건"})
    return rows


def build_quality_report(run: dict, m: dict) -> str:
    st = run["status"]
    opts = run.get("options", {})
    L = ["# Liner API 정보 수집 품질 보고서", "",
         f"- 실행 ID: `{run['run_id']}` / 로직 버전 `{run.get('logic_version')}`",
         f"- 기업: {run['company']} ({run['country']})",
         f"- 전체 분석 시작·종료: {run['started_at']} ~ {run['finished_at']} (소요 {m['total_elapsed_sec']}초, API 응답시간 합 {m['api_elapsed_sec']}초)",
         f"- 마지막 검색 시각: {run.get('last_search_at') or '검색 없음'}",
         f"- 설정: 검색 한도 {opts.get('search_budget')}회 / 결과 수 {opts.get('max_results')} / Agent {'사용' if opts.get('use_agent') else '미사용'} / 모델 {opts.get('model')}",
         f"- Mock 데이터 여부: {'예 (실제 조사 결과 아님)' if run['is_mock'] else '아니오'}", "",
         "## API 상태", f"- Search: {st['search']} / Model: {st['model']} / Agent: {st['agent']} / Premium: {st.get('premium')}", "",
         "## 수집량",
         f"- 검색 결과 {m['search_result_count']}건, 고유 URL {m['unique_urls']}, 중복 제거 후 {m['unique_urls_after_dedupe']}, 관련 자료 {m['relevant_sources']} ({m['relevant_ratio']})",
         f"- 추출 사실 {m['facts_total']}건 (출처 URL 보유 {m['facts_with_source']}, 확보 불가 {m['facts_unavailable']}, 원문 확인 {m['facts_confirmed']})",
         f"- 상태별: {m['facts_by_status']}",
         f"- 재무 수치 {m['financial_points']}건, 확보 연도 {m['financial_years']} ({m['financial_year_count']}개년)",
         f"- 최근 1년 뉴스 {m['recent_news_count']}건 / 전체 {m['news_total']}건",
         f"- 경쟁사 {m['competitor_count']}곳 (정량정보 확보 {m['competitors_with_quant']}곳, {m['competitor_quant_ratio']})",
         f"- 기존 투자자 {m['existing_investor_count']}건, 신규 VC 후보 {m['new_vc_candidates']}건",
         f"- 현재 신청 가능/가능성 있는 지원사업 {m['open_support_programs']}건, 공공입찰 {m['procurement_count']}건", "",
         "## 원문 검증",
         f"- 원문 접근 시도 {m['fetch_attempted']}건 / 성공 {m['fetch_ok']}건",
         f"- 검증 대상 항목 {m['verification_items']}건 중 원문 확인 {m['verified_items']}건 (검증률 {m['verified_ratio']})",
         f"- 출처 불일치 {m['conflict_count']}건", "",
         "## Search API ↔ Search Agent 통합", *[f"- {k}: {v}" for k, v in m["integration"].items()], "",
         "## 카테고리별 정보 확보율", *[f"- {v['label']}: {v['obtained']}/{v['items']} ({v['rate']})" for v in m["category_coverage"].values()], "",
         "## Premium Data"]
    pc = (run.get("premium") or {}).get("comparison")
    if pc:
        L += [f"- 판정: {pc['verdict']}", f"- 결과 수 일반 {pc['normal_result_count']} / Premium {pc['premium_result_count']}, knowledge 표 {pc['knowledge_tables']}개(대상 기업 관련 {pc['company_related_tables']})",
              f"- 신규 출처 {pc['new_source_count']}건, 재무·투자 데이터 추가 {pc['financial_or_investment_data_added']}",
              f"- 응답시간 일반 {pc['normal_elapsed_sec']}초 / Premium {pc['premium_elapsed_sec']}초, 비용 일반 {pc['normal_cost_usd']} / Premium {pc['premium_cost_usd']} USD(추정)"]
    else:
        L.append(f"- 실행하지 않음 또는 실패: {(run.get('premium') or {}).get('status')} {(run.get('premium') or {}).get('error', '')}")
    L += ["", "## 호출·비용", f"- 호출 수: {m['call_counts']}, Premium 호출 {m['premium_calls']}",
          f"- 추정 비용 ${m['total_est_cost_usd']} {m['est_cost_by_kind']} (공식 단가 기반 추정치, 실제 청구액과 다를 수 있음)", "",
          "## 미조사 항목(호출 한도)", *([f"- {u['key']}: {u['reason']}" for u in run.get("unsearched", [])] or ["- 없음"]), "",
          "## 오류", *([f"- [{e['stage']}] {e['message']}" for e in run["errors"]] or ["- 없음"]), "",
          "## 참고", *[f"- {n}" for n in run["analysis"].get("notes", [])],
          "- 원문 본문에서 값이 확인되지 않은 사실은 confirmed로 분류하지 않았습니다."]
    return "\n".join(L) + "\n"


def coverage_report(run: dict, m: dict) -> dict:
    targets = {"profile": ["정식 법인명", "설립일", "창업자", "대표이사", "본사", "주요 제품", "핵심 기술"],
               "finance": ["매출액(3개년)", "영업이익", "순이익", "직원수", "누적 투자유치"],
               "competitors": ["경쟁사 3곳 이상", "경쟁사 정량정보"], "news": ["최근 1년 뉴스 3건 이상"],
               "vc": ["기존 투자자", "신규 VC 후보"], "support": ["현재 신청 가능한 지원사업", "공공입찰"]}
    a = run["analysis"]
    actual = {"finance.매출액(3개년)": m["financial_year_count"], "competitors.경쟁사 3곳 이상": m["competitor_count"],
              "competitors.경쟁사 정량정보": m["competitors_with_quant"], "news.최근 1년 뉴스 3건 이상": m["recent_news_count"],
              "vc.기존 투자자": m["existing_investor_count"], "vc.신규 VC 후보": m["new_vc_candidates"],
              "support.현재 신청 가능한 지원사업": m["open_support_programs"], "support.공공입찰": m["procurement_count"]}
    for f in a["facts"]:
        for c, ts in targets.items():
            for t in ts:
                if t.split("(")[0] in (f["item"] or "") and f["value"] and f["status"] != "unavailable":
                    actual[f"{c}.{t}"] = actual.get(f"{c}.{t}", 0) + 1
    return {"run_id": run["run_id"], "categories": {
        c: {"label": CATEGORY_LABELS[c], "targets": [{"target": t, "obtained": actual.get(f"{c}.{t}", 0),
                                                       "status": "확보" if actual.get(f"{c}.{t}", 0) else "자료 확보 불가/추가 조사 필요"}
                                                      for t in ts], "metrics": m["category_coverage"][c]}
        for c, ts in targets.items()}, "unsearched": run.get("unsearched", [])}


def load_baseline(results_dir: Path) -> dict | None:
    p = results_dir / config.BASELINE_RUN_ID / "run_manifest.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def improvement_comparison(run: dict, m: dict, results_dir: Path) -> str:
    base = load_baseline(results_dir)
    if not base:
        return f"# 개선 비교\n\n기준자료({config.BASELINE_RUN_ID})가 없어 비교하지 못했습니다.\n"
    b = base.get("metrics", {})
    bc = base.get("calls_made")
    rows = [("검색 결과 수", b.get("search_result_count"), m["search_result_count"]),
            ("고유 URL 수", b.get("unique_urls"), m["unique_urls"]),
            ("추출 사실 수", b.get("facts_total"), m["facts_total"]),
            ("원문 확인 사실 수(confirmed)", (b.get("facts_by_status") or {}).get("confirmed", 0), m["facts_confirmed"]),
            ("재무 수치(건)", b.get("financial_points"), m["financial_points"]),
            ("재무 확보 연도 수", "1(2025만, 1차 기록 기준)" if b.get("financial_points") else 0, m["financial_year_count"]),
            ("경쟁사 정량정보 확보", "0(1차 기록상 재무·직원 없음)", m["competitors_with_quant"]),
            ("최근 1년 뉴스", "1차 결과 파일로 별도 산정 불가", m["recent_news_count"]),
            ("신규 VC 후보", "0(1차는 기존 투자자만 추천)", m["new_vc_candidates"]),
            ("지원사업 추천", 0, m["open_support_programs"]),
            ("원문 검증률", "0(원문 미확인)", m["verified_ratio"]),
            ("API 호출 수", bc, sum(m["call_counts"].values())),
            ("추정 비용(USD)", b.get("total_est_cost_usd"), m["total_est_cost_usd"]),
            ("총 소요(초)", b.get("total_elapsed_sec"), m["total_elapsed_sec"])]
    L = ["# 1차 테스트 대비 개선 비교", "", f"- 기준: `{config.BASELINE_RUN_ID}` (기록을 그대로 읽음, 수정하지 않음)",
         f"- 개선 실행: `{run['run_id']}` ({run['company']})", "", "| 항목 | 1차 | 개선 후 |", "|---|---|---|"]
    L += [f"| {a} | {x} | {y} |" for a, x, y in rows]
    L += ["", "※ 1차 수치 중 괄호 표기는 1차 결과 파일의 해당 항목 기록을 근거로 한 해석이며, 값이 없는 항목은 산정 불가로 표시했다.",
          "※ 비용은 공식 단가 기반 추정치다."]
    return "\n".join(L) + "\n"


def find_secret_leaks(out: Path, secrets: list[str]) -> list[str]:
    """결과 폴더(ZIP 내부 포함)에서 키/토큰 문자열 노출을 검사한다."""
    leaks = []
    pats = [re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}"), re.compile(r"(?i)x-api-key['\"]?\s*[:=]\s*['\"]?(?!\*\*\*)[A-Za-z0-9._\-]{8,}")]
    def scan(name: str, text: str) -> None:
        for sct in secrets:
            if sct and sct in text:
                leaks.append(f"{name}: API 키 문자열")
        for p in pats:
            if p.search(text):
                leaks.append(f"{name}: 인증 헤더 패턴")
    for f in out.iterdir():
        if f.suffix == ".zip":
            with zipfile.ZipFile(f) as z:
                for n in z.namelist():
                    scan(f"{f.name}/{n}", z.read(n).decode("utf-8", errors="ignore"))
        else:
            scan(f.name, f.read_text(encoding="utf-8", errors="ignore"))
    return leaks


def save_results(run: dict, secrets: list[str], results_dir: Path | None = None) -> Path:
    """결과 파일을 results/<실행ID>/ 에 저장한다(실행 ID별 폴더 — 다른 실행 결과는 건드리지 않음)."""
    base = results_dir or config.RESULTS_DIR
    out = base / run["run_id"]
    out.mkdir(parents=True, exist_ok=True)
    safe = lambda o: an.scrub(o, secrets)  # noqa: E731
    a = run["analysis"]
    m = quality_metrics(run)

    _write_json(out / "raw_api_responses.json", safe({
        "is_mock": run["is_mock"], "search_plan": run["search_plan"], "search_meta": run["search_meta"],
        "search": run["searches"], "model": run["model_response"], "search_agent": run["agent"],
        "premium": run.get("premium"), "unsearched": run.get("unsearched", [])}))
    _write_json(out / "company_profile.json", safe({
        "company_input": run["company"], "company_name": a["company_name"], "country": run["country"],
        "is_mock": run["is_mock"], "identity": run.get("identity"), "facts": a["facts"], "financials": a["financials"],
        "eligibility_profile": a.get("eligibility_profile"), "notes": a.get("notes", [])}))
    _write_csv(out / "news_events.csv", safe(a["news"]),
               ["title", "published_date", "event_date", "event_type", "commitment_level", "summary", "source_urls", "status"])
    _write_csv(out / "competitors.csv", safe(a["competitors"]),
               ["name", "relation", "products", "revenue", "employees", "funding", "as_of", "source_urls", "status", "missing_reason"])
    vs = ([{"kind": "existing_investor", **v} for v in a.get("existing_investors", [])] +
          [{"kind": "vc_candidate", **v} for v in a.get("vc_candidates", [])] +
          [{"kind": "support", **p} for p in a.get("programs", [])] +
          [{"kind": "procurement", **p} for p in a.get("procurement", [])])
    _write_csv(out / "vc_and_support.csv", safe(vs),
               ["kind", "name", "date", "round", "amount", "fund", "focus", "fund_purpose", "similar_investments", "stage",
                "recent_activity", "fit", "competitor_investment", "competitor_investment_detail", "remaining_capital",
                "new_investment_status", "agency", "purpose", "target", "self_burden", "start_date", "end_date",
                "max_company_age_years", "region_restriction", "industry_restriction", "size_restriction", "budget",
                "deadline", "eligibility", "eligibility_reasons", "url", "source_urls", "status"])
    _write_csv(out / "extracted_facts.csv", safe(an.build_facts_table(a)),
               ["category", "item", "value", "as_of", "source_url", "source_type", "status", "status_label", "origin"])
    _write_csv(out / "api_calls.csv", safe(run["calls"]),
               ["call_no", "kind", "label", "topic", "query", "max_results", "include_knowledge", "result_count",
                "knowledge_count", "endpoint", "attempt", "started_at", "finished_at", "http_status", "ok", "elapsed_sec",
                "request_id", "input_tokens", "output_tokens", "total_tokens", "est_cost_usd", "error"])
    _write_csv(out / "search_comparison.csv", safe(search_comparison_rows(run)),
               ["topic", "category", "query", "api", "result_count", "relevant_count", "relevance_ratio", "new_urls",
                "agent_overlap_urls", "premium_result_count", "premium_knowledge_tables", "premium_new_sources", "premium_verdict"])
    vrows = list(run.get("verification") or [])
    for u, f in (run.get("fetched") or {}).items():
        if not any(v["url"] == f["url"] for v in vrows):
            vrows.append({"category": "", "item": "(원문 접근)", "value": "", "url": f["url"], "source_type": "",
                          "fetch_status": f["status"], "http_status": f.get("http_status"), "verified": False,
                          "evidence_text": "", "failure_reason": f.get("reason", "")})
    _write_csv(out / "source_verification.csv", safe(vrows),
               ["category", "item", "value", "url", "source_type", "fetch_status", "http_status", "verified",
                "evidence_text", "failure_reason"])
    _write_json(out / "coverage_report.json", safe(coverage_report(run, m)))
    (out / "quality_report.md").write_text(an.scrub(build_quality_report(run, m), secrets), encoding="utf-8")
    (out / "improvement_comparison.md").write_text(an.scrub(improvement_comparison(run, m, base), secrets), encoding="utf-8")
    _write_json(out / "run_manifest.json", safe({
        "run_id": run["run_id"], "company": run["company"], "country": run["country"],
        "started_at": run["started_at"], "finished_at": run["finished_at"], "last_search_at": run.get("last_search_at"),
        "is_mock": run["is_mock"], "logic_version": run.get("logic_version"), "cache_key": run.get("cache_key"),
        "options": run.get("options"),
        "environment": {"python": sys.version.split()[0], "platform": platform.platform(), "app_version": config.APP_VERSION},
        "status": run["status"], "search_result_counts": {k: len((v or {}).get("results") or []) for k, v in run["searches"].items()},
        "call_limits": {"search": config.MAX_SEARCH_CALLS, "search_extended": config.MAX_SEARCH_CALLS_EXTENDED,
                        "model": config.MAX_MODEL_CALLS, "agent": config.MAX_AGENT_CALLS, "premium": config.MAX_PREMIUM_CALLS},
        "calls_made": len(run["calls"]), "errors": run["errors"], "metrics": m}))

    zpath = out / "analysis_bundle.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(out.iterdir()):
            if p.name != "analysis_bundle.zip":
                z.write(p, p.name)
    leaks = find_secret_leaks(out, secrets)
    run["secret_leaks"] = leaks
    return out
