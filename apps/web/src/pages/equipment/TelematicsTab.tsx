/**
 * TELEMATICS RECONCILIATION — the machine's own account of the day against
 * the one a person typed.
 *
 * Engine hours come off a CUMULATIVE counter, so a day's telematics hours are
 * the last reading of the day minus the first. That produces three states, and
 * this screen keeps them apart because collapsing them is how a control gets
 * switched off:
 *
 *   COMPARABLE      both accounts exist and the difference means something.
 *   NOT COMPARABLE  the feed cannot say — no reading, a single reading with no
 *                   interval to measure, or a counter that FELL (a device
 *                   reset or a swapped unit). Real hours were worked and the
 *                   feed can no longer say how many. This is rendered as NOT
 *                   COMPARABLE with the reason, never as a zero variance.
 *   NO PLANT SHEET  the machine ran and nobody filled in a sheet. That is
 *                   missing evidence, not an overclaim.
 *
 * A variance is not proof of a false claim — a counter can be reset, a machine
 * can be worked with the ignition off the clock. It is the question to ask,
 * and the value at risk is what makes asking it worth somebody's morning.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Select,
  SkeletonTable,
  Tooltip,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { ChartCard, GroupedBarChart } from "../../ui/charts";
import type { Tone } from "../../ui/tokens";
import { IconZap } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CurrencyRail,
  EM_DASH,
  FigureCell,
  LoadError,
  NOT_COMPARABLE_CLASSES,
  NotComparable,
  ReasonList,
  SectionHeading,
  VARIANCE_CLASS_LABEL,
  RefusalNotice,
  bucketsOf,
  hours,
  money,
  useAction,
  type DayVariance,
  type EquipmentReconciliation,
  type Loadable,
  type TelematicsIntelligence,
  type TelematicsReport,
} from "./equipmentShared";

const WINDOWS = [7, 14, 30, 60];

export default function TelematicsTab({
  projectId,
  report,
  intelligence,
  days,
  onDays,
  onOpenMachine,
}: {
  projectId: string | undefined;
  report: Loadable<TelematicsReport>;
  intelligence: Loadable<TelematicsIntelligence>;
  days: number;
  onDays: (next: number) => void;
  onOpenMachine: (equipmentId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const action = useAction();
  const [recorded, setRecorded] = useState<AssuranceRunResult | null>(null);
  const [detectorRun, setDetectorRun] = useState<DetectorRunResult | null>(null);
  const data = report.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const valueBuckets = useMemo(() => bucketsOf(data?.valueAtRiskByCurrency), [data]);

  const chartRows = useMemo(
    () =>
      rows
        .filter((row) => row.daysCompared > 0)
        .slice(0, 12)
        .map((row) => ({
          machine: row.reference,
          claimed: row.manualHours,
          engine: row.telematicsHours,
        })),
    [rows],
  );

  const columns = useMemo<DataColumns<EquipmentReconciliation>>(
    () => [
      {
        id: "reference",
        header: "Plant",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      { id: "name", header: "Machine", accessor: "name", type: "text", width: 210 },
      {
        id: "daysCompared",
        header: "Comparable days",
        headerTooltip:
          "Days on which both accounts exist: a plant sheet AND an engine-hour delta the counter could produce.",
        accessor: "daysCompared",
        type: "number",
        align: "right",
        width: 150,
        aggregate: "sum",
      },
      {
        id: "manualHours",
        header: "Claimed",
        accessor: "manualHours",
        type: "custom",
        align: "right",
        width: 115,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.manualHours)}</span>,
      },
      {
        id: "telematicsHours",
        header: "Engine",
        accessor: "telematicsHours",
        type: "custom",
        align: "right",
        width: 115,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.telematicsHours)}</span>,
      },
      {
        id: "varianceHours",
        header: "Variance",
        headerTooltip:
          "Claimed minus engine, across the comparable days only. Null when nothing was comparable — that is a statement about the evidence, not about the claim.",
        accessor: "varianceHours",
        type: "custom",
        align: "right",
        width: 140,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <FigureCell
            value={row.varianceHours}
            reasons={row.reasons}
            label="Not comparable"
            render={(value) => (
              <span
                className={
                  value > 0
                    ? "font-semibold text-danger-fg"
                    : value < 0
                      ? "font-semibold text-info-fg"
                      : ""
                }
              >
                {value > 0 ? "+" : ""}
                {hours(value)}
              </span>
            )}
          />
        ),
        toCsv: ({ row }) => row.varianceHours,
      },
      {
        id: "daysUnsupported",
        header: "Unsupported days",
        headerTooltip:
          "Days where claimed hours exceeded engine hours by more than 1 hour AND more than 1.15x. Both tolerances must be breached before a day is called unsupported.",
        accessor: "daysUnsupported",
        type: "number",
        align: "right",
        width: 165,
        aggregate: "sum",
        sortDescFirst: true,
        cell: ({ row }) => (
          <span
            className={row.daysUnsupported > 0 ? "font-semibold tabular-nums text-danger-fg" : "tabular-nums"}
          >
            {row.daysUnsupported}
          </span>
        ),
      },
      {
        id: "gaps",
        header: "Not comparable",
        headerTooltip:
          "Days the reconciliation could not run on: no telematics, or no plant sheet. These are never counted as variance.",
        accessor: (row) => row.daysWithoutTelematics + row.daysWithoutManual,
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        cell: ({ row }) => (
          <span className="flex items-center justify-end gap-1">
            {row.daysWithoutTelematics > 0 ? (
              <Tooltip content="Days on which hours were claimed and the feed was silent. Absence of a reading is absence of a reading — it is not evidence of an overclaim.">
                <span>
                  <Badge tone="neutral" size="xs" variant="outline">
                    {row.daysWithoutTelematics} no feed
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
            {row.daysWithoutManual > 0 ? (
              <Tooltip content="Days on which the machine ran and nobody filled in a plant sheet. Not a variance in money terms, but it is missing evidence.">
                <span>
                  <Badge tone="warning" size="xs" variant="outline">
                    {row.daysWithoutManual} no sheet
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
            {row.daysWithoutTelematics === 0 && row.daysWithoutManual === 0 ? (
              <span className="text-content-subtle">—</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "valueAtRisk",
        header: "Value at risk",
        headerTooltip:
          "The unsupported hours priced at the machine's recorded hourly rates. Null where no hourly rate exists — the hours are still unsupported, the money simply cannot be stated.",
        accessor: "valueAtRisk",
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <FigureCell
            value={row.valueAtRisk}
            reasons={row.reasons}
            className="font-semibold text-danger-fg"
            render={(value) => money(value, row.currency)}
          />
        ),
        toCsv: ({ row }) => (row.valueAtRisk === null ? "" : `${row.valueAtRisk} ${row.currency}`),
      },
      {
        id: "persistent",
        header: "Pattern",
        accessor: (row) => (row.persistent ? "yes" : "no"),
        type: "enum",
        width: 140,
        options: [
          { value: "yes", label: "Persistent", text: "Persistent", tone: "danger" },
          { value: "no", label: "Not persistent", text: "Not persistent" },
        ],
        cell: ({ row }) =>
          row.persistent ? (
            <Tooltip content="The variance recurs across enough days to not be noise. A persistent variance raises a signal for the assurance layer.">
              <span>
                <Badge tone="danger" size="xs" dot>
                  Persistent
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="text-2xs text-content-subtle">single days</span>
          ),
      },
    ],
    [],
  );

  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;
  if (report.loading && !data) return <SkeletonTable rows={8} columns={8} />;
  if (!data) return null;

  const from = data.from ?? data.periodStart ?? "";
  const to = data.to ?? data.periodEnd ?? "";
  const expandedRow = rows.find((row) => row.equipmentId === expanded) ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Manual hours against engine hours"
            hint="Two independent accounts of the same day, produced by parties who do not share a pathway. That is exactly why the difference is worth something."
            className="mb-0"
            actions={
              <label className="flex items-center gap-2">
                <span className="text-label uppercase tracking-wide text-content-subtle">
                  Window
                </span>
                <Select
                  size="sm"
                  value={String(days)}
                  onChange={(event) => onDays(Number(event.target.value))}
                  aria-label="Reconciliation window"
                >
                  {WINDOWS.map((value) => (
                    <option key={value} value={value}>
                      Last {value} days
                    </option>
                  ))}
                </Select>
              </label>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" size="sm">
              {data.machines} machine{data.machines === 1 ? "" : "s"}
            </Badge>
            <Badge tone={data.machinesWithVariance > 0 ? "warning" : "success"} size="sm" dot>
              {data.machinesWithVariance} with variance
            </Badge>
            <Badge tone={data.machinesPersistent > 0 ? "danger" : "neutral"} size="sm" dot={data.machinesPersistent > 0}>
              {data.machinesPersistent} persistent
            </Badge>
            <span className="text-meta text-content-muted">
              {from} to {to} · {data.totals.daysCompared} comparable day
              {data.totals.daysCompared === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-2xs text-content-muted">{data.method}</p>
        </CardBody>
      </Card>

      <AssurancePanel
        projectId={projectId}
        from={from}
        to={to}
        busy={action.busy === "record"}
        refusal={action.refusal}
        clearRefusal={action.clear}
        result={recorded}
        onRun={async () => {
          if (!projectId) return;
          const out = await action.run("record", () =>
            api.post<AssuranceRunResult>(
              `/api/v1/projects/${projectId}/equipment-telematics/reconciliation/run`,
              { from, to },
            ),
          );
          if (out) setRecorded(out);
        }}
      />

      <CurrencyRail
        buckets={valueBuckets}
        label="Value at risk"
        note={data.currencyNote}
        tone="danger"
      />

      {data.machinesPersistent > 0 ? (
        <Alert
          tone="warning"
          title={`${data.machinesPersistent} machine${data.machinesPersistent === 1 ? " has" : "s have"} a persistent unexplained variance`}
        >
          A persistent variance is not proof of a false claim. A counter can be reset, a machine can
          be worked with the ignition off the clock, and a plant sheet can be honestly wrong. It is
          the question to ask — and the answer is worth having before the hire invoice is
          certified, not after.
        </Alert>
      ) : null}

      {chartRows.length > 1 ? (
        <ChartCard
          title="Claimed against the machine"
          subtitle="Hours per machine over the window, comparable days only"
          icon={IconZap}
          footnote="Days with no telematics and days with no plant sheet are excluded from both bars — they are not comparable, and adding a zero for them would tilt every machine towards an overclaim."
        >
          <GroupedBarChart
            data={chartRows}
            categoryKey="machine"
            series={[
              { key: "claimed", label: "Claimed on plant sheets" },
              { key: "engine", label: "Engine hours" },
            ]}
            valueFormat="hours"
            ariaLabel="Claimed hours against engine hours per machine"
            height={280}
          />
        </ChartCard>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={IconZap}
          title="Nothing to reconcile on this project"
          hint={
            data.method ||
            "No plant has been assigned to this project and no utilisation has been recorded, so there are no two accounts of a day to compare."
          }
        />
      ) : (
        <>
          <DataTable<EquipmentReconciliation>
            tableId="equipment-telematics"
            data={rows}
            columns={columns}
            getRowId={(row) => row.equipmentId}
            loading={report.loading}
            height={Math.min(520, 140 + rows.length * 40)}
            stickyHeader
            gridLines
            filterRow
            exportFileName="telematics-reconciliation"
            searchPlaceholder="Search machines…"
            defaultSort={[{ id: "valueAtRisk", desc: true }]}
            rowTone={(row) => (row.persistent ? ("danger" as Tone) : undefined)}
            onRowClick={({ row }) => setExpanded(row.equipmentId)}
            rowActions={(row) => [
              { id: "days", label: "Show the days", onSelect: () => setExpanded(row.equipmentId) },
              {
                id: "open",
                label: "Open the machine",
                onSelect: () => onOpenMachine(row.equipmentId),
              },
            ]}
            empty={{ title: "No machines to reconcile" }}
            aria-label="Telematics reconciliation by machine"
          />

          {expandedRow ? (
            <DayBreakdown
              row={expandedRow}
              onClose={() => setExpanded(null)}
              onOpenMachine={onOpenMachine}
            />
          ) : (
            <p className="text-2xs text-content-subtle">
              Select a machine to see its day-by-day comparison, including the days the
              reconciliation declined to run on and why.
            </p>
          )}
        </>
      )}

      <IntelligencePanel
        intelligence={intelligence}
        onOpenMachine={onOpenMachine}
        busy={action.busy === "detectors"}
        result={detectorRun}
        onRun={
          projectId
            ? async () => {
                const out = await action.run("detectors", () =>
                  api.post<DetectorRunResult>(
                    `/api/v1/projects/${projectId}/equipment-telematics/intelligence/run`,
                    {},
                  ),
                );
                if (out) {
                  setDetectorRun(out);
                  intelligence.reload();
                }
              }
            : undefined
        }
      />
    </div>
  );
}

/* ========================================================================== */
/* What the feed says beyond hours                                             */
/* ========================================================================== */

