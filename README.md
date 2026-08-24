# ConstructOS

**An AI-native construction delivery & assurance platform.** ConstructOS pairs Procore-class project execution (drawings, BIM, RFIs, submittals, daily logs, punch, documents, workflow) with something the incumbent structurally cannot build: an owner-side **assurance layer** where every consequential claim is reconciled against independent evidence on an append-only, hash-chained ledger.

Built phase-by-phase against the [master specification](docs/master-specification.md) (1,900+ enumerated functions across Volumes I–III). Five phases are delivered, and the Volume III module map (M1–M19) is now entered end to end: **29 API modules, 130 tables, 539 tests**. Two modules remain unstarted and are named as such — **M6 ingestion** and **M11 benchmarking** — because the first of them is the difference between an evidentiary product and a very good system of record. The full accounting is in [docs/roadmap.md](docs/roadmap.md).

## What's in the platform

| Layer | Modules | Capability |
|---|---|---|
| **Platform substrate** | `identity` `directory` `admin` `projects` `notifications` | Multi-tenant companies, JWT auth with refresh rotation, per-tool RBAC (None/Read/Standard/Admin) with templates + overrides, segregated assurance roles, directory with vendor merge, projects/portfolios/locations/cost codes/WBS, cross-tool links, custom fields, comments, watchers, auto-numbering, audit trail |
| **Delivery** | `drawings` `bim` `twin` `documents` `field` `workflow` `schedule` | Bulk PDF sets with sheet splitting and revision supersession, markups/pins/calibration; IFC ingest with ISO 19650 CDE states, federation, coordination issues; asset register bound to IFC GUIDs, sensors, warranties, COBie export; folders/versioning/check-out; RFIs, submittals with review chains, daily logs, punch with verifier sign-off, photos; configurable approval workflows; native CPM schedule with baselines, lookahead and a DCMA-style health check |
| **Commercial** | `commercial` `contracts` `payments` | BoQ as a contractual instrument with taking-off provenance and rate build-ups; valuations certified by someone other than the submitter, landing in the assurance layer as Assertions; variations with basis discipline. Standard-form clause library in code (FIDIC/NEC/JCT) with a Particular Conditions overlay and a live time-bar engine. Five statutory payment regimes (UK/SG/NSW/MY/NZ) with deemed-liability sweeps, suspension and interest |
| **Programme & forensics** | `forensics` | Delay event register with excusable/compensable discipline, Time Impact Analysis by fragnet insertion, as-planned vs as-built, windows attribution (honestly scoped in the payload), prolongation calculator, claims workspace with the cause–effect–entitlement–quantum chain and auto-assembled chronology |
| **Capital & risk** | `governance` `risk` `finance` `disputes` | Five-case business cases with Green Book NPV/BCR and author≠approver; Gateway-style stage gates whose conditions are Obligations; benefits register. Seeded, reproducible Monte Carlo (QCRA/QSRA) with a replay-and-verify endpoint and contingency drawdown discipline. Funding facilities where disbursement is blocked by open conditions precedent and blocked attempts are ledgered; covenant breach signals. Dispute register with procedural-timetable Obligations and Merkle-manifest hearing bundles that a receiving party can verify |
| **Safeguards** | `land` `workforce` `esg` `jurisdiction` | Land parcels with customary/communal tenure, PAP census with cut-off enforcement, compensation that cannot be recorded without payment evidence, a grievance mechanism on published SLAs closed only with the complainant, and land blocking the programme. Worker register with **ghost-worker reconciliation of payroll against independent site-access records**, ILO rights indicators, subcontractor modern-slavery scoring, welfare inspections, audits with CAP obligations. EN 15978 whole-life carbon riding the BoQ with factor provenance, budgets, waste diversion, and social value reconciled tender-promise vs delivered. FIDIC 14.15 currency portions with FX variance, permits blocking the programme, local content/ICV |
| **Assurance** | `assurance` | The 8 primitives from spec Vol III §4 — Assertion, Evidence (hashed at ingest), **Reconciliation**, Obligation, Event, Entity graph, Signal, Ledger Entry. Six statistical detectors (Benford, duplicate/round-number clustering, approval velocity, segregation-of-duties, over-certification) plus 26 more raised directly by the domain modules — deterministic threshold-and-date rules with precision 1.0 by construction (time bars, deemed liability, covenant breaches, ghost workers, grievance SLAs, permit expiry, carbon budgets …). Entity shared-identifier scanning, Merkle evidence packs, full-chain verification |
| **AI** | `ai` | Claude-powered agents (document search with citations, RFI evaluation, submittal review, daily-log drafting, sheet naming, photo intelligence, assistant) — every run audited, every consequential output routed through a human-in-the-loop review queue that re-checks the target tool's permission |
| **Analytics** | `analytics` | Cross-tool report builder over a **whitelisted dataset registry** (no raw SQL from definitions, ever), saved and shared definitions, live preview, paged execution with honest truncation, CSV export, role dashboards (PM / commercial / assurance), and report schedules that are recorded rather than dispatched — and say so |

