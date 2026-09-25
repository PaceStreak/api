"""From history to streaks, XP, records and badges.

`snapshot()` is a pure read: it loads a user's history and runs the pure
engines in app/game over it. `recompute()` takes a snapshot, persists the
projections (user_stats, personal_records, new achievements), emits activity
events and notifications for anything new, and reports what changed so the
client can celebrate it at the moment it happened.

Recomputing everything on every write is deliberate. It is linear in a
user's history - thousands of rows after years of training - and it means an
edit to last month's session corrects every PR, streak and XP total after it
with no incremental bookkeeping to get wrong. If it ever becomes slow, this
is the one function to optimise.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.time import local_today, month_key, season_id, utcnow, zone
from app.game import achievements as ach
from app.game.levels import level_progress
from app.game.models import PersonalRecord, UserAchievement, UserStats
from app.game.records import RUN_BANDS, Observation, PrEvent, detect, e1rm
from app.game.streak import ChainResult, compute_chain, target_resolver
from app.game.xp import DayActivity, compute_xp, summarise
from app.groups.models import ChallengeParticipant, GroupMember
from app.profile.models import Profile
from app.profile.service import get_chains, get_profile
from app.social.models import Kudos
from app.training.library import (
    CUSTOM_PREFIX,
    ENDURANCE,
    EXERCISE_BY_ID,
    PULL_PATTERNS,
    PUSH_PATTERNS,
)
from app.training.models import (
    BodyMetric,
    CustomExercise,
    StreakChain,
    StreakPause,
    StreakRepair,
    Workout,
    WorkoutSet,
)
from app.training.pauses import Span, paused_days

HEATMAP_DAYS = 371  # 53 weeks: a full year with the partial weeks at each end


@dataclass
class ChainView:
    chain: StreakChain
    result: ChainResult


@dataclass
class Snapshot:
    profile: Profile
    today: date
    chains: list[ChainView]
    xp: dict
    level: dict
    events: list[PrEvent]
    bests: dict
    context: ach.Context
    heatmap: list[dict]
    days: list[DayActivity]
    sessions: int
    last_active: date | None
    repair_used_this_month: bool
    exercise_names: dict[str, str] = field(default_factory=dict)
    pauses: list[StreakPause] = field(default_factory=list)
    paused_today: bool = False


def exercise_meta(exercise_id: str, customs: dict[str, CustomExercise]) -> tuple[str, str, str]:
    """(name, pattern, load_type) for a library or custom exercise."""
    if exercise_id.startswith(CUSTOM_PREFIX):
        custom = customs.get(exercise_id)
        if custom is not None:
            return custom.name, custom.pattern, custom.load_type
        return "Deleted exercise", "other", "weight"
    lib = EXERCISE_BY_ID.get(exercise_id)
    if lib is None:
        return exercise_id, "other", "weight"
    return lib.name, lib.pattern, lib.load_type


def record_label(key: str, names: dict[str, str]) -> str:
    kind, _, subject = key.partition(":")
    name = names.get(subject, subject)
    return {
        "e1rm": f"{name} · estimated 1RM",
        "reps": f"{name} · most reps",
        "hold": f"{name} · longest hold",
        "distance": f"Longest {subject}",
        "pace_5k": "Fastest 5k pace",
        "pace_10k": "Fastest 10k pace",
        "pace_half": "Fastest half-marathon pace",
        "pace_marathon": "Fastest marathon pace",
    }.get(kind, key)


async def snapshot(db: AsyncSession, user_id: UUID) -> Snapshot:
    profile = await get_profile(db, user_id)
    chains = await get_chains(db, profile)
    tz = profile.timezone
    today = local_today(tz)

    workouts = (
        await db.execute(
            select(
                Workout.id,
                Workout.discipline,
                Workout.local_date,
                Workout.started_at,
                Workout.duration_sec,
                Workout.distance_m,
                Workout.effort,
                Workout.source,
            ).where(Workout.user_id == user_id, Workout.deleted_at.is_(None))
        )
    ).all()
    sets = (
        await db.execute(
            select(
                WorkoutSet.workout_id,
                WorkoutSet.exercise_id,
                WorkoutSet.weight_kg,
                WorkoutSet.reps,
                WorkoutSet.rpe,
                WorkoutSet.kind,
                WorkoutSet.duration_sec,
                Workout.local_date,
                Workout.source,
            )
            .join(Workout, Workout.id == WorkoutSet.workout_id)
            .where(
                WorkoutSet.user_id == user_id,
                Workout.deleted_at.is_(None),
                WorkoutSet.completed.is_(True),
                WorkoutSet.kind != "warmup",
            )
        )
    ).all()
    customs = {
        c.exercise_id: c
        for c in (
            await db.execute(select(CustomExercise).where(CustomExercise.user_id == user_id))
        ).scalars()
    }
    repairs = (
        (await db.execute(select(StreakRepair).where(StreakRepair.user_id == user_id)))
        .scalars()
        .all()
    )
    repair_used = any(r.month == month_key(today) for r in repairs)
    pauses = list(
        (
            await db.execute(
                select(StreakPause)
                .where(StreakPause.user_id == user_id)
                .order_by(StreakPause.starts_on)
            )
        ).scalars()
    )
    spans = [Span(p.starts_on, p.ends_on) for p in pauses]
    sheltered = paused_days(spans)

    # --- streaks ---------------------------------------------------------
    views: list[ChainView] = []
    for chain in chains:
        allowed = set(chain.disciplines)
        active = {w.local_date for w in workouts if not allowed or w.discipline in allowed}
        result = compute_chain(
            active,
            today,
            profile.week_starts_on,
            target_resolver(chain.target_history),
            repaired=[r.week_start for r in repairs if r.chain_id == chain.id],
            repair_available=not repair_used,
            paused_days=sheltered,
        )
        views.append(ChainView(chain, result))
    main = views[0]

    # --- days ------------------------------------------------------------
    sets_per_workout = Counter(s.workout_id for s in sets)
    by_day: dict[date, list] = defaultdict(list)
    for w in workouts:
        by_day[w.local_date].append(w)
    days = [
        DayActivity(
            d,
            len(ws),
            any(sets_per_workout[w.id] or w.duration_sec or w.distance_m for w in ws),
        )
        for d, ws in by_day.items()
        if d <= today
    ]

    # --- records ---------------------------------------------------------
    names: dict[str, str] = {}
    observations: list[Observation] = []
    patterns: set[str] = set()
    exercises: set[str] = set()
    tonnage = 0.0
    rpe_sets = push_sets = pull_sets = 0
    for s in sets:
        name, pattern, load_type = exercise_meta(s.exercise_id, customs)
        names[s.exercise_id] = name
        exercises.add(s.exercise_id)
        patterns.add(pattern)
        rewardable = s.source != "import"
        weight = s.weight_kg or 0.0
        if s.reps and weight > 0 and load_type in ("weight", "weighted_bw"):
            tonnage += weight * s.reps
            value = e1rm(weight, s.reps)
            if value:
                observations.append(
                    Observation(
                        f"e1rm:{s.exercise_id}",
                        round(value, 2),
                        s.local_date,
                        str(s.workout_id),
                        rewardable=rewardable,
                    )
                )
        elif s.reps and load_type in ("bodyweight", "weighted_bw"):
            observations.append(
                Observation(
                    f"reps:{s.exercise_id}",
                    s.reps,
                    s.local_date,
                    str(s.workout_id),
                    rewardable=rewardable,
                )
            )
        elif s.duration_sec and load_type == "time":
            observations.append(
                Observation(
                    f"hold:{s.exercise_id}",
                    s.duration_sec,
                    s.local_date,
                    str(s.workout_id),
                    rewardable=rewardable,
                )
            )
        if s.rpe is not None and 5 <= s.rpe <= 10:
            rpe_sets += 1
        if pattern in PUSH_PATTERNS:
            push_sets += 1
        elif pattern in PULL_PATTERNS:
            pull_sets += 1

    distance_km = hours = 0.0
    early = late = 0
    for w in workouts:
        rewardable = w.source != "import"
        if w.distance_m:
            distance_km += w.distance_m / 1000
        if w.duration_sec:
            hours += w.duration_sec / 3600
        local_hour = w.started_at.astimezone(zone(tz)).hour
        early += local_hour < 7
        late += local_hour >= 21
        if w.discipline in ENDURANCE and w.distance_m and w.distance_m > 0:
            observations.append(
                Observation(
                    f"distance:{w.discipline}",
                    round(w.distance_m, 1),
                    w.local_date,
                    str(w.id),
                    rewardable=rewardable,
                )
            )
            if w.discipline == "run" and w.duration_sec:
                pace = w.duration_sec / (w.distance_m / 1000)
                if pace >= 150:  # faster than 2:30/km is a typo, not a run
                    for band, label in RUN_BANDS:
                        if w.distance_m >= band:
                            observations.append(
                                Observation(
                                    f"pace_{label}:run",
                                    round(pace, 1),
                                    w.local_date,
                                    str(w.id),
                                    higher_is_better=False,
                                    rewardable=rewardable,
                                )
                            )

    events, bests = detect(observations)
    rewarded = [e for e in events if e.rewarded]

    # --- achievement context ---------------------------------------------
    active_dates = sorted(d.day for d in days)
    gap_return = max(
        ((b - a).days - 1 for a, b in zip(active_dates, active_dates[1:], strict=False)),
        default=0,
    )
    closed = main.result.weeks[:-1]
    restful = best_restful = 0
    for cell in closed:
        if cell.status == "kept" and cell.days <= cell.target + 2:
            restful += 1
            best_restful = max(best_restful, restful)
        else:
            restful = 0
    repaired_then_kept = any(
        cell.status == "repaired"
        and len(closed[i + 1 : i + 5]) == 4
        and all(c.status == "kept" for c in closed[i + 1 : i + 5])
        for i, cell in enumerate(closed)
    )
    social = await _social_counts(db, user_id)
    body_days = (
        await db.execute(select(func.count()).where(BodyMetric.user_id == user_id))
    ).scalar_one()
    ctx = ach.Context(
        sessions=len(workouts),
        active_days=len(days),
        kept_weeks=sum(1 for c in main.result.weeks if c.status == "kept"),
        longest_streak=max(v.result.longest for v in views),
        distinct_exercises=len(exercises),
        distinct_patterns=len(patterns - {"other"}),
        distinct_disciplines=len({w.discipline for w in workouts}),
        tonnage_kg=tonnage,
        distance_km=distance_km,
        hours=hours,
        rewarded_prs=len(rewarded),
        rpe_sets=rpe_sets,
        push_sets=push_sets,
        pull_sets=pull_sets,
        longest_gap_return=gap_return,
        early_sessions=early,
        late_sessions=late,
        restful_run=best_restful,
        repaired_then_kept=repaired_then_kept,
        body_metric_days=body_days,
        **social,
    )

    # --- XP ----------------------------------------------------------------
    unlocked = (
        await db.execute(
            select(UserAchievement.tier, UserAchievement.unlocked_on).where(
                UserAchievement.user_id == user_id
            )
        )
    ).all()
    main_target = target_resolver(main.chain.target_history)
    items = compute_xp(
        days,
        profile.week_starts_on,
        main_target,
        [c.week_start for c in main.result.weeks if c.status == "kept"],
        main.result.milestones_hit,
        [e.day for e in rewarded],
        [(u.tier, u.unlocked_on) for u in unlocked],
    )
    xp = summarise(items, season_id(today))

    # --- heatmap -------------------------------------------------------------
    since = today - timedelta(days=HEATMAP_DAYS - 1)
    heat: dict[date, dict] = {}
    for w in workouts:
        if w.local_date < since or w.local_date > today:
            continue
        minutes = (w.duration_sec or 1800) / 60
        weight = 1 + ((w.effort or 5) - 5) / 10
        cell = heat.setdefault(w.local_date, {"score": 0.0, "sessions": 0, "disciplines": set()})
        cell["score"] += minutes * weight
        cell["sessions"] += 1
        cell["disciplines"].add(w.discipline)
    heatmap = [
        {
            "date": d.isoformat(),
            "level": 1
            if c["score"] < 30
            else 2
            if c["score"] < 60
            else 3
            if c["score"] < 90
            else 4,
            "sessions": c["sessions"],
            "disciplines": sorted(c["disciplines"]),
        }
        for d, c in sorted(heat.items())
    ]

    for key in bests:
        kind, _, subject = key.partition(":")
        if kind in ("e1rm", "reps", "hold") and subject not in names:
            names[subject] = exercise_meta(subject, customs)[0]

    return Snapshot(
        profile=profile,
        today=today,
        chains=views,
        xp=xp,
        level=level_progress(xp["total"]),
        events=events,
        bests=bests,
        context=ctx,
        heatmap=heatmap,
        days=days,
        sessions=len(workouts),
        last_active=active_dates[-1] if active_dates else None,
        repair_used_this_month=repair_used,
        exercise_names=names,
        pauses=pauses,
        paused_today=any(sp.is_active(today) for sp in spans),
    )


async def _social_counts(db: AsyncSession, user_id: UUID) -> dict:
    kudos = (await db.execute(select(func.count()).where(Kudos.user_id == user_id))).scalar_one()
    groups = (
        await db.execute(select(func.count()).where(GroupMember.user_id == user_id))
    ).scalar_one()
    finished = (
        await db.execute(
            select(func.count()).where(
                ChallengeParticipant.user_id == user_id, ChallengeParticipant.completed.is_(True)
            )
        )
    ).scalar_one()
    return {"kudos_given": kudos, "groups_joined": groups, "challenges_finished": finished}


# --- persistence -------------------------------------------------------------


@dataclass
class Outcome:
    level: int
    title: str
    total_xp: int
    xp_gained: int
    leveled_up_to: int | None
    new_achievements: list[dict]
    new_records: list[dict]
    streak: dict
    notification_ids: list[UUID] = field(default_factory=list)

    def public(self) -> dict:
        data = self.__dict__.copy()
        data.pop("notification_ids")
        return data


async def recompute(
    db: AsyncSession, user_id: UUID, *, notify: bool = True, workout_id: UUID | None = None
) -> Outcome:
    """Snapshot, persist, and diff against the previous projection.

    `workout_id` scopes which new records are announced: a record that moved
    because an *old* session was edited is corrected silently rather than
    celebrated as if it happened today.
    """
    from app.notifications.service import notify as push_note
    from app.social.service import emit_event

    snap = await snapshot(db, user_id)
    profile = snap.profile
    main = snap.chains[0].result
    previous = (
        await db.execute(select(UserStats).where(UserStats.user_id == user_id))
    ).scalar_one_or_none()
    previous_records = {
        (r.key, r.achieved_on)
        for r in (
            await db.execute(select(PersonalRecord).where(PersonalRecord.user_id == user_id))
        ).scalars()
    }

    # New achievements. Never revoked: a badge earned stays earned even if
    # the session behind it is later deleted.
    held = {
        (a.achievement_id, a.tier)
        for a in (
            await db.execute(select(UserAchievement).where(UserAchievement.user_id == user_id))
        ).scalars()
    }
    new_badges: list[dict] = []
    for rule in ach.RULES:
        for tier in rule.reached(snap.context):
            if (rule.id, tier) in held:
                continue
            db.add(
                UserAchievement(
                    user_id=user_id,
                    achievement_id=rule.id,
                    tier=tier,
                    unlocked_on=snap.today,
                    evidence={"value": round(rule.value(snap.context), 1)},
                )
            )
            tier_name = None
            if tier and rule.tier_names:
                tier_name = rule.tier_names[ach.TIERS.index(tier)]
            new_badges.append(
                {
                    "id": rule.id,
                    "title": rule.title,
                    "tier": tier,
                    "tier_name": tier_name,
                    "hidden": rule.hidden,
                    "description": rule.description,
                }
            )
    if new_badges:
        await db.flush()
        # Achievements pay XP, so re-derive the totals with them included.
        snap = await snapshot(db, user_id)

    # Records projection, replaced wholesale.
    await db.execute(delete(PersonalRecord).where(PersonalRecord.user_id == user_id))
    current_keys = {(k, b.day) for k, b in snap.bests.items()}
    for key, best in snap.bests.items():
        db.add(
            PersonalRecord(
                user_id=user_id,
                key=key,
                value=best.value,
                achieved_on=best.day,
                workout_id=UUID(best.workout_id),
                is_current=True,
            )
        )
    for e in snap.events:
        if (e.key, e.day) in current_keys:
            # The current best row already exists; fold the event's detail in
            # rather than inserting a duplicate.
            continue
        db.add(
            PersonalRecord(
                user_id=user_id,
                key=e.key,
                value=e.value,
                previous=e.previous,
                gain_pct=e.gain_pct,
                achieved_on=e.day,
                workout_id=UUID(e.workout_id),
                flagged=e.flagged,
                rewarded=e.rewarded,
            )
        )
    await db.flush()
    event_by_key_day = {(e.key, e.day): e for e in snap.events}
    for key, best in snap.bests.items():
        e = event_by_key_day.get((key, best.day))
        if e is not None:
            await db.execute(
                PersonalRecord.__table__.update()
                .where(
                    PersonalRecord.user_id == user_id,
                    PersonalRecord.key == key,
                    PersonalRecord.is_current.is_(True),
                )
                .values(
                    previous=e.previous, gain_pct=e.gain_pct, flagged=e.flagged, rewarded=e.rewarded
                )
            )

    new_records = [
        {
            "key": e.key,
            "label": record_label(e.key, snap.exercise_names),
            "value": e.value,
            "previous": e.previous,
            "gain_pct": e.gain_pct,
        }
        for e in snap.events
        if e.rewarded
        and (e.key, e.day) not in previous_records
        and (workout_id is None or e.workout_id == str(workout_id))
    ]

    stats_values = {
        "computed_at": utcnow(),
        "computed_for": snap.today,
        "total_xp": snap.xp["total"],
        "level": snap.level["level"],
        "season_id": season_id(snap.today),
        "season_xp": snap.xp["season"],
        "current_streak": main.current,
        "longest_streak": main.longest,
        "consistency": main.consistency,
        "this_week_days": main.this_week_days,
        "this_week_target": main.this_week_target,
        "sessions": snap.sessions,
        "active_days": len(snap.days),
        "season_prs": sum(
            1 for e in snap.events if e.rewarded and season_id(e.day) == season_id(snap.today)
        ),
        "total_prs": sum(1 for e in snap.events if e.rewarded),
        "last_active": snap.last_active,
    }
    await db.execute(
        insert(UserStats)
        .values(user_id=user_id, **stats_values)
        .on_conflict_do_update(index_elements=[UserStats.user_id], set_=stats_values)
    )

    previous_level = previous.level if previous else 1
    previous_xp = previous.total_xp if previous else 0
    leveled = snap.level["level"] if snap.level["level"] > previous_level else None
    previous_streak = previous.current_streak if previous else 0
    milestone = next(
        (
            length
            for length, week in main.milestones_hit
            if length > previous_streak
            and length <= main.current
            and week >= snap.today - timedelta(days=13)
        ),
        None,
    )

    note_ids: list[UUID] = []
    gamified = profile.gamification_enabled
    if notify:
        day = snap.today
        for badge in new_badges if gamified else []:
            await emit_event(
                db,
                profile,
                "achievement",
                f"{badge['id']}:{badge['tier']}",
                day,
                {
                    "id": badge["id"],
                    "title": badge["title"],
                    "tier": badge["tier"],
                    "tier_name": badge["tier_name"],
                },
            )
            nid = await push_note(
                db,
                user_id,
                kind="achievement",
                category="achievements",
                title=f"Unlocked: {badge['tier_name'] or badge['title']}",
                body=badge["description"],
                url="/achievements",
                dedupe_key=f"achievement:{badge['id']}:{badge['tier']}",
            )
            note_ids += [nid] if nid else []
        for record in new_records:
            await emit_event(
                db,
                profile,
                "pr",
                f"{record['key']}:{day}",
                day,
                {
                    "label": record["label"],
                    "key": record["key"],
                    "value": record["value"],
                    "gain_pct": record["gain_pct"],
                },
                workout_id=workout_id,
            )
        if leveled and gamified:
            await emit_event(
                db,
                profile,
                "level",
                f"level:{leveled}",
                day,
                {"level": leveled, "title": snap.level["title"]},
            )
            nid = await push_note(
                db,
                user_id,
                kind="level_up",
                category="achievements",
                title=f"Level {leveled} - {snap.level['title']}",
                body="Consistency, compounding.",
                url="/profile",
                dedupe_key=f"level:{leveled}",
            )
            note_ids += [nid] if nid else []
        if milestone:
            chain = snap.chains[0].chain
            await emit_event(
                db,
                profile,
                "streak",
                f"streak:{chain.id}:{milestone}:{main.run_started}",
                day,
                {"weeks": milestone, "chain": chain.name},
            )
            nid = await push_note(
                db,
                user_id,
                kind="streak_milestone",
                category="achievements",
                title=f"{milestone}-week streak",
                body=f"{milestone} weeks of showing up on '{chain.name}'.",
                url="/",
                dedupe_key=f"milestone:{chain.id}:{milestone}:{main.run_started}",
            )
            note_ids += [nid] if nid else []

    return Outcome(
        level=snap.level["level"],
        title=snap.level["title"],
        total_xp=snap.xp["total"],
        xp_gained=max(0, snap.xp["total"] - previous_xp),
        leveled_up_to=leveled,
        new_achievements=new_badges if gamified else [],
        new_records=new_records,
        streak={
            "current": main.current,
            "this_week_days": main.this_week_days,
            "target": main.this_week_target,
            "milestone": milestone,
        },
        notification_ids=note_ids,
    )


def chain_payload(view: ChainView, weeks: int = 26) -> dict:
    r = view.result
    return {
        "id": str(view.chain.id),
        "name": view.chain.name,
        "disciplines": view.chain.disciplines,
        "target": view.chain.target,
        "current": r.current,
        "longest": r.longest,
        "freezes_available": r.freezes_available,
        "this_week_days": r.this_week_days,
        "this_week_target": r.this_week_target,
        "days_left": r.days_left,
        "needed": r.needed,
        "at_risk": r.at_risk,
        "will_freeze": r.will_freeze,
        "repairable_week": r.repairable_week.isoformat() if r.repairable_week else None,
        "run_started": r.run_started.isoformat() if r.run_started else None,
        "consistency": r.consistency,
        "paused_now": r.paused_now,
        "weeks": [
            {
                "week_start": c.week_start.isoformat(),
                "days": c.days,
                "target": c.target,
                "status": c.status,
                "score": c.score,
            }
            for c in r.weeks[-weeks:]
        ],
    }


def pause_payload(pause: StreakPause, today: date) -> dict:
    span = Span(pause.starts_on, pause.ends_on)
    return {
        "id": str(pause.id),
        "starts_on": pause.starts_on.isoformat(),
        "ends_on": pause.ends_on.isoformat() if pause.ends_on else None,
        "effective_end": span.effective_end().isoformat(),
        "reason": pause.reason,
        "note": pause.note,
        "active": span.is_active(today),
        "upcoming": pause.starts_on > today,
    }


def datetime_or_none(value: datetime | None) -> str | None:
    return value.isoformat() if value else None
