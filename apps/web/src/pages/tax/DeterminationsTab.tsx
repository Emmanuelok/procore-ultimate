/**
 * DETERMINATIONS — the register of what the engine decided and why (#798,
 * #799, #802, #804, #805), a what-if determination on demand, a bulk run for
 * an invoice, and the human override that never edits history.
 *
 * Every row carries its citations, warnings and assumptions; the detail
 * drawer prints them verbatim. An override writes a NEW row and points the
 * engine's row at it, so the register always shows both what the rules said
 * and what a person decided instead — and who.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  DataTable,
  Drawer,
  Field,
  Input,
  Select,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconInvoice, IconPlus } from "../../ui/icons";
import { CertificateCreateDrawer } from "./CertificatesTab";
import {
  Basis,
  CONTRACT_TYPES,
  ConfidenceBadge,
  DASH,
  LoadError,
  Row,
  SUPPLY_TYPES,
  VAT_TREATMENTS,
  WITHHOLDING_BASES,
  WITHHOLDING_SCHEMES,
  dateTime,
  determinationTone,
  isoDate,
  money,
  pct,
  taxApi,
  titleCase,
  treatmentTone,
  useAction,
  useProfile,
  useRegimeDef,
  useRegimes,
  useResource,
  useVendors,
  type DeterminationDetail,
  type DeterminationOutput,
  type DeterminationRow,
  type DetermineResponse,
  type InvoiceDetermineResponse,
  type InvoiceLite,
  type Paginated,
} from "./taxShared";

export default function DeterminationsTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [status, setStatus] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [determining, setDetermining] = useState(false);
  const [invoiceRun, setInvoiceRun] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const vendors = useVendors();

  const params = new URLSearchParams({ page: "1", pageSize: "500" });
  if (status) params.set("status", status);
  if (includeSuperseded) params.set("includeSuperseded", "true");
  if (vendorId) params.set("vendorId", vendorId);
  const list = useResource<Paginated<DeterminationRow>>(`/api/v1/projects/${projectId}/tax/determinations?${params.toString()}`);

  const columns = useMemo<DataColumns<DeterminationRow>>(
    () => [
      { id: "number", header: "#", accessor: "number", type: "number", width: 60, mono: true },
      { id: "taxPointDate", header: "Tax point", accessor: (row) => row.taxPointDate ?? "", type: "date", width: 110, cell: ({ row }) => isoDate(row.taxPointDate) },
      { id: "vendorName", header: "Supplier", accessor: (row) => row.vendorName ?? "", type: "text", width: 200, cell: ({ row }) => row.vendorName ?? <span className="text-content-subtle">unnamed</span> },
      { id: "source", header: "Source", accessor: (row) => titleCase(row.sourceType), type: "text", width: 120 },
      { id: "supplyType", header: "Supply", accessor: (row) => titleCase(row.supplyType), type: "text", width: 160 },
      { id: "amount", header: "Amount", accessor: "amount", type: "number", align: "right", width: 130, cell: ({ row }) => money(row.amount, row.currency) },
      {
        id: "vatTreatment",
        header: "VAT treatment",
        accessor: "vatTreatment",
        type: "text",
        width: 160,
        cell: ({ row }) => (
          <Badge tone={treatmentTone(row.vatTreatment)} size="xs">
            {titleCase(row.vatTreatment)} {row.vatRate > 0 ? pct(row.vatRate) : ""}
          </Badge>
        ),
      },
      {
        id: "vatAmount",
        header: "VAT charged / self-accounted",
        accessor: "vatAmount",
        type: "number",
        align: "right",
        width: 190,
        cell: ({ row }) => `${money(row.vatAmount, row.currency)} / ${money(row.selfAccountedVat, row.currency)}`,
      },
      {
        id: "withholding",
        header: "Withholding",
        accessor: "withholdingAmount",
        type: "number",
        align: "right",
        width: 170,
        cell: ({ row }) =>
          row.withholdingScheme === "none" ? (
            <span className="text-content-subtle">none</span>
          ) : (
            <span>
              {row.withholdingScheme.toUpperCase()} {pct(row.withholdingRate)} · {money(row.withholdingAmount, row.currency)}
            </span>
          ),
      },
      { id: "netPayable", header: "Net payable", accessor: "netPayable", type: "number", align: "right", width: 130, cell: ({ row }) => <span className="font-semibold">{money(row.netPayable, row.currency)}</span> },
      { id: "confidence", header: "Confidence", accessor: "confidence", type: "number", align: "right", width: 130, cell: ({ row }) => <ConfidenceBadge value={row.confidence} /> },
      { id: "status", header: "Status", accessor: "status", type: "text", width: 110, cell: ({ row }) => <Badge tone={determinationTone(row.status)} size="xs" dot>{titleCase(row.status)}</Badge> },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
              <option value="">Current + overridden</option>
              <option value="determined">Current</option>
              <option value="overridden">Overridden</option>
              <option value="superseded">Superseded</option>
            </Select>
          </Field>
          <Field label="Supplier">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} size="sm">
              <option value="">Any</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox checked={includeSuperseded} onChange={(e) => setIncludeSuperseded(e.target.checked)} label="Include superseded re-runs" className="pb-2" />
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" icon={IconInvoice} onClick={() => setInvoiceRun(true)}>
              Run for an invoice
            </Button>
            <Button icon={IconPlus} onClick={() => setDetermining(true)}>
              Determine
            </Button>
          </div>
        </CardBody>
      </Card>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : (
        <DataTable<DeterminationRow>
          tableId="tax.determinations"
          data={list.data?.items ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          loading={list.loading && !list.data}
          height={540}
          rowHeight={44}
          stickyHeader
          exportFileName="tax-determinations"
          defaultSort={[{ id: "number", desc: true }]}
          empty={{
            title: "No determinations yet",
            description: "Run one on demand to see what the rules say about a supply, or run the engine over a subcontractor invoice line by line.",
            action: <Button onClick={() => setDetermining(true)}>Determine</Button>,
          }}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowTone={(row) => (row.status === "overridden" ? "warning" : row.status === "superseded" ? "neutral" : row.confidence < 0.7 ? "warning" : undefined)}
          aria-label="Tax determinations"
        />
      )}

      <DetermineDrawer
        projectId={projectId}
        open={determining}
        onClose={() => setDetermining(false)}
        onPersisted={() => {
          list.reload();
          onChanged();
        }}
      />
      <InvoiceRunDrawer
        projectId={projectId}
        open={invoiceRun}
        onClose={() => setInvoiceRun(false)}
        onRan={() => {
          list.reload();
          onChanged();
        }}
      />
      <DeterminationDrawer
        projectId={projectId}
        determinationId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
        onOpen={setOpenId}
      />
    </div>
  );
}

/* ============================== Output panel ============================== */

