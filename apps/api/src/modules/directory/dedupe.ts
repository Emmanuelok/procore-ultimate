/**
 * Duplicate-vendor detection (Vol I §0.3 #11).
 *
 * A directory acquires duplicates the way every directory does: "ACME Ltd",
 * "Acme Limited" and "ACME LTD." are three rows, three vendor performance
 * histories, three insurance registers and three sets of commitments. This is
 * the matcher that finds them, and it explains itself — every candidate pair
 * carries the reasons it was flagged, because a merge is irreversible enough
 * that "the computer said so" is not good enough.
 *
 * Pure functions over plain records, so the thresholds are testable.
 */

export interface VendorLike {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  taxId?: string | null;
  registrationNumber?: string | null;
}

/** Legal-form suffixes that carry no distinguishing information. */
const SUFFIXES = [
  "ltd",
  "limited",
  "llc",
  "llp",
  "lp",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "bv",
  "nv",
  "sa",
  "srl",
  "pty",
  "pte",
  "sdn",
  "bhd",
  "ag",
  "as",
  "oy",
  "ab",
  "spa",
  "holdings",
  "group",
  "the",
  "and",
];

/** Lowercase, strip punctuation and legal-form noise, collapse whitespace. */
export function normaliseName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !SUFFIXES.includes(w));
  return words.join(" ");
}

export function nameTokens(name: string): Set<string> {
  return new Set(normaliseName(name).split(" ").filter(Boolean));
}

/** Jaccard similarity over word tokens: 1 = identical sets, 0 = disjoint. */
export function tokenSetSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function normaliseId(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function emailDomain(value: string | null | undefined): string {
  const at = (value ?? "").indexOf("@");
  return at === -1 ? "" : (value ?? "").slice(at + 1).toLowerCase();
}

export interface DuplicatePair {
  a: string;
  b: string;
  /** 0..1 — how confident the match is */
  confidence: number;
  reasons: string[];
}

/**
 * Compare two vendors.
 *
 * The strongest evidence is a shared registered identifier: two rows with the
 * same tax id or registration number are the same legal entity, whatever they
 * are called. Everything else accumulates.
 */
export function compareVendors(a: VendorLike, b: VendorLike): DuplicatePair | null {
  const reasons: string[] = [];
  let score = 0;

  const taxA = normaliseId(a.taxId);
  const taxB = normaliseId(b.taxId);
  if (taxA && taxA === taxB) {
    score += 0.75;
    reasons.push(`same tax id (${a.taxId})`);
  }

  const regA = normaliseId(a.registrationNumber);
  const regB = normaliseId(b.registrationNumber);
  if (regA && regA === regB) {
    score += 0.7;
    reasons.push(`same registration number (${a.registrationNumber})`);
  }

  const nameScore = tokenSetSimilarity(a.name, b.name);
  if (nameScore >= 0.999) {
    score += 0.55;
    reasons.push("identical name once legal form is stripped");
  } else if (nameScore >= 0.6) {
    score += 0.3 * nameScore;
    reasons.push(`similar name (${Math.round(nameScore * 100)}% token overlap)`);
  }

  const emailA = (a.email ?? "").toLowerCase();
  const emailB = (b.email ?? "").toLowerCase();
  if (emailA && emailA === emailB) {
    score += 0.4;
    reasons.push("same email address");
  } else {
    const domainA = emailDomain(a.email);
    const domainB = emailDomain(b.email);
    if (domainA && domainA === domainB) {
      score += 0.2;
      reasons.push(`same email domain (${domainA})`);
    }
  }

  const phoneA = digits(a.phone);
  const phoneB = digits(b.phone);
  if (phoneA.length >= 7 && phoneA.slice(-9) === phoneB.slice(-9)) {
    score += 0.25;
    reasons.push("same phone number");
  }

  const addrA = normaliseId(`${a.address ?? ""}${a.city ?? ""}`);
  const addrB = normaliseId(`${b.address ?? ""}${b.city ?? ""}`);
  if (addrA.length >= 8 && addrA === addrB) {
    score += 0.2;
    reasons.push("same address");
  }

  if (reasons.length === 0) return null;
  // A single weak signal is not a duplicate: a shared email domain across two
  // genuinely different subsidiaries is common.
  const confidence = Math.min(1, score);
  if (confidence < 0.45) return null;
  return {
    a: a.id,
    b: b.id,
    confidence: Math.round(confidence * 100) / 100,
    reasons,
  };
}

/**
 * All candidate duplicate pairs in a vendor list.
 *
 * O(n²) by design and bounded by the caller: the directory of one tenant is
 * thousands of rows, not millions, and a blocking key would cost recall on
 * exactly the misspellings this is meant to catch.
 */
export function findDuplicates(vendors: VendorLike[], limit = 200): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < vendors.length; i += 1) {
    for (let j = i + 1; j < vendors.length; j += 1) {
      const pair = compareVendors(vendors[i]!, vendors[j]!);
      if (pair) pairs.push(pair);
    }
  }
  return pairs
    .sort((x, y) => y.confidence - x.confidence || x.a.localeCompare(y.a))
    .slice(0, limit);
}
