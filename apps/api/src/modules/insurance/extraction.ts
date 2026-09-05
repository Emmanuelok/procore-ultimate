/**
 * CERTIFICATE EXTRACTION AND THE DIFF THAT MATTERS (spec #772, #781).
 *
 * WHAT THIS IS
 * A certificate of insurance is keyed into the platform by the party who
 * benefits from it reading well. Nothing checked the typed values against the
 * document that was uploaded, so a subcontractor could attach a genuine
 * certificate for £1m and type £5m, and every downstream check — limit
 * adequacy, cover gaps, invoice holds — would run against the typed number.
 *
 * This file assembles the prompt that reads the DOCUMENT and, more
 * importantly, computes the diff. The diff is the product: a mismatch between
 * what the paper says and what the record says is a finding with a severity,
 * not a correction to apply. Nothing here ever overwrites a typed value.
 *
 * WHY IT IS PURE
 * Prompt assembly and mismatch classification are the two things that must be
 * reviewable, and both are testable without a network or an API key. The
 * route does the model call and the persistence; the judgement lives here.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  • It does not decide that a certificate is fraudulent. A mismatch has
 *    innocent explanations (an endorsement, a renewal, a typo) and the system
 *    that cries fraud at every typo is the system nobody reads.
 *  • It does not auto-verify. Reading a PDF is not confirmation from the
 *    insurer; `verificationMethod` still requires a human act or a reply from
 *    the broker (see the confirmation flow).
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* What the model is asked to return                                   */
/* ------------------------------------------------------------------ */

/**
 * Every field is nullable and the prompt says so. "Not stated on the
 * document" is a real, useful answer — far more useful than a plausible
 * number the model reconstructed from context — and the mismatch engine
 * treats null as "no evidence either way", never as a contradiction.
 */
export const certificateExtractionSchema = z.object({
  insurer: z.string().max(300).nullable(),
  policyNumber: z.string().max(200).nullable(),
  insuredName: z.string().max(300).nullable(),
  policyType: z.string().max(80).nullable(),
  limitOfIndemnity: z.number().finite().nullable(),
  currency: z.string().max(8).nullable(),
  validFrom: z.string().max(40).nullable(),
  validTo: z.string().max(40).nullable(),
  /** endorsements that change who the cover protects — the ones contracts require */
  waiverOfSubrogation: z.boolean().nullable(),
  additionalInsured: z.boolean().nullable(),
  endorsements: z.array(z.string().max(300)).max(30).default([]),
  /** the exact words the extraction rests on, one per field it filled */
  citations: z
    .array(
      z.object({
        field: z.string().max(60),
        quote: z.string().max(600),
      }),
    )
    .max(40)
    .default([]),
  notes: z.string().max(2000).nullable().default(null),
});

export type CertificateExtraction = z.infer<typeof certificateExtractionSchema>;

export function buildExtractionSystemPrompt(): string {
  return [
    "You read insurance certificates and report ONLY what the document states.",
    "",
    "Rules, in order of importance:",
    "1. Never infer a value that is not written on the document. If a field is not stated,",
    "   return null for it. A null is a correct answer; a plausible guess is a wrong one.",
    "2. For every field you fill, add a citation quoting the exact words on the document that",
    "   carry it. A field with no quotable source must be null.",
    "3. Report the limit of indemnity as a number in the document's own currency, and report",
    "   that currency separately. Do not convert anything.",
    "4. Dates: return ISO (YYYY-MM-DD). If the document gives a period in another format,",
    "   convert it only when the meaning is unambiguous; otherwise return null.",
    "5. waiverOfSubrogation and additionalInsured are true only when an endorsement to that",
    "   effect is present on the document. Absence of mention is null, not false.",
    "",
    "Answer with a single JSON object and nothing else.",
  ].join("\n");
}

export interface ExtractionSubject {
  subjectName: string;
  policyType: string;
  certificateNumber: string | null;
  insurer: string | null;
  limitOfIndemnity: number | null;
  currency: string;
  validFrom: string;
  validTo: string;
}

