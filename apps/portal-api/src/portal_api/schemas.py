"""Pydantic response/request schemas for Portal API."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AssetVersionRevocationSummaryOut(BaseModel):
    """D-072: catalog-facing revocation summary — see
    `AssetVersionOut.active_revocation` docstring for when it is populated
    and why `reason` may be null even for a revoked version. Deliberately a
    separate, smaller shape from `AssetVersionRevocationOut` (the P16
    lifecycle screen's, `LIFECYCLE_READ`-gated, response) — this one rides
    along on `ASSET_READ` (granted to every role) so it must never carry
    anything `ASSET_READ` alone shouldn't unlock."""

    effective_at: datetime
    reason: str | None = None


class AssetVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    asset_id: str
    version: str
    status: str
    manifest: dict
    created_at: datetime
    updated_at: datetime
    # P06 자동검증 (§2 P06/P07) — additive; existing consumers that only read
    # known fields are unaffected. Defaults mirror the migration's
    # server_default so old in-memory objects built without these columns
    # (none exist in this codebase, but future callers might) still validate.
    validation_status: str = "NOT_RUN"
    validation_errors: list[str] | None = None
    validated_at: datetime | None = None
    # P06 버전 히스토리 화면(대체 버전 표시)이 CREATOR 범위에서도 동작하도록
    # 하는 plain passthrough — 이미 `AssetVersion` 모델의 컬럼이라 Router
    # 변경 없이 `from_attributes`로 그대로 매핑된다. P16
    # `AssetVersionLifecycleItemOut`처럼 라벨(버전 문자열)까지 조인해서
    # 채우지는 않는다(그 엔드포인트는 LIFECYCLE_READ 전용이라 CREATOR가 쓸 수
    # 없다) — 화면이 같은 자산의 `versions[]` 배열에서 id로 직접 찾아
    # 라벨을 만든다.
    approved_at: datetime | None = None
    deprecated_at: datetime | None = None
    retired_at: datetime | None = None
    replacement_version_id: str | None = None
    # Populated only by `GET /assets/{asset_id}` (not `list_assets`, to avoid
    # an N+1 ReviewRequest lookup per version across the whole catalog) — the
    # PENDING ReviewRequest id for this version, if any. CREATOR lacks
    # `Permission.REVIEW_LIST` (that's reviewer-facing, P08 검토함) so this is
    # the only way the P06 screen's "검토 요청 취소" button can discover which
    # review to cancel without a second, reviewer-only API call.
    pending_review_id: str | None = None
    # D-072: populated only when this version currently has an *effective*
    # revocation (`effective_at <= now()`, computed via the shared
    # `models.revocation.effective_filter` predicate) — a future-dated
    # revocation must stay null here, it does not block installation yet.
    # Populated by `list_assets`/`get_asset`
    # (`routers.assets._attach_active_revocations`), which also decides
    # whether `reason` inside is visible to this caller's role.
    active_revocation: AssetVersionRevocationSummaryOut | None = None


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    type: str
    name: str
    owner_org: str
    owner_creator_id: str
    classification: str
    created_at: datetime
    updated_at: datetime
    versions: list[AssetVersionOut] = []


class AssetListResponse(BaseModel):
    items: list[AssetOut]
    page: int
    page_size: int
    total: int


class ManifestValidateRequest(BaseModel):
    """P05 자산 등록 Wizard의 사전(pre-submit) 검증 — `POST /api/v1/assets`와
    달리 아무것도 저장하지 않는다. `type`은 `_MANIFEST_TYPE_TO_SCHEMA`의 키와
    동일한 값(agent/knowledge/prompt/mcp_tool)이어야 한다."""

    type: str
    manifest: dict


class ManifestValidateResponseOut(BaseModel):
    valid: bool
    errors: list[str] = []


class PromptTemplateOut(BaseModel):
    content: str


class IndexingJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    asset_version_id: str
    status: str
    chunk_count: int | None
    error_message: str | None
    created_at: datetime
    completed_at: datetime | None


class ErrorDetail(BaseModel):
    code: str
    message: str
    trace_id: str
    details: dict | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


# --- Service / Deployment (M02 — Hosted Chatbot Publication) ---


class CreateServiceRequest(BaseModel):
    name: str
    service_definition: dict


class ServiceVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    service_id: str
    version: str
    status: str
    service_definition: dict
    created_at: datetime
    # D-041 후속(ServiceVersion 자체 검토 체인) — set by decide_review's
    # RELEASE-stage APPROVE, mirrors AssetVersionOut.approved_at.
    approved_at: datetime | None = None


class ServiceOut(BaseModel):
    """Parent Service identity — no version/definition payload."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    owner_org: str
    owner_creator_id: str
    created_at: datetime


class ServiceVersionSummaryOut(BaseModel):
    """Lightweight version reference used in list rows and version history —
    deliberately excludes `service_definition` (kept out of P17's list
    payload; the full definition is only fetched on the P19 detail view)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    version: str
    status: str
    created_at: datetime
    approved_at: datetime | None = None


class ServiceListItemOut(BaseModel):
    id: str
    name: str
    owner_org: str
    owner_creator_id: str
    created_at: datetime
    version_count: int
    latest_version: ServiceVersionSummaryOut | None = None


class ServiceListResponse(BaseModel):
    items: list[ServiceListItemOut]
    page: int
    page_size: int
    total: int


class ServiceDetailOut(BaseModel):
    """GET /services/{service_id} — identity + full version history
    (newest first), per P19 '버전과 변경이력' tab."""

    id: str
    name: str
    owner_org: str
    owner_creator_id: str
    created_at: datetime
    versions: list[ServiceVersionSummaryOut]


class ServiceVersionDetailOut(BaseModel):
    """GET /service-versions/{version_id} — the full ServiceVersion
    (including `service_definition`) plus its parent Service's identity."""

    id: str
    service_id: str
    version: str
    status: str
    service_definition: dict
    created_at: datetime
    approved_at: datetime | None = None
    service: ServiceOut | None = None


class ValidationCheckOut(BaseModel):
    name: str
    passed: bool
    message: str
    code: str | None = None


class ValidationResultOut(BaseModel):
    passed: bool
    checks: list[ValidationCheckOut]


class CreateDeploymentRequest(BaseModel):
    service_version_id: str
    slug: str
    environment: Literal["internal", "demo"]
    access_policy: Literal["INTERNAL_AUTHENTICATED", "DEMO_TOKEN"]
    target_orgs: list[str] | None = None
    target_roles: list[str] | None = None


class DeploymentRevisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    deployment_id: str
    revision_number: int
    service_version_id: str
    status: str
    created_at: datetime
    activated_at: datetime | None = None


class DeploymentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    service_id: str
    service_version_id: str
    slug: str
    environment: str
    access_policy: str
    status: str
    target_orgs: list[str] | None = None
    target_roles: list[str] | None = None
    active_revision_id: str | None = None
    deployment_url: str
    created_by: str
    created_at: datetime
    updated_at: datetime
    active_revision: DeploymentRevisionOut | None = None
    suspended_by: str | None = None
    suspended_at: datetime | None = None
    suspend_reason: str | None = None


class DeploymentListResponse(BaseModel):
    items: list[DeploymentOut]
    page: int
    page_size: int
    total: int


class PublishJobResponseOut(BaseModel):
    job_id: str
    deployment_url: str


class RollbackDeploymentRequest(BaseModel):
    reason: str
    target_revision_id: str | None = None


class DeploymentRevisionKnowledgeSummary(BaseModel):
    knowledge_id: str | None = None
    asset_name: str | None = None


class DeploymentRevisionSummaryOut(BaseModel):
    id: str
    revision_number: int
    service_version_id: str
    status: str
    created_by: str
    created_at: datetime
    activated_at: datetime | None = None
    knowledge: list[DeploymentRevisionKnowledgeSummary] = Field(default_factory=list)
    model_alias: str | None = None


class DeploymentRevisionListResponse(BaseModel):
    items: list[DeploymentRevisionSummaryOut]
    page: int
    page_size: int
    total: int


class ChatbotConfigOut(BaseModel):
    welcome_message: str | None = None
    suggested_questions: list[str] = Field(default_factory=list)
    citation_display: bool = True


class DeploymentBySlugOut(BaseModel):
    deployment_id: str
    slug: str
    status: str
    name: str
    chatbot_config: ChatbotConfigOut
    active_revision_id: str | None = None
    knowledge_id: str | None = None
    model_alias: str | None = None


# --- Review workflow (M02 — §3.6 ReviewRequest/ReviewDecision) ---


class SubmitReviewResponseOut(BaseModel):
    version_id: str
    status: str
    review_id: str
    stage: str


class ReviewRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    subject_type: str
    subject_id: str
    stage: str
    status: str
    requested_by: str
    requested_at: datetime
    assigned_to: str | None = None
    policy_version: str | None = None
    # Joined info for the review inbox (P08) — best-effort, None if the
    # subject can't be resolved (e.g. unsupported subject_type).
    asset_name: str | None = None
    asset_type: str | None = None
    version_label: str | None = None


class ReviewListResponse(BaseModel):
    items: list[ReviewRequestOut]
    page: int
    page_size: int
    total: int


class ReviewDecisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    review_id: str
    decision: str
    reviewer_id: str
    comments: str
    checklist_result: dict | None = None
    subject_hash: str | None = None
    decided_at: datetime


class ReviewHistoryEntryOut(BaseModel):
    stage: str
    status: str
    decision: str | None = None
    reviewer_id: str | None = None
    comments: str | None = None
    decided_at: datetime | None = None


class ReviewDetailOut(BaseModel):
    review: ReviewRequestOut
    subject_summary: dict
    history: list[ReviewHistoryEntryOut]


class DecideReviewRequest(BaseModel):
    decision: Literal["APPROVE", "REJECT", "REQUEST_CHANGES"]
    comments: str
    checklist_result: dict | None = None


class DecisionResultOut(BaseModel):
    review: ReviewRequestOut
    decision: ReviewDecisionOut
    version_status: str
    next_stage: str | None = None


class SuspendRequest(BaseModel):
    reason: str


class DeprecateRequest(BaseModel):
    reason: str


# --- P16 수명주기/회수 (01-portal-and-distribution.md §2 P16) ---


class RetireRequest(BaseModel):
    reason: str


class SetReplacementRequest(BaseModel):
    replacement_version_id: str
    reason: str


class CreateRevocationRequest(BaseModel):
    """§2 P16: "긴급 회수는 사유, 승인자, 효력 시각이 필수다." All three are
    optional here (not `str`/`datetime` required) so a missing field yields
    the project's own `VALIDATION_ERROR` envelope naming exactly which field
    is missing, rather than FastAPI's generic 422 — same pattern as
    `SuspendRequest`/`DeprecateRequest`'s manual non-empty check."""

    reason: str | None = None
    approver_id: str | None = None
    effective_at: datetime | None = None


class AssetVersionRevocationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    version_id: str
    reason: str
    approver_id: str
    effective_at: datetime
    created_at: datetime
    trace_id: str | None = None
    # Computed by the router (effective_at <= now()) — never stored, a
    # revocation row is immutable once created (append-only, see
    # `models/revocation.py`).
    effective: bool = False


class AssetVersionLifecycleItemOut(BaseModel):
    id: str
    asset_id: str
    asset_name: str
    asset_type: str
    version: str
    status: str
    approved_at: datetime | None = None
    deprecated_at: datetime | None = None
    retired_at: datetime | None = None
    replacement_version_id: str | None = None
    replacement_version_label: str | None = None
    active_revocation: AssetVersionRevocationOut | None = None


class AssetVersionLifecycleListResponse(BaseModel):
    items: list[AssetVersionLifecycleItemOut]
    page: int
    page_size: int
    total: int


class ImpactServiceOut(BaseModel):
    service_id: str
    service_name: str
    service_version_id: str
    version: str
    status: str


class ImpactDeploymentOut(BaseModel):
    deployment_id: str
    slug: str
    status: str


class ImpactDistributionOut(BaseModel):
    id: str
    root_type: str
    root_id: str
    status: str


class AssetVersionImpactOut(BaseModel):
    version_id: str
    services: list[ImpactServiceOut] = Field(default_factory=list)
    service_deployments: list[ImpactDeploymentOut] = Field(default_factory=list)
    distribution_requests: list[ImpactDistributionOut] = Field(default_factory=list)


# --- Audit (M02 — §3.10 AuditEvent) ---


class AuditEventOut(BaseModel):
    id: str
    timestamp: datetime
    event_type: str
    actor_type: str
    actor_id: str
    organization_id: str | None = None
    site_id: str | None = None
    resource_type: str
    resource_id: str
    resource_version: str | None = None
    trace_id: str | None = None
    run_id: str | None = None
    job_id: str | None = None
    result: str
    policy_id: str | None = None
    metadata: dict = Field(default_factory=dict)


class AuditEventListResponse(BaseModel):
    items: list[AuditEventOut]
    page: int
    page_size: int
    total: int


# --- Distribution / Offline Bundle (M02/M03 — §3.8, 01-portal-and-distribution.md §4) ---


class CreateDistributionRequest(BaseModel):
    root_type: Literal["ASSET_VERSION", "SERVICE_VERSION"]
    root_id: str
    mode: Literal["ONLINE", "OFFLINE_BUNDLE"]
    target_site_id: str | None = None
    office_profile_version_id: str | None = None
    # `requested_by` is intentionally NOT a client-supplied field — the
    # server derives it from the authenticated UserContext, same pattern as
    # `owner.creator_id` elsewhere in this API.


class DistributionRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    root_type: str
    root_id: str
    mode: str
    target_site_id: str | None = None
    office_profile_version_id: str | None = None
    requested_by: str
    status: str
    stage: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    affected_assets: list[str] | None = None
    retryable: bool | None = None
    bundle_object_id: str | None = None
    bundle_size_bytes: int | None = None
    bundle_checksum: str | None = None
    manifest_summary: dict | None = None
    trace_id: str | None = None
    created_at: datetime
    updated_at: datetime


class CreateDistributionResponseOut(BaseModel):
    id: str
    status: str


class DistributionListResponse(BaseModel):
    """§5.3 목록 응답 shape for `GET /api/v1/distributions`. Scoping (which
    rows land in `items`) is applied by the router, not here — see
    `routers/distributions.py::list_distributions`."""

    items: list[DistributionRequestOut]
    page: int
    page_size: int
    total: int


# --- P13 다운로드 이력 (01-portal-and-distribution.md §2 P13) ---


class DownloadHistoryEntryOut(BaseModel):
    """One row of the merged "다운로드 이력" view — see
    `routers/distributions.py::list_download_history` docstring for how the
    two underlying sources (`DistributionRequest` "Bundle 요청" rows and
    `AuditEvent` "실제 다운로드" rows) are combined without duplicating one
    into the other. Any field genuinely unavailable for a given row is
    `None` — the UI renders that as "미기재", never a guess or a blank that
    could be mistaken for a captured-but-empty value."""

    id: str
    kind: Literal["BUNDLE_REQUEST", "DOWNLOAD"]
    distribution_id: str
    user: str
    organization: str | None = None
    target_site: str | None = None
    root_type: str | None = None
    root_id: str | None = None
    asset_name: str | None = None
    version: str | None = None
    mode: str | None = None
    requested_at: datetime
    completed_at: datetime | None = None
    client_ip: str | None = None
    outcome: Literal["SUCCESS", "FAILURE", "DENIED", "CANCELLED", "IN_PROGRESS"]
    reason: str | None = None
    trace_id: str | None = None


class DownloadHistoryListResponse(BaseModel):
    items: list[DownloadHistoryEntryOut]
    page: int
    page_size: int
    total: int


# --- P12 Knowledge 품질 (evaluations) ---


class EvaluationSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    asset_version_id: str
    status: str
    error_message: str | None = None
    dataset_id: str | None = None
    dataset_version: str | None = None
    dataset_review_status: str | None = None
    evaluated_at: datetime | None = None
    gate_passed: bool | None = None
    run_id: str | None = None
    trace_id: str
    requested_by: str
    created_at: datetime
    completed_at: datetime | None = None


class EvaluationListResponse(BaseModel):
    items: list[EvaluationSummaryOut]


class CreateEvaluationResponseOut(BaseModel):
    id: str
    status: str


class EvaluationCaseResultOut(BaseModel):
    """Mirrors evaluation-result.schema.json's `per_case[]` verbatim. No
    field here is document content (excerpt/full text) — `question` is
    dataset-author-written, and the rest are ids/verdicts/timings — so
    nothing is masked; every authenticated role sees the same values. See
    open-decisions.md D-056 for why `EVALUATION_SOURCE_VIEW` exists anyway
    (it is unused until a document-content field is added to this schema)."""

    case_id: str
    question: str
    expected_document_ids: list[str]
    retrieved_document_ids: list[str]
    hit_at_1: bool
    hit_at_5: bool
    reciprocal_rank: float
    latency_ms: int
    returned_count: int
    context_tokens: int
    forbidden_hit: bool
    tags: list[str] = Field(default_factory=list)


class EvaluationComparisonOut(BaseModel):
    """04-knowledge-platform.md §4.6. `available=False` must be rendered by
    the UI as an explicit "no prior result to compare" state, never as an
    empty/zeroed diff."""

    available: bool
    reason: str | None = None
    baseline_evaluation_id: str | None = None
    baseline_asset_version_id: str | None = None
    recall_at_1_delta: float | None = None
    recall_at_5_delta: float | None = None
    mrr_delta: float | None = None
    latency_p95_delta_ms: float | None = None
    no_result_rate_delta: float | None = None
    improved_case_ids: list[str] = Field(default_factory=list)
    regressed_case_ids: list[str] = Field(default_factory=list)
    new_case_ids: list[str] = Field(default_factory=list)
    removed_case_ids: list[str] = Field(default_factory=list)
    recommendation: str | None = None
    blocking_reasons: list[str] = Field(default_factory=list)


class EvaluationNoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    evaluation_result_id: str
    author_id: str
    author_role: str
    reason: str
    created_at: datetime


class CreateEvaluationNoteRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=2048)


