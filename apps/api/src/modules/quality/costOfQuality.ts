/**
 * The cost of quality (#1099) and first-time-right by trade (#1100).
 *
 * The PAF model, and the reason it is worth the trouble: PREVENTION and
 * APPRAISAL are what a quality system costs, INTERNAL FAILURE is what it saves
 * you from, and EXTERNAL FAILURE is what it failed to save you from. The ratio
 * between the last two is the only quality metric a board understands, because
 * a defect found at inspection and the same defect found by the client after
 * handover are the same mistake at ten times the price.
 *
 * Two honesty rules run through the whole file and are not negotiable:
 *
 *  - MONEY IS NEVER SUMMED ACROSS CURRENCIES. Every bucket returns one figure
 *    per currency, with the record counts behind it.
 *  - AN UNMEASURED COST IS NOT ZERO. Prevention and appraisal activity is
 *    counted, not costed, because this platform does not hold the hours an
 *    inspector spent; reporting them as £0 would make the ratio flattering and
 *    false. Where a bucket has no money it says so in words.
 *
 * Pure and deterministic.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export interface ReworkLike {
  id: string;
  totalCost: number | null;
  currency: string;
  causeCategory: string;
  discoveryPhase: string;
  status: string;
  trade: string | null;
  responsibleVendorId: string | null;
  labourHours: number | null;
}

export interface NcrCostLike {
  id: string;
  costImpact: number | null;
  currency: string;
  status: string;
}

export interface DlpDefectCostLike {
  id: string;
  cost: number | null;
  currency: string;
}

export interface ActivityCounts {
  /** prevention: the plans and forms that exist before the work does */
  approvedItps: number;
  approvedTemplates: number;
  trainingSessions: number;
  /** appraisal: the acts of looking */
  completedChecklists: number;
  commissioningTests: number;
  ndtExaminations: number;
  concreteSpecimens: number;
  qualityAudits: number;
}

export interface CurrencyAmount {
  currency: string;
  amount: number;
  recordCount: number;
}

export interface CoqBucket {
  bucket: "prevention" | "appraisal" | "internal_failure" | "external_failure";
  label: string;
  /** money actually held, one figure per currency — never summed across them */
  money: CurrencyAmount[];
  /** records in the bucket, and how many of them carry a cost at all */
  recordCount: number;
  costedRecordCount: number;
  activityCount: number;
  reasons: string[];
}

export interface CostOfQuality {
  buckets: CoqBucket[];
  /** failure money per currency, internal and external side by side */
  failureByCurrency: Array<{
    currency: string;
    internal: number;
    external: number;
    total: number;
    externalShare: number | null;
  }>;
  reasons: string[];
}

/** Phases at which a failure is caught before the owner has it. */
const INTERNAL_PHASES = new Set(["during_works", "at_inspection", "at_commissioning"]);

function accumulate(
  rows: Array<{ amount: number | null; currency: string }>,
): { money: CurrencyAmount[]; costed: number } {
  const byCurrency = new Map<string, { amount: number; recordCount: number }>();
  let costed = 0;
  for (const row of rows) {
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) continue;
    costed += 1;
    const key = row.currency || "USD";
    const bucket = byCurrency.get(key) ?? { amount: 0, recordCount: 0 };
    bucket.amount += row.amount;
    bucket.recordCount += 1;
    byCurrency.set(key, bucket);
  }
  return {
    money: [...byCurrency.entries()]
      .map(([currency, v]) => ({ currency, amount: round2(v.amount), recordCount: v.recordCount }))
      .sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    costed,
  };
}

/**
 * Assemble the four buckets from what the platform actually holds.
 *
 * NCR cost impacts count as failure cost only where the NCR carries one, and
 * they are attributed to internal failure unless the NCR is linked to a rework
 * item that says otherwise — the rework register is the more specific record
 * and wins where both exist.
 */
