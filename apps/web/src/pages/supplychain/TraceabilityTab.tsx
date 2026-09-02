/**
 * TRACEABILITY — heat/batch → certificate → installed location (#945–947;
 * Vol I #721, #724–725). The chain is complete only when a second person
 * has verified the certificate and the lot has a location. Gaps are named,
 * not hidden.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { TRACE_CERTIFICATE_KINDS, TRACE_STATUSES } from "@constructos/shared";
import { Badge, Button, Card, CardBody, Checkbox, Drawer, Field, Input, Select, Skeleton } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  FigureCell,
  KeyValue,
  LoadError,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  TRACE_STATUS_TONE,
  dateTime,
  isoDate,
  labelize,
  num,
  optionList,
  pct,
  useAction,
  useResource,
  type ListResponse,
  type Loadable,
  type Lookups,
  type NodeRow,
  type TraceCoverage,
  type TraceRow,
} from "./supplychainShared";

export default function TraceabilityTab({ projectId, lookups, onChanged }: { projectId: string; lookups: Lookups; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain`;
  const [status, setStatus] = useState("");
  const records = useResource<ListResponse<TraceRow>>(`${base}/trace/records?pageSize=500${status ? `&status=${status}` : ""}`);
  const coverage = useResource<TraceCoverage>(`${base}/trace/coverage`);
  const nodes = useResource<ListResponse<NodeRow>>(`${base}/nodes?pageSize=500`);
  const deliveries = useResource<ListResponse<{ id: string; reference: string; deliveryNoteNumber: string | null; lineCount: number }>>(`/api/v1/projects/${projectId}/material-deliveries?pageSize=100`);
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<TraceRow>(openId ? `${base}/trace/records/${openId}` : null);
  const action = useAction();
  const [deliveryId, setDeliveryId] = useState("");
  const [lookup, setLookup] = useState("");
  const lookupRes = useResource<{ items: TraceRow[]; total: number }>(lookup.trim() ? `${base}/trace/lookup?heat=${encodeURIComponent(lookup.trim())}` : null);

  function changed() {
    records.reload();
    coverage.reload();
    detail.reload();
    onChanged();
  }

  async function fromDelivery() {
    if (!deliveryId) return;
    const r = await action.run("from-delivery", () => api.post<{ created: unknown[]; skipped: Array<{ reason: string }> }>(`${base}/trace/from-delivery/${deliveryId}`, {}));
    if (r) {
      toast.success(`${r.created.length} trace record(s) created · ${r.skipped.length} line(s) skipped`);
      changed();
    }
  }

  const columns = useMemo<DataColumns<TraceRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 96, mono: true },
      { id: "description", header: "Lot", accessor: "description", type: "text", width: 240 },
      { id: "identifier", header: "Heat / batch / serial", accessor: (row) => [row.heatNumber, row.batchNumber, row.lotNumber, row.serialNumber].filter(Boolean).join(" · "), type: "code", width: 200, mono: true },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, groupable: true, cell: ({ row }) => <Badge tone={TRACE_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
      { id: "chain", header: "Chain", accessor: (row) => row.chainComplete, type: "number", width: 140, cell: ({ row }) => (row.chainComplete === 1 ? <Badge tone="success" size="xs" dot>complete</Badge> : <span title={row.chainGaps.join(" ")}><Badge tone="warning" size="xs" dot>{row.chainGaps.length} gap{row.chainGaps.length === 1 ? "" : "s"}</Badge></span>) },
      { id: "certificateCount", header: "Certs", accessor: "certificateCount", type: "number", width: 80 },
      { id: "materialType", header: "Material", accessor: (row) => row.materialType ?? "", type: "text", width: 140, groupable: true },
      { id: "manufacturer", header: "Manufacturer", accessor: (row) => row.manufacturer ?? "", type: "text", width: 160 },
      { id: "installedAt", header: "Installed", accessor: (row) => row.installedAt ?? "", type: "date", width: 120, cell: ({ row }) => (row.installedAt ? <span>{isoDate(row.installedAt)}{row.installedRef ? <span className="ml-1 text-2xs text-content-muted">{row.installedRef}</span> : null}</span> : EM_DASH) },
      { id: "conformityMarking", header: "CE/UKCA", accessor: (row) => row.conformityMarking ?? "", type: "code", width: 140 },
    ],
    [],
  );

  const cov = coverage.data;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Chain complete" value={cov ? <FigureCell value={cov.completenessPercent} reasons={cov.reasons} render={(v) => pct(v)} /> : EM_DASH} hint={cov ? `${cov.complete} of ${cov.records} record${cov.records === 1 ? "" : "s"}` : undefined} />
        <StatCard label="Installed" value={cov ? num(cov.installed) : EM_DASH} hint={cov ? `${cov.installedWithoutCertificate} without any certificate` : undefined} tone={cov && cov.installedWithoutCertificate > 0 ? "danger" : undefined} />
        <StatCard label="Quarantined" value={cov ? num(cov.byStatus["quarantined"] ?? 0) : EM_DASH} hint="Held pending a certificate or a decision" tone={cov && (cov.byStatus["quarantined"] ?? 0) > 0 ? "warning" : undefined} />
        <StatCard label="Open gaps" value={cov ? num(cov.openGaps.length) : EM_DASH} hint="Records whose chain is not yet closed" />
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Traceability records"
            hint="A certificate is attached by one person and verified by another. Installation without a vouching certificate is allowed but named, and stays a gap until the paperwork catches up."
            actions={
              <>
                <Input size="sm" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Look up a heat number…" aria-label="Heat number lookup" />
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {TRACE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                  Add record
                </Button>
              </>
            }
          />
          {lookup.trim() ? (
            <div className="mb-3 rounded-md border border-border p-2 text-meta">
              {lookupRes.error ? <span className="text-danger-fg">{lookupRes.error}</span> : lookupRes.loading && !lookupRes.data ? "Looking up…" : lookupRes.data && lookupRes.data.total > 0 ? (
                <span>
                  Heat <span className="font-mono">{lookup.trim()}</span>: {lookupRes.data.items.map((r) => (
                    <button key={r.id} type="button" className="ml-2 underline" onClick={() => setOpenId(r.id)}>
                      {r.reference} {r.status === "installed" ? `installed at ${r.installedLocationId}` : labelize(r.status)}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="italic text-content-muted">No record carries heat number {lookup.trim()} on this project.</span>
              )}
            </div>
          ) : null}
          {records.error ? <LoadError message={records.error} onRetry={records.reload} /> : null}
          <DataTable<TraceRow>
            tableId="supply-chain-trace"
            data={records.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={records.loading && !records.data}
            height={480}
            stickyHeader
            filterRow
            exportFileName="traceability"
            searchPlaceholder="Search by reference, lot, heat, batch or serial…"
            defaultSort={[{ id: "reference", desc: true }]}
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.status === "installed" && row.certificateCount === 0 ? "danger" : row.status === "quarantined" ? "warning" : undefined)}
            empty={{ title: "No traceability records", description: "Lift heat and batch numbers from a material delivery, or register a lot by hand." }}
          />
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
            <Field label="Lift heat/batch numbers from a material delivery" hint={deliveries.error ? `Deliveries could not be read: ${deliveries.error}` : "Creates one record per delivery line that carries an identifier; certificate files on the line come across as mill certificates."} className="min-w-64 flex-1">
              <Select value={deliveryId} onChange={(e) => setDeliveryId(e.target.value)}>
                {optionList(deliveries.data?.items ?? [], (d) => `${d.reference}${d.deliveryNoteNumber ? ` · ${d.deliveryNoteNumber}` : ""} (${d.lineCount} line${d.lineCount === 1 ? "" : "s"})`, "— choose a delivery —").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button size="sm" variant="secondary" disabled={!deliveryId} loading={action.busy === "from-delivery"} onClick={() => void fromDelivery()}>
              Import
            </Button>
          </div>
        </CardBody>
      </Card>

      {cov && cov.byMaterialType.length > 0 ? (
        <Card>
          <CardBody>
            <SectionHeading title="Coverage by material" />
            <ul className="divide-y divide-border">
              {cov.byMaterialType.map((b) => (
                <li key={b.materialType} className="flex items-center justify-between gap-2 py-1.5 text-meta">
                  <span>{labelize(b.materialType)}</span>
                  <span className="tabular-nums text-content-muted">
                    {b.completenessPercent === null ? "n/a" : pct(b.completenessPercent, 0)} complete · {b.records} record{b.records === 1 ? "" : "s"} · {b.installedWithoutCertificate} installed uncertified
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <RecordForm projectId={projectId} open={createOpen} lookups={lookups} nodes={nodes.data?.items ?? []} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); changed(); }} />
      <RecordDrawer projectId={projectId} recordId={openId} detail={detail} lookups={lookups} onClose={() => setOpenId(null)} onChanged={changed} />
    </div>
  );
}

function StatCard({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "warning" | "danger" }) {
  return (
    <Card>
      <CardBody>
        <div className="text-label uppercase text-content-subtle">{label}</div>
        <div className={`text-display-xs font-semibold tabular-nums ${tone === "danger" ? "text-danger-fg" : tone === "warning" ? "text-warning-fg" : "text-content"}`}>{value}</div>
        {hint ? <div className="text-2xs text-content-muted">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

function RecordForm({ projectId, open, lookups, nodes, onClose, onCreated }: { projectId: string; open: boolean; lookups: Lookups; nodes: NodeRow[]; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [description, setDescription] = useState("");
  const [materialType, setMaterialType] = useState("");
  const [heatNumber, setHeatNumber] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [originCountry, setOriginCountry] = useState("");
  const [supplierNodeId, setSupplierNodeId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [materialItemId, setMaterialItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [requiresMarking, setRequiresMarking] = useState(false);
  const [certKind, setCertKind] = useState("mill_certificate");
  const [certRef, setCertRef] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { description: description.trim(), requiresConformityMarking: requiresMarking, certificates: certRef.trim() ? [{ kind: certKind, reference: certRef.trim() }] : [] };
    if (materialType.trim()) payload["materialType"] = materialType.trim();
    if (heatNumber.trim()) payload["heatNumber"] = heatNumber.trim();
    if (batchNumber.trim()) payload["batchNumber"] = batchNumber.trim();
    if (serialNumber.trim()) payload["serialNumber"] = serialNumber.trim();
    if (manufacturer.trim()) payload["manufacturer"] = manufacturer.trim();
    if (originCountry.trim()) payload["originCountry"] = originCountry.trim();
    if (supplierNodeId) payload["supplierNodeId"] = supplierNodeId;
    if (vendorId) payload["vendorId"] = vendorId;
    if (materialItemId) payload["materialItemId"] = materialItemId;
    if (quantity.trim()) payload["quantity"] = Number(quantity);
    if (unit.trim()) payload["unit"] = unit.trim();
    const r = await action.run("create", () => api.post<TraceRow>(`/api/v1/projects/${projectId}/supply-chain/trace/records`, payload));
    if (r) {
      toast.success(`${r.reference} registered`);
      setDescription("");
      setHeatNumber("");
      setBatchNumber("");
      setCertRef("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Register a traceable lot" description="At least one identifier: heat, batch or serial number." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Lot" required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={500} placeholder="UB 305x165x40 — 12 lengths" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Heat number">
            <Input value={heatNumber} onChange={(e) => setHeatNumber(e.target.value)} />
          </Field>
          <Field label="Batch number">
            <Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} />
          </Field>
          <Field label="Serial number">
            <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
          </Field>
          <Field label="Material type">
            <Input value={materialType} onChange={(e) => setMaterialType(e.target.value)} placeholder="structural_steel" />
          </Field>
          <Field label="Manufacturer">
            <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          </Field>
          <Field label="Origin country">
            <Input value={originCountry} onChange={(e) => setOriginCountry(e.target.value)} maxLength={3} placeholder="DE" />
          </Field>
          <Field label="Supplier node">
            <Select value={supplierNodeId} onChange={(e) => setSupplierNodeId(e.target.value)}>
              {optionList(nodes, (n) => n.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Catalogue item">
            <Select value={materialItemId} onChange={(e) => setMaterialItemId(e.target.value)}>
              {optionList(lookups.materials, (m) => `${m.reference} ${m.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Quantity">
            <div className="flex gap-2">
              <Input type="number" min={0} step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="t" className="w-20" />
            </div>
          </Field>
          <Field label="First certificate (optional)">
            <Select value={certKind} onChange={(e) => setCertKind(e.target.value)}>
              {TRACE_CERTIFICATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Certificate reference">
            <Input value={certRef} onChange={(e) => setCertRef(e.target.value)} />
          </Field>
        </div>
        <Checkbox label="Product needs a CE / UKCA marking reference" checked={requiresMarking} onChange={(e) => setRequiresMarking(e.target.checked)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={action.busy === "create"}>Register</Button>
        </div>
      </form>
    </Drawer>
  );
}

function RecordDrawer({ projectId, recordId, detail, lookups, onClose, onChanged }: { projectId: string; recordId: string | null; detail: Loadable<TraceRow>; lookups: Lookups; onClose: () => void; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain/trace/records`;
  const action = useAction();
  const d = detail.data;
  const [certKind, setCertKind] = useState("mill_certificate");
  const [certRef, setCertRef] = useState("");
  const [certIssuer, setCertIssuer] = useState("");
  const [locationId, setLocationId] = useState("");
  const [installedRef, setInstalledRef] = useState("");
  const [marking, setMarking] = useState("");
  const [reason, setReason] = useState("");

  async function addCertificate(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    const r = await action.run("cert", () => api.post(`${base}/${d.id}/certificates`, { kind: certKind, reference: certRef.trim(), issuedBy: certIssuer.trim() || null }));
    if (r) {
      toast.success("Certificate attached — it now needs a second person to verify it");
      setCertRef("");
      onChanged();
    }
  }

  async function verify(certificateId: string) {
    if (!d) return;
    const r = await action.run(`verify:${certificateId}`, () => api.post(`${base}/${d.id}/certificates/${certificateId}/verify`, {}));
    if (r) {
      toast.success("Certificate verified");
      onChanged();
    }
  }

  async function install() {
    if (!d || !locationId) return;
    const r = await action.run("install", () => api.post<TraceRow & { warnings: string[] }>(`${base}/${d.id}/install`, { installedLocationId: locationId, installedRef: installedRef.trim() || null }));
    if (r) {
      if (r.warnings.length > 0) toast.warning(r.warnings[0]);
      else toast.success("Installed; chain closed");
      onChanged();
    }
  }

  async function saveMarking() {
    if (!d) return;
    const r = await action.run("marking", () => api.patch(`${base}/${d.id}`, { conformityMarking: marking.trim() || null }));
    if (r) {
      toast.success("Marking recorded");
      onChanged();
    }
  }

  async function lifecycle(verb: "quarantine" | "release" | "reject") {
    if (!d || !reason.trim()) return;
    const body = verb === "release" ? { note: reason.trim() } : { reason: reason.trim() };
    const r = await action.run(verb, () => api.post(`${base}/${d.id}/${verb}`, body));
    if (r) {
      toast.success(`Lot ${verb === "release" ? "released" : `${verb}ed`}`);
      setReason("");
      onChanged();
    }
  }

  const chain = d?.chain;

  return (
    <Drawer
      open={recordId !== null}
      onClose={onClose}
      size="lg"
      title={d ? <span className="flex items-center gap-2"><span className="font-mono">{d.reference}</span><span className="truncate">{d.description}</span><Badge tone={TRACE_STATUS_TONE[d.status] ?? "neutral"} size="xs" dot>{labelize(d.status)}</Badge></span> : "Record"}
      description={d ? [d.heatNumber ? `heat ${d.heatNumber}` : null, d.batchNumber ? `batch ${d.batchNumber}` : null, d.serialNumber ? `serial ${d.serialNumber}` : null, d.manufacturer, d.originCountry].filter(Boolean).join(" · ") : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !d ? (
        <div className="space-y-3">
          <Skeleton height={80} />
          <Skeleton height={160} />
        </div>
      ) : !d || !chain ? null : (
        <div className="space-y-5">
          {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

          <section className="rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Badge tone={chain.complete ? "success" : "warning"} size="sm" dot>{chain.complete ? "Chain complete" : `Chain ${chain.score}%`}</Badge>
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-1 text-meta sm:grid-cols-3">
              {(
                [
                  ["Identifier", chain.links.identifier],
                  ["Provenance", chain.links.provenance],
                  ["Certificate", chain.links.certificate],
                  ["Verified by 2nd person", chain.links.certificateVerified],
                  ["CE / UKCA", chain.links.conformityMarking],
                  ["Installed location", chain.links.installed],
                ] as Array<[string, boolean | null]>
              ).map(([label, ok]) => (
                <li key={label} className="flex items-center gap-1.5">
                  <span className={ok === null ? "text-content-subtle" : ok ? "text-success-fg" : "text-danger-fg"}>{ok === null ? "○" : ok ? "●" : "○"}</span>
                  <span className={ok === null ? "text-content-subtle" : ""}>{label}{ok === null ? " (not required)" : ""}</span>
                </li>
              ))}
            </ul>
            <ReasonList reasons={chain.gaps} className="mt-2" tone={chain.gaps.length > 0 ? "danger" : "muted"} />
          </section>

          <section>
            <SectionHeading title="Certificates" hint="Mill, test, declaration of conformity or CE/UKCA vouch for the lot. Whoever attached a certificate cannot verify it." />
            {d.certificates.length === 0 ? <p className="text-meta italic text-content-muted">No certificate attached.</p> : null}
            <ul className="divide-y divide-border">
              {d.certificates.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-1.5 text-meta">
                  <span>
                    <span className="font-medium">{labelize(c.kind)}</span> <span className="font-mono">{c.reference}</span>{c.issuedBy ? <span className="text-content-muted"> · {c.issuedBy}</span> : null}
                    {c.fileId ? <span className="text-2xs text-content-muted"> · file {c.fileId}</span> : null}
                  </span>
                  {c.verifiedBy ? (
                    <Badge tone="success" size="xs">verified {dateTime(c.verifiedAt)}</Badge>
                  ) : d.status !== "rejected" ? (
                    <Button size="xs" variant="secondary" loading={action.busy === `verify:${c.id}`} onClick={() => void verify(c.id)}>Verify</Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {d.status !== "rejected" ? (
              <form onSubmit={(e) => void addCertificate(e)} className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="Kind">
                  <Select size="sm" value={certKind} onChange={(e) => setCertKind(e.target.value)}>
                    {TRACE_CERTIFICATE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {labelize(k)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reference" className="min-w-32 flex-1">
                  <Input size="sm" value={certRef} onChange={(e) => setCertRef(e.target.value)} required />
                </Field>
                <Field label="Issued by">
                  <Input size="sm" value={certIssuer} onChange={(e) => setCertIssuer(e.target.value)} />
                </Field>
                <Button type="submit" size="sm" variant="secondary" loading={action.busy === "cert"}>Attach</Button>
              </form>
            ) : null}
          </section>

          <section>
            <SectionHeading title="Record" />
            <KeyValue
              items={[
                { label: "Material", value: d.materialType ?? EM_DASH },
                { label: "Quantity", value: d.quantity === null ? EM_DASH : `${d.quantity} ${d.unit ?? ""}` },
                { label: "Supplier / vendor", value: d.supplierNodeId ?? d.vendorId ?? EM_DASH },
                { label: "Catalogue item", value: d.materialItemId ?? EM_DASH },
                { label: "Delivery line", value: d.materialDeliveryLineId ?? EM_DASH },
                { label: "Delivery slot", value: d.deliverySlotId ?? EM_DASH },
                { label: "Received", value: isoDate(d.receivedAt) },
                { label: "Installed", value: d.installedAt ? `${isoDate(d.installedAt)} at ${d.installedLocationId}${d.installedRef ? ` (${d.installedRef})` : ""} by ${d.installedBy}` : EM_DASH },
                { label: "CE / UKCA", value: d.conformityMarking ?? EM_DASH },
                { label: "Responsible sourcing", value: d.responsibleSourcingScheme ?? EM_DASH },
              ]}
            />
            {d.status !== "installed" && d.status !== "rejected" ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="CE / UKCA marking reference" className="min-w-48 flex-1">
                  <Input size="sm" value={marking} onChange={(e) => setMarking(e.target.value)} placeholder={d.conformityMarking ?? ""} />
                </Field>
                <Button size="sm" variant="secondary" loading={action.busy === "marking"} onClick={() => void saveMarking()}>Save</Button>
              </div>
            ) : null}
          </section>

          {d.status === "received" || d.status === "certified" ? (
            <section className="rounded-md border border-border p-3">
              <SectionHeading title="Install" hint="Records where the lot went. Allowed without a certificate, but named as a gap." className="mb-2" />
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Location" className="min-w-48 flex-1">
                  <Select size="sm" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    {optionList(lookups.locations, (l) => l.name).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Element / mark">
                  <Input size="sm" value={installedRef} onChange={(e) => setInstalledRef(e.target.value)} placeholder="Beam B3-07" />
                </Field>
                <Button size="sm" disabled={!locationId} loading={action.busy === "install"} onClick={() => void install()}>Install</Button>
              </div>
            </section>
          ) : null}

          {d.status !== "installed" ? (
            <section className="rounded-md border border-danger-border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Reason / note" className="min-w-48 flex-1">
                  <Input size="sm" value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                {d.status === "received" || d.status === "certified" ? <Button size="sm" variant="secondary" disabled={!reason.trim()} loading={action.busy === "quarantine"} onClick={() => void lifecycle("quarantine")}>Quarantine</Button> : null}
                {d.status === "quarantined" ? <Button size="sm" variant="secondary" disabled={!reason.trim()} loading={action.busy === "release"} onClick={() => void lifecycle("release")}>Release</Button> : null}
                {d.status !== "rejected" ? <Button size="sm" variant="ghost" disabled={!reason.trim()} loading={action.busy === "reject"} onClick={() => void lifecycle("reject")}>Reject</Button> : null}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
