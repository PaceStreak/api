"""Per-user rate limits for authenticated writes.

app/ratelimit.py limits by client IP, which is right for login and signup -
there is no user yet. Once a request is authenticated the user is the thing
to meter: a comment flood from one account should not be able to hide behind
a mobile carrier's shared address, and one noisy account on a shared office
network should not lock out everyone else behind it.

Fixed windows in Redis. Fails open on a Redis error, like the user cache:
losing the limiter for a minute is better than refusing every comment.
"""

from fastapi import HTTPException, status
from redis.exceptions import RedisError

from app.cache import get_client


async def enforce(bucket: str, subject: object, limit: int, window_seconds: int) -> None:
    key = f"limit:{bucket}:{subject}"
    try:
        client = get_client()
        count = await client.incr(key)
        if count == 1:
            await client.expire(key, window_seconds)
    except RedisError:
        return
    if count > limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Slow down - try again in a little while.",
        )
