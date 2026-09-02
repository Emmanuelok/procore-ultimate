/**
 * CONFIGURATION — the tier (#563) and the markup schedule (#554).
 *
 * The tier decides which documents must exist before a change can be
 * packaged; the markup schedule decides what OH&P a change order request
 * carries when it is raised. Both used to be settings nothing wrote, so every
 * COR raised from the web carried zero markup. Now they are records with an
 * author and a ledger entry, and the schedule can be BANDED by cost subtotal.
 */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorAlert,
  Field,
  Input,
  Select,
} from "../../ui";
import { toast } from "../../ui/overlays";
import { errorMessage, useResource, type ChangeContext } from "./changesShared";

interface MarkupRule {
  kind: string;
  label: string;
  basis: string;
  rate: number;
  costTypes?: string[] | null;
  maxAmount?: number | null;
  sequence?: number | null;
}

interface Band {
  upTo: number | null;
  rules: MarkupRule[];
}

interface Schedule {
  id: string;
  name: string;
  primeContractId: string | null;
  rules: MarkupRule[];
  bands: Band[];
  updatedBy: string | null;
  updatedAt: string;
}

interface MarkupsResponse {
  projectId: string;
  project: Schedule | null;
  contracts: Schedule[];
  legacyRules: MarkupRule[];
  note: string | null;
}

interface ConfigResponse {
  projectId: string;
  tier: string;
  requireQuoteForSubcontract: boolean;
  stages: string[];
  source: string;
  tiers: Array<{ tier: string; label: string; stages: string[]; description: string }>;
}

const KINDS = ["percent", "fixed"] as const;
const BASES = ["cost", "running_total", "subtotal"] as const;

const emptyRule = (): MarkupRule => ({ kind: "percent", label: "Overhead", basis: "cost", rate: 10 });

