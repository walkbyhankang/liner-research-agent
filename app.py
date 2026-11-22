"""Streamlit: 6개 탭 통합 기업분석 프로토타입.

첫 탭의 '전체 분석 시작' 버튼 한 번으로 research/controller.run 이 6단계를 순서대로 수행하고,
결과는 st.session_state 에 보관한다. 탭 이동·화면 갱신 때는 API 를 다시 부르지 않는다.
(이전 8탭 검증 화면은 app_legacy.py)
"""
from __future__ import annotations

import pandas as pd
import plotly.express as px
import streamlit as st

from research import controller, papers

st.set_page_config(page_title="통합 기업분석", layout="wide")
NA = "자료 확보 불가"


def table(rows: list[dict], cols: list[str] | None = None, *, links: tuple[str, ...] = ("링크", "url"), height: int | str = "auto") -> None:
    if not rows:
        st.info(NA)
        return
    df = pd.DataFrame(rows)
    if cols:
        df = df[[c for c in cols if c in df.columns]]
    for c in df.columns:
        if c not in links:
            col = df[c].map(lambda v: "; ".join(map(str, v)) if isinstance(v, list) else ("" if v is None else v))
            # 숫자와 '-' 가 섞인 열은 Arrow 변환이 실패하므로 문자열로 통일한다(순수 숫자 열은 정렬을 위해 유지)
            if col.map(lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)).all():
                df[c] = col
            else:
                df[c] = col.map(lambda v: "" if v is None or (isinstance(v, float) and v != v) else str(v))
    cfg = {c: st.column_config.LinkColumn(c, display_text="열기") for c in df.columns if c in links}
    st.dataframe(df, width="stretch", hide_index=True, column_config=cfg, height=height)


def won(v) -> str:
    if v is None:
        return "-"
    return f"{v / 1e8:,.1f}억원"


def fin_view(pub: dict | None, key: str) -> None:
    if not pub:
        st.info("국내 공공 API 대상이 아니거나 조회하지 않았습니다.")
        return
    rows = pub.get("financials") or []
    if rows:
        disp = [{"연도": r["연도"], "구분": r["구분"], **{k: won(r.get(k)) for k in ("매출액", "영업이익", "당기순이익", "자산총계", "부채총계", "자본총계")},
                 "매출액 증가율(%)": r.get("매출액 증가율(%)"), "영업이익률(%)": r.get("영업이익률(%)"), "부채비율(%)": r.get("부채비율(%)")} for r in rows]
        table(disp)
        long = [{"연도": r["연도"], "항목": k, "억원": (r.get(k) or 0) / 1e8} for r in rows for k in ("매출액", "영업이익", "당기순이익") if r.get(k) is not None]
        if long:
            st.plotly_chart(px.bar(long, x="연도", y="억원", color="항목", barmode="group", height=320), width="stretch", key=f"fin_{key}")
        st.caption("출처: 금융위원회 기업재무정보(요약재무제표). 금액 단위 원(KRW)을 억원으로 환산. 같은 연도에 연결·별도가 모두 있으면 연결 기준.")
        if len(pub.get("financials_all") or []) > len(rows):
            with st.expander(f"전체 연도 재무 ({len(pub['financials_all'])}행)"):
                table(pub["financials_all"])
    else:
        st.info("재무실적: " + NA)


def nps_view(pub: dict | None, key: str) -> None:
    nps = (pub or {}).get("nps") or {}
    m = nps.get("monthly") or []
    if not m:
        st.info("고용현황(국민연금): " + (nps.get("note") or NA))
        return
    s = nps.get("summary") or {}
    if s:
        c = st.columns(5)
        c[0].metric("최근 가입자", f"{s['최근']}명", f"{s['증감']:+d}명")
        c[1].metric("기간 증가율", f"{s['증가율(%)']}%")
        c[2].metric("신규 취득 합계", s["신규 취득 합계"])
        c[3].metric("상실 합계", s["상실 합계"])
        c[4].metric("기간", s["기간"])
    st.plotly_chart(px.line(m, x="월", y="가입자 수", markers=True, height=280), width="stretch", key=f"nps_{key}")
    table(m, ["월", "가입자 수", "전월 대비", "신규 취득", "상실", "업종"])
    st.caption(nps.get("note", ""))


def news_view(nw: dict | None, key: str, limit: int = 300) -> None:
    arts = (nw or {}).get("articles") or []
    if not arts:
        st.info("뉴스: " + NA)
        return
    cats = sorted({t for a in arts for t in a["분류"]})
    pick = st.multiselect("분류", cats, key=f"cat_{key}")
    shown = [a for a in arts if not pick or set(pick) & set(a["분류"])]
    st.caption(f"중복 정리 후 {len(arts)}건 (수집 {nw.get('raw_count')}건, NAVER {nw['api_counts']['naver']} · Liner {nw['api_counts']['liner']}) · 기간 {nw.get('period')}")
    table([{"날짜": a["date"], "제목": a["title"], "분류": a["분류"], "관련 기사 수": a["관련 기사 수"], "매체": a["매체"],
            "요약": a["description"][:200], "출처": a["source_api"], "링크": a["url"]} for a in shown[:limit]], height=420)


