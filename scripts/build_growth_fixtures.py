"""성장노트 가짜 응답(fixtures/analysis/*.json)을 만든다. 실제 회사·기사·투자자 자료는 쓰지 않는다(가상의 회사 "가나다테크").

실행: .venv/bin/python scripts/build_growth_fixtures.py
- 난수 씨앗을 고정해 같은 파일이 나온다. 기준일은 2026-11-22(한국 시간)이다.
- 만든 뒤 growth/contract.py 타입으로 모두 검사하고, 하나라도 맞지 않으면 파일을 쓰지 않는다.
- 주소는 모두 https://example.com/… 이다(실제 페이지로 가지 않게).
"""
import copy
import json
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pydantic import TypeAdapter  # noqa: E402

from growth import contract as C  # noqa: E402
from growth import limits as L  # noqa: E402

OUT = ROOT / "fixtures" / "analysis"
T0 = datetime(2026, 11, 22, 20, 44, 0, tzinfo=L.KST)
JOB_ID = "5a1c0e7b9d3f4a2e8b6c1d0f9e8a7b6c"
CRNO = "0000000000001"
COMPANY = "주식회사 가나다테크"
QUERY = "가나다테크"
EX = "https://example.com"
ZERO = {"search": 0, "premium": 0, "model": 0, "scholar": 0}

# 기본 단락이 끝나는 초(기준 기업 실측 6.5절의 시각을 그대로 빌림, 값은 가짜)
END = {"identity": 1.4, "official": 10.4, "profile": 22.3, "funding_history": 26.5, "patents": 30.9, "news": 40.2, "facts": 143.5}
DONE_STEP = {"identity": 1, "official": 1, "profile": 2, "funding_history": 3, "patents": 4, "news": 5, "facts": 6}
STEP_T = [1.0, 10.5, 22.5, 26.6, 31.0, 40.3, 143.5]
PAID = {"profile": {"search": 3, "premium": 0, "model": 1, "scholar": 0},
        "facts": {"search": 4, "premium": 0, "model": 4, "scholar": 0},
        "funding_history": {"search": 0, "premium": 2, "model": 0, "scholar": 0},
        "news": {"search": 2, "premium": 0, "model": 1, "scholar": 0},
        "patents": {"search": 2, "premium": 0, "model": 0, "scholar": 0}}

SYL = "가나다라마바사아자차카타파하"
TRIPLES = [SYL[i:i + 3] for i in range(12)]
KO_NAMES = [t + s for s in ("벤처스", "인베스트", "파트너스", "캐피탈") for t in TRIPLES]
KO_NAMES.remove("타파하인베스트")  # F-RIVALS 의 경쟁사 투자기관 이름으로 따로 쓴다
EN_NAMES = [f"Test Ventures {c}" for c in "ABCDEFGHIJK"]
FH_POOL = KO_NAMES[:20] + EN_NAMES                      # 투자 이력의 투자기관 31곳
FACTS_CONFIRMED = KO_NAMES[:15] + KO_NAMES[20:24]       # 원문 확인 투자자 19곳(15곳은 위와 같음)
FACTS_INFERRED = KO_NAMES[24]                           # 추정 1곳(합친 목록에 넣지 않는다)
RIVAL_INVESTOR = "타파하인베스트"
OUTLETS = ["가나다일보", "라마바경제", "사아자뉴스", "차카타신문", "파하IT"]


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


class Ctx:
    def __init__(self, base: datetime = T0):
        self.base = base

    def at(self, sec: float) -> str:
        return iso(self.base + timedelta(seconds=round(sec)))

    @property
    def day(self) -> str:
        return self.base.date().isoformat()


# ---------------------------------------------------------------- 출처·값

def src(kind: str, ctx: Ctx, **kw):
    as_of = kw.pop("as_of", f"{ctx.day} 조회")
    return C.make_source(kind, as_of=as_of, **kw)


def val(display, raw, status, source, quote=None, note=None):
    return {"display": display, "raw": raw, "status": status, "source": source, "quote": quote, "note": note,
            "reason": None, "values": None, "usedIndex": None}


def unavailable(reason, source=None):
    return {"display": None, "raw": None, "status": "unavailable", "source": source, "quote": None, "note": None,
            "reason": reason, "values": None, "usedIndex": None}


def conflicting(alts, used, note=None):
    top = alts[used]
    return {"display": top["display"], "raw": top["raw"], "status": "conflicting", "source": top["source"],
            "quote": top["quote"], "note": note, "reason": None, "values": alts, "usedIndex": used}


# ---------------------------------------------------------------- 단락 결과

def corp(ctx: Ctx, *, crno=CRNO, name=COMPANY, exact=True, ceo="홍길동", founded="2020-09-15",
         address="서울특별시 강남구 예시로 123", snapshot=None, idx=1, former=None):
    region, district = C.split_address(address)
    return {"companyId": crno, "crno": crno, "bzno": f"{idx:010d}", "name": name,
            "names": [name, name.replace("주식회사 ", "")], "formerNames": former,
            "nameEn": "GANADA TECH Inc." if idx == 1 else None,
            "ceo": ceo, "founded": founded, "address": address, "region": region, "district": district,
            "homepage": "www.example.com", "industry": "전자집적회로 제조업" if idx == 1 else None, "mainBiz": None,
            "market": "기타", "updated": "2026-05-01", "exact": exact, "snapshotAt": snapshot}


def identity_result(ctx: Ctx):
    other = corp(ctx, crno="0000000000002", name="가나다테크놀로지 주식회사", exact=False, ceo="김철수",
                 founded="2015-03-02", address="경기도 성남시 분당구 예시로 45", idx=2)
    return {"corp": corp(ctx), "otherCorps": [other], "queriedAt": ctx.at(END["identity"])}


def fin_row(year, rev, op, net, assets, liab, equity, growth=None, margin=None):
    return {"year": year, "periodEnd": f"{year}-12-31", "basis": "별도요약재무제표", "basisShort": "별도", "currency": "KRW",
            "revenue": rev, "operatingIncome": op, "pretaxIncome": net + 1.0e8, "netIncome": net, "totalAssets": assets,
            "totalLiabilities": liab, "totalEquity": equity, "capital": 1.0e9,
            "debtRatioPct": round(liab / equity * 100, 1), "revenueGrowthPct": growth, "operatingMarginPct": margin}


def official_result(ctx: Ctx, *, money=False):
    ops = (-2.1e9, 0.35e9, 0.62e9) if money else (0.12e9, 0.35e9, 0.62e9)
    revs = (1.2e9, 3.4e9, 5.67e9)
    rows = []
    for i, (y, rev, op) in enumerate(zip(("2022", "2023", "2024"), revs, ops)):
        prev = revs[i - 1] if i else None
        growth = round((rev - prev) / prev * 100, 1) if prev else None
        rows.append(fin_row(y, rev, op, op * 0.8, 2.0e10 + i * 5e9, 6.0e9 + i * 1e9, 1.4e10 + i * 4e9, growth,
                            round(op / rev * 100, 1)))
    all_rows = [{**r, "revenueGrowthPct": None, "operatingMarginPct": None} for r in rows]
    months, members = [], 104
    for i in range(12):
        y, m = (2025, 11 + i) if i < 2 else (2026, i - 1)
        joined, left = 3 + i % 3, 1 + (i % 2)
        prev = members
        members = members + joined - left if i else members
        months.append({"month": f"{y}-{m:02d}", "members": members, "joined": joined, "left": left,
                       "change": (members - prev) if i else None})
    first, latest = months[0]["members"], months[-1]["members"]
    nps = {"monthly": months,
           "summary": {"first": first, "latest": latest, "change": latest - first,
                       "changePct": round((latest - first) / first * 100, 1), "period": f"{months[0]['month']} ~ {months[-1]['month']}",
                       "joinedTotal": sum(x["joined"] for x in months), "leftTotal": sum(x["left"] for x in months)},
           "workplace": {"name": "가나다테크", "bznoMasked": "000000****", "industry": "소프트웨어 개발 및 공급업", "address": "서울특별시 강남구"},
           "note": "국민연금 가입자 수는 전체 임직원 수와 같지 않습니다(외국인·임원·단기근로자 등 차이). 신규 취득·상실은 기간별 현황 API의 각 월 기준값입니다."}
    return {"crno": CRNO, "financials": rows, "financialsAll": all_rows, "financialsReason": None, "nps": nps,
            "npsReason": None, "queriedAt": ctx.at(END["official"])}


TECH = [("신경망 가속기", "neural network accelerator"), ("저전력 추론 칩", "low power inference chip"),
        ("메모리 대역폭 최적화", "memory bandwidth optimization"), ("컴파일러 최적화", "deep learning compiler"),
        ("칩렛 설계", "chiplet design"), ("데이터센터 추론", "datacenter inference"), ("온디바이스 AI", "on-device AI"),
        ("양자화", "neural network quantization"), ("가짜낱말", "fake keyword")]


