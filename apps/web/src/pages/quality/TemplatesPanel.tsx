/**
 * THE CONTROLLED FORMS.
 *
 * Every checklist and every pre-functional test in this workspace is recorded
 * against a template, and the template is the control: it is what makes two
 * inspections of the same work comparable, and it is the first document an
 * ISO 9001 surveillance visit asks to see. The register was readable from the
 * platform and authored nowhere in it — forms had to be created through the
 * API — which meant the one document that decides what gets asked on site
 * lived outside the system that files the answers.
 *
 * The lifecycle the API enforces, and this screen makes visible:
 *
 *   DRAFT     items are added, edited and removed freely. Nothing may be
 *             recorded against it, because it is not yet a form.
 *   ACTIVE    issued. It cannot be edited — a form people have already filled
 *             in cannot change under them — only revised, which makes a new
 *             version and retires this one.
 *   RETIRED   superseded or withdrawn. Records already taken against it keep
 *             pointing at the version they were taken against.
 *
 * The approval is not the author's to give: the API refuses an approval by the
 * person who drafted the form, in the same way it refuses a self-approved ITP.
 */
import { useState } from "react";
import { Badge, Button, Field, Input, Modal, Select, Textarea } from "../../ui";
import { type Tone } from "../../ui/tokens";
import { IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EditModal,
  EM_DASH,
  LoadError,
  NothingHere,
  RefusalNotice,
  isoDate,
  labelize,
  plural,
  useAction,
  useReason,
  useResource,
  type EditFieldSpec,
  type Resource,
} from "./qualityShared";
import type { ChecklistTemplate, ChecklistTemplateItem, Paged, TemplateDetail } from "./types";

const CATEGORIES = [
  "quality",
  "safety",
  "commissioning",
  "pre_pour",
  "pre_task",
  "environmental",
  "handover",
  "snagging",
  "closeout",
  "delivery_receipt",
  "prequalification",
];

const SCORING_METHODS = ["pass_fail", "percentage", "weighted", "points", "none"];

const ITEM_TYPES = [
  "pass_fail",
  "pass_fail_na",
  "yes_no",
  "numeric",
  "measurement",
  "instrument_reading",
  "temperature",
  "text",
  "long_text",
  "single_select",
  "multi_select",
  "date",
  "signature",
  "photo",
  "file_upload",
  "section_header",
];

const NUMERIC_TYPES = ["numeric", "measurement", "instrument_reading", "temperature"];

const STATUS_TONE: Record<string, Tone> = {
  draft: "warning",
  active: "success",
  retired: "neutral",
};

const TEMPLATE_BASE = "/api/v1/companies/current/checklist-templates";

/*
 * A draft form's own fields. `reference` is absent: it identifies the form
 * across every revision of it, and changing it would silently detach this
 * version from its own history.
 */
const TEMPLATE_EDIT_FIELDS: readonly EditFieldSpec[] = [
  { key: "name", label: "Name", kind: "text", nullable: false, wide: true },
  { key: "description", label: "Description", kind: "textarea" },
  {
    key: "category",
    label: "Category",
    kind: "select",
    nullable: false,
    options: CATEGORIES.map((value) => ({ value, label: labelize(value) })),
  },
  {
    key: "scoringMethod",
    label: "Scoring",
    kind: "select",
    nullable: false,
    options: SCORING_METHODS.map((value) => ({ value, label: labelize(value) })),
    hint: "A pass/fail form carries a verdict and no score; the register says 'not scored' rather than inventing one.",
  },
  { key: "passThreshold", label: "Pass threshold (%)", kind: "number" },
  { key: "specSectionCode", label: "Specification section", kind: "text" },
  { key: "appliesToTrades", label: "Applies to trades", kind: "list", hint: "Comma separated." },
  { key: "isStatutory", label: "Statutory", kind: "boolean" },
  { key: "regulatoryBasis", label: "Regulatory basis", kind: "text" },
];

