"""RBAC enforcement glue between portal-api (M02) and the framework-free
`security_policy` package (M11). This module is the only place portal-api
should translate a `PermissionDeniedError`-style decision into an HTTP
response — the decision itself (`has_permission`) always comes from
`security_policy`, never re-implemented here (CLAUDE.md 구현 원칙 2, 3).
"""

from __future__ import annotations

from fastapi.responses import JSONResponse
from security_policy import Permission, Role, has_permission
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext
from portal_api.errors import error_response


async def require_permission(
    db: AsyncSession,
    user: UserContext,
    permission: Permission,
    *,
    trace_id: str,
    resource_type: str,
    resource_id: str = "-",
) -> JSONResponse | None:
    """Return a 403 envelope (and record a DENIED audit row) if `user` lacks
    `permission`; otherwise return `None` so callers can::

        denial = await require_permission(...)
        if denial:
            return denial
    """
    try:
        role = Role(user.role)
    except ValueError:
        role = None

    if role is not None and has_permission(role, permission):
        return None

    await record_audit(
        db,
        event_type=f"PERMISSION_DENIED:{permission.value}",
        actor=user,
        resource_type=resource_type,
        resource_id=resource_id,
        result="DENIED",
        trace_id=trace_id,
        metadata={"required_permission": permission.value, "role": user.role},
    )
    return error_response(
        403,
        "PERMISSION_DENIED",
        "이 작업을 수행할 권한이 없습니다.",
        trace_id,
    )