class EvaluationDetailOut(EvaluationSummaryOut):
    """`source_masking_note` states plainly (for the API consumer and the
    screen) that the stored evaluation result carries no document content,
    so no masking is applied to `per_case` today — see open-decisions.md
    D-056. It is not a per-role indicator; it reads the same for every
    role."""

    source_masking_note: str
    retrieval_settings: dict | None = None
    metrics: dict | None = None
    gate: dict | None = None
    per_case: list[EvaluationCaseResultOut] = Field(default_factory=list)
    comparison: EvaluationComparisonOut
    known_limitations: list[str] = Field(default_factory=list)
    notes: list[EvaluationNoteOut] = Field(default_factory=list)


# --- P06 버전 관리 / P07 내 자산 (01-portal-and-distribution.md §2 P06/P07) ---


class CreateAssetVersionRequest(BaseModel):
    version: str
    changelog: str | None = None


class UpdateAssetVersionRequest(BaseModel):
    changelog: str | None = None
    # Only `description`/`tags` are accepted — enforced by the router, not
    # here, so a disallowed key gets a named VALIDATION_ERROR rather than a
    # silently-ignored field.
    manifest_patch: dict | None = None


class MyAssetReviewDecisionSummaryOut(BaseModel):
    stage: str
    decision: str
    comments: str
    reviewer_id: str
    decided_at: datetime


