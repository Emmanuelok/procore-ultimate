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
  /** directory for the embedded PGlite database when DATABASE_URL is unset */
  PGLITE_DIR: z.string().default("./.pglite"),
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
    if (cfg.AUTH_SECRET === "dev-only-secret-change-me-in-prod") {
      throw new Error(
        "Refusing to start: AUTH_SECRET is the development default. " +
          "Set a strong secret (openssl rand -hex 32) in the environment.",
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
        throw new Error(`STORAGE_DRIVER=s3 requires: ${missing.join(", ")}`);
      }
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

export const config = loadConfig();
