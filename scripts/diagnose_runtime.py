"""일회성 실행시간 진단: controller.run 을 그대로 1회 실행하면서 외부 HTTP 호출·캐시 적중·단계 경계를 기록한다.

분석 로직은 바꾸지 않는다. 실행 중에만 httpx.Client.send 와 common.cache_get 을 감싸 시간을 잰다.
기록에는 호스트·경로·상태·소요시간만 남기고 쿼리 파라미터(serviceKey 등)·헤더는 남기지 않는다.
사용: .venv/bin/python scripts/diagnose_runtime.py <기업명> [출력 JSON 경로] [--cache-dir 빈 폴더]
--cache-dir: 기존 캐시를 지우지 않고 새 빈 폴더를 캐시로 써서 '캐시 없는' 조건으로 측정한다.
병렬 실행에서는 단계 대신 스레드 이름(step_/rival_/nps_/naver_/g2b_/tech_/fh_/lookup_ 등)으로 호출 주체를 남긴다.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from research import common, controller  # noqa: E402

HOSTS = {"platform.liner.com": "Liner", "openapi.naver.com": "NAVER News", "api.openalex.org": "OpenAlex"}
T0 = time.perf_counter()
EVENTS: list[dict] = []
CACHE: list[dict] = []
STEP = {"key": "init"}
_orig_send = httpx.Client.send
_orig_cache_get = common.cache_get


def _api_name(req: httpx.Request) -> str:
    host, path = req.url.host, req.url.path
    if host == "apis.data.go.kr":
        if "GetCorpBasicInfo" in path:
            return "금융위 기업기본정보"
        if "GetFinaStatInfo" in path:
            return "금융위 요약재무제표"
        if "Nps" in path:
            return "국민연금 사업장"
        if "BidPublicInfo" in path:
            return "나라장터 입찰공고"
        return "공공데이터포털(기타)"
    if host == "platform.liner.com":
        if path.endswith("/search/web"):
            try:
                body = json.loads(req.content or b"{}")
            except ValueError:
                body = {}
            return "Liner Premium" if body.get("include_knowledge") else "Liner Web Search"
        if path.endswith("/search/scholar"):
            return "Liner Scholar"
        if "chat/completions" in path or path.endswith("/responses"):
            return "Liner Model(Router)"
        return "Liner(기타)"
    return HOSTS.get(host, f"원문 fetch/기타({host})")


def send(self, request, *a, **k):
    t = time.perf_counter()
    rec = {"step": threading.current_thread().name, "api": _api_name(request), "method": request.method, "host": request.url.host,
           "path": request.url.path[:120], "t_start": round(t - T0, 3), "thread": threading.current_thread().name}
    try:
        resp = _orig_send(self, request, *a, **k)
        rec["status"] = resp.status_code
        return resp
    except Exception as e:
        rec["status"] = None
        rec["error"] = type(e).__name__
        raise
    finally:
        rec["sec"] = round(time.perf_counter() - t, 3)
        EVENTS.append(rec)


def cache_get(kind, ident, ttl_hours):
    t = time.perf_counter()
    out = _orig_cache_get(kind, ident, ttl_hours)
    CACHE.append({"step": threading.current_thread().name, "kind": kind, "hit": out is not None, "sec": round(time.perf_counter() - t, 4)})
    return out


def main() -> None:
    args = sys.argv[1:]
    if "--cache-dir" in args:
        i = args.index("--cache-dir")
        common.CACHE_DIR = Path(args[i + 1]).resolve()
        common.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        del args[i:i + 2]
    name = args[0]
    out_path = Path(args[1]) if len(args) > 1 else Path("results/diagnostics") / f"{datetime.now():%Y%m%d_%H%M%S}_runtime.json"
    httpx.Client.send = send
    common.cache_get = cache_get
    marks, msgs = [], []
    STEP["key"] = controller.STEPS[0][0]

    def progress(m):
        msgs.append({"t": round(time.perf_counter() - T0, 2), "step": STEP["key"], "msg": common.scrub_text(m)[:160]})

    def step_done(key, status, idx):
        marks.append({"step": key, "event": "end", "status": status, "t": round(time.perf_counter() - T0, 3), "at": datetime.now().isoformat(timespec="seconds")})

    def step_start(key, idx):
        marks.append({"step": key, "event": "start", "t": round(time.perf_counter() - T0, 3), "at": datetime.now().isoformat(timespec="seconds")})

    started = datetime.now().isoformat(timespec="seconds")
    R = controller.run(name, progress=progress, step_done=step_done, step_start=step_start)
    STEP["key"] = "save"
    t = time.perf_counter()
    saved = str(controller.save(R))
    save_sec = round(time.perf_counter() - t, 3)
    httpx.Client.send = _orig_send
    common.cache_get = _orig_cache_get
    data = {"company": name, "started_at": started, "total_sec": round(time.perf_counter() - T0, 2), "controller_elapsed_sec": R.get("elapsed_sec"),
            "save_sec": save_sec, "saved_result": saved, "cache_dir": str(common.CACHE_DIR), "parallel": R.get("parallel"), "steps": R.get("steps"), "timing": R.get("timing"), "marks": marks, "progress": msgs,
            "http_events": EVENTS, "cache_lookups": CACHE, "liner_usage": R.get("liner_usage"), "liner_calls": R.get("liner_calls"),
            "liner_cache_hits": R.get("liner_cache_hits"), "errors": R.get("errors")}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=1, default=str)
    if any(s in text for s in common.secrets()):
        raise RuntimeError("진단 결과에 키 문자열이 남아 있어 저장을 중단했습니다")
    out_path.write_text(text, encoding="utf-8")
    print("DIAG", out_path)
    print("SAVED", saved)
    print("TOTAL", data["total_sec"], {k: v["sec"] for k, v in (R.get("steps") or {}).items()})


if __name__ == "__main__":
    main()
