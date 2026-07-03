CREATE TABLE `sync_seen` (
	`sync_token` text NOT NULL,
	`external_ref` text NOT NULL,
	FOREIGN KEY (`sync_token`) REFERENCES `sync_sessions`(`token`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_seen` ON `sync_seen` (`sync_token`,`external_ref`);--> statement-breakpoint
ALTER TABLE `test_case_observations` ADD `category` text;