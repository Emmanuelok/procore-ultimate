/**
 * CONSULTANT DELIVERABLE SLIPPAGE ENGINE (spec #254, #887, #909) — pure, no I/O.
 *
 * A deliverable is late against the date it was promised, and at risk when
 * the date it is now forecast for is past that promise — or when the task it
 * feeds starts before the information can possibly arrive. The verdict always
 * carries its reasons, because "AMBER" with no explanation is the reason
 * design programmes are not believed.
 *
 * What it deliberately does not do: read the database, decide who is at
 * fault, or invent a forecast when the consultant has not given one.
 */
import type { DesignSlippageLevel } from "@constructos/shared";

export interface DeliverableAssessmentInput {
  status: string;
  plannedIssueDate: string | null;
  forecastIssueDate: string | null;
  actualIssueDate: string | null;
  acceptedAt: string | null;
  /** the date the information is needed on site, if one is set */
  requiredOnSite: string | null;
  /** start of the construction task this deliverable feeds */
  taskStartDate: string | null;
  /** days of lead time construction needs after issue before the task starts */
  leadDays?: number;
  /** how many days before the planned date counts as "at risk" */
  warnDays?: number;
}

export interface DeliverableAssessment {
  level: DesignSlippageLevel;
  /** positive = days late against the planned date; negative = days early */
  slippageDays: number | null;
  /** the date the assessment compared against, and where it came from */
  comparedAgainst: string | null;
  basis: string;
  reasons: string[];
  /** true when issuing on the forecast date leaves the task with no lead time */
  blocksTask: boolean;
}

const DEFAULT_WARN_DAYS = 7;
const DEFAULT_LEAD_DAYS = 0;

const day = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
};
const diffDays = (from: number, to: number): number => Math.round((to - from) / 86_400_000);

/**
 * The verdict on one deliverable as of `asOf` (ISO date).
 *
 * Precedence:
 *   accepted/issued → delivered (with the lateness it was delivered at)
 *   cancelled       → not assessable
 *   no planned date → not assessable, with the reason
 *   planned < today and not issued → late
 *   forecast > planned, or planned within warnDays, or task lead breached → at risk
 *   otherwise       → on track
 */
export function assessDeliverable(
  input: DeliverableAssessmentInput,
  asOfISO: string,
): DeliverableAssessment {
  const reasons: string[] = [];
  const warnDays = input.warnDays ?? DEFAULT_WARN_DAYS;
  const leadDays = input.leadDays ?? DEFAULT_LEAD_DAYS;
  const asOf = day(asOfISO);
  const planned = day(input.plannedIssueDate);
  const forecast = day(input.forecastIssueDate);
  const actual = day(input.actualIssueDate);
  const taskStart = day(input.taskStartDate);
  const requiredOnSite = day(input.requiredOnSite);

  if (input.status === "cancelled") {
    return {
      level: "not_assessable",
      slippageDays: null,
      comparedAgainst: input.plannedIssueDate,
      basis: "The deliverable is cancelled.",
      reasons: ["Cancelled deliverables are not assessed for slippage."],
      blocksTask: false,
    };
  }

  // Already issued or accepted: the record is closed, but the lateness stands.
  if (actual !== null) {
    const slippage = planned !== null ? diffDays(planned, actual) : null;
    if (slippage === null) {
      reasons.push("Issued, but no planned issue date was ever recorded, so lateness cannot be measured.");
    } else if (slippage > 0) {
      reasons.push(`Issued ${slippage} day${slippage === 1 ? "" : "s"} after the planned date.`);
    } else if (slippage < 0) {
      reasons.push(`Issued ${-slippage} day${slippage === -1 ? "" : "s"} before the planned date.`);
    } else {
      reasons.push("Issued on the planned date.");
    }
    if (input.acceptedAt === null && input.status !== "rejected") {
      reasons.push("Issued but not yet accepted by the reviewer.");
    }
    return {
      level: "delivered",
      slippageDays: slippage,
      comparedAgainst: input.plannedIssueDate,
      basis: "Actual issue date against the planned issue date.",
      reasons,
      blocksTask: false,
    };
  }

  if (planned === null) {
    reasons.push("No planned issue date is set, so slippage cannot be computed.");
    if (forecast !== null) reasons.push("A forecast date exists but there is nothing to compare it against.");
    return {
      level: "not_assessable",
      slippageDays: null,
      comparedAgainst: null,
      basis: "No planned issue date.",
      reasons,
      blocksTask: false,
    };
  }

  if (asOf === null) {
    return {
      level: "not_assessable",
      slippageDays: null,
      comparedAgainst: input.plannedIssueDate,
      basis: "The as-of date could not be read.",
      reasons: ["The as-of date could not be parsed."],
      blocksTask: false,
    };
  }

  // The date we now believe: the consultant's forecast, else today when the
  // planned date has already passed, else the planned date itself.
  const believed = forecast ?? (planned < asOf ? asOf : planned);
  const believedSource = forecast !== null ? "the consultant's forecast" : planned < asOf ? "today (the planned date has passed with nothing issued)" : "the planned date";

  const slippage = diffDays(planned, believed);
  let blocksTask = false;

  if (taskStart !== null) {
    const latestUseful = taskStart - leadDays * 86_400_000;
    if (believed > latestUseful) {
      blocksTask = true;
      const over = diffDays(latestUseful, believed);
      reasons.push(
        `The construction task it feeds needs the information ${leadDays > 0 ? `${leadDays} day${leadDays === 1 ? "" : "s"} before it starts` : "by its start date"}; on ${believedSource} it arrives ${over} day${over === 1 ? "" : "s"} too late.`,
      );
    }
  }
  if (requiredOnSite !== null && believed > requiredOnSite) {
    const over = diffDays(requiredOnSite, believed);
    reasons.push(`It is required on site by ${input.requiredOnSite} and is now expected ${over} day${over === 1 ? "" : "s"} after that.`);
  }

  let level: DesignSlippageLevel;
  if (planned < asOf) {
    level = "late";
    const overdue = diffDays(planned, asOf);
    reasons.unshift(`Planned for ${input.plannedIssueDate} and not issued — ${overdue} day${overdue === 1 ? "" : "s"} overdue.`);
  } else if (slippage > 0) {
    level = "at_risk";
    reasons.unshift(`The forecast issue date is ${slippage} day${slippage === 1 ? "" : "s"} after the planned date.`);
  } else if (blocksTask) {
    level = "at_risk";
  } else if (diffDays(asOf, planned) <= warnDays) {
    level = "at_risk";
    reasons.unshift(`Due in ${diffDays(asOf, planned)} day${diffDays(asOf, planned) === 1 ? "" : "s"} and not yet issued.`);
  } else {
    level = "on_track";
    reasons.unshift(`Planned for ${input.plannedIssueDate}, ${diffDays(asOf, planned)} days away, with no forecast slip.`);
  }

  return {
    level,
    slippageDays: slippage,
    comparedAgainst: input.plannedIssueDate,
    basis: `Expected issue taken from ${believedSource}, compared with the planned issue date.`,
    reasons,
    blocksTask,
  };
}

