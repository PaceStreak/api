"""Set-by-set CSV exports from other lifting apps: Strong, Hevy and FitNotes.

Each of these writes one row per set. Rows are grouped back into sessions
(by start time for Strong and Hevy, by day for FitNotes, which records no
time), weights are converted to kilograms, and each exercise name is
matched to the library. This module does no I/O: the router decides what an
unmatched name becomes (a custom exercise, so nothing is lost).

Formats, from the apps' own exports as of 2026:

- Strong: Date, Workout Name, Duration, Exercise Name, Set Order, Weight,
  Reps, Distance, Seconds, Notes, Workout Notes, RPE. Weight is in the
  app's unit and the file doesn't say which, so the person picks.
  Set Order "W" marks a warm-up; "D" a drop set; "F" failure.
- Hevy: title, start_time, end_time, description, exercise_title,
  superset_id, exercise_notes, set_index, set_type, weight_kg or
  weight_lbs, reps, distance_km or distance_miles, duration_seconds, rpe.
- FitNotes: Date, Exercise, Category, Weight (kgs) or Weight (lbs), Reps,
  Distance, Distance Unit, Time, Comment.
"""

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

LB = 0.45359237
MAX_ROWS = 100_000
MAX_SETS_PER_SESSION = 400


class LiftingFormatError(ValueError):
    """The file as a whole could not be read. The message is user-facing."""


@dataclass
class ParsedSet:
    exercise: str  # the name as the other app wrote it
    set_index: int
    kind: str = "work"  # work | warmup | drop | failure
    weight_kg: float | None = None
    reps: int | None = None
    rpe: float | None = None
    duration_sec: int | None = None
    distance_m: float | None = None
    superset: int | None = None


@dataclass
class LiftingSession:
    started_at: datetime
    title: str | None = None
    notes: str | None = None
    duration_sec: int | None = None
    sets: list[ParsedSet] = field(default_factory=list)


@dataclass
class LiftingResult:
    format: str
    sessions: list[LiftingSession]
    problems: list[str]


def _norm(header: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", header.strip().lower()).strip("_")


def detect(headers: list[str]) -> str | None:
    h = {_norm(x) for x in headers}
    if {"exercise_name", "set_order"} <= h:
        return "strong"
    if {"exercise_title", "set_index"} <= h and "start_time" in h:
        return "hevy"
    if "exercise" in h and "category" in h and ("weight_kgs" in h or "weight_lbs" in h):
        return "fitnotes"
    return None


def is_lifting_csv(data: bytes) -> bool:
    """Whether a CSV's header row is a Strong, Hevy or FitNotes export."""
    head = data[:4096].decode("utf-8-sig", errors="ignore").splitlines()
    if not head:
        return False
    delimiter = ";" if head[0].count(";") > head[0].count(",") else ","
    try:
        headers = next(csv.reader([head[0]], delimiter=delimiter))
    except csv.Error, StopIteration:
        return False
    return detect(headers) is not None


def _num(value: str | None) -> float | None:
    if value is None:
        return None
    value = (
        value.strip().replace(",", ".")
        if value.count(",") == 1 and "." not in value
        else value.strip().replace(",", "")
    )
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _int(value: str | None) -> int | None:
    n = _num(value)
    return int(round(n)) if n is not None else None


def _duration(value: str | None) -> int | None:
    """Seconds from "1h 5m", "45m", "1:02:03", "00:45" or a bare number."""
    if not value or not value.strip():
        return None
    v = value.strip().lower()
    if re.fullmatch(r"[\d:.]+", v) and ":" in v:
        parts = [float(p) for p in v.split(":")]
        while len(parts) < 3:
            parts.insert(0, 0.0)
        h, m, s = parts[-3:]
        return int(h * 3600 + m * 60 + s)
    units = re.findall(r"(\d+(?:\.\d+)?)\s*([hms])", v)
    if units:
        mult = {"h": 3600, "m": 60, "s": 1}
        return int(sum(float(n) * mult[u] for n, u in units))
    n = _num(v)
    return int(n) if n is not None else None


HEVY_DATE = "%d %b %Y, %H:%M"


def _when(value: str, tz: str, fmt: str | None = None) -> datetime:
    zone = ZoneInfo(tz)
    value = value.strip()
    if fmt:
        return datetime.strptime(value, fmt).replace(tzinfo=zone)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        parsed = datetime.combine(date.fromisoformat(value[:10]), time(12))
    if len(value) <= 10:
        parsed = datetime.combine(parsed.date(), time(12))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=zone)


