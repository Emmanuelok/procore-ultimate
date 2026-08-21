import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { boqItems, boqs, paymentCertificates, valuations, variations } from "@constructos/db";
import { round2 } from "./shared.js";

/**
 * Project commercial position — the CVR seed (spec #184):
 *   forecastFinal = boqTotal + variationsAgreed + variationsPending.
 */
export const summaryRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];

  app.get("/projects/:projectId/commercial/summary", { preHandler: readGate }, async (req) => {
    // contract value: leaf item amounts across issued/agreed BoQs
    const [boqRow] = await app.db
      .select({
        total: sql<number>`coalesce(sum(coalesce(${boqItems.amount}, 0)), 0)`,
      })
      .from(boqItems)
      .innerJoin(boqs, eq(boqs.id, boqItems.boqId))
      .where(
        and(
          eq(boqs.companyId, req.companyId!),
          eq(boqs.projectId, req.projectId!),
          inArray(boqs.status, ["issued", "agreed"]),
          eq(boqItems.level, "item"),
        ),
      );
    const boqTotal = round2(Number(boqRow?.total ?? 0));

    // certified position + retention balance (retention on a certificate is
    // cumulative, so the held balance is the latest certificate per BoQ)
    const certs = await app.db
      .select({
        boqId: valuations.boqId,
        number: paymentCertificates.number,
        netCertified: paymentCertificates.netCertified,
        retentionHeld: paymentCertificates.retentionHeld,
      })
      .from(paymentCertificates)
      .innerJoin(valuations, eq(valuations.id, paymentCertificates.valuationId))
      .where(
        and(
          eq(paymentCertificates.companyId, req.companyId!),
          eq(paymentCertificates.projectId, req.projectId!),
          ne(paymentCertificates.status, "withdrawn"),
        ),
      );
    let certifiedToDate = 0;
    const latestByBoq = new Map<string, { number: number; retentionHeld: number }>();
    for (const c of certs) {
      certifiedToDate += c.netCertified;
      const latest = latestByBoq.get(c.boqId);
      if (!latest || c.number > latest.number) {
        latestByBoq.set(c.boqId, { number: c.number, retentionHeld: c.retentionHeld });
      }
    }
    const retentionHeld = round2(
      [...latestByBoq.values()].reduce((s, c) => s + c.retentionHeld, 0),
    );

    // variation register position
    const vars = await app.db
      .select({
        status: variations.status,
        agreedValue: variations.agreedValue,
        costEstimate: variations.costEstimate,
      })
      .from(variations)
      .where(
        and(eq(variations.companyId, req.companyId!), eq(variations.projectId, req.projectId!)),
      );
    let variationsAgreed = 0;
    let variationsPending = 0;
    for (const v of vars) {
      if (v.status === "agreed") variationsAgreed += v.agreedValue ?? 0;
      else if (v.status === "proposed" || v.status === "instructed" || v.status === "valued") {
        variationsPending += v.agreedValue ?? v.costEstimate ?? 0;
      }
    }
    variationsAgreed = round2(variationsAgreed);
    variationsPending = round2(variationsPending);

    return {
      boqTotal,
      certifiedToDate: round2(certifiedToDate),
      retentionHeld,
      variationsAgreed,
      variationsPending,
      forecastFinal: round2(boqTotal + variationsAgreed + variationsPending),
    };
  });
};
