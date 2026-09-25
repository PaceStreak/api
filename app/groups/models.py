from datetime import date, datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Group(Base):
    """A crew or a coaching roster. Joined by invite code only - there is no
    public group directory, so no group is discoverable by strangers."""

    __tablename__ = "groups"
    __table_args__ = (CheckConstraint("kind IN ('crew', 'coaching')", name="ck_group_kind"),)

    name: Mapped[str] = mapped_column(String(60), nullable=False)
    description: Mapped[str | None] = mapped_column(String(280))
    kind: Mapped[str] = mapped_column(String(10), default="crew", nullable=False)
    owner_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    invite_code: Mapped[str] = mapped_column(String(16), unique=True, index=True, nullable=False)
    avatar_hue: Mapped[int] = mapped_column(SmallInteger, default=200, nullable=False)
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Share of members (%) who must keep their week for the group's week to
    # count. 75 by default: a crew streak should survive one person's bad
    # week without being meaningless.
    streak_threshold: Mapped[int] = mapped_column(
        SmallInteger, default=75, server_default="75", nullable=False
    )


class GroupMember(Base):
    __tablename__ = "group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "user_id", name="uq_group_member"),
        CheckConstraint("role IN ('owner', 'admin', 'coach', 'member')", name="ck_member_role"),
    )

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    role: Mapped[str] = mapped_column(String(8), default="member", nullable=False)
    # A coach sees a member's training only with this explicit, revocable
    # consent. Joining a coaching group does not imply it.
    shares_with_coach: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Mute this group: its notifications still land in the inbox, so nothing
    # is lost, but they are never pushed or emailed.
    muted: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )


class Challenge(Base):
    """A time-boxed goal shared by its participants.

    Scored on distinct active days, never on volume or load, and capped at one
    per day - so nobody can carry a team by training twice a day, and a
    challenge never becomes a reason to skip rest.
    """

    __tablename__ = "challenges"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('active_days', 'weekly_target', 'plan_sessions')", name="ck_challenge_kind"
        ),
        CheckConstraint("ends_on >= starts_on", name="ck_challenge_window"),
    )

    title: Mapped[str] = mapped_column(String(60), nullable=False)
    description: Mapped[str | None] = mapped_column(String(280))
    # active_days: most distinct training days in the window (a target, if
    # set, is the finish line). weekly_target: weeks in the window where the
    # participant hit their own weekly target - fair between a 3x and a 6x
    # trainer, because each is measured against their own plan.
    kind: Mapped[str] = mapped_column(String(16), default="active_days", nullable=False)
    target: Mapped[int | None] = mapped_column(Integer)
    disciplines: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    starts_on: Mapped[date] = mapped_column(Date, nullable=False)
    ends_on: Mapped[date] = mapped_column(Date, nullable=False)
    creator_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    group_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), index=True
    )
    # Challenges outside a group are joined by code, like groups.
    invite_code: Mapped[str] = mapped_column(String(16), unique=True, index=True, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # For plan_sessions: the plan everyone follows, in the shareable format
    # (routines embedded by value), copied into each participant's plans on
    # joining. Score = sessions of their copy completed in the window.
    plan: Mapped[dict | None] = mapped_column(JSONB)


class ChallengeParticipant(Base):
    __tablename__ = "challenge_participants"
    __table_args__ = (UniqueConstraint("challenge_id", "user_id", name="uq_challenge_participant"),)

    challenge_id: Mapped[UUID] = mapped_column(
        ForeignKey("challenges.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Frozen when the challenge resolves, so editing a session afterwards can
    # never flip a settled result.
    final_score: Mapped[int | None] = mapped_column(Integer)
    final_rank: Mapped[int | None] = mapped_column(Integer)
    completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GroupAnnouncement(Base):
    """A note from a group's owner or admins to its members. Members can't
    post, so there is nothing to moderate between members; announcements
    are plain text, rendered as text."""

    __tablename__ = "group_announcements"

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), index=True, nullable=False
    )
    author_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    body: Mapped[str] = mapped_column(String(500), nullable=False)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
