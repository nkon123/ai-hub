"""두 날짜 사이의 영업일 수를 센다 (주말 제외).

Desktop 로컬 Tool(D-084) 샘플. 표준 라이브러리만 사용하고 파일·네트워크에
접근하지 않는다. 공휴일은 계산하지 않는다 — 나라·연도마다 다르고 이 함수는
그 목록을 가질 방법이 없으므로, 있지도 않은 정확도를 주장하지 않는다.
"""

from datetime import date


def business_days_between(start_date: str, end_date: str, include_end: bool = True) -> dict:
    """start_date 부터 end_date 까지의 영업일(월~금) 수를 센다.

    날짜는 YYYY-MM-DD 형식이다. include_end 가 True 면 마지막 날을 포함한다.
    start_date 가 end_date 보다 뒤면 두 날짜를 바꿔서 계산하고 그 사실을
    반환값에 표시한다 — 조용히 0을 돌려주면 입력 실수를 알 수 없다.
    """
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)

    swapped = start > end
    if swapped:
        start, end = end, start

    last = end.toordinal() if include_end else end.toordinal() - 1
    business = 0
    total = 0
    for ordinal in range(start.toordinal(), last + 1):
        total += 1
        if date.fromordinal(ordinal).weekday() < 5:
            business += 1

    return {
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "include_end": include_end,
        "inputs_swapped": swapped,
        "total_days": total,
        "business_days": business,
        "weekend_days": total - business,
        "note": "공휴일은 반영하지 않았습니다 (주말만 제외).",
    }
