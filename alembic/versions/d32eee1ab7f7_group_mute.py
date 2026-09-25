"""group mute

Revision ID: d32eee1ab7f7
Revises: 8a26a9caf99a
Create Date: 2026-09-25 09:38:09.105669

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd32eee1ab7f7'
down_revision: Union[str, None] = '8a26a9caf99a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('group_members', sa.Column('muted', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    op.drop_column('group_members', 'muted')
