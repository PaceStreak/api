from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

VISIBILITIES = ("private", "followers", "public")

# Under this age there is no account at all (COPPA's floor). Under SOCIAL_MIN_AGE
# the private training log works in full, but nothing is ever shown to another
# person: no feed, no leaderboard, no public profile. 16 is the highest GDPR
# digital-consent age any member state uses, so one number covers every market.
MIN_AGE = 13
SOCIAL_MIN_AGE = 16


class Profile(Base):
    """Everything about a person that is not a credential.

    Kept out of `users` on purpose: that table is the auth system's, is cached
    in Redis field-by-field, and every column added to it is one more thing a
    token check deserialises. Preferences change often; credentials rarely.
    """

    __tablename__ = "profiles"
    __table_args__ = (
        CheckConstraint("week_starts_on BETWEEN 0 AND 6", name="ck_profiles_week_start"),
        CheckConstraint("weight_unit IN ('kg', 'lb')", name="ck_profiles_weight_unit"),
        CheckConstraint("distance_unit IN ('km', 'mi')", name="ck_profiles_distance_unit"),
        CheckConstraint(
            "visibility IN ('private', 'followers', 'public')", name="ck_profiles_visibility"
        ),
        CheckConstraint("reminder_hour BETWEEN 0 AND 23", name="ck_profiles_reminder_hour"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
    )

    # Public identity. The handle is chosen during onboarding; until then the
    # person has no public presence at all.
    handle: Mapped[str | None] = mapped_column(String(30), unique=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(50))
    bio: Mapped[str | None] = mapped_column(String(160))
    # Avatars are a generated colour plus initials. There are no uploaded
    # images anywhere under pacestreak.com - nothing untrusted is hosted there.
    avatar_hue: Mapped[int] = mapped_column(SmallInteger, default=78, nullable=False)

    # Calendar. timezone buckets sessions into local days; week_starts_on
    # decides where one streak week ends and the next begins.
    timezone: Mapped[str] = mapped_column(String(64), default="UTC", nullable=False)
    week_starts_on: Mapped[int] = mapped_column(SmallInteger, default=0, nullable=False)
    weight_unit: Mapped[str] = mapped_column(String(2), default="kg", nullable=False)
    distance_unit: Mapped[str] = mapped_column(String(2), default="km", nullable=False)
    # Optional planned training days, as a bitmask (bit 0 = Monday). Only used
    # to aim reminders; the streak itself counts against the weekly target.
    training_days: Mapped[int | None] = mapped_column(SmallInteger)

    # Consent and age. Birth *year* only - enough for the age gate, not a
    # date of birth anyone could use for anything else.
    birth_year: Mapped[int | None] = mapped_column(Integer)
    accepted_terms_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    onboarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Privacy. "followers" by default: nothing is public until someone says so.
    visibility: Mapped[str] = mapped_column(String(10), default="followers", nullable=False)
    # A global pause: stops new activity reaching anyone without touching the
    # visibility setting, for the week you would rather nobody watched.
    sharing_paused: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # The "just a log" switch. Off removes XP, levels, badges and leaderboards
    # from the product for this person; the streak stays, because it is the
    # product rather than a game layered on top of it.
    gamification_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    leaderboard_opt_in: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Moderation. Suspends social privileges only - never the training log,
    # which a person can always keep using and exporting.
    social_suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Deletion has a 30-day grace period; the worker purges after it.
    deletion_scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Reminders fire at this local hour, and never inside quiet hours.
    reminder_hour: Mapped[int] = mapped_column(SmallInteger, default=18, nullable=False)
    quiet_start: Mapped[int] = mapped_column(SmallInteger, default=22, nullable=False)
    quiet_end: Mapped[int] = mapped_column(SmallInteger, default=7, nullable=False)

    def age_in(self, year: int) -> int | None:
        return None if self.birth_year is None else year - self.birth_year

    def social_allowed(self, year: int) -> bool:
        """Whether this person may appear to anyone else at all."""
        age = self.age_in(year)
        return (
            age is not None
            and age >= SOCIAL_MIN_AGE
            and self.social_suspended_at is None
            and self.deletion_scheduled_at is None
            and self.onboarded_at is not None
        )
