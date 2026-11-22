"""투자유치 이력·투자기관 수집(② 대상기업, ③ 경쟁사 공통 모듈).

1) Liner Premium(include_knowledge=true)의 People Data Labs 회사 카드(funding_rounds·total_raised·funding_stage)를 우선 쓴다.
   요청 형식과 funding_rounds 파싱 규칙은 261117_Liner/02_liner_premium_probe(extract.py)에서 실제 호출로 확인한 것을 옮겼다.
2) Premium 라운드가 부족한 기업만 Liner 웹 검색 1회로 보완하고, 검색 스니펫에서 투자 사실을 모델 1회로 뽑는다
   (대상기업 1회, 경쟁사 전체 묶음 1회). 근거 문장이 스니펫에 실제로 있는 것만 남기고, 투자사·금액·라운드는
   스니펫에 적힌 값만 쓴다(없는 값을 만들지 않는다).
3) 이미 수집한 뉴스 중 '투자유치'로 분류된 기사를 관련 기사로 붙인다(추가 호출 없음).

이번 프로토타입은 투자 이력을 풍부하게 보여주는 것이 목적이라 이름이 비슷한 관련 법인(합병 전후 법인 등)의 카드도
제외하지 않고 '투자대상 법인' 이름을 함께 보존한다. 같은 라운드가 명백히 중복될 때만 합치고, 출처 간 금액 차이는
'다른 출처 금액'으로 남긴다. 실패해도 예외를 올리지 않고 errors 에 기록한다.
"""
from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from urllib.parse import urlparse

from funding import notice
from research import common
from research.liner import DATA_RULE, Liner

PREMIUM_RESULTS = 10
WEB_RESULTS = 10
ENOUGH_ROUNDS = 3   # Premium 라운드가 이 수 이상이면 웹 보완 검색을 하지 않는다
PARALLEL = 3        # 기업별 Premium 조회 동시 작업 수


# ---------------- Premium(PDL 회사 카드) ----------------
def _cols(k: dict) -> list[str]:
    return [str(c) for c in (k.get("columns") or [])]


def is_company_card(k: dict) -> bool:
    cols = {c.lower() for c in _cols(k)}
    return "funding_rounds" in cols and "employer" not in cols


def is_vc_table(k: dict) -> bool:
    text = (str(k.get("title") or "") + " " + " ".join(_cols(k))).lower()
    return not is_company_card(k) and bool(re.search(r"funding|venture|financing|round|raised|investor", text))


def card_rows(k: dict) -> list[dict]:
    cols = _cols(k)
    return [{c: (row[i] if i < len(row) else "") for i, c in enumerate(cols)} for row in (k.get("rows") or []) if isinstance(row, list)]


_ROUND_SPLIT = re.compile(r";\s*(?=[^;()]{1,60}?,\s*\d{4}-\d{2}-\d{2})")
_ROUND_RE = re.compile(r"^\s*(?P<label>[^,]+?),\s*(?P<date>\d{4}-\d{2}-\d{2})(?::\s*(?P<amount>[$€£₩]?[\d.,]+\s*[KMB]?))?"
                       r"\s*(?:\((?P<investors>.*)\))?\s*$", re.S)
_CUR = {"$": "USD", "€": "EUR", "£": "GBP", "₩": "KRW"}


def money_value(s: str | None) -> float | None:
    if not s:
        return None
    m = re.fullmatch(r"[$€£₩]?\s*([\d.,]+)\s*([KMB]?)", s.strip(), re.I)
    if not m:
        return None
    try:
        v = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    return v * {"": 1, "K": 1e3, "M": 1e6, "B": 1e9}[m.group(2).upper()]


def split_investors(s: str | None) -> list[str]:
    """쉼표로 투자자 분리. 'Shinhan Capital Co., Ltd.'처럼 법인 접미사가 쉼표로 이어지는 경우를 보정한다."""
    if not s:
        return []
    out: list[str] = []
    for p in (x.strip() for x in s.split(",")):
        if out and re.fullmatch(r"(?i)(ltd\.?|llc|inc\.?|co\.?,?|limited|corp\.?|lp|l\.p\.)", p):
            out[-1] = out[-1] + ", " + p
        elif p:
            out.append(re.sub(r"\s{2,}", " ", p))
    return out


