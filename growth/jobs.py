"""분석 작업: 단락 10개를 순서대로·병렬로 돌리고, 봉투 상태를 관리하고, 스냅샷 파일로 남긴다(계약 2.2~2.8, 4, 5, 12절).

- 기본 단락 7개는 작업 시작과 함께 스레드로 돈다. identity·facts 는 바로, official·profile 은 identity 뒤,
  funding_history·news·patents 는 profile 뒤(contract.DEPENDS_ON). 앞 단락이 미확보로 끝나도 뒤 단락은 시작한다.
- 열 때 실행 단락(papers, rivals_deep, sales)과 단락 다시 실행은 POST /api/analysis/{jobId}/sections/{key} 로 같은 작업 안에서 한다.
- 단락마다 growth.limits 예산을 잡는다. 하루 상한이 모자라면 그 단락만 unavailable(daily_limit).
- 작업 상태는 메모리 + 파일(results/analysis/…)이다. 상태가 바뀔 때마다 파일 전체를 원자적으로 다시 쓴다.
"""
from __future__ import annotations

import copy
import logging
import os
import threading
import uuid
from datetime import datetime

import analysis
from growth import common, limits, merge, public_data, sections
from growth.contract import BASIC_SECTIONS, CONTRACT_VERSION, DEPENDS_ON, ESTIMATES, EXPECTED_SECONDS, NEWS_CATEGORIES, \
    ON_DEMAND_SECTIONS, SECTION_KEYS, TERMINAL_SECTION_STATUSES, company_id_for
from growth.limits import KST
from growth.store import LeakError, Store

log = logging.getLogger("growth")
ZERO = {"search": 0, "premium": 0, "model": 0, "scholar": 0}
EXAMPLE_ENV = "GROWTH_EXAMPLE_COMPANY_ID"
RUN_STAGE = {"identity": "법인 찾기", "facts": "보도·공식 자료 검색"}
NO_RETRY_CODES = ("daily_limit", "no_corp", "missing_config")
ARTICLES_IN_JOB = 20


class ApiFailure(Exception):
    """엔드포인트가 계약 3절 오류 본문으로 바꿔 돌려줄 실패."""

    def __init__(self, status: int, code: str, detail: str, retry_at: str | None = None):
        super().__init__(detail)
        self.status, self.code, self.detail, self.retry_at = status, code, detail, retry_at


def _envelope(key: str, status: str, started_at: str | None) -> dict:
    return {"key": key, "status": status, "stage": RUN_STAGE.get(key) if status == "running" else None, "startedAt": started_at,
            "seconds": None, "expectedSeconds": EXPECTED_SECONDS[key], "analyzedAt": None, "result": None, "error": None,
            "retryable": False, "waitingFor": [], "rerun": None, "paid": dict(ZERO)}


def _secs(start: str | None, end: datetime) -> float | None:
    s = common.parse_iso(start)
    return round(max(0.0, (end - s).total_seconds()), 1) if s else None


def example_id() -> str:
    """예시 회사 id. 환경변수 → 저장소 루트 .env 순서로 읽는다(실제 회사 id 라 저장소에는 적지 않는다)."""
    return (os.environ.get(EXAMPLE_ENV) or common.env(EXAMPLE_ENV) or "").strip()


