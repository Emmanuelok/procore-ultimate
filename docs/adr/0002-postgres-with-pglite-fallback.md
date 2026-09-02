# ADR 0002 — Postgres in production, embedded PGlite fallback for dev and test

**Status:** accepted (implemented)

## Context

The schema is Postgres-shaped (jsonb bags, bigserial ledger sequence, partial-order
indexes) and the assurance layer needs real transactional semantics — the ledger append
serializes on the chain head inside a transaction (`apps/api/src/lib/ledger.ts`). At the
same time, tests and local development must run with zero external services: CI spins up
nothing, and module agents work in sandboxes without Docker.

## Decision

One drizzle schema (`packages/db/src/schema`, Postgres dialect) and one committed migration
set (`packages/db/drizzle`), two interchangeable backends selected at boot by
`DATABASE_URL` (`apps/api/src/lib/db.ts`):

- **Set:** `postgres-js` against real Postgres 16 (`docker-compose.yml`).
- **Unset:** `@electric-sql/pglite` — WASM Postgres in-process; persisted to `PGLITE_DIR`
  in dev, purely in-memory under `NODE_ENV=test`.

Migrations run automatically at startup in both modes, so a fresh checkout is runnable with
`pnpm dev` and every test gets a fully migrated schema (`apps/api/src/test/helpers.ts`
`buildTestApp()`).

## Consequences

- Integration tests exercise the real SQL dialect, the real migrations and the real auth
  chain via `app.inject()` with no mocks and no services — the entire suite runs in CI on a
  bare Node runner.
- `GET /api/v1/health` reports which backend is live, keeping the distinction observable.
- Known cost — engine drift is real, not theoretical: Postgres/PGlite round-trip
  timestamp formatting differently, which surfaced as false chain-verification breaks and is
  handled by normalizing `at` to ISO-8601 before re-hashing
  (`verifyLedgerNormalized`, `apps/api/src/modules/assurance/index.ts`). Any future
  hash-covered field must be normalized the same way, and production-only behaviour
  (connection pooling, concurrent writers across processes) still needs a Postgres-backed
  test pass before release.
- PGlite is single-connection; anything relying on multi-connection concurrency is untested
  in the default suite.
