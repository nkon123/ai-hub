"""행 데이터를 Markdown 표로 만든다 — 스케줄 이력 뷰어 데모용.

Desktop 로컬 Tool(D-084) 샘플. 스케줄 실행 결과는 이력 팝업에서 Markdown
으로 렌더링되므로, 표를 돌려주는 Tool 이 그 화면에서 실제로 표로 보인다.
표준 라이브러리만 쓰고 파일·네트워크에 접근하지 않는다.
"""


def markdown_table(rows: list[dict[str, str]], title: str = "") -> str:
    """딕셔너리 목록을 Markdown 표 문자열로 돌려준다.

    열은 첫 행의 키 순서를 따르고, 뒤 행에만 있는 키는 뒤에 덧붙인다 —
    행마다 키가 달라도 조용히 버리지 않는다. 값에 든 '|' 는 표가 깨지지
    않도록 이스케이프한다.
    """
    if not rows:
        return "(표로 만들 행이 없습니다.)"

    columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)

    def cell(value: str) -> str:
        return str(value).replace("|", "\\|").replace("\n", " ")

    lines = []
    if title:
        lines.append(f"## {title}")
        lines.append("")
    lines.append("| " + " | ".join(columns) + " |")
    lines.append("| " + " | ".join("---" for _ in columns) + " |")
    for row in rows:
        lines.append("| " + " | ".join(cell(row.get(col, "")) for col in columns) + " |")
    lines.append("")
    lines.append(f"행 {len(rows)}개 · 열 {len(columns)}개")
    return "\n".join(lines)
