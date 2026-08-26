/**
 * Pure parsing heuristics for the spec pipeline (spec Vol I §2.3, module M19).
 *
 * A spec book arrives as one PDF. Everything downstream — the section a
 * submittal is registered against, the clause an NCR cites, the paragraph a
 * conflict is anchored at — depends on splitting that PDF correctly, so the
 * splitting lives here as dependency-free pure functions that can be tested
 * against the messy strings a real title block and a real TOC produce.
 *
 * The same discipline as `modules/drawings/detectors.ts`: no database, no
 * Fastify, no I/O. Every function returns a CONFIDENCE alongside its answer,
 * because a heading read by a regex and a heading typed by an engineer are
 * not the same fact and the platform must never present them as one.
 */

import type { SubmittalType } from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Section codes                                                       */
/* ------------------------------------------------------------------ */

/** Strip separators from a section code: "03 30 00" and "03-30-00" → "033000". */
export function normaliseSectionCode(code: string): string {
  return code.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/** MasterFormat 2020 division titles, for books that never spell them out. */
const DIVISION_TITLES: Record<string, string> = {
  "00": "Procurement and Contracting Requirements",
  "01": "General Requirements",
  "02": "Existing Conditions",
  "03": "Concrete",
  "04": "Masonry",
  "05": "Metals",
  "06": "Wood, Plastics, and Composites",
  "07": "Thermal and Moisture Protection",
  "08": "Openings",
  "09": "Finishes",
  "10": "Specialties",
  "11": "Equipment",
  "12": "Furnishings",
  "13": "Special Construction",
  "14": "Conveying Equipment",
  "21": "Fire Suppression",
  "22": "Plumbing",
  "23": "Heating, Ventilating, and Air Conditioning (HVAC)",
  "25": "Integrated Automation",
  "26": "Electrical",
  "27": "Communications",
  "28": "Electronic Safety and Security",
  "31": "Earthwork",
  "32": "Exterior Improvements",
  "33": "Utilities",
  "34": "Transportation",
  "35": "Waterway and Marine Construction",
  "40": "Process Interconnections",
  "41": "Material Processing and Handling Equipment",
  "42": "Process Heating, Cooling, and Drying Equipment",
  "43": "Process Gas and Liquid Handling, Purification, and Storage Equipment",
  "44": "Pollution and Waste Control Equipment",
  "45": "Industry-Specific Manufacturing Equipment",
  "46": "Water and Wastewater Equipment",
  "48": "Electrical Power Generation",
};

/** Canonical MasterFormat title for a two-digit division, or null if unknown. */
export function divisionTitle(divisionCode: string): string | null {
  return DIVISION_TITLES[divisionCode.padStart(2, "0")] ?? null;
}

/* ------------------------------------------------------------------ */
/* Heading detection                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedSectionHeading {
  /** code as written, normalised to single spaces: "03 30 00", "05 12 00.13" */
  code: string;
  /** separators stripped, for tolerant matching: "033000" */
  normalisedCode: string;
  title: string;
  divisionCode: string;
  /** 0..1 — never 1: a regex reading is never a human reading */
  confidence: number;
}

/** TOC dot leaders and a trailing page number: "… Concrete ....... 12". */
const LEADER_RE = /[.·•]{3,}\s*\d{1,4}\s*$/;
/** A bare trailing page number after 2+ spaces: "CAST-IN-PLACE CONCRETE   12". */
const TRAILING_PAGE_RE = /\s{2,}\d{1,4}\s*$/;
const DASHES = /[‐‑‒–—―]/g;

function tidy(line: string): string {
  return line.replace(DASHES, "-").replace(/\s+/g, " ").trim();
}

function stripLeaders(line: string): string {
  let out = line.replace(LEADER_RE, "");
  if (out === line) out = line.replace(TRAILING_PAGE_RE, "");
  return out.trim();
}

/** Letters only, for "is this actually a title" tests. */
function letterCount(s: string): number {
  return s.replace(/[^A-Za-z]/g, "").length;
}

