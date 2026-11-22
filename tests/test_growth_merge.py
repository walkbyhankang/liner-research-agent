"""합친 회사 값(merged, 계약 7절)과 retryable(5.5절) 규칙 테스트. 실제 API 를 부르지 않는다."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from growth import contract as C, jobs, merge

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "fixtures" / "analysis"


def job_responses():
    for p in sorted(FIX.glob("F-*.json")):
        for i, ex in enumerate(json.loads(p.read_text(encoding="utf-8")).get("exchanges", [])):
            r = ex["response"]
            if isinstance(r, dict) and "sections" in r:
                yield f"{p.stem}#{i}", r


JOBS = dict(job_responses())


@pytest.mark.parametrize("name", sorted(JOBS))
def test_merged_from_sections_equals_fixture(name):
    """가짜 응답의 단락 결과만으로 다시 계산한 merged 가 가짜 응답의 merged 와 같다(진행 중 단계·법인 없음·엇갈림·중단 포함)."""
    r = JOBS[name]
    got = merge.merged(r["sections"], query=r["query"], crno=r["company"]["crno"], job_running=r["status"] == "running")
    assert got == r["merged"]


@pytest.mark.parametrize("name", sorted(JOBS))
def test_retryable_equals_fixture(name):
    r = JOBS[name]
    for key, env in r["sections"].items():
        assert jobs.retryable(key, env, r["sections"], r["merged"], r["isExample"]) == env["retryable"], key


def base():
    return copy.deepcopy(JOBS["F-FULL#0"])


def remerge(r, running=False):
    return merge.merged(r["sections"], query=r["query"], crno=r["company"]["crno"], job_running=running)


def test_rivals_group_korean_and_english_names_and_drop_foreign():
    """profile 의 '퓨리오사AI(FuriosaAI)' 같은 후보와 facts 의 영문 표기를 한 줄로 묶는다. 해외 기업은 넣지 않는다."""
    r = base()
    r["sections"]["profile"]["result"]["competitors"] = [
        {"name": "마바사AI", "nameEn": "MabasaAI", "registeredNameKo": "마바사에이아이", "relation": "직접 경쟁", "reason": "같은 시장"}]
    comp = lambda name, dom, status="reported": {"name": name, "relation": "직접 경쟁", "products": "칩", "revenue": None, "employees": "50명",  # noqa: E731
                                                 "funding": None, "asOf": None, "status": status, "sourceUrl": None, "domestic": dom}
    r["sections"]["facts"]["result"]["competitors"] = [comp("Mabasa AI Inc.", True), comp("마바사에이아이", True), comp("해외갑", False),
                                                       comp("가나다테크", True), comp("하하랩", True, "inferred")]
    m = remerge(r)
    assert [(x["name"], x["foundIn"], x["status"]) for x in m["rivals"]] == [
        ("마바사AI", ["profile", "facts"], "reported"), ("하하랩", ["facts"], "inferred")]
    assert m["rivals"][0]["key"] == "rival:마바사에이아이" and m["rivals"][0]["employees"] == "50명"
    assert len(m["rivals"][0]["sources"]) == 2


def test_founded_conflict_rules():
    r = base()
    fields = r["sections"]["facts"]["result"]["fields"]
    f = next(x for x in fields if x["key"] == "founded")
    f.update(value="2020년", status="reported")  # 연도만 같으면 같은 값
    assert remerge(r)["founded"]["status"] == "confirmed"
    f.update(value="2019", status="reported")
    m = remerge(r)["founded"]
    assert m["status"] == "conflicting" and m["usedIndex"] == 0 and [v["display"] for v in m["values"]] == ["2020-09-15", "2019"]
    assert m["raw"] == "2020-09-15" and m["values"][1]["source"]["kind"] == "검색 결과 발췌"
    f.update(value="2019-01", status="inferred")  # 추정 웹 값은 공공 API 값과 엇갈림으로 두지 않는다
    assert remerge(r)["founded"]["status"] == "confirmed"


def test_no_corp_uses_facts_and_single_value_conflict():
    r = copy.deepcopy(JOBS["F-NOCORP#0"])
    region = next(x for x in r["sections"]["facts"]["result"]["fields"] if x["key"] == "region")
    region["status"] = "conflicting"
    m = remerge(r)
    assert m["region"]["status"] == "conflicting" and m["region"]["usedIndex"] is None and len(m["region"]["values"]) == 1
    assert m["region"]["note"] == "다른 자료의 값은 이 분석에 남지 않았습니다." and m["region"]["raw"] == "부산"
    assert m["ceo"]["reason"] == "법인 확인 안 함" and m["revenue"]["official"]["reason"] == "법인 확인 안 함"


def test_pending_and_interrupted_reasons():
    r = copy.deepcopy(JOBS["F-STAGED#0"])
    m = remerge(r, running=True)
    assert m["pending"] == ["employees", "revenue.web", "industry.web", "founded.web", "investors.confirmed", "rivals.facts"]
    assert m["region"] is None and m["employees"] is None
    r["company"]["crno"] = None
    r["companyId"] = C.company_id_for(r["query"])
    assert "region.web" in remerge(r, running=True)["pending"]
    r = base()
    r["sections"]["facts"].update(status="unavailable", result=None, error={"code": "interrupted", "message": "x", "source": None, "retryAt": None})
    m = remerge(r)
    assert m["employees"]["reason"] == "분석이 중간에 멈춤" and m["revenue"]["web"]["reason"] == "분석이 중간에 멈춤"
    assert m["pending"] == [] and all(i["foundIn"] == ["funding_history"] for i in m["investors"])


def test_investors_merge_names_and_keep_only_confirmed_or_reported():
    r = base()
    fh = r["sections"]["funding_history"]["result"]
    first = fh["investors"][0]["name"]
    r["sections"]["facts"]["result"]["investors"] = [
        {"name": f"(주){first}", "round": None, "date": None, "status": "reported", "sourceUrl": None},
        {"name": "새로운인베스트", "round": "시리즈 A", "date": "2024-02", "status": "confirmed", "sourceUrl": "https://example.com/i"},
        {"name": "새로운인베스트", "round": "시리즈 B", "date": "2025-05", "status": "reported", "sourceUrl": None},
        {"name": "추정파트너스", "round": None, "date": None, "status": "inferred", "sourceUrl": None},
        {"name": "엇갈림캐피탈", "round": None, "date": None, "status": "conflicting", "sourceUrl": None}]
    m = remerge(r)
    by = {i["name"]: i for i in m["investors"]}
    assert f"(주){first}" in by[first]["aliases"] and by[first]["foundIn"] == ["funding_history", "facts"]
    assert by[first]["status"] == "reported"  # facts 기록이 reported 뿐이면 그대로
    new = by["새로운인베스트"]
    assert (new["status"], new["roundCount"], new["roundLabels"], new["lastDate"], new["lead"]) == (
        "confirmed", 2, ["시리즈 A 2024-02", "시리즈 B 2025-05"], "2025-05", False)
    assert {s["kind"] for s in new["sources"]} == {"원문 확인", "검색 결과 발췌"}
    assert "추정파트너스" not in by and "엇갈림캐피탈" not in by
    order = [(not i["lead"], -i["roundCount"]) for i in m["investors"]]
    assert order == sorted(order)


def test_values_never_auto_fill_biz_type():
    m = remerge(base())
    assert m["bizType"]["status"] == "unavailable" and m["bizType"]["reason"] == "근거 자료 없음"
    assert m["bizTypeHint"]["id"] == "venture"
    r = base()
    r["sections"]["funding_history"]["result"]["rounds"] = []
    assert remerge(r)["bizTypeHint"] is None
