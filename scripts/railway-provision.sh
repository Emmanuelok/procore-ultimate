#!/usr/bin/env bash
# =============================================================================
# ConstructOS — Railway production provisioning
#
# Run this LOCALLY from the repo root on a machine where you are (or can be)
# signed in to Railway. It provisions the full production stack:
#
#   1. Railway project (linked to this directory)
#   2. PostgreSQL  + PITR (continuous backups) + daily/weekly volume backups
#   3. Storage bucket + S3 credentials
#   4. The app service with every required environment variable
#   5. First deploy (from your local checkout) + a public domain
#
# Prerequisites:
#   - Railway CLI:  npm i -g @railway/cli   (or: brew install railway)
#   - Signed in:    railway login           (the script checks)
#   - Run from the repo root (Dockerfile + railway.json are auto-detected)
#
# Configuration (env vars, all optional):
#   PROJECT_NAME   Railway project name          (default: constructos)
#   SERVICE_NAME   app service name              (default: constructos)
#   DB_SERVICE     Postgres service name         (default: Postgres)
#   BUCKET_NAME    bucket name                   (default: constructos-files)
#   BUCKET_REGION  sjc | iad | ams | sin         (default: ams)
#   ENABLE_HA=1    also convert Postgres to an HA cluster (see §2.2 of the
#                  runbook — do this BEFORE go-live, never after)
#   ANTHROPIC_API_KEY  if set, passed to the service to enable AI features
#
# Idempotence: each step detects "already exists" failures and continues, so
# re-running after a partial failure is safe. Nothing here is destructive.
# =============================================================================
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-constructos}"
SERVICE_NAME="${SERVICE_NAME:-constructos}"
DB_SERVICE="${DB_SERVICE:-Postgres}"
BUCKET_NAME="${BUCKET_NAME:-constructos-files}"
BUCKET_REGION="${BUCKET_REGION:-ams}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }

command -v railway >/dev/null 2>&1 || {
  echo "Railway CLI not found. Install with: npm i -g @railway/cli" >&2
  exit 1
}
[ -f Dockerfile ] && [ -f railway.json ] || {
  echo "Run this from the ConstructOS repo root (Dockerfile/railway.json not found)." >&2
  exit 1
}

step "Checking Railway authentication"
railway whoami || { echo "Not signed in — run: railway login" >&2; exit 1; }

# --- 1. Project ------------------------------------------------------------
step "Project: ${PROJECT_NAME}"
if railway status >/dev/null 2>&1; then
  bold "Directory already linked to a Railway project — reusing it."
  railway status || true
else
  railway init --name "${PROJECT_NAME}"
fi

# --- 2. PostgreSQL ---------------------------------------------------------
step "PostgreSQL service"
if railway service list 2>/dev/null | grep -qi "^${DB_SERVICE}$"; then
  bold "Postgres service '${DB_SERVICE}' already exists — skipping create."
else
  railway add --database postgres
  bold "Postgres added. If Railway named it something other than '${DB_SERVICE}',"
  bold "re-run with DB_SERVICE=<name> so the backup steps target it."
  railway service list || true
fi

step "Postgres: point-in-time recovery (continuous backups)"
railway postgres pitr enable --service "${DB_SERVICE}" \
  || warn "PITR enable failed or already enabled — check: railway postgres pitr status --service ${DB_SERVICE}"

step "Postgres: automatic volume backup schedule (daily + weekly)"
railway postgres pitr schedule set --daily --weekly --service "${DB_SERVICE}" \
  || warn "Backup schedule failed — set it manually: railway postgres pitr schedule set --daily --weekly --service ${DB_SERVICE}"

if [ "${ENABLE_HA:-0}" = "1" ]; then
  step "Postgres: converting to a high-availability cluster (this changes DB endpoints)"
  railway postgres ha convert --service "${DB_SERVICE}" -y \
    || warn "HA conversion failed — see: railway postgres ha status --service ${DB_SERVICE}"
else
  warn "HA not enabled (set ENABLE_HA=1 to convert). Convert BEFORE go-live if you"
  warn "need automatic failover — conversion drops connections and changes endpoints."
fi

# --- 3. Bucket --------------------------------------------------------------
step "Storage bucket: ${BUCKET_NAME} (${BUCKET_REGION})"
if railway bucket list 2>/dev/null | grep -qx "${BUCKET_NAME}"; then
  bold "Bucket '${BUCKET_NAME}' already exists — reusing it."
