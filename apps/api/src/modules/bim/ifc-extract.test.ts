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

/* ------------------------------------------------------------------ */
/* Fixture: a small but structurally complete IFC                      */
/* ------------------------------------------------------------------ */

export const WALL_A_GUID = "2O2Fr$t4X7Zf8NOew3FLOH";
export const WALL_B_GUID = "1ABCDEFGHIJKLMNOPQRSTU";
export const DOOR_GUID = "3ZYXWVUTSRQPONMLKJIHGF";
const SITE_GUID = "0SITE00000000000000AAA";
const BUILDING_GUID = "0BLDG00000000000000AAA";
const STOREY_GUID = "0STOREY0000000000000AA";
const SPACE_GUID = "0SPACE00000000000000AA";

/**
 * Wall A is wrapped across three physical lines and its name contains a
 * semicolon and an escaped quote — the two things the old line-based parser
 * silently dropped.
 */
export const IFC_FIXTURE = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('fixture.ifc','2026-08-21T00:00:00',(''),(''),'','','');",
  "ENDSEC;",
  "DATA;",
  "#1=IFCOWNERHISTORY(#2,#3,$,.ADDED.,$,$,$,1234567890);",
  "#2=IFCPERSONANDORGANIZATION(#4,#5,$);",
  "#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);",
  /* spatial structure */
  `#100=IFCSITE('${SITE_GUID}',#1,'Riverside Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);`,
  `#101=IFCBUILDING('${BUILDING_GUID}',#1,'Tower A',$,$,#20,$,$,.ELEMENT.,$,$,$);`,
  `#102=IFCBUILDINGSTOREY('${STOREY_GUID}',#1,'Level 01',$,$,#20,$,$,.ELEMENT.,3000.);`,
  `#103=IFCSPACE('${SPACE_GUID}',#1,'Room 1.01',$,$,#20,$,$,.ELEMENT.,.INTERNAL.,$);`,
  "#110=IFCRELAGGREGATES('0AGG10000000000000AAAA',#1,$,$,#100,(#101));",
  "#111=IFCRELAGGREGATES('0AGG20000000000000AAAA',#1,$,$,#101,(#102));",
  "#112=IFCRELAGGREGATES('0AGG30000000000000AAAA',#1,$,$,#102,(#103));",
  /* elements — wall A wrapped over three lines */
  `#10=IFCWALLSTANDARDCASE('${WALL_A_GUID}',#1,`,
  "  'Wall; North ''A''',$,$,#20,#21,",
  "  'TAG-W1');",
  `#11=IFCWALL('${WALL_B_GUID}',#1,'Wall B',$,$,#30,#22,'TAG-W2');`,
  `#12=IFCDOOR('${DOOR_GUID}',#1,'Door, Main Entrance',$,$,#30,#23,'TAG-D1',2100.,900.);`,
  /* placements: wall B and the door sit 5 m east and 3 m up */
  "#20=IFCLOCALPLACEMENT($,#24);",
  "#24=IFCAXIS2PLACEMENT3D(#25,$,$);",
  "#25=IFCCARTESIANPOINT((0.,0.,0.));",
  "#30=IFCLOCALPLACEMENT(#20,#31);",
  "#31=IFCAXIS2PLACEMENT3D(#32,$,$);",
  "#32=IFCCARTESIANPOINT((5000.,0.,3000.));",
  /* containment */
  "#300=IFCRELCONTAINEDINSPATIALSTRUCTURE('0CNT10000000000000AAAA',#1,$,$,(#10,#11,#12),#102);",
  /* property set on wall A */
  "#400=IFCPROPERTYSET('0PST10000000000000AAAA',#1,'Pset_WallCommon',$,(#401));",
  "#401=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2 HR'),$);",
  "#402=IFCRELDEFINESBYPROPERTIES('0RDP10000000000000AAAA',#1,$,$,(#10),#400);",
  /* quantities on both walls */
  "#410=IFCELEMENTQUANTITY('0EQT10000000000000AAAA',#1,'Qto_WallBaseQuantities',$,$,(#411,#412,#413));",
  "#411=IFCQUANTITYLENGTH('Length',$,$,4000.);",
  "#412=IFCQUANTITYLENGTH('Width',$,$,200.);",
  "#413=IFCQUANTITYLENGTH('Height',$,$,3000.);",
  "#414=IFCRELDEFINESBYPROPERTIES('0RDP20000000000000AAAA',#1,$,$,(#10,#11),#410);",
  /* classification + type on wall A */
  "#420=IFCCLASSIFICATIONREFERENCE('','Ss_25_10_30_60','Wall systems',$);",
  "#421=IFCRELASSOCIATESCLASSIFICATION('0RAC10000000000000AAAA',#1,$,$,(#10),#420);",
  "#430=IFCWALLTYPE('0WTY10000000000000AAAA',#1,'Basic Wall:Interior 100mm',$,$,$,$,$,$,.STANDARD.);",
  "#431=IFCRELDEFINESBYTYPE('0RDT10000000000000AAAA',#1,$,$,(#10,#11),#430);",
  "ENDSEC;",
  "END-ISO-10303-21;",
].join("\n");

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
