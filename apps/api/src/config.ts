import { z } from "zod";

/**
 * An env-var boolean. NOT `z.coerce.boolean()`, which is JavaScript truthiness
 * on a string: it reads "false", "0" and "off" as TRUE, so the documented
 * switches in .env.example (RATE_LIMIT_ENABLED=false, TRUST_PROXY=false) could
 * never be turned off by setting them to false — only by unsetting them.
 */
const envBool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(fallback)
    .transform((v) =>
      typeof v === "boolean" ? v : !["false", "0", "no", "off", ""].includes(v.trim().toLowerCase()),
    );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** directory for the embedded PGlite database when DATABASE_URL is unset */
  PGLITE_DIR: z.string().default("./.pglite"),
  /** Production refuses to boot on the embedded database unless this is set:
   *  an in-container PGlite is wiped on every redeploy, and a platform whose
   *  product is the durability of its record must not report healthy on it. */
  ALLOW_EMBEDDED_DB: envBool(false),
  /** Same guard for the local-disk storage driver in production — it needs a
   *  mounted volume and a single replica, which is a deliberate choice. */
  ALLOW_LOCAL_STORAGE: envBool(false),
  AUTH_SECRET: z.string().min(16).default("dev-only-secret-change-me-in-prod"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(60 * 60), // 1h
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  /** local = disk under STORAGE_DIR; s3 = any S3-compatible store (Railway
   *  Buckets, AWS S3, Cloudflare R2, MinIO) via the S3_* variables. */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_DIR: z.string().default("./data/storage"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: envBool(false),
  /** absolute or cwd-relative path to the built SPA; when set and present,
   *  the API serves it same-origin with an SPA fallback */
  WEB_DIST_DIR: z.string().optional(),
  /** override the drizzle migrations folder (set in the container image) */
  MIGRATIONS_DIR: z.string().optional(),
  /** honor x-forwarded-* from the platform proxy (Railway, ALB, …) */
  TRUST_PROXY: envBool(false),
  /** How many proxy hops to trust. `1` (the default) trusts only the platform
   *  edge, so a client cannot prepend a fake X-Forwarded-For and dodge the
   *  per-IP auth rate limit; raise it only behind a CDN in front of the edge. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  /** Comma-separated browser origins allowed to call the API cross-origin
   *  with credentials. The SPA is served same-origin in production, so this
   *  is normally empty; APP_BASE_URL's origin is always allowed. */
  CORS_ORIGINS: z.string().default(""),
  /** Per-file multipart ceiling. Uploads are buffered per request, so this
   *  bounds memory per in-flight upload. */
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024 * 1024).default(256 * 1024 * 1024),
  UPLOAD_MAX_FILES: z.coerce.number().int().min(1).max(100).default(25),
  /** The platform job scheduler (lib/scheduler.ts). Off in tests. */
  SCHEDULER_ENABLED: envBool(true),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_ENABLED: envBool(true),
  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().default(300),
  AUTH_RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().default(10),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-opus-5"),
  LOG_LEVEL: z.string().default("info"),

  /* ---------------------------------------------------------------- */
  /* Outbound email (Phase 8)                                          */
  /*                                                                   */
  /* The platform has never dispatched a message. Until EMAIL_PROVIDER  */
  /* is set it still does not: lib/email.ts selects the no-op           */
  /* transport, which RECORDS what it would have sent and reports       */
  /* `dispatched: false` with the missing variable named. An invitation */
  /* nobody receives must never read as a success.                      */
  /* ---------------------------------------------------------------- */
  /** none = record only. resend | postmark = HTTP API via fetch, no npm
   *  dependency. smtp = documented adapter slot; it is accepted as
   *  configuration and reports itself unavailable rather than pretending. */
  EMAIL_PROVIDER: z.enum(["none", "resend", "postmark", "smtp"]).default("none"),
  EMAIL_API_KEY: z.string().optional(),
  /** envelope sender. Must be a domain the provider has verified, or every
   *  message is rejected at the provider rather than at the recipient. */
  EMAIL_FROM_ADDRESS: z.string().optional(),
  EMAIL_FROM_NAME: z.string().default("ConstructOS"),
  EMAIL_REPLY_TO: z.string().optional(),
  /** override the provider's API base — self-hosted gateways and tests */
  EMAIL_API_BASE_URL: z.string().optional(),
  /** SMTP adapter slot. Reserved so the configuration surface is stable;
   *  no SMTP client ships in this repo, so setting these does not send. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: envBool(false),

  /** Absolute origin of the web app, used to build every link that appears
   *  in a message (verify, reset, invitation). Wrong here means links that
   *  point at localhost from production email. */
  APP_BASE_URL: z.string().default("http://localhost:5173"),

  /* --- Single-use token lifetimes --- */
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().default(48),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().default(60),
  INVITATION_TTL_DAYS: z.coerce.number().default(14),
  /** how long a half-finished MFA challenge stays answerable */
  MFA_CHALLENGE_TTL_MINUTES: z.coerce.number().default(10),
  /** absolute ceiling on a device session, regardless of refresh activity */
  SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().default(30),

  /* --- Lockout thresholds --- */
  /** consecutive failures inside the window before the account is locked */
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().default(5),
  LOGIN_FAILURE_WINDOW_MINUTES: z.coerce.number().default(15),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().default(15),
  MFA_MAX_FAILED_ATTEMPTS: z.coerce.number().default(5),
  MFA_LOCKOUT_MINUTES: z.coerce.number().default(15),
  /** how many recovery codes a fresh MFA enrolment issues */
  MFA_RECOVERY_CODE_COUNT: z.coerce.number().default(10),

  /* --- Credential handling --- */
  /** bcrypt work factor. Raising it re-hashes on next successful login, it
   *  does not invalidate existing hashes (the cost is encoded in each one). */
  BCRYPT_COST: z.coerce.number().min(4).max(15).default(10),
  /* --- Ledger anchoring, webhooks (read by their modules; declared here so
   *     production boot can validate them and .env.example stays honest) --- */
  ANCHOR_SIGNING_KEY: z.string().optional(),
  ANCHOR_TRUSTED_FINGERPRINTS: z.string().optional(),
  ANCHOR_TSA_URL: z.string().optional(),
  ANCHOR_OTS_CALENDAR_URL: z.string().optional(),
  ANCHOR_HEARTBEAT_HOURS: z.coerce.number().optional(),
  WEBHOOK_SIGNING_KEY: z.string().optional(),
  /** Key that encrypts the two secrets which cannot be hashed: an identity
   *  provider's client secret and a TOTP seed (see packages/db/src/schema/
   *  auth.ts). Unset, it is derived from AUTH_SECRET — still safe against a
   *  stolen database dump, NOT against an attacker who also holds the JWT
   *  secret. Rotating it makes existing ciphertext unreadable, so re-encrypt
   *  before changing it. */
  SSO_ENCRYPTION_KEY: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  const cfg = envSchema.parse({ ...process.env, ...overrides });
  if (cfg.NODE_ENV === "production") {
    /*
     * Two categories, deliberately separated.
     *
     * REFUSALS are for a hole that makes the deployment unsafe to run at all:
     * a guessable signing secret, or a storage driver that was explicitly
     * chosen and then not configured. Nothing else earns a refusal.
     *
     * WARNINGS are for a deployment that will run correctly but in a reduced
     * shape the operator should know about — the embedded database, the
     * local-disk driver, a mail base URL still pointing at localhost. An
     * earlier version of this file threw on those too, and that mistake took
     * a live deployment down: a service running with a mounted volume (the
     * documented local-driver topology) could no longer boot at all, and the
     * platform healthcheck failed with no clue why. A configuration smell
     * must never be a bigger outage than the problem it warns about. The
     * warnings are logged at boot and reported by /api/v1/health/ready, so
     * they are loud without being fatal.
     */
    const problems: string[] = [];
    const placeholderSecrets = [
      "dev-only-secret-change-me-in-prod",
      "change-me-to-a-long-random-string",
      "changeme",
      "secret",
    ];
    if (placeholderSecrets.includes(cfg.AUTH_SECRET.trim().toLowerCase())) {
      problems.push(
        "AUTH_SECRET is a placeholder. Set a strong secret (openssl rand -hex 32).",
      );
    } else if (cfg.AUTH_SECRET.length < 32 || new Set(cfg.AUTH_SECRET).size < 8) {
      problems.push(
        "AUTH_SECRET is too weak for production (need >= 32 characters of real entropy; openssl rand -hex 32).",
      );
    }
    if (cfg.STORAGE_DRIVER === "s3") {
      const missing = (
        [
          ["S3_ENDPOINT", cfg.S3_ENDPOINT],
          ["S3_BUCKET", cfg.S3_BUCKET],
          ["S3_ACCESS_KEY_ID", cfg.S3_ACCESS_KEY_ID],
          ["S3_SECRET_ACCESS_KEY", cfg.S3_SECRET_ACCESS_KEY],
        ] as const
      )
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (missing.length > 0) {
        problems.push(`STORAGE_DRIVER=s3 requires: ${missing.join(", ")}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`Refusing to start in production:\n - ${problems.join("\n - ")}`);
    }
  }

  // A half-configured mail provider is worse than none: the no-op transport is
  // honest about recording rather than sending, whereas a provider with no key
  // fails per-message, in the background, on the one message that mattered.
  // Refuse at boot instead, in every environment — this is a typo guard, not a
  // production-only policy.
  if (cfg.EMAIL_PROVIDER !== "none") {
    const needed: string[] = [];
    if (!cfg.EMAIL_FROM_ADDRESS) needed.push("EMAIL_FROM_ADDRESS");
    if (cfg.EMAIL_PROVIDER === "smtp") {
      if (!cfg.SMTP_HOST) needed.push("SMTP_HOST");
    } else if (!cfg.EMAIL_API_KEY) {
      needed.push("EMAIL_API_KEY");
    }
    if (needed.length > 0) {
      throw new Error(
        `EMAIL_PROVIDER=${cfg.EMAIL_PROVIDER} requires: ${needed.join(", ")}. ` +
          "Leave EMAIL_PROVIDER unset to keep the no-op transport, which records " +
          "messages and reports them as not dispatched.",
      );
    }
  }
  return cfg;
}

/**
 * Configuration smells worth saying out loud in production: everything that
 * makes the deployment smaller than it looks, without making it unsafe. These
 * are logged at boot and reported by /api/v1/health/ready. They are never
 * fatal — see the note in loadConfig.
 */
export function productionWarnings(cfg: Config): string[] {
  if (cfg.NODE_ENV !== "production") return [];
  const warnings: string[] = [];
  if (!cfg.DATABASE_URL) {
    warnings.push(
      "DATABASE_URL is not set, so this instance is running on the embedded in-container database. " +
        "It is wiped on every redeploy and cannot be shared between replicas. Set DATABASE_URL to a real Postgres.",
    );
  }
  if (cfg.STORAGE_DRIVER === "local") {
    warnings.push(
      "STORAGE_DRIVER=local stores uploaded evidence on the container filesystem. It needs a mounted volume " +
        "and a single replica (on Railway also RAILWAY_RUN_UID=0). STORAGE_DRIVER=s3 is the recommended production driver.",
    );
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(cfg.APP_BASE_URL)) {
    warnings.push(
      `APP_BASE_URL is ${cfg.APP_BASE_URL}, so every link in every message (verification, reset, invitation) ` +
        "points at localhost. Set it to the public origin of the web app.",
    );
  }
  if (cfg.EMAIL_PROVIDER === "none") {
    warnings.push(
      "EMAIL_PROVIDER is unset, so no verification, reset or invitation message is dispatched. " +
        "Each one is recorded and reported as not dispatched.",
    );
  }
  if (!process.env["ANCHOR_SIGNING_KEY"]) {
    warnings.push(
      "ANCHOR_SIGNING_KEY is not set, so ledger seals are signed with a key derived from AUTH_SECRET. " +
        "They then prove integrity against a database-only attacker, not against the operator.",
    );
  }
  if (!cfg.ANTHROPIC_API_KEY) {
    warnings.push("ANTHROPIC_API_KEY is not set, so every AI endpoint reports itself disabled (503).");
  }
  return warnings;
}

export const config = loadConfig();
