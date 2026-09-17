"""등록 시험용 stdio MCP 서버 — 읽기 전용 Tool 두 개.

D-094 의 stdio 경로를 실제로 끝까지 돌려 보기 위한 **최소 예제**다. 운영에서
쓰라고 만든 것이 아니다.

## 일부러 아무것도 건드리지 않는다

파일을 읽지도, 네트워크를 쓰지도, 환경변수를 보지도 않는다. 등록 경로가 제대로
동작하는지 확인하는 것이 목적이고, 그 확인을 위해 실제로 뭔가를 할 수 있는
서버를 샘플로 두면 "시험 삼아 넣어 본 것"이 그대로 남는다.

agent-runtime 이 이 프로세스를 띄울 때 환경변수를 물려주지 않으므로
(`env={}`, `mcp_client.client._build_sdk_target`), 이 파일은 표준 라이브러리와
`mcp` 만 쓴다.

## 실행

직접 띄울 일은 없다 — agent-runtime 이 등록 시점에 띄운다. 손으로 확인하려면:

    uv run python samples/mcp-servers/hello-mcp/server.py

그러면 stdin 을 열고 기다린다(JSON-RPC 를 기다리는 정상 동작이다).
"""

from __future__ import annotations

import asyncio
import datetime

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


async def main() -> None:
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
    asyncio.run(main())
