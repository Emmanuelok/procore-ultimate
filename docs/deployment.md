# ConstructOS — Railway Deployment Runbook

Step-by-step production deployment to [Railway](https://railway.com). Written for an
operator with no prior context on this codebase. Every claim about the *application* is
grounded in committed code (file paths cited). Claims about the *Railway dashboard* are
current as of writing — Railway ships UI changes frequently, so button labels and menu
locations may drift; the underlying concepts (services, variables, volumes, buckets,
reference variables) are stable.

The production artifact is the single Docker image built by the repo-root `Dockerfile`:
API + built SPA served same-origin from one container (`apps/api/src/app.ts`), migrations
baked in at `/app/migrations` and applied automatically at boot (`apps/api/src/lib/db.ts`).
There is no separate web service, no reverse proxy to configure, and no release command.

---

## 1. Topology on Railway

One Railway project, three components:

| Component | What | Notes |
|---|---|---|
| **App service** | This repo, built from `Dockerfile` (auto-detected via `railway.json`) | Stateless when `STORAGE_DRIVER=s3`. Serves API under `/api/v1` and the SPA same-origin with an SPA fallback (`apps/api/src/app.ts`). Healthcheck `/api/v1/health`. |
| **Postgres** | Railway Postgres database service | The only stateful component that matters. `DATABASE_URL` wired by reference variable. |
| **Bucket** | Railway Bucket (S3-compatible object storage) | Evidence/file store via the S3 driver (`apps/api/src/lib/storage-s3.ts`). Endpoint `https://storage.railway.app`. |

**No volume is needed** in the recommended configuration. With `STORAGE_DRIVER=s3` the
container writes nothing locally (`Dockerfile` comment, lines 30–32), so the service is
stateless: safe to redeploy, safe to scale to multiple replicas.

### 1.1 The volume + local-driver alternative (not recommended)

The image also supports `STORAGE_DRIVER=local` with a Railway volume mounted at `/data`
(`STORAGE_DIR=/data/storage` is the image default). If you choose this, understand the
constraints before committing:

- **Single replica only.** A volume attaches to one instance; the local driver has no
  shared view. Horizontal scaling is off the table.
- **`RAILWAY_RUN_UID=0` is required** as a service variable. The image drops privileges
  with `USER node` (`Dockerfile`), but Railway mounts volumes owned by root — without this
  override the process cannot write to `/data` and uploads fail with `EACCES`.
- **Redeploy downtime.** A service with a volume cannot run old and new instances
  side-by-side during deploys, so each deploy briefly takes the service offline.
- No provider-side redundancy for the files beyond the volume itself; you own backups.

Use S3. The local driver exists for development and as an escape hatch.

---

## 1.9 Production image — verified by CI, not by a memory of a walkthrough

This section used to be a table of results from one hand-run walkthrough, dated, quoting
a migration range (0000–0008) and a table count (177) that stopped being true within a
fortnight. A verification that decays is worse than none: it invites confidence in a fact
nobody has re-checked.

The check now runs on every push. `.github/workflows/ci.yml` has an `image` job that:

1. builds this exact `Dockerfile`;
2. runs the resulting container against a real PostgreSQL 16 service, in production mode,
   with only the variables a real deployment sets (`DATABASE_URL`, `AUTH_SECRET`,
   `APP_BASE_URL`);
3. waits for `GET /api/v1/health/ready` to return 200 — which means migrations applied and
   a query executed, not merely that a process is listening;
4. asserts `GET /api/v1/health` reports `db: postgres`, so an image that silently fell
   back to the embedded database fails rather than passing every other check;
5. asserts the SPA is served same-origin with a CSP header and that a client route falls
   back to `index.html`;
6. asserts an unauthenticated SCIM call is refused **in SCIM's own error envelope** (an
   identity provider parses that; it logs this platform's envelope as an unexplained
   failure);
7. registers an account end to end against the real database.

The deploy workflow is gated on that run: `deploy-railway.yml` triggers on CI's
completion and refuses to run unless the conclusion was `success`, checking out
`workflow_run.head_sha` — the commit CI actually tested, not whatever the branch tip has
become since.

