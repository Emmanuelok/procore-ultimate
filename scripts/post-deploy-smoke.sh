#!/usr/bin/env bash
# =============================================================================
# ConstructOS — post-deploy smoke test
#
# Verifies a LIVE deployment end-to-end:
#   health (+ that it is really on Postgres, not the embedded fallback),
#   SPA serving + client-route fallback, security headers, registration,
#   login, project creation, a document upload/download round-trip (proves
#   the S3/bucket wiring, byte-for-byte), and ledger chain integrity.
#
# Usage:   ./scripts/post-deploy-smoke.sh https://your-app.up.railway.app
#
# It registers a throwaway account (smoke-<timestamp>@example.com) that you
# can deactivate afterwards. Requires: bash, curl, node.
# =============================================================================
set -euo pipefail

BASE="${1:?usage: post-deploy-smoke.sh <base-url>}"
BASE="${BASE%/}"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[1;32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[1;31mFAIL\033[0m %s\n' "$1"; }
jget() { node -e 'let d={};try{d=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch{}const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],d);process.stdout.write(v===undefined||v===null?"":String(v))' "$1" 2>/dev/null || true; }

printf '\033[1mConstructOS smoke test → %s\033[0m\n' "$BASE"

# --- 1. health --------------------------------------------------------------
H="$(curl -sf "$BASE/api/v1/health" || true)"
[ -n "$H" ] && ok "liveness endpoint responds" || bad "liveness endpoint unreachable"
DB="$(printf '%s' "$H" | jget db)"
if [ "$DB" = "postgres" ]; then ok "database is Postgres"; else bad "database is '$DB' — DATABASE_URL is not set! (running on embedded fallback)"; fi

# --- 1b. readiness, and the reduced-shape warnings it reports ---------------
# Liveness says the process is up. READINESS executes a query against the
# database and names every configuration smell that makes this deployment
# smaller than it looks. Both are checked because a container that is up and
# cannot reach its database passes the first and fails the second.
RCODE="$(curl -s -o /tmp/constructos-ready.json -w '%{http_code}' "$BASE/api/v1/health/ready" || true)"
if [ "$RCODE" = "200" ]; then ok "readiness endpoint reports ready (200)"; else bad "readiness returned $RCODE — the deployment is up but not serving"; fi
DBOK="$(cat /tmp/constructos-ready.json 2>/dev/null | jget checks.database.ok)"
[ "$DBOK" = "true" ] && ok "readiness proved a live database query" || bad "readiness could not query the database"
WARNINGS="$(node -e 'let d={};try{d=JSON.parse(require("fs").readFileSync("/tmp/constructos-ready.json","utf8"))}catch{}const w=d.warnings||[];process.stdout.write(String(w.length))' 2>/dev/null || echo 0)"
if [ "$WARNINGS" = "0" ]; then
  ok "no configuration warnings"
else
  printf '  \033[1;33mWARN\033[0m %s configuration warning(s) reported by /api/v1/health/ready:\n' "$WARNINGS"
  node -e 'let d={};try{d=JSON.parse(require("fs").readFileSync("/tmp/constructos-ready.json","utf8"))}catch{}for(const w of d.warnings||[])console.log("        - "+w)' 2>/dev/null || true
  echo "        (warnings describe a smaller deployment, not a broken one — see docs/deployment.md)"
fi
rm -f /tmp/constructos-ready.json

# --- 2. SPA + headers -------------------------------------------------------
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
[ "$CODE" = 200 ] && ok "SPA index serves (200)" || bad "SPA index returned $CODE"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/projects")"
[ "$CODE" = 200 ] && ok "client-route fallback serves (200)" || bad "route fallback returned $CODE"
HDRS="$(curl -sI "$BASE/")"
printf '%s' "$HDRS" | grep -qi '^content-security-policy:' && ok "CSP header present" || bad "CSP header missing"
printf '%s' "$HDRS" | grep -qi '^strict-transport-security:' && ok "HSTS header present" || bad "HSTS header missing"

# --- 3. auth ----------------------------------------------------------------
EMAIL="smoke-$(date +%s)@example.com"
REG="$(curl -sf -X POST "$BASE/api/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"smoke-Passw0rd!\",\"name\":\"Smoke Test\",\"companyName\":\"Smoke Co\"}" || true)"
TOKEN="$(printf '%s' "$REG" | jget accessToken)"
COMPANY="$(printf '%s' "$REG" | jget company.id)"
[ -n "$TOKEN" ] && [ -n "$COMPANY" ] && ok "registration issues tokens + company" || bad "registration failed: $REG"
AUTH=(-H "authorization: Bearer $TOKEN" -H "x-company-id: $COMPANY")

LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"smoke-Passw0rd!\"}")"
[ "$LOGIN_CODE" = 200 ] && ok "login works" || bad "login returned $LOGIN_CODE"

# --- 4. project -------------------------------------------------------------
PRJ="$(curl -sf -X POST "$BASE/api/v1/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"name":"Smoke Project"}' || true)"
PID="$(printf '%s' "$PRJ" | jget id)"
[ -n "$PID" ] && ok "project created" || bad "project creation failed: $PRJ"

