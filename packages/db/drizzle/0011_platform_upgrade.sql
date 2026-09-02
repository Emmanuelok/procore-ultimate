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
DROP INDEX "drawing_revisions_set_idx";--> statement-breakpoint
ALTER TABLE "drawing_hyperlinks" ALTER COLUMN "to_sheet_id" DROP NOT NULL;--> statement-breakpoint
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
ALTER TABLE "spec_section_revisions" ADD COLUMN "impact" jsonb;--> statement-breakpoint
ALTER TABLE "spec_sections" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spec_sections" ADD COLUMN "withdrawn_by" text;--> statement-breakpoint
ALTER TABLE "spec_sections" ADD COLUMN "withdrawn_reason" text;--> statement-breakpoint
ALTER TABLE "spec_submittal_requirements" ADD COLUMN "needs_reconfirmation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_submittal_requirements" ADD COLUMN "superseded_by_revision_id" text;--> statement-breakpoint
ALTER TABLE "spec_submittal_requirements" ADD COLUMN "reissue_note" text;--> statement-breakpoint
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
CREATE UNIQUE INDEX "chain_watermarks_company_uq" ON "chain_watermarks" USING btree ("company_id");--> statement-breakpoint
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
CREATE INDEX "assertions_claimant_idx" ON "assertions" USING btree ("company_id","claimant_id");--> statement-breakpoint
CREATE INDEX "assertions_kind_idx" ON "assertions" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "entities_company_deleted_idx" ON "entities" USING btree ("company_id","deleted_at");--> statement-breakpoint
CREATE INDEX "signals_fingerprint_idx" ON "signals" USING btree ("company_id","detector","fingerprint");--> statement-breakpoint
CREATE INDEX "signals_subject_idx" ON "signals" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "signals_detector_idx" ON "signals" USING btree ("company_id","detector","disposition");--> statement-breakpoint
CREATE INDEX "change_order_requests_package_idx" ON "change_order_requests" USING btree ("change_order_package_id");--> statement-breakpoint
CREATE INDEX "commitment_changes_commitment_idx" ON "commitment_changes" USING btree ("commitment_id","status");--> statement-breakpoint
CREATE INDEX "commitment_payments_commitment_idx" ON "commitment_payments" USING btree ("commitment_id","status");--> statement-breakpoint
CREATE INDEX "commitment_sov_lines_project_budget_idx" ON "commitment_sov_lines" USING btree ("project_id","budget_line_item_id");--> statement-breakpoint
CREATE INDEX "invoice_line_items_project_idx" ON "invoice_line_items" USING btree ("project_id","company_id");--> statement-breakpoint
CREATE INDEX "invoices_company_idx" ON "invoices" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "potential_change_orders_cor_idx" ON "potential_change_orders" USING btree ("change_order_request_id");--> statement-breakpoint
CREATE INDEX "spec_section_revisions_fts_idx" ON "spec_section_revisions" USING gin (to_tsvector('english', left(coalesce("extracted_text", ''), 400000)));--> statement-breakpoint
CREATE INDEX "spec_submittal_requirements_reconfirm_idx" ON "spec_submittal_requirements" USING btree ("project_id","needs_reconfirmation");--> statement-breakpoint
CREATE INDEX "drawing_revisions_set_idx" ON "drawing_revisions" USING btree ("set_id","page_index");