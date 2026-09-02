/**
 * LOGISTICS ENGINE — slot booking rules, on-time analytics and the transport
 * carbon hook (spec #930–933, #937, #945; Vol I #720–722, #730).
 *
 * A gate has an operating window, N concurrent bays and (maybe) a crane. A
 * booking is refused when it falls outside the window, when the bays are
 * full for any minute of it, when the crane is already committed, or when
 * the vehicle is bigger than the approach takes. Every refusal names the
 * clashing booking so the planner can move one of them.
 *
 * Carbon: a code-resident set of generic per-km factors by vehicle type /
 * mode. They are GENERIC (DEFRA-style order of magnitude, flagged as such)
 * so a figure always carries `basis` and is never mistaken for a measured
 * value. Unknown km → no figure, with the reason.
 */
import type { TransportMode, VehicleType } from "@constructos/shared";
import { minutesBetween } from "./dates.js";

export interface GateRules {
  opensAt: string; // HH:MM
  closesAt: string;
  concurrentSlots: number;
  craneAvailable: boolean;
  maxVehicleType: string | null;
  status: string;
}

export interface SlotWindow {
  id: string;
  startsAt: string; // ISO timestamp
  endsAt: string;
  craneRequired: boolean;
  status: string;
  reference?: string;
}

export interface BookingRequest {
  startsAt: string;
  endsAt: string;
  craneRequired: boolean;
  vehicleType: string;
  /** when re-validating an existing slot, exclude itself */
  excludeSlotId?: string | null;
}

export interface BookingConflict {
  kind: "gate_closed" | "outside_hours" | "capacity" | "crane" | "vehicle_too_large" | "invalid_window";
  detail: string;
  clashingSlotIds: string[];
}

/** Vehicles in ascending size order; a gate's `maxVehicleType` caps the list. */
export const VEHICLE_SIZE_ORDER: readonly VehicleType[] = [
  "van",
  "rigid_7_5t",
  "rigid_18t",
  "rigid_26t",
  "tipper",
  "concrete_mixer",
  "crane_lorry",
  "articulated",
  "low_loader",
  "abnormal_load",
  "other",
];

const ACTIVE_SLOT_STATUSES: ReadonlySet<string> = new Set(["requested", "confirmed", "arrived", "unloading"]);

function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** minutes since local midnight of the timestamp (UTC clock; gates keep site time as UTC) */
function minuteOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = Date.parse(aStart);
  const ae = Date.parse(aEnd);
  const bs = Date.parse(bStart);
  const be = Date.parse(bEnd);
  return as < be && bs < ae;
}