def funding_rows(fh: dict) -> list[dict]:
    rows = []
    for r in fh.get("rounds") or []:
        amt = r.get("amount") or "미공개"
        if r.get("other_amounts"):
            amt += f" (다른 출처: {', '.join(r['other_amounts'])})"
        d = r.get("date") or (f"보도 {r['reported_date']}" if r.get("reported_date") else "미상")
        note = r.get("summary") or ("" if r.get("round") else r.get("raw", ""))
        ent = r.get("entity") or ""
        if ent and common_name(ent) != common_name(fh.get("company") or "") and r.get("entity_match") != "web":
            note = f"[투자대상: {ent}] " + note
        rows.append({"투자일자": d, "투자단계": r.get("round") or "미상", "투자금액": amt, "통화": r.get("currency") or "",
                     "투자기관·VC": ", ".join(r.get("investors") or []) or "미공개",
                     "리드·주요 투자자": ", ".join(r.get("lead") or []), "주요 내용": note,
                     "출처 유형": "Premium(PDL)" if r["source_type"].startswith("premium") else "웹 검색",
                     "url": next((s["url"] for s in r.get("sources") or [] if s.get("url")), "")})
    return rows


def common_name(s: str) -> str:
    from research import common as _c
    return _c.norm_name(s)


def funding_history_view(fh: dict | None, key: str, *, compact: bool = False) -> None:
    """투자유치 이력 및 투자기관(②·③ 공통)."""
    if not fh:
        st.info("투자유치 이력: " + NA)
        return
    s = fh.get("summary") or {}
    c = st.columns(4)
    c[0].metric("확인된 투자 라운드", f"{s.get('rounds', 0)}건")
    c[1].metric("투자기관", f"{s.get('investors', 0)}곳", f"VC·재무적(추정) {s.get('vc_like', 0)}곳", delta_color="off")
    tr = s.get("total_raised")
    c[2].metric("누적 투자유치(PDL)", f"${tr / 1e6:,.1f}M" if tr else "-")
    lt = s.get("latest") or {}
    c[3].metric("최근 투자", lt.get("round") or "-", lt.get("date") or None, delta_color="off")
    notes = []
    if tr:
        notes.append(f"누적액은 Premium(PDL) 회사 카드 total_raised 값({s.get('total_raised_entity')}, USD)")
    if s.get("funding_stage"):
        notes.append(f"PDL 투자단계: {s['funding_stage']}")
    if s.get("disclosed_amounts"):
        notes.append("확인 가능한 투자금액: " + " · ".join(s["disclosed_amounts"][:12]) + (" 외" if len(s["disclosed_amounts"]) > 12 else ""))
    for n in notes:
        st.caption(n)
    rows = funding_rows(fh)
    if rows:
        st.markdown("**투자유치 이력**")
        table(rows, ["투자일자", "투자단계", "투자금액", "통화", "투자기관·VC", "리드·주요 투자자", "주요 내용", "출처 유형", "url"], links=("url",))
    else:
        st.info("투자 라운드 자료를 확보하지 못했습니다(상장사·대기업은 라운드 방식 정보가 적을 수 있음).")
    inv = fh.get("investors") or []
    if inv:
        st.markdown(f"**투자기관·VC 목록 ({len(inv)}곳)**")
        table([{**i, "참여 라운드": ", ".join(i["참여 라운드"]), "리드·주요 투자자 표기": "예" if i["리드·주요 투자자 표기"] else ""} for i in inv])
    cards = fh.get("cards") or []
    if cards:
        with st.expander(f"Premium(PDL) 회사 카드 {len(cards)}건 — 관련 법인 포함"):
            table([{"법인명": x["name"], "일치": "이름·도메인 일치" if x["match"] == "exact" else "유사 이름(관련 법인 가능)", "투자단계": x["funding_stage"],
                    "누적 투자(USD)": x["total_raised"], "라운드 수": x["funding_round_count"], "설립": x["established"], "웹사이트": x["website"],
                    "위치": x["location"], "다른 이름": x["also_known_as"]} for x in cards])
    arts = fh.get("articles") or []
    if arts:
        if compact:
            with st.expander(f"투자 관련 기사 {len(arts)}건"):
                table(arts, links=("링크",))
        else:
            st.markdown(f"**투자 관련 주요 기사·발표 ({len(arts)}건)**")
            table(arts, links=("링크",), height=300)
    st.caption("출처: Liner Premium(People Data Labs 회사 카드) 우선, 라운드가 부족하면 Liner 웹 검색 스니펫으로 보완(근거 문장이 스니펫에 있는 것만). "
               "관련·이전 법인의 투자 이력이 섞일 수 있어 투자대상 법인명을 함께 표시합니다. 같은 라운드가 명백히 겹칠 때만 합치고 출처 간 금액 차이는 그대로 둡니다. "
               "투자기관 유형은 이름 기반 추정입니다.")
    for e in fh.get("errors") or []:
        st.caption("미확보: " + e)


