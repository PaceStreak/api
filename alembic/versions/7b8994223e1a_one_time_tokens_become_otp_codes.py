"""one_time_tokens become OTP codes

Revision ID: 7b8994223e1a
Revises: 8bc1bac793d0
Create Date: 2026-09-27

Email verification, password reset and email change move from a link token
to a 6-digit code typed back by the user. Two schema consequences:

- `attempts` bounds online guessing of the low-entropy code.
- `token_hash` is no longer unique: unlike a 32-byte link token, a 6-digit
  code can and will collide across different users' rows, so lookup is by
  (user, purpose) with the hash checked after, not by hash alone.
"""

from alembic import op
import sqlalchemy as sa

revision = "7b8994223e1a"
down_revision = "8bc1bac793d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "one_time_tokens",
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
    )
    op.drop_index("ix_one_time_tokens_token_hash", table_name="one_time_tokens")
    op.create_index(
        "ix_one_time_tokens_token_hash", "one_time_tokens", ["token_hash"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_one_time_tokens_token_hash", table_name="one_time_tokens")
    op.create_index(
        "ix_one_time_tokens_token_hash", "one_time_tokens", ["token_hash"], unique=True
    )
    op.drop_column("one_time_tokens", "attempts")
