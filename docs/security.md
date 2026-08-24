# ConstructOS — Security Model

Engineer-to-engineer reference for authentication, authorization, tenant isolation and
evidentiary integrity. Every claim is grounded in committed code, with file paths. The
honest gap register in §8 is part of the model — a platform whose product is the
trustworthiness of its record cannot afford flattering documentation.

---

## 1. Authentication

Implemented in `apps/api/src/plugins/auth.ts` (verification) and
`apps/api/src/modules/identity/index.ts` (credential lifecycle). Config in
`apps/api/src/config.ts`.

### 1.1 Passwords

- Hashed with **bcrypt, cost factor 10** (`bcryptjs`, `modules/identity/index.ts`
  `POST /auth/register`). Plaintext is never persisted.
- Policy: 8–128 chars enforced by zod (`registerSchema`). No complexity rules, no breach-list
  check yet (see §8).
- Login compares with `bcrypt.compare` and returns a uniform `401 Invalid credentials` for
  unknown email, wrong password and deactivated account alike — no account enumeration via
  the login route. (The register route does reveal whether an email exists via `409`; see §8.)

### 1.2 Access tokens

- **JWT, HS256** via `jose` (`signAccessToken` in `plugins/auth.ts`), symmetric secret from
  `AUTH_SECRET`, subject = user id, default TTL **1 hour**
  (`ACCESS_TOKEN_TTL_SECONDS`, `config.ts`).
- `authenticate` verifies the signature **and re-loads the user row on every request**,
  rejecting unknown or `isActive = false` users — deactivation takes effect on the next
  request, not at token expiry. What it cannot do is revoke a specific stolen token before
  its 1-hour expiry (no jti denylist yet; see §8).

### 1.3 Refresh tokens (rotation)

`modules/identity/index.ts`, table `refresh_tokens`
(`packages/db/src/schema/identity.ts`):

- Opaque random value (two concatenated 21-char nanoids, ≈ 240 bits) — **stored only as its
  SHA-256 hash** (`tokenHash`), so a database read does not yield usable tokens.
- Default TTL 30 days (`REFRESH_TOKEN_TTL_DAYS`).
- **Rotated on every `POST /auth/refresh`**: the presented token is looked up by hash,
  checked for `revokedAt`/`expiresAt`, revoked, and a fresh pair issued. `POST /auth/logout`
  revokes by hash.
- Not yet implemented: reuse detection (a replayed already-rotated token should revoke the
  whole family), device binding, per-session listing. See §8.

### 1.4 Security event log

