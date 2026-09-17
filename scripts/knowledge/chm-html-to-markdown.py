"""압축 해제한 Nexacro 도움말(CHM)의 HTML을 Knowledge 등록용 Markdown 한 파일로 만든다.

    python scripts/knowledge/chm-html-to-markdown.py <해제한_폴더> -o out.md

CHM 은 `hh.exe -decompile <폴더> <파일.chm>` (Windows 기본 제공) 또는
`7z x <파일.chm>` 으로 풀 수 있다. 푼 폴더에 `*.html` 이 평면으로 들어 있고
파일명이 곧 목차 경로다(`Components_Component_Button_Method_click.html`).

## 왜 기존 Markdown을 정리하는 대신 HTML에서 다시 만드는가

`clean-nexacro-reference.py` 는 **이미 변환된** Markdown에서 잔재를 걷어낸다.
그 Markdown을 만든 변환기가 표·체크박스·이미지를 뭉갠 뒤였기 때문에, 그
단계에서는 되살릴 수 없는 정보가 있었다. HTML에서 직접 만들면 그게 살아난다 —
실측으로 확인한 세 가지:

* **Property Type 체크박스**: 기존 Markdown에는 `| Enum | Expr | Control |
  Hidden | ReadOnly | Bind | Collection` 한 줄이 4,450번 글자 하나 다르지 않게
  반복됐다. 체크 상태가 날아가서 속성마다 달랐어야 할 값이 전부 같아진 것이다.
  HTML에는 `<input type='checkbox' ... checked>` 가 **2,395개** 남아 있다.
  이 변환기는 체크된 것만 뽑아 `**Property Type**: Enum, ReadOnly` 로 적는다.
* **지원 환경**: 기존 Markdown은 모든 페이지에 같은 브라우저 목록을 글자로만
  남겼다(파일의 25.5%). 실제 지원 여부는 아이콘이었고 — `support01.gif`
  110,070개(지원) / `support03.gif` 15,495개(미지원) — 변환에서 사라졌다.
  이 변환기는 **미지원 항목만** 적는다(`--supported-env` 로 조절).
* **Structure 구역의 다이어그램**: 기존 Markdown에서 `Structure` 40개가 전부
  빈 구역이었다. `<img src='../nexacro17_01_Button1.png'>` 를 버렸기 때문이다.
  이 변환기는 이미지 참조를 남긴다.

또 `<table>` 을 진짜 Markdown 표로 만들기 때문에 Parameters/Return 표가
`Type | Description` 머리글과 값이 흩어지지 않는다.

## 청크 크기에 대한 결정 (실측으로 되돌린 것)

구역 라벨(`Description`/`Syntax`/...)을 `###` 제목이 아니라 **굵은 글씨**로
둔다. indexing-runtime 의 `parent_child` 청킹은 제목 경계에서 **먼저** 자르므로
라벨을 제목으로 올리면 `Syntax` 한 줄(`Button.click();`)이 독립 청크가 된다.
실제로 해보니 청크 중앙값이 469자 -> 84자로 무너지고 57%가 100자 미만 파편이
됐다. 검색에 쓸모 있는 단위는 "한 API 멤버 전체"(400~600자)이지 그 조각이 아니다.

## 의존성

표준 라이브러리만 쓴다(`html.parser`). 폐쇄망에서 추가 설치 없이 돌아야 하므로
BeautifulSoup/lxml 을 쓰지 않는다.
"""
from __future__ import annotations

import argparse
import html
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

# --- 최소 DOM ---------------------------------------------------------------
# html.parser 는 스트리밍이라 "이 라벨 다음 내용 셀"을 찾기가 번거롭다. 아주
# 작은 트리를 만들어 두면 구역 분할이 단순해진다.

VOID_TAGS = {"br", "img", "input", "hr", "meta", "link", "col"}


