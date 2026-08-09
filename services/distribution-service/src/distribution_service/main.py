"""Distribution Service entrypoint — M03.

`POST /bundle/v1/jobs` runs the full §4.4 stage machine synchronously (same
PoC shape as indexing-runtime's `/indexing/v1/jobs`: "Trigger ... and return
result synchronously") and returns a `BundleJobResponse`. portal-api (M02)
is the only expected caller — it owns Registry DB access and resolves every
`BundleJobRequestItem` before calling here (see `contracts.py`).
"""

from __future__ import annotations

import logging
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from observability import bind_trace_id, configure_logging

from distribution_service.bundler import (
    BundleStageError,
    build_zip_bytes,
    collect,
    package,
    verify,
)
from distribution_service.config import settings
from distribution_service.contracts import (
    BundleJobError,
    BundleJobRequest,
    BundleJobResponse,
    ManifestSummary,
)
from distribution_service.resolver import (
    AssetVersionRevokedError,
    DependencyMissingError,
    DependencyVersionConflictError,
    PackageRevokedError,
    resolve,
)
from distribution_service.storage import FileSystemStorageAdapter

# Structured, Trace ID-carrying logs to stdout — see observability.logging_config
# for why a plain logging.basicConfig() call is not sufficient under uvicorn.
configure_logging("distribution-service")
logger = logging.getLogger(__name__)

app = FastAPI(title="Distribution Service", version="0.1.0")

_storage = FileSystemStorageAdapter(settings.bundle_output_root)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": "0.1.0"})


@app.post("/bundle/v1/jobs", response_model=BundleJobResponse)
async def create_bundle_job(request: BundleJobRequest) -> BundleJobResponse:
    trace_id = request.trace_id
    bind_trace_id(trace_id)
    logger.info(
        "bundle.job.start trace_id=%s job_id=%s root_type=%s root_id=%s",
        trace_id,
        request.job_id,
        request.root_type,
        request.root_id,
    )

    # --- RESOLVING ---
    try:
        plan = resolve(request)
    except DependencyMissingError as exc:
        return _failure(
            "RESOLVING",
            "DEPENDENCY_MISSING",
            "필수 의존 자산을 찾을 수 없습니다.",
            [i.asset_id or i.asset_name or "?" for i in exc.items],
            retryable=False,
        )
    except DependencyVersionConflictError as exc:
        return _failure(
            "RESOLVING",
            "DEPENDENCY_VERSION_CONFLICT",
            "동일 자산이 서로 다른 버전으로 요구되었습니다.",
            list(exc.conflicts.keys()),
            retryable=False,
        )
    except AssetVersionRevokedError as exc:
        return _failure(
            "RESOLVING",
            "ASSET_VERSION_REVOKED",
            "긴급 회수(Revocation)된 버전은 Bundle에 포함할 수 없습니다.",
            [i.asset_id or i.asset_name or "?" for i in exc.items],
            retryable=False,
        )
    except PackageRevokedError as exc:
        return _failure(
            "RESOLVING",
            "PACKAGE_REVOKED",
            "중단(SUSPENDED) 또는 폐기(RETIRED)된 버전은 새 Bundle에 포함할 수 없습니다.",
            [i.asset_id or i.asset_name or "?" for i in exc.items],
            retryable=False,
        )

    # --- COLLECTING ---
    try:
        collected = collect(request, plan)
    except BundleStageError as exc:
        return _from_stage_error(exc)

    bundle_id = str(uuid.uuid4())
    zip_bytes, manifest = build_zip_bytes(request, plan, collected, bundle_id)

    # --- VERIFYING ---
    try:
        verify(zip_bytes, collected)
    except BundleStageError as exc:
        return _from_stage_error(exc)

    # --- PACKAGING ---
    try:
        stored = package(zip_bytes, bundle_id, _storage)
    except BundleStageError as exc:
        return _from_stage_error(exc)

    bundle_path = str(_storage.object_path(stored.object_id))
    logger.info(
        "bundle.job.succeeded trace_id=%s job_id=%s bundle_id=%s size=%d",
        trace_id,
        request.job_id,
        bundle_id,
        stored.size_bytes,
    )
    return BundleJobResponse(
        status="SUCCEEDED",
        stage="SUCCEEDED",
        bundle_object_id=stored.object_id,
        bundle_path=bundle_path,
        bundle_size_bytes=stored.size_bytes,
        checksum=stored.sha256,
        manifest_summary=ManifestSummary(
            bundle_id=bundle_id,
            included=manifest["included_assets"],
            install_order=manifest["install_order"],
            total_size_bytes=manifest["total_installed_size_bytes"],
            file_count=len(collected.files),
        ),
    )


def _from_stage_error(exc: BundleStageError) -> BundleJobResponse:
    return _failure(exc.stage, exc.code, exc.message, exc.affected_assets, exc.retryable)


def _failure(
    stage: str, code: str, message: str, affected_assets: list[str], retryable: bool
) -> BundleJobResponse:
    return BundleJobResponse(
        status="FAILED",
        stage=stage,
        error=BundleJobError(
            stage=stage,
            code=code,
            message=message,
            affected_assets=affected_assets,
            retryable=retryable,
        ),
    )