Every register / login success / login failure / logout writes an `auth_events` row with
`ip` and `userAgent` (`modules/identity/index.ts`; spec Vol I #26). Exposed to company
owners/admins at `GET /api/v1/company/auth-events` (`modules/admin/index.ts`). This is an
operational log in a normal table — the tamper-evident record is the ledger (§5), which
auth events do not currently flow into.

---

## 2. Authorization — the three-layer RBAC model

Defined in `packages/shared/src/permissions.ts`, enforced in `apps/api/src/plugins/auth.ts`,
persisted in `packages/db/src/schema/identity.ts`.

```mermaid
flowchart TD
    A["authenticate<br/>(JWT → req.user)"] --> B["requireCompany<br/>(x-company-id → membership → req.companyRole)"]
    B --> C{"route has :projectId?"}
    C -- yes --> D["requireTool(tool, level)"]
    D --> E{"companyRole ∈ owner/admin?"}
    E -- yes --> H["allow (bypass)"]
    E -- no --> F["project membership →<br/>template ⊕ overrides → resolveLevel"]
    F --> G{"meetsLevel?"}
    G -- yes --> H
    G -- "no, level = read" --> I{"live assurance grant?"}
    I -- yes --> J["allow read-only<br/>(req.assuranceRole set)"]
    I -- no --> K["403"]
    G -- "no, level > read" --> K
    C -- "company-scope route" --> L["requireCompanyRole([...]) or<br/>requireAssuranceRole([...]) as declared"]
```

### 2.1 Layer 1 — company roles

`owner | admin | member | guest` (`COMPANY_ROLES`), one per `(companyId, userId)` in
`company_memberships`. Owner/admin: full bypass of tool-level checks inside their tenant
(`requireTool`, `plugins/auth.ts`) plus access to `requireCompanyRole(["owner","admin"])`
routes — permission templates, assurance grants, auth-events (`modules/admin/index.ts`).
`guest` is an ordinary member for tool resolution but is explicitly barred from reviewing AI
proposals (`gateReviewer`, `modules/ai/index.ts`).

### 2.2 Layer 2 — per-tool permission levels

`none < read < standard < admin` (`PERMISSION_LEVELS`, ordered by `meetsLevel`) over the 30
tools in `TOOLS` (directory, projects, documents, drawings, specifications, bim, twin, rfis,
submittals, daily_logs, punch, photos, meetings, workflow, budget, commitments,
change_management, invoicing, commercial, contracts, schedule, forensics, payments, risk,
governance, finance, disputes, assurance, ai, admin). The three Phase 3 tools and the four
Phase 4 tools (risk, governance, finance, disputes) inherit the built-in template baselines
via the `all(…)` spreads in `permissions.ts` — e.g. `project_manager` gets `standard`,
`subcontractor` gets `none` — with no per-tool carve-outs added.

Resolution (`resolveLevel`): per-user `overrides` on the `project_memberships` row beat the
membership's template (`permission_templates` row, falling back to the shared
`BUILTIN_PERMISSION_TEMPLATES`), which beats `none`. Built-in templates seeded into every new
tenant (`seedCompanyDefaults`, `modules/identity/index.ts`):

| Template | Shape (from `permissions.ts`) |
|---|---|
| `project_admin` | admin on everything |
| `project_manager` | standard everywhere; admin on workflow/rfis/submittals/daily_logs/punch/meetings; **none on admin & assurance** |
| `field_engineer` | read baseline; standard on rfis/daily_logs/punch/photos/documents; none on financial tools, admin, assurance |
| `subcontractor` | none baseline; read drawings/specs/documents; standard on rfis/submittals/daily_logs/punch/photos |
| `owner_stakeholder` | read everywhere incl. assurance & ai; none on admin |
| `read_only` | read everywhere; none on admin & assurance |

Note the deliberate default: **operational project managers get `none` on the assurance
tool.** Visibility into the assurance layer is granted, not assumed.

### 2.3 Layer 3 — assurance roles (segregation of duties)

`integrity_reviewer | auditor | regulator` (`ASSURANCE_ROLES`), granted via
`assurance_grants` rows — tenant-wide (`projectId` null) or per-project, optionally
**time-boxed** via `expiresAt` (the regulator pattern). Grants are managed only by company
owners/admins (`modules/admin/index.ts`) and every check filters expired grants
(`requireAssuranceRole` and `holdsAssuranceRole` in `modules/assurance/index.ts`).

Effect on operational tools: an unexpired grant satisfies any `requireTool(…, "read")` check
(`plugins/auth.ts`) — **read-all, change-nothing**. It never satisfies `standard` or `admin`.

### 2.4 Segregation-of-duties rules, as enforced