class MyAssetVersionRowOut(BaseModel):
    id: str
    asset_id: str
    asset_name: str
    asset_type: str
    version: str
    status: str
    category: str
    validation_status: str
    validation_errors: list[str] | None = None
    validated_at: datetime | None = None
    latest_review_decision: MyAssetReviewDecisionSummaryOut | None = None
    can_create_new_version: bool
    can_edit: bool
    created_at: datetime
    updated_at: datetime


class MyAssetCategoryOut(BaseModel):
    code: str
    count: int
    items: list[MyAssetVersionRowOut]


class MyAssetsResponseOut(BaseModel):
    categories: list[MyAssetCategoryOut]
    total: int


class CancelReviewRequest(BaseModel):
    """§2 P06 "검토 요청과 취소" — 사유가 필수다. `str | None` (not required
    `str`) so a missing field yields this project's own VALIDATION_ERROR
    envelope naming the field, rather than FastAPI's generic 422 — same
    pattern as `CreateRevocationRequest`."""

    reason: str | None = None


class CancelReviewResponseOut(BaseModel):
    review: ReviewRequestOut
    version_status: str


# --- P15 관리자 설정 (01-portal-and-distribution.md §2 P15) ----------------
# Read-only "정책·구성 현황". Every section is AVAILABLE (sourced live from a
# real config/policy file, never a hand-copied snapshot) or NOT_IMPLEMENTED
# (named reason + open-decisions.md id) — see routers/admin.py for how each
# is built and open-decisions.md D-065 for why the other P15 sub-areas have
# no editor.


