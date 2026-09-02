CREATE TABLE "anchor_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"seal_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_ref" text,
	"proof" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chain_seals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"from_entry_seq" integer NOT NULL,
	"to_entry_seq" integer NOT NULL,
	"entry_count" integer NOT NULL,
	"head_hash" text NOT NULL,
	"merkle_root" text NOT NULL,
	"prev_seal_hash" text,
	"body_hash" text NOT NULL,
	"signature" text NOT NULL,
	"key_id" text NOT NULL,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_heartbeat" integer DEFAULT 0 NOT NULL,
	"sealed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"seal_id" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_ref" text,
	"recipient_user_id" text,
	"receipt_hash" text NOT NULL,
	"document" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"purpose" text,
	"issued_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_verdict" text
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text,
	"key_id" text NOT NULL,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"public_key_pem" text NOT NULL,
	"fingerprint" text NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bond_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"bond_id" text NOT NULL,
	"called_at" text NOT NULL,
	"amount" double precision NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text,
	"proceeds_received_at" text,
	"proceeds_amount" double precision,
	"called_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonds" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"contract_id" text,
	"number" text NOT NULL,
	"bond_type" text NOT NULL,
	"guarantor" text NOT NULL,
	"bond_number" text,
	"principal_vendor_id" text,
	"beneficiary" text,
	"amount" double precision NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"percent_of_contract" double precision,
	"is_on_demand" integer DEFAULT 0 NOT NULL,
	"issued_at" text,
	"expiry_at" text,
	"demand_deadline" text,
	"reduction_schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"document_id" text,
	"released_at" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_certificates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"policy_id" text,
	"vendor_id" text,
	"subject_name" text NOT NULL,
	"policy_type" text NOT NULL,
	"certificate_number" text,
	"insurer" text,
	"limit_of_indemnity" double precision,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"valid_from" text NOT NULL,
	"valid_to" text NOT NULL,
	"file_id" text,
	"file_sha256" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"verification_method" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"policy_id" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"incident_date" text NOT NULL,
	"aware_date" text NOT NULL,
	"notified_at" text,
	"notification_due_at" text,
	"obligation_id" text,
	"quantum" double precision,
	"reserve" double precision,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"status" text DEFAULT 'notified' NOT NULL,
	"insurer_ref" text,
	"loss_adjuster" text,
	"repudiation_reason" text,
	"settled_amount" double precision,
	"settled_at" text,
	"linked_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"number" text NOT NULL,
	"policy_type" text NOT NULL,
	"insurer" text NOT NULL,
	"broker_vendor_id" text,
	"policy_number" text NOT NULL,
	"insured_parties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limit_of_indemnity" double precision,
	"limit_basis" text,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"deductible" double precision,
	"deductible_basis" text,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"notification_days" integer,
	"territorial_limits" text,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_by_clause" text,
	"contract_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"document_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"project_id" text NOT NULL,
	"applied_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" text NOT NULL,
	"outcome_note" text,
	"applied_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"due_at" text,
	"obligation_id" text,
	"lesson_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"dismissed_reason" text,
	"dismissed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"origin_project_id" text,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"phase" text,
	"context" text,
	"what_happened" text NOT NULL,
	"root_cause" text,
	"recommendation" text NOT NULL,
	"impact_value" double precision,
	"impact_currency" text,
	"impact_days" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"validated_by" text,
	"validated_at" timestamp with time zone,
	"rejection_reason" text,
	"published_at" timestamp with time zone,
	"superseded_by_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_project_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" text,
	"held_at" text,
	"facilitator" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"what_went_well" text,
	"what_did_not" text,
	"signed_off_by" text,
	"signed_off_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"client_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_types" jsonb DEFAULT '["client_credentials"]'::jsonb NOT NULL,
	"token_ttl_seconds" integer DEFAULT 3600 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"ledger_entry_id" text,
	"event_kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" text,
	"response_status" integer,
	"response_body" text,
	"error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"event_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project_id" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"secret_fingerprint" text NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"disabled_reason" text,
	"last_delivery_at" timestamp with time zone,
	"last_status" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "anchor_submissions_seal_idx" ON "anchor_submissions" USING btree ("seal_id");--> statement-breakpoint
CREATE INDEX "anchor_submissions_company_idx" ON "anchor_submissions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_seals_company_sequence_idx" ON "chain_seals" USING btree ("company_id","sequence");--> statement-breakpoint
CREATE INDEX "chain_seals_company_idx" ON "chain_seals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "escrow_receipts_company_idx" ON "escrow_receipts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "escrow_receipts_seal_idx" ON "escrow_receipts" USING btree ("seal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_key_id_idx" ON "signing_keys" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "signing_keys_company_idx" ON "signing_keys" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "bond_calls_bond_idx" ON "bond_calls" USING btree ("bond_id");--> statement-breakpoint
CREATE INDEX "bonds_company_idx" ON "bonds" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "bonds_project_idx" ON "bonds" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "insurance_certificates_company_idx" ON "insurance_certificates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "insurance_certificates_vendor_idx" ON "insurance_certificates" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "insurance_certificates_valid_to_idx" ON "insurance_certificates" USING btree ("valid_to");--> statement-breakpoint
CREATE INDEX "insurance_claims_company_idx" ON "insurance_claims" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "insurance_claims_policy_idx" ON "insurance_claims" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "insurance_policies_company_idx" ON "insurance_policies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "insurance_policies_project_idx" ON "insurance_policies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "lesson_applications_lesson_idx" ON "lesson_applications" USING btree ("lesson_id");--> statement-breakpoint
CREATE INDEX "lesson_applications_project_idx" ON "lesson_applications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "lesson_triggers_company_idx" ON "lesson_triggers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "lesson_triggers_project_idx" ON "lesson_triggers" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "lessons_company_idx" ON "lessons" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "lessons_category_idx" ON "lessons" USING btree ("company_id","category");--> statement-breakpoint
CREATE INDEX "lessons_status_idx" ON "lessons" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "post_project_reviews_project_idx" ON "post_project_reviews" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_hash_idx" ON "oauth_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_client_idx" ON "oauth_access_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_client_id_idx" ON "oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_company_idx" ON "oauth_clients" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_company_idx" ON "webhook_endpoints" USING btree ("company_id");