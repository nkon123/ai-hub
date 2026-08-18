"""Knowledge Evaluation router — M02, P12 Knowledge 품질
(01-portal-and-distribution.md §2 P12 / 04-knowledge-platform.md §4.4-§4.8).

  POST /api/v1/assets/{asset_id}/versions/{version_id}/evaluations — run
  GET  /api/v1/assets/{asset_id}/versions/{version_id}/evaluations — list (newest first)
  GET  /api/v1/evaluations/{evaluation_id}                          — detail
  POST /api/v1/evaluations/{evaluation_id}/notes                    — 기준 미달 사유

portal-api owns the `EvaluationResultRecord` row (same synchronous-with-
polling job shape as `IndexingJob`: PENDING -> RUNNING -> COMPLETED/FAILED)
and only ever imports `evaluation_runner`'s public API (`run_evaluation`,
`load_dataset`, `load_policy`, `compare_versions`, ...) — never its
internals, and never re-implements the §4.4 metric math or §4.7 gate logic
that package already owns (CLAUDE.md 구현 원칙 2, 3). The actual network call
this background job makes is `evaluation_runner.HttpSearchClient` ->
search-runtime's `POST /search/v1/query`, mirroring `_trigger_indexing` in
`routers/assets.py` (background task calls another runtime over HTTP, then
persists whatever comes back).

Evaluation Dataset storage doesn't exist yet (open-decisions.md D-055) — the
PoC discovery convention (`_find_dataset_path`) scans
`fixtures/valid/*/evaluation-dataset.json` for one whose own
`knowledge_asset_id` field matches. "검토자는 평가 질문을 추가"(editing that
dataset through the UI) is explicitly out of scope; see D-055.

Masking (P12: "운영 사용자가 원문 전체를 볼 권한이 없다면 평가 결과에서도
문서 내용을 마스킹한다") has no target today: `evaluation-result.schema.json`'s
`per_case` carries no document content at all (no excerpt, no document
text) — only ids, verdicts, and timings, which are metadata, not "문서
내용". `get_evaluation` therefore applies no redaction and says so plainly
in the response (`source_masking_note`) instead of showing a masking
indicator that never fires. `Permission.EVALUATION_SOURCE_VIEW` (see
open-decisions.md D-056) is still defined and still assigned to roles — it
is the enforcement point for the day a document-content field (e.g.
`retrieved_excerpt`) is added to that schema.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from ai_asset_schemas.validator import SchemaType, validate
from evaluation_runner import (
    DatasetLoadError,
    DatasetMismatchError,
    EvaluationDataset,
    HttpSearchClient,
    QualityGatePolicy,
    QualityGatePolicyError,
    compare_versions,
    load_dataset,
    load_policy,
    run_evaluation,
)
from evaluation_runner import EvaluationResult as EvalRunnerResult
from fastapi import APIRouter, BackgroundTasks, Depends, status
from fastapi.responses import JSONResponse
from observability import get_trace_id
from security_policy import Permission, Role
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import AsyncSessionLocal, get_db
from portal_api.errors import error_response, not_found
from portal_api.models import (
    Asset,
    AssetVersion,
    EvaluationNote,
    EvaluationResultRecord,
    IndexingJob,
)
from portal_api.rbac import require_permission
from portal_api.schemas import (
    CreateEvaluationNoteRequest,
    CreateEvaluationResponseOut,
    EvaluationAclCaseResultOut,
    EvaluationCaseResultOut,
    EvaluationComparisonOut,
    EvaluationDetailOut,
    EvaluationListResponse,
    EvaluationNoteOut,
    EvaluationSummaryOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["evaluations"])

_NO_DOCUMENT_CONTENT_NOTE = (
    "저장된 평가 결과에는 문서 원문(발췌)이 포함되어 있지 않아 현재는 마스킹 대상이 없습니다. "
    "질문, 문서 ID, 판정 결과를 포함한 모든 항목이 인증된 모든 역할에게 그대로 노출됩니다. "
    "향후 검색 결과 발췌 등 문서 원문 필드가 추가되면 EVALUATION_SOURCE_VIEW 권한에 따라 "
    "마스킹이 적용됩니다."
)

SessionFactory = Callable[[], AsyncSession]


class EvaluationCaller(Protocol):
    """Adapter seam so integration tests never need a live search-runtime —
    mirrors `routers.distributions.get_distribution_caller` exactly."""

    def __call__(
        self,
        *,
        dataset: EvaluationDataset,
        knowledge_id: str,
        policy: QualityGatePolicy,
        baseline_recall_at_5: float | None,
    ) -> Awaitable[dict]: ...


def _trace_id() -> str:
    # See portal_api.routers.assets._trace_id — same rationale.
    return get_trace_id() or str(uuid.uuid4())


async def _run_via_search_runtime(
    *,
    dataset: EvaluationDataset,
    knowledge_id: str,
    policy: QualityGatePolicy,
    baseline_recall_at_5: float | None,
) -> dict:
    client = HttpSearchClient(
        base_url=settings.search_runtime_url, timeout_seconds=settings.evaluation_timeout_seconds
    )
    result = await run_evaluation(
        search_client=client,
        dataset=dataset,
        knowledge_id=knowledge_id,
        policy=policy,
        baseline_recall_at_5=baseline_recall_at_5,
    )
    return result.to_dict()


def get_evaluation_caller() -> EvaluationCaller:
    """FastAPI dependency seam — overridden in integration tests, same
    pattern as `get_distribution_caller`."""
    return _run_via_search_runtime


def get_session_factory() -> SessionFactory:
    """Background task's own DB session seam — see
    `routers.distributions.get_session_factory` docstring for why this can't
    just import `AsyncSessionLocal` directly."""
    return AsyncSessionLocal


def _find_dataset_path(knowledge_asset_id: str) -> Path | None:
    """PoC discovery convention (open-decisions.md D-055): scan every
    `*/evaluation-dataset.json` fixture for one whose own `knowledge_asset_id`
    matches. Returns the first match (sorted for determinism)."""
    root = settings.evaluation_fixtures_root
    if not root.exists():
        return None
    for candidate in sorted(root.glob("*/evaluation-dataset.json")):
        try:
            data = json.loads(candidate.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("knowledge_asset_id") == knowledge_asset_id:
            return candidate
    return None


async def _find_previous_version(
    db: AsyncSession, asset_id: str, current: AssetVersion
) -> AssetVersion | None:
    """The AssetVersion of the same asset immediately preceding `current` by
    creation time — the "이전 버전" P12's comparison section refers to."""
    stmt = (
        select(AssetVersion)
        .where(AssetVersion.asset_id == asset_id, AssetVersion.id != current.id)
        .where(AssetVersion.created_at < current.created_at)
        .order_by(AssetVersion.created_at.desc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _find_latest_completed_evaluation(
    db: AsyncSession, asset_version_id: str
) -> EvaluationResultRecord | None:
    stmt = (
        select(EvaluationResultRecord)
        .where(
            EvaluationResultRecord.asset_version_id == asset_version_id,
            EvaluationResultRecord.status == "COMPLETED",
        )
        .order_by(EvaluationResultRecord.created_at.desc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


@router.post(
    "/assets/{asset_id}/versions/{version_id}/evaluations",
    response_model=CreateEvaluationResponseOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_evaluation(
    asset_id: str,
    version_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    caller: EvaluationCaller = Depends(get_evaluation_caller),
    session_factory: SessionFactory = Depends(get_session_factory),
) -> CreateEvaluationResponseOut | JSONResponse:
    trace_id = _trace_id()

    version = (
        await db.execute(
            select(AssetVersion).where(
                AssetVersion.id == version_id, AssetVersion.asset_id == asset_id
            )
        )
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    asset = (await db.execute(select(Asset).where(Asset.id == asset_id))).scalar_one_or_none()
    if asset is None:
        return not_found("자산을 찾을 수 없습니다.", trace_id)
    if asset.type != "knowledge":
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "Knowledge 자산만 평가를 실행할 수 있습니다.",
            trace_id,
        )

    denial = await require_permission(
        db, user, Permission.EVALUATION_RUN, trace_id=trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    # CREATOR may only run an evaluation on Knowledge they own — same
    # ownership pattern as `routers.reviews.submit_asset_version`. ADMIN and
    # the two reviewer roles are not ownership-scoped (RBAC decision, task
    # brief item 4).
    if user.role == Role.CREATOR.value and asset.owner_creator_id != user.user_id:
        await record_audit(
            db,
            event_type="EVALUATION_RUN_DENIED",
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
            "본인이 소유한 Knowledge만 평가를 실행할 수 있습니다.",
            trace_id,
        )

    indexing_job = (
        await db.execute(
            select(IndexingJob)
            .where(IndexingJob.asset_version_id == version_id, IndexingJob.status == "COMPLETED")
            .order_by(IndexingJob.completed_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if indexing_job is None:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "VALIDATION_ERROR",
            "아직 인덱싱이 완료되지 않은 버전은 평가를 실행할 수 없습니다.",
            trace_id,
        )

    dataset_path = _find_dataset_path(asset_id)
    if dataset_path is None:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "EVALUATION_DATASET_NOT_FOUND",
            "이 Knowledge에 대한 평가 데이터셋이 아직 등록되지 않았습니다. Evaluation Dataset "
            "등록/편집 화면은 아직 구현되지 않았습니다 "
            "(docs/implementation-spec/open-decisions.md D-055).",
            trace_id,
        )

    try:
        dataset = load_dataset(dataset_path)
    except DatasetLoadError as exc:
        return error_response(status.HTTP_400_BAD_REQUEST, "VALIDATION_ERROR", str(exc), trace_id)

    try:
        policy = load_policy(settings.evaluation_quality_gate_policy)
    except QualityGatePolicyError as exc:
        return error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", str(exc), trace_id
        )

    record = EvaluationResultRecord(
        asset_version_id=version_id,
        status="PENDING",
        trace_id=trace_id,
        requested_by=user.user_id,
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)

    await record_audit(
        db,
        event_type="EVALUATION_REQUESTED",
        actor=user,
        resource_type="EVALUATION",
        resource_id=record.id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"asset_version_id": version_id, "dataset_id": dataset.dataset_id},
    )

    background_tasks.add_task(
        _run_evaluation_job, record.id, dataset, version_id, policy, caller, session_factory
    )

    logger.info(
        "evaluation.create trace_id=%s evaluation_id=%s asset_version_id=%s",
        trace_id, record.id, version_id,
    )
    return CreateEvaluationResponseOut(id=record.id, status=record.status)


async def _run_evaluation_job(
    evaluation_id: str,
    dataset: EvaluationDataset,
    knowledge_id: str,
    policy: QualityGatePolicy,
    caller: EvaluationCaller,
    session_factory: SessionFactory,
) -> None:
    """Background task — mirrors `_trigger_indexing`'s shape: mark RUNNING,
    call the runtime (here: evaluation_runner.run_evaluation, which itself
    calls search-runtime over HTTP), validate + persist whatever comes back.
    Opens its own session via `session_factory` (see `get_session_factory`
    docstring)."""
    async with session_factory() as db:
        record = (
            await db.execute(
                select(EvaluationResultRecord).where(EvaluationResultRecord.id == evaluation_id)
            )
        ).scalar_one_or_none()
        if record is None:
            return
        record.status = "RUNNING"
        await db.commit()

        previous_version = None
        version = (
            await db.execute(select(AssetVersion).where(AssetVersion.id == knowledge_id))
        ).scalar_one_or_none()
        if version is not None:
            previous_version = await _find_previous_version(db, version.asset_id, version)

        baseline_recall_at_5: float | None = None
        if previous_version is not None:
            baseline = await _find_latest_completed_evaluation(db, previous_version.id)
            if baseline is not None and baseline.result_payload:
                baseline_recall_at_5 = (baseline.result_payload.get("metrics") or {}).get(
                    "recall_at_5"
                )

    try:
        payload = await caller(
            dataset=dataset,
            knowledge_id=knowledge_id,
            policy=policy,
            baseline_recall_at_5=baseline_recall_at_5,
        )
        validate(payload, SchemaType.EVALUATION_RESULT)
    except Exception as exc:  # noqa: BLE001 — must never crash the background task
        async with session_factory() as db:
            record = (
                await db.execute(
                    select(EvaluationResultRecord).where(EvaluationResultRecord.id == evaluation_id)
                )
            ).scalar_one_or_none()
            if record:
                record.status = "FAILED"
                record.error_message = f"평가 실행에 실패했습니다: {exc}"[:1000]
                record.completed_at = datetime.now(UTC)
                await db.commit()
        logger.warning("evaluation.run_failed evaluation_id=%s error=%s", evaluation_id, exc)
        return

    async with session_factory() as db:
        record = (
            await db.execute(
                select(EvaluationResultRecord).where(EvaluationResultRecord.id == evaluation_id)
            )
        ).scalar_one_or_none()
        if record is None:
            return
        record.status = "COMPLETED"
        record.result_payload = payload
        record.dataset_id = payload.get("dataset_id")
        record.dataset_version = payload.get("dataset_version")
        record.dataset_review_status = dataset.review_status.value
        evaluated_at = payload.get("evaluated_at")
        record.evaluated_at = datetime.fromisoformat(evaluated_at) if evaluated_at else None
        record.gate_passed = (payload.get("gate") or {}).get("passed")
        record.run_id = payload.get("run_id")
        record.completed_at = datetime.now(UTC)
        await db.commit()


@router.get(
    "/assets/{asset_id}/versions/{version_id}/evaluations", response_model=EvaluationListResponse
)
async def list_evaluations(
    asset_id: str,
    version_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> EvaluationListResponse | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ, trace_id=trace_id,
        resource_type="ASSET_VERSION", resource_id=version_id,
    )
    if denial:
        return denial

    version = (
        await db.execute(
            select(AssetVersion).where(
                AssetVersion.id == version_id, AssetVersion.asset_id == asset_id
            )
        )
    ).scalar_one_or_none()
    if version is None:
        return not_found("자산 버전을 찾을 수 없습니다.", trace_id)

    stmt = (
        select(EvaluationResultRecord)
        .where(EvaluationResultRecord.asset_version_id == version_id)
        .order_by(EvaluationResultRecord.created_at.desc())
    )
    records = (await db.execute(stmt)).scalars().all()
    return EvaluationListResponse(items=[EvaluationSummaryOut.model_validate(r) for r in records])


async def _build_comparison(
    db: AsyncSession, record: EvaluationResultRecord
) -> EvaluationComparisonOut:
    """04-knowledge-platform.md §4.6 — reuses `evaluation_runner.compare_versions`
    verbatim (no metric re-implementation, per CLAUDE.md 구현 원칙 3).
    `available=False` is a real, distinct state from "no change" — the UI
    must render it as "비교 불가", never as a zeroed diff."""
    if record.status != "COMPLETED" or not record.result_payload:
        return EvaluationComparisonOut(
            available=False, reason="이 평가가 아직 완료되지 않아 이전 버전과 비교할 수 없습니다."
        )

    version = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == record.asset_version_id))
    ).scalar_one_or_none()
    if version is None:
        return EvaluationComparisonOut(available=False, reason="자산 버전 정보를 찾을 수 없습니다.")

    previous_version = await _find_previous_version(db, version.asset_id, version)
    if previous_version is None:
        return EvaluationComparisonOut(
            available=False,
            reason="비교할 이전 버전이 없습니다 (이 Knowledge의 첫 번째 버전입니다).",
        )

    baseline = await _find_latest_completed_evaluation(db, previous_version.id)
    if baseline is None or not baseline.result_payload:
        return EvaluationComparisonOut(
            available=False,
            reason=f"이전 버전(v{previous_version.version})에 완료된 평가 결과가 없습니다.",
        )

    try:
        baseline_result = EvalRunnerResult.from_dict(baseline.result_payload)
        candidate_result = EvalRunnerResult.from_dict(record.result_payload)
        report = compare_versions(baseline_result, candidate_result)
    except DatasetMismatchError as exc:
        return EvaluationComparisonOut(available=False, reason=str(exc))

    return EvaluationComparisonOut(
        available=True,
        baseline_evaluation_id=baseline.id,
        baseline_asset_version_id=baseline.asset_version_id,
        recall_at_1_delta=report.recall_at_1_delta,
        recall_at_5_delta=report.recall_at_5_delta,
        mrr_delta=report.mrr_delta,
        latency_p95_delta_ms=report.latency_p95_delta_ms,
        no_result_rate_delta=report.no_result_rate_delta,
        improved_case_ids=report.improved_case_ids,
        regressed_case_ids=report.regressed_case_ids,
        new_case_ids=report.new_case_ids,
        removed_case_ids=report.removed_case_ids,
        recommendation=report.recommendation,
        blocking_reasons=report.blocking_reasons,
    )


def _known_limitations(record: EvaluationResultRecord, payload: dict) -> list[str]:
    """Real, already-recorded limitations only — never fabricated (task
    brief item on "알려진 제한사항"). Branches on the record's actual
    payload, not a static list, so this stays true as the Quality Gate's
    scope changes (2026-08-16 ACL Test, 2026-08-17 Package Smoke Test)."""
    limitations: list[str] = []
    if record.dataset_review_status == "AI_GENERATED_UNREVIEWED":
        limitations.append(
            "이 평가에 사용된 Evaluation Dataset은 review_status=AI_GENERATED_UNREVIEWED입니다 "
            "(open-decisions.md D-045) — 업무 전문가 검토를 거쳐 EXPERT_REVIEWED로 전환되기 "
            "전까지는 D-013 품질 기준의 공식 판정 근거로 사용하지 않습니다."
        )

    metrics = payload.get("metrics") or {}
    limitations.append(
        "Quality Gate는 Recall@5 최소 기준, 이전 승인 버전 대비 회귀 한도, 검색 P95 지연시간, "
        "금지 문서 오검색 비율, 권한 안전성(ACL Test) 유출·가시성 비율, 제출된 경우 Package "
        "Smoke Test 결과를 판정합니다 (open-decisions.md D-045)."
    )
    if metrics.get("acl_case_count", 0) == 0:
        limitations.append(
            "이 평가는 ACL Test를 실행하지 않았습니다 — 이 Knowledge의 Evaluation Dataset에 "
            "acl_cases가 선언되어 있지 않습니다. 유출 비율이 0%로 보이더라도 이는 측정하지 "
            "않았다는 뜻이며 안전하다는 증거가 아닙니다."
        )
    if payload.get("package_smoke_test") is None:
        limitations.append(
            "Package Smoke Test 결과가 제출되지 않았습니다 — 이 화면의 평가 실행은 Knowledge "
            "Package를 만들지 않습니다. 검증 보고서는 `package-knowledge verify --report-out`로 "
            "생성해 CLI 평가 실행(`evaluate-knowledge run --smoke-test-report`)에 첨부해야 "
            "이 화면과 Quality Gate에 반영됩니다."
        )
    return limitations


@router.get("/evaluations/{evaluation_id}", response_model=EvaluationDetailOut)
async def get_evaluation(
    evaluation_id: str,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> EvaluationDetailOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ASSET_READ, trace_id=trace_id,
        resource_type="EVALUATION", resource_id=evaluation_id,
    )
    if denial:
        return denial

    record = (
        await db.execute(
            select(EvaluationResultRecord).where(EvaluationResultRecord.id == evaluation_id)
        )
    ).scalar_one_or_none()
    if record is None:
        return not_found("평가 결과를 찾을 수 없습니다.", trace_id)

    # `Permission.EVALUATION_SOURCE_VIEW` (open-decisions.md D-056) is not
    # checked here: `evaluation-result.schema.json`'s `per_case[]` carries no
    # document content (excerpt/full text) to mask today — only ids,
    # verdicts, and timings, which every authenticated role may see per
    # P12's 전체 audience. The permission and its role assignments
    # (`security_policy.roles.ROLE_PERMISSIONS`) already exist for the day a
    # document-content field (e.g. `retrieved_excerpt`) is added to that
    # schema — adding such a field is the trigger to call
    # `has_permission(role, Permission.EVALUATION_SOURCE_VIEW)` here and
    # redact it for roles that lack it.
    payload = record.result_payload or {}
    per_case_out = [
        EvaluationCaseResultOut(
            case_id=c["case_id"],
            question=c["question"],
            expected_document_ids=c.get("expected_document_ids", []),
            retrieved_document_ids=c.get("retrieved_document_ids", []),
            hit_at_1=c["hit_at_1"],
            hit_at_5=c["hit_at_5"],
            reciprocal_rank=c["reciprocal_rank"],
            latency_ms=c["latency_ms"],
            returned_count=c["returned_count"],
            context_tokens=c["context_tokens"],
            forbidden_hit=c["forbidden_hit"],
            tags=c.get("tags", []),
        )
        for c in payload.get("per_case", [])
    ]

    per_acl_case_out = [
        EvaluationAclCaseResultOut(
            case_id=c["case_id"],
            question=c["question"],
            clearance=c["clearance"],
            forbidden_document_ids=c.get("forbidden_document_ids", []),
            retrieved_document_ids=c.get("retrieved_document_ids", []),
            leaked_document_ids=c.get("leaked_document_ids", []),
            leaked=c["leaked"],
            expected_visible_document_ids=c.get("expected_visible_document_ids", []),
            missing_visible_document_ids=c.get("missing_visible_document_ids", []),
            visibility_satisfied=c.get("visibility_satisfied"),
            returned_count=c["returned_count"],
            latency_ms=c["latency_ms"],
            tags=c.get("tags", []),
        )
        for c in payload.get("per_acl_case", [])
    ]

    comparison = await _build_comparison(db, record)

    notes_stmt = (
        select(EvaluationNote)
        .where(EvaluationNote.evaluation_result_id == evaluation_id)
        .order_by(EvaluationNote.created_at.asc())
    )
    notes = (await db.execute(notes_stmt)).scalars().all()

    return EvaluationDetailOut(
        id=record.id,
        asset_version_id=record.asset_version_id,
        status=record.status,
        error_message=record.error_message,
        dataset_id=record.dataset_id,
        dataset_version=record.dataset_version,
        dataset_review_status=record.dataset_review_status,
        evaluated_at=record.evaluated_at,
        gate_passed=record.gate_passed,
        run_id=record.run_id,
        trace_id=record.trace_id,
        requested_by=record.requested_by,
        created_at=record.created_at,
        completed_at=record.completed_at,
        source_masking_note=_NO_DOCUMENT_CONTENT_NOTE,
        retrieval_settings=payload.get("retrieval_settings"),
        metrics=payload.get("metrics"),
        gate=payload.get("gate"),
        per_case=per_case_out,
        per_acl_case=per_acl_case_out,
        package_smoke_test=payload.get("package_smoke_test"),
        comparison=comparison,
        known_limitations=_known_limitations(record, payload),
        notes=[EvaluationNoteOut.model_validate(n) for n in notes],
    )


@router.post(
    "/evaluations/{evaluation_id}/notes",
    response_model=EvaluationNoteOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_evaluation_note(
    evaluation_id: str,
    body: CreateEvaluationNoteRequest,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> EvaluationNoteOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.EVALUATION_NOTE, trace_id=trace_id,
        resource_type="EVALUATION", resource_id=evaluation_id,
    )
    if denial:
        return denial

    record = (
        await db.execute(
            select(EvaluationResultRecord).where(EvaluationResultRecord.id == evaluation_id)
        )
    ).scalar_one_or_none()
    if record is None:
        return not_found("평가 결과를 찾을 수 없습니다.", trace_id)

    reason = body.reason.strip()
    if not reason:
        return error_response(
            status.HTTP_400_BAD_REQUEST, "VALIDATION_ERROR", "사유를 입력하세요.", trace_id
        )

    note = EvaluationNote(
        evaluation_result_id=evaluation_id,
        author_id=user.user_id,
        author_role=user.role,
        reason=reason,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)

    await record_audit(
        db,
        event_type="EVALUATION_NOTE_RECORDED",
        actor=user,
        resource_type="EVALUATION",
        resource_id=evaluation_id,
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"reason_length": len(reason)},
    )

    return EvaluationNoteOut.model_validate(note)
