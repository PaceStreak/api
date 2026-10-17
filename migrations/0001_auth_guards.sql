ALTER TABLE `batch_guards` ADD `cond` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_users_pending_email` ON `users` (`pending_email`) WHERE "users"."pending_email" IS NOT NULL;