| Rule | Enforcement point |
|---|---|
| **Signal disposition requires `integrity_reviewer`** — operational owners/admins must not clear signals about their own records. Company role gives no bypass: the route uses `requireAssuranceRole`, not `requireTool`. | `PATCH /signals/:signalId/disposition`, `modules/assurance/index.ts` |
| Reconciliation disposition requires `integrity_reviewer` or `auditor` | `PATCH /reconciliations/:reconciliationId/disposition`, same file |
| **Assertion/evidence separation** (spec Vol III §4 design rule): creating a reconciliation whose evidence was *entirely* submitted by the assertion's claimant is `403 evidence not independent of claimant`; only a caller holding `integrity_reviewer` may knowingly proceed, and the creation is ledgered with full payload | `POST /projects/:projectId/reconciliations` |
| Self-certification is recorded, not hidden: satisfying an obligation with evidence the caller submitted writes `selfCertified: true` into the ledger payload | obligation `/satisfy` route, same file |
| Detector runs are restricted to assurance-role holders or company owner/admin | `POST /projects/:projectId/detectors/run` |
| AI proposals require a human with the *target tool's* `standard` permission to apply — approving an AI-drafted daily log needs the same right as writing one | `gateReviewer`, `modules/ai/index.ts` |
| **Payment certification requires a different human than the application's submitter** — `POST /valuations/:valuationId/certify` returns `403 The certifier must not be the valuation's submitter` when the caller is `valuations.submittedBy`. Level separation stacks on identity separation: submitting needs `commercial` `standard`, certifying needs `commercial` **admin**. The certificate persists the variance from the application with a reason (spec B#180), and the certified value is simultaneously written to the assurance layer as a `cost` Assertion claimed by the *certifier* — so certification is itself a reconcilable claim, not a settled fact (see `docs/adr/0008-certification-independence.md`) | `modules/commercial/valuations.ts`, certify route |
| **EOT assessment independence** — an extension-of-time claim cannot be moved to `assessed` by the user who raised it (`403 An EOT claim cannot be assessed by the user who raised it`); `assessedBy`/`assessedAt` are stamped on the row and the transition is ledgered with the days awarded | `modules/contracts/index.ts`, EOT status route |
| **Time-bar obligations cannot be quietly rewritten** — a contract event under a time-barred clause materializes an assurance `obligations` row at creation (deadline + `warnDaysBefore`). Serving notice satisfies an *open* obligation only; once the sweep has marked an event `time_barred` and breached its obligation, late service raises a `time_bar_breach_risk` signal and leaves the breach standing — the register records what happened, not what the operator wishes had happened | `sweepTimeBars` + serve-notice route, `modules/contracts/index.ts` |
| **Forensic claim assessment independence** — a delay/disruption claim cannot be moved to `assessed` by the user who created it (`403 A claim cannot be assessed by the user who created it`); `assessedBy` is stamped, the assessed days/amount are ledgered with the transition, and the claim's cause-effect-entitlement-quantum chain and supporting event set are frozen once it leaves `draft` — the narrative that was submitted is the narrative that gets assessed. Same identity-level pattern as EOT assessment and payment certification (ADR 0008) | `modules/forensics/index.ts`, claim status route |
| **Payment response authority is grounds-based and time-boxed** — a pay-less notice for less than the claimed amount without stated reasons is a 400 (statutory ground-stating, spec F#365); a response served after the statutory deadline is recorded with `late = 1`, **rescues no status** (a deemed claim stays deemed), breaches the response obligation and raises a high `late_payment_response` signal; served claims are immutable (only drafts can be edited). The payer cannot retroactively construct a compliant response history | `modules/payments/index.ts`, respond route |
| **Deemed-liability signal path** — the same materialization pattern as time bars: serving a payment claim creates an assurance `obligations` row for the statutory response deadline (`warnDaysBefore: 3`), so the payment clock and the obligation register agree on one date. The lazy sweep (`sweepDeemed`, run on every read of the register) flips an unanswered served claim to `deemed` exactly once, breaches the obligation and raises a **critical `payment_deemed_liability` signal** whose explanation embeds the regime's statutory deemed rule. Payment satisfies an *open* obligation only — paying late does not un-breach the register | `sweepDeemed` + serve/respond/mark-paid routes, `modules/payments/index.ts` |
| **Business-case determination independence** — a submitted business case cannot be approved or rejected by its author (`403 Determination independence: the author of a business case cannot decide it`); approval additionally requires a preferred option (an approval that endorses no option is not a decision), the decision is ledgered with the preferred option, and an approved/rejected case is **immutable** — the appraisal a decision was made on cannot be re-shaped afterwards (options and appraisal config are draft-only edits). Same identity-level pattern as certification and EOT/claim assessment (ADR 0008) | `modules/governance/index.ts`, approve/reject + PATCH/options routes |
| **Disbursement approval separation** — a disbursement request cannot be approved by its creator (`403 Separation of duties: a disbursement request cannot be approved by its creator`). Level separation stacks on identity separation: drafting/submitting needs `finance` `standard`, approve/reject need `finance` **admin** — as does waiving a facility condition, which also requires a stated reason and is ledgered with it. Disbursing requires a previously approved request; every transition is ledgered with payload | `modules/finance/index.ts`, approve/reject/waive routes |
| **The conditionality gate is a control, not a convenience** — a disbursement request cannot be *submitted* while any condition precedent on its facility is open **or breached** (409 listing the blocking conditions); the verification snapshot (`{verifiedAt, openConditions[]}`) is persisted on the request whether or not it passed, and **a blocked submission attempt is itself ledgered** (`submit_blocked_by_conditionality`) — circumvention attempts are on the record. Condition satisfaction requires validated assurance evidence ids (never a bare assertion); late satisfaction unblocks the pipeline but a breached obligation stays breached — only an explicit admin-level waiver supersedes it. Headroom is enforced at the same gate: the pipeline may exceed neither the facility's committed amount nor a category limit | `modules/finance/index.ts`, submit route + `sweepOverdueConditions`; ADR 0012 |
| **Contingency drawdown authority is recorded and bounded** — a drawdown exceeding the remaining contingency is refused (409 with the arithmetic); every draw records `approvedBy` and is ledgered with full payload (amount, reason, linked risk, remaining-after); a contingency with recorded drawdowns cannot be deleted; and the draw that takes remaining cover under 20% raises a high `contingency_exhaustion` signal exactly once. Stated plainly: there is **no separate release-approval workflow yet** (spec H#472) — `approvedBy` is the caller, gated only at `risk` `standard`, so drawdown authority is attributable and bounded but not yet two-person | `modules/risk/index.ts`, drawdowns route |
| **Dispute timetables and bundles cannot be quietly rewritten** — overdue timetable steps are breached by the lazy sweep (obligation breached + high `dispute_deadline_missed` signal, exactly once via the step's `breachedAt` marker) and completing a step satisfies an *open* obligation only — a missed deadline stays on the register. A generated hearing bundle is **frozen**: its manifest commits tab order and per-item content hashes under a Merkle root, `/verify` recomputes every hash and the root against today's records (the check is ledgered as an `access` entry), and only a generated bundle can be issued | `modules/disputes/index.ts`, sweep + complete/generate/verify/issue routes |

Residual weakness stated plainly: a company **owner/admin can hold operational admin and be
granted an assurance role by another admin** — the platform does not yet forbid overlapping
grants, and evidence/assertions still arrive through the same API pathway (independent
ingestion channels are Tier-1 roadmap work, `docs/roadmap.md`). The rules above make abuse
detectable and attributable, not impossible. The certification, EOT and forensic-claim
rules are *identity-level* checks inside one tenant: submitter and certifier (or claim
author and assessor) can be colleagues in the same organization, and nothing yet models
the contractual *party* (employer / contractor / administrator) an actor represents —
party-aware separation is future work on top of the `contracts.parties` field. The same
caveat applies with more force in payments: the platform records both sides of a payment
claim (claimant service and payer response) through one tenant's `payments` tool with no
party-role check on who may respond — the statutes' teeth (deadlines, ground-stating,
deemed liability) are enforced mechanically, but *who* is entitled to author a response
is an organizational matter until party modelling lands. Phase 4 widens the same caveat
in two places. **Gate reviews enforce no reviewer independence**: `reviewedBy` is stamped
and ledgered, but nothing prevents the project's own team recording its own gate decision
— the independent assurance reviewer workspace (spec G#411) is not built, and until it is,
independence at a gate is process, not code (the business-*case* decision, by contrast,
is code — see the table). And **the lender is not a principal**: facility conditions,
waivers, disbursement approvals and covenant readings are all recorded by the borrower's
tenant through the `finance` tool. The gates are enforced mechanically and every action is
attributable, but nothing models *the lender* as the party entitled to waive a condition
or accept a covenant reading — today a lender gets visibility via a read-only assurance
grant, and lender-side authority is an organizational control until party modelling
lands.

---

## 3. Tenant isolation

- Tenant = `companies` row. Tenant context is an explicit `x-company-id` header checked
  against `company_memberships` on every request (`requireCompany`) — never inferred from the
  JWT, so a stolen token for user X yields nothing in companies X does not belong to.
- **Convention: every query on tenant-owned tables filters by `companyId`** (and `projectId`
  where applicable, which `requireTool` has already proven belongs to the tenant before the
  handler runs). Records are never fetched by id alone. This is a code-review invariant, not
  a database guarantee — there is **no row-level security** in Postgres (§8).
- Child tables reached only through a tenant-checked parent (`file_versions`,
  `workflow_step_instances`, `tag_assignments`, …) rely on the parent lookup being scoped.
- Storage: object keys are prefixed `companyId/` and `keyToPath` rejects traversal outside
  the storage root (`apps/api/src/lib/storage.ts`), so blobs are physically partitioned per
  tenant.
- Ledger: one hash chain per company (`ledger_entries.companyId` + `prevHash`), so exports
  and verification never mix tenants.

---

## 4. Storage content-addressing

`apps/api/src/lib/storage.ts` (spec Domain S #862):

- Objects are stored at `<STORAGE_DIR>/<companyId>/<sha256[0:2]>/<sha256>`. The address *is*
  the content hash: identical payloads dedupe, and a stored object cannot be silently
  replaced without its path ceasing to match its content.
- The hash is computed server-side at ingest and recorded on the `files` row (`sha256`,
  `packages/db/src/schema/documents.ts`) and per version in `file_versions` — the anchor for
  later verification and for `evidence.contentHash`.
- Retrieval does not currently re-hash and compare (verification-on-retrieval is a gap, §8).
- Two drivers behind the narrow `StorageService` interface, selected by `STORAGE_DRIVER`
  (`apps/api/src/config.ts`, wired in `app.ts`): `local` (disk, dev default) and `s3`
  (`apps/api/src/lib/storage-s3.ts` — any S3-compatible store: Railway Buckets, AWS S3, R2,
  MinIO). The S3 driver keeps the identical content-addressed key scheme
  (`<companyId>/<sha2>/<sha256>`), records the sha256 as object metadata so the object
  attests to its own integrity independently of our DB, and inherits the provider's
  encryption at rest and replication. Production boot refuses `STORAGE_DRIVER=s3` with any
  S3 variable missing (`config.ts`). The local driver remains single-node and unencrypted
  at rest — dev use, or volume deployments documented in `docs/deployment.md` §1.1.

---

## 5. Evidentiary integrity — threat model

The asset under attack is the trustworthiness of the record: the per-company hash chain
(`packages/ledger/src/chain.ts`, persisted via `apps/api/src/lib/ledger.ts` into
`ledger_entries`) plus content-addressed evidence (§4). Verification is
`GET /api/v1/ledger/verify` (`modules/assurance/index.ts`), which itself appends an `access`
entry — verifying the record is part of the record.

| Threat | What the design does | Detected? |
|---|---|---|
| **Post-hoc edit** of a historical ledger row (change actor, action, object, payload hash or timestamp) | `entryHash` covers every field plus `prevHash`; editing entry *k* invalidates entries *k…n*. `verifyChain` reports the first broken index. | Yes — chain break (spec #863, #866) |
| **Edit of an operational row** (e.g. rewrite an RFI answer) without a matching ledger entry | The current state no longer matches the last ledgered `payloadHash` for that `(objectType, objectId)`. Detectable by recomputing `hashPayload` over the row — a comparison job is roadmap, the data to do it exists today. | Partially — evidence exists, automated diffing does not |
| **Backdating** a record | The ledger's `at` is server-assigned at append time and covered by `entryHash`; `seq` (bigserial) gives a total insert order per company. A record claiming an early date but ledgered late is visible on inspection. | Yes, relative to server time — but see "trusted time" below |
| **Deletion** of a ledger entry | The successor's `prevHash` no longer matches; `seq` gaps corroborate. | Yes — chain break |
| **Deletion of an operational record** | Handlers append `action: "delete"` entries (module convention); the ledger retains `payloadHash` (and full payload where `storePayload` was set). | Yes, when the convention is followed — there is no DB trigger backstop (§8) |
| **Truncating the chain tail** (drop the last *k* entries) | Internally consistent — a truncated chain still verifies. Requires an externally held head hash or Merkle root to detect. | **No — known gap** (escrow/anchoring, spec #860–861, #874, not implemented) |
| **Full-chain rewrite by a database administrator** (recompute every hash) | Computationally trivial for an insider with DB write access; only an external anchor defeats it. | **No — same gap** |
| **Evidence file substitution** | Content-addressed path + recorded `sha256` / `evidence.contentHash`; a swapped payload no longer hashes to its address. Merkle evidence packs (`POST /projects/:projectId/evidence-packs`) commit a whole set under one root with per-leaf inclusion proofs — the root is the escrow-able artifact. | Yes, given the hash is checked at read time (not yet automatic, §8) |
| **Self-certified evidence** (claimant authors both sides) | Blocked at reconciliation creation unless an `integrity_reviewer` overrides; recorded (`submittedBy`, `selfCertified`) elsewhere. `independenceScore` quantifies source independence. | Yes — flagged, and blocked in the reconciliation path |
| **Clock manipulation on the API host** | `at` comes from `new Date()` on the app server; no trusted time source (spec #864). | No — gap |

What the chain proves: *the recorded sequence of state changes has not been altered since it
was written, and each change is bound to an actor, an object and a payload digest.* What it
does **not** prove: that a payload was true when written (that is the reconciliation
engine's job), or that the whole database was not replaced wholesale by its operator
(that requires external anchoring — the Merkle pack root is the committed foundation for it).

---

## 6. AI-surface security

- Disabled by default: without `ANTHROPIC_API_KEY`, every AI route returns
  `503 AiDisabled` (`modules/ai/service.ts`) — no silent fallback, nothing leaves the host.
- No autonomous mutation: agents write proposals to `ai_review_queue`; applying one re-runs
  the target tool's permission gate against the human reviewer (`gateReviewer`,
  `modules/ai/index.ts`) and flows through the normal ledger append.
- Full audit: every invocation — including failures and refusals — is an `ai_runs` row with
  requester, input record provenance, prompt, output, citations and token counts
  (spec Domain X #1019–1021). Prompts and outputs may contain project data; `ai_runs` is
  tenant-scoped like any other table.

---

## 7. Secrets & configuration

- All configuration is environment-driven through a zod schema (`apps/api/src/config.ts`);
  unknown shapes fail at boot, nothing secret is committed.
- `AUTH_SECRET` (min 16 chars) defaults to a dev-only value for local runs, but
  **production boot refuses the default**: `loadConfig` (`apps/api/src/config.ts`) throws
  `Refusing to start: AUTH_SECRET is the development default` when `NODE_ENV=production` —
  a misconfigured deployment fails loudly at boot instead of running with a guessable
  signing key.
- `ANTHROPIC_API_KEY` is optional and only ever read server-side.
- The global error handler hides 5xx details when `NODE_ENV=production` (`app.ts`).
- `docker-compose.yml` carries throwaway local Postgres credentials only.

---

## 8. Known gaps — TODO register

### 8.1 Resolved since the first audit

Formerly open gaps, now implemented — kept here so the register shows movement, not just
debt. Each row cites the enforcing code.

| Was | Now implemented | Where |
|---|---|---|
| No rate limiting anywhere — credential stuffing unimpeded | Global per-IP limit (`RATE_LIMIT_MAX_PER_MINUTE`, default 300/min) via `@fastify/rate-limit`, plus a stricter per-IP limit on the credential endpoints (`AUTH_RATE_LIMIT_MAX_PER_MINUTE`, default 10/min) | `apps/api/src/app.ts` (registration), `apps/api/src/modules/identity/index.ts` (`authLimited` route config), `apps/api/src/config.ts` |
| No security headers | Helmet with an explicit CSP tuned for the same-origin SPA (`default-src 'self'`; `wasm-unsafe-eval` for web-ifc, `blob:` workers/fetches for pdf.js; `object-src 'none'`, `frame-ancestors 'self'`) + helmet's defaults incl. HSTS | `apps/api/src/app.ts` |
| Client IPs unusable behind a platform proxy (rate limits keyed on the proxy, `auth_events.ip` wrong) | `TRUST_PROXY` config honors `x-forwarded-*`; enabled in the production image | `apps/api/src/config.ts`, `apps/api/src/app.ts` (`trustProxy`), `Dockerfile` (`TRUST_PROXY=true`) |
| Dev-default `AUTH_SECRET` accepted even in production | Boot-time refusal: production with the dev default throws before the server starts | `apps/api/src/config.ts` (`loadConfig`) |
| Storage: single node, no path off local disk | S3-compatible content-addressed driver (Railway Buckets / AWS S3 / R2 / MinIO), same `<companyId>/<sha2>/<sha256>` keys, sha256 recorded as object metadata, provider-side encryption at rest; production boot refuses `s3` with missing S3 config | `apps/api/src/lib/storage-s3.ts`, `apps/api/src/app.ts` (driver selection), `apps/api/src/config.ts` |

### 8.2 Open gaps

Ordered roughly by risk. "Spec" references are `docs/master-specification.md`.

| # | Gap | Notes / spec ref |
|---|---|---|
| 1 | **No MFA** | Vol I #22 |
| 2 | **No external ledger anchoring/escrow** — tail-truncation and full-rewrite by a DB insider are undetectable | Domain S #860–861, #874; Merkle pack roots exist, publishing them does not |
| 3 | **No trusted timestamping** — ledger `at` is app-server clock | Domain S #864 |
| 4 | **No SSO (SAML) / SCIM** — blocks enterprise tenants | Vol I #20–21 |
| 5 | Access-token revocation only via 1h expiry (no jti denylist); refresh-token **reuse detection** absent; no progressive lockout on top of the auth rate limit | §1.2–1.3 |
| 6 | **No DB-level row security** — tenant isolation is a code convention; one missed `companyId` filter is a cross-tenant leak | add Postgres RLS keyed on a per-request setting as defense-in-depth |
| 7 | CORS `origin: true` and open registration — fine for dev, must be tightened per deployment | `app.ts`; noted in `docs/deployment.md` §2.8 |
| 8 | Storage: no hash re-verification on read, no malware scanning of uploads; local driver (dev/volume mode) unencrypted at rest | §4; Domain S #862 (retrieval half) |
| 9 | Ledger coverage relies on module convention (no DB trigger writes entries for out-of-band changes); no automated drift job comparing row state to last `payloadHash` | §5 |
| 10 | Overlapping operational + assurance roles for the same user are not forbidden | §2.4 |
| 11 | Register route reveals email existence (409); no email verification flow | §1.1 |
| 12 | **No IP allowlisting**, session timeout policy, or password policy configuration | Vol I #23–25 |
| 13 | **No log forwarding pipeline** — app logs are stdout JSON only; platform retention is finite (~30 days on Railway Pro) and `auth_events`/ledger cover mutations, not infrastructure events | operational option (Vector sidecar) documented in `docs/deployment.md` §3.3 |
| 14 | Read access is mostly unlogged (exceptions: `file_access_log`, ledger `access` entries); regulator access is read-all rather than record-scoped | Domain A #92 wants scoped regulator portals |
| 15 | No field-level visibility control on financial data (tools are all-or-nothing per level) | Vol I #18 |
| 16 | Refresh tokens and JWTs are bearer credentials — TLS termination is the platform's job (the app sends HSTS via helmet but cannot terminate TLS itself) | per-deployment TLS documented in `docs/deployment.md` §2.6 |

None of these are silent: this register, `docs/roadmap.md` and the ADRs are the paper trail
that they are known, scoped and sequenced.
