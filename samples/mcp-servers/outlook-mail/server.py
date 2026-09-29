"""Outlook 메일 조회 stdio MCP 서버 — 기간을 지정해 받은/보낸 메일을 읽는다(읽기 전용).

이 PC 에 설치된 **클래식 Outlook(데스크톱)** 을 COM 으로 읽는다. 서버·토큰·
비밀번호가 필요 없고 네트워크를 쓰지 않는다 — Outlook 이 이미 동기화해 둔 메일을
그대로 읽을 뿐이다.

## Tool

- `outlook.list_messages` — 기간(`start_date`~`end_date`, 또는 최근 `days`일)의
  메일 목록. 폴더(받은편지함/보낸편지함), 안 읽은 메일만, 최대 개수를 고를 수 있다.
- `outlook.get_message` — 목록에서 받은 `id` 로 메일 한 통의 본문을 읽는다.

둘 다 읽기 전용이다. 메일을 보내거나, 지우거나, 읽음 표시를 바꾸지 않는다
(COM 으로 본문을 읽는 것은 읽음 상태를 바꾸지 않는다).

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
    server.py --help
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import pathlib
import sys
from typing import Any

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


class ToolError(Exception):
    """사용자에게 그대로 보여 줄 수 있는 실패 — 무엇을 고치면 되는지 담는다."""


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


def _summary(name: str, data: dict) -> str:
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


_HANDLERS = {"outlook.list_messages": _list_messages, "outlook.get_message": _get_message}


async def on_list_tools(ctx, params) -> types.ListToolsResult:  # noqa: ARG001
    return types.ListToolsResult(
        tools=[
            types.Tool(
                name="outlook.list_messages",
                # 라우터는 이 설명의 앞 160자만 본다(agent-runtime
                # `tool_route_description_max_chars`). "메일 가져와줘"처럼 기간이 없는
                # 요청에도 부를 수 있다는 것을 그 안에 먼저 말한다 — 말하지 않으면
                # 신중한 모델(exaone 등)은 "기간을 모르니 호출하지 않는다"로 기운다.
                description=(
                    "Outlook 메일 가져오기/보여주기/확인(새 메일, 받은 메일, 보낸 메일). "
                    "기간이 없으면 인자 없이 호출(오늘 받은 메일), 최근 N일은 days=N, "
                    "보낸 메일은 folder=sent. 결과의 id 로 본문을 읽는다."
                ),
                input_schema=LIST_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
            ),
            types.Tool(
                name="outlook.get_message",
                description="outlook.list_messages 가 준 id 로 메일 한 통의 본문·받는 사람·첨부 파일 이름을 읽습니다.",
                input_schema=GET_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
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
        version="1.0.0",
        instructions="이 PC 의 클래식 Outlook 에서 기간별 메일 목록과 본문을 읽습니다(읽기 전용).",
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    if sys.argv[1:]:
        raise SystemExit(run_cli(sys.argv[1:]))
    asyncio.run(serve())
