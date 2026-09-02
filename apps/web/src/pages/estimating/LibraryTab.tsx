/**
 * RATE LIBRARY — the company's catalogue, assemblies, crews and production
 * rates (#192–197).
 *
 * The library is a COMPANY asset, not a project one, so it is maintained from
 * here and used by every estimate. Each rate carries its source and the date
 * it was current; the hygiene sweep moves anything older than the staleness
 * window to "review" rather than letting it be priced silently.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
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
import { IconPlus, IconRefresh } from "../../ui/icons";
import {
  COST_TYPES,
  DASH,
  LoadError,
  Row,
  count,
  dateOnly,
  estimatingApi,
  money,
  num,
  titleCase,
  useAction,
  useResource,
  type Assembly,
  type AssemblyDetail,
  type CatalogueDetail,
  type CatalogueItem,
  type Crew,
  type Paginated,
  type ProductionRate,
} from "./estimatingShared";

type LibraryPane = "catalogue" | "assemblies" | "crews" | "rates";

export default function LibraryTab({ projectId }: { projectId: string }) {
  const [pane, setPane] = useState<LibraryPane>("catalogue");
  return (
    <div className="space-y-4">
      <Tabs
        items={[
          { value: "catalogue", label: "Cost catalogue" },
          { value: "assemblies", label: "Assemblies" },
          { value: "crews", label: "Crews" },
          { value: "rates", label: "Production rates" },
        ]}
        value={pane}
        onChange={(v) => setPane(v as LibraryPane)}
        size="sm"
      />
      {pane === "catalogue" ? <CataloguePane projectId={projectId} /> : null}
      {pane === "assemblies" ? <AssembliesPane /> : null}
      {pane === "crews" ? <CrewsPane /> : null}
      {pane === "rates" ? <RatesPane /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

function CataloguePane({ projectId }: { projectId: string }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: "1", pageSize: "300", projectId });
  if (search.trim().length > 0) params.set("search", search.trim());
  if (status.length > 0) params.set("status", status);
  const list = useResource<Paginated<CatalogueItem>>(
    `/api/v1/estimating/catalogue?${params.toString()}`,
  );

  const columns = useMemo<DataColumns<CatalogueItem>>(
    () => [
      { id: "code", header: "Code", accessor: "code", type: "text", width: 130, mono: true },
      { id: "description", header: "Description", accessor: "description", type: "text", width: 300 },
      { id: "unit", header: "Unit", accessor: "unit", type: "text", width: 80 },
      {
        id: "costType",
        header: "Type",
        accessor: (row) => titleCase(row.costType),
        type: "text",
        width: 110,
      },
      {
        id: "unitRate",
        header: "Rate",
        accessor: "unitRate",
        type: "number",
        align: "right",
        width: 130,
        cell: ({ row }) => <span className="font-semibold">{money(row.unitRate, row.currency)}</span>,
      },
      {
        id: "split",
        header: "L / M / E / S / O",
        accessor: (row) => row.unitRate,
        type: "text",
        width: 220,
        sortable: false,
        cell: ({ row }) => (
          <span className="text-2xs text-content-subtle">
            {num(row.labourRate, 2)} / {num(row.materialRate, 2)} / {num(row.equipmentRate, 2)} /{" "}
            {num(row.subcontractRate, 2)} / {num(row.otherRate, 2)}
          </span>
        ),
      },
      {
        id: "rateAsAt",
        header: "Current at",
        accessor: (row) => row.rateAsAt ?? "",
        type: "text",
        width: 120,
        cell: ({ row }) =>
          row.rateAsAt ? dateOnly(row.rateAsAt) : <span className="text-content-subtle">{DASH}</span>,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <Badge
            tone={row.status === "active" ? "success" : row.status === "review" ? "warning" : "neutral"}
            size="xs"
            dot
          >
            {titleCase(row.status)}
          </Badge>
        ),
      },
      { id: "source", header: "Source", accessor: (row) => titleCase(row.source), type: "text", width: 140 },
    ],
    [],
  );

  return (
    <>
      <Card>
        <CardHeader
          title="Cost catalogue (#192, #195–196)"
          subtitle="Company rates with an optional project-specific override. The rate is stored as its cost-type split, because that split is what a subcontract comparison and a labour-hour forecast each need."
          actions={
            <div className="flex items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search code or description"
                size="sm"
                className="w-56"
              />
              <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm" className="w-36">
                <option value="">All</option>
                <option value="active">Active</option>
                <option value="review">Needs review</option>
                <option value="retired">Retired</option>
              </Select>
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                Add rate
              </Button>
            </div>
          }
        />
        <CardBody flush>
          {list.error ? (
            <div className="p-4">
              <LoadError message={list.error} onRetry={list.reload} />
            </div>
          ) : (
            <DataTable<CatalogueItem>
              tableId="estimating.catalogue"
              data={list.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={list.loading && !list.data}
              height={440}
              rowHeight={42}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "The catalogue is empty",
                description:
                  "Add the rates you price from. Every one carries the date it was current, so the platform can tell you when it has gone stale rather than pricing with it silently.",
              }}
              onRowClick={({ row }) => setOpenId(row.id)}
              rowTone={(row) => (row.status === "review" ? "warning" : undefined)}
              aria-label="Cost catalogue"
            />
          )}
        </CardBody>
      </Card>

      <CatalogueEditor
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          list.reload();
        }}
      />
      <CatalogueDrawer itemId={openId} onClose={() => setOpenId(null)} onChanged={() => list.reload()} />
    </>
  );
}

function CatalogueEditor({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("");
  const [costType, setCostType] = useState("material");
  const [currency, setCurrency] = useState("USD");
  const [costCode, setCostCode] = useState("");
  const [source, setSource] = useState("manual");
  const [rates, setRates] = useState<Record<string, string>>({});
  const action = useAction();

  const total = COST_TYPES.reduce((sum, k) => sum + (Number(rates[k]) || 0), 0);

  return (
    <Modal
      open={open}
      title="Add a catalogue rate"
      description="Split the rate by cost type. A rate that is all in one bucket is fine; a rate whose split nobody recorded cannot be argued with later."
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={action.busy === "save"}
            disabled={code.trim().length === 0 || description.trim().length === 0 || unit.trim().length === 0}
            onClick={() =>
              void action
                .run("save", () =>
                  estimatingApi.createCatalogue({
                    code,
                    description,
                    unit,
                    costType,
                    currency,
                    costCode: costCode.trim().length > 0 ? costCode : null,
                    source,
                    rates: Object.fromEntries(
                      COST_TYPES.map((k) => [k, Number(rates[k]) || 0]).filter(([, v]) => v !== 0),
                    ),
                  }),
                )
                .then((res) => {
                  if (res) {
                    toast.success(`${res.code} added`);
                    setCode("");
                    setDescription("");
                    setRates({});
                    onSaved();
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
        <div className="grid grid-cols-3 gap-3">
          <Field label="Code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="BLK-140" />
          </Field>
          <Field label="Unit" required>
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m2" />
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </Field>
        </div>
        <Field label="Description" required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Cost type">
            <Select value={costType} onChange={(e) => setCostType(e.target.value)}>
              {COST_TYPES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cost code" optional>
            <Input value={costCode} onChange={(e) => setCostCode(e.target.value)} placeholder="04-2000" />
          </Field>
          <Field label="Source" hint="Its authority, and its staleness clock">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="manual">Typed</option>
              <option value="historical">Historical</option>
              <option value="supplier_quote">Supplier quote</option>
              <option value="published_index">Published index</option>
              <option value="benchmark">Benchmark</option>
            </Select>
          </Field>
        </div>
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
        <div className="rounded-md border border-border bg-surface-sunken p-3 text-meta">
          <span className="text-content-subtle">Unit rate </span>
          <span className="font-semibold text-content">
            {num(total, 2)} {currency}/{unit || "unit"}
          </span>
        </div>
      </div>
    </Modal>
  );
}

function CatalogueDrawer({
  itemId,
  onClose,
  onChanged,
}: {
  itemId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const item = useResource<CatalogueDetail>(itemId ? `/api/v1/estimating/catalogue/${itemId}` : null);
  const d = item.data;

  return (
    <Drawer
      open={itemId !== null}
      onClose={onClose}
      size="md"
      title={d ? `${d.code} — ${d.description}` : "Catalogue item"}
      description={d ? `${money(d.unitRate, d.currency)} per ${d.unit}` : undefined}
    >
      {item.error ? (
        <LoadError message={item.error} onRetry={item.reload} />
      ) : !d ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}
          <Alert tone={d.staleness.stale ? "warning" : "info"} size="sm" title={d.staleness.stale ? "This rate has gone stale" : "Rate currency"}>
            {d.staleness.reason}
            {d.staleness.ageDays !== null ? ` It is ${count(d.staleness.ageDays)} days old.` : ""}
          </Alert>
          <dl className="divide-y divide-border">
            <Row label="Labour">{money(d.labourRate, d.currency)}</Row>
            <Row label="Material">{money(d.materialRate, d.currency)}</Row>
            <Row label="Equipment">{money(d.equipmentRate, d.currency)}</Row>
            <Row label="Subcontract">{money(d.subcontractRate, d.currency)}</Row>
            <Row label="Other">{money(d.otherRate, d.currency)}</Row>
            <Row label="Unit rate">
              <span className="font-semibold">{money(d.unitRate, d.currency)}</span>
            </Row>
            <Row label="Cost code">{d.costCode ?? DASH}</Row>
            <Row label="Source">
              {titleCase(d.source)}
              {d.sourceReference ? ` — ${d.sourceReference}` : ""}
            </Row>
            <Row label="Status">{titleCase(d.status)}</Row>
          </dl>
          {d.crew ? (
            <Card>
              <CardHeader title={`Crew: ${d.crew.name}`} subtitle={`${money(d.crew.hourlyCost, d.crew.currency)} per crew-hour, ${num(d.crew.headcount, 1)} operatives`} />
              <CardBody>
                <Table dense>
                  <tbody>
                    {d.crew.members.map((m, i) => (
                      <tr key={`m-${i}`}>
                        <Td>{m.trade}</Td>
                        <Td align="right">
                          {num(m.count, 2)} × {num(m.hourlyRate, 2)}
                        </Td>
                      </tr>
                    ))}
                    {d.crew.equipment.map((m, i) => (
                      <tr key={`e-${i}`}>
                        <Td>{m.description}</Td>
                        <Td align="right">
                          {num(m.count, 2)} × {num(m.hourlyRate, 2)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {d.productionRate !== null ? (
                  <p className="mt-2 text-2xs text-content-subtle">
                    Production rate {num(d.productionRate, 3)} ({titleCase(d.productionRateBasis ?? "")}) — the
                    labour half of this rate is built up from the crew and this figure whenever a line does not
                    already carry one.
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={action.busy === "retire"}
              disabled={d.status === "retired"}
              onClick={() =>
                void action.run("retire", () => estimatingApi.retireCatalogue(d.id)).then((res) => {
                  if (res) {
                    toast.success(`${d.code} retired`);
                    item.reload();
                    onChanged();
                  }
                })
              }
            >
              Retire
            </Button>
            <span className="self-center text-2xs text-content-subtle">
              Retired, never deleted — estimate lines cite this item, and an estimate whose rate provenance
              evaporates cannot be defended.
            </span>
          </div>
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Assemblies                                                          */
/* ------------------------------------------------------------------ */

