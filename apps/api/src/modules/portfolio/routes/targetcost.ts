/**
 * TARGET COST, PAIN/GAIN AND THE ALLIANCE MODEL.
 * Spec Vol II Domain Z #1061 (multi-party alliance pain/gain share) and #1062
 * (target cost contract gain-share computation); Vol I §7 #788.
 *
 * Project-scoped: a target-cost model prices one project's contract.
 *
 * The arithmetic lives entirely in `paingain.ts` and is pure. These routes do
 * three things and nothing else:
 *   · validate the model (bands that overlap, leave gaps or run backwards are
 *     refused with every problem listed, not just the first);
 *   · compute the current position on demand, including its basis and its
 *     warnings, so the page can show why the number is what it is;
 *   · freeze a calculation into `pain_gain_calculations` when someone needs a
 *     defensible snapshot — a final-account figure that moves when the
 *     forecast moves is not a settlement.
 *
 * Sign convention, restated so nothing on the wire is ambiguous: a POSITIVE
 * variance is an overrun (pain); `contractorShare` is always a non-negative
 * magnitude; `contractorAdjustment` is the signed movement in what the
 * contractor is paid.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { painGainCalculations, targetCostContracts } from "@constructos/db";
import { PAIN_GAIN_MECHANISMS, TARGET_COST_STATUSES } from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  computePainGain,
  PainGainError,
  parseParticipants,
  parseShareBands,
  validateShareBands,
  type PainGainOutput,
} from "../paingain.js";
import {
  buildGates,
  currencySchema,
  idSchema,
  ledger,
  nonNegativeMoneySchema,
  nowISO,
  patchSchemaOf,
  patchSet,
} from "../shared.js";

const bandSchema = z.object({
  fromPercent: z.number().finite(),
  toPercent: z.number().finite().nullable().optional(),
  contractorSharePercent: z.number().finite().min(0).max(100),
});

const participantSchema = z.object({
  name: z.string().min(1).max(200),
  partyId: idSchema.nullable().optional(),
  sharePercent: z.number().finite().min(0).max(100),
});

const targetCostCreate = z.object({
  name: z.string().min(1).max(200),
  contractReference: z.string().max(200).nullable().optional(),
  isAlliance: z.boolean().default(false),
  currency: currencySchema,
  baseTargetCost: nonNegativeMoneySchema,
  targetAdjustments: z.number().finite().default(0),
  actualDefinedCost: nonNegativeMoneySchema.default(0),
  forecastDefinedCost: nonNegativeMoneySchema.nullable().optional(),
  feePercent: z.number().finite().min(0).max(100).default(0),
  mechanism: z.enum(PAIN_GAIN_MECHANISMS).default("banded_share"),
  shareBands: z.array(bandSchema).min(1).max(30),
  painCap: nonNegativeMoneySchema.nullable().optional(),
  gainCap: nonNegativeMoneySchema.nullable().optional(),
  participants: z.array(participantSchema).max(30).default([]),
  notes: z.string().max(8000).nullable().optional(),
});

const targetCostPatch = patchSchemaOf(targetCostCreate.omit({ currency: true }));

const calculateSchema = z.object({
  basis: z.enum(["forecast", "actual"]).default("forecast"),
  /** a one-off outturn to test, without writing it to the contract */
  outturnOverride: nonNegativeMoneySchema.nullable().optional(),
  freeze: z.boolean().default(false),
  note: z.string().max(2000).nullable().optional(),
});

