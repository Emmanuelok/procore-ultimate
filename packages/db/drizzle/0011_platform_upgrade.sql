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