from collections.abc import AsyncGenerator

from redis.asyncio import ConnectionPool, Redis

from app.config import get_settings

settings = get_settings()

_pool: ConnectionPool | None = None


def init_cache() -> None:
    """Create the shared connection pool. Called once from the app lifespan."""
    global _pool
    if _pool is None:
        _pool = ConnectionPool.from_url(
            settings.redis_url,
            decode_responses=True,
            max_connections=settings.redis_max_connections,
        )


async def close_cache() -> None:
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None


def get_client() -> Redis:
    """A client over the shared pool.

    Callers must treat every operation as best-effort: Redis being unreachable
    degrades performance, never correctness, so cache helpers swallow
    connection errors and fall back to Postgres.
    """
    if _pool is None:
        init_cache()
    return Redis(connection_pool=_pool)


async def get_redis() -> AsyncGenerator[Redis]:
    """FastAPI dependency for handlers that need Redis directly."""
    client = get_client()
    try:
        yield client
    finally:
        await client.aclose()
