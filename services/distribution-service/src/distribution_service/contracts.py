"""Internal M02 -> M03 job contract for `POST /bundle/v1/jobs`.

Not part of `packages/schemas/api/portal-openapi.yaml` — that file is the
Portal's public-facing API. This is a service-to-service contract, same tier
as indexing-runtime's `/indexing/v1/jobs` (also undocumented in the public
OpenAPI spec). portal-api (M02) owns all Registry DB access (CLAUDE.md 구현
원칙 2: no cross-module internal imports, and M03 has no DB connection at
all) — so every field a `BundleJobRequestItem` needs is resolved by
portal-api *before* the call, and this service treats `items` as already
DB-joined facts to package, not references to look up itself.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

RootType = Literal["ASSET_VERSION", "SERVICE_VERSION"]

# Role of a candidate within the dependency graph — drives install order
# (06-2 스펙 §6.2: "의존성 순서대로 Prompt/Knowledge/Agent/Service/Office
# Profile을 설치한다") and which assets/{...}/ subfolder it is packaged
# under.
CandidateRole = Literal["root", "agent", "knowledge", "mcp_tool", "prompt", "service"]

# `NOT_FOUND` is a synthetic status portal-api attaches when a declared
# binding (e.g. knowledge_bindings[].knowledge_id) could not be resolved to
# any AssetVersion row — the resolver treats that as DEPENDENCY_MISSING.
# `STANDARD_LOCAL_COPY` marks the D-034 agent/prompt fallback (see
# bundler.py) — never a DB-backed AssetVersion, so it has no lifecycle
# status and is never subject to the revocation/approval checks.
CandidateStatus = Literal[
    "DRAFT",
    "VALIDATING",
    "READY_FOR_REVIEW",
    "IN_REVIEW",
    "CHANGES_REQUESTED",
    "REJECTED",
    "APPROVED",
    "SUSPENDED",
    "DEPRECATED",
    "RETIRED",
    "NOT_FOUND",
    "STANDARD_LOCAL_COPY",
]


class BundleJobRequestItem(BaseModel):
    asset_id: str | None = None
    asset_type: str
    asset_name: str | None = None
    role: CandidateRole
    required: bool = True
    asset_version_id: str | None = None
    version: str | None = None
    status: CandidateStatus
    manifest: dict | None = None
    manifest_hash: str | None = None
    storage_path: str | None = None
    index_path: str | None = None
    chunk_count: int | None = None
    # P16 긴급 Revocation (01-portal-and-distribution.md §2) — orthogonal to
    # `status` (SUSPENDED/RETIRED). portal-api computes this from its own
    # `asset_version_revocations` table (`effective_at <= now()` at request
    # time) since this service has no DB connection of its own (see module
    # docstring) — True means an *emergency recall* is currently in force for
    # this exact AssetVersion, regardless of its lifecycle status (even an
    # APPROVED version can be revoked).
    revoked: bool = False


class KnownRevocation(BaseModel):
    """System-wide SUSPENDED/DEPRECATED/RETIRED AssetVersions portal-api
    knows about at build time (D-017) — broader than just this bundle's
    resolved items, so an offline Desktop install can cross-check any
    locally-installed asset, not only the ones freshly bundled."""

    asset_id: str
    asset_name: str | None = None
    asset_version_id: str
    version: str
    status: CandidateStatus


class BundleJobRequest(BaseModel):
    job_id: str
    trace_id: str
    root_type: RootType
    root_id: str
    target_site_id: str | None = None
    office_profile_version_id: str | None = None
    requested_by: str
    items: list[BundleJobRequestItem] = Field(default_factory=list)
    service_definition: dict | None = None
    known_revocations: list[KnownRevocation] = Field(default_factory=list)


class BundleJobError(BaseModel):
    stage: str
    code: str
    message: str
    affected_assets: list[str] = Field(default_factory=list)
    retryable: bool


class ManifestSummary(BaseModel):
    bundle_id: str
    included: list[dict]
    install_order: list[str]
    total_size_bytes: int
    file_count: int


class BundleJobResponse(BaseModel):
    status: Literal["SUCCEEDED", "FAILED"]
    stage: str
    bundle_object_id: str | None = None
    bundle_path: str | None = None
    bundle_size_bytes: int | None = None
    checksum: str | None = None
    manifest_summary: ManifestSummary | None = None
    error: BundleJobError | None = None
