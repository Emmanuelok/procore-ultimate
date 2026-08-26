import { describe, expect, it } from "vitest";
import {
  canNotify,
  canRelease,
  canWaive,
  describeParties,
  isUnreleasedPastPlannedDate,
  mayProceedPast,
  noticeStatus,
  parseVerifyingParties,
  summariseActivities,
  type HoldPointActivityLike,
} from "./holdPoints.js";

const HOUR = 3_600_000;

const activity = (over: Partial<HoldPointActivityLike> = {}): HoldPointActivityLike => ({
  id: "act1",
  activity: "Pre-pour reinforcement inspection",
  activityCode: "A-010",
  interventionPoint: "hold_point",
  status: "pending",
  noticePeriodHours: 24,
  plannedDate: "2026-06-01",
  notifiedAt: null,
  notifiedBy: null,
  verifyingParties: [{ party: "engineer", userId: "user-engineer" }],
  releasedBy: null,
  releasedAt: null,
  waivedBy: null,
  waivedAt: null,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Verifying parties                                                   */
/* ------------------------------------------------------------------ */

describe("parseVerifyingParties", () => {
  it("keeps typed entries and discards junk", () => {
    const parties = parseVerifyingParties([
      { party: "engineer", userId: "u1", name: "A. Engineer" },
      { notAParty: true },
      "nonsense",
      null,
    ]);
    expect(parties).toHaveLength(1);
    expect(parties[0]!.party).toBe("engineer");
    expect(describeParties(parties)).toBe("engineer (A. Engineer)");
  });

  it("describes an empty nomination honestly", () => {
    expect(describeParties([])).toBe("(none nominated)");
  });
});

/* ------------------------------------------------------------------ */
/* Notice                                                              */
/* ------------------------------------------------------------------ */

describe("noticeStatus", () => {
  it("reports no notice served when nothing was sent", () => {
    const status = noticeStatus(activity(), Date.now());
    expect(status.served).toBe(false);
    expect(status.noticeExpiresAt).toBeNull();
  });

  it("computes when the notice period runs out", () => {
    const servedAt = new Date("2026-06-01T08:00:00.000Z").toISOString();
    const status = noticeStatus(
      activity({ notifiedAt: servedAt, noticePeriodHours: 24 }),
      Date.parse(servedAt) + 25 * HOUR,
    );
    expect(status.served).toBe(true);
    expect(status.noticeExpiresAt).toBe("2026-06-02T08:00:00.000Z");
    expect(status.noticeElapsed).toBe(true);
  });

  it("refuses to assume a zero notice period when none is recorded", () => {
    const servedAt = new Date("2026-06-01T08:00:00.000Z").toISOString();
    const status = noticeStatus(
      activity({ notifiedAt: servedAt, noticePeriodHours: null }),
      Date.parse(servedAt) + 100 * HOUR,
    );
    expect(status.noticeExpiresAt).toBeNull();
    expect(status.noticeElapsed).toBe(false);
    expect(status.reasons.join(" ")).toContain("No notice period is recorded");
  });
});

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

describe("canNotify", () => {
  it("allows notice on a hold point", () => {
    expect(canNotify(activity()).allowed).toBe(true);
  });

  it("refuses notice on a surveillance point — nobody is summoned to one", () => {
    const decision = canNotify(activity({ interventionPoint: "surveillance_point" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("continuous monitoring");
  });

  it("refuses notice on a point that is already released", () => {
    expect(canNotify(activity({ status: "released" })).allowed).toBe(false);
  });
});

describe("canRelease", () => {
  it("allows the nominated verifying user to release", () => {
    const decision = canRelease(activity(), {
      actorId: "user-engineer",
      raisedBy: "user-contractor",
    });
    expect(decision.allowed).toBe(true);
  });

  it("refuses release by anyone who is not the nominated verifying party", () => {
    const decision = canRelease(activity(), {
      actorId: "user-contractor",
      raisedBy: "user-contractor",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("reserved to the nominated verifying party");
  });

  it("refuses release when no verifying party is nominated at all", () => {
    const decision = canRelease(activity({ verifyingParties: [] }), {
      actorId: "anyone",
      raisedBy: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("No verifying party is nominated");
  });

  it("refuses self-release by the party who raised the point when the verifier is an organisation", () => {
    // the client is nominated by name, not by user account: the platform cannot
    // prove the actor IS the client, and the actor served the notice
    const decision = canRelease(
      activity({
        verifyingParties: [{ party: "client", name: "Owner's Rep" }],
        notifiedBy: "user-contractor",
        status: "notified",
      }),
      { actorId: "user-contractor", raisedBy: "user-contractor" },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("cannot also release it");
  });

  it("allows an organisation-nominated release by somebody who did not raise it", () => {
    const decision = canRelease(
      activity({
        verifyingParties: [{ party: "client", name: "Owner's Rep" }],
        notifiedBy: "user-contractor",
        status: "notified",
      }),
      { actorId: "user-clientrep", raisedBy: "user-contractor" },
    );
    expect(decision.allowed).toBe(true);
  });

  it("refuses a second release of an already-released point", () => {
    const decision = canRelease(
      activity({ status: "released", releasedBy: "user-engineer" }),
      { actorId: "user-engineer", raisedBy: "user-contractor" },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("already released");
  });

  it("refuses release of a surveillance point — there is nothing held", () => {
    const decision = canRelease(activity({ interventionPoint: "surveillance_point" }), {
      actorId: "user-engineer",
      raisedBy: null,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("canWaive", () => {
  it("requires a written reason", () => {
    expect(canWaive(activity(), "").allowed).toBe(false);
    expect(canWaive(activity(), "   ").allowed).toBe(false);
    expect(canWaive(activity(), "Client declined to attend, confirmed by email").allowed).toBe(
      true,
    );
  });

  it("refuses to waive a point that is already closed out", () => {
    expect(canWaive(activity({ status: "waived" }), "again").allowed).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* May work proceed?                                                   */
/* ------------------------------------------------------------------ */

describe("mayProceedPast", () => {
  const now = Date.parse("2026-06-02T12:00:00.000Z");

  it("blocks work past an unreleased hold point", () => {
    const decision = mayProceedPast(activity(), now);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("has not been released");
  });

  it("blocks work past a hold point even after the notice period has run", () => {
    const decision = mayProceedPast(
      activity({
        status: "notified",
        notifiedAt: "2026-06-01T00:00:00.000Z",
        noticePeriodHours: 4,
      }),
      now,
    );
    expect(decision.allowed).toBe(false);
  });

  it("allows work past a released or waived hold point", () => {
    expect(mayProceedPast(activity({ status: "released" }), now).allowed).toBe(true);
    expect(mayProceedPast(activity({ status: "waived" }), now).allowed).toBe(true);
  });

  it("allows work past a witness point once the notice period has run", () => {
    const decision = mayProceedPast(
      activity({
        interventionPoint: "witness_point",
        status: "notified",
        notifiedAt: "2026-06-01T00:00:00.000Z",
        noticePeriodHours: 24,
      }),
      now,
    );
    expect(decision.allowed).toBe(true);
  });

  it("blocks work past a witness point while its notice period is still running", () => {
    const decision = mayProceedPast(
      activity({
        interventionPoint: "witness_point",
        status: "notified",
        notifiedAt: "2026-06-02T08:00:00.000Z",
        noticePeriodHours: 24,
      }),
      now,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("does not run out until");
  });

  it("blocks a witness point notified with no recorded notice period, and says why", () => {
    const decision = mayProceedPast(
      activity({
        interventionPoint: "witness_point",
        status: "notified",
        notifiedAt: "2026-06-01T00:00:00.000Z",
        noticePeriodHours: null,
      }),
      now,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("no notice period recorded");
  });

  it("blocks work past a failed activity", () => {
    expect(mayProceedPast(activity({ status: "failed" }), now).allowed).toBe(false);
  });

  it("lets work continue past a surveillance point, which records rather than gates", () => {
    expect(
      mayProceedPast(activity({ interventionPoint: "surveillance_point" }), now).allowed,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Rollups                                                             */
/* ------------------------------------------------------------------ */

describe("isUnreleasedPastPlannedDate", () => {
  it("fires on an unreleased hold point whose planned date has gone", () => {
    expect(isUnreleasedPastPlannedDate(activity({ plannedDate: "2026-05-01" }), "2026-06-01")).toBe(
      true,
    );
  });

  it("does not fire on the planned date itself", () => {
    expect(isUnreleasedPastPlannedDate(activity({ plannedDate: "2026-06-01" }), "2026-06-01")).toBe(
      false,
    );
  });

  it("does not fire once the point is released, waived or not applicable", () => {
    for (const status of ["released", "waived", "closed", "not_applicable"]) {
      expect(
        isUnreleasedPastPlannedDate(activity({ status, plannedDate: "2026-05-01" }), "2026-06-01"),
      ).toBe(false);
    }
  });

  it("does not fire on a witness point — only hold points stop the work", () => {
    expect(
      isUnreleasedPastPlannedDate(
        activity({ interventionPoint: "witness_point", plannedDate: "2026-05-01" }),
        "2026-06-01",
      ),
    ).toBe(false);
  });
});

describe("summariseActivities", () => {
  it("counts hold and witness points and lists what is blocking", () => {
    const now = Date.parse("2026-06-05T00:00:00.000Z");
    const summary = summariseActivities(
      [
        activity({ id: "h1", plannedDate: "2026-05-01" }),
        activity({ id: "h2", status: "released" }),
        activity({ id: "w1", interventionPoint: "witness_point", status: "pending" }),
        activity({ id: "s1", interventionPoint: "surveillance_point", status: "pending" }),
      ],
      "2026-06-01",
      now,
    );
    expect(summary.activityCount).toBe(4);
    expect(summary.holdPointCount).toBe(2);
    expect(summary.witnessPointCount).toBe(1);
    expect(summary.openHoldPointCount).toBe(1);
    expect(summary.overdueHoldPointIds).toEqual(["h1"]);
    expect(summary.blockingActivityIds).toEqual(["h1", "w1"]);
  });
});
