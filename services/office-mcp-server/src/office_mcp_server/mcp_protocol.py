"""D-094 — 이 서버를 **진짜 MCP 프로토콜**로 노출한다.

지금까지 `/mcp/v1/tools*` 는 이름만 MCP 인 자체 REST 였다(JSON-RPC 도
`initialize` 협상도 없었다). 여기서는 공식 `mcp` SDK 로 같은 Tool 을 프로토콜로
내놓는다.

## 기존 REST 를 지우지 않는다

게시된 챗봇 4개가 그 경로로 돌고 있다. 두 표면이 **같은 `ToolCallPipeline`** 을
통과하므로 통제가 갈라지지 않는다 — 프로토콜 표면은 파이프라인을 새로 만들지
않고 이미 있는 것을 부른다. 마이그레이션이 끝나면 REST 쪽만 걷어내면 된다.

## 신원은 `_meta` 로 온다 (D-095)

MCP `tools/call` 에는 신원을 담을 표준 자리가 없다. 클라이언트
(`agent_runtime.mcp_client.dispatch`)가 `_meta["aihub/audit_context"]` 로 보낸다.

**Tool 인자에서는 신원을 절대 읽지 않는다.** 이것이 이 서버의 핵심 장치다 —
`request_context.py` 가 신원을 `audit_context` 에서만 파싱하는 이유이고,
Prompt Injection 으로 role 을 위조하지 못하게 한다. 프로토콜로 옮기면서 그
장치를 잃지 않으려고 `_meta` 를 쓴다.

신원이 없으면 **거부한다**. 익명 호출을 허용하면 §7 인가가 통째로 사라진다 —
클라이언트 PEP 가 이미 판정했다는 것은 우리 서버가 자기 판정을 생략해도 된다는
뜻이 아니다(그 클라이언트가 우리 것이라는 보장이 없다).
"""

from __future__ import annotations

import logging
from typing import Any

import mcp_types as types
from mcp.server import ServerRequestContext
from mcp.server.lowlevel import Server

from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.pipeline import ToolCallPipeline
from office_mcp_server.tool_registry import ToolRegistry, ToolStatus

_logger = logging.getLogger("office_mcp_server")

#: 클라이언트가 신원을 싣는 `_meta` 키. `aihub/` 접두어는 MCP 가 구현별
#: 메타데이터에 권장하는 형태다(`modelcontextprotocol.io/` 는 예약).
AUDIT_CONTEXT_META_KEY = "aihub/audit_context"


def _audit_context_from_meta(ctx: ServerRequestContext, tool_name: str) -> dict:
    """`_meta` 에서 신원을 꺼낸다. 없으면 거부한다.

    **Tool 인자는 쳐다보지도 않는다.** 인자는 모델이나 사용자가 채우는 값이라
    거기서 role 을 읽으면 "권한을 요청자가 적어 내는" 구조가 된다 —
    `request_context.py` 가 신원을 `audit_context` 에서만 파싱하는 이유이고,
    프로토콜로 옮기면서 잃으면 안 되는 장치다.
    """
    meta = getattr(ctx, "meta", None)
    raw = None
    if isinstance(meta, dict):
        raw = meta.get(AUDIT_CONTEXT_META_KEY)
    elif meta is not None:
        raw = getattr(meta, AUDIT_CONTEXT_META_KEY, None)
        if raw is None and hasattr(meta, "model_extra"):
            raw = (meta.model_extra or {}).get(AUDIT_CONTEXT_META_KEY)

    if not isinstance(raw, dict):
        _logger.warning("mcp.protocol.missing_audit_context tool=%s", tool_name)
        raise McpError(
            ErrorCode.AUTHENTICATION_REQUIRED,
            "호출자 신원이 없어 Tool 을 실행할 수 없습니다.",
        )
    return raw


def _wire_output_schema(declared: dict | None) -> dict | None:
    """선언된 `output_schema` 를 **실제로 전송되는 모양**으로 바꾼다.

    `output_filter.apply_output_filter` 는 업무 출력에 `classification` 라벨을
    덧붙인 뒤 내보낸다. 그런데 Tool 의 `output_schema` 는 **라벨을 붙이기 전의
    업무 모양**을 기술한다(그 검증이 Tool Handler 버그를 잡는 장치이므로 그쪽이
    맞다, `output_filter.py` 주석 참고).

    두 모양이 다르다는 사실은 REST 표면에서는 드러나지 않았다 — 아무도 응답을
    스키마로 검증하지 않았기 때문이다. MCP 클라이언트는 `structured_content` 를
    `output_schema` 로 검증하므로, 선언을 그대로 내보내면 **정상 응답이 매번
    "Additional properties are not allowed ('classification')" 로 거부된다.**

    그래서 전송 모양을 정직하게 기술한다. 검증을 끄는 선택지(스키마를 아예 안
    보내는 것)도 있지만, 그러면 클라이언트가 응답 모양을 확인할 수단을 잃는다.
    """
    if not declared:
        return None
    wire = dict(declared)
    properties = dict(wire.get("properties") or {})
    properties["classification"] = {
        "type": "string",
        "description": "이 결과의 정보 등급 라벨(서버가 부여).",
    }
    wire["properties"] = properties
    return wire


