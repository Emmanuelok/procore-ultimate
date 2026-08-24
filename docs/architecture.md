# ConstructOS — System Architecture

Engineering reference for the ConstructOS monorepo. Every statement below is grounded in
committed code; file paths are given so claims can be checked against the source. For the
product-level functional inventory see `docs/master-specification.md` (cited throughout as
"spec", with Volume and function numbers).

---

## 1. Product thesis

ConstructOS is two products sharing one data plane:

1. **A Procore-class construction delivery platform** — projects, directory, documents,
   drawings, BIM, RFIs, submittals, daily logs, punch, photos, workflow, notifications
   (spec Vol I, Sections 0–2).
2. **An owner-side assurance layer** — the wedge identified in spec Vol III §1–2: Procore's
   core assertion is *"here is what our users entered"*; the structural gap is *"here is what
   actually happened, and here is where the two diverge."* Reconciliation between a party's
   **Assertion** and independent **Evidence** is the product; everything else is scaffolding
   around the `reconciliations` table (spec Vol III §4, primitive 3).

The two halves are deliberately coupled at one point only: **every consequential mutation on
the delivery side is appended to the tenant's hash-chained evidence ledger**
(`apps/api/src/lib/ledger.ts`), so operational records accrete evidentiary weight as a side
effect of normal use. The assurance primitives (assertions, evidence, reconciliations,
obligations, events, entities, signals, ledger — spec Vol III §4) live in
`packages/db/src/schema/assurance.ts` and are served by `apps/api/src/modules/assurance/`.

Why the incumbent cannot follow (spec Vol III §2): the assurance layer's output is adverse to
the party that pays the incumbent's invoice. ConstructOS is built so the owner, funder,
auditor or regulator is a first-class principal — see the segregated assurance roles in
`packages/shared/src/permissions.ts` (`ASSURANCE_ROLES`) and `docs/security.md`.

---

## 2. Monorepo map

pnpm workspace, Node ≥ 22, TypeScript 5.9 strict ESM throughout (`package.json`,
`pnpm-workspace.yaml`).

| Path | Package | Contents |
|---|---|---|
| `packages/shared` | `@constructos/shared` | Domain vocabulary: enums (`src/enums.ts`), RBAC model + built-in permission templates (`src/permissions.ts`), wire types (`src/types.ts`), the eight assurance primitive interfaces (`src/primitives.ts`). No runtime dependencies. |
| `packages/ledger` | `@constructos/ledger` | Pure crypto core: RFC 8785-style canonical JSON (`src/canonical.ts`), SHA-256 helpers (`src/hash.ts`), hash chain build/verify (`src/chain.ts`), Merkle root/proof (`src/merkle.ts`). Unit-tested in `src/ledger.test.ts`. |
| `packages/db` | `@constructos/db` | Drizzle ORM schema, one file per domain (`src/schema/*.ts`), committed SQL migrations (`drizzle/`). Postgres dialect; no FK constraints — relationships are by convention (see `docs/data-model.md`). |
| `apps/api` | `@constructos/api` | Fastify 5 API. Composition root `src/app.ts`, env config `src/config.ts`, auth plugin `src/plugins/auth.ts`, helpers `src/lib/*.ts` (incl. the pure CPM engine `src/lib/cpm.ts` and the seeded Monte Carlo engine `src/lib/montecarlo.ts`), twenty-nine feature modules `src/modules/*/` (several with their own pure engines — `workforce/reconcile.ts`, `jurisdiction/fx.ts`, `esg/carbon.ts`, `analytics/datasets.ts`), the retrospective-detection harness `src/scripts/retrodetect.ts`, test harness `src/test/helpers.ts`. |
| `apps/web` | `@constructos/web` | Vite 8 + React 19 + Tailwind v4 SPA. Route table `src/App.tsx`, API client `src/lib/api.ts`, auth context `src/lib/auth.tsx`, shared UI kit `src/ui/`, feature pages `src/pages/*/`. Client-side PDF rendering via `pdfjs-dist`, IFC via `web-ifc` + `three`. |
| `docs/` | — | This documentation set plus the master specification. |
| `docker-compose.yml` | — | Postgres 16 for production-like runs. |
| `Dockerfile` / `railway.json` | — | Production image (API + SPA + migrations in one container; see §3 "Production packaging") and Railway build/healthcheck descriptor. Runbook: `docs/deployment.md`. |
| `.github/workflows/ci.yml` | — | CI: pnpm install → `pnpm typecheck` → `pnpm build` → `pnpm test` on Node 22. |

Dependency direction is strictly downward: `apps/*` → `packages/db` / `packages/ledger` /
`packages/shared`; packages never import from apps; `shared` imports nothing.

---

## 3. Runtime topology

```mermaid
flowchart LR
    subgraph Browser
        SPA["React SPA<br/>apps/web (Vite, port 5173)"]
    end
    subgraph API["apps/api (Fastify, port 4000)"]
        AUTH["auth plugin<br/>plugins/auth.ts"]
        MODS["29 feature modules<br/>modules/*/index.ts"]
        LEDGER["appendLedger<br/>lib/ledger.ts"]
        STORE["content-addressed storage<br/>lib/storage.ts"]
    end
    subgraph Data
        PG[("Postgres 16<br/>DATABASE_URL set")]
        PGL[("PGlite (WASM)<br/>DATABASE_URL unset")]
        FS[["STORAGE_DIR<br/>&lt;companyId&gt;/&lt;sha2&gt;/&lt;sha256&gt;"]]
    end
    ANTH["Anthropic API<br/>(optional, ANTHROPIC_API_KEY)"]

    SPA -- "/api proxied by Vite dev server" --> AUTH
    AUTH --> MODS
    MODS --> LEDGER
    MODS --> STORE
    LEDGER --> PG
    MODS --> PG
    MODS -.-> PGL
    STORE --> FS
    MODS -. "modules/ai/service.ts" .-> ANTH
```

- **API process**: `apps/api/src/index.ts` builds the app via `buildApp()` (`src/app.ts`) and
  listens on `PORT`/`HOST` from `src/config.ts`. Body limit 32 MB; multipart uploads up to
  1 GB / 25 files per request (`app.ts`).
- **Database**: one Drizzle schema, two backends (`apps/api/src/lib/db.ts`). With
  `DATABASE_URL` set, `postgres-js` against real Postgres (see `docker-compose.yml`); unset,
  embedded PGlite — persisted to `PGLITE_DIR` in dev, purely in-memory under `NODE_ENV=test`.
  Migrations from `packages/db/drizzle` are applied automatically at startup in both modes.
