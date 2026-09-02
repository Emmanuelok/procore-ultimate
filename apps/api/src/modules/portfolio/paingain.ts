/**
 * Target-cost pain/gain and alliance share computation.
 * Spec Vol II Domain Z #1061 (multi-party alliance pain/gain share) and
 * #1062 (target cost contract gain share computation).
 *
 * Pure and deterministic. Sign convention, stated once so no caller has to
 * guess:
 *
 *   variance        = outturn defined cost − adjusted target
 *                     POSITIVE is an overrun (pain); NEGATIVE is a saving (gain)
 *   contractorShare = the contractor's PORTION OF THE VARIANCE, always a
 *                     non-negative magnitude
 *   clientShare     = the remainder of the variance, likewise non-negative
 *   contractorAdjustment
 *                   = the signed movement in what the contractor is paid:
 *                     −contractorShare on pain, +contractorShare on gain
 *
 * Bands are expressed as percentages OF THE ADJUSTED TARGET, measured from
 * zero variance outwards, with the gain side negative. The engine integrates
 * the variance through the bands rather than applying one rate to the whole
 * amount, which is what an NEC-style stepped share actually means.
 *
 * What it deliberately does NOT do: guess at an uncovered variance. A
 * variance that runs past the last declared band is attributed wholly to the
 * client and a warning says so — silently extrapolating the last band's rate
 * would invent a contractual term.
 */

import type { PainGainMechanism } from "@constructos/shared";

export interface ShareBand {
  /** percentage of the adjusted target where this band starts (may be negative) */
  fromPercent: number;
  /** where it ends; null = open-ended in that direction */
  toPercent: number | null;
  /** the contractor's share of variance falling in this band, 0..100 */
  contractorSharePercent: number;
}

export interface AllianceParticipant {
  name: string;
  partyId?: string | null;
  /** share of the CONTRACTOR SIDE of pain/gain, 0..100 */
  sharePercent: number;
}

export interface PainGainInput {
  currency: string;
  baseTargetCost: number;
  targetAdjustments: number;
  /** actual or forecast defined cost, per `basis` */
  outturnCost: number;
  feePercent: number;
  mechanism: PainGainMechanism;
  shareBands: ShareBand[];
  painCap: number | null;
  gainCap: number | null;
  participants: AllianceParticipant[];
}

export interface BandResult {
  fromPercent: number;
  toPercent: number | null;
  contractorSharePercent: number;
  /** magnitude of variance falling inside this band, in currency */
  amountInBand: number;
  contractorAmount: number;
  clientAmount: number;
}

export interface ParticipantSplit {
  name: string;
  partyId: string | null;
  sharePercent: number;
  /** signed like contractorAdjustment: negative when the participant bears pain */
  amount: number;
}

export interface PainGainOutput {
  computable: boolean;
  reasons: string[];
  warnings: string[];
  currency: string;
  adjustedTarget: number;
  outturnCost: number;
  variance: number;
  variancePercent: number | null;
  side: "pain" | "gain" | "on_target";
  bands: BandResult[];
  /** magnitude of the variance borne/earned by the contractor */
  contractorShare: number | null;
  clientShare: number | null;
  capApplied: "pain" | "gain" | null;
  /** the cap value that bound, when one did */
  cappedAt: number | null;
  /** amount removed by the cap and transferred to the client */
  capTransfer: number;
  fee: number;
  contractorAdjustment: number | null;
  /** outturn + fee + adjustment — what the contractor ends up being paid */
  contractorPayment: number | null;
  participants: ParticipantSplit[];
  basis: string[];
}

export class PainGainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PainGainError";
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Parse a stored `share_bands` blob. Throws PainGainError the route turns into a 400. */
export function parseShareBands(raw: unknown): ShareBand[] {
  if (!Array.isArray(raw)) throw new PainGainError("share bands must be a list");
  const bands: ShareBand[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) throw new PainGainError("each share band must be an object");
    const b = entry as Record<string, unknown>;
    const fromPercent = isFiniteNumber(b["fromPercent"]) ? b["fromPercent"] : NaN;
    if (!Number.isFinite(fromPercent)) throw new PainGainError("each share band needs a numeric fromPercent");
    const toRaw = b["toPercent"];
    const toPercent = toRaw === null || toRaw === undefined ? null : isFiniteNumber(toRaw) ? toRaw : NaN;
    if (toPercent !== null && !Number.isFinite(toPercent)) {
      throw new PainGainError("a share band's toPercent must be a number or null");
    }
    if (toPercent !== null && toPercent <= fromPercent) {
      throw new PainGainError(`share band ${fromPercent}%–${toPercent}% does not move forward`);
    }
    const share = isFiniteNumber(b["contractorSharePercent"]) ? b["contractorSharePercent"] : NaN;
    if (!Number.isFinite(share) || share < 0 || share > 100) {
      throw new PainGainError("contractorSharePercent must be between 0 and 100");
    }
    bands.push({ fromPercent, toPercent, contractorSharePercent: share });
  }
  return bands;
}

