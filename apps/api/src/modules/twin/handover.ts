/**
 * O&M handover readiness (spec Domain L #628-631, #645-649) — pure.
 *
 * Handover fails on the boring things: an asset with no space, no serial
 * number, no warranty and no O&M document. This scores the register against
 * the criteria a facilities team actually needs on day one, weights them by
 * how much pain each missing item causes, and returns the assets responsible
 * for each gap so the score is actionable rather than decorative.
 *
 * The score is a weighted coverage figure, not an opinion: every dimension
 * reports populated/total and the exact basis, and a project with no assets
 * scores null (unknowable), never 0 (bad).
 */

export interface HandoverAsset {
  id: string;
  tagCode: string;
  name: string;
  status: string;
  criticality: string;
  locationId: string | null;
  classificationCode: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  installedAt: string | null;
  commissionedAt: string | null;
  hasWarranty: boolean;
  hasDocument: boolean;
  hasElementLink: boolean;
  hasSensor: boolean;
}

export interface HandoverDimension {
  key: string;
  label: string;
  weight: number;
  populated: number;
  total: number;
  percent: number;
  basis: string;
  missingTagCodes: string[];
}

export interface HandoverReadiness {
  /** 0..100, or null when there is nothing to assess */
  score: number | null;
  scoreBasis: string;
  assetsAssessed: number;
  dimensions: HandoverDimension[];
  blockers: string[];
}

interface Criterion {
  key: string;
  label: string;
  weight: number;
  basis: string;
  test: (asset: HandoverAsset) => boolean;
  blocking?: boolean;
}

const CRITERIA: Criterion[] = [
  {
    key: "located",
    label: "Located in a space",
    weight: 1.5,
    basis: "asset.locationId is set",
    test: (a) => a.locationId !== null,
    blocking: true,
  },
  {
    key: "classified",
    label: "Classified (Uniclass/Omniclass)",
    weight: 1,
    basis: "asset.classificationCode is set",
    test: (a) => !!a.classificationCode,
  },
  {
    key: "identified",
    label: "Manufacturer and model recorded",
    weight: 1.5,
    basis: "manufacturer and modelNumber are both set",
    test: (a) => !!a.manufacturer && !!a.modelNumber,
    blocking: true,
  },
  {
    key: "serialised",
    label: "Serial number recorded",
    weight: 0.5,
    basis: "asset.serialNumber is set",
    test: (a) => !!a.serialNumber,
  },
  {
    key: "commissioned",
    label: "Installed and commissioned",
    weight: 1.5,
    basis: "installedAt and commissionedAt are both set",
    test: (a) => !!a.installedAt && !!a.commissionedAt,
    blocking: true,
  },
  {
    key: "warranted",
    label: "Warranty recorded",
    weight: 1.5,
    basis: "a warranty row exists for the asset",
    test: (a) => a.hasWarranty,
    blocking: true,
  },
  {
    key: "documented",
    label: "O&M document attached",
    weight: 1,
    basis: "a warranty or attribute references a document file",
    test: (a) => a.hasDocument,
  },
  {
    key: "geometry",
    label: "Bound to model geometry",
    weight: 1,
    basis: "an asset_element_link exists",
    test: (a) => a.hasElementLink,
  },
];

export function assessHandover(assets: HandoverAsset[]): HandoverReadiness {
  if (assets.length === 0) {
    return {
      score: null,
      scoreBasis: "not available: no assets have been registered on this project",
      assetsAssessed: 0,
      dimensions: CRITERIA.map((c) => ({
        key: c.key,
        label: c.label,
        weight: c.weight,
        populated: 0,
        total: 0,
        percent: 0,
        basis: c.basis,
        missingTagCodes: [],
      })),
      blockers: ["No assets have been registered, so there is nothing to hand over"],
    };
  }

  const dimensions: HandoverDimension[] = CRITERIA.map((criterion) => {
    const missing = assets.filter((a) => !criterion.test(a));
    const populated = assets.length - missing.length;
    return {
      key: criterion.key,
      label: criterion.label,
      weight: criterion.weight,
      populated,
      total: assets.length,
      percent: Math.round((populated / assets.length) * 1000) / 10,
      basis: criterion.basis,
      missingTagCodes: missing.slice(0, 25).map((a) => a.tagCode),
    };
  });

  const totalWeight = CRITERIA.reduce((sum, c) => sum + c.weight, 0);
  const weighted = dimensions.reduce(
    (sum, d) => sum + (d.populated / d.total) * (CRITERIA.find((c) => c.key === d.key)!.weight),
    0,
  );

  const blockers: string[] = [];
  for (const criterion of CRITERIA.filter((c) => c.blocking)) {
    const dimension = dimensions.find((d) => d.key === criterion.key)!;
    const missing = dimension.total - dimension.populated;
    if (missing > 0) {
      blockers.push(`${missing} asset(s) fail "${criterion.label}"`);
    }
  }
  const notCommissioned = assets.filter(
    (a) => a.status !== "commissioned" && a.status !== "operational",
  );
  if (notCommissioned.length > 0) {
    blockers.push(
      `${notCommissioned.length} asset(s) are not yet commissioned or operational (status is planned/installed)`,
    );
  }

  return {
    score: Math.round((weighted / totalWeight) * 1000) / 10,
    scoreBasis: `weighted coverage of ${CRITERIA.length} handover criteria across ${assets.length} assets`,
    assetsAssessed: assets.length,
    dimensions,
    blockers,
  };
}

/* ------------------------------------------------------------------ */
/* Asset performance (#660-661)                                        */
/* ------------------------------------------------------------------ */

export interface PerformanceSample {
  sensorId: string;
  sensorName: string;
  kind: string;
  unit: string;
  designSetpoint: number | null;
  readings: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  lastValue: number | null;
  lastAt: string | null;
}

export interface PerformanceRow extends PerformanceSample {
  /** actual minus design intent; null when either side is unknown */
  gap: number | null;
  gapPercent: number | null;
  verdict: "on_design" | "above_design" | "below_design" | "unknown";
  basis: string;
}

/**
 * Compare measured averages with the design setpoint. A sensor with no
 * setpoint returns verdict "unknown" and an explicit basis: a performance gap
 * against a baseline nobody recorded is a fabricated number.
 */
export function performanceGap(sample: PerformanceSample, tolerancePercent = 5): PerformanceRow {
  if (sample.readings === 0) {
    return {
      ...sample,
      gap: null,
      gapPercent: null,
      verdict: "unknown",
      basis: "no readings in the window",
    };
  }
  if (sample.designSetpoint === null || sample.avg === null) {
    return {
      ...sample,
      gap: null,
      gapPercent: null,
      verdict: "unknown",
      basis:
        sample.designSetpoint === null
          ? "no design setpoint recorded for this channel"
          : "no measured average available",
    };
  }
  const gap = sample.avg - sample.designSetpoint;
  const gapPercent =
    sample.designSetpoint === 0 ? null : Math.round((gap / Math.abs(sample.designSetpoint)) * 1000) / 10;
  const verdict =
    gapPercent === null
      ? "unknown"
      : Math.abs(gapPercent) <= tolerancePercent
        ? "on_design"
        : gapPercent > 0
          ? "above_design"
          : "below_design";
  return {
    ...sample,
    gap: Math.round(gap * 1000) / 1000,
    gapPercent,
    verdict,
    basis: `${sample.readings} readings averaged against a design setpoint of ${sample.designSetpoint} ${sample.unit} (±${tolerancePercent}%)`,
  };
}
