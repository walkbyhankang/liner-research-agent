"""(이전) Streamlit 대시보드: Liner API 기업정보 수집 성능 검증. 실행: streamlit run app_legacy.py"""
from __future__ import annotations

import io
import json
import zipfile

import pandas as pd
import plotly.express as px
import streamlit as st

import analysis as an
import config
import pipeline as pl
from liner_client import LinerClient

st.set_page_config(page_title="Liner API 기업분석 검증", layout="wide")
NA = an.UNKNOWN


def get_client() -> LinerClient | None:
    key, source = config.resolve_api_key()
    if not key:
        return None
    if st.session_state.get("client_source") != source or "client" not in st.session_state:
        st.session_state["client"] = LinerClient(key, source)
        st.session_state["client_source"] = source
    return st.session_state["client"]


def link(url: str | None) -> str:
    return f"[링크]({url})" if url else "-"


def df_or_info(rows: list[dict], cols: list[str], empty: str = NA) -> None:
    if not rows:
        st.info(empty)
        return
    df = pd.DataFrame(rows)
    df = df[[c for c in cols if c in df.columns]].copy()
    for c in df.columns:  # 숫자/빈 문자열/리스트 혼합 컬럼은 pyarrow 변환 오류가 나므로 문자열로 통일
        df[c] = df[c].map(lambda v: "; ".join(map(str, v)) if isinstance(v, list) else ("" if v is None else str(v)))
    st.dataframe(df, width="stretch", hide_index=True)


def persist(run: dict) -> None:
    client = st.session_state.get("client")
    out = pl.save_results(run, client.secrets if client else [])
    st.session_state["out_dir"] = str(out)


# ---------------- 사이드바 ----------------
st.title("Liner API 기반 스타트업 기업분석 — 정보 수집 성능 검증")
client = get_client()
with st.sidebar:
    st.header("설정")
    if client:
        st.success(f"API 키 확인됨 ({config.KEY_SOURCE_LABELS.get(client.key_source)})")
    else:
        st.error("API 키가 없습니다. LINER_API_KEY 환경변수 또는 .env 파일에 설정하세요.")
    mode = st.radio("검색 모드", ["기본 검색 (최대 12회)", "확장 검색 (최대 20회)", "최대 검색 (최대 50회)"], index=2)
    search_budget = 50 if "50" in mode else 20 if "20" in mode else 12
    max_results = st.select_slider("검색 결과 수 (호출당)", options=list(config.SEARCH_RESULT_CHOICES),
                                   value=config.SEARCH_MAX_RESULTS)
    use_agent = st.checkbox("Search Agent 통합 (1회, 유료)", value=True)
    with st.expander("고급 검색 옵션"):
        model = st.selectbox("분석 모델", list(config.MODEL_CHOICES), index=0,
                             help="가격표에 있는 모델만 표시. 공식 지원 모델 목록은 확인하지 못했습니다.")
        fetch_pages = st.slider("원문 확인 최대 페이지", 0, 60, config.FETCH_MAX_PAGES)
        st.caption("기업 식별 힌트 (선택)")
        h_home = st.text_input("공식 홈페이지 도메인", "")
        h_alias = st.text_input("별칭/브랜드명 (쉼표 구분)", "당근" if st.session_state.get("company") == "당근마켓" else "")
        h_excl = st.text_input("제외할 유사 상호 (쉼표 구분)", "")
        h_ind = st.text_input("업종", "")
        h_tech = st.text_input("핵심 기술", "")
        h_year = st.number_input("설립연도 (0=미상)", 0, 2100, 0)
        h_comp = st.text_input("알고 있는 경쟁사 (쉼표 구분)", "")
    options = pl.default_options(
        search_budget=search_budget, max_results=max_results, use_agent=use_agent, model=model, fetch_pages=fetch_pages,
        hints={"homepage": h_home, "aliases": h_alias, "exclude": h_excl, "industry": h_ind, "tech": h_tech,
               "founded_year": int(h_year) or None, "competitors": h_comp})
    st.divider()
    st.subheader("API 사용량")
    if client:
        u = client.usage()
        st.caption(f"Search {u['search']['used']}/{u['search']['limit']} (남음 {u['search']['remaining']}) · "
                   f"Model {u['model']['used']}/{u['model']['limit']} · Agent {u['agent']['used']}/{u['agent']['limit']} · "
                   f"Premium {u['premium']['used']}/{u['premium']['limit']}")
    st.caption("새 분석을 실행하면 호출 카운터가 초기화됩니다(새 클라이언트). 호출 한도는 실행 1회 기준입니다.")