def parse_funding_rounds(text: str) -> list[dict]:
    """PDL funding_rounds 문자열 → 라운드 목록. 형식이 다른 조각도 원문(raw)을 보존해 버리지 않는다."""
    out = []
    for ch in _ROUND_SPLIT.split(text or ""):
        ch = ch.strip()
        if not ch:
            continue
        m = _ROUND_RE.match(ch)
        if not m:
            out.append({"raw": ch, "round": "", "date": "", "amount": "", "amount_value": None, "currency": "", "investors": []})
            continue
        amt = (m.group("amount") or "").strip()
        out.append({"raw": ch, "round": m.group("label").strip(), "date": m.group("date"), "amount": amt,
                    "amount_value": money_value(amt), "currency": (_CUR.get(amt[:1], "USD") if amt else ""),
                    "investors": split_investors(m.group("investors"))})
    return out


def _tokens(names: list[str]) -> list[str]:
    return [t for t in dict.fromkeys(common.norm_name(n) for n in names if n) if len(t) >= 2]


def _domain(url: str) -> str:
    u = (url or "").strip().lower()
    if not u:
        return ""
    if "://" not in u:
        u = "http://" + u
    try:
        h = urlparse(u).hostname or ""
    except ValueError:
        return ""
    return re.sub(r"^www\.", "", h)


def row_match(row: dict, tokens: list[str], domain: str = "") -> str:
    """회사 카드 한 행이 대상과 관련 있는지: 'exact'(이름·도메인 일치) / 'related'(이름 유사) / ''(무관).

    관련 법인을 폭넓게 포함하되(사용자 지시), 짧은 이름이 다른 회사 이름의 앞부분에 우연히 걸리는 경우를 줄이려고
    접두 일치는 5자 이상 이름에만 쓴다.
    """
    nm = common.norm_name(str(row.get("name") or ""))
    site = _domain(str(row.get("website") or ""))
    aka = [common.norm_name(a) for a in re.split(r"[;,]", str(row.get("also_known_as") or "")) if a.strip()]
    if not nm:
        return ""
    if (domain and site and (site == domain or site.endswith("." + domain))) or nm in tokens or any(a in tokens for a in aka):
        return "exact"
    for t in tokens:
        if len(t) >= 5 and (nm.startswith(t) or t.startswith(nm) and len(nm) >= 5):
            return "related"
        if len(t) >= 5 and any(a.startswith(t) for a in aka):
            return "related"
    return ""


def from_premium(data: dict, names: list[str], domain: str, query: str) -> tuple[list[dict], list[dict]]:
    """Premium 응답 → (회사 카드 요약, 라운드). 같은 카드가 여러 질의에서 나와도 호출부에서 중복 정리한다."""
    kn = data.get("knowledge") if isinstance(data, dict) else None
    items = kn if isinstance(kn, list) else ([kn] if isinstance(kn, dict) else [])
    tokens = _tokens(names)
    cards, rounds = [], []
    for k in items:
        if not isinstance(k, dict):
            continue
        src = ", ".join(str(s) for s in (k.get("sources") or [])) or "Liner Premium"
        if is_company_card(k):
            for row in card_rows(k):
                how = row_match(row, tokens, domain)
                if not how:
                    continue
                # 유사 이름 카드는 투자 정보(라운드·누적액)가 있을 때만 쓴다(예: 'Google Cloud Skills Boost' 같은 무관한 페이지 카드)
                if how == "related" and not (str(row.get("funding_rounds") or "").strip() or money_value(str(row.get("total_raised") or ""))):
                    continue
                ent = str(row.get("name") or "")
                cards.append({"name": ent, "match": how, "website": row.get("website") or "", "location": row.get("location") or "",
                              "funding_stage": row.get("funding_stage") or "", "total_raised": row.get("total_raised") or "",
                              "funding_round_count": row.get("funding_round_count") or "", "established": row.get("established") or "",
                              "parent": row.get("parent") or "", "subsidiaries": row.get("subsidiaries") or "",
                              "also_known_as": row.get("also_known_as") or "", "data_source": src, "query": query})
                for r in parse_funding_rounds(str(row.get("funding_rounds") or "")):
                    rounds.append({**r, "entity": ent, "entity_match": how, "lead": [], "summary": "",
                                   "source_type": "premium_structured", "sources": [{"type": "Premium", "label": src, "url": ""}]})
        elif is_vc_table(k):
            # 회사 카드가 아닌 투자 거래 표: 제목에 대상 이름이 있을 때만, 열 이름을 그대로 살려 원문 행으로 보존한다
            title = str(k.get("title") or "")
            if not any(t in common.norm_name(title) for t in tokens):
                continue
            for row in card_rows(k):
                low = {c.lower(): v for c, v in row.items()}
                pick = lambda *keys: next((str(low[c]) for c in low for kk in keys if kk in c and low[c] not in (None, "")), "")  # noqa: E731
                amt = pick("amount", "raised", "size")
                rounds.append({"raw": "; ".join(f"{c}: {v}" for c, v in row.items() if v not in (None, ""))[:300],
                               "round": pick("round", "series", "stage", "type"), "date": pick("date", "announced", "year")[:10],
                               "amount": amt, "amount_value": money_value(amt), "currency": _CUR.get(amt[:1], "") if amt else "",
                               "investors": split_investors(pick("investor")), "entity": title[:60], "entity_match": "related",
                               "lead": split_investors(pick("lead")), "summary": "", "source_type": "premium_structured",
                               "sources": [{"type": "Premium", "label": src, "url": ""}]})
    return cards, rounds


