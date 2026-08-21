CREATE TABLE "assurance_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"email" text,
	"kind" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "company_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tools" jsonb NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"template_key" text NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"title" text,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"vendor_id" text,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text,
	"contact_id" text,
	"email" text
);
--> statement-breakpoint
CREATE TABLE "distribution_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"trade_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"address" text,
	"city" text,
	"country" text,
	"phone" text,
	"email" text,
	"website" text,
	"tax_id" text,
	"registration_number" text,
	"entity_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"division" text,
	"cost_type" text,
	"parent_id" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"tool" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" text PRIMARY KEY NOT NULL,
	"field_def_id" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"programme" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"number" text,
	"stage" text DEFAULT 'pre_construction' NOT NULL,
	"type" text,
	"department" text,
	"address" text,
	"city" text,
	"country" text,
	"latitude" double precision,
	"longitude" double precision,
	"start_date" text,
	"finish_date" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"value" double precision,
	"description" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"portfolio_id" text,
	"is_template" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"record_type" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"from_type" text NOT NULL,
	"from_id" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" text NOT NULL,
	"link_kind" text DEFAULT 'reference' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"tag_id" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text
);
--> statement-breakpoint
CREATE TABLE "watchers" (
	"id" text PRIMARY KEY NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wbs_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"segment_type" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"version" integer NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"folder_id" text,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_private" integer DEFAULT 0 NOT NULL,
	"checked_out_by" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"is_private" integer DEFAULT 0 NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_hyperlinks" (
	"id" text PRIMARY KEY NOT NULL,
	"from_revision_id" text NOT NULL,
	"to_sheet_id" text NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"w" double precision NOT NULL,
	"h" double precision NOT NULL,
	"label" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_markups" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"author_id" text NOT NULL,
	"layer" text DEFAULT 'personal' NOT NULL,
	"shapes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_pins" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"set_id" text NOT NULL,
	"revision" text NOT NULL,
	"file_id" text NOT NULL,
	"page_index" integer DEFAULT 0 NOT NULL,
	"extracted_text" text,
	"calibration" jsonb,
	"is_superseded" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"issued_date" text,
	"processing" text DEFAULT 'pending' NOT NULL,
	"source_file_id" text,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_sheets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"discipline" text DEFAULT 'other' NOT NULL,
	"area" text,
	"current_revision_id" text,
	"needs_review" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bim_elements" (
	"id" text PRIMARY KEY NOT NULL,
	"model_version_id" text NOT NULL,
	"project_id" text NOT NULL,
	"global_id" text NOT NULL,
	"ifc_type" text NOT NULL,
	"name" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"classification" text,
	"location_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bim_model_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"version" integer NOT NULL,
	"file_id" text NOT NULL,
	"cde_state" text DEFAULT 'wip' NOT NULL,
	"suitability" text DEFAULT 'S0' NOT NULL,
	"processing" text DEFAULT 'pending' NOT NULL,
	"element_count" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bim_models" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"discipline" text DEFAULT 'other' NOT NULL,
	"format" text NOT NULL,
	"current_version_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coordination_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"discipline" text,
	"assignee_id" text,
	"due_date" text,
	"element_global_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_version_id" text,
	"viewpoint" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"model_version_id" text NOT NULL,
	"transform" jsonb
);
--> statement-breakpoint
CREATE TABLE "asset_element_links" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"project_id" text NOT NULL,
	"global_id" text NOT NULL,
	"model_version_id" text
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"tag_code" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"classification_system" text,
	"classification_code" text,
	"parent_id" text,
	"location_id" text,
	"manufacturer" text,
	"model_number" text,
	"serial_number" text,
	"installed_at" text,
	"commissioned_at" text,
	"warranty_start" text,
	"warranty_months" double precision,
	"expected_life_years" double precision,
	"criticality" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"due_date" text,
	"required_state" text DEFAULT 'published' NOT NULL,
	"required_suitability" text,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensor_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"sensor_id" text NOT NULL,
	"value" double precision NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensors" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"asset_id" text,
	"location_id" text,
	"external_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"unit" text NOT NULL,
	"min_value" double precision,
	"max_value" double precision,
	"is_active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warranties" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"provider" text NOT NULL,
	"description" text,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"document_file_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"log_date" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"weather" jsonb,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"photo_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_drafted" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"file_id" text NOT NULL,
	"album" text,
	"caption" text,
	"taken_at" timestamp with time zone,
	"latitude" double precision,
	"longitude" double precision,
	"location_id" text,
	"ai_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_summary" text,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "punch_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"item_type" text,
	"assignee_id" text,
	"verifier_id" text,
	"vendor_id" text,
	"location_id" text,
	"due_date" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"before_photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"after_photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfis" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"subject" text NOT NULL,
	"question" text NOT NULL,
	"proposed_solution" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"assignee_id" text,
	"ball_in_court_id" text,
	"distribution" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_date" text,
	"official_response" text,
	"responded_by" text,
	"responded_at" timestamp with time zone,
	"cost_impact" text DEFAULT 'tbd' NOT NULL,
	"schedule_impact" text DEFAULT 'tbd' NOT NULL,
	"schedule_impact_days" integer,
	"location_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submittal_review_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"submittal_id" text NOT NULL,
	"position" integer NOT NULL,
	"reviewer_id" text NOT NULL,
	"is_parallel" integer DEFAULT 0 NOT NULL,
	"response_code" text,
	"comments" text,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "submittals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"spec_section" text,
	"submittal_type" text DEFAULT 'other' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"ball_in_court_id" text,
	"required_on_site" text,
	"lead_time_days" integer,
	"submit_by_date" text,
	"response_code" text,
	"responded_by" text,
	"responded_at" timestamp with time zone,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previous_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"record_type" text,
	"record_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"current_position" integer DEFAULT 0 NOT NULL,
	"started_by" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_step_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"step_type" text NOT NULL,
	"assignee_id" text NOT NULL,
	"delegated_to_id" text,
	"decision" text DEFAULT 'pending' NOT NULL,
	"comments" text,
	"due_date" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"record_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"steps" jsonb NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"claimant_id" text NOT NULL,
	"claimant_kind" text DEFAULT 'user' NOT NULL,
	"value" double precision,
	"unit" text,
	"basis" text NOT NULL,
	"contract_ref" text,
	"source_type" text,
	"source_id" text,
	"asserted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"jurisdiction" text,
	"screening_status" text,
	"screened_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"from_entity_id" text NOT NULL,
	"to_entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"since" text,
	"source" text,
	"confidence" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"location" text,
	"detected_or_reported" text DEFAULT 'reported' NOT NULL,
	"causal_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"content_hash" text NOT NULL,
	"file_id" text,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"independence_score" double precision DEFAULT 0 NOT NULL,
	"provenance" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb,
	"prev_hash" text NOT NULL,
	"entry_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_clause" text NOT NULL,
	"obligor_id" text,
	"obligee_id" text,
	"trigger" text NOT NULL,
	"deadline" timestamp with time zone,
	"warn_days_before" double precision,
	"evidence_requirement" text,
	"status" text DEFAULT 'open' NOT NULL,
	"satisfied_evidence_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"assertion_id" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"method" text NOT NULL,
	"result" text NOT NULL,
	"variance" double precision,
	"variance_percent" double precision,
	"confidence" double precision,
	"reviewer_id" text,
	"disposition" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"detector" text NOT NULL,
	"severity" text NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"evidence_refs" jsonb,
	"disposition" text DEFAULT 'new' NOT NULL,
	"reviewer_id" text,
	"reviewer_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_review_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"proposal" jsonb NOT NULL,
	"summary" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"agent_kind" text NOT NULL,
	"model" text NOT NULL,
	"requested_by" text NOT NULL,
	"input_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt" text,
	"output" text,
	"output_json" jsonb,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"status" text DEFAULT 'succeeded' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "assurance_grants_user_idx" ON "assurance_grants" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE INDEX "auth_events_user_idx" ON "auth_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_memberships_uq" ON "company_memberships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "company_memberships_user_idx" ON "company_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_templates_uq" ON "permission_templates" USING btree ("company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_uq" ON "project_memberships" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_user_idx" ON "project_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_company_idx" ON "project_memberships" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_vendor_idx" ON "contacts" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "distribution_group_members_group_idx" ON "distribution_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_groups_uq" ON "distribution_groups" USING btree ("company_id","project_id","name");--> statement-breakpoint