def cumulative_of(fh: dict | None) -> dict:
    """funding_history 결과의 누적 투자유치 금액. 이전 결과 파일(cumulative 필드 없음)도 기존 값으로 계산한다."""
    s = (fh or {}).get("summary") or {}
    if s.get("cumulative"):
        return s["cumulative"]
    if not fh:
        return {}
    from research import funding_history as _fh
    return _fh.cumulative(fh.get("cards") or [], fh.get("rounds") or [])


def money_text(v: float, cur: str) -> str:
    if cur == "KRW":
        return f"{v / 1e12:,.2f}조원" if v >= 1e12 else f"{v / 1e8:,.0f}억원"
    sym = {"USD": "$", "EUR": "€", "GBP": "£"}.get(cur, "")
    return f"{sym}{v / 1e6:,.1f}M" + ("" if sym else f" {cur}")


def cum_text(cum: dict) -> str:
    by = (cum or {}).get("by_currency") or {}
    if not by:
        return "미확보"
    return " + ".join(money_text(v, c) for c, v in by.items())


def funding_chart(cos: list[tuple[str, dict | None, bool]]) -> None:
    """누적 투자유치 금액 비교(통화별로 따로). 금액 미확보 기업은 0으로 그리지 않고 아래에 이름만 적는다."""
    rows, missing = [], []
    for nm, fh, is_self in cos:
        cum = cumulative_of(fh)
        by = cum.get("by_currency") or {}
        if not by:
            missing.append(nm)
        for cur, v in by.items():
            rows.append({"기업": nm + (" (대상)" if is_self else ""), "통화": cur, "금액": v, "표시": money_text(v, cur),
                         "기준": cum.get("label"), "대상": "대상기업" if is_self else "경쟁사"})
    if not rows:
        st.info("누적 투자유치 금액을 확보한 기업이 없어 비교 차트를 그리지 않습니다.")
        return
    for cur in sorted({r["통화"] for r in rows}):
        sub = sorted([r for r in rows if r["통화"] == cur], key=lambda r: -r["금액"])
        unit, div = ("억원", 1e8) if cur == "KRW" else (f"백만 {cur}", 1e6)
        for r in sub:
            r["값"] = r["금액"] / div
        fig = px.bar(sub, x="기업", y="값", color="대상", text="표시", hover_data=["기준"], height=340,
                     color_discrete_map={"대상기업": "#d62728", "경쟁사": "#1f77b4"},
                     title=f"누적 투자유치 금액 비교 ({cur}, {unit})", category_orders={"기업": [r["기업"] for r in sub]})
        fig.update_traces(textposition="outside", cliponaxis=False)
        fig.update_layout(yaxis_title=unit, xaxis_title="", legend_title="")
        st.plotly_chart(fig, width="stretch", key=f"fund_cmp_{cur}")
    st.caption("통화가 다르면 환산하지 않고 차트를 나눕니다. 'PDL'은 People Data Labs 회사 카드의 누적액(USD), '라운드 금액 합계'·'확인된 투자유치 금액 합계'는 "
               "중복 정리한 라운드의 금액을 더한 값입니다(일부 라운드만 금액이 있으면 실제 누적액보다 작을 수 있음)."
               + (f" 금액 미확보: {', '.join(missing)}" if missing else ""))


def company_paper_chart(cp: list[dict]) -> None:
    """대상기업·국내 경쟁사별 연도별 논문 발표 건수(최근 5개년). OpenAlex 집계(by_year)가 없으면 수집 목록으로 센다."""
    import datetime as _dt
    this = _dt.date.today().year
    years = list(range(this - 4, this + 1))
    rows, table_rows, basis = [], [], []
    for c in cp:
        nm = c["company"] + (" (대상)" if c.get("self") else "")
        if c.get("by_year") is not None:
            by = {int(k): v for k, v in (c.get("by_year") or {}).items()}
            how = "OpenAlex 집계 — " + (c.get("count_basis") or "")
        else:
            by = {}
            for w in c.get("works") or []:
                if str(w.get("연도") or "").isdigit():
                    by[int(w["연도"])] = by.get(int(w["연도"]), 0) + 1
            how = f"수집 목록 {len(c.get('works') or [])}건 범위 내 집계"
        basis.append(f"{nm}: {how}")
        tr = {"기업": nm, "구분": "직접 참여(소속)" if c.get("direct", True) else "소속 문자열 일치"}
        for y in years:
            rows.append({"기업": nm, "연도": y, "논문 수": by.get(y, 0), "대상": bool(c.get("self"))})
            tr[str(y)] = by.get(y, 0)
        mention = {int(k): v for k, v in (c.get("mention_by_year") or {}).items()}
        if mention:
            tr["기업명 언급 논문(참고, 5년 합)"] = sum(mention.get(y, 0) for y in years)
        table_rows.append(tr)
    if not rows:
        return
    st.subheader("대상기업·국내 경쟁사 연도별 논문 발표 건수")
    fig = px.line(rows, x="연도", y="논문 수", color="기업", markers=True, height=380,
                  title=f"기업별 논문 발표 추이 ({years[0]}~{years[-1]}, 올해는 진행 중)")
    for tr_ in fig.data:
        if tr_.name.endswith("(대상)"):
            tr_.update(line={"width": 5}, marker={"size": 10})
        else:
            tr_.update(line={"width": 2, "dash": "dot"})
    fig.update_xaxes(dtick=1)
    st.plotly_chart(fig, width="stretch", key="company_paper_trend")
    table(table_rows)
    st.caption("저자 소속 기관이 해당 기업인 논문(직접 참여)을 셉니다. '기업명 언급 논문'은 소속과 무관하게 본문 검색에 걸린 논문 수로, 직접 참여와 구분한 참고값입니다. "
               + " / ".join(basis))


