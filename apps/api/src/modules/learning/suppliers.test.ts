import { describe, expect, it } from "vitest";
import {
  MIN_OBSERVATIONS,
  scoreSuppliers,
  type SupplierScoreInput,
} from "./suppliers.js";

const ASOF = "2026-06-01";

function input(over: Partial<SupplierScoreInput> = {}): SupplierScoreInput {
  return {
    asOf: ASOF,
    vendors: [{ id: "ven_a", name: "Groundworks Ltd" }],
    certificates: [],
    actions: [],
    ncrs: [],
    ...over,
  };
}

const cert = (over: Partial<SupplierScoreInput["certificates"][number]> = {}) => ({
  vendorId: "ven_a",
  validTo: "2026-12-31",
  verifiedAt: "2026-01-05T00:00:00.000Z",
  status: "active",
  ...over,
});

const action = (over: Partial<SupplierScoreInput["actions"][number]> = {}) => ({
  ownerVendorId: "ven_a",
  status: "open",
  dueDate: "2026-07-01",
  completedAt: null,
  carryCount: 0,
  ...over,
});

const ncr = (over: Partial<SupplierScoreInput["ncrs"][number]> = {}) => ({
  raisedAgainstVendorId: "ven_a",
  status: "closed",
  severity: "minor",
  ...over,
});

describe("honesty about absence", () => {
  it("returns null, not zero, for a supplier with no records at all", () => {
    const [s] = scoreSuppliers(input());
    expect(s!.composite).toBeNull();
    expect(s!.certificateDiscipline.score).toBeNull();
    expect(s!.commitmentSlippage.score).toBeNull();
    expect(s!.quality.score).toBeNull();
    expect(s!.observations).toBe(0);
  });

  it("says an absence of NCRs is an absence of records, not evidence of quality", () => {
    const [s] = scoreSuppliers(input());
    expect(s!.quality.basis).toContain("absence of records");
  });

  it("still returns the supplier rather than omitting them", () => {
    expect(scoreSuppliers(input())).toHaveLength(1);
  });

  it("withholds the composite below the observation threshold and says why", () => {
    const [s] = scoreSuppliers(input({ certificates: [cert()] }));
    expect(s!.observations).toBe(1);
    expect(s!.composite).toBeNull();
    expect(s!.reasons.join(" ")).toContain(`fewer than the ${MIN_OBSERVATIONS}`);
  });

  it("publishes a composite once the threshold is met", () => {
    const [s] = scoreSuppliers(
      input({ certificates: [cert(), cert(), cert()] }),
    );
    expect(s!.observations).toBe(3);
    expect(s!.composite).toBe(100);
  });
});

describe("certificate discipline", () => {
  it("weights being in date twice as heavily as being verified", () => {
    // 2 of 2 in date, 0 verified → (100*2 + 0)/3 = 67
    const [s] = scoreSuppliers(
      input({
        certificates: [cert({ verifiedAt: null }), cert({ verifiedAt: null }), cert({ verifiedAt: null })],
      }),
    );
    expect(s!.certificateDiscipline.score).toBe(67);
  });

  it("counts an expired certificate as a live exposure in the reasons", () => {
    const [s] = scoreSuppliers(
      input({ certificates: [cert(), cert(), cert({ validTo: "2026-01-01" })] }),
    );
    expect(s!.certificateDiscipline.counts["expired"]).toBe(1);
    expect(s!.reasons.join(" ")).toContain("live exposure");
  });

  it("ignores superseded and withdrawn certificates, and says nothing is left", () => {
    const [s] = scoreSuppliers(
      input({ certificates: [cert({ status: "superseded" }), cert({ status: "withdrawn" })] }),
    );
    expect(s!.certificateDiscipline.score).toBeNull();
    expect(s!.certificateDiscipline.basis).toContain("superseded or withdrawn");
  });
});

