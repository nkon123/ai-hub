"""Review workflow + Audit models — M02.

Field names mirror `docs/implementation-spec/07-data-api-contracts.md`
§3.6 (`ReviewRequest`/`ReviewDecision`) and §3.10 (`AuditEvent`).

Note: SQLAlchemy's `DeclarativeBase` reserves the attribute name `metadata`
for the class-level `MetaData` instance, so `AuditEvent`'s Python attribute
is `metadata_` while the underlying DB/JSON column stays named `metadata`
to match the spec field name.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from portal_api.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return str(uuid.uuid4())


class ReviewRequest(Base):
    __tablename__ = "review_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    subject_type: Mapped[str] = mapped_column(String(32), nullable=False)
    subject_id: Mapped[str] = mapped_column(String(36), nullable=False)
    stage: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="PENDING")
    requested_by: Mapped[str] = mapped_column(String(256), nullable=False)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    assigned_to: Mapped[str | None] = mapped_column(String(256), nullable=True)
    policy_version: Mapped[str | None] = mapped_column(String(32), nullable=True)


class ReviewDecision(Base):
    __tablename__ = "review_decisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    review_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("review_requests.id"), nullable=False
    )
    decision: Mapped[str] = mapped_column(String(16), nullable=False)
    reviewer_id: Mapped[str] = mapped_column(String(256), nullable=False)
    comments: Mapped[str] = mapped_column(Text, nullable=False)
    checklist_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    subject_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_type: Mapped[str] = mapped_column(String(16), nullable=False, default="USER")
    actor_id: Mapped[str] = mapped_column(String(256), nullable=False)
    organization_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    site_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    resource_type: Mapped[str] = mapped_column(String(32), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result: Mapped[str] = mapped_column(String(16), nullable=False)
    policy_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # DB/JSON field name is "metadata"; Python attribute is "metadata_" (see
    # module docstring). Never store prompt text, full documents, DB result
    # rows, or secrets here — sanitized summaries only (CLAUDE.md 로그 규칙).
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSON, nullable=True, default=dict)
