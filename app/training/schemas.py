import re
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.training.library import DISCIPLINE_IDS, EQUIPMENT, LOAD_TYPES, MUSCLES, PATTERNS


class SetIn(BaseModel):
    exercise_id: str = Field(min_length=1, max_length=80)
    position: int = Field(ge=0, le=200)
    set_index: int = Field(ge=0, le=100)
    # Exercises sharing a number are a superset: done back to back, resting
    # after the last one. None means a straight set.
    superset: int | None = Field(default=None, ge=0, le=50)
    kind: Literal["work", "warmup", "drop", "failure"] = "work"
    weight_kg: float | None = Field(default=None, ge=0, le=2000)
    reps: int | None = Field(default=None, ge=0, le=1000)
    rpe: float | None = Field(default=None, ge=1, le=10)
    duration_sec: int | None = Field(default=None, ge=0, le=86_400)
    distance_m: float | None = Field(default=None, ge=0, le=1_000_000)
    completed: bool = True


class SplitIn(BaseModel):
    m: int = Field(ge=1, le=1000)
    sec: int = Field(ge=0, le=86_400)


TAG_RE = re.compile(r"[^a-z0-9-]+")


def clean_tags(values: list[str]) -> list[str]:
    """Lowercase slugs, deduplicated in order: "#Hill Reps" -> "hill-reps"."""
    out: list[str] = []
    for raw in values:
        tag = TAG_RE.sub("-", raw.strip().lstrip("#").lower()).strip("-")[:24]
        if tag and tag not in out:
            out.append(tag)
    return out[:8]


class WorkoutIn(BaseModel):
    discipline: str
    title: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=1000)
    started_at: datetime
    duration_sec: int | None = Field(default=None, ge=0, le=172_800)
    distance_m: float | None = Field(default=None, ge=0, le=1_000_000)
    elevation_m: float | None = Field(default=None, ge=0, le=20_000)
    effort: int | None = Field(default=None, ge=1, le=10)
    feel: int | None = Field(default=None, ge=1, le=5)
    routine_id: UUID | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)
    gear_id: UUID | None = None
    gym_id: UUID | None = None
    soreness: int | None = Field(default=None, ge=0, le=3)
    pump: int | None = Field(default=None, ge=0, le=2)
    avg_hr: int | None = Field(default=None, ge=30, le=240)
    max_hr: int | None = Field(default=None, ge=30, le=240)
    # Echoed back like splits, so editing an imported run keeps its zones.
    hr_zones: list[int] = Field(default_factory=list, max_length=5)
    # Echoed back by the client so editing an imported run keeps its splits.
    splits: list[SplitIn] = Field(default_factory=list, max_length=500)
    client_updated_at: datetime
    sets: list[SetIn] = Field(default_factory=list, max_length=400)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        return clean_tags([t for t in v if isinstance(t, str)])

    @field_validator("discipline")
    @classmethod
    def _known_discipline(cls, v: str) -> str:
        if v not in DISCIPLINE_IDS:
            raise ValueError("unknown discipline")
        return v

    @field_validator("started_at", "client_updated_at")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("timestamps must carry a timezone offset")
        return v

    @field_validator("title", "notes")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        return v or None


class SetOut(BaseModel):
    exercise_id: str
    position: int
    set_index: int
    superset: int | None = None
    kind: str
    weight_kg: float | None
    reps: int | None
    rpe: float | None
    duration_sec: int | None
    distance_m: float | None
    completed: bool

    model_config = {"from_attributes": True}


class WorkoutOut(BaseModel):
    id: UUID
    discipline: str
    title: str | None
    notes: str | None
    started_at: datetime
    local_date: date
    duration_sec: int | None
    distance_m: float | None
    elevation_m: float | None
    effort: int | None
    feel: int | None
    routine_id: UUID | None
    tags: list[str] = []
    gear_id: UUID | None = None
    gym_id: UUID | None = None
    soreness: int | None = None
    pump: int | None = None
    avg_hr: int | None = None
    max_hr: int | None = None
    hr_zones: list[int] = []
    splits: list[dict] = []
    source: str
    client_updated_at: datetime
    deleted_at: datetime | None
    seq: int
    sets: list[SetOut]

    model_config = {"from_attributes": True}


class BatchOp(BaseModel):
    op: Literal["put", "delete"]
    id: UUID
    workout: WorkoutIn | None = None
    client_updated_at: datetime


