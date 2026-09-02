import { describe, expect, it } from "vitest";
import {
  canTransition,
  expiredPermits,
  loneWorkerDue,
  overdueEntries,
  type PermitState,
} from "./permits.js";

const NOW = "2026-04-01T10:00:00.000Z";

function permit(partial: Partial<PermitState> = {}): PermitState {
  return {
    status: "draft",
    permitType: "hot_work",
    requestedBy: "usr_requester",
    approvedBy: null,
    validFrom: "2026-04-01T08:00:00.000Z",
    validTo: "2026-04-01T18:00:00.000Z",
    precautions: [],
    utilityScanId: null,
    fireWatchMinutes: null,
    fireWatchCompletedAt: null,
    closedAt: null,
    openEntries: 0,
    ...partial,
  };
}

describe("canTransition", () => {
  it("refuses a transition from the wrong status", () => {
    const r = canTransition(permit({ status: "closed" }), "activate", { userId: "u" }, NOW);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("cannot be");
  });

  it("refuses self-approval", () => {
    const r = canTransition(permit({ status: "requested" }), "approve", { userId: "usr_requester" }, NOW);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("other than the person who requested it");
  });

  it("allows approval by a different person and warns about outstanding precautions", () => {
    const r = canTransition(
      permit({ status: "requested", precautions: [{ item: "Extinguisher present", required: true, done: false }] }),
      "approve",
      { userId: "usr_approver" },
      NOW,
    );
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.warnings[0]).toContain("Extinguisher present");
  });

  it("refuses activation with outstanding required precautions", () => {
    const r = canTransition(
      permit({
        status: "approved",
        approvedBy: "usr_approver",
        precautions: [
          { item: "Gas test", required: true, done: false },
          { item: "Signage", required: false, done: false },
        ],
      }),
      "activate",
      { userId: "usr_approver" },
      NOW,
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("Gas test");
  });

  it("refuses an excavation permit with no utility survey", () => {
    const r = canTransition(
      permit({ status: "approved", approvedBy: "a", permitType: "excavation" }),
      "activate",
      { userId: "a" },
      NOW,
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("utility survey");

    const ok = canTransition(
      permit({ status: "approved", approvedBy: "a", permitType: "excavation", utilityScanId: "scn_1" }),
      "activate",
      { userId: "a" },
      NOW,
    );
    expect(ok.allowed).toBe(true);
  });

  it("refuses activation of an unapproved or lapsed permit", () => {
    expect(canTransition(permit({ status: "approved" }), "activate", { userId: "a" }, NOW).allowed).toBe(false);
    const lapsed = canTransition(
      permit({ status: "approved", approvedBy: "a", validTo: "2026-03-31T10:00:00.000Z" }),
      "activate",
      { userId: "a" },
      NOW,
    );
    expect(lapsed.allowed).toBe(false);
    if (!lapsed.allowed) expect(lapsed.reason).toContain("validity ended");
  });

  it("warns when activation is early rather than refusing", () => {
    const r = canTransition(
      permit({ status: "approved", approvedBy: "a", validFrom: "2026-04-01T14:00:00.000Z" }),
      "activate",
      { userId: "a" },
      NOW,
    );
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.warnings[0]).toContain("does not begin until");
  });

  it("refuses to close a permit with people still inside", () => {
    const r = canTransition(permit({ status: "active", openEntries: 2 }), "close", { userId: "a" }, NOW);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("still recorded inside");
  });

  it("refuses to close hot work before the fire watch is recorded", () => {
    const open = canTransition(
      permit({ status: "active", permitType: "hot_work", fireWatchMinutes: 60 }),
      "close",
      { userId: "a" },
      NOW,
    );
    expect(open.allowed).toBe(false);
    if (!open.allowed) expect(open.reason).toContain("fire watch");

    const done = canTransition(
      permit({ status: "active", permitType: "hot_work", fireWatchMinutes: 60, fireWatchCompletedAt: NOW }),
      "close",
      { userId: "a" },
      NOW,
    );
    expect(done.allowed).toBe(true);
  });

  it("rejects an unknown action", () => {
    const r = canTransition(permit(), "teleport" as "close", { userId: "a" }, NOW);
    expect(r.allowed).toBe(false);
  });
});

