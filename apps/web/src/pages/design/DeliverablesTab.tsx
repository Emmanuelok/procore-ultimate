/**
 * DELIVERABLES — the consultant deliverable schedule (#254, #887, #909) and
 * the appointed design team with its professional indemnity cover (#912).
 *
 * Every row carries the engine's verdict AND the reasons behind it. A
 * deliverable holds an open obligation while it is outstanding; issuing it
 * satisfies that obligation and stamps the lateness it was issued at.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  DESIGN_CONSULTANT_STATUSES,
  DESIGN_DELIVERABLE_STATUSES,
  DESIGN_DELIVERABLE_TYPES,
  DESIGN_DISCIPLINES,
  DESIGN_SLIPPAGE_LEVELS,
} from "@constructos/shared";
import { Alert, Badge, Button, Card, CardBody, Drawer, EmptyState, Field, Input, Select, Skeleton, Stat, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus, IconRefresh, IconVendor } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  DELIVERABLE_STATUS_TONE,
  EM_DASH,
  FigureCell,
  KeyValue,
  LoadError,
  ReasonList,
  RefusalNotice,
  SLIPPAGE_TONE,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  money,
  num,
  optionList,
  pct,
  useAction,
  useResource,
  type ConsultantRow,
  type DeliverableDetail,
  type DeliverableRow,
  type ListResponse,
  type Lookups,
  type PerformanceResponse,
} from "./designShared";

export default function DeliverablesTab({
  projectId,
  lookups,
  onChanged,
}: {
  projectId: string;
  lookups: Lookups;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/design`;
  const [status, setStatus] = useState("");
  const [level, setLevel] = useState("");
  const [consultantFilter, setConsultantFilter] = useState("");
  const query = new URLSearchParams({ pageSize: "500" });
  if (status) query.set("status", status);
  if (level) query.set("slippageLevel", level);
  if (consultantFilter) query.set("consultantId", consultantFilter);
  const deliverables = useResource<ListResponse<DeliverableRow>>(`${base}/deliverables?${query.toString()}`);
  const consultants = useResource<ListResponse<ConsultantRow>>(`${base}/consultants?pageSize=200`);
  const performance = useResource<PerformanceResponse>(`${base}/deliverables-performance`);
  const [createOpen, setCreateOpen] = useState(false);
  const [consultantOpen, setConsultantOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<DeliverableDetail>(openId ? `${base}/deliverables/${openId}` : null);
  const action = useAction();

  function changed() {
    deliverables.reload();
    consultants.reload();
    performance.reload();
    detail.reload();
    onChanged();
  }

  async function recompute() {
    const r = await action.run("recompute", () =>
      api.post<{ assessed: number; signalsRaised: number; obligationsOpened: number; byLevel: Record<string, number> }>(
        `${base}/deliverables/recompute`,
        {},
      ),
    );
    if (r) {
      toast.success(`${r.assessed} deliverable(s) re-assessed · ${r.signalsRaised} new signal(s)`);
      changed();
    }
  }

  async function piCheck() {
    const r = await action.run("pi", () =>
      api.post<{ consultants: number; inadequate: number; signalsRaised: number }>(`${base}/consultants/pi-check`, {}),
    );
    if (r) {
      toast.success(
        r.inadequate > 0
          ? `${r.inadequate} consultant(s) with inadequate cover · ${r.signalsRaised} new signal(s)`
          : "Every recorded policy meets its requirement",
      );
      changed();
    }
  }

  const consultantName = useMemo(
    () => new Map((consultants.data?.items ?? []).map((c) => [c.id, c.name])),
    [consultants.data],
  );
  const packageRef = useMemo(() => new Map(lookups.packages.map((p) => [p.id, p.reference])), [lookups.packages]);

  const columns = useMemo<DataColumns<DeliverableRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 100, mono: true },
      { id: "title", header: "Deliverable", accessor: "title", type: "text", width: 250 },
      {
        id: "deliverableType",
        header: "Type",
        accessor: "deliverableType",
        type: "text",
        width: 120,
        groupable: true,
        cell: ({ row }) => labelize(row.deliverableType),
      },
      {
        id: "consultant",
        header: "Consultant",
        accessor: (row) => (row.consultantId ? consultantName.get(row.consultantId) ?? row.consultantId : ""),
        type: "text",
        width: 180,
        groupable: true,
      },
      {
        id: "package",
        header: "Package",
        accessor: (row) => (row.packageId ? packageRef.get(row.packageId) ?? row.packageId : ""),
        type: "text",
        width: 110,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={DELIVERABLE_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "slippageLevel",
        header: "Slippage",
        accessor: "slippageLevel",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <span title={row.slippageReasons.join(" ")}>
            <Badge tone={SLIPPAGE_TONE[row.slippageLevel] ?? "neutral"} size="xs" dot>
              {labelize(row.slippageLevel)}
            </Badge>
          </span>
        ),
      },
      {
        id: "slippageDays",
        header: "Slip (d)",
        accessor: (row) => row.slippageDays,
        type: "number",
        width: 90,
        signColor: true,
        cell: ({ row }) => (row.slippageDays === null ? <span className="italic text-content-subtle">n/a</span> : num(row.slippageDays)),
      },
      {
        id: "plannedIssueDate",
        header: "Planned issue",
        accessor: (row) => row.plannedIssueDate ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => (row.plannedIssueDate ? isoDate(row.plannedIssueDate) : <span className="italic text-content-subtle">not set</span>),
      },
      {
        id: "forecastIssueDate",
        header: "Forecast",
        accessor: (row) => row.forecastIssueDate ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => (row.forecastIssueDate ? isoDate(row.forecastIssueDate) : EM_DASH),
      },
      {
        id: "actualIssueDate",
        header: "Issued",
        accessor: (row) => row.actualIssueDate ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => (row.actualIssueDate ? isoDate(row.actualIssueDate) : <span className="italic text-content-subtle">outstanding</span>),
      },
      { id: "revision", header: "Rev", accessor: (row) => row.revision ?? "", type: "text", width: 70 },
    ],
    [consultantName, packageRef],
  );

  const perf = performance.data;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardBody>
            <Stat
              label="Late"
              value={perf ? num(perf.overall.outstandingLate) : EM_DASH}
              tone={perf && perf.overall.outstandingLate > 0 ? "danger" : "neutral"}
              hint={perf ? `${perf.overall.total} on the schedule` : undefined}
              loading={performance.loading && !perf}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Issued on time"
              value={<FigureCell value={perf?.overall.onTimePercent} reasons={perf?.overall.reasons ?? []} render={(v) => pct(v)} />}
              hint={perf ? `${perf.overall.issuedOnTime} on time · ${perf.overall.issuedLate} late` : undefined}
              loading={performance.loading && !perf}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Average slip"
              value={<FigureCell value={perf?.overall.averageSlippageDays} reasons={perf?.overall.reasons ?? []} render={(v) => `${num(v, 1)} d`} />}
              hint={perf?.overall.worstSlippageDays !== null && perf?.overall.worstSlippageDays !== undefined ? `worst ${num(perf.overall.worstSlippageDays)} d` : undefined}
              loading={performance.loading && !perf}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Consultants"
              value={consultants.data ? num(consultants.data.items.length) : EM_DASH}
              hint={
                consultants.data
                  ? `${consultants.data.items.filter((c) => c.pi?.adequate === false).length} with inadequate PI · ${consultants.data.items.filter((c) => c.pi?.adequate === null).length} unknown`
                  : undefined
              }
              tone={consultants.data && consultants.data.items.some((c) => c.pi?.adequate === false) ? "warning" : "neutral"}
              loading={consultants.loading && !consultants.data}
            />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Consultant deliverable schedule"
            hint="Slippage is measured against the planned issue date and, where a construction task is linked, against the date that task needs the information. A deliverable with no planned date is not assessed — and says so."
            actions={
              <>
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {DESIGN_DELIVERABLE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Select size="sm" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Slippage filter">
                  <option value="">All slippage levels</option>
                  {DESIGN_SLIPPAGE_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {labelize(l)}
                    </option>
                  ))}
                </Select>
                <Select size="sm" value={consultantFilter} onChange={(e) => setConsultantFilter(e.target.value)} aria-label="Consultant filter">
                  {optionList(consultants.data?.items ?? [], (c) => c.name, "All consultants").map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="secondary" leadingIcon={IconRefresh} loading={action.busy === "recompute"} onClick={() => void recompute()}>
                  Re-assess
                </Button>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                  Add deliverable
                </Button>
              </>
            }
          />
          {deliverables.error ? <LoadError message={deliverables.error} onRetry={deliverables.reload} /> : null}
          <DataTable<DeliverableRow>
            tableId="design-deliverables"
            data={deliverables.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={deliverables.loading && !deliverables.data}
            height={520}
            stickyHeader
            filterRow
            exportFileName="design-deliverables"
            searchPlaceholder="Search by reference or title…"
            defaultSort={[{ id: "plannedIssueDate", desc: false }]}
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.slippageLevel === "late" ? "danger" : row.slippageLevel === "at_risk" ? "warning" : undefined)}
            empty={{
              title: "No deliverable is scheduled",
              description: "Register the drawings, models, specifications and reports the design team owes, with the date each is planned for.",
              action: (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Add the first deliverable
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading title="Slippage by consultant" hint="Worst first. A consultant with no measurable issue shows the reason instead of a fabricated zero." />
          {performance.error ? <LoadError message={performance.error} onRetry={performance.reload} /> : null}
          {(perf?.byConsultant ?? []).length === 0 ? (
            <EmptyState icon={IconVendor} title="No deliverable is attributed to a consultant yet" />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {(perf?.byConsultant ?? []).map((entry) => (
                <li key={entry.consultantId ?? "none"} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-meta text-content">{entry.name}</div>
                    <div className="text-2xs text-content-subtle">
                      {entry.total} deliverable{entry.total === 1 ? "" : "s"} · {entry.issued} issued
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {entry.late > 0 ? (
                      <Badge tone="danger" size="xs" dot>
                        {entry.late} late
                      </Badge>
                    ) : null}
                    {entry.atRisk > 0 ? (
                      <Badge tone="warning" size="xs" dot>
                        {entry.atRisk} at risk
                      </Badge>
                    ) : null}
                    <span className="text-meta tabular-nums text-content-muted">
                      {entry.averageSlippageDays === null ? (
                        <span className="italic text-content-subtle">no measurable issue</span>
                      ) : (
                        `${num(entry.averageSlippageDays, 1)} d average slip`
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <ConsultantsPanel
        base={base}
        consultants={consultants}
        action={action}
        onAdd={() => setConsultantOpen(true)}
        onPiCheck={() => void piCheck()}
        onChanged={changed}
      />

      <DeliverableForm
        base={base}
        open={createOpen}
        lookups={lookups}
        consultants={consultants.data?.items ?? []}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          changed();
        }}
      />
      <ConsultantForm
        base={base}
        open={consultantOpen}
        lookups={lookups}
        onClose={() => setConsultantOpen(false)}
        onCreated={() => {
          setConsultantOpen(false);
          changed();
        }}
      />
      <DeliverableDrawer base={base} deliverableId={openId} detail={detail} onClose={() => setOpenId(null)} onChanged={changed} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ConsultantsPanel({
  base,
  consultants,
  action,
  onAdd,
  onPiCheck,
  onChanged,
}: {
  base: string;
  consultants: ReturnType<typeof useResource<ListResponse<ConsultantRow>>>;
  action: ReturnType<typeof useAction>;
  onAdd: () => void;
  onPiCheck: () => void;
  onChanged: () => void;
}) {
  async function verify(consultantId: string) {
    const r = await action.run(`verify-${consultantId}`, () => api.post(`${base}/consultants/${consultantId}/verify-pi`, {}));
    if (r) {
      toast.success("Cover verified");
      onChanged();
    }
  }

  const rows = consultants.data?.items ?? [];

  return (
    <Card>
      <CardBody>
        <SectionHeading
          title="Design team & professional indemnity"
          hint="Cover below the appointment's requirement, expired, or expiring inside 60 days raises a signal. A policy with no recorded requirement is reported as unknown, never as adequate."
          actions={
            <>
              <Button size="sm" variant="secondary" loading={action.busy === "pi"} onClick={onPiCheck}>
                Test every policy
              </Button>
              <Button size="sm" leadingIcon={IconPlus} onClick={onAdd}>
                Appoint a consultant
              </Button>
            </>
          }
        />
        {consultants.error ? <LoadError message={consultants.error} onRetry={consultants.reload} /> : null}
        {consultants.loading && rows.length === 0 ? <Skeleton className="h-24 w-full" /> : null}
        {rows.length === 0 && !consultants.loading ? (
          <EmptyState icon={IconVendor} title="No consultant is appointed" description="Record the design team so deliverables and information requirements can be attributed." />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {rows.map((consultant) => (
              <li key={consultant.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-meta font-medium text-content">{consultant.name}</span>
                    <Badge tone="neutral" size="xs">
                      {labelize(consultant.discipline)}
                    </Badge>
                    <Badge tone={consultant.status === "terminated" ? "danger" : "neutral"} size="xs" dot>
                      {labelize(consultant.status)}
                    </Badge>
                    {consultant.pi ? (
                      <Badge tone={consultant.pi.adequate === true ? "success" : consultant.pi.adequate === false ? "danger" : "warning"} size="xs" dot>
                        {consultant.pi.adequate === true ? "PI adequate" : consultant.pi.adequate === false ? "PI inadequate" : "PI unknown"}
                      </Badge>
                    ) : null}
                    {consultant.piVerifiedAt ? (
                      <span className="text-2xs text-content-subtle">verified {isoDate(consultant.piVerifiedAt)}</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-2xs text-content-muted">
                    {consultant.role ? `${consultant.role} · ` : ""}
                    {consultant.piCoverAmount !== null
                      ? `cover ${money(consultant.piCoverAmount, consultant.piCurrency ?? consultant.currency)}`
                      : "no cover recorded"}
                    {consultant.piRequiredAmount !== null
                      ? ` against ${money(consultant.piRequiredAmount, consultant.piCurrency ?? consultant.currency)} required`
                      : " · no requirement recorded"}
                    {consultant.piExpiresOn ? ` · expires ${isoDate(consultant.piExpiresOn)}` : ""}
                  </div>
                  {consultant.pi ? <ReasonList reasons={consultant.pi.reasons} className="mt-1" /> : null}
                </div>
                {!consultant.piVerifiedAt && consultant.piCoverAmount !== null ? (
                  <Button size="xs" variant="secondary" loading={action.busy === `verify-${consultant.id}`} onClick={() => void verify(consultant.id)}>
                    Verify cover
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function DeliverableForm({
  base,
  open,
  lookups,
  consultants,
  onClose,
  onCreated,
}: {
  base: string;
  open: boolean;
  lookups: Lookups;
  consultants: ConsultantRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [title, setTitle] = useState("");
  const [deliverableType, setDeliverableType] = useState("drawing");
  const [discipline, setDiscipline] = useState("multi_discipline");
  const [packageId, setPackageId] = useState("");
  const [consultantId, setConsultantId] = useState("");
  const [scheduleTaskId, setScheduleTaskId] = useState("");
  const [plannedIssueDate, setPlannedIssueDate] = useState("");
  const [forecastIssueDate, setForecastIssueDate] = useState("");
  const [requiredOnSite, setRequiredOnSite] = useState("");
  const [revision, setRevision] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { title: title.trim(), deliverableType, discipline };
    if (packageId) payload["packageId"] = packageId;
    if (consultantId) payload["consultantId"] = consultantId;
    if (scheduleTaskId) payload["scheduleTaskId"] = scheduleTaskId;
    if (plannedIssueDate) payload["plannedIssueDate"] = plannedIssueDate;
    if (forecastIssueDate) payload["forecastIssueDate"] = forecastIssueDate;
    if (requiredOnSite) payload["requiredOnSite"] = requiredOnSite;
    if (revision.trim()) payload["revision"] = revision.trim();
    const r = await action.run("create", () => api.post<DeliverableRow>(`${base}/deliverables`, payload));
    if (r) {
      toast.success(`${r.reference} registered — ${labelize(r.slippageLevel).toLowerCase()}`);
      setTitle("");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Add a deliverable"
      description="Link the construction task it feeds and the engine will flag it when the information arrives too late to be useful."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="Facade GA drawings" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">
            <Select value={deliverableType} onChange={(e) => setDeliverableType(e.target.value)}>
              {DESIGN_DELIVERABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Discipline">
            <Select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DESIGN_DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {labelize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Consultant">
            <Select value={consultantId} onChange={(e) => setConsultantId(e.target.value)}>
              {optionList(consultants, (c) => `${c.name} (${labelize(c.discipline)})`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Package">
            <Select value={packageId} onChange={(e) => setPackageId(e.target.value)}>
              {optionList(lookups.packages, (p) => `${p.reference} — ${p.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Feeds construction task" className="sm:col-span-2">
            <Select value={scheduleTaskId} onChange={(e) => setScheduleTaskId(e.target.value)}>
              {optionList(lookups.tasks, (t) => `${t.name}${t.isCritical === 1 ? " (critical)" : ""}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Planned issue date">
            <Input type="date" value={plannedIssueDate} onChange={(e) => setPlannedIssueDate(e.target.value)} />
          </Field>
          <Field label="Forecast issue date">
            <Input type="date" value={forecastIssueDate} onChange={(e) => setForecastIssueDate(e.target.value)} />
          </Field>
          <Field label="Required on site">
            <Input type="date" value={requiredOnSite} onChange={(e) => setRequiredOnSite(e.target.value)} />
          </Field>
          <Field label="Revision">
            <Input value={revision} onChange={(e) => setRevision(e.target.value)} maxLength={20} />
          </Field>
        </div>
        <ReasonList reasons={lookups.notes} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"} disabled={!title.trim()}>
            Register
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function ConsultantForm({
  base,
  open,
  lookups,
  onClose,
  onCreated,
}: {
  base: string;
  open: boolean;
  lookups: Lookups;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [name, setName] = useState("");
  const [discipline, setDiscipline] = useState("multi_discipline");
  const [role, setRole] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [status, setStatus] = useState("appointed");
  const [appointedAt, setAppointedAt] = useState("");
  const [feeValue, setFeeValue] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [piRequiredAmount, setPiRequiredAmount] = useState("");
  const [piCoverAmount, setPiCoverAmount] = useState("");
  const [piCurrency, setPiCurrency] = useState("USD");
  const [piExpiresOn, setPiExpiresOn] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { name: name.trim(), discipline, currency: currency.toUpperCase() };
    if (role.trim()) payload["role"] = role.trim();
    if (vendorId) payload["vendorId"] = vendorId;
    if (appointedAt) payload["appointedAt"] = appointedAt;
    if (feeValue.trim()) payload["feeValue"] = Number(feeValue);
    if (piRequiredAmount.trim()) payload["piRequiredAmount"] = Number(piRequiredAmount);
    if (piCoverAmount.trim()) payload["piCoverAmount"] = Number(piCoverAmount);
    if (piCoverAmount.trim() || piRequiredAmount.trim()) payload["piCurrency"] = piCurrency.toUpperCase();
    if (piExpiresOn) payload["piExpiresOn"] = piExpiresOn;
    const r = await action.run("create", () => api.post(`${base}/consultants`, payload));
    if (r) {
      toast.success("Consultant appointed");
      setName("");
      onCreated();
    }
    void status;
  }

  return (
    <Drawer open={open} onClose={onClose} size="md" title="Appoint a design consultant" description="Recording the PI requirement is what makes the adequacy check possible; without it the platform reports 'unknown' rather than implying the cover is fine.">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Discipline">
            <Select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DESIGN_DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {labelize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Lead designer" />
          </Field>
          <Field label="Vendor record">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Appointment status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} disabled>
              {DESIGN_CONSULTANT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Appointed on">
            <Input type="date" value={appointedAt} onChange={(e) => setAppointedAt(e.target.value)} />
          </Field>
          <Field label="Fee">
            <Input type="number" value={feeValue} onChange={(e) => setFeeValue(e.target.value)} />
          </Field>
          <Field label="Fee currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
          </Field>
          <Field label="PI required">
            <Input type="number" value={piRequiredAmount} onChange={(e) => setPiRequiredAmount(e.target.value)} />
          </Field>
          <Field label="PI cover held">
            <Input type="number" value={piCoverAmount} onChange={(e) => setPiCoverAmount(e.target.value)} />
          </Field>
          <Field label="PI currency">
            <Input value={piCurrency} onChange={(e) => setPiCurrency(e.target.value)} maxLength={3} />
          </Field>
          <Field label="PI expires on">
            <Input type="date" value={piExpiresOn} onChange={(e) => setPiExpiresOn(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"} disabled={!name.trim()}>
            Appoint
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function DeliverableDrawer({
  base,
  deliverableId,
  detail,
  onClose,
  onChanged,
}: {
  base: string;
  deliverableId: string | null;
  detail: ReturnType<typeof useResource<DeliverableDetail>>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [issueDate, setIssueDate] = useState("");
  const [issueRevision, setIssueRevision] = useState("");
  const [forecast, setForecast] = useState("");
  const [notes, setNotes] = useState("");
  const row = detail.data;

  async function issue() {
    const payload: Record<string, unknown> = {};
    if (issueDate) payload["actualIssueDate"] = issueDate;
    if (issueRevision.trim()) payload["revision"] = issueRevision.trim();
    const r = await action.run("issue", () => api.post(`${base}/deliverables/${deliverableId}/issue`, payload));
    if (r) {
      toast.success("Recorded as issued");
      onChanged();
    }
  }

  async function accept() {
    const r = await action.run("accept", () => api.post(`${base}/deliverables/${deliverableId}/accept`, {}));
    if (r) {
      toast.success("Accepted");
      onChanged();
    }
  }

  async function reject() {
    const reason = window.prompt("Why is it rejected?");
    if (!reason) return;
    const r = await action.run("reject", () => api.post(`${base}/deliverables/${deliverableId}/reject`, { reason }));
    if (r) onChanged();
  }

  async function reforecast() {
    const payload: Record<string, unknown> = {};
    if (forecast) payload["forecastIssueDate"] = forecast;
    if (notes.trim()) payload["notes"] = notes.trim();
    const r = await action.run("forecast", () => api.patch(`${base}/deliverables/${deliverableId}`, payload));
    if (r) {
      toast.success("Forecast updated and re-assessed");
      onChanged();
    }
  }

  return (
    <Drawer open={deliverableId !== null} onClose={onClose} size="md" title={row ? `${row.reference} — ${row.title}` : "Deliverable"}>
      <div className="space-y-4">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
        {detail.loading && !row ? <Skeleton className="h-40 w-full" /> : null}
        {row ? (
          <>
            <div className="rounded-lg border border-border-subtle bg-surface-sunken p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SLIPPAGE_TONE[row.assessment.level] ?? "neutral"} size="sm" dot>
                  {labelize(row.assessment.level)}
                </Badge>
                {row.assessment.slippageDays !== null ? (
                  <span className="text-meta tabular-nums text-content">{num(row.assessment.slippageDays)} day slip</span>
                ) : null}
                {row.assessment.blocksTask ? (
                  <Badge tone="danger" size="xs">
                    blocks the task it feeds
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-2xs text-content-muted">{row.assessment.basis}</p>
              <ReasonList reasons={row.assessment.reasons} className="mt-1.5" />
            </div>

            <KeyValue
              items={[
                { label: "Status", value: <Badge tone={DELIVERABLE_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
                { label: "Type", value: labelize(row.deliverableType) },
                { label: "Consultant", value: row.consultant?.name ?? EM_DASH },
                { label: "Feeds task", value: row.task ? `${row.task.name}${row.task.isCritical === 1 ? " (critical)" : ""}` : EM_DASH },
                { label: "Planned issue", value: isoDate(row.plannedIssueDate) },
                { label: "Forecast issue", value: isoDate(row.forecastIssueDate) },
                { label: "Actual issue", value: row.actualIssueDate ? isoDate(row.actualIssueDate) : "outstanding" },
                { label: "Required on site", value: isoDate(row.requiredOnSite) },
                { label: "Accepted", value: row.acceptedAt ? dateTime(row.acceptedAt) : EM_DASH },
                { label: "Revision", value: row.revision ?? EM_DASH },
              ]}
            />

            {row.obligation ? (
              <Alert tone={row.obligation.status === "open" ? "info" : "success"} title={`Obligation ${labelize(row.obligation.status).toLowerCase()}`}>
                {row.obligation.trigger}
              </Alert>
            ) : null}
            {row.rejectedReason ? <Alert tone="warning" title="Rejected">{row.rejectedReason}</Alert> : null}

            {row.status !== "accepted" && row.status !== "cancelled" ? (
              <div className="space-y-2 rounded-lg border border-border-subtle p-3">
                {row.actualIssueDate === null ? (
                  <>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Field label="Issue date">
                        <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
                      </Field>
                      <Field label="Revision">
                        <Input value={issueRevision} onChange={(e) => setIssueRevision(e.target.value)} maxLength={20} />
                      </Field>
                      <div className="flex items-end">
                        <Button size="sm" loading={action.busy === "issue"} onClick={() => void issue()}>
                          Record as issued
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Field label="Re-forecast to">
                        <Input type="date" value={forecast} onChange={(e) => setForecast(e.target.value)} />
                      </Field>
                      <Field label="Note" className="sm:col-span-2">
                        <Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} />
                      </Field>
                    </div>
                    <Button size="sm" variant="secondary" loading={action.busy === "forecast"} onClick={() => void reforecast()} disabled={!forecast && !notes.trim()}>
                      Update forecast
                    </Button>
                  </>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" loading={action.busy === "accept"} onClick={() => void accept()}>
                      Accept
                    </Button>
                    <Button size="sm" variant="ghost" loading={action.busy === "reject"} onClick={() => void reject()}>
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
