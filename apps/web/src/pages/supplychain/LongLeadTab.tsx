/**
 * LONG-LEAD — the order-by date the programme dictates (#918–921, #727–728).
 * Every row shows the engine's verdict AND its reasons; the drawer records
 * milestones in order, logs every chase, and shows the obligation the
 * order-by date raised.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { EXPEDITING_ACTIONS, INCOTERMS, LONG_LEAD_RISK_LEVELS, LONG_LEAD_STATUSES } from "@constructos/shared";
import { Badge, Button, Card, CardBody, Checkbox, Drawer, Field, Input, Select, Skeleton, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus, IconRefresh } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  EXPECTED_BASIS_LABEL,
  KeyValue,
  LONG_LEAD_RISK_TONE,
  LONG_LEAD_STATUS_TONE,
  LoadError,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  money,
  nextMilestones,
  optionList,
  today,
  useAction,
  useResource,
  type ListResponse,
  type Loadable,
  type LongLeadDetail,
  type LongLeadRow,
  type Lookups,
  type NodeRow,
} from "./supplychainShared";

export default function LongLeadTab({ projectId, lookups, onChanged }: { projectId: string; lookups: Lookups; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain`;
  const [status, setStatus] = useState("");
  const [risk, setRisk] = useState("");
  const query = new URLSearchParams({ pageSize: "500" });
  if (status) query.set("status", status);
  if (risk) query.set("riskLevel", risk);
  const items = useResource<ListResponse<LongLeadRow>>(`${base}/long-lead?${query.toString()}`);
  const nodes = useResource<ListResponse<NodeRow>>(`${base}/nodes?pageSize=500`);
  const nodeName = useMemo(() => new Map((nodes.data?.items ?? []).map((n) => [n.id, n.name])), [nodes.data]);
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<LongLeadDetail>(openId ? `${base}/long-lead/${openId}` : null);
  const action = useAction();

  function changed() {
    items.reload();
    detail.reload();
    onChanged();
  }

  async function recompute() {
    const r = await action.run("recompute", () => api.post<{ assessed: number; signalsRaised: number; byRisk: Record<string, number> }>(`${base}/long-lead/recompute`, {}));
    if (r) {
      toast.success(`${r.assessed} item(s) re-assessed · ${r.signalsRaised} new signal(s)`);
      changed();
    }
  }

  const columns = useMemo<DataColumns<LongLeadRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 96, mono: true },
      { id: "name", header: "Item", accessor: "name", type: "text", width: 220 },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 130, groupable: true, cell: ({ row }) => <Badge tone={LONG_LEAD_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
      {
        id: "riskLevel",
        header: "Risk of late",
        accessor: "riskLevel",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <span title={row.riskReasons.join(" ")}>
            <Badge tone={LONG_LEAD_RISK_TONE[row.riskLevel] ?? "neutral"} size="xs" dot>
              {labelize(row.riskLevel)}
            </Badge>
          </span>
        ),
      },
      { id: "supplier", header: "Supplier", accessor: (row) => (row.supplierNodeId ? nodeName.get(row.supplierNodeId) ?? row.supplierNodeId : ""), type: "text", width: 160, groupable: true },
      { id: "task", header: "Feeds task", accessor: (row) => row.scheduleTaskName ?? "", type: "text", width: 180 },
      { id: "requiredOnSite", header: "Required on site", accessor: (row) => row.requiredOnSite ?? "", type: "date", width: 130, cell: ({ row }) => (row.requiredOnSite ? <span>{isoDate(row.requiredOnSite)}{row.requiredFromSchedule === 1 ? <span className="ml-1 text-2xs text-content-subtle">(programme)</span> : null}</span> : <span className="italic text-content-subtle">not set</span>) },
      { id: "orderByDate", header: "Order by", accessor: (row) => row.orderByDate ?? "", type: "date", width: 120, cell: ({ row }) => (row.orderByDate ? isoDate(row.orderByDate) : <span className="italic text-content-subtle">n/a</span>) },
      { id: "floatDays", header: "Float (d)", accessor: (row) => row.floatDays, type: "number", width: 90, signColor: true, cell: ({ row }) => (row.floatDays === null ? <span className="italic text-content-subtle">n/a</span> : <span className={row.floatDays < 0 ? "text-danger-fg" : ""}>{row.floatDays}</span>) },
      { id: "leadTimeDays", header: "Lead (d)", accessor: "leadTimeDays", type: "number", width: 80 },
      { id: "forecast", header: "Forecast arrival", accessor: (row) => row.forecastArrivalDate ?? row.plannedArrivalDate ?? "", type: "date", width: 130, cell: ({ row }) => isoDate(row.actualArrivalDate ?? row.forecastArrivalDate ?? row.plannedArrivalDate) },
      { id: "value", header: "Value", accessor: (row) => row.value, type: "number", width: 120, cell: ({ row }) => money(row.value, row.currency) },
      { id: "expedited", header: "Last chased", accessor: (row) => row.lastExpeditedAt ?? "", type: "date", width: 120, cell: ({ row }) => (row.lastExpeditedAt ? isoDate(row.lastExpeditedAt) : <span className="italic text-content-subtle">never</span>) },
    ],
    [nodeName],
  );

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Long-lead register"
            hint="Order-by = required on site − lead time − buffer. Required-on-site follows the linked schedule task unless a date is typed. Each unordered item holds an open obligation for its order-by date."
            actions={
              <>
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {LONG_LEAD_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Select size="sm" value={risk} onChange={(e) => setRisk(e.target.value)} aria-label="Risk filter">
                  <option value="">All risk levels</option>
                  {LONG_LEAD_RISK_LEVELS.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="secondary" leadingIcon={IconRefresh} loading={action.busy === "recompute"} onClick={() => void recompute()}>
                  Re-assess
                </Button>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                  Add item
                </Button>
              </>
            }
          />
          {items.error ? <LoadError message={items.error} onRetry={items.reload} /> : null}
          <DataTable<LongLeadRow>
            tableId="supply-chain-long-lead"
            data={items.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={items.loading && !items.data}
            height={560}
            stickyHeader
            filterRow
            exportFileName="long-lead-register"
            searchPlaceholder="Search by reference, item or PO…"
            defaultSort={[{ id: "orderByDate", desc: false }]}
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.riskLevel === "late" ? "danger" : row.riskLevel === "at_risk" ? "warning" : undefined)}
            empty={{ title: "No long-lead items", description: "Register the items whose lead time could hold the programme: steelwork, switchgear, lifts, curtain walling, bespoke plant.", action: <Button size="sm" onClick={() => setCreateOpen(true)}>Add the first item</Button> }}
          />
        </CardBody>
      </Card>

      <ItemForm projectId={projectId} open={createOpen} lookups={lookups} nodes={nodes.data?.items ?? []} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); changed(); }} />
      <ItemDrawer projectId={projectId} itemId={openId} detail={detail} lookups={lookups} nodes={nodes.data?.items ?? []} onClose={() => setOpenId(null)} onChanged={changed} />
    </div>
  );
}

function ItemForm({ projectId, open, lookups, nodes, onClose, onCreated }: { projectId: string; open: boolean; lookups: Lookups; nodes: NodeRow[]; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [supplierNodeId, setSupplierNodeId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [scheduleTaskId, setScheduleTaskId] = useState("");
  const [requiredOnSite, setRequiredOnSite] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("0");
  const [bufferDays, setBufferDays] = useState("0");
  const [plannedArrivalDate, setPlannedArrivalDate] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [incoterms, setIncoterms] = useState("");
  const [customsRequired, setCustomsRequired] = useState(false);
  const [materialItemId, setMaterialItemId] = useState("");
  const [purchaseOrderRef, setPurchaseOrderRef] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { name: name.trim(), leadTimeDays: Number(leadTimeDays) || 0, bufferDays: Number(bufferDays) || 0, customsRequired, currency: currency.trim().toUpperCase() || "USD" };
    if (category.trim()) payload["category"] = category.trim();
    if (supplierNodeId) payload["supplierNodeId"] = supplierNodeId;
    if (vendorId) payload["vendorId"] = vendorId;
    if (scheduleTaskId) payload["scheduleTaskId"] = scheduleTaskId;
    if (requiredOnSite) payload["requiredOnSite"] = requiredOnSite;
    if (plannedArrivalDate) payload["plannedArrivalDate"] = plannedArrivalDate;
    if (value.trim()) payload["value"] = Number(value);
    if (incoterms) payload["incoterms"] = incoterms;
    if (materialItemId) payload["materialItemId"] = materialItemId;
    if (purchaseOrderRef.trim()) payload["purchaseOrderRef"] = purchaseOrderRef.trim();
    const r = await action.run("create", () => api.post<LongLeadRow>(`/api/v1/projects/${projectId}/supply-chain/long-lead`, payload));
    if (r) {
      toast.success(`${r.reference} registered — ${labelize(r.riskLevel).toLowerCase()}`);
      setName("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Register a long-lead item" description="Link the schedule task it feeds and the order-by date follows the programme." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Item" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Feeds schedule task" hint={lookups.tasks.length === 0 ? "No schedule tasks found for this project." : "Required-on-site copies the task start."}>
            <Select value={scheduleTaskId} onChange={(e) => setScheduleTaskId(e.target.value)}>
              {optionList(lookups.tasks, (t) => `${t.name}${t.startDate ? ` (${t.startDate})` : ""}${t.isCritical === 1 ? " ★" : ""}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Required on site" hint="Leave empty to follow the task">
            <Input type="date" value={requiredOnSite} onChange={(e) => setRequiredOnSite(e.target.value)} />
          </Field>
          <Field label="Lead time (days)" required>
            <Input type="number" min={0} value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} required />
          </Field>
          <Field label="Buffer (days)">
            <Input type="number" min={0} value={bufferDays} onChange={(e) => setBufferDays(e.target.value)} />
          </Field>
          <Field label="Supplier node">
            <Select value={supplierNodeId} onChange={(e) => setSupplierNodeId(e.target.value)}>
              {optionList(nodes, (n) => `T${n.tier} ${n.name}`).map((o) => (
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
          <Field label="Planned arrival">
            <Input type="date" value={plannedArrivalDate} onChange={(e) => setPlannedArrivalDate(e.target.value)} />
          </Field>
          <Field label="Category">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="steel" />
          </Field>
          <Field label="Value">
            <Input type="number" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
          </Field>
          <Field label="Incoterms">
            <Select value={incoterms} onChange={(e) => setIncoterms(e.target.value)}>
              <option value="">—</option>
              {INCOTERMS.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="PO reference">
            <Input value={purchaseOrderRef} onChange={(e) => setPurchaseOrderRef(e.target.value)} />
          </Field>
          <Field label="Catalogue item" hint="equipment.materials — the line it becomes on site">
            <Select value={materialItemId} onChange={(e) => setMaterialItemId(e.target.value)}>
              {optionList(lookups.materials, (m) => `${m.reference} ${m.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Checkbox label="Customs clearance required" checked={customsRequired} onChange={(e) => setCustomsRequired(e.target.checked)} />
        <ReasonList reasons={lookups.notes} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Register
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

interface ItemEdit {
  name: string;
  category: string;
  scheduleTaskId: string;
  requiredOnSite: string;
  leadTimeDays: string;
  bufferDays: string;
  supplierNodeId: string;
  vendorId: string;
  purchaseOrderRef: string;
  plannedArrivalDate: string;
  forecastArrivalDate: string;
  value: string;
  currency: string;
  incoterms: string;
  customsRequired: boolean;
}

const EMPTY_ITEM_EDIT: ItemEdit = { name: "", category: "", scheduleTaskId: "", requiredOnSite: "", leadTimeDays: "0", bufferDays: "0", supplierNodeId: "", vendorId: "", purchaseOrderRef: "", plannedArrivalDate: "", forecastArrivalDate: "", value: "", currency: "USD", incoterms: "", customsRequired: false };

function ItemDrawer({ projectId, itemId, detail, lookups, nodes, onClose, onChanged }: { projectId: string; itemId: string | null; detail: Loadable<LongLeadDetail>; lookups: Lookups; nodes: NodeRow[]; onClose: () => void; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain/long-lead`;
  const action = useAction();
  const d = detail.data;
  const [milestoneAt, setMilestoneAt] = useState(today());
  const [chaseAction, setChaseAction] = useState("call");
  const [chaseContact, setChaseContact] = useState("");
  const [chaseNote, setChaseNote] = useState("");
  const [promisedDate, setPromisedDate] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<ItemEdit>(EMPTY_ITEM_EDIT);

  function startEditing() {
    if (!d) return;
    setEdit({
      name: d.name,
      category: d.category ?? "",
      scheduleTaskId: d.scheduleTaskId ?? "",
      // A need date that follows the programme is left blank here: typing one
      // is what takes the item OFF the programme, so the form must not put
      // the derived date back in as if it had been typed.
      requiredOnSite: d.requiredFromSchedule === 1 ? "" : (d.requiredOnSite ?? ""),
      leadTimeDays: String(d.leadTimeDays),
      bufferDays: String(d.bufferDays),
      supplierNodeId: d.supplierNodeId ?? "",
      vendorId: d.vendorId ?? "",
      purchaseOrderRef: d.purchaseOrderRef ?? "",
      plannedArrivalDate: d.plannedArrivalDate ?? "",
      forecastArrivalDate: d.forecastArrivalDate ?? "",
      value: d.value === null ? "" : String(d.value),
      currency: d.currency,
      incoterms: d.incoterms ?? "",
      customsRequired: d.customsRequired === 1,
    });
    setEditing(true);
  }

  /**
   * The register is only as good as its inputs: a lead time of 40 days where
   * the mill quoted 400 makes the order-by date, the float, the risk level
   * and the obligation deadline all wrong. Correcting it here keeps the
   * reference, the milestones and the expediting log; cancelling would not.
   */
  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    const payload: Record<string, unknown> = {
      name: edit.name.trim(),
      category: edit.category.trim() ? edit.category.trim() : null,
      scheduleTaskId: edit.scheduleTaskId ? edit.scheduleTaskId : null,
      requiredOnSite: edit.requiredOnSite ? edit.requiredOnSite : null,
      leadTimeDays: Number(edit.leadTimeDays || 0),
      bufferDays: Number(edit.bufferDays || 0),
      supplierNodeId: edit.supplierNodeId ? edit.supplierNodeId : null,
      vendorId: edit.vendorId ? edit.vendorId : null,
      purchaseOrderRef: edit.purchaseOrderRef.trim() ? edit.purchaseOrderRef.trim() : null,
      plannedArrivalDate: edit.plannedArrivalDate ? edit.plannedArrivalDate : null,
      forecastArrivalDate: edit.forecastArrivalDate ? edit.forecastArrivalDate : null,
      value: edit.value.trim() ? Number(edit.value) : null,
      currency: edit.currency.trim().toUpperCase(),
      incoterms: edit.incoterms ? edit.incoterms : null,
      customsRequired: edit.customsRequired,
    };
    const r = await action.run("edit", () => api.patch<LongLeadRow & { assessment: LongLeadDetail["assessment"] }>(`${base}/${d.id}`, payload));
    if (r) {
      toast.success(`${r.reference} updated · order by ${r.assessment.orderByDate ?? "n/a"}`);
      setEditing(false);
      onChanged();
    }
  }

  async function milestone(m: string) {
    if (!d) return;
    const r = await action.run(`m:${m}`, () => api.post<LongLeadRow>(`${base}/${d.id}/milestones`, { milestone: m, at: milestoneAt }));
    if (r) {
      toast.success(`${r.reference}: ${labelize(m).toLowerCase()} recorded`);
      onChanged();
    }
  }

  async function expedite(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    const payload: Record<string, unknown> = { action: chaseAction };
    if (chaseContact.trim()) payload["contactName"] = chaseContact.trim();
    if (chaseNote.trim()) payload["note"] = chaseNote.trim();
    if (promisedDate) payload["promisedDate"] = promisedDate;
    const r = await action.run("expedite", () => api.post(`${base}/${d.id}/expedite`, payload));
    if (r) {
      toast.success("Chase logged");
      setChaseNote("");
      setPromisedDate("");
      onChanged();
    }
  }

  async function cancel() {
    if (!d || !cancelReason.trim()) return;
    const r = await action.run("cancel", () => api.post(`${base}/${d.id}/cancel`, { reason: cancelReason.trim() }));
    if (r) {
      toast.success("Item cancelled; its obligation waived");
      onChanged();
    }
  }

  const closed = d ? d.status === "installed" || d.status === "cancelled" : true;
  const next = d ? nextMilestones(d.status, d.customsRequired === 1) : [];

  return (
    <Drawer
      open={itemId !== null}
      onClose={onClose}
      size="lg"
      title={d ? <span className="flex items-center gap-2"><span className="font-mono">{d.reference}</span><span className="truncate">{d.name}</span></span> : "Long-lead item"}
      description={d ? `${labelize(d.status)} · ${d.supplierNode?.name ?? d.vendorId ?? "no supplier"} · lead ${d.leadTimeDays}d + buffer ${d.bufferDays}d` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !d ? (
        <div className="space-y-3">
          <Skeleton height={90} />
          <Skeleton height={180} />
        </div>
      ) : !d ? null : (
        <div className="space-y-5">
          {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

          <section className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={LONG_LEAD_RISK_TONE[d.assessment.riskLevel] ?? "neutral"} size="sm" dot>
                {labelize(d.assessment.riskLevel)}
              </Badge>
              <span className="text-meta text-content-muted">
                order by <strong className="text-content">{isoDate(d.assessment.orderByDate)}</strong> · expected on site <strong className="text-content">{isoDate(d.assessment.expectedOnSite)}</strong> ({EXPECTED_BASIS_LABEL[d.assessment.expectedOnSiteBasis] ?? d.assessment.expectedOnSiteBasis}) · float{" "}
                <strong className={d.assessment.floatDays !== null && d.assessment.floatDays < 0 ? "text-danger-fg" : "text-content"}>{d.assessment.floatDays === null ? "n/a" : `${d.assessment.floatDays}d`}</strong>
              </span>
            </div>
            <ReasonList reasons={d.assessment.reasons} className="mt-2" />
            {d.task ? (
              <p className="mt-2 text-2xs text-content-muted">
                Feeds <strong>{d.task.name}</strong> starting {isoDate(d.task.actualStart ?? d.task.startDate)}
                {d.task.isCritical ? " — on the critical path" : ""}.{d.requiredFromSchedule === 1 ? " Required-on-site follows the programme." : " Required-on-site was typed and overrides the programme."}
              </p>
            ) : null}
            {d.obligationId ? <p className="mt-1 text-2xs text-content-muted">Order-by obligation: <span className="font-mono">{d.obligationId}</span></p> : null}
          </section>

          <section>
            <SectionHeading title="Milestones" hint="Recorded in order; each stamps its actual date. Skipping a step is refused — the milestones are the audit trail of the order." />
            <ol className="grid grid-cols-2 gap-x-6 gap-y-1 text-meta sm:grid-cols-3">
              <Milestone label="Ordered" planned={d.plannedOrderDate} actual={d.actualOrderDate} />
              <Milestone label="Production start" planned={d.plannedProductionStart} actual={d.actualProductionStart} />
              <Milestone label="Shipped" planned={d.plannedShipDate} actual={d.actualShipDate} />
              {d.customsRequired === 1 ? <Milestone label="Customs cleared" planned={null} actual={d.customsClearedAt} /> : null}
              <Milestone label="Arrived" planned={d.plannedArrivalDate} actual={d.actualArrivalDate} forecast={d.forecastArrivalDate} />
              <Milestone label="Installed" planned={d.requiredOnSite} actual={d.installedAt} />
            </ol>
            {!closed && next.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="On">
                  <Input type="date" size="sm" value={milestoneAt} onChange={(e) => setMilestoneAt(e.target.value)} />
                </Field>
                {next.map((m) => (
                  <Button key={m} size="sm" variant={m === next[0] ? "primary" : "secondary"} loading={action.busy === `m:${m}`} onClick={() => void milestone(m)}>
                    Record {labelize(m).toLowerCase()}
                  </Button>
                ))}
              </div>
            ) : null}
          </section>

          <section>
            <SectionHeading title="Expediting" hint={`${d.expeditingCount} chase${d.expeditingCount === 1 ? "" : "s"} logged · last ${d.lastExpeditedAt ? dateTime(d.lastExpeditedAt) : "never"}. A promise received becomes the forecast the engine tests.`} />
            {!closed ? (
              <form onSubmit={(e) => void expedite(e)} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3">
                <Field label="Action">
                  <Select value={chaseAction} onChange={(e) => setChaseAction(e.target.value)}>
                    {EXPEDITING_ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {labelize(a)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Contact">
                  <Input value={chaseContact} onChange={(e) => setChaseContact(e.target.value)} />
                </Field>
                <Field label="Promised arrival" hint="sets the forecast">
                  <Input type="date" value={promisedDate} onChange={(e) => setPromisedDate(e.target.value)} />
                </Field>
                <Field label="Note" className="col-span-2">
                  <Textarea rows={2} value={chaseNote} onChange={(e) => setChaseNote(e.target.value)} />
                </Field>
                <div className="col-span-2 flex justify-end">
                  <Button type="submit" size="sm" loading={action.busy === "expedite"}>
                    Log chase
                  </Button>
                </div>
              </form>
            ) : null}
            {d.expeditingLogHasMore ? <p className="mt-2 text-2xs text-content-muted">Showing the most recent 200 entries; older chases are not listed.</p> : null}
            {d.expeditingLog.length === 0 ? (
              <p className="mt-2 text-meta italic text-content-muted">No expediting contact has been logged.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {d.expeditingLog.map((l) => (
                  <li key={l.id} className="py-1.5 text-meta">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{labelize(l.action)}{l.contactName ? ` · ${l.contactName}` : ""}</span>
                      <span className="text-2xs text-content-muted">{dateTime(l.loggedAt)}</span>
                    </div>
                    {l.promisedDate ? <div className="text-2xs text-content-muted">Promised {isoDate(l.promisedDate)}</div> : null}
                    {l.note ? <div className="text-content-muted">{l.note}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionHeading
              title="Record"
              actions={
                closed ? null : editing ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel edit
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={startEditing}>
                    Edit item
                  </Button>
                )
              }
            />
            {editing ? (
              <form onSubmit={(e) => void saveEdit(e)} className="space-y-3 rounded-md border border-border p-3">
                <Field label="Item" required>
                  <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required maxLength={200} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Feeds schedule task" hint="Required-on-site copies the task start.">
                    <Select value={edit.scheduleTaskId} onChange={(e) => setEdit({ ...edit, scheduleTaskId: e.target.value })}>
                      {optionList(lookups.tasks, (t) => `${t.name}${t.startDate ? ` (${t.startDate})` : ""}${t.isCritical === 1 ? " ★" : ""}`).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Required on site" hint={d.requiredFromSchedule === 1 ? "Empty = follow the programme" : "Typed date overrides the programme"}>
                    <Input type="date" value={edit.requiredOnSite} onChange={(e) => setEdit({ ...edit, requiredOnSite: e.target.value })} />
                  </Field>
                  <Field label="Lead time (days)" required>
                    <Input type="number" min={0} value={edit.leadTimeDays} onChange={(e) => setEdit({ ...edit, leadTimeDays: e.target.value })} required />
                  </Field>
                  <Field label="Buffer (days)">
                    <Input type="number" min={0} value={edit.bufferDays} onChange={(e) => setEdit({ ...edit, bufferDays: e.target.value })} />
                  </Field>
                  <Field label="Supplier node">
                    <Select value={edit.supplierNodeId} onChange={(e) => setEdit({ ...edit, supplierNodeId: e.target.value })}>
                      {optionList(nodes, (n) => `T${n.tier} ${n.name}`).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Vendor">
                    <Select value={edit.vendorId} onChange={(e) => setEdit({ ...edit, vendorId: e.target.value })}>
                      {optionList(lookups.vendors, (v) => v.name).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Planned arrival">
                    <Input type="date" value={edit.plannedArrivalDate} onChange={(e) => setEdit({ ...edit, plannedArrivalDate: e.target.value })} />
                  </Field>
                  <Field label="Forecast arrival" hint="what the supplier last promised">
                    <Input type="date" value={edit.forecastArrivalDate} onChange={(e) => setEdit({ ...edit, forecastArrivalDate: e.target.value })} />
                  </Field>
                  <Field label="Category">
                    <Input value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} />
                  </Field>
                  <Field label="PO reference">
                    <Input value={edit.purchaseOrderRef} onChange={(e) => setEdit({ ...edit, purchaseOrderRef: e.target.value })} />
                  </Field>
                  <Field label="Value">
                    <Input type="number" min={0} step="0.01" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
                  </Field>
                  <Field label="Currency" hint="ISO 4217">
                    <Input value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value })} maxLength={3} />
                  </Field>
                  <Field label="Incoterms">
                    <Select value={edit.incoterms} onChange={(e) => setEdit({ ...edit, incoterms: e.target.value })}>
                      <option value="">—</option>
                      {INCOTERMS.map((i) => (
                        <option key={i} value={i}>
                          {i}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Checkbox label="Customs clearance required" checked={edit.customsRequired} onChange={(e) => setEdit({ ...edit, customsRequired: e.target.checked })} />
                <ReasonList reasons={lookups.notes} />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" loading={action.busy === "edit"}>
                    Save changes
                  </Button>
                </div>
              </form>
            ) : (
              <KeyValue
                items={[
                  { label: "Quantity", value: d.quantity === null ? EM_DASH : `${d.quantity} ${d.unit ?? ""}` },
                  { label: "Value", value: money(d.value, d.currency) },
                  { label: "PO", value: d.purchaseOrderRef ?? EM_DASH },
                  { label: "Incoterms", value: d.incoterms ?? EM_DASH },
                  { label: "Origin", value: d.originCountry ?? EM_DASH },
                  { label: "Catalogue item", value: d.materialItemId ?? EM_DASH },
                  { label: "Category", value: d.category ?? EM_DASH },
                  { label: "Assessed", value: dateTime(d.riskAssessedAt) },
                ]}
              />
            )}
          </section>

          {!closed ? (
            <section className="rounded-md border border-danger-border p-3">
              <SectionHeading title="Cancel this item" hint="Waives the order-by obligation. The record stays." className="mb-2" />
              <div className="flex items-end gap-2">
                <Field label="Reason" className="flex-1">
                  <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                </Field>
                <Button size="sm" variant="secondary" disabled={!cancelReason.trim()} loading={action.busy === "cancel"} onClick={() => void cancel()}>
                  Cancel item
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

function Milestone({ label, planned, actual, forecast }: { label: string; planned: string | null; actual: string | null; forecast?: string | null }) {
  return (
    <li className="flex items-baseline justify-between gap-2 border-b border-border py-1">
      <span className="text-content-muted">{label}</span>
      <span className="tabular-nums">
        {actual ? (
          <span className="text-success-fg">{isoDate(actual)}</span>
        ) : forecast ? (
          <span title="supplier forecast">{isoDate(forecast)} <span className="text-2xs text-content-subtle">fcst</span></span>
        ) : planned ? (
          <span className="text-content-muted">{isoDate(planned)} <span className="text-2xs text-content-subtle">plan</span></span>
        ) : (
          <span className="italic text-content-subtle">{EM_DASH}</span>
        )}
      </span>
    </li>
  );
}