def profile_result(ctx: Ctx):
    return {
        "nameKo": "가나다테크", "nameEn": "Ganada Tech", "aliases": ["GanadaTech"],
        "industry": "AI 반도체 설계",
        "business": ("가나다테크는 데이터센터와 기기 안에서 인공지능 추론을 빠르게 처리하는 칩을 설계한다. 자체 개발한 신경망 가속 구조와 "
                     "컴파일러를 함께 제공해 고객이 기존 모델을 바로 옮겨 쓸 수 있게 한다. 칩 설계와 소프트웨어 도구, 서버 묶음 판매를 "
                     "주요 사업으로 하며 국내 통신·클라우드 기업과 실증 사업을 진행하고 있다. 최근에는 저전력 기기용 제품군을 넓히고 있다."),
        "products": [{"name": f"가나다 칩 A{i}", "desc": f"추론용 신경망 가속 칩 {i}세대"} for i in range(1, 4)]
        + [{"name": "가나다 컴파일러", "desc": "모델 변환·최적화 도구"}, {"name": "가나다 서버", "desc": "가속 칩을 넣은 추론 서버"},
           {"name": "가나다 엣지 모듈", "desc": "기기 안 추론용 소형 모듈"}],
        "coreTech": ["저전력 설계", "신경망 가속 구조", "컴파일러", "칩렛", "메모리 압축", "양자화"],
        "statusNotes": [f"회사 현황 메모 {i}: 공개 자료에서 정리한 가짜 문장입니다." for i in range(1, 8)],
        "techKeywords": [{"ko": ko, "en": en} for ko, en in TECH],
        "govKeywords": ["인공지능", "반도체", "시스템반도체", "AI 칩", "데이터센터", "클라우드", "실증", "기술개발", "R&D",
                        "저전력", "엣지", "서버", "소프트웨어", "설계"],
        "bidKeywords": ["가속기", "반도체", "NPU", "AI 서버", "추론", "데이터센터"],
        "fundField": "ai", "stage": "후기·상장 준비",
        "competitors": [
            {"name": "마바사", "nameEn": "Mabasa", "registeredNameKo": "마바사", "relation": "직접 경쟁", "reason": "같은 추론용 칩 시장에서 경쟁"},
            {"name": "아자차랩스", "nameEn": "Ajacha Labs", "registeredNameKo": "아자차랩스", "relation": "대체 기술", "reason": "다른 방식의 가속 기술로 같은 고객을 노림"},
            {"name": "카타파", "nameEn": None, "registeredNameKo": None, "relation": "유사 사업모델", "reason": "추론 서버 묶음 판매 방식이 비슷함"},
        ],
        "sourceCount": 25,
        "sources": [{"title": f"가나다테크 관련 자료 {i}", "url": f"{EX}/profile/{i}", "date": f"2026-{(i % 10) + 1:02d}-15"} for i in range(1, 26)],
    }


def facts_result(ctx: Ctx, *, conflict=False, nocorp=False, empty=False):
    fields = [
        {"key": "founded", "label": "설립", "value": "2021-01" if conflict else "2020-09", "status": "reported" if conflict else "confirmed",
         "sourceUrl": f"{EX}/facts/founded", "evidence": "가나다테크는 2021년 1월 설립된 반도체 설계 회사다." if conflict else "가나다테크는 2020년 9월 설립됐다.",
         "note": None},
        {"key": "region", "label": "본사 소재지", "value": "부산광역시 해운대구" if nocorp else "서울특별시 강남구",
         "status": "reported" if nocorp else "confirmed", "sourceUrl": f"{EX}/facts/region", "evidence": "본사는 해운대구에 있다." if nocorp else "본사는 서울 강남구에 있다.", "note": None},
        {"key": "industry", "label": "주요 사업", "value": "AI 반도체 설계", "status": "confirmed", "sourceUrl": f"{EX}/facts/industry",
         "evidence": "AI 반도체를 설계하는 가나다테크", "note": None},
        {"key": "employees", "label": "직원 수", "value": "약 120명 (2026-06 기준)", "status": "reported", "sourceUrl": f"{EX}/facts/employees",
         "evidence": "직원은 약 120명이다.", "note": None},
        {"key": "revenue", "label": "매출", "value": "약 100억원 (2025, 별도)", "status": "reported", "sourceUrl": f"{EX}/facts/revenue",
         "evidence": "지난해 매출은 약 100억원이다.", "note": None},
    ]
    investors = [] if empty else (
        [{"name": n, "round": "시리즈 A" if i % 2 else "시리즈 B", "date": f"202{4 + i % 2}-0{1 + i % 9}", "status": "confirmed",
          "sourceUrl": f"{EX}/facts/investor/{i}"} for i, n in enumerate(FACTS_CONFIRMED)]
        + [{"name": FACTS_INFERRED, "round": None, "date": None, "status": "inferred", "sourceUrl": None}])
    comp = lambda name, dom, status="reported", products=None: {  # noqa: E731
        "name": name, "relation": "직접 경쟁" if dom else "해외 경쟁사", "products": products, "revenue": None, "employees": None,
        "funding": None, "asOf": "2026-06", "status": status, "sourceUrl": f"{EX}/facts/rival/{len(name)}", "domestic": dom}
    competitors = [comp("Mabasa", True, products="추론 칩"), comp("아자차랩스", True), comp("하하테크", True, products="엣지 AI 모듈"),
                   comp("해외갑", False), comp("해외을", False), comp("파파랩", False, status="inferred")]
    return {"fields": fields, "investors": investors, "competitors": competitors, "searches": 4, "pagesRead": 8}


ROUNDS = [  # (날짜, 단계, 금액, 숫자, 통화, 투자기관 범위, 리드 위치)
    ("2026-03-10", "Series C", "$120.0M", 1.2e8, "USD", range(0, 17), [0]),
    ("2025-09-30", "Series B", "$60.0M", 6.0e7, "USD", range(17, 25), [17]),
    ("2025-02-14", "Corporate round", None, None, None, range(25, 27), []),
    ("2024-08-01", "Series B", "$40.0M", 4.0e7, "USD", list(range(27, 31)) + [0, 1], [27]),
    ("2024-01-15", "Series A", "$20.0M", 2.0e7, "USD", range(2, 7), [2]),
    ("2023-06-20", "Series A", "$7.5M", 7.5e6, "USD", range(7, 11), []),
    ("2022-11-03", "Undisclosed series", None, None, None, range(11, 13), []),
    ("2022-03-08", "Seed", "$1.5M", 1.5e6, "USD", range(13, 16), [13]),
    ("2021-07-12", "Seed", "$0.8M", 8.0e5, "USD", range(16, 18), []),
    ("2020-12-01", "Seed", None, None, None, range(18, 19), []),
]
MONEY_AMOUNTS = [("$80.0M", 8.0e7, "USD"), ("$70.0M", 7.0e7, "USD"), ("150억원", 1.5e10, "KRW"), ("$50.0M", 5.0e7, "USD"),
                 ("80억원", 8.0e9, "KRW"), ("$30.0M", 3.0e7, "USD"), ("50억원", 5.0e9, "KRW"), ("$15.0M", 1.5e7, "USD"),
                 ("20억원", 2.0e9, "KRW"), ("$5.0M", 5.0e6, "USD")]


def rounds_list(*, money=False, pool=FH_POOL, prefix=""):
    out = []
    for i, (d, label, amt, v, cur, who, lead) in enumerate(ROUNDS):
        if money:
            amt, v, cur = MONEY_AMOUNTS[i]
        names = list(dict.fromkeys(pool[j % len(pool)] for j in who))
        src_label = "People Data Labs"
        out.append({"id": f"{prefix}r{i + 1}", "date": d, "reportedDate": None, "round": label, "amount": amt, "amountValue": v,
                    "currency": cur, "otherAmounts": ["$55M"] if i == 1 else [], "investors": names,
                    "lead": list(dict.fromkeys(pool[j % len(pool)] for j in lead)), "entity": "Ganada Tech", "entityMatch": "exact",
                    "sourceType": "premium_structured", "sources": [{"type": "Premium", "label": src_label, "url": None}],
                    "raw": f"{label}, {d}" + (f": {amt}" if amt else ""), "summary": None})
    return out


