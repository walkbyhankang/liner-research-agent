"""공고 한 건의 자격 대조를 수행한다: 공고문 → 조건 추출(공고당 한 번, 저장) → 원문 대조 → 회사와 대조."""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from funding import docs, notice
from liner_client import LinerClient, extract_chat_text

# docs/notice-analysis-results.md 의 실험에서 근거 확인율이 같고 비용이 낮았던 조합
EXTRACT_MODEL = "openai/gpt-6.2-sol"
MATCH_MODEL = "anthropic/claude-opus-5.5"
CACHE_VERSION = 1
_ID = re.compile(r"^[A-Za-z0-9_]{6,40}$")


_locks_guard = threading.Lock()
_program_locks: dict[str, threading.Lock] = {}


def _program_lock(program_id: str) -> threading.Lock:
    """공고별 잠금. 같은 공고의 추출이 동시에 들어오면 한 번만 호출하고 나머지는 저장본을 쓴다."""
    with _locks_guard:
        return _program_locks.setdefault(program_id, threading.Lock())


def _write_atomic(path: Path, text: str) -> None:
    """임시 파일에 다 쓴 뒤 이름을 바꿔, 읽는 쪽이 쓰다 만 파일을 보지 않게 한다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


class AnalysisError(Exception):
    pass


def _cache_path(cache_dir: Path, program_id: str) -> Path:
    if not _ID.fullmatch(program_id):
        raise AnalysisError("공고 ID 형식이 올바르지 않습니다")
    return cache_dir / f"{program_id}.json"


def load_extraction(cache_dir: Path, program: dict) -> dict | None:
    path = _cache_path(cache_dir, program["id"])
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None
    # 공고문 파일이 바뀌었거나 저장 형식이 달라졌으면 다시 뽑는다
    if data.get("version") != CACHE_VERSION or data.get("docUrl") != program["docUrl"]:
        return None
    # 확인된 조건이 없는 저장본은 쓸 수 없으므로 없는 것으로 보고 다시 뽑게 한다
    if not data.get("conditions"):
        return None
    return data


def extract_notice(program: dict, client: LinerClient, cache_dir: Path, *, model: str = EXTRACT_MODEL,
                   fetch=None) -> dict:
    """공고문에서 조건을 뽑아 원문에 있는 근거만 남긴다. 결과는 공고 ID 로 저장해 다시 쓰고, 저장본이 있으면 호출하지 않는다."""
    with _program_lock(program["id"]):
        cached = load_extraction(cache_dir, program)
        if cached:
            return {**cached, "cached": True}
        return _extract_uncached(program, client, cache_dir, model, fetch)


def _extract_uncached(program: dict, client: LinerClient, cache_dir: Path, model: str, fetch) -> dict:
    try:
        doc = docs.extract_text((fetch or docs.fetch_document)(program["docUrl"]))
    except docs.DocumentError as e:
        raise AnalysisError(f"공고문을 읽지 못했습니다: {e}") from e
    user, truncated = notice.build_extract_user(program["title"], doc["text"])
    data, rec = client.chat_json(model, notice.EXTRACT_SYSTEM, user, schema=notice.EXTRACT_SCHEMA,
                                 schema_name="notice_conditions", label="notice_extract")
    raw = notice.parse_json(extract_chat_text(data))
    if raw is None:
        raise AnalysisError("모델 답을 해석하지 못했습니다")
    checked = notice.verify_quotes(notice.clean_conditions(raw), doc["text"])
    confirmed = [{k: c[k] for k in ("field", "requirement", "quote")} for c in checked if c["status"] == "확인됨"]
    if not confirmed:
        # 저장하지 않는다. 한 번의 실패한 답이 그 공고의 분석을 계속 막지 않게 한다
        raise AnalysisError("공고문에서 근거가 확인되는 조건을 찾지 못했습니다. 다시 시도해 주세요.")
    result = {
        "version": CACHE_VERSION, "id": program["id"], "docUrl": program["docUrl"],
        "doc": {"kind": doc["kind"], "pages": doc["pages"], "chars": len(doc["text"]), "truncated": truncated},
        "model": rec.get("response_model") or model,
        "extractedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": str(raw.get("summary") or ""),
        "notStated": [f for f in raw.get("not_stated") or [] if f in notice.FIELDS],
        "conditions": confirmed,
        "dropped": len(checked) - len(confirmed),  # 근거가 원문에 없어 버린 조건 수
        "costUsd": rec.get("cost_usd"), "elapsedSec": rec.get("elapsed_sec"),
    }
    _write_atomic(_cache_path(cache_dir, program["id"]), json.dumps(result, ensure_ascii=False, indent=1))
    return {**result, "cached": False}


def overall_from_rows(rows: list[dict]) -> str:
    """조건별 판정에서 종합 판정을 정한다. 미충족이 하나라도 있으면 대상 아님, 확인 필요가 남았거나 충족이 하나도 없으면 확인 후 판단."""
    verdicts = [r["verdict"] for r in rows if r["verdict"] != "판단 대상 아님"]
    if "미충족" in verdicts:
        return "대상 아님"
    if "확인 필요" in verdicts or "충족" not in verdicts:
        return "확인 후 판단"
    return "신청 검토 가능"


def analysis_gaps(extraction: dict) -> list[str]:
    """공고문 분석에서 빠진 부분. 있으면 대조하지 못한 조건이 있을 수 있다."""
    gaps = []
    dropped = int(extraction.get("dropped") or 0)
    if dropped:
        gaps.append(f"근거 문장을 공고문에서 확인하지 못해 제외한 조건이 {dropped}건 있습니다.")
    if (extraction.get("doc") or {}).get("truncated"):
        gaps.append("공고문이 길어 앞부분만 분석했습니다.")
    return gaps


def summarize_rows(rows: list[dict]) -> str:
    count = {v: sum(1 for r in rows if r["verdict"] == v) for v in ("충족", "미충족", "확인 필요")}
    return f"조건별 판정 기준: 충족 {count['충족']}건, 미충족 {count['미충족']}건, 확인 필요 {count['확인 필요']}건."


def match_company(extraction: dict, company_text: str, client: LinerClient, *, model: str = MATCH_MODEL) -> dict:
    conditions = extraction["conditions"]
    if not conditions:
        raise AnalysisError("원문에서 확인된 조건이 없어 대조할 수 없습니다")
    data, rec = client.chat_json(model, notice.MATCH_SYSTEM, notice.build_match_user(company_text, conditions),
                                 schema=notice.MATCH_SCHEMA, schema_name="notice_match", label="notice_match")
    result = notice.clean_match(notice.parse_json(extract_chat_text(data)), len(conditions))
    if result is None:
        raise AnalysisError("대조 결과를 해석하지 못했습니다")
    by_index = {c["index"]: c for c in result["checks"]}
    rows = [{**cond, "verdict": by_index.get(i, {}).get("verdict", "확인 필요"),
             "reason": by_index.get(i, {}).get("reason", "")} for i, cond in enumerate(conditions)]
    overall = overall_from_rows(rows)
    # 모델의 종합 판정이 조건별 판정과 어긋나면 조건별 판정을 따르고, 모델의 설명은 쓰지 않는다
    reason = result["overall_reason"] if overall == result["overall"] else summarize_rows(rows)
    # 공고문을 다 보지 못했으면 보지 못한 조건이 있을 수 있으므로 '신청 검토 가능'으로 단정하지 않는다
    gaps = analysis_gaps(extraction)
    if gaps and overall == "신청 검토 가능":
        overall = "확인 후 판단"
        reason = f"확인된 조건은 모두 충족하지만 {' '.join(gaps)} 공고문에서 나머지 조건을 직접 확인해야 합니다."
    return {"overall": overall, "overallReason": reason, "adjusted": overall != result["overall"], "rows": rows,
            "questions": result["questions"], "documents": result["documents"],
            "model": rec.get("response_model") or model, "costUsd": rec.get("cost_usd"), "elapsedSec": rec.get("elapsed_sec")}
