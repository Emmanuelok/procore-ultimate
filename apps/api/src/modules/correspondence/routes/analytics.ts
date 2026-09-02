/**
 * Correspondence analytics: the workspace summary, the register export, the
 * open signals this module raised, the health inputs WP-INTEL reads, and the
 * manual trigger for every sweep the scheduler otherwise runs on its own.
 *
 * Every figure that cannot be derived comes back as `{ value: null, reasons }`
 * — a project with no answered letters has no average response time, and
 * saying "0 days" would be a lie about the project rather than a statement
 * about our records.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { correspondenceLetters, correspondenceRecipients, signals } from "@constructos/db";
import { CORRESPONDENCE_DETECTORS } from "@constructos/shared";
import { assessLetter } from "../engines/tracking.js";
import {
  correspondenceHealthInputs,
  correspondenceSummary,
  runAllSweeps,
  toLetterInput,
} from "../service.js";
import { buildGates, todayISO } from "../shared.js";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  app.get("/projects/:projectId/correspondence/summary", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return correspondenceSummary(app.db, req.companyId!, projectId, todayISO());
  });

  app.get("/projects/:projectId/correspondence/health-inputs", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return correspondenceHealthInputs(app.db, req.companyId!, projectId, todayISO());
  });

  app.get("/projects/:projectId/correspondence/signals", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z
      .object({
        openOnly: z.coerce.boolean().default(true),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, req.companyId!),
          eq(signals.projectId, projectId),
          inArray(signals.detector, [...CORRESPONDENCE_DETECTORS]),
          q.openOnly
            ? inArray(signals.disposition, ["new", "under_review", "confirmed", "escalated"])
            : undefined,
        ),
      )
      .orderBy(desc(signals.createdAt))
      .limit(q.limit);
    return { items: rows, total: rows.length };
  });

  /** The correspondence register as CSV (#444). */
  app.get("/projects/:projectId/correspondence/register", { preHandler: readGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const rows = await app.db
      .select()
      .from(correspondenceLetters)
      .where(
        and(eq(correspondenceLetters.companyId, companyId), eq(correspondenceLetters.projectId, projectId)),
      )
      .orderBy(asc(correspondenceLetters.reference))
      .limit(20_000);
    const recipientRows = await app.db
      .select({
        recordId: correspondenceRecipients.recordId,
        name: correspondenceRecipients.name,
        kind: correspondenceRecipients.kind,
      })
      .from(correspondenceRecipients)
      .where(
        and(
          eq(correspondenceRecipients.companyId, companyId),
          eq(correspondenceRecipients.projectId, projectId),
          eq(correspondenceRecipients.recordType, "letter"),
        ),
      )
      .limit(50_000);
    const byLetter = new Map<string, string[]>();
    for (const r of recipientRows) {
      const list = byLetter.get(r.recordId) ?? [];
      list.push(`${r.name} (${r.kind})`);
      byLetter.set(r.recordId, list);
    }
    const today = todayISO();
    const header = [
      "reference",
      "type",
      "subject",
      "direction",
      "status",
      "priority",
      "contractual",
      "letter_date",
      "issued_at",
      "recipients",
      "response_due",
      "responded_at",
      "days_overdue",
      "ball_in_court",
      "source",
      "thread",
    ];
    const lines = [header.join(",")];
    for (const row of rows) {
      const a = assessLetter(toLetterInput(row), today);
      lines.push(
        [
          row.reference,
          row.typeKey,
          row.subject,
          row.direction,
          row.status,
          row.priority,
          row.isContractual === 1 ? "yes" : "no",
          row.letterDate ?? "",
          row.issuedAt ?? "",
          (byLetter.get(row.id) ?? []).join("; "),
          row.responseDueDate ?? "",
          row.respondedAt ?? "",
          a.daysOverdue ?? "",
          a.ballInCourt,
          row.source,
          row.threadId,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="correspondence-register.csv"')
      .send(lines.join("\n"));
  });

  /**
   * Run every sweep for this project now. The scheduler runs the same code on
   * its own interval; this endpoint exists so an operator (and the tests) can
   * force a cycle without waiting.
   */
  app.post("/projects/:projectId/correspondence/sweeps/run", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return runAllSweeps(app.db, req.companyId!, projectId, req.user!.id, todayISO());
  });
};