Two refusals fire during a manual walkthrough and are worth knowing about, because both
look like errors and are not: creating a project with an invalid `stage` returns a zod
validation error naming the five permitted values, and creating a budget line without a
cost code is refused outright — budget lines bind to the project's cost-code structure
rather than inventing a parallel hierarchy.

## 2. Runbook

> **Fast path — one command.** Everything in §2.1–§2.6 is scripted:
>
> ```bash
> npm i -g @railway/cli && railway login
> ./scripts/railway-provision.sh          # project + Postgres (PITR, backup
>                                         # schedules) + bucket + app service
>                                         # with all variables + deploy + domain
> ./scripts/post-deploy-smoke.sh https://<your-domain>
> ```
>
> The provisioning script is safe to re-run after a partial failure, prints
> what it skipped, and never destroys anything. Options (`ENABLE_HA=1`,
> `BUCKET_REGION=ams|sjc|iad|sin`, `ANTHROPIC_API_KEY=...`) are documented in
> its header. The smoke script verifies the live deployment end-to-end —
> including that the app is really on Postgres (not the embedded fallback)
> and that a file survives an upload/download round-trip through the bucket
> byte-for-byte. The manual steps below remain the reference for what the
> script does and for anyone provisioning through the dashboard.

### 2.1 Create the project

1. Railway dashboard → **New Project** (start empty; we add components explicitly).
2. Pick the region closest to your users. All components in this project should live in
   the same region — cross-region private networking adds latency.

### 2.2 Provision Postgres — and harden it BEFORE go-live

1. In the project canvas: **Create → Database → Postgres** (labels may drift; you want the
   official Railway Postgres).
2. Wait for it to come online. Note that it exposes two connection URLs as service
   variables: `DATABASE_URL` (private network, `*.railway.internal`) and
   `DATABASE_PUBLIC_URL` (public TCP proxy). The app must use the **private** one.
