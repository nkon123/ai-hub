"""Audit trail writer — M02, backing the mandatory audit list in
`docs/implementation-spec/README.md` §10.5 (로그인·실패·권한 거부, 자산
생성·수정·검토 요청·승인·반려·중단·폐기, 파일 업로드·다운로드, ...).

`metadata` must always be a sanitized *summary* — never raw prompt text,
full document bodies, DB result rows, or secrets (CLAUDE.md 로그 규칙).
Callers are responsible for keeping it small and non-sensitive; this helper
does not attempt to redact arbitrary input.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.auth import UserContext
from portal_api.models.review import AuditEvent


async def record_audit(
    db: AsyncSession,
    *,
    event_type: str,
    actor: UserContext,
    resource_type: str,
    resource_id: str,
    result: str,
    trace_id: str,
    metadata: dict | None = None,
    resource_version: str | None = None,
    run_id: str | None = None,
    job_id: str | None = None,
    policy_id: str | None = None,
) -> AuditEvent:
    """Persist one `AuditEvent` row and commit it.

    This commits the current session — call it last in a handler once all
    other mutations on `db` are staged, so the business change and its audit
    record land in a single transaction.
    """
    event = AuditEvent(
        event_type=event_type,
        actor_type="USER",
        actor_id=actor.user_id,
        organization_id=actor.org,
        site_id=actor.site,
        resource_type=resource_type,
        resource_id=resource_id,
        resource_version=resource_version,
        trace_id=trace_id,
        run_id=run_id,
        job_id=job_id,
        result=result,
        policy_id=policy_id,
        metadata_=metadata or {},
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event