/**
 * Lines that look like a section heading but are the section's own running
 * footer, a part heading, or an article number.
 */
const NOT_A_HEADING_RE =
  /^(PART\s+\d|APPENDIX\b|TABLE OF CONTENTS|END OF SECTION|INDEX\b|VOLUME\b)/i;

/**
 * Parse one line as a section heading.
 *
 * Accepts, in order of confidence:
 *   SECTION 03 30 00 - CAST-IN-PLACE CONCRETE      (keyword + separator)
 *   SECTION 260519—LOW-VOLTAGE ... CABLES           (keyword, no spaces)
 *   03 30 00 Cast-in-Place Concrete .......... 12   (TOC row)
 *   03300 CONCRETE WORK                             (MasterFormat 1995)
 *
 * Refuses a line whose code is not at the start ("Refer to Section 03 30 00
 * for concrete."), a part/article number ("1.3 SUBMITTALS", "2.03 MATERIALS")
 * and a running footer ("03 30 00 - 3").
 */
export function parseSectionHeading(rawLine: string): ParsedSectionHeading | null {
  // Leaders are stripped BEFORE whitespace is collapsed: "JOINT SEALANTS   14"
  // only reads as a TOC row while the run of spaces is still there.
  const line = tidy(stripLeaders(rawLine));
  if (line === "" || NOT_A_HEADING_RE.test(line)) return null;

  const keyword = /^SECTION\s*[:\-]?\s*/i.exec(line);
  const rest = keyword ? line.slice(keyword[0].length) : line;

  // Six-digit MasterFormat 2020/1995 with optional level-4 suffix, then the
  // five-digit MasterFormat 1995 form. Anchored: the code opens the line.
  const six = /^(\d{2})[ .\-]?(\d{2})[ .\-]?(\d{2})(\.\d{1,2})?(?![\d.])/.exec(rest);
  const five = six ? null : /^(\d{2})(\d{3})(?![\d.])/.exec(rest);
  if (!six && !five) return null;

  let code: string;
  let divisionCode: string;
  let consumed: number;
  if (six) {
    divisionCode = six[1]!;
    code = `${six[1]} ${six[2]} ${six[3]}${six[4] ?? ""}`;
    consumed = six[0].length;
  } else {
    divisionCode = five![1]!;
    code = `${five![1]}${five![2]}`;
    consumed = five![0].length;
  }

  let title = rest.slice(consumed).trim();
  // `tidy` has already folded every dash variant to "-".
  const separated = /^[-:]/.test(title);
  title = title.replace(/^[-:]+\s*/, "").trim();
  title = stripLeaders(title);
  // A running footer ("03 30 00 - 3") leaves a bare page number behind.
  if (letterCount(title) < 3) return null;
  // An article number that happened to look like a code would leave a title
  // that is itself numbered ("1.3 SUBMITTALS" never reaches here, but
  // "12 34 56 1. Foo" would).
  if (/^\d+\.\s/.test(title)) return null;

  let confidence: number;
  if (keyword && separated) confidence = 0.95;
  else if (keyword) confidence = 0.85;
  else if (separated) confidence = 0.8;
  else confidence = 0.65;
  if (!DIVISION_TITLES[divisionCode]) confidence -= 0.1;

  return {
    code,
    normalisedCode: normaliseSectionCode(code),
    title,
    divisionCode,
    confidence: Math.round(Math.max(0.3, Math.min(0.95, confidence)) * 100) / 100,
  };
}

export interface ParsedDivisionHeading {
  code: string;
  title: string;
  confidence: number;
}

/** "DIVISION 03 - CONCRETE", "Division 26 — ELECTRICAL", "DIVISION 3". */
export function parseDivisionHeading(rawLine: string): ParsedDivisionHeading | null {
  const line = tidy(stripLeaders(rawLine));
  const m = /^DIVISION\s+(\d{1,2})\s*[-:]?\s*(.*)$/i.exec(line);
  if (!m) return null;
  const code = m[1]!.padStart(2, "0");
  const written = stripLeaders(m[2] ?? "").replace(/^[-:]+\s*/, "").trim();
  const title = letterCount(written) >= 3 ? written : (divisionTitle(code) ?? `Division ${code}`);
  return {
    code,
    title,
    confidence: letterCount(written) >= 3 ? 0.9 : 0.6,
  };
}

