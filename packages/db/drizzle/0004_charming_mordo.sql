CREATE TABLE "contingencies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"amount" double precision NOT NULL,
	"confidence_level" text,
	"simulation_id" text,
	"is_management_reserve" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contingency_drawdowns" (
	"id" text PRIMARY KEY NOT NULL,
	"contingency_id" text NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"amount" double precision NOT NULL,
	"reason" text NOT NULL,
	"risk_id" text,
	"drawn_at" text NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_simulations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"seed" integer NOT NULL,
	"iterations" integer NOT NULL,
	"inputs" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"run_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_id" text,
	"probability_score" integer DEFAULT 3 NOT NULL,
	"impact_score" integer DEFAULT 3 NOT NULL,
	"post_probability_score" integer,
	"post_impact_score" integer,
	"occurrence_probability" double precision,
	"cost_impact" jsonb,
	"schedule_task_id" text,
	"duration_impact" jsonb,
	"mitigations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mitigation_cost" double precision,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benefit_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"benefit_id" text NOT NULL,
	"company_id" text NOT NULL,
	"reading_date" text NOT NULL,
	"value" double precision NOT NULL,
	"note" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benefits" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" text,
	"measurement_method" text,
	"unit" text NOT NULL,
	"baseline_value" double precision NOT NULL,
	"target_value" double precision NOT NULL,
	"target_date" text,
	"is_disbenefit" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"cases" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"appraisal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_option_id" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"gate_id" text NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"review_date" text NOT NULL,
	"rag" text NOT NULL,
	"decision" text NOT NULL,
	"narrative" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"gate_number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"planned_date" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "covenant_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"covenant_id" text NOT NULL,
	"company_id" text NOT NULL,
	"reading_date" text NOT NULL,
	"value" double precision NOT NULL,
	"compliant" integer NOT NULL,
	"headroom" double precision NOT NULL,
	"note" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "covenants" (
	"id" text PRIMARY KEY NOT NULL,
	"facility_id" text NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"operator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"unit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disbursements" (
	"id" text PRIMARY KEY NOT NULL,
	"facility_id" text NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"amount" double precision NOT NULL,
	"category_id" text,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conditionality" jsonb,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"disbursed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_conditions" (
	"id" text PRIMARY KEY NOT NULL,
	"facility_id" text NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"reference" text,
	"description" text NOT NULL,
	"due_date" text,
	"status" text DEFAULT 'open' NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"obligation_id" text,
	"satisfied_at" timestamp with time zone,
	"satisfied_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_facilities" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"lender" text NOT NULL,
	"instrument" text NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"committed_amount" double precision NOT NULL,
	"availability_end_date" text,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"party" text NOT NULL,
	"served_at" text NOT NULL,
	"file_id" text,
	"note" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"forum" text,
	"rules" text,
	"contract_id" text,
	"claim_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counterparty_entity_id" text,
	"amount_in_dispute" double precision,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"status" text DEFAULT 'notified' NOT NULL,
	"timetable" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"decided_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"company_id" text NOT NULL,
	"direction" text NOT NULL,
	"basis" text NOT NULL,
	"amount" double precision NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"terms" text,
	"offered_at" text NOT NULL,
	"expires_at" text,
	"status" text DEFAULT 'open' NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "contingencies_project_idx" ON "contingencies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "contingency_drawdowns_contingency_idx" ON "contingency_drawdowns" USING btree ("contingency_id");--> statement-breakpoint
CREATE INDEX "risk_simulations_project_idx" ON "risk_simulations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risks_uq" ON "risks" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "risks_project_idx" ON "risks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "benefit_readings_benefit_idx" ON "benefit_readings" USING btree ("benefit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "benefits_uq" ON "benefits" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "benefits_project_idx" ON "benefits" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "business_cases_project_idx" ON "business_cases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "gate_reviews_gate_idx" ON "gate_reviews" USING btree ("gate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_gates_uq" ON "stage_gates" USING btree ("project_id","gate_number");--> statement-breakpoint
CREATE INDEX "stage_gates_project_idx" ON "stage_gates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "covenant_readings_covenant_idx" ON "covenant_readings" USING btree ("covenant_id");--> statement-breakpoint
CREATE INDEX "covenants_facility_idx" ON "covenants" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disbursements_uq" ON "disbursements" USING btree ("facility_id","number");--> statement-breakpoint
CREATE INDEX "disbursements_project_idx" ON "disbursements" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "facility_conditions_facility_idx" ON "facility_conditions" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "funding_facilities_project_idx" ON "funding_facilities" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "dispute_bundles_dispute_idx" ON "dispute_bundles" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "dispute_submissions_dispute_idx" ON "dispute_submissions" USING btree ("dispute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_uq" ON "disputes" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "disputes_project_idx" ON "disputes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "settlement_offers_dispute_idx" ON "settlement_offers" USING btree ("dispute_id");