export function costOfQuality(input: {
  rework: ReworkLike[];
  ncrs: NcrCostLike[];
  dlpDefects: DlpDefectCostLike[];
  activity: ActivityCounts;
}): CostOfQuality {
  const live = input.rework.filter((r) => r.status !== "cancelled");
  const internalRework = live.filter((r) => INTERNAL_PHASES.has(r.discoveryPhase));
  const externalRework = live.filter((r) => !INTERNAL_PHASES.has(r.discoveryPhase));

  const internal = accumulate([
    ...internalRework.map((r) => ({ amount: r.totalCost, currency: r.currency })),
    ...input.ncrs
      .filter((n) => n.status !== "void")
      .map((n) => ({ amount: n.costImpact, currency: n.currency })),
  ]);
  const external = accumulate([
    ...externalRework.map((r) => ({ amount: r.totalCost, currency: r.currency })),
    ...input.dlpDefects.map((d) => ({ amount: d.cost, currency: d.currency })),
  ]);

  const preventionActivity =
    input.activity.approvedItps + input.activity.approvedTemplates + input.activity.trainingSessions;
  const appraisalActivity =
    input.activity.completedChecklists +
    input.activity.commissioningTests +
    input.activity.ndtExaminations +
    input.activity.concreteSpecimens +
    input.activity.qualityAudits;

  const buckets: CoqBucket[] = [
    {
      bucket: "prevention",
      label: "Prevention — planning the quality in",
      money: [],
      recordCount: preventionActivity,
      costedRecordCount: 0,
      activityCount: preventionActivity,
      reasons: [
        `${input.activity.approvedItps} approved inspection and test plan(s), ${input.activity.approvedTemplates} issued checklist template(s) and ${input.activity.trainingSessions} training session(s).`,
        "No money is reported against prevention: this platform holds the activity but not the hours or the overhead behind it. Reporting it as zero would make the failure ratio flattering and false.",
      ],
    },
    {
      bucket: "appraisal",
      label: "Appraisal — the acts of looking",
      money: [],
      recordCount: appraisalActivity,
      costedRecordCount: 0,
      activityCount: appraisalActivity,
      reasons: [
        `${input.activity.completedChecklists} completed checklist(s), ${input.activity.commissioningTests} commissioning test(s), ${input.activity.ndtExaminations} NDT examination(s), ${input.activity.concreteSpecimens} concrete specimen(s) and ${input.activity.qualityAudits} audit(s).`,
        "Appraisal is counted rather than costed for the same reason as prevention: the inspection hours are not held here.",
      ],
    },
    {
      bucket: "internal_failure",
      label: "Internal failure — caught before the owner had it",
      money: internal.money,
      recordCount: internalRework.length + input.ncrs.filter((n) => n.status !== "void").length,
      costedRecordCount: internal.costed,
      activityCount: internalRework.length,
      reasons: [],
    },
    {
      bucket: "external_failure",
      label: "External failure — found after handover",
      money: external.money,
      recordCount: externalRework.length + input.dlpDefects.length,
      costedRecordCount: external.costed,
      activityCount: externalRework.length,
      reasons: [],
    },
  ];

  for (const bucket of buckets) {
    if (bucket.bucket !== "internal_failure" && bucket.bucket !== "external_failure") continue;
    if (bucket.recordCount === 0) {
      bucket.reasons.push(
        bucket.bucket === "internal_failure"
          ? "No rework item or NCR on this project records a failure caught before handover."
          : "No rework item or liability-period defect on this project records a failure found after handover.",
      );
    } else if (bucket.costedRecordCount === 0) {
      bucket.reasons.push(
        `${bucket.recordCount} record(s) are in this bucket and none carries a cost, so the money is unmeasured — not zero.`,
      );
    } else if (bucket.costedRecordCount < bucket.recordCount) {
      bucket.reasons.push(
        `${bucket.recordCount - bucket.costedRecordCount} of ${bucket.recordCount} record(s) carry no cost and are excluded, so the total is a floor rather than the figure.`,
      );
    }
    if (bucket.money.length > 1) {
      bucket.reasons.push(
        `Costs are held in ${bucket.money.length} currencies and are reported separately; a cross-currency total would be a made-up number.`,
      );
    }
  }

  const currencies = new Set<string>([
    ...internal.money.map((m) => m.currency),
    ...external.money.map((m) => m.currency),
  ]);
  const failureByCurrency = [...currencies].sort().map((currency) => {
    const i = internal.money.find((m) => m.currency === currency)?.amount ?? 0;
    const e = external.money.find((m) => m.currency === currency)?.amount ?? 0;
    const total = round2(i + e);
    return {
      currency,
      internal: round2(i),
      external: round2(e),
      total,
      externalShare: total > 0 ? round2((e / total) * 100) : null,
    };
  });

  const reasons: string[] = [];
  if (failureByCurrency.length === 0) {
    reasons.push(
      "No failure cost is recorded on this project in any currency. That is either a project with no measured rework or a project that is not recording it; the record counts beside each bucket say which.",
    );
  }
  return { buckets, failureByCurrency, reasons };
}

