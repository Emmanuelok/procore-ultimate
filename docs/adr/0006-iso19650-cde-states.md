# ADR 0006 — ISO 19650 CDE states and suitability codes on model versions

**Status:** accepted (implemented for BIM model versions)

## Context

The platform's buyers include owners, funders and public clients operating under ISO 19650
(UK BIM mandate, increasingly the Gulf, EU and Commonwealth procurement). Spec Domain L
#639–640 requires Common Data Environment state management and suitability code enforcement;
delivery milestones (#632, #635) are defined *in terms of* those states. A folder-based
"current set" convention cannot express "this container is Shared for coordination at S1 but
not Published" — and an assurance platform needs state transitions to be governed events,
not renames.

## Decision

- Every BIM model version carries `cdeState` (`wip | shared | published | archived`) and a
  `suitability` code (`S0–S4, A1, B1, CR`) — columns on `bim_model_versions`
  (`packages/db/src/schema/bim.ts`), enums in `packages/shared/src/enums.ts` as the single
  source of truth.
- Transitions go through one route, `PATCH /bim/versions/:versionId/state`
  (`apps/api/src/modules/bim/index.ts`), which enforces a legal-transition map
  (wip → shared → published → archived, re-share from shared allowed) and rejects
  suitability codes incoherent with the target state (e.g. `A1` only when published).
  Every transition is a ledgered `state_change` with full from/to payload.
- Information delivery milestones (`delivery_milestones`, `packages/db/src/schema/twin.ts`)
  express their requirement as `requiredState` + `requiredSuitability` — MIDP/TIDP tracking
  keyed to the same vocabulary.

## Consequences

- Handover and audit questions ("was this model Published at A1 when the certificate was
  signed?") are answerable from the ledger, not from folder archaeology.
- The state machine is deliberately a subset: the suitability list is the common core
  (`SUITABILITY_CODES` is documented as extensible per tenant); workflow-gated transitions
  (approval before Published) are not yet wired — the workflow engine exists and can be
  attached without schema change.
- Honest limit: CDE states currently govern **BIM model versions only**. Drawings and
  documents use their own revision/current-set and folder models; extending CDE states
  across all information containers is future work and will reuse these enums rather than
  invent parallel ones.
- Cost accepted: teams that just want to "upload the new model" meet a state machine. The
  default (`wip`/`S0`) keeps the low-friction path open while making promotion explicit.
