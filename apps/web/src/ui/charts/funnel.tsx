/**
 * charts/funnel.tsx — FunnelChart.
 *
 * Stage-to-stage attrition: tender pipeline, submittal review, prequalification,
 * RFI resolution. Built from clip-path polygons rather than an SVG chart so the
 * funnel is fully responsive with no measurement pass, and so every stage can
 * carry a real, readable label instead of a colour the reader has to decode.
 */
import { useMemo, type ReactNode } from "react";

import { cx } from "../cx";
import type { Tone } from "../tokens";
import { ChartDataTable, ChartEmpty, ChartLoading } from "./primitives";
import { resolveMarkColor } from "./palette";
import {
  formatChartPercent,
  makeValueFormatter,
  toChartNumber,
  type ChartFormatOptions,
  type ValueFormat,
} from "./format";
import type { ChartStateProps } from "./types";

export interface FunnelStage {
  key?: string;
  label: string;
  value: number | null | undefined;
  color?: string;
  tone?: Tone;
  /** Small print under the stage label. */
  note?: ReactNode;
}

export interface FunnelChartProps extends ChartStateProps {
  data: ReadonlyArray<FunnelStage>;
  /** "vertical" stacks stages downwards (default); "horizontal" runs left to right. */
  orientation?: "vertical" | "horizontal";
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  /** Step-to-step and overall conversion rates. Default true. */
  showConversion?: boolean;
  /** Baseline for the overall rate. Default: the first stage. */
  baseIndex?: number;
  /** Plot height in px. Default 40px per stage. */
  height?: number;
  /** Narrowest the funnel is allowed to get, as a share of full width. */
  minWidthRatio?: number;
  ariaLabel?: string;
  dataTable?: boolean;
  dataTableLabel?: string;
  footnote?: ReactNode;
  className?: string;
  onStageClick?: (stage: FunnelStage, index: number) => void;
}

interface ResolvedStage {
  key: string;
  label: string;
  value: number | null;
  color: string;
  note?: ReactNode;
  ratio: number;
  stepRate: number | null;
  overallRate: number | null;
}