/**
 * WHERE, WHAT IT BURNED, AND WHAT IT IS COMPLAINING ABOUT.
 *
 * Three findings the hours reconciliation cannot make, each of which refuses
 * rather than guesses:
 *
 *  · GEOFENCE. Only readings with the ENGINE RUNNING count — a machine parked
 *    in a yard overnight is not misuse — and a single breaching reading is
 *    reported without a duration, because one point says where the machine
 *    was, not how long it was there. No project coordinates means no fence and
 *    no verdict at all.
 *  · FUEL. Litres put in against litres the machine says it burned, with both
 *    an absolute and a proportional tolerance. A feed reporting no consumption
 *    produces a reason, not an accusation: "burned nothing and took 400
 *    litres" is nearly always a device that does not report fuel.
 *  · FAULTS. Severe and above only. A critical fault is the manufacturer
 *    telling you to stop the machine.
 */
/**
 * What the detector sweep did, as it answers. `machinesAssessed` is the plant
 * it could read, not the plant that is flagged, so a run over a clean fleet
 * reports "nothing raised" rather than an empty screen.
 */
export interface DetectorRunResult {
  from: string;
  to: string;
  machinesAssessed: number;
  signalsRaised: number;
  takenOutOfService: string[];
  reasons: string[];
}

function IntelligencePanel({
  intelligence,
  onOpenMachine,
  onRun,
  busy,
  result,
}: {
  intelligence: Loadable<TelematicsIntelligence>;
  onOpenMachine: (equipmentId: string) => void;
  onRun?: (() => void) | undefined;
  busy: boolean;
  result: DetectorRunResult | null;
}) {
  const data = intelligence.data;
  const flagged = useMemo(
    () =>
      (data?.machines ?? []).filter(
        (m) =>
          m.geofence.breaches.length > 0 || m.fuel.unexplained || m.faults.actionable.length > 0,
      ),
    [data],
  );

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionHeading
          title="What the feed says beyond hours"
          hint="Where the machine was worked, what it burned against what was put in it, and what it is complaining about. Every one of these refuses rather than guesses."
          className="mb-0"
          action={
            onRun ? (
              <Button size="sm" variant="secondary" onClick={onRun} loading={busy}>
                Raise the signals
              </Button>
            ) : undefined
          }
        />
        {result ? (
          <Alert
            tone={result.signalsRaised > 0 ? "warning" : "success"}
            title={
              result.signalsRaised > 0
                ? `${result.signalsRaised} signal${result.signalsRaised === 1 ? "" : "s"} raised over ${result.from} → ${result.to}`
                : `Nothing raised over ${result.from} → ${result.to}`
            }
          >
            {result.machinesAssessed} machine{result.machinesAssessed === 1 ? "" : "s"} on this job
            could be read.{" "}
            {result.takenOutOfService.length > 0
              ? `${result.takenOutOfService.join(", ")} ${result.takenOutOfService.length === 1 ? "was" : "were"} moved to breakdown on a critical fault code and will not come back to the available fleet until a maintenance record returns ${result.takenOutOfService.length === 1 ? "it" : "them"} to service. `
              : ""}
            {result.signalsRaised === 0
              ? "A machine already signalled for this window is not signalled again — a second run says nothing new rather than accusing it twice."
              : ""}
            <ReasonList reasons={result.reasons} />
          </Alert>
        ) : null}
        {intelligence.error ? (
          <LoadError message={intelligence.error} onRetry={intelligence.reload} />
        ) : intelligence.loading ? (
          <SkeletonTable rows={3} />
        ) : !data ? (
          <EmptyState
            icon={<IconZap />}
            title="Nothing asked yet"
            description="The feed has not been read for this window."
          />
        ) : (
          <>
            <ReasonList reasons={data.reasons} />
            {data.machines.length === 0 ? (
              <EmptyState
                icon={<IconZap />}
                title="No plant on this project"
                description="No machine is assigned here, so there is no feed to read."
              />
            ) : flagged.length === 0 ? (
              <EmptyState
                icon={<IconZap />}
                title="Nothing to raise"
                description={`${data.machines.length} machine(s) read between ${data.from} and ${data.to}. No off-site running, no unexplained fuel and no actionable fault code.`}
              />
            ) : (
              <div className="space-y-3">
                {flagged.map((machine) => (
                  <div key={machine.equipmentId} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-content">{machine.reference}</span>
                        <span className="text-content-muted">{machine.name}</span>
                        <Badge tone="neutral" size="xs">
                          {machine.readings} reading{machine.readings === 1 ? "" : "s"}
                        </Badge>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onOpenMachine(machine.equipmentId)}
                      >
                        Open the machine
                      </Button>
                    </div>
                    <div className="mt-2 grid gap-3 md:grid-cols-3">
                      <div>
                        <div className="text-label uppercase tracking-wide text-content-subtle">
                          Off site
                        </div>
                        {machine.geofence.breaches.length === 0 ? (
                          machine.geofence.reasons.length > 0 ? (
                            <NotComparable reason={machine.geofence.reasons.join(" ")} />
                          ) : (
                            <div className="text-content-muted">Worked inside the fence</div>
                          )
                        ) : (
                          <div>
                            <Badge tone="danger" size="xs" dot>
                              {machine.geofence.breaches.length} running reading(s) outside
                            </Badge>
                            <div className="mt-1 text-meta text-content-muted">
                              furthest{" "}
                              {machine.geofence.maxDistanceMetres === null
                                ? EM_DASH
                                : `${Math.round(machine.geofence.maxDistanceMetres)} m`}
                              {machine.geofence.spanHours !== null
                                ? ` · spanning ${machine.geofence.spanHours} h`
                                : ""}
                            </div>
                            <ReasonList reasons={machine.geofence.reasons} className="mt-1" />
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-label uppercase tracking-wide text-content-subtle">
                          Fuel
                        </div>
                        {machine.fuel.burnLitres === null ? (
                          <NotComparable reason={machine.fuel.reasons.join(" ")} />
                        ) : (
                          <div>
                            <div
                              className={machine.fuel.unexplained ? "text-danger" : "text-content"}
                            >
                              {machine.fuel.filledLitres} L filled · {machine.fuel.burnLitres} L
                              burned
                            </div>
                            <div className="text-meta text-content-muted">
                              difference{" "}
                              {machine.fuel.differenceLitres === null
                                ? EM_DASH
                                : `${machine.fuel.differenceLitres} L`}
                              {machine.fuel.ratio !== null ? ` · ratio ${machine.fuel.ratio}` : ""}
                            </div>
                            <ReasonList reasons={machine.fuel.reasons} className="mt-1" />
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-label uppercase tracking-wide text-content-subtle">
                          Faults
                        </div>
                        {machine.faults.actionable.length === 0 ? (
                          <div className="text-content-muted">No actionable fault reported</div>
                        ) : (
                          <div>
                            <Badge
                              tone={machine.faults.stopWork ? "danger" : "warning"}
                              size="xs"
                              dot
                            >
                              {machine.faults.actionable.length} active ·{" "}
                              {machine.faults.worst ?? "severe"}
                            </Badge>
                            {machine.faults.reason ? (
                              <p className="mt-1 text-meta text-content-muted">
                                {machine.faults.reason}
                              </p>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The day grid — the honest part. Every day is one of five classifications and
 * the two that are absence-of-evidence are drawn as NOT COMPARABLE with the
 * engine's reason, never as a zero variance.
 */
function DayBreakdown({
  row,
  onClose,
  onOpenMachine,
}: {
  row: EquipmentReconciliation;
  onClose: () => void;
  onOpenMachine: (equipmentId: string) => void;
}) {
  const columns = useMemo<DataColumns<DayVariance>>(
    () => [
      { id: "date", header: "Date", accessor: "date", type: "date", sticky: "start", width: 120 },
      {
        id: "classification",
        header: "Comparison",
        accessor: "classification",
        type: "enum",
        width: 175,
        groupable: true,
        options: (
          Object.keys(VARIANCE_CLASS_LABEL) as Array<DayVariance["classification"]>
        ).map((value) => ({
          value,
          label: VARIANCE_CLASS_LABEL[value],
          text: VARIANCE_CLASS_LABEL[value],
          tone: dayTone(value),
        })),
        cell: ({ row: day }) =>
          NOT_COMPARABLE_CLASSES.has(day.classification) ? (
            <NotComparable reason={day.reason} label={VARIANCE_CLASS_LABEL[day.classification]} />
          ) : (
            <Badge tone={dayTone(day.classification) ?? "neutral"} size="xs" dot>
              {VARIANCE_CLASS_LABEL[day.classification]}
            </Badge>
          ),
      },
      {
        id: "manualWorkingHours",
        header: "Claimed",
        accessor: "manualWorkingHours",
        type: "custom",
        align: "right",
        width: 120,
        aggregate: "none",
        cell: ({ row: day }) =>
          day.manualWorkingHours === null ? (
            <Tooltip content="No plant sheet exists for this machine on this day. That is a missing record, not zero hours claimed.">
              <span className="text-2xs text-content-subtle italic">no sheet</span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">{hours(day.manualWorkingHours)}</span>
          ),
      },
      {
        id: "telematicsEngineHours",
        header: "Engine",
        accessor: "telematicsEngineHours",
        type: "custom",
        align: "right",
        width: 120,
        aggregate: "none",
        cell: ({ row: day }) =>
          day.telematicsEngineHours === null ? (
            <NotComparable
              reason={
                (day.telematicsReasons ?? []).join(" ") ||
                "The feed cannot state engine hours for this day. Engine hours are a cumulative counter: no reading, one reading with no interval to measure, or a counter that fell all yield null rather than zero."
              }
              label="Feed silent"
            />
          ) : (
            <span className="tabular-nums">{hours(day.telematicsEngineHours)}</span>
          ),
      },
      {
        id: "varianceHours",
        header: "Variance",
        accessor: "varianceHours",
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        cell: ({ row: day }) =>
          day.varianceHours === null ? (
            <NotComparable reason={day.reason} />
          ) : (
            <span
              className={
                day.varianceHours > 0
                  ? "font-semibold tabular-nums text-danger-fg"
                  : day.varianceHours < 0
                    ? "font-semibold tabular-nums text-info-fg"
                    : "tabular-nums"
              }
            >
              {day.varianceHours > 0 ? "+" : ""}
              {hours(day.varianceHours)}
            </span>
          ),
      },
      {
        id: "ratio",
        header: "Ratio",
        accessor: "ratio",
        type: "custom",
        align: "right",
        width: 105,
        aggregate: "none",
        cell: ({ row: day }) =>
          day.ratio === null ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="tabular-nums">{day.ratio.toFixed(2)}×</span>
          ),
      },
      {
        id: "reason",
        header: "What the engine says",
        accessor: "reason",
        type: "text",
        width: 460,
        truncate: false,
        cell: ({ row: day }) => (
          <span className="block whitespace-normal py-1 text-meta text-content-muted">
            {day.reason}
          </span>
        ),
      },
    ],
    [],
  );

  const notComparable = row.days.filter((day) => day.varianceHours === null).length;

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionHeading
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{row.reference}</span>
              <span>{row.name}</span>
              {row.persistent ? (
                <Badge tone="danger" size="xs" dot>
                  Persistent variance
                </Badge>
              ) : null}
            </span>
          }
          hint={`${row.days.length} day(s) in the window · ${row.daysCompared} comparable · ${notComparable} not comparable · ${row.daysUnsupported} unsupported`}
          className="mb-0"
          actions={
            <span className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => onOpenMachine(row.equipmentId)}>
                Open the machine
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </span>
          }
        />

        {row.reasons.length > 0 ? (
          <div className="rounded-lg border border-border bg-surface-sunken p-3">
            <p className="mb-1.5 text-label uppercase tracking-wide text-content-subtle">
              Why some figures on this machine are null
            </p>
            <ReasonList reasons={row.reasons} />
          </div>
        ) : null}

        <DataTable<DayVariance>
          tableId="equipment-telematics-days"
          data={row.days}
          columns={columns}
          getRowId={(day) => `${row.equipmentId}:${day.date}`}
          height={Math.min(460, 120 + row.days.length * 44)}
          stickyHeader
          gridLines
          rowHeight={52}
          toolbar={false}
          rowTone={(day) => (day.classification === "unsupported_hours" ? ("danger" as Tone) : undefined)}
          empty={{
            title: "No days in the window",
            description: "Neither a plant sheet nor a telematics reading exists for this machine.",
          }}
          aria-label={`Day by day comparison for ${row.reference}`}
        />
      </CardBody>
    </Card>
  );
}

function dayTone(classification: DayVariance["classification"]): Tone | undefined {
  switch (classification) {
    case "unsupported_hours":
      return "danger";
    case "under_reported":
      return "info";
    case "ok":
      return "success";
    default:
      return "neutral";
  }
}


/* ========================================================================== */
/* Recording the comparison as an assurance fact                               */
/* ========================================================================== */

export interface AssuranceRunResult {
  from: string;
  to: string;
  recorded: number;
  replaced: number;
  rows?: Array<{
    equipmentId: string;
    reference: string;
    assertionId: string;
    evidenceId: string | null;
    reconciliationId: string;
    result: string;
    selfCertified: boolean;
  }>;
  skipped?: Array<{ equipmentId: string; reference: string; reason: string }>;
  reasons?: string[];
  method?: string;
}

const RESULT_TONE: Record<string, Tone> = {
  supported: "success",
  partially_supported: "warning",
  unsupported: "danger",
  contradicted: "danger",
  insufficient_evidence: "neutral",
};

const RESULT_LABEL: Record<string, string> = {
  supported: "Supported",
  partially_supported: "Partly supported",
  unsupported: "Unsupported",
  contradicted: "Contradicted",
  insufficient_evidence: "Insufficient evidence",
};

/**
 * The read above is a comparison; this writes it down as the platform's three
 * primitives, which is what makes it readable on the owner's assurance page
 * next to every other claim that has been tested. The button says who the
 * claimant is and what happens when that is you, because a pack assembled by
 * the person who claimed the hours is not an independent test of the claim
 * and must never present as one.
 */
function AssurancePanel({
  projectId,
  from,
  to,
  busy,
  refusal,
  clearRefusal,
  result,
  onRun,
}: {
  projectId: string | undefined;
  from: string;
  to: string;
  busy: boolean;
  refusal: ReturnType<typeof useAction>["refusal"];
  clearRefusal: () => void;
  result: AssuranceRunResult | null;
  onRun: () => void;
}) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionHeading
          title="Record this window as assurance evidence"
          hint="The plant sheet is the ASSERTION; the machine's own counter is the EVIDENCE that tests it. Re-running a window replaces the record rather than stacking a second copy of the same finding."
          className="mb-0"
          actions={
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              disabled={!projectId || !from || !to}
              onClick={onRun}
            >
              Record {from} to {to}
            </Button>
          }
        />
        {refusal ? <RefusalNotice refusal={refusal} onDismiss={clearRefusal} /> : null}
        {result ? (
          result.recorded === 0 ? (
            <Alert tone="neutral" title="Nothing was recorded">
              <ReasonList
                reasons={
                  result.reasons?.length
                    ? result.reasons
                    : ["no machine in this window carried hours to test"]
                }
              />
            </Alert>
          ) : (
            <div className="space-y-2">
              <p className="text-meta text-content-muted">
                {result.recorded} machine{result.recorded === 1 ? "" : "s"} recorded
                {result.replaced > 0
                  ? ` · ${result.replaced} replaced an earlier record for the same window`
                  : ""}
                .
              </p>
              <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle">
                {(result.rows ?? []).map((row) => (
                  <li
                    key={row.reconciliationId}
                    className="flex flex-wrap items-center gap-2 px-3 py-2"
                  >
                    <span className="font-mono text-meta">{row.reference}</span>
                    <Badge tone={RESULT_TONE[row.result] ?? "neutral"} size="xs">
                      {RESULT_LABEL[row.result] ?? row.result}
                    </Badge>
                    {row.selfCertified ? (
                      <Tooltip content="You are one of the people who recorded these hours, so this pack is not independent of the claim it tests. The comparison stands; it is not offered as verified.">
                        <span>
                          <Badge tone="warning" size="xs" dot>
                            Self-certified
                          </Badge>
                        </span>
                      </Tooltip>
                    ) : null}
                    {row.evidenceId ? null : (
                      <span className="text-2xs text-content-subtle">
                        no evidence row — the feed never reached this window
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {result.skipped?.length ? (
                <ReasonList
                  reasons={result.skipped.map((s) => `${s.reference}: ${s.reason}`)}
                />
              ) : null}
            </div>
          )
        ) : (
          <p className="text-2xs text-content-muted">
            Nothing has been recorded for this window yet. Recording it does not change any
            figure on this page — it files the comparison, its confidence and its independence
            so somebody outside the project can read it.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
