/**
 * Minimal IFC STEP (ISO 10303-21) element extractor.
 *
 * Foundation-level parser: it walks the DATA section line by line, picks out
 * entity instance lines (`#id = IFCTYPE(attr, attr, ...);`) and extracts the
 * persistent GlobalId + Name for building-element entities. Geometry and
 * property sets are intentionally ignored at this stage — `properties` stays
 * an empty bag until a full pset pass exists.
 *
 * Attribute splitting respects single-quoted STEP strings (with `''` as the
 * escaped quote) and nested parenthesised aggregates, so names containing
 * commas or quotes survive intact.
 */

export interface ExtractedIfcElement {
  ifcType: string;
  globalId: string;
  name: string | null;
}

export interface IfcExtractResult {
  elements: ExtractedIfcElement[];
  /** number of IFC entity instance lines seen (elements or not) */
  entityCount: number;
}

/** Building-element entity allowlist, matched by prefix on the STEP keyword. */
const ELEMENT_TYPE_PREFIXES = [
  "IFCWALL", // IFCWALL, IFCWALLSTANDARDCASE, IFCWALLELEMENTEDCASE
  "IFCSLAB",
  "IFCBEAM",
  "IFCCOLUMN",
  "IFCDOOR",
  "IFCWINDOW",
  "IFCSTAIR", // IFCSTAIR, IFCSTAIRFLIGHT
  "IFCROOF",
  "IFCPIPE", // IFCPIPESEGMENT, IFCPIPEFITTING
  "IFCDUCT", // IFCDUCTSEGMENT, IFCDUCTFITTING
  "IFCFLOWTERMINAL",
  "IFCBUILDINGELEMENTPROXY",
  "IFCCOVERING",
  "IFCFOOTING",
  "IFCPILE",
  "IFCPLATE",
  "IFCMEMBER",
  "IFCRAILING",
  "IFCCURTAINWALL",
  "IFCSPACE",
  "IFCFURNISHINGELEMENT",
  "IFCSANITARYTERMINAL",
] as const;

/** IFC GlobalId: 22 chars of the IFC base64 alphabet. */
const GLOBAL_ID_RE = /^[0-9A-Za-z_$]{22}$/;

const ENTITY_LINE_RE = /^#(\d+)\s*=\s*(IFC[A-Z0-9]+)\s*\((.*)\);?$/;

export function isElementType(ifcType: string): boolean {
  return ELEMENT_TYPE_PREFIXES.some((p) => ifcType.startsWith(p));
}

/**
 * Split a STEP attribute list on top-level commas, respecting single-quoted
 * strings (`''` escapes a quote) and nested parentheses.
 */
export function splitStepAttrs(raw: string): string[] {
  const attrs: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          current += "''";
          i += 1;
          continue;
        }
        inString = false;
      }
      current += ch;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      attrs.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0 || attrs.length > 0) attrs.push(current.trim());
  return attrs;
}

function isQuoted(attr: string): boolean {
  return attr.length >= 2 && attr.startsWith("'") && attr.endsWith("'");
}

/** Strip outer quotes and un-escape `''` → `'`. */
export function decodeStepString(attr: string): string {
  return attr.slice(1, -1).replace(/''/g, "'");
}

/**
 * Extract building elements from IFC STEP text.
 *
 * - Allowlisted building-element types: GlobalId is the first quoted string
 *   attribute (must look like a 22-char IFC GUID), Name is the next quoted
 *   string attribute (IFC attr order: GlobalId, OwnerHistory ref, Name, ...).
 * - Any other IFC* entity is tolerated as an element when its first attribute
 *   is a quoted 22-char GlobalId (rooted product entities), except IFCREL*
 *   relationship entities, which carry GlobalIds but are not elements.
 */
export function extractIfcElements(text: string): IfcExtractResult {
  // isolate the DATA section when present
  let body = text;
  const dataIdx = text.search(/^\s*DATA\s*;/m);
  if (dataIdx >= 0) {
    const after = text.slice(dataIdx);
    const endIdx = after.search(/^\s*ENDSEC\s*;/m);
    body = endIdx >= 0 ? after.slice(0, endIdx) : after;
  }

  const elements: ExtractedIfcElement[] = [];
  let entityCount = 0;

  for (const rawLine of body.split(/\r?\n/)) {
    const match = ENTITY_LINE_RE.exec(rawLine.trim());
    if (!match) continue;
    entityCount += 1;

    const ifcType = match[2]!;
    if (ifcType.startsWith("IFCREL")) continue; // relationships, not elements

    const attrs = splitStepAttrs(match[3]!);
    if (attrs.length === 0) continue;

    const quoted: string[] = [];
    for (const attr of attrs) {
      if (isQuoted(attr)) quoted.push(decodeStepString(attr));
    }
    const candidate = quoted[0];
    if (candidate === undefined || !GLOBAL_ID_RE.test(candidate)) continue;

    if (!isElementType(ifcType)) {
      // generic tolerance: the GlobalId must literally be the first attribute
      const first = attrs[0]!;
      if (!isQuoted(first) || decodeStepString(first) !== candidate) continue;
    }

    const name = quoted[1];
    elements.push({
      ifcType,
      globalId: candidate,
      name: name !== undefined && name.length > 0 ? name : null,
    });
  }

  return { elements, entityCount };
}
