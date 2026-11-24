"""공통: 키 읽기, 키 지우기, 외부 응답 파일 캐시, single-flight 잠금, 이름 정리, 시각.

팀원의 통합 분석 프로토타입(커밋 97c93ce)에서 옮겨 왔다(계약 16절). 캐시 폴더·열쇠 규칙은 그대로라 지금까지 쌓인 캐시를 그대로 쓴다:
results/cache/research/<종류>/<sha1(ident)[:20]>.json
이름 견주기 열쇠는 계약의 norm_name(NFKC 정규화가 더해짐) 하나만 쓴다.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from dotenv import dotenv_values

import config
from growth.contract import norm_name  # noqa: F401  (다른 growth 모듈이 여기서 가져다 쓴다)
from growth.limits import KST

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
    """지울 키 문자열 목록(8자 이상인 값과 그 퍼센트 인코딩). 긴 것부터."""
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


# ---------------- single-flight ----------------
_key_locks: dict[str, threading.Lock] = {}
_key_guard = threading.Lock()


def key_lock(kind: str, ident: Any) -> threading.Lock:
    """같은 캐시 열쇠를 여러 스레드가 동시에 조회·호출하지 않게 하는 열쇠별 잠금.

    먼저 잡은 스레드가 호출해 캐시에 넣으면, 기다린 스레드는 캐시 적중으로 끝나 같은 API 를 두 번 부르지 않는다.
    """
    k = kind + ":" + _cache_path(kind, ident).name
    with _key_guard:
        lk = _key_locks.get(k)
        if lk is None:
            lk = _key_locks[k] = threading.Lock()
        return lk


# ---------------- 파일 캐시 ----------------
def _cache_path(kind: str, ident: Any) -> Path:
    h = hashlib.sha1(json.dumps(ident, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:20]
    return CACHE_DIR / kind / f"{h}.json"


def cache_get(kind: str, ident: Any, ttl_hours: float, *, newer_than: float | None = None) -> Any | None:
    """보관 시간 안의 캐시. newer_than(유닉스 시각)을 주면 그 뒤에 저장된 것만 쓴다(새로 분석 중 같은 요청 합치기)."""
    p = _cache_path(kind, ident)
    if not p.is_file():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return None
    saved = float(d.get("saved_at") or 0)
    if time.time() - saved > ttl_hours * 3600:
        return None
    if newer_than is not None and saved < newer_than:
        return None
    return d.get("data")


def cache_put(kind: str, ident: Any, data: Any) -> None:
    """성공 응답만 저장한다. 키는 ident 에 넣지 않는다(호출부 책임). 저장 전 한 번 더 지운다."""
    p = _cache_path(kind, ident)
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps({"saved_at": time.time(), "data": data}, ensure_ascii=False, default=str)
    text = scrub_text(text) if any(s in text for s in secrets()) else text
    with _lock:
        tmp = p.with_suffix(f".{threading.get_ident()}.tmp")  # 스레드별 임시 파일 후 원자적 교체
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, p)


# ---------------- 이름·글 ----------------
_CORP_MARK = re.compile(r"주식회사|유한회사|유한책임회사|\(주\)|\(유\)|㈜")


def strip_corp(name: str | None) -> str:
    """'주식회사 가나다' → '가나다'. 검색어로 쓸 이름(법인 표기를 뺀 것)."""
    t = unicodedata.normalize("NFKC", name or "")
    return re.sub(r"\s+", " ", _CORP_MARK.sub("", t)).strip()


TAG = re.compile(r"<[^>]+>")


def clean_html(s: str | None) -> str:
    return re.sub(r"\s+", " ", html.unescape(TAG.sub(" ", s or ""))).strip()


def web_url(u: Any) -> str | None:
    """http·https 주소만 남긴다(계약 1.3절). 그 밖은 None."""
    return u if isinstance(u, str) and u.startswith(("http://", "https://")) else None


def host_of(url: str | None) -> str:
    try:
        h = (urlparse(url or "").hostname or "").lower()
    except ValueError:
        return ""
    return re.sub(r"^www\.", "", h)


def none_if_empty(v: Any) -> Any:
    """빈 글 → None(계약 15절: 값이 없다는 뜻의 빈 글은 null)."""
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


# ---------------- 시각 ----------------
def now() -> datetime:
    return datetime.now(KST)


def iso(dt: datetime) -> str:
    return dt.astimezone(KST).isoformat(timespec="seconds")


def parse_iso(s: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(s) if s else None
    except ValueError:
        return None
