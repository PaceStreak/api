"""Moving rows to the trash and back.

Snapshots are generic: every mapped column is stored as JSON and coerced back
by its SQL type on restore, so a column added to Habit later is carried
through without anyone remembering to touch this file.
"""

from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import Date, DateTime, Uuid, inspect
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.time import utcnow
from app.trash.models import TrashItem

RETENTION_DAYS = 30


def snapshot(obj: Any) -> dict:
    out = {}
    for col in inspect(type(obj)).columns:
        value = getattr(obj, col.key)
        if isinstance(value, (datetime, date)):
            value = value.isoformat()
        elif isinstance(value, UUID):
            value = str(value)
        out[col.key] = value
    return out


def rebuild(model: type, data: dict) -> Any:
    """A new, unsaved instance of `model` from a snapshot. Columns the model
    no longer has are dropped; columns it gained take their defaults."""
    values = {}
    for col in inspect(model).columns:
        if col.key not in data:
            continue
        value = data[col.key]
        if value is not None:
            if isinstance(col.type, DateTime):
                value = datetime.fromisoformat(value)
            elif isinstance(col.type, Date):
                value = date.fromisoformat(value)
            elif isinstance(col.type, Uuid):
                value = UUID(value)
        values[col.key] = value
    return model(**values)


async def put_in_trash(
    db: AsyncSession,
    user_id: UUID,
    kind: str,
    item_id: UUID,
    label: str,
    row: Any | None = None,
    children: dict[str, list[Any]] | None = None,
) -> TrashItem:
    """Record a deletion. The caller deletes the rows itself, in the same
    transaction, so a failed delete never leaves a phantom trash entry."""
    now = utcnow()
    item = TrashItem(
        user_id=user_id,
        kind=kind,
        item_id=item_id,
        label=label[:160],
        payload={
            "row": snapshot(row) if row is not None else None,
            "children": {k: [snapshot(c) for c in v] for k, v in (children or {}).items()},
        },
        deleted_at=now,
        purge_after=now + timedelta(days=RETENTION_DAYS),
    )
    db.add(item)
    return item
