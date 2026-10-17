// Deliberate violations for the check-module-deps self-test. Do not "fix".
import { a } from "../a/service";
import { aRepo } from "../a/repo";

export function bad(env: { DB: unknown }): unknown {
  return [a, aRepo, env.DB];
}