def premium_rounds(liner: Liner, co: dict, calls: list[dict]) -> tuple[list[dict], list[dict]]:
    """기업 한 곳: Premium 1회('<영문명> company'), 카드가 없으면 도메인 또는 한글명으로 1회 더(최대 2회)."""
    names = co["names"]
    en = co.get("name_en") or ""
    queries = [(f"{en or co['name']} company", "en", "us")]
    if co.get("domain"):
        queries.append((co["domain"], "en", "us"))
    elif en and co["name"] != en:
        queries.append((f"{co['name']} {en} company", "ko", "kr"))
    cards, rounds = [], []
    for q, lang, cc in queries[:2]:
        t0 = time.perf_counter()
        hits0 = liner.cache_hits
        data = liner.premium(q, lang=lang, country=cc, max_results=PREMIUM_RESULTS)
        calls.append({"api": "Liner Premium", "query": q, "sec": round(time.perf_counter() - t0, 2),
                      "cache": liner.cache_hits > hits0, "ok": bool(data),
                      "knowledge_tables": len(data.get("knowledge") or []) if isinstance(data.get("knowledge"), list) else int(bool(data.get("knowledge")))})
        c, r = from_premium(data, names, co.get("domain") or "", q)
        cards += c
        rounds += r
        if c:  # 카드를 찾았으면 다음 질의는 하지 않는다(비용 관리)
            break
    return cards, rounds


# ---------------- 웹 검색 보완 ----------------
WEB_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["rounds"],
    "properties": {"rounds": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["company", "entity", "date", "round", "amount", "investors", "lead_investors", "summary", "source", "quote"],
        "properties": {
            "company": {"type": "string", "description": "주어진 기업 목록 중 투자를 받은 기업 이름(목록 표기 그대로)"},
            "entity": {"type": "string", "description": "자료에 적힌 투자대상 법인·브랜드명(합병 전 법인 등 다를 수 있음)"},
            "date": {"type": "string", "description": "투자 시점(자료 표기). YYYY-MM-DD, YYYY-MM, YYYY 중 확인 가능한 만큼. 없으면 빈 문자열"},
            "round": {"type": "string", "description": "라운드명(자료 표기). 없으면 빈 문자열"},
            "amount": {"type": "string", "description": "금액·단위·통화를 자료 표기 그대로. 없으면 빈 문자열"},
            "investors": {"type": "array", "items": {"type": "string"}, "description": "참여 투자기관(자료에 적힌 것만)"},
            "lead_investors": {"type": "array", "items": {"type": "string"}, "description": "리드·주요 투자자로 명시된 곳만"},
            "summary": {"type": "string", "description": "투자 관련 발표·주요 내용 한 문장(누적 투자액·기업가치 언급 포함)"},
            "source": {"type": "integer", "description": "근거 자료 번호"},
            "quote": {"type": "string", "description": "자료에서 글자 그대로 옮긴 근거. 150자 이내"}}}}},
}
WEB_SYSTEM = (f"당신은 기업 투자유치 이력을 정리하는 분석가입니다. {DATA_RULE}\n"
              "주어진 기업이 투자를 '받은' 사실(라운드, 시점, 금액, 투자기관)을 가능한 한 빠짐없이 뽑습니다. "
              "금액이 공개되지 않았어도 투자기관이나 시점이 있으면 넣습니다. 그 기업이 다른 곳에 투자한 일, 대출·보증·정부 보조금은 넣지 않습니다. "
              "투자사·금액·라운드를 추측하지 않습니다. 같은 라운드는 한 번만 적습니다. 기업당 최대 15건.")


