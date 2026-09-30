"""`samples/mcp-servers/outlook-mail` 의 `outlook.read_presentations`.

Outlook(COM)은 필요 없다. PPTX 는 zip+XML 이라 시험용 파일을 표준 라이브러리로 직접
만든다 — 슬라이드 순서(presentation.xml 이 파일 번호와 다를 때), 표, 발표자 노트, 그리고
악의적 입력(DOCTYPE, 압축 폭탄, pptx 가 아닌 파일)을 고정한다.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path

import mcp.types as types
import pytest

SERVER_DIR = Path(__file__).resolve().parents[3] / "samples" / "mcp-servers" / "outlook-mail"

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"


@pytest.fixture()
def server():
    spec = importlib.util.spec_from_file_location("outlook_mail_server_pptx_test", SERVER_DIR / "server.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop(spec.name, None)


def _paras(*texts: str) -> str:
    return "".join(f"<a:p><a:r><a:t>{t}</a:t></a:r></a:p>" for t in texts)


def _shape(kind: str | None, *texts: str) -> str:
    ph = f'<p:ph type="{kind}"/>' if kind else ""
    return f"<p:sp><p:nvSpPr><p:cNvPr id=\"1\" name=\"s\"/><p:cNvSpPr/><p:nvPr>{ph}</p:nvPr></p:nvSpPr><p:txBody>{_paras(*texts)}</p:txBody></p:sp>"


def _slide(*shapes: str) -> str:
    return (
        f'<p:sld xmlns:a="{A}" xmlns:p="{P}" xmlns:r="{R}"><p:cSld><p:spTree>'
        + "".join(shapes)
        + "</p:spTree></p:cSld></p:sld>"
    )


def _table(*rows: tuple[str, ...]) -> str:
    body = "".join(
        "<a:tr>" + "".join(f"<a:tc><a:txBody>{_paras(c)}</a:txBody></a:tc>" for c in row) + "</a:tr>" for row in rows
    )
    return f"<p:graphicFrame><a:graphic><a:graphicData><a:tbl>{body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>"


def make_pptx(slides: dict[int, str], order: list[int], notes: dict[int, str] | None = None) -> bytes:
    """`slides` 는 파일 번호 → 슬라이드 XML, `order` 는 발표 순서(파일 번호)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        ids = "".join(f'<p:sldId id="{256 + i}" r:id="rId{i}"/>' for i, _ in enumerate(order, start=1))
        zf.writestr("ppt/presentation.xml", f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst>{ids}</p:sldIdLst></p:presentation>')
        rels = "".join(
            f'<Relationship Id="rId{i}" Type="{R}/slide" Target="slides/slide{n}.xml"/>' for i, n in enumerate(order, start=1)
        )
        zf.writestr("ppt/_rels/presentation.xml.rels", f'<Relationships xmlns="{REL}">{rels}</Relationships>')
        for number, xml in slides.items():
            zf.writestr(f"ppt/slides/slide{number}.xml", xml)
            if notes and number in notes:
                zf.writestr(
                    f"ppt/slides/_rels/slide{number}.xml.rels",
                    f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{R}/notesSlide" Target="../notesSlides/notesSlide{number}.xml"/></Relationships>',
                )
                zf.writestr(
                    f"ppt/notesSlides/notesSlide{number}.xml",
                    _slide(_shape("sldImg"), _shape("body", notes[number]), _shape("sldNum", "9")),
                )
    return buf.getvalue()


# --------------------------------------------------------------------------- 추출


def test_slides_come_out_in_presentation_order_not_file_order(server) -> None:
    data = make_pptx(
        {1: _slide(_shape("title", "둘째로 발표")), 2: _slide(_shape("title", "첫째로 발표"))},
        order=[2, 1],
    )
    result = server.extract_pptx(data)
    assert [s["title"] for s in result["slides"]] == ["첫째로 발표", "둘째로 발표"]
    assert [s["n"] for s in result["slides"]] == [1, 2]


def test_title_body_table_and_notes_are_read_and_footers_skipped(server) -> None:
    slide = _slide(
        _shape("title", "분기 실적"),
        _shape(None, "매출 10% 증가", "비용 절감"),
        _table(("구분", "금액"), ("매출", "100")),
        _shape("sldNum", "7"),
        _shape("ftr", "사내 기밀"),
    )
    data = make_pptx({1: slide}, order=[1], notes={1: "여기서 강조하기"})
    s = server.extract_pptx(data)["slides"][0]
    assert s["title"] == "분기 실적"
    assert "매출 10% 증가" in s["text"] and "비용 절감" in s["text"]
    assert "구분 | 금액" in s["text"] and "매출 | 100" in s["text"]
    assert "7" not in s["text"].split() and "사내 기밀" not in s["text"]
    assert s["notes"] == "여기서 강조하기"


def test_falls_back_to_numeric_order_without_presentation_xml(server) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("ppt/slides/slide10.xml", _slide(_shape("title", "열번째")))
        zf.writestr("ppt/slides/slide2.xml", _slide(_shape("title", "두번째")))
    titles = [s["title"] for s in server.extract_pptx(buf.getvalue())["slides"]]
    assert titles == ["두번째", "열번째"]


def test_not_a_pptx_is_a_clear_error(server) -> None:
    with pytest.raises(server.ToolError, match="PowerPoint"):
        server.extract_pptx(b"\xd0\xcf\x11\xe0 legacy ppt bytes")


def test_doctype_in_slide_xml_is_refused(server) -> None:
    bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>' + _slide(_shape(None, "&a;"))
    data = make_pptx({1: bomb}, order=[1])
    # 정상 파일에는 없는 선언이라 파일 전체를 거절한다(호출부가 '건너뜀 + 이유'로 알린다).
    with pytest.raises(server.ToolError, match="XML 선언"):
        server.extract_pptx(data)


def test_oversized_uncompressed_content_is_refused(server, monkeypatch) -> None:
    monkeypatch.setattr(server, "MAX_UNCOMPRESSED_BYTES", 100)
    data = make_pptx({1: _slide(_shape(None, "x" * 500))}, order=[1])
    with pytest.raises(server.ToolError, match="너무 커서"):
        server.extract_pptx(data)


def test_render_respects_the_character_budget(server) -> None:
    slides = [{"n": i, "title": f"T{i}", "text": "가" * 300, "notes": ""} for i in range(1, 6)]
    kept, truncated = server.render_slides(slides, 700)
    assert truncated is True
    assert 1 <= len(kept) < 5
    assert sum(len(s["title"]) + len(s["text"]) + len(s["notes"]) for s in kept) <= 705


# --------------------------------------------------------------------------- Tool 처리


class FakeBox:
    def __init__(self, files=None, skipped=None, more=False) -> None:
        self.files = files or []
        self.skipped = skipped or []
        self.more = more
        self.seen: dict = {}

    def find_presentations(self, folder, start, end, subject_contains, from_contains, max_files, entry_id):
        self.seen = {
            "folder": folder,
            "start": start,
            "end": end,
            "subject_contains": subject_contains,
            "from_contains": from_contains,
            "max_files": max_files,
            "entry_id": entry_id,
        }
        return {"files": self.files, "skipped": self.skipped, "scanned": 4, "more": self.more}


def _entry(data: bytes, name: str = "보고.pptx") -> dict:
    return {
        "id": "E1",
        "time": "2026-09-30T09:00",
        "from": "김연구",
        "subject": "주간 보고",
        "file": name,
        "size_bytes": len(data),
        "data": data,
    }


def _call(server, arguments: dict) -> types.CallToolResult:
    return asyncio.run(
        server.on_call_tool(None, types.CallToolRequestParams(name="outlook.read_presentations", arguments=arguments))
    )


def test_reads_attachment_and_never_returns_raw_bytes(server) -> None:
    data = make_pptx({1: _slide(_shape("title", "결과 요약"), _shape(None, "핵심 수치"))}, order=[1])
    box = FakeBox(files=[_entry(data)])
    server.mailbox_factory = lambda: box
    server.today_provider = lambda: dt.date(2026, 9, 30)

    result = _call(server, {})
    assert not result.is_error
    text = result.content[0].text
    assert "보고.pptx" in text and "결과 요약" in text and "핵심 수치" in text
    payload = json.dumps(result.structured_content, ensure_ascii=False)
    assert "data" not in result.structured_content["files"][0]
    assert "PK" not in payload  # zip 매직 바이트가 섞여 나오지 않는다
    # 기간을 안 주면 최근 7일(오늘 포함).
    assert box.seen["start"].date() == dt.date(2026, 9, 24)


def test_filters_and_specific_message_are_passed_through(server) -> None:
    box = FakeBox()
    server.mailbox_factory = lambda: box
    _call(server, {"subject_contains": "주간", "from_contains": "김", "max_files": 2, "id": "ENTRY-9"})
    assert box.seen["subject_contains"] == "주간"
    assert box.seen["from_contains"] == "김"
    assert box.seen["max_files"] == 2
    assert box.seen["entry_id"] == "ENTRY-9"


def test_empty_result_says_so_and_lists_skipped_files(server) -> None:
    server.mailbox_factory = lambda: FakeBox(
        skipped=[{"subject": "옛 자료", "file": "old.ppt", "reason": "옛 형식(.ppt)은 지원하지 않습니다"}]
    )
    result = _call(server, {"days": 3})
    assert not result.is_error
    text = result.content[0].text
    assert "찾지 못했습니다" in text and "old.ppt" in text


def test_a_broken_attachment_is_skipped_not_fatal(server) -> None:
    good = make_pptx({1: _slide(_shape("title", "정상"))}, order=[1])
    server.mailbox_factory = lambda: FakeBox(files=[_entry(b"not a zip", "깨짐.pptx"), _entry(good, "정상.pptx")])
    result = _call(server, {})
    assert not result.is_error
    data = result.structured_content
    assert [f["file"] for f in data["files"]] == ["정상.pptx"]
    assert data["skipped"][0]["file"] == "깨짐.pptx"


@pytest.mark.parametrize(
    "arguments, fragment",
    [
        ({"max_files": 0}, "max_files"),
        ({"max_files": 99}, "max_files"),
        ({"max_chars": 10}, "max_chars"),
        ({"folder": "trash"}, "folder"),
        ({"subject_contains": "x" * 101}, "subject_contains"),
    ],
)
def test_invalid_arguments_are_refused_before_touching_outlook(server, arguments, fragment) -> None:
    def boom():
        raise AssertionError("잘못된 입력인데 Outlook 을 열었다")

    server.mailbox_factory = boom
    result = _call(server, arguments)
    assert result.is_error and fragment in result.content[0].text


def test_declared_read_only_and_matches_live_schema(server) -> None:
    manifest = json.loads((SERVER_DIR / "mcp-server-manifest.json").read_text(encoding="utf-8"))
    declared = {t["tool_name"]: t for t in manifest["declared_tools"]}
    tool = declared["outlook.read_presentations"]
    assert tool["risk_level"] == "READ_ONLY"
    assert tool["input_schema"] == server.PRESENTATIONS_SCHEMA
    assert tool["permissions"]["allowed_roles"] and tool["permissions"]["allowed_orgs"]


def test_attachment_bytes_prefers_memory_and_falls_back_to_a_server_chosen_name(server) -> None:
    box = server.OutlookMailbox

    class InMemory:
        class PropertyAccessor:
            @staticmethod
            def GetProperty(_name):  # noqa: N802
                return memoryview(b"abc")

    assert box._attachment_bytes(InMemory()) == b"abc"

    saved: list[str] = []

    class DiskOnly:
        FileName = "../../evil.pptx"

        class PropertyAccessor:
            @staticmethod
            def GetProperty(_name):  # noqa: N802
                raise OSError("blocked")

        def SaveAsFile(self, path):  # noqa: N802
            saved.append(path)
            Path(path).write_bytes(b"from disk")

    assert box._attachment_bytes(DiskOnly()) == b"from disk"
    # 첨부 파일의 이름이 경로에 들어가지 않는다.
    assert saved and "evil" not in saved[0]
    assert not Path(saved[0]).exists()  # 읽은 뒤 지워진다
