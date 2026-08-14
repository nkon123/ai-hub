"""Distribution / Offline Bundle router — M02.

  POST /api/v1/distributions              — request an Offline Bundle
  GET  /api/v1/distributions/{id}         — status/stage/error/bundle metadata
  GET  /api/v1/distributions/{id}/download — stream the finished ZIP

Mirrors `_trigger_indexing` in `routers/assets.py` exactly, per the task
brief: portal-api (M02) owns the `DistributionRequest` record, RBAC, and
audit; it resolves every dependency from its own Registry tables (Asset/
AssetVersion/ServiceVersion/DeploymentRevision) and hands the fully-resolved
payload to distribution-service (M03) over HTTP as a background task, then
persists the result. distribution-service has no DB connection of its own —
see `services/distribution-service/src/distribution_service/contracts.py`.

Root approval gates (01-portal-and-distribution.md §3.3 "승인되지 않은
버전은 다운로드에 노출하지 않는다"):
  - ASSET_VERSION root: `AssetVersion.status == APPROVED`.
  - SERVICE_VERSION root: ServiceVersion has no approval workflow yet
    (D-041 — its `status` never leaves DRAFT), so "승인됨" is operationalized
    as "has at least one DeploymentRevision" (i.e. it has been published at
    least once) — the resolved_dependency_snapshot from that Revision is
    then the pinned, immutable source of truth for what gets bundled (no
    "최신 버전 자동 선택", per §3.3). Recorded as open-decisions.md D-044.

ONLINE mode is explicitly out of scope for this task (`_trigger_indexing`
equivalent doesn't exist yet for single-file downloads) and is rejected with
a clear Korean "미구현" message rather than silently doing nothing.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse
from observability import get_trace_id
from security_policy import Permission, VersionStatus
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import AsyncSessionLocal, get_db
from portal_api.errors import error_response, not_found
from portal_api.knowledge_readiness import (
    distribution_readiness_checks,
    first_failing_check,
    is_ready,
    latest_indexing_job,
)
from portal_api.models import (
    Asset,
    AssetVersion,
    AssetVersionRevocation,
    AuditEvent,
    DeploymentRevision,
    DistributionRequest,
    Service,
    ServiceVersion,
)
from portal_api.models.revocation import effective_filter
from portal_api.rbac import require_permission
from portal_api.schemas import (
    CreateDistributionRequest,
    CreateDistributionResponseOut,
    DistributionListResponse,
    DistributionRequestOut,
    DownloadHistoryEntryOut,
    DownloadHistoryListResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/distributions", tags=["distributions"])

BundleCaller = Callable[[dict], Awaitable[dict]]
SessionFactory = Callable[[], AsyncSession]


def _trace_id() -> str:
    # See portal_api.routers.assets._trace_id — same rationale.
    return get_trace_id() or str(uuid.uuid4())


def _client_ip(request: Request) -> str | None:
    """P13 "Client IP ... 의 최소 감사값" — minimal audit-only capture.

    Recorded *only* into the `BUNDLE_DOWNLOADED`/download-scope-denial
    `AuditEvent.metadata` (see call sites in `download_distribution`), never
    into application logs and never onto any other event type. No
    User-Agent/device fingerprinting is added — CLAUDE.md forbids storing
    more than the minimum in logs, and the spec explicitly asks for IP *or*
    device info at a minimum, not both. See open-decisions.md D-064.
    """
    return request.client.host if request.client else None


async def _call_distribution_service_http(payload: dict) -> dict:
    async with httpx.AsyncClient(timeout=600) as client:
        resp = await client.post(
            f"{settings.distribution_service_url}/bundle/v1/jobs", json=payload
        )
        resp.raise_for_status()
        return resp.json()


def get_distribution_caller() -> BundleCaller:
    """FastAPI dependency seam — overridden in integration tests
    (`app.dependency_overrides[get_distribution_caller]`) so the test suite
    never needs a real distribution-service process running."""
    return _call_distribution_service_http


def get_session_factory() -> SessionFactory:
    """FastAPI dependency seam for the background task's own DB session.

    The background task runs *after* the request's `Depends(get_db)`
    session has already been torn down, so it must open its own session —
    and it must go through this seam (not import `AsyncSessionLocal`
    directly) so integration tests can override it with their isolated
    in-memory `session_factory` fixture instead of the real
    `settings.database_url` engine (mirrors `get_distribution_caller`).
    """
    return AsyncSessionLocal


async def _known_revocations(db: AsyncSession) -> list[dict]:
    """D-017: system-wide SUSPENDED/DEPRECATED/RETIRED AssetVersions known
    at build time, broader than just this bundle's resolved items."""
    stmt = (
        select(AssetVersion, Asset)
        .join(Asset, Asset.id == AssetVersion.asset_id)
        .where(AssetVersion.status.in_(["SUSPENDED", "DEPRECATED", "RETIRED"]))
        .limit(500)
    )
    rows = (await db.execute(stmt)).all()
    return [
        {
            "asset_id": asset.id,
            "asset_name": asset.name,
            "asset_version_id": version.id,
            "version": version.version,
            "status": version.status,
        }
        for version, asset in rows
    ]


