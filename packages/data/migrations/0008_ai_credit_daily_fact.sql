CREATE TABLE `ai_credit_daily_fact` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`date` text NOT NULL,
	`cost_center_id` text,
	`credits_used` real NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cost_center_id`) REFERENCES `cost_center`(`id`) ON UPDATE no action ON DELETE no action
);
