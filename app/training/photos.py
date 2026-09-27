"""Progress photo backup: opt-in, owner-only.

The app keeps every photo on the device first and uploads only when the person
has turned backup on, so a photo can follow them to a new phone. The bytes are
already a re-encoded JPEG with the camera's EXIF (location included) dropped.

Upload and download both go straight between the client and Cloudflare R2 (see
app/storage.py) over short-lived, single-object presigned URLs - this server
never sees the bytes, only metadata plus an object key. A presigned PUT can
pin the declared Content-Type into its signature, but R2 has no way to sniff
what was actually uploaded, so nothing is trusted - and no database row is
written - until `complete` below has independently checked the real size and
the real magic bytes, deleting the object if either is wrong.

Photos are served only to their owner: `presigned_get_url` signs
`Cache-Control: private, no-store` into the URL itself, so no shared cache or
CDN ever holds a copy even though the bytes come straight from R2's edge.
"""

from datetime import date, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import storage
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.limits import enforce
from app.common.time import local_today
from app.database import get_db
from app.profile.service import get_profile
from app.training.models import MAX_BODY_PHOTO_BYTES, MAX_BODY_PHOTOS, BodyPhoto

router = APIRouter(prefix="/body-photos", tags=["body"])

ALLOWED_TYPES = {"image/jpeg": b"\xff\xd8\xff", "image/webp": b"RIFF", "image/png": b"\x89PNG"}


class PhotoIn(BaseModel):
    date: date
    pose: Literal["front", "side", "back"]
    content_type: str


def _object_key(user_id: UUID, photo_id: UUID) -> str:
    return f"body-photos/{user_id}/{photo_id}"


def _out(p: BodyPhoto) -> dict:
    return {"id": str(p.id), "date": p.taken_on.isoformat(), "pose": p.pose, "size": p.size}


async def _check(db: AsyncSession, user: User, photo_id: UUID, body: PhotoIn) -> BodyPhoto | None:
    """Shared validation for both ends of an upload: the type is one this app
    serves, the date isn't in the future, and the id either doesn't exist yet
    or already belongs to this person. Returns the existing row, if any."""
    if body.content_type not in ALLOWED_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Send a JPEG, WebP or PNG")
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    if body.date > today + timedelta(days=1):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That day has not happened yet")
    photo = await db.get(BodyPhoto, photo_id)
    if photo is not None and photo.user_id != user.id:
        # Someone else's id: refuse without saying whose.
        raise HTTPException(status.HTTP_409_CONFLICT, "Pick another id")
    return photo


@router.get("")
async def list_photos(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(
        select(BodyPhoto)
        .where(BodyPhoto.user_id == user.id)
        .order_by(BodyPhoto.taken_on.desc(), BodyPhoto.created_at.desc())
    )
    return [_out(p) for p in rows.scalars()]


@router.get("/{photo_id}")
async def get_photo(
    photo_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    query = select(BodyPhoto).where(BodyPhoto.id == photo_id, BodyPhoto.user_id == user.id)
    photo = (await db.execute(query)).scalar_one_or_none()
    if photo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    url = await storage.presigned_get_url(photo.object_key, photo.content_type)
    return {"url": url, "expires_in": 60}


@router.post("/{photo_id}/upload")
async def start_upload(
    photo_id: UUID,
    body: PhotoIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Step 1: a presigned URL the client PUTs the photo's bytes to directly.
    Nothing is written to the database yet - see `complete_upload`."""
    await enforce("body-photo", user.id, 60, 3600)
    photo = await _check(db, user, photo_id, body)
    if photo is None:
        count = await db.scalar(
            select(func.count()).select_from(BodyPhoto).where(BodyPhoto.user_id == user.id)
        )
        if (count or 0) >= MAX_BODY_PHOTOS:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"You have {MAX_BODY_PHOTOS} photos backed up. Delete some old ones first.",
            )
    try:
        url = await storage.presigned_put_url(_object_key(user.id, photo_id), body.content_type)
    except storage.StorageUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Photo backup is temporarily unavailable"
        ) from None
    return {"upload_url": url, "expires_in": 300}


@router.post("/{photo_id}/upload/complete")
async def complete_upload(
    photo_id: UUID,
    body: PhotoIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Step 2, after the client's PUT to R2 has finished: independently
    verify what actually landed there, and only then create or update the
    row. A failed check deletes the object - it never counts against
    MAX_BODY_PHOTOS and is never reachable by anyone."""
    photo = await _check(db, user, photo_id, body)
    key = _object_key(user.id, photo_id)
    magic = ALLOWED_TYPES[body.content_type]
    try:
        size = await storage.verify_upload(key, magic, MAX_BODY_PHOTO_BYTES)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload it first") from None
    except ValueError as error:
        if str(error) == "too large":
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE, "That photo is too large"
            ) from None
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Not the image type it claims"
        ) from None

    if photo is None:
        photo = BodyPhoto(id=photo_id, user_id=user.id, object_key=key)
        db.add(photo)
    photo.taken_on = body.date
    photo.pose = body.pose
    photo.content_type = body.content_type
    photo.size = size
    await db.commit()
    return _out(photo)


@router.delete("/{photo_id}", status_code=204)
async def delete_photo(
    photo_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    photo = (
        await db.execute(
            select(BodyPhoto).where(BodyPhoto.id == photo_id, BodyPhoto.user_id == user.id)
        )
    ).scalar_one_or_none()
    if photo is None:
        return
    await db.execute(delete(BodyPhoto).where(BodyPhoto.id == photo_id))
    await db.commit()
    await storage.delete_object(photo.object_key)


@router.delete("", status_code=204)
async def delete_all_photos(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Turning backup off removes every copy from the server."""
    keys = (
        (await db.execute(select(BodyPhoto.object_key).where(BodyPhoto.user_id == user.id)))
        .scalars()
        .all()
    )
    await db.execute(delete(BodyPhoto).where(BodyPhoto.user_id == user.id))
    await db.commit()
    await storage.delete_objects(list(keys))
