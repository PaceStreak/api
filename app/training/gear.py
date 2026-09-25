"""Gear: shoes, bikes and anything else that wears out.

Private to its owner. Mileage is never stored - it is the sum of the
distances of the workouts that name the gear, plus whatever it had before it
was added - so editing or deleting a session corrects it automatically.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import utcnow
from app.database import get_db
from app.training.models import Gear, Workout
from app.training.schemas import GearIn, GearPatch

router = APIRouter(prefix="/gear", tags=["training"])

MAX_GEAR = 30


async def _usage(db: AsyncSession, user_id: UUID) -> dict[UUID, tuple[float, int, object]]:
    rows = (
        await db.execute(
            select(
                Workout.gear_id,
                func.coalesce(func.sum(Workout.distance_m), 0.0),
                func.count(),
                func.max(Workout.local_date),
            )
            .where(
                Workout.user_id == user_id,
                Workout.deleted_at.is_(None),
                Workout.gear_id.is_not(None),
            )
            .group_by(Workout.gear_id)
        )
    ).all()
    return {gid: (float(dist), int(n), last) for gid, dist, n, last in rows}


def _out(g: Gear, usage: tuple[float, int, object] | None) -> dict:
    logged, sessions, last = usage or (0.0, 0, None)
    total = g.initial_m + logged
    return {
        "id": str(g.id),
        "name": g.name,
        "kind": g.kind,
        "default_for": g.default_for,
        "limit_km": round(g.limit_m / 1000, 1) if g.limit_m else None,
        "initial_km": round(g.initial_m / 1000, 1),
        "distance_m": round(total, 1),
        "sessions": sessions,
        "last_used": last.isoformat() if last else None,
        # 0-1+, so the client can say "due for replacement" at >= 1.
        "worn": round(total / g.limit_m, 3) if g.limit_m else None,
        "retired": g.retired_at is not None,
        "retired_at": g.retired_at.isoformat() if g.retired_at else None,
        "note": g.note,
    }


async def _own(db: AsyncSession, user: User, gear_id: UUID) -> Gear:
    gear = await db.get(Gear, gear_id)
    if gear is None or gear.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return gear


@router.get("")
async def list_gear(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    items = (
        (
            await db.execute(
                select(Gear)
                .where(Gear.user_id == user.id)
                .order_by(Gear.retired_at.is_not(None), Gear.created_at)
            )
        )
        .scalars()
        .all()
    )
    usage = await _usage(db, user.id)
    return [_out(g, usage.get(g.id)) for g in items]


@router.post("", status_code=201)
async def create_gear(
    body: GearIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    count = (
        await db.execute(select(func.count()).select_from(Gear).where(Gear.user_id == user.id))
    ).scalar_one()
    if count >= MAX_GEAR:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"{MAX_GEAR} items is the limit. Delete a retired one first."
        )
    gear = Gear(
        user_id=user.id,
        name=body.name.strip(),
        kind=body.kind,
        default_for=body.default_for,
        limit_m=body.limit_km * 1000 if body.limit_km else None,
        initial_m=body.initial_km * 1000,
        note=(body.note or "").strip() or None,
    )
    db.add(gear)
    await db.flush()  # the id must exist before other gear is compared to it
    await _claim_defaults(db, user.id, gear)
    await db.commit()
    await db.refresh(gear)
    return _out(gear, None)


async def _claim_defaults(db: AsyncSession, user_id: UUID, gear: Gear) -> None:
    """One default per discipline: making these the running shoes takes the
    job from whichever pair had it."""
    if not gear.default_for:
        return
    others = (
        (await db.execute(select(Gear).where(Gear.user_id == user_id, Gear.id != gear.id)))
        .scalars()
        .all()
    )
    for other in others:
        kept = [d for d in other.default_for if d not in gear.default_for]
        if kept != other.default_for:
            other.default_for = kept


@router.patch("/{gear_id}")
async def update_gear(
    gear_id: UUID,
    body: GearPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    gear = await _own(db, user, gear_id)
    sent = body.model_fields_set
    if body.name is not None:
        gear.name = body.name.strip()
    if body.kind is not None:
        gear.kind = body.kind
    if "limit_km" in sent:
        gear.limit_m = body.limit_km * 1000 if body.limit_km else None
    if body.initial_km is not None:
        gear.initial_m = body.initial_km * 1000
    if "note" in sent:
        gear.note = (body.note or "").strip() or None
    if body.retired is not None:
        gear.retired_at = utcnow() if body.retired else None
    if body.default_for is not None:
        gear.default_for = body.default_for
    if gear.retired_at is not None:
        # Retired gear is never picked for a new session.
        gear.default_for = []
    await _claim_defaults(db, user.id, gear)
    await db.commit()
    return _out(gear, (await _usage(db, user.id)).get(gear.id))


@router.delete("/{gear_id}", status_code=204)
async def delete_gear(
    gear_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Sessions that used it keep everything but the link."""
    gear = await _own(db, user, gear_id)
    await db.delete(gear)
    await db.commit()