@dataclass(eq=False)  # `parent` 역참조가 있어 값 비교를 켜면 __eq__ 가 무한 재귀한다
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list = field(default_factory=list)
    parent: object | None = None

    def text(self) -> str:
        out = []
        for c in self.children:
            out.append(c if isinstance(c, str) else c.text())
        return "".join(out)

    def find_all(self, tag: str):
        for c in self.children:
            if isinstance(c, Node):
                if c.tag == tag:
                    yield c
                yield from c.find_all(tag)


class TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        # 암묵적 닫힘: `<td>a<td>b` 나 `<tr>..<tr>..` 처럼 닫는 태그를 생략한
        # 표기가 이 문서에 흔하다. 그대로 두면 칸이 중첩돼 표 모양이 무너진다.
        if tag in ("td", "th") and self.cur.tag in ("td", "th"):
            self.cur = self.cur.parent
        elif tag == "tr" and self.cur.tag in ("td", "th"):
            self.cur = self.cur.parent.parent if self.cur.parent is not None else self.root
        if tag == "tr" and self.cur.tag == "tr":
            self.cur = self.cur.parent

        node = Node(tag, {k: (v or "") for k, v in attrs}, parent=self.cur)
        self.cur.children.append(node)
        if tag not in VOID_TAGS:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, {k: (v or "") for k, v in attrs}, parent=self.cur))

    def handle_endtag(self, tag):
        """짝이 안 맞는 닫는 태그를 만나도 표 밖으로 빠져나가지 않는다.

        이 CHM HTML 은 곳곳이 비표준이다 — `</tr>` 가 두 번 닫히고, 속성이
        `<input type='checkbox' ... 0>` 처럼 깨져 있고, `<td	>` 처럼 탭이 섞여
        있다. 처음에는 닫는 태그를 만나면 스택을 끝까지 거슬러 올라가 같은
        이름을 찾도록 짰는데, 안쪽 표에서 stray `</tr>` 를 만나면 **바깥 레이아웃
        표의 `<tr>`** 까지 올라가 버려 안쪽 표를 통째로 빠져나갔다. 그 뒤의
        행들이 표에서 누락됐다(`Components / Component / Button` 의 Basic Key
        Action 에서 '선택상자 이동' 행이 사라진 것으로 발견).

        그래서 `table`/`td`/`th` 를 범위 경계로 두고, 그 경계를 넘어가야만 짝을
        찾을 수 있는 닫는 태그는 무시한다(HTML5 파서의 "table scope" 와 같은
        발상이다).
        """
        if tag in VOID_TAGS:
            return
        boundary = {"table", "td", "th", "body"}
        node = self.cur
        while node is not self.root:
            if node.tag == tag:
                self.cur = node.parent if node.parent is not None else self.root
                return
            if node.tag in boundary and tag not in boundary:
                return  # 범위를 벗어나는 stray end tag — 무시한다
            node = node.parent

    def handle_data(self, data):
        self.cur.children.append(data)


def parse_html(text: str) -> Node:
    b = TreeBuilder()
    b.feed(text)
    return b.root


# --- 텍스트 정리 ------------------------------------------------------------

def norm(s: str) -> str:
    """공백 정리. CHM HTML 은 탭과 개행이 마구 섞여 있다."""
    return re.sub(r"[ \t\r\f\v]+", " ", s.replace("\xa0", " ")).strip()