class BatchIn(BaseModel):
    ops: list[BatchOp] = Field(max_length=200)


class CustomExerciseIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    pattern: str
    equipment: str
    primary: list[str] = Field(default_factory=list, max_length=6)
    secondary: list[str] = Field(default_factory=list, max_length=6)
    load_type: str = "weight"
    rest_sec: int = Field(default=90, ge=0, le=900)
    unilateral: bool = False
    cue: str | None = Field(default=None, max_length=200)

    @field_validator("pattern")
    @classmethod
    def _pattern(cls, v: str) -> str:
        if v not in PATTERNS:
            raise ValueError("unknown movement pattern")
        return v

    @field_validator("equipment")
    @classmethod
    def _equipment(cls, v: str) -> str:
        if v not in EQUIPMENT:
            raise ValueError("unknown equipment")
        return v

    @field_validator("load_type")
    @classmethod
    def _load(cls, v: str) -> str:
        if v not in LOAD_TYPES:
            raise ValueError("unknown load type")
        return v

    @field_validator("primary", "secondary")
    @classmethod
    def _muscles(cls, v: list[str]) -> list[str]:
        unknown = [m for m in v if m not in MUSCLES]
        if unknown:
            raise ValueError(f"unknown muscles: {', '.join(unknown)}")
        return list(dict.fromkeys(v))


class RoutineItem(BaseModel):
    exercise_id: str = Field(min_length=1, max_length=80)
    sets: int = Field(default=3, ge=1, le=20)
    reps_min: int | None = Field(default=None, ge=0, le=1000)
    reps_max: int | None = Field(default=None, ge=0, le=1000)
    rest_sec: int | None = Field(default=None, ge=0, le=900)
    target_rpe: float | None = Field(default=None, ge=1, le=10)
    # Kilograms, like every stored weight. A starting point for someone with
    # no history on the movement; once they have some, last time leads.
    weight_kg: float | None = Field(default=None, ge=0, le=1000)
    # The jump progression suggests once every set tops the rep range.
    increment_kg: float | None = Field(default=None, gt=0, le=50)
    note: str | None = Field(default=None, max_length=140)


class RoutineIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    discipline: str = "strength"
    notes: str | None = Field(default=None, max_length=500)
    items: list[RoutineItem] = Field(default_factory=list, max_length=40)
    position: int = 0

    @field_validator("discipline")
    @classmethod
    def _known_discipline(cls, v: str) -> str:
        if v not in DISCIPLINE_IDS:
            raise ValueError("unknown discipline")
        return v


class BodyMetricIn(BaseModel):
    body_fat_pct: float | None = Field(default=None, ge=1, le=75)
    waist_cm: float | None = Field(default=None, gt=0, le=400)
    resting_hr: int | None = Field(default=None, ge=20, le=250)
    sleep_hours: float | None = Field(default=None, ge=0, le=24)
    note: str | None = Field(default=None, max_length=200)


class WeighInIn(BaseModel):
    weighed_at: datetime
    moment: Literal["waking", "pre_workout", "post_workout", "bedtime", "other"]
    weight_kg: float = Field(gt=0, le=700)
    note: str | None = Field(default=None, max_length=200)


class RequirementIn(BaseModel):
    disciplines: list[str] = Field(min_length=1, max_length=11)
    days: int = Field(ge=1, le=7)

    @field_validator("disciplines")
    @classmethod
    def _known(cls, v: list[str]) -> list[str]:
        bad = [d for d in v if d not in DISCIPLINE_IDS]
        if bad:
            raise ValueError(f"unknown disciplines: {', '.join(bad)}")
        return sorted(dict.fromkeys(v))


def check_requirements(reqs: list[RequirementIn], target: int, disciplines: list[str]) -> None:
    """Raise ValueError when requirements can't be met inside the chain."""
    if sum(r.days for r in reqs) > target:
        raise ValueError(
            "The requirements add up to more days than the weekly target. "
            "Raise the target or ask for fewer days."
        )
    if disciplines:
        outside = sorted({d for r in reqs for d in r.disciplines} - set(disciplines))
        if outside:
            raise ValueError(f"not counted by this streak: {', '.join(outside)}")


class ChainIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    disciplines: list[str] = Field(default_factory=list, max_length=11)
    target: int = Field(default=3, ge=1, le=7)
    requirements: list[RequirementIn] = Field(default_factory=list, max_length=3)

    @field_validator("disciplines")
    @classmethod
    def _known(cls, v: list[str]) -> list[str]:
        bad = [d for d in v if d not in DISCIPLINE_IDS]
        if bad:
            raise ValueError(f"unknown disciplines: {', '.join(bad)}")
        return list(dict.fromkeys(v))


class ChainPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    disciplines: list[str] | None = Field(default=None, max_length=11)
    target: int | None = Field(default=None, ge=1, le=7)
    requirements: list[RequirementIn] | None = Field(default=None, max_length=3)
    position: int | None = None

    @field_validator("disciplines")
    @classmethod
    def _known(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        bad = [d for d in v if d not in DISCIPLINE_IDS]
        if bad:
            raise ValueError(f"unknown disciplines: {', '.join(bad)}")
        return list(dict.fromkeys(v))


class RepairIn(BaseModel):
    week_start: date


class PauseIn(BaseModel):
    starts_on: date
    # Inclusive. Omit for "until I'm back", which runs to the maximum length.
    ends_on: date | None = None
    reason: Literal["injury", "illness", "travel", "life", "other"] = "injury"
    note: str | None = Field(default=None, max_length=280)


def _known_disciplines(v: list[str]) -> list[str]:
    bad = [d for d in v if d not in DISCIPLINE_IDS]
    if bad:
        raise ValueError(f"unknown disciplines: {', '.join(bad)}")
    return list(dict.fromkeys(v))


class GearIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    kind: Literal["shoes", "bike", "other"] = "shoes"
    default_for: list[str] = Field(default_factory=list, max_length=11)
    limit_km: float | None = Field(default=None, gt=0, le=100_000)
    initial_km: float = Field(default=0, ge=0, le=100_000)
    note: str | None = Field(default=None, max_length=200)

    @field_validator("default_for")
    @classmethod
    def _default_for(cls, v: list[str]) -> list[str]:
        return _known_disciplines(v)


class GymIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    equipment: list[str] = Field(default_factory=list, max_length=20)
    plates_kg: list[float] = Field(default_factory=list, max_length=20)
    bar_kg: float = Field(default=20, ge=0, le=50)
    is_default: bool = False

    @field_validator("equipment")
    @classmethod
    def _equipment(cls, v: list[str]) -> list[str]:
        bad = [e for e in v if e not in EQUIPMENT]
        if bad:
            raise ValueError(f"unknown equipment: {', '.join(bad)}")
        return list(dict.fromkeys(v))

    @field_validator("plates_kg")
    @classmethod
    def _plates(cls, v: list[float]) -> list[float]:
        if any(p <= 0 or p > 50 for p in v):
            raise ValueError("plates are between 0 and 50 kg")
        return sorted({round(p, 3) for p in v}, reverse=True)


class ExerciseNoteIn(BaseModel):
    note: str = Field(max_length=500)


class BlockIn(BaseModel):
    name: str = Field(default="Training block", min_length=1, max_length=60)
    weeks: int = Field(default=5, ge=3, le=8)
    rir_start: int = Field(default=3, ge=0, le=5)
    rir_end: int = Field(default=1, ge=0, le=5)
    when: Literal["this", "next"] = "this"


class ReadinessIn(BaseModel):
    sleep: int = Field(ge=1, le=5)
    energy: int = Field(ge=1, le=5)
    soreness: int = Field(ge=1, le=5)


class ReflectionIn(BaseModel):
    went_well: str | None = Field(default=None, max_length=500)
    change: str | None = Field(default=None, max_length=500)


class WeightGoalIn(BaseModel):
    target_kg: float = Field(gt=20, le=400)
    milestone_kg: float = Field(default=2, ge=0.5, le=20)


class GearPatch(BaseModel):
    """Every field optional; `limit_km` and `note` can be cleared with null,
    so only fields actually sent are applied (model_fields_set)."""

    name: str | None = Field(default=None, min_length=1, max_length=60)
    kind: Literal["shoes", "bike", "other"] | None = None
    default_for: list[str] | None = Field(default=None, max_length=11)
    limit_km: float | None = Field(default=None, gt=0, le=100_000)
    initial_km: float | None = Field(default=None, ge=0, le=100_000)
    note: str | None = Field(default=None, max_length=200)
    retired: bool | None = None

    @field_validator("default_for")
    @classmethod
    def _default_for(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else _known_disciplines(v)
