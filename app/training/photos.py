"""Progress photo backup: opt-in, owner-only.

The app keeps every photo on the device first and uploads only when the person
has turned backup on, so a photo can follow them to a new phone. The bytes are
already a re-encoded JPEG with the camera's EXIF (location included) dropped;
the server checks the type and size and stores them as sent.

Photos are served only to their owner, with `Cache-Control: private,
no-store`, so no shared cache or CDN ever holds a copy.
"""

from datetime import date, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.limits import enforce
from app.common.time import local_today
from app.database import get_db
from app.profile.service import get_profile
from app.training.models import MAX_BODY_PHOTO_BYTES, MAX_BODY_PHOTOS, BodyPhoto

router = APIRouter(prefix="/body-photos", tags=["body"])

ALLOWED_TYPES = {"image/jpeg": b"\xff\xd8\xff", "image/webp": b"RIFF", "image/png": b"\x89PNG"}


def _out(p: BodyPhoto) -> dict:
    return {"id": str(p.id), "date": p.taken_on.isoformat(), "pose": p.pose, "size": p.size}


async def _own(db: AsyncSession, user: User, photo_id: UUID, with_data: bool = False) -> BodyPhoto:
    query = select(BodyPhoto).where(BodyPhoto.id == photo_id, BodyPhoto.user_id == user.id)
    if with_data:
        query = query.options(undefer(BodyPhoto.data))
    photo = (await db.execute(query)).scalar_one_or_none()
    if photo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
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
    photo = await _own(db, user, photo_id, with_data=True)
    return Response(
        photo.data,
        media_type=photo.content_type,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.put("/{photo_id}")
async def put_photo(
    photo_id: UUID,
    request: Request,
    taken_on: date = Query(alias="date"),
    pose: Literal["front", "side", "back"] = Query(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await enforce("body-photo", user.id, 60, 3600)
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip()
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Send a JPEG, WebP or PNG")
    if int(request.headers.get("content-length") or 0) > MAX_BODY_PHOTO_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "That photo is too large")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_BODY_PHOTO_BYTES:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "That photo is too large")
    if not data.startswith(ALLOWED_TYPES[content_type]):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Not the image type it claims")

    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    if taken_on > today + timedelta(days=1):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That day has not happened yet")

    photo = await db.get(BodyPhoto, photo_id)
    if photo is not None and photo.user_id != user.id:
        # Someone else's id: refuse without saying whose.
        raise HTTPException(status.HTTP_409_CONFLICT, "Pick another id")
    if photo is None:
        count = await db.scalar(
            select(func.count()).select_from(BodyPhoto).where(BodyPhoto.user_id == user.id)
        )
        if (count or 0) >= MAX_BODY_PHOTOS:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"You have {MAX_BODY_PHOTOS} photos backed up. Delete some old ones first.",
            )
        photo = BodyPhoto(id=photo_id, user_id=user.id)
        db.add(photo)
    photo.taken_on = taken_on
    photo.pose = pose
    photo.content_type = content_type
    photo.data = bytes(data)
    photo.size = len(data)
    await db.commit()
    return _out(photo)


@router.delete("/{photo_id}", status_code=204)
async def delete_photo(
    photo_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await db.execute(
        delete(BodyPhoto).where(BodyPhoto.id == photo_id, BodyPhoto.user_id == user.id)
    )
    await db.commit()


@router.delete("", status_code=204)
async def delete_all_photos(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Turning backup off removes every copy from the server."""
    await db.execute(delete(BodyPhoto).where(BodyPhoto.user_id == user.id))
    await db.commit()
