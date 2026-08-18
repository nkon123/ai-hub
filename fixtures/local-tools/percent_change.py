"""두 수치의 증감률과 증감폭을 계산한다.

Desktop 로컬 Tool(D-084) 샘플. 표준 라이브러리만 사용하고 파일·네트워크에
접근하지 않는다.
"""


def percent_change(before: float, after: float, decimals: int = 2) -> dict:
    """before 대비 after 의 증감폭과 증감률(%)을 돌려준다.

    before 가 0이면 증감률은 정의되지 않는다 — 0으로 나누는 대신 None 을
    돌려주고 이유를 함께 표시한다. 0을 반환하면 "변화 없음"으로 잘못 읽힌다.
    """
    delta = after - before

    if before == 0:
        percent = None
        note = "기준값(before)이 0이라 증감률을 계산할 수 없습니다 — 증감폭만 참고하세요."
    else:
        percent = round(delta / abs(before) * 100, decimals)
        note = ""

    if delta > 0:
        direction = "증가"
    elif delta < 0:
        direction = "감소"
    else:
        direction = "변화 없음"

    return {
        "before": before,
        "after": after,
        "delta": round(delta, decimals),
        "percent_change": percent,
        "direction": direction,
        "note": note,
    }
