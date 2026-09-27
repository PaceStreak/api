"""favourite disciplines

Revision ID: a1c9f3e5d7b2
Revises: 7ee5ccff69ad
Create Date: 2026-09-27 00:20:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "a1c9f3e5d7b2"
down_revision: Union[str, None] = "7ee5ccff69ad"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "profiles",
        sa.Column(
            "favourite_disciplines",
            postgresql.ARRAY(sa.String()),
            server_default="{}",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("profiles", "favourite_disciplines")