def investor_table(rounds):
    agg: dict[str, dict] = {}
    for r in rounds:
        for n in r["investors"]:
            a = agg.setdefault(n, {"name": n, "roundCount": 0, "roundLabels": [], "lastDate": None, "lead": False})
            a["roundCount"] += 1
            a["roundLabels"].append(f"{r['round']} {(r['date'] or '')[:7]}".strip())
            a["lastDate"] = max(a["lastDate"] or "", r["date"] or "") or None
            a["lead"] = a["lead"] or n in r["lead"]
    rows = sorted(agg.values(), key=lambda a: a["lastDate"] or "", reverse=True)
    return sorted(rows, key=lambda a: -a["roundCount"])


def funding_result(ctx: Ctx, *, money=False, empty=False):
    rounds = [] if empty else rounds_list(money=money)
    inv = investor_table(rounds)
    if empty:
        cum = {"basis": "none", "label": "미확보", "byCurrency": {}, "roundsWithAmount": 0, "roundsTotal": 0, "entity": None, "note": None}
    elif money:
        by: dict[str, float] = {}
        for r in rounds:
            by[r["currency"]] = by.get(r["currency"], 0.0) + r["amountValue"]
        cum = {"basis": "rounds_sum", "label": "라운드 금액 합계", "byCurrency": by, "roundsWithAmount": len(rounds),
               "roundsTotal": len(rounds), "entity": None, "note": f"중복 정리한 라운드 {len(rounds)}건 중 금액 확인 {len(rounds)}건 합산(통화별, 환산 없음)"}
    else:
        cum = {"basis": "pdl_total", "label": "People Data Labs 누적액", "byCurrency": {"USD": 2.5e8}, "roundsWithAmount": None,
               "roundsTotal": len(rounds), "entity": "Ganada Tech", "note": "PDL 회사 카드 total_raised(Ganada Tech)"}
    latest = {"date": rounds[0]["date"], "round": rounds[0]["round"], "amount": rounds[0]["amount"]} if rounds else None
    related = [] if empty else [{"name": "Ganada Technology Holdings", "website": "example.com", "location": "Seoul, Korea",
                                 "totalRaised": "$5.0M", "fundingStage": "series_a", "roundCount": 1}]
    return {"company": "가나다테크", "nameEn": "Ganada Tech", "rounds": rounds, "investors": inv,
            "summary": {"roundCount": len(rounds), "investorCount": len(inv), "latest": latest, "cumulative": cum},
            "relatedEntities": related, "webUsed": empty, "queriedAt": ctx.at(END["funding_history"])}


CAT_WEIGHTS = {"기술개발": 301, "해외 진출": 227, "사업제휴": 192, "수주·계약": 149, "경영진·인터뷰": 142, "정부 관련": 137,
               "투자유치": 131, "제품 출시": 115, "매출·실적": 83, "기타 동향": 44}
PHRASE = {"기술개발": "새 가속 구조 공개", "해외 진출": "해외 고객과 실증", "사업제휴": "협력 협약 체결", "수주·계약": "공급 계약 체결",
          "경영진·인터뷰": "대표 인터뷰", "정부 관련": "정부 과제 선정", "투자유치": "투자 유치", "제품 출시": "신제품 출시",
          "매출·실적": "실적 발표", "기타 동향": "행사 참가"}


def all_articles(ctx: Ctx, n=693):
    rng = random.Random(20261122)
    cats, weights = list(CAT_WEIGHTS), list(CAT_WEIGHTS.values())
    days = sorted((int(rng.triangular(0, 364, 0)) for _ in range(n)))
    out = []
    for i, d in enumerate(days):
        first = rng.choices(cats, weights)[0]
        chosen = [first]
        if first != "기타 동향":
            for extra in (0.4, 0.15):
                if rng.random() < extra:
                    c = rng.choices(cats[:-1], weights[:-1])[0]
                    if c not in chosen:
                        chosen.append(c)
        date = (ctx.base.date() - timedelta(days=d)).isoformat()
        out.append({"id": f"a{i + 1}", "date": date, "title": f"가나다테크, {PHRASE[first]} 소식 {i + 1}",
                    "description": f"가나다테크가 {PHRASE[first]} 관련 내용을 알렸다는 가짜 기사 발췌 {i + 1}.",
                    "outlet": rng.choice(OUTLETS), "url": f"{EX}/news/{i + 1}", "naverUrl": f"{EX}/naver/{i + 1}",
                    "categories": chosen, "relatedCount": 1 if rng.random() < 0.7 else rng.randint(2, 5)})
    return out


def category_counts(articles):
    counts = {c: 0 for c in C.NEWS_CATEGORIES}
    for a in articles:
        for c in a["categories"]:
            counts[c] += 1
    order = {c: i for i, c in enumerate(C.NEWS_CATEGORIES)}
    return [{"category": c, "count": v} for c, v in sorted(counts.items(), key=lambda kv: (-kv[1], order[kv[0]]))]


def news_result(ctx: Ctx, articles, *, empty=False, keep=20):
    if empty:
        articles = []
    picks = [articles[i] for i in (2, 9, 25, 40, 61, 88, 120, 150, 190, 230, 280, 330, 400, 470)] if articles else []
    ev_cat = ["해외 진출", "투자 유치", "제품 출시", "수주·계약", "기술 개발", "정부 사업", "제휴", "실적", "인사", "전시회",
              "인증", "특허", "고객 확보", "연구 협력"]
    events = []
    for i, a in enumerate(picks):
        events.append({"date": a["date"][:7] if i % 5 == 4 else a["date"], "category": ev_cat[i],
                       "title": f"가나다테크 {ev_cat[i]} 관련 가짜 사건 {i + 1}",
                       "detail": f"가짜 기사에서 정리한 설명입니다. 금액과 상대방은 기사에 적힌 것만 씁니다({i + 1}).",
                       "articleId": a["id"], "articleTitle": a["title"], "articleUrl": a["url"], "outlet": a["outlet"],
                       "articleDate": a["date"]})
    since = (ctx.base.date() - timedelta(days=365)).isoformat()
    return {"period": f"{since} ~ {ctx.day}", "rawCount": 0 if empty else 1400, "apiCounts": {"naver": 0 if empty else 1380, "liner": 0 if empty else 20},
            "articleTotal": len(articles), "categoryCounts": category_counts(articles), "articles": articles[:keep],
            "events": events, "trends": [] if empty else [f"가짜 흐름 문장 {i}: 최근 사업 변화를 짧게 적은 줄입니다." for i in range(1, 6)],
            "longSummary": None if empty else "긴요약표지 " + "이 문단은 화면에 보이면 안 되는 긴 뉴스 요약입니다. " * 12,
            "errors": []}


def patents_result(ctx: Ctx, *, empty=False):
    if empty:
        pats, mentions = [], []
    else:
        years = ["2025", "2025", "2025", "2024", "2024", "2023", "2023", "2023", "2022", "2022", "2021"]
        pats = []
        for i, y in enumerate(years):
            no = f"10-{y}-99999{i + 1:02d}"
            reg = i not in (0, 1, 3)  # 등록 8건
            pats.append({"id": no, "title": f"신경망 연산 가속 장치 및 방법 {i + 1}", "assignee": COMPANY, "applicationNo": no,
                         "filingDate": f"{y}-{(i % 9) + 1:02d}-1{i % 9}", "publicationNo": f"KR{y}99999{i + 1:02d}A",
                         "publicationDate": f"{int(y) + 1}-0{(i % 8) + 1}-01" if int(y) < 2025 else None,
                         "registrationNo": f"KR{y}99999{i + 1:02d}B1" if reg else None,
                         "registrationDate": f"{int(y) + 1}-1{i % 3}-05" if reg else None,
                         "legalStatus": "Active" if reg else "Pending", "cpc": ["G06N 3/063", "G06F 9/50"],
                         "techFields": ["G06N 신경망 연산"], "abstract": f"입력 데이터를 나눠 병렬로 처리하는 신경망 가속 장치에 관한 가짜 요약 {i + 1}.",
                         "url": f"{EX}/patent/{i + 1}"})
        mentions = [{"pubNo": "KR2024999990A", "title": "다른 회사의 연산 장치", "assignee": "주식회사 다른회사", "filingDate": "2024-02-02",
                     "url": f"{EX}/patent/mention/1"}]
    by_year: dict[str, int] = {}
    for p in pats:
        by_year[p["filingDate"][:4]] = by_year.get(p["filingDate"][:4], 0) + 1
    return {"summary": {"total": len(pats), "registered": sum(1 for p in pats if p["registrationNo"]),
                        "recent5": sum(v for y, v in by_year.items() if int(y) > 2021), "byYear": by_year,
                        "withFilingDate": len(pats), "noFilingDate": 0},
            "patents": pats, "mentions": mentions, "pagesChecked": 4 if empty else 30, "pagesLimit": L.PATENT_PAGES_PER_COMPANY,
            "candidatesLeft": 0 if empty else 71,
            "basis": "Liner 웹 검색으로 찾은 Google Patents 공개 문서 중 원문에서 출원인이 확인된 KR 특허",
            "note": "검색으로 확인된 공개 특허입니다. 미공개 출원(출원 후 약 18개월)·검색에 걸리지 않은 특허는 빠지므로 전체 출원 건수가 아닙니다.",
            "errors": [], "queriedAt": ctx.at(END["patents"])}


