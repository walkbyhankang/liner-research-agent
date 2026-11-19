"""Liner API HTTP 클라이언트.

- 호출 종류별 한도(Search/Model/Agent) 강제
- 524/429/5xx 는 Retry-After 를 따르거나 짧은 백오프 후 최대 1회만 재시도
- 모든 시도를 호출 기록(api_calls)에 남긴다. 인증 헤더/키는 기록하지 않는다.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

import httpx

import config

RETRYABLE_STATUS = {429, 500, 502, 503, 504, 524}
MAX_AUTO_RETRIES = 1  # 동일 유료 호출의 자동 재시도 상한
DEFAULT_BACKOFF_SEC = 5.0
MAX_RETRY_WAIT_SEC = 60.0


class LinerAPIError(Exception):
    def __init__(self, message: str, status: int | None = None, code: str | None = None,
                 retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable


class CallLimitExceeded(LinerAPIError):
    pass


def estimate_cost_usd(kind: str, data: dict | None, include_knowledge: bool = False) -> float | None:
    """공식 가격표 기준 추정 비용(USD). 실제 청구액과 다를 수 있다."""
    if kind == "search":
        key = "search_web_premium" if include_knowledge else "search_web"
        return config.PRICE_PER_CALL_USD[key]
    if kind == "agent":
        return config.PRICE_PER_CALL_USD["search_agent"]
    if kind == "model" and data:
        usage = data.get("usage") or {}
        model = str(data.get("model") or "")
        prices = config.MODEL_TOKEN_PRICES.get(model)
        if not prices:
            return None
        p_in, p_out, p_cached = prices
        cached = (usage.get("input_tokens_details") or {}).get("cached_tokens") or 0
        inp = max((usage.get("input_tokens") or 0) - cached, 0)
        out = usage.get("output_tokens") or 0
        return round((inp * p_in + cached * p_cached + out * p_out) / 1_000_000, 6)
    return None


def _error_info(resp: httpx.Response) -> tuple[str, str | None]:
    """응답 본문에서 (메시지, 코드)를 안전하게 추출한다. HTML(524 등)도 처리."""
    try:
        body = resp.json()
    except ValueError:
        text = (resp.text or "").strip().replace("\n", " ")
        return (text[:200] or f"HTTP {resp.status_code}"), None
    if isinstance(body, dict):
        err = body.get("error", body)
        if isinstance(err, dict):
            return str(err.get("message") or err.get("code") or f"HTTP {resp.status_code}")[:300], \
                (str(err["code"]) if err.get("code") else None)
        return str(err)[:300], None
    return f"HTTP {resp.status_code}", None


class LinerClient:
    def __init__(self, api_key: str, key_source: str | None = None, *,
                 base_url: str = config.LINER_BASE_URL,
                 transport: httpx.BaseTransport | None = None,
                 sleep: Callable[[float], None] = time.sleep,
                 limits: dict[str, int] | None = None):
        self._api_key = api_key
        self.key_source = key_source
        self._sleep = sleep
        self._http = httpx.Client(base_url=base_url, transport=transport)
        self._limits = {"search": config.MAX_SEARCH_CALLS, "model": config.MAX_MODEL_CALLS,
                        "agent": config.MAX_AGENT_CALLS, "premium": config.MAX_PREMIUM_CALLS}
        self._limits.update(limits or {})
        self._counts = {"search": 0, "model": 0, "agent": 0, "premium": 0}
        self._lock = threading.Lock()
        self.calls: list[dict[str, Any]] = []

    # ---------- 공통 ----------
    def close(self) -> None:
        self._http.close()

    @property
    def secrets(self) -> list[str]:
        return [self._api_key] if self._api_key else []

    def remaining(self, kind: str) -> int:
        return self._limits[kind] - self._counts[kind]

    def usage(self) -> dict[str, dict[str, int]]:
        """종류별 (한도, 사용, 남음). 사용량은 '요청 시도' 기준(자동 재시도는 별도 호출 기록)."""
        return {k: {"limit": self._limits[k], "used": self._counts[k],
                    "remaining": self._limits[k] - self._counts[k]} for k in self._limits}

    def _request(self, kind: str, path: str, payload: dict, timeout: float, label: str,
                 include_knowledge: bool = False, meta: dict | None = None) -> tuple[dict, dict]:
        with self._lock:
            if self._counts[kind] >= self._limits[kind]:
                raise CallLimitExceeded(f"{kind} 호출 한도({self._limits[kind]}회) 초과", retryable=False)
            if kind == "search" and include_knowledge:  # Premium 호출은 검색 한도와 Premium 한도 모두에 포함
                if self._counts["premium"] >= self._limits["premium"]:
                    raise CallLimitExceeded(f"premium 호출 한도({self._limits['premium']}회) 초과", retryable=False)
                self._counts["premium"] += 1
            self._counts[kind] += 1

        headers = {"x-api-key": self._api_key, "Content-Type": "application/json"}
        attempt = 0
        while True:
            attempt += 1
            rec: dict[str, Any] = {
                "call_no": len(self.calls) + 1, "kind": kind, "label": label,
                "endpoint": path, "attempt": attempt,
                "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "http_status": None, "ok": False, "elapsed_sec": None, "error": "",
                "request_id": "", "input_tokens": None, "output_tokens": None,
                "total_tokens": None, "est_cost_usd": None, "finished_at": None,
                "include_knowledge": include_knowledge if kind == "search" else None, **(meta or {}),
            }
            self.calls.append(rec)
            t0 = time.perf_counter()
            try:
                resp = self._http.post(path, json=payload, headers=headers, timeout=timeout)
            except httpx.HTTPError as exc:  # 타임아웃/연결 오류: 유료 호출 중복 방지를 위해 재시도하지 않음
                rec["elapsed_sec"] = round(time.perf_counter() - t0, 2)
                rec["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                rec["error"] = f"{type(exc).__name__}: 네트워크/타임아웃 오류"
                raise LinerAPIError(f"네트워크 오류 또는 타임아웃({type(exc).__name__})", retryable=False) from exc
            rec["elapsed_sec"] = round(time.perf_counter() - t0, 2)
            rec["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            rec["http_status"] = resp.status_code

            if 200 <= resp.status_code < 300:
                try:
                    data = resp.json()
                except ValueError as exc:
                    rec["error"] = "응답이 JSON이 아님"
                    raise LinerAPIError("응답이 JSON 형식이 아닙니다.", status=resp.status_code) from exc
                rec["ok"] = True
                if isinstance(data, dict):
                    rec["request_id"] = str(data.get("requestId") or data.get("id") or "")
                    usage = data.get("usage") or {}
                    rec["input_tokens"] = usage.get("input_tokens")
                    rec["output_tokens"] = usage.get("output_tokens")
                    rec["total_tokens"] = usage.get("total_tokens")
                    rec["est_cost_usd"] = estimate_cost_usd(kind, data, include_knowledge)
                return data, rec

            msg, code = _error_info(resp)
            rec["error"] = f"{code or ''} {msg}".strip()
            retryable = resp.status_code in RETRYABLE_STATUS
            if retryable and attempt <= MAX_AUTO_RETRIES:
                wait = self._retry_wait(resp)
                rec["error"] += f" (재시도 예정: {wait:.0f}초 후)"
                self._sleep(wait)
                continue
            raise LinerAPIError(f"HTTP {resp.status_code}: {msg}", status=resp.status_code,
                                code=code, retryable=retryable)

    @staticmethod
    def _retry_wait(resp: httpx.Response) -> float:
        raw = resp.headers.get("retry-after")
        if raw:
            try:
                return min(max(float(raw), 0.0), MAX_RETRY_WAIT_SEC)
            except ValueError:
                pass
        return DEFAULT_BACKOFF_SEC

    # ---------- 개별 API ----------
    def search_web(self, query: str, *, country_code: str = "", lang: str = "ko",
                   date_range: str | None = None, label: str = "", max_results: int | None = None,
                   include_knowledge: bool | None = None, meta: dict | None = None) -> tuple[dict, dict]:
        """공식 OpenAPI: max_results 1~20, include_knowledge 기본 true(반드시 명시 전송), date_range enum."""
        n = config.SEARCH_MAX_RESULTS if max_results is None else max_results
        n = max(1, min(int(n), config.API_MAX_RESULTS))
        ik = config.INCLUDE_KNOWLEDGE if include_knowledge is None else bool(include_knowledge)
        payload: dict[str, Any] = {"query": query, "lang": lang, "max_results": n, "include_knowledge": ik}
        if country_code:
            payload["country_code"] = country_code
        if date_range:
            payload["date_range"] = date_range
        m = {"query": query, "max_results": n, "date_range": date_range or "", **(meta or {})}
        data, rec = self._request("search", config.SEARCH_WEB_PATH, payload, config.SEARCH_TIMEOUT,
                                  label or "search", include_knowledge=ik, meta=m)
        if isinstance(data, dict):
            rec["result_count"] = len(data.get("results") or [])
            rec["knowledge_count"] = len(data.get("knowledge") or [])
        return data, rec

    def responses(self, instructions: str, user_input: str, *, model: str = config.DEFAULT_MODEL,
                  max_output_tokens: int = config.MODEL_MAX_OUTPUT_TOKENS,
                  reasoning_effort: str = config.MODEL_REASONING_EFFORT,
                  label: str = "model") -> tuple[dict, dict]:
        payload = {
            "model": model,
            "instructions": instructions,
            "input": user_input,
            "max_output_tokens": max_output_tokens,
            "reasoning": {"effort": reasoning_effort},
            "text": {"format": {"type": "json_object"}},
        }
        return self._request("model", config.RESPONSES_PATH, payload, config.MODEL_TIMEOUT, label)

    def agent_search(self, question: str, *, lang: str = "ko", label: str = "search_agent") -> tuple[dict, dict]:
        payload = {
            "messages": [{"role": "user", "content": question}],
            "lang": lang, "mode": "general", "stream": False,
        }
        return self._request("agent", config.SEARCH_AGENT_PATH, payload, config.AGENT_TIMEOUT, label)


def extract_output_text(response: dict) -> str:
    """Responses API 응답에서 assistant 텍스트를 이어 붙여 반환한다."""
    parts: list[str] = []
    for item in response.get("output") or []:
        if isinstance(item, dict) and item.get("type") == "message":
            for c in item.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    parts.append(str(c.get("text") or ""))
    return "".join(parts)
