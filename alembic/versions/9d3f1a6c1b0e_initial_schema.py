"""initial schema: users, refresh_tokens, one_time_tokens, recovery_codes

Revision ID: 9d3f1a6c1b0e
Revises:
Create Date: 2026-09-18

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9d3f1a6c1b0e"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # No separate .create() call for either enum: op.create_table's own
    # CREATE TABLE below emits CREATE TYPE itself the first time each one is
    # used as a column type, and calling .create() first only duplicates it.
    userrole = postgresql.ENUM("admin", "user", name="userrole")
    tokenpurpose = postgresql.ENUM("email_verify", "password_reset", name="tokenpurpose")

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("hashed_password", sa.String(512), nullable=False),
        sa.Column("role", userrole, nullable=False, server_default="user"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("totp_secret", sa.String(512), nullable=True),
        sa.Column("totp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("totp_confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("totp_last_used_step", sa.Integer(), nullable=True),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "refresh_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("family_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("refresh_tokens.id"),
            nullable=True,
        ),
        sa.Column("replaced_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_agent", sa.String(400), nullable=True),
        sa.Column("ip_address", sa.String(45), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])
    op.create_index("ix_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"], unique=True)
    op.create_index("ix_refresh_tokens_family_id", "refresh_tokens", ["family_id"])

    op.create_table(
        "one_time_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("purpose", tokenpurpose, nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_one_time_tokens_user_id", "one_time_tokens", ["user_id"])
    op.create_index("ix_one_time_tokens_token_hash", "one_time_tokens", ["token_hash"], unique=True)

    op.create_table(
        "recovery_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("code_hash", sa.String(512), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_recovery_codes_user_id", "recovery_codes", ["user_id"])


def downgrade() -> None:
    op.drop_table("recovery_codes")
    op.drop_table("one_time_tokens")
    op.drop_table("refresh_tokens")
    op.drop_table("users")
    postgresql.ENUM(name="tokenpurpose").drop(op.get_bind())
    postgresql.ENUM(name="userrole").drop(op.get_bind())
