import fc from "fast-check";

export const enc = (text: string) => new TextEncoder().encode(text);

type Resumable<S, T> = { state: S; push(chunk: Uint8Array): T[]; end(): T[] };

/**
 * Feeds `bytes` cut at `cuts`, saving the state as JSON and building a fresh reader for every slice,
 * exactly as the import-slice queue consumer does between invocations.
 */
export function feedSliced<S, T>(
  bytes: Uint8Array,
  cuts: readonly number[],
  make: (state?: S) => Resumable<S, T>,
): { out: T[]; state: S } {
  const points = [...new Set(cuts)].filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b);
  let state: S | undefined;
  const out: T[] = [];
  let from = 0;
  for (const to of [...points, bytes.length]) {
    const reader = make(state);
    out.push(...reader.push(bytes.subarray(from, to)));
    state = JSON.parse(JSON.stringify(reader.state)) as S;
    from = to;
  }
  const last = make(state);
  out.push(...last.end());
  return { out, state: last.state };
}

/** Arbitrary cut points for a file of `length` bytes, including every-byte slicing now and then. */
export const cutsFor = (length: number) =>
  fc.oneof(
    { weight: 5, arbitrary: fc.array(fc.integer({ min: 0, max: length }), { maxLength: 12 }) },
    { weight: 1, arbitrary: fc.constant(Array.from({ length }, (_, i) => i)) },
  );

export async function streamOf(
  bytes: Uint8Array,
  cuts: readonly number[] = [],
): Promise<ReadableStream<Uint8Array>> {
  const points = [...new Set(cuts)].filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b);
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const to of [...points, bytes.length]) {
    parts.push(bytes.slice(from, to));
    from = to;
  }
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const next = parts.shift();
      if (next) c.enqueue(next);
      else c.close();
    },
  });
}
