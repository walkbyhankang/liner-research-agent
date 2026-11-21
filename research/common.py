"""공통: .env 키 읽기, 키 마스킹, 파일 캐시, 이름 정규화."""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from dotenv import dotenv_values

import config

CACHE_DIR = config.RESULTS_DIR / "cache" / "research"
SECRET_KEYS = ("LINER_API_KEY", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET", "DATA_GO_KR_SERVICE_KEY",
               "OPENALEX_API_KEY", "BIZINFO_API_KEY", "KVIC_API_KEY")
_env: dict | None = None
_lock = threading.Lock()


def env(name: str) -> str:
    """환경변수 → 이 프로젝트 .env 순서로 읽는다. 다른 프로젝트의 .env 는 읽지 않는다."""
    global _env
    if _env is None:
        _env = dict(dotenv_values(config.ENV_FILE)) if config.ENV_FILE.is_file() else {}
    return (os.environ.get(name) or _env.get(name) or "").strip()


def secrets() -> list[str]:
    out = []
    for k in SECRET_KEYS:
        v = env(k)
        if v and len(v) >= 8:
            out += [v, quote(v, safe=""), quote(v)]
    return sorted(set(out), key=len, reverse=True)


def scrub_text(text: Any) -> str:
    s = str(text or "")
    for v in secrets():
        s = s.replace(v, "***")
    return re.sub(r"(?i)(serviceKey|crtfcKey|apiKey|key)=[^&\s\"']+", r"\1=***", s)


def key_status() -> dict[str, bool]:
    return {k: bool(env(k)) for k in SECRET_KEYS}


# ---------------- 파일 캐시 ----------------
def _cache_path(kind: str, ident: Any) -> Path:
    h = hashlib.sha1(json.dumps(ident, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:20]
    return CACHE_DIR / kind / f"{h}.json"


def cache_get(kind: str, ident: Any, ttl_hours: float) -> Any | None:
    p = _cache_path(kind, ident)
    if not p.is_file():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return None
    if time.time() - float(d.get("saved_at") or 0) > ttl_hours * 3600:
        return None
    return d.get("data")


def cache_put(kind: str, ident: Any, data: Any) -> None:
    """성공 응답만 저장한다. 키는 ident 에 넣지 않는다(호출부 책임). 저장 전 한 번 더 마스킹한다."""
    p = _cache_path(kind, ident)
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps({"saved_at": time.time(), "data": data}, ensure_ascii=False, default=str)
    text = scrub_text(text) if any(s in text for s in secrets()) else text
    with _lock:
        tmp = p.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, p)


# ---------------- 이름 ----------------
_CORP_WORDS = re.compile(r"주식회사|유한회사|유한책임회사|\(주\)|\(유\)|㈜|inc\.?|corp\.?|co\.,?\s*ltd\.?|ltd\.?|llc", re.I)


def norm_name(s: str) -> str:
    s = _CORP_WORDS.sub("", s or "")
    return re.sub(r"[\s·.,&()\-_'\"]", "", s).lower()


TAG = re.compile(r"<[^>]+>")


def clean_html(s: str | None) -> str:
    import html
    return re.sub(r"\s+", " ", html.unescape(TAG.sub(" ", s or ""))).strip()
