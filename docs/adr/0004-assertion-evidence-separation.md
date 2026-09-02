# ADR 0004 — Assertion/evidence separation as an enforced invariant

**Status:** accepted (implemented at API level; pathway separation is roadmap)

## Context

Spec Vol III §4, design rule, verbatim: *"`Assertion` and `Evidence` must never be created
by the same actor through the same pathway. The moment the contractor can author both sides
of a reconciliation, the product is worthless. This constraint is the entire architecture."*
A reconciliation product whose evidence is supplied by the claimant is a reporting tool with
extra steps (Vol III §6.1).

## Decision

Make the separation *recorded always, enforced where it matters, overridable only by the
segregated role* — all in `apps/api/src/modules/assurance/`:

1. **Recorded always:** every assertion carries `claimantId`/`claimantKind`; every evidence
   record carries `submittedBy`, `source`, `provenance` and an `independenceScore` (0..1)
   (`packages/db/src/schema/assurance.ts`). The pairing is checkable after the fact even
   where not blocked.
2. **Enforced at the join:** `POST /projects/:projectId/reconciliations` rejects an
   evidence set *entirely* submitted by the assertion's claimant with
   `403 evidence not independent of claimant`. Only a caller holding the
   `integrity_reviewer` assurance role may knowingly proceed, and the creation is ledgered
   with full payload (`storePayload: true`).
3. **Surfaced elsewhere:** satisfying an obligation with self-submitted evidence is allowed
   but writes `selfCertified: true` into the ledger payload for later review; reconciliation
   confidence is derived from the evidence set's mean `independenceScore`.
4. **Roles are segregated, not layered:** assurance roles (`integrity_reviewer`, `auditor`,
   `regulator`) live in their own grant table with expiry, give read-only access to
   operational tools, and are the only path to signal disposition
   (see `docs/security.md` §2.3–2.4 and ADR context in `packages/shared/src/permissions.ts`).

## Consequences

- The worthless case — contractor authors both sides silently — cannot happen through the
  reconciliation API; the audited-override case leaves an integrity reviewer's fingerprint
  in the chain.
- Honest limit: today all records arrive through one API, so the rule is enforced at the
  *actor* level, not the *pathway* level the spec ultimately demands. True pathway
  separation (independent ingestion channels: telematics, registries, bank data — Vol III
  M6) is Phase 2 of `docs/roadmap.md`; this ADR's actor-level rule is the invariant those
  channels will inherit.
- `independenceScore` is currently self-declared at ingest by the submitter; scoring it from
  provenance automatically is detector work (M2).
