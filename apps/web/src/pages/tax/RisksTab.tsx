/**
 * RISKS — the assurance signals the tax sweeps raise on this project
 * (missing registration on a paying vendor, withholding not deducted,
 * reverse charge misapplied, PE threshold, return overdue) and the vendor
 * coverage table they draw on. The sweep runs hourly on the scheduler; the
 * button runs it now.
 */
import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Drawer, toast, type DataColumns } from "../../ui";
import { IconRefresh } from "../../ui/icons";
import {
  DASH,
  DETECTOR_LABEL,
  LoadError,
  ReasonList,
  Row,
  count,
  dateTime,
  severityTone,
  taxApi,
  titleCase,
  useAction,
  useResource,
  type Paginated,
  type ScanResult,
  type TaxSignal,
  type VendorCoverage,
  type VendorsCoverageResponse,
} from "./taxShared";

export default function RisksTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [includeClosed, setIncludeClosed] = useState(false);
  const [open, setOpen] = useState<TaxSignal | null>(null);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const action = useAction();

  const params = new URLSearchParams({ page: "1", pageSize: "500" });
  if (includeClosed) params.set("includeClosed", "true");
  const risks = useResource<Paginated<TaxSignal>>(`/api/v1/projects/${projectId}/tax/risks?${params.toString()}`);
  const coverage = useResource<VendorsCoverageResponse>(`/api/v1/projects/${projectId}/tax/vendors`);

  async function scan() {
    const res = await action.run("scan", () => taxApi.scan(projectId));
    if (res) {
      setLastScan(res);
      toast.success(`Scan complete — ${res.signalsRaised + res.peSignalsRaised} new signal${res.signalsRaised + res.peSignalsRaised === 1 ? "" : "s"}`);
      risks.reload();
      coverage.reload();
      onChanged();
    }
  }

  const signalColumns = useMemo<DataColumns<TaxSignal>>(
    () => [
      { id: "severity", header: "Severity", accessor: "severity", type: "text", width: 100, cell: ({ row }) => <Badge tone={severityTone(row.severity)} size="xs" dot>{titleCase(row.severity)}</Badge> },
      { id: "detector", header: "Detector", accessor: (row) => DETECTOR_LABEL[row.detector] ?? row.detector, type: "text", width: 180 },
      { id: "title", header: "Signal", accessor: "title", type: "text", width: 460 },
      { id: "confidence", header: "Confidence", accessor: "confidence", type: "number", align: "right", width: 100, cell: ({ row }) => `${Math.round(row.confidence * 100)}%` },
      { id: "disposition", header: "Disposition", accessor: "disposition", type: "text", width: 120, cell: ({ row }) => titleCase(row.disposition) },
      { id: "createdAt", header: "Raised", accessor: "createdAt", type: "datetime", width: 160, cell: ({ row }) => dateTime(row.createdAt) },
    ],
    [],
  );

  const coverageColumns = useMemo<DataColumns<VendorCoverage>>(
    () => [
      { id: "name", header: "Vendor", accessor: "name", type: "text", width: 240 },
      { id: "country", header: "Country", accessor: (row) => row.country ?? "", type: "text", width: 90, cell: ({ row }) => row.country ?? DASH },
      { id: "commitments", header: "Commitments (approved)", accessor: "commitments", type: "number", align: "right", width: 170, cell: ({ row }) => `${row.commitments} (${row.approved})` },
      {
        id: "registrations",
        header: "Registrations under the regime",
        accessor: (row) => row.registrations.map((r) => r.kind).join(", "),
        type: "text",
        width: 320,
        cell: ({ row }) =>
          row.registrations.length === 0 ? (
            <span className="italic text-content-subtle">none on file</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {row.registrations.map((r) => (
                <Badge key={r.id} tone={r.verificationStatus === "verified" ? "success" : r.status === "active" ? "warning" : "neutral"} size="xs">
                  {r.kind.toUpperCase()}
                  {r.number ? ` ${r.number}` : ""} · {titleCase(r.verificationStatus)}
                  {r.deductionRate !== null ? ` · ${r.deductionRate}%` : ""}
                </Badge>
              ))}
            </span>
          ),
      },
      {
        id: "covered",
        header: "Coverage",
        accessor: (row) => (row.verified ? "verified" : row.covered ? "on file" : "missing"),
        type: "text",
        width: 120,
        cell: ({ row }) => (
          <Badge tone={row.verified ? "success" : row.covered ? "warning" : "danger"} size="xs" dot>
            {row.verified ? "Verified" : row.covered ? "On file, unverified" : "Missing"}
          </Badge>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Open tax risk signals"
          subtitle="Raised once per condition and closed automatically when the condition clears (a registration recorded, a certificate issued). Review and dispose of them in Assurance."
          actions={
            <div className="flex items-center gap-3">
              <Checkbox checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} label="Include closed" size="sm" />
              <Button size="sm" icon={IconRefresh} onClick={() => void scan()} loading={action.busy === "scan"}>
                Run scan now
              </Button>
            </div>
          }
        />
        <CardBody flush>
          {action.error ? (
            <div className="p-3">
              <Alert tone="danger" size="sm">{action.error}</Alert>
            </div>
          ) : null}
          {lastScan ? (
            <div className="border-b border-border px-4 py-2 text-2xs text-content-subtle">
              Last scan {dateTime(lastScan.ranAt)}: {count(lastScan.overduePeriods)} overdue returns, {count(lastScan.verificationsExpired)} verifications lapsed, {count(lastScan.missingRegistrations)} missing registrations raised (
              {count(lastScan.missingRegistrationsCleared)} cleared), {count(lastScan.whtNotDeducted)} payments without a deduction certificate, {count(lastScan.reverseChargeMisapplied)} reverse charges misapplied,{" "}
              {count(lastScan.peRecomputed)} PE exposures recomputed ({count(lastScan.peSignalsRaised)} signals). The sweep runs company-wide.
            </div>
          ) : null}
          {risks.error ? (
            <div className="p-4">
              <LoadError message={risks.error} onRetry={risks.reload} />
            </div>
          ) : (
            <DataTable<TaxSignal>
              tableId="tax.risks"
              data={risks.data?.items ?? []}
              columns={signalColumns}
              getRowId={(row) => row.id}
              loading={risks.loading && !risks.data}
              height={360}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: includeClosed ? "No tax signals on this project" : "No open tax signals",
                description: "Nothing here means the sweeps found no missing registration, undeducted withholding, misapplied reverse charge, overdue return or PE breach — not that none can happen. Run a scan to check now.",
              }}
              onRowClick={({ row }) => setOpen(row)}
              rowTone={(row) => (row.disposition === "closed" ? "neutral" : severityTone(row.severity))}
              aria-label="Tax risk signals"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Vendor coverage"
          subtitle={coverage.data?.regime ? `Vendors with commitments on this project and their registrations under ${coverage.data.regime.toUpperCase()}. A paying vendor with nothing on file is what the missing-registration signal is about.` : "Vendors with commitments on this project."}
        />
        <CardBody flush>
          {coverage.error ? (
            <div className="p-4">
              <LoadError message={coverage.error} onRetry={coverage.reload} />
            </div>
          ) : (
            <>
              {coverage.data && coverage.data.reasons.length > 0 ? <ReasonList reasons={coverage.data.reasons} className="px-4 py-2" /> : null}
              <DataTable<VendorCoverage>
                tableId="tax.vendor-coverage"
                data={coverage.data?.items ?? []}
                columns={coverageColumns}
                getRowId={(row) => row.id}
                loading={coverage.loading && !coverage.data}
                height={320}
                rowHeight={48}
                stickyHeader
                flush
                toolbar={false}
                empty={{ title: "No vendors with commitments on this project", description: "Coverage is measured against commitments; there are none yet." }}
                rowTone={(row) => (row.verified ? undefined : row.covered ? "warning" : "danger")}
                aria-label="Vendor tax registration coverage"
              />
            </>
          )}
        </CardBody>
      </Card>

      <Drawer open={open !== null} onClose={() => setOpen(null)} size="md" title={open ? open.title : "Signal"} description={open ? `${DETECTOR_LABEL[open.detector] ?? open.detector} · ${titleCase(open.severity)} · ${Math.round(open.confidence * 100)}% confidence` : undefined}>
        {open ? (
          <div className="space-y-4">
            <p className="text-meta text-content">{open.explanation}</p>
            <dl className="divide-y divide-border">
              <Row label="Disposition">{titleCase(open.disposition)}</Row>
              <Row label="Raised">{dateTime(open.createdAt)}</Row>
            </dl>
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">Evidence references</div>
              <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken p-2 text-2xs text-content">{JSON.stringify(open.evidenceRefs, null, 2)}</pre>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
