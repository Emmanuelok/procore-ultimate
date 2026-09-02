/**
 * ESTIMATES — the register and the workspace behind it.
 *
 * The register lists every version chain; opening one gives the priced grid,
 * the markup cascade with each tier's base stated, the version history, a
 * comparison against any other version, the conversion into a budget (with a
 * dry run that writes nothing) and proposal generation.
 *
 * Every write returns the estimate's new totals, so the header never lags the
 * grid, and every priced line carries the arithmetic that produced it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  DataTable,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconEdit, IconPlus, IconRefresh, IconTrash, IconVersion } from "../../ui/icons";
import {
  BasisList,
  COST_TYPES,
  DASH,
  ESTIMATE_STATUS_TONE,
  ESTIMATE_TYPES,
  LINE_STATUS_TONE,
  LoadError,
  MARKUP_BASIS_LABEL,
  MARKUP_KINDS,
  StatusPill,
  count,
  dateOnly,
  dateTime,
  estimatingApi,
  money,
  money0,
  num,
  titleCase,
  todayIso,
  useAction,
  useResource,
  type Assembly,
  type CatalogueItem,
  type Comparison,
  type ConversionPreview,
  type ConversionResult,
  type Estimate,
  type EstimateDetail,
  type EstimateLine,
  type Paginated,
  type TakeoffItem,
} from "./estimatingShared";

type WorkspaceTab = "grid" | "markups" | "versions" | "convert";

export default function EstimatesTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [headsOnly, setHeadsOnly] = useState(true);
  const action = useAction();

  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (headsOnly) params.set("headsOnly", "true");
  const list = useResource<Paginated<Estimate>>(
    `/api/v1/projects/${projectId}/estimates?${params.toString()}`,
  );

  const columns = useMemo<DataColumns<Estimate>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", width: 110, mono: true },
      { id: "name", header: "Estimate", accessor: "name", type: "text", width: 300 },
      {
        id: "version",
        header: "Rev",
        accessor: "version",
        type: "number",
        align: "right",
        width: 70,
      },
      {
        id: "estimateType",
        header: "Maturity",
        accessor: (row) => titleCase(row.estimateType),
        type: "text",
        width: 170,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 130,
        cell: ({ row }) => <StatusPill status={row.status} map={ESTIMATE_STATUS_TONE} />,
      },
      {
        id: "lineCount",
        header: "Lines",
        accessor: "lineCount",
        type: "number",
        align: "right",
        width: 80,
      },
      {
        id: "directCostTotal",
        header: "Direct cost",
        accessor: "directCostTotal",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => money0(row.directCostTotal, row.currency),
      },
      {
        id: "total",
        header: "Total",
        accessor: "total",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => <span className="font-semibold">{money0(row.total, row.currency)}</span>,
      },
      {
        id: "updatedAt",
        header: "Updated",
        accessor: "updatedAt",
        type: "datetime",
        width: 160,
        cell: ({ row }) => dateTime(row.updatedAt),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Estimate register"
          subtitle="One row per version. A chain has exactly one live head; cutting a version supersedes its parent and keeps both."
          actions={
            <div className="flex items-center gap-3">
              <Checkbox
                checked={headsOnly}
                onChange={(e) => setHeadsOnly(e.target.checked)}
                label="Live heads only"
                size="sm"
              />
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                New estimate
              </Button>
            </div>
          }
        />
        <CardBody flush>
          {action.error ? (
            <div className="p-3">
              <Alert tone="danger" size="sm">
                {action.error}
              </Alert>
            </div>
          ) : null}
          {list.error ? (
            <div className="p-4">
              <LoadError message={list.error} onRetry={list.reload} />
            </div>
          ) : (
            <DataTable<Estimate>
              tableId="estimating.estimates"
              data={list.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={list.loading && !list.data}
              height={420}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "No estimate on this project yet",
                description:
                  "An estimate is where a project first acquires a number. Create one, measure the work on the Takeoff tab, and price it from the rate library.",
              }}
              onRowClick={({ row }) => setOpenId(row.id)}
              aria-label="Estimates"
            />
          )}
        </CardBody>
      </Card>

      <CreateEstimateModal
        open={creating}
        projectId={projectId}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          list.reload();
          onChanged();
          setOpenId(id);
        }}
      />

      <EstimateWorkspace
        projectId={projectId}
        estimateId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
        onOpenOther={(id) => setOpenId(id)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreateEstimateModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [estimateType, setEstimateType] = useState("conceptual");
  const [basis, setBasis] = useState("");
  const [accuracy, setAccuracy] = useState("");
  const [quantityBasis, setQuantityBasis] = useState("");
  const [quantityBasisUnit, setQuantityBasisUnit] = useState("m2");
  const action = useAction();

  useEffect(() => {
    if (open) {
      setName("");
      setEstimateType("conceptual");
      setBasis("");
      setAccuracy("");
      setQuantityBasis("");
    }
  }, [open]);

  async function submit() {
    const res = await action.run("create", () =>
      estimatingApi.createEstimate(projectId, {
        name,
        estimateType,
        basis: basis.trim().length > 0 ? basis : null,
        accuracyRange: accuracy.trim().length > 0 ? Number(accuracy) / 100 : null,
        quantityBasis: quantityBasis.trim().length > 0 ? Number(quantityBasis) : null,
        quantityBasisUnit: quantityBasis.trim().length > 0 ? quantityBasisUnit : null,
      }),
    );
    if (res) {
      toast.success(`${res.reference} created`);
      onCreated(res.id);
    }
  }

  return (
    <Modal
      open={open}
      title="New estimate"
      description="The maturity you declare bounds the accuracy anybody may claim from it."
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={action.busy === "create"} disabled={name.trim().length === 0}>
            Create
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Substructure GMP" />
        </Field>
        <Field label="Design maturity" hint="Conceptual estimates are not construction-document estimates; say which this is.">
          <Select value={estimateType} onChange={(e) => setEstimateType(e.target.value)}>
            {ESTIMATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Basis" hint="What the price rests on, in your own words. This is what a reviewer reads first.">
          <Textarea value={basis} onChange={(e) => setBasis(e.target.value)} rows={3} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Accuracy claimed (± %)" optional>
            <Input value={accuracy} onChange={(e) => setAccuracy(e.target.value)} inputMode="decimal" placeholder="15" />
          </Field>
          <Field label="Quantity basis" optional hint="e.g. gross floor area, so a £/m² comparison is possible at all">
            <div className="flex gap-2">
              <Input
                value={quantityBasis}
                onChange={(e) => setQuantityBasis(e.target.value)}
                inputMode="decimal"
                placeholder="4200"
              />
              <Input
                value={quantityBasisUnit}
                onChange={(e) => setQuantityBasisUnit(e.target.value)}
                className="w-24"
              />
            </div>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

function EstimateWorkspace({
  projectId,
  estimateId,
  onClose,
  onChanged,
  onOpenOther,
}: {
  projectId: string;
  estimateId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenOther: (id: string) => void;
}) {
  const [tab, setTab] = useState<WorkspaceTab>("grid");
  const action = useAction();
  const estimate = useResource<EstimateDetail>(
    estimateId ? `/api/v1/projects/${projectId}/estimates/${estimateId}` : null,
  );
  const lines = useResource<Paginated<EstimateLine>>(
    estimateId ? `/api/v1/projects/${projectId}/estimates/${estimateId}/lines?page=1&pageSize=500` : null,
  );

  const reload = useCallback(() => {
    estimate.reload();
    lines.reload();
    onChanged();
  }, [estimate, lines, onChanged]);

  useEffect(() => {
    setTab("grid");
  }, [estimateId]);

  const e = estimate.data;
  const editable = e !== null && e.lockedAt === null && (e.status === "draft" || e.status === "in_review");

  async function transition(name: string, body?: unknown) {
    const res = await action.run(name, () => estimatingApi.transition(projectId, estimateId!, name, body));
    if (res) {
      toast.success(`${res.reference} is now ${titleCase(res.status).toLowerCase()}`);
      reload();
    }
  }

  return (
    <Drawer
      open={estimateId !== null}
      onClose={onClose}
      size="xl"
      title={e ? `${e.reference} rev ${e.version} — ${e.name}` : "Estimate"}
      description={
        e ? (
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={e.status} map={ESTIMATE_STATUS_TONE} />
            <span className="text-2xs text-content-subtle">
              {titleCase(e.estimateType)} · {e.currency} · {count(e.lineCount)} lines
              {e.accuracyRange !== null ? ` · claimed ±${(e.accuracyRange * 100).toFixed(0)}%` : ""}
              {e.lockedAt ? " · locked" : ""}
            </span>
          </span>
        ) : undefined
      }
      headerActions={
        e ? (
          <div className="flex flex-wrap items-center gap-2">
            {e.status === "draft" ? (
              <Button size="sm" variant="secondary" onClick={() => void transition("submit")} loading={action.busy === "submit"}>
                Submit for review
              </Button>
            ) : null}
            {e.status === "in_review" ? (
              <>
                <Button size="sm" onClick={() => void transition("approve")} loading={action.busy === "approve"}>
                  Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void transition("withdraw")} loading={action.busy === "withdraw"}>
                  Withdraw
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              icon={IconVersion}
              onClick={() => void action.run("version", async () => {
                const res = await estimatingApi.newVersion(projectId, e.id, {});
                toast.success(`Rev ${res.version} created`);
                onChanged();
                onOpenOther(res.id);
                return res;
              })}
              loading={action.busy === "version"}
            >
              New version
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={IconRefresh}
              onClick={() => void action.run("recalc", async () => {
                const res = await estimatingApi.recalculate(projectId, e.id);
                reload();
                return res;
              })}
              loading={action.busy === "recalc"}
            >
              Recalculate
            </Button>
          </div>
        ) : undefined
      }
    >
      {estimate.error ? (
        <LoadError message={estimate.error} onRetry={estimate.reload} />
      ) : !e ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}
          {e.status === "approved" && e.approvedBy ? (
            <Alert tone="success" size="sm" title="Approved">
              Approved on {dateOnly(e.approvedAt)} by a second person — an estimator may not approve his own
              number. The estimate is locked; cut a new version to keep working.
            </Alert>
          ) : null}
          {e.convertedBudgetId ? (
            <Alert tone="info" size="sm" title="Converted into a budget">
              This estimate is now the project's plan. Budget id {e.convertedBudgetId}, converted{" "}
              {dateOnly(e.approvedAt)}.
            </Alert>
          ) : null}
          <BasisList warnings={e.warnings} />

          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-meta sm:grid-cols-4">
            <SummaryCell label="Direct cost" value={money(e.directCostTotal, e.currency)} />
            <SummaryCell label="Markups" value={money(e.markupTotal, e.currency)} />
            <SummaryCell label="Total" value={money(e.total, e.currency)} emphasis />
            <SummaryCell
              label="Labour hours"
              value={num(e.labourHours, 1)}
              hint={e.quantityBasis ? `${num(e.total / e.quantityBasis, 2)} ${e.currency}/${e.quantityBasisUnit ?? "unit"}` : undefined}
            />
          </div>

          <Tabs
            items={[
              { value: "grid", label: "Priced grid", count: e.lineCount },
              { value: "markups", label: "Markups", count: e.markups.length },
              { value: "versions", label: "Versions", count: e.versions.length },
              { value: "convert", label: "Convert & propose" },
            ]}
            value={tab}
            onChange={(v) => setTab(v as WorkspaceTab)}
            size="sm"
          />

          {tab === "grid" ? (
            <GridPanel
              projectId={projectId}
              estimate={e}
              lines={lines.data?.items ?? []}
              loading={lines.loading && !lines.data}
              error={lines.error}
              editable={editable}
              onReload={reload}
            />
          ) : null}
          {tab === "markups" ? (
            <MarkupPanel projectId={projectId} estimate={e} editable={editable} onReload={reload} />
          ) : null}
          {tab === "versions" ? (
            <VersionPanel projectId={projectId} estimate={e} onOpenOther={onOpenOther} />
          ) : null}
          {tab === "convert" ? (
            <ConvertPanel projectId={projectId} estimate={e} onReload={reload} />
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

function SummaryCell({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-content-subtle">{label}</div>
      <div className={emphasis ? "text-body font-semibold text-content" : "text-body text-content"}>{value}</div>
      {hint ? <div className="text-2xs text-content-subtle">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Grid                                                                */
