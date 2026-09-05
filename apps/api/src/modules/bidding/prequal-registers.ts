import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import {
  prequalificationFinancials,
  prequalificationLicences,
  prequalificationQuestions,
  prequalificationReferences,
  prequalificationResponses,
  prequalificationSafetyRecords,
  prequalificationSubmissions,
  signals,
  vendors,
} from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import {
  PREQUAL_LICENCE_STATUSES,
  PREQUAL_REFERENCE_OUTCOMES,
  PREQUAL_SAFETY_SOURCES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound, unauthorized } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  assertVendor,
  currencySchema,
  detailSchema,
  fetchPrequalSubmission,
  fetchQuestionnaire,
  isoDateSchema,
  ledger,
  nonNegativeMoneySchema,
  reasonSchema,
  todayIso,
  type PrequalSubmissionRow,
} from "./shared.js";
import {
  assessTier,
  type LicenceFact,
  type ReferenceFact,
  type SafetyFact,
  type TieringVerdict,
} from "./tiering.js";
import { latestScreening } from "./prequal-status.js";
import {
  isStructuralItemType,
  validateAnswer,
  type ChecklistItemSpec,
} from "../quality/checklistItems.js";

/**
 * The question, in the shared checklist vocabulary the validator speaks.
 * Mirrors `questionSpec` in prequalification.ts: one question means one thing
 * whether the buyer or the vendor is answering it.
 */
function prequalQuestionSpec(
  q: typeof prequalificationQuestions.$inferSelect,
): ChecklistItemSpec {
  return {
    id: q.id,
    itemNumber: q.questionCode,
    text: q.text,
    itemType: q.itemType,
    required: q.required === 1,
    options: (q.options as string[]) ?? [],
    targetValue: null,
    minValue: q.minValue,
    maxValue: q.maxValue,
    tolerancePlus: null,
    toleranceMinus: null,
    unit: q.unit,
    weight: q.weight,
    isCritical: q.isKnockout === 1,
    photoRequired: false,
    raisesNcrOnFail: false,
  };
}

/**
 * WHAT A PREQUALIFICATION ACTUALLY TURNS ON — AND WHO FILLS IT IN.
 *
 * The questionnaire is prose with a score on it. The three things that
 * actually decide whether a firm may be let onto a site are none of them
 * prose:
 *
 *   SAFETY   an EMR, a TRIR and a fatality count are numbers that compare
 *            across vendors and across years. Written into a free-text answer
 *            they compare with nothing, and the rule that matters — "a
 *            fatality caps this vendor at tier C, whatever the balance sheet
 *            says" — cannot be applied at all.
 *   LICENCES a licence has a jurisdiction and an EXPIRY. An expired licence is
 *            the single most common prequalification finding and it is
 *            invisible in a paragraph. Here it expires on a schedule, on its
 *            own, whether or not anybody opens the page.
 *   REFERENCES a reference is a client, a project, a value and a person who
 *            was ACTUALLY ASKED. `checkedBy` is the whole difference between
 *            "we took up references" and "we hold a list of names the vendor
 *            gave us", and the tiering rule refuses tier A without one.
 *
 * And the second half of this file answers the other question the register
 * has always begged: WHO TYPES IT IN. Until now, a company member did — which
 * meant the buyer's own staff answered on the vendor's behalf, and the
 * "vendor's declaration" was a declaration by the person assessing it. A `pq_`
 * token (minted, hashed, shown once, expiring — exactly the `bpt_` discipline
 * the bidder portal uses) lets the vendor answer for themselves, and the
 * submission then carries a declaration somebody outside this company made.
 *
 * Deliberately NOT here: verification of any of it. A licence number typed by
 * a vendor is `claimed` until a named person marks it `verified`, and nothing
 * in this file promotes a claim on its own.
 */

/* ------------------------------------------------------------------ */
/* Vendor portal tokens                                                */
/* ------------------------------------------------------------------ */

export const PREQUAL_TOKEN_PREFIX = "pq_";

export function mintPrequalToken(): { raw: string; hash: string; display: string } {
  const raw = `${PREQUAL_TOKEN_PREFIX}${randomBytes(20).toString("hex")}`;
  return { raw, hash: sha256Hex(raw), display: `${raw.slice(0, 7)}...` };
}

/** How long a vendor's prequalification link lives. */
export const PREQUAL_TOKEN_DAYS = 30;

