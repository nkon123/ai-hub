"""금액을 한국식 단위(억/만/천)와 쉼표 표기로 함께 보여준다.

Desktop 로컬 Tool(D-084) 샘플. 표준 라이브러리만 사용하고 파일·네트워크에
접근하지 않는다. 통화 환산은 하지 않는다 — 환율을 가질 방법이 없다.
"""


def format_korean_amount(amount: int, unit: str = "원") -> dict:
    """정수 금액을 쉼표 표기와 한국식 단위 표기로 함께 돌려준다.

    예: 123456789 -> "123,456,789원", "1억 2345만 6789원".
    음수도 그대로 처리하며 부호를 앞에 붙인다.
    """
    negative = amount < 0
    value = abs(amount)

    scales = [(10**12, "조"), (10**8, "억"), (10**4, "만")]
    parts = []
    remainder = value
    for size, label in scales:
        chunk, remainder = divmod(remainder, size)
        if chunk:
            parts.append(f"{chunk}{label}")
    if remainder or not parts:
        parts.append(str(remainder))

    spoken = " ".join(parts) + unit
    if negative:
        spoken = "-" + spoken

    return {
        "amount": amount,
        "unit": unit,
        "comma": f"{amount:,}{unit}",
        "korean": spoken,
        "digits": len(str(value)),
    }
