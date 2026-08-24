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
     R cannot run the workforce payroll reconciliation: that is a
     standard-level operational route and an assurance grant is read-only,
     so Owner A runs it and R reads the signals it raises.
2. **Planted project** — 17 known schemes are planted via the real API
   routes (table below).
3. **Clean control project** — seeded with innocent data, one honest
   counterpart per planted scheme: 60 log-uniform (Benford-conforming),
   non-round, unique cost values; a supported reconciliation; a properly
   segregated approval; a payment claim served and answered the same day; a
   contract event noticed inside its FIDIC 20.2 time bar; a compliant
   covenant reading; a lightly-drawn contingency; two vendors with distinct
   bank accounts; three honest workers whose payroll reconciles against the
   gate log; a critical grievance resolved and closure-verified inside its
   SLA plus an open one still inside its deadline; a parcel taken through
   evidenced compensation to `acquired` before the works it blocks start;
   and a granted, in-date road-closure consent.
4. **Run** — `POST /projects/:id/detectors/run` on both projects,
   `POST /entities/scan` (tenant-wide), `POST /workforce/reconcile` over one
   shared payroll window on both projects, and the list reads that trigger
   the lazy sweeps on both projects (`GET .../contracts/:id/events` for time
   bars, `GET .../payment-claims` for deemed liability, `GET .../grievances`
   for GRM SLA breaches, `GET .../land/schedule-risk` for un-acquired land
   blocking works, `GET .../permits` for lapsed consents and overdue
   determinations).
5. **Score** — signals are collected with `GET /signals` for the company.
   - A scheme is **caught** when a signal with its expected detector exists
     on the planted project (tenant scope for `shared_identifier`, whose
     scan signals carry no project id).
   - **Recall** = caught / planted.
   - **Precision** = signals attributable to planted schemes ÷ all signals
     raised. Attribution is by detector + project id; the same detector
     firing on the clean project is a false positive and is listed by name.

## Planted schemes

Two groups of schemes deliberately share one dataset each, because that is
how the real thing arrives.

- **Schemes 1–3** share one fabricated cost-assertion population (a manually
  invented payment book is exactly the dataset that trips all three
  statistical detectors at once); each detector keys on a different
  signature within it — round share > 40%, one value resubmitted within
  days, and a flat/high first-digit spread with chi-square ≈ 34 against
  Benford.
- **Schemes 12–14** share one payroll run over one 28-day window: a single
  reconciliation pass against the independent site-access stream raises a
  different detector for each of three workers — one paid with no attendance
  at all, one billing more days than the gate recorded, one paid materially
  below the rate on their own contract.

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
| 12 | Worker `RI-W-101`: 18 days and GBP 5,400 of payroll, **zero** site-access records | Domain M #668–669 (M17 ghost-worker elimination via biometric-to-payroll reconciliation) | `ghost_worker` |
| 13 | Worker `RI-W-102`: 22 days claimed against 12 evidenced (1.83×, tolerance 1.15×) | Domain M #669, #676 (M17 payroll vs access reconciliation; WPS ingest) | `payroll_overclaim` |
| 14 | Worker `RI-W-103`: 20 days claimed, 20 evidenced, paid GBP 210/day against a GBP 300 contract rate | Domain M #677, #682 (M17 wage payment verification against hours worked) | `wage_underpayment` |
| 15 | Critical community grievance received 20 days ago (7-day SLA), never acknowledged | Domain J #569–572 (M16 grievance redress mechanism and resolution SLA) | `grievance_sla_breach` |
| 16 | Parcel `RI-LP-014` still `identified` (customary tenure, no title) blocking embankment works that start in 10 days | Domain J #547, #551, #591 (M16 consent-to-programme dependency mapping) | `land_blocks_programme` |
| 17 | Road-closure consent granted 395 days ago on a 360-day term — lapsed 35 days ago | Domain J #585–587 (M19 permit and consent register, expiry sweep) | `permit_expired` |

Everything is planted through the public API, with **one documented
exception**: scheme 9 backdates `servedAt`/`responseDeadline` on the
payment-claim row with a direct DB update after serving the claim through
the API. The serve endpoint always computes the statutory response deadline
forward from the actual date of service, so a claim that is already past
its deadline can only exist after real days pass — the harness ages the
claim in the database instead (the same technique `payments.test.ts` uses).

No other scheme needs a workaround, and the six Phase-5 schemes added none:

- Scheme 8 — the contracts API legitimately accepts past event dates, and
  the 20.2 time bar is computed from the event date.
