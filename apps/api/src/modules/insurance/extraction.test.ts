import { describe, expect, it } from "vitest";
import {
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
  certificateExtractionSchema,
  diffExtraction,
  DOCUMENT_TEXT_LIMIT,
  summariseExtraction,
  type CertificateExtraction,
  type ExtractionSubject,
} from "./extraction.js";

const SUBJECT: ExtractionSubject = {
  subjectName: "Ridgeway Groundworks Limited",
  policyType: "public_liability",
  certificateNumber: "PL-99881",
  insurer: "Northgate Insurance plc",
  limitOfIndemnity: 5_000_000,
  currency: "GBP",
  validFrom: "2026-01-01",
  validTo: "2026-12-31",
};

function extraction(over: Partial<CertificateExtraction> = {}): CertificateExtraction {
  return certificateExtractionSchema.parse({
    insurer: "Northgate Insurance plc",
    policyNumber: "PL-99881",
    insuredName: "Ridgeway Groundworks Ltd",
    policyType: "public liability",
    limitOfIndemnity: 5_000_000,
    currency: "GBP",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    waiverOfSubrogation: null,
    additionalInsured: null,
    endorsements: [],
    citations: [],
    notes: null,
    ...over,
  });
}

/* ------------------------------------------------------------------ */
/* Prompt assembly                                                     */
/* ------------------------------------------------------------------ */

describe("prompt assembly", () => {
  it("tells the model that null is a correct answer", () => {
    const system = buildExtractionSystemPrompt();
    expect(system).toContain("return null");
    expect(system).toContain("citation");
  });

  it("labels the typed values as the claim under test, not as context", () => {
    const user = buildExtractionUserPrompt(SUBJECT, "CERTIFICATE OF INSURANCE ...");
    expect(user).toContain("claim under test");
    expect(user).toContain("Do NOT let them influence");
    expect(user).toContain("PL-99881");
  });

  it("bounds the document text so one long PDF cannot blow the context", () => {
    const user = buildExtractionUserPrompt(SUBJECT, "x".repeat(DOCUMENT_TEXT_LIMIT + 5_000));
    expect(user.length).toBeLessThan(DOCUMENT_TEXT_LIMIT + 2_000);
  });

  it("defaults the optional arrays so a terse model answer still parses", () => {
    const parsed = certificateExtractionSchema.parse({
      insurer: null,
      policyNumber: null,
      insuredName: null,
      policyType: null,
      limitOfIndemnity: null,
      currency: null,
      validFrom: null,
      validTo: null,
      waiverOfSubrogation: null,
      additionalInsured: null,
    });
    expect(parsed.endorsements).toEqual([]);
    expect(parsed.citations).toEqual([]);
    expect(parsed.notes).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The diff                                                            */
/* ------------------------------------------------------------------ */

describe("diffExtraction", () => {
  it("finds nothing when the paper and the record agree", () => {
    expect(diffExtraction(SUBJECT, extraction())).toEqual([]);
  });

  it("never treats an unreadable field as a mismatch", () => {
    const blank = extraction({
      insurer: null,
      policyNumber: null,
      insuredName: null,
      limitOfIndemnity: null,
      currency: null,
      validFrom: null,
      validTo: null,
    });
    expect(diffExtraction(SUBJECT, blank)).toEqual([]);
  });

  it("raises the understated limit as high severity and says why it matters", () => {
    const [m] = diffExtraction(SUBJECT, extraction({ limitOfIndemnity: 1_000_000 }));
    expect(m!.field).toBe("limitOfIndemnity");
    expect(m!.severity).toBe("high");
    expect(m!.detail).toContain("LOWER limit");
    expect(m!.typed).toBe(5_000_000);
    expect(m!.extracted).toBe(1_000_000);
  });

  it("tolerates rounding but not a different number", () => {
    expect(diffExtraction(SUBJECT, extraction({ limitOfIndemnity: 5_000_000.4 }))).toEqual([]);
    expect(diffExtraction(SUBJECT, extraction({ limitOfIndemnity: 5_100_000 }))).toHaveLength(1);
  });

  it("treats a different currency as cover-critical", () => {
    const [m] = diffExtraction(SUBJECT, extraction({ currency: "eur" }));
    expect(m!.field).toBe("currency");
    expect(m!.severity).toBe("high");
    expect(m!.extracted).toBe("EUR");
  });

  it("catches an expiry typed later than the document — the lapse the sweep cannot see", () => {
    const [m] = diffExtraction(SUBJECT, extraction({ validTo: "2026-06-30" }));
    expect(m!.field).toBe("validTo");
    expect(m!.severity).toBe("high");
    expect(m!.detail).toContain("hides a lapse");
  });

  it("compares dates by day, not by string", () => {
    expect(diffExtraction(SUBJECT, extraction({ validTo: "2026-12-31T00:00:00.000Z" }))).toEqual([]);
  });

  it("ignores legal-entity spelling in company names but not a different company", () => {
    expect(diffExtraction(SUBJECT, extraction({ insurer: "Northgate Insurance Limited" }))).toEqual(
      [],
    );
    const [m] = diffExtraction(SUBJECT, extraction({ insurer: "Southfield Mutual" }));
    expect(m!.field).toBe("insurer");
    expect(m!.severity).toBe("medium");
  });

  it("flags a different insured at low severity — spellings differ, companies do not", () => {
    expect(diffExtraction(SUBJECT, extraction({ insuredName: "Ridgeway Groundworks LTD." }))).toEqual(
      [],
    );
    const [m] = diffExtraction(SUBJECT, extraction({ insuredName: "Someone Else Contracting" }));
    expect(m!.field).toBe("subjectName");
    expect(m!.severity).toBe("low");
  });

  it("ignores whitespace and case in the policy number", () => {
    expect(diffExtraction(SUBJECT, extraction({ policyNumber: " pl-99881 " }))).toEqual([]);
    expect(diffExtraction(SUBJECT, extraction({ policyNumber: "PL-11111" }))).toHaveLength(1);
  });

  it("attaches the quote the finding rests on when the model supplied one", () => {
    const [m] = diffExtraction(
      SUBJECT,
      extraction({
        limitOfIndemnity: 1_000_000,
        citations: [{ field: "limitOfIndemnity", quote: "Limit of indemnity: GBP 1,000,000" }],
      }),
    );
    expect(m!.quote).toBe("Limit of indemnity: GBP 1,000,000");
  });
});

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

describe("summariseExtraction", () => {
  it("says plainly when nothing could be read", () => {
    const blank = extraction({
      insurer: null,
      policyNumber: null,
      limitOfIndemnity: null,
      validFrom: null,
      validTo: null,
    });
    expect(summariseExtraction(blank, [])).toContain("Nothing could be read");
  });

  it("refuses to call agreement with the paper a confirmation from the insurer", () => {
    const s = summariseExtraction(extraction(), []);
    expect(s).toContain("not confirmation from the insurer");
  });

  it("counts the cover-critical disagreements and states nothing was changed", () => {
    const mismatches = diffExtraction(SUBJECT, extraction({ limitOfIndemnity: 1_000_000 }));
    const s = summariseExtraction(extraction({ limitOfIndemnity: 1_000_000 }), mismatches);
    expect(s).toContain("1 of them on cover-critical fields");
    expect(s).toContain("Nothing has been changed");
  });
});
