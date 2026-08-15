"""Service/Deployment models — M02.

Field names mirror `packages/schemas/api/deployment.schema.json` where the
entities overlap. `ServiceDeployment.service_version_id` is an internal
publish-target pointer (not part of the wire-level ServiceDeployment schema,
which tracks the currently-published version only via DeploymentRevision) —
it lets `/publish` know which ServiceVersion to snapshot without requiring a
separate `/revisions` (update) endpoint, which is out of scope for this task.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from portal_api.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return str(uuid.uuid4())


class Service(Base):
    __tablename__ = "services"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    owner_org: Mapped[str] = mapped_column(String(128), nullable=False)
    owner_creator_id: Mapped[str] = mapped_column(String(256), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    versions: Mapped[list[ServiceVersion]] = relationship(
        "ServiceVersion", back_populates="service", cascade="all, delete-orphan"
    )


class ServiceVersion(Base):
    __tablename__ = "service_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(String(36), ForeignKey("services.id"), nullable=False)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="DRAFT")
    service_definition: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    # D-041 후속(ServiceVersion 자체 검토 체인): `routers/reviews.py`의
    # `decide_review`가 AssetVersion과 동일하게 다뤄 RELEASE 단계 APPROVE 시
    # `approved_at`을 채운다. `updated_at`은 `AssetVersion`과 동일한 관례
    # (감사/디버깅용 최종 변경 시각) — 검토 체인 자체는 이 컬럼을 읽지 않는다.
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    service: Mapped[Service] = relationship("Service", back_populates="versions")


class ServiceDeployment(Base):
    __tablename__ = "service_deployments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(String(36), ForeignKey("services.id"), nullable=False)
    # Internal: ServiceVersion to use for the *next* publish. See module docstring.
    service_version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("service_versions.id"), nullable=False
    )
    slug: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    environment: Mapped[str] = mapped_column(String(16), nullable=False)
    access_policy: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="PENDING")
    target_orgs: Mapped[list | None] = mapped_column(JSON, nullable=True)
    target_roles: Mapped[list | None] = mapped_column(JSON, nullable=True)
    active_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_by: Mapped[str] = mapped_column(String(256), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    # 10-hosted-chatbot-publication.md §11.1 / §8 게시 수명주기 — populated by
    # POST /deployments/{id}/suspend, cleared by /resume. NOTE(schema drift):
    # `init_db()` uses `create_all`, which never ALTERs an existing table —
    # see the ALTER TABLE note in the task report for the running portal.db.
    suspended_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    suspend_reason: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    # §8 게시 수명주기 — RETIRED는 종료 상태다. `retired_at`이 채워진 Deployment는
    # 재개·롤백·Update·재게시 어느 경로로도 되살아나지 않으며, Slug도 계속 점유해
    # 같은 URL이 다른 챗봇으로 조용히 재사용되지 않는다.
    retired_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retire_reason: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    revisions: Mapped[list[DeploymentRevision]] = relationship(
        "DeploymentRevision", back_populates="deployment", cascade="all, delete-orphan"
    )


class DeploymentRevision(Base):
    __tablename__ = "deployment_revisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    deployment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("service_deployments.id"), nullable=False
    )
    revision_number: Mapped[int] = mapped_column(Integer, nullable=False)
    service_version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("service_versions.id"), nullable=False
    )
    resolved_dependency_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="PENDING")
    publish_job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_by: Mapped[str] = mapped_column(String(256), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    deployment: Mapped[ServiceDeployment] = relationship(
        "ServiceDeployment", back_populates="revisions"
    )