/** Parse alliance participants; shares must not exceed 100% of the contractor side. */
export function parseParticipants(raw: unknown): AllianceParticipant[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PainGainError("participants must be a list");
  const out: AllianceParticipant[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) throw new PainGainError("each participant must be an object");
    const p = entry as Record<string, unknown>;
    const name = typeof p["name"] === "string" ? p["name"].trim() : "";
    if (!name) throw new PainGainError("each participant needs a name");
    const share = isFiniteNumber(p["sharePercent"]) ? p["sharePercent"] : NaN;
    if (!Number.isFinite(share) || share < 0 || share > 100) {
      throw new PainGainError(`participant "${name}" needs a sharePercent between 0 and 100`);
    }
    out.push({
      name,
      partyId: typeof p["partyId"] === "string" ? p["partyId"] : null,
      sharePercent: share,
    });
  }
  const total = out.reduce((s, p) => s + p.sharePercent, 0);
  if (total > 100.0001) {
    throw new PainGainError(`participant shares total ${round2(total)}% — they cannot exceed 100%`);
  }
  return out;
}

/**
 * Structural checks on a band set for the chosen mechanism. Returns the
 * problems rather than throwing, so the UI can show them all at once.
 */
export function validateShareBands(bands: ShareBand[], mechanism: PainGainMechanism): string[] {
  const problems: string[] = [];
  if (bands.length === 0) {
    problems.push("no share bands are defined — pain/gain cannot be apportioned");
    return problems;
  }
  if (mechanism !== "banded_share" && bands.length > 1) {
    problems.push(`a ${mechanism.replace(/_/g, " ")} mechanism uses a single share; ${bands.length} bands are defined and only the first will apply`);
  }
  const sorted = [...bands].sort((a, b) => a.fromPercent - b.fromPercent);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.toPercent === null) {
      problems.push(`band from ${prev.fromPercent}% is open-ended but another band starts at ${cur.fromPercent}%`);
      continue;
    }
    if (cur.fromPercent < prev.toPercent) {
      problems.push(`bands overlap between ${cur.fromPercent}% and ${prev.toPercent}%`);
    } else if (cur.fromPercent > prev.toPercent) {
      problems.push(`bands leave a gap between ${prev.toPercent}% and ${cur.fromPercent}%`);
    }
  }
  return problems;
}

interface Interval {
  lo: number;
  hi: number;
}

/** Overlap of a band with the [0 → variancePercent] interval, as a magnitude in percent. */
function overlapPercent(band: ShareBand, interval: Interval): number {
  const bandLo = band.fromPercent;
  const bandHi = band.toPercent ?? Number.POSITIVE_INFINITY;
  const lo = Math.max(bandLo, interval.lo);
  const hi = Math.min(bandHi, interval.hi);
  return hi > lo ? hi - lo : 0;
}

/**
 * Compute the pain/gain position. Never throws for ordinary data: an input it
 * cannot work with comes back `computable: false` with the reason, because a
 * commercial number the platform cannot stand behind must not be rendered.
 */
