/**
 * Rule builder: trigger picker, condition rows, action rows with a parameter
 * editor per action type, a dry run against a real record or a sample, and
 * save (create or edit). Conditions are edited as a flat list joined by ALL
 * or ANY — the shape every template uses — with an "advanced" JSON editor for
 * nested groups. Everything the builder produces is exactly what the API
 * validates: there is no client-side dialect.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  ErrorAlert,
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from "../../ui";
import { IconArrowDown, IconArrowUp, IconPlay, IconPlus, IconTrash } from "../../ui/icons";
import {
  DAY_OPERATORS,
  LIST_OPERATORS,
  NUMERIC_OPERATORS,
  OPERATOR_LABELS,
  VALUELESS_OPERATORS,
  actionLabel,
  asList,
  dateFields,
  errorMessage,
  humanize,
  isLeaf,
  localId,
  operatorLabel,
  userFields,
  type ActionJson,
  type Catalogue,
  type CatalogueField,
  type CatalogueObjectType,
  type ConditionJson,
  type ConditionLeaf,
  type DryRunResult,
  type NotifyTargetJson,
  type ProjectPick,
  type RuleView,
  type Scope,
  type TemplateView,
  type TriggerJson,
} from "./automationShared";
import { DryRunPanel } from "./RunsTab";

/* ================================ Draft ================================== */

interface CondRow {
  id: string;
  field: string;
  op: string;
  value: string;
}

interface ActionRow {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

interface Draft {
  name: string;
  description: string;
  projectId: string;
  triggerKind: "event" | "schedule";
  objectType: string;
  action: string;
  everyMinutes: string;
  cooldownHours: string;
  match: "all" | "any";
  conditions: CondRow[];
  advanced: boolean;
  advancedJson: string;
  actions: ActionRow[];
  immediate: boolean;
  priority: string;
}

const EVENT_FIELDS: CatalogueField[] = [
  { path: "event.action", type: "enum", label: "Event action", options: ["create", "update", "delete", "state_change", "access"] },
  { path: "event.objectType", type: "text", label: "Event object type" },
  { path: "event.objectId", type: "text", label: "Event object id" },
  { path: "event.actorId", type: "user", label: "Event actor" },
  { path: "event.at", type: "datetime", label: "Event time" },
];

/** Used only when the catalogue could not be loaded; mirrors AUTOMATION_CONDITION_OPERATORS. */
const FALLBACK_OPERATORS: readonly string[] = Object.keys(OPERATOR_LABELS);

const COMPANY_ROLES = ["owner", "admin", "member", "guest"] as const;
const ASSURANCE_ROLES = ["integrity_reviewer", "auditor", "regulator"] as const;

function valueToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function emptyDraft(scope: Scope): Draft {
  return {
    name: "",
    description: "",
    projectId: scope.projectId ?? "",
    triggerKind: "event",
    objectType: "rfi",
    action: "*",
    everyMinutes: "60",
    cooldownHours: "24",
    match: "all",
    conditions: [],
    advanced: false,
    advancedJson: "",
    actions: [{ id: localId("act"), type: "notify", params: { to: [{ kind: "roles", roles: ["owner", "admin"] }] } }],
    immediate: false,
    priority: "100",
  };
}

function draftFromSource(
  source: { name: string; description: string | null; projectId: string | null; trigger: TriggerJson; conditions: ConditionJson | null; actions: ActionJson[]; immediate: boolean; priority?: number },
  scope: Scope,
): Draft {
  const base = emptyDraft(scope);
  const rows: CondRow[] = [];
  let match: "all" | "any" = "all";
  let advanced = false;
  const c = source.conditions;
  if (c) {
    if (isLeaf(c)) rows.push({ id: localId("cond"), field: c.field, op: c.op, value: valueToString(c.value) });
    else if (("all" in c || "any" in c) && ("all" in c ? c.all : c.any).every((n) => isLeaf(n))) {
      match = "all" in c ? "all" : "any";
      for (const leaf of ("all" in c ? c.all : c.any) as ConditionLeaf[]) {
        rows.push({ id: localId("cond"), field: leaf.field, op: leaf.op, value: valueToString(leaf.value) });
      }
    } else advanced = true;
  }
  return {
    ...base,
    name: source.name,
    description: source.description ?? "",
    projectId: source.projectId ?? scope.projectId ?? "",
    triggerKind: source.trigger.kind,
    objectType: source.trigger.objectType,
    action: source.trigger.action ?? "*",
    everyMinutes: String(source.trigger.everyMinutes ?? 60),
    cooldownHours: String(source.trigger.cooldownHours ?? 24),
    match,
    conditions: rows,
    advanced,
    advancedJson: advanced ? JSON.stringify(c, null, 2) : "",
    actions: source.actions.map((a) => ({ id: localId("act"), type: a.type, params: { ...a.params } })),
    immediate: source.immediate,
    priority: String(source.priority ?? 100),
  };
}

/** Coerce a row's text value into what the operator and field type expect. */
function coerceValue(row: CondRow, field: CatalogueField | undefined): unknown {
  if (VALUELESS_OPERATORS.has(row.op)) return undefined;
  const raw = row.value.trim();
  if (LIST_OPERATORS.has(row.op)) return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (DAY_OPERATORS.has(row.op) || NUMERIC_OPERATORS.has(row.op) || field?.type === "number") {
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) ? n : raw;
  }
  if (field?.type === "boolean" && (raw === "true" || raw === "false")) return raw === "true";
  return raw;
}

