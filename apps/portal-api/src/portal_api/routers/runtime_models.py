"""Runtime Model router — M02, open-decisions.md D-093.

  GET /api/v1/runtime-models                      — list
  GET /api/v1/runtime-models/{model_id}            — detail
  GET /api/v1/runtime-models/{model_id}/download   — GGUF weight file (Range resume)
  GET /api/v1/runtime-models/{model_id}/modelfile  — Ollama Modelfile as text

Contract: `packages/schemas/api/portal-openapi.yaml` (`runtime-models` tag),
`packages/schemas/manifests/runtime-model-manifest.schema.json`. Read side
only — registration is out-of-band filesystem placement in this PoC (see
`portal_api.runtime_models` module docstring), so no request body here ever
becomes a filesystem path.

Permission: all four endpoints require `DOWNLOAD_READ` — the task brief
groups "목록·다운로드는 일반 사용자(Desktop이 자기 토큰으로 받는다)" as one
audience, and `DOWNLOAD_READ` is the existing permission already used for
`GET /api/v1/distributions/{id}/download` (granted to USER/CREATOR/AUDITOR/
ADMIN). No new permission is introduced (root CLAUDE.md 코드 규칙).
"""

from __future__ import annotations

import logging
import re
import uuid

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from observability import get_trace_id
from security_policy import Permission
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.database import get_db
from portal_api.errors import error_response, not_found
from portal_api.rbac import require_permission
from portal_api.runtime_models import (
    RuntimeModelManifest,
    list_manifests,
    load_manifest,
    resolve_model_file,
    resolve_modelfile,
)
from portal_api.schemas import RuntimeModelListResponse, RuntimeModelOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/runtime-models", tags=["runtime-models"])

_RANGE_START_ZERO = re.compile(r"^bytes=0-")


def _trace_id() -> str:
    return get_trace_id() or str(uuid.uuid4())


def _to_out(manifest: RuntimeModelManifest) -> RuntimeModelOut:
    return RuntimeModelOut(
        model_id=manifest.model_id,
        display_name=manifest.display_name,
        purpose=manifest.purpose,
        version=manifest.version,
        source_model=manifest.source_model,
        description=manifest.description,
        file_size_bytes=manifest.file_size_bytes,
        sha256=manifest.sha256,
        has_modelfile=manifest.has_modelfile,
        upload_status=manifest.upload_status,
        registered_at=manifest.registered_at,
    )


def _is_download_initiation(request: Request) -> bool:
    """True when this GET should be audited as a download "시작", false for
    a Range-resume continuation.

    Root spec (10.5) requires downloads to be audited, but a single logical
    download of a multi-gigabyte file can legitimately produce dozens of
    Range requests as a resumable client re-attaches after network drops.
    Auditing every one of those would let large-file downloads flood the
    audit log in a way no other download in this system does (the task
    brief calls this out explicitly). We audit once per logical download:
    a request with no `Range` header (a plain/full GET), or a `Range`
    header whose first byte-range starts at 0 (the download's true start,
    including a client that always issues an explicit `bytes=0-` for the
    first chunk). Any `Range` starting at a nonzero offset is treated as a
    continuation of an already-audited download and is not separately
    logged.
    """
    range_header = request.headers.get("range")
    if range_header is None:
        return True
    return bool(_RANGE_START_ZERO.match(range_header.strip()))


@router.get("", response_model=RuntimeModelListResponse)
async def list_runtime_models(
    request: Request,
    purpose: str | None = None,
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> RuntimeModelListResponse | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.DOWNLOAD_READ, trace_id=trace_id,
        resource_type="RUNTIME_MODEL", resource_id="-",
    )
    if denial:
        return denial

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    manifests = list_manifests()
    if purpose is not None:
        manifests = [m for m in manifests if m.purpose == purpose]

    total = len(manifests)
    start = (page - 1) * page_size
    page_items = manifests[start : start + page_size]

    return RuntimeModelListResponse(
        items=[_to_out(m) for m in page_items],
        page=page,
        page_size=page_size,
        total=total,
    )


@router.get("/{model_id}", response_model=RuntimeModelOut)
async def get_runtime_model(
    model_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> RuntimeModelOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.DOWNLOAD_READ, trace_id=trace_id,
        resource_type="RUNTIME_MODEL", resource_id=model_id,
    )
    if denial:
        return denial

    manifest = load_manifest(model_id)
    if manifest is None:
        return not_found("런타임 모델을 찾을 수 없습니다.", trace_id)
    return _to_out(manifest)


