/**
 * Group & ICV tab — the multi-entity half of Domain K (#600-615).
 *
 *  · Reporting entities: the legal entities a programme is delivered through,
 *    each with a FUNCTIONAL currency (IAS 21 para 9 — the currency of the
 *    primary economic environment it operates in, not the currency its
 *    invoices happen to be written in), an ownership share, and where the
 *    economy is hyperinflationary the price index IAS 29 restatement needs.
 *  · Consolidation: translate every entity into one presentation currency.
 *    An entity with no rate on file is reported UNPRICED with the reason —
 *    never converted at a guess, never dropped silently — and the difference
 *    between the two rate bases IS the translation reserve exposure.
 *  · ICV certificates: the register the Gulf and Nigerian local-content
 *    regimes run on, with expiry obligations.
 *
 * Every figure that cannot be computed says why. Functional-currency
 * subtotals are never summed across currencies.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";

/* ================================ Types ================================== */

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface EntityRow {
  id: string;
  name: string;
  code: string | null;
  role: string;
  country: string;
  functionalCurrency: string;
  presentationCurrency: string;
  hyperinflationaryBool: boolean;
  activeBool: boolean;
  ownershipPercent: number;
  projectCount: number;
}

interface ConsolidationLine {
  entityId: string;
  name: string;
  role: string;
  country: string;
  functionalCurrency: string;
  ownershipPercent: number;
  functionalAmount: number;
  restatementFactor: number;
  restatedFunctionalAmount: number;
  groupShareAmount: number;
  rate: number | null;
  rateDate: string | null;
  rateSource: string | null;
  translatedAmount: number | null;
  notes: string[];
}

interface ConsolidationResult {
  id?: string;
  presentationCurrency: string;
  method: string;
  asOf: string;
  lines: ConsolidationLine[];
  unpriced: { entityId: string; name: string; functionalCurrency: string; reason: string }[];
  totals: {
    entities: number;
    translated: number;
    presentationTotal: number;
    alternativeBasisTotal: number | null;
    translationReserve: number | null;
    byFunctionalCurrency: { currency: string; entities: number; amount: number }[];
    ias29Entities: number;
  };
  note: string | null;
}

interface ProjectLink {
  id: string;
  entityId: string;
  sharePercent: number;
  role: string | null;
  entity: EntityRow;
}

interface ProjectLinks {
  items: ProjectLink[];
  total: number;
  shareSum: number;
  shareBalanced: boolean;
  functionalCurrencies: string[];
}

interface IcvRow {
  id: string;
  entityName: string;
  jurisdiction: string;
  issuer: string;
  certificateNumber: string;
  score: number | null;
  scoreUnit: string;
  issuedAt: string;
  expiresAt: string | null;
  status: string;
  daysToExpiry: number | null;
}

const ICV_TONE: Record<string, "green" | "amber" | "red" | "gray"> = {
  issued: "green",
  expiring: "amber",
  expired: "red",
  withdrawn: "gray",
  superseded: "gray",
};

type SubView = "entities" | "consolidation" | "icv";

const SUB_VIEWS: { key: SubView; label: string; hint: string }[] = [
  { key: "entities", label: "Reporting entities", hint: "#600-603" },
  { key: "consolidation", label: "Consolidation", hint: "#604-606" },
  { key: "icv", label: "ICV certificates", hint: "#612-615" },
];

/* ================================ Shell ================================== */

export default function GroupTab({ projectId }: { projectId: string }) {
  const [view, setView] = useState<SubView>("entities");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1 border-b border-ink-200">
        {SUB_VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            className={
              view === v.key
                ? "-mb-px border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-800"
            }
          >
            {v.label}
            <span className="ml-1.5 text-[11px] font-normal text-ink-300">{v.hint}</span>
          </button>
        ))}
      </div>
      {view === "entities" ? <EntitiesPanel projectId={projectId} /> : null}
      {view === "consolidation" ? <ConsolidationPanel /> : null}
      {view === "icv" ? <IcvPanel projectId={projectId} /> : null}
    </div>
  );
}

/* ------------------------------ Entities --------------------------------- */

