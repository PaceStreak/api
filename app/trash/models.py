from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

TRASH_KINDS = ("habit", "meal", "food", "recipe", "journal", "habit_routine", "workout")


class TrashItem(Base):
    """Something deleted in the last 30 days, kept so it can be restored.

    `payload` is a snapshot of the deleted rows ({"row": {...}, "children":
    {"habit_logs": [...]}}), restored with their original ids so anything
    that pointed at them still does. Workouts are the exception: they were
    already soft-deleted for offline sync, so their payload is empty and a
    restore just clears `deleted_at`. Private to the owner, purged by the
    worker after `purge_after`, and never exported (it is a copy of data the
    export already has, or had)."""

    __tablename__ = "trash_items"
    __table_args__ = (Index("ix_trash_user_deleted", "user_id", "deleted_at"),)

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    item_id: Mapped[UUID] = mapped_column(nullable=False)
    label: Mapped[str] = mapped_column(String(160), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    purge_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