def rival_patent_items():
    """마바사 특허 낱건 6건(출원일 최근순, 등록 4건 — 요약 {total 6, registered 4, byYear}와 맞춘다). 계약 8.9 RivalPatent."""
    years = ["2025", "2024", "2024", "2023", "2023", "2022"]
    out = []
    for i, y in enumerate(years):
        no = f"10-{y}-88888{i + 1:02d}"
        reg = i not in (0, 2)
        out.append({"id": no, "title": f"추론 칩 메모리 배치 방법 {i + 1}", "assignee": "주식회사 마바사", "applicationNo": no,
                    "filingDate": f"{y}-{9 - i:02d}-2{i}", "publicationNo": f"KR{y}88888{i + 1:02d}A",
                    "registrationNo": f"KR{y}88888{i + 1:02d}B1" if reg else None, "url": f"{EX}/patent/rival/m{i + 1}"})
    return out


def rival_summary_inputs():
    """마바사 요약 모델에 넘긴 기사 4건(최신순, 마지막 건은 Liner 검색 결과라 naverUrl 없음). 계약 8.9 RivalSummaryInput."""
    rows = [("2026-11-10", "마바사, 추론 칩 2세대 공개", "가나다일보", True), ("2026-10-02", "마바사 데이터센터 공급 계약", "라마바경제", True),
            ("2026-08-19", "마바사 컴파일러 업데이트", "사아자뉴스", True), ("2026-05-04", "마바사 해외 법인 설립", "example.com", False)]
    return [{"title": t, "url": f"{EX}/news/rival/m{i + 1}", "naverUrl": f"{EX}/naver/rival/m{i + 1}" if nv else None, "date": d, "outlet": o}
            for i, (d, t, o, nv) in enumerate(rows)]


def rivals_deep_result(ctx: Ctx, started: float, seconds: float):
    fh = funding_result(ctx)
    m_rounds = rounds_list(pool=[RIVAL_INVESTOR, "Test Ventures X", "Test Ventures Y"], prefix="m")[:3]
    # 웹 보완 기사 출처(계약 8.5 sources[].url — Web 만 주소가 있다). 나란히 비교 표의 투자 칸 원문 링크 시험용(screens 4B.2)
    m_rounds[0]["sources"].append({"type": "Web", "label": "마바사 시리즈 C 투자 유치 기사", "url": f"{EX}/news/rival/round/m1"})
    m_rounds[1]["sources"].append({"type": "Web", "label": "마바사 시리즈 B 투자 기사", "url": f"{EX}/news/rival/round/m2"})
    mabasa_corp = corp(ctx, crno="0000000000003", name="주식회사 마바사", ceo="이영희", founded="2018-04-02",
                       address="대전광역시 유성구 예시로 7", idx=3)
    return {
        "rivalSet": ["rival:마바사", "rival:하하테크"],
        "rivals": [
            {"key": "rival:마바사", "name": "마바사", "nameEn": "Mabasa", "corp": mabasa_corp,
             "financials": official_result(ctx)["financials"], "financialsReason": None,
             "nps": official_result(ctx)["nps"], "npsReason": None,
             "funding": {"rounds": m_rounds, "summary": {**fh["summary"], "roundCount": 3, "investorCount": 3,
                                                          "latest": {"date": m_rounds[0]["date"], "round": m_rounds[0]["round"], "amount": m_rounds[0]["amount"]},
                                                          "cumulative": {"basis": "rounds_partial_sum", "label": "라운드 금액 합계 (금액이 있는 라운드 2건만 더함)",
                                                                         "byCurrency": {"USD": 1.8e8}, "roundsWithAmount": 2, "roundsTotal": 3, "entity": None,
                                                                         "note": "중복 정리한 라운드 3건 중 금액 확인 2건 합산(통화별, 환산 없음)"}},
                         "investors": [RIVAL_INVESTOR, "Test Ventures X", "Test Ventures Y"]},
             "fundingReason": None, "patents": {"total": 6, "registered": 4, "byYear": {"2022": 1, "2023": 2, "2024": 2, "2025": 1},
                                                "items": rival_patent_items()},
             "patentsReason": None,
             "summary": {"business": "마바사는 추론용 칩을 만드는 가짜 경쟁사다.", "productsTech": "추론 칩, 컴파일러",
                         "recentChanges": ["가짜 변화 1", "가짜 변화 2", "가짜 변화 3"], "inputArticles": rival_summary_inputs()}, "errors": []},
            # 하하테크: 출원인 확인 특허 0건(items []), 기사 없이 쓴 요약(inputArticles [])
            {"key": "rival:하하테크", "name": "하하테크", "nameEn": None, "corp": None, "financials": [],
             "financialsReason": "금융위원회 재무 자료 없음", "nps": None, "npsReason": "국민연금 사업장을 찾지 못함",
             "funding": None, "fundingReason": "투자 라운드 자료 없음", "patents": {"total": 0, "registered": 0, "byYear": {}, "items": []},
             "patentsReason": None, "summary": {"business": "하하테크는 엣지 AI 모듈을 만드는 가짜 경쟁사다.", "productsTech": "엣지 AI 모듈",
                                                 "recentChanges": [], "inputArticles": []},
             "errors": ["법인이 확인되지 않아 공식 재무·고용 자료가 없습니다."]},
        ],
        "rivalInvestors": [{"rivalKey": "rival:마바사", "rivalName": "마바사", "investors": [RIVAL_INVESTOR, "Test Ventures X", "Test Ventures Y"]}],
        "queriedAt": ctx.at(started + seconds),
    }


def sales_result(ctx: Ctx, keywords, tech_ko, *, partial=False, started=300.0, seconds=6.0):
    spec = ["open"] * 7 + ["upcoming"] * 2 + ["closed"] * 3
    items = []
    for i, st in enumerate(spec):
        day = ctx.base.date() + timedelta(days={"open": 3 + i, "upcoming": 10 + i, "closed": -2 - i}[st])
        begin = ctx.base.date() - timedelta(days=5) if st != "upcoming" else ctx.base.date() + timedelta(days=2 + i)
        kw = keywords[i % len(keywords)]
        items.append({"id": f"R26BK999{i:05d}-000", "title": f"{kw} 관련 장비 구매 가짜 공고 {i + 1}", "agency": "가나다시청 / 예시공단",
                      "kind": "물품" if i % 3 else "용역", "summary": "일반경쟁 · 총액", "amount": "3.20억원" if i % 4 else "공고문 확인",
                      "period": f"{begin} 10:00 ~ {day} 18:00", "bidBegin": f"{begin} 10:00", "bidClose": f"{day} 18:00",
                      "deadline": day.isoformat(), "status": st, "condition": "물품분류 제한" if i % 5 == 0 else "참가자격은 공고문 확인",
                      "relevance": "high" if i in (0, 2, 7, 9) else "normal", "keywords": [kw], "url": f"{EX}/bid/{i + 1}",
                      "noticeDate": (ctx.base.date() - timedelta(days=6)).isoformat()})
    errs = ["반도체/물품 구간 1건: 나라장터 응답 오류", "NPU/용역 구간 1건: 나라장터 응답 오류"] if partial else []
    start_day = ctx.base.date() - timedelta(days=27)
    return {"keywords": keywords, "strongKeywords": keywords[:3] + tech_ko[:3], "period": f"{start_day} ~ {ctx.day}", "items": items,
            "calls": 48, "errorCount": len(errs), "skipped": 0, "errors": errs, "queriedAt": ctx.at(started + seconds)}


# ---------------------------------------------------------------- 합친 값(merged)