# --- 5. file round-trip (proves S3/bucket wiring) ---------------------------
if [ -n "$PID" ]; then
  FOLDER="$(curl -sf -X POST "$BASE/api/v1/projects/$PID/folders" "${AUTH[@]}" \
    -H 'content-type: application/json' -d '{"name":"smoke"}' || true)"
  FID="$(printf '%s' "$FOLDER" | jget id)"
  TMP="$(mktemp)"; head -c 4096 /dev/urandom > "$TMP"
  UP="$(curl -sf -X POST "$BASE/api/v1/projects/$PID/folders/$FID/files" "${AUTH[@]}" \
    -F "file=@$TMP;filename=smoke.bin;type=application/octet-stream" || true)"
  FILE_ID="$(printf '%s' "$UP" | jget id)"
  if [ -n "$FILE_ID" ]; then
    ok "file uploaded to storage backend"
    DOWN="$(mktemp)"
    curl -sf "$BASE/api/v1/files/$FILE_ID/download" "${AUTH[@]}" -o "$DOWN" || true
    if cmp -s "$TMP" "$DOWN"; then ok "downloaded bytes identical (storage round-trip)"; else bad "downloaded file differs from upload"; fi
    rm -f "$DOWN"
  else
    bad "file upload failed: $UP"
  fi
  rm -f "$TMP"
fi

# --- 5b. security posture ---------------------------------------------------
# Three refusals that must hold on a live deployment. None of them mutates
# anything, and none touches the lockout counters — a smoke test that locked
# out its own account would be worse than no smoke test.
SCIM="$(curl -s "$BASE/api/v1/scim/v2/Users" || true)"
printf '%s' "$SCIM" | grep -q 'scim:api:messages:2.0:Error' \
  && ok "SCIM refuses an unauthenticated call in SCIM's own error envelope" \
  || bad "SCIM 401 is not a SCIM error document: $SCIM"

POLCODE="$(curl -s -o /tmp/constructos-policy.json -w '%{http_code}' "$BASE/api/v1/company/security-policy" "${AUTH[@]}")"
[ "$POLCODE" = "200" ] && ok "tenant security policy is readable" || bad "security policy returned $POLCODE"
MINLEN="$(cat /tmp/constructos-policy.json 2>/dev/null | jget effective.passwordMinLength)"
[ -n "$MINLEN" ] && ok "password policy in force: minimum $MINLEN characters" || bad "security policy carried no effective password rules"
rm -f /tmp/constructos-policy.json

ANON="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/company/security-events")"
[ "$ANON" = "401" ] && ok "the login audit refuses an unauthenticated caller" || bad "unauthenticated audit read returned $ANON, expected 401"

# --- 6. ledger integrity ----------------------------------------------------
LV="$(curl -sf "$BASE/api/v1/ledger/verify" "${AUTH[@]}" || true)"
VALID="$(printf '%s' "$LV" | jget valid)"
COUNT="$(printf '%s' "$LV" | jget count)"
[ "$VALID" = "true" ] && ok "ledger chain intact ($COUNT entries)" || bad "ledger verify: $LV"

# --- result -----------------------------------------------------------------
echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[1;32mAll %d checks passed — deployment is live and healthy.\033[0m\n' "$PASS"
  echo "Register your real account now: $BASE/register (first registration = company owner)."
else
  printf '\033[1;31m%d/%d checks FAILED — see docs/deployment.md §4.4 (common failures).\033[0m\n' "$FAIL" "$((PASS+FAIL))"
  exit 1
fi
