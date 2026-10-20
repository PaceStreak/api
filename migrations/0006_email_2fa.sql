CREATE TABLE `email_login_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hmac` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_sent_at` integer NOT NULL,
	`sends` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_email_login_challenges_user_id` ON `email_login_challenges` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_email_login_challenges_expires_at` ON `email_login_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `trusted_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_version` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trusted_devices_token_hash` ON `trusted_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_trusted_devices_user_id` ON `trusted_devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_trusted_devices_expires_at` ON `trusted_devices` (`expires_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `email_2fa_enabled` integer DEFAULT true NOT NULL;