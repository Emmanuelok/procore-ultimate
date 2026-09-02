/** Drawing sets: upload, processing progress (inline or by the scheduler), QA report. */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Card, CardBody, DataTable, Drawer, EmptyState, Field, Input, Progress, type DataColumns } from "../../ui";
import { IconUpload } from "../../ui/icons";
import { api, ApiClientError } from "../../lib/api";
import { useResource } from "../../layouts/project/lib";
import { formatDate, formatDateTime } from "../format";
import { pct, type SetQa } from "./drawingsShared";
import type { DrawingSetItem, ListResponse } from "./types";

function processingTone(status: string): "success" | "danger" | "info" | "neutral" {
  if (status === "ready") return "success";
  if (status === "failed") return "danger";
  if (status === "processing") return "info";
  return "neutral";
}

export default function SetsTab({ projectId, version, onChanged }: { projectId: string; version: number; onChanged: () => void }) {
  const sets = useResource<ListResponse<DrawingSetItem>>(`/api/v1/projects/${projectId}/drawing-sets?pageSize=100&_v=${version}`);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [issuedDate, setIssuedDate] = useState("");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [qaSetId, setQaSetId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const qa = useResource<SetQa>(qaSetId ? `/api/v1/projects/${projectId}/drawing-sets/${qaSetId}/qa?_v=${version}` : null);

  const items = sets.data?.items ?? [];
  const anyProcessing = useMemo(() => items.some((s) => s.processing === "pending" || s.processing === "processing"), [items]);

  useEffect(() => {
    if (!anyProcessing) return;
    const h = window.setInterval(() => sets.reload(), 2500);
    return () => window.clearInterval(h);
  }, [anyProcessing, sets]);

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("name", name.trim() || file.name.replace(/\.pdf$/i, ""));
      if (issuedDate) form.append("issuedDate", issuedDate);
      if (area.trim()) form.append("area", area.trim());
      form.append("file", file);
      const res = await api.upload<DrawingSetItem & { deferred: boolean; note: string | null }>(`/api/v1/projects/${projectId}/drawing-sets`, form);
      setNotice(res.deferred ? (res.note ?? "Processing continues in the background.") : res.processing === "failed" ? `The set could not be processed: ${res.error ?? "unknown error"}` : `${res.sheetsCreated ?? 0} sheet(s) created, ${res.revisionsAdded ?? 0} revision(s) added, ${res.autoLinksCreated ?? 0} callout link(s), ${res.unresolvedCallouts ?? 0} unresolved.`);
      setName("");
      setIssuedDate("");
      sets.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function act(id: string, action: "process" | "autolink") {
    setBusy(`${action}:${id}`);
    setError(null);
    try {
      const res = await api.post<Record<string, unknown>>(`/api/v1/projects/${projectId}/drawing-sets/${id}/${action}`, {});
      if (action === "autolink") setNotice(`Callout pass: ${res["created"] ?? 0} linked, ${res["unresolved"] ?? 0} unresolved, ${res["specReferences"] ?? 0} spec reference(s), ${res["resolvedByRerun"] ?? 0} previously unresolved now resolved.`);
      sets.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const columns = useMemo<DataColumns<DrawingSetItem>>(
    () => [
      { id: "name", header: "Set", accessor: "name", type: "text", width: 240, sticky: "start", truncate: true },
      { id: "issued", header: "Issued", accessor: (r) => r.issuedDate ?? "", type: "text", width: 110, cell: ({ row }) => formatDate(row.issuedDate) },
      { id: "area", header: "Area", accessor: (r) => r.area ?? "", type: "text", width: 110, cell: ({ row }) => row.area ?? "—" },
      {
        id: "processing",
        header: "Processing",
        accessor: "processing",
        type: "status",
        width: 220,
        cell: ({ row }) => (
          <span className="block min-w-0 py-0.5">
            <Badge tone={processingTone(row.processing)} size="xs" dot>{row.processing}</Badge>
            {row.processing === "processing" || row.processing === "pending" ? (
              <Progress className="mt-1" size="xs" value={row.processedPages ?? 0} max={row.pageCount ?? 1} label={`${row.processedPages ?? 0}/${row.pageCount ?? "?"} pages`} />
            ) : null}
            {row.processingError ? <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-danger-fg">{row.processingError}</p> : null}
          </span>
        ),
      },
      { id: "pages", header: "Pages", accessor: (r) => r.pageCount ?? 0, type: "number", align: "right", width: 80, cell: ({ row }) => row.pageCount ?? "—" },
      { id: "sheets", header: "Sheets", accessor: (r) => r.sheetCount ?? 0, type: "number", align: "right", width: 80 },
      { id: "links", header: "Links", accessor: (r) => r.autoLinksCreated ?? 0, type: "number", align: "right", width: 80, headerTooltip: "Automatic callout hyperlinks created" },
      { id: "unresolved", header: "Unresolved", accessor: (r) => r.unresolvedCallouts ?? 0, type: "number", align: "right", width: 100, cell: ({ row }) => (row.unresolvedCallouts ? <Badge tone="warning" size="xs">{row.unresolvedCallouts}</Badge> : "0") },
      { id: "by", header: "Uploaded by", accessor: (r) => r.uploadedByName ?? "", type: "text", width: 140, cell: ({ row }) => row.uploadedByName ?? "—" },
      { id: "at", header: "Uploaded", accessor: (r) => r.createdAt ?? "", type: "text", width: 150, cell: ({ row }) => formatDateTime(row.createdAt) },
    ],
    [],
  );

  const qaSet = items.find((s) => s.id === qaSetId) ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Set name" hint="Defaults to the file name." className="min-w-56 flex-1">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="IFC Set 3" />
            </Field>
            <Field label="Issued date">
              <Input type="date" value={issuedDate} onChange={(e) => setIssuedDate(e.target.value)} />
            </Field>
            <Field label="Area" hint="Applied to every sheet in the set (segregation)">
              <Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Tower A" />
            </Field>
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => void onUpload(e)} />
            <Button icon={IconUpload} onClick={() => fileRef.current?.click()} disabled={uploading} loading={uploading}>
              {uploading ? "Uploading…" : "Upload drawing set (PDF)"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-400">
            Each page becomes a sheet; the title block is read from the bottom-right of the page. Small sets are processed inline, large ones by the background job in pages-per-cycle batches — poll this list or press “Process now”. Scanned pages (no text layer) wait in the review queue rather than being guessed.
          </p>
        </CardBody>
      </Card>

      {error ? <Alert tone="danger" title="The drawings API refused this" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="info" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}
      {sets.error ? <Alert tone="danger" title="Sets could not be loaded">{sets.error}</Alert> : null}

      {!sets.loading && items.length === 0 ? (
        <EmptyState icon={IconUpload} title="No drawing sets yet" hint="Upload a multi-sheet PDF to build the register." />
      ) : (
        <DataTable<DrawingSetItem>
          tableId="drawing-sets"
          data={items}
          columns={columns}
          getRowId={(r) => r.id}
          loading={sets.loading}
          height={420}
          stickyHeader
          gridLines
          toolbar={false}
          onRowClick={({ row }) => setQaSetId(row.id)}
          rowTone={(row) => (row.processing === "failed" ? "danger" : undefined)}
          rowActions={(row) => [
            { id: "qa", label: "QA report", onSelect: () => setQaSetId(row.id) },
            { id: "process", label: row.processing === "failed" ? "Retry processing" : "Process now", disabled: row.processing === "ready" || busy !== null, onSelect: () => void act(row.id, "process") },
            { id: "autolink", label: "Re-run callout links", disabled: row.processing !== "ready" || busy !== null, onSelect: () => void act(row.id, "autolink") },
          ]}
          empty={{ title: "No sets", description: "Upload a drawing set to begin." }}
          aria-label="Drawing sets"
        />
      )}

      <Drawer open={qaSetId !== null} onClose={() => setQaSetId(null)} size="lg" title={qaSet ? `QA — ${qaSet.name}` : "QA report"} description="What the pipeline could not settle on its own.">
        {qa.loading && !qa.data ? <p className="text-sm text-ink-400">Loading…</p> : qa.error ? <Alert tone="danger">{qa.error}</Alert> : qa.data ? <QaReport qa={qa.data} projectId={projectId} /> : null}
      </Drawer>
    </div>
  );
}

function QaReport({ qa, projectId }: { qa: SetQa; projectId: string }) {
  const s = qa.summary;
  const line = (label: string, n: number, tone: "warning" | "neutral" | "success" | "danger") => (
    <div className="flex items-center justify-between rounded-md px-2 py-1.5 ring-1 ring-ink-100">
      <span className="text-sm text-ink-700">{label}</span>
      <Badge tone={n > 0 ? tone : "success"} size="xs">{n}</Badge>
    </div>
  );
  const sheetLink = (id: string | null, number: string | null) => (id ? <Link to={`/projects/${projectId}/drawings/${id}`} className="font-mono text-brand-700 hover:underline">{number ?? id}</Link> : <span className="font-mono">{number ?? "?"}</span>);
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-500">
        {qa.processing} · {qa.processedPages}/{qa.pageCount ?? "?"} pages processed · {s.pages} visible to you
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {line("Callouts to sheets that do not exist", s.unresolvedCallouts, "warning")}
        {line("Low-confidence automatic links", s.lowConfidenceLinks, "warning")}
        {line("Pages needing naming review", s.pagesNeedingReview, "warning")}
        {line("Pages with no text layer (scans)", s.noTextLayer, "neutral")}
        {line("Reissued pages the diff found unchanged", s.unchangedReissues, "neutral")}
        {line("Reissues the diff could not compare", s.diffUnknown, "neutral")}
      </div>
      {qa.unresolvedCallouts.length > 0 ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Unresolved callouts</h3>
          <ul className="space-y-1 text-sm">
            {qa.unresolvedCallouts.map((c) => (
              <li key={c.linkId} className="flex flex-wrap items-center gap-2">
                {sheetLink(null, c.number)} <span className="text-ink-500">page {c.pageIndex != null ? c.pageIndex + 1 : "?"}</span> → <span className="font-mono">{c.targetNumber}</span>
                <span className="text-xs text-ink-400">“{c.label}” · {pct(c.confidence)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-400">These resolve automatically when a sheet with that number is uploaded or confirmed in the review queue.</p>
        </section>
      ) : null}
      {qa.unchangedReissues.length > 0 ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Unchanged reissues</h3>
          <ul className="space-y-1 text-sm">
            {qa.unchangedReissues.map((u) => (
              <li key={u.sheetId ?? u.number ?? ""}>
                {sheetLink(u.sheetId, u.number)} rev {u.revision} — every text item matches the superseded revision; a reissue that changed nothing is worth asking the issuer about.
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {qa.pagesNeedingReview.length > 0 ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Pages needing review</h3>
          <p className="text-sm text-ink-600">{qa.pagesNeedingReview.map((p) => `page ${p.pageIndex != null ? p.pageIndex + 1 : "?"}`).join(", ")} — resolve them in the Review queue tab.</p>
        </section>
      ) : null}
      {qa.noTextLayer.length > 0 ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">No text layer</h3>
          <p className="text-sm text-ink-600">
            {qa.noTextLayer.map((p) => `page ${p.pageIndex != null ? p.pageIndex + 1 : "?"}`).join(", ")} — scanned pages. Nothing was read from them: no OCR engine is available in this runtime, so their numbers must be typed in the review queue and the diff will report “unknown” for them.
          </p>
        </section>
      ) : null}
    </div>
  );
}
