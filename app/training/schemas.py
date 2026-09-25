from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.training.library import DISCIPLINE_IDS, EQUIPMENT, LOAD_TYPES, MUSCLES, PATTERNS


class SetIn(BaseModel):
    exercise_id: str = Field(min_length=1, max_length=80)
    position: int = Field(ge=0, le=200)
    set_index: int = Field(ge=0, le=100)
    kind: Literal["work", "warmup", "drop", "failure"] = "work"
    weight_kg: float | None = Field(default=None, ge=0, le=2000)
    reps: int | None = Field(default=None, ge=0, le=1000)
    rpe: float | None = Field(default=None, ge=1, le=10)
    duration_sec: int | None = Field(default=None, ge=0, le=86_400)
    distance_m: float | None = Field(default=None, ge=0, le=1_000_000)
    completed: bool = True


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
    client_updated_at: datetime
    sets: list[SetIn] = Field(default_factory=list, max_length=400)

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
    weight_kg: float | None = Field(default=None, gt=0, le=700)
    body_fat_pct: float | None = Field(default=None, ge=1, le=75)
    waist_cm: float | None = Field(default=None, gt=0, le=400)
    resting_hr: int | None = Field(default=None, ge=20, le=250)
    sleep_hours: float | None = Field(default=None, ge=0, le=24)
    note: str | None = Field(default=None, max_length=200)


class ChainIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    disciplines: list[str] = Field(default_factory=list, max_length=11)
    target: int = Field(default=3, ge=1, le=7)

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
    reason: Literal["injury", "illness", "life", "other"] = "injury"
    note: str | None = Field(default=None, max_length=280)
