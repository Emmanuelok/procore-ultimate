/**
 * REALITY CAPTURE — drone flights, laser scans, scan-versus-model deviation
 * reports and 360° tours (#1077–1080).
 *
 * Two refusals are visible here rather than hidden: a flight cannot be
 * recorded as flown while its permission is pending or refused, and a
 * deviation report against an unregistered scan reads "not assessable" with
 * the reason — never "within tolerance".
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardBody, Drawer, Field, Input, Select, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus, IconScan } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  DEVIATION_TONE,
  EM_DASH,
  KeyValue,
  LoadError,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  dateTime,
  labelize,
  num,
  optionList,
  useAction,
  useResource,
  type DeviationRow,
  type FlightRow,
  type ListResponse,
  type ScanRow,
  type SiteLookups,
  type TourRow,
} from "./siteShared";

type Panel = "flights" | "scans" | "deviations" | "tours";

export default function CaptureTab({ projectId, lookups, onChanged }: { projectId: string; lookups: SiteLookups; onChanged: () => void }) {
  const [panel, setPanel] = useState<Panel>("scans");
  const base = `/api/v1/projects/${projectId}/site`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { value: "scans", label: "Scans" },
            { value: "deviations", label: "Scan vs model" },
            { value: "flights", label: "Drone flights" },
            { value: "tours", label: "360° tours" },
          ] as Array<{ value: Panel; label: string }>
        ).map((p) => (
          <Button key={p.value} size="xs" variant={panel === p.value ? "secondary" : "ghost"} onClick={() => setPanel(p.value)}>
            {p.label}
          </Button>
        ))}
      </div>
      {panel === "scans" ? <ScansPanel base={base} lookups={lookups} onChanged={onChanged} /> : null}
      {panel === "deviations" ? <DeviationsPanel base={base} onChanged={onChanged} /> : null}
      {panel === "flights" ? <FlightsPanel base={base} lookups={lookups} onChanged={onChanged} /> : null}
      {panel === "tours" ? <ToursPanel base={base} onChanged={onChanged} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ScansPanel({ base, lookups, onChanged }: { base: string; lookups: SiteLookups; onChanged: () => void }) {
  const list = useResource<ListResponse<ScanRow>>(`${base}/scans?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [captureId, setCaptureId] = useState<string | null>(null);

  const columns = useMemo<DataColumns<ScanRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "name", header: "Scan", accessor: "name", type: "text", width: 240 },
      { id: "method", header: "Method", accessor: "method", type: "status", width: 160, groupable: true, cell: ({ row }) => labelize(row.method) },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.status) },
      {
        id: "registrationStatus",
        header: "Registration",
        accessor: "registrationStatus",
        type: "status",
        width: 200,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={row.registrationStatus === "registered" ? "success" : row.registrationStatus === "failed" ? "danger" : "warning"} size="xs" dot>
            {labelize(row.registrationStatus)}
            {row.registrationErrorMm !== null ? ` · ${num(row.registrationErrorMm, 1)} mm` : ""}
          </Badge>
        ),
      },
      { id: "capturedAt", header: "Captured", accessor: (row) => row.capturedAt ?? "", type: "datetime", width: 175, cell: ({ row }) => dateTime(row.capturedAt) },
      { id: "setupCount", header: "Setups", accessor: (row) => row.setupCount ?? 0, type: "number", width: 90, cell: ({ row }) => (row.setupCount === null ? EM_DASH : num(row.setupCount)) },
      { id: "coordinateSystem", header: "CRS", accessor: (row) => row.coordinateSystem ?? "", type: "text", width: 140 },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Laser scans and point clouds"
            hint="A scan recorded as registered must carry its registration residual: a registration without a number is an assertion, not a measurement, and nothing may be compared against it."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                Plan a scan
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
            exportFileName="site-scans"
            rowTone={(row) => (row.registrationStatus === "failed" ? "danger" : undefined)}
            rowActions={(row) => (
              <Button size="xs" variant="ghost" onClick={() => setCaptureId(row.id)}>
                Record capture
              </Button>
            )}
            empty={{
              title: "No scans",
              description: "Plan the surveys that will be compared with the model. A scan on the platform is a scan a deviation report can cite.",
              action: (
                <Button size="sm" onClick={() => setOpen(true)}>
                  Plan the first scan
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <ScanForm
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
      <CaptureForm
        base={base}
        scanId={captureId}
        onClose={() => setCaptureId(null)}
        onSaved={() => {
          setCaptureId(null);
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function ScanForm({
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
  const [name, setName] = useState("");
  const [method, setMethod] = useState("terrestrial_laser");
  const [vendorId, setVendorId] = useState("");
  const [coordinateSystem, setCoordinateSystem] = useState("");
  const [areaDescription, setAreaDescription] = useState("");
  const [modelId, setModelId] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { name: name.trim(), method };
    if (vendorId) payload["vendorId"] = vendorId;
    if (coordinateSystem.trim()) payload["coordinateSystem"] = coordinateSystem.trim();
    if (areaDescription.trim()) payload["areaDescription"] = areaDescription.trim();
    if (modelId.trim()) payload["modelId"] = modelId.trim();
    const r = await action.run("create", () => api.post<ScanRow>(`${base}/scans`, payload));
    if (r) {
      toast.success(`${r.reference} planned`);
      setName("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Plan a scan" size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {["terrestrial_laser", "slam", "photogrammetry", "mobile_mapping", "drone_lidar", "total_station", "gpr"].map((m) => (
              <option key={m} value={m}>
                {labelize(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Surveyor">
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            {optionList(lookups.vendors, (v) => v.name).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Area">
          <Input value={areaDescription} onChange={(e) => setAreaDescription(e.target.value)} maxLength={500} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Coordinate system">
            <Input value={coordinateSystem} onChange={(e) => setCoordinateSystem(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Model id" hint="The BIM model this scan will be compared against.">
            <Input value={modelId} onChange={(e) => setModelId(e.target.value)} maxLength={64} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Plan
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function CaptureForm({ base, scanId, onClose, onSaved }: { base: string; scanId: string | null; onClose: () => void; onSaved: () => void }) {
  const action = useAction();
  const [registrationStatus, setRegistrationStatus] = useState("registered");
  const [registrationErrorMm, setRegistrationErrorMm] = useState("");
  const [setupCount, setSetupCount] = useState("");
  const [pointCountMillions, setPointCountMillions] = useState("");
  const [capturedByName, setCapturedByName] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { registrationStatus };
    if (registrationErrorMm.trim()) payload["registrationErrorMm"] = Number(registrationErrorMm);
    if (setupCount.trim()) payload["setupCount"] = Number(setupCount);
    if (pointCountMillions.trim()) payload["pointCountMillions"] = Number(pointCountMillions);
    if (capturedByName.trim()) payload["capturedByName"] = capturedByName.trim();
    const r = await action.run("capture", () => api.post<ScanRow>(`${base}/scans/${scanId}/captured`, payload));
    if (r) {
      toast.success(`${r.reference} recorded as ${labelize(r.status).toLowerCase()}`);
      onSaved();
    }
  }

  return (
    <Drawer open={scanId !== null} onClose={onClose} title="Record the capture" description="Registration is what ties the point cloud to the project control. Without a residual, no deviation from this scan can be assessed." size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Registration">
          <Select value={registrationStatus} onChange={(e) => setRegistrationStatus(e.target.value)}>
            {["registered", "unregistered", "failed"].map((s) => (
              <option key={s} value={s}>
                {labelize(s)}
              </option>
            ))}
          </Select>
        </Field>
        {registrationStatus === "registered" ? (
          <Field label="Registration error (mm)" required hint="The residual from the control fit.">
            <Input type="number" step="0.1" min={0} value={registrationErrorMm} onChange={(e) => setRegistrationErrorMm(e.target.value)} required />
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Setups">
            <Input type="number" min={0} value={setupCount} onChange={(e) => setSetupCount(e.target.value)} />
          </Field>
          <Field label="Points (millions)">
            <Input type="number" step="0.1" min={0} value={pointCountMillions} onChange={(e) => setPointCountMillions(e.target.value)} />
          </Field>
        </div>
        <Field label="Captured by">
          <Input value={capturedByName} onChange={(e) => setCapturedByName(e.target.value)} maxLength={200} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "capture"}>
            Save
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function DeviationsPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<DeviationRow>>(`${base}/deviations?pageSize=100`);
  const scans = useResource<ListResponse<ScanRow>>(`${base}/scans?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = (list.data?.items ?? []).find((d) => d.id === openId) ?? null;

  const columns = useMemo<DataColumns<DeviationRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      {
        id: "verdict",
        header: "Verdict",
        accessor: "verdict",
        type: "status",
        width: 170,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={DEVIATION_TONE[row.verdict] ?? "neutral"} size="xs" dot>
            {labelize(row.verdict)}
          </Badge>
        ),
      },
      { id: "toleranceMm", header: "Tolerance", accessor: "toleranceMm", type: "number", width: 110, cell: ({ row }) => `${num(row.toleranceMm)} mm` },
      { id: "elementCount", header: "Elements", accessor: "elementCount", type: "number", width: 100 },
      { id: "outOfToleranceCount", header: "Out", accessor: "outOfToleranceCount", type: "number", width: 90 },
      { id: "marginalCount", header: "Marginal", accessor: "marginalCount", type: "number", width: 100 },
      { id: "maxDeviationMm", header: "Worst (mm)", accessor: (row) => row.maxDeviationMm ?? 0, type: "number", width: 120, cell: ({ row }) => (row.maxDeviationMm === null ? EM_DASH : num(row.maxDeviationMm, 1)) },
      { id: "rmsDeviationMm", header: "RMS (mm)", accessor: (row) => row.rmsDeviationMm ?? 0, type: "number", width: 110, cell: ({ row }) => (row.rmsDeviationMm === null ? EM_DASH : num(row.rmsDeviationMm, 1)) },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 110, groupable: true, cell: ({ row }) => labelize(row.status) },
      { id: "generatedAt", header: "Generated", accessor: "generatedAt", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.generatedAt) },
    ],
    [],
  );

  async function accept(id: string, status: string) {
    const r = await action.run("accept", () => api.post<DeviationRow>(`${base}/deviations/${id}/accept`, { status }));
    if (r) {
      toast.success(`${r.reference} ${labelize(r.status).toLowerCase()}`);
      list.reload();
      onChanged();
    }
  }

  return (
    <div className="space-y-3">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Scan versus model"
            hint="Per-element deviations rolled up per zone. The verdict is the worst element, not the average — a single column 40 mm out is not averaged away by a hundred good ones."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                New comparison
              </Button>
            }
          />
          {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
          <DataTable
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={list.loading && !list.data}
            height={400}
            stickyHeader
            exportFileName="scan-deviations"
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.verdict === "out_of_tolerance" ? "danger" : row.verdict === "marginal" ? "warning" : undefined)}
            empty={{
              title: "No deviation reports",
              description: "Upload the per-element deviations from a cloud-to-mesh comparison and the platform will do the arithmetic and the refusals.",
            }}
          />
        </CardBody>
      </Card>

      <DeviationForm
        base={base}
        scans={scans.data?.items ?? []}
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {
          setOpen(false);
          list.reload();
          onChanged();
        }}
      />

      <Drawer open={openId !== null} onClose={() => setOpenId(null)} title={detail ? `${detail.reference} — scan vs model` : "Deviation report"} size="lg">
        {detail ? (
          <div className="space-y-4">
            <Alert tone={detail.verdict === "out_of_tolerance" ? "danger" : detail.verdict === "not_assessable" ? "warning" : "success"} title={labelize(detail.verdict)}>
              <ReasonList reasons={detail.reasons} />
              {detail.reasons.length === 0 ? "Every element is inside the inner band of the tolerance." : null}
            </Alert>
            <KeyValue
              items={[
                { label: "Tolerance", value: `${num(detail.toleranceMm)} mm` },
                { label: "Elements compared", value: num(detail.elementCount) },
                { label: "Within tolerance", value: num(detail.withinToleranceCount) },
                { label: "Marginal", value: num(detail.marginalCount) },
                { label: "Out of tolerance", value: num(detail.outOfToleranceCount) },
                { label: "Worst deviation", value: detail.maxDeviationMm === null ? EM_DASH : `${num(detail.maxDeviationMm, 1)} mm` },
                { label: "Mean absolute", value: detail.meanAbsDeviationMm === null ? EM_DASH : `${num(detail.meanAbsDeviationMm, 1)} mm` },
                { label: "RMS", value: detail.rmsDeviationMm === null ? EM_DASH : `${num(detail.rmsDeviationMm, 1)} mm` },
              ]}
            />
            <div>
              <SectionHeading title="By zone" hint="Worst zone first." />
              <table className="w-full text-meta">
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wide text-content-subtle">
                    <th className="py-1">Zone</th>
                    <th className="py-1 text-right">Elements</th>
                    <th className="py-1 text-right">Out</th>
                    <th className="py-1 text-right">Worst (mm)</th>
                    <th className="py-1">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.byZone.map((z) => (
                    <tr key={z.zone} className="border-t border-border-subtle">
                      <td className="py-1">{z.zone}</td>
                      <td className="py-1 text-right tabular-nums">{num(z.elements)}</td>
                      <td className="py-1 text-right tabular-nums">{num(z.outOfTolerance)}</td>
                      <td className="py-1 text-right tabular-nums">{z.maxDeviationMm === null ? EM_DASH : num(z.maxDeviationMm, 1)}</td>
                      <td className="py-1">
                        <Badge tone={DEVIATION_TONE[z.verdict] ?? "neutral"} size="xs">
                          {labelize(z.verdict)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                  {detail.byZone.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-2 text-content-muted">
                        Nothing was assessable, so there is no zone roll-up.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {detail.status === "draft" ? (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" loading={action.busy === "accept"} onClick={() => void accept(detail.id, "rejected")}>
                  Reject
                </Button>
                <Button loading={action.busy === "accept"} onClick={() => void accept(detail.id, "accepted")}>
                  Accept
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function DeviationForm({
  base,
  scans,
  open,
  onClose,
  onCreated,
}: {
  base: string;
  scans: ScanRow[];
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [scanId, setScanId] = useState("");
  const [toleranceMm, setToleranceMm] = useState("10");
  const [items, setItems] = useState("COL-B3, L2, 2.4\nCOL-B4, L2, -9.1\nSLAB-L3, L3, 25.0");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = items
      .split("\n")
      .map((line) => line.split(",").map((p) => p.trim()))
      .filter((parts) => parts.length >= 2 && parts[0])
      .map((parts) =>
        parts.length >= 3
          ? { elementId: parts[0]!, zone: parts[1]!, deviationMm: Number(parts[2]) }
          : { elementId: parts[0]!, deviationMm: Number(parts[1]) },
      )
      .filter((item) => Number.isFinite(item.deviationMm));
    const r = await action.run("create", () =>
      api.post<DeviationRow>(`${base}/scans/${scanId}/deviations`, { toleranceMm: Number(toleranceMm), items: parsed }),
    );
    if (r) {
      toast.success(`${r.reference}: ${labelize(r.verdict)}`);
      onCreated();
    }
  }

  const selected = scans.find((s) => s.id === scanId);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Compare a scan with the model"
      description="One element per line: `element id, zone, deviation in mm`. Zone is optional."
      size="md"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Scan" required>
          <Select value={scanId} onChange={(e) => setScanId(e.target.value)} required>
            {optionList(scans, (s) => `${s.reference} — ${s.name} (${labelize(s.registrationStatus)})`, "— choose a scan —").map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {selected && selected.registrationStatus !== "registered" ? (
          <Alert tone="warning" title="This scan is not registered">
            The comparison will be recorded, but its verdict will be "not assessable": an unregistered point cloud has no defensible relationship to the model.
          </Alert>
        ) : null}
        <Field label="Tolerance (mm)" required>
          <Input type="number" step="0.5" min={0.1} value={toleranceMm} onChange={(e) => setToleranceMm(e.target.value)} required />
        </Field>
        <Field label="Element deviations">
          <Textarea rows={8} value={items} onChange={(e) => setItems(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"} disabled={!scanId}>
            Compare
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function FlightsPanel({ base, lookups, onChanged }: { base: string; lookups: SiteLookups; onChanged: () => void }) {
  const list = useResource<ListResponse<FlightRow>>(`${base}/flights?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);

  const columns = useMemo<DataColumns<FlightRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "purpose", header: "Purpose", accessor: "purpose", type: "status", width: 140, groupable: true, cell: ({ row }) => labelize(row.purpose) },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.status) },
      {
        id: "permissionStatus",
        header: "Permission",
        accessor: "permissionStatus",
        type: "status",
        width: 160,
        groupable: true,
        cell: ({ row }) => (
          <Badge
            tone={row.permissionStatus === "granted" || row.permissionStatus === "not_required" ? "success" : row.permissionStatus === "refused" ? "danger" : "warning"}
            size="xs"
            dot
          >
            {labelize(row.permissionStatus)}
          </Badge>
        ),
      },
      { id: "pilotName", header: "Pilot", accessor: (row) => row.pilotName ?? "", type: "text", width: 170 },
      { id: "aircraft", header: "Aircraft", accessor: (row) => row.aircraft ?? "", type: "text", width: 140 },
      { id: "flownAt", header: "Flown", accessor: (row) => row.flownAt ?? "", type: "datetime", width: 175, cell: ({ row }) => dateTime(row.flownAt) },
      { id: "imageCount", header: "Images", accessor: (row) => row.imageCount ?? 0, type: "number", width: 100, cell: ({ row }) => (row.imageCount === null ? EM_DASH : num(row.imageCount)) },
    ],
    [],
  );

  async function grant(row: FlightRow) {
    const permissionRef = window.prompt("Permission reference (airspace or landowner):") ?? "";
    const r = await action.run("grant", () =>
      api.patch<FlightRow>(`${base}/flights/${row.id}`, { permissionStatus: "granted", permissionRef: permissionRef || null }),
    );
    if (r) {
      toast.success(`${r.reference} permitted`);
      list.reload();
      onChanged();
    }
  }

  async function flown(row: FlightRow) {
    const r = await action.run("flown", () => api.post<FlightRow>(`${base}/flights/${row.id}/flown`, {}));
    if (r) {
      toast.success(`${r.reference} recorded as flown`);
      list.reload();
      onChanged();
    }
  }

  return (
    <Card>
      <CardBody>
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <SectionHeading
          title="Drone flights"
          hint="A flight cannot be recorded as flown while its airspace or landowner permission is pending or refused. The permission is the control, so the platform will not let the record imply one that was never obtained."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
              Plan a flight
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
          exportFileName="drone-flights"
          rowTone={(row) => (row.permissionStatus === "refused" ? "danger" : row.permissionStatus === "pending" ? "warning" : undefined)}
          rowActions={(row) => (
            <span className="flex gap-1">
              {row.permissionStatus === "pending" ? (
                <Button size="xs" variant="ghost" onClick={() => void grant(row)}>
                  Record permission
                </Button>
              ) : null}
              {row.status === "permitted" ? (
                <Button size="xs" variant="ghost" onClick={() => void flown(row)}>
                  Record as flown
                </Button>
              ) : null}
            </span>
          )}
          empty={{
            title: "No drone flights",
            description: "Plan the flight, record the permission, then record what was captured. Each step is a record somebody can be asked about later.",
            action: (
              <Button size="sm" onClick={() => setOpen(true)}>
                Plan the first flight
              </Button>
            ),
          }}
        />
        <FlightForm
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
      </CardBody>
    </Card>
  );
}

function FlightForm({
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
  const [purpose, setPurpose] = useState("progress");
  const [pilotName, setPilotName] = useState("");
  const [pilotLicenceRef, setPilotLicenceRef] = useState("");
  const [operatorVendorId, setOperatorVendorId] = useState("");
  const [aircraft, setAircraft] = useState("");
  const [plannedFor, setPlannedFor] = useState("");
  const [permissionStatus, setPermissionStatus] = useState("pending");
  const [permissionRef, setPermissionRef] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { purpose, permissionStatus };
    if (pilotName.trim()) payload["pilotName"] = pilotName.trim();
    if (pilotLicenceRef.trim()) payload["pilotLicenceRef"] = pilotLicenceRef.trim();
    if (operatorVendorId) payload["operatorVendorId"] = operatorVendorId;
    if (aircraft.trim()) payload["aircraft"] = aircraft.trim();
    if (plannedFor) payload["plannedFor"] = new Date(plannedFor).toISOString();
    if (permissionRef.trim()) payload["permissionRef"] = permissionRef.trim();
    const r = await action.run("create", () => api.post<FlightRow>(`${base}/flights`, payload));
    if (r) {
      toast.success(`${r.reference} planned`);
      setPilotName("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Plan a drone flight" size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <Field label="Purpose">
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            {["progress", "survey", "inspection", "thermal", "volumetrics", "safety", "marketing", "other"].map((p) => (
              <option key={p} value={p}>
                {labelize(p)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pilot">
            <Input value={pilotName} onChange={(e) => setPilotName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Licence">
            <Input value={pilotLicenceRef} onChange={(e) => setPilotLicenceRef(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Operator">
            <Select value={operatorVendorId} onChange={(e) => setOperatorVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Aircraft">
            <Input value={aircraft} onChange={(e) => setAircraft(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Planned for">
            <Input type="datetime-local" value={plannedFor} onChange={(e) => setPlannedFor(e.target.value)} />
          </Field>
          <Field label="Permission">
            <Select value={permissionStatus} onChange={(e) => setPermissionStatus(e.target.value)}>
              {["pending", "granted", "not_required", "refused"].map((p) => (
                <option key={p} value={p}>
                  {labelize(p)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Permission reference">
          <Input value={permissionRef} onChange={(e) => setPermissionRef(e.target.value)} maxLength={200} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Plan
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function ToursPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<TourRow>>(`${base}/tours?pageSize=100`);
  const action = useAction();
  const [name, setName] = useState("");
  const [stationName, setStationName] = useState("");
  const [activeTour, setActiveTour] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    const r = await action.run("create", () => api.post<TourRow>(`${base}/tours`, { name: name.trim() }));
    if (r) {
      toast.success(`${r.name} created`);
      setName("");
      setActiveTour(r.id);
      list.reload();
      onChanged();
    }
  }

  async function addStation(e: FormEvent) {
    e.preventDefault();
    if (!activeTour) return;
    const r = await action.run("station", () => api.post<unknown>(`${base}/tours/${activeTour}/stations`, { name: stationName.trim() }));
    if (r) {
      setStationName("");
      toast.success("Station added");
      list.reload();
      onChanged();
    }
  }

  async function publish(row: TourRow) {
    const r = await action.run("publish", () => api.post<TourRow>(`${base}/tours/${row.id}/publish`, {}));
    if (r) {
      toast.success(`${r.name} published`);
      list.reload();
      onChanged();
    }
  }

  return (
    <Card>
      <CardBody>
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <SectionHeading title="360° photo tours" hint="A tour with no stations has nothing to publish, and the platform says so rather than publishing an empty walkthrough." />
        <form onSubmit={(e) => void create(e)} className="mb-3 flex items-end gap-2">
          <Field label="New tour" className="flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Level 3 walkthrough — week 42" required />
          </Field>
          <Button type="submit" size="sm" variant="secondary" loading={action.busy === "create"}>
            Create
          </Button>
        </form>
        {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
        <ul className="space-y-2">
          {(list.data?.items ?? []).map((tour) => (
            <li key={tour.id} className="rounded-md border border-border-subtle p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="text-meta font-medium text-content">{tour.name}</span>
                  <span className="ml-2 text-2xs text-content-muted">
                    {num(tour.stationCount)} station(s) · captured {dateTime(tour.capturedAt)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={tour.status === "published" ? "success" : "neutral"} size="xs">
                    {labelize(tour.status)}
                  </Badge>
                  <Button size="xs" variant="ghost" onClick={() => setActiveTour(activeTour === tour.id ? null : tour.id)}>
                    {activeTour === tour.id ? "Done" : "Add stations"}
                  </Button>
                  {tour.status === "draft" ? (
                    <Button size="xs" variant="ghost" loading={action.busy === "publish"} onClick={() => void publish(tour)}>
                      Publish
                    </Button>
                  ) : null}
                </span>
              </div>
              {activeTour === tour.id ? (
                <form onSubmit={(e) => void addStation(e)} className="mt-2 flex items-end gap-2">
                  <Field label="Station" className="flex-1">
                    <Input value={stationName} onChange={(e) => setStationName(e.target.value)} placeholder="Core lobby" required />
                  </Field>
                  <Button type="submit" size="xs" variant="secondary" loading={action.busy === "station"}>
                    Add
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
          {(list.data?.items.length ?? 0) === 0 && !list.loading ? (
            <li className="flex items-center gap-2 text-meta text-content-muted">
              <IconScan className="size-4" /> No tours yet.
            </li>
          ) : null}
        </ul>
      </CardBody>
    </Card>
  );
}
