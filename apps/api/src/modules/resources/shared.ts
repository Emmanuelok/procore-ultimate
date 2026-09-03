/**
 * Helpers shared by the resource routes and the scheduler sweeps: gates,
 * tenant-scoped fetchers, the ledger wrapper, calendar resolution and the
 * fingerprinted signal writer.
 *
 * One definition each, so a guard in a route and a guard in a sweep can never
 * disagree about what "active plan" means or raise the same finding twice
 * under two different keys.
 */
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import {
  budgetLineItems,
  crews,
  equipment,
  projectMemberships,
  projects,
  resourceAssignments,
  resourcePlans,
  resourceSkills,
  resourceTypes,
  scheduleCalendars,
  scheduleTasks,
  schedules,
  signals,
  workers,
} from "@constructos/db";
import type { LedgerAction } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { DEFAULT_WORK_PATTERN, type WorkPattern } from "./engines/calendar.js";
import type { PlannedLine } from "./engines/productivity.js";

export type ResourceTypeRow = typeof resourceTypes.$inferSelect;
export type ResourcePlanRow = typeof resourcePlans.$inferSelect;
export type ResourceAssignmentRow = typeof resourceAssignments.$inferSelect;
export type ResourceSkillRow = typeof resourceSkills.$inferSelect;

/** Ceiling on the activities read when deriving planned hours per budget line. */
export const MAX_SCHEDULE_TASKS = 50_000;

export const nowIso = (): string => new Date().toISOString();
export const todayIso = (now: Date = new Date()): string => now.toISOString().slice(0, 10);
export const pad3 = (n: number): string => String(n).padStart(3, "0");

/* ------------------------------------------------------------------ */
/* Request accessors                                                   */
/* ------------------------------------------------------------------ */

type ActorRequest = FastifyRequest & {
  companyId?: string;
  projectId?: string;
  user?: { id: string };
};

export const actorOf = (req: FastifyRequest): string => (req as ActorRequest).user!.id;
export const companyOf = (req: FastifyRequest): string => (req as ActorRequest).companyId!;
export const projectOf = (req: FastifyRequest): string => (req as ActorRequest).projectId!;

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export interface ResourceGates {
  read: preHandlerHookHandler[];
  standard: preHandlerHookHandler[];
  admin: preHandlerHookHandler[];
  /** company library routes: no project to resolve a tool level against */
  company: preHandlerHookHandler[];
  companyAdmin: preHandlerHookHandler[];
}

/**
 * `resources` is one tool key across plans, the calendar, productivity and
 * the skills matrix. Reading is `read`; planning, booking and recording is
 * `standard`; and exactly three operations are `admin` — activating a plan,
 * deleting a plan, and verifying a certification — because each of those
 * makes a record other people then rely on without re-checking.
 */
export function resourceGates(app: FastifyInstance): ResourceGates {
  return {
    read: [app.authenticate, app.requireCompany, app.requireTool("resources", "read")],
    standard: [app.authenticate, app.requireCompany, app.requireTool("resources", "standard")],
    admin: [app.authenticate, app.requireCompany, app.requireTool("resources", "admin")],
    company: [app.authenticate, app.requireCompany],
    companyAdmin: [
      app.authenticate,
      app.requireCompany,
      app.requireCompanyRole(["owner", "admin"]),
    ],
  };
}

export async function ledgerResources(
  db: Db,
  req: FastifyRequest,
  action: LedgerAction,
  objectType: string,
  objectId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const projectId = (req as ActorRequest).projectId ?? null;
  await appendLedger(db, {
    companyId: companyOf(req),
    actorId: actorOf(req),
    action,
    objectType,
    objectId,
    projectId,
    payload: projectId ? { projectId, ...payload } : payload,
  });
}

/* ------------------------------------------------------------------ */
/* Tenant-scoped fetchers                                              */
/* ------------------------------------------------------------------ */

