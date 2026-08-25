/**
 * Offline escrow-receipt verifier.
 *
 *     node verify-receipt.js receipt.json
 *
 * WHO THIS IS FOR: a counterparty — an auditor, a lender, a regulator, an
 * adverse party in a dispute — who has been handed an escrow receipt and has
 * no access to the platform that issued it, no account, no network route, and
 * no reason to trust either. Everything below runs on the file alone.
 *
 * WHY IT HAS NO IMPORTS: the canonicalizer and the sha256/Ed25519 calls are
 * inlined rather than imported from @constructos/ledger, so the compiled file
 * is a single dependency-free script that runs on any Node ≥ 22 — including
 * one that has never seen this repository. The inlined canonicalizer is
 * asserted byte-for-byte identical to the library's in
 * `modules/anchoring/anchoring.test.ts`, which is what keeps the two from
 * drifting apart.
 *
 * WHAT IT CAN PROVE FROM THE FILE ALONE:
 *   • the document has not been altered since issue (receipt hash);
 *   • the seal body hashes to the value that was signed;
 *   • the Ed25519 signature over that body verifies under the public key the
 *     receipt carries;
 *   • therefore: whoever issued this receipt held that private key, and
 *     committed to a chain of exactly `entryCount` entries ending in
 *     `headHash` with Merkle root `merkleRoot`.
 *
 * WHAT IT CANNOT PROVE WITHOUT THE LIVE CHAIN — and says so on every run:
 *   • that the chain STILL contains those entries (truncation since issue);
 *   • that the public key in the receipt is the platform's real key, rather
 *     than one manufactured together with the whole document. Compare the
 *     fingerprint printed below against a copy obtained through a different
 *     channel;
 *   • the wall-clock time of sealing, unless an RFC 3161 or blockchain anchor
 *     accompanies the receipt;
 *   • that anything recorded in the ledger was true.
 */
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* Inlined primitives (kept identical to @constructos/ledger)          */
/* ------------------------------------------------------------------ */

/** Deterministic JSON canonicalization (RFC 8785-style subset). */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Cannot canonicalize non-finite number");
      }
      return JSON.stringify(value);
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString());
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

/** The eleven fields of the signed seal body, in the order they are documented. */
const SEAL_BODY_FIELDS = [
  "companyId",
  "sequence",
  "fromEntrySeq",
  "toEntrySeq",
  "entryCount",
  "headHash",
  "merkleRoot",
  "prevSealHash",
  "sealedAt",
  "keyId",
  "algorithm",
] as const;

export interface ReceiptCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReceiptVerification {
  ok: boolean;
  checks: ReceiptCheck[];
  summary: string;
  proven: string[];
  unproven: string[];
  /** facts worth printing even when everything passes */
  facts: Record<string, string | number | boolean | null>;
}

function fail(checks: ReceiptCheck[], summary: string): ReceiptVerification {
  return {
    ok: false,
    checks,
    summary,
    proven: [],
    unproven: ["Nothing could be established from this file."],
    facts: {},
  };
}

/**
 * Verify a parsed receipt document. Pure: no filesystem, no network, no clock.
 */
