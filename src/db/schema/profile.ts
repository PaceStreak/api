import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, bool, enumCheck, json, maxLength, ms } from "./columns.ts";

export const VISIBILITIES = ["private", "followers", "public"] as const;
export const WEIGHT_UNITS = ["kg", "lb"] as const;
export const DISTANCE_UNITS = ["km", "mi"] as const;
export const REMINDER_MODES = ["fixed", "smart"] as const;

export const profiles = sqliteTable(
  "profiles",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    handle: text(),
    handleFold: text(),
    displayName: text(),
    displayNameFold: text(),
    isOfficial: bool().notNull().default(false),
    calendarTokenHash: text(),
    calendarTokenCreatedAt: ms(),
    bio: text(),
    avatarHue: integer().notNull().default(78),
    /** IANA zone name, validated on input. */
    timezone: text().notNull().default("UTC"),
    /** 0 = Monday. */
    weekStartsOn: integer().notNull().default(0),
    weightUnit: text({ enum: WEIGHT_UNITS }).notNull().default("kg"),
    distanceUnit: text({ enum: DISTANCE_UNITS }).notNull().default("km"),
    /** Bitmask, bit 0 = Monday. */
    trainingDays: integer(),
    maxHr: integer(),
    lifeTarget: integer(),
    favouriteDisciplines: json<string[]>().notNull().default([]),
    birthYear: integer(),
    acceptedTermsAt: ms(),
    acceptedTermsVersion: text(),
    onboardedAt: ms(),
    visibility: text({ enum: VISIBILITIES }).notNull().default("followers"),
    sharingPaused: bool().notNull().default(false),
    gamificationEnabled: bool().notNull().default(true),
    leaderboardOptIn: bool().notNull().default(false),
    socialSuspendedAt: ms(),
    deletionScheduledAt: ms(),
    reminderHour: integer().notNull().default(18),
    reminderMode: text({ enum: REMINDER_MODES }).notNull().default("fixed"),
    learnedReminderHour: integer(),
    quietStart: integer().notNull().default(22),
    quietEnd: integer().notNull().default(7),
    /** Bitmask, bit 0 = Monday. */
    quietDays: integer(),
  },
  (t) => [
    uniqueIndex("ix_profiles_user_id").on(t.userId),
    uniqueIndex("ix_profiles_handle").on(t.handle),
    index("ix_profiles_handle_fold").on(t.handleFold),
    index("ix_profiles_display_name_fold").on(t.displayNameFold),
    uniqueIndex("uq_profiles_calendar_token_hash").on(t.calendarTokenHash),
    index("ix_profiles_timezone").on(t.timezone),
    index("ix_profiles_deletion_scheduled_at")
      .on(t.deletionScheduledAt)
      .where(sql`${t.deletionScheduledAt} IS NOT NULL`),
    check("ck_profiles_week_starts_on", sql`${t.weekStartsOn} BETWEEN 0 AND 6`),
    check("ck_profiles_reminder_hour", sql`${t.reminderHour} BETWEEN 0 AND 23`),
    enumCheck("ck_profiles_weight_unit", t.weightUnit, WEIGHT_UNITS),
    enumCheck("ck_profiles_distance_unit", t.distanceUnit, DISTANCE_UNITS),
    enumCheck("ck_profiles_visibility", t.visibility, VISIBILITIES),
    enumCheck("ck_profiles_reminder_mode", t.reminderMode, REMINDER_MODES),
    maxLength("ck_profiles_handle_len", t.handle, 30),
  ],
);
