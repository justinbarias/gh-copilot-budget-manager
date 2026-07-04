CREATE TABLE `budget` (
	`id` text PRIMARY KEY NOT NULL,
	`budget_type` text NOT NULL,
	`budget_product_sku` text NOT NULL,
	`budget_scope` text NOT NULL,
	`budget_entity_name` text NOT NULL,
	`budget_amount` real NOT NULL,
	`prevent_further_usage` integer NOT NULL,
	`will_alert` integer,
	`alert_recipients` text
);
--> statement-breakpoint
CREATE TABLE `cost_center` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`dewr_division` text,
	`dewr_branch` text,
	`dewr_project` text
);
--> statement-breakpoint
CREATE TABLE `cost_center_member` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cost_center_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	FOREIGN KEY (`cost_center_id`) REFERENCES `cost_center`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `credits_used_fact` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`date` text NOT NULL,
	`user_id` text NOT NULL,
	`credits_used` real NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshot`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `license` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`cost_center_id` text,
	`assigned_at` integer,
	FOREIGN KEY (`cost_center_id`) REFERENCES `cost_center`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`captured_at` integer NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_fact` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`date` text NOT NULL,
	`entity` text NOT NULL,
	`user_id` text,
	`cost_center_id` text,
	`model` text NOT NULL,
	`net_quantity` real NOT NULL,
	`net_amount` real NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cost_center_id`) REFERENCES `cost_center`(`id`) ON UPDATE no action ON DELETE no action
);
