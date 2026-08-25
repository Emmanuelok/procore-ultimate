# ADR 0018 — Webhooks off the ledger, and machine callers through the same gates

**Status:** accepted (implemented in `apps/api/src/modules/integrations/`, with the emit hook
in `apps/api/src/lib/ledger.ts` and machine-caller resolution in `apps/api/src/plugins/auth.ts`;
delivers Vol I §0.7 #120–121 and completes the Procore/Aconex transports scaffolded by ADR 0015)

## Context

Two integration questions had been deferred through six phases, and both had an obvious wrong
answer that most platforms ship.

**What does a webhook subscribe to?** The usual answer is an event taxonomy: a hand-maintained
list of event names, emitted by hand-placed calls at the points someone remembered. That list
drifts from the truth immediately and silently — a module added later emits nothing, a route
refactored loses its emit call, and no test fails because the taxonomy is the only thing that
says the event should exist. Subscribers then believe they are seeing everything.

ConstructOS had an unusual asset here. ADR 0003 made every consequential mutation append to a
hash-chained ledger, and five phases of module discipline had kept that true. The ledger is
therefore not a log *of* the events — it is already the complete, enforced enumeration of them.

**How does a machine caller get permissions?** The usual answer is a parallel path: API keys
with their own scope model, checked by their own middleware, next to the human permission
system. Two authorization systems for one set of records is a standing invitation for them to
disagree, and the disagreement is always discovered as a leak. The platform already had a
per-tool RBAC model with levels, templates, overrides and segregated assurance roles; a second
one would be a liability, not a feature.

There was also an unglamorous third question. ADR 0015 shipped Procore and Aconex transports as
honest 501s pending credentials. That was correct at the time, but it left "the code is not the
blocker" as an assertion rather than a demonstrated fact.

## Decision

**Webhooks subscribe to the ledger append path, and machine callers resolve through the same
permission checks as humans.**

The emit hook fires *after* the ledger transaction commits and is awaited, so an event is never
lost to a dropped promise and emission is deterministic under test. It swallows every throw:
`appendLedger`'s contract is that it never fails a business transaction, and a webhook
subscriber must never be able to break a valuation. Emitter failures are recorded on health
counters rather than propagated. The event catalogue is *derived* from the tenant's own ledger
entries, so it cannot drift from what the platform actually does — with the honest consequence,
stated on the response, that a kind the tenant has never produced does not appear.

The delivery envelope carries **identity and hashes, not the ledger payload**. A payload is
frequently unstored and can hold sensitive state; shipping it to an operator-nominated URL
would make every subscription a data export. `payloadHash` lets a receiver verify a record it
subsequently fetches through the authenticated API — which is the same trust move the rest of
the platform makes.

Signatures are HMAC-SHA256 over `v1:{timestamp}:{deliveryId}:{rawBody}` with the **delivery id
bound in**, so a body captured from one delivery cannot be replayed as another. Retries re-send
identical bytes and an identical signature — the timestamp comes from the envelope, not the
attempt — so receivers must dedupe on the delivery id, and that is published as the contract
rather than left to be discovered.

For machine callers, an OAuth2 client-credentials token resolves to a caller whose permissions
are its scopes, and those scopes are then checked by `requireTool` — the same function, not a
parallel one. A client can never hold more than its creator held.

## Consequences

Building this surfaced a privilege escalation that the parallel-path design would have hidden.
Admitting a machine caller means setting `req.companyId`, and that alone would have admitted
*any* client to every route gated only by `authenticate + requireCompany` — company-wide reads
of projects, ingestion sources and notifications, regardless of the client's scopes. The fix
follows from the decision above: machine callers are admitted **only** to routes carrying a
`requireTool` gate, and everything else refuses them. Reusing the human authorization path is
what made the hole visible; a second scope checker would simply have been correct about its own
scopes while the first route class leaked.

The scope ceiling bites in a place worth noting: since clients are created by owners and admins,
who bypass tool checks, the ceiling only constrains where company role does not confer access —
`assurance`. An owner without a live assurance grant cannot mint a client that reads assurance
records. That is the segregation of ADR 0004 surviving contact with automation.

Known costs, admitted rather than discovered later — both are in `docs/security.md` §8.2 as
gaps 22 and 23:

- **Secret custody defaults to shared.** Webhook signing secrets are HKDF-derived from
  `WEBHOOK_SIGNING_KEY` and fall back to `AUTH_SECRET`. Under the fallback, anyone who can read
  the application's JWT secret can forge a signature the receiver would accept. Every read
  reports `keySource` with `sharedCustody: true` and the note, so an operator is told rather
  than left to assume. Rotating the master key invalidates derived secrets, and
  `secretFingerprintMatches` going false is how they find out.
- **Outbound webhooks are an egress path.** A delivery leaves the tenant boundary for an
  operator-nominated URL, and endpoint URLs are not allowlisted. A company admin can therefore
  authorise what is effectively an exfiltration channel. Per-company scoping, signing, delivery
  logging and auto-disable after consecutive failures limit the blast radius; they do not close
  the class.
- **Dispatch is an in-process timer, not a broker.** The alternative — draining the queue when
  someone opens the deliveries page — was rejected because the operators who most need retries
  are the ones not watching. The cost is that with N replicas the drain runs N times and the
  re-entrancy guard is per-process, so a receiver can see a delivery twice. That is why dedupe
  is the published contract; `SELECT … FOR UPDATE SKIP LOCKED` is the upgrade path and does not
  change the wire format.
- **The connectors are fixture-proven, not vendor-proven.** Token exchange, page-walking,
  termination, error propagation and every mapping function are tested — but the fixtures were
  *authored from published API shapes, not captured from real traffic*, and this deployment has
  no route to either vendor. Aconex in particular renders XML search envelopes to JSON
  differently across versions, so the extractor deliberately accepts several documented shapes
  rather than claiming certainty. The honest expectation is that the first live pull adjusts
  field names, not architecture — and unconfigured, the 501 still names the exact environment
  variables an operator needs.

**The forbidden shortcut:** never let a machine caller take a permission path a human does not
take, and never emit events from anywhere but the ledger append path. The first splits
authorization in two and guarantees they will diverge; the second reintroduces the drifting
taxonomy this ADR exists to avoid.