def cell_text(node: Node) -> str:
    """셀 하나의 텍스트. `<br>` 은 줄바꿈, `<pre>` 안은 원문 유지."""
    parts: list[str] = []

    def walk(n) -> None:
        if isinstance(n, str):
            parts.append(n)
            return
        if n.tag == "br":
            parts.append("\n")
            return
        if n.tag in ("script", "style"):
            return
        if n.tag == "pre":
            parts.append("\n" + n.text().strip("\n") + "\n")
            return
        for c in n.children:
            walk(c)

    for c in node.children:
        walk(c)
    raw = "".join(parts)
    lines = [norm(x) for x in raw.split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    # 3줄 이상 연속 빈 줄 -> 1줄
    out: list[str] = []
    for ln in lines:
        if not ln and out and not out[-1]:
            continue
        out.append(ln)
    return "\n".join(out)


# --- 구역별 렌더링 ----------------------------------------------------------

#: 이 라벨의 내용은 실제 코드다 -> 코드 블록으로 남긴다.
CODE_LABELS = {"Syntax", "Setting Syntax"}

CHROME_IMG = re.compile(r"(logo\d|top_bg|subtitle_icon|support\d|support_legend|bottom_update)")


def render_table(tbl: Node) -> list[str]:
    """`<table>` -> Markdown 표. 칸 수가 들쭉날쭉하면 표로 만들지 않는다.

    원본에 `colspan` 병합 헤더가 있는 표가 있는데, 병합을 무시하고 표로 만들면
    헤더가 실제 열을 설명하지 않는 **틀린 표**가 된다. 그럴 땐 각 행을 ` | ` 로
    이은 평문으로 둔다 — 내용은 그대로 남고 읽기도 검색도 문제없다.
    """
    rows: list[list[str]] = []
    for tr in tbl.find_all("tr"):
        # 중첩 표의 행은 바깥 표가 가져가지 않는다
        owner = tr.parent
        while owner is not None and owner.tag not in ("table", "#root"):
            owner = owner.parent
        if owner is not tbl:
            continue
        cells = []
        for td in tr.children:
            if isinstance(td, Node) and td.tag in ("td", "th"):
                cells.append(cell_text(td).replace("\n", " ").strip())
        if any(c for c in cells):
            rows.append(cells)
    if not rows:
        return []
    widths = {len(r) for r in rows}
    if len(rows) >= 2 and len(widths) == 1 and len(rows[0]) >= 2:
        n = len(rows[0])
        out = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * n]
        out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
        return out
    return [" | ".join(r) for r in rows if any(r)]


def render_property_type(cell: Node) -> list[str]:
    """체크된 Property Type 플래그만 뽑는다.

    기존 Markdown이 잃어버린 정보다 — HTML 전체에 `checked` 가 2,395개 있다.
    """
    flags: list[str] = []
    for td in cell.find_all("td"):
        box = next((c for c in td.children
                    if isinstance(c, Node) and c.tag == "input"
                    and c.attrs.get("type") == "checkbox"), None)
        if box is None:
            continue
        label = norm("".join(c for c in td.children if isinstance(c, str)))
        if label and "checked" in box.attrs:
            flags.append(label)
    if not flags:
        return []
    return [f"**Property Type**: {', '.join(flags)}"]


def render_supported_env(cell: Node, mode: str) -> list[str]:
    """지원 환경. 아이콘(`support01`=지원 / `support03`=미지원)이 실제 정보다.

    기본값 `compact` 는 **미지원 항목만** 적는다. 전부 지원이면 한 줄로 줄인다.
    모든 페이지에 같은 지원 목록을 12줄씩 붙이면 파일의 4분의 1이 같은 문장으로
    채워지고(실측 25.5%), 모든 청크의 임베딩이 서로 비슷해져 검색 품질이
    떨어진다 — 그런데도 미지원 정보는 실제 질문("이거 모바일에서 되나요")의
    답이라 버리지 않는다.
    """
    if mode == "omit":
        return []

    group = ""       # [Desktop] / [Mobile]
    runtime = ""     # NRE / WRE
    supported: list[str] = []
    unsupported: list[str] = []

    for tr in cell.find_all("tr"):
        pending: str | None = None
        for td in tr.children:
            if not (isinstance(td, Node) and td.tag == "td"):
                continue
            img = next((c for c in td.find_all("img")
                        if re.search(r"support(01|03)\.gif", c.attrs.get("src", ""))), None)
            txt = norm(td.text())
            if img is not None and not txt:
                pending = "yes" if "support01" in img.attrs["src"] else "no"
                continue
            if not txt:
                continue
            if txt.startswith("[") and txt.endswith("]"):
                group = txt.strip("[]")
                continue
            low = txt.lower()
            if "runtime environment" in low:
                runtime = "NRE" if "nexacro runtime" in low else "WRE"
                continue
            if pending is not None:
                entry = f"{group} {runtime} {txt}".strip()
                (supported if pending == "yes" else unsupported).append(entry)
                pending = None

    if not supported and not unsupported:
        return []
    if mode == "full":
        out = ["**지원 환경**"]
        out += [f"- 지원: {', '.join(supported)}"] if supported else []
        out += [f"- 미지원: {', '.join(unsupported)}"] if unsupported else []
        return out
    # compact
    if not unsupported:
        return ["**지원 환경**: 전체 지원"]
    return ["**지원 환경**: 미지원 — " + ", ".join(unsupported)]


