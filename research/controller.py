"""통합 분석 컨트롤러: 기업명 하나로 6단계를 순서대로 실행한다. 한 단계가 실패해도 다음 단계를 계속한다.

결과는 하나의 dict(공통 데이터 구조)에 쌓이고, 앞 단계 결과(기업 프로필·경쟁사·기술 키워드)를 뒤 단계가 재사용한다.
같은 요청은 research/common 파일 캐시로 재사용하므로, 다시 실행해도 이미 받은 자료는 다시 호출하지 않는다.
"""
from __future__ import annotations

import json
import queue
import re
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import analysis
import config
from research import common, company, funding_history, funding_view, gov, news, papers, patents, public_data
from research.liner import CONCURRENCY as LINER_CONCURRENCY, Liner

STEPS = [
    ("profile", "① 기업 기본정보·핵심 기술·경쟁사 분석"),
    ("target", "② 대상기업 재무실적·고용·뉴스 수집"),
    ("rivals", "③ 경쟁사 재무실적·고용·뉴스 수집"),
    ("tech", "④ 기술 분야별 논문·연구동향 분석"),
    ("gov", "⑤ 정부지원사업·나라장터 입찰공고 수집"),
    ("funding", "⑥ 펀딩노트 VC·정책상품 분석"),
]
MAX_TECH = 6           # 논문 검색할 기술 분야 수
MAX_RIVALS = 5
RIVAL_NEWS_PAGES = 1
# 병렬 실행 작업 수(초기값). 실제 요청 수는 common.LIMITS(공공 API·NAVER·OpenAlex)와 liner.CONCURRENCY 가 다시 묶는다
TOP_WORKERS = 5        # ②③④⑤ + ⑥(회사 조회 결과 대기)
RIVAL_WORKERS = 3      # 경쟁사 동시 수집
TECH_WORKERS = 4       # 기술 키워드·기업 논문 동시 수집


def _short(e: Exception) -> str:
    return common.scrub_text(f"{type(e).__name__}: {str(e)[:200]}")


def _aliases(prof: dict, corp: dict | None) -> list[str]:
    out = [prof.get("name_ko") or "", prof.get("name_en") or "", *(prof.get("aliases") or [])]
    if corp:
        out += [re.sub(r"주식회사|\(주\)|㈜", "", n).strip() for n in corp.get("names") or []]
        out.append(corp.get("name_en") or "")
    # 너무 일반적인 짧은 영문(AI 등)은 뉴스 매칭에 쓰지 않는다
    return [a for a in dict.fromkeys(a.strip() for a in out) if len(a) >= 2 and a.lower() not in ("ai", "inc", "inc.")]


