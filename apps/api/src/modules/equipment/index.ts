import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  apiTokens,
  assuranceGrants,
  carbonFactors,
  equipment,
  equipmentAssignments,
  equipmentCertificates,
  equipmentMaintenanceRecords,
  equipmentMaintenanceSchedules,
  equipmentReadings,
  equipmentTelematicsReadings,
  equipmentUtilisation,
  ingestedRecords,
  ingestionRuns,
  ingestionSources,
  invoices,
  materialDeliveries,
  materialDeliveryLines,
  materialItems,
  materialStockMovements,
  nonConformanceReports,
  obligations,
  projects,
  signals,
  vendors,
} from "@constructos/db";
import {
  DELIVERY_DISCREPANCY_KINDS,
  DELIVERY_STATUSES,
  EQUIPMENT_ASSIGNMENT_STATUSES,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CERTIFICATE_TYPES,
  EQUIPMENT_CONDITIONS,
  EQUIPMENT_DATA_SOURCES,
  EQUIPMENT_OWNERSHIPS,
  EQUIPMENT_READING_TYPES,
  EQUIPMENT_STATUSES,
  FUEL_TYPES,
  HIRE_RATE_UNITS,
  IDLE_REASONS,
  MAINTENANCE_INTERVAL_KINDS,
  MAINTENANCE_RESULTS,
  MAINTENANCE_TYPES,
  MATERIAL_ITEM_STATUSES,
  METER_TYPES,
  SHIFTS,
  STOCK_MOVEMENT_TYPES,
  ASSIGNMENT_CANCEL_REASONS,
  TELEMATICS_PROVIDERS,
  type AssuranceRole,
  type HireRateUnit,
  type MaintenanceIntervalKind,
  type MeterType,
  type SignalSeverity,
  type StockMovementType,
} from "@constructos/shared";
import { hashPayload, sha256Hex } from "@constructos/ledger";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isExpired } from "../../lib/time.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import { computeTco2e, normaliseUnit, unitsMatch } from "../esg/carbon.js";
import {
  assessIdlePlant,
  computeDayCost,
  computeUtilisation,
  idleCostByCurrency,
  IDLE_SUSTAINED_DAYS,
  IDLE_UTILISATION_THRESHOLD_PERCENT,
  rankIdlePlant,
  round2,
  windowDays,
  type IdleDayInput,
  type IdlePlantAssessment,
  type UtilisationHours,
} from "./utilisation.js";
import {
  averageDailyUsage,
  computeNextDue,
  earliestDue,
  type ScheduleDue,
} from "./maintenance.js";
import { anomalySeverity, detectReadingAnomaly } from "./readings.js";
import {
  checkShortfall,
  classifyDeliveryLine,
  LOSS_MOVEMENT_TYPES,
  onHandDelta,
  reconcileStock,
  reservedDelta,
  signedQuantity,
} from "./stock.js";
import {
  assessFaults,
  checkGeofence,
  coerceTelematicsRow,
  engineHoursFromCounter,
  reconcileFuel,
  reconcileTelematics,
  TELEMATICS_DATASET,
  TELEMATICS_FIELDS,
  TELEMATICS_PERSISTENT_DAYS,
  TELEMATICS_PUSH_SCOPES,
  telematicsKey,
  type EquipmentReconcileInput,
  type TelematicsDayInput,
  type TelematicsFault,
} from "./telematics.js";
import {
  assessSupplyItem,
  detectDelayedDeliveries,
  MIN_DELIVERIES_TO_SCORE,
  PROCUREMENT_ALLOWANCE_DAYS,
  scoreSuppliers,
  valueInventory,
} from "./materials.js";
import {
  companyScopeOf,
  companyToolGate,
  scopeProjectFilter,
  type CompanyScope,
} from "./gates.js";
import {
  certificateVerdict,
  EQUIPMENT_DETECTORS,
  IN_SERVICE_ASSIGNMENT_STATUSES,
  isStatutoryCertificate,
  type EquipmentDetector,
} from "./signals.js";

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

const pad = (n: number): string => String(n).padStart(4, "0");

/** Lenient ISO timestamp — avoids zod version drift on `.datetime()`. */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const nonEmpty = (max: number) => z.string().min(1).max(max);
const idRef = z.string().min(1).max(64);
const money = z.number().finite();
const hours = z.number().finite().min(0).max(1000);

