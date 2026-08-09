"""add_asset_version_validation_status

Revision ID: 8c4652dd146b
Revises: ba40f54afa06
Create Date: 2026-08-08 15:26:33.388466

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '8c4652dd146b'
down_revision: str | Sequence[str] | None = 'ba40f54afa06'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema.

    P06 버전 관리 자동검증 (01-portal-and-distribution.md §2 P06/P07) — see
    `portal_api.models.asset.AssetVersion` docstring comment. `validation_status`
    gets a `server_default` so the 5 pre-existing rows backfill to `NOT_RUN`
    instead of failing the NOT NULL constraint or requiring a manual UPDATE.
    Uses `batch_alter_table` for consistency with this table's other recent
    migrations (it already carries a self-referential FK — see
    `ba40f54afa06`) even though a bare `add_column` would also work for these
    three unconstrained columns.
    """
    with op.batch_alter_table("asset_versions", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "validation_status",
                sa.String(length=16),
                nullable=False,
                server_default="NOT_RUN",
            )
        )
        batch_op.add_column(sa.Column("validation_errors", sa.JSON(), nullable=True))
        batch_op.add_column(
            sa.Column("validated_at", sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("asset_versions", schema=None) as batch_op:
        batch_op.drop_column("validated_at")
        batch_op.drop_column("validation_errors")
        batch_op.drop_column("validation_status")
