# Retrospective Detection Run

## What this is

The master specification's closing directive (Vol III §7, "What to do next"):

> The single highest-value next artefact is not more specification. It is a
> **retrospective detection run**: take one completed public project with a
> known integrity outcome, ingest its procurement and payment record, and
> measure how many of Domain A's 114 detectors would have fired before the
> outcome was known.
>
> That result — a precision and recall figure against a known case — is the
> only thing that converts this document from a plan into a company.

This repository implements the **synthetic-scope version** of that run.
The spec's real thing requires a completed real project's procurement and
payment record — customer (or willing public-client) data we do not have.
What we can measure today, honestly, is:

- **Recall** — given a project into which known fraud/failure schemes have
  been planted through the public API, how many of them do the shipped
  detectors catch?
- **Precision** — of all signals the system raises across a planted project
  *and* an innocently-seeded clean control project, what share is
  attributable to the planted schemes? Any detector that fires on the clean
  project is a measured false positive.

The harness lives at `apps/api/src/scripts/retrodetect.ts`. It boots the
full Fastify API against an in-memory PGlite database (the same
`buildTestApp()` used by the test suites), needs no external services, and
exits non-zero when recall drops below 100% or the clean project raises any
signal — so it doubles as a regression harness for the detector suite.

## How to run

```sh
pnpm --filter @constructos/api eval:retrodetect
```

The run prints a markdown results table plus a summary line, and writes a
JSON artifact (full scheme results + every raw signal) to a temp directory
under the OS tmpdir; the path is printed at the end. Nothing is written
into the repository.

## Method

1. **Personas** (all created via the API, like the test suites):
   - **Owner A** registers the company (company owner; operational claimant).
   - **Member B** is invited through `POST /company/users/invite`, logs in
     with the returned temporary password, and gets `project_admin`
     membership on both projects (second operational actor and the
     independent evidence source).
   - **Reviewer R** is invited the same way and holds a tenant-wide
     `integrity_reviewer` assurance grant — R runs the detector batches,
     the entity scan, the sweep-triggering reads, and collects signals.
2. **Planted project** — 11 known schemes are planted via the real API
   routes (table below).
3. **Clean control project** — seeded with innocent data: 60 log-uniform
   (Benford-conforming), non-round, unique cost values; a supported
   reconciliation; a properly segregated approval; a payment claim served
   and answered the same day; a contract event noticed inside its FIDIC
   20.2 time bar; a compliant covenant reading; a lightly-drawn
   contingency; two vendors with distinct bank accounts.
4. **Run** — `POST /projects/:id/detectors/run` on both projects,
   `POST /entities/scan` (tenant-wide), and the list reads that trigger the
   lazy sweeps (`GET .../contracts/:id/events` for time bars,
   `GET .../payment-claims` for deemed liability) on both projects.
5. **Score** — signals are collected with `GET /signals` for the company.
   - A scheme is **caught** when a signal with its expected detector exists
     on the planted project (tenant scope for `shared_identifier`, whose
     scan signals carry no project id).
   - **Recall** = caught / planted.
   - **Precision** = signals attributable to planted schemes ÷ all signals
     raised. Attribution is by detector + project id; the same detector
     firing on the clean project is a false positive and is listed by name.

## Planted schemes

Schemes 1–3 deliberately share one fabricated cost-assertion population
(a manually invented payment book is exactly the dataset that trips all
three statistical detectors at once); each detector keys on a different
signature within it — round share > 40%, one value resubmitted within days,
and a flat/high first-digit spread with chi-square ≈ 34 against Benford.

| # | Scheme | Spec function(s) | Expected detector |
| --- | --- | --- | --- |
| 1 | 12 round cost assertions (all divisible by 1,000) | Domain A #57 (round-number invoice clustering) | `round_number_clustering` |
| 2 | 3 identical cost assertions, same claimant, days apart | Domain A #55–56 (duplicate payment / invoice detection) | `duplicate_assertions` |
| 3 | 54 cost assertions with a flat first-digit distribution | Domain A #58 (Benford's Law analysis) | `benford_first_digit` |
| 4 | Workflow started and approved by the same user | Domain A #39–40 (segregation-of-duties / same-person requisition-and-approval) | `segregation_of_duties` |
| 5 | 3 workflow steps approved seconds after assignment by one assignee | Domain A #37 (approval velocity anomaly) | `approval_velocity` |
| 6 | 2 reconciliations contradicting one claimant (assertions from A, evidence from B) | Domain A #65–66 (quantity certified vs evidenced; over-certification) | `contradicted_claimant` |
| 7 | 2 nominally independent vendors sharing a bank account, then `POST /entities/scan` | Domain A #9 (shared bank account detection) | `shared_identifier` |
| 8 | FIDIC 20.2 contract event dated 90 days ago, notice never served | Domain C #225–231 (M8 time-bar engine; Domain A analogue #104 back-dating/record integrity) | `time_bar_missed` |
| 9 | HGCRA payment claim served, response deadline passed with no response | Domain F #361 (M10 deemed-liability sweep) | `payment_deemed_liability` |
| 10 | Covenant (`gte` 1.2) with a non-compliant reading (1.04) | Domain O #742–743 (M14 covenant monitor) | `covenant_breach` |
| 11 | Contingency drawdown leaving 18% remaining (below the 20% line) | Domain H #473 (M13 contingency exhaustion) | `contingency_exhaustion` |

