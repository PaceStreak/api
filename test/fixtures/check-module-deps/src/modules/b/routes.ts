// Deliberate violations for the check-module-deps self-test. Do not "fix".

import { aRepo } from "../a/repo";
import { a } from "../a/service";

export function bad(env: { DB: unknown }): unknown {
  return [a, aRepo, env.DB];
}