def patent_view(P: dict | None) -> None:
    """④ 국내 특허 출원 동향(검색으로 확인된 공개 특허)."""
    st.divider()
    st.subheader("국내 특허 출원 동향")
    cos = (P or {}).get("companies") or []
    if not cos:
        st.info("국내 특허: " + ((P or {}).get("error") or NA))
        return
    import datetime as _dt
    this = _dt.date.today().year
    years = list(range(this - 4, this + 1))
    label = lambda c: c["company"] + (" (대상)" if c.get("self") else "")  # noqa: E731
    st.markdown("**A. 기업별 특허 출원 현황 (검색으로 확인된 공개 특허)**")
    table([{"기업": label(c), "확인된 출원 특허": (c.get("summary") or {}).get("total", 0),
            f"최근 5개년({years[0]}~{years[-1]}) 출원": (c.get("summary") or {}).get("recent5", 0),
            "등록": (c.get("summary") or {}).get("registered", 0), "주요 기술 분야(CPC)": ", ".join((c.get("summary") or {}).get("top_fields") or []) or "-",
            "출원인 아닌 언급 문서": len(c.get("mentions") or []), "원문 확인 문서": c.get("pages_checked", 0),
            "비고": "; ".join(c.get("errors") or [])} for c in cos])
    rows, trows = [], []
    for c in cos:
        by = {int(k): v for k, v in ((c.get("summary") or {}).get("by_year") or {}).items()}
        tr = {"기업": label(c)}
        for y in years:
            rows.append({"기업": label(c), "출원연도": y, "출원 건수": by.get(y, 0)})
            tr[str(y)] = by.get(y, 0)
        tr[f"{years[0]} 이전"] = sum(v for y, v in by.items() if y < years[0])
        trows.append(tr)
    st.markdown("**B. 연도별 출원 추이 (출원일 기준)**")
    fig = px.line(rows, x="출원연도", y="출원 건수", color="기업", markers=True, height=360,
                  title=f"기업별 국내 특허 출원 추이 ({years[0]}~{years[-1]}, 검색으로 확인된 공개 특허)")
    for tr_ in fig.data:
        tr_.update(line={"width": 5}, marker={"size": 10}) if tr_.name.endswith("(대상)") else tr_.update(line={"width": 2, "dash": "dot"})
    fig.update_xaxes(dtick=1)
    st.plotly_chart(fig, width="stretch", key="patent_trend")
    table(trows)
    st.markdown("**C. 기업별 확인된 특허 출원 건수 비교**")
    bars = sorted([{"기업": label(c), "확인된 출원 특허": (c.get("summary") or {}).get("total", 0), "대상": "대상기업" if c.get("self") else "경쟁사"} for c in cos],
                  key=lambda r: -r["확인된 출원 특허"])
    fb = px.bar(bars, x="기업", y="확인된 출원 특허", color="대상", text="확인된 출원 특허", height=320,
                color_discrete_map={"대상기업": "#d62728", "경쟁사": "#1f77b4"}, title="검색으로 확인된 공개 특허 건수(전체 출원 건수 아님)",
                category_orders={"기업": [b["기업"] for b in bars]})
    fb.update_traces(textposition="outside", cliponaxis=False)
    fb.update_layout(xaxis_title="", legend_title="")
    st.plotly_chart(fb, width="stretch", key="patent_total")
    st.markdown("**D. 주요 특허 목록 (최근 출원순)**")
    pats = sorted([p for c in cos for p in c.get("patents") or []], key=lambda p: p.get("filing_date") or "", reverse=True)
    table([{"출원기업": p.get("company"), "출원일": p.get("filing_date") or "미확인", "발명의 명칭": p.get("title"),
            "주요 기술내용": (p.get("abstract") or "")[:220], "출원번호": p.get("application_no") or "-",
            "공개번호": p.get("publication_no") or "-", "등록번호": p.get("registration_no") or "-", "CPC": ", ".join((p.get("cpc") or [])[:3]),
            "원문": p.get("url")} for p in pats], links=("원문",), height=420)
    ment = [m for c in cos for m in c.get("mentions") or []]
    if ment:
        with st.expander(f"기업명이 언급됐지만 출원인이 다른 특허 문서 {len(ment)}건 (출원 건수에 넣지 않음)"):
            table([{"검색 기업": c["company"], "문서": m.get("pub_no"), "발명의 명칭": m.get("title"), "출원인": m.get("assignee"), "출원일": m.get("filing_date"), "원문": m.get("url")}
                   for c in cos for m in c.get("mentions") or []], links=("원문",))
    st.caption("Liner 웹 검색(site:patents.google.com)으로 후보를 찾고, Google Patents 공개 원문에서 출원인이 해당 기업인 KR 특허만 셉니다. "
               "같은 출원번호의 공개·등록 문서는 한 건으로 합쳤고, 연도는 출원일 기준입니다(출원일이 없으면 공개·등록일로 대신하지 않음). "
               "출원 후 약 18개월 미공개 기간이 있어 최근 연도 건수는 실제보다 적게 보이며, 검색에 걸리지 않은 특허는 빠집니다.")


