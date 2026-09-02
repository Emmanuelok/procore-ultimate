/**
 * The change pipeline — exposure identified, priced, asked for, executed.
 *
 * Most of the money that leaks on a construction project leaks in the gaps
 * between those four states, so the panel reports the chain rather than a
 * single "change orders" number. The change-log endpoint reconciles per
 * currency and refuses to produce one figure across currencies; this panel
 * shows the bucket for the selected currency and says where the others are.
 */
import { Link } from "react-router-dom";
import { Alert } from "../../../ui";
import { IconChangeOrder } from "../../../ui/icons";
import {
  Figure,
  StatLine,
  money,
  pct,
  type Loadable,
} from "../../../layouts/project/lib";
import Panel from "./Panel";
import type { ChangeLog } from "./types";

export interface ChangePanelProps {
  currency: string;
  changeLog: Loadable<ChangeLog>;
  className?: string;
}

export default function ChangePanel({ currency, changeLog, className }: ChangePanelProps) {
  const data = changeLog.data;
  const group = data?.groups.find((g) => g.currency === currency) ?? null;
  const others = (data?.currencies ?? []).filter((code) => code !== currency);

  const nothingRaised =
    group !== null &&
    group.events.total === 0 &&
    group.pcos.total === 0 &&
    group.cors.total === 0 &&
    group.packages.total === 0;

  return (
    <Panel
      className={className}
      title="Change pipeline"
      subtitle={`Exposure identified through to executed · ${currency}`}
      icon={IconChangeOrder}
      loading={changeLog.loading && !data}
      error={changeLog.error}
      onRetry={changeLog.reload}
      isEmpty={group === null || nothingRaised}
      emptyTitle={group === null ? `No change record in ${currency}` : "No change raised yet"}
      emptyHint={
        group === null
          ? others.length > 0
            ? `This project's change records are denominated in ${others.join(", ")}. Change is reconciled inside one currency and never across them.`
            : "The change log has not been read for this project."
          : "No change event, potential change order, change order request or package exists on this project yet. The chain starts with a change event when something happens on site."
      }
      actions={
        <Link
          to="changes"
          className="rounded px-1 text-meta text-accent-text underline-offset-2 hover:underline"
        >
          Open
        </Link>
      }
      footer={
        group
          ? "Requested is every change order request that has left draft. Approved is what the owner granted, which is rarely the same number."
          : undefined
      }
    >
      {group && !nothingRaised ? (
        <div className="space-y-3">
          {data?.mixedCurrency ? (
            <Alert tone="info" size="sm" title="More than one currency on this project">
              {data.reasons.join(" ")}
            </Alert>
          ) : null}

          <dl className="space-y-1.5">
            <StatLine
              label={`Change events (${group.events.total})`}
              value={money(group.events.latestCostTotal, currency)}
            />
            <StatLine
              label={`Potential change orders (${group.pcos.total})`}
              value={money(group.pcos.positionTotal, currency)}
            />
            <StatLine
              label={`Requested of the owner (${group.cors.total})`}
              value={money(group.cors.requestedTotal, currency)}
            />
            <StatLine
              label="Approved by the owner"
              value={money(group.cors.approvedTotal, currency)}
              strong
            />
            <StatLine
              label="Negotiation gap"
              value={money(group.cors.negotiationGap, currency)}
              tone={group.cors.negotiationGap > 0 ? "warning" : undefined}
            />
          </dl>

          <div className="border-t border-border-subtle pt-3">
            <dl className="space-y-1.5">
              <StatLine
                label="Approval rate"
                value={
                  <Figure
                    figure={group.cors.approvalRatePercent}
                    render={(value) => pct(value, 1)}
                  />
                }
              />
              <StatLine
                label={`Executed on the prime contract (${group.packages.total} package${group.packages.total === 1 ? "" : "s"})`}
                value={money(group.packages.executedPrimeTotal, currency)}
              />
              <StatLine
                label="Executed down to commitments"
                value={money(group.packages.executedCommitmentTotal, currency)}
              />
              <StatLine
                label="Margin on executed change"
                value={
                  <Figure
                    figure={group.marginTotal.marginPercent}
                    render={(value) => pct(value, 1)}
                  />
                }
              />
            </dl>
          </div>

          {group.events.openScheduleImpactDays !== 0 ? (
            <div className="border-t border-border-subtle pt-3">
              <StatLine
                label="Schedule impact on open events"
                value={`${group.events.openScheduleImpactDays} days`}
                tone={group.events.openScheduleImpactDays > 0 ? "warning" : undefined}
              />
            </div>
          ) : null}

          {!group.ok ? (
            <Alert tone="warning" size="sm" title="The change log does not reconcile">
              At least one arithmetic identity on this project&rsquo;s change chain does not hold.
              Open Change Management to see which figures disagree and by how much.
            </Alert>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