export function FunnelChart({
  data,
  orientation = "vertical",
  valueFormat,
  formatOptions,
  showConversion = true,
  baseIndex = 0,
  height,
  minWidthRatio = 0.16,
  ariaLabel = "Funnel",
  dataTable = true,
  dataTableLabel,
  footnote,
  className,
  onStageClick,
  ...state
}: FunnelChartProps) {
  const formatter = useMemo(
    () => makeValueFormatter(valueFormat, formatOptions ?? {}),
    [valueFormat, formatOptions],
  );

  const stages = useMemo<ResolvedStage[]>(() => {
    const values = data.map((stage) => toChartNumber(stage.value));
    const peak = values.reduce<number>((max, value) => (value !== null && value > max ? value : max), 0);
    const base = values[baseIndex] ?? values.find((value) => value !== null) ?? null;

    return data.map((stage, index) => {
      const value = values[index] ?? null;
      const previous = values[index - 1] ?? null;
      return {
        key: stage.key ?? stage.label,
        label: stage.label,
        value,
        color: resolveMarkColor(stage, index),
        note: stage.note,
        ratio:
          value === null || peak <= 0
            ? 0
            : Math.max(minWidthRatio, value / peak),
        stepRate: value !== null && previous !== null && previous !== 0 ? value / previous : null,
        overallRate: value !== null && base !== null && base !== 0 ? value / base : null,
      };
    });
  }, [data, baseIndex, minWidthRatio]);

  const anyValue = stages.some((stage) => stage.value !== null);

  if (state.loading) {
    return (
      <div className={cx("w-full", className)} style={{ height: height ?? (stages.length * 40 || 160) }}>
        <ChartLoading variant="block" />
      </div>
    );
  }

  if (state.error) {
    const message = state.error instanceof Error ? state.error.message : state.error;
    return (
      <div className={cx("w-full", className)} style={{ height: height ?? 160 }}>
        <ChartEmpty title="Funnel unavailable" message={message} />
      </div>
    );
  }

  if (stages.length === 0 || !anyValue || state.empty) {
    return (
      <div className={cx("w-full", className)} style={{ height: height ?? 160 }}>
        <ChartEmpty
          title={state.emptyTitle ?? "No stages"}
          message={
            state.emptyMessage ??
            "No counts have been reported for these stages, so the funnel cannot be drawn."
          }
          action={state.emptyAction}
        />
      </div>
    );
  }

  const isVertical = orientation === "vertical";
  const plotHeight = height ?? (isVertical ? Math.max(stages.length * 44, 120) : 220);

  const clipFor = (index: number): string => {
    const current = stages[index];
    const next = stages[index + 1];
    if (!current) return "none";
    const from = current.ratio * 100;
    const to = (next?.ratio ?? current.ratio) * 100;
    if (isVertical) {
      const l1 = (100 - from) / 2;
      const r1 = 100 - l1;
      const l2 = (100 - to) / 2;
      const r2 = 100 - l2;
      return `polygon(${l1}% 0%, ${r1}% 0%, ${r2}% 100%, ${l2}% 100%)`;
    }
    const t1 = (100 - from) / 2;
    const b1 = 100 - t1;
    const t2 = (100 - to) / 2;
    const b2 = 100 - t2;
    return `polygon(0% ${t1}%, 100% ${t2}%, 100% ${b2}%, 0% ${b1}%)`;
  };

  const tableRows = stages.map((stage) => ({
    label: stage.label,
    values: [
      stage.value === null ? "—" : formatter(stage.value),
      stage.stepRate === null ? "—" : formatChartPercent(stage.stepRate),
      stage.overallRate === null ? "—" : formatChartPercent(stage.overallRate),
    ],
  }));

  return (
    <figure className={cx("m-0 flex min-w-0 flex-col gap-2", className)} aria-label={ariaLabel}>
      <div
        className={cx("flex min-w-0", isVertical ? "flex-col" : "flex-row")}
        style={{ height: plotHeight, gap: 2 }}
        role="list"
        aria-label={ariaLabel}
      >
        {stages.map((stage, index) => {
          const interactive = Boolean(onStageClick);
          const readout = stage.value === null ? "not reported" : formatter(stage.value);
          const body = (
            <>
              <span
                aria-hidden="true"
                className="absolute inset-0 transition-opacity duration-fast"
                style={{
                  backgroundColor: stage.color,
                  clipPath: clipFor(index),
                  opacity: stage.value === null ? 0.25 : 0.9,
                }}
              />
              <span
                className={cx(
                  "relative z-10 flex min-w-0 flex-1 items-baseline gap-2 px-3",
                  isVertical ? "flex-row" : "flex-col justify-center",
                )}
              >
                <span className="min-w-0 truncate rounded-xs bg-surface-overlay/85 px-1.5 py-0.5 text-meta font-medium text-content backdrop-blur-[1px]">
                  {stage.label}
                </span>
                <span className="ml-auto shrink-0 rounded-xs bg-surface-overlay/85 px-1.5 py-0.5 text-meta font-semibold tabular-nums text-content backdrop-blur-[1px]">
                  {stage.value === null ? "—" : formatter(stage.value)}
                </span>
              </span>
            </>
          );
          const shell = "relative flex min-w-0 flex-1 items-center overflow-hidden text-left";
          return (
            <div key={stage.key} role="listitem" className={cx("flex min-w-0 flex-1")}>
              {interactive ? (
                <button
                  type="button"
                  aria-label={`${stage.label}: ${readout}`}
                  onClick={() => onStageClick?.(data[index] as FunnelStage, index)}
                  className={cx(
                    shell,
                    "w-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  {body}
                </button>
              ) : (
                <div className={cx(shell, "w-full")}>{body}</div>
              )}
            </div>
          );
        })}
      </div>

      {showConversion ? (
        <ul className="flex list-none flex-wrap gap-x-4 gap-y-1 text-meta text-content-muted">
          {stages.map((stage, index) =>
            index === 0 ? null : (
              <li key={stage.key} className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: stage.color }} aria-hidden="true" />
                <span className="truncate">{stage.label}</span>
                <span className="tabular-nums text-content">
                  {stage.stepRate === null ? "—" : formatChartPercent(stage.stepRate)}
                </span>
                {stage.overallRate !== null ? (
                  <span className="text-content-subtle">
                    ({formatChartPercent(stage.overallRate)} of {stages[baseIndex]?.label ?? "start"})
                  </span>
                ) : null}
              </li>
            ),
          )}
        </ul>
      ) : null}

      <MissingStagesNote stages={stages} />

      {footnote ? <figcaption className="text-meta text-content-subtle">{footnote}</figcaption> : null}

      {dataTable ? (
        <ChartDataTable
          caption={ariaLabel}
          categoryHeader="Stage"
          rows={tableRows}
          columns={[
            { key: "value", label: "Count" },
            { key: "step", label: "Step" },
            { key: "overall", label: "Overall" },
          ]}
          summaryLabel={dataTableLabel}
        />
      ) : null}
    </figure>
  );
}

/** Names the stages that were never reported, rather than implying they are 0. */
function MissingStagesNote({ stages }: { stages: ReadonlyArray<ResolvedStage> }): ReactNode {
  const missing = stages.filter((stage) => stage.value === null).map((stage) => stage.label);
  if (missing.length === 0) return null;
  return (
    <p className="text-meta text-content-subtle">
      Not reported: {missing.join(", ")}.
    </p>
  );
}
