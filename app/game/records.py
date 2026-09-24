"""Personal records. Pure.

Every PR is self-relative: it compares you to your own history and nobody
else's, so neither being big nor lying about load can win anything social.

Two guards carried over from the predecessor, because both were learned the
hard way there:

- **Plausibility.** An improvement of more than PR_MAX_GAIN_PCT over the prior
  best is recorded - it may be real - but earns nothing and is never
  broadcast. A fat-fingered 500 kg curl should mint no reward.
- **Cooldown.** One rewarded PR per record per PR_COOLDOWN_DAYS, so re-testing
  a max every day is not a farming strategy.
"""

from dataclasses import dataclass
from datetime import date

PR_MAX_GAIN_PCT = 15.0
PR_COOLDOWN_DAYS = 7
MAX_E1RM_REPS = 12

# Endurance pace bands: a session at least this long gets a pace record for
# the band, using its average pace. An approximation (it is the whole
# session's average, not a split), which is honest for manual logging.
RUN_BANDS = ((5_000, "5k"), (10_000, "10k"), (21_097, "half"), (42_195, "marathon"))


def e1rm(weight_kg: float, reps: int) -> float:
    """Epley. Unreliable past a dozen reps, so those sets are not graded."""
    if reps <= 0 or weight_kg <= 0 or reps > MAX_E1RM_REPS:
        return 0.0
    return weight_kg if reps == 1 else weight_kg * (1 + reps / 30)


@dataclass(frozen=True)
class Observation:
    """One candidate value for a record, from one workout."""

    key: str  # "e1rm:back-squat", "reps:push-up", "distance:run", "pace_5k:run"
    value: float
    day: date
    workout_id: str
    higher_is_better: bool = True
    rewardable: bool = True  # imported history sets bests but never pays


@dataclass
class PrEvent:
    key: str
    value: float
    previous: float
    gain_pct: float
    day: date
    workout_id: str
    flagged: bool
    rewarded: bool


@dataclass
class Best:
    value: float
    day: date
    workout_id: str


def _better(a: float, b: float, higher: bool) -> bool:
    return a > b if higher else a < b


def detect(observations: list[Observation]) -> tuple[list[PrEvent], dict[str, Best]]:
    """Walk history chronologically; emit an event each time a record moves.

    Within one day only that day's best value per record is considered, so
    three heavier sets in one session are one PR, not three.
    """
    by_day: dict[tuple[str, date], Observation] = {}
    for obs in observations:
        slot = (obs.key, obs.day)
        existing = by_day.get(slot)
        if existing is None or _better(obs.value, existing.value, obs.higher_is_better):
            by_day[slot] = obs

    bests: dict[str, Best] = {}
    last_rewarded: dict[str, date] = {}
    events: list[PrEvent] = []

    for (key, day), obs in sorted(by_day.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        prior = bests.get(key)
        if prior is None:
            bests[key] = Best(obs.value, day, obs.workout_id)
            continue
        if not _better(obs.value, prior.value, obs.higher_is_better):
            continue
        if obs.higher_is_better:
            gain = (obs.value - prior.value) / prior.value * 100 if prior.value else 0.0
        else:
            gain = (prior.value - obs.value) / prior.value * 100 if prior.value else 0.0
        flagged = gain > PR_MAX_GAIN_PCT
        last = last_rewarded.get(key)
        cooled = last is None or (day - last).days >= PR_COOLDOWN_DAYS
        rewarded = obs.rewardable and not flagged and cooled
        if rewarded:
            last_rewarded[key] = day
        events.append(
            PrEvent(
                key, obs.value, prior.value, round(gain, 2), day, obs.workout_id, flagged, rewarded
            )
        )
        bests[key] = Best(obs.value, day, obs.workout_id)

    return events, bests
