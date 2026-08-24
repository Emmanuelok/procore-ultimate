# ConstructOS — Roadmap

Maps the committed codebase onto the master specification
(`docs/master-specification.md`), then lays out the remaining build mirroring the
Volume III module tiers. Function numbers cite the spec: Vol I numbers are the Procore
inventory (#1–804), Vol II numbers run continuously across the gap domains (#1–~1100,
Domain A starting at #1, Domain B at #115, Domain C at #193, Domain D at #265,
Domain E at #321, Domain F at #358, Domain G at #394, Domain H at #447, Domain O at
#729, Domain S at #859, Domain X at #995).

Four increments are delivered: **Phase 0/1 — Foundation** (the delivery subset +
assurance skeleton), **Phase 2 — Tier-2 commercial seed (M7 + M8)**, **Phase 3 —
Tier-2 forensics & payment security (M9 + M10, on a native §2.6 schedule core)**, and
**Phase 4 — Tier-3 programme & capital governance (M12–M15)**.
Phases 2–4 are a deliberate deviation from the spec Vol III §5 ordering (assurance core
before commercial depth): the commercial/forensic/governance engines landed before the
Tier-1 ingestion layer (M6). The deviation is contained — M7 was built so that every
certified value crosses into the assurance layer as an `Assertion`; M9/M10 materialize
their deadlines and breaches into the same `obligations`/`signals` tables; and Phase 4
extended the identical pattern to lender conditions, gate conditions and dispute
timetables (ADR 0012), so nothing shipped that Tier-1 will have to unwind; but **M6
remains the gate to the sellable assurance claim** and is called out as such below. The
"parity trap" warning (Vol III §1) is still treated as binding: Volume I parity stays
last.

---

## Phase 0/1 — Foundation (delivered)

An honest inventory. The foundation is a working Procore-class delivery subset **plus** the
assurance skeleton: all eight Vol III §4 primitives as live tables with routes, a
hash-chained per-tenant ledger written by every module, six real detectors, and segregated
assurance roles. It is a foundation, not a product tier — most function counts below are
small subsets of their spec sections.

### Implemented from Volume I (delivery platform subset)

| Spec area | Implemented (representative function numbers) | Where |
|---|---|---|
| §0.1 Identity & tenancy | #1–2 tenants & multi-company, #7–12 directory/vendor merge/distribution groups, #13–15 permission templates + levels + overrides, #26 login audit, #27–28 delegated admin/guests | `modules/identity`, `modules/directory`, `modules/admin`, `plugins/auth.ts` |
| §0.3 Core object model | #49–52 projects/stages/portfolios, #54–55 location tree, #56–61 cost codes & WBS, #62–64 custom fields, #66 tags, #68–70 comments/@mentions/watchers, #72 auto-numbering, #73 cross-tool links | `modules/projects`, `packages/db/src/schema/core.ts` |
| §0.4 Workflow engine | #79–87 configurable sequential/parallel/conditional approvals with delegation, #89 template versioning, #91–92 status & audit | `modules/workflow` |
| §0.5 Notifications | #94 in-app notification centre | `modules/notifications` |
| §1.4 BIM | #231 IFC upload, #232 federation, #233 web viewer (client-side `web-ifc`), #235 element properties, #236 versioning, #240–241 coordination issues | `modules/bim`, `apps/web/src/pages/bim` |
| §2.1 Drawings | #256–261 bulk upload/auto-naming/review queue/revisioning/current-set, #263–264 hyperlinks, #266–276 disciplines, markups, layers, calibration, pins, #281 log | `modules/drawings` |
| §2.3 Documents | #290–293 folders/permissions/versioning/check-out, #295 bulk upload, #297 private flag, #299 download tracking | `modules/documents` |
| §2.4 RFIs | #302–309 lifecycle incl. ball-in-court, #313 official response, #316–317 impact flags, analytics | `modules/field/rfis.ts` |
| §2.5 Submittals | #326–339 subset: types, review chains (sequential/parallel), response codes, resubmit chain, lead-time submit-by | `modules/field/submittals.ts` |
| §2.7 Daily log | #372–397 subset: structured sections, weather, submit/approve, missing-days | `modules/field/dailyLogs.ts` |
| §2.8 Punch | #398–408 subset incl. two-stage assignee/verifier sign-off, before/after photos | `modules/field/punch.ts` |
| §2.10 Photos | #426–433 subset: albums, EXIF timestamp, GPS, location tagging | `modules/field/photos.ts` |
| §2.14 Coordination issues | #465–470 subset (BCF-style viewpoints, element refs) | `modules/bim` |

### Implemented from Volume II (the wedge)

| Domain | Implemented | Where |
|---|---|---|
| **S — Evidentiary integrity** | #859 append-only hash-chained log, #862 hash-at-ingest (retrieval verification pending), #863 tamper detection via `/ledger/verify`, #866 edit detection (chain break), #871–872 exportable ledger + chain-of-custody foundations, #882 evidence pack assembly (Merkle root + inclusion proofs) | `packages/ledger`, `lib/ledger.ts`, `modules/assurance` |
| **A — Procurement integrity** | Detector seed: #37 approval velocity, #40 segregation-of-duties violation, #58 Benford's Law, #66 over-certification (contradicted claimant), plus duplicate-assertion and round-number clustering; #90–92 the three assurance roles; #97–98 signal register with severity/disposition + reviewer-only escalation | `modules/assurance/detectors.ts`, `assurance_grants` |
| **L — Handover & twin** | #627–629 asset register/hierarchy/tagging, #630 COBie export, #632/#635 delivery milestones (MIDP/TIDP), #639–640 CDE states + suitability enforcement, #642–644 warranty register & expiry, #658–659 twin instantiation + sensor association | `modules/twin`, `modules/bim` |
| **X — AI architecture** | #1019 citations on every run, #1020 human-in-the-loop queue, #1021 model audit trail with input provenance; 8 agent kinds; deterministic disabled mode | `modules/ai` |

### Against the Volume III module map

| Vol III module | Status in foundation |
|---|---|
| M1 Evidence Ledger | **Core shipped** — chain, canonical JSON, Merkle packs, verify route. Missing: anchoring/escrow, trusted time (see `docs/security.md` §8) |
| M2 Integrity Signal Engine | **Seeded** — 6 of Domain A's 114 detectors, run-on-demand, ledgered signals, reviewer disposition loop |
| M3 Reconciliation Engine | **Seeded** — assertion/evidence/reconciliation CRUD, automatic variance scoring (±5%/±15% thresholds), independence rule enforced |
| M4 Entity Graph | **Seeded** — entities, typed relationships, graph walk, shared-identifier scan (`POST /entities/scan`), vendor→entity mirror |
| M5 Assurance Workspace | **Seeded** — the three roles wired through auth; assurance pages in the web app; time-boxed regulator grants |
| M6 Ingestion Layer | **Not started** — today all data arrives through ConstructOS's own API |
| M7 Measurement & valuation | **Delivered (Phase 2, subset)** — BoQ/taking-off/valuation/certification/variations; see the Phase 2 section for the exact function-number in/out list |
| M8 Contract intelligence | **Delivered (Phase 2, subset)** — clause library in code, PC overlay, time-bar engine, EOT, LD exposure, obligation register; see Phase 2 section |
| M9 Delay & disruption forensics | **Delivered (Phase 3, subset)** — delay events, fragnet TIA, as-planned vs as-built, scoped windows attribution, prolongation seed, claims chain + chronology; see Phase 3 section |
| M10 Payment security | **Delivered (Phase 3, subset)** — five statutory regimes in code, deadline engine, deemed-liability sweep, suspension, interest; see Phase 3 section |
| M11 Independent benchmarking | Not started (sequenced behind multi-tenant data; see Tier 2 remainder) |
| M12 Business case & stage gates | **Delivered (Phase 4, subset)** — five-case model, CBA to NPV/BCR, stage gates + decision register, conditions as obligations, benefits register; see Phase 4 section |
| M13 Quantitative risk | **Delivered (Phase 4, subset)** — seeded QCRA/QSRA Monte Carlo, reproducibility endpoint, contingency drawdown discipline; see Phase 4 section |
| M14 Disbursement & conditionality | **Delivered (Phase 4, subset)** — facility register, CP gate on submission, evidence-backed satisfaction, covenant signals; see Phase 4 section |
| M15 Dispute support | **Delivered (Phase 4, subset)** — dispute register + timetable obligations, pleadings, Merkle-manifest bundles + verify, settlement modelling; see Phase 4 section |
| M16–M19 | Not started |

Not implemented at all (deliberately): Vol I §1.1–1.3 (bid/estimating/prequal), §2.2 specs,
§2.9/2.11–2.13, §3 financial suite, §4 quality & safety, §5 resources,
§6 analytics; Vol II domains I–K, M–N, P–R, T–Z beyond the seeds listed above (Domains B
and C gained real coverage in Phase 2, Domains D and F plus the §2.6 schedule core in
Phase 3, Domains E, G, H and O in Phase 4, below).

---

## Phase 2 — Delivered: Tier-2 commercial seed (M7 + M8)

Committed and tested: `apps/api/src/modules/commercial/` + `modules/contracts/` (with
colocated test suites), schema `packages/db/src/schema/commercial.ts` / `contracts.ts`,
web pages `apps/web/src/pages/commercial/` / `pages/contracts/`. Architecture write-up in
`docs/architecture.md` §10–11; table catalogs in `docs/data-model.md` §12–13; new
segregation-of-duties rules in `docs/security.md` §2.4; ADRs 0007 (clause library in code)
and 0008 (certification independence).

Precision matters here — this is a *subset* of Domains B and C, and the boundary is drawn
function-by-function:

### M7 — Measurement & valuation (Domain B)

**In:**

| Spec functions | What shipped |
|---|---|
| #115–116 | BoQ as a contractual object with forward-only `draft → issued → agreed` lifecycle; hierarchy `bill > section > item` (three levels — no work-section/sub-item tiers; items may hang off bills in small BQs, a documented relaxation) |
| #128–130, #132–134 (as item types) | prelims fixed vs time-related, provisional sums defined/undefined, prime cost, daywork, contingency, spot items — classification and totals by type, not the full procedural machinery (no percentage-addition daywork schedules, no nominated-subcontractor handling #131) |
| #135–136 subset | taking-off lines with timesing/length/width/depth dimension columns and manual-override capture; no waste-calculation dimension paper |
| #139–140 | quantity provenance: taking-off lines cite `drawingSheetId`; `takeoff/apply` makes the item quantity Σ of its lines — drawing → dimension → bill item is traceable |
| #145, #149 | rate build-up sheets (labour/material/plant/overhead/profit) with enforced reconciliation to the item rate (±0.01) |
| #162–164, #166–167 subset | interim valuations on remeasure and %-of-item bases; materials on/off site as values (no vesting certificates #166 or off-site bonds #167); `milestone` is an accepted basis label with no activity-schedule mechanics behind it (#165) |
| #168–171 | variation valuation at BQ rates (exact-rate discipline), pro-rata, star rates, dayworks; the value build-up ledgered with full payload — the rate-derivation audit trail |
| #179–180 | payment certificates with certifier ≠ submitter enforcement, and the certificate-vs-application variance statement persisted with reason |
| #184 (seed only) | `commercial/summary` — boqTotal / certifiedToDate / retentionHeld / variations position / forecastFinal. **This is the whole of CVR today** |

**Out (explicitly not built):** #117–126 measurement-standard rules engines and validation
(`method` is declared metadata — nrm2/smm7/cesmm4/pomi/custom — nothing validates item
coding against the standard); #137–138 abstracting/billing and query sheets; #141–144
automated quantity extraction from 2D/BIM; #146–148 all-in labour/plant/material rate
build-ups; #150–161 rate libraries, price books, elemental cost planning; #172–173
provisional-quantity remeasurement and provisional-sum adjustment; **#174–178 fluctuation
formulae** (NEDO/BCIS, FIDIC 13.8, index ingestion, currency adjustment); #181–183 final
account; #185–192 CVR beyond the summary (WIP/accruals, over/under-certification statement,
cash-flow S-curve, earned value, subcontract package control, BQ interchange export,
cross-project rate benchmarking).