def merged_for(ctx: Ctx, done: dict, *, nocorp=False, conflict=False, empty=False, terminal=False, job_running=True):
    """done: 끝난 단락 → 결과(없으면 None). 계약 7절 규칙대로 합친다(가짜 응답에 필요한 만큼만 구현)."""
    corp_src = src("fsc_corp", ctx)
    f = done.get("facts")
    facts_done = "facts" in done
    fields = {x["key"]: x for x in (f or {}).get("fields", [])}

    def web_value(key, display=None):
        x = fields.get(key)
        if not x:
            return unavailable("자료 없음")
        kind = "web_page" if x["status"] == "confirmed" else "web_snippet"
        source = src(kind, ctx, host="example.com", url=x["sourceUrl"]) if kind == "web_page" else src(kind, ctx, url=x["sourceUrl"])
        return val(display or x["value"], x["value"], x["status"], source, quote=x["evidence"])

    ident = done.get("identity")
    c = ident["corp"] if ident else None
    m = {"region": None, "district": None, "headquarters": None, "ceo": None, "founded": None,
         "bizType": unavailable("근거 자료 없음"), "bizTypeHint": None, "industry": {"official": None, "web": None},
         "employees": None, "revenue": {"official": None, "web": None}, "npsLatest": None, "patentCount": None,
         "investors": [], "rivals": [], "techKeywords": [], "programKeywords": [], "fundField": None, "bidKeywords": [], "pending": []}
    if "identity" in done:
        if c:
            m["region"] = val(c["region"], c["region"], "confirmed", corp_src)
            m["district"] = c["district"]
            m["headquarters"] = val(f"{c['region']} {c['district']}", c["address"], "confirmed", corp_src)
            m["ceo"] = val(c["ceo"], c["ceo"], "confirmed", corp_src)
            m["founded"] = val(c["founded"], c["founded"], "confirmed", corp_src)
            m["industry"]["official"] = val(c["industry"], c["industry"], "confirmed", corp_src) if c["industry"] else unavailable("공공 자료에 업종 없음", corp_src)
        else:
            m["ceo"] = unavailable("법인 확인 안 함")
            m["industry"]["official"] = unavailable("법인 확인 안 함")
            if facts_done:
                region_field = fields.get("region")
                r, d = C.split_address(region_field["value"]) if region_field else (None, None)
                hq = web_value("region", f"{r} {d}" if d else r)
                m["region"] = {**hq, "display": r, "raw": r}
                m["district"] = d
                m["headquarters"] = hq
                m["founded"] = web_value("founded")
    if "official" in done:
        o = done["official"]
        if o:
            last = o["financials"][-1]
            m["revenue"]["official"] = val(C.won_display(last["revenue"]), last["revenue"], "confirmed",
                                           src("fsc_fin", ctx, as_of=f"{last['year']} 사업연도", basis=last["basisShort"]))
            mon = o["nps"]["monthly"][-1]
            m["npsLatest"] = val(f"{mon['members']}명", mon["members"], "reference", src("nps", ctx, as_of=mon["month"]),
                                 note="국민연금 가입자 수는 상시근로자 수와 다릅니다.")
        else:
            m["revenue"]["official"] = unavailable("법인 확인 안 함" if nocorp else "공식 재무 자료 없음")
            m["npsLatest"] = unavailable("법인 확인 안 함" if nocorp else "국민연금 사업장을 찾지 못함")
    p = done.get("profile")
    if p:
        m["techKeywords"] = p["techKeywords"]
        prog = list(dict.fromkeys(p["govKeywords"] + [k["ko"] for k in p["techKeywords"]] + p["coreTech"]))[:30]
        m["programKeywords"] = prog
        m["bidKeywords"] = p["bidKeywords"][:6]
        m["fundField"] = val(C.FUND_FIELD_LABEL[p["fundField"]], p["fundField"], "inferred", src("liner_profile", ctx, n=str(p["sourceCount"])))
        if not facts_done:
            m["industry"]["web"] = val(p["industry"], p["industry"], "inferred", src("liner_profile", ctx, n=str(p["sourceCount"])))
        rivals = []
        for comp in p["competitors"]:
            rivals.append({"key": "rival:" + C.norm_name(comp["registeredNameKo"] or comp["name"]), "name": comp["name"], "nameEn": comp["nameEn"],
                           "registeredNameKo": comp["registeredNameKo"], "relation": comp["relation"], "reason": comp["reason"],
                           "status": "inferred", "foundIn": ["profile"], "products": None, "employees": None, "revenue": None,
                           "funding": None, "sources": [src("liner_profile", ctx, n=str(p["sourceCount"]))]})
        m["rivals"] = rivals
    fh = done.get("funding_history")
    if fh is not None or "funding_history" in done:
        rounds = (fh or {}).get("rounds") or []
        if rounds and m["founded"] and m["founded"]["display"]:
            m["bizTypeHint"] = {"id": "venture", "reason": f"설립 {str(m['founded']['raw'])[:7]}, 투자 라운드 {len(rounds)}건"}
        invs = []
        for row in (fh or {}).get("investors") or []:
            invs.append({"key": C.norm_name(row["name"]), "name": row["name"], "aliases": [], "status": "reported",
                         "roundCount": row["roundCount"], "roundLabels": row["roundLabels"], "lastDate": row["lastDate"], "lead": row["lead"],
                         "foundIn": ["funding_history"], "sources": [src("pdl", ctx)]})
        m["investors"] = invs
    pt = done.get("patents")
    if "patents" in done:
        if pt and pt["summary"]["total"]:
            m["patentCount"] = val(f"{pt['summary']['total']}건", pt["summary"]["total"], "confirmed", src("patents", ctx))
        else:
            m["patentCount"] = unavailable("출원인이 확인된 특허를 찾지 못함")
    if facts_done and f:
        if c and conflict:
            web = fields["founded"]
            m["founded"] = conflicting([
                {"display": c["founded"], "raw": c["founded"], "source": corp_src, "quote": None},
                {"display": web["value"], "raw": web["value"], "source": src("web_snippet", ctx, url=web["sourceUrl"]), "quote": web["evidence"]},
            ], 0)
        m["employees"] = web_value("employees")
        m["revenue"]["web"] = web_value("revenue")
        m["industry"]["web"] = web_value("industry")
        by_key = {x["key"]: x for x in m["investors"]}
        for x in f["investors"]:
            if x["status"] not in ("confirmed", "reported"):
                continue
            k = C.norm_name(x["name"])
            s = src("web_page", ctx, host="example.com", url=x["sourceUrl"]) if x["status"] == "confirmed" else src("web_snippet", ctx, url=x["sourceUrl"])
            if k in by_key:
                row = by_key[k]
                row["status"] = "confirmed" if x["status"] == "confirmed" else row["status"]
                row["foundIn"] = ["funding_history", "facts"]
                row["sources"] = row["sources"] + [s]
            else:
                row = {"key": k, "name": x["name"], "aliases": [], "status": x["status"], "roundCount": 1,
                       "roundLabels": [f"{x['round'] or '라운드 미상'} {(x['date'] or '')[:7]}".strip()], "lastDate": x["date"],
                       "lead": False, "foundIn": ["facts"], "sources": [s]}
                by_key[k] = row
                m["investors"].append(row)
        by_rival = {r["key"]: r for r in m["rivals"]}
        names = {}
        for r in m["rivals"]:
            for n in (r["name"], r["nameEn"], r["registeredNameKo"]):
                if n:
                    names[C.norm_name(n)] = r
        extra = []
        for x in f["competitors"]:
            if not x["domestic"]:
                continue
            s = src("web_snippet", ctx, url=x["sourceUrl"])
            hit = names.get(C.norm_name(x["name"]))
            if hit:
                hit["foundIn"] = ["profile", "facts"]
                hit["status"] = x["status"] if x["status"] in ("confirmed", "reported") else hit["status"]
                hit["products"] = x["products"]
                hit["sources"] = hit["sources"] + [s]
            else:
                key = "rival:" + C.norm_name(x["name"])
                if key not in by_rival:
                    extra.append({"key": key, "name": x["name"], "nameEn": None, "registeredNameKo": None, "relation": x["relation"],
                                  "reason": None, "status": x["status"] if x["status"] in ("confirmed", "reported") else "inferred",
                                  "foundIn": ["facts"], "products": x["products"], "employees": x["employees"], "revenue": x["revenue"],
                                  "funding": x["funding"], "sources": [s]})
        both = [r for r in m["rivals"] if len(r["foundIn"]) == 2]
        only = [r for r in m["rivals"] if len(r["foundIn"]) == 1]
        m["rivals"] = both + only + extra
    elif facts_done or terminal:
        reason = "분석이 중간에 멈춤" if terminal else "자료를 얻지 못함"
        m["employees"] = unavailable(reason)
        m["revenue"]["web"] = unavailable(reason)
        if m["industry"]["web"] is None:
            m["industry"]["web"] = unavailable(reason)
    if terminal:
        for k in ("region", "headquarters", "ceo", "founded", "npsLatest", "patentCount", "fundField"):
            if m[k] is None:
                m[k] = unavailable("분석이 중간에 멈춤")
        for k in ("official", "web"):
            for g in ("industry", "revenue"):
                if m[g][k] is None:
                    m[g][k] = unavailable("분석이 중간에 멈춤")
    m["investors"].sort(key=lambda r: r["lastDate"] or "", reverse=True)
    m["investors"].sort(key=lambda r: (not r["lead"], -r["roundCount"]))
    if job_running and not facts_done:
        m["pending"] = ["employees", "revenue.web", "industry.web", "founded.web"] + (["region.web"] if nocorp else []) + ["investors.confirmed", "rivals.facts"]
    return m


