# ConstructOS

**An AI-native construction delivery & assurance platform.** ConstructOS pairs Procore-class project execution (drawings, BIM, RFIs, submittals, daily logs, punch, documents, workflow) with something the incumbent structurally cannot build: an owner-side **assurance layer** where every consequential claim is reconciled against independent evidence on an append-only, hash-chained ledger.

Built phase-by-phase against the [master specification](docs/master-specification.md) (1,900+ enumerated functions across Volumes I–III). This repository contains **Phase 0/1: the platform foundation**.

## What's in the foundation

| Area | Capability |
|---|---|
| **Platform substrate** | Multi-tenant companies, JWT auth with refresh rotation, per-tool RBAC (None/Read/Standard/Admin) with permission templates + overrides, segregated assurance roles (integrity reviewer / auditor / regulator), directory (vendors, contacts, users, distribution groups), audit trail |
| **Core object model** | Projects, portfolios, hierarchical locations, cost codes (company standard + project overrides), WBS segments, cross-tool record links, custom fields, comments/@mentions, watchers, tags, auto-numbering |
| **Drawings** | Bulk PDF set upload, sheet splitting with automatic number/title extraction and review queue, revision history with supersession, markups (pen/cloud/text/measure with sheet calibration), personal vs published layers, hyperlinks, pins to RFIs/punch/photos, visual revision compare |
| **BIM & Digital Twin** | IFC model upload + element extraction, ISO 19650 CDE states (WIP→Shared→Published→Archived) with suitability codes, federation groups, coordination issues, asset register (Uniclass-ready) bound to IFC GUIDs, IoT sensor channels with threshold events, warranties, delivery milestones, COBie export |
| **Field tools** | RFIs, submittals with review chains + resubmittal revisions, daily logs (manpower/equipment/deliveries/delays/weather), punch with verifier sign-off, photos with albums + AI tagging |
| **Workflow engine** | Templates with sequential/parallel steps, conditional branching, delegation, due dates, overdue detection, notifications |
| **Assurance layer** | The 8 primitives from spec Vol III §4 — Assertion, Evidence (hashed at ingest), **Reconciliation**, Obligation, Event, Entity graph, Signal, Ledger Entry. Integrity detectors (Benford's law, duplicate/round-number clustering, approval velocity, segregation-of-duties, over-certification), entity shared-identifier scanning, merkle evidence packs, full-chain verification |
| **AI layer** | Claude-powered agents (document search with citations, RFI evaluation, submittal review, daily-log drafting, sheet naming, photo intelligence, assistant) — every run audited, every consequential output routed through a human-in-the-loop review queue |

**Design rule** (from the spec, enforced in code): *an Assertion and the Evidence used to test it must never be created by the same actor through the same pathway.*

## Architecture

pnpm monorepo, TypeScript end-to-end:

```
packages/
  shared/    domain enums, RBAC model, assurance primitive types
  ledger/    hash-chained append-only ledger + merkle proofs (pure, tested)
  db/        drizzle schema — 45 tables across 11 domains + migrations
apps/
  api/       Fastify 5 · zod v4 · drizzle · JWT/RBAC · content-addressed storage
  web/       Vite 8 · React 19 · Tailwind v4 · PDF.js drawing viewer · three.js/web-ifc BIM viewer
docs/        master specification, architecture, data model, roadmap, security, ADRs
```

The API runs against **PostgreSQL** in production and **embedded PGlite** (WASM Postgres) when `DATABASE_URL` is unset — zero-dependency local development and fully isolated in-memory integration tests.

## Getting started

```bash
corepack enable && pnpm install
pnpm build                 # builds packages + apps (topological)
pnpm dev                   # API on :4000 (embedded PGlite) + web on :5173
```

With real Postgres:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://constructos:constructos@localhost:5432/constructos pnpm dev
```

Enable AI features by setting `ANTHROPIC_API_KEY` (see `.env.example`). Without it the platform runs fully; AI endpoints report themselves disabled.

First run: open http://localhost:5173, register with a company name, create a project, upload a drawing set PDF or an IFC model.

### Deploy to production (Railway)

The repo ships a production `Dockerfile` (API + SPA served same-origin from one container, migrations applied automatically at boot) and a `railway.json` that Railway auto-detects. The full operator runbook — Postgres + Bucket provisioning, exact environment variables, hardening checklist, rollback, and common failures — is **[docs/deployment.md](docs/deployment.md)**:

```text
# the short version: one service from this repo + Railway Postgres + a Railway Bucket
AUTH_SECRET   = openssl rand -hex 32          (required — production refuses the dev default)
DATABASE_URL  = ${{Postgres.DATABASE_URL}}    (the PRIVATE url, via Railway reference variable)
STORAGE_DRIVER= s3                            (+ S3_* variables from the bucket)
```

## Verification

```bash
pnpm typecheck   # strict TS across every package
pnpm test        # vitest: ledger chain/merkle + API integration suites on PGlite
pnpm build
```

CI runs all three on every push (`.github/workflows/ci.yml`).

## Documentation

- [Architecture](docs/architecture.md) · [Data model](docs/data-model.md) · [Security](docs/security.md) · [Deployment](docs/deployment.md)
- [Roadmap](docs/roadmap.md) — how the remaining spec volumes phase in
- [ADRs](docs/adr/) — key decisions and their consequences
- [Master specification](docs/master-specification.md) — the complete build reference
