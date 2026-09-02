/**
 * RETAINAGE (#517) — held by line, the releases raised against this contract
 * (the invoicing module's retainage-release workflow), and the contractual
 * proposal: a step-down once the work passes the threshold, or the final
 * release at substantial completion — each with the gate that must be clear
 * first (open applications, in-flight releases, downstream lien waivers,
 * compliance).
 */
import { Alert, Badge, Card, CardBody, Spinner } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { ComponentValue, MoneyStat, isoDate, money, pct, statusToneOf, titleCase, type Loadable } from "./shared";
import type { ContractView, RetainageRelease, RetainageView } from "./types";

export default function RetainageTab({ contract, retainage }: { contract: ContractView; retainage: Loadable<RetainageView> }) {
  const cur = contract.currency;
  const view = retainage.data;

  const byLine: DataColumns<RetainageView["byLine"][number]> = [
    { id: "lineNumber", header: "Item", accessor: "lineNumber", type: "code", width: 90, mono: true, sticky: "start" },
    { id: "description", header: "Description", accessor: "description", type: "text", width: 260 },
    { id: "totalCompletedAndStored", header: "Completed and stored", accessor: "totalCompletedAndStored", type: "currency", currency: cur, align: "right", width: 170, mono: true, aggregate: "sum" },
    { id: "retainagePercent", header: "Rate", accessor: "retainagePercent", type: "percent", align: "right", width: 90, cell: ({ row }) => pct(row.retainagePercent) },
    { id: "retainageHeld", header: "Held", accessor: "retainageHeld", type: "currency", currency: cur, align: "right", width: 140, mono: true, aggregate: "sum" },
    { id: "retainageReleased", header: "Released", accessor: "retainageReleased", type: "currency", currency: cur, align: "right", width: 140, mono: true, aggregate: "sum" },
  ];
  const releases: DataColumns<RetainageRelease> = [
    { id: "reference", header: "Release", accessor: "reference", type: "code", width: 120, mono: true },
    { id: "status", header: "Status", accessor: "status", type: "status", width: 150, cell: ({ row }) => <Badge tone={statusToneOf(row.status)} dot size="xs">{titleCase(row.status)}</Badge> },
    { id: "basis", header: "Basis", accessor: (row) => titleCase(row.basis), type: "text", width: 180 },
    { id: "amount", header: "Amount", accessor: "amount", type: "currency", currency: cur, align: "right", width: 140, mono: true },
    { id: "after", header: "Held after", accessor: "retainageHeldAfter", type: "currency", currency: cur, align: "right", width: 140, mono: true },
    { id: "newRate", header: "New rate", accessor: "newRetainagePercent", type: "percent", width: 100, cell: ({ row }) => (row.newRetainagePercent === null ? "—" : pct(row.newRetainagePercent)) },
    { id: "effectiveDate", header: "Effective", accessor: "effectiveDate", type: "date", width: 110, cell: ({ row }) => isoDate(row.effectiveDate) },
  ];

  if (retainage.loading && !view) {
    return (
      <div className="py-12">
        <Spinner label="Loading retainage…" />
      </div>
    );
  }
  if (retainage.error) return <Alert tone="danger" title="Retainage could not be loaded">{retainage.error}</Alert>;
  if (!view) return null;

  const p = view.proposal;
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-4">
          <MoneyStat label="Held now" value={view.held} currency={cur} size="lg" />
          <MoneyStat label="Released to date" value={view.released} currency={cur} />
          <div>
            <div className="text-label uppercase text-content-subtle">Work complete</div>
            <div className="mt-0.5 text-base font-semibold tabular-nums">
              <ComponentValue component={view.percentComplete} render={(v) => pct(v, 1)} />
            </div>
          </div>
          <div>
            <div className="text-label uppercase text-content-subtle">Terms</div>
            <div className="mt-0.5 text-sm">
              {pct(contract.retainageTerms.workPercent)} on work
              {contract.retainageTerms.reductionThresholdPercent !== null && contract.retainageTerms.reducedPercent !== null
                ? `, stepping to ${pct(contract.retainageTerms.reducedPercent)} at ${pct(contract.retainageTerms.reductionThresholdPercent)} complete`
                : ", no step-down clause"}
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              Proposal{" "}
              <Badge tone={p.kind === "none" ? "neutral" : p.gate.ok ? "success" : "warning"} size="xs">
                {p.kind === "none" ? "nothing due" : p.kind === "final" ? "final release" : "step-down"}
              </Badge>
            </h3>
            {p.amount.value !== null ? <span className="font-mono text-base font-semibold tabular-nums">{money(p.amount.value, cur)}</span> : null}
          </div>
          <p className="text-meta text-content-muted">{p.rationale}</p>
          {p.amount.value === null && p.amount.reasons.length > 0 ? <p className="text-2xs text-content-subtle">{p.amount.reasons.join(" ")}</p> : null}
          {p.kind !== "none" ? (
            <div className="text-meta">
              <p className={p.gate.ok ? "text-success-fg" : "text-warning-fg"}>{p.gate.ok ? "The gate is clear — raise the release from the invoicing workspace." : "The gate is not clear:"}</p>
              {!p.gate.ok ? <ul className="list-disc pl-4">{p.gate.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
            </div>
          ) : null}
          <p className="text-2xs text-content-subtle">
            {view.gate.openApplications} open application{view.gate.openApplications === 1 ? "" : "s"} · {view.gate.outstandingLienWaivers.length} commitment{view.gate.outstandingLienWaivers.length === 1 ? "" : "s"} still awaiting a lien waiver · compliance {view.gate.compliance.ok ? "clear" : `blocked (${view.gate.compliance.blocking.length})`}
          </p>
        </CardBody>
      </Card>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Held by line</h3>
        <DataTable<RetainageView["byLine"][number]> tableId="prime-retainage-lines" data={view.byLine} columns={byLine} getRowId={(row) => row.sovLineId} height={360} stickyHeader showFooter gridLines savedViews={false} exportFileName={`retainage-${contract.reference}`} empty={{ title: "No schedule of values", description: "Retainage is held per line as applications are certified." }} aria-label={`Retainage by line for ${contract.reference}`} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Releases</h3>
        <DataTable<RetainageRelease> tableId="prime-retainage-releases" data={view.releases} columns={releases} getRowId={(row) => row.id} height={280} stickyHeader gridLines savedViews={false} empty={{ title: "No release raised", description: "A retainage release is an approval event with money attached — somebody asks, somebody else agrees. Raise one from the invoicing workspace when the proposal's gate is clear." }} aria-label={`Retainage releases for ${contract.reference}`} />
      </div>
    </div>
  );
}
