"""XP. Pure: a function of history, recomputed whole every time.

Rewards showing up and logging honestly - never lifting heavier or doing more.
Two people of very different strength earn identical XP for the same week.

- A training day pays DAY_XP. A second session that day pays SECOND_SESSION_XP,
  anything after that nothing, so splitting one workout into five does not pay.
- Days beyond the weekly target + 1 pay EXTRA_DAY_XP: training every single
  day is not rewarded over training the plan with rest in it.
- A flat DETAIL_XP for a day logged with detail - completeness, not magnitude.
- A kept week pays KEPT_WEEK_XP. Frozen or repaired weeks keep the streak but
  pay nothing: a forgiven week is not an earned one.
- Streak milestones, rewarded PRs and achievements pay fixed amounts.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from app.common.time import season_id, week_start

DAY_XP = 20
SECOND_SESSION_XP = 5
EXTRA_DAY_XP = 5
DETAIL_XP = 5
KEPT_WEEK_XP = 50
PR_XP = 25
ACHIEVEMENT_XP = {None: 50, "bronze": 50, "silver": 100, "gold": 200}
MILESTONE_XP = {4: 100, 8: 150, 12: 250, 26: 500, 52: 1000, 104: 1500, 156: 2000}


@dataclass(frozen=True)
class DayActivity:
    day: date
    sessions: int
    detailed: bool


@dataclass(frozen=True)
class XpItem:
    source: str
    amount: int
    day: date


def compute_xp(
    days: list[DayActivity],
    week_starts_on: int,
    target_for,
    kept_weeks: list[date],
    milestones: list[tuple[int, date]],
    pr_days: list[date],
    achievements: list[tuple[str | None, date]],
) -> list[XpItem]:
    items: list[XpItem] = []

    by_week: dict[date, list[DayActivity]] = defaultdict(list)
    for activity in days:
        by_week[week_start(activity.day, week_starts_on)].append(activity)

    for week, week_days in by_week.items():
        allowance = target_for(week) + 1
        for index, activity in enumerate(sorted(week_days, key=lambda a: a.day)):
            base = DAY_XP if index < allowance else EXTRA_DAY_XP
            items.append(XpItem("training_day", base, activity.day))
            if activity.sessions > 1:
                items.append(XpItem("second_session", SECOND_SESSION_XP, activity.day))
            if activity.detailed:
                items.append(XpItem("detail", DETAIL_XP, activity.day))

    for week in kept_weeks:
        items.append(XpItem("kept_week", KEPT_WEEK_XP, week + timedelta(days=6)))
    for length, week in milestones:
        amount = MILESTONE_XP.get(length, 0)
        if amount:
            items.append(XpItem("milestone", amount, week + timedelta(days=6)))
    for day in pr_days:
        items.append(XpItem("pr", PR_XP, day))
    for tier, day in achievements:
        items.append(XpItem("achievement", ACHIEVEMENT_XP.get(tier, 50), day))
    return items


def summarise(items: list[XpItem], season: str) -> dict:
    total = sum(i.amount for i in items)
    season_xp = sum(i.amount for i in items if season_id(i.day) == season)
    by_source: dict[str, int] = defaultdict(int)
    for i in items:
        by_source[i.source] += i.amount
    return {"total": total, "season": season_xp, "by_source": dict(by_source)}
