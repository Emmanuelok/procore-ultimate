# ADR 0015 — Staged-commit ingestion with hash-at-ingest provenance

**Status:** accepted (implemented in `apps/api/src/modules/ingestion/` with the pure
registry in `modules/ingestion/datasets.ts`; delivers the pathway half of the separation
ADR 0004 enforced at actor level and ADR 0014 raised to a design law)

## Context

Every phase before this one ended with the same sentence: the platform has more machinery
than input. Five phases of engines — reconciliation, forensics, statutory clocks,
conditionality gates, a ghost-worker detector — and every record feeding them arrived
through ConstructOS's own API, authored by a logged-in user of the tenant being examined.
ADR 0014 stated the consequence plainly: a two-stream reconciliation is only as good as
the separation of its ingest paths, and until M6, both streams shared one.

Building M6 forced three questions that a naive "import feature" never asks.

First, **what does an imported row prove?** A migration is not neutral: it is the moment
the platform inherits someone else's history, including its errors, its duplicates and —
on an adversarial reading — its fabrications. If imported rows appear in real tables with
no trace of how they got there, the evidentiary story of every downstream engine is
poisoned at the source. The spec's answer is S#862, hash-at-ingest: what arrived must be
fixed cryptographically at the moment of arrival, before anyone had a reason to alter it.

Second, **who is the author of a machine's records?** The turnstile vendor pushing
site-access records has no user account and must not need one — giving the employer's
administrator a login to post the evidence stream is precisely the failure mode ADR 0014
documents. But every table on the platform attributes writes to a user, and the ledger
expects an actor. A machine pathway that quietly borrows a human identity would make the
independent stream *look* operator-authored — the opposite of what the pathway exists to
prove.

Third, **what happens to the rows that fail?** A migration wizard that silently drops
bad rows converts an import into an assertion ("this is what the file said") that cannot
be checked. The rejected rows are part of what the file actually contained.

The tempting design was the obvious one: parse the file, insert what parses, report a
count. It was rejected because every one of the three questions above is unanswerable in
that shape.

## Decision

**Nothing external writes a real record directly. Everything that enters the platform
from outside — CSV upload, connector pull, machine push — lands in a staging area, is
validated against a code-resident dataset registry, and reaches a real table only through
an explicit, transactional, ledgered commit that preserves provenance in both directions.
The raw input is hashed at ingest. Machine pushes are authored by the token, not by a
person.**

Concretely, as implemented:

1. **Hash-at-ingest** (S#862). The uploaded file is retained content-addressed through
   the normal storage service and its sha256 lands on the run (`ingestion_runs.fileSha256`)
   and in every ledger entry about that run — creation and commit alike. The hash an
   auditor recomputes from the retained file must match the hash in the chain, years
   later.
2. **A registry, not a guess** (`DATASET_REGISTRY`, one entry per member of the 8
   `INGESTION_DATASETS`). The registry is the single authority the mapping UI, the
   validator and the push endpoint all read: fields, types, required flags, enum
   vocabularies, cross-field checks (payroll's net = gross − deductions to ±0.01;
   site-access hours within 0–24; FX rates positive with distinct currency codes) and a
   prose statement of where committed rows land. A field not in the registry cannot be
   mapped, staged or committed.
3. **Validation rejects rows and keeps them.** Failing rows become `rejected` with every
   reason recorded verbatim; clean rows keep `staged` with their payload replaced by the
   typed coercion. The run reports both. `externalId`s are deduped within the run and
   against rows already committed for the dataset — and a re-presented batch raises an
   `ingestion_duplicate_replay` signal, because a replayed export can be a double
   migration or an attempt to rewrite history through the import pathway, and either way
   a reviewer should look.
4. **Commit is explicit, transactional, and linked both ways.** One transaction writes
   the real records, stamps each staged row with the id of the record it became
   (`committedRecordId`), and finalizes the run's counts; a failure marks the run
   `failed` with nothing half-committed. Assertions and evidence carry
   `sourceType: "ingestion_run"` back-links; committed evidence is content-hashed over
   its typed payload. Dataset semantics are inherited, not reinvented: RFIs take real
   per-project numbers, `schedule_tasks` refuses a project with no active schedule,
   site-access rows upsert on `(workerId, accessDate)` exactly as the workforce module
   does, and rows referencing unknown workers are **skipped with a per-row reason**, never
   used to invent a worker.
5. **The machine inlet authenticates the pathway, not a person.**
   `POST /ingestion/push/:dataset` takes a `cok_…` bearer token — stored only as its
   SHA-256, shown once at creation, scoped to named datasets and to nothing else on the
   platform, revocable immediately. A push runs the same stage → validate → commit
   pipeline on an implicit run whose `startedBy` is the **token id**, ledgered with
   `actorId: null` and the token identified in the payload. Payroll filed by a user
   session and site access pushed by a token are distinguishable in the record forever —
   the pathway-level separation the spec's §4 design rule demands and ADR 0004 could not
   yet enforce.
6. **Scaffolding is labelled scaffolding.** The Procore/Aconex connectors exist as typed
   shells with fixture-tested pure mapping functions and an injectable HTTP client — and
   the pull route returns **501** naming the exact credentials and configuration a real
   pull needs, because this deployment has neither a network route to the vendors nor
   credentials for them. Source `config` refuses credential-shaped keys outright; secrets
   live in env or in `api_tokens`, never in a source row.

## Consequences

- **The pathway ADR 0014 was waiting for now exists — and its limits transfer to
  deployment.** The platform can no longer be accused of making pathway separation
  structurally impossible; it can still not prove who holds a token. A site-access token
  handed to the employer's own administrator reproduces the shared-pathway condition
  exactly, and the user-facing bulk routes remain open. What changed is that independence
  went from unavailable to available; attestation of the pushing system is the next
  layer (`docs/security.md` §8.2 gap 17), and per-run token provenance is where it will
  attach.
- **Migration inherits history without laundering it.** Rejected and skipped rows persist
  with verbatim reasons; the retained file and its hash mean "what the file actually
  said" is checkable forever; the duplicate-replay signal makes a re-presented batch a
  finding rather than a silent upsert. The cost is real: staging doubles the write volume
  of an import and the wizard has more steps than a one-click upload. That cost is the
  product.
- **Committed rows are only as true as their source.** Hash-at-ingest fixes *what
  arrived*, not whether it was honest when it left the source system. A fabricated
  turnstile export, faithfully hashed and committed, is still fabricated — detecting that
  is the reconciliation engine's job, and the reason imported cost claims land as
  `assertions` (claims to be tested), not as facts.
- **The connectors are a promise with a receipt.** Returning 501 with named requirements
  is a deliberate alternative to two dishonest options: pretending a pull works, or
  hiding that the mapping layer exists. When credentials and a network route exist, the
  transport slots into tested mapping code. Until then, every response says exactly what
  is missing — and the roadmap sequences a real feed, not more module code, as the next
  step.
- **A tempting shortcut is explicitly forbidden**: a "fast path" that inserts external
  rows directly into real tables — for performance, for a demo, for a trusted partner —
  would bypass staging, provenance and the ledger at once. If a future dataset cannot
  afford the staged pipeline, the answer is to fix the pipeline, not to route around it.
