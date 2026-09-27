"""achievement single-badge unique index

Postgres treats NULL as distinct in a unique constraint, so
uq_user_achievement_tier never protected single (non-tiered) badges, whose
`tier` is always NULL. Two concurrent recompute() calls (e.g. an offline
outbox retry racing a live request) could both pass the "already held" check
in app/game/service.py and insert the same badge twice, double-paying its XP.
This adds a partial unique index covering exactly that case so the insert can
use ON CONFLICT DO NOTHING.

Revision ID: b7a4e1c9d3f8
Revises: a1c9f3e5d7b2
Create Date: 2026-09-27 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7a4e1c9d3f8"
down_revision: Union[str, None] = "a1c9f3e5d7b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "uq_user_achievement_single",
        "user_achievements",
        ["user_id", "achievement_id"],
        unique=True,
        postgresql_where="tier IS NULL",
    )


def downgrade() -> None:
    op.drop_index("uq_user_achievement_single", table_name="user_achievements")
