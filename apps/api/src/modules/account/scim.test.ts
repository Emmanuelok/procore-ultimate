import { describe, expect, it } from "vitest";
import {
  applyGroupPatch,
  applyUserPatch,
  joinName,
  parseScimFilter,
  scimGroup,
  scimUser,
  splitName,
} from "./scim.js";
import { csvCell } from "./security-routes.js";

/**
 * SCIM 2.0, as pure decisions.
 *
 * The route tests live in security.test.ts; these are the parts that decide
 * WHAT a provider asked for, which is where SCIM implementations actually go
 * wrong: Okta and Entra send the same intent in three different shapes, and an
 * operation that is misread as "no change" deprovisions nobody while reporting
 * success.
 */

describe("filter parsing", () => {
  it("parses the one shape every IdP sends", () => {
    expect(parseScimFilter('userName eq "jane@acme.com"')).toEqual({
      attribute: "username",
      operator: "eq",
      value: "jane@acme.com",
    });
  });

  it("accepts an unquoted value and an active filter", () => {
    expect(parseScimFilter("active eq true")).toEqual({
      attribute: "active",
      operator: "eq",
      value: "true",
    });
  });

  it("returns null for no filter", () => {
    expect(parseScimFilter(undefined)).toBeNull();
    expect(parseScimFilter("   ")).toBeNull();
  });

  it("refuses a filter it cannot honour rather than ignoring it", () => {
    // An IdP that asks for a subset and receives everything will happily
    // deprovision the lot.
    expect(parseScimFilter('userName eq "a" and active eq true')).toBe("invalid");
    expect(parseScimFilter("meta.created gt 2024-01-01")).toBe("invalid");
  });
});

describe("names", () => {
  it("splits on the LAST space, so double-barrelled given names survive", () => {
    expect(splitName("Jane Rivera")).toEqual({ givenName: "Jane", familyName: "Rivera" });
    expect(splitName("Mary Jane Rivera")).toEqual({ givenName: "Mary Jane", familyName: "Rivera" });
    expect(splitName("Prince")).toEqual({ givenName: "Prince", familyName: "" });
  });

  it("prefers formatted, then given+family, then the fallback", () => {
    expect(joinName("Jane R", "Jane", "Rivera", "x")).toBe("Jane R");
    expect(joinName(undefined, "Jane", "Rivera", "x")).toBe("Jane Rivera");
    expect(joinName(undefined, undefined, undefined, "jane@acme.com")).toBe("jane@acme.com");
  });
});

describe("User PATCH", () => {
  it("reads the path form", () => {
    expect(
      applyUserPatch({ Operations: [{ op: "replace", path: "active", value: false }] }),
    ).toEqual({ active: false, unsupported: [] });
  });

  it("reads the value-object form with no path", () => {
    expect(
      applyUserPatch({ Operations: [{ op: "replace", value: { active: false } }] }),
    ).toEqual({ active: false, unsupported: [] });
  });

  it('reads the string "false" providers send instead of a boolean', () => {
    expect(
      applyUserPatch({ Operations: [{ op: "Replace", path: "active", value: "false" }] }),
    ).toEqual({ active: false, unsupported: [] });
    expect(
      applyUserPatch({ Operations: [{ op: "replace", path: "active", value: "True" }] }),
    ).toEqual({ active: true, unsupported: [] });
  });

  it("treats remove on active as deactivation", () => {
    expect(applyUserPatch({ Operations: [{ op: "remove", path: "active" }] })).toEqual({
      active: false,
      unsupported: [],
    });
  });

  it("reads displayName and the name complex", () => {
    expect(
      applyUserPatch({
        Operations: [{ op: "replace", value: { name: { givenName: "Jane", familyName: "Rivera" } } }],
      }),
    ).toEqual({ name: "Jane Rivera", unsupported: [] });
    expect(
      applyUserPatch({ Operations: [{ op: "replace", path: "displayName", value: "Jane R" }] }),
    ).toEqual({ name: "Jane R", unsupported: [] });
  });

  it("collects what it does not understand instead of dropping it", () => {
    const result = applyUserPatch({
      Operations: [
        { op: "replace", path: "active", value: false },
        { op: "add", path: "phoneNumbers", value: [{ value: "+44" }] },
      ],
    });
    expect(result.active).toBe(false);
    expect(result.unsupported).toEqual(["phoneNumbers"]);
  });

  it("rejects a document with no Operations", () => {
    expect(() => applyUserPatch({ Operations: [] })).toThrow();
    expect(() => applyUserPatch({})).toThrow();
  });
});

describe("Group PATCH", () => {
  it("reads add and remove on members", () => {
    expect(
      applyGroupPatch({
        Operations: [
          { op: "add", path: "members", value: [{ value: "u1" }, { value: "u2" }] },
          { op: "remove", path: "members", value: [{ value: "u3" }] },
        ],
      }),
    ).toEqual({ add: ["u1", "u2"], remove: ["u3"], replaceWith: null, unsupported: [] });
  });

  it("reads the filtered-path removal Entra sends", () => {
    expect(
      applyGroupPatch({ Operations: [{ op: "remove", path: 'members[value eq "u9"]' }] }),
    ).toEqual({ add: [], remove: ["u9"], replaceWith: null, unsupported: [] });
  });

  it("treats replace on members as the exact set", () => {
    expect(
      applyGroupPatch({ Operations: [{ op: "replace", path: "members", value: [{ value: "u1" }] }] }),
    ).toEqual({ add: [], remove: [], replaceWith: ["u1"], unsupported: [] });
  });

  it("accepts bare string members", () => {
    expect(
      applyGroupPatch({ Operations: [{ op: "add", path: "members", value: ["u7"] }] }).add,
    ).toEqual(["u7"]);
  });
});

describe("representations", () => {
  it("marks a user without a membership as inactive, whatever the account says", () => {
    const row = {
      id: "u1",
      email: "jane@acme.com",
      name: "Jane Rivera",
      isActive: true,
      role: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const body = scimUser(row, "/api/v1/scim/v2") as Record<string, unknown>;
    expect(body["active"]).toBe(false);
    expect(body["groups"]).toEqual([]);
    expect(body["userName"]).toBe("jane@acme.com");
    expect((body["meta"] as Record<string, unknown>)["location"]).toBe("/api/v1/scim/v2/Users/u1");
  });

  it("names the role group a member belongs to", () => {
    const body = scimUser(
      {
        id: "u1",
        email: "jane@acme.com",
        name: "Jane Rivera",
        isActive: true,
        role: "admin",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      "/scim",
    ) as Record<string, unknown>;
    expect(body["active"]).toBe(true);
    expect(body["groups"]).toEqual([{ value: "role:admin", display: "admin", type: "direct" }]);
  });

  it("renders a group as a role with its members", () => {
    const body = scimGroup("member", [{ id: "u1", name: "Jane" }], "/scim") as Record<string, unknown>;
    expect(body["id"]).toBe("role:member");
    expect(body["displayName"]).toBe("member");
    expect(body["members"]).toEqual([{ value: "u1", display: "Jane", type: "User" }]);
  });
});

describe("CSV export quoting", () => {
  it("quotes only what would break the file", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("has,comma")).toBe('"has,comma"');
    expect(csvCell('has"quote')).toBe('"has""quote"');
    expect(csvCell("has\nnewline")).toBe('"has\nnewline"');
  });
});
