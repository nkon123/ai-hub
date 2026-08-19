"""로그 텍스트에서 오류 줄을 뽑아 수준별로 집계한다.

Desktop 로컬 Tool(D-084) 샘플. "I/F 장애 알림 확인 요약" 같은 시나리오에
쓰라고 만든 것이다. 표준 라이브러리만 쓰고 파일·네트워크에 접근하지 않는다
— 로그 '텍스트'를 인자로 받지, 파일 경로를 받지 않는다(사용자가 준 경로로
파일을 여는 Tool 을 샘플로 두지 않는다).
"""


def extract_error_lines(log_text: str, max_lines: int = 20) -> dict:
    """로그에서 ERROR/WARN/FATAL 이 든 줄을 골라 집계와 함께 돌려준다.

    max_lines 는 돌려줄 줄 수 상한이다. 넘치면 잘라내고 그 사실을 표시한다
    — 조용히 잘라 놓고 전부인 척하지 않는다.
    """
    levels = ("FATAL", "ERROR", "WARN")
    counts = {level: 0 for level in levels}
    hits = []

    for raw in log_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        upper = line.upper()
        for level in levels:
            if level in upper:
                counts[level] += 1
                if len(hits) < max_lines:
                    hits.append(line)
                break

    total = sum(counts.values())
    return {
        "total_matched": total,
        "counts": counts,
        "lines": hits,
        "truncated": total > len(hits),
        "note": "파일이 아니라 넘겨받은 텍스트만 검사했습니다.",
    }