function OutputSummary({ output, currency }: { output: DeterminationOutput; currency: string }) {
  return (
    <dl className="divide-y divide-border rounded-md border border-border px-3">
      <Row label="VAT treatment">
        <Badge tone={treatmentTone(output.vatTreatment)} size="xs">
          {titleCase(output.vatTreatment)}
          {output.vatRate > 0 ? ` ${pct(output.vatRate)}` : ""}
        </Badge>
      </Row>
      <Row label="VAT charged by the supplier">{money(output.vatAmount, currency)}</Row>
      {output.reverseCharge ? <Row label="VAT the customer self-accounts">{money(output.selfAccountedVat, currency)}</Row> : null}
      {output.leviesAmount > 0 ? (
        <Row label="Levies" hint={output.levies.map((l) => `${l.name} ${pct(l.rate)}`).join(", ")}>
          {money(output.leviesAmount, currency)}
        </Row>
      ) : null}
      <Row label="Withholding">
        {output.withholdingScheme === "none" ? (
          "none"
        ) : (
          <span>
            {output.withholdingScheme.toUpperCase()} at {pct(output.withholdingRate)} of {money(output.withholdingBaseAmount, currency)} ({titleCase(output.withholdingBase)})
          </span>
        )}
      </Row>
      <Row label="Withheld">{money(output.withholdingAmount, currency)}</Row>
      <Row label="Gross payable">{money(output.grossPayable, currency)}</Row>
      <Row label="Net payable">
        <span className="font-semibold">{money(output.netPayable, currency)}</span>
      </Row>
    </dl>
  );
}

