/**
 * Minimal CPU bench harness for workerd (vitest 5 dropped `bench()`; workerd's clock does advance during local
 * tests). `pnpm bench` runs test/bench/*.bench.ts; they are excluded from `pnpm vitest run`.
 *
 * A bench fails when its median per-operation time exceeds `HEADROOM` x its budget (DESIGN.md §15: CI hardware is
 * noisier than Cloudflare's, and staging `wrangler tail` cpuTime is the real gate).
 */
import { expect, it } from "vitest";

export const HEADROOM = 0.6;

export interface BenchOptions {
  /** Per-operation budget in ms (DESIGN.md §17). */
  budgetMs: number;
  /** Operations per sample; raise it for sub-millisecond work. */
  ops?: number;
  samples?: number;
}

export async function measure(
  fn: () => unknown | Promise<unknown>,
  ops: number,
  samples: number,
): Promise<number[]> {
  for (let i = 0; i < Math.min(ops, 50); i++) await fn();
  const perOp: number[] = [];
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now();
    for (let i = 0; i < ops; i++) await fn();
    perOp.push((performance.now() - t0) / ops);
  }
  return perOp.sort((a, b) => a - b);
}

/** Registers a bench as a test: median per-op time must stay within HEADROOM x budget. */
export function benchCase(name: string, fn: () => unknown | Promise<unknown>, opts: BenchOptions): void {
  it(name, async () => {
    const times = await measure(fn, opts.ops ?? 1000, opts.samples ?? 15);
    const median = times[Math.floor(times.length / 2)] ?? Number.POSITIVE_INFINITY;
    console.log(`bench ${name}: median ${median.toFixed(4)} ms/op (budget ${opts.budgetMs} ms)`);
    expect(median, `${name} median ms/op`).toBeLessThanOrEqual(opts.budgetMs * HEADROOM);
  });
}
