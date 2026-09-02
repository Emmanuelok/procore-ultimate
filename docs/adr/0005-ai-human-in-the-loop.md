# ADR 0005 — AI proposes, humans dispose: review queue, citations, audit trail

**Status:** accepted (implemented)

## Context

Spec Domain X requires citations on every AI assertion (#1019), a human-in-the-loop review
queue for consequential outputs (#1020) and a model audit trail with input provenance
(#1021). On a platform whose product is the trustworthiness of its record, an agent that
silently mutates operational data would poison the evidentiary chain: a ledger entry must
name an accountable human actor. The AI dependency is also optional infrastructure — the
platform must be fully functional without it.

## Decision

All in `apps/api/src/modules/ai/` over `packages/db/src/schema/ai.ts`:

- **No autonomous mutation.** Agents write proposals into `ai_review_queue`
  (`pending | approved | rejected | superseded`); operational tables are untouched until a
  human approves.
- **Approval re-runs the target tool's permission gate** against the reviewer
  (`gateReviewer` invokes `requireTool(targetTool, "standard")`): approving an AI-drafted
  daily log requires exactly the permission needed to write one by hand. Guests cannot
  review. The applied change then flows through the normal `appendLedger` path with the
  human as actor.
- **Every invocation is audited**, including failures and refusals: `ai_runs` records agent
  kind, model, requester, input record references (provenance), prompt, raw + structured
  output, **citations**, token counts, latency and status `succeeded | failed | refused`.
  Upstream problems map to typed errors (`AiUpstreamError`, `AiParseError`, `AiRefused` —
  `service.ts`), never silent retries.
- **Deterministic disabled mode:** without `ANTHROPIC_API_KEY`, every AI route returns
  `503` with error name `AiDisabled` ("Set ANTHROPIC_API_KEY to enable AI features"). The
  behaviour is tested (`ai.test.ts`), and pure helpers are unit-testable without network.

## Consequences

- AI output can never appear in the operational record without a named, permissioned human
  in the ledger between proposal and effect — the audit question "who let this in?" always
  has an answer.
- Latency and friction are accepted costs: even low-risk agent output (e.g. sheet-name
  suggestions) rides the queue when it would mutate a record. If that binds, the escape
  hatch is per-agent authorisation limits (spec X#1022), not removal of the queue.
- The review queue's `superseded` state handles the re-run-before-review race; queue
  hygiene (stale pending items) is an operational concern, surfaced in the UI.
- Provider coupling is confined to `service.ts` behind the Anthropic SDK; the queue/audit
  contract is provider-agnostic.