export const targetCostRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate, adminGate } = buildGates(app);

  async function fetchContract(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(targetCostContracts)
      .where(
        and(
          eq(targetCostContracts.id, id),
          eq(targetCostContracts.companyId, companyId),
          eq(targetCostContracts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Target cost contract not found on this project");
    return row;
  }

  /** Validate a band set and refuse with every problem at once. */
  function assertBands(
    bands: z.infer<typeof bandSchema>[],
    mechanism: (typeof PAIN_GAIN_MECHANISMS)[number],
  ) {
    let parsed;
    try {
      parsed = parseShareBands(bands);
    } catch (err) {
      if (err instanceof PainGainError) throw badRequest(err.message);
      throw err;
    }
    const problems = validateShareBands(parsed, mechanism);
    /* A gap or an overlap makes the apportionment ambiguous, which is fatal;
       "more bands than a flat mechanism uses" is a warning the engine
       already reports on every computation, so it does not block. */
    const fatal = problems.filter((p) => p.includes("overlap") || p.includes("gap") || p.includes("open-ended"));
    if (fatal.length > 0) {
      throw badRequest(`The share bands do not describe one continuous apportionment: ${fatal.join("; ")}`);
    }
    return { parsed, problems };
  }

  function compute(
    row: typeof targetCostContracts.$inferSelect,
    options: { basis: "forecast" | "actual"; outturnOverride?: number | null },
  ): { output: PainGainOutput; outturn: number } {
    const outturn =
      options.outturnOverride ??
      (options.basis === "actual"
        ? row.actualDefinedCost
        : (row.forecastDefinedCost ?? row.actualDefinedCost));
    let bands;
    let participants;
    try {
      bands = parseShareBands(row.shareBands);
      participants = parseParticipants(row.participants);
    } catch (err) {
      if (err instanceof PainGainError) {
        throw badRequest(`This target-cost model cannot be computed: ${err.message}`);
      }
      throw err;
    }
    return {
      outturn,
      output: computePainGain({
        currency: row.currency,
        baseTargetCost: row.baseTargetCost,
        targetAdjustments: row.targetAdjustments,
        outturnCost: outturn,
        feePercent: row.feePercent,
        mechanism: row.mechanism as (typeof PAIN_GAIN_MECHANISMS)[number],
        shareBands: bands,
        painCap: row.painCap,
        gainCap: row.gainCap,
        participants,
      }),
    };
  }

  /* ================================================================ */
  /* Register                                                          */
  /* ================================================================ */

  app.get(
    "/projects/:projectId/portfolio/target-costs",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({ status: z.enum(TARGET_COST_STATUSES).optional() })
        .parse(req.query);
      const clauses: SQL[] = [
        eq(targetCostContracts.companyId, req.companyId!),
        eq(targetCostContracts.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(targetCostContracts.status, q.status));
      const where = and(...clauses);
      const [totalRow] = await app.db.select({ n: count() }).from(targetCostContracts).where(where);
      const rows = await app.db
        .select()
        .from(targetCostContracts)
        .where(where)
        .orderBy(asc(targetCostContracts.name))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const items = rows.map((r) => {
        try {
          const { output } = compute(r, { basis: "forecast" });
          return { ...r, position: output };
        } catch {
          /* One malformed model must not blank the register; it reports
             itself as uncomputable and the rest of the page still works. */
          return {
            ...r,
            position: null,
            positionReason: "The share bands stored on this contract are not a valid apportionment.",
          };
        }
      });
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.post(
    "/projects/:projectId/portfolio/target-costs",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = targetCostCreate.parse(req.body);
      const { problems } = assertBands(body.shareBands, body.mechanism);
      try {
        parseParticipants(body.participants);
      } catch (err) {
        if (err instanceof PainGainError) throw badRequest(err.message);
        throw err;
      }
      if (body.isAlliance && body.participants.length === 0) {
        throw badRequest(
          "An alliance model needs its participants and their shares; without them the contractor side of pain/gain cannot be split.",
        );
      }
      const id = newId("tcc");
      await app.db.insert(targetCostContracts).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        contractReference: body.contractReference ?? null,
        isAlliance: body.isAlliance ? 1 : 0,
        currency: body.currency,
        baseTargetCost: body.baseTargetCost,
        targetAdjustments: body.targetAdjustments,
        actualDefinedCost: body.actualDefinedCost,
        forecastDefinedCost: body.forecastDefinedCost ?? null,
        feePercent: body.feePercent,
        mechanism: body.mechanism,
        shareBands: body.shareBands,
        painCap: body.painCap ?? null,
        gainCap: body.gainCap ?? null,
        participants: body.participants,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "target_cost_contract",
        objectId: id,
        payload: {
          name: body.name,
          currency: body.currency,
          baseTargetCost: body.baseTargetCost,
          mechanism: body.mechanism,
          bands: body.shareBands.length,
          isAlliance: body.isAlliance,
        },
        storePayload: true,
      });
      const row = await fetchContract(id, req.companyId!, req.projectId!);
      const { output } = compute(row, { basis: "forecast" });
      return reply.status(201).send({ ...row, position: output, modelWarnings: problems });
    },
  );

  app.get(
    "/projects/:projectId/portfolio/target-costs/:targetCostId",
    { preHandler: readGate },
    async (req) => {
      const { targetCostId } = req.params as { targetCostId: string };
      const q = z.object({ basis: z.enum(["forecast", "actual"]).default("forecast") }).parse(req.query);
      const row = await fetchContract(targetCostId, req.companyId!, req.projectId!);
      const calculations = await app.db
        .select()
        .from(painGainCalculations)
        .where(
          and(
            eq(painGainCalculations.companyId, req.companyId!),
            eq(painGainCalculations.targetCostId, targetCostId),
          ),
        )
        .orderBy(desc(painGainCalculations.createdAt))
        .limit(20);
      let position: PainGainOutput | null = null;
      let positionReason: string | null = null;
      try {
        position = compute(row, { basis: q.basis }).output;
      } catch (err) {
        positionReason =
          err instanceof Error ? err.message : "The stored model could not be computed.";
      }
      return {
        ...row,
        basis: q.basis,
        position,
        positionReason,
        calculations,
        /* Both sides, so the page can show the spread between what has been
           incurred and what is forecast without a second request. */
        actualPosition: (() => {
          try {
            return compute(row, { basis: "actual" }).output;
          } catch {
            return null;
          }
        })(),
      };
    },
  );

  app.patch(
    "/projects/:projectId/portfolio/target-costs/:targetCostId",
    { preHandler: standardGate },
    async (req) => {
      const { targetCostId } = req.params as { targetCostId: string };
      const body = targetCostPatch.parse(req.body);
      const row = await fetchContract(targetCostId, req.companyId!, req.projectId!);
      if (row.status === "closed") {
        throw conflict("This target-cost contract is closed; its final account is a settled record.");
      }
      const mechanism = body.mechanism ?? (row.mechanism as (typeof PAIN_GAIN_MECHANISMS)[number]);
      let problems: string[] = [];
      if (body.shareBands) {
        problems = assertBands(body.shareBands, mechanism).problems;
      }
      if (body.participants) {
        try {
          parseParticipants(body.participants);
        } catch (err) {
          if (err instanceof PainGainError) throw badRequest(err.message);
          throw err;
        }
      }
      const set = patchSet(body as Record<string, unknown>);
      if (body.isAlliance !== undefined) set["isAlliance"] = body.isAlliance ? 1 : 0;
      await app.db
        .update(targetCostContracts)
        .set(set)
        .where(eq(targetCostContracts.id, targetCostId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "target_cost_contract",
        objectId: targetCostId,
        payload: {
          changed: Object.keys(body),
          baseTargetCost:
            body.baseTargetCost !== undefined
              ? { from: row.baseTargetCost, to: body.baseTargetCost }
              : undefined,
          targetAdjustments:
            body.targetAdjustments !== undefined
              ? { from: row.targetAdjustments, to: body.targetAdjustments }
              : undefined,
        },
        storePayload:
          body.shareBands !== undefined ||
          body.baseTargetCost !== undefined ||
          body.targetAdjustments !== undefined,
      });
      const updated = await fetchContract(targetCostId, req.companyId!, req.projectId!);
      return { ...updated, position: compute(updated, { basis: "forecast" }).output, modelWarnings: problems };
    },
  );

  const statusSchema = z.object({
    status: z.enum(TARGET_COST_STATUSES),
    note: z.string().max(4000).nullable().optional(),
  });

  app.post(
    "/projects/:projectId/portfolio/target-costs/:targetCostId/status",
    { preHandler: standardGate },
    async (req) => {
      const { targetCostId } = req.params as { targetCostId: string };
      const body = statusSchema.parse(req.body);
      const row = await fetchContract(targetCostId, req.companyId!, req.projectId!);
      if (row.status === body.status) return row;
      if (row.status === "closed") {
        throw conflict("A closed target-cost contract cannot be reopened.");
      }
      if (body.status === "closed") {
        const [frozen] = await app.db
          .select({ n: count() })
          .from(painGainCalculations)
          .where(
            and(
              eq(painGainCalculations.companyId, req.companyId!),
              eq(painGainCalculations.targetCostId, targetCostId),
            ),
          );
        if (Number(frozen?.n ?? 0) === 0) {
          throw conflict(
            "Close the contract only once a pain/gain calculation has been frozen; a settlement with no recorded computation cannot be defended.",
          );
        }
        if (row.createdBy === req.user!.id) {
          throw forbidden(
            "The person who set up the target-cost model cannot close its final account; the settlement needs a second pair of eyes.",
          );
        }
      }
      await app.db
        .update(targetCostContracts)
        .set({ status: body.status, updatedAt: nowISO() })
        .where(eq(targetCostContracts.id, targetCostId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "target_cost_contract",
        objectId: targetCostId,
        payload: { from: row.status, to: body.status, note: body.note ?? null },
        storePayload: true,
      });
      return fetchContract(targetCostId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Compute the pain/gain position (#1062). With `freeze: true` the result is
   * written to `pain_gain_calculations` with every input that produced it, so
   * the figure a settlement rests on cannot drift under it.
   */
  app.post(
    "/projects/:projectId/portfolio/target-costs/:targetCostId/calculate",
    { preHandler: standardGate },
    async (req) => {
      const { targetCostId } = req.params as { targetCostId: string };
      const body = calculateSchema.parse(req.body ?? {});
      const row = await fetchContract(targetCostId, req.companyId!, req.projectId!);
      const { output, outturn } = compute(row, {
        basis: body.basis,
        outturnOverride: body.outturnOverride ?? null,
      });
      if (!output.computable) {
        return {
          targetCostId,
          basis: body.basis,
          frozen: false,
          result: output,
          reason:
            "The position could not be computed, so nothing was frozen. " + output.reasons.join(" "),
        };
      }
      if (!body.freeze) {
        return { targetCostId, basis: body.basis, frozen: false, result: output };
      }
      const id = newId("pgc");
      await app.db.insert(painGainCalculations).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        targetCostId,
        basis: body.basis,
        currency: row.currency,
        adjustedTarget: output.adjustedTarget,
        outturnCost: output.outturnCost,
        variance: output.variance,
        contractorShare: output.contractorShare ?? 0,
        clientShare: output.clientShare ?? 0,
        detail: {
          inputs: {
            baseTargetCost: row.baseTargetCost,
            targetAdjustments: row.targetAdjustments,
            outturnCost: outturn,
            feePercent: row.feePercent,
            mechanism: row.mechanism,
            shareBands: row.shareBands,
            painCap: row.painCap,
            gainCap: row.gainCap,
            participants: row.participants,
            outturnOverride: body.outturnOverride ?? null,
          },
          output,
          note: body.note ?? null,
        },
        computedBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "pain_gain_calculation",
        objectId: id,
        payload: {
          targetCostId,
          basis: body.basis,
          adjustedTarget: output.adjustedTarget,
          outturnCost: output.outturnCost,
          variance: output.variance,
          side: output.side,
          contractorShare: output.contractorShare,
          clientShare: output.clientShare,
          capApplied: output.capApplied,
        },
        storePayload: true,
      });
      const [saved] = await app.db
        .select()
        .from(painGainCalculations)
        .where(eq(painGainCalculations.id, id))
        .limit(1);
      return { targetCostId, basis: body.basis, frozen: true, calculation: saved, result: output };
    },
  );

  app.get(
    "/projects/:projectId/portfolio/target-costs/:targetCostId/calculations",
    { preHandler: readGate },
    async (req) => {
      const { targetCostId } = req.params as { targetCostId: string };
      const q = pageQuerySchema.parse(req.query);
      await fetchContract(targetCostId, req.companyId!, req.projectId!);
      const where = and(
        eq(painGainCalculations.companyId, req.companyId!),
        eq(painGainCalculations.targetCostId, targetCostId),
      );
      const [totalRow] = await app.db.select({ n: count() }).from(painGainCalculations).where(where);
      const items = await app.db
        .select()
        .from(painGainCalculations)
        .where(where)
        .orderBy(desc(painGainCalculations.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.delete(
    "/projects/:projectId/portfolio/target-costs/:targetCostId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { targetCostId } = req.params as { targetCostId: string };
      const row = await fetchContract(targetCostId, req.companyId!, req.projectId!);
      if (row.status !== "draft") {
        throw conflict(
          `This model is ${row.status.replace(/_/g, " ")} and is part of the commercial record; close it rather than deleting it.`,
        );
      }
      await app.db.delete(targetCostContracts).where(eq(targetCostContracts.id, targetCostId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "target_cost_contract",
        objectId: targetCostId,
        payload: { name: row.name, baseTargetCost: row.baseTargetCost, currency: row.currency },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );
};
