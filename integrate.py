"""Search API ↔ Search Agent 사실 통합, 충돌 탐지, Premium Data(knowledge) 정규화/비교."""
from __future__ import annotations

import re
from typing import Any

import fetcher
import sources as src


# ---------- Agent 답변 → 사실 ----------
_CITE = re.compile(r"\(\((\d+)\)\)")


def _cites(text: str, refs: list[dict]) -> list[dict]:
    out = []
    for n in dict.fromkeys(int(x) for x in _CITE.findall(text)):
        if 1 <= n <= len(refs) and isinstance(refs[n - 1], dict) and refs[n - 1].get("url"):
            out.append(refs[n - 1])
    return out


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", _CITE.sub("", s).replace("**", "")).strip(" |-•*")


def agent_facts(answer: str, refs: list[dict]) -> list[dict]:
    """Agent 답변의 표 행·목록 항목을 (항목, 값, 인용 URL, 근거 구절) 사실로 분해한다.

    인용 ((n)) 은 references[n-1] 로 해석(1차 테스트 응답으로 대응 확인). 인용이 없는 문장은 근거 없음(inferred).
    근거 구절: 인용 출처의 description 에 값이 실제로 나타나면 그 구절, 아니면 없음.
    """
    facts: list[dict] = []
    section = ""
    for line in (answer or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            section = s.lstrip("# ").strip()
            continue
        item = value = None
        if s.startswith("|") and s.count("|") >= 3:
            cells = [c.strip() for c in s.strip("|").split("|")]
            if set("".join(cells)) <= set("-: ") or cells[0] in ("항목", "기준"):
                continue
            item, value = _clean(cells[0]), _clean(" / ".join(cells[1:]))
        elif re.match(r"^(?:[-•*]|\d+[.)])\s+", s):
            body = re.sub(r"^(?:[-•*]|\d+[.)])\s+", "", s)
            m = re.match(r"\*\*([^*]+)\*\*\s*[:：]?\s*(.*)", body)
            item, value = (_clean(m[1]), _clean(m[2])) if m else (section, _clean(body))
        elif _CITE.search(s):
            item, value = section, _clean(s)
        if not value or re.search(r"확인 불가|확인되지|확정하기 어렵|자료 간 불일치", value) and not re.search(r"\d", value):
            continue
        cites = _cites(line, refs)
        ev, ev_url = "", ""
        for r in cites:
            desc = f"{r.get('title') or ''} {r.get('description') or ''}"
            hit, snip = fetcher.verify_value(value, desc)
            if hit and re.search(r"\d", value):
                ev, ev_url = snip, r["url"]
                break
        facts.append({"section": section, "item": item or section, "value": value,
                      "urls": [r["url"] for r in cites], "evidence": ev, "evidence_url": ev_url,
                      "origin": "agent", "cited": bool(cites)})
    return facts


# ---------- 사실 대조 ----------
SECTION_CATEGORY = [("기본", "profile"), ("개요", "profile"), ("매출", "finance"), ("재무", "finance"), ("직원", "finance"),
                    ("투자유치", "finance"), ("경쟁", "competitors"), ("투자사", "vc"), ("뉴스", "news"), ("정부", "support"),
                    ("지원", "support")]


def guess_category(section: str, item: str) -> str:
    t = f"{section} {item}"
    for k, c in SECTION_CATEGORY:
        if k in t:
            return c
    return "profile"


def _fact_tokens(value: str | None) -> set[str]:
    return {t for t in fetcher.value_variants(value or "") if len(t) >= 3 or re.search(r"\d", t)}


def _item_key(item: str) -> str:
    return re.sub(r"[^0-9a-z가-힣]", "", (item or "").lower())


def reconcile(search_facts: list[dict], a_facts: list[dict]) -> dict:
    """Search 사실과 Agent 사실을 대조해 고유/공통/Agent 단독/충돌 수를 계산한다.

    같은 사실 = 값 토큰(숫자·날짜·이름)이 겹침. 충돌 = 같은 항목명에서 서로 다른 값 토큰 집합이 둘 이상(다른 출처).
    """
    s_tok = [(f, _fact_tokens(f.get("value"))) for f in search_facts if f.get("value")]
    a_items = []
    for f in a_facts:
        f = dict(f)
        f["category"] = f.get("category") or guess_category(f.get("section", ""), f.get("item", ""))
        a_items.append((f, _fact_tokens(f["value"])))

    common, agent_only = [], []
    matched_search: set[int] = set()
    for f, toks in a_items:
        hit = None
        for i, (sf, st) in enumerate(s_tok):
            if toks and st and len(toks & st) >= max(1, min(len(toks), len(st)) // 2 if len(toks) > 2 else 1):
                hit = i
                break
        if hit is not None:
            matched_search.add(hit)
            f["matched_search_item"] = s_tok[hit][0].get("item")
            common.append(f)
        elif toks:
            agent_only.append(f)
    search_only = [s_tok[i][0] for i in range(len(s_tok)) if i not in matched_search]

    # 충돌: 항목명 동일/포함 + 값 토큰 상이 + 출처 상이
    pool = [{"item": f.get("item"), "value": f.get("value"), "url": f.get("source_url"), "origin": "search",
             "as_of": f.get("as_of"), "basis": f.get("basis"), "status": f.get("status")} for f in search_facts if f.get("value")]
    pool += [{"item": f["item"], "value": f["value"], "url": (f["urls"] or [""])[0], "origin": "agent", "as_of": None,
              "basis": None, "status": "reported"} for f, _ in a_items]
    conflicts = find_conflicts(pool)
    return {"search_unique": len(s_tok), "agent_unique": len(a_items), "common": len(common),
            "agent_only": len(agent_only), "search_only": len(search_only), "conflicts": conflicts,
            "common_facts": common, "agent_only_facts": agent_only}


def find_conflicts(pool: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for p in pool:
        k = _item_key(p.get("item") or "")
        k = re.sub(r"(20\d{2}년?|연결|별도|기준)", "", k)
        if k:
            groups.setdefault(k, []).append(p)
    out = []
    for k, items in groups.items():
        toks = [(it, _fact_tokens(it["value"]) & {t for t in _fact_tokens(it["value"]) if re.search(r"\d", t)}) for it in items]
        toks = [(it, t) for it, t in toks if t]
        if len(toks) < 2:
            continue
        distinct = []
        for it, t in toks:
            if not any(t & d for _, d in distinct):  # 겹치지 않는 값 집합
                distinct.append((it, t))
        urls = {it["url"] for it, _ in distinct}
        # 기준(연결/별도)·기준일이 서로 다르면 충돌이 아니라 '구분된 값'
        bases = {(it.get("basis") or "", it.get("as_of") or "") for it, _ in distinct}
        if len(distinct) >= 2 and len(urls) >= 2 and len(bases) == 1:
            out.append({"item": items[0]["item"], "values": [{"value": it["value"], "url": it["url"],
                                                              "origin": it["origin"], "as_of": it.get("as_of")}
                                                             for it, _ in distinct]})
    return out


def merge_agent_only(final_facts: list[dict], recon: dict) -> list[dict]:
    """Agent에서만 발견된 사실을 최종 사실 목록에 추가한다(원문 근거 없으면 reported/inferred 로만)."""
    rows = []
    for f in recon["agent_only_facts"]:
        status = "reported" if f["evidence"] else "inferred"
        rows.append({"category": f["category"], "item": f["item"], "value": f["value"], "unit": None, "currency": None,
                     "as_of": None, "basis": None, "source_title": None,
                     "source_url": f["evidence_url"] or (f["urls"][0] if f["urls"] else None),
                     "source_type": "other", "status": status if f["cited"] else "inferred",
                     "evidence": f["evidence"] or None, "missing_reason": None, "origin": "agent",
                     "also_in_agent_answer": True})
    return rows


# ---------- Premium Data ----------
def normalize_knowledge(items: list[dict] | None, identity: dict) -> list[dict]:
    """knowledge(공식 스키마: title, description, sources, dataAsOf, columns, rows)를 별도 구조로 정규화한다."""
    out = []
    names = [n.lower() for n in identity.get("names", []) if n]
    for k in items or []:
        if not isinstance(k, dict):
            continue
        rows = k.get("rows") if isinstance(k.get("rows"), list) else []
        text = f"{k.get('title') or ''} {k.get('description') or ''}".lower()
        out.append({"title": k.get("title") or "", "description": k.get("description") or "",
                    "sources": k.get("sources") or [], "data_as_of": k.get("dataAsOf"),
                    "columns": k.get("columns") or [], "row_count": len(rows), "rows": rows[:30],
                    "company_related": any(n in text for n in names),
                    "financial": bool(re.search(r"revenue|income|earnings|profit|매출|이익|funding|투자|employee|직원", text))})
    return out


def compare_premium(normal: dict | None, premium: dict | None, identity: dict, normal_call: dict | None,
                    premium_call: dict | None, normal_reused: bool) -> dict:
    """일반 검색 vs Premium 검색 비교(검색어·결과 수 동일 전제). 유용한 정보를 추가하지 못해도 그대로 기록한다."""
    nr = (normal or {}).get("results") or []
    pr = (premium or {}).get("results") or []
    nk = {src.normalize_url(r.get("url", "")) for r in nr if r.get("url")}
    pk = {src.normalize_url(r.get("url", "")) for r in pr if r.get("url")}
    kn = normalize_knowledge((premium or {}).get("knowledge"), identity)
    kcount = len(kn)
    new_sources = pk - nk
    org_domestic = sorted({s for k in kn for s in k["sources"]})
    useful = [k for k in kn if k["company_related"]]
    fin_inc = any(k["financial"] and k["company_related"] for k in kn)
    verdict = ("추가 정보 있음" if useful else
               "구조화 데이터(knowledge)는 있으나 대상 기업과 무관" if kcount else
               "knowledge 미반환 — Premium Data가 이 질의에서 추가 정보를 제공하지 못함")
    return {
        "normal_result_count": len(nr), "premium_result_count": len(pr),
        "knowledge_tables": kcount, "company_related_tables": len(useful),
        "financial_or_investment_data_added": fin_inc, "new_source_count": len(new_sources),
        "overlap_urls": len(nk & pk), "overlap_ratio": round(len(nk & pk) / len(pk), 3) if pk else None,
        "knowledge_providers": org_domestic,
        "domestic_data": any("kr" in (s or "").lower() or "한국" in (s or "") for s in org_domestic),
        "global_data": bool(org_domestic),
        "normal_elapsed_sec": (normal_call or {}).get("elapsed_sec"),
        "premium_elapsed_sec": (premium_call or {}).get("elapsed_sec"),
        "normal_cost_usd": 0.0 if normal_reused else (normal_call or {}).get("est_cost_usd"),
        "premium_cost_usd": (premium_call or {}).get("est_cost_usd"),
        "normal_reused": normal_reused, "verdict": verdict, "knowledge": kn,
        "accuracy_note": "knowledge 표는 제3자 데이터 제공처(sources) 기준이며 공식 문서상 주식·FX·경제지표·웹트래픽 등 중심이므로 "
                         "비상장 스타트업 기업정보는 제공되지 않을 수 있음. 정확성은 제공처 표기 외 독립 검증하지 않음.",
    }
