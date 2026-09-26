"""weigh ins

Several weigh-ins a day, each tagged with when in the day it was taken. The one
weight per day on body_metrics moves here, at local midday with no moment
claimed, and the column goes, so there is a single place a weight lives.

Revision ID: 02c71d3228fb
Revises: 24078d2082de
Create Date: 2026-09-26 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '02c71d3228fb'
down_revision: Union[str, None] = '24078d2082de'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'weigh_ins',
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('weighed_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('local_date', sa.Date(), nullable=False),
        sa.Column('moment', sa.String(length=16), nullable=False),
        sa.Column('weight_kg', sa.Float(), nullable=False),
        sa.Column('note', sa.String(length=200), nullable=True),
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint(
            "moment IN ('waking', 'pre_workout', 'post_workout', 'bedtime', 'other')",
            name='ck_weigh_in_moment',
        ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_weigh_ins_user_day', 'weigh_ins', ['user_id', 'local_date'], unique=False)

    op.execute(
        """
        INSERT INTO weigh_ins (id, user_id, weighed_at, local_date, moment, weight_kg, note)
        SELECT gen_random_uuid(), b.user_id,
               (b.measured_on + time '12:00') AT TIME ZONE COALESCE(p.timezone, 'UTC'),
               b.measured_on, 'other', b.weight_kg, NULL
        FROM body_metrics b
        LEFT JOIN profiles p ON p.user_id = b.user_id
        WHERE b.weight_kg IS NOT NULL
        """
    )
    op.drop_column('body_metrics', 'weight_kg')


def downgrade() -> None:
    op.add_column('body_metrics', sa.Column('weight_kg', sa.Float(), nullable=True))
    # Back to one weight per day: that day's mean, on days that have a row.
    op.execute(
        """
        UPDATE body_metrics b SET weight_kg = w.kg
        FROM (
            SELECT user_id, local_date, avg(weight_kg) AS kg
            FROM weigh_ins GROUP BY user_id, local_date
        ) w
        WHERE w.user_id = b.user_id AND w.local_date = b.measured_on
        """
    )
    op.drop_index('ix_weigh_ins_user_day', table_name='weigh_ins')
    op.drop_table('weigh_ins')