def run(name: str, progress=None, step_done=None, step_start=None) -> dict:
    """progress(msg): 진행 문구. step_done(key, status, idx): 단계 완료 알림(완료되는 순서대로). step_start(key, idx): 단계 시작 알림.

    실행 구조(병렬):
      t=0  ⑥의 펀딩노트 회사 조회(회사명만 필요)를 백그라운드로 시작
           ① 기업 식별·프로필·국내 경쟁사(나머지 단계의 공통 입력) — 메인 스레드
      ① 후 ②③④⑤ 와 ⑥ 나머지(회사 조회 결과 대기)를 동시에 실행(TOP_WORKERS)
    콜백(progress/step_done/step_start)은 모두 호출한 스레드(메인)에서만 부른다. 작업 스레드의 진행 문구는 큐로 모은다.
    """
    say_main = progress or (lambda m: None)
    done = step_done or (lambda k, s, i: None)
    started = step_start or (lambda k, i: None)
    main_thread = threading.get_ident()
    msgs: queue.Queue = queue.Queue()

    def say(m: str) -> None:
        if threading.get_ident() == main_thread:
            say_main(m)
        else:
            msgs.put(("msg", m))

    def drain() -> None:
        while True:
            try:
                kind, *rest = msgs.get_nowait()
            except queue.Empty:
                return
            if kind == "msg":
                say_main(rest[0])
            elif kind == "start":
                started(*rest)
            elif kind == "done":
                done(*rest)

    t0 = time.time()
    liner = Liner.from_env()
    lock = threading.Lock()
    R: dict = {"company": name.strip(), "started_at": datetime.now().isoformat(timespec="seconds"), "steps": {},
               "keys": common.key_status(), "errors": [], "execution": "parallel"}
    R["_lock"] = lock
    if not liner.ok:
        R["errors"].append("LINER_API_KEY 가 없어 Liner 분석(기업 프로필·요약·학술 검색)을 건너뜁니다.")

    def step(idx: int, fn, start_t: float | None = None):
        key, label = STEPS[idx]
        notify = (lambda *a: msgs.put(a)) if threading.get_ident() != main_thread else None
        (notify("start", key, idx) if notify else started(key, idx))
        say(f"{label} 시작")
        st = time.time()
        try:
            fn()
            status = "완료"
        except Exception as e:  # 한 단계 실패가 전체를 멈추지 않게 한다
            with lock:
                R["errors"].append(f"[{label}] {_short(e)}")
                R.setdefault("tracebacks", []).append(common.scrub_text(traceback.format_exc()[-1500:]))
            status = "실패"
        end = time.time()
        begin = st if start_t is None else start_t
        with lock:
            R["steps"][key] = {"label": label, "status": status, "sec": round(end - begin, 1),
                               "start_offset_sec": round(begin - t0, 1), "end_offset_sec": round(end - t0, 1)}
        (notify("done", key, status, idx) if notify else done(key, status, idx))

    def add_errors(lst: list[str]) -> None:
        with lock:
            R["errors"].extend(lst)

    # t=0: 펀딩노트 회사 조회(⑥의 유료 조회, 회사명만 필요)를 먼저 시작한다. 내용·검색 범위는 기존과 같다
    side = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lookup")

    def lookup_job():
        return funding_view.company_lookup(name.strip(), progress=lambda m: say(f"펀딩노트: {m}"))
    lookup_future = side.submit(lookup_job)

    # ① 기업 식별·프로필·경쟁사·키워드(공통 입력이라 먼저 끝낸다)
    def s1():
        R["profile"] = company.analyze(name.strip(), liner, say)
        add_errors([f"[①] {e}" for e in R["profile"]["errors"]])
    step(0, s1)
    drain()
    prof = (R.get("profile") or {}).get("profile") or {}
    corp = (R.get("profile") or {}).get("corp")
    aliases = _aliases(prof, corp) or [name.strip()]
    R["aliases"] = aliases
    rivals_in = (prof.get("competitors") or [])[:MAX_RIVALS]

    # ② 대상기업 재무·고용·뉴스·투자유치
    def s2():
        t: dict = {}
        if corp or prof.get("is_korean", True):
            t["public"] = public_data.company_bundle(name.strip(), prof.get("name_en") or "", say)
            say("국민연금 가입자 수집 완료" if (t["public"].get("nps") or {}).get("monthly") else "국민연금 가입자 자료 없음")
        say("네이버 뉴스 검색 중...")
        t["news"] = news.collect(name.strip(), aliases, liner)
        say(f"뉴스 {len(t['news']['articles'])}건 정리 완료, 주요 사건 요약 중(Liner)...")
        # 뉴스 요약(모델)과 투자유치 이력(Premium)은 서로 독립이라 동시에 부른다
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="s2") as ex:
            f_sum = ex.submit(news.summarize, name.strip(), t["news"]["articles"], liner)
            f_fh = ex.submit(_funding_history,
                             [funding_history.company_entry(name.strip(), prof.get("name_en") or (corp or {}).get("name_en") or "",
                                                            aliases=aliases, homepage=(corp or {}).get("homepage") or "",
                                                            is_korean=bool(corp) or prof.get("is_korean", True))],
                             {name.strip(): t.get("news")}, liner, say, R, "target")
            t["news_summary"] = f_sum.result()
            t["funding_history"] = f_fh.result()
        R["target"] = t

    # ③ 국내 경쟁사(기업별 독립 수집 → 원래 순서대로 통합)
    def rival_one(c: dict) -> dict:
        cname = c.get("name") or ""
        say(f"경쟁사 {cname} 수집 중...")
        item = {"info": c, "public": None, "news": None, "errors": []}
        if c.get("is_korean"):
            reg = c.get("registered_name_ko") or cname
            try:
                item["public"] = public_data.company_bundle(reg, c.get("name_en") or "")
                if not item["public"].get("corp") and reg != cname:
                    item["public"] = public_data.company_bundle(cname, c.get("name_en") or "")
            except Exception as e:
                item["errors"].append(_short(e))
        try:
            al = [a for a in (cname, c.get("name_en"), c.get("registered_name_ko")) if a]
            item["news"] = news.collect(cname, al, liner if not c.get("is_korean") else None,
                                        extra_queries=["투자", "계약", "출시"], naver_pages=RIVAL_NEWS_PAGES, liner_queries=1)
        except Exception as e:
            item["errors"].append(_short(e))
        return item

    def s3():
        with ThreadPoolExecutor(max_workers=RIVAL_WORKERS, thread_name_prefix="rival") as ex:
            rows = list(ex.map(rival_one, rivals_in))  # map 은 입력 순서를 지킨다
        R["rivals"] = rows
        if not rows:
            return
        fh_in = [funding_history.company_entry(r["info"].get("name") or "", r["info"].get("name_en") or "",
                                               registered=r["info"].get("registered_name_ko") or "",
                                               homepage=((r.get("public") or {}).get("corp") or {}).get("homepage") or "",
                                               is_korean=bool(r["info"].get("is_korean"))) for r in rows if r["info"].get("name")]
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="s3") as ex:
            f_fh = ex.submit(_funding_history, fh_in, {r["info"].get("name"): r.get("news") for r in rows}, liner, say, R, "rivals")
            f_sum = ex.submit(summarize_rivals, name.strip(), rows, liner) if liner.ok else None
            if f_sum:
                say("경쟁사 사업·제품·최근 변화 요약 중(Liner)...")
            fh = f_fh.result()
            for r in rows:
                r["funding_history"] = (fh.get("by_company") or {}).get(r["info"].get("name"))
            R["rivals_funding_meta"] = fh.get("meta")
            if f_sum:
                R["rivals_summary"] = f_sum.result()

    # ④ 기술동향(키워드별·기업별 수집을 병렬로, 요약은 수집이 끝난 뒤)
    def topic_one(k: dict) -> dict:
        say(f"기술논문 분석 중: {k.get('ko')}")
        tr = papers.topic_trend(k.get("en") or k.get("ko"))
        extra = papers.scholar_extra(liner, k.get("en") or "", "") if liner.ok else []
        ps = papers.mark_important(papers.merge_unique(tr["recent"], extra, tr["cited"]))
        return {"name": k.get("ko") or k.get("en"), "en": k.get("en"), "trend": tr, "papers": ps}

    def s4():
        kws = (prof.get("tech_keywords") or [])[:MAX_TECH]
        if not kws:
            kws = [{"ko": t, "en": t} for t in (prof.get("core_tech") or [])[:MAX_TECH]]
        en_kws = [k.get("en") for k in kws if k.get("en")]
        targets = [(name.strip(), prof.get("name_en") or (corp or {}).get("name_en") or "", True)]
        targets += [(c.get("name") or "", c.get("name_en") or "", False) for c in rivals_in]

        def comp_one(t):
            r = papers.company_papers(t[0], t[1], en_kws)
            r["self"] = t[2]
            papers.mark_important(r.get("works") or [])
            return r
        # 국내 특허(대상+국내 경쟁사): 논문 수집과 독립이라 별도 작업으로 시작하고, 실패해도 논문 분석은 계속한다
        pat_in = [patents.entry(name.strip(), prof.get("name_en") or "", registered=re.sub(r"주식회사|\(주\)|㈜", "", (corp or {}).get("name") or "").strip(),
                                aliases=aliases, is_self=True)]
        pat_in += [patents.entry(c.get("name") or "", c.get("name_en") or "", registered=c.get("registered_name_ko") or "") for c in rivals_in if c.get("name")]
        pat_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="patents")
        say("국내 특허 출원 검색 중(Liner 웹 검색 + 공개 특허 원문)...")
        f_pat = pat_pool.submit(patents.collect, liner, pat_in)
        with ThreadPoolExecutor(max_workers=TECH_WORKERS, thread_name_prefix="tech") as ex:
            f_topics = [ex.submit(topic_one, k) for k in kws]
            say("경쟁사 참여 논문 확인 중(OpenAlex 소속)...")
            f_comp = [ex.submit(comp_one, t) for t in targets]
            topics = [f.result() for f in f_topics]
            comp_papers = [f.result() for f in f_comp]
        R["tech"] = {"topics": topics, "company_papers": comp_papers}
        if liner.ok and topics:
            say("연구논문 요약 중(Liner)...")
            R["tech"]["summary"] = papers.summarize(name.strip(), prof.get("business") or "", topics, liner)
        try:
            R["tech"]["patents"] = f_pat.result()
        except Exception as e:  # patents.collect 는 예외를 올리지 않지만 방어적으로 둔다
            R["tech"]["patents"] = {"companies": [], "error": _short(e)}
            add_errors([f"[④ 특허] {_short(e)}"])
        finally:
            pat_pool.shutdown(wait=False)
        add_errors([f"[④ 특허] {c['company']}: {e}" for c in R["tech"]["patents"].get("companies") or [] for e in c.get("errors") or []
                    if "LINER_API_KEY" not in e])

    # ⑤ 정부사업·나라장터
    def s5():
        tech_ko = [k.get("ko") for k in prof.get("tech_keywords") or [] if k.get("ko")]
        gov_kw = list(dict.fromkeys((prof.get("gov_keywords") or []) + tech_ko + (prof.get("core_tech") or [])))
        broad = ["AI", "인공지능", "딥테크", "R&D", "연구개발", "실증", "기술개발", "사업화"]
        say("정부지원사업(기업마당) 대조 중...")
        progs = gov.match_programs(gov_kw, broad)
        bid_kw = list(dict.fromkeys(prof.get("bid_keywords") or [k for k in gov_kw if len(k) <= 6][:5]))[:6]
        say(f"나라장터 입찰공고 검색 중... (검색어 {', '.join(bid_kw)})")
        g = gov.g2b_search(bid_kw, bid_kw[:3] + tech_ko[:3], days=28, progress=say) if bid_kw else {"items": [], "calls": 0, "errors": []}
        _, as_of = gov.load_programs()
        R["gov"] = {"items": gov.merge_sort(progs, g["items"]), "programs_count": len(progs), "g2b": {k: v for k, v in g.items() if k != "items"},
                    "g2b_count": len(g["items"]), "gov_keywords": gov_kw, "bid_keywords": bid_kw, "bizinfo_as_of": as_of}

    # ⑥ 펀딩: t=0 에 시작한 회사 조회 결과를 받아 기존 규칙 그대로 정책상품·VC 후보를 만든다
    def s6():
        say("펀딩 정보 수집 중(펀딩노트 회사 조회·정책상품·모태펀드 운용사)...")
        f: dict = {"errors": []}
        try:
            f["lookup"] = lookup_future.result()
        except Exception as e:
            f["errors"].append(f"펀딩노트 회사 조회 실패: {_short(e)}")
            f["lookup"] = None
        region = ""
        if corp:
            region = fn_region(corp.get("address") or "")
        lk = (f.get("lookup") or {}).get("draft") or {}
        region = region or lk.get("region") or "서울"
        biz = funding_view.biz_type(prof.get("stage") or "")
        field = prof.get("fund_field") or "ai"
        existing = [i["name"] for i in (f.get("lookup") or {}).get("investors") or [] if i.get("status") in ("confirmed", "reported")]
        f["inputs"] = {"region": region, "biz": biz, "field": field, "field_label": funding_view.FUND_FIELDS.get(field, ("",))[0],
                       "stage": prof.get("stage") or "", "existing_investors": existing}
        f["policy"] = funding_view.policy_products(region, biz)
        f["vc_new"], f["vc_existing"] = funding_view.vc_candidates(field, existing)
        R["funding"] = f

    with ThreadPoolExecutor(max_workers=TOP_WORKERS, thread_name_prefix="step") as ex:
        futs = [ex.submit(step, 1, s2), ex.submit(step, 2, s3), ex.submit(step, 3, s4), ex.submit(step, 4, s5),
                ex.submit(step, 5, s6, t0)]
        while not all(f.done() for f in futs):  # 메인 스레드: 진행 문구·단계 알림을 화면에 전달
            drain()
            time.sleep(0.2)
        drain()
    side.shutdown(wait=True)
    drain()

    R.pop("_lock", None)
    R["parallel"] = {"top_workers": TOP_WORKERS, "rival_workers": RIVAL_WORKERS, "tech_workers": TECH_WORKERS,
                     "service_limits": dict(common.LIMITS), "liner_limits": dict(LINER_CONCURRENCY),
                     "sum_of_step_sec": round(sum(v.get("sec") or 0 for v in R["steps"].values()), 1)}
    R["liner_usage"] = liner.usage()
    R["liner_calls"] = [{k: c.get(k) for k in ("kind", "label", "http_status", "ok", "elapsed_sec", "error", "cost_usd", "est_cost_usd",
                                                     "started_at", "attempt", "include_knowledge", "query", "result_count", "knowledge_count")}
                        for c in (liner.client.calls if liner.client else [])]
    R["liner_cache_hits"] = liner.cache_hits
    R["errors"] += liner.errors
    R["elapsed_sec"] = round(time.time() - t0, 1)
    R["parallel"]["overlap_sec"] = round(R["parallel"]["sum_of_step_sec"] - R["elapsed_sec"], 1)
    R["finished_at"] = datetime.now().isoformat(timespec="seconds")
    liner.close()
    say("전체 분석 완료")
    return R


