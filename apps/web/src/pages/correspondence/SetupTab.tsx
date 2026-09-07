/**
 * SETUP — the correspondence types this tenant issues under (#440, #445) and
 * the action plan template library (#447).
 *
 * A type decides four things a letter cannot decide for itself: its reference
 * prefix and sequence, whether a response is expected and in how many days,
 * whether the record is a contractual act, and which approvals stand between
 * a draft and an issued letter. Getting these wrong later is expensive, so
 * the screen states each consequence next to the control that sets it — and
 * every one of them can be corrected here afterwards, because configuration
 * nobody can edit is configuration that gets worked around.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
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
  Select,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconWorkflow } from "../../ui/icons";
import {
  ActivityDraftEditor,
  DASH,
  DIRECTIONS,
  LoadError,
  LoadingBlock,
  Row,
  activityDraftPayload,
  activityDraftsFrom,
  corrApi,
  count,
  days,
  titleCase,
  useAction,
  useResource,
  useTypes,
  type ActionPlanTemplate,
  type ActivityDraft,
  type CorrespondenceType,
} from "./correspondenceShared";

export default function SetupTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const types = useTypes(projectId);
  const planTemplates = useResource<{ items: ActionPlanTemplate[] }>(
    `/api/v1/correspondence/action-plan-templates?projectId=${projectId}&includeInactive=true`,
  );
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [openType, setOpenType] = useState<CorrespondenceType | null>(null);
  const [editingType, setEditingType] = useState<CorrespondenceType | null>(null);
  const [templateDrawer, setTemplateDrawer] = useState<
    { mode: "create" } | { mode: "edit"; id: string } | null
  >(null);

  const columns = useMemo<DataColumns<CorrespondenceType>>(
    () => [
      { id: "prefix", header: "Prefix", accessor: "prefix", type: "code", width: 90, mono: true },
      { id: "name", header: "Type", accessor: "name", type: "text", width: 220 },
      { id: "key", header: "Key", accessor: "key", type: "code", width: 150, mono: true },
      {
        id: "response",
        header: "Response expected",
        accessor: (r) => (r.requiresResponse === 1 ? (r.responseDays ?? 0) : -1),
        type: "text",
        width: 200,
        cell: ({ row }) =>
          row.requiresResponse === 1 ? (
            <span>
              within {row.responseDays === null ? DASH : days(row.responseDays)}
              {row.responseDaysBasis === "working" ? " (working)" : ""}
              {row.createsObligation === 1 ? (
                <Badge tone="info" size="xs" className="ml-1" title="An obligation is opened at issue">
                  obligation
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-content-subtle">not chased</span>
          ),
      },
      {
        id: "isContractual",
        header: "Contractual",
        accessor: (r) => (r.isContractual === 1 ? "yes" : "no"),
        type: "text",
        width: 110,
        cell: ({ row }) =>
          row.isContractual === 1 ? (
            <Badge tone="accent" size="xs">
              contractual
            </Badge>
          ) : (
            <span className="text-content-subtle">{DASH}</span>
          ),
      },
      {
        id: "approvals",
        header: "Approval steps",
        accessor: (r) => r.approvalSteps.length,
        type: "number",
        align: "right",
        width: 130,
        cell: ({ row }) =>
          row.approvalSteps.length === 0 ? (
            <span className="text-content-subtle">{DASH}</span>
          ) : (
            <span title={row.approvalSteps.map((s) => s.name).join(" → ")}>
              {row.approvalSteps.length}
            </span>
          ),
      },
      {
        id: "letterCount",
        header: "Letters",
        accessor: (r) => r.letterCount ?? 0,
        type: "number",
        align: "right",
        width: 90,
      },
      {
        id: "scope",
        header: "Scope",
        accessor: (r) => (r.projectId === null ? "Company-wide" : "This project"),
        type: "text",
        width: 130,
      },
    ],
    [],
  );

  async function seed() {
    const result = await action.run("seed", () => corrApi.seedTypes());
    if (result) {
      toast.success(
        result.created.length > 0
          ? `Seeded ${result.created.length} type(s): ${result.created.join(", ")}.`
          : "Everything in the default library already exists.",
      );
      types.reload();
      onChanged();
    }
  }

  async function retireType(type: CorrespondenceType) {
    const result = await action.run("retire", () => corrApi.deleteType(type.id));
    if (result) {
      toast.success(
        result.deleted
          ? `"${type.name}" was deleted — no letter had been written under it.`
          : `"${type.name}" was deactivated; ${count(result.letterCount)} letter(s) keep it, so the register stays readable.`,
      );
      setOpenType(null);
      types.reload();
      onChanged();
    }
  }

  const templates = planTemplates.data?.items ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Correspondence types"
          subtitle="What a letter IS in this tenant: its numbering, its response period, whether it is a contractual act, and the approvals it must pass."
          actions={
            <div className="flex gap-2">
              <Button variant="ghost" loading={action.busy === "seed"} onClick={seed}>
                Seed the default library
              </Button>
              <Button icon={IconPlus} onClick={() => setCreating(true)}>
                New type
              </Button>
            </div>
          }
        />
        <CardBody>
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          {types.error ? (
            <LoadError message={types.error} onRetry={types.reload} />
          ) : (
            <DataTable<CorrespondenceType>
              tableId="correspondence.types"
              data={types.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={types.loading && !types.data}
              height={360}
              rowHeight={44}
              stickyHeader
              exportFileName="correspondence-types"
              empty={{
                title: "No correspondence types configured",
                description:
                  "Nothing can be written until the tenant has at least one type. Seed the default library — general letter, instruction, notice, EOT notice and technical query — and adjust from there.",
                action: (
                  <Button loading={action.busy === "seed"} onClick={seed}>
                    Seed the default library
                  </Button>
                ),
              }}
              onRowClick={({ row }) => setOpenType(row)}
              rowTone={(row) => (row.isActive === 0 ? "warning" : undefined)}
              aria-label="Correspondence types"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Action plan templates"
          subtitle="The library a plan is built from: required activities, evidence requirements and who must sign."
          icon={IconWorkflow}
          actions={
            <Button icon={IconPlus} onClick={() => setTemplateDrawer({ mode: "create" })}>
              New template
            </Button>
          }
        />
        <CardBody>
          {planTemplates.error ? (
            <LoadError message={planTemplates.error} onRetry={planTemplates.reload} />
          ) : planTemplates.loading && !planTemplates.data ? (
            <LoadingBlock rows={3} />
          ) : templates.length === 0 ? (
            <p className="text-meta text-content-subtle">
              No templates yet. A plan can also be built ad hoc on the Action plans tab; a template is
              how the same set of checks gets applied every time.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {templates.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setTemplateDrawer({ mode: "edit", id: t.id })}
                  >
                    <div className="truncate text-meta text-content hover:underline">{t.name}</div>
                    <div className="truncate text-2xs text-content-subtle">
                      <span className="font-mono">{t.key}</span> · v{t.version} ·{" "}
                      {count(t.activityCount ?? 0)} activities
                      {t.category ? ` · ${t.category}` : ""}
                    </div>
                  </button>
                  <Badge tone={t.isActive === 1 ? "success" : "neutral"} size="xs">
                    {t.isActive === 1 ? "Active" : "Inactive"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <TypeDrawer
        open={creating || editingType !== null}
        type={editingType}
        onClose={() => {
          setCreating(false);
          setEditingType(null);
        }}
        onSaved={(saved) => {
          setCreating(false);
          setEditingType(null);
          setOpenType((current) => (current && current.id === saved.id ? saved : current));
          types.reload();
          onChanged();
        }}
      />

      <PlanTemplateDrawer
        projectId={projectId}
        state={templateDrawer}
        onClose={() => setTemplateDrawer(null)}
        onSaved={() => {
          setTemplateDrawer(null);
          planTemplates.reload();
          onChanged();
        }}
      />

      <Drawer
        open={openType !== null}
        onClose={() => setOpenType(null)}
        size="sm"
        title={openType ? openType.name : "Correspondence type"}
        description={openType ? `Prefix ${openType.prefix}` : undefined}
      >
        {openType ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setEditingType(openType)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={action.busy === "retire"}
                onClick={() => retireType(openType)}
              >
                {(openType.letterCount ?? 0) > 0 ? "Deactivate" : "Delete"}
              </Button>
            </div>
            <p className="text-2xs text-content-subtle">
              A type that letters already use is deactivated rather than deleted — deleting it would
              orphan a register a dispute may turn on.
            </p>
            <dl className="divide-y divide-border">
              <Row label="Key">
                <span className="font-mono text-2xs">{openType.key}</span>
              </Row>
              <Row label="Default direction">{titleCase(openType.defaultDirection)}</Row>
              <Row
                label="Response expected"
                hint={
                  openType.requiresResponse === 1
                    ? openType.responseDaysBasis === "working"
                      ? "Counted in working days (Mon–Fri)"
                      : "Counted in calendar days"
                    : undefined
                }
              >
                {openType.requiresResponse === 1
                  ? `within ${openType.responseDays === null ? DASH : days(openType.responseDays)}`
                  : "No"}
              </Row>
              <Row
                label="Opens an obligation"
                hint="An obligation is what makes the deadline visible to the assurance layer"
              >
                {openType.createsObligation === 1 ? "Yes" : "No"}
              </Row>
              <Row label="Contractual">{openType.isContractual === 1 ? "Yes" : "No"}</Row>
              <Row label="Letters written">{count(openType.letterCount ?? 0)}</Row>
              <Row label="Active">{openType.isActive === 1 ? "Yes" : "No — cannot be used for new letters"}</Row>
            </dl>
            {openType.description ? (
              <p className="text-meta text-content-muted">{openType.description}</p>
            ) : null}
            {openType.approvalSteps.length > 0 ? (
              <section>
                <h3 className="mb-1 text-meta font-semibold text-content">Approval workflow</h3>
                <ol className="space-y-1 text-meta text-content-muted">
                  {openType.approvalSteps.map((s, i) => (
                    <li key={i}>
                      {i + 1}. {s.name}
                      {s.role ? ` — requires the ${s.role} role` : ""}
                    </li>
                  ))}
                </ol>
                <p className="mt-1 text-2xs text-content-subtle">
                  The author of a letter can never satisfy one of its own approval steps.
                </p>
              </section>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

/* ============================ Correspondence type ========================= */