else
  railway bucket create "${BUCKET_NAME}" --region "${BUCKET_REGION}"
fi

step "Fetching bucket S3 credentials"
# `railway bucket credentials` prints eval-ready AWS_*=value lines.
CREDS="$(railway bucket -b "${BUCKET_NAME}" credentials)"
get_cred() { printf '%s\n' "${CREDS}" | sed -n "s/^${1}=//p" | head -1; }
S3_ACCESS_KEY_ID="$(get_cred AWS_ACCESS_KEY_ID)"
S3_SECRET_ACCESS_KEY="$(get_cred AWS_SECRET_ACCESS_KEY)"
S3_ENDPOINT="$(get_cred AWS_ENDPOINT_URL)"
S3_ENDPOINT="${S3_ENDPOINT:-https://storage.railway.app}"
if [ -z "${S3_ACCESS_KEY_ID}" ] || [ -z "${S3_SECRET_ACCESS_KEY}" ]; then
  echo "Could not parse bucket credentials. Output was:" >&2
  printf '%s\n' "${CREDS}" >&2
  exit 1
fi
bold "Bucket credentials obtained (endpoint: ${S3_ENDPOINT})"

# --- 4. App service ---------------------------------------------------------
step "App service: ${SERVICE_NAME} (with production environment variables)"
AUTH_SECRET_VALUE="$(openssl rand -hex 32)"
if railway service list 2>/dev/null | grep -qi "^${SERVICE_NAME}$"; then
  bold "Service '${SERVICE_NAME}' already exists — updating variables instead."
  railway service "${SERVICE_NAME}"
  warn "Keeping the service's existing AUTH_SECRET (changing it logs everyone out)."
  railway variable set \
    "DATABASE_URL=\${{${DB_SERVICE}.DATABASE_URL}}" \
    "STORAGE_DRIVER=s3" \
    "S3_ENDPOINT=${S3_ENDPOINT}" \
    "S3_REGION=auto" \
    "S3_BUCKET=${BUCKET_NAME}" \
    "S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}" \
    "S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}"
else
  railway add --service "${SERVICE_NAME}" \
    --variables "AUTH_SECRET=${AUTH_SECRET_VALUE}" \
    --variables "DATABASE_URL=\${{${DB_SERVICE}.DATABASE_URL}}" \
    --variables "STORAGE_DRIVER=s3" \
    --variables "S3_ENDPOINT=${S3_ENDPOINT}" \
    --variables "S3_REGION=auto" \
    --variables "S3_BUCKET=${BUCKET_NAME}" \
    --variables "S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}" \
    --variables "S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}"
  railway service "${SERVICE_NAME}"
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  step "Enabling AI features (ANTHROPIC_API_KEY provided)"
  railway variable set "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" "AI_MODEL=claude-opus-5"
else
  warn "ANTHROPIC_API_KEY not set — AI endpoints will report themselves disabled."
  warn "Enable later with: railway variable set ANTHROPIC_API_KEY=sk-ant-..."
fi

# --- 5. Deploy + domain ------------------------------------------------------
step "First deploy (uploading local checkout; Dockerfile build ~5-8 min)"
railway up --ci --service "${SERVICE_NAME}"

step "Public domain"
railway domain || warn "Domain generation failed — run 'railway domain' manually."

# --- Done --------------------------------------------------------------------
step "Provisioning complete"
cat <<'NEXT'
Next steps:
  1. Verify the deployment end-to-end:
       ./scripts/post-deploy-smoke.sh https://<your-domain>
     (it checks health/db, SPA, auth, project creation, file round-trip
      through the bucket, and ledger integrity — and registers a throwaway
      account you can delete)
  2. Open the app, register YOUR real account — the first registration
     creates your company and owns it.
  3. Rehearse a database restore BEFORE trusting production
     (docs/deployment.md §3.1):
       railway postgres pitr restore --service Postgres --at 30m
  4. Schedule an off-platform copy of the bucket (docs/deployment.md §3.2)
     — Railway buckets have no versioning or object-lock.
  5. Continuous deploys: connect the GitHub repo to the service
     (Dashboard → service → Settings → Source), or keep deploying with
     'railway up' from your machine.
NEXT
