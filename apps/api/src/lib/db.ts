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

/** Arbitrary but stable: the advisory-lock key every replica agrees on for migrations. */
const MIGRATION_LOCK_KEY = 7_290_331_017;

/** Locate the committed drizzle migrations folder (packages/db/drizzle). */
export function migrationsFolder(override?: string): string {
  if (override && existsSync(override)) return override;
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
  const folder = migrationsFolder(cfg.MIGRATIONS_DIR);
  if (cfg.DATABASE_URL) {
    // Migrations run at boot in EVERY replica. Two replicas starting together
    // would race the same DDL; a session-level advisory lock taken on a
    // dedicated single connection (session locks belong to a connection, so
    // it cannot come from the pool) serialises them — the second waits, then
    // finds nothing left to apply.
    const migrator = postgres(cfg.DATABASE_URL, { max: 1 });
    try {
      await migrator`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
      try {
        await migratePostgres(drizzlePostgres(migrator, { schema }), { migrationsFolder: folder });
      } finally {
        await migrator`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
      }
    } finally {
      await migrator.end();
    }
    const client = postgres(cfg.DATABASE_URL, { max: cfg.DATABASE_POOL_MAX });
    const db = drizzlePostgres(client, { schema });
    return { db: db as unknown as Db, close: () => client.end() };
  }
  // Embedded fallback: in-memory for tests, persisted directory otherwise.
  const target = cfg.NODE_ENV === "test" ? undefined : cfg.PGLITE_DIR;
  const client = target ? new PGlite(target) : new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: folder });
  return { db: db as unknown as Db, close: () => client.close() };
}
