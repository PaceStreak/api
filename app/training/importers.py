"""Parsers for activity files: GPX, FIT and CSV. Pure - bytes in, sessions out.

This is how history from a watch or another app gets in without an OAuth
integration with anyone. People export a file from wherever it lives and
upload it; nothing here talks to a third party.

Every parser returns the same shape (ParsedSession) plus a list of per-item
problems, and never raises on a single bad row or track: one malformed lap in
a five-year export should cost that lap, not the whole upload. A file that
cannot be read at all raises ImportFormatError.

Safety:
- XML goes through defusedxml, so a GPX file cannot use entity expansion
  (billion laughs) or external entities against the server.
- Sizes and counts are bounded by the caller (MAX_BYTES) and here
  (MAX_SESSIONS), and implausible values are rejected per session.
"""

import csv
import io
import math
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import fitdecode
from defusedxml import ElementTree

MAX_BYTES = 15 * 1024 * 1024
MAX_SESSIONS = 5000
MAX_DURATION = timedelta(hours=48)
MAX_DISTANCE_M = 1_000_000

# Loose names from GPX <type>, FIT sport/sub_sport and CSV columns, mapped to
# PaceStreak discipline ids. Anything unrecognised becomes "other" rather than
# an error: the session still counts towards the streak.
ALIASES = {
    "strength": "strength",
    "strength_training": "strength",
    "weight_training": "strength",
    "weights": "strength",
    "lift": "strength",
    "lifting": "strength",
    "gym": "strength",
    "run": "run",
    "running": "run",
    "trail_running": "run",
    "treadmill": "run",
    "treadmill_running": "run",
    "jog": "run",
    "ride": "ride",
    "cycling": "ride",
    "biking": "ride",
    "bike": "ride",
    "mountain_biking": "ride",
    "virtual_ride": "ride",
    "indoor_cycling": "ride",
    "e_biking": "ride",
    "swim": "swim",
    "swimming": "swim",
    "lap_swimming": "swim",
    "open_water": "swim",
    "open_water_swimming": "swim",
    "walk": "walk",
    "walking": "walk",
    "hike": "walk",
    "hiking": "walk",
    "climb": "climb",
    "climbing": "climb",
    "rock_climbing": "climb",
    "bouldering": "climb",
    "row": "row",
    "rowing": "row",
    "indoor_rowing": "row",
    "hiit": "hiit",
    "conditioning": "hiit",
    "cardio_training": "hiit",
    "crossfit": "hiit",
    "yoga": "yoga",
    "pilates": "yoga",
    "mobility": "yoga",
    "flexibility_training": "yoga",
    "sport": "sport",
    "tennis": "sport",
    "soccer": "sport",
    "football": "sport",
    "basketball": "sport",
    "other": "other",
    "generic": "other",
    "training": "other",
}


class ImportFormatError(ValueError):
    """The file as a whole could not be read. The message is user-facing."""


@dataclass
class ParsedSession:
    started_at: datetime  # timezone-aware
    discipline: str
    duration_sec: int | None = None
    distance_m: float | None = None
    elevation_m: float | None = None
    title: str | None = None
    notes: str | None = None
    effort: int | None = None
    feel: int | None = None
    # [{"m": 1000, "sec": 312}, ..., {"m": 420, "sec": 140}]: whole kilometres,
    # then the last partial one. Empty when the file has no timed track.
    splits: list[dict] = field(default_factory=list)


def km_splits(track: list[tuple[float, datetime]]) -> list[dict]:
    """Per-kilometre times from (cumulative metres, time) points, oldest
    first. Crossing points are interpolated between samples, so a watch
    recording every 5 seconds still gives honest splits. Pure.

    Stored for the person's own session view only; never ranked, never in a
    feed - a split is a detail of your run, not a score.
    """
    pts = [(d, t) for d, t in track if d is not None and t is not None]
    if len(pts) < 2 or pts[-1][0] - pts[0][0] < 100:
        return []
    splits: list[dict] = []
    base_d, base_t = pts[0]
    mark = base_d + 1000
    last_cross = base_t
    for (d0, t0), (d1, t1) in zip(pts, pts[1:], strict=False):
        while d1 >= mark > d0 and len(splits) < 500:
            frac = (mark - d0) / (d1 - d0) if d1 > d0 else 0
            cross = t0 + (t1 - t0) * frac
            splits.append({"m": 1000, "sec": round((cross - last_cross).total_seconds())})
            last_cross = cross
            mark += 1000
    remainder = pts[-1][0] - (mark - 1000)
    if remainder >= 50:
        splits.append(
            {"m": round(remainder), "sec": round((pts[-1][1] - last_cross).total_seconds())}
        )
    return splits