const ITEM_EDIT_FIELDS: readonly EditFieldSpec[] = [
  { key: "text", label: "Question", kind: "textarea", nullable: false },
  { key: "section", label: "Section", kind: "text" },
  { key: "itemNumber", label: "Number", kind: "text" },
  { key: "position", label: "Position", kind: "integer", nullable: false },
  {
    key: "itemType",
    label: "Answer type",
    kind: "select",
    nullable: false,
    options: ITEM_TYPES.map((value) => ({ value, label: labelize(value) })),
  },
  { key: "unit", label: "Unit", kind: "text" },
  { key: "targetValue", label: "Target", kind: "number" },
  { key: "minValue", label: "Minimum", kind: "number" },
  { key: "maxValue", label: "Maximum", kind: "number" },
  { key: "tolerancePlus", label: "Tolerance +", kind: "number" },
  { key: "toleranceMinus", label: "Tolerance −", kind: "number" },
  { key: "weight", label: "Weight", kind: "number", nullable: false },
  { key: "acceptanceCriteria", label: "Acceptance criteria", kind: "textarea" },
  { key: "guidance", label: "Guidance", kind: "textarea" },
  { key: "specReference", label: "Specification reference", kind: "text" },
  { key: "required", label: "Required", kind: "boolean" },
  { key: "isCritical", label: "Critical", kind: "boolean" },
  { key: "isHoldPoint", label: "Hold point", kind: "boolean" },
  { key: "raisesNcrOnFail", label: "Raises an NCR on failure", kind: "boolean" },
  { key: "photoRequired", label: "Photograph required", kind: "boolean" },
];

/** The API stores booleans as 0/1 columns; the edit form speaks true/false. */
function itemAsRecord(item: ChecklistTemplateItem): Record<string, unknown> {
  return {
    ...item,
    required: item.required === 1,
    isCritical: item.isCritical === 1,
    isHoldPoint: item.isHoldPoint === 1,
    raisesNcrOnFail: item.raisesNcrOnFail === 1,
    photoRequired: item.photoRequired === 1,
  };
}

