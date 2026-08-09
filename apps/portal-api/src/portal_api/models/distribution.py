"""DistributionRequest model — M02, `07-data-api-contracts.md` §3.8 +
operational Job fields from §3.7/§4.4 (status/stage/error/bundle metadata).

portal-api owns this row end to end: it resolves the dependency graph from
its own Registry tables, calls distribution-service's `POST /bundle/v1/jobs`
with the fully-resolved payload, and persists the result here. See
`routers/distributions.py` module docstring for the full flow.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from portal_api.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return str(uuid.uuid4())


class DistributionRequest(Base):
    __tablename__ = "distribution_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)

    # §3.8 fields — root_type is ASSET_VERSION|SERVICE_VERSION
    root_type: Mapped[str] = mapped_column(String(16), nullable=False)
    root_id: Mapped[str] = mapped_column(String(36), nullable=False)
    mode: Mapped[str] = mapped_column(String(16), nullable=False)  # ONLINE|OFFLINE_BUNDLE
    target_site_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    office_profile_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    requested_by: Mapped[str] = mapped_column(String(256), nullable=False)

    # §10.4 Job status vocabulary (QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED)
    # plus §4.4's more granular `stage` for Offline Bundle progress.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="QUEUED")
    stage: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # §4.4 failure reporting: 실패 단계(=stage above)/오류코드/영향 자산/재시도 가능 여부.
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    affected_assets: Mapped[list | None] = mapped_column(JSON, nullable=True)
    retryable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # Bundle result metadata (populated on SUCCEEDED). `bundle_path` is a
    # server-computed absolute path from distribution-service's object_id
    # storage adapter — never derived from user input.
    bundle_object_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    bundle_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    bundle_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bundle_checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    manifest_summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
