"""Deployment lifecycle router — M02, HOST-021/HOST-022/HOST-023.

Implements the 게시 수명주기 transitions that `routers/services.py` does not
cover (create/publish/read only):

  POST /api/v1/deployments/{deployment_id}/suspend    — ACTIVE -> SUSPENDED
  POST /api/v1/deployments/{deployment_id}/resume      — SUSPENDED -> ACTIVE
  POST /api/v1/deployments/{deployment_id}/rollback    — restore an earlier Revision
  GET  /api/v1/deployments/{deployment_id}/revisions   — rollback candidates

Kept in a separate module from `services.py` (which already owns Service
Definition + create/publish/read) so each router file keeps one lifecycle
responsibility (CLAUDE.md 코드 규칙: 함수와 클래스는 한 가지 책임을 가진다).
This module reuses `services.py`'s private trace/error/validation helpers
directly rather than duplicating them — both files belong to the same M02
app, so this is not the cross-module import CLAUDE.md 구현 원칙 2 prohibits
(that rule targets imports across M01-M12 module boundaries).

Out of scope here (see task boundary): creating a NEW revision from a
different Service Version ("Update", `POST /deployments/{id}/revisions`),
health/smoke checks, retire, and anything in services/agent-runtime.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from security_policy import Permission
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.database import get_db
from portal_api.models import DeploymentRevision, ServiceDeployment, ServiceVersion
from portal_api.rbac import require_permission
from portal_api.routers.services import (
    _deployment_out,
    _error,
    _not_found,
    _run_validation,
    _trace_id,
)
from portal_api.schemas import (
    DeploymentOut,
    DeploymentRevisionKnowledgeSummary,
    DeploymentRevisionListResponse,
    DeploymentRevisionSummaryOut,
    RollbackDeploymentRequest,
    SuspendRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/deployments", tags=["deployments"])


def _revision_summary_out(revision: DeploymentRevision) -> DeploymentRevisionSummaryOut:
    """Compact rollback-candidate view — deliberately excludes the full
    `resolved_dependency_snapshot` (large; not needed to pick a target)."""
    snapshot = revision.resolved_dependency_snapshot or {}
    knowledge_list = snapshot.get("knowledge") or []
    return DeploymentRevisionSummaryOut(
        id=revision.id,
        revision_number=revision.revision_number,
        service_version_id=revision.service_version_id,
        status=revision.status,
        created_by=revision.created_by,
        created_at=revision.created_at,
        activated_at=revision.activated_at,
        knowledge=[
            DeploymentRevisionKnowledgeSummary(
                knowledge_id=k.get("knowledge_id"), asset_name=k.get("asset_name")
            )
            for k in knowledge_list
        ],
        model_alias=snapshot.get("model_alias"),
    )


@router.post("/{deployment_id}/suspend", response_model=DeploymentOut)
async def suspend_deployment(
    deployment_id: str,
    body: SuspendRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DeploymentOut | JSONResponse:
    """ACTIVE -> SUSPENDED. Per §8 "Suspend 시 새 Chat Session 생성을 즉시
    차단한다" — `get_deployment_by_slug` already 404s for any non-ACTIVE
    status, so flipping `status` here is sufficient to cut off new sessions;
    no separate Hosted Runtime call is needed from M02.

    CLAUDE.md 승인·반려·중단·폐기는 확인과 사유를 요구한다: `reason` is
    mandatory and non-empty, mirroring `suspend_asset_version` in
    `reviews.py`.
    """
    trace_id = _trace_id()

    denial = await require_permission(
        db,
        user,
        Permission.DEPLOYMENT_SUSPEND,
        trace_id=trace_id,
        resource_type="DEPLOYMENT",
        resource_id=deployment_id,
    )
    if denial:
        return denial

    if not body.reason or not body.reason.strip():
        return _error(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "중단 사유(reason)는 필수입니다.",
            trace_id,
        )

    deployment = (
        await db.execute(select(ServiceDeployment).where(ServiceDeployment.id == deployment_id))
    ).scalar_one_or_none()
    if deployment is None:
        return _not_found("Deployment를 찾을 수 없습니다.", trace_id)

    if deployment.status != "ACTIVE":
        return _error(
            status.HTTP_409_CONFLICT,
            "DEPLOYMENT_NOT_ACTIVE",
            f"현재 상태({deployment.status})에서는 중단할 수 없습니다.",
            trace_id,
        )

    reason = body.reason.strip()[:500]
    deployment.status = "SUSPENDED"
    deployment.suspended_by = user.user_id
    deployment.suspended_at = datetime.now(UTC)
    deployment.suspend_reason = reason
    await db.flush()

    logger.info(
        "deployment.suspend trace_id=%s deployment_id=%s slug=%s",
        trace_id,
        deployment.id,
        deployment.slug,
    )
    await record_audit(
        db,
        event_type="DEPLOYMENT_SUSPENDED",
        actor=user,
        resource_type="DEPLOYMENT",
        resource_id=deployment.id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"reason": reason, "slug": deployment.slug},
    )
    return await _deployment_out(deployment, db)


@router.post("/{deployment_id}/resume", response_model=DeploymentOut)
async def resume_deployment(
    deployment_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DeploymentOut | JSONResponse:
    """SUSPENDED -> ACTIVE, per §10.2 "검증 후 재개": the active revision's
    Service Definition is re-run through the same publish-gate
    (`_run_validation`) so a deployment whose bound Knowledge was suspended
    or deprecated *while this deployment was suspended* cannot silently
    come back online.

    No `reason` is required — 재개(resume) is not among the CLAUDE.md
    승인·반려·중단·폐기 actions that mandate one.
    """
    trace_id = _trace_id()

    denial = await require_permission(
        db,
        user,
        Permission.DEPLOYMENT_SUSPEND,
        trace_id=trace_id,
        resource_type="DEPLOYMENT",
        resource_id=deployment_id,
    )
    if denial:
        return denial

    deployment = (
        await db.execute(select(ServiceDeployment).where(ServiceDeployment.id == deployment_id))
    ).scalar_one_or_none()
    if deployment is None:
        return _not_found("Deployment를 찾을 수 없습니다.", trace_id)

    if deployment.status != "SUSPENDED":
        return _error(
            status.HTTP_409_CONFLICT,
            "DEPLOYMENT_NOT_ACTIVE",
            f"현재 상태({deployment.status})에서는 재개할 수 없습니다.",
            trace_id,
        )

    if deployment.active_revision_id is None:
        return _error(
            status.HTTP_409_CONFLICT,
            "DEPLOYMENT_REVISION_UNAVAILABLE",
            "재개할 활성 Revision이 없습니다.",
            trace_id,
        )

    revision = (
        await db.execute(
            select(DeploymentRevision).where(DeploymentRevision.id == deployment.active_revision_id)
        )
    ).scalar_one_or_none()
    if revision is None:
        return _error(
            status.HTTP_409_CONFLICT,
            "DEPLOYMENT_REVISION_UNAVAILABLE",
            "재개할 활성 Revision을 찾을 수 없습니다.",
            trace_id,
        )

    version = (
        await db.execute(
            select(ServiceVersion).where(ServiceVersion.id == revision.service_version_id)
        )
    ).scalar_one_or_none()
    if version is None:
        return _not_found("Service Version을 찾을 수 없습니다.", trace_id)

    validation = await _run_validation(version.service_definition, db, version.status)
    if not validation.passed:
        return _error(
            status.HTTP_400_BAD_REQUEST,
            "DEPLOYMENT_VALIDATION_FAILED",
            "재개 전 검증에 실패했습니다.",
            trace_id,
            details={"checks": [c.model_dump() for c in validation.checks]},
        )

    deployment.status = "ACTIVE"
    deployment.suspended_by = None
    deployment.suspended_at = None
    deployment.suspend_reason = None
    await db.flush()

    logger.info(
        "deployment.resume trace_id=%s deployment_id=%s slug=%s",
        trace_id,
        deployment.id,
        deployment.slug,
    )
    await record_audit(
        db,
        event_type="DEPLOYMENT_RESUMED",
        actor=user,
        resource_type="DEPLOYMENT",
        resource_id=deployment.id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"slug": deployment.slug, "revision_id": revision.id},
    )
    return await _deployment_out(deployment, db)


@router.post("/{deployment_id}/rollback", response_model=DeploymentOut)
async def rollback_deployment(
    deployment_id: str,
    body: RollbackDeploymentRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DeploymentOut | JSONResponse:
    """Restore an earlier DeploymentRevision as ACTIVE. Per §8 "Update 실패 시
    기존 Active Revision을 유지한다" — rollback is the recovery path when a
    later revision turns out bad. Defaults to the highest revision_number
    below the current active one; `target_revision_id` may pick a specific
    (older) revision instead.
    """
    trace_id = _trace_id()

    denial = await require_permission(
        db,
        user,
        Permission.DEPLOYMENT_ROLLBACK,
        trace_id=trace_id,
        resource_type="DEPLOYMENT",
        resource_id=deployment_id,
    )
    if denial:
        return denial

    if not body.reason or not body.reason.strip():
        return _error(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "롤백 사유(reason)는 필수입니다.",
            trace_id,
        )

    deployment = (
        await db.execute(select(ServiceDeployment).where(ServiceDeployment.id == deployment_id))
    ).scalar_one_or_none()
    if deployment is None:
        return _not_found("Deployment를 찾을 수 없습니다.", trace_id)

    current_revision = None
    if deployment.active_revision_id:
        current_revision = (
            await db.execute(
                select(DeploymentRevision).where(
                    DeploymentRevision.id == deployment.active_revision_id
                )
            )
        ).scalar_one_or_none()

    target_revision = None
    if body.target_revision_id:
        candidate = (
            await db.execute(
                select(DeploymentRevision).where(
                    DeploymentRevision.id == body.target_revision_id,
                    DeploymentRevision.deployment_id == deployment.id,
                )
            )
        ).scalar_one_or_none()
        if candidate is not None and (
            current_revision is None or candidate.id != current_revision.id
        ):
            target_revision = candidate
    elif current_revision is not None:
        target_revision = (
            await db.execute(
                select(DeploymentRevision)
                .where(
                    DeploymentRevision.deployment_id == deployment.id,
                    DeploymentRevision.revision_number < current_revision.revision_number,
                )
                .order_by(DeploymentRevision.revision_number.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

    if target_revision is None:
        return _error(
            status.HTTP_409_CONFLICT,
            "DEPLOYMENT_REVISION_UNAVAILABLE",
            "복구할 이전 Revision이 없습니다.",
            trace_id,
        )

    reason = body.reason.strip()[:500]

    if current_revision is not None and current_revision.id != target_revision.id:
        current_revision.status = "SUPERSEDED"

    target_revision.status = "ACTIVE"
    target_revision.activated_at = datetime.now(UTC)
    deployment.active_revision_id = target_revision.id
    deployment.status = "ACTIVE"
    await db.flush()

    logger.info(
        "deployment.rollback trace_id=%s deployment_id=%s target_revision_id=%s",
        trace_id,
        deployment.id,
        target_revision.id,
    )
    await record_audit(
        db,
        event_type="DEPLOYMENT_ROLLED_BACK",
        actor=user,
        resource_type="DEPLOYMENT",
        resource_id=deployment.id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={
            "reason": reason,
            "from_revision_id": current_revision.id if current_revision else None,
            "to_revision_id": target_revision.id,
            "slug": deployment.slug,
        },
    )
    return await _deployment_out(deployment, db)


@router.get("/{deployment_id}/revisions", response_model=DeploymentRevisionListResponse)
async def list_deployment_revisions(
    deployment_id: str,
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    _user: UserContext = Depends(get_current_user),
) -> DeploymentRevisionListResponse | JSONResponse:
    trace_id = _trace_id()

    deployment = (
        await db.execute(select(ServiceDeployment).where(ServiceDeployment.id == deployment_id))
    ).scalar_one_or_none()
    if deployment is None:
        return _not_found("Deployment를 찾을 수 없습니다.", trace_id)

    base_stmt = select(DeploymentRevision).where(DeploymentRevision.deployment_id == deployment_id)
    total = (
        await db.execute(select(func.count()).select_from(base_stmt.subquery()))
    ).scalar_one()
    stmt = (
        base_stmt.order_by(DeploymentRevision.revision_number.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    revisions = (await db.execute(stmt)).scalars().all()

    items = [_revision_summary_out(r) for r in revisions]
    return DeploymentRevisionListResponse(items=items, page=page, page_size=page_size, total=total)