async def _effective_revoked_version_ids(db: AsyncSession) -> set[str]:
    """P16 긴급 Revocation — AssetVersion ids with an *effective*
    (`effective_at <= now()`) row in `asset_version_revocations`, regardless
    of lifecycle status (orthogonal to `_known_revocations`, which is
    SUSPENDED/DEPRECATED/RETIRED status only). Used to set `revoked=True` on
    outgoing `BundleJobRequestItem`s so distribution-service (M03) — which
    has no DB connection — can refuse to package them (`resolver.py`'s
    `AssetVersionRevokedError` -> `ASSET_VERSION_REVOKED`). Filters through
    `effective_filter` (`models/revocation.py`) — the shared predicate also
    used by `routers.assets._attach_active_revocations` (D-072) — so the
    two never drift apart on what "effective" means."""
    stmt = select(AssetVersionRevocation.version_id).where(effective_filter())
    return set((await db.execute(stmt)).scalars().all())


async def _has_effective_revocation(db: AsyncSession, version_id: str) -> bool:
    stmt = select(AssetVersionRevocation.id).where(
        AssetVersionRevocation.version_id == version_id,
        effective_filter(),
    )
    return (await db.execute(stmt.limit(1))).scalar_one_or_none() is not None


async def _build_asset_version_root_payload(
    db: AsyncSession, version: AssetVersion, asset: Asset
) -> tuple[list[dict], dict | None]:
    index_path = None
    chunk_count = None
    if asset.type == "knowledge":
        from portal_api.models import IndexingJob

        job = (
            await db.execute(
                select(IndexingJob)
                .where(
                    IndexingJob.asset_version_id == version.id,
                    IndexingJob.status == "COMPLETED",
                )
                .order_by(IndexingJob.completed_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if job:
            index_path = job.index_path
            chunk_count = job.chunk_count

    item = {
        "asset_id": asset.id,
        "asset_type": asset.type,
        "asset_name": asset.name,
        "role": "root",
        "required": True,
        "asset_version_id": version.id,
        "version": version.version,
        "status": version.status,
        "manifest": version.manifest,
        "manifest_hash": version.manifest_hash,
        "storage_path": version.storage_path,
        "index_path": index_path,
        "chunk_count": chunk_count,
    }
    return [item], None


async def _build_service_version_root_payload(
    db: AsyncSession, version: ServiceVersion
) -> tuple[list[dict], dict] | None:
    """Returns (items, service_definition), or None if the ServiceVersion
    has never been published (see module docstring / D-044)."""
    revision = (
        await db.execute(
            select(DeploymentRevision)
            .where(DeploymentRevision.service_version_id == version.id)
            .order_by(DeploymentRevision.revision_number.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if revision is None:
        return None

    snapshot = revision.resolved_dependency_snapshot or {}
    service_definition = snapshot.get("service_definition") or version.service_definition

    items: list[dict] = [
        {
            "asset_id": version.service_id,
            "asset_type": "service",
            "asset_name": service_definition.get("name"),
            "role": "root",
            "required": True,
            "asset_version_id": version.id,
            "version": version.version,
            "status": version.status,
            "manifest": None,
            "manifest_hash": None,
            "storage_path": None,
            "index_path": None,
            "chunk_count": None,
        }
    ]

    for k in snapshot.get("knowledge") or []:
        knowledge_version = (
            await db.execute(select(AssetVersion).where(AssetVersion.id == k.get("knowledge_id")))
        ).scalar_one_or_none()
        if knowledge_version is None:
            items.append(
                {
                    "asset_id": k.get("asset_id"),
                    "asset_type": "knowledge",
                    "asset_name": k.get("asset_name"),
                    "role": "knowledge",
                    "required": True,
                    "asset_version_id": k.get("knowledge_id"),
                    "version": k.get("version"),
                    "status": "NOT_FOUND",
                    "manifest": None,
                    "manifest_hash": None,
                    "storage_path": None,
                    "index_path": None,
                    "chunk_count": None,
                }
            )
            continue
        items.append(
            {
                "asset_id": knowledge_version.asset_id,
                "asset_type": "knowledge",
                "asset_name": k.get("asset_name"),
                "role": "knowledge",
                "required": True,
                "asset_version_id": knowledge_version.id,
                "version": knowledge_version.version,
                "status": knowledge_version.status,
                "manifest": knowledge_version.manifest,
                "manifest_hash": knowledge_version.manifest_hash,
                "storage_path": knowledge_version.storage_path,
                "index_path": k.get("index_path"),
                "chunk_count": k.get("chunk_count"),
            }
        )

    agent_ref = service_definition.get("agent_ref") or {}
    if agent_ref.get("id"):
        items.append(
            {
                "asset_id": agent_ref.get("id"),
                "asset_type": "agent",
                "asset_name": "Standard Knowledge Chat Agent",
                "role": "agent",
                "required": True,
                "asset_version_id": None,
                "version": agent_ref.get("version"),
                "status": "STANDARD_LOCAL_COPY",
                "manifest": None,
                "manifest_hash": None,
                "storage_path": None,
                "index_path": None,
                "chunk_count": None,
            }
        )

    for binding in service_definition.get("prompt_bindings") or []:
        items.append(
            {
                "asset_id": binding.get("prompt_id"),
                "asset_type": "prompt",
                "asset_name": "Standard Knowledge Answer Prompt",
                "role": "prompt",
                "required": True,
                "asset_version_id": None,
                "version": binding.get("prompt_version"),
                "status": "STANDARD_LOCAL_COPY",
                "manifest": None,
                "manifest_hash": None,
                "storage_path": None,
                "index_path": None,
                "chunk_count": None,
            }
        )

    return items, service_definition


# Action-first Korean guidance per failing check id, deliberately NOT the
# check's own `remedy` string verbatim — `BM25_FORMAT`'s remedy
# (`convert-bm25-format {index_dir}`) carries an absolute local filesystem
# path, and 07-data-api-contracts.md §10.2 forbids internal paths in a
# user-facing message. The 반출 준비 상태 점검 screen (P10/P11) still shows the
# raw `remedy` field in its own panel — this Gate's error message only
# points at the fix in general terms; the panel is not duplicated here per
# the task brief.
_READINESS_ACTION_TEXT = {
    "INDEXING_COMPLETED": "색인 작업을 실행하거나, 실패했다면 다시 실행하세요.",
    "INDEX_DIR_FOUND": "색인 작업을 다시 실행하세요.",
    "INDEX_META_KNOWLEDGE_ID": "색인 작업을 다시 실행하세요.",
    "BM25_FORMAT": "BM25 색인을 최신(JSON) 형식으로 변환한 뒤 다시 시도하세요.",
    "CHROMA_PRESENT": "색인 작업을 다시 실행하세요.",
}
_READINESS_DEFAULT_ACTION_TEXT = "색인 작업을 다시 실행하세요."


async def _knowledge_distribution_readiness_gate(
    db: AsyncSession, items: list[dict], trace_id: str
) -> JSONResponse | None:
    """D-079 반출 준비 상태 점검을 Distribution 생성 시점의 Gate로 실행한다
    (측정된 사고: 색인 Job이 FAILED인 Knowledge가 승인 -> Offline Bundle ->
    Desktop 설치까지 그대로 통과해, 활성화 시점에야 사용자가 손댈 수 없는
    오류로 실패했다).

    `routers.knowledge_diagnostics.distribution_readiness`가 쓰는 것과
    완전히 같은 판정(`portal_api.knowledge_readiness`)을 재사용한다 — 화면과
    Gate가 서로 다른 답을 낼 수 없다(브리핑 1항). `items`는 이 Distribution이
    실제로 담으려는 것 전부를 대상으로 한다: ASSET_VERSION root가 Knowledge
    Asset 자신이든, SERVICE_VERSION root의 Knowledge 의존성이든 `asset_type
    == "knowledge"`이면 동일하게 검사한다 — non-Knowledge Asset(agent 등)은
    이 필터에 걸리지 않으므로 Gate가 실수로 그것들을 붙잡을 수 없다(브리핑
    2항의 "non-Knowledge asset unaffected" 요구).

    `ready is False`(FAIL 등급 Check가 하나라도 있음)면 즉시 거부한다 — WARN
    (`EMBED_MODEL_RECORDED`/`CLASSIFICATION_STAMPED`)은 설계상 Block하지
    않는다. 인덱스 자체를 읽을 수 없는 경우도 `distribution_readiness_checks`
    안에서 이미 FAIL로 취급되므로(WARN으로 낙관하지 않음) 별도 처리가
    필요 없다.
    """
    for item in items:
        if item.get("asset_type") != "knowledge":
            continue
        version_id = item.get("asset_version_id")
        if not version_id:
            continue
        job = await latest_indexing_job(db, version_id)
        checks = distribution_readiness_checks(job, version_id)
        if is_ready(checks):
            continue

        failing = first_failing_check(checks)
        assert failing is not None  # is_ready() is False iff some check FAILed

        # 오류코드: `KNOWLEDGE_INDEX_CORRUPT`(07-data-api-contracts.md §8
        # Knowledge 분류)를 선택했다. 이 Gate가 막는 모든 FAIL 원인
        # (색인 미완료/디렉터리 없음/메타데이터 불일치/BM25 legacy
        # pickle-only/BM25 또는 Chroma 누락)은 전부 "이 버전의 색인이 Desktop
        # 활성화에 쓸 수 있는 온전한 상태가 아니다"라는 하나의 사실을
        # 서술한다. search-runtime은 이 중 BM25 legacy pickle 케이스에 대해
        # 질의 시점에 정확히 이 코드를 이미 사용하고 있고(D-054,
        # `search_runtime.main`의 `LegacyPickleBm25Refused` 처리),
        # 나머지 등록 시점 거부(`local_index_registry.py`)는
        # `VALIDATION_ERROR`를 쓰지만 그건 "이 등록 요청 자체가 잘못됨"이라는
        # 다른 화자(호출자의 등록 시도)의 의미라 이 Gate(포털이 스스로
        # 예측해 사전에 막는 상황)에는 맞지 않는다. `ASSET_STATE_TRANSITION_
        # INVALID`(바로 위 APPROVED 여부 검사에서 쓰는 코드)도 검토했으나
        # 그 코드는 이 라우터 전체에서 `AssetVersion.status`/서비스 게시
        # 여부 같은 수명주기 필드 전이에만 쓰이고 있어(reviews.py/assets.py
        # 전체 용례 확인), 색인 완전성이라는 다른 축의 실패를 같은 코드에
        # 얹으면 오류코드 하나가 두 가지 원인을 가리키게 된다. `KNOWLEDGE_
        # INDEX_CORRUPT`가 Knowledge 색인이라는 동일 도메인 안에서 가장
        # 정확히 들어맞는다고 판단했다.
        action = _READINESS_ACTION_TEXT.get(failing.id, _READINESS_DEFAULT_ACTION_TEXT)
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "KNOWLEDGE_INDEX_CORRUPT",
            f"이 Knowledge 버전의 색인이 아직 반출 가능한 상태가 아니어서 "
            f"Distribution을 생성할 수 없습니다 ({failing.id}). {action}",
            trace_id,
            details={
                "asset_version_id": version_id,
                "check": failing.id,
                "activation_reason": failing.activation_reason,
            },
        )
    return None


@router.post("", response_model=CreateDistributionResponseOut, status_code=status.HTTP_202_ACCEPTED)
async def create_distribution(
    body: CreateDistributionRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    distribution_caller: BundleCaller = Depends(get_distribution_caller),
    session_factory: SessionFactory = Depends(get_session_factory),
) -> CreateDistributionResponseOut | JSONResponse:
    trace_id = _trace_id()

    denial = await require_permission(
        db, user, Permission.DISTRIBUTION_CREATE, trace_id=trace_id, resource_type="DISTRIBUTION"
    )
    if denial:
        return denial

    if body.mode != "OFFLINE_BUNDLE":
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "ONLINE 다운로드는 아직 지원하지 않습니다. mode=OFFLINE_BUNDLE만 사용할 수 있습니다.",
            trace_id,
        )

    items: list[dict]
    service_definition: dict | None = None

    if body.root_type == "ASSET_VERSION":
        version = (
            await db.execute(select(AssetVersion).where(AssetVersion.id == body.root_id))
        ).scalar_one_or_none()
        if version is None:
            return not_found("자산 버전을 찾을 수 없습니다.", trace_id)
        asset = (
            await db.execute(select(Asset).where(Asset.id == version.asset_id))
        ).scalar_one_or_none()
        if asset is None:
            return not_found("자산을 찾을 수 없습니다.", trace_id)
        if version.status != VersionStatus.APPROVED.value:
            return error_response(
                status.HTTP_400_BAD_REQUEST,
                "ASSET_STATE_TRANSITION_INVALID",
                f"승인되지 않은 버전({version.status})은 Offline Bundle로 배포할 수 없습니다.",
                trace_id,
            )
        items, _ = await _build_asset_version_root_payload(db, version, asset)

    elif body.root_type == "SERVICE_VERSION":
        service_version = (
            await db.execute(select(ServiceVersion).where(ServiceVersion.id == body.root_id))
        ).scalar_one_or_none()
        if service_version is None:
            return not_found("Service Version을 찾을 수 없습니다.", trace_id)
        resolved = await _build_service_version_root_payload(db, service_version)
        if resolved is None:
            return error_response(
                status.HTTP_400_BAD_REQUEST,
                "VALIDATION_ERROR",
                "게시된 적 없는 Service Version은 Offline Bundle로 배포할 수 없습니다. "
                "먼저 게시(Publish)를 완료하세요.",
                trace_id,
            )
        items, service_definition = resolved

    else:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "지원하지 않는 root_type입니다.",
            trace_id,
        )

    readiness_denial = await _knowledge_distribution_readiness_gate(db, items, trace_id)
    if readiness_denial:
        return readiness_denial

    known_revocations = await _known_revocations(db)

    # P16 긴급 Revocation — flag every item (root and dependencies alike, e.g.
    # a SERVICE_VERSION-rooted bundle's Knowledge dependency) whose exact
    # AssetVersion has an effective revocation, so distribution-service can
    # refuse to package it (see `_effective_revoked_version_ids` docstring).
    revoked_ids = await _effective_revoked_version_ids(db)
    if revoked_ids:
        for item in items:
            if item.get("asset_version_id") in revoked_ids:
                item["revoked"] = True

    distribution_request = DistributionRequest(
        root_type=body.root_type,
        root_id=body.root_id,
        mode=body.mode,
        target_site_id=body.target_site_id,
        office_profile_version_id=body.office_profile_version_id,
        requested_by=user.user_id,
        status="QUEUED",
        trace_id=trace_id,
    )
    db.add(distribution_request)
    await db.commit()
    await db.refresh(distribution_request)

    await record_audit(
        db,
        event_type="DISTRIBUTION_REQUESTED",
        actor=user,
        resource_type="DISTRIBUTION",
        resource_id=distribution_request.id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"root_type": body.root_type, "root_id": body.root_id, "mode": body.mode},
    )

    payload = {
        "job_id": distribution_request.id,
        "trace_id": trace_id,
        "root_type": body.root_type,
        "root_id": body.root_id,
        "target_site_id": body.target_site_id,
        "office_profile_version_id": body.office_profile_version_id,
        "requested_by": user.user_id,
        "items": items,
        "service_definition": service_definition,
        "known_revocations": known_revocations,
    }
    background_tasks.add_task(
        _run_bundle_job, distribution_request.id, payload, distribution_caller, session_factory
    )

    logger.info(
        "distribution.create trace_id=%s distribution_id=%s root_type=%s root_id=%s",
        trace_id,
        distribution_request.id,
        body.root_type,
        body.root_id,
    )
    return CreateDistributionResponseOut(
        id=distribution_request.id, status=distribution_request.status
    )


async def _run_bundle_job(
    distribution_id: str, payload: dict, caller: BundleCaller, session_factory: SessionFactory
) -> None:
    """Background task — mirrors `_trigger_indexing`'s shape exactly: mark
    RUNNING, call the runtime service, persist whatever comes back. Opens
    its own session via `session_factory` (see `get_session_factory`
    docstring for why it can't reuse the request's `Depends(get_db)`
    session)."""
    async with session_factory() as db:
        req = (
            await db.execute(
                select(DistributionRequest).where(DistributionRequest.id == distribution_id)
            )
        ).scalar_one_or_none()
        if req is None:
            return
        req.status = "RUNNING"
        await db.commit()

    try:
        result = await caller(payload)
    except Exception as exc:  # noqa: BLE001 — must never crash the background task
        async with session_factory() as db:
            req = (
                await db.execute(
                    select(DistributionRequest).where(DistributionRequest.id == distribution_id)
                )
            ).scalar_one_or_none()
            if req:
                req.status = "FAILED"
                req.stage = req.stage or "RESOLVING"
                req.error_code = "DEPENDENCY_UNAVAILABLE"
                req.error_message = f"Distribution Service 호출에 실패했습니다: {exc}"[:1000]
                req.retryable = True
                await db.commit()
        logger.warning(
            "distribution.bundle.call_failed distribution_id=%s error=%s", distribution_id, exc
        )
        return

    async with session_factory() as db:
        req = (
            await db.execute(
                select(DistributionRequest).where(DistributionRequest.id == distribution_id)
            )
        ).scalar_one_or_none()
        if req is None:
            return
        req.status = result.get("status", "FAILED")
        req.stage = result.get("stage")
        if req.status == "SUCCEEDED":
            req.bundle_object_id = result.get("bundle_object_id")
            req.bundle_path = result.get("bundle_path")
            req.bundle_size_bytes = result.get("bundle_size_bytes")
            req.bundle_checksum = result.get("checksum")
            req.manifest_summary = result.get("manifest_summary")
        else:
            error = result.get("error") or {}
            req.error_code = error.get("code")
            req.error_message = error.get("message")
            req.affected_assets = error.get("affected_assets")
            req.retryable = error.get("retryable")
        await db.commit()


@router.get("", response_model=DistributionListResponse)
async def list_distributions(
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DistributionListResponse | JSONResponse:
    """List Distribution/Bundle requests — 07-data-api-contracts.md §5.3
    list envelope, newest first.

    Scoping mirrors `get_distribution`/`download_distribution` exactly
    (same permission, same ownership rule): ADMIN/AUDITOR see every request;
    everyone else sees only requests they made themselves. This is a
    narrower `WHERE` clause version of those endpoints' post-hoc 403 check,
    not a separate policy — 참고 P13 스펙: "사용자에게는 본인의 다운로드와
    Bundle 요청만 표시한다. AUDITOR는 권한 범위 내 전체 이력을 검색할 수
    있다."
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.DOWNLOAD_READ, trace_id=trace_id, resource_type="DISTRIBUTION"
    )
    if denial:
        return denial

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))  # §10.3: default 20, max 100

    stmt = select(DistributionRequest)
    if user.role not in ("ADMIN", "AUDITOR"):
        stmt = stmt.where(DistributionRequest.requested_by == user.user_id)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar_one()

    stmt = (
        stmt.order_by(DistributionRequest.created_at.desc(), DistributionRequest.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    records = (await db.execute(stmt)).scalars().all()

    return DistributionListResponse(
        items=[DistributionRequestOut.model_validate(r) for r in records],
        page=page,
        page_size=page_size,
        total=total,
    )


# --- P13 다운로드 이력 ---

# `AuditEvent.event_type`s that count as a "다운로드" attempt in the merged
# history view. Deliberately narrow and unambiguous:
#   - "BUNDLE_DOWNLOADED" — written only by `download_distribution` (success
#     and both failure branches: not-ready, revoked).
#   - "PERMISSION_DENIED:DISTRIBUTION_DOWNLOAD_SCOPE" — written only by
#     `download_distribution`'s cross-user ownership check.
# The generic "PERMISSION_DENIED:DOWNLOAD_READ" denial is deliberately
# excluded: it fires from multiple endpoints (list/get/download) with the
# same event_type, so including it here could misrepresent a denied *view*
# as a denied *download* — never fabricate what the row actually was.
_DOWNLOAD_EVENT_TYPES = ("BUNDLE_DOWNLOADED", "PERMISSION_DENIED:DISTRIBUTION_DOWNLOAD_SCOPE")

_REQUEST_OUTCOME = {
    "QUEUED": "IN_PROGRESS",
    "RUNNING": "IN_PROGRESS",
    "SUCCEEDED": "SUCCESS",
    "FAILED": "FAILURE",
    "CANCELLED": "CANCELLED",
}

_DOWNLOAD_RESULT_OUTCOME = {"SUCCESS": "SUCCESS", "FAILED": "FAILURE", "DENIED": "DENIED"}

_DOWNLOAD_FAILURE_REASON_TEXT = {
    "not_ready": "Bundle이 아직 준비되지 않았습니다.",
    "asset_version_revoked": "긴급 회수(Revocation)된 버전의 Bundle입니다.",
}


async def _resolve_root_display(
    db: AsyncSession,
    cache: dict[tuple[str, str], tuple[str | None, str | None]],
    root_type: str | None,
    root_id: str | None,
) -> tuple[str | None, str | None]:
    """Returns (asset_name, version) for a Bundle/Distribution root, or
    (None, None) if it can no longer be resolved — never guessed. `cache` is
    a per-request dict keyed by (root_type, root_id) so the same root looked
    up across many history rows only hits the DB once (PoC-scale dataset —
    see module note on `list_download_history` for why this stays in-Python
    rather than a single SQL join)."""
    if not root_type or not root_id:
        return None, None
    key = (root_type, root_id)
    if key in cache:
        return cache[key]

    name: str | None = None
    version: str | None = None
    if root_type == "ASSET_VERSION":
        row = (
            await db.execute(
                select(AssetVersion.version, Asset.name)
                .join(Asset, Asset.id == AssetVersion.asset_id)
                .where(AssetVersion.id == root_id)
            )
        ).first()
        if row:
            version, name = row[0], row[1]
    elif root_type == "SERVICE_VERSION":
        row = (
            await db.execute(
                select(ServiceVersion.version, Service.name)
                .join(Service, Service.id == ServiceVersion.service_id)
                .where(ServiceVersion.id == root_id)
            )
        ).first()
        if row:
            version, name = row[0], row[1]

    cache[key] = (name, version)
    return name, version


@router.get("/download-history", response_model=DownloadHistoryListResponse)
async def list_download_history(
    page: int = 1,
    page_size: int = 20,
    date_from: datetime | None = Query(default=None, alias="from"),
    date_to: datetime | None = Query(default=None, alias="to"),
    mode: str | None = None,
    outcome: str | None = None,
    actor_id: str | None = None,
    organization_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DownloadHistoryListResponse | JSONResponse:
    """P13 다운로드 이력 — merges two sources into one read-only view without
    duplicating either into the other:

      - "Bundle 요청" rows: `DistributionRequest`, one row per `POST
        /distributions` call (requested/completed timestamps = created_at/
        updated_at once terminal).
      - "다운로드" rows: `AuditEvent` rows written by `download_distribution`
        (`_DOWNLOAD_EVENT_TYPES` — success, failure, and cross-user denial).

    Scoping is enforced here, in the query/filter, not by hiding rows in the
    UI (CLAUDE.md): ADMIN/AUDITOR see everything; every other role sees only
    rows where *they* are the actor (`requested_by`/`actor_id` == their own
    user_id) — a non-auditor asking for someone else's history via
    `actor_id`/`organization_id` is denied and audited, exactly like every
    other permission denial in this router.

    조직 is read from `AuditEvent.organization_id` (never guessed): the
    "Bundle 요청" row's own `DISTRIBUTION_REQUESTED` audit event for that
    kind, the download event's own `organization_id` for the other. 대상
    사업장 prefers `DistributionRequest.target_site_id` and falls back to
    the download event's own `site_id` only when the former is unavailable.
    Any field that is genuinely unknown for a row (pre-dates a column,
    orphaned reference, etc.) is left `None` — rendered "미기재" by the UI.

    PoC-scale implementation note: with double digits of rows today, this
    fetches both sources into Python, enriches/merges/sorts/paginates there
    rather than a single SQL UNION — simpler and easier to verify correct
    at this size; revisit with real SQL-side pagination before this grows
    past a few thousand rows.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.DOWNLOAD_READ, trace_id=trace_id, resource_type="DOWNLOAD_HISTORY"
    )
    if denial:
        return denial

    is_auditor = user.role in ("ADMIN", "AUDITOR")

    if not is_auditor:
        if (actor_id and actor_id != user.user_id) or (
            organization_id and organization_id != user.org
        ):
            await record_audit(
                db,
                event_type="PERMISSION_DENIED:DOWNLOAD_HISTORY_SCOPE",
                actor=user,
                resource_type="DOWNLOAD_HISTORY",
                resource_id="-",
                result="DENIED",
                trace_id=trace_id,
                metadata={
                    "requested_actor_id": actor_id,
                    "requested_organization_id": organization_id,
                },
            )
            return error_response(
                status.HTTP_403_FORBIDDEN,
                "PERMISSION_DENIED",
                "본인의 다운로드 이력만 조회할 수 있습니다.",
                trace_id,
            )
        # Own-scope is enforced by these two, regardless of what (matching or
        # absent) actor_id/organization_id the caller passed.
        actor_id = user.user_id

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    req_stmt = select(DistributionRequest)
    if not is_auditor:
        req_stmt = req_stmt.where(DistributionRequest.requested_by == actor_id)
    if mode:
        req_stmt = req_stmt.where(DistributionRequest.mode == mode)
    if date_from:
        req_stmt = req_stmt.where(DistributionRequest.created_at >= date_from)
    if date_to:
        req_stmt = req_stmt.where(DistributionRequest.created_at <= date_to)
    requests = (await db.execute(req_stmt.limit(2000))).scalars().all()

    dl_stmt = select(AuditEvent).where(AuditEvent.event_type.in_(_DOWNLOAD_EVENT_TYPES))
    if not is_auditor:
        dl_stmt = dl_stmt.where(AuditEvent.actor_id == actor_id)
    if date_from:
        dl_stmt = dl_stmt.where(AuditEvent.timestamp >= date_from)
    if date_to:
        dl_stmt = dl_stmt.where(AuditEvent.timestamp <= date_to)
    events = (await db.execute(dl_stmt.limit(2000))).scalars().all()

    # Every download event's resource_id is a DistributionRequest.id — batch
    # fetch whichever of those aren't already in `requests` (e.g. a denied
    # cross-user attempt against someone else's request) so download rows
    # can be enriched with root_type/root_id/mode/version/target_site.
    needed_ids = {e.resource_id for e in events} | {r.id for r in requests}
    dist_by_id: dict[str, DistributionRequest] = {r.id: r for r in requests}
    missing_ids = needed_ids - dist_by_id.keys()
    if missing_ids:
        extra_stmt = select(DistributionRequest).where(DistributionRequest.id.in_(missing_ids))
        extra = (await db.execute(extra_stmt)).scalars().all()
        dist_by_id.update({r.id: r for r in extra})

    origin_audit_by_dist_id: dict[str, AuditEvent] = {}
    if needed_ids:
        origin_rows = (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "DISTRIBUTION_REQUESTED",
                    AuditEvent.resource_id.in_(needed_ids),
                )
            )
        ).scalars().all()
        origin_audit_by_dist_id = {e.resource_id: e for e in origin_rows}

    root_cache: dict[tuple[str, str], tuple[str | None, str | None]] = {}
    entries: list[DownloadHistoryEntryOut] = []

    for req in requests:
        origin = origin_audit_by_dist_id.get(req.id)
        asset_name, version = await _resolve_root_display(
            db, root_cache, req.root_type, req.root_id
        )
        row_outcome = _REQUEST_OUTCOME.get(req.status, "IN_PROGRESS")
        entries.append(
            DownloadHistoryEntryOut(
                id=f"request:{req.id}",
                kind="BUNDLE_REQUEST",
                distribution_id=req.id,
                user=req.requested_by,
                organization=origin.organization_id if origin else None,
                target_site=req.target_site_id,
                root_type=req.root_type,
                root_id=req.root_id,
                asset_name=asset_name,
                version=version,
                mode=req.mode,
                requested_at=req.created_at,
                completed_at=req.updated_at if row_outcome != "IN_PROGRESS" else None,
                client_ip=None,  # never captured on the request itself — see D-064.
                outcome=row_outcome,
                reason=req.error_message if row_outcome == "FAILURE" else None,
                trace_id=req.trace_id,
            )
        )

    for event in events:
        dist = dist_by_id.get(event.resource_id)
        asset_name, version = await _resolve_root_display(
            db, root_cache, dist.root_type if dist else None, dist.root_id if dist else None
        )
        meta = event.metadata_ or {}
        row_outcome = _DOWNLOAD_RESULT_OUTCOME.get(event.result, event.result)
        if event.event_type.startswith("PERMISSION_DENIED"):
            reason = "본인이 요청한 Distribution이 아니어서 다운로드가 거부되었습니다."
        elif row_outcome == "FAILURE":
            reason = _DOWNLOAD_FAILURE_REASON_TEXT.get(meta.get("reason"), meta.get("reason"))
        else:
            reason = None
        entries.append(
            DownloadHistoryEntryOut(
                id=f"download:{event.id}",
                kind="DOWNLOAD",
                distribution_id=event.resource_id,
                user=event.actor_id,
                organization=event.organization_id,
                target_site=(
                    dist.target_site_id if dist and dist.target_site_id else event.site_id
                ),
                root_type=dist.root_type if dist else None,
                root_id=dist.root_id if dist else None,
                asset_name=asset_name,
                version=version,
                mode=dist.mode if dist else None,
                requested_at=event.timestamp,
                completed_at=event.timestamp,
                client_ip=meta.get("client_ip"),
                outcome=row_outcome,
                reason=reason,
                trace_id=event.trace_id,
            )
        )

    if outcome:
        entries = [e for e in entries if e.outcome == outcome]
    if is_auditor and organization_id:
        entries = [e for e in entries if e.organization == organization_id]
    if is_auditor and actor_id:
        entries = [e for e in entries if e.user == actor_id]
    if mode:
        # Already applied in SQL for BUNDLE_REQUEST rows; DOWNLOAD rows need
        # it applied here since their `mode` is only known after the join.
        entries = [e for e in entries if e.mode == mode]

    entries.sort(key=lambda e: e.requested_at, reverse=True)

    total = len(entries)
    start = (page - 1) * page_size
    page_items = entries[start : start + page_size]

    return DownloadHistoryListResponse(
        items=page_items, page=page, page_size=page_size, total=total
    )


