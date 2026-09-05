/**
 * RAISING THE REST OF THE PROGRAMME.
 *
 * The incident and the observation have had a form since the first release;
 * everything else the module holds — the inspection, the template it is
 * answered against, the toolbox talk, the policy or permit or RAMS — could be
 * created only by an API client. That is not a small gap: an inspection
 * template is the question list a site is measured against, and a workspace
 * that can display one but not author one leaves the register to whoever has
 * a terminal.
 *
 * Each form asks for the minimum the API will accept and says what happens
 * next, because every one of these records has a SECOND act that a different
 * person has to perform: a template is drafted and then approved by somebody
 * else, an inspection is scheduled and then answered, a talk is planned and
 * then delivered and then verified, a RAMS is written and then approved and
 * then acknowledged. The forms say so rather than implying that saving is the
 * end of it.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from "../../ui";
import { api } from "../../lib/api";
import {
  RefusalNotice,
  labelize,
  useMutation,
  type InspectionTemplate,
  type Paged,
  type Resource,
} from "./safetyShared";

const INSPECTION_TYPES = [
  "general_site",
  "scaffold",
  "excavation",
  "lifting_equipment",
  "lifting_operation",
  "electrical",
  "fire",
  "ppe",
  "welfare",
  "plant",
  "temporary_works",
  "permit_audit",
  "environmental",
  "statutory",
  "executive_walk",
  "client_walk",
  "third_party",
];

const CATEGORIES = [
  "ppe",
  "working_at_height",
  "housekeeping",
  "electrical",
  "excavation",
  "lifting_operations",
  "hot_works",
  "confined_space",
  "plant_and_equipment",
  "manual_handling",
  "hazardous_substances",
  "fire",
  "traffic_management",
  "temporary_works",
  "permit_compliance",
  "environmental",
  "welfare",
  "behaviour",
  "emergency_preparedness",
  "other",
];

/** Every kind the programme register accepts — the frozen list plus this wave's. */
const RECORD_KINDS = [
  "policy",
  "risk_assessment",
  "method_statement",
  "jha",
  "permit_to_work",
  "training_record",
  "competency_card",
  "induction_record",
  "emergency_plan",
  "statutory_register",
  "temporary_works_design",
  "coshh_assessment",
  "safety_meeting_minutes",
  "drug_alcohol_policy",
  "drug_alcohol_test",
  "lone_worker_procedure",
  "fatigue_management_plan",
  "wellbeing_record",
  "contractor_safety_plan",
  "other",
];

const SCORING_METHODS = ["percentage", "weighted", "points", "pass_fail", "none"];
const ITEM_TYPES = ["pass_fail", "pass_fail_na", "text", "long_text", "number", "photo", "section_header"];
const FREQUENCIES = ["ad_hoc", "daily", "weekly", "fortnightly", "monthly", "quarterly", "biannual", "annual"];

const todayInput = (): string => new Date().toISOString().slice(0, 10);

function Refusals({ mutation }: { mutation: ReturnType<typeof useMutation> }) {
  return (
    <>
      {mutation.refusal ? (
        <div className="mb-3">
          <RefusalNotice refusal={mutation.refusal} onDismiss={mutation.clear} />
        </div>
      ) : null}
      {mutation.error ? (
        <div className="mb-3">
          <Alert tone="danger" title="That could not be saved" onDismiss={mutation.clear}>
            {mutation.error}
          </Alert>
        </div>
      ) : null}
    </>
  );
}

/* ========================================================================== */
/* Inspection                                                                  */
/* ========================================================================== */