- Schemes 12–14 — payroll periods and gate logs are historical records by
  nature; the ingest routes accept past windows and past access dates.
- Scheme 15 — grievance intake computes the SLA from `receivedAt` (the date
  the community raised it, never the date it was keyed in), and accepts a
  past `receivedAt`, so a grievance can be born overdue through the API.
- Scheme 16 — the parcel register records blocking task ids honestly; only
  the programme dates make the parcel late, and those are the schedule's.
- Scheme 17 — recording a historic consent with a past grant date and a past
  expiry is exactly how an existing project's permit register is loaded.
  The permit is deliberately given **no** blocking tasks: an expired permit
  that blocked a task would also (correctly) raise `permit_blocks_programme`,
  and this scheme is scored on `permit_expired` alone.

One ordering constraint is load-bearing: scheme 17 grants its permit in the
same plant call that creates it, before any permit list read. The grant
discharges the determination obligation, so the determination-overdue sweep
never sees the permit awaiting a decision — otherwise the plant would raise
a second, unmodelled signal.

One route in the run phase is called as the **operator**, not the reviewer:
`POST /projects/:id/workforce/reconcile` is a standard-level operational
route, and an assurance grant is read-only by design, so Reviewer R cannot
run it. Owner A runs the reconciliation on both projects; R reads the
signals it raises. This is a property of the permission model, not a
workaround.

## Current results

Run of 2026-08-24 (deterministic seed data; reproducible):

```
detectors/run (planted): {"benford_first_digit":1,"duplicate_assertions":1,"round_number_clustering":1,"approval_velocity":1,"segregation_of_duties":1,"contradicted_claimant":1}
detectors/run (clean):   {"benford_first_digit":0,"duplicate_assertions":0,"round_number_clustering":0,"approval_velocity":0,"segregation_of_duties":0,"contradicted_claimant":0}
entities/scan: 4 entities, 1 signal(s)
workforce/reconcile (planted): 3 worker(s), 1 ghost(s), 1 overclaim(s), 1 underpayment(s), 3 signal(s)
workforce/reconcile (clean):   3 worker(s), 0 ghost(s), 0 overclaim(s), 0 underpayment(s), 0 signal(s)
```

| Scheme | Detector | Caught | Signal |
| --- | --- | --- | --- |
| Round-number cost fabrication (12 round cost assertions) | round_number_clustering | yes | Assertion values cluster on round numbers |
| Double claim (3 identical cost assertions, same claimant, days apart) | duplicate_assertions | yes | Duplicate cost assertion (47250 GBP) |
| Fabricated value population (54 cost assertions, flat first-digit spread) | benford_first_digit | yes | First-digit distribution deviates from Benford's Law |
| Self-approval (workflow started and approved by the same user) | segregation_of_duties | yes | Initiator approved own workflow wfi_4o57h9cuoy58v2n3hs6jl |
| Rubber-stamp approvals (3 steps approved seconds after assignment) | approval_velocity | yes | Rubber-stamp approvals by u_vh118dch1a67shf8v3y9r |
| Over-certification (2 rate assertions contradicted by independent survey) | contradicted_claimant | yes | Repeatedly contradicted claimant u_9k91gymk63q3pynltghbn |
| Colluding vendors (2 nominally independent vendors, one bank account) | shared_identifier | yes | Entities share bank account: Marlin Groundworks Ltd / Pelican Formwork Ltd |
| Missed notice time bar (FIDIC 20.2 event 90 days old, never noticed) | time_bar_missed | yes | Notice time bar missed — event #1: Unforeseen ground conditions at CH 2+400 |
| Ignored payment claim (HGCRA claim served, response deadline passed) | payment_deemed_liability | yes | No payment response served in time — deemed liability for GBP 182563.44 |
| Financial covenant breach (DSCR reading below gte threshold) | covenant_breach | yes | Covenant breach — Debt service cover ratio: 1.04 vs required ≥ 1.2 x |
| Contingency exhaustion (drawdown leaves under 20% remaining) | contingency_exhaustion | yes | Contingency "Construction contingency" below 20% remaining |
| Ghost worker (18 days of payroll, zero site-access records) | ghost_worker | yes | Ghost worker — GBP 5400 paid to RI-W-101 with no site access |
| Payroll overclaim (22 days claimed against 12 evidenced) | payroll_overclaim | yes | Payroll overclaim — 10 unevidenced day(s) for RI-W-102 |
| Wage underpayment (paid GBP 210/day against a GBP 300 agreed rate) | wage_underpayment | yes | Wage underpayment — RI-W-103 short by GBP 1800 |
| Grievance SLA breach (critical community grievance 20 days old, unresolved) | grievance_sla_breach | yes | Grievance GRV-1 past its resolution SLA by 13 day(s) |
| Un-acquired land blocking imminent works (parcel identified, task starts in 10 days) | land_blocks_programme | yes | Land not acquired blocks "Embankment construction CH 3+000 to CH 3+800" — parcel RI-LP-014 |
| Lapsed consent (road-closure permit granted, expiry 35 days past) | permit_expired | yes | Permit expired — Riverside County Highways: Temporary closure of Riverside Approach for deck erection |