function EntitiesPanel({ projectId }: { projectId: string }) {
  const [entities, setEntities] = useState<EntityRow[] | null>(null);
  const [links, setLinks] = useState<ProjectLinks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    code: "",
    role: "subsidiary",
    country: "",
    functionalCurrency: "USD",
    presentationCurrency: "USD",
    ownershipPercent: "100",
    hyperinflationary: false,
    priceIndex: "",
  });
  const [linkForm, setLinkForm] = useState({ entityId: "", sharePercent: "100", role: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, projectLinks] = await Promise.all([
        api.get<ListResponse<EntityRow>>("/api/v1/reporting-entities?pageSize=200"),
        api.get<ProjectLinks>(`/api/v1/projects/${projectId}/reporting-entities`),
      ]);
      setEntities(list.items);
      setLinks(projectLinks);
    } catch (err) {
      setEntities([]);
      setError(err instanceof Error ? err.message : "Failed to load reporting entities");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const priceIndex = form.priceIndex
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [period, index] = line.split(/[,\s]+/);
          return { period: period ?? "", index: Number(index) };
        })
        .filter((p) => p.period !== "" && Number.isFinite(p.index) && p.index > 0);
      await api.post("/api/v1/reporting-entities", {
        name: form.name,
        code: form.code || null,
        role: form.role,
        country: form.country,
        functionalCurrency: form.functionalCurrency,
        presentationCurrency: form.presentationCurrency,
        ownershipPercent: Number(form.ownershipPercent),
        hyperinflationary: form.hyperinflationary,
        priceIndex,
      });
      setOpen(false);
      setForm({ ...form, name: "", code: "", priceIndex: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the entity");
    } finally {
      setSaving(false);
    }
  }

  async function link() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/reporting-entities`, {
        entityId: linkForm.entityId,
        sharePercent: Number(linkForm.sharePercent),
        role: linkForm.role || null,
      });
      setLinkOpen(false);
      setLinkForm({ entityId: "", sharePercent: "100", role: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link the entity");
    } finally {
      setSaving(false);
    }
  }

  async function unlink(linkId: string) {
    setError(null);
    try {
      await api.del(`/api/v1/projects/${projectId}/reporting-entities/${linkId}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink the entity");
    }
  }

  return (
    <div className="space-y-5">
      <ErrorAlert message={error} />

      <Card>
        <CardHeader
          title="Entities on this project"
          subtitle="Who delivers this project, and on what share"
          actions={
            <Button size="sm" onClick={() => setLinkOpen(true)}>
              Link entity
            </Button>
          }
        />
        <CardBody>
          {links === null ? (
            <Spinner label="Loading project entities…" />
          ) : links.items.length === 0 ? (
            <EmptyState
              title="No entities linked"
              description="Link the legal entities delivering this project. A JV partner's 40% of a project is not the same fact as the project."
            />
          ) : (
            <>
              {!links.shareBalanced ? (
                <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
                  Linked shares total {links.shareSum}% rather than 100%. Either an entity is
                  missing or a share is wrong — the consolidation will inherit the gap.
                </p>
              ) : null}
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Entity</Th>
                      <Th>Role</Th>
                      <Th>Country</Th>
                      <Th>Functional</Th>
                      <Th className="text-right">Share</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {links.items.map((l) => (
                      <tr key={l.id}>
                        <Td className="font-medium text-ink-900">
                          {l.entity.name}
                          {l.entity.hyperinflationaryBool ? (
                            <Badge tone="amber" className="ml-2">
                              IAS 29
                            </Badge>
                          ) : null}
                        </Td>
                        <Td className="text-ink-600">{l.role ?? humanize(l.entity.role)}</Td>
                        <Td className="text-ink-600">{l.entity.country}</Td>
                        <Td className="font-mono text-xs">{l.entity.functionalCurrency}</Td>
                        <Td className="text-right tabular-nums">{l.sharePercent}%</Td>
                        <Td className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => void unlink(l.id)}>
                            Unlink
                          </Button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {links.functionalCurrencies.length > 1 ? (
                <p className="mt-2 text-xs text-ink-500">
                  Entities here report in {links.functionalCurrencies.join(", ")}. Positions are
                  never summed across those currencies — the consolidation translates them
                  deliberately, at a dated rate, and says which entities it could not price.
                </p>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Company reporting entities"
          subtitle="IAS 21 functional currency, ownership share and IAS 29 price index"
          actions={
            <Button size="sm" onClick={() => setOpen(true)}>
              New entity
            </Button>
          }
        />
        <CardBody>
          {entities === null ? (
            <Spinner label="Loading entities…" />
          ) : entities.length === 0 ? (
            <EmptyState
              title="No reporting entities"
              description="Register the legal entities the programme is delivered through before consolidating anything."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Entity</Th>
                    <Th>Role</Th>
                    <Th>Country</Th>
                    <Th>Functional</Th>
                    <Th>Presentation</Th>
                    <Th className="text-right">Ownership</Th>
                    <Th className="text-right">Projects</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {entities.map((e) => (
                    <tr key={e.id}>
                      <Td className="font-medium text-ink-900">
                        {e.name}
                        {e.code ? (
                          <span className="ml-2 font-mono text-xs text-ink-400">{e.code}</span>
                        ) : null}
                        {e.hyperinflationaryBool ? (
                          <Badge tone="amber" className="ml-2">
                            hyperinflationary
                          </Badge>
                        ) : null}
                      </Td>
                      <Td className="text-ink-600">{humanize(e.role)}</Td>
                      <Td className="text-ink-600">{e.country}</Td>
                      <Td className="font-mono text-xs">{e.functionalCurrency}</Td>
                      <Td className="font-mono text-xs">{e.presentationCurrency}</Td>
                      <Td className="text-right tabular-nums">{e.ownershipPercent}%</Td>
                      <Td className="text-right tabular-nums">{e.projectCount}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="New reporting entity" wide>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Code">
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </Field>
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {[
                  "parent",
                  "subsidiary",
                  "branch",
                  "joint_venture",
                  "associate",
                  "permanent_establishment",
                ].map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Country">
              <Input
                value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
                placeholder="NG"
              />
            </Field>
            <Field
              label="Functional currency"
              hint="The currency of its primary economic environment"
            >
              <Input
                value={form.functionalCurrency}
                maxLength={3}
                onChange={(e) =>
                  setForm({ ...form, functionalCurrency: e.target.value.toUpperCase() })
                }
              />
            </Field>
            <Field label="Presentation currency">
              <Input
                value={form.presentationCurrency}
                maxLength={3}
                onChange={(e) =>
                  setForm({ ...form, presentationCurrency: e.target.value.toUpperCase() })
                }
              />
            </Field>
            <Field label="Ownership %">
              <Input
                type="number"
                value={form.ownershipPercent}
                onChange={(e) => setForm({ ...form, ownershipPercent: e.target.value })}
              />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.hyperinflationary}
              onChange={(e) => setForm({ ...form, hyperinflationary: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              Hyperinflationary economy (IAS 29)
              <span className="block text-xs text-ink-500">
                Requires a general price index; amounts are restated before translation, because
                translating them unrestated overstates the group by the whole of the inflation.
              </span>
            </span>
          </label>
          {form.hyperinflationary ? (
            <Field
              label="General price index"
              hint="One point per line: period then index, e.g. 2025-01 100"
            >
              <Textarea
                rows={4}
                value={form.priceIndex}
                onChange={(e) => setForm({ ...form, priceIndex: e.target.value })}
                placeholder={"2025-01 100\n2026-01 250"}
              />
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={saving || form.name.trim() === "" || form.country.trim() === ""}
            >
              {saving ? "Saving…" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title="Link an entity">
        <div className="space-y-3">
          <Field label="Entity">
            <Select
              value={linkForm.entityId}
              onChange={(e) => setLinkForm({ ...linkForm, entityId: e.target.value })}
            >
              <option value="">Select an entity…</option>
              {(entities ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.functionalCurrency})
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Share %">
              <Input
                type="number"
                value={linkForm.sharePercent}
                onChange={(e) => setLinkForm({ ...linkForm, sharePercent: e.target.value })}
              />
            </Field>
            <Field label="Role on this project">
              <Input
                value={linkForm.role}
                onChange={(e) => setLinkForm({ ...linkForm, role: e.target.value })}
                placeholder="Lead contractor"
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLinkOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void link()} disabled={saving || linkForm.entityId === ""}>
              {saving ? "Saving…" : "Link"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* --------------------------- Consolidation -------------------------------- */

function ConsolidationPanel() {
  const [entities, setEntities] = useState<EntityRow[] | null>(null);
  const [runs, setRuns] = useState<ConsolidationResult[] | null>(null);
  const [result, setResult] = useState<ConsolidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [presentationCurrency, setPresentationCurrency] = useState("USD");
  const [method, setMethod] = useState("closing_rate");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [periods, setPeriods] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, history] = await Promise.all([
        api.get<ListResponse<EntityRow>>("/api/v1/reporting-entities?pageSize=200&active=true"),
        api.get<ListResponse<ConsolidationResult>>("/api/v1/consolidations?pageSize=20"),
      ]);
      setEntities(list.items);
      setRuns(history.items);
    } catch (err) {
      setEntities([]);
      setError(err instanceof Error ? err.message : "Failed to load the consolidation view");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        presentationCurrency,
        method,
        amounts: Object.entries(amounts)
          .filter(([, v]) => v !== "" && Number.isFinite(Number(v)))
          .map(([entityId, v]) => ({
            entityId,
            amount: Number(v),
            amountPeriod: periods[entityId] || null,
          })),
      };
      if (payload.amounts.length === 0) {
        setError("Enter at least one entity amount, in that entity's own functional currency");
        return;
      }
      setResult(await api.post<ConsolidationResult>("/api/v1/consolidations", payload));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The consolidation was refused");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <ErrorAlert message={error} />

      <Card>
        <CardHeader
          title="Run a consolidation"
          subtitle="Amounts are entered in each entity's OWN functional currency; translation is the platform's job, not yours"
        />
        <CardBody>
          {entities === null ? (
            <Spinner label="Loading entities…" />
          ) : entities.length === 0 ? (
            <EmptyState
              title="No entities to consolidate"
              description="Register reporting entities first — a consolidation is a translation of positions that belong to somebody."
            />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <Field label="Presentation currency">
                  <Input
                    value={presentationCurrency}
                    maxLength={3}
                    onChange={(e) => setPresentationCurrency(e.target.value.toUpperCase())}
                  />
                </Field>
                <Field label="Method">
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {["closing_rate", "average_rate", "historical_rate"].map((m) => (
                      <option key={m} value={m}>
                        {humanize(m)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button onClick={() => void run()} disabled={busy}>
                  {busy ? "Consolidating…" : "Consolidate"}
                </Button>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Entity</Th>
                      <Th>Functional</Th>
                      <Th className="text-right">Ownership</Th>
                      <Th className="text-right">Amount</Th>
                      <Th>Period struck</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {entities.map((e) => (
                      <tr key={e.id}>
                        <Td className="font-medium text-ink-900">
                          {e.name}
                          {e.hyperinflationaryBool ? (
                            <Badge tone="amber" className="ml-2">
                              IAS 29
                            </Badge>
                          ) : null}
                        </Td>
                        <Td className="font-mono text-xs">{e.functionalCurrency}</Td>
                        <Td className="text-right tabular-nums">{e.ownershipPercent}%</Td>
                        <Td className="text-right">
                          <Input
                            type="number"
                            value={amounts[e.id] ?? ""}
                            onChange={(ev) =>
                              setAmounts({ ...amounts, [e.id]: ev.target.value })
                            }
                            className="w-40 text-right"
                          />
                        </Td>
                        <Td>
                          {e.hyperinflationaryBool ? (
                            <Input
                              value={periods[e.id] ?? ""}
                              onChange={(ev) =>
                                setPeriods({ ...periods, [e.id]: ev.target.value })
                              }
                              placeholder="2025-01"
                              className="w-28"
                            />
                          ) : (
                            <span className="text-xs text-ink-400">—</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {result ? (
        <Card>
          <CardHeader
            title={`Consolidated to ${result.presentationCurrency}`}
            subtitle={`${humanize(result.method)} as at ${formatDate(result.asOf)} — ${result.totals.translated} of ${result.totals.entities} entities translated`}
          />
          <CardBody>
            <div className="mb-4 flex flex-wrap items-center gap-6 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-ink-400">
                  Presentation total
                </div>
                <div className="text-xl font-semibold tabular-nums">
                  {result.totals.presentationTotal.toLocaleString()}{" "}
                  {result.presentationCurrency}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-ink-400">
                  Translation reserve
                </div>
                <div className="text-xl font-semibold tabular-nums">
                  {result.totals.translationReserve === null ? (
                    <span
                      className="text-base font-normal text-ink-400"
                      title="The alternative rate basis is incomplete, so the reserve cannot be quantified. Reporting it as zero would assert there is no exposure."
                    >
                      not quantifiable
                    </span>
                  ) : (
                    result.totals.translationReserve.toLocaleString()
                  )}
                </div>
              </div>
              {result.totals.ias29Entities > 0 ? (
                <Badge tone="amber">{result.totals.ias29Entities} restated under IAS 29</Badge>
              ) : null}
            </div>

            {result.totals.byFunctionalCurrency.length > 0 ? (
              <p className="mb-3 text-xs text-ink-500">
                Functional-currency subtotals (never summed across):{" "}
                {result.totals.byFunctionalCurrency
                  .map((b) => `${b.amount.toLocaleString()} ${b.currency}`)
                  .join(" · ")}
              </p>
            ) : null}

            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Entity</Th>
                    <Th className="text-right">Functional</Th>
                    <Th className="text-right">Restated</Th>
                    <Th className="text-right">Group share</Th>
                    <Th className="text-right">Rate</Th>
                    <Th>Source</Th>
                    <Th className="text-right">Translated</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {result.lines.map((l) => (
                    <tr key={l.entityId}>
                      <Td className="font-medium text-ink-900">
                        {l.name}
                        {l.notes.length > 0 ? (
                          <div className="text-[11px] font-normal text-ink-500">
                            {l.notes.join(" ")}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">
                        {l.functionalAmount.toLocaleString()} {l.functionalCurrency}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {l.restatementFactor === 1 ? (
                          <span className="text-ink-400">—</span>
                        ) : (
                          `× ${l.restatementFactor}`
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {l.groupShareAmount.toLocaleString()}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {l.rate === null ? <span className="text-ink-400">—</span> : l.rate}
                      </Td>
                      <Td className="text-xs text-ink-500">{l.rateSource ?? "—"}</Td>
                      <Td className="text-right font-medium tabular-nums">
                        {l.translatedAmount === null ? (
                          <span className="font-normal text-ink-400">unpriced</span>
                        ) : (
                          l.translatedAmount.toLocaleString()
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>

            {result.unpriced.length > 0 ? (
              <div className="mt-4 space-y-2 rounded-lg bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
                <div className="font-semibold text-amber-900">
                  {result.unpriced.length} entit
                  {result.unpriced.length === 1 ? "y is" : "ies are"} excluded from the total
                </div>
                {result.unpriced.map((u) => (
                  <p key={u.entityId} className="text-xs text-amber-800">
                    <span className="font-medium">{u.name}</span> — {u.reason}
                  </p>
                ))}
              </div>
            ) : null}
            {result.note ? <p className="mt-3 text-xs text-ink-500">{result.note}</p> : null}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Previous runs" />
        <CardBody>
          {runs === null ? (
            <Spinner label="Loading runs…" />
          ) : runs.length === 0 ? (
            <EmptyState title="No consolidations yet" description="Run one above." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>As at</Th>
                    <Th>Presentation</Th>
                    <Th>Method</Th>
                    <Th className="text-right">Entities</Th>
                    <Th className="text-right">Unpriced</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {runs.map((r, i) => (
                    <tr key={r.id ?? i}>
                      <Td className="whitespace-nowrap text-xs text-ink-500">
                        {formatDate(r.asOf)}
                      </Td>
                      <Td className="font-mono text-xs">{r.presentationCurrency}</Td>
                      <Td className="text-ink-600">{humanize(r.method)}</Td>
                      <Td className="text-right tabular-nums">{r.lines?.length ?? 0}</Td>
                      <Td className="text-right tabular-nums">{r.unpriced?.length ?? 0}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* -------------------------------- ICV ------------------------------------ */

function IcvPanel({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [rows, setRows] = useState<IcvRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    entityName: "",
    jurisdiction: "",
    issuer: "",
    certificateNumber: "",
    score: "",
    issuedAt: "",
    expiresAt: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<IcvRow>>(`${base}/icv-certificates?pageSize=200`);
      setRows(res.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load ICV certificates");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/icv-certificates`, {
        entityName: form.entityName,
        jurisdiction: form.jurisdiction,
        issuer: form.issuer,
        certificateNumber: form.certificateNumber,
        score: form.score === "" ? null : Number(form.score),
        issuedAt: form.issuedAt,
        expiresAt: form.expiresAt || null,
      });
      setOpen(false);
      setForm({ ...form, entityName: "", certificateNumber: "", score: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register the certificate");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="In-Country Value certificates"
        subtitle="In Gulf ICV and Nigerian NCDMB regimes the certificate is the tender currency — an expired one is an exclusion from bidding"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Register certificate
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {rows === null ? (
          <Spinner label="Loading certificates…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No ICV certificates"
            description="Register the certificates your suppliers and entities hold; expiry becomes an obligation and is warned about 60 days out, because recertification takes weeks."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Entity</Th>
                  <Th>Jurisdiction</Th>
                  <Th>Issuer</Th>
                  <Th>Certificate</Th>
                  <Th className="text-right">Score</Th>
                  <Th>Expires</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td className="font-medium text-ink-900">{r.entityName}</Td>
                    <Td className="text-ink-600">{r.jurisdiction}</Td>
                    <Td className="text-ink-600">{r.issuer}</Td>
                    <Td className="font-mono text-xs">{r.certificateNumber}</Td>
                    <Td className="text-right tabular-nums">
                      {r.score === null ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        `${r.score}${r.scoreUnit}`
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-500">
                      {r.expiresAt ? (
                        <>
                          {formatDate(r.expiresAt)}
                          {r.daysToExpiry !== null ? (
                            <span
                              className={
                                r.daysToExpiry < 0
                                  ? "ml-1 text-red-700"
                                  : r.daysToExpiry <= 60
                                    ? "ml-1 text-amber-700"
                                    : "ml-1 text-ink-400"
                              }
                            >
                              ({r.daysToExpiry}d)
                            </span>
                          ) : null}
                        </>
                      ) : (
                        "no expiry recorded"
                      )}
                    </Td>
                    <Td>
                      <Badge tone={ICV_TONE[r.status] ?? "gray"}>{humanize(r.status)}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="Register an ICV certificate">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Entity">
              <Input
                value={form.entityName}
                onChange={(e) => setForm({ ...form, entityName: e.target.value })}
              />
            </Field>
            <Field label="Jurisdiction">
              <Input
                value={form.jurisdiction}
                onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })}
                placeholder="AE"
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Issuer">
              <Input
                value={form.issuer}
                onChange={(e) => setForm({ ...form, issuer: e.target.value })}
              />
            </Field>
            <Field label="Certificate number">
              <Input
                value={form.certificateNumber}
                onChange={(e) => setForm({ ...form, certificateNumber: e.target.value })}
              />
            </Field>
            <Field label="Score">
              <Input
                type="number"
                value={form.score}
                onChange={(e) => setForm({ ...form, score: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Issued">
              <Input
                type="date"
                value={form.issuedAt}
                onChange={(e) => setForm({ ...form, issuedAt: e.target.value })}
              />
            </Field>
            <Field label="Expires" hint="Opens a renewal obligation warned 60 days out">
              <Input
                type="date"
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={
                saving ||
                form.entityName.trim() === "" ||
                form.issuer.trim() === "" ||
                form.certificateNumber.trim() === "" ||
                form.issuedAt === ""
              }
            >
              {saving ? "Saving…" : "Register"}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
