import type { FastifyPluginAsync } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  crewMembers,
  crews,
  signals,
  siteAccessRecords,
  timecardAllocations,
  timecardApprovals,
  timecardBatches,
  timecards,
  workers,
} from "@constructos/db";
import {
  COST_TYPES,
  IDLE_REASONS,
  PREMIUM_KINDS,
  SHIFTS,
  TIMECARD_SOURCES,
  TIMECARD_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  VARIANCE_TOLERANCE_HOURS,
  accessVariance,
  classifyHours,
  costHours,
  elapsedHours,
  nearlyEqual,
  reconcileAllocations,
  round2,
  type AccessVarianceResult,
  type AppliedOvertimeRule,
  type HourSplit,
} from "./hours.js";
// `batches.ts` imports `splitOf` from this file; both references are inside
// route handlers, so the ESM cycle resolves before either is called.
import { recomputeBatch } from "./batches.js";
import {
  actorOf,
  addDays,
  assertSameCurrency,
  assertTimecardEditable,
  assertTransition,
  checkSelfApproval,
  companyOf,
  crewConfig,
  detailSchema,
  fetchCrew,
  fetchTimecard,
  hoursSchema,
  idSchema,
  isoDateSchema,
  ledgerTimecards,
  nowIso,
  overtimeRuleOf,
  pad3,
  projectOf,
  requireBudgetLine,
  requireCostCode,
  requireWorker,
  selfApprovalRefusal,
  timeOfDaySchema,
  timecardGates,
  todayIso,
  weekStart,
  type CrewRow,
  type TimecardRow,
  type WorkerRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const allocationSchema = z.object({
  costCodeId: idSchema.nullable().optional(),
  costCode: z.string().max(60).nullable().optional(),
  costType: z.enum(COST_TYPES).optional(),
  budgetLineItemId: idSchema.nullable().optional(),
  wbsPath: z.string().max(200).nullable().optional(),
  subJob: z.string().max(100).nullable().optional(),
  locationId: idSchema.nullable().optional(),
  scheduleActivityId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  changeEventId: idSchema.nullable().optional(),
  tmTicketId: idSchema.nullable().optional(),
  equipmentId: idSchema.nullable().optional(),
  regularHours: hoursSchema.optional(),
  overtimeHours: hoursSchema.optional(),
  doubleTimeHours: hoursSchema.optional(),
  premiumHours: hoursSchema.optional(),
  hourlyRate: z.number().min(0).nullable().optional(),
  quantity: z.number().nullable().optional(),
  unit: z.string().max(30).nullable().optional(),
  isBillable: z.boolean().optional(),
  notes: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});
export type AllocationInput = z.infer<typeof allocationSchema>;

const hoursBlock = {
  /** hours worked on the day, net of breaks — classified under the crew rule */
  workedHours: hoursSchema.optional(),
  startTime: timeOfDaySchema.nullable().optional(),
  endTime: timeOfDaySchema.nullable().optional(),
  breakMinutes: z.number().int().min(0).max(720).optional(),
  /** an explicit split, which BYPASSES the crew rule and is recorded as such */
  regularHours: hoursSchema.optional(),
  overtimeHours: hoursSchema.optional(),
  doubleTimeHours: hoursSchema.optional(),
  premiumHours: hoursSchema.optional(),
  premiumKind: z.enum(PREMIUM_KINDS).optional(),
  idleHours: hoursSchema.optional(),
  idleReason: z.enum(IDLE_REASONS).nullable().optional(),
  weatherDelayHours: hoursSchema.nullable().optional(),
};

const ratesBlock = {
  hourlyRate: z.number().min(0).nullable().optional(),
  overtimeRate: z.number().min(0).nullable().optional(),
  doubleTimeRate: z.number().min(0).nullable().optional(),
  premiumRate: z.number().min(0).nullable().optional(),
  burdenRate: z.number().min(0).max(10).nullable().optional(),
  currency: z.string().length(3).optional(),
};

const timecardCreateSchema = z.object({
  workerId: idSchema,
  workDate: isoDateSchema,
  shift: z.enum(SHIFTS).optional(),
  crewId: idSchema.nullable().optional(),
  batchId: idSchema.nullable().optional(),
  trade: z.string().max(200).nullable().optional(),
  classification: z.string().max(200).nullable().optional(),
  source: z.enum(TIMECARD_SOURCES).optional(),
  isBillable: z.boolean().optional(),
  locationId: idSchema.nullable().optional(),
  dailyLogId: idSchema.nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  varianceExplanation: z.string().max(4000).nullable().optional(),
  allocations: z.array(allocationSchema).max(50).optional(),
  detail: detailSchema.optional(),
  ...hoursBlock,
  ...ratesBlock,
});

const timecardPatchSchema = timecardCreateSchema
  .omit({ workerId: true, workDate: true, shift: true, allocations: true })
  .partial();

const timecardListQuery = pageQuerySchema.extend({
  workerId: idSchema.optional(),
  crewId: idSchema.optional(),
  batchId: idSchema.optional(),
  vendorId: idSchema.optional(),
  status: z.enum(TIMECARD_STATUSES).optional(),
  shift: z.enum(SHIFTS).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** only cards whose claim exceeds recorded presence beyond tolerance */
  exceptions: z.enum(["true", "false"]).optional(),
  /** only cards with no cost coding at all */
  unallocated: z.enum(["true", "false"]).optional(),
});

const allocationsPutSchema = z.object({
  allocations: z.array(allocationSchema).min(1).max(50),
});

const submitSchema = z.object({ comment: z.string().max(4000).nullable().optional() });

const approveSchema = z.object({
  decision: z.enum(["approved", "rejected", "returned_for_revision"]).default("approved"),
  level: z.number().int().min(1).max(3).optional(),
  approverRole: z.string().max(120).nullable().optional(),
  comment: z.string().max(4000).nullable().optional(),
  signatureFileId: idSchema.nullable().optional(),
  delegatedFromId: idSchema.nullable().optional(),
});

const explainSchema = z.object({ varianceExplanation: z.string().min(1).max(4000) });

const lockSchema = z.object({ note: z.string().max(2000).nullable().optional() });

const reviseSchema = z.object({
  /** the date the correction is BOOKED on — never the original work date */
  adjustmentDate: isoDateSchema.optional(),
  reason: z.string().min(1).max(4000),
  shift: z.enum(SHIFTS).optional(),
  ...hoursBlock,
  ...ratesBlock,
  allocations: z.array(allocationSchema).max(50).optional(),
});

/* ------------------------------------------------------------------ */
/* Hour resolution                                                     */
/* ------------------------------------------------------------------ */

export interface ResolvedHours {
  split: HourSplit;
  workedHours: number;
  method: "explicit_split" | "classified_from_worked_hours" | "classified_from_clock_times";
  rule: AppliedOvertimeRule | null;
  /** carried into detail.hourClassification so the rule travels with the card */
  note: string;
}

type HoursBody = {
  workedHours?: number | undefined;
  startTime?: string | null | undefined;
  endTime?: string | null | undefined;
  breakMinutes?: number | undefined;
  regularHours?: number | undefined;
  overtimeHours?: number | undefined;
  doubleTimeHours?: number | undefined;
  premiumHours?: number | undefined;
  premiumKind?: string | undefined;
};

const hasExplicitSplit = (b: HoursBody): boolean =>
  b.regularHours !== undefined || b.overtimeHours !== undefined || b.doubleTimeHours !== undefined;

/**
 * Turn whatever the caller sent into a split, or refuse.
 *
 * Three ways in, in precedence order, and the one that was used is RECORDED:
 *  1. an explicit split (payroll import, a correction) — bypasses the crew
 *     rule, and says so on the card so nobody later reads it as classified;
 *  2. worked hours — classified under the crew's rule;
 *  3. clock times — elapsed, less breaks, then classified.
 */
export function resolveHours(
  body: HoursBody,
  crew: CrewRow | null,
  priorWeekLadderHours: number,
): ResolvedHours {
  const premium = round2(body.premiumHours ?? 0);
  const premiumKind = (body.premiumKind ?? "none") as never;

  if (hasExplicitSplit(body)) {
    const regular = round2(body.regularHours ?? 0);
    const overtime = round2(body.overtimeHours ?? 0);
    const doubleTime = round2(body.doubleTimeHours ?? 0);
    if (premium > 0 && (body.premiumKind ?? "none") === "none") {
      throw badRequest(
        `${premium} premium hour(s) were supplied with premiumKind "none". The kind is the part a ` +
          "client disputes on a T&M ticket, so an unnamed premium is not recorded.",
      );
    }
    const total = round2(regular + overtime + doubleTime + premium);
    if (total <= 0) {
      throw badRequest("A timecard with no hours on it is not a timecard. Supply hours.");
    }
    // Each bucket is capped at 24 by the schema, and 24+24+24 passed. The
    // classified paths cap the worked day; the explicit path did not, so a
    // 72-hour day could be entered, costed and allocated.
    if (total > 24) {
      throw badRequest(
        `${total} hours were supplied for a single day (${regular} plain + ${overtime} overtime + ` +
          `${doubleTime} double time + ${premium} premium). A day holds 24 hours. If this is a ` +
          "double shift spanning midnight, raise it as two cards on the two dates, which is also " +
          "how the site-access stream will have recorded it.",
      );
    }
    return {
      split: {
        regularHours: regular,
        overtimeHours: overtime,
        doubleTimeHours: doubleTime,
        premiumHours: premium,
        totalHours: total,
      },
      workedHours: total,
      method: "explicit_split",
      rule: null,
      note:
        "The hours on this card were supplied already split and were NOT classified under the " +
        `crew's overtime rule${crew ? ` (${crew.reference})` : ""}. Read them as an assertion by ` +
        "whoever entered them, not as a derivation the platform stands behind.",
    };
  }

  let worked: number | null = null;
  let method: ResolvedHours["method"] = "classified_from_worked_hours";
  if (body.workedHours !== undefined) {
    worked = round2(body.workedHours);
  } else if (body.startTime && body.endTime) {
    const elapsed = elapsedHours(body.startTime, body.endTime, body.breakMinutes ?? 0);
    if (elapsed.value === null) throw badRequest(elapsed.reasons.join(" "));
    worked = elapsed.value;
    method = "classified_from_clock_times";
  }
  if (worked === null) {
    throw badRequest(
      "This card carries no hours. Send workedHours, or startTime + endTime, or an explicit " +
        "regularHours / overtimeHours / doubleTimeHours split.",
    );
  }
  if (worked <= 0) {
    throw badRequest("A timecard with no hours on it is not a timecard. Supply hours.");
  }

  const rule = overtimeRuleOf(crew);
  const classified = classifyHours({
    workedHours: worked,
    premiumHours: premium,
    premiumKind,
    priorWeekLadderHours,
    rule,
  });
  if (classified.value === null || classified.rule === null) {
    throw badRequest(classified.reasons.join(" "), {
      control: "hour_classification",
      reasons: classified.reasons,
      inputs: classified.inputs,
    });
  }
  return {
    split: classified.value,
    workedHours: worked,
    method,
    rule: classified.rule,
    note: classified.rule.explanation,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const timecardRoutes: FastifyPluginAsync = async (app) => {
  const gates = timecardGates(app);

  /* ------------------------------- reads --------------------------- */

  async function loadAllocations(timecardId: string) {
    return app.db
      .select()
      .from(timecardAllocations)
      .where(eq(timecardAllocations.timecardId, timecardId))
      .orderBy(asc(timecardAllocations.position));
  }

  async function loadApprovals(timecardId: string) {
    return app.db
      .select()
      .from(timecardApprovals)
      .where(eq(timecardApprovals.timecardId, timecardId))
      .orderBy(asc(timecardApprovals.level), asc(timecardApprovals.decidedAt));
  }

  /** The access record for one worker on one date, or null. */
  async function accessRecordFor(workerId: string, workDate: string) {
    const rows = await app.db
      .select()
      .from(siteAccessRecords)
      .where(
        and(eq(siteAccessRecords.workerId, workerId), eq(siteAccessRecords.accessDate, workDate)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The crew a worker belonged to on a date — dated membership, not a flag. */
  async function crewOnDate(
    projectId: string,
    workerId: string,
    onDate: string,
  ): Promise<{ crew: CrewRow; member: typeof crewMembers.$inferSelect } | null> {
    const rows = await app.db
      .select({ crew: crews, member: crewMembers })
      .from(crewMembers)
      .innerJoin(crews, eq(crews.id, crewMembers.crewId))
      .where(
        and(
          eq(crewMembers.projectId, projectId),
          eq(crewMembers.workerId, workerId),
          lte(crewMembers.fromDate, onDate),
          or(isNull(crewMembers.toDate), gte(crewMembers.toDate, onDate))!,
        ),
      )
      .orderBy(desc(crewMembers.fromDate))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Ladder hours (plain + overtime + double, never premium) already banked by
   * this worker EARLIER in the same pay week. Only the weekly rule reads it;
   * the daily rule is indifferent to what happened on Monday.
   */
  async function priorWeekLadder(
    projectId: string,
    workerId: string,
    workDate: string,
    weekStartsOn: number,
    excludeTimecardId?: string,
  ): Promise<{ hours: number; weekStart: string; weekEnd: string }> {
    const start = weekStart(workDate, weekStartsOn);
    const end = addDays(start, 6);
    const clauses = [
      eq(timecards.projectId, projectId),
      eq(timecards.workerId, workerId),
      gte(timecards.workDate, start),
      lte(timecards.workDate, workDate === start ? start : addDays(workDate, -1)),
      ne(timecards.status, "void"),
      ne(timecards.status, "revised"),
    ];
    if (excludeTimecardId) clauses.push(ne(timecards.id, excludeTimecardId));
    if (workDate === start) {
      return { hours: 0, weekStart: start, weekEnd: end };
    }
    const rows = await app.db
      .select({
        regularHours: timecards.regularHours,
        overtimeHours: timecards.overtimeHours,
        doubleTimeHours: timecards.doubleTimeHours,
      })
      .from(timecards)
      .where(and(...clauses));
    return {
      hours: round2(
        rows.reduce((s, r) => s + r.regularHours + r.overtimeHours + r.doubleTimeHours, 0),
      ),
      weekStart: start,
      weekEnd: end,
    };
  }

  /* --------------------------- create ------------------------------ */

  app.post("/projects/:projectId/timecards", { preHandler: gates.standard }, async (req, reply) => {
    const body = timecardCreateSchema.parse(req.body);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const actorId = actorOf(req);
    const shift = body.shift ?? "day";

    const worker = await requireWorker(app.db, body.workerId, companyId, projectId);

    // One worker, one day, one shift. The clash is named, because the second
    // card is usually somebody re-keying a crew sheet, not fraud.
    const clash = await app.db
      .select({ id: timecards.id, reference: timecards.reference, status: timecards.status })
      .from(timecards)
      .where(
        and(
          eq(timecards.workerId, body.workerId),
          eq(timecards.workDate, body.workDate),
          eq(timecards.shift, shift),
        ),
      )
      .limit(1);
    if (clash[0]) {
      throw conflict(
        `${worker.reference} already has timecard ${clash[0].reference} (${clash[0].status}) for ` +
          `${body.workDate} on the ${shift} shift. One worker, one day, one shift — edit that card ` +
          "or raise an adjustment against it.",
      );
    }

    // Crew: named explicitly, or the crew this worker belonged to THAT DAY.
    let crew: CrewRow | null = null;
    let member: typeof crewMembers.$inferSelect | null = null;
    if (body.crewId) {
      crew = await fetchCrew(app.db, body.crewId, companyId, projectId);
      const rows = await app.db
        .select()
        .from(crewMembers)
        .where(and(eq(crewMembers.crewId, crew.id), eq(crewMembers.workerId, body.workerId)))
        .orderBy(desc(crewMembers.fromDate));
      member =
        rows.find(
          (m) => m.fromDate <= body.workDate && (m.toDate === null || m.toDate >= body.workDate),
        ) ?? null;
    } else {
      const hit = await crewOnDate(projectId, body.workerId, body.workDate);
      crew = hit?.crew ?? null;
      member = hit?.member ?? null;
    }

    const cfg = crewConfig(crew);
    const prior = await priorWeekLadder(
      projectId,
      body.workerId,
      body.workDate,
      cfg.weekStartsOn,
    );
    const resolved = resolveHours(body, crew, prior.hours);

    const idle = round2(body.idleHours ?? 0);
    if (idle > resolved.split.totalHours + 0.005) {
      throw badRequest(
        `${idle} idle hour(s) exceed the ${resolved.split.totalHours} hour(s) on this card. Idle ` +
          "hours are a memo on hours already claimed and paid, never an addition to them.",
      );
    }
    if (idle > 0 && !body.idleReason) {
      throw badRequest(
        "Idle hours were recorded with no idleReason. \"Awaiting materials\" and \"weather\" " +
          "produce entirely different conversations, and one of them is recoverable.",
      );
    }

    const rates = resolveRates(body, member, worker);
    const cost = costHours(resolved.split, rates);

    // Reconciliation 1 — claimed against the independent access stream.
    const access = await accessRecordFor(body.workerId, body.workDate);
    const variance = accessVariance({
      claimedHours: resolved.split.totalHours,
      hasAccessRecord: access !== null,
      accessHoursOnSite: access?.hoursOnSite ?? null,
      firstIn: access?.firstIn ?? null,
      lastOut: access?.lastOut ?? null,
      explanation: body.varianceExplanation ?? null,
      toleranceHours: cfg.varianceToleranceHours,
    });

    if (body.batchId) {
      const [batch] = await app.db
        .select()
        .from(timecardBatches)
        .where(and(eq(timecardBatches.id, body.batchId), eq(timecardBatches.projectId, projectId)))
        .limit(1);
      if (!batch) throw badRequest(`batchId ${body.batchId} is not a batch on this project.`);
      /*
       * A CARD ONLY JOINS A BATCH THAT IS STILL OPEN.
       *
       * Refusing only locked/exported let a draft card be dropped into a
       * SUBMITTED or APPROVED batch: lock and export only touch approved and
       * submitted cards, so the draft stayed draft under an exported batch id
       * and never reached payroll. And `collectInto` enforces one currency per
       * batch while this path did not, so a USD card in a GBP batch made
       * `computeBatchRollup` throw — permanently 400ing the batch detail view.
       */
      if (!["draft", "rejected"].includes(batch.status)) {
        throw conflict(
          `Batch ${batch.reference} is "${batch.status}" and takes no further cards. A week that ` +
            "has been submitted is a claim somebody is reviewing; adding to it silently changes " +
            "what they are reviewing. Raise the card on its own, or collect it into a new batch.",
        );
      }
      assertSameCurrency(
        [
          { label: batch.reference, currency: batch.currency },
          {
            label: "this card",
            // The same precedence resolveRates uses, so the check and the
            // stored currency can never disagree.
            currency: (
              body.currency ??
              member?.currency ??
              worker.currency ??
              "USD"
            ).toUpperCase(),
          },
        ],
        `Adding a card to batch ${batch.reference}`,
      );
    }

    const number = await nextRecordNumber(app.db, projectId, "timecard");
    const id = newId("tcd");
    const reference = `TC-${pad3(number)}`;

    await app.db.insert(timecards).values({
      id,
      companyId,
      projectId,
      number,
      reference,
      batchId: body.batchId ?? null,
      workerId: body.workerId,
      crewId: crew?.id ?? null,
      vendorId: worker.vendorId,
      workDate: body.workDate,
      shift,
      trade: body.trade ?? crew?.trade ?? worker.trade ?? null,
      classification: body.classification ?? member?.classification ?? null,
      startTime: body.startTime ?? null,
      endTime: body.endTime ?? null,
      breakMinutes: body.breakMinutes ?? 0,
      regularHours: resolved.split.regularHours,
      overtimeHours: resolved.split.overtimeHours,
      doubleTimeHours: resolved.split.doubleTimeHours,
      premiumHours: resolved.split.premiumHours,
      premiumKind: body.premiumKind ?? "none",
      totalHours: resolved.split.totalHours,
      idleHours: idle,
      idleReason: body.idleReason ?? null,
      hourlyRate: rates.hourlyRate,
      overtimeRate: rates.overtimeRate,
      doubleTimeRate: rates.doubleTimeRate,
      premiumRate: rates.premiumRate,
      burdenRate: rates.burdenRate,
      totalCost: cost.value,
      currency: rates.currency,
      isBillable: body.isBillable ? 1 : 0,
      source: body.source ?? "manual",
      siteAccessRecordId: access?.id ?? null,
      accessHoursOnSite: variance.accessHours,
      varianceHours: variance.value,
      varianceExplanation: body.varianceExplanation ?? null,
      status: "draft",
      locationId: body.locationId ?? crew?.locationId ?? null,
      weatherDelayHours: body.weatherDelayHours ?? null,
      dailyLogId: body.dailyLogId ?? null,
      notes: body.notes ?? null,
      detail: {
        ...(body.detail ?? {}),
        hourClassification: {
          method: resolved.method,
          workedHours: resolved.workedHours,
          rule: resolved.rule,
          note: resolved.note,
          priorWeekLadderHours: prior.hours,
          weekStart: prior.weekStart,
          weekEnd: prior.weekEnd,
        },
        cost: { value: cost.value, reasons: cost.reasons, currency: cost.currency },
        variance: {
          value: variance.value,
          accessHours: variance.accessHours,
          accessHoursSource: variance.accessHoursSource,
          withinTolerance: variance.withinTolerance,
          toleranceHours: variance.toleranceHours,
          reasons: variance.reasons,
        },
      },
      createdBy: actorId,
    });

    if (body.allocations && body.allocations.length > 0) {
      await writeAllocations(app.db, {
        companyId,
        projectId,
        timecardId: id,
        reference,
        split: resolved.split,
        currency: rates.currency,
        rates,
        allocations: body.allocations,
      });
    }

    await ledgerTimecards(app.db, req, "create", "timecard", id, {
      reference,
      workerId: body.workerId,
      workerReference: worker.reference,
      workDate: body.workDate,
      shift,
      crewId: crew?.id ?? null,
      hours: resolved.split,
      classificationMethod: resolved.method,
      overtimeRule: resolved.rule?.kind ?? "explicit",
      totalCost: cost.value,
      currency: rates.currency,
      varianceHours: variance.value,
      siteAccessRecordId: access?.id ?? null,
    });

    const reclassified =
      resolved.rule?.kind === "weekly"
        ? await reclassifyWeek(projectId, companyId, body.workerId, body.workDate, cfg.weekStartsOn, actorId)
        : [];
    if (body.batchId) await recomputeBatch(app.db, body.batchId);

    return reply.status(201).send({
      ...(await timecardView(id, companyId, projectId)),
      weekReclassified: reclassified,
    });
  });

  /* ---------------------------- list ------------------------------- */

  app.get("/projects/:projectId/timecards", { preHandler: gates.read }, async (req) => {
    const q = timecardListQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);

    /*
     * A READ DOES NOT WRITE. This route used to run the access-link sweep on
     * every page load, under `read` permission: up to 500 cards selected and
     * one UPDATE issued per match, by any viewer. The links are now attached
     * where the evidence lands (the site-access ingest calls
     * `attachAccessLinks`) and by the `timecards.access-links` scheduled job.
     */

    const clauses = [eq(timecards.companyId, companyId), eq(timecards.projectId, projectId)];
    if (q.workerId) clauses.push(eq(timecards.workerId, q.workerId));
    if (q.crewId) clauses.push(eq(timecards.crewId, q.crewId));
    if (q.batchId) clauses.push(eq(timecards.batchId, q.batchId));
    if (q.vendorId) clauses.push(eq(timecards.vendorId, q.vendorId));
    if (q.status) clauses.push(eq(timecards.status, q.status));
    if (q.shift) clauses.push(eq(timecards.shift, q.shift));
    if (q.from) clauses.push(gte(timecards.workDate, q.from));
    if (q.to) clauses.push(lte(timecards.workDate, q.to));
    if (q.exceptions === "true") {
      // An exception is a COMPUTED positive variance beyond tolerance that
      // nobody has explained. A null variance — no usable access record — is
      // deliberately not an exception: it is a gap in the evidence feed.
      clauses.push(sql`${timecards.varianceHours} is not null`);
      clauses.push(sql`${timecards.varianceHours} > ${VARIANCE_TOLERANCE_HOURS}`);
      clauses.push(
        or(isNull(timecards.varianceExplanation), eq(timecards.varianceExplanation, ""))!,
      );
    }
    if (q.unallocated === "true") {
      // NOT EXISTS, not a NOT IN over every allocated card id on the project —
      // that list grows with the job and was being materialised on every read.
      clauses.push(
        sql`not exists (select 1 from ${timecardAllocations} where ${timecardAllocations.timecardId} = ${timecards.id})`,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(timecards).where(where);
    const rows = await app.db
      .select({
        card: timecards,
        workerReference: workers.reference,
        workerName: workers.fullName,
      })
      .from(timecards)
      .innerJoin(workers, eq(workers.id, timecards.workerId))
      .where(where)
      .orderBy(desc(timecards.workDate), asc(timecards.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));

    const ids = rows.map((r) => r.card.id);
    const allocs =
      ids.length > 0
        ? await app.db
            .select({
              timecardId: timecardAllocations.timecardId,
              n: count(),
              hours: sql<number>`coalesce(sum(${timecardAllocations.totalHours}), 0)`,
            })
            .from(timecardAllocations)
            .where(inArray(timecardAllocations.timecardId, ids))
            .groupBy(timecardAllocations.timecardId)
        : [];
    const allocMap = new Map(allocs.map((a) => [a.timecardId, a]));

    return {
      ...paginate(
        rows.map((r) => ({
          ...r.card,
          workerReference: r.workerReference,
          workerName: r.workerName,
          allocationCount: Number(allocMap.get(r.card.id)?.n ?? 0),
          allocatedHours: round2(Number(allocMap.get(r.card.id)?.hours ?? 0)),
          isAllocated: Number(allocMap.get(r.card.id)?.n ?? 0) > 0,
        })),
        Number(totalRow?.n ?? 0),
        q,
      ),
    };
  });

  /* --------------------------- detail ------------------------------ */

  async function timecardView(id: string, companyId: string, projectId: string) {
    const card = await fetchTimecard(app.db, id, companyId, projectId);
    const [worker] = await app.db.select().from(workers).where(eq(workers.id, card.workerId));
    const crew = card.crewId
      ? ((await app.db.select().from(crews).where(eq(crews.id, card.crewId)))[0] ?? null)
      : null;
    const allocations = await loadAllocations(id);
    const approvals = await loadApprovals(id);
    const check = reconcileAllocations(splitOf(card), allocations);
    const access = card.siteAccessRecordId
      ? ((
          await app.db
            .select()
            .from(siteAccessRecords)
            .where(eq(siteAccessRecords.id, card.siteAccessRecordId))
        )[0] ?? null)
      : null;
    const cfg = crewConfig(crew);
    const variance = accessVariance({
      claimedHours: card.totalHours,
      hasAccessRecord: access !== null,
      accessHoursOnSite: access?.hoursOnSite ?? null,
      firstIn: access?.firstIn ?? null,
      lastOut: access?.lastOut ?? null,
      explanation: card.varianceExplanation,
      toleranceHours: cfg.varianceToleranceHours,
    });
    return {
      ...card,
      workerReference: worker?.reference ?? null,
      workerName: worker?.fullName ?? null,
      crewReference: crew?.reference ?? null,
      crewName: crew?.name ?? null,
      overtimeRule: overtimeRuleOf(crew),
      allocations,
      allocationCheck: {
        ok: allocations.length > 0 && check.ok,
        allocated: check.allocated,
        claimed: check.claimed,
        differences: check.differences,
        message:
          allocations.length === 0
            ? "This card has no cost coding at all. Hours nobody can code are how a labour " +
              "overrun stays invisible until the month-end journal."
            : check.message,
      },
      approvals,
      siteAccess: access,
      variance,
      isEditable: !["locked", "exported", "void", "revised"].includes(card.status),
    };
  }

  app.get("/projects/:projectId/timecards/:timecardId", { preHandler: gates.read }, async (req) => {
    const { timecardId } = req.params as { timecardId: string };
    return timecardView(timecardId, companyOf(req), projectOf(req));
  });

  /* --------------------------- update ------------------------------ */

  app.patch(
    "/projects/:projectId/timecards/:timecardId",
    { preHandler: gates.standard },
    async (req) => {
      const { timecardId } = req.params as { timecardId: string };
      const body = timecardPatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const card = await fetchTimecard(app.db, timecardId, companyId, projectId);
      assertTimecardEditable(card, "edit");
      if (card.status === "approved") {
        throw conflict(
          `Timecard ${card.reference} is approved. Return it for revision before editing it, so ` +
            "the approval that is being invalidated is visible in the trail.",
        );
      }

      const worker = await requireWorker(app.db, card.workerId, companyId, projectId);
      let crew: CrewRow | null = card.crewId
        ? await fetchCrew(app.db, card.crewId, companyId, projectId)
        : null;
      if (body.crewId !== undefined) {
        crew = body.crewId ? await fetchCrew(app.db, body.crewId, companyId, projectId) : null;
      }
      const cfg = crewConfig(crew);
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      const detail: Record<string, unknown> = { ...(card.detail ?? {}), ...(body.detail ?? {}) };

      const touchesHours =
        body.workedHours !== undefined ||
        body.startTime !== undefined ||
        body.endTime !== undefined ||
        body.breakMinutes !== undefined ||
        hasExplicitSplit(body) ||
        body.premiumHours !== undefined;

      let split = splitOf(card);
      if (touchesHours) {
        const prior = await priorWeekLadder(
          projectId,
          card.workerId,
          card.workDate,
          cfg.weekStartsOn,
          card.id,
        );
        const merged: HoursBody = {
          workedHours: body.workedHours,
          startTime: body.startTime === undefined ? card.startTime : body.startTime,
          endTime: body.endTime === undefined ? card.endTime : body.endTime,
          breakMinutes: body.breakMinutes ?? card.breakMinutes,
          ...(hasExplicitSplit(body)
            ? {
                regularHours: body.regularHours ?? card.regularHours,
                overtimeHours: body.overtimeHours ?? card.overtimeHours,
                doubleTimeHours: body.doubleTimeHours ?? card.doubleTimeHours,
              }
            : {}),
          premiumHours: body.premiumHours ?? card.premiumHours,
          premiumKind: body.premiumKind ?? card.premiumKind,
        };
        if (merged.workedHours === undefined && !hasExplicitSplit(merged) && !(merged.startTime && merged.endTime)) {
          merged.workedHours = card.totalHours - (merged.premiumHours ?? 0);
        }
        const resolved = resolveHours(merged, crew, prior.hours);
        split = resolved.split;
        set["regularHours"] = split.regularHours;
        set["overtimeHours"] = split.overtimeHours;
        set["doubleTimeHours"] = split.doubleTimeHours;
        set["premiumHours"] = split.premiumHours;
        set["totalHours"] = split.totalHours;
        detail["hourClassification"] = {
          method: resolved.method,
          workedHours: resolved.workedHours,
          rule: resolved.rule,
          note: resolved.note,
          priorWeekLadderHours: prior.hours,
          weekStart: prior.weekStart,
          weekEnd: prior.weekEnd,
        };
      }

      const direct = [
        "trade",
        "classification",
        "startTime",
        "endTime",
        "breakMinutes",
        "idleReason",
        "locationId",
        "dailyLogId",
        "notes",
        "weatherDelayHours",
        "varianceExplanation",
        "source",
      ] as const;
      for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
      if (body.crewId !== undefined) set["crewId"] = crew?.id ?? null;
      if (body.isBillable !== undefined) set["isBillable"] = body.isBillable ? 1 : 0;
      if (body.premiumKind !== undefined) set["premiumKind"] = body.premiumKind;
      if (body.idleHours !== undefined) {
        const idle = round2(body.idleHours);
        if (idle > split.totalHours + 0.005) {
          throw badRequest(
            `${idle} idle hour(s) exceed the ${split.totalHours} hour(s) on this card.`,
          );
        }
        if (idle > 0 && !(body.idleReason ?? card.idleReason)) {
          throw badRequest("Idle hours were recorded with no idleReason.");
        }
        set["idleHours"] = idle;
      }

      const rates = resolveRates(
        {
          hourlyRate: body.hourlyRate === undefined ? card.hourlyRate : body.hourlyRate,
          overtimeRate: body.overtimeRate === undefined ? card.overtimeRate : body.overtimeRate,
          doubleTimeRate:
            body.doubleTimeRate === undefined ? card.doubleTimeRate : body.doubleTimeRate,
          premiumRate: body.premiumRate === undefined ? card.premiumRate : body.premiumRate,
          burdenRate: body.burdenRate === undefined ? card.burdenRate : body.burdenRate,
          currency: body.currency ?? card.currency,
        },
        null,
        worker,
      );
      set["hourlyRate"] = rates.hourlyRate;
      set["overtimeRate"] = rates.overtimeRate;
      set["doubleTimeRate"] = rates.doubleTimeRate;
      set["premiumRate"] = rates.premiumRate;
      set["burdenRate"] = rates.burdenRate;
      set["currency"] = rates.currency;
      const cost = costHours(split, rates);
      set["totalCost"] = cost.value;
      detail["cost"] = { value: cost.value, reasons: cost.reasons, currency: cost.currency };

      // The variance follows the hours: an edited claim is a new claim.
      const access = await accessRecordFor(card.workerId, card.workDate);
      const variance = accessVariance({
        claimedHours: split.totalHours,
        hasAccessRecord: access !== null,
        accessHoursOnSite: access?.hoursOnSite ?? null,
        firstIn: access?.firstIn ?? null,
        lastOut: access?.lastOut ?? null,
        explanation:
          body.varianceExplanation === undefined ? card.varianceExplanation : body.varianceExplanation,
        toleranceHours: cfg.varianceToleranceHours,
      });
      set["siteAccessRecordId"] = access?.id ?? null;
      set["accessHoursOnSite"] = variance.accessHours;
      set["varianceHours"] = variance.value;
      detail["variance"] = {
        value: variance.value,
        accessHours: variance.accessHours,
        accessHoursSource: variance.accessHoursSource,
        withinTolerance: variance.withinTolerance,
        toleranceHours: variance.toleranceHours,
        reasons: variance.reasons,
      };
      set["detail"] = detail;

      await app.db.update(timecards).set(set).where(eq(timecards.id, timecardId));

      /*
       * A WEEKLY RULE REPRICES THE WHOLE WEEK.
       *
       * `reclassifyWeek` ran only from create. Editing Monday from 8h to 12h
       * under a 40-hour weekly threshold left Friday still showing plain time
       * although the week now crossed 40 on Thursday — the cards disagreed
       * with the rule they were classified under, and payroll paid the cards.
       */
      const weekReclassified =
        touchesHours && overtimeRuleOf(crew).kind === "weekly"
          ? await reclassifyWeek(
              projectId,
              companyId,
              card.workerId,
              card.workDate,
              cfg.weekStartsOn,
              actorOf(req),
            )
          : [];
      if (card.batchId) await recomputeBatch(app.db, card.batchId);

      await ledgerTimecards(app.db, req, "update", "timecard", timecardId, {
        reference: card.reference,
        changed: Object.keys(body),
        hours: split,
        varianceHours: variance.value,
        weekReclassified: weekReclassified.length,
      });
      return {
        ...(await timecardView(timecardId, companyId, projectId)),
        weekReclassified,
      };
    },
  );

  /* ------------------------- allocations --------------------------- */

  app.get(
    "/projects/:projectId/timecards/:timecardId/allocations",
    { preHandler: gates.read },
    async (req) => {
      const { timecardId } = req.params as { timecardId: string };
      const card = await fetchTimecard(app.db, timecardId, companyOf(req), projectOf(req));
      const allocations = await loadAllocations(timecardId);
      const check = reconcileAllocations(splitOf(card), allocations);
      return { timecardId, reference: card.reference, allocations, check };
    },
  );

  /**
   * Replace a card's cost coding.
   *
   * The set is written as a WHOLE or not at all, and it is refused unless the
   * hours reconcile bucket by bucket with the card. This is the join that puts
   * labour on the cost report; an allocation set that does not add up is
   * either hours nobody can code or hours coded twice, and both arrive on the
   * cost report looking like fact.
   */
  app.put(
    "/projects/:projectId/timecards/:timecardId/allocations",
    { preHandler: gates.standard },
    async (req) => {
      const { timecardId } = req.params as { timecardId: string };
      const body = allocationsPutSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const card = await fetchTimecard(app.db, timecardId, companyId, projectId);
      assertTimecardEditable(card, "re-code");
      if (card.status === "approved") {
        throw conflict(
          `Timecard ${card.reference} is approved; return it for revision before re-coding it.`,
        );
      }
      await writeAllocations(app.db, {
        companyId,
        projectId,
        timecardId,
        reference: card.reference,
        split: splitOf(card),
        currency: card.currency,
        rates: {
          hourlyRate: card.hourlyRate,
          overtimeRate: card.overtimeRate,
          doubleTimeRate: card.doubleTimeRate,
          premiumRate: card.premiumRate,
          burdenRate: card.burdenRate,
          currency: card.currency,
        },
        allocations: body.allocations,
      });
      await ledgerTimecards(app.db, req, "update", "timecard_allocations", timecardId, {
        reference: card.reference,
        allocations: body.allocations.length,
        hours: splitOf(card),
      });
      const allocations = await loadAllocations(timecardId);
      return {
        timecardId,
        reference: card.reference,
        allocations,
        check: reconcileAllocations(splitOf(card), allocations),
      };
    },
  );

  /** Validate the coding of every card on the project. Named because the
   *  cost report is only as exact as the worst card on it. */
  async function writeAllocations(
    db: Db,
    args: {
      companyId: string;
      projectId: string;
      timecardId: string;
      reference: string;
      split: HourSplit;
      currency: string;
      rates: {
        hourlyRate: number | null;
        overtimeRate: number | null;
        doubleTimeRate: number | null;
        premiumRate: number | null;
        burdenRate: number | null;
        currency: string;
      };
      allocations: AllocationInput[];
    },
  ): Promise<void> {
    const rows = args.allocations.map((a) => ({
      regularHours: round2(a.regularHours ?? 0),
      overtimeHours: round2(a.overtimeHours ?? 0),
      doubleTimeHours: round2(a.doubleTimeHours ?? 0),
      premiumHours: round2(a.premiumHours ?? 0),
    }));
    const check = reconcileAllocations(args.split, rows);
    if (!check.ok) {
      throw badRequest(`Timecard ${args.reference}: ${check.message}`, {
        control: "allocations_must_reconcile",
        timecardId: args.timecardId,
        claimed: check.claimed,
        allocated: check.allocated,
        differences: check.differences,
      });
    }
    for (const [i, a] of args.allocations.entries()) {
      const hours = rows[i]!;
      if (
        hours.regularHours + hours.overtimeHours + hours.doubleTimeHours + hours.premiumHours <=
        0
      ) {
        throw badRequest(
          `Allocation ${i + 1} on ${args.reference} carries no hours. An allocation with no hours ` +
            "codes nothing and only clutters the cost report.",
        );
      }
      if (a.costCodeId) await requireCostCode(db, a.costCodeId, args.companyId);
      if (a.budgetLineItemId) {
        await requireBudgetLine(db, a.budgetLineItemId, args.companyId, args.projectId);
      }
      if (!a.costCodeId && !a.budgetLineItemId && !a.costCode) {
        throw badRequest(
          `Allocation ${i + 1} on ${args.reference} names neither a cost code nor a budget line. ` +
            "Hours that land nowhere are exactly the hours that never reach the cost report.",
        );
      }
    }

    await db.transaction(async (tx) => {
      await tx.delete(timecardAllocations).where(eq(timecardAllocations.timecardId, args.timecardId));
      for (const [i, a] of args.allocations.entries()) {
        const hours = rows[i]!;
        const total = round2(
          hours.regularHours + hours.overtimeHours + hours.doubleTimeHours + hours.premiumHours,
        );
        const cost = costHours(
          { ...hours, totalHours: total },
          { ...args.rates, hourlyRate: a.hourlyRate ?? args.rates.hourlyRate },
        );
        await tx.insert(timecardAllocations).values({
          id: newId("tca"),
          companyId: args.companyId,
          projectId: args.projectId,
          timecardId: args.timecardId,
          position: i,
          costCodeId: a.costCodeId ?? null,
          costCode: a.costCode ?? null,
          costType: a.costType ?? "labour",
          budgetLineItemId: a.budgetLineItemId ?? null,
          wbsPath: a.wbsPath ?? null,
          subJob: a.subJob ?? null,
          locationId: a.locationId ?? null,
          scheduleActivityId: a.scheduleActivityId ?? null,
          commitmentId: a.commitmentId ?? null,
          changeEventId: a.changeEventId ?? null,
          tmTicketId: a.tmTicketId ?? null,
          equipmentId: a.equipmentId ?? null,
          regularHours: hours.regularHours,
          overtimeHours: hours.overtimeHours,
          doubleTimeHours: hours.doubleTimeHours,
          premiumHours: hours.premiumHours,
          totalHours: total,
          hourlyRate: a.hourlyRate ?? args.rates.hourlyRate,
          cost: cost.value,
          currency: args.currency,
          quantity: a.quantity ?? null,
          unit: a.unit ?? null,
          isBillable: a.isBillable ? 1 : 0,
          notes: a.notes ?? null,
          detail: { ...(a.detail ?? {}), costReasons: cost.reasons },
        });
      }
    });
  }

  /* --------------------------- workflow ---------------------------- */

  app.post(
    "/projects/:projectId/timecards/:timecardId/submit",
    { preHandler: gates.standard },
    async (req) => {
      const { timecardId } = req.params as { timecardId: string };
      const body = submitSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const card = await fetchTimecard(app.db, timecardId, companyId, projectId);
      assertTimecardEditable(card, "submit");
      assertTransition(card.status, ["draft", "rejected"], "timecard", "submit");

      const allocations = await loadAllocations(timecardId);
      if (allocations.length === 0) {
        throw conflict(
          `Timecard ${card.reference} has no cost coding. A timecard with no allocation is hours ` +
            "nobody can code, which is how labour overruns stay invisible until the month-end " +
            "journal. Code it before submitting it.",
        );
      }
      const check = reconcileAllocations(splitOf(card), allocations);
      if (!check.ok) throw conflict(`Timecard ${card.reference}: ${check.message}`);

      await app.db
        .update(timecards)
        .set({
          status: "submitted",
          submittedBy: actorOf(req),
          submittedAt: nowIso(),
          rejectedReason: null,
          detail: { ...(card.detail ?? {}), submitComment: body.comment ?? null },
          updatedAt: nowIso(),
        })
        .where(eq(timecards.id, timecardId));
      await ledgerTimecards(app.db, req, "state_change", "timecard", timecardId, {
        reference: card.reference,
        from: card.status,
        to: "submitted",
        hours: splitOf(card),
      });
      return timecardView(timecardId, companyId, projectId);
    },
  );

  /**
   * APPROVE — and the segregation-of-duties control the schema asks for.
   *
   * `timecard_approvals.isSelfApproval` is a STORED column deliberately: a
   * control that silently blocks a breach leaves no evidence the breach was
   * attempted. So the attempt is WRITTEN FIRST — an approval row flagged
   * self-approval, a `timecard_self_approval` signal for the assurance layer,
   * and a ledger entry — and only then refused with a 403 that names the
   * record it just created. The foreman who tries to approve his own crew
   * sheet learns that the attempt is now on the record.
   */
  app.post(
    "/projects/:projectId/timecards/:timecardId/approve",
    { preHandler: gates.standard },
    async (req) => {
      const { timecardId } = req.params as { timecardId: string };
      const body = approveSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const card = await fetchTimecard(app.db, timecardId, companyId, projectId);
      assertTimecardEditable(card, "approve");
      assertTransition(card.status, ["submitted"], "timecard", "approve");
      // Derived, not defaulted: two approvers on a two-tier crew both landing
      // on level 1 left the card submitted for ever with nothing explaining it.
      const priorApprovals = await loadApprovals(timecardId);
      const level =
        body.level ??
        Math.min(
          3,
          Math.max(
            0,
            ...priorApprovals
              .filter((a) => a.decision === "approved" && a.isSelfApproval === 0)
              .map((a) => a.level),
            0,
          ) + 1,
        );

      const self = checkSelfApproval(
        actorId,
        { submittedBy: card.submittedBy, createdBy: card.createdBy },
        "timecard",
      );
      if (self.isSelfApproval) {
        const approvalId = await recordApproval({
          companyId,
          projectId,
          timecardId,
          batchId: null,
          level,
          approverId: actorId,
          approverRole: body.approverRole ?? null,
          decision: body.decision,
          comment: body.comment ?? null,
          subjectWorkerId: card.workerId,
          isSelfApproval: true,
          delegatedFromId: body.delegatedFromId ?? null,
          signatureFileId: body.signatureFileId ?? null,
          detail: {
            outcome: "refused",
            control: "no_self_approval",
            breachedRelationship: self.role,
            attemptedDecision: body.decision,
            timecardReference: card.reference,
          },
        });
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId,
          detector: "timecard_self_approval",
          severity: "high",
          confidence: 1,
          title: `Self-approval refused on timecard ${card.reference}`,
          explanation:
            `A user attempted to approve timecard ${card.reference} (${card.totalHours} h on ` +
            `${card.workDate}) which they themselves ${self.role === "submitted_by" ? "submitted" : "raised"}. ` +
            "The approval was refused and the attempt recorded as approval " +
            `${approvalId} with isSelfApproval set. Approving one's own claimed hours is the ` +
            "classic labour fraud on a construction project: it needs no forged document and no " +
            "accomplice, only an approval chain nobody segregated.",
          evidenceRefs: {
            timecardId,
            reference: card.reference,
            approvalId,
            approverId: actorId,
            breachedRelationship: self.role,
            workerId: card.workerId,
            workDate: card.workDate,
            totalHours: card.totalHours,
          },
        });
        await ledgerTimecards(app.db, req, "state_change", "timecard_approval", approvalId, {
          control: "no_self_approval",
          outcome: "refused",
          timecardId,
          reference: card.reference,
          breachedRelationship: self.role,
        });
        throw selfApprovalRefusal("timecard", card.reference, self, approvalId);
      }

      const existing = await loadApprovals(timecardId);
      const already = existing.find(
        (a) => a.approverId === actorId && a.decision === "approved" && a.isSelfApproval === 0,
      );
      if (already && body.decision === "approved") {
        throw conflict(
          `${card.reference} already carries an approval from you at level ${already.level}. One ` +
            "person is one tier: a second signature from the same hand adds no independence.",
        );
      }

      if (body.decision === "approved") {
        const allocations = await loadAllocations(timecardId);
        const check = reconcileAllocations(splitOf(card), allocations);
        if (allocations.length === 0 || !check.ok) {
          throw conflict(
            `Timecard ${card.reference} cannot be approved: ${check.message ?? "it has no cost coding"}.`,
          );
        }
        // Reconciliation 1 gate: an unexplained overclaim is not approvable.
        const crew = card.crewId
          ? ((await app.db.select().from(crews).where(eq(crews.id, card.crewId)))[0] ?? null)
          : null;
        const tolerance = crewConfig(crew).varianceToleranceHours;
        if (
          card.varianceHours !== null &&
          Math.abs(card.varianceHours) > tolerance &&
          !(card.varianceExplanation ?? "").trim()
        ) {
          throw conflict(
            `Timecard ${card.reference} claims ${card.totalHours} h against ` +
              `${card.accessHoursOnSite ?? "?"} h of recorded site presence — a variance of ` +
              `${card.varianceHours > 0 ? "+" : ""}${card.varianceHours} h, beyond the ${tolerance} h ` +
              "tolerance. Record why before approving it: POST " +
              `/projects/${projectId}/timecards/${timecardId}/explain-variance.`,
            );
        }
      }
      if (body.decision === "rejected" && !(body.comment ?? "").trim()) {
        throw badRequest("A rejection needs a reason — the crew has to know what to fix.");
      }

      const approvalId = await recordApproval({
        companyId,
        projectId,
        timecardId,
        batchId: null,
        level,
        approverId: actorId,
        approverRole: body.approverRole ?? null,
        decision: body.decision,
        comment: body.comment ?? null,
        subjectWorkerId: card.workerId,
        isSelfApproval: false,
        delegatedFromId: body.delegatedFromId ?? null,
        signatureFileId: body.signatureFileId ?? null,
        detail: { outcome: "recorded", timecardReference: card.reference },
      });

      const crew = card.crewId
        ? ((await app.db.select().from(crews).where(eq(crews.id, card.crewId)))[0] ?? null)
        : null;
      const required = crewConfig(crew).approvalLevels;
      const approvals = await loadApprovals(timecardId);
      const approvedLevels = new Set(
        approvals
          .filter((a) => a.decision === "approved" && a.isSelfApproval === 0)
          .map((a) => a.level),
      );

      const set: Record<string, unknown> = { updatedAt: nowIso() };
      if (body.decision === "approved") {
        if (approvedLevels.size >= required) {
          set["status"] = "approved";
          set["approvedBy"] = actorId;
          set["approvedAt"] = nowIso();
        }
      } else if (body.decision === "rejected") {
        set["status"] = "rejected";
        set["rejectedReason"] = body.comment ?? null;
      } else {
        set["status"] = "draft";
        set["rejectedReason"] = body.comment ?? null;
      }
      await app.db.update(timecards).set(set).where(eq(timecards.id, timecardId));
      await ledgerTimecards(app.db, req, "state_change", "timecard", timecardId, {
        reference: card.reference,
        from: card.status,
        to: set["status"] ?? card.status,
        decision: body.decision,
        level,
        approvalId,
        approvedLevels: [...approvedLevels],
        requiredLevels: required,
      });
      if (card.batchId) await recomputeBatch(app.db, card.batchId);
      return {
        ...(await timecardView(timecardId, companyId, projectId)),
        approvalId,
        level,
        approvedLevels: [...approvedLevels].sort(),
        requiredLevels: required,
        approvalProgress:
          body.decision === "approved"
            ? `approved ${approvedLevels.size} of ${required} tier(s)` +
              (approvedLevels.size < required
                ? ` — tier ${Math.min(3, approvedLevels.size + 1)} still has to sign`
                : "")
            : null,
      };
    },
  );

  app.post(
    "/projects/:projectId/timecards/:timecardId/explain-variance",
    { preHandler: gates.standard },
    async (req) => {
      const { timecardId } = req.params as { timecardId: string };
      const body = explainSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const card = await fetchTimecard(app.db, timecardId, companyId, projectId);
      assertTimecardEditable(card, "explain the variance on");
      if (card.varianceHours === null) {
        throw conflict(
          `Timecard ${card.reference} has no computed variance to explain — there is no usable ` +
            "site-access record for this worker on this date.",
        );
      }
      await app.db
        .update(timecards)
        .set({ varianceExplanation: body.varianceExplanation, updatedAt: nowIso() })
        .where(eq(timecards.id, timecardId));
      await ledgerTimecards(app.db, req, "update", "timecard", timecardId, {
        reference: card.reference,
        varianceHours: card.varianceHours,
        varianceExplanation: body.varianceExplanation,
      });
      return timecardView(timecardId, companyId, projectId);
    },
  );

  /* ------------------------ lock and export ------------------------ */

  app.post(
    "/projects/:projectId/timecards/:timecardId/lock",
    { preHandler: gates.admin },
    async (req) => {
      const { timecardId } = req.params as { timecardId: string };
      const body = lockSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const card = await fetchTimecard(app.db, timecardId, companyId, projectId);
      assertTransition(card.status, ["approved"], "timecard", "lock");
      await app.db
        .update(timecards)
        .set({
          status: "locked",
          lockedAt: nowIso(),
          detail: { ...(card.detail ?? {}), lockNote: body.note ?? null },
          updatedAt: nowIso(),
        })
        .where(eq(timecards.id, timecardId));
      await ledgerTimecards(app.db, req, "state_change", "timecard", timecardId, {
        reference: card.reference,
        from: card.status,
        to: "locked",
        note: body.note ?? null,
      });
      return timecardView(timecardId, companyId, projectId);
    },
  );

  /**
   * The sanctioned correction to a frozen card.
   *
   * The platform holds exactly one card per (worker, day, shift) — that
   * uniqueness is what makes "how many hours did this person claim on
   * Tuesday" answerable at all. So a correction to a card payroll has already
   * drawn from is booked the way payroll actually books one: as a DATED
   * ADJUSTMENT on a later day that points back at the original through
   * `revisesTimecardId`. The original stays exactly as it was paid, and both
   * figures stay readable next to each other.
   */
  app.post(
    "/projects/:projectId/timecards/:timecardId/revise",
    { preHandler: gates.standard },
    async (req, reply) => {
      const { timecardId } = req.params as { timecardId: string };
      const body = reviseSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const original = await fetchTimecard(app.db, timecardId, companyId, projectId);
      if (original.status === "revised") {
        const superseded = (original.detail as { revisedBy?: { reference?: string } } | null)?.revisedBy;
        throw conflict(
          `Timecard ${original.reference} has already been corrected by adjustment ` +
            `${superseded?.reference ?? "another card"}. Adjust that card instead — a chain of ` +
            "corrections stays readable, a fan of them does not.",
        );
      }
      if (original.status === "void") {
        throw conflict(`Timecard ${original.reference} is void; there is nothing to correct.`);
      }
      if (!["locked", "exported", "approved"].includes(original.status)) {
        throw conflict(
          `Timecard ${original.reference} is "${original.status}" and can still be edited directly. ` +
            "An adjustment card is for corrections to hours that are already locked, exported or " +
            "approved.",
        );
      }
      const worker = await requireWorker(app.db, original.workerId, companyId, projectId);
      const adjustmentDate = body.adjustmentDate ?? todayIso();
      if (adjustmentDate < original.workDate) {
        throw badRequest(
          `An adjustment cannot be dated ${adjustmentDate}, before the ${original.workDate} card it ` +
            "corrects.",
        );
      }
      const shift = body.shift ?? original.shift;
      const clash = await app.db
        .select({ reference: timecards.reference })
        .from(timecards)
        .where(
          and(
            eq(timecards.workerId, original.workerId),
            eq(timecards.workDate, adjustmentDate),
            eq(timecards.shift, shift),
          ),
        )
        .limit(1);
      if (clash[0]) {
        throw conflict(
          `${worker.reference} already has timecard ${clash[0].reference} on ${adjustmentDate} ` +
            `(${shift} shift), and the platform holds one card per worker, day and shift. Book the ` +
            "adjustment on another date, or on another shift.",
        );
      }

      const crew = original.crewId
        ? await fetchCrew(app.db, original.crewId, companyId, projectId)
        : null;
      const cfg = crewConfig(crew);
      const prior = await priorWeekLadder(projectId, original.workerId, adjustmentDate, cfg.weekStartsOn);
      const resolved = resolveHours(body, crew, prior.hours);
      const rates = resolveRates(
        {
          hourlyRate: body.hourlyRate === undefined ? original.hourlyRate : body.hourlyRate,
          overtimeRate: body.overtimeRate === undefined ? original.overtimeRate : body.overtimeRate,
          doubleTimeRate:
            body.doubleTimeRate === undefined ? original.doubleTimeRate : body.doubleTimeRate,
          premiumRate: body.premiumRate === undefined ? original.premiumRate : body.premiumRate,
          burdenRate: body.burdenRate === undefined ? original.burdenRate : body.burdenRate,
          currency: body.currency ?? original.currency,
        },
        null,
        worker,
      );
      const cost = costHours(resolved.split, rates);
      const number = await nextRecordNumber(app.db, projectId, "timecard");
      const id = newId("tcd");
      const reference = `TC-${pad3(number)}`;

      await app.db.transaction(async (tx) => {
        await tx.insert(timecards).values({
          id,
          companyId,
          projectId,
          number,
          reference,
          workerId: original.workerId,
          crewId: original.crewId,
          vendorId: original.vendorId,
          workDate: adjustmentDate,
          shift,
          trade: original.trade,
          classification: original.classification,
          regularHours: resolved.split.regularHours,
          overtimeHours: resolved.split.overtimeHours,
          doubleTimeHours: resolved.split.doubleTimeHours,
          premiumHours: resolved.split.premiumHours,
          premiumKind: body.premiumKind ?? original.premiumKind,
          totalHours: resolved.split.totalHours,
          idleHours: round2(body.idleHours ?? 0),
          idleReason: body.idleReason ?? null,
          hourlyRate: rates.hourlyRate,
          overtimeRate: rates.overtimeRate,
          doubleTimeRate: rates.doubleTimeRate,
          premiumRate: rates.premiumRate,
          burdenRate: rates.burdenRate,
          totalCost: cost.value,
          currency: rates.currency,
          isBillable: original.isBillable,
          source: "manual",
          status: "draft",
          revisesTimecardId: original.id,
          locationId: original.locationId,
          notes: body.reason,
          detail: {
            adjustment: {
              revises: original.reference,
              originalWorkDate: original.workDate,
              originalTotalHours: original.totalHours,
              deltaHours: round2(resolved.split.totalHours - original.totalHours),
              reason: body.reason,
              note:
                "This is a dated payroll adjustment, not a re-issue. The card it corrects stays " +
                "exactly as payroll paid it.",
            },
            hourClassification: {
              method: resolved.method,
              workedHours: resolved.workedHours,
              rule: resolved.rule,
              note: resolved.note,
            },
            cost: { value: cost.value, reasons: cost.reasons, currency: cost.currency },
          },
          createdBy: actorId,
        });
        await tx
          .update(timecards)
          .set({
            status: "revised",
            detail: {
              ...(original.detail ?? {}),
              revisedBy: { timecardId: id, reference, adjustmentDate, reason: body.reason },
            },
            updatedAt: nowIso(),
          })
          .where(eq(timecards.id, original.id));
      });

      if (body.allocations && body.allocations.length > 0) {
        await writeAllocations(app.db, {
          companyId,
          projectId,
          timecardId: id,
          reference,
          split: resolved.split,
          currency: rates.currency,
          rates,
          allocations: body.allocations,
        });
      }
      await ledgerTimecards(app.db, req, "create", "timecard_adjustment", id, {
        reference,
        revises: original.reference,
        revisesTimecardId: original.id,
        adjustmentDate,
        reason: body.reason,
        hours: resolved.split,
      });
      return reply.status(201).send({
        adjustment: await timecardView(id, companyId, projectId),
        original: await timecardView(original.id, companyId, projectId),
      });
    },
  );

  /* --------------------------- helpers ----------------------------- */

  async function recordApproval(args: {
    companyId: string;
    projectId: string;
    timecardId: string | null;
    batchId: string | null;
    level: number;
    approverId: string;
    approverRole: string | null;
    decision: string;
    comment: string | null;
    subjectWorkerId: string | null;
    isSelfApproval: boolean;
    delegatedFromId: string | null;
    signatureFileId: string | null;
    detail: Record<string, unknown>;
  }): Promise<string> {
    const id = newId("tap");
    await app.db.insert(timecardApprovals).values({
      id,
      companyId: args.companyId,
      projectId: args.projectId,
      timecardId: args.timecardId,
      batchId: args.batchId,
      level: args.level,
      approverId: args.approverId,
      approverRole: args.approverRole,
      decision: args.decision,
      decidedAt: nowIso(),
      comment: args.comment,
      subjectWorkerId: args.subjectWorkerId,
      isSelfApproval: args.isSelfApproval ? 1 : 0,
      delegatedFromId: args.delegatedFromId,
      escalatedToId: null,
      signatureFileId: args.signatureFileId,
      detail: args.detail,
    });
    return id;
  }


  /**
   * Under a WEEKLY rule, adding Tuesday changes what Wednesday costs. Every
   * still-editable card later in the same pay week is reclassified in date
   * order; approved, locked and exported cards are left exactly as they were
   * approved and are reported as skipped rather than silently diverging.
   */
  async function reclassifyWeek(
    projectId: string,
    companyId: string,
    workerId: string,
    workDate: string,
    weekStartsOn: number,
    actorId: string,
  ): Promise<
    Array<{ timecardId: string; reference: string; before: HourSplit; after: HourSplit; skipped?: string }>
  > {
    const start = weekStart(workDate, weekStartsOn);
    const end = addDays(start, 6);
    const week = await app.db
      .select()
      .from(timecards)
      .where(
        and(
          eq(timecards.projectId, projectId),
          eq(timecards.workerId, workerId),
          gte(timecards.workDate, start),
          lte(timecards.workDate, end),
          ne(timecards.status, "void"),
          ne(timecards.status, "revised"),
        ),
      )
      .orderBy(asc(timecards.workDate));
    const changes: Array<{
      timecardId: string;
      reference: string;
      before: HourSplit;
      after: HourSplit;
      skipped?: string;
    }> = [];
    let ladder = 0;
    for (const card of week) {
      const crew = card.crewId
        ? ((await app.db.select().from(crews).where(eq(crews.id, card.crewId)))[0] ?? null)
        : null;
      const rule = overtimeRuleOf(crew);
      const before = splitOf(card);
      if (rule.kind !== "weekly") {
        ladder += before.regularHours + before.overtimeHours + before.doubleTimeHours;
        continue;
      }
      const classified = classifyHours({
        workedHours: round2(before.totalHours),
        premiumHours: before.premiumHours,
        premiumKind: card.premiumKind as never,
        priorWeekLadderHours: ladder,
        rule,
      });
      if (classified.value === null) {
        ladder += before.regularHours + before.overtimeHours + before.doubleTimeHours;
        continue;
      }
      const after = classified.value;
      ladder += after.regularHours + after.overtimeHours + after.doubleTimeHours;
      const same =
        nearlyEqual(before.regularHours, after.regularHours) &&
        nearlyEqual(before.overtimeHours, after.overtimeHours) &&
        nearlyEqual(before.doubleTimeHours, after.doubleTimeHours);
      if (same) continue;
      if (!["draft", "rejected"].includes(card.status)) {
        changes.push({
          timecardId: card.id,
          reference: card.reference,
          before,
          after,
          skipped:
            `${card.reference} is "${card.status}" and was NOT reclassified. Its split was fixed ` +
            "when it was approved; reopening it is a decision for a person, not a side effect of " +
            "somebody entering another day.",
        });
        continue;
      }
      const rates = {
        hourlyRate: card.hourlyRate,
        overtimeRate: card.overtimeRate,
        doubleTimeRate: card.doubleTimeRate,
        premiumRate: card.premiumRate,
        burdenRate: card.burdenRate,
        currency: card.currency,
      };
      const cost = costHours(after, rates);
      await app.db
        .update(timecards)
        .set({
          regularHours: after.regularHours,
          overtimeHours: after.overtimeHours,
          doubleTimeHours: after.doubleTimeHours,
          premiumHours: after.premiumHours,
          totalHours: after.totalHours,
          totalCost: cost.value,
          detail: {
            ...(card.detail ?? {}),
            hourClassification: {
              method: "classified_from_worked_hours",
              workedHours: round2(before.totalHours),
              rule: classified.rule,
              note: classified.rule?.explanation ?? null,
              priorWeekLadderHours: ladder - (after.regularHours + after.overtimeHours + after.doubleTimeHours),
              weekStart: start,
              weekEnd: end,
              reclassifiedBecause:
                "A weekly overtime rule reprices the whole week when any day in it changes.",
            },
          },
          updatedAt: nowIso(),
        })
        .where(eq(timecards.id, card.id));
      // The coding must follow the split, so a reclassified card's
      // allocations no longer reconcile and are cleared rather than left
      // wrong. The card returns to "needs coding", which is honest.
      await app.db.delete(timecardAllocations).where(eq(timecardAllocations.timecardId, card.id));
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "update",
        objectType: "timecard",
        objectId: card.id,
        projectId,
        payload: {
          projectId,
          reference: card.reference,
          reclassified: { before, after },
          rule: rule.kind,
        },
        storePayload: true,
      });
      changes.push({ timecardId: card.id, reference: card.reference, before, after });
    }
    return changes;
  }
};

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

export function splitOf(card: TimecardRow): HourSplit {
  return {
    regularHours: card.regularHours,
    overtimeHours: card.overtimeHours,
    doubleTimeHours: card.doubleTimeHours,
    premiumHours: card.premiumHours,
    totalHours: card.totalHours,
  };
}

/**
 * Rates, in precedence order: what the caller sent, then the CREW MEMBERSHIP
 * (which is where a prevailing-wage classification's rate lives), then the
 * worker's own agreed rate from the register. Overtime and double-time rates
 * are derived from the membership's multipliers where they exist — and are
 * left NULL where they do not, because 1.5× is a convention, not a fact, and
 * `costHours` refuses rather than assuming it.
 */
export function resolveRates(
  body: {
    hourlyRate?: number | null | undefined;
    overtimeRate?: number | null | undefined;
    doubleTimeRate?: number | null | undefined;
    premiumRate?: number | null | undefined;
    burdenRate?: number | null | undefined;
    currency?: string | undefined;
  },
  member: typeof crewMembers.$inferSelect | null,
  worker: WorkerRow,
): {
  hourlyRate: number | null;
  overtimeRate: number | null;
  doubleTimeRate: number | null;
  premiumRate: number | null;
  burdenRate: number | null;
  currency: string;
} {
  const hourlyRate = body.hourlyRate ?? member?.hourlyRate ?? null;
  const otRate =
    body.overtimeRate ??
    (hourlyRate !== null && member?.overtimeMultiplier != null
      ? round2(hourlyRate * member.overtimeMultiplier)
      : null);
  const dtRate =
    body.doubleTimeRate ??
    (hourlyRate !== null && member?.doubleTimeMultiplier != null
      ? round2(hourlyRate * member.doubleTimeMultiplier)
      : null);
  return {
    hourlyRate,
    overtimeRate: otRate,
    doubleTimeRate: dtRate,
    premiumRate: body.premiumRate ?? null,
    burdenRate: body.burdenRate ?? member?.burdenRate ?? null,
    currency: (body.currency ?? member?.currency ?? worker.currency ?? "USD").toUpperCase(),
  };
}

/**
 * Attach access records that landed after the card did, and recompute the
 * variance. Idempotent by construction — it only touches editable cards
 * that carry no link yet, so a second run finds nothing.
 */
export async function attachAccessLinks(
  db: Db,
  companyId: string,
  projectId: string,
  workerIds?: string[],
): Promise<{ examined: number; linked: number; skippedAdjustments: number }> {
  const clauses = [
    eq(timecards.companyId, companyId),
    eq(timecards.projectId, projectId),
    isNull(timecards.siteAccessRecordId),
    inArray(timecards.status, ["draft", "submitted", "rejected"]),
    /*
     * ADJUSTMENT CARDS ARE NEVER MATCHED BY DATE.
     *
     * `revise` books a correction on the ADJUSTMENT date, not the date the
     * hours were worked. Matching it against that day's access record
     * compared last Monday's corrected 10 hours with today's 8 hours on
     * site, produced a +2h variance out of nothing, and then the approve
     * route refused the card until somebody "explained" a variance that did
     * not exist.
     */
    isNull(timecards.revisesTimecardId),
  ];
  if (workerIds && workerIds.length > 0) {
    clauses.push(inArray(timecards.workerId, workerIds));
  }
  const orphans = await db
    .select()
    .from(timecards)
    .where(and(...clauses))
    .limit(500);
  if (orphans.length === 0) return { examined: 0, linked: 0, skippedAdjustments: 0 };
  const access = await db
    .select()
    .from(siteAccessRecords)
    .where(
      and(
        eq(siteAccessRecords.projectId, projectId),
        inArray(
          siteAccessRecords.workerId,
          [...new Set(orphans.map((o) => o.workerId))],
        ),
      ),
    );
  const byKey = new Map(access.map((a) => [`${a.workerId}|${a.accessDate}`, a]));
  /** the crews these cards belong to, for their configured tolerance */
  const crewIds = [...new Set(orphans.map((o) => o.crewId).filter((v): v is string => !!v))];
  const crewRows = crewIds.length
    ? await db.select().from(crews).where(inArray(crews.id, crewIds))
    : [];
  const crewById = new Map(crewRows.map((c) => [c.id, c] as const));
  let linked = 0;
  for (const card of orphans) {
    const hit = byKey.get(`${card.workerId}|${card.workDate}`);
    if (!hit) continue;
    // The crew's own tolerance, not the platform default: a crew that
    // configured 1.5h had its cards judged at 0.5h by this path alone.
    const tolerance = crewConfig(card.crewId ? (crewById.get(card.crewId) ?? null) : null)
      .varianceToleranceHours;
    const variance = accessVariance({
      claimedHours: card.totalHours,
      hasAccessRecord: true,
      accessHoursOnSite: hit.hoursOnSite,
      firstIn: hit.firstIn,
      lastOut: hit.lastOut,
      explanation: card.varianceExplanation,
      toleranceHours: tolerance,
    });
    await db
      .update(timecards)
      .set({
        siteAccessRecordId: hit.id,
        accessHoursOnSite: variance.accessHours,
        varianceHours: variance.value,
        detail: {
          ...(card.detail ?? {}),
          variance: {
            value: variance.value,
            accessHours: variance.accessHours,
            accessHoursSource: variance.accessHoursSource,
            withinTolerance: variance.withinTolerance,
            toleranceHours: variance.toleranceHours,
            reasons: variance.reasons,
            linkedBy: "lazy_sweep",
          },
        },
        updatedAt: nowIso(),
      })
      .where(eq(timecards.id, card.id));
    linked += 1;
  }
  return { examined: orphans.length, linked, skippedAdjustments: 0 };
}