function TypeDrawer({
  open,
  type,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = create a new type; a row = edit it in place */
  type: CorrespondenceType | null;
  onClose: () => void;
  onSaved: (saved: CorrespondenceType) => void;
}) {
  const action = useAction();
  const editing = type !== null;
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [description, setDescription] = useState("");
  const [defaultDirection, setDefaultDirection] = useState("outbound");
  const [requiresResponse, setRequiresResponse] = useState(true);
  const [responseDays, setResponseDays] = useState("14");
  const [responseDaysBasis, setResponseDaysBasis] = useState("calendar");
  const [isContractual, setIsContractual] = useState(false);
  const [createsObligation, setCreatesObligation] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [approvalRole, setApprovalRole] = useState("");

  // A workflow with more than one step cannot be expressed by the single
  // role picker, so editing leaves it alone rather than silently flattening it.
  const approvalEditable = (type?.approvalSteps.length ?? 0) <= 1;

  useEffect(() => {
    if (!open) return;
    setKey(type?.key ?? "");
    setName(type?.name ?? "");
    setPrefix(type?.prefix ?? "");
    setDescription(type?.description ?? "");
    setDefaultDirection(type?.defaultDirection ?? "outbound");
    setRequiresResponse(type ? type.requiresResponse === 1 : true);
    setResponseDays(type?.responseDays === null || type?.responseDays === undefined ? "14" : String(type.responseDays));
    setResponseDaysBasis(type?.responseDaysBasis ?? "calendar");
    setIsContractual(type ? type.isContractual === 1 : false);
    setCreatesObligation(type ? type.createsObligation === 1 : true);
    setIsActive(type ? type.isActive === 1 : true);
    setApprovalRole(type?.approvalSteps[0]?.role ?? "");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type?.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      name: name.trim(),
      prefix: prefix.trim().toUpperCase(),
      description: description.trim() || null,
      defaultDirection,
      requiresResponse,
      responseDays: requiresResponse ? Number(responseDays) : null,
      responseDaysBasis,
      isContractual,
      createsObligation,
    };
    if (approvalEditable) {
      payload["approvalSteps"] = approvalRole
        ? [{ name: `${titleCase(approvalRole)} approval`, role: approvalRole }]
        : [];
    }
    if (editing) {
      payload["isActive"] = isActive;
      const saved = await action.run("save", () => corrApi.patchType(type!.id, payload));
      if (saved) {
        toast.success(`"${saved.name}" updated.`);
        onSaved(saved);
      }
      return;
    }
    payload["key"] = key.trim();
    const created = await action.run("save", () => corrApi.createType(payload));
    if (created) {
      toast.success(`"${created.name}" added — letters will be numbered ${created.prefix}-001.`);
      onSaved(created);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title={editing ? `Edit ${type!.name}` : "New correspondence type"}
      description={
        editing
          ? "The key and the scope are fixed: letters already reference them. Everything else applies to the next letter written."
          : "Configuration, not project data: it applies to every project unless you say otherwise."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-type-form" loading={action.busy === "save"}>
            {editing ? "Save changes" : "Add type"}
          </Button>
        </div>
      }
    >
      <form id="corr-type-form" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Key" required={!editing} hint={editing ? "Fixed" : "Lower case"}>
            <Input
              value={key}
              disabled={editing}
              onChange={(e) => setKey(e.target.value)}
              required={!editing}
            />
          </Field>
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field
            label="Prefix"
            required
            hint={editing ? "Letters already numbered keep their reference" : "LTR-001"}
          >
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} required maxLength={12} />
          </Field>
        </div>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Default direction">
            <Select value={defaultDirection} onChange={(e) => setDefaultDirection(e.target.value)}>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {titleCase(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Response period (days)"
            required={requiresResponse}
            hint={requiresResponse ? "The register will chase this deadline" : "Not chased"}
          >
            <Input
              type="number"
              min={0}
              disabled={!requiresResponse}
              value={responseDays}
              onChange={(e) => setResponseDays(e.target.value)}
            />
          </Field>
          <Field label="Counted in" hint="Most contracts count a notice period in working days">
            <Select
              value={responseDaysBasis}
              disabled={!requiresResponse}
              onChange={(e) => setResponseDaysBasis(e.target.value)}
            >
              <option value="calendar">Calendar days</option>
              <option value="working">Working days (Mon–Fri)</option>
            </Select>
          </Field>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={requiresResponse}
              onChange={(e) => setRequiresResponse(e.target.checked)}
            />
            A response is expected
          </label>
          <label className="flex items-center gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={createsObligation}
              disabled={!requiresResponse}
              onChange={(e) => setCreatesObligation(e.target.checked)}
            />
            Open an assurance obligation for the response deadline
          </label>
          <label className="flex items-center gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={isContractual}
              onChange={(e) => setIsContractual(e.target.checked)}
            />
            This type is a contractual act (a notice served under the contract)
          </label>
          {editing ? (
            <label className="flex items-center gap-2 text-meta text-content-muted">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Available for new letters
            </label>
          ) : null}
        </div>
        <Field
          label="Approval before issue"
          hint={
            approvalEditable
              ? "The author can never satisfy their own letter's approval step."
              : `This type has ${type!.approvalSteps.length} steps, which this control cannot express — they are left untouched.`
          }
        >
          <Select
            value={approvalRole}
            disabled={!approvalEditable}
            onChange={(e) => setApprovalRole(e.target.value)}
          >
            <option value="">No approval needed</option>
            <option value="admin">A company admin must approve</option>
            <option value="owner">The company owner must approve</option>
          </Select>
        </Field>
      </form>
    </Drawer>
  );
}

/* =========================== Action plan template ========================= */

function PlanTemplateDrawer({
  projectId,
  state,
  onClose,
  onSaved,
}: {
  projectId: string;
  state: { mode: "create" } | { mode: "edit"; id: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editingId = state?.mode === "edit" ? state.id : null;
  const detail = useResource<ActionPlanTemplate>(
    editingId ? `/api/v1/correspondence/action-plan-templates/${editingId}` : null,
  );
  const action = useAction();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [scoped, setScoped] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [activities, setActivities] = useState<ActivityDraft[]>([]);
  const [replaceActivities, setReplaceActivities] = useState(false);

  useEffect(() => {
    if (state === null) return;
    action.clear();
    setReplaceActivities(state.mode === "create");
    if (state.mode === "create") {
      setKey("");
      setName("");
      setDescription("");
      setCategory("");
      setScoped(false);
      setIsActive(true);
      setActivities([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.mode, editingId]);

  const loaded = detail.data;
  useEffect(() => {
    if (!loaded || editingId === null) return;
    setKey(loaded.key);
    setName(loaded.name);
    setDescription(loaded.description ?? "");
    setCategory(loaded.category ?? "");
    setScoped(loaded.projectId !== null);
    setIsActive(loaded.isActive === 1);
    setActivities(activityDraftsFrom(loaded.activities));
  }, [loaded, editingId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const drafted = activityDraftPayload(activities);
    if (editingId) {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        category: category.trim() || null,
        isActive,
      };
      // Replacing the activity list mints a new template version; plans already
      // built keep the version they were built from. Only send it when the
      // author actually touched the list.
      if (replaceActivities) payload["activities"] = drafted;
      const saved = await action.run("save", () => corrApi.patchPlanTemplate(editingId, payload));
      if (saved) {
        toast.success(
          replaceActivities
            ? `"${saved.name}" saved as v${saved.version} — plans already built keep the version they came from.`
            : `"${saved.name}" saved.`,
        );
        onSaved();
      }
      return;
    }
    const payload: Record<string, unknown> = {
      key: key.trim(),
      name: name.trim(),
      description: description.trim() || null,
      category: category.trim() || null,
      activities: drafted,
    };
    if (scoped) payload["projectId"] = projectId;
    const created = await action.run("save", () => corrApi.createPlanTemplate(payload));
    if (created) {
      toast.success(`"${created.name}" added with ${count(drafted.length)} activities.`);
      onSaved();
    }
  }

  return (
    <Drawer
      open={state !== null}
      onClose={onClose}
      size="lg"
      title={editingId ? `Edit ${loaded?.name ?? "template"}` : "New action plan template"}
      description={
        editingId
          ? "Company configuration. Changing the activity list mints a new version; plans already built keep theirs."
          : "The checks that get applied every time: what must be done, what evidence proves it, and who signs."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-plan-template-form" loading={action.busy === "save"}>
            {editingId ? "Save template" : "Create template"}
          </Button>
        </div>
      }
    >
      {editingId && detail.loading && !loaded ? <LoadingBlock /> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {state !== null && (!editingId || loaded) ? (
        <form id="corr-plan-template-form" onSubmit={submit} className="space-y-4">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Key" required={!editingId} hint={editingId ? "Fixed" : "Unique per company"}>
              <Input
                value={key}
                disabled={editingId !== null}
                onChange={(e) => setKey(e.target.value)}
                required={!editingId}
              />
            </Field>
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} />
            </Field>
            <Field label="Category" hint="Optional grouping">
              <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
          <div className="space-y-2">
            {editingId ? (
              <label className="flex items-center gap-2 text-meta text-content-muted">
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                Available when building a new plan
              </label>
            ) : (
              <label className="flex items-center gap-2 text-meta text-content-muted">
                <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
                Only this project may use it (otherwise every project can)
              </label>
            )}
            {editingId ? (
              <label className="flex items-center gap-2 text-meta text-content-muted">
                <input
                  type="checkbox"
                  checked={replaceActivities}
                  onChange={(e) => setReplaceActivities(e.target.checked)}
                />
                Replace the activity list — saves as v{(loaded?.version ?? 1) + 1}
              </label>
            ) : null}
          </div>
          <div className={replaceActivities ? undefined : "pointer-events-none opacity-60"}>
            <ActivityDraftEditor
              activities={activities}
              onChange={setActivities}
              empty="A template with no activities enforces nothing — add at least the checks that must happen every time."
            />
          </div>
        </form>
      ) : null}
    </Drawer>
  );
}
