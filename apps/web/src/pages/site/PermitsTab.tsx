/**
 * PERMITS TO WORK, EXCLUSION ZONES AND LONE WORKING (#1070–1073).
 *
 * The permit drawer shows the transitions the engine will and will not allow,
 * with the reason attached to each — so a supervisor sees WHY a permit cannot
 * go active before they try.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardBody, Drawer, Field, Input, Select, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  ENTRY_STATUS_TONE,
  KeyValue,
  LONE_WORKER_TONE,
  LoadError,
  PERMIT_STATUS_TONE,
  ReasonList,
  RefusalNotice,
  SEVERITY_TONE,
  SectionHeading,
  ZONE_STATUS_TONE,
  dateTime,
  labelize,
  minutesLabel,
  num,
  optionList,
  relativeToNow,
  useAction,
  useResource,
  type ListResponse,
  type LoneWorkerList,
  type LoneWorkerRow,
  type PermitDetail,
  type PermitRow,
  type SiteLookups,
  type ZoneRow,
} from "./siteShared";

const PERMIT_TYPES = [
  "hot_work",
  "confined_space",
  "working_at_height",
  "excavation",
  "electrical_isolation",
  "lifting_operation",
  "live_services",
  "road_closure",
  "night_work",
  "demolition",
  "diving",
  "radiography",
  "other",
];

const ZONE_KINDS = ["lifting", "hot_work", "confined_space", "excavation", "blasting", "hazardous_material", "traffic", "drone", "overhead_line", "other"];

type Panel = "permits" | "zones" | "lone";

export default function PermitsTab({ projectId, lookups, onChanged }: { projectId: string; lookups: SiteLookups; onChanged: () => void }) {
  const [panel, setPanel] = useState<Panel>("permits");
  const base = `/api/v1/projects/${projectId}/site`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { value: "permits", label: "Permits to work" },
            { value: "zones", label: "Exclusion zones" },
            { value: "lone", label: "Lone working" },
          ] as Array<{ value: Panel; label: string }>
        ).map((p) => (
          <Button key={p.value} size="xs" variant={panel === p.value ? "secondary" : "ghost"} onClick={() => setPanel(p.value)}>
            {p.label}
          </Button>
        ))}
      </div>
      {panel === "permits" ? <PermitsPanel base={base} lookups={lookups} onChanged={onChanged} /> : null}
      {panel === "zones" ? <ZonesPanel base={base} onChanged={onChanged} /> : null}
      {panel === "lone" ? <LoneWorkerPanel base={base} lookups={lookups} onChanged={onChanged} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Permits                                                             */
/* ------------------------------------------------------------------ */

