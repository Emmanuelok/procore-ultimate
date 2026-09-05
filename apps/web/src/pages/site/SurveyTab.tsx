/**
 * SURVEY CONTROL AND SETTING OUT (#1081).
 *
 * A control point that has moved further than its own stated accuracy is
 * marked disturbed, and setting out cannot then be recorded against it. A
 * setting-out record is checked by someone other than the person who set the
 * work out, and approved by a third — the platform refuses the shortcuts.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge, Button, Card, CardBody, Drawer, Field, Input, Select, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus, IconRuler } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  ReasonList,
  RefusalNotice,
  SETTING_OUT_TONE,
  SectionHeading,
  dateTime,
  labelize,
  num,
  useAction,
  useResource,
  type ListResponse,
  type SettingOutRow,
  type SiteLookups,
  type SurveyPointRow,
} from "./siteShared";

export default function SurveyTab({ projectId, lookups, onChanged }: { projectId: string; lookups: SiteLookups; onChanged: () => void }) {
  const base = `/api/v1/projects/${projectId}/site`;
  const points = useResource<ListResponse<SurveyPointRow>>(`${base}/survey-points?pageSize=200`);
  const records = useResource<ListResponse<SettingOutRow>>(`${base}/setting-out?pageSize=200`);
  const action = useAction();
  const [pointOpen, setPointOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);

  const pointColumns = useMemo<DataColumns<SurveyPointRow>>(
    () => [
      { id: "pointRef", header: "Point", accessor: "pointRef", type: "text", sticky: "start", width: 120 },
      { id: "kind", header: "Kind", accessor: "kind", type: "status", width: 140, groupable: true, cell: ({ row }) => labelize(row.kind) },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={row.status === "active" ? "success" : row.status === "disturbed" ? "warning" : "danger"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      { id: "easting", header: "Easting", accessor: (row) => row.easting ?? 0, type: "number", width: 120, cell: ({ row }) => (row.easting === null ? EM_DASH : num(row.easting, 3)) },
      { id: "northing", header: "Northing", accessor: (row) => row.northing ?? 0, type: "number", width: 120, cell: ({ row }) => (row.northing === null ? EM_DASH : num(row.northing, 3)) },
      { id: "elevation", header: "Level", accessor: (row) => row.elevation ?? 0, type: "number", width: 100, cell: ({ row }) => (row.elevation === null ? EM_DASH : num(row.elevation, 3)) },
      {
        id: "accuracyMm",
        header: "Stated accuracy",
        accessor: (row) => row.accuracyMm ?? 0,
        type: "number",
        width: 150,
        cell: ({ row }) => (row.accuracyMm === null ? <span className="italic text-content-subtle">not stated</span> : `${num(row.accuracyMm)} mm`),
      },
      {
        id: "lastDeltaMm",
        header: "Last check",
        accessor: (row) => row.lastDeltaMm ?? 0,
        type: "number",
        width: 170,
        cell: ({ row }) =>
          row.lastCheckedAt === null ? (
            <span className="italic text-content-subtle">never checked</span>
          ) : (
            <span className="tabular-nums">
              {num(row.lastDeltaMm ?? 0, 1)} mm · {dateTime(row.lastCheckedAt)}
            </span>
          ),
      },
      { id: "method", header: "Method", accessor: "method", type: "status", width: 130, groupable: true, cell: ({ row }) => labelize(row.method) },
    ],
    [],
  );

  const recordColumns = useMemo<DataColumns<SettingOutRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "description", header: "What was set out", accessor: "description", type: "text", width: 320 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={SETTING_OUT_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      { id: "controlPointRefs", header: "From control", accessor: (row) => row.controlPointRefs.join(", "), type: "text", width: 200 },
      { id: "toleranceMm", header: "Tolerance", accessor: (row) => row.toleranceMm ?? 0, type: "number", width: 110, cell: ({ row }) => (row.toleranceMm === null ? EM_DASH : `${num(row.toleranceMm)} mm`) },
      { id: "maxDeviationMm", header: "Measured", accessor: (row) => row.maxDeviationMm ?? 0, type: "number", width: 120, cell: ({ row }) => (row.maxDeviationMm === null ? EM_DASH : `${num(row.maxDeviationMm, 1)} mm`) },
      { id: "setOutAt", header: "Set out", accessor: (row) => row.setOutAt ?? "", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.setOutAt) },
      { id: "checkedAt", header: "Checked", accessor: (row) => row.checkedAt ?? "", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.checkedAt) },
      { id: "rejectionReason", header: "Rejected because", accessor: (row) => row.rejectionReason ?? "", type: "text", width: 300 },
    ],
    [],
  );

  async function checkPoint(row: SurveyPointRow) {
    const delta = window.prompt(`How far from the recorded position is ${row.pointRef}, in millimetres?`);
    if (delta === null || !Number.isFinite(Number(delta))) return;
    const r = await action.run("check-point", () =>
      api.post<SurveyPointRow & { verdict: string }>(`${base}/survey-points/${row.id}/check`, { deltaMm: Number(delta) }),
    );
    if (r) {
      toast.success(r.verdict);
      points.reload();
      onChanged();
    }
  }

  async function checkRecord(row: SettingOutRow, outcome: "checked" | "rejected") {
    const deviation = outcome === "checked" ? window.prompt("Measured maximum deviation (mm)?") : null;
    if (outcome === "checked" && (deviation === null || !Number.isFinite(Number(deviation)))) return;
    const rejectionReason = outcome === "rejected" ? window.prompt("What was wrong?") : null;
    if (outcome === "rejected" && !rejectionReason) return;
    const r = await action.run("check-record", () =>
      api.post<SettingOutRow>(`${base}/setting-out/${row.id}/check`, {
        outcome,
        ...(deviation !== null ? { maxDeviationMm: Number(deviation) } : {}),
        ...(rejectionReason ? { rejectionReason } : {}),
      }),
    );
    if (r) {
      toast.success(`${r.reference} ${labelize(r.status).toLowerCase()}`);
      records.reload();
      onChanged();
    }
  }

  async function approve(row: SettingOutRow) {
    const r = await action.run("approve", () => api.post<SettingOutRow>(`${base}/setting-out/${row.id}/approve`, {}));
    if (r) {
      toast.success(`${r.reference} approved`);
      records.reload();
      onChanged();
    }
  }

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

      <Card>
        <CardBody>
          <SectionHeading
            title="Survey control"
            hint="The project's spatial truth. A check that exceeds a point's own stated accuracy marks it disturbed, and setting out from a disturbed point is then refused."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setPointOpen(true)}>
                Add a point
              </Button>
            }
          />
          {points.error ? <LoadError message={points.error} onRetry={points.reload} /> : null}
          <DataTable
            data={points.data?.items ?? []}
            columns={pointColumns}
            getRowId={(row) => row.id}
            loading={points.loading && !points.data}
            height={360}
            stickyHeader
            filterRow
            exportFileName="survey-control"
            rowTone={(row) => (row.status === "disturbed" ? "warning" : row.status === "destroyed" ? "danger" : undefined)}
            rowActions={(row) => (
              <Button size="xs" variant="ghost" onClick={() => void checkPoint(row)}>
                Record a check
              </Button>
            )}
            empty={{
              title: "No control points",
              description: "Enter the control and benchmarks the site is set out from. Without them a setting-out record cites nothing.",
              action: (
                <Button size="sm" onClick={() => setPointOpen(true)}>
                  Add the first point
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading
            title="Setting out"
            hint="Two people, by design: the checker may never be the person who set the work out, and the approver may never be the checker."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setRecordOpen(true)}>
                Record setting out
              </Button>
            }
          />
          {records.error ? <LoadError message={records.error} onRetry={records.reload} /> : null}
          <DataTable
            data={records.data?.items ?? []}
            columns={recordColumns}
            getRowId={(row) => row.id}
            loading={records.loading && !records.data}
            height={400}
            stickyHeader
            filterRow
            exportFileName="setting-out"
            rowTone={(row) => (row.status === "rejected" ? "danger" : row.status === "set_out" ? "warning" : undefined)}
            rowActions={(row) => (
              <span className="flex gap-1">
                {row.status === "set_out" ? (
                  <>
                    <Button size="xs" variant="ghost" onClick={() => void checkRecord(row, "checked")}>
                      Pass check
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => void checkRecord(row, "rejected")}>
                      Reject
                    </Button>
                  </>
                ) : null}
                {row.status === "checked" ? (
                  <Button size="xs" variant="ghost" onClick={() => void approve(row)}>
                    Approve
                  </Button>
                ) : null}
              </span>
            )}
            empty={{
              icon: IconRuler,
              title: "No setting-out records",
              description: "Record what was set out, from which control, to what tolerance — then have somebody else check it.",
              action: (
                <Button size="sm" onClick={() => setRecordOpen(true)}>
                  Record the first
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <PointForm
        base={base}
        open={pointOpen}
        onClose={() => setPointOpen(false)}
        onCreated={() => {
          setPointOpen(false);
          points.reload();
          onChanged();
        }}
      />
      <SettingOutForm
        base={base}
        lookups={lookups}
        points={points.data?.items ?? []}
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        onCreated={() => {
          setRecordOpen(false);
          records.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function PointForm({ base, open, onClose, onCreated }: { base: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [pointRef, setPointRef] = useState("");
  const [kind, setKind] = useState("control");
  const [easting, setEasting] = useState("");
  const [northing, setNorthing] = useState("");
  const [elevation, setElevation] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [accuracyMm, setAccuracyMm] = useState("5");
  const [coordinateSystem, setCoordinateSystem] = useState("");
  const [method, setMethod] = useState("gnss");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { pointRef: pointRef.trim(), kind, method };
    for (const [key, value] of [
      ["easting", easting],
      ["northing", northing],
      ["elevation", elevation],
      ["lat", lat],
      ["lon", lon],
      ["accuracyMm", accuracyMm],
    ] as const) {
      if (value.trim()) payload[key] = Number(value);
    }
    if (coordinateSystem.trim()) payload["coordinateSystem"] = coordinateSystem.trim();
    const r = await action.run("create", () => api.post<SurveyPointRow>(`${base}/survey-points`, payload));
    if (r) {
      toast.success(`${r.pointRef} recorded`);
      setPointRef("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Add a control point" description="Grid coordinates or latitude/longitude — a point with neither cannot be set out from." size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Point reference" required>
            <Input value={pointRef} onChange={(e) => setPointRef(e.target.value)} required maxLength={60} />
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {["control", "benchmark", "setting_out", "as_built", "monitoring"].map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Easting">
            <Input type="number" step="0.001" value={easting} onChange={(e) => setEasting(e.target.value)} />
          </Field>
          <Field label="Northing">
            <Input type="number" step="0.001" value={northing} onChange={(e) => setNorthing(e.target.value)} />
          </Field>
          <Field label="Level">
            <Input type="number" step="0.001" value={elevation} onChange={(e) => setElevation(e.target.value)} />
          </Field>
          <Field label="Coordinate system">
            <Input value={coordinateSystem} onChange={(e) => setCoordinateSystem(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Latitude">
            <Input type="number" step="0.0000001" value={lat} onChange={(e) => setLat(e.target.value)} />
          </Field>
          <Field label="Longitude">
            <Input type="number" step="0.0000001" value={lon} onChange={(e) => setLon(e.target.value)} />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {["gnss", "total_station", "level", "scan", "tape"].map((m) => (
                <option key={m} value={m}>
                  {labelize(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Stated accuracy (mm)" hint="A check beyond this marks the point disturbed.">
            <Input type="number" min={0} value={accuracyMm} onChange={(e) => setAccuracyMm(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Add
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function SettingOutForm({
  base,
  lookups,
  points,
  open,
  onClose,
  onCreated,
}: {
  base: string;
  lookups: SiteLookups;
  points: SurveyPointRow[];
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [description, setDescription] = useState("");
  const [elementRef, setElementRef] = useState("");
  const [controlPointRefs, setControlPointRefs] = useState("");
  const [toleranceMm, setToleranceMm] = useState("10");
  const [method, setMethod] = useState("total_station");
  const [notes, setNotes] = useState("");

  const usable = points.filter((p) => p.status === "active");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      description: description.trim(),
      method,
      controlPointRefs: controlPointRefs
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    };
    if (elementRef.trim()) payload["elementRef"] = elementRef.trim();
    if (toleranceMm.trim()) payload["toleranceMm"] = Number(toleranceMm);
    if (notes.trim()) payload["notes"] = notes.trim();
    const r = await action.run("create", () => api.post<SettingOutRow>(`${base}/setting-out`, payload));
    if (r) {
      toast.success(`${r.reference} recorded — it now needs a check by someone else`);
      setDescription("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Record setting out" description="Control points must exist on this project and must not be disturbed." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <Field label="What was set out" required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={500} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Element reference">
            <Input value={elementRef} onChange={(e) => setElementRef(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {["total_station", "gnss", "level", "scan", "tape"].map((m) => (
                <option key={m} value={m}>
                  {labelize(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tolerance (mm)">
            <Input type="number" min={0} value={toleranceMm} onChange={(e) => setToleranceMm(e.target.value)} />
          </Field>
        </div>
        <Field label="Control points" hint={usable.length > 0 ? `Comma separated. Active on this project: ${usable.map((p) => p.pointRef).join(", ")}` : "No active control point exists on this project yet."}>
          <Input value={controlPointRefs} onChange={(e) => setControlPointRefs(e.target.value)} placeholder="CP01, CP02" />
        </Field>
        <Field label="Notes">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Record
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