class NotImplementedInfoOut(BaseModel):
    reason: str
    decision_id: str


class RolePermissionRowOut(BaseModel):
    role: str
    permissions: list[str]


class UserRoleMappingSectionOut(BaseModel):
    status: Literal["AVAILABLE"] = "AVAILABLE"
    source: str
    roles: list[RolePermissionRowOut]
    note: str


class OrganizationSiteSectionOut(BaseModel):
    status: Literal["NOT_IMPLEMENTED"] = "NOT_IMPLEMENTED"
    not_implemented: NotImplementedInfoOut


class ModelAliasSettingOut(BaseModel):
    alias: str
    provider: str
    model_id: str
    endpoint: str
    max_context_tokens: int | None = None


class McpServerAliasSettingOut(BaseModel):
    alias: str
    endpoint: str
    allowed_tools: list[str] = Field(default_factory=list)


class OfficeProfileSectionOut(BaseModel):
    status: Literal["AVAILABLE"] = "AVAILABLE"
    source: str
    name: str
    version: str
    org: str
    sites: list[str] = Field(default_factory=list)
    max_classification_allowed: str | None = None
    audit_retention_days: int | None = None


class ModelEndpointAliasSectionOut(BaseModel):
    status: Literal["AVAILABLE"] = "AVAILABLE"
    source: str
    model_aliases: list[ModelAliasSettingOut]
    mcp_servers: list[McpServerAliasSettingOut]


