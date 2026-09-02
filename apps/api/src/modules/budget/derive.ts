/**
 * Derived-column maintenance shared by the route layer and the
 * reconciliation engine — one place, so the number written by a PATCH and the
 * number written by the nightly rebuild are the same arithmetic.
 */
import type { ForecastMethod } from "@constructos/shared";
import { computeForecast, deriveLine, round2, type LineAmounts } from "./calc.js";

export type ForecastableLine = LineAmounts & { forecastMethod: string; forecastToComplete: number };

export interface SettledForecast {
  forecastToComplete: number;
  /** why the line's method could not be applied; empty when it was */
  reasons: string[];
}

/**
 * Re-derive a line's forecast with its own recorded method. When the method
 * cannot be applied (no progress recorded, no quantity on a measured method)
 * the PREVIOUS figure is retained and the reason is handed back — a stored
 * cost column is never quietly replaced with a number the inputs do not
 * support. A `manual` method always keeps the typed figure.
 */
export function settleForecast(line: ForecastableLine, override?: number): SettledForecast {
  if (override !== undefined) return { forecastToComplete: round2(override), reasons: [] };
  if (line.forecastMethod === "manual") {
    return { forecastToComplete: round2(line.forecastToComplete), reasons: [] };
  }
  const result = computeForecast(line.forecastMethod as ForecastMethod, line);
  if (result.forecastToComplete === null) {
    return { forecastToComplete: line.forecastToComplete, reasons: result.reasons };
  }
  return { forecastToComplete: result.forecastToComplete, reasons: [] };
}

/** Everything derivable from a line's stored inputs, ready to persist. */
export function derivedColumns(
  line: ForecastableLine,
  override?: number,
): { set: { revisedBudget: number; forecastToComplete: number; forecastFinal: number; projectedOverUnder: number }; reasons: string[] } {
  const settled = settleForecast(line, override);
  const derived = deriveLine(line, settled.forecastToComplete);
  return {
    set: {
      revisedBudget: derived.revisedBudget,
      forecastToComplete: derived.forecastToComplete,
      forecastFinal: derived.forecastFinal,
      projectedOverUnder: derived.projectedOverUnder,
    },
    reasons: settled.reasons,
  };
}
