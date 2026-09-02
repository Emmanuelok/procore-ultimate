# ConstructOS

**An AI-native construction delivery & assurance platform.** ConstructOS pairs Procore-class project execution (drawings, BIM, RFIs, submittals, daily logs, punch, documents, workflow) with something the incumbent structurally cannot build: an owner-side **assurance layer** where every consequential claim is reconciled against independent evidence on an append-only, hash-chained ledger.

Built phase-by-phase against the [master specification](docs/master-specification.md) (1,900+ enumerated functions across Volumes I–III). Seven phases are delivered: **33 API modules, 153 tables, 40 permission-scoped tools, 870 tests**. Phase 6 completed the Volume III module map by landing **M6 ingestion** and **M11 benchmarking**. **Phase 7 closed the assurance core's last structural gap** — **M1 ledger anchoring & escrow**, so a chain that could previously be truncated or rewritten by whoever ran the database is now sealed against both — and added two Volume II gap domains that no longer belong on the "not started" list (**Domain P insurance & bonding**, **Domain W organisational learning**) plus the Volume I §0.7 event and machine-caller surface (**webhooks**, **OAuth2 clients**, and the completed Procore/Aconex transports). Every caveat travels with the code rather than being buried: the connectors have still never spoken to a live vendor, benchmark seed distributions are labelled illustrative, and a seal made with a key derived from `AUTH_SECRET` says so on its own face. The full accounting is in [docs/roadmap.md](docs/roadmap.md).

## What's in the platform

