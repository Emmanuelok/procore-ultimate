CREATE TABLE "admin_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"expires_at" timestamp with time zone,
	"granted_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"datasets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"format" text DEFAULT 'json' NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"requested_by" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"object_type" text,
	"object_id" text,
	"name" text NOT NULL,
	"reason" text NOT NULL,
	"matter" text,
	"status" text DEFAULT 'active' NOT NULL,
	"custodian_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"placed_by" text NOT NULL,
	"released_by" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"object_type" text NOT NULL,
	"retain_months" integer NOT NULL,
	"action" text DEFAULT 'retain' NOT NULL,
	"basis" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_merges" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"source_vendor_id" text NOT NULL,
	"target_vendor_id" text NOT NULL,
	"movements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" text,
	"performed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"dataset" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"file_name" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"valid_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"report" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'private' NOT NULL,
	"owner_id" text NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_inbound_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"folder_id" text,
	"message_id" text,
	"from_address" text,
	"to_address" text,
	"subject" text,
	"received_at" timestamp with time zone,
	"status" text DEFAULT 'stored' NOT NULL,
	"reject_reason" text,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_issue_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"user_id" text NOT NULL,
	"notified_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"purpose" text DEFAULT 'for_information' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"set_id" text,
	"revision_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"transmittal_id" text,
	"issued_at" timestamp with time zone,
	"issued_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_sheet_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_value" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"level" text DEFAULT 'read' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bim_element_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"link_type" text NOT NULL,
	"global_id" text NOT NULL,
	"model_version_id" text,
	"target_id" text NOT NULL,
	"role" text DEFAULT 'construct' NOT NULL,
	"quantity" double precision,
	"unit" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bim_version_diffs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"model_id" text NOT NULL,
	"base_version_id" text NOT NULL,
	"target_version_id" text NOT NULL,
	"added_count" integer DEFAULT 0 NOT NULL,
	"removed_count" integer DEFAULT 0 NOT NULL,
	"modified_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"by_type" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sample_added" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sample_removed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sample_modified" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clash_results" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"test_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text DEFAULT 'hard' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"global_id_a" text NOT NULL,
	"name_a" text,
	"ifc_type_a" text,
	"model_version_id_a" text,
	"discipline_a" text,
	"global_id_b" text NOT NULL,
	"name_b" text,
	"ifc_type_b" text,
	"model_version_id_b" text,
	"discipline_b" text,
	"penetration_mm" double precision,
	"distance_mm" double precision,
	"overlap_volume" double precision,
	"centroid" jsonb,
	"storey" text,
	"issue_id" text,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"reviewed_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clash_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"federation_id" text,
	"name" text NOT NULL,
	"rule_kind" text DEFAULT 'discipline_pair' NOT NULL,
	"left_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"right_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tolerance_mm" double precision DEFAULT 10 NOT NULL,
	"clearance_mm" double precision DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'never_run' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_by" text,
	"last_error" text,
	"last_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coordination_issue_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geofences" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text DEFAULT 'work_zone' NOT NULL,
	"description" text,
	"ring" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"colour" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reality_captures" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'captured' NOT NULL,
	"captured_at" text,
	"file_id" text,
	"model_version_id" text,
	"location_id" text,
	"alignment" jsonb,
	"coverage_percent" double precision,
	"deviation" jsonb,
	"viewer_url" text,
	"latitude" double precision,
	"longitude" double precision,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestone_containers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"milestone_id" text NOT NULL,
	"model_id" text,
	"document_file_id" text,
	"label" text NOT NULL,
	"required_state" text DEFAULT 'published' NOT NULL,
	"required_suitability" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensor_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sensor_id" text NOT NULL,
	"asset_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"value" double precision,
	"threshold" double precision,
	"breach_count" integer DEFAULT 1 NOT NULL,
	"first_breach_at" timestamp with time zone,
	"last_breach_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"event_id" text,
	"signal_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warranty_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"warranty_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'lodged' NOT NULL,
	"lodged_at" text,
	"responded_at" text,
	"closed_at" text,
	"resolution" text,
	"punch_item_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_log_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_escalations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"level" integer NOT NULL,
	"days_overdue" integer NOT NULL,
	"notified_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"observation_type" text DEFAULT 'other' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"assignee_id" text,
	"verifier_id" text,
	"vendor_id" text,
	"distribution" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_date" text,
	"location_id" text,
	"sheet_id" text,
	"pin_x" double precision,
	"pin_y" double precision,
	"photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"converted_to_type" text,
	"converted_to_id" text,
	"converted_at" timestamp with time zone,
	"ready_for_review_by" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_albums" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_private" integer DEFAULT 0 NOT NULL,
	"allowed_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "punch_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"trade" text,
	"item_type" text,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"default_verifier_id" text,
	"default_due_days" integer,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfi_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"rfi_id" text NOT NULL,
	"body" text NOT NULL,
	"cost_impact" text,
	"schedule_impact" text,
	"schedule_impact_days" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"author_id" text NOT NULL,
	"adopted_by" text,
	"adopted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submittal_response_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"is_approval" integer DEFAULT 0 NOT NULL,
	"is_resubmit" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"user_id" text NOT NULL,
	"default_channel" text DEFAULT 'in_app' NOT NULL,
	"digest" text DEFAULT 'off' NOT NULL,
	"kinds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"muted_project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"muted_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quiet_hours" jsonb,
	"last_digest_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authority_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"user_id" text NOT NULL,
	"object_type" text DEFAULT 'any' NOT NULL,
	"max_amount" double precision NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" text,
	"effective_to" text,
	"granted_by" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflict_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"nature" text NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"notes" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detector_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"detector" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"precision_floor" double precision,
	"min_reviewed_for_floor" integer DEFAULT 10 NOT NULL,
	"thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detector_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"scope" text DEFAULT 'project' NOT NULL,
	"actor_id" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"detectors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals_created" integer DEFAULT 0 NOT NULL,
	"signals_refreshed" integer DEFAULT 0 NOT NULL,
	"signals_auto_closed" integer DEFAULT 0 NOT NULL,
	"signals_superseded" integer DEFAULT 0 NOT NULL,
	"per_detector" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_pack_access" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"purpose" text DEFAULT 'audit' NOT NULL,
	"root" text NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"case_id" text,
	"seal_id" text,
	"seal_sequence" integer,
	"ledger_head_hash" text,
	"anchor_submission_id" text,
	"statement" text,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrity_case_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"case_id" text NOT NULL,
	"item_type" text NOT NULL,
	"item_id" text,
	"from_seq" integer,
	"to_seq" integer,
	"note" text,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrity_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"assigned_to" text,
	"referral_target" text,
	"referred_at" timestamp with time zone,
	"opened_by" text NOT NULL,
	"closed_at" timestamp with time zone,
	"closure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrity_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"scope" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_label" text,
	"score" double precision NOT NULL,
	"band" text NOT NULL,
	"open_signals" integer DEFAULT 0 NOT NULL,
	"confirmed_signals" integer DEFAULT 0 NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"assertion_kind" text NOT NULL,
	"supported_within_percent" double precision DEFAULT 5 NOT NULL,
	"partial_within_percent" double precision DEFAULT 15 NOT NULL,
	"min_independence" double precision DEFAULT 0 NOT NULL,
	"max_capture_gap_days" double precision,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screening_results" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"list" text NOT NULL,
	"match_score" double precision DEFAULT 0 NOT NULL,
	"matched_name" text,
	"matched_ref" text,
	"list_snapshot_hash" text NOT NULL,
	"list_source" text NOT NULL,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"screened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"role" text DEFAULT 'supporting' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boq_schedule_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"boq_item_id" text NOT NULL,
	"task_id" text NOT NULL,
	"allocation_percent" double precision DEFAULT 100 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cvr_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"period_end" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"value_to_date" double precision DEFAULT 0 NOT NULL,
	"certified_to_date" double precision DEFAULT 0 NOT NULL,
	"cost_to_date" double precision DEFAULT 0 NOT NULL,
	"accruals" double precision DEFAULT 0 NOT NULL,
	"wip" double precision DEFAULT 0 NOT NULL,
	"margin" double precision DEFAULT 0 NOT NULL,
	"margin_percent" double precision,
	"over_under_certification" double precision DEFAULT 0 NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prepared_by" text NOT NULL,
	"finalised_by" text,
	"finalised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cvr_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"cvr_period_id" text NOT NULL,
	"scope" text NOT NULL,
	"label" text NOT NULL,
	"package_ref" text,
	"value_to_date" double precision DEFAULT 0 NOT NULL,
	"certified_to_date" double precision DEFAULT 0 NOT NULL,
	"cost_to_date" double precision DEFAULT 0 NOT NULL,
	"accruals" double precision DEFAULT 0 NOT NULL,
	"margin" double precision DEFAULT 0 NOT NULL,
	"margin_percent" double precision,
	"basis" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daywork_items" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"unit" text,
	"qty" double precision NOT NULL,
	"rate" double precision NOT NULL,
	"amount" double precision NOT NULL,
	"percent_addition" double precision DEFAULT 0 NOT NULL,
	"amount_with_addition" double precision DEFAULT 0 NOT NULL,
	"resource_ref" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daywork_sheets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text,
	"variation_id" text,
	"number" integer NOT NULL,
	"reference" text,
	"work_date" text NOT NULL,
	"description" text NOT NULL,
	"location" text,
	"instruction_ref" text,
	"basis" text DEFAULT 'schedule_rates' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"percent_additions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"net_total" double precision DEFAULT 0 NOT NULL,
	"addition_total" double precision DEFAULT 0 NOT NULL,
	"gross_total" double precision DEFAULT 0 NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "final_account_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"final_account_id" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount" double precision NOT NULL,
	"source_type" text,
	"source_id" text,
	"source_hash" text,
	"manual" boolean DEFAULT false NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "final_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"boq_id" text,
	"number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"contract_sum" double precision DEFAULT 0 NOT NULL,
	"final_contract_sum" double precision DEFAULT 0 NOT NULL,
	"certified_to_date" double precision DEFAULT 0 NOT NULL,
	"balance_due" double precision DEFAULT 0 NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"statement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone,
	"issued_by" text,
	"issued_at" timestamp with time zone,
	"contractor_signed_by" text,
	"contractor_signed_at" timestamp with time zone,
	"employer_signed_by" text,
	"employer_signed_at" timestamp with time zone,
	"dispute_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fluctuation_calculations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text,
	"valuation_id" text,
	"formula" text NOT NULL,
	"base_date" text NOT NULL,
	"current_period" text NOT NULL,
	"non_adjustable" double precision DEFAULT 0 NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"work_done_amount" double precision DEFAULT 0 NOT NULL,
	"factor" double precision DEFAULT 1 NOT NULL,
	"adjustment" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"computed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fluctuation_series" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"source" text,
	"country" text,
	"values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisional_sum_expenditures" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"provisional_sum_id" text NOT NULL,
	"description" text NOT NULL,
	"amount" double precision NOT NULL,
	"spent_on" text NOT NULL,
	"source_type" text,
	"source_id" text,
	"approved_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisional_sums" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"boq_id" text NOT NULL,
	"boq_item_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"allowance" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"instruction_ref" text,
	"instructed_at" text,
	"expended_total" double precision DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_benchmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"code" text,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"rate" double precision NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"region" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"as_of_date" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remeasurements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"boq_id" text NOT NULL,
	"boq_item_id" text NOT NULL,
	"original_quantity" double precision,
	"remeasured_quantity" double precision NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"measured_at" text NOT NULL,
	"measured_by" text NOT NULL,
	"witnessed_by" text,
	"agreed_by" text,
	"agreed_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"dispute_reason" text,
	"note" text,
	"evidence_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text,
	"boq_id" text,
	"kind" text NOT NULL,
	"amount" double precision NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"released_on" text NOT NULL,
	"bond_reference" text,
	"certificate_id" text,
	"reason" text,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "valuation_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"valuation_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"source_type" text,
	"source_id" text,
	"amount_to_date" double precision DEFAULT 0 NOT NULL,
	"previous_amount" double precision DEFAULT 0 NOT NULL,
	"this_period" double precision DEFAULT 0 NOT NULL,
	"retention_applies" boolean DEFAULT true NOT NULL,
	"evidence_ref" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variation_build_up_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"variation_id" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"boq_item_id" text,
	"description" text NOT NULL,
	"unit" text,
	"qty" double precision NOT NULL,
	"rate" double precision NOT NULL,
	"amount" double precision NOT NULL,
	"basis" text NOT NULL,
	"factor" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accepted_programmes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"number" integer NOT NULL,
	"revision" text,
	"schedule_id" text,
	"submitted_at" text NOT NULL,
	"submitted_by" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"decision_due_date" text,
	"decision_at" text,
	"decision_by" text,
	"rejection_reason" text,
	"rejection_detail" text,
	"planned_completion" text,
	"terminal_float_days" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ce_quotations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"event_id" text NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"defined_cost" double precision DEFAULT 0 NOT NULL,
	"fee_percent" double precision DEFAULT 0 NOT NULL,
	"fee" double precision DEFAULT 0 NOT NULL,
	"risk_allowance" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"time_impact_days" integer DEFAULT 0 NOT NULL,
	"assumptions" text,
	"submitted_by" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reply_due_date" text,
	"replied_by" text,
	"replied_at" timestamp with time zone,
	"reply_reason" text,
	"deemed_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_compliance_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"kind" text NOT NULL,
	"clause_ref" text,
	"requirement" text NOT NULL,
	"required_amount" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"required_until" text,
	"evidence_type" text,
	"evidence_id" text,
	"evidence_expiry" text,
	"evidence_amount" double precision,
	"status" text DEFAULT 'unknown' NOT NULL,
	"reason" text,
	"obligation_id" text,
	"last_checked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_obligation_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"contract_event_id" text,
	"obligation_id" text NOT NULL,
	"kind" text NOT NULL,
	"clause_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_calendars" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"schedule_id" text,
	"name" text NOT NULL,
	"external_id" text,
	"workdays" jsonb DEFAULT '[0,1,1,1,1,1,0]'::jsonb NOT NULL,
	"holidays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hours_per_day" double precision DEFAULT 8 NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_constraints" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"task_id" text,
	"number" integer NOT NULL,
	"description" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_id" text,
	"need_by_date" text,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	"resolution" text,
	"escalated_at" timestamp with time zone,
	"raised_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"schedule_id" text,
	"target_schedule_id" text,
	"format" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"sha256" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"diff" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_narratives" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"title" text NOT NULL,
	"period_start" text,
	"period_end" text,
	"data_date" text,
	"body" text NOT NULL,
	"metrics" jsonb,
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_task_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"task_id" text NOT NULL,
	"name" text NOT NULL,
	"resource_type" text DEFAULT 'labour' NOT NULL,
	"external_id" text,
	"unit" text,
	"budgeted_units" double precision DEFAULT 0 NOT NULL,
	"actual_units" double precision DEFAULT 0 NOT NULL,
	"remaining_units" double precision,
	"unit_rate" double precision,
	"budgeted_cost" double precision DEFAULT 0 NOT NULL,
	"actual_cost" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disruption_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"claim_id" text,
	"method" text NOT NULL,
	"trade" text,
	"title" text NOT NULL,
	"baseline_from" text,
	"baseline_to" text,
	"impacted_from" text,
	"impacted_to" text,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"series" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lost_hours" double precision,
	"amount" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"justification" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forensic_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"claim_id" text,
	"schedule_id" text,
	"baseline_id" text,
	"method" text NOT NULL,
	"mip_code" text,
	"scl_reference" text,
	"title" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_days" double precision,
	"summary" text,
	"rationale" text,
	"run_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_float_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"ownership" text DEFAULT 'project' NOT NULL,
	"concurrency_rule" text DEFAULT 'sca_protocol' NOT NULL,
	"concurrency_threshold_days" integer DEFAULT 1 NOT NULL,
	"pacing_threshold_days" integer DEFAULT 2 NOT NULL,
	"basis" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quantum_calculations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"claim_id" text,
	"method" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount" double precision,
	"formula" text,
	"workings" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_adjudications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"payment_claim_id" text,
	"regime" text NOT NULL,
	"status" text DEFAULT 'notice' NOT NULL,
	"referring_party" text DEFAULT 'claimant' NOT NULL,
	"disputed_amount" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"adjudicator_name" text,
	"nominating_body" text,
	"notice_at" text,
	"referral_at" text,
	"response_due_at" text,
	"response_at" text,
	"decision_due_at" text,
	"decision_at" text,
	"decision_amount" double precision,
	"decision_summary" text,
	"enforced_at" text,
	"timetable" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_security_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"bank_reference" text,
	"trustee" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"beneficiary_vendor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opened_at" text,
	"closed_at" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_security_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount" double precision NOT NULL,
	"beneficiary_vendor_id" text,
	"related_payment_id" text,
	"related_invoice_id" text,
	"reference" text,
	"occurred_at" text NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statutory_liens" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'noticed' NOT NULL,
	"claimant_name" text NOT NULL,
	"claimant_vendor_id" text,
	"tier" integer DEFAULT 1 NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"jurisdiction" text,
	"served_at" text,
	"filed_at" text,
	"last_furnished_at" text,
	"deadline_at" text,
	"deadline_basis" text,
	"property_description" text,
	"related_commitment_id" text,
	"related_invoice_id" text,
	"obligation_id" text,
	"release_document_id" text,
	"released_at" text,
	"bond_reference" text,
	"dispute_reason" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_chain_payment_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"regime" text DEFAULT 'generic' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"generated_by" text NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_grievances" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"channel_id" text,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"tracking_hash" text NOT NULL,
	"category" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"summary" text NOT NULL,
	"detail_text" text,
	"language" text,
	"is_anonymous" integer DEFAULT 1 NOT NULL,
	"worker_id" text,
	"vendor_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_due_at" timestamp with time zone,
	"first_responded_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"outcome" text,
	"updates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_flag_id" text,
	"signal_id" text,
	"sla_breached" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_voice_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handler_user_id" text,
	"response_sla_hours" integer DEFAULT 72 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_forecasts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"probability" double precision,
	"p50_uplift" double precision,
	"p80_uplift" double precision,
	"reference_class" text,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"basis" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"report_id" text NOT NULL,
	"schedule_id" text,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"project_id" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"truncated" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"result_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery_dispatched" integer DEFAULT 0 NOT NULL,
	"delivery_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"run_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_mapping_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"source_id" text,
	"dataset" text NOT NULL,
	"name" text NOT NULL,
	"column_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"contributor_company_id" text NOT NULL,
	"contributor_project_id" text NOT NULL,
	"metric" text NOT NULL,
	"asset_class" text NOT NULL,
	"region" text NOT NULL,
	"currency" text,
	"sample_id" text NOT NULL,
	"superseded_sample_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_forecasts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"metric" text NOT NULL,
	"reference_class" text NOT NULL,
	"asset_class" text NOT NULL,
	"region" text NOT NULL,
	"size_band" text,
	"procurement_route" text,
	"budget" double precision,
	"currency" text,
	"contributor_count" integer DEFAULT 0 NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"p50_uplift" double precision,
	"p80_uplift" double precision,
	"exceedance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disclosures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_seed_markers" (
	"metric" text PRIMARY KEY NOT NULL,
	"rows_inserted" integer DEFAULT 0 NOT NULL,
	"materialised_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_watermarks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"last_verified_seq" integer DEFAULT 0 NOT NULL,
	"last_verified_hash" text,
	"verified_count" integer DEFAULT 0 NOT NULL,
	"deep_verified_seq" integer DEFAULT 0 NOT NULL,
	"last_verdict" text DEFAULT 'ok' NOT NULL,
	"broken_at_seq" integer,
	"broken_reason" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bond_facilities" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"provider_vendor_id" text,
	"facility_reference" text,
	"limit_amount" double precision NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"permitted_bond_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commission_rate_pct" double precision,
	"collateral_amount" double precision,
	"collateral_note" text,
	"effective_from" text,
	"effective_to" text,
	"review_date" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_premiums" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"policy_id" text NOT NULL,
	"kind" text DEFAULT 'premium' NOT NULL,
	"amount" double precision NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"period_start" text,
	"period_end" text,
	"due_date" text,
	"paid_at" text,
	"reference" text,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"contract_id" text,
	"vendor_id" text,
	"policy_type" text NOT NULL,
	"required_by_clause" text NOT NULL,
	"minimum_limit" double precision,
	"limit_basis" text,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"maximum_deductible" double precision,
	"waiver_of_subrogation" integer DEFAULT 0 NOT NULL,
	"additional_insured_required" integer DEFAULT 0 NOT NULL,
	"maintain_months_after_completion" integer,
	"territorial_limits" text,
	"notes" text,
	"status" text DEFAULT 'required' NOT NULL,
	"waived_by" text,
	"waived_at" timestamp with time zone,
	"waiver_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_pushes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"project_id" text NOT NULL,
	"score" double precision,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pushed' NOT NULL,
	"notified_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"application_id" text,
	"dismissed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developer_sandboxes" (
	"company_id" text PRIMARY KEY NOT NULL,
	"purpose" text,
	"enabled_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_export_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"system" text NOT NULL,
	"feed" text NOT NULL,
	"field_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"notes" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backcharges" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"vendor_id" text,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"reason_code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"amount" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sov_line_id" text,
	"commitment_change_id" text,
	"settled_payment_id" text,
	"issued_by" text,
	"issued_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"dispute_reason" text,
	"settled_at" timestamp with time zone,
	"settled_by" text,
	"void_reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_contingency_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"budget_id" text NOT NULL,
	"budget_line_item_id" text NOT NULL,
	"contingency_id" text NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_postings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"budget_id" text NOT NULL,
	"budget_line_item_id" text NOT NULL,
	"component" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_reference" text,
	"currency" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"previous_amount" double precision DEFAULT 0 NOT NULL,
	"delta" double precision DEFAULT 0 NOT NULL,
	"basis" text,
	"reconciliation_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"budget_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"run_by" text,
	"lines_checked" integer DEFAULT 0 NOT NULL,
	"lines_updated" integer DEFAULT 0 NOT NULL,
	"drift_count" integer DEFAULT 0 NOT NULL,
	"drift_amount" double precision DEFAULT 0 NOT NULL,
	"drift" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_views" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"budget_id" text,
	"name" text NOT NULL,
	"description" text,
	"is_default" integer DEFAULT 0 NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculated_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grouping" text DEFAULT 'none' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"tier" text DEFAULT 'two_tier' NOT NULL,
	"require_quote_for_subcontract" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_markup_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"prime_contract_id" text,
	"name" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_status_history" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitment_closeouts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"override_reason" text,
	"overridden_by" text,
	"overridden_at" timestamp with time zone,
	"final_release_payment_id" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_sweep_state" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"last_status" text NOT NULL,
	"last_finding_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_expiry_notices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_hold_notice_at" timestamp with time zone,
	"swept_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"kind" text NOT NULL,
	"template_key" text NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"file_id" text,
	"sha256" text,
	"content_type" text,
	"merge_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routed_at" timestamp with time zone,
	"routed_by" text,
	"signed_at" timestamp with time zone,
	"signed_file_id" text,
	"webhook_token_hash" text,
	"void_reason" text,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_cost_code_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"erp_system" text DEFAULT 'other' NOT NULL,
	"gl_account" text NOT NULL,
	"gl_sub_account" text,
	"gl_description" text,
	"cost_code_id" text NOT NULL,
	"cost_code" text NOT NULL,
	"cost_type" text NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"key" text NOT NULL,
	"route" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_line_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"invoice_line_item_id" text NOT NULL,
	"status" text NOT NULL,
	"approved_amount" double precision DEFAULT 0 NOT NULL,
	"billed_amount" double precision DEFAULT 0 NOT NULL,
	"note" text,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_payment_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"prime_contract_id" text NOT NULL,
	"payment_application_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"amount" double precision NOT NULL,
	"currency" text NOT NULL,
	"received_date" text NOT NULL,
	"method" text DEFAULT 'ach' NOT NULL,
	"payment_reference" text,
	"bank_reference" text,
	"notes" text,
	"void_reason" text,
	"voided_by" text,
	"voided_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"scheduled_date" text NOT NULL,
	"payment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_amount" double precision DEFAULT 0 NOT NULL,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"remittance_sent_at" timestamp with time zone,
	"cancel_reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"issued_by" text,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prime_contract_compliance_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"prime_contract_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"required" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'missing' NOT NULL,
	"document_id" text,
	"reference" text,
	"issuer" text,
	"issued_date" text,
	"effective_date" text,
	"expiry_date" text,
	"received_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"waived_by" text,
	"waived_reason" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prime_stored_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"prime_contract_id" text NOT NULL,
	"sov_line_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'stored' NOT NULL,
	"location" text DEFAULT 'on_site' NOT NULL,
	"location_notes" text,
	"quantity" double precision,
	"unit" text,
	"value" double precision NOT NULL,
	"incorporated_value" double precision DEFAULT 0 NOT NULL,
	"stored_date" text NOT NULL,
	"incorporated_date" text,
	"supplier_invoice_reference" text,
	"supplier_vendor_id" text,
	"insured" integer DEFAULT 0 NOT NULL,
	"insurance_reference" text,
	"billed_on_application_id" text,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_portal_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"commitment_id" text,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '["invoices"]'::jsonb NOT NULL,
	"contact_email" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec_revision_notices" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"section_id" text NOT NULL,
	"section_code" text NOT NULL,
	"revision_id" text NOT NULL,
	"previous_revision_id" text,
	"book_id" text,
	"revision" text NOT NULL,
	"changed_clause_count" integer DEFAULT 0 NOT NULL,
	"requirements_superseded" integer DEFAULT 0 NOT NULL,
	"requirements_to_reconfirm" integer DEFAULT 0 NOT NULL,
	"requirements_new" integer DEFAULT 0 NOT NULL,
	"submittals_affected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notified_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_agenda_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"meeting_type" text DEFAULT 'progress' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contract_requirement" text,
	"is_default" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_minute_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"meeting_id" text NOT NULL,
	"minutes_version" integer DEFAULT 1 NOT NULL,
	"user_id" text,
	"contact_id" text,
	"attendee_id" text,
	"recipient_name" text NOT NULL,
	"email" text,
	"channel" text DEFAULT 'platform' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"failure_reason" text,
	"document_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_regulatory_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"form" text NOT NULL,
	"status" text DEFAULT 'generated' NOT NULL,
	"period_year" integer,
	"period_from" text,
	"period_to" text,
	"incident_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sha256" text NOT NULL,
	"file_id" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"caveats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"certified_by" text,
	"certified_at" timestamp with time zone,
	"certifier_title" text,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"submission_reference" text,
	"supersedes_id" text,
	"superseded_by_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_risk_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"as_of_date" text NOT NULL,
	"window_from" text NOT NULL,
	"window_to" text NOT NULL,
	"score" double precision,
	"band" text DEFAULT 'unrated' NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage" double precision,
	"signal_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_sensor_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"source" text DEFAULT 'wearable' NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'high' NOT NULL,
	"device_id" text,
	"device_model" text,
	"worker_id" text,
	"reported_person_name" text,
	"vendor_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"location_id" text,
	"location_text" text,
	"latitude" double precision,
	"longitude" double precision,
	"measurement_value" double precision,
	"measurement_unit" text,
	"threshold_value" double precision,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"acknowledge_due_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"response_seconds" double precision,
	"response_note" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"outcome" text,
	"incident_id" text,
	"observation_id" text,
	"signal_id" text,
	"external_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibrated_instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"instrument_type" text,
	"manufacturer" text,
	"model" text,
	"serial_number" text NOT NULL,
	"asset_tag" text,
	"equipment_id" text,
	"owner_vendor_id" text,
	"owner_name" text,
	"custodian" text,
	"storage_location" text,
	"range_min" double precision,
	"range_max" double precision,
	"range_unit" text,
	"accuracy" text,
	"calibration_standard" text,
	"calibration_interval_months" integer DEFAULT 12 NOT NULL,
	"last_calibrated_at" text,
	"calibration_due_date" text,
	"certificate_number" text,
	"certificate_file_id" text,
	"calibrated_by_organisation" text,
	"calibration_accreditation" text,
	"status" text DEFAULT 'in_service' NOT NULL,
	"out_of_service_reason" text,
	"signal_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"calibrated_at" text NOT NULL,
	"calibration_due_date" text,
	"result" text DEFAULT 'pass' NOT NULL,
	"as_found_condition" text,
	"as_left_condition" text,
	"deviation_found" double precision,
	"certificate_number" text,
	"certificate_file_id" text,
	"calibrated_by_organisation" text,
	"technician_name" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concrete_pours" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"pour_name" text NOT NULL,
	"element_type" text,
	"location_id" text,
	"location_text" text,
	"drawing_sheet_id" text,
	"drawing_reference" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"planned_date" text,
	"poured_at" timestamp with time zone,
	"mix_reference" text,
	"specified_grade" text,
	"specified_strength_mpa" double precision,
	"test_age_days" integer DEFAULT 28 NOT NULL,
	"acceptance_code" text DEFAULT 'specified_only' NOT NULL,
	"volume_m3" double precision,
	"supplier_vendor_id" text,
	"batch_plant" text,
	"delivery_tickets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"batch_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"material_certificate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slump_mm" double precision,
	"slump_spec_min" double precision,
	"slump_spec_max" double precision,
	"air_content_pct" double precision,
	"concrete_temp_c" double precision,
	"ambient_temp_c" double precision,
	"curing_method" text,
	"curing_started_at" timestamp with time zone,
	"itp_activity_id" text,
	"pre_pour_checklist_id" text,
	"hold_point_released_at" timestamp with time zone,
	"hold_point_released_by" text,
	"poured_by_vendor_id" text,
	"supervised_by" text,
	"specimen_count" integer DEFAULT 0 NOT NULL,
	"tested_specimen_count" integer DEFAULT 0 NOT NULL,
	"failed_specimen_count" integer DEFAULT 0 NOT NULL,
	"mean_strength_mpa" double precision,
	"min_strength_mpa" double precision,
	"standard_deviation_mpa" double precision,
	"acceptance_verdict" text,
	"acceptance_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ncr_id" text,
	"concession_id" text,
	"signal_id" text,
	"photo_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concrete_test_specimens" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"pour_id" text NOT NULL,
	"specimen_ref" text NOT NULL,
	"specimen_type" text DEFAULT 'cube' NOT NULL,
	"cast_at" text,
	"test_age_days" integer DEFAULT 28 NOT NULL,
	"test_date" text,
	"strength_mpa" double precision,
	"density_kg_m3" double precision,
	"result" text DEFAULT 'pending' NOT NULL,
	"failure_mode" text,
	"lab_name" text,
	"lab_accreditation" text,
	"certificate_number" text,
	"certificate_file_id" text,
	"void_reason" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "defects_liability_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"scope_description" text,
	"turnover_package_id" text,
	"system_id" text,
	"asset_id" text,
	"commitment_id" text,
	"vendor_id" text,
	"contract_clause" text,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"duration_months" integer,
	"status" text DEFAULT 'not_started' NOT NULL,
	"make_good_obligation_id" text,
	"extended_to_date" text,
	"extension_reason" text,
	"retention_release_date" text,
	"retention_amount" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"final_certificate_date" text,
	"final_certificate_file_id" text,
	"defect_count" integer DEFAULT 0 NOT NULL,
	"open_defect_count" integer DEFAULT 0 NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"signal_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dlp_defects" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"dlp_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"reported_at" text,
	"reported_by_name" text,
	"reported_by_organisation" text,
	"severity" text DEFAULT 'minor' NOT NULL,
	"location_id" text,
	"location_text" text,
	"asset_id" text,
	"system_id" text,
	"responsible_vendor_id" text,
	"status" text DEFAULT 'reported' NOT NULL,
	"ncr_id" text,
	"punch_item_id" text,
	"warranty_claim_id" text,
	"rework_item_id" text,
	"target_rectification_date" text,
	"rectified_at" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"dispute_reason" text,
	"cost" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"photo_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itp_activity_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"itp_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"party" text NOT NULL,
	"required" integer DEFAULT 1 NOT NULL,
	"user_id" text,
	"vendor_id" text,
	"organisation" text,
	"contact_name" text,
	"contact_email" text,
	"accreditation" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"notified_at" timestamp with time zone,
	"notified_by" text,
	"attended_at" timestamp with time zone,
	"attended_by_name" text,
	"released_by" text,
	"released_at" timestamp with time zone,
	"released_by_name" text,
	"note" text,
	"report_file_id" text,
	"signature_file_id" text,
	"concession_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_test_certificates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"certificate_number" text NOT NULL,
	"certificate_type" text DEFAULT 'en_10204_3_1' NOT NULL,
	"material_description" text NOT NULL,
	"material_type" text,
	"material_grade" text,
	"standard" text,
	"heat_number" text,
	"batch_number" text,
	"cast_number" text,
	"lot_number" text,
	"serial_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quantity" double precision,
	"unit" text,
	"manufacturer" text,
	"mill_name" text,
	"supplier_vendor_id" text,
	"origin_country" text,
	"issued_at" text,
	"received_at" text,
	"material_trace_record_id" text,
	"material_item_id" text,
	"delivery_id" text,
	"spec_section_id" text,
	"spec_clause_ref" text,
	"submittal_id" text,
	"required_properties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"measured_properties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verification_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"verification_notes" text,
	"ncr_id" text,
	"concession_id" text,
	"document_file_id" text,
	"attachment_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"installed_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"installed_description" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ndt_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"weld_id" text NOT NULL,
	"method" text NOT NULL,
	"technique_ref" text,
	"procedure_ref" text,
	"acceptance_standard" text,
	"coverage_description" text,
	"coverage_percent" double precision,
	"requested_at" timestamp with time zone,
	"requested_by" text,
	"performed_at" timestamp with time zone,
	"performed_by_organisation" text,
	"technician_name" text,
	"technician_level" text,
	"technician_cert_number" text,
	"result" text DEFAULT 'pending' NOT NULL,
	"defect_type" text,
	"defect_length_mm" double precision,
	"defect_location" text,
	"report_number" text,
	"report_file_id" text,
	"retest_of_id" text,
	"ncr_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_training_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"training_kind" text DEFAULT 'hands_on' NOT NULL,
	"system_id" text,
	"asset_id" text,
	"turnover_package_id" text,
	"vendor_id" text,
	"trainer_name" text,
	"trainer_organisation" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"scheduled_for" text,
	"delivered_at" text,
	"duration_hours" double precision,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attendee_count" integer DEFAULT 0 NOT NULL,
	"competency_assessed" integer DEFAULT 0 NOT NULL,
	"materials_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recording_file_id" text,
	"attendance_sheet_file_id" text,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"acceptance_note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_guarantees" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"system_id" text,
	"asset_id" text,
	"turnover_package_id" text,
	"commitment_id" text,
	"vendor_id" text,
	"contract_clause" text,
	"parameter" text NOT NULL,
	"operator" text DEFAULT 'at_least' NOT NULL,
	"guaranteed_value" double precision,
	"guaranteed_min" double precision,
	"guaranteed_max" double precision,
	"unit" text,
	"tolerance_percent" double precision,
	"measurement_method" text,
	"test_record_id" text,
	"measured_value" double precision,
	"measured_at" timestamp with time zone,
	"measured_by" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"status" text DEFAULT 'declared' NOT NULL,
	"shortfall" double precision,
	"shortfall_percent" double precision,
	"ld_rate_per_unit" double precision,
	"ld_rate_unit" text,
	"ld_cap_amount" double precision,
	"ld_amount" double precision,
	"ld_basis" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"ncr_id" text,
	"concession_id" text,
	"waived_by" text,
	"waived_at" timestamp with time zone,
	"waiver_reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_occupancy_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"poe_kind" text DEFAULT 'soft_landings_review' NOT NULL,
	"turnover_package_id" text,
	"system_id" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"period_start" text,
	"period_end" text,
	"scheduled_for" text,
	"completed_at" text,
	"conducted_by" text,
	"conducted_by_organisation" text,
	"survey_response_count" integer,
	"survey_invite_count" integer,
	"satisfaction_score" double precision,
	"satisfaction_scale" text,
	"energy_design_value" double precision,
	"energy_actual_value" double precision,
	"energy_unit" text,
	"defects_raised_count" integer,
	"warranty_claim_count" integer,
	"findings" text,
	"recommendations" text,
	"lesson_id" text,
	"report_file_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_audit_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"audit_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"reference" text NOT NULL,
	"finding_type" text DEFAULT 'observation' NOT NULL,
	"clause_reference" text,
	"requirement" text,
	"evidence" text,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"responsible_user_id" text,
	"responsible_vendor_id" text,
	"response_due_date" text,
	"due_date" text,
	"response" text,
	"responded_at" timestamp with time zone,
	"root_cause" text,
	"corrective_action_id" text,
	"ncr_id" text,
	"rework_item_id" text,
	"verification_evidence" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"attachment_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"audit_type" text DEFAULT 'internal' NOT NULL,
	"standard" text,
	"scope" text,
	"objectives" text,
	"clause_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audited_vendor_id" text,
	"audited_function" text,
	"lead_auditor_id" text,
	"lead_auditor_name" text,
	"lead_auditor_organisation" text,
	"audit_team" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"planned_date" text,
	"started_at" text,
	"completed_at" text,
	"report_issued_at" text,
	"response_due_date" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"report_file_id" text,
	"finding_count" integer DEFAULT 0 NOT NULL,
	"major_finding_count" integer DEFAULT 0 NOT NULL,
	"minor_finding_count" integer DEFAULT 0 NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"open_finding_count" integer DEFAULT 0 NOT NULL,
	"conformity_percent" double precision,
	"next_audit_due_date" text,
	"signal_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_concessions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"kind" text DEFAULT 'concession' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"departure_from_requirement" text,
	"justification" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"ncr_id" text,
	"itp_activity_id" text,
	"checklist_id" text,
	"test_record_id" text,
	"weld_id" text,
	"pour_id" text,
	"certificate_id" text,
	"spec_section_id" text,
	"spec_clause_ref" text,
	"drawing_sheet_id" text,
	"location_id" text,
	"location_text" text,
	"asset_id" text,
	"vendor_id" text,
	"commitment_id" text,
	"quantity_limit" double precision,
	"unit" text,
	"conditions" text,
	"expiry_date" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone,
	"designer_organisation" text,
	"designer_contact" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"approval_authority" text,
	"approval_comments" text,
	"rejection_reason" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"value_impact" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"change_event_id" text,
	"document_file_id" text,
	"attachment_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signal_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rework_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'identified' NOT NULL,
	"source_type" text DEFAULT 'self_identified' NOT NULL,
	"source_id" text,
	"ncr_id" text,
	"punch_item_id" text,
	"checklist_id" text,
	"test_record_id" text,
	"audit_finding_id" text,
	"cause_category" text DEFAULT 'workmanship' NOT NULL,
	"cause_description" text,
	"discovery_phase" text DEFAULT 'during_works' NOT NULL,
	"discovered_at" text,
	"responsible_vendor_id" text,
	"responsible_party" text,
	"trade" text,
	"location_id" text,
	"location_text" text,
	"system_id" text,
	"labour_hours" double precision,
	"labour_cost" double precision,
	"material_cost" double precision,
	"plant_cost" double precision,
	"subcontractor_cost" double precision,
	"other_cost" double precision,
	"total_cost" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"cost_basis" text DEFAULT 'estimated' NOT NULL,
	"schedule_impact_days" double precision,
	"quantity_affected" double precision,
	"unit" text,
	"is_backcharged" integer DEFAULT 0 NOT NULL,
	"change_event_id" text,
	"preventable" integer DEFAULT 1 NOT NULL,
	"lesson_id" text,
	"started_at" text,
	"completed_at" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"verification_checklist_id" text,
	"photo_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spare_parts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"description" text NOT NULL,
	"category" text DEFAULT 'operational_spare' NOT NULL,
	"part_number" text,
	"manufacturer" text,
	"supplier_vendor_id" text,
	"system_id" text,
	"asset_id" text,
	"turnover_package_id" text,
	"material_item_id" text,
	"quantity_required" double precision,
	"quantity_delivered" double precision DEFAULT 0 NOT NULL,
	"unit" text,
	"unit_cost" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"lead_time_weeks" double precision,
	"status" text DEFAULT 'specified' NOT NULL,
	"ordered_at" text,
	"delivered_at" text,
	"storage_location" text,
	"received_by" text,
	"handed_over_at" timestamp with time zone,
	"handover_note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "welder_qualifications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"welder_name" text NOT NULL,
	"welder_stamp" text,
	"worker_id" text,
	"vendor_id" text,
	"certificate_number" text,
	"qualification_standard" text,
	"processes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"material_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thickness_min_mm" double precision,
	"thickness_max_mm" double precision,
	"diameter_min_mm" double precision,
	"diameter_max_mm" double precision,
	"qualified_from" text,
	"expiry_date" text,
	"continuity_confirmed_at" text,
	"continuity_months" integer DEFAULT 6 NOT NULL,
	"status" text DEFAULT 'valid' NOT NULL,
	"suspension_reason" text,
	"certificate_file_id" text,
	"wps_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "welding_procedures" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"wps_number" text NOT NULL,
	"title" text NOT NULL,
	"revision" text,
	"standard" text,
	"process" text DEFAULT 'smaw' NOT NULL,
	"secondary_process" text,
	"joint_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_material_group" text,
	"filler_material" text,
	"thickness_min_mm" double precision,
	"thickness_max_mm" double precision,
	"diameter_min_mm" double precision,
	"diameter_max_mm" double precision,
	"preheat_min_c" double precision,
	"interpass_max_c" double precision,
	"pwht_required" integer DEFAULT 0 NOT NULL,
	"pqr_reference" text,
	"vendor_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"valid_from" text,
	"valid_until" text,
	"document_file_id" text,
	"supersedes_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "welds" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"weld_map_ref" text,
	"joint_reference" text,
	"joint_type" text,
	"description" text,
	"drawing_sheet_id" text,
	"drawing_reference" text,
	"isometric_ref" text,
	"line_or_element_ref" text,
	"system_id" text,
	"asset_id" text,
	"location_id" text,
	"material_spec" text,
	"thickness_mm" double precision,
	"diameter_mm" double precision,
	"heat_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"material_certificate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wps_id" text,
	"welder_qualification_id" text,
	"welder_stamp" text,
	"welded_at" text,
	"vendor_id" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"visual_result" text,
	"visual_inspected_by" text,
	"visual_inspected_at" timestamp with time zone,
	"ndt_required_percent" double precision,
	"ndt_methods_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ndt_record_count" integer DEFAULT 0 NOT NULL,
	"ndt_accept_count" integer DEFAULT 0 NOT NULL,
	"ndt_reject_count" integer DEFAULT 0 NOT NULL,
	"repair_count" integer DEFAULT 0 NOT NULL,
	"pwht_completed_at" text,
	"ncr_id" text,
	"concession_id" text,
	"itp_activity_id" text,
	"photo_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "award_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"subject_kind" text DEFAULT 'user' NOT NULL,
	"subject_id" text NOT NULL,
	"label" text,
	"max_award_amount" double precision NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"project_id" text,
	"package_kind" text,
	"valid_from" text,
	"valid_to" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"basis" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_bonds" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"package_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"invitation_id" text,
	"submission_id" text,
	"bond_type" text DEFAULT 'bid' NOT NULL,
	"status" text DEFAULT 'required' NOT NULL,
	"required_percent" double precision,
	"required_amount" double precision,
	"provided_amount" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"provider" text,
	"bond_number" text,
	"issued_at" text,
	"valid_from" text,
	"expires_at" text,
	"received_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"verification_note" text,
	"released_at" timestamp with time zone,
	"released_by" text,
	"release_reason" text,
	"called_at" timestamp with time zone,
	"called_reason" text,
	"rejected_reason" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"obligation_id" text,
	"signal_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_document_access" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"package_id" text NOT NULL,
	"invitation_id" text,
	"vendor_id" text,
	"file_id" text NOT NULL,
	"file_name" text,
	"document_kind" text,
	"addendum_ref" text,
	"access_kind" text DEFAULT 'download' NOT NULL,
	"via" text DEFAULT 'portal_token' NOT NULL,
	"actor_id" text,
	"ip_hash" text,
	"user_agent" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_meeting_attendees" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"meeting_id" text NOT NULL,
	"package_id" text NOT NULL,
	"vendor_id" text,
	"invitation_id" text,
	"attendee_name" text,
	"attendee_email" text,
	"attendance" text DEFAULT 'invited' NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone,
	"note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"package_id" text NOT NULL,
	"kind" text DEFAULT 'pre_bid' NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer,
	"location" text,
	"meeting_url" text,
	"is_mandatory" integer DEFAULT 0 NOT NULL,
	"agenda" text,
	"minutes" text,
	"minutes_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minutes_published_at" timestamp with time zone,
	"published_addendum_ref" text,
	"held_at" timestamp with time zone,
	"chaired_by" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"cancelled_reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_opportunities" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"client_name" text,
	"client_vendor_id" text,
	"client_contact_id" text,
	"sector" text,
	"work_type" text,
	"trade_code" text,
	"region" text,
	"country" text,
	"source" text DEFAULT 'other' NOT NULL,
	"procurement_route" text,
	"stage" text DEFAULT 'identified' NOT NULL,
	"estimated_value" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"expected_margin_percent" double precision,
	"eoi_due_at" timestamp with time zone,
	"submission_due_at" timestamp with time zone,
	"decision_expected_at" text,
	"anticipated_start_date" text,
	"duration_months" double precision,
	"peak_resource_units" double precision,
	"resource_unit_label" text,
	"bid_no_bid_decision" text DEFAULT 'pending' NOT NULL,
	"bid_no_bid_factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bid_no_bid_score" double precision,
	"bid_no_bid_basis" text,
	"bid_no_bid_decided_by" text,
	"bid_no_bid_decided_at" timestamp with time zone,
	"win_probability" double precision,
	"win_probability_model" text,
	"win_probability_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"win_probability_at" timestamp with time zone,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"outcome_reason" text,
	"winning_competitor" text,
	"winning_amount" double precision,
	"submitted_amount" double precision,
	"competitors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_user_id" text,
	"bid_package_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"package_id" text NOT NULL,
	"invitation_id" text,
	"vendor_id" text,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"category" text DEFAULT 'scope' NOT NULL,
	"question" text NOT NULL,
	"anonymised_question" text,
	"asked_at" timestamp with time zone,
	"status" text DEFAULT 'submitted' NOT NULL,
	"answer" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"published_addendum_ref" text,
	"published_at" timestamp with time zone,
	"is_private" integer DEFAULT 0 NOT NULL,
	"private_reason" text,
	"rejected_reason" text,
	"spec_section_id" text,
	"drawing_sheet_id" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prequalification_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"submission_id" text,
	"kind" text NOT NULL,
	"jurisdiction" text,
	"number" text,
	"issued_by" text,
	"issued_at" text,
	"expires_at" text,
	"status" text DEFAULT 'claimed' NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prequalification_references" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"submission_id" text,
	"client_name" text NOT NULL,
	"project_name" text,
	"contract_value" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"completed_at" text,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"outcome" text DEFAULT 'unknown' NOT NULL,
	"rating" double precision,
	"would_use_again" integer,
	"checked_by" text,
	"checked_at" timestamp with time zone,
	"check_note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prequalification_safety_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"submission_id" text,
	"year" integer NOT NULL,
	"emr" double precision,
	"trir" double precision,
	"dart" double precision,
	"fatalities" integer,
	"lost_time_injuries" integer,
	"recordable_incidents" integer,
	"hours_worked" double precision,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'self_declared' NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tender_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"opportunity_id" text,
	"package_id" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"description" text NOT NULL,
	"incurred_on" text NOT NULL,
	"hours" double precision,
	"hourly_rate" double precision,
	"amount" double precision NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"user_id" text,
	"vendor_id" text,
	"invoice_reference" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_security_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"session_idle_timeout_minutes" integer,
	"session_absolute_timeout_hours" integer,
	"remember_device_days" integer,
	"password_min_length" integer,
	"password_require_complexity" boolean DEFAULT false NOT NULL,
	"password_history_depth" integer,
	"password_max_age_days" integer,
	"lockout_max_attempts" integer,
	"lockout_window_minutes" integer,
	"lockout_duration_minutes" integer,
	"ip_allowlist_mode" text DEFAULT 'off' NOT NULL,
	"ip_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ip_allowlist_break_glass_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mfa_required" boolean DEFAULT false NOT NULL,
	"mfa_accepted_amr_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"security_event_retention_days" integer,
	"email_dispatch_retention_days" integer,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"legal_hold_reason" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"origin" text DEFAULT 'password' NOT NULL,
	"ip" text,
	"user_agent" text,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_history" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"password_hash" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_by" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"event_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_code" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"event_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_fingerprint" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_status" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"company_id" text NOT NULL,
	"record" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attention_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"project_name" text,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"due_at" timestamp with time zone,
	"href" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"money" double precision,
	"currency" text,
	"status" text DEFAULT 'open' NOT NULL,
	"dismissed_by" text,
	"dismissed_at" timestamp with time zone,
	"dismiss_reason" text,
	"resolved_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_health_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"level" text NOT NULL,
	"score" double precision,
	"rated_dimensions" integer DEFAULT 0 NOT NULL,
	"dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger" text DEFAULT 'interval' NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pulse_briefings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text NOT NULL,
	"headline" text NOT NULL,
	"summary" text NOT NULL,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pulse_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"portfolio" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attention_by_severity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"open_attention" integer DEFAULT 0 NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"template_key" text,
	"trigger" jsonb NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_object_type" text NOT NULL,
	"trigger_action" text DEFAULT '*' NOT NULL,
	"conditions" jsonb,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"immediate" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_scan_at" timestamp with time zone,
	"last_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"rule_id" text NOT NULL,
	"rule_name" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"event_seq" integer,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dry_run" integer DEFAULT 0 NOT NULL,
	"caused_by_run_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"context" jsonb,
	"condition_result" jsonb,
	"action_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"actor_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pe_exposures" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"entity_name" text NOT NULL,
	"home_country" text NOT NULL,
	"host_country" text NOT NULL,
	"regime" text NOT NULL,
	"threshold_days" integer NOT NULL,
	"window_months" integer DEFAULT 12 NOT NULL,
	"warn_fraction" double precision DEFAULT 0.75 NOT NULL,
	"threshold_basis" text NOT NULL,
	"days_in_window" integer DEFAULT 0 NOT NULL,
	"days_total" integer DEFAULT 0 NOT NULL,
	"first_presence_date" text,
	"last_presence_date" text,
	"projected_breach_date" text,
	"status" text DEFAULT 'monitoring' NOT NULL,
	"mitigation_note" text,
	"last_computed_at" timestamp with time zone,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pe_presence_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"exposure_id" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"days" integer NOT NULL,
	"purpose" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_determinations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"source_line_id" text,
	"vendor_id" text,
	"vendor_name" text,
	"regime" text NOT NULL,
	"supply_type" text NOT NULL,
	"contract_type" text NOT NULL,
	"amount" double precision NOT NULL,
	"currency" text NOT NULL,
	"tax_point_date" text,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"vat_treatment" text NOT NULL,
	"vat_rate" double precision DEFAULT 0 NOT NULL,
	"vat_amount" double precision DEFAULT 0 NOT NULL,
	"self_accounted_vat" double precision DEFAULT 0 NOT NULL,
	"reverse_charge" integer DEFAULT 0 NOT NULL,
	"withholding_scheme" text DEFAULT 'none' NOT NULL,
	"withholding_base" text DEFAULT 'none' NOT NULL,
	"withholding_base_amount" double precision DEFAULT 0 NOT NULL,
	"withholding_rate" double precision DEFAULT 0 NOT NULL,
	"withholding_amount" double precision DEFAULT 0 NOT NULL,
	"levies_amount" double precision DEFAULT 0 NOT NULL,
	"net_payable" double precision NOT NULL,
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'determined' NOT NULL,
	"overridden_by_id" text,
	"overrides_id" text,
	"override_reason" text,
	"superseded_by_id" text,
	"determined_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"regime" text NOT NULL,
	"return_kind" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"due_date" text NOT NULL,
	"payment_due_date" text,
	"currency" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"output_tax" double precision,
	"input_tax" double precision,
	"self_accounted_tax" double precision,
	"withheld_total" double precision,
	"net_payable" double precision,
	"determination_count" integer DEFAULT 0 NOT NULL,
	"certificate_count" integer DEFAULT 0 NOT NULL,
	"excluded_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone,
	"compute_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"obligation_id" text,
	"filed_at" timestamp with time zone,
	"filed_by" text,
	"filing_reference" text,
	"paid_at" timestamp with time zone,
	"paid_by" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_project_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"regime" text NOT NULL,
	"place_of_supply_country" text,
	"customer_vat_registered" integer DEFAULT 0 NOT NULL,
	"customer_deduction_registered" integer DEFAULT 0 NOT NULL,
	"end_user" integer DEFAULT 0 NOT NULL,
	"default_supply_type" text DEFAULT 'construction_services' NOT NULL,
	"default_contract_type" text DEFAULT 'subcontract' NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"custom_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"holder_type" text NOT NULL,
	"holder_id" text,
	"holder_name" text NOT NULL,
	"regime" text NOT NULL,
	"kind" text NOT NULL,
	"number" text,
	"status" text DEFAULT 'active' NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"verification_reference" text,
	"deduction_rate" double precision,
	"valid_from" text,
	"valid_to" text,
	"country" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withholding_certificates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text,
	"determination_id" text,
	"payment_id" text,
	"invoice_id" text,
	"vendor_id" text,
	"vendor_name" text NOT NULL,
	"regime" text NOT NULL,
	"scheme" text NOT NULL,
	"payment_date" text NOT NULL,
	"period_start" text,
	"period_end" text,
	"currency" text NOT NULL,
	"gross_amount" double precision NOT NULL,
	"materials_amount" double precision DEFAULT 0 NOT NULL,
	"base_amount" double precision NOT NULL,
	"rate" double precision NOT NULL,
	"withheld_amount" double precision NOT NULL,
	"net_paid" double precision NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"gate_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"description" text NOT NULL,
	"supplier_node_id" text,
	"vendor_id" text,
	"long_lead_item_id" text,
	"offsite_unit_id" text,
	"material_delivery_id" text,
	"schedule_task_id" text,
	"vehicle_type" text DEFAULT 'rigid_18t' NOT NULL,
	"vehicle_registration" text,
	"haulier_name" text,
	"driver_name" text,
	"driver_phone" text,
	"crane_required" integer DEFAULT 0 NOT NULL,
	"crane_minutes" integer,
	"laydown_area" text,
	"arrived_at" timestamp with time zone,
	"unloading_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"waiting_minutes" integer,
	"was_on_time" integer,
	"late_minutes" integer,
	"issue_kind" text DEFAULT 'none' NOT NULL,
	"issue_notes" text,
	"transport_mode" text DEFAULT 'road' NOT NULL,
	"origin_text" text,
	"origin_country" text,
	"transport_km" double precision,
	"load_tonnes" double precision,
	"carbon_kg_co2e" double precision,
	"carbon_basis" text,
	"carbon_entry_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"booked_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factory_inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"unit_id" text,
	"long_lead_item_id" text,
	"node_id" text,
	"kind" text DEFAULT 'factory_acceptance_test' NOT NULL,
	"title" text NOT NULL,
	"scheduled_for" text,
	"performed_at" text,
	"inspector_id" text,
	"inspector_name" text,
	"result" text DEFAULT 'scheduled' NOT NULL,
	"findings" text,
	"percent_verified" double precision,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_lead_expediting_log" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"item_id" text NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"contact_name" text,
	"promised_date" text,
	"logged_by" text NOT NULL,
	"logged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_lead_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"supplier_node_id" text,
	"vendor_id" text,
	"commitment_id" text,
	"purchase_order_ref" text,
	"material_item_id" text,
	"schedule_task_id" text,
	"schedule_task_name" text,
	"required_on_site" text,
	"required_from_schedule" integer DEFAULT 0 NOT NULL,
	"lead_time_days" integer DEFAULT 0 NOT NULL,
	"buffer_days" integer DEFAULT 0 NOT NULL,
	"order_by_date" text,
	"float_days" integer,
	"risk_level" text DEFAULT 'not_assessable' NOT NULL,
	"risk_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_assessed_at" timestamp with time zone,
	"planned_order_date" text,
	"actual_order_date" text,
	"planned_production_start" text,
	"actual_production_start" text,
	"planned_ship_date" text,
	"actual_ship_date" text,
	"planned_arrival_date" text,
	"forecast_arrival_date" text,
	"actual_arrival_date" text,
	"customs_required" integer DEFAULT 0 NOT NULL,
	"customs_cleared_at" text,
	"installed_at" text,
	"status" text DEFAULT 'identified' NOT NULL,
	"quantity" double precision,
	"unit" text,
	"value" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"incoterms" text,
	"origin_country" text,
	"expediting_owner_id" text,
	"last_expedited_at" timestamp with time zone,
	"expediting_count" integer DEFAULT 0 NOT NULL,
	"signal_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_trace_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"description" text NOT NULL,
	"material_type" text,
	"heat_number" text,
	"batch_number" text,
	"lot_number" text,
	"serial_number" text,
	"quantity" double precision,
	"unit" text,
	"supplier_node_id" text,
	"vendor_id" text,
	"manufacturer" text,
	"origin_country" text,
	"material_item_id" text,
	"material_delivery_line_id" text,
	"delivery_slot_id" text,
	"long_lead_item_id" text,
	"offsite_unit_id" text,
	"certificates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"certificate_count" integer DEFAULT 0 NOT NULL,
	"conformity_marking" text,
	"responsible_sourcing_scheme" text,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" text,
	"installed_at" text,
	"installed_location_id" text,
	"installed_ref" text,
	"installed_by" text,
	"chain_complete" integer DEFAULT 0 NOT NULL,
	"chain_gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offsite_production_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"unit_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"planned_start" text,
	"planned_end" text,
	"actual_start" text,
	"actual_end" text,
	"completed_by" text,
	"is_qa_gate" integer DEFAULT 0 NOT NULL,
	"qa_result" text DEFAULT 'pending' NOT NULL,
	"qa_verified_by" text,
	"qa_verified_at" timestamp with time zone,
	"qa_notes" text,
	"evidence_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offsite_units" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"unit_type" text DEFAULT 'volumetric_module' NOT NULL,
	"serial_number" text,
	"design_reference" text,
	"factory_node_id" text,
	"vendor_id" text,
	"long_lead_item_id" text,
	"location_id" text,
	"schedule_task_id" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"stages_total" integer DEFAULT 0 NOT NULL,
	"stages_complete" integer DEFAULT 0 NOT NULL,
	"percent_complete" double precision DEFAULT 0 NOT NULL,
	"qa_gates_total" integer DEFAULT 0 NOT NULL,
	"qa_gates_passed" integer DEFAULT 0 NOT NULL,
	"qa_gates_failed" integer DEFAULT 0 NOT NULL,
	"planned_production_start" text,
	"planned_production_end" text,
	"actual_production_start" text,
	"actual_production_end" text,
	"planned_delivery_date" text,
	"actual_delivery_date" text,
	"installed_at" text,
	"vesting_certificate_file_id" text,
	"vesting_certified_at" text,
	"title_transferred_at" text,
	"storage_location_text" text,
	"storage_insured_until" text,
	"storage_inspected_at" text,
	"value" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"percent_verified_for_payment" double precision,
	"verified_for_payment_by" text,
	"verified_for_payment_at" timestamp with time zone,
	"delivery_slot_id" text,
	"transport_km" double precision,
	"weight_tonnes" double precision,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"opens_at" text DEFAULT '07:00' NOT NULL,
	"closes_at" text DEFAULT '18:00' NOT NULL,
	"concurrent_slots" integer DEFAULT 1 NOT NULL,
	"slot_minutes" integer DEFAULT 30 NOT NULL,
	"max_vehicle_type" text,
	"crane_available" integer DEFAULT 0 NOT NULL,
	"laydown_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_risk_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"node_id" text NOT NULL,
	"vendor_id" text,
	"assessed_at" timestamp with time zone NOT NULL,
	"score" double precision,
	"level" text NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"basis" text NOT NULL,
	"signal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_chain_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"kind" text DEFAULT 'supplies' NOT NULL,
	"description" text,
	"category" text,
	"is_sole_source" integer DEFAULT 0 NOT NULL,
	"lead_time_days" integer,
	"value" double precision,
	"currency" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_chain_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'vendor' NOT NULL,
	"tier" integer DEFAULT 1 NOT NULL,
	"country" text,
	"city" text,
	"criticality" text DEFAULT 'medium' NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vendor_id" text,
	"entity_id" text,
	"commitment_id" text,
	"annual_value" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"lead_time_days" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"risk_level" text,
	"risk_score" double precision,
	"risk_assessed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_change_impacts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"change_notice_id" text NOT NULL,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"package_id" text,
	"consultant_id" text,
	"summary" text NOT NULL,
	"cost_impact" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"time_impact_days" integer,
	"rework_hours" double precision,
	"affected_package_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_note" text,
	"assessed_by" text NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_change_notices" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"package_id" text,
	"stage_key" text,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"classification" text DEFAULT 'design_change' NOT NULL,
	"originator" text DEFAULT 'client' NOT NULL,
	"originator_vendor_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_post_freeze" integer DEFAULT 0 NOT NULL,
	"freeze_id" text,
	"post_freeze_signal_id" text,
	"required_authorisation" text DEFAULT 'design_lead' NOT NULL,
	"authorisation_basis" text,
	"assessed_cost" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"assessed_time_days" integer,
	"assessed_rework_hours" double precision,
	"impact_count" integer DEFAULT 0 NOT NULL,
	"impact_currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"change_event_id" text,
	"schedule_task_id" text,
	"decision_id" text,
	"issue_id" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"implemented_by" text,
	"implemented_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"need_by_date" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"review_id" text NOT NULL,
	"package_id" text NOT NULL,
	"participant_id" text,
	"sequence" integer DEFAULT 1 NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"body" text NOT NULL,
	"location_ref" text,
	"drawing_sheet_id" text,
	"spec_section_id" text,
	"bim_model_id" text,
	"code" text,
	"status" text DEFAULT 'open' NOT NULL,
	"response" text,
	"responded_by" text,
	"responded_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_note" text,
	"issue_id" text,
	"raised_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_consultants" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"vendor_id" text,
	"name" text NOT NULL,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"role" text,
	"appointment_ref" text,
	"commitment_id" text,
	"status" text DEFAULT 'appointed' NOT NULL,
	"appointed_at" text,
	"completed_at" text,
	"novated_to_vendor_id" text,
	"novated_at" text,
	"fee_value" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"pi_required_amount" double precision,
	"pi_cover_amount" double precision,
	"pi_currency" text,
	"pi_expires_on" text,
	"pi_insurer_name" text,
	"pi_policy_number" text,
	"pi_verified_by" text,
	"pi_verified_at" timestamp with time zone,
	"pi_signal_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"background" text,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"stage_key" text,
	"package_id" text,
	"issue_id" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decision" text,
	"chosen_option_key" text,
	"rationale" text,
	"authorisation_level" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"cost_impact" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"time_impact_days" integer,
	"supersedes_id" text,
	"superseded_by_id" text,
	"reversed_reason" text,
	"change_notice_id" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_deliverables" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"deliverable_type" text DEFAULT 'drawing' NOT NULL,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"package_id" text,
	"consultant_id" text,
	"vendor_id" text,
	"stage_key" text,
	"info_requirement_id" text,
	"schedule_task_id" text,
	"required_on_site" text,
	"planned_issue_date" text,
	"forecast_issue_date" text,
	"actual_issue_date" text,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"rejected_at" timestamp with time zone,
	"rejected_reason" text,
	"revision" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"slippage_level" text DEFAULT 'not_assessable' NOT NULL,
	"slippage_days" integer,
	"slippage_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assessed_at" timestamp with time zone,
	"obligation_id" text,
	"late_signal_id" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"drawing_sheet_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_freezes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scope" text DEFAULT 'package' NOT NULL,
	"package_id" text,
	"stage_key" text,
	"title" text NOT NULL,
	"reason" text,
	"effective_from" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"required_authorisation" text DEFAULT 'client' NOT NULL,
	"declared_by" text NOT NULL,
	"lifted_by" text,
	"lifted_at" timestamp with time zone,
	"lift_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_info_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"kind" text DEFAULT 'eir' NOT NULL,
	"title" text NOT NULL,
	"requirement" text,
	"stage_key" text,
	"package_id" text,
	"consultant_id" text,
	"responsible_user_id" text,
	"responsible_vendor_id" text,
	"due_date" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivered_by" text,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"verification_note" text,
	"waived_at" timestamp with time zone,
	"waived_by" text,
	"waive_reason" text,
	"obligation_id" text,
	"overdue_signal_id" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"issue_type" text DEFAULT 'coordination' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"affected_disciplines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"package_id" text,
	"review_id" text,
	"comment_id" text,
	"assigned_to_user_id" text,
	"assigned_to_vendor_id" text,
	"assigned_at" timestamp with time zone,
	"due_date" text,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"void_reason" text,
	"rfi_id" text,
	"change_notice_id" text,
	"change_event_id" text,
	"decision_id" text,
	"drawing_sheet_id" text,
	"spec_section_id" text,
	"bim_model_id" text,
	"location_ref" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stale_signal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"stage_key" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"lead_vendor_id" text,
	"lead_user_id" text,
	"consultant_id" text,
	"planned_issue_date" text,
	"actual_issue_date" text,
	"planned_approval_date" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"revision" text,
	"frozen_at" timestamp with time zone,
	"frozen_by" text,
	"freeze_id" text,
	"superseded_by_id" text,
	"review_count" integer DEFAULT 0 NOT NULL,
	"open_issue_count" integer DEFAULT 0 NOT NULL,
	"open_comment_count" integer DEFAULT 0 NOT NULL,
	"dcn_count" integer DEFAULT 0 NOT NULL,
	"post_freeze_dcn_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_readiness_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"package_id" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score" double precision,
	"level" text DEFAULT 'not_assessable' NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_review_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"review_id" text NOT NULL,
	"user_id" text,
	"vendor_id" text,
	"display_name" text,
	"discipline" text DEFAULT 'multi_discipline' NOT NULL,
	"is_required" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"returned_code" text,
	"returned_at" timestamp with time zone,
	"returned_by" text,
	"decline_reason" text,
	"summary" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"package_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"revision" text,
	"cycle_number" integer DEFAULT 1 NOT NULL,
	"previous_review_id" text,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"status" text DEFAULT 'open' NOT NULL,
	"consolidated_code" text,
	"consolidation_basis" text,
	"turnaround_days" double precision,
	"reviewer_count" integer DEFAULT 0 NOT NULL,
	"returned_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"open_comment_count" integer DEFAULT 0 NOT NULL,
	"overdue_signal_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_stage_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"stage_key" text NOT NULL,
	"framework" text DEFAULT 'riba_2020' NOT NULL,
	"label" text,
	"planned_start" text,
	"planned_end" text,
	"actual_start" text,
	"actual_end" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signed_off_by" text,
	"signed_off_at" timestamp with time zone,
	"sign_off_notes" text,
	"rejected_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_assemblies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" text NOT NULL,
	"category" text,
	"trade" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"cost_code_id" text,
	"cost_code" text,
	"unit_rate" double precision DEFAULT 0 NOT NULL,
	"labour_rate" double precision DEFAULT 0 NOT NULL,
	"material_rate" double precision DEFAULT 0 NOT NULL,
	"equipment_rate" double precision DEFAULT 0 NOT NULL,
	"subcontract_rate" double precision DEFAULT 0 NOT NULL,
	"other_rate" double precision DEFAULT 0 NOT NULL,
	"component_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_assembly_components" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"assembly_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"catalogue_item_id" text,
	"description" text NOT NULL,
	"unit" text,
	"cost_type" text DEFAULT 'other' NOT NULL,
	"quantity_per" double precision DEFAULT 0 NOT NULL,
	"waste_percent" double precision DEFAULT 0 NOT NULL,
	"labour_rate" double precision DEFAULT 0 NOT NULL,
	"material_rate" double precision DEFAULT 0 NOT NULL,
	"equipment_rate" double precision DEFAULT 0 NOT NULL,
	"subcontract_rate" double precision DEFAULT 0 NOT NULL,
	"other_rate" double precision DEFAULT 0 NOT NULL,
	"unit_rate" double precision DEFAULT 0 NOT NULL,
	"amount_per" double precision DEFAULT 0 NOT NULL,
	"cost_code_id" text,
	"cost_code" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_catalogue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"long_description" text,
	"unit" text NOT NULL,
	"cost_type" text DEFAULT 'other' NOT NULL,
	"category" text,
	"trade" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"labour_rate" double precision DEFAULT 0 NOT NULL,
	"material_rate" double precision DEFAULT 0 NOT NULL,
	"equipment_rate" double precision DEFAULT 0 NOT NULL,
	"subcontract_rate" double precision DEFAULT 0 NOT NULL,
	"other_rate" double precision DEFAULT 0 NOT NULL,
	"unit_rate" double precision DEFAULT 0 NOT NULL,
	"crew_id" text,
	"production_rate" double precision,
	"production_rate_basis" text,
	"waste_percent" double precision DEFAULT 0 NOT NULL,
	"cost_code_id" text,
	"cost_code" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_reference" text,
	"region" text,
	"rate_as_at" text,
	"status" text DEFAULT 'active' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"estimate_id" text NOT NULL,
	"section_id" text,
	"lineage_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"item_code" text,
	"description" text NOT NULL,
	"long_description" text,
	"cost_code_id" text,
	"cost_code" text,
	"cost_type" text DEFAULT 'other' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"unit" text,
	"takeoff_quantity" double precision,
	"waste_percent" double precision DEFAULT 0 NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit_rate" double precision DEFAULT 0 NOT NULL,
	"labour_rate" double precision DEFAULT 0 NOT NULL,
	"material_rate" double precision DEFAULT 0 NOT NULL,
	"equipment_rate" double precision DEFAULT 0 NOT NULL,
	"subcontract_rate" double precision DEFAULT 0 NOT NULL,
	"other_rate" double precision DEFAULT 0 NOT NULL,
	"labour_amount" double precision DEFAULT 0 NOT NULL,
	"material_amount" double precision DEFAULT 0 NOT NULL,
	"equipment_amount" double precision DEFAULT 0 NOT NULL,
	"subcontract_amount" double precision DEFAULT 0 NOT NULL,
	"other_amount" double precision DEFAULT 0 NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"crew_id" text,
	"production_rate" double precision,
	"production_rate_basis" text,
	"labour_hours" double precision DEFAULT 0 NOT NULL,
	"takeoff_item_id" text,
	"catalogue_item_id" text,
	"assembly_id" text,
	"assembly_parent_line_id" text,
	"sub_quote_id" text,
	"sub_quote_line_id" text,
	"rate_as_at" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_markups" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"estimate_id" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'overhead' NOT NULL,
	"name" text NOT NULL,
	"method" text DEFAULT 'percent' NOT NULL,
	"basis" text DEFAULT 'direct_cost' NOT NULL,
	"rate" double precision DEFAULT 0 NOT NULL,
	"cost_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"section_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quantity" double precision,
	"base_amount" double precision DEFAULT 0 NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"rationale" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"estimate_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"client_name" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"document" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail_level" text DEFAULT 'section' NOT NULL,
	"valid_until" text,
	"covering_note" text,
	"exclusions" text,
	"assumptions" text,
	"issued_by" text,
	"issued_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"estimate_id" text NOT NULL,
	"parent_id" text,
	"code" text,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"direct_cost_total" double precision DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_sub_quote_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sub_quote_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"item_code" text,
	"description" text NOT NULL,
	"scope_key" text,
	"unit" text,
	"quantity" double precision,
	"unit_rate" double precision,
	"amount" double precision DEFAULT 0 NOT NULL,
	"cost_code_id" text,
	"cost_code" text,
	"cost_type" text DEFAULT 'subcontract' NOT NULL,
	"excluded" integer DEFAULT 0 NOT NULL,
	"note" text,
	"estimate_line_item_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_sub_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"estimate_id" text,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"vendor_id" text,
	"vendor_name" text NOT NULL,
	"trade_package" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"quoted_total" double precision DEFAULT 0 NOT NULL,
	"adjustment_amount" double precision DEFAULT 0 NOT NULL,
	"levelled_total" double precision DEFAULT 0 NOT NULL,
	"quote_date" text,
	"valid_until" text,
	"inclusions" text,
	"exclusions" text,
	"qualifications" text,
	"line_count" integer DEFAULT 0 NOT NULL,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"estimate_type" text DEFAULT 'conceptual' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"root_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_estimate_id" text,
	"source_type" text,
	"source_id" text,
	"basis" text,
	"accuracy_range" double precision,
	"quantity_basis" double precision,
	"quantity_basis_unit" text,
	"direct_cost_total" double precision DEFAULT 0 NOT NULL,
	"labour_total" double precision DEFAULT 0 NOT NULL,
	"material_total" double precision DEFAULT 0 NOT NULL,
	"equipment_total" double precision DEFAULT 0 NOT NULL,
	"subcontract_total" double precision DEFAULT 0 NOT NULL,
	"other_total" double precision DEFAULT 0 NOT NULL,
	"markup_total" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"labour_hours" double precision DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"excluded_total" double precision DEFAULT 0 NOT NULL,
	"alternate_total" double precision DEFAULT 0 NOT NULL,
	"totals_calculated_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"converted_budget_id" text,
	"converted_at" timestamp with time zone,
	"converted_by" text,
	"superseded_by_id" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimating_crews" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trade" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"equipment" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hourly_cost" double precision DEFAULT 0 NOT NULL,
	"labour_hourly_cost" double precision DEFAULT 0 NOT NULL,
	"equipment_hourly_cost" double precision DEFAULT 0 NOT NULL,
	"headcount" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimating_production_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"trade" text,
	"crew_id" text,
	"basis" text DEFAULT 'output_per_hour' NOT NULL,
	"value" double precision DEFAULT 0 NOT NULL,
	"conditions" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_reference" text,
	"region" text,
	"rate_as_at" text,
	"status" text DEFAULT 'active' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_takeoff_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"estimate_id" text,
	"layer_id" text,
	"name" text NOT NULL,
	"description" text,
	"measurement_type" text NOT NULL,
	"status" text DEFAULT 'measured' NOT NULL,
	"sheet_id" text,
	"sheet_number" text,
	"revision_id" text,
	"page_number" integer DEFAULT 1 NOT NULL,
	"pixels_per_unit" double precision,
	"scale_unit" text,
	"scale_label" text,
	"geometry" jsonb,
	"raw_value" double precision DEFAULT 0 NOT NULL,
	"depth" double precision,
	"height" double precision,
	"deduction" double precision DEFAULT 0 NOT NULL,
	"multiplier" double precision DEFAULT 1 NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit" text NOT NULL,
	"perimeter" double precision,
	"cost_code_id" text,
	"cost_code" text,
	"colour" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"measured_by" text NOT NULL,
	"measured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_takeoff_layers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"colour" text DEFAULT '#2563eb' NOT NULL,
	"description" text,
	"cost_code_id" text,
	"cost_code" text,
	"measurement_type" text,
	"unit" text,
	"visible" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_plan_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"assignee_id" text,
	"due_date" text,
	"evidence_required" integer DEFAULT 0 NOT NULL,
	"evidence_requirement" text,
	"evidence_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_note" text,
	"evidence_submitted_at" timestamp with time zone,
	"evidence_submitted_by" text,
	"reference_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_quality_checkpoint" integer DEFAULT 0 NOT NULL,
	"signoff_required_count" integer DEFAULT 0 NOT NULL,
	"signoff_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"waived_reason" text,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_plan_signoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"seq" integer NOT NULL,
	"party_type" text DEFAULT 'user' NOT NULL,
	"party_id" text,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by" text,
	"signer_name" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_plan_template_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"template_id" text NOT NULL,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"evidence_required" integer DEFAULT 0 NOT NULL,
	"evidence_requirement" text,
	"reference_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signoff_parties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_quality_checkpoint" integer DEFAULT 0 NOT NULL,
	"due_offset_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_plan_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"template_id" text,
	"template_version" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"anchor" text DEFAULT 'none' NOT NULL,
	"location_id" text,
	"schedule_task_id" text,
	"owner_id" text,
	"start_date" text,
	"due_date" text,
	"activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"cancelled_reason" text,
	"activity_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"progress_percent" double precision,
	"blocked_reason" text,
	"overdue_notified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"letter_id" text NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence_inbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text NOT NULL,
	"body_text" text,
	"received_at" timestamp with time zone NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'captured' NOT NULL,
	"routing_reason" text,
	"detected_reference" text,
	"letter_id" text,
	"sender_user_id" text,
	"sender_contact_id" text,
	"signature_verified" integer,
	"ingested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence_letters" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"type_id" text NOT NULL,
	"type_key" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"is_contractual" integer DEFAULT 0 NOT NULL,
	"thread_id" text NOT NULL,
	"in_reply_to_id" text,
	"from_name" text,
	"from_email" text,
	"from_user_id" text,
	"from_vendor_id" text,
	"letter_date" text,
	"issued_at" timestamp with time zone,
	"issued_by" text,
	"response_required" integer DEFAULT 0 NOT NULL,
	"response_due_date" text,
	"responded_at" timestamp with time zone,
	"responded_by" text,
	"response_letter_id" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"void_reason" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"obligation_id" text,
	"inbound_message_id" text,
	"transmittal_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overdue_notified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"kind" text DEFAULT 'to' NOT NULL,
	"party_type" text DEFAULT 'external' NOT NULL,
	"party_id" text,
	"name" text NOT NULL,
	"email" text,
	"organisation" text,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"delivery_note" text,
	"first_read_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	"read_count" integer DEFAULT 0 NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"acknowledgement_required" integer DEFAULT 0 NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledgement_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence_types" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prefix" text NOT NULL,
	"default_direction" text DEFAULT 'outbound' NOT NULL,
	"requires_response" integer DEFAULT 0 NOT NULL,
	"response_days" integer,
	"is_contractual" integer DEFAULT 0 NOT NULL,
	"creates_obligation" integer DEFAULT 1 NOT NULL,
	"approval_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"is_system" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"assignee_user_id" text,
	"assignee_contact_id" text,
	"assignee_name" text NOT NULL,
	"location_id" text,
	"schedule_task_id" text,
	"due_date" text,
	"status" text DEFAULT 'assigned' NOT NULL,
	"instructions" text,
	"response_id" text,
	"completed_at" timestamp with time zone,
	"cancelled_reason" text,
	"overdue_notified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"assignment_id" text,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hidden_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signature" jsonb,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_id" text,
	"schedule_task_id" text,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"review_note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"logic" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature_required" integer DEFAULT 0 NOT NULL,
	"pdf_file_id" text,
	"pdf_field_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"archived_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transmittal_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"transmittal_id" text NOT NULL,
	"seq" integer NOT NULL,
	"item_type" text DEFAULT 'file' NOT NULL,
	"item_id" text,
	"title" text NOT NULL,
	"revision" text,
	"format" text,
	"copies" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transmittals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"subject" text NOT NULL,
	"purpose" text DEFAULT 'for_information' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"method" text DEFAULT 'email' NOT NULL,
	"cover_note" text,
	"issued_at" timestamp with time zone,
	"issued_by" text,
	"ack_due_date" text,
	"ack_required" integer DEFAULT 1 NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"void_reason" text,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"ack_required_count" integer DEFAULT 0 NOT NULL,
	"acknowledged_count" integer DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"obligation_id" text,
	"letter_id" text,
	"overdue_notified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_rights_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"verification_id" text,
	"reference" text NOT NULL,
	"subject_type" text DEFAULT 'commitment' NOT NULL,
	"subject_id" text,
	"subject_name" text NOT NULL,
	"contract_reference" text,
	"clause" text,
	"scope" text NOT NULL,
	"auditor_name" text,
	"auditor_user_id" text,
	"notice_date" text NOT NULL,
	"notice_days" integer,
	"scheduled_date" text,
	"access_granted_at" timestamp with time zone,
	"records_requested" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"obstruction_note" text,
	"status" text DEFAULT 'notified' NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text,
	"obligation_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_off_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"scope" text,
	"route" text DEFAULT 'direct_award' NOT NULL,
	"framework_id" text,
	"lot_id" text,
	"mini_competition_id" text,
	"term_contract_id" text,
	"vendor_id" text,
	"supplier_name" text NOT NULL,
	"currency" text NOT NULL,
	"order_value" double precision DEFAULT 0 NOT NULL,
	"certified_value" double precision DEFAULT 0 NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commitment_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"issued_at" text,
	"required_by" text,
	"completed_at" text,
	"justification" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "defined_cost_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"verification_id" text NOT NULL,
	"component" text NOT NULL,
	"contract_heading" text,
	"description" text NOT NULL,
	"currency" text NOT NULL,
	"claimed_amount" double precision DEFAULT 0 NOT NULL,
	"verified_amount" double precision DEFAULT 0 NOT NULL,
	"verdict" text DEFAULT 'pending' NOT NULL,
	"evidence_ref" text,
	"evidence_id" text,
	"source_type" text,
	"source_id" text,
	"verifier_note" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disallowed_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"verification_id" text,
	"defined_cost_item_id" text,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"ground_clause" text,
	"currency" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"deducted_amount" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'raised' NOT NULL,
	"raised_by" text NOT NULL,
	"raised_at" text NOT NULL,
	"response_due_at" text,
	"contractor_response" text,
	"responded_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"obligation_id" text,
	"deduction_ref_type" text,
	"deduction_ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "framework_agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"portfolio_id" text,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"contracting_authority" text,
	"start_date" text,
	"end_date" text,
	"extension_to_date" text,
	"currency" text NOT NULL,
	"maximum_value" double precision,
	"award_mode" text DEFAULT 'mini_competition' NOT NULL,
	"direct_award_threshold" double precision,
	"status" text DEFAULT 'draft' NOT NULL,
	"rules_reference" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "framework_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"framework_id" text NOT NULL,
	"lot_number" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"currency" text NOT NULL,
	"ceiling_value" double precision,
	"award_mode" text,
	"status" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "framework_mini_competitions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"framework_id" text NOT NULL,
	"lot_id" text,
	"project_id" text,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"scope" text,
	"currency" text NOT NULL,
	"estimated_value" double precision,
	"invited_supplier_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluation_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issued_at" text,
	"responses_due_at" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"awarded_supplier_id" text,
	"awarded_supplier_name" text,
	"award_value" double precision,
	"awarded_at" timestamp with time zone,
	"awarded_by" text,
	"decision_note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "framework_suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"framework_id" text NOT NULL,
	"lot_id" text,
	"vendor_id" text,
	"supplier_name" text NOT NULL,
	"rank" integer,
	"status" text DEFAULT 'appointed' NOT NULL,
	"appointed_at" text,
	"suspended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "joint_ventures" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"structure" text DEFAULT 'joint_venture' NOT NULL,
	"currency" text NOT NULL,
	"formation_date" text,
	"end_date" text,
	"deed_reference" text,
	"registered_number" text,
	"jurisdiction" text,
	"quorum_percent" double precision,
	"reserved_matter_threshold_percent" double precision,
	"status" text DEFAULT 'forming' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jv_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"jv_id" text NOT NULL,
	"reference" text,
	"decision_type" text DEFAULT 'ordinary' NOT NULL,
	"meeting_date" text NOT NULL,
	"subject" text NOT NULL,
	"narrative" text,
	"deed_clause" text,
	"votes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"share_present_percent" double precision,
	"share_for_percent" double precision,
	"quorum_met" integer DEFAULT 0 NOT NULL,
	"threshold_met" integer DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT 'deferred' NOT NULL,
	"obligation_id" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jv_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"jv_id" text NOT NULL,
	"name" text NOT NULL,
	"entity_id" text,
	"vendor_id" text,
	"role" text DEFAULT 'partner' NOT NULL,
	"share_percent" double precision DEFAULT 0 NOT NULL,
	"committed_capital" double precision,
	"liability_basis" text DEFAULT 'joint_and_several' NOT NULL,
	"is_self" integer DEFAULT 0 NOT NULL,
	"board_seats" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" text,
	"left_at" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jv_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"jv_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"due_date" text,
	"settled_date" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"reference" text,
	"obligation_id" text,
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_book_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"target_cost_id" text,
	"period_start" text,
	"period_end" text,
	"currency" text NOT NULL,
	"claimed_amount" double precision DEFAULT 0 NOT NULL,
	"verified_amount" double precision DEFAULT 0 NOT NULL,
	"queried_amount" double precision DEFAULT 0 NOT NULL,
	"disallowed_amount" double precision DEFAULT 0 NOT NULL,
	"pending_amount" double precision DEFAULT 0 NOT NULL,
	"totals_calculated_at" timestamp with time zone,
	"audit_rights_clause" text,
	"component_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"methodology" text,
	"sampling" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verifier_id" text,
	"verifier_name" text,
	"planned_at" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"reported_at" timestamp with time zone,
	"findings" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pain_gain_calculations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"target_cost_id" text NOT NULL,
	"basis" text DEFAULT 'forecast' NOT NULL,
	"currency" text NOT NULL,
	"adjusted_target" double precision DEFAULT 0 NOT NULL,
	"outturn_cost" double precision DEFAULT 0 NOT NULL,
	"variance" double precision DEFAULT 0 NOT NULL,
	"contractor_share" double precision DEFAULT 0 NOT NULL,
	"client_share" double precision DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"funding_source_id" text,
	"appropriation_id" text,
	"fiscal_year" text,
	"currency" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"drawn_amount" double precision DEFAULT 0 NOT NULL,
	"expenditure_class" text DEFAULT 'capital' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"whole_life_cost" double precision,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_appropriations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"portfolio_id" text,
	"funding_source_id" text,
	"fiscal_year" text NOT NULL,
	"period_start" text,
	"period_end" text,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"appropriated_amount" double precision DEFAULT 0 NOT NULL,
	"carried_forward_in" double precision DEFAULT 0 NOT NULL,
	"carried_forward_out" double precision DEFAULT 0 NOT NULL,
	"virement_net" double precision DEFAULT 0 NOT NULL,
	"expenditure_class" text DEFAULT 'capital' NOT NULL,
	"carry_forward_policy" text DEFAULT 'request' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"carried_forward_from_id" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_envelopes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"portfolio_id" text,
	"name" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"currency" text NOT NULL,
	"envelope_amount" double precision DEFAULT 0 NOT NULL,
	"basis" text,
	"expenditure_class" text DEFAULT 'capital' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"superseded_by_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_funding_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"portfolio_id" text,
	"reference" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text,
	"currency" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"available_from" text,
	"available_to" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"expenditure_class" text DEFAULT 'capital' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"model_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"scored_by" text NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_scoring_models" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"portfolio_id" text,
	"name" text NOT NULL,
	"description" text,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"normalisation" text DEFAULT 'fixed_scale' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_virements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"from_appropriation_id" text NOT NULL,
	"to_appropriation_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_of_rates_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"term_contract_id" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"category" text,
	"unit" text NOT NULL,
	"currency" text NOT NULL,
	"rate" double precision DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_cost_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"contract_reference" text,
	"is_alliance" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"base_target_cost" double precision DEFAULT 0 NOT NULL,
	"target_adjustments" double precision DEFAULT 0 NOT NULL,
	"actual_defined_cost" double precision DEFAULT 0 NOT NULL,
	"forecast_defined_cost" double precision,
	"fee_percent" double precision DEFAULT 0 NOT NULL,
	"mechanism" text DEFAULT 'banded_share' NOT NULL,
	"share_bands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pain_cap" double precision,
	"gain_cap" double precision,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"portfolio_id" text,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"vendor_id" text,
	"supplier_name" text NOT NULL,
	"currency" text NOT NULL,
	"start_date" text,
	"end_date" text,
	"maximum_value" double precision,
	"adjustment_percent" double precision DEFAULT 0 NOT NULL,
	"adjustment_basis" text DEFAULT 'none' NOT NULL,
	"index_reference" text,
	"price_base_date" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_access_passes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"induction_id" text,
	"worker_id" text,
	"person_name" text NOT NULL,
	"person_kind" text DEFAULT 'worker' NOT NULL,
	"vendor_id" text,
	"badge_code" text NOT NULL,
	"credential_type" text DEFAULT 'badge' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" text,
	"valid_until" text,
	"zones_allowed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issued_by" text,
	"issued_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_drone_flights" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"purpose" text DEFAULT 'progress' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"pilot_name" text,
	"pilot_licence_ref" text,
	"operator_vendor_id" text,
	"aircraft" text,
	"planned_for" timestamp with time zone,
	"flown_at" timestamp with time zone,
	"duration_minutes" double precision,
	"permission_status" text DEFAULT 'pending' NOT NULL,
	"permission_ref" text,
	"airspace_notes" text,
	"max_altitude_m" double precision,
	"area_covered_m2" double precision,
	"image_count" integer,
	"weather_observation_id" text,
	"risk_assessment_ref" text,
	"grounded_reason" text,
	"outputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_environmental_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"category" text NOT NULL,
	"detected_via" text DEFAULT 'observation' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"duration_minutes" double precision,
	"magnitude" double precision,
	"magnitude_unit" text,
	"threshold_value" double precision,
	"threshold_unit" text,
	"exceeded_threshold" integer DEFAULT 0 NOT NULL,
	"severity" text DEFAULT 'low' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"location_id" text,
	"zone_id" text,
	"lat" double precision,
	"lon" double precision,
	"sensor_ref" text,
	"impact" text,
	"work_stopped" integer DEFAULT 0 NOT NULL,
	"stoppage_minutes" double precision,
	"actions_taken" text,
	"weather_observation_id" text,
	"assurance_event_id" text,
	"signal_id" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"reported_by_name" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_exclusion_zones" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"permit_id" text,
	"ring" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"centre_lat" double precision,
	"centre_lon" double precision,
	"radius_m" double precision,
	"status" text DEFAULT 'planned' NOT NULL,
	"severity" text DEFAULT 'high' NOT NULL,
	"active_from" timestamp with time zone,
	"active_to" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_gate_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"gate_name" text DEFAULT 'main' NOT NULL,
	"device_id" text,
	"pass_id" text,
	"worker_id" text,
	"badge_code" text,
	"person_name" text,
	"person_kind" text,
	"vendor_id" text,
	"direction" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'turnstile' NOT NULL,
	"accepted" integer DEFAULT 1 NOT NULL,
	"refusal_reason" text,
	"zone_id" text,
	"lat" double precision,
	"lon" double precision,
	"external_ref" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_geotech_investigations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"hole_ref" text NOT NULL,
	"kind" text DEFAULT 'borehole' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"is_baseline" integer DEFAULT 0 NOT NULL,
	"baseline_investigation_id" text,
	"contractor_vendor_id" text,
	"investigated_on" text,
	"location_description" text,
	"lat" double precision,
	"lon" double precision,
	"easting" double precision,
	"northing" double precision,
	"ground_level_m" double precision,
	"depth_m" double precision,
	"water_strike_depth_m" double precision,
	"strata" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lab_test_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_ground_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"investigation_id" text NOT NULL,
	"baseline_investigation_id" text,
	"category" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"depth_from_m" double precision,
	"depth_to_m" double precision,
	"baseline_description" text,
	"observed_description" text NOT NULL,
	"differs_from_baseline" integer DEFAULT 1 NOT NULL,
	"variance_notes" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detection_method" text DEFAULT 'comparison' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assessed_by" text,
	"assessed_at" timestamp with time zone,
	"assessment_notes" text,
	"change_event_id" text,
	"signal_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_inductions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text,
	"person_name" text NOT NULL,
	"person_kind" text DEFAULT 'worker' NOT NULL,
	"vendor_id" text,
	"induction_type" text DEFAULT 'general' NOT NULL,
	"language" text,
	"conducted_by" text,
	"conducted_by_name" text,
	"conducted_at" timestamp with time zone,
	"valid_from" text,
	"valid_until" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score_percent" double precision,
	"pass_mark" double precision,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_lone_worker_checkins" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"checked_in_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"late_seconds" double precision,
	"lat" double precision,
	"lon" double precision,
	"method" text DEFAULT 'mobile' NOT NULL,
	"ok" integer DEFAULT 1 NOT NULL,
	"note" text,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_lone_worker_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text,
	"pass_id" text,
	"person_name" text NOT NULL,
	"activity" text NOT NULL,
	"location_id" text,
	"location_description" text,
	"lat" double precision,
	"lon" double precision,
	"started_at" timestamp with time zone NOT NULL,
	"interval_minutes" integer DEFAULT 30 NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"last_check_in_at" timestamp with time zone,
	"check_in_count" integer DEFAULT 0 NOT NULL,
	"missed_count" integer DEFAULT 0 NOT NULL,
	"expected_end_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"escalated_at" timestamp with time zone,
	"escalation_signal_id" text,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"contact_name" text,
	"contact_phone" text,
	"watcher_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_muster_checkins" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"muster_id" text NOT NULL,
	"person_key" text NOT NULL,
	"person_name" text NOT NULL,
	"pass_id" text,
	"worker_id" text,
	"status" text DEFAULT 'present' NOT NULL,
	"unexpected" integer DEFAULT 0 NOT NULL,
	"method" text DEFAULT 'manual' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_musters" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"kind" text DEFAULT 'drill' NOT NULL,
	"muster_point" text,
	"declared_at" timestamp with time zone NOT NULL,
	"declared_by" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expected_count" integer DEFAULT 0 NOT NULL,
	"accounted_count" integer DEFAULT 0 NOT NULL,
	"unaccounted_count" integer DEFAULT 0 NOT NULL,
	"unexpected_count" integer DEFAULT 0 NOT NULL,
	"expected_register" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleared_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" text,
	"duration_seconds" double precision,
	"signal_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_permit_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"permit_id" text NOT NULL,
	"person_name" text NOT NULL,
	"worker_id" text,
	"pass_id" text,
	"attendant_name" text,
	"entered_at" timestamp with time zone NOT NULL,
	"expected_exit_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"status" text DEFAULT 'inside' NOT NULL,
	"overdue_at" timestamp with time zone,
	"gas_readings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signal_id" text,
	"notes" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_permits" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"permit_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location_id" text,
	"location_description" text,
	"exclusion_zone_id" text,
	"vendor_id" text,
	"supervisor_name" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"issued_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspend_reason" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"closure_notes" text,
	"expired_at" timestamp with time zone,
	"precautions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"isolations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_occupancy" integer,
	"requires_gas_test" integer DEFAULT 0 NOT NULL,
	"gas_test_interval_minutes" integer,
	"fire_watch_minutes" integer,
	"fire_watch_completed_at" timestamp with time zone,
	"utility_scan_id" text,
	"risk_assessment_ref" text,
	"safety_record_id" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signal_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_photo_tour_stations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"tour_id" text NOT NULL,
	"name" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone,
	"file_id" text,
	"photo_id" text,
	"lat" double precision,
	"lon" double precision,
	"elevation_m" double precision,
	"heading_deg" double precision,
	"location_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_photo_tours" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"captured_at" timestamp with time zone,
	"captured_by_name" text,
	"location_id" text,
	"level" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"station_count" integer DEFAULT 0 NOT NULL,
	"coverage_notes" text,
	"scan_id" text,
	"drone_flight_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_progress_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"zone_name" text NOT NULL,
	"location_id" text,
	"schedule_task_id" text,
	"work_package_ref" text,
	"claimed_percent" double precision NOT NULL,
	"observed_percent" double precision NOT NULL,
	"variance_percent" double precision NOT NULL,
	"method" text DEFAULT 'visual' NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observed_by" text NOT NULL,
	"observed_by_name" text,
	"claim_source_type" text DEFAULT 'manual' NOT NULL,
	"claim_source_id" text,
	"claimant_id" text NOT NULL,
	"claimant_kind" text DEFAULT 'user' NOT NULL,
	"claimed_at" timestamp with time zone,
	"scan_id" text,
	"drone_flight_id" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assertion_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"reconciliation_id" text NOT NULL,
	"result" text NOT NULL,
	"confidence" double precision,
	"independence_score" double precision,
	"signal_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_scan_deviations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scan_id" text NOT NULL,
	"model_id" text,
	"model_version" text,
	"reference" text NOT NULL,
	"number" integer NOT NULL,
	"method" text DEFAULT 'cloud_to_mesh' NOT NULL,
	"tolerance_mm" double precision NOT NULL,
	"marginal_factor" double precision DEFAULT 0.8 NOT NULL,
	"element_count" integer DEFAULT 0 NOT NULL,
	"within_tolerance_count" integer DEFAULT 0 NOT NULL,
	"marginal_count" integer DEFAULT 0 NOT NULL,
	"out_of_tolerance_count" integer DEFAULT 0 NOT NULL,
	"max_deviation_mm" double precision,
	"mean_abs_deviation_mm" double precision,
	"rms_deviation_mm" double precision,
	"verdict" text DEFAULT 'not_assessable' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"by_zone" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signal_id" text,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"notes" text,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"method" text DEFAULT 'terrestrial_laser' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"captured_at" timestamp with time zone,
	"captured_by_name" text,
	"vendor_id" text,
	"location_id" text,
	"area_description" text,
	"drone_flight_id" text,
	"setup_count" integer,
	"point_count_millions" double precision,
	"size_mb" double precision,
	"coordinate_system" text,
	"registration_status" text DEFAULT 'unregistered' NOT NULL,
	"registration_error_mm" double precision,
	"control_point_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_id" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_setting_out_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"description" text NOT NULL,
	"element_ref" text,
	"location_id" text,
	"schedule_task_id" text,
	"drawing_id" text,
	"drawing_revision" text,
	"method" text DEFAULT 'total_station' NOT NULL,
	"control_point_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tolerance_mm" double precision,
	"max_deviation_mm" double precision,
	"set_out_by" text NOT NULL,
	"set_out_by_name" text,
	"set_out_at" timestamp with time zone,
	"checked_by" text,
	"checked_by_name" text,
	"checked_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"rejection_reason" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_survey_points" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"point_ref" text NOT NULL,
	"kind" text DEFAULT 'control' NOT NULL,
	"easting" double precision,
	"northing" double precision,
	"elevation" double precision,
	"lat" double precision,
	"lon" double precision,
	"coordinate_system" text,
	"datum" text,
	"method" text DEFAULT 'gnss' NOT NULL,
	"accuracy_mm" double precision,
	"established_by_name" text,
	"established_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_checked_by" text,
	"last_delta_mm" double precision,
	"superseded_by_id" text,
	"description" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_utility_services" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"service_ref" text NOT NULL,
	"utility_type" text DEFAULT 'unknown' NOT NULL,
	"owner_name" text,
	"specification" text,
	"depth_m" double precision,
	"route" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detection_method" text DEFAULT 'records' NOT NULL,
	"confidence" text DEFAULT 'unknown' NOT NULL,
	"survey_scan_id" text,
	"marked_out_at" timestamp with time zone,
	"marked_out_by_name" text,
	"mark_valid_until" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_utility_strikes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"utility_type" text DEFAULT 'unknown' NOT NULL,
	"service_id" text,
	"permit_id" text,
	"severity" text DEFAULT 'near_miss' NOT NULL,
	"status" text DEFAULT 'reported' NOT NULL,
	"location_description" text,
	"lat" double precision,
	"lon" double precision,
	"depth_m" double precision,
	"injuries" integer DEFAULT 0 NOT NULL,
	"services_lost" text,
	"contractor_vendor_id" text,
	"operative_name" text,
	"plant_type" text,
	"permit_in_place" integer DEFAULT 0 NOT NULL,
	"scan_completed" integer DEFAULT 0 NOT NULL,
	"marks_present" integer DEFAULT 0 NOT NULL,
	"root_cause" text,
	"immediate_actions" text,
	"reported_to_owner_at" timestamp with time zone,
	"cost_estimate" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"incident_id" text,
	"signal_id" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_weather_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"baseline_id" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"days_in_period" integer DEFAULT 0 NOT NULL,
	"days_observed" integer DEFAULT 0 NOT NULL,
	"observed_adverse_days" double precision,
	"baseline_adverse_days" double precision,
	"exceptional_days" double precision,
	"hours_lost" double precision,
	"coverage_percent" double precision,
	"by_month" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adverse_day_detail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delay_event_id" text,
	"issued_at" timestamp with time zone,
	"issued_by" text,
	"superseded_by_id" text,
	"notes" text,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_weather_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text DEFAULT 'contract' NOT NULL,
	"contract_ref" text,
	"method" text,
	"period_start" text,
	"period_end" text,
	"thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_expected_adverse_days" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_weather_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"observed_on" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"provider" text,
	"station_ref" text,
	"temp_min_c" double precision,
	"temp_max_c" double precision,
	"temp_mean_c" double precision,
	"precipitation_mm" double precision,
	"snowfall_mm" double precision,
	"wind_mean_kph" double precision,
	"wind_gust_kph" double precision,
	"humidity_pct" double precision,
	"visibility_m" double precision,
	"sea_state_m" double precision,
	"conditions" text,
	"work_stopped" integer DEFAULT 0 NOT NULL,
	"hours_lost" double precision,
	"affected_activities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adverse" integer,
	"adverse_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb,
	"recorded_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"resource_type_id" text,
	"subject_kind" text NOT NULL,
	"crew_id" text,
	"worker_id" text,
	"equipment_id" text,
	"subject_label" text NOT NULL,
	"schedule_task_id" text,
	"schedule_id" text,
	"location_id" text,
	"from_date" text NOT NULL,
	"to_date" text NOT NULL,
	"shift" text DEFAULT 'day' NOT NULL,
	"hours_per_day" double precision,
	"allocation_percent" double precision DEFAULT 100 NOT NULL,
	"planned_hours" double precision,
	"status" text DEFAULT 'planned' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_reason" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_availability" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"week_start" text NOT NULL,
	"available_hours" double precision DEFAULT 0 NOT NULL,
	"available_headcount" double precision,
	"source" text DEFAULT 'manual' NOT NULL,
	"vendor_id" text,
	"commitment_id" text,
	"note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_demands" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"resource_type_id" text NOT NULL,
	"week_start" text NOT NULL,
	"demand_hours" double precision DEFAULT 0 NOT NULL,
	"headcount" double precision,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_task_id" text,
	"source_schedule_id" text,
	"basis" text,
	"location_id" text,
	"crew_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_forecasts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"resource_type_id" text,
	"as_of_date" text NOT NULL,
	"method" text DEFAULT 'productivity_factor' NOT NULL,
	"budget_hours" double precision,
	"actual_hours" double precision DEFAULT 0 NOT NULL,
	"earned_hours" double precision,
	"productivity_factor" double precision,
	"percent_complete" double precision,
	"remaining_hours" double precision,
	"forecast_hours_at_completion" double precision,
	"variance_hours" double precision,
	"confidence" text,
	"basis" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"plan_kind" text DEFAULT 'current' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"schedule_id" text,
	"period_start" text,
	"period_end" text,
	"week_starts_on" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_plan_id" text,
	"derived_at" timestamp with time zone,
	"derived_task_count" integer DEFAULT 0 NOT NULL,
	"skipped_task_count" integer DEFAULT 0 NOT NULL,
	"demand_row_count" integer DEFAULT 0 NOT NULL,
	"total_demand_hours" double precision DEFAULT 0 NOT NULL,
	"peak_headcount" double precision,
	"peak_week_start" text,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_productivity_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"week_start" text,
	"scope" text DEFAULT 'project' NOT NULL,
	"scope_id" text,
	"scope_label" text,
	"actual_hours" double precision DEFAULT 0 NOT NULL,
	"earned_hours" double precision,
	"productivity_factor" double precision,
	"installed_quantity" double precision,
	"unit" text,
	"achieved_unit_rate" double precision,
	"planned_unit_rate" double precision,
	"lines_measured" integer DEFAULT 0 NOT NULL,
	"lines_unmeasurable" integer DEFAULT 0 NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"basis" text,
	"captured_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'skill' NOT NULL,
	"trade" text,
	"issuing_body" text,
	"validity_months" integer,
	"requires_evidence" integer DEFAULT 0 NOT NULL,
	"is_mandatory" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_types" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'labour' NOT NULL,
	"trade" text,
	"equipment_category" text,
	"unit" text DEFAULT 'hours' NOT NULL,
	"standard_hours_per_day" double precision,
	"working_days_per_week" double precision,
	"default_hourly_cost" double precision,
	"currency" text DEFAULT 'USD' NOT NULL,
	"required_skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"maps_to_trade" text,
	"status" text DEFAULT 'active' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"level" text DEFAULT 'competent' NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"certificate_ref" text,
	"issuing_body" text,
	"issued_at" text,
	"expires_at" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"rejected_reason" text,
	"evidence_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"expiry_notified_at" timestamp with time zone,
	"expiry_notified_for_date" text,
	"notes" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"agent_kind" text NOT NULL,
	"run_id" text,
	"review_id" text,
	"action_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"before_image" jsonb,
	"after_image" jsonb,
	"status" text DEFAULT 'applied' NOT NULL,
	"reversible" integer DEFAULT 1 NOT NULL,
	"irreversible_reason" text,
	"applied_by" text,
	"applied_at" timestamp with time zone,
	"rolled_back_by" text,
	"rolled_back_at" timestamp with time zone,
	"rollback_reason" text,
	"authorisation" text DEFAULT 'propose_only' NOT NULL,
	"policy_id" text,
	"confidence" double precision,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_kind" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"authorisation" text DEFAULT 'propose_only' NOT NULL,
	"auto_apply_min_confidence" double precision,
	"allowed_target_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_runs_per_day" integer,
	"max_input_tokens_per_day" integer,
	"max_output_tokens_per_day" integer,
	"min_confidence" double precision,
	"notes" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"window_from" text,
	"window_to" text,
	"generated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_meta" (
	"run_id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"agent_kind" text NOT NULL,
	"prompt_version" text NOT NULL,
	"agent_version" text NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"source_ref" text,
	"evidence_score" double precision,
	"evidence_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dropped_citations" integer DEFAULT 0 NOT NULL,
	"citation_count" integer DEFAULT 0 NOT NULL,
	"input_ref_count" integer DEFAULT 0 NOT NULL,
	"data_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposal_count" integer DEFAULT 0 NOT NULL,
	"action_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"agent_kind" text NOT NULL,
	"name" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"every_minutes" integer DEFAULT 1440 NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_run_id" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_usage_daily" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"usage_date" text NOT NULL,
	"agent_kind" text NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "distribution_groups_uq";--> statement-breakpoint
DROP INDEX "cost_codes_uq";--> statement-breakpoint
DROP INDEX "custom_field_defs_uq";--> statement-breakpoint
DROP INDEX "drawing_revisions_set_idx";--> statement-breakpoint
DROP INDEX "auth_security_events_email_idx";--> statement-breakpoint
ALTER TABLE "drawing_hyperlinks" ALTER COLUMN "to_sheet_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "timecard_batches" ALTER COLUMN "total_cost" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "timecard_batches" ALTER COLUMN "total_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bid_submissions" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_events" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "distribution_group_members" ADD COLUMN "member_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD COLUMN "company_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "is_sandbox" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cloned_from_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "watchers" ADD COLUMN "company_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "watchers" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "file_access_log" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "file_access_log" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "file_access_log" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "file_access_log" ADD COLUMN "version" integer;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "checked_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "stale_checkout_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "document_type" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "revision_label" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "drawing_hyperlinks" ADD COLUMN "target_number" text;--> statement-breakpoint
ALTER TABLE "drawing_hyperlinks" ADD COLUMN "confidence" double precision;--> statement-breakpoint
ALTER TABLE "drawing_hyperlinks" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_hyperlinks" ADD COLUMN "detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_markups" ADD COLUMN "carried_from_revision_id" text;--> statement-breakpoint
ALTER TABLE "drawing_markups" ADD COLUMN "review_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_pins" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "drawing_pins" ADD COLUMN "location_id" text;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "text_items" jsonb;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "has_text_layer" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "detection" jsonb;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "extraction" jsonb;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "supersedes_revision_id" text;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "changed_regions" jsonb;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "change_verdict" text;--> statement-breakpoint
ALTER TABLE "drawing_revisions" ADD COLUMN "diff_computed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "processing_error" text;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "processing_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "processed_pages" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "sheets_created" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "revisions_added" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "auto_links_created" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "unresolved_callouts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "drawing_sets" ADD COLUMN "detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "type_name" text;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "storey" text;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "spatial_global_id" text;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "property_hash" text;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "min_x" double precision;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "min_y" double precision;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "min_z" double precision;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "max_x" double precision;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "max_y" double precision;--> statement-breakpoint
ALTER TABLE "bim_elements" ADD COLUMN "max_z" double precision;--> statement-breakpoint
ALTER TABLE "bim_model_versions" ADD COLUMN "processing_error" text;--> statement-breakpoint
ALTER TABLE "bim_model_versions" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bim_model_versions" ADD COLUMN "size_bytes" double precision;--> statement-breakpoint
ALTER TABLE "bim_model_versions" ADD COLUMN "spatial_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bim_model_versions" ADD COLUMN "authorised_by" text;--> statement-breakpoint
ALTER TABLE "bim_model_versions" ADD COLUMN "authorised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bim_model_versions" ADD COLUMN "authorisation_note" text;--> statement-breakpoint
ALTER TABLE "bim_model_versions" ADD COLUMN "quality_report" jsonb;--> statement-breakpoint
ALTER TABLE "coordination_issues" ADD COLUMN "rfi_id" text;--> statement-breakpoint
ALTER TABLE "coordination_issues" ADD COLUMN "clash_result_id" text;--> statement-breakpoint
ALTER TABLE "coordination_issues" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "coordination_issues" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coordination_issues" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coordination_issues" ADD COLUMN "overdue_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "decommissioned_at" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "design_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD COLUMN "accepted_by" text;--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "sensor_readings" ADD COLUMN "source" text DEFAULT 'ingest' NOT NULL;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "stale_after_minutes" double precision;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "cooldown_minutes" double precision DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "design_setpoint" double precision;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "last_reading_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "last_value" double precision;--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "last_alert_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "obligation_id" text;--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "notified_days" integer;--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "log_kind" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "vendor_id" text;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "weather_source" text;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "weather_provider" text;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "weather_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD COLUMN "distributed_to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "is_360" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "pin" jsonb;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "exif" jsonb;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "ai_status" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "ai_error" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "punch_items" ADD COLUMN "trade" text;--> statement-breakpoint
ALTER TABLE "punch_items" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "punch_items" ADD COLUMN "distribution" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "punch_items" ADD COLUMN "ready_for_review_by" text;--> statement-breakpoint
ALTER TABLE "punch_items" ADD COLUMN "ready_for_review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "punch_items" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "punch_items" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "punch_items" ADD COLUMN "observation_id" text;--> statement-breakpoint
ALTER TABLE "rfis" ADD COLUMN "issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfis" ADD COLUMN "is_private" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rfis" ADD COLUMN "visible_to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rfis" ADD COLUMN "related_rfi_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rfis" ADD COLUMN "file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rfis" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "rfis" ADD COLUMN "source_meta" jsonb;--> statement-breakpoint
ALTER TABLE "rfis" ADD COLUMN "response_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submittal_review_steps" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submittals" ADD COLUMN "superseded_by_id" text;--> statement-breakpoint
ALTER TABLE "submittals" ADD COLUMN "review_allowance_days" integer;--> statement-breakpoint
ALTER TABLE "submittals" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submittals" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submittals" ADD COLUMN "distribution" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "submittals" ADD COLUMN "is_closeout" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submittals" ADD COLUMN "vendor_id" text;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "workflow_step_instances" ADD COLUMN "assigned_via" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_step_instances" ADD COLUMN "assigned_via_key" text;--> statement-breakpoint
ALTER TABLE "workflow_step_instances" ADD COLUMN "quorum" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_step_instances" ADD COLUMN "escalate_at" text;--> statement-breakpoint
ALTER TABLE "workflow_step_instances" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_step_instances" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_step_instances" ADD COLUMN "reassigned_from" text;--> statement-breakpoint
ALTER TABLE "workflow_step_instances" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "assertions" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "delete_reason" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "occurrences" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "superseded_by_id" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "auto_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "certified_sections" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "retention_released" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "due_date_basis" text;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "withdrawn_reason" text;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "withdrawn_by" text;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "superseded_by_id" text;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "paid_amount" double precision;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_certificates" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "takeoff_lines" ADD COLUMN "deduct" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "valuations" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "valuations" ADD COLUMN "retention_cap" double precision;--> statement-breakpoint
ALTER TABLE "valuations" ADD COLUMN "sections_total" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "valuations" ADD COLUMN "gross_total" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "valuations" ADD COLUMN "retention_released" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "valuations" ADD COLUMN "due_date" text;--> statement-breakpoint
ALTER TABLE "valuations" ADD COLUMN "due_date_basis" text;--> statement-breakpoint
ALTER TABLE "valuations" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "variations" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "awareness_date" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "effective_time_bar_days" integer;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "deadline_source" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "calendar_basis" text DEFAULT 'calendar' NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "warn_days_before" integer;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "notice_served_late" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "deadline_at_service" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "late_reason" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "service_evidence_ref" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "chain_parent_id" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "chain_stage" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "ce_state" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "quotation_due_date" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "reply_due_date" text;--> statement-breakpoint
ALTER TABLE "contract_events" ADD COLUMN "deemed_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "taking_over_date" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "actual_completion_date" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "retention_release_at_taking_over" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "payment_due_days" integer;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "calendar_basis" text DEFAULT 'calendar' NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "holidays" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
ALTER TABLE "eot_claims" ADD COLUMN "assessment" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "wbs_path" text;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "remaining_duration_days" integer;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "task_type" text DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "calendar_id" text;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "contractual_date" text;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "is_key_milestone" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "slip_alerted_days" integer;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "slip_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "budget_line_item_id" text;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "budgeted_cost" double precision;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "budgeted_hours" double precision;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "data_date" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "source" text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "parent_schedule_id" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "default_calendar_id" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "delay_events" ADD COLUMN "party" text DEFAULT 'neither' NOT NULL;--> statement-breakpoint
ALTER TABLE "delay_events" ADD COLUMN "pacing_of_event_id" text;--> statement-breakpoint
ALTER TABLE "delay_events" ADD COLUMN "notice_due_date" text;--> statement-breakpoint
ALTER TABLE "delay_events" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "delay_events" ADD COLUMN "notice_obligation_id" text;--> statement-breakpoint
ALTER TABLE "delay_events" ADD COLUMN "notice_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "quantum_best" double precision;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "quantum_likely" double precision;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "quantum_worst" double precision;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "success_probability" double precision;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "provision_amount" double precision;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "sufficiency" jsonb;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "sufficiency_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "scott_schedule" jsonb;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "package_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "assessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "revision_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "forensic_claims" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD COLUMN "source_ref" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN "format" text DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN "last_status" text;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN "run_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingested_records" ADD COLUMN "matched_record_id" text;--> statement-breakpoint
ALTER TABLE "ingested_records" ADD COLUMN "diff" jsonb;--> statement-breakpoint
ALTER TABLE "ingested_records" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "mode" text DEFAULT 'insert' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "updated_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "pages_fetched" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "progress_note" text;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "connector_cursor" text;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "parser" text DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "benchmark_samples" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "benchmark_samples" ADD COLUMN "size_band" text;--> statement-breakpoint
ALTER TABLE "benchmark_samples" ADD COLUMN "procurement_route" text;--> statement-breakpoint
ALTER TABLE "benchmark_samples" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "benchmark_samples" ADD COLUMN "superseded_by_sample_id" text;--> statement-breakpoint
ALTER TABLE "project_metric_snapshots" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "project_metric_snapshots" ADD COLUMN "outlier_signal_id" text;--> statement-breakpoint
ALTER TABLE "bonds" ADD COLUMN "facility_id" text;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD COLUMN "renewal_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD COLUMN "renewal_owner_id" text;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD COLUMN "renewal_target_date" text;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD COLUMN "renewal_notes" text;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD COLUMN "previous_policy_id" text;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD COLUMN "renewed_by_policy_id" text;--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD COLUMN "outcome" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD COLUMN "outcome_value" double precision;--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD COLUMN "outcome_currency" text;--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD COLUMN "outcome_days" integer;--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD COLUMN "measured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD COLUMN "measured_by" text;--> statement-breakpoint
ALTER TABLE "lesson_triggers" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "secret_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "signature_next" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "previous_secret_version" integer;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "consecutive_errors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "circuit_open_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "verified_host" text;--> statement-breakpoint
ALTER TABLE "spec_section_revisions" ADD COLUMN "impact" jsonb;--> statement-breakpoint
ALTER TABLE "spec_sections" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spec_sections" ADD COLUMN "withdrawn_by" text;--> statement-breakpoint
ALTER TABLE "spec_sections" ADD COLUMN "withdrawn_reason" text;--> statement-breakpoint
ALTER TABLE "spec_submittal_requirements" ADD COLUMN "needs_reconfirmation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_submittal_requirements" ADD COLUMN "superseded_by_revision_id" text;--> statement-breakpoint
ALTER TABLE "spec_submittal_requirements" ADD COLUMN "reissue_note" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "minutes_sha256" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "minutes_rendered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "minutes_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "minutes_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "agenda_pack_file_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "agenda_pack_sha256" text;--> statement-breakpoint
ALTER TABLE "material_items" ADD COLUMN "schedule_activity_id" text;--> statement-breakpoint
ALTER TABLE "material_items" ADD COLUMN "required_on_site_date" text;--> statement-breakpoint
ALTER TABLE "material_items" ADD COLUMN "order_placed_at" text;--> statement-breakpoint
ALTER TABLE "bid_awards" ADD COLUMN "recommended_comparable_amount" double precision;--> statement-breakpoint
ALTER TABLE "bid_awards" ADD COLUMN "comparison_basis" text;--> statement-breakpoint
ALTER TABLE "bid_awards" ADD COLUMN "scope_levelling_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bid_awards" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bid_awards" ADD COLUMN "withdrawn_by" text;--> statement-breakpoint
ALTER TABLE "bid_awards" ADD COLUMN "withdrawn_reason" text;--> statement-breakpoint
ALTER TABLE "bid_invitations" ADD COLUMN "portal_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bid_packages" ADD COLUMN "is_published" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bid_packages" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bid_packages" ADD COLUMN "published_by" text;--> statement-breakpoint
ALTER TABLE "bid_packages" ADD COLUMN "public_summary" text;--> statement-breakpoint
ALTER TABLE "bid_submissions" ADD COLUMN "superseded_by_id" text;--> statement-breakpoint
ALTER TABLE "prequalification_submissions" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "prequalification_submissions" ADD COLUMN "tier_basis" text;--> statement-breakpoint
ALTER TABLE "prequalification_submissions" ADD COLUMN "risk_rating" text;--> statement-breakpoint
ALTER TABLE "prequalification_submissions" ADD COLUMN "risk_basis" text;--> statement-breakpoint
ALTER TABLE "prequalification_submissions" ADD COLUMN "portal_token_hash" text;--> statement-breakpoint
ALTER TABLE "prequalification_submissions" ADD COLUMN "portal_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prequalification_submissions" ADD COLUMN "portal_last_access_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "provision_project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "idp_performs_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "mfa_amr_values" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "admin_delegations_user_idx" ON "admin_delegations" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "export_jobs_company_idx" ON "export_jobs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "legal_holds_company_idx" ON "legal_holds" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "legal_holds_scope_idx" ON "legal_holds" USING btree ("company_id","object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_uq" ON "retention_policies" USING btree ("company_id","object_type");--> statement-breakpoint
CREATE INDEX "vendor_merges_company_idx" ON "vendor_merges" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "vendor_merges_source_idx" ON "vendor_merges" USING btree ("source_vendor_id");--> statement-breakpoint
CREATE INDEX "import_jobs_company_idx" ON "import_jobs" USING btree ("company_id","dataset");--> statement-breakpoint
CREATE INDEX "import_jobs_status_idx" ON "import_jobs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "saved_views_lookup_idx" ON "saved_views" USING btree ("company_id","table_id");--> statement-breakpoint
CREATE INDEX "saved_views_owner_idx" ON "saved_views" USING btree ("owner_id","table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_name_uq" ON "saved_views" USING btree ("company_id","table_id","owner_id","name");--> statement-breakpoint
CREATE INDEX "document_inbound_emails_project_idx" ON "document_inbound_emails" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "document_inbound_emails_message_idx" ON "document_inbound_emails" USING btree ("project_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_issue_recipients_uq" ON "drawing_issue_recipients" USING btree ("issue_id","user_id");--> statement-breakpoint
CREATE INDEX "drawing_issue_recipients_user_idx" ON "drawing_issue_recipients" USING btree ("user_id","acknowledged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_issues_uq" ON "drawing_issues" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "drawing_issues_project_idx" ON "drawing_issues" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_sheet_permissions_uq" ON "drawing_sheet_permissions" USING btree ("project_id","scope","scope_value","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "drawing_sheet_permissions_project_idx" ON "drawing_sheet_permissions" USING btree ("project_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "bim_element_links_uq" ON "bim_element_links" USING btree ("project_id","link_type","target_id","global_id");--> statement-breakpoint
CREATE INDEX "bim_element_links_global_idx" ON "bim_element_links" USING btree ("project_id","global_id");--> statement-breakpoint
CREATE INDEX "bim_element_links_target_idx" ON "bim_element_links" USING btree ("project_id","link_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bim_version_diffs_uq" ON "bim_version_diffs" USING btree ("base_version_id","target_version_id");--> statement-breakpoint
CREATE INDEX "bim_version_diffs_model_idx" ON "bim_version_diffs" USING btree ("project_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clash_results_uq" ON "clash_results" USING btree ("test_id","fingerprint");--> statement-breakpoint
CREATE INDEX "clash_results_test_status_idx" ON "clash_results" USING btree ("test_id","status");--> statement-breakpoint
CREATE INDEX "clash_results_project_idx" ON "clash_results" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "clash_tests_project_idx" ON "clash_tests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "clash_tests_federation_idx" ON "clash_tests" USING btree ("federation_id");--> statement-breakpoint
CREATE INDEX "coordination_issue_comments_issue_idx" ON "coordination_issue_comments" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "geofences_project_idx" ON "geofences" USING btree ("project_id","is_active");--> statement-breakpoint
CREATE INDEX "reality_captures_project_idx" ON "reality_captures" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "reality_captures_version_idx" ON "reality_captures" USING btree ("model_version_id");--> statement-breakpoint
CREATE INDEX "milestone_containers_milestone_idx" ON "milestone_containers" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "sensor_alerts_sensor_idx" ON "sensor_alerts" USING btree ("sensor_id","status");--> statement-breakpoint
CREATE INDEX "sensor_alerts_project_idx" ON "sensor_alerts" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "warranty_claims_uq" ON "warranty_claims" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "warranty_claims_warranty_idx" ON "warranty_claims" USING btree ("warranty_id","status");--> statement-breakpoint
CREATE INDEX "daily_log_templates_project_idx" ON "daily_log_templates" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "field_escalations_uq" ON "field_escalations" USING btree ("record_type","record_id","level");--> statement-breakpoint
CREATE INDEX "field_escalations_project_idx" ON "field_escalations" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "field_observations_uq" ON "field_observations" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "field_observations_project_idx" ON "field_observations" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "field_observations_status_idx" ON "field_observations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "field_observations_assignee_idx" ON "field_observations" USING btree ("project_id","assignee_id");--> statement-breakpoint
CREATE INDEX "field_observations_due_idx" ON "field_observations" USING btree ("project_id","status","due_date");--> statement-breakpoint
CREATE INDEX "field_observations_type_idx" ON "field_observations" USING btree ("project_id","observation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "field_settings_uq" ON "field_settings" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "photo_albums_uq" ON "photo_albums" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "photo_albums_project_idx" ON "photo_albums" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "punch_templates_company_idx" ON "punch_templates" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "rfi_responses_rfi_idx" ON "rfi_responses" USING btree ("rfi_id","status");--> statement-breakpoint
CREATE INDEX "rfi_responses_project_idx" ON "rfi_responses" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submittal_response_codes_uq" ON "submittal_response_codes" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_uq" ON "notification_preferences" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "authority_limits_user_idx" ON "authority_limits" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "authority_limits_project_idx" ON "authority_limits" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conflict_declarations_uq" ON "conflict_declarations" USING btree ("company_id","user_id","entity_id","nature");--> statement-breakpoint
CREATE INDEX "conflict_declarations_user_idx" ON "conflict_declarations" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "conflict_declarations_entity_idx" ON "conflict_declarations" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "detector_policies_uq" ON "detector_policies" USING btree ("company_id","detector");--> statement-breakpoint
CREATE INDEX "detector_runs_company_idx" ON "detector_runs" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE INDEX "detector_runs_project_idx" ON "detector_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "evidence_pack_access_pack_idx" ON "evidence_pack_access" USING btree ("pack_id","at");--> statement-breakpoint
CREATE INDEX "evidence_packs_company_idx" ON "evidence_packs" USING btree ("company_id","generated_at");--> statement-breakpoint
CREATE INDEX "evidence_packs_project_idx" ON "evidence_packs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evidence_packs_case_idx" ON "evidence_packs" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "integrity_case_items_case_idx" ON "integrity_case_items" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "integrity_case_items_item_idx" ON "integrity_case_items" USING btree ("company_id","item_type","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrity_cases_reference_uq" ON "integrity_cases" USING btree ("company_id","reference");--> statement-breakpoint
CREATE INDEX "integrity_cases_company_idx" ON "integrity_cases" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "integrity_cases_project_idx" ON "integrity_cases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "integrity_scores_subject_idx" ON "integrity_scores" USING btree ("company_id","scope","subject_id","computed_at");--> statement-breakpoint
CREATE INDEX "integrity_scores_company_idx" ON "integrity_scores" USING btree ("company_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_policies_uq" ON "reconciliation_policies" USING btree ("company_id","project_id","assertion_kind");--> statement-breakpoint
CREATE INDEX "reconciliation_policies_project_idx" ON "reconciliation_policies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "screening_results_entity_idx" ON "screening_results" USING btree ("entity_id","screened_at");--> statement-breakpoint
CREATE INDEX "screening_results_company_idx" ON "screening_results" USING btree ("company_id","disposition");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_evidence_uq" ON "signal_evidence" USING btree ("signal_id","object_type","object_id");--> statement-breakpoint
CREATE INDEX "signal_evidence_signal_idx" ON "signal_evidence" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "signal_evidence_object_idx" ON "signal_evidence" USING btree ("company_id","object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "boq_schedule_links_uq" ON "boq_schedule_links" USING btree ("boq_item_id","task_id");--> statement-breakpoint
CREATE INDEX "boq_schedule_links_project_idx" ON "boq_schedule_links" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cvr_periods_uq" ON "cvr_periods" USING btree ("project_id","period_end");--> statement-breakpoint
CREATE INDEX "cvr_periods_company_idx" ON "cvr_periods" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "cvr_rows_period_idx" ON "cvr_rows" USING btree ("cvr_period_id");--> statement-breakpoint
CREATE INDEX "daywork_items_sheet_idx" ON "daywork_items" USING btree ("sheet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daywork_sheets_uq" ON "daywork_sheets" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "daywork_sheets_project_idx" ON "daywork_sheets" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "daywork_sheets_variation_idx" ON "daywork_sheets" USING btree ("variation_id");--> statement-breakpoint
CREATE INDEX "final_account_lines_account_idx" ON "final_account_lines" USING btree ("final_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "final_accounts_uq" ON "final_accounts" USING btree ("contract_id","number");--> statement-breakpoint
CREATE INDEX "final_accounts_project_idx" ON "final_accounts" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "fluctuation_calcs_project_idx" ON "fluctuation_calculations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "fluctuation_calcs_valuation_idx" ON "fluctuation_calculations" USING btree ("valuation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fluctuation_series_uq" ON "fluctuation_series" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "ps_expenditures_ps_idx" ON "provisional_sum_expenditures" USING btree ("provisional_sum_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provisional_sums_item_uq" ON "provisional_sums" USING btree ("boq_item_id");--> statement-breakpoint
CREATE INDEX "provisional_sums_project_idx" ON "provisional_sums" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "rate_benchmarks_company_idx" ON "rate_benchmarks" USING btree ("company_id","unit");--> statement-breakpoint
CREATE INDEX "rate_benchmarks_project_idx" ON "rate_benchmarks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "remeasurements_item_idx" ON "remeasurements" USING btree ("boq_item_id");--> statement-breakpoint
CREATE INDEX "remeasurements_project_idx" ON "remeasurements" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "retention_releases_project_idx" ON "retention_releases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "retention_releases_boq_idx" ON "retention_releases" USING btree ("boq_id");--> statement-breakpoint
CREATE INDEX "valuation_sections_valuation_idx" ON "valuation_sections" USING btree ("valuation_id");--> statement-breakpoint
CREATE INDEX "valuation_sections_project_idx" ON "valuation_sections" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "variation_build_up_variation_idx" ON "variation_build_up_lines" USING btree ("variation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accepted_programmes_uq" ON "accepted_programmes" USING btree ("contract_id","number");--> statement-breakpoint
CREATE INDEX "accepted_programmes_project_idx" ON "accepted_programmes" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ce_quotations_uq" ON "ce_quotations" USING btree ("event_id","number");--> statement-breakpoint
CREATE INDEX "ce_quotations_contract_idx" ON "ce_quotations" USING btree ("contract_id","status");--> statement-breakpoint
CREATE INDEX "ce_quotations_reply_idx" ON "ce_quotations" USING btree ("status","reply_due_date");--> statement-breakpoint
CREATE INDEX "contract_compliance_contract_idx" ON "contract_compliance_checks" USING btree ("contract_id","status");--> statement-breakpoint
CREATE INDEX "contract_compliance_project_idx" ON "contract_compliance_checks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "contract_compliance_expiry_idx" ON "contract_compliance_checks" USING btree ("status","required_until");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_obligation_links_uq" ON "contract_obligation_links" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "contract_obligation_links_contract_idx" ON "contract_obligation_links" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_obligation_links_event_idx" ON "contract_obligation_links" USING btree ("contract_event_id");--> statement-breakpoint
CREATE INDEX "schedule_calendars_project_idx" ON "schedule_calendars" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "schedule_calendars_schedule_idx" ON "schedule_calendars" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "schedule_calendars_company_idx" ON "schedule_calendars" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_constraints_uq" ON "schedule_constraints" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "schedule_constraints_schedule_idx" ON "schedule_constraints" USING btree ("schedule_id","status");--> statement-breakpoint
CREATE INDEX "schedule_constraints_need_by_idx" ON "schedule_constraints" USING btree ("status","need_by_date");--> statement-breakpoint
CREATE INDEX "schedule_constraints_task_idx" ON "schedule_constraints" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "schedule_imports_project_idx" ON "schedule_imports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "schedule_imports_schedule_idx" ON "schedule_imports" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "schedule_narratives_schedule_idx" ON "schedule_narratives" USING btree ("schedule_id","created_at");--> statement-breakpoint
CREATE INDEX "schedule_task_resources_task_idx" ON "schedule_task_resources" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "schedule_task_resources_schedule_idx" ON "schedule_task_resources" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "schedule_task_resources_project_idx" ON "schedule_task_resources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "disruption_analyses_project_idx" ON "disruption_analyses" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "disruption_analyses_claim_idx" ON "disruption_analyses" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "forensic_analyses_project_idx" ON "forensic_analyses" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "forensic_analyses_claim_idx" ON "forensic_analyses" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "forensic_analyses_method_idx" ON "forensic_analyses" USING btree ("project_id","method");--> statement-breakpoint
CREATE UNIQUE INDEX "project_float_rules_uq" ON "project_float_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "quantum_calculations_project_idx" ON "quantum_calculations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "quantum_calculations_claim_idx" ON "quantum_calculations" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_adjudications_uq" ON "payment_adjudications" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "payment_adjudications_project_idx" ON "payment_adjudications" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "payment_adjudications_claim_idx" ON "payment_adjudications" USING btree ("payment_claim_id");--> statement-breakpoint
CREATE INDEX "payment_adjudications_deadline_idx" ON "payment_adjudications" USING btree ("status","decision_due_at");--> statement-breakpoint
CREATE INDEX "payment_security_accounts_project_idx" ON "payment_security_accounts" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "payment_security_accounts_company_idx" ON "payment_security_accounts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "payment_security_movements_account_idx" ON "payment_security_movements" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "payment_security_movements_project_idx" ON "payment_security_movements" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_liens_uq" ON "statutory_liens" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "statutory_liens_project_idx" ON "statutory_liens" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "statutory_liens_deadline_idx" ON "statutory_liens" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "statutory_liens_company_idx" ON "statutory_liens" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "supply_chain_payment_reports_company_idx" ON "supply_chain_payment_reports" USING btree ("company_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_grievances_uq" ON "worker_grievances" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_grievances_tracking_uq" ON "worker_grievances" USING btree ("tracking_hash");--> statement-breakpoint
CREATE INDEX "worker_grievances_project_idx" ON "worker_grievances" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "worker_grievances_due_idx" ON "worker_grievances" USING btree ("company_id","response_due_at");--> statement-breakpoint
CREATE INDEX "worker_grievances_vendor_idx" ON "worker_grievances" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_voice_channels_token_uq" ON "worker_voice_channels" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "worker_voice_channels_project_idx" ON "worker_voice_channels" USING btree ("project_id","is_active");--> statement-breakpoint
CREATE INDEX "analytics_forecasts_project_idx" ON "analytics_forecasts" USING btree ("project_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "analytics_forecasts_company_idx" ON "analytics_forecasts" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "report_runs_company_idx" ON "report_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "report_runs_report_idx" ON "report_runs" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "report_runs_schedule_idx" ON "report_runs" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "ingestion_mapping_templates_company_idx" ON "ingestion_mapping_templates" USING btree ("company_id","dataset");--> statement-breakpoint
CREATE UNIQUE INDEX "benchmark_contributions_live_uq" ON "benchmark_contributions" USING btree ("contributor_project_id","metric","asset_class","region");--> statement-breakpoint
CREATE INDEX "benchmark_contributions_cell_idx" ON "benchmark_contributions" USING btree ("metric","asset_class","region");--> statement-breakpoint
CREATE INDEX "benchmark_forecasts_project_idx" ON "benchmark_forecasts" USING btree ("project_id","metric","created_at");--> statement-breakpoint
CREATE INDEX "benchmark_forecasts_company_idx" ON "benchmark_forecasts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_watermarks_company_uq" ON "chain_watermarks" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bond_facilities_uq" ON "bond_facilities" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "bond_facilities_company_idx" ON "bond_facilities" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "bond_facilities_review_idx" ON "bond_facilities" USING btree ("company_id","review_date");--> statement-breakpoint
CREATE INDEX "insurance_premiums_policy_idx" ON "insurance_premiums" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "insurance_premiums_company_idx" ON "insurance_premiums" USING btree ("company_id","currency");--> statement-breakpoint
CREATE INDEX "insurance_requirements_company_idx" ON "insurance_requirements" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "insurance_requirements_project_idx" ON "insurance_requirements" USING btree ("company_id","project_id","policy_type");--> statement-breakpoint
CREATE INDEX "insurance_requirements_vendor_idx" ON "insurance_requirements" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_pushes_uq" ON "lesson_pushes" USING btree ("lesson_id","project_id");--> statement-breakpoint
CREATE INDEX "lesson_pushes_project_idx" ON "lesson_pushes" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "lesson_pushes_company_idx" ON "lesson_pushes" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "integration_export_profiles_company_idx" ON "integration_export_profiles" USING btree ("company_id","feed");--> statement-breakpoint
CREATE UNIQUE INDEX "backcharges_uq" ON "backcharges" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "backcharges_commitment_idx" ON "backcharges" USING btree ("commitment_id","status");--> statement-breakpoint
CREATE INDEX "backcharges_project_idx" ON "backcharges" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "backcharges_company_idx" ON "backcharges" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_contingency_links_uq" ON "budget_contingency_links" USING btree ("budget_line_item_id","contingency_id");--> statement-breakpoint
CREATE INDEX "budget_contingency_links_budget_idx" ON "budget_contingency_links" USING btree ("budget_id");--> statement-breakpoint
CREATE INDEX "budget_contingency_links_contingency_idx" ON "budget_contingency_links" USING btree ("contingency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_postings_uq" ON "budget_postings" USING btree ("budget_line_item_id","component","source_type","source_id");--> statement-breakpoint
CREATE INDEX "budget_postings_line_idx" ON "budget_postings" USING btree ("budget_line_item_id","component");--> statement-breakpoint
CREATE INDEX "budget_postings_budget_idx" ON "budget_postings" USING btree ("budget_id","posted_at");--> statement-breakpoint
CREATE INDEX "budget_postings_project_idx" ON "budget_postings" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reconciliations_uq" ON "budget_reconciliations" USING btree ("budget_id","number");--> statement-breakpoint
CREATE INDEX "budget_reconciliations_budget_idx" ON "budget_reconciliations" USING btree ("budget_id","created_at");--> statement-breakpoint
CREATE INDEX "budget_reconciliations_project_idx" ON "budget_reconciliations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "budget_views_project_idx" ON "budget_views" USING btree ("project_id","budget_id");--> statement-breakpoint
CREATE INDEX "budget_views_company_idx" ON "budget_views" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "change_configs_uq" ON "change_configs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "change_markup_schedules_project_idx" ON "change_markup_schedules" USING btree ("project_id","prime_contract_id");--> statement-breakpoint
CREATE INDEX "change_status_history_object_idx" ON "change_status_history" USING btree ("object_id","at");--> statement-breakpoint
CREATE INDEX "change_status_history_project_idx" ON "change_status_history" USING btree ("project_id","object_type");--> statement-breakpoint
CREATE UNIQUE INDEX "commitment_closeouts_uq" ON "commitment_closeouts" USING btree ("commitment_id");--> statement-breakpoint
CREATE INDEX "commitment_closeouts_project_idx" ON "commitment_closeouts" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_sweep_state_uq" ON "compliance_sweep_state" USING btree ("commitment_id");--> statement-breakpoint
CREATE INDEX "compliance_sweep_state_project_idx" ON "compliance_sweep_state" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "contract_documents_commitment_idx" ON "contract_documents" USING btree ("commitment_id","status");--> statement-breakpoint
CREATE INDEX "contract_documents_project_idx" ON "contract_documents" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_documents_token_uq" ON "contract_documents" USING btree ("webhook_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_cost_code_maps_uq" ON "gl_cost_code_maps" USING btree ("company_id","project_id","erp_system","gl_account","gl_sub_account");--> statement-breakpoint
CREATE INDEX "gl_cost_code_maps_company_idx" ON "gl_cost_code_maps" USING btree ("company_id","erp_system");--> statement-breakpoint
CREATE INDEX "gl_cost_code_maps_project_idx" ON "gl_cost_code_maps" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_uq" ON "idempotency_keys" USING btree ("company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_approvals_uq" ON "invoice_line_approvals" USING btree ("invoice_line_item_id");--> statement-breakpoint
CREATE INDEX "invoice_line_approvals_invoice_idx" ON "invoice_line_approvals" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_payment_receipts_uq" ON "owner_payment_receipts" USING btree ("prime_contract_id","number");--> statement-breakpoint
CREATE INDEX "owner_payment_receipts_application_idx" ON "owner_payment_receipts" USING btree ("payment_application_id","status");--> statement-breakpoint
CREATE INDEX "owner_payment_receipts_project_idx" ON "owner_payment_receipts" USING btree ("project_id","received_date");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_runs_uq" ON "payment_runs" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "payment_runs_project_idx" ON "payment_runs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "prime_compliance_contract_idx" ON "prime_contract_compliance_documents" USING btree ("prime_contract_id","status");--> statement-breakpoint
CREATE INDEX "prime_compliance_expiry_idx" ON "prime_contract_compliance_documents" USING btree ("status","expiry_date");--> statement-breakpoint
CREATE INDEX "prime_compliance_project_idx" ON "prime_contract_compliance_documents" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prime_stored_materials_uq" ON "prime_stored_materials" USING btree ("prime_contract_id","number");--> statement-breakpoint
CREATE INDEX "prime_stored_materials_line_idx" ON "prime_stored_materials" USING btree ("sov_line_id","status");--> statement-breakpoint
CREATE INDEX "prime_stored_materials_project_idx" ON "prime_stored_materials" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_portal_tokens_hash_uq" ON "vendor_portal_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "vendor_portal_tokens_vendor_idx" ON "vendor_portal_tokens" USING btree ("vendor_id","project_id");--> statement-breakpoint
CREATE INDEX "spec_revision_notices_project_idx" ON "spec_revision_notices" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "spec_revision_notices_section_idx" ON "spec_revision_notices" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "spec_revision_notices_ack_idx" ON "spec_revision_notices" USING btree ("project_id","acknowledged_at");--> statement-breakpoint
CREATE INDEX "meeting_agenda_templates_company_idx" ON "meeting_agenda_templates" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "meeting_agenda_templates_type_idx" ON "meeting_agenda_templates" USING btree ("company_id","meeting_type");--> statement-breakpoint
CREATE INDEX "meeting_minute_deliveries_meeting_idx" ON "meeting_minute_deliveries" USING btree ("meeting_id","minutes_version");--> statement-breakpoint
CREATE INDEX "meeting_minute_deliveries_company_idx" ON "meeting_minute_deliveries" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_minute_deliveries_uq" ON "meeting_minute_deliveries" USING btree ("meeting_id","minutes_version","recipient_name","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_regulatory_reports_uq" ON "safety_regulatory_reports" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "safety_regulatory_reports_project_idx" ON "safety_regulatory_reports" USING btree ("project_id","form");--> statement-breakpoint
CREATE INDEX "safety_regulatory_reports_incident_idx" ON "safety_regulatory_reports" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "safety_regulatory_reports_period_idx" ON "safety_regulatory_reports" USING btree ("company_id","form","period_year");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_risk_snapshots_uq" ON "safety_risk_snapshots" USING btree ("project_id","as_of_date");--> statement-breakpoint
CREATE INDEX "safety_risk_snapshots_project_idx" ON "safety_risk_snapshots" USING btree ("project_id","computed_at");--> statement-breakpoint
CREATE INDEX "safety_risk_snapshots_company_idx" ON "safety_risk_snapshots" USING btree ("company_id","as_of_date");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_sensor_events_uq" ON "safety_sensor_events" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_sensor_events_external_uq" ON "safety_sensor_events" USING btree ("company_id","external_id");--> statement-breakpoint
CREATE INDEX "safety_sensor_events_project_idx" ON "safety_sensor_events" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "safety_sensor_events_occurred_idx" ON "safety_sensor_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "safety_sensor_events_worker_idx" ON "safety_sensor_events" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "safety_sensor_events_due_idx" ON "safety_sensor_events" USING btree ("company_id","status","acknowledge_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calibrated_instruments_uq" ON "calibrated_instruments" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "calibrated_instruments_serial_uq" ON "calibrated_instruments" USING btree ("project_id","serial_number");--> statement-breakpoint
CREATE INDEX "calibrated_instruments_project_idx" ON "calibrated_instruments" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "calibrated_instruments_due_idx" ON "calibrated_instruments" USING btree ("project_id","calibration_due_date");--> statement-breakpoint
CREATE INDEX "calibration_records_instrument_idx" ON "calibration_records" USING btree ("instrument_id","calibrated_at");--> statement-breakpoint
CREATE INDEX "calibration_records_project_idx" ON "calibration_records" USING btree ("project_id","result");--> statement-breakpoint
CREATE UNIQUE INDEX "concrete_pours_uq" ON "concrete_pours" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "concrete_pours_project_idx" ON "concrete_pours" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "concrete_pours_date_idx" ON "concrete_pours" USING btree ("project_id","planned_date");--> statement-breakpoint
CREATE INDEX "concrete_pours_supplier_idx" ON "concrete_pours" USING btree ("supplier_vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "concrete_test_specimens_uq" ON "concrete_test_specimens" USING btree ("pour_id","specimen_ref");--> statement-breakpoint
CREATE INDEX "concrete_test_specimens_pour_idx" ON "concrete_test_specimens" USING btree ("pour_id","test_age_days");--> statement-breakpoint
CREATE INDEX "concrete_test_specimens_project_idx" ON "concrete_test_specimens" USING btree ("project_id","result");--> statement-breakpoint
CREATE UNIQUE INDEX "defects_liability_periods_uq" ON "defects_liability_periods" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "defects_liability_periods_project_idx" ON "defects_liability_periods" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "defects_liability_periods_end_idx" ON "defects_liability_periods" USING btree ("project_id","end_date");--> statement-breakpoint
CREATE INDEX "defects_liability_periods_package_idx" ON "defects_liability_periods" USING btree ("turnover_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dlp_defects_uq" ON "dlp_defects" USING btree ("dlp_id","reference");--> statement-breakpoint
CREATE INDEX "dlp_defects_dlp_idx" ON "dlp_defects" USING btree ("dlp_id","status");--> statement-breakpoint
CREATE INDEX "dlp_defects_project_idx" ON "dlp_defects" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "itp_activity_releases_activity_idx" ON "itp_activity_releases" USING btree ("activity_id","position");--> statement-breakpoint
CREATE INDEX "itp_activity_releases_project_idx" ON "itp_activity_releases" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "itp_activity_releases_user_idx" ON "itp_activity_releases" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "material_test_certificates_uq" ON "material_test_certificates" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "material_test_certificates_project_idx" ON "material_test_certificates" USING btree ("project_id","verification_status");--> statement-breakpoint
CREATE INDEX "material_test_certificates_heat_idx" ON "material_test_certificates" USING btree ("company_id","heat_number");--> statement-breakpoint
CREATE INDEX "material_test_certificates_batch_idx" ON "material_test_certificates" USING btree ("company_id","batch_number");--> statement-breakpoint
CREATE INDEX "material_test_certificates_supplier_idx" ON "material_test_certificates" USING btree ("supplier_vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ndt_records_uq" ON "ndt_records" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "ndt_records_weld_idx" ON "ndt_records" USING btree ("weld_id","method");--> statement-breakpoint
CREATE INDEX "ndt_records_project_idx" ON "ndt_records" USING btree ("project_id","result");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_training_records_uq" ON "operator_training_records" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "operator_training_records_project_idx" ON "operator_training_records" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "operator_training_records_system_idx" ON "operator_training_records" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "operator_training_records_package_idx" ON "operator_training_records" USING btree ("turnover_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "performance_guarantees_uq" ON "performance_guarantees" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "performance_guarantees_project_idx" ON "performance_guarantees" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "performance_guarantees_system_idx" ON "performance_guarantees" USING btree ("system_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_occupancy_evaluations_uq" ON "post_occupancy_evaluations" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "post_occupancy_evaluations_project_idx" ON "post_occupancy_evaluations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "post_occupancy_evaluations_package_idx" ON "post_occupancy_evaluations" USING btree ("turnover_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_audit_findings_uq" ON "quality_audit_findings" USING btree ("audit_id","reference");--> statement-breakpoint
CREATE INDEX "quality_audit_findings_audit_idx" ON "quality_audit_findings" USING btree ("audit_id","position");--> statement-breakpoint
CREATE INDEX "quality_audit_findings_project_idx" ON "quality_audit_findings" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "quality_audit_findings_due_idx" ON "quality_audit_findings" USING btree ("project_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_audits_uq" ON "quality_audits" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "quality_audits_project_idx" ON "quality_audits" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "quality_audits_vendor_idx" ON "quality_audits" USING btree ("audited_vendor_id");--> statement-breakpoint
CREATE INDEX "quality_audits_date_idx" ON "quality_audits" USING btree ("project_id","planned_date");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_concessions_uq" ON "quality_concessions" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "quality_concessions_project_idx" ON "quality_concessions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "quality_concessions_ncr_idx" ON "quality_concessions" USING btree ("ncr_id");--> statement-breakpoint
CREATE INDEX "quality_concessions_expiry_idx" ON "quality_concessions" USING btree ("project_id","expiry_date");--> statement-breakpoint
CREATE INDEX "quality_concessions_vendor_idx" ON "quality_concessions" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rework_items_uq" ON "rework_items" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "rework_items_project_idx" ON "rework_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "rework_items_cause_idx" ON "rework_items" USING btree ("project_id","cause_category");--> statement-breakpoint
CREATE INDEX "rework_items_vendor_idx" ON "rework_items" USING btree ("responsible_vendor_id","status");--> statement-breakpoint
CREATE INDEX "rework_items_trade_idx" ON "rework_items" USING btree ("project_id","trade");--> statement-breakpoint
CREATE UNIQUE INDEX "spare_parts_uq" ON "spare_parts" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "spare_parts_project_idx" ON "spare_parts" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "spare_parts_system_idx" ON "spare_parts" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "spare_parts_package_idx" ON "spare_parts" USING btree ("turnover_package_id");--> statement-breakpoint
CREATE INDEX "welder_qualifications_project_idx" ON "welder_qualifications" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "welder_qualifications_expiry_idx" ON "welder_qualifications" USING btree ("project_id","expiry_date");--> statement-breakpoint
CREATE INDEX "welder_qualifications_stamp_idx" ON "welder_qualifications" USING btree ("project_id","welder_stamp");--> statement-breakpoint
CREATE INDEX "welder_qualifications_vendor_idx" ON "welder_qualifications" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "welding_procedures_uq" ON "welding_procedures" USING btree ("project_id","wps_number");--> statement-breakpoint
CREATE INDEX "welding_procedures_project_idx" ON "welding_procedures" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "welding_procedures_vendor_idx" ON "welding_procedures" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "welds_uq" ON "welds" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "welds_project_idx" ON "welds" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "welds_welder_idx" ON "welds" USING btree ("project_id","welder_qualification_id");--> statement-breakpoint
CREATE INDEX "welds_wps_idx" ON "welds" USING btree ("wps_id");--> statement-breakpoint
CREATE INDEX "welds_system_idx" ON "welds" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "award_delegations_company_idx" ON "award_delegations" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE INDEX "award_delegations_subject_idx" ON "award_delegations" USING btree ("company_id","subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bid_bonds_uq" ON "bid_bonds" USING btree ("package_id","vendor_id","bond_type");--> statement-breakpoint
CREATE INDEX "bid_bonds_package_idx" ON "bid_bonds" USING btree ("package_id","status");--> statement-breakpoint
CREATE INDEX "bid_bonds_expiry_idx" ON "bid_bonds" USING btree ("company_id","expires_at");--> statement-breakpoint
CREATE INDEX "bid_bonds_vendor_idx" ON "bid_bonds" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "bid_document_access_package_idx" ON "bid_document_access" USING btree ("package_id","accessed_at");--> statement-breakpoint
CREATE INDEX "bid_document_access_invitation_idx" ON "bid_document_access" USING btree ("invitation_id","accessed_at");--> statement-breakpoint
CREATE INDEX "bid_document_access_file_idx" ON "bid_document_access" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bid_meeting_attendees_uq" ON "bid_meeting_attendees" USING btree ("meeting_id","vendor_id","attendee_name");--> statement-breakpoint
CREATE INDEX "bid_meeting_attendees_meeting_idx" ON "bid_meeting_attendees" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "bid_meeting_attendees_vendor_idx" ON "bid_meeting_attendees" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "bid_meetings_package_idx" ON "bid_meetings" USING btree ("package_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "bid_meetings_project_idx" ON "bid_meetings" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bid_opportunities_uq" ON "bid_opportunities" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "bid_opportunities_stage_idx" ON "bid_opportunities" USING btree ("company_id","stage");--> statement-breakpoint
CREATE INDEX "bid_opportunities_due_idx" ON "bid_opportunities" USING btree ("company_id","submission_due_at");--> statement-breakpoint
CREATE INDEX "bid_opportunities_client_idx" ON "bid_opportunities" USING btree ("company_id","client_vendor_id");--> statement-breakpoint
CREATE INDEX "bid_opportunities_trade_idx" ON "bid_opportunities" USING btree ("company_id","trade_code");--> statement-breakpoint
CREATE UNIQUE INDEX "bid_questions_uq" ON "bid_questions" USING btree ("package_id","number");--> statement-breakpoint
CREATE INDEX "bid_questions_package_idx" ON "bid_questions" USING btree ("package_id","status");--> statement-breakpoint
CREATE INDEX "bid_questions_vendor_idx" ON "bid_questions" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "bid_questions_project_idx" ON "bid_questions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "prequal_licences_vendor_idx" ON "prequalification_licences" USING btree ("company_id","vendor_id","status");--> statement-breakpoint
CREATE INDEX "prequal_licences_expiry_idx" ON "prequalification_licences" USING btree ("company_id","expires_at");--> statement-breakpoint
CREATE INDEX "prequal_licences_submission_idx" ON "prequalification_licences" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "prequal_references_vendor_idx" ON "prequalification_references" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE INDEX "prequal_references_submission_idx" ON "prequalification_references" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prequal_safety_uq" ON "prequalification_safety_records" USING btree ("company_id","vendor_id","year","source");--> statement-breakpoint
CREATE INDEX "prequal_safety_vendor_idx" ON "prequalification_safety_records" USING btree ("company_id","vendor_id","year");--> statement-breakpoint
CREATE INDEX "prequal_safety_submission_idx" ON "prequalification_safety_records" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "tender_costs_opportunity_idx" ON "tender_costs" USING btree ("opportunity_id","incurred_on");--> statement-breakpoint
CREATE INDEX "tender_costs_package_idx" ON "tender_costs" USING btree ("package_id","incurred_on");--> statement-breakpoint
CREATE INDEX "tender_costs_company_idx" ON "tender_costs" USING btree ("company_id","incurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "company_security_policies_company_uq" ON "company_security_policies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mfa_challenges_user_idx" ON "mfa_challenges" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "mfa_challenges_expires_idx" ON "mfa_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "password_history_user_idx" ON "password_history" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_tokens_hash_uq" ON "scim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "scim_tokens_company_idx" ON "scim_tokens" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "security_webhook_deliveries_company_idx" ON "security_webhook_deliveries" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "security_webhook_deliveries_webhook_idx" ON "security_webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "security_webhook_deliveries_pending_idx" ON "security_webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "security_webhooks_company_idx" ON "security_webhooks" USING btree ("company_id","is_enabled");--> statement-breakpoint
CREATE INDEX "sso_flows_expires_idx" ON "sso_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sso_tickets_expires_idx" ON "sso_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attention_items_source_uq" ON "attention_items" USING btree ("company_id","source_type","source_id","kind");--> statement-breakpoint
CREATE INDEX "attention_items_company_idx" ON "attention_items" USING btree ("company_id","status","score");--> statement-breakpoint
CREATE INDEX "attention_items_project_idx" ON "attention_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "attention_items_due_idx" ON "attention_items" USING btree ("company_id","due_at");--> statement-breakpoint
CREATE INDEX "project_health_snapshots_project_idx" ON "project_health_snapshots" USING btree ("project_id","computed_at");--> statement-breakpoint
CREATE INDEX "project_health_snapshots_company_idx" ON "project_health_snapshots" USING btree ("company_id","computed_at");--> statement-breakpoint
CREATE INDEX "pulse_briefings_company_idx" ON "pulse_briefings" USING btree ("company_id","generated_at");--> statement-breakpoint
CREATE INDEX "pulse_briefings_project_idx" ON "pulse_briefings" USING btree ("project_id","generated_at");--> statement-breakpoint
CREATE INDEX "pulse_snapshots_company_idx" ON "pulse_snapshots" USING btree ("company_id","generated_at");--> statement-breakpoint
CREATE INDEX "automation_rules_company_idx" ON "automation_rules" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "automation_rules_trigger_idx" ON "automation_rules" USING btree ("company_id","status","trigger_kind","trigger_object_type","trigger_action");--> statement-breakpoint
CREATE INDEX "automation_rules_project_idx" ON "automation_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "automation_runs_company_idx" ON "automation_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_status_idx" ON "automation_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "automation_runs_rule_idx" ON "automation_runs" USING btree ("rule_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_object_idx" ON "automation_runs" USING btree ("rule_id","object_type","object_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_project_idx" ON "automation_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pe_exposures_project_idx" ON "pe_exposures" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "pe_exposures_company_idx" ON "pe_exposures" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "pe_exposures_entity_idx" ON "pe_exposures" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "pe_presence_entries_exposure_idx" ON "pe_presence_entries" USING btree ("exposure_id","start_date");--> statement-breakpoint
CREATE INDEX "pe_presence_entries_project_idx" ON "pe_presence_entries" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_determinations_uq" ON "tax_determinations" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "tax_determinations_project_idx" ON "tax_determinations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tax_determinations_source_idx" ON "tax_determinations" USING btree ("source_type","source_id","source_line_id");--> statement-breakpoint
CREATE INDEX "tax_determinations_vendor_idx" ON "tax_determinations" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "tax_determinations_company_idx" ON "tax_determinations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tax_determinations_tax_point_idx" ON "tax_determinations" USING btree ("project_id","tax_point_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_periods_uq" ON "tax_periods" USING btree ("project_id","regime","return_kind","period_start");--> statement-breakpoint
CREATE INDEX "tax_periods_project_idx" ON "tax_periods" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tax_periods_due_idx" ON "tax_periods" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "tax_periods_company_idx" ON "tax_periods" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_project_profiles_uq" ON "tax_project_profiles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tax_project_profiles_company_idx" ON "tax_project_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tax_registrations_holder_idx" ON "tax_registrations" USING btree ("company_id","holder_type","holder_id");--> statement-breakpoint
CREATE INDEX "tax_registrations_regime_idx" ON "tax_registrations" USING btree ("company_id","regime","kind","status");--> statement-breakpoint
CREATE INDEX "tax_registrations_verified_idx" ON "tax_registrations" USING btree ("verification_status","verified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "withholding_certificates_uq" ON "withholding_certificates" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "withholding_certificates_project_idx" ON "withholding_certificates" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "withholding_certificates_vendor_idx" ON "withholding_certificates" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "withholding_certificates_payment_idx" ON "withholding_certificates" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "withholding_certificates_period_idx" ON "withholding_certificates" USING btree ("company_id","payment_date");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_slots_uq" ON "delivery_slots" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "delivery_slots_gate_idx" ON "delivery_slots" USING btree ("gate_id","starts_at");--> statement-breakpoint
CREATE INDEX "delivery_slots_project_idx" ON "delivery_slots" USING btree ("project_id","status","starts_at");--> statement-breakpoint
CREATE INDEX "delivery_slots_company_status_idx" ON "delivery_slots" USING btree ("company_id","status","ends_at");--> statement-breakpoint
CREATE INDEX "delivery_slots_task_idx" ON "delivery_slots" USING btree ("schedule_task_id");--> statement-breakpoint
CREATE INDEX "delivery_slots_item_idx" ON "delivery_slots" USING btree ("long_lead_item_id");--> statement-breakpoint
CREATE INDEX "factory_inspections_project_idx" ON "factory_inspections" USING btree ("project_id","result");--> statement-breakpoint
CREATE INDEX "factory_inspections_unit_idx" ON "factory_inspections" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "long_lead_expediting_item_idx" ON "long_lead_expediting_log" USING btree ("item_id","logged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "long_lead_items_uq" ON "long_lead_items" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "long_lead_items_project_idx" ON "long_lead_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "long_lead_items_risk_idx" ON "long_lead_items" USING btree ("project_id","risk_level");--> statement-breakpoint
CREATE INDEX "long_lead_items_task_idx" ON "long_lead_items" USING btree ("schedule_task_id");--> statement-breakpoint
CREATE INDEX "long_lead_items_order_by_idx" ON "long_lead_items" USING btree ("company_id","order_by_date");--> statement-breakpoint
CREATE UNIQUE INDEX "material_trace_records_uq" ON "material_trace_records" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "material_trace_project_idx" ON "material_trace_records" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "material_trace_company_idx" ON "material_trace_records" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "material_trace_heat_idx" ON "material_trace_records" USING btree ("company_id","heat_number");--> statement-breakpoint
CREATE INDEX "material_trace_batch_idx" ON "material_trace_records" USING btree ("company_id","batch_number");--> statement-breakpoint
CREATE INDEX "material_trace_location_idx" ON "material_trace_records" USING btree ("installed_location_id");--> statement-breakpoint
CREATE INDEX "material_trace_item_idx" ON "material_trace_records" USING btree ("material_item_id");--> statement-breakpoint
CREATE INDEX "offsite_stages_unit_idx" ON "offsite_production_stages" USING btree ("unit_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "offsite_units_uq" ON "offsite_units" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "offsite_units_project_idx" ON "offsite_units" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "offsite_units_company_idx" ON "offsite_units" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "offsite_units_factory_idx" ON "offsite_units" USING btree ("factory_node_id");--> statement-breakpoint
CREATE INDEX "offsite_units_task_idx" ON "offsite_units" USING btree ("schedule_task_id");--> statement-breakpoint
CREATE INDEX "site_gates_project_idx" ON "site_gates" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "supplier_risk_node_idx" ON "supplier_risk_assessments" USING btree ("node_id","assessed_at");--> statement-breakpoint
CREATE INDEX "supplier_risk_project_idx" ON "supplier_risk_assessments" USING btree ("project_id","assessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_chain_links_uq" ON "supply_chain_links" USING btree ("from_node_id","to_node_id","kind");--> statement-breakpoint
CREATE INDEX "supply_chain_links_project_idx" ON "supply_chain_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "supply_chain_links_to_idx" ON "supply_chain_links" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "supply_chain_nodes_project_idx" ON "supply_chain_nodes" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "supply_chain_nodes_company_idx" ON "supply_chain_nodes" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "supply_chain_nodes_vendor_idx" ON "supply_chain_nodes" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "supply_chain_nodes_tier_idx" ON "supply_chain_nodes" USING btree ("project_id","tier");--> statement-breakpoint
CREATE INDEX "design_change_impacts_dcn_idx" ON "design_change_impacts" USING btree ("change_notice_id");--> statement-breakpoint
CREATE INDEX "design_change_impacts_project_idx" ON "design_change_impacts" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_change_notices_uq" ON "design_change_notices" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "design_change_notices_project_idx" ON "design_change_notices" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_change_notices_package_idx" ON "design_change_notices" USING btree ("package_id","status");--> statement-breakpoint
CREATE INDEX "design_change_notices_class_idx" ON "design_change_notices" USING btree ("project_id","classification");--> statement-breakpoint
CREATE INDEX "design_change_notices_company_idx" ON "design_change_notices" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "design_comments_review_idx" ON "design_comments" USING btree ("review_id","status");--> statement-breakpoint
CREATE INDEX "design_comments_package_idx" ON "design_comments" USING btree ("package_id","status");--> statement-breakpoint
CREATE INDEX "design_comments_project_idx" ON "design_comments" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_consultants_project_idx" ON "design_consultants" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_consultants_vendor_idx" ON "design_consultants" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "design_consultants_company_idx" ON "design_consultants" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_decisions_uq" ON "design_decisions" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "design_decisions_project_idx" ON "design_decisions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_decisions_package_idx" ON "design_decisions" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "design_decisions_company_idx" ON "design_decisions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_deliverables_uq" ON "design_deliverables" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "design_deliverables_project_idx" ON "design_deliverables" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_deliverables_planned_idx" ON "design_deliverables" USING btree ("project_id","planned_issue_date");--> statement-breakpoint
CREATE INDEX "design_deliverables_slippage_idx" ON "design_deliverables" USING btree ("project_id","slippage_level");--> statement-breakpoint
CREATE INDEX "design_deliverables_package_idx" ON "design_deliverables" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "design_deliverables_consultant_idx" ON "design_deliverables" USING btree ("consultant_id");--> statement-breakpoint
CREATE INDEX "design_deliverables_company_idx" ON "design_deliverables" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "design_freezes_project_idx" ON "design_freezes" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_freezes_package_idx" ON "design_freezes" USING btree ("package_id","status");--> statement-breakpoint
CREATE INDEX "design_freezes_company_idx" ON "design_freezes" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_info_requirements_uq" ON "design_info_requirements" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "design_info_requirements_project_idx" ON "design_info_requirements" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_info_requirements_due_idx" ON "design_info_requirements" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "design_info_requirements_company_idx" ON "design_info_requirements" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_issues_uq" ON "design_issues" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "design_issues_project_idx" ON "design_issues" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_issues_discipline_idx" ON "design_issues" USING btree ("project_id","discipline","status");--> statement-breakpoint
CREATE INDEX "design_issues_assignee_idx" ON "design_issues" USING btree ("assigned_to_user_id","status");--> statement-breakpoint
CREATE INDEX "design_issues_due_idx" ON "design_issues" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "design_issues_package_idx" ON "design_issues" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "design_issues_company_idx" ON "design_issues" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_packages_uq" ON "design_packages" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "design_packages_project_idx" ON "design_packages" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_packages_stage_idx" ON "design_packages" USING btree ("project_id","stage_key");--> statement-breakpoint
CREATE INDEX "design_packages_discipline_idx" ON "design_packages" USING btree ("project_id","discipline");--> statement-breakpoint
CREATE INDEX "design_packages_company_idx" ON "design_packages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "design_readiness_project_idx" ON "design_readiness_snapshots" USING btree ("project_id","computed_at");--> statement-breakpoint
CREATE INDEX "design_readiness_package_idx" ON "design_readiness_snapshots" USING btree ("package_id","computed_at");--> statement-breakpoint
CREATE INDEX "design_readiness_company_idx" ON "design_readiness_snapshots" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "design_review_participants_review_idx" ON "design_review_participants" USING btree ("review_id","status");--> statement-breakpoint
CREATE INDEX "design_review_participants_user_idx" ON "design_review_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "design_review_participants_project_idx" ON "design_review_participants" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_reviews_uq" ON "design_reviews" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "design_reviews_package_idx" ON "design_reviews" USING btree ("package_id","status");--> statement-breakpoint
CREATE INDEX "design_reviews_project_idx" ON "design_reviews" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_reviews_due_idx" ON "design_reviews" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "design_reviews_company_idx" ON "design_reviews" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_stage_gates_uq" ON "design_stage_gates" USING btree ("project_id","stage_key");--> statement-breakpoint
CREATE INDEX "design_stage_gates_project_idx" ON "design_stage_gates" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_stage_gates_company_idx" ON "design_stage_gates" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_assemblies_uq" ON "cost_assemblies" USING btree ("company_id","project_id","code");--> statement-breakpoint
CREATE INDEX "cost_assemblies_company_idx" ON "cost_assemblies" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "cost_assembly_components_assembly_idx" ON "cost_assembly_components" USING btree ("assembly_id","position");--> statement-breakpoint
CREATE INDEX "cost_assembly_components_catalogue_idx" ON "cost_assembly_components" USING btree ("catalogue_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_catalogue_items_uq" ON "cost_catalogue_items" USING btree ("company_id","project_id","code");--> statement-breakpoint
CREATE INDEX "cost_catalogue_items_company_idx" ON "cost_catalogue_items" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "cost_catalogue_items_project_idx" ON "cost_catalogue_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "cost_catalogue_items_costtype_idx" ON "cost_catalogue_items" USING btree ("company_id","cost_type");--> statement-breakpoint
CREATE INDEX "cost_catalogue_items_stale_idx" ON "cost_catalogue_items" USING btree ("company_id","rate_as_at");--> statement-breakpoint
CREATE INDEX "estimate_line_items_estimate_idx" ON "estimate_line_items" USING btree ("estimate_id","position");--> statement-breakpoint
CREATE INDEX "estimate_line_items_section_idx" ON "estimate_line_items" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "estimate_line_items_project_idx" ON "estimate_line_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "estimate_line_items_lineage_idx" ON "estimate_line_items" USING btree ("estimate_id","lineage_id");--> statement-breakpoint
CREATE INDEX "estimate_line_items_costcode_idx" ON "estimate_line_items" USING btree ("estimate_id","cost_code","cost_type");--> statement-breakpoint
CREATE INDEX "estimate_line_items_takeoff_idx" ON "estimate_line_items" USING btree ("takeoff_item_id");--> statement-breakpoint
CREATE INDEX "estimate_line_items_catalogue_idx" ON "estimate_line_items" USING btree ("catalogue_item_id");--> statement-breakpoint
CREATE INDEX "estimate_line_items_history_idx" ON "estimate_line_items" USING btree ("company_id","cost_code");--> statement-breakpoint
CREATE INDEX "estimate_line_items_stale_idx" ON "estimate_line_items" USING btree ("company_id","rate_as_at");--> statement-breakpoint
CREATE INDEX "estimate_markups_estimate_idx" ON "estimate_markups" USING btree ("estimate_id","sequence");--> statement-breakpoint
CREATE INDEX "estimate_markups_project_idx" ON "estimate_markups" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "estimate_proposals_uq" ON "estimate_proposals" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "estimate_proposals_estimate_idx" ON "estimate_proposals" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX "estimate_proposals_project_idx" ON "estimate_proposals" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "estimate_sections_estimate_idx" ON "estimate_sections" USING btree ("estimate_id","sort_order");--> statement-breakpoint
CREATE INDEX "estimate_sections_project_idx" ON "estimate_sections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "estimate_sub_quote_lines_quote_idx" ON "estimate_sub_quote_lines" USING btree ("sub_quote_id","position");--> statement-breakpoint
CREATE INDEX "estimate_sub_quote_lines_project_idx" ON "estimate_sub_quote_lines" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "estimate_sub_quote_lines_scope_idx" ON "estimate_sub_quote_lines" USING btree ("project_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "estimate_sub_quotes_uq" ON "estimate_sub_quotes" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "estimate_sub_quotes_project_idx" ON "estimate_sub_quotes" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "estimate_sub_quotes_estimate_idx" ON "estimate_sub_quotes" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX "estimate_sub_quotes_package_idx" ON "estimate_sub_quotes" USING btree ("project_id","trade_package");--> statement-breakpoint
CREATE INDEX "estimate_sub_quotes_validity_idx" ON "estimate_sub_quotes" USING btree ("company_id","valid_until");--> statement-breakpoint
CREATE INDEX "estimate_sub_quotes_source_idx" ON "estimate_sub_quotes" USING btree ("company_id","source","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_uq" ON "estimates" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "estimates_project_idx" ON "estimates" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "estimates_company_idx" ON "estimates" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "estimates_root_idx" ON "estimates" USING btree ("root_id","version");--> statement-breakpoint
CREATE INDEX "estimates_source_idx" ON "estimates" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "estimating_crews_uq" ON "estimating_crews" USING btree ("company_id","project_id","code");--> statement-breakpoint
CREATE INDEX "estimating_crews_company_idx" ON "estimating_crews" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "estimating_production_rates_uq" ON "estimating_production_rates" USING btree ("company_id","project_id","code");--> statement-breakpoint
CREATE INDEX "estimating_production_rates_company_idx" ON "estimating_production_rates" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "estimating_production_rates_crew_idx" ON "estimating_production_rates" USING btree ("crew_id");--> statement-breakpoint
CREATE INDEX "estimate_takeoff_items_project_idx" ON "estimate_takeoff_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "estimate_takeoff_items_estimate_idx" ON "estimate_takeoff_items" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX "estimate_takeoff_items_layer_idx" ON "estimate_takeoff_items" USING btree ("layer_id");--> statement-breakpoint
CREATE INDEX "estimate_takeoff_items_sheet_idx" ON "estimate_takeoff_items" USING btree ("sheet_id","page_number");--> statement-breakpoint
CREATE INDEX "estimate_takeoff_items_costcode_idx" ON "estimate_takeoff_items" USING btree ("project_id","cost_code");--> statement-breakpoint
CREATE INDEX "estimate_takeoff_layers_project_idx" ON "estimate_takeoff_layers" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "estimate_takeoff_layers_company_idx" ON "estimate_takeoff_layers" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_plan_activities_seq_uq" ON "action_plan_activities" USING btree ("plan_id","seq");--> statement-breakpoint
CREATE INDEX "action_plan_activities_plan_idx" ON "action_plan_activities" USING btree ("plan_id","status");--> statement-breakpoint
CREATE INDEX "action_plan_activities_project_idx" ON "action_plan_activities" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "action_plan_activities_due_idx" ON "action_plan_activities" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "action_plan_activities_assignee_idx" ON "action_plan_activities" USING btree ("assignee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_plan_signoffs_seq_uq" ON "action_plan_signoffs" USING btree ("activity_id","seq");--> statement-breakpoint
CREATE INDEX "action_plan_signoffs_activity_idx" ON "action_plan_signoffs" USING btree ("activity_id","status");--> statement-breakpoint
CREATE INDEX "action_plan_signoffs_plan_idx" ON "action_plan_signoffs" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "action_plan_signoffs_company_idx" ON "action_plan_signoffs" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_plan_template_activities_seq_uq" ON "action_plan_template_activities" USING btree ("template_id","seq");--> statement-breakpoint
CREATE INDEX "action_plan_template_activities_company_idx" ON "action_plan_template_activities" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_plan_templates_key_uq" ON "action_plan_templates" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "action_plan_templates_company_idx" ON "action_plan_templates" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "action_plans_ref_uq" ON "action_plans" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "action_plans_project_idx" ON "action_plans" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "action_plans_company_idx" ON "action_plans" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "action_plans_due_idx" ON "action_plans" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "action_plans_location_idx" ON "action_plans" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "action_plans_task_idx" ON "action_plans" USING btree ("schedule_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_approvals_seq_uq" ON "correspondence_approvals" USING btree ("letter_id","seq");--> statement-breakpoint
CREATE INDEX "correspondence_approvals_letter_idx" ON "correspondence_approvals" USING btree ("letter_id","status");--> statement-breakpoint
CREATE INDEX "correspondence_approvals_company_idx" ON "correspondence_approvals" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_inbound_msgid_uq" ON "correspondence_inbound_messages" USING btree ("project_id","message_id");--> statement-breakpoint
CREATE INDEX "correspondence_inbound_project_idx" ON "correspondence_inbound_messages" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "correspondence_inbound_company_idx" ON "correspondence_inbound_messages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "correspondence_inbound_received_idx" ON "correspondence_inbound_messages" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_letters_ref_uq" ON "correspondence_letters" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "correspondence_letters_project_idx" ON "correspondence_letters" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "correspondence_letters_company_idx" ON "correspondence_letters" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "correspondence_letters_due_idx" ON "correspondence_letters" USING btree ("status","response_due_date");--> statement-breakpoint
CREATE INDEX "correspondence_letters_thread_idx" ON "correspondence_letters" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "correspondence_letters_type_idx" ON "correspondence_letters" USING btree ("project_id","type_id");--> statement-breakpoint
CREATE INDEX "correspondence_recipients_record_idx" ON "correspondence_recipients" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "correspondence_recipients_project_idx" ON "correspondence_recipients" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "correspondence_recipients_company_idx" ON "correspondence_recipients" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "correspondence_recipients_email_idx" ON "correspondence_recipients" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_types_key_uq" ON "correspondence_types" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "correspondence_types_company_idx" ON "correspondence_types" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE INDEX "correspondence_types_project_idx" ON "correspondence_types" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "form_assignments_project_idx" ON "form_assignments" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "form_assignments_template_idx" ON "form_assignments" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "form_assignments_due_idx" ON "form_assignments" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "form_assignments_assignee_idx" ON "form_assignments" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX "form_assignments_company_idx" ON "form_assignments" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_responses_ref_uq" ON "form_responses" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "form_responses_project_idx" ON "form_responses" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "form_responses_template_idx" ON "form_responses" USING btree ("template_id","status");--> statement-breakpoint
CREATE INDEX "form_responses_assignment_idx" ON "form_responses" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "form_responses_company_idx" ON "form_responses" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_templates_key_uq" ON "form_templates" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "form_templates_company_idx" ON "form_templates" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "form_templates_project_idx" ON "form_templates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "transmittal_items_parent_idx" ON "transmittal_items" USING btree ("transmittal_id","seq");--> statement-breakpoint
CREATE INDEX "transmittal_items_project_idx" ON "transmittal_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "transmittal_items_item_idx" ON "transmittal_items" USING btree ("item_type","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transmittals_ref_uq" ON "transmittals" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "transmittals_project_idx" ON "transmittals" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "transmittals_company_idx" ON "transmittals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "transmittals_ack_due_idx" ON "transmittals" USING btree ("status","ack_due_date");--> statement-breakpoint
CREATE INDEX "audit_rights_executions_company_idx" ON "audit_rights_executions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "audit_rights_executions_project_idx" ON "audit_rights_executions" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "audit_rights_executions_subject_idx" ON "audit_rights_executions" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "call_off_orders_uq" ON "call_off_orders" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "call_off_orders_project_idx" ON "call_off_orders" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "call_off_orders_framework_idx" ON "call_off_orders" USING btree ("company_id","framework_id");--> statement-breakpoint
CREATE INDEX "call_off_orders_lot_idx" ON "call_off_orders" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "call_off_orders_term_idx" ON "call_off_orders" USING btree ("company_id","term_contract_id");--> statement-breakpoint
CREATE INDEX "call_off_orders_vendor_idx" ON "call_off_orders" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE INDEX "defined_cost_items_verification_idx" ON "defined_cost_items" USING btree ("company_id","verification_id","verdict");--> statement-breakpoint
CREATE INDEX "defined_cost_items_project_idx" ON "defined_cost_items" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "defined_cost_items_component_idx" ON "defined_cost_items" USING btree ("company_id","verification_id","component");--> statement-breakpoint
CREATE UNIQUE INDEX "disallowed_costs_uq" ON "disallowed_costs" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "disallowed_costs_project_idx" ON "disallowed_costs" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "disallowed_costs_verification_idx" ON "disallowed_costs" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "disallowed_costs_response_idx" ON "disallowed_costs" USING btree ("company_id","status","response_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "framework_agreements_uq" ON "framework_agreements" USING btree ("company_id","reference");--> statement-breakpoint
CREATE INDEX "framework_agreements_company_idx" ON "framework_agreements" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "framework_agreements_end_idx" ON "framework_agreements" USING btree ("company_id","status","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "framework_lots_uq" ON "framework_lots" USING btree ("framework_id","lot_number");--> statement-breakpoint
CREATE INDEX "framework_lots_company_idx" ON "framework_lots" USING btree ("company_id","framework_id");--> statement-breakpoint
CREATE UNIQUE INDEX "framework_mini_competitions_uq" ON "framework_mini_competitions" USING btree ("company_id","reference");--> statement-breakpoint
CREATE INDEX "framework_mini_competitions_framework_idx" ON "framework_mini_competitions" USING btree ("company_id","framework_id","status");--> statement-breakpoint
CREATE INDEX "framework_mini_competitions_project_idx" ON "framework_mini_competitions" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "framework_mini_competitions_due_idx" ON "framework_mini_competitions" USING btree ("company_id","status","responses_due_at");--> statement-breakpoint
CREATE INDEX "framework_suppliers_framework_idx" ON "framework_suppliers" USING btree ("company_id","framework_id","status");--> statement-breakpoint
CREATE INDEX "framework_suppliers_lot_idx" ON "framework_suppliers" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "framework_suppliers_vendor_idx" ON "framework_suppliers" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE INDEX "joint_ventures_company_idx" ON "joint_ventures" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "joint_ventures_project_idx" ON "joint_ventures" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "jv_decisions_jv_idx" ON "jv_decisions" USING btree ("company_id","jv_id","meeting_date");--> statement-breakpoint
CREATE INDEX "jv_decisions_outcome_idx" ON "jv_decisions" USING btree ("company_id","outcome");--> statement-breakpoint
CREATE INDEX "jv_partners_jv_idx" ON "jv_partners" USING btree ("company_id","jv_id");--> statement-breakpoint
CREATE INDEX "jv_partners_entity_idx" ON "jv_partners" USING btree ("company_id","entity_id");--> statement-breakpoint
CREATE INDEX "jv_transactions_jv_idx" ON "jv_transactions" USING btree ("company_id","jv_id","status");--> statement-breakpoint
CREATE INDEX "jv_transactions_partner_idx" ON "jv_transactions" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "jv_transactions_due_idx" ON "jv_transactions" USING btree ("company_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "open_book_verifications_uq" ON "open_book_verifications" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "open_book_verifications_project_idx" ON "open_book_verifications" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "open_book_verifications_planned_idx" ON "open_book_verifications" USING btree ("company_id","status","planned_at");--> statement-breakpoint
CREATE INDEX "pain_gain_calculations_target_idx" ON "pain_gain_calculations" USING btree ("company_id","target_cost_id");--> statement-breakpoint
CREATE INDEX "pain_gain_calculations_project_idx" ON "pain_gain_calculations" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "portfolio_allocations_company_idx" ON "portfolio_allocations" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "portfolio_allocations_project_idx" ON "portfolio_allocations" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "portfolio_allocations_source_idx" ON "portfolio_allocations" USING btree ("company_id","funding_source_id");--> statement-breakpoint
CREATE INDEX "portfolio_allocations_appropriation_idx" ON "portfolio_allocations" USING btree ("appropriation_id");--> statement-breakpoint
CREATE INDEX "portfolio_allocations_year_idx" ON "portfolio_allocations" USING btree ("company_id","fiscal_year");--> statement-breakpoint
CREATE INDEX "portfolio_appropriations_company_idx" ON "portfolio_appropriations" USING btree ("company_id","fiscal_year","status");--> statement-breakpoint
CREATE INDEX "portfolio_appropriations_source_idx" ON "portfolio_appropriations" USING btree ("company_id","funding_source_id");--> statement-breakpoint
CREATE INDEX "portfolio_appropriations_portfolio_idx" ON "portfolio_appropriations" USING btree ("company_id","portfolio_id");--> statement-breakpoint
CREATE INDEX "portfolio_appropriations_carry_idx" ON "portfolio_appropriations" USING btree ("carried_forward_from_id");--> statement-breakpoint
CREATE INDEX "portfolio_envelopes_company_idx" ON "portfolio_envelopes" USING btree ("company_id","fiscal_year","status");--> statement-breakpoint
CREATE INDEX "portfolio_envelopes_portfolio_idx" ON "portfolio_envelopes" USING btree ("company_id","portfolio_id");--> statement-breakpoint
CREATE INDEX "portfolio_funding_sources_company_idx" ON "portfolio_funding_sources" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "portfolio_funding_sources_portfolio_idx" ON "portfolio_funding_sources" USING btree ("company_id","portfolio_id");--> statement-breakpoint
CREATE INDEX "portfolio_funding_sources_currency_idx" ON "portfolio_funding_sources" USING btree ("company_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_scores_uq" ON "portfolio_scores" USING btree ("model_id","project_id");--> statement-breakpoint
CREATE INDEX "portfolio_scores_company_idx" ON "portfolio_scores" USING btree ("company_id","model_id");--> statement-breakpoint
CREATE INDEX "portfolio_scores_project_idx" ON "portfolio_scores" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "portfolio_scoring_models_company_idx" ON "portfolio_scoring_models" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "portfolio_scoring_models_portfolio_idx" ON "portfolio_scoring_models" USING btree ("company_id","portfolio_id");--> statement-breakpoint
CREATE INDEX "portfolio_virements_company_idx" ON "portfolio_virements" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "portfolio_virements_from_idx" ON "portfolio_virements" USING btree ("from_appropriation_id");--> statement-breakpoint
CREATE INDEX "portfolio_virements_to_idx" ON "portfolio_virements" USING btree ("to_appropriation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_of_rates_items_uq" ON "schedule_of_rates_items" USING btree ("term_contract_id","code");--> statement-breakpoint
CREATE INDEX "schedule_of_rates_items_contract_idx" ON "schedule_of_rates_items" USING btree ("company_id","term_contract_id","active");--> statement-breakpoint
CREATE INDEX "target_cost_contracts_project_idx" ON "target_cost_contracts" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "term_contracts_uq" ON "term_contracts" USING btree ("company_id","reference");--> statement-breakpoint
CREATE INDEX "term_contracts_company_idx" ON "term_contracts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "term_contracts_vendor_idx" ON "term_contracts" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_passes_badge_uq" ON "site_access_passes" USING btree ("project_id","badge_code");--> statement-breakpoint
CREATE INDEX "site_passes_project_idx" ON "site_access_passes" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_passes_worker_idx" ON "site_access_passes" USING btree ("project_id","worker_id");--> statement-breakpoint
CREATE INDEX "site_passes_expiry_idx" ON "site_access_passes" USING btree ("status","valid_until");--> statement-breakpoint
CREATE UNIQUE INDEX "site_flights_ref_uq" ON "site_drone_flights" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_flights_project_idx" ON "site_drone_flights" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_flights_planned_idx" ON "site_drone_flights" USING btree ("project_id","planned_for");--> statement-breakpoint
CREATE UNIQUE INDEX "site_env_events_ref_uq" ON "site_environmental_events" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_env_events_project_idx" ON "site_environmental_events" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_env_events_occurred_idx" ON "site_environmental_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "site_env_events_category_idx" ON "site_environmental_events" USING btree ("project_id","category");--> statement-breakpoint
CREATE INDEX "site_zones_project_idx" ON "site_exclusion_zones" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_zones_active_idx" ON "site_exclusion_zones" USING btree ("status","active_to");--> statement-breakpoint
CREATE INDEX "site_zones_permit_idx" ON "site_exclusion_zones" USING btree ("permit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_gate_events_external_uq" ON "site_gate_events" USING btree ("project_id","external_ref");--> statement-breakpoint
CREATE INDEX "site_gate_events_project_time_idx" ON "site_gate_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "site_gate_events_pass_idx" ON "site_gate_events" USING btree ("project_id","pass_id","occurred_at");--> statement-breakpoint
CREATE INDEX "site_gate_events_badge_idx" ON "site_gate_events" USING btree ("project_id","badge_code","occurred_at");--> statement-breakpoint
CREATE INDEX "site_gate_events_company_idx" ON "site_gate_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_geotech_ref_uq" ON "site_geotech_investigations" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_geotech_project_idx" ON "site_geotech_investigations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_geotech_baseline_idx" ON "site_geotech_investigations" USING btree ("project_id","is_baseline");--> statement-breakpoint
CREATE INDEX "site_geotech_hole_idx" ON "site_geotech_investigations" USING btree ("project_id","hole_ref");--> statement-breakpoint
CREATE INDEX "site_ground_findings_project_idx" ON "site_ground_findings" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_ground_findings_investigation_idx" ON "site_ground_findings" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "site_ground_findings_category_idx" ON "site_ground_findings" USING btree ("project_id","category");--> statement-breakpoint
CREATE INDEX "site_inductions_project_idx" ON "site_inductions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_inductions_worker_idx" ON "site_inductions" USING btree ("project_id","worker_id");--> statement-breakpoint
CREATE INDEX "site_inductions_expiry_idx" ON "site_inductions" USING btree ("status","valid_until");--> statement-breakpoint
CREATE INDEX "site_inductions_company_idx" ON "site_inductions" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "site_lw_checkins_session_idx" ON "site_lone_worker_checkins" USING btree ("session_id","checked_in_at");--> statement-breakpoint
CREATE INDEX "site_lw_checkins_project_idx" ON "site_lone_worker_checkins" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "site_lone_worker_project_idx" ON "site_lone_worker_sessions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_lone_worker_due_idx" ON "site_lone_worker_sessions" USING btree ("status","next_due_at");--> statement-breakpoint
CREATE INDEX "site_lone_worker_company_idx" ON "site_lone_worker_sessions" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "site_muster_checkins_uq" ON "site_muster_checkins" USING btree ("muster_id","person_key");--> statement-breakpoint
CREATE INDEX "site_muster_checkins_muster_idx" ON "site_muster_checkins" USING btree ("muster_id","status");--> statement-breakpoint
CREATE INDEX "site_muster_checkins_project_idx" ON "site_muster_checkins" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_musters_ref_uq" ON "site_musters" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_musters_project_idx" ON "site_musters" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_musters_declared_idx" ON "site_musters" USING btree ("project_id","declared_at");--> statement-breakpoint
CREATE INDEX "site_permit_entries_permit_idx" ON "site_permit_entries" USING btree ("permit_id","status");--> statement-breakpoint
CREATE INDEX "site_permit_entries_project_idx" ON "site_permit_entries" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_permit_entries_overdue_idx" ON "site_permit_entries" USING btree ("status","expected_exit_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_permits_ref_uq" ON "site_permits" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_permits_project_status_idx" ON "site_permits" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_permits_validity_idx" ON "site_permits" USING btree ("status","valid_to");--> statement-breakpoint
CREATE INDEX "site_permits_type_idx" ON "site_permits" USING btree ("project_id","permit_type","status");--> statement-breakpoint
CREATE INDEX "site_permits_company_idx" ON "site_permits" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "site_tour_stations_tour_idx" ON "site_photo_tour_stations" USING btree ("tour_id","sequence");--> statement-breakpoint
CREATE INDEX "site_tour_stations_project_idx" ON "site_photo_tour_stations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "site_tours_project_idx" ON "site_photo_tours" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_tours_captured_idx" ON "site_photo_tours" USING btree ("project_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_progress_obs_ref_uq" ON "site_progress_observations" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_progress_obs_project_idx" ON "site_progress_observations" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "site_progress_obs_result_idx" ON "site_progress_observations" USING btree ("project_id","result");--> statement-breakpoint
CREATE INDEX "site_progress_obs_task_idx" ON "site_progress_observations" USING btree ("project_id","schedule_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_deviations_ref_uq" ON "site_scan_deviations" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_deviations_scan_idx" ON "site_scan_deviations" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "site_deviations_project_idx" ON "site_scan_deviations" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "site_scans_ref_uq" ON "site_scans" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_scans_project_idx" ON "site_scans" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_scans_captured_idx" ON "site_scans" USING btree ("project_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_setting_out_ref_uq" ON "site_setting_out_records" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_setting_out_project_idx" ON "site_setting_out_records" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_setting_out_task_idx" ON "site_setting_out_records" USING btree ("project_id","schedule_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_survey_points_uq" ON "site_survey_points" USING btree ("project_id","point_ref");--> statement-breakpoint
CREATE INDEX "site_survey_points_project_idx" ON "site_survey_points" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_survey_points_kind_idx" ON "site_survey_points" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "site_utility_services_uq" ON "site_utility_services" USING btree ("project_id","service_ref");--> statement-breakpoint
CREATE INDEX "site_utility_services_project_idx" ON "site_utility_services" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_utility_services_type_idx" ON "site_utility_services" USING btree ("project_id","utility_type");--> statement-breakpoint
CREATE UNIQUE INDEX "site_strikes_ref_uq" ON "site_utility_strikes" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_strikes_project_idx" ON "site_utility_strikes" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_strikes_occurred_idx" ON "site_utility_strikes" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_weather_analyses_ref_uq" ON "site_weather_analyses" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "site_weather_analyses_project_idx" ON "site_weather_analyses" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "site_weather_analyses_period_idx" ON "site_weather_analyses" USING btree ("project_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "site_weather_baselines_project_idx" ON "site_weather_baselines" USING btree ("project_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "site_weather_obs_uq" ON "site_weather_observations" USING btree ("project_id","observed_on","source");--> statement-breakpoint
CREATE INDEX "site_weather_obs_project_idx" ON "site_weather_observations" USING btree ("project_id","observed_on");--> statement-breakpoint
CREATE INDEX "site_weather_obs_company_idx" ON "site_weather_observations" USING btree ("company_id","observed_on");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_assignments_uq" ON "resource_assignments" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "resource_assignments_project_idx" ON "resource_assignments" USING btree ("project_id","status","from_date");--> statement-breakpoint
CREATE INDEX "resource_assignments_window_idx" ON "resource_assignments" USING btree ("project_id","from_date","to_date");--> statement-breakpoint
CREATE INDEX "resource_assignments_crew_idx" ON "resource_assignments" USING btree ("crew_id","from_date");--> statement-breakpoint
CREATE INDEX "resource_assignments_worker_idx" ON "resource_assignments" USING btree ("worker_id","from_date");--> statement-breakpoint
CREATE INDEX "resource_assignments_equipment_idx" ON "resource_assignments" USING btree ("equipment_id","from_date");--> statement-breakpoint
CREATE INDEX "resource_assignments_task_idx" ON "resource_assignments" USING btree ("schedule_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_availability_uq" ON "resource_availability" USING btree ("project_id","resource_type_id","week_start");--> statement-breakpoint
CREATE INDEX "resource_availability_project_idx" ON "resource_availability" USING btree ("project_id","week_start");--> statement-breakpoint
CREATE INDEX "resource_availability_type_idx" ON "resource_availability" USING btree ("resource_type_id","week_start");--> statement-breakpoint
CREATE INDEX "resource_demands_plan_idx" ON "resource_demands" USING btree ("plan_id","week_start");--> statement-breakpoint
CREATE INDEX "resource_demands_type_idx" ON "resource_demands" USING btree ("plan_id","resource_type_id","week_start");--> statement-breakpoint
CREATE INDEX "resource_demands_project_idx" ON "resource_demands" USING btree ("project_id","week_start");--> statement-breakpoint
CREATE INDEX "resource_demands_task_idx" ON "resource_demands" USING btree ("source_task_id");--> statement-breakpoint
CREATE INDEX "resource_forecasts_project_idx" ON "resource_forecasts" USING btree ("project_id","as_of_date");--> statement-breakpoint
CREATE INDEX "resource_forecasts_type_idx" ON "resource_forecasts" USING btree ("project_id","resource_type_id","as_of_date");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_plans_uq" ON "resource_plans" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "resource_plans_project_idx" ON "resource_plans" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "resource_plans_company_idx" ON "resource_plans" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "resource_plans_kind_idx" ON "resource_plans" USING btree ("project_id","plan_kind","status");--> statement-breakpoint
CREATE INDEX "resource_prod_snapshots_project_idx" ON "resource_productivity_snapshots" USING btree ("project_id","period_end");--> statement-breakpoint
CREATE INDEX "resource_prod_snapshots_scope_idx" ON "resource_productivity_snapshots" USING btree ("project_id","scope","scope_id","period_end");--> statement-breakpoint
CREATE INDEX "resource_prod_snapshots_week_idx" ON "resource_productivity_snapshots" USING btree ("project_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_skills_uq" ON "resource_skills" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "resource_skills_company_idx" ON "resource_skills" USING btree ("company_id","category","status");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_types_uq" ON "resource_types" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "resource_types_company_idx" ON "resource_types" USING btree ("company_id","kind","status");--> statement-breakpoint
CREATE INDEX "resource_types_project_idx" ON "resource_types" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_skills_uq" ON "worker_skills" USING btree ("worker_id","skill_id");--> statement-breakpoint
CREATE INDEX "worker_skills_project_idx" ON "worker_skills" USING btree ("project_id","skill_id");--> statement-breakpoint
CREATE INDEX "worker_skills_expiry_idx" ON "worker_skills" USING btree ("company_id","expires_at");--> statement-breakpoint
CREATE INDEX "worker_skills_worker_idx" ON "worker_skills" USING btree ("project_id","worker_id");--> statement-breakpoint
CREATE INDEX "agent_actions_company_idx" ON "agent_actions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "agent_actions_project_idx" ON "agent_actions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agent_actions_target_idx" ON "agent_actions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "agent_actions_review_idx" ON "agent_actions" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_policies_kind_idx" ON "agent_policies" USING btree ("company_id","agent_kind");--> statement-breakpoint
CREATE INDEX "agent_policies_company_idx" ON "agent_policies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_reports_company_idx" ON "agent_reports" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "agent_reports_project_idx" ON "agent_reports" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agent_run_meta_company_idx" ON "agent_run_meta" USING btree ("company_id","agent_kind");--> statement-breakpoint
CREATE INDEX "agent_run_meta_project_idx" ON "agent_run_meta" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agent_schedules_due_idx" ON "agent_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "agent_schedules_company_idx" ON "agent_schedules" USING btree ("company_id","agent_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_usage_daily_key_idx" ON "agent_usage_daily" USING btree ("company_id","usage_date","agent_kind");--> statement-breakpoint
CREATE INDEX "agent_usage_daily_company_idx" ON "agent_usage_daily" USING btree ("company_id","usage_date");--> statement-breakpoint
CREATE INDEX "assurance_grants_company_idx" ON "assurance_grants" USING btree ("company_id","role");--> statement-breakpoint
CREATE INDEX "auth_events_at_idx" ON "auth_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_events_company_idx" ON "auth_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expiry_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "contacts_company_deleted_idx" ON "contacts" USING btree ("company_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_group_members_uq" ON "distribution_group_members" USING btree ("group_id","member_key");--> statement-breakpoint
CREATE INDEX "distribution_groups_company_idx" ON "distribution_groups" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "vendors_company_status_idx" ON "vendors" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "vendors_company_deleted_idx" ON "vendors" USING btree ("company_id","deleted_at");--> statement-breakpoint
CREATE INDEX "comments_project_idx" ON "comments" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "cost_codes_parent_idx" ON "cost_codes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "custom_field_defs_company_idx" ON "custom_field_defs" USING btree ("company_id","tool");--> statement-breakpoint
CREATE INDEX "custom_field_values_scope_idx" ON "custom_field_values" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "projects_company_deleted_idx" ON "projects" USING btree ("company_id","deleted_at");--> statement-breakpoint
CREATE INDEX "projects_company_stage_idx" ON "projects" USING btree ("company_id","stage");--> statement-breakpoint
CREATE INDEX "record_links_project_idx" ON "record_links" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "watchers_scope_idx" ON "watchers" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "file_access_log_project_idx" ON "file_access_log" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "file_access_log_user_idx" ON "file_access_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "files_company_idx" ON "files" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "files_type_idx" ON "files" USING btree ("project_id","document_type");--> statement-breakpoint
CREATE INDEX "files_deleted_idx" ON "files" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE INDEX "files_checkout_idx" ON "files" USING btree ("checked_out_by");--> statement-breakpoint
CREATE INDEX "folders_company_idx" ON "folders" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_path_uq" ON "folders" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "drawing_hyperlinks_to_idx" ON "drawing_hyperlinks" USING btree ("to_sheet_id");--> statement-breakpoint
CREATE INDEX "drawing_hyperlinks_status_idx" ON "drawing_hyperlinks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drawing_markups_sheet_idx" ON "drawing_markups" USING btree ("sheet_id","layer");--> statement-breakpoint
CREATE INDEX "drawing_revisions_file_idx" ON "drawing_revisions" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "drawing_revisions_fts_idx" ON "drawing_revisions" USING gin (to_tsvector('english', left(coalesce("extracted_text", ''), 400000)));--> statement-breakpoint
CREATE INDEX "drawing_sets_processing_idx" ON "drawing_sets" USING btree ("company_id","processing");--> statement-breakpoint
CREATE INDEX "drawing_sheets_review_idx" ON "drawing_sheets" USING btree ("project_id","needs_review");--> statement-breakpoint
CREATE INDEX "drawing_sheets_discipline_idx" ON "drawing_sheets" USING btree ("project_id","discipline");--> statement-breakpoint
CREATE INDEX "drawing_sheets_area_idx" ON "drawing_sheets" USING btree ("project_id","area");--> statement-breakpoint
CREATE INDEX "bim_elements_location_idx" ON "bim_elements" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "bim_model_versions_processing_idx" ON "bim_model_versions" USING btree ("processing");--> statement-breakpoint
CREATE INDEX "coordination_issues_status_idx" ON "coordination_issues" USING btree ("project_id","status","due_date");--> statement-breakpoint
CREATE INDEX "coordination_issues_assignee_idx" ON "coordination_issues" USING btree ("project_id","assignee_id");--> statement-breakpoint
CREATE INDEX "delivery_milestones_due_idx" ON "delivery_milestones" USING btree ("company_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sensor_readings_uq" ON "sensor_readings" USING btree ("sensor_id","at");--> statement-breakpoint
CREATE INDEX "sensors_active_idx" ON "sensors" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE INDEX "warranties_expiry_idx" ON "warranties" USING btree ("company_id","status","end_date");--> statement-breakpoint
CREATE INDEX "daily_logs_date_idx" ON "daily_logs" USING btree ("project_id","log_date");--> statement-breakpoint
CREATE INDEX "daily_logs_status_idx" ON "daily_logs" USING btree ("project_id","status","log_date");--> statement-breakpoint
CREATE INDEX "daily_logs_company_idx" ON "daily_logs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "photos_album_idx" ON "photos" USING btree ("project_id","album");--> statement-breakpoint
CREATE INDEX "photos_taken_idx" ON "photos" USING btree ("project_id","taken_at");--> statement-breakpoint
CREATE INDEX "photos_location_idx" ON "photos" USING btree ("project_id","location_id");--> statement-breakpoint
CREATE INDEX "photos_file_idx" ON "photos" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "photos_uploader_idx" ON "photos" USING btree ("project_id","uploaded_by");--> statement-breakpoint
CREATE INDEX "photos_tags_gin_idx" ON "photos" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "photos_ai_tags_gin_idx" ON "photos" USING gin ("ai_tags");--> statement-breakpoint
CREATE INDEX "punch_items_status_idx" ON "punch_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "punch_items_location_idx" ON "punch_items" USING btree ("project_id","location_id");--> statement-breakpoint
CREATE INDEX "punch_items_due_idx" ON "punch_items" USING btree ("project_id","status","due_date");--> statement-breakpoint
CREATE INDEX "punch_items_assignee_idx" ON "punch_items" USING btree ("project_id","assignee_id");--> statement-breakpoint
CREATE INDEX "punch_items_vendor_idx" ON "punch_items" USING btree ("project_id","vendor_id");--> statement-breakpoint
CREATE INDEX "rfis_company_project_idx" ON "rfis" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "rfis_due_idx" ON "rfis" USING btree ("project_id","status","due_date");--> statement-breakpoint
CREATE INDEX "rfis_bic_idx" ON "rfis" USING btree ("project_id","ball_in_court_id");--> statement-breakpoint
CREATE INDEX "submittal_review_steps_reviewer_idx" ON "submittal_review_steps" USING btree ("reviewer_id","response_code");--> statement-breakpoint
CREATE INDEX "submittals_status_idx" ON "submittals" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "submittals_submit_by_idx" ON "submittals" USING btree ("project_id","status","submit_by_date");--> statement-breakpoint
CREATE INDEX "submittals_bic_idx" ON "submittals" USING btree ("project_id","ball_in_court_id");--> statement-breakpoint
CREATE INDEX "submittals_previous_idx" ON "submittals" USING btree ("previous_id");--> statement-breakpoint
CREATE INDEX "submittals_spec_idx" ON "submittals" USING btree ("project_id","spec_section");--> statement-breakpoint
CREATE INDEX "notifications_feed_idx" ON "notifications" USING btree ("company_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_digest_idx" ON "notifications" USING btree ("company_id","user_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "workflow_instances_company_status_idx" ON "workflow_instances" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "workflow_instances_live_idx" ON "workflow_instances" USING btree ("company_id","record_type","record_id","status");--> statement-breakpoint
CREATE INDEX "workflow_steps_assignee_idx" ON "workflow_step_instances" USING btree ("assignee_id","decision");--> statement-breakpoint
CREATE INDEX "workflow_steps_delegate_idx" ON "workflow_step_instances" USING btree ("delegated_to_id","decision");--> statement-breakpoint
CREATE INDEX "workflow_steps_due_idx" ON "workflow_step_instances" USING btree ("decision","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_uq" ON "workflow_step_instances" USING btree ("instance_id","position","assignee_id");--> statement-breakpoint
CREATE INDEX "workflow_templates_record_idx" ON "workflow_templates" USING btree ("company_id","record_type","is_active");--> statement-breakpoint
CREATE INDEX "assertions_claimant_idx" ON "assertions" USING btree ("company_id","claimant_id");--> statement-breakpoint
CREATE INDEX "assertions_kind_idx" ON "assertions" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "entities_company_deleted_idx" ON "entities" USING btree ("company_id","deleted_at");--> statement-breakpoint
CREATE INDEX "signals_fingerprint_idx" ON "signals" USING btree ("company_id","detector","fingerprint");--> statement-breakpoint
CREATE INDEX "signals_subject_idx" ON "signals" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "signals_detector_idx" ON "signals" USING btree ("company_id","detector","disposition");--> statement-breakpoint
CREATE INDEX "boq_items_code_idx" ON "boq_items" USING btree ("boq_id","code");--> statement-breakpoint
CREATE INDEX "boqs_company_status_idx" ON "boqs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "boqs_contract_idx" ON "boqs" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "payment_certificates_due_idx" ON "payment_certificates" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "payment_certificates_company_idx" ON "payment_certificates" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "valuation_lines_item_idx" ON "valuation_lines" USING btree ("boq_item_id");--> statement-breakpoint
CREATE INDEX "valuations_company_status_idx" ON "valuations" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "valuations_boq_status_idx" ON "valuations" USING btree ("boq_id","status");--> statement-breakpoint
CREATE INDEX "variations_status_idx" ON "variations" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "contract_events_company_status_idx" ON "contract_events" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "contract_events_ce_idx" ON "contract_events" USING btree ("contract_id","ce_state");--> statement-breakpoint
CREATE INDEX "contracts_company_status_idx" ON "contracts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "eot_claims_status_idx" ON "eot_claims" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "schedule_tasks_external_idx" ON "schedule_tasks" USING btree ("schedule_id","external_id");--> statement-breakpoint
CREATE INDEX "schedule_tasks_milestone_idx" ON "schedule_tasks" USING btree ("project_id","is_key_milestone");--> statement-breakpoint
CREATE INDEX "schedule_tasks_budget_line_idx" ON "schedule_tasks" USING btree ("budget_line_item_id");--> statement-breakpoint
CREATE INDEX "schedules_company_idx" ON "schedules" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "schedules_parent_idx" ON "schedules" USING btree ("parent_schedule_id");--> statement-breakpoint
CREATE INDEX "delay_events_status_idx" ON "delay_events" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "delay_events_schedule_idx" ON "delay_events" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "delay_events_start_idx" ON "delay_events" USING btree ("project_id","start_date");--> statement-breakpoint
CREATE INDEX "delay_events_notice_idx" ON "delay_events" USING btree ("status","notice_due_date");--> statement-breakpoint
CREATE INDEX "forensic_claims_status_idx" ON "forensic_claims" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_entries_uq" ON "payroll_entries" USING btree ("worker_id","period_start","period_end","source_ref");--> statement-breakpoint
CREATE INDEX "report_schedules_due_idx" ON "report_schedules" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX "ingested_records_run_status_idx" ON "ingested_records" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "ingestion_runs_status_idx" ON "ingestion_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "ingestion_runs_project_idx" ON "ingestion_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "benchmark_samples_cell_idx" ON "benchmark_samples" USING btree ("metric","asset_class","region","currency");--> statement-breakpoint
CREATE INDEX "benchmark_samples_live_idx" ON "benchmark_samples" USING btree ("metric","superseded_at");--> statement-breakpoint
CREATE INDEX "bonds_facility_idx" ON "bonds" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "bonds_status_idx" ON "bonds" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "insurance_certificates_project_idx" ON "insurance_certificates" USING btree ("company_id","project_id","valid_to");--> statement-breakpoint
CREATE INDEX "insurance_claims_project_idx" ON "insurance_claims" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "insurance_claims_notification_idx" ON "insurance_claims" USING btree ("company_id","notified_at","notification_due_at");--> statement-breakpoint
CREATE INDEX "insurance_policies_period_idx" ON "insurance_policies" USING btree ("company_id","period_end");--> statement-breakpoint
CREATE INDEX "insurance_policies_renewal_idx" ON "insurance_policies" USING btree ("company_id","renewal_status");--> statement-breakpoint
CREATE INDEX "lesson_applications_outcome_idx" ON "lesson_applications" USING btree ("company_id","outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_triggers_source_uq" ON "lesson_triggers" USING btree ("project_id","kind","source_key");--> statement-breakpoint
CREATE INDEX "lessons_origin_idx" ON "lessons" USING btree ("company_id","origin_project_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_company_idx" ON "webhook_deliveries" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_active_idx" ON "webhook_endpoints" USING btree ("is_active","circuit_open_until");--> statement-breakpoint
CREATE INDEX "change_order_requests_package_idx" ON "change_order_requests" USING btree ("change_order_package_id");--> statement-breakpoint
CREATE INDEX "commitment_changes_commitment_idx" ON "commitment_changes" USING btree ("commitment_id","status");--> statement-breakpoint
CREATE INDEX "commitment_payments_commitment_idx" ON "commitment_payments" USING btree ("commitment_id","status");--> statement-breakpoint
CREATE INDEX "commitment_sov_lines_project_budget_idx" ON "commitment_sov_lines" USING btree ("project_id","budget_line_item_id");--> statement-breakpoint
CREATE INDEX "invoice_line_items_project_idx" ON "invoice_line_items" USING btree ("project_id","company_id");--> statement-breakpoint
CREATE INDEX "invoices_company_idx" ON "invoices" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "potential_change_orders_cor_idx" ON "potential_change_orders" USING btree ("change_order_request_id");--> statement-breakpoint
CREATE INDEX "spec_section_revisions_fts_idx" ON "spec_section_revisions" USING gin (to_tsvector('english', left(coalesce("extracted_text", ''), 400000)));--> statement-breakpoint
CREATE INDEX "spec_submittal_requirements_reconfirm_idx" ON "spec_submittal_requirements" USING btree ("project_id","needs_reconfirmation");--> statement-breakpoint
CREATE INDEX "meeting_action_items_company_due_idx" ON "meeting_action_items" USING btree ("company_id","status","due_date");--> statement-breakpoint
CREATE INDEX "meetings_company_status_idx" ON "meetings" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "equipment_telematics_readings_device_idx" ON "equipment_telematics_readings" USING btree ("company_id","device_id","recorded_at");--> statement-breakpoint
CREATE INDEX "material_items_required_idx" ON "material_items" USING btree ("company_id","required_on_site_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bid_invitations_portal_token_uq" ON "bid_invitations" USING btree ("portal_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "prequalification_submissions_portal_token_uq" ON "prequalification_submissions" USING btree ("portal_token_hash");--> statement-breakpoint
CREATE INDEX "auth_security_events_ip_at_idx" ON "auth_security_events" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "drawing_revisions_set_idx" ON "drawing_revisions" USING btree ("set_id","page_index");--> statement-breakpoint
CREATE INDEX "auth_security_events_email_idx" ON "auth_security_events" USING btree ("email","created_at");--> statement-breakpoint
ALTER TABLE "distribution_groups" ADD CONSTRAINT "distribution_groups_uq" UNIQUE NULLS NOT DISTINCT("company_id","project_id","name");--> statement-breakpoint
ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_uq" UNIQUE NULLS NOT DISTINCT("company_id","project_id","code");--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_uq" UNIQUE NULLS NOT DISTINCT("company_id","project_id","tool","key");