CREATE INDEX "vendors_company_idx" ON "vendors" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "comments_record_idx" ON "comments" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_codes_uq" ON "cost_codes" USING btree ("company_id","project_id","code");--> statement-breakpoint
CREATE INDEX "cost_codes_company_idx" ON "cost_codes" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_defs_uq" ON "custom_field_defs" USING btree ("company_id","project_id","tool","key");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_uq" ON "custom_field_values" USING btree ("field_def_id","record_type","record_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_record_idx" ON "custom_field_values" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "locations_project_idx" ON "locations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "locations_parent_idx" ON "locations" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "portfolios_company_idx" ON "portfolios" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "projects_company_idx" ON "projects" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_counters_uq" ON "record_counters" USING btree ("project_id","record_type");--> statement-breakpoint
CREATE INDEX "record_links_from_idx" ON "record_links" USING btree ("from_type","from_id");--> statement-breakpoint
CREATE INDEX "record_links_to_idx" ON "record_links" USING btree ("to_type","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_assignments_uq" ON "tag_assignments" USING btree ("tag_id","record_type","record_id");--> statement-breakpoint
CREATE INDEX "tag_assignments_record_idx" ON "tag_assignments" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_uq" ON "tags" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "watchers_uq" ON "watchers" USING btree ("record_type","record_id","user_id");--> statement-breakpoint
CREATE INDEX "watchers_user_idx" ON "watchers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wbs_segments_project_idx" ON "wbs_segments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "file_access_log_file_idx" ON "file_access_log" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_versions_uq" ON "file_versions" USING btree ("file_id","version");--> statement-breakpoint
CREATE INDEX "files_project_idx" ON "files" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "files_folder_idx" ON "files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "files_sha_idx" ON "files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "folders_project_idx" ON "folders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "folders_parent_idx" ON "folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "drawing_hyperlinks_from_idx" ON "drawing_hyperlinks" USING btree ("from_revision_id");--> statement-breakpoint
CREATE INDEX "drawing_markups_revision_idx" ON "drawing_markups" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "drawing_pins_sheet_idx" ON "drawing_pins" USING btree ("sheet_id");--> statement-breakpoint
CREATE INDEX "drawing_pins_record_idx" ON "drawing_pins" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "drawing_revisions_sheet_idx" ON "drawing_revisions" USING btree ("sheet_id");--> statement-breakpoint
CREATE INDEX "drawing_revisions_set_idx" ON "drawing_revisions" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "drawing_sets_project_idx" ON "drawing_sets" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_sheets_uq" ON "drawing_sheets" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "drawing_sheets_project_idx" ON "drawing_sheets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "bim_elements_version_idx" ON "bim_elements" USING btree ("model_version_id");--> statement-breakpoint
CREATE INDEX "bim_elements_global_idx" ON "bim_elements" USING btree ("project_id","global_id");--> statement-breakpoint
CREATE INDEX "bim_elements_type_idx" ON "bim_elements" USING btree ("model_version_id","ifc_type");--> statement-breakpoint
CREATE UNIQUE INDEX "bim_model_versions_uq" ON "bim_model_versions" USING btree ("model_id","version");--> statement-breakpoint
CREATE INDEX "bim_models_project_idx" ON "bim_models" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coordination_issues_uq" ON "coordination_issues" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "coordination_issues_project_idx" ON "coordination_issues" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "federation_groups_project_idx" ON "federation_groups" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_members_uq" ON "federation_members" USING btree ("group_id","model_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_element_links_uq" ON "asset_element_links" USING btree ("asset_id","global_id");--> statement-breakpoint
CREATE INDEX "asset_element_links_global_idx" ON "asset_element_links" USING btree ("project_id","global_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tag_uq" ON "assets" USING btree ("project_id","tag_code");--> statement-breakpoint
CREATE INDEX "assets_project_idx" ON "assets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "assets_parent_idx" ON "assets" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "delivery_milestones_project_idx" ON "delivery_milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sensor_readings_sensor_at_idx" ON "sensor_readings" USING btree ("sensor_id","at");--> statement-breakpoint
CREATE INDEX "sensors_project_idx" ON "sensors" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sensors_asset_idx" ON "sensors" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "warranties_asset_idx" ON "warranties" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_logs_uq" ON "daily_logs" USING btree ("project_id","log_date","created_by");--> statement-breakpoint
CREATE INDEX "daily_logs_project_idx" ON "daily_logs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "photos_project_idx" ON "photos" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "punch_items_uq" ON "punch_items" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "punch_items_project_idx" ON "punch_items" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rfis_number_uq" ON "rfis" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "rfis_project_idx" ON "rfis" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "rfis_status_idx" ON "rfis" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "submittal_review_steps_idx" ON "submittal_review_steps" USING btree ("submittal_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "submittals_uq" ON "submittals" USING btree ("project_id","number","revision");--> statement-breakpoint
CREATE INDEX "submittals_project_idx" ON "submittals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "workflow_instances_record_idx" ON "workflow_instances" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "workflow_instances_project_idx" ON "workflow_instances" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "workflow_step_instances_idx" ON "workflow_step_instances" USING btree ("instance_id","position");--> statement-breakpoint
CREATE INDEX "workflow_templates_company_idx" ON "workflow_templates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "assertions_project_idx" ON "assertions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "assertions_source_idx" ON "assertions" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "entities_company_idx" ON "entities" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_relationships_uq" ON "entity_relationships" USING btree ("from_entity_id","to_entity_id","kind");--> statement-breakpoint
CREATE INDEX "entity_relationships_from_idx" ON "entity_relationships" USING btree ("from_entity_id");--> statement-breakpoint
CREATE INDEX "entity_relationships_to_idx" ON "entity_relationships" USING btree ("to_entity_id");--> statement-breakpoint
CREATE INDEX "events_project_idx" ON "events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "evidence_project_idx" ON "evidence" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evidence_hash_idx" ON "evidence" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "ledger_company_seq_idx" ON "ledger_entries" USING btree ("company_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_object_idx" ON "ledger_entries" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "obligations_project_idx" ON "obligations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "obligations_deadline_idx" ON "obligations" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX "reconciliations_assertion_idx" ON "reconciliations" USING btree ("assertion_id");--> statement-breakpoint
CREATE INDEX "reconciliations_project_idx" ON "reconciliations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "signals_company_idx" ON "signals" USING btree ("company_id","disposition");--> statement-breakpoint
CREATE INDEX "signals_project_idx" ON "signals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ai_review_queue_status_idx" ON "ai_review_queue" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "ai_runs_company_idx" ON "ai_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ai_runs_project_idx" ON "ai_runs" USING btree ("project_id");