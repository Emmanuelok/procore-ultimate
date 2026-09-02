/**
 * Welding: qualification validity, joint compliance and NDT rollups
 * (#1087–1088).
 *
 * Three questions decide whether a weld is evidence or a liability, and all
 * three are arithmetic rather than opinion:
 *
 *  1. WAS THE WELDER QUALIFIED FOR THIS JOINT, on the day it was welded — for
 *     the process, the position, the material group and the thickness. A
 *     certificate that has expired, or whose continuity lapsed because the
 *     welder has not run that process for six months, does not qualify
 *     anything.
 *  2. WAS THE PROCEDURE APPROVED, and does the joint fall inside its range.
 *  3. WAS ENOUGH OF IT EXAMINED. A spec asking for 10% radiography of a class
 *     of joints is satisfied by examining 10% of THAT class, and the repair
 *     rate per welder is the number that decides whether the percentage goes
 *     up.
 *
 * Pure and deterministic: dates are compared as ISO strings against an `asOf`
 * the caller supplies. Every rate returns null with a reason when its
 * denominator is zero — a repair rate of 0% over no welds is not good news.
 */

import type { WelderQualificationStatus } from "@constructos/shared";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export interface WelderQualificationLike {
  id: string;
  welderName: string;
  welderStamp: string | null;
  processes: string[];
  positions: string[];
  materialGroups: string[];
  thicknessMinMm: number | null;
  thicknessMaxMm: number | null;
  diameterMinMm: number | null;
  diameterMaxMm: number | null;
  qualifiedFrom: string | null;
  expiryDate: string | null;
  continuityConfirmedAt: string | null;
  continuityMonths: number;
  status: string;
}

export interface WpsLike {
  id: string;
  wpsNumber: string;
  process: string;
  positions: string[];
  baseMaterialGroup: string | null;
  thicknessMinMm: number | null;
  thicknessMaxMm: number | null;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
}

export interface WeldLike {
  id: string;
  reference: string;
  status: string;
  weldedAt: string | null;
  thicknessMm: number | null;
  diameterMm: number | null;
  wpsId: string | null;
  welderQualificationId: string | null;
  ndtRequiredPercent: number | null;
  ndtRecordCount: number;
  ndtAcceptCount: number;
  ndtRejectCount: number;
  repairCount: number;
  jointType: string | null;
  detail?: Record<string, unknown>;
}