class AssetSizeExtensionPolicySectionOut(BaseModel):
    status: Literal["AVAILABLE"] = "AVAILABLE"
    source: str
    portal_upload_limit_note: str
    knowledge_package_forbidden_filenames: list[str] = Field(default_factory=list)
    knowledge_package_fail_on_fatal: bool | None = None
    desktop_bundle_max_total_uncompressed_bytes: int | None = None
    desktop_bundle_max_single_file_uncompressed_bytes: int | None = None
    desktop_bundle_max_compression_ratio: float | None = None
    desktop_bundle_forbidden_archive_extensions: list[str] | None = None
    desktop_bundle_forbidden_executable_extensions: list[str] | None = None
    parse_error: str | None = None


class ApprovalWorkflowSectionOut(BaseModel):
    status: Literal["AVAILABLE"] = "AVAILABLE"
    source: str
    stage_chain: list[str]
    require_service_version_approval: bool
    require_service_version_approval_source: str


class SecurityClassificationSubsectionOut(BaseModel):
    status: Literal["AVAILABLE"] = "AVAILABLE"
    source: str
    classification_levels: list[str]
    acl_metadata_fields: list[str]
    allow_unknown_classification: bool
    allow_unknown_classification_caveat: str


class RetentionSubsectionOut(BaseModel):
    status: Literal["NOT_IMPLEMENTED"] = "NOT_IMPLEMENTED"
    not_implemented: NotImplementedInfoOut


