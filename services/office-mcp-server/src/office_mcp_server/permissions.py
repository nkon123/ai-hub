"""Authorization — 05-mcp-security-governance.md §7.

Decision inputs per §7: User Roles, Org, Site, Tool Risk, requested data
scope. This PoC's decision is a simple allowlist intersection (D-022:
Role+Organization+Site), but two rules from §7/§12.1 are load-bearing:

- **Default Deny**: an empty `allowed_roles` or `allowed_orgs` on a tool
  denies everyone, it does not mean "unrestricted". `allowed_sites` is the
  one optional dimension — an empty list means "not site-restricted" (not
  every tool needs a site boundary), matching how the Office Profile fixture
  models MCP server allowlisting at the org level.
- **Denial must not leak the policy**: the user-facing message states that
  permission was denied and who to contact, never the tool's actual
  `allowed_roles`/`allowed_orgs` list (§7 "내부 Policy 조건 전체를 노출하지
  않는다").
"""

from __future__ import annotations

from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.request_context import RequestContext
from office_mcp_server.tool_registry import RegisteredTool


def check_permission(tool: RegisteredTool, context: RequestContext) -> None:
    role_ok = bool(tool.allowed_roles) and any(
        role in tool.allowed_roles for role in context.user.roles
    )
    org_ok = bool(tool.allowed_orgs) and context.user.organization_id in tool.allowed_orgs
    site_ok = (not tool.allowed_sites) or context.user.site_id in tool.allowed_sites

    if role_ok and org_ok and site_ok:
        return

    raise McpError(
        ErrorCode.MCP_PERMISSION_DENIED,
        f"이 Tool을 호출할 권한이 없습니다. 담당자에게 문의하세요 (문의처: {tool.owner}).",
    )
