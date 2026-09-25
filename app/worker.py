"""The scheduler. Run as its own process: `python -m app.worker`.

Everything the API cannot do in response to a request: a streak that lapsed
because nobody logged anything, a nudge aimed at 6pm in each person's own
timezone, a weekly summary, a challenge that ended overnight, an account
whose deletion grace period ran out.

One tick every WORKER_INTERVAL_SECONDS. Each tick takes a Redis lock first,
so running two worker replicas is safe - the second one skips - and every
notification carries a dedupe key, so even a tick that runs twice (a crash
between send and commit) cannot nudge anyone twice.

`python -m app.worker --once` runs a single tick and exits, for platforms that
prefer an external cron to a long-running process.
"""

import asyncio
import logging
import sys
import time
from datetime import timedelta
from uuid import UUID

from redis.exceptions import RedisError
from sqlalchemy import and_, case, delete, func, literal_column, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.auth.models import User
from app.auth.passkeys import sweep_expired_challenges
from app.cache import close_cache, get_client, init_cache
from app.common.time import local_now, local_today, utcnow, week_start
from app.config import get_settings
from app.database import AsyncSessionLocal, engine
from app.game.models import UserStats
from app.game.recap import build_recap, digest_lines
from app.game.service import recompute, snapshot
from app.groups.router import resolve_finished
from app.notifications.models import Notification, NotificationPreference
from app.notifications.service import channels_for, deliver, notify
from app.ops.health import WORKER_NAME
from app.ops.models import WorkerHeartbeat
from app.ops.service import sweep as sweep_ops
from app.profile.models import Profile

logger = logging.getLogger("app.worker")
settings = get_settings()

BATCH = 500
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def _local_hour_is(column) -> object:
    """SQL: the profile's local hour equals `column`."""
    local = func.timezone(Profile.timezone, func.now())
    return func.extract("hour", local) == column


async def refresh_stale_stats() -> int:
    """Recompute projections whose local date has rolled over. This is how a
    streak ends when the person simply stops logging: nothing writes, so
    something has to notice."""
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(UserStats.user_id, UserStats.computed_for, Profile.timezone)
                .join(Profile, Profile.user_id == UserStats.user_id)
                .where(UserStats.computed_for < func.current_date() + literal_column("1"))
                .order_by(UserStats.computed_at)
                .limit(BATCH)
            )
        ).all()
    done = 0
    for user_id, computed_for, tz in rows:
        if computed_for >= local_today(tz):
            continue
        async with AsyncSessionLocal() as db:
            await recompute(db, user_id, notify=False)
            await db.commit()
        done += 1
    return done


