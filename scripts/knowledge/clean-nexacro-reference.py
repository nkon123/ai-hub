"""Nexacro 도움말(CHM) 추출 Markdown의 1차 정리 — Knowledge 등록 전처리.

    python scripts/knowledge/clean-nexacro-reference.py output/Nexacro17_Reference_Guide_Korean.md

원본은 절대 수정하지 않는다 — 새 파일(`*.cleaned.md`)로만 쓴다.

**임시 도구다.** 특정 CHM 변환기의 출력 형태에 맞춰져 있어 범용 Markdown
정리기가 아니다. 이 문서 계열을 다시 넣을 때만 쓰고, 다른 출처 문서에는
그대로 적용하지 않는다(라벨 목록과 보일러플레이트 판정이 전부 이 문서의
전수 집계에서 나왔다).

실측 효과 (2026-09-17, `Nexacro17_Reference_Guide_Korean.md` 20.3MB):

    글자   15,892,316 -> 7,947,966  (-50.0%)
    청크       41,954 ->    22,313  (indexing-runtime parent_child 기준)
    색인 시간    8.9분 ->    약 4.6분
    한글 본문 손실 0자

무엇을 지우는지와 그 근거(전부 원본 전수 집계로 확인):

* `Supported Environments` 블록 (8,371회, 4,059,935자 = 파일의 25.5%)
  — 8,391개 페이지 중 8,371개에 **완전히 동일한** 브라우저 지원 매트릭스가
  붙어 있다. 검색 대상으로서 값이 0일 뿐 아니라, 모든 청크에 같은 문장이
  들어가면 임베딩이 서로 비슷해져 실제로 검색 품질을 **떨어뜨린다**.
* `Property Type` 블록 (4,450회) — `| Enum | Expr | Control | Hidden |
  ReadOnly | Bind | Collection` 한 줄이 4,450번 **글자 하나 다르지 않고**
  반복된다. 원래 체크박스 매트릭스였는데 변환에서 체크 표시가 통째로
  사라져, 속성마다 달랐어야 할 정보가 전부 소실됐다. 남은 건 라벨뿐이라
  지운다(정보를 버리는 게 아니라, 이미 버려진 것의 껍데기를 치운다).
* `LAST UPDATED Jan. 2024` (8,386회) — 페이지마다 동일.
* Breadcrumb `| A > B > C` (8,357회) — `##` 제목과 같은 경로의 중복.
* 앵커 ID(`PopupDiv_Method_getPixelTop`)와 잎 이름 반복 — 제목에서 유도 가능.
* 파이프만 있는 줄 (278,294줄, 1,408,729자) — HTML 표 껍데기의 잔해.
* 구역 구분선 `---` (8,391회) — `##` 제목이 이미 경계다.

구조 복원:

* `|   |   | Description` 같은 라벨 줄을 `**Description**` 으로 바꾼다.
  **`###` 제목으로 올리지 않는다** — 한 번 그렇게 해보고 실측으로 되돌렸다.
  이 저장소의 청킹(`parent_child`)은 제목 경계에서 **먼저** 자르므로 라벨을
  제목으로 만들면 `Syntax` 한 줄(`PopupDiv.getPixelTop();`)이 독립 청크가
  된다. 실제로 청크 중앙값이 469자에서 84자로 무너지고 57%가 100자 미만
  파편이 됐다. 검색 단위로 쓸모 있는 덩어리는 "한 API 멤버의 설명+문법+
  파라미터+반환값 전체"(400~600자)이지 그 안의 한 조각이 아니다.
* 산문이 들어 있는 ``` 블록은 펼치고, 실제 코드(Syntax/Setting Syntax/
  Sample Call)는 코드 블록으로 남긴다.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

# 라벨 줄: "  |   |   | Description"  (파이프 3개 이상 + 짧은 텍스트)
LABEL_RE = re.compile(r"^\s*\|(?:\s*\|)*\s*([^|]{1,60}?)\s*$")
HEAD_RE = re.compile(r"^## \d+\.\s*(.+)$")
PIPE_ONLY_RE = re.compile(r"^[\s|]*$")
LEADING_PIPES_RE = re.compile(r"^\s*(?:\|\s*)+")

#: 이 라벨이 시작하는 블록은 다음 라벨을 만날 때까지 통째로 버린다.
DROP_BLOCKS = {"Supported Environments", "Property Type"}

#: 실제 코드가 들어오는 라벨 — ``` 블록을 코드로 유지한다.
CODE_LABELS = {"Syntax", "Setting Syntax"}

#: 알려진 라벨. 이 집합에 있을 때만 `###` 제목으로 승격한다 — 임의의 짧은
#: 표 셀이 제목으로 둔갑하는 것을 막기 위해 화이트리스트로 간다.
#: 원본 전수 집계로 뽑은 닫힌 목록(5회 이상 등장하는 라벨 전부).
KNOWN_LABELS = {
    "Description", "Supported Environments", "Syntax", "Remark",
    "Property Type", "Setting Syntax", "Return", "Parameters",
    "See Also", "Property", "Default Action", "Method",
    "Basic Action", "Example", "Event", "Status", "Constructor",
    "Control", "Structure", "Basic Key Action", "Accessibility Key Action",
    "Contents Sizing",
}

#: 통째로 빼는 섹션. OpenSource License는 SQLite 등 서드파티 라이선스 전문
#: 85,898자로 정리본 최대 섹션인데, Nexacro API 질문에 답하는 데 쓰일 일이
#: 없으면서 청크 수백 개를 만들어 낸다 — 검색에 끼어들기만 한다.
DROP_SECTION_PATHS = {"Appendix / OpenSource License"}


def rebuild_tables(text: list[str]) -> list[str]:
    """셀 하나가 한 줄씩 떨어져 나온 표를 진짜 Markdown 표로 되돌린다.

    변환기가 `<td>`마다 줄바꿈을 넣어 이런 모양이 됐다:

        \\t\\t | Reason
        \\t\\t | Value
        \\t\\t | Description
        (빈 줄)
        \\t\\t | Dataset.REASON_LOAD
        \\t\\t | 0
        \\t\\t | Dataset의 Load가 완료되었을 때

    즉 **연속된 파이프 줄 = 한 행**, 빈 줄 = 행 경계다. 파이프 없는 줄은 바로
    앞 셀의 이어지는 내용이다(실제로 그런 셀이 있다).
    """
    rows: list[list[str]] = []
    cur: list[str] = []
    out: list[str] = []

    def flush_rows() -> None:
        """균일한 표만 Markdown 표로 만든다.

        칸 수가 들쭉날쭉한 표는 원본에서 `colspan`으로 병합된 2단 헤더였던
        경우가 많은데(예: `Named Color List`의 `Color Code`가 `Hex RGB Code`와
        `Decimal Code` 위에 걸쳐 있었다), 병합 정보는 변환에서 이미 사라졌다.
        그 상태로 표를 만들면 헤더가 실제 열을 설명하지 않는 **틀린 표**가
        된다. 그럴 바엔 각 행을 ` | ` 로 이은 평문으로 두는 게 정직하다 —
        내용은 그대로 남고 읽기도 검색도 문제없다.
        """
        nonlocal rows
        widths = {len(r) for r in rows}
        if len(rows) >= 2 and len(widths) == 1 and len(rows[0]) >= 2:
            width = rows[0].__len__()
            out.append("| " + " | ".join(rows[0]) + " |")
            out.append("|" + "---|" * width)
            for r in rows[1:]:
                out.append("| " + " | ".join(x.replace("\n", "<br>") for x in r) + " |")
            out.append("")
        else:
            for r in rows:
                out.append(" | ".join(r))
            out.append("")
        rows = []

    for ln in text:
        s = ln.strip()
        m = re.match(r"^\|\s*(.*)$", s)
        if m:
            cur.append(m.group(1).strip())
            continue
        if not s:
            # 빈 줄은 행 경계일 뿐 표의 끝이 아니다. 연속된 빈 줄에서 표를
            # 끊어 버리면 `Named Color List` 처럼 헤더가 두 줄이고 그 사이에
            # 빈 줄이 둘 있는 표가 헤더와 본문으로 쪼개진다. 표는 파이프가
            # 아닌 실제 내용 줄을 만나거나 블록이 끝날 때만 닫는다.
            if cur:
                rows.append(cur)
                cur = []
            elif not rows:
                out.append("")
            continue
        if cur:
            # 파이프 없는 줄 = 직전 셀의 연속
            cur[-1] = (cur[-1] + " " + s).strip()
            continue
        if rows:
            flush_rows()
        out.append(ln)

    if cur:
        rows.append(cur)
    if rows:
        flush_rows()
    while out and not out[-1]:
        out.pop()
    return out


def clean_content_line(line: str) -> str:
    """앞쪽 파이프 껍데기만 벗기고 내부 구분자는 남긴다."""
    out = LEADING_PIPES_RE.sub("", line).rstrip()
    return re.sub(r"\s*\|\s*", " | ", out).strip(" |").strip()


def clean_section(path: str, body: list[str]) -> list[str]:
    out: list[str] = [f"## {path}", ""]
    leaf = path.rsplit("/", 1)[-1].strip()

    current_label: str | None = None
    dropping = False
    in_fence = False
    fence_buf: list[str] = []
    pending_sample_call = False
    seen_first_content = False

    def flush_fence() -> None:
        nonlocal fence_buf, pending_sample_call
        text = [x for x in fence_buf]
        while text and not text[0].strip():
            text.pop(0)
        while text and not text[-1].strip():
            text.pop()
        if not text:
            fence_buf = []
            pending_sample_call = False
            return
        as_code = current_label in CODE_LABELS or pending_sample_call
        if as_code:
            out.append("```")
            out.extend(text)
            out.append("```")
        else:
            # 산문 블록은 펼치되, 셀이 줄줄이 떨어져 나온 표는 표로 되돌린다.
            out.extend(rebuild_tables(text) if any("|" in x for x in text) else text)
        out.append("")
        fence_buf = []
        pending_sample_call = False

    for raw in body:
        stripped = raw.strip()

        if stripped == "```":
            if in_fence:
                in_fence = False
                if not dropping:
                    flush_fence()
            else:
                in_fence = True
                fence_buf = []
            continue

        if in_fence:
            fence_buf.append(raw)
            continue

        if stripped == "---" or not stripped:
            continue
        if PIPE_ONLY_RE.match(raw):
            continue
        if "LAST UPDATED" in raw:
            continue

        m = LABEL_RE.match(raw)
        label = m.group(1) if (m and raw.count("|") >= 3) else None

        if label in KNOWN_LABELS:
            current_label = label
            dropping = label in DROP_BLOCKS
            if not dropping:
                out.append(f"**{label}**")
                out.append("")
            continue

        if dropping:
            continue

        text = clean_content_line(raw)
        if not text:
            continue

        # 제목에서 유도되는 중복(앵커 ID / breadcrumb / 잎 이름)은 **첫 라벨
        # 이전의 머리말에서만** 걷어낸다.
        #
        # 예전에는 "첫 실질 내용을 만나기 전까지"로 판단했는데, 이 문서는
        # 본문이 거의 전부 ``` 블록 안에 있어서 그 플래그가 섹션 끝까지 False
        # 로 남았다. 그 결과 본문 중간의 멀쩡한 한 단어짜리 줄까지 "앵커처럼
        # 생겼다"는 이유로 지워졌다(`Structure` 40건이 그렇게 사라졌다).
        # 위치로 판단하면 그런 과삭제가 구조적으로 불가능하다.
        if current_label is None:
            if text == leaf:
                continue
            if " > " in text and text.split(" > ")[-1].strip() == leaf:
                continue
            if re.fullmatch(r"[A-Za-z0-9_.\-]+", text) and not seen_first_content:
                seen_first_content = True
                continue

        seen_first_content = True

        if text.rstrip(":") == "Sample Call":
            out.append("**Sample Call:**")
            out.append("")
            pending_sample_call = True
            continue

        out.append(text)
        out.append("")

    if in_fence and fence_buf and not dropping:
        flush_fence()

    # 내용이 하나도 안 남은 `###` 구역은 지운다. 원본에서 다이어그램/이미지만
    # 있던 구역(`Structure` 40건, `Contents Sizing` 등)은 변환에서 그림이
    # 통째로 빠져 빈 ``` 블록만 남았다 — 제목만 덩그러니 남기면 검색에
    # 걸리기만 하고 답이 될 내용이 없다.
    pruned: list[str] = []
    for i, ln in enumerate(out):
        if ln.startswith("**") and ln.endswith("**"):
            rest = out[i + 1:]
            nxt = next((x for x in rest if x.strip()), None)
            if nxt is None or (nxt.startswith("**") and nxt.endswith("**")):
                continue
        pruned.append(ln)

    # 빈 줄 눌러 붙이기
    squeezed: list[str] = []
    for ln in pruned:
        if not ln and squeezed and not squeezed[-1]:
            continue
        squeezed.append(ln)
    while squeezed and not squeezed[-1]:
        squeezed.pop()
    return squeezed


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Nexacro CHM 추출 Markdown의 변환 잔재를 걷어낸다(원본은 수정하지 않는다).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="예: python scripts/knowledge/clean-nexacro-reference.py "
               "output/Nexacro17_Reference_Guide_Korean.md",
    )
    p.add_argument("source", type=Path, help="정리할 Markdown 파일")
    p.add_argument(
        "-o", "--output", type=Path, default=None,
        help="결과 파일 (기본값: 입력 파일명에 .cleaned.md)",
    )
    p.add_argument(
        "--force", action="store_true",
        help="결과 파일이 이미 있어도 덮어쓴다",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    src: Path = args.source
    if not src.is_file():
        raise SystemExit(f"입력 파일이 없습니다: {src}")

    dst: Path = args.output or src.with_suffix(".cleaned.md")
    if dst.resolve() == src.resolve():
        raise SystemExit("결과 파일이 입력 파일과 같습니다 — 원본을 덮어쓰지 않는다.")
    if dst.exists() and not args.force:
        raise SystemExit(f"결과 파일이 이미 있습니다(덮어쓰려면 --force): {dst}")

    text = src.read_text(encoding="utf-8")
    lines = text.split("\n")

    head_idx = [i for i, ln in enumerate(lines) if ln.startswith("## ")]
    if not head_idx:
        raise SystemExit(f"'## ' 섹션이 없습니다 — 예상한 형식의 파일이 아닙니다: {src}")

    header_placeholder = "<<DOC_COUNT>>"
    out: list[str] = [
        "# 넥사크로플랫폼 17 F1 Reference Guide (한국어)",
        "",
        "원본: Nexacro Studio 17.1 한국어 도움말 CHM에서 추출한 HTML",
        "",
        f"문서 수: {header_placeholder}",
        "",
        f"이 파일은 CHM->HTML->Markdown 변환 잔재를 걷어낸 1차 정리본이다"
        f"(원본: `{src.name}`, 생성: "
        f"`scripts/knowledge/clean-nexacro-reference.py`).",
        "",
        "제거한 것: 모든 페이지에 동일하게 붙어 있던 브라우저 지원 매트릭스"
        "(`Supported Environments`), 변환에서 체크 표시가 사라져 내용이 비어 버린 "
        "`Property Type` 표, `LAST UPDATED` 표기, 제목과 중복되는 breadcrumb와 앵커 ID, "
        "HTML 표 껍데기로 남은 파이프 문자, 서드파티 `OpenSource License` 전문.",
        "",
        "복원한 것: 셀이 한 줄씩 떨어져 나온 표를 Markdown 표로, "
        "`Description`/`Syntax` 같은 구역 라벨을 굵은 글씨로 되돌렸다.",
        "",
        "한글 본문은 한 글자도 제거하지 않았다.",
        "",
    ]

    bounds = head_idx + [len(lines)]
    kept = 0
    dropped_paths = 0
    for a, b in zip(bounds, bounds[1:]):
        m = HEAD_RE.match(lines[a])
        path = m.group(1).strip() if m else lines[a][3:].strip()
        if path in DROP_SECTION_PATHS:
            dropped_paths += 1
            continue
        section = clean_section(path, lines[a + 1:b])
        if len(section) <= 2:  # 제목만 남은 섹션
            continue
        kept += 1
        out.extend(section)
        out.append("")

    result = "\n".join(out).rstrip() + "\n"
    result = result.replace(header_placeholder, f"{kept:,}")
    dst.write_text(result, encoding="utf-8")

    before_chars, after_chars = len(text), len(result)
    before_bytes = len(text.encode("utf-8"))
    after_bytes = len(result.encode("utf-8"))
    print(f"sections kept : {kept:,} / {len(head_idx):,}  (명시적 제외 {dropped_paths})")
    print(f"markdown tables rebuilt: {result.count(chr(10) + '|---'):,}")
    print(f"chars         : {before_chars:,} -> {after_chars:,} "
          f"({100 * after_chars / before_chars:.1f}%, -{100 - 100 * after_chars / before_chars:.1f}%)")
    print(f"bytes         : {before_bytes:,} -> {after_bytes:,} "
          f"({before_bytes / 1024 / 1024:.1f}MB -> {after_bytes / 1024 / 1024:.1f}MB)")
    print(f"lines         : {len(lines):,} -> {result.count(chr(10)):,}")
    print(f"written       : {dst}")


main()
