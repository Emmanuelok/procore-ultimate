/**
 * FORMS (#457–#464).
 *
 * Three views behind one tab: the TEMPLATE library (fields, branching logic
 * and the acroform mapping of an uploaded fillable PDF), the ASSIGNMENTS that
 * ask a named person to complete one by a date, and the RESPONSES register
 * with its CSV export.
 *
 * The response editor renders exactly the questions the server will accept:
 * visibility is evaluated here with the same rules the API applies, and a
 * hidden field's answer is dropped on submission rather than silently kept.
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
  SegmentedControl,
  Select,
  StatusPill,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconDownload, IconPlus, IconSend } from "../../ui/icons";
import {
  DASH,
  DueBadge,
  FORM_FIELD_TYPES,
  FORM_RESPONSE_STATUSES,
  LoadError,
  LoadingBlock,
  ReasonList,
  Row,
  addDays,
  corrApi,
  count,
  dateTime,
  downloadCsv,
  isoDate,
  responseTone,
  titleCase,
  todayIso,
  useAction,
  useLocations,
  useResource,
  visibleFieldKeys,
  type FormAssignment,
  type FormFieldDef,
  type FormResponse,
  type FormResponseDetail,
  type FormTemplate,
  type FormTemplateDetail,
  type Paginated,
} from "./correspondenceShared";

type View = "templates" | "assignments" | "responses";

export default function FormsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [view, setView] = useState<View>("templates");
  return (
    <div className="space-y-4">
      <SegmentedControl
        value={view}
        onChange={(v) => setView(v as View)}
        options={[
          { value: "templates", label: "Templates" },
          { value: "assignments", label: "Assignments" },
          { value: "responses", label: "Responses" },
        ]}
        aria-label="Forms view"
      />
      {view === "templates" ? <TemplatesView projectId={projectId} onChanged={onChanged} /> : null}
      {view === "assignments" ? <AssignmentsView projectId={projectId} onChanged={onChanged} /> : null}
      {view === "responses" ? <ResponsesView projectId={projectId} onChanged={onChanged} /> : null}
    </div>
  );
}

/* ================================ Templates =============================== */