run = st.session_state.get("run")
tabs = st.tabs(["1. 검색·실행", "2. 기업 개요", "3. 재무·투자", "4. 경쟁사", "5. 뉴스·타임라인",
                "6. VC·투자자", "7. 정부지원·사업기회", "8. API 성능·품질"])

# ---------------- 1. 검색 ----------------
with tabs[0]:
    c1, c2 = st.columns([3, 1])
    company = c1.text_input("회사명 (국내/해외 스타트업)", value=st.session_state.get("company", ""))
    country = c2.selectbox("기업 소재국", list(config.COUNTRIES))
    key_now = pl.cache_key(company.strip(), country, options)
    cached = bool(run and run["company"] == company.strip() and run["country"] == country
                  and run["status"]["search"] != "not_run" and run.get("cache_key") == key_now)
    if run and run["company"] == company.strip() and run.get("cache_key") != key_now:
        st.warning("검색 설정이 이전 결과와 다릅니다. 실행하면 새 결과로 구분되어 저장됩니다(이전 결과 폴더는 유지).")
    if run:
        st.caption(f"마지막 검색 시각: {run.get('last_search_at') or '없음'} · 로직 버전 {run.get('logic_version')} · 실행 ID {run['run_id']}")
    if cached:
        st.caption("동일한 입력·설정의 기존 결과가 있어 재사용합니다. 다시 조회하려면 '강제 재검색'을 누르세요(비용 발생).")
    cb1, cb2 = st.columns(2)
    go = cb1.button("분석 실행", type="primary", disabled=not company.strip() or client is None)
    force = cb2.button("강제 재검색 (유료)", disabled=not company.strip() or client is None)
    if go or force:
        if cached and not force:
            st.info("기존 결과를 재사용했습니다. API를 호출하지 않았습니다.")
        else:
            st.session_state["company"] = company
            client.close()
            st.session_state.pop("client", None)
            client = get_client()
            with st.status("분석 진행 중...", expanded=True) as status:
                run = pl.run_analysis(company.strip(), country, client, progress=lambda m: st.write(m), options=options)
                st.session_state["run"] = run
                persist(run)
                status.update(label="완료 (일부 오류 있음)" if run["errors"] else "완료", state="complete")
    if run:
        st.divider()
        st.subheader("실행 상태")
        s = run["status"]
        cols = st.columns(4)
        cols[0].metric("Search API", s["search"])
        cols[1].metric("Model API", s["model"])
        cols[2].metric("Search Agent", s["agent"])
        cols[3].metric("Premium 비교", s.get("premium", "not_run"))
        for e in run["errors"]:
            st.error(f"[{e['stage']}] {e['message']}")
        if run.get("unsearched"):
            with st.expander(f"호출 한도로 미조사된 항목 {len(run['unsearched'])}건"):
                df_or_info(run["unsearched"], ["key", "category", "query", "reason"])
        st.markdown("**수집된 검색 결과 (원본 요약/출처)**")
        for key, resp in run["searches"].items():
            with st.expander(f"{key} — {len((resp or {}).get('results') or [])}건"):
                for r in (resp or {}).get("results") or []:
                    st.markdown(f"- **{r.get('title')}** ({r.get('date') or '날짜 없음'}) {link(r.get('url'))}\n\n"
                                f"  {r.get('description') or ''}")
        st.divider()
        if st.button("Search Agent 실행 (1회, 유료)", disabled=client is None or s["agent"] in ("success", "failed")):
            with st.status("Search Agent 실행 중...", expanded=True):
                pl.run_agent(run, client, progress=lambda m: st.write(m))
                pl.rebuild_sources(run)
                persist(run)
            st.rerun()
        if s["agent"] in ("success", "failed"):
            st.caption("Search Agent는 이미 실행되었습니다(중복 호출 방지). 사실 통합은 분석 실행 시 반영됩니다.")
        if run["agent"]["status"] == "success":
            st.markdown("**Search Agent 답변**")
            st.write(run["agent"]["answer"] or NA)
            df_or_info([{"title": r.get("title"), "url": r.get("url"), "date": r.get("date")}
                        for r in run["agent"]["references"] if isinstance(r, dict)], ["title", "url", "date"], "참고 출처 없음")
        st.divider()
        st.markdown("**Premium Data 비교 (일반 1회 재사용 + Premium 1회)**")
        if st.button("Premium Data 비교 실행 (유료 1회)", disabled=client is None or s.get("premium") in ("success", "failed")
                     or not run["search_plan"]):
            with st.status("Premium Data 비교 실행 중...", expanded=True):
                pl.run_premium_compare(run, client, progress=lambda m: st.write(m))
                persist(run)
            st.rerun()
        pc = (run.get("premium") or {}).get("comparison")
        if pc:
            st.info(pc["verdict"])
            st.table(pd.DataFrame([{"항목": k, "값": str(v)} for k, v in pc.items() if k not in ("knowledge", "knowledge_providers")]))
            if pc["knowledge"]:
                df_or_info(pc["knowledge"], ["title", "description", "sources", "data_as_of", "row_count", "company_related"])
        elif (run.get("premium") or {}).get("status") == "failed":
            st.error(run["premium"].get("error"))

