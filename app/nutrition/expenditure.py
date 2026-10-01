"""Adaptive energy expenditure: what someone actually burns, worked out from
what they ate and what the scale did, rather than from a formula about
people like them.

Energy balance: if the weight trend fell by Δ kg over the window, the body
covered 7,700 kcal per kg from storage, so expenditure is the average
intake plus that deficit. The trend is a least-squares line through the
daily weigh-in means, which a single heavy-salt day barely moves.

It needs enough data to mean anything, and it says so instead of guessing.
Suggestions are deliberately gentle: losing at most 0.5% of body weight a
week, never under 1,200 kcal, never more than 750 kcal below expenditure.
"""

from dataclasses import dataclass
from datetime import date
from statistics import mean

KCAL_PER_KG = 7700
WINDOW_DAYS = 28
MIN_FOOD_DAYS = 14
MIN_WEIGH_DAYS = 8
MIN_SPAN_DAYS = 14
FLOOR_KCAL = 1200
MAX_DEFICIT = 750
LOSE_RATE = 0.005  # of body weight per week
GAIN_RATE = 0.0025
MAINTAIN_BAND_KG = 1.0


@dataclass
class Estimate:
    status: str  # "ok", "not_enough" or "inconsistent"
    food_days: int
    weigh_days: int
    tdee: int | None = None
    avg_intake: int | None = None
    trend_kg_per_week: float | None = None
    trend_kg: float | None = None
    confidence: str | None = None  # "low" or "good"


def slope(points: list[tuple[float, float]]) -> float:
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    mx, my = mean(xs), mean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in points) / den if den else 0.0


def estimate(intake: dict[date, float], weights: dict[date, float], end: date) -> Estimate:
    """`intake` is kcal per logged day and `weights` the day's mean weigh-in,
    both over the window ending `end` (yesterday: today isn't over)."""
    food_days, weigh_days = len(intake), len(weights)
    span = (max(weights) - min(weights)).days if weights else 0
    if food_days < MIN_FOOD_DAYS or weigh_days < MIN_WEIGH_DAYS or span < MIN_SPAN_DAYS:
        return Estimate("not_enough", food_days, weigh_days)
    per_day = slope([((d - end).days, kg) for d, kg in sorted(weights.items())])
    avg_intake = mean(intake.values())
    tdee = avg_intake - per_day * KCAL_PER_KG
    if not 1000 <= tdee <= 6000:
        # Usually meals that weren't logged. A number this far out would
        # mislead, so the app asks for more complete logging instead.
        return Estimate("inconsistent", food_days, weigh_days)
    latest = (
        mean(kg for d, kg in weights.items() if (end - d).days < 7)
        if any((end - d).days < 7 for d in weights)
        else weights[max(weights)]
    )
    return Estimate(
        "ok",
        food_days,
        weigh_days,
        tdee=round(tdee),
        avg_intake=round(avg_intake),
        trend_kg_per_week=round(per_day * 7, 2),
        trend_kg=round(latest, 1),
        confidence="good" if food_days >= 21 and weigh_days >= 12 else "low",
    )


def suggest(est: Estimate, target_kg: float | None) -> dict | None:
    """A calorie target toward the weight goal, or maintenance without one."""
    if est.status != "ok" or est.tdee is None or est.trend_kg is None:
        return None
    if target_kg is None or abs(target_kg - est.trend_kg) <= MAINTAIN_BAND_KG:
        return {"goal": "maintain", "kcal": est.tdee, "rate_kg_per_week": 0.0}
    if target_kg < est.trend_kg:
        rate = -LOSE_RATE * est.trend_kg
        kcal = max(FLOOR_KCAL, est.tdee - MAX_DEFICIT, est.tdee + rate * KCAL_PER_KG / 7)
        goal = "lose"
    else:
        rate = GAIN_RATE * est.trend_kg
        kcal = est.tdee + rate * KCAL_PER_KG / 7
        goal = "gain"
    kcal = round(kcal / 10) * 10
    return {
        "goal": goal,
        "kcal": kcal,
        "rate_kg_per_week": round((kcal - est.tdee) * 7 / KCAL_PER_KG, 2),
    }