# ---------------------------------------------------------------- 작업 조립

def envelope(ctx: Ctx, key, status, *, started=None, seconds=None, result=None, error=None, retryable=False, waiting=(),
             paid=None, stage=None, rerun=None):
    terminal = status in C.TERMINAL_SECTION_STATUSES
    return {"key": key, "status": status, "stage": stage, "startedAt": None if started is None else ctx.at(started),
            "seconds": None if seconds is None else round(seconds, 1), "expectedSeconds": C.EXPECTED_SECONDS[key],
            "analyzedAt": ctx.at(started + seconds) if terminal and started is not None and seconds is not None else None,
            "result": result, "error": error, "retryable": retryable, "waitingFor": list(waiting), "rerun": rerun,
            "paid": dict(paid or ZERO)}


def sec_error(code, message, *, source=None, retry_at=None):
    return {"code": code, "message": message, "source": source, "retryAt": retry_at}


STAGE = {"identity": "법인 찾기", "official": "재무·국민연금 조회", "profile": "회사 자료 검색", "facts": "원문 확인",
         "funding_history": "투자 DB 조회", "news": "뉴스 수집", "patents": "특허 원문 확인"}


def make_job(*, step=6, base=T0, nocorp=False, conflict=False, empty=False, money=False, html=False, limit_news=False,
             interrupted_after=None, example=False, rivals=False, sales=None):
    ctx = Ctx(base)
    articles = all_articles(ctx)
    if html:
        articles[0] = {**articles[0], "title": "<b>굵게</b>"}
    results = {
        "identity": None if nocorp else identity_result(ctx),
        "official": None if nocorp else official_result(ctx, money=money),
        "profile": profile_result(ctx),
        "facts": facts_result(ctx, conflict=conflict, nocorp=nocorp, empty=empty),
        "funding_history": funding_result(ctx, money=money, empty=empty),
        "news": None if limit_news else news_result(ctx, articles, empty=empty),
        "patents": patents_result(ctx, empty=empty),
    }
    if html:
        results["patents"]["patents"][0]["abstract"] = "<img src=x onerror=alert(1)>"
    end = dict(END)
    if nocorp:
        end["identity"], end["official"] = 0.0, 0.0
    if limit_news:
        end["news"] = END["profile"]
    sections, done = {}, {}
    now_t = STEP_T[step]
    for key in C.BASIC_SECTIONS:
        finished = DONE_STEP[key] <= step if interrupted_after is None else DONE_STEP[key] <= interrupted_after
        if finished:
            done[key] = results[key]
            status, err, retry = "done", None, key == "news"
            paid = PAID.get(key, ZERO)
            if key in ("identity", "official") and nocorp:
                status, retry, paid = "unavailable", False, ZERO
                err = sec_error("no_corp", "법인이 확인되지 않아 공식 재무·고용 자료가 없습니다.")
            elif key == "news" and limit_news:
                status, retry, paid = "unavailable", False, ZERO
                err = sec_error("daily_limit", "오늘 호출 상한에 닿아 이 단락을 확인하지 못했습니다. 내일 0시 이후에 다시 분석할 수 있습니다.",
                                retry_at=iso(L.next_reset(ctx.base)))
            elif empty and key in ("funding_history", "news", "patents"):
                status, retry = "unavailable", True
                msg = {"funding_history": "투자 라운드 자료를 찾지 못했습니다. 투자 이력이 없다는 뜻은 아닙니다.",
                       "news": "최근 12개월 기사를 찾지 못했습니다.",
                       "patents": "출원인이 이 회사로 확인된 국내 특허를 찾지 못했습니다. 검색에 걸리지 않은 특허는 빠집니다."}[key]
                err = sec_error("no_data", msg)
                if key == "news":
                    paid = {**paid, "model": 0}
            sections[key] = envelope(ctx, key, status, started=0.0, seconds=end[key], result=results[key], error=err,
                                     retryable=retry and not example, paid=paid)
        elif interrupted_after is not None:
            sections[key] = envelope(ctx, key, "unavailable", started=0.0, seconds=STEP_T[interrupted_after],
                                     error=sec_error("interrupted", "분석이 중간에 멈췄습니다."), retryable=not example)
        else:
            deps = [d for d in C.DEPENDS_ON[key] if DONE_STEP[d] > step]
            status = "waiting" if deps else "running"
            sections[key] = envelope(ctx, key, status, started=0.0, seconds=now_t, waiting=deps,
                                     stage=None if deps else STAGE[key])
    profile_done = "profile" in done and done["profile"] is not None
    paper_deps = [] if profile_done else ["profile"]
    sections["papers"] = envelope(ctx, "papers", "idle", waiting=paper_deps, retryable=profile_done and not example)
    sections["rivals_deep"] = envelope(ctx, "rivals_deep", "idle", retryable=not example)
    sections["sales"] = envelope(ctx, "sales", "idle", retryable=True)
    if rivals:
        res = rivals_deep_result(ctx, 200.0, 48.0)
        sections["rivals_deep"] = envelope(ctx, "rivals_deep", "done", started=200.0, seconds=48.0, result=res, retryable=True,
                                           paid={"search": 9, "premium": 4, "model": 2, "scholar": 0})
    if sales:
        prof = results["profile"]
        res = sales_result(ctx, prof["bidKeywords"], [k["ko"] for k in prof["techKeywords"]], partial=sales == "partial")
        err = sec_error("upstream_error", f"일부 기간 조회에 실패했습니다 ({res['errorCount']}건).", source="조달청 나라장터") if sales == "partial" else None
        sections["sales"] = envelope(ctx, "sales", "partial" if sales == "partial" else "done", started=300.0, seconds=6.0,
                                     result=res, error=err, retryable=True)
    terminal_job = interrupted_after is not None or step == 6
    job_status = "interrupted" if interrupted_after is not None else ("done" if step == 6 else "running")
    merged = merged_for(ctx, {k: v for k, v in done.items()}, nocorp=nocorp, conflict=conflict, empty=empty,
                        terminal=interrupted_after is not None, job_running=not terminal_job)
    paid = {k: sum(s["paid"][k] for s in sections.values()) for k in ZERO}
    analyzed = (ctx.at(END["facts"]) if step == 6 and interrupted_after is None
                else ctx.at(STEP_T[interrupted_after]) if interrupted_after is not None else None)
    company_id = C.company_id_for(QUERY) if nocorp else CRNO
    return {
        "contractVersion": C.CONTRACT_VERSION, "jobId": JOB_ID, "companyId": company_id, "query": QUERY,
        "company": {"name": COMPANY if done.get("identity") else QUERY, "crno": None if nocorp else CRNO},
        "status": job_status, "busy": job_status == "running", "startedAt": ctx.at(0), "analyzedAt": analyzed,
        "isExample": example, "sections": sections, "merged": merged, "paid": {"liner": paid},
        "estimates": copy.deepcopy(C.ESTIMATES),
        "refresh": {"remainingToday": 0 if example else L.REFRESH_PER_COMPANY_PER_DAY, "limitPerDay": L.REFRESH_PER_COMPANY_PER_DAY},
    }, articles


# ---------------------------------------------------------------- 그 밖의 응답

def news_page(job, articles, *, offset=0, limit=20, categories=()):
    pool = [a for a in articles if not categories or set(a["categories"]) & set(categories)]
    return {"jobId": job["jobId"], "offset": offset, "limit": limit, "categories": list(categories), "total": len(pool),
            "articleTotal": len(articles), "categoryCounts": category_counts(articles), "items": pool[offset:offset + limit]}


