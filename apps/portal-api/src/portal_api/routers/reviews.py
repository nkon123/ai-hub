"""Review workflow router — M02.

Implements the sequential TECHNICAL → SECURITY → RELEASE approval chain
(docs/implementation-spec/07-data-api-contracts.md §3.6, §4.1) plus the
Release Manager lifecycle actions (suspend/deprecate/retire/replacement/
revocation — 01-portal-and-distribution.md §2 P16). All authorization and
state-machine decisions are delegated to the framework-free `security_policy`
package (M11) — this router only wires HTTP <-> DB <-> that policy.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import JSONResponse
from observability import get_trace_id
from security_policy import (
    STAGE_PERMISSION,
    InvalidTransitionError,
    Permission,
    ReviewDecisionType,
    ReviewStatus,
    Role,
    Stage,
    VersionStatus,
    can_transition,
    require_transition,
    resolve_review_decision,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.database import get_db
from portal_api.errors import error_response, not_found
from portal_api.models import (
    Asset,
    AssetVersion,
    AssetVersionRevocation,
    DeploymentRevision,
    DistributionRequest,
    Service,
    ServiceDeployment,
    ServiceVersion,
)
from portal_api.models.review import AuditEvent, ReviewDecision, ReviewRequest
from portal_api.models.revocation import is_effective
from portal_api.rbac import require_permission
from portal_api.schemas import (
    AssetVersionImpactOut,
    AssetVersionLifecycleItemOut,
    AssetVersionLifecycleListResponse,
    AssetVersionOut,
    AssetVersionRevocationOut,
    AuditEventListResponse,
    AuditEventOut,
    CancelReviewRequest,
    CancelReviewResponseOut,
    CreateRevocationRequest,
    DecideReviewRequest,
    DecisionResultOut,
    DeprecateRequest,
    ImpactDeploymentOut,
    ImpactDistributionOut,
    ImpactServiceOut,
    RetireRequest,
    ReviewDecisionOut,
    ReviewDetailOut,
    ReviewHistoryEntryOut,
    ReviewListResponse,
    ReviewRequestOut,
    SetReplacementRequest,
    SubmitReviewResponseOut,
    SuspendRequest,
)

router = APIRouter(prefix="/api/v1", tags=["reviews"])


def _trace_id() -> str:
    # See portal_api.routers.assets._trace_id — same rationale.
    return get_trace_id() or str(uuid.uuid4())


async def _load_review_subject(
    db: AsyncSession, review: ReviewRequest
) -> tuple[AssetVersion | ServiceVersion, str] | None:
    """Resolve a `ReviewRequest`'s subject row — generic across both subject
    types the schema (`07-data-api-contracts.md` §3.6) models. D-041 후속
    (ServiceVersion 자체 검토 체인): this is the single place `submit`/
    `decide`/`cancel` branch on `subject_type` so the rest of the workflow
    (RBAC, sequential stage chain, audit) stays identical for both — CLAUDE.md
    원칙 1/5 (재사용, 포크 금지).

    Returns `(version_row, resource_type)` or `None` if the subject_id no
    longer resolves (orphaned review — should not happen in practice, but
    handled explicitly rather than raising).
    """
    if review.subject_type == "ASSET_VERSION":
        version = (
            await db.execute(select(AssetVersion).where(AssetVersion.id == review.subject_id))
        ).scalar_one_or_none()
        return (version, "ASSET_VERSION") if version is not None else None
    if review.subject_type == "SERVICE_VERSION":
        version = (
            await db.execute(select(ServiceVersion).where(ServiceVersion.id == review.subject_id))
        ).scalar_one_or_none()
        return (version, "SERVICE_VERSION") if version is not None else None
    return None


async def _review_out(review: ReviewRequest, db: AsyncSession) -> ReviewRequestOut:
    # Field names (`asset_name`/`asset_type`) predate SERVICE_VERSION support
    # and stay as-is (contract/UI already consume them) — for a SERVICE_VERSION
    # subject they carry the Service's name and the literal type "service"
    # (already mapped to "서비스" in app/_components/review-meta.ts).
    asset_name: str | None = None
    asset_type: str | None = None
    version_label: str | None = None

    if review.subject_type == "ASSET_VERSION":
        version = (
            await db.execute(select(AssetVersion).where(AssetVersion.id == review.subject_id))
        ).scalar_one_or_none()
        if version is not None:
            version_label = version.version
            asset = (
                await db.execute(select(Asset).where(Asset.id == version.asset_id))
            ).scalar_one_or_none()
            if asset is not None:
                asset_name = asset.name
                asset_type = asset.type
    elif review.subject_type == "SERVICE_VERSION":
        service_version = (
            await db.execute(select(ServiceVersion).where(ServiceVersion.id == review.subject_id))
        ).scalar_one_or_none()
        if service_version is not None:
            version_label = service_version.version
            service = (
                await db.execute(select(Service).where(Service.id == service_version.service_id))
            ).scalar_one_or_none()
            if service is not None:
                asset_name = service.name
                asset_type = "service"

    return ReviewRequestOut(
        id=review.id,
        subject_type=review.subject_type,
        subject_id=review.subject_id,
        stage=review.stage,
        status=review.status,
        requested_by=review.requested_by,
        requested_at=review.requested_at,
        assigned_to=review.assigned_to,
        policy_version=review.policy_version,
        asset_name=asset_name,
        asset_type=asset_type,
        version_label=version_label,
    )


# --- Submit for review ---


@router.post("/asset-versions/{version_id}/submit", response_model=SubmitReviewResponseOut)
async def submit_asset_version(
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> SubmitReviewResponseOut | JSONResponse:
    trace_id = _trace_id()

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    denial = await require_permission(
        db,
        user,
        Permission.ASSET_SUBMIT_REVIEW,
        trace_id=trace_id,
        resource_type="ASSET_VERSION",
        resource_id=version_id,
    )
    if denial:
        return denial

    asset = (
        await db.execute(select(Asset).where(Asset.id == version.asset_id))
    ).scalar_one_or_none()
    is_owner = asset is not None and asset.owner_creator_id == user.user_id
    if asset is not None and user.role != Role.ADMIN.value and not is_owner:
        await record_audit(
            db,
            event_type="ASSET_VERSION_SUBMIT_DENIED",
            actor=user,
            resource_type="ASSET_VERSION",
            resource_id=version_id,
            result="DENIED",
            trace_id=trace_id,
            metadata={"reason": "not_owner"},
        )
        return error_response(
            status.HTTP_403_FORBIDDEN,
            "PERMISSION_DENIED",
            "본인이 소유한 자산만 검토 요청할 수 있습니다.",
            trace_id,
        )

    try:
        current = VersionStatus(version.status)
    except ValueError:
        current = None
    if current is None or not can_transition(current, VersionStatus.IN_REVIEW):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})에서는 검토를 요청할 수 없습니다.",
            trace_id,
            details={"current_status": version.status},
        )

    version.status = VersionStatus.IN_REVIEW.value
    review = ReviewRequest(
        subject_type="ASSET_VERSION",
        subject_id=version_id,
        stage=Stage.TECHNICAL.value,
        status="PENDING",
        requested_by=user.user_id,
        requested_at=datetime.now(UTC),
        policy_version="v1",
    )
    db.add(review)
    await db.flush()

    await record_audit(
        db,
        event_type="ASSET_VERSION_SUBMITTED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version_id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"stage": Stage.TECHNICAL.value, "review_id": review.id},
    )

    return SubmitReviewResponseOut(
        version_id=version_id,
        status=version.status,
        review_id=review.id,
        stage=review.stage,
    )


@router.post("/service-versions/{version_id}/submit", response_model=SubmitReviewResponseOut)
async def submit_service_version(
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> SubmitReviewResponseOut | JSONResponse:
    """D-041 후속(ServiceVersion 자체 검토 체인) — mirrors `submit_asset_version`
    exactly (same ReviewRequest table, same TECHNICAL→SECURITY→RELEASE chain,
    same ownership rule), swapping only the subject table (`ServiceVersion`/
    `Service` instead of `AssetVersion`/`Asset`) and the submit-permission
    (`SERVICE_SUBMIT_REVIEW` instead of `ASSET_SUBMIT_REVIEW`)."""
    trace_id = _trace_id()

    version = (
        await db.execute(select(ServiceVersion).where(ServiceVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("Service Version을 찾을 수 없습니다.", trace_id)

    denial = await require_permission(
        db,
        user,
        Permission.SERVICE_SUBMIT_REVIEW,
        trace_id=trace_id,
        resource_type="SERVICE_VERSION",
        resource_id=version_id,
    )
    if denial:
        return denial

    service = (
        await db.execute(select(Service).where(Service.id == version.service_id))
    ).scalar_one_or_none()
    is_owner = service is not None and service.owner_creator_id == user.user_id
    if service is not None and user.role != Role.ADMIN.value and not is_owner:
        await record_audit(
            db,
            event_type="SERVICE_VERSION_SUBMIT_DENIED",
            actor=user,
            resource_type="SERVICE_VERSION",
            resource_id=version_id,
            result="DENIED",
            trace_id=trace_id,
            metadata={"reason": "not_owner"},
        )
        return error_response(
            status.HTTP_403_FORBIDDEN,
            "PERMISSION_DENIED",
            "본인이 소유한 서비스만 검토 요청할 수 있습니다.",
            trace_id,
        )

    try:
        current = VersionStatus(version.status)
    except ValueError:
        current = None
    if current is None or not can_transition(current, VersionStatus.IN_REVIEW):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})에서는 검토를 요청할 수 없습니다.",
            trace_id,
            details={"current_status": version.status},
        )

    version.status = VersionStatus.IN_REVIEW.value
    review = ReviewRequest(
        subject_type="SERVICE_VERSION",
        subject_id=version_id,
        stage=Stage.TECHNICAL.value,
        status="PENDING",
        requested_by=user.user_id,
        requested_at=datetime.now(UTC),
        policy_version="v1",
    )
    db.add(review)
    await db.flush()

    await record_audit(
        db,
        event_type="SERVICE_VERSION_SUBMITTED",
        actor=user,
        resource_type="SERVICE_VERSION",
        resource_id=version_id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"stage": Stage.TECHNICAL.value, "review_id": review.id},
    )

    return SubmitReviewResponseOut(
        version_id=version_id,
        status=version.status,
        review_id=review.id,
        stage=review.stage,
    )


# --- Review inbox ---


@router.get("/reviews", response_model=ReviewListResponse)
async def list_reviews(
    stage: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    subject_type: str | None = None,
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> ReviewListResponse | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.REVIEW_LIST, trace_id=trace_id, resource_type="REVIEW"
    )
    if denial:
        return denial

    stmt = select(ReviewRequest)
    if stage:
        stmt = stmt.where(ReviewRequest.stage == stage)
    if status_filter:
        stmt = stmt.where(ReviewRequest.status == status_filter)
    if subject_type:
        stmt = stmt.where(ReviewRequest.subject_type == subject_type)

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = (
        stmt.offset((page - 1) * page_size)
        .limit(page_size)
        .order_by(ReviewRequest.requested_at.desc(), ReviewRequest.id)
    )
    reviews = (await db.execute(stmt)).scalars().all()

    items = [await _review_out(r, db) for r in reviews]
    return ReviewListResponse(items=items, page=page, page_size=page_size, total=total)


@router.get("/reviews/{review_id}", response_model=ReviewDetailOut)
async def get_review(
    review_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> ReviewDetailOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db,
        user,
        Permission.REVIEW_LIST,
        trace_id=trace_id,
        resource_type="REVIEW",
        resource_id=review_id,
    )
    if denial:
        return denial

    review = (
        await db.execute(select(ReviewRequest).where(ReviewRequest.id == review_id))
    ).scalar_one_or_none()
    if review is None:
        return not_found("검토 요청을 찾을 수 없습니다.", trace_id)

    review_out = await _review_out(review, db)

    subject_summary: dict = {}
    if review.subject_type == "ASSET_VERSION":
        version = (
            await db.execute(select(AssetVersion).where(AssetVersion.id == review.subject_id))
        ).scalar_one_or_none()
        if version is not None:
            manifest = version.manifest or {}
            subject_summary = {
                "asset_id": version.asset_id,
                "version": version.version,
                "status": version.status,
                "manifest_type": manifest.get("type"),
                "manifest_name": manifest.get("name"),
                "changelog": version.changelog,
            }
    elif review.subject_type == "SERVICE_VERSION":
        service_version = (
            await db.execute(select(ServiceVersion).where(ServiceVersion.id == review.subject_id))
        ).scalar_one_or_none()
        if service_version is not None:
            service = (
                await db.execute(select(Service).where(Service.id == service_version.service_id))
            ).scalar_one_or_none()
            # Reuses the same `manifest_type`/`manifest_name` keys as the
            # ASSET_VERSION branch above (rather than inventing parallel
            # `service_*` keys) so `app/reviews/[id]/page.tsx`'s "버전 요약"
            # card renders both subject types without a UI schema branch.
            subject_summary = {
                "asset_id": service_version.service_id,
                "version": service_version.version,
                "status": service_version.status,
                "manifest_type": "service",
                "manifest_name": service.name if service is not None else None,
                "changelog": None,
            }

    # Full stage history for this subject (all stages, not just this review).
    history_stmt = (
        select(ReviewRequest)
        .where(
            ReviewRequest.subject_type == review.subject_type,
            ReviewRequest.subject_id == review.subject_id,
        )
        .order_by(ReviewRequest.requested_at.asc())
    )
    all_reviews = (await db.execute(history_stmt)).scalars().all()

    history: list[ReviewHistoryEntryOut] = []
    for r in all_reviews:
        decision = (
            await db.execute(
                select(ReviewDecision)
                .where(ReviewDecision.review_id == r.id)
                .order_by(ReviewDecision.decided_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        history.append(
            ReviewHistoryEntryOut(
                stage=r.stage,
                status=r.status,
                decision=decision.decision if decision else None,
                reviewer_id=decision.reviewer_id if decision else None,
                comments=decision.comments if decision else None,
                decided_at=decision.decided_at if decision else None,
            )
        )

    return ReviewDetailOut(review=review_out, subject_summary=subject_summary, history=history)


# --- Decisions ---


@router.post("/reviews/{review_id}/decisions", response_model=DecisionResultOut)
async def decide_review(
    review_id: str,
    body: DecideReviewRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DecisionResultOut | JSONResponse:
    trace_id = _trace_id()

    review = (
        await db.execute(select(ReviewRequest).where(ReviewRequest.id == review_id))
    ).scalar_one_or_none()
    if review is None:
        return not_found("검토 요청을 찾을 수 없습니다.", trace_id)

    try:
        stage = Stage(review.stage)
    except ValueError:
        return error_response(
            status.HTTP_400_BAD_REQUEST, "VALIDATION_ERROR", "알 수 없는 검토 단계입니다.", trace_id
        )

    denial = await require_permission(
        db,
        user,
        STAGE_PERMISSION[stage],
        trace_id=trace_id,
        resource_type="REVIEW",
        resource_id=review_id,
    )
    if denial:
        return denial

    if not body.comments or not body.comments.strip():
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "검토 의견(comments)은 필수입니다.",
            trace_id,
        )

    if review.status != "PENDING":
        return error_response(
            status.HTTP_409_CONFLICT,
            "RESOURCE_REVISION_CONFLICT",
            "이미 처리된 검토 요청입니다.",
            trace_id,
            details={"current_status": review.status},
        )

    if review.subject_type not in ("ASSET_VERSION", "SERVICE_VERSION"):
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "지원하지 않는 검토 대상 유형입니다.",
            trace_id,
        )

    subject = await _load_review_subject(db, review)
    if subject is None:
        return not_found("검토 대상을 찾을 수 없습니다.", trace_id)
    version, resource_type = subject

    try:
        decision_type = ReviewDecisionType(body.decision)
    except ValueError:
        return error_response(
            status.HTTP_400_BAD_REQUEST, "VALIDATION_ERROR", "알 수 없는 결정 값입니다.", trace_id
        )

    outcome = resolve_review_decision(stage, decision_type)

    current = VersionStatus(version.status)
    if outcome.version_status != current:
        try:
            require_transition(current, outcome.version_status)
        except InvalidTransitionError:
            return error_response(
                status.HTTP_409_CONFLICT,
                "ASSET_STATE_TRANSITION_INVALID",
                f"현재 버전 상태({version.status})에서는 이 결정을 적용할 수 없습니다.",
                trace_id,
            )

    now = datetime.now(UTC)
    review.status = outcome.review_status.value

    decision = ReviewDecision(
        review_id=review.id,
        decision=decision_type.value,
        reviewer_id=user.user_id,
        comments=body.comments.strip(),
        checklist_result=body.checklist_result,
        # ServiceVersion has no manifest — `getattr` gives `None` there
        # instead of a per-subject-type branch (AssetVersion always has the
        # attribute, so this never masks a real AttributeError).
        subject_hash=getattr(version, "manifest_hash", None),
        decided_at=now,
    )
    db.add(decision)

    version.status = outcome.version_status.value
    if outcome.version_status == VersionStatus.APPROVED:
        version.approved_at = now

    if outcome.next_stage is not None:
        db.add(
            ReviewRequest(
                subject_type=review.subject_type,
                subject_id=review.subject_id,
                stage=outcome.next_stage.value,
                status="PENDING",
                requested_by=review.requested_by,
                requested_at=now,
                policy_version=review.policy_version,
            )
        )

    await db.flush()

    await record_audit(
        db,
        event_type=f"REVIEW_DECISION_{decision_type.value}",
        actor=user,
        resource_type=resource_type,
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={
            "review_id": review.id,
            "stage": stage.value,
            "next_stage": outcome.next_stage.value if outcome.next_stage else None,
        },
    )

    return DecisionResultOut(
        review=await _review_out(review, db),
        decision=ReviewDecisionOut.model_validate(decision),
        version_status=version.status,
        next_stage=outcome.next_stage.value if outcome.next_stage else None,
    )


@router.post("/reviews/{review_id}/cancel", response_model=CancelReviewResponseOut)
async def cancel_review(
    review_id: str,
    body: CancelReviewRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> CancelReviewResponseOut | JSONResponse:
    """P06 버전 관리: 검토 요청 취소.

    요청자 본인(또는 ADMIN)만, 검토가 아직 PENDING 상태일 때만 취소할 수
    있다. 취소는 새 `ReviewDecision`을 남기지 않는다 — 검토자가 실제로 의견을
    낸 적이 없기 때문이다(`ReviewRequest.status`만 CANCELLED로 전이). 대상
    버전은 IN_REVIEW → CHANGES_REQUESTED로 되돌려 다시 편집 가능하게 만든다:
    이 상태 머신에서 IN_REVIEW가 돌아갈 수 있는 유일한 편집 가능 상태다 —
    DRAFT로의 직접 복귀는 `packages/security-policy`의 검토된 전이표
    (`ALLOWED_TRANSITIONS`)에 없고, 이 구현은 그 표를 수정하지 않는다.
    """
    trace_id = _trace_id()

    review = (
        await db.execute(select(ReviewRequest).where(ReviewRequest.id == review_id))
    ).scalar_one_or_none()
    if review is None:
        return not_found("검토 요청을 찾을 수 없습니다.", trace_id)

    # Reuses ASSET_SUBMIT_REVIEW/SERVICE_SUBMIT_REVIEW: the same class of user
    # who may submit a version for review (owning CREATOR/ADMIN) may also
    # cancel their own pending submission — same pattern as
    # `submit_asset_version`/`submit_service_version`'s permission-then-
    # ownership check. Picked here (before the subject row is even loaded) so
    # a SERVICE_VERSION cancel is checked against the right permission.
    if review.subject_type == "ASSET_VERSION":
        submit_permission = Permission.ASSET_SUBMIT_REVIEW
    elif review.subject_type == "SERVICE_VERSION":
        submit_permission = Permission.SERVICE_SUBMIT_REVIEW
    else:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "지원하지 않는 검토 대상 유형입니다.",
            trace_id,
        )

    denial = await require_permission(
        db,
        user,
        submit_permission,
        trace_id=trace_id,
        resource_type="REVIEW",
        resource_id=review_id,
    )
    if denial:
        return denial

    if user.role != Role.ADMIN.value and review.requested_by != user.user_id:
        await record_audit(
            db,
            event_type="REVIEW_CANCEL_DENIED",
            actor=user,
            resource_type="REVIEW",
            resource_id=review_id,
            result="DENIED",
            trace_id=trace_id,
            metadata={"reason": "not_requester"},
        )
        return error_response(
            status.HTTP_403_FORBIDDEN,
            "PERMISSION_DENIED",
            "본인이 요청한 검토만 취소할 수 있습니다.",
            trace_id,
        )

    if not body.reason or not body.reason.strip():
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "취소 사유(reason)는 필수입니다.",
            trace_id,
        )

    if review.status != "PENDING":
        return error_response(
            status.HTTP_409_CONFLICT,
            "RESOURCE_REVISION_CONFLICT",
            "이미 처리된 검토 요청입니다.",
            trace_id,
            details={"current_status": review.status},
        )

    subject = await _load_review_subject(db, review)
    if subject is None:
        return not_found("검토 대상을 찾을 수 없습니다.", trace_id)
    version, resource_type = subject

    try:
        current = VersionStatus(version.status)
    except ValueError:
        current = None
    if current is None or not can_transition(current, VersionStatus.CHANGES_REQUESTED):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 버전 상태({version.status})에서는 검토를 취소할 수 없습니다.",
            trace_id,
        )

    review.status = ReviewStatus.CANCELLED.value
    version.status = VersionStatus.CHANGES_REQUESTED.value
    await db.flush()

    await record_audit(
        db,
        event_type="REVIEW_CANCELLED",
        actor=user,
        resource_type=resource_type,
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={
            "review_id": review.id,
            "stage": review.stage,
            "reason": body.reason.strip()[:500],
        },
    )

    return CancelReviewResponseOut(
        review=await _review_out(review, db), version_status=version.status
    )


# --- Lifecycle: suspend / deprecate ---


@router.post("/asset-versions/{version_id}/suspend", response_model=AssetVersionOut)
async def suspend_asset_version(
    version_id: str,
    body: SuspendRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db,
        user,
        Permission.ASSET_SUSPEND,
        trace_id=trace_id,
        resource_type="ASSET_VERSION",
        resource_id=version_id,
    )
    if denial:
        return denial

    if not body.reason or not body.reason.strip():
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "중단 사유(reason)는 필수입니다.",
            trace_id,
        )

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    current = VersionStatus(version.status)
    if not can_transition(current, VersionStatus.SUSPENDED):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})에서는 중단할 수 없습니다.",
            trace_id,
        )

    version.status = VersionStatus.SUSPENDED.value
    await db.flush()

    await record_audit(
        db,
        event_type="ASSET_VERSION_SUSPENDED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version_id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"reason": body.reason.strip()[:500]},
    )
    return AssetVersionOut.model_validate(version)


@router.post("/assets/{asset_id}/deprecate", response_model=AssetVersionOut)
async def deprecate_asset(
    asset_id: str,
    body: DeprecateRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db,
        user,
        Permission.ASSET_DEPRECATE,
        trace_id=trace_id,
        resource_type="ASSET",
        resource_id=asset_id,
    )
    if denial:
        return denial

    if not body.reason or not body.reason.strip():
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "지원 종료 사유(reason)는 필수입니다.",
            trace_id,
        )

    asset = (await db.execute(select(Asset).where(Asset.id == asset_id))).scalar_one_or_none()
    if asset is None:
        return not_found("자산을 찾을 수 없습니다.", trace_id)

    stmt = (
        select(AssetVersion)
        .where(
            AssetVersion.asset_id == asset_id,
            AssetVersion.status == VersionStatus.APPROVED.value,
        )
        .order_by(AssetVersion.updated_at.desc())
        .limit(1)
    )
    version = (await db.execute(stmt)).scalar_one_or_none()
    if version is None:
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            "승인된 버전이 없어 지원 종료를 설정할 수 없습니다.",
            trace_id,
        )

    version.status = VersionStatus.DEPRECATED.value
    version.deprecated_at = datetime.now(UTC)
    await db.flush()

    await record_audit(
        db,
        event_type="ASSET_DEPRECATED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"reason": body.reason.strip()[:500], "asset_id": asset_id},
    )
    return AssetVersionOut.model_validate(version)


# --- P16 수명주기/회수 (01-portal-and-distribution.md §2 P16) ---

# Statuses a version must have passed through at least once before it can be
# the target of an emergency revocation — DRAFT/IN_REVIEW/etc. were never
# distributed to anyone, so "회수(recall)" doesn't apply to them.
_REVOCABLE_STATUSES = frozenset(
    {
        VersionStatus.APPROVED,
        VersionStatus.SUSPENDED,
        VersionStatus.DEPRECATED,
        VersionStatus.RETIRED,
    }
)


async def _latest_revocation(db: AsyncSession, version_id: str) -> AssetVersionRevocation | None:
    stmt = (
        select(AssetVersionRevocation)
        .where(AssetVersionRevocation.version_id == version_id)
        .order_by(
            AssetVersionRevocation.effective_at.desc(), AssetVersionRevocation.created_at.desc()
        )
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


def _revocation_out(revocation: AssetVersionRevocation) -> AssetVersionRevocationOut:
    return AssetVersionRevocationOut(
        id=revocation.id,
        version_id=revocation.version_id,
        reason=revocation.reason,
        approver_id=revocation.approver_id,
        effective_at=revocation.effective_at,
        created_at=revocation.created_at,
        trace_id=revocation.trace_id,
        # D-072: shared with `routers.distributions`/`routers.assets` via
        # `models.revocation.is_effective` — never re-derive this check
        # locally (see that function's docstring for why).
        effective=is_effective(revocation.effective_at),
    )


async def _lifecycle_item_out(
    db: AsyncSession, version: AssetVersion, asset: Asset
) -> AssetVersionLifecycleItemOut:
    replacement_label: str | None = None
    if version.replacement_version_id:
        replacement = (
            await db.execute(
                select(AssetVersion).where(AssetVersion.id == version.replacement_version_id)
            )
        ).scalar_one_or_none()
        if replacement is not None:
            replacement_label = replacement.version

    revocation = await _latest_revocation(db, version.id)

    return AssetVersionLifecycleItemOut(
        id=version.id,
        asset_id=asset.id,
        asset_name=asset.name,
        asset_type=asset.type,
        version=version.version,
        status=version.status,
        approved_at=version.approved_at,
        deprecated_at=version.deprecated_at,
        retired_at=version.retired_at,
        replacement_version_id=version.replacement_version_id,
        replacement_version_label=replacement_label,
        active_revocation=_revocation_out(revocation) if revocation is not None else None,
    )


@router.get("/asset-versions/lifecycle", response_model=AssetVersionLifecycleListResponse)
async def list_asset_version_lifecycle(
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionLifecycleListResponse | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.LIFECYCLE_READ, trace_id=trace_id, resource_type="ASSET_VERSION"
    )
    if denial:
        return denial

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    stmt = select(AssetVersion, Asset).join(Asset, Asset.id == AssetVersion.asset_id)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = (
        stmt.order_by(AssetVersion.updated_at.desc(), AssetVersion.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).all()

    items = [await _lifecycle_item_out(db, version, asset) for version, asset in rows]
    return AssetVersionLifecycleListResponse(
        items=items, page=page, page_size=page_size, total=total
    )


@router.post("/asset-versions/{version_id}/retire", response_model=AssetVersionLifecycleItemOut)
async def retire_asset_version(
    version_id: str,
    body: RetireRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionLifecycleItemOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db,
        user,
        Permission.ASSET_RETIRE,
        trace_id=trace_id,
        resource_type="ASSET_VERSION",
        resource_id=version_id,
    )
    if denial:
        return denial

    if not body.reason or not body.reason.strip():
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "폐기 사유(reason)는 필수입니다.",
            trace_id,
        )

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    current = VersionStatus(version.status)
    if not can_transition(current, VersionStatus.RETIRED):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})에서는 Retired 처리할 수 없습니다. "
            "지원 종료(DEPRECATED) 상태의 버전만 Retired 처리할 수 있습니다.",
            trace_id,
        )

    version.status = VersionStatus.RETIRED.value
    version.retired_at = datetime.now(UTC)
    await db.flush()

    asset = (await db.execute(select(Asset).where(Asset.id == version.asset_id))).scalar_one()

    await record_audit(
        db,
        event_type="ASSET_VERSION_RETIRED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"reason": body.reason.strip()[:500]},
    )
    return await _lifecycle_item_out(db, version, asset)


@router.post(
    "/asset-versions/{version_id}/replacement", response_model=AssetVersionLifecycleItemOut
)
async def set_replacement_version(
    version_id: str,
    body: SetReplacementRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionLifecycleItemOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db,
        user,
        Permission.ASSET_SET_REPLACEMENT,
        trace_id=trace_id,
        resource_type="ASSET_VERSION",
        resource_id=version_id,
    )
    if denial:
        return denial

    if not body.reason or not body.reason.strip():
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "지정 사유(reason)는 필수입니다.",
            trace_id,
        )

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    if version.status not in (VersionStatus.DEPRECATED.value, VersionStatus.RETIRED.value):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})에서는 대체 버전을 지정할 수 없습니다. "
            "지원 종료(DEPRECATED) 또는 폐기(RETIRED) 상태의 버전만 "
            "대체 버전을 지정할 수 있습니다.",
            trace_id,
        )

    if body.replacement_version_id == version_id:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "자기 자신을 대체 버전으로 지정할 수 없습니다.",
            trace_id,
        )

    replacement = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == body.replacement_version_id))
    ).scalar_one_or_none()
    if replacement is None:
        return not_found("대체 버전으로 지정할 자산 버전을 찾을 수 없습니다.", trace_id)

    if replacement.asset_id != version.asset_id:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "다른 자산의 버전은 대체 버전으로 지정할 수 없습니다.",
            trace_id,
        )

    if replacement.status != VersionStatus.APPROVED.value:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            f"대체 버전은 승인(APPROVED) 상태여야 합니다. (현재: {replacement.status})",
            trace_id,
        )

    version.replacement_version_id = replacement.id
    await db.flush()

    asset = (await db.execute(select(Asset).where(Asset.id == version.asset_id))).scalar_one()

    await record_audit(
        db,
        event_type="ASSET_VERSION_REPLACEMENT_SET",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"reason": body.reason.strip()[:500], "replacement_version_id": replacement.id},
    )
    return await _lifecycle_item_out(db, version, asset)


@router.post(
    "/asset-versions/{version_id}/revocations",
    response_model=AssetVersionRevocationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_revocation(
    version_id: str,
    body: CreateRevocationRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionRevocationOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db,
        user,
        Permission.ASSET_REVOKE,
        trace_id=trace_id,
        resource_type="ASSET_VERSION",
        resource_id=version_id,
    )
    if denial:
        return denial

    # §2 P16: "긴급 회수는 사유, 승인자, 효력 시각이 필수다." — check each
    # individually so the error names exactly which field is missing.
    if not body.reason or not body.reason.strip():
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "회수 사유(reason)는 필수입니다.",
            trace_id,
        )
    if not body.approver_id or not body.approver_id.strip():
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "승인자(approver_id)는 필수입니다.",
            trace_id,
        )
    if body.effective_at is None:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "효력 시각(effective_at)은 필수입니다.",
            trace_id,
        )

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    try:
        current = VersionStatus(version.status)
    except ValueError:
        current = None
    if current not in _REVOCABLE_STATUSES:
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})의 버전은 긴급 회수 대상이 아닙니다. "
            "승인 이력이 있는 버전(APPROVED/SUSPENDED/DEPRECATED/RETIRED)만 회수할 수 있습니다.",
            trace_id,
        )

    revocation = AssetVersionRevocation(
        version_id=version.id,
        reason=body.reason.strip(),
        approver_id=body.approver_id.strip(),
        effective_at=body.effective_at,
        trace_id=trace_id,
    )
    db.add(revocation)
    await db.flush()

    await record_audit(
        db,
        event_type="ASSET_VERSION_REVOKED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={
            "reason": revocation.reason[:500],
            "approver_id": revocation.approver_id,
            "effective_at": revocation.effective_at.isoformat(),
            "revocation_id": revocation.id,
        },
    )
    return _revocation_out(revocation)


@router.get("/asset-versions/{version_id}/impact", response_model=AssetVersionImpactOut)
async def get_asset_version_impact(
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionImpactOut | JSONResponse:
    """영향받는 Service·Bundle 조회 (§2 P16) — the blast-radius query an
    operator must see *before* confirming a destructive lifecycle action.

    `ServiceVersion.service_definition` is a JSON blob, not a relational FK to
    `AssetVersion` (Knowledge bindings are declared inline — see
    `07-data-api-contracts.md`'s Service Definition schema), so this scans
    every ServiceVersion's `knowledge_bindings[].knowledge_id` in Python
    rather than a SQL join. Acceptable at this PoC's data scale (see
    `routers/distributions.py::_known_revocations` for the same pattern with
    a `.limit(500)` guard); a production Registry would index this.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db,
        user,
        Permission.LIFECYCLE_READ,
        trace_id=trace_id,
        resource_type="ASSET_VERSION",
        resource_id=version_id,
    )
    if denial:
        return denial

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    all_service_versions = (
        await db.execute(select(ServiceVersion).limit(1000))
    ).scalars().all()

    matched_service_version_ids: list[str] = []
    services: list[ImpactServiceOut] = []
    for sv in all_service_versions:
        bindings = (sv.service_definition or {}).get("knowledge_bindings") or []
        if any(b.get("knowledge_id") == version_id for b in bindings):
            matched_service_version_ids.append(sv.id)
            service = (
                await db.execute(select(Service).where(Service.id == sv.service_id))
            ).scalar_one_or_none()
            services.append(
                ImpactServiceOut(
                    service_id=sv.service_id,
                    service_name=service.name if service else (sv.service_definition or {}).get(
                        "name", "-"
                    ),
                    service_version_id=sv.id,
                    version=sv.version,
                    status=sv.status,
                )
            )

    deployments: list[ImpactDeploymentOut] = []
    if matched_service_version_ids:
        deployment_rows = (
            await db.execute(
                select(ServiceDeployment).where(
                    ServiceDeployment.service_version_id.in_(matched_service_version_ids)
                )
            )
        ).scalars().all()
        revision_rows = (
            await db.execute(
                select(DeploymentRevision).where(
                    DeploymentRevision.service_version_id.in_(matched_service_version_ids)
                )
            )
        ).scalars().all()
        deployment_ids = {d.id for d in deployment_rows} | {r.deployment_id for r in revision_rows}
        if deployment_ids:
            all_deployments = (
                await db.execute(
                    select(ServiceDeployment).where(ServiceDeployment.id.in_(deployment_ids))
                )
            ).scalars().all()
            deployments = [
                ImpactDeploymentOut(deployment_id=d.id, slug=d.slug, status=d.status)
                for d in all_deployments
            ]

    distribution_roots: set[tuple[str, str]] = {("ASSET_VERSION", version_id)}
    for sv_id in matched_service_version_ids:
        distribution_roots.add(("SERVICE_VERSION", sv_id))

    distribution_requests: list[ImpactDistributionOut] = []
    for root_type, root_id in distribution_roots:
        rows = (
            await db.execute(
                select(DistributionRequest).where(
                    DistributionRequest.root_type == root_type,
                    DistributionRequest.root_id == root_id,
                )
            )
        ).scalars().all()
        distribution_requests.extend(
            ImpactDistributionOut(
                id=r.id, root_type=r.root_type, root_id=r.root_id, status=r.status
            )
            for r in rows
        )

    return AssetVersionImpactOut(
        version_id=version_id,
        services=services,
        service_deployments=deployments,
        distribution_requests=distribution_requests,
    )


