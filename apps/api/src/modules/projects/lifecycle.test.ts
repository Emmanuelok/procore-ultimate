import { describe, expect, it } from "vitest";
import {
  allowedNextStages,
  currencyChange,
  isIsoDate,
  stageTransition,
  validateProjectDates,
} from "./lifecycle.js";

describe("stageTransition", () => {
  it("allows the ordinary forward move without admin", () => {
    expect(stageTransition("bidding", "pre_construction")).toEqual({
      allowed: true,
      requiresAdmin: false,
    });
    expect(stageTransition("course_of_construction", "warranty")).toEqual({
      allowed: true,
      requiresAdmin: false,
    });
  });

  it("treats a reversal as an admin correction, not an ordinary edit", () => {
    // "closed → bidding" was accepted from any member holding projects:standard.
    expect(stageTransition("closed", "bidding")).toEqual({ allowed: true, requiresAdmin: true });
    expect(stageTransition("warranty", "pre_construction")).toEqual({
      allowed: true,
      requiresAdmin: true,
    });
  });

  it("treats a skipped stage as privileged", () => {
    expect(stageTransition("bidding", "warranty")).toEqual({ allowed: true, requiresAdmin: true });
  });

  it("allows closing from anywhere", () => {
    expect(stageTransition("bidding", "closed").allowed).toBe(true);
    expect(stageTransition("bidding", "closed")).toMatchObject({ requiresAdmin: false });
  });

  it("is a no-op for the same stage", () => {
    expect(stageTransition("warranty", "warranty")).toEqual({
      allowed: true,
      requiresAdmin: false,
    });
  });

  it("refuses a stage that does not exist", () => {
    const decision = stageTransition("bidding", "demolition");
    expect(decision.allowed).toBe(false);
  });

  it("requires an admin to correct an unknown stored stage", () => {
    expect(stageTransition("legacy_value", "bidding")).toEqual({
      allowed: true,
      requiresAdmin: true,
    });
  });
});

describe("allowedNextStages", () => {
  it("offers only the forward moves to a standard user", () => {
    expect(allowedNextStages("bidding", false)).toEqual(["pre_construction", "closed"]);
    expect(allowedNextStages("closed", false)).toEqual([]);
  });

  it("offers everything to an admin", () => {
    expect(allowedNextStages("closed", true)).toContain("bidding");
  });
});

describe("currencyChange", () => {
  it("allows a change when nothing is denominated yet", () => {
    expect(
      currencyChange("USD", "EUR", { counts: { "budget lines": 0 }, currencies: ["USD"] }),
    ).toEqual({ allowed: true });
  });

  it("refuses a change that would restate stored amounts, and says what holds it", () => {
    const decision = currencyChange("USD", "EUR", {
      counts: { "budget lines": 12, "invoice lines": 3 },
      currencies: ["USD"],
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("12 budget lines");
      expect(decision.reason).toContain("3 invoice lines");
      expect(decision.reason).toContain("USD");
    }
  });

  it("is a no-op when the currency has not changed", () => {
    expect(
      currencyChange("USD", "USD", { counts: { "budget lines": 12 }, currencies: ["USD"] }),
    ).toEqual({ allowed: true });
  });
});

describe("dates", () => {
  it("recognises ISO dates and rejects everything else", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("banana")).toBe(false);
    expect(isIsoDate("28/02/2026")).toBe(false);
    expect(isIsoDate("2026-02-30")).toBe(false);
  });

  it("refuses a finish before a start", () => {
    expect(validateProjectDates("2026-06-01", "2026-05-01").ok).toBe(false);
    expect(validateProjectDates("2026-06-01", "2026-06-01").ok).toBe(true);
  });

  it("accepts either date being absent", () => {
    expect(validateProjectDates(null, "2026-06-01").ok).toBe(true);
    expect(validateProjectDates("2026-06-01", undefined).ok).toBe(true);
  });

  it("refuses an unparseable date", () => {
    const result = validateProjectDates("banana", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("startDate");
  });
});
