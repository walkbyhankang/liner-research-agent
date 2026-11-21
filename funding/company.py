"""회사 정보를 대조용 글로 바꾼다. 입력은 화면에서 직접 넣은 값이거나 기업분석 엔진이 채운 값이다."""
from __future__ import annotations

from datetime import date

BIZ_LABEL = {"venture": "창업·벤처기업", "sme": "중소기업", "micro": "소상공인"}
EMPTY = "정보 없음"


def business_age(founded: str | None, today: date | None = None) -> str | None:
    """'YYYY-MM' 설립연월에서 '업력 3년 2개월' 같은 표현을 만든다. 형식이 맞지 않으면 None."""
    if not founded:
        return None
    try:
        year, month = (int(x) for x in founded.split("-")[:2])
        start = date(year, month, 1)
    except (ValueError, TypeError):
        return None
    today = today or date.today()
    months = (today.year - start.year) * 12 + (today.month - start.month)
    if months < 0:
        return None
    return f"업력 {months // 12}년 {months % 12}개월"


def describe(company: dict, today: date | None = None) -> str:
    """모델에 넘길 회사 설명. 값이 없는 항목은 '정보 없음'으로 적어 모델이 추측하지 않게 한다."""
    age = business_age(company.get("founded"), today)
    founded = f"{company['founded']} ({age})" if age else EMPTY
    lines = [
        f"- 회사명: {company.get('name') or EMPTY}",
        f"- 본사 소재지: {company.get('region') or EMPTY}",
        f"- 기업 유형: {BIZ_LABEL.get(company.get('biz') or '', EMPTY)}",
        f"- 설립: {founded}",
        f"- 업종: {company.get('industry') or EMPTY}",
        f"- 상시근로자 수: {company.get('employees') or EMPTY}",
        f"- 최근 연매출: {company.get('revenue') or EMPTY}",
        f"- 필요한 자금: {company.get('need') or EMPTY}",
        f"- 그 밖의 사항: {company.get('notes') or EMPTY}",
    ]
    return "\n".join(lines)