### M8 — Contract intelligence (Domain C)

**In:**

| Spec functions | What shipped |
|---|---|
| #193–196, #203, #214–215 | clause-level library for FIDIC Red 1999/2017, Yellow 2017, Silver 2017, NEC3/NEC4 ECC, JCT SBC/DB 2016 — **in versioned code, not the database** (ADR 0007); ~80 clauses with categories, notice parties, time bars, standing obligations |
| #200 (partial) | 1999-vs-2017 variance is modelled as separate forms with delta clause sets (e.g. FIDIC 20.1 28-day contractor-only bar vs 20.2 mutual bar); no 2022 amendments |
| #201–202 | Particular Conditions overlay on the contract record; effective-clause view flags amendments against the standard form |
| #204 (recorded) | NEC option A–F required on NEC forms; no option-variant pricing logic behind it |
| #205 (partial), #206 | early-warning events in the register (no register meetings); compensation-event lifecycle with the NEC 61.3 eight-week bar |
| #225–230 | **the time-bar engine**: automatic notice deadline from event date + clause; per-clause notice-requirement data; service method + proof-of-service capture; breach warning *before* expiry (deadline radar + `warnDaysBefore` obligations); breach recording where missed (`time_barred` + breached obligation + critical signal) |
| #231 (partial) | condition-precedent compliance is trackable through the obligation status trail (open/satisfied/breached), not a dedicated register |
| #237–238 | EOT claim lifecycle mapped to clause and supporting events; assessment independence (assessor ≠ raiser); agreed awards move the completion date, ledgered |
| #249–250 | LD accrual from rate × days late with cap monitoring |
| #260 | contract obligation register — standing obligations materialized into assurance `obligations` at contract creation; notice obligations at event creation. The register *is* the assurance table, not a mirror |

