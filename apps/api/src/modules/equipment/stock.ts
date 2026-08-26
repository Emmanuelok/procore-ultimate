/**
 * M23 — the material stock ledger. PURE.
 *
 * A COMPOUND IS A BANK ACCOUNT. `material_items.quantityOnHand` is the
 * balance and `material_stock_movements` is the statement, and the only
 * thing that makes either trustworthy is that they agree. `reconcileStock`
 * replays the statement and reports the difference; the route exposes it
 * rather than quietly trusting the materialized figure, because a
 * materialized balance that has drifted is worse than no balance at all —
 * it is a number people order against.
 *
 * NEGATIVE STOCK IS A LIE, NOT AN ERROR. You cannot issue 40 bags from a
 * compound holding 25. When a movement would drive stock negative the route
 * refuses it and NAMES THE SHORTFALL, because the shortfall is the useful
 * fact: either 15 bags arrived and were never booked in, or 15 bags left and
 * were never booked out. The refusal can be overridden explicitly
 * (`allowNegative`), which records that somebody knowingly accepted a
 * balance the compound cannot support — an auditable act, not a default.
 */

import type { StockMovementType } from "@constructos/shared";

export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Float slack on quantities — 0.0001 of a unit. */
const EPSILON = 1e-6;

/**
 * The sign each movement kind carries against ON-HAND stock.
 *
 *  +1  stock arrives              receipt, return, transfer_in
 *  -1  stock leaves               issue, transfer_out, consumption,
 *                                 wastage, damage, theft
 *   0  the caller's sign governs  adjustment (a stock-take can go either way)
 *   0  on-hand is untouched       reservation, reservation_release — these
 *                                 move `quantityReserved`, and treating them
 *                                 as issues is how a compound "loses" stock
 *                                 that is standing right there
 */
export const STOCK_MOVEMENT_SIGN: Record<StockMovementType, 1 | -1 | 0> = {
  receipt: 1,
  return: 1,
  transfer_in: 1,
  issue: -1,
  transfer_out: -1,
  consumption: -1,
  wastage: -1,
  damage: -1,
  theft: -1,
  adjustment: 0,
  reservation: 0,
  reservation_release: 0,
};

/** Kinds that represent material LOST rather than used — the figures that
 *  make wastage measurable, and the ones a sign-off must be independent for. */
export const LOSS_MOVEMENT_TYPES: readonly StockMovementType[] = ["wastage", "damage", "theft"];

/** Kinds that move `quantityReserved` instead of `quantityOnHand`. */
export const RESERVATION_MOVEMENT_TYPES: readonly StockMovementType[] = [
  "reservation",
  "reservation_release",
];

/**
 * The signed quantity a movement stores. Callers send a positive magnitude
 * for every kind whose direction is implied by its name; only `adjustment`
 * takes a signed number, because only a stock-take can legitimately go
 * either way.
 */
export function signedQuantity(type: StockMovementType, quantity: number): number {
  const sign = STOCK_MOVEMENT_SIGN[type];
  if (sign === 0) return round4(quantity);
  return round4(sign * Math.abs(quantity));
}

/** How much this movement changes ON-HAND stock (reservations: nothing). */
export function onHandDelta(type: StockMovementType, quantity: number): number {
  if (RESERVATION_MOVEMENT_TYPES.includes(type)) return 0;
  return signedQuantity(type, quantity);
}

/** How much this movement changes RESERVED stock. */
export function reservedDelta(type: StockMovementType, quantity: number): number {
  if (type === "reservation") return round4(Math.abs(quantity));
  if (type === "reservation_release") return round4(-Math.abs(quantity));
  return 0;
}

export interface ShortfallCheck {
  currentBalance: number;
  projectedBalance: number;
  wouldGoNegative: boolean;
  /** how much is missing — the number that says what to go and look for */
  shortfall: number;
  message: string | null;
}

/**
 * Would this movement drive the balance below zero, and by how much?
 * A projected balance of exactly zero is fine — that is an empty compound,
 * not an impossible one.
 */
export function checkShortfall(
  currentBalance: number,
  type: StockMovementType,
  quantity: number,
  unit: string | null,
): ShortfallCheck {
  const delta = onHandDelta(type, quantity);
  const projected = round4(currentBalance + delta);
  const wouldGoNegative = projected < -EPSILON;
  const shortfall = wouldGoNegative ? round4(-projected) : 0;
  const u = unit ? ` ${unit}` : "";
  return {
    currentBalance: round4(currentBalance),
    projectedBalance: projected,
    wouldGoNegative,
    shortfall,
    message: wouldGoNegative
      ? `this ${type} of ${round4(Math.abs(delta))}${u} would take stock from ` +
        `${round4(currentBalance)}${u} to ${projected}${u} — a shortfall of ${shortfall}${u}. ` +
        "Either material arrived and was never booked in, or it left and was never booked out; " +
        "find which before forcing the balance"
      : null,
  };
}

