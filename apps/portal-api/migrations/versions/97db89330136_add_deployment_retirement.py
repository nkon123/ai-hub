"""add_deployment_retirement

Revision ID: 97db89330136
Revises: eba969aa8e91
Create Date: 2026-08-15 23:59:40.318078

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '97db89330136'
down_revision: str | Sequence[str] | None = 'eba969aa8e91'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema.

    10-hosted-chatbot-publication.md §8 게시 수명주기의 종료 상태(RETIRED)를
    기록하기 위한 세 컬럼. `suspended_by/at/reason`과 같은 형태이며, 모두
    nullable이라 기존 행 백필이 필요 없다 — 폐기된 적 없는 Deployment는 계속
    셋 다 NULL이고, 그 NULL이 "폐기된 적 없음"을 뜻한다.
    """
    op.add_column(
        'service_deployments',
        sa.Column('retired_by', sa.String(length=256), nullable=True),
    )
    op.add_column(
        'service_deployments',
        sa.Column('retired_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'service_deployments',
        sa.Column('retire_reason', sa.String(length=1000), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('service_deployments', 'retire_reason')
    op.drop_column('service_deployments', 'retired_at')
    op.drop_column('service_deployments', 'retired_by')
