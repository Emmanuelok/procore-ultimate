/**
 * LOGISTICS — gates, slots, arrivals (#930–939; Vol I #720–722, #730).
 * A booking is refused when the gate is closed, the bays are full, the crane
 * is committed or the vehicle will not make the approach — and the refusal
 * names the clash. Completing a delivery moves the long-lead item and the
 * offsite unit it carries, and books the transport carbon (#945).
 *
 * Times are on the site clock (UTC): 08:00 is booked as T08:00:00Z.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DELIVERY_ISSUE_KINDS, DELIVERY_SLOT_STATUSES, TRANSPORT_MODES, VEHICLE_TYPES } from "@constructos/shared";
import { Badge, Button, Card, CardBody, Checkbox, Drawer, EmptyState, Field, Input, Select, Skeleton, Textarea } from "../../ui";
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
  SLOT_STATUS_TONE,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  num,
  optionList,
  pct,
  shiftDays,
  siteTime,
  today,
  useAction,
  useResource,
  type AvailabilityResponse,
  type GateRow,
  type ListResponse,
  type Loadable,
  type LongLeadRow,
  type Lookups,
  type NodeRow,
  type OnTimeResponse,
  type SlotDetail,
  type SlotRow,
  type UnitRow,
} from "./supplychainShared";

export default function LogisticsTab({ projectId, lookups, onChanged }: { projectId: string; lookups: Lookups; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain`;
  const [from, setFrom] = useState(() => shiftDays(today(), -7));
  const [to, setTo] = useState(() => shiftDays(today(), 21));
  const [status, setStatus] = useState("");
  const gates = useResource<{ items: GateRow[]; total: number }>(`${base}/logistics/gates`);
  const slots = useResource<ListResponse<SlotRow>>(`${base}/logistics/slots?pageSize=500&from=${from}&to=${to}${status ? `&status=${status}` : ""}`);
  const onTime = useResource<OnTimeResponse>(`${base}/logistics/on-time?from=${from}&to=${to}`);
  const nodes = useResource<ListResponse<NodeRow>>(`${base}/nodes?pageSize=500`);
  const items = useResource<ListResponse<LongLeadRow>>(`${base}/long-lead?pageSize=500`);
  const units = useResource<ListResponse<UnitRow>>(`${base}/offsite/units?pageSize=500`);
  const [bookOpen, setBookOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<SlotDetail>(openId ? `${base}/logistics/slots/${openId}` : null);
  const action = useAction();

  function changed() {
    slots.reload();
    onTime.reload();
    detail.reload();
    gates.reload();
    onChanged();
  }

  async function sweep() {
    const r = await action.run("sweep", () => api.post<{ marked: number; raised: number }>(`${base}/logistics/no-show-sweep`, {}));
    if (r) {
      toast.success(`${r.marked} booking(s) marked as no-shows`);
      changed();
    }
  }

  const columns = useMemo<DataColumns<SlotRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 96, mono: true },
      { id: "startsAt", header: "Slot", accessor: "startsAt", type: "datetime", width: 190, cell: ({ row }) => <span className="tabular-nums">{isoDate(row.startsAt)} {siteTime(row.startsAt)}–{siteTime(row.endsAt)}</span> },
      { id: "gate", header: "Gate", accessor: (row) => row.gateName ?? row.gateId, type: "text", width: 130, groupable: true },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, groupable: true, cell: ({ row }) => <Badge tone={SLOT_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
      { id: "description", header: "Load", accessor: "description", type: "text", width: 240 },
      { id: "vehicleType", header: "Vehicle", accessor: "vehicleType", type: "enum", width: 120, cell: ({ row }) => <span>{labelize(row.vehicleType)}{row.craneRequired === 1 ? <Badge tone="info" size="xs" className="ml-1">crane</Badge> : null}</span> },
      { id: "haulierName", header: "Haulier", accessor: (row) => row.haulierName ?? "", type: "text", width: 140 },
      { id: "punctuality", header: "Arrival", accessor: (row) => row.lateMinutes, type: "number", width: 120, cell: ({ row }) => (row.wasOnTime === null ? <span className="italic text-content-subtle">{row.status === "no_show" ? "no-show" : EM_DASH}</span> : row.wasOnTime === 1 ? <span className="text-success-fg">on time</span> : <span className="text-danger-fg">{row.lateMinutes} min late</span>) },
      { id: "issueKind", header: "Issue", accessor: "issueKind", type: "enum", width: 110, cell: ({ row }) => (row.issueKind === "none" ? EM_DASH : <Badge tone="warning" size="xs">{labelize(row.issueKind)}</Badge>) },
      { id: "carbon", header: "kgCO₂e", accessor: (row) => row.carbonKgCo2e, type: "number", width: 100, cell: ({ row }) => (row.carbonKgCo2e === null ? <span className="italic text-content-subtle" title={row.carbonBasis ?? ""}>n/a</span> : <span title={row.carbonBasis ?? ""}>{num(row.carbonKgCo2e, 1)}</span>) },
    ],
    [],
  );

  const ot = onTime.data;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="On-time delivery" value={ot ? <FigureCell value={ot.overall.onTimePercent} reasons={ot.overall.reasons} render={(v) => pct(v)} /> : EM_DASH} hint={ot ? `${ot.overall.onTime} on time · ${ot.overall.late} late · ${ot.overall.noShow} no-show` : undefined} />
        <StatCard label="Average lateness" value={ot ? (ot.overall.averageLateMinutes === null ? <span className="italic text-content-subtle">n/a</span> : `${ot.overall.averageLateMinutes} min`) : EM_DASH} hint={ot ? `waiting ${ot.overall.averageWaitingMinutes === null ? "n/a" : `${ot.overall.averageWaitingMinutes} min`}` : undefined} />
        <StatCard label="Damage / shortage" value={ot ? num(Object.values(ot.issues).reduce((a, b) => a + b, 0)) : EM_DASH} hint={ot ? Object.entries(ot.issues).map(([k, v]) => `${labelize(k)} ${v}`).join(" · ") || "none recorded" : undefined} />
        <StatCard label="Transport carbon" value={ot ? <FigureCell value={ot.carbon.kgCo2e} reasons={ot.carbon.reasons} render={(v) => `${num(v)} kg`} /> : EM_DASH} hint={ot ? `${ot.carbon.deliveriesWithDistance} with distance · ${ot.carbon.deliveriesWithoutDistance} without` : undefined} />
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Delivery slots"
            hint={ot?.method ?? "Bookings against gate windows, bays and the crane."}
            actions={
              <>
                <Input size="sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
                <Input size="sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {DELIVERY_SLOT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="ghost" loading={action.busy === "sweep"} onClick={() => void sweep()}>
                  Sweep no-shows
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setGateOpen(true)}>
                  Gates ({gates.data?.total ?? 0})
                </Button>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setBookOpen(true)} disabled={(gates.data?.total ?? 0) === 0}>
                  Book a slot
                </Button>
              </>
            }
          />
          {slots.error ? <LoadError message={slots.error} onRetry={slots.reload} /> : null}
          {(gates.data?.total ?? 0) === 0 && !gates.loading ? <EmptyState size="sm" title="No site gates yet" hint="Define at least one gate — its window, bays and crane — before booking deliveries." action={<Button size="sm" onClick={() => setGateOpen(true)}>Add a gate</Button>} className="mb-3" /> : null}
          <DataTable<SlotRow>
            tableId="supply-chain-slots"
            data={slots.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={slots.loading && !slots.data}
            height={480}
            stickyHeader
            filterRow
            exportFileName="delivery-slots"
            searchPlaceholder="Search by reference, load, haulier or registration…"
            defaultSort={[{ id: "startsAt", desc: false }]}
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.status === "no_show" ? "danger" : row.issueKind !== "none" ? "warning" : undefined)}
            empty={{ title: "No deliveries in this window", description: "Book the deliveries the programme needs; each one is tested against the task it feeds." }}
          />
        </CardBody>
      </Card>

      {ot && ot.bySupplier.length > 0 ? (
        <Card>
          <CardBody>
            <SectionHeading title="Supplier performance" hint="On-time delivery by supplier node and by haulier over the window (#730)." />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <PerfList title="By supplier" rows={ot.bySupplier.map((r) => ({ key: r.key, label: r.name, ...r }))} />
              <PerfList title="By haulier" rows={ot.byHaulier.map((r) => ({ key: r.key, label: r.key, ...r }))} />
            </div>
          </CardBody>
        </Card>
      ) : null}

      <GatesDrawer projectId={projectId} open={gateOpen} gates={gates} onClose={() => setGateOpen(false)} onChanged={changed} />
      <BookingDrawer projectId={projectId} open={bookOpen} gates={gates.data?.items ?? []} lookups={lookups} nodes={nodes.data?.items ?? []} items={items.data?.items ?? []} units={units.data?.items ?? []} onClose={() => setBookOpen(false)} onBooked={() => { setBookOpen(false); changed(); }} />
      <SlotDrawer projectId={projectId} slotId={openId} detail={detail} onClose={() => setOpenId(null)} onChanged={changed} />
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card>
      <CardBody>
        <div className="text-label uppercase text-content-subtle">{label}</div>
        <div className="text-display-xs font-semibold tabular-nums text-content">{value}</div>
        {hint ? <div className="text-2xs text-content-muted">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

function PerfList({ title, rows }: { title: string; rows: Array<{ key: string; label: string; completed: number; onTime: number; late: number; noShow: number; onTimePercent: number | null }> }) {
  return (
    <div>
      <div className="mb-1 text-2xs uppercase tracking-wide text-content-subtle">{title}</div>
      {rows.length === 0 ? <p className="text-meta italic text-content-muted">Nothing attributed.</p> : null}
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-2 py-1.5 text-meta">
            <span className="truncate">{r.label}</span>
            <span className="tabular-nums text-content-muted">
              {r.onTimePercent === null ? <span className="italic">not assessed</span> : <span className={r.onTimePercent < 80 ? "text-danger-fg" : "text-success-fg"}>{pct(r.onTimePercent, 0)}</span>} · {r.completed} done · {r.noShow} no-show
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GatesDrawer({ projectId, open, gates, onClose, onChanged }: { projectId: string; open: boolean; gates: Loadable<{ items: GateRow[]; total: number }>; onClose: () => void; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain/logistics/gates`;
  const action = useAction();
  const [name, setName] = useState("");
  const [opensAt, setOpensAt] = useState("07:00");
  const [closesAt, setClosesAt] = useState("18:00");
  const [bays, setBays] = useState("1");
  const [slotMinutes, setSlotMinutes] = useState("30");
  const [maxVehicle, setMaxVehicle] = useState("");
  const [crane, setCrane] = useState(false);
  const [laydown, setLaydown] = useState("");

  async function create(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { name: name.trim(), opensAt, closesAt, concurrentSlots: Number(bays) || 1, slotMinutes: Number(slotMinutes) || 30, craneAvailable: crane, laydownAreas: laydown.split(",").map((s) => s.trim()).filter(Boolean) };
    if (maxVehicle) payload["maxVehicleType"] = maxVehicle;
    const r = await action.run("gate", () => api.post<GateRow>(base, payload));
    if (r) {
      toast.success(`Gate ${r.name} added`);
      setName("");
      onChanged();
    }
  }

  async function toggle(g: GateRow) {
    const r = await action.run(`toggle:${g.id}`, () => api.patch(`${base}/${g.id}`, { status: g.status === "open" ? "closed" : "open" }));
    if (r) onChanged();
  }

  return (
    <Drawer open={open} onClose={onClose} title="Site gates" description="A gate's window, bays, crane and vehicle limit are what every booking is tested against." size="md">
      <div className="space-y-4">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        {gates.error ? <LoadError message={gates.error} onRetry={gates.reload} /> : null}
        <ul className="divide-y divide-border">
          {(gates.data?.items ?? []).map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-2 py-2 text-meta">
              <span>
                <span className="font-medium">{g.name}</span>{g.code ? ` (${g.code})` : ""} · {g.opensAt}–{g.closesAt} · {g.concurrentSlots} bay{g.concurrentSlots === 1 ? "" : "s"} · {g.slotMinutes} min{g.craneAvailable === 1 ? " · crane" : ""}{g.maxVehicleType ? ` · up to ${labelize(g.maxVehicleType)}` : ""}
                {g.laydownAreas.length > 0 ? <span className="text-content-muted"> · laydown {g.laydownAreas.join(", ")}</span> : null}
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={g.status === "open" ? "success" : "neutral"} size="xs" dot>{g.status}</Badge>
                <Button size="xs" variant="ghost" loading={action.busy === `toggle:${g.id}`} onClick={() => void toggle(g)}>{g.status === "open" ? "Close" : "Open"}</Button>
              </span>
            </li>
          ))}
        </ul>
        <form onSubmit={(e) => void create(e)} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3">
          <Field label="Name" required className="col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Opens (site clock)">
            <Input type="time" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          </Field>
          <Field label="Closes">
            <Input type="time" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
          </Field>
          <Field label="Bays">
            <Input type="number" min={1} max={20} value={bays} onChange={(e) => setBays(e.target.value)} />
          </Field>
          <Field label="Slot length (min)">
            <Input type="number" min={5} max={480} value={slotMinutes} onChange={(e) => setSlotMinutes(e.target.value)} />
          </Field>
          <Field label="Largest vehicle">
            <Select value={maxVehicle} onChange={(e) => setMaxVehicle(e.target.value)}>
              <option value="">no limit</option>
              {VEHICLE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {labelize(v)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Laydown areas" hint="comma-separated">
            <Input value={laydown} onChange={(e) => setLaydown(e.target.value)} placeholder="A, B" />
          </Field>
          <div className="col-span-2 flex items-center justify-between">
            <Checkbox label="Crane / hoist allocation at this gate" checked={crane} onChange={(e) => setCrane(e.target.checked)} />
            <Button type="submit" size="sm" loading={action.busy === "gate"}>Add gate</Button>
          </div>
        </form>
      </div>
    </Drawer>
  );
}

function BookingDrawer({ projectId, open, gates, lookups, nodes, items, units, onClose, onBooked }: { projectId: string; open: boolean; gates: GateRow[]; lookups: Lookups; nodes: NodeRow[]; items: LongLeadRow[]; units: UnitRow[]; onClose: () => void; onBooked: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain/logistics`;
  const action = useAction();
  const [gateId, setGateId] = useState("");
  const [date, setDate] = useState(() => shiftDays(today(), 1));
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("08:30");
  const [description, setDescription] = useState("");
  const [vehicleType, setVehicleType] = useState("rigid_18t");
  const [crane, setCrane] = useState(false);
  const [laydownArea, setLaydownArea] = useState("");
  const [haulier, setHaulier] = useState("");
  const [supplierNodeId, setSupplierNodeId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [longLeadItemId, setLongLeadItemId] = useState("");
  const [offsiteUnitId, setOffsiteUnitId] = useState("");
  const [scheduleTaskId, setScheduleTaskId] = useState("");
  const [transportMode, setTransportMode] = useState("road");
  const [transportKm, setTransportKm] = useState("");
  const [loadTonnes, setLoadTonnes] = useState("");
  const effectiveGate = gateId || gates[0]?.id || "";
  const availability = useResource<AvailabilityResponse>(open && effectiveGate ? `${base}/gates/${effectiveGate}/availability?date=${date}` : null);
  const gate = gates.find((g) => g.id === effectiveGate);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      gateId: effectiveGate,
      startsAt: `${date}T${start}:00.000Z`,
      endsAt: `${date}T${end}:00.000Z`,
      description: description.trim(),
      vehicleType,
      craneRequired: crane,
      transportMode,
    };
    if (laydownArea) payload["laydownArea"] = laydownArea;
    if (haulier.trim()) payload["haulierName"] = haulier.trim();
    if (supplierNodeId) payload["supplierNodeId"] = supplierNodeId;
    if (vendorId) payload["vendorId"] = vendorId;
    if (longLeadItemId) payload["longLeadItemId"] = longLeadItemId;
    if (offsiteUnitId) payload["offsiteUnitId"] = offsiteUnitId;
    if (scheduleTaskId) payload["scheduleTaskId"] = scheduleTaskId;
    if (transportKm.trim()) payload["transportKm"] = Number(transportKm);
    if (loadTonnes.trim()) payload["loadTonnes"] = Number(loadTonnes);
    const r = await action.run("book", () => api.post<SlotRow>(`${base}/slots`, payload));
    if (r) {
      toast.success(`${r.reference} booked`);
      setDescription("");
      onBooked();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Book a delivery slot" description="Times are on the site clock. The gate's free windows for the chosen day are shown below; a clash is refused and named." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Gate" required>
            <Select value={effectiveGate} onChange={(e) => setGateId(e.target.value)}>
              {gates.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.opensAt}–{g.closesAt})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="From">
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
          </Field>
          <Field label="To">
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </Field>
        </div>
        <div className="rounded-md border border-border p-2 text-2xs">
          <div className="mb-1 uppercase tracking-wide text-content-subtle">Free windows on {isoDate(date)}</div>
          {availability.error ? (
            <span className="text-danger-fg">{availability.error}</span>
          ) : availability.loading && !availability.data ? (
            <Skeleton height={24} />
          ) : availability.data && availability.data.windows.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {availability.data.windows.map((w) => (
                <button key={w.startsAt} type="button" className="rounded border border-border px-1.5 py-0.5 hover:bg-surface-hover" onClick={() => { setStart(siteTime(w.startsAt)); setEnd(siteTime(w.endsAt)); }}>
                  {siteTime(w.startsAt)}–{siteTime(w.endsAt)} · {w.freeBays} bay{w.freeBays === 1 ? "" : "s"}{w.craneFree ? " · crane free" : ""}
                </button>
              ))}
            </div>
          ) : (
            <span className="italic text-content-muted">{gate?.status === "closed" ? "The gate is closed." : "No free window that day."}</span>
          )}
        </div>
        <Field label="Load" required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={500} placeholder="Steel beams L3 — 12 lengths" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vehicle">
            <Select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
              {VEHICLE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {labelize(v)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Laydown area">
            {gate && gate.laydownAreas.length > 0 ? (
              <Select value={laydownArea} onChange={(e) => setLaydownArea(e.target.value)}>
                <option value="">—</option>
                {gate.laydownAreas.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={laydownArea} onChange={(e) => setLaydownArea(e.target.value)} />
            )}
          </Field>
          <Field label="Haulier">
            <Input value={haulier} onChange={(e) => setHaulier(e.target.value)} />
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
          <Field label="Feeds task" hint="tested for JIT conflicts">
            <Select value={scheduleTaskId} onChange={(e) => setScheduleTaskId(e.target.value)}>
              {optionList(lookups.tasks, (t) => `${t.name}${t.startDate ? ` (${t.startDate})` : ""}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Long-lead item" hint="stamped arrived on completion">
            <Select value={longLeadItemId} onChange={(e) => setLongLeadItemId(e.target.value)}>
              {optionList(items.filter((i) => !["installed", "cancelled", "arrived"].includes(i.status)), (i) => `${i.reference} ${i.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Offsite unit" hint="marked delivered on completion">
            <Select value={offsiteUnitId} onChange={(e) => setOffsiteUnitId(e.target.value)}>
              {optionList(units.filter((u) => !["delivered", "installed", "rejected"].includes(u.status)), (u) => `${u.reference} ${u.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Transport mode">
            <Select value={transportMode} onChange={(e) => setTransportMode(e.target.value)}>
              {TRANSPORT_MODES.map((m) => (
                <option key={m} value={m}>
                  {labelize(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Distance (km)" hint="needed for the carbon figure">
            <Input type="number" min={0} value={transportKm} onChange={(e) => setTransportKm(e.target.value)} />
          </Field>
          <Field label="Load (tonnes)" hint="needed for rail / sea / air">
            <Input type="number" min={0} step="0.1" value={loadTonnes} onChange={(e) => setLoadTonnes(e.target.value)} />
          </Field>
        </div>
        <Checkbox label="Crane / hoist required" checked={crane} onChange={(e) => setCrane(e.target.checked)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={action.busy === "book"} disabled={!effectiveGate}>Book</Button>
        </div>
      </form>
    </Drawer>
  );
}

function SlotDrawer({ projectId, slotId, detail, onClose, onChanged }: { projectId: string; slotId: string | null; detail: Loadable<SlotDetail>; onClose: () => void; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain/logistics/slots`;
  const action = useAction();
  const d = detail.data;
  const [issueKind, setIssueKind] = useState("none");
  const [issueNotes, setIssueNotes] = useState("");
  const [km, setKm] = useState("");
  const [tonnes, setTonnes] = useState("");
  const [reason, setReason] = useState("");

  async function step(verb: "confirm" | "arrive" | "unloading" | "no-show") {
    if (!d) return;
    const r = await action.run(verb, () => api.post(`${base}/${d.id}/${verb}`, {}));
    if (r) {
      toast.success(`${d.reference}: ${labelize(verb).toLowerCase()}`);
      onChanged();
    }
  }

  async function complete() {
    if (!d) return;
    const payload: Record<string, unknown> = { issueKind };
    if (issueNotes.trim()) payload["issueNotes"] = issueNotes.trim();
    if (km.trim()) payload["transportKm"] = Number(km);
    if (tonnes.trim()) payload["loadTonnes"] = Number(tonnes);
    const r = await action.run("complete", () => api.post<SlotDetail & { effects: Record<string, { reference: string; to: string }> }>(`${base}/${d.id}/complete`, payload));
    if (r) {
      const effects = Object.values(r.effects ?? {}).map((e) => `${e.reference} → ${labelize(e.to).toLowerCase()}`);
      toast.success(`${d.reference} completed${effects.length > 0 ? ` · ${effects.join(", ")}` : ""}`);
      onChanged();
    }
  }

  async function cancel() {
    if (!d || !reason.trim()) return;
    const r = await action.run("cancel", () => api.post(`${base}/${d.id}/cancel`, { reason: reason.trim() }));
    if (r) {
      toast.success("Booking cancelled");
      onChanged();
    }
  }

  async function saveDistance() {
    if (!d) return;
    const payload: Record<string, unknown> = {};
    if (km.trim()) payload["transportKm"] = Number(km);
    if (tonnes.trim()) payload["loadTonnes"] = Number(tonnes);
    const r = await action.run("distance", () => api.patch(`${base}/${d.id}`, payload));
    if (r) {
      toast.success("Distance updated; carbon recomputed");
      onChanged();
    }
  }

  return (
    <Drawer
      open={slotId !== null}
      onClose={onClose}
      size="lg"
      title={d ? <span className="flex items-center gap-2"><span className="font-mono">{d.reference}</span><span className="truncate">{d.description}</span><Badge tone={SLOT_STATUS_TONE[d.status] ?? "neutral"} size="xs" dot>{labelize(d.status)}</Badge></span> : "Delivery"}
      description={d ? `${d.gateName ?? d.gateId} · ${isoDate(d.startsAt)} ${siteTime(d.startsAt)}–${siteTime(d.endsAt)} (site clock) · ${labelize(d.vehicleType)}${d.craneRequired === 1 ? " · crane" : ""}` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !d ? (
        <div className="space-y-3">
          <Skeleton height={80} />
          <Skeleton height={160} />
        </div>
      ) : !d ? null : (
        <div className="space-y-5">
          {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

          <section>
            <SectionHeading title="Lifecycle" hint="Requested → confirmed → arrived → unloading → completed. On time = arrived within 15 minutes of the booked start." />
            <div className="flex flex-wrap gap-2">
              {d.status === "requested" ? <Button size="sm" variant="secondary" loading={action.busy === "confirm"} onClick={() => void step("confirm")}>Confirm</Button> : null}
              {["requested", "confirmed", "no_show"].includes(d.status) ? <Button size="sm" loading={action.busy === "arrive"} onClick={() => void step("arrive")}>Arrived now</Button> : null}
              {d.status === "arrived" ? <Button size="sm" variant="secondary" loading={action.busy === "unloading"} onClick={() => void step("unloading")}>Unloading started</Button> : null}
              {["requested", "confirmed"].includes(d.status) ? <Button size="sm" variant="ghost" loading={action.busy === "no-show"} onClick={() => void step("no-show")}>Mark no-show</Button> : null}
            </div>
            <KeyValue
              items={[
                { label: "Arrived", value: d.arrivedAt ? `${dateTime(d.arrivedAt)} · ${d.wasOnTime === 1 ? "on time" : `${d.lateMinutes} min late`}` : EM_DASH },
                { label: "Unloading from", value: d.unloadingStartedAt ? `${dateTime(d.unloadingStartedAt)}${d.waitingMinutes !== null ? ` · waited ${d.waitingMinutes} min` : ""}` : EM_DASH },
                { label: "Completed", value: dateTime(d.completedAt) },
                { label: "Issue", value: d.issueKind === "none" ? "none" : `${labelize(d.issueKind)}${d.issueNotes ? ` — ${d.issueNotes}` : ""}` },
                { label: "Long-lead item", value: d.longLeadItem ? `${d.longLeadItem.reference} ${d.longLeadItem.name} (${labelize(d.longLeadItem.status)})` : EM_DASH },
                { label: "Offsite unit", value: d.offsiteUnit ? `${d.offsiteUnit.reference} ${d.offsiteUnit.name} (${labelize(d.offsiteUnit.status)})` : EM_DASH },
                { label: "Supplier", value: d.supplierNode?.name ?? d.vendorId ?? EM_DASH },
                { label: "Haulier / driver", value: [d.haulierName, d.driverName, d.vehicleRegistration].filter(Boolean).join(" · ") || EM_DASH },
              ]}
            />
          </section>

          {d.status === "arrived" || d.status === "unloading" ? (
            <section className="rounded-md border border-border p-3">
              <SectionHeading title="Complete the delivery" hint="Record damage, shortage or documentation problems here — the register is what the supplier claim is built on (#939, #940)." className="mb-2" />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Issue">
                  <Select value={issueKind} onChange={(e) => setIssueKind(e.target.value)}>
                    {DELIVERY_ISSUE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {labelize(k)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Distance (km)" hint="for the carbon entry">
                  <Input type="number" min={0} value={km} onChange={(e) => setKm(e.target.value)} placeholder={d.transportKm === null ? "" : String(d.transportKm)} />
                </Field>
                <Field label="Issue notes" className="col-span-2">
                  <Textarea rows={2} value={issueNotes} onChange={(e) => setIssueNotes(e.target.value)} />
                </Field>
                <Field label="Load (tonnes)">
                  <Input type="number" min={0} step="0.1" value={tonnes} onChange={(e) => setTonnes(e.target.value)} />
                </Field>
                <div className="flex items-end justify-end">
                  <Button size="sm" loading={action.busy === "complete"} onClick={() => void complete()}>Complete</Button>
                </div>
              </div>
            </section>
          ) : null}

          <section>
            <SectionHeading title="Transport carbon (ESG module A4)" hint="Generic per-km factors by vehicle type, per-tonne-km by mode. Written to the project carbon register on completion; never a substitute for a measured figure." />
            <div className="text-display-xs font-semibold tabular-nums">
              <FigureCell value={d.carbonKgCo2e} reasons={d.carbonEstimate.reasons.length > 0 ? d.carbonEstimate.reasons : [d.carbonBasis ?? ""]} render={(v) => `${num(v, 1)} kgCO₂e`} reasonsBelow />
            </div>
            <p className="text-2xs text-content-muted">{d.carbonBasis ?? d.carbonEstimate.basis}{d.carbonEntryId ? ` · carbon entry ${d.carbonEntryId}` : ""}</p>
            {d.status === "completed" ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="Distance (km)">
                  <Input size="sm" type="number" min={0} value={km} onChange={(e) => setKm(e.target.value)} />
                </Field>
                <Field label="Load (tonnes)">
                  <Input size="sm" type="number" min={0} step="0.1" value={tonnes} onChange={(e) => setTonnes(e.target.value)} />
                </Field>
                <Button size="sm" variant="secondary" loading={action.busy === "distance"} onClick={() => void saveDistance()}>Update</Button>
              </div>
            ) : null}
          </section>

          {["requested", "confirmed", "no_show"].includes(d.status) ? (
            <section className="rounded-md border border-danger-border p-3">
              <div className="flex items-end gap-2">
                <Field label="Cancel with reason" className="flex-1">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Button size="sm" variant="secondary" disabled={!reason.trim()} loading={action.busy === "cancel"} onClick={() => void cancel()}>Cancel booking</Button>
              </div>
            </section>
          ) : null}
          <ReasonList reasons={[]} />
        </div>
      )}
    </Drawer>
  );
}
