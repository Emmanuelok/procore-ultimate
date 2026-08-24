CREATE TABLE "schedule_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"project_start" text NOT NULL,
	"computed_finish" text,
	"snapshot" jsonb NOT NULL,
	"captured_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"predecessor_id" text NOT NULL,
	"successor_id" text NOT NULL,
	"dep_type" text DEFAULT 'FS' NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"wbs_code" text,
	"duration_days" integer DEFAULT 1 NOT NULL,
	"constraint_type" text,
	"constraint_date" text,
	"actual_start" text,
	"actual_finish" text,
	"percent_complete" double precision DEFAULT 0 NOT NULL,
	"responsible_id" text,
	"location_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"start_date" text,
	"finish_date" text,
	"total_float" integer,
	"is_critical" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"project_start" text NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"computed_finish" text,
	"computed_duration_days" integer,
	"last_computed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delay_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"cause" text NOT NULL,
	"excusable" integer DEFAULT 0 NOT NULL,
	"compensable" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"task_id" text,
	"schedule_id" text,
	"start_date" text NOT NULL,
	"duration_days" integer NOT NULL,
	"contract_event_id" text,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tia_result" jsonb,
	"raised_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forensic_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"contract_id" text,
	"clause_ref" text,
	"delay_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chain" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"days_claimed" integer,
	"amount_claimed" double precision,
	"days_assessed" integer,
	"amount_assessed" double precision,
	"prolongation" jsonb,
	"chronology" jsonb,
	"chronology_at" timestamp with time zone,
	"assessed_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text,
	"valuation_id" text,
	"number" integer NOT NULL,
	"regime" text NOT NULL,
	"reference_date" text NOT NULL,
	"claimed_amount" double precision NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"description" text,
	"served_at" timestamp with time zone,
	"service_method" text,
	"service_reference" text,
	"response_deadline" text,
	"final_payment_date" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"obligation_id" text,
	"paid_at" timestamp with time zone,
	"paid_amount" double precision,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_claim_id" text NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount" double precision NOT NULL,
	"reasons" text,
	"breakdown" jsonb,
	"served_at" timestamp with time zone NOT NULL,
	"late" integer DEFAULT 0 NOT NULL,
	"served_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suspension_notices" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"payment_claim_id" text NOT NULL,
	"served_at" timestamp with time zone NOT NULL,
	"effective_from" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"served_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "schedule_baselines_schedule_idx" ON "schedule_baselines" USING btree ("schedule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_deps_uq" ON "schedule_dependencies" USING btree ("predecessor_id","successor_id","dep_type");--> statement-breakpoint
CREATE INDEX "schedule_deps_schedule_idx" ON "schedule_dependencies" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "schedule_tasks_schedule_idx" ON "schedule_tasks" USING btree ("schedule_id","sort_order");--> statement-breakpoint
CREATE INDEX "schedule_tasks_project_idx" ON "schedule_tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "schedules_project_idx" ON "schedules" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delay_events_uq" ON "delay_events" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "delay_events_project_idx" ON "delay_events" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forensic_claims_uq" ON "forensic_claims" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "forensic_claims_project_idx" ON "forensic_claims" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_claims_uq" ON "payment_claims" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "payment_claims_project_idx" ON "payment_claims" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "payment_claims_deadline_idx" ON "payment_claims" USING btree ("status","response_deadline");--> statement-breakpoint
CREATE INDEX "payment_responses_claim_idx" ON "payment_responses" USING btree ("payment_claim_id");--> statement-breakpoint
CREATE INDEX "suspension_notices_project_idx" ON "suspension_notices" USING btree ("project_id");