"""보안: 원문 확인 내부망 차단(설계 10.3), 접속 주소별 요청 제한(계약 2.12), 오류 본문(계약 1.3·3절).
실제 네트워크·DNS 는 쓰지 않는다(가짜 transport, 가짜 DNS, 가짜 소켓)."""
import ipaddress
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import httpcore
import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api.main as api_main  # noqa: E402
import fetcher as fx  # noqa: E402
from funding import docs  # noqa: E402
from growth import contract as C  # noqa: E402
from growth import limits as L  # noqa: E402
from liner_client import LinerClient  # noqa: E402

PAGE = "<html><head><title>기사</title></head><body><article><p>" + ("가나다테크가 시리즈 A 투자를 유치했다. " * 20) + "</p></article></body></html>"
PUBLIC = "93.184.215.14"
DNS = {"news.example": [PUBLIC], "other.example": ["93.184.215.15"], "intranet.example": ["10.0.0.5"],
       "metadata.example": ["169.254.169.254"], "mixed.example": [PUBLIC, "192.168.0.1"], "v6.example": ["fd00::1"],
       "mapped.example": ["::ffff:127.0.0.1"], "cgnat.example": ["100.64.1.2"]}


def fake_dns(host, port):
    if host not in DNS:
        raise OSError("not found")
    return list(DNS[host])


class Site:
    """가짜 웹. 요청을 기록하고 (호스트, 경로) → 응답."""

    def __init__(self, routes=None, robots=None):
        self.routes = routes or {}
        self.robots = robots or {}
        self.seen: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.seen.append(str(req.url))
        if req.url.path == "/robots.txt":
            r = self.robots.get(req.url.host)
            return r if isinstance(r, httpx.Response) else httpx.Response(200, text=r or "User-agent: *\nAllow: /")
        r = self.routes.get((req.url.host, req.url.path))
        return r if r is not None else httpx.Response(404)


def page():
    return httpx.Response(200, text=PAGE, headers={"content-type": "text/html; charset=utf-8"})


def moved(location, status=302):
    return httpx.Response(status, headers={"location": location})


def fetcher(site, **kw):
    return fx.Fetcher(transport=httpx.MockTransport(site), resolve=fake_dns, **kw)


# ---------------------------------------------------------------- 주소 판정

@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
                                "100.127.255.254", "0.0.0.0", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
                                "192.0.2.1", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
                                "fec0::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::127.0.0.1", "64:ff9b::7f00:1",
                                "64:ff9b::a00:1", "2002:7f00:1::1", "2001:db8::1", "fe80::1%en0"])
def test_internal_and_reserved_addresses_are_blocked(ip):
    assert fx.blocked_ip(ipaddress.ip_address(ip))


@pytest.mark.parametrize("ip", ["8.8.8.8", PUBLIC, "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::808:808"])
def test_public_addresses_pass(ip):
    assert not fx.blocked_ip(ipaddress.ip_address(ip))


@pytest.mark.parametrize("url", ["http://127.0.0.1:8000/api/health", "http://localhost/", "http://LOCALHOST./x", "http://a.localhost/",
                                 "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://[::1]:8000/",
                                 "http://[::ffff:7f00:1]/", "http://[fd00::1]/", "http://192.168.0.1/admin", "http://100.64.0.1/",
                                 "ftp://news.example/a", "file:///etc/passwd", "gopher://news.example/", "http:///nohost"])
def test_check_url_blocks_without_dns(url):
    with pytest.raises(fx.BlockedAddress):
        fx.check_url(url, resolve=None)


def test_check_url_resolves_names_and_blocks_any_internal_answer():
    fx.check_url("https://news.example/a", resolve=fake_dns)
    for host in ("intranet.example", "metadata.example", "mixed.example", "v6.example", "mapped.example", "cgnat.example"):
        with pytest.raises(fx.BlockedAddress):
            fx.check_url(f"https://{host}/", resolve=fake_dns)
    with pytest.raises(httpx.ConnectError):  # 해석하지 못하면 막힘이 아니라 연결 실패
        fx.check_url("https://nowhere.example/", resolve=fake_dns)


# ---------------------------------------------------------------- Fetcher: 내부망 차단, 리다이렉트, robots

@pytest.mark.parametrize("url", ["http://127.0.0.1:8000/api/health", "http://intranet.example/", "http://[::1]/",
                                 "http://metadata.example/latest/meta-data/", "http://mixed.example/a", "http://2130706433/"])