def web_results(liner: Liner, co: dict, calls: list[dict]) -> list[dict]:
    if co.get("is_korean", True) or re.search(r"[가-힣]", co["name"]):
        q, lang, cc = f"{co['name']} 투자유치 시리즈 투자사", "ko", "kr"
    else:
        q, lang, cc = f"{co.get('name_en') or co['name']} funding round raised investors", "en", ""
    t0 = time.perf_counter()
    hits0 = liner.cache_hits
    res = liner.search(q, lang=lang, country=cc, max_results=WEB_RESULTS, label="funding_search")
    calls.append({"api": "Liner Web Search", "query": q, "sec": round(time.perf_counter() - t0, 2),
                  "cache": liner.cache_hits > hits0, "ok": bool(res), "results": len(res)})
    return [{**r, "_company": co["name"]} for r in res]


def _in(v: str, text: str) -> bool:
    s = notice.squash(v)
    return bool(s) and s in text


def _year_from(s: str) -> str:
    m = re.search(r"(?:19|20)\d{2}(?:[-./]\d{1,2}(?:[-./]\d{1,2})?)?", s or "")
    return m.group(0).replace(".", "-").replace("/", "-") if m else ""


def clean_web(raw: dict | None, cos: list[dict], results: list[dict]) -> list[dict]:
    """모델 답 정리: 근거 문장이 해당 자료에 있고, 그 자료에 기업 이름이 나오는 것만 남긴다.

    투자사·라운드·금액은 그 자료에 적힌 것만 남기고 나머지는 비운다. 시점이 자료에 없으면 기사 날짜를 '보도일'로 둔다.
    """
    by = {}
    for co in cos:
        for n in co["names"]:
            by[notice.squash(n).lower()] = co
    out = []
    for r in (raw or {}).get("rounds") or []:
        if not isinstance(r, dict) or not isinstance(r.get("source"), int) or not 0 <= r["source"] < len(results):
            continue
        co = by.get(notice.squash(str(r.get("company") or "")).lower())
        if not co:
            continue
        src = results[r["source"]]
        raw_text = f"{src.get('title') or ''} {src.get('description') or ''}"
        text = notice.squash(raw_text)
        low = text.lower()
        quote = str(r.get("quote") or "").strip()
        if len(notice.squash(quote)) < 6 or notice.squash(quote) not in text:
            continue
        if not any(notice.squash(n).lower() in low for n in co["names"] if len(notice.squash(n)) >= 2):
            continue
        keep = lambda v, n=40: v if v and len(v) <= n and _in(v, raw_text) else ""  # noqa: E731
        investors = [str(i).strip() for i in r.get("investors") or [] if isinstance(i, str) and _in(str(i), raw_text)]
        lead = [str(i).strip() for i in r.get("lead_investors") or [] if isinstance(i, str) and _in(str(i), raw_text)]
        d = str(r.get("date") or "").strip()
        dt = d if d and (_in(d, raw_text) or _in(_year_from(d)[:4], raw_text)) else ""
        dt = _year_from(dt) or dt
        reported = str(src.get("date") or "")[:10]
        amount = keep(str(r.get("amount") or "").strip())
        out.append({"raw": quote[:200], "round": keep(str(r.get("round") or "").strip(), 30), "date": dt[:10],
                    "reported_date": reported, "amount": amount, "amount_value": None,
                    "currency": "KRW" if "원" in amount else ("USD" if re.search(r"\$|달러|USD", amount) else ""),
                    "investors": list(dict.fromkeys(investors + [x for x in lead if x not in investors]))[:20], "lead": list(dict.fromkeys(lead)),
                    "entity": str(r.get("entity") or "").strip()[:60] or co["name"], "entity_match": "web",
                    "summary": str(r.get("summary") or "").strip()[:200], "source_type": "web_reported", "company": co["name"],
                    "sources": [{"type": "Web", "label": src.get("title") or "", "url": str(src.get("url") or "")}]})
    return out