def corp_search(ctx: Ctx, kind: str):
    mk = lambda i, name, exact, snap=None: corp(ctx, crno=f"{i:013d}", name=name, exact=exact, idx=i, snapshot=snap,  # noqa: E731
                                                 address=["서울특별시 강남구 예시로 1", "부산광역시 해운대구 예시로 2", "경기도 성남시 분당구 예시로 3"][i % 3],
                                                 founded=f"20{10 + i}-0{1 + i % 9}-1{i % 9}")
    if kind == "0":
        cands, q = [], "없는회사"
    elif kind == "1":
        cands, q = [mk(1, COMPANY, True)], QUERY
    elif kind == "2":
        # 이름·대표·시군구가 같고 설립일만 다른 두 법인: 한쪽은 합병 뒤 이름을 바꾼 존속법인(이전 이름 있음), 다른 쪽은 이력 없음.
        # 사업자번호·건물까지 나온 주소·이전 이름으로 구분한다(K-10). 주소 하나는 좁은 화면에서 줄이 바뀔 만큼 길다
        same = dict(ceo="홍길동")
        cands = [corp(ctx, crno=f"{1:013d}", name=COMPANY, exact=True, idx=1, founded="2022-01-04", **same,
                      address="경기도 성남시 분당구 예시로 239 (예시동, 가나다타워) 102동 8층",
                      former=[{"name": "주식회사 라마바코리아", "changedOn": "2024-12-11"}]),
                 corp(ctx, crno=f"{2:013d}", name="가나다테크 주식회사", exact=True, idx=2, founded="2020-06-23", **same,
                      address="경기도 성남시 분당구 예시로 3", former=[])]
        q = QUERY
    else:
        cands = [mk(1, COMPANY, True)] + [mk(i, n, False, iso(T0 - timedelta(days=3)) if i == 3 else None) for i, n in
                                          zip(range(2, 8), ["가나다테크놀로지", "가나다테크솔루션", "가나다테크랩", "가나다테크코리아", "가나다테크서비스", "가나다테크글로벌"])]
        q = QUERY
    return {"query": q, "candidates": cands, "queriedAt": ctx.at(1)}


def health(ctx: Ctx):
    usage = {"date": ctx.day, "resetAt": iso(L.next_reset(ctx.base)),
             "apis": {api: {"used": 0, "limit": L.DAILY_LIMITS[api], "remaining": L.DAILY_LIMITS[api]} for api in L.API_NAMES}}
    usage["apis"][L.LINER_SEARCH] = {"used": 11, "limit": 500, "remaining": 489}
    return {"ok": True, "hasKey": True, "paidUsed": 19, "paidLimit": 60, "extractModel": "openai/gpt-6.2-sol",
            "matchModel": "anthropic/claude-opus-5.5", "keys": {"liner": True, "dataGoKr": True, "naver": True, "openalex": False},
            "usage": usage, "analysis": {"running": 0, "maxRunning": L.MAX_RUNNING_ANALYSES}, "contractVersion": C.CONTRACT_VERSION}


def notice_company():
    return {"name": COMPANY, "region": "서울", "biz": "venture", "founded": "2020-09", "industry": "전자집적회로 제조업",
            "employees": "약 120명 (2026-06 기준)", "revenue": "56.7억원 (2024 사업연도, 별도)", "need": "운전자금 3억 원",
            "notes": "확인된 국내 특허 11건(출원인 확인, 등록 8건), 국민연금 가입자 118명(2026-10, 직원 수와 다름)"}


def notice_analysis():
    rows = ([{"field": f, "requirement": f"{f} 조건 가짜 문장", "quote": f"{f} 관련 공고문 가짜 문장", "verdict": "충족", "reason": "회사 값과 맞음"}
             for f in ("지역", "업력", "업종", "기업규모")]
            + [{"field": "제외대상", "requirement": "체납 기업 제외", "quote": "체납 사실이 있는 기업은 제외한다", "verdict": "미충족", "reason": "가짜 판정"}]
            + [{"field": f, "requirement": f"{f} 조건 가짜 문장", "quote": f"{f} 관련 공고문 가짜 문장", "verdict": "확인 필요", "reason": "회사 값에 없음"}
               for f in ("지원대상 기타", "자금용도")]
            + [{"field": f, "requirement": f"{f} 안내 가짜 문장", "quote": f"{f} 관련 공고문 가짜 문장", "verdict": "판단 대상 아님", "reason": "자격과 무관"}
               for f in ("신청방법", "제출서류")])
    return {"program": {"id": "PBLN_000000000000001", "title": "가나다시 지원자금 가짜 공고", "url": f"{EX}/program/1", "docUrl": f"{EX}/program/1.hwpx"},
            "extraction": {"summary": "가나다시 기업 운전자금 융자(가짜)", "notStated": ["금리·보증료"], "doc": {"kind": "hwpx", "pages": None, "chars": 12000, "truncated": False},
                           "model": "openai/gpt-6.2-sol", "extractedAt": "2026-11-22T11:50:00+00:00", "dropped": 0, "cached": False},
            "match": {"overall": "대상 아님", "overallReason": "제외 대상 조건 하나가 맞지 않습니다(가짜).", "adjusted": False, "rows": rows,
                      "questions": [f"기관에 물어볼 가짜 질문 {i}" for i in range(1, 6)], "documents": [f"준비 자료 {i}" for i in range(1, 4)],
                      "model": "anthropic/claude-opus-5.5", "costUsd": 0.0123, "elapsedSec": 21.4}}


def gp_brief():
    facts = [{"kind": k, "text": f"{k} 가짜 사실", "quote": f"{k} 관련 검색 결과 가짜 문장", "sourceUrl": f"{EX}/gp/{i}", "sourceHost": "example.com"}
             for i, k in enumerate(["투자 분야", "투자 단계", "투자 사례", "제안 경로"])]
    return {"gp": "가나다벤처스", "facts": facts, "fit": [{"text": "회사 분야와 투자 분야가 맞닿음(가짜)", "fact": 0}, {"text": "회사 단계와 투자 단계가 맞닿음(가짜)", "fact": 1}],
            "questions": ["가짜 질문 1", "가짜 질문 2"], "sources": [{"title": f"검색 결과 {i}", "url": f"{EX}/gp/src/{i}", "host": "example.com"} for i in range(1, 7)],
            "searched": 6, "model": "openai/gpt-6.2-sol"}


# ---------------------------------------------------------------- 파일

def x(method, path, status, response, *, query=None, request=None, label=None):
    return {"label": label, "method": method, "path": path, "query": query, "request": request, "status": status, "response": response}