async def streak_nudges() -> list[UUID]:
    """At each person's reminder hour: warn about a streak at risk, else (if
    they asked for it) a plain reminder on a planned training day."""
    note_ids: list[UUID] = []
    async with AsyncSessionLocal() as db:
        profiles = (
            (
                await db.execute(
                    select(Profile)
                    .join(User, User.id == Profile.user_id)
                    .where(
                        Profile.onboarded_at.is_not(None),
                        Profile.deletion_scheduled_at.is_(None),
                        User.is_active.is_(True),
                        # Smart mode nudges at the learned hour when there
                        # is one; everyone else at their fixed hour.
                        _local_hour_is(
                            case(
                                (
                                    and_(
                                        Profile.reminder_mode == "smart",
                                        Profile.learned_reminder_hour.is_not(None),
                                    ),
                                    Profile.learned_reminder_hour,
                                ),
                                else_=Profile.reminder_hour,
                            )
                        ),
                    )
                    .limit(5000)
                )
            )
            .scalars()
            .all()
        )

    for profile in profiles:
        async with AsyncSessionLocal() as db:
            snap = await snapshot(db, profile.user_id)
            today = snap.today
            if snap.paused_today:
                # Nobody on a declared injury break gets told to train.
                continue
            sent_risk = False
            for view in snap.chains:
                r = view.result
                if not r.at_risk or (r.current == 0 and r.this_week_days == 0):
                    continue
                end = WEEKDAYS[(week_start(today, profile.week_starts_on).weekday() + 6) % 7]
                sessions = "session" if r.needed == 1 else "sessions"
                if r.will_freeze:
                    body = (
                        f"{r.needed} more {sessions} by {end} keeps '{view.chain.name}' "
                        "going. If not, a freeze covers this week - rest if you need to."
                    )
                elif r.needed > r.days_left:
                    body = (
                        f"This week is out of reach for '{view.chain.name}'. A repair can "
                        "save it later this month - no need to train sore to fix it."
                    )
                else:
                    body = (
                        f"{r.needed} more {sessions} by {end} keeps your "
                        f"{r.current}-week streak. Skip it if you're hurt or wiped - "
                        "a missed week can be repaired once a month."
                    )
                nid = await notify(
                    db,
                    profile.user_id,
                    kind="streak_risk",
                    category="streak_risk",
                    title=f"Your {r.current}-week streak needs {r.needed} more"
                    if r.current
                    else f"'{view.chain.name}' needs {r.needed} more this week",
                    body=body,
                    url="/",
                    dedupe_key=f"risk:{view.chain.id}:{today.isoformat()}",
                )
                if nid:
                    note_ids.append(nid)
                    sent_risk = True
            if not sent_risk:
                main = snap.chains[0].result
                planned = profile.training_days
                is_planned = (planned is None and main.needed > 0) or (
                    planned is not None and planned & (1 << today.weekday())
                )
                trained_today = any(d.day == today for d in snap.days)
                if is_planned and not trained_today:
                    nid = await notify(
                        db,
                        profile.user_id,
                        kind="reminder",
                        category="reminder",
                        title="Training today?",
                        body=f"{main.this_week_days} of {main.this_week_target} this week. "
                        "Ten seconds to log it.",
                        url="/log",
                        dedupe_key=f"reminder:{today.isoformat()}",
                    )
                    note_ids += [nid] if nid else []
            await db.commit()
    return note_ids


async def weekly_digest() -> list[UUID]:
    """09:00 local on the first day of each person's week: last week, summed up."""
    note_ids: list[UUID] = []
    async with AsyncSessionLocal() as db:
        profiles = (
            (
                await db.execute(
                    select(Profile)
                    .join(User, User.id == Profile.user_id)
                    .where(
                        Profile.onboarded_at.is_not(None),
                        Profile.deletion_scheduled_at.is_(None),
                        User.is_active.is_(True),
                        _local_hour_is(9),
                    )
                    .limit(5000)
                )
            )
            .scalars()
            .all()
        )
    for profile in profiles:
        now = local_now(profile.timezone)
        if now.weekday() != profile.week_starts_on:
            continue
        last_week = week_start(now.date(), profile.week_starts_on) - timedelta(days=7)
        async with AsyncSessionLocal() as db:
            snap = await snapshot(db, profile.user_id)
            recap = await build_recap(db, snap, last_week)
            if recap is None:
                continue
            title, body = digest_lines(recap)
            nid = await notify(
                db,
                profile.user_id,
                kind="weekly_digest",
                category="digest",
                title=title,
                body=body,
                url=f"/recap?week={last_week.isoformat()}",
                dedupe_key=f"digest:{last_week.isoformat()}",
            )
            await db.commit()
            note_ids += [nid] if nid else []
    return note_ids