**Recall 17/17, Precision 100.0% (17/17 signals attributable to planted
schemes), false positives: none.**

Signal ids and generated user ids differ per run (they are freshly minted
against an in-memory database); everything else — which detectors fire, how
many, on which project, and with which numbers in the title — is
deterministic.

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
  cross the 20% line; the overclaim is 1.83× against a 1.15× tolerance).
  Recall of 17/17 on adversarially *cooperative* data is a floor-check, not
  a field measurement.
- **Precision here is measured against one clean project** with plausible
  but idealized innocent data. The control has been sharpened — the three
  honest workers each sit just inside a *different* tolerance (1.06× claimed
  vs evidenced days; 0.975× of the agreed daily rate), one grievance is open
  but inside its SLA, and the acquired parcel blocks works that start in 14
  days — so the detectors are shown to key on the breach rather than on the
  shape of the data. But real projects contain far messier honest data
  (legitimately round lump sums, genuinely fast approvals of trivial items,
  gate logs that miss a whole shift, cash-paid day labour) that this control
  does not model. **Real-world precision will be lower**, and the honest
  expectation is that the payroll reconciliation in particular will produce
  false positives wherever access control is patchy — which is exactly the
  kind of project where ghost workers live.
- **Coverage is 17 detectors across six domains**, and the headline number
  should not be read as "17 of Domain A's 114". Only schemes 1–7 are Domain
  A functions proper, so **Domain A coverage is 7 of ~114**. Schemes 8–11
  are its cross-domain analogues in the contract, payment, finance and
  cost-control engines (Domains C, F, O, H) — the same "someone let a clock
  run out or a threshold pass" family, wired into different registers. The
  six added in Phase 5 are safeguard detectors from the Tier-4 modules:
  Domain M (workforce rights — ghost worker, payroll overclaim, wage
  underpayment),
  Domain J (land and community — grievance SLA breach, land blocking the
  programme) and the M19 permit register (lapsed consent). Shipped but
  **not** exercised by this harness — because no scheme plants their inputs
  — are `underage_worker_blocked`, `labour_rights_indicator`,
  `accommodation_overcrowding`, `welfare_standard_failure`,
  `labour_cap_overdue`, `permit_determination_overdue`,
  `permit_blocks_programme`, `carbon_budget_exceeded`,
  `social_value_shortfall` and `local_content_shortfall`; each has unit-test
  coverage in its module but no ground-truth entry here. The recall
  denominator is "schemes we planted", not "schemes that exist" and not
  "detectors we ship".
- **One plant still requires a database write** — scheme 9's backdating,
  above — because the API correctly refuses to create a claim that is born
  overdue. The six Phase-5 schemes added none: payroll periods, gate logs,
  grievance receipt dates and historic permits are all legitimately
  backdatable through the public API, which is why time-dependent detectors
  can be exercised by aging records rather than by waiting. That asymmetry
  is itself worth reading: where the API refuses a backdate it is protecting
  a statutory clock, and the harness has to reach past it.
- **Severity and money figures in the signals are the model's, not a
  finding.** "GBP 5,400 paid with no site access" is what the payroll file
  said, reconciled against what the turnstile said. It is a question to put
  to the employer, not a proven theft.

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
   **both** projects. If it fires from an operational route the reviewer
   cannot call (an assurance grant is read-only), call it as Owner A and say
   so in a comment — see the workforce reconciliation.
5. Check the plant does not raise a **second** detector's signal by
   accident. Anything the ground truth does not account for is counted as an
   unattributed signal and drags precision below 100%, even though it does
   not fail the run. Scheme 17's "no blocking tasks" note is exactly this
   trap: an expired permit that blocks a task legitimately raises
   `permit_blocks_programme` too.
6. Run `pnpm --filter @constructos/api eval:retrodetect` and update the
   results section above. The script exits non-zero until the new scheme is
   caught and the clean project stays silent.