Everything is planted through the public API, with **one documented
exception**: scheme 9 backdates `servedAt`/`responseDeadline` on the
payment-claim row with a direct DB update after serving the claim through
the API. The serve endpoint always computes the statutory response deadline
forward from the actual date of service, so a claim that is already past
its deadline can only exist after real days pass — the harness ages the
claim in the database instead (the same technique `payments.test.ts` uses).
Scheme 8 needs no such workaround: the contracts API legitimately accepts
past event dates, and the 20.2 time bar is computed from the event date.

## Current results

Run of 2026-08-24 (deterministic seed data; reproducible):

```
detectors/run (planted): {"benford_first_digit":1,"duplicate_assertions":1,"round_number_clustering":1,"approval_velocity":1,"segregation_of_duties":1,"contradicted_claimant":1}
detectors/run (clean):   {"benford_first_digit":0,"duplicate_assertions":0,"round_number_clustering":0,"approval_velocity":0,"segregation_of_duties":0,"contradicted_claimant":0}
entities/scan: 4 entities, 1 signal(s)
```

| Scheme | Detector | Caught | Signal |
| --- | --- | --- | --- |
| Round-number cost fabrication (12 round cost assertions) | round_number_clustering | yes | Assertion values cluster on round numbers |
| Double claim (3 identical cost assertions, same claimant, days apart) | duplicate_assertions | yes | Duplicate cost assertion (47250 GBP) |
| Fabricated value population (54 cost assertions, flat first-digit spread) | benford_first_digit | yes | First-digit distribution deviates from Benford's Law |
| Self-approval (workflow started and approved by the same user) | segregation_of_duties | yes | Initiator approved own workflow wfi_kbrl1hdow6p2e7q6i1eva |
| Rubber-stamp approvals (3 steps approved seconds after assignment) | approval_velocity | yes | Rubber-stamp approvals by u_a8gi2pa3wedp433jmsmlv |
| Over-certification (2 rate assertions contradicted by independent survey) | contradicted_claimant | yes | Repeatedly contradicted claimant u_6g6bx8svuqjvb7ftsesw3 |
| Colluding vendors (2 nominally independent vendors, one bank account) | shared_identifier | yes | Entities share bank account: Marlin Groundworks Ltd / Pelican Formwork Ltd |
| Missed notice time bar (FIDIC 20.2 event 90 days old, never noticed) | time_bar_missed | yes | Notice time bar missed — event #1: Unforeseen ground conditions at CH 2+400 |
| Ignored payment claim (HGCRA claim served, response deadline passed) | payment_deemed_liability | yes | No payment response served in time — deemed liability for GBP 182563.44 |
| Financial covenant breach (DSCR reading below gte threshold) | covenant_breach | yes | Covenant breach — Debt service cover ratio: 1.04 vs required ≥ 1.2 x |
| Contingency exhaustion (drawdown leaves under 20% remaining) | contingency_exhaustion | yes | Contingency "Construction contingency" below 20% remaining |

**Recall 11/11, Precision 100.0% (11/11 signals attributable to planted
schemes), false positives: none.**

## Honest limitations

Read these before quoting the numbers above anywhere.

- **This is not the spec §7 run.** The spec demands a *real* completed
  project with a *known* integrity outcome. That run requires a customer's
  (or a willing public client's / audit institution's) procurement and
  payment record, which we do not have. Until it happens, these figures
  prove the detectors work as built — not that they detect real-world fraud.
- **The schemes were planted by the people who wrote the detectors**, and
  the detectors were tuned on their own test data. The plants are shaped to
  sit on the firing side of each threshold (e.g. the Benford population is
  constructed to exceed the chi-square threshold; the drawdown is sized to
  cross the 20% line). Recall of 11/11 on adversarially *cooperative* data
  is a floor-check, not a field measurement.
- **Precision here is measured against one clean project** with plausible
  but idealized innocent data. Real projects contain messy-but-honest data
  (legitimately round lump sums, genuinely fast approvals of trivial items)
  that this control does not model; real-world precision will be lower.
- **Coverage is 11 detectors**, i.e. the ones shipped so far — the spec's
  Domain A alone enumerates 114. The recall denominator is "schemes we
  planted", not "schemes that exist".
- **One plant required a database write** (scheme 9's backdating, above),
  because the API — correctly — refuses to create a claim that is born
  overdue. Time-dependent detectors are exercised by aging records, not by
  waiting.

## Extending with new schemes

1. Add a detector (or a lazy-sweep signal emitter) to the relevant module.
2. In `apps/api/src/scripts/retrodetect.ts`, write a `plantYourScheme()`
   function that creates the guilty records **through the public API**
   (direct DB writes only where a record must be older than the API can
   create it — comment every such case), and append an entry to the
   `GROUND_TRUTH` table: `{ id, name, specRef, expectedDetector, scope,
   plant }`. Use `scope: "company"` only for detectors that emit
   tenant-level signals without a project id.
3. Seed the innocent counterpart of the same records into
   `seedCleanControl()` — a scheme without a clean-side control does not
   measure precision.
4. If the detector fires from a lazy sweep, make sure
   `runDetectorsAndSweeps()` hits the list endpoint that triggers it, on
   **both** projects.
5. Run `pnpm --filter @constructos/api eval:retrodetect` and update the
   results section above. The script exits non-zero until the new scheme is
   caught and the clean project stays silent.
