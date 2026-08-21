# ConstructOS — Roadmap

Maps the committed codebase onto the master specification
(`docs/master-specification.md`), then lays out the remaining build mirroring the
Volume III module tiers. Function numbers cite the spec: Vol I numbers are the Procore
inventory (#1–804), Vol II numbers run continuously across the gap domains (#1–~1100,
Domain A starting at #1, Domain B at #115, Domain C at #193, Domain S at #859, Domain X
at #995).

Two increments are delivered: **Phase 0/1 — Foundation** (the delivery subset + assurance
skeleton) and **Phase 2 — Tier-2 commercial seed (M7 + M8)**. Phase 2 is a deliberate
deviation from the spec Vol III §5 ordering (assurance core before commercial depth): the
commercial engine landed before the Tier-1 ingestion layer (M6). The deviation is contained
— M7 was built so that every certified value crosses into the assurance layer as an
`Assertion`, so nothing shipped that Tier-1 will have to unwind; but **M6 remains the gate
to the sellable assurance claim** and is called out as such below. The "parity trap"
warning (Vol III §1) is still treated as binding: Volume I parity stays last.

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
| M9–M19 | Not started |

Not implemented at all (deliberately): Vol I §1.1–1.3 (bid/estimating/prequal), §2.2 specs,
§2.6 schedule, §2.9/2.11–2.13, §3 financial suite, §4 quality & safety, §5 resources,
§6 analytics; Vol II domains D–K, M–R, T–Z beyond the seeds listed above (Domains B and C
gained real coverage in Phase 2, below).

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

### Phase-2 status against the old Tier-2 acceptance criteria

1. *"A certified interim valuation traced item-by-item to BQ lines and evidence (B#140)"* —
   **half met**: item-by-item tracing to BQ lines, taking-off sheets and source drawings is
   live; tracing to *independent evidence* waits on M6 ingestion + M3 reconciliation. The
   hook exists: every certificate already lands as a `cost` Assertion (ADR 0008).
2. *"A time-bar warning fired before expiry on a live contract (C#229)"* — **mechanism
   delivered** (deadline radar + `warnDaysBefore` obligations + `/obligations/upcoming`);
   firing it on a *live* contract is a deployment milestone, not an engineering one.
3. *"One delay analysis assembled solely from ledgered contemporaneous records (D domain)"*
   — **not started**; that is M9.

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

## Tier 2 remainder — M9–M11

"A variance is an observation; a variance mapped to a FIDIC sub-clause with a live time bar
is an action" (spec Vol III §5 Phase 3). M7 and M8 (delivered above) built the sub-clause
and the live time bar; the remaining Tier-2 modules build the forensics and the money
protection around them.

| Module | Status | Domain / representative functions | Hooks now in place |
|---|---|---|---|
| M7 Measurement & valuation | **Delivered (subset — see Phase 2)** | B#115–192 | — |
| M8 Contract intelligence | **Delivered (subset — see Phase 2)** | C#193–264 | — |
| M9 Delay & disruption forensics | Open | D#265–320: as-planned vs as-built, window analysis, concurrent delay, contemporaneous records | `contract_events` (kind `delay_event`, cost/time impact estimates, clause refs), `eot_claims.eventIds`, `variations.timeImpactDays`, daily logs, ledger timestamps — the contemporaneous record D-domain analysis feeds on now exists as structured data |
| M10 Payment security | Open | F#358–393: statutory payment regimes (HGCRA/SOP), payment-chain visibility | `payment_certificates` with `dueDate` + variance statements; `contract_events` kinds `payment_notice`/`pay_less_notice`; the clause library already describes payment-clause mechanics it declines to compute (JCT 4.9) — exactly the gap M10 fills with real regime engines |
| M11 Independent benchmarking | Open | R#821–858: independent rate/productivity benchmarks | BQ rates + `rateBuildUp` components and variation star rates are the raw material; anonymized cross-tenant aggregates over assertions/reconciliations |

---

## Next phase — recommendation

**Recommended: complete Tier 2 with M9 (delay & disruption forensics) + M10 (payment
security), with M6 ingestion run in parallel if the next engagement is assurance-led.**

Reasoning, grounded in the spec's own guidance:

1. **M9 and M10 compound what Phase 2 just built.** Delay forensics consumes the contract
   event register, EOT claims and ledgered contemporaneous records M8 now produces; payment
   security consumes the certificates, due dates and payment-notice events M7/M8 now
   produce. Building them next converts existing structured data into the two highest-value
   dispute artifacts (D and F domains) with no new substrate.
2. **Tier 3 stays demand-driven.** Spec Vol III §5 Phase 4 is explicit: Tier-3/4 modules
   are "built in the order your first three institutional customers contractually require
   them. Do not speculate." Absent that contractual pull, starting M12–M15 before Tier 2 is
   complete would be speculation.
3. **The standing caveat: M6 is still the gate.** The spec's sequencing (assurance core
   first) exists because the sellable claim is reconciliation against *independent*
   evidence. Phase 2 kept faith with that by making every certified value an Assertion, but
   until M6 lands there is nothing independent to reconcile it against. If a real
   engagement materializes, M6 + the Tier-1 acceptance criteria jump the queue — that was
   true before Phase 2 and remains true after it.

**Tier-2 completion criteria carried forward:** the delay-analysis criterion (one analysis
assembled solely from ledgered contemporaneous records, exported as an evidence pack) and
the outstanding halves of the Phase-2 criteria above (evidence-side tracing of certified
valuations; a live-contract time-bar save).

---

## Tier 3 — Programme & capital governance (M12–M15)

| Module | Domain / representative functions |
|---|---|
| M12 Business case & stage gates | G#394–446 (gateway reviews, benefits tracking, board-grade reporting) |
| M13 Quantitative risk | H#447–490 (Monte Carlo, P-values, contingency drawdown discipline) |
| M14 Disbursement & lender conditionality | O#729–770 (drawdown against verified progress — direct consumer of M3 output) |
| M15 Dispute support | E#321–357 (issue escalation, bundle production from evidence packs) |

**Acceptance criteria:** a drawdown certificate generated only from `supported`
reconciliations (O domain); a dispute bundle exported with chain-of-custody documentation
(E domain + S#872), verifiable by the receiving party against the escrowed chain head.

Build order within Tiers 3–4 is demand-driven per spec Vol III §5 Phase 4: "built in the
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
| False-positive fatigue | Precision measured before a detector ships (Tier-1 acceptance #3); reviewer feedback loop live since foundation. Phase 2 added two deterministic detectors (`time_bar_missed`, `time_bar_breach_risk`) whose precision is 1.0 by construction — date arithmetic, not inference |
| Procurement cycle length | Services-led entry: the Tier-1 retrospective detection run *is* the first engagement deliverable |
