/**
 * IFC STEP (ISO 10303-21) extractor — pure, dependency-free, streaming.
 *
 * Covers spec #234-236 (element extraction and version comparison inputs),
 * #248 (model-based location assignment) and feeds the clash engine (#240).
 *
 * WHAT CHANGED AND WHY
 *   The first implementation matched entity instances line by line. ISO
 *   10303-21 terminates an instance with ';', not a newline, and ArchiCAD,
 *   Tekla and several Revit exporters wrap long attribute lists — those files
 *   uploaded "ready" with a fraction of their elements, and the missing GUIDs
 *   could not be resolved by the asset/issue/clash paths even though the
 *   browser viewer rendered them. Tokenising on ';' outside quoted strings
 *   fixes that, and lets the same code consume a read stream chunk by chunk
 *   instead of holding three copies of a 400 MB model in memory.
 *
 * WHAT IT EXTRACTS
 *   - building elements: GlobalId, IfcType, Name, type name, classification
 *   - property sets and element quantities, flattened as "Pset.Property"
 *   - spatial structure (site/building/storey/space) and the container of
 *     every element, so locations can be created from the model (#248)
 *   - an axis-aligned bounding box per element, derived from the placement
 *     chain and Qto_* length/width/height quantities
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   Tessellate geometry. There is no BREP evaluation here: bounds come from
 *   placement plus declared quantities, so an element without quantities has
 *   `bounds: null` and is reported as "no extents" rather than given a fake
 *   box. The clash engine excludes those elements and says so.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ElementBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface ExtractedIfcElement {
  ifcType: string;
  globalId: string;
  name: string | null;
  typeName: string | null;
  classification: string | null;
  /** GlobalId of the spatial container (storey/space) holding the element */
  spatialGlobalId: string | null;
  storey: string | null;
  properties: Record<string, unknown>;
  bounds: ElementBounds | null;
}

export interface ExtractedSpatialNode {
  globalId: string;
  ifcType: string;
  name: string | null;
  /** GlobalId of the parent spatial node (IfcRelAggregates) */
  parentGlobalId: string | null;
}

