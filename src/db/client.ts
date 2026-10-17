/**
 * The typed D1 client every module uses (`ctx.db`), wrapped so each request knows how many D1 round trips and
 * statements it spent. The counts feed the per-request log line and the round-trip budget assertions in tests.
 */
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema/index.ts";

export type Schema = typeof schema;
export type Db = DrizzleD1Database<Schema> & { $client: D1Database };

export interface DbStats {
  /** Calls that crossed to D1: one per `batch`, one per single statement. */
  roundTrips: number;
  /** SQL statements executed, summed over all round trips. */
  statements: number;
}

export const newStats = (): DbStats => ({ roundTrips: 0, statements: 0 });

class CountingStatement implements D1PreparedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    private readonly stats: DbStats,
  ) {}

  private tick(): void {
    this.stats.roundTrips++;
    this.stats.statements++;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new CountingStatement(this.inner.bind(...values), this.stats);
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T>(colName?: string): Promise<T | null> {
    this.tick();
    return colName === undefined ? this.inner.first<T>() : this.inner.first<T>(colName);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.tick();
    return this.inner.run<T>();
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.tick();
    return this.inner.all<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
    this.tick();
    return options?.columnNames === true ? this.inner.raw<T>({ columnNames: true }) : this.inner.raw<T>();
  }
}

/** A D1 binding that counts. Read replication (sessions) is deliberately not used (DESIGN.md §17). */
class CountingD1 implements D1Database {
  constructor(
    private readonly d1: D1Database,
    private readonly stats: DbStats,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new CountingStatement(this.d1.prepare(query), this.stats);
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.stats.roundTrips++;
    this.stats.statements += statements.length;
    return this.d1.batch<T>(statements.map((s) => (s instanceof CountingStatement ? s.inner : s)));
  }

  exec(query: string): Promise<D1ExecResult> {
    this.stats.roundTrips++;
    this.stats.statements++;
    return this.d1.exec(query);
  }

  withSession(): D1DatabaseSession {
    throw new Error("D1 sessions are not used: they would weaken read-your-writes after a logout");
  }

  dump(): Promise<ArrayBuffer> {
    return this.d1.dump();
  }
}

export function createDb(d1: D1Database, stats: DbStats): Db {
  return drizzle(new CountingD1(d1, stats), { schema, casing: "snake_case" });
}
