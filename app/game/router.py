"""Read side of the engine: streaks, heatmap, XP, records, achievements,
and the weekly aggregates behind the progress charts."""

from collections import defaultdict
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import season_bounds, season_id, week_start
from app.database import get_db
from app.game import achievements as ach
from app.game.models import PersonalRecord, StreakWager, UserAchievement
from app.game.monthly import build_month
from app.game.quests import QUEST_XP
from app.game.recap import build_recap, last_closed_week
from app.game.review import build_year, record_history
from app.game.service import (
    Snapshot,
    chain_payload,
    pause_payload,
    recompute,
    record_label,
    snapshot,
)
from app.game.streak import target_resolver
from app.profile.models import Profile
from app.training.library import EXERCISE_BY_ID, MUSCLES
from app.training.models import BodyMetric, CustomExercise, WeighIn, Workout

router = APIRouter(prefix="/me", tags=["stats"])


@router.get("/stats")
async def stats(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    snap = await snapshot(db, user.id)
    await db.commit()
    ctx = snap.context
    sid = season_id(snap.today)
    start, end = season_bounds(sid)
    return {
        "today": snap.today.isoformat(),
        "week_starts_on": snap.profile.week_starts_on,
        "gamification_enabled": snap.profile.gamification_enabled,
        "level": snap.level,
        "xp": snap.xp,
        "season": {"id": sid, "starts_on": start.isoformat(), "ends_on": end.isoformat()},
        "chains": [chain_payload(v) for v in snap.chains],
        "repair_available": not snap.repair_used_this_month,
        "paused_today": snap.paused_today,
        "pauses": [pause_payload(p, snap.today) for p in snap.pauses[-12:]],
        "training_days": snap.profile.training_days,
        "heatmap": snap.heatmap,
        "totals": {
            "sessions": ctx.sessions,
            "active_days": ctx.active_days,
            "hours": round(ctx.hours, 1),
            "distance_km": round(ctx.distance_km, 1),
            "tonnage_kg": round(ctx.tonnage_kg),
            "records": ctx.rewarded_prs,
            "disciplines": ctx.distinct_disciplines,
            "exercises": ctx.distinct_exercises,
        },
        "last_active": snap.last_active.isoformat() if snap.last_active else None,
        "quests": _quests_payload(snap),
        "pr_streak": _pr_streak_payload(snap),
        "wager": _wager_state(snap),
    }


def _quests_payload(snap: Snapshot) -> dict | None:
    if not snap.profile.gamification_enabled:
        return None
    this_week = week_start(snap.today, snap.profile.week_starts_on)
    current = next((q for q in snap.quests if q.week_start == this_week), None)
    return {
        "week_start": this_week.isoformat(),
        "xp_each": QUEST_XP,
        "paused": current is None,
        "items": [
            {
                "id": q.id,
                "title": q.title,
                "description": q.description,
                "goal": q.goal,
                "progress": min(progress, q.goal),
                "done": progress >= q.goal,
            }
            for q, progress in (current.quests if current else [])
        ],
        "completed_total": sum(len(q.done) for q in snap.quests),
    }


def _pr_streak_payload(snap: Snapshot) -> dict | None:
    p = snap.pr_streak
    if p is None:
        return None
    return {
        "current": p.current,
        "longest": p.longest,
        "this_block_has_pr": p.this_block_has_pr,
        "block_ends": p.block_ends.isoformat(),
    }


def _wager_state(snap: Snapshot) -> dict:
    """The wager for this week or next, if any, and whether one can be made."""
    main = snap.chains[0]
    this_week = week_start(snap.today, snap.profile.week_starts_on)
    next_week = this_week + timedelta(days=7)
    by_week = {w.week_start: w for w in snap.wagers}
    won = set(main.result.wagers_won)
    this_cell = main.result.weeks[-1]
    target_for = target_resolver(main.chain.target_history)

    def entry(week: date) -> dict | None:
        w = by_week.get(week)
        if w is None:
            return None
        status_ = (
            "won"
            if week in won or (week == this_week and this_cell.days >= w.days)
            else ("open" if week >= this_week else "lost")
        )
        return {
            "week_start": week.isoformat(),
            "days": w.days,
            "done": this_cell.days if week == this_week else None,
            "status": status_,
        }

    def blocked(week: date) -> str | None:
        if any(w.week_start.strftime("%Y-%m") == week.strftime("%Y-%m") for w in snap.wagers):
            return "One wager a month."
        if target_for(week) + 1 > 7:
            return "Your target is already every day."
        if week == this_week and this_cell.days > 0:
            return "Wagers are made before the week's first session."
        if week == this_week and this_cell.status == "paused":
            return "Not during a pause."
        return None

    last_closed = next((w for w in reversed(snap.wagers) if w.week_start < this_week), None)
    return {
        "current": entry(this_week),
        "next": entry(next_week),
        "last": entry(last_closed.week_start) if last_closed else None,
        "options": [
            {
                "week": key,
                "week_start": week.isoformat(),
                "days": min(7, target_for(week) + 1),
                "blocked": None
                if by_week.get(week) is None and blocked(week) is None
                else (blocked(week) or "Already made."),
            }
            for key, week in (("this", this_week), ("next", next_week))
        ],
        "freezes_available": main.result.freezes_available,
    }


class WagerIn(BaseModel):
    week: Literal["this", "next"]


@router.post("/wager", status_code=201)
async def make_wager(
    body: WagerIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Promise one more day than the target in a week. Kept, it earns a
    freeze; missed, nothing happens. Opt-in, and never offered as a nag."""
    snap = await snapshot(db, user.id)
    option = next(o for o in _wager_state(snap)["options"] if o["week"] == body.week)
    if option["blocked"]:
        raise HTTPException(status.HTTP_409_CONFLICT, option["blocked"])
    db.add(
        StreakWager(
            user_id=user.id,
            week_start=date.fromisoformat(option["week_start"]),
            days=option["days"],
        )
    )
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
    return _wager_state(await snapshot(db, user.id))


@router.delete("/wager/{week}", status_code=204)
async def cancel_wager(
    week: date, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Take a wager back while nothing has been logged against it."""
    snap = await snapshot(db, user.id)
    this_week = week_start(snap.today, snap.profile.week_starts_on)
    if week < this_week or (week == this_week and snap.chains[0].result.this_week_days > 0):
        raise HTTPException(status.HTTP_409_CONFLICT, "That wager is already under way")
    await db.execute(
        delete(StreakWager).where(StreakWager.user_id == user.id, StreakWager.week_start == week)
    )
    await db.commit()


@router.get("/recap/month")
async def month_recap(
    month: str | None = Query(default=None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """One month of lifting against your own history. Defaults to last month
    once this one has barely started, otherwise this month."""
    snap = await snapshot(db, user.id)
    await db.commit()
    if month is None:
        ref = snap.today if snap.today.day > 7 else snap.today.replace(day=1) - timedelta(days=1)
        month = ref.strftime("%Y-%m")
    if month > snap.today.strftime("%Y-%m"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That month has not started")
    result = await build_month(db, snap, month)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nothing logged that month")
    return result


@router.get("/recap")
async def recap(
    week: date | None = Query(default=None, description="Any day in the week; default last week"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """One closed (or the current) week, summed up. Attendance only."""
    snap = await snapshot(db, user.id)
    target = week or last_closed_week(snap)
    if target > snap.today:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That week has not started")
    result = await build_recap(db, snap, target)
    await db.commit()
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nothing to recap for that week")
    return result


@router.get("/review")
async def year_review(
    year: int | None = Query(default=None, ge=2000, le=2100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """A calendar year, summed up. Attendance only, like the weekly recap.
    Defaults to the current year; last year until the first week of this one
    has anything to say."""
    snap = await snapshot(db, user.id)
    await db.commit()
    wanted = year or snap.today.year
    result = await build_year(db, snap, wanted)
    if result is None and year is None:
        result = await build_year(db, snap, wanted - 1)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nothing logged that year")
    return result


@router.get("/records/history")
async def records_history(
    key: str = Query(max_length=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    snap = await snapshot(db, user.id)
    await db.commit()
    result = record_history(snap, key)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such record")
    return result


@router.get("/xp")
async def xp_breakdown(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Where the XP came from - shown so the system visibly teaches that
    showing up, not lifting heavier, is what it rewards."""
    snap = await snapshot(db, user.id)
    await db.commit()
    items = snap.xp_items
    recent = sorted(items, key=lambda i: i.day, reverse=True)[:40]
    weekly: dict[str, int] = defaultdict(int)
    for item in items:
        weekly[week_start(item.day, snap.profile.week_starts_on).isoformat()] += item.amount
    return {
        "level": snap.level,
        "by_source": snap.xp["by_source"],
        "season_xp": snap.xp["season"],
        "recent": [
            {"source": i.source, "amount": i.amount, "date": i.day.isoformat()} for i in recent
        ],
        "weekly": sorted(weekly.items())[-26:],
    }


@router.get("/records")
async def records(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (
        (
            await db.execute(
                select(PersonalRecord)
                .where(PersonalRecord.user_id == user.id)
                .order_by(PersonalRecord.achieved_on.desc())
            )
        )
        .scalars()
        .all()
    )
    customs = {
        c.exercise_id: c.name
        for c in (
            await db.execute(select(CustomExercise).where(CustomExercise.user_id == user.id))
        ).scalars()
    }
    names = {e.id: e.name for e in EXERCISE_BY_ID.values()} | customs

    def out(r: PersonalRecord) -> dict:
        kind, _, subject = r.key.partition(":")
        return {
            "key": r.key,
            "kind": kind,
            "subject": subject,
            "label": record_label(r.key, names),
            "value": r.value,
            "previous": r.previous,
            "gain_pct": r.gain_pct,
            "date": r.achieved_on.isoformat(),
            "workout_id": str(r.workout_id) if r.workout_id else None,
            "flagged": r.flagged,
            "rewarded": r.rewarded,
        }

    return {
        "current": [out(r) for r in rows if r.is_current],
        "recent": [out(r) for r in rows if r.previous is not None][:30],
    }


@router.get("/achievements")
async def achievements(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    snap = await snapshot(db, user.id)
    await db.commit()
    held = (
        (await db.execute(select(UserAchievement).where(UserAchievement.user_id == user.id)))
        .scalars()
        .all()
    )
    by_rule: dict[str, dict] = defaultdict(dict)
    for a in held:
        by_rule[a.achievement_id][a.tier or "single"] = a.unlocked_on.isoformat()

    # Rarity: share of onboarded people holding each tier. Computed at read
    # time - it is one grouped count, and a stored number would only drift.
    population = (
        await db.execute(select(func.count()).where(Profile.onboarded_at.is_not(None)))
    ).scalar_one() or 1
    counts = {
        (r.achievement_id, r.tier or "single"): r.n
        for r in (
            await db.execute(
                select(
                    UserAchievement.achievement_id,
                    UserAchievement.tier,
                    func.count().label("n"),
                ).group_by(UserAchievement.achievement_id, UserAchievement.tier)
            )
        ).all()
    }

    out = []
    for rule in ach.RULES:
        unlocked = by_rule.get(rule.id, {})
        secret = rule.hidden and not unlocked
        tiers = list(ach.TIERS) if rule.tiered else ["single"]
        out.append(
            {
                "id": rule.id,
                "title": "Hidden" if secret else rule.title,
                "description": "Keep training - some things are found, not chased."
                if secret
                else rule.description,
                "category": rule.category,
                "hidden": rule.hidden,
                "secret": secret,
                "tiered": rule.tiered,
                "unit": rule.unit,
                "thresholds": [] if secret else list(rule.thresholds),
                "tier_names": list(rule.tier_names),
                "unlocked": unlocked,
                "progress": None if secret else rule.progress(snap.context),
                "rarity": {
                    t: round(counts.get((rule.id, t), 0) / population * 100, 1) for t in tiers
                },
            }
        )
    return {"achievements": out, "unlocked_count": len(held)}


@router.get("/progress")
async def progress(
    weeks: int = Query(default=12, ge=4, le=104),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    snap = await snapshot(db, user.id)
    await db.commit()
    wso = snap.profile.week_starts_on
    this_week = week_start(snap.today, wso)
    first = this_week - timedelta(weeks=weeks - 1)

    rows = (
        (
            await db.execute(
                select(Workout).where(
                    Workout.user_id == user.id,
                    Workout.deleted_at.is_(None),
                    Workout.local_date >= first,
                )
            )
        )
        .scalars()
        .all()
    )

    customs = {
        c.exercise_id: c
        for c in (
            await db.execute(select(CustomExercise).where(CustomExercise.user_id == user.id))
        ).scalars()
    }

    def muscles_of(exercise_id: str) -> tuple[list[str], list[str]]:
        if exercise_id in EXERCISE_BY_ID:
            e = EXERCISE_BY_ID[exercise_id]
            return list(e.primary), list(e.secondary)
        c = customs.get(exercise_id)
        return (list(c.primary), list(c.secondary)) if c else ([], [])

    series = {
        (first + timedelta(weeks=i)).isoformat(): {
            "week_start": (first + timedelta(weeks=i)).isoformat(),
            "sessions": 0,
            "active_days": set(),
            "minutes": 0,
            "distance_km": 0.0,
            "tonnage_kg": 0.0,
            "sets": 0,
            "by_discipline": defaultdict(int),
            "feel": [],
            "effort": [],
        }
        for i in range(weeks)
    }
    muscle_week: dict[str, float] = defaultdict(float)
    muscle_4w: dict[str, float] = defaultdict(float)
    last_7 = snap.today - timedelta(days=6)
    last_28 = snap.today - timedelta(days=27)
    for w in rows:
        bucket = series.get(week_start(w.local_date, wso).isoformat())
        if bucket is None:
            continue
        bucket["sessions"] += 1
        bucket["active_days"].add(w.local_date)
        bucket["minutes"] += (w.duration_sec or 0) // 60
        bucket["distance_km"] += (w.distance_m or 0) / 1000
        bucket["by_discipline"][w.discipline] += 1
        if w.feel:
            bucket["feel"].append(w.feel)
        if w.effort:
            bucket["effort"].append(w.effort)
        for s in w.sets:
            if not s.completed or s.kind == "warmup":
                continue
            bucket["sets"] += 1
            if s.weight_kg and s.reps:
                bucket["tonnage_kg"] += s.weight_kg * s.reps
            primary, secondary = muscles_of(s.exercise_id)
            for target, since in ((muscle_week, last_7), (muscle_4w, last_28)):
                if w.local_date >= since:
                    for m in primary:
                        target[m] += 1
                    for m in secondary:
                        target[m] += 0.5

    weekly = []
    for b in series.values():
        weekly.append(
            {
                "week_start": b["week_start"],
                "sessions": b["sessions"],
                "active_days": len(b["active_days"]),
                "minutes": b["minutes"],
                "distance_km": round(b["distance_km"], 2),
                "tonnage_kg": round(b["tonnage_kg"]),
                "sets": b["sets"],
                "by_discipline": dict(b["by_discipline"]),
                "feel": round(sum(b["feel"]) / len(b["feel"]), 1) if b["feel"] else None,
                "effort": round(sum(b["effort"]) / len(b["effort"]), 1) if b["effort"] else None,
            }
        )

    main = snap.chains[0].result
    target_by_week = {c.week_start.isoformat(): c for c in main.weeks}
    for w in weekly:
        cell = target_by_week.get(w["week_start"])
        w["target"] = cell.target if cell else None
        w["status"] = cell.status if cell else None

    body = {
        b.measured_on: b
        for b in (
            await db.execute(
                select(BodyMetric).where(
                    BodyMetric.user_id == user.id, BodyMetric.measured_on >= first
                )
            )
        ).scalars()
    }
    # A day's weight is the mean of that day's weigh-ins. The Body screen does
    # the moment-aware trend; this is only a per-day summary.
    weights = dict(
        (
            await db.execute(
                select(WeighIn.local_date, func.avg(WeighIn.weight_kg))
                .where(WeighIn.user_id == user.id, WeighIn.local_date >= first)
                .group_by(WeighIn.local_date)
            )
        ).all()
    )

    return {
        "weeks": weekly,
        "muscles": [
            {
                "id": m,
                "name": MUSCLES[m],
                "last_7_days": round(muscle_week.get(m, 0), 1),
                "weekly_avg_4w": round(muscle_4w.get(m, 0) / 4, 1),
            }
            for m in MUSCLES
        ],
        "body": [
            {
                "date": day.isoformat(),
                "weight_kg": round(weights[day], 2) if day in weights else None,
                "body_fat_pct": body[day].body_fat_pct if day in body else None,
                "waist_cm": body[day].waist_cm if day in body else None,
                "resting_hr": body[day].resting_hr if day in body else None,
                "sleep_hours": body[day].sleep_hours if day in body else None,
            }
            for day in sorted(body.keys() | weights.keys())
        ],
    }
