/**
 * Race plans (Python app/training/race.py): from this week to race day, then a recovery week. Pure. The long run
 * grows about 10% a week with a lighter week every fourth, one faster session once a base is built, a taper.
 */
import { pyRound } from "../../lib/format.ts";
import { addDays, daysBetween, weekStart } from "../../lib/time.ts";

const EASY = "Easy: you could talk in sentences. Slower is fine.";

interface RaceSpec {
  label: string;
  km: number;
  startLong: number;
  peakLong: number;
  taper: number;
  quality: string;
  minWeeks: number;
}

const RACES: Readonly<Record<string, RaceSpec>> = {
  "5k": {
    label: "5 km",
    km: 5,
    startLong: 25,
    peakLong: 50,
    taper: 1,
    quality: "Intervals: 6 x 2 min a little faster, 2 min easy between",
    minWeeks: 4,
  },
  "10k": {
    label: "10 km",
    km: 10,
    startLong: 35,
    peakLong: 70,
    taper: 1,
    quality: "Intervals: 5 x 4 min comfortably hard, 2 min easy between",
    minWeeks: 5,
  },
  half: {
    label: "half marathon",
    km: 21.1,
    startLong: 50,
    peakLong: 120,
    taper: 2,
    quality: "Tempo: 2 x 12 min comfortably hard, 3 min easy between",
    minWeeks: 8,
  },
  marathon: {
    label: "marathon",
    km: 42.2,
    startLong: 70,
    peakLong: 180,
    taper: 2,
    quality: "Tempo: 3 x 12 min at goal effort, 3 min easy between",
    minWeeks: 12,
  },
};
const MAX_WEEKS = 25;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export class RacePlanError extends Error {}

export type RaceSession = Record<string, string | number>;

const DAYS: Readonly<Record<number, readonly number[]>> = {
  3: [1, 3, 5],
  4: [0, 2, 4, 6],
  5: [0, 1, 3, 4, 6],
};

/** `[first week's start, weeks, name]`. The race sits in the second-last week on its own weekday. */
export function buildRacePlan(
  race: string,
  raceDate: string,
  today: string,
  weekStartsOn: number,
  perWeek: number,
): [string, RaceSession[][], string] {
  const spec = RACES[race];
  if (spec === undefined) throw new RacePlanError("Choose 5 km, 10 km, half marathon or marathon");
  const days = DAYS[perWeek];
  if (days === undefined) throw new RacePlanError("Three, four or five runs a week");
  let first = weekStart(today, weekStartsOn);
  const raceWeek = weekStart(raceDate, weekStartsOn);
  if (raceDate <= today) throw new RacePlanError("The race has to be in the future");
  let weeksToRace = Math.floor(daysBetween(first, raceWeek) / 7) + 1;
  if (weeksToRace < spec.minWeeks)
    throw new RacePlanError(
      `A ${spec.label} plan needs at least ${spec.minWeeks} weeks; that race is sooner`,
    );
  if (weeksToRace > MAX_WEEKS) {
    first = addDays(raceWeek, -7 * (MAX_WEEKS - 1));
    weeksToRace = MAX_WEEKS;
  }
  const withDays = (sessions: RaceSession[]) => sessions.map((s, i) => ({ day: days[i] as number, ...s }));
  const easyRun = (easy: number): RaceSession => ({
    discipline: "run",
    title: `Easy run, ${easy} min`,
    minutes: easy,
    note: EASY,
  });

  const buildWeeks = weeksToRace - spec.taper - 1;
  const baseWeeks = Math.max(1, pyRound(buildWeeks * 0.45));
  const weeks: RaceSession[][] = [];
  let longMin = spec.startLong;
  let peak = spec.startLong;
  for (let i = 0; i < buildWeeks; i++) {
    const cutback = (i + 1) % 4 === 0;
    const longNow = pyRound(longMin * (cutback ? 0.8 : 1));
    peak = Math.max(peak, longNow);
    const easy = Math.max(20, Math.min(60, pyRound(longNow * 0.55)));
    const sessions = days.slice(0, -1).map(() => easyRun(easy));
    if (i >= baseWeeks && !cutback && sessions.length >= 2) {
      sessions[1] = {
        discipline: "run",
        title: spec.quality.slice(0, 80),
        minutes: easy + 10,
        note: "10 min easy to warm up and cool down. Hard, not all out.",
      };
    }
    sessions.push({
      discipline: "run",
      title: `Long run, ${longNow} min${cutback ? " (lighter week)" : ""}`,
      minutes: longNow,
      note: EASY,
    });
    weeks.push(withDays(sessions));
    if (!cutback && (i + 2) % 4 !== 0) longMin = Math.min(spec.peakLong, longMin * 1.1);
  }
  for (let t = 0; t < spec.taper; t++) {
    const share = t === 0 && spec.taper === 2 ? 0.7 : 0.55;
    const longNow = pyRound(peak * share);
    const easy = Math.max(20, pyRound(longNow * 0.5));
    weeks.push(
      withDays([
        ...days.slice(0, -1).map(() => easyRun(easy)),
        {
          discipline: "run",
          title: `Long run, ${longNow} min`,
          minutes: longNow,
          note: "Tapering: less running so you arrive fresh. Resist adding more.",
        },
      ]),
    );
  }
  const raceDay = daysBetween(raceWeek, raceDate);
  const raceSessions: RaceSession[] = days
    .filter((d) => d < raceDay - 1)
    .slice(0, 2)
    .map((d) => ({
      day: d,
      discipline: "run",
      title: "Easy run, 20 min",
      minutes: 20,
      note: "A few relaxed strides at the end. Save the legs.",
    }));
  raceSessions.push({
    day: raceDay,
    discipline: "run",
    title: `Race day: ${spec.label}`,
    distance_km: spec.km,
    note: "Start slower than feels right. Enjoy it.",
  });
  weeks.push(raceSessions);
  weeks.push([
    {
      day: days[1] as number,
      discipline: "walk",
      title: "Recovery walk, 30 min",
      minutes: 30,
      note: "Moving helps sore legs recover. No running needed yet.",
    },
    {
      day: days[days.length - 1] as number,
      discipline: "run",
      title: "Easy run, 20 min",
      minutes: 20,
      note: "Only if everything feels fine. Otherwise walk, or rest.",
    },
  ]);
  const name = `${spec.label[0]?.toUpperCase()}${spec.label.slice(1)} on ${Number(raceDate.slice(8, 10))} ${MONTHS[Number(raceDate.slice(5, 7)) - 1]}`;
  return [first, weeks, name];
}