**Out (explicitly not built):** #197–199 FIDIC Green/Gold/Emerald; #207–213 NEC
quotation/Defined Cost/SCC/Accepted Programme machinery; #216–224 further forms (JCT
Intermediate/Minor Works, PPC2000, AS4000/AS2124, Hong Kong GCC, PSSCOC/REDAS, CPWD/NHAI,
Gulf forms); #232–236 the determination register proper (EOT `assessedBy` is the only
determination captured; no reasoning publication or notices of dissatisfaction); #239–248
concurrent-delay apportionment, risk-event classification, force-majeure register semantics
(an event `kind` exists, nothing more), change in law, suspension/termination sequences,
taking-over/sectional completion, DNP and performance certificates; #251–259 bonuses,
performance security, guarantees, retention substitution, warranties, novation,
back-to-back flow-down; #261–264 obligation dashboard, clause-tagged correspondence,
privilege segregation. **No statutory payment engines** — HGCRA / Security-of-Payment
regimes are Domain F (M10); deadlines that count backwards from a payment date (JCT Pay
Less) are described in the clause library but deliberately carry no computed time bar.
*(That gap is now filled by Phase 3's M10 — the statutory clocks run in
`modules/payments/regimes.ts`, not in the clause library, which keeps its refusal to
compute what it cannot compute correctly.)*

### Phase-2 status against the old Tier-2 acceptance criteria

1. *"A certified interim valuation traced item-by-item to BQ lines and evidence (B#140)"* —
   **half met**: item-by-item tracing to BQ lines, taking-off sheets and source drawings is
   live; tracing to *independent evidence* waits on M6 ingestion + M3 reconciliation. The
   hook exists: every certificate already lands as a `cost` Assertion (ADR 0008).
2. *"A time-bar warning fired before expiry on a live contract (C#229)"* — **mechanism
   delivered** (deadline radar + `warnDaysBefore` obligations + `/obligations/upcoming`);
   firing it on a *live* contract is a deployment milestone, not an engineering one.
3. *"One delay analysis assembled solely from ledgered contemporaneous records (D domain)"*
   — **mechanism delivered in Phase 3**: the claims chronology assembler reads only
   platform records that were ledgered when written (delay events, contract events/notices,
   RFIs, daily-log delay entries, instructed variations), and TIA runs are persisted and
   ledgered. Running it on a *live* dispute is a deployment milestone, as with criterion 2.

---

## Phase 3 — Delivered: Tier-2 forensics & payment security (M9 + M10 + schedule core)

Committed and tested: `apps/api/src/lib/cpm.ts` (pure CPM engine) +
`apps/api/src/modules/schedule/` + `modules/forensics/` + `modules/payments/` (with
colocated test suites), schema `packages/db/src/schema/schedule.ts` / `forensics.ts` /
`payments.ts`, web pages `apps/web/src/pages/schedule/` / `pages/forensics/` /
`pages/payments/`. Architecture write-up in `docs/architecture.md` §12–14; table catalogs
in `docs/data-model.md` §14–16; segregation-of-duties additions in `docs/security.md`
§2.4; ADRs 0009 (pure CPM engine, persisted computed dates) and 0010 (statutory regimes
in code).

