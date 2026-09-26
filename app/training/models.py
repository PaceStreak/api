from datetime import date, datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Sequence,
    SmallInteger,
    String,
    UniqueConstraint,
    false,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

# One sequence for every row a client syncs. `updated_at` would be the obvious
# cursor, but two writes can share a timestamp and a clock can step backwards;
# a sequence is strictly increasing, so "give me everything after 1042" can
# never skip a row.
sync_seq = Sequence("sync_seq", metadata=Base.metadata)


class Workout(Base):
    """One training session.

    The id is chosen by the client, not the server. That is what makes offline
    logging safe: the app creates the row locally, and however many times the
    save is retried - a flaky gym basement, a tab closed mid-request - it is
    the same id, so it upserts instead of duplicating.
    """

    __tablename__ = "workouts"
    __table_args__ = (
        Index("ix_workouts_user_date", "user_id", "local_date"),
        Index("ix_workouts_user_seq", "user_id", "seq"),
        CheckConstraint("effort IS NULL OR effort BETWEEN 1 AND 10", name="ck_workouts_effort"),
        CheckConstraint("feel IS NULL OR feel BETWEEN 1 AND 5", name="ck_workouts_feel"),
        CheckConstraint("duration_sec IS NULL OR duration_sec >= 0", name="ck_workouts_duration"),
        CheckConstraint("distance_m IS NULL OR distance_m >= 0", name="ck_workouts_distance"),
        CheckConstraint(
            "soreness IS NULL OR soreness BETWEEN 0 AND 3", name="ck_workouts_soreness"
        ),
        CheckConstraint("pump IS NULL OR pump BETWEEN 0 AND 2", name="ck_workouts_pump"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    discipline: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str | None] = mapped_column(String(80))
    # Private. Notes are never shown to anyone but their author.
    notes: Mapped[str | None] = mapped_column(String(1000))

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # The user's calendar date for started_at, in their timezone at the time of
    # writing. Stored, not derived on read, so moving house to another timezone
    # does not reshuffle a year of history into different days.
    local_date: Mapped[date] = mapped_column(Date, nullable=False)

    duration_sec: Mapped[int | None] = mapped_column(Integer)
    distance_m: Mapped[float | None] = mapped_column(Float)
    elevation_m: Mapped[float | None] = mapped_column(Float)
    # Session RPE, 1-10. How hard it was, not how much was lifted.
    effort: Mapped[int | None] = mapped_column(SmallInteger)
    # How it felt, 1-5. Tracked because a streak built on miserable sessions
    # is one that ends, and the trend is worth seeing.
    feel: Mapped[int | None] = mapped_column(SmallInteger)
    # Optional after-session check-in, used only to suggest a set more or
    # fewer next time. Soreness carried in from last time (0 none - 3 still
    # very sore) and how the pump felt (0 low - 2 great).
    soreness: Mapped[int | None] = mapped_column(SmallInteger)
    pump: Mapped[int | None] = mapped_column(SmallInteger)
    # Heart rate, from an imported file or typed in. Zones are seconds in
    # each of five zones, worked out at import from the person's max HR.
    avg_hr: Mapped[int | None] = mapped_column(SmallInteger)
    max_hr: Mapped[int | None] = mapped_column(SmallInteger)
    hr_zones: Mapped[list[int]] = mapped_column(
        JSONB, default=list, server_default="[]", nullable=False
    )

    routine_id: Mapped[UUID | None] = mapped_column()
    # Private, like notes: free-form labels ("hills", "with-sam", "race") for
    # finding sessions again. Normalised to lowercase slugs on the way in.
    tags: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default="[]", nullable=False
    )
    # Per-kilometre times from an imported track: [{"m": 1000, "sec": 312}].
    # Private, like the rest of the session detail; never ranked.
    splits: Mapped[list[dict]] = mapped_column(
        JSONB, default=list, server_default="[]", nullable=False
    )
    # Shoes, bike, board... NULLed if the gear is deleted, so removing a pair
    # of shoes never touches the training log itself.
    gear_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("gear.id", ondelete="SET NULL"), index=True
    )
    # Where it happened, for the equipment and plates on hand. NULLed if the
    # gym is deleted, like gear.
    gym_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("gyms.id", ondelete="SET NULL"), index=True
    )
    # "app" or "import". Imported history counts for the personal streak but
    # never for challenges, where backfilling would be cheating.
    source: Mapped[str] = mapped_column(String(10), default="app", nullable=False)

    # Last-write-wins, judged by the client's own edit time: an old queued
    # offline edit arriving late must not overwrite a newer one made since.
    client_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Soft delete, so a deletion can sync to the user's other devices. Rows
    # with deleted_at set are excluded everywhere except the sync feed.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seq: Mapped[int] = mapped_column(
        BigInteger, sync_seq, server_default=sync_seq.next_value(), nullable=False
    )

    sets: Mapped[list[WorkoutSet]] = relationship(
        "WorkoutSet",
        back_populates="workout",
        cascade="all, delete-orphan",
        order_by="(WorkoutSet.position, WorkoutSet.set_index)",
        lazy="selectin",
    )


