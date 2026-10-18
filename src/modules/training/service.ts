/**
 * The training module's public surface: the only file another module may import (groups use plans; account
 * export/import and trash restore use the row shapes and the workout write path).
 */

export { hrSummary, kmSplits, zoneSeconds } from "./importers.ts";
export { blockWeek } from "./personal.ts";
export {
  MAX_PLANS,
  matchWeek,
  materialize,
  PLAN_FORMAT,
  planView,
  runOnly,
  shareable,
  summary as planSummary,
  templateShared,
  viewRange,
} from "./plans.ts";
export { buildRacePlan, RacePlanError } from "./race.ts";
export { cleanTags, SharedPlan, type SharedPlanInput } from "./schemas.ts";
export {
  DEFAULT_PROFILE,
  feedVisible,
  groupSets,
  putWorkout,
  setOut,
  workoutOut,
} from "./workouts.ts";