export function validateBooking(
  gate: GateRules,
  existing: SlotWindow[],
  request: BookingRequest,
): BookingConflict[] {
  const conflicts: BookingConflict[] = [];
  const start = Date.parse(request.startsAt);
  const end = Date.parse(request.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return [{ kind: "invalid_window", detail: "The slot must end after it starts.", clashingSlotIds: [] }];
  }
  if (gate.status !== "open") {
    conflicts.push({ kind: "gate_closed", detail: "The gate is closed to bookings.", clashingSlotIds: [] });
  }
  const opens = hhmmToMinutes(gate.opensAt);
  const closes = hhmmToMinutes(gate.closesAt);
  if (opens !== null && closes !== null) {
    const s = minuteOfDay(request.startsAt);
    const e = minuteOfDay(request.endsAt);
    const sameDay = request.startsAt.slice(0, 10) === request.endsAt.slice(0, 10);
    const endMinute = sameDay ? e : 24 * 60;
    if (s < opens || endMinute > closes || !sameDay) {
      conflicts.push({
        kind: "outside_hours",
        detail: `The gate takes deliveries ${gate.opensAt}–${gate.closesAt}; the slot runs ${request.startsAt.slice(11, 16)}–${request.endsAt.slice(11, 16)}${sameDay ? "" : " and crosses midnight"}.`,
        clashingSlotIds: [],
      });
    }
  }
  if (gate.maxVehicleType) {
    const cap = VEHICLE_SIZE_ORDER.indexOf(gate.maxVehicleType as VehicleType);
    const got = VEHICLE_SIZE_ORDER.indexOf(request.vehicleType as VehicleType);
    if (cap >= 0 && got > cap && request.vehicleType !== "other") {
      conflicts.push({
        kind: "vehicle_too_large",
        detail: `The gate takes up to ${gate.maxVehicleType}; ${request.vehicleType} will not make the approach.`,
        clashingSlotIds: [],
      });
    }
  }

  const live = existing.filter((s) => s.id !== request.excludeSlotId && ACTIVE_SLOT_STATUSES.has(s.status));
  const clashing = live.filter((s) => overlaps(s.startsAt, s.endsAt, request.startsAt, request.endsAt));

  // Capacity: the busiest minute inside the requested window must stay below concurrentSlots.
  if (clashing.length >= Math.max(1, gate.concurrentSlots)) {
    const peak = peakConcurrency(clashing, request.startsAt, request.endsAt);
    if (peak >= Math.max(1, gate.concurrentSlots)) {
      conflicts.push({
        kind: "capacity",
        detail: `All ${gate.concurrentSlots} bay(s) are taken for part of that window (${clashing.map((s) => s.reference ?? s.id).join(", ")}).`,
        clashingSlotIds: clashing.map((s) => s.id),
      });
    }
  }
  if (request.craneRequired) {
    if (!gate.craneAvailable) {
      conflicts.push({ kind: "crane", detail: "This gate has no crane allocation.", clashingSlotIds: [] });
    } else {
      const craneClash = clashing.filter((s) => s.craneRequired);
      if (craneClash.length > 0) {
        conflicts.push({
          kind: "crane",
          detail: `The crane is already committed to ${craneClash.map((s) => s.reference ?? s.id).join(", ")} in that window.`,
          clashingSlotIds: craneClash.map((s) => s.id),
        });
      }
    }
  }
  return conflicts;
}

