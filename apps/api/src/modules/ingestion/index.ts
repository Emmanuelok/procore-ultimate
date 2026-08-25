import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  apiTokens,
  assertions,
  companies,
  contracts,
  evidence,
  files,
  fxRates,
  ingestedRecords,
  ingestionRuns,
  ingestionSources,
  paymentCertificates,
  payrollEntries,
  projects,
  rfis,
  schedules,
  scheduleTasks,
  signals,
  siteAccessRecords,
  valuations,
  variations,
  vendors,
  workers,
} from "@constructos/db";
import {
  INGESTION_DATASETS,
  INGESTION_RUN_STATUSES,
  INGESTION_SOURCE_KINDS,
  STAGED_RECORD_STATUSES,
  type IngestionDataset,
} from "@constructos/shared";
import { hashPayload, sha256Hex } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { ACONEX_REQUIREMENTS, PROCORE_REQUIREMENTS } from "./connectors.js";
import {
  coerceRow,
  datasetCatalog,
  datasetDef,
  MAX_PUSH_RECORDS,
  MAX_REPORT_ENTRIES,
  MAX_ROWS_PER_RUN,
  parseCsv,
  PREVIEW_ROWS,
  type DatasetDef,
  type RowIssue,
} from "./datasets.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const sourceCreateSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(INGESTION_SOURCE_KINDS),
  projectId: z.string().min(1).max(64).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const sourcePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

const sourcesListQuery = pageQuerySchema.extend({
  kind: z.enum(INGESTION_SOURCE_KINDS).optional(),
});

const runFieldsSchema = z.object({
  sourceId: z.string().min(1).max(64),
  dataset: z.enum(INGESTION_DATASETS),
  projectId: z.string().min(1).max(64).optional(),
});

const runsListQuery = pageQuerySchema.extend({
  dataset: z.enum(INGESTION_DATASETS).optional(),
  status: z.enum(INGESTION_RUN_STATUSES).optional(),
});

const recordsListQuery = pageQuerySchema.extend({
  status: z.enum(STAGED_RECORD_STATUSES).optional(),
});

const mapSchema = z.object({
  columnMap: z.record(z.string().min(1).max(100), z.string().min(1).max(200)),
});

const tokenCreateSchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.enum(INGESTION_DATASETS)).min(1).max(INGESTION_DATASETS.length),
  expiresAt: isoTimestamp.nullable().optional(),
});

const pushBodySchema = z.object({
  records: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_PUSH_RECORDS),
  projectId: z.string().min(1).max(64).optional(),
});

/**
 * Source `config` NEVER holds credentials (schema comment on
 * ingestion_sources.config): secrets live in env or in api_tokens. This is a
 * key-name guard, not cryptography — it exists so a Procore client secret
 * pasted into config is refused loudly instead of stored quietly.
 */
const CREDENTIAL_KEY_RE =
  /(token|secret|password|passwd|credential|api[-_]?key|client[-_]?secret|bearer|private[-_]?key|auth)/i;