def _collect_blocks(node: Node, blocks: list, buf: list) -> None:
    """셀 내용을 **문서 순서대로** 블록으로 모은다.

    순서를 지키는 것이 핵심이다. 처음에는 "표가 있으면 표만 렌더링"으로 짰는데,
    한 셀 안에 산문과 표가 같이 있는 경우(예: `FileDialog / Method / open` 의
    Remark — 설명 네 줄 뒤에 Alias 경로 표가 붙어 있다) 산문이 통째로
    사라졌다. 한글 토큰 100개가 없어진 것을 보고 발견했다.

    `<table>` 이 `<pre>` **안에** 들어 있는 경우도 있어서 `<pre>` 도 재귀한다.
    """
    def flush() -> None:
        if buf:
            text = "".join(buf)
            if text.strip():
                blocks.append(("text", text))
            buf.clear()

    for child in node.children:
        if isinstance(child, str):
            buf.append(child)
            continue
        if child.tag in ("script", "style"):
            continue
        if child.tag == "br":
            buf.append("\n")
            continue
        if child.tag == "img":
            src = child.attrs.get("src", "")
            if not CHROME_IMG.search(src):
                flush()
                blocks.append(("img", src.split("/")[-1]))
            continue
        if child.tag == "table":
            flush()
            rows = render_table(child)
            if rows:
                blocks.append(("table", rows))
            continue
        if child.tag == "pre":
            flush()
            inner: list = []
            inner_buf: list[str] = []
            _collect_blocks(child, inner, inner_buf)
            if inner_buf and "".join(inner_buf).strip():
                inner.append(("text", "".join(inner_buf)))
            for kind, value in inner:
                blocks.append(("pre", value) if kind == "text" else (kind, value))
            continue
        _collect_blocks(child, blocks, buf)