export function NewInspectionModal({
  projectId,
  open,
  templates,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  templates: Resource<Paged<InspectionTemplate>>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const mutation = useMutation(() => undefined);
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [inspectionType, setInspectionType] = useState("general_site");
  const [scheduledFor, setScheduledFor] = useState(todayInput());
  const [locationText, setLocationText] = useState("");
  const [isStatutory, setIsStatutory] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setLocationText("");
      setIsStatutory(false);
      mutation.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const approved = (templates.data?.items ?? []).filter((t) => t.status === "active");
  const usable = approved.length > 0 ? approved : (templates.data?.items ?? []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule an inspection"
      size="md"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={title.trim() === ""}
            loading={mutation.busy !== null}
            onClick={() =>
              void mutation.run("create", "This inspection could not be scheduled", async () => {
                const created = await api.post<{ id: string }>(
                  `/api/v1/projects/${projectId}/safety/inspections`,
                  {
                    ...(templateId ? { templateId } : {}),
                    title: title.trim(),
                    inspectionType,
                    ...(scheduledFor ? { scheduledFor } : {}),
                    ...(locationText.trim() ? { locationText: locationText.trim() } : {}),
                    ...(isStatutory ? { isStatutory: true } : {}),
                  },
                );
                onCreated(created.id);
              })
            }
          >
            Schedule it
          </Button>
        </div>
      }
    >
      <Refusals mutation={mutation} />
      <div className="space-y-3">
        <Alert tone="info" title="Scheduling is not inspecting">
          This creates the record. It is answered later, item by item, against the template version
          stamped at that moment — so a template revised next month cannot rewrite what was asked
          today. An inspection with no answers is a walk that has not happened; it is never a pass.
        </Alert>

        <Field
          label="Template"
          hint="Without one the inspection cannot be scored or even checked against a question list, and the platform will refuse to complete it."
        >
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">No template — free-form</option>
            {usable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · v{t.version} · {labelize(t.status)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Title" required>
          <Input
            value={title}
            placeholder="What is being inspected, and where"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">
            <Select value={inspectionType} onChange={(e) => setInspectionType(e.target.value)}>
              {INSPECTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scheduled for">
            <Input
              type="date"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Location">
          <Input value={locationText} onChange={(e) => setLocationText(e.target.value)} />
        </Field>

        <Checkbox
          checked={isStatutory}
          onChange={(e) => setIsStatutory(e.target.checked)}
          label="Statutory inspection"
          description="A statutory inspection carries a fixed re-inspection interval and is swept for being overdue — the interval comes from the template's frequency."
        />
      </div>
    </Modal>
  );
}

/* ========================================================================== */
/* Inspection template                                                         */
/* ========================================================================== */

interface DraftItem {
  key: number;
  text: string;
  itemType: string;
  required: boolean;
  isCritical: boolean;
  photoRequired: boolean;
  section: string;
}

let itemKey = 0;
const blankItem = (): DraftItem => ({
  key: (itemKey += 1),
  text: "",
  itemType: "pass_fail",
  required: true,
  isCritical: false,
  photoRequired: false,
  section: "",
});

export function NewTemplateModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const mutation = useMutation(() => undefined);
  const [reference, setReference] = useState("");
  const [name, setName] = useState("");
  const [inspectionType, setInspectionType] = useState("general_site");
  const [scoringMethod, setScoringMethod] = useState("percentage");
  const [passThreshold, setPassThreshold] = useState("80");
  const [frequency, setFrequency] = useState("ad_hoc");
  const [isStatutory, setIsStatutory] = useState(false);
  const [regulatoryBasis, setRegulatoryBasis] = useState("");
  const [items, setItems] = useState<DraftItem[]>(() => [blankItem()]);

  useEffect(() => {
    if (!open) {
      setReference("");
      setName("");
      setItems([blankItem()]);
      mutation.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filled = items.filter((i) => i.text.trim() !== "");
  const valid = reference.trim() !== "" && name.trim() !== "" && filled.length > 0;

  function update(key: number, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New inspection template"
      size="lg"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            loading={mutation.busy !== null}
            onClick={() =>
              void mutation.run("create", "This template could not be created", async () => {
                await api.post(`/api/v1/companies/current/safety/inspection-templates`, {
                  reference: reference.trim(),
                  name: name.trim(),
                  inspectionType,
                  scoringMethod,
                  ...(scoringMethod === "percentage" || scoringMethod === "weighted"
                    ? { passThreshold: Number(passThreshold) }
                    : {}),
                  frequency,
                  ...(isStatutory ? { isStatutory: true } : {}),
                  ...(regulatoryBasis.trim() ? { regulatoryBasis: regulatoryBasis.trim() } : {}),
                  items: filled.map((i, index) => ({
                    text: i.text.trim(),
                    itemType: i.itemType,
                    required: i.required,
                    isCritical: i.isCritical,
                    photoRequired: i.photoRequired,
                    position: index,
                    ...(i.section.trim() ? { section: i.section.trim() } : {}),
                  })),
                });
                onCreated();
              })
            }
          >
            Create as a draft
          </Button>
        </div>
      }
    >
      <Refusals mutation={mutation} />
      <div className="space-y-3">
        <Alert tone="info" title="A template is drafted here and approved by somebody else">
          It is created as a draft and cannot be used until a second person approves it. That is
          deliberate: the question list is the standard a site is measured against, and an author
          approving their own is a standard nobody checked. Marking an item CRITICAL means failing it
          fails the whole inspection whatever the percentage says; marking it PHOTO-REQUIRED means
          the platform will refuse a completion that answers it without a photograph.
        </Alert>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reference" required hint="How the form is known on site.">
            <Input
              value={reference}
              placeholder="TPL-SCAF-01"
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Inspection type">
            <Select value={inspectionType} onChange={(e) => setInspectionType(e.target.value)}>
              {INSPECTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scoring">
            <Select value={scoringMethod} onChange={(e) => setScoringMethod(e.target.value)}>
              {SCORING_METHODS.map((m) => (
                <option key={m} value={m}>
                  {labelize(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Pass threshold %"
            hint="Below it the inspection fails. Without one, any defect downgrades a pass."
          >
            <Input
              type="number"
              min={0}
              max={100}
              value={passThreshold}
              disabled={scoringMethod !== "percentage" && scoringMethod !== "weighted"}
              onChange={(e) => setPassThreshold(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Frequency" hint="Sets the re-inspection interval on statutory inspections.">
            <Select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {labelize(f)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Regulatory basis" hint="The regulation this form discharges, if any.">
            <Input
              value={regulatoryBasis}
              placeholder="Work at Height Regulations 2005 reg. 12"
              onChange={(e) => setRegulatoryBasis(e.target.value)}
            />
          </Field>
        </div>

        <Checkbox
          checked={isStatutory}
          onChange={(e) => setIsStatutory(e.target.checked)}
          label="Statutory form"
          description="Inspections using it carry a fixed re-inspection interval and are swept for being overdue."
        />

        <div className="space-y-2">
          <p className="text-label uppercase text-content-subtle">
            Questions · {filled.length} usable
          </p>
          {items.map((item) => (
            <div key={item.key} className="rounded-lg border border-border bg-surface-raised p-2.5">
              <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
                <Field label="Question">
                  <Input
                    value={item.text}
                    placeholder="Guardrails continuous at every lift"
                    onChange={(e) => update(item.key, { text: e.target.value })}
                  />
                </Field>
                <Field label="Answer type">
                  <Select
                    value={item.itemType}
                    onChange={(e) => update(item.key, { itemType: e.target.value })}
                  >
                    {ITEM_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {labelize(t)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="Section">
                  <Input
                    value={item.section}
                    placeholder="Access"
                    onChange={(e) => update(item.key, { section: e.target.value })}
                  />
                </Field>
                <div className="flex flex-wrap items-end gap-3 pb-1">
                  <Checkbox
                    size="sm"
                    checked={item.required}
                    onChange={(e) => update(item.key, { required: e.target.checked })}
                    label="Required"
                  />
                  <Checkbox
                    size="sm"
                    checked={item.isCritical}
                    onChange={(e) => update(item.key, { isCritical: e.target.checked })}
                    label="Critical"
                  />
                  <Checkbox
                    size="sm"
                    checked={item.photoRequired}
                    onChange={(e) => update(item.key, { photoRequired: e.target.checked })}
                    label="Photo required"
                  />
                  {items.length > 1 ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
          <Button size="xs" variant="outline" onClick={() => setItems((prev) => [...prev, blankItem()])}>
            Add a question
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ========================================================================== */
/* Toolbox talk                                                                */
/* ========================================================================== */

export function NewTalkModal({
  projectId,
  open,
  vendors,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  vendors: Map<string, string>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const mutation = useMutation(() => undefined);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [category, setCategory] = useState("other");
  const [talkDate, setTalkDate] = useState(todayInput());
  const [durationMinutes, setDurationMinutes] = useState("15");
  const [vendorId, setVendorId] = useState("");
  const [language, setLanguage] = useState("");
  const [interpreterUsed, setInterpreterUsed] = useState(false);
  const [contentSummary, setContentSummary] = useState("");

  useEffect(() => {
    if (!open) {
      setTitle("");
      setTopic("");
      setContentSummary("");
      mutation.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Plan a toolbox talk"
      size="md"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={title.trim() === "" || talkDate === ""}
            loading={mutation.busy !== null}
            onClick={() =>
              void mutation.run("create", "This talk could not be created", async () => {
                const created = await api.post<{ id: string }>(
                  `/api/v1/projects/${projectId}/safety/toolbox-talks`,
                  {
                    title: title.trim(),
                    ...(topic.trim() ? { topic: topic.trim() } : {}),
                    category,
                    talkDate,
                    ...(durationMinutes ? { durationMinutes: Number(durationMinutes) } : {}),
                    ...(vendorId ? { vendorId } : {}),
                    ...(language.trim() ? { language: language.trim() } : {}),
                    ...(interpreterUsed ? { interpreterUsed: true } : {}),
                    ...(contentSummary.trim() ? { contentSummary: contentSummary.trim() } : {}),
                  },
                );
                onCreated(created.id);
              })
            }
          >
            Create the talk
          </Button>
        </div>
      }
    >
      <Refusals mutation={mutation} />
      <div className="space-y-3">
        <Alert tone="info" title="Attendance is what makes this evidence">
          The talk is created as planned. Add the people who actually attended, then mark it
          delivered — an attendance list is the only thing that answers "was this person briefed",
          and it is the first document requested after an incident involving them.
        </Alert>

        <Field label="Title" required>
          <Input
            value={title}
            placeholder="Working near the excavation edge"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Topic">
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} />
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
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date" required>
            <Input type="date" value={talkDate} onChange={(e) => setTalkDate(e.target.value)} />
          </Field>
          <Field label="Minutes">
            <Input
              type="number"
              min={1}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
            />
          </Field>
          <Field label="Subcontractor">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Our own crews</option>
              {[...vendors.entries()].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Language delivered in"
            hint="A briefing given in a language the crew does not read is not a briefing."
          >
            <Input value={language} onChange={(e) => setLanguage(e.target.value)} />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox
              checked={interpreterUsed}
              onChange={(e) => setInterpreterUsed(e.target.checked)}
              label="Interpreter used"
            />
          </div>
        </div>

        <Field label="What was covered">
          <Textarea
            rows={3}
            value={contentSummary}
            onChange={(e) => setContentSummary(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ========================================================================== */
/* Programme record                                                            */
/* ========================================================================== */

export function NewProgrammeRecordModal({
  projectId,
  open,
  vendors,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  vendors: Map<string, string>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const mutation = useMutation(() => undefined);
  const [recordKind, setRecordKind] = useState("method_statement");
  const [title, setTitle] = useState("");
  const [version, setVersion] = useState("1.0");
  const [scope, setScope] = useState<"project" | "company">("project");
  const [effectiveFrom, setEffectiveFrom] = useState(todayInput());
  const [expiresAt, setExpiresAt] = useState("");
  const [reviewIntervalMonths, setReviewIntervalMonths] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [regulatoryReference, setRegulatoryReference] = useState("");
  const [requiredAcknowledgementCount, setRequiredAcknowledgementCount] = useState("");
  const [sitePermitId, setSitePermitId] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) {
      setTitle("");
      setExpiresAt("");
      setDescription("");
      setRequiredAcknowledgementCount("");
      setSitePermitId("");
      mutation.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const criticalKind =
    recordKind === "permit_to_work" ||
    recordKind === "competency_card" ||
    recordKind === "temporary_works_design";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New programme record"
      size="md"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={title.trim() === ""}
            loading={mutation.busy !== null}
            onClick={() =>
              void mutation.run("create", "This record could not be created", async () => {
                const created = await api.post<{ id: string }>(
                  `/api/v1/companies/current/safety/programme-records`,
                  {
                    recordKind,
                    title: title.trim(),
                    projectId: scope === "project" ? projectId : null,
                    ...(version.trim() ? { version: version.trim() } : {}),
                    ...(description.trim() ? { description: description.trim() } : {}),
                    ...(effectiveFrom ? { effectiveFrom } : {}),
                    ...(expiresAt ? { expiresAt } : {}),
                    ...(reviewIntervalMonths
                      ? { reviewIntervalMonths: Number(reviewIntervalMonths) }
                      : {}),
                    ...(vendorId ? { vendorId } : {}),
                    ...(regulatoryReference.trim()
                      ? { regulatoryReference: regulatoryReference.trim() }
                      : {}),
                    ...(requiredAcknowledgementCount
                      ? { requiredAcknowledgementCount: Number(requiredAcknowledgementCount) }
                      : {}),
                    ...(sitePermitId.trim() ? { sitePermitId: sitePermitId.trim() } : {}),
                  },
                );
                onCreated(created.id);
              })
            }
          >
            Create as a draft
          </Button>
        </div>
      }
    >
      <Refusals mutation={mutation} />
      <div className="space-y-3">
        <Alert tone="info" title="These records share one table because they all expire">
          Something has to watch the date, and that is what this register is for. A record is created
          as a draft, approved by somebody other than its author, and then acknowledged by the people
          it governs. Renewal is bound to the platform's obligations register — the same one that
          carries contractual time bars.
        </Alert>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind" required>
            <Select value={recordKind} onChange={(e) => setRecordKind(e.target.value)}>
              {RECORD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scope">
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value === "company" ? "company" : "project")}
            >
              <option value="project">This project</option>
              <option value="company">Company-wide</option>
            </Select>
          </Field>
        </div>

        <Field label="Title" required>
          <Input
            value={title}
            placeholder="MS-021 Facade panel installation"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Version">
            <Input value={version} onChange={(e) => setVersion(e.target.value)} />
          </Field>
          <Field label="Effective from">
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
          <Field
            label="Expires"
            hint={
              criticalKind
                ? "This kind stops work when it lapses — the expiry sweep raises a critical signal."
                : "Leave blank if it does not expire."
            }
          >
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Review every (months)">
            <Input
              type="number"
              min={1}
              value={reviewIntervalMonths}
              onChange={(e) => setReviewIntervalMonths(e.target.value)}
            />
          </Field>
          <Field label="Belongs to">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Us</option>
              {[...vendors.entries()].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Acknowledgements needed"
            hint="The number of people who must confirm they have read it. The shortfall is shown on the register."
          >
            <Input
              type="number"
              min={0}
              value={requiredAcknowledgementCount}
              onChange={(e) => setRequiredAcknowledgementCount(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Regulatory reference">
            <Input
              value={regulatoryReference}
              placeholder="CDM 2015 reg. 15"
              onChange={(e) => setRegulatoryReference(e.target.value)}
            />
          </Field>
          <Field
            label="Permit-to-work id"
            hint="The live authorisation in site operations this document was issued against. A record is the DOCUMENT; the site permit is the entry, the exit and the exclusion zone. A link to a permit that does not exist is refused."
          >
            <Input
              value={sitePermitId}
              placeholder="sper_…"
              onChange={(e) => setSitePermitId(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