@dataclass
class ParseResult:
    format: str
    sessions: list[ParsedSession]
    problems: list[str]


def discipline_for(*names: str | None, default: str = "other") -> str:
    for name in names:
        if not name:
            continue
        key = str(name).strip().lower().replace("-", "_").replace(" ", "_")
        if key in ALIASES:
            return ALIASES[key]
    return default


def check(session: ParsedSession, now: datetime) -> str | None:
    """Why this session cannot be imported, or None."""
    if session.started_at > now + timedelta(minutes=10):
        return "starts in the future"
    if session.started_at.year < 1990:
        return "is dated before 1990"
    if (
        session.duration_sec is not None
        and not 0 <= session.duration_sec <= MAX_DURATION.total_seconds()
    ):
        return "has an implausible duration"
    if session.distance_m is not None and not 0 <= session.distance_m <= MAX_DISTANCE_M:
        return "has an implausible distance"
    return None


def sniff(filename: str, data: bytes) -> str:
    name = filename.lower()
    if name.endswith(".fit") or data[8:12] == b".FIT":
        return "fit"
    if name.endswith(".gpx") or b"<gpx" in data[:2048]:
        return "gpx"
    if name.endswith(".csv"):
        return "csv"
    raise ImportFormatError("Upload a .gpx, .fit or .csv file.")


def parse(filename: str, data: bytes, tz: str, discipline: str | None = None) -> ParseResult:
    if len(data) > MAX_BYTES:
        raise ImportFormatError("That file is larger than 15 MB.")
    if not data:
        raise ImportFormatError("That file is empty.")
    kind = sniff(filename, data)
    if kind == "fit":
        result = parse_fit(data, discipline)
    elif kind == "gpx":
        result = parse_gpx(data, discipline)
    else:
        result = parse_csv(data, tz, discipline)
    if len(result.sessions) > MAX_SESSIONS:
        raise ImportFormatError(f"One upload can hold at most {MAX_SESSIONS} sessions.")
    return result


# --- GPX ---------------------------------------------------------------------------------


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(node, name: str):
    return [c for c in node if _local(c.tag) == name]


def _text(node, name: str) -> str | None:
    for c in node:
        if _local(c.tag) == name and c.text:
            return c.text.strip()
    return None


def _iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


# GPS elevation is noisy; summing every tiny rise inflates the gain several
# times over. Only climbs that accumulate past this threshold count.
ELEVATION_NOISE_M = 3.0


