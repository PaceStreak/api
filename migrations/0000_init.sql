CREATE TABLE `one_time_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`code_hmac` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_one_time_tokens_purpose" CHECK("one_time_tokens"."purpose" IN ('email_verify', 'password_reset', 'email_change'))
);
--> statement-breakpoint
CREATE INDEX `ix_one_time_tokens_user_purpose` ON `one_time_tokens` (`user_id`,`purpose`,`created_at`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_passkeys_sign_count" CHECK("passkeys"."sign_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_passkeys_credential_id` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `ix_passkeys_user_id` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`code_hmac` text NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_recovery_codes_user_code` ON `recovery_codes` (`user_id`,`code_hmac`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`replaced_by` text,
	`used_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ix_refresh_tokens_token_hash` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_refresh_tokens_session_id` ON `refresh_tokens` (`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_sessions_user_id` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_sessions_expires_at` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`email` text NOT NULL,
	`hashed_password` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`token_version` integer DEFAULT 0 NOT NULL,
	`is_verified` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	`password_changed_at` integer,
	`pending_email` text,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`totp_confirmed_at` integer,
	`totp_last_used_step` integer,
	CONSTRAINT "ck_users_role" CHECK("users"."role" IN ('admin', 'moderator', 'user')),
	CONSTRAINT "ck_users_email_len" CHECK(length("users"."email") <= 320),
	CONSTRAINT "ck_users_pending_email_len" CHECK(length("users"."pending_email") <= 320)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ix_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`challenge` text NOT NULL,
	`user_id` text,
	`purpose` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webauthn_challenges_challenge` ON `webauthn_challenges` (`challenge`);--> statement-breakpoint
CREATE INDEX `ix_webauthn_challenges_user_id` ON `webauthn_challenges` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_webauthn_challenges_expires_at` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `personal_records` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` real NOT NULL,
	`previous` real,
	`gain_pct` real,
	`achieved_on` text NOT NULL,
	`workout_id` text,
	`flagged` integer DEFAULT false NOT NULL,
	`rewarded` integer DEFAULT false NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_personal_records_user_key` ON `personal_records` (`user_id`,`key`);--> statement-breakpoint
CREATE TABLE `records_best` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` real NOT NULL,
	`achieved_on` text NOT NULL,
	`workout_id` text,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stat_days` (
	`user_id` text NOT NULL,
	`chain_id` text NOT NULL,
	`local_date` text NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`detailed` integer DEFAULT 0 NOT NULL,
	`minutes` real DEFAULT 0 NOT NULL,
	`distance_m` real DEFAULT 0 NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `chain_id`, `local_date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stat_weeks` (
	`user_id` text NOT NULL,
	`chain_id` text NOT NULL,
	`week_start` text NOT NULL,
	`days_mask` integer DEFAULT 0 NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`detailed` integer DEFAULT 0 NOT NULL,
	`minutes` real DEFAULT 0 NOT NULL,
	`distance_m` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `chain_id`, `week_start`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `streak_wagers` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`days` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_streak_wager_week` ON `streak_wagers` (`user_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `user_achievements` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`achievement_id` text NOT NULL,
	`tier` text,
	`unlocked_on` text NOT NULL,
	`evidence` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_user_achievements_achievement` ON `user_achievements` (`achievement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_achievement_single` ON `user_achievements` (`user_id`,`achievement_id`) WHERE "user_achievements"."tier" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_achievement_tier` ON `user_achievements` (`user_id`,`achievement_id`,`tier`);--> statement-breakpoint
CREATE TABLE `user_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	`computed_for` text NOT NULL,
	`total_xp` integer DEFAULT 0 NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`season_id` text NOT NULL,
	`season_xp` integer DEFAULT 0 NOT NULL,
	`current_streak` integer DEFAULT 0 NOT NULL,
	`longest_streak` integer DEFAULT 0 NOT NULL,
	`consistency` integer DEFAULT 0 NOT NULL,
	`this_week_days` integer DEFAULT 0 NOT NULL,
	`this_week_target` integer DEFAULT 3 NOT NULL,
	`weekly_days4w` real DEFAULT 0 NOT NULL,
	`life_streak` integer DEFAULT 0 NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`active_days` integer DEFAULT 0 NOT NULL,
	`season_prs` integer DEFAULT 0 NOT NULL,
	`total_prs` integer DEFAULT 0 NOT NULL,
	`last_active` text,
	`recent_weeks` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ix_user_stats_user_id` ON `user_stats` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_user_stats_season_xp` ON `user_stats` (`season_id`,`season_xp`);--> statement-breakpoint
CREATE INDEX `ix_user_stats_computed_at` ON `user_stats` (`computed_at`);--> statement-breakpoint
CREATE TABLE `challenge_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`challenge_id` text NOT NULL,
	`user_id` text NOT NULL,
	`final_score` integer,
	`final_rank` integer,
	`completed` integer DEFAULT false NOT NULL,
	`left_at` integer,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_challenge_participants_user_id` ON `challenge_participants` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_challenge_participant` ON `challenge_participants` (`challenge_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'active_days' NOT NULL,
	`target` integer,
	`disciplines` text DEFAULT '[]' NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`creator_id` text NOT NULL,
	`group_id` text,
	`invite_code` text NOT NULL,
	`resolved_at` integer,
	`hidden_at` integer,
	`plan` text,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_challenge_kind" CHECK("challenges"."kind" IN ('active_days', 'weekly_target', 'plan_sessions')),
	CONSTRAINT "ck_challenge_range" CHECK("challenges"."ends_on" >= "challenges"."starts_on"),
	CONSTRAINT "ck_challenges_title_len" CHECK(length("challenges"."title") <= 60)
);
--> statement-breakpoint
CREATE INDEX `ix_challenges_creator_id` ON `challenges` (`creator_id`);--> statement-breakpoint
CREATE INDEX `ix_challenges_group_id` ON `challenges` (`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ix_challenges_invite_code` ON `challenges` (`invite_code`);--> statement-breakpoint
CREATE INDEX `ix_challenges_unresolved` ON `challenges` (`ends_on`) WHERE "challenges"."resolved_at" IS NULL;--> statement-breakpoint
CREATE TABLE `group_announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`group_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_group_announcements_body_len" CHECK(length("group_announcements"."body") <= 500)
);
--> statement-breakpoint
CREATE INDEX `ix_group_announcements_group` ON `group_announcements` (`group_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_group_announcements_author_id` ON `group_announcements` (`author_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`shares_with_coach` integer DEFAULT false NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_group_member_role" CHECK("group_members"."role" IN ('owner', 'admin', 'coach', 'member'))
);
--> statement-breakpoint
CREATE INDEX `ix_group_members_user_id` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_group_member` ON `group_members` (`group_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name` text NOT NULL,
	`name_fold` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'crew' NOT NULL,
	`owner_id` text NOT NULL,
	`invite_code` text NOT NULL,
	`avatar_hue` integer DEFAULT 200 NOT NULL,
	`hidden_at` integer,
	`streak_threshold` integer DEFAULT 75 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_group_kind" CHECK("groups"."kind" IN ('crew', 'coaching'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ix_groups_invite_code` ON `groups` (`invite_code`);--> statement-breakpoint
CREATE INDEX `ix_groups_owner_id` ON `groups` (`owner_id`);--> statement-breakpoint
CREATE INDEX `ix_groups_name_fold` ON `groups` (`name_fold`);--> statement-breakpoint
CREATE TABLE `habit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`habit_id` text NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`amount` real NOT NULL,
	`note` text,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_habit_logs_user_day` ON `habit_logs` (`user_id`,`day`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_habit_log_day` ON `habit_logs` (`habit_id`,`day`);--> statement-breakpoint
CREATE TABLE `habit_routines` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`emoji` text DEFAULT '🌅' NOT NULL,
	`time_of_day` text DEFAULT 'morning' NOT NULL,
	`habit_ids` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_habit_routine_time" CHECK("habit_routines"."time_of_day" IN ('morning', 'afternoon', 'evening', 'anytime'))
);
--> statement-breakpoint
CREATE INDEX `ix_habit_routines_user_id` ON `habit_routines` (`user_id`);--> statement-breakpoint
CREATE TABLE `habits` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_fold` text NOT NULL,
	`emoji` text DEFAULT '✨' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`kind` text DEFAULT 'check' NOT NULL,
	`unit` text,
	`daily_goal` real,
	`weekly_target` integer DEFAULT 7 NOT NULL,
	`time_of_day` text DEFAULT 'anytime' NOT NULL,
	`cue` text,
	`why` text,
	`total_goal` real,
	`remind_hour` integer,
	`template_id` text,
	`started_on` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`snoozed_until` integer,
	`days_mask` integer,
	`paused_from` text,
	`paused_until` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_habit_kind" CHECK("habits"."kind" IN ('check', 'duration', 'count', 'quit')),
	CONSTRAINT "ck_habit_weekly_target" CHECK("habits"."weekly_target" BETWEEN 1 AND 7),
	CONSTRAINT "ck_habit_remind_hour" CHECK("habits"."remind_hour" IS NULL OR "habits"."remind_hour" BETWEEN 0 AND 23)
);
--> statement-breakpoint
CREATE INDEX `ix_habits_user_name` ON `habits` (`user_id`,`name_fold`);--> statement-breakpoint
CREATE INDEX `ix_habits_remind_hour` ON `habits` (`remind_hour`) WHERE "habits"."remind_hour" IS NOT NULL AND "habits"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `ix_habits_snoozed_until` ON `habits` (`snoozed_until`) WHERE "habits"."snoozed_until" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `journal_days` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`mood` integer,
	`note` text,
	`note_fold` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_journal_mood" CHECK("journal_days"."mood" IS NULL OR "journal_days"."mood" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_day` ON `journal_days` (`user_id`,`day`);--> statement-breakpoint
CREATE TABLE `sync_seq` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	CONSTRAINT "ck_sync_seq_single_row" CHECK("sync_seq"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `trash_items` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`label` text NOT NULL,
	`payload` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`purge_after` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_trash_kind" CHECK("trash_items"."kind" IN ('habit', 'meal', 'food', 'recipe', 'journal', 'habit_routine', 'workout'))
);
--> statement-breakpoint
CREATE INDEX `ix_trash_user_deleted` ON `trash_items` (`user_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_trash_purge_after` ON `trash_items` (`purge_after`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`channels` text DEFAULT '{}' NOT NULL,
	`habit_summary_hour` integer,
	`backup_attachment` integer DEFAULT false NOT NULL,
	`backup_frequency` text DEFAULT 'monthly' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ix_notification_preferences_user_id` ON `notification_preferences` (`user_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`url` text,
	`actor_id` text,
	`data` text,
	`dedupe_key` text,
	`read_at` integer,
	`delivered_at` integer,
	`delivery_attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_notifications_inbox` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_notifications_actor_id` ON `notifications` (`actor_id`);--> statement-breakpoint
CREATE INDEX `ix_notifications_undelivered` ON `notifications` (`created_at`) WHERE "notifications"."delivered_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notification_dedupe` ON `notifications` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`last_success_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_push_subscriptions_endpoint` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `ix_push_subscriptions_user_id` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `foods` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_fold` text NOT NULL,
	`brand` text,
	`barcode` text,
	`serving_label` text,
	`kcal` real NOT NULL,
	`protein_g` real DEFAULT 0 NOT NULL,
	`carbs_g` real DEFAULT 0 NOT NULL,
	`fat_g` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_foods_user_name` ON `foods` (`user_id`,`name_fold`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_food_barcode` ON `foods` (`user_id`,`barcode`);--> statement-breakpoint
CREATE TABLE `meal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`meal` text NOT NULL,
	`name` text NOT NULL,
	`food_id` text,
	`servings` real DEFAULT 1 NOT NULL,
	`kcal` real NOT NULL,
	`protein_g` real DEFAULT 0 NOT NULL,
	`carbs_g` real DEFAULT 0 NOT NULL,
	`fat_g` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_meal_entries_meal" CHECK("meal_entries"."meal" IN ('breakfast', 'lunch', 'dinner', 'snack'))
);
--> statement-breakpoint
CREATE INDEX `ix_meal_entries_user_day` ON `meal_entries` (`user_id`,`day`);--> statement-breakpoint
CREATE INDEX `ix_meal_entries_food_id` ON `meal_entries` (`food_id`);--> statement-breakpoint
CREATE TABLE `nutrition_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`kcal` real,
	`protein_g` real,
	`carbs_g` real,
	`fat_g` real,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_nutrition_targets_user_id` ON `nutrition_targets` (`user_id`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_fold` text NOT NULL,
	`serves` real DEFAULT 1 NOT NULL,
	`items` text NOT NULL,
	`kcal` real NOT NULL,
	`protein_g` real DEFAULT 0 NOT NULL,
	`carbs_g` real DEFAULT 0 NOT NULL,
	`fat_g` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_recipes_user_name` ON `recipes` (`user_id`,`name_fold`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail` text,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_audit_log_created` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_log_actor_id` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE TABLE `auth_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`kind` text NOT NULL,
	`ip_address` text,
	`email_hash` text,
	`user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_auth_failures_created` ON `auth_failures` (`created_at`);--> statement-breakpoint
CREATE INDEX `ix_auth_failures_ip_address` ON `auth_failures` (`ip_address`);--> statement-breakpoint
CREATE INDEX `ix_auth_failures_email_hash` ON `auth_failures` (`email_hash`);--> statement-breakpoint
CREATE INDEX `ix_auth_failures_user_id` ON `auth_failures` (`user_id`);--> statement-breakpoint
CREATE TABLE `batch_guards` (
	`session` integer NOT NULL,
	`rate_limit` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `client_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`path` text,
	`release` text,
	`user_agent` text,
	`count` integer DEFAULT 1 NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`alerted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_client_errors_fingerprint` ON `client_errors` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `ix_client_errors_last_seen` ON `client_errors` (`last_seen`);--> statement-breakpoint
CREATE INDEX `ix_client_errors_unalerted` ON `client_errors` (`first_seen`) WHERE "client_errors"."alerted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`parts` text DEFAULT '[]' NOT NULL,
	`object_key` text,
	`error` text,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_export_jobs_kind" CHECK("export_jobs"."kind" IN ('json', 'csv', 'ics', 'backup')),
	CONSTRAINT "ck_export_jobs_status" CHECK("export_jobs"."status" IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `ix_export_jobs_user_id` ON `export_jobs` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_export_jobs_open` ON `export_jobs` (`status`,`created_at`) WHERE "export_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`object_key` text NOT NULL,
	`size` integer NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`state` text,
	`counts` text DEFAULT '{}' NOT NULL,
	`error` text,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_import_jobs_kind" CHECK("import_jobs"."kind" IN ('activity', 'lifting', 'account', 'habits')),
	CONSTRAINT "ck_import_jobs_status" CHECK("import_jobs"."status" IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `ix_import_jobs_user_id` ON `import_jobs` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_import_jobs_open` ON `import_jobs` (`status`,`created_at`) WHERE "import_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE TABLE `job_leases` (
	`name` text PRIMARY KEY NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_counters` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_rate_counters_window_start` ON `rate_counters` (`window_start`);--> statement-breakpoint
CREATE TABLE `security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`meta` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_security_events_user` ON `security_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_security_events_kind_created` ON `security_events` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `worker_heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name` text NOT NULL,
	`last_tick_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`jobs` text DEFAULT '{}' NOT NULL,
	`failing_ticks` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_worker_heartbeats_name` ON `worker_heartbeats` (`name`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`handle` text,
	`handle_fold` text,
	`display_name` text,
	`display_name_fold` text,
	`is_official` integer DEFAULT false NOT NULL,
	`calendar_token_hash` text,
	`calendar_token_created_at` integer,
	`bio` text,
	`avatar_hue` integer DEFAULT 78 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`week_starts_on` integer DEFAULT 0 NOT NULL,
	`weight_unit` text DEFAULT 'kg' NOT NULL,
	`distance_unit` text DEFAULT 'km' NOT NULL,
	`training_days` integer,
	`max_hr` integer,
	`life_target` integer,
	`favourite_disciplines` text DEFAULT '[]' NOT NULL,
	`birth_year` integer,
	`accepted_terms_at` integer,
	`accepted_terms_version` text,
	`onboarded_at` integer,
	`visibility` text DEFAULT 'followers' NOT NULL,
	`sharing_paused` integer DEFAULT false NOT NULL,
	`gamification_enabled` integer DEFAULT true NOT NULL,
	`leaderboard_opt_in` integer DEFAULT false NOT NULL,
	`social_suspended_at` integer,
	`deletion_scheduled_at` integer,
	`reminder_hour` integer DEFAULT 18 NOT NULL,
	`reminder_mode` text DEFAULT 'fixed' NOT NULL,
	`learned_reminder_hour` integer,
	`quiet_start` integer DEFAULT 22 NOT NULL,
	`quiet_end` integer DEFAULT 7 NOT NULL,
	`quiet_days` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_profiles_week_starts_on" CHECK("profiles"."week_starts_on" BETWEEN 0 AND 6),
	CONSTRAINT "ck_profiles_reminder_hour" CHECK("profiles"."reminder_hour" BETWEEN 0 AND 23),
	CONSTRAINT "ck_profiles_weight_unit" CHECK("profiles"."weight_unit" IN ('kg', 'lb')),
	CONSTRAINT "ck_profiles_distance_unit" CHECK("profiles"."distance_unit" IN ('km', 'mi')),
	CONSTRAINT "ck_profiles_visibility" CHECK("profiles"."visibility" IN ('private', 'followers', 'public')),
	CONSTRAINT "ck_profiles_reminder_mode" CHECK("profiles"."reminder_mode" IN ('fixed', 'smart')),
	CONSTRAINT "ck_profiles_handle_len" CHECK(length("profiles"."handle") <= 30)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ix_profiles_user_id` ON `profiles` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ix_profiles_handle` ON `profiles` (`handle`);--> statement-breakpoint
CREATE INDEX `ix_profiles_handle_fold` ON `profiles` (`handle_fold`);--> statement-breakpoint
CREATE INDEX `ix_profiles_display_name_fold` ON `profiles` (`display_name_fold`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_profiles_calendar_token_hash` ON `profiles` (`calendar_token_hash`);--> statement-breakpoint
CREATE INDEX `ix_profiles_timezone` ON `profiles` (`timezone`);--> statement-breakpoint
CREATE INDEX `ix_profiles_deletion_scheduled_at` ON `profiles` (`deletion_scheduled_at`) WHERE "profiles"."deletion_scheduled_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_key` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`occurred_on` text NOT NULL,
	`workout_id` text,
	`hidden_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_activity_events_workout_id` ON `activity_events` (`workout_id`);--> statement-breakpoint
CREATE INDEX `ix_activity_feed` ON `activity_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_activity_ref` ON `activity_events` (`user_id`,`kind`,`ref_key`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_blocks_blocked_id` ON `blocks` (`blocked_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_block_pair` ON `blocks` (`blocker_id`,`blocked_id`);--> statement-breakpoint
CREATE TABLE `buddy_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_a` text NOT NULL,
	`user_b` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`user_a`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_b`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_buddy_status" CHECK("buddy_pairs"."status" IN ('pending', 'active', 'ended')),
	CONSTRAINT "ck_buddy_order" CHECK("buddy_pairs"."user_a" < "buddy_pairs"."user_b")
);
--> statement-breakpoint
CREATE INDEX `ix_buddy_pairs_user_b` ON `buddy_pairs` (`user_b`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_buddy_pair` ON `buddy_pairs` (`user_a`,`user_b`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`event_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`hidden_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `activity_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_comments_body_len" CHECK(length("comments"."body") <= 280)
);
--> statement-breakpoint
CREATE INDEX `ix_comments_author_id` ON `comments` (`author_id`);--> statement-breakpoint
CREATE INDEX `ix_comments_event` ON `comments` (`event_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `follows` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`follower_id` text NOT NULL,
	`followee_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`accepted_at` integer,
	FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`followee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_follow_status" CHECK("follows"."status" IN ('pending', 'accepted')),
	CONSTRAINT "ck_follow_not_self" CHECK("follows"."follower_id" <> "follows"."followee_id")
);
--> statement-breakpoint
CREATE INDEX `ix_follows_followee` ON `follows` (`followee_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_follow_pair` ON `follows` (`follower_id`,`followee_id`);--> statement-breakpoint
CREATE TABLE `kudos` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reaction` text DEFAULT 'kudos' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `activity_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_kudos_reaction" CHECK("kudos"."reaction" IN ('kudos', 'fire', 'strong', 'star', 'heart'))
);
--> statement-breakpoint
CREATE INDEX `ix_kudos_user_id` ON `kudos` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_kudos_pair` ON `kudos` (`event_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`reporter_id` text NOT NULL,
	`reported_user_id` text,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`snapshot` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`resolution` text,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reported_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_report_target" CHECK("reports"."target_type" IN ('user', 'comment', 'event', 'group', 'challenge')),
	CONSTRAINT "ck_report_status" CHECK("reports"."status" IN ('open', 'actioned', 'dismissed'))
);
--> statement-breakpoint
CREATE INDEX `ix_reports_reporter_id` ON `reports` (`reporter_id`);--> statement-breakpoint
CREATE INDEX `ix_reports_reported_user_id` ON `reports` (`reported_user_id`);--> statement-breakpoint
CREATE INDEX `ix_reports_resolved_by` ON `reports` (`resolved_by`);--> statement-breakpoint
CREATE INDEX `ix_reports_status` ON `reports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `body_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`measured_on` text NOT NULL,
	`body_fat_pct` real,
	`waist_cm` real,
	`resting_hr` integer,
	`sleep_hours` real,
	`note` text,
	`neck_cm` real,
	`shoulders_cm` real,
	`chest_cm` real,
	`arm_cm` real,
	`forearm_cm` real,
	`hips_cm` real,
	`thigh_cm` real,
	`calf_cm` real,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_body_metric_day` ON `body_metrics` (`user_id`,`measured_on`);--> statement-breakpoint
CREATE TABLE `body_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`taken_on` text NOT NULL,
	`pose` text NOT NULL,
	`content_type` text NOT NULL,
	`object_key` text NOT NULL,
	`size` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_body_photos_pose" CHECK("body_photos"."pose" IN ('front', 'side', 'back'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_body_photos_object_key` ON `body_photos` (`object_key`);--> statement-breakpoint
CREATE INDEX `ix_body_photos_user_taken` ON `body_photos` (`user_id`,`taken_on`);--> statement-breakpoint
CREATE TABLE `custom_exercises` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_fold` text NOT NULL,
	`pattern` text NOT NULL,
	`equipment` text NOT NULL,
	`primary` text DEFAULT '[]' NOT NULL,
	`secondary` text DEFAULT '[]' NOT NULL,
	`load_type` text DEFAULT 'weight' NOT NULL,
	`rest_sec` integer DEFAULT 90 NOT NULL,
	`unilateral` integer DEFAULT false NOT NULL,
	`cue` text,
	`archived` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_custom_exercises_user_name` ON `custom_exercises` (`user_id`,`name_fold`);--> statement-breakpoint
CREATE TABLE `exercise_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`note` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_exercise_note` ON `exercise_notes` (`user_id`,`exercise_id`);--> statement-breakpoint
CREATE TABLE `gear` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'shoes' NOT NULL,
	`default_for` text DEFAULT '[]' NOT NULL,
	`limit_m` real,
	`initial_m` real DEFAULT 0 NOT NULL,
	`retired_at` integer,
	`note` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_gear_kind" CHECK("gear"."kind" IN ('shoes', 'bike', 'other')),
	CONSTRAINT "ck_gear_limit_m" CHECK("gear"."limit_m" IS NULL OR "gear"."limit_m" > 0)
);
--> statement-breakpoint
CREATE INDEX `ix_gear_user_id` ON `gear` (`user_id`);--> statement-breakpoint
CREATE TABLE `gyms` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`equipment` text DEFAULT '[]' NOT NULL,
	`plates_kg` text DEFAULT '[]' NOT NULL,
	`bar_kg` real DEFAULT 20 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_gyms_user_id` ON `gyms` (`user_id`);--> statement-breakpoint
CREATE TABLE `monthly_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`month` text NOT NULL,
	`days` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_monthly_goal_days" CHECK("monthly_goals"."days" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_monthly_goal` ON `monthly_goals` (`user_id`,`month`);--> statement-breakpoint
CREATE TABLE `readiness` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`sleep` integer NOT NULL,
	`energy` integer NOT NULL,
	`soreness` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_readiness_range" CHECK("readiness"."sleep" BETWEEN 1 AND 5 AND "readiness"."energy" BETWEEN 1 AND 5 AND "readiness"."soreness" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_readiness_day` ON `readiness` (`user_id`,`day`);--> statement-breakpoint
CREATE TABLE `rest_days` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`kind` text DEFAULT 'rest' NOT NULL,
	`note` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_rest_day_kind" CHECK("rest_days"."kind" IN ('rest', 'sleep', 'mobility', 'sick'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_rest_day` ON `rest_days` (`user_id`,`day`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_fold` text NOT NULL,
	`discipline` text DEFAULT 'strength' NOT NULL,
	`notes` text,
	`items` text DEFAULT '[]' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_routines_user_name` ON `routines` (`user_id`,`name_fold`);--> statement-breakpoint
CREATE TABLE `streak_chains` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`disciplines` text DEFAULT '[]' NOT NULL,
	`target_history` text DEFAULT '[]' NOT NULL,
	`requirements_history` text DEFAULT '[]' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_streak_chains_user_id` ON `streak_chains` (`user_id`);--> statement-breakpoint
CREATE TABLE `streak_pauses` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`reason` text DEFAULT 'injury' NOT NULL,
	`note` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_pause_reason" CHECK("streak_pauses"."reason" IN ('injury', 'illness', 'travel', 'life', 'other')),
	CONSTRAINT "ck_pause_range" CHECK("streak_pauses"."ends_on" IS NULL OR "streak_pauses"."ends_on" >= "streak_pauses"."starts_on")
);
--> statement-breakpoint
CREATE INDEX `ix_streak_pauses_user_start` ON `streak_pauses` (`user_id`,`starts_on`);--> statement-breakpoint
CREATE TABLE `streak_repairs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`chain_id` text NOT NULL,
	`week_start` text NOT NULL,
	`month` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chain_id`) REFERENCES `streak_chains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repair_chain_week` ON `streak_repairs` (`chain_id`,`week_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_repair_user_month` ON `streak_repairs` (`user_id`,`month`);--> statement-breakpoint
CREATE TABLE `training_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`starts_on` text NOT NULL,
	`weeks` integer NOT NULL,
	`rir_start` integer DEFAULT 3 NOT NULL,
	`rir_end` integer DEFAULT 1 NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_block_weeks" CHECK("training_blocks"."weeks" BETWEEN 3 AND 8),
	CONSTRAINT "ck_block_rir" CHECK("training_blocks"."rir_start" BETWEEN 0 AND 5 AND "training_blocks"."rir_end" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE INDEX `ix_training_blocks_user_id` ON `training_blocks` (`user_id`);--> statement-breakpoint
CREATE TABLE `training_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`template_id` text,
	`weeks` text DEFAULT '[]' NOT NULL,
	`started_on` text,
	`challenge_id` text,
	`assigned_by` text,
	`finished_at` integer,
	`repeat` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`challenge_id`) REFERENCES `challenges`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_training_plans_user_started` ON `training_plans` (`user_id`,`started_on`);--> statement-breakpoint
CREATE INDEX `ix_training_plans_challenge_id` ON `training_plans` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `ix_training_plans_assigned_by` ON `training_plans` (`assigned_by`);--> statement-breakpoint
CREATE TABLE `week_reflections` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`went_well` text,
	`change` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reflection_week` ON `week_reflections` (`user_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `weigh_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`weighed_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`moment` text NOT NULL,
	`weight_kg` real NOT NULL,
	`note` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_weigh_ins_moment" CHECK("weigh_ins"."moment" IN ('waking', 'pre_workout', 'post_workout', 'bedtime', 'other'))
);
--> statement-breakpoint
CREATE INDEX `ix_weigh_ins_user_day` ON `weigh_ins` (`user_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `weight_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`target_kg` real NOT NULL,
	`start_kg` real NOT NULL,
	`milestone_kg` real DEFAULT 2 NOT NULL,
	`set_on` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_weight_goals_user_id` ON `weight_goals` (`user_id`);--> statement-breakpoint
CREATE TABLE `workout_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workout_id` text NOT NULL,
	`user_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`position` integer NOT NULL,
	`set_index` integer NOT NULL,
	`superset` integer,
	`kind` text DEFAULT 'work' NOT NULL,
	`weight_kg` real,
	`reps` integer,
	`rpe` real,
	`duration_sec` integer,
	`distance_m` real,
	`completed` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`workout_id`) REFERENCES `workouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_workout_sets_kind" CHECK("workout_sets"."kind" IN ('work', 'warmup', 'drop', 'failure')),
	CONSTRAINT "ck_workout_sets_weight" CHECK("workout_sets"."weight_kg" IS NULL OR "workout_sets"."weight_kg" >= 0),
	CONSTRAINT "ck_workout_sets_reps" CHECK("workout_sets"."reps" IS NULL OR "workout_sets"."reps" >= 0),
	CONSTRAINT "ck_workout_sets_rpe" CHECK("workout_sets"."rpe" IS NULL OR "workout_sets"."rpe" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE INDEX `ix_workout_sets_workout_id` ON `workout_sets` (`workout_id`,`position`,`set_index`);--> statement-breakpoint
CREATE INDEX `ix_workout_sets_user_exercise` ON `workout_sets` (`user_id`,`exercise_id`);--> statement-breakpoint
CREATE TABLE `workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`discipline` text NOT NULL,
	`title` text,
	`notes` text,
	`started_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`duration_sec` integer,
	`distance_m` real,
	`elevation_m` real,
	`effort` integer,
	`feel` integer,
	`soreness` integer,
	`pump` integer,
	`avg_hr` integer,
	`max_hr` integer,
	`hr_zones` text DEFAULT '[]' NOT NULL,
	`routine_id` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`splits` text DEFAULT '[]' NOT NULL,
	`gear_id` text,
	`gym_id` text,
	`source` text DEFAULT 'app' NOT NULL,
	`client_updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gear_id`) REFERENCES `gear`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`gym_id`) REFERENCES `gyms`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_workouts_source" CHECK("workouts"."source" IN ('app', 'import')),
	CONSTRAINT "ck_workouts_duration" CHECK("workouts"."duration_sec" IS NULL OR "workouts"."duration_sec" >= 0),
	CONSTRAINT "ck_workouts_distance" CHECK("workouts"."distance_m" IS NULL OR "workouts"."distance_m" >= 0),
	CONSTRAINT "ck_workouts_effort" CHECK("workouts"."effort" IS NULL OR "workouts"."effort" BETWEEN 1 AND 10),
	CONSTRAINT "ck_workouts_feel" CHECK("workouts"."feel" IS NULL OR "workouts"."feel" BETWEEN 1 AND 5),
	CONSTRAINT "ck_workouts_soreness" CHECK("workouts"."soreness" IS NULL OR "workouts"."soreness" BETWEEN 0 AND 3),
	CONSTRAINT "ck_workouts_pump" CHECK("workouts"."pump" IS NULL OR "workouts"."pump" BETWEEN 0 AND 2),
	CONSTRAINT "ck_workouts_title_len" CHECK(length("workouts"."title") <= 80)
);
--> statement-breakpoint
CREATE INDEX `ix_workouts_user_date` ON `workouts` (`user_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `ix_workouts_user_seq` ON `workouts` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `ix_workouts_seq` ON `workouts` (`seq`);--> statement-breakpoint
CREATE INDEX `ix_workouts_gear_id` ON `workouts` (`gear_id`);--> statement-breakpoint
CREATE INDEX `ix_workouts_gym_id` ON `workouts` (`gym_id`);