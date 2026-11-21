"""통합 분석 컨트롤러: 기업명 하나로 6단계를 순서대로 실행한다. 한 단계가 실패해도 다음 단계를 계속한다.

결과는 하나의 dict(공통 데이터 구조)에 쌓이고, 앞 단계 결과(기업 프로필·경쟁사·기술 키워드)를 뒤 단계가 재사용한다.
같은 요청은 research/common 파일 캐시로 재사용하므로, 다시 실행해도 이미 받은 자료는 다시 호출하지 않는다.
"""
from __future__ import annotations

import json
import re
import time
import traceback
from datetime import datetime
from pathlib import Path

import analysis
import config
from research import common, company, funding_view, gov, news, papers, public_data
from research.liner import Liner

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


def _short(e: Exception) -> str:
    return common.scrub_text(f"{type(e).__name__}: {str(e)[:200]}")


def _aliases(prof: dict, corp: dict | None) -> list[str]:
    out = [prof.get("name_ko") or "", prof.get("name_en") or "", *(prof.get("aliases") or [])]
    if corp:
        out += [re.sub(r"주식회사|\(주\)|㈜", "", n).strip() for n in corp.get("names") or []]
        out.append(corp.get("name_en") or "")
    # 너무 일반적인 짧은 영문(AI 등)은 뉴스 매칭에 쓰지 않는다
    return [a for a in dict.fromkeys(a.strip() for a in out) if len(a) >= 2 and a.lower() not in ("ai", "inc", "inc.")]


def run(name: str, progress=None, step_done=None) -> dict:
    """progress(msg): 진행 문구. step_done(key, status, idx): 단계 완료 알림."""
    say = progress or (lambda m: None)
    done = step_done or (lambda k, s, i: None)
    t0 = time.time()
    liner = Liner.from_env()
    R: dict = {"company": name.strip(), "started_at": datetime.now().isoformat(timespec="seconds"), "steps": {},
               "keys": common.key_status(), "errors": []}
    if not liner.ok:
        R["errors"].append("LINER_API_KEY 가 없어 Liner 분석(기업 프로필·요약·학술 검색)을 건너뜁니다.")

    def step(idx: int, fn):
        key, label = STEPS[idx]
        say(f"{label} 시작")
        st = time.time()
        try:
            fn()
            status = "완료"
        except Exception as e:  # 한 단계 실패가 전체를 멈추지 않게 한다
            R["errors"].append(f"[{label}] {_short(e)}")
            R.setdefault("tracebacks", []).append(common.scrub_text(traceback.format_exc()[-1500:]))
            status = "실패"
        R["steps"][key] = {"label": label, "status": status, "sec": round(time.time() - st, 1)}
        done(key, status, idx)

    # ① 기업 식별·프로필·경쟁사·키워드
    def s1():
        R["profile"] = company.analyze(name.strip(), liner, say)
        R["errors"] += [f"[①] {e}" for e in R["profile"]["errors"]]
    step(0, s1)
    prof = (R.get("profile") or {}).get("profile") or {}
    corp = (R.get("profile") or {}).get("corp")
    aliases = _aliases(prof, corp) or [name.strip()]
    R["aliases"] = aliases

    # ② 대상기업 재무·고용·뉴스
    def s2():
        t: dict = {}
        if corp or prof.get("is_korean", True):
            t["public"] = public_data.company_bundle(name.strip(), prof.get("name_en") or "", say)
            say("국민연금 가입자 수집 완료" if (t["public"].get("nps") or {}).get("monthly") else "국민연금 가입자 자료 없음")
        say("네이버 뉴스 검색 중...")
        t["news"] = news.collect(name.strip(), aliases, liner)
        say(f"뉴스 {len(t['news']['articles'])}건 정리 완료, 주요 사건 요약 중(Liner)...")
        t["news_summary"] = news.summarize(name.strip(), t["news"]["articles"], liner)
        R["target"] = t
    step(1, s2)

    # ③ 경쟁사
    def s3():
        rows = []
        for c in (prof.get("competitors") or [])[:MAX_RIVALS]:
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
                q_name = cname if c.get("is_korean") or re.search(r"[가-힣]", cname) else cname
                item["news"] = news.collect(q_name, al, liner if not c.get("is_korean") else None,
                                            extra_queries=["투자", "계약", "출시"], naver_pages=RIVAL_NEWS_PAGES, liner_queries=1)
            except Exception as e:
                item["errors"].append(_short(e))
            rows.append(item)
        R["rivals"] = rows
        if rows and liner.ok:
            say("경쟁사 사업·제품·최근 변화 요약 중(Liner)...")
            R["rivals_summary"] = summarize_rivals(name.strip(), rows, liner)
    step(2, s3)

    # ④ 기술동향
    def s4():
        kws = (prof.get("tech_keywords") or [])[:MAX_TECH]
        if not kws:
            kws = [{"ko": t, "en": t} for t in (prof.get("core_tech") or [])[:MAX_TECH]]
        topics = []
        for k in kws:
            say(f"기술논문 분석 중: {k.get('ko')}")
            tr = papers.topic_trend(k.get("en") or k.get("ko"))
            extra = papers.scholar_extra(liner, k.get("en") or "", "") if liner.ok else []
            topics.append({"name": k.get("ko") or k.get("en"), "en": k.get("en"), "trend": tr,
                           "papers": papers.merge_unique(tr["recent"], extra, tr["cited"])})
        say("경쟁사 참여 논문 확인 중(OpenAlex 소속)...")
        en_kws = [k.get("en") for k in kws if k.get("en")]
        comp_papers = []
        targets = [(name.strip(), prof.get("name_en") or (corp or {}).get("name_en") or "", True)]
        targets += [(c.get("name") or "", c.get("name_en") or "", False) for c in (prof.get("competitors") or [])[:MAX_RIVALS]]
        for cn, en, is_self in targets:
            r = papers.company_papers(cn, en, en_kws)
            r["self"] = is_self
            comp_papers.append(r)
        R["tech"] = {"topics": topics, "company_papers": comp_papers}
        if liner.ok and topics:
            say("연구논문 요약 중(Liner)...")
            R["tech"]["summary"] = papers.summarize(name.strip(), prof.get("business") or "", topics, liner)
    step(3, s4)

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
    step(4, s5)

    # ⑥ 펀딩
    def s6():
        say("펀딩 정보 수집 중(펀딩노트 회사 조회·정책상품·모태펀드 운용사)...")
        f: dict = {"errors": []}
        try:
            f["lookup"] = funding_view.company_lookup(name.strip(), progress=lambda m: say(f"펀딩노트: {m}"))
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
    step(5, s6)

    R["liner_usage"] = liner.usage()
    R["liner_calls"] = [{k: c.get(k) for k in ("kind", "label", "http_status", "ok", "elapsed_sec", "error", "cost_usd", "est_cost_usd")}
                        for c in (liner.client.calls if liner.client else [])]
    R["liner_cache_hits"] = liner.cache_hits
    R["errors"] += liner.errors
    R["elapsed_sec"] = round(time.time() - t0, 1)
    R["finished_at"] = datetime.now().isoformat(timespec="seconds")
    liner.close()
    say("전체 분석 완료")
    return R


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
