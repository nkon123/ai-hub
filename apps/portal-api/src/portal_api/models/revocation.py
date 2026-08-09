"""AssetVersionRevocation model — M02, P16 긴급 Revocation.

01-portal-and-distribution.md §2 P16: "긴급 회수는 사유, 승인자, 효력 시각이
필수다." Modeled as its own append-only record rather than a new
`AssetVersion.status` value — the reviewed state machine in
`packages/security-policy/src/security_policy/transitions.py` already fully
covers the lifecycle (APPROVED → {SUSPENDED, DEPRECATED} → RETIRED); a
version can be revoked from *any* of those states (e.g. an already-APPROVED
version distributed org-wide that must be pulled immediately), so revocation
is an orthogonal distribution gate, not another status. Multiple rows per
version are allowed (a revocation is never edited/deleted once recorded —
CLAUDE.md 로그/불변성 원칙); "the active revocation" is whichever row has the
latest `effective_at` that is already `<= now()`, computed by the caller.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from portal_api.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return str(uuid.uuid4())


class AssetVersionRevocation(Base):
    __tablename__ = "asset_version_revocations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("asset_versions.id"), nullable=False
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    approver_id: Mapped[str] = mapped_column(String(256), nullable=False)
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


def effective_filter(now: datetime | None = None):
    """SQLAlchemy WHERE-clause fragment for "is this revocation row in
    effect right now" — `effective_at <= now`, the exact rule this module's
    docstring already states. This is the single source of truth for that
    comparison: every read/enforcement path that needs to know whether a
    revocation currently blocks something must filter through this
    function rather than re-typing `effective_at <= datetime.now(UTC)`
    itself, or two call sites can silently drift apart (e.g. a version
    shown as revoked in the catalog — D-072 — while it still installs fine,
    or the reverse). Used by
    `routers.distributions._effective_revoked_version_ids`/
    `_has_effective_revocation` (installation-time enforcement) and
    `routers.assets._attach_active_revocations` (D-072 catalog visibility).
    """
    now = now if now is not None else _now()
    return AssetVersionRevocation.effective_at <= now


def is_effective(effective_at: datetime, *, now: datetime | None = None) -> bool:
    """Python-side twin of `effective_filter`, for a value already fetched
    into memory rather than filtered in SQL (e.g. after picking "the latest
    row for this version" in application code — see
    `routers.reviews._revocation_out`). Normalizes naive datetimes to UTC
    first: SQLite/aiosqlite round-trips a `DateTime(timezone=True)` value as
    a naive string once it is read back in a *different* session than the
    one that inserted it, and every timestamp in this system is UTC by
    convention (`_now()` above), so a naive value is always assumed to
    already be UTC wall-clock time."""
    now = now if now is not None else _now()
    if effective_at.tzinfo is None:
        effective_at = effective_at.replace(tzinfo=UTC)
    return effective_at <= now
