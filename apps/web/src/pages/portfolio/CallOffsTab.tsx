/**
 * CALL-OFFS — what has been bought off a framework or a term contract for this
 * project (#1053, #1056).
 *
 * The create form is deliberately route-led: the route decides what has to be
 * true. A direct award demands a justification and is checked against the
 * framework's threshold before it is accepted; a mini-competition order must
 * name the competition it came from and can only go to the supplier that won
 * it; a measured term order is priced from the schedule of rates, line by
 * line, with unpriced lines named rather than zeroed.
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
import { IconPlus } from "../../ui/icons";
import {
  CALL_OFF_ROUTES,
  DASH,
  LoadError,
  ReasonList,
  Row,
  isoDate,
  money,
  moneyShort,
  num,
  projectApi,
  statusTone,
  titleCase,
  useAction,
  useResource,
  useVendors,
  type AvailableFrameworks,
  type CallOff,
  type CallOffListResponse,
} from "./portfolioShared";

export default function CallOffsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const list = useResource<CallOffListResponse>(
    `/api/v1/projects/${projectId}/portfolio/call-offs?page=1&pageSize=200`,
  );
  const available = useResource<AvailableFrameworks>(
    `/api/v1/projects/${projectId}/portfolio/available-frameworks`,
  );
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  function reloadAll() {
    list.reload();
    available.reload();
    onChanged();
  }

  const columns = useMemo<DataColumns<CallOff>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", width: 100 },
      { id: "title", header: "Order", accessor: "title", type: "text", width: 280 },
      { id: "supplierName", header: "Supplier", accessor: "supplierName", type: "text", width: 200 },
      {
        id: "route",
        header: "Route",
        accessor: "route",
        type: "text",
        width: 170,
        cell: ({ row }) => (
          <Badge tone={row.route === "direct_award" ? "warning" : "neutral"} size="xs">
            {titleCase(row.route)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => (
          <Badge tone={statusTone(row.status)} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "orderValue",
        header: "Ordered",
        accessor: "orderValue",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.orderValue, row.currency),
      },
      {
        id: "certifiedValue",
        header: "Certified",
        accessor: "certifiedValue",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.certifiedValue, row.currency),
      },
      {
        id: "requiredBy",
        header: "Required by",
        accessor: (r) => r.requiredBy ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => isoDate(row.requiredBy),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Call-off orders"
          subtitle="Bought under an existing agreement rather than a fresh procurement. Issuing an order is what consumes the framework's ceiling, and the check runs at that moment."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
              New call-off
            </Button>
          }
        />
        <CardBody flush>
          {list.data && list.data.byCurrency.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2 text-meta text-content-muted">
              {list.data.byCurrency.map((b) => (
                <span key={b.currency} className="rounded-md border border-border bg-surface-raised px-2.5 py-1">
                  <span className="font-semibold text-content">{b.currency}</span> · ordered{" "}
                  {moneyShort(b.ordered, null)} · certified {moneyShort(b.certified, null)} ({num(b.count)} order
                  {b.count === 1 ? "" : "s"})
                </span>
              ))}
              {list.data.byCurrency.length > 1 ? (
                <span className="self-center text-2xs text-content-subtle">
                  Bucketed by currency; never summed across.
                </span>
              ) : null}
            </div>
          ) : null}
          {list.error ? (
            <div className="p-4">
              <LoadError message={list.error} onRetry={list.reload} />
            </div>
          ) : (
            <DataTable<CallOff>
              tableId="portfolio.call-offs"
              data={list.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={list.loading && !list.data}
              height={420}
              rowHeight={44}
              stickyHeader
              flush
              exportFileName="call-offs"
              onRowClick={({ row }) => setOpenId(row.id)}
              empty={{
                title: "No call-offs on this project",
                description:
                  "A call-off buys work off a framework, a lot or a term contract. The route it travels decides what has to be true before it can be issued.",
                action: <Button onClick={() => setCreating(true)}>Raise a call-off</Button>,
              }}
              aria-label="Call-off orders"
            />
          )}
        </CardBody>
      </Card>

      {available.data && available.data.frameworks.length > 0 ? (
        <Card>
          <CardHeader
            title="What can still be called off"
            subtitle="Live frameworks and their remaining headroom. A framework past its end date cannot be called off at all, whatever headroom is left."
          />
          <CardBody flush>
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Framework</Th>
                    <Th>Award mode</Th>
                    <Th align="right">Direct-award limit</Th>
                    <Th align="right">Headroom</Th>
                    <Th>Ends</Th>
                    <Th align="right">Lots</Th>
                  </tr>
                </thead>
                <tbody>
                  {available.data.frameworks.map((f) => (
                    <tr key={f.id}>
                      <Td>
                        <span className="font-mono text-2xs text-content-subtle">{f.reference}</span> {f.title}
                      </Td>
                      <Td>{titleCase(f.awardMode)}</Td>
                      <Td align="right">
                        {f.directAwardThreshold === null ? (
                          <span className="italic text-content-subtle">none</span>
                        ) : (
                          moneyShort(f.directAwardThreshold, f.currency)
                        )}
                      </Td>
                      <Td align="right">
                        {f.utilisation.headroom === null ? (
                          <span className="italic text-content-subtle">uncapped</span>
                        ) : (
                          <span className={f.utilisation.breached ? "font-semibold text-danger-text" : undefined}>
                            {moneyShort(f.utilisation.headroom, f.currency)}
                          </span>
                        )}
                      </Td>
                      <Td>
                        {isoDate(f.utilisation.expiresOn)}
                        {f.utilisation.daysToExpiry !== null && f.utilisation.daysToExpiry <= 90 ? (
                          <span className="ml-1 text-2xs text-warning-text">
                            in {f.utilisation.daysToExpiry}d
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">{num(f.lots.length)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <CallOffDrawer
        projectId={projectId}
        callOffId={openId}
        onClose={() => setOpenId(null)}
        onChanged={reloadAll}
      />
      <CreateDrawer
        projectId={projectId}
        open={creating}
        available={available.data}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reloadAll();
        }}
      />
    </div>
  );
}

/* =============================== Detail =================================== */