def test_fetch_never_sends_anything_to_internal_hosts(url):
    site = Site()
    r = fetcher(site).fetch(url)
    assert r["status"] == "blocked" and r["reason"] == fx.BLOCKED_REASON and not r["ok"]
    assert site.seen == []  # robots.txt 도 보내지 않았다


def test_redirect_to_internal_address_is_blocked_at_that_hop():
    for target in ("http://127.0.0.1:8000/api/health", "http://intranet.example/admin", "http://[fd00::1]/",
                   "http://metadata.example/latest", "ftp://news.example/x"):
        site = Site({("news.example", "/a"): moved(target)})
        r = fetcher(site).fetch("https://news.example/a")
        assert r["status"] == "blocked" and not r["ok"], target
        assert all("news.example" in u for u in site.seen), site.seen  # 내부 주소로는 한 번도 보내지 않았다


def test_same_site_redirect_is_followed_and_each_hop_checked():
    site = Site({("news.example", "/old"): moved("/mid", 301), ("news.example", "/mid"): moved("https://news.example/new", 308),
                 ("news.example", "/new"): page()})
    r = fetcher(site).fetch("https://news.example/old")
    assert r["ok"] and r["status"] == "fetched" and r["http_status"] == 200
    assert site.seen == ["https://news.example/robots.txt", "https://news.example/old", "https://news.example/mid",
                         "https://news.example/new"]


def test_redirect_to_other_site_checks_that_sites_robots():
    site = Site({("news.example", "/a"): moved("https://other.example/b"), ("other.example", "/b"): page()},
                robots={"other.example": "User-agent: *\nDisallow: /"})
    r = fetcher(site).fetch("https://news.example/a")
    assert r["status"] == "blocked" and "robots.txt" in r["reason"]
    assert "https://other.example/b" not in site.seen and "https://other.example/robots.txt" in site.seen


def test_too_many_redirects_stop():
    routes = {("news.example", f"/{i}"): moved(f"/{i + 1}") for i in range(10)}
    site = Site(routes)
    r = fetcher(site).fetch("https://news.example/0")
    assert r["status"] == "failed" and "리다이렉트" in r["reason"]
    assert len([u for u in site.seen if not u.endswith("robots.txt")]) == fx.MAX_REDIRECTS + 1


def test_robots_request_is_guarded_too():
    # robots.txt 가 내부 주소로 리다이렉트하면 그 단계에서 막고, 본문 요청도 보내지 않는다
    site = Site({("news.example", "/a"): page()}, robots={"news.example": moved("http://127.0.0.1/robots.txt")})
    r = fetcher(site).fetch("https://news.example/a")
    assert r["status"] == "blocked" and r["reason"] == fx.BLOCKED_REASON
    assert site.seen == ["https://news.example/robots.txt"]
    # robots.txt 가 다른 공개 주소로 리다이렉트하면 따라가 읽는다(예: http → https)
    site = Site({("news.example", "/private"): page()},
                robots={"news.example": moved("https://other.example/robots.txt"), "other.example": "User-agent: *\nDisallow: /private"})
    assert fetcher(site).fetch("https://news.example/private")["status"] == "blocked"


def test_robots_body_is_capped(monkeypatch):
    monkeypatch.setattr(fx, "ROBOTS_MAX_BYTES", 64)
    site = Site({("news.example", "/x"): page()}, robots={"news.example": "User-agent: *\nAllow: /\n" + "#" * 10_000 + "\nDisallow: /x"})
    assert fetcher(site).fetch("https://news.example/x")["ok"]  # 잘린 뒤쪽 Disallow 는 읽지 않는다(메모리 보호)


# ---------------------------------------------------------------- 실제 연결 계층: 검사한 IP 로만 연결(DNS 재바인딩)

