CREATE TABLE "boq_items" (
	"id" text PRIMARY KEY NOT NULL,
	"boq_id" text NOT NULL,
	"parent_id" text,
	"path" text NOT NULL,
	"level" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"unit" text,
	"quantity" double precision,
	"rate" double precision,
	"amount" double precision,
	"item_type" text DEFAULT 'measured' NOT NULL,
	"rate_build_up" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boqs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text,
	"name" text NOT NULL,
	"method" text DEFAULT 'nrm2' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_certificates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"valuation_id" text NOT NULL,
	"number" integer NOT NULL,
	"certified_work_done" double precision DEFAULT 0 NOT NULL,
	"certified_materials" double precision DEFAULT 0 NOT NULL,
	"retention_held" double precision DEFAULT 0 NOT NULL,
	"previous_certified" double precision DEFAULT 0 NOT NULL,
	"net_certified" double precision DEFAULT 0 NOT NULL,
	"variance_from_application" double precision DEFAULT 0 NOT NULL,
	"variance_reason" text,
	"due_date" text,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takeoff_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"boq_item_id" text NOT NULL,
	"project_id" text NOT NULL,
	"drawing_sheet_id" text,
	"description" text NOT NULL,
	"timesing" double precision DEFAULT 1 NOT NULL,
	"length" double precision,
	"width" double precision,
	"depth" double precision,
	"quantity" double precision NOT NULL,
	"is_manual" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "valuation_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"valuation_id" text NOT NULL,
	"boq_item_id" text NOT NULL,
	"qty_to_date" double precision,
	"percent_to_date" double precision,
	"amount_to_date" double precision DEFAULT 0 NOT NULL,
	"previous_amount" double precision DEFAULT 0 NOT NULL,
	"this_period" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "valuations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text,
	"boq_id" text NOT NULL,
	"number" integer NOT NULL,
	"valuation_date" text NOT NULL,
	"basis" text DEFAULT 'remeasure' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"retention_percent" double precision DEFAULT 0 NOT NULL,
	"work_done_to_date" double precision DEFAULT 0 NOT NULL,
	"materials_on_site" double precision DEFAULT 0 NOT NULL,
	"materials_off_site" double precision DEFAULT 0 NOT NULL,
	"retention_held" double precision DEFAULT 0 NOT NULL,
	"previous_net" double precision DEFAULT 0 NOT NULL,
	"net_due" double precision DEFAULT 0 NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"basis" text DEFAULT 'bq_rates' NOT NULL,
	"clause_ref" text,
	"instruction_ref" text,
	"instructed_at" text,
	"cost_estimate" double precision,
	"agreed_value" double precision,
	"time_impact_days" integer,
	"boq_item_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"clause_ref" text,
	"title" text NOT NULL,
	"description" text,
	"event_date" text NOT NULL,
	"notice_deadline" text,
	"notice_served_at" timestamp with time zone,
	"notice_method" text,
	"notice_reference" text,
	"status" text DEFAULT 'open' NOT NULL,
	"obligation_id" text,
	"cost_impact_estimate" double precision,
	"time_impact_days_estimate" integer,
	"raised_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"form" text NOT NULL,
	"nec_option" text,
	"parties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"base_date" text,
	"commencement_date" text,
	"completion_date" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"contract_sum" double precision,
	"retention_percent" double precision DEFAULT 0 NOT NULL,
	"retention_cap" double precision,
	"defects_period_months" integer,
	"ld_rate_per_day" double precision,
	"ld_cap" double precision,
	"particular_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eot_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"clause_ref" text,
	"event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"days_claimed" integer NOT NULL,
	"days_awarded" integer,
	"status" text DEFAULT 'notified' NOT NULL,
	"narrative" text,
	"assessed_by" text,
	"assessed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "boq_items_boq_idx" ON "boq_items" USING btree ("boq_id","path");--> statement-breakpoint
CREATE INDEX "boq_items_parent_idx" ON "boq_items" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "boqs_project_idx" ON "boqs" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_certificates_uq" ON "payment_certificates" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "payment_certificates_valuation_idx" ON "payment_certificates" USING btree ("valuation_id");--> statement-breakpoint
CREATE INDEX "takeoff_lines_item_idx" ON "takeoff_lines" USING btree ("boq_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "valuation_lines_uq" ON "valuation_lines" USING btree ("valuation_id","boq_item_id");--> statement-breakpoint
CREATE INDEX "valuation_lines_valuation_idx" ON "valuation_lines" USING btree ("valuation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "valuations_uq" ON "valuations" USING btree ("boq_id","number");--> statement-breakpoint
CREATE INDEX "valuations_project_idx" ON "valuations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variations_uq" ON "variations" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "variations_project_idx" ON "variations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_events_uq" ON "contract_events" USING btree ("contract_id","number");--> statement-breakpoint
CREATE INDEX "contract_events_project_idx" ON "contract_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "contract_events_deadline_idx" ON "contract_events" USING btree ("status","notice_deadline");--> statement-breakpoint
CREATE INDEX "contracts_project_idx" ON "contracts" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eot_claims_uq" ON "eot_claims" USING btree ("contract_id","number");--> statement-breakpoint
CREATE INDEX "eot_claims_project_idx" ON "eot_claims" USING btree ("project_id");