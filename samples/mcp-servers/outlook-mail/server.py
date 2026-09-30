"""Outlook 메일 stdio MCP 서버 — 기간별 메일 읽기 + 임시 보관함에 초안 저장(보내지는 않는다).

이 PC 에 설치된 **클래식 Outlook(데스크톱)** 을 COM 으로 읽는다. 서버·토큰·
비밀번호가 필요 없고 네트워크를 쓰지 않는다 — Outlook 이 이미 동기화해 둔 메일을
그대로 읽을 뿐이다.

## Tool

- `outlook.list_messages` — 기간(`start_date`~`end_date`, 또는 최근 `days`일)의
  메일 목록. 폴더(받은편지함/보낸편지함), 안 읽은 메일만, 최대 개수를 고를 수 있다.
- `outlook.get_message` — 목록에서 받은 `id` 로 메일 한 통의 본문을 읽는다.
- `outlook.read_presentations` — 기간(기본 최근 7일)의 메일에 **첨부된 PowerPoint(.pptx)** 를 찾아
  슬라이드별 제목·본문·표·발표자 노트를 읽는다. 제목·보낸 사람으로 좁히거나 메일 `id` 하나를
  지정할 수 있다. 파일을 디스크에 저장하지 않고 받은 바이트를 메모리에서 바로 읽는다
  (`python-pptx` 없이 zip+XML 을 직접 읽는다). 이미지·차트 안의 글자는 읽지 않는다.
  옛 형식(.ppt)과 30MB 넘는 파일은 건너뛰고 이유를 알린다. 매크로는 실행하지 않는다.
- `outlook.create_draft` — 받는 사람·제목·본문으로 **임시 보관함에 초안을 저장**한다.

앞의 둘은 읽기 전용이다. 메일을 지우거나 읽음 표시를 바꾸지 않는다(COM 으로 본문을
읽는 것은 읽음 상태를 바꾸지 않는다).

**이 서버는 메일을 보내지 않는다.** `create_draft` 는 초안을 만들어 저장할 뿐이고,
Outlook 에서 내용을 확인하고 직접 보내는 것은 사람이다. 코드에 `Send` 호출이 없고,
시험이 그것을 고정한다(`tests/unit/mcp_samples/test_outlook_mail_draft.py`). 그래도
초안이 생기는 것은 부작용이라 매니페스트에 `WRITE`·`ALWAYS`(매번 확인)로 선언한다 —
그래서 AI 가 자동으로 고르지 않고, 사용자가 직접 지정했을 때만 확인 창을 거쳐 실행된다
(open-decisions.md D-108).

## 제약과 알아둘 것

- **클래식 Outlook 만 된다.** 새 Outlook(olk.exe)과 웹 Outlook 은 COM 을 제공하지
  않는다. Outlook 이 꺼져 있으면 COM 이 Outlook 을 띄운다.
- 표준 라이브러리 + `mcp` 만 쓴다. `win32com`(pywin32)은 Windows 에서 `mcp` 가 함께
  설치하는 의존성이다 — 따로 설치하지 않는다. 없으면 무엇이 없는지 말하고 실패한다.
- agent-runtime 은 이 프로세스를 `env={}` 로 띄운다. 환경변수를 읽지 않는다.
  COM 은 `gen_py` 캐시(쓰기 필요)를 만들지 않는 동적 디스패치만 쓴다.
- 보안 소프트웨어 상태에 따라 Outlook 이 "프로그램이 전자 메일 주소에 액세스하려고
  합니다" 확인 창을 띄울 수 있다(Outlook 개체 모델 보호). 그때는 PC 에서 허용해야 한다.
- 날짜는 **이 PC 의 현지 시각** 기준이다. `end_date` 는 그날 끝까지 포함한다.

## 실행 / 점검

인자가 없으면 stdio 서버로 뜬다. 인자가 있으면 서버를 띄우지 않고 점검만 한다:

    server.py --check
    server.py --list-tools
    server.py --call outlook.list_messages --args "{\"days\": 3}"
    server.py --call outlook.get_message --args "{\"id\": \"<목록의 id>\"}"
    server.py --yes --call outlook.create_draft --args "{\"to\": [\"a@example.com\"], \"subject\": \"제목\", \"body\": \"본문\"}"
    server.py --help
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import io
import json
import pathlib
import posixpath
import re
import sys
import tempfile
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

DEFAULT_MANIFEST = pathlib.Path(__file__).with_name("mcp-server-manifest.json")

MAX_RESULTS_LIMIT = 100
MAX_DAYS = 366
PREVIEW_CHARS = 200
# 목록의 받는 사람 요약(앞 3명, 최대 60자 + "외 N명").
RECIPIENT_NAMES = 3
RECIPIENT_CHARS = 60
BODY_DEFAULT_CHARS = 4000
BODY_MAX_CHARS = 20000

# Outlook 폴더 상수(OlDefaultFolders)와 항목 클래스(OlObjectClass).
_FOLDERS = {"inbox": 6, "sent": 5}
_OL_MAIL = 43

LIST_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "start_date": {
            "type": "string",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
            "description": "시작일 YYYY-MM-DD (그날 0시부터). days 와 함께 쓰지 않는다.",
        },
        "end_date": {
            "type": "string",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
            "description": "종료일 YYYY-MM-DD (그날 끝까지 포함). 생략하면 시작일 하루 또는 오늘까지.",
        },
        "days": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_DAYS,
            "description": "오늘을 포함한 최근 N일. 날짜를 정확히 모를 때 쓴다(예: 최근 3일이면 3).",
        },
        "folder": {
            "type": "string",
            "enum": ["inbox", "sent"],
            "description": "inbox=받은편지함(기본), sent=보낸편지함",
        },
        "unread_only": {"type": "boolean", "description": "안 읽은 메일만 (기본 false)"},
        "max_results": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_RESULTS_LIMIT,
            "description": "최대 개수 (기본 20). 최신 메일부터.",
        },
    },
}

GET_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id"],
    "properties": {
        "id": {"type": "string", "minLength": 1, "description": "outlook.list_messages 결과의 id"},
        "max_chars": {
            "type": "integer",
            "minimum": 200,
            "maximum": BODY_MAX_CHARS,
            "description": f"본문 최대 글자 수 (기본 {BODY_DEFAULT_CHARS})",
        },
    },
}


MAX_RECIPIENTS = 20
MAX_SUBJECT_CHARS = 200
MAX_DRAFT_BODY_CHARS = 20000

DRAFT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["to", "subject", "body"],
    "properties": {
        "to": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_RECIPIENTS,
            "items": {"type": "string", "minLength": 3, "maxLength": 254},
            "description": "받는 사람 이메일 주소 목록. 사용자가 말한 주소만 쓴다.",
        },
        "cc": {
            "type": "array",
            "maxItems": MAX_RECIPIENTS,
            "items": {"type": "string", "minLength": 3, "maxLength": 254},
            "description": "참조 이메일 주소 목록 (선택).",
        },
        "subject": {
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_SUBJECT_CHARS,
            "description": "메일 제목 (한 줄).",
        },
        "body": {
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_DRAFT_BODY_CHARS,
            "description": "메일 본문 (일반 텍스트).",
        },
    },
}


MAX_PRESENTATION_FILES = 5
DEFAULT_PRESENTATION_FILES = 3
DEFAULT_PRESENTATION_DAYS = 7
DEFAULT_PRESENTATION_CHARS = 6000
MAX_PRESENTATION_CHARS = 20000
MAX_FILTER_CHARS = 100
# 한 번에 훑는 메일 수의 상한 — 오래된 메일함에서 끝없이 돌지 않게.
MAX_SCANNED_MESSAGES = 500

PRESENTATIONS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "start_date": LIST_SCHEMA["properties"]["start_date"],
        "end_date": LIST_SCHEMA["properties"]["end_date"],
        "days": {
            **LIST_SCHEMA["properties"]["days"],
            "description": f"사용자가 기간을 말했을 때만(최근 3일이면 3). 말하지 않았으면 생략 — 기본 최근 {DEFAULT_PRESENTATION_DAYS}일.",
        },
        "folder": LIST_SCHEMA["properties"]["folder"],
        "subject_contains": {
            "type": "string",
            "maxLength": MAX_FILTER_CHARS,
            "description": "사용자가 메일 제목의 일부를 직접 말했을 때만. '파워포인트'·'ppt' 같은 파일 종류는 넣지 않는다.",
        },
        "from_contains": {
            "type": "string",
            "maxLength": MAX_FILTER_CHARS,
            "description": "사용자가 보낸 사람(이름·주소)을 말했을 때만.",
        },
        "id": {
            "type": "string",
            "minLength": 1,
            "description": "특정 메일 한 통만 읽을 때 outlook.list_messages 결과의 id (선택).",
        },
        "max_files": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_PRESENTATION_FILES,
            "description": f"읽을 파일 최대 개수 (기본 {DEFAULT_PRESENTATION_FILES}). 최신 메일부터.",
        },
        "max_chars": {
            "type": "integer",
            "minimum": 1000,
            "maximum": MAX_PRESENTATION_CHARS,
            "description": f"전체 결과 글자 수 상한 (기본 {DEFAULT_PRESENTATION_CHARS}). 파일 수로 나눠 쓴다.",
        },
    },
}

# 첨부 파일 한 개의 상한과, 압축을 풀었을 때의 상한(zip 폭탄 방지).
MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024
MAX_XML_BYTES = 10 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
MAX_SLIDES = 300
_PPTX_EXTENSIONS = (".pptx", ".pptm")
# PR_ATTACH_DATA_BIN — 첨부 파일의 바이트를 디스크에 쓰지 않고 바로 받는다.
_PR_ATTACH_DATA_BIN = "http://schemas.microsoft.com/mapi/proptag/0x37010102"


class ToolError(Exception):
    """사용자에게 그대로 보여 줄 수 있는 실패 — 무엇을 고치면 되는지 담는다."""


# --------------------------------------------------------------------------- PPTX 텍스트 추출
#
# .pptx 는 zip 안의 XML 이다. python-pptx 없이 표준 라이브러리(zipfile, xml)만으로
# 슬라이드 순서대로 제목·본문·표·발표자 노트를 읽는다. 매크로를 실행하지 않고, 이미지·차트
# 안의 글자는 읽지 않는다(텍스트 상자·표·노트만).

_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
_SKIP_PLACEHOLDERS = {"sldNum", "dt", "ftr", "hdr"}


def _parse_xml(zf: zipfile.ZipFile, name: str) -> ET.Element:
    info = zf.getinfo(name)  # 없으면 KeyError
    if info.file_size > MAX_XML_BYTES:
        raise ToolError(f"'{name}' 이(가) 너무 큽니다.")
    raw = zf.read(name)
    lowered = raw.lower()
    # 엔티티 폭탄(billion laughs)을 막는다 — 정상 파워포인트 XML 에는 DOCTYPE 이 없다.
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise ToolError("허용되지 않는 XML 선언이 있어 읽지 않았습니다.")
    return ET.fromstring(raw)


def _resolve_target(base_dir: str, target: str) -> str:
    return target[1:] if target.startswith("/") else posixpath.normpath(posixpath.join(base_dir, target))


def _relationships(zf: zipfile.ZipFile, rels_name: str, base_dir: str) -> list[tuple[str, str, str]]:
    """(Id, Type, 정규화된 Target) 목록. 관계 파일이 없으면 빈 목록."""
    try:
        root = _parse_xml(zf, rels_name)
    except KeyError:
        return []
    return [
        (r.get("Id", ""), r.get("Type", ""), _resolve_target(base_dir, r.get("Target", "")))
        for r in root.iter(f"{{{_REL}}}Relationship")
    ]


def _slide_parts(zf: zipfile.ZipFile) -> list[str]:
    """슬라이드 파트를 **발표 순서대로**. presentation.xml 의 목록을 따르고, 없으면 번호순."""
    names = set(zf.namelist())
    ordered: list[str] = []
    try:
        pres = _parse_xml(zf, "ppt/presentation.xml")
        target_by_id = {rid: target for rid, _, target in _relationships(zf, "ppt/_rels/presentation.xml.rels", "ppt")}
        for sld in pres.iter(f"{{{_P}}}sldId"):
            target = target_by_id.get(sld.get(f"{{{_R}}}id", ""))
            if target:
                ordered.append(target)
    except (KeyError, ET.ParseError):
        ordered = []
    ordered = [n for n in ordered if n in names]
    if not ordered:
        numbered = [(int(m.group(1)), n) for n in names if (m := re.fullmatch(r"ppt/slides/slide(\d+)\.xml", n))]
        ordered = [n for _, n in sorted(numbered)]
    return ordered


def _paragraph_text(paragraph: ET.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == f"{{{_A}}}t":
            parts.append(node.text or "")
        elif node.tag == f"{{{_A}}}br":
            parts.append("\n")
    return "".join(parts).strip()


def _placeholder_type(shape: ET.Element) -> str | None:
    ph = shape.find(f"{{{_P}}}nvSpPr/{{{_P}}}nvPr/{{{_P}}}ph")
    return None if ph is None else (ph.get("type") or "body")


def _collect(node: ET.Element, lines: list[str], title: list[str], *, notes_only_body: bool) -> None:
    for child in node:
        if child.tag == f"{{{_P}}}sp":
            kind = _placeholder_type(child)
            if kind in _SKIP_PLACEHOLDERS or (notes_only_body and kind != "body"):
                continue
            paragraphs = [
                t for t in (_paragraph_text(p) for p in child.findall(f"{{{_P}}}txBody/{{{_A}}}p")) if t
            ]
            if kind in ("title", "ctrTitle") and paragraphs and not title:
                title.append(" ".join(paragraphs))
            else:
                lines.extend(paragraphs)
        elif child.tag == f"{{{_P}}}graphicFrame" and not notes_only_body:
            for row in child.iter(f"{{{_A}}}tr"):
                cells = [
                    " ".join(t for t in (_paragraph_text(p) for p in cell.findall(f"{{{_A}}}txBody/{{{_A}}}p")) if t)
                    for cell in row.findall(f"{{{_A}}}tc")
                ]
                if any(cells):
                    lines.append(" | ".join(cells))
        elif child.tag == f"{{{_P}}}grpSp":
            _collect(child, lines, title, notes_only_body=notes_only_body)


def _shape_tree(root: ET.Element) -> ET.Element | None:
    return root.find(f"{{{_P}}}cSld/{{{_P}}}spTree")


def extract_pptx(data: bytes) -> dict:
    """PPTX 바이트에서 슬라이드별 제목·본문·발표자 노트를 뽑는다. 입력이 pptx 가 아니거나
    비정상적으로 크면 `ToolError`."""
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise ToolError("첨부 파일이 너무 큽니다.")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ToolError("PowerPoint(.pptx) 형식이 아닙니다. 옛 형식(.ppt)은 지원하지 않습니다.") from None
    with zf:
        if sum(i.file_size for i in zf.infolist()) > MAX_UNCOMPRESSED_BYTES:
            raise ToolError("압축을 풀면 너무 커서 읽지 않았습니다.")
        parts = _slide_parts(zf)
        if not parts:
            raise ToolError("슬라이드를 찾지 못했습니다. PowerPoint 파일이 맞는지 확인하세요.")
        slides: list[dict] = []
        for number, part in enumerate(parts[:MAX_SLIDES], start=1):
            try:
                root = _parse_xml(zf, part)
            except (KeyError, ET.ParseError):
                slides.append({"n": number, "title": "", "text": "", "notes": ""})
                continue
            lines: list[str] = []
            title: list[str] = []
            tree = _shape_tree(root)
            if tree is not None:
                _collect(tree, lines, title, notes_only_body=False)
            notes_lines: list[str] = []
            slide_dir = posixpath.dirname(part)
            rels_name = posixpath.join(slide_dir, "_rels", posixpath.basename(part) + ".rels")
            for _, rel_type, target in _relationships(zf, rels_name, slide_dir):
                if rel_type.endswith("/notesSlide"):
                    try:
                        notes_tree = _shape_tree(_parse_xml(zf, target))
                    except (KeyError, ET.ParseError):
                        notes_tree = None
                    if notes_tree is not None:
                        _collect(notes_tree, notes_lines, [], notes_only_body=True)
            slides.append(
                {
                    "n": number,
                    "title": title[0] if title else "",
                    "text": "\n".join(lines),
                    "notes": "\n".join(notes_lines),
                }
            )
    return {"slide_count": len(parts), "slides": slides, "slides_truncated": len(parts) > MAX_SLIDES}


def render_slides(slides: list[dict], budget: int) -> tuple[list[dict], bool]:
    """글자 수 예산 안에서 앞 슬라이드부터 담는다. 넘치면 그 슬라이드를 잘라 표시하고 멈춘다."""
    out: list[dict] = []
    used = 0
    for slide in slides:
        size = len(slide["title"]) + len(slide["text"]) + len(slide["notes"])
        if used + size <= budget:
            out.append(slide)
            used += size
            continue
        room = max(budget - used, 0)
        if room > 0:
            kept = dict(slide)
            kept["text"] = clip(slide["text"], max(room - len(slide["title"]), 0))[0]
            kept["notes"] = ""
            out.append(kept)
        return out, True
    return out, False


# --------------------------------------------------------------------------- 순수 로직


def resolve_range(arguments: dict, today: dt.date) -> tuple[dt.datetime, dt.datetime]:
    """인자 → [시작, 끝) 현지 시각 구간. 끝은 종료일 다음 날 0시(그날 끝까지 포함)."""
    days = arguments.get("days")
    start_s = arguments.get("start_date")
    end_s = arguments.get("end_date")
    if days is not None and (start_s or end_s):
        raise ToolError("days 와 start_date/end_date 는 함께 쓸 수 없습니다. 하나만 주세요.")

    def parse(value: str, name: str) -> dt.date:
        try:
            return dt.date.fromisoformat(value)
        except ValueError:
            raise ToolError(f"{name} 는 YYYY-MM-DD 형식이어야 합니다: {value!r}") from None

    if days is not None:
        if not isinstance(days, int) or not 1 <= days <= MAX_DAYS:
            raise ToolError(f"days 는 1~{MAX_DAYS} 사이 정수여야 합니다.")
        start, end = today - dt.timedelta(days=days - 1), today
    elif start_s:
        start = parse(start_s, "start_date")
        end = parse(end_s, "end_date") if end_s else start
    elif end_s:
        raise ToolError("end_date 만 줄 수는 없습니다. start_date 도 주거나 days 를 쓰세요.")
    else:
        start = end = today

    if end < start:
        raise ToolError(f"종료일({end})이 시작일({start})보다 앞입니다.")
    if (end - start).days + 1 > MAX_DAYS:
        raise ToolError(f"기간은 최대 {MAX_DAYS}일입니다.")
    return dt.datetime.combine(start, dt.time()), dt.datetime.combine(
        end + dt.timedelta(days=1), dt.time()
    )


def summarize_recipients(
    raw: Any, max_names: int = RECIPIENT_NAMES, max_chars: int = RECIPIENT_CHARS
) -> str:
    """목록에는 받는 사람을 다 싣지 않는다 — 앞의 몇 명과 나머지 수만.

    전체 수신인은 단체 메일에서 수백 명이 되기도 해 목록 결과를 부풀리고, 모델
    입력 한도와 `execution_guards.max_bytes` 를 먼저 채운다. 전체가 필요하면
    `outlook.get_message` 가 준다.
    """
    names = [n.strip() for n in str(raw or "").split(";") if n.strip()]
    if not names:
        return ""
    shown = "; ".join(names[:max_names])
    if len(shown) > max_chars:
        shown = shown[:max_chars].rstrip() + "…"
    rest = len(names) - min(len(names), max_names)
    return f"{shown} 외 {rest}명" if rest else shown


def local_naive(value: Any) -> dt.datetime | None:
    """Outlook 이 주는 시각 → 현지 naive datetime.

    pywin32 는 Outlook 의 **현지 시각에 UTC 표시를 붙여** 돌려준다(잘 알려진 특성).
    변환하지 않고 표시만 떼어 현지 시각으로 쓴다 — 변환하면 시차만큼 틀린다.
    """
    if value is None:
        return None
    try:
        return dt.datetime(
            value.year, value.month, value.day, value.hour, value.minute, value.second
        )
    except (AttributeError, ValueError):
        return None


def clip(text: Any, limit: int) -> tuple[str, bool]:
    s = (
        " ".join(str(text or "").split())
        if limit <= PREVIEW_CHARS
        else str(text or "").replace("\r\n", "\n").strip()
    )
    return (s, False) if len(s) <= limit else (s[:limit].rstrip() + "…", True)


# --------------------------------------------------------------------------- Outlook 접근


class OutlookMailbox:
    """클래식 Outlook COM 을 감싼다. 호출마다 그 스레드에서 COM 을 초기화한다."""

    def _session(self):
        try:
            import pythoncom  # noqa: PLC0415 — Windows 전용, 점검 모드에서는 불필요
            from win32com.client import dynamic  # noqa: PLC0415
        except ImportError:
            raise ToolError(
                "pywin32(win32com)를 찾을 수 없습니다. 이 서버는 Windows 에서 mcp 와 함께 설치되는 "
                "pywin32 가 필요합니다."
            ) from None
        pythoncom.CoInitialize()
        try:
            # 동적 디스패치: gen_py 캐시 파일을 쓰지 않는다(설치 폴더는 쓰기 불가).
            app = dynamic.Dispatch("Outlook.Application")
            return app.GetNamespace("MAPI")
        except Exception as exc:  # noqa: BLE001 — COM 오류는 종류가 많다
            raise ToolError(
                "Outlook 에 연결하지 못했습니다. 클래식 Outlook(데스크톱)이 설치·설정되어 있어야 합니다"
                f"(새 Outlook 은 지원하지 않습니다). 원인: {type(exc).__name__}"
            ) from None

    @staticmethod
    def _sender_email(item) -> str:
        try:
            if getattr(item, "SenderEmailType", "") == "EX":
                user = item.Sender.GetExchangeUser()
                if user is not None and user.PrimarySmtpAddress:
                    return str(user.PrimarySmtpAddress)
        except Exception:  # noqa: BLE001
            pass
        return str(getattr(item, "SenderEmailAddress", "") or "")

    def list_messages(
        self, folder: str, start: dt.datetime, end: dt.datetime, unread_only: bool, limit: int
    ) -> tuple[list[dict], bool]:
        ns = self._session()
        items = ns.GetDefaultFolder(_FOLDERS[folder]).Items
        time_prop = "SentOn" if folder == "sent" else "ReceivedTime"
        # 로캘에 따라 형식이 달라지는 Restrict 날짜 필터를 쓰지 않는다. 최신순으로
        # 정렬해 훑다가 시작일보다 오래된 메일이 나오면 멈춘다.
        items.Sort(f"[{time_prop}]", True)
        out: list[dict] = []
        truncated = False
        item = items.GetFirst()
        while item is not None:
            when = local_naive(getattr(item, time_prop, None))
            if when is not None and when < start:
                break
            if when is not None and when < end and getattr(item, "Class", None) == _OL_MAIL:
                if not unread_only or bool(getattr(item, "UnRead", False)):
                    if len(out) >= limit:
                        truncated = True
                        break
                    preview, _ = clip(getattr(item, "Body", ""), PREVIEW_CHARS)
                    out.append(
                        {
                            "id": str(item.EntryID),
                            "time": when.isoformat(timespec="minutes"),
                            "from": str(getattr(item, "SenderName", "") or ""),
                            "from_email": self._sender_email(item),
                            "to": summarize_recipients(getattr(item, "To", "")),
                            "subject": str(getattr(item, "Subject", "") or ""),
                            "unread": bool(getattr(item, "UnRead", False)),
                            "has_attachments": int(
                                getattr(getattr(item, "Attachments", None), "Count", 0) or 0
                            )
                            > 0,
                            "preview": preview,
                        }
                    )
            item = items.GetNext()
        return out, truncated

    @staticmethod
    def _attachment_bytes(attachment) -> bytes:
        """첨부 파일의 바이트. 디스크에 쓰지 않는 경로를 먼저 쓰고, 안 되면 임시 폴더에
        **서버가 정한 이름**으로 저장했다가 읽고 바로 지운다 — 첨부 파일의 이름으로 경로를
        만들지 않는다(사용자가 정한 이름이 경로가 되면 안 된다)."""
        try:
            return bytes(attachment.PropertyAccessor.GetProperty(_PR_ATTACH_DATA_BIN))
        except Exception:  # noqa: BLE001
            pass
        try:
            with tempfile.TemporaryDirectory(prefix="outlook-att-") as directory:
                path = pathlib.Path(directory) / "attachment.bin"
                attachment.SaveAsFile(str(path))
                return path.read_bytes()
        except Exception as exc:  # noqa: BLE001
            raise ToolError(
                f"첨부 파일을 받지 못했습니다. Outlook 의 보안 확인 창이 떠 있다면 허용하세요. 원인: {type(exc).__name__}"
            ) from None

    def find_presentations(
        self,
        folder: str,
        start: dt.datetime,
        end: dt.datetime,
        subject_contains: str,
        from_contains: str,
        max_files: int,
        entry_id: str,
    ) -> dict:
        """기간 안의 메일에서 PowerPoint 첨부를 찾아 바이트까지 받아 온다. 메일은 바꾸지 않는다."""
        ns = self._session()
        if entry_id:
            try:
                candidates = [ns.GetItemFromID(entry_id)]
            except Exception:  # noqa: BLE001
                raise ToolError(
                    "해당 id 의 메일을 찾지 못했습니다. outlook.list_messages 로 다시 조회해 id 를 확인하세요."
                ) from None
            time_prop = "ReceivedTime"
        else:
            items = ns.GetDefaultFolder(_FOLDERS[folder]).Items
            time_prop = "SentOn" if folder == "sent" else "ReceivedTime"
            items.Sort(f"[{time_prop}]", True)
            candidates = None

        files: list[dict] = []
        skipped: list[dict] = []
        scanned = 0
        more = False

        def visit(item) -> bool:
            """파일 개수 상한에 닿으면 False."""
            nonlocal more
            subject = str(getattr(item, "Subject", "") or "")
            sender = f"{getattr(item, 'SenderName', '')} {self._sender_email(item)}"
            if subject_contains and subject_contains.lower() not in subject.lower():
                return True
            if from_contains and from_contains.lower() not in sender.lower():
                return True
            attachments = getattr(item, "Attachments", None)
            for index in range(1, int(getattr(attachments, "Count", 0) or 0) + 1):
                attachment = attachments.Item(index)
                name = str(getattr(attachment, "FileName", "") or "")
                if not name.lower().endswith(_PPTX_EXTENSIONS):
                    if name.lower().endswith(".ppt"):
                        skipped.append({"subject": subject, "file": name, "reason": "옛 형식(.ppt)은 지원하지 않습니다"})
                    continue
                if len(files) >= max_files:
                    more = True
                    return False
                size = int(getattr(attachment, "Size", 0) or 0)
                if size > MAX_ATTACHMENT_BYTES:
                    skipped.append({"subject": subject, "file": name, "reason": "파일이 너무 큽니다"})
                    continue
                when = local_naive(getattr(item, time_prop, None))
                try:
                    data = self._attachment_bytes(attachment)
                except ToolError as exc:
                    skipped.append({"subject": subject, "file": name, "reason": str(exc)})
                    continue
                files.append(
                    {
                        "id": str(getattr(item, "EntryID", "")),
                        "time": when.isoformat(timespec="minutes") if when else None,
                        "from": str(getattr(item, "SenderName", "") or ""),
                        "subject": subject,
                        "file": name,
                        "size_bytes": size or len(data),
                        "data": data,
                    }
                )
            return True

        if candidates is not None:
            for item in candidates:
                visit(item)
        else:
            item = items.GetFirst()
            while item is not None and scanned < MAX_SCANNED_MESSAGES:
                when = local_naive(getattr(item, time_prop, None))
                if when is not None and when < start:
                    break
                if when is not None and when < end and getattr(item, "Class", None) == _OL_MAIL:
                    scanned += 1
                    if not visit(item):
                        break
                item = items.GetNext()
        return {"files": files, "skipped": skipped, "scanned": scanned, "more": more}

    def create_draft(self, to: list[str], cc: list[str], subject: str, body: str) -> dict:
        """받은 내용으로 메일을 만들어 **임시 보관함에 저장**한다. 보내지 않는다 —
        이 메서드는 `Save()` 만 부르고 `Send()` 는 어디서도 부르지 않는다."""
        ns = self._session()
        try:
            mail = ns.Application.CreateItem(0)  # olMailItem
            mail.To = "; ".join(to)
            if cc:
                mail.CC = "; ".join(cc)
            mail.Subject = subject
            mail.Body = body
            mail.Save()
            entry_id = str(mail.EntryID)
        except Exception as exc:  # noqa: BLE001 — COM 오류는 종류가 많다
            raise ToolError(
                f"초안을 저장하지 못했습니다. Outlook 이 응답하는지 확인하세요. 원인: {type(exc).__name__}"
            ) from None
        return {"id": entry_id, "saved_to": "임시 보관함", "sent": False}

    def get_message(self, entry_id: str, max_chars: int) -> dict:
        ns = self._session()
        try:
            item = ns.GetItemFromID(entry_id)
        except Exception:  # noqa: BLE001
            raise ToolError(
                "해당 id 의 메일을 찾지 못했습니다. outlook.list_messages 로 다시 조회해 id 를 확인하세요."
            ) from None
        body, truncated = clip(getattr(item, "Body", ""), max_chars)
        attachments = []
        att = getattr(item, "Attachments", None)
        for i in range(1, int(getattr(att, "Count", 0) or 0) + 1):
            try:
                attachments.append(str(att.Item(i).FileName))
            except Exception:  # noqa: BLE001
                continue
        when = local_naive(getattr(item, "ReceivedTime", None) or getattr(item, "SentOn", None))
        return {
            "id": entry_id,
            "time": when.isoformat(timespec="minutes") if when else None,
            "from": str(getattr(item, "SenderName", "") or ""),
            "from_email": self._sender_email(item),
            "to": str(getattr(item, "To", "") or ""),
            "cc": str(getattr(item, "CC", "") or ""),
            "subject": str(getattr(item, "Subject", "") or ""),
            "body": body,
            "body_truncated": truncated,
            "attachments": attachments,
        }


#: 점검·시험에서 바꿔 끼울 수 있게 모듈 수준에 둔다.
mailbox_factory = OutlookMailbox
today_provider = dt.date.today


# --------------------------------------------------------------------------- Tool 처리


def _list_messages(arguments: dict) -> dict:
    start, end = resolve_range(arguments, today_provider())
    folder = arguments.get("folder", "inbox")
    if folder not in _FOLDERS:
        raise ToolError("folder 는 inbox 또는 sent 입니다.")
    limit = arguments.get("max_results", 20)
    if not isinstance(limit, int) or not 1 <= limit <= MAX_RESULTS_LIMIT:
        raise ToolError(f"max_results 는 1~{MAX_RESULTS_LIMIT} 사이 정수입니다.")
    messages, truncated = mailbox_factory().list_messages(
        folder, start, end, bool(arguments.get("unread_only", False)), limit
    )
    return {
        "folder": folder,
        "start": start.date().isoformat(),
        "end": (end - dt.timedelta(days=1)).date().isoformat(),
        "count": len(messages),
        "truncated": truncated,
        "messages": messages,
    }


def _get_message(arguments: dict) -> dict:
    entry_id = str(arguments.get("id") or "").strip()
    if not entry_id:
        raise ToolError("id 가 필요합니다. outlook.list_messages 결과의 id 를 주세요.")
    max_chars = arguments.get("max_chars", BODY_DEFAULT_CHARS)
    if not isinstance(max_chars, int) or not 200 <= max_chars <= BODY_MAX_CHARS:
        raise ToolError(f"max_chars 는 200~{BODY_MAX_CHARS} 사이 정수입니다.")
    return mailbox_factory().get_message(entry_id, max_chars)


def _read_presentations(arguments: dict) -> dict:
    """기간(기본 최근 7일)의 메일에서 PowerPoint 첨부를 찾아 슬라이드 글을 돌려준다.
    파일을 디스크에 저장하지 않는다 — 받은 바이트를 메모리에서 바로 읽는다."""
    entry_id = str(arguments.get("id") or "").strip()
    range_args = dict(arguments)
    if not entry_id and not any(k in range_args for k in ("start_date", "end_date", "days")):
        range_args["days"] = DEFAULT_PRESENTATION_DAYS
    start, end = resolve_range(range_args, today_provider())
    folder = arguments.get("folder", "inbox")
    if folder not in _FOLDERS:
        raise ToolError("folder 는 inbox 또는 sent 입니다.")
    max_files = arguments.get("max_files", DEFAULT_PRESENTATION_FILES)
    if not isinstance(max_files, int) or not 1 <= max_files <= MAX_PRESENTATION_FILES:
        raise ToolError(f"max_files 는 1~{MAX_PRESENTATION_FILES} 사이 정수입니다.")
    max_chars = arguments.get("max_chars", DEFAULT_PRESENTATION_CHARS)
    if not isinstance(max_chars, int) or not 1000 <= max_chars <= MAX_PRESENTATION_CHARS:
        raise ToolError(f"max_chars 는 1000~{MAX_PRESENTATION_CHARS} 사이 정수입니다.")
    filters = {}
    for key in ("subject_contains", "from_contains"):
        value = str(arguments.get(key) or "").strip()
        if len(value) > MAX_FILTER_CHARS:
            raise ToolError(f"{key} 는 최대 {MAX_FILTER_CHARS}자입니다.")
        filters[key] = value

    found = mailbox_factory().find_presentations(
        folder, start, end, filters["subject_contains"], filters["from_contains"], max_files, entry_id
    )
    per_file = max_chars // max(len(found["files"]), 1)
    files: list[dict] = []
    skipped = list(found["skipped"])
    for entry in found["files"]:
        meta = {k: v for k, v in entry.items() if k != "data"}
        try:
            extracted = extract_pptx(entry["data"])
        except (ToolError, ET.ParseError, zipfile.BadZipFile) as exc:
            skipped.append({"subject": entry["subject"], "file": entry["file"], "reason": str(exc)})
            continue
        slides, truncated = render_slides(extracted["slides"], per_file)
        files.append(
            {
                **meta,
                "slide_count": extracted["slide_count"],
                "slides_truncated": extracted["slides_truncated"],
                "truncated": truncated,
                "slides": slides,
            }
        )
    return {
        "folder": folder,
        "start": start.date().isoformat(),
        "end": (end - dt.timedelta(days=1)).date().isoformat(),
        "scanned": found["scanned"],
        "more_files_available": found["more"],
        "files": files,
        "skipped": skipped,
    }


_ADDRESS = re.compile(r"^[^@\s;,<>\"]+@[^@\s;,<>\"]+\.[^@\s;,<>\"]+$")


def _addresses(arguments: dict, key: str, *, required: bool) -> list[str]:
    raw = arguments.get(key)
    if raw is None and not required:
        return []
    if not isinstance(raw, list) or (required and not raw):
        raise ToolError(f"{key} 는 이메일 주소 목록이어야 합니다.")
    if len(raw) > MAX_RECIPIENTS:
        raise ToolError(f"{key} 는 최대 {MAX_RECIPIENTS}명입니다.")
    cleaned: list[str] = []
    for item in raw:
        address = str(item).strip()
        # 세미콜론·쉼표·줄바꿈이 섞이면 주소 하나가 여러 명(또는 헤더 삽입)이 된다.
        if not _ADDRESS.match(address):
            raise ToolError(f"{key} 에 올바르지 않은 이메일 주소가 있습니다: '{address}'")
        cleaned.append(address)
    return cleaned


def _create_draft(arguments: dict) -> dict:
    to = _addresses(arguments, "to", required=True)
    cc = _addresses(arguments, "cc", required=False)
    subject = str(arguments.get("subject") or "").strip()
    body = str(arguments.get("body") or "").replace("\r\n", "\n").strip()
    if not subject or "\n" in subject or "\r" in subject:
        raise ToolError("subject 는 한 줄의 비어 있지 않은 제목이어야 합니다.")
    if len(subject) > MAX_SUBJECT_CHARS:
        raise ToolError(f"subject 는 최대 {MAX_SUBJECT_CHARS}자입니다.")
    if not body:
        raise ToolError("body 가 비어 있습니다.")
    if len(body) > MAX_DRAFT_BODY_CHARS:
        raise ToolError(f"body 는 최대 {MAX_DRAFT_BODY_CHARS}자입니다.")
    result = mailbox_factory().create_draft(to, cc, subject, body)
    return {**result, "to": to, "cc": cc, "subject": subject}


def _summary(name: str, data: dict) -> str:
    if name == "outlook.read_presentations":
        if not data["files"]:
            head = f"{data['start']} ~ {data['end']} 기간의 메일에서 읽을 수 있는 PowerPoint(.pptx) 첨부를 찾지 못했습니다."
            reasons = [f"{s['file']}: {s['reason']}" for s in data["skipped"]]
            return head + ("\n건너뛴 파일: " + "; ".join(reasons) if reasons else "")
        blocks = [f"{data['start']} ~ {data['end']} 메일의 PowerPoint 첨부 {len(data['files'])}개"]
        for f in data["files"]:
            blocks.append(f"\n■ {f['file']} — 메일: {f['subject']} ({f['from']}, {f['time']}) · 슬라이드 {f['slide_count']}장")
            for s in f["slides"]:
                blocks.append(f"[슬라이드 {s['n']}] {s['title']}".rstrip())
                if s["text"]:
                    blocks.append(s["text"])
                if s["notes"]:
                    blocks.append("(발표자 노트) " + s["notes"])
            if f["truncated"] or f["slides_truncated"]:
                blocks.append("…(이후 내용은 글자 수 제한으로 생략)")
        if data["more_files_available"]:
            blocks.append("\n(더 많은 PowerPoint 첨부가 있습니다. 기간·제목·보낸 사람으로 좁혀 다시 요청하세요.)")
        if data["skipped"]:
            blocks.append("\n건너뛴 파일: " + "; ".join(f"{s['file']}: {s['reason']}" for s in data["skipped"]))
        return "\n".join(blocks)
    if name == "outlook.create_draft":
        return (
            f"초안을 {data['saved_to']}에 저장했습니다(보내지 않았습니다). "
            f"받는 사람: {', '.join(data['to'])} | 제목: {data['subject']}\n"
            "Outlook 의 임시 보관함에서 내용을 확인한 뒤 직접 보내세요."
        )
    if name == "outlook.list_messages":
        head = f"{data['start']} ~ {data['end']} {'받은' if data['folder'] == 'inbox' else '보낸'}편지함 메일 {data['count']}통"
        if data["truncated"]:
            head += " (최대 개수에 걸려 일부만)"
        lines = [head]
        for m in data["messages"]:
            mark = "●" if m["unread"] else " "
            lines.append(f"{mark} {m['time']} | {m['from']} | {m['subject']} | id={m['id']}")
        return "\n".join(lines)
    return f"{data['time']} | {data['from']} <{data['from_email']}> | {data['subject']}\n\n{data['body']}"


_HANDLERS = {
    "outlook.list_messages": _list_messages,
    "outlook.get_message": _get_message,
    "outlook.create_draft": _create_draft,
    "outlook.read_presentations": _read_presentations,
}


async def on_list_tools(ctx, params) -> types.ListToolsResult:  # noqa: ARG001
    return types.ListToolsResult(
        tools=[
            types.Tool(
                name="outlook.list_messages",
                # 라우터는 이 설명의 앞 160자만 본다(agent-runtime
                # `tool_route_description_max_chars`). "메일 가져와줘"처럼 기간이 없는
                # 요청에도 부를 수 있다는 것을 그 안에 먼저 말한다 — 말하지 않으면
                # 신중한 모델(exaone 등)은 "기간을 모르니 호출하지 않는다"로 기운다.
                # "가져와서 요약해줘"처럼 후처리가 붙은 요청도 먼저 이 도구다 —
                # 말하지 않으면 모델이 요약을 보고 본문 도구(get_message)로 가거나
                # 아무것도 고르지 않았다(exaone, 2026-09-29 실측).
                description=(
                    "Outlook 메일 목록. '메일 가져와줘', '메일 확인해줘', '메일 보여줘', '새 메일 있어?', "
                    "'메일 요약해줘' 같은 요청에 쓴다(요약도 먼저 이 도구). 인자 없으면 오늘, "
                    "어제 온 메일은 days=2, 최근 N일은 days=N, 보낸 메일은 folder=sent."
                ),
                input_schema=LIST_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
            ),
            types.Tool(
                name="outlook.get_message",
                description=(
                    "메일 id 를 이미 알 때만 쓰는 도구(질문에 메일 id 가 적혀 있을 때). id 를 모르면 고르지 않는다. "
                    "메일 목록·요약·첨부 파일 읽기에는 쓰지 않는다."
                ),
                input_schema=GET_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
            ),
            types.Tool(
                name="outlook.read_presentations",
                description=(
                    "메일 첨부 PowerPoint(.pptx) 내용을 슬라이드별로 읽는다. '첨부된 ppt/파워포인트 읽어줘·요약해줘'는 "
                    "이 도구 하나로 끝난다(메일 목록 도구 불필요). 기간 생략 시 최근 7일."
                ),
                input_schema=PRESENTATIONS_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
            ),
            types.Tool(
                name="outlook.create_draft",
                description=(
                    "Outlook 임시 보관함에 메일 초안을 저장한다(보내지 않음, 사용자가 확인 후 직접 발송). "
                    "'메일 써줘', '메일 작성해줘', '초안 만들어줘'에 쓴다. 받는 사람 주소는 사용자가 말한 것만."
                ),
                input_schema=DRAFT_SCHEMA,
                # 초안이 생기는 것은 부작용이다 — 읽기 전용이라고 선언하지 않는다. 삭제·덮어쓰기는
                # 하지 않으므로 파괴적이지는 않다.
                annotations=types.ToolAnnotations(read_only_hint=False, destructive_hint=False),
            ),
        ]
    )


async def on_call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:  # noqa: ARG001
    handler = _HANDLERS.get(params.name)
    if handler is None:
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"알 수 없는 Tool 입니다: {params.name}")],
            is_error=True,
        )
    try:
        # COM 호출은 블로킹이다 — 이벤트 루프를 막지 않도록 작업 스레드에서 돈다.
        data = await asyncio.to_thread(handler, dict(params.arguments or {}))
    except ToolError as exc:
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=str(exc))], is_error=True
        )
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=_summary(params.name, data))],
        structured_content=data,
    )


# --------------------------------------------------------------------------- 점검 모드


def _schema_of(tool: types.Tool) -> dict:
    return getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", {})


def _tools() -> list[types.Tool]:
    return asyncio.run(on_list_tools(None, None)).tools


def _load_manifest(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def cmd_list_tools(_args: argparse.Namespace) -> int:
    for tool in _tools():
        print(f"{tool.name}\n  {tool.description}")
        print("  입력: " + json.dumps(_schema_of(tool), ensure_ascii=False))
    return 0


def cmd_call(args: argparse.Namespace) -> int:
    manifest = _load_manifest(args.manifest)
    declared = {t["tool_name"]: t for t in manifest.get("declared_tools", [])}
    if args.call not in {t.name for t in _tools()}:
        print(f"없는 Tool 입니다: {args.call}", file=sys.stderr)
        return 1
    risk = declared.get(args.call, {}).get("risk_level")
    if risk != "READ_ONLY" and not args.yes:
        print(
            f"'{args.call}' 의 risk_level 이 {risk or '(매니페스트에 없음)'} 입니다. --yes 가 필요합니다.",
            file=sys.stderr,
        )
        return 1
    try:
        arguments = json.loads(args.args)
    except json.JSONDecodeError as exc:
        print(f"--args 가 올바른 JSON 이 아닙니다: {exc}", file=sys.stderr)
        return 1
    result = asyncio.run(
        on_call_tool(None, types.CallToolRequestParams(name=args.call, arguments=arguments))
    )
    for item in result.content:
        print(getattr(item, "text", item))
    return 1 if result.is_error else 0


def cmd_check(args: argparse.Namespace) -> int:
    """등록·연결에서 실제로 막히는 것들. 통과하면 0, 하나라도 걸리면 1. Outlook 은 필요 없다."""
    problems: list[str] = []
    if not args.manifest.exists():
        print(f"매니페스트가 없습니다: {args.manifest}", file=sys.stderr)
        return 1
    manifest = _load_manifest(args.manifest)

    transport = manifest.get("transport") or {}
    entrypoint = transport.get("entrypoint")
    if entrypoint and not args.manifest.with_name(pathlib.PurePosixPath(entrypoint).name).exists():
        problems.append(f"transport.entrypoint '{entrypoint}' 가 이 폴더에 없습니다.")
    stray = [a for a in transport.get("args", []) if str(a).startswith("--")]
    if stray:
        problems.append(f"transport.args 에 플래그가 있습니다: {stray} — 서버가 뜨지 않습니다.")

    live = {t.name: _schema_of(t) for t in _tools()}
    declared = {t["tool_name"]: t for t in manifest.get("declared_tools", [])}
    for name in sorted(set(live) - set(declared)):
        problems.append(f"'{name}' 은 서버가 내보내는데 declared_tools 에 없습니다.")
    for name in sorted(set(declared) - set(live)):
        problems.append(f"'{name}' 은 declared_tools 에 있는데 서버가 내보내지 않습니다.")
    for name in sorted(set(live) & set(declared)):
        if live[name] != declared[name].get("input_schema"):
            problems.append(f"'{name}' 의 input_schema 가 매니페스트와 다릅니다.")
    for name, tool in sorted(declared.items()):
        perms = tool.get("permissions") or {}
        for key in ("allowed_roles", "allowed_orgs"):
            if not perms.get(key):
                problems.append(
                    f"'{name}' 의 permissions.{key} 가 비어 있습니다 (아무도 호출할 수 없습니다)."
                )
        if tool.get("risk_level") == "WRITE" and tool.get("confirmation_policy") == "NEVER":
            problems.append(f"'{name}' 은 WRITE 인데 confirmation_policy 가 NEVER 입니다.")

    if problems:
        print(f"문제 {len(problems)}건", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(f"이상 없음 — Tool {len(live)}개, 매니페스트 {args.manifest.name}")
    return 0


def run_cli(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(
        prog="server.py",
        description="outlook-mail 점검 모드. 인자가 없으면 stdio MCP 서버로 뜹니다.",
    )
    parser.add_argument(
        "--manifest",
        type=pathlib.Path,
        default=DEFAULT_MANIFEST,
        help="검사할 매니페스트 (기본: 이 파일과 같은 폴더)",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check",
        action="store_true",
        help="매니페스트와 tools/list 가 맞는지 검사 (Outlook 불필요)",
    )
    mode.add_argument("--list-tools", action="store_true", dest="list_tools", help="Tool 목록 출력")
    mode.add_argument("--call", metavar="TOOL", help="Tool 하나를 실제로 호출 (Outlook 필요)")
    parser.add_argument(
        "--args", default="{}", metavar="JSON", help="--call 에 넘길 인자 (기본 {})"
    )
    parser.add_argument("--yes", action="store_true", help="READ_ONLY 가 아닌 Tool 호출을 승인")
    args = parser.parse_args(argv)
    if args.check:
        return cmd_check(args)
    if args.list_tools:
        return cmd_list_tools(args)
    return cmd_call(args)


async def serve() -> None:
    server = Server(
        "outlook-mail",
        version="1.2.0",
        instructions=(
            "이 PC 의 클래식 Outlook 에서 기간별 메일 목록과 본문, 첨부 PowerPoint 내용을 읽고, "
            "임시 보관함에 초안을 저장합니다(메일을 보내지는 않습니다)."
        ),
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    if sys.argv[1:]:
        raise SystemExit(run_cli(sys.argv[1:]))
    asyncio.run(serve())
