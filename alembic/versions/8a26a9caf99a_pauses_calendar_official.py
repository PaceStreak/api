"""streak pauses, calendar feed, official accounts

- streak_pauses: declared injury/illness/life breaks that shelter a streak.
- profiles.calendar_token_hash: SHA-256 of the private ICS feed token.
- profiles.is_official: admin-set flag that may hold a reserved handle.

Revision ID: 8a26a9caf99a
Revises: fd264d571db7
Create Date: 2026-09-25 07:36:27.360570

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8a26a9caf99a'
down_revision: Union[str, None] = 'fd264d571db7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('streak_pauses',
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('starts_on', sa.Date(), nullable=False),
    sa.Column('ends_on', sa.Date(), nullable=True),
    sa.Column('reason', sa.String(length=10), nullable=False),
    sa.Column('note', sa.String(length=280), nullable=True),
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("reason IN ('injury', 'illness', 'life', 'other')", name='ck_pause_reason'),
    sa.CheckConstraint('ends_on IS NULL OR ends_on >= starts_on', name='ck_pause_range'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_streak_pauses_user_start', 'streak_pauses', ['user_id', 'starts_on'], unique=False)
    op.add_column('profiles', sa.Column('is_official', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('profiles', sa.Column('calendar_token_hash', sa.String(length=64), nullable=True))
    op.add_column('profiles', sa.Column('calendar_token_created_at', sa.DateTime(timezone=True), nullable=True))
    op.create_unique_constraint('uq_profiles_calendar_token_hash', 'profiles', ['calendar_token_hash'])


def downgrade() -> None:
    op.drop_constraint('uq_profiles_calendar_token_hash', 'profiles', type_='unique')
    op.drop_column('profiles', 'calendar_token_created_at')
    op.drop_column('profiles', 'calendar_token_hash')
    op.drop_column('profiles', 'is_official')
    op.drop_index('ix_streak_pauses_user_start', table_name='streak_pauses')
    op.drop_table('streak_pauses')
