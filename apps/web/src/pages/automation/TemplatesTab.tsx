/**
 * Template gallery: the code-resident rule library grouped by category, and
 * one-call instantiation into the tenant (company-wide or for a project).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, EmptyState, ErrorAlert, Field, Input, Modal, Select, Switch } from "../../ui";
import { IconZap } from "../../ui/icons";
import {
  TEMPLATE_CATEGORY_LABELS,
  actionLabel,
  asList,
  describeAction,
  describeCondition,
  describeTrigger,
  errorMessage,
  type ProjectPick,
  type RuleView,
  type Scope,
  type TemplateView,
} from "./automationShared";

export default function TemplatesTab({
  scope,
  isAdmin,
  onInstantiated,
}: {
  scope: Scope;
  isAdmin: boolean;
  onInstantiated: (rule: RuleView) => void;
}) {
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<TemplateView | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTemplates(asList<TemplateView>(await api.get<unknown>("/api/v1/automation/templates")).items);
    } catch (err) {
      setError(errorMessage(err, "Failed to load templates"));
      setTemplates((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, TemplateView[]>();
    for (const t of templates ?? []) {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    }
    return [...map.entries()];
  }, [templates]);

  const canUse = isAdmin || scope.isProject;

  if (error && (!templates || templates.length === 0)) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (templates && templates.length === 0) return <EmptyState icon={IconZap} title="No templates" hint="The template library is empty in this build." />;

  return (
    <div className="space-y-6">
      {!canUse ? (
        <Alert tone="info" size="sm">
          Instantiating a template creates a company rule, which needs the owner or admin role. You can still read the library.
        </Alert>
      ) : null}
      {grouped.map(([category, items]) => (
        <section key={category}>
          <h3 className="mb-2 text-sm font-semibold text-content">{TEMPLATE_CATEGORY_LABELS[category] ?? category}</h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((t) => (
              <Card key={t.key} className="flex flex-col">
                <CardBody className="flex flex-1 flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-semibold leading-snug text-content">{t.name}</div>
                    <Badge tone={t.trigger.kind === "schedule" ? "accent" : "info"} size="xs">
                      {t.trigger.kind === "schedule" ? "scan" : "event"}
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-content-muted">{t.description}</p>
                  <div className="text-2xs text-content-subtle">{describeTrigger(t.trigger)}</div>
                  <div className="flex flex-wrap gap-1">
                    {t.actions.map((a, i) => (
                      <Badge key={`${a.type}-${i}`} tone="neutral" size="xs">
                        {actionLabel(a.type)}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-2xs text-content-subtle">
                    Spec {t.spec.join(", ")}
                    {t.tunables.length > 0 ? ` · tune: ${t.tunables.join(", ")}` : ""}
                  </div>
                  <div className="mt-auto pt-1">
                    <Button size="sm" variant="secondary" disabled={!canUse} onClick={() => setPicked(t)}>
                      Use template
                    </Button>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      ))}
      {templates === null ? <div className="text-xs text-content-subtle">Loading templates…</div> : null}

      <InstantiateModal template={picked} scope={scope} onClose={() => setPicked(null)} onCreated={(rule) => { setPicked(null); onInstantiated(rule); }} />
    </div>
  );
}

function InstantiateModal({
  template,
  scope,
  onClose,
  onCreated,
}: {
  template: TemplateView | null;
  scope: Scope;
  onClose: () => void;
  onCreated: (rule: RuleView) => void;
}) {
  const [name, setName] = useState("");
  const [activate, setActivate] = useState(false);
  const [immediate, setImmediate] = useState(false);
  const [projectId, setProjectId] = useState<string>("");
  const [projects, setProjects] = useState<ProjectPick[] | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!template) return;
    setName(template.name);
    setActivate(false);
    setImmediate(template.immediate);
    setProjectId("");
    setWebhookUrl("");
    setError(null);
  }, [template]);

  useEffect(() => {
    if (scope.isProject || projects !== null) return;
    api
      .get<unknown>("/api/v1/projects?page=1&pageSize=200")
      .then((res) => setProjects(asList<ProjectPick>(res).items))
      .catch(() => setProjects([]));
  }, [scope.isProject, projects]);

  if (!template) return null;
  const webhookIndex = template.actions.findIndex((a) => a.type === "webhook");

  async function submit() {
    if (!template) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim() || template.name,
        status: activate ? "active" : "draft",
        immediate,
      };
      if (!scope.isProject && projectId) body["projectId"] = projectId;
      if (webhookIndex >= 0 && webhookUrl.trim()) body["actionOverrides"] = { [String(webhookIndex)]: { url: webhookUrl.trim() } };
      const rule = await api.post<RuleView>(`${scope.base}/templates/${template.key}/instantiate`, body);
      toast.success(activate ? "Rule created and activated" : "Rule created as a draft", { description: rule.name });
      onCreated(rule);
    } catch (err) {
      setError(errorMessage(err, "Failed to create the rule"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`Use template: ${template.name}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <p className="text-xs text-content-muted">{template.description}</p>
        <div className="rounded-md bg-surface-sunken p-3 text-xs">
          <div className="font-medium">{describeTrigger(template.trigger)}</div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-2xs text-content-muted">{describeCondition(template.conditions).join("\n")}</pre>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-content-muted">
            {template.actions.map((a, i) => (
              <li key={i}>{describeAction(a)}</li>
            ))}
          </ol>
        </div>
        <Field label="Rule name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!scope.isProject ? (
          <Field label="Scope" hint="Company-wide rules fire for every project; a project rule only for that project.">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Company-wide</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number ? `${p.number} — ` : ""}
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Alert tone="info" size="sm">
            The rule will belong to this project.
          </Alert>
        )}
        {webhookIndex >= 0 ? (
          <Field label="Webhook URL" hint="Replace the placeholder endpoint. Must be a public http(s) host — internal addresses are refused at run time." required>
            <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://…" className="font-mono" />
          </Field>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <Switch checked={activate} onCheckedChange={setActivate} label="Activate immediately" description="Otherwise the rule is saved as a draft you can tune first." />
          <Switch
            checked={immediate}
            onCheckedChange={setImmediate}
            label="Execute on the ledger hook"
            description={template.trigger.kind === "schedule" ? "Ignored for schedule scans." : "Off: queued for the drain job (within a minute)."}
            disabled={template.trigger.kind === "schedule"}
          />
        </div>
        {error ? <ErrorAlert message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Create rule
          </Button>
        </div>
      </div>
    </Modal>
  );
}
