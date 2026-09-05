import { describe, expect, it } from "vitest";
import {
  buildSkillsMatrix,
  classifyValidity,
  detectSkillGaps,
  type SkillDefinition,
  type WorkerRef,
  type WorkerSkillCell,
} from "./skills.js";

const TODAY = "2026-03-01";

const skill = (over: Partial<SkillDefinition> = {}): SkillDefinition => ({
  id: "sk_mewp",
  code: "MEWP",
  name: "MEWP operator",
  category: "certification",
  trade: null,
  validityMonths: 60,
  isMandatory: true,
  requiresEvidence: true,
  ...over,
});

const worker = (over: Partial<WorkerRef> = {}): WorkerRef => ({
  id: "w1",
  reference: "W-001",
  fullName: "A. Mason",
  trade: "Concretor",
  vendorId: null,
  status: "active",
  ...over,
});

const cell = (over: Partial<WorkerSkillCell> = {}): WorkerSkillCell => ({
  workerId: "w1",
  skillId: "sk_mewp",
  level: "competent",
  status: "verified",
  issuedAt: "2024-01-01",
  expiresAt: "2027-01-01",
  certificateRef: "MEWP-123",
  ...over,
});

describe("classifyValidity", () => {
  it("treats a missing expiry as unknown, not as valid", () => {
    const v = classifyValidity(null, TODAY);
    expect(v.state).toBe("unknown");
    expect(v.reason).toContain("not the same as never expiring");
  });

  it("classifies valid, expiring and expired", () => {
    expect(classifyValidity("2027-01-01", TODAY).state).toBe("valid");
    expect(classifyValidity("2026-03-20", TODAY).state).toBe("expiring");
    expect(classifyValidity("2026-03-20", TODAY).daysToExpiry).toBe(19);
    expect(classifyValidity("2026-02-01", TODAY).state).toBe("expired");
    expect(classifyValidity("2026-02-01", TODAY).daysToExpiry).toBe(-28);
  });

  it("uses the configured warning window", () => {
    expect(classifyValidity("2026-04-15", TODAY, 30).state).toBe("valid");
    expect(classifyValidity("2026-04-15", TODAY, 60).state).toBe("expiring");
  });
});

describe("buildSkillsMatrix", () => {
  it("keeps evidence state and validity state apart", () => {
    const matrix = buildSkillsMatrix(
      [worker()],
      [skill()],
      [cell({ status: "verified", expiresAt: "2026-02-01" })],
      { today: TODAY },
    );
    const c = matrix.rows[0]!.cells[0]!;
    expect(c.held).toBe(true);
    expect(c.status).toBe("verified");
    expect(c.validity).toBe("expired");
    expect(matrix.totals.expired).toBe(1);
    // a mandatory ticket that has expired is a gap even though it is verified
    expect(matrix.totals.mandatoryGaps).toBe(1);
  });

  it("counts an unverified claim as held but flags it", () => {
    const matrix = buildSkillsMatrix([worker()], [skill()], [cell({ status: "claimed" })], {
      today: TODAY,
    });
    expect(matrix.rows[0]!.cells[0]!.held).toBe(true);
    expect(matrix.rows[0]!.unverifiedCount).toBe(1);
    expect(matrix.rows[0]!.cells[0]!.reason).toContain("nobody has verified");
    expect(matrix.coverage[0]!.unverified).toBe(1);
  });

  it("does not count a rejected or revoked record as held", () => {
    const matrix = buildSkillsMatrix(
      [worker(), worker({ id: "w2", reference: "W-002", fullName: "B. Smith" })],
      [skill()],
      [cell({ status: "rejected" }), cell({ workerId: "w2", status: "revoked" })],
      { today: TODAY },
    );
    expect(matrix.rows.every((r) => r.cells[0]!.held === false)).toBe(true);
    expect(matrix.totals.mandatoryGaps).toBe(2);
    expect(matrix.coverage[0]!.missing).toBe(2);
  });

  it("computes coverage as a percentage of the register", () => {
    const matrix = buildSkillsMatrix(
      [worker(), worker({ id: "w2", reference: "W-002", fullName: "B. Smith" })],
      [skill()],
      [cell()],
      { today: TODAY },
    );
    expect(matrix.coverage[0]!.workersHolding).toBe(1);
    expect(matrix.coverage[0]!.valid).toBe(1);
    expect(matrix.coverage[0]!.missing).toBe(1);
    expect(matrix.coverage[0]!.coveragePercent).toBe(50);
  });

  it("reports coverage as unknowable when nobody is on the register", () => {
    const matrix = buildSkillsMatrix([], [skill()], [], { today: TODAY });
    expect(matrix.coverage[0]!.coveragePercent).toBeNull();
    expect(matrix.reasons.join(" ")).toContain("No workers are on this project's register");
  });

  it("flags holders with no expiry date as unknown rather than valid", () => {
    const matrix = buildSkillsMatrix([worker()], [skill()], [cell({ expiresAt: null })], {
      today: TODAY,
    });
    expect(matrix.rows[0]!.cells[0]!.validity).toBe("unknown");
    expect(matrix.coverage[0]!.unknownExpiry).toBe(1);
    expect(matrix.coverage[0]!.valid).toBe(0);
    expect(matrix.coverage[0]!.reasons.join(" ")).toContain("unknown rather than good");
  });

  it("says so when no skills are defined at all", () => {
    const matrix = buildSkillsMatrix([worker()], [], [], { today: TODAY });
    expect(matrix.reasons.join(" ")).toContain("No skills or certifications are defined");
  });
});

describe("detectSkillGaps", () => {
  const booking = {
    assignmentId: "ra1",
    assignmentReference: "RA-001",
    workerId: "w1",
    workerLabel: "A. Mason",
    fromDate: "2026-03-02",
    toDate: "2026-04-30",
    requiredSkillIds: ["sk_mewp"],
  };

  it("flags a worker booked on work needing a ticket they do not hold", () => {
    const gaps = detectSkillGaps([booking], [skill()], [], { today: TODAY });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind).toBe("missing");
    expect(gaps[0]!.severity).toBe("critical");
    expect(gaps[0]!.explanation).toContain("mandatory");
  });

  it("flags an already-expired ticket", () => {
    const gaps = detectSkillGaps([booking], [skill()], [cell({ expiresAt: "2026-01-01" })], {
      today: TODAY,
    });
    expect(gaps[0]!.kind).toBe("expired");
  });

  it("flags a ticket that lapses part-way through the booking", () => {
    const gaps = detectSkillGaps([booking], [skill()], [cell({ expiresAt: "2026-03-20" })], {
      today: TODAY,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind).toBe("expires_during");
    expect(gaps[0]!.expiresAt).toBe("2026-03-20");
    expect(gaps[0]!.explanation).toContain("nobody catches this by hand");
  });

  it("flags an unverified claim on a ticket that requires evidence", () => {
    const gaps = detectSkillGaps([booking], [skill()], [cell({ status: "claimed" })], {
      today: TODAY,
    });
    expect(gaps[0]!.kind).toBe("unverified");
    expect(gaps[0]!.explanation).toContain("not evidence");
  });

  it("finds nothing when the ticket is valid, verified and outlives the booking", () => {
    expect(detectSkillGaps([booking], [skill()], [cell()], { today: TODAY })).toEqual([]);
  });

  it("ignores a requirement for a skill that no longer exists", () => {
    expect(
      detectSkillGaps(
        [{ ...booking, requiredSkillIds: ["sk_gone"] }],
        [skill()],
        [cell()],
        { today: TODAY },
      ),
    ).toEqual([]);
  });
});
