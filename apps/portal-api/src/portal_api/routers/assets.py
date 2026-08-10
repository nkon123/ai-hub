"""Asset CRUD router — supports Knowledge, Agent, Prompt, MCP Tool."""

from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
from ai_asset_schemas import SchemaType
from ai_asset_schemas import ValidationError as SchemaValidationError
from ai_asset_schemas import validate as validate_manifest
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import JSONResponse
from observability import get_trace_id
from security_policy import Permission, Role, VersionStatus, has_permission, is_mutable
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import get_db
from portal_api.diffing import compute_manifest_diff
from portal_api.errors import error_response, not_found
from portal_api.models import Asset, AssetVersion, AssetVersionRevocation, IndexingJob
from portal_api.models.review import ReviewDecision, ReviewRequest
from portal_api.models.revocation import effective_filter
from portal_api.platform_settings import INDEXING_EMBED_MODEL_KEY, get_setting
from portal_api.rbac import require_permission
from portal_api.schemas import (
    AssetListResponse,
    AssetOut,
    AssetVersionOut,
    AssetVersionRevocationSummaryOut,
    CreateAssetVersionRequest,
    IndexingJobOut,
    ManifestValidateRequest,
    ManifestValidateResponseOut,
    MyAssetCategoryOut,
    MyAssetReviewDecisionSummaryOut,
    MyAssetsResponseOut,
    MyAssetVersionRowOut,
    PromptTemplateOut,
    UpdateAssetVersionRequest,
)
from portal_api.semver import is_strictly_greater

router = APIRouter(prefix="/api/v1", tags=["assets"])

# P06: only these manifest keys may be edited in place via PATCH — the rest
# of the manifest (workflow shape, source documents, indexing profile, etc.)
# requires a new version, not an edit (§2 P06 "새 버전 만들기" vs "Changelog
# 작성" being separate actions).
_EDITABLE_MANIFEST_FIELDS = frozenset({"description", "tags"})

# P07 "구분" (01-portal-and-distribution.md §2 P07), in the spec's own order.
# SUSPENDED/RETIRED are deliberately absent — those belong to the P16
# 수명주기/회수 screen, not 내 자산.
_MY_ASSET_CATEGORY_ORDER = (
    "IN_PROGRESS",
    "VALIDATION_FAILED",
    "PENDING_REVIEW",
    "REJECTED",
    "APPROVED",
    "DEPRECATED",
)

_MANIFEST_TYPE_TO_SCHEMA: dict[str, SchemaType] = {
    "agent": SchemaType.AGENT,
    "knowledge": SchemaType.KNOWLEDGE,
    "prompt": SchemaType.PROMPT,
    "mcp_tool": SchemaType.MCP_TOOL,
    "service": SchemaType.SERVICE,
}

# DI seams for `_trigger_indexing`'s background task — mirrors
# `routers.distributions.get_distribution_caller`/`get_session_factory`
# exactly (same rationale: a background task outlives the request's
# `Depends(get_db)` session and must not hardcode a real outbound HTTP call,
# so integration tests can override both via `app.dependency_overrides`
# instead of a real indexing-runtime process or the real `portal.db`).
IndexingCaller = Callable[[dict], Awaitable[dict]]
SessionFactory = Callable[[], AsyncSession]


async def _call_indexing_runtime_http(payload: dict) -> dict:
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(
            f"{settings.indexing_runtime_url}/indexing/v1/jobs", json=payload
        )
        # No raise_for_status() here, deliberately unchanged from this
        # function's pre-DI-seam behavior: a non-2xx response body is still
        # parsed and stored via IndexingJob.status = result.get("status",
        # "COMPLETED") below, same as before this refactor.
        return resp.json()


def get_indexing_caller() -> IndexingCaller:
    """FastAPI dependency seam — overridden in integration tests
    (`app.dependency_overrides[get_indexing_caller]`) so the suite never
    needs a real indexing-runtime process running."""
    return _call_indexing_runtime_http


def get_indexing_session_factory() -> SessionFactory:
    """FastAPI dependency seam for `_trigger_indexing`'s own DB session —
    see `routers.distributions.get_session_factory`'s docstring for why a
    background task can't reuse the request's `Depends(get_db)` session."""
    from portal_api.database import AsyncSessionLocal

    return AsyncSessionLocal


def _trace_id() -> str:
    # `observability.middleware.TraceIdMiddleware` (wired in main.py) binds
    # one trace id per inbound request before any router runs — reuse it so
    # this endpoint's audit records/error responses/log lines all agree on
    # the same id, instead of minting a second, different one. The uuid4
    # fallback only matters for direct unit-test calls that bypass the app's
    # middleware stack.
    return get_trace_id() or str(uuid.uuid4())