| Layer | Modules | Capability |
|---|---|---|
| **Platform substrate** | `identity` `directory` `admin` `projects` `notifications` | Multi-tenant companies, JWT auth with refresh rotation, per-tool RBAC (None/Read/Standard/Admin) with templates + overrides, segregated assurance roles, directory with vendor merge, projects/portfolios/locations/cost codes/WBS, cross-tool links, custom fields, comments, watchers, auto-numbering, audit trail |
| **Delivery** | `drawings` `bim` `twin` `documents` `field` `workflow` `schedule` | Bulk PDF sets with sheet splitting and revision supersession, markups/pins/calibration; IFC ingest with ISO 19650 CDE states, federation, coordination issues; asset register bound to IFC GUIDs, sensors, warranties, COBie export; folders/versioning/check-out; RFIs, submittals with review chains, daily logs, punch with verifier sign-off, photos; configurable approval workflows; native CPM schedule with baselines, lookahead and a DCMA-style health check |
| **Commercial** | `commercial` `contracts` `payments` | BoQ as a contractual instrument with taking-off provenance and rate build-ups; valuations certified by someone other than the submitter, landing in the assurance layer as Assertions; variations with basis discipline. Standard-form clause library in code (FIDIC/NEC/JCT) with a Particular Conditions overlay and a live time-bar engine. Five statutory payment regimes (UK/SG/NSW/MY/NZ) with deemed-liability sweeps, suspension and interest |
| **Programme & forensics** | `forensics` | Delay event register with excusable/compensable discipline, Time Impact Analysis by fragnet insertion, as-planned vs as-built, windows attribution (honestly scoped in the payload), prolongation calculator, claims workspace with the cause–effect–entitlement–quantum chain and auto-assembled chronology |
| **Capital & risk** | `governance` `risk` `finance` `disputes` | Five-case business cases with Green Book NPV/BCR and author≠approver; Gateway-style stage gates whose conditions are Obligations; benefits register. Seeded, reproducible Monte Carlo (QCRA/QSRA) with a replay-and-verify endpoint and contingency drawdown discipline. Funding facilities where disbursement is blocked by open conditions precedent and blocked attempts are ledgered; covenant breach signals. Dispute register with procedural-timetable Obligations and Merkle-manifest hearing bundles that a receiving party can verify |
| **Safeguards** | `land` `workforce` `esg` `jurisdiction` | Land parcels with customary/communal tenure, PAP census with cut-off enforcement, compensation that cannot be recorded without payment evidence, a grievance mechanism on published SLAs closed only with the complainant, and land blocking the programme. Worker register with **ghost-worker reconciliation of payroll against independent site-access records**, ILO rights indicators, subcontractor modern-slavery scoring, welfare inspections, audits with CAP obligations. EN 15978 whole-life carbon riding the BoQ with factor provenance, budgets, waste diversion, and social value reconciled tender-promise vs delivered. FIDIC 14.15 currency portions with FX variance, permits blocking the programme, local content/ICV |
| **Assurance** | `assurance` | The 8 primitives from spec Vol III §4 — Assertion, Evidence (hashed at ingest), **Reconciliation**, Obligation, Event, Entity graph, Signal, Ledger Entry. Six statistical detectors (Benford, duplicate/round-number clustering, approval velocity, segregation-of-duties, over-certification) plus 37 more raised directly by the domain modules — deterministic threshold-and-date rules with precision 1.0 by construction (time bars, deemed liability, covenant breaches, ghost workers, grievance SLAs, permit expiry, carbon budgets, lapsed insurance, a broken chain seal …). Entity shared-identifier scanning, Merkle evidence packs, full-chain verification |
| **AI** | `ai` | Language-model agents (document search with citations, RFI evaluation, submittal review, daily-log drafting, sheet naming, photo intelligence, assistant), the model configured by `AI_MODEL` — every run audited, every consequential output routed through a human-in-the-loop review queue that re-checks the target tool's permission |
| **Analytics** | `analytics` | Cross-tool report builder over a **whitelisted dataset registry** (no raw SQL from definitions, ever), saved and shared definitions, live preview, paged execution with honest truncation, CSV export, role dashboards (PM / commercial / assurance), and report schedules that are recorded rather than dispatched — and say so |
| **Ingestion** | `ingestion` | Staged-commit migration and evidence intake: CSV upload **hashed at ingest** → column mapping against a code-resident dataset registry (8 datasets) → validation with a per-row rejection report → explicit, ledgered commit that forward-links every staged row to the real record it created. Dataset-scoped API tokens (SHA-256-stored, shown once) give evidence streams like site access and payroll **a machine pathway the claimant's users do not share** (ADR 0014/0015); re-presented batches raise a duplicate-replay signal; OCDS export with an honest partial-mapping note. The Procore/Aconex connectors carry complete transports since Phase 7 — token exchange, page-walking and mapping, all fixture-tested and none of it ever run against a live vendor, so the first real pull is discovery; unconfigured, the pull still returns 501 naming the exact missing requirements |
| **Benchmarking** | `benchmarks` | Code-resident metric registry (7 cost/schedule/field metrics computed from the project's own records, with the inputs persisted for audit — or an honest 422 naming exactly what is missing), **contribute-to-access** cross-tenant distributions with min-n suppression and always-disclosed sample size, an anonymization boundary contributor ids never cross, adverse-percentile outlier signals, and seed distributions labelled *illustrative — not derived from real project data* on every response that includes them |
| **Evidentiary integrity** | `anchoring` | **Chain sealing, anchoring and third-party escrow (M1).** A seal commits to the ledger's `entryCount` and a Merkle root over every entry hash, signed Ed25519 with a private key that never enters the database, chained to the previous seal so removing one is as visible as editing an entry, and refreshed on a heartbeat so a quiet period cannot hide a truncation. Verification returns one of six named verdicts pointing at the failing seal or entry — not a boolean. Escrow receipts are self-contained and verifiable **offline, with no access to this platform**, by the auditor, lender or regulator holding them |
| **Insurance & bonding** | `insurance` | Insurance programme register with limit basis and conditions precedent, certificate collection as *evidence* against the policy's *assertion*, supply-chain cover-gap analysis, a bond register keyed on the **demand deadline** rather than expiry (the date that actually kills the security), bond calls with the evidence relied on, and claims whose notification deadline is an Obligation — the insurance analogue of a contractual time bar. Cover requirements are inferred from clause references and reported as *unknown* rather than as "no gaps"; money is grouped per currency and never converted; bonding-line headroom is refused because no facility limit exists to divide by |
| **Organisational learning** | `learning` | Lessons-learned capture **triggered by records rather than goodwill** — a dispute closing, a variation crossing a threshold, a confirmed signal each raise an Obligation only a lesson discharges, and a trigger cannot quietly expire. Retrieval is bound to the record being created, with a deterministic ranker that returns the reason for every hit. Applications bind a published lesson to a later record on another project — the only evidence learning crossed a boundary. Post-project reviews compute outturn from platform records and return `null` with reasons where an input is missing |
| **Integrations** | `integrations` | **Webhooks that subscribe to the ledger append path**, so the event catalogue is derived from what the platform actually did rather than from a taxonomy that drifts away from it; envelopes carry identity and hashes, never the record payload, and are HMAC-signed with the delivery id bound in. **OAuth2 client-credentials machine callers** whose scopes are `tool:level` pairs checked by the *same* `requireTool` gate humans pass through — no parallel authorization system, and no client holding more than its creator held |

**Two design rules** (from the spec, enforced in code): *an Assertion and the Evidence used to test it must never be created by the same actor through the same pathway* ([ADR 0004](docs/adr/0004-assertion-evidence-separation.md)) — and where the platform reconciles, the two sides are **separate streams with separate write paths** ([ADR 0014](docs/adr/0014-independent-evidence-streams.md)).

**And one guarantee, stated precisely.** A hash chain is tamper-evident against *edits* and nothing else: whoever controls the database can delete the last N entries (the remainder verifies perfectly) or recompute the whole chain from genesis (so does that). Since Phase 7, both are **detected** — a seal commits to the entry count and to a Merkle root over every entry hash, signed with a key the database does not hold, and seals chain to one another so deleting the one that would have noticed is itself noticed ([ADR 0017](docs/adr/0017-ledger-anchoring-and-escrow.md)). The guarantee is **bounded by key custody**, and the platform says so on every seal it makes: with `ANCHOR_SIGNING_KEY` unset outside production the key is derived from `AUTH_SECRET` and is therefore held by the same operator that runs the application, which proves integrity **against a database-only attacker and not against the operator**. And because `sealedAt` is the app-server clock until a timestamp authority is configured, a seal proves **order, not wall-clock time**. Both limits are carried in the API responses and in [docs/security.md](docs/security.md) §8.2, not only here.

## Architecture

pnpm monorepo, TypeScript end-to-end:

```
packages/
  shared/    domain enums, RBAC model (40 tools), assurance primitive types
  ledger/    hash-chained append-only ledger, merkle proofs, and chain sealing
             (Ed25519 seal bodies + the six-verdict classifier) — pure, tested
  db/        drizzle schema — 153 tables across 29 domains + migrations 0000-0007
apps/
  api/       Fastify 5 · zod v4 · drizzle · JWT/RBAC · content-addressed storage
             33 feature modules + pure engines (CPM, Monte Carlo, FX, carbon,
             workforce reconciliation, the analytics query registry, the
             ingestion dataset registry, benchmark statistics, the insurance
             expiry engine, the learning trigger/relevance/metrics cores,
             webhook signing and OAuth scope resolution)
  web/       Vite 8 · React 19 · Tailwind v4 · PDF.js drawing viewer · three.js/web-ifc BIM viewer
docs/        master specification, architecture, data model, roadmap, security,
             deployment, the retrospective detection run, 18 ADRs
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
pnpm test        # vitest: ledger chain/merkle/seal + API integration suites on PGlite (870 tests)
pnpm build
```

CI runs all three on every push (`.github/workflows/ci.yml`). The spec Vol III §7 detection harness runs separately:

```bash
pnpm --filter @constructos/api eval:retrodetect   # plants known schemes, reports precision/recall
                                                  # unchanged at 17/17 recall, 100% precision
```

An escrow receipt can be checked without this repository running, and without trusting whoever ran it:

```bash
pnpm --filter @constructos/api verify:receipt path/to/receipt.json
```

## Documentation

- [Architecture](docs/architecture.md) · [Data model](docs/data-model.md) · [Security](docs/security.md) · [Deployment](docs/deployment.md) · [Deploy with an agent](docs/deploy-with-cowork.md)
- [Roadmap](docs/roadmap.md) — what is delivered, what remains (with spec section numbers), and the recommended next sequence
- [Retrospective detection run](docs/retrospective-detection.md) — the spec's §7 milestone, its synthetic scope stated honestly
- [ADRs](docs/adr/) — key decisions and their consequences
- [Master specification](docs/master-specification.md) — the complete build reference
