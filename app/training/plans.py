"""Training plans: a schedule of suggested sessions over several weeks.

A plan never changes what the streak counts. It answers "what should I do
today?", and it reads the log to say what's done - so there is nothing to
tick off by hand, and an offline session that syncs later completes its plan
day the moment it arrives.

Matching is forgiving on purpose. A session counts for the plan day it was
scheduled on; if it happened on another day of the same week, it still
counts for an unfinished plan session of the same kind that week. Life moves
Tuesday's run to Wednesday, and the plan should not call that a miss.
"""

from collections import defaultdict
from datetime import date, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import local_today, utcnow, week_start
from app.database import get_db
from app.profile.models import Profile
from app.profile.service import get_profile
from app.training.library import DISCIPLINE_IDS, EXERCISE_BY_ID, TEMPLATE_BY_ID
from app.training.models import Routine, TrainingPlan, Workout
from app.training.plan_templates import PLAN_TEMPLATE_BY_ID, PLAN_TEMPLATES
from app.training.race import RacePlanError, build_race_plan
from app.training.schemas import RoutineItem

router = APIRouter(prefix="/plans", tags=["training"])

MAX_PLANS = 20
MAX_WEEKS = 26
MAX_PER_WEEK = 14


class PlanSession(BaseModel):
    day: int = Field(ge=0, le=6)
    discipline: str
    title: str = Field(min_length=1, max_length=80)
    minutes: int | None = Field(default=None, ge=1, le=600)
    distance_km: float | None = Field(default=None, gt=0, le=500)
    routine_id: UUID | None = None
    note: str | None = Field(default=None, max_length=200)

    @field_validator("discipline")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in DISCIPLINE_IDS:
            raise ValueError("unknown discipline")
        return v


class PlanIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str | None = Field(default=None, max_length=500)
    weeks: list[list[PlanSession]] = Field(min_length=1, max_length=MAX_WEEKS)
    repeat: bool = False

    @field_validator("weeks")
    @classmethod
    def _week_size(cls, v: list[list[PlanSession]]) -> list[list[PlanSession]]:
        if any(len(w) > MAX_PER_WEEK for w in v):
            raise ValueError(f"at most {MAX_PER_WEEK} sessions a week")
        return [sorted(w, key=lambda s: s.day) for w in v]


class PlanCreate(BaseModel):
    template_id: str | None = None
    plan: PlanIn | None = None


class StartIn(BaseModel):
    # "this" week or "next" week. A plan always starts on a week boundary.
    when: str = Field(default="this", pattern="^(this|next)$")


# --- the pure part ---------------------------------------------------------------


def match_week(
    sessions: list[dict], week_start_day: date, done: list[tuple[date, str]], today: date
) -> list[dict]:
    """Statuses for one week of a plan. `done` is (local_date, discipline)
    for every session logged that week. Pure: no I/O.

    done      - logged on its day, or later/earlier that week (moved: true)
    today     - scheduled today, not yet done
    upcoming  - later this week
    skipped   - its day has passed and nothing of its kind took its place
    """
    remaining = list(done)
    out: list[dict] = [dict(s) for s in sessions]
    # Exact day first, so a moved session never steals a slot from one that
    # happened on schedule.
    for s in out:
        when = week_start_day + timedelta(days=s["day"])
        s["date"] = when.isoformat()
        hit = next((d for d in remaining if d == (when, s["discipline"])), None)
        if hit:
            remaining.remove(hit)
            s["status"], s["moved"] = "done", False
    for s in out:
        if "status" in s:
            continue
        hit = next((d for d in remaining if d[1] == s["discipline"]), None)
        if hit:
            remaining.remove(hit)
            s["status"], s["moved"] = "done", True
            continue
        when = date.fromisoformat(s["date"])
        s["moved"] = False
        s["status"] = "today" if when == today else "upcoming" if when > today else "skipped"
    return out


def plan_position(plan: TrainingPlan, today: date, starts_on: int) -> int | None:
    """0-based week index today, or None if the plan is not running. May be
    >= len(weeks) once the plan has run its course."""
    if plan.started_on is None:
        return None
    return (week_start(today, starts_on) - plan.started_on).days // 7


def cycle_start(plan: TrainingPlan, index: int | None) -> date:
    """The week-start date of the cycle being shown. A plan that runs once
    has one cycle, from its first week; a repeating plan shows the lap it is
    on now, so its statuses and progress are about this time round."""
    assert plan.started_on is not None
    length = len(plan.weeks or []) or 1
    if not plan.repeat or index is None or index < length:
        return plan.started_on
    return plan.started_on + timedelta(weeks=index - index % length)


