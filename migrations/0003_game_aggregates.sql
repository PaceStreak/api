CREATE TABLE `record_days` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`local_date` text NOT NULL,
	`value` real NOT NULL,
	`workout_id` text NOT NULL,
	`rewardable` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`, `local_date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_record_days_user_date` ON `record_days` (`user_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `stat_days` (
	`user_id` text NOT NULL,
	`local_date` text NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`detailed` integer DEFAULT 0 NOT NULL,
	`duration_sec` real DEFAULT 0 NOT NULL,
	`distance_m` real DEFAULT 0 NOT NULL,
	`heat` real DEFAULT 0 NOT NULL,
	`short` integer DEFAULT 0 NOT NULL,
	`early` integer DEFAULT 0 NOT NULL,
	`late` integer DEFAULT 0 NOT NULL,
	`rpe_sets` integer DEFAULT 0 NOT NULL,
	`disciplines` text DEFAULT '{}' NOT NULL,
	`exercises` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`user_id`, `local_date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stat_exercises` (
	`user_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`first_seen` text NOT NULL,
	`sets` integer DEFAULT 0 NOT NULL,
	`rpe_sets` integer DEFAULT 0 NOT NULL,
	`tonnage` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `exercise_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
