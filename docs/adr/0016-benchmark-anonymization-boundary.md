# ADR 0016 — Benchmark anonymization boundary and contribute-to-access

**Status:** accepted (implemented in `apps/api/src/modules/benchmarks/` over
`packages/db/src/schema/benchmarks.ts`; governs M11 and any future cross-tenant
aggregation)

## Context

M11 was the module every roadmap revision refused to start, for a stated reason: a
benchmark built from one tenant's data is a mirror, not a benchmark, and the spec's own
constraint — *"the benchmark must be independent of the benchmarked"* (Domain R) — cannot
be satisfied by code alone. It needs data from more than one tenant, and that creates the
one problem this platform had never had before Phase 6: **a read path that crosses the
tenant wall by design.**

Everything else on the platform is tenant-isolated by convention — every query filters
`companyId` (`docs/security.md` §3). A cross-project distribution breaks that convention
deliberately: tenant A's number must inform what tenant B sees. Three failure modes had
to be designed against before the first row was written.

First, **attribution leakage.** In construction, a cost-per-m² figure attached to an
asset class, a region and a year is close to identifying on its own — the population of
GB hospital projects in a given year is small. If contributor identity ever appears in a
response, or can be joined back through an id, the module is a data breach with a
statistics UI.

Second, **small-n inference.** Aggregates do not protect anyone at n = 2: a contributor
who knows its own value can subtract it from a mean. Any honest design has to decide the
n below which it will show nothing, and say so.

Third, **the free-rider and the fabricator.** If distributions are free to read, no one
contributes and the seed data becomes the product. If contribution is unverified, the
cheapest way to look good is to contribute fiction. The spec's #855 names the mechanism
for the first (contribute to access); nothing fully solves the second — a benchmark
service can only make fabrication attributable and expensive, not impossible.

There was also a nearer-term temptation: with no second tenant on day one, ship
plausible-looking distributions and call them benchmarks. The platform's carbon module
had already set the precedent for the honest alternative — seeded reference data carrying
a verbatim health warning.

## Decision

**Contributor identity is written to exactly one place, read for exactly one purpose,
and returned by nothing. Access to contributed distributions is earned by contributing.
Cells with fewer than `MIN_SAMPLE_N` contributed samples are suppressed, with the sample
size always disclosed. Seed data exists so the machinery works on day one, and every
response that includes it says what it is.**

Concretely, as implemented:

1. **The boundary is structural, not procedural.**
   `benchmark_samples.contributorCompanyId`/`contributorProjectId` exist only to enforce
   contribute-to-access and to count contributors; they are null on seed rows. In the
   whole module they are read in one WHERE clause (`hasContributed`) and written in two
   places (null on seed insert, the contributing tenant on contribute). Every
   distribution read goes through `cellRows`, which selects only
   `{value, dataYear, methodology}`; the single row-returning path goes through
   `viewSample`, which does not know the contributor columns exist. There is no code path
   from a distribution response back to a contributor — not "no authorized path": no
   path.
2. **Contribute-to-access** (#855). A tenant that has not contributed a sample for a
   metric sees only the seed distribution, marked `accessLevel: "seed_only"` with an
   explicit upgrade note; after contributing, the seed rows drop out and the contributed
   distribution appears. Contribution is a `benchmarks` **admin** act — the value leaves
   the tenant's walls, anonymized, forever — and is idempotent per snapshot: one snapshot
   becomes at most one sample.
3. **What is contributed is a computed, auditable number, not a form field.** A sample is
   born from a `project_metric_snapshots` row, which the platform computed from the
   project's own records with the exact inputs persisted; a metric whose inputs are
   missing returns a 422 naming them rather than a fabricated zero. Fabrication therefore
   requires fabricating the underlying operational records — possible, but ledgered,
   attributable and expensive, which is the available ceiling.
4. **Min-n suppression with unconditional disclosure** (#831, `MIN_SAMPLE_N` = 5). A cell
   with fewer than five contributed samples returns `{n, suppressed: true}` and nothing
   else — a percentile over three contributors would let one bound another's number. `n`
   itself is disclosed in every branch, suppressed or not, seed or contributed, because a
   benchmark that hides its sample size is an opinion. Seed rows are shown at any n: they
   are fictional and protect nobody.
5. **Seed data is labelled at the row, and the label travels.** Every seed row carries
   the methodology string *"Illustrative seed distribution — not derived from real
   project data"* verbatim, and every response whose statistics include seed rows repeats
   it as `healthWarning`. Seed cells are code-resident, deterministic (no RNG), and
   materialized lazily with a ledger entry recording the materialization.
6. **The comparison raises signals, not rankings.** Compare reports the project's
   percentile rank in its cell and raises a `benchmark_outlier` signal only beyond the
   adverse tail (p90, or p10 where higher is better), idempotent per snapshot, with the
   arithmetic in the explanation. Under suppression the percentile is withheld with
   everything else.

## Consequences

- **The tenant-isolation convention survives its first designed exception.** The
  exception is one table, crossed in one direction (values out, never identities), with
  the boundary enforced by what the queries are able to select rather than by reviewer
  vigilance. Any future cross-tenant feature inherits this shape: a dedicated table, a
  choke-point view, enforcement-only identity columns.
- **This is aggregation + min-n, not differential privacy — stated, not discovered.** A
  determined contributor watching a small cell before and after another tenant
  contributes can bound the newcomer's value; `assetClass` and `region` are
  self-declared, so a contributor also chooses how identifying its cell is. k = 5 is a
  floor that defeats casual inference, not a formal privacy guarantee. Recorded as gap 21
  in `docs/security.md` §8.2; noise injection or coarser cells are the upgrade path if
  the population ever makes the attack practical.
- **Until tenants contribute, the product is honest about being empty.** The seed
  distributions make the machinery demonstrable and the health warning makes them
  unquotable as evidence. The first real contribution suppresses rather than reveals
  (n = 1 < 5) — which looks anticlimactic and is correct: the module refuses to be a
  mirror. Genuine benchmarks arrive with population, not with code, exactly as every
  roadmap revision said.
- **Contribute-to-access cuts both ways.** It solves the free-rider problem and creates
  an incentive to contribute one throwaway number for read access. The admin gate, the
  computed-not-typed rule and per-sample methodology disclosure raise the cost of a junk
  contribution; they do not eliminate it. If junk becomes a real problem, the next
  instrument is contribution review or weighting by evidenced inputs — not loosening the
  boundary.
- **A tempting shortcut is explicitly forbidden**: returning contributor identity to
  "trusted" callers (an admin console, a support tool, an export) would convert the
  anonymization boundary from a structural property into an access-control policy — one
  misconfigured role away from a breach. If an operational need ever genuinely requires
  knowing who contributed a sample, it must be met in the database by an operator, on the
  record, and never through this module's API.
