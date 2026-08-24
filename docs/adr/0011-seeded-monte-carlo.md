# ADR 0011 — Seeded, deterministic Monte Carlo (reproducibility over "true" randomness)

**Status:** accepted (implemented in `apps/api/src/lib/montecarlo.ts`, consumed by
`apps/api/src/modules/risk/`)

## Context

Spec Domain H (M13) requires quantitative risk analysis: QSRA and QCRA by Monte Carlo
simulation (#457–458), three-point estimates and per-risk distributions (#459–460),
P50/P80/P90 outputs for cost and completion date (#465), tornado and criticality/sensitivity
indices (#466–468), and confidence-level contingency setting (#469). The outputs are not
decorative statistics: a P80 becomes the contingency a board approves, the completion
confidence a gate review relies on (Domain G #414), and — on the assurance thesis this
platform is built around — a number an auditor may later be asked to challenge.

That last consumer creates the design tension. A conventional Monte Carlo implementation
seeds its PRNG from the clock: every run of the same model gives different percentiles
(within sampling error). That is statistically fine and forensically useless. When the
question is *"prove that the P80 presented at Gate 3 came from these inputs"*, "run it again
and get a similar number" is not an answer. The platform's standing rule — every consequential
computation must be replayable from its record (the pure CPM engine of ADR 0009, the
statutory clocks of ADR 0010) — applies with more force here, because a simulation buries
its arithmetic under tens of thousands of samples.

There is a second honesty problem specific to this domain. The spec asks for a correlation
matrix between risks and common-cause modelling (#461–462). Independent sampling —
the simplest correct-in-isolation implementation — systematically **understates** spread
when risks are positively correlated (the common case: weather delays correlate, market
escalation hits every package at once). A tool that silently reports too-narrow a P80 is
worse than no tool: it launders overconfidence through a Monte Carlo veneer.

## Decision

The engine (`apps/api/src/lib/montecarlo.ts`) is **pure, seeded and deterministic**:

1. **All randomness flows from one caller-supplied 32-bit seed** through a mulberry32 PRNG
   (`createRng`). No `Math.random`, no clock, no I/O. Same inputs + same seed + same
   iteration count ⇒ bit-identical results, on any host. Distribution sampling
   (`sampleDistribution`: triangular, PERT via Marsaglia–Tsang beta, uniform, Box–Muller
   normal, lognormal, discrete) draws only from that stream.
2. **The record is the run.** Every simulation persists to `risk_simulations`
   (`packages/db/src/schema/risk.ts`) with the seed, the iteration count and a **full input
   snapshot** — the sampled risk set for QCRA; the task/dependency network, project start
   and per-task distribution sources for QSRA — plus the complete results object, and is
   ledgered with its headline percentiles. The simulation does not depend on the live risk
   register or schedule staying frozen; it carries its own inputs.
3. **Reproducibility is an endpoint, not a promise.**
   `POST /projects/:projectId/risk-simulations/:simId/rerun` (`modules/risk/index.ts`)
   replays the stored snapshot with the stored seed and reports whether the fresh
   percentiles deep-equal the persisted ones, ledgering the check as an `access` entry.
   A failed rerun means the record was tampered with or the engine has drifted — either is
   exactly what an auditor needs surfaced. Corollary: **any change to the sampling code is
   a breaking change to historical reruns** and must ship as a deliberate, reviewed event
   (the engine's unit tests pin the arithmetic; a future `engineVersion` column on
   `risk_simulations` is the extension point if sampling ever must change).
4. **QSRA rides the CPM engine.** Each iteration samples task durations and calls
   `computeCpm` (`lib/cpm.ts`) — the same pure engine that schedules the project
   deterministically, which is why criticality indices and completion distributions agree
   with the scheduling module's conventions by construction. This is the payoff ADR 0009's
   purity trade-off was shaped for: thousands of CPM passes per request with no database
   contact.
5. **Correlation between risks is NOT modelled, and every result says so.** `runQcra` and
   `runQsra` both return `correlationModelled: false` as a literal field in the result
   object (persisted, and available to every UI). Spec #461–462 are explicitly out of
   scope for this phase. The roadmap item is an **Iman–Conover rank-correlation stage**:
   sample all marginals independently as today, then reorder samples per risk to induce a
   caller-supplied rank-correlation matrix — it composes cleanly with the existing
   samplers, preserves the marginal distributions and stays deterministic under the same
   seed. Until it lands, results are documented as narrower than reality wherever risks are
   positively correlated — the flag exists so UIs and reports can say so rather than
   letting the caveat live only in documentation.

Iteration counts are clamped (QCRA 100–20,000; QSRA 50–5,000 — each iteration is a full
CPM pass) so a request cannot convert the engine into a denial-of-service primitive.

## Consequences

- **A percentile is now an auditable claim.** The chain is: ledgered simulation → stored
  seed + input snapshot → rerun endpoint → deep-equal percentiles. Contingencies cite their
  source (`contingencies.confidenceLevel` + `simulationId`), so "why is the contingency
  £X?" resolves to a replayable computation, not a recollection.
- **Determinism costs nothing statistically.** Seeded mulberry32 is not
  cryptographically random, and does not need to be: the requirement is statistical
  adequacy for sampling plus exact replay, and the engine's tests verify distribution means
  and reproducibility (`lib/montecarlo.test.ts`). Callers wanting run-to-run variation
  simply pass a different seed (the API defaults the seed from the clock **once, at run
  creation** — after which it is pinned in the record).
- **The limitation is machine-readable, in the same spirit as ADR 0010.** As with the
  regime library's `deemedRule`, the `correlationModelled: false` flag makes the model's
  honesty part of the payload; documentation cannot drift from behaviour.
- **Extension path**: Iman–Conover rank correlation (#461–462) as an optional stage keyed
  off a stored correlation matrix; risk-adjusted forecasts (#475–476) as read models over
  the latest simulation; convergence reporting (#464's second half) as a summary statistic
  computed from the existing sample stream. None of these disturb the seed-and-snapshot
  contract.
