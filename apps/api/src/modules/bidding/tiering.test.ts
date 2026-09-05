import { describe, expect, it } from "vitest";
import {
  assessTier,
  capTier,
  DEFAULT_TIERING_RULE,
  safetyInWindow,
  type TieringInput,
} from "./tiering.js";

const base = (over: Partial<TieringInput> = {}): TieringInput => ({
  scorePercent: 92,
  passThreshold: 60,
  knockoutFailed: false,
  singleProjectLimit: 2_500_000,
  limitCurrency: "GBP",
  safety: [{ year: 2026, emr: 0.8, trir: 1.2, dart: 0.4, fatalities: 0, source: "audited" }],
  licences: [{ kind: "gas_safe", status: "verified", expiresAt: "2027-01-01" }],
  references: [{ outcome: "delivered", checkedBy: "usr_buyer" }],
  asOf: "2026-06-01",
  ...over,
});

describe("capTier", () => {
  it("only ever lowers a tier", () => {
    expect(capTier("a", "c")).toBe("c");
    expect(capTier("c", "a")).toBe("c");
    expect(capTier("b", "unrated")).toBe("unrated");
    expect(capTier("unrated", "a")).toBe("unrated");
  });
});

describe("safetyInWindow", () => {
  it("drops records older than the window and orders newest first", () => {
    const rows = safetyInWindow(
      [
        { year: 2019, emr: 3, trir: 9, dart: 4, fatalities: 2, source: "audited" },
        { year: 2025, emr: 0.9, trir: 1, dart: 0.5, fatalities: 0, source: "audited" },
        { year: 2026, emr: 0.8, trir: 1, dart: 0.5, fatalities: 0, source: "self_declared" },
      ],
      "2026-06-01",
      3,
    );
    expect(rows.map((r) => r.year)).toEqual([2026, 2025]);
  });

  it("prefers the audited row when two sources describe the same year", () => {
    const rows = safetyInWindow(
      [
        { year: 2026, emr: 0.7, trir: 1, dart: 0, fatalities: 0, source: "self_declared" },
        { year: 2026, emr: 1.4, trir: 1, dart: 0, fatalities: 0, source: "regulator" },
      ],
      "2026-06-01",
      3,
    );
    expect(rows[0]?.source).toBe("regulator");
  });
});

describe("assessTier — the score opens the door", () => {
  it("grants tier A on a strong score with clean evidence", () => {
    const v = assessTier(base());
    expect(v.scoreBandTier).toBe("a");
    expect(v.tier).toBe("a");
    expect(v.ceilings).toEqual([]);
    expect(v.tierBasis).toContain("92%");
    expect(v.riskRating).toBe("low");
    expect(v.limit.value).toBe(2_500_000);
  });

  it("bands B and C from the score alone", () => {
    expect(assessTier(base({ scorePercent: 75 })).scoreBandTier).toBe("b");
    expect(assessTier(base({ scorePercent: 61 })).scoreBandTier).toBe("c");
  });

  it("refuses any tier below the questionnaire's pass threshold", () => {
    const v = assessTier(base({ scorePercent: 55, passThreshold: 60 }));
    expect(v.tier).toBe("unrated");
    expect(v.tierBasis).toContain("below the 60% floor");
  });

  it("returns unrated — not C — when there is no score at all", () => {
    const v = assessTier(base({ scorePercent: null }));
    expect(v.tier).toBe("unrated");
    expect(v.tierBasis).toContain("not known");
  });

  it("returns unrated on a knockout failure", () => {
    const v = assessTier(base({ knockoutFailed: true }));
    expect(v.tier).toBe("unrated");
    expect(v.riskRating).toBe("high");
    expect(v.riskBasis).toContain("knockout");
  });
});