The completed criterion 3 mechanism above rests on the schedule core: delay analysis
needs a programme, so a **Vol I §2.6 subset** shipped alongside the Vol II modules —
#351 native creation/editing, #352–353 Gantt + critical path (pure-SVG client side),
#354 FS/SS/FF/SF dependencies with lag, #355–357 baselines & comparison, #358/#361
progress, #359 lookahead, #360 assignment, #371 health indicators (a DCMA-style
ten-check subset that also serves Domain D #283). Not built from §2.6: #349–350 XER/MPP
import, #362–365 cross-tool linkage (submittal/RFI/inspection/action-plan), #366
milestone tracking beyond zero-duration tasks, #367–370 calendar view, change
notifications, narrative attachments, resource loading. No working calendars — durations
are calendar days (ADR 0009).

As with Phase 2, the boundary is drawn function-by-function:

### M9 — Delay & disruption forensics (Domain D)

**In:**

| Spec functions | What shipped |
|---|---|
| #265, #267 | delay event register with cause classification (10 `DELAY_CAUSES`) and excusable/compensable entitlement classification, compensable ⇒ excusable enforced |
| #266 (partial), #268 (partial) | delay → contract-clause mapping via the linked `contractEventId` (the served notice carries the clause); culpability attribution rests on the classification flags + validated assurance `evidenceIds` per event — no dedicated attribution workflow |
| #269 | as-planned vs as-built against a captured baseline, actuals preferred over forecast, per-task and headline slip |
| #272 | Time Impact Analysis by fragnet insertion (`modules/forensics/tia.ts`): virtual fragnet after the struck task, `start_no_earlier_than` on the delay start, before/after completion delta persisted per event |
| #273 (scoped) | windows attribution with configurable boundaries — events bucketed by start date, classification days and per-event TIA deltas summed per window; the API response itself states the method limitation |
| #283 | programme quality assessment — the DCMA-style subset in `modules/schedule/quality.ts` |
| #299 (seed) | prolongation from time-related preliminaries: explicit rate or derived from `prelims_time` BQ items over the programme duration, derivation string returned |
| #304–306 | claims workspace with the enforced cause-effect-entitlement-quantum chain (frozen after draft), delay-event linking, evidence linking via events |
| #310 (partial — the response side) | claim assessment with enforced independence: assessor ≠ creator (403), `assessedBy` stamped, assessed days/amount ledgered with the transition (the code cites #310 at the enforcement point, `modules/forensics/index.ts`) |
| #318 | claim chronology auto-assembly from platform records (delay events, contract events + notices, RFIs, daily-log delay sections, instructed variations), cached with generation time |

**Out (explicitly not built):** #270–271 impacted-as-planned and collapsed as-built
methods; **#274–277 retrospective longest path, time slice, SCL Protocol (2nd ed.)
methodology alignment and AACE RP 29R-03 method selection** — the platform runs *one*
prospective method (fragnet TIA) and labels its windows view honestly rather than
claiming protocol coverage; #278–282 concurrency, pacing, float ownership/consumption,
critical-path migration tracking; #284–288 programme-revision forensics
(out-of-sequence, logic-change, constraint-manipulation, duration-change detection,
baseline integrity verification); #289–298 disruption as a discipline — **#290 measured
mile**, earned-value quantification, industry curves, cumulative impact, trade stacking,
learning curve, acceleration build-ups; #300–303 site/head-office overheads —
**#301 Hudson/Emden/Eichleay formulae** (named out of scope in
`modules/forensics/prolongation.ts`), loss of profit, finance charges; #307–309 record
sufficiency scoring, gap identification, submission package assembly; #310's structured
rebuttal management beyond the assess/reject transition; #311–320 counterclaims,
valuation ranges, success-probability modelling, global/total-cost claim warnings,
expert-report schedules, Scott Schedules, portfolio claim roll-up.

### M10 — Payment security (Domain F)

**In:**

| Spec functions | What shipped |
|---|---|
| #358–360 | statutory payment claims per regime with the deadline engine: response deadline + final payment date computed from the later of the statutory reference date and service, calendar or business day basis per regime |
| #361 | deemed-liability consequence: lazy sweep flips unanswered served claims to `deemed`, breaches the materialized obligation, raises a critical `payment_deemed_liability` signal embedding the regime's deemed rule; deadline radar + `warnDaysBefore` obligations give the pre-expiry warning |
| #362 | right-to-suspend notices with the regime's statutory notice period (`effectiveFrom`), lift returning the claim to `deemed` |
| #364–366, #367 (NSW only), #368–369 | five regimes in code (`modules/payments/regimes.ts`): UK HGCRA (+#365 payment notice / pay-less engine with ground-stating), Singapore SOPA, NSW SOPA, Malaysia CIPAA (deemed = disputed, modelled honestly), NZ CCA — each with documented simplifications (ADR 0010) |
| #386 (seed) | days-to-pay analytics: status mix, avg served→paid days, outstanding book valued at on-time response amounts, deemed exposure |
| #387 | late-payment interest: simple ACT/365 at the regime's pinned modelled rate on the outstanding amount, statutory formula quoted in the response |