def _kind(value: str | None) -> str:
    v = (value or "").strip().lower()
    if v in ("w", "warmup", "warm_up", "warm-up"):
        return "warmup"
    if v in ("d", "dropset", "drop_set", "drop"):
        return "drop"
    if v in ("f", "failure"):
        return "failure"
    return "work"


def parse_lifting(data: bytes, tz: str, unit: str = "kg") -> LiftingResult:
    """Read a Strong, Hevy or FitNotes export. `unit` is the weight unit for
    Strong, whose file doesn't say."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise LiftingFormatError("CSV files need to be UTF-8.") from error
    sample = text[:4096]
    delimiter = ";" if sample.count(";") > sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    if not reader.fieldnames:
        raise LiftingFormatError("That CSV file has no header row.")
    kind = detect(reader.fieldnames)
    if kind is None:
        raise LiftingFormatError("That isn't a Strong, Hevy or FitNotes export.")
    reader.fieldnames = [_norm(h) for h in reader.fieldnames]
    to_kg = LB if unit == "lb" else 1.0

    sessions: dict[tuple, LiftingSession] = {}
    order: dict[tuple, dict[str, int]] = {}
    problems: list[str] = []
    for line, row in enumerate(reader, start=2):
        if line > MAX_ROWS:
            raise LiftingFormatError(f"One upload can hold at most {MAX_ROWS} rows.")
        try:
            if kind == "strong":
                started = _when(row["date"], tz)
                key = (started,)
                name = (row.get("exercise_name") or "").strip()
                weight = _num(row.get("weight"))
                parsed = ParsedSet(
                    exercise=name,
                    set_index=0,
                    kind=_kind(row.get("set_order")),
                    weight_kg=weight * to_kg if weight is not None else None,
                    reps=_int(row.get("reps")),
                    rpe=_num(row.get("rpe")),
                    duration_sec=_int(row.get("seconds")),
                    distance_m=(d * 1000 if (d := _num(row.get("distance"))) else None),
                )
                title, notes = row.get("workout_name"), row.get("workout_notes")
                duration = _duration(row.get("duration"))
            elif kind == "hevy":
                raw = row["start_time"]
                started = _when(
                    raw, tz, HEVY_DATE if re.match(r"\d{1,2} \w{3} \d{4},", raw.strip()) else None
                )
                key = (started,)
                name = (row.get("exercise_title") or "").strip()
                if row.get("weight_kg") not in (None, ""):
                    weight = _num(row.get("weight_kg"))
                else:
                    w = _num(row.get("weight_lbs"))
                    weight = w * LB if w is not None else None
                dist = _num(row.get("distance_km"))
                if dist is None and (mi := _num(row.get("distance_miles"))) is not None:
                    dist = mi * 1.609344
                superset = _int(row.get("superset_id"))
                parsed = ParsedSet(
                    exercise=name,
                    set_index=0,
                    kind=_kind(row.get("set_type")),
                    weight_kg=weight,
                    reps=_int(row.get("reps")),
                    rpe=_num(row.get("rpe")),
                    duration_sec=_int(row.get("duration_seconds")),
                    distance_m=dist * 1000 if dist else None,
                    superset=superset + 1 if superset is not None else None,
                )
                title, notes = row.get("title"), row.get("description")
                end = row.get("end_time")
                duration = None
                if end:
                    try:
                        finished = _when(
                            end,
                            tz,
                            HEVY_DATE if re.match(r"\d{1,2} \w{3} \d{4},", end.strip()) else None,
                        )
                        duration = max(0, int((finished - started).total_seconds())) or None
                    except ValueError:
                        duration = None
            else:  # fitnotes
                day = date.fromisoformat(row["date"].strip()[:10])
                started = datetime.combine(day, time(12), tzinfo=ZoneInfo(tz))
                key = (day,)
                name = (row.get("exercise") or "").strip()
                if row.get("weight_kgs") not in (None, ""):
                    weight = _num(row.get("weight_kgs"))
                else:
                    w = _num(row.get("weight_lbs"))
                    weight = w * LB if w is not None else None
                dist = _num(row.get("distance"))
                dunit = (row.get("distance_unit") or "").strip().lower()
                factor = {"km": 1000, "m": 1, "mi": 1609.344, "miles": 1609.344, "ft": 0.3048}.get(
                    dunit, 1000
                )
                parsed = ParsedSet(
                    exercise=name,
                    set_index=0,
                    weight_kg=weight,
                    reps=_int(row.get("reps")),
                    duration_sec=_duration(row.get("time")),
                    distance_m=dist * factor if dist else None,
                )
                title, notes, duration = None, None, None
        except KeyError, ValueError:
            problems.append(f"Row {line} has a date or number that couldn't be read.")
            continue
        if not name:
            problems.append(f"Row {line} has no exercise name.")
            continue
        if parsed.weight_kg is not None and not 0 <= parsed.weight_kg <= 1000:
            problems.append(f"Row {line} has an implausible weight.")
            continue
        if parsed.reps is not None and not 0 <= parsed.reps <= 1000:
            problems.append(f"Row {line} has an implausible number of reps.")
            continue
        if parsed.rpe is not None and not 1 <= parsed.rpe <= 10:
            parsed.rpe = None
        session = sessions.get(key)
        if session is None:
            session = sessions[key] = LiftingSession(
                started_at=started,
                title=(title or "").strip()[:80] or None,
                notes=(notes or "").strip()[:2000] or None,
                duration_sec=duration if duration and duration <= 48 * 3600 else None,
            )
            order[key] = {}
        if len(session.sets) >= MAX_SETS_PER_SESSION:
            continue
        counts = order[key]
        parsed.set_index = counts.get(name, 0)
        counts[name] = parsed.set_index + 1
        session.sets.append(parsed)

    return LiftingResult(kind, sorted(sessions.values(), key=lambda s: s.started_at), problems)


# --- matching names to the library ----------------------------------------------

EQUIPMENT_WORDS = {
    "barbell": "barbell",
    "dumbbell": "dumbbell",
    "dumbbells": "dumbbell",
    "cable": "cable",
    "machine": "machine",
    "smith machine": "smith",
    "smith": "smith",
    "kettlebell": "kettlebell",
    "band": "band",
    "bodyweight": "bodyweight",
    "weighted": "bodyweight",
    "assisted": "machine",
    "ez bar": "barbell",
    "trap bar": "barbell",
    "plate": "dumbbell",
}

# Names other apps use for exercises we hold under another name.
SYNONYMS = {
    "squat": "back squat",
    "bench press": "bench press",
    "overhead press": "overhead press",
    "military press": "overhead press",
    "shoulder press": "dumbbell shoulder press",
    "bent over row": "barbell row",
    "bent over one arm row": "one arm dumbbell row",
    "deadlift": "deadlift",
    "romanian deadlift": "romanian deadlift",
    "pull up": "pull up",
    "chin up": "chin up",
    "lat pulldown": "lat pulldown",
    "seated row": "seated cable row",
    "bicep curl": "dumbbell curl",
    "biceps curl": "dumbbell curl",
    "triceps pushdown": "triceps pushdown",
    "triceps extension": "overhead triceps extension",
    "lateral raise": "lateral raise",
    "leg press": "leg press",
    "leg extension": "leg extension",
    "lying leg curl": "lying leg curl",
    "seated leg curl": "seated leg curl",
    "calf raise": "standing calf raise",
    "standing calf raise": "standing calf raise",
    "hip thrust": "hip thrust",
    "plank": "plank",
    "crunch": "crunch",
    "push up": "push up",
    "dip": "dip",
    "dips": "dip",
    "lunge": "forward lunge",
    "lunges": "forward lunge",
    "curl": "dumbbell curl",
    "skullcrusher": "skull crusher",
    "rdl": "romanian deadlift",
    "ohp": "overhead press",
    "face pull": "face pull",
    "shrug": "shrug",
    "incline bench press": "incline bench press",
    "flat dumbbell bench press": "dumbbell bench press",
}


def _key(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def split_name(name: str) -> tuple[str, str | None]:
    """ "Bench Press (Barbell)" -> ("bench press", "barbell")."""
    m = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", name)
    if not m:
        return _key(name), None
    base, tag = _key(m.group(1)), _key(m.group(2))
    return base, EQUIPMENT_WORDS.get(tag)


EQUIPMENT_PREFIX = {"smith": "smith machine"}
FILLER = {"flat", "standard", "regular", "the", "a"}


def _strip_equipment(key: str) -> tuple[str, str | None]:
    """Pull an equipment word out of the name itself: "flat barbell bench
    press" -> ("bench press", "barbell")."""
    found = None
    for word in sorted(EQUIPMENT_WORDS, key=len, reverse=True):
        if re.search(rf"\b{word}\b", key):
            found = found or EQUIPMENT_WORDS[word]
            key = re.sub(rf"\b{word}\b", " ", key)
    words = [w for w in key.split() if w not in FILLER]
    return " ".join(words), found