# ---------------- 세션 상태 ----------------
R = st.session_state.get("R")
st.title("통합 기업분석")
tabs = st.tabs(["1. 기업 검색", "2. 기업 세부정보", "3. 경쟁사 동향", "4. 기술동향", "5. 정부사업·입찰공고", "6. 펀딩"])

# ---------------- 1. 기업 검색 ----------------
with tabs[0]:
    c1, c2 = st.columns([3, 1])
    name = c1.text_input("기업명", value=(R or {}).get("company", ""), placeholder="예: 기준 기업")
    c2.write("")
    go = c2.button("전체 분석 시작", type="primary", disabled=not name.strip(), width="stretch")
    if go:
        bar = st.progress(0.0, text="분석 준비 중...")
        step_box = st.empty()
        state = {k: "대기" for k, _ in controller.STEPS}

        def render_steps():
            step_box.markdown("\n".join(f"- {'✅' if state[k] == '완료' else '⚠️' if state[k] == '실패' else '⏳' if state[k] == '진행 중' else '▫️'} {lbl} — {state[k]}"
                                        for k, lbl in controller.STEPS))
        render_steps()
        with st.status("분석 진행 중...", expanded=True) as status:
            # 병렬 실행: 단계는 끝나는 순서대로 알림이 온다. 콜백은 controller 가 메인 스레드에서만 부른다
            def on_step(key, s, idx):
                state[key] = s
                n = sum(v in ("완료", "실패") for v in state.values())
                bar.progress(n / len(controller.STEPS), text=f"{n}/{len(controller.STEPS)} 단계 완료")
                render_steps()

            def on_start(key, idx):
                state[key] = "진행 중"
                render_steps()
            R = controller.run(name.strip(), progress=lambda m: st.write(m), step_done=on_step, step_start=on_start)
            try:
                R["saved_to"] = str(controller.save(R))
            except Exception as e:
                R["errors"].append(f"결과 저장 실패: {e}")
            st.session_state["R"] = R
            status.update(label="전체 분석 완료" + (" (일부 미확보)" if R["errors"] else ""), state="complete", expanded=False)
    if R:
        st.divider()
        cols = st.columns(6)
        for i, (k, lbl) in enumerate(controller.STEPS):
            s = R["steps"].get(k, {})
            cols[i].metric(lbl[:1] + " " + lbl[2:12], s.get("status", "-"), f"{s.get('sec', 0)}초", delta_color="off")
        u = R.get("liner_usage") or {}
        st.caption(f"소요 {R.get('elapsed_sec')}초 · Liner 호출: 검색 {u.get('search', {}).get('used', 0)}, 모델 {u.get('model', {}).get('used', 0)}, "
                   f"학술 {u.get('scholar', {}).get('used', 0)} (캐시 재사용 {R.get('liner_cache_hits', 0)}회) · 저장: {R.get('saved_to', '-')}")
        missing = [k for k, v in (R.get("keys") or {}).items() if not v and k not in ("BIZINFO_API_KEY", "KVIC_API_KEY")]
        if missing:
            st.warning(f".env 에 없는 키: {', '.join(missing)} — 해당 API 는 건너뛰었습니다.")
        if R["errors"]:
            with st.expander(f"미확보·오류 {len(R['errors'])}건 (나머지 분석은 계속 진행됨)"):
                for e in R["errors"]:
                    st.write("- " + e)
        P = R.get("profile") or {}
        prof, corp = P.get("profile") or {}, P.get("corp")
        st.subheader(f"{(corp or {}).get('name') or prof.get('name_ko') or R['company']}")
        g = st.columns(3)
        basic = [("정확한 기업명", (corp or {}).get("name") or prof.get("name_ko")), ("영문 기업명", (corp or {}).get("name_en") or prof.get("name_en")),
                 ("사업자등록번호", (corp or {}).get("bzno")), ("법인등록번호", (corp or {}).get("crno")), ("설립일", (corp or {}).get("founded")),
                 ("대표자", (corp or {}).get("ceo")), ("대표자·창업자(검색)", prof.get("founders")), ("업종", (corp or {}).get("industry") or prof.get("industry")),
                 ("주소", (corp or {}).get("address")), ("홈페이지", (corp or {}).get("homepage")), ("기업 단계(추정)", prof.get("stage")),
                 ("공공 API 주요사업", (corp or {}).get("main_biz"))]
        for i, (k, v) in enumerate(basic):
            g[i % 3].markdown(f"**{k}**  \n{v or NA}")
        st.caption("식별번호·설립일·대표자·주소: 금융위 기업기본정보 API. 사업·제품·기술·경쟁사: Liner 웹 검색 + 모델 정리(검색 자료 기반).")
        if len(P.get("corp_candidates") or []) > 1:
            with st.expander(f"동일·유사 상호 법인 {len(P['corp_candidates'])}건 (금융위)"):
                table(P["corp_candidates"], ["name", "name_en", "crno", "bzno", "ceo", "founded", "address", "updated", "exact"])
        st.markdown("#### 주요 사업내용")
        st.write(prof.get("business") or NA)
        a, b = st.columns(2)
        with a:
            st.markdown("#### 제품·서비스")
            table(prof.get("products") or [])
            st.markdown("#### 핵심 기술")
            st.write(", ".join(prof.get("core_tech") or []) or NA)
        with b:
            st.markdown("#### 기타 중요한 기업 현황")
            for s in prof.get("status_notes") or []:
                st.write("- " + s)
        st.markdown(f"#### 주요 국내 경쟁기업 ({len(prof.get('competitors') or [])}개)")
        table(prof.get("competitors") or [], ["name", "name_en", "country", "relation", "reason"])
        if P.get("excluded_competitors"):
            st.caption("국내 기업만 경쟁사로 사용합니다. 제외: " + ", ".join(f"{c.get('name')}({c.get('excluded_reason')})" for c in P["excluded_competitors"]))
        st.markdown("#### 기술 키워드 (논문·정부사업·나라장터 검색에 공통 사용)")
        table(prof.get("tech_keywords") or [])
        with st.expander(f"프로필 분석에 쓴 검색 자료 {len(P.get('sources') or [])}건"):
            table(P.get("sources") or [], links=("url",))

