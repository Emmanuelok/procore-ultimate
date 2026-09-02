/**
 * ACTION PLANS (#447–#456).
 *
 * The drawer is the point of this tab: it shows, activity by activity, what
 * stands between the plan and closure — missing evidence, missing signatures,
 * a quality checkpoint holding everything behind it. Those blockers come from
 * the API's own engine, so the screen and the server can never disagree about
 * whether something may be signed.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Field,
  Input,
  Progress,
  Select,
  StatusPill,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconApproval, IconPlus } from "../../ui/icons";
import {
  DASH,
  DueBadge,
  LoadError,
  LoadingBlock,
  PLAN_STATUSES,
  ReasonList,
  Row,
  activityTone,
  corrApi,
  count,
  dateTime,
  isoDate,
  pct,
  planTone,
  titleCase,
  todayIso,
  useAction,
  useLocations,
  useResource,
  type ActionPlan,
  type ActionPlanDetail,
  type ActionPlanTemplate,
  type Paginated,
} from "./correspondenceShared";

export default function ActionPlansTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (status) params.set("status", status);
  if (overdueOnly) params.set("overdueOnly", "true");
  if (search.trim()) params.set("q", search.trim());

  const list = useResource<Paginated<ActionPlan>>(
    `/api/v1/projects/${projectId}/correspondence/action-plans?${params.toString()}`,
  );

  const columns = useMemo<DataColumns<ActionPlan>>(
    () => [
      { id: "reference", header: "Reference", accessor: "reference", type: "code", width: 100, mono: true },
      { id: "title", header: "Plan", accessor: "title", type: "text", width: 300 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => <StatusPill status={row.status} size="xs" />,
      },
      {
        id: "progressPercent",
        header: "Progress",
        accessor: (row) => row.progressPercent ?? -1,
        type: "number",
        align: "right",
        width: 160,
        cell: ({ row }) =>
          row.progressPercent === null ? (
            <span className="text-content-subtle" title="This plan has no activities, so there is nothing to measure.">
              {DASH}
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Progress
                value={row.progressPercent}
                size="sm"
                tone={row.status === "blocked" ? "danger" : row.progressPercent === 100 ? "success" : "info"}
                className="w-20"
              />
              <span className="tabular-nums text-2xs">{pct(row.progressPercent)}</span>
            </span>
          ),
      },
      {
        id: "activities",
        header: "Activities",
        accessor: (row) => row.activityCount,
        type: "number",
        align: "right",
        width: 110,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.completedCount}/{row.activityCount}
          </span>
        ),
      },
      {
        id: "anchor",
        header: "Anchored to",
        accessor: (row) => titleCase(row.anchor),
        type: "text",
        width: 130,
      },
      {
        id: "dueDate",
        header: "Due",
        accessor: (row) => row.dueDate ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => <DueBadge date={row.dueDate} daysOverdue={row.overdue ? 1 : null} />,
      },
      {
        id: "blockedReason",
        header: "Held by",
        accessor: (row) => row.blockedReason ?? "",
        type: "text",
        width: 280,
        cell: ({ row }) =>
          row.blockedReason ? (
            <span className="text-danger-text">{row.blockedReason}</span>
          ) : (
            <span className="text-content-subtle">{DASH}</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Any</option>
              {PLAN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="sm"
              placeholder="Reference or title…"
            />
          </Field>
          <label className="flex items-center gap-2 pb-1 text-meta text-content-muted">
            <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
            Overdue only
          </label>
          <div className="ml-auto">
            <Button icon={IconPlus} onClick={() => setCreating(true)}>
              New action plan
            </Button>
          </div>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<ActionPlan>
          tableId="correspondence.actionPlans"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={540}
          rowHeight={44}
          stickyHeader
          exportFileName="action-plans"
          empty={{
            title: "No action plans yet",
            description:
              "An action plan is a set of required activities with evidence and sign-off — the way a hold point is enforced rather than hoped for.",
            action: <Button onClick={() => setCreating(true)}>Create the first plan</Button>,
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.status === "blocked" ? "danger" : row.overdue ? "warning" : undefined)}
          aria-label="Action plans"
        />
      )}

      <PlanCreateDrawer
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          list.reload();
          onChanged();
          setOpenId(id);
        }}
      />
      <PlanDrawer
        projectId={projectId}
        planId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/* ================================= Create ================================= */