export interface NdtRecordLike {
  id: string;
  weldId: string;
  method: string;
  result: string;
  performedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** Add whole months to an ISO date, clamping the day into the target month. */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map((p) => Number(p));
  if (!y || !m || !d) return isoDate;
  const zeroBased = m - 1 + months;
  const year = y + Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/* ------------------------------------------------------------------ */
/* Qualification validity                                              */
/* ------------------------------------------------------------------ */

export interface QualificationStanding {
  status: WelderQualificationStatus;
  /** date the qualification lapses on continuity, when computable */
  continuityLapsesOn: string | null;
  expiresInDays: number | null;
  reasons: string[];
}

/**
 * Where a welder's qualification stands on `asOf`.
 *
 * Suspension and revocation are decisions and override arithmetic. Otherwise
 * the earliest of the certificate expiry and the continuity lapse governs:
 * both end the qualification, and only one of them is on the certificate.
 */
export function qualificationStanding(
  q: WelderQualificationLike,
  asOf: string,
  warnDays = 45,
): QualificationStanding {
  const reasons: string[] = [];
  if (q.status === "suspended" || q.status === "revoked") {
    return {
      status: q.status,
      continuityLapsesOn: null,
      expiresInDays: null,
      reasons: [`The qualification is recorded as ${q.status}; no weld may be attributed to it.`],
    };
  }
  const continuityLapsesOn = q.continuityConfirmedAt
    ? addMonths(q.continuityConfirmedAt, q.continuityMonths)
    : null;
  if (!q.continuityConfirmedAt) {
    reasons.push(
      "No continuity confirmation is recorded, so whether the welder has used this process within the continuity window cannot be shown. Most standards void the qualification on that ground alone.",
    );
  }
  const candidates: Array<{ date: string; why: string }> = [];
  if (q.expiryDate) candidates.push({ date: q.expiryDate, why: "the certificate expiry" });
  if (continuityLapsesOn) {
    candidates.push({
      date: continuityLapsesOn,
      why: `continuity (${q.continuityMonths} months from ${q.continuityConfirmedAt})`,
    });
  }
  if (candidates.length === 0) {
    reasons.push(
      "Neither an expiry date nor a continuity confirmation is held, so this qualification cannot be shown to be current.",
    );
    return { status: "expiring", continuityLapsesOn, expiresInDays: null, reasons };
  }
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const governing = candidates[0]!;
  const days = daysBetween(asOf, governing.date);
  if (days !== null && days < 0) {
    reasons.push(
      `Lapsed on ${governing.date} (${governing.why}), ${Math.abs(days)} day(s) ago. Welds made after that date are not covered by a valid qualification.`,
    );
    return { status: "expired", continuityLapsesOn, expiresInDays: days, reasons };
  }
  if (days !== null && days <= warnDays) {
    reasons.push(
      `Lapses on ${governing.date} (${governing.why}), in ${days} day(s). Re-qualify or confirm continuity before the joints being welded next month are attributed to it.`,
    );
    return { status: "expiring", continuityLapsesOn, expiresInDays: days, reasons };
  }
  return { status: "valid", continuityLapsesOn, expiresInDays: days, reasons };
}

/* ------------------------------------------------------------------ */
/* Joint compliance                                                    */
/* ------------------------------------------------------------------ */

export interface ComplianceCheck {
  name: string;
  passed: boolean | null;
  detail: string;
}

export interface WeldCompliance {
  compliant: boolean;
  checks: ComplianceCheck[];
  blockers: string[];
}

const withinRange = (
  value: number | null,
  min: number | null,
  max: number | null,
): boolean | null => {
  if (value === null) return null;
  if (min === null && max === null) return null;
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
};

/**
 * Does this joint stand up: procedure approved and in range, welder qualified
 * for the process and the thickness, and qualified ON THE DAY it was welded.
 */
export function weldCompliance(
  weld: WeldLike,
  wps: WpsLike | null,
  qualification: WelderQualificationLike | null,
  asOf: string,
): WeldCompliance {
  const checks: ComplianceCheck[] = [];
  const blockers: string[] = [];
  const weldDate = weld.weldedAt ?? asOf;

  if (!wps) {
    checks.push({
      name: "welding procedure",
      passed: false,
      detail: "No welding procedure specification is named on this joint.",
    });
    blockers.push(
      `${weld.reference} names no WPS. A joint welded to no written procedure cannot be shown to have been welded to the qualified one.`,
    );
  } else {
    const approved = wps.status === "approved";
    const inDate =
      (!wps.validFrom || wps.validFrom <= weldDate) &&
      (!wps.validUntil || wps.validUntil >= weldDate);
    checks.push({
      name: "welding procedure",
      passed: approved && inDate,
      detail: approved
        ? inDate
          ? `${wps.wpsNumber} is approved and in date on ${weldDate}.`
          : `${wps.wpsNumber} was not in date on ${weldDate} (valid ${wps.validFrom ?? "—"} to ${wps.validUntil ?? "—"}).`
        : `${wps.wpsNumber} is ${wps.status}, not approved.`,
    });
    if (!approved || !inDate) {
      blockers.push(
        `${weld.reference} was welded to ${wps.wpsNumber}, which was ${approved ? "out of date" : wps.status} at the time.`,
      );
    }
    const thicknessOk = withinRange(weld.thicknessMm, wps.thicknessMinMm, wps.thicknessMaxMm);
    checks.push({
      name: "thickness within the procedure range",
      passed: thicknessOk,
      detail:
        thicknessOk === null
          ? "Either the joint thickness or the procedure's qualified range is not recorded, so the range cannot be checked."
          : thicknessOk
            ? `${weld.thicknessMm} mm is inside [${wps.thicknessMinMm ?? "-"}, ${wps.thicknessMaxMm ?? "-"}] mm.`
            : `${weld.thicknessMm} mm is outside the procedure's qualified range [${wps.thicknessMinMm ?? "-"}, ${wps.thicknessMaxMm ?? "-"}] mm.`,
    });
    if (thicknessOk === false) {
      blockers.push(
        `${weld.reference} is ${weld.thicknessMm} mm, outside the thickness range ${wps.wpsNumber} is qualified for.`,
      );
    }
  }

  if (!qualification) {
    checks.push({
      name: "welder qualification",
      passed: false,
      detail: "No welder qualification is named on this joint.",
    });
    blockers.push(
      `${weld.reference} names no welder qualification, so the joint cannot be traced to a qualified welder — which is the one thing a weld map exists to do.`,
    );
  } else {
    const standing = qualificationStanding(qualification, weldDate);
    checks.push({
      name: "welder qualification current on the day",
      passed: standing.status === "valid" || standing.status === "expiring",
      detail:
        standing.status === "valid" || standing.status === "expiring"
          ? `${qualification.welderName} was qualified on ${weldDate}.`
          : `${qualification.welderName}'s qualification was ${standing.status} on ${weldDate}. ${standing.reasons.join(" ")}`,
    });
    if (standing.status === "expired" || standing.status === "suspended" || standing.status === "revoked") {
      blockers.push(
        `${weld.reference} was welded on ${weldDate} by ${qualification.welderName}, whose qualification was ${standing.status} then.`,
      );
    }
    if (wps) {
      const processOk =
        qualification.processes.length === 0 ? null : qualification.processes.includes(wps.process);
      checks.push({
        name: "welder qualified for the process",
        passed: processOk,
        detail:
          processOk === null
            ? "The qualification lists no processes, so the process cannot be checked against it."
            : processOk
              ? `${wps.process.toUpperCase()} is among the qualified processes.`
              : `${wps.process.toUpperCase()} is not among the qualified processes (${qualification.processes.join(", ")}).`,
      });
      if (processOk === false) {
        blockers.push(
          `${weld.reference} was welded by ${qualification.welderName} using ${wps.process.toUpperCase()}, which their qualification does not cover.`,
        );
      }
    }
    const thicknessOk = withinRange(
      weld.thicknessMm,
      qualification.thicknessMinMm,
      qualification.thicknessMaxMm,
    );
    checks.push({
      name: "thickness within the welder's qualified range",
      passed: thicknessOk,
      detail:
        thicknessOk === null
          ? "Either the joint thickness or the welder's qualified thickness range is not recorded."
          : thicknessOk
            ? `${weld.thicknessMm} mm is inside the welder's range.`
            : `${weld.thicknessMm} mm is outside the welder's qualified range [${qualification.thicknessMinMm ?? "-"}, ${qualification.thicknessMaxMm ?? "-"}] mm.`,
    });
    if (thicknessOk === false) {
      blockers.push(
        `${weld.reference} is outside the thickness range ${qualification.welderName} is qualified for.`,
      );
    }
  }

  return { compliant: blockers.length === 0, checks, blockers };
}

/* ------------------------------------------------------------------ */
/* NDT rollups                                                         */
/* ------------------------------------------------------------------ */

export interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
  reasons: string[];
}

