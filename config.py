"""프로그램 설정, 호출 한도, API 키 확인."""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import dotenv_values

APP_VERSION = "0.2.0"
LOGIC_VERSION = "search-v2.0"  # 검색·분석 로직 버전(캐시 구분/결과 기록용)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"
LOG_DIR = BASE_DIR / "logs"
ENV_FILE = BASE_DIR / ".env"

LINER_BASE_URL = "https://platform.liner.com"
SEARCH_WEB_PATH = "/api/v1/tools/search/web"
RESPONSES_PATH = "/api/v1/responses"
CHAT_COMPLETIONS_PATH = "/api/v1/chat/completions"  # 게이트웨이: 공급사/모델 형식 ID 직접 지정 가능
SEARCH_AGENT_PATH = "/api/v1/agents/search"
CREDITS_BALANCE_PATH = "/api/v1/credits/balance"
CREDITS_USAGE_PATH = "/api/v1/credits/usage"

# 호출 한도 (분석 실행 1회 기준)
MAX_SEARCH_CALLS = 50            # 검색 한도(사용자 지시로 상향: 12→50)
MAX_SEARCH_CALLS_EXTENDED = 50   # 확장 검색
SEARCH_LIMIT_CHOICES = (12, 20, 50)
MAX_MODEL_CALLS = 6              # 카테고리별 1회
MAX_AGENT_CALLS = 1
MAX_PREMIUM_CALLS = 1            # Premium 비교 (검색 호출 한도에도 포함)
SEARCH_MAX_RESULTS = 15          # 기본 결과 수
SEARCH_RESULT_CHOICES = (5, 10, 15, 20)
API_MAX_RESULTS = 20             # 공식 OpenAPI: max_results 1~20
INCLUDE_KNOWLEDGE = False        # 기본 검색은 Premium Data 미사용(공식 기본값은 true이므로 명시적으로 false 전송)

# 원문 확인(fetch)
FETCH_MAX_PAGES = 40   # 원문 확인 한도(비용 없음, 1차 실행에서 한도 초과로 검증률 29%에 그쳐 상향)
FETCH_TIMEOUT = 10
FETCH_MAX_BYTES = 1_000_000
FETCH_USER_AGENT = "LinerProbeBot/0.2 (+company-research; respects robots.txt)"

BASELINE_RUN_ID = "20261118_002846_9604"  # 1차 테스트 결과(비교 기준)

DEFAULT_MODEL = "liner-gpt-router"
MODEL_REASONING_EFFORT = "low"
MODEL_MAX_OUTPUT_TOKENS = 6000

# 타임아웃(초). Responses API는 약 125초 무응답 시 524가 날 수 있음(공식 문서).
SEARCH_TIMEOUT = 60
MODEL_TIMEOUT = 180
MODEL_CHOICES = (DEFAULT_MODEL, "gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol")  # 가격표에 있는 모델(공식 지원 목록은 미확인)
AGENT_TIMEOUT = 320  # 공식 문서: upstream 시도당 최대 300초

# 공식 가격표 기준 (USD). 2026-11 확인. 실제 청구액은 크레딧 잔액 차이로 별도 확인.
PRICE_PER_CALL_USD = {
    "search_web": 0.001,          # include_knowledge=false
    "search_web_premium": 0.002,  # include_knowledge=true
    "search_agent": 0.02,
}
# 모델별 USD / 1M tokens: (input, output, cached_input)
MODEL_TOKEN_PRICES = {
    "gpt-6-luna": (0.10, 0.50, 0.01),
    "gpt-6.1-terra": (1.00, 5.00, 0.05),
    "gpt-6.1-sol": (2.00, 10.00, 0.10),
    "gpt-6-sol": (2.00, 10.00, 0.20),
    "gpt-6-astra": (10.00, 50.00, 1.00),
}

COUNTRIES = {
    "대한민국": {"code": "kr", "lang": "ko"},
    "미국": {"code": "us", "lang": "en"},
    "일본": {"code": "jp", "lang": "ja"},
    "영국": {"code": "gb", "lang": "en"},
    "독일": {"code": "de", "lang": "en"},
    "싱가포르": {"code": "sg", "lang": "en"},
    "기타(영어 검색)": {"code": "", "lang": "en"},
}

KEY_SOURCE_LABELS = {
    "env": "LINER_API_KEY 환경변수",
    "dotenv": "프로젝트 .env 파일",
    "claude_code": "Claude Code의 ANTHROPIC_AUTH_TOKEN (Liner 주소 확인됨, 메모리에서만 사용)",
    None: "키 없음",
}


def _is_liner_url(url: str | None) -> bool:
    if not url:
        return False
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "platform.liner.com"


def resolve_api_key(environ: dict | None = None, env_file: Path | None = None) -> tuple[str | None, str | None]:
    """(키, 출처)를 반환한다. 키는 파일로 복사하거나 저장하지 않는다."""
    environ = os.environ if environ is None else environ
    env_file = ENV_FILE if env_file is None else env_file

    key = (environ.get("LINER_API_KEY") or "").strip()
    if key:
        return key, "env"

    if env_file.is_file():
        key = (dotenv_values(env_file).get("LINER_API_KEY") or "").strip()
        if key:
            return key, "dotenv"

    token = (environ.get("ANTHROPIC_AUTH_TOKEN") or "").strip()
    if token and _is_liner_url(environ.get("ANTHROPIC_BASE_URL")):
        return token, "claude_code"

    return None, None
