/**
 * GROUND CONDITIONS AND BURIED UTILITIES (#1082–1083).
 *
 * The investigation register holds one flagged BASELINE — the ground model
 * the contract was priced on — and every other hole is compared against it by
 * the engine, interval by interval. An interval the baseline is silent about
 * is recorded and explicitly NOT called a change.
 *
 * The strike register records the three controls (permit, survey, marks) for
 * every strike, so the pattern in their absence is visible at a glance.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardBody, Drawer, Field, Input, Select, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  GROUND_STATUS_TONE,
  KeyValue,
  LoadError,
  ReasonList,
  RefusalNotice,
  SEVERITY_TONE,
  SectionHeading,
  UTILITY_CONFIDENCE_TONE,
  dateTime,
  labelize,
  num,
  optionList,
  useAction,
  useResource,
  type GeotechRow,
  type GroundFindingRow,
  type ListResponse,
  type SiteLookups,
  type StrikeList,
  type StrikeRow,
  type UtilityRow,
} from "./siteShared";

type Panel = "geotech" | "findings" | "utilities" | "strikes";

export default function GroundTab({ projectId, lookups, onChanged }: { projectId: string; lookups: SiteLookups; onChanged: () => void }) {
  const [panel, setPanel] = useState<Panel>("geotech");
  const base = `/api/v1/projects/${projectId}/site`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { value: "geotech", label: "Investigations" },
            { value: "findings", label: "Ground findings" },
            { value: "utilities", label: "Buried services" },
            { value: "strikes", label: "Strikes" },
          ] as Array<{ value: Panel; label: string }>
        ).map((p) => (
          <Button key={p.value} size="xs" variant={panel === p.value ? "secondary" : "ghost"} onClick={() => setPanel(p.value)}>
            {p.label}
          </Button>
        ))}
      </div>
      {panel === "geotech" ? <GeotechPanel base={base} lookups={lookups} onChanged={onChanged} /> : null}
      {panel === "findings" ? <FindingsPanel base={base} onChanged={onChanged} /> : null}
      {panel === "utilities" ? <UtilitiesPanel base={base} onChanged={onChanged} /> : null}
      {panel === "strikes" ? <StrikesPanel base={base} lookups={lookups} onChanged={onChanged} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function GeotechPanel({ base, lookups, onChanged }: { base: string; lookups: SiteLookups; onChanged: () => void }) {
  const list = useResource<ListResponse<GeotechRow>>(`${base}/geotech?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [compareResult, setCompareResult] = useState<{
    findings: GroundFindingRow[];
    slicesCompared: number;
    slicesWithoutBaseline: number;
    replacedFindings: number;
    signalsRaised: number;
    reasons: string[];
    baseline: { reference: string; holeRef: string };
  } | null>(null);

  const columns = useMemo<DataColumns<GeotechRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "holeRef", header: "Hole", accessor: "holeRef", type: "text", width: 120 },
      { id: "kind", header: "Kind", accessor: "kind", type: "status", width: 140, groupable: true, cell: ({ row }) => labelize(row.kind) },
      {
        id: "isBaseline",
        header: "Role",
        accessor: (row) => (row.isBaseline === 1 ? "baseline" : "investigation"),
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) =>
          row.isBaseline === 1 ? (
            <Badge tone="highlight" size="xs" dot>
              baseline
            </Badge>
          ) : (
            <Badge tone="neutral" size="xs">
              investigation
            </Badge>
          ),
      },
      { id: "investigatedOn", header: "Date", accessor: (row) => row.investigatedOn ?? "", type: "date", width: 130 },
      { id: "depthM", header: "Depth (m)", accessor: (row) => row.depthM ?? 0, type: "number", width: 110, cell: ({ row }) => (row.depthM === null ? EM_DASH : num(row.depthM, 2)) },
      {
        id: "waterStrikeDepthM",
        header: "Water strike (m)",
        accessor: (row) => row.waterStrikeDepthM ?? 0,
        type: "number",
        width: 150,
        cell: ({ row }) => (row.waterStrikeDepthM === null ? <span className="italic text-content-subtle">none recorded</span> : num(row.waterStrikeDepthM, 2)),
      },
      { id: "strata", header: "Strata", accessor: (row) => row.strata.length, type: "number", width: 90 },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.status) },
    ],
    [],
  );

  async function compare(row: GeotechRow) {
    const r = await action.run("compare", () =>
      api.post<{
        findings: GroundFindingRow[];
        slicesCompared: number;
        slicesWithoutBaseline: number;
        replacedFindings: number;
        signalsRaised: number;
        reasons: string[];
        baseline: { reference: string; holeRef: string };
      }>(`${base}/geotech/${row.id}/compare`, {}),
    );
    if (r) {
      setCompareResult(r);
      toast.success(`${r.findings.length} finding(s) against ${r.baseline.reference}`);
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
            title="Geotechnical investigations"
            hint="Flag the tender-stage holes as the baseline ground model. Everything else is compared against them — and the comparison is arithmetic, not somebody's eye."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                Record a hole
              </Button>
            }
          />
          {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
          <DataTable
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={list.loading && !list.data}
            height={420}
            stickyHeader
            filterRow
            exportFileName="geotech-investigations"
            rowActions={(row) =>
              row.isBaseline === 1 ? null : (
                <Button size="xs" variant="ghost" loading={action.busy === "compare"} onClick={() => void compare(row)}>
                  Compare with baseline
                </Button>
              )
            }
            empty={{
              title: "No investigations",
              description: "Enter the baseline ground model first, then the holes sunk during the works. The difference between them is a ground-conditions claim in record form.",
              action: (
                <Button size="sm" onClick={() => setOpen(true)}>
                  Record the first hole
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      {compareResult ? (
        <Card>
          <CardBody>
            <SectionHeading title={`Comparison against ${compareResult.baseline.reference} (${compareResult.baseline.holeRef})`} />
            <KeyValue
              items={[
                { label: "Intervals compared", value: num(compareResult.slicesCompared) },
                { label: "Intervals the baseline is silent about", value: num(compareResult.slicesWithoutBaseline) },
                { label: "Findings", value: num(compareResult.findings.length) },
                { label: "Open findings replaced", value: num(compareResult.replacedFindings) },
                { label: "Signals raised", value: num(compareResult.signalsRaised) },
              ]}
            />
            <ReasonList reasons={compareResult.reasons} className="mt-2" />
            <ul className="mt-3 space-y-1.5 text-meta">
              {compareResult.findings.map((f) => (
                <li key={f.id} className="rounded-md border border-border-subtle px-3 py-1.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[f.severity] ?? "neutral"} size="xs" dot>
                      {labelize(f.severity)}
                    </Badge>
                    <span className="font-medium text-content">
                      {num(f.depthFromM ?? 0, 2)}–{num(f.depthToM ?? 0, 2)} m · {labelize(f.category)}
                    </span>
                    {f.differsFromBaseline === 0 ? (
                      <Badge tone="neutral" size="xs">
                        no baseline — not a change
                      </Badge>
                    ) : null}
                  </span>
                  <p className="mt-0.5 text-content-muted">{f.varianceNotes}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <GeotechForm
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

function GeotechForm({
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
  const [holeRef, setHoleRef] = useState("");
  const [kind, setKind] = useState("borehole");
  const [isBaseline, setIsBaseline] = useState(false);
  const [investigatedOn, setInvestigatedOn] = useState("");
  const [depthM, setDepthM] = useState("");
  const [waterStrikeDepthM, setWaterStrikeDepthM] = useState("");
  const [contractorVendorId, setContractorVendorId] = useState("");
  const [strata, setStrata] = useState("0, 2, Made ground, made_ground\n2, 6, Firm clay, clay, 20\n6, 12, Dense sand, sand, 40");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = strata
      .split("\n")
      .map((line) => line.split(",").map((p) => p.trim()))
      .filter((parts) => parts.length >= 3)
      .map((parts) => ({
        fromM: Number(parts[0]),
        toM: Number(parts[1]),
        description: parts[2]!,
        ...(parts[3] ? { soilType: parts[3] } : {}),
        ...(parts[4] && Number.isFinite(Number(parts[4])) ? { spt: Number(parts[4]) } : {}),
      }))
      .filter((s) => Number.isFinite(s.fromM) && Number.isFinite(s.toM));
    const payload: Record<string, unknown> = { holeRef: holeRef.trim(), kind, isBaseline, strata: parsed };
    if (investigatedOn) payload["investigatedOn"] = investigatedOn;
    if (depthM.trim()) payload["depthM"] = Number(depthM);
    if (waterStrikeDepthM.trim()) payload["waterStrikeDepthM"] = Number(waterStrikeDepthM);
    if (contractorVendorId) payload["contractorVendorId"] = contractorVendorId;
    const r = await action.run("create", () => api.post<GeotechRow>(`${base}/geotech`, payload));
    if (r) {
      toast.success(`${r.reference} recorded with ${r.strata.length} stratum/strata`);
      setHoleRef("");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Record an investigation"
      description="Strata: one per line as `from, to, description, soil type, SPT`. Intervals must not overlap — a borehole log describes one material per depth."
      size="md"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hole reference" required>
            <Input value={holeRef} onChange={(e) => setHoleRef(e.target.value)} required maxLength={60} />
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {["borehole", "trial_pit", "cpt", "window_sample", "probe", "monitoring_well", "geophysics"].map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role" hint="The baseline is the ground model the contract was priced on.">
            <Select value={isBaseline ? "baseline" : "investigation"} onChange={(e) => setIsBaseline(e.target.value === "baseline")}>
              <option value="investigation">Investigation during the works</option>
              <option value="baseline">Baseline ground model</option>
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={investigatedOn} onChange={(e) => setInvestigatedOn(e.target.value)} />
          </Field>
          <Field label="Depth (m)">
            <Input type="number" step="0.01" min={0} value={depthM} onChange={(e) => setDepthM(e.target.value)} />
          </Field>
          <Field label="Water strike (m)">
            <Input type="number" step="0.01" min={0} value={waterStrikeDepthM} onChange={(e) => setWaterStrikeDepthM(e.target.value)} />
          </Field>
          <Field label="Contractor">
            <Select value={contractorVendorId} onChange={(e) => setContractorVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Strata log">
          <Textarea rows={7} value={strata} onChange={(e) => setStrata(e.target.value)} />
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

/* ------------------------------------------------------------------ */

function FindingsPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<GroundFindingRow>>(`${base}/ground-findings?pageSize=200`);
  const action = useAction();

  const columns = useMemo<DataColumns<GroundFindingRow>>(
    () => [
      {
        id: "depth",
        header: "Depth (m)",
        accessor: (row) => row.depthFromM ?? 0,
        type: "number",
        sticky: "start",
        width: 130,
        cell: ({ row }) => `${num(row.depthFromM ?? 0, 2)}–${num(row.depthToM ?? 0, 2)}`,
      },
      { id: "category", header: "Category", accessor: "category", type: "status", width: 170, groupable: true, cell: ({ row }) => labelize(row.category) },
      { id: "severity", header: "Severity", accessor: "severity", type: "status", width: 120, groupable: true, cell: ({ row }) => <Badge tone={SEVERITY_TONE[row.severity] ?? "neutral"} size="xs" dot>{labelize(row.severity)}</Badge> },
      {
        id: "differsFromBaseline",
        header: "Against the baseline",
        accessor: (row) => (row.differsFromBaseline === 1 ? "differs" : "no baseline"),
        type: "status",
        width: 170,
        groupable: true,
        cell: ({ row }) =>
          row.differsFromBaseline === 1 ? (
            <Badge tone="warning" size="xs">
              differs
            </Badge>
          ) : (
            <Badge tone="neutral" size="xs" title="The baseline says nothing about this interval, so it is recorded but is not a change.">
              no baseline
            </Badge>
          ),
      },
      { id: "baselineDescription", header: "Baseline said", accessor: (row) => row.baselineDescription ?? "", type: "text", width: 240 },
      { id: "observedDescription", header: "Found", accessor: "observedDescription", type: "text", width: 260 },
      { id: "varianceNotes", header: "Because", accessor: (row) => row.varianceNotes ?? "", type: "text", width: 460 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={GROUND_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      { id: "detectedAt", header: "Detected", accessor: "detectedAt", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.detectedAt) },
    ],
    [],
  );

  async function assess(row: GroundFindingRow, status: string) {
    const assessmentNotes = window.prompt(`Record the assessment for ${labelize(row.category)} at ${row.depthFromM}–${row.depthToM} m:`);
    if (!assessmentNotes) return;
    const r = await action.run("assess", () => api.post<GroundFindingRow>(`${base}/ground-findings/${row.id}/assess`, { status, assessmentNotes }));
    if (r) {
      toast.success(`Finding ${labelize(r.status).toLowerCase()}`);
      list.reload();
      onChanged();
    }
  }

  return (
    <Card>
      <CardBody>
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <SectionHeading
          title="Ground findings"
          hint="Produced by the comparison engine, one per differing depth interval. A finding somebody has assessed or claimed survives a re-run; only untouched ones are replaced."
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
          exportFileName="ground-findings"
          rowTone={(row) => (row.severity === "critical" || row.severity === "high" ? "danger" : undefined)}
          rowActions={(row) =>
            row.status === "closed" ? null : (
              <span className="flex gap-1">
                <Button size="xs" variant="ghost" onClick={() => void assess(row, "assessed")}>
                  Assess
                </Button>
                <Button size="xs" variant="ghost" onClick={() => void assess(row, "claimed")}>
                  Claim
                </Button>
              </span>
            )
          }
          empty={{
            title: "No ground findings",
            description: "Run a comparison from the Investigations panel. If the ground matches the baseline, that is the finding.",
          }}
        />
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function UtilitiesPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<UtilityRow>>(`${base}/utilities?pageSize=200`);
  const [open, setOpen] = useState(false);

  const columns = useMemo<DataColumns<UtilityRow>>(
    () => [
      { id: "serviceRef", header: "Ref", accessor: "serviceRef", type: "text", sticky: "start", width: 120 },
      { id: "utilityType", header: "Type", accessor: "utilityType", type: "status", width: 150, groupable: true, cell: ({ row }) => labelize(row.utilityType) },
      { id: "ownerName", header: "Owner", accessor: (row) => row.ownerName ?? "", type: "text", width: 180 },
      { id: "specification", header: "Spec", accessor: (row) => row.specification ?? "", type: "text", width: 160 },
      { id: "depthM", header: "Depth (m)", accessor: (row) => row.depthM ?? 0, type: "number", width: 110, cell: ({ row }) => (row.depthM === null ? EM_DASH : num(row.depthM, 2)) },
      { id: "detectionMethod", header: "Detected by", accessor: "detectionMethod", type: "status", width: 160, groupable: true, cell: ({ row }) => labelize(row.detectionMethod) },
      {
        id: "confidence",
        header: "Confidence",
        accessor: "confidence",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={UTILITY_CONFIDENCE_TONE[row.confidence] ?? "neutral"} size="xs" dot>
            {labelize(row.confidence)}
          </Badge>
        ),
      },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.status) },
      { id: "markValidUntil", header: "Marks valid until", accessor: (row) => row.markValidUntil ?? "", type: "date", width: 160 },
    ],
    [],
  );

  return (
    <Card>
      <CardBody>
        <SectionHeading
          title="Buried services"
          hint="A service is only `verified` when a survey verified it. Recording one as verified on the strength of utility records alone is refused — that is how people dig into live cables."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
              Record a service
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
          exportFileName="buried-services"
          rowTone={(row) => (row.confidence === "unknown" && row.status === "live" ? "danger" : undefined)}
          empty={{
            title: "No buried services recorded",
            description: "Record what is under the ground and how well it is known. An excavation permit will not go active without a survey behind it.",
            action: (
              <Button size="sm" onClick={() => setOpen(true)}>
                Record the first
              </Button>
            ),
          }}
        />
        <UtilityForm
          base={base}
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

function UtilityForm({ base, open, onClose, onCreated }: { base: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [serviceRef, setServiceRef] = useState("");
  const [utilityType, setUtilityType] = useState("electricity");
  const [ownerName, setOwnerName] = useState("");
  const [specification, setSpecification] = useState("");
  const [depthM, setDepthM] = useState("");
  const [detectionMethod, setDetectionMethod] = useState("gpr");
  const [confidence, setConfidence] = useState("probable");
  const [status, setStatus] = useState("live");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { serviceRef: serviceRef.trim(), utilityType, detectionMethod, confidence, status };
    if (ownerName.trim()) payload["ownerName"] = ownerName.trim();
    if (specification.trim()) payload["specification"] = specification.trim();
    if (depthM.trim()) payload["depthM"] = Number(depthM);
    const r = await action.run("create", () => api.post<UtilityRow>(`${base}/utilities`, payload));
    if (r) {
      toast.success(`${r.serviceRef} recorded`);
      setServiceRef("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Record a buried service" size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Service reference" required>
            <Input value={serviceRef} onChange={(e) => setServiceRef(e.target.value)} required maxLength={60} />
          </Field>
          <Field label="Type">
            <Select value={utilityType} onChange={(e) => setUtilityType(e.target.value)}>
              {["electricity", "gas", "water", "telecom", "sewer", "fuel", "district_heating", "signalling", "unknown"].map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Owner">
            <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Specification">
            <Input value={specification} onChange={(e) => setSpecification(e.target.value)} maxLength={300} placeholder="11kV, 150 mm PE…" />
          </Field>
          <Field label="Depth (m)">
            <Input type="number" step="0.01" min={0} value={depthM} onChange={(e) => setDepthM(e.target.value)} />
          </Field>
          <Field label="Detected by">
            <Select value={detectionMethod} onChange={(e) => setDetectionMethod(e.target.value)}>
              {["gpr", "electromagnetic", "records", "trial_hole", "as_built", "vacuum_excavation"].map((m) => (
                <option key={m} value={m}>
                  {labelize(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Confidence">
            <Select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
              {["verified", "probable", "indicative", "unknown"].map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {["live", "isolated", "abandoned", "diverted", "unknown"].map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
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

/* ------------------------------------------------------------------ */

function StrikesPanel({ base, lookups, onChanged }: { base: string; lookups: SiteLookups; onChanged: () => void }) {
  const list = useResource<StrikeList>(`${base}/strikes?pageSize=200`);
  const services = useResource<ListResponse<UtilityRow>>(`${base}/utilities?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);

  const columns = useMemo<DataColumns<StrikeRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "occurredAt", header: "Occurred", accessor: "occurredAt", type: "datetime", width: 175, cell: ({ row }) => dateTime(row.occurredAt) },
      { id: "utilityType", header: "Service", accessor: "utilityType", type: "status", width: 140, groupable: true, cell: ({ row }) => labelize(row.utilityType) },
      {
        id: "severity",
        header: "Severity",
        accessor: "severity",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={row.severity === "major" ? "danger" : row.severity === "significant" ? "warning" : "neutral"} size="xs" dot>
            {labelize(row.severity)}
          </Badge>
        ),
      },
      {
        id: "controls",
        header: "Controls in place",
        accessor: (row) => row.permitInPlace + row.scanCompleted + row.marksPresent,
        type: "number",
        width: 230,
        cell: ({ row }) => (
          <span className="flex gap-1">
            <Badge tone={row.permitInPlace === 1 ? "success" : "danger"} size="xs">
              permit
            </Badge>
            <Badge tone={row.scanCompleted === 1 ? "success" : "danger"} size="xs">
              survey
            </Badge>
            <Badge tone={row.marksPresent === 1 ? "success" : "danger"} size="xs">
              marks
            </Badge>
          </span>
        ),
      },
      { id: "injuries", header: "Injuries", accessor: "injuries", type: "number", width: 100 },
      { id: "operativeName", header: "Operative", accessor: (row) => row.operativeName ?? "", type: "text", width: 170 },
      { id: "plantType", header: "Plant", accessor: (row) => row.plantType ?? "", type: "text", width: 150 },
      { id: "rootCause", header: "Root cause", accessor: (row) => row.rootCause ?? "", type: "text", width: 340 },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.status) },
    ],
    [],
  );

  async function close(row: StrikeRow) {
    const rootCause = window.prompt("Root cause?");
    if (!rootCause) return;
    const r = await action.run("close", () => api.post<StrikeRow>(`${base}/strikes/${row.id}/close`, { rootCause }));
    if (r) {
      toast.success(`${r.reference} closed`);
      list.reload();
      onChanged();
    }
  }

  const c = list.data?.controls;

  return (
    <div className="space-y-3">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {c && c.total > 0 ? (
        <Alert tone={c.withPermit < c.total || c.withScan < c.total ? "warning" : "info"} title="The three controls, across every strike on this site">
          Permit in place on {c.withPermit} of {c.total}; a survey had been done on {c.withScan} of {c.total}; marks were present on {c.withMarks} of {c.total}. The
          pattern in what is missing is the finding.
        </Alert>
      ) : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Utility strikes and near misses"
            hint="Every strike records whether a permit, a survey and marks were in place. A near miss with two controls missing is treated as seriously as a strike with all three."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                Report a strike
              </Button>
            }
          />
          {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
          <DataTable
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={list.loading && !list.data}
            height={420}
            stickyHeader
            filterRow
            exportFileName="utility-strikes"
            rowTone={(row) => (row.severity === "major" || row.injuries > 0 ? "danger" : undefined)}
            rowActions={(row) =>
              row.status === "closed" ? null : (
                <Button size="xs" variant="ghost" onClick={() => void close(row)}>
                  Close
                </Button>
              )
            }
            empty={{
              title: "No strikes or near misses",
              description: "Report every near miss, not only the strikes: the near misses are where the missing controls show up first.",
              action: (
                <Button size="sm" onClick={() => setOpen(true)}>
                  Report the first
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <StrikeForm
        base={base}
        lookups={lookups}
        services={services.data?.items ?? []}
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

function StrikeForm({
  base,
  lookups,
  services,
  open,
  onClose,
  onCreated,
}: {
  base: string;
  lookups: SiteLookups;
  services: UtilityRow[];
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [occurredAt, setOccurredAt] = useState("");
  const [utilityType, setUtilityType] = useState("electricity");
  const [serviceId, setServiceId] = useState("");
  const [severity, setSeverity] = useState("near_miss");
  const [operativeName, setOperativeName] = useState("");
  const [plantType, setPlantType] = useState("");
  const [contractorVendorId, setContractorVendorId] = useState("");
  const [permitInPlace, setPermitInPlace] = useState(false);
  const [scanCompleted, setScanCompleted] = useState(false);
  const [marksPresent, setMarksPresent] = useState(false);
  const [injuries, setInjuries] = useState("0");
  const [locationDescription, setLocationDescription] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
      utilityType,
      severity,
      permitInPlace,
      scanCompleted,
      marksPresent,
      injuries: Number(injuries) || 0,
    };
    if (serviceId) payload["serviceId"] = serviceId;
    if (operativeName.trim()) payload["operativeName"] = operativeName.trim();
    if (plantType.trim()) payload["plantType"] = plantType.trim();
    if (contractorVendorId) payload["contractorVendorId"] = contractorVendorId;
    if (locationDescription.trim()) payload["locationDescription"] = locationDescription.trim();
    const r = await action.run("create", () => api.post<StrikeRow & { controlsMissing: string[] }>(`${base}/strikes`, payload));
    if (r) {
      toast.success(r.controlsMissing.length > 0 ? `${r.reference} — controls missing: ${r.controlsMissing.join("; ")}` : `${r.reference} reported`);
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Report a utility strike" description="Be honest about the three controls: the register exists to show the pattern in what was missing." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <ReasonList reasons={lookups.notes} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Occurred at">
            <Input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
          </Field>
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {["near_miss", "minor", "significant", "major"].map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Service type">
            <Select value={utilityType} onChange={(e) => setUtilityType(e.target.value)}>
              {["electricity", "gas", "water", "telecom", "sewer", "fuel", "district_heating", "signalling", "unknown"].map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Recorded service">
            <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {optionList(services.map((s) => ({ id: s.id, name: `${s.serviceRef} — ${labelize(s.utilityType)}` })), (s) => s.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Operative">
            <Input value={operativeName} onChange={(e) => setOperativeName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Plant">
            <Input value={plantType} onChange={(e) => setPlantType(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Contractor">
            <Select value={contractorVendorId} onChange={(e) => setContractorVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Injuries">
            <Input type="number" min={0} value={injuries} onChange={(e) => setInjuries(e.target.value)} />
          </Field>
        </div>
        <Field label="Where">
          <Input value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)} maxLength={500} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Permit in place">
            <Select value={permitInPlace ? "yes" : "no"} onChange={(e) => setPermitInPlace(e.target.value === "yes")}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </Select>
          </Field>
          <Field label="Survey done">
            <Select value={scanCompleted ? "yes" : "no"} onChange={(e) => setScanCompleted(e.target.value === "yes")}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </Select>
          </Field>
          <Field label="Marks present">
            <Select value={marksPresent ? "yes" : "no"} onChange={(e) => setMarksPresent(e.target.value === "yes")}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Report
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