3. **Enable High Availability and Point-in-Time Recovery now**, per Railway's current
   Postgres docs (dashboard: the Postgres service's settings/backups area). Two reasons to
   do this before go-live, not after:
   - **The conversion drops existing connections and changes connection endpoints.**
     Doing it against a live system is an outage plus a variable change; doing it now
     costs nothing.
   - PITR needs WAL archiving running from before the moment you want to be able to
     rewind to.
4. Confirm the backup schedule on the Postgres volume is enabled (daily is the usual
   default — verify, don't assume; see §3.1 for the restore rehearsal that makes a backup
   real).

### 2.3 Create the Bucket and access keys

1. Project canvas → **Create → Bucket** (Railway's S3-compatible object storage). Name it
   e.g. `constructos-files`.
2. Create/reveal the bucket's credentials. You need four values:
   - bucket name
   - access key ID
   - secret access key
   - endpoint — `https://storage.railway.app` (region is `auto`)
3. Keep the secret in Railway variables only; it never goes in the repo.

### 2.4 Create the app service from GitHub

> **⚠️ ONE service, rooted at `/`. Do not let Railway split the monorepo.**
> Railway's GitHub import may detect the pnpm workspace and offer to create
> per-package services (`@constructos/api`, `@constructos/web`). **Decline that.**
> Those services build the packages in isolation with Railway's auto-builder,
> which cannot work here — the web app is served *by the API* from one
> container, and a package-rooted service never sees the root `railway.json`
> or `Dockerfile`. Symptoms of the wrong setup: builder shows "Railpack"
> instead of "Dockerfile"; the web service dies at *Create container* with
> ``The executable `pnpm` could not be found``; commits show
> *SKIPPED — no changes to watched files* because the split services were
> given per-package watch paths.
>
> **Recovery if this already happened:** delete both broken services
> (service → Settings → Danger → Delete, or `railway service "@constructos/api" delete`),
> then either run `./scripts/railway-provision.sh` from a linked local
> checkout (fastest — it also adds Postgres + the bucket), or re-create one
> service from the repo with its **Root Directory left at `/`** and continue
> below. The check that you got it right: the service's build settings show
> **Dockerfile**, not Railpack.

1. Project canvas → **Create → GitHub Repo** → select **`Emmanuelok/procore-ultimate`**
   (authorize the Railway GitHub app for the repo if prompted). Choose the branch you
   deploy from (`main` unless you have a release branch). If the import flow asks which
   app/package to deploy, choose the repository root — never an individual package.
2. With the service rooted at `/`, Railway reads **`railway.json`** at the repo root
   automatically. You should see, without configuring anything by hand:
   - builder: **Dockerfile** (`Dockerfile` at repo root)
   - healthcheck path: **`/api/v1/health`**, timeout 180 s
   - restart policy: on-failure, max 5 retries
3. **Do not let the first deploy finish before variables are set** (next step). Without a
   real `AUTH_SECRET` the container refuses to boot — by design (`apps/api/src/config.ts`
   `loadConfig`) — and will just burn its 5 restart retries. Set variables first, then
   deploy (Railway queues variable changes into the next deploy).

### 2.5 Set environment variables

Service → **Variables**. Set exactly these:

| Variable | Value | Notes |
|---|---|---|
| `AUTH_SECRET` | output of `openssl rand -hex 32` | Run the command locally; paste the 64-char hex string. The app refuses to boot in production with the dev default (`config.ts`). Treat as a crown-jewel secret — it signs every JWT. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway reference variable → the **private** URL. **Never** use `DATABASE_PUBLIC_URL`: it routes over the public internet, costs egress, and exposes the DB endpoint. If your Postgres service has a different name, use that name in the reference. |
| `STORAGE_DRIVER` | `s3` | Selects the S3 driver in `apps/api/src/app.ts`. |
| `S3_ENDPOINT` | `https://storage.railway.app` | Railway Buckets endpoint. |
| `S3_REGION` | `auto` | |
| `S3_BUCKET` | *bucket name from §2.3* | |
| `S3_ACCESS_KEY_ID` | *from §2.3* | |
| `S3_SECRET_ACCESS_KEY` | *from §2.3* | |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | **Optional.** Without it the platform runs fully; AI routes return `503 AiDisabled` (`modules/ai/service.ts`). |
| `AI_MODEL` | e.g. `claude-opus-5` | **Optional**, has a default (`config.ts`). |

Everything else is already correct inside the image (`Dockerfile` `ENV` block):
`NODE_ENV=production`, `PORT=4000`, `HOST=0.0.0.0`, `TRUST_PROXY=true` (required so
rate limiting and logs see real client IPs behind Railway's proxy),
`MIGRATIONS_DIR=/app/migrations`, `WEB_DIST_DIR=/app/public`. Full reference table in §4.1.

### 2.6 Deploy and attach a domain

1. Trigger the deploy (it may already be queued from service creation). Watch build logs:
   pnpm install → build → `pnpm deploy` prune, then the runtime image.
2. Service → **Settings → Networking**: **Generate Domain** for a `*.up.railway.app` URL,
   or **Custom Domain** → add e.g. `app.yourdomain.com` and create the CNAME record Railway
   shows you. Railway provisions TLS automatically. Point the domain at the port Railway
   detected from the image (`EXPOSE 4000`).
3. HTTPS is terminated by Railway's edge; the app sends HSTS and the rest of its security
   headers itself via helmet (`apps/api/src/app.ts`).

### 2.7 First-boot verification

Migrations run automatically inside app startup, before the server listens
(`apps/api/src/lib/db.ts` `createDb` → drizzle `migrate`). **There is no release command
and no manual migration step.** The healthcheck's 180 s timeout exists to cover first-boot
migration time.

1. Deploy logs should show Fastify start: `ConstructOS API listening on 0.0.0.0:4000`.
2. Hit the health endpoint:

   ```bash
   curl https://<your-domain>/api/v1/health
   # {"ok":true,"db":"postgres","time":"..."}
   ```

   **`"db"` must say `"postgres"`.** If it says `"pglite"`, `DATABASE_URL` is not set or
   not resolving — the app has silently fallen back to an embedded database inside the
   container, which is **ephemeral and lost on the next deploy**. Stop and fix before
   creating any data.
3. Load `https://<your-domain>/` — the SPA should render (served same-origin by the API;
   no CORS, no proxy involved).

### 2.8 Register the first account

1. Open `https://<your-domain>/register`.
2. Register with your email, password, and a **company name**. The first user creates the
   company and becomes its **owner** (`modules/identity/index.ts` — registration seeds the
   tenant with built-in permission templates).
3. Log in, create a project, upload a small PDF to confirm the S3 write path end-to-end
   (a failed S3 write surfaces as a 5xx on upload — check service logs).

Note honestly: **registration is open** — anyone who can reach the URL can create a new
tenant (`docs/security.md` §8). Acceptable for a controlled rollout; revisit before broad
exposure.

---

## 3. Production hardening checklist

Work through all of these before declaring the deployment production.

### 3.1 Database: backups + PITR, verified by an ACTUAL restore rehearsal

An unverified backup is a hypothesis. The rehearsal, concretely:

1. Confirm the backup schedule on the Postgres service's volume and that PITR is active
   (§2.2). Record the retention window somewhere your team can find.
2. **Restore to a sibling**: use Railway's restore flow to materialize a backup / PITR
   point as a *new* Postgres service in the same project (never restore over production).
3. **Point a staging copy of the app at it**: duplicate the app service (or create a
   second service from the same repo), set its `DATABASE_URL` reference to the restored
   sibling, same bucket variables (reads are harmless — objects are content-addressed and
   immutable), deploy, and check `/api/v1/health` says `postgres`.
4. **Verify the evidence ledger on the restored copy**: log in as a company owner and call
   `GET /api/v1/ledger/verify` (bearer token + `x-company-id` header — assurance module).
   It must return a clean verification. This is the whole point for this platform: a
   restore that loses or reorders ledger entries is not a restore.
5. Tear down the staging service and the sibling database.
6. Put the rehearsal on a calendar (quarterly at minimum). Write down the measured
   restore time — that is your actual RTO.

### 3.2 Bucket: schedule an off-platform copy

Railway Buckets currently offer **no object versioning and no object lock** — a deleted or
overwritten object is gone. For an evidentiary store that is not acceptable as the only
copy. Mitigations, in the app and in ops:

- The app never overwrites: objects are content-addressed (`<companyId>/<sha2>/<sha256>`,
  `apps/api/src/lib/storage-s3.ts`), so a given key's content can never legitimately
  change. That makes replication trivially incremental and append-only.
- **Schedule a sync to a second S3 target off Railway** (any provider: AWS S3, R2, MinIO —
  the driver-visible interface is identical). With rclone:

  ```bash
  # one-time: rclone config — provider "s3", endpoint https://storage.railway.app,
  # region auto, the bucket's keys; plus a remote for the destination.
  rclone sync railway:constructos-files offsite:constructos-files-replica --immutable
  ```

  `--immutable` is safe *because* keys are content-addressed — any attempted change of an
  existing key is itself a signal worth alerting on. `aws s3 sync` with
  `--endpoint-url https://storage.railway.app` works equally.
- Run it from a scheduled job (Railway cron service, GitHub Actions cron, or any box you
  trust). Daily minimum; hourly for active projects. Alert on non-zero exit.

### 3.3 Log forwarding

Railway retains service logs **30 days on the Pro plan** (verify your plan's current
number). The app logs structured JSON via pino to stdout (`LOG_LEVEL`, default `info`,
`apps/api/src/config.ts`). If compliance needs longer retention or SIEM ingestion:

- Deploy a **Vector sidecar service** in the same project that ships logs to your sink
  (S3, Datadog, Loki, …), per Railway's current log-forwarding guidance.
- Note the tamper-evident audit trail does **not** depend on platform logs: auth events
  are in the `auth_events` table and consequential mutations are in the hash-chained
  ledger, both in Postgres and covered by §3.1.

### 3.4 Enable the CDN for static assets

Enable Railway's CDN option on the service/domain (Networking settings). The app already
sends the right cache headers for it (`apps/api/src/app.ts`): hashed `/assets/*` are
`public, max-age=31536000, immutable`; `index.html` is `no-cache`. The CDN therefore
caches aggressively and correctly with zero app changes.

### 3.5 Usage alerts and a NON-destructive spending limit

Workspace → Usage/Billing settings:

- Set **usage email alerts** at thresholds that give you reaction time.
- If you set a limit, set a **soft limit** (notification). **Warning: the hard limit
  takes your workloads offline when crossed** — for a system holding contractual
  time-bar deadlines and an evidence ledger, an availability outage caused by a billing
  guard is worse than the overage. Do not set a hard limit on this project.

### 3.6 Scaling notes

- With `STORAGE_DRIVER=s3` + Postgres, the app service is stateless → **replicas are
  safe** (Railway service settings → replicas). Two caveats:
  - Rate limiting (`@fastify/rate-limit`, `apps/api/src/app.ts`) keeps its counters
    in-memory per replica — the effective per-IP ceiling is `limit × replicas`. Fine at
    small replica counts; revisit the numbers if you scale wide.
  - Each replica opens up to **10 Postgres connections** (`postgres(url, { max: 10 })`,
    `apps/api/src/lib/db.ts`). Budget accordingly.
- **The database is the bottleneck**, not the app. Scale Postgres vertically first. When
  connection counts grow (many replicas, or sidecar jobs), put Railway's **PgBouncer
  template** between app and DB and point `DATABASE_URL` at it (transaction pooling mode).

---

## 4. Ops reference

### 4.1 Environment variables — complete table

Source of truth: `apps/api/src/config.ts` (zod schema — unknown/invalid shapes fail at
boot). "Image" = value baked into `Dockerfile`; set in Railway only what §2.5 lists.

| Variable | Default (`config.ts`) | Image sets | Required when |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | — (leave image value) |
| `PORT` | `4000` | `4000` | — (app honors an injected `PORT`) |
| `HOST` | `0.0.0.0` | `0.0.0.0` | — |
| `DATABASE_URL` | unset → embedded PGlite fallback | — | **Always in production.** Unset means ephemeral in-container data. |
| `PGLITE_DIR` | `./.pglite` | `/data/pglite` | Only used when `DATABASE_URL` unset |
| `AUTH_SECRET` | dev-only default (min 16 chars) | — | **Always.** Production boot refuses the default. |
| `ACCESS_TOKEN_TTL_SECONDS` | `3600` | — | Optional tuning |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | — | Optional tuning |
| `STORAGE_DRIVER` | `local` | — | Set `s3` in production |
| `STORAGE_DIR` | `./data/storage` | `/data/storage` | Local driver only |
| `S3_ENDPOINT` | unset | — | Required when `STORAGE_DRIVER=s3` (boot refuses otherwise) |
| `S3_REGION` | `auto` | — | `auto` for Railway Buckets |
| `S3_BUCKET` | unset | — | Required when `STORAGE_DRIVER=s3` |
| `S3_ACCESS_KEY_ID` | unset | — | Required when `STORAGE_DRIVER=s3` |
| `S3_SECRET_ACCESS_KEY` | unset | — | Required when `STORAGE_DRIVER=s3` |
| `S3_FORCE_PATH_STYLE` | `false` | — | `true` for MinIO/self-hosted endpoints |
| `WEB_DIST_DIR` | unset (SPA serving off) | `/app/public` | — |
| `MIGRATIONS_DIR` | unset (repo-relative search) | `/app/migrations` | — |
| `TRUST_PROXY` | `false` | `true` | Must be `true` behind Railway's proxy |
| `TRUST_PROXY_HOPS` | `1` | — | Raise only when a CDN sits in front of the Railway edge. Each increment is one more hop whose word is taken for the client's address. |
| `CORS_ORIGINS` | `""` | — | Only when a browser on another origin calls the API. `APP_BASE_URL`'s origin is always allowed. |
| `ALLOW_EMBEDDED_DB` | `false` | — | Set only for a deliberate throwaway environment — production otherwise refuses to boot without `DATABASE_URL`. |
| `ALLOW_LOCAL_STORAGE` | `false` | — | Set only for the volume topology (§1.1). |
| `UPLOAD_MAX_BYTES` | `268435456` (256 MiB) | — | Bounds memory per in-flight upload (multipart is buffered per request). |
| `UPLOAD_MAX_FILES` | `25` | — | Optional tuning |
| `DATABASE_POOL_MAX` | `10` | — | Multiply by replica count and compare with Postgres `max_connections` before raising. |
| `SCHEDULER_ENABLED` | `true` | — | Leave on. Off means the sweeps (session/invitation expiry, security-webhook delivery, deadline detection, heartbeat seals) do not run at all — not "later". |
| `SCHEDULER_TICK_MS` | `60000` | — | Tick granularity; a job's `everyMs` rounds up to it. |
| `RATE_LIMIT_ENABLED` | `true` | — | — |
| `RATE_LIMIT_MAX_PER_MINUTE` | `300` | — | Optional tuning (per IP, per replica) |
| `AUTH_RATE_LIMIT_MAX_PER_MINUTE` | `10` | — | Optional tuning (credential endpoints). NOT a lockout — see §4.6. |
| `WEBHOOK_SIGNING_KEY` | unset → derived from `AUTH_SECRET` | — | Set it: under the fallback anyone who can read the JWT secret can forge a webhook signature a receiver would accept. |
| `WEBHOOK_ALLOW_HOSTS` | unset | — | Comma-separated hosts exempt from the SSRF refusal. Use only for a receiver inside your own network. |
| `SSO_ENCRYPTION_KEY` | unset → derived from `AUTH_SECRET` | — | Set it before configuring SSO or MFA. **Rotating it makes every stored client secret and TOTP seed unreadable** — re-encrypt first. |
| `ANCHOR_SIGNING_KEY` | unset → derived from `AUTH_SECRET` | — | Set it, or seals prove integrity against a database-only attacker and not against the operator. |
| `ANCHOR_TRUSTED_FINGERPRINTS` | unset | — | Pin out of band; see `.env.example`. |
| `ANCHOR_TSA_URL`, `ANCHOR_OTS_CALENDAR_URL` | unset | — | Optional external timestamping. |
| `ANCHOR_HEARTBEAT_HOURS` | `24` | — | Bounds how long a tail truncation can hide. |
| `ANTHROPIC_API_KEY` | unset | — | Optional — AI routes 503 without it |
| `AI_MODEL` | `claude-opus-5` | — | Optional |
| `LOG_LEVEL` | `info` | — | Optional (`debug`, `warn`, …) |

There are deliberately **no environment variables** for the session timeout, password
policy, lockout thresholds or IP allowlist. Those are **per tenant**, set by an owner or
admin at `PUT /api/v1/company/security-policy` (web app → Security). The `LOGIN_*`,
`SESSION_*` and `BCRYPT_COST` values are the platform DEFAULTS a tenant that has chosen
nothing inherits; a tenant may tighten them and can never loosen them below the platform
floor. See §4.6.

### 4.2 Upgrade and rollback

- **Upgrade**: push to the deployed branch → Railway builds the Dockerfile and deploys.
  The healthcheck gates cutover — a build that cannot boot (bad variable, failed
  migration) never replaces the running deployment.
- **The healthcheck is READINESS, not liveness.** `railway.json` points at
  `/api/v1/health/ready`, which executes `select 1` against the database before
  answering. `/api/v1/health` only proves the process is listening, and a container that
  is listening while unable to reach Postgres would have passed it. Readiness answers
  200 **with** configuration warnings present — a warning describes a smaller
  deployment, not a broken one — and 503 only when a check genuinely failed.
- **CI gates the deploy.** `.github/workflows/deploy-railway.yml` triggers on the
  *completion* of the CI workflow and refuses to run unless that run concluded
  `success`, then checks out `workflow_run.head_sha` — the exact commit CI tested, not
  whatever the branch tip has become since. A manual `workflow_dispatch` is an operator's
  deliberate act and is not gated.
- **Migrations are forward-only and run at boot** (`lib/db.ts`). Write additive
  migrations: rolling back the *app image* does not roll back the *schema*, so an old
  image must tolerate the new schema. This repo's drizzle migrations are committed under
  `packages/db/drizzle` and copied into the image at build time.
- **Rollback**: service → Deployments → previous deployment → rollback/redeploy. Railway
  retains prior images ~120 h on Pro (verify current retention on your plan) — within
  that window rollback is instant, no rebuild. After it, rollback = redeploy of the old
  git commit.

### 4.3 Reading logs

- Dashboard: service → the observability/logs view. CLI: `railway logs` (after
  `railway link` to the project/service).
- Logs are single-line JSON (pino). Request logs carry `reqId`; 5xx handler logs the
  error server-side while returning a generic message to clients in production
  (`app.ts` error handler).
- Build logs and deploy (runtime) logs are separate streams — boot refusals (§4.4) appear
  in the *deploy* logs.

### 4.4 Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Boot loop; deploy log: `Refusing to start: AUTH_SECRET is the development default` | Guard in `config.ts` `loadConfig` — working as designed | Set `AUTH_SECRET` (§2.5), redeploy |
| Boot loop; `STORAGE_DRIVER=s3 requires: S3_ENDPOINT, ...` | S3 driver selected but variables missing (`config.ts` production check) | Set the listed variables |
| Boot loop; `Drizzle migrations folder not found` | `MIGRATIONS_DIR` points nowhere — only possible with a modified image/build; the stock `Dockerfile` copies `packages/db/drizzle` → `/app/migrations` | Restore the `Dockerfile` COPY + `MIGRATIONS_DIR=/app/migrations` |
| `/api/v1/health` returns `"db":"pglite"` | `DATABASE_URL` unset or reference not resolving | Fix the `${{Postgres.DATABASE_URL}}` reference. Any data created meanwhile lives only inside the container and dies on redeploy. |
| Healthcheck timeout on deploy | Migration failure or crash before listen | Read deploy logs; the app fails loudly before binding the port |
| Everyone hits 429 at once | `TRUST_PROXY` not `true` → all traffic keyed on the proxy's IP for rate limiting | Keep the image default `TRUST_PROXY=true`; don't override it |
| Upload fails `EACCES` (volume mode only) | Railway mounts volumes as root; image runs as `USER node` | Set `RAILWAY_RUN_UID=0` on the service (§1.1) |
| AI routes return `503 AiDisabled` | No `ANTHROPIC_API_KEY` | Intentional degradation; set the key to enable |
| SSO sign-in fails ~half the time with "this sign-in link is not valid any more" | More than one replica **and** `DATABASE_URL` unset, so the authorization-code state lives in one process's memory and the callback lands on another | Set `DATABASE_URL`. With a shared Postgres the SSO flow/ticket store is a table (`sso_flows`, `sso_tickets`) and any replica can complete any sign-in. |
| Everyone in a company is refused with "your organisation only permits sign-in from approved networks" | An IP allowlist was set to `enforce` with the wrong ranges, or `TRUST_PROXY` is off so every request appears to come from the proxy | An owner on the break-glass list can still sign in and fix it (`ipAllowlistBreakGlassUserIds`). Otherwise set `ipAllowlistMode` back to `off` in `company_security_policies`. Introduce allowlists in `monitor` mode first. |
| A SIEM stops receiving security webhooks and nothing is logged | 20 consecutive delivery failures disabled the endpoint | The row carries `disabledReason`. Fix the destination, then re-enable it — re-enabling clears the failure count. |
| SCIM calls answer 401 with a SCIM error document | The bearer token was revoked, expired, or is a user access token rather than a `scim_…` token | Mint a new one at `POST /api/v1/company/scim/tokens`; it is shown once. |

### 4.5 Replica safety — what is and is not shared

| Concern | Shared across replicas? | Where it lives |
|---|---|---|
| Application data | Yes | Postgres |
| Uploaded evidence | Yes **with `STORAGE_DRIVER=s3`**; no with `local` | Bucket / container disk |
| SSO authorization-code state and tickets | Yes **when `DATABASE_URL` is set** | `sso_flows` / `sso_tickets` |
| Scheduler jobs | Yes — one runner per job via a Postgres advisory lock | `lib/scheduler.ts` |
| Ledger appends | Yes — serialised per company by an advisory lock | `lib/ledger.ts` |
| Account and IP lockout counters | Yes — derived from `auth_security_events`, not from process memory | `modules/account/lockout.ts` |
| `@fastify/rate-limit` counters | **No** — per process | In-memory. `RATE_LIMIT_MAX_PER_MINUTE` is therefore per replica; the lockout engine, which is not, is the control that actually stops credential guessing. |
| MFA challenge tokens | N/A — stateless, MAC-authenticated | `modules/mfa/challenge.ts` |

### 4.6 Tenant security policy (spec #23, #24, #25)

Each company sets its own policy; a person who belongs to several companies is governed
by the **strictest** of them, because a session is an account-level object that can read
every tenant the holder belongs to.

| Setting | Effect | Platform default |
|---|---|---|
| `sessionIdleTimeoutMinutes` | Sign out a session idle this long | none |
| `sessionAbsoluteTimeoutHours` | Hard ceiling on a session's age | 720 (30 days) |
| `passwordMinLength` | Minimum length (floor 12, may only be raised) | 12 |
| `passwordRequireComplexity` | Require upper, lower, digit and symbol | off |
| `passwordHistoryDepth` | Refuse the last N passwords (ceiling 24) | 0 |
| `passwordMaxAgeDays` | Maximum password age | none |
| `lockoutMaxAttempts` / `WindowMinutes` / `DurationMinutes` | Account lockout | 5 / 15 / 15 |
| `ipAllowlistMode` + `ipAllowlist` | `off`, `monitor` (records) or `enforce` (refuses) | off |
| `ipAllowlistBreakGlassUserIds` | Members exempt from the allowlist | empty |
| `mfaRequired` | Require a second factor, including for SSO | off |

**Introduce an allowlist in `monitor` first.** It records every sign-in it would have
refused (`login_blocked_ip`, outcome `pending`) without refusing anything, so you can
read a week of real traffic before enforcing. The API refuses to enable `enforce` from an
address the new list would itself refuse.

### 4.7 SCIM 2.0 provisioning (spec #21)

Base URL `https://<your-host>/api/v1/scim/v2`. Authentication is a per-tenant bearer
token minted at `POST /api/v1/company/scim/tokens` and shown exactly once.

- `Users` supports GET (filter `userName eq "…"`, `active eq true|false`), POST, GET/:id,
  PUT, PATCH and DELETE.
- `Groups` are this platform's four **company roles** (`owner`, `admin`, `member`,
  `guest`). Per-project permission templates are not exposed: SCIM has no concept of a
  project, so a directory cannot know which projects exist. `ServiceProviderConfig` says
  so in the discovery document rather than only here.
- `active: false` (via PUT, PATCH or DELETE) removes the company membership, revokes the
  sessions opened in that company, and deactivates the account platform-wide when it
  belongs to no other company.
- The `owner` role is never removed by a directory: an IdP mapping mistake that removed
  every owner would leave the tenant with nobody able to fix it.

### 4.8 Security event webhooks

`POST /api/v1/company/security-webhooks` registers a destination for a tenant's
`auth_security_events`. Deliveries are signed exactly like the integrations webhooks
(`x-constructos-signature: v1=HMAC-SHA256` over `v1:<timestamp>:<deliveryId>:<body>`), so
one verifier serves both. Delivery is at-least-once — dedupe on
`x-constructos-delivery`. Retries back off quadratically to a 30-minute ceiling over five
attempts; twenty consecutive failures disable the endpoint with a stated reason, because
a webhook that has been silently failing for a month is worse than one that is visibly
off. Destinations are re-checked against the SSRF policy on **every** delivery, not only
at registration, because DNS moves.

---

## 5. When to leave Railway

Railway is the right call for this stage: one image, managed Postgres, managed buckets,
minutes to deploy. Leave when a requirement appears that the platform structurally cannot
meet:

- **Data residency in the Gulf or Africa** — Railway regions are US/EU/Southeast Asia;
  a tender requiring in-country hosting (KSA, UAE, Nigeria, …) cannot be satisfied.
- **BYOC / on-prem** — a client or regulator requires the system inside their cloud
  account or building.
- **CMEK** — customer-managed encryption keys over database and object storage.
- **Contractual SLA / bespoke DPA** — enterprise procurement wanting signed availability
  numbers beyond platform terms.

The exit is deliberately cheap, and worth stating precisely: **the Docker image and the
S3 storage driver work unchanged off Railway.** The AWS path is: run the same image on
ECS/Fargate (or any container host), point `DATABASE_URL` at RDS Postgres (schema
migrates itself at boot), set `S3_ENDPOINT`/`S3_REGION`/credentials to real AWS S3, and
copy the bucket with `rclone sync` — storage keys are content-addressed
(`lib/storage-s3.ts`), so object identity survives the move and no database rows change.
Nothing in the application is Railway-specific.
