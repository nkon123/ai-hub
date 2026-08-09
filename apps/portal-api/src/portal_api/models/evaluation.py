"""Knowledge Evaluation models — M02, P12 (01-portal-and-distribution.md §2).

`EvaluationResultRecord` follows the same synchronous-with-polling job shape
as `IndexingJob` (status PENDING -> RUNNING -> COMPLETED/FAILED) rather than
introducing a separate job table, per the task brief. The full validated
`evaluation-result.json` payload (evaluation-result.schema.json,
`SchemaType.EVALUATION_RESULT`) is stored verbatim in `result_payload` once
the run completes; the columns alongside it exist so the list/detail
endpoints and the "이전 버전 대비 변화" comparison lookup can query without
deserializing that JSON blob every time.

Never renamed to `EvaluationResult` — that name is `evaluation_runner`'s own
public dataclass (the in-memory result of one run). Keeping the DB model's
name distinct avoids confusing the two in `routers/evaluations.py`, which
imports both.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from portal_api.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return str(uuid.uuid4())


class EvaluationResultRecord(Base):
    __tablename__ = "evaluation_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    asset_version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("asset_versions.id"), nullable=False
    )

    # Job status vocabulary, same as IndexingJob (PENDING/RUNNING/COMPLETED/FAILED).
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="PENDING")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Queryable columns lifted out of result_payload once the run completes
    # (task brief: "Store ... plus queryable columns").
    dataset_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    dataset_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    dataset_review_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    evaluated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    gate_passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # CLAUDE.md 구현 원칙 9 — trace id of the portal-api request that
    # triggered this run (distinct from run_id above, which is
    # evaluation_runner's own per-run correlation id across search-runtime
    # calls; same relationship as IndexingJob vs. its request trace_id).
    trace_id: Mapped[str] = mapped_column(String(64), nullable=False)
    requested_by: Mapped[str] = mapped_column(String(256), nullable=False)

    # Full validated evaluation-result.json (SchemaType.EVALUATION_RESULT).
    # NULL until status=COMPLETED.
    result_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class EvaluationNote(Base):
    """검토자가 기록하는 기준 미달 사유 (P12: "검토자는 ... 기준 미달 사유를
    기록할 수 있다"). Append-only — no update/delete endpoint, matching the
    audit-trail spirit of ReviewDecision.comments."""

    __tablename__ = "evaluation_notes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    evaluation_result_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("evaluation_results.id"), nullable=False
    )
    author_id: Mapped[str] = mapped_column(String(256), nullable=False)
    author_role: Mapped[str] = mapped_column(String(32), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
