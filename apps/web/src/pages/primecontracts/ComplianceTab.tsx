/**
 * COMPLIANCE DOCUMENTS (#519) — insurance, bonds, permits, tax forms, notice
 * to proceed. A required document that is missing or expired gates the
 * submission of an application for payment, mirroring the commitment-side
 * payment hold; the gate is printed here with exactly what blocks it.
 */
import { useState } from "react";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, EmptyState, Field, Input, Modal, Select, Spinner, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { RefusalPanel, isoDate, statusToneOf, titleCase, useAction, useReason, type Loadable } from "./shared";
import type { ComplianceDocument, ComplianceKind, ComplianceView, ContractView } from "./types";

const KINDS: ComplianceKind[] = ["insurance_certificate", "performance_bond", "payment_bond", "permit", "tax_form", "notice_to_proceed", "lien_waiver", "warranty", "other"];

export default function ComplianceTab({ contract, compliance, onChanged }: { contract: ContractView; compliance: Loadable<ComplianceView>; onChanged: () => void }) {
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog } = useReason();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ComplianceDocument | null>(null);
  const view = compliance.data;

  async function post(path: string, body: unknown, key: string) {
    const done = await run(key, () => api.post(path, body));
    if (done !== null) {
      compliance.reload();
      onChanged();
    }
  }

  const columns: DataColumns<ComplianceDocument> = [
    { id: "title", header: "Document", accessor: "title", type: "text", width: 240, cell: ({ row }) => (<span>{row.title}<span className="block text-2xs text-content-subtle">{titleCase(row.kind)}{row.reference ? ` · ${row.reference}` : ""}{row.issuer ? ` · ${row.issuer}` : ""}</span></span>) },
    { id: "required", header: "Required", accessor: (row) => row.required === 1, type: "boolean", width: 100, cell: ({ row }) => (row.required === 1 ? <Badge tone="info" size="xs">required</Badge> : <span className="text-2xs text-content-subtle">optional</span>) },
    { id: "status", header: "Status", accessor: "status", type: "status", width: 130, cell: ({ row }) => (<Badge tone={row.status === "verified" ? "success" : row.status === "received" ? "info" : row.status === "waived" ? "neutral" : "danger"} dot size="xs">{titleCase(row.status)}</Badge>) },
    { id: "expiryDate", header: "Expires", accessor: "expiryDate", type: "date", width: 120, cell: ({ row }) => isoDate(row.expiryDate) },
    { id: "verifiedAt", header: "Verified", accessor: "verifiedAt", type: "date", width: 120, cell: ({ row }) => (row.verifiedAt ? isoDate(row.verifiedAt) : <span className="text-2xs text-content-subtle">—</span>) },
    {
      id: "actions",
      header: "",
      width: 320,
      sortable: false,
      interactive: true,
      exportable: false,
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          {row.status !== "waived" ? (
            <Button size="xs" variant="ghost" onClick={() => setEditing(row)} disabled={busy !== null}>
              Edit
            </Button>
          ) : null}
          {row.status === "missing" || row.status === "expired" ? (
            <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => setEditing(row)}>
              Record receipt
            </Button>
          ) : null}
          {row.status === "received" ? (
            <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => void post(`/api/v1/prime-compliance/${row.id}/verify`, {}, `verify:${row.id}`)}>
              Verify
            </Button>
          ) : null}
          {row.status !== "waived" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={async () => {
                const reason = await ask({ title: `Waive ${row.title}?`, description: "A waived requirement no longer gates the application. The waiver and its reason are ledgered.", label: "Why is it waived?", confirmLabel: "Waive" });
                if (!reason) return;
                await post(`/api/v1/prime-compliance/${row.id}/waive`, { reason }, `waive:${row.id}`);
              }}
            >
              Waive
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={async () => {
              const done = await run(`delete:${row.id}`, () => api.del(`/api/v1/prime-compliance/${row.id}`));
              if (done !== null) {
                compliance.reload();
                onChanged();
              }
            }}
          >
            Remove
          </Button>
        </span>
      ),
    },
  ];

  if (compliance.loading && !view) {
    return (
      <div className="py-12">
        <Spinner label="Loading compliance documents…" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {dialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {compliance.error ? <Alert tone="danger" title="Compliance documents could not be loaded">{compliance.error}</Alert> : null}
      {view ? (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">
                The gate{" "}
                <Badge tone={view.gate.ok ? "success" : "danger"} dot size="xs">
                  {view.gate.ok ? "open — applications may be submitted" : `blocked by ${view.gate.blocking.length} document${view.gate.blocking.length === 1 ? "" : "s"}`}
                </Badge>
              </h3>
              <p className="text-2xs text-content-subtle">
                {view.gate.summary.required} required · {view.gate.summary.satisfied} satisfied · {view.gate.summary.missing} missing · {view.gate.summary.expired} expired · {view.gate.summary.waived} waived · {view.gate.summary.optional} optional
              </p>
              {view.gate.blocking.length > 0 ? <ul className="mt-1 list-disc pl-4 text-meta text-danger-fg">{view.gate.blocking.map((b) => <li key={b.id}>{b.problem}</li>)}</ul> : null}
              {view.gate.expiringSoon.length > 0 ? <p className="mt-1 text-meta text-warning-fg">Expiring soon: {view.gate.expiringSoon.map((e) => `${e.title} in ${e.daysLeft} day${e.daysLeft === 1 ? "" : "s"}`).join(", ")}</p> : null}
            </div>
            <Button size="sm" onClick={() => setAdding(true)} disabled={contract.status === "void" || contract.status === "terminated"}>
              Add document
            </Button>
          </CardBody>
        </Card>
      ) : null}
      <DataTable<ComplianceDocument>
        tableId="prime-compliance"
        data={view?.items ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        loading={compliance.loading}
        height={420}
        stickyHeader
        gridLines
        savedViews={false}
        empty={{ title: "No compliance document recorded", description: "Add the insurance certificates, bonds, permits and forms the owner requires; mark them required to gate applications for payment on them." }}
        aria-label={`Compliance documents for ${contract.reference}`}
      />
      {(view?.items ?? []).length === 0 && !compliance.loading ? (
        <EmptyState title="Nothing gates this contract yet" hint="Required documents block submission while missing or expired; the platform's hourly sweep expires them on their expiry date." action={<Button onClick={() => setAdding(true)}>Add the first document</Button>} />
      ) : null}
      <DocumentDialog open={adding || editing !== null} contractId={contract.id} existing={editing} onClose={() => { setAdding(false); setEditing(null); }} onDone={() => { setAdding(false); setEditing(null); compliance.reload(); onChanged(); }} />
    </div>
  );
}

function DocumentDialog({ open, contractId, existing, onClose, onDone }: { open: boolean; contractId: string; existing: ComplianceDocument | null; onClose: () => void; onDone: () => void }) {
  const { busy, refusal, clear, run } = useAction();
  const [kind, setKind] = useState<ComplianceKind>("insurance_certificate");
  const [title, setTitle] = useState("");
  const [required, setRequired] = useState(true);
  const [received, setReceived] = useState(false);
  const [reference, setReference] = useState("");
  const [issuer, setIssuer] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [seeded, setSeeded] = useState<string | null>(null);

  const key = existing ? existing.id : "new";
  if (open && seeded !== key) {
    setSeeded(key);
    setKind(existing?.kind ?? "insurance_certificate");
    setTitle(existing?.title ?? "");
    setRequired(existing ? existing.required === 1 : true);
    setReceived(existing ? existing.status === "received" || existing.status === "verified" : false);
    setReference(existing?.reference ?? "");
    setIssuer(existing?.issuer ?? "");
    setExpiryDate(existing?.expiryDate ?? "");
    setNotes(existing?.notes ?? "");
  }
  if (!open && seeded !== null) setSeeded(null);

  async function submit() {
    const body = {
      kind,
      title: title.trim(),
      required,
      status: received ? "received" : "missing",
      reference: reference.trim() || null,
      issuer: issuer.trim() || null,
      expiryDate: expiryDate || null,
      notes: notes.trim() || null,
    };
    const done = await run("save", () =>
      existing ? api.patch(`/api/v1/prime-compliance/${existing.id}`, body) : api.post(`/api/v1/prime-contracts/${contractId}/compliance`, body),
    );
    if (done !== null) onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? `Edit ${existing.title}` : "Add a compliance document"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={title.trim() === "" || busy !== null}>
            {existing ? "Save" : "Add"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ComplianceKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {titleCase(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Field label="Reference" optional>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Issuer" optional>
            <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          </Field>
          <Field label="Expiry date" optional hint="The hourly sweep marks the document expired the day after.">
            <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
          </Field>
          <Field label="Notes" optional className="sm:col-span-2">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-meta">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          Required — gates submission of an application while missing or expired
        </label>
        <label className="flex items-center gap-2 text-meta">
          <input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} />
          The document is on file (received). Verification is a second person's act.
        </label>
      </div>
    </Modal>
  );
}