describe("overdueEntries", () => {
  it("lists people still inside past their expected exit, worst first", () => {
    const r = overdueEntries(
      [
        { id: "e1", personName: "Alice", enteredAt: "2026-04-01T08:00:00.000Z", expectedExitAt: "2026-04-01T09:00:00.000Z", status: "inside" },
        { id: "e2", personName: "Bob", enteredAt: "2026-04-01T09:30:00.000Z", expectedExitAt: "2026-04-01T09:45:00.000Z", status: "inside" },
        { id: "e3", personName: "Cara", enteredAt: "2026-04-01T09:00:00.000Z", expectedExitAt: "2026-04-01T11:00:00.000Z", status: "inside" },
        { id: "e4", personName: "Dan", enteredAt: "2026-04-01T07:00:00.000Z", expectedExitAt: "2026-04-01T08:00:00.000Z", status: "exited" },
      ],
      NOW,
    );
    expect(r.map((x) => x.personName)).toEqual(["Alice", "Bob"]);
    expect(r[0]?.overdueMinutes).toBe(60);
    expect(r[0]?.insideMinutes).toBe(120);
  });

  it("ignores entries with no expected exit rather than guessing one", () => {
    expect(
      overdueEntries([{ id: "e", personName: "X", enteredAt: "2026-04-01T01:00:00.000Z", expectedExitAt: null, status: "inside" }], NOW),
    ).toEqual([]);
  });
});

describe("loneWorkerDue", () => {
  const session = (partial: Partial<Parameters<typeof loneWorkerDue>[0][number]> = {}) => ({
    id: "lw1",
    personName: "Sam",
    status: "active",
    nextDueAt: "2026-04-01T09:50:00.000Z",
    intervalMinutes: 30,
    missedCount: 0,
    expectedEndAt: null,
    ...partial,
  });

  it("marks a just-missed check-in overdue", () => {
    const r = loneWorkerDue([session()], NOW);
    expect(r).toHaveLength(1);
    expect(r[0]?.action).toBe("overdue");
    expect(r[0]?.lateMinutes).toBe(10);
  });

  it("escalates once a full interval has passed", () => {
    const r = loneWorkerDue([session({ nextDueAt: "2026-04-01T09:20:00.000Z" })], NOW);
    expect(r[0]?.action).toBe("escalate");
    expect(r[0]?.reason).toContain("last known position");
  });

  it("escalates immediately for a session already marked overdue", () => {
    const r = loneWorkerDue([session({ status: "overdue" })], NOW);
    expect(r[0]?.action).toBe("escalate");
  });

  it("escalates a very short interval after five minutes", () => {
    const r = loneWorkerDue([session({ intervalMinutes: 2, nextDueAt: "2026-04-01T09:54:00.000Z" })], NOW);
    expect(r[0]?.action).toBe("escalate");
  });

  it("leaves a session that is not yet due alone", () => {
    expect(loneWorkerDue([session({ nextDueAt: "2026-04-01T10:30:00.000Z" })], NOW)).toEqual([]);
    expect(loneWorkerDue([session({ status: "completed", nextDueAt: "2026-04-01T01:00:00.000Z" })], NOW)).toEqual([]);
  });
});

describe("expiredPermits", () => {
  it("finds open permits past their validity and leaves closed ones alone", () => {
    const rows = [
      { id: "p1", status: "active", validTo: "2026-04-01T09:00:00.000Z" },
      { id: "p2", status: "active", validTo: "2026-04-01T11:00:00.000Z" },
      { id: "p3", status: "closed", validTo: "2026-03-01T09:00:00.000Z" },
      { id: "p4", status: "approved", validTo: null },
      { id: "p5", status: "suspended", validTo: "2026-03-31T09:00:00.000Z" },
    ];
    expect(expiredPermits(rows, NOW).map((p) => p.id)).toEqual(["p1", "p5"]);
  });
});