export interface HeadingHit extends ParsedSectionHeading {
  /** index of the line the heading was found on */
  lineIndex: number;
}

/**
 * Scan a block of text for section headings, tolerating the two-line form a
 * cover page uses ("SECTION 03 30 00" then the title on the next line).
 */
export function detectSectionHeadings(text: string): HeadingHit[] {
  const lines = text.split("\n");
  const hits: HeadingHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const direct = parseSectionHeading(raw);
    if (direct) {
      hits.push({ ...direct, lineIndex: i });
      continue;
    }
    // Two-line form: a bare code, with the title on the following line.
    const bare = /^\s*(?:SECTION\s*)?(\d{2})[ .\-]?(\d{2})[ .\-]?(\d{2})(\.\d{1,2})?\s*$/i.exec(
      tidy(raw),
    );
    if (!bare) continue;
    const next = tidy(lines[i + 1] ?? "");
    if (next === "" || letterCount(next) < 3 || next.length > 120) continue;
    if (NOT_A_HEADING_RE.test(next) || /^\d/.test(next)) continue;
    const code = `${bare[1]} ${bare[2]} ${bare[3]}${bare[4] ?? ""}`;
    hits.push({
      code,
      normalisedCode: normaliseSectionCode(code),
      title: stripLeaders(next),
      divisionCode: bare[1]!,
      confidence: 0.6,
      lineIndex: i,
    });
    i += 1;
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* CSI three-part structure and clause refs                            */
/* ------------------------------------------------------------------ */

export interface SpecClause {
  /** "1.3.B.2" — the citation a requirement or a conflict is anchored at */
  ref: string;
  part: number | null;
  partTitle: string | null;
  article: string | null;
  articleTitle: string | null;
  text: string;
  lineIndex: number;
}

const PART_RE = /^PART\s+([123])\b\s*[-:]?\s*(.*)$/i;
const ARTICLE_RE = /^(\d{1,2}\.\d{1,2})\s+(\S.*)$/;
const LETTER_RE = /^([A-Z])\.\s+(\S.*)$/;
const ARABIC_RE = /^(\d{1,2})\.\s+(\S.*)$/;
const LOWER_RE = /^([a-z])\.\s+(\S.*)$/;
const FOOTER_RE = /^(?:\d{2}[ .\-]?\d{2}[ .\-]?\d{2}\s*-\s*\d{1,3}|Page\s+\d+(?:\s+of\s+\d+)?)$/i;

/**
 * Split a section's text into numbered clauses.
 *
 * PDF text extraction loses indentation but keeps the leading markers, so the
 * hierarchy is rebuilt from the markers alone: article (1.3) → letter (B) →
 * arabic (2) → lowercase (a). Unmarked lines continue the clause above them,
 * which is what a wrapped sentence looks like after extraction.
 */
export function parseClauses(text: string): SpecClause[] {
  const lines = text.split("\n");
  const clauses: SpecClause[] = [];
  let part: number | null = null;
  let partTitle: string | null = null;
  let article: string | null = null;
  let articleTitle: string | null = null;
  let letter: string | null = null;
  let arabic: string | null = null;
  /** index into `clauses` of the clause a wrapped line continues, or -1 */
  let openIndex = -1;

  const push = (ref: string, body: string, lineIndex: number) => {
    clauses.push({ ref, part, partTitle, article, articleTitle, text: body.trim(), lineIndex });
    openIndex = clauses.length - 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = tidy(lines[i] ?? "");
    if (line === "" || FOOTER_RE.test(line) || /^END OF SECTION/i.test(line)) {
      openIndex = -1;
      continue;
    }

    const p = PART_RE.exec(line);
    if (p) {
      part = Number(p[1]);
      partTitle = (p[2] ?? "").trim() || null;
      article = null;
      articleTitle = null;
      letter = null;
      arabic = null;
      openIndex = -1;
      continue;
    }

    const a = ARTICLE_RE.exec(line);
    if (a) {
      article = a[1]!;
      articleTitle = (a[2] ?? "").trim();
      letter = null;
      arabic = null;
      openIndex = -1;
      continue;
    }

    const l = LETTER_RE.exec(line);
    if (l) {
      letter = l[1]!;
      arabic = null;
      push([article, letter].filter(Boolean).join("."), l[2]!, i);
      continue;
    }

    const n = ARABIC_RE.exec(line);
    if (n) {
      arabic = n[1]!;
      push([article, letter, arabic].filter(Boolean).join("."), n[2]!, i);
      continue;
    }

    const lo = LOWER_RE.exec(line);
    if (lo) {
      push([article, letter, arabic, lo[1]!].filter(Boolean).join("."), lo[2]!, i);
      continue;
    }

    const open = openIndex >= 0 ? clauses[openIndex] : undefined;
    if (open) {
      open.text = `${open.text} ${line}`.trim();
    } else if (article) {
      push(article, line, i);
    }
  }
  return clauses;
}

export interface CsiPart {
  title: string | null;
  articles: { ref: string; title: string }[];
}

/** The `parts` jsonb on a section revision: { part1, part2, part3 }. */
export function splitCsiParts(text: string): Record<string, CsiPart> {
  const out: Record<string, CsiPart> = {};
  const lines = text.split("\n");
  let key: string | null = null;
  for (const raw of lines) {
    const line = tidy(raw);
    const p = PART_RE.exec(line);
    if (p) {
      key = `part${p[1]}`;
      out[key] = { title: (p[2] ?? "").trim() || null, articles: [] };
      continue;
    }
    const a = ARTICLE_RE.exec(line);
    if (a && key && out[key]) {
      out[key]!.articles.push({ ref: a[1]!, title: (a[2] ?? "").trim() });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Clause-level diff between revisions                                 */
/* ------------------------------------------------------------------ */

export interface ClauseChange {
  ref: string;
  kind: "added" | "removed" | "amended";
  text: string;
  previousText?: string;
}

/**
 * Clause-level diff, keyed on the clause ref. "What changed in rev C" is a
 * question asked in a dispute about a specific paragraph, so the answer is
 * per-paragraph rather than per-line.
 */
export function diffClauses(previousText: string, nextText: string): ClauseChange[] {
  const prev = new Map(parseClauses(previousText).map((c) => [c.ref, c.text] as const));
  const next = new Map(parseClauses(nextText).map((c) => [c.ref, c.text] as const));
  const changes: ClauseChange[] = [];
  for (const [ref, text] of next) {
    const before = prev.get(ref);
    if (before === undefined) changes.push({ ref, kind: "added", text });
    else if (before !== text) changes.push({ ref, kind: "amended", text, previousText: before });
  }
  for (const [ref, text] of prev) {
    if (!next.has(ref)) changes.push({ ref, kind: "removed", text });
  }
  changes.sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }));
  return changes;
}

/* ------------------------------------------------------------------ */
/* Submittal requirement extraction                                    */
/* ------------------------------------------------------------------ */

interface TermDef {
  /** matched against the clause text */
  re: RegExp;
  canonical: string;
  type: SubmittalType;
}

/**
 * The clauses that DEMAND a submittal. Ordered most-specific first: "product
 * data" must win over "data", "coordination drawings" over "drawings".
 */
const TERMS: TermDef[] = [
  // A deferred submittal is still a submittal the spec demands; it is named
  // first so the deferral is not lost behind a more generic term.
  { re: /\bdeferred submittals?\b/i, canonical: "Deferred Submittal", type: "other" },
  { re: /\bcoordination drawings?\b/i, canonical: "Coordination Drawings", type: "shop_drawing" },
  { re: /\bshop drawings?\b/i, canonical: "Shop Drawings", type: "shop_drawing" },
  {
    re: /\bdelegated[- ]design (?:submittals?|drawings?|calculations?)\b/i,
    canonical: "Delegated-Design Submittal",
    type: "shop_drawing",
  },
  { re: /\bproduct data\b/i, canonical: "Product Data", type: "product_data" },
  {
    re: /\bmanufacturer'?s?\s+(?:product\s+)?(?:literature|data|instructions)\b/i,
    canonical: "Manufacturer's Data",
    type: "product_data",
  },
  { re: /\bcatalog(?:ue)? cuts?\b/i, canonical: "Catalogue Cuts", type: "product_data" },
  { re: /\btechnical data sheets?\b/i, canonical: "Technical Data Sheets", type: "product_data" },
  {
    re: /\b(?:material\s+)?safety data sheets?\b|\bSDS\b|\bMSDS\b/i,
    canonical: "Safety Data Sheets",
    type: "product_data",
  },
  { re: /\b(?:concrete )?mix designs?\b/i, canonical: "Mix Design", type: "product_data" },
  { re: /\bmock-?ups?\b/i, canonical: "Mock-Up", type: "mock_up" },
  { re: /\bsamples?\b/i, canonical: "Samples", type: "sample" },
  {
    re: /\b(?:operation(?:s)? and maintenance|o\s*(?:&|and)\s*m)\s+(?:manuals?|data)\b/i,
    canonical: "Operation and Maintenance Manuals",
    type: "o_and_m",
  },
  { re: /\bmaintenance data\b/i, canonical: "Maintenance Data", type: "o_and_m" },
  { re: /\bwarrant(?:y|ies)\b/i, canonical: "Warranty", type: "warranty" },
  { re: /\bguarantees?\b/i, canonical: "Guarantee", type: "warranty" },
  { re: /\bmill certificates?\b/i, canonical: "Mill Certificates", type: "certificate" },
  {
    re: /\b(?:test|inspection|calibration) reports?\b/i,
    canonical: "Test Reports",
    type: "certificate",
  },
  {
    re: /\bcertificat(?:e|es|ion|ions)\b/i,
    canonical: "Certificates",
    type: "certificate",
  },
  { re: /\bqualification data\b/i, canonical: "Qualification Data", type: "other" },
  { re: /\brecord drawings?\b|\bas-?built drawings?\b/i, canonical: "Record Drawings", type: "other" },
  { re: /\bcloseout submittals?\b/i, canonical: "Closeout Submittals", type: "other" },
  { re: /\bLEED submittals?\b/i, canonical: "LEED Submittals", type: "other" },
];

const DEMAND_RE = /\b(submit|submittal|submitted|furnish|provide|deliver|prepare)\w*\b/i;
const REFERRAL_RE = /^(see|refer to|as (?:indicated|shown|specified)|comply with|coordinate)\b/i;
const CROSS_SECTION_RE = /\bSection\s+\d{2}[ .\-]?\d{2}[ .\-]?\d{2}\b/i;
const SUBMITTAL_ARTICLE_RE = /submittal/i;

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function extractCopies(text: string): number | null {
  const m =
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:copies|sets|prints)\b/i.exec(
      text,
    );
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  const n = WORD_NUMBERS[raw] ?? Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractRequiredBefore(text: string): string | null {
  const before =
    /\b(?:prior to|before)\s+(?:the\s+)?(fabrication|installation|delivery|ordering|purchase|erection|placement|manufacture|shipment|start of work)\b/i.exec(
      text,
    );
  if (before) return `prior to ${before[1]!.toLowerCase()}`;
  if (/\bwith (?:the )?bid\b/i.test(text)) return "with bid";
  if (/\bat (?:project )?closeout\b|\bat (?:substantial )?completion\b/i.test(text)) {
    return "at closeout";
  }
  const within = /\bwithin\s+(\d{1,3})\s+(?:calendar |working |business )?days\b/i.exec(text);
  if (within) return `within ${within[1]} days`;
  return null;
}

function extractReviewDays(text: string): number | null {
  const m =
    /\ballow\s+(\d{1,3})\s+(?:calendar |working |business )?days?\s+for\s+(?:the\s+)?(?:\w+'?s?\s+)?review\b/i.exec(
      text,
    );
  return m ? Number(m[1]) : null;
}

export interface RequirementExtraction {
  paragraphRef: string | null;
  title: string;
  description: string | null;
  /** verbatim clause text — the citation, never a paraphrase */
  clauseText: string;
  submittalType: SubmittalType;
  requiredCopies: number | null;
  requiredBefore: string | null;
  reviewDays: number | null;
  isDeferred: boolean;
  /** 0..1, never 1 */
  confidence: number;
  /** the phrase that fired, so a reviewer can see WHY this row exists */
  matchedTerm: string;
  articleTitle: string | null;
}

/** Everything the extractor read, for the audit trail on the created rows. */
export const EXTRACTOR_VERSION = "spec-requirements/heuristic-v1";

/**
 * Read the submittals a section DEMANDS out of its text.
 *
 * The bar is a DEMAND, not a mention: "Shop Drawings: Include plans..." is a
 * requirement, "as indicated on the Shop Drawings prepared under Section
 * 05 12 00" is a cross-reference and must not become a register row. Every
 * result carries the confidence and the matched phrase so the register never
 * shows a machine reading as though a person made it.
 */
export function extractSubmittalRequirements(text: string): RequirementExtraction[] {
  const clauses = parseClauses(text);
  const found: RequirementExtraction[] = [];

  for (const clause of clauses) {
    const body = clause.text;
    if (body.length < 6) continue;
    const term = TERMS.find((t) => t.re.test(body));
    if (!term) continue;

    const match = term.re.exec(body)!;
    const matchedTerm = match[0];
    const leadStripped = body
      .replace(/^(?:submit|provide|furnish|deliver)\s+/i, "")
      .replace(/^[^A-Za-z0-9]+/, "");
    const clauseLeading = new RegExp(`^${term.re.source}`, "i").test(leadStripped);
    const inSubmittalArticle = SUBMITTAL_ARTICLE_RE.test(clause.articleTitle ?? "");
    const hasDemand = DEMAND_RE.test(body);

    let confidence: number;
    if (clauseLeading) confidence = 0.85;
    else if (hasDemand) confidence = 0.7;
    else if (inSubmittalArticle) confidence = 0.6;
    else continue; // a bare mention is not a requirement

    if (inSubmittalArticle && clauseLeading) confidence += 0.1;
    if (new RegExp(`${term.re.source}\\s*:`, "i").test(body)) confidence += 0.05;
    if (REFERRAL_RE.test(body)) confidence -= 0.25;
    if (!clauseLeading && CROSS_SECTION_RE.test(body)) confidence -= 0.15;
    if (clause.part === 3 && !inSubmittalArticle) confidence -= 0.05;
    confidence = Math.round(Math.max(0.3, Math.min(0.95, confidence)) * 100) / 100;
    if (confidence < 0.5) continue;

    const colon = body.indexOf(":");
    const headline =
      colon > 0 && colon <= 120 ? body.slice(0, colon).trim() : term.canonical;
    const title = headline.length >= 3 && headline.length <= 200 ? headline : term.canonical;

    found.push({
      paragraphRef: clause.ref || null,
      title,
      description: colon > 0 ? body.slice(colon + 1).trim() || null : null,
      clauseText: body,
      submittalType: term.type,
      requiredCopies: extractCopies(body),
      requiredBefore: extractRequiredBefore(body),
      reviewDays: extractReviewDays(body),
      isDeferred: /\bdeferred submittals?\b/i.test(body),
      confidence,
      matchedTerm,
      articleTitle: clause.articleTitle,
    });
  }

  // One row per (paragraph, type): a clause that says "Shop Drawings" twice
  // is one requirement, and the strongest reading of it wins.
  const best = new Map<string, RequirementExtraction>();
  for (const r of found) {
    const key = `${r.paragraphRef ?? ""}|${r.submittalType}`;
    const existing = best.get(key);
    if (!existing || r.confidence > existing.confidence) best.set(key, r);
  }
  return [...best.values()];
}
