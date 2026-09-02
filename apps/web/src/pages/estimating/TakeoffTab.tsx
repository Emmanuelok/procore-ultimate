/**
 * TAKEOFF — layers, the scale calculator, and every measurement with the
 * geometry and the calibration it was taken at (#184–190).
 *
 * The record model is the product here. The SVG preview is a convenience —
 * what has to survive is the geometry, the scale, the factors and the
 * arithmetic that turned them into a quantity, and all four are on screen.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconRuler, IconTrash } from "../../ui/icons";
import {
  BasisList,
  DASH,
  GEOMETRY_KINDS,
  LENGTH_UNITS,
  LoadError,
  MEASUREMENT_TYPES,
  Row,
  dateTime,
  estimatingApi,
  num,
  titleCase,
  useAction,
  useResource,
  type Measurement,
  type Paginated,
  type TakeoffItem,
  type TakeoffLayer,
} from "./estimatingShared";

interface GeometryDraft {
  kind: string;
  points: Array<{ x: number; y: number }>;
  radius?: number;
  closed?: boolean;
}

const DEFAULT_POINTS = "0,0\n100,0\n100,100\n0,100";

function parsePoints(raw: string): Array<{ x: number; y: number }> {
  return raw
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [x, y] = line.split(/[, \t]+/);
      return { x: Number(x), y: Number(y) };
    })
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

export default function TakeoffTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<TakeoffItem | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const action = useAction();

  const layers = useResource<{ items: TakeoffLayer[] }>(
    `/api/v1/projects/${projectId}/takeoff/layers`,
  );
  const params = new URLSearchParams({ page: "1", pageSize: "300" });
  if (statusFilter.length > 0) params.set("status", statusFilter);
  const items = useResource<Paginated<TakeoffItem>>(
    `/api/v1/projects/${projectId}/takeoff/items?${params.toString()}`,
  );

  const layerName = useMemo(() => {
    const map = new Map<string, TakeoffLayer>();
    for (const l of layers.data?.items ?? []) map.set(l.id, l);
    return map;
  }, [layers.data]);

  const columns = useMemo<DataColumns<TakeoffItem>>(
    () => [
      {
        id: "name",
        header: "Measurement",
        accessor: "name",
        type: "text",
        width: 260,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            {row.colour ? (
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: row.colour }}
              />
            ) : null}
            <span className="truncate">{row.name}</span>
          </span>
        ),
      },
      {
        id: "layer",
        header: "Layer",
        accessor: (row) => (row.layerId ? (layerName.get(row.layerId)?.name ?? "") : ""),
        type: "text",
        width: 150,
        cell: ({ row }) =>
          row.layerId ? (layerName.get(row.layerId)?.name ?? DASH) : <span className="text-content-subtle">{DASH}</span>,
      },
      {
        id: "measurementType",
        header: "Measure",
        accessor: (row) => titleCase(row.measurementType),
        type: "text",
        width: 100,
      },
      {
        id: "quantity",
        header: "Quantity",
        accessor: "quantity",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => (
          <span className="font-semibold">
            {num(row.quantity, 3)} {row.unit}
          </span>
        ),
      },
      {
        id: "scale",
        header: "Scale",
        accessor: (row) => row.scaleLabel ?? "",
        type: "text",
        width: 130,
        cell: ({ row }) =>
          row.pixelsPerUnit === null ? (
            <Badge tone="warning" size="xs">
              Uncalibrated
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle">
              {row.scaleLabel ?? `${num(row.pixelsPerUnit, 3)}/${row.scaleUnit ?? "unit"}`}
            </span>
          ),
      },
      {
        id: "sheetNumber",
        header: "Sheet",
        accessor: (row) => row.sheetNumber ?? "",
        type: "text",
        width: 110,
      },
      { id: "costCode", header: "Cost code", accessor: (row) => row.costCode ?? "", type: "text", width: 110 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <Badge
            tone={row.status === "priced" ? "success" : row.status === "void" ? "neutral" : "info"}
            size="xs"
            dot
          >
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "createdAt",
        header: "Measured",
        accessor: "createdAt",
        type: "datetime",
        width: 160,
        cell: ({ row }) => dateTime(row.createdAt),
      },
    ],
    [layerName],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ScaleCalculator projectId={projectId} />
        </div>
        <LayerPanel projectId={projectId} layers={layers.data?.items ?? []} error={layers.error} onChanged={() => layers.reload()} />
      </div>

      <Card>
        <CardHeader
          title="Measurements"
          subtitle="Every takeoff keeps its geometry, its calibration and the arithmetic that produced the quantity, so it can be re-measured by anybody."
          actions={
            <div className="flex items-center gap-2">
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                size="sm"
                className="w-40"
              >
                <option value="">All statuses</option>
                <option value="measured">Measured</option>
                <option value="assigned">Assigned</option>
                <option value="priced">Priced</option>
                <option value="void">Void</option>
              </Select>
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                New measurement
              </Button>
            </div>
          }
        />
        <CardBody flush>
          {action.error ? (
            <div className="p-3">
              <Alert tone="danger" size="sm" onDismiss={action.clear}>
                {action.error}
              </Alert>
            </div>
          ) : null}
          {items.error ? (
            <div className="p-4">
              <LoadError message={items.error} onRetry={items.reload} />
            </div>
          ) : (
            <DataTable<TakeoffItem>
              tableId="estimating.takeoff"
              data={items.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={items.loading && !items.data}
              height={420}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "Nothing measured yet",
                description:
                  "Calibrate a sheet, draw the shape, and the quantity follows. A measurement without its scale is a number nobody can check.",
              }}
              onRowClick={({ row }) => setOpen(row)}
              aria-label="Takeoff measurements"
            />
          )}
        </CardBody>
      </Card>

      <TakeoffEditor
        projectId={projectId}
        open={creating}
        layers={layers.data?.items ?? []}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          items.reload();
          onChanged();
        }}
      />

      <TakeoffDrawer
        projectId={projectId}
        item={open}
        layers={layers.data?.items ?? []}
        onClose={() => setOpen(null)}
        onChanged={() => {
          items.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scale calculator                                                    */
