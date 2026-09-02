# ADR 0010 — Statutory payment regimes as versioned code, with documented simplifications

**Status:** accepted (implemented for 5 regimes in `apps/api/src/modules/payments/regimes.ts`)

## Context

Spec Domain F (M10) requires the security-of-payment statutory regimes — UK HGCRA,
Singapore SOPA, Australian SOPA variants, Malaysia CIPAA, NZ CCA (#358–369) — where a
payment claim starts hard statutory clocks and a missed response deadline creates real
liability (deemed liability, loss of withholding grounds, a right to suspend work). The
deadline engine (#359–361) computes dates with legal consequences, which is exactly the
situation ADR 0007 already resolved for contract time bars: data that decides whether an
entitlement survives must be **auditable** (a computed deadline must trace to a specific,
reviewable definition) and **correct per published statute** (NSW s 14(4)'s ten business
days is not tenant data). Database-resident rules would be mutable at runtime, per
tenant, without a review gate — the failure mode where a tenant "corrects" a statutory
day count and the engine computes wrong deadlines with the platform's authority behind
them.

There is a second, statute-specific problem ADR 0007 did not face: the statutes do not
reduce cleanly to day counts. Real regimes hang deadlines off contractual due dates (UK),
tax invoices (Singapore), or different periods per contracting tier (NSW head contracts
vs subcontracts); "working days" definitions depend on public-holiday calendars;
statutory interest floats on central-bank base rates. A model that silently pretended to
full fidelity would be worse than no model.

## Decision

The regime library is a **typed constant in versioned source**: `REGIME_LIBRARY` in
`apps/api/src/modules/payments/regimes.ts` — five `RegimeDef` entries (UK HGCRA 1996/2011,
SG SOPA 2004, NSW SOPA 1999, MY CIPAA 2012, NZ CCA 2002), each carrying one response
deadline and one final payment date (day count + `calendar`/`business` basis), a
suspension notice period, a pinned interest rate with its `interestNote`, a `deemedRule`
narrative and an `adjudicationNote`. Rules of the model:

1. **Read-only at runtime.** Served at `GET /payment-regimes` (+`/:regime`); no route
   writes it. `PAYMENT_REGIMES` (`packages/shared/src/enums.ts`) and the library are kept
   from drifting by `libraryCoversAllRegimes()`, asserted in
   `modules/payments/payments.test.ts`.
2. **Simplifications are documented at the definition site, not hidden.** The file
   header lists them and per-regime comments cite the statutory sections they diverge
   from:
   - *No public-holiday calendars* — business-day arithmetic (`addBusinessDays`) skips
     Saturdays/Sundays only, so "working days" statutes (NSW, MY, NZ) compute slightly
     **early** around holidays: conservative in the warning direction, never late.
   - *Single-base-date timelines* — both clocks run from the later of the statutory
     `referenceDate` and the date of service (`computeTimeline`), where real statutes
     sometimes anchor to contractual due dates or invoices; the per-regime comments say
     where (e.g. the UK model preserves the ≥ 7-day pay-less gap via the Scheme's
     17-day default rather than modelling the contractual due date).
   - *Pinned interest rates* — floating statutory formulae (8% over BoE base; RBA cash
     rate + 4%) are pinned to stated figures, with the true formula recorded in
     `interestNote` and quoted verbatim in the `/interest` response's `basis`.
   - *Regime semantics kept honest* — CIPAA's `deemedRule` states that a missing payment
     response deems the claim **disputed** (adjudication-ready exposure), not
     automatically payable; the platform's `deemed` status is documented as meaning that
     under CIPAA. Suspension is modelled from deemed liability only; the statutes'
     suspension-for-non-payment-past-the-final-date limb is explicitly marked not
     modelled (comment on the suspend route, `modules/payments/index.ts`).
3. **Consequences are enforced by the engine, recorded in the assurance layer.** Serving
   a claim materializes the response deadline as an assurance `obligations` row (the same
   pattern as ADR 0007's time bars); the lazy `sweepDeemed` flips unanswered claims to
   `deemed`, breaches the obligation and raises a critical `payment_deemed_liability`
   signal embedding the regime's `deemedRule` — exactly once. Late responses are
   recorded (`late = 1`), breach the obligation, raise a high signal and rescue no
   status. Ground-stating (#365) is a hard 400.

## Consequences

- **Auditability and PR review**: every computed statutory deadline traces to a
  definition in git. A day-count change arrives by pull request with review history,
  deploys atomically with the `computeTimeline` engine that interprets it, and is pinned
  by tests that hand-check the arithmetic (NSW business days across weekends, the UK
  base-date rule, NZ working-day defaults — `payments.test.ts`). A wrong day count is a
  code defect fixed once for every tenant, not a per-tenant data-quality problem
  discovered in an adjudication.
- **The model's honesty is machine-readable.** Because simplifications live in the
  served `RegimeDef` (summary, `interestNote`, `deemedRule`), the web UI's regime cards
  and the interest calculation's `basis` string carry the caveats to the user — the
  documentation cannot silently drift from the behaviour.
- **Jurisdictional-advice disclaimer, stated plainly**: the library is an engineering
  model of the statutes built for deadline discipline and exposure surfacing — it is
  **not legal advice**, it does not track amendments in real time, and contract-specific
  variations the statutes permit (shorter contractual response periods, subcontract-tier
  day counts, contractual interest rates) are not modelled. Anything the model computes
  is a prompt to act, not a determination of rights; disputes need counsel in the
  relevant jurisdiction. This mirrors ADR 0007's "engineering summaries, not legal
  advice" limit, with more force because statutes, unlike standard forms, change under
  the platform.
- **Extension path**: new regimes (Ireland CCA #370, Canadian prompt payment #371,
  Australian states beyond NSW #367) are new `RegimeDef` entries + enum members — a code
  release, by design. Holiday calendars, when they land, belong behind
  `addBusinessDays`; per-contract statutory overrides (shorter response periods) would
  attach to the claim row under review, never mutate the library — the same shape ADR
  0007 chose for Particular Conditions.
