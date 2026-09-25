"""travel pause reason

Revision ID: 623a0a3291a4
Revises: 5997e8235479
Create Date: 2026-09-25 13:05:48.247586

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '623a0a3291a4'
down_revision: Union[str, None] = '5997e8235479'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("ck_pause_reason", "streak_pauses", type_="check")
    op.create_check_constraint(
        "ck_pause_reason",
        "streak_pauses",
        "reason IN ('injury', 'illness', 'travel', 'life', 'other')",
    )


def downgrade() -> None:
    # Travel pauses become "other" rather than blocking the downgrade.
    op.execute("UPDATE streak_pauses SET reason = 'other' WHERE reason = 'travel'")
    op.drop_constraint("ck_pause_reason", "streak_pauses", type_="check")
    op.create_check_constraint(
        "ck_pause_reason",
        "streak_pauses",
        "reason IN ('injury', 'illness', 'life', 'other')",
    )
