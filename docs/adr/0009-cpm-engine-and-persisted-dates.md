# ADR 0009 — Pure CPM engine with persisted computed dates

**Status:** accepted (implemented in `apps/api/src/lib/cpm.ts` + `cpm.test.ts`, consumed
by `apps/api/src/modules/schedule/index.ts` and `modules/forensics/tia.ts`)

## Context

Phase 3 needed a schedule core (spec Vol I §2.6 subset) for one dominating reason: the
delay-forensics module (Domain D / M9) has nothing to analyse without a programme. That
consumer shapes the requirements differently from a generic Gantt feature:

1. **Forensic reproducibility.** A Time Impact Analysis result (#272) may be cited in a
   dispute years later. The number it produced must be re-derivable from the inputs that
   were on record when it ran — which means the computation must be a deterministic
   function of explicit inputs, with no hidden state, clock reads, or database coupling.
2. **Testability at the arithmetic level.** CPM has textbook answers. A wrong early-start
   is the scheduling equivalent of a wrong time-bar date (ADR 0007's argument): incorrect
   output delivered with the platform's authority. The engine must be assertable against
   hand-computed networks, including the awkward cases — SS/FF/SF with negative lags,
   zero-duration milestones, `must_start_on` producing negative float, actuals overriding
   durations.
3. **Read-heavy usage.** Task lists, the Gantt, lookahead, baseline comparison,
   as-planned-vs-as-built and windows analysis all *read* dates. Mutations (task edits,
   dependency changes) are comparatively rare.

Two architectures were on the table: compute dates on demand at read time (always fresh,
nothing stored), or compute on write and persist the results.

## Decision

**The engine is a pure function; its output is persisted; recomputation happens on
write.**

1. `computeCpm(tasks, deps, {projectStart})` in `apps/api/src/lib/cpm.ts` performs no
   I/O. Time is whole days from `projectStart`; internally a task occupies
   `[start, start + d)` — the **exclusive finish keeps dependency math uniform**
   (FS: `succ.ES = pred.EF + lag`) — while the reported `finishDate` is the inclusive
   last day of work (equal to `startDate` for milestones). Constraints
   (`start_no_earlier_than`, `must_start_on`, `finish_no_later_than`) and actuals
   (`actualStart` pins ES; `actualFinish` pins EF and overrides duration) are engine
   inputs, not module logic. Negative float is a **reported signal, not an error** — a
   breached constraint should be visible, not rejected. Dependency cycles abort the pass
   and report the member ids (feeding the DCMA-style checks and the API's 409s).
2. `recomputeSchedule` (`modules/schedule/index.ts`) is the **single recompute code
   path**: it runs the engine and persists per-task
   `startDate`/`finishDate`/`totalFloat`/`isCritical` and the schedule header's
   `computedFinish`/`computedDurationDays`/`lastComputedAt`
   (`packages/db/src/schema/schedule.ts`). Every task/dependency mutation calls it; an
   explicit `POST …/compute` exposes it directly. Persisted dates are therefore never
   stale by construction — there is no code path that writes schedule inputs without
   recomputing.
3. Dependency creation runs the engine over existing + candidate **before** inserting, so
   a cycle-producing link is rejected (409, naming the cycle) rather than persisted.
4. Baselines (`scheduleBaselines`) snapshot the persisted computed dates after a forced
   recompute — the immutable as-planned record (#355) that forensic comparison reads.

## Consequences

- **Reads are free and forensically stable.** Lists, the Gantt and every forensic
  comparison read stored columns. A baseline snapshot, an as-planned-vs-as-built row and
  a windows bucket all refer to dates that *were actually persisted*, not dates
  recomputed under a possibly-newer engine at read time — the record the analysis cites
  is the record on disk, and every change to the inputs that produced it is in the
  ledger.
- **TIA is reproducible and cheap.** `runFragnetTia` (`modules/forensics/tia.ts`) calls
  the pure engine twice (before/after fragnet insertion) on in-memory inputs. The
  persisted `tiaResult` plus the ledgered payload make the run auditable; purity makes it
  re-runnable. The same property is what makes Monte Carlo QSRA (spec H#457, module M13)
  a natural next consumer — thousands of engine runs over sampled durations with no
  database in the loop.
- **Unit tests pin the arithmetic** (`lib/cpm.test.ts`): hand-computed FS chains with
  parallel branches, SS/FF with lags, leads, milestones, constraint-induced negative
  float, actuals pinning the forward pass, cycle reporting, and the fragnet-delay
  primitive itself.
- **Trade-off accepted: recompute-on-write.** Every task/dependency mutation pays a full
  CPM pass plus row updates (diffed — unchanged rows are not rewritten). At the §2.6
  subset's scale (single-project schedules, thousands of tasks at most) this is
  milliseconds; the write path is also where the ledger append already lives, so the
  cost lands where the consequence is. If schedules grow to the point where a full pass
  per keystroke hurts, the escape hatches are incremental recompute (the topology is
  already explicit) or batched mutation endpoints — not a switch to compute-on-read,
  which would surrender the reproducibility property the forensics module exists for.
- **Trade-off accepted: two representations of "finish".** The exclusive/inclusive
  convention (internal vs reported) is a standing trap for contributors; it is documented
  in the engine header, in `docs/architecture.md` §12, and enforced by the milestone
  tests. The alternative — inclusive finishes everywhere — makes every dependency formula
  carry ±1 corrections, which is where real schedulers' bugs live.
- **Honest limits.** Durations are *calendar* days: there are no working calendars,
  holidays, or resource levelling (Vol I #370). Calendar arithmetic belongs inside the
  engine when it lands, keeping purity intact. The persisted-dates contract also means
  any future out-of-band write to schedule inputs (bulk import, direct SQL) must call
  the recompute path or stored dates will lie — acceptable while the module owns all
  writes, and the reason `lastComputedAt` is stored and surfaced.