interface ActivityDraft {
  title: string;
  evidenceRequired: boolean;
  evidenceRequirement: string;
  isQualityCheckpoint: boolean;
  dueOffsetDays: string;
  signoffLabels: string;
}

const emptyActivity = (): ActivityDraft => ({
  title: "",
  evidenceRequired: false,
  evidenceRequirement: "",
  isQualityCheckpoint: false,
  dueOffsetDays: "",
  signoffLabels: "",
});

function PlanCreateDrawer({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const templates = useResource<{ items: ActionPlanTemplate[] }>(
    `/api/v1/correspondence/action-plan-templates?projectId=${projectId}`,
  );
  const locations = useLocations(projectId);
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [anchor, setAnchor] = useState("none");
  const [locationId, setLocationId] = useState("");
  const [scheduleTaskId, setScheduleTaskId] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState("");
  const [activities, setActivities] = useState<ActivityDraft[]>([]);

  useEffect(() => {
    if (!open) return;
    setTemplateId("");
    setTitle("");
    setAnchor("none");
    setLocationId("");
    setScheduleTaskId("");
    setStartDate(todayIso());
    setDueDate("");
    setActivities([]);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      anchor,
      startDate,
      activities: activities
        .filter((a) => a.title.trim() !== "")
        .map((a) => ({
          title: a.title.trim(),
          evidenceRequired: a.evidenceRequired,
          evidenceRequirement: a.evidenceRequirement.trim() || null,
          isQualityCheckpoint: a.isQualityCheckpoint,
          dueOffsetDays: a.dueOffsetDays === "" ? null : Number(a.dueOffsetDays),
          signoffParties: a.signoffLabels
            .split(",")
            .map((l) => l.trim())
            .filter((l) => l !== "")
            .map((label) => ({ partyType: "user", label })),
        })),
    };
    if (templateId) payload["templateId"] = templateId;
    if (title.trim()) payload["title"] = title.trim();
    if (anchor === "location") payload["locationId"] = locationId;
    if (anchor === "schedule_task") payload["scheduleTaskId"] = scheduleTaskId;
    if (dueDate) payload["dueDate"] = dueDate;
    const created = await action.run("create", () => corrApi.createPlan(projectId, payload));
    if (created) {
      toast.success(`${created.reference} created as a draft.`);
      onCreated(created.id);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title="New action plan"
      description="Start from a template, or define the required activities here. A plan enforces nothing until it is activated."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-plan-create" loading={action.busy === "create"}>
            Create draft
          </Button>
        </div>
      }
    >
      <form id="corr-plan-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <Field label="Template" hint="Optional — its activities, evidence rules and sign-offs are copied in.">
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">No template — define the activities below</option>
            {(templates.data?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (v{t.version}, {t.activityCount ?? 0} activities)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" required={!templateId} hint={templateId ? "Defaults to the template name" : undefined}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Anchored to" hint="What the plan is about (#453)">
            <Select value={anchor} onChange={(e) => setAnchor(e.target.value)}>
              <option value="none">Nothing in particular</option>
              <option value="location">A location</option>
              <option value="schedule_task">A schedule task</option>
            </Select>
          </Field>
          {anchor === "location" ? (
            <Field label="Location" required>
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
                <option value="">Choose…</option>
                {(locations.data?.items ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : anchor === "schedule_task" ? (
            <Field label="Schedule task id" required>
              <Input value={scheduleTaskId} onChange={(e) => setScheduleTaskId(e.target.value)} required />
            </Field>
          ) : (
            <div />
          )}
          <Field label="Start date">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Plan due date">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>

        {templateId ? null : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-meta font-semibold text-content">Required activities</span>
              <Button
                size="sm"
                variant="ghost"
                icon={IconPlus}
                onClick={() => setActivities((a) => [...a, emptyActivity()])}
              >
                Add
              </Button>
            </div>
            {activities.length === 0 ? (
              <p className="text-2xs text-content-subtle">
                A plan with no activities cannot be activated — it would enforce nothing.
              </p>
            ) : null}
            {activities.map((activity, index) => (
              <div key={index} className="space-y-2 rounded-md border border-border p-2">
                <Input
                  size="sm"
                  placeholder="What must be done"
                  value={activity.title}
                  onChange={(e) =>
                    setActivities((rows) => rows.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)))
                  }
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    size="sm"
                    placeholder="Signatories, comma separated"
                    value={activity.signoffLabels}
                    onChange={(e) =>
                      setActivities((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, signoffLabels: e.target.value } : r)),
                      )
                    }
                  />
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    placeholder="Due, days after start"
                    value={activity.dueOffsetDays}
                    onChange={(e) =>
                      setActivities((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, dueOffsetDays: e.target.value } : r)),
                      )
                    }
                  />
                </div>
                <Input
                  size="sm"
                  placeholder="Evidence requirement (leave blank if none)"
                  value={activity.evidenceRequirement}
                  onChange={(e) =>
                    setActivities((rows) =>
                      rows.map((r, i) =>
                        i === index
                          ? { ...r, evidenceRequirement: e.target.value, evidenceRequired: e.target.value.trim() !== "" }
                          : r,
                      ),
                    )
                  }
                />
                <label className="flex items-center gap-2 text-2xs text-content-muted">
                  <input
                    type="checkbox"
                    checked={activity.isQualityCheckpoint}
                    onChange={(e) =>
                      setActivities((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, isQualityCheckpoint: e.target.checked } : r)),
                      )
                    }
                  />
                  Quality checkpoint — holds every activity after it until it is signed off
                  <button
                    type="button"
                    className="ml-auto text-danger-text hover:underline"
                    onClick={() => setActivities((rows) => rows.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </label>
              </div>
            ))}
          </div>
        )}
      </form>
    </Drawer>
  );
}

