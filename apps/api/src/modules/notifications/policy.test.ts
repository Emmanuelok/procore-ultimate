import { describe, expect, it } from "vitest";
import { buildDigest, decideDelivery, nextDigestDue, type PreferenceRow } from "./policy.js";

const pref = (over: Partial<PreferenceRow> = {}): PreferenceRow => ({
  userId: "u1",
  defaultChannel: "in_app",
  digest: "off",
  kinds: {},
  mutedProjectIds: [],
  mutedTools: [],
  ...over,
});

describe("decideDelivery", () => {
  it("delivers in-app by default when the user has no preference row at all", () => {
    expect(decideDelivery({ userId: "u1", kind: "assignment" }, undefined)).toEqual({
      deliver: true,
      channel: "in_app",
      digested: false,
    });
  });

  it("suppresses a muted project", () => {
    expect(
      decideDelivery(
        { userId: "u1", projectId: "p1", kind: "status_change" },
        pref({ mutedProjectIds: ["p1"] }),
      ),
    ).toEqual({ deliver: false, reason: "muted_project" });
  });

  it("suppresses a muted tool", () => {
    expect(
      decideDelivery(
        { userId: "u1", kind: "status_change", tool: "punch" },
        pref({ mutedTools: ["punch"] }),
      ),
    ).toEqual({ deliver: false, reason: "muted_tool" });
  });

  it("suppresses a kind the user turned off", () => {
    expect(
      decideDelivery({ userId: "u1", kind: "status_change" }, pref({ kinds: { status_change: "none" } })),
    ).toEqual({ deliver: false, reason: "kind_disabled" });
  });

  it("never suppresses an escalation, a signal or a review request", () => {
    for (const kind of ["escalation", "signal", "ai_review"]) {
      expect(
        decideDelivery(
          { userId: "u1", projectId: "p1", kind },
          pref({ mutedProjectIds: ["p1"], kinds: { [kind]: "none" } }),
        ),
      ).toEqual({ deliver: true, channel: "in_app", digested: false });
    }
  });

  it("honours a per-kind email channel", () => {
    expect(
      decideDelivery({ userId: "u1", kind: "assignment" }, pref({ kinds: { assignment: "email" } })),
    ).toMatchObject({ deliver: true, channel: "email" });
  });

  it("digests ordinary kinds when a cadence is set, but not urgent ones", () => {
    const daily = pref({ digest: "daily" });
    expect(decideDelivery({ userId: "u1", kind: "status_change" }, daily)).toMatchObject({
      digested: true,
    });
    expect(decideDelivery({ userId: "u1", kind: "overdue" }, daily)).toMatchObject({
      digested: false,
    });
    expect(decideDelivery({ userId: "u1", kind: "mention" }, daily)).toMatchObject({
      digested: false,
    });
  });
});

describe("buildDigest", () => {
  const items = [
    { id: "1", kind: "assignment", title: "A", body: null, projectId: "p1", createdAt: "2026-06-01T09:00:00Z" },
    { id: "2", kind: "assignment", title: "B", body: null, projectId: "p1", createdAt: "2026-06-01T10:00:00Z" },
    { id: "3", kind: "status_change", title: "C", body: null, projectId: "p2", createdAt: "2026-06-01T11:00:00Z" },
    { id: "4", kind: "system", title: "D", body: null, projectId: null, createdAt: "2026-06-01T12:00:00Z" },
  ];

  it("groups by project then kind, biggest project first, company last", () => {
    const digest = buildDigest("u1", items, { since: "s", until: "u" }, new Map([["p1", "Tower"]]));
    expect(digest.sections.map((s) => s.projectId)).toEqual(["p1", "p2", null]);
    expect(digest.sections[0]!.projectName).toBe("Tower");
    expect(digest.sections[0]!.byKind[0]).toMatchObject({ kind: "assignment", count: 2 });
  });

  it("orders items newest-first inside a kind and caps them", () => {
    const digest = buildDigest("u1", items, { since: "s", until: "u" }, new Map(), 1);
    expect(digest.sections[0]!.byKind[0]!.items).toHaveLength(1);
    expect(digest.sections[0]!.byKind[0]!.items[0]!.id).toBe("2");
  });

  it("counts everything and writes an honest subject", () => {
    const digest = buildDigest("u1", items, { since: "s", until: "u" });
    expect(digest.total).toBe(4);
    expect(digest.subject).toContain("4 updates");
  });

  it("says nothing happened rather than inventing a number", () => {
    const digest = buildDigest("u1", [], { since: "s", until: "u" });
    expect(digest.total).toBe(0);
    expect(digest.subject).toBe("Nothing new on ConstructOS");
    expect(digest.sections).toEqual([]);
  });
});

describe("nextDigestDue", () => {
  const now = new Date("2026-06-10T08:00:00Z");

  it("is never due when the cadence is off", () => {
    expect(nextDigestDue("off", null, now)).toBe(false);
  });

  it("is due immediately the first time", () => {
    expect(nextDigestDue("daily", null, now)).toBe(true);
  });

  it("respects the daily and weekly windows", () => {
    expect(nextDigestDue("daily", "2026-06-10T00:00:00Z", now)).toBe(false);
    expect(nextDigestDue("daily", "2026-06-09T00:00:00Z", now)).toBe(true);
    expect(nextDigestDue("weekly", "2026-06-05T00:00:00Z", now)).toBe(false);
    expect(nextDigestDue("weekly", "2026-06-01T00:00:00Z", now)).toBe(true);
  });

  it("treats an unparseable timestamp as due rather than never", () => {
    expect(nextDigestDue("daily", "not-a-date", now)).toBe(true);
  });
});
