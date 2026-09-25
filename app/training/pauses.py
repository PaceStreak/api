"""Streak pauses: the rules, kept pure so they can be tested without a database.

A pause is how "rest is training" survives an injury. It is deliberately
bounded, because an unbounded pause would be a way to hold a streak (and a
place on the streak leaderboard) without training at all:

- It can start up to PAUSE_BACKDATE_DAYS in the past (people open the app a
  few days after the injury, not during it) and up to PAUSE_LEAD_DAYS ahead
  (a planned operation).
- One pause lasts at most PAUSE_MAX_DAYS. An open-ended pause counts as
  running to that cap, and simply stops sheltering weeks after it.
- At most PAUSE_BUDGET_DAYS of pause in any trailing PAUSE_BUDGET_WINDOW days.
- Pauses never overlap.

What a pause does to a week is decided in app/game/streak.py, not here: it
shelters a week only if it covers at least PAUSE_MIN_DAYS of it.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta

PAUSE_MAX_DAYS = 84
PAUSE_BACKDATE_DAYS = 14
PAUSE_LEAD_DAYS = 30
PAUSE_BUDGET_DAYS = 120
PAUSE_BUDGET_WINDOW = 365
REASONS = ("injury", "illness", "life", "other")


class PauseError(ValueError):
    """A pause that breaks one of the rules above. The message is user-facing."""


@dataclass(frozen=True)
class Span:
    starts_on: date
    ends_on: date | None  # inclusive; None while open

    def effective_end(self) -> date:
        cap = self.starts_on + timedelta(days=PAUSE_MAX_DAYS - 1)
        return cap if self.ends_on is None else min(self.ends_on, cap)

    def days(self) -> list[date]:
        end = self.effective_end()
        return [self.starts_on + timedelta(days=i) for i in range((end - self.starts_on).days + 1)]

    def overlaps(self, other: Span) -> bool:
        return self.starts_on <= other.effective_end() and other.starts_on <= self.effective_end()

    def is_active(self, today: date) -> bool:
        return self.starts_on <= today <= self.effective_end()


def paused_days(spans: Iterable[Span]) -> set[date]:
    return {d for s in spans for d in s.days()}


def days_used(spans: Iterable[Span], today: date) -> int:
    """Pause days inside the trailing budget window, counting planned ones."""
    since = today - timedelta(days=PAUSE_BUDGET_WINDOW - 1)
    return sum(1 for d in paused_days(spans) if d >= since)


def validate(new: Span, existing: list[Span], today: date) -> None:
    if new.starts_on < today - timedelta(days=PAUSE_BACKDATE_DAYS):
        raise PauseError(f"A pause can start at most {PAUSE_BACKDATE_DAYS} days ago.")
    if new.starts_on > today + timedelta(days=PAUSE_LEAD_DAYS):
        raise PauseError(f"A pause can be planned at most {PAUSE_LEAD_DAYS} days ahead.")
    if new.ends_on is not None:
        if new.ends_on < new.starts_on:
            raise PauseError("A pause cannot end before it starts.")
        if (new.ends_on - new.starts_on).days + 1 > PAUSE_MAX_DAYS:
            raise PauseError(f"One pause can last at most {PAUSE_MAX_DAYS // 7} weeks.")
    if any(new.overlaps(s) for s in existing):
        raise PauseError("That overlaps a pause you already have.")
    if days_used([*existing, new], today) > PAUSE_BUDGET_DAYS:
        raise PauseError(
            f"Pauses are limited to {PAUSE_BUDGET_DAYS} days a year. "
            "Set an end date, or end an earlier pause sooner."
        )


def end_date_for(span: Span, today: date) -> date | None:
    """The inclusive end when someone ends a pause today, meaning today is
    their first day back. None means the pause never took effect and should
    be deleted rather than ended."""
    if span.starts_on >= today:
        return None
    return min(today - timedelta(days=1), span.effective_end())