if not run:
    for t in tabs[1:]:
        with t:
            st.info("먼저 '검색·실행' 탭에서 분석을 실행하세요.")
    st.stop()

a = run["analysis"]
facts = a["facts"]
BASIS = {"consolidated": "연결", "standalone": "별도", "unknown": "기준 미상"}


def show_facts(cat_filter):
    rows = [f for f in facts if cat_filter(f)]
    df_or_info(rows, ["item", "value", "unit", "currency", "as_of", "basis", "source_url", "source_type", "status",
                      "evidence", "missing_reason"], "해당 항목의 자료를 확보하지 못했습니다(추가 조사 필요).")


def notes_box():
    for n in a.get("notes", []):
        if "추가 조사" in n or "자료 확보 불가" in n or "결과 없음" in n:
            st.caption(f"ℹ️ {n}")


# ---------------- 2. 개요 ----------------
with tabs[1]:
    st.subheader(a["company_name"] or run["company"])
    if run["status"]["model"] not in ("success", "partial"):
        st.warning("Model API 분석이 없어 구조화된 개요를 제공할 수 없습니다. 1번 탭의 검색 원본을 참고하세요.")
    ident = run.get("identity") or {}
    if ident:
        st.caption(f"식별: 이름 후보 {ident.get('names')} · 제외 상호 {ident.get('exclude_names') or '-'} · 공식 도메인 {ident.get('official_hosts') or '-'}")
    show_facts(lambda f: f["category"] == "profile")
    notes_box()
    st.caption("상태: confirmed 원문 본문에서 값 확인 / reported 발표·보도 / inferred AI 해석·근거 부족 / conflicting 불일치 / unavailable 확보 불가.")

# ---------------- 3. 재무 ----------------
with tabs[2]:
    show_facts(lambda f: f["category"] in ("finance", "funding", "employees"))
    fin = pd.DataFrame(a["financials"])
    st.markdown("**확보된 재무 수치 (연결/별도·연도·단위 구분)**")
    if fin.empty:
        st.info(f"{NA} — 검증 가능한 수치가 없어 표·그래프를 생성하지 않습니다.")
    else:
        fin["basis"] = fin["basis"].map(lambda b: BASIS.get(b, b)) if "basis" in fin else "기준 미상"
        st.dataframe(fin.sort_values(["metric", "year"]), width="stretch", hide_index=True)
        for metric, title in (("revenue", "연도별 매출"), ("operating_profit", "연도별 영업이익"), ("employees", "직원수")):
            d = fin[fin["metric"] == metric]
            if d.empty:
                st.info(f"{title}: {NA}")
                continue
            d = d.sort_values("year")
            d["series"] = d["basis"] + " / " + d["unit"].astype(str) + " " + d["currency"].fillna("").astype(str)
            st.plotly_chart(px.bar(d, x="year", y="value", color="series", barmode="group",
                                   hover_data=["source_url", "status"], title=f"{title} (출처 있는 수치만)"),
                            width="stretch")
        st.caption(f"확보 연도 수(매출): {len(set(fin[fin['metric'] == 'revenue']['year']))}개년. 3개년 미만이면 해당 연도는 자료 확보 불가입니다.")
    notes_box()

# ---------------- 4. 경쟁사 ----------------
with tabs[3]:
    df_or_info(a["competitors"], ["name", "relation", "products", "revenue", "employees", "funding", "as_of",
                                  "source_urls", "status", "missing_reason"], "경쟁사 정보를 확보하지 못했습니다.")
    q = [c for c in a["competitors"] if c.get("revenue") or c.get("employees") or c.get("funding")]
    st.caption(f"경쟁사 정량정보 확보: {len(q)}/{len(a['competitors'])}곳. 값이 없는 경쟁사는 그래프에서 제외합니다.")
    if run.get("competitor_names"):
        st.caption(f"후속 검색 대상 경쟁사(Agent·힌트에서 추출): {', '.join(run['competitor_names'])}")
    notes_box()