export function computePainGain(input: PainGainInput): PainGainOutput {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const basis: string[] = [];

  const adjustedTarget = input.baseTargetCost + input.targetAdjustments;
  const outturnCost = input.outturnCost;
  const variance = outturnCost - adjustedTarget;
  const fee = round2((input.feePercent / 100) * outturnCost);
  const side: "pain" | "gain" | "on_target" =
    Math.abs(variance) < 0.005 ? "on_target" : variance > 0 ? "pain" : "gain";

  basis.push(
    `Adjusted target = base target ${round2(input.baseTargetCost)} + agreed adjustments ${round2(input.targetAdjustments)} = ${round2(adjustedTarget)} ${input.currency}.`,
  );
  basis.push(`Fee = ${input.feePercent}% of defined cost ${round2(outturnCost)} = ${fee} ${input.currency}.`);

  const empty: PainGainOutput = {
    computable: false,
    reasons,
    warnings,
    currency: input.currency,
    adjustedTarget: round2(adjustedTarget),
    outturnCost: round2(outturnCost),
    variance: round2(variance),
    variancePercent: null,
    side,
    bands: [],
    contractorShare: null,
    clientShare: null,
    capApplied: null,
    cappedAt: null,
    capTransfer: 0,
    fee,
    contractorAdjustment: null,
    contractorPayment: null,
    participants: [],
    basis,
  };

  if (!Number.isFinite(adjustedTarget) || adjustedTarget <= 0) {
    reasons.push("the adjusted target cost is zero or negative, so a variance percentage cannot be expressed against it");
    return empty;
  }
  if (!Number.isFinite(outturnCost) || outturnCost < 0) {
    reasons.push("the outturn defined cost is missing or negative");
    return empty;
  }
  const bands = input.shareBands;
  if (bands.length === 0) {
    reasons.push("no share bands are defined for this contract, so the variance cannot be apportioned");
    return empty;
  }

  const variancePercent = (variance / adjustedTarget) * 100;
  basis.push(
    `Variance = defined cost ${round2(outturnCost)} − adjusted target ${round2(adjustedTarget)} = ${round2(variance)} ${input.currency} (${round2(variancePercent)}% of target).`,
  );

  const bandResults: BandResult[] = [];
  let contractorShare = 0;
  let clientShare = 0;

  if (side === "on_target") {
    basis.push("Outturn equals the adjusted target: there is nothing to share.");
  } else if (input.mechanism === "banded_share") {
    const interval: Interval =
      side === "pain" ? { lo: 0, hi: variancePercent } : { lo: variancePercent, hi: 0 };
    let coveredPercent = 0;
    const sorted = [...bands].sort((a, b) => a.fromPercent - b.fromPercent);
    for (const band of sorted) {
      const pct = overlapPercent(band, interval);
      if (pct <= 0) continue;
      const amountInBand = (pct / 100) * adjustedTarget;
      const contractorAmount = (band.contractorSharePercent / 100) * amountInBand;
      coveredPercent += pct;
      contractorShare += contractorAmount;
      clientShare += amountInBand - contractorAmount;
      bandResults.push({
        fromPercent: band.fromPercent,
        toPercent: band.toPercent,
        contractorSharePercent: band.contractorSharePercent,
        amountInBand: round2(amountInBand),
        contractorAmount: round2(contractorAmount),
        clientAmount: round2(amountInBand - contractorAmount),
      });
    }
    const totalPercent = Math.abs(variancePercent);
    const uncoveredPercent = totalPercent - coveredPercent;
    if (uncoveredPercent > 0.0001) {
      const uncoveredAmount = (uncoveredPercent / 100) * adjustedTarget;
      clientShare += uncoveredAmount;
      warnings.push(
        `${round2(uncoveredPercent)}% of the target (${round2(uncoveredAmount)} ${input.currency}) falls outside every declared share band and is attributed wholly to the client; extending the last band's rate would invent a contract term.`,
      );
    }
    basis.push(`Variance integrated through ${bandResults.length} share band(s).`);
  } else {
    const flat = bands[0]!;
    const magnitude = Math.abs(variance);
    contractorShare = (flat.contractorSharePercent / 100) * magnitude;
    clientShare = magnitude - contractorShare;
    bandResults.push({
      fromPercent: flat.fromPercent,
      toPercent: flat.toPercent,
      contractorSharePercent: flat.contractorSharePercent,
      amountInBand: round2(magnitude),
      contractorAmount: round2(contractorShare),
      clientAmount: round2(clientShare),
    });
    basis.push(
      `${input.mechanism === "capped_share" ? "Capped" : "Flat"} share: ${flat.contractorSharePercent}% of the whole ${round2(magnitude)} ${input.currency} variance.`,
    );
    if (bands.length > 1) {
      warnings.push(`${bands.length} bands are stored but a ${input.mechanism.replace(/_/g, " ")} mechanism applies only the first.`);
    }
  }

  /* Caps bind the contractor's exposure/upside; whatever the cap removes
     lands on the client — the money does not disappear. */
  let capApplied: "pain" | "gain" | null = null;
  let cappedAt: number | null = null;
  let capTransfer = 0;
  const cap = side === "pain" ? input.painCap : side === "gain" ? input.gainCap : null;
  if (cap !== null && Number.isFinite(cap) && contractorShare > cap) {
    capTransfer = round2(contractorShare - cap);
    clientShare += contractorShare - cap;
    contractorShare = cap;
    capApplied = side === "pain" ? "pain" : "gain";
    cappedAt = cap;
    basis.push(
      `Contractor ${side} capped at ${round2(cap)} ${input.currency}; ${capTransfer} ${input.currency} transferred to the client.`,
    );
  }

  contractorShare = round2(contractorShare);
  clientShare = round2(clientShare);
  const contractorAdjustment = side === "pain" ? -contractorShare : side === "gain" ? contractorShare : 0;
  const contractorPayment = round2(outturnCost + fee + contractorAdjustment);

  const participants: ParticipantSplit[] = [];
  if (input.participants.length > 0) {
    const total = input.participants.reduce((s, p) => s + p.sharePercent, 0);
    if (total < 99.9999) {
      warnings.push(
        `alliance participant shares total ${round2(total)}% of the contractor side; the remaining ${round2(100 - total)}% is unallocated.`,
      );
    }
    for (const p of input.participants) {
      participants.push({
        name: p.name,
        partyId: p.partyId ?? null,
        sharePercent: p.sharePercent,
        amount: round2((p.sharePercent / 100) * contractorAdjustment),
      });
    }
  }

  return {
    computable: true,
    reasons,
    warnings,
    currency: input.currency,
    adjustedTarget: round2(adjustedTarget),
    outturnCost: round2(outturnCost),
    variance: round2(variance),
    variancePercent: round2(variancePercent),
    side,
    bands: bandResults,
    contractorShare,
    clientShare,
    capApplied,
    cappedAt,
    capTransfer,
    fee,
    contractorAdjustment: round2(contractorAdjustment),
    contractorPayment,
    participants,
    basis,
  };
}
