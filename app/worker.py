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

from app import storage
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
from app.habits.actions import action_url
from app.habits.engine import is_done
from app.habits.models import Habit, HabitLog
from app.notifications.models import Notification, NotificationPreference
from app.notifications.service import channels_for, deliver, notify
from app.ops.health import WORKER_NAME
from app.ops.models import WorkerHeartbeat
from app.ops.service import sweep as sweep_ops
from app.profile.models import Profile
from app.training.models import BodyPhoto, StreakPause
from app.training.pauses import Span
from app.trash.models import TrashItem

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


BUDDY_NUDGE_HOUR = 17


async def buddy_nudges() -> list[UUID]:
    """At 5pm local for the helper: if their buddy is still short this week
    with at most two days left, and it's still reachable, suggest sending
    some encouragement. Never about a paused buddy, never twice in one of
    the buddy's weeks, and it says nothing about why they're short."""
    from app.game.models import UserStats
    from app.social.models import BuddyPair

    note_ids: list[UUID] = []
    async with AsyncSessionLocal() as db:
        pairs = (
            (await db.execute(select(BuddyPair).where(BuddyPair.status == "active")))
            .scalars()
            .all()
        )
        if not pairs:
            return []
        ids = {x for p in pairs for x in (p.user_a, p.user_b)}
        profiles = {
            p.user_id: p
            for p in (await db.execute(select(Profile).where(Profile.user_id.in_(ids)))).scalars()
        }
        stats = {
            s.user_id: s
            for s in (
                await db.execute(select(UserStats).where(UserStats.user_id.in_(ids)))
            ).scalars()
        }
        for pair in pairs:
            for helper, buddy in ((pair.user_a, pair.user_b), (pair.user_b, pair.user_a)):
                hp, bp, bs = profiles.get(helper), profiles.get(buddy), stats.get(buddy)
                if hp is None or bp is None or bs is None or not bs.recent_weeks:
                    continue
                if local_now(hp.timezone).hour != BUDDY_NUDGE_HOUR:
                    continue
                if bs.recent_weeks[-1] != "open":
                    continue  # kept already, or paused: nothing to say
                today = local_today(bp.timezone)
                week = week_start(today, bp.week_starts_on)
                days_left = (week + timedelta(days=6) - today).days + 1
                needed = bs.this_week_target - bs.this_week_days
                if not 0 < needed <= days_left <= 2:
                    continue
                nid = await notify(
                    db,
                    helper,
                    kind="buddy_at_risk",
                    category="social",
                    title=f"@{bp.handle} needs {needed} more this week",
                    body="Your buddy streak rides on it. "
                    "A quick word of encouragement goes a long way.",
                    url="/buddies",
                    actor_id=buddy,
                    dedupe_key=f"buddy-risk:{pair.id}:{buddy}:{week.isoformat()}",
                )
                note_ids += [nid] if nid else []
        await db.commit()
    return note_ids