class Job:
    def __init__(self, manager: "Manager", data: dict, *, homepage: str = "", fresh: bool = False):
        self.m = manager
        self.data = data
        self.homepage = homepage
        self.fresh = fresh
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.save_lock = threading.Lock()
        self._latest_written: str | None = None
        self.version = 0            # 상태가 바뀔 때마다 1씩(잠금 안에서 touch())
        self.saved_version = -1     # 파일에 쓴 마지막 상태

    def touch(self) -> None:
        """상태가 바뀌었음을 남긴다. self.lock 을 잡은 채로 부른다."""
        self.version += 1

    def flushed(self) -> bool:
        """지금 상태가 파일에 쓰였는가(쓰기를 시도했는가)."""
        with self.lock:
            return self.saved_version >= self.version

    # ---------------- 읽기(단락 실행이 부른다)
    @property
    def job_id(self) -> str:
        return self.data["jobId"]

    @property
    def company_id(self) -> str:
        return self.data["companyId"]

    @property
    def query(self) -> str:
        return self.data["query"]

    @property
    def crno(self) -> str | None:
        return self.data["company"]["crno"]

    def section(self, key: str) -> dict:
        with self.lock:
            return dict(self.data["sections"][key])

    def result(self, key: str) -> dict | None:
        with self.lock:
            return self.data["sections"][key]["result"]

    def terminal(self, key: str) -> bool:
        with self.lock:
            return self.data["sections"][key]["status"] in TERMINAL_SECTION_STATUSES

    def wait_terminal(self, key: str, timeout: float | None) -> bool:
        with self.cond:
            return self.cond.wait_for(lambda: self.data["sections"][key]["status"] in TERMINAL_SECTION_STATUSES, timeout)

    def set_stage(self, key: str, text: str) -> None:
        with self.lock:
            env = self.data["sections"][key]
            if env["status"] == "running":
                env["stage"] = text

    def snapshot_at(self, crno: str) -> str | None:
        return self.m.snapshot_at(crno)

    def merged_rivals(self) -> list[dict]:
        return self.view()["merged"]["rivals"]

    # ---------------- 응답 모양
    def view(self, *, full_articles: bool = False) -> dict:
        """AnalysisJob(계약 4절). 경과 초·기다리는 단락·retryable·busy·merged 는 지금 시각으로 계산한다."""
        return self._view(full_articles)[0]

    def _view(self, full_articles: bool) -> tuple[dict, int]:
        with self.lock:
            d = copy.deepcopy(self.data)
            version = self.version
        now = common.now()
        ex = self.m.is_example(d["companyId"])
        secs = d["sections"]
        for key, env in secs.items():
            if env["status"] in ("running", "waiting"):
                env["seconds"] = _secs(env["startedAt"], now)
            rr = env.get("rerun")
            if rr and rr["status"] == "running":
                rr["seconds"] = _secs(rr["startedAt"], now)
            env["waitingFor"] = ([dep for dep in DEPENDS_ON[key] if secs[dep]["status"] not in TERMINAL_SECTION_STATUSES]
                                 if env["status"] in ("waiting", "idle") else [])
        m = merge.merged(secs, query=d["query"], crno=d["company"]["crno"], job_running=d["status"] == "running")
        for key, env in secs.items():
            env["retryable"] = retryable(key, env, secs, m, ex)
            if env["status"] != "running":  # stage 는 running 일 때만(계약 5.1절)
                env["stage"] = None
        d["merged"] = m
        d["isExample"] = ex
        d["busy"] = (d["status"] == "running" or any(e["status"] in ("waiting", "running") for e in secs.values())
                     or any((e.get("rerun") or {}).get("status") == "running" for e in secs.values()))
        d["paid"] = {"liner": {k: sum(e["paid"][k] for e in secs.values()) for k in ZERO}}
        d["estimates"] = copy.deepcopy(ESTIMATES)
        d["refresh"] = {"remainingToday": 0 if ex else limits.refresh_remaining(d["companyId"]),
                        "limitPerDay": limits.REFRESH_PER_COMPANY_PER_DAY}
        news = secs["news"]["result"]
        if news and not full_articles:
            news["articles"] = news["articles"][:ARTICLES_IN_JOB]
        return d, version

    def save(self) -> None:
        """파일 전체를 다시 쓴다. 키가 남아 있으면 쓰지 않고 기록만 한다."""
        with self.save_lock:
            v, version = self._view(True)
            try:
                self._write(v)
            finally:
                with self.lock:
                    self.saved_version = max(self.saved_version, version)

    def _write(self, v: dict) -> None:
        try:
            self.m.store.write(v)
        except LeakError:
            log.error("분석 스냅샷에 키 문자열이 남아 저장하지 않았습니다(작업 %s)", self.job_id)
            return
        except OSError as e:
            log.error("분석 스냅샷을 쓰지 못했습니다(작업 %s): %s", self.job_id, type(e).__name__)
            return
        if v["status"] == "done" and self._latest_written != v["analyzedAt"]:
            try:
                self.m.store.write_latest(v)
                self._latest_written = v["analyzedAt"]
            except (LeakError, OSError):
                log.error("latest.json 을 쓰지 못했습니다(작업 %s)", self.job_id)


