#!/usr/bin/env bash
# =============================================================================
# ConstructOS — regenerate the in-flight migration.
#
# Migrations 0000–0010 are the committed baseline. Everything this upgrade
# adds to packages/db/src/schema lands in ONE migration on top of it,
# 0011_platform_upgrade, which is regenerated from scratch every time the
# schema changes (nothing has been deployed with it, so rewriting is safe).
#
# Safe to run concurrently: generation is serialised through flock.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRIZZLE="$ROOT/packages/db/drizzle"
BASELINE_IDX=10

exec 9>"/tmp/constructos-migrate.lock"
flock 9

# Once 0011 has been applied to any database that matters, regenerating it
# would produce a migration with a new hash that drizzle re-applies at boot
# and fails on the existing tables. Drop a marker to freeze it; from then on
# use plain `pnpm --filter @constructos/db generate` to append 0012+.
if [ -f "$DRIZZLE/.frozen" ]; then
  echo "refusing: $DRIZZLE/.frozen exists — 0011_platform_upgrade has shipped; append a new migration with drizzle-kit generate instead" >&2
  exit 1
fi

node - "$DRIZZLE" "$BASELINE_IDX" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [dir, baseIdxRaw] = process.argv.slice(2);
const baseIdx = Number(baseIdxRaw);
const journalPath = path.join(dir, "meta", "_journal.json");
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const keep = journal.entries.filter((e) => e.idx <= baseIdx);
for (const e of journal.entries) {
  if (e.idx > baseIdx) {
    for (const f of [path.join(dir, `${e.tag}.sql`), path.join(dir, "meta", `${String(e.idx).padStart(4, "0")}_snapshot.json`)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}
// Also sweep any stray files beyond the baseline that the journal lost track of.
for (const f of fs.readdirSync(dir)) {
  const m = f.match(/^(\d{4})_.*\.sql$/);
  if (m && Number(m[1]) > baseIdx) fs.unlinkSync(path.join(dir, f));
}
for (const f of fs.readdirSync(path.join(dir, "meta"))) {
  const m = f.match(/^(\d{4})_snapshot\.json$/);
  if (m && Number(m[1]) > baseIdx) fs.unlinkSync(path.join(dir, "meta", f));
}
journal.entries = keep;
fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");
JS

cd "$ROOT/packages/db"
pnpm exec drizzle-kit generate --name platform_upgrade 2>&1 | tail -5
ls "$DRIZZLE" | grep -E '^0011_' || echo "(no schema changes beyond the baseline — no 0011 migration needed)"