def _funding_history(cos: list[dict], news_by: dict, liner: Liner, say, R: dict, where: str) -> dict:
    """투자유치 이력 수집을 감싼다. 예외는 기록만 하고 빈 결과를 돌려준다. 소요시간은 R['timing'] 에 남긴다(진단용)."""
    t0 = time.time()
    try:
        out = funding_history.collect(liner, cos, news_by, progress=say)
    except Exception as e:  # 투자유치 기능 실패가 기존 분석을 멈추지 않게 한다
        out = {"by_company": {}, "meta": {"error": _short(e)}}
        errs = [f"[투자유치 이력·{where}] {_short(e)}"]
    else:
        errs = []
    for item in (out.get("by_company") or {}).values():
        errs += [f"[투자유치 이력] {item['company']}: {e}" for e in item.get("errors") or [] if "LINER_API_KEY" not in e]
    with R.get("_lock") or threading.Lock():
        R["errors"].extend(errs)
        R.setdefault("timing", {})[f"funding_history_{where}_sec"] = round(time.time() - t0, 2)
    if where == "target":
        return (out.get("by_company") or {}).get(cos[0]["name"]) if cos else None
    return out


def fn_region(address: str) -> str:
    from funding.profile import parse_region
    return parse_region(address)


RIVAL_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["rivals"],
    "properties": {"rivals": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["name", "business", "products_tech", "recent_changes"],
        "properties": {"name": {"type": "string"}, "business": {"type": "string", "description": "주요 사업 2~3문장"},
                       "products_tech": {"type": "string", "description": "주요 제품·기술"},
                       "recent_changes": {"type": "array", "items": {"type": "string"}, "description": "최근 사업 변화 최대 5개(자료 근거)"}}}}},
}


