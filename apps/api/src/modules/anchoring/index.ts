/**
 * M1 — Ledger anchoring & escrow (spec Vol II Domain S #860-861, #864,
 * #873-874; docs/roadmap.md "Structural holes" #2; docs/security.md §8.2
 * gaps 2-3).
 *
 * THE HOLE THIS CLOSES. `ledger_entries` is a per-company hash chain: every
 * entry's hash covers its content and its predecessor's hash, so an edit to
 * entry k invalidates k…n and `GET /ledger/verify` reports the break. That is
 * tamper-evidence against EDITS, and it is the whole of what the chain can do
 * by itself. Two attacks walk straight through it, and both are available to
 * whoever controls the database — which, on a self-hosted deployment, is the
 * party whose record is under scrutiny:
 *
 *   TAIL TRUNCATION   Delete the last N entries. The remainder verifies
 *                     perfectly. Nothing in the chain knows how long it was
 *                     supposed to be.
 *
 *   WHOLESALE REWRITE Recompute every hash from genesis over a different
 *                     history. The result verifies perfectly. Nothing inside
 *                     the database can defeat an attacker who owns everything
 *                     inside the database.
 *
 * A SEAL closes both: it commits to `entryCount` (so a shorter chain is
 * arithmetic, not judgement) and to a Merkle root over every entry hash (so a
 * different history is a different root), and it is SIGNED with an Ed25519 key
 * whose private half is in the process environment and never in the database.
 * Seals are chained to each other by `prevSealHash` and numbered contiguously
 * from 1, so deleting the seal that would have noticed is itself noticed.
 *
 * ESCROW is what turns "we verified our own chain" into "a third party can
 * verify it": a self-contained receipt — seal body, signature, public key,
 * fingerprint, procedure in words — handed to a named counterparty, who can
 * later present it back (POST /ledger/escrow/verify) or verify it entirely
 * offline with `apps/api/src/scripts/verify-receipt.ts`.
 *
 * WHAT THIS STILL DOES NOT PROVE, stated here because a module like this is
 * dangerous when it overstates itself:
 *   • With no ANCHOR_SIGNING_KEY configured, the key is DERIVED FROM
 *     AUTH_SECRET and is therefore held by the same operator as the
 *     application. It defeats a database-only attacker; it does not defeat the
 *     operator, who could re-derive and re-sign. Every response and every
 *     receipt made under such a key says so (`derivedFromAuthSecret`).
 *   • `sealedAt` is this application's clock until an RFC 3161 anchor
 *     succeeds. This deployment has no timestamp authority configured, so
 *     seals prove ORDER, not wall-clock time (§8.2 gap 3 is narrowed, not
 *     closed).
 *   • A seal proves the record has not changed since it was sealed. It says
 *     nothing about whether the record was TRUE when written — that is the
 *     reconciliation engine's job.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  anchorSubmissions,
  chainSeals,
  escrowReceipts,
  ledgerEntries,
  signals,
} from "@constructos/db";
import { ANCHOR_PROVIDERS, type AnchorProvider, type ChainVerdict } from "@constructos/shared";
import {
  buildSealBody,
  canonicalize,
  classifyChain,
  merkleRoot,
  sealBodyHash,
  sha256Hex,
  signSealBody,
  verifySealSignature,
  type ChainClassification,
  type SealBody,
  type SealChainVerdict,
  type SealRecord,
  type SealedChainEntry,
} from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  anchorKeyState,
  listVisibleKeys,
  registerPublicKey,
  requireAnchorKey,
  retireOtherKeys,
  type AnchorKeyEnv,
  type AnchorKeyRecord,
} from "./keys.js";
import {
  PROVIDER_REQUIREMENTS,
  submitAnchor,
  type AnchorProviderEnv,
} from "./providers.js";

/**
 * Compile-time proof that the ledger package's local verdict union and
 * `CHAIN_VERDICTS` in @constructos/shared are the same set. The ledger package
 * cannot import shared (it must stay usable by an offline verifier), so this
 * assertion is the thing that stops the two drifting.
 */
type VerdictParity = [SealChainVerdict] extends [ChainVerdict]
  ? [ChainVerdict] extends [SealChainVerdict]
    ? true
    : never
  : never;
const VERDICTS_MATCH: VerdictParity = true;

/** Tracks apps/api/package.json; carried in every escrow receipt. */
export const PLATFORM = { name: "ConstructOS", version: "0.1.0" } as const;

export const RECEIPT_DOCUMENT_TYPE = "constructos.escrow-receipt";
export const RECEIPT_DOCUMENT_VERSION = 1;

/** Ledger objectType used for the module's own appends. */
const SEAL_OBJECT = "chain_seal";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const sealCreateSchema = z.object({
  /** seal even when nothing material changed since the last one */
  force: z.boolean().optional(),
  note: z.string().max(2000).optional(),
});

const anchorSchema = z.object({
  provider: z.enum(ANCHOR_PROVIDERS),
  counterpartyName: z.string().min(1).max(200).optional(),
  counterpartyRef: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
});

const anchorConfirmSchema = z.object({
  externalRef: z.string().min(1).max(200),
  acknowledgedBy: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
});

const anchorsListQuery = pageQuerySchema.extend({
  provider: z.enum(ANCHOR_PROVIDERS).optional(),
  sealId: z.string().min(1).max(64).optional(),
});

const escrowIssueSchema = z.object({
  recipientName: z.string().min(1).max(200),
  recipientRef: z.string().min(1).max(200).nullable().optional(),
  recipientUserId: z.string().min(1).max(64).nullable().optional(),
  purpose: z.string().max(2000).nullable().optional(),
});

const receiptsListQuery = pageQuerySchema.extend({
  sealId: z.string().min(1).max(64).optional(),
});

/** The receipt document as presented back for verification. */
const receiptDocumentSchema = z.object({
  documentType: z.literal(RECEIPT_DOCUMENT_TYPE),
  version: z.number().int().min(1),
  receiptId: z.string().min(1).max(64),
  issuedAt: z.string().min(4),
  issuer: z.object({
    platform: z.string().min(1),
    platformVersion: z.string().min(1),
    companyId: z.string().min(1).max(64),
  }),
  seal: z.object({
    sealId: z.string().min(1).max(64),
    companyId: z.string().min(1).max(64),
    sequence: z.number().int().min(1),
    fromEntrySeq: z.number().int().min(1),
    toEntrySeq: z.number().int().min(1),
    entryCount: z.number().int().min(1),
    headHash: z.string().length(64),
    merkleRoot: z.string().length(64),
    prevSealHash: z.string().length(64).nullable(),
    sealedAt: z.string().min(4),
    keyId: z.string().min(1).max(200),
    algorithm: z.string().min(1).max(50),
    bodyHash: z.string().length(64),
    signature: z.string().min(1).max(400),
  }),
  key: z.object({
    keyId: z.string().min(1).max(200),
    algorithm: z.string().min(1).max(50),
    publicKeyPem: z.string().min(1).max(4000),
    fingerprint: z.string().length(64),
    derivedFromAuthSecret: z.boolean(),
    weakening: z.string().nullable(),
  }),
  receiptHash: z.string().length(64),
});

type ReceiptDocument = z.infer<typeof receiptDocumentSchema>;

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */

type SealRow = typeof chainSeals.$inferSelect;
type AnchorRow = typeof anchorSubmissions.$inferSelect;

/**
 * Postgres and PGlite hand a `timestamptz` back as "2026-08-25 10:20:00.1+00",
 * not as the ISO-8601 string that was written. The seal body is SIGNED, so the
 * exact bytes matter: everything that reconstructs a body normalizes through
 * here, and `buildSealBody` normalizes again as a backstop.
 */