async def _attach_active_revocations(
    db: AsyncSession, assets_out: list[AssetOut], user: UserContext
) -> None:
    """D-072: populate `AssetVersionOut.active_revocation` for every version
    across the given assets with a single batched query — the same N+1
    concern `get_asset`'s pending-review lookup docstring already flags,
    just for revocations across a whole catalog page this time.

    Reuses `effective_filter` (`models/revocation.py`) as the *only*
    definition of "effective" — the same one
    `routers.distributions._effective_revoked_version_ids`/
    `_has_effective_revocation` use to actually block installation. This
    function must never diverge from that predicate: showing a version as
    revoked here while it still installs fine (or the reverse) would be
    worse than the missing-visibility bug D-072 closes. A future-dated
    revocation (`effective_at` still in the future) is filtered out by
    `effective_filter` itself, so it never appears here — CLAUDE.md 원칙
    "추측 금지": browsing must not show a block that hasn't started yet.

    `reason` is included only when the caller holds
    `Permission.LIFECYCLE_READ` (RELEASE_MANAGER/AUDITOR/ADMIN — see that
    permission's docstring in `security_policy.roles`), mirroring the P16
    lifecycle screen's own boundary. `ASSET_READ` (required just to call
    this endpoint) is granted to *every* role, including plain `USER` —
    the Desktop 자산 스토어's identity — so exposing the raw reason text to
    every caller here would silently widen a boundary that already exists
    elsewhere in this codebase.
    """
    version_ids = [v.id for a in assets_out for v in a.versions]
    if not version_ids:
        return

    stmt = (
        select(AssetVersionRevocation)
        .where(
            AssetVersionRevocation.version_id.in_(version_ids),
            effective_filter(),
        )
        .order_by(
            AssetVersionRevocation.version_id,
            AssetVersionRevocation.effective_at.desc(),
            AssetVersionRevocation.created_at.desc(),
        )
    )
    rows = (await db.execute(stmt)).scalars().all()
    # Rows are already restricted to effective ones and ordered so that,
    # per version_id, the latest-taking-effect row comes first — the same
    # tie-break `reviews._latest_revocation` uses, just batched across many
    # versions in one query instead of one query per version.
    latest_by_version: dict[str, AssetVersionRevocation] = {}
    for row in rows:
        latest_by_version.setdefault(row.version_id, row)

    if not latest_by_version:
        return

    try:
        role: Role | None = Role(user.role)
    except ValueError:
        role = None
    can_see_reason = role is not None and has_permission(role, Permission.LIFECYCLE_READ)

    for asset_out in assets_out:
        for version_out in asset_out.versions:
            revocation = latest_by_version.get(version_out.id)
            if revocation is None:
                continue
            version_out.active_revocation = AssetVersionRevocationSummaryOut(
                effective_at=revocation.effective_at,
                reason=revocation.reason if can_see_reason else None,
            )


@router.get("/assets", response_model=AssetListResponse)
async def list_assets(
    type: str | None = None,
    status: str | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetListResponse | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ, trace_id=trace_id, resource_type="ASSET"
    )
    if denial:
        return denial

    stmt = select(Asset).options(selectinload(Asset.versions))
    if type:
        stmt = stmt.where(Asset.type == type)
    if q:
        stmt = stmt.where(Asset.name.icontains(q))

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar_one()

    stmt = stmt.offset((page - 1) * page_size).limit(page_size).order_by(Asset.created_at.desc())
    assets = (await db.execute(stmt)).scalars().all()

    items = [AssetOut.model_validate(a) for a in assets]
    # D-072: catalog browsing (this is the endpoint Desktop's 자산 스토어
    # uses) must show effective revocations, not just approval status.
    await _attach_active_revocations(db, items, user)

    return AssetListResponse(
        items=items,
        page=page,
        page_size=page_size,
        total=total,
    )


