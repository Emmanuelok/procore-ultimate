/**
 * STAGES & PACKAGES — the project's stage plan against the canonical library
 * (#888–#889) and the packages that move through it (#253, #886). A gate
 * cannot be signed off while a criterion is unmet, and the refusal names it;
 * a package is approved by someone other than whoever raised it.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DESIGN_DISCIPLINES, DESIGN_PACKAGE_STATUSES, DESIGN_STAGE_FRAMEWORKS, DESIGN_STAGE_KEYS } from "@constructos/shared";
import { Alert, Badge, Button, Card, CardBody, Checkbox, Drawer, EmptyState, Field, Input, Select, Skeleton, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconCheck, IconLock, IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  GATE_STATUS_TONE,
  KeyValue,
  LoadError,
  PACKAGE_STATUS_TONE,
  READINESS_TONE,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  num,
  optionList,
  useAction,
  useResource,
  type GateCriterion,
  type ListResponse,
  type Lookups,
  type PackageDetail,
  type PackageRow,
  type StagesResponse,
} from "./designShared";

export default function PackagesTab({
  projectId,
  lookups,
  onChanged,
}: {
  projectId: string;
  lookups: Lookups;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/design`;
  const [framework, setFramework] = useState("riba_2020");
  const [status, setStatus] = useState("");
  const [discipline, setDiscipline] = useState("");
  const stages = useResource<StagesResponse>(`${base}/stages?framework=${framework}`);
  const query = new URLSearchParams({ pageSize: "500" });
  if (status) query.set("status", status);
  if (discipline) query.set("discipline", discipline);
  const packages = useResource<ListResponse<PackageRow>>(`${base}/packages?${query.toString()}`);
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<PackageDetail>(openId ? `${base}/packages/${openId}` : null);
  const action = useAction();

  function changed() {
    packages.reload();
    stages.reload();
    detail.reload();
    onChanged();
  }

  const stageLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of stages.data?.library ?? []) map.set(stage.key, stage.label);
    return map;
  }, [stages.data]);

  const columns = useMemo<DataColumns<PackageRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 90, mono: true },
      { id: "name", header: "Package", accessor: "name", type: "text", width: 240 },
      {
        id: "discipline",
        header: "Discipline",
        accessor: "discipline",
        type: "text",
        width: 150,
        groupable: true,
        cell: ({ row }) => labelize(row.discipline),
      },
      {
        id: "stage",
        header: "Stage",
        accessor: (row) => (row.stageKey ? stageLabel.get(row.stageKey) ?? row.stageKey : ""),
        type: "text",
        width: 180,
        groupable: true,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <Badge tone={PACKAGE_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
              {labelize(row.status)}
            </Badge>
            {row.frozenAt ? <IconLock className="h-3.5 w-3.5 text-content-subtle" aria-label="Frozen" /> : null}
          </span>
        ),
      },
      { id: "revision", header: "Rev", accessor: (row) => row.revision ?? "", type: "text", width: 70 },
      { id: "reviews", header: "Cycles", accessor: "reviewCount", type: "number", width: 80 },
      {
        id: "openComments",
        header: "Open comments",
        accessor: "openCommentCount",
        type: "number",
        width: 130,
        cell: ({ row }) => (row.openCommentCount > 0 ? <span className="text-warning-fg">{row.openCommentCount}</span> : "0"),
      },
      {
        id: "openIssues",
        header: "Open issues",
        accessor: "openIssueCount",
        type: "number",
        width: 110,
        cell: ({ row }) => (row.openIssueCount > 0 ? <span className="text-warning-fg">{row.openIssueCount}</span> : "0"),
      },
      {
        id: "dcns",
        header: "DCNs",
        accessor: "dcnCount",
        type: "number",
        width: 100,
        cell: ({ row }) => (
          <span>
            {row.dcnCount}
            {row.postFreezeDcnCount > 0 ? <span className="ml-1 text-2xs text-danger-fg">({row.postFreezeDcnCount} post-freeze)</span> : null}
          </span>
        ),
      },
      {
        id: "plannedIssueDate",
        header: "Planned issue",
        accessor: (row) => row.plannedIssueDate ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => isoDate(row.plannedIssueDate),
      },
      {
        id: "approvedAt",
        header: "Approved",
        accessor: (row) => row.approvedAt ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => (row.approvedAt ? isoDate(row.approvedAt) : <span className="italic text-content-subtle">not approved</span>),
      },
    ],
    [stageLabel],
  );

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {lookups.notes.length > 0 ? (
        <Alert tone="warning" title="Some pickers could not be filled">
          <ReasonList reasons={lookups.notes} />
        </Alert>
      ) : null}

      <StagePlan
        base={base}
        stages={stages}
        framework={framework}
        onFramework={setFramework}
        action={action}
        onChanged={changed}
      />

      <Card>
        <CardBody>
          <SectionHeading
            title="Design packages"
            hint="The unit that is issued, reviewed, approved and frozen. Approval must come from someone other than whoever raised the package, and an approved package is changed through a design change notice rather than edited in place."
            actions={
              <>
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {DESIGN_PACKAGE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Select size="sm" value={discipline} onChange={(e) => setDiscipline(e.target.value)} aria-label="Discipline filter">
                  <option value="">All disciplines</option>
                  {DESIGN_DISCIPLINES.map((d) => (
                    <option key={d} value={d}>
                      {labelize(d)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                  New package
                </Button>
              </>
            }
          />
          {packages.error ? <LoadError message={packages.error} onRetry={packages.reload} /> : null}
          <DataTable<PackageRow>
            tableId="design-packages"
            data={packages.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={packages.loading && !packages.data}
            height={480}
            stickyHeader
            filterRow
            exportFileName="design-packages"
            searchPlaceholder="Search by reference or name…"
            defaultSort={[{ id: "reference", desc: false }]}
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) => (row.postFreezeDcnCount > 0 ? "danger" : row.openIssueCount > 0 ? "warning" : undefined)}
            empty={{
              title: "No design package",
              description: "Register the bundles the design team will issue: the substructure package, the facade package, the MEP services package.",
              action: (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Register the first package
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <PackageForm
        base={base}
        open={createOpen}
        lookups={lookups}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          changed();
        }}
      />
      <PackageDrawer base={base} packageId={openId} detail={detail} onClose={() => setOpenId(null)} onChanged={changed} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StagePlan({
  base,
  stages,
  framework,
  onFramework,
  action,
  onChanged,
}: {
  base: string;
  stages: ReturnType<typeof useResource<StagesResponse>>;
  framework: string;
  onFramework: (v: string) => void;
  action: ReturnType<typeof useAction>;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [stageKey, setStageKey] = useState<string>("stage_2");
  const [plannedEnd, setPlannedEnd] = useState("");
  const [criteriaText, setCriteriaText] = useState("");

  const data = stages.data;
  const planned = new Set((data?.gates ?? []).map((g) => g.stageKey));
  const available = (data?.library ?? []).filter((s) => !planned.has(s.key));

  async function addGate(e: FormEvent) {
    e.preventDefault();
    const criteria: GateCriterion[] = criteriaText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((label, index) => ({ key: `c${index + 1}`, label, met: false }));
    const r = await action.run("gate", () =>
      api.post(`${base}/stages`, {
        stageKey,
        framework,
        ...(plannedEnd ? { plannedEnd } : {}),
        criteria,
      }),
    );
    if (r) {
      toast.success("Stage gate added");
      setCriteriaText("");
      setAdding(false);
      onChanged();
    }
  }

  async function toggleCriterion(gateId: string, criteria: GateCriterion[], index: number) {
    const next = criteria.map((c, i) => (i === index ? { ...c, met: !c.met } : c));
    const r = await action.run(`criterion-${gateId}-${index}`, () => api.patch(`${base}/stages/${gateId}`, { criteria: next }));
    if (r) onChanged();
  }

  async function signOff(gateId: string, force: boolean) {
    const r = await action.run(`signoff-${gateId}`, () => api.post(`${base}/stages/${gateId}/sign-off`, { force }));
    if (r) {
      toast.success(force ? "Gate signed off with the unmet criteria recorded" : "Gate signed off");
      onChanged();
    }
  }

  return (
    <Card>
      <CardBody>
        <SectionHeading
          title="Stage plan"
          hint="RIBA 2020, the AIA phases and the ISO 19650 information stages are the same journey in three vocabularies; the plan is held once and rendered in whichever the project speaks."
          actions={
            <>
              <Select size="sm" value={framework} onChange={(e) => onFramework(e.target.value)} aria-label="Stage framework">
                {DESIGN_STAGE_FRAMEWORKS.map((f) => (
                  <option key={f} value={f}>
                    {labelize(f)}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="secondary" leadingIcon={IconPlus} onClick={() => setAdding((v) => !v)} disabled={available.length === 0}>
                Add a gate
              </Button>
            </>
          }
        />
        {stages.error ? <LoadError message={stages.error} onRetry={stages.reload} /> : null}
        {stages.loading && !data ? <Skeleton className="h-24 w-full" /> : null}

        {adding ? (
          <form onSubmit={(e) => void addGate(e)} className="mb-4 grid gap-3 rounded-lg border border-border-subtle bg-surface-sunken p-3 md:grid-cols-3">
            <Field label="Stage">
              <Select value={stageKey} onChange={(e) => setStageKey(e.target.value)}>
                {available.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Planned end">
              <Input type="date" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} />
            </Field>
            <Field label="Gate criteria (one per line)" className="md:col-span-3">
              <Textarea rows={3} value={criteriaText} onChange={(e) => setCriteriaText(e.target.value)} placeholder={"Coordinated model signed off\nCost plan within budget\nPlanning permission granted"} />
            </Field>
            <div className="md:col-span-3">
              <Button size="sm" type="submit" loading={action.busy === "gate"}>
                Add gate
              </Button>
            </div>
          </form>
        ) : null}

        {data && data.outOfOrder.length > 0 ? (
          <Alert tone="warning" title="The stage plan has been passed out of order" className="mb-3">
            {data.outOfOrder.map((key) => labelize(key)).join(", ")} {data.outOfOrder.length === 1 ? "is" : "are"} still open while a
            later stage has been signed off. That is recorded, not corrected.
          </Alert>
        ) : null}

        {data && data.gates.length === 0 ? (
          <EmptyState
            icon={IconCheck}
            title="No stage gate is planned"
            description="Add the stages this project will pass through and the criteria each gate must satisfy. A gate cannot be signed off while a criterion is unmet unless it is deliberately overridden."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {(data?.gates ?? []).map((gate) => (
              <div key={gate.id} className="rounded-lg border border-border-subtle bg-surface-raised p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-meta font-semibold text-content">{gate.displayLabel ?? gate.stageKey}</div>
                    <div className="text-2xs text-content-subtle">
                      {gate.plannedEnd ? `planned end ${isoDate(gate.plannedEnd)}` : "no planned end"} · {gate.packages.approved}/
                      {gate.packages.total} package(s) approved
                    </div>
                  </div>
                  <Badge tone={GATE_STATUS_TONE[gate.status] ?? "neutral"} size="xs" dot>
                    {labelize(gate.status)}
                  </Badge>
                </div>
                <ul className="mt-2 space-y-1">
                  {gate.criteria.length === 0 ? (
                    <li className="text-2xs italic text-content-subtle">No criteria recorded — the gate can be signed off freely.</li>
                  ) : (
                    gate.criteria.map((criterion, index) => (
                      <li key={criterion.key} className="flex items-start gap-2">
                        <Checkbox
                          checked={criterion.met}
                          disabled={gate.status === "signed_off" || action.busy === `criterion-${gate.id}-${index}`}
                          onChange={() => void toggleCriterion(gate.id, gate.criteria, index)}
                          aria-label={criterion.label}
                        />
                        <span className={criterion.met ? "text-2xs text-content-muted line-through" : "text-2xs text-content"}>{criterion.label}</span>
                      </li>
                    ))
                  )}
                </ul>
                {gate.status === "signed_off" ? (
                  <p className="mt-2 text-2xs text-content-muted">
                    Signed off {dateTime(gate.signedOffAt)}
                    {gate.signOffNotes ? ` — ${gate.signOffNotes}` : ""}
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="xs"
                      variant="secondary"
                      loading={action.busy === `signoff-${gate.id}`}
                      onClick={() => void signOff(gate.id, false)}
                    >
                      Sign off
                    </Button>
                    {gate.blockers.length > 0 ? (
                      <Button size="xs" variant="ghost" onClick={() => void signOff(gate.id, true)}>
                        Override {gate.blockers.length}
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function PackageForm({
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
  const [description, setDescription] = useState("");
  const [discipline, setDiscipline] = useState("multi_discipline");
  const [stageKey, setStageKey] = useState("");
  const [leadVendorId, setLeadVendorId] = useState("");
  const [consultantId, setConsultantId] = useState("");
  const [plannedIssueDate, setPlannedIssueDate] = useState("");
  const [revision, setRevision] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { name: name.trim(), discipline };
    if (description.trim()) payload["description"] = description.trim();
    if (stageKey) payload["stageKey"] = stageKey;
    if (leadVendorId) payload["leadVendorId"] = leadVendorId;
    if (consultantId) payload["consultantId"] = consultantId;
    if (plannedIssueDate) payload["plannedIssueDate"] = plannedIssueDate;
    if (revision.trim()) payload["revision"] = revision.trim();
    const r = await action.run("create", () => api.post<PackageRow>(`${base}/packages`, payload));
    if (r) {
      toast.success(`${r.reference} registered`);
      setName("");
      setDescription("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Register a design package" size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="Facade technical design" />
        </Field>
        <Field label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
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
          <Field label="Stage">
            <Select value={stageKey} onChange={(e) => setStageKey(e.target.value)}>
              <option value="">— not assigned —</option>
              {DESIGN_STAGE_KEYS.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lead consultant">
            <Select value={consultantId} onChange={(e) => setConsultantId(e.target.value)}>
              {optionList(lookups.consultants, (c) => `${c.name} (${labelize(c.discipline)})`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lead vendor">
            <Select value={leadVendorId} onChange={(e) => setLeadVendorId(e.target.value)}>
              {optionList(lookups.vendors, (v) => v.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Planned issue date">
            <Input type="date" value={plannedIssueDate} onChange={(e) => setPlannedIssueDate(e.target.value)} />
          </Field>
          <Field label="Revision">
            <Input value={revision} onChange={(e) => setRevision(e.target.value)} maxLength={20} placeholder="P01" />
          </Field>
        </div>
        <div className="flex gap-2 pt-2">
          <Button type="submit" loading={action.busy === "create"} disabled={!name.trim()}>
            Register package
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

const TRANSITIONS: Record<string, string[]> = {
  planned: ["in_progress", "cancelled"],
  in_progress: ["in_review", "planned", "cancelled"],
  in_review: ["approved", "in_progress", "cancelled"],
  approved: ["superseded", "in_progress"],
  frozen: ["superseded"],
  superseded: [],
  cancelled: [],
};

function PackageDrawer({
  base,
  packageId,
  detail,
  onClose,
  onChanged,
}: {
  base: string;
  packageId: string | null;
  detail: ReturnType<typeof useResource<PackageDetail>>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [freezeTitle, setFreezeTitle] = useState("");
  const row = detail.data;

  async function transition(to: string) {
    const r = await action.run(`to-${to}`, () => api.post(`${base}/packages/${packageId}/transition`, { to }));
    if (r) {
      toast.success(`Moved to ${labelize(to).toLowerCase()}`);
      onChanged();
    }
  }

  async function freeze() {
    const r = await action.run("freeze", () =>
      api.post(`${base}/freezes`, {
        scope: "package",
        packageId,
        title: freezeTitle.trim() || `Freeze on ${row?.reference ?? "package"}`,
        requiredAuthorisation: "client",
      }),
    );
    if (r) {
      toast.success("Design freeze declared");
      setFreezeTitle("");
      onChanged();
    }
  }

  async function lift(freezeId: string) {
    const reason = window.prompt("Why is the freeze being lifted?");
    if (!reason) return;
    const r = await action.run(`lift-${freezeId}`, () => api.post(`${base}/freezes/${freezeId}/lift`, { reason }));
    if (r) {
      toast.success("Freeze lifted");
      onChanged();
    }
  }

  return (
    <Drawer open={packageId !== null} onClose={onClose} title={row ? `${row.reference} — ${row.name}` : "Design package"} size="lg">
      <div className="space-y-4">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
        {detail.loading && !row ? <Skeleton className="h-40 w-full" /> : null}
        {row ? (
          <>
            <KeyValue
              items={[
                { label: "Status", value: <Badge tone={PACKAGE_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
                { label: "Discipline", value: labelize(row.discipline) },
                { label: "Stage", value: row.stageKey ? labelize(row.stageKey) : EM_DASH },
                { label: "Revision", value: row.revision ?? EM_DASH },
                { label: "Planned issue", value: isoDate(row.plannedIssueDate) },
                { label: "Approved", value: row.approvedAt ? dateTime(row.approvedAt) : EM_DASH },
                { label: "Frozen", value: row.frozenAt ? dateTime(row.frozenAt) : "not frozen" },
                { label: "Cycles / open comments", value: `${row.reviewCount} / ${row.openCommentCount}` },
              ]}
            />
            {row.description ? <p className="text-meta text-content-muted">{row.description}</p> : null}

            <div className="flex flex-wrap gap-2">
              {(TRANSITIONS[row.status] ?? []).map((to) => (
                <Button key={to} size="sm" variant="secondary" loading={action.busy === `to-${to}`} onClick={() => void transition(to)}>
                  {labelize(to)}
                </Button>
              ))}
              {row.status === "approved" && !row.frozenAt ? (
                <span className="flex items-center gap-2">
                  <Input size="sm" value={freezeTitle} onChange={(e) => setFreezeTitle(e.target.value)} placeholder="Freeze title" className="w-48" />
                  <Button size="sm" leadingIcon={IconLock} loading={action.busy === "freeze"} onClick={() => void freeze()}>
                    Declare a freeze
                  </Button>
                </span>
              ) : null}
            </div>

            <div>
              <SectionHeading title="Handover readiness for this package" hint="Computed live; not a stored snapshot." />
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={READINESS_TONE[row.readiness.level] ?? "neutral"} size="sm" dot>
                  {labelize(row.readiness.level)}
                </Badge>
                <span className="text-meta tabular-nums text-content">
                  {row.readiness.score === null ? "no score" : `${num(row.readiness.score, 1)} / 100`}
                </span>
                <span className="text-2xs text-content-muted">{Math.round(row.readiness.confidence * 100)}% of the weighting had inputs</span>
              </div>
              <ReasonList reasons={row.readiness.blockers} className="mt-2" tone="danger" />
              <ReasonList reasons={row.readiness.reasons} className="mt-1" />
            </div>

            {row.freezes.length > 0 ? (
              <div>
                <SectionHeading title="Freezes covering this package" />
                <ul className="divide-y divide-border-subtle">
                  {row.freezes.map((freezeRow) => (
                    <li key={freezeRow.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-meta text-content">{freezeRow.title}</div>
                        <div className="text-2xs text-content-subtle">
                          {labelize(freezeRow.scope)} · from {dateTime(freezeRow.effectiveFrom)} · needs{" "}
                          {labelize(freezeRow.requiredAuthorisation).toLowerCase()} authorisation
                          {freezeRow.status === "lifted" ? ` · lifted ${dateTime(freezeRow.liftedAt)}` : ""}
                        </div>
                      </div>
                      {freezeRow.status === "active" ? (
                        <Button size="xs" variant="ghost" loading={action.busy === `lift-${freezeRow.id}`} onClick={() => void lift(freezeRow.id)}>
                          Lift
                        </Button>
                      ) : (
                        <Badge tone="neutral" size="xs">
                          lifted
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-2">
              <MiniList
                title="Review cycles"
                empty="No cycle has been issued for this package."
                rows={row.reviews.map((r) => ({
                  id: r.id,
                  primary: `${r.reference} — cycle ${r.cycleNumber}`,
                  secondary: `${labelize(r.status)}${r.consolidatedCode ? ` · code ${r.consolidatedCode}` : ""}${r.dueAt ? ` · due ${isoDate(r.dueAt)}` : ""}`,
                }))}
              />
              <MiniList
                title="Change notices"
                empty="No change notice has been raised against this package."
                rows={row.changeNotices.map((n) => ({
                  id: n.id,
                  primary: `${n.reference} — ${n.title}`,
                  secondary: `${labelize(n.status)}${n.isPostFreeze === 1 ? " · post-freeze" : ""} · needs ${labelize(n.requiredAuthorisation).toLowerCase()}`,
                }))}
              />
              <MiniList
                title="Open issues"
                empty="No issue is open against this package."
                rows={row.issues
                  .filter((i) => ["open", "assigned", "in_progress"].includes(i.status))
                  .map((i) => ({ id: i.id, primary: `${i.reference} — ${i.title}`, secondary: `${labelize(i.priority)} · ${labelize(i.discipline)}` }))}
              />
              <MiniList
                title="Deliverables"
                empty="No deliverable is scheduled against this package."
                rows={row.deliverables.map((d) => ({
                  id: d.id,
                  primary: `${d.reference} — ${d.title}`,
                  secondary: `${labelize(d.slippageLevel)}${d.plannedIssueDate ? ` · planned ${isoDate(d.plannedIssueDate)}` : ""}`,
                }))}
              />
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}

function MiniList({ title, rows, empty }: { title: string; rows: Array<{ id: string; primary: string; secondary: string }>; empty: string }) {
  return (
    <div>
      <h3 className="mb-1.5 text-meta font-semibold text-content">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-2xs italic text-content-subtle">{empty}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {rows.map((row) => (
            <li key={row.id} className="py-1.5">
              <div className="truncate text-meta text-content">{row.primary}</div>
              <div className="text-2xs text-content-subtle">{row.secondary}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