/* ------------------------------------------------------------------ */

function ScaleCalculator({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<"reference" | "ratio">("reference");
  const [drawn, setDrawn] = useState("250");
  const [real, setReal] = useState("5");
  const [ratio, setRatio] = useState("50");
  const [unit, setUnit] = useState("m");
  const [result, setResult] = useState<{ pixelsPerUnit: number; label: string; explanation: string } | null>(
    null,
  );
  const action = useAction();

  async function calibrate() {
    const body =
      mode === "reference"
        ? { mode, drawnLength: Number(drawn), realLength: Number(real), unit }
        : { mode, ratio: Number(ratio), unit };
    const res = await action.run("cal", () => estimatingApi.calibrate(projectId, body));
    if (res) setResult(res);
  }

  return (
    <Card>
      <CardHeader
        icon={IconRuler}
        title="Scale calibration (#188)"
        subtitle="Work out how many drawing units make one building unit — from a dimension you know, or from the printed ratio. Nothing is written; copy the result onto a measurement."
      />
      <CardBody className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" variant={mode === "reference" ? "primary" : "secondary"} onClick={() => setMode("reference")}>
            From a known dimension
          </Button>
          <Button size="sm" variant={mode === "ratio" ? "primary" : "secondary"} onClick={() => setMode("ratio")}>
            From a printed ratio
          </Button>
        </div>
        {mode === "reference" ? (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Drawn length">
              <Input value={drawn} onChange={(e) => setDrawn(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Real length">
              <Input value={real} onChange={(e) => setReal(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Unit">
              <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
                {LENGTH_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ratio (1 : n)">
              <Input value={ratio} onChange={(e) => setRatio(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Unit">
              <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
                {LENGTH_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Button size="sm" onClick={() => void calibrate()} loading={action.busy === "cal"}>
          Calculate
        </Button>
        {result ? (
          <Alert tone="info" size="sm" title={`${num(result.pixelsPerUnit, 4)} drawing units per ${unit}`}>
            {result.explanation}
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Layers                                                              */
/* ------------------------------------------------------------------ */

function LayerPanel({
  projectId,
  layers,
  error,
  onChanged,
}: {
  projectId: string;
  layers: TakeoffLayer[];
  error: string | null;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [colour, setColour] = useState("#2563eb");
  const [costCode, setCostCode] = useState("");
  const [measurementType, setMeasurementType] = useState("");
  const action = useAction();

  return (
    <Card>
      <CardHeader
        title="Layers (#189)"
        subtitle="Colour-coded groups. A layer's cost code is inherited by everything drawn on it."
        actions={
          <Button size="sm" variant="secondary" icon={IconPlus} onClick={() => setAdding(true)}>
            Add
          </Button>
        }
      />
      <CardBody className="space-y-2">
        {error ? <LoadError message={error} onRetry={onChanged} /> : null}
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        {layers.length === 0 ? (
          <p className="text-meta text-content-subtle">
            No layers yet. They are optional — a measurement can carry its own cost code.
          </p>
        ) : (
          layers.map((l) => (
            <div key={l.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
              <span
                aria-hidden
                className="inline-block h-3 w-3 shrink-0 rounded-sm"
                style={{ backgroundColor: l.colour }}
              />
              <span className="flex-1 truncate text-meta text-content">{l.name}</span>
              <span className="text-2xs text-content-subtle">
                {l.costCode ?? DASH}
                {l.measurementType ? ` · ${titleCase(l.measurementType)}` : ""}
              </span>
              <Button
                size="xs"
                variant="ghost"
                iconOnly
                icon={IconTrash}
                aria-label={`Delete ${l.name}`}
                onClick={() =>
                  void action
                    .run(`d-${l.id}`, () => estimatingApi.deleteLayer(projectId, l.id))
                    .then((r) => {
                      if (r) onChanged();
                    })
                }
              />
            </div>
          ))
        )}
      </CardBody>

      <Modal
        open={adding}
        title="Add a takeoff layer"
        onClose={() => setAdding(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              loading={action.busy === "add"}
              disabled={name.trim().length === 0}
              onClick={() =>
                void action
                  .run("add", () =>
                    estimatingApi.createLayer(projectId, {
                      name,
                      colour,
                      costCode: costCode.trim().length > 0 ? costCode : null,
                      measurementType: measurementType.length > 0 ? measurementType : null,
                      sortOrder: layers.length + 1,
                    }),
                  )
                  .then((r) => {
                    if (r) {
                      setAdding(false);
                      setName("");
                      setCostCode("");
                      onChanged();
                    }
                  })
              }
            >
              Add
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="External walls" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Colour">
              <Input value={colour} onChange={(e) => setColour(e.target.value)} placeholder="#2563eb" />
            </Field>
            <Field label="Default cost code" optional>
              <Input value={costCode} onChange={(e) => setCostCode(e.target.value)} placeholder="04-2000" />
            </Field>
          </div>
          <Field label="Default measure" optional>
            <Select value={measurementType} onChange={(e) => setMeasurementType(e.target.value)}>
              <option value="">Any</option>
              {MEASUREMENT_TYPES.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Measurement editor                                                  */
/* ------------------------------------------------------------------ */

function TakeoffEditor({
  projectId,
  open,
  layers,
  onClose,
  onSaved,
}: {
  projectId: string;
  open: boolean;
  layers: TakeoffLayer[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [layerId, setLayerId] = useState("");
  const [measurementType, setMeasurementType] = useState("area");
  const [geometryKind, setGeometryKind] = useState("polygon");
  const [pointsRaw, setPointsRaw] = useState(DEFAULT_POINTS);
  const [radius, setRadius] = useState("");
  const [pixelsPerUnit, setPixelsPerUnit] = useState("10");
  const [scaleUnit, setScaleUnit] = useState("m");
  const [scaleLabel, setScaleLabel] = useState("");
  const [sheetNumber, setSheetNumber] = useState("");
  const [depth, setDepth] = useState("");
  const [height, setHeight] = useState("");
  const [deduction, setDeduction] = useState("0");
  const [multiplier, setMultiplier] = useState("1");
  const [manual, setManual] = useState("");
  const [costCode, setCostCode] = useState("");
  const [preview, setPreview] = useState<Measurement | null>(null);
  const action = useAction();

  useEffect(() => {
    if (!open) return;
    setName("");
    setPreview(null);
    setManual("");
  }, [open]);

  const geometry: GeometryDraft | null = useMemo(() => {
    if (manual.trim().length > 0) return null;
    const points = parsePoints(pointsRaw);
    const draft: GeometryDraft = { kind: geometryKind, points };
    if (geometryKind === "circle" && radius.trim().length > 0) draft.radius = Number(radius);
    return draft;
  }, [geometryKind, pointsRaw, radius, manual]);

  const body = useMemo(
    () => ({
      measurementType,
      geometry,
      pixelsPerUnit: pixelsPerUnit.trim().length > 0 ? Number(pixelsPerUnit) : null,
      scaleUnit,
      depth: depth.trim().length > 0 ? Number(depth) : null,
      height: height.trim().length > 0 ? Number(height) : null,
      deduction: Number(deduction) || 0,
      multiplier: Number(multiplier) || 1,
      manualRawValue: manual.trim().length > 0 ? Number(manual) : null,
    }),
    [measurementType, geometry, pixelsPerUnit, scaleUnit, depth, height, deduction, multiplier, manual],
  );

  async function runPreview() {
    const res = await action.run("preview", () => estimatingApi.measure(projectId, body));
    if (res) setPreview(res);
  }

  async function save() {
    const res = await action.run("save", () =>
      estimatingApi.createTakeoff(projectId, {
        ...body,
        name,
        layerId: layerId.length > 0 ? layerId : null,
        scaleLabel: scaleLabel.trim().length > 0 ? scaleLabel : null,
        sheetNumber: sheetNumber.trim().length > 0 ? sheetNumber : null,
        costCode: costCode.trim().length > 0 ? costCode : null,
      }),
    );
    if (res) {
      toast.success(`${res.name} measured — ${num(res.quantity, 3)} ${res.unit}`);
      onSaved();
    }
  }

  return (
    <Modal
      open={open}
      title="New measurement"
      description="Give the geometry in the sheet's own coordinates and the scale that converts it. Everything is re-derivable from what is stored."
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex justify-between gap-2">
          <Button variant="secondary" onClick={() => void runPreview()} loading={action.busy === "preview"}>
            Measure (no save)
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={action.busy === "save"} disabled={name.trim().length === 0}>
              Save
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Gable wall" />
          </Field>
          <Field label="Layer" optional>
            <Select value={layerId} onChange={(e) => setLayerId(e.target.value)}>
              <option value="">No layer</option>
              {layers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Measure">
            <Select value={measurementType} onChange={(e) => setMeasurementType(e.target.value)}>
              {MEASUREMENT_TYPES.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Shape">
            <Select value={geometryKind} onChange={(e) => setGeometryKind(e.target.value)}>
              {GEOMETRY_KINDS.map((g) => (
                <option key={g} value={g}>
                  {titleCase(g)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Units per building unit" hint="From the calculator">
            <Input value={pixelsPerUnit} onChange={(e) => setPixelsPerUnit(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Scale unit">
            <Select value={scaleUnit} onChange={(e) => setScaleUnit(e.target.value)}>
              {LENGTH_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Geometry"
          hint="One vertex per line as x,y in the sheet's coordinates. A rectangle takes two opposite corners; a circle takes a centre and a radius."
        >
          <Textarea value={pointsRaw} onChange={(e) => setPointsRaw(e.target.value)} rows={4} />
        </Field>
        {geometryKind === "circle" ? (
          <Field label="Radius (drawing units)">
            <Input value={radius} onChange={(e) => setRadius(e.target.value)} inputMode="decimal" />
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Depth" optional hint="Volume">
            <Input value={depth} onChange={(e) => setDepth(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Height" optional hint="Run → area">
            <Input value={height} onChange={(e) => setHeight(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Repeats">
            <Input value={multiplier} onChange={(e) => setMultiplier(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Deduction" hint="Openings, in the quantity unit">
            <Input value={deduction} onChange={(e) => setDeduction(e.target.value)} inputMode="decimal" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Sheet" optional>
            <Input value={sheetNumber} onChange={(e) => setSheetNumber(e.target.value)} placeholder="A-201" />
          </Field>
          <Field label="Scale label" optional>
            <Input value={scaleLabel} onChange={(e) => setScaleLabel(e.target.value)} placeholder="1:100" />
          </Field>
          <Field label="Cost code" optional>
            <Input value={costCode} onChange={(e) => setCostCode(e.target.value)} placeholder="04-2000" />
          </Field>
        </div>
        <Field
          label="Or enter the quantity directly"
          optional
          hint="A legitimate takeoff — 32 doors counted on site — that still carries its factors."
        >
          <Input value={manual} onChange={(e) => setManual(e.target.value)} inputMode="decimal" />
        </Field>

        {preview ? (
          <div className="rounded-md border border-border bg-surface-sunken p-3">
            <div className="text-body font-semibold text-content">
              {num(preview.quantity, 4)} {preview.unit}
            </div>
            <div className="text-2xs text-content-subtle">
              Raw measure {num(preview.rawValue, 4)} {preview.unit}
              {preview.perimeter !== null ? ` · perimeter ${num(preview.perimeter, 3)}` : ""}
            </div>
            <BasisList lines={preview.basis} warnings={preview.warnings} className="mt-2" />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Detail drawer                                                       */
/* ------------------------------------------------------------------ */

function TakeoffDrawer({
  projectId,
  item,
  layers,
  onClose,
  onChanged,
}: {
  projectId: string;
  item: TakeoffItem | null;
  layers: TakeoffLayer[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [multiplier, setMultiplier] = useState("1");
  const [deduction, setDeduction] = useState("0");
  const [warnings, setWarnings] = useState<string[]>([]);
  const action = useAction();

  useEffect(() => {
    if (item) {
      setMultiplier(String(item.multiplier));
      setDeduction(String(item.deduction));
      setWarnings([]);
    }
  }, [item]);

  const detail = useResource<TakeoffItem & { pricedOn: Array<{ id: string; estimateId: string; description: string; amount: number }> }>(
    item ? `/api/v1/projects/${projectId}/takeoff/items/${item.id}` : null,
  );

  const basis = (detail.data?.detail?.basis ?? item?.detail?.basis) as string[] | undefined;
  const measurementWarnings = (detail.data?.detail?.warnings ?? item?.detail?.warnings) as string[] | undefined;

  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      size="md"
      title={item ? item.name : "Measurement"}
      description={
        item ? `${titleCase(item.measurementType)} · ${num(item.quantity, 3)} ${item.unit}` : undefined
      }
    >
      {!item ? null : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}
          {warnings.length > 0 ? (
            <Alert tone="warning" size="sm" title="Re-measured">
              <ul className="list-disc space-y-0.5 pl-4">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <dl className="divide-y divide-border">
            <Row label="Quantity">
              <span className="font-semibold">
                {num(item.quantity, 4)} {item.unit}
              </span>
            </Row>
            <Row label="Raw measure">{num(item.rawValue, 4)}</Row>
            {item.perimeter !== null ? <Row label="Perimeter">{num(item.perimeter, 3)}</Row> : null}
            <Row label="Scale" hint={item.pixelsPerUnit === null ? "Uncalibrated — the measure is in drawing units" : undefined}>
              {item.pixelsPerUnit === null
                ? DASH
                : `${num(item.pixelsPerUnit, 4)} per ${item.scaleUnit ?? "unit"}${item.scaleLabel ? ` (${item.scaleLabel})` : ""}`}
            </Row>
            <Row label="Sheet">{item.sheetNumber ?? DASH}</Row>
            <Row label="Layer">
              {item.layerId ? (layers.find((l) => l.id === item.layerId)?.name ?? DASH) : DASH}
            </Row>
            <Row label="Cost code">{item.costCode ?? DASH}</Row>
            <Row label="Status">{titleCase(item.status)}</Row>
            <Row label="Measured">{dateTime(item.createdAt)}</Row>
          </dl>

          <BasisList lines={basis} warnings={measurementWarnings} />

          {item.geometry ? (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Geometry as recorded ({item.geometry.kind})
              </div>
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-surface-sunken p-2 text-2xs text-content">
                {JSON.stringify(item.geometry, null, 2)}
              </pre>
            </div>
          ) : null}

          {detail.data && detail.data.pricedOn.length > 0 ? (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Priced on {detail.data.pricedOn.length} estimate line
                {detail.data.pricedOn.length === 1 ? "" : "s"}
              </div>
              <Table dense>
                <thead>
                  <tr>
                    <Th>Line</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.pricedOn.map((l) => (
                    <tr key={l.id}>
                      <Td>{l.description}</Td>
                      <Td align="right">{num(l.amount, 2)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}

          <Card>
            <CardHeader title="Re-measure" subtitle="Changing a factor never re-prices an estimate line on its own — the change is reported so somebody accepts it." />
            <CardBody className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Repeats">
                  <Input value={multiplier} onChange={(e) => setMultiplier(e.target.value)} inputMode="decimal" />
                </Field>
                <Field label="Deduction">
                  <Input value={deduction} onChange={(e) => setDeduction(e.target.value)} inputMode="decimal" />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={action.busy === "patch"}
                  onClick={() =>
                    void action
                      .run("patch", () =>
                        estimatingApi.patchTakeoff(projectId, item.id, {
                          multiplier: Number(multiplier) || 1,
                          deduction: Number(deduction) || 0,
                        }),
                      )
                      .then((res) => {
                        if (res) {
                          setWarnings(res.warnings);
                          toast.success(`Now ${num(res.quantity, 3)} ${res.unit}`);
                          detail.reload();
                          onChanged();
                        }
                      })
                  }
                >
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={IconTrash}
                  loading={action.busy === "void"}
                  onClick={() =>
                    void action
                      .run("void", () => estimatingApi.voidTakeoff(projectId, item.id))
                      .then((res) => {
                        if (res) {
                          toast.success("Measurement voided");
                          onClose();
                          onChanged();
                        }
                      })
                  }
                >
                  Void
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </Drawer>
  );
}
