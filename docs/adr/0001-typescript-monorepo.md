# ADR 0001 — One TypeScript monorepo, strict ESM, shared vocabulary packages

**Status:** accepted (implemented)

## Context

The platform spans an API, a SPA, a crypto library and a large relational schema, built by
several agents/engineers concurrently against one specification. The dominant failure mode
at this stage is vocabulary drift: an enum value spelled differently in the database, the
API and the UI; a permission level that means different things on different surfaces. The
spec makes enums load-bearing (lifecycle states are contractual semantics, e.g. ISO 19650
CDE states) and the assurance layer requires the API and the ledger library to agree
byte-for-byte on serialization.

## Decision

- One pnpm workspace (`pnpm-workspace.yaml`), Node ≥ 22, TypeScript 5.9 with `strict`
  everywhere, native ESM with explicit `.js` import extensions.
- Domain vocabulary lives in `packages/shared` (enums, permission model, wire types, the
  eight assurance primitive interfaces) with **zero runtime dependencies**; it is imported by
  the DB schema, the API and the web client. Enum members are stored as text in Postgres, so
  `packages/shared/src/enums.ts` is documented as the single source of truth and renaming a
  member is a data migration, not a refactor.
- Pure logic that must be reproducible for years (canonical JSON, hashing, chain, Merkle)
  is isolated in `packages/ledger` with only `node:crypto` as a dependency.
- Dependency direction is strictly downward: `apps/*` → `packages/*`; packages never import
  from apps; `shared` imports nothing.
- No code generation, no OpenAPI-first: zod schemas in route handlers are the runtime
  contract; TypeScript types flow from drizzle and shared.

## Consequences

- One `pnpm typecheck` / `pnpm test` gate covers every surface (`.github/workflows/ci.yml`);
  a vocabulary change that breaks any consumer fails CI immediately.
- Concurrent module development stays safe: modules share `lib/` helpers and the schema but
  own their folders exclusively.
- Costs accepted: no polyglot options (e.g. a Python analytics service would sit outside the
  type system); ESM `.js` extension discipline is a persistent papercut; publishing
  `packages/ledger` for third-party verification later will require extracting it from the
  workspace cleanly (its zero-dependency design keeps that cheap).
