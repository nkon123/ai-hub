from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from portal_api.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return str(uuid.uuid4())


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    owner_org: Mapped[str] = mapped_column(String(128), nullable=False)
    owner_creator_id: Mapped[str] = mapped_column(String(256), nullable=False)
    classification: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    versions: Mapped[list[AssetVersion]] = relationship(
        "AssetVersion", back_populates="asset", cascade="all, delete-orphan"
    )


class AssetVersion(Base):
    __tablename__ = "asset_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    asset_id: Mapped[str] = mapped_column(String(36), ForeignKey("assets.id"), nullable=False)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="DRAFT")
    manifest: Mapped[dict] = mapped_column(JSON, nullable=False)
    manifest_hash: Mapped[str | None] = mapped_column(String(64))
    changelog: Mapped[str | None] = mapped_column(Text)
    storage_path: Mapped[str | None] = mapped_column(Text)
    # P06 버전 관리 자동검증 (01-portal-and-distribution.md §2 P06/P07).
    # Validation failure is NOT a lifecycle state — a version that fails
    # 자동검증 simply stays DRAFT/CHANGES_REQUESTED. `packages/security-policy`'s
    # reviewed `VersionStatus` enum has no FAILED member and this stays that
    # way (CLAUDE.md 원칙 2/3: the state machine is owned by M11, not
    # re-derived here) — these three columns record only the *last*
    # automated validation run's outcome, orthogonal to `status`.
    validation_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="NOT_RUN", server_default="NOT_RUN"
    )
    validation_errors: Mapped[list | None] = mapped_column(JSON, nullable=True)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deprecated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # P16 수명주기/회수 (01-portal-and-distribution.md §2 P16).
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 대체 버전 설정 — points a DEPRECATED/RETIRED version at its successor.
    # Self-referential FK; no `ondelete` because versions are never deleted
    # (CLAUDE.md: 승인 Version을 수정하는 Update 코드를 만들지 않는다 — the
    # row itself is immutable once APPROVED, only this pointer is settable
    # while the *source* version is DEPRECATED/RETIRED, enforced in the
    # router, not the schema).
    replacement_version_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("asset_versions.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    asset: Mapped[Asset] = relationship("Asset", back_populates="versions")
    indexing_jobs: Mapped[list[IndexingJob]] = relationship(
        "IndexingJob", back_populates="asset_version"
    )


class IndexingJob(Base):
    __tablename__ = "indexing_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    asset_version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("asset_versions.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="PENDING")
    error_message: Mapped[str | None] = mapped_column(Text)
    chunk_count: Mapped[int | None] = mapped_column()
    index_path: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    asset_version: Mapped[AssetVersion] = relationship(
        "AssetVersion", back_populates="indexing_jobs"
    )
