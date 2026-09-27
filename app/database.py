from collections.abc import AsyncGenerator
from uuid import UUID, uuid7

from sqlalchemy import DateTime, func
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, declarative_base, mapped_column

from app.config import get_settings

settings = get_settings()

# statement_cache_size=0: asyncpg's default is to cache prepared statements
# per physical connection. That's invisible on a direct connection, but Neon's
# pooled endpoint (PgBouncer in transaction mode) hands out a different
# backend connection per transaction - a statement prepared on one can vanish
# or collide by name on the next, surfacing as random
# "prepared statement already exists" errors. Disabling the cache costs a
# little latency and is harmless everywhere else (a direct Postgres, or the
# local dev/test database), so it's a permanent default rather than an
# environment-conditional one. See infra/DECISIONS.md.
engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    future=True,
    connect_args={"statement_cache_size": 0},
)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(declarative_base()):
    __abstract__ = True

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid7)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


async def get_db() -> AsyncGenerator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        yield session