class FakeStream(httpcore.NetworkStream):
    """httpcore 가 쓰는 소켓 대신. 보낸 바이트를 모으고 정해 둔 HTTP 응답을 돌려준다."""

    def __init__(self, peer, response=b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok"):
        self.peer, self.sent, self._resp, self.closed = peer, b"", response, False

    def read(self, max_bytes, timeout=None):
        out, self._resp = self._resp[:max_bytes], self._resp[max_bytes:]
        return out

    def write(self, buffer, timeout=None):
        self.sent += buffer

    def close(self):
        self.closed = True

    def get_extra_info(self, info):
        return self.peer if info == "server_addr" else None


@pytest.fixture
def sockets(monkeypatch):
    """httpcore.SyncBackend.connect_tcp 를 가짜로. 실제 소켓을 열지 않는다. 연결 요청(host, port)을 기록한다."""
    calls, peers, streams = [], {}, []

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        calls.append((host, port))
        s = FakeStream(peers.get(host, (host, port)))
        streams.append(s)
        return s

    monkeypatch.setattr(httpcore.SyncBackend, "connect_tcp", connect_tcp)
    return calls, peers, streams


def test_real_transport_connects_only_to_the_checked_ip(sockets):
    calls, _, streams = sockets
    with httpx.Client(transport=fx.GuardedTransport(resolve=fake_dns), trust_env=False) as c:
        r = c.get("http://news.example/a")
    assert r.status_code == 200 and r.text == "ok"
    assert calls == [(PUBLIC, 80)]  # 호스트 이름이 아니라 검사한 IP 로 연결했다
    assert b"Host: news.example" in streams[0].sent  # 머리글의 호스트 이름은 그대로


def test_dns_rebinding_between_check_and_connect_is_blocked(sockets):
    calls, _, _ = sockets
    answers = iter([[PUBLIC], ["127.0.0.1"]])  # 요청 직전 검사 때는 공개 주소, 연결할 때는 루프백

    with httpx.Client(transport=fx.GuardedTransport(resolve=lambda h, p: next(answers)), trust_env=False) as c:
        with pytest.raises(fx.BlockedAddress):
            c.get("http://rebind.example/")
    assert calls == []  # 소켓을 열지 않았다


def test_connected_peer_address_is_checked_too(sockets):
    calls, peers, streams = sockets
    peers[PUBLIC] = ("10.0.0.9", 80)  # 연결해 보니 상대가 내부 주소(가로채기 등)
    with httpx.Client(transport=fx.GuardedTransport(resolve=fake_dns), trust_env=False) as c:
        with pytest.raises(fx.BlockedAddress):
            c.get("http://news.example/")
    assert calls == [(PUBLIC, 80)] and streams[0].closed and streams[0].sent == b""  # 요청을 보내기 전에 끊었다


def test_pinned_backend_works_over_a_real_local_socket(monkeypatch):
    """실제 소켓으로 끝까지: 이 컴퓨터 안의 임시 서버(127.0.0.1, 빈 포트)에 연결한다. 이 테스트에서만 그 주소 하나를 허용한다.
    검사한 IP 로 연결하고, 요청 머리글의 Host 는 원래 이름이며, 허용하지 않으면 같은 서버에 아무것도 보내지 않는다."""
    import http.server
    import threading

    seen = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append((self.path, self.headers.get("Host")))
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    resolve = lambda h, p: ["127.0.0.1"] if h == "local.test" else []  # noqa: E731
    try:
        with httpx.Client(transport=fx.GuardedTransport(resolve=resolve), trust_env=False, timeout=5) as c:
            with pytest.raises(fx.BlockedAddress):
                c.get(f"http://local.test:{port}/a")
            assert seen == []  # 막으면 연결조차 하지 않는다
            real = fx.blocked_ip
            monkeypatch.setattr(fx, "blocked_ip", lambda ip: False if str(ip) == "127.0.0.1" else real(ip))
            r = c.get(f"http://local.test:{port}/b")
        assert r.status_code == 200 and r.text == "ok" and seen == [("/b", f"local.test:{port}")]
    finally:
        srv.shutdown()
        srv.server_close()


def test_default_fetcher_and_document_client_use_the_pinned_backend(monkeypatch, sockets):
    calls, _, _ = sockets
    f = fx.Fetcher()
    try:
        assert isinstance(f._http._transport, fx.GuardedTransport)
        assert isinstance(f._http._transport._inner._pool._network_backend, fx._PinnedBackend)
        assert f._http._mounts == {}  # 환경변수 프록시를 쓰지 않는다(trust_env=False)
    finally:
        f.close()
    # 공고문 받기: 기업마당 주소라도 DNS 답이 내부망이면 열지 않는다
    monkeypatch.setattr(fx, "system_resolve", lambda h, p: ["10.0.0.1"])
    with pytest.raises(docs.DocumentError) as e:
        docs.fetch_document("https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=F&fileSn=0")
    assert "내부망" in str(e.value) and calls == []


def test_proxy_env_is_ignored(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:3128")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:3128")
    f = fx.Fetcher(transport=httpx.MockTransport(Site({("news.example", "/a"): page()})), resolve=fake_dns)
    try:
        assert f._http._mounts == {} and f.fetch("https://news.example/a")["ok"]
    finally:
        f.close()


def test_document_errors_carry_no_exception_names():
    def refuse(req):
        raise httpx.ConnectError("[Errno 61] Connection refused to 10.0.0.1", request=req)

    with pytest.raises(docs.DocumentError) as e:
        docs.fetch_document("https://www.bizinfo.go.kr/x", transport=httpx.MockTransport(refuse))
    assert str(e.value) == "공고문 서버에 연결하지 못했습니다"


# ---------------------------------------------------------------- 접속 주소별 요청 제한

# 모두 요청 모양 검사(422)에서 끝나 분석·유료 호출로 이어지지 않는 요청이다. 제한은 모양 검사보다 먼저 센다.
POSTS = [("/api/analysis", {"name": "가"}), ("/api/analysis/" + "a" * 32 + "/sections/nope", {}),
         ("/api/notice/analyze", {"programId": "../x", "company": {}}), ("/api/gp/brief", {"gp": "가", "company": {}})]


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    c = Clock()
    api_main._rate_limiter.reset(6, clock=c)
    return c


def post(client, i, xff=None):
    path, body = POSTS[i % len(POSTS)]
    return client.post(path, json=body, headers={"x-forwarded-for": xff} if xff else {})


def test_four_post_paths_share_a_per_address_limit(clock):
    client = TestClient(api_main.app)
    codes = [post(client, i, "203.0.113.7").status_code for i in range(6)]
    assert 429 not in codes
    res = post(client, 6, "203.0.113.7")
    body = res.json()
    assert res.status_code == 429 and body["code"] == "rate_limited" and body["detail"] == api_main.RATE_LIMIT_MESSAGE
    TypeAdapter(C.ApiError).validate_python(body, strict=True)
    retry = datetime.fromisoformat(body["retryAt"])
    assert retry.utcoffset() == timedelta(hours=9) and 55 <= (retry - datetime.now(L.KST)).total_seconds() <= 61
    assert res.headers["retry-after"] == "60"
    assert post(client, 0, "203.0.113.8").status_code != 429  # 다른 주소는 따로 센다
    assert client.get("/api/health", headers={"x-forwarded-for": "203.0.113.7"}).status_code == 200  # GET 은 세지 않는다
    clock.t += 61  # 60초가 지나면 다시 받는다
    assert post(client, 1, "203.0.113.7").status_code != 429


def test_last_forwarded_value_is_used_so_spoofed_first_values_do_not_help(clock):
    client = TestClient(api_main.app)
    for i in range(6):  # 접속자가 맨 앞에 아무 값이나 넣어도, 터널이 맨 뒤에 붙인 실제 주소로 센다
        assert post(client, i, f"10.0.0.{i}, 198.51.100.20").status_code != 429
    assert post(client, 0, "1.2.3.4, 198.51.100.20").status_code == 429
    assert post(client, 0, "198.51.100.20, 1.2.3.4").status_code != 429  # 맨 뒤 값이 다르면 다른 주소


def test_client_key_normalizes_addresses():
    class H(dict):
        def getlist(self, k):
            v = self.get(k)
            return v if isinstance(v, list) else ([v] if v else [])

    assert api_main.client_key(H({"x-forwarded-for": "a, 203.0.113.9 "}), "127.0.0.1") == "203.0.113.9"
    assert api_main.client_key(H({"x-forwarded-for": ["1.1.1.1", "203.0.113.9:5555"]}), "127.0.0.1") == "203.0.113.9"
    assert api_main.client_key(H({"x-forwarded-for": "::ffff:127.0.0.1"}), None) == "127.0.0.1"
    a = api_main.client_key(H({"x-forwarded-for": "2001:db8:1:2::1"}), None)
    b = api_main.client_key(H({"x-forwarded-for": "[2001:db8:1:2:ffff::9]:443"}), None)
    assert a == b == "2001:db8:1:2::/64"  # IPv6 는 /64 로 묶는다
    assert api_main.client_key(H({"x-forwarded-for": "unknown"}), "127.0.0.1") == "127.0.0.1"  # 주소 모양이 아니면 연결 주소
    assert api_main.client_key(H({}), "192.0.2.4") == "192.0.2.4"


def test_rate_limit_env_override(monkeypatch, clock):
    monkeypatch.setenv("GROWTH_RATE_LIMIT_PER_MINUTE", "2")
    api_main._rate_limiter.reset(clock=clock)
    client = TestClient(api_main.app)
    assert [post(client, i, "203.0.113.1").status_code == 429 for i in range(3)] == [False, False, True]


def test_lookup_and_get_paths_are_not_rate_limited(clock, monkeypatch):
    monkeypatch.setattr(api_main.config, "resolve_api_key", lambda: (None, None))
    client = TestClient(api_main.app)
    assert all(client.post("/api/company/lookup", json={"name": "가나다"}).status_code == 503 for _ in range(8))


# ---------------------------------------------------------------- 오류 본문

SECRET = "sk-live-0123456789abcdef"


def assert_api_error(res, status, code):
    body = res.json()
    assert res.status_code == status, res.text
    TypeAdapter(C.ApiError).validate_python(body, strict=True)
    assert body["code"] == code
    return body


def test_unknown_path_and_method_use_contract_error_shape():
    client = TestClient(api_main.app)
    body = assert_api_error(client.get("/api/nope"), 404, "not_found")
    assert body["detail"] == "없는 경로입니다" and body["retryAt"] is None
    assert_api_error(client.delete("/api/health"), 405, "not_found")


def test_validation_error_keeps_fastapi_default_shape():
    res = TestClient(api_main.app).post("/api/gp/brief", json={"gp": "가"})
    assert res.status_code == 422 and isinstance(res.json()["detail"], list)


def test_unhandled_exception_returns_internal_without_details(monkeypatch):
    def boom():
        raise RuntimeError(f"/Users/someone/secret/path.py {SECRET} LINER_API_KEY")

    monkeypatch.setattr(api_main, "programs", boom)
    res = TestClient(api_main.app, raise_server_exceptions=False).post(
        "/api/notice/analyze", json={"programId": "PBLN_000000000000001", "company": {}})
    body = assert_api_error(res, 500, "internal")
    for leak in ("RuntimeError", "/Users", SECRET, "LINER_API_KEY", "Traceback", "path.py"):
        assert leak not in res.text


def test_upstream_and_config_errors_hide_upstream_text_and_key_names(monkeypatch, tmp_path):
    program = {"id": "PBLN_000000000000001", "title": "공고", "url": "https://www.bizinfo.go.kr/p",
               "docUrl": "https://www.bizinfo.go.kr/f"}
    monkeypatch.setattr(api_main, "_programs", {program["id"]: program})
    monkeypatch.setattr(api_main, "_funds_by_gp", {"가나벤처스": [{"name": "가나 1호", "field": "AI", "year": 2024}]})
    monkeypatch.setattr(api_main, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(api_main.service.docs, "fetch_document", lambda url: b"x")
    client = TestClient(api_main.app)

    monkeypatch.setattr(api_main.config, "resolve_api_key", lambda: (None, None))
    for path, body in (("/api/notice/analyze", {"programId": program["id"], "company": {}}), ("/api/gp/brief", {"gp": "가나벤처스", "company": {}})):
        b = assert_api_error(client.post(path, json=body), 503, "missing_config")
        assert "LINER_API_KEY" not in b["detail"] and "Liner" in b["detail"]

    monkeypatch.setattr(api_main.config, "resolve_api_key", lambda: (SECRET, "env"))
    upstream = httpx.MockTransport(lambda req: httpx.Response(402, json={"error": {"message": f"Insufficient credits for key {SECRET} at /internal/billing"}}))
    monkeypatch.setattr(api_main, "LinerClient", lambda key, source, limits: LinerClient(key, source, transport=upstream, limits=limits))
    res = client.post("/api/gp/brief", json={"gp": "가나벤처스", "company": {}})
    b = assert_api_error(res, 502, "upstream_error")
    assert "HTTP 402" in b["detail"] and "Insufficient" not in res.text and SECRET not in res.text and "/internal" not in res.text
    assert L.usage_today()["apis"][L.LINER_SEARCH] == {"used": 1, "limit": 500, "remaining": 499}  # 실패한 요청도 센다

    b = assert_api_error(client.post("/api/notice/analyze", json={"programId": "PBLN_999999", "company": {}}), 404, "not_found")
    assert b["detail"] == "스냅샷에 없는 공고입니다"
    b = assert_api_error(client.post("/api/notice/analyze", json={"programId": program["id"], "company": {}}), 422, "analysis_failed")
    assert b["detail"].startswith("공고문을 읽지 못했습니다")