if not R:
    for t in tabs[1:]:
        with t:
            st.info("먼저 '1. 기업 검색' 탭에서 '전체 분석 시작'을 누르세요.")
    st.stop()

prof = ((R.get("profile") or {}).get("profile")) or {}
T = R.get("target") or {}

# ---------------- 2. 기업 세부정보 ----------------
with tabs[1]:
    st.subheader("A. 재무실적 (최근 3개 사업연도)")
    fin_view(T.get("public"), "target")
    st.subheader("B. 고용현황 (국민연금, 최근 12개월)")
    nps_view(T.get("public"), "target")
    st.subheader("C. 주요 뉴스 (최근 12개월)")
    sm = T.get("news_summary")
    if sm:
        st.markdown("**최근 기업 동향 (Liner 요약)**")
        st.write(sm["summary"])
        for t in sm.get("trends") or []:
            st.write("- " + t)
        st.markdown("**중요 사건**")
        table(sm.get("events") or [], ["date", "category", "title", "detail", "기사 제목", "url"], links=("url",))
    news_view(T.get("news"), "target")
    st.subheader("D. 투자유치 이력 및 투자기관")
    funding_history_view(T.get("funding_history"), "target")

# ---------------- 3. 경쟁사 동향 ----------------
with tabs[2]:
    rivals = R.get("rivals") or []
    if not rivals:
        st.info("경쟁사 자료: " + NA)
    else:
        st.subheader("대상기업·경쟁사 비교")
        comp_rows, fin_long, nps_long = [], [], []
        all_cos = [(R["company"], T.get("public"), T.get("news"))] + [(r["info"]["name"], r.get("public"), r.get("news")) for r in rivals]
        for nm, pub, nw in all_cos:
            fin = (pub or {}).get("financials") or []
            last = fin[-1] if fin else {}
            s = ((pub or {}).get("nps") or {}).get("summary") or {}
            comp_rows.append({"기업": nm, "최근 재무연도": last.get("연도", "-"), "매출액": won(last.get("매출액")) if last else "-",
                              "영업이익": won(last.get("영업이익")) if last else "-", "자산총계": won(last.get("자산총계")) if last else "-",
                              "국민연금 가입자(최근)": s.get("최근", "-"), "12개월 증가율(%)": s.get("증가율(%)", "-"),
                              "뉴스 건수": len((nw or {}).get("articles") or [])})
            for r in fin:
                if r.get("매출액") is not None:
                    fin_long.append({"기업": nm, "연도": r["연도"], "매출액(억원)": r["매출액"] / 1e8})
            for m in ((pub or {}).get("nps") or {}).get("monthly") or []:
                nps_long.append({"기업": nm, "월": m["월"], "가입자 수": m["가입자 수"]})
        table(comp_rows)
        c1, c2 = st.columns(2)
        if fin_long:
            c1.plotly_chart(px.bar(fin_long, x="연도", y="매출액(억원)", color="기업", barmode="group", height=320, title="매출액 비교"), width="stretch")
        if nps_long:
            c2.plotly_chart(px.line(nps_long, x="월", y="가입자 수", color="기업", markers=True, height=320, title="국민연금 가입자 비교"), width="stretch")
        st.caption("국내 기업만 금융위·국민연금 API로 조회합니다. 해외 기업은 뉴스·검색 자료만 표시합니다.")
        st.subheader("투자유치 이력 비교")
        fund_rows = []
        for nm, fh in [(R["company"] + " (대상)", T.get("funding_history"))] + [(r["info"]["name"], r.get("funding_history")) for r in rivals]:
            s = (fh or {}).get("summary") or {}
            lt = s.get("latest") or {}
            inv = (fh or {}).get("investors") or []
            cum = cumulative_of(fh)
            fund_rows.append({"기업": nm, "누적 투자유치 금액": cum_text(cum), "산정 기준": cum.get("label") or "미확보", "확인 라운드 수": s.get("rounds", 0),
                              "PDL 투자단계": s.get("funding_stage") or "-", "최근 투자": " ".join(x for x in (lt.get("date"), lt.get("round"), lt.get("amount")) if x) or "-",
                              "투자기관 수": len(inv), "주요 투자기관": ", ".join(i["투자기관"] for i in inv[:6]) or "-"})
        table(fund_rows)
        funding_chart([(R["company"], T.get("funding_history"), True)] + [(r["info"]["name"], r.get("funding_history"), False) for r in rivals])
        summ = R.get("rivals_summary") or {}
        for i, r in enumerate(rivals):
            c = r["info"]
            with st.expander(f"{c.get('name')} ({c.get('country')}) — {c.get('relation')}", expanded=i == 0):
                st.write(c.get("reason") or "")
                s = summ.get(c.get("name")) or {}
                if s:
                    st.markdown(f"**주요 사업** {s.get('business')}")
                    st.markdown(f"**주요 제품·기술** {s.get('products_tech')}")
                    if s.get("recent_changes"):
                        st.markdown("**최근 사업 변화**")
                        for x in s["recent_changes"]:
                            st.write("- " + x)
                for e in (r.get("errors") or []) + ((r.get("public") or {}).get("errors") or []):
                    st.caption("미확보: " + e)
                if r.get("public"):
                    corp = r["public"].get("corp")
                    if corp:
                        st.caption(f"법인: {corp['name']} · 법인등록번호 {corp['crno']} · 설립 {corp['founded']} · 대표 {corp['ceo']}")
                    st.markdown("**재무실적**")
                    fin_view(r["public"], f"r{i}")
                    st.markdown("**고용현황**")
                    nps_view(r["public"], f"r{i}")
                st.markdown("**최근 12개월 뉴스**")
                news_view(r.get("news"), f"r{i}", limit=100)
                st.markdown("**투자유치 이력 및 투자기관**")
                funding_history_view(r.get("funding_history"), f"r{i}", compact=True)

