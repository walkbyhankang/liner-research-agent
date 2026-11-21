"""공고문 추출·검증·대조 모듈 테스트. 실제 API 는 호출하지 않는다(httpx.MockTransport)."""
import io
import json
import sys
import zipfile
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402
from funding import docs, notice  # noqa: E402
from liner_client import LinerClient, extract_chat_text  # noqa: E402

HWPX_SECTION = """<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p><hp:run><hp:t>대전광역시 공고 제2026-1호</hp:t></hp:run></hp:p>
  <hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList>
    <hp:p><hp:run><hp:t>지원규모 : 업체당 </hp:t></hp:run><hp:run><hp:t>5억원 이내</hp:t></hp:run></hp:p>
  </hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>
  <hp:p><hp:run><hp:t>신청일 현재 지방세, 국세 체납 사실이 있는 기업은 제외한다. 완납 후 신청할 수 있다.</hp:t></hp:run></hp:p>
</hs:sec>"""


def make_hwpx(section: str = HWPX_SECTION) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/hwp+zip")
        zf.writestr("Contents/section0.xml", section)
    return buf.getvalue()


def test_detect_kind():
    assert docs.detect_kind(b"%PDF-1.7 ...") == "pdf"
    assert docs.detect_kind(make_hwpx()) == "hwpx"
    assert docs.detect_kind(bytes.fromhex("d0cf11e0a1b11ae1") + b"x") == "hwp"
    assert docs.detect_kind(b"<html>") == "unknown"


def test_hwpx_text_keeps_paragraphs_and_table_cells():
    out = docs.extract_text(make_hwpx())
    assert out["kind"] == "hwpx"
    lines = out["text"].split("\n")
    assert lines[0] == "대전광역시 공고 제2026-1호"
    assert "지원규모 : 업체당 5억원 이내" in lines
    assert any("체납" in line for line in lines)


def test_extract_text_rejects_unsupported_and_empty():
    with pytest.raises(docs.DocumentError):
        docs.extract_text(b"<html>not a document</html>")
    with pytest.raises(docs.DocumentError):
        docs.extract_text(make_hwpx(HWPX_SECTION.split("<hp:p>")[0] + "</hs:sec>"))


def test_fetch_document_only_allows_bizinfo_https():
    called = []
    transport = httpx.MockTransport(lambda req: called.append(req) or httpx.Response(200, content=b"%PDF-1.7"))
    for url in ("http://www.bizinfo.go.kr/a", "https://example.com/a", "https://www.bizinfo.go.kr.evil.com/a", "file:///etc/passwd"):
        with pytest.raises(docs.DocumentError):
            docs.fetch_document(url, transport=transport)
    assert called == []
    assert docs.fetch_document("https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=F&fileSn=0", transport=transport) == b"%PDF-1.7"
    assert len(called) == 1


def test_fetch_document_errors_on_bad_status():
    transport = httpx.MockTransport(lambda req: httpx.Response(404))
    with pytest.raises(docs.DocumentError):
        docs.fetch_document("https://www.bizinfo.go.kr/x", transport=transport)


def test_verify_quotes_ignores_line_breaks_and_punctuation_variants():
    text = "가. 대전광역시에 본사 또는 사업장을 소재한 「중소기업기본법」상\n중소기업으로 별첨1 업종\n업체당 5억원 이내ㆍ소요자금의 75% 지원"
    conds = [
        {"field": "지역", "requirement": "대전 소재", "quote": "대전광역시에 본사 또는 사업장을 소재한 「중소기업기본법」상 중소기업"},
        {"field": "지원한도", "requirement": "5억 이내", "quote": "업체당 5억원 이내·소요자금의 75% 지원"},
        {"field": "업력", "requirement": "7년 미만", "quote": "업력 7년 미만 창업기업"},
        {"field": "기간", "requirement": "짧은 근거", "quote": "⑨｢"},
    ]
    assert [c["status"] for c in notice.verify_quotes(conds, text)] == ["확인됨", "확인됨", "원문 미확인", "원문 미확인"]


def test_clean_conditions_drops_malformed_rows():
    raw = {"conditions": [
        {"field": "지역", "requirement": " 대전 ", "quote": " 대전광역시 "},
        {"field": "없는항목", "requirement": "x", "quote": "y"},
        {"field": "업력", "requirement": "", "quote": "y"},
        "문자열", {"field": "업종"},
    ]}
    assert notice.clean_conditions(raw) == [{"field": "지역", "requirement": "대전", "quote": "대전광역시"}]
    assert notice.clean_conditions(None) == []


def test_parse_json_accepts_fenced_and_rejects_non_objects():
    assert notice.parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert notice.parse_json('{"a": 1}') == {"a": 1}
    assert notice.parse_json("[1, 2]") is None
    assert notice.parse_json("설명 문장") is None


