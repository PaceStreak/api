/** Deterministic time for tests. test/setup.ts restores the system clock after each test. */
import { fixedClock, setClock, systemClock } from "../../src/lib/time.ts";

export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0); // Wednesday 2026-10-14 12:00 UTC

/** Every `Ctx` created from now on (including requests through SELF) reads this clock. */
export function useFixedClock(ms: number = T0) {
  const c = fixedClock(ms);
  setClock(c);
  return c;
}

export function useSystemClock(): void {
  setClock(systemClock);
}
