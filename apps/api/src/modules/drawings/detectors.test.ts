import { describe, expect, it } from "vitest";
import { detectSheetMetaPositioned } from "./detectors.js";
import type { PositionedItem } from "./pdf.js";

const it_ = (t: string, x: number, y: number, w = 0.05, h = 0.01): PositionedItem => ({ t, x, y, w, h });

describe("positioned title-block detection (#257, #258)", () => {
  it("prefers a number in the bottom-right title block over one in a note", () => {
    const items = [
      it_("SEE DETAIL 3/A-501", 0.1, 0.1),
      it_("REFER TO A-102 FOR FINISHES", 0.2, 0.3),
      it_("FLOOR PLAN LEVEL 1", 0.8, 0.9, 0.12, 0.016),
      it_("A-101", 0.9, 0.95, 0.04, 0.02),
    ];
    const det = detectSheetMetaPositioned(items, items.map((i) => i.t).join("\n"));
    expect(det.number).toBe("A-101");
    expect(det.title).toBe("FLOOR PLAN LEVEL 1");
    expect(det.method).toBe("title_block");
    expect(det.discipline).toBe("architectural");
    expect(det.confident).toBe(true);
    expect(det.confidence).toBeGreaterThanOrEqual(0.85);
    expect(det.confidence).toBeLessThan(1);
    expect(det.candidates[0]?.number).toBe("A-101");
    expect(det.isIndexPage).toBe(false);
  });

  it("falls back to the text stream with lower confidence when nothing sits in the title block", () => {
    const items = [it_("GENERAL NOTES", 0.1, 0.1, 0.1, 0.015), it_("G-001", 0.1, 0.2)];
    const det = detectSheetMetaPositioned(items, "GENERAL NOTES\nG-001");
    expect(det.number).toBe("G-001");
    expect(det.method).toBe("text_stream");
    expect(det.confidence).toBeLessThan(0.85);
  });

  it("recognises a drawing index page and refuses to give it a number", () => {
    const items = [it_("DRAWING INDEX", 0.5, 0.05, 0.1, 0.02)];
    for (let i = 1; i <= 9; i++) items.push(it_(`A-10${i} FLOOR PLAN LEVEL ${i}`, 0.1, 0.1 + i * 0.05));
    const det = detectSheetMetaPositioned(items, items.map((i) => i.t).join("\n"));
    expect(det.isIndexPage).toBe(true);
    expect(det.number).toBeNull();
    expect(det.method).toBe("placeholder");
    expect(det.candidates.length).toBeGreaterThan(0);
  });

  it("reports a page with no text layer honestly", () => {
    const det = detectSheetMetaPositioned([], "");
    expect(det.noTextLayer).toBe(true);
    expect(det.number).toBeNull();
    expect(det.method).toBe("placeholder");
    expect(det.confidence).toBe(0);
  });

  it("ignores callout-shaped lines when scoring candidates", () => {
    const items = [it_("SEE 5/A-401", 0.9, 0.95), it_("S-201", 0.85, 0.9, 0.04, 0.02)];
    const det = detectSheetMetaPositioned(items, "SEE 5/A-401\nS-201");
    expect(det.number).toBe("S-201");
  });
});