def parse_gpx(data: bytes, discipline: str | None = None) -> ParseResult:
    try:
        root = ElementTree.fromstring(data)
    except Exception as error:  # defusedxml raises several distinct types
        raise ImportFormatError("That GPX file could not be read.") from error
    if _local(root.tag) != "gpx":
        raise ImportFormatError("That isn't a GPX file.")

    sessions: list[ParsedSession] = []
    problems: list[str] = []
    for index, track in enumerate(_children(root, "trk"), start=1):
        points = []
        for segment in _children(track, "trkseg"):
            for point in _children(segment, "trkpt"):
                when = _text(point, "time")
                try:
                    lat = float(point.get("lat"))
                    lon = float(point.get("lon"))
                    ele = _text(point, "ele")
                    points.append(
                        (lat, lon, float(ele) if ele else None, _iso(when) if when else None)
                    )
                except TypeError, ValueError:
                    continue
        timed = [p for p in points if p[3] is not None]
        if not timed:
            problems.append(f"Track {index} has no timestamps, so it can't be dated.")
            continue

        distance = sum(_haversine(a[:2], b[:2]) for a, b in zip(points, points[1:], strict=False))
        track_points: list[tuple[float, datetime]] = []
        running = 0.0
        for i, p in enumerate(points):
            if i:
                running += _haversine(points[i - 1][:2], p[:2])
            if p[3] is not None:
                track_points.append((running, p[3]))
        climb = pending = 0.0
        elevations = [p[2] for p in points if p[2] is not None]
        for a, b in zip(elevations, elevations[1:], strict=False):
            pending = max(0.0, pending + (b - a))
            if pending >= ELEVATION_NOISE_M:
                climb += pending
                pending = 0.0

        start, end = timed[0][3], timed[-1][3]
        duration = max(0, int((end - start).total_seconds()))
        guess = _guess_from_speed(distance, duration)
        sessions.append(
            ParsedSession(
                started_at=start,
                discipline=discipline or discipline_for(_text(track, "type"), default=guess),
                duration_sec=duration or None,
                distance_m=round(distance, 1) if distance else None,
                elevation_m=round(climb, 1) if elevations else None,
                title=(_text(track, "name") or "")[:80] or None,
                splits=km_splits(track_points),
            )
        )
    if not sessions and not problems:
        problems.append("The file has no tracks.")
    return ParseResult("gpx", sessions, problems)


def _guess_from_speed(distance_m: float, duration_sec: int) -> str:
    """Last resort when a GPX track has no <type>: average speed."""
    if not distance_m or not duration_sec:
        return "other"
    kmh = distance_m / duration_sec * 3.6
    if kmh < 6.5:
        return "walk"
    if kmh < 17:
        return "run"
    return "ride"


# --- FIT ---------------------------------------------------------------------------------


def parse_fit(data: bytes, discipline: str | None = None) -> ParseResult:
    sessions: list[ParsedSession] = []
    problems: list[str] = []
    records: list[tuple[float, datetime]] = []
    try:
        with fitdecode.FitReader(io.BytesIO(data)) as reader:
            for frame in reader:
                if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                    continue
                if frame.name == "record":
                    when = frame.get_value("timestamp", fallback=None)
                    dist = frame.get_value("distance", fallback=None)
                    if isinstance(when, datetime) and dist is not None:
                        records.append(
                            (float(dist), when if when.tzinfo else when.replace(tzinfo=UTC))
                        )
                    continue
                if frame.name != "session":
                    continue
                start = frame.get_value("start_time", fallback=None)
                if not isinstance(start, datetime):
                    problems.append("A session in the file has no start time.")
                    continue
                if start.tzinfo is None:
                    start = start.replace(tzinfo=UTC)
                elapsed = frame.get_value("total_timer_time", fallback=None) or frame.get_value(
                    "total_elapsed_time", fallback=None
                )
                distance = frame.get_value("total_distance", fallback=None)
                ascent = frame.get_value("total_ascent", fallback=None)
                sessions.append(
                    ParsedSession(
                        started_at=start,
                        discipline=discipline
                        or discipline_for(
                            frame.get_value("sub_sport", fallback=None),
                            frame.get_value("sport", fallback=None),
                        ),
                        duration_sec=int(elapsed) if elapsed else None,
                        distance_m=float(distance) if distance else None,
                        elevation_m=float(ascent) if ascent else None,
                        splits=km_splits(
                            [
                                r
                                for r in records
                                if start
                                <= r[1]
                                <= start + timedelta(seconds=float(elapsed or 0) + 60)
                            ]
                        ),
                    )
                )
    except fitdecode.FitError as error:
        if not sessions:
            raise ImportFormatError("That FIT file could not be read.") from error
        problems.append("The file ended early; sessions before that point were read.")
    if not sessions and not problems:
        problems.append("The file has no sessions in it.")
    return ParseResult("fit", sessions, problems)


# --- CSV ---------------------------------------------------------------------------------