export async function fetchResourceType(
  db: Db,
  id: string,
  companyId: string,
): Promise<ResourceTypeRow> {
  const rows = await db
    .select()
    .from(resourceTypes)
    .where(and(eq(resourceTypes.id, id), eq(resourceTypes.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Resource type not found in this company");
  return rows[0];
}

export async function fetchSkill(
  db: Db,
  id: string,
  companyId: string,
): Promise<ResourceSkillRow> {
  const rows = await db
    .select()
    .from(resourceSkills)
    .where(and(eq(resourceSkills.id, id), eq(resourceSkills.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Skill not found in this company");
  return rows[0];
}

export async function fetchPlan(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<ResourcePlanRow> {
  const rows = await db
    .select()
    .from(resourcePlans)
    .where(
      and(
        eq(resourcePlans.id, id),
        eq(resourcePlans.companyId, companyId),
        eq(resourcePlans.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Resource plan not found on this project");
  return rows[0];
}

export async function fetchAssignment(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<ResourceAssignmentRow> {
  const rows = await db
    .select()
    .from(resourceAssignments)
    .where(
      and(
        eq(resourceAssignments.id, id),
        eq(resourceAssignments.companyId, companyId),
        eq(resourceAssignments.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Resource assignment not found on this project");
  return rows[0];
}

/** Types usable on a project: the company library plus this project's own. */
export async function typesForProject(
  db: Db,
  companyId: string,
  projectId: string,
  options: { includeArchived?: boolean } = {},
): Promise<ResourceTypeRow[]> {
  const clauses = [
    eq(resourceTypes.companyId, companyId),
    or(isNull(resourceTypes.projectId), eq(resourceTypes.projectId, projectId))!,
  ];
  if (!options.includeArchived) clauses.push(eq(resourceTypes.status, "active"));
  return db.select().from(resourceTypes).where(and(...clauses)).orderBy(resourceTypes.code);
}

/**
 * A resource type named on a project route must be usable there: the company
 * library, or this project's own. A type belonging to another project is a
 * 400, not a silent no-op — a demand row filed against a type the histogram
 * does not draw is invisible.
 */
export async function requireTypeForProject(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<ResourceTypeRow> {
  const type = await fetchResourceType(db, id, companyId);
  if (type.projectId !== null && type.projectId !== projectId) {
    throw badRequest(
      `Resource type ${type.code} belongs to another project. Use a company-library type or one ` +
        "created on this project.",
    );
  }
  return type;
}

export async function requireProjectInCompany(
  db: Db,
  projectId: string,
  companyId: string,
): Promise<void> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Project not found in this company");
}

/* ------------------------------------------------------------------ */
/* The work calendar                                                   */
/* ------------------------------------------------------------------ */

/**
 * The project's work pattern, read from `schedule_calendars` where the
 * schedule module has one and falling back to Monday–Friday, 8 hours.
 *
 * The fallback is named in the response's reasons rather than hidden: a
 * histogram built on an assumed five-day week is wrong for a project on a
 * six-day rotation, and the reader has to be told which one they are looking
 * at.
 */
export async function workPatternFor(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<{ pattern: WorkPattern; source: string; isDefault: boolean }> {
  const rows = await db
    .select()
    .from(scheduleCalendars)
    .where(
      and(
        eq(scheduleCalendars.companyId, companyId),
        eq(scheduleCalendars.projectId, projectId),
      ),
    )
    .orderBy(desc(scheduleCalendars.isDefault))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      pattern: DEFAULT_WORK_PATTERN,
      source:
        "No work calendar is defined on this project, so a Monday–Friday, eight-hour week is " +
        "assumed. Define a schedule calendar to spread hours over the days actually worked.",
      isDefault: true,
    };
  }
  return {
    pattern: {
      workdays: row.workdays.length === 7 ? row.workdays : DEFAULT_WORK_PATTERN.workdays,
      holidays: row.holidays ?? [],
      exceptions: row.exceptions ?? [],
      hoursPerDay: row.hoursPerDay,
    },
    source: `Work calendar "${row.name}" (${row.hoursPerDay} h/day).`,
    isDefault: false,
  };
}

/** Working days in a standard week under a pattern (no holidays applied). */
export function standardWorkingDaysPerWeek(pattern: WorkPattern): number {
  return pattern.workdays.reduce((s, d) => s + (d === 1 ? 1 : 0), 0);
}

/* ------------------------------------------------------------------ */
/* Planned hours per budget line                                       */
/* ------------------------------------------------------------------ */

/**
 * The planned side of every productivity figure.
 *
 * Budget lines carry a quantity and a unit but no hours column, so planned
 * HOURS are derived, in this order, and the derivation is reported:
 *
 *   1. `budget_line_items.detail.budgetHours` — an explicit figure somebody
 *      typed against the line. Always wins.
 *   2. The sum of `schedule_tasks.budgetedHours` for the activities mapped to
 *      that line. This is the usual case on a resource-loaded programme.
 *   3. Nothing. The line then has no planned rate and its hours are reported
 *      as unearnable with the reason — never earned at a factor of 1.0.
 */
export async function plannedLinesFor(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<{ lines: PlannedLine[]; reasons: string[] }> {
  const lines = await db
    .select({
      id: budgetLineItems.id,
      costCode: budgetLineItems.costCode,
      description: budgetLineItems.description,
      unit: budgetLineItems.unit,
      quantity: budgetLineItems.quantity,
      detail: budgetLineItems.detail,
    })
    .from(budgetLineItems)
    .where(
      and(
        eq(budgetLineItems.companyId, companyId),
        eq(budgetLineItems.projectId, projectId),
      ),
    );

  const hoursByLine = new Map<string, number>();
  if (lines.length > 0) {
    const taskRows = await db
      .select({
        budgetLineItemId: scheduleTasks.budgetLineItemId,
        budgetedHours: scheduleTasks.budgetedHours,
      })
      .from(scheduleTasks)
      .where(eq(scheduleTasks.projectId, projectId))
      .limit(MAX_SCHEDULE_TASKS);
    for (const row of taskRows) {
      if (!row.budgetLineItemId || row.budgetedHours === null) continue;
      hoursByLine.set(
        row.budgetLineItemId,
        (hoursByLine.get(row.budgetLineItemId) ?? 0) + row.budgetedHours,
      );
    }
  }

  let fromDetail = 0;
  let fromSchedule = 0;
  let none = 0;
  const out: PlannedLine[] = lines.map((line) => {
    const explicit = line.detail?.["budgetHours"];
    let budgetHours: number | null = null;
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
      budgetHours = explicit;
      fromDetail += 1;
    } else {
      const derived = hoursByLine.get(line.id);
      if (derived !== undefined && derived > 0) {
        budgetHours = derived;
        fromSchedule += 1;
      } else {
        none += 1;
      }
    }
    return {
      id: line.id,
      code: line.costCode,
      description: line.description,
      budgetHours,
      budgetQuantity: line.quantity,
      unit: line.unit,
    };
  });

  const reasons: string[] = [];
  if (fromSchedule > 0) {
    reasons.push(
      `${fromSchedule} budget line(s) take their planned hours from the resource-loaded schedule ` +
        "activities mapped to them.",
    );
  }
  if (fromDetail > 0) {
    reasons.push(`${fromDetail} budget line(s) carry planned hours set directly on the line.`);
  }
  if (none > 0) {
    reasons.push(
      `${none} budget line(s) have no planned hours from either source, so hours booked to them ` +
        "cannot be earned and are reported as unmeasurable rather than as fully productive.",
    );
  }
  return { lines: out, reasons };
}

/* ------------------------------------------------------------------ */
/* Subject resolution for assignments                                  */
/* ------------------------------------------------------------------ */

export interface ResolvedSubject {
  subjectKind: "crew" | "worker" | "equipment";
  subjectId: string;
  subjectLabel: string;
}

/**
 * Resolve the crew, worker or machine an assignment books, checking it
 * belongs to this tenant and project. Equipment may be company fleet
 * (`projectId` null) because plant is booked to a project by being assigned;
 * crews and workers are project-scoped registers.
 */
export async function resolveSubject(
  db: Db,
  input: { crewId?: string | null; workerId?: string | null; equipmentId?: string | null },
  companyId: string,
  projectId: string,
): Promise<ResolvedSubject> {
  const named = [
    input.crewId ? "crewId" : null,
    input.workerId ? "workerId" : null,
    input.equipmentId ? "equipmentId" : null,
  ].filter((x): x is string => x !== null);
  if (named.length !== 1) {
    throw badRequest(
      `An assignment books exactly one resource — set exactly one of crewId, workerId or ` +
        `equipmentId (received ${named.length === 0 ? "none" : named.join(", ")}). A booking ` +
        "nobody can attribute to a resource cannot conflict with anything, which makes it " +
        "invisible exactly when it matters.",
    );
  }

  if (input.crewId) {
    const rows = await db
      .select({ id: crews.id, reference: crews.reference, name: crews.name })
      .from(crews)
      .where(
        and(
          eq(crews.id, input.crewId),
          eq(crews.companyId, companyId),
          eq(crews.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest(`crewId ${input.crewId} is not a crew on this project.`);
    return {
      subjectKind: "crew",
      subjectId: rows[0].id,
      subjectLabel: `${rows[0].reference} ${rows[0].name}`,
    };
  }
  if (input.workerId) {
    const rows = await db
      .select({ id: workers.id, reference: workers.reference, fullName: workers.fullName })
      .from(workers)
      .where(
        and(
          eq(workers.id, input.workerId),
          eq(workers.companyId, companyId),
          eq(workers.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw badRequest(
        `workerId ${input.workerId} is not on this project's worker register. Bookings name people ` +
          "who are already enrolled there — this module keeps no second person table.",
      );
    }
    return {
      subjectKind: "worker",
      subjectId: rows[0].id,
      subjectLabel: `${rows[0].reference} ${rows[0].fullName}`,
    };
  }

  const rows = await db
    .select({
      id: equipment.id,
      reference: equipment.reference,
      name: equipment.name,
      projectId: equipment.projectId,
    })
    .from(equipment)
    .where(and(eq(equipment.id, input.equipmentId!), eq(equipment.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`equipmentId ${input.equipmentId} is not in this company's fleet.`);
  if (rows[0].projectId !== null && rows[0].projectId !== projectId) {
    throw badRequest(
      `${rows[0].reference} is currently assigned to another project. Move it in the equipment ` +
        "module before booking it here.",
    );
  }
  return {
    subjectKind: "equipment",
    subjectId: rows[0].id,
    subjectLabel: `${rows[0].reference} ${rows[0].name}`,
  };
}

/** The schedule activity an assignment or demand row points at, if any. */
export async function requireScheduleTask(
  db: Db,
  taskId: string,
  projectId: string,
): Promise<{ id: string; name: string; scheduleId: string }> {
  const rows = await db
    .select({ id: scheduleTasks.id, name: scheduleTasks.name, scheduleId: scheduleTasks.scheduleId })
    .from(scheduleTasks)
    .where(and(eq(scheduleTasks.id, taskId), eq(scheduleTasks.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw badRequest(`scheduleTaskId ${taskId} is not an activity on this project.`);
  return rows[0];
}

/** The project's active schedule, or the one named. */
export async function resolveSchedule(
  db: Db,
  projectId: string,
  scheduleId?: string | null,
): Promise<{ id: string; name: string } | null> {
  if (scheduleId) {
    const rows = await db
      .select({ id: schedules.id, name: schedules.name })
      .from(schedules)
      .where(and(eq(schedules.id, scheduleId), eq(schedules.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw badRequest(`scheduleId ${scheduleId} is not a schedule on this project.`);
    return rows[0];
  }
  const rows = await db
    .select({ id: schedules.id, name: schedules.name })
    .from(schedules)
    .where(and(eq(schedules.projectId, projectId), eq(schedules.isActive, 1)))
    .orderBy(desc(schedules.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

/** Dispositions the assurance module treats as still open. */
export const OPEN_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"] as const;

export interface ResourceSignal {
  detector: string;
  fingerprint: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: number;
  title: string;
  explanation: string;
  subjectType: string;
  subjectId: string;
  evidenceRefs?: unknown;
}

/**
 * Raise a finding once. Re-running a sweep over unchanged data must not
 * manufacture a second signal: the fingerprint identifies the FINDING, and a
 * repeat observation refreshes `lastSeenAt` and bumps `occurrences` instead
 * of inserting. False-positive fatigue is what switches a control off.
 */
export async function raiseSignal(
  db: Db,
  companyId: string,
  projectId: string,
  input: ResourceSignal,
  now: Date,
): Promise<"created" | "refreshed"> {
  const at = now.toISOString();
  const existing = await db
    .select({ id: signals.id, occurrences: signals.occurrences })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.detector, input.detector),
        eq(signals.fingerprint, input.fingerprint),
        inArray(signals.disposition, [...OPEN_DISPOSITIONS]),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(signals)
      .set({
        lastSeenAt: at,
        occurrences: existing[0].occurrences + 1,
        severity: input.severity,
        explanation: input.explanation,
      })
      .where(eq(signals.id, existing[0].id));
    return "refreshed";
  }
  await db.insert(signals).values({
    id: newId("sig"),
    companyId,
    projectId,
    detector: input.detector,
    severity: input.severity,
    confidence: input.confidence,
    title: input.title,
    explanation: input.explanation,
    evidenceRefs: input.evidenceRefs ?? null,
    disposition: "new",
    fingerprint: input.fingerprint,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    firstSeenAt: at,
    lastSeenAt: at,
    occurrences: 1,
  });
  return "created";
}

/** Close every open signal of a detector whose condition has cleared. */
export async function closeSignals(
  db: Db,
  companyId: string,
  detector: string,
  fingerprints: string[],
  now: Date,
): Promise<number> {
  if (fingerprints.length === 0) return 0;
  const at = now.toISOString();
  const rows = await db
    .update(signals)
    .set({ disposition: "dismissed", autoClosedAt: at, closedAt: at })
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.detector, detector),
        inArray(signals.fingerprint, fingerprints),
        inArray(signals.disposition, [...OPEN_DISPOSITIONS]),
      ),
    )
    .returning({ id: signals.id });
  return rows.length;
}

/** Open findings this module raised, for a project or a company. */
export async function openResourceSignals(
  db: Db,
  companyId: string,
  detectors: readonly string[],
  projectId?: string,
) {
  const clauses = [
    eq(signals.companyId, companyId),
    inArray(signals.detector, [...detectors]),
    inArray(signals.disposition, [...OPEN_DISPOSITIONS]),
  ];
  if (projectId) clauses.push(eq(signals.projectId, projectId));
  return db
    .select({
      id: signals.id,
      projectId: signals.projectId,
      detector: signals.detector,
      severity: signals.severity,
      confidence: signals.confidence,
      title: signals.title,
      explanation: signals.explanation,
      disposition: signals.disposition,
      subjectType: signals.subjectType,
      subjectId: signals.subjectId,
      occurrences: signals.occurrences,
      createdAt: signals.createdAt,
      lastSeenAt: signals.lastSeenAt,
    })
    .from(signals)
    .where(and(...clauses))
    .orderBy(desc(signals.createdAt))
    .limit(200);
}

/* ------------------------------------------------------------------ */
/* Notification recipients                                             */
/* ------------------------------------------------------------------ */

/**
 * Who hears about a resourcing finding on a project: its members.
 *
 * Deliberately not "everyone in the company" — a resourcing clash on one job
 * is noise to everybody on the other forty, and noise is what teaches people
 * to ignore the notification centre. Preferences and muting are applied
 * downstream by `pushNotifications`.
 */
export async function projectMemberIds(
  db: Db,
  companyId: string,
  projectId: string,
  limit = 100,
): Promise<string[]> {
  const rows = await db
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.companyId, companyId),
        eq(projectMemberships.projectId, projectId),
      ),
    )
    .limit(limit);
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * The projects a caller may see in a company-wide list of project findings.
 *
 * Owners and admins see the portfolio; everybody else sees the projects they
 * are a member of. Without this a bare company gate on a cross-project list
 * hands every resourcing problem on every job to every user in the tenant.
 */
export async function visibleProjectIds(
  db: Db,
  req: FastifyRequest,
): Promise<Set<string> | "all"> {
  const companyId = companyOf(req);
  const userId = actorOf(req);
  const role = (req as FastifyRequest & { companyRole?: string }).companyRole;
  if (role === "owner" || role === "admin") return "all";
  const rows = await db
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.companyId, companyId),
        eq(projectMemberships.userId, userId),
      ),
    )
    .limit(1000);
  return new Set(rows.map((r) => r.projectId));
}