export function verifyReceiptDocument(input: unknown): ReceiptVerification {
  const checks: ReceiptCheck[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail(checks, "The file does not contain a JSON object.");
  }
  const doc = input as Record<string, unknown>;

  if (doc["documentType"] !== "constructos.escrow-receipt") {
    return fail(
      checks,
      `Not a ConstructOS escrow receipt (documentType = ${JSON.stringify(doc["documentType"])}).`,
    );
  }
  const seal = doc["seal"];
  const key = doc["key"];
  if (!seal || typeof seal !== "object" || !key || typeof key !== "object") {
    return fail(checks, "The receipt is missing its `seal` or `key` section.");
  }
  const sealObj = seal as Record<string, unknown>;
  const keyObj = key as Record<string, unknown>;

  /* 1. receipt hash --------------------------------------------------- */
  const claimedReceiptHash = doc["receiptHash"];
  const { receiptHash: _omit, ...withoutHash } = doc;
  void _omit;
  const recomputedReceiptHash = sha256Hex(canonicalize(withoutHash));
  const receiptIntact = recomputedReceiptHash === claimedReceiptHash;
  checks.push({
    name: "receipt document unaltered",
    ok: receiptIntact,
    detail: receiptIntact
      ? `sha256 of the canonical document (minus receiptHash) = ${recomputedReceiptHash}`
      : `recomputed ${recomputedReceiptHash}, receipt claims ${String(claimedReceiptHash)} — ` +
        "the document has been edited since it was issued",
  });

  /* 2. seal body hash ------------------------------------------------- */
  const body: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const field of SEAL_BODY_FIELDS) {
    if (!(field in sealObj)) missing.push(field);
    else body[field] = sealObj[field];
  }
  if (missing.length > 0) {
    checks.push({
      name: "seal body complete",
      ok: false,
      detail: `the seal is missing: ${missing.join(", ")}`,
    });
    return { ...fail(checks, "The seal body is incomplete; no signature could be checked."), checks };
  }
  const bodyBytes = canonicalize(body);
  const recomputedBodyHash = sha256Hex(bodyBytes);
  const bodyHashMatches = recomputedBodyHash === sealObj["bodyHash"];
  checks.push({
    name: "seal body hash",
    ok: bodyHashMatches,
    detail: bodyHashMatches
      ? `sha256 of the canonical seal body = ${recomputedBodyHash}`
      : `recomputed ${recomputedBodyHash}, receipt claims ${String(sealObj["bodyHash"])}`,
  });

  /* 3. signature ------------------------------------------------------ */
  const algorithm = String(sealObj["algorithm"] ?? "");
  let signatureValid = false;
  let signatureDetail: string;
  if (algorithm !== "ed25519") {
    signatureDetail = `unsupported algorithm "${algorithm}" — this verifier only reads ed25519`;
  } else {
    try {
      const pem = String(keyObj["publicKeyPem"] ?? "");
      const pub = createPublicKey(pem);
      if (pub.asymmetricKeyType !== "ed25519") {
        signatureDetail = `the receipt's public key is ${String(pub.asymmetricKeyType)}, not ed25519`;
      } else {
        signatureValid = edVerify(
          null,
          Buffer.from(bodyBytes, "utf8"),
          pub,
          Buffer.from(String(sealObj["signature"] ?? ""), "base64"),
        );
        signatureDetail = signatureValid
          ? "Ed25519 signature verifies over the canonical seal body"
          : "the Ed25519 signature does NOT verify over the canonical seal body";
      }
    } catch (err) {
      signatureDetail = `could not read the public key or signature: ${(err as Error).message}`;
    }
  }
  checks.push({ name: "seal signature", ok: signatureValid, detail: signatureDetail });

  /* 4. key fingerprint ------------------------------------------------ */
  let fingerprintMatches = false;
  let fingerprintDetail = "no public key to fingerprint";
  try {
    const pub = createPublicKey(String(keyObj["publicKeyPem"] ?? ""));
    const der = pub.export({ type: "spki", format: "der" });
    const computed = sha256Hex(new Uint8Array(der));
    fingerprintMatches = computed === keyObj["fingerprint"];
    fingerprintDetail = fingerprintMatches
      ? `sha256(SPKI DER) = ${computed}`
      : `computed ${computed}, receipt claims ${String(keyObj["fingerprint"])}`;
  } catch {
    /* handled by the signature check above */
  }
  checks.push({
    name: "public key fingerprint self-consistent",
    ok: fingerprintMatches,
    detail: fingerprintDetail,
  });

  /* 5. internal consistency of the ranges ----------------------------- */
  const entryCount = Number(sealObj["entryCount"]);
  const fromSeq = Number(sealObj["fromEntrySeq"]);
  const toSeq = Number(sealObj["toEntrySeq"]);
  const rangeSane =
    Number.isInteger(entryCount) &&
    entryCount >= 1 &&
    Number.isInteger(fromSeq) &&
    Number.isInteger(toSeq) &&
    toSeq >= fromSeq;
  checks.push({
    name: "sealed range coherent",
    ok: rangeSane,
    detail: rangeSane
      ? `commits to ${entryCount} entries, ledger seq ${fromSeq}-${toSeq}`
      : "entryCount / fromEntrySeq / toEntrySeq are not a coherent range",
  });

  const ok = checks.every((c) => c.ok);
  const derived = keyObj["derivedFromAuthSecret"] === true;

  const proven = ok
    ? [
        `Whoever issued this receipt held the private key whose public half is in the file ` +
          `(fingerprint ${String(keyObj["fingerprint"])}).`,
        `They committed to a ledger of exactly ${entryCount} entries ending in entry hash ` +
          `${String(sealObj["headHash"])}, with Merkle root ${String(sealObj["merkleRoot"])}.`,
        "Any chain presented later that is shorter than that, or whose first " +
          `${entryCount} entries do not reproduce that Merkle root, is not the chain that was sealed.`,
        `The seal claims sequence ${String(sealObj["sequence"])} in the company's seal chain` +
          (sealObj["prevSealHash"]
            ? `, chained to the previous seal (${String(sealObj["prevSealHash"]).slice(0, 16)}…).`
            : " — the first seal of that chain."),
      ]
    : [];

  const unproven = [
    "Whether the live ledger STILL holds those entries. Truncation after issue is invisible " +
      "from this file alone: present the receipt to POST /api/v1/ledger/escrow/verify, or ask " +
      "the holder to.",
    "That this public key is really the issuing platform's key. The receipt carries its own " +
      "key, so a whole receipt could have been manufactured. Obtain the fingerprint through a " +
      "different channel and compare it with the value above.",
    `The wall-clock time of sealing. sealedAt (${String(sealObj["sealedAt"])}) is the issuing ` +
      "application's own clock unless an RFC 3161 timestamp or blockchain anchor accompanies " +
      "this receipt.",
    "That anything recorded in the ledger was TRUE. A seal covers integrity, not accuracy.",
  ];
  if (derived) {
    unproven.unshift(
      "That the OPERATOR of the issuing deployment did not produce this seal: the receipt " +
        "declares derivedFromAuthSecret = true, meaning the signing key was derived from the " +
        "application's own AUTH_SECRET. It proves integrity against someone with database " +
        "access only — not against the operator.",
    );
  }

  return {
    ok,
    checks,
    summary: ok
      ? "VERIFIED — the receipt is internally consistent and its signature is valid."
      : "FAILED — see the checks above; do not rely on this receipt.",
    proven,
    unproven,
    facts: {
      receiptId: String(doc["receiptId"] ?? ""),
      issuedAt: String(doc["issuedAt"] ?? ""),
      companyId: String(sealObj["companyId"] ?? ""),
      sealSequence: Number(sealObj["sequence"] ?? 0),
      entryCount,
      sealedAt: String(sealObj["sealedAt"] ?? ""),
      keyId: String(keyObj["keyId"] ?? ""),
      fingerprint: String(keyObj["fingerprint"] ?? ""),
      derivedFromAuthSecret: derived,
    },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function formatReport(result: ReceiptVerification): string {
  const lines: string[] = [];
  lines.push("ConstructOS escrow receipt — offline verification");
  lines.push("=".repeat(64));
  for (const [k, v] of Object.entries(result.facts)) {
    lines.push(`  ${k.padEnd(22)} ${String(v)}`);
  }
  lines.push("");
  lines.push("Checks");
  lines.push("-".repeat(64));
  for (const check of result.checks) {
    lines.push(`  [${check.ok ? "PASS" : "FAIL"}] ${check.name}`);
    lines.push(`         ${check.detail}`);
  }
  lines.push("");
  lines.push(result.summary);
  if (result.proven.length > 0) {
    lines.push("");
    lines.push("What this file proves");
    lines.push("-".repeat(64));
    for (const item of result.proven) lines.push(`  • ${item}`);
  }
  lines.push("");
  lines.push("What this file CANNOT prove without the live chain");
  lines.push("-".repeat(64));
  for (const item of result.unproven) lines.push(`  • ${item}`);
  lines.push("");
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const file = argv[2];
  if (!file || file === "--help" || file === "-h") {
    process.stdout.write(
      "usage: node verify-receipt.js <receipt.json>\n\n" +
        "Verifies a ConstructOS escrow receipt offline: the document hash, the seal body\n" +
        "hash, the Ed25519 signature and the key fingerprint. Exits 0 when every check\n" +
        "passes, 1 when any fails, 2 when the file cannot be read or parsed.\n",
    );
    return file ? 0 : 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    process.stderr.write(`Cannot read ${file}: ${(err as Error).message}\n`);
    return 2;
  }
  const result = verifyReceiptDocument(parsed);
  process.stdout.write(formatReport(result));
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main(process.argv));
}