def web_rounds(liner: Liner, need: list[dict], calls_by: dict[str, list[dict]], calls: list[dict]) -> dict[str, list[dict]]:
    """웹 보완이 필요한 기업들: 기업당 검색 1회 + 모델 1회(묶음). 검색 기록은 calls_by[기업], 모델 기록은 calls."""
    results: list[dict] = []
    seen: set[str] = set()
    for co in need:
        calls_by.setdefault(co["name"], [])
    with ThreadPoolExecutor(max_workers=max(1, min(PARALLEL, len(need))), thread_name_prefix="fhw") as ex:
        per = list(ex.map(lambda co: web_results(liner, co, calls_by[co["name"]]), need))  # 입력 순서 유지
    for rs in per:
        for r in rs:
            u = str(r.get("url") or "")
            if u and u not in seen:
                seen.add(u)
                results.append(r)
    out: dict[str, list[dict]] = {co["name"]: [] for co in need}
    if not results:
        return out
    lines = "\n".join(f"[{i}] ({r.get('date') or '날짜 없음'}) {r.get('title') or ''}\n{str(r.get('description') or '')[:400]}" for i, r in enumerate(results))
    who = "\n".join(f"- {co['name']}" + (f" (영문 {co['name_en']})" if co.get("name_en") else "") for co in need)
    t0 = time.perf_counter()
    hits0 = liner.cache_hits
    raw = liner.json(WEB_SYSTEM, f"기업 목록:\n{who}\n\n<자료>\n{lines}\n</자료>", WEB_SCHEMA, name="funding_history", max_tokens=6000)
    calls.append({"api": "Liner Model", "query": f"funding_history({len(need)}개 기업, 자료 {len(results)}건)",
                  "sec": round(time.perf_counter() - t0, 2), "cache": liner.cache_hits > hits0, "ok": raw is not None})
    for r in clean_web(raw, need, results):
        out.setdefault(r["company"], []).append(r)
    return out


# ---------------- 병합·요약 ----------------
def norm_round(label: str) -> str:
    s = (label or "").lower().replace(" ", "")
    for a, b in (("시리즈", "series"), ("프리", "pre"), ("시드", "seed"), ("브릿지", "bridge"), ("브리지", "bridge"),
                 ("pre-", "pre"), ("-", ""), ("round", ""), ("라운드", ""), ("투자", "")):
        s = s.replace(a, b)
    return s


def _days(a: str, b: str) -> int | None:
    def p(s: str):
        """YYYY-MM-DD / YYYY-MM(15일로) / YYYY(7월 1일로). 해석할 수 없으면 None."""
        s = (s or "")[:10]
        m = re.fullmatch(r"(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", s)
        if not m:
            return None
        try:
            return date(int(m.group(1)), int(m.group(2) or 7), int(m.group(3) or (15 if m.group(2) else 1)))
        except ValueError:
            return None
    x, y = p(a), p(b)
    return abs((x - y).days) if x and y else None


def _same(a: dict, b: dict) -> bool:
    """명백한 중복만: 원문이 같거나, 라운드명이 같고 시점이 60일 이내(같은 연도로만 알면 같은 연도)."""
    if a["raw"] and a["raw"] == b["raw"] and a.get("entity") == b.get("entity"):
        return True
    ra, rb = norm_round(a["round"]), norm_round(b["round"])
    if not ra or ra != rb:
        return False
    da, db = a.get("date") or "", b.get("date") or ""
    if not da or not db:
        return False
    if len(da) == 4 or len(db) == 4:
        return da[:4] == db[:4]
    g = _days(da, db)
    return g is not None and g <= 60