describe("assessTier — safety is a ceiling", () => {
  it("caps a 92% vendor at C for a fatality", () => {
    const v = assessTier(
      base({
        safety: [{ year: 2025, emr: 0.8, trir: 1, dart: 0.4, fatalities: 1, source: "audited" }],
      }),
    );
    expect(v.scoreBandTier).toBe("a");
    expect(v.tier).toBe("c");
    expect(v.ceilings.join(" ")).toContain("fatality");
    expect(v.riskRating).toBe("high");
  });

  it("caps at C above the EMR hard cap and at B above the soft cap", () => {
    const hard = assessTier(
      base({
        safety: [{ year: 2026, emr: 1.8, trir: 1, dart: 0, fatalities: 0, source: "audited" }],
      }),
    );
    expect(hard.tier).toBe("c");
    const soft = assessTier(
      base({
        safety: [{ year: 2026, emr: 1.3, trir: 1, dart: 0, fatalities: 0, source: "audited" }],
      }),
    );
    expect(soft.tier).toBe("b");
    expect(soft.riskRating).toBe("high");
  });

  it("caps at B on a TRIR above the threshold", () => {
    const v = assessTier(
      base({
        safety: [{ year: 2026, emr: 0.9, trir: 9, dart: 0, fatalities: 0, source: "audited" }],
      }),
    );
    expect(v.tier).toBe("b");
    expect(v.ceilings.join(" ")).toContain("TRIR");
  });

  it("caps at B when every safety figure is self-declared", () => {
    const v = assessTier(
      base({
        safety: [{ year: 2026, emr: 0.5, trir: 1, dart: 0, fatalities: 0, source: "self_declared" }],
      }),
    );
    expect(v.tier).toBe("b");
    expect(v.ceilings.join(" ")).toContain("self-declared");
  });

  it("treats a missing safety record as an absence, not a clean sheet", () => {
    const v = assessTier(base({ safety: [] }));
    expect(v.tier).toBe("b");
    expect(v.ceilings.join(" ")).toContain("not a clean one");
    expect(v.safetyYear).toBeNull();
  });

  it("ignores a fatality older than the window", () => {
    const v = assessTier(
      base({
        safety: [
          { year: 2020, emr: 0.8, trir: 1, dart: 0, fatalities: 3, source: "audited" },
          { year: 2026, emr: 0.8, trir: 1, dart: 0, fatalities: 0, source: "audited" },
        ],
      }),
    );
    expect(v.tier).toBe("a");
  });
});

describe("assessTier — licences, references and money", () => {
  it("caps at C on an expired licence status", () => {
    const v = assessTier(
      base({ licences: [{ kind: "asbestos", status: "expired", expiresAt: "2026-01-01" }] }),
    );
    expect(v.tier).toBe("c");
    expect(v.ceilings.join(" ")).toContain("asbestos");
    expect(v.riskRating).toBe("high");
  });

  it("caps at C on a licence whose stated expiry has passed even where the status is stale", () => {
    const v = assessTier(
      base({ licences: [{ kind: "electrical", status: "verified", expiresAt: "2026-05-01" }] }),
    );
    expect(v.tier).toBe("c");
  });

  it("does not penalise a licence marked not applicable", () => {
    const v = assessTier(
      base({ licences: [{ kind: "gas_safe", status: "not_applicable", expiresAt: null }] }),
    );
    expect(v.tier).toBe("a");
  });

  it("caps at C on a terminated reference", () => {
    const v = assessTier(
      base({ references: [{ outcome: "terminated", checkedBy: "usr_buyer" }] }),
    );
    expect(v.tier).toBe("c");
    expect(v.riskRating).toBe("high");
  });

  it("caps at B when no reference was actually taken up", () => {
    const v = assessTier(base({ references: [{ outcome: "delivered", checkedBy: null }] }));
    expect(v.tier).toBe("b");
    expect(v.ceilings.join(" ")).toContain("checked reference");
  });

  it("caps at C and refuses a limit where no financial screening exists", () => {
    const v = assessTier(base({ singleProjectLimit: null }));
    expect(v.tier).toBe("c");
    expect(v.limit.value).toBeNull();
    expect(v.limit.reasons[0]).toContain("no basis");
    expect(v.riskRating).toBe("medium");
  });
});

describe("assessTier — risk rating", () => {
  it("is unrated, never low, where nothing is known", () => {
    const v = assessTier(base({ scorePercent: null, safety: [] }));
    expect(v.riskRating).toBe("unrated");
    expect(v.riskBasis).toContain("not a low-risk vendor");
  });

  it("is medium where nothing adverse is recorded but the evidence is thin", () => {
    const v = assessTier(base({ safety: [], references: [] }));
    expect(v.riskRating).toBe("medium");
    expect(v.riskBasis).toContain("no safety record on file");
  });

  it("names every high-risk reason", () => {
    const v = assessTier(
      base({
        scorePercent: 62,
        safety: [{ year: 2026, emr: 1.4, trir: 1, dart: 0, fatalities: 1, source: "audited" }],
      }),
    );
    expect(v.riskRating).toBe("high");
    expect(v.riskBasis).toContain("fatality");
    expect(v.riskBasis).toContain("EMR");
    expect(v.riskBasis).toContain("62%");
  });
});

describe("assessTier — the rule is configurable and cited", () => {
  it("uses the supplied thresholds", () => {
    const v = assessTier(
      base({ scorePercent: 82, rule: { ...DEFAULT_TIERING_RULE, tierAScorePercent: 80 } }),
    );
    expect(v.scoreBandTier).toBe("a");
    expect(v.tierBasis).toContain("80% tier A band");
  });
});
