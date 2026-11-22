"""분석 스냅샷 파일(계약 12.1절).

- 파일: results/analysis/<companyId>/<YYYYMMDD-HHMMSS>.json(작업 startedAt, 한국 시간). 내용은 AnalysisJob 과 같은 모양이고
  기사 목록만 전체가 들어 있다. 맨 앞에 "schema": "growth.analysis/1" 을 더한다(응답으로 낼 때 뺀다).
- 쓰기: 키 지우기(analysis.scrub) → 키 문자열·인증 머리글 모양이 남았는지 검사 → 임시 파일에 쓰고 os.replace(원자적 교체).
  남았으면 쓰지 않는다. 다른 작업의 파일은 건드리지 않고, 이전 스냅샷을 지우거나 덮어쓰지 않는다.
- latest.json: {"file", "jobId", "analyzedAt"}. 작업이 done 이 될 때만 바꾼다.
- results/ 는 Git 에서 제외돼 있다(제3자 기사 발췌가 들어 있다).
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

import analysis
import config
from growth import common

SCHEMA = "growth.analysis/1"
_LEAK = [re.compile(r"(?i)bearer\s+(?!\*\*\*)[A-Za-z0-9._\-]{8,}"),
         re.compile(r"(?i)x-api-key['\"]?\s*[:=]\s*['\"]?(?!\*\*\*)[A-Za-z0-9._\-]{8,}")]


class LeakError(RuntimeError):
    pass


class Store:
    def __init__(self, root: Path | None = None):
        self.root = Path(root or config.RESULTS_DIR / "analysis")
        self._lock = threading.Lock()
        self._paths: dict[str, Path] = {}   # jobId → 파일

    # ---------------- 쓰기
    def path_for(self, job_id: str, company_id: str, started_at: str) -> Path:
        with self._lock:
            p = self._paths.get(job_id)
            if p is not None:
                return p
            stamp = re.sub(r"\D", "", started_at[:19])
            base = self.root / company_id / f"{stamp[:8]}-{stamp[8:14]}.json"
            p = base
            if p.exists():  # 같은 초에 시작한 다른 작업(드묾): 덮어쓰지 않게 작업 id 를 붙인다
                p = base.with_name(f"{base.stem}-{job_id[:8]}.json")
            self._paths[job_id] = p
            return p

    @staticmethod
    def _safe_text(data: dict) -> str:
        secrets = common.secrets()
        clean = analysis.scrub(data, secrets)
        text = json.dumps(clean, ensure_ascii=False, indent=None, separators=(",", ":"), default=str)
        if any(s and s in text for s in secrets) or any(p.search(text) for p in _LEAK):
            raise LeakError("결과에 키 문자열이 남아 있어 저장하지 않았습니다")
        return text

    def _atomic(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)

    def write(self, job: dict) -> Path:
        """작업 하나를 파일 전체로 쓴다(기사 전체 포함). 키가 남으면 LeakError."""
        path = self.path_for(job["jobId"], job["companyId"], job["startedAt"])
        self._atomic(path, self._safe_text({"schema": SCHEMA, **job}))
        return path

    def write_latest(self, job: dict) -> None:
        path = self.path_for(job["jobId"], job["companyId"], job["startedAt"])
        text = self._safe_text({"file": path.name, "jobId": job["jobId"], "analyzedAt": job["analyzedAt"]})
        self._atomic(path.parent / "latest.json", text)

    # ---------------- 읽기
    @staticmethod
    def read(path: Path) -> dict | None:
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(d, dict) or d.get("schema") != SCHEMA or not d.get("jobId"):
            return None
        d.pop("schema", None)
        return d

    def scan(self) -> list[tuple[Path, dict]]:
        """results/analysis/*/*.json 을 모두 읽는다(latest.json·깨진 파일은 건너뜀)."""
        out = []
        if not self.root.is_dir():
            return out
        for p in sorted(self.root.glob("*/*.json")):
            if p.name == "latest.json":
                continue
            d = self.read(p)
            if d is None:
                continue
            with self._lock:
                self._paths[d["jobId"]] = p
            out.append((p, d))
        return out

    def path_of(self, job_id: str) -> Path | None:
        with self._lock:
            return self._paths.get(job_id)

    def latest_info(self, company_id: str) -> dict | None:
        """latest.json 의 {file, jobId, analyzedAt}. 없거나 깨졌거나 가리키는 파일이 없으면 None(그때는 폴더를 훑는다)."""
        lp = self.root / company_id / "latest.json"
        try:
            d = json.loads(lp.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(d, dict):
            return None
        name, jid = str(d.get("file") or ""), str(d.get("jobId") or "")
        if not re.fullmatch(r"[0-9A-Za-z\-]+\.json", name) or not re.fullmatch(r"[0-9a-f]{32}", jid):
            return None
        return d if (lp.parent / name).is_file() else None

    def company_files(self, company_id: str) -> list[Path]:
        d = self.root / company_id
        return sorted(p for p in d.glob("*.json") if p.name != "latest.json") if d.is_dir() else []