/* ------------------------------------------------------------------ */

function GridPanel({
  projectId,
  estimate,
  lines,
  loading,
  error,
  editable,
  onReload,
}: {
  projectId: string;
  estimate: EstimateDetail;
  lines: EstimateLine[];
  loading: boolean;
  error: string | null;
  editable: boolean;
  onReload: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingLine, setEditingLine] = useState<EstimateLine | null>(null);
  const [lastBasis, setLastBasis] = useState<string[] | null>(null);
  const action = useAction();

  const sectionName = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of estimate.sections) map.set(s.id, s.code ? `${s.code} ${s.name}` : s.name);
    return map;
  }, [estimate.sections]);

  const columns = useMemo<DataColumns<EstimateLine>>(
    () => [
      {
        id: "section",
        header: "Section",
        accessor: (row) => (row.sectionId ? (sectionName.get(row.sectionId) ?? "") : ""),
        type: "text",
        width: 150,
        cell: ({ row }) =>
          row.sectionId ? (sectionName.get(row.sectionId) ?? DASH) : <span className="text-content-subtle">{DASH}</span>,
      },
      { id: "description", header: "Description", accessor: "description", type: "text", width: 300 },
      { id: "costCode", header: "Cost code", accessor: (row) => row.costCode ?? "", type: "text", width: 110 },
      {
        id: "costType",
        header: "Type",
        accessor: (row) => titleCase(row.costType),
        type: "text",
        width: 110,
      },
      {
        id: "source",
        header: "Source",
        accessor: "source",
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <Badge tone={row.source === "manual" ? "neutral" : "info"} size="xs">
            {titleCase(row.source)}
          </Badge>
        ),
      },
      {
        id: "quantity",
        header: "Qty",
        accessor: "quantity",
        type: "number",
        align: "right",
        width: 110,
        cell: ({ row }) => (
          <span>
            {num(row.quantity, 3)} {row.unit ?? ""}
          </span>
        ),
      },
      {
        id: "unitRate",
        header: "Rate",
        accessor: "unitRate",
        type: "number",
        align: "right",
        width: 110,
        cell: ({ row }) => num(row.unitRate, 2),
      },
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "number",
        align: "right",
        width: 130,
        cell: ({ row }) => money(row.amount, estimate.currency),
      },
      {
        id: "status",
        header: "In total?",
        accessor: "status",
        type: "text",
        width: 110,
        cell: ({ row }) => <StatusPill status={row.status} map={LINE_STATUS_TONE} />,
      },
      {
        id: "rateAsAt",
        header: "Rate dated",
        accessor: (row) => row.rateAsAt ?? "",
        type: "text",
        width: 120,
        cell: ({ row }) => (row.rateAsAt ? dateOnly(row.rateAsAt) : <span className="text-content-subtle">{DASH}</span>),
      },
    ],
    [estimate.currency, sectionName],
  );

  return (
    <div className="space-y-3">
      {!editable ? (
        <Alert tone="info" size="sm">
          This estimate is {estimate.lockedAt ? "locked" : estimate.status}; its lines can no longer be changed.
          Cut a new version to keep working.
        </Alert>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={IconPlus} onClick={() => setAdding(true)}>
            Add line
          </Button>
          <AssemblyInserter projectId={projectId} estimate={estimate} onDone={onReload} />
          <TakeoffInserter projectId={projectId} estimate={estimate} onDone={onReload} />
          <SectionCreator projectId={projectId} estimate={estimate} onDone={onReload} />
        </div>
      )}

      {action.error ? (
        <Alert tone="danger" size="sm" onDismiss={action.clear}>
          {action.error}
        </Alert>
      ) : null}
      {lastBasis ? <BasisList lines={lastBasis} /> : null}

      {error ? (
        <LoadError message={error} onRetry={onReload} />
      ) : (
        <DataTable<EstimateLine>
          tableId="estimating.lines"
          data={lines}
          columns={columns}
          getRowId={(row) => row.id}
          loading={loading}
          height={380}
          rowHeight={40}
          stickyHeader
          toolbar={false}
          empty={{
            title: "No priced lines yet",
            description:
              "Add a line by hand, expand an assembly, or price a measurement from the Takeoff tab. The grid is the estimate.",
          }}
          onRowClick={({ row }) => setEditingLine(row)}
          rowTone={(row) => (row.status === "excluded" ? "neutral" : undefined)}
          aria-label="Estimate lines"
        />
      )}

      <LineEditor
        projectId={projectId}
        estimate={estimate}
        open={adding || editingLine !== null}
        line={editingLine}
        onClose={() => {
          setAdding(false);
          setEditingLine(null);
        }}
        onSaved={(basis) => {
          setAdding(false);
          setEditingLine(null);
          setLastBasis(basis);
          onReload();
        }}
        onDeleted={() => {
          setEditingLine(null);
          onReload();
        }}
      />
    </div>
  );
}

