import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, enumCheck, json, ms, nullableCheck } from "./columns.ts";

export const journalDays = sqliteTable(
  "journal_days",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text().notNull(),
    mood: integer(),
    note: text(),
    noteFold: text(),
  },
  (t) => [
    unique("uq_journal_day").on(t.userId, t.day),
    nullableCheck("ck_journal_mood", t.mood, sql`${t.mood} BETWEEN 1 AND 5`),
  ],
);

export const TRASH_KINDS = [
  "habit",
  "meal",
  "food",
  "recipe",
  "journal",
  "habit_routine",
  "workout",
] as const;
export type TrashPayload = {
  row?: Record<string, unknown>;
  children?: Record<string, Record<string, unknown>[]>;
};

export const trashItems = sqliteTable(
  "trash_items",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text({ enum: TRASH_KINDS }).notNull(),
    /** Not a foreign key: the row it names is gone until restored. */
    itemId: text().notNull(),
    label: text().notNull(),
    payload: json<TrashPayload>().notNull(),
    deletedAt: ms().notNull(),
    purgeAfter: ms().notNull(),
  },
  (t) => [
    index("ix_trash_user_deleted").on(t.userId, t.deletedAt),
    index("ix_trash_purge_after").on(t.purgeAfter),
    enumCheck("ck_trash_kind", t.kind, TRASH_KINDS),
  ],
);

/**
 * The global workout sync cursor (spec/schema.md §2.1), one row `id = 1`. Self-seeding:
 * `INSERT INTO sync_seq (id, value) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET value = value + 1`, then the
 * workout write in the same batch reads `(SELECT value FROM sync_seq WHERE id = 1)`.
 */
export const syncSeq = sqliteTable(
  "sync_seq",
  {
    id: integer().primaryKey(),
    value: integer().notNull(),
  },
  (t) => [check("ck_sync_seq_single_row", sql`${t.id} = 1`)],
);
