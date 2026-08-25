# ADR 0017 — Ledger anchoring, sealing and third-party escrow

**Status:** accepted (implemented in `packages/ledger/src/seal.ts` as the pure core, with
custody, providers and routes in `apps/api/src/modules/anchoring/`; closes the second of
the two structural holes named in `docs/roadmap.md` and narrows `docs/security.md` §8.2
gaps 2–3)

## Context

ADR 0003 committed the platform to a hash-chained evidence ledger: every consequential
mutation appends an entry whose hash covers the previous entry's hash, so altering a
historical record breaks every hash after it. For four phases that claim was repeated in
every document this project produced, and for four phases it was **narrower than it
sounded**.

A hash chain is tamper-evident against *edits*. It is evident against nothing else. Two
attacks are available to whoever controls the database, and neither leaves a trace the
chain itself can show:

**Tail truncation.** Delete the last N entries. The remaining chain verifies perfectly —
every hash still covers its predecessor, genesis to head, with no gap and no contradiction.
Nothing inside a chain records how long it is supposed to be. The most incriminating
window of a project's history is also the cheapest to remove, and `/ledger/verify` would
have returned `valid: true` on the remainder.

**Wholesale rewrite.** Recompute the entire chain from genesis with whatever history the
operator prefers. Internal consistency is a property anyone with write access can
manufacture, because the chain is self-referential: it proves its entries are consistent
*with each other*, not that they are the entries that were originally written.

Both attacks share a root cause. Verification asked the database to attest to itself.
Every input to the check — entries, hashes, ordering — came from the same store the
attacker controls, so a sufficiently thorough attacker controls the verdict. Add to this
that `at` on every entry is the application server's own clock, which the operator also
sets, and the honest summary of the pre-Phase-7 position was: *the ledger detects careless
tampering and a database administrator's mistake; it does not detect a determined insider,
and it cannot prove anything to a third party who does not already trust the operator.*

This mattered beyond tidiness. The Tier-3 acceptance criterion is a dispute bundle a
receiving party can verify. The spec's §7 retrospective detection run is meant to be
published. Both rest on a chain whose integrity is asserted by the party with the most to
gain from asserting it — which is not evidence, it is a claim about evidence.

## Decision

**Periodically seal the chain head with a signature the database cannot produce, chain the
seals to each other, and hand seals to third parties.**

A **seal** is a signed commitment to the whole state of one company's chain at a moment:

- `entryCount` — how many entries exist. This single field converts truncation from an
  undetectable deletion into an arithmetic contradiction.
- `merkleRoot` over every entry hash — a rewrite of any entry, anywhere in history,
  changes the root.
- `headHash`, the sealed range, and `prevSealHash` — the hash of the previous seal's
  canonical body, so seals form their own chain and one cannot be quietly removed either.
- An **Ed25519 signature** over the canonical seal body, made with a key whose private
  half never enters the database.

The last point is the whole design. Everything else is arithmetic that an attacker with
write access could recompute; the signature is the one input they cannot manufacture from
inside the store they control. `signing_keys` holds the **public** half and a fingerprint,
guarded by an assertion that runs on every write; the private half lives only in
`ANCHOR_SIGNING_KEY`.

Three further decisions follow from taking the threat seriously rather than performing it:

**Heartbeat seals.** Seals are written on a schedule even when nothing has been appended.
Without this, a quiet period is indistinguishable from a truncated one, and an attacker's
best move is simply to wait for the next seal to be far away. A heartbeat bounds the window
in which a truncation can hide to the heartbeat interval.

**Verdicts, not booleans.** `classifyChain` returns which of six states holds — `intact`,
`tail_truncated`, `entry_altered`, `seal_forged`, `seal_broken`, `no_seals` — and names the
exact seal or entry sequence at which it failed. "Something is wrong" is not actionable;
"seal 4 committed to 1,203 entries and 1,180 exist" is. Where the Merkle root diverges, the
classifier distinguishes a prefix that was **cut and refilled** from a **wholesale rewrite**
by checking whether the entry now occupying the sealed head position carries the sequence
the seal recorded — a distinction that matters because the two imply different attackers.

**Escrow.** A seal that only the operator holds still asks a third party to trust the
operator. An escrow receipt is self-contained — seal body, signature, public key,
fingerprint and the verification procedure in words — and is issued to a named recipient,
who can later present it back to prove the chain they were shown is the chain that exists.
A standalone CLI (`pnpm --filter @constructos/api verify:receipt`) verifies a receipt with
no access to this platform at all, because a verification tool the operator hosts is a
verification tool the operator controls.

## Consequences

The two attacks are closed and **tested against real corrupted database state**, not mocks:
truncating the tail, altering a historical entry, forging a signature and removing a middle
seal each produce their specific verdict with the offending sequence named.

What this buys is bounded, and the boundaries are carried **in the API responses, not only
in this document** — a limitation stated in an ADR nobody reads is a limitation concealed:

