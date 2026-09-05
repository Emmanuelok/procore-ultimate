/**
 * WEATHER & ENVIRONMENT (#1074–1076, #1084).
 *
 * The archive, the contract baseline that defines "adverse", the exceptional
 * weather analysis a claim is built on — and the log of everything else the
 * environment did to the site: tremors, tides, floods, dust, noise, spills.
 *
 * Coverage is stated on every analysis: a missing day is a gap in the record,
 * never a fair-weather day.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardBody, Drawer, Field, Input, Select, Textarea } from "../../ui";
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
  SEVERITY_TONE,
  SectionHeading,
  dateTime,
  labelize,
  num,
  optionList,
  useAction,
  useResource,
  type EnvironmentalEventRow,
  type ListResponse,
  type WeatherAnalysisDetail,
  type WeatherAnalysisRow,
  type WeatherBaselineRow,
  type WeatherObservationRow,
} from "./siteShared";

const METRICS = [
  "precipitation_mm",
  "temp_min_c",
  "temp_max_c",
  "wind_mean_kph",
  "wind_gust_kph",
  "snowfall_mm",
  "visibility_m",
  "sea_state_m",
  "humidity_pct",
];

const CATEGORIES = [
  "seismic",
  "tidal",
  "flood",
  "storm",
  "wind",
  "lightning",
  "dust",
  "noise",
  "vibration",
  "spill",
  "wildlife",
  "air_quality",
  "ground_movement",
  "other",
];

type Panel = "archive" | "baselines" | "analyses" | "events";

export default function WeatherTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [panel, setPanel] = useState<Panel>("archive");
  const base = `/api/v1/projects/${projectId}/site`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { value: "archive", label: "Daily archive" },
            { value: "baselines", label: "Baselines" },
            { value: "analyses", label: "Exceptional weather" },
            { value: "events", label: "Environmental events" },
          ] as Array<{ value: Panel; label: string }>
        ).map((p) => (
          <Button key={p.value} size="xs" variant={panel === p.value ? "secondary" : "ghost"} onClick={() => setPanel(p.value)}>
            {p.label}
          </Button>
        ))}
      </div>
      {panel === "archive" ? <ArchivePanel base={base} onChanged={onChanged} /> : null}
      {panel === "baselines" ? <BaselinePanel base={base} onChanged={onChanged} /> : null}
      {panel === "analyses" ? <AnalysisPanel base={base} onChanged={onChanged} /> : null}
      {panel === "events" ? <EventsPanel base={base} onChanged={onChanged} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ArchivePanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<WeatherObservationRow>>(`${base}/weather/observations?pageSize=200`);
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [captureFrom, setCaptureFrom] = useState("");
  const [captureTo, setCaptureTo] = useState("");
  const [captureNotes, setCaptureNotes] = useState<string[]>([]);

  const columns = useMemo<DataColumns<WeatherObservationRow>>(
    () => [
      { id: "observedOn", header: "Date", accessor: "observedOn", type: "date", sticky: "start", width: 120 },
      { id: "source", header: "Source", accessor: "source", type: "status", width: 120, groupable: true, cell: ({ row }) => labelize(row.source) },
      { id: "precipitationMm", header: "Rain (mm)", accessor: (row) => row.precipitationMm ?? 0, type: "number", width: 110, cell: ({ row }) => (row.precipitationMm === null ? EM_DASH : num(row.precipitationMm, 1)) },
      { id: "snowfallMm", header: "Snow (mm)", accessor: (row) => row.snowfallMm ?? 0, type: "number", width: 110, cell: ({ row }) => (row.snowfallMm === null ? EM_DASH : num(row.snowfallMm, 1)) },
      { id: "windGustKph", header: "Gust (km/h)", accessor: (row) => row.windGustKph ?? 0, type: "number", width: 120, cell: ({ row }) => (row.windGustKph === null ? EM_DASH : num(row.windGustKph)) },
      { id: "tempMinC", header: "Min °C", accessor: (row) => row.tempMinC ?? 0, type: "number", width: 100, cell: ({ row }) => (row.tempMinC === null ? EM_DASH : num(row.tempMinC, 1)) },
      { id: "tempMaxC", header: "Max °C", accessor: (row) => row.tempMaxC ?? 0, type: "number", width: 100, cell: ({ row }) => (row.tempMaxC === null ? EM_DASH : num(row.tempMaxC, 1)) },
      {
        id: "adverse",
        header: "Verdict",
        accessor: (row) => (row.adverse === null ? "untested" : row.adverse === 1 ? "adverse" : "fair"),
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) =>
          row.adverse === null ? (
            <Badge tone="neutral" size="xs" title="No analysis has tested this day against a baseline yet.">
              untested
            </Badge>
          ) : row.adverse === 1 ? (
            <Badge tone="danger" size="xs" title={row.adverseReasons.join(" ")}>
              adverse
            </Badge>
          ) : (
            <Badge tone="success" size="xs">
              within limits
            </Badge>
          ),
      },
      {
        id: "workStopped",
        header: "Site reported",
        accessor: (row) => (row.workStopped === 1 ? "stopped" : ""),
        type: "text",
        width: 200,
        cell: ({ row }) =>
          row.workStopped === 1 ? (
            <span>
              stopped{row.hoursLost !== null ? ` · ${num(row.hoursLost, 1)} h lost` : ""}
            </span>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      { id: "adverseReasons", header: "Because", accessor: (row) => row.adverseReasons.join(" "), type: "text", width: 460 },
    ],
    [],
  );

  async function capture(e: FormEvent) {
    e.preventDefault();
    const r = await action.run("capture", () =>
      api.post<{ inserted: number; updated: number; provider: string; reasons: string[] }>(`${base}/weather/capture`, {
        from: captureFrom,
        to: captureTo,
      }),
    );
    if (r) {
      setCaptureNotes(r.reasons);
      if (r.inserted + r.updated > 0) {
        toast.success(`${r.inserted} new and ${r.updated} updated observation(s) from ${r.provider}`);
        list.reload();
        onChanged();
      } else {
        toast.message("Nothing was captured — see the reasons below.");
      }
    }
  }

  return (
    <div className="space-y-3">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Pull from the weather provider"
            hint="A graceful no-op: with no coordinates on the project, no network, or a bad response, nothing is written and the reason is shown. A manual observation for the same day is never overwritten."
          />
          <form onSubmit={(e) => void capture(e)} className="flex flex-wrap items-end gap-2">
            <Field label="From">
              <Input type="date" value={captureFrom} onChange={(e) => setCaptureFrom(e.target.value)} required />
            </Field>
            <Field label="To">
              <Input type="date" value={captureTo} onChange={(e) => setCaptureTo(e.target.value)} required />
            </Field>
            <Button type="submit" size="sm" variant="secondary" loading={action.busy === "capture"}>
              Capture
            </Button>
          </form>
          <ReasonList reasons={captureNotes} className="mt-2" />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading
            title="Daily weather archive"
            hint="One row per date and source. A day the archive does not hold is a gap, and every analysis says how many gaps it found."
            actions={
              <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
                Record a day
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
            exportFileName="weather-archive"
            rowTone={(row) => (row.adverse === 1 ? "danger" : undefined)}
            empty={{
              title: "The weather archive is empty",
              description: "Record the site's daily observations, or pull them from the provider above. Without them no weather claim can be tested.",
              action: (
                <Button size="sm" onClick={() => setOpen(true)}>
                  Record the first day
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <ObservationForm
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

function ObservationForm({ base, open, onClose, onCreated }: { base: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [observedOn, setObservedOn] = useState("");
  const [precipitationMm, setPrecipitationMm] = useState("");
  const [windGustKph, setWindGustKph] = useState("");
  const [tempMinC, setTempMinC] = useState("");
  const [tempMaxC, setTempMaxC] = useState("");
  const [snowfallMm, setSnowfallMm] = useState("");
  const [workStopped, setWorkStopped] = useState(false);
  const [hoursLost, setHoursLost] = useState("");
  const [conditions, setConditions] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { observedOn, source: "manual", workStopped };
    for (const [key, value] of [
      ["precipitationMm", precipitationMm],
      ["windGustKph", windGustKph],
      ["tempMinC", tempMinC],
      ["tempMaxC", tempMaxC],
      ["snowfallMm", snowfallMm],
      ["hoursLost", hoursLost],
    ] as const) {
      if (value.trim()) payload[key] = Number(value);
    }
    if (conditions.trim()) payload["conditions"] = conditions.trim();
    const r = await action.run("create", () => api.post<{ total: number }>(`${base}/weather/observations`, payload));
    if (r) {
      toast.success("Observation recorded");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Record a day's weather" description="Leave a field blank rather than guessing: a metric the archive does not hold cannot breach a threshold, and the analysis says so." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Date" required>
          <Input type="date" value={observedOn} onChange={(e) => setObservedOn(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rainfall (mm)">
            <Input type="number" step="0.1" value={precipitationMm} onChange={(e) => setPrecipitationMm(e.target.value)} />
          </Field>
          <Field label="Snowfall (mm)">
            <Input type="number" step="0.1" value={snowfallMm} onChange={(e) => setSnowfallMm(e.target.value)} />
          </Field>
          <Field label="Maximum gust (km/h)">
            <Input type="number" step="1" value={windGustKph} onChange={(e) => setWindGustKph(e.target.value)} />
          </Field>
          <Field label="Conditions">
            <Input value={conditions} onChange={(e) => setConditions(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Minimum °C">
            <Input type="number" step="0.1" value={tempMinC} onChange={(e) => setTempMinC(e.target.value)} />
          </Field>
          <Field label="Maximum °C">
            <Input type="number" step="0.1" value={tempMaxC} onChange={(e) => setTempMaxC(e.target.value)} />
          </Field>
          <Field label="Hours lost">
            <Input type="number" step="0.5" min={0} max={24} value={hoursLost} onChange={(e) => setHoursLost(e.target.value)} />
          </Field>
          <Field label="Work stopped for weather">
            <Select value={workStopped ? "yes" : "no"} onChange={(e) => setWorkStopped(e.target.value === "yes")}>
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
            Record
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function BaselinePanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<WeatherBaselineRow>>(`${base}/weather/baselines?pageSize=100`);
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardBody>
        <SectionHeading
          title="Contract baselines"
          hint="What the contract calls adverse, and how many adverse days a normal month holds. Without the monthly figures the platform will count adverse days but refuses to call any of them exceptional."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
              Add a baseline
            </Button>
          }
        />
        {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
        <div className="space-y-3">
          {(list.data?.items ?? []).map((b) => (
            <div key={b.id} className="rounded-md border border-border-subtle p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-body font-semibold text-content">{b.name}</span>
                <span className="text-2xs uppercase tracking-wide text-content-subtle">
                  {labelize(b.source)}
                  {b.contractRef ? ` · ${b.contractRef}` : ""}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {b.thresholds.length === 0 ? (
                  <Badge tone="danger" size="xs">
                    no thresholds — nothing can be tested
                  </Badge>
                ) : (
                  b.thresholds.map((t, i) => (
                    <Badge key={i} tone="neutral" size="xs">
                      {t.label ?? labelize(t.metric)} {t.comparator === "gte" ? "≥" : t.comparator === "gt" ? ">" : t.comparator === "lte" ? "≤" : "<"} {t.value}
                    </Badge>
                  ))
                )}
              </div>
              <div className="mt-2 text-meta text-content-muted">
                {Object.keys(b.monthlyExpectedAdverseDays).length === 0 ? (
                  "No monthly expected adverse days — exceptional days cannot be derived from this baseline."
                ) : (
                  <>
                    Expected adverse days:{" "}
                    {Object.entries(b.monthlyExpectedAdverseDays)
                      .sort((a, c) => Number(a[0]) - Number(c[0]))
                      .map(([m, v]) => `M${m} ${v}`)
                      .join(" · ")}
                  </>
                )}
              </div>
            </div>
          ))}
          {(list.data?.items.length ?? 0) === 0 && !list.loading ? (
            <p className="text-meta text-content-muted">
              No baseline yet. Enter the thresholds the contract uses (for example rainfall ≥ 10 mm, gusts ≥ 60 km/h, minimum ≤ −2 °C) and the number of adverse days a normal month holds.
            </p>
          ) : null}
        </div>
        <BaselineForm
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

function BaselineForm({ base, open, onClose, onCreated }: { base: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [source, setSource] = useState("contract");
  const [contractRef, setContractRef] = useState("");
  const [thresholds, setThresholds] = useState("precipitation_mm gte 10 Rainfall\nwind_gust_kph gte 60 Gust\ntemp_min_c lte -2 Frost");
  const [monthly, setMonthly] = useState("1 3\n2 2.5\n3 2\n11 2.5\n12 3");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsedThresholds = thresholds
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 3 && METRICS.includes(parts[0] ?? ""))
      .map((parts) => ({
        metric: parts[0]!,
        comparator: parts[1]!,
        value: Number(parts[2]),
        ...(parts.length > 3 ? { label: parts.slice(3).join(" ") } : {}),
      }));
    const parsedMonthly: Record<string, number> = {};
    for (const line of monthly.split("\n")) {
      const [month, value] = line.trim().split(/\s+/);
      if (!month || !value) continue;
      if (Number.isFinite(Number(month)) && Number.isFinite(Number(value))) parsedMonthly[String(Number(month))] = Number(value);
    }
    const payload: Record<string, unknown> = { name: name.trim(), source, thresholds: parsedThresholds, monthlyExpectedAdverseDays: parsedMonthly };
    if (contractRef.trim()) payload["contractRef"] = contractRef.trim();
    const r = await action.run("create", () => api.post<WeatherBaselineRow>(`${base}/weather/baselines`, payload));
    if (r) {
      toast.success(`${r.name} saved with ${r.thresholds.length} threshold(s)`);
      setName("");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Add a weather baseline"
      description="Thresholds: one per line as `metric comparator value label`. Monthly expectations: one per line as `month days`."
      size="md"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              {["contract", "met_records", "manual", "provider"].map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contract reference">
            <Input value={contractRef} onChange={(e) => setContractRef(e.target.value)} maxLength={200} />
          </Field>
        </div>
        <Field label="Thresholds" hint={`Metrics: ${METRICS.join(", ")}. Comparators: gte, gt, lte, lt.`}>
          <Textarea rows={5} value={thresholds} onChange={(e) => setThresholds(e.target.value)} />
        </Field>
        <Field label="Expected adverse days per month" hint="Month number then days, e.g. `1 3.1`. Months you leave out cannot produce exceptional days.">
          <Textarea rows={5} value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Save
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function AnalysisPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<WeatherAnalysisRow>>(`${base}/weather/analyses?pageSize=100`);
  const baselines = useResource<ListResponse<WeatherBaselineRow>>(`${base}/weather/baselines?pageSize=100`);
  const action = useAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<WeatherAnalysisDetail>(openId ? `${base}/weather/analyses/${openId}` : null);
  const [baselineId, setBaselineId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  const columns = useMemo<DataColumns<WeatherAnalysisRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "period", header: "Period", accessor: (row) => `${row.periodStart} → ${row.periodEnd}`, type: "text", width: 220 },
      { id: "observedAdverseDays", header: "Adverse days", accessor: (row) => row.observedAdverseDays ?? 0, type: "number", width: 130, cell: ({ row }) => num(row.observedAdverseDays ?? 0, 2) },
      {
        id: "baselineAdverseDays",
        header: "Baseline",
        accessor: (row) => row.baselineAdverseDays ?? 0,
        type: "number",
        width: 130,
        cell: ({ row }) => <FigureCell value={row.baselineAdverseDays} reasons={row.reasons} render={(v) => num(v, 2)} />,
      },
      {
        id: "exceptionalDays",
        header: "Exceptional",
        accessor: (row) => row.exceptionalDays ?? 0,
        type: "number",
        width: 140,
        cell: ({ row }) => <FigureCell value={row.exceptionalDays} reasons={row.reasons} render={(v) => num(v, 2)} className="font-semibold" />,
      },
      {
        id: "coveragePercent",
        header: "Coverage",
        accessor: (row) => row.coveragePercent ?? 0,
        type: "number",
        width: 130,
        cell: ({ row }) => (
          <span className={`tabular-nums ${(row.coveragePercent ?? 0) < 90 ? "text-warning-fg" : ""}`}>
            {num(row.coveragePercent ?? 0, 1)}% ({row.daysObserved}/{row.daysInPeriod})
          </span>
        ),
      },
      { id: "hoursLost", header: "Hours lost", accessor: (row) => row.hoursLost ?? 0, type: "number", width: 120, cell: ({ row }) => <FigureCell value={row.hoursLost} reasons={row.reasons} render={(v) => num(v, 1)} /> },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 110, groupable: true, cell: ({ row }) => labelize(row.status) },
      { id: "generatedAt", header: "Generated", accessor: "generatedAt", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.generatedAt) },
    ],
    [],
  );

  async function run(e: FormEvent) {
    e.preventDefault();
    const r = await action.run("run", () =>
      api.post<WeatherAnalysisRow>(`${base}/weather/analyses`, { baselineId, periodStart, periodEnd }),
    );
    if (r) {
      toast.success(`${r.reference}: ${num(r.observedAdverseDays ?? 0, 2)} adverse day(s) observed`);
      list.reload();
      setOpenId(r.id);
      onChanged();
    }
  }

  async function issue(id: string) {
    const r = await action.run("issue", () => api.post<WeatherAnalysisRow>(`${base}/weather/analyses/${id}/issue`, {}));
    if (r) {
      toast.success(`${r.reference} issued`);
      list.reload();
      detail.reload();
    }
  }

  return (
    <div className="space-y-3">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <Card>
        <CardBody>
          <SectionHeading title="Run a comparison" hint="Compares the archive against a baseline over a period and stores the result as a numbered, claim-ready analysis." />
          <form onSubmit={(e) => void run(e)} className="flex flex-wrap items-end gap-2">
            <Field label="Baseline" required>
              <Select value={baselineId} onChange={(e) => setBaselineId(e.target.value)} required>
                {optionList(baselines.data?.items ?? [], (b) => b.name, "— choose a baseline —").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From" required>
              <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
            </Field>
            <Field label="To" required>
              <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
            </Field>
            <Button type="submit" size="sm" loading={action.busy === "run"} disabled={!baselineId}>
              Run
            </Button>
          </form>
          {(baselines.data?.items.length ?? 0) === 0 && !baselines.loading ? (
            <p className="mt-2 text-meta text-content-muted">There is no baseline to compare against yet. Add one on the Baselines panel first.</p>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading title="Exceptional-weather analyses" />
          {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
          <DataTable
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={list.loading && !list.data}
            height={380}
            stickyHeader
            exportFileName="exceptional-weather"
            onRowClick={({ row }) => setOpenId(row.id)}
            empty={{ title: "No analyses", description: "Run one above once the archive and a baseline are in place." }}
          />
        </CardBody>
      </Card>

      <Drawer
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={detail.data ? `${detail.data.reference} — exceptional weather` : "Analysis"}
        description={detail.data ? `${detail.data.periodStart} → ${detail.data.periodEnd} against ${detail.data.baseline?.name ?? "an unknown baseline"}` : undefined}
        size="lg"
      >
        {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
        {detail.data ? (
          <div className="space-y-4">
            <KeyValue
              items={[
                { label: "Days in period", value: num(detail.data.daysInPeriod) },
                { label: "Days observed", value: `${num(detail.data.daysObserved)} (${num(detail.data.coveragePercent ?? 0, 1)}% coverage)` },
                { label: "Adverse days observed", value: num(detail.data.observedAdverseDays ?? 0, 2) },
                { label: "Baseline adverse days", value: <FigureCell value={detail.data.baselineAdverseDays} reasons={detail.data.reasons} render={(v) => num(v, 2)} /> },
                { label: "Exceptional days", value: <FigureCell value={detail.data.exceptionalDays} reasons={detail.data.reasons} render={(v) => num(v, 2)} /> },
                { label: "Hours lost", value: <FigureCell value={detail.data.hoursLost} reasons={detail.data.reasons} render={(v) => num(v, 1)} /> },
              ]}
            />
            <ReasonList reasons={detail.data.reasons} />

            <div>
              <SectionHeading title="Month by month" hint="A mild month never pays for a wet one: exceptional days are floored at zero per month." />
              <table className="w-full text-meta">
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wide text-content-subtle">
                    <th className="py-1">Month</th>
                    <th className="py-1 text-right">Days</th>
                    <th className="py-1 text-right">Observed</th>
                    <th className="py-1 text-right">Expected</th>
                    <th className="py-1 text-right">Exceptional</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.byMonth.map((m) => (
                    <tr key={m.month} className="border-t border-border-subtle align-top">
                      <td className="py-1">{m.month}</td>
                      <td className="py-1 text-right tabular-nums">{num(m.days)}</td>
                      <td className="py-1 text-right tabular-nums">{num(m.observed)}</td>
                      <td className="py-1 text-right tabular-nums">{m.expected === null ? EM_DASH : num(m.expected, 2)}</td>
                      <td className="py-1 text-right tabular-nums font-medium">{m.exceptional === null ? EM_DASH : num(m.exceptional, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.data.byMonth.some((m) => m.reasons.length > 0) ? (
                <ReasonList reasons={detail.data.byMonth.flatMap((m) => m.reasons)} className="mt-2" />
              ) : null}
            </div>

            <div>
              <SectionHeading title="Every day counted, and the threshold it breached" />
              <ul className="space-y-1 text-meta">
                {detail.data.adverseDayDetail.length === 0 ? <li className="text-content-muted">No adverse day in this period.</li> : null}
                {detail.data.adverseDayDetail.map((d) => (
                  <li key={d.date} className="rounded-md border border-border-subtle px-3 py-1.5">
                    <span className="font-medium text-content">{d.date}</span>
                    {d.workStopped ? <Badge tone="warning" size="xs" className="ml-2">site stopped</Badge> : null}
                    {d.hoursLost !== null ? <span className="ml-2 text-2xs text-content-muted">{num(d.hoursLost, 1)} h lost</span> : null}
                    <ReasonList reasons={d.reasons} className="mt-1" />
                  </li>
                ))}
              </ul>
            </div>

            {detail.data.status === "draft" ? (
              <div className="flex justify-end">
                <Button loading={action.busy === "issue"} onClick={() => void issue(detail.data!.id)}>
                  Issue this analysis
                </Button>
              </div>
            ) : (
              <Alert tone="info" title={`Issued ${dateTime(detail.data.issuedAt)}`}>
                An issued analysis is a fixed record. Re-run the comparison to produce a new draft rather than editing this one.
              </Alert>
            )}
          </div>
        ) : detail.loading ? (
          <p className="text-meta text-content-muted">Loading the analysis…</p>
        ) : null}
      </Drawer>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function EventsPanel({ base, onChanged }: { base: string; onChanged: () => void }) {
  const list = useResource<ListResponse<EnvironmentalEventRow> & { byCategory: Record<string, number> }>(
    `${base}/environmental-events?pageSize=200`,
  );
  const action = useAction();
  const [open, setOpen] = useState(false);

  const columns = useMemo<DataColumns<EnvironmentalEventRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", sticky: "start", width: 110 },
      { id: "category", header: "Category", accessor: "category", type: "status", width: 150, groupable: true, cell: ({ row }) => labelize(row.category) },
      { id: "occurredAt", header: "Occurred", accessor: "occurredAt", type: "datetime", width: 175, cell: ({ row }) => dateTime(row.occurredAt) },
      {
        id: "magnitude",
        header: "Measured",
        accessor: (row) => row.magnitude ?? 0,
        type: "number",
        width: 150,
        cell: ({ row }) => (row.magnitude === null ? <span className="italic text-content-subtle">not measured</span> : `${num(row.magnitude, 2)} ${row.magnitudeUnit ?? ""}`),
      },
      {
        id: "thresholdValue",
        header: "Limit",
        accessor: (row) => row.thresholdValue ?? 0,
        type: "number",
        width: 140,
        cell: ({ row }) => (row.thresholdValue === null ? <span className="italic text-content-subtle">no limit set</span> : `${num(row.thresholdValue, 2)} ${row.thresholdUnit ?? ""}`),
      },
      {
        id: "exceededThreshold",
        header: "Verdict",
        accessor: (row) => (row.thresholdValue === null ? "no limit" : row.exceededThreshold === 1 ? "exceeded" : "within"),
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) =>
          row.thresholdValue === null ? (
            <Badge tone="neutral" size="xs">
              no limit
            </Badge>
          ) : row.exceededThreshold === 1 ? (
            <Badge tone="danger" size="xs" dot>
              exceeded
            </Badge>
          ) : (
            <Badge tone="success" size="xs">
              within
            </Badge>
          ),
      },
      { id: "severity", header: "Severity", accessor: "severity", type: "status", width: 110, cell: ({ row }) => <Badge tone={SEVERITY_TONE[row.severity] ?? "neutral"} size="xs">{labelize(row.severity)}</Badge> },
      { id: "impact", header: "Impact", accessor: (row) => row.impact ?? "", type: "text", width: 360 },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 110, groupable: true, cell: ({ row }) => labelize(row.status) },
    ],
    [],
  );

  async function close(row: EnvironmentalEventRow) {
    const actionsTaken = window.prompt("What was done about this event?");
    if (!actionsTaken) return;
    const r = await action.run("close", () => api.post<EnvironmentalEventRow>(`${base}/environmental-events/${row.id}/close`, { actionsTaken }));
    if (r) {
      toast.success(`${r.reference} closed`);
      list.reload();
      onChanged();
    }
  }

  return (
    <Card>
      <CardBody>
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <SectionHeading
          title="Environmental, seismic and tidal events"
          hint="Everything that happened TO the site. An event with a stated limit is judged against it and raises a signal when it is exceeded; every event is also written to the platform-wide occurrence log."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setOpen(true)}>
              Log an event
            </Button>
          }
        />
        {list.error ? <LoadError message={list.error} onRetry={list.reload} /> : null}
        <DataTable
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={460}
          stickyHeader
          filterRow
          exportFileName="environmental-events"
          rowTone={(row) => (row.exceededThreshold === 1 ? "danger" : undefined)}
          rowActions={(row) =>
            row.status === "closed" ? null : (
              <Button size="xs" variant="ghost" onClick={() => void close(row)}>
                Close
              </Button>
            )
          }
          empty={{
            title: "No environmental events",
            description: "Log tremors, tides, floods, dust and noise exceedances here so the chronology of what the environment did to this site survives the project.",
            action: (
              <Button size="sm" onClick={() => setOpen(true)}>
                Log the first event
              </Button>
            ),
          }}
        />
        <EventForm
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

function EventForm({ base, open, onClose, onCreated }: { base: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const action = useAction();
  const [category, setCategory] = useState("vibration");
  const [occurredAt, setOccurredAt] = useState("");
  const [magnitude, setMagnitude] = useState("");
  const [unit, setUnit] = useState("mm/s");
  const [thresholdValue, setThresholdValue] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [sensorRef, setSensorRef] = useState("");
  const [impact, setImpact] = useState("");
  const [workStopped, setWorkStopped] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      category,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
      severity,
      workStopped,
      detectedVia: sensorRef.trim() ? "sensor" : "observation",
    };
    if (magnitude.trim()) {
      payload["magnitude"] = Number(magnitude);
      payload["magnitudeUnit"] = unit.trim();
    }
    if (thresholdValue.trim()) {
      payload["thresholdValue"] = Number(thresholdValue);
      payload["thresholdUnit"] = unit.trim();
    }
    if (sensorRef.trim()) payload["sensorRef"] = sensorRef.trim();
    if (impact.trim()) payload["impact"] = impact.trim();
    const r = await action.run("create", () => api.post<EnvironmentalEventRow & { thresholdVerdict: string }>(`${base}/environmental-events`, payload));
    if (r) {
      toast.success(r.thresholdVerdict);
      setMagnitude("");
      setImpact("");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Log an environmental event"
      description="The measured value and the limit must share a unit — the platform will not compare millimetres per second with decibels."
      size="md"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" required>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Occurred at">
            <Input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
          </Field>
          <Field label="Measured value">
            <Input type="number" step="any" value={magnitude} onChange={(e) => setMagnitude(e.target.value)} />
          </Field>
          <Field label="Unit" hint="Used for both the measurement and the limit.">
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Limit">
            <Input type="number" step="any" value={thresholdValue} onChange={(e) => setThresholdValue(e.target.value)} />
          </Field>
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {["info", "low", "medium", "high", "critical"].map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sensor reference">
            <Input value={sensorRef} onChange={(e) => setSensorRef(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Work stopped">
            <Select value={workStopped ? "yes" : "no"} onChange={(e) => setWorkStopped(e.target.value === "yes")}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </Select>
          </Field>
        </div>
        <Field label="Impact">
          <Textarea rows={3} value={impact} onChange={(e) => setImpact(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"}>
            Log
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
