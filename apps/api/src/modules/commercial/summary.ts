import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  boqItems,
  boqs,
  contracts,
  dayworkSheets,
  paymentCertificates,
  provisionalSums,
  remeasurements,
  valuations,
  variations,
} from "@constructos/db";
import { round2, todayISO } from "./shared.js";

interface CurrencyPosition {
  currency: string;
  boqTotal: number;
  certifiedToDate: number;
  paidToDate: number;
  retentionHeld: number;
  variationsAgreed: number;
  variationsPending: number;
  forecastFinal: number;
  boqCount: number;
}

function emptyPosition(currency: string): CurrencyPosition {
  return {
    currency,
    boqTotal: 0,
    certifiedToDate: 0,
    paidToDate: 0,
    retentionHeld: 0,
    variationsAgreed: 0,
    variationsPending: 0,
    forecastFinal: 0,
    boqCount: 0,
  };
}

/**
 * Project commercial position — the CVR seed (spec #184), bucketed BY CURRENCY.
 *
 * The first cut summed BQ item amounts, certificates and variations across
 * bills in different currencies and labelled the result with the first bill's
 * currency, so a project with a GBP bill of 1,000,000 and an AED bill of
 * 4,700,000 reported "£5,700,000". Money in two currencies is two numbers.
 * `byCurrency` is always the truth; the flat fields are populated only when the
 * project has exactly one currency, and are null otherwise with `reasons`
 * saying why — never a fabricated total.
 */