const rate = (numerator: number, denominator: number, emptyReason: string): Rate =>
  denominator === 0
    ? { value: null, numerator, denominator, reasons: [emptyReason] }
    : { value: round2((numerator / denominator) * 100), numerator, denominator, reasons: [] };

export interface WeldProgramme {
  weldCount: number;
  weldedCount: number;
  examinedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  repairCount: number;
  /** examined joints as a percentage of welded joints */
  ndtCoverage: Rate;
  /** rejected examinations as a percentage of examinations */
  repairRate: Rate;
  /** joints whose examined percentage is short of the specified one */
  coverageShortfalls: Array<{ weldId: string; reference: string; required: number; achieved: number }>;
}

/**
 * The programme-level picture. `coverageShortfalls` is per joint rather than
 * per class because the platform is told the required percentage per joint;
 * where a project records it per class the same arithmetic holds, with the
 * class's joints sharing a required percentage.
 */
export function weldProgramme(welds: WeldLike[], ndt: NdtRecordLike[]): WeldProgramme {
  const ndtByWeld = new Map<string, NdtRecordLike[]>();
  for (const record of ndt) {
    const list = ndtByWeld.get(record.weldId) ?? [];
    list.push(record);
    ndtByWeld.set(record.weldId, list);
  }
  const welded = welds.filter((w) => w.status !== "planned" && w.status !== "fit_up");
  const examined = welded.filter((w) => (ndtByWeld.get(w.id) ?? []).length > 0);
  const examinations = ndt.filter((r) => r.result !== "pending");
  const rejected = examinations.filter((r) => r.result === "reject");
  const accepted = examinations.filter((r) => r.result === "accept");
  const coverageShortfalls: WeldProgramme["coverageShortfalls"] = [];
  for (const w of welded) {
    if (w.ndtRequiredPercent === null || w.ndtRequiredPercent <= 0) continue;
    const records = ndtByWeld.get(w.id) ?? [];
    const achieved = records.length > 0 ? 100 : 0;
    if (achieved < w.ndtRequiredPercent) {
      coverageShortfalls.push({
        weldId: w.id,
        reference: w.reference,
        required: w.ndtRequiredPercent,
        achieved,
      });
    }
  }
  return {
    weldCount: welds.length,
    weldedCount: welded.length,
    examinedCount: examined.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    repairCount: welds.reduce((n, w) => n + w.repairCount, 0),
    ndtCoverage: rate(
      examined.length,
      welded.length,
      "No joint on this project has been welded yet, so there is no coverage to report. A coverage of 0% over no welds would read as a failure to examine.",
    ),
    repairRate: rate(
      rejected.length,
      examinations.length,
      "No examination has returned a result yet, so no repair rate can be computed. It is unmeasured, not zero.",
    ),
    coverageShortfalls,
  };
}

