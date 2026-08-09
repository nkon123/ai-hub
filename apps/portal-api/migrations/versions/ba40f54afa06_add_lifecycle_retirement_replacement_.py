"""add_lifecycle_retirement_replacement_revocation

Revision ID: ba40f54afa06
Revises: a2788c84aadb
Create Date: 2026-08-08 14:27:02.543037

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'ba40f54afa06'
down_revision: str | Sequence[str] | None = 'a2788c84aadb'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # NOTE: hand-adjusted from the raw autogenerate output — SQLite has no
    # `ALTER TABLE ... ADD CONSTRAINT`, so adding a (self-referential)
    # foreign key to an existing table must go through `batch_alter_table`
    # (rebuild-and-swap), not a bare `op.create_foreign_key` (which would
    # raise against the sqlite dialect). See D-043 in open-decisions.md for
    # why this project uses Alembic instead of `create_all` at all.
    op.create_table(
        "asset_version_revocations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("version_id", sa.String(length=36), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("approver_id", sa.String(length=256), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("trace_id", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["version_id"], ["asset_versions.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("asset_versions", schema=None) as batch_op:
        batch_op.add_column(sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(
            sa.Column("replacement_version_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_asset_versions_replacement_version_id",
            "asset_versions",
            ["replacement_version_id"],
            ["id"],
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("asset_versions", schema=None) as batch_op:
        batch_op.drop_constraint(
            "fk_asset_versions_replacement_version_id", type_="foreignkey"
        )
        batch_op.drop_column("replacement_version_id")
        batch_op.drop_column("retired_at")
    op.drop_table("asset_version_revocations")