/* ------------------------------------------------------------------ */
/* Register-level analytics                                            */
/* ------------------------------------------------------------------ */

export interface SlippageRow {
  id: string;
  consultantId: string | null;
  discipline: string;
  packageId: string | null;
  status: string;
  slippageLevel: string;
  slippageDays: number | null;
  plannedIssueDate: string | null;
  actualIssueDate: string | null;
}

export interface SlippageStats {
  total: number;
  byLevel: Record<string, number>;
  issued: number;
  issuedOnTime: number;
  issuedLate: number;
  onTimePercent: number | null;
  averageSlippageDays: number | null;
  worstSlippageDays: number | null;
  outstandingLate: number;
  reasons: string[];
}

export function slippageStats(rows: readonly SlippageRow[]): SlippageStats {
  const reasons: string[] = [];
  const byLevel: Record<string, number> = {};
  for (const row of rows) byLevel[row.slippageLevel] = (byLevel[row.slippageLevel] ?? 0) + 1;

  const issued = rows.filter((r) => r.actualIssueDate !== null);
  const measurable = issued.filter((r) => r.slippageDays !== null);
  const onTime = measurable.filter((r) => (r.slippageDays ?? 0) <= 0).length;
  const late = measurable.length - onTime;

  if (issued.length === 0) reasons.push("Nothing has been issued yet, so issue performance is not available.");
  else if (measurable.length < issued.length) {
    reasons.push(
      `${issued.length - measurable.length} issued deliverable(s) had no planned date and are excluded from the on-time figure.`,
    );
  }

  const values = measurable.map((r) => r.slippageDays ?? 0);
  const average = values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  const worst = values.length === 0 ? null : Math.max(...values);

  return {
    total: rows.length,
    byLevel,
    issued: issued.length,
    issuedOnTime: onTime,
    issuedLate: late,
    onTimePercent: measurable.length === 0 ? null : Math.round((onTime / measurable.length) * 1000) / 10,
    averageSlippageDays: average,
    worstSlippageDays: worst,
    outstandingLate: rows.filter((r) => r.slippageLevel === "late").length,
    reasons,
  };
}

/** Slippage grouped by consultant, so the register can name who is late. */
export function slippageByConsultant(
  rows: readonly SlippageRow[],
): Array<{ consultantId: string | null; total: number; late: number; atRisk: number; issued: number; averageSlippageDays: number | null }> {
  const groups = new Map<string, SlippageRow[]>();
  for (const row of rows) {
    const key = row.consultantId ?? "";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const measurable = list.filter((r) => r.actualIssueDate !== null && r.slippageDays !== null).map((r) => r.slippageDays ?? 0);
      return {
        consultantId: key === "" ? null : key,
        total: list.length,
        late: list.filter((r) => r.slippageLevel === "late").length,
        atRisk: list.filter((r) => r.slippageLevel === "at_risk").length,
        issued: list.filter((r) => r.actualIssueDate !== null).length,
        averageSlippageDays:
          measurable.length === 0 ? null : Math.round((measurable.reduce((a, b) => a + b, 0) / measurable.length) * 10) / 10,
      };
    })
    .sort((a, b) => b.late - a.late || b.atRisk - a.atRisk);
}