# ---------------- 4. 기술동향 ----------------
with tabs[3]:
    tech = R.get("tech") or {}
    topics = tech.get("topics") or []
    if not topics:
        st.info("기술동향: " + NA)
    else:
        long = [{"기술": t["name"], "연도": y, "논문 수": n} for t in topics for y, n in sorted((t["trend"].get("by_year") or {}).items())
                if int(y) <= __import__("datetime").date.today().year]
        if long:
            st.plotly_chart(px.line(long, x="연도", y="논문 수", color="기술", markers=True, height=380,
                                    title="기술 분야별 연도별 논문 발표량 (OpenAlex, 올해는 진행 중)"), width="stretch")
        table([{"기술": t["name"], "검색어": t["en"], "추세": papers.trend_label({int(k): v for k, v in (t["trend"].get("by_year") or {}).items()}),
                "최근 2년 상위 기관": ", ".join(x["기관"] for x in t["trend"].get("institutions", [])[:5]), "논문 수(목록)": len(t["papers"])} for t in topics])
        cp = tech.get("company_papers") or []
        direct = [w for c in cp for w in c.get("works") or []]
        st.subheader(f"⭐ 경쟁기업·대상기업 직접 참여 논문 ({len(direct)}건, 저자 소속 확인)")
        if direct:
            table([{"기업": w["경쟁사"], "제목": w["제목"], "연도": w["연도"], "저자": w["저자"], "소속": w["소속"], "피인용": w["피인용"],
                    "주요 논문(OpenAlex 지표)": w.get("주요 논문") or "", "링크": w["링크"]} for w in direct], height=360)
        st.caption(" · ".join(f"{c['company']}: {len(c.get('works') or [])}건({c.get('mode') or '-'})" + (f" 오류 {c['error']}" if c.get("error") else "") for c in cp))
        company_paper_chart(cp)
        summary = tech.get("summary") or {}
        for t in topics:
            with st.expander(f"{t['name']} — 논문 {len(t['papers'])}건"):
                s = summary.get(t["name"]) or next((v for k, v in summary.items() if k and (k in t["name"] or t["name"] in k)), None)
                if s:
                    st.markdown(f"**연구 흐름** {s['summary']}")
                    st.markdown(f"**대상기업 기술과의 관련성** {s['relevance']}")
                    for kp in s.get("key_papers") or []:
                        st.markdown(f"- [{kp['제목']}]({kp['링크']}) — {kp['요지']}")
                inst = t["trend"].get("institutions") or []
                if inst:
                    st.markdown("**주요 연구기관 (최근 2년)**")
                    table(inst)
                st.markdown("**최근·주요 논문**")
                for p in t["papers"]:
                    star = f"🏅 주요 논문({p['주요 논문']}) · " if p.get("주요 논문") else ""
                    st.markdown(f"{star}**[{p['제목']}]({p['링크']})** ({p['연도']}, {p['출처']}, 피인용 {p['피인용']})  \n"
                                f"<small>{p['저자']} · {p['소속'] or p['학술지·학회']}</small>", unsafe_allow_html=True)
                    if p["초록"]:
                        st.caption(p["초록"][:600] + ("…" if len(p["초록"]) > 600 else ""))

    patent_view((R.get("tech") or {}).get("patents"))

