"""공고문 파일을 받아 글자로 바꾼다. PDF 와 HWPX 를 지원한다."""
from __future__ import annotations

import io
import re
import zipfile
from urllib.parse import urlparse
from xml.etree import ElementTree

import httpx

from fetcher import BlockedAddress, GuardedTransport

MAX_BYTES = 15_000_000
ALLOWED_HOSTS = {"www.bizinfo.go.kr", "bizinfo.go.kr"}
USER_AGENT = "FundingNoteBot/0.1 (+public notice reader)"


class DocumentError(Exception):
    pass


def detect_kind(data: bytes) -> str:
    if data[:5] == b"%PDF-":
        return "pdf"
    if data[:2] == b"PK":
        return "hwpx"
    if data[:8] == bytes.fromhex("d0cf11e0a1b11ae1"):
        return "hwp"
    return "unknown"


def fetch_document(url: str, *, transport: httpx.BaseTransport | None = None, timeout: float = 40.0) -> bytes:
    """기업마당에 올라온 공고문 파일만 받는다. 스냅샷의 주소를 그대로 쓰므로 호스트를 제한한다.
    요청은 fetcher.GuardedTransport(내부망 차단, 연결한 IP 확인)를 거치고, 환경변수 프록시는 쓰지 않는다."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise DocumentError(f"허용되지 않은 주소: {parsed.scheme}://{parsed.hostname}")
    chunks, size = [], 0
    try:
        with httpx.Client(transport=GuardedTransport(transport), timeout=timeout, follow_redirects=False,
                          trust_env=False, headers={"User-Agent": USER_AGENT}) as http:
            with http.stream("GET", url) as resp:
                if resp.status_code != 200:
                    raise DocumentError(f"HTTP {resp.status_code}")
                for chunk in resp.iter_bytes():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise DocumentError("파일이 너무 큽니다")
                    chunks.append(chunk)
    except httpx.TimeoutException as exc:
        raise DocumentError("공고문 서버가 제때 응답하지 않았습니다") from exc
    except BlockedAddress as exc:
        raise DocumentError("공고문 주소가 내부망을 가리켜 열지 않았습니다") from exc
    except httpx.HTTPError as exc:  # 연결 실패, 중간 끊김 등. 응답에 실리므로 예외 이름·메시지(주소가 들어 있을 수 있음)는 넣지 않는다
        raise DocumentError("공고문 서버에 연결하지 못했습니다") from exc
    return b"".join(chunks)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _hwpx_paragraph(el: ElementTree.Element, lines: list[str]) -> None:
    """문단 하나의 글자를 한 줄로 모은다. 표 안의 문단은 따로 줄을 만든다."""
    buf: list[str] = []

    def collect(node: ElementTree.Element) -> None:
        for child in node:
            name = _local(child.tag)
            if name == "p":
                _hwpx_paragraph(child, lines)
            elif name == "t":
                buf.append("".join(child.itertext()))
            else:
                collect(child)

    collect(el)
    line = "".join(buf).strip()
    if line:
        lines.append(line)


def _hwpx_walk(el: ElementTree.Element, lines: list[str]) -> None:
    for child in el:
        if _local(child.tag) == "p":
            _hwpx_paragraph(child, lines)
        else:
            _hwpx_walk(child, lines)


def hwpx_text(data: bytes) -> str:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise DocumentError("HWPX 압축을 열 수 없습니다") from exc
    # section2 가 section10 보다 먼저 오도록 번호로 정렬한다(글자순이면 순서가 뒤바뀐다)
    names = sorted((n for n in zf.namelist() if re.fullmatch(r"Contents/section\d+\.xml", n)),
                   key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
    if not names:
        raise DocumentError("HWPX 본문(section)을 찾지 못했습니다")
    lines: list[str] = []
    for name in names:
        info = zf.getinfo(name)
        if info.file_size > MAX_BYTES:
            raise DocumentError("HWPX 본문이 너무 큽니다")
        try:
            root = ElementTree.fromstring(zf.read(name))
        except ElementTree.ParseError as exc:
            raise DocumentError("HWPX 본문을 해석하지 못했습니다") from exc
        _hwpx_walk(root, lines)
    return "\n".join(lines)


def pdf_text(data: bytes) -> tuple[str, int]:
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError

    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
    except (PyPdfError, ValueError, KeyError) as exc:
        raise DocumentError("PDF 를 읽지 못했습니다") from exc
    return "\n\n".join(pages), len(pages)


def extract_text(data: bytes) -> dict:
    """{'kind', 'text', 'pages'} 를 돌려준다. 글자를 뽑을 수 없는 형식이면 DocumentError."""
    kind = detect_kind(data)
    if kind == "pdf":
        text, pages = pdf_text(data)
    elif kind == "hwpx":
        text, pages = hwpx_text(data), None
    else:
        raise DocumentError(f"지원하지 않는 형식: {kind}")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(re.sub(r"\s", "", text)) < 50:
        raise DocumentError("글자를 거의 뽑지 못했습니다(스캔 문서일 수 있음)")
    return {"kind": kind, "text": text, "pages": pages}