/** The maximum number of `slots` overlapping any instant inside [from, to). */
export function peakConcurrency(slots: SlotWindow[], from: string, to: string): number {
  const events: Array<{ t: number; d: number }> = [];
  const lo = Date.parse(from);
  const hi = Date.parse(to);
  for (const s of slots) {
    const a = Math.max(Date.parse(s.startsAt), lo);
    const b = Math.min(Date.parse(s.endsAt), hi);
    if (b <= a) continue;
    events.push({ t: a, d: 1 }, { t: b, d: -1 });
  }
  events.sort((x, y) => x.t - y.t || x.d - y.d);
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    cur += e.d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/* ------------------------------------------------------------------ */
/* Arrival, punctuality, waiting                                       */
/* ------------------------------------------------------------------ */

export interface ArrivalAssessment {
  wasOnTime: boolean;
  lateMinutes: number;
  /** minutes the vehicle waited between arrival and unloading */
  waitingMinutes: number | null;
}

/** On time = arrived no later than `graceMinutes` after the slot start. Early is on time. */
export function assessArrival(
  slot: { startsAt: string; endsAt: string },
  arrivedAt: string,
  unloadingStartedAt: string | null,
  graceMinutes = 15,
): ArrivalAssessment {
  const late = minutesBetween(slot.startsAt, arrivedAt) ?? 0;
  const lateMinutes = Math.max(0, late);
  return {
    wasOnTime: lateMinutes <= graceMinutes,
    lateMinutes,
    waitingMinutes: unloadingStartedAt ? Math.max(0, minutesBetween(arrivedAt, unloadingStartedAt) ?? 0) : null,
  };
}

export interface OnTimeStats {
  completed: number;
  onTime: number;
  late: number;
  noShow: number;
  onTimePercent: number | null;
  averageLateMinutes: number | null;
  averageWaitingMinutes: number | null;
  reasons: string[];
}

export function onTimeDelivery(
  slots: Array<{ status: string; wasOnTime: number | null; lateMinutes: number | null; waitingMinutes: number | null }>,
): OnTimeStats {
  const completed = slots.filter((s) => s.status === "completed");
  const noShow = slots.filter((s) => s.status === "no_show").length;
  const assessed = completed.filter((s) => s.wasOnTime !== null);
  const onTime = assessed.filter((s) => s.wasOnTime === 1).length;
  const late = assessed.length - onTime;
  const reasons: string[] = [];
  if (assessed.length === 0) reasons.push("No completed deliveries with an arrival time recorded yet.");
  const lateMins = assessed.filter((s) => s.wasOnTime === 0 && typeof s.lateMinutes === "number").map((s) => s.lateMinutes as number);
  const waits = completed.filter((s) => typeof s.waitingMinutes === "number").map((s) => s.waitingMinutes as number);
  return {
    completed: completed.length,
    onTime,
    late,
    noShow,
    onTimePercent: assessed.length > 0 ? Math.round((onTime / assessed.length) * 1000) / 10 : null,
    averageLateMinutes: lateMins.length > 0 ? Math.round(lateMins.reduce((a, b) => a + b, 0) / lateMins.length) : null,
    averageWaitingMinutes: waits.length > 0 ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Transport carbon hook (#945, ESG module A4)                         */
/* ------------------------------------------------------------------ */

/**
 * Generic factors, kgCO2e per vehicle-km, laden. Order-of-magnitude values in
 * the style of the UK government (DEFRA/BEIS) freight conversion factors; they
 * are NOT a substitute for the tenant's own factor library and are labelled
 * "generic" on every figure they produce.
 */
export const ROAD_FACTORS_KG_PER_KM: Record<VehicleType, number> = {
  van: 0.25,
  rigid_7_5t: 0.49,
  rigid_18t: 0.68,
  rigid_26t: 0.83,
  tipper: 0.83,
  concrete_mixer: 0.9,
  crane_lorry: 0.9,
  articulated: 0.95,
  low_loader: 1.1,
  abnormal_load: 1.4,
  other: 0.8,
};

/** kgCO2e per tonne-km for non-road modes (a load weight is required). */
export const MODE_FACTORS_KG_PER_TONNE_KM: Partial<Record<TransportMode, number>> = {
  rail: 0.028,
  sea: 0.016,
  inland_waterway: 0.031,
  air: 1.1,
};

export interface CarbonEstimate {
  kgCo2e: number | null;
  basis: string;
  reasons: string[];
}

export function estimateTransportCarbon(input: {
  transportMode: string;
  vehicleType: string;
  transportKm: number | null;
  loadTonnes: number | null;
}): CarbonEstimate {
  const reasons: string[] = [];
  if (input.transportKm === null || !(input.transportKm > 0)) {
    reasons.push("Transport distance not recorded; no carbon figure is produced without it.");
    return { kgCo2e: null, basis: "none", reasons };
  }
  if (input.transportMode === "road" || input.transportMode === "multimodal") {
    const factor = ROAD_FACTORS_KG_PER_KM[input.vehicleType as VehicleType] ?? ROAD_FACTORS_KG_PER_KM.other;
    return {
      kgCo2e: Math.round(input.transportKm * factor * 100) / 100,
      basis: `generic road factor ${factor} kgCO2e/vehicle-km (${input.vehicleType}) × ${input.transportKm} km${input.transportMode === "multimodal" ? "; multimodal legs treated as road" : ""}`,
      reasons,
    };
  }
  const perTonneKm = MODE_FACTORS_KG_PER_TONNE_KM[input.transportMode as TransportMode];
  if (perTonneKm === undefined) {
    reasons.push(`No generic factor for transport mode ${input.transportMode}.`);
    return { kgCo2e: null, basis: "none", reasons };
  }
  if (input.loadTonnes === null || !(input.loadTonnes > 0)) {
    reasons.push(`${input.transportMode} carbon is per tonne-km; record the load weight.`);
    return { kgCo2e: null, basis: "none", reasons };
  }
  return {
    kgCo2e: Math.round(input.transportKm * input.loadTonnes * perTonneKm * 100) / 100,
    basis: `generic ${input.transportMode} factor ${perTonneKm} kgCO2e/tonne-km × ${input.loadTonnes} t × ${input.transportKm} km`,
    reasons,
  };
}
