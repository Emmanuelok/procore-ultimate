import { describe, expect, it } from "vitest";
import {
  ancestorPaths,
  effectiveAclLevel,
  privateSubtreeIds,
  resolveFolderVisibility,
  type FolderRow,
} from "./privacy.js";

const folders: FolderRow[] = [
  { id: "root", path: "/Design", isPrivate: 0, permissions: {} },
  { id: "struct", path: "/Design/Structural", isPrivate: 0, permissions: { u2: "none" } },
  { id: "calcs", path: "/Design/Structural/Calcs", isPrivate: 0, permissions: {} },
  { id: "legal", path: "/Legal Hold", isPrivate: 1, permissions: { u3: "admin" } },
  { id: "claims", path: "/Legal Hold/Claims", isPrivate: 0, permissions: {} },
  { id: "legalish", path: "/Legal Holdings", isPrivate: 0, permissions: {} },
];

describe("private-folder containment (#296)", () => {
  it("hides a private folder and every descendant, but not a sibling with a similar prefix", () => {
    const ids = privateSubtreeIds(folders);
    expect([...ids].sort()).toEqual(["claims", "legal"]);
  });

  it("walks ancestor paths deepest first", () => {
    expect(ancestorPaths("/a/b/c")).toEqual(["/a/b/c", "/a/b", "/a"]);
    expect(ancestorPaths("/a")).toEqual(["/a"]);
  });
});

describe("folder ACL inheritance (#291, #297)", () => {
  const byPath = new Map(folders.map((f) => [f.path, f] as const));

  it("finds the nearest ancestor-or-self entry for a user", () => {
    expect(effectiveAclLevel(folders[2]!, byPath, "u2")).toBe("none");
    expect(effectiveAclLevel(folders[1]!, byPath, "u2")).toBe("none");
    expect(effectiveAclLevel(folders[0]!, byPath, "u2")).toBeNull();
    expect(effectiveAclLevel(folders[4]!, byPath, "u3")).toBe("admin");
  });

  it("applies the tool level where no ACL names the user", () => {
    const vis = resolveFolderVisibility(folders, "u1", "standard", false);
    expect(vis.levels.get("root")).toBe("standard");
    expect(vis.standard.has("calcs")).toBe(true);
    expect(vis.hidden.has("legal")).toBe(true);
    expect(vis.hidden.has("claims")).toBe(true);
    expect(vis.hidden.has("legalish")).toBe(false);
  });

  it("hides a subtree from a user with an explicit `none`", () => {
    const vis = resolveFolderVisibility(folders, "u2", "standard", false);
    expect(vis.hidden.has("struct")).toBe(true);
    expect(vis.hidden.has("calcs")).toBe(true);
    expect(vis.hidden.has("root")).toBe(false);
  });

  it("lets a folder-level admin into the private subtree beneath it", () => {
    const vis = resolveFolderVisibility(folders, "u3", "read", false);
    expect(vis.hidden.has("legal")).toBe(false);
    expect(vis.hidden.has("claims")).toBe(false);
    expect(vis.admin.has("claims")).toBe(true);
    // but `read` elsewhere
    expect(vis.standard.has("root")).toBe(false);
  });

  it("shows everything to a documents admin", () => {
    const vis = resolveFolderVisibility(folders, "owner", "admin", true);
    expect(vis.hidden.size).toBe(0);
  });
});
