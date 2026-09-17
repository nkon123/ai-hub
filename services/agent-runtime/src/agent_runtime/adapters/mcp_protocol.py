"""D-094 — 새 MCP 프로토콜 파이프라인을 기존 `MCPAdapter` 계약 뒤에 둔다.

`workflow.run_knowledge_chat` 의 MCP_TOOL_CALL 단계는 이미 확인 흐름, 취소,
시간 초과, `mcp.call.*` 이벤트를 전부 다루고 있다. 그것을 다시 쓰면 게시된
챗봇 4개가 의존하는 검증된 경로를 건드리게 된다 — 대신 **호출 한 줄만** 갈아
끼운다. 그래서 이 클래스는 `HttpMCPAdapter` 와 같은 모양
(`call_tool(request) -> dict`, 실패는 `MCPCallError`)을 그대로 지킨다.

## 라우팅

`RoutingMCPAdapter` 가 Tool 마다 둘 중 하나를 고른다: 레지스트리에 등록된
서버가 제공하는 Tool 이면 새 프로토콜 경로, 아니면 기존 office-mcp-server
REST 경로. **기능 플래그가 아니라 실제 등록 상태로 고른다** — 플래그는 누군가
켜야 하고, 켜는 것을 잊으면 새 경로는 영원히 죽은 코드가 된다. 등록 상태로
고르면 office-mcp-server 를 MCP 서버로 등록하는 순간 자연스럽게 넘어간다.

## 판정은 여기서 하지 않는다

인가·확인·Rate Limit·마스킹·감사는 전부 `mcp_client.dispatch_tool_call` 안에
있다. 이 어댑터는 요청/응답 모양을 옮기기만 한다 — 두 곳에서 판단하면 한
곳만 고쳐진다.
"""

from __future__ import annotations

import logging
from typing import Any

from agent_runtime.adapters import MCPAdapter
from agent_runtime.adapters.mcp import MCPCallError
from agent_runtime.mcp_client import DispatchContext, RateLimiter, dispatch_tool_call

logger = logging.getLogger("agent_runtime")

#: 거부 사유 → **중앙 오류코드**(`office_mcp_server.errors.ErrorCode`, 07-data-api
#: -contracts.md §8). 새 코드를 만들지 않는다 — workflow 와 Desktop 이 이미 이
#: 목록을 다루고, 여기서만 아는 코드를 내보내면 화면이 그것을 모른다.
#:
#: 여기 없는 사유(인가·등급 거부)는 전부 `MCP_PERMISSION_DENIED` 하나로 모인다.
#: 그것이 §7 의 요구사항이다 — 거부 응답이 **어느 차원에서** 막혔는지 알려 주면
#: 정책 구조를 역추적할 수 있다. 정확한 사유는 감사 이벤트에만 남는다.
_DENIAL_TO_ERROR_CODE = {
    "tool_not_approved": "MCP_TOOL_NOT_FOUND",
    "server_not_active": "MCP_SERVER_UNAVAILABLE",
    "tool_suspended": "MCP_TOOL_DISABLED",
    "input_schema_violation": "MCP_INPUT_INVALID",
    "rate_limited": "RATE_LIMITED",
}