describe("commitment slippage", () => {
  it("scores a clean record at 100", () => {
    const [s] = scoreSuppliers(input({ actions: [action(), action(), action()] }));
    expect(s!.commitmentSlippage.score).toBe(100);
  });

  it("counts an open action past its date as overdue", () => {
    const [s] = scoreSuppliers(
      input({ actions: [action({ dueDate: "2026-05-01" }), action(), action()] }),
    );
    expect(s!.commitmentSlippage.counts["overdue"]).toBe(1);
    expect(s!.commitmentSlippage.score).toBe(67);
  });

  it("does not call a completed action overdue merely because its date passed", () => {
    const [s] = scoreSuppliers(
      input({
        actions: [
          action({ dueDate: "2026-05-01", status: "completed", completedAt: "2026-04-20T09:00:00Z" }),
          action(),
          action(),
        ],
      }),
    );
    expect(s!.commitmentSlippage.counts["overdue"]).toBe(0);
    expect(s!.commitmentSlippage.counts["lateClosed"]).toBe(0);
  });

  it("counts a late closure separately from an open overdue", () => {
    const [s] = scoreSuppliers(
      input({
        actions: [
          action({ dueDate: "2026-05-01", status: "completed", completedAt: "2026-05-10T09:00:00Z" }),
          action(),
          action(),
        ],
      }),
    );
    expect(s!.commitmentSlippage.counts["lateClosed"]).toBe(1);
    expect(s!.commitmentSlippage.counts["overdue"]).toBe(0);
  });

  it("penalises a repeatedly carried action twice when it also closed late", () => {
    const both = scoreSuppliers(
      input({
        actions: [
          action({
            dueDate: "2026-05-01",
            status: "completed",
            completedAt: "2026-05-10T09:00:00Z",
            carryCount: 3,
          }),
          action(),
          action(),
        ],
      }),
    )[0]!;
    // two penalties over three actions → clamped at 33
    expect(both.commitmentSlippage.score).toBe(33);
    expect(both.reasons.join(" ")).toContain("carried between meetings");
  });

  it("never goes below zero however bad the record", () => {
    const [s] = scoreSuppliers(
      input({
        actions: [
          action({ dueDate: "2026-01-01", carryCount: 5 }),
          action({ dueDate: "2026-01-01", carryCount: 5 }),
        ],
      }),
    );
    expect(s!.commitmentSlippage.score).toBe(0);
  });

  it("does not count a cancelled action against the supplier", () => {
    const [s] = scoreSuppliers(
      input({ actions: [action({ dueDate: "2026-01-01", status: "cancelled" }), action(), action()] }),
    );
    expect(s!.commitmentSlippage.counts["overdue"]).toBe(0);
  });
});

describe("quality", () => {
  it("penalises a major open NCR harder than a closed minor one", () => {
    const minor = scoreSuppliers(input({ ncrs: [ncr(), ncr(), ncr()] }))[0]!;
    const major = scoreSuppliers(
      input({ ncrs: [ncr({ severity: "major", status: "open" }), ncr(), ncr()] }),
    )[0]!;
    expect(major.quality.score).toBeLessThan(minor.quality.score!);
    expect(major.quality.counts["major"]).toBe(1);
    expect(major.quality.counts["open"]).toBe(1);
  });

  it("states that its scale is a convention, not a standard", () => {
    const [s] = scoreSuppliers(input({ ncrs: [ncr()] }));
    expect(s!.quality.basis).toContain("not an industry standard");
  });

  it("floors at zero", () => {
    const many = Array.from({ length: 40 }, () => ncr({ severity: "critical", status: "open" }));
    const [s] = scoreSuppliers(input({ ncrs: many }));
    expect(s!.quality.score).toBe(0);
  });
});

describe("the composite", () => {
  it("is the weighted mean of the dimensions that HAVE a score, not of zeros", () => {
    // certificates only: perfect. Slippage and quality unscored.
    const [s] = scoreSuppliers(input({ certificates: [cert(), cert(), cert()] }));
    expect(s!.composite).toBe(100);
    expect(s!.reasons.join(" ")).toContain("left out rather than counted as zero");
  });

  it("weights certificate discipline above the others", () => {
    const certBad = scoreSuppliers(
      input({
        certificates: [cert({ validTo: "2020-01-01", verifiedAt: null })],
        actions: [action(), action()],
      }),
    )[0]!;
    const slipBad = scoreSuppliers(
      input({
        certificates: [cert()],
        actions: [action({ dueDate: "2020-01-01" }), action({ dueDate: "2020-01-01" })],
      }),
    )[0]!;
    expect(certBad.composite).toBeLessThan(slipBad.composite!);
  });

  it("always says it is a record rather than a recommendation", () => {
    const [s] = scoreSuppliers(input({ certificates: [cert()] }));
    expect(s!.reasons.at(-1)).toContain("not a recommendation");
  });
});

describe("ordering", () => {
  it("puts the worst first and the unrated last", () => {
    const rows = scoreSuppliers(
      input({
        vendors: [
          { id: "ven_a", name: "A" },
          { id: "ven_b", name: "B" },
          { id: "ven_c", name: "C" },
        ],
        certificates: [
          cert({ vendorId: "ven_a", validTo: "2020-01-01", verifiedAt: null }),
          cert({ vendorId: "ven_a", validTo: "2020-01-01", verifiedAt: null }),
          cert({ vendorId: "ven_a", validTo: "2020-01-01", verifiedAt: null }),
          cert({ vendorId: "ven_b" }),
          cert({ vendorId: "ven_b" }),
          cert({ vendorId: "ven_b" }),
        ],
      }),
    );
    expect(rows.map((r) => r.vendorId)).toEqual(["ven_a", "ven_b", "ven_c"]);
    expect(rows[2]!.composite).toBeNull();
  });

  it("keeps one vendor's records out of another's", () => {
    const rows = scoreSuppliers(
      input({
        vendors: [
          { id: "ven_a", name: "A" },
          { id: "ven_b", name: "B" },
        ],
        ncrs: [ncr({ raisedAgainstVendorId: "ven_b" })],
      }),
    );
    const a = rows.find((r) => r.vendorId === "ven_a")!;
    const b = rows.find((r) => r.vendorId === "ven_b")!;
    expect(a.quality.observations).toBe(0);
    expect(b.quality.observations).toBe(1);
  });
});