/** The ISO date a timestamp falls on, in UTC — the grain utilisation uses. */
function dateOf(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

const MAX_TELEMATICS_RECORDS = 5000;

/**
 * How far ahead the sweep looks for certificates. A certificate expiring in
 * two years cannot change state today, so scanning it on every read buys
 * nothing; anything inside this horizon can move to expiring or expired.
 */
const CERTIFICATE_HORIZON_DAYS = 120;

/** A read may trigger the sweep at most this often per company. */
const SWEEP_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * EQUIPMENT, PLANT & MATERIALS (M23) — tool key `equipment`.
 *
 * The register is built around the two questions that cost money and the two
 * independent evidence streams that answer them:
 *
 *  1. WHAT ARE WE PAYING FOR THAT IS NOT WORKING. `equipment_utilisation`
 *     splits the day into working / idle / standby / downtime, and
 *     `GET .../equipment-idle` finds hired plant with sustained low
 *     utilisation that nobody has off-hired — with the accumulated standing
 *     cost of the run stated, because "the 30-tonner has stood for nine
 *     days" is an observation and "the 30-tonne excavator has cost £6,300
 *     standing since the 4th" is a decision.
 *
 *  2. IS ANY OF THIS LAWFUL. `equipment_certificates.validTo` is the column
 *     the table exists for. An expired STATUTORY certificate on plant
 *     currently assigned to a project is a CRITICAL Signal — that is
 *     uninsured, unlawful operation, not overdue paperwork — raised by the
 *     same idempotent lazy sweep the insurance module uses (never a cron:
 *     the read is the trigger, and `evidenceRefs.key` is what stops one
 *     lapse being raised twice).
 *
 * TELEMATICS COMES IN THROUGH INGESTION, NOT THROUGH A SECOND INLET.
 * `POST /ingestion/push/telematics` sits alongside the ingestion module's own
 * `POST /ingestion/push/:dataset`: same `api_tokens` credential verified by
 * sha256, same implicit `ingestion_sources` row per token, same
 * `ingestion_runs` + `ingested_records` staging, same ledger provenance. The
 * readings land with `ingestionRunId`, `apiTokenId` and `sourceSha256`, and
 * `(providerKey, deviceId, recordedAt)` is unique so a replayed batch is
 * idempotent rather than doubled. A device nobody has mapped keeps its rows
 * with a null `equipmentId` and is listed for an operator to map — those
 * rows are the evidence of when the mapping was wrong.
 *
 * Then the part that is actually worth having: engine hours from the machine
 * reconciled against hours a person typed, exposed as a variance. It is the
 * ghost-worker pattern of `modules/workforce/reconcile.ts` applied to plant,
 * and a persistent variance is a Signal.
 *
 * DISCIPLINE, enforced by tests: no figure is fabricated when an input is
 * missing (null + `reasons`); money is never summed across currencies; an
 * approver or verifier may never be the creator (only an integrity reviewer
 * may knowingly self-verify, and the override is ledgered); every
 * consequential mutation appends to the ledger.
 *
 * ---------------------------------------------------------------------------
 * PLATFORM UPGRADE WAVE
 *
 *  • THE COMPANY ROUTES ARE GATED BY THE TOOL, not by company membership.
 *    `companyToolGate` (gates.ts) asks for `equipment` at the stated level on
 *    at least one project; before it, a company guest could read the whole
 *    fleet and the raw telematics feed, and any member could register plant,
 *    verify certificates and remap devices.
 *  • THE SWEEP IS A SCHEDULED JOB (`equipment.sweep`), bounded to certificates
 *    inside the expiry horizon and live schedules, debounced on the read path
 *    and run as the SYSTEM actor — it used to scan the whole fleet with
 *    per-row writes and ledger appends on every list and detail GET, under a
 *    read-only permission.
 *  • CERTIFICATE COVER IS PER TYPE. The latest validTo per (machine, type)
 *    decides whether a machine is out of certificate, and adding a renewal
 *    supersedes the earlier rows automatically. A renewal filed without
 *    `supersedesId` used to leave in-date plant flagged and raise a critical
 *    "stop the machine" signal against it.
 *  • ASSIGNMENTS CAN BE CANCELLED AND TRANSFERRED, and confirming an off-hire
 *    closes the live assignment; a hire that was approved and never arrived
 *    used to block the machine from every other project for good.
 *  • MATERIALS: order-by dates from lead time, shortage forecasts, delayed
 *    deliveries, supplier scorecards and inventory valuation
 *    (materials.ts), with `equipment.materials-supply` raising the signals.
 *  • Delivery receipt validates every line before writing any of them and
 *    books them in ONE transaction; stock movements take a row lock; company
 *    catalogue items hold no stock at all.
 */
export const equipmentModule: FastifyPluginAsync = async (app) => {
  const readGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("equipment", "read"),
  ];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("equipment", "standard"),
  ];
  /**
   * The fleet register sits ABOVE the projects, so `requireTool` (which
   * resolves permission through `:projectId`) cannot gate it. `companyToolGate`
   * asks the same question against every project the caller is a member of:
   * hold `equipment` at this level on at least one job, or be an owner/admin.
   * Before this the company routes ran on membership alone, and a company
   * guest could read the whole fleet, every certificate and the raw telematics
   * feed while any member could register, off-hire and verify plant.
   */
  const companyRead = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "equipment", "read"),
  ];
  const companyWrite = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "equipment", "standard"),
  ];
  /** Verification, off-hire and device remapping — the irreversible three. */
  const companyAdmin = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "equipment", "admin"),
  ];

  /* ---------------------------------------------------------------- */
  /* Fetchers and guards                                               */
  /* ---------------------------------------------------------------- */

  /** Run inside the caller's transaction, or open one. */
  async function withTx<T>(
    tx: Db | undefined,
    fn: (tx: Db) => Promise<T>,
  ): Promise<T> {
    if (tx) return fn(tx);
    return app.db.transaction(async (inner) => fn(inner as unknown as Db));
  }

  async function fetchEquipment(equipmentId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(equipment)
      .where(
        and(eq(equipment.id, equipmentId), eq(equipment.companyId, companyId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Equipment not found");
    return rows[0];
  }

  async function fetchAssignment(
    assignmentId: string,
    companyId: string,
    projectId: string,
  ) {
    const rows = await app.db
      .select()
      .from(equipmentAssignments)
      .where(
        and(
          eq(equipmentAssignments.id, assignmentId),
          eq(equipmentAssignments.companyId, companyId),
          eq(equipmentAssignments.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Equipment assignment not found");
    return rows[0];
  }

  async function fetchUtilisation(
    utilisationId: string,
    companyId: string,
    projectId: string,
  ) {
    const rows = await app.db
      .select()
      .from(equipmentUtilisation)
      .where(
        and(
          eq(equipmentUtilisation.id, utilisationId),
          eq(equipmentUtilisation.companyId, companyId),
          eq(equipmentUtilisation.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Utilisation record not found");
    return rows[0];
  }

  async function fetchCertificate(certificateId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(equipmentCertificates)
      .where(
        and(
          eq(equipmentCertificates.id, certificateId),
          eq(equipmentCertificates.companyId, companyId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Equipment certificate not found");
    return rows[0];
  }

  async function fetchMaintenanceRecord(recordId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(equipmentMaintenanceRecords)
      .where(
        and(
          eq(equipmentMaintenanceRecords.id, recordId),
          eq(equipmentMaintenanceRecords.companyId, companyId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Maintenance record not found");
    return rows[0];
  }

  async function fetchMaterialItem(
    itemId: string,
    companyId: string,
    projectId: string | null,
  ) {
    const rows = await app.db
      .select()
      .from(materialItems)
      .where(
        projectId
          ? and(
              eq(materialItems.id, itemId),
              eq(materialItems.companyId, companyId),
              or(
                eq(materialItems.projectId, projectId),
                isNull(materialItems.projectId),
              )!,
            )
          : and(
              eq(materialItems.id, itemId),
              eq(materialItems.companyId, companyId),
            ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Material item not found");
    return rows[0];
  }

  async function fetchDelivery(
    deliveryId: string,
    companyId: string,
    projectId: string,
  ) {
    const rows = await app.db
      .select()
      .from(materialDeliveries)
      .where(
        and(
          eq(materialDeliveries.id, deliveryId),
          eq(materialDeliveries.companyId, companyId),
          eq(materialDeliveries.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Delivery not found");
    return rows[0];
  }

  async function assertVendor(
    vendorId: string,
    companyId: string,
  ): Promise<void> {
    const rows = await app.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!rows[0])
      throw badRequest("supplierVendorId is not a vendor in this company");
  }

  async function assertProject(
    projectId: string,
    companyId: string,
  ): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!rows[0])
      throw badRequest("projectId is not a project in this company");
  }

  async function holdsAssuranceRole(
    req: FastifyRequest,
    roles: AssuranceRole[],
    projectId?: string | null,
  ): Promise<boolean> {
    const rows = await app.db
      .select()
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, req.companyId!),
          eq(assuranceGrants.userId, req.user!.id),
        ),
      );
    const nowMs = Date.now();
    return rows.some(
      (g) =>
        roles.includes(g.role as AssuranceRole) &&
        !isExpired(g.expiresAt, nowMs) &&
        (!g.projectId || !projectId || g.projectId === projectId),
    );
  }

  /**
   * ADR 0004 at the join: the actor who created or claimed a record may not
   * be the actor who attests to it. Only an integrity reviewer may knowingly
   * self-verify, and the override is returned so the caller can ledger it.
   *
   * Returns true when the act WAS a self-verification under override.
   */
  async function assertIndependent(
    req: FastifyRequest,
    creatorId: string | null,
    subject: string,
    projectId?: string | null,
  ): Promise<boolean> {
    if (!creatorId || creatorId !== req.user!.id) return false;
    const override = await holdsAssuranceRole(
      req,
      ["integrity_reviewer"],
      projectId ?? null,
    );
    if (!override) {
      throw forbidden(
        `${subject} is not independent of its author — the actor who created this record cannot ` +
          "also approve or verify it (ADR 0004). Have another user do it, or an integrity " +
          "reviewer do so knowingly.",
      );
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Signals                                                           */
  /* ---------------------------------------------------------------- */

  /** Keys already raised for a detector in this company — the idempotence
   *  guard the whole lazy-sweep pattern rests on. */
  async function alreadySignalled(
    companyId: string,
    detector: string,
    candidateKeys?: string[],
  ): Promise<Set<string>> {
    // Bounded by the keys we are about to consider: an unbounded scan of
    // every signal a detector ever raised runs on every list read.
    const clauses = [
      eq(signals.companyId, companyId),
      eq(signals.detector, detector),
    ];
    if (candidateKeys && candidateKeys.length > 0) {
      clauses.push(
        sql`${signals.evidenceRefs}->>'key' in (${sql.join(
          candidateKeys.map((k) => sql`${k}`),
          sql`, `,
        )})`,
      );
    } else if (candidateKeys) {
      return new Set<string>();
    }
    const rows = await app.db
      .select({ refs: signals.evidenceRefs })
      .from(signals)
      .where(and(...clauses));
    const keys = new Set<string>();
    for (const row of rows) {
      const refs = row.refs as { key?: unknown } | null;
      if (typeof refs?.key === "string") keys.add(refs.key);
    }
    return keys;
  }

  async function raiseSignalOnce(input: {
    companyId: string;
    projectId: string | null;
    detector: EquipmentDetector;
    key: string;
    severity: SignalSeverity;
    title: string;
    explanation: string;
    refs: Record<string, unknown>;
    seen: Set<string>;
  }): Promise<string | null> {
    if (input.seen.has(input.key)) return null;
    input.seen.add(input.key);
    const id = newId("sig");
    await app.db.insert(signals).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      detector: input.detector,
      severity: input.severity,
      confidence: 1,
      title: input.title,
      explanation: input.explanation,
      evidenceRefs: { key: input.key, ...input.refs },
    });
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* THE SWEEP — certificates and maintenance                          */
  /* ---------------------------------------------------------------- */

  /**
   * `equipment.nextCertificateExpiry` for one machine, computed the way the
   * question is actually asked: the EARLIEST of the LATEST certificate per
   * type. Two thorough examinations a year apart do not make a machine out of
   * certificate; a missing LOLER examination does.
   */
  async function refreshCertificateColumn(
    companyId: string,
    equipmentId: string,
  ): Promise<string | null> {
    const rows = await app.db
      .select({
        certificateType: equipmentCertificates.certificateType,
        validTo: equipmentCertificates.validTo,
      })
      .from(equipmentCertificates)
      .where(
        and(
          eq(equipmentCertificates.companyId, companyId),
          eq(equipmentCertificates.equipmentId, equipmentId),
          inArray(equipmentCertificates.status, [
            "valid",
            "expiring",
            "expired",
          ]),
        ),
      );
    const latestByType = new Map<string, string>();
    for (const r of rows) {
      const held = latestByType.get(r.certificateType);
      if (!held || r.validTo > held)
        latestByType.set(r.certificateType, r.validTo);
    }
    const next = [...latestByType.values()].sort()[0] ?? null;
    await app.db
      .update(equipment)
      .set({ nextCertificateExpiry: next, updatedAt: new Date().toISOString() })
      .where(eq(equipment.id, equipmentId));
    return next;
  }

  /**
   * The read path's entry to the sweep. The sweep proper is a scheduled job
   * (`equipment.sweep`); a read may still nudge it, but at most once every
   * five minutes per company and always as the SYSTEM actor, so a viewer with
   * read-only permission never appears in the ledger as the author of a
   * status flip they did not make. Disabled debouncing under test keeps the
   * suite deterministic.
   */
  const lastSweptAt = new Map<string, number>();
  async function maybeSweep(companyId: string): Promise<void> {
    if (process.env["NODE_ENV"] !== "test") {
      const now = Date.now();
      const last = lastSweptAt.get(companyId) ?? 0;
      if (now - last < SWEEP_MIN_INTERVAL_MS) return;
      lastSweptAt.set(companyId, now);
    }
    await sweepEquipment(companyId, null);
  }

  /** Which machines are on a project right now? An expired certificate in
   *  the yard is housekeeping; the same certificate on a machine that is
   *  lifting today is an unlawful lift. */
  async function inServiceEquipmentIds(
    companyId: string,
  ): Promise<Map<string, string>> {
    const rows = await app.db
      .select({
        equipmentId: equipmentAssignments.equipmentId,
        projectId: equipmentAssignments.projectId,
      })
      .from(equipmentAssignments)
      .where(
        and(
          eq(equipmentAssignments.companyId, companyId),
          inArray(equipmentAssignments.status, [
            ...IN_SERVICE_ASSIGNMENT_STATUSES,
          ]),
        ),
      );
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.equipmentId, r.projectId);
    return map;
  }

  /**
   * Idempotent expiry / overdue sweep, run on every equipment, certificate
   * and maintenance list read. The platform pattern (insurance, payments,
   * contract time bars): no cron, because a record nobody reads harms
   * nobody and the read is the moment the answer must be true.
   *
   * Three detectors, each keyed in `evidenceRefs.key`:
   *  - `equipment_certificate_expired_in_service`  key = certificateId
   *  - `equipment_certificate_expired`             key = certificateId
   *  - `equipment_maintenance_overdue_critical`    key = scheduleId
   *
   * Status flips (certificate → expiring/expired, schedule → due/overdue)
   * are a second, independent guard: a swept row leaves the candidate set,
   * so a repeated read writes nothing at all.
   */
  async function sweepEquipment(
    companyId: string,
    actorId: string | null,
  ): Promise<void> {
    const asOf = todayISO();
    const now = new Date().toISOString();

    /*
     * CANDIDATES, NOT THE WHOLE FLEET. This ran on every list and detail read
     * over every machine, every certificate and every signal the detectors had
     * ever raised, with per-row UPDATEs and ledger appends — hundreds of
     * milliseconds of write work triggered by a read-only viewer. Now it is a
     * scheduled job (equipment.sweep) plus a debounced read path, and the
     * candidate set is bounded to certificates inside the expiry horizon and
     * schedules that are actually live.
     */
    const horizon = addDaysISO(asOf, CERTIFICATE_HORIZON_DAYS);
    const dueCerts = await app.db
      .select({ equipmentId: equipmentCertificates.equipmentId })
      .from(equipmentCertificates)
      .where(
        and(
          eq(equipmentCertificates.companyId, companyId),
          lte(equipmentCertificates.validTo, horizon),
        ),
      );
    const liveSchedules = await app.db
      .select()
      .from(equipmentMaintenanceSchedules)
      .where(
        and(
          eq(equipmentMaintenanceSchedules.companyId, companyId),
          inArray(equipmentMaintenanceSchedules.status, [
            "active",
            "due",
            "overdue",
          ]),
        ),
      );
    const candidateIds = [
      ...new Set([
        ...dueCerts.map((c) => c.equipmentId),
        ...liveSchedules.map((s) => s.equipmentId),
      ]),
    ];
    if (candidateIds.length === 0) return;

    const fleet = await app.db
      .select()
      .from(equipment)
      .where(
        and(
          eq(equipment.companyId, companyId),
          inArray(equipment.id, candidateIds),
        ),
      );
    if (fleet.length === 0) return;
    const fleetById = new Map(fleet.map((e) => [e.id, e] as const));
    const inService = await inServiceEquipmentIds(companyId);

    /* (1) certificates — EVERY certificate of a candidate machine, because
     *     "is this machine out of certificate" is answered per TYPE: a valid
     *     thorough examination issued this year answers last year's expired
     *     row, and treating the old row as live is how a machine with current
     *     paperwork gets a critical "stop the machine" signal. */
    const certs = await app.db
      .select()
      .from(equipmentCertificates)
      .where(
        and(
          eq(equipmentCertificates.companyId, companyId),
          inArray(equipmentCertificates.equipmentId, candidateIds),
        ),
      );
    const liveCerts = certs.filter(
      (c) => c.status !== "revoked" && c.status !== "superseded",
    );
    /** the latest validTo per (equipmentId, certificateType) */
    const latestByType = new Map<string, string>();
    for (const cert of liveCerts) {
      const key = `${cert.equipmentId}|${cert.certificateType}`;
      const held = latestByType.get(key);
      if (!held || cert.validTo > held) latestByType.set(key, cert.validTo);
    }
    const certKeys = liveCerts.map((c) => c.id);
    const seenCritical = await alreadySignalled(
      companyId,
      "equipment_certificate_expired_in_service",
      certKeys,
    );
    const seenExpired = await alreadySignalled(
      companyId,
      "equipment_certificate_expired",
      certKeys,
    );
    /** earliest live expiry per machine, for the materialized column */
    const earliestExpiry = new Map<string, string>();

    for (const cert of liveCerts) {
      const machine = fleetById.get(cert.equipmentId);
      if (!machine) continue;
      const assignedProjectId =
        inService.get(cert.equipmentId) ?? machine.projectId ?? null;
      const verdict = certificateVerdict({
        validTo: cert.validTo,
        validFrom: cert.validFrom,
        certificateType: cert.certificateType,
        inService: assignedProjectId !== null,
        asOf,
      });
      const typeKey = `${cert.equipmentId}|${cert.certificateType}`;
      const latestForType = latestByType.get(typeKey) ?? cert.validTo;
      /** a newer certificate of the same type has taken over from this one */
      const superseded = latestForType > cert.validTo;
      if (!superseded) {
        const current = earliestExpiry.get(cert.equipmentId);
        if (!current || cert.validTo < current)
          earliestExpiry.set(cert.equipmentId, cert.validTo);
      }

      if (cert.status !== verdict.status) {
        await app.db
          .update(equipmentCertificates)
          .set({ status: verdict.status, updatedAt: now })
          .where(eq(equipmentCertificates.id, cert.id));
        await appendLedger(app.db, {
          companyId,
          actorId,
          action: "state_change",
          objectType: "equipment_certificate",
          objectId: cert.id,
          payload: {
            from: cert.status,
            to: verdict.status,
            validTo: cert.validTo,
            derived: true,
          },
          projectId: cert.projectId,
        });
      }

      if (
        verdict.status !== "expired" ||
        !verdict.detector ||
        !verdict.severity
      )
        continue;
      if (superseded) {
        // A later certificate of the same type covers this machine. The old
        // row expiring is bookkeeping, not an unlawful lift.
        continue;
      }
      // A lapsed renewal obligation is breached — the same time-bar machinery
      // the insurance module binds certificate renewal to (ADR 0012).
      if (cert.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "breached" })
          .where(
            and(
              eq(obligations.id, cert.obligationId),
              eq(obligations.status, "open"),
            ),
          );
      }
      const critical =
        verdict.detector === "equipment_certificate_expired_in_service";
      const seen = critical ? seenCritical : seenExpired;
      const signalId = await raiseSignalOnce({
        companyId,
        projectId: cert.projectId ?? assignedProjectId,
        detector: verdict.detector,
        key: cert.id,
        severity: verdict.severity,
        title: critical
          ? `Out of certificate on site — ${machine.reference} ${machine.name} (${cert.certificateType})`
          : `Equipment certificate expired — ${machine.reference} ${machine.name} (${cert.certificateType})`,
        explanation: critical
          ? `The ${cert.certificateType.replace(/_/g, " ")} for ${machine.reference} ` +
            `${machine.name}${cert.certificateNumber ? ` (cert. ${cert.certificateNumber})` : ""} ` +
            `ran to ${cert.validTo} and has expired, and the machine is currently assigned to a ` +
            `project. Operating statutory plant without an in-date examination is unlawful, and it ` +
            `is uninsured: the hire company's and your own policies both answer a loss by asking for ` +
            `the certificate. Stop the machine, quarantine it, and get a competent person to it — ` +
            `an inspector who arrives before you do will do the first two for you.`
          : `The ${cert.certificateType.replace(/_/g, " ")} for ${machine.reference} ` +
            `${machine.name} ran to ${cert.validTo} and has expired. The machine is not currently ` +
            `assigned to a project, so nothing unlawful is happening yet — but it cannot be ` +
            `mobilised until the certificate is renewed, and finding that out on the morning it is ` +
            `needed is how a week gets lost.`,
        refs: {
          certificateId: cert.id,
          equipmentId: cert.equipmentId,
          equipmentReference: machine.reference,
          certificateType: cert.certificateType,
          validTo: cert.validTo,
          statutory: isStatutoryCertificate(cert.certificateType),
          inServiceProjectId: assignedProjectId,
        },
        seen,
      });
      if (signalId && !cert.signalId) {
        await app.db
          .update(equipmentCertificates)
          .set({ signalId, updatedAt: now })
          .where(eq(equipmentCertificates.id, cert.id));
      }
    }

    /* (2) maintenance schedules — already loaded as sweep candidates */
    const schedules = liveSchedules;
    const seenOverdue = await alreadySignalled(
      companyId,
      "equipment_maintenance_overdue_critical",
      schedules.map((sch) => sch.id),
    );
    /** earliest computed due date per machine, for the materialized column */
    const earliestDueAt = new Map<string, string>();

    for (const schedule of schedules) {
      const machine = fleetById.get(schedule.equipmentId);
      if (!machine) continue;
      const due = computeNextDue({
        intervalKind: schedule.intervalKind as MaintenanceIntervalKind,
        intervalValue: schedule.intervalValue,
        warnAheadValue: schedule.warnAheadValue,
        lastPerformedAt: schedule.lastPerformedAt,
        lastPerformedMeter: schedule.lastPerformedMeter,
        currentMeter: machine.currentMeterReading,
        meterType: machine.meterType as MeterType,
        baselineDate: machine.hireStartDate ?? machine.purchaseDate,
        baselineMeter: null,
        averageDailyUsage: null,
        asOf,
      });
      const nextStatus =
        due.status === "overdue"
          ? "overdue"
          : due.status === "due_soon"
            ? "due"
            : "active";
      const changed =
        schedule.status !== nextStatus ||
        schedule.nextDueAt !== due.nextDueAt ||
        schedule.nextDueMeter !== due.nextDueMeter;
      if (changed) {
        await app.db
          .update(equipmentMaintenanceSchedules)
          .set({
            status: nextStatus,
            nextDueAt: due.nextDueAt,
            nextDueMeter: due.nextDueMeter,
            updatedAt: now,
          })
          .where(eq(equipmentMaintenanceSchedules.id, schedule.id));
        await appendLedger(app.db, {
          companyId,
          actorId,
          action: "state_change",
          objectType: "equipment_maintenance_schedule",
          objectId: schedule.id,
          payload: {
            from: schedule.status,
            to: nextStatus,
            nextDueAt: due.nextDueAt,
            nextDueMeter: due.nextDueMeter,
            derived: true,
          },
          projectId: schedule.projectId,
        });
      }
      const candidate = due.nextDueAt ?? due.projectedDueAt;
      if (candidate) {
        const held = earliestDueAt.get(schedule.equipmentId);
        if (!held || candidate < held)
          earliestDueAt.set(schedule.equipmentId, candidate);
      }

      // Overdue maintenance on CRITICAL plant only. Every machine on a site
      // has a service coming; the ones whose failure stops the job or hurts
      // somebody are the ones worth a Signal.
      if (due.status !== "overdue" || machine.isCritical !== 1) continue;
      const assignedProjectId =
        inService.get(schedule.equipmentId) ?? machine.projectId ?? null;
      await raiseSignalOnce({
        companyId,
        projectId: schedule.projectId ?? assignedProjectId,
        detector: "equipment_maintenance_overdue_critical",
        key: schedule.id,
        severity: schedule.isStatutory === 1 ? "critical" : "high",
        title: `Overdue maintenance on critical plant — ${machine.reference} ${schedule.name}`,
        explanation:
          `"${schedule.name}" on ${machine.reference} ${machine.name} is overdue by ` +
          `${due.overdueBy ? `${due.overdueBy.value} ${due.overdueBy.unit}` : "an unknown margin"}` +
          `${due.nextDueMeter !== null ? ` (due at meter ${due.nextDueMeter}, machine reads ${machine.currentMeterReading ?? "unknown"})` : ""}` +
          `${due.nextDueAt ? ` (due ${due.nextDueAt})` : ""}. This machine is flagged CRITICAL: its ` +
          `failure stops the works or endangers somebody, which is the entire reason the interval ` +
          `exists. Running past a manufacturer's interval also voids the warranty and, on hired ` +
          `plant, hands the hire company a defence to any damage claim.`,
        refs: {
          scheduleId: schedule.id,
          equipmentId: schedule.equipmentId,
          equipmentReference: machine.reference,
          intervalKind: schedule.intervalKind,
          nextDueAt: due.nextDueAt,
          nextDueMeter: due.nextDueMeter,
          overdueBy: due.overdueBy,
          isStatutory: schedule.isStatutory === 1,
        },
        seen: seenOverdue,
      });
    }

    /* (3) materialized "next expiry / next service" columns on the machine */
    for (const machine of fleet) {
      const nextCert = earliestExpiry.get(machine.id) ?? null;
      const nextMaint = earliestDueAt.get(machine.id) ?? null;
      if (
        machine.nextCertificateExpiry === nextCert &&
        machine.nextMaintenanceDue === nextMaint
      ) {
        continue;
      }
      await app.db
        .update(equipment)
        .set({
          nextCertificateExpiry: nextCert,
          nextMaintenanceDue: nextMaint,
          updatedAt: now,
        })
        .where(eq(equipment.id, machine.id));
    }
  }

  /* ================================================================ */
  /* THE REGISTER — company-wide, across every ownership kind          */
  /* ================================================================ */

  const equipmentCreateSchema = z.object({
    name: nonEmpty(200),
    description: z.string().max(4000).optional(),
    assetTag: z.string().max(100).nullable().optional(),
    category: z.enum(EQUIPMENT_CATEGORIES).default("other"),
    equipmentType: z.string().max(120).nullable().optional(),
    ownership: z.enum(EQUIPMENT_OWNERSHIPS).default("owned"),
    manufacturer: z.string().max(120).nullable().optional(),
    model: z.string().max(120).nullable().optional(),
    serialNumber: z.string().max(120).nullable().optional(),
    registrationNumber: z.string().max(60).nullable().optional(),
    yearOfManufacture: z
      .number()
      .int()
      .min(1900)
      .max(2200)
      .nullable()
      .optional(),
    capacity: z.string().max(120).nullable().optional(),
    projectId: idRef.nullable().optional(),
    purchaseDate: isoDateSchema.nullable().optional(),
    purchaseCost: money.nullable().optional(),
    bookValue: money.nullable().optional(),
    internalRateAmount: money.nullable().optional(),
    supplierVendorId: idRef.nullable().optional(),
    hireAgreementRef: z.string().max(120).nullable().optional(),
    commitmentId: idRef.nullable().optional(),
    hireRateAmount: money.nullable().optional(),
    hireRateUnit: z.enum(HIRE_RATE_UNITS).nullable().optional(),
    idleRateAmount: money.nullable().optional(),
    operatorRateAmount: money.nullable().optional(),
    currency: z.string().length(3).default("USD"),
    hireStartDate: isoDateSchema.nullable().optional(),
    hireEndDate: isoDateSchema.nullable().optional(),
    status: z.enum(EQUIPMENT_STATUSES).default("available"),
    condition: z.enum(EQUIPMENT_CONDITIONS).default("good"),
    locationId: idRef.nullable().optional(),
    locationText: z.string().max(300).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    currentOperatorWorkerId: idRef.nullable().optional(),
    meterType: z.enum(METER_TYPES).default("hours"),
    currentMeterReading: z.number().finite().min(0).nullable().optional(),
    fuelType: z.enum(FUEL_TYPES).default("diesel"),
    fuelCapacityLitres: z.number().finite().min(0).nullable().optional(),
    carbonFactorId: idRef.nullable().optional(),
    telematicsProvider: z.enum(TELEMATICS_PROVIDERS).nullable().optional(),
    telematicsDeviceId: z.string().max(200).nullable().optional(),
    requiresCertification: z.boolean().default(false),
    isCritical: z.boolean().default(false),
    costCodeId: idRef.nullable().optional(),
    budgetLineItemId: idRef.nullable().optional(),
    photoFileIds: z.array(idRef).max(50).optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  const equipmentPatchSchema = equipmentCreateSchema
    .partial()
    .omit({ currency: true })
    .extend({ currency: z.string().length(3).optional() });

  const equipmentListQuery = pageQuerySchema.extend({
    category: z.enum(EQUIPMENT_CATEGORIES).optional(),
    ownership: z.enum(EQUIPMENT_OWNERSHIPS).optional(),
    status: z.enum(EQUIPMENT_STATUSES).optional(),
    projectId: idRef.optional(),
    isCritical: z.coerce.boolean().optional(),
    /** only machines whose earliest certificate expiry has passed */
    outOfCertificate: z.coerce.boolean().optional(),
    q: z.string().max(200).optional(),
  });

  /**
   * The register row plus the two derived facts nobody can read off the
   * columns: whether the machine is currently out of certificate, and
   * whether a hire is still running that nobody has stopped.
   */
  function decorateEquipment(row: typeof equipment.$inferSelect, asOf: string) {
    const outOfCertificate =
      row.nextCertificateExpiry !== null && row.nextCertificateExpiry < asOf;
    const onHire = ["hired", "operator_hired", "leased"].includes(
      row.ownership,
    );
    const hireRunning = onHire && row.offHiredAt === null;
    const offHireRequestedNotCollected =
      row.offHireRequestedAt !== null && row.offHiredAt === null;
    return {
      ...row,
      requiresCertification: row.requiresCertification === 1,
      isCritical: row.isCritical === 1,
      derived: {
        asOf,
        outOfCertificate,
        onHire,
        hireRunning,
        offHireRequestedNotCollected,
        hireOverrun:
          hireRunning && row.hireEndDate !== null && row.hireEndDate < asOf
            ? `the agreed hire end was ${row.hireEndDate} and the machine has not been off-hired — ` +
              "every day since is being charged at the full rate"
            : null,
        maintenanceOverdue:
          row.nextMaintenanceDue !== null && row.nextMaintenanceDue < asOf,
      },
    };
  }

  async function nextEquipmentNumber(
    companyId: string,
  ): Promise<{ number: number; reference: string }> {
    const number = await nextRecordNumber(app.db, companyId, "equipment");
    return { number, reference: `EQP-${pad(number)}` };
  }

  app.post(
    "/companies/current/equipment",
    { preHandler: companyWrite },
    async (req, reply) => {
      const body = equipmentCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      if (body.supplierVendorId)
        await assertVendor(body.supplierVendorId, companyId);
      if (body.projectId) await assertProject(body.projectId, companyId);
      if (body.hireRateAmount != null && !body.hireRateUnit) {
        throw badRequest(
          "a hire rate amount was given with no hireRateUnit — an amount with no unit cannot be " +
            "turned into a day's cost, which is the only thing the rate is for",
        );
      }
      if (
        body.hireStartDate &&
        body.hireEndDate &&
        body.hireEndDate < body.hireStartDate
      ) {
        throw badRequest(
          `hireEndDate ${body.hireEndDate} falls before hireStartDate ${body.hireStartDate}`,
        );
      }
      const { number, reference } = await nextEquipmentNumber(companyId);
      const id = newId("eqp");
      await app.db.insert(equipment).values({
        id,
        companyId,
        projectId: body.projectId ?? null,
        number,
        reference,
        assetTag: body.assetTag ?? null,
        name: body.name,
        description: body.description ?? null,
        category: body.category,
        equipmentType: body.equipmentType ?? null,
        ownership: body.ownership,
        manufacturer: body.manufacturer ?? null,
        model: body.model ?? null,
        serialNumber: body.serialNumber ?? null,
        registrationNumber: body.registrationNumber ?? null,
        yearOfManufacture: body.yearOfManufacture ?? null,
        capacity: body.capacity ?? null,
        purchaseDate: body.purchaseDate ?? null,
        purchaseCost: body.purchaseCost ?? null,
        bookValue: body.bookValue ?? null,
        internalRateAmount: body.internalRateAmount ?? null,
        supplierVendorId: body.supplierVendorId ?? null,
        hireAgreementRef: body.hireAgreementRef ?? null,
        commitmentId: body.commitmentId ?? null,
        hireRateAmount: body.hireRateAmount ?? null,
        hireRateUnit: body.hireRateUnit ?? null,
        idleRateAmount: body.idleRateAmount ?? null,
        operatorRateAmount: body.operatorRateAmount ?? null,
        currency: body.currency,
        hireStartDate: body.hireStartDate ?? null,
        hireEndDate: body.hireEndDate ?? null,
        status: body.status,
        condition: body.condition,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        currentOperatorWorkerId: body.currentOperatorWorkerId ?? null,
        meterType: body.meterType,
        currentMeterReading: body.currentMeterReading ?? null,
        fuelType: body.fuelType,
        fuelCapacityLitres: body.fuelCapacityLitres ?? null,
        carbonFactorId: body.carbonFactorId ?? null,
        telematicsProvider: body.telematicsProvider ?? null,
        telematicsDeviceId: body.telematicsDeviceId ?? null,
        requiresCertification: body.requiresCertification ? 1 : 0,
        isCritical: body.isCritical ? 1 : 0,
        costCodeId: body.costCodeId ?? null,
        budgetLineItemId: body.budgetLineItemId ?? null,
        photoFileIds: body.photoFileIds ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "equipment",
        objectId: id,
        projectId: body.projectId ?? null,
        payload: {
          reference,
          name: body.name,
          category: body.category,
          ownership: body.ownership,
          hireRateAmount: body.hireRateAmount ?? null,
          hireRateUnit: body.hireRateUnit ?? null,
          currency: body.currency,
          hireStartDate: body.hireStartDate ?? null,
          hireEndDate: body.hireEndDate ?? null,
          isCritical: body.isCritical,
        },
        storePayload: true,
      });
      const created = await fetchEquipment(id, companyId);
      return reply.status(201).send(decorateEquipment(created, todayISO()));
    },
  );

  app.get(
    "/companies/current/equipment",
    { preHandler: companyRead },
    async (req) => {
      const q = equipmentListQuery.parse(req.query);
      const companyId = req.companyId!;
      await maybeSweep(companyId);
      const asOf = todayISO();
      const clauses = [eq(equipment.companyId, companyId)];
      if (q.category) clauses.push(eq(equipment.category, q.category));
      if (q.ownership) clauses.push(eq(equipment.ownership, q.ownership));
      if (q.status) clauses.push(eq(equipment.status, q.status));
      if (q.projectId) clauses.push(eq(equipment.projectId, q.projectId));
      if (q.isCritical !== undefined)
        clauses.push(eq(equipment.isCritical, q.isCritical ? 1 : 0));
      if (q.outOfCertificate) {
        clauses.push(isNotNull(equipment.nextCertificateExpiry));
        clauses.push(
          lte(equipment.nextCertificateExpiry, addDaysISO(asOf, -1)),
        );
      }
      if (q.q) {
        clauses.push(
          or(
            sql`lower(${equipment.name}) like ${`%${q.q.toLowerCase()}%`}`,
            sql`lower(${equipment.reference}) like ${`%${q.q.toLowerCase()}%`}`,
            sql`lower(coalesce(${equipment.assetTag}, '')) like ${`%${q.q.toLowerCase()}%`}`,
          )!,
        );
      }
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(equipment)
        .where(where);
      const rows = await app.db
        .select()
        .from(equipment)
        .where(where)
        .orderBy(asc(equipment.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(
        rows.map((r) => decorateEquipment(r, asOf)),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.get(
    "/companies/current/equipment/:equipmentId",
    { preHandler: companyRead },
    async (req) => {
      const { equipmentId } = req.params as { equipmentId: string };
      await fetchEquipment(equipmentId, req.companyId!); // 404 before sweeping
      await maybeSweep(req.companyId!);
      const asOf = todayISO();
      const machine = await fetchEquipment(equipmentId, req.companyId!);
      const certs = await app.db
        .select()
        .from(equipmentCertificates)
        .where(eq(equipmentCertificates.equipmentId, equipmentId))
        .orderBy(asc(equipmentCertificates.validTo));
      const assignments = await app.db
        .select()
        .from(equipmentAssignments)
        .where(eq(equipmentAssignments.equipmentId, equipmentId))
        .orderBy(desc(equipmentAssignments.assignedFrom));
      const schedules = await app.db
        .select()
        .from(equipmentMaintenanceSchedules)
        .where(eq(equipmentMaintenanceSchedules.equipmentId, equipmentId));
      const inService = await inServiceEquipmentIds(req.companyId!);
      const scheduleDue: ScheduleDue[] = schedules.map((s) => ({
        scheduleId: s.id,
        name: s.name,
        intervalKind: s.intervalKind as MaintenanceIntervalKind,
        isStatutory: s.isStatutory === 1,
        ...computeNextDue({
          intervalKind: s.intervalKind as MaintenanceIntervalKind,
          intervalValue: s.intervalValue,
          warnAheadValue: s.warnAheadValue,
          lastPerformedAt: s.lastPerformedAt,
          lastPerformedMeter: s.lastPerformedMeter,
          currentMeter: machine.currentMeterReading,
          meterType: machine.meterType as MeterType,
          baselineDate: machine.hireStartDate ?? machine.purchaseDate,
          asOf,
        }),
      }));
      return {
        ...decorateEquipment(machine, asOf),
        inServiceProjectId: inService.get(equipmentId) ?? null,
        certificates: certs.map((c) => ({
          ...c,
          verdict: certificateVerdict({
            validTo: c.validTo,
            validFrom: c.validFrom,
            certificateType: c.certificateType,
            inService: inService.has(equipmentId),
            asOf,
          }),
        })),
        assignments,
        maintenance: {
          schedules: scheduleDue,
          governing: earliestDue(scheduleDue),
        },
      };
    },
  );

  app.patch(
    "/companies/current/equipment/:equipmentId",
    { preHandler: companyWrite },
    async (req) => {
      const { equipmentId } = req.params as { equipmentId: string };
      const body = equipmentPatchSchema.parse(req.body);
      const companyId = req.companyId!;
      const before = await fetchEquipment(equipmentId, companyId);
      if (body.supplierVendorId)
        await assertVendor(body.supplierVendorId, companyId);
      if (body.projectId) await assertProject(body.projectId, companyId);
      const patch: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        if (key === "requiresCertification" || key === "isCritical") {
          patch[key] = value ? 1 : 0;
        } else {
          patch[key] = value;
        }
      }
      await app.db
        .update(equipment)
        .set(patch)
        .where(eq(equipment.id, equipmentId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "equipment",
        objectId: equipmentId,
        projectId: before.projectId,
        payload: { changed: Object.keys(body) },
      });
      return decorateEquipment(
        await fetchEquipment(equipmentId, companyId),
        todayISO(),
      );
    },
  );

  /**
   * Acceptance of a machine onto site. The schema comment on
   * `equipment.verifiedBy` says it: never the person who requested the hire.
   * Somebody signing off their own hire is how plant arrives without a
   * certificate and nobody notices until it does not lift.
   */
  app.post(
    "/companies/current/equipment/:equipmentId/verify",
    { preHandler: companyAdmin },
    async (req) => {
      const { equipmentId } = req.params as { equipmentId: string };
      const body = z
        .object({
          note: z.string().max(2000).optional(),
          condition: z.enum(EQUIPMENT_CONDITIONS).optional(),
        })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const machine = await fetchEquipment(equipmentId, companyId);
      const override = await assertIndependent(
        req,
        machine.createdBy,
        "equipment acceptance",
        machine.projectId,
      );
      const now = new Date().toISOString();
      await app.db
        .update(equipment)
        .set({
          verifiedBy: req.user!.id,
          verifiedAt: now,
          condition: body.condition ?? machine.condition,
          updatedAt: now,
        })
        .where(eq(equipment.id, equipmentId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment",
        objectId: equipmentId,
        projectId: machine.projectId,
        payload: {
          verified: true,
          note: body.note ?? null,
          registeredBy: machine.createdBy,
          selfVerifiedUnderOverride: override,
        },
        storePayload: true,
      });
      return {
        ...decorateEquipment(
          await fetchEquipment(equipmentId, companyId),
          todayISO(),
        ),
        independentVerification: !override,
      };
    },
  );

  /**
   * OFF-HIRE — the single most avoidable cost on a project.
   *
   * Two acts, deliberately separate: `request` records the day somebody
   * asked for the machine to go back (which is the date a credit will be
   * argued from), and `confirm` records the day it actually went. The gap
   * between them is pure loss and is reported rather than smoothed over.
   */
  app.post(
    "/companies/current/equipment/:equipmentId/off-hire",
    { preHandler: companyAdmin },
    async (req) => {
      const { equipmentId } = req.params as { equipmentId: string };
      const body = z
        .object({
          action: z.enum(["request", "confirm", "cancel"]),
          at: isoTimestamp.optional(),
          reference: z.string().max(120).nullable().optional(),
          note: z.string().max(2000).optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const machine = await fetchEquipment(equipmentId, companyId);
      if (!["hired", "operator_hired", "leased"].includes(machine.ownership)) {
        throw badRequest(
          `${machine.reference} is ${machine.ownership}, not hired — there is no hire to stop. ` +
            "Owned plant is released by ending its assignment, not by off-hiring it.",
        );
      }
      const at = body.at
        ? new Date(body.at).toISOString()
        : new Date().toISOString();
      const now = new Date().toISOString();
      if (body.action === "request") {
        if (machine.offHiredAt) {
          throw conflict(
            `${machine.reference} was already off-hired on ${machine.offHiredAt} — the charge has stopped`,
          );
        }
        await app.db
          .update(equipment)
          .set({
            offHireRequestedAt: at,
            offHireReference: body.reference ?? machine.offHireReference,
            status: "off_hire_requested",
            updatedAt: now,
          })
          .where(eq(equipment.id, equipmentId));
      } else if (body.action === "confirm") {
        if (!machine.offHireRequestedAt) {
          throw badRequest(
            "off-hire has never been requested for this machine — record the request first, " +
              "because the request date is the date any credit for standing time runs from",
          );
        }
        await app.db
          .update(equipment)
          .set({
            offHiredAt: at,
            offHireReference: body.reference ?? machine.offHireReference,
            status: "off_hired",
            projectId: null,
            currentAssignmentId: null,
            updatedAt: now,
          })
          .where(eq(equipment.id, equipmentId));
        /*
         * THE ASSIGNMENT GOES BACK WITH THE MACHINE. Clearing
         * equipment.projectId while leaving a live assignment row on_site kept
         * the machine in `inServiceEquipmentIds`, so a returned machine still
         * counted as on the project — and its certificates were still judged
         * as "in service", which is what makes the critical detector fire.
         */
        const live = await app.db
          .select()
          .from(equipmentAssignments)
          .where(
            and(
              eq(equipmentAssignments.companyId, companyId),
              eq(equipmentAssignments.equipmentId, equipmentId),
              inArray(equipmentAssignments.status, [...IN_SERVICE_ASSIGNMENT_STATUSES]),
            ),
          );
        for (const assignment of live) {
          await app.db
            .update(equipmentAssignments)
            .set({
              status: "returned",
              returnedAt: at,
              assignedTo: assignment.assignedTo ?? at.slice(0, 10),
              updatedAt: now,
            })
            .where(eq(equipmentAssignments.id, assignment.id));
          await appendLedger(app.db, {
            companyId,
            actorId: req.user!.id,
            action: "state_change",
            objectType: "equipment_assignment",
            objectId: assignment.id,
            projectId: assignment.projectId,
            payload: {
              from: assignment.status,
              to: "returned",
              closedBy: "off_hire_confirm",
              equipmentId,
              at,
            },
          });
        }
      } else {
        await app.db
          .update(equipment)
          .set({
            offHireRequestedAt: null,
            offHiredAt: null,
            status: machine.currentAssignmentId ? "in_use" : "available",
            updatedAt: now,
          })
          .where(eq(equipment.id, equipmentId));
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment",
        objectId: equipmentId,
        projectId: machine.projectId,
        payload: {
          offHire: body.action,
          at,
          reference: body.reference ?? null,
          note: body.note ?? null,
          previousStatus: machine.status,
        },
        storePayload: true,
      });
      const after = await fetchEquipment(equipmentId, companyId);
      const standingDays =
        after.offHireRequestedAt && after.offHiredAt
          ? Math.max(
              0,
              Math.round(
                (Date.parse(after.offHiredAt) -
                  Date.parse(after.offHireRequestedAt)) /
                  86_400_000,
              ),
            )
          : null;
      return {
        ...decorateEquipment(after, todayISO()),
        collectionDelayDays: standingDays,
        collectionDelayNote:
          standingDays !== null && standingDays > 0
            ? `${standingDays} day(s) passed between the off-hire request and collection. Under ` +
              "most hire conditions the charge stops on notice, not on collection — check the " +
              "invoice against the request reference."
            : null,
      };
    },
  );

  /* ================================================================ */
  /* ASSIGNMENTS — mobilisation, condition, damage on return           */
  /* ================================================================ */

  const assignmentCreateSchema = z.object({
    equipmentId: idRef,
    assignedFrom: isoDateSchema,
    assignedTo: isoDateSchema.nullable().optional(),
    fromProjectId: idRef.nullable().optional(),
    locationId: idRef.nullable().optional(),
    scheduleActivityId: idRef.nullable().optional(),
    costCodeId: idRef.nullable().optional(),
    budgetLineItemId: idRef.nullable().optional(),
    operatorWorkerId: idRef.nullable().optional(),
    crewId: idRef.nullable().optional(),
    mobilisationCost: money.nullable().optional(),
    demobilisationCost: money.nullable().optional(),
    currency: z.string().length(3).optional(),
    transportDocketRef: z.string().max(120).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  const assignmentListQuery = pageQuerySchema.extend({
    status: z.enum(EQUIPMENT_ASSIGNMENT_STATUSES).optional(),
    equipmentId: idRef.optional(),
  });

  app.post(
    "/projects/:projectId/equipment/assignments",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = assignmentCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const machine = await fetchEquipment(body.equipmentId, companyId);
      if (body.assignedTo && body.assignedTo < body.assignedFrom) {
        throw badRequest(
          `assignedTo ${body.assignedTo} falls before assignedFrom ${body.assignedFrom}`,
        );
      }
      if (machine.offHiredAt) {
        throw badRequest(
          `${machine.reference} was off-hired on ${machine.offHiredAt} and is no longer on the ` +
            "fleet — a returned machine cannot be assigned to a project",
        );
      }
      // An overlapping live assignment means one machine in two places. It is
      // always a data error and it always corrupts the utilisation figures.
      const live = await app.db
        .select({
          id: equipmentAssignments.id,
          projectId: equipmentAssignments.projectId,
        })
        .from(equipmentAssignments)
        .where(
          and(
            eq(equipmentAssignments.equipmentId, body.equipmentId),
            inArray(equipmentAssignments.status, [
              "approved",
              "mobilising",
              "on_site",
            ]),
          ),
        );
      if (live.length > 0) {
        throw conflict(
          `${machine.reference} is already assigned (assignment ${live[0]!.id} on project ` +
            `${live[0]!.projectId}). Demobilise it before assigning it elsewhere — one machine ` +
            "cannot be on two projects, and a register that says it is will bill both.",
        );
      }
      const id = newId("eqa");
      await app.db.insert(equipmentAssignments).values({
        id,
        companyId,
        projectId,
        equipmentId: body.equipmentId,
        fromProjectId: body.fromProjectId ?? null,
        status: "requested",
        assignedFrom: body.assignedFrom,
        assignedTo: body.assignedTo ?? null,
        locationId: body.locationId ?? null,
        scheduleActivityId: body.scheduleActivityId ?? null,
        costCodeId: body.costCodeId ?? machine.costCodeId,
        budgetLineItemId: body.budgetLineItemId ?? machine.budgetLineItemId,
        operatorWorkerId: body.operatorWorkerId ?? null,
        crewId: body.crewId ?? null,
        mobilisationCost: body.mobilisationCost ?? null,
        demobilisationCost: body.demobilisationCost ?? null,
        currency: body.currency ?? machine.currency,
        transportDocketRef: body.transportDocketRef ?? null,
        notes: body.notes ?? null,
        requestedBy: req.user!.id,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "equipment_assignment",
        objectId: id,
        projectId,
        payload: {
          equipmentId: body.equipmentId,
          equipmentReference: machine.reference,
          assignedFrom: body.assignedFrom,
          assignedTo: body.assignedTo ?? null,
          mobilisationCost: body.mobilisationCost ?? null,
          currency: body.currency ?? machine.currency,
        },
        storePayload: true,
      });
      const created = await fetchAssignment(id, companyId, projectId);
      return reply.status(201).send({
        ...created,
        equipment: decorateEquipment(machine, todayISO()),
        mobilisationNote:
          body.mobilisationCost === null || body.mobilisationCost === undefined
            ? "no mobilisation cost was recorded — transport is the cost most often forgotten " +
              "until the haulier's invoice arrives, and it is rarely in the hire rate"
            : null,
      });
    },
  );

  app.get(
    "/projects/:projectId/equipment/assignments",
    { preHandler: readGate },
    async (req) => {
      const q = assignmentListQuery.parse(req.query);
      const clauses = [
        eq(equipmentAssignments.companyId, req.companyId!),
        eq(equipmentAssignments.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(equipmentAssignments.status, q.status));
      if (q.equipmentId)
        clauses.push(eq(equipmentAssignments.equipmentId, q.equipmentId));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(equipmentAssignments)
        .where(where);
      const rows = await app.db
        .select()
        .from(equipmentAssignments)
        .where(where)
        .orderBy(desc(equipmentAssignments.assignedFrom))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows, Number(totalRow?.n ?? 0), q);
    },
  );

  app.get(
    "/projects/:projectId/equipment/assignments/:assignmentId",
    { preHandler: readGate },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const row = await fetchAssignment(
        assignmentId,
        req.companyId!,
        req.projectId!,
      );
      const machine = await fetchEquipment(row.equipmentId, req.companyId!);
      return { ...row, equipment: decorateEquipment(machine, todayISO()) };
    },
  );

  app.patch(
    "/projects/:projectId/equipment/assignments/:assignmentId",
    { preHandler: standardGate },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const body = assignmentCreateSchema
        .partial()
        .omit({ equipmentId: true })
        .parse(req.body);
      const existing = await fetchAssignment(
        assignmentId,
        req.companyId!,
        req.projectId!,
      );
      if (existing.status === "returned" || existing.status === "cancelled") {
        throw badRequest(
          `this assignment is ${existing.status} — it is a closed record of what happened and is ` +
            "not editable. Raise a new assignment instead.",
        );
      }
      const patch: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) patch[key] = value;
      }
      await app.db
        .update(equipmentAssignments)
        .set(patch)
        .where(eq(equipmentAssignments.id, assignmentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "equipment_assignment",
        objectId: assignmentId,
        projectId: req.projectId!,
        payload: { changed: Object.keys(body) },
      });
      return fetchAssignment(assignmentId, req.companyId!, req.projectId!);
    },
  );

  /** Approval of the hire spend. Schema comment: never the requester. */
  app.post(
    "/projects/:projectId/equipment/assignments/:assignmentId/approve",
    { preHandler: standardGate },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const assignment = await fetchAssignment(
        assignmentId,
        req.companyId!,
        req.projectId!,
      );
      if (assignment.status !== "requested") {
        throw badRequest(
          `assignment is ${assignment.status}, not requested — nothing to approve`,
        );
      }
      const override = await assertIndependent(
        req,
        assignment.requestedBy ?? assignment.createdBy,
        "hire approval",
        req.projectId!,
      );
      const now = new Date().toISOString();
      await app.db
        .update(equipmentAssignments)
        .set({
          status: "approved",
          approvedBy: req.user!.id,
          approvedAt: now,
          updatedAt: now,
        })
        .where(eq(equipmentAssignments.id, assignmentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment_assignment",
        objectId: assignmentId,
        projectId: req.projectId!,
        payload: {
          from: "requested",
          to: "approved",
          requestedBy: assignment.requestedBy,
          selfApprovedUnderOverride: override,
        },
        storePayload: true,
      });
      return {
        ...(await fetchAssignment(
          assignmentId,
          req.companyId!,
          req.projectId!,
        )),
        independentApproval: !override,
      };
    },
  );

  /** Mobilisation: the machine arrives. Condition on arrival is recorded HERE
   *  and nowhere else, because it is the only baseline any damage claim on
   *  return can be argued against. */
  app.post(
    "/projects/:projectId/equipment/assignments/:assignmentId/mobilise",
    { preHandler: standardGate },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const body = z
        .object({
          mobilisedAt: isoTimestamp.optional(),
          conditionOnArrival: z.enum(EQUIPMENT_CONDITIONS),
          arrivalPhotoFileIds: z.array(idRef).max(50).optional(),
          transportDocketRef: z.string().max(120).nullable().optional(),
          mobilisationCost: money.nullable().optional(),
          meterReading: z.number().finite().min(0).nullable().optional(),
          notes: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const assignment = await fetchAssignment(
        assignmentId,
        companyId,
        projectId,
      );
      if (
        !["requested", "approved", "mobilising"].includes(assignment.status)
      ) {
        throw badRequest(
          `assignment is ${assignment.status} — it cannot be mobilised again`,
        );
      }
      if (assignment.status === "requested") {
        throw badRequest(
          "this assignment has not been approved — approve the hire spend before the machine is " +
            "brought to site, which is the only moment the approval can still change anything",
        );
      }
      const machine = await fetchEquipment(assignment.equipmentId, companyId);
      const at = body.mobilisedAt
        ? new Date(body.mobilisedAt).toISOString()
        : new Date().toISOString();
      const now = new Date().toISOString();
      await app.db
        .update(equipmentAssignments)
        .set({
          status: "on_site",
          mobilisedAt: at,
          conditionOnArrival: body.conditionOnArrival,
          arrivalPhotoFileIds: body.arrivalPhotoFileIds ?? [],
          transportDocketRef:
            body.transportDocketRef ?? assignment.transportDocketRef,
          mobilisationCost:
            body.mobilisationCost ?? assignment.mobilisationCost,
          notes: body.notes ?? assignment.notes,
          updatedAt: now,
        })
        .where(eq(equipmentAssignments.id, assignmentId));
      await app.db
        .update(equipment)
        .set({
          projectId,
          currentAssignmentId: assignmentId,
          status: "in_use",
          condition: body.conditionOnArrival,
          currentMeterReading: body.meterReading ?? machine.currentMeterReading,
          lastMeterReadingAt:
            body.meterReading != null ? at : machine.lastMeterReadingAt,
          updatedAt: now,
        })
        .where(eq(equipment.id, assignment.equipmentId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment_assignment",
        objectId: assignmentId,
        projectId,
        payload: {
          to: "on_site",
          mobilisedAt: at,
          conditionOnArrival: body.conditionOnArrival,
          meterReading: body.meterReading ?? null,
          photos: (body.arrivalPhotoFileIds ?? []).length,
        },
        storePayload: true,
      });
      const updated = await fetchAssignment(assignmentId, companyId, projectId);
      return {
        ...updated,
        arrivalEvidenceNote:
          (body.arrivalPhotoFileIds ?? []).length === 0
            ? "no arrival photographs were attached. Condition on arrival is the ONLY baseline a " +
              "damage charge on return can be argued against; without photographs it is your word " +
              "against the hire company's, and theirs is on their docket."
            : null,
      };
    },
  );

  /** Demobilisation: the machine goes back, and any damage is recorded
   *  against the arrival baseline while somebody can still be asked about it. */
  app.post(
    "/projects/:projectId/equipment/assignments/:assignmentId/demobilise",
    { preHandler: standardGate },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const body = z
        .object({
          returnedAt: isoTimestamp.optional(),
          conditionOnReturn: z.enum(EQUIPMENT_CONDITIONS),
          returnPhotoFileIds: z.array(idRef).max(50).optional(),
          damageOnReturnNote: z.string().max(4000).nullable().optional(),
          demobilisationCost: money.nullable().optional(),
          meterReading: z.number().finite().min(0).nullable().optional(),
          requestOffHire: z.boolean().default(false),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const assignment = await fetchAssignment(
        assignmentId,
        companyId,
        projectId,
      );
      if (assignment.status === "returned") {
        throw conflict("this assignment has already been demobilised");
      }
      if (!assignment.mobilisedAt) {
        throw badRequest(
          "this machine was never mobilised, so it cannot be demobilised — cancel the assignment " +
            "instead, which records that it never came",
        );
      }
      const machine = await fetchEquipment(assignment.equipmentId, companyId);
      const at = body.returnedAt
        ? new Date(body.returnedAt).toISOString()
        : new Date().toISOString();
      const now = new Date().toISOString();
      const CONDITION_RANK: Record<string, number> = {
        new: 0,
        good: 1,
        fair: 2,
        poor: 3,
        unserviceable: 4,
      };
      const arrival = assignment.conditionOnArrival ?? "good";
      const deteriorated =
        (CONDITION_RANK[body.conditionOnReturn] ?? 0) >
        (CONDITION_RANK[arrival] ?? 0);
      await app.db
        .update(equipmentAssignments)
        .set({
          status: "returned",
          returnedAt: at,
          conditionOnReturn: body.conditionOnReturn,
          returnPhotoFileIds: body.returnPhotoFileIds ?? [],
          damageOnReturnNote: body.damageOnReturnNote ?? null,
          demobilisationCost:
            body.demobilisationCost ?? assignment.demobilisationCost,
          assignedTo: assignment.assignedTo ?? at.slice(0, 10),
          updatedAt: now,
        })
        .where(eq(equipmentAssignments.id, assignmentId));
      await app.db
        .update(equipment)
        .set({
          projectId: null,
          currentAssignmentId: null,
          status: body.requestOffHire ? "off_hire_requested" : "available",
          offHireRequestedAt: body.requestOffHire
            ? (machine.offHireRequestedAt ?? at)
            : machine.offHireRequestedAt,
          condition: body.conditionOnReturn,
          currentMeterReading: body.meterReading ?? machine.currentMeterReading,
          lastMeterReadingAt:
            body.meterReading != null ? at : machine.lastMeterReadingAt,
          updatedAt: now,
        })
        .where(eq(equipment.id, assignment.equipmentId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment_assignment",
        objectId: assignmentId,
        projectId,
        payload: {
          to: "returned",
          returnedAt: at,
          conditionOnArrival: arrival,
          conditionOnReturn: body.conditionOnReturn,
          deteriorated,
          damageOnReturnNote: body.damageOnReturnNote ?? null,
          offHireRequested: body.requestOffHire,
        },
        storePayload: true,
      });
      return {
        ...(await fetchAssignment(assignmentId, companyId, projectId)),
        conditionDeteriorated: deteriorated,
        damageNote: deteriorated
          ? `condition fell from ${arrival} on arrival to ${body.conditionOnReturn} on return. ` +
            "The hire company will charge for this. Whether that charge sticks depends entirely on " +
            "the arrival photographs and this note, so make both of them worth reading."
          : null,
        offHireNote: body.requestOffHire
          ? "off-hire has been requested — confirm collection on the machine record when it goes, " +
            "because the charge runs until it does"
          : "NO OFF-HIRE WAS REQUESTED. The machine has left site but the hire is still running: " +
            "this is the single most common avoidable cost on a project.",
      };
    },
  );

  /* ================================================================ */
  /* UTILISATION — where the hours actually went                       */
  /* ================================================================ */

  const utilisationCreateSchema = z.object({
    equipmentId: idRef,
    utilisationDate: isoDateSchema,
    shift: z.enum(SHIFTS).default("day"),
    assignmentId: idRef.nullable().optional(),
    availableHours: hours.nullable().optional(),
    workingHours: hours.default(0),
    idleHours: hours.default(0),
    standbyHours: hours.default(0),
    downtimeHours: hours.default(0),
    travelHours: hours.default(0),
    idleReason: z.enum(IDLE_REASONS).nullable().optional(),
    idleNote: z.string().max(2000).nullable().optional(),
    downtimeReason: z.string().max(2000).nullable().optional(),
    meterStart: z.number().finite().min(0).nullable().optional(),
    meterEnd: z.number().finite().min(0).nullable().optional(),
    fuelLitres: z.number().finite().min(0).nullable().optional(),
    fuelCost: money.nullable().optional(),
    productionQuantity: z.number().finite().nullable().optional(),
    productionUnit: z.string().max(40).nullable().optional(),
    operatorWorkerId: idRef.nullable().optional(),
    crewId: idRef.nullable().optional(),
    costCodeId: idRef.nullable().optional(),
    budgetLineItemId: idRef.nullable().optional(),
    locationId: idRef.nullable().optional(),
    isBillable: z.boolean().default(false),
    tmTicketId: idRef.nullable().optional(),
    source: z.enum(EQUIPMENT_DATA_SOURCES).default("manual"),
    sourceRef: z.string().max(200).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  const utilisationListQuery = pageQuerySchema.extend({
    equipmentId: idRef.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    idleReason: z.enum(IDLE_REASONS).optional(),
    shift: z.enum(SHIFTS).optional(),
    unverifiedOnly: z.coerce.boolean().optional(),
  });

  function hoursOf(row: {
    availableHours: number | null;
    workingHours: number;
    idleHours: number;
    standbyHours: number;
    downtimeHours: number;
    travelHours: number;
  }): UtilisationHours {
    return {
      availableHours: row.availableHours,
      workingHours: row.workingHours,
      idleHours: row.idleHours,
      standbyHours: row.standbyHours,
      downtimeHours: row.downtimeHours,
      travelHours: row.travelHours,
    };
  }

  /** Fuel burnt on a day, converted through the machine's carbon factor.
   *  Returns null with a reason rather than 0 when anything is missing — a
   *  zero emissions figure on a diesel excavator is a lie. */
  async function fuelCarbon(
    companyId: string,
    carbonFactorId: string | null,
    fuelLitres: number | null,
  ): Promise<{
    tco2e: number | null;
    factorId: string | null;
    reasons: string[];
  }> {
    const reasons: string[] = [];
    if (fuelLitres === null || fuelLitres <= 0) {
      reasons.push(
        "no fuel was recorded for this day, so no combustion emissions can be stated",
      );
      return { tco2e: null, factorId: carbonFactorId, reasons };
    }
    if (!carbonFactorId) {
      reasons.push(
        "no carbon factor is bound to this machine — litres are known, kgCO2e per litre is not, " +
          "so the emissions are not computed rather than estimated",
      );
      return { tco2e: null, factorId: null, reasons };
    }
    const rows = await app.db
      .select()
      .from(carbonFactors)
      .where(
        and(
          eq(carbonFactors.id, carbonFactorId),
          eq(carbonFactors.companyId, companyId),
        ),
      )
      .limit(1);
    const factor = rows[0];
    if (!factor) {
      reasons.push(
        `carbon factor ${carbonFactorId} is not in this company's factor library`,
      );
      return { tco2e: null, factorId: carbonFactorId, reasons };
    }
    if (!unitsMatch(factor.unit, "litre")) {
      reasons.push(
        `carbon factor "${factor.name}" is published per ${factor.unit}, not per litre — ` +
          "converting between them is not this module's job and guessing at it would be a fabrication",
      );
      return { tco2e: null, factorId: carbonFactorId, reasons };
    }
    return {
      tco2e: computeTco2e(fuelLitres, factor.factorKgCo2ePerUnit),
      factorId: carbonFactorId,
      reasons,
    };
  }

  /** The utilisation row with everything derived from it, in one shape the
   *  UI can render without recomputing anything. */
  async function decorateUtilisation(
    row: typeof equipmentUtilisation.$inferSelect,
    machine: typeof equipment.$inferSelect,
  ) {
    const h = hoursOf(row);
    const util = computeUtilisation(h);
    const cost = computeDayCost({
      hireRateAmount: machine.hireRateAmount,
      hireRateUnit: machine.hireRateUnit as HireRateUnit | null,
      idleRateAmount: machine.idleRateAmount,
      internalRateAmount: machine.internalRateAmount,
      ownership: machine.ownership,
      operatorRateAmount: machine.operatorRateAmount,
      fuelCost: row.fuelCost,
      fuelLitres: row.fuelLitres,
      currency: row.currency,
      hours: h,
    });
    const carbon = await fuelCarbon(
      row.companyId,
      machine.carbonFactorId,
      row.fuelLitres,
    );
    return {
      ...row,
      isBillable: row.isBillable === 1,
      equipmentReference: machine.reference,
      equipmentName: machine.name,
      utilisation: util,
      cost,
      carbon,
      costCoding: {
        costCodeId: row.costCodeId,
        budgetLineItemId: row.budgetLineItemId,
        note:
          row.costCodeId === null && row.budgetLineItemId === null
            ? "this day's plant cost lands on no cost code and no budget line — it will not appear " +
              "in the cost report, which is how plant overspend is discovered at final account"
            : null,
      },
    };
  }

  app.post(
    "/projects/:projectId/equipment-utilisation",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = utilisationCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const machine = await fetchEquipment(body.equipmentId, companyId);
      const h: UtilisationHours = {
        availableHours: body.availableHours ?? null,
        workingHours: body.workingHours,
        idleHours: body.idleHours,
        standbyHours: body.standbyHours,
        downtimeHours: body.downtimeHours,
        travelHours: body.travelHours,
      };
      const util = computeUtilisation(h);
      if (util.utilisationPercent === null && util.accountedHours > 0) {
        throw badRequest(
          `the hours on this row do not make a usable day: ${util.reasons.join("; ")}`,
          { reasons: util.reasons, accountedHours: util.accountedHours },
        );
      }
      // The idle reason is the field that turns a cost into an action, so a
      // day with material idle time and no reason is refused.
      const idleish = body.idleHours + body.standbyHours;
      if (idleish > 0 && !body.idleReason) {
        throw badRequest(
          `${round2(idleish)} idle/standby hour(s) were recorded with no idleReason. ` +
            `"awaiting materials" and "weather" produce entirely different conversations and only ` +
            `one of them is recoverable from somebody — one of: ${IDLE_REASONS.join(", ")}`,
        );
      }
      const existing = await app.db
        .select({ id: equipmentUtilisation.id })
        .from(equipmentUtilisation)
        .where(
          and(
            eq(equipmentUtilisation.equipmentId, body.equipmentId),
            eq(equipmentUtilisation.utilisationDate, body.utilisationDate),
            eq(equipmentUtilisation.shift, body.shift),
          ),
        )
        .limit(1);
      if (existing[0]) {
        throw conflict(
          `${machine.reference} already has a ${body.shift} shift recorded for ` +
            `${body.utilisationDate} (${existing[0].id}). Patch that row rather than adding a ` +
            "second one — two rows for one shift double the hire cost in every report that reads them.",
        );
      }
      const meterDelta =
        body.meterStart != null && body.meterEnd != null
          ? round2(body.meterEnd - body.meterStart)
          : null;
      if (meterDelta !== null && meterDelta < 0) {
        throw badRequest(
          `meterEnd ${body.meterEnd} is below meterStart ${body.meterStart} — the meter went ` +
            "backwards across a single shift, which is a reading error or a replaced unit",
        );
      }
      const cost = computeDayCost({
        hireRateAmount: machine.hireRateAmount,
        hireRateUnit: machine.hireRateUnit as HireRateUnit | null,
        idleRateAmount: machine.idleRateAmount,
        internalRateAmount: machine.internalRateAmount,
        ownership: machine.ownership,
        operatorRateAmount: machine.operatorRateAmount,
        fuelCost: body.fuelCost ?? null,
        fuelLitres: body.fuelLitres ?? null,
        currency: machine.currency,
        hours: h,
      });
      const id = newId("equ");
      await app.db.insert(equipmentUtilisation).values({
        id,
        companyId,
        projectId,
        equipmentId: body.equipmentId,
        assignmentId: body.assignmentId ?? machine.currentAssignmentId,
        utilisationDate: body.utilisationDate,
        shift: body.shift,
        availableHours: body.availableHours ?? null,
        workingHours: body.workingHours,
        idleHours: body.idleHours,
        standbyHours: body.standbyHours,
        downtimeHours: body.downtimeHours,
        travelHours: body.travelHours,
        utilisationPercent: util.utilisationPercent,
        idleReason: body.idleReason ?? null,
        idleNote: body.idleNote ?? null,
        downtimeReason: body.downtimeReason ?? null,
        meterStart: body.meterStart ?? null,
        meterEnd: body.meterEnd ?? null,
        meterDelta,
        fuelLitres: body.fuelLitres ?? null,
        fuelCost: body.fuelCost ?? null,
        hireCost: cost.hireCost,
        operatorCost: cost.operatorCost,
        totalCost: cost.totalCost,
        currency: machine.currency,
        productionQuantity: body.productionQuantity ?? null,
        productionUnit: body.productionUnit ?? null,
        operatorWorkerId: body.operatorWorkerId ?? null,
        crewId: body.crewId ?? null,
        costCodeId: body.costCodeId ?? machine.costCodeId,
        budgetLineItemId: body.budgetLineItemId ?? machine.budgetLineItemId,
        locationId: body.locationId ?? null,
        isBillable: body.isBillable ? 1 : 0,
        tmTicketId: body.tmTicketId ?? null,
        source: body.source,
        sourceRef: body.sourceRef ?? null,
        notes: body.notes ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      /*
       * THE MACHINE METER ONLY EVER GOES FORWARD. Writing meterEnd onto the
       * machine unconditionally let a back-filled plant sheet regress the
       * reading — after which every meter-based service interval gains the
       * difference and an overdue service reads as "scheduled". The row keeps
       * whatever was entered (it is the plant sheet, and it is evidence); the
       * machine's own reading advances only when this row is both LATER than
       * the last reading and HIGHER than the current one.
       */
      const meterAt = `${body.utilisationDate}T23:59:59Z`;
      let meterAdvanced = false;
      let meterNote: string | null = null;
      if (body.meterEnd != null) {
        const isLater =
          machine.lastMeterReadingAt === null ||
          meterAt >= machine.lastMeterReadingAt;
        const isHigher =
          machine.currentMeterReading === null ||
          body.meterEnd >= machine.currentMeterReading;
        if (isLater && isHigher) {
          meterAdvanced = true;
          await app.db
            .update(equipment)
            .set({
              currentMeterReading: body.meterEnd,
              lastMeterReadingAt: meterAt,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(equipment.id, body.equipmentId));
        } else {
          meterNote =
            `The machine reads ${machine.currentMeterReading ?? "unknown"}` +
            `${machine.lastMeterReadingAt ? ` as at ${machine.lastMeterReadingAt.slice(0, 10)}` : ""}` +
            `, and this row reports ${body.meterEnd} on ${body.utilisationDate}. The row is kept ` +
            "as entered, but the machine's meter has NOT been moved backwards: every meter-based " +
            "service interval is measured from it, and regressing it turns an overdue service into " +
            "a scheduled one.";
        }
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "equipment_utilisation",
        objectId: id,
        projectId,
        payload: {
          equipmentId: body.equipmentId,
          equipmentReference: machine.reference,
          utilisationDate: body.utilisationDate,
          shift: body.shift,
          hours: h,
          utilisationPercent: util.utilisationPercent,
          idleReason: body.idleReason ?? null,
          totalCost: cost.totalCost,
          currency: machine.currency,
          source: body.source,
        },
        storePayload: true,
      });
      const created = await fetchUtilisation(id, companyId, projectId);
      return reply.status(201).send({
        ...(await decorateUtilisation(created, machine)),
        meter: { advanced: meterAdvanced, note: meterNote },
      });
    },
  );

  app.get(
    "/projects/:projectId/equipment-utilisation",
    { preHandler: readGate },
    async (req) => {
      const q = utilisationListQuery.parse(req.query);
      const companyId = req.companyId!;
      const clauses = [
        eq(equipmentUtilisation.companyId, companyId),
        eq(equipmentUtilisation.projectId, req.projectId!),
      ];
      if (q.equipmentId)
        clauses.push(eq(equipmentUtilisation.equipmentId, q.equipmentId));
      if (q.from)
        clauses.push(gte(equipmentUtilisation.utilisationDate, q.from));
      if (q.to) clauses.push(lte(equipmentUtilisation.utilisationDate, q.to));
      if (q.idleReason)
        clauses.push(eq(equipmentUtilisation.idleReason, q.idleReason));
      if (q.shift) clauses.push(eq(equipmentUtilisation.shift, q.shift));
      if (q.unverifiedOnly)
        clauses.push(isNull(equipmentUtilisation.verifiedBy));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(equipmentUtilisation)
        .where(where);
      const rows = await app.db
        .select()
        .from(equipmentUtilisation)
        .where(where)
        .orderBy(
          desc(equipmentUtilisation.utilisationDate),
          asc(equipmentUtilisation.shift),
        )
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const machineIds = [...new Set(rows.map((r) => r.equipmentId))];
      const machines =
        machineIds.length > 0
          ? await app.db
              .select()
              .from(equipment)
              .where(inArray(equipment.id, machineIds))
          : [];
      const byId = new Map(machines.map((m) => [m.id, m] as const));
      const decorated = [];
      for (const row of rows) {
        const machine = byId.get(row.equipmentId);
        decorated.push(machine ? await decorateUtilisation(row, machine) : row);
      }
      return paginate(decorated, Number(totalRow?.n ?? 0), q);
    },
  );

  /**
   * Per-machine rollup over a window. Costs are bucketed BY CURRENCY and
   * never added across them, and every machine carries the reasons behind
   * any figure that could not be computed.
   */
  app.get(
    "/projects/:projectId/equipment-utilisation/summary",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({
          from: isoDateSchema.optional(),
          to: isoDateSchema.optional(),
        })
        .parse(req.query);
      const to = q.to ?? todayISO();
      const from = q.from ?? addDaysISO(to, -29);
      const rows = await app.db
        .select()
        .from(equipmentUtilisation)
        .where(
          and(
            eq(equipmentUtilisation.companyId, req.companyId!),
            eq(equipmentUtilisation.projectId, req.projectId!),
            gte(equipmentUtilisation.utilisationDate, from),
            lte(equipmentUtilisation.utilisationDate, to),
          ),
        );
      const machineIds = [...new Set(rows.map((r) => r.equipmentId))];
      const machines =
        machineIds.length > 0
          ? await app.db
              .select()
              .from(equipment)
              .where(inArray(equipment.id, machineIds))
          : [];
      const byId = new Map(machines.map((m) => [m.id, m] as const));
      const grouped = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = grouped.get(row.equipmentId) ?? [];
        list.push(row);
        grouped.set(row.equipmentId, list);
      }
      const items = [...grouped.entries()].map(([equipmentId, list]) => {
        const machine = byId.get(equipmentId);
        const totals: UtilisationHours = {
          availableHours: list.some((r) => r.availableHours !== null)
            ? list.reduce((s, r) => s + (r.availableHours ?? 0), 0)
            : null,
          workingHours: list.reduce((s, r) => s + r.workingHours, 0),
          idleHours: list.reduce((s, r) => s + r.idleHours, 0),
          standbyHours: list.reduce((s, r) => s + r.standbyHours, 0),
          downtimeHours: list.reduce((s, r) => s + r.downtimeHours, 0),
          travelHours: list.reduce((s, r) => s + r.travelHours, 0),
        };
        const util = computeUtilisation(totals);
        const currency = machine?.currency ?? list[0]?.currency ?? "USD";
        const costed = list.filter((r) => r.totalCost !== null);
        const idleByReason: Record<string, number> = {};
        for (const r of list) {
          if (!r.idleReason) continue;
          idleByReason[r.idleReason] = round2(
            (idleByReason[r.idleReason] ?? 0) + r.idleHours + r.standbyHours,
          );
        }
        return {
          equipmentId,
          reference: machine?.reference ?? null,
          name: machine?.name ?? null,
          ownership: machine?.ownership ?? null,
          days: list.length,
          hours: {
            availableHours:
              totals.availableHours === null
                ? null
                : round2(totals.availableHours),
            workingHours: round2(totals.workingHours),
            idleHours: round2(totals.idleHours),
            standbyHours: round2(totals.standbyHours),
            downtimeHours: round2(totals.downtimeHours),
            travelHours: round2(totals.travelHours),
          },
          utilisation: util,
          idleByReason,
          currency,
          cost: {
            total:
              costed.length > 0
                ? round2(costed.reduce((s, r) => s + (r.totalCost ?? 0), 0))
                : null,
            daysPriced: costed.length,
            daysUnpriced: list.length - costed.length,
            complete: costed.length === list.length,
            note:
              costed.length === list.length
                ? null
                : `${list.length - costed.length} of ${list.length} day(s) could not be priced — ` +
                  "the total below is a floor, not the cost",
          },
          verification: {
            verified: list.filter((r) => r.verifiedBy !== null).length,
            unverified: list.filter((r) => r.verifiedBy === null).length,
          },
        };
      });
      items.sort(
        (a, b) =>
          (a.utilisation.utilisationPercent ?? 101) -
          (b.utilisation.utilisationPercent ?? 101),
      );
      const costByCurrency: Record<string, number> = {};
      for (const item of items) {
        if (item.cost.total === null) continue;
        costByCurrency[item.currency] = round2(
          (costByCurrency[item.currency] ?? 0) + item.cost.total,
        );
      }
      return {
        from,
        to,
        days: windowDays(from, to),
        machines: items.length,
        items,
        costByCurrency,
        currencyNote:
          Object.keys(costByCurrency).length > 1
            ? "plant on this project is hired in more than one currency. The totals are reported " +
              "per currency and are NEVER added — a single number here would need an FX rate and a " +
              "date, and neither belongs in a utilisation report."
            : null,
      };
    },
  );

  app.patch(
    "/projects/:projectId/equipment-utilisation/:utilisationId",
    { preHandler: standardGate },
    async (req) => {
      const { utilisationId } = req.params as { utilisationId: string };
      const body = utilisationCreateSchema
        .partial()
        .omit({ equipmentId: true, utilisationDate: true, shift: true })
        .parse(req.body);
      const companyId = req.companyId!;
      const existing = await fetchUtilisation(
        utilisationId,
        companyId,
        req.projectId!,
      );
      if (existing.verifiedBy) {
        throw badRequest(
          "these hours have been independently verified and are no longer editable — a verified " +
            "claim that can still be changed is not a verified claim. Void and re-enter instead.",
        );
      }
      const machine = await fetchEquipment(existing.equipmentId, companyId);
      const h: UtilisationHours = {
        availableHours:
          body.availableHours !== undefined
            ? (body.availableHours ?? null)
            : existing.availableHours,
        workingHours: body.workingHours ?? existing.workingHours,
        idleHours: body.idleHours ?? existing.idleHours,
        standbyHours: body.standbyHours ?? existing.standbyHours,
        downtimeHours: body.downtimeHours ?? existing.downtimeHours,
        travelHours: body.travelHours ?? existing.travelHours,
      };
      const util = computeUtilisation(h);
      if (util.utilisationPercent === null && util.accountedHours > 0) {
        throw badRequest(
          `the hours on this row do not make a usable day: ${util.reasons.join("; ")}`,
          {
            reasons: util.reasons,
          },
        );
      }
      const cost = computeDayCost({
        hireRateAmount: machine.hireRateAmount,
        hireRateUnit: machine.hireRateUnit as HireRateUnit | null,
        idleRateAmount: machine.idleRateAmount,
        internalRateAmount: machine.internalRateAmount,
        ownership: machine.ownership,
        operatorRateAmount: machine.operatorRateAmount,
        fuelCost:
          body.fuelCost !== undefined
            ? (body.fuelCost ?? null)
            : existing.fuelCost,
        fuelLitres:
          body.fuelLitres !== undefined
            ? (body.fuelLitres ?? null)
            : existing.fuelLitres,
        currency: existing.currency,
        hours: h,
      });
      const patch: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        patch[key] = key === "isBillable" ? (value ? 1 : 0) : value;
      }
      patch["availableHours"] = h.availableHours;
      patch["workingHours"] = h.workingHours;
      patch["idleHours"] = h.idleHours;
      patch["standbyHours"] = h.standbyHours;
      patch["downtimeHours"] = h.downtimeHours;
      patch["travelHours"] = h.travelHours;
      patch["utilisationPercent"] = util.utilisationPercent;
      patch["hireCost"] = cost.hireCost;
      patch["operatorCost"] = cost.operatorCost;
      patch["totalCost"] = cost.totalCost;
      await app.db
        .update(equipmentUtilisation)
        .set(patch)
        .where(eq(equipmentUtilisation.id, utilisationId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "equipment_utilisation",
        objectId: utilisationId,
        projectId: req.projectId!,
        payload: {
          changed: Object.keys(body),
          utilisationPercent: util.utilisationPercent,
        },
      });
      return decorateUtilisation(
        await fetchUtilisation(utilisationId, companyId, req.projectId!),
        machine,
      );
    },
  );

  /** Verification of claimed hours. Schema comment: never the operator who
   *  claimed them. Hours are a claim for money; a claim checked by its own
   *  author is not checked. */
  app.post(
    "/projects/:projectId/equipment-utilisation/:utilisationId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { utilisationId } = req.params as { utilisationId: string };
      const body = z
        .object({ note: z.string().max(2000).optional() })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const row = await fetchUtilisation(
        utilisationId,
        companyId,
        req.projectId!,
      );
      if (row.verifiedBy)
        throw conflict("these hours have already been verified");
      const override = await assertIndependent(
        req,
        row.createdBy,
        "utilisation verification",
        req.projectId!,
      );
      const now = new Date().toISOString();
      await app.db
        .update(equipmentUtilisation)
        .set({ verifiedBy: req.user!.id, verifiedAt: now, updatedAt: now })
        .where(eq(equipmentUtilisation.id, utilisationId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment_utilisation",
        objectId: utilisationId,
        projectId: req.projectId!,
        payload: {
          verified: true,
          claimedBy: row.createdBy,
          note: body.note ?? null,
          selfVerifiedUnderOverride: override,
        },
        storePayload: true,
      });
      const machine = await fetchEquipment(row.equipmentId, companyId);
      return {
        ...(await decorateUtilisation(
          await fetchUtilisation(utilisationId, companyId, req.projectId!),
          machine,
        )),
        independentVerification: !override,
      };
    },
  );

  /* ================================================================ */
  /* IDLE PLANT STILL ON HIRE — where the money leaks                  */
  /* ================================================================ */

  const idleQuery = z.object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    days: z.coerce.number().int().min(2).max(180).optional(),
    thresholdPercent: z.coerce.number().min(0).max(100).optional(),
    sustainedDays: z.coerce.number().int().min(1).max(90).optional(),
    includeAll: z.coerce.boolean().optional(),
  });

  /**
   * Find hired plant with sustained low utilisation that nobody has
   * off-hired, and state what the idle run has cost.
   *
   * Raises `equipment_idle_on_hire` once per machine (keyed on equipmentId),
   * because the point is a standing conversation about one machine, not a
   * new alert every time somebody opens the page.
   */
  async function idleAssessments(
    companyId: string,
    projectId: string | null,
    q: z.infer<typeof idleQuery>,
  ): Promise<{
    from: string;
    to: string;
    thresholdPercent: number;
    sustainedDays: number;
    rows: IdlePlantAssessment[];
    flagged: IdlePlantAssessment[];
    idleCostByCurrency: Record<string, number>;
  }> {
    const to = q.to ?? todayISO();
    const from = q.from ?? addDaysISO(to, -((q.days ?? 14) - 1));
    const thresholdPercent =
      q.thresholdPercent ?? IDLE_UTILISATION_THRESHOLD_PERCENT;
    const sustainedDays = q.sustainedDays ?? IDLE_SUSTAINED_DAYS;

    let fleet = await app.db
      .select()
      .from(equipment)
      .where(eq(equipment.companyId, companyId));
    if (projectId) {
      const assigned = await app.db
        .select({ equipmentId: equipmentAssignments.equipmentId })
        .from(equipmentAssignments)
        .where(
          and(
            eq(equipmentAssignments.companyId, companyId),
            eq(equipmentAssignments.projectId, projectId),
            inArray(equipmentAssignments.status, [
              ...IN_SERVICE_ASSIGNMENT_STATUSES,
            ]),
          ),
        );
      const ids = new Set(assigned.map((a) => a.equipmentId));
      fleet = fleet.filter((m) => ids.has(m.id) || m.projectId === projectId);
    }
    if (fleet.length === 0) {
      return {
        from,
        to,
        thresholdPercent,
        sustainedDays,
        rows: [],
        flagged: [],
        idleCostByCurrency: {},
      };
    }
    const utilRowsClauses = [
      eq(equipmentUtilisation.companyId, companyId),
      gte(equipmentUtilisation.utilisationDate, from),
      lte(equipmentUtilisation.utilisationDate, to),
      inArray(
        equipmentUtilisation.equipmentId,
        fleet.map((m) => m.id),
      ),
    ];
    if (projectId)
      utilRowsClauses.push(eq(equipmentUtilisation.projectId, projectId));
    const utilRows = await app.db
      .select()
      .from(equipmentUtilisation)
      .where(and(...utilRowsClauses));
    const byEquipment = new Map<string, IdleDayInput[]>();
    for (const row of utilRows) {
      const list = byEquipment.get(row.equipmentId) ?? [];
      list.push({
        date: row.utilisationDate,
        hours: hoursOf(row),
        idleReason: row.idleReason,
      });
      byEquipment.set(row.equipmentId, list);
    }

    const rows = rankIdlePlant(
      fleet.map((m) =>
        assessIdlePlant(
          {
            equipmentId: m.id,
            reference: m.reference,
            name: m.name,
            ownership: m.ownership,
            status: m.status,
            currency: m.currency,
            hireRateAmount: m.hireRateAmount,
            hireRateUnit: m.hireRateUnit as HireRateUnit | null,
            idleRateAmount: m.idleRateAmount,
            internalRateAmount: m.internalRateAmount,
            operatorRateAmount: m.operatorRateAmount,
            offHireRequestedAt: m.offHireRequestedAt,
            offHiredAt: m.offHiredAt,
            hireEndDate: m.hireEndDate,
            days: byEquipment.get(m.id) ?? [],
            windowStart: from,
            windowEnd: to,
          },
          { thresholdPercent, sustainedDays },
        ),
      ),
    );
    const flagged = rows.filter((r) => r.isIdleOnHire);

    if (flagged.length > 0) {
      const seen = await alreadySignalled(companyId, "equipment_idle_on_hire");
      for (const row of flagged) {
        const machine = fleet.find((m) => m.id === row.equipmentId);
        const costPhrase =
          row.idleCost !== null
            ? `${row.currency} ${row.idleCost} has been spent on it standing`
            : "its standing cost cannot be stated because no usable hire rate is recorded, which " +
              "is its own problem";
        await raiseSignalOnce({
          companyId,
          projectId: projectId ?? machine?.projectId ?? null,
          detector: "equipment_idle_on_hire",
          key: row.equipmentId,
          severity: "high",
          title: `Idle plant still on hire — ${row.reference} ${row.name}`,
          explanation:
            `${row.reference} ${row.name} has worked at or below ${thresholdPercent}% of its ` +
            `available hours for ${row.consecutiveLowDays} consecutive day(s) and is still on ` +
            `hire. Over that run ${costPhrase}` +
            `${row.idleReasons.length > 0 ? `, and the site has been recording it as "${row.idleReasons[0]}"` : ""}. ` +
            `Idle hired plant is the most avoidable cost on a project: the machine is not ` +
            `producing, the hire company is charging, and nothing about the situation improves by ` +
            `waiting. Off-hire it, or record the decision to hold it and why the standby is worth ` +
            `${row.currency} a day.` +
            (row.offHireRequestedAt
              ? ` Off-hire was requested on ${row.offHireRequestedAt} and it is still here — chase ` +
                `collection and check the invoice stops at the request date.`
              : ""),
          refs: {
            equipmentId: row.equipmentId,
            equipmentReference: row.reference,
            consecutiveLowDays: row.consecutiveLowDays,
            utilisationPercent: row.utilisationPercent,
            idleCost: row.idleCost,
            currency: row.currency,
            windowStart: from,
            windowEnd: to,
            idleReasons: row.idleReasons,
          },
          seen,
        });
      }
    }

    return {
      from,
      to,
      thresholdPercent,
      sustainedDays,
      rows: q.includeAll ? rows : flagged,
      flagged,
      idleCostByCurrency: idleCostByCurrency(rows),
    };
  }

  function idleResponse(result: Awaited<ReturnType<typeof idleAssessments>>) {
    return {
      from: result.from,
      to: result.to,
      days: windowDays(result.from, result.to),
      thresholdPercent: result.thresholdPercent,
      sustainedDays: result.sustainedDays,
      criteria:
        `hired plant (not owned, not already off-hired) working at or below ` +
        `${result.thresholdPercent}% of its available hours for ${result.sustainedDays} or more ` +
        `consecutive days up to ${result.to}`,
      flaggedCount: result.flagged.length,
      idleCostByCurrency: result.idleCostByCurrency,
      currencyNote:
        Object.keys(result.idleCostByCurrency).length > 1
          ? "reported per currency and never added — a single cross-currency total would need an " +
            "FX rate and a date, and this is a decision list, not a financial statement"
          : null,
      items: result.rows,
    };
  }

  app.get(
    "/projects/:projectId/equipment-idle",
    { preHandler: readGate },
    async (req) => {
      const q = idleQuery.parse(req.query);
      return idleResponse(
        await idleAssessments(req.companyId!, req.projectId!, q),
      );
    },
  );

  app.get(
    "/companies/current/equipment-idle",
    { preHandler: companyRead },
    async (req) => {
      const q = idleQuery.parse(req.query);
      return idleResponse(await idleAssessments(req.companyId!, null, q));
    },
  );

  /* ================================================================ */
  /* CERTIFICATES — the column the table exists for is `validTo`       */
  /* ================================================================ */

  const OBLIGATION_PREFIX = "Equipment certificate";

  const certificateCreateSchema = z.object({
    certificateType: z.enum(EQUIPMENT_CERTIFICATE_TYPES),
    validTo: isoDateSchema,
    validFrom: isoDateSchema.nullable().optional(),
    issuedAt: isoDateSchema.nullable().optional(),
    certificateNumber: z.string().max(120).nullable().optional(),
    title: z.string().max(200).nullable().optional(),
    issuedByName: z.string().max(200).nullable().optional(),
    issuerVendorId: idRef.nullable().optional(),
    issuerAccreditation: z.string().max(200).nullable().optional(),
    inspectionIntervalMonths: z
      .number()
      .int()
      .min(1)
      .max(120)
      .nullable()
      .optional(),
    nextInspectionDue: isoDateSchema.nullable().optional(),
    result: z
      .enum(["pass", "pass_with_conditions", "fail", "not_applicable"])
      .default("pass"),
    conditions: z.string().max(4000).nullable().optional(),
    defectsNoted: z
      .array(z.record(z.string(), z.unknown()))
      .max(100)
      .optional(),
    safeWorkingLoad: z.string().max(120).nullable().optional(),
    fileId: idRef.nullable().optional(),
    fileSha256: z.string().max(64).nullable().optional(),
    projectId: idRef.nullable().optional(),
    supersedesId: idRef.nullable().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  app.post(
    "/companies/current/equipment/:equipmentId/certificates",
    { preHandler: companyWrite },
    async (req, reply) => {
      const { equipmentId } = req.params as { equipmentId: string };
      const body = certificateCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const machine = await fetchEquipment(equipmentId, companyId);
      if (body.validFrom && body.validTo < body.validFrom) {
        throw badRequest(
          `validTo ${body.validTo} falls before validFrom ${body.validFrom}`,
        );
      }
      if (body.projectId) await assertProject(body.projectId, companyId);
      const projectId = body.projectId ?? machine.projectId ?? null;

      // The renewal is bound to the obligations register (ADR 0012) so the
      // lapse is a diarised commitment before it is an enforcement notice.
      // Obligations are project-scoped, so a yard machine gets none — and is
      // told so rather than silently missing one.
      let obligationId: string | null = null;
      if (projectId) {
        obligationId = newId("obl");
        await app.db.insert(obligations).values({
          id: obligationId,
          companyId,
          projectId,
          sourceClause: `${OBLIGATION_PREFIX} — ${body.certificateType} — ${machine.reference}`,
          trigger: `Renew ${body.certificateType.replace(/_/g, " ")} for ${machine.reference} ${machine.name}`,
          deadline: `${body.validTo}T23:59:59Z`,
          warnDaysBefore: 28,
          evidenceRequirement:
            "A replacement certificate from a competent person, uploaded and independently verified",
          status: "open",
          createdBy: req.user!.id,
        });
      }

      const nextInspectionDue =
        body.nextInspectionDue ??
        (body.inspectionIntervalMonths && body.issuedAt
          ? addDaysISO(
              body.issuedAt,
              Math.round(body.inspectionIntervalMonths * 30.44),
            )
          : null);

      const id = newId("eqc");
      await app.db.insert(equipmentCertificates).values({
        id,
        companyId,
        projectId,
        equipmentId,
        certificateType: body.certificateType,
        certificateNumber: body.certificateNumber ?? null,
        title: body.title ?? null,
        issuedByName: body.issuedByName ?? null,
        issuerVendorId: body.issuerVendorId ?? null,
        issuerAccreditation: body.issuerAccreditation ?? null,
        issuedAt: body.issuedAt ?? null,
        validFrom: body.validFrom ?? null,
        validTo: body.validTo,
        inspectionIntervalMonths: body.inspectionIntervalMonths ?? null,
        nextInspectionDue,
        result: body.result,
        conditions: body.conditions ?? null,
        defectsNoted: body.defectsNoted ?? [],
        safeWorkingLoad: body.safeWorkingLoad ?? null,
        status: "valid",
        fileId: body.fileId ?? null,
        fileSha256: body.fileSha256 ?? null,
        supersedesId: body.supersedesId ?? null,
        obligationId,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      /*
       * SUPERSESSION IS AUTOMATIC, not a field somebody remembers to send.
       * A renewal added without `supersedesId` used to leave last year's row
       * live and expired, which made the machine read as out of certificate
       * and raised a critical "stop the machine" signal against plant whose
       * paperwork was in order. Every earlier certificate of the SAME TYPE on
       * the same machine whose cover ends no later than this one is closed.
       */
      const nowIso2 = new Date().toISOString();
      const priorSameType = await app.db
        .select({
          id: equipmentCertificates.id,
          validTo: equipmentCertificates.validTo,
        })
        .from(equipmentCertificates)
        .where(
          and(
            eq(equipmentCertificates.companyId, companyId),
            eq(equipmentCertificates.equipmentId, equipmentId),
            eq(equipmentCertificates.certificateType, body.certificateType),
            lte(equipmentCertificates.validTo, body.validTo),
            inArray(equipmentCertificates.status, [
              "valid",
              "expiring",
              "expired",
            ]),
          ),
        );
      const supersededIds = priorSameType
        .map((c) => c.id)
        .filter((cid) => cid !== id);
      if (supersededIds.length > 0) {
        await app.db
          .update(equipmentCertificates)
          .set({ supersededById: id, status: "superseded", updatedAt: nowIso2 })
          .where(inArray(equipmentCertificates.id, supersededIds));
        for (const supersededId of supersededIds) {
          await appendLedger(app.db, {
            companyId,
            actorId: req.user!.id,
            action: "state_change",
            objectType: "equipment_certificate",
            objectId: supersededId,
            projectId,
            payload: {
              to: "superseded",
              supersededById: id,
              certificateType: body.certificateType,
              reason:
                "a later certificate of the same type was issued for this machine, so this row no " +
                "longer describes the machine's current cover",
            },
          });
        }
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "equipment_certificate",
        objectId: id,
        projectId,
        payload: {
          equipmentId,
          equipmentReference: machine.reference,
          certificateType: body.certificateType,
          certificateNumber: body.certificateNumber ?? null,
          validFrom: body.validFrom ?? null,
          validTo: body.validTo,
          result: body.result,
          statutory: isStatutoryCertificate(body.certificateType),
          obligationId,
          supersedesId: body.supersedesId ?? null,
        },
        storePayload: true,
      });
      await refreshCertificateColumn(companyId, equipmentId);
      await sweepEquipment(companyId, null);
      const created = await fetchCertificate(id, companyId);
      return reply.status(201).send({
        ...created,
        statutory: isStatutoryCertificate(created.certificateType),
        verdict: certificateVerdict({
          validTo: created.validTo,
          validFrom: created.validFrom,
          certificateType: created.certificateType,
          inService: (await inServiceEquipmentIds(companyId)).has(equipmentId),
          asOf: todayISO(),
        }),
        obligationNote: obligationId
          ? "the renewal is diarised as an obligation against the project, so it appears in the " +
            "time-bar register rather than only in this module"
          : "this machine is not assigned to a project, so no renewal obligation was raised — " +
            "obligations are project-scoped. Assign the machine, or diarise the renewal elsewhere.",
      });
    },
  );

  app.get(
    "/companies/current/equipment/:equipmentId/certificates",
    { preHandler: companyRead },
    async (req) => {
      const { equipmentId } = req.params as { equipmentId: string };
      await fetchEquipment(equipmentId, req.companyId!);
      await maybeSweep(req.companyId!);
      const asOf = todayISO();
      const inService = await inServiceEquipmentIds(req.companyId!);
      const rows = await app.db
        .select()
        .from(equipmentCertificates)
        .where(
          and(
            eq(equipmentCertificates.companyId, req.companyId!),
            eq(equipmentCertificates.equipmentId, equipmentId),
          ),
        )
        .orderBy(asc(equipmentCertificates.validTo));
      return {
        items: rows.map((c) => ({
          ...c,
          statutory: isStatutoryCertificate(c.certificateType),
          verdict: certificateVerdict({
            validTo: c.validTo,
            validFrom: c.validFrom,
            certificateType: c.certificateType,
            inService: inService.has(equipmentId),
            asOf,
          }),
        })),
        total: rows.length,
      };
    },
  );

  /** The company-wide "which machines are out of certificate today" view —
   *  the question an inspector asks first. */
  app.get(
    "/companies/current/equipment-certificates",
    { preHandler: companyRead },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          certificateType: z.enum(EQUIPMENT_CERTIFICATE_TYPES).optional(),
          status: z
            .enum([
              "pending",
              "valid",
              "expiring",
              "expired",
              "revoked",
              "superseded",
            ])
            .optional(),
          expiringWithinDays: z.coerce
            .number()
            .int()
            .min(0)
            .max(365)
            .optional(),
          inServiceOnly: z.coerce.boolean().optional(),
          unverifiedOnly: z.coerce.boolean().optional(),
        })
        .parse(req.query);
      const companyId = req.companyId!;
      await maybeSweep(companyId);
      const asOf = todayISO();
      const inService = await inServiceEquipmentIds(companyId);
      const clauses = [eq(equipmentCertificates.companyId, companyId)];
      if (q.certificateType)
        clauses.push(
          eq(equipmentCertificates.certificateType, q.certificateType),
        );
      if (q.status) clauses.push(eq(equipmentCertificates.status, q.status));
      if (q.expiringWithinDays !== undefined) {
        clauses.push(
          lte(
            equipmentCertificates.validTo,
            addDaysISO(asOf, q.expiringWithinDays),
          ),
        );
      }
      if (q.unverifiedOnly)
        clauses.push(isNull(equipmentCertificates.verifiedBy));
      const where = and(...clauses);
      const rows = await app.db
        .select()
        .from(equipmentCertificates)
        .where(where)
        .orderBy(asc(equipmentCertificates.validTo));
      const machineIds = [...new Set(rows.map((r) => r.equipmentId))];
      const machines =
        machineIds.length > 0
          ? await app.db
              .select()
              .from(equipment)
              .where(inArray(equipment.id, machineIds))
          : [];
      const byId = new Map(machines.map((m) => [m.id, m] as const));
      let items = rows.map((c) => {
        const machine = byId.get(c.equipmentId);
        const onProject =
          inService.get(c.equipmentId) ?? machine?.projectId ?? null;
        return {
          ...c,
          statutory: isStatutoryCertificate(c.certificateType),
          equipmentReference: machine?.reference ?? null,
          equipmentName: machine?.name ?? null,
          inServiceProjectId: onProject,
          verdict: certificateVerdict({
            validTo: c.validTo,
            validFrom: c.validFrom,
            certificateType: c.certificateType,
            inService: onProject !== null,
            asOf,
          }),
        };
      });
      if (q.inServiceOnly)
        items = items.filter((i) => i.inServiceProjectId !== null);
      const total = items.length;
      const page = items.slice(pageOffset(q), pageOffset(q) + q.pageSize);
      return {
        ...paginate(page, total, q),
        asOf,
        summary: {
          expired: items.filter((i) => i.verdict.status === "expired").length,
          expiredInServiceStatutory: items.filter(
            (i) =>
              i.verdict.detector === "equipment_certificate_expired_in_service",
          ).length,
          expiring: items.filter((i) => i.verdict.status === "expiring").length,
          unverified: items.filter((i) => i.verifiedBy === null).length,
        },
      };
    },
  );

  /** Verification that the certificate is GENUINE. Schema comment: never the
   *  hire desk — i.e. never whoever filed it. A forged thorough examination
   *  is not a rare thing on a busy site. */
  app.post(
    "/companies/current/equipment-certificates/:certificateId/verify",
    { preHandler: companyAdmin },
    async (req) => {
      const { certificateId } = req.params as { certificateId: string };
      const body = z
        .object({
          verificationMethod: z.enum([
            "issuer_confirmation",
            "accreditation_register",
            "document_only",
            "physical_inspection",
          ]),
          note: z.string().max(2000).optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const cert = await fetchCertificate(certificateId, companyId);
      if (cert.status === "revoked" || cert.status === "superseded") {
        throw badRequest(`a ${cert.status} certificate cannot be verified`);
      }
      const override = await assertIndependent(
        req,
        cert.createdBy,
        "certificate verification",
        cert.projectId,
      );
      const now = new Date().toISOString();
      await app.db
        .update(equipmentCertificates)
        .set({
          verifiedBy: req.user!.id,
          verifiedAt: now,
          verificationMethod: body.verificationMethod,
          updatedAt: now,
        })
        .where(eq(equipmentCertificates.id, certificateId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment_certificate",
        objectId: certificateId,
        projectId: cert.projectId,
        payload: {
          verified: true,
          verificationMethod: body.verificationMethod,
          filedBy: cert.createdBy,
          note: body.note ?? null,
          selfVerifiedUnderOverride: override,
        },
        storePayload: true,
      });
      return {
        ...(await fetchCertificate(certificateId, companyId)),
        independentVerification: !override,
        verificationStrength:
          body.verificationMethod === "issuer_confirmation"
            ? "confirmed with the issuing body — the strongest evidence available"
            : body.verificationMethod === "accreditation_register"
              ? "the issuer's accreditation was checked against the register — strong, but it " +
                "proves the issuer, not this certificate"
              : body.verificationMethod === "physical_inspection"
                ? "the certificate was checked against the machine and its markings on site"
                : "documentary only — a PDF is a claim about an examination, not the examination",
      };
    },
  );

  /* ================================================================ */
  /* MAINTENANCE — schedules that fall due, records that close them    */
  /* ================================================================ */

  const scheduleCreateSchema = z.object({
    name: nonEmpty(200),
    description: z.string().max(4000).nullable().optional(),
    maintenanceType: z.enum(MAINTENANCE_TYPES).default("preventive"),
    intervalKind: z.enum(MAINTENANCE_INTERVAL_KINDS).default("operating_hours"),
    intervalValue: z.number().finite().positive(),
    warnAheadValue: z.number().finite().min(0).nullable().optional(),
    lastPerformedAt: isoDateSchema.nullable().optional(),
    lastPerformedMeter: z.number().finite().min(0).nullable().optional(),
    providerVendorId: idRef.nullable().optional(),
    estimatedCost: money.nullable().optional(),
    estimatedDowntimeHours: hours.nullable().optional(),
    currency: z.string().length(3).optional(),
    instructionsFileId: idRef.nullable().optional(),
    standardReference: z.string().max(120).nullable().optional(),
    isStatutory: z.boolean().default(false),
    projectId: idRef.nullable().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  /** Observed meter movement per day, from the two most recent readings —
   *  the input that lets a meter interval be projected onto a date. */
  async function observedDailyUsage(
    equipmentId: string,
  ): Promise<number | null> {
    const rows = await app.db
      .select({
        value: equipmentReadings.value,
        readAt: equipmentReadings.readAt,
      })
      .from(equipmentReadings)
      .where(
        and(
          eq(equipmentReadings.equipmentId, equipmentId),
          inArray(equipmentReadings.readingType, [
            "hours",
            "odometer",
            "cycles",
          ]),
          eq(equipmentReadings.isAnomalous, 0),
        ),
      )
      .orderBy(desc(equipmentReadings.readAt))
      .limit(2);
    if (rows.length < 2) return null;
    const later = rows[0]!;
    const earlier = rows[1]!;
    if (later.value === null || earlier.value === null) return null;
    return averageDailyUsage(
      { value: earlier.value, at: earlier.readAt },
      { value: later.value, at: later.readAt },
    );
  }

  async function scheduleDueRows(
    machine: typeof equipment.$inferSelect,
    asOf: string,
  ): Promise<ScheduleDue[]> {
    const schedules = await app.db
      .select()
      .from(equipmentMaintenanceSchedules)
      .where(eq(equipmentMaintenanceSchedules.equipmentId, machine.id));
    const usage = await observedDailyUsage(machine.id);
    return schedules.map((s) => ({
      scheduleId: s.id,
      name: s.name,
      intervalKind: s.intervalKind as MaintenanceIntervalKind,
      isStatutory: s.isStatutory === 1,
      ...computeNextDue({
        intervalKind: s.intervalKind as MaintenanceIntervalKind,
        intervalValue: s.intervalValue,
        warnAheadValue: s.warnAheadValue,
        lastPerformedAt: s.lastPerformedAt,
        lastPerformedMeter: s.lastPerformedMeter,
        currentMeter: machine.currentMeterReading,
        meterType: machine.meterType as MeterType,
        baselineDate: machine.hireStartDate ?? machine.purchaseDate,
        averageDailyUsage: usage,
        asOf,
      }),
    }));
  }

  app.post(
    "/companies/current/equipment/:equipmentId/maintenance-schedules",
    { preHandler: companyWrite },
    async (req, reply) => {
      const { equipmentId } = req.params as { equipmentId: string };
      const body = scheduleCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const machine = await fetchEquipment(equipmentId, companyId);
      if (body.projectId) await assertProject(body.projectId, companyId);
      const asOf = todayISO();
      const due = computeNextDue({
        intervalKind: body.intervalKind,
        intervalValue: body.intervalValue,
        warnAheadValue: body.warnAheadValue ?? null,
        lastPerformedAt: body.lastPerformedAt ?? null,
        lastPerformedMeter: body.lastPerformedMeter ?? null,
        currentMeter: machine.currentMeterReading,
        meterType: machine.meterType as MeterType,
        baselineDate: machine.hireStartDate ?? machine.purchaseDate,
        averageDailyUsage: await observedDailyUsage(equipmentId),
        asOf,
      });
      const id = newId("ems");
      await app.db.insert(equipmentMaintenanceSchedules).values({
        id,
        companyId,
        projectId: body.projectId ?? machine.projectId ?? null,
        equipmentId,
        name: body.name,
        description: body.description ?? null,
        maintenanceType: body.maintenanceType,
        intervalKind: body.intervalKind,
        intervalValue: body.intervalValue,
        warnAheadValue: body.warnAheadValue ?? null,
        lastPerformedAt: body.lastPerformedAt ?? null,
        lastPerformedMeter: body.lastPerformedMeter ?? null,
        nextDueAt: due.nextDueAt,
        nextDueMeter: due.nextDueMeter,
        status:
          due.status === "overdue"
            ? "overdue"
            : due.status === "due_soon"
              ? "due"
              : "active",
        providerVendorId: body.providerVendorId ?? null,
        estimatedCost: body.estimatedCost ?? null,
        estimatedDowntimeHours: body.estimatedDowntimeHours ?? null,
        currency: body.currency ?? machine.currency,
        instructionsFileId: body.instructionsFileId ?? null,
        standardReference: body.standardReference ?? null,
        isStatutory: body.isStatutory ? 1 : 0,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "equipment_maintenance_schedule",
        objectId: id,
        projectId: body.projectId ?? machine.projectId ?? null,
        payload: {
          equipmentId,
          equipmentReference: machine.reference,
          name: body.name,
          intervalKind: body.intervalKind,
          intervalValue: body.intervalValue,
          nextDueAt: due.nextDueAt,
          nextDueMeter: due.nextDueMeter,
          isStatutory: body.isStatutory,
        },
        storePayload: true,
      });
      const rows = await app.db
        .select()
        .from(equipmentMaintenanceSchedules)
        .where(eq(equipmentMaintenanceSchedules.id, id))
        .limit(1);
      return reply.status(201).send({ ...rows[0], due });
    },
  );

  app.get(
    "/companies/current/equipment/:equipmentId/maintenance-schedules",
    { preHandler: companyRead },
    async (req) => {
      const { equipmentId } = req.params as { equipmentId: string };
      const machine = await fetchEquipment(equipmentId, req.companyId!);
      await maybeSweep(req.companyId!);
      const asOf = todayISO();
      const due = await scheduleDueRows(
        await fetchEquipment(equipmentId, req.companyId!),
        asOf,
      );
      const schedules = await app.db
        .select()
        .from(equipmentMaintenanceSchedules)
        .where(eq(equipmentMaintenanceSchedules.equipmentId, equipmentId));
      const byId = new Map(due.map((d) => [d.scheduleId, d] as const));
      return {
        equipmentId,
        equipmentReference: machine.reference,
        currentMeterReading: machine.currentMeterReading,
        meterType: machine.meterType,
        asOf,
        items: schedules.map((s) => ({
          ...s,
          isStatutory: s.isStatutory === 1,
          due: byId.get(s.id) ?? null,
        })),
        governing: earliestDue(due),
      };
    },
  );

  /** The company-wide due/overdue register. Sweeps, so opening it is what
   *  makes the overdue-on-critical-plant Signals exist. */
  app.get(
    "/companies/current/equipment-maintenance",
    { preHandler: companyRead },
    async (req) => {
      const q = z
        .object({
          status: z
            .enum(["active", "due", "overdue", "suspended", "retired"])
            .optional(),
          criticalOnly: z.coerce.boolean().optional(),
          statutoryOnly: z.coerce.boolean().optional(),
        })
        .parse(req.query);
      const companyId = req.companyId!;
      await maybeSweep(companyId);
      const asOf = todayISO();
      const clauses = [eq(equipmentMaintenanceSchedules.companyId, companyId)];
      if (q.status)
        clauses.push(eq(equipmentMaintenanceSchedules.status, q.status));
      if (q.statutoryOnly)
        clauses.push(eq(equipmentMaintenanceSchedules.isStatutory, 1));
      const schedules = await app.db
        .select()
        .from(equipmentMaintenanceSchedules)
        .where(and(...clauses));
      const machineIds = [...new Set(schedules.map((s) => s.equipmentId))];
      const machines =
        machineIds.length > 0
          ? await app.db
              .select()
              .from(equipment)
              .where(inArray(equipment.id, machineIds))
          : [];
      const byId = new Map(machines.map((m) => [m.id, m] as const));
      const items = schedules
        .filter(
          (s) => !q.criticalOnly || byId.get(s.equipmentId)?.isCritical === 1,
        )
        .map((s) => {
          const machine = byId.get(s.equipmentId);
          const due = machine
            ? computeNextDue({
                intervalKind: s.intervalKind as MaintenanceIntervalKind,
                intervalValue: s.intervalValue,
                warnAheadValue: s.warnAheadValue,
                lastPerformedAt: s.lastPerformedAt,
                lastPerformedMeter: s.lastPerformedMeter,
                currentMeter: machine.currentMeterReading,
                meterType: machine.meterType as MeterType,
                baselineDate: machine.hireStartDate ?? machine.purchaseDate,
                asOf,
              })
            : null;
          return {
            ...s,
            isStatutory: s.isStatutory === 1,
            equipmentReference: machine?.reference ?? null,
            equipmentName: machine?.name ?? null,
            isCriticalPlant: machine?.isCritical === 1,
            due,
          };
        });
      items.sort((a, b) => {
        const rank = (x: typeof a) =>
          x.due?.status === "overdue"
            ? 0
            : x.due?.status === "due_soon"
              ? 1
              : 2;
        return (
          rank(a) - rank(b) ||
          (a.equipmentReference ?? "").localeCompare(b.equipmentReference ?? "")
        );
      });
      return {
        asOf,
        total: items.length,
        summary: {
          overdue: items.filter((i) => i.due?.status === "overdue").length,
          overdueOnCriticalPlant: items.filter(
            (i) => i.due?.status === "overdue" && i.isCriticalPlant,
          ).length,
          dueSoon: items.filter((i) => i.due?.status === "due_soon").length,
          notScheduled: items.filter((i) => i.due?.status === "not_scheduled")
            .length,
        },
        items,
      };
    },
  );

  const maintenanceRecordSchema = z.object({
    scheduleId: idRef.nullable().optional(),
    maintenanceType: z.enum(MAINTENANCE_TYPES).default("corrective"),
    description: nonEmpty(4000),
    faultDescription: z.string().max(4000).nullable().optional(),
    failureMode: z.string().max(200).nullable().optional(),
    workOrderRef: z.string().max(120).nullable().optional(),
    startedAt: isoTimestamp.nullable().optional(),
    performedAt: isoTimestamp.optional(),
    performedByWorkerId: idRef.nullable().optional(),
    providerVendorId: idRef.nullable().optional(),
    technicianName: z.string().max(200).nullable().optional(),
    meterReading: z.number().finite().min(0).nullable().optional(),
    downtimeHours: hours.nullable().optional(),
    labourHours: hours.nullable().optional(),
    partsUsed: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
    partsCost: money.nullable().optional(),
    labourCost: money.nullable().optional(),
    currency: z.string().length(3).optional(),
    isWarrantyClaim: z.boolean().default(false),
    isRechargeable: z.boolean().default(false),
    commitmentId: idRef.nullable().optional(),
    costCodeId: idRef.nullable().optional(),
    result: z.enum(MAINTENANCE_RESULTS).default("completed"),
    returnedToServiceAt: isoTimestamp.nullable().optional(),
    certificateFileId: idRef.nullable().optional(),
    fileIds: z.array(idRef).max(50).optional(),
    projectId: idRef.nullable().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  /**
   * Close out a schedule. The record is what actually happened; writing it
   * back onto the schedule (`lastPerformedAt`, `lastPerformedMeter`) is what
   * moves the next due date, so a service that is recorded but not linked to
   * its schedule leaves the schedule overdue for ever — which is why the
   * response says so when no scheduleId was given.
   */
  app.post(
    "/companies/current/equipment/:equipmentId/maintenance-records",
    { preHandler: companyWrite },
    async (req, reply) => {
      const { equipmentId } = req.params as { equipmentId: string };
      const body = maintenanceRecordSchema.parse(req.body);
      const companyId = req.companyId!;
      const machine = await fetchEquipment(equipmentId, companyId);
      let schedule:
        | typeof equipmentMaintenanceSchedules.$inferSelect
        | undefined;
      if (body.scheduleId) {
        const rows = await app.db
          .select()
          .from(equipmentMaintenanceSchedules)
          .where(
            and(
              eq(equipmentMaintenanceSchedules.id, body.scheduleId),
              eq(equipmentMaintenanceSchedules.companyId, companyId),
            ),
          )
          .limit(1);
        schedule = rows[0];
        if (!schedule)
          throw badRequest(
            "scheduleId is not a maintenance schedule in this company",
          );
        if (schedule.equipmentId !== equipmentId) {
          throw badRequest(
            `schedule ${body.scheduleId} belongs to a different machine — a service performed on ` +
              `${machine.reference} cannot close out another machine's schedule`,
          );
        }
      }
      const performedAt = body.performedAt
        ? new Date(body.performedAt).toISOString()
        : new Date().toISOString();
      const number = await nextRecordNumber(
        app.db,
        companyId,
        "equipment_maintenance",
      );
      const reference = `MNT-${pad(number)}`;
      const partsCost = body.partsCost ?? null;
      const labourCost = body.labourCost ?? null;
      const totalCost =
        partsCost === null && labourCost === null
          ? null
          : round2((partsCost ?? 0) + (labourCost ?? 0));

      // The next due point after this service, computed from the schedule's
      // own interval and the meter at which the work was actually done.
      const nextDue = schedule
        ? computeNextDue({
            intervalKind: schedule.intervalKind as MaintenanceIntervalKind,
            intervalValue: schedule.intervalValue,
            warnAheadValue: schedule.warnAheadValue,
            lastPerformedAt: performedAt.slice(0, 10),
            lastPerformedMeter:
              body.meterReading ?? machine.currentMeterReading,
            currentMeter: body.meterReading ?? machine.currentMeterReading,
            meterType: machine.meterType as MeterType,
            asOf: todayISO(),
          })
        : null;

      const id = newId("emr");
      await app.db.insert(equipmentMaintenanceRecords).values({
        id,
        companyId,
        projectId: body.projectId ?? machine.projectId ?? null,
        equipmentId,
        scheduleId: body.scheduleId ?? null,
        number,
        reference,
        maintenanceType: body.maintenanceType,
        workOrderRef: body.workOrderRef ?? null,
        description: body.description,
        faultDescription: body.faultDescription ?? null,
        failureMode: body.failureMode ?? null,
        status: "completed",
        startedAt: body.startedAt ?? null,
        performedAt,
        performedByWorkerId: body.performedByWorkerId ?? null,
        providerVendorId: body.providerVendorId ?? null,
        technicianName: body.technicianName ?? null,
        meterReading: body.meterReading ?? null,
        downtimeHours: body.downtimeHours ?? null,
        labourHours: body.labourHours ?? null,
        partsUsed: body.partsUsed ?? [],
        partsCost,
        labourCost,
        totalCost,
        currency: body.currency ?? machine.currency,
        isWarrantyClaim: body.isWarrantyClaim ? 1 : 0,
        isRechargeable: body.isRechargeable ? 1 : 0,
        commitmentId: body.commitmentId ?? null,
        costCodeId: body.costCodeId ?? machine.costCodeId,
        result: body.result,
        returnedToServiceAt: body.returnedToServiceAt ?? null,
        nextDueAt: nextDue?.nextDueAt ?? null,
        nextDueMeter: nextDue?.nextDueMeter ?? null,
        certificateFileId: body.certificateFileId ?? null,
        fileIds: body.fileIds ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });

      if (
        schedule &&
        (body.result === "completed" || body.result === "partial")
      ) {
        await app.db
          .update(equipmentMaintenanceSchedules)
          .set({
            lastPerformedAt: performedAt.slice(0, 10),
            /*
             * The BASELINE the next service is measured from, and it must be
             * the same input the record's own nextDue was computed from
             * (body.meterReading ?? machine.currentMeterReading). Storing the
             * OLD baseline when no reading was supplied left the schedule
             * measuring from the last service but two: the sweep recomputed
             * old-baseline + interval, found it already passed, and flipped
             * the schedule straight back to overdue — contradicting the
             * maintenance record that had just closed it.
             */
            lastPerformedMeter:
              body.meterReading ??
              machine.currentMeterReading ??
              schedule.lastPerformedMeter,
            nextDueAt: nextDue?.nextDueAt ?? null,
            nextDueMeter: nextDue?.nextDueMeter ?? null,
            status:
              nextDue?.status === "overdue"
                ? "overdue"
                : nextDue?.status === "due_soon"
                  ? "due"
                  : "active",
            updatedAt: new Date().toISOString(),
          })
          .where(eq(equipmentMaintenanceSchedules.id, schedule.id));
      }
      if (
        body.meterReading != null &&
        (machine.currentMeterReading === null ||
          body.meterReading >= machine.currentMeterReading)
      ) {
        await app.db
          .update(equipment)
          .set({
            currentMeterReading: body.meterReading,
            lastMeterReadingAt: performedAt,
            status:
              body.result === "condemned" ? "quarantined" : machine.status,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(equipment.id, equipmentId));
      } else if (body.result === "condemned") {
        await app.db
          .update(equipment)
          .set({
            status: "quarantined",
            condition: "unserviceable",
            updatedAt: new Date().toISOString(),
          })
          .where(eq(equipment.id, equipmentId));
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "equipment_maintenance_record",
        objectId: id,
        projectId: body.projectId ?? machine.projectId ?? null,
        payload: {
          reference,
          equipmentId,
          equipmentReference: machine.reference,
          scheduleId: body.scheduleId ?? null,
          maintenanceType: body.maintenanceType,
          result: body.result,
          meterReading: body.meterReading ?? null,
          totalCost,
          currency: body.currency ?? machine.currency,
          nextDueAt: nextDue?.nextDueAt ?? null,
          nextDueMeter: nextDue?.nextDueMeter ?? null,
        },
        storePayload: true,
      });
      const created = await fetchMaintenanceRecord(id, companyId);
      return reply.status(201).send({
        ...created,
        nextDue,
        scheduleNote: body.scheduleId
          ? null
          : "this record is not linked to a maintenance schedule, so no schedule has been moved " +
            "on. Whatever fell due is still showing as due — link the record to its schedule.",
        condemnedNote:
          body.result === "condemned"
            ? "the machine has been condemned and quarantined. On hired plant this must be " +
              "reported to the hire company's insurer; it is the only maintenance outcome that has to be."
            : null,
      });
    },
  );

  app.get(
    "/companies/current/equipment/:equipmentId/maintenance-records",
    { preHandler: companyRead },
    async (req) => {
      const { equipmentId } = req.params as { equipmentId: string };
      await fetchEquipment(equipmentId, req.companyId!);
      const q = pageQuerySchema.parse(req.query);
      const where = and(
        eq(equipmentMaintenanceRecords.companyId, req.companyId!),
        eq(equipmentMaintenanceRecords.equipmentId, equipmentId),
      );
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(equipmentMaintenanceRecords)
        .where(where);
      const rows = await app.db
        .select()
        .from(equipmentMaintenanceRecords)
        .where(where)
        .orderBy(desc(equipmentMaintenanceRecords.performedAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows, Number(totalRow?.n ?? 0), q);
    },
  );

  /** Verification of the work. Schema comment: never the person who
   *  performed it — a fitter signing off their own repair is not a check. */
  app.post(
    "/companies/current/equipment-maintenance-records/:recordId/verify",
    { preHandler: companyAdmin },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const body = z
        .object({
          note: z.string().max(2000).optional(),
          returnToService: z.boolean().default(false),
        })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const record = await fetchMaintenanceRecord(recordId, companyId);
      if (record.verifiedBy)
        throw conflict("this maintenance record has already been verified");
      const override = await assertIndependent(
        req,
        record.createdBy,
        "maintenance verification",
        record.projectId,
      );
      const now = new Date().toISOString();
      await app.db
        .update(equipmentMaintenanceRecords)
        .set({
          verifiedBy: req.user!.id,
          verifiedAt: now,
          status: "verified",
          returnedToServiceAt: body.returnToService
            ? (record.returnedToServiceAt ?? now)
            : record.returnedToServiceAt,
          returnedToServiceBy: body.returnToService
            ? req.user!.id
            : record.returnedToServiceBy,
          updatedAt: now,
        })
        .where(eq(equipmentMaintenanceRecords.id, recordId));
      if (body.returnToService) {
        await app.db
          .update(equipment)
          .set({ status: "available", updatedAt: now })
          .where(
            and(
              eq(equipment.id, record.equipmentId),
              inArray(equipment.status, [
                "under_maintenance",
                "breakdown",
                "quarantined",
              ]),
            ),
          );
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment_maintenance_record",
        objectId: recordId,
        projectId: record.projectId,
        payload: {
          verified: true,
          performedBy: record.createdBy,
          returnedToService: body.returnToService,
          note: body.note ?? null,
          selfVerifiedUnderOverride: override,
        },
        storePayload: true,
      });
      return {
        ...(await fetchMaintenanceRecord(recordId, companyId)),
        independentVerification: !override,
      };
    },
  );

  /* ================================================================ */
  /* METER AND FUEL READINGS — flagged, never silently stored          */
  /* ================================================================ */

  const readingCreateSchema = z.object({
    readingType: z.enum(EQUIPMENT_READING_TYPES),
    readAt: isoTimestamp.optional(),
    value: z.number().finite().nullable().optional(),
    unit: z.string().max(40).nullable().optional(),
    fuelLitres: z.number().finite().nullable().optional(),
    fuelCost: money.nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    fuelCardRef: z.string().max(120).nullable().optional(),
    supplierVendorId: idRef.nullable().optional(),
    docketNumber: z.string().max(120).nullable().optional(),
    operatorWorkerId: idRef.nullable().optional(),
    locationId: idRef.nullable().optional(),
    locationText: z.string().max(300).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    source: z.enum(EQUIPMENT_DATA_SOURCES).default("manual"),
    sourceRef: z.string().max(200).nullable().optional(),
    photoFileId: idRef.nullable().optional(),
    projectId: idRef.nullable().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  /**
   * Record a meter or fuel reading, checked against the machine's history
   * and its physical limits.
   *
   * The anomaly is FLAGGED AND STORED, never rejected: a refused reading is
   * a reading nobody can audit, and the anomalous ones are exactly the rows
   * worth keeping. An anomalous reading does not advance the machine's
   * current meter — a backwards or impossible figure must not become the
   * basis of the next maintenance calculation.
   */
  app.post(
    "/companies/current/equipment/:equipmentId/readings",
    { preHandler: companyWrite },
    async (req, reply) => {
      const { equipmentId } = req.params as { equipmentId: string };
      const body = readingCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const machine = await fetchEquipment(equipmentId, companyId);
      if (body.supplierVendorId)
        await assertVendor(body.supplierVendorId, companyId);
      const readAt = body.readAt
        ? new Date(body.readAt).toISOString()
        : new Date().toISOString();
      const previous = await app.db
        .select({
          value: equipmentReadings.value,
          readAt: equipmentReadings.readAt,
        })
        .from(equipmentReadings)
        .where(
          and(
            eq(equipmentReadings.equipmentId, equipmentId),
            eq(equipmentReadings.readingType, body.readingType),
            eq(equipmentReadings.isAnomalous, 0),
          ),
        )
        .orderBy(desc(equipmentReadings.readAt))
        .limit(1);
      const prev = previous[0] ?? null;
      const anomaly = detectReadingAnomaly({
        readingType: body.readingType,
        value: body.value ?? null,
        readAt,
        previousValue: prev?.value ?? null,
        previousReadAt: prev?.readAt ?? null,
        meterType: machine.meterType as MeterType,
        fuelLitres: body.fuelLitres ?? null,
        fuelCapacityLitres: machine.fuelCapacityLitres,
        nowIso: new Date().toISOString(),
      });

      const id = newId("eqr");
      await app.db.insert(equipmentReadings).values({
        id,
        companyId,
        projectId: body.projectId ?? machine.projectId ?? null,
        equipmentId,
        readingType: body.readingType,
        readAt,
        value: body.value ?? null,
        unit: body.unit ?? (body.readingType === "hours" ? "hours" : null),
        previousValue: prev?.value ?? null,
        delta: anomaly.delta,
        fuelLitres: body.fuelLitres ?? null,
        fuelCost: body.fuelCost ?? null,
        currency:
          body.currency ?? (body.fuelCost != null ? machine.currency : null),
        fuelCardRef: body.fuelCardRef ?? null,
        supplierVendorId: body.supplierVendorId ?? null,
        docketNumber: body.docketNumber ?? null,
        operatorWorkerId: body.operatorWorkerId ?? null,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        source: body.source,
        sourceRef: body.sourceRef ?? null,
        photoFileId: body.photoFileId ?? null,
        isAnomalous: anomaly.isAnomalous ? 1 : 0,
        anomalyNote: anomaly.note,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });

      let signalId: string | null = null;
      if (anomaly.isAnomalous) {
        const seen = await alreadySignalled(
          companyId,
          "equipment_meter_anomaly",
        );
        signalId = await raiseSignalOnce({
          companyId,
          projectId: body.projectId ?? machine.projectId ?? null,
          detector: "equipment_meter_anomaly",
          key: id,
          severity: anomalySeverity(anomaly.kinds),
          title: `Reading anomaly — ${machine.reference} ${machine.name} (${anomaly.kinds.join(", ")})`,
          explanation:
            `A ${body.readingType} reading on ${machine.reference} ${machine.name} did not survive ` +
            `the physical check: ${anomaly.note}. The reading has been STORED and flagged rather ` +
            `than discarded, because the anomalous readings are the ones worth having — and it has ` +
            `NOT advanced the machine's current meter, so the next service interval is still ` +
            `computed from a figure somebody can defend. Check the docket, the photograph and who ` +
            `took it.`,
          refs: {
            readingId: id,
            equipmentId,
            equipmentReference: machine.reference,
            readingType: body.readingType,
            value: body.value ?? null,
            previousValue: prev?.value ?? null,
            delta: anomaly.delta,
            ratePerDay: anomaly.ratePerDay,
            kinds: anomaly.kinds,
            fuelLitres: body.fuelLitres ?? null,
            fuelCapacityLitres: machine.fuelCapacityLitres,
          },
          seen,
        });
        if (signalId) {
          await app.db
            .update(equipmentReadings)
            .set({ signalId })
            .where(eq(equipmentReadings.id, id));
        }
      } else if (
        body.value != null &&
        ["hours", "odometer", "cycles"].includes(body.readingType)
      ) {
        await app.db
          .update(equipment)
          .set({
            currentMeterReading: body.value,
            lastMeterReadingAt: readAt,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(equipment.id, equipmentId));
      }

      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "equipment_reading",
        objectId: id,
        projectId: body.projectId ?? machine.projectId ?? null,
        payload: {
          equipmentId,
          equipmentReference: machine.reference,
          readingType: body.readingType,
          readAt,
          value: body.value ?? null,
          previousValue: prev?.value ?? null,
          fuelLitres: body.fuelLitres ?? null,
          isAnomalous: anomaly.isAnomalous,
          anomalyKinds: anomaly.kinds,
          signalId,
        },
        storePayload: true,
      });

      const rows = await app.db
        .select()
        .from(equipmentReadings)
        .where(eq(equipmentReadings.id, id))
        .limit(1);
      return reply.status(201).send({
        ...rows[0],
        anomaly,
        signalId,
        meterAdvanced: !anomaly.isAnomalous && body.value != null,
      });
    },
  );

  app.get(
    "/companies/current/equipment/:equipmentId/readings",
    { preHandler: companyRead },
    async (req) => {
      const { equipmentId } = req.params as { equipmentId: string };
      await fetchEquipment(equipmentId, req.companyId!);
      const q = pageQuerySchema
        .extend({
          readingType: z.enum(EQUIPMENT_READING_TYPES).optional(),
          anomalousOnly: z.coerce.boolean().optional(),
        })
        .parse(req.query);
      const clauses = [
        eq(equipmentReadings.companyId, req.companyId!),
        eq(equipmentReadings.equipmentId, equipmentId),
      ];
      if (q.readingType)
        clauses.push(eq(equipmentReadings.readingType, q.readingType));
      if (q.anomalousOnly) clauses.push(eq(equipmentReadings.isAnomalous, 1));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(equipmentReadings)
        .where(where);
      const rows = await app.db
        .select()
        .from(equipmentReadings)
        .where(where)
        .orderBy(desc(equipmentReadings.readAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(
        rows.map((r) => ({ ...r, isAnomalous: r.isAnomalous === 1 })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  /* ================================================================ */
  /* TELEMATICS — through the ingestion pipeline, not around it        */
  /* ================================================================ */

  const telematicsPushSchema = z.object({
    projectId: idRef.optional(),
    providerKey: z.enum(TELEMATICS_PROVIDERS).default("generic_aemp"),
    records: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .max(MAX_TELEMATICS_RECORDS),
  });

  /**
   * Machine push, verified exactly as `modules/ingestion` verifies its own:
   * `Authorization: Bearer cok_…` hashed with sha256 against `api_tokens`,
   * revocation and expiry checked, scope checked. No JWT, no session — the
   * pathway-level separation ADR 0014 asks for, so the party asserting the
   * hours does not share a credential with the party claiming them.
   */
  async function authenticateTelematicsToken(req: FastifyRequest) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
      throw unauthorized("Missing bearer token");
    const rawToken = header.slice(7).trim();
    const rows = await app.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, sha256Hex(rawToken)))
      .limit(1);
    const token = rows[0];
    if (!token) throw unauthorized("Invalid API token");
    if (token.revokedAt) throw unauthorized("API token has been revoked");
    if (isExpired(token.expiresAt)) throw unauthorized("API token has expired");
    const scopes = token.scopes as string[];
    if (!scopes.some((s) => TELEMATICS_PUSH_SCOPES.includes(s))) {
      throw forbidden(
        `Token is not scoped for telematics — it holds [${scopes.join(", ")}] and needs one of ` +
          `[${TELEMATICS_PUSH_SCOPES.join(", ")}]`,
      );
    }
    await app.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiTokens.id, token.id));
    return token;
  }

  /** One implicit `api_token` ingestion source per token, created on first
   *  use — the same row the ingestion module's own push endpoint makes, so a
   *  token that pushes both datasets has one source, not two. */
  async function implicitSource(
    token: typeof apiTokens.$inferSelect,
  ): Promise<string> {
    const candidates = await app.db
      .select()
      .from(ingestionSources)
      .where(
        and(
          eq(ingestionSources.companyId, token.companyId),
          eq(ingestionSources.kind, "api_token"),
        ),
      );
    const existing = candidates.find(
      (s) => (s.config as Record<string, unknown>)["tokenId"] === token.id,
    );
    if (existing) return existing.id;
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
    return sourceId;
  }

  /**
   * `POST /ingestion/push/telematics` — a STATIC sibling of the ingestion
   * module's `POST /ingestion/push/:dataset`. Same inlet, same credential,
   * same staging tables, same provenance; the only reason it is handled here
   * rather than there is that the coercion and the equipment-mapping step
   * belong to this module's schema.
   *
   * Idempotent on `(providerKey, deviceId, recordedAt)` — the UNIQUE index —
   * so a replayed batch reports duplicates and commits nothing. Rows whose
   * device nobody has mapped land with `equipmentId: null` and are LISTED,
   * never dropped.
   */
  app.post("/ingestion/push/telematics", async (req, reply) => {
    const token = await authenticateTelematicsToken(req);
    const body = telematicsPushSchema.parse(req.body);
    const companyId = token.companyId;
    const projectId = body.projectId ?? null;
    if (projectId) {
      const rows = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.id, projectId), eq(projects.companyId, companyId)),
        )
        .limit(1);
      if (!rows[0])
        throw badRequest("projectId is not a project in this company");
    }

    const sourceId = await implicitSource(token);
    const runId = newId("irn");
    await app.db.insert(ingestionRuns).values({
      id: runId,
      companyId,
      projectId,
      sourceId,
      dataset: TELEMATICS_DATASET,
      status: "staging",
      totalRows: body.records.length,
      // the TOKEN, not a person: no operator session authored these rows
      startedBy: token.id,
    });

    /* stage every record verbatim, then validate */
    const staged = body.records.map((record, i) => {
      const coerced = coerceTelematicsRow(record, {
        providerKey: body.providerKey,
      });
      const externalRaw = record["externalId"];
      return {
        rowNumber: i + 1,
        recordId: newId("irc"),
        externalId:
          typeof externalRaw === "string" && externalRaw.trim() !== ""
            ? externalRaw.trim()
            : null,
        record,
        coerced,
      };
    });
    await app.db.insert(ingestedRecords).values(
      staged.map((s) => ({
        id: s.recordId,
        runId,
        companyId,
        rowNumber: s.rowNumber,
        externalId: s.externalId,
        payload: s.record,
        status: "staged" as const,
      })),
    );

    const report: {
      row: number;
      field: string | null;
      code: string;
      message: string;
    }[] = [];
    const accepted: typeof staged = [];
    for (const s of staged) {
      if (s.coerced.row === null) {
        for (const issue of s.coerced.issues) {
          report.push({
            row: s.rowNumber,
            field: issue.field,
            code: issue.code,
            message: issue.message,
          });
        }
        await app.db
          .update(ingestedRecords)
          .set({
            status: "rejected",
            reason: s.coerced.issues.map((i) => i.message).join("; "),
          })
          .where(eq(ingestedRecords.id, s.recordId));
      } else {
        accepted.push(s);
      }
    }

    /* dedupe: against the batch itself and against what is already stored */
    const deviceIds = [
      ...new Set(accepted.map((s) => s.coerced.row!.deviceId)),
    ];
    const existingKeys = new Set<string>();
    if (deviceIds.length > 0) {
      /*
       * BOUNDED BY THE BATCH'S OWN TIME WINDOW. This used to select every
       * reading ever stored for each device in the push: a machine reporting
       * every minute accumulates half a million rows a year, so each push read
       * the entire history to look for duplicates of the last five minutes.
       * The (company_id, device_id, recorded_at) index makes this a range scan,
       * and the unique index + ON CONFLICT below is the backstop for a racing
       * concurrent push.
       */
      const times = accepted.map((s) => s.coerced.row!.recordedAt).sort();
      const earliest = times[0]!;
      const latest = times[times.length - 1]!;
      const existing = await app.db
        .select({
          providerKey: equipmentTelematicsReadings.providerKey,
          deviceId: equipmentTelematicsReadings.deviceId,
          recordedAt: equipmentTelematicsReadings.recordedAt,
        })
        .from(equipmentTelematicsReadings)
        .where(
          and(
            eq(equipmentTelematicsReadings.companyId, companyId),
            inArray(equipmentTelematicsReadings.deviceId, deviceIds),
            gte(equipmentTelematicsReadings.recordedAt, earliest),
            lte(equipmentTelematicsReadings.recordedAt, latest),
          ),
        );
      for (const row of existing) {
        existingKeys.add(
          telematicsKey(row.providerKey, row.deviceId, row.recordedAt),
        );
      }
    }

    /* device → machine mapping. Unmapped is a null equipmentId, never a drop. */
    const fleet =
      deviceIds.length > 0
        ? await app.db
            .select()
            .from(equipment)
            .where(
              and(
                eq(equipment.companyId, companyId),
                inArray(equipment.telematicsDeviceId, deviceIds),
              ),
            )
        : [];
    const mapped = new Map<string, typeof equipment.$inferSelect>();
    for (const m of fleet) {
      if (!m.telematicsDeviceId) continue;
      mapped.set(`${m.telematicsProvider ?? "*"}|${m.telematicsDeviceId}`, m);
      if (!m.telematicsProvider) mapped.set(`*|${m.telematicsDeviceId}`, m);
    }
    const resolve = (providerKey: string, deviceId: string) =>
      mapped.get(`${providerKey}|${deviceId}`) ??
      mapped.get(`*|${deviceId}`) ??
      null;

    const inserts: (typeof equipmentTelematicsReadings.$inferInsert)[] = [];
    const commits: { recordId: string; readingId: string }[] = [];
    /** staged rows that were duplicates — updated in ONE statement, not 5000 */
    const skippedIds: string[] = [];
    let duplicates = 0;
    const unmappedDevices = new Set<string>();
    const seenInBatch = new Set<string>();
    /** highest engine-hour counter seen per machine, to advance the meter */
    const meterHigh = new Map<string, { hours: number; at: string }>();

    for (const s of accepted) {
      const row = s.coerced.row!;
      const key = telematicsKey(row.providerKey, row.deviceId, row.recordedAt);
      if (existingKeys.has(key) || seenInBatch.has(key)) {
        duplicates += 1;
        skippedIds.push(s.recordId);
        continue;
      }
      seenInBatch.add(key);
      const machine = resolve(row.providerKey, row.deviceId);
      if (!machine) unmappedDevices.add(`${row.providerKey}|${row.deviceId}`);
      if (machine && row.engineHours !== null) {
        const held = meterHigh.get(machine.id);
        if (!held || row.engineHours > held.hours) {
          meterHigh.set(machine.id, {
            hours: row.engineHours,
            at: row.recordedAt,
          });
        }
      }
      const readingId = newId("etr");
      inserts.push({
        id: readingId,
        companyId,
        projectId: projectId ?? machine?.projectId ?? null,
        equipmentId: machine?.id ?? null,
        providerKey: row.providerKey,
        deviceId: row.deviceId,
        externalId: row.externalId,
        recordedAt: row.recordedAt,
        latitude: row.latitude,
        longitude: row.longitude,
        altitudeMetres: row.altitudeMetres,
        headingDegrees: row.headingDegrees,
        speedKph: row.speedKph,
        engineRunning: row.engineRunning,
        engineHours: row.engineHours,
        idleHours: row.idleHours,
        odometerKm: row.odometerKm,
        fuelLevelPercent: row.fuelLevelPercent,
        fuelUsedLitres: row.fuelUsedLitres,
        engineLoadPercent: row.engineLoadPercent,
        coolantTempC: row.coolantTempC,
        batteryVoltage: row.batteryVoltage,
        defLevelPercent: row.defLevelPercent,
        payloadTonnes: row.payloadTonnes,
        faultCodes: row.faultCodes,
        raw: row.raw,
        ingestionRunId: runId,
        apiTokenId: token.id,
        sourceSha256: hashPayload(row.raw),
      });
      commits.push({ recordId: s.recordId, readingId });
    }

    /*
     * ON CONFLICT DO NOTHING against (provider_key, device_id, recorded_at):
     * the in-memory dedupe above cannot see a batch that is landing on another
     * replica at the same moment. RETURNING tells us which rows actually
     * landed, so a row lost to the race is reported as a duplicate rather than
     * committed against a reading that is not ours.
     */
    const insertedIds = new Set<string>();
    for (let i = 0; i < inserts.length; i += 500) {
      const returned = await app.db
        .insert(equipmentTelematicsReadings)
        .values(inserts.slice(i, i + 500))
        .onConflictDoNothing({
          target: [
            equipmentTelematicsReadings.providerKey,
            equipmentTelematicsReadings.deviceId,
            equipmentTelematicsReadings.recordedAt,
          ],
        })
        .returning({ id: equipmentTelematicsReadings.id });
      for (const r of returned) insertedIds.add(r.id);
    }
    const landed = commits.filter((c) => insertedIds.has(c.readingId));
    for (const c of commits) {
      if (!insertedIds.has(c.readingId)) {
        duplicates += 1;
        skippedIds.push(c.recordId);
      }
    }
    // One UPDATE per 200 staged rows instead of one per row.
    for (let i = 0; i < skippedIds.length; i += 200) {
      const chunk = skippedIds.slice(i, i + 200);
      await app.db
        .update(ingestedRecords)
        .set({
          status: "skipped",
          reason:
            "duplicate of a reading already stored for this (provider, device, timestamp) — " +
            "replaying a batch never double-counts",
        })
        .where(inArray(ingestedRecords.id, chunk));
    }
    for (let i = 0; i < landed.length; i += 200) {
      const chunk = landed.slice(i, i + 200);
      await app.db
        .update(ingestedRecords)
        .set({
          status: "committed",
          committedRecordId: sql`case ${ingestedRecords.id} ${sql.join(
            chunk.map((c) => sql`when ${c.recordId} then ${c.readingId}`),
            sql` `,
          )} end`,
        })
        .where(
          inArray(
            ingestedRecords.id,
            chunk.map((c) => c.recordId),
          ),
        );
    }
    for (const [equipmentId, high] of meterHigh) {
      const machine = fleet.find((m) => m.id === equipmentId);
      if (!machine) continue;
      const advance =
        machine.meterType === "hours" &&
        (machine.currentMeterReading === null ||
          high.hours > machine.currentMeterReading);
      await app.db
        .update(equipment)
        .set({
          telematicsLastSeenAt: high.at,
          currentMeterReading: advance
            ? high.hours
            : machine.currentMeterReading,
          lastMeterReadingAt: advance ? high.at : machine.lastMeterReadingAt,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(equipment.id, equipmentId));
    }

    const committed = landed.length;
    const rejected = staged.length - accepted.length;
    await app.db
      .update(ingestionRuns)
      .set({
        status: "committed",
        stagedCount: accepted.length,
        committedCount: committed,
        rejectedCount: rejected,
        skippedCount: duplicates,
        report: report.slice(0, 500),
        committedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(ingestionRuns.id, runId));
    await appendLedger(app.db, {
      companyId,
      actorId: null,
      action: "create",
      objectType: "ingestion_run",
      objectId: runId,
      projectId,
      payload: {
        via: "api_token_push",
        dataset: TELEMATICS_DATASET,
        tokenId: token.id,
        tokenPrefix: token.tokenPrefix,
        provider: body.providerKey,
        received: body.records.length,
        committed,
        duplicates,
        rejected,
        unmappedDevices: [...unmappedDevices],
      },
      storePayload: true,
    });

    return reply.status(201).send({
      runId,
      dataset: TELEMATICS_DATASET,
      provider: body.providerKey,
      received: body.records.length,
      staged: accepted.length,
      committed,
      duplicates,
      rejected,
      unmappedDeviceCount: unmappedDevices.size,
      unmappedDevices: [...unmappedDevices].map((k) => {
        const [providerKey, deviceId] = k.split("|");
        return { providerKey, deviceId };
      }),
      report,
      idempotencyNote:
        "readings are unique on (providerKey, deviceId, recordedAt). A replayed batch reports " +
        "duplicates and commits nothing — it can never double-count engine hours.",
      unmappedNote:
        unmappedDevices.size > 0
          ? `${unmappedDevices.size} device(s) are not mapped to a machine. Their readings HAVE ` +
            "been stored with a null equipmentId and are listed at " +
            "GET /companies/current/telematics/devices — they are the evidence of when the " +
            "register was wrong, and dropping them would destroy exactly that."
          : null,
    });
  });

  /** What the inlet accepts — published so a vendor can be told what to send. */
  app.get(
    "/companies/current/telematics/dataset",
    { preHandler: companyRead },
    async () => ({
      dataset: TELEMATICS_DATASET,
      endpoint: "POST /api/v1/ingestion/push/telematics",
      auth: "Authorization: Bearer <api token>, scoped for telematics (see acceptedScopes)",
      acceptedScopes: TELEMATICS_PUSH_SCOPES,
      providers: TELEMATICS_PROVIDERS,
      idempotencyKey: ["providerKey", "deviceId", "recordedAt"],
      fields: TELEMATICS_FIELDS,
      provenance: ["ingestionRunId", "apiTokenId", "sourceSha256", "raw"],
    }),
  );

  /**
   * Devices the feed is reporting that nobody has mapped to a machine.
   * These are the rows that would have been dropped by a naive importer, and
   * they are the ones that prove a machine was running while the register
   * said it was in the yard.
   */
  app.get(
    "/companies/current/telematics/devices",
    { preHandler: companyRead },
    async (req) => {
      const q = z
        .object({
          mapped: z.coerce.boolean().optional(),
          providerKey: z.enum(TELEMATICS_PROVIDERS).optional(),
        })
        .parse(req.query);
      const clauses = [
        eq(equipmentTelematicsReadings.companyId, req.companyId!),
      ];
      if (q.providerKey)
        clauses.push(
          eq(equipmentTelematicsReadings.providerKey, q.providerKey),
        );
      if (q.mapped === true)
        clauses.push(isNotNull(equipmentTelematicsReadings.equipmentId));
      if (q.mapped !== true)
        clauses.push(isNull(equipmentTelematicsReadings.equipmentId));
      const rows = await app.db
        .select({
          providerKey: equipmentTelematicsReadings.providerKey,
          deviceId: equipmentTelematicsReadings.deviceId,
          readings: count(),
          firstSeenAt: sql<string>`min(${equipmentTelematicsReadings.recordedAt})`,
          lastSeenAt: sql<string>`max(${equipmentTelematicsReadings.recordedAt})`,
          lastEngineHours: sql<
            number | null
          >`max(${equipmentTelematicsReadings.engineHours})`,
        })
        .from(equipmentTelematicsReadings)
        .where(and(...clauses))
        .groupBy(
          equipmentTelematicsReadings.providerKey,
          equipmentTelematicsReadings.deviceId,
        );
      return {
        mapped: q.mapped === true,
        total: rows.length,
        items: rows.map((r) => ({ ...r, readings: Number(r.readings) })),
        note:
          q.mapped === true
            ? null
            : "these devices are reporting to a machine nobody has identified. Every reading has " +
              "been kept with a null equipmentId; map the device and the history binds to the " +
              "machine retrospectively.",
      };
    },
  );

  /** Map a device to a machine — and BACKFILL the readings already stored
   *  under it, which is the entire reason they were kept. */
  app.post(
    "/companies/current/telematics/devices/map",
    { preHandler: companyAdmin },
    async (req) => {
      const body = z
        .object({
          providerKey: z.enum(TELEMATICS_PROVIDERS),
          deviceId: nonEmpty(200),
          equipmentId: idRef,
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const machine = await fetchEquipment(body.equipmentId, companyId);
      const clash = await app.db
        .select({ id: equipment.id, reference: equipment.reference })
        .from(equipment)
        .where(
          and(
            eq(equipment.companyId, companyId),
            eq(equipment.telematicsDeviceId, body.deviceId),
          ),
        );
      const other = clash.find((c) => c.id !== body.equipmentId);
      if (other) {
        throw conflict(
          `device ${body.deviceId} is already mapped to ${other.reference}. One device cannot report ` +
            "for two machines — unmap it there first, and check which machine the history belongs to.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(equipment)
        .set({
          telematicsProvider: body.providerKey,
          telematicsDeviceId: body.deviceId,
          updatedAt: now,
        })
        .where(eq(equipment.id, body.equipmentId));
      const backfilled = await app.db
        .update(equipmentTelematicsReadings)
        .set({ equipmentId: body.equipmentId, projectId: machine.projectId })
        .where(
          and(
            eq(equipmentTelematicsReadings.companyId, companyId),
            eq(equipmentTelematicsReadings.providerKey, body.providerKey),
            eq(equipmentTelematicsReadings.deviceId, body.deviceId),
            isNull(equipmentTelematicsReadings.equipmentId),
          ),
        )
        .returning({ id: equipmentTelematicsReadings.id });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "equipment",
        objectId: body.equipmentId,
        projectId: machine.projectId,
        payload: {
          telematicsMapped: true,
          providerKey: body.providerKey,
          deviceId: body.deviceId,
          backfilledReadings: backfilled.length,
        },
        storePayload: true,
      });
      return {
        equipmentId: body.equipmentId,
        equipmentReference: machine.reference,
        providerKey: body.providerKey,
        deviceId: body.deviceId,
        backfilledReadings: backfilled.length,
        note:
          backfilled.length > 0
            ? `${backfilled.length} reading(s) that arrived before anyone mapped this device have ` +
              "been bound to the machine. That history is now available to the hours reconciliation."
            : "no unmapped readings were waiting for this device",
      };
    },
  );

  app.get(
    "/companies/current/telematics/readings",
    { preHandler: companyRead },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          equipmentId: idRef.optional(),
          deviceId: z.string().max(200).optional(),
          providerKey: z.enum(TELEMATICS_PROVIDERS).optional(),
          from: isoTimestamp.optional(),
          to: isoTimestamp.optional(),
          unmappedOnly: z.coerce.boolean().optional(),
        })
        .parse(req.query);
      const clauses = [
        eq(equipmentTelematicsReadings.companyId, req.companyId!),
      ];
      if (q.equipmentId)
        clauses.push(
          eq(equipmentTelematicsReadings.equipmentId, q.equipmentId),
        );
      if (q.deviceId)
        clauses.push(eq(equipmentTelematicsReadings.deviceId, q.deviceId));
      if (q.providerKey)
        clauses.push(
          eq(equipmentTelematicsReadings.providerKey, q.providerKey),
        );
      if (q.from)
        clauses.push(
          gte(
            equipmentTelematicsReadings.recordedAt,
            new Date(q.from).toISOString(),
          ),
        );
      if (q.to)
        clauses.push(
          lte(
            equipmentTelematicsReadings.recordedAt,
            new Date(q.to).toISOString(),
          ),
        );
      if (q.unmappedOnly)
        clauses.push(isNull(equipmentTelematicsReadings.equipmentId));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(equipmentTelematicsReadings)
        .where(where);
      const rows = await app.db
        .select()
        .from(equipmentTelematicsReadings)
        .where(where)
        .orderBy(desc(equipmentTelematicsReadings.recordedAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows, Number(totalRow?.n ?? 0), q);
    },
  );

  /**
   * TELEMATICS versus MANUAL — the independent-evidence-stream check.
   *
   * The machine's own ECU says one thing and the person filling in the plant
   * sheet says another. Neither is authoritative on its own; the DIFFERENCE
   * is the product, exactly as it is for site access against payroll in the
   * workforce module. A persistent variance is a Signal, keyed on the
   * machine, so it becomes one standing conversation rather than a fresh
   * alert every time somebody opens the page.
   *
   * The write-back onto `equipment_utilisation.telematicsWorkingHours` /
   * `.varianceHours` is what those columns exist for: the reconciliation
   * must be readable from the utilisation row itself, not only from here.
   */
  app.get(
    "/projects/:projectId/equipment-telematics/reconciliation",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({
          from: isoDateSchema.optional(),
          to: isoDateSchema.optional(),
          days: z.coerce.number().int().min(1).max(180).optional(),
          equipmentId: idRef.optional(),
        })
        .parse(req.query);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const to = q.to ?? todayISO();
      const from = q.from ?? addDaysISO(to, -((q.days ?? 14) - 1));

      const utilClauses = [
        eq(equipmentUtilisation.companyId, companyId),
        eq(equipmentUtilisation.projectId, projectId),
        gte(equipmentUtilisation.utilisationDate, from),
        lte(equipmentUtilisation.utilisationDate, to),
      ];
      if (q.equipmentId)
        utilClauses.push(eq(equipmentUtilisation.equipmentId, q.equipmentId));
      const utilRows = await app.db
        .select()
        .from(equipmentUtilisation)
        .where(and(...utilClauses));

      const assigned = await app.db
        .select({ equipmentId: equipmentAssignments.equipmentId })
        .from(equipmentAssignments)
        .where(
          and(
            eq(equipmentAssignments.companyId, companyId),
            eq(equipmentAssignments.projectId, projectId),
          ),
        );
      const machineIds = [
        ...new Set([
          ...utilRows.map((r) => r.equipmentId),
          ...assigned.map((a) => a.equipmentId),
        ]),
      ].filter((id) => !q.equipmentId || id === q.equipmentId);
      if (machineIds.length === 0) {
        return {
          from,
          to,
          machines: 0,
          machinesWithVariance: 0,
          machinesPersistent: 0,
          valueAtRiskByCurrency: {},
          totals: {
            manualHours: 0,
            telematicsHours: 0,
            varianceHours: 0,
            daysCompared: 0,
          },
          rows: [],
          method:
            "no plant has been assigned to this project and no utilisation has been recorded — " +
            "there is nothing to reconcile",
        };
      }
      const fleet = await app.db
        .select()
        .from(equipment)
        .where(
          and(
            eq(equipment.companyId, companyId),
            inArray(equipment.id, machineIds),
          ),
        );
      const teleRows = await app.db
        .select()
        .from(equipmentTelematicsReadings)
        .where(
          and(
            eq(equipmentTelematicsReadings.companyId, companyId),
            inArray(equipmentTelematicsReadings.equipmentId, machineIds),
            gte(
              equipmentTelematicsReadings.recordedAt,
              `${from}T00:00:00.000Z`,
            ),
            lte(equipmentTelematicsReadings.recordedAt, `${to}T23:59:59.999Z`),
          ),
        );

      /* telematics engine hours per machine per calendar day (UTC) */
      const teleByMachineDay = new Map<
        string,
        { recordedAt: string; engineHours: number | null }[]
      >();
      for (const row of teleRows) {
        if (!row.equipmentId) continue;
        const key = `${row.equipmentId}|${dateOf(row.recordedAt)}`;
        const list = teleByMachineDay.get(key) ?? [];
        list.push({ recordedAt: row.recordedAt, engineHours: row.engineHours });
        teleByMachineDay.set(key, list);
      }
      /* manual hours per machine per day — shifts on the same day are summed,
         because the telematics counter does not know about shifts */
      const manualByMachineDay = new Map<
        string,
        { hours: number; rowIds: string[] }
      >();
      for (const row of utilRows) {
        const key = `${row.equipmentId}|${row.utilisationDate}`;
        const held = manualByMachineDay.get(key) ?? { hours: 0, rowIds: [] };
        held.hours = round2(held.hours + row.workingHours);
        held.rowIds.push(row.id);
        manualByMachineDay.set(key, held);
      }

      const inputs: EquipmentReconcileInput[] = fleet.map((machine) => {
        const dates = new Set<string>();
        for (const key of manualByMachineDay.keys()) {
          const [id, date] = key.split("|");
          if (id === machine.id && date) dates.add(date);
        }
        for (const key of teleByMachineDay.keys()) {
          const [id, date] = key.split("|");
          if (id === machine.id && date) dates.add(date);
        }
        const days: TelematicsDayInput[] = [...dates].sort().map((date) => {
          const counter = engineHoursFromCounter(
            teleByMachineDay.get(`${machine.id}|${date}`) ?? [],
          );
          const manual = manualByMachineDay.get(`${machine.id}|${date}`);
          return {
            date,
            manualWorkingHours: manual ? manual.hours : null,
            telematicsEngineHours: counter.hours,
            telematicsReasons: counter.reasons,
          };
        });
        return {
          equipmentId: machine.id,
          reference: machine.reference,
          name: machine.name,
          currency: machine.currency,
          hireRateAmount: machine.hireRateAmount,
          hireRateUnit: machine.hireRateUnit as HireRateUnit | null,
          internalRateAmount: machine.internalRateAmount,
          operatorRateAmount: machine.operatorRateAmount,
          days,
        };
      });

      const summary = reconcileTelematics(inputs, {
        periodStart: from,
        periodEnd: to,
      });

      /* write the comparison back onto the utilisation rows */
      const now = new Date().toISOString();
      for (const machineRow of summary.rows) {
        for (const day of machineRow.days) {
          const manual = manualByMachineDay.get(
            `${machineRow.equipmentId}|${day.date}`,
          );
          if (!manual) continue;
          for (const rowId of manual.rowIds) {
            const existing = utilRows.find((r) => r.id === rowId);
            if (
              existing &&
              existing.telematicsWorkingHours === day.telematicsEngineHours &&
              existing.varianceHours === day.varianceHours
            ) {
              continue;
            }
            await app.db
              .update(equipmentUtilisation)
              .set({
                telematicsWorkingHours: day.telematicsEngineHours,
                varianceHours: day.varianceHours,
                updatedAt: now,
              })
              .where(eq(equipmentUtilisation.id, rowId));
          }
        }
      }

      /* a persistent variance is a Signal */
      const persistent = summary.rows.filter((r) => r.persistent);
      if (persistent.length > 0) {
        const seen = await alreadySignalled(
          companyId,
          "equipment_telematics_variance",
        );
        for (const row of persistent) {
          await raiseSignalOnce({
            companyId,
            projectId,
            detector: "equipment_telematics_variance",
            key: row.equipmentId,
            severity: "high",
            title: `Plant hours unsupported by the machine — ${row.reference} ${row.name}`,
            explanation:
              `Across ${from} to ${to}, ${row.manualHours} working hour(s) were claimed for ` +
              `${row.reference} ${row.name} against ${row.telematicsHours} engine hour(s) reported ` +
              `by the machine itself — a variance of ${row.varianceHours} hour(s) over ` +
              `${row.daysCompared} comparable day(s), unsupported on ${row.daysUnsupported} of them ` +
              `(threshold ${TELEMATICS_PERSISTENT_DAYS} days).` +
              (row.valueAtRisk !== null
                ? ` At the recorded hourly rates that is ${row.currency} ${row.valueAtRisk} of plant ` +
                  `and operator time being charged against hours the machine does not corroborate.`
                : ` The money cannot be stated: ${row.reasons.join("; ")}.`) +
              ` The telematics feed and the plant sheet are independent accounts of the same day ` +
              `produced by parties who do not share a pathway, which is exactly why the difference ` +
              `is worth something. It is not proof of a false claim — a counter can be reset, a ` +
              `machine can be worked with the ignition off the clock — but it is the question to ask.`,
            refs: {
              equipmentId: row.equipmentId,
              equipmentReference: row.reference,
              periodStart: from,
              periodEnd: to,
              manualHours: row.manualHours,
              telematicsHours: row.telematicsHours,
              varianceHours: row.varianceHours,
              daysUnsupported: row.daysUnsupported,
              valueAtRisk: row.valueAtRisk,
              currency: row.currency,
            },
            seen,
          });
        }
      }

      return {
        ...summary,
        method:
          "engine hours are a CUMULATIVE counter, so a day's telematics hours are the last " +
          "reading of the day minus the first. A day with one reading, or a counter that fell " +
          "(a device reset), yields null rather than zero — 'the machine did not work' and 'the " +
          "feed cannot say' are opposite facts. Claimed hours must exceed engine hours by more " +
          "than 1 hour AND more than 1.15x before the day is called unsupported.",
        currencyNote:
          Object.keys(summary.valueAtRiskByCurrency).length > 1
            ? "value at risk is reported per currency and never added"
            : null,
      };
    },
  );

  /* ================================================================ */
  /* PROJECT PLANT VIEW                                                */
  /* ================================================================ */

  /** What plant is on this project, and is any of it out of certificate?
   *  This read is what makes the sweep run for a project team. */
  app.get(
    "/projects/:projectId/equipment",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          status: z.enum(EQUIPMENT_STATUSES).optional(),
          category: z.enum(EQUIPMENT_CATEGORIES).optional(),
        })
        .parse(req.query);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      await maybeSweep(companyId);
      const asOf = todayISO();
      const assigned = await app.db
        .select({
          equipmentId: equipmentAssignments.equipmentId,
          assignmentId: equipmentAssignments.id,
          status: equipmentAssignments.status,
          assignedFrom: equipmentAssignments.assignedFrom,
          assignedTo: equipmentAssignments.assignedTo,
        })
        .from(equipmentAssignments)
        .where(
          and(
            eq(equipmentAssignments.companyId, companyId),
            eq(equipmentAssignments.projectId, projectId),
            inArray(equipmentAssignments.status, [
              ...IN_SERVICE_ASSIGNMENT_STATUSES,
            ]),
          ),
        );
      const ids = [...new Set(assigned.map((a) => a.equipmentId))];
      if (ids.length === 0)
        return { ...paginate([], 0, q), asOf, outOfCertificateCount: 0 };
      const clauses = [
        eq(equipment.companyId, companyId),
        inArray(equipment.id, ids),
      ];
      if (q.status) clauses.push(eq(equipment.status, q.status));
      if (q.category) clauses.push(eq(equipment.category, q.category));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(equipment)
        .where(where);
      const rows = await app.db
        .select()
        .from(equipment)
        .where(where)
        .orderBy(asc(equipment.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const byEquipment = new Map(
        assigned.map((a) => [a.equipmentId, a] as const),
      );
      const items = rows.map((r) => ({
        ...decorateEquipment(r, asOf),
        assignment: byEquipment.get(r.id) ?? null,
      }));
      return {
        ...paginate(items, Number(totalRow?.n ?? 0), q),
        asOf,
        outOfCertificateCount: items.filter((i) => i.derived.outOfCertificate)
          .length,
        outOfCertificateNote: items.some((i) => i.derived.outOfCertificate)
          ? "plant on this project is out of certificate. See the critical signals raised by the " +
            "sweep — an expired statutory examination on assigned plant is unlawful operation."
          : null,
      };
    },
  );

  /* ================================================================ */
  /* MATERIALS — items and the lifecycle quantities                    */
  /* ================================================================ */

  const materialCreateSchema = z.object({
    name: nonEmpty(200),
    unit: nonEmpty(40),
    code: z.string().max(80).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    category: z.string().max(120).nullable().optional(),
    specSectionId: idRef.nullable().optional(),
    specSectionCode: z.string().max(80).nullable().optional(),
    submittalId: idRef.nullable().optional(),
    manufacturer: z.string().max(200).nullable().optional(),
    modelNumber: z.string().max(120).nullable().optional(),
    supplierVendorId: idRef.nullable().optional(),
    commitmentId: idRef.nullable().optional(),
    costCodeId: idRef.nullable().optional(),
    budgetLineItemId: idRef.nullable().optional(),
    unitCost: money.nullable().optional(),
    currency: z.string().length(3).default("USD"),
    leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
    quantityRequired: z.number().finite().min(0).default(0),
    quantityOrdered: z.number().finite().min(0).default(0),
    reorderLevel: z.number().finite().min(0).nullable().optional(),
    storageLocationId: idRef.nullable().optional(),
    isHazardous: z.boolean().default(false),
    coshhFileId: idRef.nullable().optional(),
    storageRequirements: z.string().max(2000).nullable().optional(),
    shelfLifeDays: z.number().int().min(0).max(36500).nullable().optional(),
    carbonFactorId: idRef.nullable().optional(),
    isTracked: z.boolean().default(true),
    status: z.enum(MATERIAL_ITEM_STATUSES).default("planned"),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  /** Embodied carbon for a quantity of this item — null with reasons when
   *  the factor is missing or published in an incompatible unit. */
  async function materialCarbon(
    companyId: string,
    item: typeof materialItems.$inferSelect,
    quantity: number,
  ): Promise<{
    tco2e: number | null;
    factorId: string | null;
    reasons: string[];
  }> {
    const reasons: string[] = [];
    if (!item.carbonFactorId) {
      reasons.push(
        "no carbon factor is bound to this material — the quantity is known, the kgCO2e per unit " +
          "is not, so embodied carbon is left null rather than estimated",
      );
      return { tco2e: null, factorId: null, reasons };
    }
    if (quantity <= 0) {
      reasons.push("no quantity has been delivered or installed yet");
      return { tco2e: null, factorId: item.carbonFactorId, reasons };
    }
    const rows = await app.db
      .select()
      .from(carbonFactors)
      .where(
        and(
          eq(carbonFactors.id, item.carbonFactorId),
          eq(carbonFactors.companyId, companyId),
        ),
      )
      .limit(1);
    const factor = rows[0];
    if (!factor) {
      reasons.push(
        `carbon factor ${item.carbonFactorId} is not in this company's factor library`,
      );
      return { tco2e: null, factorId: item.carbonFactorId, reasons };
    }
    if (!unitsMatch(factor.unit, item.unit)) {
      reasons.push(
        `the factor is published per ${normaliseUnit(factor.unit)} and the material is measured in ` +
          `${normaliseUnit(item.unit)} — converting between them needs a density or a conversion ` +
          "the platform does not hold, so no figure is produced",
      );
      return { tco2e: null, factorId: item.carbonFactorId, reasons };
    }
    return {
      tco2e: computeTco2e(quantity, factor.factorKgCo2ePerUnit),
      factorId: item.carbonFactorId,
      reasons,
    };
  }

  /** The item plus the lifecycle arithmetic nobody should have to redo. */
  function decorateMaterial(item: typeof materialItems.$inferSelect) {
    const outstandingToOrder = round2(
      item.quantityRequired - item.quantityOrdered,
    );
    const outstandingToDeliver = round2(
      item.quantityOrdered - item.quantityDelivered,
    );
    const available = round2(item.quantityOnHand - item.quantityReserved);
    return {
      ...item,
      isHazardous: item.isHazardous === 1,
      isTracked: item.isTracked === 1,
      derived: {
        outstandingToOrder,
        outstandingToDeliver,
        availableToIssue: available,
        belowReorderLevel:
          item.reorderLevel !== null &&
          item.quantityOnHand <= item.reorderLevel,
        wastagePercent:
          item.quantityDelivered > 0
            ? round2((item.quantityWasted / item.quantityDelivered) * 100)
            : null,
        wastagePercentReason:
          item.quantityDelivered > 0
            ? null
            : "nothing has been delivered, so a wastage percentage would divide by zero — it is " +
              "null rather than 0%",
        rejectionPercent:
          item.quantityDelivered > 0
            ? round2((item.quantityRejected / item.quantityDelivered) * 100)
            : null,
        specControlled:
          item.specSectionId !== null || item.submittalId !== null,
        specNote:
          item.specSectionId === null && item.submittalId === null
            ? "this material is bound to no spec section and no approved submittal — nothing on " +
              "the platform says the product that arrives is the product that was approved"
            : null,
      },
    };
  }

  app.post(
    "/projects/:projectId/materials",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = materialCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      if (body.supplierVendorId)
        await assertVendor(body.supplierVendorId, companyId);
      const number = await nextRecordNumber(app.db, companyId, "material_item");
      const reference = `MAT-${pad(number)}`;
      const id = newId("mat");
      await app.db.insert(materialItems).values({
        id,
        companyId,
        projectId: req.projectId!,
        number,
        reference,
        code: body.code ?? null,
        name: body.name,
        description: body.description ?? null,
        category: body.category ?? null,
        unit: body.unit,
        specSectionId: body.specSectionId ?? null,
        specSectionCode: body.specSectionCode ?? null,
        submittalId: body.submittalId ?? null,
        manufacturer: body.manufacturer ?? null,
        modelNumber: body.modelNumber ?? null,
        supplierVendorId: body.supplierVendorId ?? null,
        commitmentId: body.commitmentId ?? null,
        costCodeId: body.costCodeId ?? null,
        budgetLineItemId: body.budgetLineItemId ?? null,
        unitCost: body.unitCost ?? null,
        currency: body.currency,
        leadTimeDays: body.leadTimeDays ?? null,
        quantityRequired: body.quantityRequired,
        quantityOrdered: body.quantityOrdered,
        reorderLevel: body.reorderLevel ?? null,
        storageLocationId: body.storageLocationId ?? null,
        isHazardous: body.isHazardous ? 1 : 0,
        coshhFileId: body.coshhFileId ?? null,
        storageRequirements: body.storageRequirements ?? null,
        shelfLifeDays: body.shelfLifeDays ?? null,
        carbonFactorId: body.carbonFactorId ?? null,
        isTracked: body.isTracked ? 1 : 0,
        status: body.status,
        totalsCalculatedAt: new Date().toISOString(),
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "material_item",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          reference,
          name: body.name,
          unit: body.unit,
          quantityRequired: body.quantityRequired,
          unitCost: body.unitCost ?? null,
          currency: body.currency,
          specSectionId: body.specSectionId ?? null,
          submittalId: body.submittalId ?? null,
        },
        storePayload: true,
      });
      const created = await fetchMaterialItem(id, companyId, req.projectId!);
      return reply.status(201).send({
        ...decorateMaterial(created),
        hazardNote:
          body.isHazardous && !body.coshhFileId
            ? "this material is flagged hazardous with no COSHH assessment attached. It cannot " +
              "lawfully be issued to anyone until one exists."
            : null,
      });
    },
  );

  app.get(
    "/projects/:projectId/materials",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          status: z.enum(MATERIAL_ITEM_STATUSES).optional(),
          category: z.string().max(120).optional(),
          supplierVendorId: idRef.optional(),
          belowReorder: z.coerce.boolean().optional(),
          includeCatalogue: z.coerce.boolean().optional(),
          q: z.string().max(200).optional(),
        })
        .parse(req.query);
      const clauses = [eq(materialItems.companyId, req.companyId!)];
      clauses.push(
        q.includeCatalogue
          ? or(
              eq(materialItems.projectId, req.projectId!),
              isNull(materialItems.projectId),
            )!
          : eq(materialItems.projectId, req.projectId!),
      );
      if (q.status) clauses.push(eq(materialItems.status, q.status));
      if (q.category) clauses.push(eq(materialItems.category, q.category));
      if (q.supplierVendorId)
        clauses.push(eq(materialItems.supplierVendorId, q.supplierVendorId));
      if (q.q) {
        clauses.push(
          or(
            sql`lower(${materialItems.name}) like ${`%${q.q.toLowerCase()}%`}`,
            sql`lower(${materialItems.reference}) like ${`%${q.q.toLowerCase()}%`}`,
          )!,
        );
      }
      const where = and(...clauses);
      const rows = await app.db
        .select()
        .from(materialItems)
        .where(where)
        .orderBy(asc(materialItems.number));
      let items = rows.map(decorateMaterial);
      if (q.belowReorder)
        items = items.filter((i) => i.derived.belowReorderLevel);
      const total = items.length;
      return paginate(
        items.slice(pageOffset(q), pageOffset(q) + q.pageSize),
        total,
        q,
      );
    },
  );

  app.get(
    "/companies/current/materials",
    { preHandler: companyRead },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          catalogueOnly: z.coerce.boolean().optional(),
          status: z.enum(MATERIAL_ITEM_STATUSES).optional(),
        })
        .parse(req.query);
      const clauses = [eq(materialItems.companyId, req.companyId!)];
      if (q.catalogueOnly) clauses.push(isNull(materialItems.projectId));
      if (q.status) clauses.push(eq(materialItems.status, q.status));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(materialItems)
        .where(where);
      const rows = await app.db
        .select()
        .from(materialItems)
        .where(where)
        .orderBy(asc(materialItems.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows.map(decorateMaterial), Number(totalRow?.n ?? 0), q);
    },
  );

  app.get(
    "/projects/:projectId/materials/:itemId",
    { preHandler: readGate },
    async (req) => {
      const { itemId } = req.params as { itemId: string };
      const companyId = req.companyId!;
      const item = await fetchMaterialItem(itemId, companyId, req.projectId!);
      const movements = await app.db
        .select()
        .from(materialStockMovements)
        .where(eq(materialStockMovements.materialItemId, itemId))
        .orderBy(desc(materialStockMovements.movedAt))
        .limit(50);
      return {
        ...decorateMaterial(item),
        embodiedCarbon: {
          delivered: await materialCarbon(
            companyId,
            item,
            item.quantityDelivered,
          ),
          installed: await materialCarbon(
            companyId,
            item,
            item.quantityInstalled,
          ),
          wasted: await materialCarbon(companyId, item, item.quantityWasted),
        },
        recentMovements: movements,
      };
    },
  );

  app.patch(
    "/projects/:projectId/materials/:itemId",
    { preHandler: standardGate },
    async (req) => {
      const { itemId } = req.params as { itemId: string };
      const body = materialCreateSchema
        .partial()
        .omit({ quantityRequired: true, quantityOrdered: true })
        .extend({
          quantityRequired: z.number().finite().min(0).optional(),
          quantityOrdered: z.number().finite().min(0).optional(),
          quantityInstalled: z.number().finite().min(0).optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const item = await fetchMaterialItem(itemId, companyId, req.projectId!);
      if (item.projectId !== req.projectId!) {
        throw forbidden(
          "this is a company catalogue item and is not editable from a project — a project cannot " +
            "quietly change a definition every other project reads",
        );
      }
      const patch: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        patch[key] =
          key === "isHazardous" || key === "isTracked"
            ? value
              ? 1
              : 0
            : value;
      }
      if (body.quantityInstalled !== undefined) {
        if (body.quantityInstalled > item.quantityAccepted) {
          throw badRequest(
            `${body.quantityInstalled} ${item.unit} cannot have been installed when only ` +
              `${item.quantityAccepted} ${item.unit} have been accepted onto site`,
          );
        }
        patch["totalsCalculatedAt"] = new Date().toISOString();
      }
      await app.db
        .update(materialItems)
        .set(patch)
        .where(eq(materialItems.id, itemId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "material_item",
        objectId: itemId,
        projectId: req.projectId!,
        payload: { changed: Object.keys(body) },
      });
      return decorateMaterial(
        await fetchMaterialItem(itemId, companyId, req.projectId!),
      );
    },
  );

  /* ================================================================ */
  /* STOCK — the compound is a bank account                            */
  /* ================================================================ */

  interface MovementRequest {
    companyId: string;
    projectId: string;
    item: typeof materialItems.$inferSelect;
    movementType: StockMovementType;
    quantity: number;
    actorId: string;
    movedAt?: string;
    allowNegative?: boolean;
    reason?: string | null;
    unitCost?: number | null;
    currency?: string | null;
    deliveryId?: string | null;
    deliveryLineId?: string | null;
    batchNumber?: string | null;
    fromLocationId?: string | null;
    toLocationId?: string | null;
    fromProjectId?: string | null;
    toProjectId?: string | null;
    issuedToWorkerId?: string | null;
    issuedToVendorId?: string | null;
    crewId?: string | null;
    costCodeId?: string | null;
    budgetLineItemId?: string | null;
    scheduleActivityId?: string | null;
    source?: string;
    sourceRef?: string | null;
    photoFileIds?: string[];
    detail?: Record<string, unknown>;
    /** run inside an existing transaction (delivery receipt books many lines) */
    tx?: Db;
  }

  /**
   * Write one movement and move the balance with it.
   *
   * Refuses anything that would drive stock negative unless `allowNegative`
   * is set, and NAMES THE SHORTFALL when it refuses — the shortfall is the
   * useful fact, because it says how much material is unaccounted for and
   * therefore what to go and look for. A forced negative raises a Signal:
   * somebody knowingly accepted a balance the compound cannot support, and
   * that is an auditable act rather than a default.
   */
  async function insertStockMovement(input: MovementRequest): Promise<{
    movement: typeof materialStockMovements.$inferSelect;
    shortfall: ReturnType<typeof checkShortfall>;
    signalId: string | null;
  }> {
    const { item } = input;
    /*
     * A COMPANY CATALOGUE ITEM HAS NO STOCK. `projectId` null means "the
     * product, as specified", shared by every project; moving stock against it
     * would put project A's compound balance on project B's screen and let B
     * issue against it. The project clones what it needs.
     */
    if (item.projectId === null) {
      throw badRequest(
        `${item.reference} ${item.name} is a COMPANY CATALOGUE item, not a project material. Its ` +
          "balance is shared by every project, so a movement against it would move stock the site " +
          "in front of you does not hold. Create the item on this project (POST " +
          "/projects/:projectId/materials) and book the movement against that.",
        { code: "catalogue_item_has_no_stock", materialItemId: item.id },
      );
    }
    if (input.movementType !== "adjustment" && input.quantity <= 0) {
      throw badRequest(
        `a ${input.movementType} of ${input.quantity} makes no sense — send a positive quantity ` +
          "and the movement kind supplies the direction. Only an adjustment may be signed.",
      );
    }
    if (input.movementType === "adjustment" && input.quantity === 0) {
      throw badRequest(
        "an adjustment of zero changes nothing — record no movement at all",
      );
    }
    /*
     * SERIALISED. Two concurrent issues of 20 from a balance of 30 both used
     * to pass the in-memory shortfall check, both wrote balanceAfter 10, and
     * the item ended at −10 with no refusal and no signal — the compound
     * balance this module sells as a bank statement, silently wrong. The row
     * is locked for the read-check-write, and the balance is computed from
     * the LOCKED row rather than the one the caller fetched.
     */
    return withTx(input.tx, async (tx) => {
      const [locked] = await tx
        .select()
        .from(materialItems)
        .where(eq(materialItems.id, item.id))
        .for("update")
        .limit(1);
      if (!locked) throw notFound("Material item not found");
      return bookMovement(tx, input, locked);
    });
  }

  /** The body of a stock movement, running against a locked item row. */
  async function bookMovement(
    tx: Db,
    input: MovementRequest,
    item: typeof materialItems.$inferSelect,
  ): Promise<{
    movement: typeof materialStockMovements.$inferSelect;
    shortfall: ReturnType<typeof checkShortfall>;
    signalId: string | null;
  }> {
    const shortfall = checkShortfall(
      item.quantityOnHand,
      input.movementType,
      input.quantity,
      item.unit,
    );
    if (shortfall.wouldGoNegative && !input.allowNegative) {
      throw badRequest(
        shortfall.message ?? "movement would drive stock negative",
        {
          code: "stock_would_go_negative",
          materialItemId: item.id,
          materialReference: item.reference,
          unit: item.unit,
          currentBalance: shortfall.currentBalance,
          projectedBalance: shortfall.projectedBalance,
          shortfall: shortfall.shortfall,
          movementType: input.movementType,
          quantity: input.quantity,
          remedy:
            "book in the missing receipt if it arrived, or record the loss as wastage/damage/theft " +
            "so it is measurable. Pass allowNegative to force it and the override is signalled.",
        },
      );
    }
    const stored = signedQuantity(input.movementType, input.quantity);
    const onHandAfter = round2(
      item.quantityOnHand + onHandDelta(input.movementType, input.quantity),
    );
    const reservedAfter = round2(
      Math.max(
        0,
        item.quantityReserved +
          reservedDelta(input.movementType, input.quantity),
      ),
    );
    const movedAt = input.movedAt
      ? new Date(input.movedAt).toISOString()
      : new Date().toISOString();
    const id = newId("msm");
    const unitCost = input.unitCost ?? item.unitCost ?? null;
    await tx.insert(materialStockMovements).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      materialItemId: item.id,
      movementType: input.movementType,
      quantity: stored,
      unit: item.unit,
      movedAt,
      fromLocationId: input.fromLocationId ?? null,
      toLocationId: input.toLocationId ?? null,
      fromProjectId: input.fromProjectId ?? null,
      toProjectId: input.toProjectId ?? null,
      issuedToWorkerId: input.issuedToWorkerId ?? null,
      issuedToVendorId: input.issuedToVendorId ?? null,
      crewId: input.crewId ?? null,
      costCodeId: input.costCodeId ?? item.costCodeId,
      budgetLineItemId: input.budgetLineItemId ?? item.budgetLineItemId,
      scheduleActivityId: input.scheduleActivityId ?? null,
      deliveryId: input.deliveryId ?? null,
      deliveryLineId: input.deliveryLineId ?? null,
      batchNumber: input.batchNumber ?? null,
      reason: input.reason ?? null,
      unitCost,
      valueAmount:
        unitCost !== null ? round2(Math.abs(stored) * unitCost) : null,
      currency: input.currency ?? item.currency,
      balanceAfter: onHandAfter,
      source: input.source ?? "manual",
      sourceRef: input.sourceRef ?? null,
      photoFileIds: input.photoFileIds ?? [],
      detail: input.detail ?? {},
      createdBy: input.actorId,
    });

    const wastedAfter = LOSS_MOVEMENT_TYPES.includes(input.movementType)
      ? round2(item.quantityWasted + Math.abs(stored))
      : item.quantityWasted;
    await tx
      .update(materialItems)
      .set({
        quantityOnHand: onHandAfter,
        quantityReserved: reservedAfter,
        quantityWasted: wastedAfter,
        totalsCalculatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(materialItems.id, item.id));

    let signalId: string | null = null;
    if (shortfall.wouldGoNegative) {
      const seen = await alreadySignalled(
        input.companyId,
        "material_stock_negative",
      );
      signalId = await raiseSignalOnce({
        companyId: input.companyId,
        projectId: input.projectId,
        detector: "material_stock_negative",
        key: id,
        severity: "high",
        title: `Stock forced negative — ${item.reference} ${item.name}`,
        explanation:
          `A ${input.movementType} of ${input.quantity} ${item.unit} was recorded against ` +
          `${item.reference} ${item.name} when the compound held ${shortfall.currentBalance} ` +
          `${item.unit}, taking the balance to ${shortfall.projectedBalance} ${item.unit}. Negative ` +
          `stock is not a small bookkeeping error: ${shortfall.shortfall} ${item.unit} either ` +
          `arrived and was never booked in, or left and was never booked out. The second of those ` +
          `is theft until somebody shows it is not. The movement was allowed because the override ` +
          `was passed explicitly — this Signal is the record of that decision.`,
        refs: {
          movementId: id,
          materialItemId: item.id,
          materialReference: item.reference,
          movementType: input.movementType,
          quantity: input.quantity,
          unit: item.unit,
          balanceBefore: shortfall.currentBalance,
          balanceAfter: shortfall.projectedBalance,
          shortfall: shortfall.shortfall,
        },
        seen,
      });
      if (signalId) {
        await tx
          .update(materialStockMovements)
          .set({ signalId })
          .where(eq(materialStockMovements.id, id));
      }
    }

    await appendLedger(tx, {
      companyId: input.companyId,
      actorId: input.actorId,
      action: "create",
      objectType: "material_stock_movement",
      objectId: id,
      projectId: input.projectId,
      payload: {
        materialItemId: item.id,
        materialReference: item.reference,
        movementType: input.movementType,
        quantity: stored,
        unit: item.unit,
        balanceBefore: shortfall.currentBalance,
        balanceAfter: onHandAfter,
        forcedNegative: shortfall.wouldGoNegative,
        deliveryId: input.deliveryId ?? null,
        reason: input.reason ?? null,
      },
      storePayload: true,
    });

    const rows = await tx
      .select()
      .from(materialStockMovements)
      .where(eq(materialStockMovements.id, id))
      .limit(1);
    return { movement: rows[0]!, shortfall, signalId };
  }

  /* ================================================================ */
  /* DELIVERIES — what arrived, what was rejected, what it will cost   */
  /* ================================================================ */

  const deliveryLineSchema = z.object({
    materialItemId: idRef.nullable().optional(),
    description: nonEmpty(500),
    unit: z.string().max(40).nullable().optional(),
    quantityExpected: z.number().finite().min(0).nullable().optional(),
    unitCost: money.nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    batchNumber: z.string().max(120).nullable().optional(),
    heatNumber: z.string().max(120).nullable().optional(),
    serialNumbers: z.array(z.string().max(120)).max(500).optional(),
    certificateFileIds: z.array(idRef).max(50).optional(),
    manufactureDate: isoDateSchema.nullable().optional(),
    expiryDate: isoDateSchema.nullable().optional(),
    storageLocationId: idRef.nullable().optional(),
    photoFileIds: z.array(idRef).max(50).optional(),
  });

  const deliveryCreateSchema = z.object({
    deliveryNoteNumber: z.string().max(120).nullable().optional(),
    supplierVendorId: idRef.nullable().optional(),
    commitmentId: idRef.nullable().optional(),
    purchaseOrderRef: z.string().max(120).nullable().optional(),
    carrierName: z.string().max(200).nullable().optional(),
    vehicleRegistration: z.string().max(60).nullable().optional(),
    driverName: z.string().max(200).nullable().optional(),
    scheduledFor: isoTimestamp.nullable().optional(),
    arrivedAt: isoTimestamp.nullable().optional(),
    locationId: idRef.nullable().optional(),
    offloadLocationText: z.string().max(300).nullable().optional(),
    craneRequired: z.boolean().default(false),
    waitingMinutes: z.number().int().min(0).max(10_000).nullable().optional(),
    gateEntryRef: z.string().max(120).nullable().optional(),
    deliveryNoteFileId: idRef.nullable().optional(),
    weighbridgeTicketRef: z.string().max(120).nullable().optional(),
    photoFileIds: z.array(idRef).max(50).optional(),
    currency: z.string().length(3).default("USD"),
    lines: z.array(deliveryLineSchema).max(500).optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  function decorateDelivery(
    delivery: typeof materialDeliveries.$inferSelect,
    lines: (typeof materialDeliveryLines.$inferSelect)[],
  ) {
    const discrepantLines = lines.filter((l) => l.discrepancyKind !== "none");
    return {
      ...delivery,
      craneRequired: delivery.craneRequired === 1,
      hasDiscrepancy: delivery.hasDiscrepancy === 1,
      invoiceMatched: delivery.invoiceMatched === 1,
      lines,
      derived: {
        discrepantLineCount: discrepantLines.length,
        discrepancyKinds: [
          ...new Set(discrepantLines.map((l) => l.discrepancyKind)),
        ],
        ncrLinked: delivery.ncrId !== null,
        ncrCandidate:
          delivery.hasDiscrepancy === 1 && delivery.ncrId === null
            ? "this delivery has a recorded discrepancy and no NCR is linked. If the material was " +
              "rejected on quality grounds, raise the NCR in the quality module and link it here — " +
              "the delivery record is evidence for the NCR, not a substitute for it."
            : null,
        invoiceMatchNote:
          delivery.invoiceMatched === 1
            ? null
            : "this delivery has not been matched to an invoice line. An unmatched delivery is " +
              "either unbilled (money the supplier will come back for, usually at the worst moment) " +
              "or double-billed (money already paid twice). Both are found by matching.",
        certificateCoverage: {
          linesWithCertificates: lines.filter(
            (l) => (l.certificateFileIds as string[]).length > 0,
          ).length,
          linesWithBatchOrHeat: lines.filter(
            (l) => l.batchNumber !== null || l.heatNumber !== null,
          ).length,
          totalLines: lines.length,
          note:
            lines.length > 0 &&
            lines.every((l) => (l.certificateFileIds as string[]).length === 0)
              ? "no line on this delivery carries a certificate. Mill certs and declarations of " +
                "conformity are what a structural sign-off depends on, and they are impossible to " +
                "obtain retrospectively once the batch is in the works."
              : null,
        },
      },
    };
  }

  async function deliveryLines(deliveryId: string) {
    return app.db
      .select()
      .from(materialDeliveryLines)
      .where(eq(materialDeliveryLines.deliveryId, deliveryId))
      .orderBy(asc(materialDeliveryLines.position));
  }

  app.post(
    "/projects/:projectId/material-deliveries",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = deliveryCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      if (body.supplierVendorId)
        await assertVendor(body.supplierVendorId, companyId);
      const number = await nextRecordNumber(
        app.db,
        projectId,
        "material_delivery",
      );
      const reference = `DEL-${pad(number)}`;
      const id = newId("mdl");
      const lines = body.lines ?? [];
      for (const line of lines) {
        if (line.materialItemId)
          await fetchMaterialItem(line.materialItemId, companyId, projectId);
      }
      await app.db.insert(materialDeliveries).values({
        id,
        companyId,
        projectId,
        number,
        reference,
        deliveryNoteNumber: body.deliveryNoteNumber ?? null,
        supplierVendorId: body.supplierVendorId ?? null,
        commitmentId: body.commitmentId ?? null,
        purchaseOrderRef: body.purchaseOrderRef ?? null,
        carrierName: body.carrierName ?? null,
        vehicleRegistration: body.vehicleRegistration ?? null,
        driverName: body.driverName ?? null,
        status: body.arrivedAt ? "arrived" : "scheduled",
        scheduledFor: body.scheduledFor ?? null,
        arrivedAt: body.arrivedAt ?? null,
        waitingMinutes: body.waitingMinutes ?? null,
        gateEntryRef: body.gateEntryRef ?? null,
        locationId: body.locationId ?? null,
        offloadLocationText: body.offloadLocationText ?? null,
        craneRequired: body.craneRequired ? 1 : 0,
        lineCount: lines.length,
        deliveryNoteFileId: body.deliveryNoteFileId ?? null,
        weighbridgeTicketRef: body.weighbridgeTicketRef ?? null,
        photoFileIds: body.photoFileIds ?? [],
        currency: body.currency,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      if (lines.length > 0) {
        await app.db.insert(materialDeliveryLines).values(
          lines.map((line, i) => ({
            id: newId("mdll"),
            companyId,
            projectId,
            deliveryId: id,
            materialItemId: line.materialItemId ?? null,
            position: i,
            description: line.description,
            unit: line.unit ?? null,
            quantityExpected: line.quantityExpected ?? null,
            unitCost: line.unitCost ?? null,
            lineTotal:
              line.unitCost != null && line.quantityExpected != null
                ? round2(line.unitCost * line.quantityExpected)
                : null,
            currency: line.currency ?? body.currency,
            batchNumber: line.batchNumber ?? null,
            heatNumber: line.heatNumber ?? null,
            serialNumbers: line.serialNumbers ?? [],
            certificateFileIds: line.certificateFileIds ?? [],
            manufactureDate: line.manufactureDate ?? null,
            expiryDate: line.expiryDate ?? null,
            storageLocationId: line.storageLocationId ?? null,
            photoFileIds: line.photoFileIds ?? [],
          })),
        );
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "material_delivery",
        objectId: id,
        projectId,
        payload: {
          reference,
          deliveryNoteNumber: body.deliveryNoteNumber ?? null,
          supplierVendorId: body.supplierVendorId ?? null,
          commitmentId: body.commitmentId ?? null,
          lineCount: lines.length,
          currency: body.currency,
        },
        storePayload: true,
      });
      const created = await fetchDelivery(id, companyId, projectId);
      return reply
        .status(201)
        .send(decorateDelivery(created, await deliveryLines(id)));
    },
  );

  app.post(
    "/projects/:projectId/material-deliveries/:deliveryId/lines",
    { preHandler: standardGate },
    async (req, reply) => {
      const { deliveryId } = req.params as { deliveryId: string };
      const body = z
        .object({ lines: z.array(deliveryLineSchema).min(1).max(500) })
        .parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const delivery = await fetchDelivery(deliveryId, companyId, projectId);
      if (
        ["received", "rejected", "returned", "cancelled"].includes(
          delivery.status,
        )
      ) {
        throw badRequest(
          `this delivery is ${delivery.status} — lines cannot be added to a closed receipt. ` +
            "What arrived is what arrived.",
        );
      }
      const existing = await deliveryLines(deliveryId);
      for (const line of body.lines) {
        if (line.materialItemId)
          await fetchMaterialItem(line.materialItemId, companyId, projectId);
      }
      await app.db.insert(materialDeliveryLines).values(
        body.lines.map((line, i) => ({
          id: newId("mdll"),
          companyId,
          projectId,
          deliveryId,
          materialItemId: line.materialItemId ?? null,
          position: existing.length + i,
          description: line.description,
          unit: line.unit ?? null,
          quantityExpected: line.quantityExpected ?? null,
          unitCost: line.unitCost ?? null,
          lineTotal:
            line.unitCost != null && line.quantityExpected != null
              ? round2(line.unitCost * line.quantityExpected)
              : null,
          currency: line.currency ?? delivery.currency,
          batchNumber: line.batchNumber ?? null,
          heatNumber: line.heatNumber ?? null,
          serialNumbers: line.serialNumbers ?? [],
          certificateFileIds: line.certificateFileIds ?? [],
          manufactureDate: line.manufactureDate ?? null,
          expiryDate: line.expiryDate ?? null,
          storageLocationId: line.storageLocationId ?? null,
          photoFileIds: line.photoFileIds ?? [],
        })),
      );
      const all = await deliveryLines(deliveryId);
      await app.db
        .update(materialDeliveries)
        .set({ lineCount: all.length, updatedAt: new Date().toISOString() })
        .where(eq(materialDeliveries.id, deliveryId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "material_delivery",
        objectId: deliveryId,
        projectId,
        payload: { linesAdded: body.lines.length, lineCount: all.length },
      });
      return reply
        .status(201)
        .send(
          decorateDelivery(
            await fetchDelivery(deliveryId, companyId, projectId),
            all,
          ),
        );
    },
  );

  const receiveSchema = z.object({
    receivedAt: isoTimestamp.optional(),
    receivedByName: z.string().max(200).nullable().optional(),
    waitingMinutes: z.number().int().min(0).max(10_000).nullable().optional(),
    photoFileIds: z.array(idRef).max(50).optional(),
    discrepancyNotes: z.string().max(4000).nullable().optional(),
    inspectionChecklistId: idRef.nullable().optional(),
    createStockMovements: z.boolean().default(true),
    lines: z
      .array(
        z.object({
          lineId: idRef,
          quantityReceived: z.number().finite().min(0),
          quantityAccepted: z.number().finite().min(0),
          quantityRejected: z.number().finite().min(0).default(0),
          discrepancyKind: z.enum(DELIVERY_DISCREPANCY_KINDS).optional(),
          discrepancyNote: z.string().max(2000).nullable().optional(),
          rejectionReason: z.string().max(2000).nullable().optional(),
          batchNumber: z.string().max(120).nullable().optional(),
          heatNumber: z.string().max(120).nullable().optional(),
          certificateFileIds: z.array(idRef).max(50).optional(),
          photoFileIds: z.array(idRef).max(50).optional(),
        }),
      )
      .min(1),
  });

  /**
   * Receipt. Per LINE, because a delivery is short on one item and damaged
   * on another and the supplier's invoice will claim all of it — the gap
   * between expected, received and accepted IS the credit note.
   *
   * Accepted material becomes stock through a real movement rather than by
   * incrementing a number, so the compound balance stays reconcilable to a
   * statement (see `GET .../materials/:itemId/stock`).
   */
  app.post(
    "/projects/:projectId/material-deliveries/:deliveryId/receive",
    { preHandler: standardGate },
    async (req) => {
      const { deliveryId } = req.params as { deliveryId: string };
      const body = receiveSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const delivery = await fetchDelivery(deliveryId, companyId, projectId);
      // Receipt is a once-only act. A genuinely partial delivery that is
      // completed by a second drop is a SECOND delivery record against the
      // same order — receiving this one again would book the same material
      // into stock twice and give the supplier two claims for one load.
      if (
        delivery.receivedAt ||
        ["rejected", "returned", "cancelled"].includes(delivery.status)
      ) {
        throw conflict(
          `this delivery is already ${delivery.status}` +
            (delivery.receivedAt ? ` (received ${delivery.receivedAt})` : "") +
            " — receiving it twice would book the same material into stock twice. Raise a new " +
            "delivery for a second drop against the same order.",
        );
      }
      const lines = await deliveryLines(deliveryId);
      const byId = new Map(lines.map((l) => [l.id, l] as const));
      for (const entry of body.lines) {
        if (!byId.has(entry.lineId)) {
          throw badRequest(
            `line ${entry.lineId} does not belong to delivery ${delivery.reference}`,
          );
        }
      }
      const receivedAt = body.receivedAt
        ? new Date(body.receivedAt).toISOString()
        : new Date().toISOString();
      const now = new Date().toISOString();
      const discrepancyKinds = new Set<string>();
      const movements: {
        lineId: string;
        movementId: string;
        balanceAfter: number | null;
      }[] = [];
      const lineResults: {
        lineId: string;
        discrepancyKind: string;
        variance: number | null;
        message: string | null;
      }[] = [];

      /*
       * VALIDATE EVERY LINE BEFORE WRITING ANY OF THEM.
       *
       * The receive loop used to update the line, increment the item's
       * quantities and book a stock movement, and only then look at the next
       * line — so a bad line 2 (rejected with no reason, or an arithmetic
       * mismatch) threw a 400 AFTER line 1 had been booked into stock. The
       * delivery stayed unreceived, the user fixed line 2 and retried, and
       * line 1 went into stock a second time. Two passes: check the whole
       * body, then write it all inside ONE transaction.
       */
      const validated: Array<{
        input: (typeof body.lines)[number];
        line: (typeof lines)[number];
        kind: string;
        verdict: ReturnType<typeof classifyDeliveryLine>;
      }> = [];
      for (const input of body.lines) {
        const line = byId.get(input.lineId)!;
        if (
          Math.abs(
            input.quantityAccepted +
              input.quantityRejected -
              input.quantityReceived,
          ) > 1e-6
        ) {
          throw badRequest(
            `line "${line.description}": ${input.quantityAccepted} accepted + ` +
              `${input.quantityRejected} rejected does not equal ${input.quantityReceived} ` +
              "received. Every unit that came off the lorry was either taken or refused; a line " +
              "that does not add up is a line nobody has finished inspecting.",
          );
        }
        const verdict = classifyDeliveryLine({
          quantityExpected: line.quantityExpected,
          quantityReceived: input.quantityReceived,
          quantityAccepted: input.quantityAccepted,
          quantityRejected: input.quantityRejected,
        });
        const kind = input.discrepancyKind ?? verdict.kind;
        if (input.quantityRejected > 0 && !input.rejectionReason) {
          throw badRequest(
            `line "${line.description}": ${input.quantityRejected} were rejected with no ` +
              "rejectionReason. A rejection with no reason cannot be turned into a credit note " +
              "or an NCR, which are the only two things a rejection is for.",
          );
        }
        if (line.materialItemId) {
          const item = await fetchMaterialItem(
            line.materialItemId,
            companyId,
            projectId,
          );
          if (item.projectId === null) {
            throw badRequest(
              `line "${line.description}" names ${item.reference} ${item.name}, which is a COMPANY ` +
                "CATALOGUE item. Receiving against it would move a balance every project shares. " +
                "Create the material on this project and point the line at it.",
              { code: "catalogue_item_has_no_stock", materialItemId: item.id },
            );
          }
        }
        validated.push({ input, line, kind, verdict });
      }

      await app.db.transaction(async (tx) => {
        for (const { input, line, kind, verdict } of validated) {
          if (kind !== "none") discrepancyKinds.add(kind);
          await tx
            .update(materialDeliveryLines)
            .set({
              quantityReceived: input.quantityReceived,
              quantityAccepted: input.quantityAccepted,
              quantityRejected: input.quantityRejected,
              discrepancyKind: kind,
              discrepancyNote: input.discrepancyNote ?? verdict.message,
              rejectionReason: input.rejectionReason ?? null,
              batchNumber: input.batchNumber ?? line.batchNumber,
              heatNumber: input.heatNumber ?? line.heatNumber,
              certificateFileIds:
                input.certificateFileIds ??
                (line.certificateFileIds as string[]),
              photoFileIds:
                input.photoFileIds ?? (line.photoFileIds as string[]),
              lineTotal:
                line.unitCost != null
                  ? round2(line.unitCost * input.quantityAccepted)
                  : line.lineTotal,
              updatedAt: now,
            })
            .where(eq(materialDeliveryLines.id, line.id));
          lineResults.push({
            lineId: line.id,
            discrepancyKind: kind,
            variance: verdict.variance,
            message: input.discrepancyNote ?? verdict.message,
          });

          if (!line.materialItemId) continue;
          const item = await fetchMaterialItem(
            line.materialItemId,
            companyId,
            projectId,
          );
          await tx
            .update(materialItems)
            .set({
              quantityDelivered: round2(
                item.quantityDelivered + input.quantityReceived,
              ),
              quantityAccepted: round2(
                item.quantityAccepted + input.quantityAccepted,
              ),
              quantityRejected: round2(
                item.quantityRejected + input.quantityRejected,
              ),
              status:
                item.quantityRequired > 0 &&
                round2(item.quantityDelivered + input.quantityReceived) >=
                  item.quantityRequired
                  ? "delivered"
                  : "partially_delivered",
              totalsCalculatedAt: now,
              updatedAt: now,
            })
            .where(eq(materialItems.id, item.id));
          if (
            body.createStockMovements &&
            item.isTracked === 1 &&
            input.quantityAccepted > 0
          ) {
            const refreshed = await fetchMaterialItem(
              line.materialItemId,
              companyId,
              projectId,
            );
            const result = await insertStockMovement({
              tx,
              companyId,
              projectId,
              item: refreshed,
              movementType: "receipt",
              quantity: input.quantityAccepted,
              actorId: req.user!.id,
              movedAt: receivedAt,
              deliveryId,
              deliveryLineId: line.id,
              batchNumber: input.batchNumber ?? line.batchNumber,
              unitCost: line.unitCost,
              currency: line.currency,
              toLocationId: line.storageLocationId,
              source: "manual",
              sourceRef: delivery.deliveryNoteNumber,
              reason: `Receipt against ${delivery.reference}`,
            });
            movements.push({
              lineId: line.id,
              movementId: result.movement.id,
              balanceAfter: result.movement.balanceAfter,
            });
          }
        }
      });

      const updatedLines = await deliveryLines(deliveryId);
      const allRejected =
        updatedLines.length > 0 &&
        updatedLines.every(
          (l) => l.quantityAccepted === 0 && l.quantityReceived > 0,
        );
      const anyOutstanding = updatedLines.some(
        (l) =>
          l.quantityExpected !== null &&
          l.quantityReceived < l.quantityExpected,
      );
      const status = allRejected
        ? "rejected"
        : anyOutstanding
          ? "partially_received"
          : "received";
      const totalValue = updatedLines.every((l) => l.lineTotal === null)
        ? null
        : round2(updatedLines.reduce((s, l) => s + (l.lineTotal ?? 0), 0));
      const currencies = new Set(
        updatedLines.map((l) => l.currency ?? delivery.currency),
      );
      await app.db
        .update(materialDeliveries)
        .set({
          status,
          receivedAt,
          receivedBy: req.user!.id,
          receivedByName: body.receivedByName ?? null,
          waitingMinutes: body.waitingMinutes ?? delivery.waitingMinutes,
          hasDiscrepancy: discrepancyKinds.size > 0 ? 1 : 0,
          discrepancyKinds: [...discrepancyKinds],
          discrepancyNotes: body.discrepancyNotes ?? delivery.discrepancyNotes,
          inspectionChecklistId:
            body.inspectionChecklistId ?? delivery.inspectionChecklistId,
          photoFileIds:
            body.photoFileIds ?? (delivery.photoFileIds as string[]),
          totalValue: currencies.size === 1 ? totalValue : null,
          lineCount: updatedLines.length,
          updatedAt: now,
        })
        .where(eq(materialDeliveries.id, deliveryId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "material_delivery",
        objectId: deliveryId,
        projectId,
        payload: {
          to: status,
          receivedAt,
          lines: lineResults,
          discrepancyKinds: [...discrepancyKinds],
          stockMovements: movements.length,
          totalValue: currencies.size === 1 ? totalValue : null,
        },
        storePayload: true,
      });

      const after = await fetchDelivery(deliveryId, companyId, projectId);
      return {
        ...decorateDelivery(after, updatedLines),
        lineResults,
        stockMovements: movements,
        mixedCurrencyNote:
          currencies.size > 1
            ? "the lines on this delivery are priced in more than one currency, so no delivery " +
              "total has been stored. Adding them would need an FX rate and a date; the line " +
              "values stand on their own."
            : null,
      };
    },
  );

  app.get(
    "/projects/:projectId/material-deliveries",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          status: z.enum(DELIVERY_STATUSES).optional(),
          supplierVendorId: idRef.optional(),
          commitmentId: idRef.optional(),
          hasDiscrepancy: z.coerce.boolean().optional(),
          invoiceMatched: z.coerce.boolean().optional(),
          from: isoDateSchema.optional(),
          to: isoDateSchema.optional(),
        })
        .parse(req.query);
      const clauses = [
        eq(materialDeliveries.companyId, req.companyId!),
        eq(materialDeliveries.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(materialDeliveries.status, q.status));
      if (q.supplierVendorId)
        clauses.push(
          eq(materialDeliveries.supplierVendorId, q.supplierVendorId),
        );
      if (q.commitmentId)
        clauses.push(eq(materialDeliveries.commitmentId, q.commitmentId));
      if (q.hasDiscrepancy !== undefined) {
        clauses.push(
          eq(materialDeliveries.hasDiscrepancy, q.hasDiscrepancy ? 1 : 0),
        );
      }
      if (q.invoiceMatched !== undefined) {
        clauses.push(
          eq(materialDeliveries.invoiceMatched, q.invoiceMatched ? 1 : 0),
        );
      }
      if (q.from)
        clauses.push(
          gte(materialDeliveries.receivedAt, `${q.from}T00:00:00.000Z`),
        );
      if (q.to)
        clauses.push(
          lte(materialDeliveries.receivedAt, `${q.to}T23:59:59.999Z`),
        );
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(materialDeliveries)
        .where(where);
      const rows = await app.db
        .select()
        .from(materialDeliveries)
        .where(where)
        .orderBy(desc(materialDeliveries.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(
        rows.map((d) => ({
          ...d,
          craneRequired: d.craneRequired === 1,
          hasDiscrepancy: d.hasDiscrepancy === 1,
          invoiceMatched: d.invoiceMatched === 1,
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  /**
   * THREE-WAY MATCH: PO ↔ delivery ↔ invoice. An unmatched delivery is
   * either unbilled cost that will arrive later, or cost already billed
   * twice. Both are found by asking the question; neither is found by
   * waiting. Values are reported PER CURRENCY and never added.
   */
  app.get(
    "/projects/:projectId/material-deliveries/invoice-match",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({
          from: isoDateSchema.optional(),
          to: isoDateSchema.optional(),
        })
        .parse(req.query);
      const clauses = [
        eq(materialDeliveries.companyId, req.companyId!),
        eq(materialDeliveries.projectId, req.projectId!),
        inArray(materialDeliveries.status, ["received", "partially_received"]),
      ];
      if (q.from)
        clauses.push(
          gte(materialDeliveries.receivedAt, `${q.from}T00:00:00.000Z`),
        );
      if (q.to)
        clauses.push(
          lte(materialDeliveries.receivedAt, `${q.to}T23:59:59.999Z`),
        );
      const rows = await app.db
        .select()
        .from(materialDeliveries)
        .where(and(...clauses))
        .orderBy(asc(materialDeliveries.receivedAt));
      const matched = rows.filter((d) => d.invoiceMatched === 1);
      const unmatched = rows.filter((d) => d.invoiceMatched !== 1);
      const bucket = (list: typeof rows) => {
        const out: Record<
          string,
          { value: number; deliveries: number; unpriced: number }
        > = {};
        for (const d of list) {
          const cur = d.currency;
          const held = out[cur] ?? { value: 0, deliveries: 0, unpriced: 0 };
          held.deliveries += 1;
          if (d.totalValue === null) held.unpriced += 1;
          else held.value = round2(held.value + d.totalValue);
          out[cur] = held;
        }
        return out;
      };
      const asOf = todayISO();
      return {
        asOf,
        total: rows.length,
        matchedCount: matched.length,
        unmatchedCount: unmatched.length,
        matchedByCurrency: bucket(matched),
        unmatchedByCurrency: bucket(unmatched),
        unmatched: unmatched.map((d) => ({
          id: d.id,
          reference: d.reference,
          deliveryNoteNumber: d.deliveryNoteNumber,
          supplierVendorId: d.supplierVendorId,
          commitmentId: d.commitmentId,
          purchaseOrderRef: d.purchaseOrderRef,
          receivedAt: d.receivedAt,
          totalValue: d.totalValue,
          currency: d.currency,
          hasDiscrepancy: d.hasDiscrepancy === 1,
          ageDays:
            d.receivedAt === null
              ? null
              : Math.max(
                  0,
                  Math.round(
                    (Date.parse(`${asOf}T00:00:00Z`) -
                      Date.parse(d.receivedAt)) /
                      86_400_000,
                  ),
                ),
          valueNote:
            d.totalValue === null
              ? "this delivery carries no value, so the exposure cannot be stated — price the " +
                "lines or the match is only a tick, not a control"
              : null,
        })),
        interpretation:
          "an unmatched delivery is not automatically a problem — the invoice may simply not have " +
          "arrived. It becomes one when it ages: an old unmatched delivery is unbilled cost the " +
          "supplier will eventually claim (often at final account, when there is no budget left " +
          "for it), and a delivery matched to two invoice lines is cost paid twice. The value " +
          "figures are per currency and are never added together.",
      };
    },
  );

  app.get(
    "/projects/:projectId/material-deliveries/:deliveryId",
    { preHandler: readGate },
    async (req) => {
      const { deliveryId } = req.params as { deliveryId: string };
      const delivery = await fetchDelivery(
        deliveryId,
        req.companyId!,
        req.projectId!,
      );
      return decorateDelivery(delivery, await deliveryLines(deliveryId));
    },
  );

  /** Verification of the receipt. Schema comment: never the person who
   *  signed for it. The signature says material arrived; the verification
   *  says the delivery note matches what is standing in the compound. */
  app.post(
    "/projects/:projectId/material-deliveries/:deliveryId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { deliveryId } = req.params as { deliveryId: string };
      const body = z
        .object({ note: z.string().max(2000).optional() })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const delivery = await fetchDelivery(
        deliveryId,
        companyId,
        req.projectId!,
      );
      if (delivery.verifiedAt)
        throw conflict("this delivery has already been verified");
      if (!delivery.receivedAt) {
        throw badRequest(
          "this delivery has not been received yet — there is nothing to verify",
        );
      }
      const override = await assertIndependent(
        req,
        delivery.receivedBy ?? delivery.createdBy,
        "delivery verification",
        req.projectId!,
      );
      const now = new Date().toISOString();
      await app.db
        .update(materialDeliveries)
        .set({ verifiedBy: req.user!.id, verifiedAt: now, updatedAt: now })
        .where(eq(materialDeliveries.id, deliveryId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "material_delivery",
        objectId: deliveryId,
        projectId: req.projectId!,
        payload: {
          verified: true,
          receivedBy: delivery.receivedBy,
          note: body.note ?? null,
          selfVerifiedUnderOverride: override,
        },
        storePayload: true,
      });
      return {
        ...decorateDelivery(
          await fetchDelivery(deliveryId, companyId, req.projectId!),
          await deliveryLines(deliveryId),
        ),
        independentVerification: !override,
      };
    },
  );

  /**
   * Link a delivery discrepancy to an NCR raised in the quality module.
   * The NCR is NOT created here: non-conformance is a quality judgement with
   * its own disposition, segregation and closeout evidence, and duplicating
   * it in the materials module would produce two records of one problem that
   * disagree by the end of the month. This binds them.
   */
  app.post(
    "/projects/:projectId/material-deliveries/:deliveryId/ncr",
    { preHandler: standardGate },
    async (req) => {
      const { deliveryId } = req.params as { deliveryId: string };
      const body = z.object({ ncrId: idRef }).parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const delivery = await fetchDelivery(deliveryId, companyId, projectId);
      const ncrRows = await app.db
        .select()
        .from(nonConformanceReports)
        .where(
          and(
            eq(nonConformanceReports.id, body.ncrId),
            eq(nonConformanceReports.companyId, companyId),
            eq(nonConformanceReports.projectId, projectId),
          ),
        )
        .limit(1);
      const ncr = ncrRows[0];
      if (!ncr) throw badRequest("ncrId is not an NCR on this project");
      if (delivery.hasDiscrepancy !== 1) {
        throw badRequest(
          `${delivery.reference} records no discrepancy, so there is nothing for an NCR to be ` +
            "about. Record what was wrong with the delivery first.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(materialDeliveries)
        .set({ ncrId: body.ncrId, updatedAt: now })
        .where(eq(materialDeliveries.id, deliveryId));
      // The NCR's own `deliveryId` column exists for exactly this back-link.
      await app.db
        .update(nonConformanceReports)
        .set({ deliveryId, updatedAt: now })
        .where(eq(nonConformanceReports.id, body.ncrId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "material_delivery",
        objectId: deliveryId,
        projectId,
        payload: {
          ncrLinked: body.ncrId,
          ncrReference: ncr.reference,
          discrepancyKinds: delivery.discrepancyKinds,
        },
        storePayload: true,
      });
      return {
        deliveryId,
        deliveryReference: delivery.reference,
        ncrId: body.ncrId,
        ncrReference: ncr.reference,
        ncrStatus: ncr.status,
        note:
          "the delivery and the NCR now reference each other. The delivery record is the evidence " +
          "— quantities, batch and heat numbers, photographs — and the NCR carries the " +
          "disposition, corrective action and closeout.",
      };
    },
  );

  app.post(
    "/projects/:projectId/material-deliveries/:deliveryId/invoice-match",
    { preHandler: standardGate },
    async (req) => {
      const { deliveryId } = req.params as { deliveryId: string };
      const body = z
        .object({
          invoiceId: idRef,
          invoiceLineItemId: idRef.nullable().optional(),
          note: z.string().max(2000).optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const delivery = await fetchDelivery(deliveryId, companyId, projectId);
      if (!delivery.receivedAt) {
        throw badRequest(
          "this delivery has not been received — matching an invoice to a delivery that has not " +
            "happened is how a supplier gets paid for material nobody has seen",
        );
      }
      const invoiceRows = await app.db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, body.invoiceId),
            eq(invoices.companyId, companyId),
            eq(invoices.projectId, projectId),
          ),
        )
        .limit(1);
      const invoice = invoiceRows[0];
      if (!invoice)
        throw badRequest("invoiceId is not an invoice on this project");
      if (invoice.currency !== delivery.currency) {
        throw badRequest(
          `the delivery is valued in ${delivery.currency} and the invoice is in ` +
            `${invoice.currency}. Matching across currencies would need an FX rate and a date, and ` +
            "this module does not invent either — record the delivery in the currency it is billed in.",
        );
      }
      // The match is a check on the receipt, so it may not be done by the
      // person who signed for it.
      const override = await assertIndependent(
        req,
        delivery.receivedBy,
        "invoice match",
        projectId,
      );
      const alreadyMatched = await app.db
        .select({
          id: materialDeliveries.id,
          reference: materialDeliveries.reference,
        })
        .from(materialDeliveries)
        .where(
          and(
            eq(materialDeliveries.companyId, companyId),
            eq(materialDeliveries.projectId, projectId),
            eq(materialDeliveries.invoiceId, body.invoiceId),
          ),
        );
      const now = new Date().toISOString();
      await app.db
        .update(materialDeliveries)
        .set({
          invoiceMatched: 1,
          invoiceId: body.invoiceId,
          detail: {
            ...(delivery.detail as Record<string, unknown>),
            invoiceLineItemId: body.invoiceLineItemId ?? null,
            invoiceMatchedBy: req.user!.id,
            invoiceMatchedAt: now,
            invoiceMatchNote: body.note ?? null,
          },
          updatedAt: now,
        })
        .where(eq(materialDeliveries.id, deliveryId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "material_delivery",
        objectId: deliveryId,
        projectId,
        payload: {
          invoiceMatched: true,
          invoiceId: body.invoiceId,
          invoiceReference: invoice.reference,
          invoiceLineItemId: body.invoiceLineItemId ?? null,
          receivedBy: delivery.receivedBy,
          selfMatchedUnderOverride: override,
        },
        storePayload: true,
      });
      return {
        deliveryId,
        deliveryReference: delivery.reference,
        invoiceId: body.invoiceId,
        invoiceReference: invoice.reference,
        invoiceLineItemId: body.invoiceLineItemId ?? null,
        deliveryValue: delivery.totalValue,
        invoiceTotal: invoice.total,
        currency: delivery.currency,
        independentMatch: !override,
        valueVariance:
          delivery.totalValue === null
            ? null
            : round2(invoice.total - delivery.totalValue),
        valueVarianceNote:
          delivery.totalValue === null
            ? "the delivery carries no value, so the invoice cannot be checked against it — this " +
              "match records that the paperwork was seen, not that the amount is right"
            : null,
        otherDeliveriesOnThisInvoice: alreadyMatched
          .filter((d) => d.id !== deliveryId)
          .map((d) => d.reference),
        doubleBillingNote:
          alreadyMatched.filter((d) => d.id !== deliveryId).length > 0
            ? "other deliveries are already matched to this invoice. That is legitimate for a " +
              "consolidated invoice and is double-billing if it is not — check the invoice lines."
            : null,
      };
    },
  );

  /* ================================================================ */
  /* STOCK MOVEMENTS                                                   */
  /* ================================================================ */

  const movementCreateSchema = z.object({
    materialItemId: idRef,
    movementType: z.enum(STOCK_MOVEMENT_TYPES),
    quantity: z.number().finite(),
    movedAt: isoTimestamp.optional(),
    fromLocationId: idRef.nullable().optional(),
    toLocationId: idRef.nullable().optional(),
    fromProjectId: idRef.nullable().optional(),
    toProjectId: idRef.nullable().optional(),
    issuedToWorkerId: idRef.nullable().optional(),
    issuedToVendorId: idRef.nullable().optional(),
    crewId: idRef.nullable().optional(),
    costCodeId: idRef.nullable().optional(),
    budgetLineItemId: idRef.nullable().optional(),
    scheduleActivityId: idRef.nullable().optional(),
    deliveryId: idRef.nullable().optional(),
    batchNumber: z.string().max(120).nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
    unitCost: money.nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    source: z.enum(EQUIPMENT_DATA_SOURCES).default("manual"),
    sourceRef: z.string().max(200).nullable().optional(),
    photoFileIds: z.array(idRef).max(50).optional(),
    /** knowingly accept a balance the compound cannot support — signalled */
    allowNegative: z.boolean().default(false),
    detail: z.record(z.string(), z.unknown()).optional(),
  });

  app.post(
    "/projects/:projectId/material-stock-movements",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = movementCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const item = await fetchMaterialItem(
        body.materialItemId,
        companyId,
        projectId,
      );
      if (item.isTracked !== 1) {
        throw badRequest(
          `${item.reference} ${item.name} is not stock-tracked (isTracked = false) — it is a bulk ` +
            "consumable with no running balance. Turn tracking on before recording movements, or " +
            "the balance will mean nothing.",
        );
      }
      if (LOSS_MOVEMENT_TYPES.includes(body.movementType) && !body.reason) {
        throw badRequest(
          `a ${body.movementType} movement needs a reason. Wastage, damage and theft are separate ` +
            "kinds precisely so material loss is measurable — an unexplained one is not.",
        );
      }
      const result = await insertStockMovement({
        companyId,
        projectId,
        item,
        movementType: body.movementType,
        quantity: body.quantity,
        actorId: req.user!.id,
        movedAt: body.movedAt,
        allowNegative: body.allowNegative,
        reason: body.reason ?? null,
        unitCost: body.unitCost ?? null,
        currency: body.currency ?? null,
        deliveryId: body.deliveryId ?? null,
        batchNumber: body.batchNumber ?? null,
        fromLocationId: body.fromLocationId ?? null,
        toLocationId: body.toLocationId ?? null,
        fromProjectId: body.fromProjectId ?? null,
        toProjectId: body.toProjectId ?? null,
        issuedToWorkerId: body.issuedToWorkerId ?? null,
        issuedToVendorId: body.issuedToVendorId ?? null,
        crewId: body.crewId ?? null,
        costCodeId: body.costCodeId ?? null,
        budgetLineItemId: body.budgetLineItemId ?? null,
        scheduleActivityId: body.scheduleActivityId ?? null,
        source: body.source,
        sourceRef: body.sourceRef ?? null,
        photoFileIds: body.photoFileIds ?? [],
        detail: body.detail ?? {},
      });
      const after = await fetchMaterialItem(
        body.materialItemId,
        companyId,
        projectId,
      );
      return reply.status(201).send({
        ...result.movement,
        balance: {
          before: result.shortfall.currentBalance,
          after: result.movement.balanceAfter,
          availableToIssue: round2(
            after.quantityOnHand - after.quantityReserved,
          ),
          unit: item.unit,
        },
        forcedNegative: result.shortfall.wouldGoNegative,
        signalId: result.signalId,
        note: result.shortfall.wouldGoNegative
          ? "this movement was FORCED past a zero balance. A Signal has been raised recording who " +
            "did it and what the shortfall was."
          : null,
      });
    },
  );

  app.get(
    "/projects/:projectId/material-stock-movements",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          materialItemId: idRef.optional(),
          movementType: z.enum(STOCK_MOVEMENT_TYPES).optional(),
          from: isoDateSchema.optional(),
          to: isoDateSchema.optional(),
          lossesOnly: z.coerce.boolean().optional(),
        })
        .parse(req.query);
      const clauses = [
        eq(materialStockMovements.companyId, req.companyId!),
        eq(materialStockMovements.projectId, req.projectId!),
      ];
      if (q.materialItemId)
        clauses.push(
          eq(materialStockMovements.materialItemId, q.materialItemId),
        );
      if (q.movementType)
        clauses.push(eq(materialStockMovements.movementType, q.movementType));
      if (q.lossesOnly)
        clauses.push(
          inArray(materialStockMovements.movementType, [
            ...LOSS_MOVEMENT_TYPES,
          ]),
        );
      if (q.from)
        clauses.push(
          gte(materialStockMovements.movedAt, `${q.from}T00:00:00.000Z`),
        );
      if (q.to)
        clauses.push(
          lte(materialStockMovements.movedAt, `${q.to}T23:59:59.999Z`),
        );
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(materialStockMovements)
        .where(where);
      const rows = await app.db
        .select()
        .from(materialStockMovements)
        .where(where)
        .orderBy(desc(materialStockMovements.movedAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows, Number(totalRow?.n ?? 0), q);
    },
  );

  /**
   * The reconciliation. Replays the statement and compares it to the
   * materialized balance, because a materialized balance that has drifted is
   * worse than no balance at all — it is a number people order against.
   */
  app.get(
    "/projects/:projectId/materials/:itemId/stock",
    { preHandler: readGate },
    async (req) => {
      const { itemId } = req.params as { itemId: string };
      const companyId = req.companyId!;
      const item = await fetchMaterialItem(itemId, companyId, req.projectId!);
      const movements = await app.db
        .select()
        .from(materialStockMovements)
        .where(eq(materialStockMovements.materialItemId, itemId))
        .orderBy(asc(materialStockMovements.movedAt));
      const reconciliation = reconcileStock({
        openingBalance: 0,
        recordedBalance: item.quantityOnHand,
        movements: movements.map((m) => ({
          id: m.id,
          movementType: m.movementType as StockMovementType,
          quantity: m.quantity,
          movedAt: m.movedAt,
          balanceAfter: m.balanceAfter,
        })),
      });
      return {
        materialItemId: itemId,
        reference: item.reference,
        name: item.name,
        unit: item.unit,
        quantityOnHand: item.quantityOnHand,
        quantityReserved: item.quantityReserved,
        availableToIssue: round2(item.quantityOnHand - item.quantityReserved),
        reconciliation,
        method:
          "movements are replayed in movedAt order (ties broken by id), starting from a zero " +
          "opening balance: every unit in the compound must have arrived through a movement. " +
          "Reservations move quantityReserved, not the on-hand balance, so reserved stock is " +
          "still physically there and still counted.",
        verdict: reconciliation.reconciles
          ? "the balance reconciles to the movements"
          : `the balance does NOT reconcile — the recorded figure and the replayed movements ` +
            `differ by ${reconciliation.difference} ${item.unit}. One of the two is wrong, and ` +
            `only the compound can say which.`,
      };
    },
  );

  /** Sign-off on a loss. Schema comment: never the person who reported it.
   *  "Theft" recorded and countersigned by the same person is not a control. */
  app.post(
    "/projects/:projectId/material-stock-movements/:movementId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { movementId } = req.params as { movementId: string };
      const body = z
        .object({ note: z.string().max(2000).optional() })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const rows = await app.db
        .select()
        .from(materialStockMovements)
        .where(
          and(
            eq(materialStockMovements.id, movementId),
            eq(materialStockMovements.companyId, companyId),
            eq(materialStockMovements.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const movement = rows[0];
      if (!movement) throw notFound("Stock movement not found");
      if (movement.verifiedAt)
        throw conflict("this movement has already been verified");
      const override = await assertIndependent(
        req,
        movement.createdBy,
        "stock movement verification",
        req.projectId!,
      );
      const now = new Date().toISOString();
      await app.db
        .update(materialStockMovements)
        .set({ verifiedBy: req.user!.id, verifiedAt: now })
        .where(eq(materialStockMovements.id, movementId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "material_stock_movement",
        objectId: movementId,
        projectId: req.projectId!,
        payload: {
          verified: true,
          movementType: movement.movementType,
          quantity: movement.quantity,
          reportedBy: movement.createdBy,
          note: body.note ?? null,
          selfVerifiedUnderOverride: override,
        },
        storePayload: true,
      });
      const after = await app.db
        .select()
        .from(materialStockMovements)
        .where(eq(materialStockMovements.id, movementId))
        .limit(1);
      return { ...after[0], independentVerification: !override };
    },
  );

  /* ================================================================ */
  /* MODULE SUMMARY                                                    */
  /* ================================================================ */

  /** One read that answers "what is wrong with the plant and materials on
   *  this project today", and runs the sweep while it does. */
  app.get(
    "/projects/:projectId/equipment-summary",
    { preHandler: readGate },
    async (req) => {
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      await maybeSweep(companyId);
      const asOf = todayISO();
      const signalRows = await app.db
        .select({
          detector: signals.detector,
          disposition: signals.disposition,
          severity: signals.severity,
          n: count(),
        })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, companyId),
            inArray(signals.detector, [...EQUIPMENT_DETECTORS]),
            or(eq(signals.projectId, projectId), isNull(signals.projectId))!,
          ),
        )
        .groupBy(signals.detector, signals.disposition, signals.severity);
      const byDetector: Record<string, number> = {};
      for (const d of EQUIPMENT_DETECTORS) byDetector[d] = 0;
      let open = 0;
      let critical = 0;
      let total = 0;
      for (const row of signalRows) {
        const n = Number(row.n);
        byDetector[row.detector] = (byDetector[row.detector] ?? 0) + n;
        total += n;
        if (row.disposition === "new" || row.disposition === "under_review")
          open += n;
        if (row.severity === "critical") critical += n;
      }
      const assigned = await app.db
        .select({ equipmentId: equipmentAssignments.equipmentId })
        .from(equipmentAssignments)
        .where(
          and(
            eq(equipmentAssignments.companyId, companyId),
            eq(equipmentAssignments.projectId, projectId),
            inArray(equipmentAssignments.status, [
              ...IN_SERVICE_ASSIGNMENT_STATUSES,
            ]),
          ),
        );
      const deliveries = await app.db
        .select({
          status: materialDeliveries.status,
          hasDiscrepancy: materialDeliveries.hasDiscrepancy,
          invoiceMatched: materialDeliveries.invoiceMatched,
          ncrId: materialDeliveries.ncrId,
        })
        .from(materialDeliveries)
        .where(
          and(
            eq(materialDeliveries.companyId, companyId),
            eq(materialDeliveries.projectId, projectId),
          ),
        );
      return {
        asOf,
        plant: {
          assignedMachines: new Set(assigned.map((a) => a.equipmentId)).size,
        },
        deliveries: {
          total: deliveries.length,
          withDiscrepancy: deliveries.filter((d) => d.hasDiscrepancy === 1)
            .length,
          discrepancyWithoutNcr: deliveries.filter(
            (d) => d.hasDiscrepancy === 1 && !d.ncrId,
          ).length,
          unmatchedToInvoice: deliveries.filter(
            (d) =>
              d.invoiceMatched !== 1 &&
              ["received", "partially_received"].includes(d.status),
          ).length,
        },
        signals: { total, open, critical, byDetector },
        detectors: EQUIPMENT_DETECTORS,
      };
    },
  );
  /* ================================================================ */
  /* ASSIGNMENT LIFECYCLE — cancel and transfer (#714-718)             */
  /* ================================================================ */

  /**
   * CANCEL. `cancelled` was referenced by the PATCH guard and by the
   * demobilise error text ("cancel the assignment instead") and no route ever
   * set it: a hire that was approved and never arrived could not be
   * demobilised (nothing was ever mobilised) and could not be cancelled, so
   * the machine was blocked from every other project for good.
   */
  app.post(
    "/projects/:projectId/equipment/assignments/:assignmentId/cancel",
    { preHandler: standardGate },
    async (req) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const body = z
        .object({
          reason: z.enum(ASSIGNMENT_CANCEL_REASONS).default("hire_not_required"),
          note: z.string().max(2000).nullable().optional(),
        })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const assignment = await fetchAssignment(assignmentId, companyId, projectId);
      if (!["requested", "approved", "mobilising"].includes(assignment.status)) {
        throw conflict(
          `assignment ${assignment.id} is "${assignment.status}". A machine that has arrived is ` +
            "demobilised, not cancelled — the difference is whether anything was ever on site, " +
            "and the hire company's invoice will know which.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(equipmentAssignments)
        .set({
          status: "cancelled",
          assignedTo: assignment.assignedTo ?? todayISO(),
          detail: {
            ...(assignment.detail ?? {}),
            cancelReason: body.reason,
            cancelNote: body.note ?? null,
          },
          updatedAt: now,
        })
        .where(eq(equipmentAssignments.id, assignmentId));
      const machine = await fetchEquipment(assignment.equipmentId, companyId);
      if (machine.currentAssignmentId === assignmentId) {
        await app.db
          .update(equipment)
          .set({
            currentAssignmentId: null,
            projectId: null,
            status: machine.status === "in_use" ? "available" : machine.status,
            updatedAt: now,
          })
          .where(eq(equipment.id, machine.id));
      }
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment_assignment",
        objectId: assignmentId,
        projectId,
        payload: {
          from: assignment.status,
          to: "cancelled",
          reason: body.reason,
          note: body.note ?? null,
          equipmentId: assignment.equipmentId,
          equipmentReference: machine.reference,
        },
        storePayload: true,
      });
      return {
        ...(await fetchAssignment(assignmentId, companyId, projectId)),
        note:
          "the machine is free to be assigned again. If the hire company has charged anything " +
          "against this booking, that is a credit to chase now rather than at the end of the job.",
      };
    },
  );

  /**
   * TRANSFER. Moving plant between two of your own jobs is one decision, not
   * a demobilisation somebody remembers to follow with a mobilisation — and
   * the cost coding has to move with it or the receiving job runs free.
   */
  app.post(
    "/projects/:projectId/equipment/assignments/:assignmentId/transfer",
    { preHandler: standardGate },
    async (req, reply) => {
      const { assignmentId } = req.params as { assignmentId: string };
      const body = z
        .object({
          toProjectId: idRef,
          at: isoDateSchema.optional(),
          assignedTo: isoDateSchema.nullable().optional(),
          locationId: idRef.nullable().optional(),
          costCodeId: idRef.nullable().optional(),
          budgetLineItemId: idRef.nullable().optional(),
          transportDocketRef: z.string().max(120).nullable().optional(),
          mobilisationCost: money.nullable().optional(),
          notes: z.string().max(2000).nullable().optional(),
        })
        .parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      if (body.toProjectId === projectId) {
        throw badRequest("a machine cannot be transferred to the project it is already on");
      }
      await assertProject(body.toProjectId, companyId);
      const assignment = await fetchAssignment(assignmentId, companyId, projectId);
      if (!["approved", "mobilising", "on_site"].includes(assignment.status)) {
        throw conflict(
          `assignment ${assignment.id} is "${assignment.status}" — there is nothing on this ` +
            "project to transfer.",
        );
      }
      const machine = await fetchEquipment(assignment.equipmentId, companyId);
      const at = body.at ?? todayISO();
      const now = new Date().toISOString();
      const newAssignmentId = newId("eqa");

      await app.db.transaction(async (tx) => {
        await tx
          .update(equipmentAssignments)
          .set({
            status: "returned",
            returnedAt: `${at}T00:00:00.000Z`,
            assignedTo: at,
            detail: {
              ...(assignment.detail ?? {}),
              transferredTo: { projectId: body.toProjectId, assignmentId: newAssignmentId, at },
            },
            updatedAt: now,
          })
          .where(eq(equipmentAssignments.id, assignmentId));
        await tx.insert(equipmentAssignments).values({
          id: newAssignmentId,
          companyId,
          projectId: body.toProjectId,
          equipmentId: assignment.equipmentId,
          fromProjectId: projectId,
          // The hire spend was approved once; moving the machine between our
          // own jobs does not re-open that decision, and stamping a new
          // approver would be a fabricated approval.
          status: assignment.approvedBy ? "approved" : "requested",
          assignedFrom: at,
          assignedTo: body.assignedTo ?? null,
          locationId: body.locationId ?? null,
          costCodeId: body.costCodeId ?? assignment.costCodeId,
          budgetLineItemId: body.budgetLineItemId ?? assignment.budgetLineItemId,
          operatorWorkerId: assignment.operatorWorkerId,
          crewId: null,
          mobilisationCost: body.mobilisationCost ?? null,
          currency: assignment.currency,
          transportDocketRef: body.transportDocketRef ?? null,
          notes: body.notes ?? null,
          requestedBy: req.user!.id,
          approvedBy: assignment.approvedBy,
          approvedAt: assignment.approvedAt,
          detail: { transferredFrom: { projectId, assignmentId, at } },
          createdBy: req.user!.id,
        });
        await tx
          .update(equipment)
          .set({
            projectId: body.toProjectId,
            currentAssignmentId: newAssignmentId,
            updatedAt: now,
          })
          .where(eq(equipment.id, assignment.equipmentId));
      });

      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "equipment_assignment",
        objectId: assignmentId,
        projectId,
        payload: {
          from: assignment.status,
          to: "returned",
          transfer: { toProjectId: body.toProjectId, newAssignmentId, at },
          equipmentId: assignment.equipmentId,
          equipmentReference: machine.reference,
          mobilisationCost: body.mobilisationCost ?? null,
        },
        storePayload: true,
      });
      return reply.status(201).send({
        from: await fetchAssignment(assignmentId, companyId, projectId),
        to: await fetchAssignment(newAssignmentId, companyId, body.toProjectId),
        note:
          body.mobilisationCost == null
            ? "no transport cost was recorded against the move. It is the cost most often lost " +
              "between two jobs, because neither of them raised it."
            : null,
      });
    },
  );

  /**
   * AVAILABILITY. Which machines are free between two dates — the question a
   * plant manager asks before every booking, previously answerable only by
   * reading the assignment list by eye.
   */
  app.get(
    "/companies/current/equipment-availability",
    { preHandler: companyRead },
    async (req) => {
      const q = z
        .object({
          from: isoDateSchema,
          to: isoDateSchema,
          category: z.enum(EQUIPMENT_CATEGORIES).optional(),
        })
        .parse(req.query);
      if (q.to < q.from) throw badRequest("to must not precede from");
      const companyId = req.companyId!;
      const scope = companyScopeOf(req);
      const clauses = [eq(equipment.companyId, companyId), isNull(equipment.offHiredAt)];
      if (q.category) clauses.push(eq(equipment.category, q.category));
      const projectFilter = scopeProjectFilter(scope, equipment.projectId);
      if (projectFilter) clauses.push(projectFilter);
      const fleet = await app.db
        .select()
        .from(equipment)
        .where(and(...clauses))
        .orderBy(asc(equipment.number));
      if (fleet.length === 0) return { from: q.from, to: q.to, available: [], busy: [] };

      const assignments = await app.db
        .select()
        .from(equipmentAssignments)
        .where(
          and(
            eq(equipmentAssignments.companyId, companyId),
            inArray(
              equipmentAssignments.equipmentId,
              fleet.map((m) => m.id),
            ),
            inArray(equipmentAssignments.status, [...IN_SERVICE_ASSIGNMENT_STATUSES]),
          ),
        );
      const downtime = await app.db
        .select()
        .from(equipmentMaintenanceSchedules)
        .where(
          and(
            eq(equipmentMaintenanceSchedules.companyId, companyId),
            inArray(equipmentMaintenanceSchedules.status, ["due", "overdue"]),
            inArray(
              equipmentMaintenanceSchedules.equipmentId,
              fleet.map((m) => m.id),
            ),
          ),
        );
      const overlaps = (from: string, to: string | null): boolean =>
        from <= q.to && (to === null || to >= q.from);

      const available: unknown[] = [];
      const busy: unknown[] = [];
      for (const machine of fleet) {
        const clash = assignments.filter(
          (a) => a.equipmentId === machine.id && overlaps(a.assignedFrom, a.assignedTo),
        );
        const service = downtime.filter((d) => d.equipmentId === machine.id);
        const hireEnds =
          machine.hireEndDate !== null && machine.hireEndDate < q.to ? machine.hireEndDate : null;
        const row = {
          id: machine.id,
          reference: machine.reference,
          name: machine.name,
          category: machine.category,
          ownership: machine.ownership,
          status: machine.status,
          currency: machine.currency,
          hireRateAmount: machine.hireRateAmount,
          hireRateUnit: machine.hireRateUnit,
          internalRateAmount: machine.internalRateAmount,
          outOfCertificate:
            machine.nextCertificateExpiry !== null && machine.nextCertificateExpiry < q.to,
          nextCertificateExpiry: machine.nextCertificateExpiry,
          clashes: clash.map((a) => ({
            assignmentId: a.id,
            projectId: a.projectId,
            status: a.status,
            assignedFrom: a.assignedFrom,
            assignedTo: a.assignedTo,
          })),
          serviceDue: service.map((d) => ({
            scheduleId: d.id,
            name: d.name,
            nextDueAt: d.nextDueAt,
          })),
          caveats: [
            ...(hireEnds
              ? [`the hire agreement ends ${hireEnds}, inside the window you asked about`]
              : []),
            ...(service.length > 0
              ? [
                  `${service.length} service(s) are due or overdue — book the downtime, not just ` +
                    "the machine",
                ]
              : []),
            ...(machine.nextCertificateExpiry !== null && machine.nextCertificateExpiry < q.to
              ? [
                  `a certificate expires ${machine.nextCertificateExpiry}: the machine may not be ` +
                    "worked past that date until it is renewed",
                ]
              : []),
          ],
        };
        if (clash.length === 0) available.push(row);
        else busy.push(row);
      }
      return {
        from: q.from,
        to: q.to,
        available,
        busy,
        note:
          "availability is computed from live assignments, the hire end date and outstanding " +
          "services. It does not know about a machine somebody has verbally promised elsewhere.",
      };
    },
  );

  /* ================================================================ */
  /* MATERIALS SUPPLY — order-by dates, shortages, supplier scorecard  */
  /* ================================================================ */

  /** Quantity on deliveries that are booked but have not yet been received. */
  async function inTransitByItem(
    companyId: string,
    projectId: string,
  ): Promise<Map<string, number>> {
    const rows = await app.db
      .select({
        materialItemId: materialDeliveryLines.materialItemId,
        quantityExpected: materialDeliveryLines.quantityExpected,
      })
      .from(materialDeliveryLines)
      .innerJoin(materialDeliveries, eq(materialDeliveries.id, materialDeliveryLines.deliveryId))
      .where(
        and(
          eq(materialDeliveryLines.companyId, companyId),
          eq(materialDeliveryLines.projectId, projectId),
          isNull(materialDeliveries.receivedAt),
          inArray(materialDeliveries.status, ["scheduled", "in_transit", "arrived"]),
        ),
      );
    const out = new Map<string, number>();
    for (const r of rows) {
      if (!r.materialItemId || r.quantityExpected === null) continue;
      out.set(r.materialItemId, round2((out.get(r.materialItemId) ?? 0) + r.quantityExpected));
    }
    return out;
  }

  async function supplyAssessment(companyId: string, projectId: string) {
    const asOf = todayISO();
    const items = await app.db
      .select()
      .from(materialItems)
      .where(and(eq(materialItems.companyId, companyId), eq(materialItems.projectId, projectId)));
    const inTransit = await inTransitByItem(companyId, projectId);
    const assessments = items.map((item) =>
      assessSupplyItem(
        {
          id: item.id,
          reference: item.reference,
          name: item.name,
          unit: item.unit,
          status: item.status,
          leadTimeDays: item.leadTimeDays,
          requiredOnSiteDate: item.requiredOnSiteDate,
          orderPlacedAt: item.orderPlacedAt,
          scheduleActivityId: item.scheduleActivityId,
          quantityRequired: item.quantityRequired,
          quantityOrdered: item.quantityOrdered,
          quantityDelivered: item.quantityDelivered,
          quantityAccepted: item.quantityAccepted,
          quantityOnHand: item.quantityOnHand,
          quantityReserved: item.quantityReserved,
          quantityInTransit: inTransit.get(item.id) ?? 0,
          unitCost: item.unitCost,
          currency: item.currency,
        },
        asOf,
      ),
    );
    const openDeliveries = await app.db
      .select()
      .from(materialDeliveries)
      .where(
        and(
          eq(materialDeliveries.companyId, companyId),
          eq(materialDeliveries.projectId, projectId),
          inArray(materialDeliveries.status, ["scheduled", "in_transit"]),
        ),
      );
    const openLines = openDeliveries.length
      ? await app.db
          .select({
            deliveryId: materialDeliveryLines.deliveryId,
            materialItemId: materialDeliveryLines.materialItemId,
          })
          .from(materialDeliveryLines)
          .where(
            inArray(
              materialDeliveryLines.deliveryId,
              openDeliveries.map((d) => d.id),
            ),
          )
      : [];
    const delayedDeliveries = detectDelayedDeliveries(
      openDeliveries.map((d) => ({
        id: d.id,
        reference: d.reference,
        status: d.status,
        scheduledFor: d.scheduledFor,
        arrivedAt: d.arrivedAt,
        receivedAt: d.receivedAt,
        supplierVendorId: d.supplierVendorId,
        itemIds: openLines
          .filter((l) => l.deliveryId === d.id && l.materialItemId)
          .map((l) => l.materialItemId as string),
      })),
      asOf,
    );
    const valuation = valueInventory(
      items.map((i) => ({
        id: i.id,
        reference: i.reference,
        name: i.name,
        unit: i.unit,
        quantityOnHand: i.quantityOnHand,
        quantityDelivered: i.quantityDelivered,
        quantityInstalled: i.quantityInstalled,
        quantityWasted: i.quantityWasted,
        unitCost: i.unitCost,
        currency: i.currency,
      })),
    );
    return { asOf, items: assessments, delayedDeliveries, valuation };
  }

  app.get("/projects/:projectId/materials/supply", { preHandler: readGate }, async (req) => {
    const result = await supplyAssessment(req.companyId!, req.projectId!);
    return {
      ...result,
      summary: {
        items: result.items.length,
        orderByDateMissed: result.items.filter((i) => i.risk === "order_by_date_missed").length,
        orderNow: result.items.filter((i) => i.risk === "order_now").length,
        shortages: result.items.filter((i) => i.risk === "shortage").length,
        unknown: result.items.filter((i) => i.risk === "unknown").length,
        delayedDeliveries: result.delayedDeliveries.length,
      },
      atRisk: result.items.filter((i) => i.risk !== "ok"),
      method:
        "order-by date = required-on-site − lead time − " +
        `${PROCUREMENT_ALLOWANCE_DAYS} days to place the order. An item with no lead time or no ` +
        "required-on-site date has no order-by date and is listed as unknown, never as safe.",
    };
  });

  /**
   * Raise the supply signals. A read never writes, so the detectors run here
   * and from the scheduler — idempotently, keyed on the item and the risk.
   */
  async function sweepMaterialSupply(companyId: string): Promise<{ raised: number }> {
    const projectRows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    let raised = 0;
    for (const project of projectRows) {
      const result = await supplyAssessment(companyId, project.id);
      const atRisk = result.items.filter(
        (i) => i.risk === "order_by_date_missed" || i.risk === "shortage",
      );
      if (atRisk.length > 0) {
        const keys = atRisk.map((i) => `${i.id}|${i.risk}`);
        const seenMissed = await alreadySignalled(
          companyId,
          "material_order_by_date_missed",
          keys,
        );
        const seenShort = await alreadySignalled(companyId, "material_shortage_forecast", keys);
        for (const item of atRisk) {
          const detector =
            item.risk === "shortage"
              ? "material_shortage_forecast"
              : "material_order_by_date_missed";
          const id = await raiseSignalOnce({
            companyId,
            projectId: project.id,
            detector: detector as EquipmentDetector,
            key: `${item.id}|${item.risk}`,
            severity: item.risk === "order_by_date_missed" ? "high" : "medium",
            title:
              item.risk === "order_by_date_missed"
                ? `Order-by date missed — ${item.reference} ${item.name}`
                : `Material shortage forecast — ${item.reference} ${item.name}`,
            explanation: item.reasons.join(" "),
            refs: {
              materialItemId: item.id,
              reference: item.reference,
              orderByDate: item.orderByDate,
              shortfall: item.shortfall,
              exposure: item.exposure,
              currency: item.currency,
              scheduleActivityId: item.activityAtRisk?.id ?? null,
            },
            seen: detector === "material_shortage_forecast" ? seenShort : seenMissed,
          });
          if (id) raised += 1;
        }
      }
      if (result.delayedDeliveries.length > 0) {
        const keys = result.delayedDeliveries.map((d) => d.id);
        const seen = await alreadySignalled(companyId, "material_delivery_delayed", keys);
        for (const delayed of result.delayedDeliveries) {
          const id = await raiseSignalOnce({
            companyId,
            projectId: project.id,
            detector: "material_delivery_delayed" as EquipmentDetector,
            key: delayed.id,
            severity: delayed.overdueDays > 7 ? "high" : "medium",
            title: `Delivery overdue — ${delayed.reference}`,
            explanation: delayed.explanation,
            refs: {
              deliveryId: delayed.id,
              reference: delayed.reference,
              scheduledFor: delayed.scheduledFor,
              overdueDays: delayed.overdueDays,
              supplierVendorId: delayed.supplierVendorId,
              itemIds: delayed.itemIds,
            },
            seen,
          });
          if (id) raised += 1;
        }
      }
    }
    return { raised };
  }

  app.post(
    "/projects/:projectId/materials/supply/run",
    { preHandler: standardGate },
    async (req) => {
      const companyId = req.companyId!;
      const result = await sweepMaterialSupply(companyId);
      const assessment = await supplyAssessment(companyId, req.projectId!);
      return { ...result, ...assessment };
    },
  );

  /**
   * Supplier performance from deliveries alone. No survey, no opinion: the
   * dates, the discrepancies and the invoice matches already on record.
   */
  app.get(
    "/companies/current/materials/supplier-scorecard",
    { preHandler: companyRead },
    async (req) => {
      const q = z
        .object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
        .parse(req.query);
      const companyId = req.companyId!;
      const scope = companyScopeOf(req);
      const clauses = [
        eq(materialDeliveries.companyId, companyId),
        isNotNull(materialDeliveries.supplierVendorId),
      ];
      if (q.from) clauses.push(gte(materialDeliveries.createdAt, `${q.from}T00:00:00.000Z`));
      if (q.to) clauses.push(lte(materialDeliveries.createdAt, `${q.to}T23:59:59.999Z`));
      const projectFilter = scopeProjectFilter(scope, materialDeliveries.projectId);
      if (projectFilter) clauses.push(projectFilter);
      const deliveryRows = await app.db
        .select()
        .from(materialDeliveries)
        .where(and(...clauses));
      if (deliveryRows.length === 0) {
        return {
          items: [],
          total: 0,
          method:
            "no delivery in this window names a supplier, so nobody can be scored. A scorecard " +
            "built on deliveries with no vendor would rank the blank.",
        };
      }
      const lineRows = await app.db
        .select({
          deliveryId: materialDeliveryLines.deliveryId,
          quantityReceived: materialDeliveryLines.quantityReceived,
          quantityRejected: materialDeliveryLines.quantityRejected,
        })
        .from(materialDeliveryLines)
        .where(
          inArray(
            materialDeliveryLines.deliveryId,
            deliveryRows.map((d) => d.id),
          ),
        );
      const facts = deliveryRows.map((d) => {
        const own = lineRows.filter((l) => l.deliveryId === d.id);
        return {
          vendorId: d.supplierVendorId as string,
          scheduledFor: d.scheduledFor,
          receivedAt: d.receivedAt,
          hasDiscrepancy: d.hasDiscrepancy === 1,
          waitingMinutes: d.waitingMinutes,
          quantityReceived: round2(own.reduce((s, l) => s + l.quantityReceived, 0)),
          quantityRejected: round2(own.reduce((s, l) => s + l.quantityRejected, 0)),
          invoiceMatched: d.receivedAt ? d.invoiceMatched === 1 : null,
          invoiceVarianceAmount:
            (d.detail as { invoiceVariance?: number } | null)?.invoiceVariance ?? null,
          currency: d.currency,
        };
      });
      const vendorIds = [...new Set(facts.map((f) => f.vendorId))];
      const vendorRows = await app.db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, vendorIds)));
      const items = scoreSuppliers(facts, new Map(vendorRows.map((r) => [r.id, r.name] as const)));
      return {
        items,
        total: items.length,
        method:
          "50 points punctuality (received on or before the booked day), 15 discrepancy-free, " +
          "10 rejection-free, 15 invoice match, 10 waiting time under two hours. A component with " +
          `no data drops out of the denominator; fewer than ${MIN_DELIVERIES_TO_SCORE} deliveries ` +
          "gives measured rates and no score.",
      };
    },
  );

  /* ================================================================ */
  /* HEALTH INPUTS (contract 3.5) + the manual sweep                   */
  /* ================================================================ */

  app.get(
    "/projects/:projectId/equipment/health-inputs",
    { preHandler: readGate },
    async (req) => {
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const asOf = todayISO();
      const assigned = await app.db
        .select({ equipmentId: equipmentAssignments.equipmentId })
        .from(equipmentAssignments)
        .where(
          and(
            eq(equipmentAssignments.companyId, companyId),
            eq(equipmentAssignments.projectId, projectId),
            inArray(equipmentAssignments.status, [...IN_SERVICE_ASSIGNMENT_STATUSES]),
          ),
        );
      const machineIds = [...new Set(assigned.map((a) => a.equipmentId))];
      const machines = machineIds.length
        ? await app.db.select().from(equipment).where(inArray(equipment.id, machineIds))
        : [];
      const outOfCertificate = machines.filter(
        (m) => m.nextCertificateExpiry !== null && m.nextCertificateExpiry < asOf,
      ).length;
      const maintenanceOverdue = machines.filter(
        (m) => m.nextMaintenanceDue !== null && m.nextMaintenanceDue < asOf,
      ).length;
      const supply = await supplyAssessment(companyId, projectId);
      const openSignals = await app.db
        .select({ n: count() })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, companyId),
            eq(signals.projectId, projectId),
            inArray(signals.detector, [...EQUIPMENT_DETECTORS]),
            inArray(signals.disposition, ["new", "under_review", "confirmed"]),
          ),
        );
      const reasons: string[] = [];
      if (machines.length === 0) {
        reasons.push(
          "no plant is assigned to this project, so the plant metrics are null rather than zero",
        );
      }
      return {
        metrics: {
          machinesOnSite: machines.length,
          machinesOutOfCertificate: machines.length === 0 ? null : outOfCertificate,
          machinesMaintenanceOverdue: machines.length === 0 ? null : maintenanceOverdue,
          materialItemsAtRisk: supply.items.filter(
            (i) => i.risk !== "ok" && i.risk !== "unknown",
          ).length,
          deliveriesOverdue: supply.delayedDeliveries.length,
          openEquipmentSignals: Number(openSignals[0]?.n ?? 0),
        },
        reasons,
      };
    },
  );

  /** Run the sweep on demand — what an operator and the tests reach for. */
  app.post("/companies/current/equipment/sweep", { preHandler: companyWrite }, async (req) => {
    const companyId = req.companyId!;
    await sweepEquipment(companyId, null);
    const supply = await sweepMaterialSupply(companyId);
    lastSweptAt.set(companyId, Date.now());
    return { swept: true, supplySignalsRaised: supply.raised };
  });

  /* ================================================================ */
  /* TELEMATICS INTELLIGENCE — geofence, fuel and fault codes           */
  /* ================================================================ */

  /**
   * What the machine's own feed says beyond hours: where it was worked, what
   * it burned against what was put in it, and what it is complaining about.
   *
   * Each part refuses rather than guesses. No project location means no fence
   * and no verdict. A feed that reports no fuel consumption cannot evidence a
   * loss, however many litres were booked in. A single off-site reading says
   * where the machine was, not how long it was there.
   */
  app.get(
    "/projects/:projectId/equipment-telematics/intelligence",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({
          days: z.coerce.number().int().min(1).max(90).default(14),
          radiusMetres: z.coerce.number().int().min(50).max(200_000).optional(),
        })
        .parse(req.query);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const to = todayISO();
      const from = addDaysISO(to, -(q.days - 1));

      const [project] = await app.db
        .select({ latitude: projects.latitude, longitude: projects.longitude })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
        .limit(1);
      const site =
        project?.latitude != null && project?.longitude != null
          ? { latitude: project.latitude, longitude: project.longitude }
          : null;

      const assigned = await app.db
        .select({ equipmentId: equipmentAssignments.equipmentId })
        .from(equipmentAssignments)
        .where(
          and(
            eq(equipmentAssignments.companyId, companyId),
            eq(equipmentAssignments.projectId, projectId),
            inArray(equipmentAssignments.status, [...IN_SERVICE_ASSIGNMENT_STATUSES]),
          ),
        );
      const machineIds = [...new Set(assigned.map((a) => a.equipmentId))];
      if (machineIds.length === 0) {
        return {
          from,
          to,
          machines: [],
          reasons: ["no plant is assigned to this project, so there is no feed to read"],
        };
      }
      const fleet = await app.db
        .select()
        .from(equipment)
        .where(and(eq(equipment.companyId, companyId), inArray(equipment.id, machineIds)));
      const readings = await app.db
        .select()
        .from(equipmentTelematicsReadings)
        .where(
          and(
            eq(equipmentTelematicsReadings.companyId, companyId),
            inArray(equipmentTelematicsReadings.equipmentId, machineIds),
            gte(equipmentTelematicsReadings.recordedAt, `${from}T00:00:00.000Z`),
            lte(equipmentTelematicsReadings.recordedAt, `${to}T23:59:59.999Z`),
          ),
        );
      const fuelFills = await app.db
        .select()
        .from(equipmentReadings)
        .where(
          and(
            eq(equipmentReadings.companyId, companyId),
            inArray(equipmentReadings.equipmentId, machineIds),
            eq(equipmentReadings.readingType, "fuel_fill"),
            gte(equipmentReadings.readAt, `${from}T00:00:00.000Z`),
            lte(equipmentReadings.readAt, `${to}T23:59:59.999Z`),
          ),
        );

      const machines = fleet.map((machine) => {
        const own = readings.filter((r) => r.equipmentId === machine.id);
        const geofence = checkGeofence({
          site,
          ...(q.radiusMetres != null ? { radiusMetres: q.radiusMetres } : {}),
          readings: own
            .filter((r) => r.latitude !== null && r.longitude !== null)
            .map((r) => ({
              latitude: r.latitude as number,
              longitude: r.longitude as number,
              recordedAt: r.recordedAt,
              engineRunning: r.engineRunning,
            })),
        });
        const fuel = reconcileFuel({
          telematicsFuelUsedLitres: own.map((r) => r.fuelUsedLitres),
          fills: fuelFills
            .filter((f) => f.equipmentId === machine.id && (f.value ?? 0) > 0)
            .map((f) => ({ litres: f.value as number, at: f.readAt })),
        });
        const faults = assessFaults(
          own.flatMap((r) => (r.faultCodes as TelematicsFault[] | null) ?? []),
        );
        return {
          equipmentId: machine.id,
          reference: machine.reference,
          name: machine.name,
          readings: own.length,
          geofence,
          fuel,
          faults,
        };
      });

      return {
        from,
        to,
        site,
        machines,
        reasons: site
          ? []
          : [
              "this project records no location, so no machine can be tested against a site " +
                "boundary. Set the project's coordinates to make off-site use detectable.",
            ],
      };
    },
  );

  /* ================================================================ */
  /* SCHEDULED JOBS (plan §6.1)                                        */
  /* ================================================================ */

  app.scheduler.register({
    name: "equipment.sweep",
    description:
      "Expire equipment certificates, move maintenance schedules to due and overdue, and raise " +
      "the critical signal for statutory plant working out of certificate",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        await sweepEquipment(companyId, null);
        return { companyId };
      }),
  });

  app.scheduler.register({
    name: "equipment.materials-supply",
    description:
      "Long-lead items past their order-by date, forecast shortages inside the lead time, and " +
      "deliveries booked for a day that has passed",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) => forEachCompany(db, (companyId) => sweepMaterialSupply(companyId)),
  });
};