export function prequalTokenExpiry(days: number = PREQUAL_TOKEN_DAYS, now = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * Resolve a vendor from a `pq_` token and nothing else. The four refusals, in
 * order: not a portal token; no such token; the token has expired; the
 * assessment is over. A credential that outlives the assessment it was minted
 * for is a credential nobody revoked.
 */
export async function resolvePrequalSession(
  db: Db,
  rawHeader: string | undefined,
): Promise<PrequalSubmissionRow> {
  if (!rawHeader?.startsWith("Bearer ")) throw unauthorized("Missing prequalification token");
  const raw = rawHeader.slice(7).trim();
  if (!raw.startsWith(PREQUAL_TOKEN_PREFIX)) throw unauthorized("Not a prequalification token");
  const rows = await db
    .select()
    .from(prequalificationSubmissions)
    .where(eq(prequalificationSubmissions.portalTokenHash, sha256Hex(raw)))
    .limit(1);
  const submission = rows[0];
  if (!submission) throw unauthorized("Invalid or revoked prequalification token");
  if (
    submission.portalTokenExpiresAt &&
    Date.parse(submission.portalTokenExpiresAt) < Date.now()
  ) {
    throw unauthorized(
      `This prequalification link expired on ${submission.portalTokenExpiresAt}. Ask the buyer ` +
        "for a new one — an access credential that never expires outlives the assessment it " +
        "belonged to.",
    );
  }
  if (!["invited", "in_progress", "submitted"].includes(submission.status)) {
    throw unauthorized(
      `This prequalification is ${submission.status} and is no longer open for answers. The ` +
        "outcome is communicated by the buyer, not read back out of the form.",
    );
  }
  return submission;
}

async function ledgerVendorAction(
  db: Db,
  submission: PrequalSubmissionRow,
  action: "access" | "create" | "update" | "state_change",
  payload: Record<string, unknown>,
): Promise<void> {
  await appendLedger(db, {
    companyId: submission.companyId,
    actorId: null,
    action,
    objectType: "prequalification_submission",
    objectId: submission.id,
    payload: { via: "prequal_token", vendorId: submission.vendorId, ...payload },
    projectId: submission.projectId,
    storePayload: true,
  });
}

/* ------------------------------------------------------------------ */
/* Loading the typed registers                                         */
/* ------------------------------------------------------------------ */

export interface VendorEvidence {
  safety: (typeof prequalificationSafetyRecords.$inferSelect)[];
  licences: (typeof prequalificationLicences.$inferSelect)[];
  references: (typeof prequalificationReferences.$inferSelect)[];
}

export async function loadVendorEvidence(
  db: Db,
  companyId: string,
  vendorId: string,
): Promise<VendorEvidence> {
  const [safety, licences, references] = await Promise.all([
    db
      .select()
      .from(prequalificationSafetyRecords)
      .where(
        and(
          eq(prequalificationSafetyRecords.companyId, companyId),
          eq(prequalificationSafetyRecords.vendorId, vendorId),
        ),
      )
      .orderBy(desc(prequalificationSafetyRecords.year)),
    db
      .select()
      .from(prequalificationLicences)
      .where(
        and(
          eq(prequalificationLicences.companyId, companyId),
          eq(prequalificationLicences.vendorId, vendorId),
        ),
      )
      .orderBy(asc(prequalificationLicences.expiresAt)),
    db
      .select()
      .from(prequalificationReferences)
      .where(
        and(
          eq(prequalificationReferences.companyId, companyId),
          eq(prequalificationReferences.vendorId, vendorId),
        ),
      )
      .orderBy(desc(prequalificationReferences.completedAt)),
  ]);
  return { safety, licences, references };
}

export const toSafetyFacts = (rows: VendorEvidence["safety"]): SafetyFact[] =>
  rows.map((r) => ({
    year: r.year,
    emr: r.emr,
    trir: r.trir,
    dart: r.dart,
    fatalities: r.fatalities,
    source: r.source,
  }));

export const toLicenceFacts = (rows: VendorEvidence["licences"]): LicenceFact[] =>
  rows.map((r) => ({ kind: r.kind, status: r.status, expiresAt: r.expiresAt }));

export const toReferenceFacts = (rows: VendorEvidence["references"]): ReferenceFact[] =>
  rows.map((r) => ({ outcome: r.outcome, checkedBy: r.checkedBy }));

/**
 * The tier a decision would grant, computed from everything on file. Called
 * on `decide` (where the verdict is persisted) and exposed read-only on the
 * vendor standing view so a buyer can see the answer BEFORE they make the
 * decision that depends on it.
 */
export async function tierForSubmission(
  db: Db,
  submission: PrequalSubmissionRow,
  overrides: { scorePercent?: number | null; singleProjectLimit?: number | null; currency?: string } = {},
  asOf: string = todayIso(),
): Promise<TieringVerdict> {
  const evidence = await loadVendorEvidence(db, submission.companyId, submission.vendorId);
  const questionnaire = await fetchQuestionnaire(
    db,
    submission.questionnaireId,
    submission.companyId,
  );
  const screening = await latestScreening(db, submission.companyId, submission.vendorId);
  const limit =
    overrides.singleProjectLimit !== undefined
      ? overrides.singleProjectLimit
      : (submission.singleProjectLimit ?? screening?.value ?? null);
  return assessTier({
    scorePercent:
      overrides.scorePercent !== undefined ? overrides.scorePercent : submission.scorePercent,
    passThreshold: questionnaire.passThreshold,
    knockoutFailed: submission.knockoutFailed === 1,
    singleProjectLimit: limit,
    limitCurrency: overrides.currency ?? screening?.currency ?? submission.currency,
    safety: toSafetyFacts(evidence.safety),
    licences: toLicenceFacts(evidence.licences),
    references: toReferenceFacts(evidence.references),
    asOf,
  });
}

/* ------------------------------------------------------------------ */
/* Licence expiry sweep                                                */
/* ------------------------------------------------------------------ */

/** The detector name every licence-expiry signal carries. */
export const PREQUAL_LICENCE_DETECTOR = "prequalification_licence_expired";

export interface LicenceSweepResult {
  expired: string[];
  signalled: number;
}

/**
 * A LICENCE EXPIRES WHETHER OR NOT ANYBODY OPENS THE PAGE.
 *
 * Idempotent by construction: the status flip is conditional on the row still
 * being `claimed`/`verified`, and the signal is fingerprinted on the licence
 * id so a second run raises nothing. Bounded by the (companyId, expiresAt)
 * index — it never reads the whole register.
 */
export async function sweepPrequalLicences(
  db: Db,
  companyId: string,
  asOf: string = todayIso(),
): Promise<LicenceSweepResult> {
  const due = await db
    .select()
    .from(prequalificationLicences)
    .where(
      and(
        eq(prequalificationLicences.companyId, companyId),
        isNotNull(prequalificationLicences.expiresAt),
        lte(prequalificationLicences.expiresAt, asOf),
        inArray(prequalificationLicences.status, ["claimed", "verified"]),
      ),
    )
    .limit(500);
  if (due.length === 0) return { expired: [], signalled: 0 };

  const vendorRows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(
      and(
        eq(vendors.companyId, companyId),
        inArray(vendors.id, [...new Set(due.map((l) => l.vendorId))]),
      ),
    );
  const vendorName = new Map(vendorRows.map((v) => [v.id, v.name] as const));

  /*
   * IDEMPOTENCE, BOUNDED BY THE ROWS IN HAND. The fingerprint carries the
   * licence id, so "have we already said this" is one indexed lookup over the
   * licences about to expire rather than a scan of every signal this company
   * has ever raised. Raising the same lapse twice is a bug: it is the
   * false-positive fatigue that makes people stop reading the register.
   */
  const fingerprints = due.map((l) => `${PREQUAL_LICENCE_DETECTOR}:${l.id}`);
  const existing = await db
    .select({ fingerprint: signals.fingerprint })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.detector, PREQUAL_LICENCE_DETECTOR),
        inArray(signals.fingerprint, fingerprints),
      ),
    );
  const seen = new Set(
    existing.map((s) => s.fingerprint).filter((k): k is string => typeof k === "string"),
  );

  const expired: string[] = [];
  let signalled = 0;
  const now = new Date().toISOString();
  for (const licence of due) {
    const flipped = await db
      .update(prequalificationLicences)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(prequalificationLicences.id, licence.id),
          inArray(prequalificationLicences.status, ["claimed", "verified"]),
        ),
      )
      .returning({ id: prequalificationLicences.id });
    if (flipped.length === 0) continue;
    expired.push(licence.id);
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "prequalification_licence",
      objectId: licence.id,
      payload: {
        event: "licence_expired",
        vendorId: licence.vendorId,
        kind: licence.kind,
        expiresAt: licence.expiresAt,
        asOf,
      },
      storePayload: true,
    });
    if (seen.has(`${PREQUAL_LICENCE_DETECTOR}:${licence.id}`)) continue;
    const name = vendorName.get(licence.vendorId) ?? licence.vendorId;
    await db.insert(signals).values({
      id: newId("sig"),
      companyId,
      projectId: null,
      detector: PREQUAL_LICENCE_DETECTOR,
      severity: "high",
      confidence: 1,
      title: `Licence expired — ${name} (${licence.kind})`,
      explanation:
        `${name}'s ${licence.kind} licence${licence.number ? ` ${licence.number}` : ""} expired ` +
        `on ${licence.expiresAt}. A prequalified vendor working on an expired licence is the ` +
        "finding the register exists to prevent, and it does not announce itself: nothing about " +
        "the vendor changes on the day it lapses.",
      evidenceRefs: {
        key: licence.id,
        licenceId: licence.id,
        vendorId: licence.vendorId,
        kind: licence.kind,
        expiresAt: licence.expiresAt,
      },
      fingerprint: `${PREQUAL_LICENCE_DETECTOR}:${licence.id}`,
      subjectType: "vendor",
      subjectId: licence.vendorId,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    signalled += 1;
    seen.add(`${PREQUAL_LICENCE_DETECTOR}:${licence.id}`);
  }
  return { expired, signalled };
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const citationSchema = z.object({
  agency: z.string().trim().min(1).max(200),
  date: isoDateSchema.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  penalty: z.number().finite().nullable().optional(),
  currency: currencySchema.nullable().optional(),
  status: z.string().max(60).nullable().optional(),
});

const safetySchema = z.object({
  vendorId: z.string().min(1).max(64),
  submissionId: z.string().min(1).max(64).nullable().optional(),
  year: z.number().int().min(1900).max(2200),
  emr: z.number().finite().min(0).max(20).nullable().optional(),
  trir: z.number().finite().min(0).max(500).nullable().optional(),
  dart: z.number().finite().min(0).max(500).nullable().optional(),
  fatalities: z.number().int().min(0).max(10000).nullable().optional(),
  lostTimeInjuries: z.number().int().min(0).max(100000).nullable().optional(),
  recordableIncidents: z.number().int().min(0).max(100000).nullable().optional(),
  hoursWorked: z.number().finite().min(0).nullable().optional(),
  citations: z.array(citationSchema).max(200).optional(),
  source: z.enum(PREQUAL_SAFETY_SOURCES).default("self_declared"),
  fileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  note: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});

const licenceSchema = z.object({
  vendorId: z.string().min(1).max(64),
  submissionId: z.string().min(1).max(64).nullable().optional(),
  kind: z.string().trim().min(1).max(120),
  jurisdiction: z.string().max(120).nullable().optional(),
  number: z.string().max(120).nullable().optional(),
  issuedBy: z.string().max(200).nullable().optional(),
  issuedAt: isoDateSchema.nullable().optional(),
  expiresAt: isoDateSchema.nullable().optional(),
  fileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  note: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});

const referenceSchema = z.object({
  vendorId: z.string().min(1).max(64),
  submissionId: z.string().min(1).max(64).nullable().optional(),
  clientName: z.string().trim().min(1).max(300),
  projectName: z.string().max(300).nullable().optional(),
  contractValue: nonNegativeMoneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  completedAt: isoDateSchema.nullable().optional(),
  contactName: z.string().max(200).nullable().optional(),
  contactEmail: z.string().max(320).nullable().optional(),
  contactPhone: z.string().max(60).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const prequalRegisterRoutes: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];
  const BASE = "/companies/current/prequalification";

  /**
   * A register row may only be bound to a submission belonging to the SAME
   * vendor in the SAME company. Ids travel — they are in ledger payloads and
   * in the responses this module returns — so an id is never authority.
   */
  async function resolveSubmissionBinding(
    companyId: string,
    vendorId: string,
    submissionId: string | null | undefined,
  ): Promise<string | null> {
    if (!submissionId) return null;
    const submission = await fetchPrequalSubmission(app.db, submissionId, companyId);
    if (submission.vendorId !== vendorId) {
      throw badRequest(
        "That prequalification belongs to a different vendor. A safety record, a licence or a " +
          "reference is evidence about ONE firm; filing it against another firm's assessment " +
          "would put it in front of the wrong decision.",
      );
    }
    return submission.id;
  }

  /* ---------------------------------------------------------------- */
  /* Safety records                                                    */
  /* ---------------------------------------------------------------- */

  app.post(`${BASE}/safety-records`, { preHandler: adminGate }, async (req, reply) => {
    const body = safetySchema.parse(req.body);
    const companyId = req.companyId!;
    await assertVendor(app.db, body.vendorId, companyId);
    const submissionId = await resolveSubmissionBinding(
      companyId,
      body.vendorId,
      body.submissionId,
    );
    const year = new Date().getUTCFullYear();
    if (body.year > year) {
      throw badRequest(
        `${body.year} has not happened yet. A safety record describes a year that finished; a ` +
          "forward-dated one is a projection wearing a statistic's clothes.",
      );
    }
    const existing = await app.db
      .select({ id: prequalificationSafetyRecords.id })
      .from(prequalificationSafetyRecords)
      .where(
        and(
          eq(prequalificationSafetyRecords.companyId, companyId),
          eq(prequalificationSafetyRecords.vendorId, body.vendorId),
          eq(prequalificationSafetyRecords.year, body.year),
          eq(prequalificationSafetyRecords.source, body.source),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw conflict(
        `A ${body.source} safety record for ${body.year} already exists for this vendor. Correct ` +
          "it rather than filing a second one: two figures for one year with one provenance is " +
          "an argument, not a record.",
      );
    }
    const id = newId("psr");
    await app.db.insert(prequalificationSafetyRecords).values({
      id,
      companyId,
      vendorId: body.vendorId,
      submissionId,
      year: body.year,
      emr: body.emr ?? null,
      trir: body.trir ?? null,
      dart: body.dart ?? null,
      fatalities: body.fatalities ?? null,
      lostTimeInjuries: body.lostTimeInjuries ?? null,
      recordableIncidents: body.recordableIncidents ?? null,
      hoursWorked: body.hoursWorked ?? null,
      citations: body.citations ?? [],
      source: body.source,
      fileIds: body.fileIds ?? [],
      note: body.note ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "prequalification_safety_record", id, {
      vendorId: body.vendorId,
      year: body.year,
      source: body.source,
      emr: body.emr ?? null,
      trir: body.trir ?? null,
      fatalities: body.fatalities ?? null,
    }, null, true);
    const [row] = await app.db
      .select()
      .from(prequalificationSafetyRecords)
      .where(eq(prequalificationSafetyRecords.id, id))
      .limit(1);
    return reply.status(201).send(row);
  });

  app.post(
    `${BASE}/safety-records/:recordId/verify`,
    { preHandler: adminGate },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const { source, note } = z
        .object({
          source: z.enum(PREQUAL_SAFETY_SOURCES),
          note: reasonSchema.optional(),
        })
        .parse(req.body);
      const rows = await app.db
        .select()
        .from(prequalificationSafetyRecords)
        .where(
          and(
            eq(prequalificationSafetyRecords.id, recordId),
            eq(prequalificationSafetyRecords.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("Safety record not found");
      if (source === "self_declared") {
        throw badRequest(
          "Verification cannot conclude that a figure is self-declared — that is where it " +
            "started. Verify it against an audit or a regulator's return, or leave it as it is.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(prequalificationSafetyRecords)
        .set({
          source,
          verifiedBy: req.user!.id,
          verifiedAt: now,
          note: note ?? row.note,
          updatedAt: now,
        })
        .where(eq(prequalificationSafetyRecords.id, recordId));
      await ledger(app.db, req, "update", "prequalification_safety_record", recordId, {
        event: "verified",
        vendorId: row.vendorId,
        year: row.year,
        from: row.source,
        to: source,
      }, null, true);
      const [fresh] = await app.db
        .select()
        .from(prequalificationSafetyRecords)
        .where(eq(prequalificationSafetyRecords.id, recordId))
        .limit(1);
      return fresh;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Licences                                                          */
  /* ---------------------------------------------------------------- */

  app.post(`${BASE}/licences`, { preHandler: adminGate }, async (req, reply) => {
    const body = licenceSchema.parse(req.body);
    const companyId = req.companyId!;
    await assertVendor(app.db, body.vendorId, companyId);
    const submissionId = await resolveSubmissionBinding(
      companyId,
      body.vendorId,
      body.submissionId,
    );
    const id = newId("plc");
    const today = todayIso();
    /*
     * A licence whose stated expiry is already in the past is filed EXPIRED
     * on the way in. Recording it as `claimed` would put a lapsed licence in
     * front of a buyer wearing the same badge as a live one until the next
     * sweep happened to run.
     */
    const status =
      body.expiresAt !== null && body.expiresAt !== undefined && body.expiresAt <= today
        ? "expired"
        : "claimed";
    await app.db.insert(prequalificationLicences).values({
      id,
      companyId,
      vendorId: body.vendorId,
      submissionId,
      kind: body.kind,
      jurisdiction: body.jurisdiction ?? null,
      number: body.number ?? null,
      issuedBy: body.issuedBy ?? null,
      issuedAt: body.issuedAt ?? null,
      expiresAt: body.expiresAt ?? null,
      status,
      fileIds: body.fileIds ?? [],
      note: body.note ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "prequalification_licence", id, {
      vendorId: body.vendorId,
      kind: body.kind,
      number: body.number ?? null,
      expiresAt: body.expiresAt ?? null,
      status,
    }, null, true);
    const [row] = await app.db
      .select()
      .from(prequalificationLicences)
      .where(eq(prequalificationLicences.id, id))
      .limit(1);
    return reply.status(201).send({
      ...row,
      note:
        status === "expired"
          ? "Filed as expired: the stated expiry date has already passed."
          : "Filed as CLAIMED. A licence number a vendor typed is a claim until a named person " +
            "checks it against the issuing body.",
    });
  });

  app.post(`${BASE}/licences/:licenceId/status`, { preHandler: adminGate }, async (req) => {
    const { licenceId } = req.params as { licenceId: string };
    const body = z
      .object({
        status: z.enum(PREQUAL_LICENCE_STATUSES),
        note: reasonSchema.optional(),
        expiresAt: isoDateSchema.nullable().optional(),
      })
      .parse(req.body);
    const rows = await app.db
      .select()
      .from(prequalificationLicences)
      .where(
        and(
          eq(prequalificationLicences.id, licenceId),
          eq(prequalificationLicences.companyId, req.companyId!),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Licence not found");
    const expiresAt = body.expiresAt !== undefined ? body.expiresAt : row.expiresAt;
    if (body.status === "verified") {
      if (!expiresAt) {
        throw badRequest(
          "A verified licence needs an expiry date. Verifying a licence with no end date " +
            "records a check that can never lapse, which is the one thing a licence always does.",
        );
      }
      if (expiresAt <= todayIso()) {
        throw badRequest(
          `That licence expired on ${expiresAt} and cannot be marked verified. Record the ` +
            "renewal, or mark it expired.",
        );
      }
    }
    const now = new Date().toISOString();
    await app.db
      .update(prequalificationLicences)
      .set({
        status: body.status,
        expiresAt,
        note: body.note ?? row.note,
        verifiedBy: body.status === "verified" ? req.user!.id : row.verifiedBy,
        verifiedAt: body.status === "verified" ? now : row.verifiedAt,
        updatedAt: now,
      })
      .where(eq(prequalificationLicences.id, licenceId));
    await ledger(app.db, req, "state_change", "prequalification_licence", licenceId, {
      vendorId: row.vendorId,
      kind: row.kind,
      from: row.status,
      to: body.status,
      expiresAt,
      note: body.note ?? null,
    }, null, true);
    const [fresh] = await app.db
      .select()
      .from(prequalificationLicences)
      .where(eq(prequalificationLicences.id, licenceId))
      .limit(1);
    return fresh;
  });

  /* ---------------------------------------------------------------- */
  /* References                                                        */
  /* ---------------------------------------------------------------- */

  app.post(`${BASE}/references`, { preHandler: adminGate }, async (req, reply) => {
    const body = referenceSchema.parse(req.body);
    const companyId = req.companyId!;
    await assertVendor(app.db, body.vendorId, companyId);
    const submissionId = await resolveSubmissionBinding(
      companyId,
      body.vendorId,
      body.submissionId,
    );
    const id = newId("prf");
    await app.db.insert(prequalificationReferences).values({
      id,
      companyId,
      vendorId: body.vendorId,
      submissionId,
      clientName: body.clientName,
      projectName: body.projectName ?? null,
      contractValue: body.contractValue ?? null,
      currency: body.currency ?? "USD",
      completedAt: body.completedAt ?? null,
      contactName: body.contactName ?? null,
      contactEmail: body.contactEmail ?? null,
      contactPhone: body.contactPhone ?? null,
      /*
       * OUTCOME AND RATING ARE NOT SUPPLIED HERE. They are what the reference
       * SAYS, and nobody has asked yet. A vendor-supplied outcome of
       * "delivered" on a vendor-supplied reference is the vendor marking
       * their own homework.
       */
      outcome: "unknown",
      rating: null,
      wouldUseAgain: null,
      checkedBy: null,
      checkedAt: null,
      checkNote: null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "prequalification_reference", id, {
      vendorId: body.vendorId,
      clientName: body.clientName,
      projectName: body.projectName ?? null,
      contractValue: body.contractValue ?? null,
      currency: body.currency ?? "USD",
    }, null, true);
    const [row] = await app.db
      .select()
      .from(prequalificationReferences)
      .where(eq(prequalificationReferences.id, id))
      .limit(1);
    return reply.status(201).send({
      ...row,
      note:
        "Recorded as an UNCHECKED reference. Until somebody takes it up through " +
        "/references/:id/check it is a name the vendor supplied, and the tiering rule treats it " +
        "as one.",
    });
  });

  app.post(`${BASE}/references/:referenceId/check`, { preHandler: adminGate }, async (req) => {
    const { referenceId } = req.params as { referenceId: string };
    const body = z
      .object({
        outcome: z.enum(PREQUAL_REFERENCE_OUTCOMES),
        rating: z.number().finite().min(0).max(5).nullable().optional(),
        wouldUseAgain: z.boolean().nullable().optional(),
        checkNote: reasonSchema,
      })
      .parse(req.body);
    const rows = await app.db
      .select()
      .from(prequalificationReferences)
      .where(
        and(
          eq(prequalificationReferences.id, referenceId),
          eq(prequalificationReferences.companyId, req.companyId!),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Reference not found");
    if (body.outcome === "unknown") {
      throw badRequest(
        "A completed reference check has an outcome. If the referee could not be reached, leave " +
          "the reference unchecked — an 'unknown' check records an act that did not happen.",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(prequalificationReferences)
      .set({
        outcome: body.outcome,
        rating: body.rating ?? null,
        wouldUseAgain:
          body.wouldUseAgain === null || body.wouldUseAgain === undefined
            ? null
            : body.wouldUseAgain
              ? 1
              : 0,
        checkedBy: req.user!.id,
        checkedAt: now,
        checkNote: body.checkNote,
        updatedAt: now,
      })
      .where(eq(prequalificationReferences.id, referenceId));
    await ledger(app.db, req, "update", "prequalification_reference", referenceId, {
      event: "reference_checked",
      vendorId: row.vendorId,
      clientName: row.clientName,
      outcome: body.outcome,
      rating: body.rating ?? null,
      checkedBy: req.user!.id,
    }, null, true);
    const [fresh] = await app.db
      .select()
      .from(prequalificationReferences)
      .where(eq(prequalificationReferences.id, referenceId))
      .limit(1);
    return fresh;
  });

  /* ---------------------------------------------------------------- */
  /* The evidence repository for one vendor                            */
  /* ---------------------------------------------------------------- */

  /**
   * EVERYTHING THIS COMPANY HOLDS ON ONE VENDOR, IN ONE READ.
   *
   * Assembling it by hand is how an expired licence sits unnoticed next to a
   * current approval: the two facts live on different pages. The tier the
   * evidence supports is computed here too, so "what would this vendor be
   * admitted at, on today's evidence" is answerable before anybody decides.
   */
  app.get(`${BASE}/vendors/:vendorId/evidence`, { preHandler: memberGate }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const companyId = req.companyId!;
    const vendor = await assertVendor(app.db, vendorId, companyId);
    const evidence = await loadVendorEvidence(app.db, companyId, vendorId);
    const submissions = await app.db
      .select()
      .from(prequalificationSubmissions)
      .where(
        and(
          eq(prequalificationSubmissions.companyId, companyId),
          eq(prequalificationSubmissions.vendorId, vendorId),
        ),
      )
      .orderBy(desc(prequalificationSubmissions.createdAt));
    const responses =
      submissions.length > 0
        ? await app.db
            .select({
              id: prequalificationResponses.id,
              submissionId: prequalificationResponses.submissionId,
              questionId: prequalificationResponses.questionId,
              fileIds: prequalificationResponses.fileIds,
            })
            .from(prequalificationResponses)
            .where(
              inArray(
                prequalificationResponses.submissionId,
                submissions.map((s) => s.id),
              ),
            )
        : [];
    const financials = await app.db
      .select()
      .from(prequalificationFinancials)
      .where(
        and(
          eq(prequalificationFinancials.companyId, companyId),
          eq(prequalificationFinancials.vendorId, vendorId),
        ),
      )
      .orderBy(desc(prequalificationFinancials.financialYearEnd));

    const files: Array<{ fileId: string; source: string; sourceId: string; label: string }> = [];
    for (const r of responses) {
      for (const fileId of (r.fileIds as string[]) ?? []) {
        files.push({
          fileId,
          source: "questionnaire_response",
          sourceId: r.id,
          label: `Answer to ${r.questionId}`,
        });
      }
    }
    for (const f of financials) {
      for (const fileId of (f.fileIds as string[]) ?? []) {
        files.push({
          fileId,
          source: "financial",
          sourceId: f.id,
          label: `Accounts to ${f.financialYearEnd} (${f.source})`,
        });
      }
    }
    for (const s of evidence.safety) {
      for (const fileId of (s.fileIds as string[]) ?? []) {
        files.push({
          fileId,
          source: "safety_record",
          sourceId: s.id,
          label: `Safety record ${s.year} (${s.source})`,
        });
      }
    }
    for (const l of evidence.licences) {
      for (const fileId of (l.fileIds as string[]) ?? []) {
        files.push({
          fileId,
          source: "licence",
          sourceId: l.id,
          label: `${l.kind}${l.number ? ` ${l.number}` : ""}`,
        });
      }
    }

    const latest = submissions[0] ?? null;
    const tier = latest ? await tierForSubmission(app.db, latest) : null;
    const today = todayIso();
    return {
      vendor,
      safety: evidence.safety,
      licences: evidence.licences.map((l) => ({
        ...l,
        expired: l.expiresAt !== null && l.expiresAt <= today,
      })),
      references: evidence.references.map((r) => ({
        ...r,
        wouldUseAgain: r.wouldUseAgain === null ? null : r.wouldUseAgain === 1,
        checked: r.checkedBy !== null,
      })),
      financials,
      files,
      fileCount: files.length,
      tier,
      tierNote:
        tier === null
          ? "No prequalification submission exists for this vendor, so there is nothing to tier."
          : `On today's evidence this vendor would be admitted at tier ${tier.tier.toUpperCase()}.`,
      counts: {
        safety: evidence.safety.length,
        licences: evidence.licences.length,
        licencesExpired: evidence.licences.filter(
          (l) => l.status === "expired" || (l.expiresAt !== null && l.expiresAt <= today),
        ).length,
        references: evidence.references.length,
        referencesChecked: evidence.references.filter((r) => r.checkedBy !== null).length,
        financials: financials.length,
      },
    };
  });

  /** The three registers, company-wide, for the register view. */
  app.get(`${BASE}/licences`, { preHandler: memberGate }, async (req) => {
    const query = pageQuerySchema
      .extend({
        vendorId: z.string().max(64).optional(),
        status: z.enum(PREQUAL_LICENCE_STATUSES).optional(),
        expiringWithinDays: z.coerce.number().int().min(0).max(1000).optional(),
      })
      .parse(req.query);
    const filters = [eq(prequalificationLicences.companyId, req.companyId!)];
    if (query.vendorId) filters.push(eq(prequalificationLicences.vendorId, query.vendorId));
    if (query.status) filters.push(eq(prequalificationLicences.status, query.status));
    if (query.expiringWithinDays !== undefined) {
      const horizon = new Date(Date.now() + query.expiringWithinDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      filters.push(isNotNull(prequalificationLicences.expiresAt));
      filters.push(lte(prequalificationLicences.expiresAt, horizon));
    }
    const where = and(...filters);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(prequalificationLicences)
      .where(where);
    const rows = await app.db
      .select()
      .from(prequalificationLicences)
      .where(where)
      .orderBy(asc(prequalificationLicences.expiresAt))
      .limit(query.pageSize)
      .offset(pageOffset(query));
    const today = todayIso();
    return paginate(
      rows.map((r) => ({ ...r, expired: r.expiresAt !== null && r.expiresAt <= today })),
      Number(totalRow?.n ?? 0),
      query,
    );
  });

  /* ---------------------------------------------------------------- */
  /* Vendor self-service: minting and revoking the pq_ token           */
  /* ---------------------------------------------------------------- */

  app.post(
    `${BASE}/submissions/:submissionId/portal-token`,
    { preHandler: adminGate },
    async (req, reply) => {
      const { submissionId } = req.params as { submissionId: string };
      const body = z
        .object({ validityDays: z.number().int().min(1).max(365).optional() })
        .parse(req.body ?? {});
      const submission = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
      if (!["invited", "in_progress", "submitted"].includes(submission.status)) {
        throw conflict(
          `${submission.reference} is ${submission.status}; a vendor link issued now would open ` +
            "an assessment that is over.",
        );
      }
      const token = mintPrequalToken();
      const expiresAt = prequalTokenExpiry(body.validityDays ?? PREQUAL_TOKEN_DAYS);
      const now = new Date().toISOString();
      await app.db
        .update(prequalificationSubmissions)
        .set({ portalTokenHash: token.hash, portalTokenExpiresAt: expiresAt, updatedAt: now })
        .where(eq(prequalificationSubmissions.id, submissionId));
      await ledger(app.db, req, "create", "prequalification_submission", submissionId, {
        event: "vendor_portal_token_issued",
        vendorId: submission.vendorId,
        tokenPrefix: token.display,
        expiresAt,
        replacedPrevious: Boolean(submission.portalTokenHash),
      }, submission.projectId, true);
      return reply.status(201).send({
        token: token.raw,
        tokenPrefix: token.display,
        submissionId,
        reference: submission.reference,
        expiresAt,
        note:
          "Shown once and never again — only its sha256 is stored. Send it to the vendor so " +
          "they answer for themselves: a declaration typed in by the buyer's own staff is not " +
          "the vendor's declaration, whatever the form says at the bottom.",
      });
    },
  );

  app.delete(
    `${BASE}/submissions/:submissionId/portal-token`,
    { preHandler: adminGate },
    async (req, reply) => {
      const { submissionId } = req.params as { submissionId: string };
      const submission = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
      if (!submission.portalTokenHash) throw notFound("No vendor link has been issued.");
      await app.db
        .update(prequalificationSubmissions)
        .set({ portalTokenHash: null, updatedAt: new Date().toISOString() })
        .where(eq(prequalificationSubmissions.id, submissionId));
      await ledger(app.db, req, "delete", "prequalification_submission", submissionId, {
        event: "vendor_portal_token_revoked",
        vendorId: submission.vendorId,
      }, submission.projectId);
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Vendor self-service: the vendor's own view and answers            */
  /* ---------------------------------------------------------------- */

  /**
   * WHAT THE VENDOR SEES. The questionnaire, their own answers and what is
   * still outstanding — never another vendor, never a score, never the
   * buyer's threshold, and never the assessment. A vendor who can read the
   * pass mark answers the pass mark.
   */
  app.post("/prequal-portal/session", async (req) => {
    const submission = await resolvePrequalSession(app.db, req.headers.authorization);
    const questionnaire = await fetchQuestionnaire(
      app.db,
      submission.questionnaireId,
      submission.companyId,
    );
    const questions = await app.db
      .select()
      .from(prequalificationQuestions)
      .where(eq(prequalificationQuestions.questionnaireId, submission.questionnaireId))
      .orderBy(asc(prequalificationQuestions.position));
    const responses = await app.db
      .select()
      .from(prequalificationResponses)
      .where(eq(prequalificationResponses.submissionId, submission.id));
    const answered = new Map(responses.map((r) => [r.questionId, r] as const));
    const now = new Date().toISOString();
    await app.db
      .update(prequalificationSubmissions)
      .set({ portalLastAccessAt: now, updatedAt: now })
      .where(eq(prequalificationSubmissions.id, submission.id));
    await ledgerVendorAction(app.db, submission, "access", { event: "vendor_portal_viewed" });
    const evidence = await loadVendorEvidence(
      app.db,
      submission.companyId,
      submission.vendorId,
    );
    return {
      reference: submission.reference,
      status: submission.status,
      dueAt: submission.dueAt,
      questionnaire: {
        reference: questionnaire.reference,
        name: questionnaire.name,
        description: questionnaire.description,
        /* NOT the pass threshold, and NOT the weights. */
      },
      questions: questions.map((q) => ({
        id: q.id,
        questionCode: q.questionCode,
        category: q.category,
        text: q.text,
        guidance: q.guidance,
        itemType: q.itemType,
        options: q.options,
        unit: q.unit,
        required: q.required === 1,
        evidenceRequired: q.evidenceRequired === 1,
        response: answered.get(q.id)?.response ?? null,
        numericValue: answered.get(q.id)?.numericValue ?? null,
        selectedOptions: answered.get(q.id)?.selectedOptions ?? [],
        fileIds: answered.get(q.id)?.fileIds ?? [],
      })),
      outstanding: questions
        .filter((q) => q.required === 1 && !answered.has(q.id))
        .map((q) => `${q.questionCode} — ${q.text}`),
      declared: {
        safetyYears: evidence.safety.map((s) => s.year).sort((a, b) => b - a),
        licences: evidence.licences.map((l) => ({
          id: l.id,
          kind: l.kind,
          number: l.number,
          expiresAt: l.expiresAt,
          status: l.status,
        })),
        references: evidence.references.map((r) => ({
          id: r.id,
          clientName: r.clientName,
          projectName: r.projectName,
        })),
      },
      note:
        "Answers are saved as you go. Submitting is a separate, recorded step, and after it the " +
        "form is read-only until the buyer asks for more.",
    };
  });

  /* The SAME answer shape the staff route takes — one vocabulary, so an
   * answer means the same thing whichever door it came through. */
  const vendorAnswerSchema = z.object({
    responses: z
      .array(
        z.object({
          questionId: z.string().min(1).max(64),
          response: z.string().max(20000).nullable().optional(),
          numericValue: z.number().finite().nullable().optional(),
          selectedOptions: z.array(z.string().min(1).max(200)).max(100).optional(),
          fileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
        }),
      )
      .min(1)
      .max(500),
  });

  app.post("/prequal-portal/responses", async (req) => {
    const body = vendorAnswerSchema.parse(req.body);
    const submission = await resolvePrequalSession(app.db, req.headers.authorization);
    if (submission.status === "submitted") {
      throw conflict(
        `${submission.reference} has been submitted. Ask the buyer to reopen it if something ` +
          "needs correcting — a declaration that can be edited after submission is not a " +
          "declaration.",
      );
    }
    const questions = await app.db
      .select()
      .from(prequalificationQuestions)
      .where(eq(prequalificationQuestions.questionnaireId, submission.questionnaireId));
    const byId = new Map(questions.map((q) => [q.id, q] as const));
    const strays = body.responses.filter((r) => !byId.has(r.questionId));
    if (strays.length > 0) {
      throw badRequest(
        `${strays.length} answer(s) reference a question that is not on this questionnaire.`,
        { questionIds: strays.map((x) => x.questionId) },
      );
    }
    /*
     * THE VENDOR'S ANSWERS GO THROUGH THE SAME VALIDATOR AS THE BUYER'S.
     * A portal that accepts "maybe" to a yes/no knockout question has moved
     * the assessment's hardest moment into an assessor's inbox.
     */
    const errors: string[] = [];
    for (const r of body.responses) {
      const question = byId.get(r.questionId)!;
      const validation = validateAnswer(prequalQuestionSpec(question), {
        response: r.response ?? null,
        numericValue: r.numericValue ?? null,
        selectedOptions: r.selectedOptions ?? [],
        fileIds: r.fileIds ?? [],
      });
      if (!validation.ok) errors.push(...validation.errors);
    }
    if (errors.length > 0) {
      throw badRequest(
        `${errors.length} answer(s) do not match the question they answer.`,
        { errors },
      );
    }
    const existing = await app.db
      .select()
      .from(prequalificationResponses)
      .where(eq(prequalificationResponses.submissionId, submission.id));
    const byQuestion = new Map(existing.map((r) => [r.questionId, r] as const));
    const now = new Date().toISOString();
    for (const answer of body.responses) {
      const question = byId.get(answer.questionId)!;
      const prior = byQuestion.get(answer.questionId);
      const values = {
        companyId: submission.companyId,
        projectId: submission.projectId,
        submissionId: submission.id,
        questionnaireId: submission.questionnaireId,
        questionId: answer.questionId,
        questionCode: question.questionCode,
        /* snapshot: the assessment must stay readable after a revision */
        questionText: question.text,
        category: question.category,
        itemType: question.itemType,
        response: answer.response ?? null,
        numericValue: answer.numericValue ?? null,
        selectedOptions: answer.selectedOptions ?? [],
        fileIds: answer.fileIds ?? prior?.fileIds ?? [],
        maxScore: question.maxScore,
        updatedAt: now,
      };
      if (prior) {
        await app.db
          .update(prequalificationResponses)
          .set(values)
          .where(eq(prequalificationResponses.id, prior.id));
      } else {
        await app.db.insert(prequalificationResponses).values({
          id: newId("pqr"),
          ...values,
          /* The VENDOR answered. No platform user did, and none is invented. */
          detail: { via: "prequal_token" },
        });
      }
    }
    if (submission.status === "invited") {
      await app.db
        .update(prequalificationSubmissions)
        .set({ status: "in_progress", portalLastAccessAt: now, updatedAt: now })
        .where(eq(prequalificationSubmissions.id, submission.id));
    } else {
      await app.db
        .update(prequalificationSubmissions)
        .set({ portalLastAccessAt: now, updatedAt: now })
        .where(eq(prequalificationSubmissions.id, submission.id));
    }
    await ledgerVendorAction(app.db, submission, "update", {
      event: "vendor_answers_saved",
      answered: body.responses.length,
    });
    return {
      saved: body.responses.length,
      status: submission.status === "invited" ? "in_progress" : submission.status,
      note: "Saved. Nothing has been submitted yet.",
    };
  });

  app.post("/prequal-portal/submit", async (req) => {
    const { declaration } = z
      .object({ declaration: z.string().trim().min(20).max(4000) })
      .parse(req.body);
    const submission = await resolvePrequalSession(app.db, req.headers.authorization);
    if (submission.status === "submitted") {
      throw conflict(`${submission.reference} has already been submitted.`);
    }
    const questions = await app.db
      .select()
      .from(prequalificationQuestions)
      .where(eq(prequalificationQuestions.questionnaireId, submission.questionnaireId))
      .orderBy(asc(prequalificationQuestions.position));
    const responses = await app.db
      .select()
      .from(prequalificationResponses)
      .where(eq(prequalificationResponses.submissionId, submission.id));
    const answered = new Map(responses.map((r) => [r.questionId, r] as const));
    const missing = questions.filter((q) => {
      if (q.required !== 1 || isStructuralItemType(q.itemType)) return false;
      const r = answered.get(q.id);
      if (!r) return true;
      return (
        r.response === null &&
        r.numericValue === null &&
        ((r.selectedOptions as string[] | null) ?? []).length === 0
      );
    });
    if (missing.length > 0) {
      throw conflict(
        `${missing.length} required question(s) are unanswered: ` +
          missing.map((q) => q.questionCode ?? q.text).join(", ") +
          ". A submission with gaps forces the assessor to score an absence, and an unscored " +
          "required question leaves the overall score null rather than low.",
      );
    }
    const missingEvidence = questions.filter(
      (q) =>
        q.evidenceRequired === 1 && ((answered.get(q.id)?.fileIds as string[] | undefined) ?? []).length === 0,
    );
    if (missingEvidence.length > 0) {
      throw conflict(
        `${missingEvidence.length} question(s) require supporting evidence and none is attached: ` +
          missingEvidence.map((q) => q.questionCode ?? q.text).join(", ") +
          ". Evidence required means evidence supplied — a declaration with no document behind " +
          "it is the claim the document was supposed to test.",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(prequalificationSubmissions)
      .set({
        status: "submitted",
        submittedAt: now,
        portalLastAccessAt: now,
        detail: {
          ...(submission.detail as Record<string, unknown>),
          vendorDeclaration: declaration,
          vendorDeclaredAt: now,
          via: "prequal_token",
        },
        updatedAt: now,
      })
      .where(eq(prequalificationSubmissions.id, submission.id));
    await ledgerVendorAction(app.db, submission, "state_change", {
      event: "vendor_submitted",
      from: submission.status,
      to: "submitted",
      questionCount: questions.length,
      answered: responses.length,
      declaration,
    });
    return {
      reference: submission.reference,
      status: "submitted",
      submittedAt: now,
      note:
        "Submitted. The assessment that follows is the buyer's, and its outcome will reach you " +
        "from them rather than from this form.",
    };
  });

  /** The vendor declaring their own safety figures, licences and references. */
  app.post("/prequal-portal/declarations", async (req) => {
    const body = z
      .object({
        safety: z
          .array(safetySchema.omit({ vendorId: true, submissionId: true, source: true }))
          .max(10)
          .optional(),
        licences: z
          .array(licenceSchema.omit({ vendorId: true, submissionId: true }))
          .max(50)
          .optional(),
        references: z
          .array(referenceSchema.omit({ vendorId: true, submissionId: true }))
          .max(50)
          .optional(),
      })
      .parse(req.body);
    const submission = await resolvePrequalSession(app.db, req.headers.authorization);
    if (submission.status === "submitted") {
      throw conflict(`${submission.reference} has been submitted and takes no further entries.`);
    }
    const companyId = submission.companyId;
    const today = todayIso();
    const thisYear = new Date().getUTCFullYear();
    const created = { safety: 0, licences: 0, references: 0 };

    for (const s of body.safety ?? []) {
      if (s.year > thisYear) {
        throw badRequest(`${s.year} has not happened yet; a safety record describes a year that finished.`);
      }
      const clash = await app.db
        .select({ id: prequalificationSafetyRecords.id })
        .from(prequalificationSafetyRecords)
        .where(
          and(
            eq(prequalificationSafetyRecords.companyId, companyId),
            eq(prequalificationSafetyRecords.vendorId, submission.vendorId),
            eq(prequalificationSafetyRecords.year, s.year),
            eq(prequalificationSafetyRecords.source, "self_declared"),
          ),
        )
        .limit(1);
      if (clash[0]) {
        await app.db
          .update(prequalificationSafetyRecords)
          .set({
            emr: s.emr ?? null,
            trir: s.trir ?? null,
            dart: s.dart ?? null,
            fatalities: s.fatalities ?? null,
            lostTimeInjuries: s.lostTimeInjuries ?? null,
            recordableIncidents: s.recordableIncidents ?? null,
            hoursWorked: s.hoursWorked ?? null,
            citations: s.citations ?? [],
            fileIds: s.fileIds ?? [],
            note: s.note ?? null,
            submissionId: submission.id,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(prequalificationSafetyRecords.id, clash[0].id));
        continue;
      }
      await app.db.insert(prequalificationSafetyRecords).values({
        id: newId("psr"),
        companyId,
        vendorId: submission.vendorId,
        submissionId: submission.id,
        year: s.year,
        emr: s.emr ?? null,
        trir: s.trir ?? null,
        dart: s.dart ?? null,
        fatalities: s.fatalities ?? null,
        lostTimeInjuries: s.lostTimeInjuries ?? null,
        recordableIncidents: s.recordableIncidents ?? null,
        hoursWorked: s.hoursWorked ?? null,
        citations: s.citations ?? [],
        /* A vendor's own figure is SELF-DECLARED. It cannot arrive audited. */
        source: "self_declared",
        fileIds: s.fileIds ?? [],
        note: s.note ?? null,
        detail: { via: "prequal_token" },
        createdBy: null,
      });
      created.safety += 1;
    }

    for (const l of body.licences ?? []) {
      await app.db.insert(prequalificationLicences).values({
        id: newId("plc"),
        companyId,
        vendorId: submission.vendorId,
        submissionId: submission.id,
        kind: l.kind,
        jurisdiction: l.jurisdiction ?? null,
        number: l.number ?? null,
        issuedBy: l.issuedBy ?? null,
        issuedAt: l.issuedAt ?? null,
        expiresAt: l.expiresAt ?? null,
        status: l.expiresAt && l.expiresAt <= today ? "expired" : "claimed",
        fileIds: l.fileIds ?? [],
        note: l.note ?? null,
        detail: { via: "prequal_token" },
        createdBy: null,
      });
      created.licences += 1;
    }

    for (const r of body.references ?? []) {
      await app.db.insert(prequalificationReferences).values({
        id: newId("prf"),
        companyId,
        vendorId: submission.vendorId,
        submissionId: submission.id,
        clientName: r.clientName,
        projectName: r.projectName ?? null,
        contractValue: r.contractValue ?? null,
        currency: r.currency ?? "USD",
        completedAt: r.completedAt ?? null,
        contactName: r.contactName ?? null,
        contactEmail: r.contactEmail ?? null,
        contactPhone: r.contactPhone ?? null,
        outcome: "unknown",
        rating: null,
        wouldUseAgain: null,
        checkedBy: null,
        detail: { via: "prequal_token" },
        createdBy: null,
      });
      created.references += 1;
    }

    await ledgerVendorAction(app.db, submission, "create", {
      event: "vendor_declarations_filed",
      ...created,
    });
    return {
      ...created,
      note:
        "Filed as the vendor's own declaration: safety figures are recorded as self-declared, " +
        "licences as claimed and references as unchecked. Each becomes evidence only when " +
        "somebody on the buyer's side verifies it.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Manual sweep trigger (operators and tests)                        */
  /* ---------------------------------------------------------------- */

  app.post(`${BASE}/licences/sweep`, { preHandler: adminGate }, async (req) => {
    const result = await sweepPrequalLicences(app.db, req.companyId!);
    return {
      ...result,
      note:
        result.expired.length === 0
          ? "No licence had reached its expiry date."
          : `${result.expired.length} licence(s) expired; ${result.signalled} signal(s) raised.`,
    };
  });
};
