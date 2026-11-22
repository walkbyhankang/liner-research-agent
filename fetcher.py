"""공개 원문 확인: robots.txt 준수, 유료/차단 페이지 우회 금지, 실패 사유 기록, 내부망 차단.

외부 페이지의 문장은 항상 '데이터'이다. 페이지 안의 명령문은 실행하지 않으며 모델 입력에도
'[원문 발췌: 데이터]' 로 감싸 전달한다(프롬프트 인젝션 방지).

내부망 차단(설계 10.3): 검색 결과·외부 자료에서 온 주소를 열 때 이 컴퓨터나 같은 네트워크의 기기(공유기 관리 화면,
127.0.0.1:8000 분석 서버 등)로 요청이 가지 않게 한다. Fetcher 가 여는 요청(robots.txt, 리다이렉트 한 단계마다 포함)은 모두
GuardedTransport 를 거친다.
  1. 요청 직전: 스킴은 http·https 만, 호스트를 해석해 사설·루프백·링크 로컬·멀티캐스트·예약·미지정·CGNAT·IPv6 ULA·
     IPv4 대응 IPv6 주소면 막는다(check_url).
  2. 연결 순간: 실제 네트워크 계층(_PinnedBackend)이 호스트를 다시 해석해 검사하고, 검사한 그 IP 로만 연결한다.
     그래서 검사와 연결 사이에 DNS 답이 바뀌는 재바인딩도 막는다. 연결된 상대 주소(getpeername)도 한 번 더 본다.
     TLS 인증서는 원래 호스트 이름으로 검사한다(httpcore 가 server_hostname 에 원래 이름을 쓴다).
  3. 리다이렉트는 자동으로 따라가지 않고 한 단계마다 1·2를 다시 거친다(최대 MAX_REDIRECTS 단계).
  환경변수 프록시(HTTP_PROXY 등)는 쓰지 않는다(trust_env=False). 프록시를 거치면 1·2 검사가 프록시 연결에만 걸리기 때문이다.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import urllib.robotparser
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Callable
from urllib.parse import urlparse

import httpcore
import httpx

import config
import sources as src

PAYWALL_HINTS = ("구독 후", "유료회원", "유료 회원", "로그인 후", "로그인이 필요", "subscribe to read",
                 "subscribers only", "paywall", "sign in to continue", "premium content", "멤버십 가입")
SKIP_EXT = (".pdf", ".hwp", ".hwpx", ".xls", ".xlsx", ".doc", ".docx", ".ppt", ".pptx", ".zip", ".png", ".jpg",
            ".jpeg", ".gif", ".mp4")
INJECTION_PAT = re.compile(r"(ignore (all |any )?(previous|prior) instructions|이전 지시.{0,6}무시|시스템 프롬프트|"
                           r"system prompt|you are now|api[_ ]?key)", re.I)


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "aside", "iframe"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self.meta: dict[str, str] = {}
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            k = (a.get("property") or a.get("name") or "").lower()
            if k and a.get("content"):
                self.meta[k] = a["content"]
        elif tag in ("p", "br", "li", "tr", "h1", "h2", "h3", "h4", "div", "section", "article"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip and data.strip():
            self.parts.append(data.strip() + " ")


def extract_text(html: str) -> dict:
    p = _TextExtractor()
    try:
        p.feed(html)
    except Exception:  # 잘못된 HTML 도 최대한 처리
        pass
    text = re.sub(r"[ \t]+", " ", "".join(p.parts))
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    pub = next((p.meta[k] for k in ("article:published_time", "og:article:published_time", "date", "pubdate",
                                    "datepublished", "article:modified_time") if k in p.meta), None)
    return {"title": (p.meta.get("og:title") or p.title or "").strip(), "text": text, "published": pub}


# ---------- 내부망 차단 ----------
MAX_REDIRECTS = 5              # 리다이렉트는 이 단계까지만 따라간다(단계마다 다시 검사)
ROBOTS_MAX_BYTES = 512_000     # robots.txt 는 이만큼만 읽는다
MAX_ADDRESSES = 4              # 호스트 하나에 연결을 시도하는 주소 수
BLOCKED_REASON = "내부망·예약 주소로 가는 요청이라 열지 않음"

# ipaddress 의 is_global 판정은 Python 버전마다 조금씩 달라서, 막을 대역을 직접 적고 is_* 검사와 함께 쓴다.
_BLOCKED_NETS = tuple(ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
    "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
    "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
    "::/128", "::1/128", "::/96", "::ffff:0:0/96", "::ffff:0:0:0/96", "64:ff9b:1::/48", "100::/64", "2001::/23",
    "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
))
_NAT64 = ipaddress.ip_network("64:ff9b::/96")   # 공용 NAT64: 끝 32비트의 IPv4 주소로 판정한다
_V4_LITERAL = re.compile(r"[0-9a-fx.]+")         # 127.1, 0x7f.1, 2130706433 같은 옛 IPv4 표기도 IP 로 본다

Resolver = Callable[[str, int], list[str]]


class BlockedAddress(httpx.RequestError):
    """내부망·예약 주소이거나 http·https 가 아니라 요청하지 않았다. httpx.HTTPError 이기도 해서 기존 코드는 연결 실패처럼 다룬다."""


def system_resolve(host: str, port: int) -> list[str]:
    """운영체제 DNS 로 호스트의 IP 주소들을 얻는다(중복 제거, 받은 순서)."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """공개 인터넷 주소가 아니면 True. IPv4 대응 IPv6(::ffff:a.b.c.d)와 옛 IPv4 호환(::a.b.c.d)은 늘 막는다."""
    if ip.version == 6 and ip in _NAT64:
        return blocked_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    if any(ip in net for net in _BLOCKED_NETS if net.version == ip.version):
        return True
    return (not ip.is_global or ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
            or ip.is_reserved or ip.is_unspecified or (ip.version == 6 and ip.is_site_local))


def _literal_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    if _V4_LITERAL.fullmatch(host) and any(c.isdigit() for c in host):
        try:
            return ipaddress.IPv4Address(socket.inet_aton(host))
        except OSError:
            return None
    return None


def check_host(host: str, port: int, resolve: Resolver | None) -> list[str]:
    """호스트가 공개 주소인지 본다. 막을 주소면 BlockedAddress, 해석하지 못하면 httpx.ConnectError.
    resolve 가 None 이면 DNS 를 묻지 않고 IP 표기·localhost 만 본다(가짜 transport 로 시험할 때). 검사를 통과한 IP 목록을 돌려준다."""
    h = (host or "").strip().rstrip(".").lower()
    if not h:
        raise BlockedAddress("호스트가 없는 주소")
    if h == "localhost" or h.endswith(".localhost"):
        raise BlockedAddress(BLOCKED_REASON)
    literal = _literal_ip(h)
    if literal is not None:
        if blocked_ip(literal):
            raise BlockedAddress(BLOCKED_REASON)
        return [str(literal)]
    if resolve is None:
        return []
    try:
        addrs = resolve(h, port)
    except (OSError, UnicodeError) as exc:
        raise httpx.ConnectError("주소를 찾지 못했습니다") from exc
    if not addrs:
        raise httpx.ConnectError("주소를 찾지 못했습니다")
    for a in addrs:
        try:
            ip = ipaddress.ip_address(str(a))
        except ValueError as exc:
            raise BlockedAddress(BLOCKED_REASON) from exc
        if blocked_ip(ip):   # 여러 주소 중 하나라도 내부망이면 통째로 막는다(섞어 보내는 DNS 답 대비)
            raise BlockedAddress(BLOCKED_REASON)
    return [str(a) for a in addrs]


def check_url(url: str | httpx.URL, resolve: Resolver | None = system_resolve) -> None:
    """요청 직전 검사: http·https 만, 호스트가 공개 주소일 때만 통과. 막으면 BlockedAddress."""
    try:
        u = url if isinstance(url, httpx.URL) else httpx.URL(str(url))
    except (httpx.InvalidURL, TypeError, ValueError) as exc:
        raise BlockedAddress("주소 형식이 올바르지 않음") from exc
    if u.scheme not in ("http", "https"):
        raise BlockedAddress("http·https 주소만 엽니다")
    check_host(u.raw_host.decode("ascii", "replace"), u.port or (443 if u.scheme == "https" else 80), resolve)


class _PinnedBackend(httpcore.NetworkBackend):
    """연결하는 순간 호스트를 다시 해석해 검사하고, 검사한 IP 로만 연결한다(DNS 재바인딩 대비). 연결된 상대 주소도 한 번 더 본다."""

    def __init__(self, resolve: Resolver):
        self._resolve = resolve
        self._inner = httpcore.SyncBackend()

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            addrs = check_host(host, port, self._resolve)
        except httpx.ConnectError as exc:
            raise httpcore.ConnectError(str(exc)) from exc
        last: Exception | None = None
        for ip in addrs[:MAX_ADDRESSES]:
            try:
                stream = self._inner.connect_tcp(ip, port, timeout=timeout, local_address=local_address,
                                                 socket_options=socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last = exc
                continue
            peer = stream.get_extra_info("server_addr")
            try:
                peer_ip = ipaddress.ip_address(str(peer[0])) if peer else None
            except ValueError:
                peer_ip = None
            if peer_ip is None or blocked_ip(peer_ip):
                stream.close()
                raise BlockedAddress(BLOCKED_REASON)
            return stream
        raise last or httpcore.ConnectError("주소를 찾지 못했습니다")

    def connect_unix_socket(self, *args, **kwargs):
        raise BlockedAddress("유닉스 소켓으로는 열지 않음")

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


def _pinned_transport(resolve: Resolver) -> httpx.HTTPTransport:
    """실제 네트워크용 transport. httpx.HTTPTransport 의 연결 풀에 _PinnedBackend 를 끼운다.
    httpx 내부 이름(_pool._network_backend)이 바뀌면 조용히 검사를 건너뛰지 않고 바로 실패하게 한다."""
    t = httpx.HTTPTransport(trust_env=False)
    pool = getattr(t, "_pool", None)
    if not isinstance(pool, httpcore.ConnectionPool) or not hasattr(pool, "_network_backend"):
        raise RuntimeError("httpx 연결 풀 구조가 달라 내부망 차단을 걸 수 없습니다(httpx·httpcore 버전 확인)")
    pool._network_backend = _PinnedBackend(resolve)
    return t


class GuardedTransport(httpx.BaseTransport):
    """모든 요청을 check_url 로 먼저 검사하는 transport.

    inner 가 None 이면 실제 네트워크(_pinned_transport)를 쓰고 DNS 를 묻는다(resolve 기본값 system_resolve).
    inner 를 주면(시험용 가짜 transport) resolve 를 따로 줄 때만 DNS 를 흉내 내고, 주지 않으면 IP 표기·localhost 만 본다.
    """

    def __init__(self, inner: httpx.BaseTransport | None = None, *, resolve: Resolver | None = None):
        if inner is None:
            self._resolve: Resolver | None = resolve or system_resolve
            inner = _pinned_transport(self._resolve)
        else:
            self._resolve = resolve
        self._inner = inner

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        check_url(request.url, self._resolve)
        return self._inner.handle_request(request)

    def close(self) -> None:
        self._inner.close()


class _TooManyRedirects(Exception):
    pass


class _RobotsBlocked(Exception):
    pass


class Fetcher:
    """원문 확인기. 여는 요청은 모두 GuardedTransport(내부망 차단)를 거친다.

    transport 를 주면(시험용) 그 위에 같은 검사를 얹는다. 이때 DNS 는 resolve 를 줄 때만 흉내 낸다(실제 DNS 를 묻지 않는다).
    """

    def __init__(self, *, transport: httpx.BaseTransport | None = None, max_pages: int | None = None,
                 timeout: float | None = None, max_bytes: int | None = None, resolve: Resolver | None = None) -> None:
        self._http = httpx.Client(transport=GuardedTransport(transport, resolve=resolve), follow_redirects=False,
                                  trust_env=False, timeout=timeout or config.FETCH_TIMEOUT,
                                  headers={"User-Agent": config.FETCH_USER_AGENT,
                                           "Accept": "text/html,application/xhtml+xml"})
        self.max_pages = config.FETCH_MAX_PAGES if max_pages is None else max_pages
        self.max_bytes = max_bytes or config.FETCH_MAX_BYTES
        self._robots: dict[str, urllib.robotparser.RobotFileParser | str] = {}   # str 이면 막힌 사유
        self.fetched = 0
        self.log: list[dict] = []

    def close(self) -> None:
        self._http.close()

    def _send(self, url: str, *, robots: bool) -> httpx.Response:
        """GET 을 보내고 리다이렉트를 한 단계씩 직접 따라간다(최대 MAX_REDIRECTS). 응답은 본문을 읽지 않은 채로 돌려준다(호출한 쪽이 닫는다).
        단계마다 GuardedTransport 가 주소를 다시 검사하고, robots=True 이면 다른 사이트로 넘어갈 때 그 사이트의 robots.txt 도 본다."""
        request = self._http.build_request("GET", url)
        for _ in range(MAX_REDIRECTS + 1):
            resp = self._http.send(request, stream=True)
            nxt = resp.next_request
            if nxt is None:
                return resp
            resp.close()
            if robots and (nxt.url.scheme, nxt.url.host, nxt.url.port) != (request.url.scheme, request.url.host, request.url.port):
                ok, why = self._allowed(str(nxt.url))
                if not ok:
                    raise _RobotsBlocked(why)
            request = nxt
        raise _TooManyRedirects()

    def _allowed(self, url: str) -> tuple[bool, str]:
        p = urlparse(url)
        base = f"{p.scheme}://{p.netloc}"
        if base not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self._send(base + "/robots.txt", robots=False)
                try:
                    if r.status_code == 200:
                        buf = b""
                        for chunk in r.iter_bytes():
                            buf += chunk
                            if len(buf) >= ROBOTS_MAX_BYTES:
                                break
                        rp.parse(buf[:ROBOTS_MAX_BYTES].decode(r.encoding or "utf-8", errors="replace").splitlines())
                        self._robots[base] = rp
                    elif r.status_code in (401, 403):
                        self._robots[base] = "robots.txt 접근 제한(차단으로 간주)"  # 접근 자체를 제한 → 차단으로 간주
                    else:
                        self._robots[base] = rp  # robots 없음 = 허용
                        rp.parse([])
                finally:
                    r.close()
            except BlockedAddress:
                self._robots[base] = BLOCKED_REASON
            except (httpx.HTTPError, _TooManyRedirects):
                rp.parse([])
                self._robots[base] = rp
        rp = self._robots[base]
        if isinstance(rp, str):
            return False, rp
        if not rp.can_fetch(config.FETCH_USER_AGENT, url):
            return False, "robots.txt 에서 크롤링 금지"
        return True, ""

    def fetch(self, url: str) -> dict:
        """단일 URL 원문 확인 결과. 실패해도 예외 없이 상태/사유를 반환한다."""
        rec = {"url": url, "ok": False, "status": "not_attempted", "http_status": None, "reason": "",
               "title": "", "text": "", "published": None, "chars": 0, "injection_suspected": False,
               "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not p.netloc:
            rec.update(status="failed", reason="지원하지 않는 URL 형식")
        elif p.path.lower().endswith(SKIP_EXT):
            rec.update(status="unsupported", reason=f"본문 추출 미지원 형식({p.path.rsplit('.', 1)[-1]})")
        elif self.fetched >= self.max_pages:
            rec.update(status="skipped", reason=f"원문 확인 한도({self.max_pages}건) 초과")
        else:
            ok, why = self._allowed(url)
            if not ok:
                rec.update(status="blocked", reason=why)
            else:
                self.fetched += 1
                try:
                    r = self._send(url, robots=True)
                    try:
                        rec["http_status"] = r.status_code
                        ctype = r.headers.get("content-type", "").lower()
                        if r.status_code in (401, 402, 403, 451):
                            rec.update(status="blocked", reason=f"접근 거부(HTTP {r.status_code}) — 우회하지 않음")
                        elif r.status_code == 429:
                            rec.update(status="failed", reason="요청 제한(HTTP 429) — 재시도하지 않음")
                        elif r.status_code >= 400:
                            rec.update(status="failed", reason=f"HTTP {r.status_code}")
                        elif ctype and "html" not in ctype and "text" not in ctype and "xml" not in ctype:
                            rec.update(status="unsupported", reason=f"본문 추출 미지원 형식({ctype.split(';')[0]})")
                        else:
                            buf = b""
                            for chunk in r.iter_bytes():
                                buf += chunk
                                if len(buf) >= self.max_bytes:
                                    break
                            html = buf.decode(r.encoding or "utf-8", errors="replace")
                            ex = extract_text(html)
                            text = ex["text"]
                            low = text.lower()
                            if len(text) < 200:
                                rec.update(status="failed", reason="본문 추출 실패(텍스트 부족, JS 렌더링 페이지 가능)")
                            elif any(h in low for h in PAYWALL_HINTS) and len(text) < 1500:
                                rec.update(status="blocked", reason="유료/로그인 콘텐츠로 추정 — 우회하지 않음")
                            else:
                                rec.update(ok=True, status="fetched", title=ex["title"], published=ex["published"],
                                           text=text[:60000], chars=len(text),
                                           injection_suspected=bool(INJECTION_PAT.search(text)))
                    finally:
                        r.close()
                except BlockedAddress:
                    rec.update(status="blocked", reason=BLOCKED_REASON)
                except _RobotsBlocked as e:
                    rec.update(status="blocked", reason=f"{e} (리다이렉트한 곳)")
                except _TooManyRedirects:
                    rec.update(status="failed", reason=f"리다이렉트가 너무 많음({MAX_REDIRECTS}단계 초과)")
                except httpx.HTTPError as e:
                    rec.update(status="failed", reason=f"{type(e).__name__}: 연결 실패/타임아웃")
        self.log.append({k: rec[k] for k in ("url", "status", "http_status", "reason", "chars", "fetched_at")})
        return rec


# ---------- 값 검증 ----------
def _norm(s: str) -> str:
    return re.sub(r"[\s,]", "", (s or "").lower())


def value_variants(value: str) -> list[str]:
    """값 문자열에서 원문 대조용 토큰(숫자+단위, 날짜, 이름 등)을 뽑는다."""
    v = str(value or "")
    toks = set()
    for m in re.finditer(r"\d[\d,\.]*\s*(?:억|조|만|천|명|%|원|달러|USD|KRW|M|B)?", v):
        t = _norm(m.group(0))
        if len(re.sub(r"\D", "", t)) >= 2:
            toks.add(t)
    for m in re.finditer(r"(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})", v):
        y, mo, d = m.groups()
        toks.update({f"{y}년{int(mo)}월{int(d)}일", f"{y}.{int(mo):02d}.{int(d):02d}", f"{y}-{int(mo):02d}-{int(d):02d}",
                     f"{y}.{int(mo)}.{int(d)}"})
    if not toks:
        for m in re.finditer(r"[가-힣A-Za-z]{2,}(?: [가-힣A-Za-z]{2,})?", v):
            toks.add(_norm(m.group(0)))
    return sorted(toks, key=len, reverse=True)


def verify_value(value: str, page_text: str) -> tuple[bool, str]:
    """원문에 값이 실제로 나타나는지 확인한다. 반환 (일치 여부, 근거 구절)."""
    if not value or not page_text:
        return False, ""
    norm_text = _norm(page_text)
    toks = value_variants(value)
    if not toks:
        return False, ""
    hits = [t for t in toks if t in norm_text]
    need = max(1, (len(toks) + 1) // 2) if len(toks) > 1 else 1
    if len(hits) < need:
        return False, ""
    plain = re.sub(r"\s+", " ", page_text)
    compact = re.sub(r"[\s,]", "", plain.lower())
    pos = compact.find(hits[0])
    # compact 위치 → plain 위치 매핑
    count, idx = 0, 0
    for i, ch in enumerate(plain):
        if ch.isspace() or ch == ",":
            continue
        if count == pos:
            idx = i
            break
        count += 1
    return True, plain[max(0, idx - 80): idx + 120].strip()


def prioritize(sources: list[dict], per_category_cap: int | None = None) -> list[dict]:
    """원문 확인 대상 선정: 공식 → 정부 → 공시 → 언론 → VC → DB → 기타 순, 같은 순위에서는 최신순. 커뮤니티 제외."""
    cand = [s for s in sources if s.get("use") and s.get("source_type") != "community"]
    def k(s):
        d = src.parse_date(s.get("date"))
        return (src.FETCH_PRIORITY.get(s["source_type"], 9), -(d.toordinal() if d else 0))
    return sorted(cand, key=k)