/* ============================ Determine on demand ========================= */

function DetermineDrawer({ projectId, open, onClose, onPersisted }: { projectId: string; open: boolean; onClose: () => void; onPersisted: () => void }) {
  const action = useAction();
  const profile = useProfile(projectId);
  const regimes = useRegimes();
  const vendors = useVendors();
  const [regime, setRegime] = useState("");
  const regimeDef = useRegimeDef(regime || profile.data?.resolved.regime || null);
  const [amount, setAmount] = useState("");
  const [materials, setMaterials] = useState("");
  const [currency, setCurrency] = useState("");
  const [supplyType, setSupplyType] = useState("");
  const [contractType, setContractType] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [individual, setIndividual] = useState(false);
  const [place, setPlace] = useState("");
  const [rateKey, setRateKey] = useState("");
  const [treatyRate, setTreatyRate] = useState("");
  const [treatyRef, setTreatyRef] = useState("");
  const [asOf, setAsOf] = useState("");
  const [persist, setPersist] = useState(false);
  const [result, setResult] = useState<DetermineResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    setRegime("");
    setAmount("");
    setMaterials("");
    setCurrency("");
    setSupplyType("");
    setContractType("");
    setVendorId("");
    setIndividual(false);
    setPlace("");
    setRateKey("");
    setTreatyRate("");
    setTreatyRef("");
    setAsOf(new Date().toISOString().slice(0, 10));
    setPersist(false);
    setResult(null);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { amount: Number(amount), persist };
    if (regime) body["regime"] = regime;
    if (materials.trim() !== "") body["materialsAmount"] = Number(materials);
    if (currency.trim()) body["currency"] = currency.trim().toUpperCase();
    if (supplyType) body["supplyType"] = supplyType;
    if (contractType) body["contractType"] = contractType;
    if (vendorId) body["vendorId"] = vendorId;
    if (individual) body["supplierIsIndividual"] = true;
    if (place.trim()) body["placeOfSupplyCountry"] = place.trim().toUpperCase();
    if (rateKey) body["rateKey"] = rateKey;
    if (treatyRate.trim() !== "") body["treaty"] = { rate: Number(treatyRate), reference: treatyRef.trim() };
    if (asOf) body["asOf"] = asOf;
    const res = await action.run("determine", () => taxApi.determine(projectId, body));
    if (res) {
      setResult(res);
      if (res.determination) {
        toast.success(`Determination #${res.determination.number} recorded`);
        onPersisted();
      }
    }
  }

  const resolved = regime || profile.data?.resolved.regime || null;
  const def = regimeDef.data;
  const cur = currency.trim().toUpperCase() || profile.data?.profile?.currency || def?.currency || "";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="xl"
      title="Determine the tax treatment of a supply"
      description="What the rules say for this supply, from the registrations on file. Nothing is recorded unless you ask."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="tax-determine-form" loading={action.busy === "determine"}>
            {persist ? "Determine and record" : "Determine"}
          </Button>
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <form id="tax-determine-form" onSubmit={submit} className="space-y-4">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          {!resolved ? (
            <Alert tone="warning" size="sm">
              This project has no resolved regime; pick one below or save a profile on the Overview tab.
            </Alert>
          ) : null}
          <Field label="Regime" hint={resolved && !regime ? `Defaults to the project's (${resolved.toUpperCase()})` : undefined}>
            <Select value={regime} onChange={(e) => setRegime(e.target.value)}>
              <option value="">Project default</option>
              {(regimes.data?.items ?? []).map((r) => (
                <option key={r.regime} value={r.regime}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Amount (net of VAT)" required>
              <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </Field>
            <Field label="of which materials" hint="Excluded from CIS/RCT bases">
              <Input type="number" min={0} step="0.01" value={materials} onChange={(e) => setMaterials(e.target.value)} />
            </Field>
            <Field label="Currency" hint={cur ? `Default ${cur}` : undefined}>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Supply type">
              <Select value={supplyType} onChange={(e) => setSupplyType(e.target.value)}>
                <option value="">Project default</option>
                {SUPPLY_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {titleCase(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contract type">
              <Select value={contractType} onChange={(e) => setContractType(e.target.value)}>
                <option value="">Project default</option>
                {CONTRACT_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {titleCase(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Supplier" hint="The supplier's registrations on file decide its position">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Unknown supplier (everything assumed)</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.country ? ` (${v.country})` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox checked={individual} onChange={(e) => setIndividual(e.target.checked)} label="Supplier is an individual / sole trader" description="Some regimes withhold at a different rate for individuals (India s194C)." />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Place of supply (ISO-2)">
              <Input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={2} />
            </Field>
            <Field label="Concession rate" hint="Opt-in; the burden of proof is yours">
              <Select value={rateKey} onChange={(e) => setRateKey(e.target.value)}>
                <option value="">None claimed</option>
                {(def?.indirectTax.otherRates ?? []).map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.appliesTo} — {pct(r.rate)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="As of">
              <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Treaty rate (%)" hint="Cross-border payments only (#805)">
              <Input type="number" min={0} max={100} step="0.5" value={treatyRate} onChange={(e) => setTreatyRate(e.target.value)} />
            </Field>
            <Field label="Treaty reference" hint="Article / residence certificate">
              <Input value={treatyRef} onChange={(e) => setTreatyRef(e.target.value)} />
            </Field>
          </div>
          <Checkbox checked={persist} onChange={(e) => setPersist(e.target.checked)} label="Record this determination in the register" description="Recorded as a manual determination: it appears in the register but is excluded from period aggregates." />
        </form>

        <div className="space-y-4">
          {result ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info" size="sm">
                  {result.regime.toUpperCase()} · {result.regimeSource === "explicit" ? "explicit regime" : `regime from ${titleCase(result.regimeSource)}`}
                </Badge>
                {result.vendor ? (
                  <Badge tone="neutral" size="sm">
                    {result.vendor.name} · {result.vendorRegistrations.length} registration{result.vendorRegistrations.length === 1 ? "" : "s"} on file
                  </Badge>
                ) : null}
                {result.determination ? (
                  <Badge tone="success" size="sm">
                    Recorded as #{result.determination.number}
                  </Badge>
                ) : null}
              </div>
              <OutputSummary output={result.output} currency={String(result.input["currency"] ?? cur)} />
              <Basis output={result.output} />
            </>
          ) : (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-meta text-content-subtle">
              The engine's answer appears here with the rules it cited, the assumptions it made and the confidence that follows.
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

/* ============================== Invoice run ============================== */

function InvoiceRunDrawer({ projectId, open, onClose, onRan }: { projectId: string; open: boolean; onClose: () => void; onRan: () => void }) {
  const action = useAction();
  const invoices = useResource<Paginated<InvoiceLite>>(open ? `/api/v1/projects/${projectId}/invoices?kind=subcontractor_invoice&page=1&pageSize=200` : null);
  const [invoiceId, setInvoiceId] = useState("");
  const [result, setResult] = useState<InvoiceDetermineResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    setInvoiceId("");
    setResult(null);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!invoiceId) return;
    const res = await action.run("run", () => taxApi.determineInvoice(projectId, invoiceId));
    if (res) {
      setResult(res);
      toast.success(`${res.determined} line${res.determined === 1 ? "" : "s"} determined for ${res.invoice.reference}`);
      onRan();
    }
  }

  const items = invoices.data?.items ?? [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="xl"
      title="Run the engine over an invoice"
      description="One determination per billable line, superseding earlier runs for the same line, with the invoice's own tax figure checked against the rules (#799, #818)."
    >
      <form onSubmit={run} className="flex flex-wrap items-end gap-3">
        <Field label="Subcontractor invoice" required error={invoices.error} className="min-w-72 flex-1">
          <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} placeholder={invoices.loading ? "Loading invoices…" : items.length === 0 ? "No subcontractor invoices on this project" : "Choose an invoice"}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.reference} · {titleCase(i.status)} · {money(i.total, i.currency)}
                {i.billingDate ? ` · ${i.billingDate}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={!invoiceId} loading={action.busy === "run"}>
          Run
        </Button>
      </form>
      {action.error ? <Alert tone="danger" size="sm" className="mt-3">{action.error}</Alert> : null}
      {result ? (
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border p-3">
              <div className="text-2xs uppercase tracking-wide text-content-subtle">Determined / skipped</div>
              <div className="text-lg font-semibold tabular-nums">
                {result.determined} / {result.skipped}
              </div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-2xs uppercase tracking-wide text-content-subtle">Withholding on this invoice</div>
              <div className="text-lg font-semibold tabular-nums">{money(result.totals.withholdingAmount, result.invoice.currency)}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-2xs uppercase tracking-wide text-content-subtle">Net payable</div>
              <div className="text-lg font-semibold tabular-nums">{money(result.totals.netPayable, result.invoice.currency)}</div>
            </div>
          </div>
          <Alert tone={Math.abs(result.check.mismatch) > 0.005 ? "warning" : "success"} size="sm" title="Invoice tax check">
            {result.check.note} Invoice shows {money(result.check.invoiceTax, result.invoice.currency)}; the rules say {money(result.check.determinedVat, result.invoice.currency)} should be charged
            {result.totals.selfAccountedVat > 0 ? ` and ${money(result.totals.selfAccountedVat, result.invoice.currency)} self-accounted` : ""}.
          </Alert>
          {result.risks.length > 0 ? (
            <Alert tone="danger" size="sm" title="Signals">
              <ul className="space-y-1">
                {result.risks.map((r) => (
                  <li key={r.signalId}>
                    {r.title} — {r.raised ? "raised now" : "already open"} ({titleCase(r.severity)})
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <table className="w-full text-meta">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-content-subtle">
                <th className="py-1 pr-2">Line</th>
                <th className="py-1 pr-2">Description</th>
                <th className="py-1 pr-2 text-right">Amount</th>
                <th className="py-1 pr-2">Treatment</th>
                <th className="py-1 pr-2 text-right">Withheld</th>
                <th className="py-1 pr-2 text-right">Net</th>
                <th className="py-1">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {result.lines.map((l) => (
                <tr key={l.lineId}>
                  <td className="py-1.5 pr-2 font-mono">{l.lineNumber}</td>
                  <td className="py-1.5 pr-2">{l.description}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{money(l.amount, result.invoice.currency)}</td>
                  <td className="py-1.5 pr-2">
                    {l.skipped ? (
                      <span className="italic text-content-subtle">skipped: {l.skipped}</span>
                    ) : l.output ? (
                      <Badge tone={treatmentTone(l.output.vatTreatment)} size="xs">
                        {titleCase(l.output.vatTreatment)}
                      </Badge>
                    ) : (
                      DASH
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{l.output ? money(l.output.withholdingAmount, result.invoice.currency) : DASH}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{l.output ? money(l.output.netPayable, result.invoice.currency) : DASH}</td>
                  <td className="py-1.5">{l.output ? <ConfidenceBadge value={l.output.confidence} /> : DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Drawer>
  );
}

/* ================================= Detail ================================= */

function DeterminationDrawer({
  projectId,
  determinationId,
  onClose,
  onChanged,
  onOpen,
}: {
  projectId: string;
  determinationId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const detail = useResource<DeterminationDetail>(determinationId ? `/api/v1/projects/${projectId}/tax/determinations/${determinationId}` : null);
  const action = useAction();
  const d = detail.data;
  const [overriding, setOverriding] = useState(false);
  const [certOpen, setCertOpen] = useState(false);
  const [vatTreatment, setVatTreatment] = useState("");
  const [vatRate, setVatRate] = useState("");
  const [scheme, setScheme] = useState("");
  const [whtRate, setWhtRate] = useState("");
  const [base, setBase] = useState("");
  const [reason, setReason] = useState("");
  const [citation, setCitation] = useState("");

  useEffect(() => {
    setOverriding(false);
    setCertOpen(false);
    setVatTreatment("");
    setVatRate("");
    setScheme("");
    setWhtRate("");
    setBase("");
    setReason("");
    setCitation("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [determinationId]);

  async function submitOverride(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    const body: Record<string, unknown> = { reason: reason.trim() };
    if (vatTreatment) body["vatTreatment"] = vatTreatment;
    if (vatRate.trim() !== "") body["vatRate"] = Number(vatRate);
    if (scheme) body["withholdingScheme"] = scheme;
    if (whtRate.trim() !== "") body["withholdingRate"] = Number(whtRate);
    if (base) body["withholdingBase"] = base;
    if (citation.trim()) body["citation"] = citation.trim();
    const res = await action.run("override", () => taxApi.override(projectId, d.id, body));
    if (res) {
      toast.success(`Override recorded as #${res.number}; #${d.number} kept as the engine's record`);
      onChanged();
      onOpen(res.id);
    }
  }

  const output: DeterminationOutput | null = d
    ? {
        regime: d.regime,
        vatTreatment: d.vatTreatment,
        vatRate: d.vatRate,
        vatAmount: d.vatAmount,
        selfAccountedVat: d.selfAccountedVat,
        reverseCharge: d.reverseCharge,
        withholdingScheme: d.withholdingScheme,
        withholdingBase: d.withholdingBase,
        withholdingBaseAmount: d.withholdingBaseAmount,
        withholdingRate: d.withholdingRate,
        withholdingAmount: d.withholdingAmount,
        levies: Array.isArray(d.outputs["levies"]) ? (d.outputs["levies"] as DeterminationOutput["levies"]) : [],
        leviesAmount: d.leviesAmount,
        grossPayable: typeof d.outputs["grossPayable"] === "number" ? (d.outputs["grossPayable"] as number) : d.netPayable + d.withholdingAmount,
        netPayable: d.netPayable,
        citations: d.citations,
        warnings: d.warnings,
        assumptions: d.assumptions,
        confidence: d.confidence,
        explanation: typeof d.outputs["explanation"] === "string" ? (d.outputs["explanation"] as string) : "",
      }
    : null;

  return (
    <Drawer
      open={determinationId !== null}
      onClose={onClose}
      size="xl"
      title={d ? `Determination #${d.number}${d.vendorName ? ` — ${d.vendorName}` : ""}` : "Determination"}
      description={d ? `${d.regimeDef?.name ?? d.regime.toUpperCase()} · ${titleCase(d.sourceType)} · tax point ${isoDate(d.taxPointDate)}` : undefined}
      headerActions={
        d && d.status === "determined" ? (
          <div className="flex gap-2">
            {d.withholdingAmount > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => setCertOpen(true)}>
                Draft certificate
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setOverriding((v) => !v)}>
              Override
            </Button>
          </div>
        ) : undefined
      }
    >
      {detail.loading && !d ? <div className="text-meta text-content-subtle">Loading…</div> : null}
      {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
      {d && output ? (
        <div className="space-y-5">
          {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={determinationTone(d.status)} size="sm" dot>
              {titleCase(d.status)}
            </Badge>
            <Badge tone="neutral" size="sm">
              {titleCase(d.supplyType)} · {titleCase(d.contractType)}
            </Badge>
            <Badge tone="neutral" size="sm">
              {money(d.amount, d.currency)}
            </Badge>
            <span className="text-2xs text-content-subtle">recorded {dateTime(d.createdAt)}</span>
          </div>

          {d.status === "overridden" && d.overriddenById ? (
            <Alert tone="warning" size="sm" title="Overridden by a person">
              The engine's figures below were replaced.{" "}
              <button type="button" className="underline" onClick={() => onOpen(d.overriddenById!)}>
                Open the override
              </button>
              .
            </Alert>
          ) : null}
          {d.overridesId ? (
            <Alert tone="info" size="sm" title="This is a human override">
              {d.overrideReason}{" "}
              <button type="button" className="underline" onClick={() => onOpen(d.overridesId!)}>
                Open the engine's record it replaced
              </button>
              .
            </Alert>
          ) : null}
          {d.status === "superseded" && d.supersededById ? (
            <Alert tone="neutral" size="sm" title="Superseded by a re-run">
              <button type="button" className="underline" onClick={() => onOpen(d.supersededById!)}>
                Open the current determination
              </button>
            </Alert>
          ) : null}

          {overriding && d.status === "determined" ? (
            <form onSubmit={submitOverride} className="space-y-3 rounded-md border border-warning-border bg-warning-bg p-3">
              <h3 className="text-sm font-semibold text-content">Override the engine</h3>
              <p className="text-meta text-content-muted">
                The engine's record stays. A new determination is written with your figures, your reason and your name, and the register shows both.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="VAT treatment">
                  <Select value={vatTreatment} onChange={(e) => setVatTreatment(e.target.value)}>
                    <option value="">Keep {titleCase(d.vatTreatment)}</option>
                    {VAT_TREATMENTS.map((t) => (
                      <option key={t} value={t}>
                        {titleCase(t)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="VAT rate (%)">
                  <Input type="number" min={0} max={100} step="0.5" value={vatRate} onChange={(e) => setVatRate(e.target.value)} placeholder={String(d.vatRate)} />
                </Field>
                <Field label="Withholding scheme">
                  <Select value={scheme} onChange={(e) => setScheme(e.target.value)}>
                    <option value="">Keep {d.withholdingScheme.toUpperCase()}</option>
                    {WITHHOLDING_SCHEMES.map((s) => (
                      <option key={s} value={s}>
                        {s.toUpperCase()}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Withholding rate (%)">
                  <Input type="number" min={0} max={100} step="0.5" value={whtRate} onChange={(e) => setWhtRate(e.target.value)} placeholder={String(d.withholdingRate)} />
                </Field>
                <Field label="Withholding base">
                  <Select value={base} onChange={(e) => setBase(e.target.value)}>
                    <option value="">Keep {titleCase(d.withholdingBase)}</option>
                    {WITHHOLDING_BASES.map((b) => (
                      <option key={b} value={b}>
                        {titleCase(b)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Citation" hint="The law, ruling or authority letter relied on">
                  <Input value={citation} onChange={(e) => setCitation(e.target.value)} />
                </Field>
              </div>
              <Field label="Reason" required hint="At least ten characters; this is the audit record">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOverriding(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={reason.trim().length < 10} loading={action.busy === "override"}>
                  Record override
                </Button>
              </div>
            </form>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-3">
              <OutputSummary output={output} currency={d.currency} />
              <dl className="divide-y divide-border rounded-md border border-border px-3">
                <Row label="Source">
                  {titleCase(d.sourceType)}
                  {d.sourceId ? <span className="text-content-subtle"> · {d.sourceId}</span> : null}
                  {d.sourceLineId ? <span className="text-content-subtle"> · line {d.sourceLineId}</span> : null}
                </Row>
                <Row label="Materials in the amount">{money(typeof d.inputs["materialsAmount"] === "number" ? (d.inputs["materialsAmount"] as number) : 0, d.currency)}</Row>
                <Row label="Place of supply">{typeof d.inputs["placeOfSupplyCountry"] === "string" ? (d.inputs["placeOfSupplyCountry"] as string) : DASH}</Row>
                <Row label="Determined by">{d.determinedBy ?? "system"}</Row>
              </dl>
              {d.chain.length > 0 ? (
                <div>
                  <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">Related records</div>
                  <ul className="space-y-1">
                    {d.chain.map((c) => (
                      <li key={c.id} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-meta">
                        <button type="button" className="underline" onClick={() => onOpen(c.id)}>
                          #{c.number}
                        </button>
                        <Badge tone={determinationTone(c.status)} size="xs">
                          {titleCase(c.status)}
                        </Badge>
                        <span className="text-2xs text-content-subtle">{dateTime(c.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <Basis output={output} />
          </div>
        </div>
      ) : null}
      <CertificateCreateDrawer
        projectId={projectId}
        open={certOpen}
        onClose={() => setCertOpen(false)}
        determinationId={d?.id ?? null}
        onCreated={() => {
          setCertOpen(false);
          onChanged();
        }}
      />
    </Drawer>
  );
}