export interface WelderPerformance {
  welderQualificationId: string;
  welderName: string;
  welderStamp: string | null;
  weldCount: number;
  examinedCount: number;
  rejectedCount: number;
  repairRate: Rate;
}

/**
 * Repair rate per welder. The reason this is worth computing: most codes
 * require the examination percentage to be RAISED for a welder whose repair
 * rate exceeds a threshold, and lowering it again only once the rate comes
 * back down. Without the rate per welder that rule cannot be operated.
 */
export function welderPerformance(
  welds: WeldLike[],
  ndt: NdtRecordLike[],
  qualifications: WelderQualificationLike[],
): WelderPerformance[] {
  const qById = new Map(qualifications.map((q) => [q.id, q] as const));
  const ndtByWeld = new Map<string, NdtRecordLike[]>();
  for (const record of ndt) {
    const list = ndtByWeld.get(record.weldId) ?? [];
    list.push(record);
    ndtByWeld.set(record.weldId, list);
  }
  const byWelder = new Map<string, WeldLike[]>();
  for (const w of welds) {
    if (!w.welderQualificationId) continue;
    const list = byWelder.get(w.welderQualificationId) ?? [];
    list.push(w);
    byWelder.set(w.welderQualificationId, list);
  }
  const out: WelderPerformance[] = [];
  for (const [qualificationId, list] of byWelder) {
    const q = qById.get(qualificationId);
    const examinations = list.flatMap((w) =>
      (ndtByWeld.get(w.id) ?? []).filter((r) => r.result !== "pending"),
    );
    const rejected = examinations.filter((r) => r.result === "reject");
    out.push({
      welderQualificationId: qualificationId,
      welderName: q?.welderName ?? qualificationId,
      welderStamp: q?.welderStamp ?? null,
      weldCount: list.length,
      examinedCount: examinations.length,
      rejectedCount: rejected.length,
      repairRate: rate(
        rejected.length,
        examinations.length,
        `No examination of ${q?.welderName ?? "this welder"}'s joints has returned a result, so their repair rate is unmeasured.`,
      ),
    });
  }
  return out.sort((a, b) => (b.repairRate.value ?? -1) - (a.repairRate.value ?? -1));
}
