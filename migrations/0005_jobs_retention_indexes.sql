CREATE INDEX `ix_users_role` ON `users` (`role`);--> statement-breakpoint
CREATE INDEX `ix_notifications_created_at` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE INDEX `ix_export_jobs_created_at` ON `export_jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX `ix_import_jobs_created_at` ON `import_jobs` (`created_at`);