/** The drawing log report (#281): every sheet, its revisions, and its last distribution. Exportable as CSV. */
import { useMemo, useState } from "react";
import { Alert, Badge, Button, DataTable, Drawer, EmptyState, type DataColumns } from "../../ui";
import { IconDownload, IconSpreadsheet } from "../../ui/icons";
import { fetchBlobUrl } from "../../lib/api";
import { useResource } from "../../layouts/project/lib";
import { humanize, formatDate, formatDateTime } from "../format";
import { verdictTone, type LogRow } from "./drawingsShared";

export default function LogTab({ projectId, version }: { projectId: string; version: number }) {
  const log = useResource<{ items: LogRow[]; total: number; generatedAt: string }>(`/api/v1/projects/${projectId}/sheets/log?_v=${version}`);
  const [open, setOpen] = useState<LogRow | null>(null);
  const [exporting, setExporting] = useState(false);

  async function exportCsv() {
    setExporting(true);
    try {
      const url = await fetchBlobUrl(`/api/v1/projects/${projectId}/sheets/log?format=csv`);
      const a = document.createElement("a");
      a.href = url;
      a.download = "drawing-log.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setExporting(false);
    }
  }

  const rows = log.data?.items ?? [];
  const columns = useMemo<DataColumns<LogRow>>(
    () => [
      { id: "number", header: "Number", accessor: "number", type: "code", width: 110, mono: true, sticky: "start" },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 260, truncate: true },
      { id: "discipline", header: "Discipline", accessor: "discipline", type: "status", width: 130, groupable: true, cell: ({ row }) => humanize(row.discipline) },
      { id: "area", header: "Area", accessor: (r) => r.area ?? "", type: "text", width: 100, groupable: true, cell: ({ row }) => row.area ?? "—" },
      { id: "rev", header: "Rev", accessor: (r) => r.currentRevision ?? "", type: "code", width: 60, mono: true, cell: ({ row }) => row.currentRevision ?? "—" },
      { id: "count", header: "Revs", accessor: "revisionCount", type: "number", align: "right", width: 60 },
      { id: "issued", header: "Issued", accessor: (r) => r.issuedDate ?? "", type: "text", width: 100, cell: ({ row }) => formatDate(row.issuedDate) },
      { id: "set", header: "Set", accessor: (r) => r.setName ?? "", type: "text", width: 160, truncate: true, cell: ({ row }) => row.setName ?? "—" },
      { id: "change", header: "Change", accessor: (r) => r.changeVerdict ?? "", type: "status", width: 110, cell: ({ row }) => (row.changeVerdict ? <Badge tone={verdictTone(row.changeVerdict)} size="xs">{row.changeVerdict}</Badge> : <span className="text-ink-400">first</span>) },
      { id: "lastIssue", header: "Last issue", accessor: (r) => r.lastIssuedReference ?? "", type: "code", width: 100, mono: true, cell: ({ row }) => row.lastIssuedReference ?? "—" },
      { id: "issuedAt", header: "Issued at", accessor: (r) => r.lastIssuedAt ?? "", type: "text", width: 150, cell: ({ row }) => formatDateTime(row.lastIssuedAt) },
      { id: "ack", header: "Ack", accessor: (r) => r.acknowledged ?? "", type: "text", width: 70, cell: ({ row }) => row.acknowledged ?? "—" },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {log.error ? <Alert tone="danger" title="The drawing log could not be loaded">{log.error}</Alert> : null}
      {!log.loading && rows.length === 0 ? (
        <EmptyState icon={IconSpreadsheet} title="The drawing log is empty" hint="Upload a drawing set to populate it." />
      ) : (
        <DataTable<LogRow>
          tableId="drawing-log"
          data={rows}
          columns={columns}
          getRowId={(r) => r.sheetId}
          loading={log.loading}
          height={560}
          stickyHeader
          gridLines
          toolbarActions={<Button size="sm" variant="secondary" icon={IconDownload} onClick={() => void exportCsv()} loading={exporting}>Download CSV</Button>}
          onRowClick={({ row }) => setOpen(row)}
          empty={{ title: "No sheets" }}
          aria-label="Drawing log"
        />
      )}
      <p className="text-xs text-ink-400">{log.data ? `${log.data.total} sheet(s) · generated ${formatDateTime(log.data.generatedAt)}` : ""} · Click a row for its revision history.</p>
      <Drawer open={open !== null} onClose={() => setOpen(null)} size="md" title={open ? `${open.number} — ${open.title}` : ""} description="Revision history, oldest first.">
        {open ? (
          <ul className="divide-y divide-ink-100 text-sm">
            {open.history.map((h) => (
              <li key={h.revisionId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className="font-mono font-semibold">rev {h.revision}</span> <span className="text-ink-500">{h.setName ?? "—"} · {formatDate(h.issuedDate)}</span></span>
                <span className="flex items-center gap-1.5">
                  {h.changeVerdict ? <Badge tone={verdictTone(h.changeVerdict)} size="xs">{h.changeVerdict}</Badge> : null}
                  {h.isSuperseded ? <Badge tone="neutral" size="xs">superseded</Badge> : <Badge tone="success" size="xs">current</Badge>}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Drawer>
    </div>
  );
}
