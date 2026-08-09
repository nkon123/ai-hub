"""add_service_version_review_timestamps

Revision ID: ce52d6d1f75a
Revises: 8c4652dd146b
Create Date: 2026-08-08 22:57:49.725131

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'ce52d6d1f75a'
down_revision: str | Sequence[str] | None = '8c4652dd146b'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema.

    D-041 후속(ServiceVersion 자체 검토 체인, open-decisions.md) —
    `routers/reviews.py`가 AssetVersion과 동일한 TECHNICAL→SECURITY→RELEASE
    체인을 ServiceVersion에도 재사용하는 데 필요한 최소 컬럼만 추가한다.
    `updated_at`은 NOT NULL이라 기존 6개 행이 제약을 통과하도록
    `server_default=CURRENT_TIMESTAMP`로 backfill한다 (validation_status를
    추가한 `8c4652dd146b`와 동일한 패턴). `batch_alter_table`은 이 테이블에
    아직 제약(FK 등)이 없어 필수는 아니지만, 이 프로젝트의 다른 모든
    `service_versions`/`asset_versions` 컬럼 추가 마이그레이션과 일관되게
    유지한다.
    """
    with op.batch_alter_table("service_versions", schema=None) as batch_op:
        batch_op.add_column(sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("service_versions", schema=None) as batch_op:
        batch_op.drop_column("updated_at")
        batch_op.drop_column("approved_at")
