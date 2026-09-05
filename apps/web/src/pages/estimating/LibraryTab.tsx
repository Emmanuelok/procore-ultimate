/**
 * RATE LIBRARY — the company's catalogue, assemblies, crews and production
 * rates (#192–197).
 *
 * The library is a COMPANY asset, not a project one, so it is maintained from
 * here and used by every estimate. Each rate carries its source and the date
 * it was current; the hygiene sweep moves anything older than the staleness
 * window to "review" rather than letting it be priced silently.
 */
import { useEffect, useMemo, useState } from "react";
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
import {
  IconArrowDown,
  IconArrowUp,
  IconEdit,
  IconImport,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../../ui/icons";
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
  todayIso,
  useAction,
  useResource,
  type Assembly,
  type AssemblyComponent,
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
  const [importing, setImporting] = useState(false);
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
              <Button size="sm" variant="secondary" icon={IconImport} onClick={() => setImporting(true)}>
                Import rates
              </Button>
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
      <CatalogueImporter
        open={importing}
        projectId={projectId}
        onClose={() => setImporting(false)}
        onImported={() => list.reload()}
      />
      <CatalogueDrawer itemId={openId} onClose={() => setOpenId(null)} onChanged={() => list.reload()} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Rate-list import (#192)                                             */
/* ------------------------------------------------------------------ */

interface ParsedRateRow {
  code: string;
  description: string;
  unit: string;
  costType: string;
  rate: number;
  line: number;
  error: string | null;
}

/** code | description | unit | cost type | rate — one per line. */
function parseRateList(raw: string): ParsedRateRow[] {
  return raw
    .split(/\r?\n/)
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter((l) => l.text.length > 0 && !l.text.startsWith("#"))
    .map(({ line, text }) => {
      const [code = "", description = "", unit = "", costType = "material", rateRaw = ""] = text
        .split("|")
        .map((p) => p.trim());
      const rate = Number(rateRaw);
      const error =
        code.length === 0
          ? "no code"
          : description.length === 0
            ? "no description"
            : unit.length === 0
              ? "no unit"
              : !Number.isFinite(rate)
                ? `"${rateRaw}" is not a number`
                : !COST_TYPES.includes(costType as (typeof COST_TYPES)[number])
                  ? `"${costType}" is not a cost type`
                  : null;
      return { code, description, unit, costType, rate: Number.isFinite(rate) ? rate : 0, line, error };
    });
}

function CatalogueImporter({
  open,
  projectId,
  onClose,
  onImported,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const action = useAction();
  const [raw, setRaw] = useState("");
  const [upsert, setUpsert] = useState(false);
  const [scopeToProject, setScopeToProject] = useState(false);
  const [rateAsAt, setRateAsAt] = useState(todayIso());
  const [result, setResult] = useState<string[] | null>(null);

  const parsed = useMemo(() => parseRateList(raw), [raw]);
  const bad = parsed.filter((r) => r.error !== null);
  const good = parsed.filter((r) => r.error === null);

  return (
    <Modal
      open={open}
      title="Import a rate list"
      description="One rate per line: code | description | unit | cost type | rate. Nothing is written until every line parses, so a half-imported library cannot happen."
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            loading={action.busy === "import"}
            disabled={good.length === 0 || bad.length > 0}
            onClick={() =>
              void action
                .run("import", () =>
                  estimatingApi.bulkCatalogue({
                    upsert,
                    items: good.map((r) => ({
                      code: r.code,
                      description: r.description,
                      unit: r.unit,
                      costType: r.costType,
                      rateAsAt,
                      projectId: scopeToProject ? projectId : null,
                      rates: { [r.costType]: r.rate },
                    })),
                  }),
                )
                .then((res) => {
                  if (res) {
                    toast.success(`${res.created} created, ${res.updated} updated`);
                    setResult([
                      `${res.created} rate${res.created === 1 ? "" : "s"} created, ${res.updated} updated.`,
                      ...res.skipped.map((s) => `Skipped ${s.code}: ${s.reason}.`),
                    ]);
                    onImported();
                  }
                })
            }
          >
            Import {good.length > 0 ? `${good.length} rate${good.length === 1 ? "" : "s"}` : ""}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <Field
          label="Rate list"
          hint="Cost types: labour, material, equipment, subcontract, other. Lines starting with # are ignored."
        >
          <Textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={8}
            placeholder={"BLK-140 | 140mm dense blockwork | m2 | material | 18.40\nEXC-BULK | Bulk excavation | m3 | equipment | 9.10"}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Current at" hint="The date every rate in this list was true.">
            <Input value={rateAsAt} onChange={(e) => setRateAsAt(e.target.value)} type="date" />
          </Field>
          <div className="space-y-2 self-end pb-1">
            <label className="flex items-center gap-2 text-meta text-content">
              <input type="checkbox" checked={upsert} onChange={(e) => setUpsert(e.target.checked)} />
              Overwrite a rate that already carries this code
            </label>
            <label className="flex items-center gap-2 text-meta text-content">
              <input
                type="checkbox"
                checked={scopeToProject}
                onChange={(e) => setScopeToProject(e.target.checked)}
              />
              Import as this project's override rates only
            </label>
          </div>
        </div>
        {bad.length > 0 ? (
          <Alert tone="warning" size="sm" title={`${bad.length} line${bad.length === 1 ? "" : "s"} will not parse`}>
            <ul className="list-disc pl-4">
              {bad.slice(0, 8).map((r) => (
                <li key={r.line}>
                  Line {r.line}: {r.error}.
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {good.length > 0 ? (
          <div className="rounded-md border border-border bg-surface-sunken p-3 text-2xs text-content-subtle">
            {good.length} rate{good.length === 1 ? "" : "s"} ready. The first is {good[0]!.code} —{" "}
            {good[0]!.description} at {num(good[0]!.rate, 2)} per {good[0]!.unit}.
          </div>
        ) : null}
        {result ? (
          <Alert tone="info" size="sm" title="Import result">
            <ul className="list-disc pl-4">
              {result.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>
    </Modal>
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
  const [amending, setAmending] = useState(false);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [rateAsAt, setRateAsAt] = useState(todayIso());
  const [sourceReference, setSourceReference] = useState("");

  function startAmend(current: CatalogueDetail) {
    setRates({
      labour: String(current.labourRate),
      material: String(current.materialRate),
      equipment: String(current.equipmentRate),
      subcontract: String(current.subcontractRate),
      other: String(current.otherRate),
    });
    setRateAsAt(todayIso());
    setSourceReference(current.sourceReference ?? "");
    setAmending(true);
  }

  return (
    <Drawer
      open={itemId !== null}
      onClose={onClose}
      size="md"
      title={d ? `${d.code} — ${d.description}` : "Catalogue item"}
      description={d ? `${money(d.unitRate, d.currency)} per ${d.unit}` : undefined}
      headerActions={
        d ? (
          <Button size="sm" variant="secondary" icon={IconEdit} onClick={() => startAmend(d)}>
            Amend the rate
          </Button>
        ) : undefined
      }
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

          <Modal
            open={amending}
            title={`Amend ${d.code}`}
            description="A new rate resets the staleness clock and takes the item off review. Estimate lines already priced from it keep the rate they were priced at — this is the library, not the estimate."
            onClose={() => setAmending(false)}
            size="lg"
            footer={
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setAmending(false)}>
                  Cancel
                </Button>
                <Button
                  loading={action.busy === "amend"}
                  onClick={() =>
                    void action
                      .run("amend", () =>
                        estimatingApi.patchCatalogue(d.id, {
                          rates: Object.fromEntries(
                            COST_TYPES.map((k) => [k, Number(rates[k]) || 0]),
                          ),
                          rateAsAt,
                          sourceReference:
                            sourceReference.trim().length > 0 ? sourceReference : null,
                        }),
                      )
                      .then((res) => {
                        if (res) {
                          toast.success(`${d.code} now ${money(res.unitRate, res.currency)}`);
                          setAmending(false);
                          item.reload();
                          onChanged();
                        }
                      })
                  }
                >
                  Save the rate
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {COST_TYPES.map((key) => (
                  <Field key={key} label={titleCase(key)}>
                    <Input
                      value={rates[key] ?? ""}
                      onChange={(e) => setRates((prev) => ({ ...prev, [key]: e.target.value }))}
                      inputMode="decimal"
                    />
                  </Field>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Current at" hint="The date this price was true. It drives the staleness sweep.">
                  <Input value={rateAsAt} onChange={(e) => setRateAsAt(e.target.value)} type="date" />
                </Field>
                <Field label="Source reference" optional hint="The quote, index or invoice it came from.">
                  <Input
                    value={sourceReference}
                    onChange={(e) => setSourceReference(e.target.value)}
                    placeholder="Hanson quote 4471"
                  />
                </Field>
              </div>
              <div className="rounded-md border border-border bg-surface-sunken p-3 text-meta">
                <span className="text-content-subtle">New unit rate </span>
                <span className="font-semibold text-content">
                  {num(
                    COST_TYPES.reduce((sum, k) => sum + (Number(rates[k]) || 0), 0),
                    2,
                  )}{" "}
                  {d.currency}/{d.unit}
                </span>
                <span className="text-content-subtle"> — was {money(d.unitRate, d.currency)}</span>
              </div>
            </div>
          </Modal>
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
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editTrade, setEditTrade] = useState("");
  const [editDescription, setEditDescription] = useState("");
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

  /**
   * Send an existing component back exactly as it is stored — its rates
   * included. PUT .../components is a replace, and a component that names a
   * catalogue item but carries no rate is re-read from the catalogue at write
   * time. Omitting the rates would therefore make "add one component" quietly
   * re-price every other one; refreshing from the catalogue is the button
   * next to this, and it is meant to be a deliberate act.
   */
  const asSpec = (c: AssemblyComponent) => ({
    catalogueItemId: c.catalogueItemId,
    description: c.description,
    unit: c.unit,
    costType: c.costType,
    quantityPer: c.quantityPer,
    wastePercent: c.wastePercent,
    costCode: c.costCode,
    rates: {
      labour: c.labourRate,
      material: c.materialRate,
      equipment: c.equipmentRate,
      subcontract: c.subcontractRate,
      other: c.otherRate,
    },
  });

  async function addComponent() {
    if (!a) return;
    const next = [
      ...a.components.map(asSpec),
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
      toast.success("Component added — the other components kept their stored rates");
      setAdding(false);
      setCatalogueItemId("");
      setDescription("");
      setQuantityPer("");
      assembly.reload();
      onChanged();
    }
  }

  async function removeComponent(componentId: string) {
    if (!a) return;
    const next = a.components.filter((c) => c.id !== componentId).map(asSpec);
    const res = await action.run(`del-${componentId}`, () =>
      estimatingApi.setComponents(a.id, { components: next }),
    );
    if (res) {
      toast.success("Component removed");
      assembly.reload();
      onChanged();
    }
  }

  async function moveComponent(componentId: string, delta: -1 | 1) {
    if (!a) return;
    const list = [...a.components];
    const index = list.findIndex((c) => c.id === componentId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    const moved = list[index]!;
    list[index] = list[target]!;
    list[target] = moved;
    const res = await action.run(`move-${componentId}`, () =>
      estimatingApi.setComponents(a.id, { components: list.map(asSpec) }),
    );
    if (res) {
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
          <div className="flex flex-wrap gap-2">
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
            <Button size="sm" variant="ghost" icon={IconEdit} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={IconTrash}
              disabled={a.status === "retired"}
              loading={action.busy === "retire"}
              onClick={() =>
                void action.run("retire", () => estimatingApi.retireAssembly(a.id)).then((res) => {
                  if (res) {
                    toast.success(`${a.code} retired`);
                    assembly.reload();
                    onChanged();
                  }
                })
              }
            >
              Retire
            </Button>
          </div>
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
                <Th align="right">Order</Th>
              </tr>
            </thead>
            <tbody>
              {a.components.length === 0 ? (
                <tr>
                  <Td colSpan={6}>
                    <span className="text-content-subtle">
                      No components yet — an assembly with none prices at zero.
                    </span>
                  </Td>
                </tr>
              ) : (
                a.components.map((c, i) => (
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
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          iconOnly
                          icon={IconArrowUp}
                          aria-label={`Move ${c.description} up`}
                          disabled={i === 0 || action.busy !== null}
                          onClick={() => void moveComponent(c.id, -1)}
                        />
                        <Button
                          size="xs"
                          variant="ghost"
                          iconOnly
                          icon={IconArrowDown}
                          aria-label={`Move ${c.description} down`}
                          disabled={i === a.components.length - 1 || action.busy !== null}
                          onClick={() => void moveComponent(c.id, 1)}
                        />
                        <Button
                          size="xs"
                          variant="ghost"
                          iconOnly
                          icon={IconTrash}
                          aria-label={`Remove ${c.description}`}
                          loading={action.busy === `del-${c.id}`}
                          onClick={() => void removeComponent(c.id)}
                        />
                      </div>
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
                <Td />
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

          <Modal
            open={editing}
            title={`Edit ${a.code}`}
            description="The header only. The components, and therefore the rate, are edited in the table."
            onClose={() => setEditing(false)}
            footer={
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  loading={action.busy === "edit"}
                  onClick={() =>
                    void action
                      .run("edit", () =>
                        estimatingApi.patchAssembly(a.id, {
                          name: editName.trim().length > 0 ? editName : a.name,
                          trade: editTrade.trim().length > 0 ? editTrade : null,
                          description: editDescription.trim().length > 0 ? editDescription : null,
                        }),
                      )
                      .then((res) => {
                        if (res) {
                          toast.success("Saved");
                          setEditing(false);
                          assembly.reload();
                          onChanged();
                        }
                      })
                  }
                >
                  Save
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
              <Field label="Name">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={a.name}
                />
              </Field>
              <Field label="Trade" optional>
                <Input
                  value={editTrade}
                  onChange={(e) => setEditTrade(e.target.value)}
                  placeholder={a.trade ?? "Masonry"}
                />
              </Field>
              <Field label="Description" optional>
                <Textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={2}
                  placeholder={a.description ?? ""}
                />
              </Field>
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

/** One per line: label | count | hourly rate. */
function parseCrewLines(raw: string, isEquipment: boolean) {
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

const crewLinesOf = (
  rows: ReadonlyArray<{ trade?: string; description?: string; count: number; hourlyRate: number }>,
): string => rows.map((r) => `${r.trade ?? r.description ?? ""} | ${r.count} | ${r.hourlyRate}`).join("\n");

function CrewEditor({
  crew,
  onClose,
  onSaved,
}: {
  crew: Crew | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const [name, setName] = useState("");
  const [membersRaw, setMembersRaw] = useState("");
  const [equipmentRaw, setEquipmentRaw] = useState("");

  useEffect(() => {
    if (!crew) return;
    setName(crew.name);
    setMembersRaw(crewLinesOf(crew.members));
    setEquipmentRaw(crewLinesOf(crew.equipment));
  }, [crew]);

  return (
    <Modal
      open={crew !== null}
      title={crew ? `Edit ${crew.code}` : "Edit crew"}
      description="Changing the make-up re-materializes the hourly cost. Estimate lines already priced from this crew keep the rate they were priced at."
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={action.busy === "save"}
            disabled={crew === null || name.trim().length === 0}
            onClick={() =>
              void action
                .run("save", () =>
                  estimatingApi.patchCrew(crew!.id, {
                    name,
                    members: parseCrewLines(membersRaw, false),
                    equipment: parseCrewLines(equipmentRaw, true),
                  }),
                )
                .then((res) => {
                  if (res) {
                    toast.success(`${res.code} — ${money(res.hourlyCost, res.currency)} per crew-hour`);
                    onSaved();
                  }
                })
            }
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Operatives" hint="One per line: trade | count | hourly rate">
          <Textarea value={membersRaw} onChange={(e) => setMembersRaw(e.target.value)} rows={3} />
        </Field>
        <Field label="Plant" optional hint="One per line: description | count | hourly rate">
          <Textarea value={equipmentRaw} onChange={(e) => setEquipmentRaw(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}

function CrewsPane() {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Crew | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [membersRaw, setMembersRaw] = useState("");
  const [equipmentRaw, setEquipmentRaw] = useState("");
  const action = useAction();
  const list = useResource<Paginated<Crew>>("/api/v1/estimating/crews?page=1&pageSize=200");

  const parse = parseCrewLines;

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
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((c) => (
                <tr key={c.id}>
                  <Td className="font-mono text-2xs">{c.code}</Td>
                  <Td>
                    <div className="text-content">
                      {c.name}
                      {c.status === "retired" ? (
                        <Badge tone="neutral" size="xs" className="ml-2">
                          Retired
                        </Badge>
                      ) : null}
                    </div>
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
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        iconOnly
                        icon={IconEdit}
                        aria-label={`Edit ${c.name}`}
                        onClick={() => setEditing(c)}
                      />
                      <Button
                        size="xs"
                        variant="ghost"
                        iconOnly
                        icon={IconTrash}
                        aria-label={`Retire ${c.name}`}
                        disabled={c.status === "retired"}
                        loading={action.busy === `retire-${c.id}`}
                        onClick={() =>
                          void action
                            .run(`retire-${c.id}`, () => estimatingApi.retireCrew(c.id))
                            .then((res) => {
                              if (res) {
                                toast.success(`${c.code} retired`);
                                list.reload();
                              }
                            })
                        }
                      />
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>

      <CrewEditor
        crew={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          list.reload();
        }}
      />

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

function ProductionRateEditor({
  rate,
  onClose,
  onSaved,
}: {
  rate: ProductionRate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useAction();
  const [value, setValue] = useState("");
  const [basis, setBasis] = useState("output_per_hour");
  const [conditions, setConditions] = useState("");
  const [rateAsAt, setRateAsAt] = useState(todayIso());

  useEffect(() => {
    if (!rate) return;
    setValue(String(rate.value));
    setBasis(rate.basis);
    setConditions(rate.conditions ?? "");
    setRateAsAt(rate.rateAsAt ?? todayIso());
  }, [rate]);

  return (
    <Modal
      open={rate !== null}
      title={rate ? `Edit ${rate.code}` : "Edit production rate"}
      description="The basis is stored as it was quoted. Changing it does NOT convert the value — say what the number means and leave the number alone."
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={action.busy === "save"}
            disabled={rate === null}
            onClick={() =>
              void action
                .run("save", () =>
                  estimatingApi.patchProductionRate(rate!.id, {
                    value: Number(value) || 0,
                    basis,
                    conditions: conditions.trim().length > 0 ? conditions : null,
                    rateAsAt,
                  }),
                )
                .then((res) => {
                  if (res) {
                    toast.success(`${res.code} updated`);
                    onSaved();
                  }
                })
            }
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Value" required>
            <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Basis">
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="output_per_hour">Output per hour</option>
              <option value="hours_per_unit">Hours per unit</option>
            </Select>
          </Field>
        </div>
        <Field label="Conditions" optional hint="What the rate assumes — access, weather, gang size, shift.">
          <Textarea value={conditions} onChange={(e) => setConditions(e.target.value)} rows={2} />
        </Field>
        <Field label="Current at">
          <Input value={rateAsAt} onChange={(e) => setRateAsAt(e.target.value)} type="date" />
        </Field>
      </div>
    </Modal>
  );
}

function RatesPane() {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProductionRate | null>(null);
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
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-2xs">{r.code}</Td>
                  <Td>
                    <div className="text-content">
                      {r.description}
                      {r.status === "retired" ? (
                        <Badge tone="neutral" size="xs" className="ml-2">
                          Retired
                        </Badge>
                      ) : null}
                    </div>
                    {r.conditions ? <div className="text-2xs text-content-subtle">{r.conditions}</div> : null}
                  </Td>
                  <Td>{r.unit}</Td>
                  <Td align="right" className="font-semibold">
                    {num(r.value, 4)}
                  </Td>
                  <Td>{titleCase(r.basis)}</Td>
                  <Td>{r.rateAsAt ? dateOnly(r.rateAsAt) : DASH}</Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        iconOnly
                        icon={IconEdit}
                        aria-label={`Edit ${r.code}`}
                        onClick={() => setEditing(r)}
                      />
                      <Button
                        size="xs"
                        variant="ghost"
                        iconOnly
                        icon={IconTrash}
                        aria-label={`Retire ${r.code}`}
                        disabled={r.status === "retired"}
                        loading={action.busy === `retire-${r.id}`}
                        onClick={() =>
                          void action
                            .run(`retire-${r.id}`, () => estimatingApi.retireProductionRate(r.id))
                            .then((res) => {
                              if (res) {
                                toast.success(`${r.code} retired`);
                                list.reload();
                              }
                            })
                        }
                      />
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>

      <ProductionRateEditor
        rate={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          list.reload();
        }}
      />

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