def match_exercise(name: str, exercises: list) -> str | None:
    """The library id for a name written by another app, or None.

    Equipment comes from "(Barbell)" or from a word inside the name, and an
    exercise using that equipment always beats one that doesn't; a different
    piece of equipment is only accepted when nothing else matches and the
    name carried no equipment at all."""
    index: dict[str, list] = {}
    for e in exercises:
        for label in (e.name, *e.aliases):
            index.setdefault(_key(label), []).append(e)
    whole = _key(name)
    if whole in index:
        return index[whole][0].id
    # "Deadlift (Trap bar)" is the library's "Trap bar deadlift".
    bracket = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", name)
    if bracket:
        joined = _key(f"{bracket.group(2)} {bracket.group(1)}")
        if joined in index:
            return index[joined][0].id
    base, tagged = split_name(name)
    base, inner = _strip_equipment(base)
    equipment = tagged or inner

    stems = [base]
    if base in SYNONYMS:
        stems.append(_strip_equipment(SYNONYMS[base])[0])
    if base.endswith("s") and base[:-1] in SYNONYMS:
        stems.append(_strip_equipment(SYNONYMS[base[:-1]])[0])
    stems = [s for s in dict.fromkeys(stems) if s]

    hits: list = []
    for stem in stems:
        variants = [stem]
        if equipment and equipment != "bodyweight":
            variants.insert(0, f"{EQUIPMENT_PREFIX.get(equipment, equipment)} {stem}")
        variants.append(SYNONYMS.get(stem, ""))
        for v in variants:
            hits.extend(index.get(v, []))
    if not hits:
        return None
    if equipment:
        same = [e for e in hits if e.equipment == equipment]
        return same[0].id if same else None
    return hits[0].id


