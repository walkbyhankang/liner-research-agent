"""공개 원문 확인: robots.txt 준수, 유료/차단 페이지 우회 금지, 실패 사유 기록.

외부 페이지의 문장은 항상 '데이터'이다. 페이지 안의 명령문은 실행하지 않으며 모델 입력에도
'[원문 발췌: 데이터]' 로 감싸 전달한다(프롬프트 인젝션 방지).
"""
from __future__ import annotations

import re
import urllib.robotparser
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlparse

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


class Fetcher:
    def __init__(self, *, transport: httpx.BaseTransport | None = None, max_pages: int | None = None,
                 timeout: float | None = None, max_bytes: int | None = None) -> None:
        self._http = httpx.Client(transport=transport, follow_redirects=True, timeout=timeout or config.FETCH_TIMEOUT,
                                  headers={"User-Agent": config.FETCH_USER_AGENT,
                                           "Accept": "text/html,application/xhtml+xml"})
        self.max_pages = config.FETCH_MAX_PAGES if max_pages is None else max_pages
        self.max_bytes = max_bytes or config.FETCH_MAX_BYTES
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self.fetched = 0
        self.log: list[dict] = []

    def close(self) -> None:
        self._http.close()

    def _allowed(self, url: str) -> tuple[bool, str]:
        p = urlparse(url)
        base = f"{p.scheme}://{p.netloc}"
        if base not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self._http.get(base + "/robots.txt")
                if r.status_code == 200:
                    rp.parse(r.text.splitlines())
                    self._robots[base] = rp
                elif r.status_code in (401, 403):
                    self._robots[base] = None  # 접근 자체를 제한 → 차단으로 간주
                    return False, "robots.txt 접근 제한(차단으로 간주)"
                else:
                    self._robots[base] = rp  # robots 없음 = 허용
                    rp.parse([])
            except httpx.HTTPError:
                rp.parse([])
                self._robots[base] = rp
        rp = self._robots[base]
        if rp is None:
            return False, "robots.txt 접근 제한(차단으로 간주)"
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
                    with self._http.stream("GET", url) as r:
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
