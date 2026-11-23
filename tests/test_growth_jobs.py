"""성장노트 분석 작업 전체 테스트: 실제 단락 함수 + 가짜 바깥 응답(httpx.MockTransport·monkeypatch) → 계약 모양.

바깥 API(Liner, 공공데이터포털, NAVER, OpenAlex, Google Patents)는 하나도 부르지 않는다.
가상의 회사 '가나다테크'와 지어낸 경쟁사·투자기관만 쓴다(fixtures/analysis 와 같은 이름 규칙).
"""
from __future__ import annotations

import json
import threading
import time
import zlib
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path

import httpx
import pytest
from pydantic import TypeAdapter

import pipeline
from growth import common, contract as C, jobs, limits as L, news, papers, patents, public_data, gov, sections
from growth.store import Store

ROOT = Path(__file__).resolve().parent.parent
LINER_KEY = "liner-test-key-000000000"
DATA_KEY = "data-key-1234567890abc"
NAVER_ID, NAVER_SECRET = "naver-id-12345678", "naver-secret-12345678"
CRNO = "1101110000001"
JOB = TypeAdapter(C.AnalysisJob)

CORPS = [
    {"crno": CRNO, "bzno": "1234567890", "corpNm": "주식회사 가나다테크", "corpEnsnNm": "GANADA TECH Inc.", "enpRprFnm": "홍길동",
     "enpEstbDt": "20200915", "enpBsadr": "서울특별시 강남구 예시로 123", "enpHmpgUrl": "www.example.com", "sicNm": "전자집적회로 제조업",
     "enpMainBizNm": "", "corpRegMrktDcdNm": "기타", "lastOpegDt": "20260501"},
    {"crno": "1101110000002", "bzno": "2234567890", "corpNm": "가나다테크놀로지 주식회사", "corpEnsnNm": "", "enpRprFnm": "김철수",
     "enpEstbDt": "20150302", "enpBsadr": "경기도 성남시 분당구 예시로 45", "lastOpegDt": "20250101"},
    {"crno": "1101110000005", "bzno": "5234567890", "corpNm": "주식회사 마바사에이아이", "corpEnsnNm": "Mabasa", "enpRprFnm": "이영희",
     "enpEstbDt": "20180402", "enpBsadr": "대전광역시 유성구 예시로 7", "lastOpegDt": "20260101"},
    {"crno": "1101110000009", "bzno": "9234567890", "corpNm": "주식회사 아자차랩스", "enpRprFnm": "박민수", "enpEstbDt": "20190101",
     "enpBsadr": "서울특별시 마포구 예시로 9", "lastOpegDt": "20260101"},
]
FIN = [{"bizYear": y, "basDt": f"{y}1231", "fnclDcdNm": "별도요약재무제표", "curCd": "KRW", "enpSaleAmt": str(rev), "enpBzopPft": str(op),
        "iclsPalClcAmt": str(op), "enpCrtmNpf": str(op * 0.8), "enpTastAmt": "20000000000", "enpTdbtAmt": "6000000000",
        "enpTcptAmt": "14000000000", "enpCptlAmt": "1000000000", "fnclDebtRto": "42.9"}
       for y, rev, op in (("2022", 1.2e9, 1.2e8), ("2023", 3.4e9, 3.5e8), ("2024", 5.67e9, 6.2e8))]
NPS_MONTHS = [("202508", "1", 100, 3, 1), ("202509", "2", 103, 4, 1), ("202510", "3", 105, 3, 1)]
PDL_COLS = ["name", "status", "funding_stage", "total_raised", "location", "website", "funding_round_count", "funding_rounds", "also_known_as", "sources"]
PDL_ROWS = [["Ganada Tech", "", "Series B", "41000000.0", "Seoul, Korea", "example.com", "3",
             "Seed, 2021-01-10: $1M (가나다벤처스); Series A, 2023-03-01: $10M (Test Ventures A, 가나다벤처스); "
             "Series B, 2025-06-01: $30M (Test Ventures B)", "가나다테크", "People Data Labs"],
            ["Ganada Technology Holdings", "", "Series A", "5000000.0", "Seoul", "holdings.example.net", "1",
             "Series A, 2022-01-01: $5M (Test Ventures Z)", "", "People Data Labs"]]
PATENT_PAGE = ("KR102000001B1 - 신경망 연산 가속 장치 Info Application number KR1020240000001A Original Assignee 주식회사 가나다테크 "
               "Filing date 2024-03-03 Application filed by 주식회사 가나다테크 filed Critical 주식회사 가나다테크 "
               "2025-09-01 Publication of KR20250000001A publication 2026-02-01 Publication of KR102000001B1 Status Active\n"
               "Abstract <img src=x onerror=alert(1)> 입력을 나눠 처리하는 가속 장치. Description\n")
# 경쟁사(마바사에이아이) 특허 원문: 출원인이 경쟁사로 확인된다. 아래 MENTION 은 출원인이 다른 문서(언급 문서, 경쟁사 특허로 세지 않음)
RIVAL_PATENT_PAGE = ("KR102000002B1 - 추론 칩 메모리 배치 Info Application number KR1020230000002A Original Assignee 주식회사 마바사에이아이 "
                     "Filing date 2023-05-05 Application filed by 주식회사 마바사에이아이 filed Critical 주식회사 마바사에이아이 "
                     "2024-11-01 Publication of KR20240000002A publication 2025-03-01 Publication of KR102000002B1 Status Active\n"
                     "Abstract 추론 칩의 메모리 배치. Description\n")
RIVAL_MENTION_PAGE = ("KR20250000003A - 다른 장치 Info Application number KR1020250000003A Original Assignee 주식회사 다른회사 "
                      "Filing date 2025-01-01 Application filed by 주식회사 다른회사 filed Critical 주식회사 다른회사 "
                      "2025-07-01 Publication of KR20250000003A Status Pending\nAbstract 마바사에이아이 칩을 인용한 장치. Description\n")
PATENT_PAGES = {"KR102000001B1": PATENT_PAGE, "KR102000002B1": RIVAL_PATENT_PAGE, "KR20250000003A": RIVAL_MENTION_PAGE}
ANSWERS = {
    "company_profile": {
        "name_ko": "가나다테크", "name_en": "Ganada Tech", "aliases": ["GanadaTech"], "is_korean": True, "founders": "홍길동",
        "industry": "AI 반도체 설계", "business": "가나다테크는 추론용 칩을 설계한다.", "products": [{"name": "가나다 칩", "desc": "추론 칩"}],
        "core_tech": ["저전력 설계"], "status_notes": ["실증 사업 진행"], "stage": "성장", "fund_field": "ai",
        "competitors": [{"name": "마바사", "name_en": "Mabasa", "registered_name_ko": "마바사에이아이", "country": "한국", "is_korean": True,
                         "relation": "직접 경쟁", "reason": "같은 칩 시장"},
                        {"name": "해외회사", "name_en": "Overseas", "registered_name_ko": "", "country": "미국", "is_korean": False,
                         "relation": "직접 경쟁", "reason": "해외"}],
        "tech_keywords": [{"ko": "신경망 가속기", "en": "neural network accelerator"}],
        "gov_keywords": ["인공지능", "반도체"], "bid_keywords": ["AI 서버", "반도체"]},
    "news_summary": {"summary": "긴 요약", "events": [{"date": "2026-11-01", "category": "제품 출시", "title": "신제품 출시", "detail": "칩 출시",
                                                    "source": 0}], "trends": ["흐름 1", "흐름 2"]},
    "paper_summary": {"topics": [{"topic": "신경망 가속기", "research_summary": "연구 흐름", "relevance": "관련 있음",
                                  "key_papers": [{"index": 0, "point": "핵심 내용"}]}]},
    "funding_history": {"rounds": []},
    "rival_summary": {"rivals": [{"name": "마바사", "business": "마바사는 칩을 만든다.", "products_tech": "추론 칩", "recent_changes": ["변화 1"]}]},
}
FACTS_ANALYSIS = {
    "company_name": "가나다테크",
    "facts": [{"category": "profile", "item": "설립일", "value": "2020년 9월", "status": "confirmed", "source_url": "https://example.com/facts/1",
               "evidence": "가나다테크는 2020년 9월 설립됐다."},
              {"category": "profile", "item": "본사 소재지", "value": "서울특별시 강남구", "status": "confirmed", "source_url": "https://example.com/facts/2",
               "evidence": "본사는 서울 강남구"},
              {"category": "profile", "item": "주요 제품", "value": "AI 칩", "status": "confirmed", "source_url": "https://example.com/facts/3",
               "evidence": "AI 칩을 만드는 가나다테크"},
              {"category": "finance", "item": "직원 수", "value": "120", "unit": "명", "status": "reported", "source_url": "https://example.com/facts/4",
               "evidence": "직원은 120명이다."}],
    "financials": [{"metric": "revenue", "value": "100", "unit": "억원", "year": "2025", "basis": "별도", "currency": "KRW", "status": "reported",
                    "source_url": "https://example.com/facts/5", "evidence": "매출 100억원"}],
    "existing_investors": [{"name": "가나다벤처스", "round": "Seed", "date": "2021-01", "status": "confirmed", "source_urls": ["https://example.com/inv/1"]},
                           {"name": "라마바인베스트", "round": "시리즈 A", "date": "2023-03", "status": "reported", "source_urls": []},
                           {"name": "나다라파트너스", "round": "", "date": "", "status": "inferred", "source_urls": []}],
    "competitors": [{"name": "Mabasa", "relation": "direct", "products": "추론 칩", "status": "reported", "source_urls": ["https://example.com/c/1"]},
                    {"name": "아자차랩스", "relation": "similar_tech", "products": "엣지 모듈", "status": "reported", "source_urls": []},
                    {"name": "해외갑", "relation": "global", "products": "", "status": "reported", "source_urls": []}],
}


