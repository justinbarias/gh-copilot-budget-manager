CREATE TABLE `control_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`controls_json` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshot`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_snapshot_snapshot_id_unique` ON `control_snapshot` (`snapshot_id`);