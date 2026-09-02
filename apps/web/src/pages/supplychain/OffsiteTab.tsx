/**
 * OFFSITE — units in the factory (#922–929). Progress is what the stages
 * say; the percent a valuation may rely on is what an inspector who
 * completed no stage has witnessed. A QA gate is recorded by someone other
 * than the person who completed the stage.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FACTORY_INSPECTION_KINDS, OFFSITE_UNIT_STATUSES, OFFSITE_UNIT_TYPES } from "@constructos/shared";
import { Badge, Button, Card, CardBody, Checkbox, Drawer, Field, Input, Progress, Select, Skeleton, Textarea } from "../../ui";
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
  UNIT_STATUS_TONE,
  dateTime,
  isoDate,
  labelize,
  money,
  optionList,
  pct,
  today,
  useAction,
  useResource,
  type ListResponse,
  type Loadable,
  type Lookups,
  type NodeRow,
  type StageRow,
  type UnitDetail,
  type UnitRow,
} from "./supplychainShared";

export default function OffsiteTab({ projectId, lookups, onChanged }: { projectId: string; lookups: Lookups; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain`;
  const [status, setStatus] = useState("");
  const units = useResource<ListResponse<UnitRow>>(`${base}/offsite/units?pageSize=500${status ? `&status=${status}` : ""}`);
  const nodes = useResource<ListResponse<NodeRow>>(`${base}/nodes?pageSize=500`);
  const nodeName = useMemo(() => new Map((nodes.data?.items ?? []).map((n) => [n.id, n.name])), [nodes.data]);
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<UnitDetail>(openId ? `${base}/offsite/units/${openId}` : null);

  function changed() {
    units.reload();
    detail.reload();
    onChanged();
  }

  const columns = useMemo<DataColumns<UnitRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 96, mono: true },
      { id: "name", header: "Unit", accessor: "name", type: "text", width: 220 },
      { id: "unitType", header: "Type", accessor: "unitType", type: "enum", width: 140, groupable: true, cell: ({ row }) => labelize(row.unitType) },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 130, groupable: true, cell: ({ row }) => <Badge tone={UNIT_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
      { id: "factory", header: "Factory", accessor: (row) => (row.factoryNodeId ? nodeName.get(row.factoryNodeId) ?? row.factoryNodeId : ""), type: "text", width: 160, groupable: true },
      { id: "percentComplete", header: "Stages complete", accessor: "percentComplete", type: "percent", width: 150, progress: true, cell: ({ row }) => <span className="tabular-nums">{pct(row.percentComplete, 0)} <span className="text-2xs text-content-muted">({row.stagesComplete}/{row.stagesTotal})</span></span> },
      { id: "verified", header: "Verified for payment", accessor: (row) => row.percentVerifiedForPayment, type: "percent", width: 160, cell: ({ row }) => (row.percentVerifiedForPayment === null ? <span className="italic text-content-subtle">not verified</span> : pct(row.percentVerifiedForPayment, 0)) },
      { id: "qa", header: "QA gates", accessor: (row) => row.qaGatesPassed, type: "number", width: 110, cell: ({ row }) => <span className="tabular-nums">{row.qaGatesPassed}/{row.qaGatesTotal}{row.qaGatesFailed > 0 ? <span className="ml-1 text-danger-fg">({row.qaGatesFailed} failed)</span> : null}</span> },
      { id: "plannedDeliveryDate", header: "Planned delivery", accessor: (row) => row.plannedDeliveryDate ?? "", type: "date", width: 130, cell: ({ row }) => isoDate(row.actualDeliveryDate ?? row.plannedDeliveryDate) },
      { id: "value", header: "Value", accessor: (row) => row.value, type: "number", width: 120, cell: ({ row }) => money(row.value, row.currency) },
      { id: "serialNumber", header: "Serial", accessor: (row) => row.serialNumber ?? "", type: "code", width: 130, mono: true },
    ],
    [nodeName],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <SectionHeading
            title="Offsite units"
            hint="One identifier from design to installation. Stage completion is the factory's claim; the verified percent is what an independent inspection witnessed, and only that may feed a valuation."
            actions={
              <>
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {OFFSITE_UNIT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                  Add unit
                </Button>
              </>
            }
          />
          {units.error ? <LoadError message={units.error} onRetry={units.reload} /> : null}
          <DataTable<UnitRow>
            tableId="supply-chain-offsite"
            data={units.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={units.loading && !units.data}
            height={520}
            stickyHeader
            filterRow
            exportFileName="offsite-units"
            searchPlaceholder="Search by reference, name or serial…"
            defaultSort={[{ id: "reference", desc: false }]}
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.status === "qa_hold" || row.status === "rejected" ? "danger" : undefined)}
            empty={{ title: "No offsite units", description: "Register the modules, pods, panels and assemblies being built away from site.", action: <Button size="sm" onClick={() => setCreateOpen(true)}>Add the first unit</Button> }}
          />
        </CardBody>
      </Card>
      <UnitForm projectId={projectId} open={createOpen} lookups={lookups} nodes={nodes.data?.items ?? []} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); changed(); }} />
      <UnitDrawer projectId={projectId} unitId={openId} detail={detail} lookups={lookups} onClose={() => setOpenId(null)} onChanged={changed} />
    </div>
  );
}

function UnitForm({ projectId, open, lookups, nodes, onClose, onCreated }: { projectId: string; open: boolean; lookups: Lookups; nodes: NodeRow[]; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [unitType, setUnitType] = useState("volumetric_module");
  const [serialNumber, setSerialNumber] = useState("");
  const [factoryNodeId, setFactoryNodeId] = useState("");
  const [scheduleTaskId, setScheduleTaskId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [plannedDeliveryDate, setPlannedDeliveryDate] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [transportKm, setTransportKm] = useState("");
  const [stages, setStages] = useState("Frame\nServices first fix*\nFinishes\nFinal inspection*");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const stageList = stages
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ name: s.replace(/\*$/, "").trim(), isQaGate: s.endsWith("*") }));
    const payload: Record<string, unknown> = { name: name.trim(), unitType, stages: stageList, currency: currency.trim().toUpperCase() || "USD" };
    if (serialNumber.trim()) payload["serialNumber"] = serialNumber.trim();
    if (factoryNodeId) payload["factoryNodeId"] = factoryNodeId;
    if (scheduleTaskId) payload["scheduleTaskId"] = scheduleTaskId;
    if (locationId) payload["locationId"] = locationId;
    if (plannedDeliveryDate) payload["plannedDeliveryDate"] = plannedDeliveryDate;
    if (value.trim()) payload["value"] = Number(value);
    if (transportKm.trim()) payload["transportKm"] = Number(transportKm);
    const r = await action.run("create", () => api.post<UnitRow>(`/api/v1/projects/${projectId}/supply-chain/offsite/units`, payload));
    if (r) {
      toast.success(`${r.reference} registered with ${stageList.length} stage(s)`);
      setName("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Register an offsite unit" description="One stage per line; end a line with * to make it a QA gate that a second person must verify." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Unit" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={unitType} onChange={(e) => setUnitType(e.target.value)}>
              {OFFSITE_UNIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Serial / DfMA id">
            <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
          </Field>
          <Field label="Factory (node)">
            <Select value={factoryNodeId} onChange={(e) => setFactoryNodeId(e.target.value)}>
              {optionList(nodes, (n) => `T${n.tier} ${n.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Install task">
            <Select value={scheduleTaskId} onChange={(e) => setScheduleTaskId(e.target.value)}>
              {optionList(lookups.tasks, (t) => `${t.name}${t.startDate ? ` (${t.startDate})` : ""}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Install location">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {optionList(lookups.locations, (l) => l.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Planned delivery">
            <Input type="date" value={plannedDeliveryDate} onChange={(e) => setPlannedDeliveryDate(e.target.value)} />
          </Field>
          <Field label="Value">
            <Input type="number" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
          </Field>
          <Field label="Transport to site (km)">
            <Input type="number" min={0} value={transportKm} onChange={(e) => setTransportKm(e.target.value)} />
          </Field>
        </div>
        <Field label="Production stages" hint="One per line. A trailing * marks a QA gate.">
          <Textarea rows={5} value={stages} onChange={(e) => setStages(e.target.value)} />
        </Field>
        <ReasonList reasons={lookups.notes} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Register unit
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function UnitDrawer({ projectId, unitId, detail, lookups, onClose, onChanged }: { projectId: string; unitId: string | null; detail: Loadable<UnitDetail>; lookups: Lookups; onClose: () => void; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain/offsite`;
  const action = useAction();
  const d = detail.data;
  const [qaNotes, setQaNotes] = useState("");
  const [transitionNote, setTransitionNote] = useState("");
  const [installLocation, setInstallLocation] = useState("");
  const [inspKind, setInspKind] = useState("factory_acceptance_test");
  const [inspTitle, setInspTitle] = useState("");
  const [inspDate, setInspDate] = useState(today());
  const [recResult, setRecResult] = useState("passed");
  const [recPercent, setRecPercent] = useState("");
  const [recFindings, setRecFindings] = useState("");
  const [vestingAt, setVestingAt] = useState("");
  const [insuredUntil, setInsuredUntil] = useState("");
  const [storageText, setStorageText] = useState("");

  async function stageAction(stage: StageRow, verb: "start" | "complete") {
    if (!d) return;
    const r = await action.run(`${verb}:${stage.id}`, () => api.post(`${base}/units/${d.id}/stages/${stage.id}/${verb}`, {}));
    if (r) {
      toast.success(`${stage.name}: ${verb === "start" ? "started" : "complete"}`);
      onChanged();
    }
  }

  async function qa(stage: StageRow, result: "passed" | "failed" | "waived") {
    if (!d) return;
    const r = await action.run(`qa:${stage.id}:${result}`, () => api.post(`${base}/units/${d.id}/stages/${stage.id}/qa`, { result, notes: qaNotes.trim() || null }));
    if (r) {
      toast.success(`QA gate ${result}`);
      setQaNotes("");
      onChanged();
    }
  }

  async function transition(status: string) {
    if (!d) return;
    const payload: Record<string, unknown> = { status };
    if (transitionNote.trim()) payload["note"] = transitionNote.trim();
    if (status === "installed" && installLocation) payload["locationId"] = installLocation;
    const r = await action.run(`t:${status}`, () => api.post(`${base}/units/${d.id}/transition`, payload));
    if (r) {
      toast.success(`${d.reference} → ${labelize(status).toLowerCase()}`);
      setTransitionNote("");
      onChanged();
    }
  }

  async function scheduleInspection(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    const r = await action.run("inspect", () => api.post(`${base}/inspections`, { unitId: d.id, kind: inspKind, title: inspTitle.trim() || `${labelize(inspKind)} — ${d.reference}`, scheduledFor: inspDate || null }));
    if (r) {
      toast.success("Inspection scheduled");
      setInspTitle("");
      onChanged();
    }
  }

  async function record(inspectionId: string) {
    const payload: Record<string, unknown> = { result: recResult };
    if (recPercent.trim()) payload["percentVerified"] = Number(recPercent);
    if (recFindings.trim()) payload["findings"] = recFindings.trim();
    const r = await action.run(`record:${inspectionId}`, () => api.post(`${base}/inspections/${inspectionId}/record`, payload));
    if (r) {
      toast.success("Inspection recorded");
      setRecPercent("");
      setRecFindings("");
      onChanged();
    }
  }

  async function saveVesting() {
    if (!d) return;
    const payload: Record<string, unknown> = {};
    if (vestingAt) payload["vestingCertifiedAt"] = vestingAt;
    if (insuredUntil) payload["storageInsuredUntil"] = insuredUntil;
    if (storageText.trim()) payload["storageLocationText"] = storageText.trim();
    const r = await action.run("vesting", () => api.post(`${base}/units/${d.id}/vesting`, payload));
    if (r) {
      toast.success("Vesting and storage recorded");
      onChanged();
    }
  }

  const scheduled = d?.inspections.filter((i) => i.result === "scheduled") ?? [];

  return (
    <Drawer
      open={unitId !== null}
      onClose={onClose}
      size="lg"
      title={d ? <span className="flex items-center gap-2"><span className="font-mono">{d.reference}</span><span className="truncate">{d.name}</span><Badge tone={UNIT_STATUS_TONE[d.status] ?? "neutral"} size="xs" dot>{labelize(d.status)}</Badge></span> : "Unit"}
      description={d ? `${labelize(d.unitType)}${d.serialNumber ? ` · ${d.serialNumber}` : ""}${d.factoryNode ? ` · ${d.factoryNode.name}` : ""}${d.task ? ` · installs on ${d.task.name}` : ""}` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !d ? (
        <div className="space-y-3">
          <Skeleton height={90} />
          <Skeleton height={200} />
        </div>
      ) : !d ? null : (
        <div className="space-y-5">
          {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

          <section className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-border p-3">
              <div className="text-2xs uppercase tracking-wide text-content-subtle">Stages complete (factory's claim)</div>
              <div className="text-display-xs font-semibold tabular-nums">{pct(d.rollup.percentComplete, 0)}</div>
              <Progress value={d.rollup.percentComplete} size="sm" tone={d.rollup.onQaHold ? "danger" : "accent" as never} />
              <div className="mt-1 text-2xs text-content-muted">{d.rollup.stagesComplete}/{d.rollup.stagesTotal} stages · QA {d.rollup.qaGatesPassed}/{d.rollup.qaGatesTotal}{d.rollup.qaGatesPending > 0 ? ` · ${d.rollup.qaGatesPending} awaiting verifier` : ""}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-2xs uppercase tracking-wide text-content-subtle">Verified for payment (independent)</div>
              <div className="text-display-xs font-semibold tabular-nums">
                <FigureCell value={d.verifiedForPayment.percent} reasons={d.verifiedForPayment.reasons} render={(v) => pct(v, 0)} />
              </div>
              <div className="mt-1 text-2xs text-content-muted">{d.verifiedForPaymentAt ? `by ${d.verifiedForPaymentBy} · ${dateTime(d.verifiedForPaymentAt)}` : `${d.verifiedForPayment.inspectionCount} inspection(s) on record`}</div>
            </div>
            <ReasonList reasons={d.rollup.reasons} className="col-span-2" />
          </section>

          <section>
            <SectionHeading title="Production stages" hint="Complete a stage as the factory reports it. A QA gate stays pending until someone else records the result; a failed gate holds the unit." />
            <ul className="divide-y divide-border">
              {d.stages.map((s) => (
                <li key={s.id} className="py-2 text-meta">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <Badge tone={s.status === "complete" ? "success" : s.status === "in_progress" ? "info" : s.status === "failed" ? "danger" : "neutral"} size="xs" dot>
                        {labelize(s.status)}
                      </Badge>
                      <span className="font-medium">{s.position + 1}. {s.name}</span>
                      {s.isQaGate === 1 ? (
                        <Badge tone={s.qaResult === "passed" || s.qaResult === "waived" ? "success" : s.qaResult === "failed" ? "danger" : "warning"} size="xs">
                          QA {s.qaResult}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1">
                      {s.status === "not_started" || s.status === "failed" ? (
                        <Button size="xs" variant="secondary" loading={action.busy === `start:${s.id}`} onClick={() => void stageAction(s, "start")}>
                          Start
                        </Button>
                      ) : null}
                      {s.status !== "complete" ? (
                        <Button size="xs" loading={action.busy === `complete:${s.id}`} onClick={() => void stageAction(s, "complete")}>
                          Complete
                        </Button>
                      ) : null}
                      {s.isQaGate === 1 && s.status === "complete" && s.qaResult === "pending" ? (
                        <>
                          <Button size="xs" variant="secondary" loading={action.busy === `qa:${s.id}:passed`} onClick={() => void qa(s, "passed")}>
                            Pass
                          </Button>
                          <Button size="xs" variant="secondary" loading={action.busy === `qa:${s.id}:failed`} onClick={() => void qa(s, "failed")}>
                            Fail
                          </Button>
                          <Button size="xs" variant="ghost" loading={action.busy === `qa:${s.id}:waived`} onClick={() => void qa(s, "waived")}>
                            Waive
                          </Button>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="text-2xs text-content-muted">
                    {s.actualStart ? `started ${isoDate(s.actualStart)}` : s.plannedStart ? `planned ${isoDate(s.plannedStart)}` : "not started"}
                    {s.actualEnd ? ` · complete ${isoDate(s.actualEnd)} by ${s.completedBy}` : ""}
                    {s.qaVerifiedBy ? ` · QA by ${s.qaVerifiedBy} ${dateTime(s.qaVerifiedAt)}` : ""}
                    {s.qaNotes ? ` · ${s.qaNotes}` : ""}
                  </div>
                </li>
              ))}
            </ul>
            {d.stages.some((s) => s.isQaGate === 1 && s.status === "complete" && s.qaResult === "pending") ? (
              <Field label="QA notes" hint="Required for a waiver; kept on the gate for pass or fail." className="mt-2">
                <Input value={qaNotes} onChange={(e) => setQaNotes(e.target.value)} />
              </Field>
            ) : null}
          </section>

          <section>
            <SectionHeading title="Lifecycle" hint={`Allowed next: ${d.allowedTransitions.length > 0 ? d.allowedTransitions.map(labelize).join(", ") : "none"}. Passed QA and ready to ship are refused until every stage is complete and every gate passed or waived.`} />
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Note" className="min-w-48 flex-1">
                <Input value={transitionNote} onChange={(e) => setTransitionNote(e.target.value)} placeholder="required for a rejection" />
              </Field>
              {d.allowedTransitions.includes("installed") && !d.locationId ? (
                <Field label="Install location">
                  <Select value={installLocation} onChange={(e) => setInstallLocation(e.target.value)}>
                    {optionList(lookups.locations, (l) => l.name).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {d.allowedTransitions.map((t) => (
                <Button key={t} size="sm" variant={t === "rejected" ? "ghost" : "secondary"} loading={action.busy === `t:${t}`} onClick={() => void transition(t)}>
                  {labelize(t)}
                </Button>
              ))}
            </div>
            <KeyValue
              items={[
                { label: "Production", value: `${isoDate(d.actualProductionStart ?? d.plannedProductionStart)} → ${isoDate(d.actualProductionEnd ?? d.plannedProductionEnd)}` },
                { label: "Delivery", value: d.actualDeliveryDate ? `${isoDate(d.actualDeliveryDate)} (actual)` : d.plannedDeliveryDate ? `${isoDate(d.plannedDeliveryDate)} (planned)` : EM_DASH },
                { label: "Installed", value: d.installedAt ? `${isoDate(d.installedAt)} at ${d.locationId ?? "?"}` : EM_DASH },
                { label: "Delivery slot", value: d.deliverySlotId ?? <span className="italic text-content-subtle">not booked</span> },
                { label: "Value", value: money(d.value, d.currency) },
                { label: "Transport", value: d.transportKm === null ? EM_DASH : `${d.transportKm} km` },
              ]}
            />
          </section>

          <section>
            <SectionHeading title="Factory inspections" hint="An inspector who completed a stage on this unit may not record its inspection. A passed or conditional inspection's verified percent is what a valuation may rely on." />
            {d.inspections.length === 0 ? <p className="text-meta italic text-content-muted">Nothing inspected yet.</p> : null}
            <ul className="divide-y divide-border">
              {d.inspections.map((i) => (
                <li key={i.id} className="py-2 text-meta">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <Badge tone={i.result === "passed" ? "success" : i.result === "conditional" ? "warning" : i.result === "failed" ? "danger" : "neutral"} size="xs" dot>
                        {labelize(i.result)}
                      </Badge>
                      <span className="font-medium">{i.title}</span>
                      <span className="text-2xs text-content-muted">{labelize(i.kind)}</span>
                    </span>
                    <span className="text-2xs text-content-muted">{i.performedAt ? `performed ${isoDate(i.performedAt)}` : `scheduled ${isoDate(i.scheduledFor)}`}{i.percentVerified !== null ? ` · ${pct(i.percentVerified, 0)} verified` : ""}</span>
                  </div>
                  {i.findings ? <div className="text-2xs text-content-muted">{i.findings}</div> : null}
                </li>
              ))}
            </ul>
            {scheduled.length > 0 ? (
              <div className="mt-2 grid grid-cols-2 gap-2 rounded-md border border-border p-3">
                <Field label="Result">
                  <Select value={recResult} onChange={(e) => setRecResult(e.target.value)}>
                    <option value="passed">Passed</option>
                    <option value="conditional">Conditional</option>
                    <option value="failed">Failed</option>
                  </Select>
                </Field>
                <Field label="Percent verified complete">
                  <Input type="number" min={0} max={100} value={recPercent} onChange={(e) => setRecPercent(e.target.value)} />
                </Field>
                <Field label="Findings" className="col-span-2">
                  <Textarea rows={2} value={recFindings} onChange={(e) => setRecFindings(e.target.value)} />
                </Field>
                <div className="col-span-2 flex flex-wrap justify-end gap-2">
                  {scheduled.map((i) => (
                    <Button key={i.id} size="sm" loading={action.busy === `record:${i.id}`} onClick={() => void record(i.id)}>
                      Record: {i.title}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            <form onSubmit={(e) => void scheduleInspection(e)} className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Kind">
                <Select size="sm" value={inspKind} onChange={(e) => setInspKind(e.target.value)}>
                  {FACTORY_INSPECTION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {labelize(k)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Title" className="min-w-40 flex-1">
                <Input size="sm" value={inspTitle} onChange={(e) => setInspTitle(e.target.value)} />
              </Field>
              <Field label="Date">
                <Input size="sm" type="date" value={inspDate} onChange={(e) => setInspDate(e.target.value)} />
              </Field>
              <Button type="submit" size="sm" variant="secondary" loading={action.busy === "inspect"}>
                Schedule
              </Button>
            </form>
          </section>

          <section>
            <SectionHeading title="Title, storage and insurance" hint="A vesting certificate transfers title to materials sitting in the factory; storage insurance and inspection are what protect the money paid for them (#925–926)." />
            <KeyValue
              items={[
                { label: "Vesting certified", value: isoDate(d.vestingCertifiedAt) },
                { label: "Title transferred", value: isoDate(d.titleTransferredAt) },
                { label: "Stored at", value: d.storageLocationText ?? EM_DASH },
                { label: "Insured until", value: d.storageInsuredUntil ? <span className={d.storageInsuredUntil < today() ? "text-danger-fg" : ""}>{isoDate(d.storageInsuredUntil)}</span> : <span className="italic text-content-subtle">not recorded</span> },
                { label: "Last storage inspection", value: isoDate(d.storageInspectedAt) },
              ]}
            />
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Vesting certified on">
                <Input size="sm" type="date" value={vestingAt} onChange={(e) => setVestingAt(e.target.value)} />
              </Field>
              <Field label="Insured until">
                <Input size="sm" type="date" value={insuredUntil} onChange={(e) => setInsuredUntil(e.target.value)} />
              </Field>
              <Field label="Stored at" className="min-w-40 flex-1">
                <Input size="sm" value={storageText} onChange={(e) => setStorageText(e.target.value)} />
              </Field>
              <Button size="sm" variant="secondary" loading={action.busy === "vesting"} onClick={() => void saveVesting()}>
                Save
              </Button>
            </div>
          </section>

          {d.traceRecords.length > 0 ? (
            <section>
              <SectionHeading title="Traced materials in this unit" />
              <ul className="divide-y divide-border">
                {d.traceRecords.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-1.5 text-meta">
                    <span><span className="font-mono">{t.reference}</span> {t.description}</span>
                    <Badge tone={t.chainComplete === 1 ? "success" : "warning"} size="xs">{t.chainComplete === 1 ? "chain complete" : "chain incomplete"}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
