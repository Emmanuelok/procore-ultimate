/**
 * THE MARKUP STACK, as an ordered audit trail.
 *
 * A markup stack applied in the wrong order is one of the classic sources of
 * change-order dispute: 10% overhead then 5% profit on the running total is
 * not the same money as 5% profit then 10% overhead, and neither is the same
 * as both taken on cost. So this component never prints a single "markup"
 * figure. It prints the build-up, in sequence, and for every step it names:
 *
 *   the label      what is being charged ("Overhead", "Bond", "Insurance")
 *   the basis      WHAT the rate multiplied, in words, plus the exact figure
 *   the rate       the percentage, the flat amount or the per-unit rate
 *   the amount     what is actually charged, and the uncapped figure when a
 *                  contractual cap bit
 *   the running    cost + every markup up to and including this step
 *
 * The API computes and stores all of this (`AppliedMarkup`); nothing here is
 * recomputed client-side, because a screen that re-derives the number is a
 * second implementation waiting to disagree with the first.
 */
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState } from "../../ui";
import { IconLayers } from "../../ui/icons";
import {
  COST_TYPES,
  COST_TYPE_LABEL,
  MARKUP_BASIS_EXPLAIN,
  Reasons,
  label,
  money,
  num,
  percent,
  type AppliedMarkup,
  type MarkupStackResult,
} from "./changesShared";

function rateText(step: AppliedMarkup): string {
  if (step.kind === "percent") return percent(step.rate, 4);
  if (step.kind === "per_unit") return `${num(step.rate, 4)} / unit`;
  return "flat amount";
}

function basisText(step: AppliedMarkup, currency: string | null): string {
  const explain = MARKUP_BASIS_EXPLAIN[step.basis] ?? step.basis;
  const narrowed =
    step.costTypes && step.costTypes.length > 0
      ? ` — ${step.costTypes.map((t) => label(t)).join(", ")} only`
      : "";
  if (step.basis === "none") return explain;
  if (step.basis === "quantity") return `${explain}${narrowed} (${num(step.basisAmount, 4)})`;
  return `${explain}${narrowed} (${money(step.basisAmount, currency)})`;
}

export function MarkupStackTable({
  stack,
  currency,
  title = "Markup stack",
  subtitle,
}: {
  stack: MarkupStackResult;
  currency: string | null;
  title?: string;
  subtitle?: string;
}) {
  const costTypeRows = COST_TYPES.filter((t) => (stack.costByType[t] ?? 0) !== 0);

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={
          subtitle ??
          "Applied in sequence. Each step names the figure its rate multiplied, so the order the stack was applied in is auditable rather than assumed."
        }
        icon={IconLayers}
      />
      <CardBody className="space-y-4">
        {stack.reasons.length > 0 ? (
          <Reasons
            reasons={stack.reasons}
            tone="danger"
            title="This total rests on a figure the cost lines do not support"
          />
        ) : null}

        {/* ---- the cost base, by cost type ---- */}
        <div>
          <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
            Cost base
          </p>
          {costTypeRows.length === 0 ? (
            <p className="text-meta text-content-muted">
              No cost lines carry an amount yet, so there is no base for a markup to apply to.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-meta">
                <tbody className="divide-y divide-border-subtle">
                  {costTypeRows.map((type) => (
                    <tr key={type}>
                      <td className="py-1.5 pr-3 text-content-muted">{COST_TYPE_LABEL[type]}</td>
                      <td className="py-1.5 text-right tabular-nums text-content">
                        {money(stack.costByType[type] ?? 0, currency)}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="py-1.5 pr-3 text-content">Cost subtotal</td>
                    <td className="py-1.5 text-right tabular-nums text-content">
                      {money(stack.costSubtotal, currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---- the ordered build-up ---- */}
        <div>
          <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
            Build-up, in order
          </p>
          {stack.applied.length === 0 ? (
            <EmptyState
              size="sm"
              title="No markups on this stack"
              hint="The amount is the cost subtotal plus tax. Overhead, profit, bond and insurance are charged only when they are on the stack — an implied markup is not a markup."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-meta">
                <thead>
                  <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
                    <th className="w-10 py-1.5 pr-2 text-left font-semibold">#</th>
                    <th className="py-1.5 pr-3 text-left font-semibold">Markup</th>
                    <th className="py-1.5 pr-3 text-left font-semibold">Applied to</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Rate</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Amount</th>
                    <th className="py-1.5 text-right font-semibold">Running total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {stack.applied.map((step) => (
                    <tr key={`${step.sequence}-${step.label}`} className="align-top">
                      <td className="py-2 pr-2 font-mono text-2xs text-content-subtle">
                        {step.sequence + 1}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="font-medium text-content">{step.label}</span>
                        <span className="mt-0.5 block text-2xs text-content-subtle">
                          {label(step.kind)}
                        </span>
                        {step.reasons.length > 0 ? (
                          <span className="mt-1 block text-2xs leading-snug text-danger-fg">
                            {step.reasons.join(" ")}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-content-muted">{basisText(step, currency)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-content">
                        {rateText(step)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-content">
                        {money(step.amount, currency)}
                        {step.cappedBy !== null ? (
                          <span className="mt-0.5 block whitespace-nowrap text-2xs text-warning-fg">
                            capped at {money(step.cappedBy, currency)} — uncapped{" "}
                            {money(step.computedAmount, currency)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums text-content">
                        {money(step.runningTotalAfter, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-border">
                  <tr>
                    <td />
                    <td className="py-2 pr-3 text-content-muted">Markup total</td>
                    <td />
                    <td />
                    <td className="py-2 pr-3 text-right tabular-nums text-content">
                      {money(stack.markupTotal, currency)}
                    </td>
                    <td />
                  </tr>
                  {stack.taxTotal !== 0 ? (
                    <tr>
                      <td />
                      <td className="py-2 pr-3 text-content-muted">Tax</td>
                      <td />
                      <td />
                      <td className="py-2 pr-3 text-right tabular-nums text-content">
                        {money(stack.taxTotal, currency)}
                      </td>
                      <td />
                    </tr>
                  ) : null}
                  <tr className="text-body font-semibold">
                    <td />
                    <td className="py-2 pr-3 text-content">Total</td>
                    <td />
                    <td />
                    <td />
                    <td className="py-2 text-right tabular-nums text-content">
                      {money(stack.total, currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          <Badge tone="neutral" size="xs">
            Cost {money(stack.costSubtotal, currency)}
          </Badge>
          <Badge tone="info" size="xs">
            Markup {money(stack.markupTotal, currency)}
          </Badge>
          <Badge tone="neutral" size="xs">
            Tax {money(stack.taxTotal, currency)}
          </Badge>
          <Badge tone="accent" size="xs">
            Total {money(stack.total, currency)}
          </Badge>
          <span className="text-2xs text-content-subtle">
            Margin over cost is the markup, not the tax: {money(stack.margin, currency)}
          </span>
        </div>

        {stack.applied.length > 1 ? (
          <Alert tone="info" variant="subtle" size="sm" title="Why the order is printed">
            Two stacks with the same rates and a different order produce different money. The
            sequence above is the sequence the server applied and stored; it is what a change order
            can be defended with.
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default MarkupStackTable;
