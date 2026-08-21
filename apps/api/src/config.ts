import { z } from "zod";

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
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  /** absolute or cwd-relative path to the built SPA; when set and present,
   *  the API serves it same-origin with an SPA fallback */
  WEB_DIST_DIR: z.string().optional(),
  /** override the drizzle migrations folder (set in the container image) */
  MIGRATIONS_DIR: z.string().optional(),
  /** honor x-forwarded-* from the platform proxy (Railway, ALB, …) */
  TRUST_PROXY: z.coerce.boolean().default(false),
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().default(300),
  AUTH_RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().default(10),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-opus-5"),
  LOG_LEVEL: z.string().default("info"),
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
  return cfg;
}

export const config = loadConfig();
