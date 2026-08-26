/**
 * charts/ChartCard.tsx — the panel every dashboard chart sits in.
 *
 * One wrapper so a dashboard reads as a grid of comparable panels rather than
 * a scrapbook: title and subtitle on the left, actions on the right, an
 * optional hero metric with its delta, the plot, a legend row, and a footnote
 * rail for the disclosures a construction number always needs — "excludes
 * retention", "as at the 12 Aug data date", "unapproved variations included".
 */
import { useId, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "../cx";
import { IconTrendDown, IconTrendUp, type IconComponent } from "../icons";
import { deltaToTone, tone as toneStyles } from "../tokens";
import {
  formatChartDelta,
  type ChartFormatOptions,
  type ValueFormat,
} from "./format";

export interface ChartCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconComponent;
  /** Toolbar on the right of the header: range picker, menu, export. */
  actions?: ReactNode;
  /** Hero number, printed under the title. */
  metric?: ReactNode;
  /** Caption under the hero number. */
  metricCaption?: ReactNode;
  /**
   * Signed change beside the hero number. `null` renders "—", never "0" —
   * "no comparison available" is not the same statement as "no change".
   * With the default `deltaFormat="percent"` this is a FRACTION: -0.043 → −4.3%.
   */
  delta?: number | null;
  deltaFormat?: ValueFormat;
  deltaFormatOptions?: ChartFormatOptions;
  /** Comparison window: "vs last month". */
  deltaCaption?: ReactNode;
  /** Whether a rise is good news. Cost panels want false. */
  higherIsBetter?: boolean;
  /** Row between the header and the plot: filters, segmented control, legend. */
  toolbar?: ReactNode;
  /** Row under the plot. Use when the chart's own legend is turned off. */
  legend?: ReactNode;
  /** Disclosure text in the footer rail. */
  footnote?: ReactNode;
  /** Right-aligned footer content — "Source: Primavera P6 · 12 Aug". */
  footerMeta?: ReactNode;
  /** Remove body padding, for full-bleed plots (Gantt, heatmap). */
  flush?: boolean;
  /** Drop the card chrome — for charts already inside a panel. */
  bare?: boolean;
  loading?: boolean;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function ChartCard({
  title,
  subtitle,
  icon: Icon,
  actions,
  metric,
  metricCaption,
  delta,
  deltaFormat = "percent",
  deltaFormatOptions,
  deltaCaption,
  higherIsBetter = true,
  toolbar,
  legend,
  footnote,
  footerMeta,
  flush = false,
  bare = false,
  loading = false,
  className,
  headerClassName,
  bodyClassName,
  children,
  ...rest
}: ChartCardProps) {
  const headingId = useId();
  const hasDelta = delta !== undefined;
  const numericDelta = typeof delta === "number" && Number.isFinite(delta) ? delta : null;
  const deltaTone = numericDelta === null ? "neutral" : deltaToTone(numericDelta, { higherIsBetter });
  const DeltaIcon = numericDelta === null ? null : numericDelta > 0 ? IconTrendUp : numericDelta < 0 ? IconTrendDown : null;

  return (
    <section
      aria-labelledby={headingId}
      className={cx(
        "flex min-w-0 flex-col",
        !bare && "rounded-lg border border-border bg-surface-raised shadow-e1",
        className,
      )}
      {...rest}
    >
      <header
        className={cx(
          "flex min-w-0 items-start gap-3 px-card pt-card",
          headerClassName,
        )}
      >
        {Icon ? (
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-surface-sunken text-content-muted">
            <Icon size="sm" />
          </span>
        ) : null}

        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="truncate text-sm font-semibold text-content">
            {title}
          </h3>
          {subtitle ? (
            <p className="mt-0.5 line-clamp-2 text-meta text-content-muted">{subtitle}</p>
          ) : null}

          {metric !== undefined || hasDelta ? (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {metric !== undefined ? (
                <span
                  className={cx(
                    "text-display-xs font-semibold tabular-nums text-content",
                    loading && "skeleton min-w-24 rounded-sm text-transparent",
                  )}
                >
                  {metric}
                </span>
              ) : null}

              {hasDelta ? (
                <span
                  className={cx(
                    "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-meta font-medium tabular-nums",
                    toneStyles[deltaTone].subtle,
                  )}
                  title={numericDelta === null ? "No comparison available" : undefined}
                >
                  {DeltaIcon ? <DeltaIcon size={12} /> : null}
                  {numericDelta === null
                    ? "—"
                    : formatChartDelta(numericDelta, deltaFormat, deltaFormatOptions ?? {})}
                </span>
              ) : null}

              {deltaCaption ? (
                <span className="text-meta text-content-subtle">{deltaCaption}</span>
              ) : null}
            </div>
          ) : null}

          {metricCaption ? (
            <p className="mt-0.5 text-meta text-content-subtle">{metricCaption}</p>
          ) : null}
        </div>

        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>

      {toolbar ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 px-card">{toolbar}</div>
      ) : null}

      <div
        className={cx(
          "min-w-0 flex-1",
          flush ? "mt-3" : "px-card pt-3",
          !footnote && !footerMeta && !legend && !flush && "pb-card",
          bodyClassName,
        )}
      >
        {children}
      </div>

      {legend ? <div className={cx("min-w-0 px-card pt-2", !footnote && !footerMeta && "pb-card")}>{legend}</div> : null}

      {footnote || footerMeta ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-baseline justify-between gap-2 border-t border-border-subtle px-card py-2">
          {footnote ? (
            <p className="min-w-0 flex-1 text-meta text-content-subtle">{footnote}</p>
          ) : (
            <span />
          )}
          {footerMeta ? (
            <p className="shrink-0 text-meta text-content-subtle">{footerMeta}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A compact KPI panel: one number, one sparkline slot, one delta.
 * Same visual family as ChartCard so a KPI strip lines up with the charts
 * beneath it.
 */
export interface ChartStatCardProps extends Omit<ChartCardProps, "children"> {
  children?: ReactNode;
}

export function ChartStatCard({ children, flush = true, ...rest }: ChartStatCardProps) {
  return (
    <ChartCard flush={flush} {...rest}>
      {children ?? null}
    </ChartCard>
  );
}