# ---------------- 5. 뉴스 ----------------
with tabs[4]:
    news = a["news"]
    st.caption("최신 사건일(없으면 발행일) 순 정렬. 중복 보도는 한 사건으로 묶고 원본 기사 목록(source_urls)을 유지합니다.")
    df_or_info(news, ["event_date", "published_date", "title", "event_type", "commitment_level", "summary",
                      "source_urls", "status"], "뉴스 정보를 확보하지 못했습니다.")
    dated = [dict(n, when=pd.to_datetime(n.get("event_date") or n.get("published_date"), errors="coerce")) for n in news]
    dated = [n for n in dated if pd.notna(n["when"])]
    if dated:
        fig = px.scatter(pd.DataFrame(dated), x="when", y="event_type", color="commitment_level",
                         hover_data=["title", "published_date", "event_date"], title="기업 활동 타임라인")
        fig.update_traces(marker_size=14)
        st.plotly_chart(fig, width="stretch")
    else:
        st.info(f"기업 활동 타임라인: {NA}")

# ---------------- 6. VC ----------------
with tabs[5]:
    st.markdown("**A. 기존 투자자** (이미 투자한 VC — 신규 후보로 추천하지 않음)")
    df_or_info(a.get("existing_investors", []), ["name", "date", "round", "amount", "fund", "source_urls", "status"],
               "기존 투자자 정보를 확보하지 못했습니다.")
    st.markdown("**B. 신규 투자 후보** (적합성 근거가 있는 경우만 표시)")
    cands = a.get("vc_candidates", [])
    df_or_info(cands, ["name", "focus", "fund", "fund_purpose", "similar_investments", "stage", "recent_activity", "fit",
                       "competitor_investment", "competitor_investment_detail", "remaining_capital",
                       "new_investment_status", "source_urls", "status"], "신규 투자 후보를 확보하지 못했습니다(근거 부족 시 추천하지 않음).")
    comp_vc = [c for c in cands if c.get("competitor_investment")]
    if comp_vc:
        st.markdown("**경쟁사 투자 이력 VC** — 투자 경험(장점)과 이해상충 가능성을 함께 검토하세요. 경쟁사 투자만으로 가능성이 높다고 판단하지 않습니다.")
        df_or_info(comp_vc, ["name", "competitor_investment_detail", "source_urls"])
    st.caption("투자 확률·점수는 근거 자료가 없어 산출하지 않습니다. 잔여 투자재원은 공개 확인이 불가하면 미확인입니다.")
    notes_box()

# ---------------- 7. 지원사업 ----------------
with tabs[6]:
    st.markdown("**현재 활용 가능한 정부지원·R&D·정책금융** (공고 원문 조건 우선, 정보가 없으면 확정하지 않음)")
    progs = a.get("programs", [])
    if progs:
        order = {"신청 가능 확인": 0, "조건부 가능": 1, "자격 확인 필요": 2, "자격 미충족": 3, "모집 종료": 4}
        progs = sorted(progs, key=lambda p: order.get(p.get("eligibility"), 9))
    df_or_info(progs, ["eligibility", "name", "agency", "purpose", "target", "amount", "self_burden", "start_date", "end_date",
                       "max_company_age_years", "region_restriction", "industry_restriction", "size_restriction",
                       "eligibility_reasons", "url", "status"], "현재 신청 가능한 지원사업이 검색되지 않았습니다(결과 없음).")
    st.markdown("**공공입찰·조달 (잠재 매출기회 — 정부지원금 아님)**")
    df_or_info(a.get("procurement", []), ["name", "agency", "budget", "deadline", "url", "status"], "공공입찰 정보를 확보하지 못했습니다.")
    st.caption("종료된 사업은 추천하지 않고 '모집 종료'로 표시됩니다. 공공 API는 연동하지 않았습니다.")
    notes_box()