# --- Audit ---


@router.get("/audit-events", response_model=AuditEventListResponse)
async def list_audit_events(
    resource_id: str | None = None,
    event_type: str | None = None,
    actor_id: str | None = None,
    date_from: datetime | None = Query(default=None, alias="from"),
    date_to: datetime | None = Query(default=None, alias="to"),
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AuditEventListResponse | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.AUDIT_READ, trace_id=trace_id, resource_type="AUDIT_EVENT"
    )
    if denial:
        return denial

    stmt = select(AuditEvent)
    if resource_id:
        stmt = stmt.where(AuditEvent.resource_id == resource_id)
    if event_type:
        stmt = stmt.where(AuditEvent.event_type == event_type)
    if actor_id:
        stmt = stmt.where(AuditEvent.actor_id == actor_id)
    if date_from:
        stmt = stmt.where(AuditEvent.timestamp >= date_from)
    if date_to:
        stmt = stmt.where(AuditEvent.timestamp <= date_to)

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = (
        stmt.offset((page - 1) * page_size)
        .limit(page_size)
        .order_by(AuditEvent.timestamp.desc(), AuditEvent.id)
    )
    events = (await db.execute(stmt)).scalars().all()

    items = [
        AuditEventOut(
            id=e.id,
            timestamp=e.timestamp,
            event_type=e.event_type,
            actor_type=e.actor_type,
            actor_id=e.actor_id,
            organization_id=e.organization_id,
            site_id=e.site_id,
            resource_type=e.resource_type,
            resource_id=e.resource_id,
            resource_version=e.resource_version,
            trace_id=e.trace_id,
            run_id=e.run_id,
            job_id=e.job_id,
            result=e.result,
            policy_id=e.policy_id,
            metadata=e.metadata_ or {},
        )
        for e in events
    ]
    return AuditEventListResponse(items=items, page=page, page_size=page_size, total=total)
