"""body photos move to r2

Revision ID: 8bc1bac793d0
Revises: b7a4e1c9d3f8
Create Date: 2026-09-27 17:18:26.476249

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8bc1bac793d0"
down_revision: Union[str, None] = "b7a4e1c9d3f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nothing is deployed yet (see CLAUDE.md), so there is no photo anyone
    # would lose - any row here predates R2 and has no object in the bucket
    # to point at. Dropped rather than backfilled for that reason alone;
    # this is not the pattern for a live migration with real users' photos.
    op.execute("DELETE FROM body_photos")
    op.add_column("body_photos", sa.Column("object_key", sa.String(length=255), nullable=False))
    op.create_unique_constraint("uq_body_photos_object_key", "body_photos", ["object_key"])
    op.drop_column("body_photos", "data")


def downgrade() -> None:
    op.add_column(
        "body_photos", sa.Column("data", sa.LargeBinary(), autoincrement=False, nullable=False)
    )
    op.drop_constraint("uq_body_photos_object_key", "body_photos", type_="unique")
    op.drop_column("body_photos", "object_key")