async def monthly_backup() -> list[UUID]:
    """09:00 local on the 1st (or, for people who chose weekly, on the first
    day of their week): remind the people who opted in to download a copy of
    their data. Nothing is created for anyone who has not opted in,
    so the inbox never fills with a reminder nobody asked for."""
    note_ids: list[UUID] = []
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(
                    Profile,
                    NotificationPreference.channels,
                    NotificationPreference.backup_attachment,
                    NotificationPreference.backup_frequency,
                )
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
    for profile, prefs, attach, frequency in rows:
        wanted = channels_for(prefs, "backup")
        if not (wanted["email"] or wanted["push"]):
            continue
        now = local_now(profile.timezone)
        weekly = frequency == "weekly"
        # week_starts_on uses date.weekday()'s numbering (Monday = 0).
        if weekly and now.weekday() != profile.week_starts_on:
            continue
        if not weekly and now.day != 1:
            continue
        period = f"{now:%G-W%V}" if weekly else f"{now:%Y-%m}"
        word = "weekly" if weekly else "monthly"
        async with AsyncSessionLocal() as db:
            nid = await notify(
                db,
                profile.user_id,
                kind="monthly_backup",
                category="backup",
                title=f"Your {word} PaceStreak backup",
                body=(
                    f"A new {'week' if weekly else 'month'}, "
                    "and a copy of everything you've logged."
                    if attach and wanted["email"]
                    else f"A new {'week' if weekly else 'month'}. Download a copy of everything "
                    "you've logged - one tap, and it's yours to keep."
                ),
                url="/settings/data?backup=1",
                data={"export_attachment": True} if attach and wanted["email"] else None,
                dedupe_key=f"backup:{period}",
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
        keys = (
            (await db.execute(select(BodyPhoto.object_key).where(BodyPhoto.user_id.in_(due))))
            .scalars()
            .all()
        )
        for user_id in due:
            # Cascades to every table keyed on the user - except R2, which
            # Postgres's foreign keys cannot reach, so the object keys are
            # collected above and swept after the commit.
            await db.execute(delete(User).where(User.id == user_id))
        await db.commit()
    await storage.delete_objects(list(keys))
    return len(due)


async def housekeeping() -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(
            delete(Notification).where(Notification.created_at < utcnow() - timedelta(days=180))
        )
        await db.execute(delete(TrashItem).where(TrashItem.purge_after < utcnow()))
        await sweep_expired_challenges(db)
        await sweep_ops(db)
        await db.commit()


async def resolve_challenges() -> list[UUID]:
    async with AsyncSessionLocal() as db:
        ids = await resolve_finished(db, utcnow().date())
        await db.commit()
    return ids


async def _paused(db, user_id, today) -> bool:
    pauses = (await db.execute(select(StreakPause).where(StreakPause.user_id == user_id))).scalars()
    return any(Span(p.starts_on, p.ends_on).is_active(today) for p in pauses)


def _habit_off_today(habit: Habit, today) -> bool:
    """Not a day to nudge about this habit: it isn't planned for today, or
    it's paused on its own."""
    from app.habits.engine import scheduled

    if not scheduled(habit.days_mask, today):
        return True
    return (
        habit.paused_from is not None
        and habit.paused_from <= today
        and (habit.paused_until is None or today <= habit.paused_until)
    )


async def _done_today(db, habit: Habit, today) -> bool:
    logged = (
        await db.execute(
            select(HabitLog.amount).where(HabitLog.habit_id == habit.id, HabitLog.day == today)
        )
    ).scalar_one_or_none()
    return logged is not None and is_done(habit.kind, logged, habit.daily_goal)


async def _remind(db, habit: Habit, profile: Profile, today, dedupe_key: str) -> UUID | None:
    goal = (
        f" {habit.daily_goal:g} {habit.unit or ''}".rstrip()
        if habit.kind in ("duration", "count") and habit.daily_goal
        else ""
    )
    day = today.isoformat()
    return await notify(
        db,
        profile.user_id,
        kind="habit_reminder",
        category="habits",
        title=f"{habit.emoji} {habit.name}".strip(),
        body=(habit.cue + ". " if habit.cue else "")
        + (f"Today's goal:{goal}." if goal else "One tap when it's done."),
        url=f"/habits/{habit.id}",
        # Buttons on the push itself; signed, since the service worker that
        # handles them has no session (app/habits/actions.py).
        data={
            "actions": [
                {
                    "action": "done",
                    "title": "Done",
                    "url": action_url(profile.user_id, habit.id, "done", day),
                },
                {
                    "action": "snooze",
                    "title": "In 1 hour",
                    "url": action_url(profile.user_id, habit.id, "snooze", day),
                },
            ]
        },
        dedupe_key=dedupe_key,
    )


async def habit_reminders() -> list[UUID]:
    """At the hour someone chose for a habit, if it isn't done yet today. Not
    for habits being broken - "don't smoke" at 6pm is a prompt, not a help -
    and not during a pause. Quiet hours and the reminder category's settings
    apply as for every other nudge, via notify(), in its own "habits"
    category so it can be turned off separately. People who chose one evening
    summary instead (habit_summary_hour) get that, from habit_summary()."""
    note_ids: list[UUID] = []
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Habit, Profile)
                .join(Profile, Profile.user_id == Habit.user_id)
                .join(User, User.id == Habit.user_id)
                .outerjoin(NotificationPreference, NotificationPreference.user_id == Habit.user_id)
                .where(
                    Habit.remind_hour.is_not(None),
                    Habit.archived_at.is_(None),
                    Habit.kind != "quit",
                    Profile.onboarded_at.is_not(None),
                    Profile.deletion_scheduled_at.is_(None),
                    User.is_active.is_(True),
                    NotificationPreference.habit_summary_hour.is_(None),
                    _local_hour_is(Habit.remind_hour),
                )
                .limit(BATCH * 10)
            )
        ).all()
        for habit, profile in rows:
            today = local_today(profile.timezone)
            if (
                _habit_off_today(habit, today)
                or await _paused(db, profile.user_id, today)
                or await _done_today(db, habit, today)
            ):
                continue
            nid = await _remind(db, habit, profile, today, f"habit:{habit.id}:{today.isoformat()}")
            if nid:
                note_ids.append(nid)
        await db.commit()
    return note_ids


