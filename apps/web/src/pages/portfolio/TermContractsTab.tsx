/**
 * TERM CONTRACTS AND SCHEDULES OF RATES (#1055–#1056).
 *
 * A schedule of rates is only useful if you can see what a measured order
 * would actually cost under it, so the pricing engine is exposed directly:
 * enter codes and quantities and the panel shows the adjusted rate per line,
 * which lines could not be priced, and why. An unpriced line is never zeroed —
 * it is excluded from the total and named.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconSpreadsheet } from "../../ui/icons";
import {
  DASH,
  LoadError,
  ReasonList,
  Row,
  isoDate,
  money,
  moneyShort,
  num,
  portfolioApi,
  statusTone,
  titleCase,
  useAction,
  useIsCompanyAdmin,
  useResource,
  useVendors,
  type Paginated,
  type PricedOrder,
  type SorItem,
  type TermContract,
} from "./portfolioShared";

export default function TermContractsTab({ onChanged }: { onChanged: () => void }) {
  const isAdmin = useIsCompanyAdmin();
  const list = useResource<Paginated<TermContract>>("/api/v1/portfolio/term-contracts?page=1&pageSize=100");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const columns = useMemo<DataColumns<TermContract>>(
    () => [
      { id: "reference", header: "Reference", accessor: "reference", type: "code", width: 170 },
      { id: "title", header: "Contract", accessor: "title", type: "text", width: 260 },
      { id: "supplierName", header: "Supplier", accessor: "supplierName", type: "text", width: 200 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "adjustment",
        header: "Adjustment",
        accessor: "adjustmentPercent",
        type: "number",
        align: "right",
        width: 130,
        cell: ({ row }) => (
          <span>
            {row.adjustmentPercent > 0 ? "+" : ""}
            {row.adjustmentPercent}%{" "}
            <span className="text-2xs text-content-subtle">{titleCase(row.adjustmentBasis)}</span>
          </span>
        ),
      },
      {
        id: "ordered",
        header: "Ordered",
        accessor: (r) => r.consumption.ordered,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.consumption.ordered, row.currency),
      },
      {
        id: "maximumValue",
        header: "Maximum",
        accessor: (r) => r.maximumValue ?? 0,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) =>
          row.maximumValue === null ? (
            <span className="italic text-content-subtle">uncapped</span>
          ) : (
            moneyShort(row.maximumValue, row.currency)
          ),
      },
      {
        id: "endDate",
        header: "Ends",
        accessor: (r) => r.endDate ?? "",
        type: "date",
        width: 120,
        cell: ({ row }) => isoDate(row.endDate),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Term contracts"
          subtitle="A priced schedule of rates and the measured orders placed against it. The contract's percentage adjustment applies to schedule rates and never to a star rate agreed for one order."
          actions={
            isAdmin ? (
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                New term contract
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          {list.error ? (
            <div className="p-4">
              <LoadError message={list.error} onRetry={list.reload} />
            </div>
          ) : !list.loading && (list.data?.items.length ?? 0) === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={IconSpreadsheet}
                title="No term contracts"
                description="A term contract carries a schedule of rates; measured term orders are priced from it line by line, and any code the schedule does not carry is returned unpriced with its reason."
                action={isAdmin ? <Button onClick={() => setCreating(true)}>Add a term contract</Button> : undefined}
              />
            </div>
          ) : (
            <DataTable<TermContract>
              tableId="portfolio.term-contracts"
              data={list.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={list.loading && !list.data}
              height={340}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              onRowClick={({ row }) => setOpenId(row.id)}
              empty={{ title: "No term contracts" }}
              aria-label="Term contracts"
            />
          )}
        </CardBody>
      </Card>

      <TermContractDrawer
        contractId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
        isAdmin={isAdmin}
      />
      <TermContractCreateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function TermContractDrawer({
  contractId,
  onClose,
  onChanged,
  isAdmin,
}: {
  contractId: string | null;
  onClose: () => void;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const detail = useResource<TermContract>(
    contractId ? `/api/v1/portfolio/term-contracts/${contractId}` : null,
  );
  const action = useAction();
  const [rateForm, setRateForm] = useState<Record<string, string>>({});
  const [priceLines, setPriceLines] = useState<Array<{ code: string; quantity: string; rate: string }>>([
    { code: "", quantity: "", rate: "" },
  ]);
  const [priced, setPriced] = useState<PricedOrder | null>(null);

  useEffect(() => {
    setRateForm({});
    setPriced(null);
    setPriceLines([{ code: "", quantity: "", rate: "" }]);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  const c = detail.data;

  async function addRate(e: FormEvent) {
    e.preventDefault();
    if (!contractId) return;
    const rate = Number(rateForm["rate"] ?? "");
    const res = await action.run("rate", () =>
      portfolioApi.addRates(contractId, {
        code: rateForm["code"] ?? "",
        description: rateForm["description"] ?? "",
        unit: rateForm["unit"] ?? "",
        category: rateForm["category"] || undefined,
        rate: Number.isFinite(rate) ? rate : 0,
      }),
    );
    if (res) {
      toast.success(`${res.total} rate(s) added`);
      setRateForm({});
      detail.reload();
      onChanged();
    }
  }

  async function price(e: FormEvent) {
    e.preventDefault();
    if (!contractId) return;
    const lines = priceLines
      .filter((l) => l.code.trim() !== "" || l.quantity.trim() !== "")
      .map((l) => ({
        code: l.code.trim() || undefined,
        quantity: Number(l.quantity) || 0,
        rate: l.rate.trim() === "" ? undefined : Number(l.rate),
      }));
    if (lines.length === 0) return;
    const res = await action.run("price", () => portfolioApi.priceLines(contractId, lines));
    if (res) setPriced(res);
  }

  const rateColumns = useMemo<DataColumns<SorItem>>(
    () => [
      { id: "code", header: "Code", accessor: "code", type: "code", width: 110 },
      { id: "description", header: "Description", accessor: "description", type: "text", width: 320 },
      { id: "unit", header: "Unit", accessor: "unit", type: "text", width: 80 },
      {
        id: "rate",
        header: "Rate",
        accessor: "rate",
        type: "number",
        align: "right",
        width: 120,
        cell: ({ row }) => moneyShort(row.rate, row.currency),
      },
      {
        id: "active",
        header: "Active",
        accessor: "active",
        type: "number",
        width: 90,
        cell: ({ row }) => (
          <Badge tone={row.active === 1 ? "success" : "neutral"} size="xs">
            {row.active === 1 ? "Active" : "Withdrawn"}
          </Badge>
        ),
      },
    ],
    [],
  );

  return (
    <Drawer
      open={contractId !== null}
      onClose={onClose}
      size="xl"
      title={c ? `${c.reference} — ${c.title}` : "Term contract"}
      description={c ? `${c.supplierName} · ${c.currency} · ${titleCase(c.status)}` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !c ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}
          <dl className="divide-y divide-border">
            <Row label="Term">
              {isoDate(c.startDate)} → {isoDate(c.endDate)}
            </Row>
            <Row label="Maximum value">
              {c.maximumValue === null ? "uncapped" : money(c.maximumValue, c.currency)}
            </Row>
            <Row
              label="Rate adjustment"
              hint={c.indexReference ? `Index: ${c.indexReference}` : undefined}
            >
              {c.adjustmentPercent > 0 ? "+" : ""}
              {c.adjustmentPercent}% ({titleCase(c.adjustmentBasis)})
            </Row>
            <Row label="Ordered" hint={`${num(c.consumption.count)} consuming order(s)`}>
              {money(c.consumption.ordered, c.currency)}
            </Row>
            <Row label="Certified">{money(c.consumption.certified, c.currency)}</Row>
            <Row label="Price base date">{isoDate(c.priceBaseDate)}</Row>
          </dl>
          {c.consumption.currencyMismatches > 0 ? (
            <ReasonList
              reasons={[
                `${c.consumption.currencyMismatches} order(s) against this contract are in another currency and are excluded from its consumption.`,
              ]}
            />
          ) : null}

          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Schedule of rates ({c.rates?.length ?? 0})
            </div>
            <DataTable<SorItem>
              tableId="portfolio.sor"
              data={c.rates ?? []}
              columns={rateColumns}
              getRowId={(row) => row.id}
              height={240}
              rowHeight={40}
              stickyHeader
              toolbar={false}
              empty={{
                title: "No rates loaded",
                description: "Without a schedule, a measured term order has nothing to price against.",
              }}
              aria-label="Schedule of rates"
            />
            {isAdmin ? (
              <form onSubmit={addRate} className="mt-2 grid gap-2 rounded-md border border-border p-2 sm:grid-cols-6">
                <Field label="Code">
                  <Input
                    value={rateForm["code"] ?? ""}
                    onChange={(e) => setRateForm((f) => ({ ...f, code: e.target.value }))}
                    size="sm"
                    required
                  />
                </Field>
                <Field label="Description" className="sm:col-span-2">
                  <Input
                    value={rateForm["description"] ?? ""}
                    onChange={(e) => setRateForm((f) => ({ ...f, description: e.target.value }))}
                    size="sm"
                    required
                  />
                </Field>
                <Field label="Unit">
                  <Input
                    value={rateForm["unit"] ?? ""}
                    onChange={(e) => setRateForm((f) => ({ ...f, unit: e.target.value }))}
                    size="sm"
                    required
                  />
                </Field>
                <Field label={`Rate (${c.currency})`}>
                  <Input
                    type="number"
                    value={rateForm["rate"] ?? ""}
                    onChange={(e) => setRateForm((f) => ({ ...f, rate: e.target.value }))}
                    size="sm"
                    min={0}
                    step="0.01"
                    required
                  />
                </Field>
                <div className="flex items-end">
                  <Button size="sm" type="submit" loading={action.busy === "rate"}>
                    Add rate
                  </Button>
                </div>
              </form>
            ) : null}
          </div>

          <div className="rounded-md border border-border p-3">
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Price a measured order
            </div>
            <form onSubmit={price} className="space-y-2">
              {priceLines.map((l, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-4">
                  <Field label="Code">
                    <Input
                      value={l.code}
                      onChange={(e) =>
                        setPriceLines((list) => list.map((x, j) => (i === j ? { ...x, code: e.target.value } : x)))
                      }
                      size="sm"
                    />
                  </Field>
                  <Field label="Quantity">
                    <Input
                      type="number"
                      value={l.quantity}
                      onChange={(e) =>
                        setPriceLines((list) => list.map((x, j) => (i === j ? { ...x, quantity: e.target.value } : x)))
                      }
                      size="sm"
                      step="0.001"
                    />
                  </Field>
                  <Field label="Star rate" hint="Overrides the schedule; not adjusted">
                    <Input
                      type="number"
                      value={l.rate}
                      onChange={(e) =>
                        setPriceLines((list) => list.map((x, j) => (i === j ? { ...x, rate: e.target.value } : x)))
                      }
                      size="sm"
                      step="0.01"
                    />
                  </Field>
                  <div className="flex items-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPriceLines((list) => [...list, { code: "", quantity: "", rate: "" }])}
                    >
                      Add line
                    </Button>
                  </div>
                </div>
              ))}
              <Button size="sm" type="submit" loading={action.busy === "price"}>
                Price
              </Button>
            </form>
            {priced ? (
              <div className="mt-3">
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Description</Th>
                        <Th align="right">Qty</Th>
                        <Th align="right">Base rate</Th>
                        <Th align="right">Rate</Th>
                        <Th align="right">Amount</Th>
                        <Th>Source</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {priced.lines.map((l, i) => (
                        <tr key={i}>
                          <Td>{l.code}</Td>
                          <Td>{l.description || DASH}</Td>
                          <Td align="right">{l.quantity}</Td>
                          <Td align="right">{l.baseRate === null ? DASH : l.baseRate}</Td>
                          <Td align="right">{l.rate === null ? DASH : l.rate}</Td>
                          <Td align="right">
                            {l.amount === null ? (
                              <span className="italic text-warning-text">not priced</span>
                            ) : (
                              moneyShort(l.amount, priced.currency)
                            )}
                          </Td>
                          <Td>
                            <Badge
                              tone={l.source === "unpriced" ? "warning" : l.source === "star_rate" ? "info" : "neutral"}
                              size="xs"
                            >
                              {titleCase(l.source)}
                            </Badge>
                            {l.reason ? <div className="text-2xs text-content-subtle">{l.reason}</div> : null}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                <div className="mt-2 text-meta">
                  <span className="text-content-subtle">Total of priced lines: </span>
                  <span className="font-semibold text-content">{money(priced.total, priced.currency)}</span>
                  {priced.unpricedLines > 0 ? (
                    <span className="ml-2 text-warning-text">
                      {priced.unpricedLines} line(s) excluded from the total
                    </span>
                  ) : null}
                </div>
                <ReasonList reasons={priced.reasons} className="mt-1" />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function TermContractCreateDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const vendors = useVendors();
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    setForm({});
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const max = Number(form["maximumValue"] ?? "");
    const adj = Number(form["adjustmentPercent"] ?? "0");
    const res = await action.run("create", () =>
      portfolioApi.createTermContract({
        reference: form["reference"] ?? "",
        title: form["title"] ?? "",
        supplierName: form["supplierName"] ?? "",
        vendorId: form["vendorId"] || undefined,
        currency: form["currency"] ?? "",
        startDate: form["startDate"] || undefined,
        endDate: form["endDate"] || undefined,
        maximumValue: form["maximumValue"] && Number.isFinite(max) ? max : undefined,
        adjustmentPercent: Number.isFinite(adj) ? adj : 0,
        adjustmentBasis: form["adjustmentBasis"] ?? "none",
        indexReference: form["indexReference"] || undefined,
        priceBaseDate: form["priceBaseDate"] || undefined,
        notes: form["notes"] || undefined,
      }),
    );
    if (res) {
      toast.success("Term contract created — load its schedule of rates next");
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="New term contract"
      description="An index-linked contract must name the index it is linked to; a percentage with no stated basis is not a price adjustment mechanism."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-term-create" loading={action.busy === "create"}>
            Save
          </Button>
        </div>
      }
    >
      <form id="portfolio-term-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reference" required>
            <Input value={form["reference"] ?? ""} onChange={(e) => set("reference", e.target.value)} required />
          </Field>
          <Field label="Currency" required>
            <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
          </Field>
        </div>
        <Field label="Title" required>
          <Input value={form["title"] ?? ""} onChange={(e) => set("title", e.target.value)} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier name" required>
            <Input value={form["supplierName"] ?? ""} onChange={(e) => set("supplierName", e.target.value)} required />
          </Field>
          <Field label="Vendor record">
            <Select
              value={form["vendorId"] ?? ""}
              onChange={(e) => {
                const v = vendors.data?.items.find((x) => x.id === e.target.value);
                setForm((f) => ({ ...f, vendorId: e.target.value, supplierName: v ? v.name : (f["supplierName"] ?? "") }));
              }}
            >
              <option value="">None</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Start">
            <Input type="date" value={form["startDate"] ?? ""} onChange={(e) => set("startDate", e.target.value)} />
          </Field>
          <Field label="End">
            <Input type="date" value={form["endDate"] ?? ""} onChange={(e) => set("endDate", e.target.value)} />
          </Field>
          <Field label="Maximum value">
            <Input
              type="number"
              value={form["maximumValue"] ?? ""}
              onChange={(e) => set("maximumValue", e.target.value)}
              min={0}
              step="0.01"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Adjustment %" hint="Applied to schedule rates, never to a star rate">
            <Input
              type="number"
              value={form["adjustmentPercent"] ?? "0"}
              onChange={(e) => set("adjustmentPercent", e.target.value)}
              step="0.01"
            />
          </Field>
          <Field label="Basis">
            <Select value={form["adjustmentBasis"] ?? "none"} onChange={(e) => set("adjustmentBasis", e.target.value)}>
              {["none", "fixed_percent", "index_linked", "negotiated"].map((b) => (
                <option key={b} value={b}>
                  {titleCase(b)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Price base date">
            <Input type="date" value={form["priceBaseDate"] ?? ""} onChange={(e) => set("priceBaseDate", e.target.value)} />
          </Field>
        </div>
        <Field label="Index reference" hint="Required when the basis is index-linked">
          <Input value={form["indexReference"] ?? ""} onChange={(e) => set("indexReference", e.target.value)} />
        </Field>
        <Field label="Notes">
          <Textarea rows={2} value={form["notes"] ?? ""} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
    </Drawer>
  );
}