/* ================================= Detail ================================= */

function PlanDrawer({
  projectId,
  planId,
  onClose,
  onChanged,
}: {
  projectId: string;
  planId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useResource<ActionPlanDetail>(
    planId ? `/api/v1/projects/${projectId}/correspondence/action-plans/${planId}` : null,
  );
  const action = useAction();
  const [evidenceIds, setEvidenceIds] = useState<Record<string, string>>({});
  const [waiveReason, setWaiveReason] = useState<Record<string, string>>({});

  useEffect(() => {
    setEvidenceIds({});
    setWaiveReason({});
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  const plan = detail.data;

  async function run(key: string, fn: () => Promise<unknown>, message: string) {
    const result = await action.run(key, fn);
    if (result) {
      toast.success(message);
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={planId !== null}
      onClose={onClose}
      size="lg"
      title={plan ? `${plan.reference} · ${plan.title}` : "Action plan"}
      description={plan ? `${titleCase(plan.status)} · ${plan.activityCount} activities` : undefined}
    >
      {detail.loading && !plan ? <LoadingBlock /> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {plan ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}

          {plan.status === "draft" ? (
            <Button
              size="sm"
              icon={IconApproval}
              loading={action.busy === "activate"}
              onClick={() =>
                run("activate", () => corrApi.activatePlan(projectId, plan.id), `${plan.reference} is active.`)
              }
            >
              Activate
            </Button>
          ) : null}

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Progress</h3>
            {plan.progress.percent === null ? (
              <ReasonList reasons={plan.progress.reasons} />
            ) : (
              <>
                <Progress
                  value={plan.progress.percent}
                  tone={plan.status === "blocked" ? "danger" : plan.progress.percent === 100 ? "success" : "info"}
                  label={`${plan.progress.signedOff + plan.progress.waived} of ${plan.progress.total} closed`}
                />
                <dl className="mt-2 divide-y divide-border">
                  <Row label="Signed off">{count(plan.progress.signedOff)}</Row>
                  <Row label="Waived" hint="Closed by decision, not by performance">
                    {count(plan.progress.waived)}
                  </Row>
                  <Row label="Outstanding">{count(plan.progress.outstanding)}</Row>
                  <Row label="Overdue">{count(plan.progress.overdue)}</Row>
                  <Row label="Next up">
                    {plan.progress.nextActivity
                      ? `${plan.progress.nextActivity.seq}. ${plan.progress.nextActivity.title}`
                      : DASH}
                  </Row>
                </dl>
                <ReasonList reasons={plan.progress.reasons} className="mt-1" />
              </>
            )}
            {plan.blockedReason ? (
              <Alert tone="danger" size="sm" className="mt-2">
                {plan.blockedReason}
              </Alert>
            ) : null}
          </section>

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Activities</h3>
            <ul className="space-y-2">
              {plan.activities.map((activity) => (
                <li key={activity.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-meta font-medium text-content">
                        {activity.seq}. {activity.title}
                        {activity.isQualityCheckpoint === 1 ? (
                          <Badge tone="accent" size="xs" className="ml-2">
                            hold point
                          </Badge>
                        ) : null}
                      </div>
                      {activity.evidenceRequirement ? (
                        <div className="text-2xs text-content-subtle">
                          Evidence: {activity.evidenceRequirement}
                        </div>
                      ) : null}
                      <div className="mt-0.5 text-2xs text-content-subtle">
                        {activity.signoffCount}/{activity.signoffRequiredCount} signatures ·{" "}
                        {activity.evidenceFileIds.length} evidence file(s)
                        {activity.dueDate ? ` · due ${isoDate(activity.dueDate)}` : ""}
                      </div>
                    </div>
                    <Badge tone={activityTone(activity.status)} size="xs" dot>
                      {titleCase(activity.status)}
                    </Badge>
                  </div>

                  {activity.readiness && !activity.readiness.ready && activity.status !== "signed_off" ? (
                    <ReasonList reasons={activity.readiness.blockers} className="mt-2" />
                  ) : null}

                  {activity.status !== "signed_off" && activity.status !== "waived" ? (
                    <div className="mt-2 space-y-2">
                      <div className="flex gap-2">
                        <Input
                          size="sm"
                          placeholder="Evidence file id"
                          value={evidenceIds[activity.id] ?? ""}
                          onChange={(e) =>
                            setEvidenceIds((s) => ({ ...s, [activity.id]: e.target.value }))
                          }
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={action.busy === `evidence-${activity.id}`}
                          onClick={() =>
                            run(
                              `evidence-${activity.id}`,
                              () =>
                                corrApi.submitEvidence(projectId, activity.id, {
                                  fileIds: (evidenceIds[activity.id] ?? "")
                                    .split(",")
                                    .map((v) => v.trim())
                                    .filter((v) => v !== ""),
                                }),
                              "Evidence recorded.",
                            )
                          }
                        >
                          Submit evidence
                        </Button>
                      </div>
                      {(activity.signoffs ?? []).map((s) => (
                        <div key={s.id} className="flex items-center justify-between gap-2">
                          <span className="text-2xs text-content-muted">
                            {s.label}
                            {s.signedAt ? ` — signed ${dateTime(s.signedAt)}` : ""}
                          </span>
                          {s.status === "pending" ? (
                            <div className="flex gap-1">
                              <Button
                                size="xs"
                                loading={action.busy === `sign-${s.id}`}
                                onClick={() =>
                                  run(
                                    `sign-${s.id}`,
                                    () => corrApi.sign(projectId, activity.id, s.id, { decision: "signed" }),
                                    "Signed.",
                                  )
                                }
                              >
                                Sign
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                loading={action.busy === `reject-${s.id}`}
                                onClick={() =>
                                  run(
                                    `reject-${s.id}`,
                                    () => corrApi.sign(projectId, activity.id, s.id, { decision: "rejected" }),
                                    "Rejected — the activity is blocked.",
                                  )
                                }
                              >
                                Reject
                              </Button>
                            </div>
                          ) : (
                            <Badge tone={s.status === "signed" ? "success" : "danger"} size="xs">
                              {titleCase(s.status)}
                            </Badge>
                          )}
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <Input
                          size="sm"
                          placeholder="Waive because…"
                          value={waiveReason[activity.id] ?? ""}
                          onChange={(e) => setWaiveReason((s) => ({ ...s, [activity.id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={(waiveReason[activity.id] ?? "").trim().length < 3}
                          loading={action.busy === `waive-${activity.id}`}
                          onClick={() =>
                            run(
                              `waive-${activity.id}`,
                              () =>
                                corrApi.waive(
                                  projectId,
                                  activity.id,
                                  (waiveReason[activity.id] ?? "").trim(),
                                ),
                              "Activity waived.",
                            )
                          }
                        >
                          Waive
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {activity.waivedReason ? (
                    <p className="mt-2 text-2xs text-content-muted">Waived: {activity.waivedReason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">What stands in the way</h3>
            {plan.report.gaps.length === 0 ? (
              <p className="text-meta text-success-text">
                Nothing outstanding — every activity is signed off or waived.
              </p>
            ) : (
              <ReasonList reasons={plan.report.gaps} />
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
