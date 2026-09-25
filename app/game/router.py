"""Read side of the engine: streaks, heatmap, XP, records, achievements,
and the weekly aggregates behind the progress charts."""

from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import season_bounds, season_id, week_start
from app.database import get_db
from app.game import achievements as ach
from app.game.models import PersonalRecord, UserAchievement
from app.game.recap import build_recap, last_closed_week
from app.game.service import chain_payload, pause_payload, record_label, snapshot
from app.game.xp import compute_xp
from app.profile.models import Profile
from app.training.library import EXERCISE_BY_ID, MUSCLES
from app.training.models import BodyMetric, CustomExercise, Workout

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
    }


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


@router.get("/xp")
async def xp_breakdown(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Where the XP came from - shown so the system visibly teaches that
    showing up, not lifting heavier, is what it rewards."""
    snap = await snapshot(db, user.id)
    await db.commit()
    main = snap.chains[0]
    from app.game.streak import target_resolver

    unlocked = (
        await db.execute(
            select(UserAchievement.tier, UserAchievement.unlocked_on).where(
                UserAchievement.user_id == user.id
            )
        )
    ).all()
    items = compute_xp(
        snap.days,
        snap.profile.week_starts_on,
        target_resolver(main.chain.target_history),
        [c.week_start for c in main.result.weeks if c.status == "kept"],
        main.result.milestones_hit,
        [e.day for e in snap.events if e.rewarded],
        [(u.tier, u.unlocked_on) for u in unlocked],
    )
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

    body = (
        (
            await db.execute(
                select(BodyMetric)
                .where(BodyMetric.user_id == user.id, BodyMetric.measured_on >= first)
                .order_by(BodyMetric.measured_on)
            )
        )
        .scalars()
        .all()
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
                "date": b.measured_on.isoformat(),
                "weight_kg": b.weight_kg,
                "body_fat_pct": b.body_fat_pct,
                "waist_cm": b.waist_cm,
                "resting_hr": b.resting_hr,
                "sleep_hours": b.sleep_hours,
            }
            for b in body
        ],
    }