- **The derived key is the weak case, and it is the local default.** With
  `ANCHOR_SIGNING_KEY` unset outside production, the key is HKDF-derived from
  `AUTH_SECRET`. That key is held by the same operator who runs the application, so seals
  made under it prove integrity **against a database-only attacker** and **not against the
  operator**, who can re-derive it and re-sign a rewritten chain. Every key record, seal,
  verdict, anchor proof and receipt carries `derivedFromAuthSecret: true` with a
  plain-English note, receipts list it under what they do *not* prove, and key ids are
  prefixed `ankd_` rather than `ank_` so a seal made months ago still reports the weakening
  that applied when it was made. In production, sealing without a real key returns 503
  naming the command to generate one.
- **Time is still self-asserted.** `sealedAt` is the application server's clock. Seals prove
  **order**, not wall-clock time. The RFC 3161 and OpenTimestamps providers carry real wire
  implementations behind an injected client, but with no endpoint configured they record
  `unavailable` naming the exact missing variable rather than fabricating a proof, and a
  successful OpenTimestamps submission records `pending` — a calendar receipt is not yet a
  Bitcoin attestation. §8.2 gap 3 is therefore **narrowed, not closed**: the mechanism is
  built and tested, and what remains is configuration.
- **A receipt carrying its own key proves internal consistency only.** Verification returns
  `signatureValid` separately from `key.recognized`, because a forged receipt signed with an
  attacker's own key is fully self-consistent and is caught only by comparing the fingerprint
  against the key register — or, better, out of band. Collapsing the two into one pass/fail
  would hide exactly the case that matters.
- **A seal covers integrity, not accuracy.** Nothing here says a record was true when it was
  written. The platform's answer to that question is reconciliation against independent
  evidence (ADR 0004, ADR 0014); sealing only guarantees that what you are reconciling is
  what was recorded.
- **Verification is not free of side effects, deliberately.** `chain-verdict` does *not*
  append an access entry, unlike the assurance module's verify endpoint: an endpoint that
  grows the chain in proportion to how closely it is watched would defeat the heartbeat's
  own "nothing changed" test. Escrow *presentation* is ledgered instead, because that is a
  consequential act by an identified party.

**The forbidden shortcut:** never make sealing depend on a key the application database can
reach, and never let a verification path answer from data the party under examination
supplied. Both would restore the self-attestation this ADR exists to end — the first by
handing the attacker the signature, the second by handing them the verdict.

## Amendment — the first implementation broke its own rule

An adversarial pass against a real Postgres, mutating rows behind the running server,
defeated the design as first built. The attack is worth recording in full because the flaw
was in exactly the place this ADR claimed to be careful about.

The private half of the signing key was outside the database, as designed. **The public half
was not.** Signature checking merged every row of `signing_keys` into its trusted key set —
a table inside the database the seal exists to police. So an attacker with database write
access and nothing else could: rewrite the chain from genesis so it was internally perfect,
generate their own Ed25519 key, `INSERT` its public half under a fresh key id, and re-sign
every seal. The observed verdict was `intact`, `signaturesChecked: 3`, `unknownKeyIds: []`.

It was worse than silent. Because the attacker chose their own key id and no rule reserved
the environment-key prefix, the forged chain reported a *stronger* guarantee than the honest
one — `weakening: null` where the legitimate derived key would have carried its warning.

This is the second half of the forbidden shortcut above, committed by the ADR's own author:
the verification path was answering from data the party under examination supplied. A
signature is only as good as the verifier's prior knowledge of which public key to expect,
and that knowledge was being fetched from the store under attack.

**The fix is to move the trust anchor out of reach of the database.**
`ANCHOR_TRUSTED_FINGERPRINTS` pins the acceptable public-key fingerprints in the
environment. Pinned, a key registered in `signing_keys` is unusable unless the operator
vouched for its fingerprint out of band, and a seal signed under anything else is reported
as `seal_forged` rather than as merely uncheckable — because under a pin those are different
claims. The process's own key is subject to the same pin, so an operator who pins and then
runs with a key outside the set is refused at seal time rather than quietly minting seals no
verifier will accept.

**Unpinned behaviour is deliberately unchanged, and now says so.** From inside the database,
an attacker-registered key and a legitimate rotation are indistinguishable — `retired_at` is
attacker-controlled too — so treating an unknown key as a forgery without a pin would break
the module's promise that rotation does not invalidate earlier seals. Instead every verdict
carries a `trustAnchor` block, and when unpinned, a limitation naming this exact attack and
its remedy.

The claim this ADR may make is therefore bounded, and the bound is now the first thing a
verdict states: **sealing defeats a database-only attacker who does not also register a key;
pinning the fingerprints out of band removes that qualifier.** Three tests reproduce the
exploit end to end — unpinned it verifies, pinned it is caught, and an honest chain still
verifies under its own pin.

The general lesson generalises past this module: *a cryptographic check inherits the
trustworthiness of wherever its public parameters came from.* Signing was never the weak
point; knowing whose signature to expect was.