function PermitsPanel({ base, lookups, onChanged }: { base: string; lookups: SiteLookups; onChanged: () => void }) {
  const list = useResource<ListResponse<PermitRow>>(`${base}/permits?pageSize=200`);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const detail = useResource<PermitDetail>(openId ? `${base}/permits/${openId}` : null);

  const columns = useMemo<DataColumns<PermitRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "permitType", header: "Type", accessor: "permitType", type: "status", width: 170, groupable: true, cell: ({ row }) => labelize(row.permitType) },
      { id: "title", header: "Work", accessor: "title", type: "text", width: 300 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={PERMIT_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      { id: "validFrom", header: "Valid from", accessor: (row) => row.validFrom ?? "", type: "datetime", width: 165, cell: ({ row }) => dateTime(row.validFrom) },
      {
        id: "validTo",
        header: "Valid to",
        accessor: (row) => row.validTo ?? "",
        type: "datetime",
        width: 190,
        cell: ({ row }) =>
          row.validTo ? (
            <span className="tabular-nums">
              {dateTime(row.validTo)} <span className="text-2xs text-content-muted">({relativeToNow(row.validTo)})</span>
            </span>
          ) : (
            <span className="italic text-content-subtle">no window</span>
          ),
      },
      { id: "supervisorName", header: "Supervisor", accessor: (row) => row.supervisorName ?? "", type: "text", width: 170 },
      {
        id: "precautions",
        header: "Precautions",
        accessor: (row) => row.precautions.filter((p) => p.required && !p.done).length,
        type: "number",
        width: 130,
        cell: ({ row }) => {
          const outstanding = row.precautions.filter((p) => p.required && !p.done).length;
          return outstanding === 0 ? (
            <Badge tone="success" size="xs">
              all ticked
            </Badge>
          ) : (
            <Badge tone="warning" size="xs">
              {outstanding} outstanding
            </Badge>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <Card>
        <CardBody>
          <SectionHeading
            title="Permits to work"
            hint="A permit is approved by someone other than the person who asked for it, activated only when every required precaution is ticked, and closed only when the space is empty."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
                Raise a permit
              </Button>
            }
          />
          {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
          <DataTable
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={list.loading && !list.data}
            height={480}
            stickyHeader
            filterRow
            exportFileName="permits-to-work"
            searchPlaceholder="Search by reference or work…"
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.status === "expired" ? "danger" : row.status === "active" ? "success" : undefined)}
            empty={{
              title: "No permits",
              description: "Hot work, confined space, excavation and lifting all start here. A permit raised on the platform is a permit the sweeps can watch.",
              action: (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Raise the first permit
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <PermitForm
        base={base}
        lookups={lookups}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          list.reload();
          onChanged();
        }}
      />
      <PermitDrawer
        base={base}
        permitId={openId}
        detail={detail}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          detail.reload();
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function PermitForm({
  base,
  lookups,
  open,
  onClose,
  onCreated,
}: {
  base: string;
  lookups: SiteLookups;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [permitType, setPermitType] = useState("hot_work");
  const [title, setTitle] = useState("");
  const [locationDescription, setLocationDescription] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [supervisorName, setSupervisorName] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [precautions, setPrecautions] = useState("Extinguisher present\nCombustibles removed\nSignage in place*");
  const [maxOccupancy, setMaxOccupancy] = useState("");
  const [fireWatchMinutes, setFireWatchMinutes] = useState("60");
  const [description, setDescription] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const list = precautions
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ item: p.replace(/\*$/, "").trim(), required: !p.endsWith("*"), done: false }));
    const payload: Record<string, unknown> = { permitType, title: title.trim(), precautions: list };
    if (description.trim()) payload["description"] = description.trim();
    if (locationDescription.trim()) payload["locationDescription"] = locationDescription.trim();
    if (vendorId) payload["vendorId"] = vendorId;
    if (supervisorName.trim()) payload["supervisorName"] = supervisorName.trim();
    if (validFrom) payload["validFrom"] = new Date(validFrom).toISOString();
    if (validTo) payload["validTo"] = new Date(validTo).toISOString();
    if (maxOccupancy.trim()) payload["maxOccupancy"] = Number(maxOccupancy);
    if (permitType === "hot_work" && fireWatchMinutes.trim()) payload["fireWatchMinutes"] = Number(fireWatchMinutes);
    const r = await action.run("create", () => api.post<PermitRow>(`${base}/permits`, payload));
    if (r) {
      toast.success(`${r.reference} raised in draft`);
      setTitle("");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Raise a permit to work"
      description="One precaution per line; end a line with * to make it advisory rather than required. Required precautions must be ticked before the permit goes active."
      size="md"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Permit type" required>
            <Select value={permitType} onChange={(e) => setPermitType(e.target.value)}>
              {PERMIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contractor">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Work" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />
        </Field>
        <Field label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Where">
            <Input value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)} maxLength={300} />
          </Field>
          <Field label="Supervisor">
            <Input value={supervisorName} onChange={(e) => setSupervisorName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Valid from">
            <Input type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <Field label="Valid to">
            <Input type="datetime-local" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
          </Field>
          {permitType === "confined_space" ? (
            <Field label="Maximum inside at once">
              <Input type="number" min={1} value={maxOccupancy} onChange={(e) => setMaxOccupancy(e.target.value)} />
            </Field>
          ) : null}
          {permitType === "hot_work" ? (
            <Field label="Fire watch (minutes)" hint="The permit cannot be closed until this is recorded as done.">
              <Input type="number" min={0} value={fireWatchMinutes} onChange={(e) => setFireWatchMinutes(e.target.value)} />
            </Field>
          ) : null}
        </div>
        <Field label="Precautions">
          <Textarea rows={5} value={precautions} onChange={(e) => setPrecautions(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Raise
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function PermitDrawer({
  base,
  permitId,
  detail,
  onClose,
  onChanged,
}: {
  base: string;
  permitId: string | null;
  detail: ReturnType<typeof useResource<PermitDetail>>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [entryName, setEntryName] = useState("");
  const [entryMinutes, setEntryMinutes] = useState("30");
  // What the issuer has ticked in this drawer, keyed by precaution. Nothing is
  // ticked on their behalf: the whole point of the control is that a person
  // confirms each precaution is actually in place before the permit goes live.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const p = detail.data;

  useEffect(() => {
    setTicked({});
  }, [permitId]);

  async function transition(kind: string) {
    const needsReason = kind === "reject" || kind === "suspend";
    const reason = needsReason ? window.prompt(`Why is this permit being ${kind === "reject" ? "rejected" : "suspended"}?`) : undefined;
    if (needsReason && !reason) return;
    const body: Record<string, unknown> = reason ? { reason } : {};
    if (kind === "activate" && p) body["precautions"] = p.precautions.map((x) => ({ ...x, done: ticked[x.item] ?? x.done }));
    const r = await action.run(kind, () => api.post<PermitRow>(`${base}/permits/${permitId}/${kind}`, body));
    if (r) {
      toast.success(`${r.reference} is now ${labelize(r.status).toLowerCase()}`);
      onChanged();
    }
  }

  async function fireWatch() {
    const r = await action.run("fire-watch", () => api.post<PermitRow>(`${base}/permits/${permitId}/fire-watch`, {}));
    if (r) {
      toast.success("Fire watch recorded");
      onChanged();
    }
  }

  async function addEntry(e: FormEvent) {
    e.preventDefault();
    const r = await action.run("entry", () =>
      api.post<unknown>(`${base}/permits/${permitId}/entries`, {
        personName: entryName.trim(),
        expectedDurationMinutes: Number(entryMinutes) || 30,
      }),
    );
    if (r) {
      setEntryName("");
      toast.success("Entry recorded");
      onChanged();
    }
  }

  async function exitEntry(entryId: string) {
    const r = await action.run("exit", () => api.post<unknown>(`${base}/permits/${permitId}/entries/${entryId}/exit`, {}));
    if (r) {
      toast.success("Exit recorded");
      onChanged();
    }
  }

  const refusedTransitions = (p?.transitions ?? []).filter((t) => !t.allowed);

  return (
    <Drawer
      open={permitId !== null}
      onClose={onClose}
      title={p ? `${p.reference} — ${p.title}` : "Permit"}
      description={p ? `${labelize(p.permitType)} · ${labelize(p.status)}` : undefined}
      size="lg"
    >
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {p ? (
        <div className="space-y-4">
          <KeyValue
            items={[
              { label: "Status", value: <Badge tone={PERMIT_STATUS_TONE[p.status] ?? "neutral"} size="xs" dot>{labelize(p.status)}</Badge> },
              { label: "Valid", value: `${dateTime(p.validFrom)} → ${dateTime(p.validTo)}` },
              { label: "Where", value: p.locationDescription ?? EM_DASH },
              { label: "Supervisor", value: p.supervisorName ?? EM_DASH },
              { label: "Approved", value: p.approvedAt ? dateTime(p.approvedAt) : "not approved" },
              { label: "People inside", value: num(p.openEntries) },
              { label: "Fire watch", value: p.fireWatchMinutes ? (p.fireWatchCompletedAt ? `done ${dateTime(p.fireWatchCompletedAt)}` : `${p.fireWatchMinutes} min outstanding`) : "not required" },
              { label: "Utility survey", value: p.utilityScanId ?? "none linked" },
            ]}
          />

          <div className="flex flex-wrap gap-2">
            {(p.transitions ?? [])
              .filter((t) => t.allowed)
              .map((t) => (
                <Button
                  key={t.action}
                  size="sm"
                  variant={t.action === "close" || t.action === "cancel" ? "ghost" : "secondary"}
                  loading={action.busy === t.action}
                  onClick={() => void transition(t.action)}
                >
                  {labelize(t.action)}
                </Button>
              ))}
            {p.permitType === "hot_work" && p.fireWatchMinutes && !p.fireWatchCompletedAt ? (
              <Button size="sm" variant="secondary" loading={action.busy === "fire-watch"} onClick={() => void fireWatch()}>
                Record the fire watch
              </Button>
            ) : null}
          </div>

          {refusedTransitions.length > 0 ? (
            <Alert tone="info" title="What this permit cannot do yet, and why">
              <ul className="space-y-1">
                {refusedTransitions.map((t) => (
                  <li key={t.action} className="text-meta">
                    <span className="font-medium">{labelize(t.action)}:</span> {t.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <div>
            <SectionHeading
              title="Precautions"
              hint="Tick each one you have confirmed on site. Every required precaution must be ticked before the permit can go active — the platform will not tick them for you."
            />
            <ul className="space-y-1 text-meta">
              {p.precautions.length === 0 ? <li className="text-content-muted">None recorded.</li> : null}
              {p.precautions.map((c, i) => {
                const isDone = ticked[c.item] ?? c.done;
                return (
                  <li key={i} className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-1.5">
                    <label className="flex flex-1 items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-accent-solid"
                        checked={isDone}
                        onChange={(e) => setTicked((current) => ({ ...current, [c.item]: e.target.checked }))}
                      />
                      <span className="text-content">{c.item}</span>
                    </label>
                    <span className="flex gap-1">
                      {c.required ? <Badge tone="neutral" size="xs">required</Badge> : <Badge tone="neutral" size="xs">advisory</Badge>}
                      <Badge tone={isDone ? "success" : "warning"} size="xs">
                        {isDone ? "done" : "outstanding"}
                      </Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {p.permitType === "confined_space" || p.entries.length > 0 || p.status === "active" ? (
            <div>
              <SectionHeading
                title="Who is inside"
                hint="Every entry carries an expected exit time. The five-minute sweep flags anyone still recorded inside past theirs."
              />
              {p.overdueEntries.length > 0 ? (
                <Alert tone="danger" title={`${p.overdueEntries.length} person(s) overdue out`}>
                  <ul className="space-y-1 text-meta">
                    {p.overdueEntries.map((o) => (
                      <li key={o.id}>
                        {o.personName} — expected out {dateTime(o.expectedExitAt)}, {minutesLabel(o.overdueMinutes)} late, inside {minutesLabel(o.insideMinutes)}.
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              <ul className="mt-2 space-y-1 text-meta">
                {p.entries.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-1.5">
                    <span className="min-w-0">
                      <span className="font-medium text-content">{entry.personName}</span>
                      <span className="ml-2 text-2xs text-content-muted">
                        in {dateTime(entry.enteredAt)} · due out {dateTime(entry.expectedExitAt)}
                        {entry.attendantName ? ` · attendant ${entry.attendantName}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={ENTRY_STATUS_TONE[entry.status] ?? "neutral"} size="xs" dot>
                        {labelize(entry.status)}
                      </Badge>
                      {entry.status !== "exited" ? (
                        <Button size="xs" variant="ghost" loading={action.busy === "exit"} onClick={() => void exitEntry(entry.id)}>
                          Record exit
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {p.status === "active" ? (
                <form onSubmit={(e) => void addEntry(e)} className="mt-2 flex items-end gap-2">
                  <Field label="Person" className="flex-1">
                    <Input value={entryName} onChange={(e) => setEntryName(e.target.value)} required />
                  </Field>
                  <Field label="Expected duration (min)">
                    <Input type="number" min={1} value={entryMinutes} onChange={(e) => setEntryMinutes(e.target.value)} />
                  </Field>
                  <Button type="submit" size="sm" variant="secondary" loading={action.busy === "entry"}>
                    Record entry
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : detail.loading ? (
        <p className="text-meta text-content-muted">Loading the permit…</p>
      ) : null}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Exclusion zones                                                     */
/* ------------------------------------------------------------------ */

function ZonesPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<ZoneRow>>(`${base}/zones?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [checkResult, setCheckResult] = useState<{ inside: boolean; hits: Array<{ zoneName: string; test: string; distanceM: number | null; kind: string | null }>; zonesTested: number; reasons: string[] } | null>(null);

  const columns = useMemo<DataColumns<ZoneRow>>(
    () => [
      { id: "name", header: "Zone", accessor: "name", type: "text", sticky: "start", width: 220 },
      { id: "kind", header: "Kind", accessor: "kind", type: "status", width: 160, groupable: true, cell: ({ row }) => labelize(row.kind) },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={ZONE_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "shape",
        header: "Shape",
        accessor: (row) => (row.ring.length >= 3 ? `${row.ring.length}-point ring` : row.radiusM ? `${row.radiusM} m radius` : "not testable"),
        type: "text",
        width: 160,
        cell: ({ row }) =>
          row.ring.length >= 3 ? (
            `${row.ring.length}-point ring`
          ) : row.radiusM ? (
            `${num(row.radiusM)} m radius`
          ) : (
            <Badge tone="danger" size="xs">
              not testable
            </Badge>
          ),
      },
      { id: "severity", header: "Severity", accessor: "severity", type: "status", width: 110, cell: ({ row }) => <Badge tone={SEVERITY_TONE[row.severity] ?? "neutral"} size="xs">{labelize(row.severity)}</Badge> },
      { id: "activeTo", header: "Active until", accessor: (row) => row.activeTo ?? "", type: "datetime", width: 175, cell: ({ row }) => dateTime(row.activeTo) },
    ],
    [],
  );

  async function transition(row: ZoneRow, verb: "activate" | "lift" | "cancel") {
    const r = await action.run(verb, () => api.post<ZoneRow>(`${base}/zones/${row.id}/${verb}`, {}));
    if (r) {
      toast.success(`${r.name} ${labelize(r.status).toLowerCase()}`);
      list.reload();
      onChanged();
    }
  }

  async function check(e: FormEvent) {
    e.preventDefault();
    const r = await action.run("check", () =>
      api.post<{ inside: boolean; hits: Array<{ zoneName: string; test: string; distanceM: number | null; kind: string | null }>; zonesTested: number; reasons: string[] }>(
        `${base}/zones/check`,
        { lat: Number(lat), lon: Number(lon) },
      ),
    );
    if (r) setCheckResult(r);
  }

  return (
    <div className="space-y-3">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Exclusion zones"
            hint="A closed ring of points, or a centre and a radius. A zone with neither cannot be tested against a position, and the platform says so instead of quietly passing it."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                Draw a zone
              </Button>
            }
          />
          {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
          <DataTable
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={list.loading && !list.data}
            height={380}
            stickyHeader
            exportFileName="exclusion-zones"
            rowTone={(row) => (row.status === "active" ? "danger" : undefined)}
            rowActions={(row) => (
              <span className="flex gap-1">
                {row.status !== "active" ? (
                  <Button size="xs" variant="ghost" onClick={() => void transition(row, "activate")}>
                    Activate
                  </Button>
                ) : null}
                {row.status === "active" || row.status === "planned" ? (
                  <Button size="xs" variant="ghost" onClick={() => void transition(row, "lift")}>
                    Lift
                  </Button>
                ) : null}
              </span>
            )}
            empty={{ title: "No exclusion zones", description: "Draw the lift zones, blast radii and open excavations so a position can be tested against them." }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading title="Test a position" hint="Point-in-polygon against every live zone. This is the same answer a phone or a plant tracker gets from the API." />
          <form onSubmit={(e) => void check(e)} className="flex flex-wrap items-end gap-2">
            <Field label="Latitude">
              <Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="51.5074" required />
            </Field>
            <Field label="Longitude">
              <Input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-0.1278" required />
            </Field>
            <Button type="submit" size="sm" variant="secondary" loading={action.busy === "check"}>
              Check
            </Button>
          </form>
          {checkResult ? (
            <div className="mt-3">
              <Alert tone={checkResult.inside ? "danger" : "success"} title={checkResult.inside ? "Inside a live exclusion zone" : "Clear of every live zone"}>
                {checkResult.inside
                  ? checkResult.hits.map((h) => `${h.zoneName} (${labelize(h.kind)}, ${h.test} test${h.distanceM !== null ? `, ${num(h.distanceM)} m inside` : ""})`).join("; ")
                  : `${checkResult.zonesTested} zone(s) tested.`}
              </Alert>
              <ReasonList reasons={checkResult.reasons} className="mt-2" />
            </div>
          ) : null}
        </CardBody>
      </Card>

      <ZoneForm
        base={base}
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {
          setOpen(false);
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function ZoneForm({ base, open, onClose, onCreated }: { base: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("lifting");
  const [shape, setShape] = useState<"ring" | "radius">("radius");
  const [ring, setRing] = useState("-0.1280, 51.5070\n-0.1270, 51.5070\n-0.1270, 51.5078\n-0.1280, 51.5078");
  const [centreLat, setCentreLat] = useState("");
  const [centreLon, setCentreLon] = useState("");
  const [radiusM, setRadiusM] = useState("30");
  const [activeTo, setActiveTo] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { name: name.trim(), kind, activeFrom: new Date().toISOString() };
    if (activeTo) payload["activeTo"] = new Date(activeTo).toISOString();
    if (shape === "ring") {
      payload["ring"] = ring
        .split("\n")
        .map((line) => line.split(",").map((n) => Number(n.trim())))
        .filter((pair) => pair.length === 2 && pair.every((n) => Number.isFinite(n)));
    } else {
      payload["centreLat"] = Number(centreLat);
      payload["centreLon"] = Number(centreLon);
      payload["radiusM"] = Number(radiusM);
    }
    const r = await action.run("create", () => api.post<ZoneRow>(`${base}/zones`, payload));
    if (r) {
      toast.success(`${r.name} created`);
      setName("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Draw an exclusion zone" description="A ring is a list of longitude, latitude pairs — one per line, in order around the boundary." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {ZONE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Shape">
            <Select value={shape} onChange={(e) => setShape(e.target.value as "ring" | "radius")}>
              <option value="radius">Centre and radius</option>
              <option value="ring">Polygon ring</option>
            </Select>
          </Field>
        </div>
        {shape === "ring" ? (
          <Field label="Ring" hint="One `longitude, latitude` pair per line; at least three.">
            <Textarea rows={5} value={ring} onChange={(e) => setRing(e.target.value)} />
          </Field>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Centre latitude" required>
              <Input value={centreLat} onChange={(e) => setCentreLat(e.target.value)} required />
            </Field>
            <Field label="Centre longitude" required>
              <Input value={centreLon} onChange={(e) => setCentreLon(e.target.value)} required />
            </Field>
            <Field label="Radius (m)" required>
              <Input type="number" min={1} value={radiusM} onChange={(e) => setRadiusM(e.target.value)} required />
            </Field>
          </div>
        )}
        <Field label="Active until">
          <Input type="datetime-local" value={activeTo} onChange={(e) => setActiveTo(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Create
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Lone working                                                        */
/* ------------------------------------------------------------------ */

function LoneWorkerPanel({ base, lookups, onChanged }: { base: string; lookups: SiteLookups; onChanged: () => void }) {
  const list = useResource<LoneWorkerList>(`${base}/lone-workers?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);

  const columns = useMemo<DataColumns<LoneWorkerRow>>(
    () => [
      { id: "personName", header: "Person", accessor: "personName", type: "text", sticky: "start", width: 200 },
      { id: "activity", header: "Activity", accessor: "activity", type: "text", width: 280 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={LONE_WORKER_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "nextDueAt",
        header: "Next check-in",
        accessor: "nextDueAt",
        type: "datetime",
        width: 210,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {dateTime(row.nextDueAt)} <span className="text-2xs text-content-muted">({relativeToNow(row.nextDueAt)})</span>
          </span>
        ),
      },
      { id: "intervalMinutes", header: "Every", accessor: "intervalMinutes", type: "number", width: 90, cell: ({ row }) => `${row.intervalMinutes} min` },
      { id: "checkInCount", header: "Check-ins", accessor: "checkInCount", type: "number", width: 100 },
      { id: "missedCount", header: "Missed", accessor: "missedCount", type: "number", width: 90 },
      { id: "contactName", header: "Emergency contact", accessor: (row) => row.contactName ?? "", type: "text", width: 200 },
    ],
    [],
  );

  async function checkIn(row: LoneWorkerRow) {
    const r = await action.run("checkin", () => api.post<{ lateSeconds: number }>(`${base}/lone-workers/${row.id}/check-in`, { method: "manual" }));
    if (r) {
      toast.success(r.lateSeconds > 0 ? `Checked in ${Math.round(r.lateSeconds / 60)} min late` : "Checked in on time");
      list.reload();
      onChanged();
    }
  }

  async function close(row: LoneWorkerRow) {
    const r = await action.run("close", () => api.post<LoneWorkerRow>(`${base}/lone-workers/${row.id}/close`, {}));
    if (r) {
      toast.success("Session closed");
      list.reload();
      onChanged();
    }
  }

  return (
    <div className="space-y-3">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {(list.data?.due.length ?? 0) > 0 ? (
        <Alert tone="danger" title={`${list.data?.due.length} lone worker(s) past a check-in`}>
          <ul className="space-y-1 text-meta">
            {(list.data?.due ?? []).map((d) => (
              <li key={d.id}>{d.reason}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Lone working"
            hint="A session with a check-in interval. The five-minute sweep marks a missed check-in overdue and escalates it — with a critical signal and a notification — once a whole interval has passed."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                Start a session
              </Button>
            }
          />
          {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
          <DataTable
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={list.loading && !list.data}
            height={440}
            stickyHeader
            filterRow
            exportFileName="lone-worker-sessions"
            rowTone={(row) => (row.status === "escalated" ? "danger" : row.status === "overdue" ? "warning" : undefined)}
            rowActions={(row) =>
              row.status === "completed" || row.status === "cancelled" ? null : (
                <span className="flex gap-1">
                  <Button size="xs" variant="ghost" onClick={() => void checkIn(row)}>
                    Check in
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => void close(row)}>
                    Close
                  </Button>
                </span>
              )
            }
            empty={{
              title: "No lone-working sessions",
              description: "Start a session for anybody working out of sight of others. A missed check-in becomes an escalation, not a silence.",
              action: (
                <Button size="sm" onClick={() => setOpen(true)}>
                  Start the first session
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <LoneWorkerForm
        base={base}
        lookups={lookups}
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {
          setOpen(false);
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function LoneWorkerForm({
  base,
  lookups,
  open,
  onClose,
  onCreated,
}: {
  base: string;
  lookups: SiteLookups;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [personName, setPersonName] = useState("");
  const [activity, setActivity] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("30");
  const [locationDescription, setLocationDescription] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      personName: personName.trim(),
      activity: activity.trim(),
      intervalMinutes: Number(intervalMinutes) || 30,
    };
    if (locationDescription.trim()) payload["locationDescription"] = locationDescription.trim();
    if (contactName.trim()) payload["contactName"] = contactName.trim();
    if (contactPhone.trim()) payload["contactPhone"] = contactPhone.trim();
    const r = await action.run("create", () => api.post<LoneWorkerRow>(`${base}/lone-workers`, payload));
    if (r) {
      toast.success(`${r.personName} — first check-in due ${dateTime(r.nextDueAt)}`);
      setPersonName("");
      setActivity("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Start a lone-working session" description="The interval is the whole control: pick one somebody could survive being late by." size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <Field label="Person" required>
          <Input value={personName} onChange={(e) => setPersonName(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Activity" required>
          <Input value={activity} onChange={(e) => setActivity(e.target.value)} required maxLength={500} />
        </Field>
        <Field label="Check-in interval (minutes)">
          <Input type="number" min={5} max={240} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} />
        </Field>
        <Field label="Where">
          <Input value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)} maxLength={300} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Emergency contact">
            <Input value={contactName} onChange={(e) => setContactName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Phone">
            <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} maxLength={60} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Start
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
