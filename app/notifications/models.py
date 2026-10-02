from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    false,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Notification(Base):
    """The in-app inbox. Every notification lands here whatever else happens;
    push and email are extra channels on top, chosen per category."""

    __tablename__ = "notifications"
    __table_args__ = (
        # De-duplication for scheduled nudges: "streak at risk for chain X in
        # week Y" can be attempted by every worker tick but lands once.
        UniqueConstraint("user_id", "dedupe_key", name="uq_notification_dedupe"),
        Index("ix_notifications_inbox", "user_id", "created_at"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    body: Mapped[str | None] = mapped_column(String(400))
    url: Mapped[str | None] = mapped_column(String(200))
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    data: Mapped[dict | None] = mapped_column(JSONB)
    dedupe_key: Mapped[str | None] = mapped_column(String(120))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class NotificationPreference(Base):
    __tablename__ = "notification_preferences"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
    )
    # {"streak_risk": {"push": true, "email": false}, ...}. Absent keys fall
    # back to DEFAULTS in app/notifications/service.py.
    channels: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    # Set: habit reminders arrive as one summary at this local hour instead
    # of one notification per habit. Null: one per habit, at its own hour.
    habit_summary_hour: Mapped[int | None] = mapped_column(SmallInteger)
    # Opt-in, off by default: the monthly backup email carries the export
    # itself (a zip) instead of only a link. That puts every habit - quit
    # habits included - weight, food and journal into an inbox, so the app
    # makes someone confirm exactly that before it can be switched on.
    backup_attachment: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    endpoint: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    p256dh: Mapped[str] = mapped_column(String(200), nullable=False)
    auth: Mapped[str] = mapped_column(String(100), nullable=False)
    user_agent: Mapped[str | None] = mapped_column(String(400))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failures: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