function AssembliesPane() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const action = useAction();
  const list = useResource<Paginated<Assembly>>("/api/v1/estimating/assemblies?page=1&pageSize=200");

  const columns = useMemo<DataColumns<Assembly>>(
    () => [
      { id: "code", header: "Code", accessor: "code", type: "text", width: 150, mono: true },
      { id: "name", header: "Assembly", accessor: "name", type: "text", width: 300 },
      { id: "unit", header: "Per", accessor: "unit", type: "text", width: 80 },
      {
        id: "componentCount",
        header: "Components",
        accessor: "componentCount",
        type: "number",
        align: "right",
        width: 120,
      },
      {
        id: "unitRate",
        header: "Unit rate",
        accessor: "unitRate",
        type: "number",
        align: "right",
        width: 140,
        cell: ({ row }) => <span className="font-semibold">{money(row.unitRate, row.currency)}</span>,
      },
      {
        id: "status",
        header: "Status",
        accessor: (row) => titleCase(row.status),
        type: "text",
        width: 110,
      },
    ],
    [],
  );

  return (
    <>
      <Card>
        <CardHeader
          title="Assemblies (#191, #193)"
          subtitle="A composed item — blocks, mortar, labour and scaffold priced as one m² of wall. Expanding one onto an estimate writes a line per component so the build-up is visible in the grid."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
              New assembly
            </Button>
          }
        />
        <CardBody flush>
          {list.error ? (
            <div className="p-4">
              <LoadError message={list.error} onRetry={list.reload} />
            </div>
          ) : (
            <DataTable<Assembly>
              tableId="estimating.assemblies"
              data={list.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={list.loading && !list.data}
              height={400}
              rowHeight={42}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "No assemblies yet",
                description:
                  "Create one and give it components from the catalogue. Its unit rate is materialized from them, so refreshing it is a deliberate act rather than a side effect.",
              }}
              onRowClick={({ row }) => setOpenId(row.id)}
              aria-label="Assemblies"
            />
          )}
        </CardBody>
      </Card>

      <Modal
        open={creating}
        title="New assembly"
        onClose={() => setCreating(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              loading={action.busy === "create"}
              disabled={code.trim().length === 0 || name.trim().length === 0 || unit.trim().length === 0}
              onClick={() =>
                void action
                  .run("create", () => estimatingApi.createAssembly({ code, name, unit }))
                  .then((res) => {
                    if (res) {
                      toast.success(`${res.code} created`);
                      setCreating(false);
                      setCode("");
                      setName("");
                      list.reload();
                      setOpenId(res.id);
                    }
                  })
              }
            >
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
          <Field label="Code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ASM-BLK-140" />
          </Field>
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="140mm blockwork, built" />
          </Field>
          <Field label="Priced per" required>
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m2" />
          </Field>
        </div>
      </Modal>

      <AssemblyDrawer assemblyId={openId} onClose={() => setOpenId(null)} onChanged={() => list.reload()} />
    </>
  );
}

