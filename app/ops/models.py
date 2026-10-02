from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class WorkerHeartbeat(Base):
    """One row per worker name, rewritten at the end of every tick.

    In Postgres, not Redis: this is what tells an operator (and the status
    page) that reminders, digests and account purges are actually running,
    and Redis is best-effort by design here. A heartbeat that disappears in a
    Redis restart would page someone for nothing.
    """

    __tablename__ = "worker_heartbeats"

    name: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    last_tick_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    # {"stats": {"result": 3}, "nudges": {"error": "..."}, ...} for the last tick.
    jobs: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    # Ticks in a row with at least one failing job. Reset by a clean tick.
    failing_ticks: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class ClientError(Base):
    """A crash reported by the app, grouped by fingerprint.

    Anonymous on purpose: no user id, no query strings, no request bodies -
    just enough to find the bug. Grouping keeps one broken screen from
    becoming ten thousand rows; `count` says how often it happened.
    """

    __tablename__ = "client_errors"

    fingerprint: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    message: Mapped[str] = mapped_column(String(500), nullable=False)
    stack: Mapped[str | None] = mapped_column(String(4000))
    # Path only, never the query string (it can carry tokens).
    path: Mapped[str | None] = mapped_column(String(300))
    release: Mapped[str | None] = mapped_column(String(40))
    user_agent: Mapped[str | None] = mapped_column(String(400))
    count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # When admins were emailed about this group; each is reported once.
    alerted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuthFailure(Base):
    """A failed sign-in, recovery or second-factor attempt, for the admin
    abuse view. The address is stored only as a keyed hash, so this table
    never becomes a list of who tried to sign in as whom; kept 30 days."""

    __tablename__ = "auth_failures"
    __table_args__ = (Index("ix_auth_failures_created", "created_at"),)

    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    ip_address: Mapped[str | None] = mapped_column(String(45), index=True)
    email_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    # Set when the address belongs to a real account, so the admin view can
    # say whose account is being tried without reversing any hash.
    user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
