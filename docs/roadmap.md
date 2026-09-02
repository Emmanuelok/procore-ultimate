# ConstructOS — Roadmap

Maps the committed codebase onto the master specification
(`docs/master-specification.md`), then lays out the remaining build mirroring the
Volume III module tiers. Function numbers cite the spec: Vol I numbers are the Procore
inventory (#1–804), Vol II numbers run continuously across the gap domains (#1–~1100,
Domain A starting at #1, Domain B at #115, Domain C at #193, Domain D at #265,
Domain E at #321, Domain F at #358, Domain G at #394, Domain H at #447, Domain O at
#729, Domain S at #859, Domain X at #995).

Seven increments are delivered: **Phase 0/1 — Foundation** (the delivery subset +
assurance skeleton), **Phase 2 — Tier-2 commercial seed (M7 + M8)**, **Phase 3 —
Tier-2 forensics & payment security (M9 + M10, on a native §2.6 schedule core)**,
**Phase 4 — Tier-3 programme & capital governance (M12–M15)**, **Phase 5 — Tier-4
safeguards & sustainability (M16–M19) plus the Vol I §6 reporting layer**,
**Phase 6 — Tier-1 ingestion + Tier-2 benchmarking (M6 + M11)**, and **Phase 7 — M1
ledger anchoring & escrow, Domain P insurance & bonding, Domain W organisational learning,
and the Vol I §0.7 integration surface**.
Phases 2–5 were a deliberate deviation from the spec Vol III §5 ordering (assurance core
before commercial depth): the commercial/forensic/governance/safeguard engines landed
before the Tier-1 ingestion layer (M6). The deviation was contained — M7 was built so that
every certified value crosses into the assurance layer as an `Assertion`; M9/M10
materialize their deadlines and breaches into the same `obligations`/`signals` tables;
Phase 4 extended the identical pattern to lender conditions, gate conditions and dispute
timetables (ADR 0012); and Phase 5 extended it again to grievance SLAs, labour
corrective-action plans and permit determinations, while M17 built the platform's first
genuine **two-stream reconciliation** (ADR 0014) — so nothing shipped that Tier-1 had
to unwind. Phase 6 then built M6 itself, and Phase 7 built M1 — the anchoring and escrow
half of the assurance core that every earlier phase deferred. **The gate to the sellable
assurance claim is now entered, not passed**: the machinery for records to arrive hashed,
staged and through a pathway the claimant's users do not share exists in code; the chain
those records land on is now sealed against truncation and wholesale rewrite, and the
connector transports are finished. What is still missing is not machinery — it is a real
third-party feed actually connected, a signing key held outside the operator's hands, and a
timestamp authority — and each is named plainly below. The "parity trap" warning (Vol III §1)
is still treated as binding: Volume I parity stays last, with the two §0.7 exceptions Phase 7
took deliberately (webhooks and OAuth2, because both fell out of the ledger and the RBAC model
the platform already had).

---

## Status at the end of Phase 7

**Every module in the Vol III module map has shipped code, and the assurance core's last
structural gap is closed.** Nineteen modules (M1–M19) plus the Vol I §6 reporting layer;
Phase 6 landed the final two module-map entries (M6 ingestion, M11 benchmarking) and
**Phase 7 built the half of M1 that had been deferred through six phases** — sealing,
anchoring and third-party escrow — alongside two Vol II gap domains (P insurance & bonding,
W organisational learning) and the Vol I §0.7 event and machine-caller surface. Concretely,
on `main`:

| | |
|---|---|
| API modules | **33** Fastify plugins (`apps/api/src/modules/*/index.ts`) registered under `/api/v1` — none of them stubs |
| Tables | **153** across 29 domain schema files (`packages/db/src/schema/`), migrations `0000`–`0007` |
| Permission-scoped tools | **40** in `packages/shared/src/permissions.ts` |
| Tests | **870** passing — 827 API integration/unit tests across 46 files on in-memory PGlite + 43 ledger unit tests across 2 files (`pnpm test`) |
| Detection harness | `eval:retrodetect` unchanged at **17/17 recall, 100% precision** on the synthetic scope |
| Web workspaces | one page per tool under `apps/web/src/pages/` |
| Docs | architecture, data model, roadmap, security, deployment, retrospective-detection run, **18 ADRs** |

What has landed, by spec volume:

- **Vol III Tier 2** (commercial depth): M7 measurement & valuation, M8 contract
  intelligence, M9 delay & disruption forensics, M10 payment security — delivered as
  documented subsets (Phases 2–3). M11 benchmarking landed in Phase 6: the machinery
  (metric registry, auditable snapshots, contribute-to-access distributions with min-n
  suppression) is real and tested, and the caveat that used to keep it un-started now
  travels with it instead — until multiple tenants contribute, the only distributions on
  offer are seed data labelled illustrative on every response that includes them.
- **Vol III Tier 3** (programme & capital governance): M12 business case & stage gates,
  M13 quantitative risk, M14 disbursement & lender conditionality, M15 dispute support —
  delivered as documented subsets (Phase 4).
- **Vol III Tier 4** (safeguards & sustainability): M16 land/resettlement/community, M17
  workforce rights & welfare, M18 carbon/ESG/social value, M19 multi-jurisdiction
  operations — delivered as documented subsets (Phase 5, below).
- **Vol I §6.1–6.2** (360 reporting and dashboards): the whitelisted report builder,
  saved definitions, CSV export, role dashboards and recorded-but-not-dispatched
  schedules — delivered (Phase 5). §6.3 insights & benchmarking is M11 territory — its
  cross-project distribution half landed in Phase 6; per-metric insights depth has not.
- **Vol III §7** (the retrospective detection run): the *harness* exists —
  `apps/api/src/scripts/retrodetect.ts` plants known schemes through the public API into a
  seeded project, runs the shipped detectors, and reports precision and recall against a
  clean control project (`pnpm --filter @constructos/api eval:retrodetect`; methodology in
  `docs/retrospective-detection.md`). What it measures is a **synthetic** scope: the
  spec's actual artefact needs one completed real project with a known integrity outcome
  and third-party records — which requires a willing institution, and since Phase 6 no
  longer waits on missing machinery: the ingestion pathway to receive those third-party
  records exists (`docs/adr/0015-staged-commit-ingestion.md`).
- **Vol II gap domains**: **Domain P insurance & bonding** and **Domain W organisational
  learning** landed in Phase 7 as documented subsets, both built on primitives that already
  existed (notification periods and mandatory-capture triggers are Obligations; a lapsed
  certificate is a Signal) — which is most of why they were cheap. Both left the "still
  absent" table below.
- **Vol I §0.7** (integration & extensibility): webhooks (#121) and OAuth2 for machine
  callers (#120) delivered in Phase 7, plus the Procore/Aconex transports completed. The
  rest of §0.7 — developer sandbox, marketplace, MCP exposure, embedded experiences, the ERP
  connector framework and P6/Bluebeam/Autodesk exchange — is still absent and still last.
- **Vol III Tier 1** (the assurance core, M1–M5): **M6 built in Phase 6, M1 built in Phase
  7.** The ledger, the eight primitives, the entity graph and the three assurance roles are
  as before, but the chain is no longer self-attesting — seals commit to `entryCount` and a
  Merkle root over every entry hash, signed with a key the database does not hold, so tail
  truncation and wholesale rewrite are detected rather than merely deplored (ADR 0017). The
  detector set has grown from six to **forty-three distinct signal detectors** — the six
  statistical/pattern detectors in `modules/assurance/detectors.ts` plus deterministic
  threshold-and-date detectors embedded across the domain modules (Phase 5 alone added
  sixteen: `land_blocks_programme`, `grievance_sla_breach`, `ghost_worker`,
  `payroll_overclaim`, `wage_underpayment`, `underage_worker_blocked`,
  `labour_rights_indicator`, `accommodation_overcrowding`, `welfare_standard_failure`,
  `labour_cap_overdue`, plus the ESG/jurisdiction family
  `carbon_budget_exceeded`, `social_value_shortfall`, `permit_determination_overdue`,
  `permit_expired`, `permit_blocks_programme`, `local_content_shortfall`; Phase 6 added
  `ingestion_duplicate_replay` and `benchmark_outlier`; Phase 7 added nine — the five
  insurance detectors `insurance_certificate_expired`, `insurance_cover_gap`,
  `bond_demand_deadline_passed`, `policy_lapsed_during_works`,
  `insurance_notification_missed`, and the four critical chain verdicts
  `ledger_truncation_detected`, `ledger_entry_altered`, `chain_seal_broken`,
  `chain_seal_forged`). M2–M5 remain as they were.

The honest headline: **the record is now sealed, and the platform still has more machinery
than input.** Phase 6 built the pathway ADR 0014 was waiting for; Phase 7 made the chain
those records land on defensible to a third party, and finished the connectors so "the code
is not the blocker" is a demonstrated fact rather than an assertion. Neither changes what any
deployment *is*: no real third-party feed is connected, the connectors have never spoken to a
live vendor, and outside production the signing key is derived from `AUTH_SECRET` and is
therefore held by the same operator whose record is under scrutiny — which proves integrity
against a database-only attacker and **not** against the operator (`docs/security.md` §8.2
gap 2). Connecting one real feed, and moving the key out of the operator's hands, are the
arguments for what comes next.

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
| M1 Evidence Ledger | **Core shipped in the foundation** — chain, canonical JSON, Merkle packs, verify route; **anchoring, sealing and escrow delivered in Phase 7** (ADR 0017). Still missing: a signing key held outside the operator and a configured timestamp authority (`docs/security.md` §8.2 gaps 2–3) |
| M2 Integrity Signal Engine | **Seeded** — 6 of Domain A's 114 detectors, run-on-demand, ledgered signals, reviewer disposition loop |
| M3 Reconciliation Engine | **Seeded** — assertion/evidence/reconciliation CRUD, automatic variance scoring (±5%/±15% thresholds), independence rule enforced |
| M4 Entity Graph | **Seeded** — entities, typed relationships, graph walk, shared-identifier scan (`POST /entities/scan`), vendor→entity mirror |
| M5 Assurance Workspace | **Seeded** — the three roles wired through auth; assurance pages in the web app; time-boxed regulator grants |
| M6 Ingestion Layer | **Delivered (Phase 6, subset)** — staged CSV migration with hash-at-ingest, the code-resident dataset registry, ledgered commits with per-row provenance, dataset-scoped machine tokens + the push inlet (ADR 0014 pathway separation), duplicate-replay signal, OCDS export. The Procore/Aconex transports were completed in Phase 7 but have never spoken to a live vendor, and an unconfigured pull still returns 501; see the Phase 6 and Phase 7 sections |
| M7 Measurement & valuation | **Delivered (Phase 2, subset)** — BoQ/taking-off/valuation/certification/variations; see the Phase 2 section for the exact function-number in/out list |
| M8 Contract intelligence | **Delivered (Phase 2, subset)** — clause library in code, PC overlay, time-bar engine, EOT, LD exposure, obligation register; see Phase 2 section |
| M9 Delay & disruption forensics | **Delivered (Phase 3, subset)** — delay events, fragnet TIA, as-planned vs as-built, scoped windows attribution, prolongation seed, claims chain + chronology; see Phase 3 section |
| M10 Payment security | **Delivered (Phase 3, subset)** — five statutory regimes in code, deadline engine, deemed-liability sweep, suspension, interest; see Phase 3 section |
| M11 Independent benchmarking | **Delivered (Phase 6, subset)** — metric registry, auditable snapshots, contribute-to-access distributions with min-n suppression and disclosed n, anonymization boundary, outlier signals. Seed data is labelled illustrative; genuine benchmarks still require contributing tenants; see the Phase 6 section |
| M12 Business case & stage gates | **Delivered (Phase 4, subset)** — five-case model, CBA to NPV/BCR, stage gates + decision register, conditions as obligations, benefits register; see Phase 4 section |
| M13 Quantitative risk | **Delivered (Phase 4, subset)** — seeded QCRA/QSRA Monte Carlo, reproducibility endpoint, contingency drawdown discipline; see Phase 4 section |
| M14 Disbursement & conditionality | **Delivered (Phase 4, subset)** — facility register, CP gate on submission, evidence-backed satisfaction, covenant signals; see Phase 4 section |
| M15 Dispute support | **Delivered (Phase 4, subset)** — dispute register + timetable obligations, pleadings, Merkle-manifest bundles + verify, settlement modelling; see Phase 4 section |
| M16 Land, resettlement & community | **Delivered (Phase 5, subset)** — parcel register with customary/communal tenure, evidenced compensation, PAP census with cut-off enforcement, GRM with SLA obligations and complainant-verified closure, consent-to-programme risk; see Phase 5 section |
| M17 Workforce rights & welfare | **Delivered (Phase 5, subset)** — verified worker register, **ghost-worker reconciliation of payroll against independent site access**, ILO risk indicators, subcontractor modern-slavery scoring, welfare inspections, audits with CAP obligations; see Phase 5 section |
| M18 Carbon, ESG & social value | **Delivered (Phase 5, subset)** — EN 15978 modules, factor library with product-specific flagging, carbon off the BoQ, budgets with drawdown, waste diversion, social value tender-vs-delivered; see Phase 5 section |
| M19 Multi-jurisdiction operations | **Delivered (Phase 5, subset)** — FIDIC 14.15 currency portions and FX variance, rate provenance, permits blocking the programme, local content/ICV; see Phase 5 section |
| *(Vol I §6 reporting layer — not a Vol III module)* | **Delivered (Phase 5, subset)** — whitelisted report builder, saved definitions, CSV export, role dashboards, recorded schedules; see Phase 5 section and ADR 0013 |

Not implemented at all (deliberately): Vol I §1.1–1.3 (bid/estimating/prequal), §2.2 specs,
§2.9/2.11–2.13, §3 financial suite, §4 quality & safety, §5 resources; Vol II domains
Q, T, U, V, Z beyond the seeds listed above (Domains B and C gained real coverage in Phase 2,
Domains D and F plus the §2.6 schedule core in Phase 3, Domains E, G, H and O in Phase 4,
Domains I, J, K and M plus Vol I §6.1–6.2 in Phase 5, Domains N and R plus §6.3's
cross-project distribution half in Phase 6, and Domains P and W plus Vol I §0.7's webhook and
OAuth2 half in Phase 7).

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
   live; tracing to *independent evidence* waits on M3 reconciliation methods over a real
   ingested feed (the M6 machinery landed in Phase 6). The hook exists: every certificate
   already lands as a `cost` Assertion (ADR 0008), and `cost_assertions` is an ingestion
   dataset.
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
   gated drawdown waits on M3 methods producing reconciliations worth gating on, fed by a
   real ingested stream (the M6 machinery landed in Phase 6). The hook is in place:
   condition satisfaction already points at `evidence` rows, and the disbursement carries
   its verification snapshot.
2. *"A dispute bundle exported with chain-of-custody documentation (E domain + S#872),
   verifiable by the receiving party against the escrowed chain head"* — **mechanism
   delivered except escrow**: the frozen manifest (tabs, content hashes, Merkle root),
   the CSV export and the `/verify` recomputation exist and are ledgered; verification
   *against an escrowed chain head* waits on external anchoring — still open gap #2 in
   `docs/security.md` §8.2.

---

## Phase 5 — Delivered: Tier 4 safeguards (M16–M19) + the Vol I §6 reporting layer

Committed and tested: `apps/api/src/modules/{land,workforce,esg,jurisdiction,analytics}/`
with colocated suites (**153 tests**), schema
`packages/db/src/schema/{land,workforce,esg,jurisdiction,analytics}.ts` (25 tables), web
workspaces `apps/web/src/pages/{land,workforce,esg,jurisdiction,analytics}/`. Architecture
write-ups in `docs/architecture.md` §19–23; table catalogs in `docs/data-model.md` §21–25;
new controls in `docs/security.md` §2.4; ADRs 0013 (whitelisted report builder) and 0014
(independent evidence streams).

This is the tier the spec sequences by contractual pull — *"built in the order your first
three institutional customers contractually require them. Do not speculate."* (Vol III §5
Phase 4). Building all four together is a deviation from that rule, taken deliberately to
close the module map; the consequence is that each module is a **breadth-first subset** of
its domain, drawn function-by-function below rather than a deep implementation of any one.

### M16 — Land, resettlement & community (Domain J)

**In:** #547–551 parcel register with tenure including customary, communal and informal,
encumbrances, and a transition-guarded acquisition flow; #553–554 valuation and
compensation where **`compensated` is reachable only through an evidenced route** that
demands validated assurance `evidence` ids; #555–557 PAP census with household baseline
and vulnerability screening; #558 (reporting half) `land/rap-progress` — the supervision
view a lender's E&S mission asks for; #561 livelihood programme fields; #564 cut-off-date
declaration (a `land` **admin** act) with census-after-cut-off refused as encroachment;
#565 physical/economic displacement classification; #566 entitlement matrix with a
server-recomputed total; #569–574 the full GRM — multi-channel intake including genuinely
anonymous (identity **stripped at intake**), severity-driven SLA materialized as an
assurance Obligation, a lazy breach sweep raising `grievance_sla_breach`, closure verified
*with* the complainant (a rejection reopens the grievance), and analytics by type,
location, severity and time; #575 FPIC consent status on engagements; #579–584 stakeholder
register with influence/interest quadrants and the consultation log with feedback
disposition; #591 consent-to-programme dependency mapping with the
`land_blocks_programme` signal.

**Out (explicitly not built):** #552 compulsory purchase / eminent domain process
management; #558's RAP document lifecycle and #568 independent monitoring and completion
audit as workflow; #559–560 IFC PS5 / ESS5 as separately tracked compliance frames (they
are the design frame, not a checklist object); #562–563 replacement housing and
resettlement-site development monitoring; #567 compensation-at-replacement-cost
verification; #576–578 indigenous peoples plans, cultural heritage chance-find and
archaeological stop-work protocols; #592 regulator correspondence register. Permits
(#585–590) are implemented in M19 because they share the permit/consent clock.

### M17 — Workforce rights & welfare (Domain M)

**In:** #667–668 verified worker register with identity and biometric-enrolment flags (never
document images); #669 **ghost-worker elimination** — the module's flagship and the
platform's first two-stream reconciliation (ADR 0014): employer payroll claims against an
independent site-access stream, classifying `ghost` / `overclaim` / `underpaid` / `ok` with
value-at-risk and wage shortfall quantified, raising `ghost_worker` (critical),
`payroll_overclaim` and `wage_underpayment` (high) signals idempotently, with a read-only
replay endpoint that writes nothing; #670 age verification as a **blocked write** that
still raises `underage_worker_blocked`; #671–675 recruitment-fee, passport-retention,
contract-substitution and related indicators with severity derived from the indicator
rather than the reporter; #676 WPS reference capture; #677 wage-versus-hours verification
against the agreed daily rate; #683–688 welfare inspection scoring across eight areas with
occupancy-density compliance and corrective actions; #694 modern-slavery composite scoring
at subcontractor level with every component returned; #697–699 the audit programme with
unannounced scheduling and **corrective-action plans tracked as assurance obligations**.

**Out (explicitly not built):** #678–682 minimum wage by jurisdiction, overtime limits, rest
day / maximum consecutive days, deduction-legality checking and late-payment escalation —
each needs a per-jurisdiction rule library of the kind M8/M10 built for clauses and
statutes, and none is modelled; #689–693 the **employer-independent** worker grievance
channel, anonymous multilingual worker voice, retaliation monitoring, freedom-of-association
recording and migrant vulnerability screening (the community GRM in M16 is not a substitute
— an employer-independent worker channel needs its own identity path, and building it
inside the employer's tenant would defeat it); #695–696 ILO core convention and IFC PS2
compliance mapping as tracked frames; #700 lender welfare KPI reporting; #701–702
independent fatality reporting and statistical under-reporting detection; #703–704
demographic, turnover and skills-pathway analytics.

### M18 — Carbon, ESG & social value (Domain I)

**In:** #491–492 embodied carbon to the EN 15978 life-cycle module split; #494–495 carbon
budgets by element with drawdown bands and a `carbon_budget_exceeded` signal; #496 factor
library (ICE-derived seed set); #498 product-specific versus generic flagging surfaced as
**`productSpecificSharePercent`** — a data-quality measure of the assessment itself, not a
compliance number; #501 carbon riding the BoQ (bulk generation from bill items with the
`boqItemId` as provenance, unit checking, and unconvertible items **skipped and reported**);
#505–508 GHG-Protocol scope reporting alongside the life-cycle split; #513–514 waste by
stream and destination with diversion-from-landfill and the narrower recycled share;
#527–528 UK Social Value Model / TOMs commitments; #538 proxy financial valuation;
#539–540 the tender-commitment-versus-delivered reconciliation with a
`social_value_shortfall` signal after a 30-day grace period.

**Out (explicitly not built):** #493 PAS 2080 as a tracked frame; #497 EPD *ingestion and
verification* as a pipeline (the reference field exists; parsing and verifying EPD
documents does not); #499–500 design-option carbon comparison and marginal abatement cost;
#502–504 transport carbon from supplier location and mode, site energy and fuel capture,
plant emissions by equipment hours (the last of these is a telematics use case — ADR 0014);
#509–511 SBTi tracking, offset register, operational carbon handover; #512 water; #515–516
material passports and reuse tracking; #517–526 biodiversity net gain, habitat compliance,
noise/dust/vibration and air-quality monitoring integration, environmental incidents and
regulator notification, environmental permits (M19 holds the generic permit register),
EMP compliance, ISO 14001 evidence assembly and BREEAM/LEED/Green Star/Estidama credit
tracking; #529–537 the individual social-value measure families (local employment,
apprenticeship weeks, local spend by radius, SME/VCSE spend, indigenous participation,
diverse supplier spend, community investment, volunteering) beyond the generic
commitment/delivery model; #541–546 CSRD/ESRS, IFRS S1/S2, EU Taxonomy, TCFD, Modern
Slavery Act statement evidence and CSDDD supply-chain due diligence.

