from datetime import date, datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserStats(Base):
    """A projection of everything the engine derives from history.

    Nothing here is a source of truth - it is rebuilt from workouts by
    app/game/service.py after every write, and nightly by the worker so
    streaks that lapsed without a write still read correctly. It exists so a
    leaderboard is one indexed query rather than a replay of every user's log.
    """

    __tablename__ = "user_stats"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
    )
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # The user's local date when computed. The worker recomputes rows whose
    # date has rolled over, which is how a streak "breaks" with no new write.
    computed_for: Mapped[date] = mapped_column(Date, nullable=False)

    total_xp: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    level: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    season_id: Mapped[str] = mapped_column(String(8), nullable=False)
    season_xp: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    current_streak: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    longest_streak: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    consistency: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    this_week_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    this_week_target: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    # Mean active days per week over the last four closed weeks. Used only to
    # pair people with others who train about as often, so a board or a
    # challenge feels winnable.
    weekly_days_4w: Mapped[float] = mapped_column(
        Float, default=0, server_default="0", nullable=False
    )
    # The optional whole-life streak, in kept weeks; 0 when it's off.
    life_streak: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)

    sessions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    active_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    season_prs: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_prs: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_active: Mapped[date | None] = mapped_column(Date)
    # The main chain's last 26 week verdicts, oldest first, current week last:
    # ["kept", "frozen", "paused", "missed", "open"]. Buddy and group streaks
    # are judged from these, so they need no replay of anyone's history.
    recent_weeks: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default="[]", nullable=False
    )


class UserAchievement(Base):
    __tablename__ = "user_achievements"
    __table_args__ = (
        UniqueConstraint("user_id", "achievement_id", "tier", name="uq_user_achievement_tier"),
        Index("ix_user_achievements_achievement", "achievement_id"),
        # Postgres treats NULL as distinct under a unique constraint, so the
        # constraint above never covers single (non-tiered) badges - this
        # partial index does, closing a race where two concurrent recomputes
        # both insert the same single badge. See migration b7a4e1c9d3f8.
        Index(
            "uq_user_achievement_single",
            "user_id",
            "achievement_id",
            unique=True,
            postgresql_where=sa.text("tier IS NULL"),
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    achievement_id: Mapped[str] = mapped_column(String(40), nullable=False)
    # NULL for single badges. Postgres treats NULLs as distinct in a unique
    # constraint, so single badges are de-duplicated in code (see service.py).
    tier: Mapped[str | None] = mapped_column(String(8))
    unlocked_on: Mapped[date] = mapped_column(Date, nullable=False)
    evidence: Mapped[dict | None] = mapped_column(JSONB)


class PersonalRecord(Base):
    """Every time a record moved. A projection like UserStats: replaced
    wholesale per user on recompute, so deleting or editing an old session
    corrects every record after it."""

    __tablename__ = "personal_records"
    __table_args__ = (Index("ix_personal_records_user_key", "user_id", "key"),)

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    previous: Mapped[float | None] = mapped_column(Float)
    gain_pct: Mapped[float | None] = mapped_column(Float)
    achieved_on: Mapped[date] = mapped_column(Date, nullable=False)
    workout_id: Mapped[UUID | None] = mapped_column()
    flagged: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    rewarded: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # True for the current best of its key - the row the records page shows.
    is_current: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class StreakWager(Base):
    """An opt-in promise: one more day than the target in a given week. Kept,
    it earns a freeze (within the usual cap); missed, it costs nothing at all.
    At most one a calendar month, set before the week's first session, so it
    can't be placed on a week that is already won."""

    __tablename__ = "streak_wagers"
    __table_args__ = (UniqueConstraint("user_id", "week_start", name="uq_streak_wager_week"),)

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    days: Mapped[int] = mapped_column(SmallInteger, nullable=False)