function AssemblyDrawer({
  assemblyId,
  onClose,
  onChanged,
}: {
  assemblyId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [catalogueItemId, setCatalogueItemId] = useState("");
  const [description, setDescription] = useState("");
  const [quantityPer, setQuantityPer] = useState("");
  const [waste, setWaste] = useState("0");

  const assembly = useResource<AssemblyDetail>(
    assemblyId ? `/api/v1/estimating/assemblies/${assemblyId}` : null,
  );
  const catalogue = useResource<Paginated<CatalogueItem>>(
    assemblyId ? "/api/v1/estimating/catalogue?page=1&pageSize=300&status=active" : null,
  );
  const a = assembly.data;

  async function addComponent() {
    if (!a) return;
    const next = [
      ...a.components.map((c) => ({
        catalogueItemId: c.catalogueItemId,
        description: c.description,
        unit: c.unit,
        costType: c.costType,
        quantityPer: c.quantityPer,
        wastePercent: c.wastePercent,
        costCode: c.costCode,
        ...(c.catalogueItemId
          ? {}
          : {
              rates: {
                labour: c.labourRate,
                material: c.materialRate,
                equipment: c.equipmentRate,
                subcontract: c.subcontractRate,
                other: c.otherRate,
              },
            }),
      })),
      {
        catalogueItemId: catalogueItemId.length > 0 ? catalogueItemId : null,
        description:
          description.trim().length > 0
            ? description
            : (catalogue.data?.items.find((c) => c.id === catalogueItemId)?.description ?? "Component"),
        quantityPer: Number(quantityPer) || 0,
        wastePercent: Number(waste) || 0,
      },
    ];
    const res = await action.run("add", () => estimatingApi.setComponents(a.id, { components: next }));
    if (res) {
      toast.success("Component added");
      setAdding(false);
      setCatalogueItemId("");
      setDescription("");
      setQuantityPer("");
      assembly.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={assemblyId !== null}
      onClose={onClose}
      size="lg"
      title={a ? `${a.code} — ${a.name}` : "Assembly"}
      description={a ? `${money(a.unitRate, a.currency)} per ${a.unit} · ${count(a.componentCount)} components` : undefined}
      headerActions={
        a ? (
          <Button
            size="sm"
            variant="secondary"
            icon={IconRefresh}
            loading={action.busy === "refresh"}
            onClick={() =>
              void action.run("refresh", () => estimatingApi.refreshAssembly(a.id)).then((res) => {
                if (res) {
                  setRefreshNote(res.refresh?.reason ?? null);
                  toast.success(`Unit rate now ${num(res.unitRate, 2)}`);
                  assembly.reload();
                  onChanged();
                }
              })
            }
          >
            Refresh from catalogue
          </Button>
        ) : undefined
      }
    >
      {assembly.error ? (
        <LoadError message={assembly.error} onRetry={assembly.reload} />
      ) : !a ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}
          {refreshNote ? (
            <Alert tone="info" size="sm" title="Rates refreshed">
              {refreshNote}
            </Alert>
          ) : null}

          <Table>
            <thead>
              <tr>
                <Th>Component</Th>
                <Th align="right">Per {a.unit}</Th>
                <Th align="right">Waste</Th>
                <Th align="right">Rate</Th>
                <Th align="right">Amount per {a.unit}</Th>
              </tr>
            </thead>
            <tbody>
              {a.components.length === 0 ? (
                <tr>
                  <Td colSpan={5}>
                    <span className="text-content-subtle">
                      No components yet — an assembly with none prices at zero.
                    </span>
                  </Td>
                </tr>
              ) : (
                a.components.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <div className="text-content">{c.description}</div>
                      <div className="text-2xs text-content-subtle">
                        {titleCase(c.costType)}
                        {c.catalogueItemId ? " · from the catalogue" : " · typed rate"}
                      </div>
                    </Td>
                    <Td align="right">
                      {num(c.quantityPer, 4)} {c.unit ?? ""}
                    </Td>
                    <Td align="right">{num(c.wastePercent, 2)}%</Td>
                    <Td align="right">{num(c.unitRate, 2)}</Td>
                    <Td align="right" className="font-semibold">
                      {money(c.amountPer, a.currency)}
                    </Td>
                  </tr>
                ))
              )}
              <tr>
                <Td className="font-semibold">Assembly rate</Td>
                <Td />
                <Td />
                <Td />
                <Td align="right" className="font-semibold">
                  {money(a.unitRate, a.currency)}
                </Td>
              </tr>
            </tbody>
          </Table>

          <Button size="sm" icon={IconPlus} onClick={() => setAdding(true)}>
            Add a component
          </Button>

          <Modal
            open={adding}
            title="Add a component"
            description="Quantity is per ONE assembly unit — 12.5 blocks per m², 0.35 crew-hours per m²."
            onClose={() => setAdding(false)}
            footer={
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button
                  loading={action.busy === "add"}
                  disabled={quantityPer.trim().length === 0}
                  onClick={() => void addComponent()}
                >
                  Add
                </Button>
              </div>
            }
          >
            <div className="space-y-3">
              <Field label="Catalogue item" optional hint="Its rate is copied in at write time.">
                <Select value={catalogueItemId} onChange={(e) => setCatalogueItemId(e.target.value)}>
                  <option value="">Type the description instead</option>
                  {(catalogue.data?.items ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.description} ({num(c.unitRate, 2)}/{c.unit})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Description" optional>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Quantity per ${a.unit}`} required>
                  <Input value={quantityPer} onChange={(e) => setQuantityPer(e.target.value)} inputMode="decimal" />
                </Field>
                <Field label="Waste %">
                  <Input value={waste} onChange={(e) => setWaste(e.target.value)} inputMode="decimal" />
                </Field>
              </div>
            </div>
          </Modal>
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Crews and production rates                                          */
/* ------------------------------------------------------------------ */

function CrewsPane() {
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [membersRaw, setMembersRaw] = useState("");
  const [equipmentRaw, setEquipmentRaw] = useState("");
  const action = useAction();
  const list = useResource<Paginated<Crew>>("/api/v1/estimating/crews?page=1&pageSize=200");

  function parse(raw: string, isEquipment: boolean) {
    return raw
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [label = "", countRaw = "1", rateRaw = "0"] = line.split("|").map((p) => p.trim());
        return isEquipment
          ? { description: label, count: Number(countRaw) || 0, hourlyRate: Number(rateRaw) || 0 }
          : { trade: label, count: Number(countRaw) || 0, hourlyRate: Number(rateRaw) || 0 };
      });
  }

  return (
    <Card>
      <CardHeader
        title="Crews (#197)"
        subtitle="Estimating archetypes — 'a 2+1 bricklaying gang' — that exist before anybody is hired. Distinct from the real crews of named people in Timecards."
        actions={
          <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
            New crew
          </Button>
        }
      />
      <CardBody>
        {list.error ? (
          <LoadError message={list.error} onRetry={list.reload} />
        ) : (list.data?.items ?? []).length === 0 ? (
          <p className="text-meta text-content-subtle">
            No crews yet. A crew plus a production rate is what turns "£42/m²" into a position somebody can
            argue with.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Crew</Th>
                <Th align="right">Heads</Th>
                <Th align="right">Labour /hr</Th>
                <Th align="right">Plant /hr</Th>
                <Th align="right">Total /hr</Th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((c) => (
                <tr key={c.id}>
                  <Td className="font-mono text-2xs">{c.code}</Td>
                  <Td>
                    <div className="text-content">{c.name}</div>
                    <div className="text-2xs text-content-subtle">
                      {c.members.map((m) => `${num(m.count, 0)}× ${m.trade}`).join(", ") || DASH}
                    </div>
                  </Td>
                  <Td align="right">{num(c.headcount, 1)}</Td>
                  <Td align="right">{money(c.labourHourlyCost, c.currency)}</Td>
                  <Td align="right">{money(c.equipmentHourlyCost, c.currency)}</Td>
                  <Td align="right" className="font-semibold">
                    {money(c.hourlyCost, c.currency)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>

      <Modal
        open={creating}
        title="New crew"
        onClose={() => setCreating(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              loading={action.busy === "create"}
              disabled={code.trim().length === 0 || name.trim().length === 0}
              onClick={() =>
                void action
                  .run("create", () =>
                    estimatingApi.createCrew({
                      code,
                      name,
                      members: parse(membersRaw, false),
                      equipment: parse(equipmentRaw, true),
                    }),
                  )
                  .then((res) => {
                    if (res) {
                      toast.success(`${res.code} — ${money(res.hourlyCost, res.currency)} per crew-hour`);
                      setCreating(false);
                      setCode("");
                      setName("");
                      setMembersRaw("");
                      setEquipmentRaw("");
                      list.reload();
                    }
                  })
              }
            >
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code" required>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="GANG-2+1" />
            </Field>
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bricklaying gang 2+1" />
            </Field>
          </div>
          <Field label="Operatives" hint="One per line: trade | count | hourly rate">
            <Textarea
              value={membersRaw}
              onChange={(e) => setMembersRaw(e.target.value)}
              rows={3}
              placeholder={"bricklayer | 2 | 32\nlabourer | 1 | 21"}
            />
          </Field>
          <Field label="Plant" optional hint="One per line: description | count | hourly rate">
            <Textarea
              value={equipmentRaw}
              onChange={(e) => setEquipmentRaw(e.target.value)}
              rows={2}
              placeholder={"Mixer | 1 | 6.50"}
            />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

function RatesPane() {
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("");
  const [basis, setBasis] = useState("output_per_hour");
  const [value, setValue] = useState("");
  const [crewId, setCrewId] = useState("");
  const action = useAction();
  const list = useResource<Paginated<ProductionRate>>(
    "/api/v1/estimating/production-rates?page=1&pageSize=200",
  );
  const crews = useResource<Paginated<Crew>>("/api/v1/estimating/crews?page=1&pageSize=200");

  return (
    <Card>
      <CardHeader
        title="Production rates (#194)"
        subtitle="Stored in the direction they were quoted in. Converting silently between output-per-hour and hours-per-unit is how estimates acquire factor-of-ten errors."
        actions={
          <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
            New rate
          </Button>
        }
      />
      <CardBody>
        {list.error ? (
          <LoadError message={list.error} onRetry={list.reload} />
        ) : (list.data?.items ?? []).length === 0 ? (
          <p className="text-meta text-content-subtle">No production rates yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Description</Th>
                <Th>Unit</Th>
                <Th align="right">Rate</Th>
                <Th>Basis</Th>
                <Th>Current at</Th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-2xs">{r.code}</Td>
                  <Td>
                    <div className="text-content">{r.description}</div>
                    {r.conditions ? <div className="text-2xs text-content-subtle">{r.conditions}</div> : null}
                  </Td>
                  <Td>{r.unit}</Td>
                  <Td align="right" className="font-semibold">
                    {num(r.value, 4)}
                  </Td>
                  <Td>{titleCase(r.basis)}</Td>
                  <Td>{r.rateAsAt ? dateOnly(r.rateAsAt) : DASH}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>

      <Modal
        open={creating}
        title="New production rate"
        onClose={() => setCreating(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              loading={action.busy === "create"}
              disabled={code.trim().length === 0 || description.trim().length === 0 || unit.trim().length === 0}
              onClick={() =>
                void action
                  .run("create", () =>
                    estimatingApi.createProductionRate({
                      code,
                      description,
                      unit,
                      basis,
                      value: Number(value) || 0,
                      crewId: crewId.length > 0 ? crewId : null,
                    }),
                  )
                  .then((res) => {
                    if (res) {
                      toast.success(`${res.code} added`);
                      setCreating(false);
                      setCode("");
                      setDescription("");
                      setValue("");
                      list.reload();
                    }
                  })
              }
            >
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code" required>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="PR-BLK" />
            </Field>
            <Field label="Unit" required>
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m2" />
            </Field>
          </div>
          <Field label="Description" required>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Basis">
              <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="output_per_hour">Output per hour</option>
                <option value="hours_per_unit">Hours per unit</option>
              </Select>
            </Field>
            <Field label="Value" required>
              <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
            </Field>
          </div>
          <Field label="Crew" optional>
            <Select value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              <option value="">No crew</option>
              {(crews.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