/* ------------------------------------------------------------------ */
/* First-time right (#1100)                                            */
/* ------------------------------------------------------------------ */

export interface ChecklistOutcomeLike {
  id: string;
  result: string | null;
  failedItemCount: number;
  criticalFailureCount: number;
  vendorId: string | null;
  category: string;
  detail?: Record<string, unknown>;
}

export interface FirstTimeRightRow {
  key: string;
  label: string;
  judged: number;
  right: number;
  failed: number;
  /** percentage, or null when nothing has been judged for this trade */
  rate: number | null;
  reasons: string[];
}

/**
 * The proportion of inspections a trade passed with nothing to put right.
 *
 * "Right" is computed from the record rather than from the verdict label: a
 * checklist with any failed item is not first-time right even if its overall
 * result was a pass with observations, because something had to be redone.
 * A trade with no judged checklists returns a null rate with the reason —
 * never 100%, which is what an unmeasured trade would otherwise look like.
 */
export function firstTimeRightByTrade(
  checklists: ChecklistOutcomeLike[],
  labels: Map<string, string> = new Map(),
): { rows: FirstTimeRightRow[]; overall: FirstTimeRightRow } {
  const groups = new Map<string, ChecklistOutcomeLike[]>();
  for (const c of checklists) {
    if (c.result === null) continue;
    const explicitTrade =
      typeof c.detail?.["trade"] === "string" ? (c.detail["trade"] as string) : null;
    const key = explicitTrade ?? c.vendorId ?? "__unattributed__";
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const rowFor = (key: string, label: string, rows: ChecklistOutcomeLike[]): FirstTimeRightRow => {
    const judged = rows.length;
    const right = rows.filter((c) => c.failedItemCount === 0 && c.result !== "fail").length;
    return {
      key,
      label,
      judged,
      right,
      failed: judged - right,
      rate: judged === 0 ? null : round2((right / judged) * 100),
      reasons:
        judged === 0
          ? [
              "No checklist attributed to this trade has been completed with a result, so its first-time-right rate is unmeasured rather than perfect.",
            ]
          : judged < 5
            ? [
                `Only ${judged} judged checklist(s) — the rate moves by ${round2(100 / judged)} points on a single record and should not be read as a trend yet.`,
              ]
            : [],
    };
  };
  const rows = [...groups.entries()]
    .map(([key, list]) =>
      rowFor(
        key,
        key === "__unattributed__"
          ? "Unattributed (no vendor on the checklist)"
          : (labels.get(key) ?? key),
        list,
      ),
    )
    .sort((a, b) => (a.rate ?? -1) - (b.rate ?? -1));
  const all = checklists.filter((c) => c.result !== null);
  return { rows, overall: rowFor("__all__", "All trades", all) };
}
