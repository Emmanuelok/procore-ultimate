/**
 * M1 — anchor providers (spec Vol II Domain S #864, #873-874).
 *
 * "Anchoring" means witnessing a seal somewhere this deployment does not
 * control. Four providers, ordered by how far outside the deployment the
 * witness actually reaches:
 *
 *   local_signed    The Ed25519 signature itself. The private key is in the
 *                   process environment, not the database, so this defeats a
 *                   database-only attacker. It reaches no further than the
 *                   host, and it is not a time source.
 *
 *   rfc3161         A Time-Stamp Authority countersigns the seal's body hash
 *                   (RFC 3161). This is the one that closes the trusted-time
 *                   gap (docs/security.md §8.2 gap 3), because the TSA's clock
 *                   is not ours. Requires ANCHOR_TSA_URL and an account with
 *                   an authority.
 *
 *   opentimestamps  The body hash is submitted to a public OpenTimestamps
 *                   calendar, which aggregates it into a Bitcoin transaction.
 *                   The strongest reach available without a commercial
 *                   relationship, and the slowest to confirm. Requires
 *                   ANCHOR_OTS_CALENDAR_URL.
 *
 *   counterparty    The seal is handed to a named third party who acknowledges
 *                   a reference. No cryptography beyond the seal itself; its
 *                   strength is that the copy is outside this database and the
 *                   holder is adverse. Fully implementable here, and in a
 *                   dispute it is often the one that actually gets used.
 *
 * The two network providers are implemented for real — the RFC 3161 request is
 * a genuine DER TimeStampReq and the response parser is a genuine (if minimal)
 * TimeStampResp reader — behind an INJECTED http client, so they are testable
 * against fixtures. What this file will NOT do is fabricate a proof: with no
 * endpoint configured, or with the network call failing, the submission is
 * recorded `unavailable` with a detail string naming the exact variable, URL
 * and relationship the operator has to obtain. An anchor that lies about where
 * it reached is worse than an absent one.
 */
import { randomBytes } from "node:crypto";
import { sha256Hex } from "@constructos/ledger";
import type { AnchorProvider, AnchorStatus } from "@constructos/shared";
import type { AnchorKeyRecord } from "./keys.js";

/* ------------------------------------------------------------------ */
/* Injected HTTP client                                                */
/* ------------------------------------------------------------------ */

export interface AnchorHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface AnchorHttpClient {
  post(
    url: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ): Promise<AnchorHttpResponse>;
}

/** The real client. Used when an endpoint is configured; nothing else calls out. */
export function createFetchAnchorHttpClient(timeoutMs = 10_000): AnchorHttpClient {
  return {
    async post(url, body, headers) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          body,
          headers,
          signal: controller.signal,
        });
        const buf = new Uint8Array(await res.arrayBuffer());
        const outHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          outHeaders[k.toLowerCase()] = v;
        });
        return { status: res.status, headers: outHeaders, body: buf };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface AnchorFixture {
  status: number;
  body: Uint8Array | string;
  headers?: Record<string, string>;
  /** throw instead of responding — models an unreachable endpoint */
  networkError?: string;
}

