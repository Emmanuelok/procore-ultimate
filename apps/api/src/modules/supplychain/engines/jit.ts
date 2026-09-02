/**
 * JUST-IN-TIME ENGINE (spec #919, #930; Vol I #727–728).
 *
 * Tests every delivery-bearing record against the schedule task it feeds:
 *
 *  - a booked delivery that lands AFTER the task starts
 *  - a long-lead item whose expected arrival is after the task starts
 *  - a delivery booked far too EARLY (double handling, laydown, damage)
 *  - an offsite unit not passed QA / delivered before its install task starts
 *  - a task starting within `lookaheadDays` with material linked but NO slot booked
 *
 * Pure: inputs are plain rows and a date; outputs carry a stable `key` so
 * the sweep that raises signals from them is idempotent.
 */
import type { JitConflictKind } from "@constructos/shared";
import { daysBetween } from "./dates.js";

export interface JitTask {
  id: string;
  name: string;
  startDate: string | null;
  actualStart: string | null;
  isCritical: boolean;
}

export interface JitSlot {
  id: string;
  reference: string;
  scheduleTaskId: string | null;
  longLeadItemId: string | null;
  offsiteUnitId: string | null;
  startsAt: string;
  status: string;
}

export interface JitItem {
  id: string;
  reference: string;
  name: string;
  scheduleTaskId: string | null;
  expectedOnSite: string | null;
  status: string;
}

export interface JitUnit {
  id: string;
  reference: string;
  name: string;
  scheduleTaskId: string | null;
  status: string;
  plannedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
}

export interface JitConflict {
  kind: JitConflictKind;
  severity: "low" | "medium" | "high" | "critical";
  key: string;
  taskId: string;
  taskName: string;
  sourceType: "delivery_slot" | "long_lead_item" | "offsite_unit" | "schedule_task";
  sourceId: string;
  sourceRef: string;
  title: string;
  explanation: string;
  daysDelta: number | null;
}

export interface JitInput {
  tasks: JitTask[];
  slots: JitSlot[];
  items: JitItem[];
  units: JitUnit[];
  today: string;
  /** deliveries this many days before a task start are "too early"; default 21 */
  tooEarlyDays?: number;
  /** tasks starting within this window with linked material and no slot are flagged; default 10 */
  lookaheadDays?: number;
}

const UNIT_READY: ReadonlySet<string> = new Set(["delivered", "installed"]);
const CLOSED_ITEM: ReadonlySet<string> = new Set(["installed", "cancelled", "arrived"]);
const LIVE_SLOT: ReadonlySet<string> = new Set(["requested", "confirmed", "arrived", "unloading", "completed"]);

function taskStart(t: JitTask): string | null {
  return t.actualStart ?? t.startDate;
}

