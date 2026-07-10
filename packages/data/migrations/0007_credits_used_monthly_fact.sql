CREATE TABLE `credits_used_monthly_fact` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`month` text NOT NULL,
	`user_id` text,
	`user_login` text,
	`credits_used` real NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshot`(`id`) ON UPDATE no action ON DELETE no action
);