**Out (explicitly not built):** #363 entitlement calculation per statute (the claimed
amount is operator-entered, optionally linked to a valuation); #367 Australian
state-by-state variants beyond NSW; #370–372 Ireland CCA, Canadian prompt payment,
US prompt-payment statutes; **#373–377 the lien family** (mechanic's lien deadline
engines, preliminary notices, notices of intent, filings/releases, stop notices);
**#378–381 retention trusts and project bank accounts** (PBA integration, cascading
payment verification, tier-2/3 visibility); #382 pay-when-paid validity checking;
#383–384 retention release deadlines and bond substitution; #385, #388 supply-chain
payment reporting duties; #389–391 insolvency early warning and financial-health
monitoring; #392–393 set-off justification register and unlawful-deduction detection.
**No adjudication case management** — that is Domain E (#329–333, module M15); the
`referred` claim status exists in `PAYMENT_CLAIM_STATUSES` with no workflow behind it,
and each regime's `adjudicationNote` is descriptive only. Statutory day counts are an
engineering model (no public-holiday calendars, pinned interest rates, single-base-date
timelines) — documented in the regime file header and ADR 0010, and not legal advice.
*(Phase 4's M15 now supplies the dispute register and procedural timetable engine an
adjudication runs on — the #329–330 register/timetable subset — but a `referred` payment
claim is still not auto-linked to a dispute record, and adjudicator nomination #331 and
decision enforcement #333 remain open.)*

---

## Phase 4 — Delivered: Tier 3 programme & capital governance (M12–M15)

Committed and tested: `apps/api/src/lib/montecarlo.ts` (pure seeded Monte Carlo engine)
+ `apps/api/src/modules/risk/` + `modules/governance/` + `modules/finance/` +
`modules/disputes/` (with colocated test suites), schema
`packages/db/src/schema/risk.ts` / `governance.ts` / `finance.ts` / `disputes.ts`, web
pages `apps/web/src/pages/risk/` / `pages/governance/` / `pages/finance/` /
`pages/disputes/`. Architecture write-up in `docs/architecture.md` §15–18; table
catalogs in `docs/data-model.md` §17–20; segregation-of-duties additions in
`docs/security.md` §2.4; ADRs 0011 (seeded deterministic Monte Carlo) and 0012
(conditionality as obligations — the one deadline primitive now spanning time bars,
payment deadlines, lender conditions, gate conditions and dispute timetables).

As with Phases 2–3, the boundary is drawn function-by-function. The headline exclusions,
named up front because each would otherwise be assumed in: **no reference-class
forecasting database (G#403)**, **no Redfern schedules (E#340)**, **no PPP/concession
models (O#752–756)**, **no World Bank/ADB/AfDB withdrawal-application formats (O#734)**,
and **no correlation modelling between risks (H#461–462)** — the Monte Carlo results
carry `correlationModelled: false` in the payload so the narrowness is surfaced, not
hidden (ADR 0011).

### M12 — Business case & stage gates (Domain G)

**In:**

| Spec functions | What shipped |
|---|---|
| #394–395 | SOC/OBC/FBC lifecycle over the five-case model; approved/rejected cases immutable; approver ≠ author enforced (403) |
| #396 (short-list half), #397 | options appraisal with server-computed NPV/BCR per option; do-nothing/do-minimum counterfactual flag — no long-list→short-list narrowing workflow |
| #398–399 | CBA with discounting; NPV, BCR and simple undiscounted payback (`modules/governance/appraisal.ts`, unit-tested) |
| #401–402 | configurable social discount rate (default 3.5% Green Book STPR); optimism bias uplift applied to capex only (documented modelling choice) |
| #408–409 | gate definitions with criteria, Gateway 0–5 numbering, planned dates |
| #412, #414 | decision register (every review retained, latest governs) with `proceed / proceed_with_conditions / hold / stop`; five-point RAG delivery confidence with narrative; findings must cover every criterion; a `stop` lands in the assurance `events` graph |
| #413, #415 (seed) | conditions of approval materialized as assurance `obligations`, tracked to closure; open-conditions radar across all gates |
| #416–418, #420 | benefits register with owner/measurement method/baseline/target; realisation readings with documented status thresholds and owner notification on at_risk/missed; disbenefits as direction-aware reduction targets |

**Out (explicitly not built):** #400 EIRR; **#403 reference-class forecasting
database** and #404–405 outside-view estimates and uplift-challenge workflow; #406–407
sensitivity/switching values and distributional impact; #410 gate evidence-pack assembly
(criteria can flag `evidenceRequired`; nothing assembles a pack — the Merkle evidence-pack
machinery exists in the assurance module for this); #411 an independent reviewer
workspace (gate reviews stamp `reviewedBy` but enforce no reviewer independence — noted
in `docs/security.md` §2.4); #419 benefits dependency networks; #421–422 outcome/output
logic models; #423–446 the whole programme/portfolio layer (aggregation, MCDA,
affordability envelopes, appropriations, capitalisation, grant conditions, PIR, lessons
learned, board pack automation, disclosure).

### M13 — Quantitative risk (Domain H)

**In:**

| Spec functions | What shipped |
|---|---|
| #447, #449–450, #452–453 | risk register with 1–5 probability × impact, six categories, pre/post-mitigation scoring, owner assignment, mitigation actions with cost |
| #454 | mitigation cost vs expected value — analytic distribution means, post-mitigation EV scaled by the qualitative score ratio (documented proxy, stated in the response) |
| #455 | risk-to-schedule-activity mapping (`scheduleTaskId`, validated) |
| #457–458 | QSRA and QCRA by seeded Monte Carlo (`lib/montecarlo.ts`); QSRA runs the pure CPM engine per iteration |
| #459–460 | three-point estimating via triangular/PERT; six distribution kinds (triangular, PERT, uniform, normal, lognormal, discrete), wire-validated |
| #464 (count half) | iteration count configuration (clamped); **plus the reproducibility endpoint** — seed + full input snapshot persisted per run, `/rerun` replays and deep-compares percentiles (ADR 0011). Convergence testing is not built |
| #465–468 | P10/P50/P80/P90/P95 for cost and completion date; tornado ranking by correlation with total; per-task criticality index and duration sensitivity |
| #469–471 | confidence-level contingency setting citing its source simulation; drawdowns citing realised risks; cumulative drawdown curve (actuals only — no planned curve) |
| #473–474 | contingency exhaustion warning (high signal on the draw crossing 20% remaining, once); management reserve held apart from risk contingency |

**Out (explicitly not built):** #448 risk breakdown structure; #451 appetite/tolerance
thresholds; #456 risk-to-cost-line mapping; **#461–462 correlation matrix and
common-cause modelling** — the engine samples independently and says so in every result
(`correlationModelled: false`); Iman–Conover rank correlation is the named roadmap item
(ADR 0011); #463 probabilistic branching; #472 contingency release authority workflow
(the drawdown records `approvedBy` = the caller; there is no separate approval step —
`docs/security.md` §2.4); #475–476 risk-adjusted forecasts; #477–482 escalation,
currency, commodity, interest-rate, political and force-majeure modelling; #483–486
register versioning/trend, velocity, horizon scanning, opportunity register; #487–490
independent challenge workspace, maturity assessment, portfolio aggregation and
contingency optimisation.

### M14 — Disbursement & lender conditionality (Domain O)

**In:**

| Spec functions | What shipped |
|---|---|
| #729 | funding facility register with lender and instrument type (loan/grant/equity/guarantee/blended) |
| #730–731 | conditions precedent and subsequent, each materialized as an assurance obligation (ADR 0012); overdue sweep breaches + signals; **satisfaction requires validated evidence ids**; waiver is admin-level with reason; breached obligations stay breached |
| #732 | disbursement request preparation with expenditure evidence assembly |
| #733 | **the conditionality gate**: submission is refused (409) while any CP is open or breached; the verification snapshot is persisted on the request either way, and a blocked attempt is itself ledgered |
| #735, #769 (seed) | statement of expenditure (JSON + CSV) from the numbered request history |
| #739 | category/allocation limit monitoring — pipeline may exceed neither committed amount nor category limit |
| #740 (actuals half), #741 | disbursed vs pipeline positions (no forecast model); undisbursed balance and closing-date monitoring |
| #742–743 | covenant compliance with signed headroom computed at write; breach = critical `covenant_breach` signal; worst-case covenant status in the project summary |

**Out (explicitly not built):** **#734 withdrawal-application generation in World
Bank/ADB/AfDB formats** (the gate and the evidence assembly exist; the lender-specific
document formats do not); #736–738 designated/special account reconciliation, eligible
vs ineligible expenditure classification and recovery; #740's forecast half; #744–745
lender's technical advisor / independent engineer certification workspaces; #746–751
milestone-triggered disbursement, drawdown-vs-programme alignment, cash-flow waterfall,
DSRA monitoring, IDC and commitment fees; **#752–756 PPP/concession models**
(availability payments, deduction/abatement, unitary charge, refinancing gain share);
#757–768 equity schedules, sponsor support, tranche management, counterpart funding,
lender procurement-compliance (ICB/NCB, prior review, no-objection #763,
misprocurement), fiduciary ratings and audit-finding tracking; #770 financial
statements. Covenant readings are operator-entered values — the ratio is not yet
computed from platform records.

### M15 — Dispute support (Domain E)

**In:**

| Spec functions | What shipped |
|---|---|
| #321 (register subset), #329, #334–336 | dispute register across DAAB, statutory adjudication, mediation, expert determination, arbitration and litigation, with forum capture, linked contract, referred forensic claims (validated) and a counterparty from the entity graph |
| #325, #330, #338 | referral/submission timetables: every dated step materializes an assurance obligation (`warnDaysBefore: 3`); missed-deadline sweep breaches + raises `dispute_deadline_missed`, once; forward-only escalation ladder |
| #337 | institutional rules recorded per dispute (free-text reference — no rules engine) |
| #339 | pleadings register (referral/response/reply/rejoinder/witness statement/expert report/decision/award) per party, dated, file-backed |
| #343–344 | hearing bundle assembly with sequential tab numbering and an exportable index; chronological ordering; **generation freezes a Merkle-rooted manifest over per-item content hashes, and `/verify` recomputes hashes + root against today's records** — E-domain production tied to the Domain S integrity machinery |
| #349 (decision half) | decisions require a recorded outcome with `decidedAt`; enforcement tracking is not built |
| #350–352 | settlement offer register (open / WP / WP-save-as-to-costs); acceptance settles the dispute, ledgered; expected-value settlement analysis with the arithmetic in the rationale |

**Out (explicitly not built):** #322–324 DAAB member independence, site visits, informal
assistance; #326–328 DAAB decision compliance, notices of dissatisfaction, amicable
settlement periods; #331–333 adjudicator nomination generation, adjudication
response-management specifics, decision enforcement; **#340 Redfern Schedule
generation** and #341–342 document production and privilege/redaction workflow; #345–348
witness statement versioning, expert joint statements, hot-tubbing materials,
transcripts; #351's Part 36/Calderbank costs-consequence engine (the offer bases are
recorded, the consequences are not computed); #353–357 provisioning, legal cost
tracking, recovery-vs-cost analysis, outcome database and root-cause analytics.

### Phase-4 status against the Tier 3 acceptance criteria

1. *"A drawdown certificate generated only from `supported` reconciliations (O domain)"*
   — **partially met, honestly short of the bar**: the conditionality gate blocks
   submission on open CPs and satisfaction demands assurance evidence, but conditions are
   discharged by *evidence*, not by `supported` *reconciliations* — the reconciliation-
   gated drawdown waits on M6 ingestion + M3 methods producing reconciliations worth
   gating on. The hook is in place: condition satisfaction already points at `evidence`
   rows, and the disbursement carries its verification snapshot.
2. *"A dispute bundle exported with chain-of-custody documentation (E domain + S#872),
   verifiable by the receiving party against the escrowed chain head"* — **mechanism
   delivered except escrow**: the frozen manifest (tabs, content hashes, Merkle root),
   the CSV export and the `/verify` recomputation exist and are ledgered; verification
   *against an escrowed chain head* waits on external anchoring — still open gap #2 in
   `docs/security.md` §8.2.

---

## Tier 1 — Assurance core completion (M1–M6) — open

*(This section was headed "Phase 2 — Assurance core complete" in earlier revisions; ADR
0004 and `docs/security.md` refer to its content as Tier-1 roadmap work. The Phase 2 that
actually shipped is the commercial seed above; the work below is unchanged and remains the
gate to the sellable assurance product.)*

Goal: turn the seeds into the sellable assurance product of spec Vol III §2 — "every
certified payment … reconciled against independent evidence." M7's certificates now
generate exactly the assertions this tier must reconcile.

| Workstream | Representative spec functions | Notes |
|---|---|---|
| M6 Ingestion layer (build first — spec Phase 0 is "ingest and prove") | Domain N #705–711 (API export/import, open schemas), #715 (foreign-system record mirroring); hash-at-ingest per S#862 | Procore/Aconex/CSV connectors landing as `evidence` + `assertions` with provenance; this also delivers the **pathway separation** the §4 design rule requires |
| M1 hardening | S#860–861 notarisation & anchoring, #864 trusted time, #873–874 attestation & hash escrow, #871 forensic export format | Publish Merkle roots + chain heads to an external escrow on a schedule |
| M2 detector build-out | Domain A #1–35 (bid-pattern family), #53–71 (ghost vendor/worker, duplicate payment, certification-vs-evidence family), #93–99 (risk scores, red-flag register, false-positive loop) | Ship detectors with measured precision (Vol III §6.2: "ship five that work rather than fifty that fire") |
| M3 methods | Domain A #65–71 quantity/progress/plant/labour reconciliations; X#1017 evidence sufficiency scoring | Method plug-ins beyond mean-variance |
| M4 graph depth | A#9–11 shared bank/address/contact detection, #44 undeclared relationships, #45–50 PEP/sanctions/debarment screening & shell indicators | External registry integrations |
| M5 workspace | A#90–92 full reviewer/auditor/regulator workspaces, #100–101 case files & chain-of-custody, S#882 completeness certification | Case-file assembly over evidence packs |

**Acceptance criteria** (from spec Vol III §5 Phase 0–2 and §7):
1. One real project's records ingested from a third-party system, hashed at ingest, and a
   reconciliation report of certified quantities vs. independent evidence produced end-to-end.
2. A **retrospective detection run** on a completed project with a known integrity outcome,
   reporting precision/recall per detector — the spec's bar for "a plan becomes a company".
3. Every detector ships with a measured precision figure and a reviewer feedback loop
   (`false_positive` dispositions feed detector tuning).
4. Ledger heads/Merkle roots escrowed externally; a truncation attack becomes detectable.

---

## Tier 2 remainder — M11

"A variance is an observation; a variance mapped to a FIDIC sub-clause with a live time bar
is an action" (spec Vol III §5 Phase 3). M7–M10 (delivered above) built the sub-clause,
the live time bar, the forensic method and the statutory clocks; one Tier-2 module
remains.

| Module | Status | Domain / representative functions | Hooks now in place |
|---|---|---|---|
| M7 Measurement & valuation | **Delivered (subset — see Phase 2)** | B#115–192 | — |
| M8 Contract intelligence | **Delivered (subset — see Phase 2)** | C#193–264 | — |
| M9 Delay & disruption forensics | **Delivered (subset — see Phase 3)** | D#265–320 | — |
| M10 Payment security | **Delivered (subset — see Phase 3)** | F#358–393 | — |
| M11 Independent benchmarking | Open | R#821–858: independent rate/productivity benchmarks | BQ rates + `rateBuildUp` components and variation star rates are the raw material; anonymized cross-tenant aggregates over assertions/reconciliations |

---

## Next phase — recommendation

**Recommended: make the spec §7 retrospective detection run the next milestone — a
product deliverable that pulls the Tier-1 workstreams (M6 first) through in its service —
rather than opening Tier 4 or building analytics.**

Reasoning, grounded in the spec's own guidance:

1. **The spec names this as the single highest-value next artefact.** Vol III §7,
   verbatim: *"The single highest-value next artefact is not more specification. It is a
   retrospective detection run: take one completed public project with a known integrity
   outcome, ingest its procurement and payment record, and measure how many of Domain A's
   114 detectors would have fired before the outcome was known."* It is also Tier-1
   acceptance criterion 2 above, and the risk register's answer to procurement-cycle
   length — *"the retrospective detection run is the first engagement deliverable."*
   Treating it as a product milestone (with a willing audit institution or public client)
   rather than a background engineering task is what §6.2's services-led entry means.
2. **Four phases of engines now exist; none of them has independent input.** The
   platform's imbalance after Phase 4 is not missing machinery — it is that certificates
   land as Assertions, and time bars, payment deadlines, lender conditions, gate
   conditions and dispute timetables all land as Obligations (ADR 0012), while everything
   still arrives through ConstructOS's own API. Both Tier-3 acceptance criteria stalled
   on exactly this: the reconciliation-gated drawdown waits on M6 + M3, and bundle
   verification against an escrowed head waits on M1 anchoring. The retrospective run
   forces precisely those three workstreams — M6 ingestion with hash-at-ingest, M2
   detectors with measured precision, M1 escrow for the credibility of the result — in a
   context where each has a customer-visible payoff.
3. **Against opening Tier 4 (M16–M19 safeguards):** the build-order rule for Tiers 3–4
   (Vol III §5 Phase 4) is *"built in the order your first three institutional customers
   contractually require them. Do not speculate."* No such pull exists in-repo, and the
   safeguard modules are at their best when they hold welfare records to the evidentiary
   standard — M17's attendance-vs-access-control reconciliation *is* an ingestion + M3
   use case. Building M16–M19 before M6 would add a fifth tier of registers to the same
   imbalance. Contractual pull overrides this — if a DFI engagement demands M16 or M17,
   that module jumps, per the rule.
4. **Against Analytics/360 reporting (Vol I §6 #731–758):** it is parity surface — the
   cross-tool report builder, dashboards and BI exposure are exactly the Tier-5 territory
   the spec warns against entering early (Vol III §3: *"Do not start here"*), and the
   platform's differentiated reporting story (report on *integrity* — reconciliation
   coverage, obligation breaches, signal dispositions — not just activity) gets
   dramatically stronger once ingestion and reconciliations carry real data. The one
   §6-adjacent artefact worth building early, board-grade governance reporting (G#443),
   should be assembled from the M12 gate/benefit registers when a customer asks for it.
5. **What the milestone looks like concretely:** the Tier-1 table below is the
   engineering content, M6 first; the deliverable is the §7 run — one completed project,
   records ingested from the third-party system with provenance and hashes, detectors
   run retrospectively, precision/recall reported per detector, methodology published
   (spec §7: publish methodology, not findings), ledger heads escrowed so the result is
   itself verifiable. Exit = Tier-1 acceptance criteria 1–4 below.

**Completion criteria carried forward:** evidence-side tracing of certified valuations
(waits on M6+M3); a live-contract time-bar save; a live dispute bundle produced and
verified by a receiving party (the Phase 4 mechanism exists; escrowed-head verification
waits on M1 anchoring); the reconciliation-gated drawdown (waits on M6+M3). The
mechanisms exist — the live runs are deployment milestones, and the retrospective run is
the engagement that creates them.

---

## Tier 3 — Programme & capital governance (M12–M15) — delivered (subset)

*(Delivered as Phase 4, above — the function-by-function boundary, the named exclusions
(G#403, E#340, O#734, O#752–756, H#461–462) and the honest status against this tier's
acceptance criteria are in that section.)*

| Module | Domain / representative functions | Status |
|---|---|---|
| M12 Business case & stage gates | G#394–446 (gateway reviews, benefits tracking, board-grade reporting) | Delivered subset — see Phase 4 |
| M13 Quantitative risk | H#447–490 (Monte Carlo, P-values, contingency drawdown discipline) | Delivered subset — see Phase 4 |
| M14 Disbursement & lender conditionality | O#729–770 (drawdown against verified progress — direct consumer of M3 output) | Delivered subset — see Phase 4 |
| M15 Dispute support | E#321–357 (issue escalation, bundle production from evidence packs) | Delivered subset — see Phase 4 |

**Acceptance criteria:** a drawdown certificate generated only from `supported`
reconciliations (O domain); a dispute bundle exported with chain-of-custody documentation
(E domain + S#872), verifiable by the receiving party against the escrowed chain head.
Status: the first is evidence-gated but not yet reconciliation-gated (M6+M3); the second
is delivered except escrowed-head verification (M1 anchoring) — see the Phase 4 section.

Build order within Tier 4 remains demand-driven per spec Vol III §5 Phase 4: "built in the
order your first three institutional customers contractually require them. Do not speculate."

---

## Tier 4 — Safeguards & sustainability (M16–M19)

| Module | Domain / representative functions |
|---|---|
| M16 Land, resettlement & grievance | J#547–592 |
| M17 Worker welfare & labour rights | M#667–704 (biometric/attendance evidence feeds ghost-worker detection A#54) |
| M18 Carbon, ESG & social value | I#491–546 |
| M19 Multi-jurisdiction operations | K#593–626 (multi-currency, local statutory regimes) |

**Acceptance criteria:** welfare and safeguard records held to the same evidentiary standard
as financial ones — hashed, ledgered, reconciled against independent sources (e.g. M17
attendance vs. access-control logs).

---

## Tier 5 — Parity — deliberately last

Vol I Sections 1–5 remainder (~650 functions): schedule, full financial suite, quality &
safety, resources, meetings, correspondence, specifications, forms. Per spec Vol III §3
Tier 5: *"Do not start here … even then consider acquiring rather than building."* Entered
only when a customer refuses to run two systems. The foundation keeps this option open —
tool keys for budget/commitments/change_management/invoicing/meetings are already reserved in
`packages/shared/src/permissions.ts`, and the record-links/custom-fields/workflow substrate
is tool-agnostic.

---

## Standing risk register (spec Vol III §6, mapped to phases)

| Kill risk | Mitigation in this plan |
|---|---|
| Evidence independence collapses | M6 ingestion is the first Tier-1 workstream and jumps the queue on any assurance-led engagement; `independenceScore` + separation rule already enforced; certification/EOT separation-of-duties added in Phase 2 (`docs/security.md` §2.4); contractual evidence mandates at project setup |
| False-positive fatigue | Precision measured before a detector ships (Tier-1 acceptance #3); reviewer feedback loop live since foundation. Phase 2 added two deterministic detectors (`time_bar_missed`, `time_bar_breach_risk`), Phase 3 two more (`payment_deemed_liability`, `late_payment_response`) and Phase 4 four more (`contingency_exhaustion`, `facility_condition_overdue`, `covenant_breach`, `dispute_deadline_missed`) — all with precision 1.0 by construction: threshold and date arithmetic, not inference |
| Procurement cycle length | Services-led entry: the Tier-1 retrospective detection run *is* the first engagement deliverable |
