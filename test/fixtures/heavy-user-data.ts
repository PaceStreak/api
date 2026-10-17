/**
 * Deterministic data for the "heavy user" (DESIGN.md §15): about 5 years of history, 3,000 workouts, 30,000 sets,
 * 20 habits and 2,000 habit logs by default. Pure (no I/O), so both the D1 test seeder and
 * scripts/seed-heavy.ts (SQL for `wrangler d1 execute --local`) use it.
 */
export interface HeavyOptions {
  userId: string;
  seed?: number;
  /** Last day of history, `YYYY-MM-DD`. */
  until?: string;
  years?: number;
  workouts?: number;
  /** Sets per strength workout; about 60% of workouts are strength. */
  setsPerStrength?: number;
  habits?: number;
  habitLogs?: number;
}

export type Row = Record<string, string | number | null>;

export interface HeavyData {
  users: Row[];
  profiles: Row[];
  workouts: Row[];
  workout_sets: Row[];
  habits: Row[];
  habit_logs: Row[];
  /** Highest `seq` used; seed `sync_seq` with it. */
  maxSeq: number;
}

/** mulberry32: small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const EXERCISES = [
  "back_squat",
  "bench_press",
  "deadlift",
  "overhead_press",
  "barbell_row",
  "pull_up",
  "dip",
  "lunge",
];
const CARDIO = ["run", "ride", "swim", "walk", "row"];

/** Deterministic UUIDv7-shaped ids, ordered by `ms` then `n`. */
function idFor(ms: number, n: number, salt: number): string {
  const h = ms.toString(16).padStart(12, "0");
  const c = n.toString(16).padStart(8, "0");
  const s = salt.toString(16).padStart(4, "0").slice(-4);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${c.slice(0, 3)}-8${s.slice(0, 3)}-${c.slice(3)}${s}${"000"}`.slice(
    0,
    36,
  );
}

export function heavyUserData(o: HeavyOptions): HeavyData {
  const rnd = prng(o.seed ?? 42);
  const until = Date.parse(`${o.until ?? "2026-10-14"}T00:00:00Z`);
  const days = Math.round((o.years ?? 5) * 365);
  const from = until - days * DAY;
  const nWorkouts = o.workouts ?? 3000;
  const setsPer = o.setsPerStrength ?? 17;
  const created = from - DAY;

  const users: Row[] = [
    {
      id: o.userId,
      created_at: created,
      updated_at: created,
      email: `heavy-${o.userId.slice(-12)}@example.com`,
      hashed_password: "pbkdf2-sha256$v=1$i=1$placeholder$placeholder",
      role: "user",
      is_active: 1,
      token_version: 0,
      is_verified: 1,
      totp_enabled: 0,
    },
  ];
  const profiles: Row[] = [
    {
      id: idFor(created, 0, 1),
      created_at: created,
      updated_at: created,
      user_id: o.userId,
      timezone: "Asia/Kolkata",
      onboarded_at: created,
      accepted_terms_at: created,
      favourite_disciplines: "[]",
    },
  ];

  const workouts: Row[] = [];
  const sets: Row[] = [];
  let seq = 0;
  for (let i = 0; i < nWorkouts; i++) {
    const startedAt = from + Math.floor((i / nWorkouts) * days * DAY) + Math.floor(rnd() * 12 * 3_600_000);
    const strength = rnd() < 0.6;
    const id = idFor(startedAt, i, 2);
    seq++;
    workouts.push({
      id,
      created_at: startedAt,
      updated_at: startedAt,
      user_id: o.userId,
      discipline: strength ? "strength" : (CARDIO[Math.floor(rnd() * CARDIO.length)] ?? "run"),
      title: null,
      started_at: startedAt,
      local_date: new Date(startedAt + 5.5 * 3_600_000).toISOString().slice(0, 10),
      duration_sec: 1800 + Math.floor(rnd() * 3600),
      distance_m: strength ? null : Math.round(2000 + rnd() * 20000),
      effort: 1 + Math.floor(rnd() * 10),
      hr_zones: "[]",
      tags: "[]",
      splits: "[]",
      source: "app",
      client_updated_at: startedAt,
      seq,
    });
    if (strength) {
      for (let s = 0; s < setsPer; s++) {
        sets.push({
          id: idFor(startedAt, i * 100 + s, 3),
          created_at: startedAt,
          updated_at: startedAt,
          workout_id: id,
          user_id: o.userId,
          exercise_id: EXERCISES[Math.floor(s / 4) % EXERCISES.length] ?? "back_squat",
          position: Math.floor(s / 4),
          set_index: s % 4,
          kind: s % 4 === 0 ? "warmup" : "work",
          weight_kg: Math.round((40 + rnd() * 100) * 2) / 2,
          reps: 3 + Math.floor(rnd() * 10),
          completed: 1,
        });
      }
    }
  }

  const habits: Row[] = [];
  const logs: Row[] = [];
  const nHabits = o.habits ?? 20;
  const nLogs = o.habitLogs ?? 2000;
  for (let h = 0; h < nHabits; h++) {
    const name = `Habit ${h + 1}`;
    habits.push({
      id: idFor(created, h, 4),
      created_at: created,
      updated_at: created,
      user_id: o.userId,
      name,
      name_fold: name.toLowerCase(),
      kind: h % 4 === 3 ? "quit" : "check",
      weekly_target: 1 + (h % 7),
      started_on: new Date(from).toISOString().slice(0, 10),
      position: h,
    });
  }
  const perHabit = Math.ceil(nLogs / Math.max(nHabits, 1));
  for (let h = 0; h < nHabits && logs.length < nLogs; h++) {
    for (let k = 0; k < perHabit && logs.length < nLogs; k++) {
      const day = new Date(until - k * DAY * Math.max(1, Math.floor(days / perHabit)))
        .toISOString()
        .slice(0, 10);
      logs.push({
        id: idFor(until - k * DAY, h * 10_000 + k, 5),
        created_at: until,
        updated_at: until,
        habit_id: habits[h]?.id ?? "",
        user_id: o.userId,
        day,
        amount: 1,
      });
    }
  }
  return { users, profiles, workouts, workout_sets: sets, habits, habit_logs: logs, maxSeq: seq };
}

/** D1 binds at most 100 parameters per statement: rows per multi-row INSERT for a row width. */
export function rowsPerInsert(columns: number): number {
  return Math.max(1, Math.floor(100 / columns));
}

/** Multi-row INSERT statements (sql + params) for `rows`, each within D1's 100-parameter limit. */
export function insertStatements(
  table: string,
  rows: readonly Row[],
): { sql: string; params: (string | number | null)[] }[] {
  const first = rows[0];
  if (first === undefined) return [];
  const cols = Object.keys(first);
  const per = rowsPerInsert(cols.length);
  const out: { sql: string; params: (string | number | null)[] }[] = [];
  const tuple = `(${cols.map(() => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push({
      sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${chunk.map(() => tuple).join(", ")}`,
      params: chunk.flatMap((r) => cols.map((c) => r[c] ?? null)),
    });
  }
  return out;
}

export const HEAVY_TABLE_ORDER = [
  "users",
  "profiles",
  "workouts",
  "workout_sets",
  "habits",
  "habit_logs",
] as const;