export interface IfcExtractResult {
  elements: ExtractedIfcElement[];
  spatial: ExtractedSpatialNode[];
  /** number of entity instances seen (elements or not) */
  entityCount: number;
  /** metres per file length unit (1 for metres, 0.001 for millimetres) */
  lengthScale: number;
  /** non-fatal notes about what could not be resolved */
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** Spatial structure: these become locations, never elements (#248). */
const SPATIAL_TYPES = new Set([
  "IFCPROJECT",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
]);

/** Building-element entity allowlist, matched by prefix on the STEP keyword. */
const ELEMENT_TYPE_PREFIXES = [
  "IFCWALL",
  "IFCSLAB",
  "IFCBEAM",
  "IFCCOLUMN",
  "IFCDOOR",
  "IFCWINDOW",
  "IFCSTAIR",
  "IFCROOF",
  "IFCPIPE",
  "IFCDUCT",
  "IFCFLOWTERMINAL",
  "IFCFLOWSEGMENT",
  "IFCFLOWFITTING",
  "IFCFLOWCONTROLLER",
  "IFCENERGYCONVERSIONDEVICE",
  "IFCDISTRIBUTIONELEMENT",
  "IFCBUILDINGELEMENTPROXY",
  "IFCCOVERING",
  "IFCFOOTING",
  "IFCPILE",
  "IFCPLATE",
  "IFCMEMBER",
  "IFCRAILING",
  "IFCCURTAINWALL",
  "IFCREINFORCINGBAR",
  "IFCFURNISHINGELEMENT",
  "IFCSANITARYTERMINAL",
  "IFCCABLECARRIER",
  "IFCCABLESEGMENT",
  "IFCLIGHTFIXTURE",
] as const;

/** Entities kept for resolution even though they are not elements. */
const SUPPORT_TYPES = new Set([
  "IFCPROPERTYSET",
  "IFCPROPERTYSINGLEVALUE",
  "IFCPROPERTYENUMERATEDVALUE",
  "IFCELEMENTQUANTITY",
  "IFCQUANTITYLENGTH",
  "IFCQUANTITYAREA",
  "IFCQUANTITYVOLUME",
  "IFCQUANTITYCOUNT",
  "IFCQUANTITYWEIGHT",
  "IFCLOCALPLACEMENT",
  "IFCAXIS2PLACEMENT3D",
  "IFCCARTESIANPOINT",
  "IFCCLASSIFICATIONREFERENCE",
  "IFCSIUNIT",
  "IFCBOUNDINGBOX",
]);

/** IFC GlobalId: 22 chars of the IFC base64 alphabet. */
const GLOBAL_ID_RE = /^[0-9A-Za-z_$]{22}$/;
const LEADING_GUID_RE = /^'[0-9A-Za-z_$]{22}'/;
const STATEMENT_RE = /^#(\d+)\s*=\s*([A-Z][A-Z0-9_]*)\s*\(([\s\S]*)\)$/;

export function isElementType(ifcType: string): boolean {
  return ELEMENT_TYPE_PREFIXES.some((p) => ifcType.startsWith(p));
}

export function isSpatialType(ifcType: string): boolean {
  return SPATIAL_TYPES.has(ifcType);
}

/* ------------------------------------------------------------------ */
/* Tokenising                                                          */
/* ------------------------------------------------------------------ */

/**
 * Incremental STEP tokeniser: feed it chunks in any size, get complete
 * statements back (';' terminated, quotes and comments respected). An entity
 * that spans twenty lines is one statement; a ';' inside a quoted name is not
 * a terminator.
 */
export class StepTokenizer {
  private buf = "";
  private inString = false;
  private inComment = false;

  /** Feed a chunk; returns every statement completed by it (unterminated tail is kept). */
  push(chunk: string): string[] {
    const out: string[] = [];
    let start = 0;
    const text = chunk;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (this.inComment) {
        if (ch === "*" && text[i + 1] === "/") {
          this.inComment = false;
          // the comment body is discarded, not appended
          start = i + 2;
          i += 1;
        }
        continue;
      }
      if (this.inString) {
        if (ch === "'") {
          if (text[i + 1] === "'") {
            i += 1;
            continue;
          }
          this.inString = false;
        }
        continue;
      }
      if (ch === "'") {
        this.inString = true;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        this.inComment = true;
        this.buf += text.slice(start, i);
        start = i + 2;
        i += 1;
        continue;
      }
      if (ch === ";") {
        this.buf += text.slice(start, i);
        const statement = this.buf.trim();
        if (statement.length > 0) out.push(statement);
        this.buf = "";
        start = i + 1;
      }
    }
    if (!this.inComment) this.buf += text.slice(start);
    return out;
  }

  /** Flush an unterminated tail (a truncated file still yields what it had). */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest.length > 0 ? [rest] : [];
  }
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

/**
 * Strip outer quotes, un-escape `''` → `'` and decode the ISO 10303-21
 * extended sequences a European or Asian model is full of:
 *   \X2\00E9\X0\  (UTF-16 run)   \X\E9  (Latin-1 byte)   \S\i  (high ASCII)
 */
export function decodeStepString(attr: string): string {
  const raw = attr.slice(1, -1).replace(/''/g, "'");
  return decodeIfcText(raw);
}

export function decodeIfcText(raw: string): string {
  let out = raw;
  out = out.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_m, hex: string) => {
    let s = "";
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const code = Number.parseInt(hex.slice(i, i + 4), 16);
      if (Number.isFinite(code) && code > 0) s += String.fromCharCode(code);
    }
    return s;
  });
  out = out.replace(/\\X\\([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  out = out.replace(/\\S\\(.)/g, (_m, ch: string) =>
    String.fromCharCode(ch.charCodeAt(0) + 128),
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

const REF_RE = /^#(\d+)$/;

function refId(attr: string | undefined): number | null {
  if (!attr) return null;
  const m = REF_RE.exec(attr.trim());
  return m ? Number(m[1]) : null;
}

function refList(attr: string | undefined): number[] {
  if (!attr) return [];
  const inner = attr.trim().replace(/^\(/, "").replace(/\)$/, "");
  const out: number[] = [];
  for (const part of inner.split(",")) {
    const id = refId(part.trim());
    if (id !== null) out.push(id);
  }
  return out;
}

/** Parse a STEP typed value: IFCLABEL('2 HR'), IFCBOOLEAN(.T.), 1200., $ */
export function parseStepValue(attr: string | undefined): unknown {
  if (attr === undefined) return null;
  const raw = attr.trim();
  if (raw === "" || raw === "$" || raw === "*") return null;
  if (isQuoted(raw)) return decodeStepString(raw);
  const typed = /^[A-Z][A-Z0-9_]*\s*\(([\s\S]*)\)$/.exec(raw);
  if (typed) return parseStepValue(typed[1]!);
  if (raw === ".T.") return true;
  if (raw === ".F.") return false;
  if (/^\.[A-Z0-9_]+\.$/.test(raw)) return raw.slice(1, -1);
  const num = Number(raw.endsWith(".") ? raw.slice(0, -1) : raw);
  if (Number.isFinite(num) && /^[-+0-9.eE]+$/.test(raw)) return num;
  return raw;
}

function numberList(attr: string | undefined): number[] {
  if (!attr) return [];
  const inner = attr.trim().replace(/^\(/, "").replace(/\)$/, "");
  return inner
    .split(",")
    .map((p) => Number(p.trim().endsWith(".") ? p.trim().slice(0, -1) : p.trim()))
    .filter((n) => Number.isFinite(n));
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

interface Entity {
  type: string;
  attrs: string[];
}

interface ParseOptions {
  /** hard cap on retained entities so one pathological file cannot OOM a worker */
  maxEntities?: number;
}

const DEFAULT_MAX_ENTITIES = 3_000_000;

class IfcModel {
  readonly entities = new Map<number, Entity>();
  entityCount = 0;
  truncated = false;
  lengthScale = 1;
  private inData = false;
  private readonly maxEntities: number;

  constructor(options: ParseOptions = {}) {
    this.maxEntities = options.maxEntities ?? DEFAULT_MAX_ENTITIES;
  }

  /** Feed one tokenised statement. */
  accept(statement: string): void {
    const head = statement.slice(0, 8).toUpperCase();
    if (!this.inData) {
      if (head.startsWith("DATA")) this.inData = true;
      return;
    }
    if (head.startsWith("ENDSEC")) {
      this.inData = false;
      return;
    }
    const m = STATEMENT_RE.exec(statement);
    if (!m) return;
    this.entityCount += 1;
    const type = m[2]!.toUpperCase();
    const body = m[3]!;
    if (!this.keep(type, body)) return;
    if (this.entities.size >= this.maxEntities) {
      this.truncated = true;
      return;
    }
    this.entities.set(Number(m[1]), { type, attrs: splitStepAttrs(body) });
  }

  private keep(type: string, body: string): boolean {
    if (type.startsWith("IFCREL")) return true;
    if (SPATIAL_TYPES.has(type)) return true;
    if (SUPPORT_TYPES.has(type)) return true;
    if (type.endsWith("TYPE")) return true;
    // any rooted product: the first attribute is a 22-char GlobalId
    return LEADING_GUID_RE.test(body.trimStart());
  }
}

function resolveLengthScale(model: IfcModel): number {
  for (const entity of model.entities.values()) {
    if (entity.type !== "IFCSIUNIT") continue;
    // IFCSIUNIT(Dimensions, UnitType, Prefix, Name)
    const unitType = entity.attrs[1] ?? "";
    if (!unitType.includes("LENGTHUNIT")) continue;
    const prefix = (entity.attrs[2] ?? "$").replace(/\./g, "");
    switch (prefix) {
      case "MILLI":
        return 0.001;
      case "CENTI":
        return 0.01;
      case "DECI":
        return 0.1;
      case "KILO":
        return 1000;
      default:
        return 1;
    }
  }
  return 1;
}

/** Resolve an IfcLocalPlacement chain to an absolute (unrotated) origin. */
function placementOrigin(
  model: IfcModel,
  placementId: number | null,
  cache: Map<number, [number, number, number]>,
  depth = 0,
): [number, number, number] {
  if (placementId === null || depth > 64) return [0, 0, 0];
  const cached = cache.get(placementId);
  if (cached) return cached;
  const entity = model.entities.get(placementId);
  if (!entity || entity.type !== "IFCLOCALPLACEMENT") return [0, 0, 0];
  const parent = placementOrigin(model, refId(entity.attrs[0]), cache, depth + 1);
  const axisId = refId(entity.attrs[1]);
  let local: [number, number, number] = [0, 0, 0];
  if (axisId !== null) {
    const axis = model.entities.get(axisId);
    if (axis && (axis.type === "IFCAXIS2PLACEMENT3D" || axis.type === "IFCAXIS2PLACEMENT2D")) {
      const pointId = refId(axis.attrs[0]);
      if (pointId !== null) {
        const point = model.entities.get(pointId);
        if (point && point.type === "IFCCARTESIANPOINT") {
          const coords = numberList(point.attrs[0]);
          local = [coords[0] ?? 0, coords[1] ?? 0, coords[2] ?? 0];
        }
      }
    }
  }
  const abs: [number, number, number] = [
    parent[0] + local[0],
    parent[1] + local[1],
    parent[2] + local[2],
  ];
  cache.set(placementId, abs);
  return abs;
}

function boundsFrom(
  origin: [number, number, number],
  properties: Record<string, unknown>,
  scale: number,
): ElementBounds | null {
  const pick = (...names: string[]): number | null => {
    for (const [key, value] of Object.entries(properties)) {
      const leaf = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
      if (names.includes(leaf) && typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  };
  const length = pick("length", "nominallength");
  const width = pick("width", "nominalwidth", "thickness", "nominalthickness");
  const height = pick("height", "nominalheight", "depth");
  if (length === null && width === null && height === null) return null;
  const halfX = ((length ?? width ?? 0.2) * scale) / 2;
  const halfY = ((width ?? length ?? 0.2) * scale) / 2;
  const h = (height ?? 0.2) * scale;
  const [x, y, z] = [origin[0] * scale, origin[1] * scale, origin[2] * scale];
  return {
    minX: x - halfX,
    maxX: x + halfX,
    minY: y - halfY,
    maxY: y + halfY,
    minZ: z,
    maxZ: z + h,
  };
}

function propertySetInto(
  model: IfcModel,
  target: Record<string, unknown>,
  definitionId: number | null,
): void {
  if (definitionId === null) return;
  const def = model.entities.get(definitionId);
  if (!def) return;
  if (def.type === "IFCPROPERTYSET") {
    const setName = isQuoted(def.attrs[2] ?? "") ? decodeStepString(def.attrs[2]!) : "Pset";
    for (const propId of refList(def.attrs[4])) {
      const prop = model.entities.get(propId);
      if (!prop) continue;
      if (prop.type !== "IFCPROPERTYSINGLEVALUE" && prop.type !== "IFCPROPERTYENUMERATEDVALUE") {
        continue;
      }
      const name = isQuoted(prop.attrs[0] ?? "") ? decodeStepString(prop.attrs[0]!) : null;
      if (!name) continue;
      const value =
        prop.type === "IFCPROPERTYSINGLEVALUE"
          ? parseStepValue(prop.attrs[2])
          : parseStepValue((refList(prop.attrs[2])[0] ?? null) === null ? prop.attrs[2] : "$");
      target[`${setName}.${name}`] = value;
    }
    return;
  }
  if (def.type === "IFCELEMENTQUANTITY") {
    const setName = isQuoted(def.attrs[2] ?? "") ? decodeStepString(def.attrs[2]!) : "Qto";
    for (const qId of refList(def.attrs[5])) {
      const q = model.entities.get(qId);
      if (!q || !q.type.startsWith("IFCQUANTITY")) continue;
      const name = isQuoted(q.attrs[0] ?? "") ? decodeStepString(q.attrs[0]!) : null;
      if (!name) continue;
      target[`${setName}.${name}`] = parseStepValue(q.attrs[3]);
    }
  }
}

/** Build the extraction result from a fully-fed model. */
function finish(model: IfcModel): IfcExtractResult {
  const notes: string[] = [];
  if (model.truncated) notes.push("Entity cap reached — the model was truncated during parsing");
  const scale = resolveLengthScale(model);
  model.lengthScale = scale;

  /* relationships ------------------------------------------------- */
  const propertyDefs = new Map<number, number[]>(); // element expressId → property definition ids
  const containedIn = new Map<number, number>(); // element → spatial structure
  const typeOf = new Map<number, number>(); // element → type entity
  const classificationOf = new Map<number, number>(); // element → classification reference
  const spatialParent = new Map<number, number>(); // spatial child → spatial parent

  for (const entity of model.entities.values()) {
    switch (entity.type) {
      case "IFCRELDEFINESBYPROPERTIES": {
        const definition = refId(entity.attrs[5]);
        if (definition === null) break;
        for (const objectId of refList(entity.attrs[4])) {
          const list = propertyDefs.get(objectId);
          if (list) list.push(definition);
          else propertyDefs.set(objectId, [definition]);
        }
        break;
      }
      case "IFCRELCONTAINEDINSPATIALSTRUCTURE": {
        const structure = refId(entity.attrs[5]);
        if (structure === null) break;
        for (const objectId of refList(entity.attrs[4])) containedIn.set(objectId, structure);
        break;
      }
      case "IFCRELDEFINESBYTYPE": {
        const typeEntity = refId(entity.attrs[5]);
        if (typeEntity === null) break;
        for (const objectId of refList(entity.attrs[4])) typeOf.set(objectId, typeEntity);
        break;
      }
      case "IFCRELASSOCIATESCLASSIFICATION": {
        const reference = refId(entity.attrs[5]);
        if (reference === null) break;
        for (const objectId of refList(entity.attrs[4])) classificationOf.set(objectId, reference);
        break;
      }
      case "IFCRELAGGREGATES": {
        const parent = refId(entity.attrs[4]);
        if (parent === null) break;
        for (const childId of refList(entity.attrs[5])) spatialParent.set(childId, parent);
        break;
      }
      default:
        break;
    }
  }

  /* spatial structure --------------------------------------------- */
  const spatial: ExtractedSpatialNode[] = [];
  const spatialById = new Map<number, ExtractedSpatialNode>();
  for (const [id, entity] of model.entities) {
    if (!SPATIAL_TYPES.has(entity.type)) continue;
    const guid = isQuoted(entity.attrs[0] ?? "") ? decodeStepString(entity.attrs[0]!) : null;
    if (!guid || !GLOBAL_ID_RE.test(guid)) continue;
    const nameAttr = entity.attrs[2];
    const longNameAttr = entity.type === "IFCSPACE" ? entity.attrs[7] : undefined;
    const name = isQuoted(nameAttr ?? "")
      ? decodeStepString(nameAttr!)
      : isQuoted(longNameAttr ?? "")
        ? decodeStepString(longNameAttr!)
        : null;
    const node: ExtractedSpatialNode = {
      globalId: guid,
      ifcType: entity.type,
      name: name && name.length > 0 ? name : null,
      parentGlobalId: null,
    };
    spatial.push(node);
    spatialById.set(id, node);
  }
  for (const [id, node] of spatialById) {
    const parentId = spatialParent.get(id);
    if (parentId === undefined) continue;
    const parent = spatialById.get(parentId);
    if (parent) node.parentGlobalId = parent.globalId;
  }

  /** nearest named storey walking up the spatial tree */
  function storeyOf(structureId: number | undefined): { guid: string | null; storey: string | null } {
    if (structureId === undefined) return { guid: null, storey: null };
    let cursor: number | undefined = structureId;
    const guid = spatialById.get(structureId)?.globalId ?? null;
    let hops = 0;
    while (cursor !== undefined && hops < 32) {
      const entity = model.entities.get(cursor);
      const node = spatialById.get(cursor);
      if (entity?.type === "IFCBUILDINGSTOREY" && node) return { guid, storey: node.name };
      cursor = spatialParent.get(cursor);
      hops += 1;
    }
    const direct = spatialById.get(structureId);
    return { guid, storey: direct?.name ?? null };
  }

  /* elements ------------------------------------------------------- */
  const placementCache = new Map<number, [number, number, number]>();
  const elements: ExtractedIfcElement[] = [];
  let withoutBounds = 0;

  for (const [id, entity] of model.entities) {
    const type = entity.type;
    if (type.startsWith("IFCREL")) continue;
    if (SPATIAL_TYPES.has(type)) continue;
    if (SUPPORT_TYPES.has(type)) continue;
    if (type.endsWith("TYPE")) continue;

    const first = entity.attrs[0];
    if (!first || !isQuoted(first)) continue;
    const guid = decodeStepString(first);
    if (!GLOBAL_ID_RE.test(guid)) continue;
    // Only rooted products; other rooted entities (IfcActor, IfcGroup…) are
    // tolerated exactly as before when they carry a leading GlobalId.
    const nameAttr = entity.attrs[2];
    const name = isQuoted(nameAttr ?? "") ? decodeStepString(nameAttr!) : null;

    const properties: Record<string, unknown> = {};
    for (const definitionId of propertyDefs.get(id) ?? []) {
      propertySetInto(model, properties, definitionId);
    }

    let typeName: string | null = null;
    const typeId = typeOf.get(id);
    if (typeId !== undefined) {
      const typeEntity = model.entities.get(typeId);
      const typeNameAttr = typeEntity?.attrs[2];
      if (isQuoted(typeNameAttr ?? "")) typeName = decodeStepString(typeNameAttr!);
    }

    let classification: string | null = null;
    const classId = classificationOf.get(id);
    if (classId !== undefined) {
      const ref = model.entities.get(classId);
      if (ref) {
        const identification = ref.attrs[1];
        const refName = ref.attrs[2];
        classification = isQuoted(identification ?? "")
          ? decodeStepString(identification!)
          : isQuoted(refName ?? "")
            ? decodeStepString(refName!)
            : null;
      }
    }

    const { guid: spatialGuid, storey } = storeyOf(containedIn.get(id));
    const origin = placementOrigin(model, refId(entity.attrs[5]), placementCache);
    const bounds = boundsFrom(origin, properties, scale);
    if (!bounds) withoutBounds += 1;

    elements.push({
      ifcType: type,
      globalId: guid,
      name: name && name.length > 0 ? name : null,
      typeName,
      classification,
      spatialGlobalId: spatialGuid,
      storey,
      properties,
      bounds,
    });
  }

  if (withoutBounds > 0) {
    notes.push(
      `${withoutBounds} of ${elements.length} elements carry no length/width/height quantities — they have no extents and are excluded from geometric clash tests`,
    );
  }

  return { elements, spatial, entityCount: model.entityCount, lengthScale: scale, notes };
}

/** Extract from a complete STEP document held in memory (small files, tests). */
export function extractIfcElements(text: string, options: ParseOptions = {}): IfcExtractResult {
  const model = new IfcModel(options);
  const tokenizer = new StepTokenizer();
  for (const statement of tokenizer.push(text)) model.accept(statement);
  for (const statement of tokenizer.flush()) model.accept(statement);
  return finish(model);
}

/**
 * Extract from an async stream of chunks (Buffer or string). This is the path
 * the ingestion worker uses: the file is read from storage in 64 KiB pieces
 * and never materialised as one string.
 */
export async function extractIfcFromStream(
  chunks: AsyncIterable<Buffer | string>,
  options: ParseOptions = {},
): Promise<IfcExtractResult> {
  const model = new IfcModel(options);
  const tokenizer = new StepTokenizer();
  for await (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const statement of tokenizer.push(text)) model.accept(statement);
  }
  for (const statement of tokenizer.flush()) model.accept(statement);
  return finish(model);
}
