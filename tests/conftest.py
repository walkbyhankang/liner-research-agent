"""모든 테스트 공통: 하루 사용량·요청 제한을 테스트마다 새로 시작한다.

- 하루 사용량은 테스트마다 임시 폴더에 센다. 실제 results/usage/ 파일(운영 중인 서버의 하루 상한)을 건드리지 않는다.
- 환경변수 덮어쓰기(GROWTH_DAILY_LIMIT_*, GROWTH_RATE_LIMIT_PER_MINUTE)는 무시하고 기본값으로 시작한다.
- api.main 을 이미 불러왔으면 접속 주소별 요청 제한 기록도 지운다(한 테스트 안에서는 그대로 센다).
- 테스트 중에는 이 컴퓨터 밖으로 연결하지 못하게 막는다. 테스트는 가짜 응답(MockTransport)으로만 하고, 실수로 유료
  API(Liner)나 무료 공공 API를 부르지 않게 한다. 이 컴퓨터 안(루프백)과 유닉스 소켓 연결만 허용한다.
"""
import ipaddress
import socket
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


def _loopback(address) -> bool:
    if not isinstance(address, tuple):   # 유닉스 소켓 경로
        return True
    host = str(address[0])
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.split("%")[0]).is_loopback
    except ValueError:
        return False


_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


def _guarded_connect(self, address):
    if not _loopback(address):
        raise ConnectionRefusedError("테스트에서는 외부로 연결하지 않는다(tests/conftest.py)")
    return _real_connect(self, address)


def _guarded_connect_ex(self, address):
    if not _loopback(address):
        raise ConnectionRefusedError("테스트에서는 외부로 연결하지 않는다(tests/conftest.py)")
    return _real_connect_ex(self, address)


@pytest.fixture(autouse=True)
def _no_external_network(monkeypatch):
    monkeypatch.setattr(socket.socket, "connect", _guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", _guarded_connect_ex)
    yield


@pytest.fixture(autouse=True)
def _fresh_usage_and_rate_limit(tmp_path):
    _reset(tmp_path / "usage")
    yield
    _reset(None)