def retryable(key: str, env: dict, secs: dict, merged: dict, is_example: bool) -> bool:
    """POST …/sections/{key} 를 지금 받아 주는가(계약 2.4절 표, 5.5절)."""
    if is_example and key != "sales":
        return False
    st = env["status"]
    if st in ("waiting", "running") or (env.get("rerun") or {}).get("status") == "running":
        return False
    err = env.get("error") or {}
    code = err.get("code")
    if key in ON_DEMAND_SECTIONS and code == "daily_limit":
        # 5.3절: daily_limit 이면 retryable false. 열 때 실행 단락은 '언제나'(2.4절)라서 다음 날 0시(retryAt)가 지나면 다시 받는다
        reset = common.parse_iso(err.get("retryAt"))
        if reset is None or common.now() < reset:
            return False
    if key == "papers":
        return secs["profile"]["status"] in TERMINAL_SECTION_STATUSES and bool(merged["techKeywords"])
    if key in ("rivals_deep", "sales"):
        return True
    if key == "news":
        return not (st == "unavailable" and code in ("daily_limit", "missing_config"))
    return st in ("partial", "unavailable") and code not in NO_RETRY_CODES


class Manager:
    """서버 전체 작업 목록. api/analysis.py 가 하나만 만들어 쓴다."""

    def __init__(self, store: Store | None = None):
        self.store = store or Store()
        self.lock = threading.RLock()
        self.jobs: dict[str, Job] = {}       # 메모리에 있는 작업(진행 중 + 읽어 온 것)
        self.meta: dict[str, dict] = {}      # jobId → {companyId, status, startedAt, analyzedAt, name}
        self._loaded = False

    # ---------------- 시작할 때 파일에서 되살리기(12.1)
    def ensure_loaded(self) -> None:
        with self.lock:
            if self._loaded:
                return
            self._loaded = True
            for path, d in self.store.scan():
                changed = _interrupt(d, path)
                if changed:
                    try:
                        self.store.write(d)
                    except (LeakError, OSError):
                        log.error("되살린 스냅샷을 다시 쓰지 못했습니다(%s)", path.name)
                self.note(d)

    def note(self, d: dict) -> None:
        with self.lock:
            self.meta[d["jobId"]] = {"companyId": d["companyId"], "status": d["status"], "startedAt": d["startedAt"],
                                     "analyzedAt": d.get("analyzedAt"), "name": d["company"]["name"]}

    def get(self, job_id: str) -> Job | None:
        self.ensure_loaded()
        with self.lock:
            job = self.jobs.get(job_id)
            if job is not None:
                return job
            path = self.store.path_of(job_id)
        d = self.store.read(path) if path else None
        if d is None:
            return None
        _interrupt(d, path)
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                job = self.jobs[job_id] = Job(self, d)
            return job

    def is_example(self, company_id: str) -> bool:
        return bool(company_id) and company_id == example_id()

    def _latest(self, company_id: str, statuses: tuple[str, ...]) -> str | None:
        with self.lock:
            rows = [(m.get("analyzedAt") or m["startedAt"], jid) for jid, m in self.meta.items()
                    if m["companyId"] == company_id and m["status"] in statuses]
        return max(rows)[1] if rows else None

    def saved_job_id(self, company_id: str) -> str | None:
        """2.6절: done 중 가장 최근, 없으면 interrupted 중 가장 최근. latest.json 을 먼저 본다."""
        self.ensure_loaded()
        info = self.store.latest_info(company_id)
        if info is not None:
            with self.lock:
                m = self.meta.get(info["jobId"])
            if m and m["status"] == "done" and m["companyId"] == company_id:
                return info["jobId"]
        return self._latest(company_id, ("done",)) or self._latest(company_id, ("interrupted",))

    def snapshot_at(self, crno: str) -> str | None:
        self.ensure_loaded()
        jid = self._latest(crno, ("done",))
        return self.meta[jid]["analyzedAt"] if jid else None

    def _running(self) -> list[Job]:
        """진행 중 작업. 상태는 목록(meta)으로 본다: 작업 상태와 목록은 같은 잠금 순서로 함께 바뀐다."""
        with self.lock:
            return [j for jid, j in self.jobs.items() if (self.meta.get(jid) or {}).get("status") == "running"]

    def running_for(self, company_id: str) -> Job | None:
        return next((j for j in self._running() if j.company_id == company_id), None)

    def running_count(self) -> int:
        return len(self._running())

    # ---------------- POST /api/analysis (2.2)
    def start(self, name: str, crno: str | None, homepage: str | None, refresh: bool) -> tuple[int, dict]:
        self.ensure_loaded()
        name = (name or "").strip()
        try:
            cid = company_id_for(name, crno)
        except ValueError:
            raise ApiFailure(400, "bad_request", "회사 이름을 확인해 주세요") from None
        crno = cid if crno and cid == crno else None
        with self.lock:
            running = self.running_for(cid)
            if running:
                return 200, {"jobId": running.job_id, "companyId": cid, "started": False}
            if not refresh:
                saved = self.saved_job_id(cid)
                if saved:
                    return 200, {"jobId": saved, "companyId": cid, "started": False}
            if refresh and self.is_example(cid):
                raise ApiFailure(409, "example_readonly", "예시 회사는 새로 분석할 수 없습니다")
            if self.running_count() >= limits.MAX_RUNNING_ANALYSES:
                raise ApiFailure(429, "busy", "다른 분석이 진행 중입니다. 잠시 뒤 다시 시도해 주세요.")
            if refresh:
                try:
                    limits.take_refresh(cid)
                except limits.LimitReached as e:
                    raise ApiFailure(429, "refresh_limit", e.message, e.retry_at_iso) from None
            job = self._new_job(name, cid, crno, homepage or "", fresh=refresh)
        job.save()
        threading.Thread(target=self._run_basic, args=(job,), daemon=True, name=f"job-{job.job_id[:8]}").start()
        return 202, {"jobId": job.job_id, "companyId": cid, "started": True}

    def _new_job(self, name: str, cid: str, crno: str | None, homepage: str, *, fresh: bool) -> Job:
        t0 = common.now()
        started = common.iso(t0)
        secs = {}
        for key in SECTION_KEYS:
            if key in BASIC_SECTIONS:
                secs[key] = _envelope(key, "waiting" if DEPENDS_ON[key] else "running", started)
            else:
                secs[key] = _envelope(key, "idle", None)
        data = {"contractVersion": CONTRACT_VERSION, "jobId": uuid.uuid4().hex, "companyId": cid, "query": name,
                "company": {"name": name, "crno": crno}, "status": "running", "busy": True, "startedAt": started,
                "analyzedAt": None, "isExample": False, "sections": secs, "merged": None, "paid": {"liner": dict(ZERO)},
                "estimates": copy.deepcopy(ESTIMATES), "refresh": {"remainingToday": 0, "limitPerDay": limits.REFRESH_PER_COMPANY_PER_DAY}}
        job = Job(self, data, homepage=homepage, fresh=fresh)
        self.jobs[job.job_id] = job
        self.note(data)
        return job

    def _run_basic(self, job: Job) -> None:
        threads = [threading.Thread(target=self._basic_section, args=(job, key), daemon=True, name=f"{key}-{job.job_id[:6]}")
                   for key in BASIC_SECTIONS]
        for t in threads:
            t.start()

    def _basic_section(self, job: Job, key: str) -> None:
        deps = DEPENDS_ON[key]
        with job.cond:
            job.cond.wait_for(lambda: all(job.data["sections"][d]["status"] in TERMINAL_SECTION_STATUSES for d in deps))
            env = job.data["sections"][key]
            env["status"], env["stage"] = "running", RUN_STAGE.get(key)
            if deps:
                job.touch()
        if deps:
            job.save()
        started = common.parse_iso(job.data["startedAt"]) or common.now()
        try:
            budget = limits.reserve_section(key)
        except limits.LimitReached as e:
            self._finish(job, key, sections.unavailable(sections.limit_error(e)), dict(ZERO), mode="first", started=started)
            return
        self._execute(job, key, budget, mode="first", started=started, fresh=job.fresh)

    def _execute(self, job: Job, key: str, budget: limits.SectionBudget, *, mode: str, started: datetime, fresh: bool,
                 body: dict | None = None) -> None:
        ctx = sections.RunCtx(job, key, budget, fresh=fresh, body=body)
        outcome: dict
        try:
            outcome = sections.RUNNERS[key](ctx)
        except Exception as e:  # 예상하지 못한 오류: 단락만 미확보로 끝내고 내용은 응답에 넣지 않는다
            log.error("단락 %s 실행 중 오류: %s", key, common.scrub_text(f"{type(e).__name__}: {str(e)[:200]}"))
            outcome = sections.unavailable(sections.error("upstream_error", "이 단락의 자료를 처리하지 못했습니다."))
        try:
            paid = ctx.settle()
        except Exception as e:  # 확정에 실패해도 단락 상태는 끝낸다
            log.error("단락 %s 사용량 확정 오류: %s", key, type(e).__name__)
            paid = dict(ZERO)
        self._finish(job, key, outcome, paid, mode=mode, started=started)

    def _finish(self, job: Job, key: str, outcome: dict, paid: dict, *, mode: str, started: datetime) -> None:
        now = common.now()
        if outcome.get("result") is not None:  # 바깥 자료에 키 문자열이 섞여 있어도 응답·파일에 남지 않게 한 번 지운다
            outcome = {**outcome, "result": analysis.scrub(outcome["result"], common.secrets())}
        with job.cond:
            env = job.data["sections"][key]
            env["paid"] = {k: env["paid"].get(k, 0) + int(paid.get(k, 0)) for k in ZERO}
            secs = round(max(0.0, (now - started).total_seconds()), 1)
            if mode == "rerun":
                if outcome["status"] in ("done", "partial"):
                    env.update(status=outcome["status"], result=outcome["result"], error=outcome["error"], startedAt=common.iso(started),
                               seconds=secs, analyzedAt=common.iso(now), stage=None, rerun=None)
                else:
                    env["rerun"] = {"status": "failed", "startedAt": common.iso(started), "seconds": secs, "error": outcome["error"]}
            else:
                env.update(status=outcome["status"], result=outcome["result"], error=outcome["error"], seconds=secs,
                           analyzedAt=common.iso(now), stage=None, rerun=None)
            if key == "identity" and outcome["result"]:
                job.data["company"]["name"] = outcome["result"]["corp"]["name"]
            if job.data["status"] == "running" and all(job.data["sections"][k]["status"] in TERMINAL_SECTION_STATUSES
                                                       for k in BASIC_SECTIONS):
                job.data["status"], job.data["analyzedAt"] = "done", common.iso(now)
            job.touch()
            self.note(job.data)  # 목록(저장된 분석 찾기)도 같은 순간에 바꾼다: 끝난 직후 POST 가 새 작업을 만들지 않게
            job.cond.notify_all()
        job.save()

    # ---------------- POST /api/analysis/{jobId}/sections/{key} (2.4)
    def run_section(self, job_id: str, key: str, rivals: list[dict] | None, keywords: list[str] | None) -> dict:
        job = self.get(job_id)
        if job is None:
            raise ApiFailure(404, "not_found", "분석 작업을 찾을 수 없습니다")
        body: dict = {}
        if key == "rivals_deep":
            if not rivals or keywords is not None:
                raise ApiFailure(400, "bad_request", "경쟁사를 1~5곳 골라 주세요")
            body["rivals"] = rivals
        elif key == "sales":
            words = list(dict.fromkeys(w.strip() for w in keywords or [] if w and w.strip()))
            if not words or rivals is not None or any(len(w) > 20 for w in words):
                raise ApiFailure(400, "bad_request", "검색 낱말을 1~6개 넣어 주세요")
            body["keywords"] = words
        elif rivals is not None or keywords is not None:
            raise ApiFailure(400, "bad_request", "이 단락에는 요청 내용을 보내지 않습니다")
        if self.is_example(job.company_id) and key != "sales":
            raise ApiFailure(409, "example_readonly", "예시 회사는 이 단락을 다시 분석할 수 없습니다")
        with job.cond:
            env = job.data["sections"][key]
            st, code = env["status"], (env.get("error") or {}).get("code")
            if st in ("waiting", "running") or (env.get("rerun") or {}).get("status") == "running":
                raise ApiFailure(409, "section_running", "이 단락은 이미 실행 중입니다")
            if key == "papers":
                prof = job.data["sections"]["profile"]
                if prof["status"] not in TERMINAL_SECTION_STATUSES or not (prof["result"] or {}).get("techKeywords"):
                    raise ApiFailure(409, "section_not_ready", "논문을 찾을 기술 낱말이 아직 없습니다")
            elif key == "news":
                if st == "unavailable" and code in ("daily_limit", "missing_config"):
                    raise ApiFailure(409, "conflict", "지금은 이 단락을 다시 실행할 수 없습니다")
            elif key not in ("rivals_deep", "sales"):
                if st not in ("partial", "unavailable") or code in NO_RETRY_CODES:
                    raise ApiFailure(409, "conflict", "지금은 이 단락을 다시 실행할 수 없습니다")
            try:
                budget = limits.reserve_section(key, rivals=len(body.get("rivals") or []))
            except limits.LimitReached as e:
                raise ApiFailure(429, "daily_limit", e.message, e.retry_at_iso) from None
            started = common.now()
            mode = "rerun" if st in ("done", "partial") else "run"
            if mode == "rerun":
                env["rerun"] = {"status": "running", "startedAt": common.iso(started), "seconds": 0.0, "error": None}
            else:
                env.update(status="running", stage=None, startedAt=common.iso(started), seconds=0.0, analyzedAt=None,
                           result=None, error=None, rerun=None)
            fresh = mode == "rerun" or job.fresh
            job.touch()
        job.save()
        threading.Thread(target=self._execute, args=(job, key, budget),
                         kwargs={"mode": mode, "started": started, "fresh": fresh, "body": body}, daemon=True,
                         name=f"{key}-{job_id[:6]}").start()
        return {"jobId": job_id, "key": key, "started": True}

    # ---------------- GET /api/analysis/{jobId}/news (2.5)
    def news_page(self, job_id: str, offset: int, limit: int, categories: list[str]) -> dict:
        job = self.get(job_id)
        if job is None:
            raise ApiFailure(404, "not_found", "분석 작업을 찾을 수 없습니다")
        bad = [c for c in categories if c not in NEWS_CATEGORIES]
        if bad:
            raise ApiFailure(400, "bad_request", "모르는 기사 분류입니다")
        with job.lock:
            res = job.data["sections"]["news"]["result"]
            if res is None:
                raise ApiFailure(409, "section_not_ready", "기사 목록이 아직 없습니다")
            articles = list(res["articles"])
            counts = copy.deepcopy(res["categoryCounts"])
        cats = list(dict.fromkeys(categories))
        pool = [a for a in articles if not cats or set(a["categories"]) & set(cats)]
        return {"jobId": job_id, "offset": offset, "limit": limit, "categories": cats, "total": len(pool),
                "articleTotal": len(articles), "categoryCounts": counts, "items": copy.deepcopy(pool[offset:offset + limit])}

    # ---------------- GET /api/corp/search (2.1)
    def corp_search(self, name: str) -> dict:
        q = (name or "").strip()
        if len(q) < 2:
            raise ApiFailure(400, "bad_request", "회사 이름을 두 글자 이상 넣어 주세요")
        if not sections.has_datagokr():
            raise ApiFailure(503, "missing_config", "공공데이터 설정이 되어 있지 않습니다")
        try:
            corps = public_data.find_corps(q, use=limits.use)
        except limits.LimitReached as e:
            raise ApiFailure(429, "daily_limit", e.message, e.retry_at_iso) from None
        except public_data.MissingKey:
            raise ApiFailure(503, "missing_config", "공공데이터 설정이 되어 있지 않습니다") from None
        except public_data.PublicDataError:
            raise ApiFailure(502, "upstream_error", "금융위원회 자료에 연결하지 못했습니다") from None
        cands = [public_data.corp_contract(c, snapshot_at=self.snapshot_at(c["crno"])) for c in corps[:20]]
        return {"query": q, "candidates": cands, "queriedAt": common.iso(common.now())}

    # ---------------- GET /api/company/{id}/analysis·job, /api/example (2.6~2.8)
    def company_analysis(self, company_id: str) -> dict:
        jid = self.saved_job_id(company_id)
        job = self.get(jid) if jid else None
        if job is None:
            raise ApiFailure(404, "not_found", "저장된 분석이 없습니다")
        return job.view()

    def company_job(self, company_id: str) -> dict:
        self.ensure_loaded()
        job = self.running_for(company_id)
        if job is None:
            raise ApiFailure(404, "not_found", "진행 중인 분석이 없습니다")
        return {"jobId": job.job_id, "companyId": company_id, "startedAt": job.data["startedAt"], "status": "running"}

    def example(self) -> dict:
        self.ensure_loaded()
        cid = example_id()
        jid = self._latest(cid, ("done",)) if cid else None
        if not jid:
            raise ApiFailure(404, "not_found", "예시 회사가 없습니다")
        with self.lock:
            m = dict(self.meta[jid])
        return {"companyId": cid, "jobId": jid, "name": m["name"], "analyzedAt": m["analyzedAt"]}


def _interrupt(d: dict, path) -> bool:
    """진행 중이던 파일을 interrupted 로 바꾼다(12.1절). 진행 중이던 단락·다시 실행도 멈춘 것으로 둔다. 바꿨으면 True."""
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, KST)
    except (OSError, AttributeError):
        mtime = common.now()
    end = common.iso(mtime)
    changed = False
    msg = sections.error("interrupted")
    for env in d["sections"].values():
        if env["status"] in ("waiting", "running"):
            env.update(status="unavailable", result=None, error=dict(msg), stage=None, analyzedAt=end,
                       seconds=_secs(env["startedAt"], mtime) or 0.0, startedAt=env["startedAt"] or d["startedAt"])
            changed = True
        rr = env.get("rerun")
        if rr and rr["status"] == "running":
            env["rerun"] = {"status": "failed", "startedAt": rr["startedAt"], "seconds": _secs(rr["startedAt"], mtime),
                            "error": dict(msg)}
            changed = True
    if d["status"] == "running":
        d["status"], d["analyzedAt"], d["busy"] = "interrupted", end, False
        changed = True
    return changed