def merge_rounds(rounds: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in sorted(rounds, key=lambda x: (x["source_type"] != "premium_structured", x.get("date") or "")):
        dup = next((o for o in out if _same(o, r)), None)
        if not dup:
            out.append({**r, "other_amounts": [], "investors": list(r["investors"]), "sources": list(r["sources"])})
            continue
        dup["investors"] = list(dict.fromkeys(dup["investors"] + r["investors"]))
        dup["lead"] = list(dict.fromkeys((dup.get("lead") or []) + (r.get("lead") or [])))
        if r["amount"] and not dup["amount"]:
            dup["amount"], dup["currency"], dup["amount_value"] = r["amount"], r["currency"], r.get("amount_value")
        elif r["amount"] and notice.squash(r["amount"]) != notice.squash(dup["amount"]) and r["amount"] not in dup["other_amounts"]:
            dup["other_amounts"].append(r["amount"])  # 출처 간 금액 차이는 지우지 않고 남긴다
        if len(r.get("date") or "") > len(dup.get("date") or ""):
            dup["date"] = r["date"]
        if r.get("summary") and not dup.get("summary"):
            dup["summary"] = r["summary"]
        for s in r["sources"]:
            if s not in dup["sources"]:
                dup["sources"].append(s)
        if r["source_type"] not in dup["source_type"]:
            dup["source_type"] += "+" + r["source_type"]
    out.sort(key=lambda x: (x.get("date") or x.get("reported_date") or ""), reverse=True)
    return out


_VC = re.compile(r"venture|ventures|capital|investment|invest|partners|equity|fund|management|asset|securities|holdings? ?pe|\bpe\b|"
                 r"인베스트|벤처스|벤처캐피탈|캐피탈|파트너스|창업투자|투자|자산운용|증권|프라이빗|에쿼티|펀드|액셀러레이터|accelerator|combinator", re.I)
_PUBLIC = re.compile(r"development bank|산업은행|기업은행|ibk|기술지주|tech holdings|tips|신용보증|기술보증|kotec|kodit|정책|모태|"
                     r"growth fund|국민성장|한국투자공사|중소벤처기업진흥|university|대학", re.I)


def investor_type(name: str) -> str:
    """이름 기반 1차 분류(규칙 기반 추정 — 원본 자료에 투자자 유형 정보가 없다)."""
    if _PUBLIC.search(name):
        return "정책금융·공공·대학(추정)"
    if _VC.search(name):
        return "VC·재무적 투자자(추정)"
    return "전략적·기타 투자자(추정)"


def investor_table(rounds: list[dict]) -> list[dict]:
    agg: dict[str, dict] = {}
    for r in rounds:
        for i, nm in enumerate(r["investors"]):
            k = common.norm_name(nm)
            if len(k) < 2:
                continue
            a = agg.setdefault(k, {"투자기관": nm, "유형(이름 기반 추정)": investor_type(nm), "참여 라운드 수": 0, "참여 라운드": [],
                                   "최근 참여": "", "리드·주요 투자자 표기": False})
            a["참여 라운드 수"] += 1
            lbl = " ".join(x for x in (r.get("round") or "", (r.get("date") or r.get("reported_date") or "")[:7]) if x) or "라운드 미상"
            if lbl not in a["참여 라운드"]:
                a["참여 라운드"].append(lbl)
            d = r.get("date") or r.get("reported_date") or ""
            a["최근 참여"] = max(a["최근 참여"], d)
            if nm in (r.get("lead") or []):
                a["리드·주요 투자자 표기"] = True
    rows = sorted(agg.values(), key=lambda a: a["최근 참여"], reverse=True)
    return sorted(rows, key=lambda a: -a["참여 라운드 수"])


def cumulative(cards: list[dict], rounds: list[dict]) -> dict:
    """누적 투자유치 금액. ① PDL 회사 카드 total_raised(이름·도메인 일치 카드) → ② 라운드 금액을 통화별로 합산.

    라운드 합산은 merge_rounds 로 이미 중복을 정리한 라운드만 쓰고, 통화가 다르면 환산하지 않고 따로 더한다.
    금액이 일부 라운드에만 있으면 '확인된 투자유치 금액 합계'로 표시한다. 금액이 하나도 없으면 미확보(None).
    """
    main = next((c for c in cards if c["match"] == "exact" and money_value(str(c.get("total_raised") or ""))), None)
    if main:
        v = money_value(str(main["total_raised"]))
        return {"basis": "pdl_total", "label": "누적 투자유치(PDL)", "by_currency": {"USD": v}, "rounds_with_amount": None,
                "rounds_total": len(rounds), "entity": main["name"], "note": f"PDL 회사 카드 total_raised({main['name']})"}
    sums: dict[str, float] = {}
    n_amt = 0
    for r in rounds:
        v, cur = r.get("amount_value"), r.get("currency") or ""
        if v is None and r.get("amount"):
            v, cur = parse_amount(r["amount"])
        if v is None or not cur:
            continue
        n_amt += 1
        sums[cur] = sums.get(cur, 0.0) + v
    if not sums:
        return {"basis": "none", "label": "미확보", "by_currency": {}, "rounds_with_amount": 0, "rounds_total": len(rounds), "entity": "", "note": ""}
    full = n_amt == len(rounds)
    return {"basis": "rounds_sum" if full else "rounds_partial_sum",
            "label": "라운드 금액 합계" if full else "확인된 투자유치 금액 합계",
            "by_currency": sums, "rounds_with_amount": n_amt, "rounds_total": len(rounds), "entity": "",
            "note": f"중복 정리한 라운드 {len(rounds)}건 중 금액 확인 {n_amt}건 합산(통화별, 환산 없음)"}


_KRW_UNITS = {"조": 1e12, "억": 1e8, "천만": 1e7, "백만": 1e6, "만": 1e4}


def parse_amount(s: str) -> tuple[float | None, str]:
    """웹 원문 금액 표기 → (값, 통화). '1100억원', '1조 2000억 원', '$1.5B', '3억 달러', '150 million USD'. 해석 못 하면 (None, '')."""
    t = (s or "").replace(",", "").strip()
    if not t or re.search(r"[~∼\-–]|이상|이하|약|여|규모의?\s*$", t) and not re.search(r"\d", t):
        return None, ""
    m = re.fullmatch(r"\$\s*([\d.]+)\s*([KMB]|million|billion)?\s*(USD)?", t, re.I)
    if m:
        mul = {"k": 1e3, "m": 1e6, "b": 1e9, "million": 1e6, "billion": 1e9}.get((m.group(2) or "").lower(), 1)
        return float(m.group(1)) * mul, "USD"
    m = re.fullmatch(r"([\d.]+)\s*(million|billion|M|B)\s*(USD|dollars?)", t, re.I)
    if m:
        return float(m.group(1)) * (1e9 if m.group(2).lower() in ("billion", "b") else 1e6), "USD"
    cur = "KRW" if re.search(r"원$", t) else ("USD" if re.search(r"달러$", t) else "")
    if not cur:
        return None, ""
    body = re.sub(r"\s*(원|달러)$", "", t)
    total, rest = 0.0, body
    for part in re.findall(r"([\d.]+)\s*(조|억|천만|백만|만)?", body):
        if not part[0]:
            continue
        total += float(part[0]) * (_KRW_UNITS.get(part[1], 1) if cur == "KRW" or part[1] else 1)
        rest = rest.replace(part[0] + part[1], "", 1)
    if re.sub(r"\s", "", rest) or total <= 0:
        return None, ""
    return total, cur


def summarize(cards: list[dict], rounds: list[dict], investors: list[dict]) -> dict:
    main = next((c for c in cards if c["match"] == "exact"), cards[0] if cards else None)
    total = (main or {}).get("total_raised") or ""
    tv = money_value(str(total)) if total else None
    dated = [r for r in rounds if r.get("date")]
    latest = max(dated, key=lambda r: r["date"]) if dated else (rounds[0] if rounds else None)
    return {"rounds": len(rounds), "investors": len(investors),
            "vc_like": sum(1 for i in investors if i["유형(이름 기반 추정)"].startswith("VC")),
            "total_raised": tv, "total_raised_currency": "USD" if tv else "", "total_raised_source": (main or {}).get("data_source", "") if tv else "",
            "total_raised_entity": (main or {}).get("name", "") if tv else "",
            "funding_stage": (main or {}).get("funding_stage", ""), "funding_round_count_pdl": (main or {}).get("funding_round_count", ""),
            "latest": ({"date": latest.get("date") or latest.get("reported_date") or "", "round": latest.get("round") or "",
                        "amount": latest.get("amount") or ""} if latest else None),
            "disclosed_amounts": [f"{r.get('round') or '라운드 미상'} {r['amount']}" for r in rounds if r.get("amount")],
            "cumulative": cumulative(cards, rounds)}


def funding_articles(news: dict | None, limit: int = 40) -> list[dict]:
    """이미 수집한 뉴스 중 '투자유치' 분류 기사(추가 호출 없음)."""
    arts = [a for a in (news or {}).get("articles") or [] if "투자유치" in (a.get("분류") or [])]
    return [{"날짜": a.get("date"), "제목": a.get("title"), "요약": str(a.get("description") or "")[:200], "매체": a.get("매체"),
             "링크": a.get("url")} for a in arts[:limit]]


# ---------------- 진입점 ----------------
def company_entry(name: str, name_en: str = "", *, aliases: list[str] | None = None, homepage: str = "", is_korean: bool = True,
                  registered: str = "") -> dict:
    names = [n for n in dict.fromkeys([name, name_en, registered, *(aliases or [])]) if n and len(n.strip()) >= 2]
    return {"name": name, "name_en": name_en, "names": names, "domain": _domain(homepage), "is_korean": is_korean}


def collect(liner: Liner, companies: list[dict], news_by_company: dict[str, dict] | None = None, progress=None) -> dict[str, dict]:
    """기업 목록(company_entry) → {기업명: 투자유치 결과}. 예외를 올리지 않는다.

    호출: 기업당 Premium 1~2회, Premium 라운드가 ENOUGH_ROUNDS 미만인 기업만 웹 검색 1회, 모델은 묶어서 1회.
    """
    say = progress or (lambda m: None)
    out: dict[str, dict] = {}
    need: list[dict] = []
    t_all = time.perf_counter()

    def premium_one(co: dict) -> None:
        """기업 한 곳의 Premium 조회. 결과는 그 기업의 item 에만 쓴다(스레드 간 데이터 혼합 없음)."""
        t0 = time.perf_counter()
        item = out[co["name"]]
        if not liner.ok:
            item["errors"].append("LINER_API_KEY 가 없어 투자유치 이력을 조회하지 않았습니다.")
            item["_premium_rounds"] = []
            return
        try:
            say(f"투자유치 이력: {co['name']} Premium(PDL) 조회 중...")
            cards, rounds = premium_rounds(liner, co, item["calls"])
            seen_cards = set()
            item["cards"] = [c for c in cards if not (c["name"], c["total_raised"]) in seen_cards and not seen_cards.add((c["name"], c["total_raised"]))]
            item["_premium_rounds"] = rounds
        except Exception as e:  # 투자유치 수집 실패가 전체 분석을 멈추지 않게 한다
            item["errors"].append(common.scrub_text(f"Premium 조회 오류: {type(e).__name__}: {str(e)[:150]}"))
            item["_premium_rounds"] = []
            item["_premium_failed"] = True
        item["sec"] = round(time.perf_counter() - t0, 2)

    for co in companies:
        out[co["name"]] = {"company": co["name"], "name_en": co.get("name_en") or "", "cards": [], "rounds": [], "investors": [], "summary": {},
                           "articles": funding_articles((news_by_company or {}).get(co["name"])), "calls": [], "errors": [], "web_used": False}
    # 기업별 Premium 조회는 서로 독립이라 병렬로 부른다(동시 수는 Liner 래퍼의 premium 제한이 다시 묶는다)
    with ThreadPoolExecutor(max_workers=max(1, min(PARALLEL, len(companies))), thread_name_prefix="fh") as ex:
        list(ex.map(premium_one, companies))
    for co in companies:  # 웹 보완 대상은 입력 순서대로 정한다(결과가 실행 순서에 따라 달라지지 않게)
        item = out[co["name"]]
        if liner.ok and (item.pop("_premium_failed", False) or len({r["raw"] for r in item["_premium_rounds"]}) < ENOUGH_ROUNDS):
            need.append(co)
    web: dict[str, list[dict]] = {}
    web_calls: list[dict] = []
    if need and liner.ok:
        say(f"투자유치 이력: 웹 검색 보완({', '.join(c['name'] for c in need)})...")
        try:
            web = web_rounds(liner, need, {co["name"]: out[co["name"]]["calls"] for co in need}, web_calls)
        except Exception as e:
            for co in need:
                out[co["name"]]["errors"].append(common.scrub_text(f"웹 보완 오류: {type(e).__name__}: {str(e)[:150]}"))
    for co in companies:
        item = out[co["name"]]
        prem = item.pop("_premium_rounds", [])
        w = web.get(co["name"]) or []
        item["web_used"] = co in need and liner.ok
        item["rounds"] = merge_rounds(prem + w)
        item["investors"] = investor_table(item["rounds"])
        item["summary"] = summarize(item["cards"], item["rounds"], item["investors"])
        item["counts"] = {"premium_rounds_raw": len(prem), "web_rounds_raw": len(w), "merged_rounds": len(item["rounds"])}
    model_calls = [c for c in web_calls if c["api"] == "Liner Model"]
    meta = {"companies": len(companies), "web_supplemented": [c["name"] for c in need], "model_calls": model_calls,
            "sec": round(time.perf_counter() - t_all, 2)}
    return {"by_company": out, "meta": meta}
