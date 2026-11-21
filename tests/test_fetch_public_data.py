"""공공 데이터 수집 스크립트의 정리 함수 테스트(네트워크 호출 없음)."""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_public_data as f  # noqa: E402


def test_safe_url_keeps_http_and_fixes_schemeless():
    assert f.safe_url("https://a.kr/x?y=1") == "https://a.kr/x?y=1"
    assert f.safe_url(" https://harus.gjep.or.kr") == "https://harus.gjep.or.kr"
    assert f.safe_url("https://untact.koreg.or.kr ") == "https://untact.koreg.or.kr"
    assert f.safe_url("www.matchingbank.career.co.kr") == "https://www.matchingbank.career.co.kr"


def test_safe_url_drops_non_web_values():
    for v in (None, "", "javascript:alert(1)", "data:text/html,x", "방문 접수", "a b.kr", "mailto:a@b.kr", "/relative/path"):
        assert f.safe_url(v) == "", v


def test_program_regions():
    assert f.program_regions("[대전] 공고", ["금융", "대전"], "대전광역시") == ["대전"]
    assert f.program_regions("공고", ["금융"], "중소벤처기업부") == ["전국"]
    assert f.program_regions("공고", ["금융"], "충청북도") == ["충북"]
    assert f.program_regions("공고", [r for r in f.REGIONS if r not in ("광주", "전남")], "충청북도") == ["전국"]
    assert f.program_regions("공고", ["전북", "제주"], "전북특별자치도") == ["전북", "제주"]


def test_period_status():
    today = date(2026, 11, 21)
    assert f.period("2026-11-19 ~ 2026-11-27", today)["status"] == "접수 중"
    assert f.period("2026-11-23 ~ 2026-12-11", today)["status"] == "접수 예정"
    assert f.period("2026-10-01 ~ 2026-11-20", today)["status"] == "마감"
    assert f.period("예산 소진시까지", today) == {"raw": "예산 소진시까지", "start": None, "end": None, "status": "수시"}
    assert f.period("", today)["status"] == "미기재"


def test_summary_and_contact_cleanup():
    intro, points = f.split_summary("<p>인사말</p><p>☞&nbsp;대상 기업</p><p>☞ 지원 내용</p>")
    assert intro == "" and points == ["대상 기업", "지원 내용"]
    intro, points = f.split_summary("<p>항목 없는 개요</p>")
    assert intro == "항목 없는 개요" and points == []
    assert f.EMAIL.sub("", "팀 032-000-0000, a.b@c.or.kr") == "팀 032-000-0000, "


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
