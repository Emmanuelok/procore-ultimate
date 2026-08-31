CREATE TABLE "auth_security_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text,
	"user_id" text,
	"email" text,
	"kind" text NOT NULL,
	"outcome" text DEFAULT 'success' NOT NULL,
	"session_id" text,
	"provider_id" text,
	"identity_id" text,
	"ip" text,
	"user_agent" text,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text,
	"refresh_token_id" text,
	"identity_id" text,
	"provider_id" text,
	"auth_method" text DEFAULT 'password' NOT NULL,
	"mfa_satisfied_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	"device_label" text,
	"device_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user" boolean DEFAULT false NOT NULL,
	"revoked_by" text,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "email_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text,
	"user_id" text,
	"template" text NOT NULL,
	"to_email" text NOT NULL,
	"to_name" text,
	"subject" text NOT NULL,
	"body_preview" text,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"transport" text DEFAULT 'noop' NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"dispatched_at" timestamp with time zone,
	"related_type" text,
	"related_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text DEFAULT 'signup' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_ip" text,
	"requested_user_agent" text,
	"consumed_ip" text,
	"dispatch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"issuer" text,
	"discovery_url" text,
	"authorization_url" text,
	"token_url" text,
	"userinfo_url" text,
	"jwks_uri" text,
	"discovery_fetched_at" timestamp with time zone,
	"client_id" text,
	"secret_storage" text DEFAULT 'encrypted' NOT NULL,
	"client_secret_ciphertext" text,
	"client_secret_ref" text,
	"client_secret_key_id" text,
	"client_secret_fingerprint" text,
	"scopes" jsonb DEFAULT '["openid","email","profile"]'::jsonb NOT NULL,
	"saml_entity_id" text,
	"saml_sso_url" text,
	"saml_binding" text,
	"saml_certificate_pem" text,
	"saml_want_assertions_signed" boolean DEFAULT true NOT NULL,
	"allowed_email_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"domains_verified_at" timestamp with time zone,
	"auto_provision" boolean DEFAULT false NOT NULL,
	"default_company_role" text DEFAULT 'member' NOT NULL,
	"default_template_key" text,
	"group_claim_name" text DEFAULT 'groups' NOT NULL,
	"group_role_mappings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_password_login" boolean DEFAULT true NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"last_used_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mfa_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"batch_id" text NOT NULL,
	"used_at" timestamp with time zone,
	"used_ip" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"requested_ip" text,
	"requested_user_agent" text,
	"consumed_ip" text,
	"dispatch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"company_id" text NOT NULL,
	"external_subject" text NOT NULL,
	"email_at_link" text NOT NULL,
	"display_name" text,
	"raw_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"template_key" text,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text,
	"token_hash" text NOT NULL,
	"token_prefix" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"invited_by" text NOT NULL,
	"send_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_dispatch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"method" text DEFAULT 'totp' NOT NULL,
	"secret_ciphertext" text,
	"secret_key_id" text,
	"label" text,
	"algorithm" text DEFAULT 'SHA1' NOT NULL,
	"digits" integer DEFAULT 6 NOT NULL,
	"period_seconds" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_step" integer,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_security_events_user_idx" ON "auth_security_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_security_events_company_idx" ON "auth_security_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_security_events_email_idx" ON "auth_security_events" USING btree ("email");--> statement-breakpoint
CREATE INDEX "auth_security_events_kind_idx" ON "auth_security_events" USING btree ("kind","outcome");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_refresh_token_idx" ON "auth_sessions" USING btree ("refresh_token_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_company_idx" ON "auth_sessions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "email_dispatches_company_idx" ON "email_dispatches" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "email_dispatches_to_idx" ON "email_dispatches" USING btree ("to_email");--> statement-breakpoint
CREATE INDEX "email_dispatches_status_idx" ON "email_dispatches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_dispatches_related_idx" ON "email_dispatches" USING btree ("related_type","related_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_verifications_token_uq" ON "email_verifications" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_verifications_user_idx" ON "email_verifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_verifications_email_idx" ON "email_verifications" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_providers_slug_uq" ON "identity_providers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "identity_providers_company_idx" ON "identity_providers" USING btree ("company_id","is_enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_recovery_codes_hash_uq" ON "mfa_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_user_idx" ON "mfa_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_batch_idx" ON "mfa_recovery_codes" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "password_resets_token_uq" ON "password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_resets_user_idx" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_resets_email_idx" ON "password_resets" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_subject_uq" ON "user_identities" USING btree ("provider_id","external_subject");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_identities_company_idx" ON "user_identities" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_invitations_token_uq" ON "user_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_invitations_company_idx" ON "user_invitations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "user_invitations_email_idx" ON "user_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "user_invitations_status_idx" ON "user_invitations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_user_method_uq" ON "user_mfa" USING btree ("user_id","method");