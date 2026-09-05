/**
 * DEMAND & SUPPLY — the plan, the histogram and the levelling suggestions
 * (spec Vol I #676–687).
 *
 * The histogram is the point of this tab. Three things it will not do:
 *  · it never paints a week with no recorded availability as an overload —
 *    unknown supply is grey with the reason, not red;
 *  · it never converts hours to a headcount for a trade with no standard
 *    working day;
 *  · it never applies a levelling suggestion. Moving an activity is a
 *    programme change made in the schedule module; here it is a proposal with
 *    the float that makes it possible printed next to it.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Td,
  Th,
  type DataColumns,
} from "../../ui";
import { IconGantt, IconPlus, IconRefresh, IconZap } from "../../ui/icons";
import {
  HISTOGRAM_STATE_LABEL,
  HISTOGRAM_STATE_TONE,
  LoadError,
  PLAN_STATUS_TONE,
  Pill,
  ReasonList,
  Row,
  count,
  dateOnly,
  hours,
  mondayOf,
  num,
  percent,
  resourcesApi,
  shiftIso,
  shortDate,
  titleCase,
  todayIso,
  useAction,
  useResource,
  type AvailabilityRow,
  type DemandRow,
  type DeriveResult,
  type Histogram,
  type PlanDetail,
  type Paginated,
  type ResourcePlan,
  type ResourceType,
} from "./resourcesShared";

export default function PlanTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [supplyOpen, setSupplyOpen] = useState(false);
  const [nonce, setNonce] = useState(0);

  const from = mondayOf(todayIso());
  const to = shiftIso(from, 12 * 7);

  const plans = useResource<Paginated<ResourcePlan>>(
    `/api/v1/projects/${projectId}/resource-plans?pageSize=100&_=${nonce}`,
  );
  const histogram = useResource<Histogram>(
    `/api/v1/projects/${projectId}/resources/histogram?from=${from}&to=${to}&_=${nonce}`,
  );
  const types = useResource<Paginated<ResourceType>>(
    `/api/v1/resource-types?pageSize=200&status=active&projectId=${projectId}`,
  );

  const reload = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  const planColumns = useMemo<DataColumns<ResourcePlan>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", width: 100, mono: true },
      { id: "name", header: "Plan", accessor: "name", type: "text", width: 260 },
      {
        id: "planKind",
        header: "Kind",
        accessor: (row) => titleCase(row.planKind),
        type: "text",
        width: 110,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => <Pill status={row.status} map={PLAN_STATUS_TONE} />,
      },
      {
        id: "demandRowCount",
        header: "Rows",
        accessor: "demandRowCount",
        type: "number",
        align: "right",
        width: 80,
      },
      {
        id: "totalDemandHours",
        header: "Demand",
        accessor: "totalDemandHours",
        type: "number",
        align: "right",
        width: 110,
        cell: ({ row }) => hours(row.totalDemandHours),
      },
      {
        id: "peakHeadcount",
        header: "Peak people",
        accessor: (row) => row.peakHeadcount,
        type: "number",
        align: "right",
        width: 120,
        cell: ({ row }) => count(row.peakHeadcount),
      },
      {
        id: "derivedAt",
        header: "Source",
        accessor: (row) => (row.derivedAt ? "Schedule" : "Manual"),
        type: "text",
        width: 110,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {action.error ? (
        <Alert tone="danger" size="sm" onDismiss={action.clear}>
          {action.error}
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Resource plans"
          subtitle="Versioned, never edited in place: the baseline the job was sanctioned on stays readable next to what we are doing now"
          actions={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" icon={IconZap} onClick={() => setSupplyOpen(true)}>
                State supply
              </Button>
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                New plan
              </Button>
            </div>
          }
        />
        <CardBody flush>
          {plans.error ? (
            <div className="p-4">
              <LoadError message={plans.error} onRetry={plans.reload} />
            </div>
          ) : (
            <DataTable<ResourcePlan>
              tableId="resources.plans"
              data={plans.data?.items ?? []}
              columns={planColumns}
              getRowId={(row) => row.id}
              loading={plans.loading && !plans.data}
              height={240}
              rowHeight={40}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "No resource plan on this project",
                description:
                  "A plan is where the programme becomes a demand curve. Create one and derive it from the schedule — after that, changing the dates moves the histogram.",
              }}
              onRowClick={({ row }) => setOpenPlanId(row.id)}
              aria-label="Resource plans"
            />
          )}
        </CardBody>
      </Card>

      <HistogramPanel
        histogram={histogram.data}
        loading={histogram.loading}
        error={histogram.error}
        onRetry={histogram.reload}
      />

      <CreatePlanModal
        open={creating}
        projectId={projectId}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          reload();
          setOpenPlanId(id);
        }}
      />

      <SupplyModal
        open={supplyOpen}
        projectId={projectId}
        types={types.data?.items ?? []}
        onClose={() => setSupplyOpen(false)}
        onSaved={() => {
          setSupplyOpen(false);
          reload();
        }}
      />

      <PlanDrawer
        projectId={projectId}
        planId={openPlanId}
        types={types.data?.items ?? []}
        onClose={() => setOpenPlanId(null)}
        onChanged={reload}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Histogram                                                           */
