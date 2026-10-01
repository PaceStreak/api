from datetime import date, datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

HABIT_KINDS = ("check", "duration", "count", "quit")
HABIT_CATEGORIES = (
    "health",
    "fitness",
    "learning",
    "mind",
    "social",
    "productivity",
    "money",
    "home",
    "creative",
    "break",
    "other",
)
TIMES_OF_DAY = ("morning", "afternoon", "evening", "anytime")


class Habit(Base):
    """Anything worth doing regularly that isn't a logged training session:
    reading, practising guitar, water, meditation, a call home - or something
    being given up.

    Private to its owner. Each has its own week-based streak, like training:
    `weekly_target` days a week keeps the week. Kinds:

    - check:    done or not.
    - duration: minutes; a day counts when it reaches `daily_goal`.
    - count:    a number (pages, glasses); counts at `daily_goal`.
    - quit:     something being broken. A day is clean unless a slip is
                logged on it; `weekly_target` is how many clean days keep the
                week, so one slip doesn't have to cost the week.

    A habit's name never appears to anyone else, anywhere: a quit habit in a
    feed or on a badge would out someone's recovery.
    """

    __tablename__ = "habits"
    __table_args__ = (
        CheckConstraint("kind IN ('check', 'duration', 'count', 'quit')", name="ck_habit_kind"),
        CheckConstraint("weekly_target BETWEEN 1 AND 7", name="ck_habit_target"),
        CheckConstraint(
            "remind_hour IS NULL OR remind_hour BETWEEN 0 AND 23", name="ck_habit_remind"
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    emoji: Mapped[str] = mapped_column(String(8), default="✨", nullable=False)
    category: Mapped[str] = mapped_column(String(16), default="other", nullable=False)
    kind: Mapped[str] = mapped_column(String(10), default="check", nullable=False)
    # Pages, glasses, words... for count habits; minutes for duration.
    unit: Mapped[str | None] = mapped_column(String(20))
    # How much makes a day count, for duration and count habits.
    daily_goal: Mapped[float | None] = mapped_column(Float)
    weekly_target: Mapped[int] = mapped_column(SmallInteger, default=7, nullable=False)
    time_of_day: Mapped[str] = mapped_column(String(10), default="anytime", nullable=False)
    # An implementation intention - "After I pour my coffee" - which the
    # research on habit formation finds works better than willpower.
    cue: Mapped[str | None] = mapped_column(String(120))
    # Why it matters, in the person's own words; shown when it's hard.
    why: Mapped[str | None] = mapped_column(String(200))
    # For skills: a long goal in the habit's unit (100 hours, 20 books).
    total_goal: Mapped[float | None] = mapped_column(Float)
    remind_hour: Mapped[int | None] = mapped_column(SmallInteger)
    template_id: Mapped[str | None] = mapped_column(String(40))
    started_on: Mapped[date] = mapped_column(Date, nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, default=0, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class HabitLog(Base):
    """One day of one habit: how much (1 for a check, minutes, a count), or
    for a quit habit, the number of slips that day."""

    __tablename__ = "habit_logs"
    __table_args__ = (
        UniqueConstraint("habit_id", "day", name="uq_habit_log_day"),
        Index("ix_habit_logs_user_day", "user_id", "day"),
    )

    habit_id: Mapped[UUID] = mapped_column(
        ForeignKey("habits.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    note: Mapped[str | None] = mapped_column(String(280))


class HabitRoutine(Base):
    """An ordered run of habits done together - a morning routine, a wind-down -
    stepped through one at a time in the app. A routine is only an order:
    ticking a step logs the habit itself, so streaks need nothing new.
    Private, like the habits in it."""

    __tablename__ = "habit_routines"
    __table_args__ = (
        CheckConstraint(
            "time_of_day IN ('morning', 'afternoon', 'evening', 'anytime')",
            name="ck_habit_routine_time",
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    emoji: Mapped[str] = mapped_column(String(8), default="🌅", nullable=False)
    time_of_day: Mapped[str] = mapped_column(String(10), default="morning", nullable=False)
    # Habit ids as strings, in order. A deleted habit simply drops out.
    habit_ids: Mapped[list] = mapped_column(JSONB, nullable=False)