function TemplatesView({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const list = useResource<{ items: FormTemplate[]; total: number }>(
    `/api/v1/correspondence/form-templates?projectId=${projectId}`,
  );
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FormTemplateDetail | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const columns = useMemo<DataColumns<FormTemplate>>(
    () => [
      { id: "name", header: "Form", accessor: "name", type: "text", width: 280 },
      { id: "key", header: "Key", accessor: "key", type: "code", width: 160, mono: true },
      { id: "category", header: "Category", accessor: (r) => r.category ?? "", type: "text", width: 130 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => <StatusPill status={row.status} size="xs" />,
      },
      { id: "version", header: "Version", accessor: "version", type: "number", align: "right", width: 90 },
      {
        id: "fieldCount",
        header: "Fields",
        accessor: (r) => r.fieldCount ?? r.fields.length,
        type: "number",
        align: "right",
        width: 90,
      },
      {
        id: "signatureRequired",
        header: "Signature",
        accessor: (r) => (r.signatureRequired === 1 ? "required" : ""),
        type: "text",
        width: 110,
        cell: ({ row }) =>
          row.signatureRequired === 1 ? (
            <Badge tone="accent" size="xs">
              required
            </Badge>
          ) : (
            <span className="text-content-subtle">{DASH}</span>
          ),
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

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex items-center justify-between gap-3">
          <p className="text-meta text-content-muted">
            The template library (#464). A form must be published before it can be assigned or filled
            in — an unpublished one is still being written.
          </p>
          <Button icon={IconPlus} onClick={() => setCreating(true)}>
            New form
          </Button>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<FormTemplate>
          tableId="correspondence.formTemplates"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={460}
          rowHeight={44}
          stickyHeader
          exportFileName="form-templates"
          empty={{
            title: "No forms in the library",
            description:
              "Build a form once — fields, branching logic and a signature — and assign it as often as the job needs.",
            action: <Button onClick={() => setCreating(true)}>Build the first form</Button>,
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          aria-label="Form templates"
        />
      )}

      <TemplateFormDrawer
        open={creating || editing !== null}
        template={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          list.reload();
          onChanged();
        }}
      />
      <TemplateDrawer
        templateId={openId}
        onClose={() => setOpenId(null)}
        onEdit={(t) => {
          setOpenId(null);
          setEditing(t);
        }}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

interface FieldDraft {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string;
  showWhenField: string;
  showWhenValue: string;
}

const emptyField = (): FieldDraft => ({
  key: "",
  label: "",
  type: "text",
  required: false,
  options: "",
  showWhenField: "",
  showWhenValue: "",
});

/** A template's stored fields, back in the shape the builder edits. */
function toDrafts(fields: readonly FormFieldDef[]): FieldDraft[] {
  if (fields.length === 0) return [emptyField()];
  return fields.map((f) => {
    const condition = f.visibleWhen?.all?.[0] ?? f.visibleWhen?.any?.[0] ?? null;
    return {
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required === true,
      options: (f.options ?? []).map((o) => o.value).join(", "),
      showWhenField: condition?.field ?? "",
      showWhenValue: condition?.value === undefined || condition?.value === null ? "" : String(condition.value),
    };
  });
}

/**
 * The builder, used both to write a new form and to correct an existing one.
 * Editing matters: the detail drawer reports why a template cannot be
 * published, and without an edit path a template with a reported problem could
 * only be abandoned and rebuilt under a new key.
 */
function TemplateFormDrawer({
  open,
  template,
  onClose,
  onSaved,
}: {
  open: boolean;
  template: FormTemplateDetail | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const editing = template !== null;
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [signatureRequired, setSignatureRequired] = useState(false);
  const [fields, setFields] = useState<FieldDraft[]>([emptyField()]);

  useEffect(() => {
    if (!open) return;
    setKey(template?.key ?? "");
    setName(template?.name ?? "");
    setCategory(template?.category ?? "");
    setSignatureRequired(template?.signatureRequired === 1);
    setFields(template ? toDrafts(template.fields) : [emptyField()]);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template?.id, template?.version]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: name.trim(),
      category: category.trim() || null,
      signatureRequired,
      fields: fields
        .filter((f) => f.key.trim() !== "" && f.label.trim() !== "")
        .map((f) => ({
          key: f.key.trim(),
          label: f.label.trim(),
          type: f.type,
          required: f.required,
          options:
            f.options.trim() === ""
              ? undefined
              : f.options
                  .split(",")
                  .map((o) => o.trim())
                  .filter((o) => o !== "")
                  .map((o) => ({ value: o, label: titleCase(o) })),
          visibleWhen:
            f.showWhenField.trim() === ""
              ? null
              : { all: [{ field: f.showWhenField.trim(), operator: "eq", value: f.showWhenValue }] },
        })),
    };
    const saved = editing
      ? await action.run("save", () => corrApi.patchFormTemplate(template!.id, body))
      : await action.run("save", () => corrApi.createFormTemplate({ ...body, key: key.trim() }));
    if (saved) {
      toast.success(
        editing
          ? `"${saved.name}" saved — published forms move to version ${saved.version}.`
          : `"${saved.name}" created as a draft.`,
      );
      onSaved();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${template!.name}` : "New form"}
      description={
        editing
          ? "Changing the questions on a published form bumps its version; responses already captured keep the version they were answered on."
          : "Fields and simple show/hide logic (#459). Publish it when it is ready to be filled in."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-form-create" loading={action.busy === "save"}>
            {editing ? "Save changes" : "Create draft"}
          </Button>
        </div>
      }
    >
      <form id="corr-form-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Key"
            required={!editing}
            hint={editing ? "A form's key never changes once it exists" : "Lower case, digits, - and _"}
          >
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
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 pt-6 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={signatureRequired}
              onChange={(e) => setSignatureRequired(e.target.checked)}
            />
            A signature is required to submit (#462)
          </label>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-meta font-semibold text-content">Fields</span>
            <Button size="sm" variant="ghost" icon={IconPlus} onClick={() => setFields((f) => [...f, emptyField()])}>
              Add
            </Button>
          </div>
          {fields.map((field, index) => (
            <div key={index} className="space-y-2 rounded-md border border-border p-2">
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_130px]">
                <Input
                  size="sm"
                  placeholder="key"
                  value={field.key}
                  onChange={(e) =>
                    setFields((rows) => rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
                  }
                />
                <Input
                  size="sm"
                  placeholder="Label"
                  value={field.label}
                  onChange={(e) =>
                    setFields((rows) => rows.map((r, i) => (i === index ? { ...r, label: e.target.value } : r)))
                  }
                />
                <Select
                  size="sm"
                  value={field.type}
                  onChange={(e) =>
                    setFields((rows) => rows.map((r, i) => (i === index ? { ...r, type: e.target.value } : r)))
                  }
                >
                  {FORM_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {titleCase(t)}
                    </option>
                  ))}
                </Select>
              </div>
              {["select", "multiselect", "radio"].includes(field.type) ? (
                <Input
                  size="sm"
                  placeholder="Options, comma separated"
                  value={field.options}
                  onChange={(e) =>
                    setFields((rows) => rows.map((r, i) => (i === index ? { ...r, options: e.target.value } : r)))
                  }
                />
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  size="sm"
                  placeholder="Show only when field…"
                  value={field.showWhenField}
                  onChange={(e) =>
                    setFields((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, showWhenField: e.target.value } : r)),
                    )
                  }
                />
                <Input
                  size="sm"
                  placeholder="…equals this value"
                  value={field.showWhenValue}
                  onChange={(e) =>
                    setFields((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, showWhenValue: e.target.value } : r)),
                    )
                  }
                />
              </div>
              <label className="flex items-center gap-2 text-2xs text-content-muted">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(e) =>
                    setFields((rows) => rows.map((r, i) => (i === index ? { ...r, required: e.target.checked } : r)))
                  }
                />
                Required (only enforced while the field is visible)
                {fields.length > 1 ? (
                  <button
                    type="button"
                    className="ml-auto text-danger-text hover:underline"
                    onClick={() => setFields((rows) => rows.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                ) : null}
              </label>
            </div>
          ))}
        </div>
      </form>
    </Drawer>
  );
}

function TemplateDrawer({
  templateId,
  onClose,
  onEdit,
  onChanged,
}: {
  templateId: string | null;
  onClose: () => void;
  onEdit: (template: FormTemplateDetail) => void;
  onChanged: () => void;
}) {
  const detail = useResource<FormTemplateDetail>(
    templateId ? `/api/v1/correspondence/form-templates/${templateId}` : null,
  );
  const action = useAction();
  const template = detail.data;

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
      open={templateId !== null}
      onClose={onClose}
      size="md"
      title={template ? template.name : "Form template"}
      description={template ? `${titleCase(template.status)} · version ${template.version}` : undefined}
    >
      {detail.loading && !template ? <LoadingBlock /> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {template ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            {template.status !== "archived" ? (
              <Button size="sm" variant="secondary" onClick={() => onEdit(template)}>
                Edit questions
              </Button>
            ) : null}
            {template.status !== "published" ? (
              <Button
                size="sm"
                loading={action.busy === "publish"}
                onClick={() =>
                  run("publish", () => corrApi.publishFormTemplate(template.id), "Published.")
                }
              >
                Publish
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                loading={action.busy === "archive"}
                onClick={() => run("archive", () => corrApi.archiveFormTemplate(template.id), "Archived.")}
              >
                Archive
              </Button>
            )}
          </div>

          {template.problems.length > 0 ? (
            <Alert tone="danger" size="sm" title="This template cannot be published yet">
              <ReasonList reasons={template.problems} />
              <Button size="xs" variant="secondary" className="mt-2" onClick={() => onEdit(template)}>
                Fix the questions
              </Button>
            </Alert>
          ) : null}

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Fields ({template.fields.length})</h3>
            <ul className="divide-y divide-border">
              {template.fields.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-3 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-meta text-content">
                      {f.label}
                      {f.required ? <span className="ml-1 text-danger-text">*</span> : null}
                    </div>
                    <div className="text-2xs text-content-subtle">
                      <span className="font-mono">{f.key}</span> · {titleCase(f.type)}
                      {f.visibleWhen ? " · conditional" : ""}
                      {f.pdfField ? ` · PDF: ${f.pdfField}` : ""}
                    </div>
                  </div>
                  {template.initialVisibility.hidden.includes(f.key) ? (
                    <Badge tone="neutral" size="xs" title="Hidden until its controlling answer is given">
                      conditional
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Fillable PDF mapping (#457–#458)</h3>
            {template.pdfFileId === null ? (
              <p className="text-meta text-content-subtle">
                No fillable PDF is attached to this form, so there is nothing to map.
              </p>
            ) : (
              <dl className="divide-y divide-border">
                <Row label="Mapped fields">{count(Object.keys(template.pdfMapping.mapped).length)}</Row>
                <Row
                  label="PDF fields with no answer"
                  hint={template.pdfMapping.danglingPdfFields.join(", ") || undefined}
                >
                  {count(template.pdfMapping.danglingPdfFields.length)}
                </Row>
                <Row
                  label="Answers with no PDF field"
                  hint={template.pdfMapping.unmappedFields.join(", ") || undefined}
                >
                  {count(template.pdfMapping.unmappedFields.length)}
                </Row>
              </dl>
            )}
          </section>

          <section>
            <dl className="divide-y divide-border">
              <Row label="Responses captured">{count(template.responseCount)}</Row>
              <Row label="Published">{dateTime(template.publishedAt)}</Row>
              <Row label="Signature">
                {template.signatureRequired === 1 ? "Required to submit" : "Not required"}
              </Row>
            </dl>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

/* =============================== Assignments ============================== */

function AssignmentsView({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<FormAssignment | null>(null);
  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (overdueOnly) params.set("overdueOnly", "true");
  const list = useResource<Paginated<FormAssignment>>(
    `/api/v1/projects/${projectId}/correspondence/form-assignments?${params.toString()}`,
  );
  const templates = useResource<{ items: FormTemplate[] }>(
    `/api/v1/correspondence/form-templates?projectId=${projectId}&status=published`,
  );
  const locations = useLocations(projectId);
  const action = useAction();

  const byTemplate = new Map((templates.data?.items ?? []).map((t) => [t.id, t.name]));

  const columns = useMemo<DataColumns<FormAssignment>>(
    () => [
      {
        id: "template",
        header: "Form",
        accessor: (r) => byTemplate.get(r.templateId) ?? r.templateId,
        type: "text",
        width: 240,
      },
      { id: "assigneeName", header: "Assigned to", accessor: "assigneeName", type: "text", width: 200 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => <StatusPill status={row.status} size="xs" />,
      },
      {
        id: "dueDate",
        header: "Due",
        accessor: (r) => r.dueDate ?? "",
        type: "date",
        width: 140,
        cell: ({ row }) => <DueBadge date={row.dueDate} daysOverdue={row.overdue ? 1 : null} />,
      },
      {
        id: "responseId",
        header: "Response",
        accessor: (r) => r.responseId ?? "",
        type: "code",
        width: 160,
        mono: true,
        cell: ({ row }) => row.responseId ?? <span className="text-content-subtle">{DASH}</span>,
      },
      {
        id: "completedAt",
        header: "Completed",
        accessor: (r) => r.completedAt ?? "",
        type: "date",
        width: 140,
        cell: ({ row }) => isoDate(row.completedAt),
      },
    ],
    [byTemplate],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-meta text-content-muted">
            <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
            Overdue only
          </label>
          <Button icon={IconPlus} onClick={() => setCreating(true)} disabled={(templates.data?.items ?? []).length === 0}>
            Assign a form
          </Button>
        </CardBody>
      </Card>
      {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<FormAssignment>
          tableId="correspondence.formAssignments"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={460}
          rowHeight={44}
          stickyHeader
          exportFileName="form-assignments"
          empty={{
            title: "Nothing assigned",
            description:
              "An unreturned form is an unrecorded inspection, not an inspection that passed — assign one with a due date and the platform will chase it.",
          }}
          rowTone={(row) => (row.overdue ? "danger" : undefined)}
          onRowClick={({ row }) => setOpen(row)}
          aria-label="Form assignments"
        />
      )}

      <AssignmentDrawer
        projectId={projectId}
        assignment={open}
        templateName={open ? (byTemplate.get(open.templateId) ?? open.templateId) : ""}
        onClose={() => setOpen(null)}
        onChanged={() => {
          setOpen(null);
          list.reload();
          onChanged();
        }}
      />

      <AssignDrawer
        projectId={projectId}
        open={creating}
        templates={templates.data?.items ?? []}
        locations={locations.data?.items ?? []}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/**
 * One assignment, and the only thing that can still be done to it: withdraw it
 * with a reason. An assignment that no longer applies but cannot be cancelled
 * goes on being chased by the overdue sweep for ever.
 */
function AssignmentDrawer({
  projectId,
  assignment,
  templateName,
  onClose,
  onChanged,
}: {
  projectId: string;
  assignment: FormAssignment | null;
  templateName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [reason, setReason] = useState("");

  useEffect(() => {
    setReason("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment?.id]);

  const openStatus = assignment?.status === "assigned" || assignment?.status === "in_progress";

  return (
    <Drawer
      open={assignment !== null}
      onClose={onClose}
      size="sm"
      title={assignment ? templateName : "Assignment"}
      description={assignment ? `${titleCase(assignment.status)} · assigned to ${assignment.assigneeName}` : undefined}
    >
      {assignment ? (
        <div className="space-y-4">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          <dl className="divide-y divide-border">
            <Row label="Assigned to">{assignment.assigneeName}</Row>
            <Row label="Form version">v{assignment.templateVersion}</Row>
            <Row label="Due">
              <DueBadge date={assignment.dueDate} daysOverdue={assignment.overdue ? 1 : null} />
            </Row>
            <Row label="Response">
              {assignment.responseId ?? <span className="text-content-subtle">Nothing returned yet</span>}
            </Row>
            <Row label="Completed">{isoDate(assignment.completedAt)}</Row>
          </dl>
          {assignment.instructions ? (
            <p className="whitespace-pre-wrap rounded-md border border-border bg-surface-raised p-3 text-meta text-content">
              {assignment.instructions}
            </p>
          ) : null}
          {openStatus ? (
            <section className="rounded-md border border-danger-border p-3">
              <h3 className="mb-1 text-meta font-semibold text-danger-text">Withdraw this assignment</h3>
              <p className="mb-2 text-2xs text-content-muted">
                Cancelling stops the overdue chase. The record and the reason stay.
              </p>
              <div className="flex gap-2">
                <Input
                  size="sm"
                  value={reason}
                  placeholder="Reason"
                  onChange={(e) => setReason(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="danger"
                  disabled={reason.trim().length < 3}
                  loading={action.busy === "cancel"}
                  onClick={async () => {
                    const done = await action.run("cancel", () =>
                      corrApi.cancelAssignment(projectId, assignment.id, reason.trim()),
                    );
                    if (done) {
                      toast.success("Assignment withdrawn.");
                      onChanged();
                    }
                  }}
                >
                  Cancel it
                </Button>
              </div>
            </section>
          ) : (
            <p className="text-meta text-content-subtle">
              This assignment is {titleCase(assignment.status).toLowerCase()}; there is nothing left to do to it.
            </p>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

function AssignDrawer({
  projectId,
  open,
  templates,
  locations,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  templates: FormTemplate[];
  locations: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [templateId, setTemplateId] = useState("");
  const [assigneeName, setAssigneeName] = useState("");
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [dueDate, setDueDate] = useState(addDays(todayIso(), 3));
  const [instructions, setInstructions] = useState("");

  useEffect(() => {
    if (!open) return;
    setTemplateId(templates[0]?.id ?? "");
    setAssigneeName("");
    setAssigneeUserId("");
    setLocationId("");
    setDueDate(addDays(todayIso(), 3));
    setInstructions("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templates]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { templateId, dueDate: dueDate || null };
    if (assigneeUserId.trim()) payload["assigneeUserId"] = assigneeUserId.trim();
    if (assigneeName.trim()) payload["assigneeName"] = assigneeName.trim();
    if (locationId) payload["locationId"] = locationId;
    if (instructions.trim()) payload["instructions"] = instructions.trim();
    const created = await action.run("assign", () => corrApi.assignForm(projectId, payload));
    if (created) {
      toast.success(`Assigned to ${created.assigneeName}.`);
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Assign a form"
      description="Name the person and the date. The platform raises a signal when it is not returned."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-assign" loading={action.busy === "assign"}>
            Assign
          </Button>
        </div>
      }
    >
      <form id="corr-assign" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <Field label="Form" required>
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (v{t.version})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Assignee user id" hint="A company member; leave blank for an external name">
            <Input value={assigneeUserId} onChange={(e) => setAssigneeUserId(e.target.value)} />
          </Field>
          <Field label="Assignee name" required={!assigneeUserId}>
            <Input value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Location">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Anywhere</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Instructions">
          <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
        </Field>
      </form>
    </Drawer>
  );
}

/* ================================ Responses =============================== */

function ResponsesView({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [status, setStatus] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const exportAction = useAction();

  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (status) params.set("status", status);
  if (templateId) params.set("templateId", templateId);
  const list = useResource<Paginated<FormResponse>>(
    `/api/v1/projects/${projectId}/correspondence/form-responses?${params.toString()}`,
  );
  const templates = useResource<{ items: FormTemplate[] }>(
    `/api/v1/correspondence/form-templates?projectId=${projectId}`,
  );
  const byTemplate = new Map((templates.data?.items ?? []).map((t) => [t.id, t.name]));

  const columns = useMemo<DataColumns<FormResponse>>(
    () => [
      { id: "reference", header: "Reference", accessor: "reference", type: "code", width: 100, mono: true },
      {
        id: "template",
        header: "Form",
        accessor: (r) => byTemplate.get(r.templateId) ?? r.templateId,
        type: "text",
        width: 240,
      },
      { id: "title", header: "Title", accessor: (r) => r.title ?? "", type: "text", width: 220 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => <StatusPill status={row.status} size="xs" />,
      },
      {
        id: "signature",
        header: "Signed by",
        accessor: (r) => r.signature?.name ?? "",
        type: "text",
        width: 180,
        cell: ({ row }) =>
          row.signature ? row.signature.name : <span className="text-content-subtle">{DASH}</span>,
      },
      {
        id: "submittedAt",
        header: "Submitted",
        accessor: (r) => r.submittedAt ?? "",
        type: "date",
        width: 150,
        cell: ({ row }) => isoDate(row.submittedAt),
      },
      {
        id: "hidden",
        header: "Hidden fields",
        accessor: (r) => r.hiddenFields.length,
        type: "number",
        align: "right",
        width: 120,
        cell: ({ row }) =>
          row.hiddenFields.length === 0 ? (
            <span className="text-content-subtle">{DASH}</span>
          ) : (
            <span title={row.hiddenFields.join(", ")}>{row.hiddenFields.length}</span>
          ),
      },
    ],
    [byTemplate],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Any</option>
              {FORM_RESPONSE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Form">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} size="sm">
              <option value="">Any</option>
              {(templates.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="ml-auto flex gap-2">
            <Button
              variant="ghost"
              icon={IconDownload}
              disabled={!templateId}
              loading={exportAction.busy === "export"}
              title={templateId ? undefined : "Choose a form first — the export has one column per field"}
              onClick={() =>
                void exportAction.run("export", async () => {
                  await downloadCsv(
                    `/api/v1/projects/${projectId}/correspondence/form-responses/export?templateId=${templateId}`,
                    `${byTemplate.get(templateId) ?? "form"}-responses.csv`,
                  );
                  return true;
                })
              }
            >
              Export
            </Button>
            <Button icon={IconPlus} onClick={() => setCreating(true)}>
              Fill in a form
            </Button>
          </div>
        </CardBody>
      </Card>

      {exportAction.error ? (
        <Alert tone="danger" size="sm">
          {exportAction.error}
        </Alert>
      ) : null}

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<FormResponse>
          tableId="correspondence.formResponses"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={460}
          rowHeight={44}
          stickyHeader
          exportFileName="form-responses"
          empty={{
            title: "No responses yet",
            description: "Fill in a published form, or assign one to the person who should.",
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          aria-label="Form responses"
        />
      )}

      <ResponseCreateDrawer
        projectId={projectId}
        open={creating}
        templates={(templates.data?.items ?? []).filter((t) => t.status === "published")}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          list.reload();
          onChanged();
          setOpenId(id);
        }}
      />
      <ResponseDrawer
        projectId={projectId}
        responseId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function ResponseCreateDrawer({
  projectId,
  open,
  templates,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  templates: FormTemplate[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const [templateId, setTemplateId] = useState("");

  useEffect(() => {
    if (!open) return;
    setTemplateId(templates[0]?.id ?? "");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templates]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const created = await action.run("create", () =>
      corrApi.createResponse(projectId, { templateId, values: {} }),
    );
    if (created) {
      toast.success(`${created.reference} started.`);
      onCreated(created.id);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="sm"
      title="Fill in a form"
      description="A draft is created; answer it in the drawer that opens."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="corr-response-create" loading={action.busy === "create"}>
            Start
          </Button>
        </div>
      }
    >
      <form id="corr-response-create" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        {templates.length === 0 ? (
          <Alert tone="warning" size="sm">
            No published forms yet — publish one in the Templates view first.
          </Alert>
        ) : null}
        <Field label="Form" required>
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Drawer>
  );
}

/**
 * A list-valued answer. `multiselect`, `photo` and `file` are the three field
 * kinds the API validates as arrays, so the renderer has to produce arrays for
 * them: handing back a string makes the response unsavable AND unsubmittable,
 * with no way for the person filling it in to clear the field.
 */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

function MultiSelectInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FormFieldDef;
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const options = field.options ?? [];
  if (options.length === 0) {
    return (
      <ListInput
        disabled={disabled}
        value={value}
        placeholder="Values, comma separated"
        hint="This field offers no options, so any comma-separated list is accepted."
        onChange={onChange}
      />
    );
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-meta text-content-muted">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.includes(o.value)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, o.value]
                  : value.filter((v) => v !== o.value),
              )
            }
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function ListInput({
  value,
  disabled,
  placeholder,
  hint,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  placeholder: string;
  hint?: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-1">
      <Input
        disabled={disabled}
        placeholder={placeholder}
        value={value.join(", ")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter((v) => v !== ""),
          )
        }
      />
      {hint ? <p className="text-2xs text-content-subtle">{hint}</p> : null}
    </div>
  );
}

function ResponseDrawer({
  projectId,
  responseId,
  onClose,
  onChanged,
}: {
  projectId: string;
  responseId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useResource<FormResponseDetail>(
    responseId ? `/api/v1/projects/${projectId}/correspondence/form-responses/${responseId}` : null,
  );
  const action = useAction();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [signatureName, setSignatureName] = useState("");
  const [reviewNote, setReviewNote] = useState("");

  useEffect(() => {
    setValues(detail.data?.values ?? {});
    setSignatureName(detail.data?.signature?.name ?? "");
    setReviewNote("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.id]);

  const response = detail.data;
  const fields: FormFieldDef[] = response?.template?.fields ?? [];
  const visible = useMemo(
    () => visibleFieldKeys(fields, values, response?.template?.logic ?? {}),
    [fields, values, response?.template?.logic],
  );

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
      open={responseId !== null}
      onClose={onClose}
      size="lg"
      title={response ? `${response.reference} · ${response.title ?? "Form"}` : "Form response"}
      description={response ? `${titleCase(response.status)} · template v${response.templateVersion}` : undefined}
    >
      {detail.loading && !response ? <LoadingBlock /> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {response ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          {response.templateDrifted ? (
            <Alert tone="info" size="sm" title="The form has changed since this was answered">
              This response was captured against version {response.templateVersion}; the template is now
              on a later version. The answers below are the questions that were actually asked.
            </Alert>
          ) : null}

          <section className="space-y-3">
            {fields
              .filter((f) => visible.has(f.key))
              .map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  required={f.required}
                  hint={f.help ?? undefined}
                >
                  {f.type === "heading" ? (
                    <p className="text-meta font-semibold text-content">{f.label}</p>
                  ) : f.type === "textarea" ? (
                    <Textarea
                      rows={3}
                      disabled={response.status !== "draft"}
                      value={String(values[f.key] ?? "")}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  ) : f.type === "select" || f.type === "radio" ? (
                    <Select
                      disabled={response.status !== "draft"}
                      value={String(values[f.key] ?? "")}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    >
                      <option value="">—</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : f.type === "checkbox" ? (
                    <input
                      type="checkbox"
                      disabled={response.status !== "draft"}
                      checked={values[f.key] === true}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
                    />
                  ) : f.type === "multiselect" ? (
                    <MultiSelectInput
                      field={f}
                      disabled={response.status !== "draft"}
                      value={asList(values[f.key])}
                      onChange={(next) => setValues((v) => ({ ...v, [f.key]: next }))}
                    />
                  ) : f.type === "photo" || f.type === "file" ? (
                    <ListInput
                      disabled={response.status !== "draft"}
                      value={asList(values[f.key])}
                      placeholder="File ids, comma separated"
                      hint={
                        f.type === "photo"
                          ? "Photograph file ids, comma separated. Each id is checked against this project's files."
                          : "File ids, comma separated. Each id is checked against this project's files."
                      }
                      onChange={(next) => setValues((v) => ({ ...v, [f.key]: next }))}
                    />
                  ) : (
                    <Input
                      type={f.type === "number" || f.type === "rating" ? "number" : f.type === "date" ? "date" : f.type === "time" ? "time" : "text"}
                      disabled={response.status !== "draft"}
                      value={String(values[f.key] ?? "")}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  )}
                </Field>
              ))}
            {response.visibility.hidden.length > 0 ? (
              <p className="text-2xs text-content-subtle">
                {response.visibility.hidden.length} field(s) are hidden by this form's logic and are not
                asked: {response.visibility.hidden.join(", ")}.
              </p>
            ) : null}
          </section>

          {response.status === "draft" ? (
            <section className="space-y-3">
              {response.template?.signatureRequired === 1 ? (
                <Field label="Signature" required hint="Typed name, recorded with the time (#462)">
                  <Input value={signatureName} onChange={(e) => setSignatureName(e.target.value)} />
                </Field>
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={action.busy === "save"}
                  onClick={() =>
                    run("save", () => corrApi.patchResponse(projectId, response.id, { values }), "Draft saved.")
                  }
                >
                  Save draft
                </Button>
                <Button
                  size="sm"
                  icon={IconSend}
                  loading={action.busy === "submit"}
                  onClick={() =>
                    run(
                      "submit",
                      () =>
                        corrApi.submitResponse(projectId, response.id, {
                          values,
                          signature:
                            response.template?.signatureRequired === 1
                              ? { name: signatureName, method: "typed" }
                              : undefined,
                        }),
                      "Submitted.",
                    )
                  }
                >
                  Submit
                </Button>
              </div>
            </section>
          ) : null}

          {response.status === "submitted" ? (
            <section className="space-y-2 rounded-md border border-border p-3">
              <h3 className="text-meta font-semibold text-content">Review</h3>
              <p className="text-2xs text-content-muted">
                The person who submitted a form cannot review it — a check by its own author is not a
                check.
              </p>
              <Input
                size="sm"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="Note (optional)"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={action.busy === "approve"}
                  onClick={() =>
                    run(
                      "approve",
                      () =>
                        corrApi.reviewResponse(projectId, response.id, {
                          decision: "approved",
                          note: reviewNote || null,
                        }),
                      "Approved.",
                    )
                  }
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={action.busy === "reject"}
                  onClick={() =>
                    run(
                      "reject",
                      () =>
                        corrApi.reviewResponse(projectId, response.id, {
                          decision: "rejected",
                          note: reviewNote || null,
                        }),
                      "Rejected.",
                    )
                  }
                >
                  Reject
                </Button>
              </div>
            </section>
          ) : null}

          <section>
            <h3 className="mb-1 text-meta font-semibold text-content">Record</h3>
            <dl className="divide-y divide-border">
              <Row label="Status">
                <Badge tone={responseTone(response.status)} size="xs" dot>
                  {titleCase(response.status)}
                </Badge>
              </Row>
              <Row label="Submitted">{dateTime(response.submittedAt)}</Row>
              <Row label="Signed">
                {response.signature
                  ? `${response.signature.name} · ${dateTime(response.signature.signedAt)}`
                  : DASH}
              </Row>
              <Row label="Reviewed">{dateTime(response.reviewedAt)}</Row>
              {response.reviewNote ? <Row label="Review note">{response.reviewNote}</Row> : null}
            </dl>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
