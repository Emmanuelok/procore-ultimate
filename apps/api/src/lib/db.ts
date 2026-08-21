import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import { schema } from "@constructos/db";
import type { Config } from "../config.js";

/**
 * Unified database handle. Backed by Postgres in production and by embedded
 * PGlite (WASM Postgres) for zero-dependency local development and tests —
 * the same drizzle schema and SQL dialect run against both.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate the committed drizzle migrations folder (packages/db/drizzle). */
export function migrationsFolder(): string {
  const candidates = [
    path.resolve(here, "../../../../packages/db/drizzle"),
    path.resolve(here, "../../../packages/db/drizzle"),
    path.resolve(process.cwd(), "../../packages/db/drizzle"),
    path.resolve(process.cwd(), "packages/db/drizzle"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    "Drizzle migrations folder not found — run `pnpm db:generate` in packages/db first",
  );
}

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export async function createDb(cfg: Config): Promise<DbHandle> {
  if (cfg.DATABASE_URL) {
    const client = postgres(cfg.DATABASE_URL, { max: 10 });
    const db = drizzlePostgres(client, { schema });
    await migratePostgres(db, { migrationsFolder: migrationsFolder() });
    return { db: db as unknown as Db, close: () => client.end() };
  }
  // Embedded fallback: in-memory for tests, persisted directory otherwise.
  const target = cfg.NODE_ENV === "test" ? undefined : cfg.PGLITE_DIR;
  const client = target ? new PGlite(target) : new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: migrationsFolder() });
  return { db: db as unknown as Db, close: () => client.close() };
}
