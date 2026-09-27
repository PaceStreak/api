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
