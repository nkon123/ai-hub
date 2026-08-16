"""Service Definition + Deployment publication router — M02.

Implements the "Knowledge 챗봇을 내부 URL로 게시" MVP flow:
  POST /api/v1/services                                  — save a Service Definition draft
  POST /api/v1/service-versions/{version_id}/validate     — publish-gate checks
  POST /api/v1/deployments                                — create a deployment (slug reservation)
  POST /api/v1/deployments/{deployment_id}/publish        — snapshot + activate
  GET  /api/v1/deployments/{deployment_id}                — detail
  GET  /api/v1/deployments                                — list
  GET  /api/v1/deployments/by-slug/{slug}                 — Hosted Runtime resolution (no auth)

Portal API never calls the model itself; publish only fixes an immutable
Service Definition + dependency snapshot and flips the deployment to ACTIVE.
Actual chat execution is done by the separate Hosted Agent Runtime (M05).
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime

from ai_asset_schemas.validator import SchemaType
from ai_asset_schemas.validator import ValidationError as SchemaValidationError
from ai_asset_schemas.validator import validate as validate_schema
from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from observability import get_trace_id
from security_policy import Permission, VersionStatus
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import get_db
from portal_api.models import (
    AssetVersion,
    DeploymentRevision,
    IndexingJob,
    Service,
    ServiceDeployment,
    ServiceVersion,
)
from portal_api.models.asset import Asset
from portal_api.rbac import require_permission
from portal_api.schemas import (
    ChatbotConfigOut,
    CreateDeploymentRequest,
    CreateServiceRequest,
    DeploymentBySlugOut,
    DeploymentListResponse,
    DeploymentOut,
    DeploymentRevisionOut,
    PublishJobResponseOut,
    ServiceDetailOut,
    ServiceListItemOut,
    ServiceListResponse,
    ServiceOut,
    ServiceVersionDetailOut,
    ServiceVersionOut,
    ServiceVersionSummaryOut,
    ValidationCheckOut,
    ValidationResultOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["services"])

SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$")
RESERVED_SLUGS = {
    "chat",
    "api",
    "admin",
    "new",
    "static",
    "health",
    "assets",
    "knowledge",
    "chatbots",
    "_next",
}


def _trace_id() -> str:
    # See portal_api.routers.assets._trace_id — same rationale. deployments.py
    # imports this same function rather than defining its own.
    return get_trace_id() or str(uuid.uuid4())


def _error(
    status_code: int, code: str, message: str, trace_id: str, details: dict | None = None
) -> JSONResponse:
    payload: dict = {"error": {"code": code, "message": message, "trace_id": trace_id}}
    if details:
        payload["error"]["details"] = details
    return JSONResponse(status_code=status_code, content=payload)


def _deployment_url(slug: str) -> str:
    return f"{settings.hosted_chat_base_url}/{slug}"


def _not_found(message: str, trace_id: str) -> JSONResponse:
    return _error(status.HTTP_404_NOT_FOUND, "RESOURCE_NOT_FOUND", message, trace_id)


# --- Service Definition ---


@router.post("/services", response_model=ServiceVersionOut, status_code=status.HTTP_201_CREATED)
async def create_service(
    body: CreateServiceRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> ServiceVersionOut | JSONResponse:
    trace_id = _trace_id()

    denial = await require_permission(
        db, user, Permission.SERVICE_CREATE, trace_id=trace_id, resource_type="SERVICE"
    )
    if denial:
        return denial

    try:
        validate_schema(body.service_definition, SchemaType.SERVICE)
    except SchemaValidationError as exc:
        logger.info("service.create.schema_invalid trace_id=%s", trace_id)
        return _error(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "Service Definition이 Schema를 통과하지 못했습니다.",
            trace_id,
            details={"errors": exc.errors[:10]},
        )

    new_version_string = body.service_definition.get("version", "1.0.0")

    if body.service_id:
        # 새 Service가 아니라 기존 Service의 새 버전. `POST
        # /deployments/{id}/revisions`(Update)가 요구하는 "같은 Service의 다른
        # Version"을 만드는 유일한 경로다.
        service = (
            await db.execute(select(Service).where(Service.id == body.service_id))
        ).scalar_one_or_none()
        if service is None:
            return _not_found("Service를 찾을 수 없습니다.", trace_id)

        duplicate = (
            await db.execute(
                select(ServiceVersion).where(
                    ServiceVersion.service_id == service.id,
                    ServiceVersion.version == new_version_string,
                )
            )
        ).scalar_one_or_none()
        if duplicate is not None:
            # 승인 Version을 수정하는 Update 코드를 만들지 않는다(CLAUDE.md
            # 코드 규칙) — 같은 버전 번호를 다시 제출하면 기존 행을 고치는
            # 대신 거부한다.
            return _error(
                status.HTTP_409_CONFLICT,
                "SERVICE_VERSION_EXISTS",
                f"이 Service에 {new_version_string} 버전이 이미 있습니다.",
                trace_id,
            )
    else:
        owner = body.service_definition.get("owner", {})
        service = Service(
            name=body.name,
            owner_org=owner.get("org", user.org),
            owner_creator_id=owner.get("creator_id", user.user_id),
        )
        db.add(service)
        await db.flush()

    version = ServiceVersion(
        service_id=service.id,
        version=new_version_string,
        status="DRAFT",
        service_definition=body.service_definition,
    )
    db.add(version)
    await db.commit()
    await db.refresh(version)

    logger.info(
        "service.create trace_id=%s service_id=%s version_id=%s", trace_id, service.id, version.id
    )
    await record_audit(
        db,
        event_type="SERVICE_VERSION_CREATED",
        actor=user,
        resource_type="SERVICE_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"service_id": service.id},
    )
    return ServiceVersionOut.model_validate(version)


@router.get("/services", response_model=ServiceListResponse)
async def list_services(
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> ServiceListResponse | JSONResponse:
    """P17 AI Service 목록 — paginated, newest Service first. Read-level
    access mirrors ASSET_READ (`Permission.SERVICE_READ` is granted to every
    role, same as `Permission.ASSET_READ`): §01-portal-and-distribution.md
    P17 lists its access level as `전체`."""
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.SERVICE_READ, trace_id=trace_id, resource_type="SERVICE"
    )
    if denial:
        return denial

    stmt = select(Service)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.offset((page - 1) * page_size).limit(page_size).order_by(Service.created_at.desc())
    services = (await db.execute(stmt)).scalars().all()

    items: list[ServiceListItemOut] = []
    for svc in services:
        versions_stmt = (
            select(ServiceVersion)
            .where(ServiceVersion.service_id == svc.id)
            .order_by(ServiceVersion.created_at.desc())
        )
        versions = (await db.execute(versions_stmt)).scalars().all()
        latest = versions[0] if versions else None
        items.append(
            ServiceListItemOut(
                id=svc.id,
                name=svc.name,
                owner_org=svc.owner_org,
                owner_creator_id=svc.owner_creator_id,
                created_at=svc.created_at,
                version_count=len(versions),
                latest_version=(
                    ServiceVersionSummaryOut.model_validate(latest) if latest else None
                ),
            )
        )

    return ServiceListResponse(items=items, page=page, page_size=page_size, total=total)


@router.get("/services/{service_id}", response_model=ServiceDetailOut)
async def get_service(
    service_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> ServiceDetailOut | JSONResponse:
    """Service identity + full version history (newest first) — backs P19
    '버전과 변경이력'. Same `SERVICE_READ` gate as `list_services`."""
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.SERVICE_READ,
        trace_id=trace_id, resource_type="SERVICE", resource_id=service_id,
    )
    if denial:
        return denial

    service = (
        await db.execute(select(Service).where(Service.id == service_id))
    ).scalar_one_or_none()
    if service is None:
        return _not_found("Service를 찾을 수 없습니다.", trace_id)

    versions_stmt = (
        select(ServiceVersion)
        .where(ServiceVersion.service_id == service_id)
        .order_by(ServiceVersion.created_at.desc())
    )
    versions = (await db.execute(versions_stmt)).scalars().all()

    return ServiceDetailOut(
        id=service.id,
        name=service.name,
        owner_org=service.owner_org,
        owner_creator_id=service.owner_creator_id,
        created_at=service.created_at,
        versions=[ServiceVersionSummaryOut.model_validate(v) for v in versions],
    )


@router.get("/service-versions/{version_id}", response_model=ServiceVersionDetailOut)
async def get_service_version(
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> ServiceVersionDetailOut | JSONResponse:
    """P19 Service 상세 — the full ServiceVersion (`service_definition`
    included) plus its parent Service's identity, so the UI can resolve
    owner/name without a second round trip."""
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.SERVICE_READ,
        trace_id=trace_id, resource_type="SERVICE_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    version = (
        await db.execute(select(ServiceVersion).where(ServiceVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return _not_found("Service Version을 찾을 수 없습니다.", trace_id)

    service = (
        await db.execute(select(Service).where(Service.id == version.service_id))
    ).scalar_one_or_none()

    return ServiceVersionDetailOut(
        id=version.id,
        service_id=version.service_id,
        version=version.version,
        status=version.status,
        service_definition=version.service_definition,
        created_at=version.created_at,
        approved_at=version.approved_at,
        service=ServiceOut.model_validate(service) if service else None,
    )


async def _run_validation(
    service_definition: dict, db: AsyncSession, version_status: str
) -> ValidationResultOut:
    """Publish-gate checks shared by /validate and /publish.

    Checks (each independent — all must pass for `passed=True`):
      a. service_definition passes the SERVICE json schema
      b. every knowledge_bindings[].knowledge_id resolves to an existing AssetVersion
      c. that AssetVersion has a COMPLETED IndexingJob (the real 게시 Gate)
      d. model_policy.model_alias is non-empty
      e. (D-041 후속/D-063) the ServiceVersion itself has passed its own
         TECHNICAL→SECURITY→RELEASE 검토 체인 — only *blocking* (passed=False)
         when `settings.require_service_version_approval` is True. When that
         setting is False (this PoC's default), the check is still reported
         (never hidden) but always passes, so an unreviewed Service's status
         stays visible instead of silently looking reviewed.
    """
    checks: list[ValidationCheckOut] = []

    try:
        validate_schema(service_definition, SchemaType.SERVICE)
        checks.append(
            ValidationCheckOut(
                name="service_definition_schema",
                passed=True,
                message="Schema 검증 통과",
            )
        )
    except SchemaValidationError as exc:
        checks.append(
            ValidationCheckOut(
                name="service_definition_schema",
                passed=False,
                message=str(exc),
                code="VALIDATION_ERROR",
            )
        )

    bindings = service_definition.get("knowledge_bindings") or []
    if not bindings:
        checks.append(
            ValidationCheckOut(
                name="knowledge_binding_resolved",
                passed=False,
                message="연결된 Knowledge가 없습니다.",
                code="CHATBOT_KNOWLEDGE_REQUIRED",
            )
        )
        checks.append(
            ValidationCheckOut(
                name="knowledge_indexed",
                passed=False,
                message="연결된 Knowledge가 없어 색인 상태를 확인할 수 없습니다.",
                code="CHATBOT_KNOWLEDGE_REQUIRED",
            )
        )
    else:
        missing_ids: list[str] = []
        resolved: dict[str, AssetVersion] = {}
        for binding in bindings:
            knowledge_id = binding.get("knowledge_id")
            asset_version = (
                await db.execute(select(AssetVersion).where(AssetVersion.id == knowledge_id))
            ).scalar_one_or_none()
            if asset_version is None:
                missing_ids.append(str(knowledge_id))
            else:
                resolved[knowledge_id] = asset_version

        if missing_ids:
            checks.append(
                ValidationCheckOut(
                    name="knowledge_binding_resolved",
                    passed=False,
                    message=f"지식 자산 버전을 찾을 수 없습니다: {', '.join(missing_ids)}",
                    code="CHATBOT_KNOWLEDGE_REQUIRED",
                )
            )
        else:
            checks.append(
                ValidationCheckOut(
                    name="knowledge_binding_resolved",
                    passed=True,
                    message="Knowledge 참조 확인 완료",
                )
            )

        not_indexed: list[str] = []
        for knowledge_id, asset_version in resolved.items():
            job_stmt = (
                select(IndexingJob)
                .where(
                    IndexingJob.asset_version_id == asset_version.id,
                    IndexingJob.status == "COMPLETED",
                )
                .limit(1)
            )
            job = (await db.execute(job_stmt)).scalar_one_or_none()
            if job is None:
                not_indexed.append(knowledge_id)

        if not resolved:
            checks.append(
                ValidationCheckOut(
                    name="knowledge_indexed",
                    passed=False,
                    message="확인할 수 있는 Knowledge 버전이 없습니다.",
                    code="CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE",
                )
            )
        elif not_indexed:
            not_indexed_str = ", ".join(not_indexed)
            checks.append(
                ValidationCheckOut(
                    name="knowledge_indexed",
                    passed=False,
                    message=f"Knowledge 색인이 완료되지 않아 게시할 수 없습니다: {not_indexed_str}",
                    code="CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE",
                )
            )
        else:
            checks.append(
                ValidationCheckOut(
                    name="knowledge_indexed",
                    passed=True,
                    message="Knowledge 색인 완료 확인",
                )
            )

        # 10-hosted-chatbot-publication.md §5 게시 가능: "APPROVED Knowledge
        # Version만 허용" — Preview stays open to VALIDATED-or-APPROVED
        # (agent-runtime's /local/v1/runs is untouched), but this shared
        # publish-gate check requires APPROVED before a deployment may go
        # live.
        if resolved:
            not_approved = [
                knowledge_id
                for knowledge_id, asset_version in resolved.items()
                if asset_version.status != VersionStatus.APPROVED.value
            ]
            if not_approved:
                not_approved_str = ", ".join(not_approved)
                checks.append(
                    ValidationCheckOut(
                        name="knowledge_version_approved",
                        passed=False,
                        message=(
                            "승인되지 않은 Knowledge 버전은 게시할 수 없습니다. "
                            f"먼저 검토·승인을 완료하세요: {not_approved_str}"
                        ),
                        code="CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE",
                    )
                )
            else:
                checks.append(
                    ValidationCheckOut(
                        name="knowledge_version_approved",
                        passed=True,
                        message="Knowledge 버전 승인 상태 확인 완료",
                    )
                )

    model_alias = (service_definition.get("model_policy") or {}).get("model_alias")
    if model_alias:
        checks.append(
            ValidationCheckOut(
                name="model_alias_present",
                passed=True,
                message="모델 정책 확인 완료",
            )
        )
    else:
        checks.append(
            ValidationCheckOut(
                name="model_alias_present",
                passed=False,
                message="model_policy.model_alias가 비어 있습니다.",
                code="VALIDATION_ERROR",
            )
        )

    # D-041 후속 / open-decisions.md D-063: ServiceVersion 자체 검토 체인의
    # 게시 Gate. 기본값(설정 False)에서는 절대 게시를 막지 않지만, 검토
    # 상태를 화면과 응답에서 숨기지 않는다 — "미검토인데 검토된 것처럼
    # 보이는" 상태를 만들지 않기 위함이다.
    review_approved = version_status == VersionStatus.APPROVED.value
    if settings.require_service_version_approval:
        checks.append(
            ValidationCheckOut(
                name="service_version_review_status",
                passed=review_approved,
                message=(
                    "Service Version 검토 승인 확인 완료"
                    if review_approved
                    else (
                        "Service Version이 검토·승인되지 않아 게시할 수 없습니다. "
                        f"(현재 상태: {version_status}) 검토 요청 후 TECHNICAL→"
                        "SECURITY→RELEASE 승인을 완료하세요."
                    )
                ),
                code=None if review_approved else "DEPLOYMENT_VALIDATION_FAILED",
            )
        )
    else:
        checks.append(
            ValidationCheckOut(
                name="service_version_review_status",
                passed=True,
                message=(
                    "Service Version 검토 승인 확인 완료"
                    if review_approved
                    else (
                        "Service Version이 아직 검토·승인되지 않았습니다. "
                        f"(현재 상태: {version_status}) PoC 설정상 게시가 허용되지만, "
                        "운영 환경에서는 승인 후 게시하도록 설정을 켜야 합니다."
                    )
                ),
            )
        )

    return ValidationResultOut(passed=all(c.passed for c in checks), checks=checks)


@router.post("/service-versions/{version_id}/validate", response_model=ValidationResultOut)
async def validate_service_version(
    version_id: str,
    db: AsyncSession = Depends(get_db),
    _user: UserContext = Depends(get_current_user),
) -> ValidationResultOut | JSONResponse:
    trace_id = _trace_id()
    version = (
        await db.execute(select(ServiceVersion).where(ServiceVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return _not_found("Service Version을 찾을 수 없습니다.", trace_id)

    return await _run_validation(version.service_definition, db, version.status)


# --- Deployment ---


@router.post("/deployments", response_model=DeploymentOut, status_code=status.HTTP_201_CREATED)
async def create_deployment(
    body: CreateDeploymentRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DeploymentOut | JSONResponse:
    trace_id = _trace_id()

    denial = await require_permission(
        db, user, Permission.DEPLOYMENT_CREATE, trace_id=trace_id, resource_type="DEPLOYMENT"
    )
    if denial:
        return denial

    version = (
        await db.execute(select(ServiceVersion).where(ServiceVersion.id == body.service_version_id))
    ).scalar_one_or_none()
    if version is None:
        return _not_found("Service Version을 찾을 수 없습니다.", trace_id)

    if not SLUG_PATTERN.match(body.slug):
        return _error(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "Slug는 소문자, 숫자, 하이픈만 사용하는 5~64자여야 합니다.",
            trace_id,
        )
    if body.slug in RESERVED_SLUGS:
        return _error(
            status.HTTP_409_CONFLICT,
            "DEPLOYMENT_SLUG_CONFLICT",
            "예약된 Slug는 사용할 수 없습니다.",
            trace_id,
            details={"slug": body.slug},
        )

    existing = (
        await db.execute(select(ServiceDeployment).where(ServiceDeployment.slug == body.slug))
    ).scalar_one_or_none()
    if existing is not None:
        return _error(
            status.HTTP_409_CONFLICT,
            "DEPLOYMENT_SLUG_CONFLICT",
            "이미 사용 중인 Slug입니다.",
            trace_id,
            details={"slug": body.slug},
        )

    deployment = ServiceDeployment(
        service_id=version.service_id,
        service_version_id=version.id,
        slug=body.slug,
        environment=body.environment,
        access_policy=body.access_policy,
        status="PENDING",
        target_orgs=body.target_orgs,
        target_roles=body.target_roles,
        created_by=user.user_id,
    )
    db.add(deployment)
    await db.commit()
    await db.refresh(deployment)

    logger.info(
        "deployment.create trace_id=%s deployment_id=%s slug=%s",
        trace_id,
        deployment.id,
        deployment.slug,
    )
    return DeploymentOut(
        id=deployment.id,
        service_id=deployment.service_id,
        service_version_id=deployment.service_version_id,
        slug=deployment.slug,
        environment=deployment.environment,
        access_policy=deployment.access_policy,
        status=deployment.status,
        target_orgs=deployment.target_orgs,
        target_roles=deployment.target_roles,
        active_revision_id=deployment.active_revision_id,
        deployment_url=_deployment_url(deployment.slug),
        created_by=deployment.created_by,
        created_at=deployment.created_at,
        updated_at=deployment.updated_at,
    )


@router.post(
    "/deployments/{deployment_id}/publish",
    response_model=PublishJobResponseOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def publish_deployment(
    deployment_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> PublishJobResponseOut | JSONResponse:
    trace_id = _trace_id()

    # NOTE(open-decisions D-040): publishing now enforces the M11 policy
    # package's DEPLOYMENT_PUBLISH permission (RELEASE_MANAGER/ADMIN only —
    # CREATOR can no longer self-publish, tightened from the prior PoC
    # default). The ServiceVersion's own 검토/승인(REVIEW) 상태 전이 gate (as
    # opposed to the Knowledge it depends on, checked below via
    # `_run_validation`) is now implemented (D-041 후속) inside
    # `_run_validation`'s `service_version_review_status` check — enforced
    # only when `settings.require_service_version_approval` is True (default
    # False for this PoC; see open-decisions.md D-063).
    denial = await require_permission(
        db, user, Permission.DEPLOYMENT_PUBLISH, trace_id=trace_id,
        resource_type="DEPLOYMENT", resource_id=deployment_id,
    )
    if denial:
        return denial

    deployment = (
        await db.execute(select(ServiceDeployment).where(ServiceDeployment.id == deployment_id))
    ).scalar_one_or_none()
    if deployment is None:
        return _not_found("Deployment를 찾을 수 없습니다.", trace_id)

    # §8: RETIRED is terminal. Without this guard a re-publish would revive a
    # retired chatbot at its old URL — the one thing retiring is supposed to
    # make impossible.
    if deployment.status == "RETIRED":
        return _error(
            status.HTTP_409_CONFLICT,
            "DEPLOYMENT_RETIRED",
            "폐기된 Deployment는 다시 게시할 수 없습니다. 새 Deployment를 만드세요.",
            trace_id,
        )

    version = (
        await db.execute(
            select(ServiceVersion).where(ServiceVersion.id == deployment.service_version_id)
        )
    ).scalar_one_or_none()
    if version is None:
        return _not_found("Service Version을 찾을 수 없습니다.", trace_id)

    validation = await _run_validation(version.service_definition, db, version.status)
    if not validation.passed:
        return _error(
            status.HTTP_400_BAD_REQUEST,
            "DEPLOYMENT_VALIDATION_FAILED",
            "게시 Gate 검증에 실패했습니다.",
            trace_id,
            details={"checks": [c.model_dump() for c in validation.checks]},
        )

    revision = await _activate_new_revision(deployment, version, user.user_id, db)
    deployment.status = "ACTIVE"
    await db.commit()

    logger.info(
        "deployment.publish trace_id=%s deployment_id=%s revision_id=%s slug=%s",
        trace_id,
        deployment.id,
        revision.id,
        deployment.slug,
    )
    await record_audit(
        db,
        event_type="DEPLOYMENT_PUBLISHED",
        actor=user,
        resource_type="DEPLOYMENT",
        resource_id=deployment.id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"revision_id": revision.id, "slug": deployment.slug},
    )
    return PublishJobResponseOut(
        job_id=revision.id, deployment_url=_deployment_url(deployment.slug)
    )


async def _build_dependency_snapshot(version: ServiceVersion, db: AsyncSession) -> dict:
    """§11.2 `resolved_dependency_snapshot` — the immutable record of exactly
    which asset versions a revision serves. Resolved once, at activation
    time, so a later change to the Knowledge asset cannot retroactively
    alter what a published revision claims to have shipped.

    Shared by `/publish` and `/deployments/{id}/revisions` (update): both
    activate a revision, and a snapshot assembled two different ways would
    make the two paths silently divergent.
    """
    knowledge_snapshot: list[dict] = []
    for binding in version.service_definition.get("knowledge_bindings") or []:
        knowledge_id = binding.get("knowledge_id")
        asset_version = (
            await db.execute(select(AssetVersion).where(AssetVersion.id == knowledge_id))
        ).scalar_one_or_none()
        if asset_version is None:
            continue
        asset = (
            await db.execute(select(Asset).where(Asset.id == asset_version.asset_id))
        ).scalar_one_or_none()
        job = (
            await db.execute(
                select(IndexingJob)
                .where(
                    IndexingJob.asset_version_id == asset_version.id,
                    IndexingJob.status == "COMPLETED",
                )
                .order_by(IndexingJob.completed_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        knowledge_snapshot.append(
            {
                "knowledge_id": asset_version.id,
                "asset_id": asset_version.asset_id,
                "asset_name": asset.name if asset else None,
                "version": asset_version.version,
                "index_path": job.index_path if job else None,
                "chunk_count": job.chunk_count if job else None,
            }
        )

    return {
        "service_version_id": version.id,
        "service_definition": version.service_definition,
        "knowledge": knowledge_snapshot,
        "model_alias": (version.service_definition.get("model_policy") or {}).get("model_alias"),
        # D-034: `agent_ref`/`prompt_bindings` carry *manifest* ids, which the
        # Hosted runtime cannot resolve — `resolve_registry_agent_config`
        # needs Portal AssetVersion ids. Resolving that mapping here, once at
        # activation time, is the same discipline the knowledge list above
        # follows and is what makes the snapshot self-sufficient.
        "registry_agent": await _resolve_registry_asset_version(
            version.service_definition.get("agent_ref") or {}, "agent", db
        ),
        "registry_prompt": await _resolve_registry_asset_version(
            _first_prompt_ref(version.service_definition), "prompt", db
        ),
        "published_at": datetime.now(UTC).isoformat(),
    }


def _first_prompt_ref(service_definition: dict) -> dict:
    """`prompt_bindings[0]` normalized to the `{id, version}` shape
    `_resolve_registry_asset_version` expects. Only the first binding is
    resolved: `resolve_registry_agent_config` takes exactly one Agent+Prompt
    pair, so a second binding has nowhere to go — better to resolve nothing
    for it than to invent a pairing the runtime cannot honour."""
    bindings = service_definition.get("prompt_bindings") or []
    if not bindings or not isinstance(bindings[0], dict):
        return {}
    return {"id": bindings[0].get("prompt_id"), "version": bindings[0].get("prompt_version")}


async def _resolve_registry_asset_version(
    ref: dict, asset_type: str, db: AsyncSession
) -> dict | None:
    """Find the APPROVED AssetVersion whose *manifest* declares `ref["id"]`
    and `ref["version"]`, or None.

    None is the normal, expected outcome for the two standard Agents: their
    manifests live only in `services/agent-runtime/config/` and were never
    registered as Portal assets, so no row can match. That is exactly why a
    miss must not fail the publish — the four already-published chatbots run
    on those standard Agents, and making this lookup mandatory would break
    every one of them. A miss simply means "not a Registry asset", and the
    Hosted runtime falls back to its standard config.

    Unapproved matches are also treated as a miss rather than an error: the
    publish Gate is what decides whether a Service Version may go live, and
    silently shipping a DRAFT Agent would be worse than falling back.
    """
    ref_id = ref.get("id")
    ref_version = ref.get("version")
    if not isinstance(ref_id, str) or not isinstance(ref_version, str):
        return None

    candidates = (
        await db.execute(
            select(AssetVersion, Asset)
            .join(Asset, Asset.id == AssetVersion.asset_id)
            .where(Asset.type == asset_type, AssetVersion.status == "APPROVED")
        )
    ).all()

    for asset_version, asset in candidates:
        manifest = asset_version.manifest or {}
        if manifest.get("id") == ref_id and manifest.get("version") == ref_version:
            return {
                "asset_version_id": asset_version.id,
                "asset_id": asset.id,
                "asset_name": asset.name,
                "manifest_id": ref_id,
                "version": ref_version,
            }
    return None


async def _activate_new_revision(
    deployment: ServiceDeployment,
    version: ServiceVersion,
    actor_id: str,
    db: AsyncSession,
) -> DeploymentRevision:
    """Create revision N+1 for `version`, make it ACTIVE, and demote the
    previously active one to SUPERSEDED. Does not commit — the caller owns
    the transaction, which is what makes an update atomic: the deployment is
    never observably half-switched (see §8's UPDATING state, deliberately
    absent from `deployment.schema.json`).

    Does NOT set `deployment.status` — publish and update reach this point
    from different states and each decides its own resulting status.
    """
    activated_at = datetime.now(UTC)
    snapshot = await _build_dependency_snapshot(version, db)

    max_revision = (
        await db.execute(
            select(func.max(DeploymentRevision.revision_number)).where(
                DeploymentRevision.deployment_id == deployment.id
            )
        )
    ).scalar_one()
    revision_number = (max_revision or 0) + 1

    # Bookkeeping for rollback (§8, §11.2): the revision that was ACTIVE
    # before this publish must transition to SUPERSEDED so
    # `/rollback` has a meaningful, ordered history to restore from.
    previous_active_revision_id = deployment.active_revision_id

    revision = DeploymentRevision(
        deployment_id=deployment.id,
        revision_number=revision_number,
        service_version_id=version.id,
        resolved_dependency_snapshot=snapshot,
        status="ACTIVE",
        created_by=actor_id,
        activated_at=activated_at,
    )
    db.add(revision)
    await db.flush()

    if previous_active_revision_id:
        previous_revision = (
            await db.execute(
                select(DeploymentRevision).where(
                    DeploymentRevision.id == previous_active_revision_id
                )
            )
        ).scalar_one_or_none()
        if previous_revision is not None:
            previous_revision.status = "SUPERSEDED"

    revision.publish_job_id = revision.id  # PoC: publish is synchronous, job_id == revision id
    deployment.active_revision_id = revision.id
    deployment.service_version_id = version.id
    return revision


async def _deployment_out(deployment: ServiceDeployment, db: AsyncSession) -> DeploymentOut:
    active_revision_out = None
    if deployment.active_revision_id:
        revision = (
            await db.execute(
                select(DeploymentRevision).where(
                    DeploymentRevision.id == deployment.active_revision_id
                )
            )
        ).scalar_one_or_none()
        if revision is not None:
            active_revision_out = DeploymentRevisionOut.model_validate(revision)

    return DeploymentOut(
        id=deployment.id,
        service_id=deployment.service_id,
        service_version_id=deployment.service_version_id,
        slug=deployment.slug,
        environment=deployment.environment,
        access_policy=deployment.access_policy,
        status=deployment.status,
        target_orgs=deployment.target_orgs,
        target_roles=deployment.target_roles,
        active_revision_id=deployment.active_revision_id,
        deployment_url=_deployment_url(deployment.slug),
        created_by=deployment.created_by,
        created_at=deployment.created_at,
        updated_at=deployment.updated_at,
        active_revision=active_revision_out,
        suspended_by=deployment.suspended_by,
        suspended_at=deployment.suspended_at,
        suspend_reason=deployment.suspend_reason,
        retired_by=deployment.retired_by,
        retired_at=deployment.retired_at,
        retire_reason=deployment.retire_reason,
    )


@router.get("/deployments/by-slug/{slug}", response_model=DeploymentBySlugOut)
async def get_deployment_by_slug(
    slug: str,
    db: AsyncSession = Depends(get_db),
) -> DeploymentBySlugOut | JSONResponse:
    """Chatbot-facing resolution endpoint for the Hosted Chat Runtime (M05).

    Intentionally has NO `get_current_user` dependency: the Hosted Agent
    Runtime calls this server-to-server, and per D-035 agent-runtime itself
    has no authentication in this PoC. Access control for the end user is
    enforced by the Hosted Runtime / chat session layer, not here.

    Per spec §9 ("Not Found: Slug 존재 여부를 구분하지 않는 안전한 메시지"), a
    missing slug and a non-ACTIVE slug return the exact same status, code,
    and message so a caller cannot distinguish "never existed" from
    "exists but suspended/retired".
    """
    trace_id = _trace_id()

    deployment = (
        await db.execute(select(ServiceDeployment).where(ServiceDeployment.slug == slug))
    ).scalar_one_or_none()

    if deployment is None or deployment.status != "ACTIVE" or deployment.active_revision_id is None:
        return _error(
            status.HTTP_404_NOT_FOUND,
            "DEPLOYMENT_NOT_ACTIVE",
            "요청하신 챗봇을 찾을 수 없거나 현재 사용할 수 없습니다.",
            trace_id,
        )

    revision = (
        await db.execute(
            select(DeploymentRevision).where(DeploymentRevision.id == deployment.active_revision_id)
        )
    ).scalar_one_or_none()
    if revision is None:
        return _error(
            status.HTTP_404_NOT_FOUND,
            "DEPLOYMENT_NOT_ACTIVE",
            "요청하신 챗봇을 찾을 수 없거나 현재 사용할 수 없습니다.",
            trace_id,
        )

    snapshot = revision.resolved_dependency_snapshot or {}
    service_definition = snapshot.get("service_definition") or {}
    chatbot_config = service_definition.get("chatbot_config") or {}
    knowledge_list = snapshot.get("knowledge") or []
    primary_knowledge_id = knowledge_list[0]["knowledge_id"] if knowledge_list else None
    registry_agent = snapshot.get("registry_agent") or None
    registry_prompt = snapshot.get("registry_prompt") or None

    return DeploymentBySlugOut(
        deployment_id=deployment.id,
        slug=deployment.slug,
        status=deployment.status,
        name=service_definition.get("name", deployment.slug),
        chatbot_config=ChatbotConfigOut(
            welcome_message=chatbot_config.get("welcome_message"),
            suggested_questions=chatbot_config.get("suggested_questions", []),
            citation_display=chatbot_config.get("citation_display", True),
        ),
        active_revision_id=deployment.active_revision_id,
        knowledge_id=primary_knowledge_id,
        model_alias=snapshot.get("model_alias"),
        # D-034: both ids or neither. agent-runtime's `resolve_registry_agent_config`
        # takes an Agent+Prompt *pair*; handing it a half pair would make it
        # fail per message at chat time instead of here, so a snapshot that
        # resolved only one of the two is reported as neither — the Hosted
        # runtime then uses its standard config, exactly as before D-034.
        registry_agent_version_id=(
            registry_agent.get("asset_version_id")
            if registry_agent and registry_prompt
            else None
        ),
        registry_prompt_version_id=(
            registry_prompt.get("asset_version_id")
            if registry_agent and registry_prompt
            else None
        ),
    )


@router.get("/deployments/{deployment_id}", response_model=DeploymentOut)
async def get_deployment(
    deployment_id: str,
    db: AsyncSession = Depends(get_db),
    _user: UserContext = Depends(get_current_user),
) -> DeploymentOut | JSONResponse:
    trace_id = _trace_id()
    deployment = (
        await db.execute(select(ServiceDeployment).where(ServiceDeployment.id == deployment_id))
    ).scalar_one_or_none()
    if deployment is None:
        return _not_found("Deployment를 찾을 수 없습니다.", trace_id)
    return await _deployment_out(deployment, db)


@router.get("/deployments", response_model=DeploymentListResponse)
async def list_deployments(
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    _user: UserContext = Depends(get_current_user),
) -> DeploymentListResponse:
    stmt = select(ServiceDeployment)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = (
        stmt.offset((page - 1) * page_size)
        .limit(page_size)
        .order_by(ServiceDeployment.created_at.desc())
    )
    deployments = (await db.execute(stmt)).scalars().all()

    items = [await _deployment_out(d, db) for d in deployments]
    return DeploymentListResponse(items=items, page=page, page_size=page_size, total=total)
