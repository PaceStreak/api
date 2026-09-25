from datetime import datetime

from sqlalchemy import DateTime, Integer, String
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