CSV_COLUMNS = {
    "date": ("date", "started_at", "start", "start_time", "activity_date", "datetime"),
    "discipline": ("discipline", "type", "activity_type", "sport", "activity"),
    "duration": ("duration", "elapsed_time", "moving_time", "time"),
    "duration_min": ("duration_min", "duration_minutes", "minutes"),
    # A bare "distance" is read as kilometres: that is what the common
    # exports (Strava, most spreadsheets) mean by it. Metres need the
    # explicit column.
    "distance_km": ("distance_km", "km", "distance"),
    "distance_mi": ("distance_mi", "miles"),
    "distance_m": ("distance_m", "metres", "meters"),
    "elevation_m": ("elevation_m", "elevation", "elevation_gain", "ascent"),
    "title": ("title", "name", "activity_name"),
    "notes": ("notes", "description", "comment"),
    "effort": ("effort", "rpe"),
    "feel": ("feel",),
}


def _normalise(header: str) -> str:
    return header.strip().lower().replace(" ", "_").replace("-", "_")


def _pick(row: dict[str, str], field: str) -> str | None:
    for alias in CSV_COLUMNS[field]:
        value = row.get(alias)
        if value is not None and value.strip() != "":
            return value.strip()
    return None


def _number(value: str | None) -> float | None:
    if value is None:
        return None
    return float(value.replace(",", ""))


def _duration(value: str | None) -> int | None:
    """Seconds from "1:02:03", "45:10" or a bare number of seconds."""
    if value is None:
        return None
    if ":" in value:
        parts = [float(p) for p in value.split(":")]
        while len(parts) < 3:
            parts.insert(0, 0.0)
        h, m, s = parts[-3:]
        return int(h * 3600 + m * 60 + s)
    return int(float(value))


def _when(value: str, tz: str) -> datetime:
    zone = ZoneInfo(tz)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        parsed = datetime.combine(date.fromisoformat(value[:10]), time(12))
    if len(value) <= 10:
        # A bare date: midday local, so no timezone can push it onto a
        # neighbouring day.
        parsed = datetime.combine(parsed.date(), time(12))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=zone)


def parse_csv(data: bytes, tz: str, discipline: str | None = None) -> ParseResult:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ImportFormatError("CSV files need to be UTF-8.") from error
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ImportFormatError("That CSV file has no header row.")
    reader.fieldnames = [_normalise(h) for h in reader.fieldnames]
    if not any(a in reader.fieldnames for a in CSV_COLUMNS["date"]):
        raise ImportFormatError("The CSV needs a 'date' column.")

    sessions: list[ParsedSession] = []
    problems: list[str] = []
    for line, row in enumerate(reader, start=2):
        if line - 1 > MAX_SESSIONS:
            raise ImportFormatError(f"One upload can hold at most {MAX_SESSIONS} sessions.")
        try:
            when = _pick(row, "date")
            if when is None:
                raise ValueError("no date")
            duration = _duration(_pick(row, "duration"))
            if duration is None and (minutes := _number(_pick(row, "duration_min"))) is not None:
                duration = int(minutes * 60)
            distance = _number(_pick(row, "distance_m"))
            if (km := _number(_pick(row, "distance_km"))) is not None:
                distance = km * 1000
            if (mi := _number(_pick(row, "distance_mi"))) is not None:
                distance = mi * 1609.344
            effort = _number(_pick(row, "effort"))
            feel = _number(_pick(row, "feel"))
            sessions.append(
                ParsedSession(
                    started_at=_when(when, tz),
                    discipline=discipline or discipline_for(_pick(row, "discipline")),
                    duration_sec=duration,
                    distance_m=distance,
                    elevation_m=_number(_pick(row, "elevation_m")),
                    title=(_pick(row, "title") or "")[:80] or None,
                    notes=(_pick(row, "notes") or "")[:1000] or None,
                    effort=int(effort) if effort is not None and 1 <= effort <= 10 else None,
                    feel=int(feel) if feel is not None and 1 <= feel <= 5 else None,
                )
            )
        except ValueError, KeyError:
            problems.append(f"Row {line} could not be read.")
    return ParseResult("csv", sessions, problems)
