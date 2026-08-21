# ADR 0008 — Certification independence and the certified value as an Assertion

**Status:** accepted (implemented in `apps/api/src/modules/commercial/valuations.ts`)

## Context

The payment certificate is the highest-consequence mutation on the commercial side: it is
the point where measured work becomes money owed. Spec Domain B demands the certificate as
a distinct determination (#179) with a persisted variance against the application (#180),
and Vol III's design rule — *assertion and evidence must never be authored by the same
actor* — applies with full force here: a platform where the party that applied for payment
can also certify it is a self-billing tool, and its certificates are worthless to an owner,
funder or auditor. Procore-class systems record certificates as documents; nothing
structural stops the applicant approving their own number.

The same failure mode exists on the time side: an extension-of-time claim assessed by the
person who raised it is not an assessment (spec #232's determination register exists
precisely because the administrator's determination is a *different party's* act).

## Decision

Three rules, all in code:

1. **Certifier ≠ submitter, enforced at the route.** `POST /valuations/:valuationId/certify`
   requires the valuation to be `submitted` and returns
   `403 The certifier must not be the valuation's submitter` when
   `req.user.id === valuations.submittedBy`. Level separation stacks on top: submission
   needs `commercial` `standard`, certification needs `commercial` **admin**
   (`requireCommercialLevel`, `modules/commercial/shared.ts`). The certificate persists the
   certifier's own figures plus `varianceFromApplication` and `varianceReason` (#180) — the
   determination and its distance from the application are both on the record, ledgered
   with full payload.

2. **The certified value becomes an Assertion, in the same transaction.** Certification
   inserts an `assertions` row — `kind: "cost"`, `value: netCertified`,
   `claimantId` = the certifier, `sourceType: "payment_certificate"`, `sourceId` = the
   certificate (`packages/db/src/schema/assurance.ts`). The design point: **a certificate
   is not treated as truth; it is treated as a claim by the certifier**, sitting in the
   assurance layer waiting to be reconciled against independent evidence (site surveys,
   photos, ingested third-party records) exactly like any contractor claim. This is the
   delivery→assurance bridge for money, and it is what makes the over-certification
   detector family (Domain A #66) possible: certified-vs-evidence is just another
   reconciliation.

3. **The same independence rule on the time side.** An EOT claim cannot be transitioned to
   `assessed` by its creator (`403`, `modules/contracts/index.ts`); `assessedBy` and
   `assessedAt` are stamped, and an agreed award moves the contract completion date through
   a ledgered state change citing the claim as cause.

## Consequences

- The self-billing failure mode cannot happen through the API, and every certificate is
  attributable: submitter, certifier, variance and reason are separate recorded facts.
- The assurance layer gains a continuous feed of high-value assertions with zero extra
  user effort — Tier-1 reconciliation work (M3/M6, `docs/roadmap.md`) plugs into rows that
  already exist rather than asking anyone to re-key certified values.
- Honest limits, stated plainly (also in `docs/security.md` §2.4):
  - The check is **identity-level within one tenant**. Submitter and certifier can be two
    employees of the same contractor; the platform does not yet model which contractual
    *party* (employer / contractor / administrator per `contracts.parties`) an actor acts
    for. Party-aware certification is the designed next step.
  - `previousNet`/`previousCertified` arithmetic trusts prior non-withdrawn certificates;
    there is no independent re-derivation of the cumulative position yet (that is the
    Domain B #187 over/under-certification statement, not built).
  - `dueDate` on a certificate is a recorded date, not a computed statutory deadline —
    payment-regime engines are M10.
  - A certificate's Assertion has claimant = certifier but, until M6 lands, any evidence it
    is reconciled against still arrives through the same API pathway — ADR 0004's
    actor-level-not-pathway-level caveat applies here unchanged.
