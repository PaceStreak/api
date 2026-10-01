"""Habit history from other apps, so switching doesn't cost a streak.

Two shapes cover the exports in the wild:

- Wide: a date column, then one column per habit. Loop Habit Tracker's
  `Checkmarks.csv` (on its own or inside its export zip) is this shape, with
  2 meaning "done by hand", 1 "implied by the frequency", 0 "not done" and
  -1 "unknown"; only 2 counts as done. Any other wide file counts a
  positive number as done, and keeps the number as the amount.
- Long: one row per habit per day, with a date column and a habit-name
  column (Habitify, Streaks, spreadsheets). A value column, if present, is
  the amount; without one each row is a tick.

Only ISO dates (2026-09-30, 2026/09/30, or a timestamp starting with one)
are read: 03/04/2026 means a different day in different countries, and
guessing would quietly scramble someone's history.
"""

import csv
import io
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date

MAX_BYTES = 5 * 1024 * 1024
MAX_HABITS = 60
_ISO = re.compile(r"^(\d{4})[-/](\d{2})[-/](\d{2})")
DATE_COLUMNS = ("date", "day", "entry_date", "completed_at", "completion_date", "timestamp", "time")
NAME_COLUMNS = ("habit", "habit_name", "name", "title", "task", "task_title", "habit name")
VALUE_COLUMNS = ("value", "amount", "count", "quantity", "duration", "minutes", "progress")


class HabitImportError(ValueError):
    pass


@dataclass
class ImportedHabit:
    name: str
    days: dict[date, float] = field(default_factory=dict)
    # True when every amount was a plain tick, so it becomes a check habit.
    binary: bool = True


def parse_date(text: str) -> date | None:
    m = _ISO.match(text.strip())
    if not m:
        return None
    try:
        return date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return None


def _number(text: str) -> float | None:
    try:
        return float(text.strip().replace(",", "."))
    except ValueError:
        return None


def _csv_text(filename: str, data: bytes) -> str:
    if len(data) > MAX_BYTES:
        raise HabitImportError("That file is over 5 MB")
    if filename.lower().endswith(".zip") or data[:2] == b"PK":
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise HabitImportError("That zip file can't be opened") from exc
        names = [n for n in archive.namelist() if n.lower().endswith(".csv")]
        # Loop's export keeps every habit's ticks in the top-level file.
        chosen = next((n for n in names if n.lower() == "checkmarks.csv"), None) or next(
            (n for n in names if n.lower().endswith("checkmarks.csv")), None
        )
        if chosen is None:
            if len(names) != 1:
                raise HabitImportError("Couldn't tell which file in the zip holds the history")
            chosen = names[0]
        info = archive.getinfo(chosen)
        if info.file_size > MAX_BYTES:
            raise HabitImportError("That file is over 5 MB")
        data = archive.read(chosen)
    for encoding in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise HabitImportError("That file isn't text")


def _find(header: list[str], options: tuple[str, ...]) -> int | None:
    lowered = [h.strip().lower() for h in header]
    for option in options:
        if option in lowered:
            return lowered.index(option)
    return None


def _long(rows: list[list[str]], d_col: int, n_col: int, v_col: int | None) -> list[ImportedHabit]:
    habits: dict[str, ImportedHabit] = {}
    for row in rows:
        if max(d_col, n_col) >= len(row):
            continue
        day, name = parse_date(row[d_col]), row[n_col].strip()[:60]
        if day is None or not name:
            continue
        amount = 1.0
        if v_col is not None and v_col < len(row):
            value = _number(row[v_col])
            if value is None or value <= 0:
                continue
            amount = value
        habit = habits.setdefault(name.casefold(), ImportedHabit(name))
        habit.days[day] = habit.days.get(day, 0) + amount
    for h in habits.values():
        h.binary = all(v == 1 for v in h.days.values())
    return list(habits.values())


def _wide(rows: list[list[str]], header: list[str], d_col: int) -> list[ImportedHabit]:
    out = []
    for col, name in enumerate(header):
        if col == d_col or not name.strip():
            continue
        values: list[tuple[date, float]] = []
        for row in rows:
            if col >= len(row):
                continue
            day, value = parse_date(row[d_col]), _number(row[col])
            if day is not None and value is not None:
                values.append((day, value))
        seen = {v for _, v in values}
        loop_style = 2 in seen and seen <= {-1, 0, 1, 2, 3}
        habit = ImportedHabit(name.strip()[:60])
        for day, value in values:
            if loop_style:
                if value == 2:
                    habit.days[day] = 1
            elif value > 0:
                habit.days[day] = value
        habit.binary = loop_style or all(v == 1 for v in habit.days.values())
        out.append(habit)
    return out


def parse(filename: str, data: bytes) -> list[ImportedHabit]:
    text = _csv_text(filename, data)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = [r for r in csv.reader(io.StringIO(text), dialect) if any(c.strip() for c in r)]
    if len(rows) < 2:
        raise HabitImportError("That file has no rows to import")
    header, body = rows[0], rows[1:]
    d_col = _find(header, DATE_COLUMNS)
    if d_col is None:
        raise HabitImportError("Couldn't find a date column. It needs a header named Date.")
    if not any(parse_date(r[d_col]) for r in body[:50] if d_col < len(r)):
        raise HabitImportError("Dates must be written year first, like 2026-09-30")
    n_col = _find(header, NAME_COLUMNS)
    if n_col is not None:
        habits = _long(body, d_col, n_col, _find(header, VALUE_COLUMNS))
    else:
        habits = _wide(body, header, d_col)
    habits = [h for h in habits if h.days]
    if not habits:
        raise HabitImportError("Nothing in that file was marked done")
    if len(habits) > MAX_HABITS:
        raise HabitImportError(f"More than {MAX_HABITS} habits in one file")
    return habits
