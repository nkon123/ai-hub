"""등록 시험용 stdio MCP 서버 — 읽기 전용 Tool 두 개 + 터미널 점검 모드.

D-094 의 stdio 경로를 실제로 끝까지 돌려 보기 위한 **최소 예제**다. 운영에서
쓰라고 만든 것이 아니다.

## 일부러 아무것도 건드리지 않는다

파일은 자기 매니페스트만 읽고, 네트워크를 쓰지도 환경변수를 보지도 않는다.
등록 경로가 제대로 동작하는지 확인하는 것이 목적이고, 그 확인을 위해 실제로
뭔가를 할 수 있는 서버를 샘플로 두면 "시험 삼아 넣어 본 것"이 그대로 남는다.

agent-runtime 이 이 프로세스를 띄울 때 환경변수를 물려주지 않으므로
(`env={}`, `mcp_client.client._build_sdk_target`), 이 파일은 표준 라이브러리와
`mcp` 만 쓴다.

## 실행

**인자가 없으면 stdio 서버로 뜬다.** agent-runtime 이 등록 시점에 그렇게 띄운다.
손으로 확인하려면:

    uv run python samples/mcp-servers/hello-mcp/server.py

그러면 stdin 을 열고 기다린다(JSON-RPC 를 기다리는 정상 동작이다).

## 터미널 점검

**인자가 있으면 서버를 띄우지 않고** 점검만 하고 끝난다. 이 구분이 중요하다 —
stdout 은 JSON-RPC 채널이라, 점검 출력이 거기 섞이면 프로토콜이 깨진다.

    server.py --check                         # 매니페스트 ↔ tools/list 일치
    server.py --list-tools                    # 무엇을 내보내는지
    server.py --call hello.now --args '{}'    # 실제로 한 번 호출
    server.py --help

`--check` 는 문제가 없으면 0, 있으면 1 로 끝난다. 등록 전에 이것부터 돌린다.

`mcp-server-manifest.json` 의 `transport.args` 에는 이 플래그들을 **넣지 않는다**.
거기 들어간 인자는 런타임이 서버를 띄울 때 그대로 넘기므로, 서버가 뜨지 않고
점검만 하고 끝나 버린다.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import pathlib
import sys

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

ECHO_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["message"],
    "properties": {"message": {"type": "string", "description": "되돌려 줄 문장"}},
}

TIME_SCHEMA = {"type": "object", "additionalProperties": False, "properties": {}}

DEFAULT_MANIFEST = pathlib.Path(__file__).with_name("mcp-server-manifest.json")


async def on_list_tools(ctx, params) -> types.ListToolsResult:  # noqa: ARG001
    return types.ListToolsResult(
        tools=[
            types.Tool(
                name="hello.echo",
                description="보낸 문장을 그대로 돌려줍니다. 연결 확인용입니다.",
                input_schema=ECHO_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
            ),
            types.Tool(
                name="hello.now",
                description="이 서버가 실행 중인 PC 의 현재 시각을 돌려줍니다.",
                input_schema=TIME_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
            ),
        ]
    )


async def on_call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:  # noqa: ARG001
    arguments = dict(params.arguments or {})

    if params.name == "hello.echo":
        message = str(arguments.get("message", ""))
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=message)],
            structured_content={"message": message},
        )

    if params.name == "hello.now":
        now = datetime.datetime.now().isoformat(timespec="seconds")
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=now)],
            structured_content={"now": now},
        )

    # 모르는 Tool 은 프로토콜 오류가 아니라 실패한 결과로 돌려준다 — MCP 에서
    # 프로토콜 오류는 전송/요청 형식 문제를 뜻한다.
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=f"알 수 없는 Tool 입니다: {params.name}")],
        is_error=True,
    )


# --------------------------------------------------------------------------- 점검 모드
#
# 점검은 JSON-RPC 세션을 열지 않고 위 핸들러를 직접 부른다. 자기 자신을 자식
# 프로세스로 띄우면 확인하려던 것(이 파일의 Tool 정의)과 다른 것을 확인하게 되고,
# 실패했을 때 서버 문제인지 배관 문제인지 구분할 수 없다.


def _schema_of(tool: types.Tool) -> dict:
    """SDK 판본에 따라 `input_schema` 와 `inputSchema` 중 하나를 쓴다."""
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

    # 부작용은 터미널에서도 확인을 거친다. 매니페스트에 없는 Tool 도 여기서 막는다 —
    # 선언되지 않은 것은 등록 후에도 호출되지 않으므로 여기서 통과시키면 오해를 준다.
    risk = declared.get(args.call, {}).get("risk_level")
    if risk != "READ_ONLY" and not args.yes:
        print(
            f"'{args.call}' 의 risk_level 이 {risk or '(매니페스트에 없음)'} 입니다. "
            "부작용이 있을 수 있어 --yes 가 필요합니다.",
            file=sys.stderr,
        )
        return 1

    try:
        arguments = json.loads(args.args)
    except json.JSONDecodeError as exc:
        print(f"--args 가 올바른 JSON 이 아닙니다: {exc}", file=sys.stderr)
        return 1

    params = types.CallToolRequestParams(name=args.call, arguments=arguments)
    result = asyncio.run(on_call_tool(None, params))
    for item in result.content:
        print(getattr(item, "text", item))
    if result.structured_content is not None:
        print(json.dumps(result.structured_content, ensure_ascii=False))
    return 1 if result.is_error else 0


def cmd_check(args: argparse.Namespace) -> int:
    """등록·연결에서 실제로 막히는 것들만 본다. 통과하면 0, 하나라도 걸리면 1."""
    problems: list[str] = []

    if not args.manifest.exists():
        print(f"매니페스트가 없습니다: {args.manifest}", file=sys.stderr)
        return 1
    manifest = _load_manifest(args.manifest)

    # 1. 진입점 — 선언한 파일이 실제로 있어야 업로드가 통과한다.
    entrypoint = (manifest.get("transport") or {}).get("entrypoint")
    if entrypoint and not args.manifest.with_name(pathlib.PurePosixPath(entrypoint).name).exists():
        problems.append(f"transport.entrypoint '{entrypoint}' 가 이 폴더에 없습니다.")

    # 2. transport.args 에 점검 플래그가 들어가면 서버가 뜨지 않는다.
    stray = [a for a in (manifest.get("transport") or {}).get("args", []) if str(a).startswith("--")]
    if stray:
        problems.append(f"transport.args 에 플래그가 있습니다: {stray} — 서버가 뜨지 않습니다.")

    # 3. tools/list 와 declared_tools 의 이름 집합 (다르면 tools_snapshot_mismatch).
    live = {t.name: _schema_of(t) for t in _tools()}
    declared = {t["tool_name"]: t for t in manifest.get("declared_tools", [])}
    for name in sorted(set(live) - set(declared)):
        problems.append(f"'{name}' 은 서버가 내보내는데 declared_tools 에 없습니다.")
    for name in sorted(set(declared) - set(live)):
        problems.append(f"'{name}' 은 declared_tools 에 있는데 서버가 내보내지 않습니다.")

    # 4. 같은 이름인데 입력 스키마가 갈라진 경우.
    for name in sorted(set(live) & set(declared)):
        if live[name] != declared[name].get("input_schema"):
            problems.append(f"'{name}' 의 input_schema 가 매니페스트와 다릅니다.")

    # 5. 권한은 Default Deny — 비어 있으면 아무도 못 쓴다.
    for name, tool in sorted(declared.items()):
        perms = tool.get("permissions") or {}
        for key in ("allowed_roles", "allowed_orgs"):
            if not perms.get(key):
                problems.append(f"'{name}' 의 permissions.{key} 가 비어 있습니다 (아무도 호출할 수 없습니다).")
        if tool.get("risk_level") == "WRITE" and tool.get("confirmation_policy") == "NEVER":
            problems.append(f"'{name}' 은 WRITE 인데 confirmation_policy 가 NEVER 입니다 (스키마가 거부합니다).")

    if problems:
        print(f"문제 {len(problems)}건", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print(f"이상 없음 — Tool {len(live)}개, 매니페스트 {args.manifest.name}")
    return 0


def run_cli(argv: list[str]) -> int:
    # Windows 콘솔/파이프의 기본 인코딩(cp949)에 한국어를 쓰면 UnicodeEncodeError 로
    # 죽는다 — 점검 결과를 보려다 점검이 죽는 셈이다. 배포 대상이 사내 Windows PC 라
    # 예외가 아니라 기본 경로다. 서버 모드는 건드리지 않는다(거기 stdout 은 SDK 것).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(
        prog="server.py",
        description="hello-mcp 점검 모드. 인자가 없으면 stdio MCP 서버로 뜹니다.",
    )
    parser.add_argument("--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST,
                        help="검사할 매니페스트 (기본: 이 파일과 같은 폴더)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="매니페스트와 tools/list 가 맞는지 검사")
    mode.add_argument("--list-tools", action="store_true", dest="list_tools", help="Tool 목록 출력")
    mode.add_argument("--call", metavar="TOOL", help="Tool 하나를 실제로 호출")
    parser.add_argument("--args", default="{}", metavar="JSON", help="--call 에 넘길 인자 (기본 {})")
    parser.add_argument("--yes", action="store_true", help="READ_ONLY 가 아닌 Tool 호출을 승인")
    args = parser.parse_args(argv)

    if args.check:
        return cmd_check(args)
    if args.list_tools:
        return cmd_list_tools(args)
    return cmd_call(args)


async def serve() -> None:
    server = Server(
        "hello-mcp",
        version="1.0.0",
        instructions="등록 시험용 예제 서버. 읽기 전용 Tool 두 개만 제공합니다.",
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    # 인자가 있으면 점검, 없으면 서버. 이 한 줄이 stdout 오염을 막는다.
    if sys.argv[1:]:
        raise SystemExit(run_cli(sys.argv[1:]))
    asyncio.run(serve())
