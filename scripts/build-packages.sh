#!/usr/bin/env bash
# Rebuild the workspace packages apps/api and apps/web resolve through dist/
# (@constructos/shared, @constructos/ledger, @constructos/db). Serialised with
# flock so parallel contributors never interleave tsc emits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec 9>"/tmp/constructos-packages.lock"
flock 9
cd "$ROOT"
pnpm --filter @constructos/shared build
pnpm --filter @constructos/ledger build
pnpm --filter @constructos/db build
