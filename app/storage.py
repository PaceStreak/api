"""Object storage: progress photos live in Cloudflare R2, not Postgres.

R2 speaks the S3 API, so this is a thin wrapper around boto3's S3 client
rather than a Cloudflare-specific SDK. boto3 is synchronous; every call here
runs on a worker thread via `asyncio.to_thread` so it never blocks the event
loop, the same tradeoff FastAPI itself makes for sync path operations.
"""

import asyncio
from functools import lru_cache

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError

from app.config import get_settings


class StorageUnavailable(RuntimeError):
    """R2 is not configured. Raised instead of crashing at import time, so a
    fresh checkout without a bucket still boots - see app/config.py."""


@lru_cache
def _client():
    settings = get_settings()
    if not (
        settings.r2_account_id
        and settings.r2_access_key_id
        and settings.r2_secret_access_key
        and settings.r2_bucket
    ):
        raise StorageUnavailable("R2 is not configured")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{settings.r2_account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        # R2 only speaks the v4 signature and has no regions - "auto" is
        # Cloudflare's documented value, not a real AWS region.
        config=BotoConfig(signature_version="s3v4"),
        region_name="auto",
    )


async def put_object(key: str, data: bytes, content_type: str) -> None:
    settings = get_settings()
    await asyncio.to_thread(
        _client().put_object,
        Bucket=settings.r2_bucket,
        Key=key,
        Body=data,
        ContentType=content_type,
    )


async def presigned_put_url(key: str, content_type: str, expires_in: int = 300) -> str:
    """A short-lived URL the client PUTs bytes to directly, bypassing this
    server's bandwidth. `ContentType` is signed into the URL, so a PUT with
    any other Content-Type header fails signature verification before it
    reaches R2 at all - the client cannot silently swap the declared type.

    This still does not verify what the bytes *actually* are - R2 has no way
    to sniff content the way `photos.py` does - so nothing here is trusted
    until `verify_upload` below has checked it."""
    settings = get_settings()
    return await asyncio.to_thread(
        _client().generate_presigned_url,
        "put_object",
        Params={"Bucket": settings.r2_bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=expires_in,
    )


async def presigned_get_url(key: str, content_type: str, expires_in: int = 60) -> str:
    """A short-lived, single-object URL for the client to fetch directly from
    R2. `ResponseCacheControl` is signed into the URL itself, so R2 - not this
    server - is what tells the browser never to cache it."""
    settings = get_settings()
    return await asyncio.to_thread(
        _client().generate_presigned_url,
        "get_object",
        Params={
            "Bucket": settings.r2_bucket,
            "Key": key,
            "ResponseContentType": content_type,
            "ResponseCacheControl": "private, no-store",
        },
        ExpiresIn=expires_in,
    )


async def verify_upload(key: str, magic: bytes, max_bytes: int) -> int:
    """Confirms what a presigned PUT actually put there before any database
    row is allowed to point at it: real size within the cap, and the first
    bytes matching the claimed image type. Deletes the object and raises on
    either failure, so a rejected upload never lingers in the bucket.

    Returns the verified size in bytes."""
    settings = get_settings()

    def _verify() -> int:
        client = _client()
        try:
            head = client.head_object(Bucket=settings.r2_bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                raise FileNotFoundError(key) from exc
            raise
        size = head["ContentLength"]
        if size > max_bytes:
            client.delete_object(Bucket=settings.r2_bucket, Key=key)
            raise ValueError("too large")
        head_bytes = client.get_object(
            Bucket=settings.r2_bucket, Key=key, Range=f"bytes=0-{len(magic) - 1}"
        )["Body"].read()
        if not head_bytes.startswith(magic):
            client.delete_object(Bucket=settings.r2_bucket, Key=key)
            raise ValueError("wrong type")
        return size

    return await asyncio.to_thread(_verify)


async def get_object(key: str) -> bytes:
    settings = get_settings()

    def _get() -> bytes:
        try:
            return _client().get_object(Bucket=settings.r2_bucket, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                raise FileNotFoundError(key) from exc
            raise

    return await asyncio.to_thread(_get)


async def delete_object(key: str) -> None:
    settings = get_settings()
    await asyncio.to_thread(_client().delete_object, Bucket=settings.r2_bucket, Key=key)


async def delete_objects(keys: list[str]) -> None:
    """Deletes up to 1000 keys in one request - R2's batch-delete limit."""
    if not keys:
        return
    settings = get_settings()
    for i in range(0, len(keys), 1000):
        batch = keys[i : i + 1000]
        await asyncio.to_thread(
            _client().delete_objects,
            Bucket=settings.r2_bucket,
            Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True},
        )