class WorkoutSet(Base):
    __tablename__ = "workout_sets"
    __table_args__ = (
        Index("ix_workout_sets_user_exercise", "user_id", "exercise_id"),
        CheckConstraint("reps IS NULL OR reps >= 0", name="ck_sets_reps"),
        CheckConstraint("weight_kg IS NULL OR weight_kg >= 0", name="ck_sets_weight"),
        CheckConstraint("rpe IS NULL OR rpe BETWEEN 1 AND 10", name="ck_sets_rpe"),
        CheckConstraint("kind IN ('work', 'warmup', 'drop', 'failure')", name="ck_sets_kind"),
    )

    workout_id: Mapped[UUID] = mapped_column(
        ForeignKey("workouts.id", ondelete="CASCADE"), index=True, nullable=False
    )
    workout: Mapped[Workout] = relationship("Workout", back_populates="sets")
    # Denormalised from the workout so exercise history is one indexed lookup.
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    exercise_id: Mapped[str] = mapped_column(String(80), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    set_index: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    superset: Mapped[int | None] = mapped_column(SmallInteger)
    kind: Mapped[str] = mapped_column(String(8), default="work", nullable=False)
    # Always kilograms. The predecessor stored "whatever unit the user had
    # selected", so switching kg to lb silently corrupted every total and PR.
    # Conversion happens at the edge, in the client, and nowhere else.
    weight_kg: Mapped[float | None] = mapped_column(Float)
    reps: Mapped[int | None] = mapped_column(Integer)
    rpe: Mapped[float | None] = mapped_column(Float)
    duration_sec: Mapped[int | None] = mapped_column(Integer)
    distance_m: Mapped[float | None] = mapped_column(Float)
    completed: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class CustomExercise(Base):
    __tablename__ = "custom_exercises"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    pattern: Mapped[str] = mapped_column(String(20), nullable=False)
    equipment: Mapped[str] = mapped_column(String(20), nullable=False)
    primary: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    secondary: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    load_type: Mapped[str] = mapped_column(String(12), default="weight", nullable=False)
    rest_sec: Mapped[int] = mapped_column(Integer, default=90, nullable=False)
    unilateral: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    cue: Mapped[str | None] = mapped_column(String(200))
    # Archived rather than deleted once it has history, so old sets still name
    # the movement they were.
    archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    @property
    def exercise_id(self) -> str:
        from app.training.library import CUSTOM_PREFIX

        return f"{CUSTOM_PREFIX}{self.id}"


class Routine(Base):
    """A reusable plan: an ordered list of exercises with targets.

    Items are JSON rather than a child table - a routine is always read and
    written whole, and nothing queries into it.
    """

    __tablename__ = "routines"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    discipline: Mapped[str] = mapped_column(String(20), default="strength", nullable=False)
    notes: Mapped[str | None] = mapped_column(String(500))
    items: Mapped[list[dict]] = mapped_column(JSONB, default=list, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BodyMetric(Base):
    """Private only. Nothing here ever reaches a leaderboard, XP, a badge or
    another person - a body-weight number anywhere competitive is an incentive
    to cut, and that is a harm this product will not build in."""

    __tablename__ = "body_metrics"
    __table_args__ = (UniqueConstraint("user_id", "measured_on", name="uq_body_metric_day"),)

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    measured_on: Mapped[date] = mapped_column(Date, nullable=False)
    body_fat_pct: Mapped[float | None] = mapped_column(Float)
    waist_cm: Mapped[float | None] = mapped_column(Float)
    resting_hr: Mapped[int | None] = mapped_column(SmallInteger)
    sleep_hours: Mapped[float | None] = mapped_column(Float)
    note: Mapped[str | None] = mapped_column(String(200))
    # Tape measurements, centimetres. One side for limbs: the same side each
    # time is what makes them comparable, and the app says so.
    neck_cm: Mapped[float | None] = mapped_column(Float)
    shoulders_cm: Mapped[float | None] = mapped_column(Float)
    chest_cm: Mapped[float | None] = mapped_column(Float)
    arm_cm: Mapped[float | None] = mapped_column(Float)
    forearm_cm: Mapped[float | None] = mapped_column(Float)
    hips_cm: Mapped[float | None] = mapped_column(Float)
    thigh_cm: Mapped[float | None] = mapped_column(Float)
    calf_cm: Mapped[float | None] = mapped_column(Float)


TAPE_FIELDS = (
    "neck_cm",
    "shoulders_cm",
    "chest_cm",
    "waist_cm",
    "arm_cm",
    "forearm_cm",
    "hips_cm",
    "thigh_cm",
    "calf_cm",
)
# Every recorded field of a BodyMetric, in export order.
METRIC_FIELDS = ("body_fat_pct", "resting_hr", "sleep_hours", *TAPE_FIELDS, "note")

# Most progress photos one person keeps on the server, and the largest one.
# The app re-encodes to a 1600 px JPEG first, which lands well under the cap.
MAX_BODY_PHOTOS = 500
MAX_BODY_PHOTO_BYTES = 2 * 1024 * 1024
PHOTO_POSES = ("front", "side", "back")


class BodyPhoto(Base):
    """A progress photo backed up to the account, only when the person turns
    backup on. Private like BodyMetric: served only to its owner, never
    cached by a shared cache, never shown to anyone. The id is chosen by the
    client, so a retried upload replaces rather than duplicates."""

    __tablename__ = "body_photos"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    taken_on: Mapped[date] = mapped_column(Date, nullable=False)
    pose: Mapped[str] = mapped_column(String(8), nullable=False)
    content_type: Mapped[str] = mapped_column(String(32), nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)
    size: Mapped[int] = mapped_column(Integer, nullable=False)


# When in the day a weigh-in was taken. Weight swings by a kilo or more across
# a day (water, food, a workout), so readings are only comparable with others
# from the same moment; the moment is what the trend is filtered by.
WEIGH_IN_MOMENTS = ("waking", "pre_workout", "post_workout", "bedtime", "other")


class WeighIn(Base):
    """Private, like BodyMetric: never XP, a badge, a board or another person.
    Several per day. The id is chosen by the client, so a retried save is an
    update rather than a duplicate."""

    __tablename__ = "weigh_ins"
    __table_args__ = (
        CheckConstraint(
            "moment IN ('waking', 'pre_workout', 'post_workout', 'bedtime', 'other')",
            name="ck_weigh_in_moment",
        ),
        Index("ix_weigh_ins_user_day", "user_id", "local_date"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    weighed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    local_date: Mapped[date] = mapped_column(Date, nullable=False)
    moment: Mapped[str] = mapped_column(String(16), nullable=False)
    weight_kg: Mapped[float] = mapped_column(Float, nullable=False)
    note: Mapped[str | None] = mapped_column(String(200))


class StreakChain(Base):
    """A streak: which disciplines count towards it, and the weekly target.

    Everyone starts with one chain covering everything. Adding more is how
    "lifting and running on separate chains" works.

    The target is a history, not a number. Raising it from three to five must
    not retroactively break a year of weeks that were kept under three, so
    each change records the week it took effect from.
    """

    __tablename__ = "streak_chains"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(40), nullable=False)
    # Empty means every discipline counts.
    disciplines: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    # [{"from": "2026-09-21", "target": 4}, ...], ascending by "from".
    target_history: Mapped[list[dict]] = mapped_column(JSONB, default=list, nullable=False)
    # [{"from": "2026-09-21", "requirements": [{"disciplines": ["run"], "days": 2}]}]
    # - a history, like the target, so adding a rule never re-judges old weeks.
    requirements_history: Mapped[list[dict]] = mapped_column(
        JSONB, default=list, server_default="[]", nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    @property
    def target(self) -> int:
        return int(self.target_history[-1]["target"]) if self.target_history else 3

    @property
    def requirements(self) -> list[dict]:
        return (
            list(self.requirements_history[-1]["requirements"]) if self.requirements_history else []
        )


class StreakRepair(Base):
    """A missed week the user chose to repair. One per person per calendar
    month - enough to forgive a bad week, too scarce to replace training."""

    __tablename__ = "streak_repairs"
    __table_args__ = (
        UniqueConstraint("chain_id", "week_start", name="uq_repair_chain_week"),
        UniqueConstraint("user_id", "month", name="uq_repair_user_month"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    chain_id: Mapped[UUID] = mapped_column(
        ForeignKey("streak_chains.id", ondelete="CASCADE"), nullable=False
    )
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    month: Mapped[str] = mapped_column(String(7), nullable=False)


class StreakPause(Base):
    """A declared break - injury, illness, travel or life - that shelters the streak.

    It applies to every chain at once: an injury does not care which discipline
    a streak counts. `ends_on` is inclusive and NULL while the pause is open;
    an open pause is treated as running to today, and never past
    PAUSE_MAX_DAYS from its start (see app/training/pauses.py), so forgetting
    to end one cannot shelter a streak indefinitely.
    """

    __tablename__ = "streak_pauses"
    __table_args__ = (
        CheckConstraint(
            "reason IN ('injury', 'illness', 'travel', 'life', 'other')", name="ck_pause_reason"
        ),
        CheckConstraint("ends_on IS NULL OR ends_on >= starts_on", name="ck_pause_range"),
        Index("ix_streak_pauses_user_start", "user_id", "starts_on"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    starts_on: Mapped[date] = mapped_column(Date, nullable=False)
    ends_on: Mapped[date | None] = mapped_column(Date)
    reason: Mapped[str] = mapped_column(String(10), default="injury", nullable=False)
    # Private, like workout notes: never shown to anyone but its author.
    note: Mapped[str | None] = mapped_column(String(280))


class Gear(Base):
    """Something that wears out: shoes, a bike, a board. Private - never shown
    to anyone else, never ranked. Mileage is summed from the workouts that
    name it, so it can never drift from the log.
    """

    __tablename__ = "gear"
    __table_args__ = (
        CheckConstraint("kind IN ('shoes', 'bike', 'other')", name="ck_gear_kind"),
        CheckConstraint("limit_m IS NULL OR limit_m > 0", name="ck_gear_limit"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    kind: Mapped[str] = mapped_column(String(10), default="shoes", nullable=False)
    # New sessions in these disciplines get this gear picked by default.
    default_for: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    # Distance before replacement is due - e.g. 700 km for running shoes. A
    # reminder, never a rule.
    limit_m: Mapped[float | None] = mapped_column(Float)
    # Distance it had before it was added here, so a half-worn pair starts
    # at the right number.
    initial_m: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(String(200))


class TrainingBlock(Base):
    """A multi-week block: reps in reserve tighten week by week, then a
    lighter week. RIR is how many more reps the set could have had; aiming
    for it is what turns "train hard" into a number. One active at a time.
    """

    __tablename__ = "training_blocks"
    __table_args__ = (
        CheckConstraint("weeks BETWEEN 3 AND 8", name="ck_block_weeks"),
        CheckConstraint(
            "rir_start BETWEEN 0 AND 5 AND rir_end BETWEEN 0 AND 5", name="ck_block_rir"
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    # A week start. Weeks count from here; the last one is the lighter week.
    starts_on: Mapped[date] = mapped_column(Date, nullable=False)
    weeks: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    rir_start: Mapped[int] = mapped_column(SmallInteger, default=3, nullable=False)
    rir_end: Mapped[int] = mapped_column(SmallInteger, default=1, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Readiness(Base):
    """A morning check-in: sleep, energy and soreness, 1-5 each. Private.
    It only changes what Today suggests; it never gates or scores anything."""

    __tablename__ = "readiness"
    __table_args__ = (
        UniqueConstraint("user_id", "day", name="uq_readiness_day"),
        CheckConstraint(
            "sleep BETWEEN 1 AND 5 AND energy BETWEEN 1 AND 5 AND soreness BETWEEN 1 AND 5",
            name="ck_readiness_range",
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    sleep: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    energy: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    soreness: Mapped[int] = mapped_column(SmallInteger, nullable=False)


class WeekReflection(Base):
    """A line or two about a week, written on its recap. Private."""

    __tablename__ = "week_reflections"
    __table_args__ = (UniqueConstraint("user_id", "week_start", name="uq_reflection_week"),)

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    went_well: Mapped[str | None] = mapped_column(String(500))
    change: Mapped[str | None] = mapped_column(String(500))


class Gym(Base):
    """A place someone trains, with what it has: equipment, plates and bar.
    Private. The exercise picker can narrow to what this gym has, and the
    plate calculator uses its plates instead of a full commercial set."""

    __tablename__ = "gyms"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    # Library equipment ids ("barbell", "dumbbell", ...).
    equipment: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    # Plate weights available, per side, in kg.
    plates_kg: Mapped[list[float]] = mapped_column(JSONB, default=list, nullable=False)
    bar_kg: Mapped[float] = mapped_column(Float, default=20, nullable=False)
    is_default: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )


class ExerciseNote(Base):
    """A note that stays with an exercise across sessions: seat height, grip,
    a form cue. Private."""

    __tablename__ = "exercise_notes"
    __table_args__ = (UniqueConstraint("user_id", "exercise_id", name="uq_exercise_note"),)

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    exercise_id: Mapped[str] = mapped_column(String(60), nullable=False)
    note: Mapped[str] = mapped_column(String(500), nullable=False)


class WeightGoal(Base):
    """A private weight goal: where the trend is heading, broken into small
    milestones. It never pays XP, a badge or anything visible to others -
    rewarding a number on the scale is an incentive to chase it unsafely."""

    __tablename__ = "weight_goals"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    target_kg: Mapped[float] = mapped_column(Float, nullable=False)
    # The smoothed weight when the goal was set, so progress has a start.
    start_kg: Mapped[float] = mapped_column(Float, nullable=False)
    milestone_kg: Mapped[float] = mapped_column(Float, default=2, nullable=False)
    set_on: Mapped[date] = mapped_column(Date, nullable=False)


class TrainingPlan(Base):
    """A multi-week plan: which sessions, on which days of each week.

    `weeks` is [[{"day": 0-6, "discipline": "run", "title": "...",
    "minutes": 20, "distance_km": null, "routine_id": null, "note": "..."}],
    ...], one list per week, days counted from the person's week start. JSON
    because a plan is always read and written whole, like a routine.

    At most one plan is active at a time. A plan tells you what to do; it
    never changes what the streak counts - logging something else on a plan
    day still keeps the week.
    """

    __tablename__ = "training_plans"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    template_id: Mapped[str | None] = mapped_column(String(40))
    weeks: Mapped[list[list[dict]]] = mapped_column(JSONB, default=list, nullable=False)
    # The week-start date of week one, while the plan is running.
    started_on: Mapped[date | None] = mapped_column(Date)
    # Set on a copy made for a plan challenge; the challenge scores it.
    challenge_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("challenges.id", ondelete="SET NULL"), index=True
    )
    # Set when a coach suggested this plan. It is the member's plan: they
    # choose whether to start it, and can edit or delete it like any other.
    assigned_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # A repeating plan loops its weeks for as long as it runs and never
    # finishes: a one-week plan that repeats is a weekly schedule.
    repeat: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )


class MonthlyGoal(Base):
    """A personal target of active days for one calendar month. Private and
    never ranked: it exists to give a quiet month a shape."""

    __tablename__ = "monthly_goals"
    __table_args__ = (
        UniqueConstraint("user_id", "month", name="uq_monthly_goal"),
        CheckConstraint("days BETWEEN 1 AND 31", name="ck_monthly_goal_days"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    month: Mapped[str] = mapped_column(String(7), nullable=False)  # "2026-10"
    days: Mapped[int] = mapped_column(SmallInteger, nullable=False)


class RestDay(Base):
    """A rest day logged on purpose: sleep, mobility, or just rest. Shown on
    the grid as a choice rather than a gap. It never counts toward a streak
    or a target - rest is already free in a week-based streak, and counting
    it would make "rest" a way to game the number."""

    __tablename__ = "rest_days"
    __table_args__ = (
        UniqueConstraint("user_id", "day", name="uq_rest_day"),
        CheckConstraint("kind IN ('rest', 'sleep', 'mobility', 'sick')", name="ck_rest_kind"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    kind: Mapped[str] = mapped_column(String(10), default="rest", nullable=False)
    # Private, like workout notes.
    note: Mapped[str | None] = mapped_column(String(200))