@router.get("/{model_id}/download", response_model=None)
async def download_runtime_model(
    model_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> FileResponse | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.DOWNLOAD_READ, trace_id=trace_id,
        resource_type="RUNTIME_MODEL", resource_id=model_id,
    )
    if denial:
        return denial

    manifest = load_manifest(model_id)
    if manifest is None:
        return not_found("런타임 모델을 찾을 수 없습니다.", trace_id)

    if manifest.upload_status != "READY":
        return error_response(
            status.HTTP_409_CONFLICT,
            "RUNTIME_MODEL_NOT_READY",
            "이 모델은 아직 업로드가 완료되지 않았습니다. 잠시 후 다시 시도하세요.",
            trace_id,
            details={"model_id": model_id, "upload_status": manifest.upload_status},
        )

    file_path = resolve_model_file(manifest)
    if file_path is None or not file_path.is_file():
        logger.error(
            "runtime_model.file_missing model_id=%s trace_id=%s", model_id, trace_id
        )
        return error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "RUNTIME_MODEL_FILE_MISSING",
            "모델 파일을 찾을 수 없습니다. 관리자에게 문의하세요.",
            trace_id,
            details={"model_id": model_id},
        )

    if _is_download_initiation(request):
        await record_audit(
            db,
            event_type="RUNTIME_MODEL_DOWNLOADED",
            actor=user,
            resource_type="RUNTIME_MODEL",
            resource_id=model_id,
            result="SUCCESS",
            trace_id=trace_id,
            metadata={
                "sha256": manifest.sha256,
                "file_size_bytes": manifest.file_size_bytes,
                "client_ip": request.client.host if request.client else None,
            },
        )

    # ETag is the file's sha256 (registered at manifest time), NOT
    # Starlette's default mtime+size-derived tag — see the download
    # endpoint's contract description in portal-openapi.yaml for why: a
    # resuming client's `If-Range: <this-etag>` only correctly detects a
    # replaced file if the tag is derived from content identity, not
    # filesystem metadata. `FileResponse.set_stat_headers` only
    # `setdefault`s the etag, so pre-setting it here in `headers=` wins.
    return FileResponse(
        path=file_path,
        media_type="application/octet-stream",
        filename=manifest.file_name,
        headers={
            "ETag": f'"{manifest.sha256}"',
            "X-Content-Sha256": manifest.sha256,
        },
    )


@router.get("/{model_id}/modelfile", response_model=None)
async def get_runtime_model_modelfile(
    model_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> PlainTextResponse | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.DOWNLOAD_READ, trace_id=trace_id,
        resource_type="RUNTIME_MODEL", resource_id=model_id,
    )
    if denial:
        return denial

    manifest = load_manifest(model_id)
    if manifest is None:
        return not_found("런타임 모델을 찾을 수 없습니다.", trace_id)

    if manifest.upload_status != "READY":
        return error_response(
            status.HTTP_409_CONFLICT,
            "RUNTIME_MODEL_NOT_READY",
            "이 모델은 아직 업로드가 완료되지 않았습니다. 잠시 후 다시 시도하세요.",
            trace_id,
            details={"model_id": model_id, "upload_status": manifest.upload_status},
        )

    if not manifest.has_modelfile:
        return not_found("이 모델에는 Modelfile이 등록되어 있지 않습니다.", trace_id)

    modelfile_path = resolve_modelfile(manifest)
    if modelfile_path is None or not modelfile_path.is_file():
        logger.error(
            "runtime_model.modelfile_missing model_id=%s trace_id=%s", model_id, trace_id
        )
        return error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "RUNTIME_MODEL_FILE_MISSING",
            "Modelfile을 찾을 수 없습니다. 관리자에게 문의하세요.",
            trace_id,
            details={"model_id": model_id},
        )

    content = modelfile_path.read_text(encoding="utf-8")

    await record_audit(
        db,
        event_type="RUNTIME_MODEL_MODELFILE_DOWNLOADED",
        actor=user,
        resource_type="RUNTIME_MODEL",
        resource_id=model_id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={},
    )

    return PlainTextResponse(content)