function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/* =============================== Builder ================================= */

export default function RuleBuilder({
  open,
  rule,
  template,
  scope,
  isAdmin,
  catalogue,
  catalogueError,
  onRetryCatalogue,
  onClose,
  onSaved,
}: {
  open: boolean;
  rule: RuleView | null;
  template: TemplateView | null;
  scope: Scope;
  isAdmin: boolean;
  catalogue: Catalogue | null;
  catalogueError: string | null;
  onRetryCatalogue: () => void;
  onClose: () => void;
  onSaved: (rule: RuleView) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(scope));
  const [projects, setProjects] = useState<ProjectPick[] | null>(null);
  const [saving, setSaving] = useState<"draft" | "active" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testObjectId, setTestObjectId] = useState("");
  const [testSample, setTestSample] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<DryRunResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    setTestResult(null);
    setTestError(null);
    setTestObjectId("");
    setTestSample("");
    if (rule) setDraft(draftFromSource(rule, scope));
    else if (template) setDraft(draftFromSource({ ...template, projectId: scope.projectId }, scope));
    else setDraft(emptyDraft(scope));
  }, [open, rule, template, scope]);

  useEffect(() => {
    if (!open || scope.isProject || projects !== null) return;
    api
      .get<unknown>("/api/v1/projects?page=1&pageSize=200")
      .then((res) => setProjects(asList<ProjectPick>(res).items))
      .catch(() => setProjects([]));
  }, [open, scope.isProject, projects]);

  const entry: CatalogueObjectType | undefined = catalogue?.objectTypes.find((o) => o.objectType === draft.objectType);

  const fieldOptions = useMemo<CatalogueField[]>(() => {
    const record = (entry?.fields ?? []).map((f) => ({ ...f, path: `record.${f.path}`, label: `record · ${f.label}` }));
    const derived = (catalogue?.derivedFields ?? [])
      .filter((d) => d.appliesTo.includes(draft.objectType) || draft.objectType === "*")
      .map<CatalogueField>((d) => ({ path: d.path, type: d.type === "boolean" ? "boolean" : "text", label: `derived · ${d.label}` }));
    const event = draft.triggerKind === "event" ? EVENT_FIELDS.map((f) => ({ ...f, label: `event · ${f.label}` })) : [];
    return [...record, ...derived, ...event];
  }, [entry, catalogue, draft.objectType, draft.triggerKind]);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  function buildPayload(): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
    if (!draft.name.trim()) return { ok: false, error: "Give the rule a name." };
    if (!draft.objectType.trim()) return { ok: false, error: "Choose a record type." };
    const trigger: Record<string, unknown> =
      draft.triggerKind === "event"
        ? { kind: "event", objectType: draft.objectType.trim(), action: draft.action || "*" }
        : { kind: "schedule", objectType: draft.objectType.trim(), everyMinutes: Number(draft.everyMinutes) || 60, cooldownHours: Number(draft.cooldownHours) || 24 };
    let conditions: unknown = null;
    if (draft.advanced) {
      if (draft.advancedJson.trim()) {
        try {
          conditions = JSON.parse(draft.advancedJson) as unknown;
        } catch (err) {
          return { ok: false, error: `Advanced conditions are not valid JSON: ${errorMessage(err, "parse error")}` };
        }
      }
    } else if (draft.conditions.length > 0) {
      const leaves = draft.conditions.map((row) => {
        const field = fieldOptions.find((f) => f.path === row.field);
        const value = coerceValue(row, field);
        return value === undefined ? { field: row.field, op: row.op } : { field: row.field, op: row.op, value };
      });
      for (const l of leaves) if (!l.field.trim()) return { ok: false, error: "Every condition needs a field." };
      conditions = draft.match === "all" ? { all: leaves } : { any: leaves };
    }
    if (draft.actions.length === 0) return { ok: false, error: "Add at least one action." };
    const actions = draft.actions.map((a) => ({ type: a.type, params: cleanParams(a.params) }));
    const body: Record<string, unknown> = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      trigger,
      conditions,
      actions,
      immediate: draft.immediate,
      priority: Number(draft.priority) || 100,
    };
    if (!scope.isProject) body["projectId"] = draft.projectId || null;
    return { ok: true, body };
  }

  async function save(status: "draft" | "active") {
    const built = buildPayload();
    if (!built.ok) {
      setSaveError(built.error);
      return;
    }
    setSaving(status);
    setSaveError(null);
    try {
      let saved: RuleView;
      if (rule) {
        const { projectId: _ignored, ...patch } = built.body;
        saved = await api.patch<RuleView>(`${scope.base}/rules/${rule.id}`, patch);
        if (status === "active" && saved.status !== "active") {
          saved = await api.post<RuleView>(`${scope.base}/rules/${rule.id}/activate`);
        }
        toast.success("Rule saved", { description: saved.name });
      } else {
        saved = await api.post<RuleView>(`${scope.base}/rules`, { ...built.body, status });
        toast.success(status === "active" ? "Rule created and activated" : "Rule saved as a draft", { description: saved.name });
      }
      onSaved(saved);
    } catch (err) {
      setSaveError(errorMessage(err, "Failed to save the rule"));
    } finally {
      setSaving(null);
    }
  }

  /** Company admins test the draft as edited; a project tester can only test the saved rule through the project route. */
  const canTestDraft = isAdmin;
  const canTestSaved = scope.isProject && rule !== null;

  async function runTest() {
    const built = buildPayload();
    if (!built.ok) {
      setTestError(built.error);
      return;
    }
    let record: Record<string, unknown> | undefined;
    if (testSample.trim()) {
      try {
        const parsed = JSON.parse(testSample) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Sample must be a JSON object");
        record = parsed as Record<string, unknown>;
      } catch (err) {
        setTestError(errorMessage(err, "Sample is not valid JSON"));
        return;
      }
    }
    const input = { ...(testObjectId.trim() ? { objectId: testObjectId.trim() } : {}), ...(record ? { record } : {}) };
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = canTestDraft
        ? await api.post<DryRunResult>("/api/v1/automation/rules/test", { rule: built.body, ...input })
        : await api.post<DryRunResult>(`${scope.base}/rules/${rule!.id}/test`, input);
      setTestResult(res);
    } catch (err) {
      setTestError(errorMessage(err, "Dry run failed"));
    } finally {
      setTesting(false);
    }
  }

  const objectTypes = catalogue?.objectTypes ?? [];
  const isKnownType = draft.objectType === "*" || objectTypes.some((o) => o.objectType === draft.objectType);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="xl"
      title={rule ? `Edit rule: ${rule.name}` : template ? `New rule from template: ${template.name}` : "New automation rule"}
      description={scope.isProject ? "This rule will belong to the current project." : undefined}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div className="text-2xs text-content-subtle">
            {saveError ? <span className="text-danger-fg">{saveError}</span> : rule ? `Status: ${humanize(rule.status)} — use the rule's controls to change it.` : "Rules start as drafts unless activated here."}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" loading={saving === "draft"} onClick={() => void save("draft")}>
              {rule ? "Save" : "Save as draft"}
            </Button>
            {!rule || rule.status !== "active" ? (
              <Button loading={saving === "active"} onClick={() => void save("active")} disabled={rule?.status === "archived"}>
                {rule ? "Save and activate" : "Create and activate"}
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      {catalogueError ? <ErrorAlert message={`The builder catalogue could not be loaded: ${catalogueError}. Field and type pickers are reduced to free text.`} onRetry={onRetryCatalogue} /> : null}

      <div className="space-y-6">
        {/* ------------------------------ Identity ------------------------------ */}
        <section className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="RFI overdue 3 days → escalate to PM" />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} placeholder="What this rule is for, and what it deliberately does not do." />
          </Field>
          {!scope.isProject ? (
            <Field label="Scope" hint={rule ? "Scope cannot change after creation." : "Company-wide rules fire for every project and for company-level records."}>
              <Select value={draft.projectId} onChange={(e) => update({ projectId: e.target.value })} disabled={rule !== null}>
                <option value="">Company-wide</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number ? `${p.number} — ` : ""}
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Priority" hint="Lower runs first when several rules match one event (0–1000).">
            <Input type="number" min={0} max={1000} value={draft.priority} onChange={(e) => update({ priority: e.target.value })} />
          </Field>
        </section>

        {/* ------------------------------- Trigger ------------------------------ */}
        <section className="space-y-3">
          <SectionTitle n={1} title="Trigger" hint="What makes the rule evaluate." />
          <SegmentedControl<"event" | "schedule">
            value={draft.triggerKind}
            onChange={(v) => update({ triggerKind: v, objectType: v === "schedule" && draft.objectType === "*" ? "rfi" : draft.objectType })}
            options={[
              { value: "event", label: "Ledger event" },
              { value: "schedule", label: "Schedule scan" },
            ]}
            aria-label="Trigger kind"
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Record type" required hint={draft.triggerKind === "schedule" ? "Scans need a type the platform can load." : "Any snake_case ledger object type; unknown types get event-only context."}>
              {objectTypes.length > 0 ? (
                <Select
                  value={isKnownType ? draft.objectType : "__custom"}
                  onChange={(e) => update({ objectType: e.target.value === "__custom" ? "" : e.target.value })}
                >
                  {draft.triggerKind === "event" ? <option value="*">Any record type</option> : null}
                  {objectTypes.map((o) => (
                    <option key={o.objectType} value={o.objectType}>
                      {o.label} ({o.objectType})
                    </option>
                  ))}
                  {draft.triggerKind === "event" ? <option value="__custom">Other type…</option> : null}
                </Select>
              ) : (
                <Input value={draft.objectType} onChange={(e) => update({ objectType: e.target.value })} placeholder="rfi" className="font-mono" />
              )}
            </Field>
            {objectTypes.length > 0 && !isKnownType ? (
              <Field label="Custom type" hint="snake_case, as it appears in the ledger">
                <Input value={draft.objectType} onChange={(e) => update({ objectType: e.target.value })} placeholder="my_record" className="font-mono" />
              </Field>
            ) : null}
            {draft.triggerKind === "event" ? (
              <Field label="Ledger action">
                <Select value={draft.action} onChange={(e) => update({ action: e.target.value })}>
                  <option value="*">Any action</option>
                  {(catalogue?.ledgerActions ?? ["create", "update", "delete", "state_change", "access"])
                    .filter((a) => a !== "*")
                    .map((a) => (
                      <option key={a} value={a}>
                        {humanize(a)}
                      </option>
                    ))}
                </Select>
              </Field>
            ) : (
              <>
                <Field label="Scan every (minutes)" hint="5 – 10080">
                  <Input type="number" min={5} max={10080} value={draft.everyMinutes} onChange={(e) => update({ everyMinutes: e.target.value })} />
                </Field>
                <Field label="Cooldown per record (hours)" hint="Do not fire twice for the same record inside this window.">
                  <Input type="number" min={1} max={720} value={draft.cooldownHours} onChange={(e) => update({ cooldownHours: e.target.value })} />
                </Field>
              </>
            )}
          </div>
          {draft.triggerKind === "event" ? (
            <Switch
              checked={draft.immediate}
              onCheckedChange={(v) => update({ immediate: v })}
              label="Execute immediately on the ledger hook"
              description="Off: the run is queued and executed by the drain job within a minute. Immediate rules run synchronously, bounded and guarded — they can never fail the write that fired them."
            />
          ) : null}
          {entry?.openStatuses && draft.triggerKind === "schedule" ? (
            <p className="text-2xs text-content-subtle">
              Scans consider records in {entry.openStatuses.join(", ")} (newest 500), so add a status condition only to narrow further.
            </p>
          ) : null}
        </section>

        {/* ----------------------------- Conditions ----------------------------- */}
        <section className="space-y-3">
          <SectionTitle n={2} title="Conditions" hint="Predicates over the record snapshot, the event and derived facts. No expressions, no code." />
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl<"all" | "any">
              value={draft.match}
              onChange={(v) => update({ match: v })}
              options={[
                { value: "all", label: "Match ALL" },
                { value: "any", label: "Match ANY" },
              ]}
              size="xs"
              aria-label="Condition join"
            />
            <Checkbox size="sm" checked={draft.advanced} onChange={(e) => update({ advanced: e.target.checked, advancedJson: e.target.checked && !draft.advancedJson ? JSON.stringify(previewConditions(draft, fieldOptions), null, 2) : draft.advancedJson })} label="Advanced (nested JSON)" />
          </div>
          {draft.advanced ? (
            <Field label="Condition tree" hint='Leaves are {"field","op","value"}; groups are {"all":[…]}, {"any":[…]}, {"not":…}. Empty = no conditions.'>
              <Textarea rows={8} value={draft.advancedJson} onChange={(e) => update({ advancedJson: e.target.value })} className="font-mono text-xs" />
            </Field>
          ) : (
            <div className="space-y-2">
              {draft.conditions.length === 0 ? (
                <p className="text-xs text-content-subtle">No conditions — every matching trigger fires.</p>
              ) : null}
              {draft.conditions.map((row) => (
                <ConditionRowEditor
                  key={row.id}
                  row={row}
                  fields={fieldOptions}
                  operators={catalogue?.operators ?? FALLBACK_OPERATORS}
                  onChange={(next) => update({ conditions: draft.conditions.map((r) => (r.id === row.id ? next : r)) })}
                  onRemove={() => update({ conditions: draft.conditions.filter((r) => r.id !== row.id) })}
                />
              ))}
              <Button
                size="xs"
                variant="secondary"
                leadingIcon={IconPlus}
                onClick={() =>
                  update({
                    conditions: [...draft.conditions, { id: localId("cond"), field: fieldOptions[0]?.path ?? "record.status", op: "eq", value: "" }],
                  })
                }
              >
                Add condition
              </Button>
            </div>
          )}
        </section>

        {/* ------------------------------- Actions ------------------------------ */}
        <section className="space-y-3">
          <SectionTitle n={3} title="Actions" hint="Executed in order. A failing action is recorded and the next still runs; the run is then marked failed." />
          {draft.actions.map((a, i) => (
            <ActionRowEditor
              key={a.id}
              index={i}
              total={draft.actions.length}
              row={a}
              catalogue={catalogue}
              entry={entry}
              onChange={(next) => update({ actions: draft.actions.map((r) => (r.id === a.id ? next : r)) })}
              onRemove={() => update({ actions: draft.actions.filter((r) => r.id !== a.id) })}
              onMove={(dir) => {
                const list = [...draft.actions];
                const j = i + dir;
                if (j < 0 || j >= list.length) return;
                const cur = list[i]!;
                list[i] = list[j]!;
                list[j] = cur;
                update({ actions: list });
              }}
            />
          ))}
          <Button
            size="xs"
            variant="secondary"
            leadingIcon={IconPlus}
            disabled={draft.actions.length >= (catalogue?.limits.maxActionsPerRule ?? 10)}
            onClick={() => update({ actions: [...draft.actions, { id: localId("act"), type: "notify", params: { to: [{ kind: "roles", roles: ["owner", "admin"] }] } }] })}
          >
            Add action
          </Button>
        </section>

        {/* ------------------------------- Dry run ------------------------------ */}
        <section className="space-y-3">
          <SectionTitle n={4} title="Dry run" hint="Evaluate the conditions as edited against a real record or a sample. Nothing executes." />
          {!canTestDraft && !canTestSaved ? (
            <Alert tone="info" size="sm">
              Save the rule first: at project scope a dry run tests the saved rule through the project route.
            </Alert>
          ) : null}
          {!canTestDraft && canTestSaved ? (
            <Alert tone="info" size="sm">
              This dry run evaluates the rule as last saved, not the unsaved edits above.
            </Alert>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Record id" hint={`A ${draft.objectType || "record"} id in this company${scope.isProject ? " and project" : ""}`}>
              <Input size="sm" value={testObjectId} onChange={(e) => setTestObjectId(e.target.value)} className="font-mono" />
            </Field>
            <Field label="Sample record (JSON)" hint="Used when no record id is given">
              <Textarea rows={3} value={testSample} onChange={(e) => setTestSample(e.target.value)} className="font-mono text-xs" placeholder='{"status":"open","dueDate":"2026-01-01"}' />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" leadingIcon={IconPlay} loading={testing} disabled={!canTestDraft && !canTestSaved} onClick={() => void runTest()}>
              Run dry run
            </Button>
            {testError ? <span className="text-xs text-danger-fg">{testError}</span> : null}
          </div>
          {testResult ? <DryRunPanel result={testResult} /> : null}
        </section>
      </div>
    </Drawer>
  );
}

function previewConditions(draft: Draft, fields: CatalogueField[]): unknown {
  if (draft.conditions.length === 0) return null;
  const leaves = draft.conditions.map((row) => {
    const value = coerceValue(row, fields.find((f) => f.path === row.field));
    return value === undefined ? { field: row.field, op: row.op } : { field: row.field, op: row.op, value };
  });
  return draft.match === "all" ? { all: leaves } : { any: leaves };
}

function SectionTitle({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className="flex items-start gap-2">
      <Badge tone="accent" size="sm">
        {n}
      </Badge>
      <div>
        <div className="text-sm font-semibold text-content">{title}</div>
        <div className="text-2xs text-content-subtle">{hint}</div>
      </div>
    </div>
  );
}

/* ============================ Condition row ============================== */

function ConditionRowEditor({
  row,
  fields,
  operators,
  onChange,
  onRemove,
}: {
  row: CondRow;
  fields: CatalogueField[];
  operators: readonly string[];
  onChange: (row: CondRow) => void;
  onRemove: () => void;
}) {
  const known = fields.find((f) => f.path === row.field);
  const isKnown = known !== undefined;
  const ops = operators.length > 0 ? operators : FALLBACK_OPERATORS;
  const valueless = VALUELESS_OPERATORS.has(row.op);
  const numeric = DAY_OPERATORS.has(row.op) || NUMERIC_OPERATORS.has(row.op) || known?.type === "number";
  const enumChoice = known?.type === "enum" && known.options && (row.op === "eq" || row.op === "neq");
  return (
    <div className="grid items-end gap-2 rounded-md border border-border-subtle p-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
      <Field label="Field">
        <Select size="sm" value={isKnown ? row.field : "__custom"} onChange={(e) => onChange({ ...row, field: e.target.value === "__custom" ? "" : e.target.value })}>
          {fields.map((f) => (
            <option key={f.path} value={f.path}>
              {f.label} — {f.path}
            </option>
          ))}
          <option value="__custom">Other path…</option>
        </Select>
        {!isKnown ? (
          <Input size="sm" className="mt-1 font-mono" value={row.field} onChange={(e) => onChange({ ...row, field: e.target.value })} placeholder="record.customField" />
        ) : null}
      </Field>
      <Field label="Operator">
        <Select size="sm" value={row.op} onChange={(e) => onChange({ ...row, op: e.target.value })}>
          {ops.map((op) => (
            <option key={op} value={op}>
              {operatorLabel(op)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Value" hint={valueless ? "No value needed" : LIST_OPERATORS.has(row.op) ? "Comma-separated" : DAY_OPERATORS.has(row.op) ? "Days" : undefined}>
        {valueless ? (
          <Input size="sm" value="" disabled placeholder="—" />
        ) : enumChoice ? (
          <Select size="sm" value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} placeholder="Choose…">
            {known!.options!.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        ) : (
          <Input size="sm" type={numeric ? "number" : "text"} value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} />
        )}
      </Field>
      <Button size="sm" variant="ghost" iconOnly aria-label="Remove condition" icon={IconTrash} onClick={onRemove} />
    </div>
  );
}

/* ============================== Action row =============================== */

function ActionRowEditor({
  index,
  total,
  row,
  catalogue,
  entry,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  row: ActionRow;
  catalogue: Catalogue | null;
  entry: CatalogueObjectType | undefined;
  onChange: (row: ActionRow) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const types = catalogue?.actions ?? [];
  const hint = types.find((t) => t.type === row.type)?.description;
  const setParam = (key: string, value: unknown) => onChange({ ...row, params: { ...row.params, [key]: value } });
  return (
    <div className="space-y-3 rounded-md border border-border-subtle p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Badge tone="neutral" size="sm">
          {index + 1}
        </Badge>
        <Field label="Action" className="min-w-56">
          <Select
            size="sm"
            value={row.type}
            onChange={(e) => onChange({ id: row.id, type: e.target.value, params: defaultParams(e.target.value) })}
          >
            {(types.length > 0 ? types.map((t) => t.type) : Object.keys(defaultParamsByType)).map((t) => (
              <option key={t} value={t}>
                {actionLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="ml-auto flex gap-1">
          <Button size="xs" variant="ghost" iconOnly aria-label="Move up" icon={IconArrowUp} disabled={index === 0} onClick={() => onMove(-1)} />
          <Button size="xs" variant="ghost" iconOnly aria-label="Move down" icon={IconArrowDown} disabled={index === total - 1} onClick={() => onMove(1)} />
          <Button size="xs" variant="ghost" iconOnly aria-label="Remove action" icon={IconTrash} onClick={onRemove} disabled={total <= 1} />
        </div>
      </div>
      {hint ? <p className="text-2xs text-content-subtle">{hint}</p> : null}
      <ActionParams type={row.type} params={row.params} setParam={setParam} catalogue={catalogue} entry={entry} />
    </div>
  );
}

const defaultParamsByType: Record<string, Record<string, unknown>> = {
  notify: { to: [{ kind: "roles", roles: ["owner", "admin"] }], kind: "automation" },
  escalate: {},
  create_obligation: { dueInDays: 7 },
  create_signal: { detector: "rule", severity: "medium", confidence: 0.7 },
  webhook: { url: "", includeRecord: true },
  run_agent: { agentKind: "" },
  assign: { notify: true },
  tag: { name: "" },
  create_task: { dueInDays: 3, priority: "medium" },
};

function defaultParams(type: string): Record<string, unknown> {
  return { ...(defaultParamsByType[type] ?? {}) };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function ActionParams({
  type,
  params,
  setParam,
  catalogue,
  entry,
}: {
  type: string;
  params: Record<string, unknown>;
  setParam: (key: string, value: unknown) => void;
  catalogue: Catalogue | null;
  entry: CatalogueObjectType | undefined;
}) {
  const users = userFields(entry);
  const dates = dateFields(entry);
  const numberParam = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => setParam(key, e.target.value === "" ? undefined : Number(e.target.value));
  switch (type) {
    case "notify":
      return (
        <div className="space-y-3">
          <TargetsEditor value={params["to"]} onChange={(to) => setParam("to", to)} users={users} required />
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Kind">
              <Select size="sm" value={str(params["kind"]) || "automation"} onChange={(e) => setParam("kind", e.target.value)}>
                {(catalogue?.notificationKinds ?? ["automation"]).map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Title" hint="{{record.field}} placeholders render from the snapshot" className="sm:col-span-2">
              <Input size="sm" value={str(params["title"])} onChange={(e) => setParam("title", e.target.value)} placeholder="RFI {{record.number}} is overdue" />
            </Field>
            <Field label="Body" className="sm:col-span-3">
              <Textarea rows={2} value={str(params["body"])} onChange={(e) => setParam("body", e.target.value)} />
            </Field>
          </div>
        </div>
      );
    case "escalate":
      return (
        <div className="space-y-3">
          <TargetsEditor value={params["to"]} onChange={(to) => setParam("to", to)} users={users} hint="Leave empty to escalate to company owners and admins." />
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Title">
              <Input size="sm" value={str(params["title"])} onChange={(e) => setParam("title", e.target.value)} />
            </Field>
            <Field label="Body">
              <Input size="sm" value={str(params["body"])} onChange={(e) => setParam("body", e.target.value)} />
            </Field>
            <Switch size="sm" checked={params["raiseSignal"] === true} onCheckedChange={(v) => setParam("raiseSignal", v)} label="Also raise an assurance signal" />
            <Field label="Signal severity">
              <Select size="sm" value={str(params["severity"]) || "medium"} onChange={(e) => setParam("severity", e.target.value)} disabled={params["raiseSignal"] !== true}>
                {(catalogue?.signalSeverities ?? ["info", "low", "medium", "high", "critical"]).map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reassign to (user id)" hint="Must be a company member; written to the record's assignable field." className="sm:col-span-2">
              <Input size="sm" value={str(params["reassignTo"])} onChange={(e) => setParam("reassignTo", e.target.value)} className="font-mono" />
            </Field>
          </div>
        </div>
      );
    case "create_obligation": {
      const mode: "field" | "days" | "date" = params["deadlineField"] !== undefined ? "field" : params["deadline"] !== undefined ? "date" : "days";
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Obligation (trigger text)" required className="sm:col-span-2">
            <Input size="sm" value={str(params["trigger"])} onChange={(e) => setParam("trigger", e.target.value)} placeholder="Serve notice for contract event {{record.number}}" />
          </Field>
          <Field label="Source clause">
            <Input size="sm" value={str(params["sourceClause"])} onChange={(e) => setParam("sourceClause", e.target.value)} placeholder="{{record.clauseRef}}" />
          </Field>
          <Field label="Evidence requirement">
            <Input size="sm" value={str(params["evidenceRequirement"])} onChange={(e) => setParam("evidenceRequirement", e.target.value)} />
          </Field>
          <Field label="Deadline from" className="sm:col-span-2">
            <SegmentedControl<"field" | "days" | "date">
              size="xs"
              value={mode}
              onChange={(v) => {
                const next: Record<string, unknown> = { ...params };
                delete next["deadlineField"];
                delete next["deadline"];
                delete next["dueInDays"];
                if (v === "field") next["deadlineField"] = dates[0]?.path ?? "dueDate";
                else if (v === "date") next["deadline"] = "";
                else next["dueInDays"] = 7;
                for (const k of ["deadlineField", "deadline", "dueInDays"]) setParam(k, next[k]);
              }}
              options={[
                { value: "field", label: "A record field" },
                { value: "days", label: "N days from now" },
                { value: "date", label: "A fixed date" },
              ]}
              aria-label="Deadline source"
            />
          </Field>
          {mode === "field" ? (
            <Field label="Date field on the record">
              {dates.length > 0 ? (
                <Select size="sm" value={str(params["deadlineField"])} onChange={(e) => setParam("deadlineField", e.target.value)}>
                  {dates.map((d) => (
                    <option key={d.path} value={d.path}>
                      {d.label} ({d.path})
                    </option>
                  ))}
                </Select>
              ) : (
                <Input size="sm" value={str(params["deadlineField"])} onChange={(e) => setParam("deadlineField", e.target.value)} className="font-mono" placeholder="dueDate" />
              )}
            </Field>
          ) : mode === "date" ? (
            <Field label="Deadline (YYYY-MM-DD)">
              <Input size="sm" value={str(params["deadline"])} onChange={(e) => setParam("deadline", e.target.value)} placeholder="2026-12-31" />
            </Field>
          ) : (
            <Field label="Due in (days)">
              <Input size="sm" type="number" min={0} value={str(params["dueInDays"])} onChange={numberParam("dueInDays")} />
            </Field>
          )}
          <Field label="Warn (days before)">
            <Input size="sm" type="number" min={0} value={str(params["warnDaysBefore"])} onChange={numberParam("warnDaysBefore")} />
          </Field>
        </div>
      );
    }
    case "create_signal":
      return (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Detector" hint="Prefixed automation. on write" required>
            <Input size="sm" value={str(params["detector"])} onChange={(e) => setParam("detector", e.target.value)} className="font-mono" placeholder="invoice_without_insurance" />
          </Field>
          <Field label="Severity">
            <Select size="sm" value={str(params["severity"]) || "medium"} onChange={(e) => setParam("severity", e.target.value)}>
              {(catalogue?.signalSeverities ?? ["info", "low", "medium", "high", "critical"]).map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Confidence (0–1)">
            <Input size="sm" type="number" min={0} max={1} step={0.05} value={str(params["confidence"])} onChange={numberParam("confidence")} />
          </Field>
          <Field label="Title" className="sm:col-span-3">
            <Input size="sm" value={str(params["title"])} onChange={(e) => setParam("title", e.target.value)} />
          </Field>
          <Field label="Explanation" className="sm:col-span-3">
            <Textarea rows={2} value={str(params["explanation"])} onChange={(e) => setParam("explanation", e.target.value)} />
          </Field>
        </div>
      );
    case "webhook":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="URL" required hint="Public http(s) host only — localhost and private ranges are refused at run time." className="sm:col-span-2">
            <Input size="sm" value={str(params["url"])} onChange={(e) => setParam("url", e.target.value)} className="font-mono" placeholder="https://receiver.example/hooks/constructos" />
          </Field>
          <Field label="Signing secret" hint="Optional per-endpoint HMAC secret (min 8 chars); otherwise the platform key signs.">
            <Input size="sm" type="password" value={str(params["secret"])} onChange={(e) => setParam("secret", e.target.value || undefined)} />
          </Field>
          <Switch size="sm" checked={params["includeRecord"] !== false} onCheckedChange={(v) => setParam("includeRecord", v)} label="Include the record snapshot in the envelope" description="Off: identifiers, hashes and the event only." />
          <Alert tone="warning" size="sm" className="sm:col-span-2">
            This configures egress: the envelope leaves the tenant boundary to the URL you nominate. Verify the x-constructos-signature header at the receiver.
          </Alert>
        </div>
      );
    case "run_agent":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Agent kind" required hint="snake_case; a human approves the request in the AI review queue before anything runs.">
            <Input size="sm" value={str(params["agentKind"])} onChange={(e) => setParam("agentKind", e.target.value)} className="font-mono" placeholder="time_bar_notice_drafter" />
          </Field>
          <Field label="Summary for the reviewer">
            <Input size="sm" value={str(params["summary"])} onChange={(e) => setParam("summary", e.target.value)} placeholder="Draft notice for {{record.title}}" />
          </Field>
        </div>
      );
    case "assign": {
      const byField = params["userId"] === undefined;
      return (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Assign">
            <SegmentedControl<"field" | "user">
              size="xs"
              value={byField ? "field" : "user"}
              onChange={(v) => {
                if (v === "field") {
                  setParam("userId", undefined);
                  setParam("userField", users[0]?.path ?? "createdBy");
                } else {
                  setParam("userField", undefined);
                  setParam("userId", "");
                }
              }}
              options={[
                { value: "field", label: "User named on the record" },
                { value: "user", label: "A specific user" },
              ]}
              aria-label="Assignee source"
            />
          </Field>
          {byField ? (
            <Field label="Record field">
              {users.length > 0 ? (
                <Select size="sm" value={str(params["userField"])} onChange={(e) => setParam("userField", e.target.value)}>
                  {users.map((u) => (
                    <option key={u.path} value={u.path}>
                      {u.label} ({u.path})
                    </option>
                  ))}
                </Select>
              ) : (
                <Input size="sm" value={str(params["userField"])} onChange={(e) => setParam("userField", e.target.value)} className="font-mono" placeholder="createdBy" />
              )}
            </Field>
          ) : (
            <Field label="User id">
              <Input size="sm" value={str(params["userId"])} onChange={(e) => setParam("userId", e.target.value)} className="font-mono" />
            </Field>
          )}
          <Switch size="sm" checked={params["notify"] !== false} onCheckedChange={(v) => setParam("notify", v)} label="Notify the assignee" />
          {entry && !entry.assignField ? (
            <Alert tone="warning" size="sm" className="sm:col-span-3">
              {entry.label} has no assignable field; this action will be skipped.
            </Alert>
          ) : null}
        </div>
      );
    }
    case "tag":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Tag name" required>
            <Input size="sm" value={str(params["name"])} onChange={(e) => setParam("name", e.target.value)} placeholder="insurance-hold" />
          </Field>
          <Field label="Colour (optional)">
            <Input size="sm" value={str(params["color"])} onChange={(e) => setParam("color", e.target.value || undefined)} placeholder="amber" />
          </Field>
        </div>
      );
    case "create_task": {
      const byField = params["ownerId"] === undefined;
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Title" className="sm:col-span-2">
            <Input size="sm" value={str(params["title"])} onChange={(e) => setParam("title", e.target.value)} placeholder="Follow up {{record.reference}}" />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea rows={2} value={str(params["description"])} onChange={(e) => setParam("description", e.target.value)} />
          </Field>
          <Field label="Owner">
            <SegmentedControl<"field" | "user">
              size="xs"
              value={byField ? "field" : "user"}
              onChange={(v) => {
                if (v === "field") {
                  setParam("ownerId", undefined);
                  setParam("ownerField", users[0]?.path ?? "createdBy");
                } else {
                  setParam("ownerField", undefined);
                  setParam("ownerId", "");
                }
              }}
              options={[
                { value: "field", label: "From the record" },
                { value: "user", label: "A specific user" },
              ]}
              aria-label="Owner source"
            />
          </Field>
          {byField ? (
            <Field label="Record field">
              {users.length > 0 ? (
                <Select size="sm" value={str(params["ownerField"])} onChange={(e) => setParam("ownerField", e.target.value)}>
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.path} value={u.path}>
                      {u.label} ({u.path})
                    </option>
                  ))}
                </Select>
              ) : (
                <Input size="sm" value={str(params["ownerField"])} onChange={(e) => setParam("ownerField", e.target.value || undefined)} className="font-mono" />
              )}
            </Field>
          ) : (
            <Field label="User id">
              <Input size="sm" value={str(params["ownerId"])} onChange={(e) => setParam("ownerId", e.target.value)} className="font-mono" />
            </Field>
          )}
          <Field label="Due in (days)">
            <Input size="sm" type="number" min={0} value={str(params["dueInDays"])} onChange={numberParam("dueInDays")} />
          </Field>
          <Field label="Priority">
            <Select size="sm" value={str(params["priority"]) || "medium"} onChange={(e) => setParam("priority", e.target.value)}>
              {["low", "medium", "high", "critical"].map((p) => (
                <option key={p} value={p}>
                  {humanize(p)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      );
    }
    default:
      return <p className="text-xs text-content-subtle">No parameters.</p>;
  }
}

/* ============================ Targets editor ============================= */

function TargetsEditor({
  value,
  onChange,
  users,
  required,
  hint,
}: {
  value: unknown;
  onChange: (targets: NotifyTargetJson[] | undefined) => void;
  users: CatalogueField[];
  required?: boolean;
  hint?: string;
}) {
  const targets: NotifyTargetJson[] = Array.isArray(value) ? (value as NotifyTargetJson[]) : [];
  const roles = new Set(targets.filter((t) => t.kind === "roles").flatMap((t) => t.roles ?? []));
  const fields = new Set(targets.filter((t) => t.kind === "record_field").map((t) => t.field ?? ""));
  const projectMembers = targets.some((t) => t.kind === "project_members");
  const userIds = targets.filter((t) => t.kind === "users").flatMap((t) => t.userIds ?? []);
  const groupIds = targets.filter((t) => t.kind === "distribution_groups").flatMap((t) => t.groupIds ?? []);

  function emit(next: { roles: Set<string>; fields: Set<string>; projectMembers: boolean; userIds: string[]; groupIds: string[] }) {
    const out: NotifyTargetJson[] = [];
    if (next.roles.size > 0) out.push({ kind: "roles", roles: [...next.roles] });
    for (const f of next.fields) if (f) out.push({ kind: "record_field", field: f });
    if (next.projectMembers) out.push({ kind: "project_members" });
    if (next.userIds.length > 0) out.push({ kind: "users", userIds: next.userIds });
    if (next.groupIds.length > 0) out.push({ kind: "distribution_groups", groupIds: next.groupIds });
    onChange(out.length > 0 ? out : undefined);
  }
  const state = { roles, fields, projectMembers, userIds, groupIds };

  return (
    <div className="space-y-2">
      <div className="text-label uppercase text-content-subtle">
        Recipients{required ? " (required)" : ""}
        {hint ? <span className="ml-2 normal-case text-content-subtle">{hint}</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {[...COMPANY_ROLES, ...ASSURANCE_ROLES].map((r) => (
          <Checkbox
            key={r}
            size="sm"
            label={humanize(r)}
            checked={roles.has(r)}
            onChange={(e) => {
              const next = new Set(roles);
              if (e.target.checked) next.add(r);
              else next.delete(r);
              emit({ ...state, roles: next });
            }}
          />
        ))}
        <Checkbox size="sm" label="All project members" checked={projectMembers} onChange={(e) => emit({ ...state, projectMembers: e.target.checked })} />
      </div>
      {users.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {users.map((u) => (
            <Checkbox
              key={u.path}
              size="sm"
              label={`User in ${u.label}`}
              checked={fields.has(u.path)}
              onChange={(e) => {
                const next = new Set(fields);
                if (e.target.checked) next.add(u.path);
                else next.delete(u.path);
                emit({ ...state, fields: next });
              }}
            />
          ))}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Specific user ids" hint="Comma-separated; non-members are dropped at run time.">
          <Input
            size="sm"
            className="font-mono"
            value={userIds.join(", ")}
            onChange={(e) => emit({ ...state, userIds: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
        </Field>
        <Field label="Distribution group ids" hint="Comma-separated.">
          <Input
            size="sm"
            className="font-mono"
            value={groupIds.join(", ")}
            onChange={(e) => emit({ ...state, groupIds: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
        </Field>
      </div>
    </div>
  );
}
