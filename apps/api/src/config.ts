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
  STORAGE_DIR: z.string().default("./data/storage"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-opus-5"),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return envSchema.parse({ ...process.env, ...overrides });
}

export const config = loadConfig();