@router.get("/{distribution_id}", response_model=DistributionRequestOut)
async def get_distribution(
    distribution_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> DistributionRequestOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.DOWNLOAD_READ, trace_id=trace_id,
        resource_type="DISTRIBUTION", resource_id=distribution_id,
    )
    if denial:
        return denial

    record = (
        await db.execute(
            select(DistributionRequest).where(DistributionRequest.id == distribution_id)
        )
    ).scalar_one_or_none()
    if record is None:
        return not_found("Distribution 요청을 찾을 수 없습니다.", trace_id)

    if user.role not in ("ADMIN", "AUDITOR") and record.requested_by != user.user_id:
        await record_audit(
            db,
            event_type="PERMISSION_DENIED:DISTRIBUTION_READ_SCOPE",
            actor=user,
            resource_type="DISTRIBUTION",
            resource_id=distribution_id,
            result="DENIED",
            trace_id=trace_id,
        )
        return error_response(
            status.HTTP_403_FORBIDDEN,
            "PERMISSION_DENIED",
            "본인이 요청한 Distribution만 조회할 수 있습니다.",
            trace_id,
        )

    return DistributionRequestOut.model_validate(record)


@router.get("/{distribution_id}/download", response_model=None)
async def download_distribution(
    distribution_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> FileResponse | JSONResponse:
    trace_id = _trace_id()
    client_ip = _client_ip(request)
    denial = await require_permission(
        db, user, Permission.DOWNLOAD_READ, trace_id=trace_id,
        resource_type="DISTRIBUTION", resource_id=distribution_id,
    )
    if denial:
        return denial

    record = (
        await db.execute(
            select(DistributionRequest).where(DistributionRequest.id == distribution_id)
        )
    ).scalar_one_or_none()
    if record is None:
        return not_found("Distribution 요청을 찾을 수 없습니다.", trace_id)

    if user.role not in ("ADMIN", "AUDITOR") and record.requested_by != user.user_id:
        await record_audit(
            db,
            event_type="PERMISSION_DENIED:DISTRIBUTION_DOWNLOAD_SCOPE",
            actor=user,
            resource_type="DISTRIBUTION",
            resource_id=distribution_id,
            result="DENIED",
            trace_id=trace_id,
            metadata={"client_ip": client_ip},
        )
        return error_response(
            status.HTTP_403_FORBIDDEN,
            "PERMISSION_DENIED",
            "본인이 요청한 Distribution만 다운로드할 수 있습니다.",
            trace_id,
        )

    if record.status != "SUCCEEDED" or not record.bundle_path:
        await record_audit(
            db,
            event_type="BUNDLE_DOWNLOADED",
            actor=user,
            resource_type="DISTRIBUTION",
            resource_id=distribution_id,
            result="FAILED",
            trace_id=trace_id,
            metadata={"reason": "not_ready", "status": record.status, "client_ip": client_ip},
        )
        return error_response(
            status.HTTP_409_CONFLICT,
            "DEPENDENCY_UNAVAILABLE",
            f"Bundle이 아직 준비되지 않았습니다 (현재 상태: {record.status}).",
            trace_id,
        )

    # P16 긴급 Revocation — a bundle already built and stored on disk before
    # a revocation was recorded must still stop serving once the revocation
    # becomes effective. Scoped to ASSET_VERSION-rooted requests, where
    # `root_id` is exactly the revoked AssetVersion id; a SERVICE_VERSION
    # root's transitive Knowledge dependencies are checked at *build* time
    # only (distribution-service's resolver — see contracts.py/resolver.py)
    # since `DistributionRequest` doesn't persist the resolved dependency
    # item list to re-check them individually on every re-download
    # (open-decisions.md D-057).
    if record.root_type == "ASSET_VERSION" and await _has_effective_revocation(
        db, record.root_id
    ):
        await record_audit(
            db,
            event_type="BUNDLE_DOWNLOADED",
            actor=user,
            resource_type="DISTRIBUTION",
            resource_id=distribution_id,
            result="FAILED",
            trace_id=trace_id,
            metadata={
                "reason": "asset_version_revoked",
                "root_id": record.root_id,
                "client_ip": client_ip,
            },
        )
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_VERSION_REVOKED",
            "긴급 회수(Revocation)된 버전의 Bundle은 다운로드할 수 없습니다.",
            trace_id,
        )

    bundle_file = Path(record.bundle_path)
    if not bundle_file.is_file():
        return error_response(
            status.HTTP_404_NOT_FOUND,
            "RESOURCE_NOT_FOUND",
            "Bundle 파일을 찾을 수 없습니다.",
            trace_id,
        )

    # Filename derived entirely from server-controlled fields — never from
    # user input (CLAUDE.md: 사용자가 제공한 파일명으로 파일 경로를 만들지
    # 않는다; the on-disk *path* is `record.bundle_path`, already an
    # object_id-based path from distribution-service's Storage Adapter).
    bundle_id = (record.manifest_summary or {}).get("bundle_id", record.id)
    download_name = f"bundle-{record.id}-{bundle_id}.zip"

    await record_audit(
        db,
        event_type="BUNDLE_DOWNLOADED",
        actor=user,
        resource_type="DISTRIBUTION",
        resource_id=distribution_id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"bundle_size_bytes": record.bundle_size_bytes, "client_ip": client_ip},
    )
    return FileResponse(
        path=bundle_file,
        media_type="application/zip",
        filename=download_name,
    )