export default function TemplatesPanel({
  templates,
  onMutated,
}: {
  templates: Resource<Paged<ChecklistTemplate>>;
  onMutated: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = templates.data?.items ?? [];

  if (templates.error) {
    return (
      <LoadError
        message={templates.error}
        onRetry={templates.reload}
        title="The form register could not be loaded"
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {templates.data
            ? `${templates.data.total} ${plural(templates.data.total, "form")} · ${rows.filter((t) => t.status === "active").length} issued`
            : "Loading the forms…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          Draft a form
        </Button>
      </div>

      {rows.length === 0 ? (
        <NothingHere
          title="No controlled form exists in this company"
          reason="Every checklist is recorded against an issued form, so until one exists nothing can be recorded — and a project that inspects against forms nobody controls cannot show two inspections were of the same thing."
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Draft the first one
            </Button>
          }
        />
      ) : (
        <ul className="space-y-1.5">
          {rows.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle p-2.5 text-meta"
            >
              <span className="font-mono text-2xs">
                {t.reference} v{t.version}
              </span>
              <Badge tone={STATUS_TONE[t.status] ?? "neutral"} size="xs" dot>
                {labelize(t.status)}
              </Badge>
              <span className="min-w-0 font-medium text-content">{t.name}</span>
              <Badge tone="neutral" size="xs" variant="outline">
                {labelize(t.category)}
              </Badge>
              {t.isStatutory === 1 ? (
                <Badge tone="accent" size="xs" variant="outline">
                  statutory
                </Badge>
              ) : null}
              <span className="text-2xs text-content-subtle">
                {t.itemCount} {plural(t.itemCount, "question")} ·{" "}
                {t.approvedAt ? `issued ${isoDate(t.approvedAt)}` : "never issued"}
              </span>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() => setOpenId(t.id)}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}

      <CreateTemplate
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          templates.reload();
          onMutated();
          setOpenId(id);
        }}
      />
      <TemplateModal
        templateId={openId}
        onClose={() => setOpenId(null)}
        onMutated={() => {
          templates.reload();
          onMutated();
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* Drafting a form                                                     */
/* ================================================================== */

function CreateTemplate({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [reference, setReference] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("quality");
  const [scoringMethod, setScoringMethod] = useState("pass_fail");
  const [passThreshold, setPassThreshold] = useState("");
  const [isStatutory, setIsStatutory] = useState(false);
  const [regulatoryBasis, setRegulatoryBasis] = useState("");
  const [description, setDescription] = useState("");

  async function create() {
    const threshold = Number(passThreshold);
    const created = await run("create", () =>
      api.post<TemplateDetail>(TEMPLATE_BASE, {
        reference: reference.trim(),
        name: name.trim(),
        category,
        scoringMethod,
        passThreshold:
          passThreshold.trim() === "" || !Number.isFinite(threshold) ? null : threshold,
        isStatutory,
        regulatoryBasis: regulatoryBasis.trim() === "" ? null : regulatoryBasis.trim(),
        description: description.trim() === "" ? null : description.trim(),
      }),
    );
    if (created) {
      setReference("");
      setName("");
      setDescription("");
      onCreated(created.id);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Draft a controlled form"
      description="It starts as a draft with no questions. Nothing can be recorded against it until the questions are written and somebody other than you issues it."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "create"}
            disabled={reference.trim() === "" || name.trim() === ""}
            onClick={create}
          >
            Create the draft
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Reference"
            required
            hint="Stays the same across every revision — it is how the form is known."
          >
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="QF-014"
              autoFocus
            />
          </Field>
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pre-pour inspection — suspended slabs"
            />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Scoring"
            hint="pass_fail carries a verdict and no percentage, which is honest for most site forms."
          >
            <Select value={scoringMethod} onChange={(e) => setScoringMethod(e.target.value)}>
              {SCORING_METHODS.map((m) => (
                <option key={m} value={m}>
                  {labelize(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pass threshold (%)" hint="Only meaningful for a scored form.">
            <Input
              type="number"
              value={passThreshold}
              onChange={(e) => setPassThreshold(e.target.value)}
            />
          </Field>
          <Field label="Regulatory basis" hint="For a statutory form, the instrument it comes from.">
            <Input
              value={regulatoryBasis}
              onChange={(e) => setRegulatoryBasis(e.target.value)}
              placeholder="LOLER 1998 reg. 9"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-meta">
          <input
            type="checkbox"
            checked={isStatutory}
            onChange={(e) => setIsStatutory(e.target.checked)}
          />
          This is a statutory form — the inspection it records is required by law, not by the
          contract.
        </label>
        <Field label="Description">
          <Textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* One form: its questions and its lifecycle                           */
/* ================================================================== */

function TemplateModal({
  templateId,
  onClose,
  onMutated,
}: {
  templateId: string | null;
  onClose: () => void;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog } = useReason();
  const [editOpen, setEditOpen] = useState(false);
  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const base = `${TEMPLATE_BASE}/${templateId ?? ""}`;
  const template = useResource<TemplateDetail>(
    (signal) => api.get<TemplateDetail>(base, { signal }),
    [base],
    templateId !== null,
  );
  if (!templateId) return null;
  const t = template.data;
  const draft = t?.status === "draft";
  const reload = () => {
    template.reload();
    onMutated();
  };
  const editingItem = t?.items.find((i) => i.id === editItemId) ?? null;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t ? `${t.reference} v${t.version} — ${t.name}` : "Controlled form"}
      description="A draft is written freely. An issued form is revised, never edited, because people have already filled it in."
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {t && draft ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
                Edit the form
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={busy === "approve"}
                disabled={t.items.length === 0}
                onClick={async () => {
                  const done = await run("approve", () => api.post(`${base}/approve`, {}));
                  if (done) reload();
                }}
              >
                Issue it
              </Button>
            </>
          ) : null}
          {t && t.status === "active" ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "revise"}
                onClick={async () => {
                  const done = await run("revise", () => api.post(`${base}/revise`, {}));
                  if (done) {
                    reload();
                    onClose();
                  }
                }}
              >
                Revise it
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === "retire"}
                onClick={async () => {
                  const reason = await ask({
                    title: `Retire ${t.reference} v${t.version}`,
                    description:
                      "Retiring withdraws the form: no new checklist can be taken against it. Records already taken keep pointing at this version, which is the point of versioning it.",
                    label: "Why is it being withdrawn?",
                    confirmLabel: "Retire the form",
                    destructive: true,
                  });
                  if (!reason) return;
                  const done = await run("retire", () =>
                    api.post(`${base}/retire`, { reason }),
                  );
                  if (done) reload();
                }}
              >
                Retire it
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      {template.error ? (
        <LoadError message={template.error} onRetry={template.reload} />
      ) : !t ? (
        <p className="text-meta text-content-muted">Loading…</p>
      ) : (
        <div className="space-y-3 text-meta">
          {dialog}
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS_TONE[t.status] ?? "neutral"} size="xs" dot>
              {labelize(t.status)}
            </Badge>
            <Badge tone="neutral" size="xs" variant="outline">
              {labelize(t.category)}
            </Badge>
            <Badge tone="neutral" size="xs" variant="outline">
              {labelize(t.scoringMethod)}
              {t.passThreshold === null ? "" : ` · pass at ${t.passThreshold}%`}
            </Badge>
            {t.isStatutory === 1 ? (
              <Badge tone="accent" size="xs" variant="solid">
                statutory{t.regulatoryBasis ? ` · ${t.regulatoryBasis}` : ""}
              </Badge>
            ) : null}
          </div>
          {t.description ? (
            <p className="whitespace-pre-wrap text-content-muted">{t.description}</p>
          ) : null}
          {draft ? (
            <p className="text-2xs text-content-subtle">
              This form is a draft: nothing can be recorded against it yet, and the issue is not
              yours to give if you drafted it — the API refuses a self-approved form.
            </p>
          ) : null}

          <div className="rounded-md border border-border-subtle p-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-label uppercase tracking-wide text-content-subtle">
                Questions ({t.items.length})
              </div>
              {draft ? (
                <Button size="xs" variant="ghost" icon={IconPlus} onClick={() => setAddOpen(true)}>
                  Add a question
                </Button>
              ) : null}
            </div>
            {t.items.length === 0 ? (
              <p className="mt-1 text-content-muted">
                No question yet. A form with no questions cannot be issued — it records nothing.
              </p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {t.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-start gap-1.5 rounded border border-border-subtle px-2 py-1.5"
                  >
                    <span className="font-mono text-2xs text-content-subtle">
                      {item.itemNumber ?? item.position}
                    </span>
                    <span className="min-w-0 flex-1 text-content">{item.text}</span>
                    <Badge tone="neutral" size="xs" variant="outline">
                      {labelize(item.itemType)}
                    </Badge>
                    {NUMERIC_TYPES.includes(item.itemType) ? (
                      <span className="text-2xs text-content-subtle tabular-nums">
                        {item.minValue === null && item.maxValue === null
                          ? "no window"
                          : `${item.minValue ?? EM_DASH} … ${item.maxValue ?? EM_DASH}`}
                        {item.unit ? ` ${item.unit}` : ""}
                      </span>
                    ) : null}
                    {item.isCritical === 1 ? (
                      <Badge tone="danger" size="xs" variant="outline">
                        critical
                      </Badge>
                    ) : null}
                    {item.isHoldPoint === 1 ? (
                      <Badge tone="warning" size="xs" variant="outline">
                        hold point
                      </Badge>
                    ) : null}
                    {item.raisesNcrOnFail === 1 ? (
                      <Badge tone="warning" size="xs" variant="outline">
                        raises an NCR
                      </Badge>
                    ) : null}
                    {draft ? (
                      <span className="flex gap-1">
                        <Button size="xs" variant="ghost" onClick={() => setEditItemId(item.id)}>
                          Edit
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          loading={busy === `del-${item.id}`}
                          onClick={async () => {
                            const done = await run(`del-${item.id}`, () =>
                              api.del(`${base}/items/${item.id}`),
                            );
                            if (done) reload();
                          }}
                        >
                          Remove
                        </Button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <EditModal
            open={editOpen}
            onClose={() => setEditOpen(false)}
            title={`Edit ${t.reference} v${t.version}`}
            description="The form's own fields while it is a draft. The reference is fixed: it identifies this form across every revision of it."
            url={base}
            fields={TEMPLATE_EDIT_FIELDS}
            record={t as unknown as Record<string, unknown>}
            onSaved={reload}
          />
          <EditModal
            open={editingItem !== null}
            onClose={() => setEditItemId(null)}
            title="Edit the question"
            description="A numeric question needs a window to be judged against; the API refuses a definition that cannot produce a verdict, and says which part is missing."
            url={`${base}/items/${editItemId ?? ""}`}
            fields={ITEM_EDIT_FIELDS}
            record={editingItem ? itemAsRecord(editingItem) : null}
            onSaved={reload}
          />
          <AddItem
            open={addOpen}
            base={base}
            onClose={() => setAddOpen(false)}
            onCreated={() => {
              setAddOpen(false);
              reload();
            }}
          />
        </div>
      )}
    </Modal>
  );
}

/**
 * ADDING A QUESTION. The type decides what the answer can be judged against:
 * a numeric question with no window is a number nobody can call right or
 * wrong, so the window is offered here rather than left to be added later —
 * and the API refuses the definition outright if it cannot produce a verdict.
 */
function AddItem({
  open,
  base,
  onClose,
  onCreated,
}: {
  open: boolean;
  base: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [text, setText] = useState("");
  const [section, setSection] = useState("");
  const [itemNumber, setItemNumber] = useState("");
  const [itemType, setItemType] = useState("pass_fail");
  const [unit, setUnit] = useState("");
  const [minValue, setMinValue] = useState("");
  const [maxValue, setMaxValue] = useState("");
  const [targetValue, setTargetValue] = useState("");
  const [options, setOptions] = useState("");
  const [required, setRequired] = useState(true);
  const [isCritical, setIsCritical] = useState(false);
  const [isHoldPoint, setIsHoldPoint] = useState(false);
  const [raisesNcrOnFail, setRaisesNcrOnFail] = useState(false);
  const [photoRequired, setPhotoRequired] = useState(false);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");

  const numeric = NUMERIC_TYPES.includes(itemType);
  const select = itemType === "single_select" || itemType === "multi_select";

  function numOrNull(value: string): number | null {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function create() {
    const done = await run("add", () =>
      api.post(`${base}/items`, {
        text: text.trim(),
        section: section.trim() === "" ? null : section.trim(),
        itemNumber: itemNumber.trim() === "" ? null : itemNumber.trim(),
        itemType,
        required,
        isCritical,
        isHoldPoint,
        raisesNcrOnFail,
        photoRequired,
        unit: unit.trim() === "" ? null : unit.trim(),
        minValue: numeric ? numOrNull(minValue) : null,
        maxValue: numeric ? numOrNull(maxValue) : null,
        targetValue: numeric ? numOrNull(targetValue) : null,
        options: select
          ? options
              .split(",")
              .map((o) => o.trim())
              .filter((o) => o !== "")
          : [],
        acceptanceCriteria:
          acceptanceCriteria.trim() === "" ? null : acceptanceCriteria.trim(),
      }),
    );
    if (done) {
      setText("");
      setItemNumber("");
      setMinValue("");
      setMaxValue("");
      setTargetValue("");
      setOptions("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a question"
      description="What is asked on site, and what makes the answer right or wrong."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "add"}
            disabled={text.trim() === ""}
            onClick={create}
          >
            Add it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalNotice refusal={refusal} onDismiss={clear} />
        <Field label="Question" required>
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Section">
            <Input value={section} onChange={(e) => setSection(e.target.value)} />
          </Field>
          <Field label="Number">
            <Input value={itemNumber} onChange={(e) => setItemNumber(e.target.value)} />
          </Field>
          <Field label="Answer type">
            <Select value={itemType} onChange={(e) => setItemType(e.target.value)}>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {numeric ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Unit">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="mm" />
            </Field>
            <Field label="Target">
              <Input
                type="number"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
              />
            </Field>
            <Field label="Minimum" hint="Blank is an open end, not zero.">
              <Input
                type="number"
                value={minValue}
                onChange={(e) => setMinValue(e.target.value)}
              />
            </Field>
            <Field label="Maximum">
              <Input
                type="number"
                value={maxValue}
                onChange={(e) => setMaxValue(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
        {select ? (
          <Field label="Options" hint="Comma separated; the answer must be one of them.">
            <Input value={options} onChange={(e) => setOptions(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Acceptance criteria">
          <Textarea
            rows={2}
            value={acceptanceCriteria}
            onChange={(e) => setAcceptanceCriteria(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-3 text-2xs">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            Required
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isCritical}
              onChange={(e) => setIsCritical(e.target.checked)}
            />
            Critical — a failure fails the whole checklist
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isHoldPoint}
              onChange={(e) => setIsHoldPoint(e.target.checked)}
            />
            Hold point
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={raisesNcrOnFail}
              onChange={(e) => setRaisesNcrOnFail(e.target.checked)}
            />
            Raises an NCR when it fails
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={photoRequired}
              onChange={(e) => setPhotoRequired(e.target.checked)}
            />
            Photograph required
          </label>
        </div>
      </div>
    </Modal>
  );
}
