# ADR 0007 — Standard-form clause library as versioned code, not database rows

**Status:** accepted (implemented for 8 contract forms; tenant-authored clause packs are
explicitly out of scope for this phase)

## Context

Spec Domain C (#193–224) requires clause-level modelling of the standard forms — FIDIC,
NEC, JCT — and the time-bar engine (#225) computes **legally consequential deadlines** from
that model: a `contract_events.noticeDeadline` derived from a clause's `timeBarDays` is the
date after which a real entitlement may be lost. Data that decides whether a claim survives
has two hard requirements: it must be *auditable* (a deadline must trace to a specific,
reviewable definition that cannot have been quietly edited) and it must be *correct per
published edition* (FIDIC Red 2017 Sub-Clause 20.2 says 28 days for every contract in the
world; it is not tenant data).

Storing clauses in a database table would make them mutable at runtime, per tenant, with no
review gate — exactly the wrong properties. It would also invite the failure mode where a
tenant "fixes" a time bar and the engine silently computes wrong deadlines with the
platform's authority behind them.

## Decision

The clause library is a **typed constant in versioned source**:
`CLAUSE_LIBRARY` in `apps/api/src/modules/contracts/clause-library.ts` — ~80 `ClauseDef`
entries across FIDIC Red 1999/2017, Yellow 2017, Silver 2017, NEC3/NEC4 ECC and JCT SBC/DB
2016 (the `bespoke` form has no library clauses by definition). Rules encoded in the type
and its doc comments:

1. **`timeBarDays` is set only where the form itself imposes a day-counted deadline running
   from the event/awareness date** with a stated consequence (FIDIC 20.2 / 20.2.4, FIDIC
   18.2, NEC 61.3). Deadlines counted from any other reference — JCT's Pay Less Notice
   counts *backwards* from the final date for payment — are described in the clause summary
   but carry no `timeBarDays`, because computing `eventDate + N` would be wrong. The engine
   would rather compute nothing than compute a false deadline.
2. **`standingObligation`** entries are the continuing duties (programme submission,
   certification within 28 days, payment within 56 days, early-warning duty) materialized
   into the assurance `obligations` register when a contract is created (#260).
3. **The library is read-only at runtime**: served via `GET /contract-forms` and
   `GET /contract-forms/:form/clauses` (search/category filters), resolved by
   `clausesForForm`/`findClause`. No route writes it.
4. **Per-contract deviations never touch the library.** They live in
   `contracts.particularConditions` (`[{clauseRef, amendment}]` — the Particular Conditions
   overlay, spec #201–202); the contract detail endpoint computes `effectiveClauses` =
   library ⊕ overlay with amended clauses flagged, so an amendment is always visible
   *against* the standard form rather than replacing it.

## Consequences

- **Auditability**: every computed deadline traces to a clause definition that lives in git
  — changes arrive by pull request, carry review history, and deploy atomically with the
  engine that interprets them. The tests that pin deadline arithmetic
  (`modules/contracts/contracts.test.ts`) version together with the data they test.
- **Correctness pressure is front-loaded**: a wrong `timeBarDays` is a code defect fixed
  once for every tenant, not a per-tenant data-quality problem discovered in a dispute.
- **No tenant editing — accepted, for now.** Tenants cannot add forms or clauses
  (#216–224's regional forms, #197–199's remaining FIDIC books require a code release), and
  a Particular Condition that *changes a time bar* is captured as text but does not alter
  the computed deadline. That last limit is stated to users implicitly by the amended flag;
  making PC overlays machine-readable (override `timeBarDays` per contract, under a review
  workflow) is the designed next step and fits the current shape — the overlay already
  keys by `clauseRef`.
- **If tenant-authored clause packs ever land, they move to the database** — but they will
  reuse the `ClauseDef` shape and must bring the review-gate property with them (versioned
  packs, approval workflow) rather than abandon it.
- Honest limit: the summaries are engineering summaries of the forms, not legal advice, and
  the library covers a **subset** of each form (the clauses that drive notices, payment,
  time and termination) — completeness per edition is tracked in `docs/roadmap.md`, not
  implied here.
