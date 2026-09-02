/**
 * READINESS & INFORMATION — the design-to-construction handover readiness
 * assessment (#907–#908) and the ISO 19650 information requirements
 * (EIR / BEP / TIDP / MIDP).
 *
 * A dimension with no inputs scores nothing and says why; it is never scored
 * zero, because "we have no information" and "the information is bad" are
 * different statements and a handover decision turns on which one it is.
 */
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DESIGN_INFO_REQUIREMENT_KINDS, DESIGN_INFO_REQUIREMENT_STATUSES, DESIGN_STAGE_KEYS } from "@constructos/shared";
import { Alert, Badge, Button, Card, CardBody, Drawer, Field, Input, Progress, Select, Skeleton, Stat, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus, IconRefresh } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  FigureCell,
  INFO_STATUS_TONE,
  LoadError,
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
  type InfoRequirementRow,
  type ListResponse,
  type Lookups,
  type ReadinessResponse,
} from "./designShared";

export default function ReadinessTab({
  projectId,
  lookups,
  onChanged,
}: {
  projectId: string;
  lookups: Lookups;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/design`;
  const [scopePackageId, setScopePackageId] = useState("");
  const readiness = useResource<ReadinessResponse>(
    `${base}/readiness${scopePackageId ? `?packageId=${scopePackageId}` : ""}`,
  );
  const [statusFilter, setStatusFilter] = useState("");
  const query = new URLSearchParams({ pageSize: "300" });
  if (statusFilter) query.set("status", statusFilter);
  const requirements = useResource<ListResponse<InfoRequirementRow>>(`${base}/information-requirements?${query.toString()}`);
  const [createOpen, setCreateOpen] = useState(false);
  const action = useAction();

  function changed() {
    readiness.reload();
    requirements.reload();
    onChanged();
  }

  async function recompute() {
    const r = await action.run("recompute", () =>
      api.post<{ level: string; score: number | null; snapshotWritten: boolean }>(`${base}/readiness/recompute`, {
        packageId: scopePackageId || null,
      }),
    );
    if (r) {
      toast.success(
        r.snapshotWritten
          ? `Readiness is ${labelize(r.level).toLowerCase()} — snapshot written`
          : `Readiness is ${labelize(r.level).toLowerCase()} — unchanged, so no snapshot`,
      );
      changed();
    }
  }

  async function sweep() {
    const r = await action.run("sweep", () =>
      api.post<{ overdue: number; obligationsOpened: number; signalsRaised: number }>(`${base}/information-requirements/sweep`, {}),
    );
    if (r) {
      toast.success(`${r.overdue} overdue · ${r.obligationsOpened} obligation(s) opened · ${r.signalsRaised} signal(s)`);
      changed();
    }
  }

  async function deliver(id: string) {
    const r = await action.run(`deliver-${id}`, () => api.post(`${base}/information-requirements/${id}/deliver`, {}));
    if (r) changed();
  }

  async function verify(id: string) {
    const note = window.prompt("What did you check?") ?? undefined;
    const r = await action.run(`verify-${id}`, () => api.post(`${base}/information-requirements/${id}/verify`, note ? { note } : {}));
    if (r) {
      toast.success("Verified");
      changed();
    }
  }

  async function waive(id: string) {
    const reason = window.prompt("Why is this requirement waived?");
    if (!reason) return;
    const r = await action.run(`waive-${id}`, () => api.post(`${base}/information-requirements/${id}/waive`, { reason }));
    if (r) changed();
  }

  const columns: DataColumns<InfoRequirementRow> = [
    { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 90, mono: true },
    { id: "kind", header: "Kind", accessor: "kind", type: "text", width: 100, groupable: true, cell: ({ row }) => row.kind.toUpperCase() },
    { id: "title", header: "Requirement", accessor: "title", type: "text", width: 280 },
    {
      id: "status",
      header: "Status",
      accessor: "status",
      type: "status",
      width: 120,
      groupable: true,
      cell: ({ row }) => (
        <Badge tone={INFO_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
          {labelize(row.status)}
        </Badge>
      ),
    },
    {
      id: "dueDate",
      header: "Due",
      accessor: (row) => row.dueDate ?? "",
      type: "date",
      width: 120,
      cell: ({ row }) => (row.dueDate ? isoDate(row.dueDate) : <span className="italic text-content-subtle">no date</span>),
    },
    {
      id: "deliveredAt",
      header: "Delivered",
      accessor: (row) => row.deliveredAt ?? "",
      type: "date",
      width: 130,
      cell: ({ row }) => (row.deliveredAt ? isoDate(row.deliveredAt) : EM_DASH),
    },
    {
      id: "verifiedAt",
      header: "Verified",
      accessor: (row) => row.verifiedAt ?? "",
      type: "date",
      width: 130,
      cell: ({ row }) => (row.verifiedAt ? isoDate(row.verifiedAt) : <span className="italic text-content-subtle">not verified</span>),
    },
    {
      id: "actions",
      header: "",
      width: 220,
      cell: ({ row }) => (
        <span className="flex gap-1.5">
          {row.status === "planned" || row.status === "in_progress" || row.status === "overdue" ? (
            <Button size="xs" variant="secondary" loading={action.busy === `deliver-${row.id}`} onClick={() => void deliver(row.id)}>
              Deliver
            </Button>
          ) : null}
          {row.status === "delivered" ? (
            <Button size="xs" loading={action.busy === `verify-${row.id}`} onClick={() => void verify(row.id)}>
              Verify
            </Button>
          ) : null}
          {row.status !== "verified" && row.status !== "waived" ? (
            <Button size="xs" variant="ghost" loading={action.busy === `waive-${row.id}`} onClick={() => void waive(row.id)}>
              Waive
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  const r = readiness.data;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

      <Card>
        <CardBody>
          <SectionHeading
            title="Design-to-construction handover readiness"
            hint="Six weighted dimensions. A dimension with no inputs is dropped from the weighting and lowers the confidence — it is never scored zero."
            actions={
              <>
                <Select size="sm" value={scopePackageId} onChange={(e) => setScopePackageId(e.target.value)} aria-label="Scope">
                  {optionList(lookups.packages, (p) => `${p.reference} — ${p.name}`, "Whole project").map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="secondary" leadingIcon={IconRefresh} loading={action.busy === "recompute"} onClick={() => void recompute()}>
                  Recompute & snapshot
                </Button>
              </>
            }
          />
          {readiness.error ? <LoadError message={readiness.error} onRetry={readiness.reload} /> : null}
          {readiness.loading && !r ? <Skeleton className="h-40 w-full" /> : null}
          {r ? (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Card>
                  <CardBody>
                    <Stat
                      label="Verdict"
                      value={
                        <Badge tone={READINESS_TONE[r.level] ?? "neutral"} size="sm" dot>
                          {labelize(r.level)}
                        </Badge>
                      }
                      hint={r.computedAt ? `computed ${dateTime(r.computedAt)}` : undefined}
                    />
                  </CardBody>
                </Card>
                <Card>
                  <CardBody>
                    <Stat
                      label="Score"
                      value={<FigureCell value={r.score} reasons={r.reasons} render={(v) => `${num(v, 1)} / 100`} />}
                      hint="Weighted across the dimensions that had inputs"
                    />
                  </CardBody>
                </Card>
                <Card>
                  <CardBody>
                    <Stat label="Confidence" value={`${Math.round(r.confidence * 100)}%`} hint="Share of the weighting with real inputs" tone={r.confidence < 0.4 ? "warning" : "neutral"} />
                  </CardBody>
                </Card>
                <Card>
                  <CardBody>
                    <Stat label="Blockers" value={num(r.blockers.length)} tone={r.blockers.length > 0 ? "danger" : "success"} hint="Named, not scored away" />
                  </CardBody>
                </Card>
              </div>

              {r.blockers.length > 0 ? (
                <Alert tone="warning" title="What is holding the design back" className="mt-3">
                  <ReasonList reasons={r.blockers} />
                </Alert>
              ) : null}
              <ReasonList reasons={r.reasons} className="mt-3" />

              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {r.dimensions.map((dimension) => (
                  <div key={dimension.key} className="rounded-lg border border-border-subtle bg-surface-raised p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-meta font-semibold text-content">{dimension.label}</div>
                        <div className="text-2xs text-content-subtle">weight {Math.round(dimension.weight * 100)}%</div>
                      </div>
                      <div className="text-right">
                        {dimension.score === null ? (
                          <span className="text-meta italic text-content-subtle">no inputs</span>
                        ) : (
                          <span className="text-body font-semibold tabular-nums text-content">{num(dimension.score, 1)}</span>
                        )}
                      </div>
                    </div>
                    {dimension.score !== null ? <Progress value={dimension.score} max={100} className="mt-2" /> : null}
                    <p className="mt-1.5 text-2xs text-content-muted">{dimension.basis}</p>
                    <ReasonList reasons={dimension.reasons} className="mt-1" />
                  </div>
                ))}
              </div>

              {r.history.length > 1 ? (
                <div className="mt-4">
                  <SectionHeading title="Readiness over time" hint="Snapshots are written only when the verdict moves." />
                  <ul className="flex flex-wrap gap-3">
                    {r.history.map((entry) => (
                      <li key={entry.id} className="rounded border border-border-subtle px-2 py-1">
                        <div className="text-2xs text-content-subtle">{isoDate(entry.computedAt)}</div>
                        <div className="flex items-center gap-1.5">
                          <Badge tone={READINESS_TONE[entry.level] ?? "neutral"} size="xs">
                            {labelize(entry.level)}
                          </Badge>
                          <span className="text-meta tabular-nums text-content">{entry.score === null ? EM_DASH : num(entry.score, 1)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading
            title="Information requirements"
            hint="EIR, BEP, OIR/AIR/PIR, TIDP and MIDP milestones. Each one with a due date holds an obligation, and verification must come from someone other than whoever delivered it."
            actions={
              <>
                <Select size="sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {DESIGN_INFO_REQUIREMENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="secondary" leadingIcon={IconRefresh} loading={action.busy === "sweep"} onClick={() => void sweep()}>
                  Sweep for overdue
                </Button>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                  Add a requirement
                </Button>
              </>
            }
          />
          {requirements.error ? <LoadError message={requirements.error} onRetry={requirements.reload} /> : null}
          <DataTable<InfoRequirementRow>
            tableId="design-information-requirements"
            data={requirements.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={requirements.loading && !requirements.data}
            height={420}
            stickyHeader
            filterRow
            exportFileName="design-information-requirements"
            searchPlaceholder="Search by reference or title…"
            defaultSort={[{ id: "dueDate", desc: false }]}
            rowTone={(row) => (row.status === "overdue" ? "danger" : undefined)}
            empty={{
              title: "No information requirement is registered",
              description: "An information requirement nobody delivered is the quiet start of most design disputes. Register the EIR, the BEP and the TIDP milestones with the dates they are owed.",
              action: (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Add the first requirement
                </Button>
              ),
            }}
          />
        </CardBody>
      </Card>

      <RequirementForm
        base={base}
        open={createOpen}
        lookups={lookups}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          changed();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RequirementForm({
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
  const [kind, setKind] = useState("eir");
  const [title, setTitle] = useState("");
  const [requirement, setRequirement] = useState("");
  const [stageKey, setStageKey] = useState("");
  const [packageId, setPackageId] = useState("");
  const [consultantId, setConsultantId] = useState("");
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [dueDate, setDueDate] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { kind, title: title.trim() };
    if (requirement.trim()) payload["requirement"] = requirement.trim();
    if (stageKey) payload["stageKey"] = stageKey;
    if (packageId) payload["packageId"] = packageId;
    if (consultantId) payload["consultantId"] = consultantId;
    if (responsibleUserId) payload["responsibleUserId"] = responsibleUserId;
    if (dueDate) payload["dueDate"] = dueDate;
    const r = await action.run("create", () => api.post<InfoRequirementRow>(`${base}/information-requirements`, payload));
    if (r) {
      toast.success(`${r.reference} registered`);
      setTitle("");
      setRequirement("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} size="md" title="Add an information requirement" description="Give it a due date and the platform will hold an obligation against it and flag it when it goes past.">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {DESIGN_INFO_REQUIREMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="What is required">
          <Textarea rows={3} value={requirement} onChange={(e) => setRequirement(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Stage">
            <Select value={stageKey} onChange={(e) => setStageKey(e.target.value)}>
              <option value="">— not stage-specific —</option>
              {DESIGN_STAGE_KEYS.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
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
          <Field label="Consultant">
            <Select value={consultantId} onChange={(e) => setConsultantId(e.target.value)}>
              {optionList(lookups.consultants, (c) => c.name).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Responsible person">
            <Select value={responsibleUserId} onChange={(e) => setResponsibleUserId(e.target.value)}>
              {optionList(lookups.users, (u) => u.name || u.email).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
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