def guess_pattern(name: str) -> tuple[str, str, list[str]]:
    """A best guess at pattern, equipment and muscles for an unmatched name,
    so a created custom exercise lands somewhere sensible in the library."""
    base, equipment = split_name(name)
    rules = (
        (("squat", "lunge", "leg press", "step up"), "squat", ["quads", "glutes"]),
        (
            ("deadlift", "rdl", "hip thrust", "good morning", "swing", "leg curl"),
            "hinge",
            ["hamstrings", "glutes"],
        ),
        (("bench", "chest press", "push up", "fly", "dip"), "push_h", ["chest", "triceps"]),
        (
            ("overhead press", "shoulder press", "military", "arnold"),
            "push_v",
            ["front_delts", "triceps"],
        ),
        (("pulldown", "pull up", "chin up", "pullover"), "pull_v", ["lats"]),
        (("row",), "pull_h", ["upper_back", "lats"]),
        (("raise", "shrug", "face pull"), "shoulders", ["side_delts"]),
        (("curl",), "arms", ["biceps"]),
        (("extension", "pushdown", "skull", "kickback"), "arms", ["triceps"]),
        (("calf",), "calves", ["calves"]),
        (("plank", "crunch", "sit up", "leg raise", "ab "), "core", ["abs"]),
        (("carry", "walk"), "carry", ["forearms"]),
    )
    for words, pattern, muscles in rules:
        if any(w in f"{base} " for w in words):
            return pattern, equipment or "machine", muscles
    return "core", equipment or "machine", ["abs"]
