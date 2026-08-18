"""붙여넣은 글의 분량 통계를 낸다 (글자·단어·줄·문단).

Desktop 로컬 Tool(D-084) 샘플. 표준 라이브러리만 사용하고 파일·네트워크에
접근하지 않는다. 입력 문자열을 어디에도 저장하거나 전송하지 않으며 통계
숫자만 돌려준다.
"""


def text_stats(text: str, chars_per_page: int = 1800) -> dict:
    """글의 분량 통계를 돌려준다.

    chars_per_page 는 예상 페이지 수를 낼 때 쓰는 한 쪽당 글자 수다
    (기본 1800자 = A4 한 쪽 대략치). 원문은 반환값에 포함하지 않는다.
    """
    lines = text.splitlines()
    paragraphs = [block for block in text.split("\n\n") if block.strip()]
    chars_no_space = sum(1 for ch in text if not ch.isspace())
    pages = round(chars_no_space / chars_per_page, 2) if chars_per_page > 0 else None

    return {
        "characters": len(text),
        "characters_without_spaces": chars_no_space,
        "words": len(text.split()),
        "lines": len(lines),
        "non_empty_lines": sum(1 for line in lines if line.strip()),
        "paragraphs": len(paragraphs),
        "estimated_pages": pages,
        "chars_per_page": chars_per_page,
    }
