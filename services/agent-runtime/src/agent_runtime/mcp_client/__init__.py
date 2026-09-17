"""D-094 MCP 프로토콜 클라이언트 (M05).

공개 API는 이 파일에 적힌 것이 전부다 — 다른 모듈은 하위 모듈을 직접
import하지 않는다(루트 구현 원칙 2, 3).
"""

from agent_runtime.mcp_client.client import (
    DiscoveredTool,
    HandshakeResult,
    RawToolResult,
    call_tool,
    approved_tool_intersection,
    compute_tools_snapshot_hash,
    discover,
    handshake,
    open_session,
)
from agent_runtime.mcp_client.connection import (
    ConnectionTarget,
    HttpTarget,
    StdioTarget,
    resolve_connection_target,
)
from agent_runtime.mcp_client.audit import (
    MCPAuditEvent,
    MCPAuditResult,
    event_from_decision,
    now_iso,
)
from agent_runtime.mcp_client.dispatch import DispatchOutcome, dispatch_tool_call
from agent_runtime.mcp_client.errors import MCPRegistrationError, MCPRegistrationReason
from agent_runtime.mcp_client.policy import (
    DispatchContext,
    DispatchDecision,
    RateLimiter,
    ToolPolicy,
    decide,
    is_llm_routable,
    requires_confirmation,
    routable_candidates,
)
from agent_runtime.mcp_client.result_filter import (
    FilteredResult,
    ResultLimits,
    content_blocks_to_dicts,
    filter_tool_result,
    mask_pii,
    mask_pii_deep,
)

__all__ = [
    "ConnectionTarget",
    "DispatchContext",
    "DispatchDecision",
    "FilteredResult",
    "MCPAuditEvent",
    "MCPAuditResult",
    "RateLimiter",
    "ResultLimits",
    "ToolPolicy",
    "DiscoveredTool",
    "DispatchOutcome",
    "RawToolResult",
    "HandshakeResult",
    "HttpTarget",
    "MCPRegistrationError",
    "MCPRegistrationReason",
    "StdioTarget",
    "approved_tool_intersection",
    "call_tool",
    "dispatch_tool_call",
    "compute_tools_snapshot_hash",
    "content_blocks_to_dicts",
    "decide",
    "discover",
    "event_from_decision",
    "filter_tool_result",
    "handshake",
    "is_llm_routable",
    "mask_pii",
    "mask_pii_deep",
    "now_iso",
    "open_session",
    "requires_confirmation",
    "resolve_connection_target",
    "routable_candidates",
]