@router.get("/assets/{asset_id}", response_model=AssetOut)
async def get_asset(
    asset_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ,
        trace_id=trace_id, resource_type="ASSET", resource_id=asset_id,
    )
    if denial:
        return denial

    stmt = select(Asset).where(Asset.id == asset_id).options(selectinload(Asset.versions))
    asset = (await db.execute(stmt)).scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    asset_out = AssetOut.model_validate(asset)
    # D-072: same effective-revocation summary as the catalog list, kept
    # consistent so this detail view never contradicts it.
    await _attach_active_revocations(db, [asset_out], user)
    # P06: only asset detail (not the catalog list) resolves each
    # IN_REVIEW/READY_FOR_REVIEW version's PENDING ReviewRequest id — see
    # `AssetVersionOut.pending_review_id` docstring for why this can't be a
    # client-side `GET /reviews` call for a CREATOR.
    for version_out in asset_out.versions:
        if version_out.status not in (
            VersionStatus.IN_REVIEW.value,
            VersionStatus.READY_FOR_REVIEW.value,
        ):
            continue
        pending = (
            await db.execute(
                select(ReviewRequest)
                .where(
                    ReviewRequest.subject_type == "ASSET_VERSION",
                    ReviewRequest.subject_id == version_out.id,
                    ReviewRequest.status == "PENDING",
                )
                .order_by(ReviewRequest.requested_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if pending is not None:
            version_out.pending_review_id = pending.id

    return asset_out


@router.get("/asset-versions/{version_id}", response_model=AssetVersionOut)
async def get_asset_version(
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionOut | JSONResponse:
    """07-data-api-contracts.md §3.2 lists this as a required API ("버전·
    Manifest·의존성") but it had never been implemented — every other screen
    that needed a single version's manifest instead walked the whole
    `GET /assets/{asset_id}` versions array. Filling the gap now because
    D-034's agent-runtime Registry resolution (M05) needs exactly this
    shape: one AssetVersion by id, with its manifest and status, over the
    public HTTP API (CLAUDE.md 원칙2 — no cross-module import of
    `portal_api.models`). Deliberately returns the manifest/status
    regardless of AssetVersion.status (DRAFT included) — same precedent as
    `get_asset` above; approval gating is the caller's job (see
    `get_prompt_template` below and agent-runtime's `manifests.py`), not
    this generic read.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ,
        trace_id=trace_id, resource_type="ASSET_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)
    return AssetVersionOut.model_validate(version)


@router.get("/asset-versions/{version_id}/template", response_model=PromptTemplateOut)
async def get_prompt_template(
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> PromptTemplateOut | JSONResponse:
    """D-034: agent-runtime's Registry resolution needs the Prompt's actual
    template file content (referenced by `manifest.template.file`), not just
    the manifest JSON — `AssetVersionOut` never exposes `storage_path`
    (deliberately, so this stays the one narrow, intent-revealing path to a
    package file instead of a generic-by-filename file server that would
    also hand out full Knowledge document text to any ASSET_READ caller).
    Scoped to `type == "prompt"` only; every other type 404s.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ,
        trace_id=trace_id, resource_type="ASSET_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    manifest = version.manifest or {}
    if manifest.get("type") != "prompt":
        return not_found("Prompt 자산 버전만 템플릿을 조회할 수 있습니다.", trace_id)
    if not version.storage_path:
        return not_found("템플릿 파일을 찾을 수 없습니다.", trace_id)

    template_file = (manifest.get("template") or {}).get("file")
    if not template_file:
        return not_found("템플릿 파일을 찾을 수 없습니다.", trace_id)

    # `template_file` comes from the version's own already-validated (schema
    # `pattern: "^(?!.*\\.\\.).*$"`) manifest, not from this request — still
    # resolve with `.name` defensively so a legacy/DB-edited manifest can
    # never escape `storage_path` (same posture as create_asset's upload
    # handling above).
    path = Path(version.storage_path) / Path(template_file).name
    if not path.exists():
        return not_found("템플릿 파일을 찾을 수 없습니다.", trace_id)
    return PromptTemplateOut(content=path.read_text(encoding="utf-8"))


@router.post("/manifests/validate", response_model=ManifestValidateResponseOut)
async def validate_manifest_draft(
    body: ManifestValidateRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> ManifestValidateResponseOut | JSONResponse:
    """P05 자산 등록 Wizard 4단계(자동검증) 사전 단계 — 아무 것도 저장하지
    않는 순수 Dry-run. `POST /api/v1/assets`가 생성 시점에 강제하는 것과
    동일한 스키마 검증을 초안 단계에서 미리 보여줘 제출 전에 필드별 오류를
    표시할 수 있게 한다(CLAUDE.md UI 구현 규칙: "모든 Form Field에 Label과
    Validation Message를 제공한다"). `POST /api/v1/assets`를 대체하지 않고
    그 앞에 오는 별도 조회성 단계다 — 두 endpoint가 같은 검증 로직을 각자
    호출하므로 계약이 갈라질 위험이 없다.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_CREATE, trace_id=trace_id, resource_type="ASSET"
    )
    if denial:
        return denial

    schema_type = _MANIFEST_TYPE_TO_SCHEMA.get(body.type)
    if schema_type is None:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            f"지원하지 않는 자산 유형입니다: {body.type!r}",
            trace_id,
        )
    try:
        validate_manifest(body.manifest, schema_type)
    except SchemaValidationError as e:
        return ManifestValidateResponseOut(
            valid=False, errors=list(e.errors) if e.errors else [str(e)]
        )
    return ManifestValidateResponseOut(valid=True, errors=[])


@router.post("/assets", response_model=AssetVersionOut, status_code=status.HTTP_201_CREATED)
async def create_asset(
    manifest: str = Form(..., description="Asset manifest JSON string"),
    files: list[UploadFile] = File(default=[]),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    indexing_caller: IndexingCaller = Depends(get_indexing_caller),
    indexing_session_factory: SessionFactory = Depends(get_indexing_session_factory),
) -> AssetVersionOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_CREATE, trace_id=trace_id, resource_type="ASSET"
    )
    if denial:
        return denial

    try:
        manifest_dict = json.loads(manifest)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid manifest JSON: {e}") from e

    asset_type = manifest_dict.get("type")
    if not asset_type:
        raise HTTPException(status_code=400, detail="manifest.type is required")

    # D-034: this endpoint is generic across Knowledge/Agent/Prompt/MCP Tool —
    # nothing type-specific below this check. Before this fix, an
    # AGENT/PROMPT/MCP_TOOL manifest that violated its own schema (missing
    # `workflow`, wrong `risk_level`, etc.) was still accepted and stored
    # as-is; the only schema check anywhere was the separate, post-creation
    # `POST .../versions/{id}/validate` endpoint, which never blocks DRAFT
    # creation. P05 (자산 등록 Wizard) requires "Manifest Schema" as one of
    # its listed validations *at registration time* (01-portal-and-
    # distribution.md §2 P05) — enforce it here, for every type including
    # `knowledge` (unchanged in practice: `/knowledge/new`'s manifest already
    # conforms, see progress-log.md).
    schema_type = _MANIFEST_TYPE_TO_SCHEMA.get(asset_type)
    if schema_type is None:
        raise HTTPException(
            status_code=400, detail=f"지원하지 않는 자산 유형입니다: {asset_type!r}"
        )
    try:
        validate_manifest(manifest_dict, schema_type)
    except SchemaValidationError as e:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "Manifest가 스키마를 충족하지 않습니다.",
            trace_id,
            details={"errors": list(e.errors) if e.errors else [str(e)]},
        )

    asset_id = manifest_dict.get("id") or str(uuid.uuid4())
    version_str = manifest_dict.get("version", "1.0.0")
    name = manifest_dict.get("name", "")

    # Save uploaded files to storage (use absolute path to share with indexing-runtime)
    version_id = str(uuid.uuid4())
    storage_path = (settings.storage_root / asset_type / asset_id / version_str).resolve()
    storage_path.mkdir(parents=True, exist_ok=True)

    saved_files: list[str] = []
    for upload in files:
        if not upload.filename:
            continue
        # Prevent path traversal
        safe_name = Path(upload.filename).name
        dest = storage_path / safe_name
        content = await upload.read()
        dest.write_bytes(content)
        saved_files.append(safe_name)

    # Compute manifest hash
    canonical = json.dumps(manifest_dict, sort_keys=True, ensure_ascii=False)
    manifest_hash = hashlib.sha256(canonical.encode()).hexdigest()

    # Upsert Asset
    existing_asset = (
        await db.execute(select(Asset).where(Asset.id == asset_id))
    ).scalar_one_or_none()
    if not existing_asset:
        asset = Asset(
            id=asset_id,
            type=asset_type,
            name=name,
            owner_org=manifest_dict.get("owner", {}).get("org", user.org),
            owner_creator_id=manifest_dict.get("owner", {}).get("creator_id", user.user_id),
            classification=manifest_dict.get("classification", "INTERNAL"),
        )
        db.add(asset)
    else:
        asset = existing_asset

    version = AssetVersion(
        id=version_id,
        asset_id=asset_id,
        version=version_str,
        status="DRAFT",
        manifest=manifest_dict,
        manifest_hash=manifest_hash,
        changelog=manifest_dict.get("changelog"),
        storage_path=str(storage_path),
    )
    db.add(version)
    await db.commit()
    await db.refresh(version)

    await record_audit(
        db,
        event_type="ASSET_VERSION_CREATED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"asset_id": asset_id, "asset_type": asset_type, "file_count": len(saved_files)},
    )

    # Trigger indexing for knowledge assets
    if asset_type == "knowledge" and saved_files:
        job = IndexingJob(asset_version_id=version_id, status="PENDING")
        db.add(job)
        await db.commit()
        await db.refresh(job)
        # D-065 UPDATE / D-075: the ADMIN-configured indexing embedding
        # model, read once here (same request-scoped `db` session, before
        # the background task runs) — `None` when unset, in which case
        # `_trigger_indexing` omits the field entirely so indexing-runtime's
        # own INDEXING_EMBED_MODEL default applies (unchanged behavior).
        configured_embed_model = await get_setting(db, INDEXING_EMBED_MODEL_KEY)
        background_tasks.add_task(
            _trigger_indexing,
            job.id,
            version_id,
            str(storage_path),
            trace_id,
            # D-062: the raw manifest value, NOT `asset.classification` above
            # (which already applies its own unrelated "INTERNAL if missing"
            # default at Asset-creation time). indexing-runtime independently
            # stamps UNKNOWN for a missing/unrecognized value — see
            # indexing_runtime.pipeline.run_pipeline's docstring.
            manifest_dict.get("classification"),
            configured_embed_model,
            indexing_caller,
            indexing_session_factory,
        )

    return AssetVersionOut.model_validate(version)


async def _require_asset_owner(
    db: AsyncSession,
    user: UserContext,
    asset_id: str,
    trace_id: str,
    *,
    resource_type: str,
    resource_id: str,
    denied_event: str,
    denied_message: str,
) -> tuple[Asset, JSONResponse | None]:
    """Shared ownership gate for the P06 endpoints below (CLAUDE.md RBAC
    요구사항: "P06/P07은 CREATOR-facing이며 호출자 소유 자산으로 범위를
    제한한다 — CREATOR는 다른 소유자의 초안을 수정·열람할 수 없다. ADMIN은
    전체를 본다."). Callers must already have passed the generic
    `require_permission` gate for the relevant `Permission` — this only adds
    the per-resource ownership check and its own DENIED audit row."""
    asset = (await db.execute(select(Asset).where(Asset.id == asset_id))).scalar_one_or_none()
    if asset is None:
        return None, not_found("자산을 찾을 수 없습니다.", trace_id)  # type: ignore[return-value]

    if user.role != Role.ADMIN.value and asset.owner_creator_id != user.user_id:
        await record_audit(
            db,
            event_type=denied_event,
            actor=user,
            resource_type=resource_type,
            resource_id=resource_id,
            result="DENIED",
            trace_id=trace_id,
            metadata={"reason": "not_owner"},
        )
        return None, error_response(
            status.HTTP_403_FORBIDDEN, "PERMISSION_DENIED", denied_message, trace_id
        )

    return asset, None


@router.post(
    "/assets/{asset_id}/versions",
    response_model=AssetVersionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_asset_version(
    asset_id: str,
    body: CreateAssetVersionRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionOut | JSONResponse:
    """P06 버전 관리: 최신 승인(APPROVED) 버전에서 새 초안(DRAFT)을 만든다.

    Source manifest와 저장소 디렉터리를 그대로 복사하고, `version`/
    `changelog`만 교체한다. 새 버전 문자열은 소스보다 SemVer상 엄격히 커야
    한다. 저장 경로는 오직 id로만 구성한다 — 사용자가 입력한 버전 문자열이나
    업로드 파일명으로 경로를 만들지 않는다(CLAUDE.md 코드 규칙).
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_CREATE, trace_id=trace_id,
        resource_type="ASSET", resource_id=asset_id,
    )
    if denial:
        return denial

    asset, denial = await _require_asset_owner(
        db, user, asset_id, trace_id,
        resource_type="ASSET", resource_id=asset_id,
        denied_event="ASSET_VERSION_CREATE_DENIED",
        denied_message="본인이 소유한 자산만 새 버전을 만들 수 있습니다.",
    )
    if denial:
        return denial
    assert asset is not None

    source_stmt = (
        select(AssetVersion)
        .where(
            AssetVersion.asset_id == asset_id,
            AssetVersion.status == VersionStatus.APPROVED.value,
        )
        .order_by(AssetVersion.approved_at.desc(), AssetVersion.updated_at.desc())
        .limit(1)
    )
    source = (await db.execute(source_stmt)).scalar_one_or_none()
    if source is None:
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            "승인된 버전이 없어 새 버전을 만들 수 없습니다.",
            trace_id,
        )

    new_version_str = (body.version or "").strip()
    comparison = is_strictly_greater(new_version_str, source.version)
    if comparison is None:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "버전 형식이 올바르지 않습니다. major.minor.patch 형식(예: 1.2.3)을 사용하세요.",
            trace_id,
        )
    if not comparison:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            f"새 버전({new_version_str})은 기존 승인 버전({source.version})보다 커야 합니다.",
            trace_id,
        )

    dup_stmt = select(AssetVersion).where(
        AssetVersion.asset_id == asset_id, AssetVersion.version == new_version_str
    )
    if (await db.execute(dup_stmt)).scalar_one_or_none() is not None:
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_VERSION_CONFLICT",
            f"버전 {new_version_str}은(는) 이미 존재합니다.",
            trace_id,
        )

    new_version_id = str(uuid.uuid4())
    new_manifest = dict(source.manifest or {})
    new_manifest["version"] = new_version_str
    if body.changelog is not None:
        new_manifest["changelog"] = body.changelog

    canonical = json.dumps(new_manifest, sort_keys=True, ensure_ascii=False)
    manifest_hash = hashlib.sha256(canonical.encode()).hexdigest()

    new_storage_path: str | None = None
    if source.storage_path and Path(source.storage_path).exists():
        # Path derived from ids only (asset type / asset id / new version
        # id) — never from the user-supplied version string or an upload
        # filename (CLAUDE.md 코드 규칙: "사용자가 제공한 파일명으로 파일
        # 경로를 만들지 않는다").
        dest = (settings.storage_root / asset.type / asset_id / new_version_id).resolve()
        shutil.copytree(Path(source.storage_path), dest)
        new_storage_path = str(dest)

    new_version = AssetVersion(
        id=new_version_id,
        asset_id=asset_id,
        version=new_version_str,
        status=VersionStatus.DRAFT.value,
        manifest=new_manifest,
        manifest_hash=manifest_hash,
        changelog=body.changelog if body.changelog is not None else source.changelog,
        storage_path=new_storage_path,
    )
    db.add(new_version)
    await db.commit()
    await db.refresh(new_version)

    await record_audit(
        db,
        event_type="ASSET_VERSION_CREATED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=new_version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=new_version.version,
        metadata={
            "asset_id": asset_id,
            "source_version_id": source.id,
            "source_version": source.version,
        },
    )
    return AssetVersionOut.model_validate(new_version)


@router.patch("/assets/{asset_id}/versions/{version_id}", response_model=AssetVersionOut)
async def update_asset_version(
    asset_id: str,
    version_id: str,
    body: UpdateAssetVersionRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionOut | JSONResponse:
    """P06 버전 관리: Changelog 작성 + 편집 가능한 Manifest 필드(설명/태그) 수정.

    DRAFT/CHANGES_REQUESTED에서만 허용된다 — 승인(APPROVED) 이후 버전을
    수정하는 코드는 만들지 않는다(CLAUDE.md 코드 규칙). 이 규칙은 이미
    `update_chunk_tags`에서도 동일한 오류코드/메시지 스타일로 강제되고 있다.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_EDIT_DRAFT, trace_id=trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    _, denial = await _require_asset_owner(
        db, user, asset_id, trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
        denied_event="ASSET_VERSION_EDIT_DENIED",
        denied_message="본인이 소유한 자산만 수정할 수 있습니다.",
    )
    if denial:
        return denial

    stmt = select(AssetVersion).where(
        AssetVersion.id == version_id, AssetVersion.asset_id == asset_id
    )
    version = (await db.execute(stmt)).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    try:
        current_status = VersionStatus(version.status)
    except ValueError:
        current_status = None
    if current_status is None or not is_mutable(current_status):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})의 버전은 수정할 수 없습니다.",
            trace_id,
        )

    if body.manifest_patch:
        disallowed = set(body.manifest_patch) - _EDITABLE_MANIFEST_FIELDS
        if disallowed:
            return error_response(
                status.HTTP_400_BAD_REQUEST,
                "VALIDATION_ERROR",
                f"수정할 수 없는 필드입니다: {', '.join(sorted(disallowed))}",
                trace_id,
            )

    manifest = dict(version.manifest or {})
    changed_fields: list[str] = []
    if body.manifest_patch:
        for key, value in body.manifest_patch.items():
            manifest[key] = value
            changed_fields.append(key)
    if body.changelog is not None:
        manifest["changelog"] = body.changelog
        version.changelog = body.changelog
        changed_fields.append("changelog")

    if not changed_fields:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "수정할 필드가 없습니다 (changelog 또는 manifest_patch 중 하나는 필요합니다).",
            trace_id,
        )

    canonical = json.dumps(manifest, sort_keys=True, ensure_ascii=False)
    version.manifest = manifest
    version.manifest_hash = hashlib.sha256(canonical.encode()).hexdigest()
    # An edit invalidates any prior automated validation result — it ran
    # against the manifest *before* this change.
    version.validation_status = "NOT_RUN"
    version.validation_errors = None
    version.validated_at = None

    await db.commit()
    await db.refresh(version)

    await record_audit(
        db,
        event_type="ASSET_VERSION_EDITED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"changed_fields": sorted(set(changed_fields))},
    )
    return AssetVersionOut.model_validate(version)


@router.post(
    "/assets/{asset_id}/versions/{version_id}/validate", response_model=AssetVersionOut
)
async def validate_asset_version(
    asset_id: str,
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AssetVersionOut | JSONResponse:
    """P06 버전 관리: 자동검증 재실행 — `ai_asset_schemas`의 공개 Validator
    API(`validate`/`SchemaType`/`ValidationError`)만 사용한다.

    검증 실패는 상태 전이가 아니라 `validation_status` 컬럼에만 기록한다 —
    `packages/security-policy`의 검토된 상태 머신에는 실패 상태가 없고, 이
    구현은 그 결정을 그대로 존중한다: 실패해도 버전은
    DRAFT/CHANGES_REQUESTED에 그대로 머문다.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_VALIDATE, trace_id=trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    _, denial = await _require_asset_owner(
        db, user, asset_id, trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
        denied_event="ASSET_VERSION_VALIDATE_DENIED",
        denied_message="본인이 소유한 자산만 검증할 수 있습니다.",
    )
    if denial:
        return denial

    stmt = select(AssetVersion).where(
        AssetVersion.id == version_id, AssetVersion.asset_id == asset_id
    )
    version = (await db.execute(stmt)).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    try:
        current_status = VersionStatus(version.status)
    except ValueError:
        current_status = None
    if current_status is None or not is_mutable(current_status):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})의 버전은 자동검증을 실행할 수 없습니다.",
            trace_id,
        )

    manifest = version.manifest or {}
    errors: list[str] = []
    manifest_type = manifest.get("type")
    schema_type = _MANIFEST_TYPE_TO_SCHEMA.get(manifest_type)
    if schema_type is None:
        errors = [f"알 수 없는 자산 유형입니다: {manifest_type!r}"]
    else:
        try:
            validate_manifest(manifest, schema_type)
        except SchemaValidationError as e:
            errors = list(e.errors) if e.errors else [str(e)]

    now = datetime.now(UTC)
    version.validation_status = "FAILED" if errors else "PASSED"
    version.validation_errors = errors or None
    version.validated_at = now
    await db.commit()
    await db.refresh(version)

    await record_audit(
        db,
        event_type="ASSET_VERSION_VALIDATED",
        actor=user,
        resource_type="ASSET_VERSION",
        resource_id=version.id,
        result="SUCCESS",
        trace_id=trace_id,
        resource_version=version.version,
        metadata={"validation_status": version.validation_status, "error_count": len(errors)},
    )
    return AssetVersionOut.model_validate(version)