export function detectJitConflicts(input: JitInput): JitConflict[] {
  const tooEarly = input.tooEarlyDays ?? 21;
  const lookahead = input.lookaheadDays ?? 10;
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const out: JitConflict[] = [];
  const sev = (task: JitTask, base: JitConflict["severity"]): JitConflict["severity"] => {
    if (!task.isCritical) return base;
    if (base === "high") return "critical";
    if (base === "medium") return "high";
    return base;
  };

  /* deliveries vs task start */
  for (const slot of input.slots) {
    if (!slot.scheduleTaskId || !LIVE_SLOT.has(slot.status)) continue;
    const task = taskById.get(slot.scheduleTaskId);
    if (!task) continue;
    const start = taskStart(task);
    if (!start) continue;
    const delta = daysBetween(start, slot.startsAt.slice(0, 10));
    if (delta === null) continue;
    if (delta > 0 && !task.actualStart) {
      out.push({
        kind: "arrives_after_task_start",
        severity: sev(task, "high"),
        key: `jit:slot:${slot.id}:after`,
        taskId: task.id,
        taskName: task.name,
        sourceType: "delivery_slot",
        sourceId: slot.id,
        sourceRef: slot.reference,
        title: `${slot.reference} is booked ${delta} day(s) after ${task.name} starts`,
        explanation: `Delivery ${slot.reference} is booked for ${slot.startsAt.slice(0, 10)}; task "${task.name}" is planned to start ${start}. The crew will be waiting on the material.`,
        daysDelta: delta,
      });
    } else if (delta < -tooEarly) {
      out.push({
        kind: "arrives_too_early",
        severity: "low",
        key: `jit:slot:${slot.id}:early`,
        taskId: task.id,
        taskName: task.name,
        sourceType: "delivery_slot",
        sourceId: slot.id,
        sourceRef: slot.reference,
        title: `${slot.reference} lands ${-delta} day(s) before ${task.name} needs it`,
        explanation: `Delivery ${slot.startsAt.slice(0, 10)} against a task start of ${start}: more than ${tooEarly} days of laydown, double handling and exposure to damage or theft.`,
        daysDelta: delta,
      });
    }
  }

  /* long-lead items vs task start */
  for (const item of input.items) {
    if (!item.scheduleTaskId || CLOSED_ITEM.has(item.status) || !item.expectedOnSite) continue;
    const task = taskById.get(item.scheduleTaskId);
    if (!task) continue;
    const start = taskStart(task);
    if (!start) continue;
    const delta = daysBetween(start, item.expectedOnSite);
    if (delta !== null && delta > 0) {
      out.push({
        kind: "forecast_after_task_start",
        severity: sev(task, "medium"),
        key: `jit:item:${item.id}:forecast`,
        taskId: task.id,
        taskName: task.name,
        sourceType: "long_lead_item",
        sourceId: item.id,
        sourceRef: item.reference,
        title: `${item.reference} ${item.name} expected ${delta} day(s) after ${task.name} starts`,
        explanation: `Expected on site ${item.expectedOnSite}; task start ${start}.`,
        daysDelta: delta,
      });
    }
  }

  /* offsite units vs install task */
  for (const unit of input.units) {
    if (!unit.scheduleTaskId || UNIT_READY.has(unit.status) || unit.status === "rejected") continue;
    const task = taskById.get(unit.scheduleTaskId);
    if (!task) continue;
    const start = taskStart(task);
    if (!start) continue;
    const daysToStart = daysBetween(input.today, start);
    const planned = unit.plannedDeliveryDate ? daysBetween(start, unit.plannedDeliveryDate) : null;
    if ((daysToStart !== null && daysToStart <= 7) || (planned !== null && planned > 0)) {
      out.push({
        kind: "unit_not_ready_for_install",
        severity: sev(task, planned !== null && planned > 0 ? "high" : "medium"),
        key: `jit:unit:${unit.id}:notready`,
        taskId: task.id,
        taskName: task.name,
        sourceType: "offsite_unit",
        sourceId: unit.id,
        sourceRef: unit.reference,
        title: `${unit.reference} ${unit.name} is ${unit.status.replace(/_/g, " ")} with ${task.name} ${daysToStart !== null && daysToStart >= 0 ? `starting in ${daysToStart} day(s)` : "already started"}`,
        explanation:
          planned !== null && planned > 0
            ? `Planned delivery ${unit.plannedDeliveryDate} is ${planned} day(s) after the install task start ${start}.`
            : `Install task starts ${start}; the unit has not been delivered.`,
        daysDelta: planned ?? daysToStart,
      });
    }
  }

  /* tasks with linked material and no delivery booked in the lookahead */
  const slotsByTask = new Map<string, JitSlot[]>();
  for (const s of input.slots) {
    if (!s.scheduleTaskId || !LIVE_SLOT.has(s.status)) continue;
    const list = slotsByTask.get(s.scheduleTaskId) ?? [];
    list.push(s);
    slotsByTask.set(s.scheduleTaskId, list);
  }
  const itemsByTask = new Map<string, JitItem[]>();
  for (const i of input.items) {
    if (!i.scheduleTaskId || CLOSED_ITEM.has(i.status)) continue;
    const list = itemsByTask.get(i.scheduleTaskId) ?? [];
    list.push(i);
    itemsByTask.set(i.scheduleTaskId, list);
  }
  for (const task of input.tasks) {
    const start = taskStart(task);
    if (!start || task.actualStart) continue;
    const daysToStart = daysBetween(input.today, start);
    if (daysToStart === null || daysToStart < 0 || daysToStart > lookahead) continue;
    const items = itemsByTask.get(task.id) ?? [];
    if (items.length === 0) continue;
    if ((slotsByTask.get(task.id) ?? []).length > 0) continue;
    out.push({
      kind: "no_delivery_booked",
      severity: sev(task, "medium"),
      key: `jit:task:${task.id}:nobooking:${start}`,
      taskId: task.id,
      taskName: task.name,
      sourceType: "schedule_task",
      sourceId: task.id,
      sourceRef: task.name,
      title: `No delivery booked for ${task.name} starting in ${daysToStart} day(s)`,
      explanation: `${items.length} long-lead item(s) feed this task (${items.map((i) => i.reference).join(", ")}) and no delivery slot references it.`,
      daysDelta: daysToStart,
    });
  }

  return out.sort((a, b) => rank(b.severity) - rank(a.severity) || a.key.localeCompare(b.key));
}

function rank(s: JitConflict["severity"]): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[s];
}
