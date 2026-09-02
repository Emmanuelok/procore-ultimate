/**
 * Drawing issues (#280–#281): a named distribution of exact revisions to
 * named people, with notification on issue and acknowledgement tracked per
 * recipient. The transmittal view prints what was sent and who has
 * acknowledged it.
 */
import { useMemo, useState } from "react";
import { Alert, Badge, Button, Checkbox, DataTable, Drawer, EmptyState, Field, Input, Modal, Select, Textarea, useConfirm, type DataColumns } from "../../ui";
import { IconSend } from "../../ui/icons";
import { api, ApiClientError } from "../../lib/api";
import { useResource } from "../../layouts/project/lib";
import { humanize, formatDateTime } from "../format";
import { ISSUE_PURPOSES, type CompanyUser, type DrawingIssue, type DrawingIssueDetail } from "./drawingsShared";
import type { DrawingSetItem, ListResponse, SheetListItem } from "./types";

function statusTone(s: string): "neutral" | "success" | "danger" {
  if (s === "issued") return "success";
  if (s === "cancelled") return "danger";
  return "neutral";
}

export default function IssuesTab({ projectId, version, onChanged }: { projectId: string; version: number; onChanged: () => void }) {
  const issues = useResource<ListResponse<DrawingIssue>>(`/api/v1/projects/${projectId}/drawing-issues?pageSize=200&_v=${version}`);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const detail = useResource<DrawingIssueDetail>(openId ? `/api/v1/projects/${projectId}/drawing-issues/${openId}?_v=${version}` : null);
  const { confirm, dialog } = useConfirm();

  async function act(id: string, action: "issue" | "acknowledge" | "cancel") {
    if (action === "issue") {
      const ok = await confirm({ title: "Issue these drawings?", description: "Every recipient is notified and asked to acknowledge. The list of revisions is frozen on the record — a later reissue never rewrites it.", confirmLabel: "Issue" });
      if (!ok) return;
    }
    if (action === "cancel") {
      const ok = await confirm({ title: "Cancel this issue?", description: "The record stays, marked cancelled.", confirmLabel: "Cancel the issue", tone: "danger" });
      if (!ok) return;
    }
    setBusy(action);
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/drawing-issues/${id}/${action}`, {});
      issues.reload();
      detail.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The action failed");
    } finally {
      setBusy(null);
    }
  }

  const rows = issues.data?.items ?? [];
  const columns = useMemo<DataColumns<DrawingIssue>>(
    () => [
      { id: "reference", header: "Issue", accessor: "reference", type: "code", width: 90, mono: true, sticky: "start" },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 260, truncate: true },
      { id: "purpose", header: "Purpose", accessor: "purpose", type: "status", width: 150, groupable: true, cell: ({ row }) => humanize(row.purpose) },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 110, cell: ({ row }) => <Badge tone={statusTone(row.status)} size="xs" dot>{row.status}</Badge> },
      { id: "sheets", header: "Sheets", accessor: (r) => r.sheetCount ?? r.revisionIds.length, type: "number", align: "right", width: 80 },
      { id: "ack", header: "Acknowledged", accessor: (r) => r.acknowledged ?? 0, type: "text", width: 130, cell: ({ row }) => (row.status === "issued" ? <Badge tone={(row.acknowledged ?? 0) === (row.recipients ?? 0) ? "success" : "warning"} size="xs">{row.acknowledged ?? 0}/{row.recipients ?? 0}</Badge> : <span className="text-ink-400">{row.recipients ?? 0} recipient(s)</span>) },
      { id: "issuedAt", header: "Issued", accessor: (r) => r.issuedAt ?? "", type: "text", width: 160, cell: ({ row }) => formatDateTime(row.issuedAt) },
    ],
    [],
  );

  const d = detail.data;

  return (
    <div className="space-y-3">
      {dialog}
      {error ? <Alert tone="danger" title="Refused" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {issues.error ? <Alert tone="danger" title="Issues could not be loaded">{issues.error}</Alert> : null}
      {!issues.loading && rows.length === 0 ? (
        <EmptyState icon={IconSend} title="No drawing issues yet" hint="An issue records exactly which revisions were sent to whom, and who acknowledged. Create one from a set or a selection of sheets." action={<Button icon={IconSend} onClick={() => setCreateOpen(true)}>New issue</Button>} />
      ) : (
        <DataTable<DrawingIssue>
          tableId="drawing-issues"
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          loading={issues.loading}
          height={480}
          stickyHeader
          gridLines
          toolbarActions={<Button size="sm" icon={IconSend} onClick={() => setCreateOpen(true)}>New issue</Button>}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.status === "cancelled" ? "danger" : undefined)}
          empty={{ title: "No issues" }}
          aria-label="Drawing issues"
        />
      )}

      <CreateIssueModal projectId={projectId} open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => { setCreateOpen(false); issues.reload(); onChanged(); setOpenId(id); }} />

      <Drawer open={openId !== null} onClose={() => setOpenId(null)} size="lg" title={d ? `${d.reference} — ${d.title}` : "Drawing issue"} description={d ? `${humanize(d.purpose)} · ${d.status}${d.issuedAt ? ` · issued ${formatDateTime(d.issuedAt)} by ${d.issuedByName ?? "?"}` : ""}` : undefined}
        headerActions={d ? <Badge tone={statusTone(d.status)} dot>{d.status}</Badge> : null}
        footer={d ? (
          <div className="flex flex-wrap justify-end gap-2">
            {d.status === "draft" ? <Button onClick={() => void act(d.id, "issue")} loading={busy === "issue"} disabled={busy !== null}>Issue to {d.recipients.length} recipient{d.recipients.length === 1 ? "" : "s"}</Button> : null}
            {d.status === "issued" && d.isRecipient && !d.recipients.find((r) => r.acknowledgedAt && r.userId === d.recipients.find((x) => x.userId)?.userId && false) ? null : null}
            {d.status === "issued" && d.isRecipient ? <Button variant="secondary" onClick={() => void act(d.id, "acknowledge")} loading={busy === "acknowledge"} disabled={busy !== null}>Acknowledge receipt</Button> : null}
            {d.status !== "cancelled" ? <Button variant="ghost" onClick={() => void act(d.id, "cancel")} loading={busy === "cancel"} disabled={busy !== null}>Cancel issue</Button> : null}
            <Button variant="secondary" onClick={() => window.print()}>Print transmittal</Button>
          </div>
        ) : undefined}
      >
        {detail.loading && !d ? <p className="text-sm text-ink-400">Loading…</p> : detail.error ? <Alert tone="danger">{detail.error}</Alert> : d ? (
          <div className="space-y-4">
            {d.notes ? <p className="text-sm text-ink-700">{d.notes}</p> : null}
            {d.transmittalId ? <p className="text-xs text-ink-500">Linked transmittal: <span className="font-mono">{d.transmittalId}</span></p> : null}
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Sheets issued ({d.sheets.length})</h3>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-2xs uppercase text-ink-400"><th className="py-1">Number</th><th>Title</th><th>Rev</th><th>Discipline</th></tr></thead>
                <tbody className="divide-y divide-ink-100">
                  {d.sheets.map((s) => (
                    <tr key={s.revisionId}><td className="py-1 font-mono">{s.number}</td><td>{s.title}</td><td className="font-mono">{s.revision}{s.isSuperseded === 1 ? <span className="ml-1 text-2xs text-ink-400">(since superseded)</span> : null}</td><td>{humanize(s.discipline)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Recipients ({d.acknowledged}/{d.recipients.length} acknowledged)</h3>
              <ul className="divide-y divide-ink-100 text-sm">
                {d.recipients.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>{r.name ?? r.userId} <span className="text-xs text-ink-400">{r.email}</span></span>
                    <span className="flex items-center gap-2 text-xs text-ink-500">
                      {r.notifiedAt ? `notified ${formatDateTime(r.notifiedAt)}` : "not yet notified"}
                      {r.remindedAt ? ` · reminded ${formatDateTime(r.remindedAt)}` : ""}
                      {r.acknowledgedAt ? <Badge tone="success" size="xs">acknowledged {formatDateTime(r.acknowledgedAt)}</Badge> : d.status === "issued" ? <Badge tone="warning" size="xs">awaiting</Badge> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <p className="text-2xs text-ink-400">Created by {d.createdByName ?? d.createdBy} on {formatDateTime(d.createdAt)}. Recipients who have not acknowledged after three days are reminded once by the scheduler.</p>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function CreateIssueModal({ projectId, open, onClose, onCreated }: { projectId: string; open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const sets = useResource<ListResponse<DrawingSetItem>>(open ? `/api/v1/projects/${projectId}/drawing-sets?pageSize=100&processing=ready` : null);
  const sheets = useResource<ListResponse<SheetListItem>>(open ? `/api/v1/projects/${projectId}/sheets?pageSize=500&needsReview=0` : null);
  const users = useResource<ListResponse<CompanyUser>>(open ? "/api/v1/company/users?pageSize=200" : null);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState<string>("for_information");
  const [source, setSource] = useState<"set" | "sheets">("set");
  const [setId, setSetId] = useState("");
  const [sheetIds, setSheetIds] = useState<Set<string>>(new Set());
  const [recipients, setRecipients] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState("");
  const [sheetFilter, setSheetFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { title: title.trim(), purpose, recipientUserIds: [...recipients], notes: notes.trim() || null };
      if (source === "set") body["setId"] = setId;
      else body["sheetIds"] = [...sheetIds];
      const res = await api.post<{ id: string }>(`/api/v1/projects/${projectId}/drawing-issues`, body);
      setTitle("");
      setSheetIds(new Set());
      setRecipients(new Set());
      setNotes("");
      onCreated(res.id);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not create the issue");
    } finally {
      setBusy(false);
    }
  }

  const filteredSheets = (sheets.data?.items ?? []).filter((s) => !sheetFilter || `${s.number} ${s.title}`.toLowerCase().includes(sheetFilter.toLowerCase()));
  const valid = title.trim().length > 0 && recipients.size > 0 && (source === "set" ? setId !== "" : sheetIds.size > 0);

  return (
    <Modal open={open} onClose={onClose} title="New drawing issue" size="lg" footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void submit()} disabled={!valid || busy} loading={busy}>Create draft</Button></div>}>
      <div className="space-y-3">
        {error ? <Alert tone="danger" size="sm" title="Refused" onDismiss={() => setError(null)}>{error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" required className="sm:col-span-2"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Level 1 for construction" /></Field>
          <Field label="Purpose">
            <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {ISSUE_PURPOSES.map((p) => (
                <option key={p} value={p}>{humanize(p)}</option>
              ))}
            </Select>
          </Field>
          <Field label="What to issue">
            <Select value={source} onChange={(e) => setSource(e.target.value as "set" | "sheets")}>
              <option value="set">Every sheet of a set</option>
              <option value="sheets">Chosen sheets (current revisions)</option>
            </Select>
          </Field>
        </div>
        {source === "set" ? (
          <Field label="Set" required>
            <Select value={setId} onChange={(e) => setSetId(e.target.value)}>
              <option value="">Choose…</option>
              {(sets.data?.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.sheetCount ?? 0} sheets)</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={`Sheets (${sheetIds.size} chosen)`} required>
            <Input value={sheetFilter} onChange={(e) => setSheetFilter(e.target.value)} placeholder="Filter…" className="mb-1" />
            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md p-2 ring-1 ring-ink-200">
              {filteredSheets.map((s) => (
                <Checkbox key={s.id} size="sm" checked={sheetIds.has(s.id)} onChange={() => setSheetIds((prev) => toggle(prev, s.id))} label={<span><span className="font-mono">{s.number}</span> {s.title} <span className="text-ink-400">rev {s.currentRevision?.revision ?? "—"}</span></span>} />
              ))}
              {filteredSheets.length === 0 ? <p className="text-xs text-ink-400">No confirmed sheets match.</p> : null}
            </div>
          </Field>
        )}
        <Field label={`Recipients (${recipients.size})`} required hint="Company members. Each is notified when the issue is issued and asked to acknowledge.">
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md p-2 ring-1 ring-ink-200">
            {(users.data?.items ?? []).map((u) => (
              <Checkbox key={u.id} size="sm" checked={recipients.has(u.id)} onChange={() => setRecipients((prev) => toggle(prev, u.id))} label={<span>{u.name} <span className="text-ink-400">{u.email}</span></span>} />
            ))}
            {users.error ? <p className="text-xs text-red-600">{users.error}</p> : null}
          </div>
        </Field>
        <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
