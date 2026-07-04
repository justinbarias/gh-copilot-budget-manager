CREATE TABLE `audit_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_ref` text NOT NULL,
	`trigger` text NOT NULL,
	`envelope_snapshot` text,
	`before` text,
	`after` text,
	`justification` text,
	`data_snapshot_id` integer,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	FOREIGN KEY (`data_snapshot_id`) REFERENCES `snapshot`(`id`) ON UPDATE no action ON DELETE no action
);