function isoOf(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/**
 * Build a `SealRecord` from a stored row WITHOUT validating it. Validation is
 * `classifyChain`'s job: a row with an impossible `entryCount` must produce a
 * verdict, not a 500.
 */
function toSealRecord(row: SealRow): SealRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    sequence: row.sequence,
    fromEntrySeq: row.fromEntrySeq,
    toEntrySeq: row.toEntrySeq,
    entryCount: row.entryCount,
    headHash: row.headHash,
    merkleRoot: row.merkleRoot,
    prevSealHash: row.prevSealHash,
    sealedAt: isoOf(row.sealedAt),
    keyId: row.keyId,
    algorithm: row.algorithm,
    bodyHash: row.bodyHash,
    signature: row.signature,
  };
}

function sealBodyOf(record: SealRecord): SealBody {
  const { bodyHash, signature, id, ...body } = record;
  void bodyHash;
  void signature;
  void id;
  return body;
}

/**
 * A key id beginning `ankd_` was derived from AUTH_SECRET (see keys.ts). The
 * flag is recoverable from the id alone, which is what lets a seal made months
 * ago still report the weakening that applied when it was made.
 */
function derivedKeyId(keyId: string): boolean {
  return keyId.startsWith("ankd_");
}

const DERIVED_NOTE_FALLBACK =
  "This seal was signed with a key derived from AUTH_SECRET, held by the same operator that " +
  "runs this application: it proves integrity against a database-only attacker, not against " +
  "the operator.";

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const anchoringModule: FastifyPluginAsync = async (app) => {
  void VERDICTS_MATCH;

  /**
   * Reads are open to every company member. That deliberately includes users
   * whose reach comes from an assurance grant (`requireAssuranceRole` resolves
   * against `assurance_grants` for a user who is already a company member, so
   * an auditor or integrity reviewer reaches these routes through
   * `requireCompany`): the chain verdict is the endpoint an auditor lives on,
   * and gating it behind owner/admin would put the record's custodian between
   * the auditor and the record.
   */
  const memberGate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /* ---------------------------------------------------------------- */
  /* Environment                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Anchoring configuration is read from `process.env` at call time rather
   * than from the boot-time config schema: the signing key is a secret this
   * module must not copy into a shared, loggable config object, and reading it
   * late means an operator can set it without a redeploy on platforms that
   * support it.
   */
  function anchorEnv(): AnchorKeyEnv & AnchorProviderEnv {
    return {
      NODE_ENV: app.appConfig.NODE_ENV,
      AUTH_SECRET: app.appConfig.AUTH_SECRET,
      ANCHOR_SIGNING_KEY: process.env["ANCHOR_SIGNING_KEY"],
      ANCHOR_TSA_URL: process.env["ANCHOR_TSA_URL"],
      ANCHOR_OTS_CALENDAR_URL: process.env["ANCHOR_OTS_CALENDAR_URL"],
    };
  }

  /** Heartbeat interval in hours; bounds how long a truncation can hide. */
  function heartbeatHours(): number {
    const raw = Number(process.env["ANCHOR_HEARTBEAT_HOURS"]);
    return Number.isFinite(raw) && raw > 0 ? raw : 24;
  }

  /* ---------------------------------------------------------------- */
  /* Loading the chain and its seals                                   */
  /* ---------------------------------------------------------------- */

  async function loadEntries(companyId: string): Promise<SealedChainEntry[]> {
    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, companyId))
      .orderBy(asc(ledgerEntries.seq));
    return rows.map((r) => ({
      seq: Number(r.seq),
      companyId: r.companyId,
      actorId: r.actorId,
      action: r.action,
      objectType: r.objectType,
      objectId: r.objectId,
      payloadHash: r.payloadHash,
      // Carried so classifyChain can re-derive the snapshot's own hash: the
      // chain covers `payloadHash`, never the snapshot it was taken over.
      payload: r.payload,
      at: isoOf(r.at),
      prevHash: r.prevHash,
      entryHash: r.entryHash,
    }));
  }

  async function loadSeals(companyId: string): Promise<SealRow[]> {
    return app.db
      .select()
      .from(chainSeals)
      .where(eq(chainSeals.companyId, companyId))
      .orderBy(asc(chainSeals.sequence));
  }

  async function fetchSeal(sealId: string, companyId: string): Promise<SealRow> {
    const rows = await app.db
      .select()
      .from(chainSeals)
      .where(and(eq(chainSeals.id, sealId), eq(chainSeals.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Seal not found");
    return rows[0];
  }

  /**
   * Public keys available for signature checking, by keyId: everything on
   * record plus the key this process currently holds (which may not be
   * registered yet — a seal must be verifiable the instant it is made).
   */
  async function publicKeyMap(companyId: string): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    for (const row of await listVisibleKeys(app.db, companyId)) {
      map[row.keyId] = row.publicKeyPem;
    }
    const state = anchorKeyState(anchorEnv());
    if (state.available) map[state.record.keyId] = state.record.publicKeyPem;
    return map;
  }

  interface KeyInfo {
    keyId: string;
    algorithm: string;
    fingerprint: string | null;
    publicKeyPem: string | null;
    derivedFromAuthSecret: boolean;
    weakening: string | null;
    /** false when no public key for this id is on record — nothing can be checked */
    known: boolean;
  }

  async function keyInfoFor(keyId: string, companyId: string): Promise<KeyInfo> {
    const derived = derivedKeyId(keyId);
    const rows = await listVisibleKeys(app.db, companyId);
    const row = rows.find((r) => r.keyId === keyId);
    const state = anchorKeyState(anchorEnv());
    const envRecord =
      state.available && state.record.keyId === keyId ? state.record : null;
    const pem = envRecord?.publicKeyPem ?? row?.publicKeyPem ?? null;
    return {
      keyId,
      algorithm: envRecord?.algorithm ?? row?.algorithm ?? "ed25519",
      fingerprint: envRecord?.fingerprint ?? row?.fingerprint ?? null,
      publicKeyPem: pem,
      derivedFromAuthSecret: derived,
      weakening: derived ? (envRecord?.weakening ?? DERIVED_NOTE_FALLBACK) : null,
      known: Boolean(pem),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Views                                                             */
  /* ---------------------------------------------------------------- */

  function sealView(row: SealRow, key: KeyInfo) {
    const record = toSealRecord(row);
    return {
      id: row.id,
      companyId: row.companyId,
      sequence: row.sequence,
      fromEntrySeq: row.fromEntrySeq,
      toEntrySeq: row.toEntrySeq,
      entryCount: row.entryCount,
      headHash: row.headHash,
      merkleRoot: row.merkleRoot,
      prevSealHash: row.prevSealHash,
      bodyHash: row.bodyHash,
      signature: row.signature,
      keyId: row.keyId,
      algorithm: row.algorithm,
      sealedAt: isoOf(row.sealedAt),
      isHeartbeat: row.isHeartbeat === 1,
      sealedBy: row.sealedBy,
      createdAt: row.createdAt,
      /** the exact object that was signed — canonicalize this to reproduce the bytes */
      body: sealBodyOf(record),
      key,
      derivedFromAuthSecret: key.derivedFromAuthSecret,
      weakening: key.weakening,
      timeCaveat:
        "sealedAt is this application's clock. Until an RFC 3161 anchor succeeds, a seal " +
        "proves ORDER (it came after the previous seal), not wall-clock time.",
    };
  }

  /* ---------------------------------------------------------------- */
  /* Signals — a broken chain is a critical finding                    */
  /* ---------------------------------------------------------------- */

  const VERDICT_DETECTOR: Record<Exclude<ChainVerdict, "intact" | "no_seals">, string> = {
    tail_truncated: "ledger_truncation_detected",
    seal_broken: "chain_seal_broken",
    seal_forged: "chain_seal_forged",
    // The three names above are the ones the design brief specifies. An
    // altered entry inside a sealed range needs its own name or it would be
    // the one broken-chain verdict that raises nothing at all.
    entry_altered: "ledger_entry_altered",
  };

  const VERDICT_TITLE: Record<Exclude<ChainVerdict, "intact" | "no_seals">, string> = {
    tail_truncated: "Ledger truncation detected — sealed entries are missing",
    seal_broken: "Chain seal linkage broken — a seal has been removed or relinked",
    seal_forged: "Chain seal does not verify — forged or altered after signing",
    entry_altered: "Ledger entry altered inside a sealed range",
  };

  /**
   * Raise a critical signal for a broken chain, once per distinct finding.
   * Idempotency is keyed on verdict + the seal and entry it was localized to,
   * so re-reading the verdict every minute does not manufacture a signal
   * storm, while a NEW break (a different entry, a later seal) still fires.
   * `projectId` is null: this is a tenant-level finding and `signals.projectId`
   * is nullable for exactly that case.
   */
  async function raiseVerdictSignal(
    companyId: string,
    actorId: string | null,
    result: ChainClassification,
  ): Promise<string | null> {
    if (result.verdict === "intact" || result.verdict === "no_seals") return null;
    const detector = VERDICT_DETECTOR[result.verdict];
    // The identity of a finding is what it is ABOUT, not what the chain
    // happened to look like when it was read. An altered entry is identified
    // by that entry; a truncation or a seal failure by the seal that caught it
    // — the surviving head moves every time anything is appended, and keying
    // on it would raise a fresh critical signal on every poll.
    const fingerprint =
      result.verdict === "entry_altered"
        ? `entry_altered:entry:${result.failedEntrySeq ?? "-"}`
        : `${result.verdict}:seal:${result.failedSealSequence ?? "-"}`;
    const existing = await app.db
      .select({ id: signals.id, refs: signals.evidenceRefs })
      .from(signals)
      .where(and(eq(signals.companyId, companyId), eq(signals.detector, detector)));
    for (const row of existing) {
      const refs = row.refs as { fingerprint?: string } | null;
      if (refs?.fingerprint === fingerprint) return null;
    }
    const id = newId("sig");
    await app.db.insert(signals).values({
      id,
      companyId,
      projectId: null,
      detector,
      severity: "critical",
      confidence: 1,
      title: VERDICT_TITLE[result.verdict],
      explanation:
        `${result.reason} ` +
        "This is a finding about the record itself, not about anything recorded in it: until " +
        "it is explained, every figure this tenant can produce is unsupported by its own audit " +
        "trail. Preserve a database backup now, before investigating.",
      evidenceRefs: {
        fingerprint,
        verdict: result.verdict,
        sealSequence: result.failedSealSequence,
        entrySeq: result.failedEntrySeq,
        suspectRange: result.suspectRange,
        entryCount: result.entryCount,
        sealedEntryCount: result.sealedEntryCount,
      },
    });
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "signal",
      objectId: id,
      payload: { detector, severity: "critical", verdict: result.verdict },
    });
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* Classification                                                    */
  /* ---------------------------------------------------------------- */

  interface VerdictResult extends ChainClassification {
    key: {
      keyId: string | null;
      derivedFromAuthSecret: boolean;
      weakening: string | null;
      /** the newest seal was signed under the key this process currently holds */
      heldByProcess: boolean;
    };
    /**
     * Key ids that seals were signed under which this process does NOT hold.
     * Their public halves could only come from `signing_keys`, so their
     * signatures are checkable but not attributable. See
     * {@link FOREIGN_KEY_LIMITATION}.
     */
    keyIdsNotHeldByThisProcess: string[];
    limitations: string[];
  }

  /**
   * The one limit the signature check cannot state for itself.
   *
   * A seal's whole strength is that the private half of its key is outside the
   * database. That only helps a verifier who knows which PUBLIC key to expect.
   * `publicKeyMap` merges the keys on record in `signing_keys` — a table inside
   * the very database the seal exists to police — so an attacker with database
   * write access can register a key of their own, re-sign a rewritten chain
   * under it, and every signature will verify. The process cannot tell that
   * apart from a legitimate rotation, and must not pretend otherwise: what it
   * CAN say is which key it holds itself, and that anything else came from the
   * database. Everything under a key this process does not hold is checkable,
   * not attributable.
   */
  function foreignKeyLimitation(keyIds: string[]): string {
    return (
      `Seal(s) here are signed under key id(s) ${keyIds.join(", ")}, which is not the key this ` +
      "deployment holds. Their public halves came from `signing_keys`, a table inside the same " +
      "database the seal exists to police, so those signatures prove the seal bodies are " +
      "internally consistent — they do NOT prove who made them: anyone able to write to this " +
      "database could have registered that key and re-signed a rewritten chain under it. Either " +
      "the deployment's signing key was rotated, or this chain was re-sealed by something else. " +
      "Compare the key fingerprint (GET /api/v1/ledger/keys) against an independently held copy " +
      "before relying on this verdict."
    );
  }

  /**
   * The limits that apply to EVERY verdict this module produces. They are part
   * of the result, not documentation: a verdict of "intact" carried without
   * them would be read as more than it is.
   */
  function limitationsFor(
    derived: boolean,
    sealCount: number,
    foreignKeyIds: string[] = [],
  ): string[] {
    const out: string[] = [];
    if (derived) out.push(DERIVED_NOTE_FALLBACK);
    if (foreignKeyIds.length > 0) out.push(foreignKeyLimitation(foreignKeyIds));
    out.push(
      "sealedAt is this application's own clock; no timestamp authority is configured, so " +
        "seals establish order, not wall-clock time.",
    );
    if (sealCount > 0) {
      out.push(
        "Entries appended since the newest seal are covered by the hash chain only: a " +
          "truncation confined to them is not yet detectable. Heartbeat seals bound that window.",
      );
    }
    out.push(
      "A verified seal proves the record has not changed since it was sealed. It does not " +
        "prove any record was true when written.",
    );
    return out;
  }

  /** The key id this process holds right now, or null when it holds none. */
  function heldKeyId(): string | null {
    const state = anchorKeyState(anchorEnv());
    return state.available ? state.record.keyId : null;
  }

  /** Distinct seal key ids that are not the key this process holds. */
  function foreignKeyIdsOf(seals: SealRecord[]): string[] {
    const held = heldKeyId();
    return [...new Set(seals.map((s) => s.keyId))].filter((id) => id !== held);
  }

  async function classifyCompany(companyId: string): Promise<VerdictResult> {
    const [entries, sealRows, keys] = await Promise.all([
      loadEntries(companyId),
      loadSeals(companyId),
      publicKeyMap(companyId),
    ]);
    const seals = sealRows.map(toSealRecord);
    const result = classifyChain({ entries, seals, publicKeys: keys });
    const latestKeyId = seals[seals.length - 1]?.keyId ?? null;
    const derived = seals.some((s) => derivedKeyId(s.keyId));
    const foreign = foreignKeyIdsOf(seals);
    return {
      ...result,
      key: {
        keyId: latestKeyId,
        derivedFromAuthSecret: derived,
        weakening: derived ? DERIVED_NOTE_FALLBACK : null,
        heldByProcess: latestKeyId !== null && latestKeyId === heldKeyId(),
      },
      keyIdsNotHeldByThisProcess: foreign,
      limitations: limitationsFor(derived, seals.length, foreign),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Sealing                                                           */
  /* ---------------------------------------------------------------- */

  interface SealOutcome {
    seal: SealRow;
    created: boolean;
    /** an existing recent seal was returned because nothing material changed */
    reused: boolean;
    key: AnchorKeyRecord;
    entriesSinceLastSeal: number;
  }

  /**
   * Seal the company's chain as it stands.
   *
   * Idempotent-ish by design: if the previous seal is younger than the
   * heartbeat interval and nothing MATERIAL has been appended since (the
   * module's own `chain_seal` entries do not count — sealing appends one, and
   * counting it would make every seal justify the next), the existing seal is
   * returned instead of churning out a fresh signature over an identical head.
   */
  async function createSeal(
    companyId: string,
    actorId: string | null,
    opts: { heartbeat?: boolean; force?: boolean; note?: string | undefined } = {},
  ): Promise<SealOutcome> {
    const key = requireAnchorKey(anchorEnv());
    const entries = await loadEntries(companyId);
    if (entries.length === 0) {
      throw badRequest(
        "There are no ledger entries to seal for this company. A seal commits to a chain; " +
          "there is nothing here to commit to yet.",
      );
    }
    const existing = await loadSeals(companyId);
    const last = existing[existing.length - 1];
    const sinceLast = last
      ? entries.filter((e) => e.seq > last.toEntrySeq && e.objectType !== SEAL_OBJECT).length
      : entries.length;

    if (last && !opts.force) {
      const ageMs = Date.now() - Date.parse(isoOf(last.sealedAt));
      if (sinceLast === 0 && ageMs < heartbeatHours() * 3_600_000) {
        return { seal: last, created: false, reused: true, key: key.record, entriesSinceLastSeal: 0 };
      }
    }

    const head = entries[entries.length - 1]!;
    const sealedAt = new Date().toISOString();
    const body = buildSealBody({
      companyId,
      sequence: (last?.sequence ?? 0) + 1,
      // The seal commits to the WHOLE chain, so the range is the whole chain.
      // What is new since the previous seal is `prevSeal.toEntrySeq + 1`.
      fromEntrySeq: entries[0]!.seq,
      toEntrySeq: head.seq,
      entryCount: entries.length,
      headHash: head.entryHash,
      merkleRoot: merkleRoot(entries.map((e) => e.entryHash)),
      prevSealHash: last?.bodyHash ?? null,
      sealedAt,
      keyId: key.record.keyId,
    });
    const bodyHash = sealBodyHash(body);
    const signature = signSealBody(body, key.privateKey);
    const id = newId("seal");
    await app.db.insert(chainSeals).values({
      id,
      companyId,
      sequence: body.sequence,
      fromEntrySeq: body.fromEntrySeq,
      toEntrySeq: body.toEntrySeq,
      entryCount: body.entryCount,
      headHash: body.headHash,
      merkleRoot: body.merkleRoot,
      prevSealHash: body.prevSealHash,
      bodyHash,
      signature,
      keyId: body.keyId,
      algorithm: body.algorithm,
      sealedAt,
      isHeartbeat: opts.heartbeat ? 1 : 0,
      sealedBy: actorId,
    });

    // Register the public half opportunistically: a seal nobody can verify
    // because the key was never published is not much of a seal.
    await registerPublicKey(app.db, key.record);

    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: SEAL_OBJECT,
      objectId: id,
      payload: {
        sequence: body.sequence,
        entryCount: body.entryCount,
        headHash: body.headHash,
        merkleRoot: body.merkleRoot,
        prevSealHash: body.prevSealHash,
        bodyHash,
        keyId: body.keyId,
        derivedFromAuthSecret: key.record.derivedFromAuthSecret,
        isHeartbeat: opts.heartbeat === true,
        note: opts.note ?? null,
      },
      storePayload: true,
    });

    const rows = await app.db.select().from(chainSeals).where(eq(chainSeals.id, id)).limit(1);
    return {
      seal: rows[0]!,
      created: true,
      reused: false,
      key: key.record,
      entriesSinceLastSeal: sinceLast,
    };
  }

  /**
   * HEARTBEAT SWEEP — the lazy pattern used by the payments deemed-liability,
   * finance overdue-condition and jurisdiction permit sweeps: work that must
   * happen on a schedule is done on the reads that care about it, because this
   * platform runs no scheduler.
   *
   * Why it matters here specifically: a seal only bounds truncation up to the
   * entries it covers. Without heartbeats, a tenant that seals once and then
   * goes quiet leaves an unbounded tail that can be cut invisibly. A heartbeat
   * seal re-commits to the head every `ANCHOR_HEARTBEAT_HOURS` (default 24)
   * even when nothing changed, so the exposure window is one interval.
   *
   * Never throws: a monitoring read must not 500 because sealing is
   * unavailable (no key in production, for instance).
   */
  async function sweepHeartbeat(companyId: string, actorId: string | null): Promise<boolean> {
    try {
      const existing = await loadSeals(companyId);
      const last = existing[existing.length - 1];
      if (!last) return false; // never sealed: sealing is an explicit, ledgered act
      const ageMs = Date.now() - Date.parse(isoOf(last.sealedAt));
      if (ageMs < heartbeatHours() * 3_600_000) return false;
      const outcome = await createSeal(companyId, actorId, { heartbeat: true, force: true });
      return outcome.created;
    } catch (err) {
      app.log.warn({ err, companyId }, "heartbeat seal skipped");
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Keys                                                              */
  /* ---------------------------------------------------------------- */

  app.get("/ledger/keys", { preHandler: memberGate }, async (req) => {
    const rows = await listVisibleKeys(app.db, req.companyId!);
    const state = anchorKeyState(anchorEnv());
    return {
      // Public halves only. The private key is never in this table and never
      // in a response — see the module test that asserts it.
      items: rows.map((r) => ({
        id: r.id,
        keyId: r.keyId,
        algorithm: r.algorithm,
        publicKeyPem: r.publicKeyPem,
        fingerprint: r.fingerprint,
        activeFrom: r.activeFrom,
        retiredAt: r.retiredAt,
        derivedFromAuthSecret: derivedKeyId(r.keyId),
        weakening: derivedKeyId(r.keyId) ? DERIVED_NOTE_FALLBACK : null,
      })),
      current: state.available
        ? {
            keyId: state.record.keyId,
            algorithm: state.record.algorithm,
            publicKeyPem: state.record.publicKeyPem,
            fingerprint: state.record.fingerprint,
            source: state.record.source,
            derivedFromAuthSecret: state.record.derivedFromAuthSecret,
            weakening: state.record.weakening,
            registered: rows.some((r) => r.keyId === state.record.keyId),
          }
        : null,
      unavailable: state.available ? null : { reason: state.reason, remedy: state.remedy },
    };
  });

  app.post("/ledger/keys/rotate", { preHandler: adminGate }, async (req) => {
    const key = requireAnchorKey(anchorEnv());
    const { row, created } = await registerPublicKey(app.db, key.record);
    const retired = await retireOtherKeys(app.db, key.record.keyId);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: created ? "create" : "access",
      objectType: "signing_key",
      objectId: row.id,
      payload: {
        keyId: key.record.keyId,
        fingerprint: key.record.fingerprint,
        source: key.record.source,
        derivedFromAuthSecret: key.record.derivedFromAuthSecret,
        retiredOthers: retired,
      },
      storePayload: true,
    });
    return {
      key: {
        id: row.id,
        keyId: row.keyId,
        algorithm: row.algorithm,
        publicKeyPem: row.publicKeyPem,
        fingerprint: row.fingerprint,
        activeFrom: row.activeFrom,
        source: key.record.source,
        derivedFromAuthSecret: key.record.derivedFromAuthSecret,
        weakening: key.record.weakening,
      },
      created,
      retiredOtherKeys: retired,
      note:
        "Only the public half was written. Rotation does not invalidate earlier seals: they " +
        "are verified against the key id they were made under, which stays on record.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Seals                                                             */
  /* ---------------------------------------------------------------- */

  app.post("/ledger/seals", { preHandler: adminGate }, async (req, reply) => {
    const body = sealCreateSchema.parse(req.body ?? {});
    const outcome = await createSeal(req.companyId!, req.user!.id, {
      force: body.force,
      note: body.note,
    });
    const key = await keyInfoFor(outcome.seal.keyId, req.companyId!);
    const view = {
      ...sealView(outcome.seal, key),
      reused: outcome.reused,
      entriesSinceLastSeal: outcome.entriesSinceLastSeal,
      ...(outcome.reused
        ? {
            note:
              "Nothing material has been appended since the last seal and it is still within " +
              `the heartbeat interval (${heartbeatHours()}h), so the existing seal was ` +
              "returned. Pass {\"force\":true} to seal anyway.",
          }
        : {}),
    };
    return reply.status(outcome.created ? 201 : 200).send(view);
  });

  app.get("/ledger/seals", { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    await sweepHeartbeat(req.companyId!, req.user!.id);
    const where = eq(chainSeals.companyId, req.companyId!);
    const [totalRow] = await app.db.select({ n: count() }).from(chainSeals).where(where);
    const rows = await app.db
      .select()
      .from(chainSeals)
      .where(where)
      .orderBy(desc(chainSeals.sequence))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const keyCache = new Map<string, KeyInfo>();
    const items = [];
    for (const row of rows) {
      let key = keyCache.get(row.keyId);
      if (!key) {
        key = await keyInfoFor(row.keyId, req.companyId!);
        keyCache.set(row.keyId, key);
      }
      items.push(sealView(row, key));
    }
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/ledger/seals/:sealId", { preHandler: memberGate }, async (req) => {
    const { sealId } = req.params as { sealId: string };
    const row = await fetchSeal(sealId, req.companyId!);
    return sealView(row, await keyInfoFor(row.keyId, req.companyId!));
  });

  /**
   * Re-verify ONE seal against the live chain: the signature, the stored body
   * hash, and whether the entries the seal committed to are still present,
   * unaltered and producing the sealed Merkle root.
   */
  app.get("/ledger/seals/:sealId/verify", { preHandler: memberGate }, async (req) => {
    const { sealId } = req.params as { sealId: string };
    const row = await fetchSeal(sealId, req.companyId!);
    const record = toSealRecord(row);
    const key = await keyInfoFor(row.keyId, req.companyId!);
    const entries = await loadEntries(req.companyId!);

    let body: SealBody | null = null;
    let bodyError: string | null = null;
    try {
      body = buildSealBody(record);
    } catch (err) {
      bodyError = (err as Error).message;
    }
    const bodyHashMatches = body ? sealBodyHash(body) === row.bodyHash : false;
    const signatureValid =
      body && key.publicKeyPem
        ? verifySealSignature(body, row.signature, key.publicKeyPem)
        : false;

    const prefix = entries.slice(0, row.entryCount);
    const entriesPresent = entries.length >= row.entryCount;
    const recomputedRoot = entriesPresent ? merkleRoot(prefix.map((e) => e.entryHash)) : null;
    const headEntry = entriesPresent ? prefix[prefix.length - 1]! : null;

    // The single-seal verdict is the whole-chain classification restricted to
    // this seal, so one seal and the chain as a whole can never disagree.
    //
    // "Restricted to this seal" means the seal chain UP TO AND INCLUDING it,
    // not the seal alone: `verifySealChain` requires sequences contiguous from
    // 1, so classifying seal 3 by itself reported "seal_broken — a seal is
    // missing" on a perfectly intact chain. A seal is also only as good as the
    // seals it chains to, so its predecessors belong in its own verdict.
    const sealChainToHere = (await loadSeals(req.companyId!))
      .filter((s) => s.sequence <= row.sequence)
      .map(toSealRecord);
    const whole = classifyChain({
      entries,
      seals: sealChainToHere,
      publicKeys: await publicKeyMap(req.companyId!),
    });

    return {
      sealId: row.id,
      sequence: row.sequence,
      verdict: whole.verdict,
      ok: whole.ok,
      reason: whole.reason,
      checks: {
        bodyWellFormed: bodyError === null,
        bodyError,
        bodyHashMatches,
        signatureValid,
        signatureCheckable: key.known,
        entriesPresent,
        entryCountSealed: row.entryCount,
        entryCountNow: entries.length,
        merkleRootMatches: recomputedRoot === row.merkleRoot,
        recomputedMerkleRoot: recomputedRoot,
        headHashMatches: headEntry ? headEntry.entryHash === row.headHash : false,
      },
      key: {
        keyId: key.keyId,
        fingerprint: key.fingerprint,
        derivedFromAuthSecret: key.derivedFromAuthSecret,
        weakening: key.weakening,
        heldByProcess: key.keyId === heldKeyId(),
      },
      limitations: limitationsFor(
        key.derivedFromAuthSecret,
        1,
        foreignKeyIdsOf(sealChainToHere),
      ),
    };
  });

  /**
   * THE AUDITOR'S ENDPOINT. The full classification of this company's chain
   * against every seal it has.
   *
   * Deliberately does NOT append an `access` ledger entry, unlike
   * `GET /ledger/verify` in the assurance module. A monitoring endpoint that
   * mutates the object it monitors grows the chain in proportion to how
   * closely it is watched, and would make the heartbeat sweep believe the
   * chain is always changing. Escrow verification — a consequential act by a
   * third party — is ledgered instead.
   */
  app.get("/ledger/chain-verdict", { preHandler: memberGate }, async (req) => {
    await sweepHeartbeat(req.companyId!, req.user!.id);
    const result = await classifyCompany(req.companyId!);
    const signalId = await raiseVerdictSignal(req.companyId!, req.user!.id, result);
    const seals = await loadSeals(req.companyId!);
    const newest = seals[seals.length - 1];
    return {
      ...result,
      companyId: req.companyId!,
      heartbeat: {
        intervalHours: heartbeatHours(),
        newestSealAt: newest ? isoOf(newest.sealedAt) : null,
        newestSealIsHeartbeat: newest ? newest.isHeartbeat === 1 : null,
        overdue: newest
          ? Date.now() - Date.parse(isoOf(newest.sealedAt)) >= heartbeatHours() * 3_600_000
          : null,
      },
      signalRaised: signalId,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Anchors                                                           */
  /* ---------------------------------------------------------------- */

  app.post("/ledger/seals/:sealId/anchor", { preHandler: adminGate }, async (req, reply) => {
    const { sealId } = req.params as { sealId: string };
    const body = anchorSchema.parse(req.body ?? {});
    const seal = await fetchSeal(sealId, req.companyId!);
    const key = await keyInfoFor(seal.keyId, req.companyId!);
    const state = anchorKeyState(anchorEnv());
    const keyRecord: AnchorKeyRecord = state.available
      ? state.record
      : {
          keyId: key.keyId,
          algorithm: "ed25519",
          publicKeyPem: key.publicKeyPem ?? "",
          fingerprint: key.fingerprint ?? "",
          source: key.derivedFromAuthSecret ? "derived_from_auth_secret" : "env",
          derivedFromAuthSecret: key.derivedFromAuthSecret,
          weakening: key.weakening,
        };

    const attempt = await submitAnchor({
      provider: body.provider,
      bodyHash: seal.bodyHash,
      sealId: seal.id,
      sealSequence: seal.sequence,
      signature: seal.signature,
      key: keyRecord,
      counterparty: body.counterpartyName
        ? { name: body.counterpartyName, ref: body.counterpartyRef ?? null, note: body.note ?? null }
        : undefined,
      env: anchorEnv(),
    });

    const id = newId("anch");
    await app.db.insert(anchorSubmissions).values({
      id,
      companyId: req.companyId!,
      sealId: seal.id,
      provider: attempt.provider,
      status: attempt.status,
      externalRef: attempt.externalRef,
      proof: attempt.proof,
      detail: attempt.detail,
      confirmedAt: attempt.confirmedAt,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "anchor_submission",
      objectId: id,
      payload: {
        sealId: seal.id,
        provider: attempt.provider,
        status: attempt.status,
        externalRef: attempt.externalRef,
        detail: attempt.detail,
      },
      storePayload: true,
    });

    const rows = await app.db
      .select()
      .from(anchorSubmissions)
      .where(eq(anchorSubmissions.id, id))
      .limit(1);
    return reply.status(201).send({
      ...rows[0]!,
      requirements: PROVIDER_REQUIREMENTS[attempt.provider],
      reach: providerReach(attempt.provider, attempt.status, keyRecord.derivedFromAuthSecret),
    });
  });

  /** One sentence per provider on how far the witness actually reaches. */
  function providerReach(
    provider: AnchorProvider,
    status: string,
    derived: boolean,
  ): string {
    if (status === "unavailable") {
      return "Nothing was witnessed anywhere. This submission records the attempt and what is missing.";
    }
    switch (provider) {
      case "local_signed":
        return derived
          ? "Witnessed by a key derived from AUTH_SECRET: outside the database, inside the operator."
          : "Witnessed by a key held outside the database in this deployment's environment.";
      case "rfc3161":
        return "Witnessed by an external timestamp authority — an independent clock and an independent signature.";
      case "opentimestamps":
        return "Submitted to a public calendar; independently verifiable once it reaches the Bitcoin chain.";
      case "counterparty":
        return "Held by a named third party outside this database once they acknowledge the reference.";
      default:
        return "Unknown provider.";
    }
  }

  /**
   * Counterparty acknowledgement. This is what makes the counterparty provider
   * real rather than aspirational: the third party returns a reference and the
   * submission becomes `anchored` with their acknowledgement on record.
   */
  app.post("/ledger/anchors/:anchorId/confirm", { preHandler: adminGate }, async (req) => {
    const { anchorId } = req.params as { anchorId: string };
    const body = anchorConfirmSchema.parse(req.body ?? {});
    const rows = await app.db
      .select()
      .from(anchorSubmissions)
      .where(
        and(eq(anchorSubmissions.id, anchorId), eq(anchorSubmissions.companyId, req.companyId!)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Anchor submission not found");
    if (row.provider !== "counterparty") {
      throw badRequest(
        `Only counterparty anchors are confirmed by hand; ${row.provider} anchors are confirmed ` +
          "by the provider's own response, and claiming otherwise would fabricate a proof.",
      );
    }
    if (row.status === "anchored") {
      throw badRequest("This anchor is already confirmed.");
    }
    const confirmedAt = new Date().toISOString();
    const proof = {
      ...(row.proof as Record<string, unknown>),
      acknowledgement: {
        externalRef: body.externalRef,
        acknowledgedBy: body.acknowledgedBy ?? null,
        note: body.note ?? null,
        recordedAt: confirmedAt,
        recordedBy: req.user!.id,
      },
    };
    await app.db
      .update(anchorSubmissions)
      .set({ status: "anchored", externalRef: body.externalRef, proof, confirmedAt })
      .where(eq(anchorSubmissions.id, anchorId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "anchor_submission",
      objectId: anchorId,
      payload: { status: "anchored", externalRef: body.externalRef },
      storePayload: true,
    });
    const updated = await app.db
      .select()
      .from(anchorSubmissions)
      .where(eq(anchorSubmissions.id, anchorId))
      .limit(1);
    return {
      ...updated[0]!,
      note:
        "Recorded as acknowledged by this platform's operator. The counterparty's own copy of " +
        "the escrow receipt, not this row, is what makes the anchor independent.",
    };
  });

  app.get("/ledger/anchors", { preHandler: memberGate }, async (req) => {
    const q = anchorsListQuery.parse(req.query);
    const where = and(
      eq(anchorSubmissions.companyId, req.companyId!),
      q.provider ? eq(anchorSubmissions.provider, q.provider) : undefined,
      q.sealId ? eq(anchorSubmissions.sealId, q.sealId) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(anchorSubmissions).where(where);
    const rows = await app.db
      .select()
      .from(anchorSubmissions)
      .where(where)
      .orderBy(desc(anchorSubmissions.requestedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return {
      ...paginate(
        rows.map((r: AnchorRow) => ({
          ...r,
          requirements: PROVIDER_REQUIREMENTS[r.provider as AnchorProvider],
        })),
        Number(totalRow?.n ?? 0),
        q,
      ),
      providers: PROVIDER_REQUIREMENTS,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Escrow                                                            */
  /* ---------------------------------------------------------------- */

  const VERIFICATION_PROCEDURE = [
    "1. Recompute the receipt hash: remove the `receiptHash` field, canonicalize the remaining " +
      "document (RFC 8785-style: keys sorted, no insignificant whitespace) and take its sha256. " +
      "It must equal `receiptHash`.",
    "2. Canonicalize the `seal` object WITHOUT its `sealId`, `bodyHash` and `signature` fields " +
      "— the remaining eleven fields, key-sorted, are the exact bytes that were signed — and " +
      "take their sha256. It must equal `seal.bodyHash`.",
    "3. Verify `seal.signature` (base64, Ed25519) over those same canonical bytes using " +
      "`key.publicKeyPem`. Any Ed25519 implementation will do; `node apps/api/dist/scripts/" +
      "verify-receipt.js receipt.json` performs steps 1-3 offline.",
    "4. Compare `key.fingerprint` with the fingerprint published by the platform " +
      "(GET /api/v1/ledger/keys) THROUGH A DIFFERENT CHANNEL than the one that gave you this " +
      "receipt. A receipt that carries its own key proves internal consistency only: without " +
      "an independent copy of the fingerprint, a whole receipt could have been manufactured.",
    "5. To prove the live chain still contains what was sealed, present this document to " +
      "POST /api/v1/ledger/escrow/verify. The chain must hold at least `seal.entryCount` " +
      "entries, and the first `seal.entryCount` of them must reproduce `seal.merkleRoot` and " +
      "end in `seal.headHash`.",
  ];

  const PROVES = [
    "That at the moment of sealing, this company's ledger held exactly `entryCount` entries " +
      "ending in `headHash`, and that they hash to `merkleRoot`.",
    "That the seal was made by something holding the private key matching `key.publicKeyPem`.",
    "That any later chain which is shorter than `entryCount`, or whose first `entryCount` " +
      "entries do not reproduce `merkleRoot`, is not the chain that was sealed.",
  ];

  const DOES_NOT_PROVE = [
    "That anything recorded in the ledger was TRUE. A seal covers integrity, not accuracy.",
    "The wall-clock time of sealing. `sealedAt` is the application server's clock; only an " +
      "RFC 3161 or blockchain anchor would fix it independently, and none is configured here.",
    "Anything about entries appended AFTER this seal.",
  ];

  function receiptKeyBlock(key: KeyInfo) {
    return {
      keyId: key.keyId,
      algorithm: key.algorithm,
      publicKeyPem: key.publicKeyPem ?? "",
      fingerprint: key.fingerprint ?? "",
      derivedFromAuthSecret: key.derivedFromAuthSecret,
      weakening: key.weakening,
    };
  }

  /** Build the receipt document and its self-hash. */
  function buildReceiptDocument(input: {
    receiptId: string;
    issuedAt: string;
    companyId: string;
    seal: SealRow;
    key: KeyInfo;
    recipient: { name: string; ref: string | null; userId: string | null; purpose: string | null };
    issuedBy: string;
  }): { document: Record<string, unknown>; receiptHash: string } {
    const record = toSealRecord(input.seal);
    const body = sealBodyOf(record);
    const withoutHash = {
      documentType: RECEIPT_DOCUMENT_TYPE,
      version: RECEIPT_DOCUMENT_VERSION,
      receiptId: input.receiptId,
      issuedAt: input.issuedAt,
      issuer: {
        platform: PLATFORM.name,
        platformVersion: PLATFORM.version,
        companyId: input.companyId,
        issuedByUserId: input.issuedBy,
      },
      recipient: {
        name: input.recipient.name,
        ref: input.recipient.ref,
        userId: input.recipient.userId,
        purpose: input.recipient.purpose,
      },
      seal: {
        sealId: input.seal.id,
        ...body,
        bodyHash: input.seal.bodyHash,
        signature: input.seal.signature,
        isHeartbeat: input.seal.isHeartbeat === 1,
      },
      key: receiptKeyBlock(input.key),
      verification: {
        procedure: VERIFICATION_PROCEDURE,
        offlineTool: "node verify-receipt.js receipt.json",
        liveEndpoint: "POST /api/v1/ledger/escrow/verify",
        proves: PROVES,
        doesNotProve: input.key.derivedFromAuthSecret
          ? [
              ...DOES_NOT_PROVE,
              "That the OPERATOR of this deployment did not produce it: this seal's key was " +
                "derived from AUTH_SECRET, which the operator holds. It proves integrity " +
                "against anyone with database access only.",
            ]
          : DOES_NOT_PROVE,
      },
    };
    const receiptHash = sha256Hex(canonicalize(withoutHash));
    return { document: { ...withoutHash, receiptHash }, receiptHash };
  }

  app.post("/ledger/seals/:sealId/escrow", { preHandler: adminGate }, async (req, reply) => {
    const { sealId } = req.params as { sealId: string };
    const body = escrowIssueSchema.parse(req.body ?? {});
    const seal = await fetchSeal(sealId, req.companyId!);
    const key = await keyInfoFor(seal.keyId, req.companyId!);
    if (!key.publicKeyPem) {
      throw new AppError(
        503,
        `No public key is on record for key id ${seal.keyId}, so a self-contained receipt ` +
          "cannot be issued: the holder would have nothing to verify the signature with. " +
          "Register the key with POST /api/v1/ledger/keys/rotate.",
      );
    }
    const receiptId = newId("esc");
    const issuedAt = new Date().toISOString();
    const { document, receiptHash } = buildReceiptDocument({
      receiptId,
      issuedAt,
      companyId: req.companyId!,
      seal,
      key,
      recipient: {
        name: body.recipientName,
        ref: body.recipientRef ?? null,
        userId: body.recipientUserId ?? null,
        purpose: body.purpose ?? null,
      },
      issuedBy: req.user!.id,
    });
    await app.db.insert(escrowReceipts).values({
      id: receiptId,
      companyId: req.companyId!,
      sealId: seal.id,
      recipientName: body.recipientName,
      recipientRef: body.recipientRef ?? null,
      recipientUserId: body.recipientUserId ?? null,
      receiptHash,
      document,
      purpose: body.purpose ?? null,
      issuedBy: req.user!.id,
      issuedAt,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "escrow_receipt",
      objectId: receiptId,
      payload: {
        sealId: seal.id,
        sealSequence: seal.sequence,
        recipientName: body.recipientName,
        recipientRef: body.recipientRef ?? null,
        receiptHash,
        keyId: seal.keyId,
        derivedFromAuthSecret: key.derivedFromAuthSecret,
      },
      storePayload: true,
    });
    return reply.status(201).send({
      id: receiptId,
      companyId: req.companyId!,
      sealId: seal.id,
      recipientName: body.recipientName,
      recipientRef: body.recipientRef ?? null,
      recipientUserId: body.recipientUserId ?? null,
      purpose: body.purpose ?? null,
      issuedAt,
      receiptHash,
      document,
      downloadUrl: `/api/v1/ledger/escrow-receipts/${receiptId}/document`,
      handover:
        "Send the `document` object verbatim. It is self-contained: the holder needs nothing " +
        "from this platform to check the signature, and needs only POST /ledger/escrow/verify " +
        "to check the live chain still contains what was sealed.",
    });
  });

  app.get("/ledger/escrow-receipts", { preHandler: memberGate }, async (req) => {
    const q = receiptsListQuery.parse(req.query);
    const where = and(
      eq(escrowReceipts.companyId, req.companyId!),
      q.sealId ? eq(escrowReceipts.sealId, q.sealId) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(escrowReceipts).where(where);
    // The document blob is deliberately omitted from the list: it is fetched
    // one at a time from the /document route, which is the thing handed over.
    const items = await app.db
      .select({
        id: escrowReceipts.id,
        companyId: escrowReceipts.companyId,
        sealId: escrowReceipts.sealId,
        recipientName: escrowReceipts.recipientName,
        recipientRef: escrowReceipts.recipientRef,
        recipientUserId: escrowReceipts.recipientUserId,
        receiptHash: escrowReceipts.receiptHash,
        purpose: escrowReceipts.purpose,
        issuedBy: escrowReceipts.issuedBy,
        issuedAt: escrowReceipts.issuedAt,
        lastVerifiedAt: escrowReceipts.lastVerifiedAt,
        lastVerdict: escrowReceipts.lastVerdict,
      })
      .from(escrowReceipts)
      .where(where)
      .orderBy(desc(escrowReceipts.issuedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((r) => ({
        ...r,
        downloadUrl: `/api/v1/ledger/escrow-receipts/${r.id}/document`,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /** The exact JSON handed over, as a download. */
  app.get(
    "/ledger/escrow-receipts/:receiptId/document",
    { preHandler: memberGate },
    async (req, reply) => {
      const { receiptId } = req.params as { receiptId: string };
      const rows = await app.db
        .select()
        .from(escrowReceipts)
        .where(
          and(eq(escrowReceipts.id, receiptId), eq(escrowReceipts.companyId, req.companyId!)),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Escrow receipt not found");
      // Pretty-printed for a human reading it in an email attachment. Safe:
      // receiptHash is over the CANONICAL form, which is whitespace-independent.
      return reply
        .header("content-type", "application/json; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="constructos-escrow-receipt-${receiptId}.json"`,
        )
        .send(JSON.stringify(rows[0].document, null, 2));
    },
  );

  /* ---------------------------------------------------------------- */
  /* Escrow verification — a receipt presented back                    */
  /* ---------------------------------------------------------------- */

  app.post("/ledger/escrow/verify", { preHandler: memberGate }, async (req) => {
    const raw = req.body as Record<string, unknown> | null | undefined;
    if (!raw || typeof raw !== "object") {
      throw badRequest("Send the escrow receipt document, or {\"document\": {…}}.");
    }
    const candidate = (
      "document" in raw && raw["document"] && typeof raw["document"] === "object"
        ? raw["document"]
        : raw
    ) as Record<string, unknown>;

    const parsed = receiptDocumentSchema.safeParse(candidate);
    if (!parsed.success) {
      throw badRequest(
        "This is not a ConstructOS escrow receipt document (or it is missing required fields). " +
          "Nothing was verified.",
        { issues: parsed.error.issues.slice(0, 10) },
      );
    }
    const doc: ReceiptDocument = parsed.data;

    /* 1. the document's own integrity ------------------------------ */
    const { receiptHash: claimedHash, ...withoutHash } = candidate as Record<string, unknown> & {
      receiptHash: string;
    };
    const recomputedReceiptHash = sha256Hex(canonicalize(withoutHash));
    const receiptIntact = recomputedReceiptHash === claimedHash;

    /* 2. the seal body and its signature --------------------------- */
    const sealFields = doc.seal;
    let body: SealBody | null = null;
    let bodyError: string | null = null;
    try {
      body = buildSealBody({
        companyId: sealFields.companyId,
        sequence: sealFields.sequence,
        fromEntrySeq: sealFields.fromEntrySeq,
        toEntrySeq: sealFields.toEntrySeq,
        entryCount: sealFields.entryCount,
        headHash: sealFields.headHash,
        merkleRoot: sealFields.merkleRoot,
        prevSealHash: sealFields.prevSealHash,
        sealedAt: sealFields.sealedAt,
        keyId: sealFields.keyId,
        algorithm: sealFields.algorithm,
      });
    } catch (err) {
      bodyError = (err as Error).message;
    }
    const bodyHashMatches = body ? sealBodyHash(body) === sealFields.bodyHash : false;
    const signatureValid = body
      ? verifySealSignature(body, sealFields.signature, doc.key.publicKeyPem)
      : false;

    /* 3. is the key in the receipt a key we actually published? ---- */
    const onRecord = await listVisibleKeys(app.db, req.companyId!);
    const keyRow = onRecord.find((k) => k.keyId === doc.key.keyId);
    const keyRecognized = Boolean(
      keyRow &&
        keyRow.fingerprint === doc.key.fingerprint &&
        keyRow.publicKeyPem.trim() === doc.key.publicKeyPem.trim(),
    );

    /* 4. the live chain — only ever this tenant's own -------------- */
    const sameCompany = doc.issuer.companyId === req.companyId! &&
      sealFields.companyId === req.companyId!;
    let chain: VerdictResult | null = null;
    let sealOnRecord: SealRow | null = null;
    let receiptOnRecord = false;
    let prefixChecks: {
      entriesNow: number;
      entriesSealed: number;
      entriesPresent: boolean;
      merkleRootMatches: boolean;
      headHashMatches: boolean;
      recomputedMerkleRoot: string | null;
    } | null = null;

    if (sameCompany) {
      const entries = await loadEntries(req.companyId!);
      const prefix = entries.slice(0, sealFields.entryCount);
      const entriesPresent = entries.length >= sealFields.entryCount;
      const recomputedRoot = entriesPresent ? merkleRoot(prefix.map((e) => e.entryHash)) : null;
      prefixChecks = {
        entriesNow: entries.length,
        entriesSealed: sealFields.entryCount,
        entriesPresent,
        merkleRootMatches: recomputedRoot === sealFields.merkleRoot,
        headHashMatches: entriesPresent
          ? prefix[prefix.length - 1]!.entryHash === sealFields.headHash
          : false,
        recomputedMerkleRoot: recomputedRoot,
      };
      chain = await classifyCompany(req.companyId!);
      const sealRows = await app.db
        .select()
        .from(chainSeals)
        .where(
          and(eq(chainSeals.id, sealFields.sealId), eq(chainSeals.companyId, req.companyId!)),
        )
        .limit(1);
      sealOnRecord = sealRows[0] ?? null;
      const receiptRows = await app.db
        .select({ id: escrowReceipts.id })
        .from(escrowReceipts)
        .where(
          and(eq(escrowReceipts.id, doc.receiptId), eq(escrowReceipts.companyId, req.companyId!)),
        )
        .limit(1);
      receiptOnRecord = Boolean(receiptRows[0]);
    }

    /* 5. the verdict ------------------------------------------------ */
    let verdict: ChainVerdict;
    let reason: string;
    const scope: "live_chain" | "receipt_only" = sameCompany ? "live_chain" : "receipt_only";

    if (!signatureValid) {
      verdict = "seal_forged";
      reason = body
        ? "The signature in this receipt does not verify against the public key the receipt " +
          "itself carries. The document has been altered after issue, or it was never issued " +
          "by anything holding that key."
        : `The seal body in this receipt is malformed (${bodyError ?? "unknown"}), so no ` +
          "signature over it could be checked.";
    } else if (!receiptIntact) {
      verdict = "seal_forged";
      reason =
        "The seal signature verifies, but the receipt document around it has been altered: " +
        `its recomputed hash is ${recomputedReceiptHash}, not the ${claimedHash} it claims. ` +
        "Trust the seal fields, not the surrounding document.";
    } else if (!sameCompany) {
      verdict = "intact";
      reason =
        "The receipt is internally consistent and its signature verifies under the key it " +
        "carries. It was issued for a different company than the one this request is scoped " +
        "to, so the live chain was NOT consulted: nothing here says whether that chain still " +
        "contains what was sealed. Present this receipt to the issuing tenant, or verify the " +
        "key fingerprint out of band.";
    } else if (prefixChecks && !prefixChecks.entriesPresent) {
      verdict = "tail_truncated";
      reason =
        `This receipt was issued over ${sealFields.entryCount} entries; the live chain now ` +
        `holds ${prefixChecks.entriesNow}. ${sealFields.entryCount - prefixChecks.entriesNow} ` +
        "sealed entries are gone. The remaining chain still verifies internally, which is " +
        "exactly why this receipt exists.";
    } else if (prefixChecks && (!prefixChecks.merkleRootMatches || !prefixChecks.headHashMatches)) {
      verdict = chain && chain.verdict !== "intact" ? chain.verdict : "entry_altered";
      reason =
        `This receipt commits the first ${sealFields.entryCount} entries to Merkle root ` +
        `${sealFields.merkleRoot}; those entries now produce ` +
        `${prefixChecks.recomputedMerkleRoot ?? "a different root"}. ` +
        (chain ? chain.reason : "");
    } else if (chain && chain.verdict !== "intact") {
      // The sealed prefix is fine but the chain has some other problem
      // (a later seal removed, a later entry altered): report it, do not
      // let a good receipt vouch for a bad chain.
      verdict = chain.verdict;
      reason =
        "The prefix this receipt commits to is present and unaltered, but the chain as a " +
        `whole does not verify: ${chain.reason}`;
    } else {
      verdict = "intact";
      reason =
        `The signature verifies, the receipt is unaltered, and the live chain still holds all ` +
        `${sealFields.entryCount} sealed entries, in order, producing the sealed Merkle root.`;
    }

    /* 6. record the presentation ------------------------------------ */
    const verifiedAt = new Date().toISOString();
    if (receiptOnRecord) {
      await app.db
        .update(escrowReceipts)
        .set({ lastVerifiedAt: verifiedAt, lastVerdict: verdict })
        .where(eq(escrowReceipts.id, doc.receiptId));
    }
    // Unlike the read-only verdict endpoint, presenting a receipt IS a
    // consequential act — someone is asserting something about this record —
    // so it goes in the ledger.
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "escrow_receipt",
      objectId: doc.receiptId,
      payload: {
        verify: true,
        verdict,
        scope,
        receiptOnRecord,
        receiptHash: claimedHash,
        signatureValid,
        keyRecognized,
      },
      storePayload: true,
    });
    if (sameCompany && chain) {
      await raiseVerdictSignal(req.companyId!, req.user!.id, {
        ...chain,
        verdict: verdict as SealChainVerdict,
      });
    }

    const derived = doc.key.derivedFromAuthSecret;
    return {
      verdict,
      ok: verdict === "intact",
      scope,
      reason,
      receipt: {
        receiptId: doc.receiptId,
        issuedAt: doc.issuedAt,
        issuerCompanyId: doc.issuer.companyId,
        sealId: sealFields.sealId,
        sealSequence: sealFields.sequence,
        /** issued by THIS tenant and still on record here */
        onRecord: receiptOnRecord,
        sealOnRecord: Boolean(sealOnRecord),
        intact: receiptIntact,
        recomputedReceiptHash,
        bodyHashMatches,
        signatureValid,
        bodyError,
      },
      key: {
        keyId: doc.key.keyId,
        fingerprint: doc.key.fingerprint,
        /** the receipt's key matches a key this platform has published */
        recognized: keyRecognized,
        /** …and is the key this process actually holds, not merely one on record */
        heldByProcess: doc.key.keyId === heldKeyId(),
        derivedFromAuthSecret: derived,
        weakening: derived ? (doc.key.weakening ?? DERIVED_NOTE_FALLBACK) : null,
      },
      liveChain: sameCompany
        ? { checked: true, ...prefixChecks, verdict: chain?.verdict ?? null }
        : {
            checked: false,
            why:
              "This receipt names a different company than the tenant context of this request. " +
              "Reading another tenant's chain to answer a question about their receipt would " +
              "be a tenant-isolation breach, so it was not read.",
          },
      limitations: [
        ...limitationsFor(
          derived,
          sameCompany ? 1 : 0,
          doc.key.keyId === heldKeyId() ? [] : [doc.key.keyId],
        ),
        keyRecognized
          ? "The receipt's public key matches a key published by this platform."
          : "The receipt's public key is NOT on this platform's key register. The signature " +
            "checks out against the key the receipt carries, which proves internal consistency " +
            "only — compare the fingerprint against an independently obtained copy before " +
            "relying on it.",
        ...(scope === "receipt_only"
          ? ["The live chain was not consulted; this verdict covers the document only."]
          : []),
      ],
      verifiedAt,
    };
  });
};
