/**
 * THE BUYOUT LOG — budget versus committed versus projected saving, per budget
 * line. The one report that says whether a project is making or losing money
 * on procurement.
 *
 * Two honesty rules of the API's are carried straight through:
 *
 *  · `projectedSavings` is budget minus BOTH committed and pending. A line
 *    that is 60% bought out with an out-for-signature subcontract for the rest
 *    has no saving; it has a decision already taken. The column says so.
 *  · With no active budget there is nothing to compare against, so the API
 *    returns no rows and a reason. That reason is shown instead of a table of
 *    zeroes, because a table of zeroes would read as "no overspend".
 */
import { useMemo } from "react";
import { Alert, Badge, Card, CardBody, EmptyState, ErrorAlert, Spinner } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { Figure, money, pct, titleCase, type Loadable } from "./shared";
import type { BuyoutLog, BuyoutRow } from "./types";

export default function BuyoutTab({ log }: { log: Loadable<BuyoutLog> }) {
  const data = log.data;
  const currency = data?.currency ?? null;

  const columns = useMemo<DataColumns<BuyoutRow>>(
    () => [
      {
        id: "costCode",
        header: "Cost code",
        accessor: "costCode",
        type: "code",
        width: 130,
        sticky: "start",
        mono: true,
      },
      {
        id: "description",
        header: "Budget line",
        accessor: "description",
        type: "text",
        width: 280,
      },
      {
        id: "costType",
        header: "Cost type",
        accessor: (row) => titleCase(row.costType),
        type: "text",
        width: 130,
        groupable: true,
      },
      {
        id: "revisedBudget",
        header: "Revised budget",
        accessor: "revisedBudget",
        type: "currency",
        currency: currency ?? "USD",
        precision: 2,
        align: "right",
        width: 150,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "committed",
        header: "Committed",
        headerTooltip: "Approved and complete commitments only — real money we owe.",
        accessor: "committed",
        type: "currency",
        currency: currency ?? "USD",
        precision: 2,
        align: "right",
        width: 150,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "pendingCommitted",
        header: "Pending",
        headerTooltip:
          "Out for bid or out for signature. Exposure we have created but not yet signed — deliberately a separate column.",
        accessor: "pendingCommitted",
        type: "currency",
        currency: currency ?? "USD",
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "projectedSavings",
        header: "Projected saving",
        headerTooltip:
          "Revised budget less committed AND pending. Negative is an overrun on that line.",
        accessor: "projectedSavings",
        type: "currency",
        currency: currency ?? "USD",
        precision: 2,
        align: "right",
        width: 160,
        mono: true,
        signColor: true,
        aggregate: "sum",
      },
      {
        id: "percentBoughtOut",
        header: "% bought out",
        accessor: (row) => row.percentBoughtOut.value,
        type: "custom",
        align: "right",
        width: 170,
        truncate: false,
        cell: ({ row }) => (
          <Figure
            figure={row.percentBoughtOut}
            render={(v) => <span className="font-mono tabular-nums">{pct(v)}</span>}
            className="block text-right"
          />
        ),
        toCsv: ({ row }) =>
          row.percentBoughtOut.value === null
            ? row.percentBoughtOut.reasons.join(" ")
            : row.percentBoughtOut.value,
      },
      {
        id: "commitmentCount",
        header: "Commitments",
        accessor: "commitmentCount",
        type: "number",
        align: "right",
        width: 130,
        aggregate: "sum",
        cell: ({ row }) =>
          row.commitmentCount === 0 ? (
            <span className="text-2xs italic text-content-subtle">still to buy</span>
          ) : (
            <span className="tabular-nums">{row.commitmentCount}</span>
          ),
      },
      {
        id: "state",
        header: "State",
        accessor: (row) => (row.boughtOut ? "Bought out" : row.commitmentCount === 0 ? "Unbought" : "In progress"),
        type: "text",
        width: 130,
        cell: ({ row }) =>
          row.boughtOut ? (
            <Badge tone="success" size="xs" dot>
              Bought out
            </Badge>
          ) : row.commitmentCount === 0 ? (
            <Badge tone="neutral" size="xs">
              Unbought
            </Badge>
          ) : (
            <Badge tone="info" size="xs" dot>
              In progress
            </Badge>
          ),
      },
      {
        id: "excludedCurrencies",
        header: "Excluded",
        headerTooltip:
          "Commitments on this line written in another currency. They are not counted against the budget, because figures in different currencies are never summed.",
        accessor: (row) => row.excludedCurrencies.join(", "),
        type: "text",
        width: 150,
        truncate: false,
        cell: ({ row }) =>
          row.excludedCurrencies.length === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="text-2xs text-warning-fg">
              {row.excludedCurrencies.join(", ")} excluded
            </span>
          ),
      },
    ],
    [currency],
  );

  if (log.loading && !data) {
    return (
      <div className="py-12">
        <Spinner label="Loading the buyout log…" />
      </div>
    );
  }
  if (log.error) {
    return <ErrorAlert message={log.error} onRetry={log.reload} />;
  }
  if (!data) return null;

  /* No budget is not an empty buyout log — it is a different statement. */
  if (data.budgetId === null) {
    return (
      <EmptyState
        title="No buyout log can be produced"
        hint={data.notes.join(" ")}
        icon={undefined}
      />
    );
  }

  return (
    <div className="space-y-4">
      {data.notes.map((note) => (
        <Alert key={note} tone="info" size="sm">
          {note}
        </Alert>
      ))}

      {data.totals && data.currency ? (
        <Card>
          <CardBody className="grid gap-4 sm:grid-cols-4">
            <Total label="Revised budget" value={data.totals.revisedBudget} currency={data.currency} />
            <Total label="Committed" value={data.totals.committed} currency={data.currency} />
            <Total label="Pending" value={data.totals.pendingCommitted} currency={data.currency} />
            <Total
              label="Projected saving"
              value={data.totals.projectedSavings}
              currency={data.currency}
              tone={data.totals.projectedSavings < 0 ? "danger" : "success"}
              hint={
                data.totals.projectedSavings < 0
                  ? "Negative: committed and pending exceed the budget on these lines."
                  : "Budget still unspent and uncommitted across these lines."
              }
            />
          </CardBody>
        </Card>
      ) : null}

      <p className="text-2xs text-content-subtle">
        Every figure is in {data.currency}, the active budget&rsquo;s currency. Commitments written
        in any other currency are excluded from the comparison rather than converted, and the rows
        they would have hit name them in the Excluded column.
        {data.unboughtLineCount > 0
          ? ` ${data.unboughtLineCount} budget line${data.unboughtLineCount === 1 ? " has" : "s have"} no commitment against ${data.unboughtLineCount === 1 ? "it" : "them"} at all — that is the buyout still to come.`
          : null}
      </p>

      <DataTable<BuyoutRow>
        tableId="commitments-buyout"
        data={data.rows}
        columns={columns}
        getRowId={(row) => row.budgetLineItemId}
        loading={log.loading}
        height={560}
        stickyHeader
        showFooter
        stickyFooter
        gridLines
        filterRow
        savedViews
        exportFileName="buyout-log"
        defaultSort={[{ id: "costCode", desc: false }]}
        rowTone={(row) => (row.projectedSavings < 0 ? "danger" : undefined)}
        empty={{
          title: "The active budget has no lines",
          description:
            "A buyout log compares committed cost against budget lines. This budget has none, so there is nothing to compare.",
        }}
        aria-label="Buyout log"
      />
    </div>
  );
}

function Total({
  label,
  value,
  currency,
  tone,
  hint,
}: {
  label: string;
  value: number;
  currency: string;
  tone?: "danger" | "success";
  hint?: string;
}) {
  return (
    <div>
      <div className="text-label uppercase text-content-subtle">{label}</div>
      <div
        className={
          "mt-0.5 text-lg font-semibold tabular-nums " +
          (tone === "danger" ? "text-danger-fg" : tone === "success" ? "text-success-fg" : "text-content")
        }
      >
        {money(value, currency)}
      </div>
      {hint ? <p className="mt-0.5 text-2xs text-content-subtle">{hint}</p> : null}
    </div>
  );
}