# --- views -----------------------------------------------------------------------


def _summary(plan: TrainingPlan) -> dict:
    weeks = plan.weeks or []
    return {
        "id": str(plan.id),
        "name": plan.name,
        "description": plan.description,
        "template_id": plan.template_id,
        "weeks_count": len(weeks),
        "sessions_count": sum(len(w) for w in weeks),
        "started_on": plan.started_on.isoformat() if plan.started_on else None,
        "finished_at": plan.finished_at.isoformat() if plan.finished_at else None,
        "active": plan.started_on is not None and plan.finished_at is None,
        "repeat": plan.repeat,
    }


async def _logged(
    db: AsyncSession, user_id: UUID, start: date, end: date, app_only: bool = False
) -> dict[date, list[tuple[date, str]]]:
    stmt = select(Workout.local_date, Workout.discipline).where(
        Workout.user_id == user_id,
        Workout.deleted_at.is_(None),
        Workout.local_date >= start,
        Workout.local_date <= end,
    )
    if app_only:
        # Challenges never count imported history, like every other challenge.
        stmt = stmt.where(Workout.source == "app")
    rows = (await db.execute(stmt)).all()
    by_week: dict[date, list[tuple[date, str]]] = defaultdict(list)
    for d, disc in rows:
        by_week[start + timedelta(weeks=(d - start).days // 7)].append((d, disc))
    return by_week


async def plan_view(
    db: AsyncSession, plan: TrainingPlan, profile: Profile, app_only: bool = False
) -> dict:
    """The whole plan with a status on every session that has come due."""
    today = local_today(profile.timezone)
    out = _summary(plan) | {
        "weeks": plan.weeks,
        "challenge_id": str(plan.challenge_id) if plan.challenge_id else None,
        "assigned_by": str(plan.assigned_by) if plan.assigned_by else None,
    }
    if plan.started_on is None:
        return out | {"current_week": None, "today": [], "progress": None}
    weeks = plan.weeks or []
    index = plan_position(plan, today, profile.week_starts_on)
    base = cycle_start(plan, index)
    end = base + timedelta(weeks=len(weeks)) - timedelta(days=1)
    logged = await _logged(db, plan.user_id, base, min(end, today), app_only)
    detailed = []
    done = total_due = 0
    for i, sessions in enumerate(weeks):
        ws = base + timedelta(weeks=i)
        if ws > today:
            detailed.append(
                [
                    dict(s)
                    | {
                        "date": (ws + timedelta(days=s["day"])).isoformat(),
                        "status": "upcoming",
                        "moved": False,
                    }
                    for s in sessions
                ]
            )
            continue
        matched = match_week(sessions, ws, logged.get(ws, []), today)
        detailed.append(matched)
        for s in matched:
            if s["status"] != "upcoming":
                total_due += 1
            if s["status"] == "done":
                done += 1
    if index is not None:
        index -= (base - plan.started_on).days // 7
    current = index if index is not None and 0 <= index < len(weeks) else None
    return out | {
        "weeks": detailed,
        "current_week": current,
        "today": [s for s in detailed[current] if s["date"] == today.isoformat()]
        if current is not None
        else [],
        "progress": {"done": done, "due": total_due, "total": sum(len(w) for w in weeks)},
        "cycle": (base - plan.started_on).days // (7 * len(weeks)) + 1 if weeks else 1,
    }


async def _finish_if_over(plan: TrainingPlan, profile: Profile) -> None:
    if plan.started_on is None or plan.finished_at is not None or plan.repeat:
        return
    index = plan_position(plan, local_today(profile.timezone), profile.week_starts_on)
    if index is not None and index >= len(plan.weeks or []):
        plan.finished_at = utcnow()


async def _own(db: AsyncSession, user: User, plan_id: UUID) -> TrainingPlan:
    plan = await db.get(TrainingPlan, plan_id)
    if plan is None or plan.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return plan


async def _check_routines(db: AsyncSession, user: User, body: PlanIn) -> None:
    ids = {s.routine_id for w in body.weeks for s in w if s.routine_id}
    if not ids:
        return
    owned = set(
        (
            await db.execute(
                select(Routine.id).where(Routine.user_id == user.id, Routine.id.in_(ids))
            )
        ).scalars()
    )
    if ids - owned:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "A session names a routine that isn't yours"
        )


async def _from_template(db: AsyncSession, user: User, template: dict) -> list[list[dict]]:
    """Copy a template, turning each routine template into one of the
    person's routines (reusing one with the same name if it exists)."""
    routines: dict[str, UUID] = {}
    weeks: list[list[dict]] = []
    for week in template["weeks"]:
        out_week = []
        for s in week:
            s = dict(s)
            tpl = s.pop("routine_template", None)
            if tpl and tpl in TEMPLATE_BY_ID:
                if tpl not in routines:
                    rt = TEMPLATE_BY_ID[tpl]
                    existing = (
                        await db.execute(
                            select(Routine)
                            .where(Routine.user_id == user.id, Routine.name == rt["name"])
                            # Names aren't unique (two plans can share a routine
                            # template, or the person made one by hand), so take
                            # the oldest rather than demanding exactly one.
                            .order_by(Routine.created_at, Routine.id)
                            .limit(1)
                        )
                    ).scalar_one_or_none()
                    if existing is None:
                        existing = Routine(
                            user_id=user.id,
                            name=rt["name"],
                            discipline=rt["discipline"],
                            notes=rt["summary"],
                            items=rt["items"],
                        )
                        db.add(existing)
                        await db.flush()
                    routines[tpl] = existing.id
                s["routine_id"] = str(routines[tpl])
            out_week.append(PlanSession.model_validate(s).model_dump(mode="json"))
        weeks.append(out_week)
    return weeks


# --- endpoints -------------------------------------------------------------------


@router.get("/templates")
async def templates():
    return [
        {
            "id": t["id"],
            "name": t["name"],
            "summary": t["summary"],
            "weeks_count": len(t["weeks"]),
            "per_week": max(len(w) for w in t["weeks"]),
            "disciplines": sorted({s["discipline"] for w in t["weeks"] for s in w}),
            "equipment": _template_equipment(t),
        }
        for t in PLAN_TEMPLATES
    ]


def _template_equipment(template: dict) -> list[str]:
    """Every kind of equipment the plan's routines use; empty for plans that
    need none (runs, walks, bodyweight). Lets the app say whether a plan fits
    the gym someone trains at."""
    from app.training.library import EXERCISE_BY_ID, TEMPLATE_BY_ID

    kinds = {
        EXERCISE_BY_ID[item["exercise_id"]].equipment
        for week in template["weeks"]
        for session in week
        if session.get("routine_template") in TEMPLATE_BY_ID
        for item in TEMPLATE_BY_ID[session["routine_template"]]["items"]
    }
    return sorted(kinds - {"bodyweight"})


@router.get("")
async def list_plans(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    profile = await get_profile(db, user.id)
    plans = (
        (
            await db.execute(
                select(TrainingPlan)
                .where(TrainingPlan.user_id == user.id)
                .order_by(TrainingPlan.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    for p in plans:
        await _finish_if_over(p, profile)
    await db.commit()
    return [_summary(p) for p in plans]


@router.get("/active")
async def active_plan(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The running plan with today's sessions, or null. Cheap enough for the
    home screen: one plan, one week-bounded query."""
    profile = await get_profile(db, user.id)
    plan = (
        await db.execute(
            select(TrainingPlan).where(
                TrainingPlan.user_id == user.id,
                TrainingPlan.started_on.is_not(None),
                TrainingPlan.finished_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if plan is None:
        return None
    await _finish_if_over(plan, profile)
    view = await plan_view(db, plan, profile)
    await db.commit()
    return view


@router.post("", status_code=201)
async def create_plan(
    body: PlanCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    count = (
        await db.execute(
            select(func.count()).select_from(TrainingPlan).where(TrainingPlan.user_id == user.id)
        )
    ).scalar_one()
    if count >= MAX_PLANS:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"{MAX_PLANS} plans is the limit. Delete an old one first."
        )
    if body.template_id:
        template = PLAN_TEMPLATE_BY_ID.get(body.template_id)
        if template is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such template")
        plan = TrainingPlan(
            user_id=user.id,
            name=template["name"],
            description=template["summary"],
            template_id=template["id"],
            weeks=await _from_template(db, user, template),
        )
    elif body.plan:
        await _check_routines(db, user, body.plan)
        plan = TrainingPlan(
            user_id=user.id,
            name=body.plan.name.strip(),
            description=(body.plan.description or "").strip() or None,
            weeks=[[s.model_dump(mode="json") for s in w] for w in body.plan.weeks],
            repeat=body.plan.repeat,
        )
    else:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a template or send a plan"
        )
    db.add(plan)
    await db.commit()
    await db.refresh(plan)
    return await plan_view(db, plan, await get_profile(db, user.id))


class RaceIn(BaseModel):
    race: str = Field(pattern="^(5k|10k|half|marathon)$")
    race_date: date
    per_week: int = Field(default=3, ge=3, le=5)


@router.post("/race", status_code=201)
async def create_race_plan(
    body: RaceIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Build a plan from this week to race day, plus a recovery week, and
    start it. Any running plan is stopped, as with starting one by hand."""
    await check_plan_room(db, user.id)
    profile = await get_profile(db, user.id)
    try:
        first, weeks, name = build_race_plan(
            body.race,
            body.race_date,
            local_today(profile.timezone),
            profile.week_starts_on,
            body.per_week,
        )
    except RacePlanError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error
    plan = TrainingPlan(
        user_id=user.id,
        name=name[:60],
        description=(
            "Easy running most days, one faster session once the base is built, a taper, "
            "then a recovery week. A schedule of suggestions: rest when you need to."
        ),
        template_id=f"race-{body.race}",
        weeks=weeks,
    )
    db.add(plan)
    await db.flush()
    await run_only(db, plan, first)
    await db.commit()
    await db.refresh(plan)
    return await plan_view(db, plan, profile)


PLAN_FORMAT = "pacestreak-plan"


async def shareable(db: AsyncSession, plan: TrainingPlan) -> dict:
    """A plan in the shareable format. Routines belong to an account, so each
    one a session uses is embedded by value and the recipient gets their own
    copy. Custom exercises are someone else's too, so routine items naming
    them are left out rather than exported as ids that mean nothing."""
    ids = {s.get("routine_id") for w in plan.weeks or [] for s in w if s.get("routine_id")}
    routines = (
        {
            str(r.id): r
            for r in (
                await db.execute(
                    select(Routine).where(Routine.user_id == plan.user_id, Routine.id.in_(ids))
                )
            ).scalars()
        }
        if ids
        else {}
    )

    def session_out(s: dict) -> dict:
        out = {
            k: s.get(k) for k in ("day", "discipline", "title", "minutes", "distance_km", "note")
        }
        r = routines.get(str(s.get("routine_id")))
        if r is not None:
            out["routine"] = {
                "name": r.name,
                "discipline": r.discipline,
                "notes": r.notes,
                "items": [i for i in r.items if i.get("exercise_id") in EXERCISE_BY_ID],
            }
        return out

    return {
        "format": PLAN_FORMAT,
        "version": 1,
        "name": plan.name,
        "description": plan.description,
        "weeks": [[session_out(s) for s in w] for w in plan.weeks or []],
        "repeat": plan.repeat,
    }


@router.get("/{plan_id}/export")
async def export_plan(
    plan_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await shareable(db, await _own(db, user, plan_id))


class SharedRoutine(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    discipline: str = "strength"
    notes: str | None = Field(default=None, max_length=500)
    items: list[RoutineItem] = Field(default_factory=list, max_length=40)


class SharedSession(PlanSession):
    routine: SharedRoutine | None = None


class SharedPlan(BaseModel):
    format: str = Field(pattern=f"^{PLAN_FORMAT}$")
    version: int = Field(ge=1, le=1)
    name: str = Field(min_length=1, max_length=60)
    description: str | None = Field(default=None, max_length=500)
    weeks: list[list[SharedSession]] = Field(min_length=1, max_length=MAX_WEEKS)
    repeat: bool = False


def template_shared(template: dict) -> SharedPlan:
    """A built-in template in the shareable format, its routine templates
    embedded by value like any shared routine."""
    weeks = []
    for week in template["weeks"]:
        out = []
        for s in week:
            s = dict(s)
            tpl = TEMPLATE_BY_ID.get(s.pop("routine_template", None) or "")
            if tpl:
                s["routine"] = {
                    "name": tpl["name"],
                    "discipline": tpl["discipline"],
                    "notes": tpl["summary"],
                    "items": tpl["items"],
                }
            out.append(s)
        weeks.append(out)
    return SharedPlan.model_validate(
        {
            "format": PLAN_FORMAT,
            "version": 1,
            "name": template["name"],
            "description": template["summary"],
            "weeks": weeks,
        }
    )


async def check_plan_room(db: AsyncSession, user_id: UUID) -> None:
    count = (
        await db.execute(
            select(func.count()).select_from(TrainingPlan).where(TrainingPlan.user_id == user_id)
        )
    ).scalar_one()
    if count >= MAX_PLANS:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"{MAX_PLANS} plans is the limit. Delete an old one first."
        )


async def materialize(
    db: AsyncSession, user_id: UUID, shared: SharedPlan, **fields
) -> TrainingPlan:
    """Turn a shareable plan into one of `user_id`'s plans. Embedded routines
    become their own, reusing one with the same name; items naming
    exercises this library doesn't have are dropped. Caller commits."""
    if any(len(w) > MAX_PER_WEEK for w in shared.weeks):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"at most {MAX_PER_WEEK} sessions a week"
        )
    made: dict[str, UUID] = {}
    weeks: list[list[dict]] = []
    for week in shared.weeks:
        out_week = []
        for s in sorted(week, key=lambda x: x.day):
            data = s.model_dump(mode="json", exclude={"routine", "routine_id"})
            if s.routine is not None:
                key = s.routine.name.lower()
                if key not in made:
                    existing = (
                        await db.execute(
                            select(Routine).where(
                                Routine.user_id == user_id, func.lower(Routine.name) == key
                            )
                        )
                    ).scalar_one_or_none()
                    if existing is None:
                        existing = Routine(
                            user_id=user_id,
                            name=s.routine.name,
                            discipline=s.routine.discipline
                            if s.routine.discipline in DISCIPLINE_IDS
                            else "strength",
                            notes=s.routine.notes,
                            items=[
                                i.model_dump()
                                for i in s.routine.items
                                if i.exercise_id in EXERCISE_BY_ID
                            ],
                        )
                        db.add(existing)
                        await db.flush()
                    made[key] = existing.id
                data["routine_id"] = str(made[key])
            out_week.append(data)
        weeks.append(out_week)
    plan = TrainingPlan(
        user_id=user_id,
        name=shared.name.strip(),
        description=(shared.description or "").strip() or None,
        weeks=weeks,
        # A challenge scores a fixed run of weeks, so its copy never loops.
        repeat=shared.repeat and "challenge_id" not in fields,
        **fields,
    )
    db.add(plan)
    await db.flush()
    return plan


async def run_only(db: AsyncSession, plan: TrainingPlan, starts: date) -> None:
    """Start `plan` from the week of `starts`, stopping any other running
    plan: one plan at a time keeps "today" unambiguous. Caller commits."""
    others = (
        (
            await db.execute(
                select(TrainingPlan).where(
                    TrainingPlan.user_id == plan.user_id,
                    TrainingPlan.id != plan.id,
                    TrainingPlan.started_on.is_not(None),
                    TrainingPlan.finished_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    for other in others:
        other.started_on = None
    plan.started_on = starts
    plan.finished_at = None


@router.post("/import", status_code=201)
async def import_plan(
    body: SharedPlan, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await check_plan_room(db, user.id)
    plan = await materialize(db, user.id, body)
    await db.commit()
    await db.refresh(plan)
    return await plan_view(db, plan, await get_profile(db, user.id))


@router.get("/{plan_id}")
async def get_plan(
    plan_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    plan = await _own(db, user, plan_id)
    profile = await get_profile(db, user.id)
    await _finish_if_over(plan, profile)
    view = await plan_view(db, plan, profile)
    await db.commit()
    return view


@router.put("/{plan_id}")
async def update_plan(
    plan_id: UUID,
    body: PlanIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Replace the plan's content. Editing a running plan is allowed - past
    weeks are judged by whatever the plan says now, which is what the person
    would expect after fixing a typo in week one."""
    plan = await _own(db, user, plan_id)
    await _check_routines(db, user, body)
    plan.name = body.name.strip()
    plan.description = (body.description or "").strip() or None
    plan.weeks = [[s.model_dump(mode="json") for s in w] for w in body.weeks]
    # A plan that has already finished stays finished until restarted.
    plan.repeat = body.repeat
    await db.commit()
    return await plan_view(db, plan, await get_profile(db, user.id))


@router.post("/{plan_id}/start")
async def start_plan(
    plan_id: UUID,
    body: StartIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start (or restart) a plan from this week or next. Any other running
    plan is stopped: one plan at a time keeps "today" unambiguous."""
    plan = await _own(db, user, plan_id)
    profile = await get_profile(db, user.id)
    this_week = week_start(local_today(profile.timezone), profile.week_starts_on)
    await run_only(
        db, plan, this_week + (timedelta(weeks=1) if body.when == "next" else timedelta())
    )
    await db.commit()
    return await plan_view(db, plan, profile)


@router.post("/{plan_id}/stop")
async def stop_plan(
    plan_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    plan = await _own(db, user, plan_id)
    plan.started_on = None
    plan.finished_at = None
    await db.commit()
    return await plan_view(db, plan, await get_profile(db, user.id))


@router.delete("/{plan_id}", status_code=204)
async def delete_plan(
    plan_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    plan = await _own(db, user, plan_id)
    await db.delete(plan)
    await db.commit()
