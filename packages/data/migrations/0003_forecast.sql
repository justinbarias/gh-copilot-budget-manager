CREATE TABLE `forecast` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`scope` text NOT NULL,
	`entity_ref` text,
	`computed_at` text NOT NULL,
	`forecast_json` text NOT NULL,
	`mape` real,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshot`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `forecast_snapshot_id_scope_entity_ref_idx` ON `forecast` (`snapshot_id`,`scope`,`entity_ref`);