# Mission brief: publish ConstructOS live on Railway

> **Who this is for:** a Claude agent (Claude Cowork / Claude Code) running on the
> owner's own machine — with a real browser, a real terminal, and unrestricted
> access to railway.com. Execute this mission end-to-end on the owner's behalf.
> The owner of this repository and Railway account is the human you are working
> for; call them "the owner" below.

## Mission

Deploy the ConstructOS platform (this repository) to Railway as a live
production service, verify it end-to-end, and hand the owner a working URL.
Success = the post-deploy smoke test passes and the owner has registered the
first account.

## Context you need

- **Repo:** `https://github.com/Emmanuelok/procore-ultimate`, branch
  **`claude/ai-saas-construction-platform-9bkv1v`** (this is the live branch;
  `main` is only the historical base of PR #1).
- **What it is:** a construction delivery + assurance SaaS. One Docker
  container serves the API and the web app together; migrations run
  automatically at boot. It needs exactly three Railway components: **one app
  service** (built from the repo-root `Dockerfile` — auto-detected via
  `railway.json`), **one PostgreSQL**, **one storage bucket**.
- **Two scripts in this repo do almost all the work:**
  - `scripts/railway-provision.sh` — provisions everything via the Railway CLI
    (project, Postgres + backups + PITR, bucket + credentials, app service with
    all variables including a generated `AUTH_SECRET`, first deploy, public
    domain). Idempotent: safe to re-run after a partial failure. Reads env
    options: `BUCKET_REGION` (sjc|iad|ams|sin), `ENABLE_HA=1`, `PROJECT_NAME`,
    `DB_SERVICE`.
  - `scripts/post-deploy-smoke.sh <url>` — verifies the live deployment:
    health (and that the DB is really Postgres), SPA + deep-link fallback,
    security headers, register/login, project creation, a file round-trip
    through the bucket (byte-compared), ledger integrity. Green line
    "All checks passed" = done. Needs bash, curl, node (on Windows use WSL or
    Git Bash).

## Known history — one critical pitfall

A previous attempt used Railway's **"Deploy from GitHub repo"** import, and
Railway split the pnpm monorepo into two per-package services
(`@constructos/api`, `@constructos/web`). Both can never build that way (the
web service dies with ``The executable `pnpm` could not be found``). The rule:
**ONE service, Root Directory `/`, builder must show "Dockerfile"** — never
per-package services, never Railpack. The CLI path below avoids this entirely.
If the owner's project `ideal-prosperity` still contains those two failed
services, delete them (and only them) first:
`railway service "@constructos/api" delete` and the same for
`@constructos/web` — or via dashboard: service → Settings → Delete service.
Do **not** delete anything else.

## Execution plan (primary path — CLI)

1. **Preflight.** Confirm tools: `git --version`, `node --version` (≥ 20),
   `npm --version`. Clone the repo if not present:
   `git clone https://github.com/Emmanuelok/procore-ultimate && cd procore-ultimate`
   — then `git checkout claude/ai-saas-construction-platform-9bkv1v && git pull`.
2. **Install the Railway CLI:** `npm i -g @railway/cli` (or
   `brew install railway` on macOS). Verify with `railway --version`.
3. **Authenticate:** run `railway login`. This opens a browser (or prints a
   device code on headless machines). **Pause and let the owner complete the
   sign-in** — never enter credentials yourself.
4. **Billing check.** If Railway prompts for a plan upgrade or payment method
   at any point: **stop and hand control to the owner.** Never enter or confirm
   payment details. A Hobby ($5/mo) or Pro plan is sufficient.
5. **Choose the project.** If the owner wants to reuse `ideal-prosperity`:
   `railway link` and select it (environment: production), then do the cleanup
   deletion from the pitfall section. Otherwise skip — the script creates a
   fresh project named `constructos`.
6. **Provision everything:**
   ```bash
   BUCKET_REGION=sjc ./scripts/railway-provision.sh
   ```
   (`sjc` = US West, matching the owner's earlier project region. Use `ams`
   for EU, `sin` for Asia-Pacific if the owner prefers.) Watch the output; the
   Docker build takes 5–8 minutes. The script prints the public domain at the
   end (`railway domain` re-prints it). If a step fails, read the error, fix
   the cause, and re-run the script — it skips what already exists.
7. **Verify:**
   ```bash
   ./scripts/post-deploy-smoke.sh https://<the-domain>
   ```
   Required outcome: **"All checks passed — deployment is live and healthy."**
   The one check that must never be rationalized away: `database is Postgres`.
   If it reports `pglite`, the `DATABASE_URL` variable is missing on the
   service — fix and redeploy before proceeding.
8. **Hand over for account creation.** Open `https://<domain>/register` in the
   browser and **ask the owner to register personally** — the first account
   creates and owns the company, so the credentials must be theirs, chosen by
   them. (The smoke test's throwaway `smoke-*@example.com` account can be
   ignored or deactivated later from Admin.)
9. **Post-launch hardening (do these, they're quick):**
   - Connect GitHub for auto-deploys: dashboard → app service → Settings →
     Source → repo `Emmanuelok/procore-ultimate`, branch
     `claude/ai-saas-construction-platform-9bkv1v`, **Root Directory `/`**.
   - Confirm backups: `railway postgres pitr status --service Postgres` and
     `railway postgres pitr schedule list --service Postgres` (the script
     enabled PITR + daily/weekly schedules; re-run those subcommands to fix if
     missing).
   - Optional, owner's call: custom domain (service → Settings → Networking),
     `ENABLE_HA=1` re-run for a high-availability Postgres cluster (do this
     BEFORE real data accumulates; it changes DB endpoints), and setting
     `ANTHROPIC_API_KEY` (`railway variable set ANTHROPIC_API_KEY=...` — ask
     the owner for the key; never invent one) to switch on the AI features.

## Fallback path (dashboard-only, if the CLI misbehaves)

All in the browser at railway.com: create PostgreSQL; create a Bucket named
`constructos-files` and copy its S3 credentials; create ONE service from the
GitHub repo (Root Directory `/`, branch as above, builder must say
Dockerfile); service → Variables → Raw Editor → paste, filling the bucket
values and a fresh secret from `openssl rand -hex 32`:

```
AUTH_SECRET=<openssl rand -hex 32>
DATABASE_URL=${{Postgres.DATABASE_URL}}
STORAGE_DRIVER=s3
S3_ENDPOINT=https://storage.railway.app
S3_REGION=auto
S3_BUCKET=constructos-files
S3_ACCESS_KEY_ID=<bucket credentials>
S3_SECRET_ACCESS_KEY=<bucket credentials>
```

Then Settings → Networking → Generate Domain, and continue from step 7 above.
Full operator detail lives in `docs/deployment.md` in this repo — consult it
for anything ambiguous; it is the authority over this brief on Railway
mechanics.

## Troubleshooting quick table

| Symptom | Cause → fix |
|---|---|
| Build fails, "pnpm could not be found" at container start | Service was created per-package (Railpack). Delete it; recreate with Root Directory `/` |
| Two services named `@constructos/api` / `@constructos/web` appeared | Same — the monorepo split. Delete both; one root service only |
| Health shows `"db":"pglite"` | `DATABASE_URL` not set on the service (must be the `${{Postgres.DATABASE_URL}}` reference). Set it; redeploy |
| Container exits immediately, log says AUTH_SECRET is the development default | Set a real `AUTH_SECRET` (the script generates one; dashboard path: `openssl rand -hex 32`) |
| Boot error naming S3 variables | `STORAGE_DRIVER=s3` set but one of the four S3_* values missing/wrong — recopy from bucket credentials |
| Smoke: file round-trip fails | Bucket credentials or bucket name mismatch; check `S3_BUCKET` matches the actual bucket name exactly |
| `railway` commands hang on login | Use `railway login` on a machine with a browser, or the printed device-code URL |

## Guardrails (non-negotiable)

- Never enter payment details, passwords, or 2FA codes — pause for the owner.
- Never delete any Railway resource except the two named broken services, and
  only after confirming their names match exactly.
- Never commit secrets to the repo or paste them into chat logs beyond what
  Railway's variable editor requires.
- Don't modify repository code for deployment reasons — the repo deploys
  as-is. If something seems to need a code change, stop and report instead.

## Report back to the owner

When finished, give the owner: the live URL; the smoke-test output (pass
count); which project/services exist now on Railway; confirmation that PITR +
backup schedules are on; what remains optional (custom domain, HA, AI key);
and anything you had to deviate on, with the reason.
