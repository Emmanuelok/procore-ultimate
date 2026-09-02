# ADR 0014 — Independent evidence streams are a design law, not a feature

**Status:** accepted (first fully realised in `apps/api/src/modules/workforce/`; extends
ADR 0004 from actor-level separation toward pathway-level separation)

## Context

ADR 0004 took the spec's §4 design rule — *"`Assertion` and `Evidence` must never be
created by the same actor through the same pathway. The moment the contractor can author
both sides of a reconciliation, the product is worthless. This constraint is the entire
architecture."* — and enforced the **actor** half: claimant identity is recorded on every
assertion, submitter identity on every evidence row, and a reconciliation whose evidence
was wholly submitted by the claimant is a 403 unless an integrity reviewer knowingly
overrides. Its own stated limit was that all records still arrive through one API, so the
*pathway* half was deferred to M6 ingestion.

Phase 5 forced the question earlier than M6, because M17's flagship function is literally a
two-stream reconciliation: spec M#669, *"ghost worker elimination via biometric-to-payroll
reconciliation"*. Building it made three things clear.

First, the pattern is not specific to labour. The same shape recurs across the map, and in
every case the value comes from the **two sides having different authors**:

| Assertion side (the claim) | Evidence side (independent record) | Spec |
|---|---|---|
| Payroll: days claimed, gross pay | Site access: turnstile / biometric swipes | M#669, M#677; A#54 ghost worker |
| Progress claims, valuation percentages | Reality capture, survey, photo with EXIF | B#162–167 vs A#65–67 |
| Plant and daywork claims | Telematics: engine hours, GPS | A#68–69 |
| Compensation paid to a household | Bank transaction, beneficiary-verified receipt | J#554 |
| Social value delivered | Third-party evidence attached to the delivery | I#539 |
| Waste diverted from landfill | Duty-of-care consignment notes | I#513–514 |

Second, a two-stream reconciliation is only as good as the **separation of the two
ingest paths**, and separation is a property of the *deployment*, not of the schema. A
turnstile feed wired into the API by the same subcontractor's administrator who files the
payroll is not independent evidence; it is the same claim, typed twice.

Third — and this is the part that decides the design — nothing in the code can *prove*
independence. What the code can do is make the dependence visible: record who wrote each
side, keep the two sides in separate tables with separate write routes, refuse to let one
side be derived from the other, and state the assumption in the output.

## Decision

**Where the platform reconciles a claim against evidence, the two sides are modelled as
separate streams with separate write paths, and the reconciliation is a read-only
computation over both. The platform never manufactures the evidence side from the claim
side, and it surfaces the independence assumption rather than assuming it away.**

Concretely, as implemented in M17 (`apps/api/src/modules/workforce/`):

1. **Two tables, two routes, two authors.** `payroll_entries` (the employer's claim:
   `daysClaimed`, `grossPay`, `submittedBy`) and `site_access_records` (the independent
   stream: one row per worker per date, `source ∈ turnstile | biometric | manual |
   gate_log`) are written by different endpoints — `POST …/payroll` and
   `POST …/site-access` — and never by each other. There is no route that infers attendance
   from payroll or payroll from attendance.
2. **The reconciliation engine is pure and reads both** (`modules/workforce/reconcile.ts`,
   unit-tested without a database). `reconcileWorker` classifies each worker's period as
   `ghost` (pay claimed with **zero** evidenced days), `overclaim` (claimed days beyond
   `OVERCLAIM_TOLERANCE` = 1.15× evidenced days), `underpaid` (implied daily rate below
   `UNDERPAYMENT_TOLERANCE` = 0.95× the agreed rate, M#677) or `ok`, with the money at
   risk and the wage shortfall quantified and the arithmetic restated in `reason`.
3. **Findings land in the platform's own spine.** `POST …/workforce/reconcile` raises
   `ghost_worker` (critical), `payroll_overclaim` (high) and `wage_underpayment` (high)
   `signals` — idempotent per `(detector, workerId, period)` — and ledgers the run. The
   GET twin (`…/workforce/reconciliations`) replays the identical engine and writes
   nothing, so a reviewer can look without changing the record.
4. **Neither side can be edited into agreement with the other.** Payroll rows are
   insert-only; access rows upsert on `(workerId, accessDate)` so a feed can be re-ingested
   idempotently without duplicating a day. There is no route that edits a stored payroll
   claim, and the reconciliation is recomputed from stored rows on every run — so "fixing" a
   ghost means adding real attendance evidence, dated, from a named source, and every ingest
   batch is ledgered with its counts.
5. **`source` is carried, not scored.** Every access record states how it was captured.
   `manual` and `gate_log` are accepted (many sites have no turnstile) and are exactly the
   sources a reviewer should discount; the field exists so that discount is possible.

The same law is applied more weakly, but deliberately, elsewhere in Phase 5: compensation
to a land parcel or an affected household **cannot be recorded without at least one
validated assurance `evidence` id** (`POST …/parcels/:id/compensate`,
`…/affected-persons/:id/compensate` — J#554), and a grievance cannot reach
`closed_verified` on the operator's say-so: closure is verified *with the complainant*, and
a complainant who rejects the resolution reopens the grievance (J#573). In both cases the
second side of the record is authored by someone other than the party asserting compliance.

## Consequences

- **This is the platform's differentiator, restated as an invariant.** Vol III §2's claim —
  *"here is what actually happened, and here is where the two diverge"* — is only true
  where two independently-authored records exist. Every future module that reconciles
  anything inherits this shape: separate table, separate route, pure engine, signals out.
  Reconciliation logic that reads one table and calls it verification is a bug, not a
  simplification.
- **It sharpens what M6 (ingestion) is for.** M6 is not "importing spreadsheets"; it is the
  work of making the evidence side arrive through a channel the claimant does not control —
  a turnstile vendor's API, a bank feed, a telematics provider, a registry. M17's
  `site_access_records` is the first table shaped to receive such a feed, and the
  `source` column is where that provenance will land. Until M6, an operator can post both
  streams through the same API with the same token, and the reconciliation is then only as
  independent as the operator's own process — the honest statement of ADR 0004's limit,
  now attached to a concrete table.
- **False negatives are structural and must be stated.** The reconciliation detects
  *fabricated attendance*, not short days: a ten-minute swipe counts as a day present
  (documented in `reconcile.ts`). Payroll entries overlapping a period edge are counted
  whole, which over-states claimed days — which is precisely why the 1.15× tolerance is
  deliberately generous. A ghost worker whose accomplice swipes a spare badge is invisible
  to this engine and visible only to biometric enrolment (M#668) and the modern-slavery
  indicator family. Every one of these limits is written into the engine's header rather
  than into a footnote.
- **Independence is measured where it can be, and asserted nowhere.** The assurance layer's
  `evidence.independenceScore` remains self-declared at ingest (ADR 0004); nothing in this
  ADR changes that. What changes is that a whole module is now built so the score *could*
  be derived from provenance later, because the two streams are physically distinct rows
  with distinct authors and distinct sources.
- **A tempting shortcut is now explicitly forbidden**: generating site-access records from
  daily-log manpower counts, or seeding payroll from access records, would make the
  dashboards look complete and the product worthless. Neither route exists, and neither
  should be added.