class World:
    """가짜 바깥 세계. 요청 수를 세고, 필요하면 Liner 응답을 막아 둔다(동시 실행 시험)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.count: dict[str, int] = {}
        self.gate = threading.Event()
        self.gate.set()
        self.liner_status = 200
        self.naver_status = 200
        self.fail_models = False
        self.corps = CORPS              # 회사명 조회가 돌려줄 법인
        self.history: dict[str, list[dict]] = {}  # 법인등록번호 조회(이름 이력)가 돌려줄 기록
        self.history_status = 200
        self.prompts: dict[str, str] = {}  # 모델 이름 → 마지막으로 받은 사용자 글(요약에 넘긴 자료 확인용)

    def hit(self, k: str) -> None:
        with self.lock:
            self.count[k] = self.count.get(k, 0) + 1

    # Liner
    def liner(self, req: httpx.Request) -> httpx.Response:
        self.gate.wait(10)
        assert req.headers["x-api-key"] == LINER_KEY
        body = json.loads(req.content or b"{}")
        path = req.url.path
        if self.liner_status != 200:
            self.hit("liner_fail")
            return httpx.Response(self.liner_status, json={"error": {"message": "down"}})
        if path == "/api/v1/tools/search/scholar":
            self.hit("scholar")
            return httpx.Response(200, json={"results": [{"title": "Scholar paper on accelerators", "url": "https://example.com/sch/1",
                                                          "date": "2025-05-01", "authors": ["A"], "journal": "J", "citationCount": 3}]})
        if path == "/api/v1/responses":
            self.hit("responses")
            return httpx.Response(200, json={"output": [], "usage": {}})
        if path == "/api/v1/chat/completions":
            name = body["response_format"]["json_schema"]["name"]
            self.hit(name)
            self.prompts[name] = "\n".join(str(m.get("content")) for m in body.get("messages") or [] if m.get("role") == "user")
            if self.fail_models:
                return httpx.Response(500, json={"error": {"message": "model down"}})
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(ANSWERS[name], ensure_ascii=False)}}], "usage": {}})
        q = body["query"]
        if body.get("include_knowledge"):
            self.hit("premium")
            return httpx.Response(200, json={"results": [], "knowledge": [{"title": "Companies", "columns": PDL_COLS, "rows": PDL_ROWS,
                                                                           "sources": ["People Data Labs"]}]})
        self.hit("search")
        if "site:patents.google.com" in q and "마바사" in q:
            return httpx.Response(200, json={"results": [
                {"title": "KR102000002B1 - 추론 칩 메모리 배치", "url": "https://patents.google.com/patent/KR102000002B1/ko", "description": "마바사"},
                {"title": "KR20250000003A - 다른 장치", "url": "https://patents.google.com/patent/KR20250000003A/ko", "description": "마바사"}]})
        if "site:patents.google.com" in q:
            return httpx.Response(200, json={"results": [{"title": "KR102000001B1 - 신경망 연산 가속 장치",
                                                          "url": "https://patents.google.com/patent/KR102000001B1/ko", "description": "주식회사 가나다테크"}]})
        h = zlib.crc32(q.encode())
        return httpx.Response(200, json={"results": [
            {"title": f"가나다테크(Ganada Tech) 자료 {i}", "url": f"https://example.com/s/{h}/{i}", "description": f"가나다테크는 AI 반도체 회사다 {i}.",
             "date": "2026-10-0{}".format(i + 1)} for i in range(3)]})

    # 공공데이터포털(금융위·국민연금·나라장터)
    def datagokr(self, req: httpx.Request) -> httpx.Response:
        p, q = req.url.path, req.url.params
        assert q["serviceKey"] == DATA_KEY
        if p.endswith("getCorpOutline_V2") and "crno" in q:  # 이름 이력 조회(이름이 같은 후보만)
            self.hit("fsc_corp_crno")
            if self.history_status != 200:
                return httpx.Response(self.history_status, text="down")
            items = self.history.get(q["crno"], [])
            return httpx.Response(200, json={"response": {"body": {"totalCount": len(items), "items": {"item": items}}}})
        if p.endswith("getCorpOutline_V2"):
            self.hit("fsc_corp")
            key = q["corpNm"].replace(" ", "")
            items = [c for c in self.corps if key in c["corpNm"].replace(" ", "")]
            return httpx.Response(200, json={"response": {"body": {"totalCount": len(items), "items": {"item": items}}}})
        if p.endswith("getSummFinaStat_V2"):
            self.hit("fsc_fin")
            items = FIN if q["crno"] == CRNO else []
            return httpx.Response(200, json={"response": {"body": {"totalCount": len(items), "items": {"item": items}}}})
        if "Nps" in p:
            self.hit("nps")
            ok = "<header><resultCode>00</resultCode></header>"
            if p.endswith("getBassInfoSearchV2"):
                rows = "".join(f"<item><seq>{s}</seq><wkplNm>가나다테크</wkplNm><bzowrRgstNo>123456****</bzowrRgstNo>"
                               f"<dataCrtYm>{ym}</dataCrtYm><wkplRoadNmDtlAddr>서울특별시 강남구</wkplRoadNmDtlAddr></item>"
                               for ym, s, *_ in NPS_MONTHS) if q["wkplNm"] == "가나다테크" else ""
                return httpx.Response(200, text=f"<response>{ok}<body><items>{rows}</items></body></response>")
            row = next(m for m in NPS_MONTHS if m[1] == q["seq"])
            inner = (f"<jnngpCnt>{row[2]}</jnngpCnt><vldtVlKrnNm>소프트웨어 개발</vldtVlKrnNm>" if p.endswith("getDetailInfoSearchV2")
                     else f"<nwAcqzrCnt>{row[3]}</nwAcqzrCnt><lssJnngpCnt>{row[4]}</lssJnngpCnt>")
            return httpx.Response(200, text=f"<response>{ok}<body><items><item>{inner}</item></items></body></response>")
        if "BidPublicInfoService" in p:
            self.hit("g2b")
            kw = q["bidNtceNm"]
            item = {"bidNtceNo": f"R26BK{zlib.crc32(kw.encode()) % 10000:05d}", "bidNtceOrd": "000", "bidNtceNm": f"{kw} 구매",
                    "ntceInsttNm": "가나다시청", "bidBeginDt": "2026-11-01 10:00:00", "bidClseDt": "2099-12-01 18:00:00",
                    "asignBdgtAmt": "45000000", "bidMethdNm": "전자입찰", "cntrctCnclsMthdNm": "일반경쟁",
                    "bidNtceDtlUrl": "https://example.com/bid/1", "bidNtceDt": "2026-11-01 09:00:00"}
            return httpx.Response(200, json={"response": {"header": {"resultCode": "00"}, "body": {"items": [item]}}})
        raise AssertionError(p)

    def naver(self, req: httpx.Request) -> httpx.Response:
        self.hit("naver")
        assert req.headers["X-Naver-Client-Secret"] == NAVER_SECRET
        if self.naver_status != 200:
            return httpx.Response(self.naver_status, text="down")
        q = req.url.params["query"]
        if int(req.url.params["start"]) > 1:
            return httpx.Response(200, json={"items": []})
        topic = q.replace("가나다테크", "").strip() or "근황"
        off = zlib.crc32(q.encode()) % 5
        now = datetime.now(timezone.utc)
        items = [{"title": f"<b>{q.split()[0]}</b> {topic} 소식 {i}", "description": f"{q.split()[0]} 관련 발췌 {i}" + (f" serviceKey={DATA_KEY}" if i == 0 else ""),
                  "originallink": f"https://example.com/news/{zlib.crc32(q.encode())}/{i}", "link": f"https://example.com/naver/{zlib.crc32(q.encode())}/{i}",
                  "pubDate": format_datetime(now - timedelta(days=i * 7 + off))} for i in range(5)]
        return httpx.Response(200, json={"items": items})

    def openalex(self, req: httpx.Request) -> httpx.Response:
        self.hit("openalex")
        q = req.url.params
        if req.url.path == "/institutions":
            return httpx.Response(200, json={"results": []})
        if q.get("group_by") == "publication_year":
            y = datetime.now().year
            return httpx.Response(200, json={"group_by": [{"key": str(y - 2), "count": 10}, {"key": str(y - 1), "count": 15}]})
        if q.get("group_by"):
            return httpx.Response(200, json={"group_by": [{"key": "I1", "key_display_name": "가나다대학교", "count": 4}]})
        work = {"id": "https://openalex.org/W1", "doi": "https://doi.org/10.1/x", "display_name": "Neural accelerator design",
                "publication_year": 2025, "publication_date": "2025-03-01", "cited_by_count": 7, "fwci": 2.5,
                "authorships": [{"author": {"display_name": "Kim"}, "institutions": [{"display_name": "Ganada Tech"}],
                                 "raw_affiliation_strings": ["Ganada Tech, Seoul"]}],
                "primary_location": {"source": {"display_name": "Test Conf"}}}
        return httpx.Response(200, json={"results": [work]})


class FakeFetcher:
    def fetch(self, url):
        pub = url.split("/patent/")[1].split("/")[0]
        text = PATENT_PAGES.get(pub, "")
        return {"ok": bool(text), "text": text, "title": text.split(" Info ")[0] + " - Google Patents"}


class NoFetch:
    fetched, max_pages = 0, 0

    def fetch(self, url):  # 원문 확인을 하지 않는다(엔진 단위 테스트는 tests/test_funding_service.py)
        raise AssertionError(url)


def fake_search(run, client, step, say):
    data, _ = client.search_web(step["query"], country_code=step["country_code"], lang=step["lang"], label=f"search:{step['key']}",
                                max_results=5)
    run["searches"][step["key"]] = data
    run["search_meta"][step["key"]] = {"category": step["category"], "query": step["query"], "market": False}
    return True


def fake_models(run, client, say):
    say("Model API profile")
    for cat in ("profile", "finance", "vc", "competitors"):
        client.responses("지시", "자료", label=f"model:{cat}")
    run["category_runs"] = {c: {"status": "success"} for c in ("profile", "finance", "vc", "competitors")}
    run["analysis"] = json.loads(json.dumps(FACTS_ANALYSIS, ensure_ascii=False))


@pytest.fixture
def world(tmp_path, monkeypatch):
    w = World()
    env = {"DATA_GO_KR_SERVICE_KEY": DATA_KEY, "NAVER_CLIENT_ID": NAVER_ID, "NAVER_CLIENT_SECRET": NAVER_SECRET, "LINER_API_KEY": LINER_KEY}
    monkeypatch.setattr(common, "env", lambda k: env.get(k, ""))
    monkeypatch.setattr(common, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(sections, "liner_key", lambda: (LINER_KEY, "env"))
    monkeypatch.setattr(sections, "LINER_KWARGS", {"transport": httpx.MockTransport(w.liner), "sleep": lambda s: None})
    monkeypatch.setattr(sections, "FACTS_FETCHER", lambda: NoFetch())
    monkeypatch.setattr(sections, "PROFILE_WAIT_SEC", 10)
    monkeypatch.setattr(public_data, "_http", httpx.Client(transport=httpx.MockTransport(w.datagokr)))
    monkeypatch.setattr(public_data, "_sleep", lambda s: None)
    monkeypatch.setattr(gov, "_http", httpx.Client(transport=httpx.MockTransport(w.datagokr)))
    monkeypatch.setattr(news, "_NAVER", httpx.Client(transport=httpx.MockTransport(w.naver)))
    monkeypatch.setattr(papers, "_http", httpx.Client(transport=httpx.MockTransport(w.openalex)))
    monkeypatch.setattr(papers, "_sleep", lambda s: None)
    monkeypatch.setattr(patents, "_fetcher", lambda: FakeFetcher())
    monkeypatch.setattr(pipeline, "_do_search", fake_search)
    monkeypatch.setattr(pipeline, "rebuild_sources", lambda run: run.update(sources=[]))
    monkeypatch.setattr(pipeline, "run_models", fake_models)
    monkeypatch.delenv("GROWTH_EXAMPLE_COMPANY_ID", raising=False)
    L._reset_for_tests({})
    w.manager = jobs.Manager(Store(tmp_path / "analysis"))
    w.root = tmp_path / "analysis"
    yield w
    w.gate.set()
    L._reset_for_tests({})


def wait_idle(m: jobs.Manager, job_id: str, timeout: float = 15.0, views: list | None = None) -> dict:
    """작업이 끝나고(busy false) 그 상태가 파일에도 쓰일 때까지 기다린다."""
    end = time.time() + timeout
    while time.time() < end:
        job = m.get(job_id)
        v = job.view()
        if views is not None:
            views.append(v)
        if not v["busy"] and job.flushed():
            return job.view()
        time.sleep(0.02)
    raise AssertionError("작업이 끝나지 않았습니다")


# ---------------------------------------------------------------- 계약 규칙 검사(tests/test_growth_contract.py 의 가짜 응답 규칙과 같다)

def walk(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield path, k, v
            yield from walk(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, f"{path}[{i}]")


def check_contract(job: dict) -> None:
    JOB.validate_python(job, strict=True)
    sec, m = job["sections"], job["merged"]
    assert list(sec) == list(C.SECTION_KEYS)
    assert job["companyId"] == C.company_id_for(job["query"], job["company"]["crno"])
    assert job["paid"]["liner"] == {k: sum(s["paid"][k] for s in sec.values()) for k in ("search", "premium", "model", "scholar")}
    assert job["estimates"] == C.ESTIMATES
    if job["status"] == "running":
        assert job["busy"] and job["analyzedAt"] is None
    else:
        assert job["analyzedAt"] is not None and m["pending"] == []
    for key, s in sec.items():
        st, res, err = s["status"], s["result"], s["error"]
        assert s["key"] == key and s["expectedSeconds"] == C.EXPECTED_SECONDS[key]
        if st == "done":
            assert res is not None and err is None, key
        elif st == "partial":
            assert res is not None and err is not None, key
        elif st == "unavailable":
            assert err is not None and (res is not None) == (err["code"] == "no_data"), key
        else:
            assert res is None and err is None and s["analyzedAt"] is None, key
        if st in C.TERMINAL_SECTION_STATUSES:
            assert s["analyzedAt"] and s["startedAt"] and s["seconds"] is not None, key
        if st == "waiting":
            assert s["waitingFor"], key
        if st != "running":
            assert s["stage"] is None, key
        if err and err["code"] == "daily_limit":
            assert err["retryAt"] and not s["retryable"], key
        if job["isExample"] and key != "sales":
            assert not s["retryable"], key
    n = sec["news"]["result"]
    if n:
        assert len(n["articles"]) <= 20 and n["articleTotal"] >= len(n["articles"])
        assert {c["category"] for c in n["categoryCounts"]} == set(C.NEWS_CATEGORIES)
        counts = [c["count"] for c in n["categoryCounts"]]
        assert counts == sorted(counts, reverse=True)
    for _, _, v in walk(m):
        if isinstance(v, dict) and "usedIndex" in v and "status" in v:
            if v["status"] == "unavailable":
                assert v["display"] is None and v["reason"] and v["values"] is None
            elif v["status"] == "conflicting":
                assert v["values"] and (v["usedIndex"] is None or v["raw"] == v["values"][v["usedIndex"]]["raw"])
            else:
                assert v["display"] and v["reason"] is None and v["values"] is None and v["usedIndex"] is None
            if v["source"]:
                assert v["source"]["label"] == C.source_label(v["source"]["org"], v["source"]["name"], v["source"]["kind"])
    assert all(i["status"] in ("confirmed", "reported") for i in m["investors"])
    foreign = {c["name"] for c in ((sec["facts"]["result"] or {}).get("competitors") or []) if not c["domestic"]}
    assert not foreign & {r["name"] for r in m["rivals"]}
    assert len({r["key"] for r in m["rivals"]}) == len(m["rivals"]) and all(r["key"].startswith("rival:") for r in m["rivals"])
    both = [len(r["foundIn"]) == 2 for r in m["rivals"]]
    assert both == sorted(both, reverse=True)
    assert set(m["pending"]) <= set(C.PENDING_KEYS) and len(m["bidKeywords"]) <= 6
    if sec["facts"]["status"] not in C.TERMINAL_SECTION_STATUSES:
        assert m["employees"] is None and "employees" in m["pending"]
    hangul = [k for _, k, _ in walk(job) if any("가" <= ch <= "힣" for ch in k)]
    assert hangul == []  # 한글은 값에만(분류 이름도 categoryCounts 의 값)
    for _, k, v in walk(job):
        if isinstance(v, str) and k.lower().endswith("url"):
            assert v.startswith(("http://", "https://")), (k, v)


MAP_KEYS = {"byYear", "byCurrency", "apiCounts", "mentionByYear"}


def same_shape(a, b, path="") -> None:
    """가짜 응답(fixtures/analysis/F-FULL)과 키 구조가 같은가(값이 있는 곳끼리)."""
    if isinstance(a, dict) and isinstance(b, dict):
        if path.rsplit(".", 1)[-1] in MAP_KEYS:
            return
        assert set(a) == set(b), (path, set(a) ^ set(b))
        for k in a:
            same_shape(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list) and a and b:
        same_shape(a[0], b[0], path + "[0]")


# ---------------------------------------------------------------- 기본 분석 전체

def run_full(w: World, **kw) -> dict:
    status, body = w.manager.start("주식회사 가나다테크", CRNO, "example.com", kw.get("refresh", False))
    assert status == 202 and body["started"] and body["companyId"] == CRNO
    views: list[dict] = []
    v = wait_idle(w.manager, body["jobId"], views=views)
    for x in views[::max(1, len(views) // 10)]:  # 진행 중 응답도 계약 모양
        check_contract(x)
    return v


def test_full_analysis_matches_contract_and_fixture_shape(world):
    v = run_full(world)
    check_contract(v)
    assert v["status"] == "done" and v["company"] == {"name": "주식회사 가나다테크", "crno": CRNO} and not v["busy"]
    s = v["sections"]
    assert {k: s[k]["status"] for k in C.BASIC_SECTIONS} == {k: "done" for k in C.BASIC_SECTIONS}
    assert [s[k]["status"] for k in C.ON_DEMAND_SECTIONS] == ["idle", "idle", "idle"]
    assert [s[k]["retryable"] for k in ("identity", "news", "papers", "rivals_deep", "sales")] == [False, True, True, True, True]
    # 가짜 응답(F-FULL)과 같은 키 구조
    fixture = json.loads((ROOT / "fixtures" / "analysis" / "F-FULL.json").read_text(encoding="utf-8"))["exchanges"][0]["response"]
    same_shape(v, fixture)
    # 단락 결과
    ident = s["identity"]["result"]
    assert ident["corp"]["crno"] == CRNO and ident["corp"]["region"] == "서울" and [c["crno"] for c in ident["otherCorps"]] == ["1101110000002"]
    o = s["official"]["result"]
    assert [r["year"] for r in o["financials"]] == ["2022", "2023", "2024"] and o["financials"][1]["revenueGrowthPct"] == 183.3
    assert [x["members"] for x in o["nps"]["monthly"]] == [100, 103, 105] and o["nps"]["summary"]["change"] == 5
    p = s["profile"]["result"]
    assert [c["name"] for c in p["competitors"]] == ["마바사"] and p["sourceCount"] == 9 and p["fundField"] == "ai"
    f = s["facts"]["result"]
    assert {c["name"]: c["domestic"] for c in f["competitors"]} == {"Mabasa": True, "아자차랩스": True, "해외갑": False}
    fh = s["funding_history"]["result"]
    assert [r["round"] for r in fh["rounds"]] == ["Series B", "Series A", "Seed"]
    assert [e["name"] for e in fh["relatedEntities"]] == ["Ganada Technology Holdings"]
    assert "Test Ventures Z" not in {i["name"] for i in fh["investors"]}  # 관련 법인의 투자기관은 빼다
    nr = s["news"]["result"]
    assert nr["articleTotal"] > 20 and len(nr["articles"]) == 20 and nr["articles"][0]["id"] == "a1"
    assert nr["events"][0]["articleId"] and nr["longSummary"] == "긴 요약"
    assert nr["articles"][0]["title"].startswith("가나다테크")  # NAVER 제목의 <b> 태그를 지운 평문
    pt = s["patents"]["result"]
    assert pt["summary"]["total"] == 1 and pt["patents"][0]["applicationNo"] == "10-2024-0000001" and pt["pagesLimit"] == 30
    assert pt["patents"][0]["abstract"].startswith("<img")  # 글 그대로(화면이 HTML 로 해석하지 않는다)
    # 합친 값
    m = v["merged"]
    assert (m["region"]["raw"], m["district"], m["headquarters"]["display"]) == ("서울", "강남구", "서울 강남구")
    assert m["founded"]["status"] == "confirmed" and m["founded"]["raw"] == "2020-09-15"  # 웹 '2020-09' 는 같은 값
    assert m["ceo"]["display"] == "홍길동" and m["industry"]["official"]["display"] == "전자집적회로 제조업"
    assert (m["industry"]["web"]["display"], m["industry"]["web"]["status"]) == ("AI 칩", "confirmed")
    assert m["industry"]["web"]["source"]["kind"] == "원문 확인" and m["industry"]["web"]["source"]["org"] == "example.com"
    assert (m["employees"]["display"], m["employees"]["status"]) == ("120명", "reported")
    assert m["revenue"]["official"]["display"] == "56.7억원" and m["revenue"]["official"]["source"]["asOf"] == "2024 사업연도"
    assert m["revenue"]["official"]["source"]["basis"] == "별도" and m["revenue"]["web"]["display"] == "100억원 (2025, 별도)"
    assert (m["npsLatest"]["raw"], m["npsLatest"]["status"]) == (105, "reference") and m["npsLatest"]["source"]["asOf"] == "2025-10"
    assert m["patentCount"]["raw"] == 1 and m["bizType"]["status"] == "unavailable"
    assert m["bizTypeHint"] == {"id": "venture", "reason": "설립 2020-09, 투자 라운드 3건"}
    assert m["fundField"]["display"] == C.FUND_FIELD_LABEL["ai"] and m["bidKeywords"] == ["AI 서버", "반도체"]
    assert m["programKeywords"] == ["인공지능", "반도체", "신경망 가속기", "저전력 설계"]
    inv = {i["name"]: i for i in m["investors"]}
    assert set(inv) == {"가나다벤처스", "Test Ventures A", "Test Ventures B", "라마바인베스트"}  # 추정(나다라파트너스)·관련 법인 투자기관 없음
    assert inv["가나다벤처스"]["status"] == "confirmed" and inv["가나다벤처스"]["foundIn"] == ["funding_history", "facts"]
    assert inv["Test Ventures A"]["status"] == "reported" and inv["라마바인베스트"]["roundLabels"] == ["시리즈 A 2023-03"]
    assert [i["name"] for i in m["investors"]][0] == "가나다벤처스"  # 참여 라운드 많은 순
    assert [(r["name"], r["foundIn"]) for r in m["rivals"]] == [("마바사", ["profile", "facts"]), ("아자차랩스", ["facts"])]
    assert m["rivals"][0]["key"] == "rival:마바사에이아이" and m["rivals"][0]["status"] == "reported" and m["rivals"][0]["products"] == "추론 칩"
    # 호출 수(단락 상한 안, 경쟁사 투자 조사 없음)
    assert v["paid"]["liner"] == {"search": 11, "premium": 1, "model": 6, "scholar": 0}
    assert world.count["responses"] == 4 and "rival_research" not in world.count
    assert s["facts"]["paid"] == {"search": 4, "premium": 0, "model": 4, "scholar": 0}
    usage = L.usage_today()["apis"]
    assert usage[L.LINER_SEARCH]["used"] == 11 and usage[L.LINER_SEARCH]["remaining"] == 500 - 11  # 예약은 모두 돌려받았다
    assert usage[L.DATAGOKR_NPS]["used"] == world.count["nps"] and usage[L.NAVER_NEWS]["used"] == world.count["naver"]
    assert usage[L.PATENTS_PAGE]["used"] == pt["pagesChecked"] >= 1  # 원문을 받은 쪽마다 하나씩


def test_snapshot_is_written_scrubbed_and_restored(world):
    v = run_full(world)
    files = sorted((world.root / CRNO).glob("*.json"))
    names = [f.name for f in files]
    assert "latest.json" in names and len(files) == 2
    snap_path = next(f for f in files if f.name != "latest.json")
    assert snap_path.name == v["startedAt"][:19].replace("-", "").replace(":", "").replace("T", "-") + ".json"
    text = snap_path.read_text(encoding="utf-8")
    for secret in (DATA_KEY, LINER_KEY, NAVER_SECRET, NAVER_ID):
        assert secret not in text and secret not in json.dumps(v, ensure_ascii=False)
    snap = json.loads(text)
    assert snap["schema"] == "growth.analysis/1" and len(snap["sections"]["news"]["result"]["articles"]) == v["sections"]["news"]["result"]["articleTotal"]
    assert json.loads((world.root / CRNO / "latest.json").read_text()) == {"file": snap_path.name, "jobId": v["jobId"], "analyzedAt": v["analyzedAt"]}
    # 서버를 다시 시작한 것처럼 새 관리자로 읽는다
    m2 = jobs.Manager(Store(world.root))
    again = m2.get(v["jobId"]).view()
    check_contract(again)
    assert again["sections"] == v["sections"] and again["merged"] == v["merged"]
    assert m2.company_analysis(CRNO)["jobId"] == v["jobId"] and m2.saved_job_id(CRNO) == v["jobId"]
    page = m2.news_page(v["jobId"], 20, 20, [])
    assert page["items"] and page["items"][0]["id"] == "a21" and page["articleTotal"] == v["sections"]["news"]["result"]["articleTotal"]


def test_waiting_section_whose_deps_finished_is_shown_running(world):
    """앞 단락이 끝난 뒤 단락 스레드가 깨어나기 전의 틈: 기다릴 앞 단락이 없는 waiting 은 running 으로 보인다(빈 waitingFor 의 waiting 없음)."""
    v = run_full(world)
    job = jobs.Manager(Store(world.root)).get(v["jobId"])
    with job.lock:
        for key in ("profile", "news"):  # identity 는 끝났고, news 는 profile 을 기다린다
            job.data["sections"][key] = jobs._envelope(key, "waiting", job.data["startedAt"])
    s = job.view()["sections"]
    assert s["profile"]["status"] == "running" and s["profile"]["waitingFor"] == [] and s["profile"]["stage"] == jobs.RUN_STAGE.get("profile")
    assert s["news"]["status"] == "waiting" and s["news"]["waitingFor"] == ["profile"]
    assert job.data["sections"]["profile"]["status"] == "waiting"  # 보이는 값만 바꾸고 작업 상태는 단락 스레드가 바꾼다


def test_section_on_restored_older_job_does_not_move_latest_pointer_back(world):
    """서버를 다시 시작한 뒤 옛 작업 A 에서 단락(sales)을 실행해도 latest.json 은 더 새 작업 B 를 가리킨다."""
    a = run_full(world)
    status, body = world.manager.start("주식회사 가나다테크", CRNO, "example.com", True)  # 새로 분석(진행 중 모양 검사는 run_full 이 한다)
    assert status == 202 and body["started"]
    b = wait_idle(world.manager, body["jobId"])
    assert a["jobId"] != b["jobId"] and b["status"] == "done"
    latest = world.root / CRNO / "latest.json"
    assert json.loads(latest.read_text())["jobId"] == b["jobId"]
    # A 가 B 보다 확실히 먼저 끝난 것으로(같은 초에 끝났을 수 있으므로 파일의 분석 시각을 하루 앞당긴다)
    a_path = next(p for p in (world.root / CRNO).glob("2*.json") if json.loads(p.read_text())["jobId"] == a["jobId"])
    d = json.loads(a_path.read_text(encoding="utf-8"))
    older = (common.parse_iso(b["analyzedAt"]) - timedelta(days=1)).isoformat(timespec="seconds")
    d["analyzedAt"] = older
    a_path.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")

    m2 = jobs.Manager(Store(world.root))  # 다시 시작: A 를 디스크에서 읽는다
    m2.run_section(a["jobId"], "sales", None, ["AI 서버"])
    after = wait_idle(m2, a["jobId"])
    assert after["sections"]["sales"]["status"] == "done" and after["analyzedAt"] == older
    assert json.loads(a_path.read_text(encoding="utf-8"))["sections"]["sales"]["status"] == "done"  # A 파일은 썼다
    assert json.loads(latest.read_text())["jobId"] == b["jobId"]
    assert m2.saved_job_id(CRNO) == b["jobId"] and m2.company_analysis(CRNO)["jobId"] == b["jobId"]

    # 새롭거나 같은 쪽(B)에서 단락을 실행하면 포인터를 쓴다(지워져 있었으면 다시 만든다)
    latest.unlink()
    m2.run_section(b["jobId"], "sales", None, ["AI 서버"])
    wait_idle(m2, b["jobId"])
    assert json.loads(latest.read_text())["jobId"] == b["jobId"]


def test_restart_turns_running_file_into_interrupted(world):
    v = run_full(world)
    path = next(p for p in (world.root / CRNO).glob("2*.json"))
    d = json.loads(path.read_text(encoding="utf-8"))
    d.update(status="running", analyzedAt=None, busy=True)
    d["sections"]["facts"].update(status="running", result=None, analyzedAt=None, seconds=None, stage="원문 확인")
    d["sections"]["news"]["rerun"] = {"status": "running", "startedAt": d["startedAt"], "seconds": 1.0, "error": None}
    path.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    (world.root / CRNO / "latest.json").unlink()
    m2 = jobs.Manager(Store(world.root))
    got = m2.company_analysis(CRNO)  # done 이 없으면 interrupted 중 가장 최근
    check_contract(got)
    assert got["status"] == "interrupted" and not got["busy"] and got["analyzedAt"]
    f = got["sections"]["facts"]
    assert (f["status"], f["error"]["code"], f["retryable"]) == ("unavailable", "interrupted", True)
    assert got["sections"]["news"]["rerun"]["status"] == "failed" and got["sections"]["news"]["status"] == "done"
    assert got["merged"]["employees"] == {**got["merged"]["employees"], "status": "unavailable", "reason": "분석이 중간에 멈춤"}
    assert json.loads(path.read_text(encoding="utf-8"))["status"] == "interrupted"  # 파일도 다시 썼다
    with pytest.raises(jobs.ApiFailure) as e:
        m2.company_job(CRNO)
    assert e.value.status == 404


def test_section_rerun_keeps_previous_result_until_new_one(world):
    v = run_full(world)
    jid = v["jobId"]
    before = v["sections"]["news"]
    world.gate.clear()  # 새 Liner 응답을 잠시 막는다
    assert world.manager.run_section(jid, "news", None, None) == {"jobId": jid, "key": "news", "started": True}
    mid = world.manager.get(jid).view()
    check_contract(mid)
    n = mid["sections"]["news"]
    assert n["status"] == "done" and n["result"] == before["result"] and n["rerun"]["status"] == "running" and mid["busy"]
    assert not n["retryable"]
    with pytest.raises(jobs.ApiFailure) as e:
        world.manager.run_section(jid, "news", None, None)
    assert (e.value.status, e.value.code) == (409, "section_running")
    world.gate.set()
    after = wait_idle(world.manager, jid)
    check_contract(after)
    n = after["sections"]["news"]
    assert n["rerun"] is None and n["analyzedAt"] >= before["analyzedAt"] and n["paid"]["search"] == 4  # 뉴스만 새로: 캐시를 건너뛰었다
    assert after["analyzedAt"] == v["analyzedAt"]  # 작업 분석 시각은 바뀌지 않는다
    with pytest.raises(jobs.ApiFailure) as e:  # done 인 기본 단락은 다시 실행하지 않는다
        world.manager.run_section(jid, "profile", None, None)
    assert (e.value.status, e.value.code) == (409, "conflict")
    with pytest.raises(jobs.ApiFailure) as e:
        world.manager.run_section(jid, "news", None, ["낱말"])
    assert (e.value.status, e.value.code) == (400, "bad_request")


def test_failed_rerun_keeps_previous_result(world):
    v = run_full(world)
    world.liner_status = world.naver_status = 503
    world.manager.run_section(v["jobId"], "news", None, None)
    after = wait_idle(world.manager, v["jobId"])
    check_contract(after)
    n = after["sections"]["news"]
    assert n["status"] == "done" and n["result"] == v["sections"]["news"]["result"] and n["analyzedAt"] == v["sections"]["news"]["analyzedAt"]
    assert n["rerun"]["status"] == "failed" and n["rerun"]["error"]["code"] == "upstream_error" and n["retryable"]
    assert n["paid"]["search"] > v["sections"]["news"]["paid"]["search"]  # 실패한 요청도 센다(자동 재시도 포함)


def test_on_demand_sections_papers_sales_rivals(world):
    v = run_full(world)
    jid = v["jobId"]
    world.manager.run_section(jid, "papers", None, None)
    world.manager.run_section(jid, "sales", None, ["AI 서버", " AI 서버 ", "반도체"])
    world.manager.run_section(jid, "rivals_deep", [{"key": "rival:마바사에이아이", "name": "마바사", "nameEn": "Mabasa", "crno": None}], None)
    after = wait_idle(world.manager, jid)
    check_contract(after)
    s = after["sections"]
    pp = s["papers"]
    assert pp["status"] == "done" and pp["paid"] == {"search": 0, "premium": 0, "model": 1, "scholar": 1}
    topic = pp["result"]["topics"][0]
    assert topic["name"] == "신경망 가속기" and topic["trend"].startswith("증가") and topic["keyPapers"][0]["point"] == "핵심 내용"
    assert {p["source"] for p in topic["papers"]} == {"OpenAlex", "Liner Scholar"} and topic["papers"][0]["important"] == "FWCI 2.5"
    assert pp["result"]["company"]["works"][0]["title"] == "Neural accelerator design"
    sa = s["sales"]
    assert sa["status"] == "done" and sa["result"]["keywords"] == ["AI 서버", "반도체"] and sa["result"]["calls"] == 16
    assert {b["status"] for b in sa["result"]["items"]} == {"open"} and sa["result"]["strongKeywords"] == ["AI 서버", "반도체", "신경망 가속기"]
    rd = s["rivals_deep"]
    assert rd["status"] == "done" and rd["result"]["rivalSet"] == ["rival:마바사에이아이"]
    r0 = rd["result"]["rivals"][0]
    assert r0["corp"]["crno"] == "1101110000005" and r0["financials"] == [] and r0["financialsReason"]
    assert r0["summary"]["business"] == "마바사는 칩을 만든다." and r0["funding"] is None and r0["fundingReason"]
    assert after["paid"]["liner"]["scholar"] == 1 and after["status"] == "done"


def test_start_rules_running_saved_refresh_and_busy(world):
    m = world.manager
    world.gate.clear()
    s1, b1 = m.start("가나다테크", CRNO, None, False)
    s2, b2 = m.start("가나다테크", CRNO, None, True)  # 진행 중이면 refresh 와 상관없이 그 작업
    assert (s1, s2, b2) == (202, 200, {"jobId": b1["jobId"], "companyId": CRNO, "started": False})
    assert m.company_job(CRNO)["jobId"] == b1["jobId"]
    s3, b3 = m.start("다른회사", None, None, False)  # 법인 없이(이름 기반 회사 id)
    assert s3 == 202 and b3["companyId"].startswith("n-")
    with pytest.raises(jobs.ApiFailure) as e:  # 서버 동시 분석 2개
        m.start("세번째회사", None, None, False)
    assert (e.value.status, e.value.code) == (429, "busy")
    with pytest.raises(jobs.ApiFailure) as e:
        m.start("(주)", None, None, False)
    assert (e.value.status, e.value.code) == (400, "bad_request")
    world.gate.set()
    v1 = wait_idle(m, b1["jobId"])
    v3 = wait_idle(m, b3["jobId"])
    check_contract(v3)
    assert v3["sections"]["identity"]["error"]["code"] == "no_corp" and v3["sections"]["official"]["error"]["code"] == "no_corp"
    assert v3["company"] == {"name": "다른회사", "crno": None} and v3["merged"]["ceo"]["reason"] == "법인 확인 안 함"
    assert v3["sections"]["official"]["paid"] == {"search": 0, "premium": 0, "model": 0, "scholar": 0}
    assert m.start("가나다테크", CRNO, None, False) == (200, {"jobId": b1["jobId"], "companyId": CRNO, "started": False})  # 저장된 분석
    for i in range(L.REFRESH_PER_COMPANY_PER_DAY):
        st, b = m.start("가나다테크", CRNO, None, True)
        assert st == 202 and b["jobId"] != b1["jobId"]
        assert m.get(b["jobId"]).view()["refresh"]["remainingToday"] == L.REFRESH_PER_COMPANY_PER_DAY - i - 1
        wait_idle(m, b["jobId"])
    with pytest.raises(jobs.ApiFailure) as e:
        m.start("가나다테크", CRNO, None, True)
    assert (e.value.status, e.value.code) == (429, "refresh_limit") and e.value.retry_at.endswith("T00:00:00+09:00")
    assert len(list((world.root / CRNO).glob("2*.json"))) == 4  # 새로 분석은 새 파일, 이전 파일은 그대로
    assert v1["jobId"] != m.saved_job_id(CRNO)  # 가장 최근 done


def test_example_company_is_read_only_except_sales(world, monkeypatch):
    v = run_full(world)
    monkeypatch.setenv("GROWTH_EXAMPLE_COMPANY_ID", CRNO)
    ex = world.manager.example()
    assert ex == {"companyId": CRNO, "jobId": v["jobId"], "name": "주식회사 가나다테크", "analyzedAt": v["analyzedAt"]}
    job = world.manager.get(v["jobId"]).view()
    check_contract(job)
    assert job["isExample"] and job["refresh"]["remainingToday"] == 0
    assert [k for k, s in job["sections"].items() if s["retryable"]] == ["sales"]
    for key, body in (("papers", (None, None)), ("news", (None, None))):
        with pytest.raises(jobs.ApiFailure) as e:
            world.manager.run_section(v["jobId"], key, *body)
        assert (e.value.status, e.value.code) == (409, "example_readonly")
    with pytest.raises(jobs.ApiFailure) as e:
        world.manager.start("가나다테크", CRNO, None, True)
    assert e.value.code == "example_readonly"
    assert world.manager.run_section(v["jobId"], "sales", None, ["AI 서버"])["started"]
    wait_idle(world.manager, v["jobId"])
    monkeypatch.delenv("GROWTH_EXAMPLE_COMPANY_ID")
    with pytest.raises(jobs.ApiFailure) as e:
        world.manager.example()
    assert e.value.status == 404


def test_daily_limit_marks_only_that_section(world):
    # 모델 하루 2회: profile(예약 2)은 되고 facts(8)는 모자람. profile 이 1회로 확정한 뒤 남은 1로는 news·funding_history(각 2)도 모자람
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_LINER_MODEL": "2"})
    status, body = world.manager.start("가나다테크", CRNO, None, False)
    v = wait_idle(world.manager, body["jobId"])
    check_contract(v)
    s = v["sections"]
    codes = {k: (s[k]["error"] or {}).get("code") for k in C.BASIC_SECTIONS}
    assert codes == {"identity": None, "official": None, "profile": None, "facts": "daily_limit", "funding_history": "daily_limit",
                     "news": "daily_limit", "patents": None}
    assert s["facts"]["paid"] == {"search": 0, "premium": 0, "model": 0, "scholar": 0} and "responses" not in world.count
    assert not s["news"]["retryable"] and s["facts"]["error"]["retryAt"].endswith("T00:00:00+09:00")
    assert v["merged"]["employees"]["reason"] == "오늘 호출 상한 도달"
    with pytest.raises(jobs.ApiFailure) as e:
        world.manager.run_section(body["jobId"], "news", None, None)
    assert (e.value.status, e.value.code) == (409, "conflict")


def test_model_failure_then_run_unavailable_section_again(world):
    world.fail_models = True
    status, body = world.manager.start("가나다테크", CRNO, None, False)
    v = wait_idle(world.manager, body["jobId"])
    check_contract(v)
    s = v["sections"]
    assert (s["profile"]["status"], s["profile"]["error"]["code"], s["profile"]["error"]["source"]) == ("unavailable", "upstream_error", "Liner")
    assert s["profile"]["retryable"] and s["profile"]["paid"]["model"] == 2  # 500 → 자동 재시도 1회도 센다
    assert s["news"]["status"] == "partial" and s["news"]["result"]["events"] == [] and s["news"]["result"]["articles"]
    assert s["funding_history"]["status"] == "done" and s["facts"]["status"] == "done"
    m = v["merged"]
    assert m["techKeywords"] == [] and m["fundField"]["status"] == "unavailable" and not s["papers"]["retryable"]
    with pytest.raises(jobs.ApiFailure) as e:
        world.manager.run_section(body["jobId"], "papers", None, None)
    assert e.value.code == "section_not_ready"
    world.fail_models = False
    world.manager.run_section(body["jobId"], "profile", None, None)  # 결과 없는 단락: rerun 없이 단락 자체가 running → 끝 상태
    mid = world.manager.get(body["jobId"]).view()
    assert mid["sections"]["profile"]["rerun"] is None and mid["sections"]["profile"]["status"] in ("running", "done")
    after = wait_idle(world.manager, body["jobId"])
    check_contract(after)
    p = after["sections"]["profile"]
    assert p["status"] == "done" and p["paid"]["model"] == 3 and p["paid"]["search"] == 3  # 검색은 캐시(같은 작업, 새로 분석 아님)
    assert after["merged"]["techKeywords"] and after["sections"]["papers"]["retryable"]
    assert after["sections"]["news"]["status"] == "partial"  # 뒤 단락은 자동으로 다시 하지 않는다


def test_profile_dependents_run_together_and_unexpected_error_stays_in_its_section(world, monkeypatch):
    """profile 뒤 세 단락(funding_history·news·patents)은 함께 돌고, 단락 안의 예상하지 못한 오류는 그 단락만 미확보로 끝낸다.
    오류 글(예외 내용·키)은 응답과 스냅샷에 넣지 않는다. 팀원의 통합 분석 프로토타입(커밋 98d8c6c)의 병렬 실행·실패 격리 시험을 옮긴 것."""
    together = threading.Barrier(3, timeout=10)  # 셋이 동시에 돌지 않으면 시간 초과 → 그 단락이 미확보가 되어 아래 검사에서 걸린다
    orig = dict(sections.RUNNERS)

    def runner(key: str, fail: bool):
        def run(ctx):
            together.wait()
            if fail:
                raise RuntimeError(f"{key} down {LINER_KEY}")
            return orig[key](ctx)
        return run
    for key, fail in (("funding_history", True), ("news", False), ("patents", True)):
        monkeypatch.setitem(sections.RUNNERS, key, runner(key, fail))
    v = run_full(world)
    check_contract(v)
    s = v["sections"]
    assert v["status"] == "done" and s["news"]["status"] == "done" and s["news"]["result"]["articles"]
    assert all(s[k]["status"] == "done" for k in ("identity", "official", "profile", "facts"))
    for key in ("funding_history", "patents"):
        assert (s[key]["status"], s[key]["error"]["code"], s[key]["retryable"]) == ("unavailable", "upstream_error", True)
        assert s[key]["error"]["message"] == "이 단락의 자료를 처리하지 못했습니다." and s[key]["result"] is None
    saved = world.manager.store.path_of(v["jobId"]).read_text(encoding="utf-8")
    for text in (json.dumps(v, ensure_ascii=False), saved):
        assert " down " not in text and LINER_KEY not in text
    m = v["merged"]
    assert m["patentCount"] is None or m["patentCount"]["status"] == "unavailable"
    assert {i["name"] for i in m["investors"]} == {"가나다벤처스", "라마바인베스트"}  # 투자 이력 없이 facts 의 확인·보도 투자기관만


def test_free_api_daily_limit_on_demand_section(world):
    v = run_full(world)
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_DATAGOKR_G2B": "0"})
    world.manager.run_section(v["jobId"], "sales", None, ["AI 서버"])
    after = wait_idle(world.manager, v["jobId"])
    check_contract(after)
    sa = after["sections"]["sales"]
    assert sa["status"] == "unavailable" and sa["error"]["code"] == "daily_limit" and not sa["retryable"]
    assert "g2b" not in world.count  # 상한에 닿은 요청은 보내지 않았다


def test_missing_keys_end_sections_with_missing_config(world, monkeypatch):
    monkeypatch.setattr(common, "env", lambda k: "")
    monkeypatch.setattr(sections, "liner_key", lambda: (None, None))
    status, body = world.manager.start("가나다테크", CRNO, None, False)
    v = wait_idle(world.manager, body["jobId"])
    check_contract(v)
    assert {k: v["sections"][k]["error"]["code"] for k in C.BASIC_SECTIONS} == {k: "missing_config" for k in C.BASIC_SECTIONS}
    assert v["paid"]["liner"] == {"search": 0, "premium": 0, "model": 0, "scholar": 0} and world.count == {}
    with pytest.raises(jobs.ApiFailure) as e:
        world.manager.corp_search("가나다테크")
    assert (e.value.status, e.value.code) == (503, "missing_config")


def test_corp_search_and_news_page(world):
    out = world.manager.corp_search(" 가나다테크 ")
    assert out["query"] == "가나다테크" and [c["crno"] for c in out["candidates"]] == [CRNO, "1101110000002"]
    assert out["candidates"][0]["exact"] and not out["candidates"][1]["exact"] and out["candidates"][0]["snapshotAt"] is None
    # 이름이 겹치지 않으면(가나다테크 / 가나다테크놀로지) 이름 이력을 부르지 않는다
    assert "fsc_corp_crno" not in world.count and [c["formerNames"] for c in out["candidates"]] == [None, None]
    TypeAdapter(C.CorpSearchResponse).validate_python(out, strict=True)
    v = run_full(world)
    assert world.manager.corp_search("가나다테크")["candidates"][0]["snapshotAt"] == v["analyzedAt"]
    page = world.manager.news_page(v["jobId"], 0, 5, ["제품 출시"])
    TypeAdapter(C.NewsPage).validate_python(page, strict=True)
    full = world.manager.get(v["jobId"]).view(full_articles=True)["sections"]["news"]["result"]["articles"]
    pool = [a for a in full if "제품 출시" in a["categories"]]
    assert page["total"] == len(pool) and page["items"] == pool[:5] and page["categories"] == ["제품 출시"]
    with pytest.raises(jobs.ApiFailure) as e:
        world.manager.news_page("0" * 32, 0, 20, [])
    assert e.value.status == 404


# 이름·대표가 같은 두 번째 법인(설립일·사업자번호·건물 주소가 다름). 합병 때 존속법인이 '라마바코리아'였고 이름만 바꾼 경우
TWIN = "1101110000003"
TWIN_CORP = {"crno": TWIN, "bzno": "3234567890", "corpNm": "가나다테크 주식회사", "corpEnsnNm": "GANADA TECH Inc.", "enpRprFnm": "홍길동",
             "enpEstbDt": "20220104", "enpBsadr": "서울특별시 강남구 예시로 456 (예시동, 가나다타워) 8층", "lastOpegDt": "20261121"}


def _rec(crno: str, name: str, first: str, last: str, en: str = "GANADA TECH Inc.") -> dict:
    return {"crno": crno, "corpNm": name, "corpEnsnNm": en, "fstOpegDt": first, "lastOpegDt": last}


HISTORY = {  # 법인등록번호 조회 기록(금융위 응답처럼 순서가 섞여 있고, 하루짜리 기록과 표기만 다른 기록이 끼어 있다)
    TWIN: [_rec(TWIN, "가나다테크 주식회사", "20260803", "20261121"), _rec(TWIN, "가나다테크 주식회사", "20250310", "20260802"),
           _rec(TWIN, "가나다테크 주식회사", "20260101", "20260101"), _rec(TWIN, "가나다테크(주)", "20251008", "20251014", "GANADA TECH INC."),
           _rec(TWIN, "가나다테크 주식회사", "20241211", "20250309"),
           _rec(TWIN, "주식회사 라마바코리아", "20241210", "20241210"),  # 영문명만 하루 먼저 바뀐 기록(영문명 변경은 쓰지 않는다)
           _rec(TWIN, "주식회사 라마바코리아", "20230301", "20241209", "RAMABA Korea Inc."),
           _rec(TWIN, "주식회사 라마바코리아", "20220111", "20230228", "RAMABA Korea Inc.")],
    CRNO: [_rec(CRNO, "주식회사 가나다테크", "20230417", "20261121"), _rec(CRNO, "가나다테크(주)", "20220524", "20251014", "GANADA TECH INC."),
           _rec(CRNO, "주식회사 가나다테크", "20260101", "20260101")],
}


def test_corp_search_adds_former_names_only_to_same_name_candidates(world):
    world.corps, world.history = CORPS + [TWIN_CORP], HISTORY
    out = world.manager.corp_search("가나다테크")
    TypeAdapter(C.CorpSearchResponse).validate_python(out, strict=True)
    by = {c["crno"]: c for c in out["candidates"]}
    assert by[TWIN]["formerNames"] == [{"name": "주식회사 라마바코리아", "changedOn": "2024-12-11"}]  # 지금 이름 기록이 처음 시작한 날
    assert by[CRNO]["formerNames"] == []                 # "(주)"·"주식회사" 표기 차이만 있다 → 이전 이름 아님
    assert by["1101110000002"]["formerNames"] is None    # 가나다테크놀로지: 이름이 겹치지 않아 조회하지 않음
    assert world.count["fsc_corp_crno"] == 2
    # 추가 조회도 금융위 기업정보 하루 사용량에 센다
    assert L.usage_today()["apis"][L.DATAGOKR_FSC_CORP]["used"] == world.count["fsc_corp"] + 2
    world.manager.corp_search("가나다테크")  # 같은 요청은 캐시(24시간): 다시 부르지 않는다
    assert world.count["fsc_corp_crno"] == 2


def test_corp_search_succeeds_when_former_name_lookup_fails(world):
    world.corps, world.history, world.history_status = CORPS + [TWIN_CORP], HISTORY, 503
    out = world.manager.corp_search("가나다테크")
    TypeAdapter(C.CorpSearchResponse).validate_python(out, strict=True)
    assert len(out["candidates"]) == 3 and all(c["formerNames"] is None for c in out["candidates"])  # 모름(null)
    assert world.count["fsc_corp_crno"] == 4  # 후보 2곳 × (첫 시도 + 재시도 1회)


def test_corp_search_succeeds_when_daily_limit_blocks_former_names(world):
    L._reset_for_tests({"GROWTH_DAILY_LIMIT_DATAGOKR_FSC_CORP": "1"})  # 회사명 조회 1회만 남김
    world.corps, world.history = CORPS + [TWIN_CORP], HISTORY
    out = world.manager.corp_search("가나다테크")
    assert len(out["candidates"]) == 3 and all(c["formerNames"] is None for c in out["candidates"])
    assert "fsc_corp_crno" not in world.count and L.usage_today()["apis"][L.DATAGOKR_FSC_CORP]["used"] == 1


def test_corp_search_former_names_cap_per_search(world, monkeypatch):
    monkeypatch.setattr(public_data, "HISTORY_CALLS_PER_SEARCH", 1)
    world.corps, world.history = CORPS + [TWIN_CORP], HISTORY
    out = world.manager.corp_search("가나다테크")
    got = [c["formerNames"] for c in out["candidates"] if c["crno"] in (TWIN, CRNO)]
    assert world.count["fsc_corp_crno"] == 1 and got.count(None) == 1  # 상한을 넘는 후보는 모름(null)


def test_old_snapshot_without_former_names_still_reads(world, tmp_path):
    """formerNames 가 생기기 전에 저장한 스냅샷: 그대로 읽히고, 응답은 계약 모양(null 로 채움)이며 파일은 다시 쓰지 않는다."""
    v = run_full(world)
    path = world.manager.store.path_of(v["jobId"])
    d = json.loads(path.read_text(encoding="utf-8"))
    ident = d["sections"]["identity"]["result"]
    for c in [ident["corp"], *ident["otherCorps"]]:
        c.pop("formerNames")
    old = tmp_path / "old" / d["companyId"] / path.name
    old.parent.mkdir(parents=True)
    text = json.dumps(d, ensure_ascii=False)
    old.write_text(text, encoding="utf-8")
    m = jobs.Manager(Store(tmp_path / "old"))
    got = m.company_analysis(d["companyId"])
    check_contract(got)
    assert got["sections"]["identity"]["result"]["corp"]["formerNames"] is None
    assert old.read_text(encoding="utf-8") == text


# ---------------------------------------------------------------- 경쟁사 원문 링크 기록(계약 8.9)

def run_rivals(w: World) -> dict:
    v = run_full(w)
    w.manager.run_section(v["jobId"], "rivals_deep", [{"key": "rival:마바사에이아이", "name": "마바사", "nameEn": "Mabasa", "crno": None}], None)
    after = wait_idle(w.manager, v["jobId"])
    check_contract(after)
    return after


def test_rivals_deep_records_confirmed_patent_items(world):
    """출원인이 원문에서 경쟁사로 확인된 특허만 낱건으로 남고(언급 문서는 빠짐), 건수 칸과 맞으며, 주소는 연 원문 주소다."""
    r0 = run_rivals(world)["sections"]["rivals_deep"]["result"]["rivals"][0]
    pt = r0["patents"]
    assert pt["items"] == [{"id": "10-2023-0000002", "title": "추론 칩 메모리 배치", "assignee": "주식회사 마바사에이아이",
                            "applicationNo": "10-2023-0000002", "filingDate": "2023-05-05", "publicationNo": "KR20240000002A",
                            "registrationNo": "KR102000002B1", "url": "https://patents.google.com/patent/KR102000002B1/ko"}]
    assert pt["total"] == len(pt["items"]) and pt["registered"] == sum(1 for p in pt["items"] if p["registrationNo"])
    assert pt["byYear"] == {"2023": 1}
    assert sections.RIVAL_PATENT_ITEMS == L.PATENT_PAGES_PER_COMPANY == 30  # 원문 확인 상한과 같아 확인된 특허가 잘리지 않는다


def test_rivals_deep_runs_rivals_together_keeps_order_and_isolates_one_failure(world, monkeypatch):
    """경쟁사 여러 곳은 함께 모으고, 결과는 고른 순서대로 두며, 한 곳의 실패는 그 경쟁사에만 남는다(자료가 섞이지 않음).
    팀원의 통합 분석 프로토타입(커밋 98d8c6c)의 경쟁사 병렬 수집 시험을 옮긴 것."""
    v = run_full(world)
    orig = news.collect
    together = threading.Barrier(2, timeout=10)  # 두 경쟁사의 뉴스 수집이 동시에 돌지 않으면 시간 초과
    threads = set()

    def collect(name, *a, **k):
        threads.add(threading.current_thread().name)
        together.wait()
        if name == "고장":
            raise RuntimeError("뉴스 API 오류")
        return orig(name, *a, **k)
    monkeypatch.setattr(news, "collect", collect)
    picks = [{"key": "rival:마바사에이아이", "name": "마바사", "nameEn": "Mabasa", "crno": None},
             {"key": "rival:고장", "name": "고장", "nameEn": "", "crno": None}]
    world.manager.run_section(v["jobId"], "rivals_deep", picks, None)
    after = wait_idle(world.manager, v["jobId"])
    check_contract(after)
    rd = after["sections"]["rivals_deep"]
    assert rd["status"] == "done" and rd["result"]["rivalSet"] == ["rival:마바사에이아이", "rival:고장"]
    a, b = rd["result"]["rivals"]
    assert (a["name"], b["name"]) == ("마바사", "고장")  # 고른 순서 그대로
    assert a["corp"]["crno"] == "1101110000005" and a["summary"]["business"] == "마바사는 칩을 만든다." and a["patents"]["total"] == 1
    assert "경쟁사 뉴스를 받지 못했습니다." in b["errors"] and "경쟁사 뉴스를 받지 못했습니다." not in a["errors"]
    assert b["corp"] is None and b["summary"] is None and b["patents"]["total"] == 0  # 다른 경쟁사 자료가 섞이지 않는다
    assert len(threads) == 2 and all(t.startswith("rival") for t in threads)


def test_rivals_deep_records_articles_given_to_summary_model(world):
    """요약에 넘긴 기사 목록이 그대로(같은 순서·같은 수) 남고, 주소는 받은 http·https 주소뿐이며 발췌 글(키가 섞일 수 있음)은 남기지 않는다."""
    after = run_rivals(world)
    r0 = after["sections"]["rivals_deep"]["result"]["rivals"][0]
    inputs = r0["summary"]["inputArticles"]
    assert r0["summary"]["business"] == "마바사는 칩을 만든다." and 1 <= len(inputs) <= sections.RIVAL_SUMMARY_ARTICLES
    prompt = world.prompts["rival_summary"]
    assert prompt.count("\n- (") == len(inputs)  # 넘긴 기사 줄 수와 같다(경쟁사 한 곳)
    at = [prompt.index(f") {a['title']} — ") for a in inputs]
    assert at == sorted(at)  # 넘긴 순서 그대로
    assert all(a["url"].startswith("https://example.com/news/") and a["naverUrl"].startswith("https://example.com/naver/") for a in inputs)
    assert all(set(a) == {"title", "url", "naverUrl", "date", "outlet"} and a["date"] and a["outlet"] for a in inputs)
    saved = world.manager.store.path_of(after["jobId"]).read_text(encoding="utf-8")
    assert DATA_KEY not in saved and '"inputArticles":[{' in saved and '"items":[{' in saved  # 키 지우기를 거쳐 파일에 남는다


def test_rival_link_helpers_keep_only_web_urls():
    """받은 주소만 옮기고 http·https 가 아닌 주소(javascript:, ftp:, 상대 주소, 빈 글, 없음)는 null 이다. 값을 만들어 내지 않는다."""
    bad = ["javascript:alert(1)", "ftp://example.com/a", "//example.com/a", "/news/1", "", None, 123]
    arts = [{"title": f"기사 {i}", "url": u, "naver_url": u, "date": "", "매체": "  "} for i, u in enumerate(bad)]
    arts.append({"title": "<b>평문</b>", "url": "http://example.com/ok", "naver_url": "https://example.com/naver/ok", "date": "2026-11-01",
                 "매체": "가나다일보", "description": "발췌 serviceKey=xxx"})
    out = sections.summary_inputs(arts)
    assert [(a["url"], a["naverUrl"], a["date"], a["outlet"]) for a in out[:-1]] == [(None, None, None, None)] * len(bad)
    assert out[-1] == {"title": "<b>평문</b>", "url": "http://example.com/ok", "naverUrl": "https://example.com/naver/ok",
                       "date": "2026-11-01", "outlet": "가나다일보"}
    rows = [{"news": {"articles": [{"title": str(i)} for i in range(40)]}}, {"news": None}, {}]
    assert [len(sections.summary_articles(r)) for r in rows] == [sections.RIVAL_SUMMARY_ARTICLES, 0, 0]
    pats = [{"pub_no": f"KR10200000{i:02d}B1", "title": f"특허 {i}", "application_no": "", "url": u}
            for i, u in enumerate(["javascript:alert(1)", "https://patents.google.com/patent/KR1020000001B1/ko", ""])]
    items = sections.rival_patent_items(pats)
    assert [p["url"] for p in items] == [None, "https://patents.google.com/patent/KR1020000001B1/ko", None]
    assert items[0]["id"] == "KR1020000000B1" and items[0]["applicationNo"] is None and items[0]["assignee"] is None
    many = [{"pub_no": f"KR{i:011d}B1", "title": "t", "url": ""} for i in range(sections.RIVAL_PATENT_ITEMS + 5)]
    assert len(sections.rival_patent_items(many)) == sections.RIVAL_PATENT_ITEMS


def test_old_snapshot_without_rival_links_still_reads(world, tmp_path):
    """원문 링크 칸(patents.items, summary.inputArticles)이 생기기 전에 저장한 경쟁사 비교 자료: 그대로 읽히고, 응답은 계약 모양
    (null = 기록 없음)이며 파일은 다시 쓰지 않는다. 예전 값(건수·요약 글)은 바뀌지 않는다."""
    after = run_rivals(world)
    path = world.manager.store.path_of(after["jobId"])
    d = json.loads(path.read_text(encoding="utf-8"))
    r0 = d["sections"]["rivals_deep"]["result"]["rivals"][0]
    r0["patents"].pop("items")
    r0["summary"].pop("inputArticles")
    old = tmp_path / "old" / d["companyId"] / path.name
    old.parent.mkdir(parents=True)
    text = json.dumps(d, ensure_ascii=False)
    old.write_text(text, encoding="utf-8")
    got = jobs.Manager(Store(tmp_path / "old")).company_analysis(d["companyId"])
    check_contract(got)
    g0 = got["sections"]["rivals_deep"]["result"]["rivals"][0]
    assert g0["patents"]["items"] is None and g0["summary"]["inputArticles"] is None
    assert g0["patents"]["total"] == r0["patents"]["total"] == 1 and g0["summary"]["business"] == r0["summary"]["business"]
    assert old.read_text(encoding="utf-8") == text


def test_endpoints_return_contract_bodies(world, monkeypatch):
    from fastapi.testclient import TestClient
    import api.analysis as A
    import api.main as api_main
    monkeypatch.setattr(A, "manager", world.manager)
    client = TestClient(api_main.app)
    r = client.post("/api/analysis", json={"name": "주식회사 가나다테크", "crno": CRNO, "homepage": "example.com"})
    assert r.status_code == 202
    jid = r.json()["jobId"]
    assert A.running_count() in (0, 1)
    wait_idle(world.manager, jid)
    r = client.get(f"/api/analysis/{jid}")
    assert r.status_code == 200
    check_contract(r.json())
    r = client.get(f"/api/analysis/{jid}/news", params=[("offset", 0), ("limit", 3), ("category", "제품 출시"), ("category", "기타 동향")])
    assert r.status_code == 200 and len(r.json()["items"]) <= 3
    assert client.get(f"/api/company/{CRNO}/analysis").json()["jobId"] == jid
    r = client.get(f"/api/company/{CRNO}/job")
    assert r.status_code == 404 and r.json() == {"detail": "진행 중인 분석이 없습니다", "code": "not_found", "retryAt": None}
    r = client.post(f"/api/analysis/{jid}/sections/papers", json={})
    assert r.status_code == 202 and r.json() == {"jobId": jid, "key": "papers", "started": True}
    r = client.post(f"/api/analysis/{jid}/sections/sales", json={"rivals": [{"key": "rival:x", "name": "x"}]})
    assert r.status_code == 400 and r.json()["code"] == "bad_request"
    assert client.get(f"/api/analysis/{'f' * 32}").json()["code"] == "not_found"
    assert client.get("/api/example").status_code == 404
    assert client.get("/api/corp/search", params={"name": "가나다테크"}).json()["candidates"][0]["snapshotAt"]
    wait_idle(world.manager, jid)