@router.get("/assets/{asset_id}/versions/{version_id}/diff", response_model=None)
async def diff_asset_version(
    asset_id: str,
    version_id: str,
    against: str = Query(..., description="비교 대상(base) 버전 id"),
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> dict | JSONResponse:
    """P06 버전 관리: 이전 버전과 Manifest/Dependency/Permission Diff.

    세 축의 조작적 정의는 `portal_api.diffing` 모듈 docstring 참고.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ, trace_id=trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    _, denial = await _require_asset_owner(
        db, user, asset_id, trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
        denied_event="ASSET_VERSION_DIFF_DENIED",
        denied_message="본인이 소유한 자산만 비교할 수 있습니다.",
    )
    if denial:
        return denial

    target = (
        await db.execute(
            select(AssetVersion).where(
                AssetVersion.id == version_id, AssetVersion.asset_id == asset_id
            )
        )
    ).scalar_one_or_none()
    if target is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    base = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == against))
    ).scalar_one_or_none()
    if base is None:
        return not_found("비교 대상 버전을 찾을 수 없습니다.", trace_id)
    if base.asset_id != asset_id:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "다른 자산의 버전과는 비교할 수 없습니다.",
            trace_id,
        )

    sections = compute_manifest_diff(base.manifest or {}, target.manifest or {})
    return {
        "version_id": target.id,
        "against_version_id": base.id,
        "version": target.version,
        "against_version": base.version,
        **sections,
    }


def _my_asset_category(version: AssetVersion) -> str | None:
    """Maps a version's state onto one of P07's six 구분 — see
    `_MY_ASSET_CATEGORY_ORDER` above. Returns `None` for
    SUSPENDED/RETIRED/VALIDATING, which never appear on this screen."""
    if version.status in (VersionStatus.DRAFT.value, VersionStatus.CHANGES_REQUESTED.value):
        return "VALIDATION_FAILED" if version.validation_status == "FAILED" else "IN_PROGRESS"
    if version.status in (VersionStatus.READY_FOR_REVIEW.value, VersionStatus.IN_REVIEW.value):
        return "PENDING_REVIEW"
    if version.status == VersionStatus.REJECTED.value:
        return "REJECTED"
    if version.status == VersionStatus.APPROVED.value:
        return "APPROVED"
    if version.status == VersionStatus.DEPRECATED.value:
        return "DEPRECATED"
    return None


async def _latest_review_decision(
    db: AsyncSession, version_id: str
) -> MyAssetReviewDecisionSummaryOut | None:
    stmt = (
        select(ReviewDecision, ReviewRequest.stage)
        .join(ReviewRequest, ReviewRequest.id == ReviewDecision.review_id)
        .where(
            ReviewRequest.subject_type == "ASSET_VERSION",
            ReviewRequest.subject_id == version_id,
        )
        .order_by(ReviewDecision.decided_at.desc())
        .limit(1)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        return None
    decision, stage = row
    return MyAssetReviewDecisionSummaryOut(
        stage=stage,
        decision=decision.decision,
        comments=decision.comments,
        reviewer_id=decision.reviewer_id,
        decided_at=decision.decided_at,
    )


@router.get("/my/assets", response_model=MyAssetsResponseOut)
async def list_my_assets(
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> MyAssetsResponseOut | JSONResponse:
    """P07 내 자산: 호출자가 소유한 Asset의 버전을 6개 구분으로 묶어 반환한다.

    ADMIN은 전체 소유자의 버전을 본다(P16 수명주기 화면과 동일한 원칙); 그
    외 역할은 `owner_creator_id`가 자신과 일치하는 Asset의 버전만 본다.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ, trace_id=trace_id, resource_type="ASSET"
    )
    if denial:
        return denial

    stmt = select(AssetVersion, Asset).join(Asset, Asset.id == AssetVersion.asset_id)
    if user.role != Role.ADMIN.value:
        stmt = stmt.where(Asset.owner_creator_id == user.user_id)
    stmt = stmt.order_by(AssetVersion.updated_at.desc())
    rows = (await db.execute(stmt)).all()

    approved_asset_ids: set[str] = {
        asset.id for version, asset in rows if version.status == VersionStatus.APPROVED.value
    }

    buckets: dict[str, list[MyAssetVersionRowOut]] = {
        code: [] for code in _MY_ASSET_CATEGORY_ORDER
    }
    for version, asset in rows:
        category = _my_asset_category(version)
        if category is None:
            continue

        try:
            version_status = VersionStatus(version.status)
        except ValueError:
            version_status = None
        can_edit = version_status is not None and is_mutable(version_status)

        latest_decision = await _latest_review_decision(db, version.id)

        buckets[category].append(
            MyAssetVersionRowOut(
                id=version.id,
                asset_id=asset.id,
                asset_name=asset.name,
                asset_type=asset.type,
                version=version.version,
                status=version.status,
                category=category,
                validation_status=version.validation_status,
                validation_errors=version.validation_errors,
                validated_at=version.validated_at,
                latest_review_decision=latest_decision,
                can_create_new_version=asset.id in approved_asset_ids,
                can_edit=can_edit,
                created_at=version.created_at,
                updated_at=version.updated_at,
            )
        )

    categories = [
        MyAssetCategoryOut(code=code, count=len(buckets[code]), items=buckets[code])
        for code in _MY_ASSET_CATEGORY_ORDER
    ]
    return MyAssetsResponseOut(
        categories=categories, total=sum(len(items) for items in buckets.values())
    )


