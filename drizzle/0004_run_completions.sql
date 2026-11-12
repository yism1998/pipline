CREATE TABLE `run_completions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`recipient` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`acknowledged_at` text
);
--> statement-breakpoint
CREATE INDEX `run_completions_inbox_idx` ON `run_completions` (`recipient`,`acknowledged_at`,`created_at`);