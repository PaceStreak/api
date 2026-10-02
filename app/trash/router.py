"""The trash: deleted things, restorable for 30 days."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import utcnow
from app.database import get_db
from app.game.service import recompute
from app.habits.models import Habit, HabitLog, HabitRoutine
from app.insights.models import JournalDay
from app.nutrition.models import Food, MealEntry, Recipe
from app.training.models import Workout, sync_seq
from app.trash.models import TrashItem
from app.trash.service import rebuild

router = APIRouter(prefix="/trash", tags=["trash"])

MODELS = {
    "habit": Habit,
    "meal": MealEntry,
    "food": Food,
    "recipe": Recipe,
    "journal": JournalDay,
    "habit_routine": HabitRoutine,
}
CHILDREN = {"habit_logs": HabitLog}
# Restoring these changes streaks, so the engine reruns.
RECOMPUTE = {"habit", "workout"}
MAX_LIVE_HABITS = 30


def _out(t: TrashItem) -> dict:
    return {
        "id": str(t.id),
        "kind": t.kind,
        "item_id": str(t.item_id),
        "label": t.label,
        "deleted_at": t.deleted_at.isoformat(),
        "purge_after": t.purge_after.isoformat(),
    }


async def _own(db: AsyncSession, user: User, trash_id: UUID) -> TrashItem:
    item = await db.get(TrashItem, trash_id)
    if item is None or item.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return item


@router.get("")
async def list_trash(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(
        select(TrashItem)
        .where(TrashItem.user_id == user.id, TrashItem.purge_after > utcnow())
        .order_by(TrashItem.deleted_at.desc())
        .limit(500)
    )
    return [_out(t) for t in rows.scalars()]


@router.post("/{trash_id}/restore")
async def restore(
    trash_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Put it back exactly as it was, with its original id. Fails with 409,
    changing nothing, if something now occupies its place (a journal entry
    written for the same day, a food saved with the same barcode)."""
    item = await _own(db, user, trash_id)
    if item.kind == "workout":
        workout = await db.get(Workout, item.item_id)
        if workout is None or workout.user_id != user.id:
            raise HTTPException(status.HTTP_410_GONE, "That session can no longer be restored")
        workout.deleted_at = None
        workout.client_updated_at = utcnow()
        # A new sequence number is what makes every device's sync pick it up.
        workout.seq = sync_seq.next_value()
    else:
        model = MODELS.get(item.kind)
        row = (item.payload or {}).get("row")
        if model is None or row is None:
            raise HTTPException(status.HTTP_410_GONE, "That can no longer be restored")
        if item.kind == "habit" and row.get("archived_at") is None:
            live = (
                await db.execute(
                    select(func.count())
                    .select_from(Habit)
                    .where(Habit.user_id == user.id, Habit.archived_at.is_(None))
                )
            ).scalar_one()
            if live >= MAX_LIVE_HABITS:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"{MAX_LIVE_HABITS} habits at once is the limit. Archive one first.",
                )
        db.add(rebuild(model, row))
        for name, rows in ((item.payload or {}).get("children") or {}).items():
            child_model = CHILDREN.get(name)
            for child in rows if child_model else []:
                db.add(rebuild(child_model, child))
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Something already exists in its place"
        ) from None
    await db.delete(item)
    if item.kind in RECOMPUTE:
        await recompute(db, user.id, notify=False)
    await db.commit()
    return {"kind": item.kind, "item_id": str(item.item_id)}


@router.delete("/{trash_id}", status_code=204)
async def delete_forever(
    trash_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    item = await _own(db, user, trash_id)
    await db.delete(item)
    await db.commit()
    return Response(status_code=204)


@router.delete("", status_code=204)
async def empty_trash(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await db.execute(delete(TrashItem).where(TrashItem.user_id == user.id))
    await db.commit()
    return Response(status_code=204)
