/**
 * SAVED VIEWS with CALCULATED FIELDS (spec #486–487).
 *
 * A calculated field is an arithmetic expression over the stored cost-report
 * columns — `revisedBudget - committedCost`, `pct(jobToDateCosts,
 * revisedBudget)` — evaluated by the API's own whitelisted evaluator, never
 * by the browser. The editor previews the field over the real lines before
 * anything is saved, and a division by zero on a line renders "not
 * available" with the reason, never 0.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
  useConfirm,
} from "../../ui";
import { IconPlus, IconSpreadsheet } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  SectionHeading,
  actorName,
  count,
  errorMessage,
  errorReasons,
  labelize,
  money,
  useResource,
  type BudgetDetail,
  type BudgetView,
  type CalculatedField,
  type EvalResult,
  type ViewRowsResponse,
} from "./budgetShared";

const COLUMN_HELP =
  "originalBudget, budgetModifications, approvedChanges, pendingBudgetChanges, revisedBudget, committedCost, pendingCommitments, directCosts, jobToDateCosts, forecastToComplete, forecastFinal, projectedOverUnder, percentComplete, quantity, unitRate · functions: min, max, abs, round, pct(a, b), ratio(a, b)";

export default function ViewsTab({
  budget,
  currency,
  users,
  version,
  onChanged,
}: {
  budget: BudgetDetail;
  currency: string;
  users: Map<string, string>;
  version: number;
  onChanged: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<BudgetView | null | "new">(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const views = useResource<{ items: BudgetView[]; total: number; columns: string[] }>(
    (signal) => api.get<{ items: BudgetView[]; total: number; columns: string[] }>(`/api/v1/budgets/${budget.id}/views`, { signal }),
    [budget.id, version],
  );
  const items = useMemo(() => views.data?.items ?? [], [views.data]);
  useEffect(() => {
    if (items.length === 0) return;
    if (selected && items.some((v) => v.id === selected)) return;
    const preferred = items.find((v) => v.isDefault === 1) ?? items[0];
    if (preferred) setSelected(preferred.id);
  }, [items, selected]);

  const rows = useResource<ViewRowsResponse>(
    (signal) => api.get<ViewRowsResponse>(`/api/v1/budget-views/${selected}/rows?budgetId=${budget.id}`, { signal }),
    [selected ?? "", budget.id, version],
    selected !== null,
  );

  const current = items.find((v) => v.id === selected) ?? null;

  async function remove(view: BudgetView) {
    const ok = await confirm({ title: `Delete view "${view.name}"?`, description: "Its calculated fields are deleted with it. The budget lines are untouched.", confirmLabel: "Delete view", destructive: true });
    if (!ok) return;
    try {
      await api.del(`/api/v1/budget-views/${view.id}`);
      setSelected(null);
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, "The view could not be deleted"));
    }
  }

  return (
    <div className="space-y-5">
      {dialog}
      <ErrorAlert message={actionError} onDismiss={() => setActionError(null)} />
      <SectionHeading
        title="Saved views"
        hint="A view is a column set, a grouping and any number of calculated fields — arithmetic over the stored cost report, evaluated server-side so a saved figure is reproducible."
        actions={
          <>
            {items.length > 0 ? (
              <Select value={selected ?? ""} onChange={(e) => setSelected(e.target.value)} size="sm" aria-label="View">
                {items.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.isDefault === 1 ? " — default" : ""}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button size="sm" leadingIcon={IconPlus} onClick={() => setEditing("new")}>
              New view
            </Button>
          </>
        }
      />

      {views.error ? <LoadError message={views.error} onRetry={views.reload} title="Views could not be loaded" /> : null}

      {views.loading && items.length === 0 ? (
        <Skeleton height={200} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={IconSpreadsheet}
          title="No saved view yet"
          hint="Create one to add calculated columns such as headroom (revised − committed) or spent % to the cost report."
          action={
            <Button leadingIcon={IconPlus} onClick={() => setEditing("new")}>
              Create a view
            </Button>
          }
        />
      ) : current ? (
        <>
          <Card>
            <CardBody className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-body font-semibold text-content">
                    {current.name}{" "}
                    {current.isDefault === 1 ? (
                      <Badge tone="accent" size="xs">
                        default
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-meta text-content-muted">
                    {current.description ?? "No description"} · grouped by {labelize(current.grouping)} · by {actorName(users, current.createdBy)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(current)}>
                    Edit fields
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(current)}>
                    Delete
                  </Button>
                </div>
              </div>
              {current.calculatedFields.length === 0 ? (
                <p className="text-meta text-content-subtle">This view defines no calculated field.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {current.calculatedFields.map((f) => (
                    <li key={f.key} className="rounded-md border border-border-subtle px-2 py-1 text-meta">
                      <span className="font-medium">{f.label}</span> <code className="font-mono text-content-muted">= {f.expression}</code>{" "}
                      <Badge tone="neutral" size="xs" variant="outline">
                        {f.format}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {rows.error ? <LoadError message={rows.error} onRetry={rows.reload} title="The view could not be evaluated" /> : null}
          {rows.loading && !rows.data ? <Skeleton height={280} /> : null}
          {rows.data ? (
            <>
              {rows.data.errors.length > 0 ? (
                <Alert tone="danger" title="A saved field no longer compiles">
                  {rows.data.errors.join(" · ")}
                </Alert>
              ) : null}
              <div className="overflow-x-auto">
                <Table dense stickyHeader>
                  <thead>
                    <tr>
                      <Th>Line</Th>
                      <Th numeric>Revised</Th>
                      <Th numeric>Committed</Th>
                      <Th numeric>Spent</Th>
                      <Th numeric>Forecast</Th>
                      {rows.data.fields.map((f) => (
                        <Th key={f.key} numeric>
                          {f.label}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.data.items.map((l) => (
                      <Tr key={l.id}>
                        <Td>
                          <span className="font-mono text-code">{l.costCode}</span> <span className="text-content-muted">{labelize(l.costType)}</span>
                          <span className="block truncate text-meta text-content-subtle">{l.description}</span>
                        </Td>
                        <Td numeric>{money(l.revisedBudget, currency)}</Td>
                        <Td numeric>{money(l.committedCost, currency)}</Td>
                        <Td numeric>{money(l.jobToDateCosts, currency)}</Td>
                        <Td numeric>{money(l.forecastFinal, currency)}</Td>
                        {rows.data!.fields.map((f) => (
                          <Td key={f.key} numeric>
                            <CalculatedCell result={l.calculated[f.key]} format={f.format} currency={currency} />
                          </Td>
                        ))}
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              <p className="text-meta text-content-subtle">
                {count(rows.data.total)} lines · calculated fields are evaluated per line and deliberately not summed: a percentage of percentages is not a percentage.
              </p>
            </>
          ) : null}
        </>
      ) : null}

      <ViewEditor
        open={editing !== null}
        budget={budget}
        currency={currency}
        existing={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(id) => {
          setEditing(null);
          setSelected(id);
          onChanged();
        }}
      />
    </div>
  );
}

function CalculatedCell({ result, format, currency }: { result: EvalResult | undefined; format: CalculatedField["format"]; currency: string }) {
  if (!result) return <span className="text-content-disabled">{EM_DASH}</span>;
  if (result.value === null) {
    return (
      <span className="text-content-muted" title={result.reasons.join(" ")}>
        Not available
      </span>
    );
  }
  if (format === "currency") return <span className="tabular-nums">{money(result.value, currency)}</span>;
  if (format === "percent") return <span className="tabular-nums">{result.value.toFixed(1)}%</span>;
  return <span className="tabular-nums">{result.value.toLocaleString()}</span>;
}

interface DraftField {
  key: string;
  label: string;
  expression: string;
  format: CalculatedField["format"];
}

function ViewEditor({
  open,
  budget,
  currency,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  budget: BudgetDetail;
  currency: string;
  existing: BudgetView | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [grouping, setGrouping] = useState("none");
  const [isDefault, setIsDefault] = useState(false);
  const [fields, setFields] = useState<DraftField[]>([]);
  const [preview, setPreview] = useState<{ errors: string[]; items: Array<{ lineItemId: string; costCode: string; calculated: Record<string, EvalResult> }>; fields: CalculatedField[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? "");
    setDescription(existing?.description ?? "");
    setGrouping(existing?.grouping ?? "none");
    setIsDefault(existing?.isDefault === 1);
    setFields(
      existing?.calculatedFields.map((f) => ({ key: f.key, label: f.label, expression: f.expression, format: f.format })) ?? [
        { key: "headroom", label: "Headroom", expression: "revisedBudget - committedCost", format: "currency" },
      ],
    );
    setPreview(null);
    setError(null);
    setReasons([]);
  }, [open, existing]);

  function update(i: number, patch: Partial<DraftField>) {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
    setPreview(null);
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    try {
      const res = await api.post<{ errors: string[]; items: Array<{ lineItemId: string; costCode: string; calculated: Record<string, EvalResult> }>; fields: CalculatedField[] }>(
        `/api/v1/budgets/${budget.id}/views/evaluate`,
        { calculatedFields: fields },
      );
      setPreview(res);
    } catch (err) {
      setError(errorMessage(err, "The fields could not be evaluated"));
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    if (name.trim() === "") {
      setError("A view needs a name.");
      return;
    }
    setSaving(true);
    setError(null);
    setReasons([]);
    try {
      const body = { name: name.trim(), description: description.trim() === "" ? null : description.trim(), grouping, isDefault, calculatedFields: fields };
      if (existing) {
        const saved = await api.patch<BudgetView>(`/api/v1/budget-views/${existing.id}`, body);
        onSaved(saved.id);
      } else {
        const saved = await api.post<BudgetView>(`/api/v1/budgets/${budget.id}/views`, body);
        onSaved(saved.id);
      }
    } catch (err) {
      setError(errorMessage(err, "The view could not be saved"));
      const details = (err as { details?: { details?: { errors?: string[] } } }).details?.details;
      setReasons(details?.errors ?? errorReasons(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={existing ? `Edit view ${existing.name}` : "New view"}
      description="Expressions read the line's stored columns only. They are parsed and refused server-side; nothing is evaluated in the browser."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => void runPreview()} loading={previewing} disabled={fields.length === 0}>
            Preview over the lines
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            {existing ? "Save view" : "Create view"}
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} />
      {reasons.length > 0 ? (
        <Alert tone="danger" size="sm" title="Refused fields">
          <ul className="list-disc pl-4">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Grouping">
          <Select value={grouping} onChange={(e) => setGrouping(e.target.value)}>
            {["none", "division", "cost_type", "line_kind", "sub_job", "wbs"].map((g) => (
              <option key={g} value={g}>
                {labelize(g)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" optional className="sm:col-span-2">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-meta">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Make this the project's default view
      </label>

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className="text-meta font-semibold text-content">Calculated fields</p>
          <Button size="xs" variant="ghost" leadingIcon={IconPlus} onClick={() => setFields((f) => [...f, { key: `field_${f.length + 1}`, label: "", expression: "", format: "currency" }])}>
            Add field
          </Button>
        </div>
        <p className="mb-2 text-2xs text-content-subtle">Columns: {COLUMN_HELP}</p>
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[120px_160px_1fr_110px_auto]">
              <Input value={f.key} placeholder="key" onChange={(e) => update(i, { key: e.target.value })} aria-label="Field key" />
              <Input value={f.label} placeholder="Label" onChange={(e) => update(i, { label: e.target.value })} aria-label="Field label" />
              <Input value={f.expression} placeholder="revisedBudget - committedCost" onChange={(e) => update(i, { expression: e.target.value })} className="font-mono" aria-label="Expression" />
              <Select value={f.format} onChange={(e) => update(i, { format: e.target.value as CalculatedField["format"] })} aria-label="Format">
                <option value="currency">Currency</option>
                <option value="number">Number</option>
                <option value="percent">Percent</option>
              </Select>
              <Button size="sm" variant="ghost" onClick={() => setFields((prev) => prev.filter((_, idx) => idx !== i))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      </div>

      {preview ? (
        <div className="mt-4">
          {preview.errors.length > 0 ? (
            <Alert tone="danger" size="sm" title="These fields do not compile">
              <ul className="list-disc pl-4">
                {preview.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          ) : (
            <Table dense>
              <thead>
                <tr>
                  <Th>Line</Th>
                  {preview.fields.map((f) => (
                    <Th key={f.key} numeric>
                      {f.label}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.items.slice(0, 12).map((l) => (
                  <Tr key={l.lineItemId}>
                    <Td className="font-mono text-code">{l.costCode}</Td>
                    {preview.fields.map((f) => (
                      <Td key={f.key} numeric>
                        <CalculatedCell result={l.calculated[f.key]} format={f.format} currency={currency} />
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
