# ADR 0003 — Append-only hash-chained evidence ledger, per tenant

**Status:** accepted (implemented)

## Context

Spec Domain S #859 and Vol III §4 primitive 8: the record of state changes must be
*admissible rather than merely informative* — a mutable audit table administered by one party
to a dispute proves nothing. Requirements: tamper evidence, actor attribution, reproducible
hashing years later, per-tenant exportability, and a path to external notarisation. A full
blockchain (consensus, distribution) is unnecessary: there is one writer (the platform) and
the threat is retroactive falsification, not double-spend.

## Decision

- **Hash chain per company** in `ledger_entries` (`packages/db/src/schema/assurance.ts`):
  each entry's `entryHash = SHA-256(prevHash + companyId + actorId + action + objectType +
  objectId + payloadHash + at)`; the first entry chains from a 64-zero genesis sentinel
  (`packages/ledger/src/chain.ts`). `seq` is bigserial for total order.
- **Canonical JSON** (RFC 8785-style: sorted keys, `undefined` stripped, finite numbers
  only — `packages/ledger/src/canonical.ts`) under every `payloadHash`, so the hash is
  reproducible independent of engine and property order.
- **Append in the same request as the operational write** (`apps/api/src/lib/ledger.ts`);
  a failed append fails the request — an unledgered mutation is worse than a rolled-back
  one. The append transaction reads the chain head, serializing concurrent writers per
  tenant.
- Rows are never updated or deleted; the API exposes no mutating route. Full payload
  snapshots are stored only for high-value objects (`storePayload: true`); the hash is
  always stored.
- **Merkle evidence packs** (`packages/ledger/src/merkle.ts`, odd leaves promoted rather
  than duplicated) commit evidence sets under a single escrow-able root with per-leaf
  inclusion proofs.
- Verification is first-class: `verifyChain` returns the first broken index; exposed at
  `GET /api/v1/ledger/verify`, which itself appends an `access` entry.

## Consequences

- Any retroactive edit or deletion of history breaks every subsequent hash — cheap to
  detect, impossible to hide from a verifier holding the chain (see the threat model in
  `docs/security.md` §5).
- Honest limits: tail truncation and full-rewrite by a DB operator verify clean; only
  external escrow of chain heads / Merkle roots defeats them (roadmap Phase 2, spec
  #860–861, #874). Timestamps trust the app server clock (#864).
- Writes serialize per tenant on the head row — a throughput ceiling accepted deliberately;
  batching or per-tenant sharding is the escape hatch if it ever binds.
- Ledger coverage is a module convention ("every consequential mutation appends"), reviewed,
  not enforced by DB triggers.