def _as_lines(text: str) -> list[str]:
    lines = [norm(x) for x in text.split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    out: list[str] = []
    for ln in lines:
        if not ln and out and not out[-1]:
            continue
        out.append(ln)
    return out


def render_content(cell: Node, label: str) -> list[str]:
    """라벨 하나에 딸린 내용 셀을 Markdown 으로."""
    blocks: list = []
    buf: list[str] = []
    _collect_blocks(cell, blocks, buf)
    if buf and "".join(buf).strip():
        blocks.append(("text", "".join(buf)))

    out: list[str] = []
    prev_text = ""
    for kind, value in blocks:
        if kind == "img":
            out += [f"![{label} 다이어그램]({value})", ""]
            continue
        if kind == "table":
            out += [*value, ""]
            continue
        lines = _as_lines(value)
        if not lines:
            continue
        # `<pre>` 는 이 문서에서 두 가지로 쓰인다: Description/Remark 에서는
        # 산문, Syntax 와 "Sample Call:" 뒤에서는 실제 코드다. 라벨만 보면
        # Parameters 안의 Sample Call 코드가 산문으로 흘러 코드 블록을 잃는다.
        is_code = kind == "pre" and (
            label in CODE_LABELS
            or prev_text.lower().rstrip(": ").endswith("sample call")
        )
        out += (["```", *lines, "```", ""] if is_code else [*lines, ""])
        if kind == "text":
            prev_text = lines[-1]
    return out


# --- 페이지 한 장 -----------------------------------------------------------

def convert_page(source: str, path: str, supported_env: str) -> list[str] | None:
    root = parse_html(source)

    body = next(root.find_all("body"), None)
    if body is None:
        return None

    # 목차 경로: breadcrumb(`td.top_navi`)가 있으면 그것이 정답이다.
    crumb = next((td for td in body.find_all("td")
                  if td.attrs.get("class") == "top_navi"), None)
    if crumb is not None:
        crumb_text = norm(crumb.text())
        if crumb_text:
            path = " / ".join(x.strip() for x in crumb_text.split(">"))

    out: list[str] = [f"## {path}", ""]

    # `td.sub_title` 이 구역 라벨이고, 그 **다음에 오는 내용 있는 td** 가 본문이다.
    #
    # 내용 셀의 class 를 `list` 로 한정하면 안 된다 — Supported Environments 의
    # 내용 셀은 class 가 아예 없다(`<td >`). 처음에 `td.list` 만 찾도록 짰다가
    # 8,371개 페이지의 지원 환경이 통째로 비는 것을 보고 고쳤다. 대신 문서
    # 순서로 훑으면서 "빈 레이아웃 칸이 아닌 첫 td" 를 내용으로 본다.
    all_tds = list(body.find_all("td"))
    consumed: set[int] = set()  # 내용 셀 안에 중첩된 td 는 따로 소비하지 않는다

    #: 본문이 아닌 칸(머리글/발자국). 라벨에 딸려 붙으면 안 된다.
    SKIP_CLASSES = {"sub_title", "title", "top_navi", "bottom_update"}

    def flush(label: str, cells: list[Node]) -> list[str]:
        """한 라벨에 딸린 내용 셀들을 하나로 렌더링한다.

        **셀이 여러 개일 수 있다.** 처음에는 라벨마다 셀 하나만 가져가도록
        짰는데, `Accessibility Key Action` 처럼 설명 문장 셀과 표 셀이 따로
        떨어져 있는 구역에서 표가 통째로 사라졌다(`Components / Component /
        Button` 에서 '선택상자 이동' 행이 없어진 것으로 발견). 라벨은 다음
        `sub_title` 을 만날 때까지 유효하다.
        """
        body_lines: list[str] = []
        for cell in cells:
            if label == "Supported Environments":
                body_lines += render_supported_env(cell, supported_env)
            elif label == "Property Type":
                body_lines += render_property_type(cell)
            else:
                body_lines += render_content(cell, label)
        while body_lines and not body_lines[-1]:
            body_lines.pop()
        if not body_lines:
            return []
        if label in ("Supported Environments", "Property Type"):
            return [*body_lines, ""]
        return [f"**{label}**", "", *body_lines, ""]

    label: str | None = None
    cells: list[Node] = []
    emitted = False
    for i, td in enumerate(all_tds):
        if i in consumed:
            continue
        cls = td.attrs.get("class")
        if cls == "sub_title":
            if label is not None:
                chunk = flush(label, cells)
                if chunk:
                    out += chunk
                    emitted = True
            label = norm(td.text())
            cells = []
            continue
        if label is None or cls in SKIP_CLASSES:
            continue
        # 레이아웃용 빈 칸은 건너뛴다
        if not norm(td.text()) and not any(
            not CHROME_IMG.search(im.attrs.get("src", "")) for im in td.find_all("img")
        ):
            continue
        nested = {id(x) for x in td.find_all("td")}
        for j in range(i + 1, len(all_tds)):
            if id(all_tds[j]) in nested:
                consumed.add(j)
        cells.append(td)

    if label is not None:
        chunk = flush(label, cells)
        if chunk:
            out += chunk
            emitted = True

    if not emitted:
        return None

    while out and not out[-1]:
        out.pop()
    return out


# --- 진입점 -----------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="압축 해제한 CHM 의 HTML 을 Knowledge 등록용 Markdown 한 파일로 만든다.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "CHM 풀기:\n"
            "  hh.exe -decompile <폴더> <파일.chm>      (Windows 기본)\n"
            "  7z x <파일.chm> -o<폴더>                 (7-Zip)\n\n"
            "예:\n"
            "  python scripts/knowledge/chm-html-to-markdown.py "
            "C:\\temp\\nexacro_manual_ko -o output/nexacro-reference.md"
        ),
    )
    p.add_argument("source_dir", type=Path, help="압축 해제한 CHM 폴더 (*.html 이 들어 있는 곳)")
    p.add_argument("-o", "--output", type=Path, required=True, help="만들 Markdown 파일")
    p.add_argument("--title", default="넥사크로플랫폼 17 F1 Reference Guide (한국어)",
                   help="문서 제목")
    p.add_argument("--supported-env", choices=("compact", "full", "omit"), default="compact",
                   help="지원 환경 표기 방식 (기본 compact: 미지원 항목만)")
    p.add_argument("--force", action="store_true", help="결과 파일이 있어도 덮어쓴다")
    p.add_argument("--limit", type=int, default=0, help="앞에서 N개 파일만 변환(점검용)")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    src_dir: Path = args.source_dir
    if not src_dir.is_dir():
        raise SystemExit(f"폴더가 없습니다: {src_dir}")

    pages = sorted(src_dir.glob("*.html"))
    if not pages:
        raise SystemExit(
            f"`*.html` 이 없습니다: {src_dir}\n"
            "CHM 을 먼저 풀었는지, 그리고 이 폴더가 HTML 이 들어 있는 폴더인지 확인하세요."
        )
    if args.limit:
        pages = pages[: args.limit]

    dst: Path = args.output
    if dst.exists() and not args.force:
        raise SystemExit(f"결과 파일이 이미 있습니다(덮어쓰려면 --force): {dst}")
    dst.parent.mkdir(parents=True, exist_ok=True)

    out: list[str] = [
        f"# {args.title}",
        "",
        f"원본: Nexacro 도움말 CHM 추출 HTML ({src_dir.name})",
        "",
        "문서 수: <<DOC_COUNT>>",
        "",
        "생성: `scripts/knowledge/chm-html-to-markdown.py`. "
        "HTML 에서 직접 만들었으므로 Property Type 체크 상태, 지원 환경의 미지원 항목, "
        "Structure 다이어그램 참조가 모두 보존되어 있다.",
        "",
    ]

    converted = skipped = 0
    for i, page in enumerate(pages, 1):
        try:
            source = page.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            source = page.read_text(encoding="cp949", errors="replace")
        path = page.stem.replace("_", " / ")
        section = convert_page(source, path, args.supported_env)
        if section is None:
            skipped += 1
            continue
        converted += 1
        out += section
        out.append("")
        if i % 1000 == 0:
            print(f"  ... {i:,}/{len(pages):,}", file=sys.stderr, flush=True)

    result = "\n".join(out).rstrip() + "\n"
    result = result.replace("<<DOC_COUNT>>", f"{converted:,}")
    dst.write_text(result, encoding="utf-8")

    print(f"HTML 파일      : {len(pages):,}")
    print(f"변환           : {converted:,}   (내용 없어 건너뜀: {skipped:,})")
    print(f"결과           : {len(result):,}자 / "
          f"{len(result.encode('utf-8')) / 1024 / 1024:.1f}MB / {result.count(chr(10)):,}줄")
    print(f"written        : {dst}")


if __name__ == "__main__":
    main()
