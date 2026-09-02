/**
 * BIM workspace summary and health inputs (cross-package contract 3.5).
 *
 * Everything here is derived from records that already exist, and every
 * number that cannot be computed is returned as null with the reason, never
 * as 0: "no model has been uploaded" and "every element is linked" are
 * different facts and the intelligence layer must be able to tell them apart.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  bimElementLinks,
  bimElements,
  bimModelVersions,
  bimModels,
  clashResults,
  coordinationIssues,
  geofences,
  realityCaptures,
} from "@constructos/db";
import { buildBimGates, todayISO } from "../shared.js";

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildBimGates(app);

  async function gather(companyId: string, projectId: string) {
    const today = todayISO();
    const modelWhere = and(eq(bimModels.companyId, companyId), eq(bimModels.projectId, projectId));

    const [
      modelRows,
      versionStates,
      issueStates,
      overdueRow,
      clashRows,
      elementRow,
      linkRows,
      captureRow,
      fenceRow,
    ] = await Promise.all([
      app.db
        .select({ id: bimModels.id, discipline: bimModels.discipline, currentVersionId: bimModels.currentVersionId })
        .from(bimModels)
        .where(modelWhere),
      app.db
        .select({
          processing: bimModelVersions.processing,
          cdeState: bimModelVersions.cdeState,
          n: count(),
        })
        .from(bimModelVersions)
        .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
        .where(modelWhere)
        .groupBy(bimModelVersions.processing, bimModelVersions.cdeState),
      app.db
        .select({ status: coordinationIssues.status, n: count() })
        .from(coordinationIssues)
        .where(
          and(
            eq(coordinationIssues.companyId, companyId),
            eq(coordinationIssues.projectId, projectId),
          ),
        )
        .groupBy(coordinationIssues.status),
      app.db
        .select({ n: count() })
        .from(coordinationIssues)
        .where(
          and(
            eq(coordinationIssues.companyId, companyId),
            eq(coordinationIssues.projectId, projectId),
            inArray(coordinationIssues.status, ["open", "assigned"]),
            sql`${coordinationIssues.dueDate} is not null`,
            sql`${coordinationIssues.dueDate} < ${today}`,
          ),
        ),
      app.db
        .select({ status: clashResults.status, n: count() })
        .from(clashResults)
        .where(
          and(eq(clashResults.companyId, companyId), eq(clashResults.projectId, projectId)),
        )
        .groupBy(clashResults.status),
      app.db
        .select({ n: count() })
        .from(bimElements)
        .innerJoin(bimModels, eq(bimModels.currentVersionId, bimElements.modelVersionId))
        .where(modelWhere),
      app.db
        .select({ linkType: bimElementLinks.linkType, n: count() })
        .from(bimElementLinks)
        .where(
          and(
            eq(bimElementLinks.companyId, companyId),
            eq(bimElementLinks.projectId, projectId),
          ),
        )
        .groupBy(bimElementLinks.linkType),
      app.db
        .select({ n: count() })
        .from(realityCaptures)
        .where(
          and(
            eq(realityCaptures.companyId, companyId),
            eq(realityCaptures.projectId, projectId),
          ),
        ),
      app.db
        .select({ n: count() })
        .from(geofences)
        .where(
          and(
            eq(geofences.companyId, companyId),
            eq(geofences.projectId, projectId),
            eq(geofences.isActive, 1),
          ),
        ),
    ]);

    const published = versionStates
      .filter((v) => v.cdeState === "published")
      .reduce((s, v) => s + Number(v.n), 0);
    const failed = versionStates
      .filter((v) => v.processing === "failed")
      .reduce((s, v) => s + Number(v.n), 0);
    const queued = versionStates
      .filter((v) => v.processing === "queued" || v.processing === "pending")
      .reduce((s, v) => s + Number(v.n), 0);

    const issues = Object.fromEntries(issueStates.map((r) => [r.status, Number(r.n)]));
    const clashes = Object.fromEntries(clashRows.map((r) => [r.status, Number(r.n)]));
    const links = Object.fromEntries(linkRows.map((r) => [r.linkType, Number(r.n)]));
    const elements = Number(elementRow[0]?.n ?? 0);

    return {
      models: modelRows.length,
      modelsWithVersion: modelRows.filter((m) => m.currentVersionId !== null).length,
      disciplines: [...new Set(modelRows.map((m) => m.discipline))],
      publishedVersions: published,
      failedVersions: failed,
      queuedVersions: queued,
      issues,
      openIssues: (issues["open"] ?? 0) + (issues["assigned"] ?? 0),
      overdueIssues: Number(overdueRow[0]?.n ?? 0),
      clashes,
      openClashes: (clashes["new"] ?? 0) + (clashes["active"] ?? 0),
      elements,
      links,
      captures: Number(captureRow[0]?.n ?? 0),
      activeGeofences: Number(fenceRow[0]?.n ?? 0),
    };
  }

  app.get("/projects/:projectId/bim/summary", { preHandler: gates.readGate }, async (req) => {
    const data = await gather(req.companyId!, req.projectId!);
    const linked4d = data.links["schedule_task"] ?? 0;
    const linked5d = data.links["budget_line"] ?? 0;
    return {
      ...data,
      fourDCoverage:
        data.elements > 0 ? Math.round((linked4d / data.elements) * 1000) / 10 : null,
      fourDCoverageBasis:
        data.elements > 0
          ? `${linked4d} of ${data.elements} current-version elements linked to a task`
          : "no elements have been extracted yet",
      fiveDCoverage:
        data.elements > 0 ? Math.round((linked5d / data.elements) * 1000) / 10 : null,
      generatedAt: new Date().toISOString(),
    };
  });

  /** Contract 3.5 — what WP-INTEL reads for the project health score. */
  app.get("/projects/:projectId/bim/health-inputs", { preHandler: gates.readGate }, async (req) => {
    const data = await gather(req.companyId!, req.projectId!);
    const reasons: string[] = [];
    if (data.models === 0) reasons.push("No BIM model has been registered on this project");
    if (data.failedVersions > 0) {
      reasons.push(`${data.failedVersions} model version(s) failed element extraction`);
    }
    if (data.queuedVersions > 0) {
      reasons.push(`${data.queuedVersions} model version(s) are still being processed`);
    }
    if (data.overdueIssues > 0) {
      reasons.push(`${data.overdueIssues} coordination issue(s) are past their due date`);
    }
    if (data.openClashes > 0) reasons.push(`${data.openClashes} unresolved clash(es) in the register`);
    if (data.models > 0 && data.publishedVersions === 0) {
      reasons.push("No container has reached the published (A1) state");
    }
    return {
      metrics: {
        bim_models: data.models,
        bim_published_versions: data.publishedVersions,
        bim_failed_versions: data.failedVersions,
        bim_open_coordination_issues: data.openIssues,
        bim_overdue_coordination_issues: data.overdueIssues,
        bim_open_clashes: data.openClashes,
        bim_elements: data.models === 0 ? null : data.elements,
        bim_4d_linked_elements: data.links["schedule_task"] ?? 0,
        bim_5d_linked_elements: data.links["budget_line"] ?? 0,
        bim_reality_captures: data.captures,
      },
      reasons,
    };
  });
};
