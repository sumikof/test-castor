CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_token_hash` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`repo_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `sync_sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`committed_at` integer,
	`created_count` integer,
	`changed_count` integer,
	`staled_count` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_sync_status" CHECK("sync_sessions"."status" IN ('active','committed','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_active_session` ON `sync_sessions` (`project_id`,`origin`) WHERE "sync_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX `ix_sync_project_committed` ON `sync_sessions` (`project_id`,`status`,`committed_at`);--> statement-breakpoint
CREATE TABLE `sync_staging` (
	`sync_token` text NOT NULL,
	`external_ref` text NOT NULL,
	`new_test_case_id` text NOT NULL,
	FOREIGN KEY (`sync_token`) REFERENCES `sync_sessions`(`token`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staging` ON `sync_staging` (`sync_token`,`external_ref`);--> statement-breakpoint
CREATE TABLE `test_case_history` (
	`id` text PRIMARY KEY NOT NULL,
	`test_case_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`delta` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_history_action" CHECK("test_case_history"."action" IN ('created','updated','status_changed','imported'))
);
--> statement-breakpoint
CREATE INDEX `ix_history_tc_time` ON `test_case_history` (`test_case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_case_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`test_case_id` text NOT NULL,
	`project_id` text NOT NULL,
	`origin` text NOT NULL,
	`external_ref` text NOT NULL,
	`is_stale` integer DEFAULT 0 NOT NULL,
	`last_seen_sync_token` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_identity` ON `test_case_identities` (`project_id`,`origin`,`external_ref`);--> statement-breakpoint
CREATE INDEX `ix_identity_lastseen` ON `test_case_identities` (`project_id`,`origin`,`last_seen_sync_token`);--> statement-breakpoint
CREATE INDEX `ix_identity_rollup` ON `test_case_identities` (`test_case_id`,`is_stale`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `test_case_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`test_case_id` text,
	`external_ref` text NOT NULL,
	`project_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`observed` text NOT NULL,
	`sync_token` text NOT NULL,
	`origin` text NOT NULL,
	`confidence` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_obs_idem` ON `test_case_observations` (`external_ref`,`origin`,`sync_token`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `ix_obs_tc_time` ON `test_case_observations` (`test_case_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_obs_project_token` ON `test_case_observations` (`project_id`,`sync_token`);--> statement-breakpoint
CREATE INDEX `ix_obs_ref_origin_time` ON `test_case_observations` (`project_id`,`origin`,`external_ref`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`target` text,
	`category` text NOT NULL,
	`given` text NOT NULL,
	`when` text NOT NULL,
	`then` text NOT NULL,
	`parameters` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`is_stale` integer DEFAULT 0 NOT NULL,
	`ownership` text NOT NULL,
	`mirror_origin` text,
	`drift` integer DEFAULT 0 NOT NULL,
	`fingerprint` text,
	`version` integer DEFAULT 1 NOT NULL,
	`confidence` real,
	`source_ref` text,
	`created_origin` text NOT NULL,
	`metadata` text,
	`human_updated_at` integer,
	`system_updated_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_tc_status" CHECK("test_cases"."status" IN ('draft','approved','archived')),
	CONSTRAINT "ck_tc_category" CHECK("test_cases"."category" IN ('normal','abnormal','boundary','error_handling')),
	CONSTRAINT "ck_tc_ownership" CHECK("test_cases"."ownership" IN ('machine','human')),
	CONSTRAINT "ck_tc_status_ownership" CHECK("test_cases"."status" = 'draft' OR "test_cases"."ownership" = 'human')
);
--> statement-breakpoint
CREATE INDEX `ix_tc_project_status` ON `test_cases` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_tc_project_category` ON `test_cases` (`project_id`,`category`);--> statement-breakpoint
CREATE INDEX `ix_tc_project_stale` ON `test_cases` (`project_id`,`is_stale`);--> statement-breakpoint
CREATE INDEX `ix_tc_project_drift` ON `test_cases` (`project_id`,`drift`);--> statement-breakpoint
CREATE INDEX `ix_tc_project_created` ON `test_cases` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_users_role" CHECK("users"."role" IN ('admin','editor','viewer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_org_email` ON `users` (`organization_id`,`email`);