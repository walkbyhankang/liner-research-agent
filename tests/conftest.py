"""모든 테스트 공통: 하루 사용량·요청 제한을 테스트마다 새로 시작한다.

- 하루 사용량은 테스트마다 임시 폴더에 센다. 실제 results/usage/ 파일(운영 중인 서버의 하루 상한)을 건드리지 않는다.
- 환경변수 덮어쓰기(GROWTH_DAILY_LIMIT_*, GROWTH_RATE_LIMIT_PER_MINUTE)는 무시하고 기본값으로 시작한다.
- api.main 을 이미 불러왔으면 접속 주소별 요청 제한 기록도 지운다(한 테스트 안에서는 그대로 센다).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from growth import limits  # noqa: E402


def _reset(usage_dir):
    limits._reset_for_tests({}, usage_dir=usage_dir)
    main = sys.modules.get("api.main")
    if main is not None:
        main._rate_limiter.reset(limits.RATE_LIMIT_PER_MINUTE)


@pytest.fixture(autouse=True)
def _fresh_usage_and_rate_limit(tmp_path):
    _reset(tmp_path / "usage")
    yield
    _reset(None)