# ---------------- 8. 성능 ----------------
with tabs[7]:
    m = pl.quality_metrics(run)
    c = st.columns(5)
    c[0].metric("검색 결과(고유 URL)", f"{m['search_result_count']} ({m['unique_urls']})")
    c[1].metric("관련 자료 비율", m["relevant_ratio"] if m["relevant_ratio"] is not None else "-")
    c[2].metric("추출 사실 / 원문확인", f"{m['facts_total']} / {m['facts_confirmed']}")
    c[3].metric("총 소요(초)", m["total_elapsed_sec"])
    c[4].metric("추정 비용(USD)", m["total_est_cost_usd"])
    st.caption("비용은 공식 단가 기반 추정치이며 실제 청구액은 크레딧 잔액 변화로 확인해야 합니다. "
               f"분석 시작·종료: {run['started_at']} ~ {run['finished_at']}")
    c = st.columns(5)
    c[0].metric("재무 확보 연도 수", m["financial_year_count"])
    c[1].metric("최근 1년 뉴스", m["recent_news_count"])
    c[2].metric("신규 VC 후보", m["new_vc_candidates"])
    c[3].metric("신청 가능 지원사업", m["open_support_programs"])
    c[4].metric("출처 불일치", m["conflict_count"])
    st.markdown("**카테고리별 정보 확보율**")
    st.dataframe(pd.DataFrame(m["category_coverage"].values()), width="stretch", hide_index=True)
    st.markdown("**원문 검증**")
    st.write(f"원문 접근 {m['fetch_ok']}/{m['fetch_attempted']}건 성공 · 검증 대상 {m['verification_items']}건 중 원문 확인 {m['verified_items']}건 (검증률 {m['verified_ratio']})")
    df_or_info(run.get("verification", []), ["category", "item", "value", "url", "source_type", "fetch_status", "verified",
                                              "evidence_text", "failure_reason"], "원문 검증 기록 없음")
    st.markdown("**API 호출 기록 (검색어별)**")
    df_or_info(run["calls"], ["call_no", "kind", "label", "query", "max_results", "include_knowledge", "result_count",
                              "knowledge_count", "attempt", "started_at", "finished_at", "http_status", "ok", "elapsed_sec",
                              "input_tokens", "output_tokens", "est_cost_usd", "error"], "호출 기록 없음")
    st.markdown("**카테고리별 Model 호출**")
    df_or_info([{"category": k, **{kk: vv for kk, vv in v.items() if kk != "usage"}} for k, v in run.get("category_runs", {}).items()],
               ["category", "status", "model_id", "sources_used", "elapsed_sec", "est_cost_usd", "reason", "error"], "모델 호출 없음")
    st.markdown("**확인 상태 분포**")
    st.json(m["facts_by_status"])
    st.markdown("**API별 정보 확보 성능 비교 (Search API vs Search Agent vs Premium)**")
    ig = m["integration"]
    st.table(pd.DataFrame([
        {"항목": "출처 수", "Search API": m["search_result_count"], "Search Agent": m["agent_reference_count"]},
        {"항목": "고유 도메인", "Search API": m["search_unique_hosts"], "Search Agent": m["agent_unique_hosts"]},
        {"항목": "고유 사실 수", "Search API": ig["search_unique_facts"], "Search Agent": ig["agent_unique_facts"]},
        {"항목": "공통 확인 / Agent 단독 추가", "Search API": ig["common_facts"], "Search Agent": ig["agent_only_facts"]},
        {"항목": "출처 충돌 사실 / 최종 반영 사실", "Search API": ig["conflicting_facts"], "Search Agent": ig["final_facts"]},
    ]).astype(str))
    df_or_info(pl.search_comparison_rows(run), ["topic", "category", "api", "result_count", "relevant_count", "relevance_ratio",
                                                 "new_urls", "agent_overlap_urls", "premium_knowledge_tables", "premium_verdict"])
    with st.expander("제외된 검색 결과 (유사 상호·무관·중복) 사유"):
        df_or_info(m["excluded_sources"], ["url", "reason"], "제외된 자료 없음")
    with st.expander("출처 목록 (검색어별 출처·관련성·신뢰도 보존)"):
        df_or_info(run.get("sources", []), ["title", "url", "source_type", "trust", "relevance", "use", "excluded_reason",
                                             "origins", "categories", "date"])

    st.divider()
    st.subheader("다운로드")
    out = st.session_state.get("out_dir")
    if out:
        from pathlib import Path
        base = Path(out)
        st.caption(f"저장 위치: {base}")
        if run.get("secret_leaks"):
            st.error(f"인증정보 노출 의심: {run['secret_leaks']}")
        else:
            st.caption("인증정보 노출 검사: 이상 없음")
        for name, mime in (("extracted_facts.csv", "text/csv"), ("company_profile.json", "application/json"),
                           ("source_verification.csv", "text/csv"), ("search_comparison.csv", "text/csv"),
                           ("coverage_report.json", "application/json"), ("improvement_comparison.md", "text/markdown"),
                           ("api_calls.csv", "text/csv"), ("analysis_bundle.zip", "application/zip")):
            p = base / name
            if p.exists():
                st.download_button(f"{name} 다운로드", p.read_bytes(), file_name=name, mime=mime, key=f"dl_{name}")