/**
 * The user prompt states what was TYPED, clearly separated from the document,
 * and instructs the model not to be influenced by it. That is a real risk —
 * a model shown an expected answer tends to produce it — so the typed values
 * are labelled as the claim under test rather than as context.
 */
export function buildExtractionUserPrompt(subject: ExtractionSubject, documentText: string): string {
  return [
    "The following values were TYPED INTO THE SYSTEM by the party supplying the certificate.",
    "They are the claim under test. Do NOT let them influence what you read; if the document",
    "says something different, report what the document says.",
    "",
    `  subject:      ${subject.subjectName}`,
    `  policy type:  ${subject.policyType}`,
    `  certificate:  ${subject.certificateNumber ?? "(not recorded)"}`,
    `  insurer:      ${subject.insurer ?? "(not recorded)"}`,
    `  limit:        ${subject.limitOfIndemnity ?? "(not recorded)"} ${subject.currency}`,
    `  valid:        ${subject.validFrom} to ${subject.validTo}`,
    "",
    "--- DOCUMENT TEXT BEGINS ---",
    documentText.slice(0, DOCUMENT_TEXT_LIMIT),
    "--- DOCUMENT TEXT ENDS ---",
  ].join("\n");
}

export const DOCUMENT_TEXT_LIMIT = 40_000;

/* ------------------------------------------------------------------ */
/* The diff                                                            */
/* ------------------------------------------------------------------ */

export type MismatchSeverity = "high" | "medium" | "low";

export interface Mismatch {
  field: string;
  typed: string | number | null;
  extracted: string | number | null;
  severity: MismatchSeverity;
  detail: string;
  quote: string | null;
}

/** Money comparison with a tolerance for rounding, not for a different number. */
function limitsDiffer(typed: number, extracted: number): boolean {
  if (typed === extracted) return false;
  const scale = Math.max(Math.abs(typed), Math.abs(extracted));
  return Math.abs(typed - extracted) / scale > 0.001;
}

