/**
 * RECEIVABLES (#518) — every certified application aged against the
 * contract's payment terms: outstanding = certified − receipts, due =
 * certification + terms, overdue = today past due. Without recorded terms
 * nothing is called overdue, and the screen says so rather than guessing.
 */
import { Alert, Badge, Card, CardBody, Spinner } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { MoneyStat, isoDate, money, titleCase, type Loadable } from "./shared";
import type { AgedReceivable, ContractView, ReceivablesView } from "./types";

export default function ReceivablesTab({ contract, receivables, onOpenApplication }: { contract: ContractView; receivables: Loadable<ReceivablesView>; onOpenApplication: (id: string) => void }) {
  const cur = contract.currency;
  const view = receivables.data;
  const columns: DataColumns<AgedReceivable> = [
    { id: "reference", header: "Application", accessor: "reference", type: "code", width: 120, mono: true, sticky: "start" },
    { id: "state", header: "Settlement", accessor: "state", type: "status", width: 140, cell: ({ row }) => <Badge tone={row.state === "paid" ? "success" : row.state === "partially_paid" ? "warning" : "neutral"} dot size="xs">{titleCase(row.state)}</Badge> },
    { id: "certifiedAt", header: "Certified", accessor: "certifiedAt", type: "date", width: 110, cell: ({ row }) => isoDate(row.certifiedAt) },
    { id: "dueDate", header: "Due", accessor: "dueDate", type: "date", width: 110, cell: ({ row }) => (row.dueDate ? isoDate(row.dueDate) : <span className="text-2xs text-content-subtle">no terms</span>) },
    { id: "certified", header: "Certified", accessor: "certified", type: "currency", currency: cur, align: "right", width: 140, mono: true, aggregate: "sum" },
    { id: "paid", header: "Received", accessor: "paid", type: "currency", currency: cur, align: "right", width: 140, mono: true, aggregate: "sum" },
    { id: "outstanding", header: "Outstanding", accessor: "outstanding", type: "currency", currency: cur, align: "right", width: 140, mono: true, aggregate: "sum" },
    { id: "daysOverdue", header: "Days overdue", accessor: "daysOverdue", type: "number", align: "right", width: 120, cell: ({ row }) => (row.daysOverdue === null ? <span className="text-2xs text-content-subtle">—</span> : row.daysOverdue > 0 ? <span className="text-danger-fg">{row.daysOverdue}</span> : "0") },
    { id: "bucket", header: "Bucket", accessor: "bucket", type: "text", width: 90, cell: ({ row }) => <Badge tone={row.bucket === "current" ? "success" : row.bucket === "unknown" ? "neutral" : row.bucket === "1-30" ? "warning" : "danger"} size="xs">{row.bucket}</Badge> },
  ];

  if (receivables.loading && !view) {
    return (
      <div className="py-12">
        <Spinner label="Ageing the receivables…" />
      </div>
    );
  }
  if (receivables.error) return <Alert tone="danger" title="Receivables could not be loaded">{receivables.error}</Alert>;
  if (!view) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-4">
          <MoneyStat label="Certified" value={view.totals.certified} currency={cur} />
          <MoneyStat label="Received" value={view.totals.paid} currency={cur} hint={`${view.receipts} receipt${view.receipts === 1 ? "" : "s"}`} />
          <MoneyStat label="Outstanding" value={view.totals.outstanding} currency={cur} size="lg" />
          <MoneyStat label="Overdue" value={view.totals.overdue} currency={cur} tone={view.totals.overdue > 0 ? "danger" : undefined} hint={view.paymentTermsDays === null ? "no payment terms recorded" : `terms: ${view.paymentTermsDays} days`} />
        </CardBody>
      </Card>
      {view.reasons.length > 0 ? <Alert tone="info" size="sm" title="What the ageing cannot say">{view.reasons.join(" ")}</Alert> : null}
      <div className="grid gap-2 sm:grid-cols-6">
        {view.buckets.map((b) => (
          <Card key={b.bucket}>
            <CardBody className="py-2">
              <div className="text-label uppercase text-content-subtle">{b.bucket}</div>
              <div className="font-mono text-sm font-semibold tabular-nums">{money(b.amount, cur)}</div>
              <div className="text-2xs text-content-subtle">{b.count} application{b.count === 1 ? "" : "s"}</div>
            </CardBody>
          </Card>
        ))}
      </div>
      {view.dunning.length > 0 ? (
        <Alert tone="warning" title={`Dunning list — ${view.dunning.length} overdue application${view.dunning.length === 1 ? "" : "s"}`}>
          <ul className="list-disc pl-4">
            {view.dunning.map((d) => (
              <li key={d.applicationId}>
                {d.reference}: {money(d.outstanding, cur)} outstanding, {d.daysOverdue} days past {isoDate(d.dueDate)}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <DataTable<AgedReceivable>
        tableId="prime-receivables"
        data={view.items}
        columns={columns}
        getRowId={(row) => row.applicationId}
        height={420}
        stickyHeader
        showFooter
        gridLines
        savedViews={false}
        onRowClick={(row) => onOpenApplication(row.applicationId)}
        exportFileName={`receivables-${contract.reference}`}
        empty={{ title: "Nothing certified yet", description: "Receivables begin when an application is certified; until then there is nothing the owner owes." }}
        aria-label={`Receivables ageing for ${contract.reference}`}
      />
    </div>
  );
}