def build() -> dict[str, dict]:
    ctx = Ctx()
    jp = f"/api/analysis/{JOB_ID}"
    full, articles = make_job()
    files = {}

    def fixture(name, desc, exchanges, base_date="2026-11-22"):
        files[name] = {"fixture": name, "description": desc, "baseDate": base_date, "exchanges": exchanges}

    fixture("F-FULL", "기본 단락 7개 모두 done. 건수는 기준 기업 실측과 같은 규모(재무 3행, 국민연금 12개월, 라운드 10, 합친 투자기관 35, 특허 11, 기사 693).", [
        x("GET", jp, 200, full),
        x("GET", f"/api/company/{CRNO}/analysis", 200, full),
        x("GET", f"/api/company/{CRNO}/job", 404, {"detail": "진행 중인 분석이 없습니다", "code": "not_found", "retryAt": None}),
        x("GET", f"{jp}/news", 200, news_page(full, articles), query={"offset": 0, "limit": 20}, label="첫 20건"),
        x("GET", f"{jp}/news", 200, news_page(full, articles, offset=20), query={"offset": 20, "limit": 20}, label="다음 20건"),
        x("GET", f"{jp}/news", 200, news_page(full, articles, categories=["수주·계약"]), query={"offset": 0, "limit": 20, "category": ["수주·계약"]}, label="분류 거르기"),
        x("POST", "/api/analysis", 200, {"jobId": JOB_ID, "companyId": CRNO, "started": False}, request={"name": QUERY, "crno": CRNO, "refresh": False}, label="저장된 분석이 있어 시작하지 않음"),
        x("POST", "/api/analysis", 202, {"jobId": JOB_ID, "companyId": CRNO, "started": True}, request={"name": QUERY, "crno": CRNO, "refresh": True}, label="새로 분석"),
        x("POST", f"{jp}/sections/news", 202, {"jobId": JOB_ID, "key": "news", "started": True}, request={}, label="뉴스만 새로"),
        x("POST", f"{jp}/sections/papers", 202, {"jobId": JOB_ID, "key": "papers", "started": True}, request={}),
        x("GET", "/api/health", 200, health(ctx)),
    ])
    files["F-FULL"]["articlesFile"] = "F-FULL.articles.json"
    steps = [x("GET", jp, 200, make_job(step=s)[0], label=f"t{s}") for s in range(7)]
    fixture("F-STAGED", "폴링 응답 7단계. t0 모두 확인 중, t1 official, t2 profile, t3 funding_history, t4 patents, t5 news, t6 facts 끝(값은 F-FULL).", steps)
    lim, _ = make_job(limit_news=True)
    fixture("F-LIMIT-NEWS", "news 만 unavailable(daily_limit), retryable false. 나머지 F-FULL.", [x("GET", jp, 200, lim)])
    noc, _ = make_job(nocorp=True)
    fixture("F-NOCORP", "법인 없이 분석(crno null, 이름 기반 companyId). identity·official 은 no_corp, facts 가 본사 지역 '부산'(보도)을 줌.", [
        x("GET", jp, 200, noc),
        x("POST", "/api/analysis", 202, {"jobId": JOB_ID, "companyId": noc["companyId"], "started": True}, request={"name": QUERY}),
    ])
    con, _ = make_job(conflict=True)
    fixture("F-CONFLICT", "merged.founded 가 conflicting(공공 API 2020-09-15, 기사 2021-01), usedIndex 0.", [x("GET", jp, 200, con)])
    stale_base = T0 - timedelta(days=45)
    stale, _ = make_job(base=stale_base)
    fixture("F-STALE", "analyzedAt 이 기준일(2026-11-22)보다 45일 전.", [x("GET", f"/api/company/{CRNO}/analysis", 200, stale)])
    exa, _ = make_job(example=True)
    fixture("F-EXAMPLE", "예시 회사(isExample true). 유료 단락은 retryable false, refresh.remainingToday 0.", [
        x("GET", "/api/example", 200, {"companyId": CRNO, "jobId": JOB_ID, "name": COMPANY, "analyzedAt": exa["analyzedAt"]}),
        x("GET", f"/api/company/{CRNO}/analysis", 200, exa),
        x("POST", "/api/analysis", 409, {"detail": "예시 회사는 새로 분석할 수 없습니다", "code": "example_readonly", "retryAt": None},
          request={"name": QUERY, "crno": CRNO, "refresh": True}),
    ])
    emp, _ = make_job(empty=True)
    fixture("F-EMPTY", "라운드 0, 특허 0, 중요 사건 0, 기사 0(funding_history·patents·news 는 unavailable no_data, result 는 빈 목록).", [
        x("GET", jp, 200, emp),
        x("GET", f"{jp}/news", 200, news_page(emp, []), query={"offset": 0, "limit": 20}),
    ])
    mon, _ = make_job(money=True)
    fixture("F-MONEY", "누적 투자 {USD 2.5e8, KRW 3.0e10}(rounds_sum), 영업이익이 음수인 연도 1개.", [x("GET", jp, 200, mon)])
    for k in ("0", "1", "2", "7"):
        desc = {"0": "법인 후보 0곳", "1": "이름 같은 1곳", "2": "이름 같은 2곳(대표·시군구도 같음, 1곳은 이전 이름 있음)", "7": "7곳(이름 같은 1곳, 3번째 후보에 snapshotAt)"}[k]
        res = corp_search(ctx, k)
        fixture(f"F-CORP-{k}", desc, [x("GET", "/api/corp/search", 200, res, query={"name": res["query"]})])
    fixture("F-DOWN", "/api/health 실패(화면 프록시가 분석 서버에 닿지 못함).", [
        x("GET", "/api/health", 502, {"detail": "분석 서버에 연결하지 못했습니다", "code": "upstream_error", "retryAt": None})])
    intr, _ = make_job(interrupted_after=3)
    fixture("F-INTERRUPTED", "작업 status interrupted. identity 와 official·profile·funding_history(화면 단락 기준 3개)는 done, 나머지 기본 단락은 interrupted.", [x("GET", jp, 200, intr)])
    fixture("F-NOTICE", "공고문 대조 응답: 충족 4, 미충족 1, 확인 필요 2, 판단 대상 아님 2, 질문 5, 준비 자료 3.", [
        x("POST", "/api/notice/analyze", 200, notice_analysis(), request={"programId": "PBLN_000000000000001", "company": notice_company()}),
        x("POST", "/api/notice/analyze", 429, {"detail": "오늘 호출 상한에 닿았습니다. 내일 0시 이후에 다시 할 수 있습니다.", "code": "daily_limit",
                                               "retryAt": iso(L.next_reset(T0))}, request={"programId": "PBLN_000000000000002", "company": notice_company()}, label="상한 도달"),
    ])
    fixture("F-BRIEF", "운용사 요약 응답: 사실 4, 맞닿는 점 2, 물어볼 것 2, 검색 결과 6(지금 코드 상한: 맞닿는 점·물어볼 것 각 2).", [
        x("POST", "/api/gp/brief", 200, gp_brief(), request={"gp": "가나다벤처스", "company": notice_company()})])
    riv, _ = make_job(rivals=True)
    fixture("F-RIVALS", "rivals_deep done: 경쟁사 2곳(하하테크는 재무 미확보), rivalInvestors 에 '타파하인베스트'(화면 테스트의 가짜 운용사 이름과 맞춘다). "
            "원문 링크 기록: 마바사 patents.items 6건·summary.inputArticles 4건, 하하테크는 둘 다 빈 목록.", [
        x("POST", f"{jp}/sections/rivals_deep", 202, {"jobId": JOB_ID, "key": "rivals_deep", "started": True},
          request={"rivals": [{"key": "rival:마바사", "name": "마바사", "nameEn": "Mabasa"}, {"key": "rival:하하테크", "name": "하하테크"}]}),
        x("GET", jp, 200, riv),
    ])
    sal, _ = make_job(sales="done")
    fixture("F-SALES", "sales done: 입찰공고 12건(진행 중 7, 예정 2, 마감 3, 관련성 high 4), errorCount 0.", [
        x("POST", f"{jp}/sections/sales", 202, {"jobId": JOB_ID, "key": "sales", "started": True}, request={"keywords": full["merged"]["bidKeywords"]}),
        x("GET", jp, 200, sal)])
    salp, _ = make_job(sales="partial")
    fixture("F-SALES-PARTIAL", "F-SALES 와 같고 sales 는 partial, errorCount 2.", [x("GET", jp, 200, salp)])
    htm, html_articles = make_job(html=True)
    fixture("F-HTML", "기사 제목 하나가 '<b>굵게</b>', 특허 요약 하나가 '<img src=x onerror=alert(1)>'(글자 그대로 보여야 함).", [
        x("GET", jp, 200, htm), x("GET", f"{jp}/news", 200, news_page(htm, html_articles), query={"offset": 0, "limit": 20})])
    files["F-FULL.articles"] = {"fixture": "F-FULL", "description": "F-FULL 의 기사 693건 전체(기사 나눠 받기 시험용). 스냅샷 파일에만 있는 목록이다.",
                                "baseDate": "2026-11-22", "jobId": JOB_ID, "articles": articles}
    return files


ADAPTERS = {
    "job": TypeAdapter(C.AnalysisJob), "news": TypeAdapter(C.NewsPage), "corp": TypeAdapter(C.CorpSearchResponse),
    "example": TypeAdapter(C.ExampleResponse), "health": TypeAdapter(C.HealthResponse), "notice": TypeAdapter(C.NoticeAnalysis),
    "gp": TypeAdapter(C.GpBrief), "start": TypeAdapter(C.StartAnalysisResponse), "run": TypeAdapter(C.RunSectionResponse),
    "companyJob": TypeAdapter(C.CompanyJobResponse), "error": TypeAdapter(C.ApiError), "article": TypeAdapter(list[C.Article]),
}


def response_kind(method: str, path: str, status: int) -> str:
    """가짜 응답 한 건이 어느 타입이어야 하는지(tests/test_growth_contract.py 도 같은 규칙을 쓴다)."""
    if status >= 400:
        return "error"
    if method == "GET" and path.endswith("/news"):
        return "news"
    if method == "GET" and (path.startswith("/api/analysis/") or path.endswith("/analysis")):
        return "job"
    if method == "GET" and path.endswith("/job"):
        return "companyJob"
    return {("GET", "/api/corp/search"): "corp", ("GET", "/api/example"): "example", ("GET", "/api/health"): "health",
            ("POST", "/api/notice/analyze"): "notice", ("POST", "/api/gp/brief"): "gp", ("POST", "/api/analysis"): "start"}.get(
        (method, path), "run" if "/sections/" in path else "?")


def validate(files: dict[str, dict]) -> None:
    for name, f in files.items():
        if "articles" in f:
            ADAPTERS["article"].validate_python(f["articles"], strict=True)
            continue
        for ex in f["exchanges"]:
            kind = response_kind(ex["method"], ex["path"], ex["status"])
            ADAPTERS[kind].validate_python(ex["response"], strict=True)


READABLE = {"F-FULL", "F-BRIEF", "F-NOTICE", "F-DOWN", "F-CORP-0", "F-CORP-1", "F-CORP-2", "F-CORP-7"}


def main() -> None:
    files = build()
    validate(files)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        # 사람이 읽을 파일(F-FULL 과 작은 파일)만 들여 쓰고, 큰 변형 파일은 한 줄로 줄여 저장소 무게를 줄인다
        compact = name not in READABLE
        text = json.dumps(data, ensure_ascii=False, indent=None if compact else 1, separators=(",", ":") if compact else None)
        (OUT / f"{name}.json").write_text(text + "\n", encoding="utf-8")
    print(f"{len(files)}개 파일 → {OUT}")


if __name__ == "__main__":
    main()