# ---------------- 5. 정부사업·입찰공고 ----------------
with tabs[4]:
    G = R.get("gov") or {}
    items = G.get("items") or []
    st.caption(f"정부지원사업(기업마당 스냅샷 {G.get('bizinfo_as_of', '-')}) {G.get('programs_count', 0)}건 · 나라장터 {G.get('g2b_count', 0)}건 "
               f"(기간 {(G.get('g2b') or {}).get('period', '-')}, 호출 {(G.get('g2b') or {}).get('calls', 0)}회) · 통합 {len(items)}건")
    st.caption(f"검색어: 정부사업 {', '.join(G.get('gov_keywords') or [])} / 나라장터 {', '.join(G.get('bid_keywords') or [])}")
    if (G.get("g2b") or {}).get("error_count"):
        st.warning(f"나라장터 일부 구간 실패 {G['g2b']['error_count']}건: {'; '.join(G['g2b']['errors'][:3])}")
    if not items:
        st.info(NA)
    else:
        c1, c2, c3 = st.columns(3)
        kinds = c1.multiselect("구분", sorted({i["구분"].split(" ")[0] for i in items}))
        sts = c2.multiselect("상태", sorted({i["상태"] for i in items}))
        rels = c3.multiselect("관련성", ["높음", "보통", "참고"])
        shown = [i for i in items if (not kinds or i["구분"].split(" ")[0] in kinds) and (not sts or i["상태"] in sts) and (not rels or i["관련성"] in rels)]
        table(shown, ["구분", "상태", "관련성", "공고명", "기관", "사업 내용", "금액", "기간", "신청조건", "관련 키워드", "링크"], height=560)
        st.caption("정렬: 모집·입찰 진행 중 → 관련성 → 마감 임박. 관련성은 정렬·분류용이며 공고를 제외하지 않습니다. 기업마당 공고 금액은 API에 없어 공고문 확인이 필요합니다.")

# ---------------- 6. 펀딩 ----------------
with tabs[5]:
    F = R.get("funding") or {}
    if not F:
        st.info("펀딩: " + NA)
    else:
        inp = F.get("inputs") or {}
        st.caption(f"펀딩노트 입력값(①단계 결과 연결): 지역 {inp.get('region')}, 기업 유형 {inp.get('biz')}, 관심 투자 분야 {inp.get('field_label')}, 단계 {inp.get('stage')}")
        for e in F.get("errors") or []:
            st.warning(e)
        lk = F.get("lookup") or {}
        st.subheader("기존 투자자 (펀딩노트 회사 조회)")
        table(lk.get("investors") or [], ["name", "round", "date", "status", "sourceUrl"], links=("sourceUrl",))
        if lk.get("rivalFunding"):
            st.subheader("경쟁사 투자 이력 (펀딩노트)")
            table(lk["rivalFunding"])
        st.subheader(f"VC 후보: 모태펀드 자펀드 운용사 ({inp.get('field_label')}) — 신규 {len(F.get('vc_new') or [])}곳")
        st.caption("펀딩노트 '자금 찾기'와 같은 규칙(만기 전 펀드, 출자분야 낱말 일치, 최근 결성 순). 이미 투자한 운용사는 신규 후보에서 뺐습니다. 투자 가능성 판단이 아닙니다.")
        table(F.get("vc_new") or [], height=380)
        if F.get("vc_existing"):
            st.markdown("**이미 투자한 운용사(신규 후보 제외)**")
            table(F["vc_existing"])
        st.subheader(f"정책융자·보증 후보 — {len(F.get('policy') or [])}건")
        st.caption("펀딩노트 '자금 찾기'의 융자·보증 대조 규칙(지역·지원대상)을 그대로 적용했습니다. 세부 자격은 공고문에서 확인하세요.")
        table(F.get("policy") or [], height=380)
