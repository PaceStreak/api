"""Calendar helpers shared by every feature that reasons about "which day".

A training day is the user's *local* calendar date, never the UTC one: a run
at 23:30 in Los Angeles is that day's run, not tomorrow's. Every date that
feeds a streak, a heatmap cell or a challenge window goes through here so the
rule lives in exactly one place.
"""

from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones


def utcnow() -> datetime:
    return datetime.now(UTC)


@lru_cache(maxsize=1)
def _known_zones() -> frozenset[str]:
    return frozenset(available_timezones())


def is_valid_timezone(name: str) -> bool:
    return name in _known_zones()


@lru_cache(maxsize=512)
def zone(name: str) -> ZoneInfo:
    """A zone that never raises. An unknown name falls back to UTC rather than
    turning one stale browser setting into a 500 on every request."""
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError, ValueError:
        return ZoneInfo("UTC")


def local_date(moment: datetime, tz: str) -> date:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(zone(tz)).date()


def local_now(tz: str) -> datetime:
    return utcnow().astimezone(zone(tz))


def local_today(tz: str) -> date:
    return local_now(tz).date()


def week_start(day: date, week_starts_on: int) -> date:
    """The first day of the week containing `day`. 0 = Monday … 6 = Sunday,
    matching date.weekday()."""
    return day - timedelta(days=(day.weekday() - week_starts_on) % 7)


def month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def season_id(day: date) -> str:
    """Competitive seasons are calendar quarters: "2026-Q3"."""
    return f"{day.year}-Q{(day.month - 1) // 3 + 1}"


def season_bounds(sid: str) -> tuple[date, date]:
    year, quarter = sid.split("-Q")
    first_month = (int(quarter) - 1) * 3 + 1
    start = date(int(year), first_month, 1)
    end_month = first_month + 3
    end = date(int(year) + (end_month > 12), (end_month - 1) % 12 + 1, 1) - timedelta(days=1)
    return start, end