@router.get("/assets/{asset_id}/indexing-jobs", response_model=list[IndexingJobOut])
async def list_indexing_jobs(
    asset_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> list[IndexingJobOut] | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ,
        trace_id=trace_id, resource_type="ASSET", resource_id=asset_id,
    )
    if denial:
        return denial

    stmt = (
        select(IndexingJob)
        .join(AssetVersion, IndexingJob.asset_version_id == AssetVersion.id)
        .where(AssetVersion.asset_id == asset_id)
        .order_by(IndexingJob.created_at.desc())
    )
    jobs = (await db.execute(stmt)).scalars().all()
    return [IndexingJobOut.model_validate(j) for j in jobs]


@router.get("/assets/{asset_id}/knowledge-info", response_model=None)
async def get_knowledge_info(
    asset_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> dict | JSONResponse:
    """Return combined Knowledge detail: versions, indexing metadata, chunk preview."""
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ,
        trace_id=trace_id, resource_type="ASSET", resource_id=asset_id,
    )
    if denial:
        return denial

    stmt = select(Asset).where(Asset.id == asset_id).options(selectinload(Asset.versions))
    asset = (await db.execute(stmt)).scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.type != "knowledge":
        raise HTTPException(status_code=400, detail="Asset is not a Knowledge type")

    versions_info = []
    for ver in sorted(asset.versions, key=lambda v: v.created_at, reverse=True):
        # Find latest indexing job for this version
        job_stmt = (
            select(IndexingJob)
            .where(IndexingJob.asset_version_id == ver.id)
            .order_by(IndexingJob.created_at.desc())
            .limit(1)
        )
        job = (await db.execute(job_stmt)).scalar_one_or_none()

        index_meta: dict | None = None
        chunks_preview: list[dict] = []
        if job and job.status == "COMPLETED":
            # Resolve index path: try stored path first, then shared index base by version_id
            candidates = []
            if job.index_path:
                candidates.append(Path(job.index_path))
            candidates.append(settings.index_base / ver.id)
            candidates.append(settings.index_base / "hr-policy-v1")  # legacy manual index

            index_dir = next((p for p in candidates if (p / "index-meta.json").exists()), None)
            if index_dir:
                with open(index_dir / "index-meta.json") as f:
                    index_meta = json.load(f)
                if (index_dir / "parents.json").exists():
                    with open(index_dir / "parents.json") as f:
                        parents = json.load(f)
                    chunks_preview = [
                        {
                            "chunk_id": cid,
                            "section": c["metadata"].get("section", ""),
                            "page": c["metadata"].get("page", 1),
                            "title": c["metadata"].get("title", ""),
                            "excerpt": c["text"][:200],
                            "chunk_type": c["metadata"].get("chunk_type", ""),
                        }
                        for cid, c in parents.items()
                    ]

        manifest = ver.manifest or {}
        chunk_tags: dict = manifest.get("chunk_tags") or {}
        if chunks_preview and chunk_tags:
            for cp in chunks_preview:
                cp["tags"] = chunk_tags.get(cp["chunk_id"], [])
        elif chunks_preview:
            for cp in chunks_preview:
                cp["tags"] = []
        indexing_profile = manifest.get("indexing_profile_ref", {})

        versions_info.append({
            "id": ver.id,
            "version": ver.version,
            "status": ver.status,
            "created_at": ver.created_at.isoformat(),
            "indexing_job": {
                "id": job.id if job else None,
                "status": job.status if job else None,
                "chunk_count": job.chunk_count if job else None,
                "completed_at": job.completed_at.isoformat() if job and job.completed_at else None,
                "index_path": job.index_path if job else None,
            } if job else None,
            "index_meta": index_meta,
            "indexing_profile_ref": indexing_profile,
            "chunks_preview": chunks_preview,
            "source_documents": manifest.get("source", {}).get("documents", []),
        })

    return {
        "id": asset.id,
        "type": asset.type,
        "name": asset.name,
        "classification": asset.classification,
        "owner_org": asset.owner_org,
        "owner_creator_id": asset.owner_creator_id,
        "created_at": asset.created_at.isoformat(),
        "versions": versions_info,
        "search_config": {
            "method": "hybrid",
            "vector_store": "ChromaDB (HNSW, cosine)",
            "keyword_index": "BM25 (Okapi BM25, whitespace tokenizer)",
            "fusion": "RRF (Reciprocal Rank Fusion)",
            "default_alpha": 0.5,
            "default_top_k": 5,
        },
    }