def _server_alias_for(registry: ToolRegistry, tool_name: str) -> str | None:
    for entry in registry.admin_list():
        if entry["name"] == tool_name:
            return entry.get("server_alias")
    return None


def build_mcp_server(
    registry: ToolRegistry, pipeline: ToolCallPipeline, *, version: str
) -> Server:
    """Tool Registry 를 MCP 프로토콜로 내놓는다.

    lowlevel `Server` 를 쓰는 이유는 **승인된 `input_schema` 를 그대로**
    내보내기 위해서다. 상위 `MCPServer.add_tool` 은 파이썬 함수 시그니처에서
    스키마를 유도하는데, 그러면 검토자가 승인한 스키마가 아니라 우리가 쓴
    래퍼 함수의 모양이 클라이언트에게 계약으로 나간다.

    목록은 Registry 에서 읽는다 — 손으로 다시 적으면 REST 표면과 프로토콜
    표면이 서로 다른 Tool 을 내놓게 되고 그 차이는 아무도 모르게 벌어진다.
    """

    async def on_list_tools(
        ctx: ServerRequestContext, params: Any
    ) -> types.ListToolsResult:  # noqa: ARG001
        tools = [
            types.Tool(
                name=entry["name"],
                description=entry.get("description") or entry["name"],
                input_schema=entry.get("input_schema") or {"type": "object"},
                output_schema=_wire_output_schema(entry.get("output_schema")),
                annotations=types.ToolAnnotations(
                    # 읽기 전용이라는 사실을 프로토콜 수준에서도 밝힌다.
                    # 힌트일 뿐 통제가 아니다 — 실제 강제는
                    # `ToolRegistry.register` 의 READ_ONLY 검사다.
                    read_only_hint=entry.get("risk_level") == "READ_ONLY",
                ),
            )
            # Kill Switch 로 내린 Tool 은 목록에도 내놓지 않는다 — 목록에
            # 두고 호출만 막으면 클라이언트는 그것을 쓸 수 있는 것으로 보고
            # 승인 스냅샷에 담는다.
            for entry in registry.admin_list()
            if entry.get("status") == ToolStatus.ACTIVE.value
        ]
        return types.ListToolsResult(tools=tools)

    async def on_call_tool(
        ctx: ServerRequestContext, params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        tool_name = params.name
        try:
            audit_context = _audit_context_from_meta(ctx, tool_name)
            # 기존 파이프라인을 그대로 통과한다 — 인가, 입력 검증, 확인 정책,
            # 실행 가드, 출력 필터, 감사가 전부 거기 있다. 프로토콜 표면이
            # 그중 하나라도 건너뛰면 두 표면의 통제가 갈라진다.
            result = await pipeline.call(
                tool_name,
                {
                    "input": dict(params.arguments or {}),
                    "audit_context": audit_context,
                    # 파이프라인은 `server_alias` 로 "이 요청이 이 서버로 온 것이
                    # 맞는가"를 확인한다(REST 에서는 호출자가 보낸다). 프로토콜
                    # 에서는 연결 자체가 이 서버이므로 호출자에게 받지 않고
                    # Registry 가 아는 값을 넣는다 — 호출자가 보내게 하면
                    # 그 검사는 스스로 답을 적어 내는 것이 되어 의미가 없다.
                    "server_alias": _server_alias_for(registry, tool_name),
                },
            )
        except McpError as error:
            # 오류 본문을 프로토콜 오류로 던지지 않고 `is_error` 결과로 돌려준다 —
            # MCP 에서 Tool 실행 실패는 정상 응답이고, 프로토콜 오류는 전송/
            # 요청 형식 문제를 뜻한다. 섞으면 클라이언트가 재시도 판단을 못 한다.
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=error.message)],
                is_error=True,
            )

        output = result.get("output", result)
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=str(output))],
            structured_content=output if isinstance(output, dict) else {"result": output},
            is_error=False,
        )

    return Server(
        "office-mcp-server",
        version=version,
        instructions=(
            "사내 업무 시스템 조회 Tool. 모든 호출은 서버 측 인가·실행 통제·"
            "출력 필터·감사를 거칩니다."
        ),
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
