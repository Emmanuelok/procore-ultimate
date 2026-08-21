# ConstructOS — Roadmap

Maps the committed codebase (called **Phase 0/1 — Foundation** here) onto the master
specification (`docs/master-specification.md`), then lays out the phased build mirroring the
Volume III module tiers. Function numbers cite the spec: Vol I numbers are the Procore
inventory (#1–804), Vol II numbers run continuously across the gap domains (#1–~1100,
Domain A starting at #1, Domain S at #859, Domain X at #995).

The sequencing follows spec Vol III §5 deliberately: the assurance core before commercial
depth, commercial depth before governance, and Volume I parity **last** — the spec's "parity
trap" warning (Vol III §1) is treated as binding.

---

## Phase 0/1 — Foundation (this codebase)

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
| M7–M19 | Not started |

Not implemented at all (deliberately): Vol I §1.1–1.3 (bid/estimating/prequal), §2.2 specs,
§2.6 schedule, §2.9/2.11–2.13, §3 financial suite, §4 quality & safety, §5 resources,
§6 analytics; Vol II domains B–K, M–R, T–Z beyond the seeds listed above.

---

## Phase 2 — Assurance core complete (Vol III Tier 1: M1–M6)

Goal: turn the seeds into the sellable assurance product of spec Vol III §2 — "every
certified payment … reconciled against independent evidence."

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

## Phase 3 — Commercial depth (Vol III Tier 2: M7–M11)

"A variance is an observation; a variance mapped to a FIDIC sub-clause with a live time bar
is an action" (spec Vol III §5 Phase 3).

| Module | Domain / representative functions | Foundation hooks already in place |
|---|---|---|
| M7 Measurement & valuation | B#115–126 BQ + methods of measurement, #139–140 taking-off audit trail & quantity provenance, #151+ valuation/certification | `assertions.kind = quantity/rate`, cost codes/WBS in `core.ts` |
| M8 Contract intelligence | C#193–229 clause engine, notices, **time bars** (#229 breach warning before expiry) | `obligations` with `deadline` + `warnDaysBefore` and `/obligations/upcoming` are the primitive |
| M9 Delay & disruption forensics | D#265–320: as-planned vs as-built, window analysis, concurrent delay, contemporaneous records | `events` with `detectedOrReported` + `causalLinks`; daily logs; ledger timestamps |
| M10 Payment security | F#358–393: statutory payment regimes, payment-chain visibility | `assertions.kind = entitlement/cost`; invoicing tool key reserved in `TOOLS` |
| M11 Independent benchmarking | R#821–858: independent rate/productivity benchmarks | anonymized cross-tenant aggregates over assertions/reconciliations |

**Acceptance criteria:** a certified interim valuation traced item-by-item to BQ lines and
evidence (B#140); a time-bar warning fired *before* expiry on a live contract (C#229); one
delay analysis assembled solely from ledgered contemporaneous records (D domain), exported as
an evidence pack.

---

## Phase 4 — Programme & capital governance (Vol III Tier 3: M12–M15)

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

## Phase 5 — Safeguards & sustainability (Vol III Tier 4: M16–M19)

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

## Phase 6 — Parity (Vol III Tier 5) — deliberately last

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
| Evidence independence collapses | M6 ingestion first in Phase 2; `independenceScore` + separation rule already enforced; contractual evidence mandates at project setup |
| False-positive fatigue | Precision measured before a detector ships (Phase 2 acceptance #3); reviewer feedback loop live since foundation |
| Procurement cycle length | Services-led entry: the Phase 2 retrospective detection run *is* the first engagement deliverable |
