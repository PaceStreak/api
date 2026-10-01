from datetime import date
from uuid import UUID

from sqlalchemy import CheckConstraint, Date, ForeignKey, SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class JournalDay(Base):
    """A day's mood (1-5) and a short note. Private to its owner: never XP,
    a badge, a board or another person. Either half may be empty."""

    __tablename__ = "journal_days"
    __table_args__ = (
        UniqueConstraint("user_id", "day", name="uq_journal_day"),
        CheckConstraint("mood IS NULL OR mood BETWEEN 1 AND 5", name="ck_journal_mood"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    mood: Mapped[int | None] = mapped_column(SmallInteger)
    note: Mapped[str | None] = mapped_column(String(1000))
