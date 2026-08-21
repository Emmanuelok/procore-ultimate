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

## 2. Runbook

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

1. Project canvas → **Create → GitHub Repo** → select **`Emmanuelok/procore-ultimate`**
   (authorize the Railway GitHub app for the repo if prompted). Choose the branch you
   deploy from (`main` unless you have a release branch).
2. Railway reads **`railway.json`** at the repo root automatically. You should see, without
   configuring anything by hand:
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
| `RATE_LIMIT_ENABLED` | `true` | — | — |
| `RATE_LIMIT_MAX_PER_MINUTE` | `300` | — | Optional tuning (per IP, per replica) |
| `AUTH_RATE_LIMIT_MAX_PER_MINUTE` | `10` | — | Optional tuning (credential endpoints) |
| `ANTHROPIC_API_KEY` | unset | — | Optional — AI routes 503 without it |
| `AI_MODEL` | `claude-opus-5` | — | Optional |
| `LOG_LEVEL` | `info` | — | Optional (`debug`, `warn`, …) |

### 4.2 Upgrade and rollback

- **Upgrade**: push to the deployed branch → Railway builds the Dockerfile and deploys.
  The healthcheck (`/api/v1/health`) gates cutover — a build that cannot boot (bad
  variable, failed migration) never replaces the running deployment.
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
