/**
 * STORED MATERIALS (#516) — the register behind G703 column F. Every item is
 * material actually stored, on or off site, with the supplier invoice that
 * supports its value and whether it is insured; incorporation moves value
 * off column F and into the work. The identity Σ register = column F is
 * checked per line and in total, and uninsured or unevidenced items are
 * named, because an owner is entitled to refuse column F on either.
 */
import { useState } from "react";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, Field, Input, Modal, Select, Spinner, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IdentityRow, RefusalPanel, isoDate, money, titleCase, useAction, useReason, type Loadable } from "./shared";
import type { ContractView, SovView, StoredMaterial, StoredMaterialsView } from "./types";

export default function StoredMaterialsTab({ contract, stored, sov, onChanged }: { contract: ContractView; stored: Loadable<StoredMaterialsView>; sov: Loadable<SovView>; onChanged: () => void }) {
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog } = useReason();
  const [adding, setAdding] = useState(false);
  const [incorporating, setIncorporating] = useState<StoredMaterial | null>(null);
  const cur = contract.currency;
  const view = stored.data;
  const lines = sov.data?.lines ?? [];
  const lineLabel = (id: string): string => {
    const l = lines.find((x) => x.id === id);
    return l ? `${l.lineNumber} — ${l.description}` : id;
  };

  const columns: DataColumns<StoredMaterial> = [
    { id: "reference", header: "Item", accessor: "reference", type: "code", width: 100, mono: true, sticky: "start" },
    { id: "description", header: "Description", accessor: "description", type: "text", width: 240, cell: ({ row }) => (<span>{row.description}<span className="block text-2xs text-content-subtle">{lineLabel(row.sovLineId)}</span></span>) },
    { id: "status", header: "Status", accessor: "status", type: "status", width: 160, cell: ({ row }) => <Badge tone={row.status === "removed" ? "danger" : row.status === "incorporated" ? "success" : "info"} dot size="xs">{titleCase(row.status)}</Badge> },
    { id: "location", header: "Location", accessor: (row) => titleCase(row.location), type: "text", width: 140 },
    { id: "value", header: "Value", accessor: "value", type: "currency", currency: cur, align: "right", width: 140, mono: true, aggregate: "sum" },
    { id: "incorporatedValue", header: "Incorporated", accessor: "incorporatedValue", type: "currency", currency: cur, align: "right", width: 140, mono: true, aggregate: "sum" },
    { id: "stillStored", header: "Still stored", accessor: (row) => (row.status === "removed" ? 0 : row.value - row.incorporatedValue), type: "currency", currency: cur, align: "right", width: 140, mono: true, aggregate: "sum" },
    { id: "storedDate", header: "Stored", accessor: "storedDate", type: "date", width: 110, cell: ({ row }) => isoDate(row.storedDate) },
    { id: "evidence", header: "Evidence", width: 170, sortable: false, cell: ({ row }) => (<span className="flex flex-wrap gap-1"><Badge tone={row.insured === 1 ? "success" : "warning"} size="xs">{row.insured === 1 ? "insured" : "uninsured"}</Badge><Badge tone={row.supplierInvoiceReference ? "success" : "warning"} size="xs">{row.supplierInvoiceReference ? row.supplierInvoiceReference : "no supplier invoice"}</Badge></span>) },
    {
      id: "actions",
      header: "",
      width: 200,
      sortable: false,
      interactive: true,
      exportable: false,
      cell: ({ row }) =>
        row.status === "removed" || row.status === "incorporated" ? (
          <span className="text-2xs text-content-subtle">—</span>
        ) : (
          <span className="flex gap-1">
            <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => setIncorporating(row)}>
              Incorporate
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={async () => {
                const reason = await ask({ title: `Remove ${row.reference}?`, description: "Material removed from site or written off. If it was billed on a certified application the API refuses — that is a credit on the next application.", label: "Why?", confirmLabel: "Remove", destructive: true });
                if (!reason) return;
                const done = await run(`remove:${row.id}`, () => api.post(`/api/v1/prime-stored-materials/${row.id}/remove`, { reason }));
                if (done !== null) {
                  stored.reload();
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

  if (stored.loading && !view) {
    return (
      <div className="py-12">
        <Spinner label="Loading the stored materials register…" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {dialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {stored.error ? <Alert tone="danger" title="The register could not be loaded">{stored.error}</Alert> : null}
      {view ? (
        <Card>
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Σ register = Σ G703 column F</h3>
              <Button size="sm" onClick={() => setAdding(true)} disabled={lines.length === 0}>
                Add stored material
              </Button>
            </div>
            <IdentityRow identity={view.reconciliation.totals.identity} currency={cur} />
            {view.reconciliation.lines.filter((l) => !l.identity.ok).length > 0 ? (
              <div>
                <p className="text-2xs text-content-subtle">Lines that do not agree:</p>
                {view.reconciliation.lines.filter((l) => !l.identity.ok).map((l) => <IdentityRow key={l.sovLineId} identity={l.identity} currency={cur} />)}
              </div>
            ) : null}
            {view.reconciliation.reasons.length > 0 ? <ul className="list-disc pl-4 text-meta text-warning-fg">{view.reconciliation.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
            <p className="text-2xs text-content-subtle">Column F on an application is entered on the continuation sheet; this register is the evidence behind it. The identity fails until the two agree.</p>
          </CardBody>
        </Card>
      ) : null}
      <DataTable<StoredMaterial>
        tableId="prime-stored-materials"
        data={view?.items ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        loading={stored.loading}
        height={440}
        stickyHeader
        showFooter
        gridLines
        savedViews={false}
        exportFileName={`stored-materials-${contract.reference}`}
        empty={{ title: "No stored material recorded", description: "Column F on a G703 must be backed by material that is stored, insured and evidenced. Record each delivery here before billing it." }}
        aria-label={`Stored materials for ${contract.reference}`}
      />
      <AddDialog open={adding} contractId={contract.id} currency={cur} lines={lines} onClose={() => setAdding(false)} onDone={() => { setAdding(false); stored.reload(); onChanged(); }} />
      <IncorporateDialog item={incorporating} currency={cur} onClose={() => setIncorporating(null)} onDone={() => { setIncorporating(null); stored.reload(); onChanged(); }} />
    </div>
  );
}

function AddDialog({ open, contractId, currency, lines, onClose, onDone }: { open: boolean; contractId: string; currency: string; lines: SovView["lines"]; onClose: () => void; onDone: () => void }) {
  const { busy, refusal, clear, run } = useAction();
  const [sovLineId, setSovLineId] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [location, setLocation] = useState("on_site");
  const [storedDate, setStoredDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [supplierInvoiceReference, setSupplier] = useState("");
  const [insured, setInsured] = useState(false);
  const [insuranceReference, setInsuranceRef] = useState("");
  const [notes, setNotes] = useState("");
  const amount = Number(value);
  const valid = sovLineId !== "" && description.trim() !== "" && Number.isFinite(amount) && amount > 0;

  async function submit() {
    const done = await run("add", () =>
      api.post(`/api/v1/prime-contracts/${contractId}/stored-materials`, {
        sovLineId,
        description: description.trim(),
        value: amount,
        location,
        storedDate,
        supplierInvoiceReference: supplierInvoiceReference.trim() || null,
        insured,
        insuranceReference: insuranceReference.trim() || null,
        notes: notes.trim() || null,
      }),
    );
    if (done !== null) {
      setDescription("");
      setValue("");
      setSupplier("");
      setInsuranceRef("");
      setNotes("");
      onDone();
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record stored material" footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!valid || busy !== null}>Record</Button></div>}>
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Schedule-of-values line" required className="sm:col-span-2">
            <Select value={sovLineId} onChange={(e) => setSovLineId(e.target.value)}>
              <option value="">Choose the line this material is billed under…</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.lineNumber} — {l.description}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description" required className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} autoFocus />
          </Field>
          <Field label={`Value (${currency})`} required>
            <Input value={value} inputMode="decimal" onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Stored on" required>
            <Input type="date" value={storedDate} onChange={(e) => setStoredDate(e.target.value)} />
          </Field>
          <Field label="Location">
            <Select value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="on_site">On site</option>
              <option value="off_site_bonded">Off site — bonded warehouse</option>
              <option value="off_site_insured">Off site — insured</option>
            </Select>
          </Field>
          <Field label="Supplier invoice / bill of sale" optional hint="The evidence of value an owner will ask for.">
            <Input value={supplierInvoiceReference} onChange={(e) => setSupplier(e.target.value)} />
          </Field>
          <Field label="Insurance reference" optional>
            <Input value={insuranceReference} onChange={(e) => setInsuranceRef(e.target.value)} />
          </Field>
          <Field label="Notes" optional>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-meta">
          <input type="checkbox" checked={insured} onChange={(e) => setInsured(e.target.checked)} />
          The material is insured while stored
        </label>
      </div>
    </Modal>
  );
}

function IncorporateDialog({ item, currency, onClose, onDone }: { item: StoredMaterial | null; currency: string; onClose: () => void; onDone: () => void }) {
  const { busy, refusal, clear, run } = useAction();
  const [value, setValue] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const remaining = item ? item.value - item.incorporatedValue : 0;
  const amount = value.trim() === "" ? remaining : Number(value);
  const over = Number.isFinite(amount) && amount - remaining > 0.005;

  async function submit() {
    if (!item) return;
    const done = await run("incorporate", () => api.post(`/api/v1/prime-stored-materials/${item.id}/incorporate`, { ...(value.trim() === "" ? {} : { value: Number(value) }), date }));
    if (done !== null) {
      setValue("");
      onDone();
    }
  }

  return (
    <Modal open={item !== null} onClose={onClose} title={item ? `Incorporate ${item.reference} into the work` : "Incorporate"} footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={over || !Number.isFinite(amount) || amount <= 0 || busy !== null}>Incorporate {money(Number.isFinite(amount) ? amount : 0, currency)}</Button></div>}>
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <p className="text-meta text-content-muted">
          {money(remaining, currency)} of this item is still stored. Incorporation moves value off column F and into the work completed on the next application.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Value incorporated (${currency})`} hint="Leave blank for all of it.">
            <Input value={value} inputMode="decimal" placeholder={String(remaining)} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Date" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {over ? <Alert tone="danger" size="sm" title="More than is stored">Only {money(remaining, currency)} remains in store.</Alert> : null}
      </div>
    </Modal>
  );
}
