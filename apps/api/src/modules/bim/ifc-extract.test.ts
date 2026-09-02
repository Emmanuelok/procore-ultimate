import { describe, expect, it } from "vitest";
import {
  StepTokenizer,
  decodeIfcText,
  decodeStepString,
  extractIfcElements,
  extractIfcFromStream,
  isElementType,
  isSpatialType,
  parseStepValue,
  splitStepAttrs,
} from "./ifc-extract.js";

import {
  DOOR_GUID,
  IFC_FIXTURE,
  STOREY_GUID,
  WALL_A_GUID,
  WALL_B_GUID,
} from "./fixtures.js";

/* ------------------------------------------------------------------ */

describe("STEP tokenising", () => {
  it("splits attributes respecting quotes and nested parens", () => {
    const attrs = splitStepAttrs("'a, b ''c''',#1,$,(#2,#3),2100.");
    expect(attrs).toEqual(["'a, b ''c'''", "#1", "$", "(#2,#3)", "2100."]);
    expect(decodeStepString(attrs[0]!)).toBe("a, b 'c'");
  });

  it("terminates statements on ';' outside quotes, across chunk boundaries", () => {
    const tokenizer = new StepTokenizer();
    const first = tokenizer.push("#1=IFCWALL('a;b'");
    expect(first).toEqual([]);
    const second = tokenizer.push(",'x');#2=IFCDOOR('y');");
    expect(second).toEqual(["#1=IFCWALL('a;b','x')", "#2=IFCDOOR('y')"]);
    expect(tokenizer.flush()).toEqual([]);
  });

  it("skips /* */ comments", () => {
    const tokenizer = new StepTokenizer();
    expect(tokenizer.push("/* a ; comment */#1=IFCWALL('x');")).toEqual(["#1=IFCWALL('x')"]);
  });

  it("decodes IFC extended string escapes", () => {
    expect(decodeIfcText("Caf\\X2\\00E9\\X0\\ Wall")).toBe("Café Wall");
    expect(decodeIfcText("Gr\\X\\FCn")).toBe("Grün");
  });

  it("parses typed STEP values", () => {
    expect(parseStepValue("IFCLABEL('2 HR')")).toBe("2 HR");
    expect(parseStepValue("IFCBOOLEAN(.T.)")).toBe(true);
    expect(parseStepValue("4000.")).toBe(4000);
    expect(parseStepValue("$")).toBeNull();
    expect(parseStepValue(".INTERNAL.")).toBe("INTERNAL");
  });

  it("classifies element and spatial types", () => {
    expect(isElementType("IFCWALLSTANDARDCASE")).toBe(true);
    expect(isSpatialType("IFCBUILDINGSTOREY")).toBe(true);
    expect(isSpatialType("IFCWALL")).toBe(false);
  });
});

describe("IFC extraction", () => {
  const result = extractIfcElements(IFC_FIXTURE);

  it("extracts 2 walls + 1 door and keeps spatial entities out of the element set", () => {
    expect(result.elements).toHaveLength(3);
    const types = result.elements.map((e) => e.ifcType).sort();
    expect(types).toEqual(["IFCDOOR", "IFCWALL", "IFCWALLSTANDARDCASE"]);
    expect(result.spatial.map((s) => s.ifcType).sort()).toEqual([
      "IFCBUILDING",
      "IFCBUILDINGSTOREY",
      "IFCSITE",
      "IFCSPACE",
    ]);
  });

  it("reads a wrapped entity whose name contains a semicolon and a quote", () => {
    const wall = result.elements.find((e) => e.globalId === WALL_A_GUID);
    expect(wall).toBeDefined();
    expect(wall!.name).toBe("Wall; North 'A'");
  });

  it("resolves the spatial hierarchy and the storey of each element", () => {
    const storey = result.spatial.find((s) => s.ifcType === "IFCBUILDINGSTOREY");
    const building = result.spatial.find((s) => s.ifcType === "IFCBUILDING");
    expect(storey?.parentGlobalId).toBe(building?.globalId);
    for (const element of result.elements) {
      expect(element.storey).toBe("Level 01");
      expect(element.spatialGlobalId).toBe(STOREY_GUID);
    }
  });

  it("flattens property sets and quantities as Pset.Property", () => {
    const wall = result.elements.find((e) => e.globalId === WALL_A_GUID)!;
    expect(wall.properties["Pset_WallCommon.FireRating"]).toBe("2 HR");
    expect(wall.properties["Qto_WallBaseQuantities.Length"]).toBe(4000);
    const door = result.elements.find((e) => e.globalId === DOOR_GUID)!;
    expect(Object.keys(door.properties)).toHaveLength(0);
  });

  it("reads classification and type name", () => {
    const wall = result.elements.find((e) => e.globalId === WALL_A_GUID)!;
    expect(wall.classification).toBe("Ss_25_10_30_60");
    expect(wall.typeName).toBe("Basic Wall:Interior 100mm");
  });

  it("derives millimetre-scaled bounds from placement and quantities", () => {
    expect(result.lengthScale).toBe(0.001);
    const wallA = result.elements.find((e) => e.globalId === WALL_A_GUID)!;
    expect(wallA.bounds).toEqual({
      minX: -2,
      maxX: 2,
      minY: -0.1,
      maxY: 0.1,
      minZ: 0,
      maxZ: 3,
    });
    // wall B inherits the parent placement: 5 m east, 3 m up
    const wallB = result.elements.find((e) => e.globalId === WALL_B_GUID)!;
    expect(wallB.bounds?.minX).toBeCloseTo(3, 6);
    expect(wallB.bounds?.minZ).toBeCloseTo(3, 6);
  });

  it("reports elements with no extents instead of inventing a box", () => {
    const door = result.elements.find((e) => e.globalId === DOOR_GUID)!;
    expect(door.bounds).toBeNull();
    expect(result.notes.join(" ")).toContain("no length/width/height quantities");
  });

  it("returns zero entities for non-STEP content", () => {
    const empty = extractIfcElements("this is not an ifc file at all");
    expect(empty.entityCount).toBe(0);
    expect(empty.elements).toHaveLength(0);
  });

  it("produces the same result when streamed in small chunks", async () => {
    async function* chunks() {
      for (let i = 0; i < IFC_FIXTURE.length; i += 17) {
        yield IFC_FIXTURE.slice(i, i + 17);
      }
    }
    const streamed = await extractIfcFromStream(chunks());
    expect(streamed.elements.map((e) => e.globalId).sort()).toEqual(
      result.elements.map((e) => e.globalId).sort(),
    );
    expect(streamed.spatial).toHaveLength(result.spatial.length);
  });

  it("stops at the entity cap instead of growing without bound", () => {
    const big = extractIfcElements(IFC_FIXTURE, { maxEntities: 3 });
    expect(big.notes.join(" ")).toContain("Entity cap reached");
  });
});