async def snoozed_reminders() -> list[UUID]:
    """A snooze that has run out: remind again if it still isn't done, then
    clear it, so each snooze fires at most once."""
    note_ids: list[UUID] = []
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Habit, Profile)
                .join(Profile, Profile.user_id == Habit.user_id)
                .join(User, User.id == Habit.user_id)
                .where(
                    Habit.snoozed_until.is_not(None),
                    Habit.snoozed_until <= utcnow(),
                    User.is_active.is_(True),
                    Profile.deletion_scheduled_at.is_(None),
                )
                .limit(BATCH * 10)
            )
        ).all()
        for habit, profile in rows:
            due = habit.snoozed_until
            habit.snoozed_until = None
            today = local_today(profile.timezone)
            if habit.archived_at is not None or habit.kind == "quit":
                continue
            if (
                _habit_off_today(habit, today)
                or await _paused(db, profile.user_id, today)
                or await _done_today(db, habit, today)
            ):
                continue
            nid = await _remind(
                db, habit, profile, today, f"habit-snooze:{habit.id}:{due.isoformat()}"
            )
            if nid:
                note_ids.append(nid)
        await db.commit()
    return note_ids


async def habit_summary() -> list[UUID]:
    """One notification at the hour someone chose, instead of one per habit:
    how many are still open today. A count, never names - it shows on a lock
    screen, and a habit's name is nobody else's business."""
    note_ids: list[UUID] = []
    async with AsyncSessionLocal() as db:
        rows = (
            (
                await db.execute(
                    select(Profile)
                    .join(User, User.id == Profile.user_id)
                    .join(NotificationPreference, NotificationPreference.user_id == Profile.user_id)
                    .where(
                        NotificationPreference.habit_summary_hour.is_not(None),
                        Profile.onboarded_at.is_not(None),
                        Profile.deletion_scheduled_at.is_(None),
                        User.is_active.is_(True),
                        _local_hour_is(NotificationPreference.habit_summary_hour),
                    )
                    .limit(BATCH * 10)
                )
            )
            .scalars()
            .all()
        )
        for profile in rows:
            today = local_today(profile.timezone)
            if await _paused(db, profile.user_id, today):
                continue
            habits = (
                (
                    await db.execute(
                        select(Habit).where(
                            Habit.user_id == profile.user_id,
                            Habit.archived_at.is_(None),
                            Habit.kind != "quit",
                            Habit.started_on <= today,
                        )
                    )
                )
                .scalars()
                .all()
            )
            open_ = [
                h
                for h in habits
                if not _habit_off_today(h, today) and not await _done_today(db, h, today)
            ]
            if not open_:
                continue
            n = len(open_)
            nid = await notify(
                db,
                profile.user_id,
                kind="habit_summary",
                category="habits",
                title=f"{n} habit{'' if n == 1 else 's'} still open today",
                body="A few minutes now keeps the week on track.",
                url="/habits",
                dedupe_key=f"habit-summary:{today.isoformat()}",
            )
            if nid:
                note_ids.append(nid)
        await db.commit()
    return note_ids


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
        ("habits", habit_reminders),
        ("habit_snoozes", snoozed_reminders),
        ("habit_summary", habit_summary),
        ("digest", weekly_digest),
        ("challenges", resolve_challenges),
        ("backup", monthly_backup),
        ("buddies", buddy_nudges),
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
