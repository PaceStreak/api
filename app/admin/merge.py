"""Merge one account into another: everything the source owns moves to the
destination, then the source is deleted.

The tables are read from Postgres's own foreign keys at run time rather than
listed here, so a table added next year is merged too instead of being left
behind (or cascaded away with the source). Rules:

- Sign-in material (sessions, one-time codes, passkeys, recovery codes,
  WebAuthn challenges) is not moved: the source's credentials must not start
  opening the destination.
- A row that would point an account at itself (following, blocking or
  pairing with yourself) is dropped.
- When a moved row collides with one the destination already has (its
  profile, its stats, the same badge, the same day's habit log), the
  destination's row wins and the source's copy is dropped. Callers who want
  the source's profile should move it first, which `keep_source_profile`
  does.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

NOT_MOVED = frozenset(
    {"refresh_tokens", "one_time_tokens", "passkeys", "recovery_codes", "webauthn_challenges"}
)

FK_QUERY = text(
    """
    select cl.relname as table_name, att.attname as column_name
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
    where con.contype = 'f'
      and con.confrelid = 'users'::regclass
      and ns.nspname = current_schema()
    order by 1, 2
    """
)


def _q(name: str) -> str:
    # Identifiers come from pg_catalog, never from a request; quoted anyway.
    return '"' + name.replace('"', '""') + '"'


async def merge_accounts(
    db: AsyncSession, source: UUID, dest: UUID, keep_source_profile: bool = False
) -> dict[str, int]:
    """Move `source`'s rows to `dest` inside the caller's transaction and
    delete `source`. Returns rows moved per table. The caller commits."""
    refs = [(r.table_name, r.column_name) for r in (await db.execute(FK_QUERY)).all()]
    by_table: dict[str, list[str]] = {}
    for table, column in refs:
        by_table.setdefault(table, []).append(column)
    ids = {"s": source, "d": dest}
    moved: dict[str, int] = {}

    if keep_source_profile:
        # The destination keeps its login; the person-facing profile and its
        # projection come from the source.
        for table in ("profiles", "user_stats"):
            if table in by_table:
                await db.execute(text(f"delete from {_q(table)} where user_id = :d"), ids)

    for table, columns in by_table.items():
        if table in NOT_MOVED:
            continue
        t = _q(table)
        # Rows linking the two accounts would become self-links.
        if len(columns) > 1:
            for a in columns:
                for b in columns:
                    if a != b:
                        await db.execute(
                            text(f"delete from {t} where {_q(a)} = :s and {_q(b)} = :d"), ids
                        )
        for column in columns:
            c = _q(column)
            try:
                async with db.begin_nested():
                    result = await db.execute(text(f"update {t} set {c} = :d where {c} = :s"), ids)
                moved[table] = moved.get(table, 0) + (result.rowcount or 0)
                continue
            except IntegrityError:
                pass
            # Some rows collide with the destination's: move them one by one,
            # dropping the source's copy of any that do.
            rows = (await db.execute(text(f"select ctid from {t} where {c} = :s"), ids)).all()
            for (ctid,) in rows:
                try:
                    async with db.begin_nested():
                        await db.execute(
                            text(f"update {t} set {c} = :d where ctid = :ctid"),
                            {**ids, "ctid": ctid},
                        )
                    moved[table] = moved.get(table, 0) + 1
                except IntegrityError:
                    await db.execute(text(f"delete from {t} where ctid = :ctid"), {"ctid": ctid})

    await db.execute(text("delete from users where id = :s"), ids)
    return {k: v for k, v in sorted(moved.items()) if v}