class SecurityClassificationRetentionSectionOut(BaseModel):
    classification: SecurityClassificationSubsectionOut
    retention: RetentionSubsectionOut


class PackageTrustSignatureSectionOut(BaseModel):
    status: Literal["NOT_IMPLEMENTED"] = "NOT_IMPLEMENTED"
    not_implemented: NotImplementedInfoOut


# --- D-065 UPDATE / D-075: 인덱싱 임베딩 모델 (P15의 유일한 편집 가능 영역) -------


class IndexingEmbeddingModelSectionOut(BaseModel):
    status: Literal["AVAILABLE"] = "AVAILABLE"
    source: str
    configured_model: str | None = None
    updated_at: datetime | None = None
    updated_by: str | None = None
    note: str


class EmbeddingModelInfoOut(BaseModel):
    name: str
    embedding_capable: bool
    size: int | None = None
    modified_at: str | None = None


class EmbeddingModelsOut(BaseModel):
    models: list[EmbeddingModelInfoOut]
    default_embed_model: str
    source: str
    trace_id: str


class IndexingEmbeddingModelUpdateIn(BaseModel):
    model: str = Field(min_length=1)


class AdminSettingsOut(BaseModel):
    generated_at: datetime
    trace_id: str
    user_role_mapping: UserRoleMappingSectionOut
    organization_site: OrganizationSiteSectionOut
    office_profile: OfficeProfileSectionOut
    model_endpoint_alias: ModelEndpointAliasSectionOut
    asset_size_extension_policy: AssetSizeExtensionPolicySectionOut
    approval_workflow: ApprovalWorkflowSectionOut
    security_classification_retention: SecurityClassificationRetentionSectionOut
    package_trust_signature: PackageTrustSignatureSectionOut
    indexing_embedding_model: IndexingEmbeddingModelSectionOut
