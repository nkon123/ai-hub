"""연구회원용 MCP 서버 템플릿 — 사내 용어집 조회 (읽기 전용).

Desktop 의 "MCP 서버 > 서버 추가 > 로컬 Python 파일" 로 바로 붙일 수 있는 최소
예제다. 이 파일을 복사해 `TERMS` 와 Tool 정의만 바꾸면 자기 서버가 된다.
가이드: docs/user-guide/mcp-서버-만들기-가이드.md

지켜야 할 것
- 표준 라이브러리 + `mcp` 만 쓴다. 서버는 환경변수 없이(`env={}`) 뜬다.
- stdout 은 JSON-RPC 채널이다. `print()` 로 아무것도 찍지 않는다(로그는 stderr).
- 인자가 없을 때만 서버로 뜬다. 인자가 있으면 점검만 하고 끝난다.

터미널 점검 (서버를 띄우지 않고 Tool 정의와 동작만 확인)
    python server.py --list-tools
    python server.py --call glossary.lookup --args '{"term": "PoC"}'
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

# 실제 서버에서는 여기가 파일·DB·사내 API 조회로 바뀐다. 접속 정보를 코드에 적지 않는다.
TERMS = {
    "poc": "Proof of Concept. 본 개발 전에 가능성을 확인하는 시험 구현.",
    "mcp": "Model Context Protocol. AI 앱이 외부 도구·데이터에 붙는 표준 규약.",
    "knowledge": "이 플랫폼에서 문서를 색인해 검색할 수 있게 만든 지식 자산.",
}

LOOKUP_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["term"],
    "properties": {"term": {"type": "string", "minLength": 1, "description": "찾을 용어"}},
}

LIST_SCHEMA = {"type": "object", "additionalProperties": False, "properties": {}}


async def on_list_tools(ctx, params) -> types.ListToolsResult:  # noqa: ARG001
    # description 이 곧 "언제 이 Tool 을 부를지"의 근거다. 무엇을 하는지와 어떤
    # 질문에 쓰는지를 한 줄로 쓴다(가이드 4장).
    return types.ListToolsResult(
        tools=[
            types.Tool(
                name="glossary.lookup",
                description="사내 용어의 뜻을 찾습니다. '~가 뭐야', '~ 뜻' 같은 질문에 씁니다.",
                input_schema=LOOKUP_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
            ),
            types.Tool(
                name="glossary.list_terms",
                description="용어집에 등록된 용어 목록을 돌려줍니다.",
                input_schema=LIST_SCHEMA,
                annotations=types.ToolAnnotations(read_only_hint=True),
            ),
        ]
    )


async def on_call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:  # noqa: ARG001
    arguments = dict(params.arguments or {})

    if params.name == "glossary.lookup":
        term = str(arguments.get("term", "")).strip()
        meaning = TERMS.get(term.lower())
        if meaning is None:
            # 못 찾은 것은 오류가 아니라 정상 결과다. 모델이 그대로 읽고 답할 수 있게 말로 쓴다.
            return _text(f"'{term}' 은(는) 용어집에 없습니다.", {"term": term, "found": False})
        return _text(f"{term}: {meaning}", {"term": term, "found": True, "meaning": meaning})

    if params.name == "glossary.list_terms":
        names = sorted(TERMS)
        return _text(", ".join(names), {"terms": names})

    return types.CallToolResult(
        content=[types.TextContent(type="text", text=f"알 수 없는 Tool 입니다: {params.name}")],
        is_error=True,
    )


def _text(text: str, structured: dict) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=text)], structured_content=structured
    )


# ------------------------------------------------------------------ 터미널 점검


def _utf8_console() -> None:
    # Windows 콘솔 기본 인코딩(cp949)에서 한글 출력이 죽는 것을 막는다. 서버 모드에서는 부르지 않는다.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def run_cli(argv: list[str]) -> int:
    _utf8_console()
    parser = argparse.ArgumentParser(description="glossary-mcp 점검 모드. 인자가 없으면 서버로 뜹니다.")
    parser.add_argument("--list-tools", action="store_true", help="Tool 이름과 설명을 출력")
    parser.add_argument("--call", metavar="TOOL", help="Tool 하나를 실제로 한 번 호출")
    parser.add_argument("--args", default="{}", help="--call 의 인자(JSON)")
    args = parser.parse_args(argv)

    if args.call:
        try:
            arguments = json.loads(args.args)
        except json.JSONDecodeError as exc:
            print(f"--args 가 올바른 JSON 이 아닙니다: {exc}", file=sys.stderr)
            return 1
        result = asyncio.run(
            on_call_tool(None, types.CallToolRequestParams(name=args.call, arguments=arguments))
        )
        print(result.content[0].text)
        return 1 if result.is_error else 0

    listed = asyncio.run(on_list_tools(None, None))
    for tool in listed.tools:
        print(f"{tool.name}\n  {tool.description}")
    return 0


async def serve() -> None:
    server = Server(
        "glossary-mcp",
        version="1.0.0",
        instructions="사내 용어집을 조회하는 읽기 전용 서버입니다.",
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    if sys.argv[1:]:
        raise SystemExit(run_cli(sys.argv[1:]))
    asyncio.run(serve())