### M19 — Multi-currency & multi-jurisdiction operation (Domain K)

**In:** #593–595 multi-currency contracts with defined currency proportions and a
base-date rate per FIDIC Sub-Clause 14.15, validated to exhaust the payment; #596 payment
splitting across the portions; #597 exchange-rate source configuration with a dated,
attributed, immutable rate register and an explicit
`identity → direct → inverse → triangulated` resolution ladder that reports the path and
the governing quote date; #599 unrealised FX gain/loss against the contractual rates, with
unquoted currencies named rather than dropped; #585–590 permit and consent register with
authority, statutory determination period, grant conditions and expiry, plus two sweeps
(`permit_determination_overdue`, `permit_expired`); #591 permits blocking the programme
(`permit_blocks_programme`); #608 and #614 as permit kinds (customs clearance, work
permits and visas); #612–615 local content / ICV targets with dated readings and a
`local_content_shortfall` signal.

**Out (explicitly not built):** #598's dispute *handling* workflow (the audit trail that
wins one is built; the process is not); #600–601 hedging instrument register and
effectiveness, currency control and repatriation restrictions; #602–607 multi-entity
consolidation with FX translation, functional versus presentation currency,
inflation-adjusted and IAS 29 hyperinflationary reporting, country charts of accounts and
multi-jurisdiction statutory reporting — this family belongs with a general ledger the
platform does not have; #609–611 customs bonds and temporary import, port-clearance delay
logging with claim linkage, border and logistics delay attribution; #616–626 the whole
emerging-market client stack (offline-first architecture, SMS/USSD capture, feature-phone
support, low-bandwidth delta sync, intermittent-power tolerance, paper-to-digital OCR,
non-Latin and RTL languages, regional formats, metric/imperial dual display, local holiday
calendars, regional data residency). That last family is an **application-shell
programme**, not a module: it touches the SPA, the API and the deployment topology, and it
is sequenced separately below.

