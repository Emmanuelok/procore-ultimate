/**
 * Report definitions — the builder, the runner and the schedule editor
 * (spec Vol I §6.1, #731-739).
 *
 * The builder is driven entirely by GET /analytics/datasets: fields, operator
 * sets, aggregation sets and enum vocabularies all come from the server's
 * whitelisted registry, so the UI can only compose definitions the executor
 * will accept. The preview runs the REAL executor against live rows — what
 * you see is what the saved report returns, including its truncation.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, fetchBlobUrl } from "../../lib/api";
import {
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
  Spinner,
  Table,
  Td,
  Th,
  Textarea,
} from "../../ui";
import { formatDate, formatDateTime } from "../format";
import {
  AGGREGATION_LABELS,
  CADENCE_LABELS,
  Caveat,
  DeliveryNote,
  OPERATOR_LABELS,
  ResultTable,
  TruncationNotice,
  WEEKDAYS,
  errorMessage,
  fmtNum,
  type AggregationInput,
  type CatalogColumn,
  type CatalogDataset,
  type DatasetsResponse,
  type FilterInput,
  type ListResponse,
  type PreviewResponse,
  type ReportRow,
  type RunResponse,
  type SchedulesResponse,
} from "./analyticsShared";

const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/* ------------------------------ draft shapes ------------------------------ */

interface FilterDraft {
  field: string;
  operator: string;
  /** scalar raw value, or comma-separated list for non-enum `in` */
  value: string;
  /** multi-select values for enum `in` */
  values: string[];
}

interface AggDraft {
  field: string;
  fn: string;
  alias: string;
}

interface BuiltSpec {
  spec?: Record<string, unknown>;
  problem?: string;
}

function needsValue(operator: string): boolean {
  return operator !== "is_null" && operator !== "not_null";
}

function suggestAlias(fn: string, field: string): string {
  const raw = `${fn}_${field}`.replace(/[^A-Za-z0-9_]/g, "_");
  return (/^[A-Za-z]/.test(raw) ? raw : `a_${raw}`).slice(0, 41);
}

function scopeBadge(report: ReportRow, projectId: string) {
  if (report.projectId === projectId) return <Badge tone="blue">This project</Badge>;
  if (report.projectId === null) return <Badge tone="violet">Company-wide</Badge>;
  return <Badge tone="gray">Another project</Badge>;
}

/* ================================== Tab ================================== */