export const summaryRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];

  app.get("/projects/:projectId/commercial/summary", { preHandler: readGate }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;

    const projectBoqs = await app.db
      .select()
      .from(boqs)
      .where(and(eq(boqs.companyId, companyId), eq(boqs.projectId, projectId)));
    const positions = new Map<string, CurrencyPosition>();
    const currencyOf = new Map<string, string>();
    const bump = (currency: string): CurrencyPosition => {
      let p = positions.get(currency);
      if (!p) {
        p = emptyPosition(currency);
        positions.set(currency, p);
      }
      return p;
    };
    for (const boq of projectBoqs) {
      currencyOf.set(boq.id, boq.currency);
      bump(boq.currency).boqCount += 1;
    }

    // contract value: leaf item amounts across issued/agreed bills
    const priced = projectBoqs.filter((b) => b.status === "issued" || b.status === "agreed");
    if (priced.length > 0) {
      const rows = await app.db
        .select({ boqId: boqItems.boqId, amount: boqItems.amount, level: boqItems.level })
        .from(boqItems)
        .where(inArray(boqItems.boqId, priced.map((b) => b.id)));
      for (const row of rows) {
        if (row.level !== "item") continue;
        const currency = currencyOf.get(row.boqId);
        if (!currency) continue;
        bump(currency).boqTotal += row.amount ?? 0;
      }
    }

    // certified / paid position + retention balance (retention on a certificate
    // is cumulative, so the held balance is the latest certificate per bill)
    const certs = await app.db
      .select({
        boqId: valuations.boqId,
        number: paymentCertificates.number,
        netCertified: paymentCertificates.netCertified,
        retentionHeld: paymentCertificates.retentionHeld,
        status: paymentCertificates.status,
        paidAmount: paymentCertificates.paidAmount,
        currency: paymentCertificates.currency,
      })
      .from(paymentCertificates)
      .innerJoin(valuations, eq(valuations.id, paymentCertificates.valuationId))
      .where(
        and(
          eq(paymentCertificates.companyId, companyId),
          eq(paymentCertificates.projectId, projectId),
          ne(paymentCertificates.status, "withdrawn"),
        ),
      );
    const latestByBoq = new Map<string, { number: number; retentionHeld: number; currency: string }>();
    for (const c of certs) {
      const currency = currencyOf.get(c.boqId) ?? c.currency;
      const p = bump(currency);
      p.certifiedToDate += c.netCertified;
      if (c.status === "paid") p.paidToDate += c.paidAmount ?? c.netCertified;
      const latest = latestByBoq.get(c.boqId);
      if (!latest || c.number > latest.number) {
        latestByBoq.set(c.boqId, { number: c.number, retentionHeld: c.retentionHeld, currency });
      }
    }
    for (const latest of latestByBoq.values()) {
      bump(latest.currency).retentionHeld += latest.retentionHeld;
    }

    // variation register position, in each variation's own currency
    const vars = await app.db
      .select({
        status: variations.status,
        currency: variations.currency,
        agreedValue: variations.agreedValue,
        costEstimate: variations.costEstimate,
      })
      .from(variations)
      .where(and(eq(variations.companyId, companyId), eq(variations.projectId, projectId)));
    for (const v of vars) {
      const p = bump(v.currency);
      if (v.status === "agreed") p.variationsAgreed += v.agreedValue ?? 0;
      else if (v.status === "proposed" || v.status === "instructed" || v.status === "valued") {
        p.variationsPending += v.agreedValue ?? v.costEstimate ?? 0;
      }
    }

    const byCurrency = [...positions.values()]
      .map((p) => {
        const boqTotal = round2(p.boqTotal);
        const variationsAgreed = round2(p.variationsAgreed);
        const variationsPending = round2(p.variationsPending);
        return {
          ...p,
          boqTotal,
          certifiedToDate: round2(p.certifiedToDate),
          paidToDate: round2(p.paidToDate),
          retentionHeld: round2(p.retentionHeld),
          variationsAgreed,
          variationsPending,
          forecastFinal: round2(boqTotal + variationsAgreed + variationsPending),
        };
      })
      .sort((a, b) => b.forecastFinal - a.forecastFinal);

    const single = byCurrency.length === 1 ? byCurrency[0]! : null;
    const reasons =
      byCurrency.length > 1
        ? [
            `This project holds commercial records in ${byCurrency.length} currencies (${byCurrency
              .map((c) => c.currency)
              .join(", ")}); totals are reported per currency and are not added together.`,
          ]
        : byCurrency.length === 0
          ? ["No bills of quantities exist on this project yet."]
          : [];

    return {
      currency: single?.currency ?? null,
      byCurrency,
      reasons,
      // flat fields stay for single-currency projects, which is nearly all
      boqTotal: single?.boqTotal ?? null,
      certifiedToDate: single?.certifiedToDate ?? null,
      paidToDate: single?.paidToDate ?? null,
      retentionHeld: single?.retentionHeld ?? null,
      variationsAgreed: single?.variationsAgreed ?? null,
      variationsPending: single?.variationsPending ?? null,
      forecastFinal: single?.forecastFinal ?? null,
    };
  });

  /**
   * Health inputs for the intelligence layer (contract 3.5). Counts and
   * ratios only — no money is summed across currencies here either; the
   * money-shaped metrics are expressed as percentages.
   */
  app.get(
    "/projects/:projectId/commercial/health-inputs",
    { preHandler: readGate },
    async (req) => {
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const today = todayISO();
      const reasons: string[] = [];
      const metrics: Record<string, number | null> = {};

      const projectBoqs = await app.db
        .select({ id: boqs.id, currency: boqs.currency, status: boqs.status })
        .from(boqs)
        .where(and(eq(boqs.companyId, companyId), eq(boqs.projectId, projectId)));
      metrics["boqs"] = projectBoqs.length;
      const currencies = new Set(projectBoqs.map((b) => b.currency));

      const vars = await app.db
        .select({
          status: variations.status,
          currency: variations.currency,
          agreedValue: variations.agreedValue,
          costEstimate: variations.costEstimate,
        })
        .from(variations)
        .where(and(eq(variations.companyId, companyId), eq(variations.projectId, projectId)));
      metrics["variationsOpen"] = vars.filter(
        (v) => v.status === "proposed" || v.status === "instructed" || v.status === "valued",
      ).length;
      metrics["variationsAgreed"] = vars.filter((v) => v.status === "agreed").length;

      const certs = await app.db
        .select({
          status: paymentCertificates.status,
          dueDate: paymentCertificates.dueDate,
          variance: paymentCertificates.varianceFromApplication,
        })
        .from(paymentCertificates)
        .where(
          and(
            eq(paymentCertificates.companyId, companyId),
            eq(paymentCertificates.projectId, projectId),
          ),
        );
      metrics["certificatesIssued"] = certs.length;
      metrics["certificatesOverdue"] = certs.filter(
        (c) => c.status === "issued" && c.dueDate != null && c.dueDate < today,
      ).length;
      const cut = certs.filter((c) => c.variance < -0.005).length;
      metrics["certificatesCutBelowApplication"] = cut;

      const openVals = await app.db
        .select({ status: valuations.status })
        .from(valuations)
        .where(and(eq(valuations.companyId, companyId), eq(valuations.projectId, projectId)));
      metrics["valuationsOpen"] = openVals.filter(
        (v) => v.status === "draft" || v.status === "submitted",
      ).length;

      const unagreedRemeasures = await app.db
        .select({ status: remeasurements.status })
        .from(remeasurements)
        .where(
          and(eq(remeasurements.companyId, companyId), eq(remeasurements.projectId, projectId)),
        );
      metrics["remeasurementsUnagreed"] = unagreedRemeasures.filter(
        (r) => r.status === "proposed" || r.status === "disputed",
      ).length;

      const sheets = await app.db
        .select({ status: dayworkSheets.status })
        .from(dayworkSheets)
        .where(and(eq(dayworkSheets.companyId, companyId), eq(dayworkSheets.projectId, projectId)));
      metrics["dayworkSheetsAwaitingVerification"] = sheets.filter(
        (s) => s.status === "submitted",
      ).length;

      const ps = await app.db
        .select({
          allowance: provisionalSums.allowance,
          expended: provisionalSums.expendedTotal,
          status: provisionalSums.status,
        })
        .from(provisionalSums)
        .where(
          and(eq(provisionalSums.companyId, companyId), eq(provisionalSums.projectId, projectId)),
        );
      metrics["provisionalSumsOpen"] = ps.filter((p) => p.status === "open").length;
      metrics["provisionalSumsOverspent"] = ps.filter(
        (p) => p.expended > p.allowance + 0.005,
      ).length;

      // variance percentage is currency-free and therefore safe to express
      if (currencies.size === 1) {
        const pricedIds = projectBoqs.filter((b) => b.status !== "draft").map((b) => b.id);
        const rows =
          pricedIds.length === 0
            ? []
            : await app.db
                .select({ amount: boqItems.amount, level: boqItems.level })
                .from(boqItems)
                .where(inArray(boqItems.boqId, pricedIds));
        const boqTotal = rows
          .filter((r) => r.level === "item")
          .reduce((s, r) => s + (r.amount ?? 0), 0);
        const agreed = vars
          .filter((v) => v.status === "agreed")
          .reduce((s, v) => s + (v.agreedValue ?? 0), 0);
        const pending = vars
          .filter((v) => v.status !== "agreed" && v.status !== "rejected" && v.status !== "withdrawn")
          .reduce((s, v) => s + (v.agreedValue ?? v.costEstimate ?? 0), 0);
        metrics["variationExposurePercent"] =
          boqTotal > 0 ? Math.round(((agreed + pending) / boqTotal) * 1000) / 10 : null;
        if (boqTotal <= 0) reasons.push("No priced bill, so variation exposure cannot be expressed as a percentage.");
      } else {
        metrics["variationExposurePercent"] = null;
        reasons.push(
          currencies.size === 0
            ? "No bills of quantities exist, so variation exposure cannot be measured."
            : "The project holds more than one currency; variation exposure is not expressed as a single percentage.",
        );
      }

      const contractRows = await app.db
        .select({ id: contracts.id, status: contracts.status })
        .from(contracts)
        .where(and(eq(contracts.companyId, companyId), eq(contracts.projectId, projectId)));
      metrics["contracts"] = contractRows.length;

      return { metrics, reasons };
    },
  );
};
