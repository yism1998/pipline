CREATE TABLE `scheduler_meta` (
	`id` text PRIMARY KEY NOT NULL,
	`last_heartbeat_at` text
);
--> statement-breakpoint
CREATE TABLE `task_schedules` (
	`task_id` text PRIMARY KEY NOT NULL,
	`rule_key` text NOT NULL,
	`generation` text NOT NULL,
	`revision` integer NOT NULL,
	`task_version` integer NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`last_run_id` text,
	`completed` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `task_schedules_due_idx` ON `task_schedules` (`next_run_at`);--> statement-breakpoint
ALTER TABLE `runs` ADD `trigger_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_trigger_key_unique` ON `runs` (`trigger_key`);