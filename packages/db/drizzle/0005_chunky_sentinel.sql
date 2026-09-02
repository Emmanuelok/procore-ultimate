CREATE TABLE "affected_persons" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"reference" text NOT NULL,
	"household_head" text NOT NULL,
	"household_size" integer,
	"parcel_id" text,
	"displacement_type" text DEFAULT 'none' NOT NULL,
	"vulnerabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"baseline" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entitlements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compensation_total" double precision,
	"compensation_paid_at" text,
	"livelihood_programme" text,
	"livelihood_restored_at" text,
	"status" text DEFAULT 'registered' NOT NULL,
	"census_date" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"engagement_date" text NOT NULL,
	"location" text,
	"stakeholder_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attendee_count" integer,
	"summary" text,
	"feedback" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consent_status" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grievances" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"channel" text NOT NULL,
	"is_anonymous" integer DEFAULT 0 NOT NULL,
	"complainant_name" text,
	"complainant_contact" text,
	"pap_id" text,
	"category" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"description" text NOT NULL,
	"location_id" text,
	"received_at" text NOT NULL,
	"acknowledge_due_at" text,
	"resolve_due_at" text,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"complainant_satisfied" integer,
	"status" text DEFAULT 'received' NOT NULL,
	"assignee_id" text,
	"obligation_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "land_parcels" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"reference" text NOT NULL,
	"description" text,
	"area_sqm" double precision,
	"tenure_type" text NOT NULL,
	"owner_name" text,
	"owner_entity_id" text,
	"encumbrances" text,
	"status" text DEFAULT 'identified' NOT NULL,
	"valuation_amount" double precision,
	"compensation_amount" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"compensation_paid_at" text,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"blocking_task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stakeholders" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"organisation" text,
	"category" text,
	"influence" integer DEFAULT 3 NOT NULL,
	"interest" integer DEFAULT 3 NOT NULL,
	"contact" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labour_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"is_unannounced" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" double precision,
	"report_file_id" text,
	"audited_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labour_risk_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text,
	"vendor_id" text,
	"indicator" text NOT NULL,
	"severity" text DEFAULT 'high' NOT NULL,
	"detail" text,
	"source" text DEFAULT 'audit' NOT NULL,
	"signal_id" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"raised_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"days_claimed" double precision NOT NULL,
	"hours_claimed" double precision,
	"gross_pay" double precision NOT NULL,
	"deductions" double precision DEFAULT 0 NOT NULL,
	"net_pay" double precision NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"paid_at" text,
	"wps_reference" text,
	"submitted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_access_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"access_date" text NOT NULL,
	"first_in" text,
	"last_out" text,
	"hours_on_site" double precision,
	"source" text DEFAULT 'turnstile' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "welfare_inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"inspection_date" text NOT NULL,
	"location" text NOT NULL,
	"vendor_id" text,
	"areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occupancy_count" integer,
	"capacity" integer,
	"overall_score" double precision,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inspected_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"reference" text NOT NULL,
	"full_name" text NOT NULL,
	"date_of_birth" text,
	"nationality" text,
	"vendor_id" text,
	"trade" text,
	"id_verified" integer DEFAULT 0 NOT NULL,
	"biometric_enrolled" integer DEFAULT 0 NOT NULL,
	"contract_issued" integer DEFAULT 0 NOT NULL,
	"contract_language" text,
	"recruitment_agency" text,
	"agreed_daily_rate" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"accommodation_ref" text,
	"inducted_at" text,
	"demobilised_at" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carbon_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"element" text,
	"baseline_tco2e" double precision NOT NULL,
	"target_tco2e" double precision NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carbon_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"budget_id" text,
	"description" text NOT NULL,
	"lifecycle_module" text NOT NULL,
	"scope" text,
	"factor_id" text,
	"quantity" double precision NOT NULL,
	"unit" text NOT NULL,
	"tco2e" double precision NOT NULL,
	"boq_item_id" text,
	"source_note" text,
	"entry_date" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carbon_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"material_category" text,
	"unit" text NOT NULL,
	"factor_kg_co2e_per_unit" double precision NOT NULL,
	"source" text NOT NULL,
	"is_product_specific" integer DEFAULT 0 NOT NULL,
	"epd_reference" text,
	"valid_until" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_value_commitments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"theme" text NOT NULL,
	"measure_ref" text,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"target_value" double precision NOT NULL,
	"delivered_value" double precision DEFAULT 0 NOT NULL,
	"proxy_value_per_unit" double precision,
	"due_date" text,
	"status" text DEFAULT 'committed' NOT NULL,
	"vendor_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_value_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"commitment_id" text NOT NULL,
	"company_id" text NOT NULL,
	"delivery_date" text NOT NULL,
	"value" double precision NOT NULL,
	"note" text,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waste_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"record_date" text NOT NULL,
	"stream" text NOT NULL,
	"destination" text NOT NULL,
	"tonnes" double precision NOT NULL,
	"carrier" text,
	"consignment_note" text,
	"cost" double precision,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currency_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text,
	"base_currency" text NOT NULL,
	"base_date" text NOT NULL,
	"portions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_source" text DEFAULT 'contractual' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate" double precision NOT NULL,
	"rate_date" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_reference" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_content_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"company_id" text NOT NULL,
	"reading_date" text NOT NULL,
	"value" double precision NOT NULL,
	"compliant" integer NOT NULL,
	"basis" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_content_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"metric" text NOT NULL,
	"target_value" double precision NOT NULL,
	"unit" text DEFAULT '%' NOT NULL,
	"period_start" text,
	"period_end" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permits" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"authority" text NOT NULL,
	"jurisdiction" text,
	"reference" text,
	"applied_at" text,
	"expected_days" integer,
	"due_at" text,
	"granted_at" text,
	"expires_at" text,
	"status" text DEFAULT 'not_started' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocking_task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"obligation_id" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"audience" text,
	"widgets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"dataset" text NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_by" text,
	"aggregations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_by" text,
	"sort_dir" text DEFAULT 'desc' NOT NULL,
	"limit_rows" integer DEFAULT 500 NOT NULL,
	"is_shared" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"company_id" text NOT NULL,
	"cadence" text NOT NULL,
	"day_of_period" integer,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "affected_persons_uq" ON "affected_persons" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "affected_persons_project_idx" ON "affected_persons" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "engagements_project_idx" ON "engagements" USING btree ("project_id","engagement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "grievances_uq" ON "grievances" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "grievances_project_idx" ON "grievances" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "grievances_sla_idx" ON "grievances" USING btree ("status","resolve_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "land_parcels_uq" ON "land_parcels" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "land_parcels_project_idx" ON "land_parcels" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "stakeholders_project_idx" ON "stakeholders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "labour_audits_project_idx" ON "labour_audits" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "labour_risk_flags_project_idx" ON "labour_risk_flags" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "labour_risk_flags_vendor_idx" ON "labour_risk_flags" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "payroll_entries_worker_idx" ON "payroll_entries" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "payroll_entries_project_period_idx" ON "payroll_entries" USING btree ("project_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "site_access_uq" ON "site_access_records" USING btree ("worker_id","access_date");--> statement-breakpoint
CREATE INDEX "site_access_project_date_idx" ON "site_access_records" USING btree ("project_id","access_date");--> statement-breakpoint
CREATE INDEX "welfare_inspections_project_idx" ON "welfare_inspections" USING btree ("project_id","inspection_date");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_uq" ON "workers" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "workers_project_idx" ON "workers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "workers_vendor_idx" ON "workers" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "carbon_budgets_project_idx" ON "carbon_budgets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "carbon_entries_project_idx" ON "carbon_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "carbon_entries_budget_idx" ON "carbon_entries" USING btree ("budget_id");--> statement-breakpoint
CREATE INDEX "carbon_factors_company_idx" ON "carbon_factors" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_value_commitments_uq" ON "social_value_commitments" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "social_value_commitments_project_idx" ON "social_value_commitments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "social_value_deliveries_commitment_idx" ON "social_value_deliveries" USING btree ("commitment_id");--> statement-breakpoint
CREATE INDEX "waste_records_project_idx" ON "waste_records" USING btree ("project_id","record_date");--> statement-breakpoint
CREATE INDEX "currency_configs_project_idx" ON "currency_configs" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_uq" ON "fx_rates" USING btree ("company_id","from_currency","to_currency","rate_date","source");--> statement-breakpoint
CREATE INDEX "fx_rates_pair_idx" ON "fx_rates" USING btree ("from_currency","to_currency","rate_date");--> statement-breakpoint
CREATE INDEX "local_content_readings_target_idx" ON "local_content_readings" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "local_content_targets_project_idx" ON "local_content_targets" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permits_uq" ON "permits" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "permits_project_idx" ON "permits" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "permits_status_due_idx" ON "permits" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "dashboards_company_idx" ON "dashboards" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "report_definitions_company_idx" ON "report_definitions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "report_schedules_report_idx" ON "report_schedules" USING btree ("report_id");