class ProtocolMCPAdapter(MCPAdapter):
    """등록된 MCP 서버를 프로토콜로 호출한다."""

    def __init__(self, registry, settings, rate_limiter: RateLimiter | None = None) -> None:
        self._registry = registry
        self._settings = settings
        # Rate Limit 창은 어댑터 수명 동안 유지돼야 의미가 있다 — 호출마다 새로
        # 만들면 상한이 사실상 없는 것과 같다.
        self._rate_limiter = rate_limiter or RateLimiter()

    async def call_tool(self, request: dict[str, Any]) -> dict[str, Any]:
        audit_context = request.get("audit_context") or {}
        user = audit_context.get("user") or {}
        context = DispatchContext(
            user_id=str(user.get("id") or "unknown"),
            roles=tuple(user.get("roles") or ()),
            organization_id=str(user.get("organization_id") or "unknown-org"),
            site_id=user.get("site_id"),
        )

        outcome = await dispatch_tool_call(
            server_alias=str(request.get("server_alias") or ""),
            tool_name=str(request.get("tool_name") or ""),
            arguments=request.get("input") or {},
            context=context,
            registry=self._registry,
            trace_id=str(audit_context.get("trace_id") or ""),
            run_id=str(audit_context.get("run_id") or ""),
            settings=self._settings,
            # workflow 가 이미 확인 흐름을 마쳤다. 여기서 다시 막으면 사용자가
            # 두 번 승인해야 한다 — 다만 `decide` 는 여전히 확인이 필요한지를
            # 판정하고 그 사실을 감사에 남긴다.
            confirmed=bool(request.get("confirmed", False)),
            ai_derived_arguments=bool(request.get("ai_derived", False)),
            rate_limiter=self._rate_limiter,
        )

        if not outcome.decision.allowed:
            code = _DENIAL_TO_ERROR_CODE.get(
                outcome.decision.denial_reason or "", "MCP_PERMISSION_DENIED"
            )
            raise MCPCallError(
                code, outcome.decision.message or "이 Tool 을 호출할 수 없습니다."
            )

        if outcome.awaiting_confirmation:
            # workflow 가 확인을 마치지 않고 호출한 경우다. 조용히 진행하지
            # 않는다 — 확인 정책을 낮추는 유일한 방법이 "실수로 건너뛰기"가
            # 되어서는 안 된다.
            # 중앙 목록에 "확인 필요" 코드가 없다. 새로 만들지 않고 권한 거부로
            # 돌려준다 — 확인을 건너뛴 호출은 허용되지 않았다는 점에서 같고,
            # 무엇이 부족했는지는 감사에 남는다.
            raise MCPCallError(
                "MCP_PERMISSION_DENIED", "이 Tool 은 사용자 확인이 필요합니다."
            )

        if outcome.result is None:
            code = (
                "MCP_EXECUTION_TIMEOUT"
                if outcome.failure_reason == "timeout"
                else "MCP_SERVER_UNAVAILABLE"
            )
            raise MCPCallError(code, "MCP Tool 호출에 실패했습니다.")

        if outcome.result.is_error:
            raise MCPCallError(
                "MCP_SERVER_UNAVAILABLE", "MCP Tool 이 오류를 반환했습니다."
            )

        return {
            "output": {
                "content": outcome.result.content,
                "structured_content": outcome.result.structured_content,
                "classification": outcome.result.classification,
            },
            "rows_returned": getattr(outcome.audit_event, "row_count", None),
            "truncated": outcome.result.truncated,
        }


class RoutingMCPAdapter(MCPAdapter):
    """Tool 마다 프로토콜 경로와 기존 REST 경로 중 하나를 고른다.

    병행 기간을 위한 것이다. 게시된 챗봇 4개는 Office Profile 이 이름을 아는
    office-mcp-server Tool 을 쓰고, 그 Tool 들은 아직 레지스트리에 없으므로
    기존 경로로 간다 — 이 변경으로 그 챗봇들의 동작은 달라지지 않는다.
    """

    def __init__(self, registry, settings, legacy: MCPAdapter | None) -> None:
        self._registry = registry
        self._protocol = ProtocolMCPAdapter(registry, settings)
        self._legacy = legacy

    def uses_protocol(self, server_alias: str, tool_name: str) -> bool:
        return self._registry.get_policy(server_alias, tool_name) is not None

    async def call_tool(self, request: dict[str, Any]) -> dict[str, Any]:
        alias = str(request.get("server_alias") or "")
        tool_name = str(request.get("tool_name") or "")
        if self.uses_protocol(alias, tool_name):
            logger.debug("mcp.route.protocol alias=%s tool=%s", alias, tool_name)
            return await self._protocol.call_tool(request)
        if self._legacy is None:
            raise MCPCallError("MCP_SERVER_UNAVAILABLE", "MCP Adapter가 구성되지 않았습니다.")
        logger.debug("mcp.route.legacy alias=%s tool=%s", alias, tool_name)
        return await self._legacy.call_tool(request)