def summarize_rivals(target: str, rows: list[dict], liner: Liner) -> dict:
    """경쟁사별 상위 뉴스 제목·요약을 묶어 모델 1회로 사업·제품·최근 변화를 정리한다."""
    from research.liner import DATA_RULE
    blocks = []
    for r in rows:
        arts = ((r.get("news") or {}).get("articles") or [])[:15]
        lines = "\n".join(f"- ({a['date']}) {a['title']} — {a['description'][:150]}" for a in arts) or "- 뉴스 없음"
        c = r["info"]
        blocks.append(f"## {c.get('name')} ({c.get('country')}, {c.get('relation')}: {c.get('reason')})\n{lines}")
    system = f"당신은 경쟁사 분석가입니다. {DATA_RULE}\n경쟁사마다 주요 사업, 주요 제품·기술, 최근 사업 변화를 한국어로 정리합니다. 뉴스가 없으면 일반적으로 알려진 사업 개요만 짧게 쓰고 최근 변화는 비웁니다."
    out = liner.json(system, f"대상 기업: {target}\n\n<자료>\n" + "\n\n".join(blocks) + "\n</자료>", RIVAL_SCHEMA, name="rival_summary")
    return {x.get("name"): x for x in (out or {}).get("rivals") or []}


def save(R: dict) -> Path:
    """결과를 results/integrated_<시각>_<회사>.json 으로 저장한다(키 마스킹 후 누출 검사). 기존 파일은 덮어쓰지 않는다."""
    out_dir = config.RESULTS_DIR / "integrated"
    out_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^0-9A-Za-z가-힣]", "", R.get("company") or "company")[:30]
    path = out_dir / f"{datetime.now():%Y%m%d_%H%M%S}_{safe}.json"
    data = analysis.scrub(R, common.secrets())
    text = json.dumps(data, ensure_ascii=False, indent=1, default=str)
    if any(s in text for s in common.secrets()):
        raise RuntimeError("결과에 키 문자열이 남아 있어 저장을 중단했습니다")
    path.write_text(text, encoding="utf-8")
    return path


def load_latest(name: str) -> dict | None:
    d = config.RESULTS_DIR / "integrated"
    safe = re.sub(r"[^0-9A-Za-z가-힣]", "", name)[:30]
    files = sorted(d.glob(f"*_{safe}.json")) if d.is_dir() else []
    return json.loads(files[-1].read_text(encoding="utf-8")) if files else None
