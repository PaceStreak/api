"""Patterns in a person's own data, found by arithmetic rather than a model.

Each candidate pairs a driver (sleep, training, mood...) with an outcome
(habits kept, mood, protein...). Days are split in two by the driver - did
or didn't train; at or above the median sleep, or below it - and the
outcome's mean is compared across the halves. A pattern is reported only
when both halves have enough days, the gap is big enough to matter, and a
Welch t-test says it is unlikely to be noise. It is correlation, and the
app says so.
"""

import math
from dataclasses import dataclass
from datetime import date
from statistics import mean, median, variance

MIN_DAYS = 8
MIN_T = 2.0
MAX_INSIGHTS = 6


@dataclass(frozen=True)
class Series:
    key: str
    label: str
    # How a value prints: "rate" (0-1 as a percentage), "score" (1-5),
    # "hours", "grams", "kcal", or "binary" for a yes/no driver.
    kind: str
    # The smallest gap in means worth reporting, in the series' own units.
    min_gap: float = 0


# Drivers and outcomes. A pair is only tried when it reads as a sentence.
SERIES = {
    "sleep_hours": Series("sleep_hours", "sleep", "hours"),
    "sleep": Series("sleep", "sleep rating", "score", 0.4),
    "energy": Series("energy", "energy", "score", 0.4),
    "mood": Series("mood", "mood", "score", 0.4),
    "trained": Series("trained", "training", "binary", 0.1),
    "habits": Series("habits", "habits done", "rate", 0.1),
    "protein_g": Series("protein_g", "protein", "grams", 10),
    "kcal": Series("kcal", "calories", "kcal", 150),
}
PAIRS = [
    ("sleep_hours", "habits"),
    ("sleep_hours", "trained"),
    ("sleep_hours", "mood"),
    ("sleep", "habits"),
    ("sleep", "trained"),
    ("sleep", "mood"),
    ("energy", "trained"),
    ("trained", "mood"),
    ("trained", "protein_g"),
    ("trained", "habits"),
    ("mood", "habits"),
    ("habits", "mood"),
    ("protein_g", "mood"),
]


@dataclass
class Insight:
    driver: str
    outcome: str
    text: str
    high: float
    low: float
    days_high: int
    days_low: int
    strength: float


def welch_t(a: list[float], b: list[float]) -> float:
    va, vb = variance(a), variance(b)
    se = math.sqrt(va / len(a) + vb / len(b))
    if se == 0:
        return math.inf if mean(a) != mean(b) else 0.0
    return (mean(a) - mean(b)) / se


def fmt(series: Series, value: float) -> str:
    match series.kind:
        case "rate" | "binary":
            return f"{round(value * 100)}%"
        case "score":
            return f"{value:.1f}/5"
        case "hours":
            return f"{value:.1f} h"
        case "grams":
            return f"{round(value)} g"
        case "kcal":
            return f"{round(value)} kcal"
    return f"{value:g}"


def _condition(driver: Series, threshold: float | None, high: bool) -> str:
    if driver.kind == "binary":
        return f"days you {'trained' if high else 'rested'}"
    if driver.kind == "hours":
        return f"days after {fmt(driver, threshold)}+ of sleep" if high else "shorter nights"
    if driver.kind == "rate":
        return f"days with {fmt(driver, threshold)}+ of {driver.label}" if high else "other days"
    if driver.kind == "score":
        return f"days your {driver.label} was {threshold:g}+" if high else "other days"
    return f"days with {fmt(driver, threshold)}+ {driver.label}" if high else "other days"


def _sentence(driver: Series, outcome: Series, threshold: float | None, hi: float, lo: float):
    if outcome.kind == "binary":
        what = "You trained on"
        return (
            f"{what} {fmt(outcome, hi)} of {_condition(driver, threshold, True)}, "
            f"against {fmt(outcome, lo)} of {_condition(driver, threshold, False)}."
        )
    if outcome.kind == "rate":
        return (
            f"You kept {fmt(outcome, hi)} of your habits on {_condition(driver, threshold, True)}, "
            f"against {fmt(outcome, lo)} on {_condition(driver, threshold, False)}."
        )
    return (
        f"Your {outcome.label} averaged {fmt(outcome, hi)} on "
        f"{_condition(driver, threshold, True)}, against {fmt(outcome, lo)} on "
        f"{_condition(driver, threshold, False)}."
    )


def find(series: dict[str, dict[date, float]]) -> list[Insight]:
    """The strongest patterns, strongest first. `series` maps a key in
    SERIES to its values by day; a day missing from a series is unknown,
    not zero."""
    found: list[Insight] = []
    for d_key, o_key in PAIRS:
        driver_values, outcome_values = series.get(d_key) or {}, series.get(o_key) or {}
        days = sorted(driver_values.keys() & outcome_values.keys())
        if len(days) < 2 * MIN_DAYS:
            continue
        driver, outcome = SERIES[d_key], SERIES[o_key]
        if driver.kind == "binary":
            threshold = None
            is_high = [driver_values[d] >= 0.5 for d in days]
        else:
            threshold = median(driver_values[d] for d in days)
            if driver.kind == "hours":
                threshold = round(threshold * 2) / 2
            elif driver.kind == "score":
                threshold = math.ceil(threshold)
            is_high = [driver_values[d] >= threshold for d in days]
        high = [outcome_values[d] for d, h in zip(days, is_high, strict=True) if h]
        low = [outcome_values[d] for d, h in zip(days, is_high, strict=True) if not h]
        if len(high) < MIN_DAYS or len(low) < MIN_DAYS:
            continue
        hi, lo = mean(high), mean(low)
        gap = abs(hi - lo)
        if outcome.kind in ("grams", "kcal") and lo > 0:
            # Food gaps matter relative to how much is eaten.
            if gap < max(outcome.min_gap, 0.1 * lo):
                continue
        elif gap < outcome.min_gap:
            continue
        t = welch_t(high, low)
        if abs(t) < MIN_T:
            continue
        found.append(
            Insight(
                driver=d_key,
                outcome=o_key,
                text=_sentence(driver, outcome, threshold, hi, lo),
                high=round(hi, 3),
                low=round(lo, 3),
                days_high=len(high),
                days_low=len(low),
                strength=round(min(abs(t), 99), 2),
            )
        )
    found.sort(key=lambda i: -i.strength)
    # One insight per outcome: three ways of saying "you keep more habits
    # when..." is one finding, not three.
    seen: set[str] = set()
    best = []
    for i in found:
        if i.outcome in seen:
            continue
        seen.add(i.outcome)
        best.append(i)
    return best[:MAX_INSIGHTS]