export default function ReportsTab({
  projectId,
  catalog,
  catalogError,
  onReloadCatalog,
}: {
  projectId: string;
  catalog: DatasetsResponse | null;
  catalogError: string | null;
  onReloadCatalog: () => void;
}) {
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListError(null);
    try {
      const res = await api.get<ListResponse<ReportRow>>("/api/v1/analytics/reports?pageSize=100");
      setReports(res.items);
      setTotal(res.total);
    } catch (err) {
      setReports((prev) => prev ?? []);
      setListError(errorMessage(err, "Failed to load report definitions"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  type View = { kind: "list" } | { kind: "build"; report: ReportRow | null } | { kind: "run"; report: ReportRow };
  const [view, setView] = useState<View>({ kind: "list" });
  const [scheduleReport, setScheduleReport] = useState<ReportRow | null>(null);

  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onDelete(report: ReportRow) {
    if (!window.confirm(`Delete report "${report.name}"? Its schedules are removed too.`)) return;
    setActionError(null);
    setRowBusy(report.id);
    try {
      await api.del(`/api/v1/analytics/reports/${report.id}`);
      await load();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to delete the report"));
    } finally {
      setRowBusy(null);
    }
  }

  async function onToggleShare(report: ReportRow) {
    setActionError(null);
    setRowBusy(report.id);
    try {
      await api.patch(`/api/v1/analytics/reports/${report.id}`, { isShared: !report.isShared });
      await load();
    } catch (err) {
      setActionError(errorMessage(err, "Failed to change sharing"));
    } finally {
      setRowBusy(null);
    }
  }

  async function onExport(report: ReportRow) {
    setActionError(null);
    setRowBusy(report.id);
    try {
      const url = await fetchBlobUrl(
        `/api/v1/analytics/reports/${report.id}/export.csv?projectId=${encodeURIComponent(projectId)}`,
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${report.name.replace(/[^\w-]+/g, "-").toLowerCase() || "report"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(errorMessage(err, "CSV export failed"));
    } finally {
      setRowBusy(null);
    }
  }

  if (view.kind === "build") {
    return (
      <ReportBuilder
        projectId={projectId}
        catalog={catalog}
        catalogError={catalogError}
        onReloadCatalog={onReloadCatalog}
        report={view.report}
        onClose={(saved) => {
          setView({ kind: "list" });
          if (saved) void load();
        }}
      />
    );
  }

  if (view.kind === "run") {
    return (
      <RunView
        projectId={projectId}
        report={view.report}
        onBack={() => setView({ kind: "list" })}
        onExport={() => void onExport(view.report)}
        exporting={rowBusy === view.report.id}
      />
    );
  }

  if (reports === null) return <Spinner label="Loading report definitions…" />;

  return (
    <div>
      <ErrorAlert message={listError} />
      <ErrorAlert message={actionError} />

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-ink-400">
          {total} saved {total === 1 ? "definition" : "definitions"} — yours plus any shared with
          the company. Reports read only the projects you can otherwise open.
        </p>
        <Button onClick={() => setView({ kind: "build", report: null })}>New report</Button>
      </div>

      {reports.length === 0 ? (
        <EmptyState
          title="No report definitions yet"
          hint="Build a report over any registered dataset — RFIs, punch items, claims, signals and more — or seed the default role dashboards from the Dashboards tab."
          action={<Button onClick={() => setView({ kind: "build", report: null })}>New report</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Report</Th>
              <Th>Dataset</Th>
              <Th>Scope</Th>
              <Th>Sharing</Th>
              <Th>Updated</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {reports.map((r) => (
              <tr key={r.id} className="hover:bg-ink-50">
                <Td>
                  <div className="font-medium text-ink-900">{r.name}</div>
                  {r.description ? (
                    <div className="max-w-md truncate text-xs text-ink-400" title={r.description}>
                      {r.description}
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone="gray">{r.dataset}</Badge>
                </Td>
                <Td>{scopeBadge(r, projectId)}</Td>
                <Td>
                  <button
                    type="button"
                    className="cursor-pointer"
                    title={
                      r.isShared
                        ? "Shared — everyone in the company can see and run it. Click to make it private."
                        : "Private — only you and company admins. Click to share."
                    }
                    disabled={rowBusy === r.id}
                    onClick={() => void onToggleShare(r)}
                  >
                    {r.isShared ? <Badge tone="green">Shared</Badge> : <Badge tone="gray">Private</Badge>}
                  </button>
                </Td>
                <Td className="whitespace-nowrap text-xs text-ink-500">{formatDate(r.updatedAt)}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="secondary" onClick={() => setView({ kind: "run", report: r })}>
                      Run
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setView({ kind: "build", report: r })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setScheduleReport(r)}>
                      Schedules
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rowBusy === r.id}
                      onClick={() => void onExport(r)}
                    >
                      CSV
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600"
                      disabled={rowBusy === r.id}
                      onClick={() => void onDelete(r)}
                    >
                      Delete
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {reports.length < total ? (
        <p className="mt-2 text-xs text-ink-400">
          Showing the {reports.length} most recently updated of {total} definitions.
        </p>
      ) : null}

      {scheduleReport ? (
        <SchedulesModal report={scheduleReport} onClose={() => setScheduleReport(null)} />
      ) : null}
    </div>
  );
}

/* ================================ Builder ================================ */

function ReportBuilder({
  projectId,
  catalog,
  catalogError,
  onReloadCatalog,
  report,
  onClose,
}: {
  projectId: string;
  catalog: DatasetsResponse | null;
  catalogError: string | null;
  onReloadCatalog: () => void;
  report: ReportRow | null;
  onClose: (saved: boolean) => void;
}) {
  const [name, setName] = useState(report?.name ?? "");
  const [description, setDescription] = useState(report?.description ?? "");
  const [isShared, setIsShared] = useState(report?.isShared ?? false);
  const [scope, setScope] = useState<"project" | "company">(
    report ? (report.projectId ? "project" : "company") : "project",
  );
  const [dataset, setDataset] = useState(report?.dataset ?? "");
  const [columns, setColumns] = useState<string[]>(report?.columns ?? []);
  const [filters, setFilters] = useState<FilterDraft[]>(() =>
    (report?.filters ?? []).map((f) => hydrateFilter(f)),
  );
  const [groupBy, setGroupBy] = useState(report?.groupBy ?? "");
  const [aggs, setAggs] = useState<AggDraft[]>(
    (report?.aggregations ?? []).map((a) => ({ field: a.field, fn: a.fn, alias: a.alias })),
  );
  const [sortBy, setSortBy] = useState(report?.sortBy ?? "");
  const [sortDir, setSortDir] = useState(report?.sortDir === "asc" ? "asc" : "desc");
  const [limitRows, setLimitRows] = useState(String(report?.limitRows ?? 500));

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const ds: CatalogDataset | null = useMemo(
    () => catalog?.datasets.find((d) => d.key === dataset) ?? null,
    [catalog, dataset],
  );
  const colByKey = useMemo(() => {
    const m = new Map<string, CatalogColumn>();
    for (const c of ds?.columns ?? []) m.set(c.key, c);
    return m;
  }, [ds]);
  const maxLimit = catalog?.limits.maxLimitRows ?? 5000;
  const isAggregate = aggs.length > 0;

  function hydrateFilter(f: FilterInput): FilterDraft {
    if (Array.isArray(f.value)) {
      return {
        field: f.field,
        operator: f.operator,
        value: f.value.map((v) => String(v)).join(", "),
        values: f.value.map((v) => String(v)),
      };
    }
    return {
      field: f.field,
      operator: f.operator,
      value: f.value === null || f.value === undefined ? "" : String(f.value),
      values: [],
    };
  }

  function selectDataset(key: string) {
    setDataset(key);
    const next = catalog?.datasets.find((d) => d.key === key);
    // a new dataset invalidates every field reference — reset, don't guess
    setColumns(next ? next.columns.slice(0, 5).map((c) => c.key) : []);
    setFilters([]);
    setGroupBy("");
    setAggs([]);
    setSortBy("");
  }

  function toggleColumn(key: string) {
    setColumns((prev) => (prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key]));
  }

  /* ------------------------------ spec assembly ---------------------------- */

  const built: BuiltSpec = useMemo(() => {
    if (!catalog) return { problem: "The dataset registry has not loaded." };
    if (!ds) return { problem: "Pick a dataset to report over." };
    if (columns.length === 0) return { problem: "Select at least one column." };

    const specFilters: FilterInput[] = [];
    for (let i = 0; i < filters.length; i += 1) {
      const f = filters[i]!;
      const col = colByKey.get(f.field);
      if (!col) return { problem: `Filter ${i + 1}: pick a field.` };
      if (!needsValue(f.operator)) {
        specFilters.push({ field: f.field, operator: f.operator });
        continue;
      }
      if (f.operator === "in") {
        const list =
          col.type === "enum" && col.enumValues
            ? f.values
            : f.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        if (list.length === 0) {
          return { problem: `Filter ${i + 1} (“${col.label}”): choose at least one value.` };
        }
        const coerced =
          col.type === "number"
            ? list.map(Number)
            : list;
        if (col.type === "number" && coerced.some((n) => !Number.isFinite(n as number))) {
          return { problem: `Filter ${i + 1} (“${col.label}”): every value must be a number.` };
        }
        specFilters.push({ field: f.field, operator: "in", value: coerced });
        continue;
      }
      if (f.value.trim() === "" && f.operator !== "contains") {
        return { problem: `Filter ${i + 1} (“${col.label}”): enter a value.` };
      }
      let v: unknown = f.value.trim();
      if (col.type === "number") {
        v = Number(f.value);
        if (!Number.isFinite(v as number)) {
          return { problem: `Filter ${i + 1} (“${col.label}”): the value must be a number.` };
        }
      }
      specFilters.push({ field: f.field, operator: f.operator, value: v });
    }

    const specAggs: AggregationInput[] = [];
    const aliases = new Set<string>();
    for (let i = 0; i < aggs.length; i += 1) {
      const a = aggs[i]!;
      const col = colByKey.get(a.field);
      if (!col) return { problem: `Aggregation ${i + 1}: pick a field.` };
      if (!ALIAS_RE.test(a.alias)) {
        return {
          problem: `Aggregation ${i + 1}: the alias must start with a letter and use only letters, digits and underscores.`,
        };
      }
      if (aliases.has(a.alias)) return { problem: `Duplicate aggregation alias “${a.alias}”.` };
      if (groupBy && a.alias === groupBy) {
        return { problem: `Aggregation alias “${a.alias}” collides with the group-by column.` };
      }
      aliases.add(a.alias);
      specAggs.push({ field: a.field, fn: a.fn, alias: a.alias });
    }

    if (groupBy && specAggs.length === 0) {
      return { problem: "Grouping needs at least one aggregation — add one, or clear the group." };
    }

    let effectiveSort: string | null = sortBy || null;
    if (effectiveSort) {
      if (isAggregate) {
        const ok = aliases.has(effectiveSort) || (groupBy !== "" && effectiveSort === groupBy);
        if (!ok) effectiveSort = null;
      } else if (!colByKey.has(effectiveSort)) {
        effectiveSort = null;
      }
    }

    const limit = Math.trunc(Number(limitRows));
    if (!Number.isFinite(limit) || limit < 1 || limit > maxLimit) {
      return { problem: `Row limit must be between 1 and ${fmtNum(maxLimit, 0)}.` };
    }

    return {
      spec: {
        // editing never silently rebinds a report from another project
        projectId: scope === "project" ? (report?.projectId ?? projectId) : null,
        dataset: ds.key,
        columns,
        filters: specFilters,
        groupBy: groupBy || null,
        aggregations: specAggs,
        sortBy: effectiveSort,
        sortDir,
        limitRows: limit,
      },
    };
  }, [catalog, ds, columns, filters, colByKey, groupBy, aggs, sortBy, sortDir, limitRows, maxLimit, scope, projectId, isAggregate, report]);

  /* ------------------------------ live preview ----------------------------- */

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewSeq = useRef(0);

  const specJson = built.spec ? JSON.stringify(built.spec) : null;

  useEffect(() => {
    const seq = previewSeq.current + 1;
    previewSeq.current = seq;
    if (!specJson) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.post<PreviewResponse>(
          "/api/v1/analytics/reports/preview?pageSize=25",
          JSON.parse(specJson),
        );
        if (previewSeq.current === seq) {
          setPreview(res);
          setPreviewError(null);
        }
      } catch (err) {
        if (previewSeq.current === seq) {
          setPreview(null);
          setPreviewError(errorMessage(err, "Preview failed"));
        }
      } finally {
        if (previewSeq.current === seq) setPreviewing(false);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [specJson]);

  /* --------------------------------- save ---------------------------------- */

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!built.spec) {
      setSaveError(built.problem ?? "The definition is incomplete.");
      return;
    }
    if (!name.trim()) {
      setSaveError("Give the report a name.");
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      const payload = {
        ...built.spec,
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        isShared,
      };
      if (report) {
        await api.patch(`/api/v1/analytics/reports/${report.id}`, payload);
      } else {
        await api.post("/api/v1/analytics/reports", payload);
      }
      onClose(true);
    } catch (err) {
      setSaveError(errorMessage(err, "Failed to save the report"));
    } finally {
      setSaving(false);
    }
  }

  /* -------------------------------- render --------------------------------- */

  if (catalogError) {
    return (
      <div>
        <ErrorAlert message={catalogError} />
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => onClose(false)}>
            Back
          </Button>
          <Button onClick={onReloadCatalog}>Retry loading datasets</Button>
        </div>
      </div>
    );
  }
  if (!catalog) return <Spinner label="Loading the dataset registry…" />;

  const sortOptions: { key: string; label: string }[] = isAggregate
    ? [
        ...(groupBy ? [{ key: groupBy, label: colByKey.get(groupBy)?.label ?? groupBy }] : []),
        ...aggs.filter((a) => ALIAS_RE.test(a.alias)).map((a) => ({ key: a.alias, label: a.alias })),
      ]
    : (ds?.columns ?? []).map((c) => ({ key: c.key, label: c.label }));

  return (
    <form onSubmit={onSave}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <Button variant="secondary" onClick={() => onClose(false)}>
          ← Back to reports
        </Button>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-ink-600">
            <input
              type="checkbox"
              checked={isShared}
              onChange={(e) => setIsShared(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            Shared with the company
          </label>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : report ? "Save changes" : "Save report"}
          </Button>
        </div>
      </div>

      <ErrorAlert message={saveError} />

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ------------------------------ definition ---------------------------- */}
        <div className="space-y-4">
          <Card>
            <CardBody className="space-y-3">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
              </Field>
              <Field label="Description (optional)">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-h-16"
                  maxLength={5000}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Dataset"
                  hint={ds?.description}
                >
                  <Select value={dataset} onChange={(e) => selectDataset(e.target.value)} required>
                    <option value="">— pick a dataset —</option>
                    {catalog.datasets.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Scope"
                  hint={
                    scope === "project"
                      ? report && report.projectId && report.projectId !== projectId
                        ? "rows from the project this report is bound to (not this one)"
                        : "rows from this project only"
                      : "rows from every project you can open — never wider"
                  }
                >
                  <Select
                    value={scope}
                    onChange={(e) => setScope(e.target.value as "project" | "company")}
                  >
                    <option value="project">This project</option>
                    <option value="company">Company-wide</option>
                  </Select>
                </Field>
              </div>
            </CardBody>
          </Card>

          {ds ? (
            <>
              <Card>
                <CardBody>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">
                    Columns
                    {isAggregate ? (
                      <span className="ml-2 normal-case font-normal text-amber-700">
                        (grouped output shows the group and its aggregates instead)
                      </span>
                    ) : null}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {ds.columns.map((c) => (
                      <label key={c.key} className="flex items-center gap-1.5 text-sm text-ink-700">
                        <input
                          type="checkbox"
                          checked={columns.includes(c.key)}
                          onChange={() => toggleColumn(c.key)}
                          className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Filters</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const first = ds.columns.find((c) => c.filterable);
                        if (!first) return;
                        setFilters((prev) => [
                          ...prev,
                          { field: first.key, operator: first.operators[0] ?? "eq", value: "", values: [] },
                        ]);
                      }}
                    >
                      Add filter
                    </Button>
                  </div>
                  {filters.length === 0 ? (
                    <p className="text-xs text-ink-400">No filters — every row in scope.</p>
                  ) : (
                    <div className="space-y-2">
                      {filters.map((f, i) => (
                        <FilterRow
                          key={i}
                          draft={f}
                          dataset={ds}
                          onChange={(next) =>
                            setFilters((prev) => prev.map((p, j) => (j === i ? next : p)))
                          }
                          onRemove={() => setFilters((prev) => prev.filter((_, j) => j !== i))}
                        />
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardBody>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                      Group &amp; aggregate
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const first = ds.columns[0];
                        if (!first) return;
                        const fn = first.aggregations[0] ?? "count";
                        setAggs((prev) => [
                          ...prev,
                          { field: first.key, fn, alias: suggestAlias(fn, first.key) },
                        ]);
                      }}
                    >
                      Add aggregation
                    </Button>
                  </div>
                  <Field
                    label="Group by"
                    hint={groupBy && aggs.length === 0 ? "grouping needs at least one aggregation" : undefined}
                  >
                    <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                      <option value="">— no grouping —</option>
                      {ds.columns
                        .filter((c) => c.groupable)
                        .map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  {aggs.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      {aggs.map((a, i) => (
                        <AggRow
                          key={i}
                          draft={a}
                          dataset={ds}
                          onChange={(next) => setAggs((prev) => prev.map((p, j) => (j === i ? next : p)))}
                          onRemove={() => setAggs((prev) => prev.filter((_, j) => j !== i))}
                        />
                      ))}
                    </div>
                  ) : null}
                </CardBody>
              </Card>

              <Card>
                <CardBody className="grid grid-cols-3 gap-3">
                  <Field label="Sort by">
                    <Select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                      <option value="">
                        {isAggregate ? "— unsorted —" : `default (${ds.defaultSort})`}
                      </option>
                      {sortOptions.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Direction">
                    <Select value={sortDir} onChange={(e) => setSortDir(e.target.value)}>
                      <option value="desc">Descending</option>
                      <option value="asc">Ascending</option>
                    </Select>
                  </Field>
                  <Field label="Row limit" hint={`1 – ${fmtNum(maxLimit, 0)}`}>
                    <Input
                      type="number"
                      min={1}
                      max={maxLimit}
                      value={limitRows}
                      onChange={(e) => setLimitRows(e.target.value)}
                    />
                  </Field>
                </CardBody>
              </Card>
            </>
          ) : null}
        </div>

        {/* ------------------------------- preview ------------------------------ */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
              Live preview <span className="normal-case font-normal">(first 25 rows)</span>
            </p>
            {previewing ? <span className="text-xs text-ink-400">running…</span> : null}
          </div>
          {built.problem ? (
            <Caveat>{built.problem}</Caveat>
          ) : previewError ? (
            <ErrorAlert message={previewError} />
          ) : preview ? (
            <>
              <p className="text-xs text-ink-400">
                {preview.rowCount} {preview.rowCount === 1 ? "row" : "rows"} in{" "}
                {fmtNum(preview.ms, 0)} ms · executed {formatDateTime(preview.executedAt)} · live
                data, not saved
              </p>
              <TruncationNotice result={preview} />
              {preview.rowCount === 0 ? (
                <EmptyState title="No rows match" hint="The definition is valid — nothing in scope satisfies its filters." />
              ) : (
                <ResultTable result={preview} />
              )}
            </>
          ) : (
            <Spinner label="Running preview…" />
          )}
        </div>
      </div>
    </form>
  );
}

/* ------------------------------- filter row ------------------------------- */

function FilterRow({
  draft,
  dataset,
  onChange,
  onRemove,
}: {
  draft: FilterDraft;
  dataset: CatalogDataset;
  onChange: (next: FilterDraft) => void;
  onRemove: () => void;
}) {
  const col = dataset.columns.find((c) => c.key === draft.field) ?? null;

  function selectField(key: string) {
    const next = dataset.columns.find((c) => c.key === key);
    onChange({
      field: key,
      operator: next?.operators[0] ?? "eq",
      value: "",
      values: [],
    });
  }

  function selectOperator(op: string) {
    onChange({ ...draft, operator: op, value: "", values: [] });
  }

  const valueEditor = (() => {
    if (!col || !needsValue(draft.operator)) return null;
    if (col.type === "enum" && col.enumValues) {
      if (draft.operator === "in") {
        return (
          <select
            multiple
            size={Math.min(4, col.enumValues.length)}
            value={draft.values}
            onChange={(e) =>
              onChange({
                ...draft,
                values: Array.from(e.target.selectedOptions).map((o) => o.value),
              })
            }
            className="block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm ring-1 ring-inset ring-ink-200 focus:ring-2 focus:ring-inset focus:ring-brand-500"
          >
            {col.enumValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        );
      }
      return (
        <Select value={draft.value} onChange={(e) => onChange({ ...draft, value: e.target.value })}>
          <option value="">— choose —</option>
          {col.enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      );
    }
    if (col.type === "date" && draft.operator !== "in") {
      return (
        <Input
          type="date"
          value={draft.value}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
        />
      );
    }
    return (
      <Input
        type={col.type === "number" && draft.operator !== "in" ? "number" : "text"}
        placeholder={draft.operator === "in" ? "comma-separated values" : undefined}
        value={draft.value}
        onChange={(e) => onChange({ ...draft, value: e.target.value })}
      />
    );
  })();

  return (
    <div className="flex items-start gap-2">
      <div className="w-40 shrink-0">
        <Select value={draft.field} onChange={(e) => selectField(e.target.value)}>
          {dataset.columns
            .filter((c) => c.filterable)
            .map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
        </Select>
      </div>
      <div className="w-36 shrink-0">
        <Select value={draft.operator} onChange={(e) => selectOperator(e.target.value)}>
          {(col?.operators ?? []).map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABELS[op] ?? op}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-0 flex-1">{valueEditor}</div>
      <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Remove filter">
        ✕
      </Button>
    </div>
  );
}

/* ---------------------------- aggregation row ----------------------------- */

function AggRow({
  draft,
  dataset,
  onChange,
  onRemove,
}: {
  draft: AggDraft;
  dataset: CatalogDataset;
  onChange: (next: AggDraft) => void;
  onRemove: () => void;
}) {
  const col = dataset.columns.find((c) => c.key === draft.field) ?? null;

  return (
    <div className="flex items-start gap-2">
      <div className="w-40 shrink-0">
        <Select
          value={draft.field}
          onChange={(e) => {
            const key = e.target.value;
            const next = dataset.columns.find((c) => c.key === key);
            const fn = next?.aggregations.includes(draft.fn) ? draft.fn : (next?.aggregations[0] ?? "count");
            onChange({ field: key, fn, alias: suggestAlias(fn, key) });
          }}
        >
          {dataset.columns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-32 shrink-0">
        <Select
          value={draft.fn}
          onChange={(e) =>
            onChange({ ...draft, fn: e.target.value, alias: suggestAlias(e.target.value, draft.field) })
          }
        >
          {(col?.aggregations ?? ["count"]).map((fn) => (
            <option key={fn} value={fn}>
              {AGGREGATION_LABELS[fn] ?? fn}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-0 flex-1">
        <Input
          value={draft.alias}
          onChange={(e) => onChange({ ...draft, alias: e.target.value })}
          placeholder="alias (column name in the output)"
        />
      </div>
      <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Remove aggregation">
        ✕
      </Button>
    </div>
  );
}

/* ================================ Run view =============================== */

function RunView({
  projectId,
  report,
  onBack,
  onExport,
  exporting,
}: {
  projectId: string;
  report: ReportRow;
  onBack: () => void;
  onExport: () => void;
  exporting: boolean;
}) {
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(
    async (p: number) => {
      setRunning(true);
      setError(null);
      try {
        const res = await api.post<RunResponse>(
          `/api/v1/analytics/reports/${report.id}/run?page=${p}&pageSize=${PAGE_SIZE}&projectId=${encodeURIComponent(projectId)}`,
        );
        setResult(res);
      } catch (err) {
        setResult(null);
        setError(errorMessage(err, "The run failed"));
      } finally {
        setRunning(false);
      }
    },
    [report.id, projectId],
  );

  useEffect(() => {
    void run(page);
  }, [run, page]);

  const offsetEnd = result ? result.offset + result.rowCount : 0;
  const hasNext = result !== null && result.truncated && offsetEnd < result.limitRows;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={onBack}>
            ← Back to reports
          </Button>
          <div>
            <h2 className="text-base font-semibold text-ink-900">{report.name}</h2>
            <p className="text-xs text-ink-400">
              {report.dataset} ·{" "}
              {result?.report.projectId
                ? result.report.projectId === projectId
                  ? "scoped to this project"
                  : `scoped to project ${result.report.projectId}`
                : "company-wide across the projects you can open"}
            </p>
          </div>
        </div>
        <Button variant="secondary" onClick={onExport} disabled={exporting}>
          {exporting ? "Exporting…" : "Export CSV"}
        </Button>
      </div>

      <ErrorAlert message={error} />

      {running && !result ? <Spinner label="Running the report…" /> : null}

      {result ? (
        <div className="space-y-3">
          <p className="text-xs text-ink-400">
            Rows {result.rowCount === 0 ? 0 : result.offset + 1}–{offsetEnd} · executed{" "}
            {formatDateTime(result.executedAt)} in {fmtNum(result.ms, 0)} ms
          </p>
          <TruncationNotice result={result} />
          {result.rowCount === 0 && result.offset === 0 ? (
            <EmptyState title="No rows match" hint="The definition ran, and nothing in scope satisfies its filters." />
          ) : (
            <ResultTable result={result} />
          )}
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-400">Page {page}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1 || running}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!hasNext || running}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ============================ Schedules modal ============================ */

function SchedulesModal({ report, onClose }: { report: ReportRow; onClose: () => void }) {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<SchedulesResponse>(
        `/api/v1/analytics/reports/${report.id}/schedules`,
      );
      setData(res);
    } catch (err) {
      setError(errorMessage(err, "Failed to load schedules"));
    }
  }, [report.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const [cadence, setCadence] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [dayOfPeriod, setDayOfPeriod] = useState("1");
  const [recipients, setRecipients] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const list = recipients
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) {
      setFormError("Enter at least one recipient email.");
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { cadence, recipients: list };
      if (cadence !== "daily") payload["dayOfPeriod"] = Number(dayOfPeriod);
      await api.post(`/api/v1/analytics/reports/${report.id}/schedules`, payload);
      setRecipients("");
      await load();
    } catch (err) {
      setFormError(errorMessage(err, "Failed to record the schedule"));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(scheduleId: string) {
    if (!window.confirm("Remove this schedule?")) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/analytics/reports/${report.id}/schedules/${scheduleId}`);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to remove the schedule"));
    } finally {
      setBusy(false);
    }
  }

  function describeSchedule(s: { cadence: string; dayOfPeriod: number | null }): string {
    if (s.cadence === "daily") return "Daily at 06:00 UTC";
    if (s.cadence === "weekly") {
      return `Weekly on ${WEEKDAYS[(s.dayOfPeriod ?? 1) % 7]} at 06:00 UTC`;
    }
    return `Monthly on day ${s.dayOfPeriod ?? 1} at 06:00 UTC`;
  }

  return (
    <Modal open title={`Schedules — ${report.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <ErrorAlert message={error} />
        {data ? <DeliveryNote delivery={data.delivery} /> : null}

        {data === null && !error ? (
          <Spinner label="Loading schedules…" />
        ) : data && data.items.length === 0 ? (
          <p className="text-sm text-ink-400">No schedules recorded for this report.</p>
        ) : data ? (
          <Table>
            <thead>
              <tr>
                <Th>Cadence</Th>
                <Th>Recipients</Th>
                <Th>Next run (computed)</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.items.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <Badge tone="blue">{CADENCE_LABELS[s.cadence] ?? s.cadence}</Badge>
                    <div className="mt-0.5 text-xs text-ink-400">{describeSchedule(s)}</div>
                  </Td>
                  <Td className="text-xs">{s.recipients.join(", ")}</Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500" title="Maintained for when a delivery worker exists — nothing is sent when it passes.">
                    {formatDateTime(s.nextRunAt)}
                  </Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600"
                      disabled={busy}
                      onClick={() => void onDelete(s.id)}
                    >
                      Remove
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}

        <form onSubmit={onCreate} className="rounded-lg bg-ink-50 p-3">
          <p className="mb-2 text-xs font-medium text-ink-600">Record a schedule</p>
          <ErrorAlert message={formError} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cadence">
              <Select
                value={cadence}
                onChange={(e) => {
                  const c = e.target.value as "daily" | "weekly" | "monthly";
                  setCadence(c);
                  setDayOfPeriod("1");
                }}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </Field>
            {cadence === "weekly" ? (
              <Field label="Day of week">
                <Select value={dayOfPeriod} onChange={(e) => setDayOfPeriod(e.target.value)}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={String(i)}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : cadence === "monthly" ? (
              <Field label="Day of month" hint="1 – 28, so every month has one">
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={dayOfPeriod}
                  onChange={(e) => setDayOfPeriod(e.target.value)}
                />
              </Field>
            ) : (
              <div />
            )}
          </div>
          <div className="mt-3">
            <Field label="Recipients" hint="email addresses, separated by commas or new lines">
              <Textarea
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                className="min-h-16"
                placeholder="pm@example.com, commercial@example.com"
              />
            </Field>
          </div>
          <div className="mt-2 flex justify-end">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Recording…" : "Record schedule"}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