/* ------------------------------------------------------------------ */

function HistogramPanel({
  histogram,
  loading,
  error,
  onRetry,
}: {
  histogram: Histogram | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) return <LoadError message={error} onRetry={onRetry} />;
  if (loading && !histogram) {
    return (
      <Card>
        <CardBody>
          <div className="py-8 text-center text-meta text-content-subtle">Building the histogram…</div>
        </CardBody>
      </Card>
    );
  }
  if (!histogram) return null;

  const weeks = histogram.weeks;
  const hasSeries = histogram.series.length > 0;

  return (
    <Card>
      <CardHeader
        title="Demand against supply, week by week"
        subtitle={
          histogram.plan
            ? `${histogram.plan.reference} · ${dateOnly(histogram.window.from)} → ${dateOnly(histogram.window.to)}`
            : "No active plan"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2 text-2xs">
            {(["over", "tight", "ok", "idle", "unknown"] as const).map((state) => (
              <Badge key={state} tone={HISTOGRAM_STATE_TONE[state]} size="xs" dot>
                {HISTOGRAM_STATE_LABEL[state]}
              </Badge>
            ))}
          </div>
        }
      />
      <CardBody flush>
        {hasSeries && weeks.length > 0 ? (
          <div className="overflow-x-auto">
            <Table dense>
              <thead>
                <tr>
                  <Th className="sticky left-0 z-10 bg-surface">Trade / plant class</Th>
                  {weeks.map((w) => (
                    <Th key={w} align="right" className="whitespace-nowrap">
                      {shortDate(w)}
                    </Th>
                  ))}
                  <Th align="right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {histogram.series.map((series) => (
                  <tr key={series.resourceType.id}>
                    <Td className="sticky left-0 z-10 bg-surface">
                      <div className="font-medium text-content">{series.resourceType.name}</div>
                      <div className="text-2xs text-content-subtle">
                        {series.resourceType.code} · {titleCase(series.resourceType.kind)}
                        {series.resourceType.standardHoursPerDay === null
                          ? " · no standard day recorded"
                          : ` · ${num(series.resourceType.standardHoursPerDay)} h/day`}
                      </div>
                    </Td>
                    {series.cells.map((cell) => (
                      <Td key={cell.weekStart} align="right">
                        <span
                          className="inline-flex flex-col items-end"
                          title={
                            cell.reasons.length > 0
                              ? cell.reasons.join(" ")
                              : `${hours(cell.demandHours)} needed, ${hours(
                                  cell.availableHours,
                                )} available`
                          }
                        >
                          <Badge tone={HISTOGRAM_STATE_TONE[cell.state]} size="xs">
                            {num(cell.demandHours)}
                          </Badge>
                          <span className="text-2xs text-content-subtle">
                            {cell.state === "unknown"
                              ? "supply —"
                              : `of ${num(cell.availableHours)}`}
                          </span>
                        </span>
                      </Td>
                    ))}
                    <Td align="right">
                      <div className="font-medium">{hours(series.totalDemandHours)}</div>
                      <div className="text-2xs text-content-subtle">
                        {series.totalAvailableHours === null
                          ? "supply not stated"
                          : `of ${hours(series.totalAvailableHours)}`}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <div className="p-4">
            <EmptyState
              title="Nothing to plot"
              hint={
                histogram.reasons[0] ??
                "Create a resource plan, derive it from the schedule, and state what the project can field."
              }
              icon={IconGantt}
              size="sm"
            />
          </div>
        )}
      </CardBody>
      <CardBody>
        <div className="grid gap-3 sm:grid-cols-3">
          <Row label="Total demand">{hours(histogram.totals.demandHours)}</Row>
          <Row
            label="Total supply"
            hint={histogram.totals.availableHours === null ? "Not stated — some weeks are blank" : undefined}
          >
            {hours(histogram.totals.availableHours)}
          </Row>
          <Row label="Weeks short">{count(histogram.totals.overAllocatedCells)}</Row>
        </div>
        <ReasonList reasons={[histogram.calendar.source, ...histogram.reasons]} className="mt-2" />

        {histogram.levelling.length > 0 ? (
          <div className="mt-4">
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Ways out of the peak — suggestions only
            </div>
            <ul className="space-y-2">
              {histogram.levelling.slice(0, 8).map((l, i) => (
                <li
                  key={`${l.resourceTypeId}-${l.weekStart}-${i}`}
                  className="rounded-md border border-border-subtle bg-surface-raised p-3"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone={l.action === "defer_task" ? "info" : "warning"} size="xs">
                      {titleCase(l.action)}
                    </Badge>
                    <span className="text-meta font-medium text-content">
                      {l.resourceTypeName} · week of {shortDate(l.weekStart)}
                    </span>
                    {l.floatDays !== null ? (
                      <span className="text-2xs text-content-subtle">{l.floatDays} days float</span>
                    ) : null}
                    {l.moveHours !== null ? (
                      <span className="text-2xs text-content-subtle">{hours(l.moveHours)}</span>
                    ) : null}
                  </div>
                  <p className="text-2xs text-content-subtle">{l.explanation}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Plan drawer                                                         */
/* ------------------------------------------------------------------ */

function PlanDrawer({
  projectId,
  planId,
  types,
  onClose,
  onChanged,
}: {
  projectId: string;
  planId: string | null;
  types: ResourceType[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [nonce, setNonce] = useState(0);
  const [derived, setDerived] = useState<DeriveResult | null>(null);
  const [defaultTypeId, setDefaultTypeId] = useState("");
  const [remainingOnly, setRemainingOnly] = useState(true);

  const plan = useResource<PlanDetail>(
    planId ? `/api/v1/projects/${projectId}/resource-plans/${planId}?_=${nonce}` : null,
  );
  const demand = useResource<Paginated<DemandRow>>(
    planId
      ? `/api/v1/projects/${projectId}/resource-plans/${planId}/demand?pageSize=200&_=${nonce}`
      : null,
  );

  useEffect(() => {
    if (planId === null) setDerived(null);
  }, [planId]);

  const p = plan.data;
  const bump = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  return (
    <Drawer
      open={planId !== null}
      onClose={onClose}
      size="xl"
      title={p ? `${p.reference} — ${p.name}` : "Resource plan"}
      description={
        p ? (
          <span className="flex flex-wrap items-center gap-2">
            <Pill status={p.status} map={PLAN_STATUS_TONE} />
            <span className="text-2xs text-content-subtle">
              {titleCase(p.planKind)} · {count(p.demandRows)} rows · {hours(p.demandHours)}
            </span>
          </span>
        ) : null
      }
    >
      {plan.error ? (
        <LoadError message={plan.error} onRetry={plan.reload} />
      ) : !p ? (
        <div className="py-8 text-center text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={action.busy === "activate"}
              disabled={p.status === "active" || p.status === "archived"}
              onClick={async () => {
                const res = await action.run("activate", () =>
                  resourcesApi.activatePlan(projectId, p.id),
                );
                if (res) {
                  toast.success(`${p.reference} is live`);
                  bump();
                }
              }}
            >
              Activate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={action.busy === "archive"}
              disabled={p.status === "archived"}
              onClick={async () => {
                const res = await action.run("archive", () =>
                  resourcesApi.archivePlan(projectId, p.id),
                );
                if (res) {
                  toast.success("Archived");
                  bump();
                }
              }}
            >
              Archive
            </Button>
          </div>

          <Card>
            <CardHeader
              title="Derive from the programme"
              subtitle="Spreads each activity's planned hours over its working days and buckets them by week. Manual rows are never touched."
            />
            <CardBody className="space-y-3">
              <Field label="Attribute unmapped activities to">
                <Select value={defaultTypeId} onChange={(e) => setDefaultTypeId(e.target.value)}>
                  <option value="">Leave unmapped (they will be skipped with a reason)</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.code} — {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-meta text-content">
                <input
                  type="checkbox"
                  checked={remainingOnly}
                  onChange={(e) => setRemainingOnly(e.target.checked)}
                />
                Spread only the hours still to spend
              </label>
              <Button
                size="sm"
                icon={IconRefresh}
                loading={action.busy === "derive"}
                disabled={p.status === "superseded" || p.status === "archived"}
                onClick={async () => {
                  const res = await action.run("derive", () =>
                    resourcesApi.derive(projectId, p.id, {
                      remainingOnly,
                      perActivity: true,
                      ...(defaultTypeId ? { defaultResourceTypeId: defaultTypeId } : {}),
                    }),
                  );
                  if (res) {
                    setDerived(res);
                    toast.success(`${res.rowsWritten} demand rows written`);
                    bump();
                  }
                }}
              >
                Derive
              </Button>

              {derived ? (
                <div className="space-y-2">
                  <dl className="divide-y divide-border-subtle">
                    <Row label="Rows written">{count(derived.rowsWritten)}</Row>
                    <Row label="Activities that contributed">{count(derived.derivedTaskCount)}</Row>
                    <Row label="Activity lines skipped">{count(derived.skippedCount)}</Row>
                    <Row label="Total demand">{hours(derived.totalDemandHours)}</Row>
                  </dl>
                  {derived.skipped.length > 0 ? (
                    <Alert tone="warning" size="sm" title="What produced no demand, and why">
                      <ul className="list-disc space-y-1 pl-4 text-2xs">
                        {derived.skipped.slice(0, 8).map((sk, i) => (
                          <li key={`${sk.taskId}-${i}`}>
                            <span className="font-medium">{sk.taskName}</span>: {sk.reason}
                          </li>
                        ))}
                      </ul>
                    </Alert>
                  ) : null}
                  <ReasonList reasons={[derived.calendar.source, ...derived.reasons]} />
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Demand by trade"
              subtitle={p.peakHeadcountBasis}
            />
            <CardBody>
              {p.byResourceType.length > 0 ? (
                <Table dense>
                  <thead>
                    <tr>
                      <Th>Trade / plant class</Th>
                      <Th align="right">Hours</Th>
                      <Th align="right">Share</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.byResourceType.map((r) => (
                      <tr key={r.resourceTypeId}>
                        <Td>
                          {r.name ?? "Unknown"}{" "}
                          <span className="text-2xs text-content-subtle">{r.code ?? ""}</span>
                        </Td>
                        <Td align="right">{hours(r.demandHours)}</Td>
                        <Td align="right">
                          {p.demandHours > 0 ? percent((r.demandHours / p.demandHours) * 100) : "—"}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="No demand rows yet" size="sm" bordered={false} />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Every demand row" subtitle="Derived rows carry the activity they came from" />
            <CardBody flush>
              {demand.error ? (
                <div className="p-3">
                  <LoadError message={demand.error} onRetry={demand.reload} />
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  <Table dense>
                    <thead>
                      <tr>
                        <Th>Week</Th>
                        <Th>Trade</Th>
                        <Th align="right">Hours</Th>
                        <Th align="right">People</Th>
                        <Th>Source</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {(demand.data?.items ?? []).map((d) => (
                        <tr key={d.id} title={d.basis ?? undefined}>
                          <Td>{dateOnly(d.weekStart)}</Td>
                          <Td>{d.resourceTypeName ?? d.resourceTypeId}</Td>
                          <Td align="right">{num(d.demandHours)}</Td>
                          <Td align="right">{count(d.headcount)}</Td>
                          <Td>
                            <Badge tone={d.source === "schedule" ? "info" : "neutral"} size="xs">
                              {titleCase(d.source)}
                            </Badge>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {(demand.data?.items.length ?? 0) === 0 ? (
                    <div className="p-4">
                      <EmptyState
                        title="No demand rows"
                        hint="Derive from the programme, or add a row by hand for a trade the schedule does not model."
                        size="sm"
                      />
                    </div>
                  ) : null}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

function CreatePlanModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const [name, setName] = useState("");
  const [planKind, setPlanKind] = useState("current");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New resource plan"
      description="A plan is a version, not a document you edit. Activating it supersedes the previous live one."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={action.busy === "create"}
            disabled={name.trim().length === 0}
            onClick={async () => {
              const res = await action.run("create", () =>
                resourcesApi.createPlan(projectId, { name: name.trim(), planKind }),
              );
              if (res) {
                toast.success(`${res.reference} created`);
                setName("");
                onCreated(res.id);
              }
            }}
          >
            Create
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Construction resourcing" />
        </Field>
        <Field
          label="Kind"
          hint="Baseline never moves; current is what we intend to do now; a scenario is a what-if and is never mistaken for either."
        >
          <Select value={planKind} onChange={(e) => setPlanKind(e.target.value)}>
            <option value="current">Current</option>
            <option value="baseline">Baseline</option>
            <option value="scenario">Scenario</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function SupplyModal({
  open,
  projectId,
  types,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  types: ResourceType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const today = mondayOf(todayIso());
  const [typeId, setTypeId] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(shiftIso(today, 12 * 7));
  const [availableHours, setAvailableHours] = useState("200");
  const [source, setSource] = useState("roster");

  const existing = useResource<Paginated<AvailabilityRow>>(
    open && typeId
      ? `/api/v1/projects/${projectId}/resource-availability?resourceTypeId=${typeId}&pageSize=100`
      : null,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="State what this project can field"
      description="One statement per trade per week. A second statement replaces the first — two half-remembered figures for the same week would silently double the supply on the histogram."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={action.busy === "save"}
            disabled={typeId === "" || Number.isNaN(Number(availableHours))}
            onClick={async () => {
              const res = await action.run("save", () =>
                resourcesApi.bulkAvailability(projectId, {
                  resourceTypeId: typeId,
                  from,
                  to,
                  availableHours: Number(availableHours),
                  source,
                }),
              );
              if (res) {
                toast.success(`${res.weeks} weeks set`);
                onSaved();
              }
            }}
          >
            Set supply
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <Field label="Trade or plant class" required>
          <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">Choose…</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From (week beginning)">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hours available each week">
            <Input
              type="number"
              value={availableHours}
              onChange={(e) => setAvailableHours(e.target.value)}
            />
          </Field>
          <Field
            label="How firm is this?"
            hint="Assumed supply is reported distinctly — coverage that rests on people nobody has committed is a plan, not a fact."
          >
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="roster">Roster</option>
              <option value="vendor_commitment">Vendor commitment</option>
              <option value="assumed">Assumed</option>
              <option value="manual">Manual</option>
            </Select>
          </Field>
        </div>
        {existing.data && existing.data.items.length > 0 ? (
          <div className="rounded-md border border-border-subtle p-2">
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Already stated for this trade
            </div>
            <div className="max-h-40 overflow-y-auto">
              <Table dense>
                <thead>
                  <tr>
                    <Th>Week</Th>
                    <Th align="right">Hours</Th>
                    <Th>Source</Th>
                  </tr>
                </thead>
                <tbody>
                  {existing.data.items.map((a) => (
                    <tr key={a.id}>
                      <Td>{dateOnly(a.weekStart)}</Td>
                      <Td align="right">{num(a.availableHours)}</Td>
                      <Td>{titleCase(a.source)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