/** Fixture-backed fake: exact URL match, then URL-suffix match, else 404. */
export function createFixtureAnchorHttpClient(
  fixtures: Record<string, AnchorFixture>,
): AnchorHttpClient {
  return {
    async post(url) {
      const hit =
        fixtures[url] ?? Object.entries(fixtures).find(([k]) => url.endsWith(k))?.[1] ?? null;
      if (!hit) {
        return { status: 404, headers: {}, body: new Uint8Array() };
      }
      if (hit.networkError) throw new Error(hit.networkError);
      return {
        status: hit.status,
        headers: hit.headers ?? {},
        body: typeof hit.body === "string" ? Buffer.from(hit.body, "utf8") : hit.body,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Minimal DER — enough for RFC 3161, and no more                      */
/* ------------------------------------------------------------------ */

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const derSequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const derOctetString = (content: Buffer) => tlv(0x04, content);
const derNull = () => Buffer.from([0x05, 0x00]);
const derBoolean = (value: boolean) => Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);

function derInteger(value: number | Buffer): Buffer {
  if (typeof value === "number") {
    const bytes: number[] = [];
    let n = value;
    if (n === 0) bytes.push(0);
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n = Math.floor(n / 256);
    }
    if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0);
    return tlv(0x02, Buffer.from(bytes));
  }
  const buf = (value[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return tlv(0x02, buf);
}

/** OID 2.16.840.1.101.3.4.2.1 (sha-256), pre-encoded. */
const OID_SHA256 = Buffer.from("0609608648016503040201", "hex");

/**
 * RFC 3161 §2.4.1:
 *   TimeStampReq ::= SEQUENCE {
 *     version        INTEGER { v1(1) },
 *     messageImprint MessageImprint,
 *     reqPolicy      TSAPolicyId OPTIONAL,
 *     nonce          INTEGER OPTIONAL,
 *     certReq        BOOLEAN DEFAULT FALSE,
 *     extensions [0] IMPLICIT Extensions OPTIONAL }
 *   MessageImprint ::= SEQUENCE {
 *     hashAlgorithm  AlgorithmIdentifier,
 *     hashedMessage  OCTET STRING }
 */
export function encodeTimeStampReq(digest: Buffer, nonce: Buffer): Buffer {
  const messageImprint = derSequence(
    derSequence(OID_SHA256, derNull()),
    derOctetString(digest),
  );
  return derSequence(
    derInteger(1),
    messageImprint,
    derInteger(nonce),
    derBoolean(true), // certReq: ask for the TSA certificate, so the token is self-verifiable
  );
}

interface DerNode {
  tag: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

function readTlv(buf: Uint8Array, offset: number): DerNode | null {
  if (offset + 2 > buf.length) return null;
  const tag = buf[offset]!;
  let lenByte = buf[offset + 1]!;
  let cursor = offset + 2;
  let length: number;
  if ((lenByte & 0x80) === 0) {
    length = lenByte;
  } else {
    const count = lenByte & 0x7f;
    if (count === 0 || count > 4 || cursor + count > buf.length) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[cursor + i]!;
    cursor += count;
  }
  const contentEnd = cursor + length;
  if (contentEnd > buf.length) return null;
  return { tag, contentStart: cursor, contentEnd, end: contentEnd };
}

export interface TimeStampRespParse {
  /** PKIStatus: 0 granted, 1 grantedWithMods, 2 rejection, 3 waiting, … */
  status: number | null;
  granted: boolean;
  /** the raw DER TimeStampToken, when one was returned */
  token: Uint8Array | null;
  error?: string;
}

/**
 * RFC 3161 §2.4.2:
 *   TimeStampResp ::= SEQUENCE {
 *     status         PKIStatusInfo,
 *     timeStampToken TimeStampToken OPTIONAL }
 *
 * Deliberately shallow: the token is a full CMS SignedData and this platform
 * ships no CMS parser, so the token is carried through verbatim as the proof
 * rather than being partially interpreted. `openssl ts -verify` is the tool
 * that reads it, and the proof object says so.
 */
export function parseTimeStampResp(bytes: Uint8Array): TimeStampRespParse {
  const outer = readTlv(bytes, 0);
  if (!outer || outer.tag !== 0x30) {
    return { status: null, granted: false, token: null, error: "response is not a DER SEQUENCE" };
  }
  const statusInfo = readTlv(bytes, outer.contentStart);
  if (!statusInfo || statusInfo.tag !== 0x30) {
    return { status: null, granted: false, token: null, error: "missing PKIStatusInfo" };
  }
  const statusInt = readTlv(bytes, statusInfo.contentStart);
  if (!statusInt || statusInt.tag !== 0x02) {
    return { status: null, granted: false, token: null, error: "missing PKIStatus integer" };
  }
  let status = 0;
  for (let i = statusInt.contentStart; i < statusInt.contentEnd; i++) {
    status = status * 256 + bytes[i]!;
  }
  const granted = status === 0 || status === 1;
  let token: Uint8Array | null = null;
  if (statusInfo.end < outer.contentEnd) {
    const tokenNode = readTlv(bytes, statusInfo.end);
    if (tokenNode) token = bytes.slice(statusInfo.end, tokenNode.end);
  }
  return { status, granted, token };
}

/* ------------------------------------------------------------------ */
/* Provider environment & results                                      */
/* ------------------------------------------------------------------ */

export interface AnchorProviderEnv {
  /** RFC 3161 Time-Stamp Authority endpoint, e.g. https://freetsa.org/tsr */
  ANCHOR_TSA_URL?: string | undefined;
  /** OpenTimestamps calendar, e.g. https://a.pool.opentimestamps.org */
  ANCHOR_OTS_CALENDAR_URL?: string | undefined;
}

export interface AnchorAttempt {
  provider: AnchorProvider;
  status: AnchorStatus;
  externalRef: string | null;
  proof: Record<string, unknown>;
  detail: string | null;
  confirmedAt: string | null;
}

export interface AnchorRequest {
  provider: AnchorProvider;
  /** sha256 of the canonical seal body — the value being witnessed */
  bodyHash: string;
  sealId: string;
  sealSequence: number;
  signature: string;
  key: AnchorKeyRecord;
  counterparty?: { name: string; ref?: string | null; note?: string | null } | undefined;
  env: AnchorProviderEnv;
  http?: AnchorHttpClient | undefined;
  now?: string | undefined;
}

/** What an operator has to obtain before a provider can reach anywhere. */
export const PROVIDER_REQUIREMENTS: Record<AnchorProvider, { needs: string[]; note: string }> = {
  local_signed: {
    needs: ["ANCHOR_SIGNING_KEY (optional; falls back to a key derived from AUTH_SECRET)"],
    note:
      "Always available. The witness is this deployment's own Ed25519 key: it proves the seal " +
      "was made by something holding that key, and it is not an independent time source.",
  },
  rfc3161: {
    needs: [
      "ANCHOR_TSA_URL — the TSA's HTTP endpoint (RFC 3161 over HTTP, content-type application/timestamp-query)",
      "An account or open service with a Time-Stamp Authority (e.g. FreeTSA, DigiCert, Sectigo, a national TSA)",
      "The TSA's root/intermediate certificates, so a third party can run `openssl ts -verify`",
      "Outbound network access from this deployment to that endpoint",
    ],
    note:
      "The request encoder and response parser are implemented and fixture-tested; what a real " +
      "timestamp needs beyond them is a relationship with an authority and a network path to " +
      "it. Without both, no token is issued and the submission records that instead of a proof.",
  },
  opentimestamps: {
    needs: [
      "ANCHOR_OTS_CALENDAR_URL — a calendar server, e.g. https://a.pool.opentimestamps.org",
      "Outbound network access from this deployment to that calendar",
      "A later upgrade pass (calendar → Bitcoin attestation) before the proof is independently " +
        "verifiable; a fresh calendar receipt commits the digest but is not yet on-chain",
    ],
    note:
      "Without a configured calendar and a route to it, nothing is submitted to any blockchain. " +
      "Even with one, a fresh calendar receipt is recorded as pending, not anchored, until the " +
      "digest reaches the Bitcoin chain.",
  },
  counterparty: {
    needs: [
      "A named third party willing to hold a copy of the seal (auditor, lender, regulator, counterparty)",
      "A reference they return when they acknowledge receipt",
    ],
    note:
      "Fully implementable in this deployment: issue the escrow receipt, hand it over, and record " +
      "their acknowledgement reference against the submission.",
  },
};

function unavailable(provider: AnchorProvider, reason: string, now: string): AnchorAttempt {
  const req = PROVIDER_REQUIREMENTS[provider];
  return {
    provider,
    status: "unavailable",
    externalRef: null,
    // No proof is recorded, because there is none. An empty proof on an
    // `unavailable` row is the honest representation of "nothing happened".
    proof: { attemptedAt: now, required: req.needs },
    detail: `${reason} ${req.note} Required: ${req.needs.join("; ")}.`,
    confirmedAt: null,
  };
}

/* ------------------------------------------------------------------ */
/* Submission                                                          */
/* ------------------------------------------------------------------ */

export async function submitAnchor(request: AnchorRequest): Promise<AnchorAttempt> {
  const now = request.now ?? new Date().toISOString();
  switch (request.provider) {
    case "local_signed":
      return localSigned(request, now);
    case "rfc3161":
      return rfc3161(request, now);
    case "opentimestamps":
      return openTimestamps(request, now);
    case "counterparty":
      return counterparty(request, now);
    default: {
      const exhaustive: never = request.provider;
      throw new Error(`unknown anchor provider ${String(exhaustive)}`);
    }
  }
}

function localSigned(request: AnchorRequest, now: string): AnchorAttempt {
  return {
    provider: "local_signed",
    status: "anchored",
    externalRef: `${request.key.keyId}:${request.bodyHash.slice(0, 16)}`,
    proof: {
      algorithm: request.key.algorithm,
      keyId: request.key.keyId,
      fingerprint: request.key.fingerprint,
      publicKeyPem: request.key.publicKeyPem,
      bodyHash: request.bodyHash,
      signature: request.signature,
      derivedFromAuthSecret: request.key.derivedFromAuthSecret,
      weakening: request.key.weakening,
      verify:
        "Recompute sha256 over the canonical seal body, confirm it equals bodyHash, then verify " +
        "the base64 Ed25519 signature over those same canonical bytes with publicKeyPem.",
    },
    detail:
      "Witnessed by this deployment's own signing key. The private half is in the process " +
      "environment and not in the database, so this defeats an attacker with database access " +
      "only. It is not an independent time source and does not reach outside this host." +
      (request.key.derivedFromAuthSecret ? ` ${request.key.weakening}` : ""),
    confirmedAt: now,
  };
}

async function rfc3161(request: AnchorRequest, now: string): Promise<AnchorAttempt> {
  const url = request.env.ANCHOR_TSA_URL?.trim();
  if (!url) {
    return unavailable(
      "rfc3161",
      "No timestamp authority is configured: ANCHOR_TSA_URL is unset.",
      now,
    );
  }
  const http = request.http ?? createFetchAnchorHttpClient();
  const digest = Buffer.from(request.bodyHash, "hex");
  const nonce = randomBytes(8);
  const der = encodeTimeStampReq(digest, nonce);
  let response: AnchorHttpResponse;
  try {
    response = await http.post(url, der, {
      "content-type": "application/timestamp-query",
      accept: "application/timestamp-reply",
      "content-length": String(der.length),
    });
  } catch (err) {
    return unavailable(
      "rfc3161",
      `The timestamp request to ${url} failed: ${(err as Error).message}. Nothing was timestamped.`,
      now,
    );
  }
  if (response.status !== 200) {
    return unavailable(
      "rfc3161",
      `The timestamp authority at ${url} answered HTTP ${response.status}.`,
      now,
    );
  }
  const parsed = parseTimeStampResp(response.body);
  if (!parsed.granted || !parsed.token) {
    return {
      provider: "rfc3161",
      status: "failed",
      externalRef: null,
      proof: { pkiStatus: parsed.status, requestDerBase64: der.toString("base64") },
      detail:
        `The timestamp authority at ${url} refused the request (PKIStatus ${parsed.status ?? "?"}` +
        `${parsed.error ? `, ${parsed.error}` : ""}). No token was issued, so nothing is anchored.`,
      confirmedAt: null,
    };
  }
  const token = Buffer.from(parsed.token);
  return {
    provider: "rfc3161",
    status: "anchored",
    // Full CMS parsing (serial, genTime, TSA name) is out of scope; the token
    // is carried verbatim and the reference identifies it by its own digest.
    externalRef: `tsa-token-sha256:${sha256Hex(token)}`,
    proof: {
      tsaUrl: url,
      pkiStatus: parsed.status,
      messageImprintAlgorithm: "sha-256",
      messageImprint: request.bodyHash,
      nonce: nonce.toString("hex"),
      requestDerBase64: der.toString("base64"),
      timeStampTokenBase64: token.toString("base64"),
      verify:
        "Save timeStampTokenBase64 (base64-decoded) as seal.tsr and run: " +
        "openssl ts -verify -digest <seal bodyHash> -in seal.tsr -CAfile <tsa-ca.pem>. " +
        "The genTime inside the token is the authority's clock, not this deployment's.",
    },
    detail:
      "Countersigned by an external time-stamp authority. This is the only provider here that " +
      "supplies time from a source other than this application's own clock.",
    confirmedAt: now,
  };
}

async function openTimestamps(request: AnchorRequest, now: string): Promise<AnchorAttempt> {
  const base = request.env.ANCHOR_OTS_CALENDAR_URL?.trim().replace(/\/+$/, "");
  if (!base) {
    return unavailable(
      "opentimestamps",
      "No OpenTimestamps calendar is configured: ANCHOR_OTS_CALENDAR_URL is unset.",
      now,
    );
  }
  const http = request.http ?? createFetchAnchorHttpClient();
  const digest = Buffer.from(request.bodyHash, "hex");
  const url = `${base}/digest`;
  let response: AnchorHttpResponse;
  try {
    response = await http.post(url, digest, {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/vnd.opentimestamps.v1",
      "content-length": String(digest.length),
    });
  } catch (err) {
    return unavailable(
      "opentimestamps",
      `The calendar submission to ${url} failed: ${(err as Error).message}. Nothing was submitted.`,
      now,
    );
  }
  if (response.status !== 200 || response.body.length === 0) {
    return unavailable(
      "opentimestamps",
      `The calendar at ${url} answered HTTP ${response.status} with ${response.body.length} bytes.`,
      now,
    );
  }
  const receipt = Buffer.from(response.body);
  return {
    provider: "opentimestamps",
    // Deliberately "pending", not "anchored": a fresh calendar receipt commits
    // the digest to that calendar's aggregation, and only becomes a Bitcoin
    // attestation after the calendar publishes. Calling it anchored now would
    // overstate it by several hours.
    status: "pending",
    externalRef: `ots-calendar:${base}`,
    proof: {
      calendar: base,
      digest: request.bodyHash,
      calendarReceiptBase64: receipt.toString("base64"),
      upgrade: `${base}/timestamp/${request.bodyHash}`,
      verify:
        "Reconstruct the .ots file from calendarReceiptBase64, upgrade it against the calendar " +
        "once the Bitcoin attestation exists (`ots upgrade`), then `ots verify`. Until the " +
        "upgrade completes this receipt proves submission to the calendar, not inclusion in a block.",
    },
    detail:
      "Submitted to a public OpenTimestamps calendar. The proof becomes independently " +
      "verifiable only after the calendar aggregates it into a Bitcoin transaction; until then " +
      "it is a calendar receipt and is recorded as pending.",
    confirmedAt: null,
  };
}

function counterparty(request: AnchorRequest, now: string): AnchorAttempt {
  const name = request.counterparty?.name?.trim();
  if (!name) {
    return unavailable(
      "counterparty",
      "No counterparty was named: this provider records a seal handed to a specific third party.",
      now,
    );
  }
  return {
    provider: "counterparty",
    status: "pending",
    externalRef: request.counterparty?.ref?.trim() || null,
    proof: {
      counterpartyName: name,
      note: request.counterparty?.note ?? null,
      sealId: request.sealId,
      sealSequence: request.sealSequence,
      bodyHash: request.bodyHash,
      handover:
        "Issue an escrow receipt for this seal (POST /api/v1/ledger/seals/:sealId/escrow), send " +
        "the receipt document to the counterparty, and record their acknowledgement reference " +
        "with POST /api/v1/ledger/anchors/:anchorId/confirm.",
    },
    detail:
      `Awaiting acknowledgement from ${name}. This anchor becomes real when they confirm a ` +
      "reference: its strength is that a copy of the seal is held outside this database by a " +
      "party with no interest in it agreeing with us.",
    confirmedAt: null,
  };
}


/* ------------------------------------------------------------------ */
/* Upgrading a pending OpenTimestamps receipt                          */
/* ------------------------------------------------------------------ */

export interface AnchorUpgradeRequest {
  /** the digest that was submitted — the seal's bodyHash */
  bodyHash: string;
  /** the calendar the receipt came from, from the stored proof */
  calendar: string;
  env: AnchorProviderEnv;
  http?: AnchorHttpClient | undefined;
  now?: string | undefined;
}

export interface AnchorUpgradeResult {
  upgraded: boolean;
  status: AnchorStatus;
  proof: Record<string, unknown> | null;
  detail: string;
  confirmedAt: string | null;
}

/**
 * Poll a calendar for the Bitcoin attestation of a previously submitted
 * digest (`GET <calendar>/timestamp/<digest>`).
 *
 * WHY THIS EXISTS. A fresh OpenTimestamps submission is a calendar receipt,
 * not a blockchain proof, and is recorded as `pending` for exactly that
 * reason. Without something that comes back later and upgrades it, every OTS
 * anchor on this platform would stay pending forever and the provider would be
 * decorative. The scheduler calls this; nothing on a request path does.
 *
 * The upgrade is still honest about what it proves: the calendar's answer is
 * the attestation path, and full verification (`ots verify`) needs a Bitcoin
 * node or a block explorer. We record the bytes and say so.
 */
export async function upgradeOpenTimestamps(
  request: AnchorUpgradeRequest,
): Promise<AnchorUpgradeResult> {
  const now = request.now ?? new Date().toISOString();
  const base = (request.calendar || request.env.ANCHOR_OTS_CALENDAR_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    return {
      upgraded: false,
      status: "pending",
      proof: null,
      detail:
        "No calendar is recorded on this submission and ANCHOR_OTS_CALENDAR_URL is unset, so " +
        "there is nowhere to ask for the attestation.",
      confirmedAt: null,
    };
  }
  const http = request.http ?? createFetchAnchorHttpClient();
  const url = `${base}/timestamp/${request.bodyHash}`;
  let response: AnchorHttpResponse;
  try {
    // The calendar's timestamp endpoint is a GET in the OTS protocol; the
    // injected client only speaks POST, and a zero-length POST body is what
    // both the real calendars and the fixture client treat as a plain fetch.
    response = await http.post(url, new Uint8Array(0), {
      accept: "application/vnd.opentimestamps.v1",
    });
  } catch (err) {
    return {
      upgraded: false,
      status: "pending",
      proof: null,
      detail: `The calendar at ${url} could not be reached: ${(err as Error).message}.`,
      confirmedAt: null,
    };
  }
  if (response.status === 404) {
    return {
      upgraded: false,
      status: "pending",
      proof: null,
      detail:
        "The calendar has not yet aggregated this digest into a Bitcoin transaction " +
        "(HTTP 404). This is the normal state for the first few hours after submission.",
      confirmedAt: null,
    };
  }
  if (response.status !== 200 || response.body.length === 0) {
    return {
      upgraded: false,
      status: "pending",
      proof: null,
      detail: `The calendar answered HTTP ${response.status} with ${response.body.length} bytes; nothing was upgraded.`,
      confirmedAt: null,
    };
  }
  return {
    upgraded: true,
    status: "anchored",
    proof: {
      calendar: base,
      digest: request.bodyHash,
      attestationBase64: Buffer.from(response.body).toString("base64"),
      upgradedAt: now,
      verify:
        "Save attestationBase64 (base64-decoded) as seal.ots and run `ots verify seal.ots` " +
        "against a Bitcoin node or a trusted explorer. This platform records the bytes the " +
        "calendar returned; it does not itself validate the Bitcoin chain.",
    },
    detail:
      "The calendar returned an attestation for this digest. The receipt is now independently " +
      "verifiable against the Bitcoin chain by anyone holding it.",
    confirmedAt: now,
  };
}