function normaliseName(v: string): string {
  return v
    .toLowerCase()
    .replace(/\b(limited|ltd|plc|llp|inc|incorporated|company|co|insurance|assurance)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function sameDate(a: string, b: string): boolean {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return a.trim() === b.trim();
  return new Date(pa).toISOString().slice(0, 10) === new Date(pb).toISOString().slice(0, 10);
}

/**
 * Compare the document's reading against the record.
 *
 * SEVERITY IS ABOUT CONSEQUENCE, NOT SIZE.
 *  • high   — the field that decides whether cover exists at the moment of a
 *             claim: the limit, and the dates. A certificate typed with a
 *             later expiry than the document has is the exact failure the
 *             expiry sweep cannot catch, because the sweep believes the record.
 *  • medium — the insurer and the policy number: they decide who is on risk,
 *             and a mismatch usually means the wrong document is attached.
 *  • low    — the insured's name, where legal-entity spellings differ
 *             legitimately all the time.
 *
 * A null extraction is never a mismatch. The model not finding a field on the
 * document is a fact about the model and the document, not evidence that the
 * typed value is wrong.
 */
export function diffExtraction(
  subject: ExtractionSubject,
  extraction: CertificateExtraction,
): Mismatch[] {
  const quoteFor = (field: string): string | null =>
    extraction.citations.find((c) => c.field === field)?.quote ?? null;
  const out: Mismatch[] = [];

  if (
    extraction.limitOfIndemnity !== null &&
    subject.limitOfIndemnity !== null &&
    limitsDiffer(subject.limitOfIndemnity, extraction.limitOfIndemnity)
  ) {
    const understated = extraction.limitOfIndemnity < subject.limitOfIndemnity;
    out.push({
      field: "limitOfIndemnity",
      typed: subject.limitOfIndemnity,
      extracted: extraction.limitOfIndemnity,
      severity: "high",
      detail: understated
        ? "The document states a LOWER limit than the record. Every adequacy check on this certificate has been run against a limit the policy does not provide."
        : "The document states a higher limit than the record. The record understates the cover held.",
      quote: quoteFor("limitOfIndemnity"),
    });
  }

  if (
    extraction.currency !== null &&
    extraction.currency.trim() &&
    extraction.currency.trim().toUpperCase() !== subject.currency.toUpperCase()
  ) {
    out.push({
      field: "currency",
      typed: subject.currency,
      extracted: extraction.currency.trim().toUpperCase(),
      severity: "high",
      detail:
        "The document's limit is in a different currency from the record. A limit compared across currencies is not a comparison.",
      quote: quoteFor("currency"),
    });
  }

  for (const [field, typed, extracted] of [
    ["validFrom", subject.validFrom, extraction.validFrom],
    ["validTo", subject.validTo, extraction.validTo],
  ] as const) {
    if (extracted === null || !extracted.trim()) continue;
    if (sameDate(typed, extracted)) continue;
    out.push({
      field,
      typed,
      extracted,
      severity: "high",
      detail:
        field === "validTo"
          ? "The document expires on a different date from the record. The expiry sweep believes the record, so a record that expires later than the paper hides a lapse."
          : "The document's inception date differs from the record, so the period of cover the platform is checking is not the period the policy provides.",
      quote: quoteFor(field),
    });
  }

  if (
    extraction.insurer !== null &&
    extraction.insurer.trim() &&
    subject.insurer &&
    normaliseName(extraction.insurer) !== normaliseName(subject.insurer)
  ) {
    out.push({
      field: "insurer",
      typed: subject.insurer,
      extracted: extraction.insurer.trim(),
      severity: "medium",
      detail:
        "The document names a different insurer. Usually the wrong document is attached; occasionally the cover moved and nobody said.",
      quote: quoteFor("insurer"),
    });
  }

  if (
    extraction.policyNumber !== null &&
    extraction.policyNumber.trim() &&
    subject.certificateNumber &&
    extraction.policyNumber.replace(/\s/g, "").toLowerCase() !==
      subject.certificateNumber.replace(/\s/g, "").toLowerCase()
  ) {
    out.push({
      field: "certificateNumber",
      typed: subject.certificateNumber,
      extracted: extraction.policyNumber.trim(),
      severity: "medium",
      detail:
        "The policy number on the document does not match the number recorded against this certificate.",
      quote: quoteFor("policyNumber"),
    });
  }

  if (
    extraction.insuredName !== null &&
    extraction.insuredName.trim() &&
    normaliseName(extraction.insuredName) !== normaliseName(subject.subjectName)
  ) {
    out.push({
      field: "subjectName",
      typed: subject.subjectName,
      extracted: extraction.insuredName.trim(),
      severity: "low",
      detail:
        "The insured named on the document is not the party this certificate is recorded against. Legal-entity spellings differ legitimately; a different company does not.",
      quote: quoteFor("insuredName"),
    });
  }

  return out;
}

/**
 * A short, honest sentence about what the extraction established. Used as the
 * ledger payload's summary and shown at the top of the drawer, so the reader
 * does not have to infer "no mismatches" from an empty table.
 */
export function summariseExtraction(
  extraction: CertificateExtraction,
  mismatches: readonly Mismatch[],
): string {
  const filled = [
    extraction.insurer !== null && "insurer",
    extraction.policyNumber !== null && "policy number",
    extraction.limitOfIndemnity !== null && "limit",
    extraction.validFrom !== null && "inception",
    extraction.validTo !== null && "expiry",
  ].filter((v): v is string => typeof v === "string");
  if (filled.length === 0) {
    return "Nothing could be read from the document: no field was stated in terms the extraction could quote. The typed values stand unchecked.";
  }
  if (mismatches.length === 0) {
    return `Read ${filled.join(", ")} from the document; every field it could read agrees with the record. This is not confirmation from the insurer — it is agreement between the record and the paper supplied with it.`;
  }
  const high = mismatches.filter((m) => m.severity === "high").length;
  return `Read ${filled.join(", ")} from the document. ${mismatches.length} field(s) disagree with the record${high > 0 ? `, ${high} of them on cover-critical fields` : ""}. Nothing has been changed: the typed values stand until somebody decides which is right.`;
}