export interface MovementRow {
  id: string;
  movementType: StockMovementType;
  /** as stored: already signed */
  quantity: number;
  movedAt: string;
  balanceAfter: number | null;
}

export interface ReplayedMovement extends MovementRow {
  /** the balance the replay says should stand after this movement */
  computedBalanceAfter: number;
  /** the stored figure minus the replayed one; 0 when they agree */
  drift: number | null;
}

export interface StockReconciliation {
  openingBalance: number;
  /** balance implied by replaying every movement in `movedAt` order */
  computedBalance: number;
  /** the materialized figure on material_items */
  recordedBalance: number;
  difference: number;
  reconciles: boolean;
  movements: number;
  /** movements whose stored balanceAfter disagrees with the replay */
  driftedMovements: ReplayedMovement[];
  /** totals by kind, so wastage and theft are visible rather than netted */
  byType: Record<string, number>;
  reasons: string[];
}

/**
 * Replay the statement and compare it to the balance.
 *
 * Movements are replayed in `movedAt` order, ties broken by id, so the
 * result is deterministic regardless of insert order — a back-dated
 * correction lands where it belongs in the sequence rather than at the end.
 * `balanceAfter` on the stored rows is checked too: a row whose stored
 * balance disagrees with the replay is where the drift entered.
 */
export function reconcileStock(input: {
  openingBalance?: number;
  movements: MovementRow[];
  recordedBalance: number;
}): StockReconciliation {
  const opening = round4(input.openingBalance ?? 0);
  const reasons: string[] = [];
  const ordered = [...input.movements].sort(
    (a, b) => a.movedAt.localeCompare(b.movedAt) || a.id.localeCompare(b.id),
  );
  let running = opening;
  const byType: Record<string, number> = {};
  const driftedMovements: ReplayedMovement[] = [];
  for (const m of ordered) {
    const affectsOnHand = !RESERVATION_MOVEMENT_TYPES.includes(m.movementType);
    if (affectsOnHand) running = round4(running + m.quantity);
    byType[m.movementType] = round4((byType[m.movementType] ?? 0) + m.quantity);
    const drift = m.balanceAfter === null ? null : round4(m.balanceAfter - running);
    if (m.balanceAfter === null) {
      reasons.push(`movement ${m.id} carries no balanceAfter, so it cannot corroborate the replay`);
    } else if (Math.abs(drift ?? 0) > EPSILON) {
      driftedMovements.push({ ...m, computedBalanceAfter: running, drift });
    }
  }
  const difference = round4(input.recordedBalance - running);
  const reconciles = Math.abs(difference) <= EPSILON;
  if (!reconciles) {
    reasons.push(
      `the recorded on-hand balance (${round4(input.recordedBalance)}) differs from the movements ` +
        `replayed (${running}) by ${difference} — one of the two is wrong and the compound is the ` +
        "only place to find out which",
    );
  }
  if (ordered.length === 0 && Math.abs(input.recordedBalance) > EPSILON) {
    reasons.push(
      "there are no movements at all, yet a balance is recorded — the stock got there without " +
        "being booked in",
    );
  }
  return {
    openingBalance: opening,
    computedBalance: running,
    recordedBalance: round4(input.recordedBalance),
    difference,
    reconciles,
    movements: ordered.length,
    driftedMovements,
    byType,
    reasons,
  };
}

/**
 * Delivery-line arithmetic. `received` against `expected` is the discrepancy
 * the supplier will argue about; `accepted` + `rejected` against `received`
 * is the one that must simply add up, and a line where it does not is a line
 * nobody has finished inspecting.
 */
export function classifyDeliveryLine(input: {
  quantityExpected: number | null;
  quantityReceived: number;
  quantityAccepted: number;
  quantityRejected: number;
}): { kind: string; variance: number | null; message: string | null; balanced: boolean } {
  const { quantityExpected, quantityReceived, quantityAccepted, quantityRejected } = input;
  const balanced = Math.abs(quantityAccepted + quantityRejected - quantityReceived) <= EPSILON;
  const variance = quantityExpected === null ? null : round4(quantityReceived - quantityExpected);
  if (quantityRejected > EPSILON) {
    return {
      kind: "failed_inspection",
      variance,
      message: `${quantityRejected} of ${quantityReceived} received were rejected`,
      balanced,
    };
  }
  if (variance === null) {
    return {
      kind: "none",
      variance: null,
      message:
        "no expected quantity was recorded for this line, so short and over delivery cannot be " +
        "detected — the delivery note is being taken on trust",
      balanced,
    };
  }
  if (variance < -EPSILON) {
    return {
      kind: "short_delivery",
      variance,
      message: `${round4(-variance)} short against the ${quantityExpected} expected`,
      balanced,
    };
  }
  if (variance > EPSILON) {
    return {
      kind: "over_delivery",
      variance,
      message: `${variance} more than the ${quantityExpected} expected — check it is not another order`,
      balanced,
    };
  }
  return { kind: "none", variance: 0, message: null, balanced };
}