function RuleEditor({
  rules,
  onChange,
}: {
  rules: MarkupRule[];
  onChange: (next: MarkupRule[]) => void;
}) {
  const update = (i: number, patch: Partial<MarkupRule>) =>
    onChange(rules.map((r, ri) => (ri === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rules.length === 0 ? (
        <p className="text-meta italic text-content-subtle">No rules — a change order request under this schedule carries no markup.</p>
      ) : null}
      {rules.map((r, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_100px_auto]">
          <Input value={r.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label" aria-label="Rule label" />
          <Select value={r.kind} onChange={(e) => update(i, { kind: e.target.value })} aria-label="Kind">
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <Select value={r.basis} onChange={(e) => update(i, { basis: e.target.value })} aria-label="Basis">
            {BASES.map((b) => (
              <option key={b} value={b}>
                {b.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
          <Input
            value={String(r.rate)}
            inputMode="decimal"
            onChange={(e) => update(i, { rate: Number(e.target.value) })}
            aria-label={r.kind === "percent" ? "Rate %" : "Amount"}
          />
          <Button size="sm" variant="ghost" onClick={() => onChange(rules.filter((_, ri) => ri !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <Button size="xs" variant="secondary" onClick={() => onChange([...rules, emptyRule()])}>
        Add rule
      </Button>
    </div>
  );
}

function ScheduleEditor({
  projectId,
  primeContractId,
  initial,
  onSaved,
}: {
  projectId: string;
  primeContractId: string | null;
  initial: Schedule | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? (primeContractId ? "Contract override" : "Standard markups"));
  const [rules, setRules] = useState<MarkupRule[]>(initial?.rules ?? []);
  const [bands, setBands] = useState<Band[]>(initial?.bands ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(initial?.name ?? (primeContractId ? "Contract override" : "Standard markups"));
    setRules(initial?.rules ?? []);
    setBands(initial?.bands ?? []);
  }, [initial, primeContractId]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const q = primeContractId ? `?primeContractId=${encodeURIComponent(primeContractId)}` : "";
      await api.put(`/api/v1/projects/${projectId}/change-markups${q}`, { name, rules, bands });
      toast.success("Markup schedule saved.");
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "The schedule was refused"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <ErrorAlert message={error} />
      <Field label="Schedule name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div>
        <p className="mb-1 text-label uppercase text-content-subtle">Default rules (when no band matches)</p>
        <RuleEditor rules={rules} onChange={setRules} />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-label uppercase text-content-subtle">Bands by cost subtotal</p>
          <Button size="xs" variant="ghost" onClick={() => setBands([...bands, { upTo: null, rules: [emptyRule()] }])}>
            Add band
          </Button>
        </div>
        <p className="mb-2 text-2xs text-content-subtle">
          &ldquo;15% under 50,000, 10% to 250,000, 5% above&rdquo; — ascending, with at most one open-ended band, last.
        </p>
        <div className="space-y-3">
          {bands.map((b, i) => (
            <Card key={i}>
              <CardBody className="space-y-2">
                <div className="flex items-center gap-2">
                  <Field label="Applies up to a cost subtotal of" hint="Leave blank for open-ended (the last band)">
                    <Input
                      value={b.upTo === null ? "" : String(b.upTo)}
                      inputMode="decimal"
                      onChange={(e) =>
                        setBands(bands.map((x, xi) => (xi === i ? { ...x, upTo: e.target.value.trim() === "" ? null : Number(e.target.value) } : x)))
                      }
                    />
                  </Field>
                  <Button size="xs" variant="ghost" onClick={() => setBands(bands.filter((_, xi) => xi !== i))}>
                    Remove band
                  </Button>
                </div>
                <RuleEditor rules={b.rules} onChange={(next) => setBands(bands.map((x, xi) => (xi === i ? { ...x, rules: next } : x)))} />
              </CardBody>
            </Card>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save schedule"}
        </Button>
      </div>
    </div>
  );
}

export default function ConfigTab({ projectId, context }: { projectId: string; context: ChangeContext }) {
  const config = useResource<ConfigResponse>(`/api/v1/projects/${projectId}/change-config`);
  const markups = useResource<MarkupsResponse>(`/api/v1/projects/${projectId}/change-markups`);
  const [tier, setTier] = useState<string>("two_tier");
  const [requireQuote, setRequireQuote] = useState(false);
  const [contractForOverride, setContractForOverride] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config.data) {
      setTier(config.data.tier);
      setRequireQuote(config.data.requireQuoteForSubcontract);
    }
  }, [config.data]);

  async function saveTier() {
    setError(null);
    try {
      await api.put(`/api/v1/projects/${projectId}/change-config`, { tier, requireQuoteForSubcontract: requireQuote });
      toast.success("Tier saved.");
      config.reload();
    } catch (err) {
      setError(errorMessage(err, "The configuration was refused"));
    }
  }

  const tierDef = config.data?.tiers.find((t) => t.tier === tier) ?? null;

  return (
    <div className="space-y-4">
      <ErrorAlert message={config.error ?? markups.error ?? error} />

      <Card>
        <CardHeader
          title="Change-management tier"
          subtitle="How many documents stand between a field event and money moving. A three-tier project refuses to package a PCO that skipped its owner request."
          actions={
            config.data ? (
              <Badge tone="neutral" variant="outline">
                source: {config.data.source.replace(/_/g, " ")}
              </Badge>
            ) : null
          }
        />
        <CardBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="Tier">
              <Select value={tier} onChange={(e) => setTier(e.target.value)}>
                {(config.data?.tiers ?? []).map((t) => (
                  <option key={t.tier} value={t.tier}>
                    {t.label} — {t.stages.join(" → ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Subcontract PCOs need an accepted RFQ (three-tier only)">
              <Select value={requireQuote ? "yes" : "no"} onChange={(e) => setRequireQuote(e.target.value === "yes")}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </Select>
            </Field>
            <div className="flex items-end">
              <Button onClick={() => void saveTier()} disabled={config.loading}>
                Save tier
              </Button>
            </div>
          </div>
          {tierDef ? (
            <Alert tone="info" variant="subtle" size="sm" title={tierDef.label}>
              {tierDef.description}
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Markup schedule — project default"
          subtitle="The OH&P stack a change order request carries when it is raised without explicit markups. Resolved contract override → project → legacy setting → none."
        />
        <CardBody>
          {markups.data?.note ? (
            <Alert tone="warning" size="sm" className="mb-3" title="No schedule configured">
              {markups.data.note}
            </Alert>
          ) : null}
          {markups.data && markups.data.legacyRules.length > 0 && !markups.data.project ? (
            <Alert tone="info" variant="subtle" size="sm" className="mb-3" title="Legacy project setting in use">
              {markups.data.legacyRules.length} rule(s) from the project settings apply until a schedule is saved here.
            </Alert>
          ) : null}
          <ScheduleEditor projectId={projectId} primeContractId={null} initial={markups.data?.project ?? null} onSaved={markups.reload} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Per-contract overrides"
          subtitle="A prime contract may carry its own stack; it wins over the project default for requests under it."
        />
        <CardBody className="space-y-3">
          {(markups.data?.contracts ?? []).length > 0 ? (
            <ul className="space-y-1 text-meta">
              {(markups.data?.contracts ?? []).map((s) => (
                <li key={s.id} className="flex items-center justify-between">
                  <span>
                    <span className="font-mono">{context.contractById.get(s.primeContractId ?? "")?.reference ?? s.primeContractId}</span>{" "}
                    — {s.name} · {s.rules.length} rule(s), {s.bands.length} band(s)
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => setContractForOverride(s.primeContractId ?? "")}>
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta italic text-content-subtle">No contract carries its own schedule.</p>
          )}
          <Field label="Contract to override">
            <Select value={contractForOverride} onChange={(e) => setContractForOverride(e.target.value)}>
              <option value="">Pick a prime contract…</option>
              {context.contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.reference} — {c.title}
                </option>
              ))}
            </Select>
          </Field>
          {contractForOverride ? (
            <ScheduleEditor
              projectId={projectId}
              primeContractId={contractForOverride}
              initial={markups.data?.contracts.find((s) => s.primeContractId === contractForOverride) ?? null}
              onSaved={markups.reload}
            />
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