### Vol I §6 — 360 reporting & Analytics 2.0

**In:** #731–733 cross-tool report builder with column selection, filters and grouping over
a registry of twelve datasets spanning delivery, commercial, forensic, financial and
safeguard tables; #735 pre-built definitions (seeded with the role dashboards); #736 report
scheduling — **recorded, not dispatched**, and every response says so; #737 sharing and
permissions; #738 paged execution with honest truncation and CSV export; #739 project- and
company-level scope; #741–742 pre-built role dashboards (PM / commercial / assurance) and
custom dashboards; #749 drill-through identifiers on widget rows; #751 row-level security
enforced by the executor from request context, never by the stored definition.

**Out (explicitly not built):** #734 calculated columns — an arbitrary user expression is
user-authored SQL by another name, and the shape that would preserve the ADR 0013
invariant (a registry of *named* derived columns) is described there; #738's PDF and Excel
targets (CSV only); #740 inactive-project tracking; #743 direct BI-tool connection (the
REST surface and the dataset catalog are the only exposure); #744–748 portfolio
aggregation, cross-project trend analysis and the whole predictive-field family (predicted
spend, predicted schedule risk) — the platform has the Monte Carlo engine for the honest
version of this and should not ship a regression dressed as a prediction; #750 historical
comparison; #752 scheduled data refresh (nothing is materialized — every run is live); all
of §6.3 (#753–758) insights and benchmarking, which is M11.

### Phase-5 status against the Tier 4 acceptance criterion

*"Welfare and safeguard records held to the same evidentiary standard as financial ones —
hashed, ledgered, reconciled against independent sources (e.g. M17 attendance vs.
access-control logs)."*

- **Ledgered: met.** Every consequential mutation across all four modules appends to the
  company's hash chain, with full payloads on the records an auditor comes back for
  (compensation payments, closure verifications, reconciliation runs, carbon entries,
  permit determinations).
- **Reconciled against independent sources: mechanism met, independence not yet
  guaranteed.** M17 implements exactly the reconciliation the criterion names, as two
  separate tables with two separate write routes and a pure engine over both (ADR 0014).
  What the platform could not guarantee at the end of Phase 5 was that the access stream
  *arrives through a different channel from the payroll* — both posted through the same
  API with the same token. *(Phase 6 note: that channel now exists —
  `POST /ingestion/push/site_access` with a dataset-scoped machine token is a pathway no
  user session shares, and pushed rows land in `site_access_records` with run-level token
  provenance. Who holds the token is the remaining assumption — see the Phase 6 section
  and `docs/security.md` §8.2 gap 17.)*
- **Hashed: partially met.** File-backed safeguard evidence inherits content-addressed
  storage and `evidence.contentHash` (`docs/security.md` §4). Bulk-ingested access and
  payroll rows are ledgered but are not themselves hashed-at-ingest artefacts. *(Phase 6
  note: rows migrated through an M6 file run now are — the raw upload is retained
  content-addressed and its sha256 travels with the run and its ledger entries. Rows
  arriving through the workforce module's own bulk routes, or through a token push — which
  has no file — remain ledgered-with-counts rather than file-hashed.)*

---

## Phase 6 — Delivered: Tier-1 ingestion + Tier-2 benchmarking (M6 + M11)

Committed and tested: `apps/api/src/modules/{ingestion,benchmarks}/` with colocated
suites (**52 tests**), schema `packages/db/src/schema/{ingestion,benchmarks}.ts`
(6 tables), web workspaces `apps/web/src/pages/{ingestion,benchmarks}/`. Architecture
write-ups in `docs/architecture.md` §24–25; table catalogs in `docs/data-model.md`
§26–27; the token model in `docs/security.md` §1.5; ADRs 0015 (staged-commit ingestion)
and 0016 (benchmark anonymization boundary).

These are the two modules every earlier phase named as not started, and they were held
back for opposite reasons: M6 because it changes what the product *is* (the difference
between an evidentiary product and a system of record), M11 because it cannot honestly
exist without data from more than one tenant. Phase 6 built both as machinery and kept
the second constraint visible in the output rather than pretending it away.

### M6 — Data ingestion & migration (Domain N #705–711, #715; S#862; A#109)

**In:** the staged-commit pipeline — CSV upload retained content-addressed with its
sha256 **hashed at ingest** (S#862, ingest half) → column mapping against a code-resident
dataset registry (`modules/ingestion/datasets.ts`; 8 datasets: vendors, cost_assertions,
site_access, payroll, rfis, schedule_tasks, evidence, fx_rates — a field not in the
registry cannot be mapped, staged or committed) → validation with typed coercion,
cross-field checks and per-row rejection reasons → an explicit, ledgered commit that
writes real records and per-row provenance in one transaction, forward-linking every
staged row to the record it created (`committedRecordId`) and back-linking assertions and
evidence to the run (`sourceType/sourceId`); rejected rows stay behind as the honest
record of what the file contained. Re-presented `externalId`s are rejected *and* raise an
`ingestion_duplicate_replay` signal — a replayed batch is a finding, not just an error.
**Machine tokens** (`cok_` + 40 hex, stored only as SHA-256 + display prefix, shown once)
scoped to named datasets drive `POST /ingestion/push/:dataset` — the ADR 0014 inlet: no
JWT, no user session, run `startedBy` is the token id and the ledger entry's `actorId` is
null with the token identified in the payload. Out-of-scope pushes are 403; revocation is
immediate. Site-access and payroll pushes resolve `workerReference` against the project's
worker register and **skip** (with a per-row reason) rather than invent workers. Plus an
OCDS 1.1 export (A#109) whose `x_scopeNote` states exactly which sections are absent and
why. All of it ledgered; verified live end-to-end (hash match, counts, chain intact).

**Out (explicitly not built, stated in the product):** the Procore/Aconex **connector
transports**. `modules/ingestion/connectors.ts` is honest scaffolding — an injectable
HTTP client, the vendors' documented request paths, and pure fixture-tested mapping
functions into the ingestion datasets — but this deployment has no network route to
either vendor and holds no credentials, so `POST /ingestion/sources/:id/pull` returns
**501** with the exact credential and config requirements rather than pretending.
*(**Superseded by Phase 7**, which completed both transports — token exchange, page-walking,
termination and mapping. They remain fixture-proven rather than vendor-proven, and an
unconfigured pull still returns the same honest 501; see the Phase 7 section.)*
Also out: Domain N's open-schema import/export family beyond OCDS, scheduled/incremental
pulls, per-row trusted-source attestation (what arrived is attributable to a token, not
yet to an attested device), and any write path for credentials — source `config` refuses
credential-shaped keys outright.

### M11 — Independent benchmarking (Domain R #821–858 subset; Vol I §6.3 half)

**In:** a code-resident registry of **7 metrics** (cost per GFA m², cost growth, schedule
growth, median RFI response days, variation rate, punch open rate, median payment cycle
days) computed from the project's own records with the exact inputs persisted for audit —
or a **422 that names every missing input** rather than a fabricated zero; project metric
snapshots frozen at computation time; **contribute-to-access** (#855): a company sees a
metric's contributed distribution only after contributing a snapshot to it (an
admin-of-the-tool act — the value leaves the tenant's walls, anonymized, forever);
distributions with **min-n suppression** (fewer than 5 contributed samples in a cell:
statistics withheld, n still disclosed — #831 is unconditional); the **anonymization
boundary**: contributor company/project ids are stored only to enforce
contribute-to-access and min-n counting, and no read path selects them; percentile
comparison with an adverse-tail `benchmark_outlier` signal; every seed-backed response
carries `healthWarning: "Illustrative seed distribution — not derived from real project
data"` verbatim.

**Out (explicitly not built):** the rate/productivity benchmark family the domain
ultimately wants (#821 onward — BQ rates, `rateBuildUp` components and star rates are
still raw material, not benchmarks); a write path for `projects.settings.gfaM2`, which
makes `cost_per_gfa_m2` uncomputable through the API alone today — the 422 names the
missing input, and making project settings writable is a projects-module design decision
deliberately not taken from inside M11; any claim of independence for the seed data (it is
hand-authored, deterministic, and labelled); k-anonymity beyond the min-n floor —
suppression at n < 5 protects contributors from casual inference, not from a determined
differential attack, and region/asset class are self-declared (ADR 0016 states the
boundary and its limits); external/third-party benchmark import. The spec's own
constraint stands: *"the benchmark must be independent of the benchmarked"* — with one
tenant contributing, a distribution is a mirror, and the module says so by suppressing
it. Genuine benchmarks are sequenced behind customers, exactly as before; what changed is
that their arrival no longer requires new code.

### Phase-6 status against the Tier 1 acceptance criteria

Phase 6 moves criterion 1 (*"one real project's records ingested from a third-party
system, hashed at ingest, and a reconciliation report … produced end-to-end"*) from
**blocked** to **waiting on a counterparty**: every mechanical step — third-party-shaped
intake, hash-at-ingest, staged commit, reconciliation — now exists and is tested, and
what is missing is a real external system on the other end of the wire. Criteria 2–3
(retrospective run on real data, measured detector precision) were unchanged; criterion 4
(escrowed chain heads) was **met in Phase 7** — see below.

---

## Phase 7 — Delivered: M1 anchoring & escrow, Domain P, Domain W, Vol I §0.7

Committed and tested: `apps/api/src/modules/{anchoring,insurance,learning,integrations}/`
with colocated suites, the pure sealing core `packages/ledger/src/seal.ts`, schema
`packages/db/src/schema/{anchoring,insurance,learning,integrations}.ts` (17 tables), the
webhook emit hook in `apps/api/src/lib/ledger.ts`, machine-caller resolution in
`apps/api/src/plugins/auth.ts`, the timestamp helpers `apps/api/src/lib/time.ts`, the
standalone receipt verifier `apps/api/src/scripts/verify-receipt.ts`, and web workspaces
`apps/web/src/pages/{ledger,insurance,learning,integrations}/`. Architecture write-ups in
`docs/architecture.md` §26–28 and §30; table catalogs in `docs/data-model.md` §28–31; the
custody and egress gaps in `docs/security.md` §8.2 gaps 2–3 and 22–23; ADRs 0017 (ledger
anchoring and escrow) and 0018 (integration surface).

Four modules, chosen for one reason each. **M1** because it was the second of the two
structural holes named on this page, and the only one closable by code alone — the first
needs a counterparty, not a commit. **Domain P** and **Domain W** because both sit on
primitives that already existed (Obligations, Signals, the ledgered corpus), which is why two
gap domains cost one phase. **§0.7** because the two pieces worth building fell out of assets
the platform already had — the ledger already enumerated every event worth emitting, and the
RBAC model already knew how to answer "may this actor do this?"

### M1 — Ledger anchoring, sealing & escrow (Domain S #860–861, #864, #873–874)

**In:** chain **seals** — a signed commitment to `entryCount` (the truncation tripwire), a
Merkle root over every entry hash, the head hash, the sealed range and `prevSealHash`, so
seals form their own chain and removing one is as visible as editing an entry. Ed25519,
signed over a canonical body reproducible years later with `openssl pkeyutl -verify`, with
the **private half in `ANCHOR_SIGNING_KEY` and never in the database** — `signing_keys` holds
public halves only, asserted on every write. `classifyChain` returns one of six verdicts
(`intact`, `tail_truncated`, `entry_altered`, `seal_forged`, `seal_broken`, `no_seals`) and
**names the failing seal or entry sequence**, distinguishing a sealed prefix that was cut and
refilled from one rewritten in place. **Heartbeat seals** (`ANCHOR_HEARTBEAT_HOURS`, default
24, swept lazily) bound the window in which a truncation can hide to one interval.
**Escrow receipts** are self-contained — seal body, signature, public key, fingerprint,
procedure in words and explicit `proves` / `doesNotProve` lists — issued to a named
counterparty, presentable back at `POST /ledger/escrow/verify` (ledgered) or verifiable with
**no access to this platform at all** via `pnpm --filter @constructos/api verify:receipt`.
Four anchor providers (`local_signed`, `rfc3161`, `opentimestamps`, `counterparty`), the two
network ones carrying real wire implementations behind an injected client. Four critical
detectors on the verdicts. Tested **against real corrupted database state, not mocks**:
truncating the tail, altering a historical entry, forging a signature and removing a middle
seal each produce their specific verdict with the offending sequence named.

**Out, and stated on the API responses rather than only here:**

- **Key custody is the guarantee's ceiling.** Outside production with `ANCHOR_SIGNING_KEY`
  unset, the key is HKDF-derived from `AUTH_SECRET` and is therefore **held by the same
  operator that runs the application**: it proves integrity against a database-only attacker
  and **not against the operator**, who can re-derive it and re-sign a rewritten chain. Every
  key record, seal, verdict, anchor proof and receipt carries `derivedFromAuthSecret: true`
  with a plain-English note, key ids are prefixed `ankd_` so a seal made months ago still
  reports the custody that applied when it was made, and production refuses to seal without a
  real key. Moving the key out of the operator's hands is deployment work, not code
  (`docs/security.md` §8.2 gap 2).
- **Time is still self-asserted.** `sealedAt` is the app-server clock, so **seals prove order,
  not wall-clock time.** The RFC 3161 and OpenTimestamps providers are real implementations,
  but with no `ANCHOR_TSA_URL` / `ANCHOR_OTS_CALENDAR_URL` configured they record
  `unavailable` naming the exact missing variable **rather than fabricating a proof**, and a
  successful OpenTimestamps submission records `pending` — a calendar receipt is not a Bitcoin
  attestation. Gap 3 is narrowed, not closed: what remains is configuration and a network
  route.
- **A seal covers integrity, not accuracy** — nothing here says a record was true when
  written; that is the reconciliation engine's job. And **a receipt carrying its own key proves
  internal consistency only**, which is why verification reports `signatureValid` separately
  from `key.recognized`.
- Not built: automated scheduled anchoring against a paid TSA, cross-tenant or platform-level
  seal publication, and S#871's forensic export format beyond the existing ledger export and
  bundle manifest.

### Domain P — Insurance & bonding (#771–797 subset)

**In:** the insurance programme register (CAR/EAR, TPL, PI, employer's liability, marine
cargo, DSU and the rest of `POLICY_TYPES`) with limit **basis** recorded rather than assumed
(per occurrence vs in the aggregate), conditions precedent captured as structured clauses, and
`requiredByClause` tying cover to the contract that demands it; **certificate collection** as
Evidence against the policy's Assertion (ADR 0004), content-addressed with the file sha256 and
carrying `verificationMethod` so a reviewer can weigh insurer confirmation against a PDF; a
**bond register** with on-demand vs conditional status, milestone reduction schedules and —
the date that actually kills the security — the **demand deadline**, which is usually earlier
than expiry (#794); **bond calls** with the evidence relied on and the outcome; and **claims**
whose notification deadline is computed from the policy's `notificationDays` off the *aware*
date and materialized as an `obligations` row (ADR 0012), missing which is the insurance
analogue of a time bar. The expiry engine (`modules/insurance/expiry.ts`) is pure and takes an
explicit `asOf`; five detectors sweep lazily and idempotently.

**Out, and refused rather than approximated:**

- **Cover requirements are inferred, not declared.** Required policy types are derived from the
  programme itself (policies carrying a `requiredByClause`) or supplied per request; where
  nothing is recorded the gap analysis returns **`requirementsKnown: false` with a note**, not
  an empty gap list — a silent "no gaps" is the dangerous answer here. In-date cover nobody
  independent has verified is reported separately as `unverified`.
- **There is no FX anywhere in this module.** Bond exposure, claim reserves and settlements are
  grouped **per currency and never summed across currencies**, and the summary says so.
- **Bonding-line headroom (#796) is refused, not estimated**: no agreed facility limit per
  surety is recorded anywhere in the data, so utilisation is shown without a denominator
  rather than against an invented one.
- Not built: insurer/broker portal integration, premium and claims-experience analytics,
  policy-wording parsing (the clause-library treatment of ADR 0007 applied to insurance
  wordings), captive and programme-layer structures, and any automated notice *transmission* —
  the platform records that a notification was made and when, not the sending of it.

### Domain W — Organisational learning (#976–994 subset)

**In:** the failure mode this domain is defined by — capture is voluntary and retrieval is
nobody's job — inverted on both sides. **Capture is triggered by records**: seven rules
(`dispute_closed`, `claim_settled`, `delay_event_closed`, `variation_threshold`,
`signal_confirmed`, `gate_review`, `project_closeout`) read the registers other modules already
maintain and raise a trigger with a written rationale and an **`obligations` row that only a
lesson discharges** (#977); the variation threshold is configurable per project, then per
company, then a code default. A trigger has exactly three states — open, captured, dismissed
(which demands a named dismisser and a recorded reason) — and **no fourth**: it cannot quietly
expire. **Retrieval is bound to the record being created**, not a search box: relevance
ranking is deterministic, integer-scored and **returns the reason for every hit**
(category, tool affinity, phase, tag overlap, impact magnitude, recency, previously applied).
Validation is a second pair of eyes that may not be the author; publication is the tool-admin
act that makes a lesson company-wide while retaining `originProjectId`; **applications** bind a
published lesson to a later record on another project, which is the only evidence learning
crossed a boundary. Post-project reviews compute outturn from platform records.

**Out, and null rather than invented:**

- **Post-project metrics return `null` with reasons when inputs are missing**, never a
  fabricated number — the same contract as `modules/benchmarks/metrics.ts`, deliberately the
  same shape.
- **There is no budget table on this platform**, so "approved budget" is *derived*: executed or
  completed contract sums plus agreed variations. A project with no executed contract carrying
  a contract sum reports `approved_budget: null` with that sentence attached, and the
  cost-variance metric is withheld rather than computed against nothing.
- Not built: #988–989's cross-organisation knowledge exchange, semantic/vector retrieval (the
  ranker is keyword and metadata, deliberately explainable), automatic lesson *drafting* from
  the record that triggered capture, and any measurement of whether an applied lesson changed
  an outcome — `outcomeNote` is free text, not a controlled experiment.

### Vol I §0.7 — the integration surface (#120–121, #130–133 partial)

**In:** **webhooks that subscribe to the ledger append path** rather than to a hand-maintained
taxonomy that drifts silently from the truth. The emit hook fires after the chain transaction
commits, is awaited (so no event is lost to a dropped promise and emission is deterministic
under test) and **swallows every throw**, because `appendLedger`'s contract is that it never
fails a business transaction. The event catalogue is *derived* from the tenant's own ledger
entries, so it cannot drift — with the honest consequence, stated on the response, that a kind
the tenant has never produced does not appear. The envelope carries **identity and hashes,
never the ledger payload**, so a subscription is not a data export; `payloadHash` lets a
receiver verify a record it then fetches through the authenticated API. Signatures are
HMAC-SHA256 over `v1:{timestamp}:{deliveryId}:{rawBody}` with the delivery id bound in.
**OAuth2 client-credentials machine callers** resolve to scopes that are `tool:level` pairs
from the same vocabulary humans are governed by, checked by **the same `requireTool`
function** — and building it that way surfaced a privilege escalation a parallel scope checker
would have hidden, so machine callers are admitted only to routes carrying a tool gate.
Clients can never hold more than their creator held. **The Procore and Aconex transports are
complete**: credential resolution, the Procore OAuth2 exchange, the Aconex Basic +
application-key scheme, page-walking, termination, error propagation and mapping.

**Out, and the costs admitted rather than discovered later:**

- **The connectors have never been exercised against a live vendor.** Their fixtures were
  *authored from published API shapes, not captured from real traffic*, and this deployment has
  no route to either vendor. Aconex in particular renders XML search envelopes to JSON
  differently across versions, so the extractor deliberately accepts several documented shapes.
  **The first live pull is a discovery exercise** — expect to adjust field names, not
  architecture. Unconfigured, the 501 still names the exact variables required.
- **Webhook secret custody falls back to sharing `AUTH_SECRET`.** With `WEBHOOK_SIGNING_KEY`
  unset, anyone who can read the application's JWT secret can forge a signature a receiver
  would accept; every read reports `sharedCustody: true` with the remedy
  (`docs/security.md` §8.2 gap 22).
- **Outbound webhooks are an egress path with no endpoint allowlist.** A company admin can
  authorise what is effectively an exfiltration channel; per-company scoping, signing, delivery
  logging and auto-disable limit the blast radius without closing the class (gap 23).
- **Dispatch is an in-process timer, not a broker.** With N replicas the drain runs N times and
  the re-entrancy guard is per-process, so **a receiver can see a delivery twice** —
  **dedupe on the delivery id (`x-constructos-delivery`) is the published contract**, not
  something integrators are left to discover. `SELECT … FOR UPDATE SKIP LOCKED` is the upgrade
  path and does not change the wire format.
- Not built, and still last per Vol III §3: the developer sandbox (#123), the app marketplace
  (#124–125), MCP/agentic API exposure (#126–127), embedded experiences (#128–129), the wider
  **ERP connector framework** (#130–133) and P6/MS Project/Bluebeam/Autodesk exchange
  (#134–137).

### A latent bug found and fixed on the way

Worth recording because it explains a helper that now sits under every credential check.
Timestamp columns are declared `mode: "string"`, so Postgres hands back
`2026-08-25 23:00:00+00` while the application produces `2026-08-25T23:00:00Z`. Compared as
strings, the date halves agree and **the separator decides** — a space (0x20) sorts before `T`
(0x54) — so a credential valid until 23:00 read as **already expired at 10:00**. It was
invisible on every day except the one that mattered. It affected assurance grants and
ingestion API tokens, and it **failed closed** (access wrongly refused, never wrongly
granted). Every expiry comparison now goes through `epochMs` / `isExpired` / `isFuture` in
`apps/api/src/lib/time.ts`, and `lib/time.test.ts` pins the *wrong* comparison so nobody
reintroduces it believing it works.

### Phase-7 status against the Tier 1 acceptance criteria

Criterion 4 (*"Ledger heads/Merkle roots escrowed externally; a truncation attack becomes
detectable"*) is **met as machinery, bounded by custody**: truncation and wholesale rewrite are
detected and the detection is tested against real corrupted state, and a third party can verify
a receipt offline — but with a derived key the guarantee reaches a database-only attacker and
not the operator, and without a timestamp authority a seal proves order rather than time. What
remains is a key held elsewhere and a TSA account: deployment decisions, not code. Criterion 1
still waits on a counterparty (Phase 6). Criteria 2–3 (retrospective run on real data, measured
detector precision per detector) are unchanged and now sit at the front of the queue.

---

## Tier 1 — Assurance core completion (M1–M6) — M1 and M6 delivered, M2–M5 open

*(This section was headed "Phase 2 — Assurance core complete" in earlier revisions; ADR
0004 and `docs/security.md` refer to its content as Tier-1 roadmap work. The Phase 2 that
actually shipped is the commercial seed above; the work below is unchanged and remains the
gate to the sellable assurance product.)*

Goal: turn the seeds into the sellable assurance product of spec Vol III §2 — "every
certified payment … reconciled against independent evidence." M7's certificates
generate exactly the assertions this tier must reconcile, and Phase 5 added the first
*complete* consumer of the missing half: M17's ghost-worker reconciliation
(`modules/workforce/reconcile.ts`) is a finished engine that reads two tables, one of
which is meant to be fed by a system the claimant does not control. Phase 6 built that
feed's pathway (the Phase 6 section above): the engine's accuracy becomes an evidentiary
property the day a system the employer does not control actually posts through it. Phase 7
then built M1, so the chain those reconciliations rest on is sealed rather than
self-attesting. The remaining workstreams below — the detector programme, reconciliation
methods, graph depth and the reviewer workspace — still gate the sellable claim.

| Workstream | Representative spec functions | Notes |
|---|---|---|
| M6 Ingestion layer | Domain N #705–711 (API export/import, open schemas), #715 (foreign-system record mirroring); hash-at-ingest per S#862 | **Delivered (Phase 6, subset — see the Phase 6 section)**: staged CSV migration lands as `evidence` + `assertions` (and six more datasets) with hash-at-ingest and per-row provenance, and the machine-token push inlet delivers the **pathway separation** the §4 design rule requires. The Procore/Aconex transports were **completed in Phase 7** but have never spoken to a live vendor. Still open inside M6: a production deployment receiving a real third-party feed |
| M1 anchoring & escrow | S#860–861 notarisation & anchoring, #864 trusted time, #873–874 attestation & hash escrow, #871 forensic export format | **Delivered (Phase 7 — see the Phase 7 section)**: Ed25519 chain seals over `entryCount` + a Merkle root, chained to each other, heartbeat-refreshed, with six-verdict classification and offline-verifiable escrow receipts (ADR 0017). Still open: a signing key held **outside the operator** (with `ANCHOR_SIGNING_KEY` unset it is derived from `AUTH_SECRET`, so the guarantee reaches a database-only attacker and not the operator), a configured **timestamp authority** (#864 — the providers are built; seals prove order, not wall-clock time, until one exists), scheduled anchoring against a paid TSA, and S#871's forensic export format |
| M2 detector build-out | Domain A #1–35 (bid-pattern family), #53–71 (ghost vendor/worker, duplicate payment, certification-vs-evidence family), #93–99 (risk scores, red-flag register, false-positive loop) | Ship detectors with measured precision (Vol III §6.2: "ship five that work rather than fifty that fire"). Forty-three detectors now write signals, but only the six statistical ones in `modules/assurance/detectors.ts` are *inference*; the rest are deterministic rules whose precision is 1.0 by construction — the domain's hard families (#1–35, #53–71) remain unbuilt |
| M3 methods | Domain A #65–71 quantity/progress/plant/labour reconciliations; X#1017 evidence sufficiency scoring | Method plug-ins beyond mean-variance |
| M4 graph depth | A#9–11 shared bank/address/contact detection, #44 undeclared relationships, #45–50 PEP/sanctions/debarment screening & shell indicators | External registry integrations |
| M5 workspace | A#90–92 full reviewer/auditor/regulator workspaces, #100–101 case files & chain-of-custody, S#882 completeness certification | Case-file assembly over evidence packs |

**Acceptance criteria** (from spec Vol III §5 Phase 0–2 and §7):
1. One real project's records ingested from a third-party system, hashed at ingest, and a
   reconciliation report of certified quantities vs. independent evidence produced end-to-end.
2. A **retrospective detection run** on a completed project with a known integrity outcome,
   reporting precision/recall per detector — the spec's bar for "a plan becomes a company".
   *(The harness exists and passes on synthetic data — `docs/retrospective-detection.md`.
   What is missing is real third-party input, i.e. criterion 1 — which since Phase 6 waits
   on a counterparty, not on code.)*
3. Every detector ships with a measured precision figure and a reviewer feedback loop
   (`false_positive` dispositions feed detector tuning).
4. Ledger heads/Merkle roots escrowed externally; a truncation attack becomes detectable.
   *(**Met as machinery in Phase 7**, bounded by custody: truncation and wholesale rewrite are
   detected — tested against real corrupted database state — and an escrow receipt is verifiable
   offline by a third party. With a key derived from `AUTH_SECRET` the guarantee holds against a
   database-only attacker but not against the operator, and without a timestamp authority a seal
   proves order rather than time. Both remainders are deployment decisions — ADR 0017,
   `docs/security.md` §8.2 gaps 2–3.)*

---

## Tier 2 — complete as documented subsets (M7–M11)

"A variance is an observation; a variance mapped to a FIDIC sub-clause with a live time bar
is an action" (spec Vol III §5 Phase 3). M7–M10 built the sub-clause, the live time bar,
the forensic method and the statutory clocks; Phase 6 closed the tier with M11.

| Module | Status | Domain / representative functions | Notes |
|---|---|---|---|
| M7 Measurement & valuation | **Delivered (subset — see Phase 2)** | B#115–192 | — |
| M8 Contract intelligence | **Delivered (subset — see Phase 2)** | C#193–264 | — |
| M9 Delay & disruption forensics | **Delivered (subset — see Phase 3)** | D#265–320 | — |
| M10 Payment security | **Delivered (subset — see Phase 3)** | F#358–393 | — |
| M11 Independent benchmarking | **Delivered (subset — see Phase 6)** | R#821–858: outcome-metric distributions with contribute-to-access and min-n suppression | The rate/productivity benchmark family is still open depth (see "What remains"); BQ rates + `rateBuildUp` components and variation star rates remain the raw material for it |

---

## What remains — the honest inventory

The module map is entered; the specification is not finished. Two kinds of absence, kept
apart because they carry different risk: **structural holes** (things the platform claims
to be but cannot yet do) and **breadth** (spec surface deliberately not built). Function
numbers are from `docs/master-specification.md`.

### Structural holes — one closed, one now a deployment condition

| # | What is missing | Why it is structural |
|---|---|---|
| 1 | **A real third-party feed through M6** (Vol III Tier 1; Domain N #705–711, #715; S#862) | Phase 6 built the pathway: records can now arrive staged, hashed at ingest and — via dataset-scoped machine tokens — through a channel the operator's user sessions do not share (`POST /ingestion/push/:dataset`; ADR 0014, ADR 0015). Phase 7 finished the other end of the wire: the Procore and Aconex transports are now complete — token exchange, page-walking, error propagation and mapping, fixture-tested — and an *unconfigured* pull returns 501 naming the exact credentials and environment variables it needs. What no deployment has yet done is connect one: no vendor instance has ever answered a request from this code, and no turnstile vendor, bank or telematics provider posts to a production instance. The hole is smaller than it was — a capability gap became a deployment gap — but until a real feed flows, "reconciled against independent evidence" is a capability of the product exercised by nobody, and the platform still cannot prove who holds a token (`docs/security.md` §8.2 gap 17). |
| 2 | ~~**M1 anchoring & escrow**~~ — **closed in Phase 7** (Domain S #860–861, #864, #873–874) | Seals commit to `entryCount` and a Merkle root over every entry hash, signed Ed25519 with a key whose private half never enters the database and chained to one another, so tail truncation and wholesale rewrite are now detected — tested against real corrupted database state, not mocks — and escrow receipts let a third party verify offline. What is left is not a hole but a **custody** condition: with `ANCHOR_SIGNING_KEY` unset the key is derived from `AUTH_SECRET` and proves integrity against a database-only attacker, not against the operator; and without a timestamp authority configured, seals prove order rather than wall-clock time. Both are carried in the API responses themselves. See ADR 0017 and `docs/security.md` §8.2 gaps 2–3, rewritten accordingly. |

Everything else on this page is scope. These two were the difference between a very good
system of record and the product Vol III describes. Phase 7 closed the second outright.
The first is no longer a capability gap either — what remains of it is counterparty work:
connecting a feed, and attesting who operates the system that pushes it.

### Vol II — gap domains still absent

Three domains have left this table. Domain R (independent benchmarking) left it in Phase 6;
**Domain P (insurance & bonding)** and **Domain W (organisational learning)** left it in
Phase 7. In each case the delivered subset and its stated limits are in that phase's section,
and the depth still missing is listed under "depth still missing" below.

| Domain | Range | Status |
|---|---|---|
| **Domain Q — Tax & statutory deduction** | #798–820 | Not started. VAT/GST by jurisdiction and supply type, reverse charge, CIS/withholding regimes, permanent establishment exposure. This is the family M19 explicitly did not open (#606–607), and it is the one place where a wrong answer creates liability directly rather than through a claim — it wants the same code-resident-regime-library treatment as ADR 0007/0010 and a specialist review. |
| **Domain U — Supply chain, logistics & offsite manufacture** | #913–947 | Not started. Multi-tier supply chain mapping, offsite/modular production tracking, logistics and delivery sequencing, material traceability. M18's waste and carbon models and M16's parcel logistics touch its edges; the module itself is not built. |
| **Domain V — Commissioning & systems turnover** | #948–975 | Not started. Systems/subsystems breakdown, commissioning plans, pre-functional and functional test records, turnover packages, performance verification. The twin module (`modules/twin`) holds the asset register and delivery milestones this would hand over into — the seam is designed, the module is not. |
| Domain Z — miscellaneous critical absences | #1048+ | Not started (bid/no-bid win-probability modelling and the rest). |

### Vol II — depth still missing inside delivered domains

Delivered ≠ complete: each phase drew its boundary function-by-function above. The largest
remaining depth, worst first:

- **Domain A — the detector programme** (#1–114). Six statistical detectors shipped in the
  foundation; the domain specifies 114. The families that matter and are unbuilt: bid
  patterns (#1–35), the ghost-vendor / duplicate-payment / certification-vs-evidence
  family (#53–71 — M17's ghost-*worker* reconciliation is one member of it), risk scoring
  and the red-flag register (#93–99). The spec's own rule governs: *"ship five that work
  rather than fifty that fire"* (Vol III §6.2), which is why this is sequenced with real
  ingested data (the M6 pathway now exists to supply it) and measured precision rather
  than shipped as a batch.
- **Domain R — the benchmark *service*** (#821–858 beyond the Phase 6 subset): the
  rate/productivity benchmark database by asset class (#821) built from BQ rates,
  `rateBuildUp` components and star rates; methodology review; and the thing no code
  ships — enough contributing tenants that suppression lifts and the spec's constraint
  (*"the benchmark must be independent of the benchmarked"*) is satisfied by population
  rather than by a seed-data label. The Phase 6 machinery (contribute-to-access, min-n,
  the anonymization boundary) is the container this fills.
- **Domain D — forensic method** (#274–298): full retrospective windows analysis with
  per-window schedule updates, SCL-Protocol method selection, concurrency/pacing/float
  ownership, measured mile and the disruption family.
- **Domain B — measurement depth** (#117–134, #150–161, #172–192): full method-of-measurement
  rule engines, remeasurement and dayworks depth, CVR/WIP beyond the summary seed.
- **Domain F** (#373–393): liens, retention trusts and project bank accounts, adjudication
  case management, supply-chain payment reporting.
- **Domain O** (#734, #736–738, #744–768): DFI withdrawal-application formats,
  designated-account reconciliation, LTA/independent-engineer certification, PPP models.
- **Domain P — the insurance programme beyond the register** (#771–797 remainder): insurer
  and broker portal integration, premium and claims-experience analytics, policy-wording
  parsing (the ADR 0007 clause-library treatment applied to insurance wordings), captive and
  programme-layer structures, and the bonding-line facility record that would make headroom
  (#796) computable instead of refused.
- **Domain W — learning beyond one organisation** (#976–994 remainder): #988–989's
  cross-organisation knowledge exchange, semantic retrieval on top of the deliberately
  explainable keyword/metadata ranker, automatic lesson drafting from the record that triggered
  capture, and any measurement of whether an applied lesson changed an outcome.
- **Domains G/H/E/I/J/K/M**: the exclusion lists in each phase section above.

### Vol I — parity surface still absent

Per Vol III §3 Tier 5 this is *deliberately* last (*"Do not start here … even then consider
acquiring rather than building"*). Named honestly so nobody discovers it in a demo:

| Spec area | Range | Note |
|---|---|---|
| §1.1 Bid management | #155–183 | Bid packages, invitations, bidder comparison, levelling. Nothing built. |
| §1.2 Estimating & takeoff | #184–208 | Digital plan takeoff from PDFs, assemblies, estimate→budget conversion. The *measurement* half exists commercially (M7 takeoff lines with drawing provenance, `docs/architecture.md` §10.3) but the estimating tool does not. |
| §1.3 Prequalification | #209–230 | Questionnaire builder, financial screening, scoring, expiry. Adjacent to Domain A vendor screening and to M17's vendor risk score — a natural pairing when it lands. |
| §3.1–3.5 The financial suite | #479–585 | **Budget, prime contracts, commitments (subcontracts/POs), change management, invoicing.** This is the single largest parity hole: ConstructOS has BoQ→valuation→certificate (M7) and facility→disbursement (M14) but no budget/commitment ledger between them. Tool keys `budget`, `commitments`, `change_management`, `invoicing` are already reserved in `packages/shared/src/permissions.ts`. |
| §3.6–3.8 Pay, T&M tickets, timecards | #586–616 | Not built. Timecards are the parity-side twin of M17's payroll/access streams and should be built so that the two do not become one author (ADR 0014). |
| §4.1, §4.3–4.4 Inspections, incidents, safety programme | #617–633, #647–675 | Not built. §4.2 observations (#634–646) are partially covered by the field module's punch/photo surface, not as a first-class observation object. Incident reporting has an assurance twin in M#701–702 (independent fatality reporting, under-reporting detection) that is also unbuilt. |
| §5.1–5.4 Resource, equipment & materials management | #676–730 | Not built. Equipment (#700–718) is where telematics enters the platform — the third independent evidence stream named in ADR 0014, and the reason this section is more interesting than its parity label suggests. |
| §0.6 Mobile & field | #104–118 | No native iOS/Android apps and no offline mode. The web app is responsive; that is not the same claim. Compounded by Domain K #616–626 (offline-first, SMS/USSD, low-bandwidth sync) — together they are an **application-shell programme**, not a module. |
| §0.7 Integration & extensibility | #119–142 | REST API (#119) and rate limiting (#122) exist; **webhooks (#121) and OAuth2 for machine callers (#120) were delivered in Phase 7** — the emitter hangs off the ledger append path, so the event catalogue is derived rather than curated, and machine callers resolve through the same `requireTool` gate as humans (ADR 0018). The **Procore/Aconex transports are complete** but have never been exercised against a live vendor, so the first pull is discovery. **Still absent: the developer sandbox (#123), the app marketplace (#124–125), MCP/agentic API exposure (#126–127), embedded experiences (#128–129), the wider ERP connector framework (#130–133) and P6/MS Project/Bluebeam/Autodesk exchange (#134–137).** |
| §6.3 Insights & benchmarking | #753–758 | See M11 — the cross-project distribution half was delivered in Phase 6; predictive insights were not. |
| §7 Owner & portfolio | #776–789 | Partially met sideways: portfolios, stage gates (M12), portfolio contingency (M13) and cross-project reporting (Phase 5 analytics) exist; a dedicated owner/portfolio workspace does not. |

---

## Recommended next sequence

The order has not changed since Phase 4; what has changed is that **step 2 is done.**
Phase 7 built M1 anchoring and escrow, so the remaining sequence is
**connect a real feed through M6, then run the spec §7 retrospective detection on real
data** — with the two custody items M1 left behind carried alongside. Then, and only then,
demand-led work.

**1. A real independent feed through M6 (Domain N #705–711, #715; S#862).** *Reasoning:*
Phase 6 built the staged pipeline, the hash-at-ingest provenance and the machine-token
inlet — the only item that changed what the product *is* rather than what it covers — and
Phase 7 finished the Procore and Aconex transports, so "the code is not the blocker" is now a
demonstrated fact rather than an assertion. What no phase can build is the other end of the
wire. In order of evidentiary value per unit of work: site access-control systems (feeds M17
directly — `POST /ingestion/push/site_access` is live for exactly this), bank/payment files
(feeds M14 and Domain A's duplicate-payment family), telematics (feeds plant and daywork
claims), then a first real Procore or Aconex pull for the incumbent-migration story — which
should be planned as a **discovery exercise**, because the connector fixtures were authored
from published API shapes rather than captured from live traffic (ADR 0018). This step is
integration and counterparty work, not platform code (ADR 0015).

**2. M1 anchoring & escrow (S#860–861, #864, #873–874) — DONE (Phase 7).** Chain seals
commit to `entryCount` and a Merkle root over every entry hash, signed Ed25519 with a private
half that never enters the database and chained to one another; heartbeat seals bound the
window in which a truncation can hide; `classifyChain` names the failing seal or entry; and an
escrow receipt is verifiable offline by a third party with no access to this platform. Tail
truncation and wholesale rewrite are **detected**, tested against real corrupted database
state. `docs/security.md` §8.2 gap 2 is rewritten as a custody condition and gap 3 is narrowed
rather than closed, and the Tier-3 dispute-bundle criterion now has the escrowed head it was
waiting for. **What remains of it is not code, and belongs beside step 1 rather than in front
of it:**

   - **Key custody.** Generate an Ed25519 key, set `ANCHOR_SIGNING_KEY` from a secret manager,
     keep it off the application host, and publish the fingerprint to the parties who will
     verify. Until then — and by default outside production — the key is derived from
     `AUTH_SECRET` and the guarantee reaches a database-only attacker but **not the operator**,
     which every seal, verdict and receipt says on its face.
   - **A timestamp authority.** Configure `ANCHOR_TSA_URL` (RFC 3161) or
     `ANCHOR_OTS_CALENDAR_URL`. The providers are written and fixture-tested and record
     `unavailable` rather than fabricating a proof; until one is configured, **seals prove
     order, not wall-clock time** (#864).

**3. The §7 retrospective detection run, on a real completed project.** *Reasoning:* the
spec names it as the single highest-value next artefact and the thing that *"converts this
document from a plan into a company."* The harness is built and green — 17/17 recall, 100%
precision on the synthetic scope (`docs/retrospective-detection.md`); what it lacks is real
input, which is exactly what step 1 supplies. Run it with an audit institution or public
client, publish the methodology (not the findings, per §7), and let it pull M2 detector
build-out behind it with measured precision per detector. Step 2 is now a genuine asset here:
the numbers can be shown against a sealed chain, and the receipt handed over with them.

**4. Then demand-led, in whichever order the first institutional customers actually
require** — the Vol III §5 Phase 4 rule, which Phase 5 deliberately broke to close the map
and which now resumes:

- **Depth inside a delivered safeguard module** beats a new one. A DFI engagement that
  bought M17 will want #678–682 (wage/overtime/rest-day rule engines by jurisdiction) and
  #689–691 (the employer-independent worker voice channel) first.
- **Domain Q tax & statutory deduction** (#798–820) is now the gap domain that most often
  appears as a hard contractual condition, and the one place where a wrong answer creates
  liability directly rather than through a claim — it wants the code-resident regime-library
  treatment of ADR 0007/0010 and a specialist review, and should not be speculated on.
  (Domain P insurance/bonding and Domain W organisational learning, which used to sit here,
  were built in Phase 7.)
- **Depth inside the Phase 7 modules** where a customer asks for it: a bonding-line facility
  record would make headroom (#796) computable instead of refused; cross-organisation
  knowledge exchange (#988–989) is the natural extension of Domain W.
- **The §3 financial suite** is the largest parity hole and the one customers will name
  first when asked to run two systems — and per Vol III §3, still the last thing to build,
  and a candidate for acquisition rather than construction.

**Completion criteria carried forward** (now waiting on step 1 alone): evidence-side tracing
of certified valuations; a live-contract time-bar save; a live dispute bundle produced and
verified by a receiving party against an escrowed chain head — **the escrowed head exists as
of Phase 7, so what remains is a receiving party actually doing it**; the
reconciliation-gated drawdown; and **a ghost-worker reconciliation run against an
access-control feed the employer does not control** — the Tier-4 acceptance criterion in
its full form.

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
Status: the first is evidence-gated but not yet reconciliation-gated (M3 methods over a
real ingested feed — the M6 machinery landed in Phase 6); the second is now **complete as
machinery** — Phase 7 supplied the escrowed head the criterion was missing, and a receiving
party can verify a receipt offline against the seal that covers the bundle's chain
(ADR 0017), bounded by the key-custody caveat. What has not happened is a real receiving
party doing it. See the Phase 4 and Phase 7 sections.

---

## Tier 4 — Safeguards & sustainability (M16–M19) — delivered (subset)

*(Delivered as Phase 5, above — the function-by-function boundary, the named exclusions
(J#552, #562–563, #567, #576–578; M#678–682, #689–693, #700–704; I#493, #497, #499–500,
#502–504, #509–526, #541–546; K#600–611, #616–626) and the honest status against this
tier's acceptance criterion are in that section.)*

| Module | Domain / representative functions | Status |
|---|---|---|
| M16 Land, resettlement & grievance | J#547–592 | Delivered subset — see Phase 5 |
| M17 Worker welfare & labour rights | M#667–704 (biometric/attendance evidence feeds ghost-worker detection A#54) | Delivered subset — see Phase 5 |
| M18 Carbon, ESG & social value | I#491–546 | Delivered subset — see Phase 5 |
| M19 Multi-jurisdiction operations | K#593–626 (multi-currency, local statutory regimes) | Delivered subset — see Phase 5 |

**Acceptance criterion:** welfare and safeguard records held to the same evidentiary standard
as financial ones — hashed, ledgered, reconciled against independent sources (e.g. M17
attendance vs. access-control logs). Status: **ledgered — met; reconciled — the mechanism
is built (ADR 0014) and since Phase 6 the evidence side has its own machine pathway
(dataset-scoped tokens, `POST /ingestion/push/site_access`), with token custody the stated
residual assumption; hashed — file-backed evidence and M6 file runs; pushed rows are
ledgered per run, not file-hashed.** Full analysis at the end of the Phase 5 section, with
the Phase 6 notes inline.

Build order *within* this tier was supposed to be demand-driven per spec Vol III §5 Phase 4
(*"built in the order your first three institutional customers contractually require them.
Do not speculate."*). Phase 5 built all four together to close the module map — a deliberate
deviation, whose cost is that each module is a breadth-first subset. The rule resumes for
everything after it: see "Recommended next sequence" above.

---

## Tier 5 — Parity — deliberately last

Vol I Sections 1–5 remainder (~600 functions): bid management, estimating & takeoff,
prequalification, the full §3 financial suite, quality & safety, resources & equipment,
meetings, correspondence, specifications, forms — plus §0.6 mobile/offline and what is left
of the §0.7 integration surface (developer sandbox, marketplace, MCP exposure, embedded
experiences, the ERP connector framework; webhooks and OAuth2 were taken early in Phase 7,
for the reason given below). Enumerated with section and function numbers under "What
remains" above. Per spec Vol III §3 Tier 5:
*"Do not start here … even then consider acquiring rather than building."* Entered only
when a customer refuses to run two systems. The foundation keeps this option open — tool
keys for budget/commitments/change_management/invoicing/meetings are already reserved in
`packages/shared/src/permissions.ts`, and the record-links/custom-fields/workflow substrate
is tool-agnostic. Note the exceptions already taken deliberately: the §2.6 schedule
core (Phase 3, because delay forensics needs a programme to run on), §6.1–6.2 reporting
(Phase 5, because every domain now has something worth reporting on), and §0.7's webhooks and
OAuth2 (Phase 7, because both were nearly free on assets the platform already had — the ledger
already enumerated every event worth emitting, and the RBAC model already answered "may this
actor do this?"; a parallel scope model would have been the expensive choice, ADR 0018). All
parity surface, each built because something that was not parity depended on it or made it
cheap.

---

## Standing risk register (spec Vol III §6, mapped to phases)

| Kill risk | Mitigation in this plan |
|---|---|
| Evidence independence collapses | M6 shipped in Phase 6 (staged commits, hash-at-ingest, dataset-scoped machine tokens — ADR 0015), so the two streams no longer *must* share an API pathway; connecting a claimant-independent feed jumps the queue on any assurance-led engagement; `independenceScore` + separation rule already enforced; certification/EOT separation-of-duties added in Phase 2 (`docs/security.md` §2.4); Phase 5 raised the stake and named the law — `docs/adr/0014-independent-evidence-streams.md` makes two-stream separation a design rule with M17's payroll-vs-site-access reconciliation as its first instance, and stated plainly that both streams shared an API pathway until M6 — the pathway Phase 6 now provides, leaving token custody as the stated assumption (`docs/security.md` §8.2 gap 17); contractual evidence mandates at project setup |
| False-positive fatigue | Precision measured before a detector ships (Tier-1 acceptance #3); reviewer feedback loop live since foundation. Phase 2 added two deterministic detectors (`time_bar_missed`, `time_bar_breach_risk`), Phase 3 two more (`payment_deemed_liability`, `late_payment_response`) Phase 4 four more (`contingency_exhaustion`, `facility_condition_overdue`, `covenant_breach`, `dispute_deadline_missed`), Phase 5 sixteen more across the safeguard modules, Phase 6 two more (`ingestion_duplicate_replay`, `benchmark_outlier`) and Phase 7 nine more (five insurance detectors plus the four chain verdicts) — all with precision 1.0 by construction: threshold and date arithmetic, not inference. The chain-verdict detectors add a fingerprinting rule worth naming: a finding is identified by *what it is about* (the altered entry, or the seal that caught the failure), never by the surviving chain head, which moves on every append and would otherwise raise a fresh critical signal on every poll. The retrospective harness (`docs/retrospective-detection.md`) exits non-zero if recall drops below 100% **or the clean control project raises any signal at all** — a runnable false-positive gate, unchanged at 17/17 recall and 100% precision (`pnpm --filter @constructos/api eval:retrodetect`; still not wired into `.github/workflows/ci.yml`) |
| **The record is trusted more than the custody warrants** | *New in Phase 7, because Phase 7 created it.* Sealing makes tail truncation and wholesale rewrite detectable (ADR 0017), and the danger of a mechanism like that is a reader hearing "cryptographically sealed" and stopping there. The mitigation is that the weakening is carried **in the data, not only in the docs**: a key derived from `AUTH_SECRET` produces key ids prefixed `ankd_`, and every key record, seal, verdict, anchor proof and escrow receipt reports `derivedFromAuthSecret: true` with a plain-English note; receipts list what they do **not** prove; production refuses to seal without a real key; and an unconfigured timestamp provider records `unavailable` naming the missing variable rather than fabricating a proof. Closing it for real is two deployment acts — a signing key held outside the operator, and a TSA account (`docs/security.md` §8.2 gaps 2–3) |
| **The integration surface becomes an exfiltration surface** | *New in Phase 7.* Outbound webhooks leave the tenant boundary for operator-nominated URLs with **no endpoint allowlist**, and with `WEBHOOK_SIGNING_KEY` unset the signing secret shares custody with `AUTH_SECRET` (`docs/security.md` §8.2 gaps 22–23). Mitigations that limit rather than close it: per-company scoping enforced in the query, envelopes carrying identity and hashes instead of record payloads, signed deliveries with the delivery id bound in, a full delivery log, auto-disable after consecutive failures, and `sharedCustody: true` reported on every read so an operator is told rather than left to assume. An allowlist and an SSRF guard are the fix and are not built |
| Procurement cycle length | Services-led entry: the Tier-1 retrospective detection run *is* the first engagement deliverable; since Phase 7 it can be delivered **with an escrow receipt attached**, which is the difference between showing an institution numbers and handing it something it can check |