def test_clean_match_keeps_only_valid_checks():
    raw = {"overall": "확인 후 판단", "overall_reason": "이유", "checks": [
        {"index": 0, "verdict": "충족", "reason": "r"}, {"index": 5, "verdict": "충족", "reason": "범위 밖"},
        {"index": 1, "verdict": "점수 90", "reason": "없는 판정"}, {"index": "0", "verdict": "충족"},
    ], "questions": ["q1", "", 3, "q2"], "documents": ["d1"]}
    out = notice.clean_match(raw, 2)
    assert out["checks"] == [{"index": 0, "verdict": "충족", "reason": "r"}]
    assert out["questions"] == ["q1", "q2"] and out["documents"] == ["d1"]
    assert notice.clean_match({"overall": "선정 확률 80%"}, 2) is None
    assert notice.clean_match(None, 2) is None


def test_build_extract_user_truncates_long_notice():
    user, truncated = notice.build_extract_user("공고", "가" * (notice.MAX_NOTICE_CHARS + 10))
    assert truncated is True and user.count("가") == notice.MAX_NOTICE_CHARS
    assert notice.build_extract_user("공고", "짧은 글")[1] is False


def test_schemas_are_strict():
    for schema in (notice.EXTRACT_SCHEMA, notice.MATCH_SCHEMA):
        assert schema["additionalProperties"] is False
        assert set(schema["required"]) == set(schema["properties"])


def test_chat_json_sends_schema_and_records_actual_cost():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["path"] = req.url.path
        seen["key"] = req.headers.get("x-api-key")
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={
            "id": "chat_1", "model": "anthropic/claude-opus-5.5",
            "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": '{"ok": true}'}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 8, "total_tokens": 128, "cost": 0.00064},
        })

    client = LinerClient("test-key-123", transport=httpx.MockTransport(handler))
    data, rec = client.chat_json("anthropic/claude-opus-5.5", "시스템", "사용자", schema={"type": "object"}, schema_name="s")
    assert seen["path"] == config.CHAT_COMPLETIONS_PATH and seen["key"] == "test-key-123"
    assert seen["body"]["model"] == "anthropic/claude-opus-5.5"
    assert seen["body"]["response_format"] == {"type": "json_schema", "json_schema": {"name": "s", "strict": True, "schema": {"type": "object"}}}
    assert [m["role"] for m in seen["body"]["messages"]] == ["system", "user"]
    assert extract_chat_text(data) == '{"ok": true}'
    assert (rec["input_tokens"], rec["output_tokens"], rec["cost_usd"], rec["response_model"]) == (120, 8, 0.00064, "anthropic/claude-opus-5.5")
    assert "test-key-123" not in json.dumps(client.calls, ensure_ascii=False)
    assert client.usage()["model"]["used"] == 1


def test_extract_chat_text_handles_missing_choices():
    assert extract_chat_text({}) == ""
    assert extract_chat_text({"choices": [None]}) == ""


class _BrokenStream(httpx.SyncByteStream):
    def __iter__(self):
        yield b"%PDF-1.7 part"
        raise httpx.ReadTimeout("stalled")


def test_fetch_document_turns_transport_failures_into_document_errors():
    url = "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=SECRETID&fileSn=0"

    def refuse(req):
        raise httpx.ConnectError("connection refused", request=req)

    with pytest.raises(docs.DocumentError) as e:
        docs.fetch_document(url, transport=httpx.MockTransport(refuse))
    assert "연결하지 못했습니다" in str(e.value) and "SECRETID" not in str(e.value)

    def stall_before_headers(req):
        raise httpx.ConnectTimeout("timed out", request=req)

    with pytest.raises(docs.DocumentError) as e:
        docs.fetch_document(url, transport=httpx.MockTransport(stall_before_headers))
    assert "제때 응답하지 않았습니다" in str(e.value)

    with pytest.raises(docs.DocumentError) as e:
        docs.fetch_document(url, transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=_BrokenStream())))
    assert "제때 응답하지 않았습니다" in str(e.value)


def test_hwpx_sections_are_read_in_numeric_order():
    def section(text):
        return ('<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">'
                f"<hp:p><hp:run><hp:t>{text}</hp:t></hp:run></hp:p></hs:sec>")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i in (10, 2, 0, 1, 11):  # 넣는 순서와 무관하게 번호 순으로 읽어야 한다
            zf.writestr(f"Contents/section{i}.xml", section(f"구역 {i}번의 본문 내용입니다. 신청 자격과 지원 조건을 적습니다."))
    lines = docs.hwpx_text(buf.getvalue()).split("\n")
    assert [line.split("번")[0] for line in lines] == ["구역 0", "구역 1", "구역 2", "구역 10", "구역 11"]