function SectionCreator({
  projectId,
  estimate,
  onDone,
}: {
  projectId: string;
  estimate: EstimateDetail;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const action = useAction();
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Add section
      </Button>
      <Modal
        open={open}
        title="Add a section"
        description="A heading the grid groups by. Deleting one later never deletes money — its lines are unparented."
        onClose={() => setOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={action.busy === "s"}
              disabled={name.trim().length === 0}
              onClick={() =>
                void action
                  .run("s", () =>
                    estimatingApi.createSection(projectId, estimate.id, {
                      name,
                      code: code.trim().length > 0 ? code : null,
                      sortOrder: estimate.sections.length + 1,
                    }),
                  )
                  .then((res) => {
                    if (res) {
                      setOpen(false);
                      setName("");
                      setCode("");
                      onDone();
                    }
                  })
              }
            >
              Add
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Groundworks" />
          </Field>
          <Field label="Code" optional>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A" />
          </Field>
        </div>
      </Modal>
    </>
  );
}

function AssemblyInserter({
  projectId,
  estimate,
  onDone,
}: {
  projectId: string;
  estimate: EstimateDetail;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [assemblyId, setAssemblyId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [expand, setExpand] = useState(true);
  const action = useAction();
  const assemblies = useResource<Paginated<Assembly>>(
    open ? `/api/v1/estimating/assemblies?page=1&pageSize=200&status=active` : null,
  );

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Insert assembly
      </Button>
      <Modal
        open={open}
        title="Insert an assembly"
        description="Expanding writes one line per component under a header line that is deliberately kept out of the total, so the assembly is never counted twice."
        onClose={() => setOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={action.busy === "a"}
              disabled={assemblyId.length === 0 || quantity.trim().length === 0}
              onClick={() =>
                void action
                  .run("a", () =>
                    estimatingApi.fromAssembly(projectId, estimate.id, {
                      assemblyId,
                      quantity: Number(quantity),
                      sectionId: sectionId.length > 0 ? sectionId : null,
                      expandComponents: expand,
                    }),
                  )
                  .then((res) => {
                    if (res) {
                      toast.success(`${res.created} lines added`);
                      for (const w of res.warnings) toast.warning(w);
                      setOpen(false);
                      onDone();
                    }
                  })
              }
            >
              Insert
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}
          <Field label="Assembly" required>
            <Select value={assemblyId} onChange={(e) => setAssemblyId(e.target.value)} placeholder="Choose an assembly">
              <option value="">Choose an assembly</option>
              {(assemblies.data?.items ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name} ({num(a.unitRate, 2)} {a.currency}/{a.unit})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Quantity" required>
            <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Section" optional>
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">No section</option>
              {estimate.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code ? `${s.code} ${s.name}` : s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox
            checked={expand}
            onChange={(e) => setExpand(e.target.checked)}
            label="Expand the components onto their own lines"
          />
        </div>
      </Modal>
    </>
  );
}

function TakeoffInserter({
  projectId,
  estimate,
  onDone,
}: {
  projectId: string;
  estimate: EstimateDetail;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [catalogueItemId, setCatalogueItemId] = useState("");
  const [waste, setWaste] = useState("0");
  const action = useAction();
  const takeoffs = useResource<Paginated<TakeoffItem>>(
    open
      ? `/api/v1/projects/${projectId}/takeoff/items?page=1&pageSize=200&unpricedOnly=true`
      : null,
  );
  const catalogue = useResource<Paginated<CatalogueItem>>(
    open ? `/api/v1/estimating/catalogue?page=1&pageSize=200&status=active` : null,
  );

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Price a measurement
      </Button>
      <Modal
        open={open}
        title="Price measured takeoff"
        description="Only measurements no estimate line already cites are offered. The quantity comes from the measurement; the rate comes from the catalogue item you choose."
        onClose={() => setOpen(false)}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={action.busy === "t"}
              disabled={selected.length === 0}
              onClick={() =>
                void action
                  .run("t", () =>
                    estimatingApi.fromTakeoff(projectId, estimate.id, {
                      takeoffItemIds: selected,
                      catalogueItemId: catalogueItemId.length > 0 ? catalogueItemId : null,
                      wastePercent: Number(waste) || 0,
                    }),
                  )
                  .then((res) => {
                    if (res) {
                      toast.success(`${res.created} lines added`);
                      setOpen(false);
                      setSelected([]);
                      onDone();
                    }
                  })
              }
            >
              Price {selected.length > 0 ? `${selected.length} measurement${selected.length === 1 ? "" : "s"}` : ""}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}
          <Field label="Rate to apply" hint="Leave blank to bring the quantity in unpriced and type the rate on the line.">
            <Select value={catalogueItemId} onChange={(e) => setCatalogueItemId(e.target.value)}>
              <option value="">No catalogue rate</option>
              {(catalogue.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.description} ({num(c.unitRate, 2)} {c.currency}/{c.unit})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Waste %" optional>
            <Input value={waste} onChange={(e) => setWaste(e.target.value)} inputMode="decimal" className="w-32" />
          </Field>
          <div className="max-h-64 overflow-y-auto rounded-md border border-border">
            {(takeoffs.data?.items ?? []).length === 0 ? (
              <div className="p-4 text-meta text-content-subtle">
                Every measurement on this project is already priced onto a line.
              </div>
            ) : (
              (takeoffs.data?.items ?? []).map((t) => (
                <label key={t.id} className="flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-b-0">
                  <input
                    type="checkbox"
                    checked={selected.includes(t.id)}
                    onChange={(ev) =>
                      setSelected((prev) =>
                        ev.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id),
                      )
                    }
                  />
                  <span className="flex-1 text-meta text-content">{t.name}</span>
                  <span className="text-2xs text-content-subtle">
                    {num(t.quantity, 3)} {t.unit} · {titleCase(t.measurementType)}
                    {t.sheetNumber ? ` · ${t.sheetNumber}` : ""}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

function LineEditor({
  projectId,
  estimate,
  open,
  line,
  onClose,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  estimate: EstimateDetail;
  open: boolean;
  line: EstimateLine | null;
  onClose: () => void;
  onSaved: (basis: string[]) => void;
  onDeleted: () => void;
}) {
  const [description, setDescription] = useState("");
  const [costCode, setCostCode] = useState("");
  const [costType, setCostType] = useState("other");
  const [status, setStatus] = useState("active");
  const [unit, setUnit] = useState("");
  const [quantity, setQuantity] = useState("");
  const [waste, setWaste] = useState("0");
  const [sectionId, setSectionId] = useState("");
  const [rates, setRates] = useState<Record<string, string>>({});
  const [catalogueItemId, setCatalogueItemId] = useState("");
  const action = useAction();
  const catalogue = useResource<Paginated<CatalogueItem>>(
    open ? `/api/v1/estimating/catalogue?page=1&pageSize=200&status=active` : null,
  );

  useEffect(() => {
    if (!open) return;
    setDescription(line?.description ?? "");
    setCostCode(line?.costCode ?? "");
    setCostType(line?.costType ?? "other");
    setStatus(line?.status ?? "active");
    setUnit(line?.unit ?? "");
    setWaste(String(line?.wastePercent ?? 0));
    setSectionId(line?.sectionId ?? "");
    setCatalogueItemId("");
    if (line) {
      const base = line.quantity / (1 + line.wastePercent / 100);
      setQuantity(String(Number(base.toFixed(4))));
      setRates({
        labour: String(line.labourRate),
        material: String(line.materialRate),
        equipment: String(line.equipmentRate),
        subcontract: String(line.subcontractRate),
        other: String(line.otherRate),
      });
    } else {
      setQuantity("");
      setRates({});
    }
  }, [open, line]);

  const rateBody = useMemo(() => {
    const out: Record<string, number> = {};
    for (const key of COST_TYPES) {
      const raw = rates[key];
      if (raw !== undefined && raw.trim().length > 0) out[key] = Number(raw) || 0;
    }
    return out;
  }, [rates]);

  const preview = useMemo(() => {
    const q = (Number(quantity) || 0) * (1 + (Number(waste) || 0) / 100);
    const r = COST_TYPES.reduce((sum, k) => sum + (rateBody[k] ?? 0), 0);
    return { quantity: q, unitRate: r, amount: q * r };
  }, [quantity, waste, rateBody]);

  async function save() {
    const body: Record<string, unknown> = {
      description,
      costCode: costCode.trim().length > 0 ? costCode : null,
      costType,
      status,
      unit: unit.trim().length > 0 ? unit : null,
      quantity: Number(quantity) || 0,
      wastePercent: Number(waste) || 0,
      sectionId: sectionId.length > 0 ? sectionId : null,
    };
    if (catalogueItemId.length > 0) body["catalogueItemId"] = catalogueItemId;
    else body["rates"] = rateBody;
    const res = await action.run("save", () =>
      line
        ? estimatingApi.patchLine(projectId, estimate.id, line.id, body)
        : estimatingApi.createLine(projectId, estimate.id, body),
    );
    if (res) {
      toast.success(line ? "Line updated" : "Line added");
      onSaved(res.basis);
    }
  }

  return (
    <Modal
      open={open}
      title={line ? "Edit line" : "Add a line"}
      description="The quantity you type is the measured quantity; waste is applied on top and both are kept, so a reviewer can see the difference."
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex justify-between gap-2">
          {line ? (
            <Button
              variant="danger"
              icon={IconTrash}
              loading={action.busy === "delete"}
              onClick={() =>
                void action
                  .run("delete", () => estimatingApi.deleteLine(projectId, estimate.id, line.id))
                  .then((res) => {
                    if (res) {
                      toast.success("Line deleted");
                      onDeleted();
                    }
                  })
              }
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={action.busy === "save"} disabled={description.trim().length === 0}>
              {line ? "Save" : "Add"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <Field label="Description" required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Cost code">
            <Input value={costCode} onChange={(e) => setCostCode(e.target.value)} placeholder="04-2000" />
          </Field>
          <Field label="Cost type">
            <Select value={costType} onChange={(e) => setCostType(e.target.value)}>
              {COST_TYPES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit">
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m2" />
          </Field>
          <Field label="In the total?">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active — counted</option>
              <option value="provisional">Provisional — counted, flagged</option>
              <option value="alternate">Alternate — offered, not counted</option>
              <option value="excluded">Excluded — kept, not counted</option>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Measured quantity" required>
            <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Waste %">
            <Input value={waste} onChange={(e) => setWaste(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Section">
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">No section</option>
              {estimate.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code ? `${s.code} ${s.name}` : s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Take the rate from the catalogue"
          optional
          hint="Choosing an item copies its rate split, its cost code and the date the rate was current. Leave blank to type the rate."
        >
          <Select value={catalogueItemId} onChange={(e) => setCatalogueItemId(e.target.value)}>
            <option value="">Type the rate below</option>
            {(catalogue.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.description} ({num(c.unitRate, 2)} {c.currency}/{c.unit})
              </option>
            ))}
          </Select>
        </Field>
        {catalogueItemId.length === 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {COST_TYPES.map((key) => (
              <Field key={key} label={titleCase(key)}>
                <Input
                  value={rates[key] ?? ""}
                  onChange={(e) => setRates((prev) => ({ ...prev, [key]: e.target.value }))}
                  inputMode="decimal"
                  placeholder="0"
                />
              </Field>
            ))}
          </div>
        ) : null}
        {catalogueItemId.length === 0 ? (
          <div className="rounded-md border border-border bg-surface-sunken p-3 text-meta">
            <span className="text-content-subtle">Priced quantity </span>
            <span className="text-content">{num(preview.quantity, 3)}</span>
            <span className="text-content-subtle"> × rate </span>
            <span className="text-content">{num(preview.unitRate, 2)}</span>
            <span className="text-content-subtle"> = </span>
            <span className="font-semibold text-content">{money(preview.amount, estimate.currency)}</span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Markups                                                             */
/* ------------------------------------------------------------------ */

function MarkupPanel({
  projectId,
  estimate,
  editable,
  onReload,
}: {
  projectId: string;
  estimate: EstimateDetail;
  editable: boolean;
  onReload: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("overhead");
  const [method, setMethod] = useState("percent");
  const [basis, setBasis] = useState("direct_cost");
  const [rate, setRate] = useState("");
  const [costTypes, setCostTypes] = useState<string[]>([]);
  const [rationale, setRationale] = useState("");
  const action = useAction();

  let running = estimate.directCostTotal;

  async function create() {
    const res = await action.run("create", () =>
      estimatingApi.createMarkup(projectId, estimate.id, {
        name,
        kind,
        method,
        basis,
        rate: Number(rate) || 0,
        costTypes: basis === "cost_type" ? costTypes : [],
        rationale: rationale.trim().length > 0 ? rationale : null,
        sequence: estimate.markups.length + 1,
      }),
    );
    if (res) {
      toast.success("Markup added");
      setAdding(false);
      setName("");
      setRate("");
      setRationale("");
      onReload();
    }
  }

  return (
    <div className="space-y-3">
      {editable ? (
        <Button size="sm" icon={IconPlus} onClick={() => setAdding(true)}>
          Add markup tier
        </Button>
      ) : null}
      {action.error ? (
        <Alert tone="danger" size="sm" onDismiss={action.clear}>
          {action.error}
        </Alert>
      ) : null}

      {estimate.markups.length === 0 ? (
        <Alert tone="info" size="sm" title="No markups">
          The total is the direct cost. Add overhead, profit, contingency and bond as tiers so the order they
          are applied in is recorded rather than assumed.
        </Alert>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Seq</Th>
              <Th>Tier</Th>
              <Th>Applied to</Th>
              <Th align="right">Rate</Th>
              <Th align="right">Base</Th>
              <Th align="right">Amount</Th>
              <Th align="right">Running total</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {estimate.markups.map((m) => {
              const before = running;
              if (m.enabled === 1) running = running + m.amount;
              return (
                <tr key={m.id}>
                  <Td>{m.sequence}</Td>
                  <Td>
                    <div className="text-content">{m.name}</div>
                    <div className="text-2xs text-content-subtle">
                      {titleCase(m.kind)}
                      {m.enabled === 0 ? " · disabled" : ""}
                    </div>
                    {m.rationale ? <div className="text-2xs text-content-subtle">{m.rationale}</div> : null}
                  </Td>
                  <Td>
                    <span className="text-2xs text-content-subtle">
                      {MARKUP_BASIS_LABEL[m.basis] ?? m.basis}
                      {m.costTypes.length > 0 ? ` (${m.costTypes.map(titleCase).join(", ")})` : ""}
                    </span>
                  </Td>
                  <Td align="right">{m.method === "percent" ? `${num(m.rate, 3)}%` : num(m.rate, 2)}</Td>
                  <Td align="right">{money(m.baseAmount, estimate.currency)}</Td>
                  <Td align="right">{money(m.amount, estimate.currency)}</Td>
                  <Td align="right">{money(m.enabled === 1 ? running : before, estimate.currency)}</Td>
                  <Td align="right">
                    {editable ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            void action
                              .run(`t-${m.id}`, () =>
                                estimatingApi.patchMarkup(projectId, estimate.id, m.id, {
                                  enabled: m.enabled === 0,
                                }),
                              )
                              .then((r) => r && onReload())
                          }
                        >
                          {m.enabled === 1 ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={IconTrash}
                          aria-label="Delete markup"
                          iconOnly
                          onClick={() =>
                            void action
                              .run(`d-${m.id}`, () => estimatingApi.deleteMarkup(projectId, estimate.id, m.id))
                              .then((r) => r && onReload())
                          }
                        />
                      </div>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
            <tr>
              <Td />
              <Td className="font-semibold">Estimate total</Td>
              <Td />
              <Td />
              <Td />
              <Td align="right" className="font-semibold">
                {money(estimate.markupTotal, estimate.currency)}
              </Td>
              <Td align="right" className="font-semibold">
                {money(estimate.total, estimate.currency)}
              </Td>
              <Td />
            </tr>
          </tbody>
        </Table>
      )}

      <Modal
        open={adding}
        title="Add a markup tier"
        description="The basis decides what the percentage is a percentage OF. Profit on cost and profit on cost-plus-overhead differ by real money."
        onClose={() => setAdding(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} loading={action.busy === "create"} disabled={name.trim().length === 0}>
              Add
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Site overhead" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Family">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {MARKUP_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {titleCase(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="percent">Percentage</option>
                <option value="fixed">Fixed amount</option>
                <option value="per_unit">Per unit</option>
              </Select>
            </Field>
          </div>
          <Field label="Basis" hint="What the percentage is a percentage of.">
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="direct_cost">Direct cost</option>
              <option value="cost_type">Selected cost types</option>
              <option value="running_total">Running total (compounds on earlier tiers)</option>
              <option value="estimate_total">Estimate as it stands</option>
            </Select>
          </Field>
          {basis === "cost_type" ? (
            <Field label="Cost types" hint="An empty selection would apply to everything; choose at least one.">
              <div className="flex flex-wrap gap-3">
                {COST_TYPES.map((c) => (
                  <Checkbox
                    key={c}
                    checked={costTypes.includes(c)}
                    onChange={(ev) =>
                      setCostTypes((prev) => (ev.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))
                    }
                    label={titleCase(c)}
                    size="sm"
                  />
                ))}
              </div>
            </Field>
          ) : null}
          <Field label={method === "percent" ? "Rate (%)" : "Amount"} required>
            <Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Why" optional hint="A contingency without a reason is a plug.">
            <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Versions and comparison                                             */
/* ------------------------------------------------------------------ */

function VersionPanel({
  projectId,
  estimate,
  onOpenOther,
}: {
  projectId: string;
  estimate: EstimateDetail;
  onOpenOther: (id: string) => void;
}) {
  const others = estimate.versions.filter((v) => v.id !== estimate.id);
  const [against, setAgainst] = useState(() => others[others.length - 1]?.id ?? "");
  const comparison = useResource<Comparison>(
    against.length > 0
      ? `/api/v1/projects/${projectId}/estimates/${estimate.id}/compare?against=${against}`
      : null,
  );

  return (
    <div className="space-y-3">
      <Table>
        <thead>
          <tr>
            <Th>Rev</Th>
            <Th>Status</Th>
            <Th align="right">Total</Th>
            <Th>Created</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {estimate.versions.map((v) => (
            <tr key={v.id}>
              <Td>{v.version}</Td>
              <Td>
                <StatusPill status={v.status} map={ESTIMATE_STATUS_TONE} />
              </Td>
              <Td align="right">{money(v.total, estimate.currency)}</Td>
              <Td>{dateTime(v.createdAt)}</Td>
              <Td align="right">
                {v.id === estimate.id ? (
                  <span className="text-2xs text-content-subtle">Open</span>
                ) : (
                  <Button size="xs" variant="ghost" onClick={() => onOpenOther(v.id)}>
                    Open
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      {others.length === 0 ? (
        <Alert tone="info" size="sm">
          This is the only version in the chain, so there is nothing to compare it with yet.
        </Alert>
      ) : (
        <>
          <Field label="Compare against" layout="horizontal">
            <Select value={against} onChange={(e) => setAgainst(e.target.value)} className="max-w-xs">
              {others.map((v) => (
                <option key={v.id} value={v.id}>
                  Rev {v.version} — {money0(v.total, estimate.currency)}
                </option>
              ))}
            </Select>
          </Field>
          {comparison.error ? (
            <LoadError message={comparison.error} onRetry={comparison.reload} />
          ) : comparison.data ? (
            <ComparisonView data={comparison.data} currency={estimate.currency} />
          ) : null}
        </>
      )}
    </div>
  );
}

function ComparisonView({ data, currency }: { data: Comparison; currency: string }) {
  return (
    <div className="space-y-3">
      {data.warnings.length > 0 ? (
        <Alert tone="warning" size="sm" title="Read this before using the deltas">
          <ul className="list-disc space-y-0.5 pl-4">
            {data.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-surface-sunken p-3 sm:grid-cols-4">
        <SummaryCell
          label={`Rev ${data.before.version}`}
          value={money0(data.totals.beforeTotal, currency)}
        />
        <SummaryCell label={`Rev ${data.after.version}`} value={money0(data.totals.afterTotal, currency)} />
        <SummaryCell label="Movement" value={money0(data.totals.totalDelta, currency)} emphasis />
        <SummaryCell
          label="Explained by"
          value={`${money0(data.totals.quantityEffectTotal, currency)} qty · ${money0(data.totals.rateEffectTotal, currency)} rate`}
          hint={`${money0(data.totals.addedTotal, currency)} added, ${money0(data.totals.removedTotal, currency)} removed`}
        />
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Line</Th>
            <Th>Change</Th>
            <Th align="right">Qty before → after</Th>
            <Th align="right">Rate before → after</Th>
            <Th align="right">Amount Δ</Th>
            <Th align="right">Quantity effect</Th>
            <Th align="right">Rate effect</Th>
          </tr>
        </thead>
        <tbody>
          {data.rows.length === 0 ? (
            <tr>
              <Td colSpan={7}>
                <span className="text-content-subtle">Nothing moved between these two versions.</span>
              </Td>
            </tr>
          ) : (
            data.rows.map((r) => (
              <tr key={r.key}>
                <Td>
                  <div className="text-content">{r.description}</div>
                  <div className="text-2xs text-content-subtle">
                    {r.costCode ?? DASH} · {titleCase(r.costType)} · paired on {r.matchedOn.replace("_", " ")}
                  </div>
                </Td>
                <Td>
                  <Badge
                    tone={
                      r.change === "added"
                        ? "success"
                        : r.change === "removed"
                          ? "danger"
                          : r.change === "scope"
                            ? "warning"
                            : "info"
                    }
                    size="xs"
                  >
                    {titleCase(r.change)}
                  </Badge>
                </Td>
                <Td align="right">
                  {r.before ? num(r.before.quantity, 2) : DASH} → {r.after ? num(r.after.quantity, 2) : DASH}
                </Td>
                <Td align="right">
                  {r.before ? num(r.before.unitRate, 2) : DASH} → {r.after ? num(r.after.unitRate, 2) : DASH}
                </Td>
                <Td align="right" className="font-semibold">
                  {money(r.amountDelta, currency)}
                </Td>
                <Td align="right">{money(r.quantityEffect, currency)}</Td>
                <Td align="right">{money(r.rateEffect, currency)}</Td>
              </tr>
            ))
          )}
        </tbody>
      </Table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Conversion and proposals                                            */
/* ------------------------------------------------------------------ */

function ConvertPanel({
  projectId,
  estimate,
  onReload,
}: {
  projectId: string;
  estimate: EstimateDetail;
  onReload: () => void;
}) {
  const [treatment, setTreatment] = useState("separate_lines");
  const [uncoded, setUncoded] = useState("UNCODED");
  const [makeActive, setMakeActive] = useState(true);
  const [preview, setPreview] = useState<ConversionPreview | null>(null);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalTitle, setProposalTitle] = useState(estimate.name);
  const [clientName, setClientName] = useState("");
  const [detailLevel, setDetailLevel] = useState("section");
  const [validUntil, setValidUntil] = useState(todayIso());
  const action = useAction();

  async function run(dryRun: boolean) {
    const res = await action.run(dryRun ? "dry" : "convert", () =>
      estimatingApi.convert(projectId, estimate.id, {
        markupTreatment: treatment,
        uncodedCostCode: uncoded,
        makeActive,
        dryRun,
      }),
    );
    if (!res) return;
    if ("dryRun" in res) {
      setPreview(res);
      setResult(null);
    } else {
      setResult(res);
      setPreview(null);
      toast.success(`Budget ${res.budgetReference} created`);
      onReload();
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Convert into the project budget (#204)"
          subtitle="Only an approved estimate becomes a budget. Lines are merged where they share a cost code and cost type, uncoded lines go to a named holding code, and markups land the way you choose."
        />
        <CardBody className="space-y-3">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Markups" hint="Where overhead, profit and contingency land in the budget.">
              <Select value={treatment} onChange={(e) => setTreatment(e.target.value)}>
                <option value="separate_lines">Their own budget lines</option>
                <option value="prorate">Spread pro rata across the lines</option>
                <option value="exclude">Left out entirely</option>
              </Select>
            </Field>
            <Field label="Holding code for uncoded lines">
              <Input value={uncoded} onChange={(e) => setUncoded(e.target.value)} />
            </Field>
            <Field label="Make it the active budget">
              <Checkbox checked={makeActive} onChange={(e) => setMakeActive(e.target.checked)} label="Yes" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void run(true)} loading={action.busy === "dry"}>
              Preview (writes nothing)
            </Button>
            <Button
              onClick={() => void run(false)}
              loading={action.busy === "convert"}
              disabled={estimate.status !== "approved" || estimate.convertedBudgetId !== null}
            >
              Convert
            </Button>
            {estimate.status !== "approved" && estimate.convertedBudgetId === null ? (
              <span className="self-center text-2xs text-content-subtle">
                The estimate must be approved by a second person first.
              </span>
            ) : null}
          </div>

          {result ? (
            <Alert tone="success" size="sm" title={`Budget ${result.budgetReference} created`}>
              {result.lines} budget lines totalling {money(result.totals.budgetTotal, result.currency)}.
              {result.warnings.length > 0 ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-4">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </Alert>
          ) : null}

          {preview ? (
            <div className="space-y-3">
              <Alert
                tone={preview.totals.reconciles ? "info" : "warning"}
                size="sm"
                title={
                  preview.totals.reconciles
                    ? "The budget reconciles to the estimate"
                    : "The budget does NOT reconcile to the estimate"
                }
              >
                Estimate {money(preview.totals.estimateTotal, preview.currency)} · budget{" "}
                {money(preview.totals.budgetTotal, preview.currency)}
                {preview.warnings.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-0.5 pl-4">
                    {preview.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                ) : null}
              </Alert>
              <Table>
                <thead>
                  <tr>
                    <Th>Cost code</Th>
                    <Th>Type</Th>
                    <Th>Description</Th>
                    <Th align="right">Qty</Th>
                    <Th align="right">Rate</Th>
                    <Th align="right">Budget</Th>
                    <Th align="right">From</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.plan.map((l) => (
                    <tr key={`${l.costCode}-${l.costType}`}>
                      <Td>{l.costCode}</Td>
                      <Td>{titleCase(l.costType)}</Td>
                      <Td>{l.description}</Td>
                      <Td align="right">
                        {l.quantity === null ? DASH : `${num(l.quantity, 3)} ${l.unit ?? ""}`}
                      </Td>
                      <Td align="right">{l.unitRate === null ? DASH : num(l.unitRate, 2)}</Td>
                      <Td align="right" className="font-semibold">
                        {money(l.originalBudget, preview.currency)}
                      </Td>
                      <Td align="right">
                        <span className="text-2xs text-content-subtle">
                          {l.sourceLineIds.length > 0
                            ? `${l.sourceLineIds.length} line${l.sourceLineIds.length === 1 ? "" : "s"}`
                            : `${l.sourceMarkupIds.length} markup${l.sourceMarkupIds.length === 1 ? "" : "s"}`}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Generate a proposal (#205)"
          subtitle="The document is frozen at generation time: what was sent to a client on a date must not change because somebody later edited a rate."
          actions={
            <Button size="sm" icon={IconEdit} onClick={() => setProposalOpen(true)} disabled={estimate.lineCount === 0}>
              New proposal
            </Button>
          }
        />
        <CardBody>
          <p className="text-meta text-content-subtle">
            Proposals appear on the Proposals tab, where they can be read as printable HTML and issued.
          </p>
        </CardBody>
      </Card>

      <Modal
        open={proposalOpen}
        title="Generate a proposal"
        description="Detail level decides what the client sees. The internal explanation of each markup is never included at any level."
        onClose={() => setProposalOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setProposalOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={action.busy === "proposal"}
              onClick={() =>
                void action
                  .run("proposal", () =>
                    estimatingApi.createProposal(projectId, estimate.id, {
                      title: proposalTitle,
                      clientName: clientName.trim().length > 0 ? clientName : null,
                      detailLevel,
                      validUntil,
                    }),
                  )
                  .then((res) => {
                    if (res) {
                      toast.success(`${res.reference} generated`);
                      setProposalOpen(false);
                      onReload();
                    }
                  })
              }
            >
              Generate
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Title" required>
            <Input value={proposalTitle} onChange={(e) => setProposalTitle(e.target.value)} />
          </Field>
          <Field label="Client" optional>
            <Input value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Detail level">
              <Select value={detailLevel} onChange={(e) => setDetailLevel(e.target.value)}>
                <option value="summary">Lump sum</option>
                <option value="section">Section breakdown</option>
                <option value="line">Every line</option>
              </Select>
            </Field>
            <Field label="Valid until">
              <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </Field>
          </div>
        </div>
      </Modal>
    </div>
  );
}