export function assertNoCredentialKeys(config: Record<string, unknown>, path = ""): void {
  for (const [key, value] of Object.entries(config)) {
    const where = path ? `${path}.${key}` : key;
    if (CREDENTIAL_KEY_RE.test(key)) {
      throw badRequest(
        `config must never hold credentials — remove "${where}". Secrets live in the ` +
          "deployment environment or in ingestion API tokens, not in source rows.",
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertNoCredentialKeys(value as Record<string, unknown>, where);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

type RunRow = typeof ingestionRuns.$inferSelect;
type StagedRow = typeof ingestedRecords.$inferSelect;
type TokenRow = typeof apiTokens.$inferSelect;

interface ReportEntry {
  row: number;
  field: string | null;
  code: string;
  message: string;
}

interface CommitCtx {
  companyId: string;
  projectId: string | null;
  runId: string;
  /** whose id lands on createdBy/submittedBy of the real records */
  actorId: string;
  fileSha256: string | null;
}

interface CommitPrep {
  /** pre-allocated RFI numbers, one per staged row, in row order */
  rfiNumbers: number[];
  activeScheduleId: string | null;
  taskSortBase: number;
}

type RowOutcome = { recordId: string } | { skipped: string };

const CHUNK = 500;

/**
 * M6 — Data ingestion & migration (spec Vol III M6 / Domain N; Domain Y
 * #1045-1047; ADR 0014).
 *
 * The migration wizard is a staged pipeline: upload (hash-at-ingest) → map →
 * validate against the code-resident dataset registry → explicit, ledgered
 * commit into REAL records with per-row provenance (`committedRecordId`
 * forward-links, `sourceType/sourceId` back-links, the raw file retained
 * content-addressed). The push endpoint is the machine inlet ADR 0014 calls
 * for: an evidence stream (site access, payroll) authenticated by a hashed
 * bearer token scoped to datasets — a pathway the claimant does not share.
 */
export const ingestionModule: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /* ---------------------------------------------------------------- */
  /* Fetch helpers                                                     */
  /* ---------------------------------------------------------------- */

  async function fetchSource(sourceId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(ingestionSources)
      .where(and(eq(ingestionSources.id, sourceId), eq(ingestionSources.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Ingestion source not found");
    return rows[0];
  }

  async function fetchRun(runId: string, companyId: string): Promise<RunRow> {
    const rows = await app.db
      .select()
      .from(ingestionRuns)
      .where(and(eq(ingestionRuns.id, runId), eq(ingestionRuns.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Ingestion run not found");
    return rows[0];
  }

  async function fetchToken(tokenId: string, companyId: string): Promise<TokenRow> {
    const rows = await app.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("API token not found");
    return rows[0];
  }

  async function assertProjectInCompany(projectId: string, companyId: string) {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("projectId is not a project in this company");
  }

  async function readRunFile(run: RunRow): Promise<Buffer> {
    if (!run.fileId) throw badRequest("Run has no uploaded file");
    const rows = await app.db.select().from(files).where(eq(files.id, run.fileId)).limit(1);
    if (!rows[0]) throw notFound("Run file not found");
    const stream = app.storage.readStream(rows[0].storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  const viewToken = (t: TokenRow) => {
    const { tokenHash, ...rest } = t;
    void tokenHash;
    return rest;
  };

  /* ---------------------------------------------------------------- */
  /* Validation core (shared by the route and the push endpoint)       */
  /* ---------------------------------------------------------------- */

  /**
   * Validate every non-committed staged row of a run against the registry:
   * types, required fields, enum membership, cross-field checks, duplicate
   * externalId within the run and against rows already COMMITTED for the same
   * dataset in this company. Clean rows keep status `staged` with their
   * payload replaced by the typed coercion; failing rows become `rejected`
   * with every reason recorded. The run becomes `validated` either way —
   * commit takes only the clean rows, and the rejects stay behind as the
   * honest record of what the file actually contained.
   */
  async function runValidation(run: RunRow, ledgerActorId: string | null) {
    const def = datasetDef(run.dataset)!;
    const rows = await app.db
      .select()
      .from(ingestedRecords)
      .where(and(eq(ingestedRecords.runId, run.id), ne(ingestedRecords.status, "committed")))
      .orderBy(asc(ingestedRecords.rowNumber));

    const externalIds = [
      ...new Set(rows.map((r) => r.externalId).filter((v): v is string => Boolean(v))),
    ];
    const committedDup = new Set<string>();
    if (externalIds.length > 0) {
      const committedRows = await app.db
        .select({ externalId: ingestedRecords.externalId })
        .from(ingestedRecords)
        .innerJoin(ingestionRuns, eq(ingestedRecords.runId, ingestionRuns.id))
        .where(
          and(
            eq(ingestionRuns.companyId, run.companyId),
            eq(ingestionRuns.dataset, run.dataset),
            eq(ingestedRecords.status, "committed"),
            inArray(ingestedRecords.externalId, externalIds),
          ),
        );
      for (const r of committedRows) if (r.externalId) committedDup.add(r.externalId);
    }

    const seenInRun = new Set<string>();
    const report: ReportEntry[] = [];
    const replayed = new Set<string>();
    let staged = 0;
    let rejected = 0;

    for (const rec of rows) {
      const { value, issues } = coerceRow(def, rec.payload);
      const extId = rec.externalId;
      if (extId) {
        if (seenInRun.has(extId)) {
          issues.push({
            field: "externalId",
            code: "duplicate_in_run",
            message: `externalId "${extId}" appears more than once in this run`,
          });
        } else {
          seenInRun.add(extId);
        }
        if (committedDup.has(extId)) {
          issues.push({
            field: "externalId",
            code: "duplicate_committed",
            message: `externalId "${extId}" was already committed for dataset ${run.dataset}`,
          });
          replayed.add(extId);
        }
      }
      if (issues.length > 0) {
        rejected += 1;
        for (const issue of issues) {
          if (report.length < MAX_REPORT_ENTRIES) {
            report.push({
              row: rec.rowNumber,
              field: issue.field,
              code: issue.code,
              message: issue.message,
            });
          }
        }
        await app.db
          .update(ingestedRecords)
          .set({
            status: "rejected",
            reason: issues.map((i: RowIssue) => `${i.code}: ${i.message}`).join("; "),
          })
          .where(eq(ingestedRecords.id, rec.id));
      } else {
        staged += 1;
        await app.db
          .update(ingestedRecords)
          .set({ status: "staged", reason: null, payload: value })
          .where(eq(ingestedRecords.id, rec.id));
      }
    }

    await app.db
      .update(ingestionRuns)
      .set({
        status: "validated",
        stagedCount: staged,
        rejectedCount: rejected,
        report,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(ingestionRuns.id, run.id));

    // A re-presented batch is a finding, not just a rejection: it can be a
    // double migration, a replayed export, or an attempt to overwrite history
    // through the ingestion pathway. It lands in the signals spine.
    if (replayed.size > 0) {
      await app.db.insert(signals).values({
        id: newId("sig"),
        companyId: run.companyId,
        projectId: run.projectId,
        detector: "ingestion_duplicate_replay",
        severity: "medium",
        confidence: 0.7,
        title: `Ingestion run re-presented ${replayed.size} already-committed record(s) — ${run.dataset}`,
        explanation:
          `Validation of ingestion run ${run.id} (dataset ${run.dataset}) found ` +
          `${replayed.size} externalId(s) that earlier runs already committed. The rows were ` +
          `rejected and nothing was overwritten, but review the source and the earlier runs ` +
          `before re-importing: a replayed batch can mean a duplicated migration or a ` +
          `deliberate attempt to re-write records through the import pathway.`,
        evidenceRefs: {
          runId: run.id,
          dataset: run.dataset,
          duplicateExternalIds: [...replayed].slice(0, 50),
        },
      });
    }

    await appendLedger(app.db, {
      companyId: run.companyId,
      actorId: ledgerActorId,
      action: "state_change",
      objectType: "ingestion_run",
      objectId: run.id,
      payload: {
        phase: "validate",
        dataset: run.dataset,
        staged,
        rejected,
        duplicateCommitted: replayed.size,
      },
    });

    return { staged, rejected, report };
  }

  /* ---------------------------------------------------------------- */
  /* Commit writers — one per INGESTION_DATASETS member                */
  /* ---------------------------------------------------------------- */

  async function commitRows(
    db: Db,
    dataset: IngestionDataset,
    ctx: CommitCtx,
    rows: StagedRow[],
    prep: CommitPrep,
  ): Promise<RowOutcome[]> {
    const now = new Date().toISOString();
    const str = (p: Record<string, unknown>, k: string) => p[k] as string | undefined;
    const num = (p: Record<string, unknown>, k: string) => p[k] as number | undefined;

    switch (dataset) {
      case "vendors": {
        const outcomes: RowOutcome[] = [];
        const values: (typeof vendors.$inferInsert)[] = rows.map((r) => {
          const p = r.payload;
          const id = newId("vnd");
          outcomes.push({ recordId: id });
          return {
            id,
            companyId: ctx.companyId,
            name: str(p, "name")!,
            tradeCodes:
              str(p, "tradeCodes")
                ?.split(/[,;]/)
                .map((s) => s.trim())
                .filter(Boolean) ?? [],
            address: str(p, "address") ?? null,
            city: str(p, "city") ?? null,
            country: str(p, "country") ?? null,
            phone: str(p, "phone") ?? null,
            email: str(p, "email") ?? null,
            website: str(p, "website") ?? null,
            taxId: str(p, "taxId") ?? null,
            registrationNumber: str(p, "registrationNumber") ?? null,
          };
        });
        for (let i = 0; i < values.length; i += CHUNK) {
          await db.insert(vendors).values(values.slice(i, i + CHUNK));
        }
        return outcomes;
      }

      case "cost_assertions": {
        const outcomes: RowOutcome[] = [];
        const values: (typeof assertions.$inferInsert)[] = rows.map((r) => {
          const p = r.payload;
          const id = newId("asr");
          outcomes.push({ recordId: id });
          return {
            id,
            companyId: ctx.companyId,
            projectId: ctx.projectId!,
            kind: str(p, "kind")!,
            claimantId: ctx.actorId,
            claimantKind: "user",
            value: num(p, "value") ?? null,
            unit: str(p, "unit") ?? null,
            basis: str(p, "basis")!,
            contractRef: str(p, "contractRef") ?? null,
            sourceType: "ingestion_run",
            sourceId: ctx.runId,
            assertedAt: str(p, "assertedAt") ?? now,
          };
        });
        for (let i = 0; i < values.length; i += CHUNK) {
          await db.insert(assertions).values(values.slice(i, i + CHUNK));
        }
        return outcomes;
      }

      case "site_access": {
        const outcomes: RowOutcome[] = [];
        const refs = [...new Set(rows.map((r) => str(r.payload, "workerReference")!))];
        const workerRows = await db
          .select({ id: workers.id, reference: workers.reference })
          .from(workers)
          .where(
            and(
              eq(workers.companyId, ctx.companyId),
              eq(workers.projectId, ctx.projectId!),
              inArray(workers.reference, refs),
            ),
          );
        const byRef = new Map(workerRows.map((w) => [w.reference, w.id]));
        const workerIds = [...new Set(byRef.values())];
        const dates = [...new Set(rows.map((r) => str(r.payload, "accessDate")!))];
        const existing =
          workerIds.length > 0
            ? await db
                .select({
                  id: siteAccessRecords.id,
                  workerId: siteAccessRecords.workerId,
                  accessDate: siteAccessRecords.accessDate,
                })
                .from(siteAccessRecords)
                .where(
                  and(
                    inArray(siteAccessRecords.workerId, workerIds),
                    inArray(siteAccessRecords.accessDate, dates),
                  ),
                )
            : [];
        // Upsert on (workerId, accessDate), matching the workforce module: a
        // re-ingested feed refreshes a day instead of duplicating it. Repeats
        // WITHIN the run also land on the same row — last write wins.
        const pairId = new Map(existing.map((e) => [`${e.workerId}|${e.accessDate}`, e.id]));
        for (const r of rows) {
          const p = r.payload;
          const ref = str(p, "workerReference")!;
          const workerId = byRef.get(ref);
          if (!workerId) {
            outcomes.push({ skipped: `unknown worker reference "${ref}" on this project` });
            continue;
          }
          const accessDate = str(p, "accessDate")!;
          const key = `${workerId}|${accessDate}`;
          const set = {
            firstIn: str(p, "firstIn") ?? null,
            lastOut: str(p, "lastOut") ?? null,
            hoursOnSite: num(p, "hoursOnSite") ?? null,
            source: str(p, "source") ?? "turnstile",
          };
          const existingId = pairId.get(key);
          if (existingId) {
            await db.update(siteAccessRecords).set(set).where(eq(siteAccessRecords.id, existingId));
            outcomes.push({ recordId: existingId });
          } else {
            const id = newId("sac");
            await db.insert(siteAccessRecords).values({
              id,
              companyId: ctx.companyId,
              projectId: ctx.projectId!,
              workerId,
              accessDate,
              ...set,
            });
            pairId.set(key, id);
            outcomes.push({ recordId: id });
          }
        }
        return outcomes;
      }

      case "payroll": {
        const outcomes: RowOutcome[] = [];
        const refs = [...new Set(rows.map((r) => str(r.payload, "workerReference")!))];
        const workerRows = await db
          .select({ id: workers.id, reference: workers.reference })
          .from(workers)
          .where(
            and(
              eq(workers.companyId, ctx.companyId),
              eq(workers.projectId, ctx.projectId!),
              inArray(workers.reference, refs),
            ),
          );
        const byRef = new Map(workerRows.map((w) => [w.reference, w.id]));
        const values: (typeof payrollEntries.$inferInsert)[] = [];
        for (const r of rows) {
          const p = r.payload;
          const ref = str(p, "workerReference")!;
          const workerId = byRef.get(ref);
          if (!workerId) {
            outcomes.push({ skipped: `unknown worker reference "${ref}" on this project` });
            continue;
          }
          const id = newId("pay");
          outcomes.push({ recordId: id });
          values.push({
            id,
            companyId: ctx.companyId,
            projectId: ctx.projectId!,
            workerId,
            periodStart: str(p, "periodStart")!,
            periodEnd: str(p, "periodEnd")!,
            daysClaimed: num(p, "daysClaimed")!,
            hoursClaimed: num(p, "hoursClaimed") ?? null,
            grossPay: num(p, "grossPay")!,
            deductions: num(p, "deductions") ?? 0,
            netPay: num(p, "netPay")!,
            currency: str(p, "currency") ?? "USD",
            paidAt: str(p, "paidAt") ?? null,
            wpsReference: str(p, "wpsReference") ?? null,
            submittedBy: ctx.actorId,
          });
        }
        for (let i = 0; i < values.length; i += CHUNK) {
          await db.insert(payrollEntries).values(values.slice(i, i + CHUNK));
        }
        return outcomes;
      }

      case "rfis": {
        const outcomes: RowOutcome[] = [];
        const values: (typeof rfis.$inferInsert)[] = rows.map((r, i) => {
          const p = r.payload;
          const id = newId("rfi");
          outcomes.push({ recordId: id });
          return {
            id,
            companyId: ctx.companyId,
            projectId: ctx.projectId!,
            number: prep.rfiNumbers[i]!,
            subject: str(p, "subject")!,
            question: str(p, "question")!,
            proposedSolution: str(p, "proposedSolution") ?? null,
            status: str(p, "status") ?? "draft",
            distribution: [],
            dueDate: str(p, "dueDate") ?? null,
            costImpact: str(p, "costImpact") ?? "tbd",
            scheduleImpact: str(p, "scheduleImpact") ?? "tbd",
            createdBy: ctx.actorId,
          };
        });
        for (let i = 0; i < values.length; i += CHUNK) {
          await db.insert(rfis).values(values.slice(i, i + CHUNK));
        }
        return outcomes;
      }

      case "schedule_tasks": {
        const outcomes: RowOutcome[] = [];
        const values: (typeof scheduleTasks.$inferInsert)[] = rows.map((r, i) => {
          const p = r.payload;
          const id = newId("tsk");
          outcomes.push({ recordId: id });
          return {
            id,
            scheduleId: prep.activeScheduleId!,
            projectId: ctx.projectId!,
            name: str(p, "name")!,
            wbsCode: str(p, "wbsCode") ?? null,
            durationDays: (p["durationDays"] as number | undefined) ?? 1,
            percentComplete: num(p, "percentComplete") ?? 0,
            actualStart: str(p, "actualStart") ?? null,
            actualFinish: str(p, "actualFinish") ?? null,
            sortOrder: prep.taskSortBase + i,
          };
        });
        for (let i = 0; i < values.length; i += CHUNK) {
          await db.insert(scheduleTasks).values(values.slice(i, i + CHUNK));
        }
        return outcomes;
      }

      case "evidence": {
        const outcomes: RowOutcome[] = [];
        const values: (typeof evidence.$inferInsert)[] = rows.map((r) => {
          const p = r.payload;
          const id = newId("evd");
          outcomes.push({ recordId: id });
          return {
            id,
            companyId: ctx.companyId,
            projectId: ctx.projectId!,
            kind: str(p, "kind")!,
            source: str(p, "source")!,
            // hash-at-ingest: the typed payload is the content being attested
            contentHash: hashPayload(p),
            fileId: null,
            capturedAt: str(p, "capturedAt") ?? null,
            independenceScore: num(p, "independenceScore") ?? 0,
            provenance: {
              via: "ingestion_run",
              runId: ctx.runId,
              fileSha256: ctx.fileSha256,
              rowNumber: r.rowNumber,
              at: now,
            },
            metadata: p,
            submittedBy: ctx.actorId,
          };
        });
        for (let i = 0; i < values.length; i += CHUNK) {
          await db.insert(evidence).values(values.slice(i, i + CHUNK));
        }
        return outcomes;
      }

      case "fx_rates": {
        const outcomes: RowOutcome[] = [];
        const keyed = rows.map((r) => {
          const p = r.payload;
          return {
            row: r,
            fromCurrency: str(p, "fromCurrency")!.toUpperCase(),
            toCurrency: str(p, "toCurrency")!.toUpperCase(),
            rateDate: str(p, "rateDate")!,
            source: str(p, "source") ?? "manual",
          };
        });
        const existing = await db
          .select({
            fromCurrency: fxRates.fromCurrency,
            toCurrency: fxRates.toCurrency,
            rateDate: fxRates.rateDate,
            source: fxRates.source,
          })
          .from(fxRates)
          .where(
            and(
              eq(fxRates.companyId, ctx.companyId),
              inArray(fxRates.fromCurrency, [...new Set(keyed.map((k) => k.fromCurrency))]),
              inArray(fxRates.toCurrency, [...new Set(keyed.map((k) => k.toCurrency))]),
              inArray(fxRates.rateDate, [...new Set(keyed.map((k) => k.rateDate))]),
            ),
          );
        const existKeys = new Set(
          existing.map((e) => `${e.fromCurrency}|${e.toCurrency}|${e.rateDate}|${e.source}`),
        );
        const seen = new Set<string>();
        const values: (typeof fxRates.$inferInsert)[] = [];
        for (const k of keyed) {
          const key = `${k.fromCurrency}|${k.toCurrency}|${k.rateDate}|${k.source}`;
          if (existKeys.has(key)) {
            outcomes.push({
              skipped: `a ${k.source} rate for ${k.fromCurrency}/${k.toCurrency} on ${k.rateDate} is already on file`,
            });
            continue;
          }
          if (seen.has(key)) {
            outcomes.push({
              skipped: `duplicate ${k.source} rate for ${k.fromCurrency}/${k.toCurrency} on ${k.rateDate} within this run`,
            });
            continue;
          }
          seen.add(key);
          const p = k.row.payload;
          const id = newId("fxr");
          outcomes.push({ recordId: id });
          values.push({
            id,
            companyId: ctx.companyId,
            fromCurrency: k.fromCurrency,
            toCurrency: k.toCurrency,
            rate: num(p, "rate")!,
            rateDate: k.rateDate,
            source: k.source,
            sourceReference: str(p, "sourceReference") ?? null,
            recordedBy: ctx.actorId,
          });
        }
        for (let i = 0; i < values.length; i += CHUNK) {
          await db.insert(fxRates).values(values.slice(i, i + CHUNK));
        }
        return outcomes;
      }
    }
  }

  /**
   * Commit a validated run: the real records, the per-row provenance updates
   * and the run's final state are written in ONE transaction, so a failure
   * leaves nothing half-committed (the run is marked `failed` and can be
   * retried). RFI numbers are allocated through the shared record-counter
   * BEFORE the transaction — a failed commit burns numbers rather than
   * nesting transactions, which is the same trade every module makes.
   * The single ledger entry carries the file hash and the counts.
   */
  async function runCommit(
    run: RunRow,
    recordActorId: string,
    ledgerActorId: string | null,
  ): Promise<{ committed: number; skipped: number }> {
    const def = datasetDef(run.dataset)!;
    const rows = await app.db
      .select()
      .from(ingestedRecords)
      .where(and(eq(ingestedRecords.runId, run.id), eq(ingestedRecords.status, "staged")))
      .orderBy(asc(ingestedRecords.rowNumber));
    if (rows.length === 0) {
      throw badRequest("Run has no valid staged rows to commit — validate first, or fix and re-map");
    }
    if (def.requiresProject && !run.projectId) {
      throw badRequest(`dataset ${def.dataset} requires the run to carry a projectId`);
    }

    // Preconditions & pre-allocation (all BEFORE the run leaves `validated`,
    // so a refused commit leaves the run exactly as it was).
    const prep: CommitPrep = { rfiNumbers: [], activeScheduleId: null, taskSortBase: 0 };
    if (run.dataset === "rfis") {
      for (let i = 0; i < rows.length; i += 1) {
        prep.rfiNumbers.push(await nextRecordNumber(app.db, run.projectId!, "rfi"));
      }
    }
    if (run.dataset === "schedule_tasks") {
      const sch = await app.db
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.companyId, run.companyId),
            eq(schedules.projectId, run.projectId!),
            eq(schedules.isActive, 1),
          ),
        )
        .limit(1);
      if (!sch[0]) {
        throw badRequest(
          "Project has no active schedule — create one in the schedule tool before committing schedule_tasks",
        );
      }
      prep.activeScheduleId = sch[0].id;
      const maxRow = await app.db
        .select({ m: sql<number>`coalesce(max(${scheduleTasks.sortOrder}), -1)` })
        .from(scheduleTasks)
        .where(eq(scheduleTasks.scheduleId, sch[0].id));
      prep.taskSortBase = Number(maxRow[0]?.m ?? -1) + 1;
    }

    const now = new Date().toISOString();
    await app.db
      .update(ingestionRuns)
      .set({ status: "committing", updatedAt: now })
      .where(eq(ingestionRuns.id, run.id));

    const ctx: CommitCtx = {
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      actorId: recordActorId,
      fileSha256: run.fileSha256,
    };

    let committed = 0;
    let skipped = 0;
    try {
      await app.db.transaction(async (tx) => {
        // PgTransaction extends PgDatabase, so the writers run unchanged
        // inside the transaction; the cast keeps their signature on Db.
        const dbh = tx as unknown as Db;
        const outcomes = await commitRows(dbh, def.dataset, ctx, rows, prep);
        const committedAt = new Date().toISOString();
        for (let i = 0; i < rows.length; i += 1) {
          const outcome = outcomes[i]!;
          if ("recordId" in outcome) {
            committed += 1;
            await dbh
              .update(ingestedRecords)
              .set({ status: "committed", committedRecordId: outcome.recordId, reason: null })
              .where(eq(ingestedRecords.id, rows[i]!.id));
          } else {
            skipped += 1;
            await dbh
              .update(ingestedRecords)
              .set({ status: "skipped", reason: outcome.skipped })
              .where(eq(ingestedRecords.id, rows[i]!.id));
          }
        }
        await dbh
          .update(ingestionRuns)
          .set({
            status: "committed",
            committedCount: committed,
            skippedCount: skipped,
            committedBy: recordActorId,
            committedAt,
            updatedAt: committedAt,
            error: null,
          })
          .where(eq(ingestionRuns.id, run.id));
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await app.db
        .update(ingestionRuns)
        .set({ status: "failed", error: message, updatedAt: new Date().toISOString() })
        .where(eq(ingestionRuns.id, run.id));
      throw err;
    }

    await appendLedger(app.db, {
      companyId: run.companyId,
      actorId: ledgerActorId,
      action: "state_change",
      objectType: "ingestion_run",
      objectId: run.id,
      payload: {
        phase: "commit",
        dataset: run.dataset,
        sourceId: run.sourceId,
        projectId: run.projectId,
        fileName: run.fileName,
        fileSha256: run.fileSha256,
        totalRows: run.totalRows,
        committed,
        skipped,
        rejected: run.rejectedCount,
      },
      storePayload: true,
    });

    return { committed, skipped };
  }

  /* ---------------------------------------------------------------- */
  /* Sources                                                           */
  /* ---------------------------------------------------------------- */

  app.get("/ingestion/sources", { preHandler: memberGate }, async (req) => {
    const q = sourcesListQuery.parse(req.query);
    const where = and(
      eq(ingestionSources.companyId, req.companyId!),
      q.kind ? eq(ingestionSources.kind, q.kind) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(ingestionSources).where(where);
    const items = await app.db
      .select()
      .from(ingestionSources)
      .where(where)
      .orderBy(desc(ingestionSources.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/ingestion/sources", { preHandler: adminGate }, async (req, reply) => {
    const body = sourceCreateSchema.parse(req.body);
    const config = body.config ?? {};
    assertNoCredentialKeys(config);
    if (body.projectId) await assertProjectInCompany(body.projectId, req.companyId!);
    const id = newId("isr");
    await app.db.insert(ingestionSources).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      name: body.name,
      kind: body.kind,
      config,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "ingestion_source",
      objectId: id,
      payload: { name: body.name, kind: body.kind, projectId: body.projectId ?? null, config },
      storePayload: true,
    });
    return reply.status(201).send(await fetchSource(id, req.companyId!));
  });

  app.patch("/ingestion/sources/:sourceId", { preHandler: adminGate }, async (req) => {
    const { sourceId } = req.params as { sourceId: string };
    const body = sourcePatchSchema.parse(req.body);
    const source = await fetchSource(sourceId, req.companyId!);
    if (body.config) assertNoCredentialKeys(body.config);
    await app.db
      .update(ingestionSources)
      .set({
        name: body.name ?? source.name,
        config: body.config ?? (source.config as Record<string, unknown>),
        isActive: body.isActive === undefined ? source.isActive : body.isActive ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(ingestionSources.id, sourceId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "ingestion_source",
      objectId: sourceId,
      payload: { changed: Object.keys(body) },
    });
    return fetchSource(sourceId, req.companyId!);
  });

  /* ---------------------------------------------------------------- */
  /* Connector pull — honest 501 scaffolding (see connectors.ts)       */
  /* ---------------------------------------------------------------- */

  app.post("/ingestion/sources/:sourceId/pull", { preHandler: adminGate }, async (req) => {
    const { sourceId } = req.params as { sourceId: string };
    const source = await fetchSource(sourceId, req.companyId!);
    if (source.kind === "csv") {
      throw badRequest("csv sources take file uploads — POST /ingestion/runs");
    }
    if (source.kind === "api_token") {
      throw badRequest("api_token sources receive machine pushes — POST /ingestion/push/:dataset");
    }
    const requirements = source.kind === "procore" ? PROCORE_REQUIREMENTS : ACONEX_REQUIREMENTS;
    // Not implemented and not pretended: this sandbox cannot reach either
    // vendor and holds no credentials. The body names exactly what a real
    // pull needs; the mapping layer is already written and fixture-tested.
    throw new AppError(
      501,
      `${source.kind} pull is not implemented in this deployment: there is no network route ` +
        "to the vendor and no credentials are configured. Nothing was fetched and nothing was staged.",
      {
        connector: requirements.connector,
        required: { credentials: requirements.credentials, config: requirements.config },
        note: requirements.note,
      },
    );
  });

  /* ---------------------------------------------------------------- */
  /* Dataset registry                                                  */
  /* ---------------------------------------------------------------- */

  app.get("/ingestion/datasets", { preHandler: memberGate }, async () => ({
    datasets: datasetCatalog(),
    limits: {
      maxRowsPerRun: MAX_ROWS_PER_RUN,
      maxPushRecords: MAX_PUSH_RECORDS,
      maxReportEntries: MAX_REPORT_ENTRIES,
    },
  }));

  /* ---------------------------------------------------------------- */
  /* Runs — upload, map, validate, commit, discard, read               */
  /* ---------------------------------------------------------------- */

  app.post("/ingestion/runs", { preHandler: adminGate }, async (req, reply) => {
    if (!req.isMultipart()) {
      throw badRequest("Expected multipart/form-data with a file and fields sourceId, dataset");
    }
    const mp = await req.file();
    if (!mp) throw badRequest("Expected a multipart file upload");
    const buf = await mp.toBuffer();
    const fieldVal = (name: string): string | undefined => {
      const raw = (mp.fields as Record<string, unknown>)[name];
      const f = Array.isArray(raw) ? raw[0] : raw;
      const v = (f as { value?: unknown } | undefined)?.value;
      return typeof v === "string" ? v : undefined;
    };
    const fields = runFieldsSchema.parse({
      sourceId: fieldVal("sourceId"),
      dataset: fieldVal("dataset"),
      projectId: fieldVal("projectId"),
    });
    const source = await fetchSource(fields.sourceId, req.companyId!);
    if (source.isActive !== 1) throw badRequest("Ingestion source is deactivated");
    if (source.kind === "api_token") {
      throw badRequest(
        "api_token sources receive machine pushes (POST /ingestion/push/:dataset), not file uploads",
      );
    }
    const def = datasetDef(fields.dataset)!;
    const projectId = fields.projectId ?? source.projectId ?? null;
    if (def.requiresProject && !projectId) {
      throw badRequest(`dataset ${def.dataset} requires a projectId on the run`);
    }
    if (projectId) await assertProjectInCompany(projectId, req.companyId!);

    const parsed = parseCsv(buf.toString("utf8"));
    if (parsed.length < 2) {
      throw badRequest("CSV must contain a header row and at least one data row");
    }
    const header = parsed[0]!.map((h) => h.trim());
    if (header.some((h) => h === "")) throw badRequest("CSV header contains an empty column name");
    const dupCols = header.filter((h, i) => header.indexOf(h) !== i);
    if (dupCols.length > 0) {
      throw badRequest(`CSV header contains duplicate column name(s): ${[...new Set(dupCols)].join(", ")}`);
    }
    const dataRows = parsed.slice(1);
    if (dataRows.length > MAX_ROWS_PER_RUN) {
      throw badRequest(`CSV has ${dataRows.length} data rows — the per-run cap is ${MAX_ROWS_PER_RUN}`);
    }

    // hash-at-ingest provenance: the raw file is retained content-addressed
    // and its sha256 travels with the run and into every ledger entry.
    const saved = await app.storage.saveBuffer(req.companyId!, buf);
    const fileId = newId("fil");
    const fileName = mp.filename || "upload.csv";
    await app.db.insert(files).values({
      id: fileId,
      companyId: req.companyId!,
      projectId,
      folderId: null,
      name: fileName,
      contentType: mp.mimetype || "text/csv",
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      storageKey: saved.storageKey,
      metadata: { ingestion: true },
      uploadedBy: req.user!.id,
    });

    const runId = newId("irn");
    await app.db.insert(ingestionRuns).values({
      id: runId,
      companyId: req.companyId!,
      projectId,
      sourceId: source.id,
      dataset: def.dataset,
      status: "staging",
      fileId,
      fileName,
      fileSha256: saved.sha256,
      totalRows: dataRows.length,
      startedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "ingestion_run",
      objectId: runId,
      payload: {
        dataset: def.dataset,
        sourceId: source.id,
        projectId,
        fileName,
        fileSha256: saved.sha256,
        totalRows: dataRows.length,
      },
      storePayload: true,
    });

    return reply.status(201).send({
      run: await fetchRun(runId, req.companyId!),
      columns: header,
      preview: dataRows.slice(0, PREVIEW_ROWS),
    });
  });

  app.post("/ingestion/runs/:runId/map", { preHandler: adminGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const body = mapSchema.parse(req.body);
    const run = await fetchRun(runId, req.companyId!);
    if (run.status !== "staging" && run.status !== "validated") {
      throw conflict(`Run is ${run.status} — mapping is only possible before commit`);
    }
    if (!run.fileId) {
      throw badRequest("Run has no uploaded file to map (machine-push runs are mapped implicitly)");
    }
    const def = datasetDef(run.dataset)!;
    const fieldKeys = new Set(def.fields.map((f) => f.key));
    for (const key of Object.keys(body.columnMap)) {
      if (!fieldKeys.has(key)) {
        throw badRequest(
          `Unknown target field "${key}" for dataset ${run.dataset} — see GET /ingestion/datasets`,
        );
      }
    }
    for (const f of def.fields) {
      if (f.required && !(f.key in body.columnMap)) {
        throw badRequest(`Required field "${f.key}" is not mapped`);
      }
    }

    const parsed = parseCsv((await readRunFile(run)).toString("utf8"));
    const header = (parsed[0] ?? []).map((h) => h.trim());
    const colIndex = new Map(header.map((h, i) => [h, i] as const));
    for (const [field, col] of Object.entries(body.columnMap)) {
      if (!colIndex.has(col)) {
        throw badRequest(`Field "${field}" is mapped to source column "${col}", which is not in the file header`);
      }
    }
    const dataRows = parsed.slice(1);

    // Re-mapping recreates the staging area from the raw file.
    await app.db.delete(ingestedRecords).where(eq(ingestedRecords.runId, run.id));
    const inserts: (typeof ingestedRecords.$inferInsert)[] = dataRows.map((row, i) => {
      const payload: Record<string, unknown> = {};
      for (const [field, col] of Object.entries(body.columnMap)) {
        const v = row[colIndex.get(col)!] ?? "";
        if (v.trim() !== "") payload[field] = v;
      }
      return {
        id: newId("irc"),
        runId: run.id,
        companyId: run.companyId,
        rowNumber: i + 1,
        externalId: typeof payload["externalId"] === "string" ? (payload["externalId"] as string).trim() : null,
        payload,
        status: "staged",
      };
    });
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await app.db.insert(ingestedRecords).values(inserts.slice(i, i + CHUNK));
    }
    await app.db
      .update(ingestionRuns)
      .set({
        columnMap: body.columnMap,
        status: "staging",
        stagedCount: inserts.length,
        rejectedCount: 0,
        committedCount: 0,
        skippedCount: 0,
        report: [],
        updatedAt: new Date().toISOString(),
      })
      .where(eq(ingestionRuns.id, run.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "ingestion_run",
      objectId: run.id,
      payload: { phase: "map", columnMap: body.columnMap, staged: inserts.length },
    });
    return { run: await fetchRun(run.id, req.companyId!), staged: inserts.length };
  });

  app.post("/ingestion/runs/:runId/validate", { preHandler: adminGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const run = await fetchRun(runId, req.companyId!);
    if (run.status !== "staging" && run.status !== "validated") {
      throw conflict(`Run is ${run.status} — validation applies before commit`);
    }
    const [{ n } = { n: 0 }] = await app.db
      .select({ n: count() })
      .from(ingestedRecords)
      .where(eq(ingestedRecords.runId, run.id));
    if (Number(n) === 0) {
      throw badRequest("Run has no staged rows — map columns first (POST /ingestion/runs/:runId/map)");
    }
    const result = await runValidation(run, req.user!.id);
    return { run: await fetchRun(run.id, req.companyId!), ...result };
  });

  app.post("/ingestion/runs/:runId/commit", { preHandler: adminGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const run = await fetchRun(runId, req.companyId!);
    if (run.status !== "validated" && run.status !== "failed") {
      throw conflict(`Run is ${run.status} — commit requires a validated run`);
    }
    const result = await runCommit(run, req.user!.id, req.user!.id);
    return { run: await fetchRun(run.id, req.companyId!), ...result };
  });

  app.post("/ingestion/runs/:runId/discard", { preHandler: adminGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const run = await fetchRun(runId, req.companyId!);
    if (run.status === "committed") {
      throw conflict("A committed run cannot be discarded — its records are already real");
    }
    if (run.status === "discarded") throw conflict("Run is already discarded");
    await app.db
      .update(ingestionRuns)
      .set({ status: "discarded", updatedAt: new Date().toISOString() })
      .where(eq(ingestionRuns.id, run.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "ingestion_run",
      objectId: run.id,
      payload: { phase: "discard", dataset: run.dataset, previousStatus: run.status },
    });
    return fetchRun(run.id, req.companyId!);
  });

  app.get("/ingestion/runs", { preHandler: memberGate }, async (req) => {
    const q = runsListQuery.parse(req.query);
    const where = and(
      eq(ingestionRuns.companyId, req.companyId!),
      q.dataset ? eq(ingestionRuns.dataset, q.dataset) : undefined,
      q.status ? eq(ingestionRuns.status, q.status) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(ingestionRuns).where(where);
    const items = await app.db
      .select()
      .from(ingestionRuns)
      .where(where)
      .orderBy(desc(ingestionRuns.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/ingestion/runs/:runId", { preHandler: memberGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    return fetchRun(runId, req.companyId!);
  });

  app.get("/ingestion/runs/:runId/records", { preHandler: memberGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const q = recordsListQuery.parse(req.query);
    const run = await fetchRun(runId, req.companyId!);
    const where = and(
      eq(ingestedRecords.runId, run.id),
      q.status ? eq(ingestedRecords.status, q.status) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(ingestedRecords).where(where);
    const items = await app.db
      .select()
      .from(ingestedRecords)
      .where(where)
      .orderBy(asc(ingestedRecords.rowNumber))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* ---------------------------------------------------------------- */
  /* API tokens — machine credentials for evidence streams             */
  /* ---------------------------------------------------------------- */

  app.post("/ingestion/tokens", { preHandler: adminGate }, async (req, reply) => {
    const body = tokenCreateSchema.parse(req.body);
    // cok_ + 40 hex chars. Only the sha256 of the token is stored; the raw
    // token appears in THIS response and never again, anywhere.
    const rawToken = `cok_${randomBytes(20).toString("hex")}`;
    const id = newId("tok");
    await app.db.insert(apiTokens).values({
      id,
      companyId: req.companyId!,
      name: body.name,
      tokenHash: sha256Hex(rawToken),
      tokenPrefix: rawToken.slice(0, 8),
      scopes: [...new Set(body.scopes)],
      expiresAt: body.expiresAt ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "api_token",
      objectId: id,
      payload: {
        name: body.name,
        scopes: [...new Set(body.scopes)],
        tokenPrefix: rawToken.slice(0, 8),
        expiresAt: body.expiresAt ?? null,
      },
      storePayload: true,
    });
    const created = await fetchToken(id, req.companyId!);
    return reply.status(201).send({ token: rawToken, ...viewToken(created) });
  });

  app.get("/ingestion/tokens", { preHandler: adminGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = eq(apiTokens.companyId, req.companyId!);
    const [totalRow] = await app.db.select({ n: count() }).from(apiTokens).where(where);
    const items = await app.db
      .select()
      .from(apiTokens)
      .where(where)
      .orderBy(desc(apiTokens.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items.map(viewToken), Number(totalRow?.n ?? 0), q);
  });

  app.post("/ingestion/tokens/:tokenId/revoke", { preHandler: adminGate }, async (req) => {
    const { tokenId } = req.params as { tokenId: string };
    const token = await fetchToken(tokenId, req.companyId!);
    if (token.revokedAt) throw conflict("API token is already revoked");
    await app.db
      .update(apiTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(apiTokens.id, tokenId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "api_token",
      objectId: tokenId,
      payload: { revoked: true, tokenPrefix: token.tokenPrefix },
    });
    return viewToken(await fetchToken(tokenId, req.companyId!));
  });

  /* ---------------------------------------------------------------- */
  /* Machine push — the ADR 0014 independent evidence stream inlet     */
  /* ---------------------------------------------------------------- */

  /**
   * No JWT, no session: `Authorization: Bearer cok_…` verified by sha256
   * against api_tokens. This is the pathway-level separation ADR 0014 asks
   * for — a turnstile vendor or payroll bureau holds a token scoped to its
   * dataset and nothing else on the platform. The push stages, validates and
   * commits in one pass; rejected rows stay on the implicit run for audit.
   */
  app.post("/ingestion/push/:dataset", async (req, reply) => {
    const { dataset } = req.params as { dataset: string };
    const def = datasetDef(dataset);
    if (!def) {
      throw badRequest(`Unknown dataset "${dataset}" — one of: ${INGESTION_DATASETS.join(", ")}`);
    }
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized("Missing bearer token");
    const rawToken = header.slice(7).trim();
    const tokenRows = await app.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, sha256Hex(rawToken)))
      .limit(1);
    const token = tokenRows[0];
    if (!token) throw unauthorized("Invalid API token");
    const nowIso = new Date().toISOString();
    if (token.revokedAt) throw unauthorized("API token has been revoked");
    if (token.expiresAt && token.expiresAt <= nowIso) throw unauthorized("API token has expired");
    if (!(token.scopes as string[]).includes(def.dataset)) {
      throw forbidden(`Token is not scoped for dataset ${def.dataset}`);
    }
    await app.db.update(apiTokens).set({ lastUsedAt: nowIso }).where(eq(apiTokens.id, token.id));

    const body = pushBodySchema.parse(req.body);
    const projectId = body.projectId ?? null;
    if (def.requiresProject && !projectId) {
      throw badRequest(`dataset ${def.dataset} requires projectId`);
    }
    if (projectId) await assertProjectInCompany(projectId, token.companyId);

    // One implicit api_token source per token, created on first use.
    const candidates = await app.db
      .select()
      .from(ingestionSources)
      .where(
        and(eq(ingestionSources.companyId, token.companyId), eq(ingestionSources.kind, "api_token")),
      );
    let source = candidates.find(
      (s) => (s.config as Record<string, unknown>)["tokenId"] === token.id,
    );
    if (!source) {
      const sourceId = newId("isr");
      await app.db.insert(ingestionSources).values({
        id: sourceId,
        companyId: token.companyId,
        projectId: null,
        name: `API token: ${token.name}`,
        kind: "api_token",
        config: { tokenId: token.id, tokenPrefix: token.tokenPrefix },
        createdBy: token.createdBy,
      });
      source = await fetchSource(sourceId, token.companyId);
    }

    // Implicit run. startedBy records the TOKEN, not a person — the whole
    // point of this inlet is that no operator session authored these rows.
    const runId = newId("irn");
    await app.db.insert(ingestionRuns).values({
      id: runId,
      companyId: token.companyId,
      projectId,
      sourceId: source.id,
      dataset: def.dataset,
      status: "staging",
      totalRows: body.records.length,
      startedBy: token.id,
    });
    const fieldKeys = def.fields.map((f) => f.key);
    const inserts: (typeof ingestedRecords.$inferInsert)[] = body.records.map((record, i) => {
      const payload: Record<string, unknown> = {};
      for (const key of fieldKeys) {
        if (record[key] !== undefined && record[key] !== null) payload[key] = record[key];
      }
      const extRaw = payload["externalId"];
      return {
        id: newId("irc"),
        runId,
        companyId: token.companyId,
        rowNumber: i + 1,
        externalId: typeof extRaw === "string" && extRaw.trim() !== "" ? extRaw.trim() : null,
        payload,
        status: "staged",
      };
    });
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await app.db.insert(ingestedRecords).values(inserts.slice(i, i + CHUNK));
    }
    await appendLedger(app.db, {
      companyId: token.companyId,
      actorId: null,
      action: "create",
      objectType: "ingestion_run",
      objectId: runId,
      payload: {
        via: "api_token_push",
        tokenId: token.id,
        tokenPrefix: token.tokenPrefix,
        dataset: def.dataset,
        projectId,
        received: body.records.length,
      },
      storePayload: true,
    });

    const run = await fetchRun(runId, token.companyId);
    const validation = await runValidation(run, null);
    let committed = 0;
    let skipped = 0;
    if (validation.staged > 0) {
      const validatedRun = await fetchRun(runId, token.companyId);
      // Real records carry the token creator's id (the columns demand a
      // user); the run + ledger carry the token itself as the pathway.
      const res = await runCommit(validatedRun, token.createdBy, null);
      committed = res.committed;
      skipped = res.skipped;
    }
    return reply.status(201).send({
      runId,
      dataset: def.dataset,
      received: body.records.length,
      staged: validation.staged,
      rejected: validation.rejected,
      committed,
      skipped,
      report: validation.report,
    });
  });

  /* ---------------------------------------------------------------- */
  /* OCDS export (Domain A #109)                                       */
  /* ---------------------------------------------------------------- */

  const ocdsGate = [app.authenticate, app.requireCompany, app.requireTool("ingestion", "read")];

  const OCDS_STATUS: Record<string, string> = {
    draft: "pending",
    executed: "active",
    completed: "terminated",
    terminated: "terminated",
  };

  app.get("/projects/:projectId/export/ocds", { preHandler: ocdsGate }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const [projectRow] = await app.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    const [companyRow] = await app.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const contractRows = await app.db
      .select()
      .from(contracts)
      .where(and(eq(contracts.companyId, companyId), eq(contracts.projectId, projectId)))
      .orderBy(asc(contracts.createdAt));
    const variationRows = await app.db
      .select()
      .from(variations)
      .where(and(eq(variations.companyId, companyId), eq(variations.projectId, projectId)))
      .orderBy(asc(variations.number));
    const valuationRows = await app.db
      .select({ id: valuations.id, contractId: valuations.contractId })
      .from(valuations)
      .where(and(eq(valuations.companyId, companyId), eq(valuations.projectId, projectId)));
    const certRows = await app.db
      .select()
      .from(paymentCertificates)
      .where(
        and(
          eq(paymentCertificates.companyId, companyId),
          eq(paymentCertificates.projectId, projectId),
        ),
      )
      .orderBy(asc(paymentCertificates.number));

    const valuationContract = new Map(valuationRows.map((v) => [v.id, v.contractId]));
    const contractIds = new Set(contractRows.map((c) => c.id));
    const variationsByContract = new Map<string, typeof variationRows>();
    let unlinkedVariations = 0;
    for (const v of variationRows) {
      if (v.contractId && contractIds.has(v.contractId)) {
        const list = variationsByContract.get(v.contractId) ?? [];
        list.push(v);
        variationsByContract.set(v.contractId, list);
      } else {
        unlinkedVariations += 1;
      }
    }
    const certsByContract = new Map<string, typeof certRows>();
    let unlinkedCerts = 0;
    for (const cert of certRows) {
      const contractId = valuationContract.get(cert.valuationId) ?? null;
      if (contractId && contractIds.has(contractId)) {
        const list = certsByContract.get(contractId) ?? [];
        list.push(cert);
        certsByContract.set(contractId, list);
      } else {
        unlinkedCerts += 1;
      }
    }

    const now = new Date().toISOString();
    const releases = contractRows.map((c) => {
      const parties: Record<string, unknown>[] = [];
      const partyNames = (c.parties ?? {}) as Record<string, string>;
      const party = (roleKey: string, ocdsRole: string) => {
        const name = partyNames[roleKey];
        if (!name) return null;
        const ref = { id: `${c.id}-${roleKey}`, name };
        parties.push({ ...ref, roles: [ocdsRole] });
        return ref;
      };
      const buyer = party("employer", "buyer");
      const supplier = party("contractor", "supplier");
      // partyRole is an open codelist; the contract administrator has no
      // exact standard role, so a descriptive extension value is used.
      party("administrator", "contractAdministrator");

      const amendments = (variationsByContract.get(c.id) ?? []).map((v) => ({
        id: v.id,
        date: v.instructedAt ?? v.createdAt,
        rationale: v.title,
        description: v.description ?? null,
        x_status: v.status,
        x_agreedValue: v.agreedValue ?? null,
      }));
      const transactions = (certsByContract.get(c.id) ?? []).map((cert) => ({
        id: cert.id,
        date: cert.issuedAt,
        value: { amount: cert.netCertified, currency: c.currency },
      }));
      return {
        // "unreg1" is deliberately NOT an Open Contracting Partnership
        // registered prefix — see x_scopeNote on the package.
        ocid: `ocds-unreg1-${projectId}-${c.id}`,
        id: `${c.id}-${now}`,
        date: now,
        language: "en",
        tag: ["contract"],
        initiationType: "tender",
        parties,
        buyer,
        awards: [
          {
            id: `${c.id}-award`,
            status: "active",
            date: c.createdAt,
            value: c.contractSum != null ? { amount: c.contractSum, currency: c.currency } : null,
            suppliers: supplier ? [supplier] : [],
          },
        ],
        contracts: [
          {
            id: c.id,
            awardID: `${c.id}-award`,
            title: c.name,
            status: OCDS_STATUS[c.status] ?? "pending",
            period:
              c.commencementDate || c.completionDate
                ? { startDate: c.commencementDate ?? null, endDate: c.completionDate ?? null }
                : null,
            value: c.contractSum != null ? { amount: c.contractSum, currency: c.currency } : null,
            amendments,
            implementation: { transactions },
          },
        ],
      };
    });

    // Data leaving the platform is a ledgered access event.
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "access",
      objectType: "ocds_export",
      objectId: projectId,
      payload: {
        releases: releases.length,
        variations: variationRows.length,
        certificates: certRows.length,
      },
    });

    return {
      uri: `urn:constructos:${companyId}:${projectId}:ocds:${now}`,
      version: "1.1",
      publishedDate: now,
      publisher: {
        name: companyRow?.name ?? "ConstructOS tenant",
        uid: companyId,
      },
      license: null,
      x_scopeNote:
        "PARTIAL MAPPING — read before relying on this package. It is generated only from the " +
        `contracts (${contractRows.length}), variations (${variationRows.length}) and payment ` +
        `certificates (${certRows.length}) recorded for project "${projectRow?.name ?? projectId}". ` +
        "The platform captures no tender or planning data, so those OCDS sections are absent. " +
        "The ocds-unreg1 prefix is NOT registered with the Open Contracting Partnership, and the " +
        "package URI is a URN, not a resolvable URL. Contract statuses are approximated onto the " +
        "OCDS codelist (draft→pending, executed→active, completed/terminated→terminated). " +
        "Variations are expressed as contract amendments and payment certificates as " +
        `implementation transactions. ${unlinkedVariations} variation(s) and ${unlinkedCerts} ` +
        "payment certificate(s) not linked to a contract are omitted from the releases.",
      releases,
    };
  });
};

/* re-exported for callers that need the registry without the plugin */
export type { DatasetDef };
export { datasetCatalog, datasetDef };