- **Storage — driver selection**: two content-addressed drivers behind the narrow
  `StorageService` interface, chosen by `STORAGE_DRIVER` at composition time
  (`apps/api/src/app.ts` decorates `app.storage` with one or the other):
  `local` (`apps/api/src/lib/storage.ts`, dev default) writes
  `<STORAGE_DIR>/<companyId>/<sha256[0:2]>/<sha256>`; `s3`
  (`apps/api/src/lib/storage-s3.ts`, production) writes the identical key scheme to any
  S3-compatible store (Railway Buckets, AWS S3, R2, MinIO) via `S3_*` config, recording the
  sha256 as object metadata. Because the key scheme is shared, a stored `storageKey` never
  changes when switching drivers, identical payloads dedupe in both, and the address
  attests to content either way (spec Domain S #862).
- **Web**: the Vite dev server proxies `/api` to the API (`apps/web/vite.config.ts`). In
  production there is no proxy at all — **the API serves the built SPA same-origin**
  (`apps/api/src/app.ts`): when `WEB_DIST_DIR` points at a build, `@fastify/static` serves
  it with hashed `/assets/*` marked `immutable` and `index.html` `no-cache`, and a
  not-found handler falls back to `index.html` for any non-`/api/` GET (client-side
  routing). The SPA's absolute `/api/v1/...` calls therefore need no CORS and no rewrite,
  and helmet's CSP (same file) covers app and API from one origin.
- **Production packaging**: the repo-root `Dockerfile` builds one image containing the
  pruned API bundle, the committed migrations (`/app/migrations`, applied automatically at
  boot by `lib/db.ts`) and the built SPA (`/app/public`), running as non-root `USER node`
  with `TRUST_PROXY=true`. `railway.json` declares the Dockerfile build and the
  `/api/v1/health` healthcheck; the full operator runbook is `docs/deployment.md`.
- **AI**: optional outbound dependency on the Anthropic API, gated on `ANTHROPIC_API_KEY`
  (`apps/api/src/modules/ai/service.ts`); see §24.
- **Health**: `GET /api/v1/health` reports which database backend is live (`app.ts`).

---

## 4. Request lifecycle

Every operational route composes the same preHandler chain, declared as Fastify decorators in
`apps/api/src/plugins/auth.ts` and typed in `apps/api/src/types.ts`:

```mermaid
sequenceDiagram
    participant C as Client
    participant A as authenticate
    participant T as requireCompany
    participant R as requireTool(tool, level)
    participant H as Handler
    participant L as appendLedger

    C->>A: Authorization: Bearer <JWT>
    A->>A: jwtVerify (HS256, jose) → load user, check isActive
    A->>T: req.user set
    C->>T: x-company-id header
    T->>T: companyMemberships lookup → req.companyId, req.companyRole
    T->>R: tenant resolved
    R->>R: project belongs to tenant? → req.projectId
    R->>R: owner/admin bypass, else template + overrides → meetsLevel()
    R->>R: else assurance grant → read-only access
    R->>H: authorized
    H->>H: zod .parse(body/query) — ZodError → 400
    H->>H: DB write, companyId + projectId scoped
    H->>L: append hash-chained entry (same request; failure fails the request)
    H-->>C: response (AppError → typed JSON error envelope)
```

Key properties, all visible in `plugins/auth.ts`:

- **`authenticate`** verifies the bearer JWT (HS256 via `jose`, secret from
  `AUTH_SECRET`), re-loads the user row and rejects deactivated users.
- **`requireCompany`** resolves the tenant from the `x-company-id` header against
  `company_memberships` — a valid token alone never grants tenant access.
- **`requireTool(tool, level)`** (routes carrying `:projectId`) first proves the project
  belongs to the tenant, then resolves the caller's effective permission:
  company owner/admin bypass → project membership template (`permission_templates` row, falling
  back to `BUILTIN_PERMISSION_TEMPLATES` in `packages/shared/src/permissions.ts`) + per-user
  `overrides` → `resolveLevel`/`meetsLevel`. If that fails and the requested level is `read`,
  a live `assurance_grants` row (optionally project-scoped, optionally time-boxed via
  `expiresAt`) grants read-only visibility — auditors see everything, change nothing.
- **`requireCompanyRole` / `requireAssuranceRole`** gate company administration and the
  segregation-of-duties routes respectively (see `docs/security.md` §2–3).
- **Validation** is zod v4 `.parse()` in handlers; the global error handler in `app.ts` maps
  `ZodError` → 400 and `AppError` (`lib/errors.ts`) → its status, and hides 5xx details in
  production.
- **Ledger append** (`lib/ledger.ts`) runs after the operational write, in the same request.
  A failed append fails the request: an unledgered mutation is treated as worse than a
  rolled-back one.

---

## 5. Multi-tenancy model

- The **company** (`companies` table, `packages/db/src/schema/identity.ts`) is the tenant.
  Users are global (`users`) and join tenants through `company_memberships`; a user can belong
  to several companies (spec Vol I #1–2).
- Tenant context is explicit per request (`x-company-id`), never inferred from the token.
- **Every table that stores tenant data carries a `companyId` column, and every query is
  scoped by it** (convention enforced in review; there is no row-level security in the
  database — see `docs/security.md` §3 and §8). Project-scoped tables additionally carry and are
  filtered by `projectId`, which `requireTool` has already proven belongs to the tenant.
- Storage keys are prefixed with `companyId` (`lib/storage.ts`), so blobs are physically
  partitioned per tenant.
- The evidence ledger is **one chain per company** (`ledger_entries.companyId` +
  `prevHash`), so a tenant's history can be exported and verified without reference to any
  other tenant.

---

## 6. Module inventory

Twenty-nine Fastify plugins, each `apps/api/src/modules/<name>/index.ts`, all registered in
`src/app.ts` under the `/api/v1` prefix. "Tool" is the `requireTool` key from
`packages/shared/src/permissions.ts`; tables are from `packages/db/src/schema/`. Sibling
modules are being developed concurrently — the contracts below come from route registration
and schema, not implementation internals.

| Module | Tool gate(s) | Key tables | Representative routes | Spec coverage |
|---|---|---|---|---|
| `identity` | none (public auth) / `authenticate` | `users`, `companies`, `companyMemberships`, `refreshTokens`, `authEvents`, `permissionTemplates` | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /me`, `GET|POST /companies` | Vol I §0.1 #1–2, #4, #13, #26 |
| `directory` | `directory` | `vendors`, `contacts`, `distributionGroups(+Members)`, `companyMemberships` | `GET|POST /vendors`, `POST /vendors/:id/merge`, `/contacts`, `/distribution-groups`, `/company/users` | Vol I §0.1 #7–12 |
| `admin` | `admin`, `requireCompanyRole(["owner","admin"])` | `permissionTemplates`, `projectMemberships`, `assuranceGrants`, `authEvents` | `/permission-templates`, `/projects/:projectId/memberships`, `/assurance-grants`, `/company/auth-events` | Vol I §0.1 #13–17, #26–27 |
| `projects` | `projects` | `projects`, `portfolios`, `locations`, `costCodes`, `wbsSegments`, `recordLinks`, `customFieldDefs/Values`, `comments`, `watchers`, `tags` | `GET|POST /projects`, `/projects/:id/locations`, `/cost-codes`, `/wbs`, `/links`, `/records/:type/:id/{comments,tags,watchers,custom-values}`, `/summary` | Vol I §0.3 #49–78 |
| `documents` | `documents` | `folders`, `files`, `fileVersions`, `fileAccessLog` | `/projects/:id/folders`, `/folders/:id/files` (multipart), `/files/:id/download`, `/files/:id/checkout|checkin`, `/files/:id/versions` | Vol I §2.3 #290–301 |
| `drawings` | `drawings` | `drawingSets`, `drawingSheets`, `drawingRevisions`, `drawingMarkups`, `drawingHyperlinks`, `drawingPins` | `/projects/:id/drawing-sets` (bulk PDF), `/sheets`, `/sheets/log`, `/revisions/:id/{markups,hyperlinks,calibration}`, `/sheets/:id/pins`, `/drawing-files/:fileId/pdf` | Vol I §2.1 #256–282 |
| `bim` | `bim` | `bimModels`, `bimModelVersions`, `bimElements`, `federationGroups(+Members)`, `coordinationIssues` | `/projects/:id/bim/models`, `/bim/models/:id/versions` (IFC upload), `/bim/versions/:id/elements`, `/bim/versions/:id/state` (CDE), `/bim/federations`, `/bim/issues` | Vol I §1.4 #231–248, §2.14 #465–470; Domain L #639–640 |
| `twin` | `twin` | `assets`, `assetElementLinks`, `sensors`, `sensorReadings`, `warranties`, `deliveryMilestones` | `/projects/:id/assets`, `/assets/from-element`, `/sensors/:id/readings`, `/warranties/expiring`, `/delivery-milestones`, `/cobie.{csv,json}` | Domain L #627–632, #635, #639–644, #658–659 |
| `workflow` | `workflow` | `workflowTemplates`, `workflowInstances`, `workflowStepInstances` | `/workflow-templates`, `/projects/:id/workflows/start`, `/workflow-steps/:id/{decide,delegate}`, `/me/workflow-inbox`, `/workflows/overdue` | Vol I §0.4 #79–92 |
| `field` | `rfis`, `submittals`, `daily_logs`, `punch`, `photos` | `rfis`, `submittals`, `submittalReviewSteps`, `dailyLogs`, `punchItems`, `photos` | `/projects/:id/rfis` (+`issue/respond/close/void`, `analytics`), `/submittals` (+review steps, `resubmit`), `/daily-logs/:date` (+`submit/approve`, `missing`), `/punch` (+`status`, `analytics`), `/photos` (+`albums`) | Vol I §2.4 #302–325, §2.5 #326–348, §2.7 #372–397, §2.8 #398–414, §2.10 #426–439 |
| `notifications` | authenticated user | `notifications` | `GET /notifications`, `/unread-count`, `POST /:id/read`, `/read-all` | Vol I §0.5 #93–97 |
| `assurance` | `assurance` + `requireAssuranceRole` on dispositions | `assertions`, `evidence`, `reconciliations`, `obligations`, `events`, `entities`, `entityRelationships`, `signals`, `ledgerEntries` | `/projects/:id/{assertions,evidence,reconciliations,obligations,events,signals}`, `/entities` (+graph, scan), `/projects/:id/detectors/run`, `/projects/:id/evidence-packs`, `/ledger`, `/ledger/verify` | Vol III §4 (all 8 primitives); Domain A detectors subset; Domain S #859, #862, #871–872, #882 |
| `ai` | `ai` (read/standard) | `aiRuns`, `aiReviewQueue` | `/projects/:id/ai/{search,assist,submittal-review,daily-log-draft,rfi-evaluate,sheet-name,photo-intel}`, `/ai/review` (+`approve/reject`), `/ai/runs` | Vol I §6.4 #759–775 subset; Domain X #1019–1021 |
| `commercial` | `commercial` | `boqs`, `boqItems`, `takeoffLines`, `valuations`, `valuationLines`, `paymentCertificates`, `variations` | `/projects/:id/boqs`, `/boqs/:id` (+`summary`), `/boqs/:id/items`, `/boq-items/:id/takeoff` (+`apply`), `/projects/:id/valuations`, `/valuations/:id/{lines,submit,certify}`, `/projects/:id/certificates`, `/projects/:id/variations` (+`status`, `value`), `/projects/:id/commercial/summary` | Vol II Domain B (M7) #115–116, #135–140, #145/149, #162–171, #179–180, #184 seed |
| `contracts` | `contracts` | `contracts`, `contractEvents`, `eotClaims` (+ writes assurance `obligations`, `signals`) | `/contract-forms` (+`/:form/clauses`), `/projects/:id/contracts` (+`status`, `deadlines`), `/contracts/:contractId/events` (+`serve-notice`, `status`), `/contracts/:contractId/eot-claims` (+`status`), `/contracts/:contractId/ld-exposure` | Vol II Domain C (M8) #193–196, #200–204 subset, #214–215, #225–231, #237–238, #249–250, #260 |
| `schedule` | `schedule` | `schedules`, `scheduleTasks`, `scheduleDependencies`, `scheduleBaselines` | `/projects/:id/schedules` (+`activate`, `compute`), `…/schedules/:id/tasks` (+`reorder`), `/schedule-tasks/:taskId`, `…/schedules/:id/dependencies`, `…/baselines` (+`compare`), `…/lookahead`, `…/quality` | Vol I §2.6 #351, #353–361; #371 / Domain D #283 (health check) |
| `forensics` | `forensics` | `delayEvents`, `forensicClaims` (+ reads schedule, contracts, commercial, field, assurance tables) | `/projects/:id/delay-events` (+`status`, `tia`), `/projects/:id/forensics/{as-planned-vs-as-built,windows,prolongation}`, `/projects/:id/claims` (+`status`, `chronology`) | Vol II Domain D (M9) #265, #267–269, #272–273 (scoped), #283, #299, #304–306, #310, #318 |
| `payments` | `payments` (regime library: authenticated only) | `paymentClaims`, `paymentResponses`, `suspensionNotices` (+ writes assurance `obligations`, `signals`) | `/payment-regimes` (+`/:regime`), `/projects/:id/payment-claims` (+`serve`, `respond`, `suspend`, `mark-paid`, `interest`), `/projects/:id/suspension-notices/:id/lift`, `/projects/:id/payments/{deadlines,analytics}` | Vol II Domain F (M10) #358–362, #364–369 subset, #386–387 |
| `risk` | `risk` | `risks`, `riskSimulations`, `contingencies`, `contingencyDrawdowns` (+ writes assurance `signals`) | `/projects/:id/risks` (+`status`, `mitigation-value`), `/projects/:id/risk/simulations/{qcra,qsra}`, `/projects/:id/risk-simulations/:id` (+`rerun`), `/projects/:id/contingencies` (+`drawdowns`, `drawdown-curve`) | Vol II Domain H (M13) #447–450, #452–455, #457–460, #464–471, #473–474 subset |
| `governance` | `governance` | `businessCases`, `stageGates`, `gateReviews`, `benefits`, `benefitReadings` (+ writes assurance `obligations`, `events`) | `/projects/:id/business-cases` (+`options`, `select-option`, `submit`, `approve`, `reject`), `/projects/:id/stage-gates` (+`reviews`), `/gate-reviews/:id/conditions/:id/close`, `/projects/:id/governance/conditions`, `/projects/:id/benefits` (+`readings`) | Vol II Domain G (M12) #394–399, #401–402, #408–409, #412–418, #420 subset |
| `finance` | `finance` | `fundingFacilities`, `facilityConditions`, `disbursements`, `covenants`, `covenantReadings` (+ writes assurance `obligations`, `signals`) | `/projects/:id/facilities` (+`conditions`, `disbursements`, `covenants`, `statement{,.csv}`), `/facility-conditions/:id/{satisfy,waive}`, `/disbursements/:id/{submit,approve,disburse,reject}`, `/covenants/:id/readings`, `/projects/:id/finance/summary` | Vol II Domain O (M14) #729–733, #735, #739–743, #769 subset |
| `disputes` | `disputes` | `disputes`, `disputeSubmissions`, `disputeBundles`, `settlementOffers` (+ writes assurance `obligations`, `signals`) | `/projects/:id/disputes` (+`status`, `timetable/:stepId/complete`, `submissions`, `offers`, `settlement-analysis`), `/dispute-bundles/:id/{items,chronological,generate,verify,issue,manifest.csv}`, `/settlement-offers/:id/status` | Vol II Domain E (M15) #321 partial, #325, #329–330, #334–339, #343–344, #349–352 subset |
| `land` | `land` | `landParcels`, `affectedPersons`, `grievances`, `stakeholders`, `engagements` (+ writes assurance `obligations`, `signals`) | `/land/reference`, `/projects/:id/parcels` (+`status`, `compensate`), `/projects/:id/land/{parcel-summary,schedule-risk,cut-off,rap-progress}`, `/projects/:id/affected-persons` (+`entitlements`, `compensate`, `status`), `/projects/:id/grievances` (+`acknowledge`, `assign`, `resolve`, `verify-closure`, `escalate`, `analytics`), `/projects/:id/stakeholders` (+`matrix`), `/projects/:id/engagements` | Vol II Domain J (M16) #547–559, #561, #564–575, #579–584, #591 subset |
| `workforce` | `workforce` | `workers`, `siteAccessRecords`, `payrollEntries`, `labourRiskFlags`, `welfareInspections`, `labourAudits` (+ writes assurance `obligations`, `signals`) | `/projects/:id/workers` (+`status`), `/projects/:id/{site-access,payroll}` (bulk ingest), `/projects/:id/workforce/{reconcile,reconciliations,vendor-risk}`, `/projects/:id/labour-risk-flags` (+`resolve`), `/projects/:id/welfare-inspections` (+`actions/:id/close`), `/projects/:id/labour-audits` (+`report`, `findings/:id/close`) | Vol II Domain M (M17) #667–677, #683–688, #694, #697–699 subset |
| `esg` | `esg` (factor library: `requireCompany` + company role) | `carbonFactors`, `carbonBudgets`, `carbonEntries`, `wasteRecords`, `socialValueCommitments`, `socialValueDeliveries` (+ writes assurance `signals`) | `/carbon-factors` (+`seed-defaults`, company-scoped), `/projects/:id/carbon-budgets`, `/projects/:id/carbon-entries` (+`from-boq`), `/projects/:id/carbon/{summary,report.csv}`, `/projects/:id/waste-records` (+`waste/summary`), `/projects/:id/social-value` (+`deliveries`, `summary`) | Vol II Domain I (M18) #491–498, #501, #505–508, #513–514, #527–540 subset |
| `jurisdiction` | `jurisdiction` (FX rate register: `requireCompany`) | `currencyConfigs`, `fxRates`, `permits`, `localContentTargets`, `localContentReadings` (+ writes assurance `obligations`, `signals`) | `/fx-rates` (+`latest`, company-scoped), `/projects/:id/currency-configs` (+`split`), `/projects/:id/fx/{convert,exposure}`, `/projects/:id/permits` (+`status`, `conditions/:id/close`, `schedule-risk`), `/projects/:id/local-content-targets` (+`readings`) | Vol II Domain K (M19) #585–591, #593–599, #608, #612–615 subset |
| `analytics` | `requireCompany` + per-report project reach (the `analytics` tool key is reserved in `TOOLS` but the module deliberately does not use `requireTool` — reports cross projects) | `reportDefinitions`, `dashboards`, `reportSchedules` (reads the registered datasets) | `/analytics/datasets`, `/analytics/reports` (+`preview`, `run`, `export.csv`, `schedules`), `/analytics/dashboards` (+`data`, `seed-defaults`) | Vol I §6.1–6.2 #731–733, #735–739, #741–742, #749, #751 |

Shared helpers used by all modules (`apps/api/src/lib/`): `ids.ts` (prefixed nanoid),
`numbering.ts` (atomic per-project record counters, spec #72), `pagination.ts`
(`page`/`pageSize` → `{items,total,page,pageSize}`), `errors.ts`, `ledger.ts`, `storage.ts`.

---

## 7. The evidence ledger

The evidentiary spine (spec Domain S #859; Vol III §4 primitive 8). Three layers:

**1. Canonicalization** (`packages/ledger/src/canonical.ts`). Payloads are hashed over an
RFC 8785-style canonical JSON encoding — sorted keys, `undefined` stripped, finite numbers
only, deterministic across engines — because a hash must be reproducible years later in front
of an auditor.

**2. Hash chain** (`packages/ledger/src/chain.ts`, persisted by `apps/api/src/lib/ledger.ts`
into `ledger_entries`). Each entry's `entryHash` is SHA-256 over its own fields
(`companyId`, `actorId`, `action`, `objectType`, `objectId`, `payloadHash`, `at`) **plus the
previous entry's hash**; the first entry chains from a 64-zero genesis sentinel.

```mermaid
flowchart LR
    G["GENESIS<br/>000…0"] --> E1
    subgraph E1["entry seq=1"]
        direction TB
        p1["prevHash = GENESIS"]
        h1["entryHash = H(prev + fields + payloadHash)"]
    end
    E1 --> E2
    subgraph E2["entry seq=2"]
        direction TB
        p2["prevHash = entryHash(1)"]
        h2["entryHash = H(prev + fields + payloadHash)"]
    end
    E2 --> E3["… entry seq=n"]
```

Properties:

- **Append-only by contract**: rows in `ledger_entries` are never updated or deleted
  (schema comment, `packages/db/src/schema/assurance.ts`); the API exposes no mutating route.
- **Tamper-evident**: editing any historical row breaks every `entryHash` after it;
  `verifyChain` returns the index of the first break. Exposed as
  `GET /api/v1/ledger/verify` (assurance module) and `verifyCompanyLedger` in `lib/ledger.ts`.
- **Concurrency-safe**: appends run in a transaction that reads the current chain head, so
  concurrent writers serialize per company (`lib/ledger.ts`).
- **Payload-optional**: the chain always stores `payloadHash`; the full canonical snapshot is
  stored only when `storePayload: true` (high-value objects, e.g. company creation in
  `modules/identity/index.ts`), keeping the chain lean without weakening it.
- **Every module writes it**: the platform convention is that each create / update /
  state-change / delete of an operational record appends one entry with
  `action ∈ create|update|delete|state_change|access` (`LEDGER_ACTIONS`,
  `packages/shared/src/enums.ts`).

**3. Merkle evidence packs** (`packages/ledger/src/merkle.ts`;
`POST /projects/:projectId/evidence-packs` in the assurance module). A pack commits to a set
of evidence content-hashes under a single Merkle root, with per-leaf inclusion proofs
(odd nodes promoted, not duplicated, so a leaf cannot appear included twice). The root is a
single hash that can be escrowed with a third party or anchored externally — the committed
foundation for spec Domain S #860–861, #874, #882. Self-certification is surfaced on the
obligation path: satisfying an obligation records `selfCertified: ev.submittedBy === req.user.id`
in the ledger payload (`modules/assurance/index.ts`, obligation `/satisfy` route), so a reviewer
can weigh it later.

What the chain does and does not prove is analysed honestly in `docs/security.md` §5.

---

## 8. Drawings pipeline

Upload → extraction → sheet/revision model → markups/pins. All in
`apps/api/src/modules/drawings/` against `packages/db/src/schema/drawings.ts`.

1. **Bulk upload** (`POST /projects/:projectId/drawing-sets`, multipart): the source PDF is
   saved through content-addressed storage into `files`, and a `drawing_sets` row tracks the
   pipeline state machine `pending | processing | ready | failed`.
2. **Text extraction**: `extractPdfPages` (`modules/drawings/index.ts`) renders per-page text
   via `pdfjs-dist` — real text-layer extraction, not OCR of raster scans (scanned-image OCR
   is a known gap; the schema field is future-proofed as `extractedText`).
3. **Sheet detection** (`modules/drawings/detectors.ts`): dependency-free heuristics extract
   the sheet number and title from each page's text stream and classify discipline from the
   number prefix (A→architectural, S→structural, …) — spec Vol I #257–258, #266. Low-confidence
   extractions set `drawing_sheets.needsReview = 1`, feeding the human naming-review queue
   (#258); the AI `sheet_naming` agent (§24) can propose corrections.
4. **Sheet/revision model**: a `drawing_sheets` row is the logical sheet, unique per
   `(projectId, number)`; each upload appends a `drawing_revisions` row (revision label,
   source set, `pageIndex`, extracted text, calibration) and supersedes the previous one
   (`isSuperseded`), while the sheet's `currentRevisionId` enforces current-set visibility
   (#259–261).
5. **Markups** (`drawing_markups`): `MarkupShape[]` JSON (pen/line/arrow/rect/ellipse/cloud/
   text/measure — `packages/shared/src/types.ts`) in **normalized 0..1 sheet coordinates**, so
   they survive re-rendering and revision swaps (#269). Layers are `personal` vs `published`
   (#268) with an explicit publish action. Measurement uses per-revision `calibration`
   (a known real-world distance between two sheet points, #271).
6. **Hyperlinks & pins**: `drawing_hyperlinks` are normalized rectangles linking detail
   callouts between sheets, `manual` or `auto` (#263–264). `drawing_pins` place any record —
   `rfi | punch | observation | photo | inspection` — on a sheet by generic
   `(recordType, recordId)`, keeping the drawings tool decoupled from every other module
   (#272–276).
7. **Serving**: `GET /drawing-files/:fileId/pdf` streams the stored PDF; the web viewer
   (`apps/web/src/pages/drawings/SheetViewerPage.tsx`) renders it client-side with
   `pdfjs-dist` and overlays markups/pins.

---

## 9. BIM / digital-twin pipeline

IFC ingest → elements → CDE states → assets/sensors → COBie. Split across
`modules/bim/` (design-side) and `modules/twin/` (operations-side), schemas
`packages/db/src/schema/bim.ts` and `twin.ts`.

1. **Ingest**: a `bim_models` row per discipline model; each upload creates a
   `bim_model_versions` row (`POST /bim/models/:modelId/versions`) with processing state
   `pending | processing | ready | failed`. Accepted formats per `MODEL_FORMATS`
   (`ifc`, `gltf`, `glb`, `nwd`, `rvt`, `other`); only IFC is parsed server-side today.
2. **Element extraction** (`modules/bim/ifc-extract.ts`): a minimal, dependency-free
   IFC STEP (ISO 10303-21) parser walks the DATA section, matches building-element entity
   types against an allowlist (IFCWALL, IFCSLAB, IFCDOOR, …) and extracts the persistent
   **GlobalId** (22-char IFC GUID) + Name into `bim_elements`. Geometry and property sets are
   intentionally deferred — `properties` remains an empty bag until a full pset pass exists.
   The GlobalId is the identity that survives re-export and is what everything else binds to.
3. **CDE states** (ISO 19650): every model version carries `cdeState`
   (`wip → shared → published → archived`) and a suitability code (`S0…S4, A1, B1, CR`) —
   enums in `packages/shared/src/enums.ts`, transitions via
   `PATCH /bim/versions/:versionId/state` (spec Domain L #639–640; rationale in
   `docs/adr/0006-iso19650-cde-states.md`).
4. **Federation & coordination**: `federation_groups` name a set of model versions viewed
   together (optional per-member transform); `coordination_issues` reference elements by IFC
   GUID list and store a BCF-style camera `viewpoint` (spec #240–241, #465–470).
5. **Twin**: `assets` is the owner-facing register built during construction (spec Domain L
   #627–629) — tag codes unique per project, Uniclass/Omniclass/SFG20 classification, COBie-
   aligned `attributes` bag, lifecycle `planned → installed → commissioned → operational →
   decommissioned`. `asset_element_links` bind assets to geometry by GlobalId
   (`POST /projects/:id/assets/from-element` promotes a model element to an asset).
   `sensors` + `sensor_readings` attach IoT channels with min/max alert thresholds (#658–659);
   `warranties` and `delivery_milestones` (MIDP/TIDP tracking, #632, #635, #642–644) complete
   the handover record.
6. **COBie export**: `GET /projects/:projectId/cobie.{csv,json}` generates the handover
   deliverable from the live register (spec #630).
7. **Viewer**: the web model viewer (`apps/web/src/pages/bim/ModelViewerPage.tsx`) parses IFC
   client-side with `web-ifc` and renders with `three` — the server never needs a geometry
   pipeline for the foundation build.

---

## 10. Commercial engine (M7)

Measurement & valuation (spec Vol II Domain B), the first Tier-2 module. Routes in
`apps/api/src/modules/commercial/` (`boqs.ts`, `valuations.ts`, `variations.ts`,
`summary.ts`), schema `packages/db/src/schema/commercial.ts`, web UI
`apps/web/src/pages/commercial/` (tabbed page: BoQ / Valuations / Certificates / Variations).
The design premise is the spec's: the BoQ is a **contractual measurement instrument**, not an
import format — so every quantity has provenance and every certified value becomes a
reconcilable claim.

```mermaid
flowchart LR
    TO["takeoff_lines<br/>timesing × L × W × D<br/>drawingSheetId provenance"] -- "takeoff/apply<br/>qty = Σ lines" --> BQI["boq_items<br/>bill > section > item<br/>rate build-up sheet"]
    BQI --> V["valuations<br/>lines: qty or % to date"]
    V -- "submit (submittedBy)" --> C["certify — different user,<br/>commercial admin level"]
    C --> PC["payment_certificates<br/>variance vs application"]
    PC -- "netCertified" --> A["assertions (kind: cost)<br/>assurance layer"]
    VAR["variations<br/>bq_rates | pro_rata |<br/>star_rate | daywork"] --> SUM["commercial/summary<br/>CVR seed: forecastFinal"]
    BQI --> SUM
    PC --> SUM
```

1. **BoQ hierarchy** (#115–116): `boqs` carries a declared method of measurement
   (`nrm2 | smm7 | cesmm4 | pomi | custom` — metadata, not a rules engine yet) and a
   forward-only lifecycle `draft → issued → agreed`; an agreed BoQ is immutable. `boq_items`
   form a `bill > section > item` tree via `parentId` + materialized `path` (small BQs may
   hang items directly off a bill — a documented relaxation of #116). Item types cover
   measured, provisional (defined/undefined), prime cost, prelims fixed/time-related,
   daywork, contingency and spot items (`BOQ_ITEM_TYPES`).
2. **Rate build-up** (#145, #149): an item's rate may be a build-up sheet of
   labour/material/plant/overhead/profit components (`rateBuildUp` jsonb). The item rate is
   Σ component amounts, and an explicit rate disagreeing by more than 0.01 is a 400
   (`resolveRate`, `boqs.ts`) — the build-up is the audit trail for the rate, so they must
   reconcile.
3. **Taking-off provenance** (#135–140): `takeoff_lines` are dimension-sheet rows
   (`timesing × length × width × depth`, manual overrides recorded with `isManual`), each
   optionally citing the `drawingSheetId` it was measured from (validated against the
   project's drawing register). `POST /boq-items/:id/takeoff/apply` sets the item quantity
   to Σ of its lines — after which the quantity is traceable drawing → dimension → bill item.
4. **Valuation** (#162–167): a valuation snapshots one line per BQ leaf item, seeded from the
   latest *certified* valuation of that BoQ. Each line takes exactly one of `qtyToDate`
   (remeasure × BQ rate, #163) or `percentToDate` (% × BQ item amount, #164);
   `recomputeValuation` (`valuations.ts`) derives work done, retention, materials on/off
   site, previous net and `netDue`. Submission stamps `submittedBy` — that identity is
   load-bearing for the next step.
5. **Certification** (#179–180): `POST /valuations/:id/certify` requires `commercial`
   **admin** and rejects the valuation's own submitter (403) — see
   `docs/adr/0008-certification-independence.md` and `docs/security.md` §2.4. The
   certificate persists the certifier's determination *and* the variance from the
   application with its reason (#180). In the same transaction the certified net value is
   written into the assurance layer as an `assertions` row
   (`kind: "cost"`, `sourceType: "payment_certificate"`) — **a certificate is a claim to be
   reconciled against independent evidence, not a fact**. This is the delivery→assurance
   bridge for money, the exact hook Phase-2/Tier-1 reconciliation work consumes.
6. **Variations** (#168–171): lifecycle `proposed → instructed → valued → agreed` with
   basis discipline — `bq_rates` demands the exact BQ item rate (±0.01, else the API tells
   you to use a `star_rate` fair valuation), `pro_rata` requires BQ item references,
   `star_rate`/`daywork` are fair-valuation bases. The valuation build-up is ledgered with
   full payload — the rate-derivation audit trail of #171.
7. **Commercial summary** (#184 seed): `GET /projects/:id/commercial/summary` rolls up BoQ
   total, certified to date, retention held (latest certificate per BoQ), variation
   register position and `forecastFinal` — the CVR seed, deliberately no more than that
   (full CVR/WIP is roadmap, `docs/roadmap.md`).

Sub-resource routes without `:projectId` (e.g. `/boqs/:boqId`) resolve the owning project
from the record and re-run the same `requireTool("commercial", …)` gate
(`requireCommercialLevel`, `modules/commercial/shared.ts`) — no permission short-cut through
the flat URLs. Money rounds to 2 dp, measured quantities to 3 dp (`round2`/`round3`).

---

## 11. Contract intelligence (M8)

Spec Vol II Domain C. Routes in `apps/api/src/modules/contracts/index.ts`, clause library in
`modules/contracts/clause-library.ts`, schema `packages/db/src/schema/contracts.ts`, web UI
`apps/web/src/pages/contracts/` (register with 30-day time-bar radar; detail page with
Overview / Clauses / Events / EOT tabs).

```mermaid
flowchart LR
    LIB["CLAUSE_LIBRARY (code)<br/>8 forms, timeBarDays,<br/>standingObligation"] -- "clausesForForm ⊕<br/>particularConditions" --> EFF["effectiveClauses<br/>(amended flagged)"]
    EV["contract_events<br/>kind + clauseRef + eventDate"] -- "findClause →<br/>eventDate + timeBarDays" --> DL["noticeDeadline"]
    DL --> OBL["obligations<br/>deadline + warnDaysBefore"]
    DL -- "served in time" --> OK["notice_served<br/>obligation satisfied"]
    DL -- "sweep: deadline past" --> TB["time_barred<br/>obligation breached"]
    TB --> SIG["signals<br/>time_bar_missed (critical)"]
    OK -- "served late" --> SIG2["signals<br/>time_bar_breach_risk (high)"]
```

1. **Clause library in code** (#193–196, #203, #214–215): `CLAUSE_LIBRARY` is a typed
   constant — FIDIC Red 1999/2017, Yellow 2017, Silver 2017, NEC3/NEC4 ECC, JCT SBC/DB 2016
   (plus `bespoke`, which by definition has no library clauses). Each `ClauseDef` carries a
   summary, category, notice party, an optional `timeBarDays` (set **only** where the form
   itself imposes a day-counted deadline from the event/awareness date — FIDIC 20.2's 28
   days, NEC 61.3's 56 days) and an optional `standingObligation`. It is reference data, not
   tenant data — rationale in `docs/adr/0007-contract-clause-library-in-code.md`. Served
   read-only at `GET /contract-forms` and `/contract-forms/:form/clauses`.
2. **Particular Conditions overlay** (#201–202): per-contract amendments live in
   `contracts.particularConditions` (`[{clauseRef, amendment}]`). The contract detail
   response computes `effectiveClauses` = library ⊕ overlay, flagging amended clauses —
   amendments are visible against the standard form, never silently replacing it.
3. **Obligation materialization** (#260): creating a contract inserts one assurance
   `obligations` row per `standingObligation` clause of its form (programme submission,
   certification duties, payment duties, early-warning duty …) — the contract obligation
   register and the assurance layer are the same table, not a mirror.
4. **Time-bar engine** (#225–231): creating a `contract_events` row whose `clauseRef`
   resolves to a time-barred clause computes `noticeDeadline = eventDate + timeBarDays` and
   materializes a deadline `obligations` row (`warnDaysBefore` for early warning, per
   spec #229). `GET /projects/:id/contracts/deadlines` is the time-bar radar (soonest
   first, `daysRemaining` signed). Serving notice (#227–228) records method
   (email/letter/portal/registered post), reference and timestamp, satisfies the obligation
   — and if served after the deadline, raises a high-severity `time_bar_breach_risk` signal
   without un-breaching the register. A lazy sweep (`sweepTimeBars`) marks open events whose
   deadline fully elapsed as `time_barred`, breaches the linked obligation and raises a
   critical `time_bar_missed` signal, exactly once (#230).
5. **EOT claims** (#237–238): lifecycle `notified → submitted → assessed →
   agreed | rejected | referred`, claims cite clause and supporting event ids. Assessment
   requires `daysAwarded` and **must not be performed by the user who raised the claim**
   (403 — `docs/security.md` §2.4). Agreement of an assessed award moves the contract
   completion date forward by the awarded days, with the movement ledgered against the
   claim as cause.
6. **LD exposure** (#249–250): `GET …/ld-exposure` computes accrued liquidated damages from
   `ldRatePerDay` × days past completion, capped at `ldCap` with `capReached` flagged — a
   live read model, nothing persisted.

Every consequential mutation (contract create/patch/status, event create/serve/status,
EOT transitions, time-bar sweeps) appends to the evidence ledger, so the notice history that
decides a claim's survival is itself tamper-evident (§7).

---

## 12. Schedule core & CPM

Spec Vol I §2.6 subset, built in Phase 3 as the substrate the delay-forensics module (§13)
runs on. Engine `apps/api/src/lib/cpm.ts` (+ `cpm.test.ts`), routes
`apps/api/src/modules/schedule/index.ts`, DCMA-style health check
`modules/schedule/quality.ts`, schema `packages/db/src/schema/schedule.ts`, web workspace
`apps/web/src/pages/schedule/` (editable task table + dependency editor, pure-SVG Gantt
with baseline ghost bars/critical bars/float whiskers, baseline-compare, lookahead and
health panels).

1. **The engine is pure** — `computeCpm(tasks, deps, {projectStart})` does no I/O and is
   unit-tested against hand-computed textbook networks (`lib/cpm.test.ts`). Its conventions
   are the module's law (see `docs/adr/0009-cpm-engine-and-persisted-dates.md`):
   time is whole days from `projectStart` (day 0); a task occupies `[start, start + d)` —
   the **finish is exclusive internally**, which keeps dependency math uniform
   (FS: `succ.ES = pred.EF + lag`), while the reported `finishDate` is the **inclusive**
   last day of work (`= startDate` for zero-duration milestones). All four dependency
   types (FS/SS/FF/SF, `DEPENDENCY_TYPES`) with positive or negative lag (leads).
   Constraints (`TASK_CONSTRAINT_TYPES`): `start_no_earlier_than` bounds the forward pass,
   `must_start_on` pins both passes (and can create **negative float — a real signal, not
   an error**), `finish_no_later_than` caps the late finish and goes negative when
   breached. Actuals pin the passes: `actualStart` pins ES, `actualFinish` pins EF and
   overrides duration. Dependency cycles abort the computation and report the member ids.
2. **Computed dates are persisted, not derived on read.** `recomputeSchedule`
   (`modules/schedule/index.ts`) is the single recompute code path: it runs the engine and
   persists per-task `startDate`/`finishDate`/`totalFloat`/`isCritical` plus the schedule
   header's `computedFinish`/`computedDurationDays`/`lastComputedAt`. It is called after
   **every** task/dependency mutation (and by the explicit `POST …/compute`), so stored
   dates are never stale — and reads (lists, Gantt, forensic comparisons) never pay a live
   CPM pass. Trade-off analysis in ADR 0009.
3. **Cycles cannot be persisted**: creating a dependency runs the engine over
   existing + candidate *before* the insert and returns 409 naming the cycle members —
   a link that cannot schedule never lands. (A cycle can still be *reported* defensively
   by the compute summary; the recompute path then leaves existing dates untouched.)
4. **Baselines are immutable snapshots** (#355–357): `scheduleBaselines.snapshot` stores
   every task's computed dates/float/criticality at capture time (capture forces a fresh
   recompute first). `GET …/baselines/:id/compare` reports per-task start/finish variance,
   float change, critical-path churn (`becameCritical`/`droppedCritical`), added/removed
   tasks and the headline `completionMovementDays` — the as-planned record forensic
   comparisons run against.
5. **Progress & lookahead** (#358–361, #359): `percentComplete` + actuals on the task
   (validated: finish ≥ start, finish requires start); `GET …/lookahead?weeks=N` returns
   incomplete tasks starting/finishing inside the window.
6. **Health check** (#371 / Domain D #283): `GET …/quality` runs
   `assessScheduleQuality` — a pure DCMA-14-point-style subset of ten checks (missing
   predecessors/successors with the schedule start/finish excluded, leads, lags, FS ratio
   ≥ 90%, hard constraints, high float > 44d, negative float, high duration > 44d,
   invalid progress) with documented thresholds, per-check offending ids and an overall
   score.

Not built (deliberately): XER/MPP import (#349–350), resource loading (#370), calendars —
durations are calendar days; working-calendar arithmetic is future work the pure engine
was shaped to absorb.

---

## 13. Delay & disruption forensics (M9)

Spec Vol II Domain D, the first forensic module — the one Procore's own customer cannot
ask its vendor for (Domain D's classification note). Routes
`apps/api/src/modules/forensics/index.ts`, pure analysis helpers `tia.ts` and
`prolongation.ts` (both unit-tested), schema `packages/db/src/schema/forensics.ts`, web UI
`apps/web/src/pages/forensics/` (Delay Events / Analysis / Claims tabs).

```mermaid
flowchart LR
    DE["delay_events<br/>cause + excusable/compensable<br/>evidenceIds, contractEventId"] -- "taskId = fragnet<br/>insertion point" --> TIA["runFragnetTia<br/>before vs after CPM"]
    TIA -- "completionDeltaDays<br/>persisted on event" --> WIN["windows attribution<br/>by start date"]
    BSL["schedule_baselines"] --> APAB["as-planned vs as-built<br/>per-task slip"]
    DE --> CLM["forensic_claims<br/>cause-effect-entitlement-quantum"]
    PRO["prolongation calculator<br/>prelims_time BQ ÷ programme days"] --> CLM
    PLAT["contract events, RFIs,<br/>daily-log delays, variations"] -- "chronology<br/>auto-assembly" --> CLM
```

1. **Delay event register** (#265–268): numbered per project (`nextRecordNumber`), cause
   classified over `DELAY_CAUSES` (client change, late design information, exceptional
   weather, unforeseen ground, statutory, contractor performance, subcontractor default,
   supply chain, force majeure, other), entitlement classified excusable/compensable with
   the rule **compensable ⇒ excusable enforced as a 400** (#267). Events cite the contract
   event (notice) raised for them and assurance `evidenceIds` substantiating them (#306) —
   both validated to belong to the project. A bare `taskId` resolves against the project's
   active schedule and the resolved `scheduleId` is stored, so the fragnet insertion point
   is stable even if the active schedule later changes.
2. **Time Impact Analysis by fragnet insertion** (#272): `POST …/delay-events/:id/tia`
   models the delay as a virtual fragnet task inserted after the struck task
   (`struck --FS--> fragnet --FS--> each successor`), carrying `start_no_earlier_than` on
   the delay's real-world start date; original logic is preserved and the fragnet path
   competes with (and, when the delay bites, dominates) existing paths (`tia.ts`). The
   result — `completionDeltaDays`, before/after finish — is persisted on the event
   (`tiaResult`) and ledgered; editing the delay's dates or insertion point voids the
   stale TIA (`tiaResult` nulled on those PATCHes). Because the engine is pure and dates
   are persisted, the run is reproducible from the row + the ledger entry.
3. **As-planned vs as-built** (#269): `GET …/forensics/as-planned-vs-as-built` compares a
   captured baseline (default: the earliest — the closest thing to the as-planned
   programme) against current tasks, preferring **actuals over forecast dates** per task,
   reporting per-task start/finish slip and the headline `totalSlipDays`.
4. **Windows attribution** (#273 — honestly scoped): `GET …/forensics/windows` buckets
   delay events into caller-supplied window boundaries **by event start date** and sums
   excusable/compensable/non-excusable days and per-event TIA deltas per window. The
   response carries its own `method` string stating the limitation verbatim: this is
   *attribution of events to windows quantified by per-event TIA against the current
   programme*, **not** a full retrospective windows TIA with per-window schedule updates
   and critical-path re-analysis (#274–275 are not built). The honest label is in the API
   payload, not just the docs.
5. **Prolongation calculator** (#299 seed): `POST …/forensics/prolongation` computes
   compensable days × time-related prelims rate; the rate is explicit or derived from the
   project's `prelims_time` BQ items spread over the programme duration
   (`prolongation.ts`), with the derivation string returned. Head-office overhead formulae
   (#301 Hudson/Emden/Eichleay) are deliberately out of scope.
6. **Claims workspace** (#304–320 subset): numbered claims over `CLAIM_KINDS`
   (delay/disruption/prolongation/acceleration) with the four-limb
   **cause–effect–entitlement–quantum chain** (#305) as a structured `chain` object,
   supporting `delayEventIds` (validated), claimed vs assessed days/amounts and lifecycle
   `draft → submitted → assessed → agreed | rejected` (withdrawn pre-agreement). The chain
   and event set **freeze once the claim leaves draft** — the submitted narrative is the
   narrative that gets assessed — and **assessment rejects the claim's creator (403)**
   (#310; `docs/security.md` §2.4). `POST …/claims/:id/chronology` (#318) auto-assembles
   a dated chronology from platform records — delay events, contract events + notice
   service, RFIs raised/answered, daily-log delay entries, instructed variations — and
   caches it on the claim with its generation time.

Every mutation is ledgered (delay-event creation and claim creation with full payload),
which is the point: the Tier-2 acceptance criterion is a delay analysis assembled solely
from ledgered contemporaneous records, and the chronology assembler reads exactly those.

**Scope note.** This is the Domain D *foundation*: SCL-Protocol method selection (#276–277),
concurrency/pacing/float-ownership (#278–281), programme-revision forensics (#284–288),
measured mile and the disruption family (#289–298), and claim packaging beyond the chain +
chronology (#307–309, #311–320) are not built — the boundary is drawn function-by-function
in `docs/roadmap.md`.

---

## 14. Statutory payment security (M10)

Spec Vol II Domain F — the security-of-payment regimes that govern most of the
Commonwealth and Asia, where a missed response deadline creates real liability. Routes
`apps/api/src/modules/payments/index.ts`, regime library
`modules/payments/regimes.ts`, schema `packages/db/src/schema/payments.ts`, web UI
`apps/web/src/pages/payments/` (regime reference cards, claim register with deadline
radar and deemed-liability surfacing, analytics, and a claim drawer with the statutory
timeline and state-driven actions).

```mermaid
flowchart LR
    LIB["REGIME_LIBRARY (code)<br/>5 regimes: response + payment<br/>day counts, deemed rules"] -- "computeTimeline<br/>base = max(referenceDate, served)" --> TL["responseDeadline<br/>finalPaymentDate"]
    CLM["payment_claims<br/>draft → served"] --> TL
    TL --> OBL["obligations<br/>deadline + warnDaysBefore 3"]
    TL -- "on-time response" --> OK["responded<br/>obligation satisfied"]
    TL -- "sweep: deadline past,<br/>no response" --> DM["deemed<br/>obligation breached"]
    DM --> SIG["signals<br/>payment_deemed_liability (critical)"]
    OK -. "late response" .-> SIG2["signals<br/>late_payment_response (high)"]
    DM --> SUS["suspension notice<br/>effectiveFrom = today + notice days"]
```

1. **Regimes in code** (#364–369 subset): `REGIME_LIBRARY` is a typed constant covering
   UK HGCRA 1996/2011, Singapore SOPA 2004, NSW SOPA 1999, Malaysia CIPAA 2012 and NZ CCA
   2002 — the same reference-data-not-tenant-data decision as the Phase 2 clause library
   (ADR 0007), argued for this domain in
   `docs/adr/0010-statutory-payment-regimes-in-code.md`. Each `RegimeDef` carries one
   response deadline and one final payment date (day count + calendar/business basis), a
   suspension notice period, a pinned interest rate with the true statutory formula in
   `interestNote`, and a `deemedRule` narrative — including the CIPAA divergence, where
   "deemed" marks an adjudication-ready *dispute*, not automatic liability. The
   simplifications (no public-holiday calendars; single-base-date model; pinned rates) are
   documented in the file header and per-regime comments, and the library is served
   read-only at `GET /payment-regimes`. `libraryCoversAllRegimes()` keeps the enum and
   library from drifting (asserted in tests).
2. **Timeline computation** (#359–360): serving a claim
   (`POST …/payment-claims/:id/serve`) computes both statutory clocks via
   `computeTimeline` from a single base date — the **later** of the statutory
   `referenceDate` and the service date, so a clock never starts before service and an
   early claim waits for its reference date. Business-day regimes count Mon–Fri
   (`addBusinessDays`). Served claims are immutable; only drafts can be edited.
3. **Obligation materialization — the same pattern as time bars** (§11.4): service
   inserts an assurance `obligations` row for the response deadline (`warnDaysBefore: 3`)
   and stores its id on the claim, so the payment clock and the obligation register agree
   on one date. On-time responses satisfy it; the sweep or a late response breaches it;
   payment moots an *open* obligation only — **a breached obligation stays breached; the
   register records what happened**.
4. **Deemed sweep** (#361): `sweepDeemed` runs lazily on reads (list, radar, analytics,
   claim detail) and before suspension — a served claim whose response deadline has fully
   elapsed with no response on file flips to `deemed`, breaches its obligation and raises
   a **critical `payment_deemed_liability` signal** whose explanation embeds the regime's
   `deemedRule`, exactly once (guarded on the status flip). A **late** response never
   rescues status: it is recorded with `late: 1`, breaches the obligation and raises a
   high `late_payment_response` signal — statutory ineffectiveness, surfaced.
5. **Ground-stating** (#365): a pay-less notice for less than the claimed amount without
   stated reasons is a 400 — withholding without grounds is exactly what these statutes
   exist to prevent.
6. **Suspension & interest** (#362, #387): suspension is available on deemed claims only
   (a documented simplification — suspension for non-payment past the final date is not
   modelled), with `effectiveFrom` = today + the regime's notice period; lifting returns
   the claim to `deemed` (the liability is unaffected). `GET …/interest` computes simple
   ACT/365 interest at the regime's modelled rate on the outstanding amount — the latest
   *on-time* response amount where one exists, else the claimed amount (late responses do
   not reduce the base) — with the derivation and the statutory formula note in the
   response.
7. **Analytics** (#386): status mix, average served→paid days, the outstanding book
   (valued at on-time response amounts where they exist) and deemed exposure
   (deemed + suspended — suspension does not extinguish the liability).

Not built: liens (#373–377), retention trusts / project bank accounts (#378–381),
adjudication case management (Domain E #329–333 — the `referred` claim status exists in
the enum with no workflow behind it), pay-when-paid validity (#382), supply-chain payment
reporting (#385, #388–391). See `docs/roadmap.md` and the disclaimer in ADR 0010: the
library is an engineering model of the statutes, not jurisdictional legal advice.

---

## 15. Quantitative risk (M13)

Spec Vol II Domain H — the probabilistic discipline Procore does not have ("Cost certainty
in major projects is a probabilistic discipline and Procore is deterministic", Domain H
preamble). Engine `apps/api/src/lib/montecarlo.ts` (+ `montecarlo.test.ts`), routes
`apps/api/src/modules/risk/index.ts`, distribution wire-format validation and analytic
means in `modules/risk/distributions.ts`, schema `packages/db/src/schema/risk.ts`, web UI
`apps/web/src/pages/risk/` (register with 5×5 heatmap, quantification drawer, pure-SVG
simulation charts — histogram, S-curve percentiles, tornado — and the contingency
drawdown curve).

```mermaid
flowchart LR
    REG["risks<br/>P×I scores pre/post +<br/>occurrenceProbability,<br/>costImpact / durationImpact"] -- "quantified subset" --> QCRA["runQcra<br/>total-cost distribution"]
    REG -- "scheduleTaskId links" --> QSRA["runQsra<br/>CPM per iteration<br/>(lib/cpm.ts)"]
    SEED["seed + iterations"] --> QCRA
    SEED --> QSRA
    QCRA --> SIM["risk_simulations<br/>seed + input snapshot +<br/>results, ledgered"]
    QSRA --> SIM
    SIM -- "rerun: replay snapshot,<br/>deep-equal percentiles" --> VER["reproduced: true/false"]
    SIM -- "P50/P80/P90" --> CTG["contingencies<br/>confidenceLevel + simulationId"]
    CTG --> DD["contingency_drawdowns<br/>over-draw refused (409)"]
    DD -- "crosses 20% remaining" --> SIG["signals<br/>contingency_exhaustion (high)"]
```

1. **The engine is pure, seeded and deterministic** (`lib/montecarlo.ts`): all randomness
   flows from a caller-supplied seed through a mulberry32 PRNG, so same inputs + seed ⇒
   bit-identical percentiles — the property that makes a P80 defensible in front of a gate
   review or an auditor. Six distribution kinds (`DISTRIBUTION_KINDS`): triangular, PERT
   (Marsaglia–Tsang beta), uniform, normal (Box–Muller), lognormal, discrete — the spec's
   three-point estimating (#459) and distribution selection (#460). Full rationale in
   `docs/adr/0011-seeded-monte-carlo.md`.
2. **Risk register** (#447–455 subset): numbered risks over six categories (#449),
   qualitative pre/post-mitigation 1–5 scoring (#450) with derived `preScore`/`postScore`,
   owner assignment (#452), mitigation actions with cost (#453). Quantification is
   optional per risk: `occurrenceProbability` + `costImpact` distribution for QCRA;
   `scheduleTaskId` (validated against the project's schedules) + `durationImpact` for
   QSRA (#455). `GET …/risks/:id/mitigation-value` (#454) compares mitigation cost to the
   analytic expected value (`analyticMean`, no sampling), scaling post-mitigation EV by
   the qualitative score ratio — a documented proxy, stated in the response's `method`.
3. **QCRA** (#458, #465–466): per iteration, each risk occurs with its probability and
   samples its impact; totals are summarized to mean/stdDev/percentiles/histogram.
   Per-risk expected value, occurrence share and |correlation with total| give the tornado
   ranking (#466). `contingencyAt` reports P50/P80/P90 (#465, #469).
4. **QSRA rides the CPM engine** (#457, #467–468): task duration distributions come from
   linked risks (applied unconditionally — occurrence probability is a QCRA concept, a
   documented simplification) with per-request `taskUncertainties` overrides; each
   iteration runs `computeCpm` over the sampled network. Outputs: completion-duration
   distribution mapped to ISO completion dates per percentile, criticality index (#467)
   and duration sensitivity (#468) per task. This is the payoff of ADR 0009's pure engine
   — thousands of CPM passes per request, no I/O.
5. **The reproducibility endpoint** (#464): every run persists seed + full input snapshot
   + results to `risk_simulations` and is ledgered with its headline percentiles.
   `POST …/risk-simulations/:id/rerun` replays the snapshot and reports whether fresh
   percentiles deep-equal the stored ones, ledgering the verification — the audit answer
   to "prove that P80". A failed rerun means tampering or engine drift, both of which
   deserve surfacing.
6. **Contingency drawdown discipline** (#469–474): contingencies cite the confidence level
   and simulation they were set from (#469), separate management reserve from risk
   contingency (#474), and refuse over-draws (409 with the arithmetic). Drawdowns cite the
   realised risk (#470), are ledgered with full payload, and build the cumulative
   drawdown-curve read model (#471 — actuals only; a planned curve is not modelled). The
   draw that crosses 20% remaining raises a high `contingency_exhaustion` signal, exactly
   once (#473). A contingency with recorded drawdowns cannot be deleted.
7. **The honest limitation, in the payload**: correlation between risks is **not**
   modelled (#461–462 out of scope) — independent sampling understates spread under
   positive correlation, so every QCRA/QSRA result carries `correlationModelled: false`
   for UIs and reports to surface. The Iman–Conover rank-correlation stage is the named
   roadmap item (ADR 0011).

---

## 16. Capital governance (M12)

Spec Vol II Domain G — the owner-side instruments ("Public clients and development finance
institutions run on exactly these instruments", Domain G preamble). Routes
`apps/api/src/modules/governance/index.ts`, pure appraisal mathematics in
`modules/governance/appraisal.ts` (+ `appraisal.test.ts`), schema
`packages/db/src/schema/governance.ts`, web UI `apps/web/src/pages/governance/` (Business
Cases / Stage Gates / Benefits tabs).

1. **Five-case business cases** (#394–395): `business_cases` carry the HM Treasury
   five-case narratives (strategic/economic/commercial/financial/management) through the
   SOC → OBC → FBC stages (`BUSINESS_CASE_STAGES`) and a `draft → submitted →
   approved | rejected` lifecycle. An approved/rejected case is immutable; stage and
   appraisal changes are draft-only.
2. **The CBA math lives in `modules/governance/appraisal.ts`** — pure, unit-tested, no
   I/O: per-option `capexAdjusted = capex × (1 + optimism-bias %)` (uplift applied to
   capex only, the dominant Green Book case — #402, documented in the file), discounted
   present values of annual benefit/cost series, NPV and BCR (#398–399), simple
   undiscounted payback. The discount rate defaults to 3.5% — the Green Book social time
   preference rate — and is configurable per case (#401). The server owns the computed
   block: options are appraised on write (`PUT …/options`), a draft-only appraisal change
   recomputes every stored option, and the counterfactual is a first-class flag (#397).
   Approval requires a preferred option and **a decider who is not the author** (403 —
   `docs/security.md` §2.4).
3. **Stage gates & reviews** (#408–414): Gateway 0–5-style gates (unique per project
   gate number) with criteria; a review must return findings covering **every** criterion
   (400 listing what is missing), a RAG delivery-confidence rating over the five-point
   scale (#414), and a decision from `GATE_DECISIONS`
   (`proceed | proceed_with_conditions | hold | stop`). Every review is retained — the
   decision register (#412) — and a `stop` lands in the assurance `events` graph as a
   project-level `gate_stop` event.
4. **Gate conditions → obligations** (#413): each condition of approval materializes an
   assurance `obligations` row at review creation (`warnDaysBefore: 7`); closing the
   condition satisfies the obligation, and `GET …/governance/conditions` is the
   open-conditions radar across all gates, soonest due first (#415 seed). One
   deadline primitive across the platform — `docs/adr/0012-conditionality-as-obligations.md`.
5. **Benefits register** (#416–418, #420): numbered benefits with owner, measurement
   method, baseline/target/date; disbenefits are direction-aware negatives (#420 —
   the signed-denominator progress formula in `appraisal.ts` handles reduction targets).
   Realisation readings recompute status against documented thresholds
   (`planned → tracking → realised / at_risk / missed`), transitions are ledgered, and
   moves into `at_risk`/`missed` notify the benefit owner.

---

## 17. Disbursement & conditionality (M14)

Spec Vol II Domain O — "Procore models cost. It does not model money — where it comes
from, on what conditions, and what happens when conditions are breached" (Domain O
preamble). Routes `apps/api/src/modules/finance/index.ts`, schema
`packages/db/src/schema/finance.ts`, web UI `apps/web/src/pages/finance/` (facility
register, facility detail with conditions/disbursements/covenants, covenant headroom
chart, evidence picker).

```mermaid
flowchart LR
    FAC["funding_facilities<br/>lender + instrument +<br/>category limits"] --> CP["facility_conditions<br/>precedent / subsequent<br/>→ obligations"]
    CP -- "sweep: dueDate past" --> BR["breached<br/>+ high signal"]
    CP -- "satisfy WITH evidenceIds" --> OK["satisfied<br/>obligation satisfied"]
    DR["disbursements<br/>draft"] -- "submit" --> GATE{"any CP<br/>open/breached?"}
    GATE -- "yes: 409 + snapshot<br/>+ ledgered attempt" --> DR
    GATE -- "no: snapshot + headroom<br/>checks pass" --> SUB["submitted"]
    SUB -- "approve: admin,<br/>not the requester" --> APP["approved"] --> DSB["disbursed"]
    COV["covenants + readings<br/>computed compliant/headroom"] -- "breach" --> SIG["signals<br/>covenant_breach (critical)"]
```

1. **Facility register** (#729, #739–741): facilities per lender and instrument
   (`FACILITY_INSTRUMENTS`: loan/grant/equity/guarantee/blended) with allocation
   categories whose limits may not exceed the committed amount (#739), closing-date
   monitoring (`daysToClosing`, #741) and live aggregates (disbursed, undisbursed,
   per-category remaining). A category with non-rejected requests against it cannot be
   removed.
2. **Conditions precedent/subsequent, obligation-backed** (#730–731): every condition
   materializes an assurance `obligations` row (ADR 0012). A lazy sweep
   (`sweepOverdueConditions`, run on reads and before every conditionality check) flips
   overdue open conditions to `breached`, breaches the obligation and raises a high
   `facility_condition_overdue` signal, exactly once. **Satisfaction requires evidence**:
   `/satisfy` demands at least one validated assurance `evidence` id (#731) — a condition
   is discharged by pointing at documents, not by asserting it. Late satisfaction unblocks
   the pipeline but never un-breaches the obligation; only an explicit **waiver**
   (finance `admin`, reason required, ledgered) supersedes a breach.
3. **The CP gate on submission — the module's core rule** (#733–734 subset): a
   disbursement request assembles expenditure evidence (#732) as a draft, and `/submit`
   first re-sweeps, then verifies **no condition precedent on the facility is open or
   breached**. The verification is snapshotted onto the request either way
   (`conditionality: {verifiedAt, openConditions[]}`) — the record shows what was checked
   and when. A blocked submission is a 409 listing the open CPs **and is itself ledgered**
   (`submit_blocked_by_conditionality`): attempted circumvention is on the record. A
   passing submission then enforces headroom — the pipeline (submitted + approved +
   disbursed) may exceed neither the committed amount nor a category limit.
4. **Approval workflow with separation of duties**: approve/reject require finance
   **admin** and the approver must not be the request's creator (403 —
   `docs/security.md` §2.4); disbursing requires an approved request. Every transition is
   ledgered with payload.
5. **Statement of expenditure** (#735, #769 seed): `GET …/facilities/:id/statement{,.csv}`
   renders the numbered request history with totals — the SoE the lender's reporting cycle
   consumes.
6. **Covenant breach signals** (#742–743): covenants are threshold tests
   (`gte`/`lte`); readings compute `compliant` and **signed headroom** (negative = depth
   of breach) at write time. A breaching reading raises a **critical `covenant_breach`
   signal** explaining the test, the headroom and the draw-stop consequence. Covenants are
   deliberately not obligations — a continuous test, not a dated duty (ADR 0012). The
   project `finance/summary` rolls up committed/disbursed/undisbursed, per-category
   positions, open conditions and worst-case covenant status.

Not built (see `docs/roadmap.md`): #734 World Bank/ADB/AfDB withdrawal-application
formats, #736–738 designated-account reconciliation and eligibility classification,
#744–751 LTA/independent-engineer certification and finance modelling, #752–756 PPP
models, #757–768 equity/procurement-compliance/fiduciary tracking. Covenant reading
values are operator-entered — the ratio itself is not yet derived from platform records.

---

## 18. Dispute support (M15)

Spec Vol II Domain E — "The moment a project turns contentious — precisely when the
record matters most — the platform is abandoned" (Domain E preamble). Routes
`apps/api/src/modules/disputes/index.ts`, pure settlement arithmetic in
`modules/disputes/settlement.ts`, schema `packages/db/src/schema/disputes.ts`, web UI
`apps/web/src/pages/disputes/` (register with next-deadline radar; dispute drawer with
Timeline / Submissions / Bundles / Settlement tabs; bundle builder).

1. **Dispute register across forums** (#321 partial, #329, #334–337): numbered disputes
   over `DISPUTE_KINDS` (adjudication, DAAB, mediation, arbitration, expert
   determination, litigation) with forum and institutional-rules fields (#337), linked
   contract, referred forensic claims (validated — the M9 claims workspace feeds
   directly in), a counterparty from the assurance entity graph, and amount in dispute.
   The escalation ladder is forward-only
   (`notified → referred → submissions → hearing → decided`, settle/withdraw from any
   live state); recording a decision requires an outcome (#349 partial).
2. **Timetable obligations** (#325, #330, #338): every dated procedural step materializes
   an assurance `obligations` row (`warnDaysBefore: 3` — dispute clocks are short;
   ADR 0012). Timetable edits keep obligations in step (new deadline → materialize;
   moved → update; removed → waive). A lazy sweep breaches overdue undone steps —
   obligation breached, high `dispute_deadline_missed` signal explaining why missed
   procedural deadlines are fatal in adjudication — exactly once, guarded by the step's
   `breachedAt` marker. Completing a step satisfies an *open* obligation only: a breach,
   as everywhere on the platform, stays on the register.
3. **Pleadings register** (#339): submissions typed over `SUBMISSION_KINDS` (referral,
   response, reply, rejoinder, witness statement, expert report, decision, award) per
   party, dated, optionally file-backed.
4. **Merkle-manifest bundles + verify — the evidentiary integrity story applied to
   production** (#343–344): a draft bundle assembles items from platform records (RFIs,
   delay events, contract events, forensic claims, assurance evidence) or stored files;
   `/chronological` sorts by date (#344). **Generation freezes the bundle**: sequential
   tab numbers, a per-item content hash — file-backed items reuse the content-addressed
   `files.sha256` (§4 of `docs/security.md`), record-backed items hash the record's
   canonical JSON (`hashPayload`, `@constructos/ledger`) — and a **Merkle root over the
   hashes** (`merkleRoot`, the same primitive as evidence packs, §7). The manifest is the
   tamper-evident commitment to exactly what was produced to the tribunal, exportable as
   the hyperlinked-index CSV (#343). `POST …/verify` recomputes every item hash from
   today's files/records and the root from the manifest, reporting per-tab mismatches —
   so the receiving party's question "is this bundle what the record said it was?" has a
   mechanical answer, and the check itself is ledgered. Issuance is a state change on a
   generated (frozen) bundle only.
5. **Settlement offers & modelling** (#350–352): an offer register over
   `SETTLEMENT_OFFER_BASES` (open / without prejudice / WP save as to costs — #351's
   bases recorded, its costs-consequence engine not built); accepting a received offer
   settles the dispute with the amount in the outcome, ledgered. The expected-value
   analysis (`settlement.ts`, pure and unit-tested) compares
   `winProbability × expectedAward − legalCosts` against the best open received offer
   and states its recommendation with the arithmetic in the rationale (#352).

---

## 19. Land, resettlement & community (M16)

Spec Vol II Domain J — *"this is a category of work Procore has no concept of"*, and
frequently the single largest source of delay on internationally financed infrastructure.
Routes `apps/api/src/modules/land/` (`parcels.ts`, `paps.ts`, `grievances.ts`,
`engagement.ts`, shared helpers `shared.ts`, code-resident reference data `reference.ts`),
schema `packages/db/src/schema/land.ts`, web workspace `apps/web/src/pages/land/` (RAP
dashboard / Parcels / Affected households / Grievances / Stakeholders). The compliance
frame is IFC Performance Standard 5 and World Bank ESS5, named in the module header.

```mermaid
flowchart LR
    PAR["land_parcels<br/>tenure incl. customary,<br/>communal, informal"] -- "blockingTaskIds" --> SR["land/schedule-risk<br/>tasks starting on<br/>un-acquired land"]
    SR -- "≤ 30 days out" --> SIG["signals<br/>land_blocks_programme (high)"]
    PAR -- "compensate:<br/>evidenceIds REQUIRED" --> PAID["compensated<br/>ledgered w/ payload"]
    PAP["affected_persons<br/>census + vulnerability<br/>+ entitlement matrix"] --> PAID
    CUT["cut-off date<br/>(project settings, admin)"] -- "census after cut-off<br/>= encroachment (400)" --> PAP
    GRV["grievances<br/>severity → SLA"] --> OBL["obligations<br/>resolveDueAt, warn 2d"]
    OBL -- "sweep: SLA elapsed" --> BR["breached + signal<br/>grievance_sla_breach"]
    GRV -- "resolve → verify-closure" --> VER{"complainant<br/>satisfied?"}
    VER -- "yes" --> CLOSED["closed_verified"]
    VER -- "no" --> REOPEN["back to investigating"]
```

1. **Parcel register with real tenure** (#547–551): `land_parcels` carries a cadastral
   `reference` (unique per project), area, owner (optionally an assurance `entities` id),
   encumbrances and — the point — a `tenureType` from `TENURE_TYPES` that includes
   `customary`, `communal` and `informal`. A title-only model cannot represent the majority
   of land on the projects this module exists for. Status moves along an explicit
   transition table (`PARCEL_TRANSITIONS`, `reference.ts`): `identified → surveyed →
   under_negotiation → agreed → … → acquired`, with `disputed` reachable and an illegal
   move refused with the allowed set named.
2. **Compensation cannot be asserted, only evidenced** (#553–554): `compensated` is
   unreachable through the status route (400 telling you which route to use). The only path
   is `POST …/parcels/:id/compensate` (and its PAP twin), which requires **at least one
   validated assurance `evidence` id** — a bank transaction, a signed receipt, a
   beneficiary-verified payment record — merges them onto the parcel and ledgers the
   payment with full payload. Same rule, same reason as lender-condition satisfaction
   (§17.2): a payment to a displaced household is discharged by pointing at documents.
3. **PAP census with a cut-off that bites** (#555–557, #564–566): `affected_persons` holds
   the household census, `vulnerabilities[]` screening (elderly, disabled, female-headed,
   landless, indigenous, below poverty line, child-headed) that drives enhanced
   entitlements under PS5, the socio-economic `baseline` bag (#556), the entitlement matrix
   as `entitlements[]` with a server-recomputed `compensationTotal`, and displacement
   classified `physical | economic | both | none` (#565). The **cut-off date** is declared
   once per project (`POST …/land/cut-off`, `land` **admin**, stored in project settings)
   and a census dated after it is a 400 — *"households recorded after the cut-off are
   encroachment, not project-affected persons"*. That single rule is the classic
   compensation-fraud vector on a resettlement programme, closed in code.
4. **Land blocking the programme** (#591): a parcel lists the `blockingTaskIds` it stands
   under. `GET …/land/schedule-risk?days=N` joins those ids to the project's schedule tasks
   and returns every works package due to start on land the project does not hold, soonest
   first with `daysUntilStart` signed. Anything inside 30 days raises a high
   `land_blocks_programme` signal, idempotent per `(parcelId, taskId)` carried in
   `evidenceRefs`, whose explanation names the exposure (trespass, injunction, lender
   non-compliance) — the same read-model-plus-signal shape as the contract time-bar radar
   (§11.4). `land/rap-progress` rolls the two registers into the supervision view a lender's
   E&S mission asks for: parcels and PAPs by status, physical vs economic displacement,
   vulnerable households, and compensation committed vs paid.
5. **The grievance mechanism is SLA-driven and obligation-backed** (#569–574): intake over
   eight channels including genuinely anonymous — an anonymous grievance has its
   complainant name and contact **stripped at intake**, not merely hidden, so they cannot
   leak through a later read or a ledger payload. Severity selects the published service
   standard (`GRIEVANCE_SLA` in `reference.ts`: critical 1/7 days, high 2/14, medium 3/30,
   low 5/45, each with its rationale), which computes `acknowledgeDueAt`/`resolveDueAt` and
   materializes an assurance `obligations` row for the resolution deadline
   (`warnDaysBefore: 2`) — ADR 0012's primitive again. A lazy sweep breaches overdue
   grievances exactly once (obligation breached + `grievance_sla_breach` signal). **Closure
   is verified with the complainant** (#573): `POST …/verify-closure` moves a resolved
   grievance to `closed_verified` only when `complainantSatisfied` is true; a rejection
   reopens it to `investigating`, nulls `resolvedAt` and ledgers
   `closure_rejected_reopened` with the rejected resolution. `…/grievances/analytics`
   is #574 — by type, location, severity and time.
6. **Stakeholders & engagement** (#575, #579–584): the register with 1–5 influence/interest
   scores mapped to quadrants (`…/stakeholders/matrix`), and the consultation log carrying
   attendance, feedback with its disposition (#582), attached files and an FPIC
   `consentStatus` (`pending | granted | conditional | refused`, #575).

Not built (Domain J remainder): #552 compulsory-purchase process management, #558's full RAP
document lifecycle and #568 independent monitoring/completion audit as workflow, #560 ESS5
as a distinct tracked frame, #562–563 replacement housing and resettlement-site delivery,
#567 replacement-cost verification, #576–578 indigenous peoples plans and cultural-heritage
chance finds, #592 regulator correspondence. Permits (#585–590) live in the jurisdiction
module (§22) because they share the permit/consent clock.

---

## 20. Workforce rights & welfare (M17)

Spec Vol II Domain M — *"Procore tracks labour as cost and hours. It does not track labour
as people with rights."* Routes `apps/api/src/modules/workforce/index.ts`, pure engines
`modules/workforce/reconcile.ts` (age verification, reconciliation, vendor scoring — all
unit-testable without a database), schema `packages/db/src/schema/workforce.ts`, web
workspace `apps/web/src/pages/workforce/` (Worker register / Payroll reconciliation /
Rights indicators / Subcontractor risk / Welfare / Labour audits).

```mermaid
flowchart LR
    PAY["payroll_entries<br/>employer's CLAIM<br/>daysClaimed, grossPay"] --> REC["reconcileWorkforce<br/>(pure)"]
    ACC["site_access_records<br/>INDEPENDENT stream<br/>turnstile / biometric"] --> REC
    REC -- "0 evidenced days" --> G["signals: ghost_worker (critical)"]
    REC -- "> 1.15× evidenced" --> O["signals: payroll_overclaim (high)"]
    REC -- "rate < 0.95× agreed" --> U["signals: wage_underpayment (high)"]
    FLAG["labour_risk_flags<br/>10 ILO indicators"] --> VR["vendor-risk<br/>100-pt composite"]
    G --> VR
    O --> VR
    AUD["labour_audits<br/>findings + CAP dates"] --> OBL["obligations<br/>warn 7d → labour_cap_overdue"]
    WEL["welfare_inspections<br/>8 scored areas"] --> WS["signals: welfare_standard_failure,<br/>accommodation_overcrowding"]
```

1. **The flagship: ghost-worker reconciliation** (#669, #677). Two streams, two write
   routes, two authors — the design law of `docs/adr/0014-independent-evidence-streams.md`.
   `payroll_entries` is the employer's *claim* (`daysClaimed`, `grossPay`, `submittedBy`,
   optional Gulf `wpsReference` per #676); `site_access_records` is the *independent
   evidence* (one row per worker per date, unique on `(workerId, accessDate)`, tagged
   `turnstile | biometric | manual | gate_log`). Both ingest in bulk (up to 5000 rows,
   addressable by `workerId` or `workerReference`). `POST …/workforce/reconcile` runs the
   pure engine over a period and classifies each worker:

   | Classification | Test | What it means |
   |---|---|---|
   | `ghost` | pay claimed, **zero** evidenced days | the whole gross pay is value at risk |
   | `overclaim` | claimed days > 1.15 × evidenced days (`OVERCLAIM_TOLERANCE`) | unmatched days × the implied daily rate is value at risk |
   | `underpaid` | implied daily rate < 0.95 × the agreed rate (`UNDERPAYMENT_TOLERANCE`) | the wage shortfall is money owed *to* the worker (#677) |

   Conditions are evaluated independently (a worker can be both overclaimed and underpaid)
   while the table shows the worst single label — because a ghost and an underpaid worker
   are different wrongs with different remedies. Findings become `ghost_worker` (critical),
   `payroll_overclaim` and `wage_underpayment` (high) signals, idempotent per
   `(detector, workerId, period)`, and the run is ledgered with its totals.
   `GET …/workforce/reconciliations` replays the identical engine and **writes nothing**
   (`persisted: false`) so a reviewer can look without changing the record. The engine's
   own header states its false negatives: a ten-minute swipe counts as a day present, and
   period-edge payroll is counted whole — which is why the 1.15× tolerance is deliberately
   generous.
2. **Child labour is a blocked write, not a report** (#670): enrolling or patching a worker
   whose date of birth puts them under `MINIMUM_WORKING_AGE` (18, ILO C138) is refused —
   *and the refused attempt raises a critical `underage_worker_blocked` signal first*, so
   the attempt is on the record even though the row never lands.
3. **Rights indicators drive severity, not the reporter** (#671–675, #694): a
   `labour_risk_flags` row names an indicator from `LABOUR_RISK_INDICATORS` (recruitment fee
   paid, passport retained, contract substituted, wage withheld, excessive overtime, no rest
   day, underage, no contract in language, movement restricted, debt bondage) against a
   worker or an employer, sourced `audit | worker_report | detector | inspection`. Severity
   is derived from the indicator (`CRITICAL_LABOUR_INDICATORS` — passport retention, debt
   bondage, underage, movement restriction are treated as direct forced-labour evidence
   under the ILO framework), never from who filed it. Every flag raises a
   `labour_rights_indicator` signal and stores the signal id back on the flag.
4. **Modern-slavery scoring at subcontractor level** (#694): `…/workforce/vendor-risk`
   ranks employers on a documented 100-point composite — open flags (45, weighted 12
   critical / 6 other), reconciliation findings (25, 6 per ghost / 3 per overclaim),
   contract-issuance coverage (18, #674) and identity verification (12, #667) — with every
   component returned alongside the score and band (`low | medium | high | critical`). The
   weights are the author's calibration, not a published standard, and the response says so.
   A vendor with no workers scores 0: an empty denominator must not manufacture risk.
5. **Welfare inspections are scored and consequential** (#683–688): eight areas
   (`WELFARE_INSPECTION_AREAS` — accommodation, sanitation, catering, potable water,
   transport, heat stress, PPE, medical) scored 1–5 with notes and photo ids. Occupancy
   above the operator's own declared capacity raises a high `accommodation_overcrowding`
   signal with the arithmetic (#684); any area at or below 2 raises
   `welfare_standard_failure` and demands a dated corrective action.
6. **Audits with corrective-action plans on the obligation clock** (#697–699): audits are
   scheduled per vendor (`isUnannounced` for #698) and reported once. **Every finding with
   a CAP due date materializes an assurance `obligations` row** (`warnDaysBefore: 7`,
   evidence requirement stated) — ADR 0012 again — and a lazy sweep breaches overdue CAPs
   exactly once, guarded by the finding's own `capBreachedAt` marker, raising
   `labour_cap_overdue`. Closing a finding satisfies an *open* obligation only.

Not built (Domain M remainder): #678–682 minimum-wage/overtime/rest-day/deduction-legality
rule engines by jurisdiction and late-payment escalation, #689–693 the employer-independent
grievance channel and worker voice (the community GRM in §19 is not it — an
employer-independent worker channel needs its own identity path), #695–696 ILO/PS2
compliance mapping as a tracked frame, #700 lender KPI reporting, #701–702 independent
fatality reporting and statistical under-reporting detection, #703–704 demographic,
turnover and skills analytics.

---

## 21. Carbon, ESG & social value (M18)

Spec Vol II Domain I — carbon reporting is becoming a contractual condition in the UK, EU
and Gulf, and social value is a *scored tender criterion* in UK public procurement. Routes
`apps/api/src/modules/esg/index.ts`, pure calculation core `modules/esg/carbon.ts` (unit
conversion, `computeTco2e`, budget drawdown bands, waste diversion, commitment status,
the seed factor library), schema `packages/db/src/schema/esg.ts`, web workspace
`apps/web/src/pages/esg/` (Carbon / Waste / Social value / Factors).

1. **EN 15978 life-cycle modules are the accounting spine** (#491–492): every
   `carbon_entries` row is attributed to a `lifecycleModule` from `CARBON_MODULES`
   (`A1-A3` product, `A4` transport, `A5` construction, `B1-B7` in use, `C1-C4` end of
   life, `D` beyond the boundary) and optionally to a GHG-Protocol `scope`
   (`scope_1 | scope_2 | scope_3`, #505–508). `…/carbon/summary` reports `byModule` and
   `byScope` side by side — the RICS whole-life split and the GHG split are different cuts
   of the same rows, not different data.
2. **Factor provenance is a first-class measure of the assessment's maturity** (#496–498).
   `carbon_factors` is tenant reference data (company-scoped, gated on company role rather
   than a project tool level) with `source ∈ epd | ice_database | generic | supplier |
   custom`, an `isProductSpecific` flag and an `epdReference`. The summary returns
   **`productSpecificSharePercent`** — the share of the reported footprint standing on a
   product-specific EPD rather than a generic library figure — and the code says why in as
   many words: *a low number is not an error; it is the honest maturity of the
   assessment.* `POST /carbon-factors/seed-defaults` seeds an ICE-database-derived starter
   set so a project is not blocked on library curation.
3. **Carbon rides the BoQ** (#501). `POST …/carbon-entries/from-boq` takes mappings of
   `{factorId, boqItemId | codePrefix}`, walks the bill's items, and generates A1-A3 /
   scope-3 entries with the `boqItemId` recorded as provenance and units checked through
   `normaliseUnit`/`unitsMatch` (so `m³`/`m3`/`cum` agree and a genuine mismatch still
   fails). Items that cannot be converted are **skipped and reported with a reason**, never
   silently guessed: a carbon figure with no quantity behind it is worse than a missing one.
   This is the same provenance discipline as taking-off → BQ quantity (§10.3), applied to
   emissions: the carbon model is a view of the commercial model, not a parallel
   spreadsheet.
4. **Budgets with drawdown and an exceedance signal** (#494–495): `carbon_budgets` hold a
   baseline and target in tCO2e per element; `budgetDrawdown` bands the position
   (`on_track` < 80%, `at_risk` 80–100%, `exceeded` > 100%, with a non-positive target
   treated as instantly exceeded by any emission), and crossing the target raises
   `carbon_budget_exceeded` exactly once. The summary also reports `unbudgetedTco2e` —
   unattributed emissions are as material as attributed ones — and `intensityPerSqm`
   (kgCO2e/m² GIA, the RICS reporting unit) when the project's GIA is set.
5. **Waste with the number that is actually audited** (#513–514): movements by
   `WASTE_STREAMS` × `WASTE_DESTINATIONS` with tonnage, carrier and duty-of-care
   consignment note. `wasteDiversion` computes diversion-from-landfill and, separately, the
   narrow `recycledPercent` — with the taxonomy boundary documented: energy-from-waste
   belongs in `recovered`, so `incinerated` is counted as diverted and a site that books it
   wrongly gets a flattering number it can be challenged on.
6. **Social value: tender promise against delivery** (#527–540). `social_value_commitments`
   are numbered per project, themed over the UK Social Value Model (`SOCIAL_VALUE_THEMES`,
   PPN 06/20) with an optional TOMs `measureRef`, a unit, a target and an optional
   `proxyValuePerUnit` for proxy financial valuation (#538). Deliveries are separate rows
   carrying their own dates and assurance `evidenceIds`, and the commitment's
   `deliveredValue` and `status` are recomputed server-side by `commitmentStatus`:
   delivered at or above target whatever the date; `at_risk` past due and under 70%;
   **`shortfall`** past due + 30 days and still short — which raises
   `social_value_shortfall`. #539's reconciliation is the whole point of the sub-module:
   the tender score was bought with the promise, and the shortfall is the number the
   client's compliance team asks for.

Not built (Domain I remainder): #493 PAS 2080 as a tracked frame, #497 EPD ingestion and
verification as a pipeline (the reference field exists; parsing EPD documents does not),
#499–500 design-option comparison and marginal abatement cost, #502–504 transport carbon
from supplier location, site energy and plant emissions by equipment hours, #509–511 SBTi,
offsets and operational carbon handover, #512 water, #515–516 material passports and reuse,
#517–526 biodiversity, environmental monitoring/incidents/permits/ISO 14001 and
BREEAM/LEED credit tracking, #529–537 the individual social-value measure families beyond
the generic commitment/delivery model, #541–546 CSRD/ESRS, IFRS S1/S2, EU Taxonomy, TCFD,
Modern Slavery Act statements and CSDDD due diligence.

---

## 22. Multi-jurisdiction operations (M19)

Spec Vol II Domain K — *"Procore is a single-currency, single-tax-regime system with locale
skins on top. Internationally financed projects run three or four currencies simultaneously
with contractual exchange mechanics."* Routes
`apps/api/src/modules/jurisdiction/index.ts`, pure FX engine `modules/jurisdiction/fx.ts`,
schema `packages/db/src/schema/jurisdiction.ts`, web workspace
`apps/web/src/pages/jurisdiction/`.

1. **Contractual currency portions, not a converter** (#593–595). A `currency_configs` row
   fixes, at a base date, the share of each payment settled in each currency and the rate
   applied to that share — FIDIC Sub-Clause 14.15. `validatePortions` requires the
   proportions to exhaust the payment (sum to 100% within `PORTION_SUM_TOLERANCE` 0.01),
   because a split that does not add up is not a contract term. The rate direction is one
   convention the whole engine depends on and it is stated in the file header: a rate
   `from → to` is **units of `to` bought by one unit of `from`**, so
   `foreignAmount = baseAmount × baseRate`.
2. **FX variance is the deliverable** (#596, #599). `POST …/currency-configs/:id/split`
   splits a payment across the portions and values each share against the market:
   `contractualAmount = baseAmount × baseRate` versus `marketAmount = baseAmount ×
   marketRate`, plus the base-currency cost *today* of buying the contractual foreign
   entitlement (`contractualAmount ÷ marketRate`) against the base share it was meant to
   settle. That difference is the unrealised gain/loss the project is carrying. A portion
   with no usable quote is returned with nulls and named in `missingRates` with a `note`
   — a partially-quoted contract still produces a usable statement rather than a silent
   half-answer. `…/fx/exposure` rolls every config (and its linked contract sum) into the
   project-level position.
3. **Rate provenance, because #598 is won on the audit trail** (#597). `fx_rates` are dated
   quotes, unique per `(company, from, to, date, source)` with `source ∈ contractual |
   central_bank | market | manual` and a `sourceReference`. `resolveRate` walks an explicit
   ladder — `identity → direct → inverse → triangulated` through a pivot — and **reports
   which path it took**, the quote dates used (the staler leg for a triangulation) and the
   legs themselves. A converted number that cannot say where its rate came from is not
   evidence.
4. **Permits that block the programme** (#585–591, #608, #614). `permits` are numbered per
   project over `PERMIT_KINDS` (work permit, visa, import licence, customs clearance, road
   closure, environmental consent, planning condition, utility wayleave) with the authority,
   jurisdiction, the application date and an `expectedDays` statutory determination period
   that computes `dueAt` — and that date materializes an assurance `obligations` row
   (`warnDaysBefore: 7`, evidence requirement: a written determination from the authority),
   kept in step when the application date or period is edited. Two sweeps run lazily on
   reads: a determination past `dueAt` while still `applied`/`in_review` breaches that
   obligation and raises `permit_determination_overdue` (medium, with the advice that
   authority delay is normally an employer-risk event and the chase correspondence is what
   the entitlement argument later rests on); a `granted` permit past `expiresAt` flips to
   `expired` and raises `permit_expired` (high). Conditions attached to a grant are tracked
   as closable items on the permit with their own due dates and a live `openConditions`
   count (#586–587) — they are **not** obligation-backed today, a deliberate boundary noted
   in `docs/roadmap.md`. `…/permits/schedule-risk` is the twin of the land analysis in
   §19.4: permits that are not granted, joined to the `blockingTaskIds` they gate, sorted by
   how soon the work starts, raising `permit_blocks_programme` inside the horizon (#591).
5. **Local content and ICV** (#612–615): a target names its jurisdiction and metric
   (`local_spend_percent | local_headcount_percent | icv_score | national_quota`) and takes
   dated readings. Every one of these metrics is a floor — higher is better — so compliance
   is `value >= targetValue` with no operator to configure, and a reading below the floor
   raises `local_content_shortfall` with the gap and the consequence (penalties, withheld
   certificates, exclusion from future Gulf ICV tenders).

Not built (Domain K remainder): #600–601 hedging instruments and repatriation restrictions,
#602–607 multi-entity consolidation, functional/presentation currency, inflation and IAS 29,
country charts of accounts and multi-jurisdiction statutory reporting, #609–611 customs
bonds, port-clearance delay logging and border delay attribution, #616–626 the
emerging-market client stack (offline-first, SMS/USSD, low-bandwidth sync, OCR paper
capture, RTL and non-Latin scripts, regional formats, holiday calendars, data residency)
— that last family is an application-shell programme, not a module, and is sequenced in
`docs/roadmap.md`.

---

## 23. Analytics & 360 reporting (Vol I §6)

Spec Vol I §6.1–6.2. Routes `apps/api/src/modules/analytics/index.ts`, dataset registry and
query builder `modules/analytics/datasets.ts`, schema
`packages/db/src/schema/analytics.ts`, web workspace `apps/web/src/pages/analytics/`.
This is the one Phase-5 module that is *parity* surface rather than gap surface, and it is
built the way the rest of the platform is: declaratively, with the security model living
in a registry rather than in a filter.

1. **A registry, not a query language** (#731–733). `DATASETS` in `datasets.ts` is the
   single source of truth for what is reportable: one entry per `REPORT_DATASETS` member
   (twelve today, spanning delivery, commercial, forensic, financial and safeguard tables —
   `rfis`, `submittals`, `punch_items`, `daily_logs`, `delay_events`, `risks`, `signals`,
   `payment_claims`, `variations`, `disbursements`, `grievances`, `workers`), each with its
   drizzle table, its company/project columns and a map of column keys to
   `{label, drizzle column, type, enum vocabulary, filterable, groupable, aggregatable}`.
   `GET /analytics/datasets` serves the same constant to the builder UI as the catalog, so
   the field list a user sees and the fields the executor accepts cannot drift.
2. **Why there is no raw SQL — and why that is the whole design.** A report definition is
   stored user input describing a query, and *identifiers cannot be parameterized*. So no
   identifier is ever taken from the user: dataset, column, filter field, group-by,
   aggregation field and sort are all **keys looked up in the registry** (via
   `Object.hasOwn`, not bare indexing — `__proto__` and `constructor` would otherwise
   resolve), and a key that does not resolve is a 400 that echoes the offending key back
   without ever putting it in a query. Aggregation aliases — the only user string that
   reaches the SQL text — must match `[A-Za-z][A-Za-z0-9_]{0,40}`. Filter values are
   coerced to the registered column's type (enums checked against their vocabulary, `in`
   capped at 200) and bound as parameters by drizzle. Full argument and the accepted
   trade-off in `docs/adr/0013-whitelisted-report-builder.md`.
3. **Scope is applied by the executor, never by the definition** (#739, #751).
   `executeReport` pushes `eq(companyColumn, companyId)` **first**, then the project
   predicate, and ANDs the definition's own filters *beneath* them — so a stored definition
   that names another tenant returns nothing instead of escaping. For a company-wide run,
   `reachableProjectIds` mirrors `requireTool`'s model (owner/admin and company-wide
   assurance grants unrestricted; everyone else gets memberships plus project-scoped
   grants) and an empty reach renders as a literal `false` predicate, not "everything".
   Analytics crosses projects by design, so its routes gate on `requireCompany` and check
   project reach per
   report rather than carrying a `:projectId` tool gate — it is never a wider door than the
   module it reports on. (The `analytics` tool key is reserved in `TOOLS` and inherited by
   every permission template, but the module deliberately does not gate on it: a per-tool
   level keyed to one project cannot express "may read across projects". The reach check
   is the gate, and keeping it in step with `requireTool`'s model is a review-and-test
   obligation, not a type-system one — `docs/security.md` §2.4.)
4. **Definitions, preview and execution** (#734 partial, #735–738): saved
   `report_definitions` (project- or company-scoped, `isShared` for #737, editable only by
   creator or company admin), `POST …/reports/preview` for an unsaved spec, `POST
   …/reports/:id/run` for paged execution with an honest `truncated` flag (the executor
   fetches one row beyond the window rather than silently cutting), and
   `GET …/reports/:id/export.csv` (#738 — CSV only; PDF and Excel are not built).
   Calculated columns (#734) are deliberately absent: an arbitrary user expression is
   user-authored SQL by another name — see ADR 0013 for the shape that would preserve the
   invariant.
5. **Dashboards** (#741–742, #749): `dashboards` hold widgets (`WIDGET_KINDS`:
   `stat | bar | line | donut | table`) bound either to a report definition or to one of a
   small set of code-defined `METRICS` (`open_obligations`, `open_signals` — the assurance
   counts that no single dataset expresses). `…/dashboards/:id/data` executes every widget
   under the caller's scope, and `POST …/dashboards/seed-defaults` idempotently seeds three
   role dashboards from real definitions — **PM** (open RFIs, punch by status, RFI ageing),
   **Commercial** (variations by status, payment claims by status, disbursement register)
   and **Assurance** (signals by severity, open obligations, grievances by status). Each
   widget result carries its dataset key alongside the rows, and row-mode definitions
   project the record's own identifying columns — which is what the client needs to drill
   from a chart back to the record (#749). Widget execution is fault-isolated: a widget
   whose report was deleted or whose project the viewer cannot reach comes back with
   `data: null` and an `error` string rather than failing the whole dashboard.
6. **Scheduled delivery is recorded, not dispatched** (#736) — stated plainly because the
   alternative is a user believing a report is arriving. `report_schedules` stores the
   cadence, the recipients and a maintained `nextRunAt` (computed for 06:00 UTC), and
   **nothing happens when that instant passes**: this deployment runs a single API process
   with no worker, queue or cron and no mail transport. Every schedule response carries a
   `delivery: {enabled: false, note}` block saying so, and the module header names the work
   to wire it (a scheduler polling `report_schedules` for due rows, executing the report,
   handing the CSV to a transport).

Not built from §6: #740 inactive-project tracking, #743 direct BI-tool data-model exposure
(the REST surface is the only exposure), #744–748 portfolio aggregation, trend analysis and
the predictive-field family, #750 historical comparison, #752 scheduled data refresh
(nothing is materialized — every run is live), and all of §6.3 insights & benchmarking
(#753–758), which is M11 territory and needs a benchmark independent of the benchmarked
(`docs/roadmap.md`).

---

## 24. AI layer

`modules/ai/` (service in `service.ts`), schema `packages/db/src/schema/ai.ts`. Design rules
come from spec Domain X: **citations always (#1019), human-in-the-loop for consequential
outputs (#1020), full audit trail (#1021).**

- **Agents** (`AI_AGENT_KINDS`, `packages/shared/src/enums.ts`): document search, submittal
  review, daily-log draft, RFI evaluation, contract risk, sheet naming, photo intelligence,
  and a general assistant. Exposed as `POST /projects/:projectId/ai/*` routes gated by the
  `ai` tool; model calls go through the Anthropic SDK (`@anthropic-ai/sdk`), default model
  from `AI_MODEL` in `src/config.ts`.
- **Audit trail**: every invocation writes an `ai_runs` row — agent kind, model, requester,
  input record references (provenance), prompt, raw and structured output, **citations**,
  token counts, latency, and status `succeeded | failed | refused`. Failures and refusals are
  recorded, not swallowed (`service.ts` maps them to typed `AiUpstreamError` /
  `AiParseError` / `AiRefused` errors).
- **Human-in-the-loop queue**: agents never mutate operational records directly. Consequential
  proposals land in `ai_review_queue` (`pending | approved | rejected | superseded`);
  `POST /ai/review/:id/approve` re-runs the **target tool's** `requireTool(…, "standard")`
  gate against the reviewer before applying the proposal (`gateReviewer` in
  `modules/ai/index.ts`) — approving an AI-drafted daily log requires the same permission as
  writing one by hand. Applied changes then flow through the normal ledger append.
- **Disabled mode**: with no `ANTHROPIC_API_KEY`, `aiEnabled()` is false and every AI route
  returns **503 with error name `AiDisabled`** ("Set ANTHROPIC_API_KEY to enable AI
  features") — deterministic, testable degradation; the rest of the platform is unaffected.
  Pure helpers in `service.ts` are unit-tested without network access.

---

## 25. Integration surface

**Today (implemented):**

- REST API under `/api/v1`, JSON bodies, zod-validated, bearer auth + `x-company-id` tenant
  header; uniform error envelope `{statusCode, error, message, details?}` (`app.ts`);
  uniform pagination `{items, total, page, pageSize}` (`lib/pagination.ts`).
- Multipart binary upload on documents/drawings/BIM routes; streamed binary download
  (`/files/:id/download`, `/drawing-files/:id/pdf`).
- Ledger export/verify (`GET /ledger`, `GET /ledger/verify`) and Merkle evidence packs — the
  forensically exportable surface (spec Domain S #871–872).
- COBie CSV/JSON export (twin module) — the open handover format (spec Domain N adjacent).
- CSV exports for external counterparties: the facility statement of expenditure
  (`…/facilities/:id/statement.csv`, spec O#735), the frozen bundle manifest with per-tab
  content hashes (`…/dispute-bundles/:id/manifest.csv`, spec E#343), the whole-life carbon
  report (`…/carbon/report.csv`, spec I#491–492) and any saved report definition
  (`/analytics/reports/:id/export.csv`, spec Vol I #738 — CSV only; PDF/Excel are not
  built).
- The analytics dataset catalog (`GET /analytics/datasets`) is the closest thing to a
  published data model today: labels, types, enum vocabularies and per-column capability
  flags for every reportable column (spec Vol I #743 wants direct BI-tool connection; the
  REST surface is the only exposure — see §23).
- CORS is open (`origin: true` in `app.ts`) to keep third-party browser clients possible in
  dev; tighten per deployment.

**Planned (not yet in code):**

- Webhooks for event-driven integration (spec Vol I #121) — the natural emitter is the ledger
  append path, which already sees every consequential mutation.
- OAuth2 client credentials for machine callers (#120); today only user JWTs exist.
- Ingestion connectors (Procore/Aconex/ERP/spreadsheets — spec Vol III M6), the Tier-1 module
  that feeds the assurance layer with third-party records. See `docs/roadmap.md`.

---

## 26. Verification & test strategy

- `packages/ledger` has pure unit tests (`src/ledger.test.ts`); so do the pure analysis
  cores in the API — the CPM engine (`apps/api/src/lib/cpm.test.ts`, hand-computed
  networks incl. the fragnet-TIA primitive), the prolongation calculator
  (`modules/forensics/prolongation.test.ts`), the Monte Carlo engine
  (`apps/api/src/lib/montecarlo.test.ts`: seed determinism, distribution means, QCRA/QSRA
  behaviour against hand-reasoned cases), the appraisal mathematics
  (`modules/governance/appraisal.test.ts`), the settlement expected-value model
  (exercised via `modules/disputes/disputes.test.ts`), the carbon calculation core
  (`modules/esg/carbon.test.ts`), the multi-currency engine
  (`modules/jurisdiction/fx.test.ts`: rate-direction conventions, the
  identity/direct/inverse/triangulated ladder, portion validation, payment splitting) and
  the analytics registry and resolver (`modules/analytics/datasets.test.ts`, which asserts
  the injection invariants of ADR 0013 directly: unknown keys, prototype-chain keys,
  non-groupable fields, out-of-vocabulary enum values and alias patterns).
  The ghost-worker reconciliation engine (`modules/workforce/reconcile.ts`) is pure and is
  exercised through `modules/workforce/workforce.test.ts` against hand-worked periods.
- Every API module colocates `<name>.test.ts` using `buildTestApp()`
  (`apps/api/src/test/helpers.ts`): a full Fastify app over in-memory PGlite with migrations
  applied — integration tests with zero external services, exercising the real auth chain via
  `registerActor()` and `app.inject()`.
- CI (`.github/workflows/ci.yml`) runs typecheck, build and the full test suite on Node 22
  with a frozen lockfile.
