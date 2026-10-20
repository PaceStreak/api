DROP INDEX `ix_activity_feed`;--> statement-breakpoint
CREATE INDEX `ix_activity_feed` ON `activity_events` (`user_id`,`created_at`,`id`);