@router.patch("/assets/{asset_id}/versions/{version_id}/chunk-tags", response_model=None)
async def update_chunk_tags(
    asset_id: str,
    version_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> dict | JSONResponse:
    """Add or replace tags for a specific chunk within an asset version.

    Blocked once the version is no longer mutable (`is_mutable`) — this is
    the concrete enforcement of "승인 Version을 수정하는 Update 코드를
    만들지 않는다": an APPROVED/IN_REVIEW/SUSPENDED/DEPRECATED/RETIRED
    version can never have its manifest edited in place again.
    """
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_EDIT_DRAFT, trace_id=trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    chunk_id: str | None = body.get("chunk_id")
    tags: list[str] | None = body.get("tags")
    if not chunk_id or tags is None:
        raise HTTPException(status_code=400, detail="chunk_id and tags are required")

    stmt = select(AssetVersion).where(
        AssetVersion.id == version_id, AssetVersion.asset_id == asset_id
    )
    version = (await db.execute(stmt)).scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    try:
        current_status = VersionStatus(version.status)
    except ValueError:
        current_status = None
    if current_status is None or not is_mutable(current_status):
        return error_response(
            status.HTTP_409_CONFLICT,
            "ASSET_STATE_TRANSITION_INVALID",
            f"현재 상태({version.status})의 버전은 수정할 수 없습니다.",
            trace_id,
        )

    manifest = dict(version.manifest or {})
    chunk_tags: dict = dict(manifest.get("chunk_tags") or {})
    sanitized = [str(t)[:64] for t in tags if str(t).strip()][:20]
    chunk_tags[chunk_id] = sanitized
    manifest["chunk_tags"] = chunk_tags
    version.manifest = manifest
    await db.commit()
    return {"chunk_id": chunk_id, "tags": sanitized}


async def _trigger_indexing(
    job_id: str,
    version_id: str,
    storage_path: str,
    trace_id: str | None,
    classification: str | None,
    embed_model: str | None,
    caller: IndexingCaller,
    session_factory: SessionFactory,
) -> None:
    """Background task: call indexing-runtime to index the Knowledge package.

    Mirrors `routers.distributions._run_bundle_job`'s shape exactly: mark
    RUNNING via `session_factory` (never the module-level `AsyncSessionLocal`
    directly — see `get_indexing_session_factory`'s docstring for why),
    invoke `caller`, persist whatever comes back or mark FAILED on any
    exception. Both `caller`/`session_factory` are DI seams
    (`get_indexing_caller`/`get_indexing_session_factory`) so integration
    tests can override them via `app.dependency_overrides` instead of
    needing a real indexing-runtime process or the real `portal.db`.

    `trace_id` (the same id `record_audit`/the HTTP response for the upload
    request already used) is forwarded so indexing-runtime's own logs for
    this job correlate with the request that triggered it — see
    `indexing_runtime.main.IndexJobRequest.trace_id`. `None` is only reached
    from a caller that predates this parameter; indexing-runtime mints its
    own id in that case, unchanged from before.

    `classification` (D-062, additive/optional) is the raw manifest value —
    see the call site's comment for why this is not `Asset.classification`.

    `embed_model` (D-065 UPDATE / D-075, additive/optional) is the ADMIN-
    configured value from `portal_api.platform_settings` at the moment
    indexing was triggered (the call site reads it, not this function — see
    that call site's comment). `None` means "no admin override configured";
    the key is omitted entirely from the request body in that case (NOT
    sent as an explicit JSON `null`) because indexing-runtime's
    `IndexJobRequest.embed_model` is a non-Optional `str` field with its own
    default — sending `null` would fail that field's validation instead of
    falling through to it."""
    async with session_factory() as db:
        job = (
            await db.execute(select(IndexingJob).where(IndexingJob.id == job_id))
        ).scalar_one_or_none()
        if not job:
            return
        job.status = "RUNNING"
        await db.commit()

    job_body: dict = {
        "version_id": version_id,
        "storage_path": storage_path,
        "job_id": job_id,
        "index_base": str(settings.index_base),
        "trace_id": trace_id,
        "classification": classification,
    }
    # D-065 UPDATE / D-075: omit the key (never send an explicit JSON null)
    # when no admin override is configured — see this function's docstring
    # for why. indexing-runtime's own IndexJobRequest.embed_model default
    # then applies, exactly like every caller before this change.
    if embed_model is not None:
        job_body["embed_model"] = embed_model

    try:
        result = await caller(job_body)
    except Exception as e:  # noqa: BLE001 — must never crash the background task
        async with session_factory() as db:
            job = (
                await db.execute(select(IndexingJob).where(IndexingJob.id == job_id))
            ).scalar_one_or_none()
            if job:
                job.status = "FAILED"
                job.error_message = str(e)
                job.completed_at = datetime.now(UTC)
                await db.commit()
        return

    async with session_factory() as db:
        job = (
            await db.execute(select(IndexingJob).where(IndexingJob.id == job_id))
        ).scalar_one_or_none()
        if job:
            job.status = result.get("status", "COMPLETED")
            job.chunk_count = result.get("chunk_count")
            job.index_path = result.get("index_path")
            job.completed_at = datetime.now(UTC)
            await db.commit()
