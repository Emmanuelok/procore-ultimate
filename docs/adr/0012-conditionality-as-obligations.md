# ADR 0012 — Conditions and timetables materialize as assurance Obligations

**Status:** accepted (implemented in `apps/api/src/modules/finance/`,
`modules/governance/`, `modules/disputes/`; pattern established by `modules/contracts/`
and `modules/payments/`)

## Context

Phase 4 added three new families of dated commitments, each with real consequences when
missed:

- **Lender conditions** (Domain O #730–731): conditions precedent block disbursement;
  an unsatisfied condition subsequent is an event-of-default risk under the facility
  agreement.
- **Gate conditions of approval** (Domain G #413): a "proceed with conditions" decision is
  only as good as the tracking of those conditions to closure.
- **Dispute procedural timetables** (Domain E #330, #338): a missed referral or submission
  deadline in adjudication or arbitration can be fatal to the case.

Each could have carried its own deadline field, its own "overdue" query and its own
warning logic inside its own module. Two platform facts argued against that. First, the
spec's own primitive definition (Vol III §4): *"Time bars are `Obligation` records with a
computed deadline"* — the obligation is the platform's one deadline primitive, with
`deadline`, `warnDaysBefore`, an evidence requirement and a lifecycle
(`open → satisfied | breached | waived`). Second, two phases of precedent: M8 materializes
contract time bars and standing duties into `obligations` at event/contract creation
(spec C#260, ADR 0007 era), and M10 materializes statutory payment-response deadlines the
same way (ADR 0010). Both proved the shape: the domain table stores an `obligationId`, the
domain clock and the obligation register agree on one date by construction, and
`GET /obligations/upcoming` is a single cross-domain deadline radar.

## Decision

**Every dated condition or timetable step in M12/M14/M15 materializes as an assurance
`obligations` row at creation, and the domain record stores the `obligationId`.** The
register *is* the assurance table, not a mirror of it.

Concretely:

- `facility_conditions.obligationId` (`modules/finance/index.ts`, condition-create route):
  source clause = facility name + condition kind, deadline from `dueDate`,
  `warnDaysBefore: 7`, evidence requirement stated.
- `gateReviews.conditions[].obligationId` (`modules/governance/index.ts`, review-create
  route): source clause = gate number + name, trigger = the condition text,
  `warnDaysBefore: 7`.
- `disputes.timetable[].obligationId` (`modules/disputes/index.ts`,
  `materializeStepObligation`): source clause = dispute kind + step name,
  `warnDaysBefore: 3` — dispute clocks are short. Timetable edits keep the obligation in
  step: a step that gains a deadline materializes one, a moved deadline updates the open
  obligation, a removed deadline or dropped step waives it.

The lifecycle rules are the ones M8/M10 established, applied uniformly:

1. **Satisfy only what is open.** Closing a gate condition, satisfying a facility
   condition (which requires evidence ids — #731), or completing a timetable step flips
   the obligation to `satisfied` **only where its status is still `open`**.
2. **Breach by lazy sweep, exactly once.** `sweepOverdueConditions` (finance) and
   `sweepMissedDeadlines` (disputes) run on reads — the payments-module pattern — flipping
   overdue items, breaching the linked obligation and raising a signal
   (`facility_condition_overdue`, `dispute_deadline_missed`), guarded so each fires once.
3. **A breached obligation stays breached.** Late satisfaction of a facility condition
   unblocks the disbursement pipeline but does not rewrite the register; only an explicit
   lender **waiver** (finance `admin` level, reason required, ledgered) supersedes a
   breach. The register records what happened, not what the operator wishes had happened.

## Consequences

- **One deadline-discipline primitive across the platform.** The same `obligations` table
  now carries contract time bars (M8), statutory payment-response deadlines (M10), lender
  conditions precedent/subsequent (M14), gate conditions of approval (M12) and dispute
  timetable steps (M15). One upcoming-deadlines radar, one early-warning mechanism
  (`warnDaysBefore`), one breach vocabulary — and every future dated duty (retention
  release deadlines F#383, MIDP milestones, safeguard commitments) has an obvious home.
- **The assurance layer sees every commitment without integration work.** An auditor
  granted assurance access reads one register and gets the project's full deadline
  exposure across commercial, statutory, financing, governance and dispute domains —
  exactly the owner-side visibility the Vol III thesis sells.
- **Breaches are signals, so they enter the disposition workflow.** A missed condition or
  timetable deadline surfaces as a `signals` row with severity and an explanation, and
  only an `integrity_reviewer` can disposition it (`docs/security.md` §2.4) — deadline
  failures cannot be quietly tidied away by the team that missed them.
- **Cost accepted: the obligation register is denormalized into three jsonb-adjacent
  homes.** The `obligationId` back-references live on domain rows (and, for gates and
  disputes, inside jsonb arrays), so referential integrity is by convention, like every
  other relationship in the schema (`docs/data-model.md`, Conventions). The uniform
  lifecycle rules above are what keep the two views consistent; they are enforced in code
  and covered by the module test suites.
- **Boundary stated plainly**: covenant breaches (M14) are deliberately **not**
  obligations — a covenant is a continuous test, not a dated duty, so a breach raises a
  critical `covenant_breach` signal directly from the reading (`modules/finance/index.ts`)
  with no obligation row. The primitive is for deadlines; stretching it to continuous
  conditions would blur what "satisfied" means.