function CallOffDrawer({
  projectId,
  callOffId,
  onClose,
  onChanged,
}: {
  projectId: string;
  callOffId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useResource<CallOff>(
    callOffId ? `/api/v1/projects/${projectId}/portfolio/call-offs/${callOffId}` : null,
  );
  const action = useAction();
  const api = projectApi(projectId);
  const [certifyAmount, setCertifyAmount] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  useEffect(() => {
    setCertifyAmount("");
    setCancelReason("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callOffId]);

  const c = detail.data;

  async function run(key: string, fn: () => Promise<CallOff>, message: string) {
    const res = await action.run(key, fn);
    if (res) {
      toast.success(message);
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={callOffId !== null}
      onClose={onClose}
      size="lg"
      title={c ? `${c.reference} — ${c.title}` : "Call-off"}
      description={c ? `${c.supplierName} · ${titleCase(c.route)} · ${titleCase(c.status)}` : undefined}
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
            <Row label="Order value">{money(c.orderValue, c.currency)}</Row>
            <Row label="Certified">{money(c.certifiedValue, c.currency)}</Row>
            <Row label="Remaining to certify">
              {money(c.remainingToCertify ?? c.orderValue - c.certifiedValue, c.currency)}
            </Row>
            <Row label="Framework">
              {c.framework ? `${c.framework.reference} — ${c.framework.title}` : DASH}
            </Row>
            <Row label="Term contract">
              {c.termContract ? `${c.termContract.reference} — ${c.termContract.title}` : DASH}
            </Row>
            <Row label="Issued">{isoDate(c.issuedAt)}</Row>
            <Row label="Required by">{isoDate(c.requiredBy)}</Row>
            <Row label="Completed">{isoDate(c.completedAt)}</Row>
          </dl>
          {c.scope ? <p className="text-meta text-content-muted">{c.scope}</p> : null}
          {c.justification ? (
            <Alert tone="info" size="sm" title="Direct-award justification">
              {c.justification}
            </Alert>
          ) : null}

          {c.lines.length > 0 ? (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Priced lines
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Code</Th>
                      <Th>Description</Th>
                      <Th align="right">Qty</Th>
                      <Th align="right">Rate</Th>
                      <Th align="right">Amount</Th>
                      <Th>Source</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.lines.map((l, i) => (
                      <tr key={i}>
                        <Td>{l.code}</Td>
                        <Td>{l.description || DASH}</Td>
                        <Td align="right">{l.quantity}</Td>
                        <Td align="right">{l.rate === null ? DASH : l.rate}</Td>
                        <Td align="right">
                          {l.amount === null ? (
                            <span className="italic text-warning-text">not priced</span>
                          ) : (
                            moneyShort(l.amount, c.currency)
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
            </div>
          ) : null}

          <div className="space-y-3 border-t border-border pt-3">
            {c.status === "draft" ? (
              <Button
                size="sm"
                onClick={() => void run("issue", () => api.issueCallOff(c.id), "Order issued")}
                loading={action.busy === "issue"}
              >
                Issue the order
              </Button>
            ) : null}
            {c.status === "issued" || c.status === "in_progress" ? (
              <>
                <div className="flex items-end gap-2">
                  <Field label={`Certify (${c.currency})`} className="flex-1">
                    <Input
                      type="number"
                      value={certifyAmount}
                      onChange={(e) => setCertifyAmount(e.target.value)}
                      size="sm"
                      min={0}
                      step="0.01"
                    />
                  </Field>
                  <Button
                    size="sm"
                    disabled={!certifyAmount}
                    onClick={() =>
                      void run(
                        "certify",
                        () => api.certifyCallOff(c.id, { amount: Number(certifyAmount) }),
                        "Certified",
                      )
                    }
                    loading={action.busy === "certify"}
                  >
                    Certify
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void run("complete", () => api.completeCallOff(c.id), "Order completed")}
                  loading={action.busy === "complete"}
                >
                  Complete
                </Button>
              </>
            ) : null}
            {c.status !== "completed" && c.status !== "cancelled" && c.certifiedValue === 0 ? (
              <div className="flex items-end gap-2">
                <Field label="Cancel" className="flex-1">
                  <Input
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    size="sm"
                    placeholder="Reason"
                  />
                </Field>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!cancelReason.trim()}
                  onClick={() =>
                    void run("cancel", () => api.cancelCallOff(c.id, cancelReason), "Order cancelled")
                  }
                  loading={action.busy === "cancel"}
                >
                  Cancel order
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Drawer>
  );
}

/* =============================== Create =================================== */

function CreateDrawer({
  projectId,
  open,
  available,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  available: AvailableFrameworks | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const vendors = useVendors();
  const api = projectApi(projectId);
  const [form, setForm] = useState<Record<string, string>>({ route: "direct_award" });
  const [lines, setLines] = useState<Array<{ code: string; quantity: string; rate: string }>>([
    { code: "", quantity: "", rate: "" },
  ]);
  const [pricingReasons, setPricingReasons] = useState<string[]>([]);

  useEffect(() => {
    setForm({ route: "direct_award" });
    setLines([{ code: "", quantity: "", rate: "" }]);
    setPricingReasons([]);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const route = form["route"] ?? "direct_award";
  const framework = available?.frameworks.find((f) => f.id === form["frameworkId"]) ?? null;
  const competitions =
    available?.frameworks.flatMap(() => [] as Array<{ id: string; label: string }>) ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      title: form["title"] ?? "",
      scope: form["scope"] || undefined,
      route,
      supplierName: form["supplierName"] ?? "",
      vendorId: form["vendorId"] || undefined,
      currency: form["currency"] ?? "",
      requiredBy: form["requiredBy"] || undefined,
    };
    if (route === "direct_award") {
      body["frameworkId"] = form["frameworkId"] || undefined;
      body["lotId"] = form["lotId"] || undefined;
      body["justification"] = form["justification"] ?? "";
      body["orderValue"] = Number(form["orderValue"] ?? "0") || 0;
    }
    if (route === "mini_competition") {
      body["miniCompetitionId"] = form["miniCompetitionId"] ?? "";
      if (form["orderValue"]) body["orderValue"] = Number(form["orderValue"]);
    }
    if (route === "term_contract") {
      body["termContractId"] = form["termContractId"] ?? "";
      body["orderValue"] = Number(form["orderValue"] ?? "0") || 0;
    }
    if (route === "measured_term") {
      body["termContractId"] = form["termContractId"] ?? "";
      body["lines"] = lines
        .filter((l) => l.code.trim() !== "" || l.quantity.trim() !== "")
        .map((l) => ({
          code: l.code.trim() || undefined,
          quantity: Number(l.quantity) || 0,
          rate: l.rate.trim() === "" ? undefined : Number(l.rate),
        }));
    }
    const res = await action.run("create", () => api.createCallOff(body));
    if (res) {
      setPricingReasons(res.pricingReasons ?? []);
      toast.success(`${res.reference} created — issue it to consume the ceiling`);
      onCreated();
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title="New call-off order"
      description="The route decides what has to be true: a direct award needs a justification and is checked against the framework's threshold; a mini-competition order can only go to the supplier that won it."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-calloff-create" loading={action.busy === "create"}>
            Create as draft
          </Button>
        </div>
      }
    >
      <form id="portfolio-calloff-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <ReasonList reasons={pricingReasons} />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Route" required>
            <Select value={route} onChange={(e) => set("route", e.target.value)}>
              {CALL_OFF_ROUTES.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" required>
            <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
          </Field>
        </div>
        <Field label="Title" required>
          <Input value={form["title"] ?? ""} onChange={(e) => set("title", e.target.value)} required />
        </Field>
        <Field label="Scope">
          <Textarea rows={2} value={form["scope"] ?? ""} onChange={(e) => set("scope", e.target.value)} />
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

        {route === "direct_award" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Framework" required>
                <Select
                  value={form["frameworkId"] ?? ""}
                  onChange={(e) => {
                    const f = available?.frameworks.find((x) => x.id === e.target.value);
                    setForm((prev) => ({
                      ...prev,
                      frameworkId: e.target.value,
                      lotId: "",
                      currency: f ? f.currency : (prev["currency"] ?? ""),
                    }));
                  }}
                  required
                >
                  <option value="">Choose a live framework</option>
                  {(available?.frameworks ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.reference} — {f.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Lot">
                <Select value={form["lotId"] ?? ""} onChange={(e) => set("lotId", e.target.value)}>
                  <option value="">Whole framework</option>
                  {(framework?.lots ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      Lot {l.lotNumber} — {l.title}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field
              label="Order value"
              required
              hint={
                framework?.directAwardThreshold != null
                  ? `Direct awards on this framework are limited to ${money(framework.directAwardThreshold, framework.currency)}`
                  : "This framework declares no direct-award threshold"
              }
            >
              <Input
                type="number"
                value={form["orderValue"] ?? ""}
                onChange={(e) => set("orderValue", e.target.value)}
                min={0}
                step="0.01"
                required
              />
            </Field>
            <Field
              label="Justification"
              required
              hint="Calling off without competing is a decision that has to be defensible."
            >
              <Textarea
                rows={3}
                value={form["justification"] ?? ""}
                onChange={(e) => set("justification", e.target.value)}
                required
              />
            </Field>
          </>
        ) : null}

        {route === "mini_competition" ? (
          <>
            <Field
              label="Mini-competition id"
              required
              hint="The competition this order comes from. Its framework, lot and award value are inherited, and the supplier must be the one that won."
            >
              <Input
                value={form["miniCompetitionId"] ?? ""}
                onChange={(e) => set("miniCompetitionId", e.target.value)}
                required
              />
            </Field>
            {competitions.length > 0 ? null : (
              <p className="text-2xs text-content-subtle">
                Competition references are on the Frameworks tab of the company portfolio workspace.
              </p>
            )}
            <Field label="Order value" hint="Leave blank to inherit the award value">
              <Input
                type="number"
                value={form["orderValue"] ?? ""}
                onChange={(e) => set("orderValue", e.target.value)}
                min={0}
                step="0.01"
              />
            </Field>
          </>
        ) : null}

        {route === "term_contract" || route === "measured_term" ? (
          <Field label="Term contract" required>
            <Select
              value={form["termContractId"] ?? ""}
              onChange={(e) => {
                const t = available?.termContracts.find((x) => x.id === e.target.value);
                setForm((prev) => ({
                  ...prev,
                  termContractId: e.target.value,
                  currency: t ? t.currency : (prev["currency"] ?? ""),
                }));
              }}
              required
            >
              <option value="">Choose a live term contract</option>
              {(available?.termContracts ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.reference} — {t.title} ({t.supplierName})
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {route === "term_contract" ? (
          <Field label="Order value" required>
            <Input
              type="number"
              value={form["orderValue"] ?? ""}
              onChange={(e) => set("orderValue", e.target.value)}
              min={0}
              step="0.01"
              required
            />
          </Field>
        ) : null}

        {route === "measured_term" ? (
          <div className="rounded-md border border-border p-2">
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Measured lines — priced from the schedule of rates
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-4">
                <Field label="Code">
                  <Input
                    value={l.code}
                    onChange={(e) => setLines((list) => list.map((x, j) => (i === j ? { ...x, code: e.target.value } : x)))}
                    size="sm"
                  />
                </Field>
                <Field label="Quantity">
                  <Input
                    type="number"
                    value={l.quantity}
                    onChange={(e) =>
                      setLines((list) => list.map((x, j) => (i === j ? { ...x, quantity: e.target.value } : x)))
                    }
                    size="sm"
                    step="0.001"
                  />
                </Field>
                <Field label="Star rate" hint="Overrides the schedule">
                  <Input
                    type="number"
                    value={l.rate}
                    onChange={(e) => setLines((list) => list.map((x, j) => (i === j ? { ...x, rate: e.target.value } : x)))}
                    size="sm"
                    step="0.01"
                  />
                </Field>
                <div className="flex items-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLines((list) => [...list, { code: "", quantity: "", rate: "" }])}
                  >
                    Add line
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <Field label="Required on site by">
          <Input type="date" value={form["requiredBy"] ?? ""} onChange={(e) => set("requiredBy", e.target.value)} />
        </Field>
      </form>
    </Drawer>
  );
}
