"""두 수를 더한다 — 채팅 자동 Tool 선택 데모용.

Desktop 로컬 Tool(D-084) 샘플. 채팅에 "1 + 3333" 처럼 입력하고 "로컬 Tool
인자 자동 채우기" 토글을 켜면, LLM 이 이 Tool 과 인자를 골라 실행한다.
표준 라이브러리만 쓰고 파일·네트워크에 접근하지 않는다.
"""


def add_numbers(a: float, b: float) -> dict:
    """a 와 b 를 더한 결과를 돌려준다.

    정수로 떨어지면 정수로 표기한다 — 3334.0 보다 3334 가 읽기 좋다.
    """
    total = a + b
    exact = float(total).is_integer()
    return {
        "a": a,
        "b": b,
        "sum": int(total) if exact else total,
        "expression": f"{a} + {b} = {int(total) if exact else total}",
    }