**Two design rules** (from the spec, enforced in code): *an Assertion and the Evidence used to test it must never be created by the same actor through the same pathway* ([ADR 0004](docs/adr/0004-assertion-evidence-separation.md)) — and where the platform reconciles, the two sides are **separate streams with separate write paths** ([ADR 0014](docs/adr/0014-independent-evidence-streams.md)).

## Architecture

pnpm monorepo, TypeScript end-to-end:

```
packages/
  shared/    domain enums, RBAC model (35 tools), assurance primitive types
  ledger/    hash-chained append-only ledger + merkle proofs (pure, tested)
  db/        drizzle schema — 130 tables across 25 domains + migrations
apps/
  api/       Fastify 5 · zod v4 · drizzle · JWT/RBAC · content-addressed storage
             29 feature modules + pure engines (CPM, Monte Carlo, FX, carbon,
             workforce reconciliation, the analytics query registry)
  web/       Vite 8 · React 19 · Tailwind v4 · PDF.js drawing viewer · three.js/web-ifc BIM viewer
docs/        master specification, architecture, data model, roadmap, security,
             deployment, the retrospective detection run, 14 ADRs
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

The repo ships a production `Dockerfile` (API + SPA served same-origin from one container, migrations applied automatically at boot) and a `railway.json` that Railway auto-detects. The full operator runbook — Postgres + Bucket provisioning, exact environment variables, hardening checklist, rollback, and common failures — is **[docs/deployment.md](docs/deployment.md)**; to have an agent drive the deployment for you, follow **[docs/deploy-with-cowork.md](docs/deploy-with-cowork.md)**:

```text
# the short version: one service from this repo + Railway Postgres + a Railway Bucket
AUTH_SECRET   = openssl rand -hex 32          (required — production refuses the dev default)
DATABASE_URL  = ${{Postgres.DATABASE_URL}}    (the PRIVATE url, via Railway reference variable)
STORAGE_DRIVER= s3                            (+ S3_* variables from the bucket)
```

## Verification

```bash
pnpm typecheck   # strict TS across every package
pnpm test        # vitest: ledger chain/merkle + API integration suites on PGlite (539 tests)
pnpm build
```

CI runs all three on every push (`.github/workflows/ci.yml`). The spec Vol III §7 detection harness runs separately:

```bash
pnpm --filter @constructos/api eval:retrodetect   # plants known schemes, reports precision/recall
```

## Documentation

- [Architecture](docs/architecture.md) · [Data model](docs/data-model.md) · [Security](docs/security.md) · [Deployment](docs/deployment.md) · [Deploy with an agent](docs/deploy-with-cowork.md)
- [Roadmap](docs/roadmap.md) — what is delivered, what remains (with spec section numbers), and the recommended next sequence
- [Retrospective detection run](docs/retrospective-detection.md) — the spec's §7 milestone, its synthetic scope stated honestly
- [ADRs](docs/adr/) — key decisions and their consequences
- [Master specification](docs/master-specification.md) — the complete build reference
