/** The golden endpoints: what the app reads on every screen, plus the writes whose answers it renders. */
import * as z from "zod";
import * as s from "./schemas.ts";
import type { Seeded } from "./seed.ts";

export interface Endpoint {
  name: string;
  request: (seed: Seeded) => {
    path: string;
    method?: string;
    json?: unknown;
    status?: number;
    as?: "me" | "other";
  };
  schema: z.ZodType;
}

const get =
  (path: string | ((seed: Seeded) => string)) =>
  (seed: Seeded): { path: string } => ({ path: typeof path === "string" ? path : path(seed) });

const iso = (ms: number) => new Date(ms).toISOString();

export const endpoints: Endpoint[] = [
  { name: "GET /me", request: get("/v1/me"), schema: s.Me },
  { name: "GET /me/stats", request: get("/v1/me/stats"), schema: s.Stats },
  { name: "GET /library", request: get("/v1/library"), schema: s.Library },
  { name: "GET /exercises/custom", request: get("/v1/exercises/custom"), schema: z.array(s.Exercise) },
  { name: "GET /workouts/changes", request: get("/v1/workouts/changes?since=0"), schema: s.Changes },
  {
    name: "POST /workouts/batch",
    request: (seed) => ({
      path: "/v1/workouts/batch",
      json: {
        ops: [
          {
            op: "put",
            id: crypto.randomUUID(),
            client_updated_at: iso(Date.now()),
            workout: {
              discipline: "run",
              started_at: iso(Date.now() - 3_600_000),
              client_updated_at: iso(Date.now()),
              duration_sec: 1500,
              distance_m: 4000,
            },
          },
          { op: "delete", id: seed.ids.workout, client_updated_at: iso(Date.now() + 1000) },
        ],
      },
    }),
    schema: s.BatchResult,
  },
  { name: "GET /chains", request: get("/v1/chains"), schema: s.Chains },
  { name: "GET /pauses", request: get("/v1/pauses"), schema: s.PauseState },
  { name: "GET /me/recap", request: get(() => `/v1/me/recap?week=${mondayOf(new Date())}`), schema: s.Recap },
  { name: "GET /me/recap/month", request: get("/v1/me/recap/month"), schema: s.MonthRecap },
  { name: "GET /me/achievements", request: get("/v1/me/achievements"), schema: s.Achievements },
  { name: "GET /me/records", request: get("/v1/me/records"), schema: s.Records },
  { name: "GET /habits", request: get("/v1/habits"), schema: z.array(s.HabitListRow) },
  { name: "GET /habits/{id}", request: get((x) => `/v1/habits/${x.ids.habit}`), schema: s.HabitDetail },
  {
    name: "GET /habits/{id}/stats",
    request: get((x) => `/v1/habits/${x.ids.habit}/stats`),
    schema: s.HabitStats,
  },
  { name: "GET /habits/catalog", request: get("/v1/habits/catalog"), schema: s.HabitCatalog },
  {
    name: "POST /habits",
    request: () => ({
      path: "/v1/habits",
      json: { name: "Read", kind: "duration", unit: "min" },
      status: 201,
    }),
    schema: s.HabitCreated,
  },
  { name: "GET /habit-routines", request: get("/v1/habit-routines"), schema: z.array(s.HabitRoutine) },
  { name: "GET /gyms", request: get("/v1/gyms"), schema: z.array(s.Gym) },
  { name: "GET /gear", request: get("/v1/gear"), schema: z.array(s.Gear) },
  { name: "GET /routines", request: get("/v1/routines"), schema: z.array(s.Routine) },
  { name: "GET /plans", request: get("/v1/plans"), schema: z.array(s.PlanSummary) },
  { name: "GET /plans/{id}", request: get((x) => `/v1/plans/${x.ids.plan}`), schema: s.Plan },
  { name: "GET /plans/templates", request: get("/v1/plans/templates"), schema: z.array(s.PlanTemplate) },
  { name: "GET /weigh-ins", request: get("/v1/weigh-ins"), schema: z.array(s.WeighIn) },
  { name: "GET /body-metrics", request: get("/v1/body-metrics"), schema: z.array(s.BodyMetric) },
  { name: "GET /weight-goal", request: get("/v1/weight-goal"), schema: s.WeightGoal },
  { name: "GET /readiness", request: get("/v1/readiness"), schema: z.array(s.Readiness) },
  {
    name: "PUT /reflections/{week}",
    request: () => ({
      path: `/v1/reflections/${mondayOf(new Date())}`,
      method: "PUT",
      json: { went_well: "Slept", change: null },
    }),
    schema: s.Reflection,
  },
  {
    name: "GET /nutrition/days/{date}",
    request: get((x) => `/v1/nutrition/days/${x.today}`),
    schema: s.NutritionDay,
  },
  { name: "GET /nutrition/foods", request: get("/v1/nutrition/foods"), schema: z.array(s.Food) },
  { name: "GET /nutrition/recipes", request: get("/v1/nutrition/recipes"), schema: z.array(s.Recipe) },
  { name: "GET /nutrition/recent", request: get("/v1/nutrition/recent"), schema: z.array(s.RecentFood) },
  {
    name: "GET /nutrition/history",
    request: get("/v1/nutrition/history?days=30"),
    schema: s.NutritionHistory,
  },
  { name: "GET /nutrition/expenditure", request: get("/v1/nutrition/expenditure"), schema: s.Expenditure },
  { name: "GET /coach/today", request: get("/v1/coach/today"), schema: s.CoachToday },
  { name: "GET /journal", request: get("/v1/journal"), schema: z.array(s.JournalDay) },
  { name: "GET /insights", request: get("/v1/insights"), schema: s.Insights },
  { name: "GET /search", request: get("/v1/search?q=stre"), schema: s.Search },
  { name: "GET /day/{date}", request: get((x) => `/v1/day/${x.today}`), schema: s.DayView },
  { name: "GET /notifications", request: get("/v1/notifications"), schema: s.Notifications },
  { name: "GET /feed", request: get("/v1/feed"), schema: s.FeedPage },
  { name: "GET /events/{id}", request: get((x) => `/v1/events/${x.ids.event}`), schema: s.FeedEvent },
  {
    name: "GET /people/search",
    request: get((x) => `/v1/people/search?q=${x.otherHandle.slice(0, 4)}`),
    schema: z.array(s.Person),
  },
  { name: "GET /groups", request: get("/v1/groups"), schema: z.array(s.GroupRow) },
  { name: "GET /groups/{id}", request: get((x) => `/v1/groups/${x.ids.group}`), schema: s.Group },
  { name: "GET /challenges", request: get("/v1/challenges"), schema: z.array(s.ChallengeRow) },
  {
    name: "GET /challenges/{id}",
    request: get((x) => `/v1/challenges/${x.ids.challenge}`),
    schema: s.Challenge,
  },
  { name: "GET /trash", request: get("/v1/trash"), schema: z.array(s.TrashItem) },
];

function mondayOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString()
    .slice(0, 10);
}