async def monthly_backup() -> list[UUID]:
    """09:00 local on the 1st: remind the people who opted in to download a
    copy of their data. Nothing is created for anyone who has not opted in,
    so the inbox never fills with a reminder nobody asked for."""
    note_ids: list[UUID] = []
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Profile, NotificationPreference.channels)
                .join(User, User.id == Profile.user_id)
                .join(NotificationPreference, NotificationPreference.user_id == Profile.user_id)
                .where(
                    Profile.onboarded_at.is_not(None),
                    Profile.deletion_scheduled_at.is_(None),
                    User.is_active.is_(True),
                    _local_hour_is(9),
                )
                .limit(5000)
            )
        ).all()
    for profile, prefs in rows:
        wanted = channels_for(prefs, "backup")
        if not (wanted["email"] or wanted["push"]):
            continue
        now = local_now(profile.timezone)
        if now.day != 1:
            continue
        async with AsyncSessionLocal() as db:
            nid = await notify(
                db,
                profile.user_id,
                kind="monthly_backup",
                category="backup",
                title="Your monthly PaceStreak backup",
                body="A new month. Download a copy of everything you've logged - "
                "one tap, and it's yours to keep.",
                url="/settings/data?backup=1",
                dedupe_key=f"backup:{now:%Y-%m}",
            )
            await db.commit()
            note_ids += [nid] if nid else []
    return note_ids


async def purge_deleted_accounts() -> int:
    async with AsyncSessionLocal() as db:
        due = (
            (
                await db.execute(
                    select(Profile.user_id).where(Profile.deletion_scheduled_at < utcnow())
                )
            )
            .scalars()
            .all()
        )
        for user_id in due:
            # Cascades to every table keyed on the user.
            await db.execute(delete(User).where(User.id == user_id))
        await db.commit()
    return len(due)


async def housekeeping() -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(
            delete(Notification).where(Notification.created_at < utcnow() - timedelta(days=180))
        )
        await sweep_expired_challenges(db)
        await sweep_ops(db)
        await db.commit()


async def resolve_challenges() -> list[UUID]:
    async with AsyncSessionLocal() as db:
        ids = await resolve_finished(db, utcnow().date())
        await db.commit()
    return ids


async def tick() -> None:
    try:
        got = await get_client().set(
            "worker:tick", "1", nx=True, ex=max(30, settings.worker_interval_seconds - 5)
        )
    except RedisError:
        got = True  # no Redis, no contention to worry about
    if not got:
        return
    jobs = (
        ("stats", refresh_stale_stats),
        ("nudges", streak_nudges),
        ("digest", weekly_digest),
        ("challenges", resolve_challenges),
        ("backup", monthly_backup),
        ("purge", purge_deleted_accounts),
        ("housekeeping", housekeeping),
    )
    started = time.monotonic()
    report: dict[str, dict] = {}
    for name, job in jobs:
        try:
            result = await job()
            if isinstance(result, list):
                await deliver(result)
                result = len(result)
            report[name] = {"result": int(result or 0)}
            if result:
                logger.info("worker %s: %s", name, result)
        except Exception as err:
            # One failing job must not starve the rest of the tick.
            logger.exception("worker job %s failed", name)
            report[name] = {"error": type(err).__name__}
    await record_heartbeat(report, int((time.monotonic() - started) * 1000))


async def record_heartbeat(report: dict[str, dict], duration_ms: int) -> None:
    """Upsert this worker's row. Failure to record is logged, never raised:
    a heartbeat problem must not stop the jobs themselves."""
    failed = any("error" in r for r in report.values())
    try:
        async with AsyncSessionLocal() as db:
            stmt = pg_insert(WorkerHeartbeat).values(
                name=WORKER_NAME,
                last_tick_at=utcnow(),
                duration_ms=duration_ms,
                jobs=report,
                failing_ticks=1 if failed else 0,
            )
            await db.execute(
                stmt.on_conflict_do_update(
                    index_elements=[WorkerHeartbeat.name],
                    set_={
                        "last_tick_at": stmt.excluded.last_tick_at,
                        "duration_ms": stmt.excluded.duration_ms,
                        "jobs": stmt.excluded.jobs,
                        "failing_ticks": (WorkerHeartbeat.failing_ticks + 1) if failed else 0,
                        "updated_at": func.now(),
                    },
                )
            )
            await db.commit()
    except Exception:
        logger.exception("worker heartbeat not recorded")


async def main(once: bool) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    init_cache()
    try:
        while True:
            await tick()
            if once:
                break
            await asyncio.sleep(settings.worker_interval_seconds)
    finally:
        await close_cache()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main("--once" in sys.argv))
