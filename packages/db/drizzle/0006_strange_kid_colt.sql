CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingested_records" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"company_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"external_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"reason" text,
	"committed_record_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"source_id" text NOT NULL,
	"dataset" text NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"file_id" text,
	"file_name" text,
	"file_sha256" text,
	"column_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"staged_count" integer DEFAULT 0 NOT NULL,
	"committed_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"report" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_by" text NOT NULL,
	"committed_by" text,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"metric" text NOT NULL,
	"asset_class" text NOT NULL,
	"region" text NOT NULL,
	"value" double precision NOT NULL,
	"unit" text NOT NULL,
	"source" text NOT NULL,
	"contributor_company_id" text,
	"contributor_project_id" text,
	"data_year" integer,
	"methodology" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_metric_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"unit" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contributed_sample_id" text,
	"computed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_tokens_company_idx" ON "api_tokens" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "api_tokens_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ingested_records_run_idx" ON "ingested_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ingested_records_external_idx" ON "ingested_records" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_company_idx" ON "ingestion_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_source_idx" ON "ingestion_runs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ingestion_sources_company_idx" ON "ingestion_sources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "benchmark_samples_metric_idx" ON "benchmark_samples" USING btree ("metric","asset_class","region");--> statement-breakpoint
CREATE INDEX "benchmark_samples_contributor_idx" ON "benchmark_samples" USING btree ("contributor_company_id");--> statement-breakpoint
CREATE INDEX "project_metric_snapshots_project_idx" ON "project_metric_snapshots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_metric_snapshots_metric_idx" ON "project_metric_snapshots" USING btree ("company_id","metric");