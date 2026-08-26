/**
 * THE INVOICE REGISTER — both directions, kept apart.
 *
 * Owner applications for payment and subcontractor invoices share one table
 * and one implementation of the G702 arithmetic, because they ARE the same
 * arithmetic. They are not the same MONEY, though: one is a receivable and the
 * other a payable, so this register separates them and never adds them up.
 *
 * Totals are per currency. A project running a USD subcontract and a EUR
 * equipment purchase order gets two blocks, not one wrong number.
 */
import { useMemo, useState } from "react";
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
  SegmentedControl,
  Select,
} from "../../ui";
import { Modal, toast } from "../../ui/overlays";
import { DataTable, type DataColumns } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconInvoice } from "../../ui/icons";
import { api } from "../../lib/api";
import InvoiceDrawer from "./InvoiceDetail";
import {
  INVOICE_STATUSES,
  KIND_LABEL,
  Reasons,
  RefusalPanel,
  errorMessage,
  invoiceTone,
  label,
  money,
  percent,
  periodAcceptsBilling,
  refusalFrom,
  useResource,
  type InvoiceRow,
  type InvoicingContext,
  type ListResponse,
  type ServerRefusal,
} from "./invoicingShared";

type Side = "all" | "owner_billing" | "subcontractor_invoice";

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreateInvoiceModal({
  open,
  onClose,
  projectId,
  context,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  context: InvoicingContext;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<"owner_billing" | "subcontractor_invoice">(
    "subcontractor_invoice",
  );
  const [contractId, setContractId] = useState("");
  const [billingPeriodId, setBillingPeriodId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [billingDate, setBillingDate] = useState("");
  const [retainagePercent, setRetainagePercent] = useState<number | null>(null);
  const [generateLines, setGenerateLines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const period = billingPeriodId ? context.periodById.get(billingPeriodId) : undefined;
  const periodRule = periodAcceptsBilling(period);

  async function submit() {
    setBusy(true);
    setRefusal(null);
    setError(null);
    try {
      const body: Record<string, unknown> = { kind, generateLines };
      if (kind === "owner_billing") body["primeContractId"] = contractId;
      else body["commitmentId"] = contractId;
      if (billingPeriodId) body["billingPeriodId"] = billingPeriodId;
      if (invoiceNumber.trim()) body["invoiceNumber"] = invoiceNumber.trim();
      if (billingDate) body["billingDate"] = billingDate;
      if (retainagePercent !== null) body["retainagePercent"] = retainagePercent;
      await api.post(`/api/v1/projects/${projectId}/invoices`, body);
      toast.success("Invoice raised with its continuation sheet.");
      setContractId("");
      setInvoiceNumber("");
      onCreated();
      onClose();
    } catch (err) {
      const parsed = refusalFrom(err);
      if (parsed) setRefusal(parsed);
      else setError(errorMessage(err, "The invoice was refused"));
    } finally {
      setBusy(false);
    }
  }

  const options =
    kind === "owner_billing"
      ? context.contracts.map((c) => ({
          id: c.id,
          text: `${c.reference} — ${c.title} (${c.currency})`,
        }))
      : context.commitments.map((c) => ({
          id: c.id,
          text: `${c.reference} — ${c.title} (${c.currency})`,
        }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Raise an invoice"
      description="Owner applications bill a prime contract's SOV; subcontractor invoices bill a commitment's. Nothing may be billed against an unsigned contract."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={!contractId || !periodRule.ok}
          >
            Raise invoice
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <RefusalPanel refusal={refusal} />

        <Field label="Direction" required>
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as "owner_billing" | "subcontractor_invoice");
              setContractId("");
            }}
          >
            <option value="subcontractor_invoice">
              Subcontractor invoice — a sub bills us (payable)
            </option>
            <option value="owner_billing">
              Owner application for payment — we bill the owner (receivable)
            </option>
          </Select>
        </Field>

        <Field
          label={kind === "owner_billing" ? "Prime contract" : "Commitment"}
          required
          hint="The schedule of values the continuation sheet is drawn from."
        >
          <Select value={contractId} onChange={(e) => setContractId(e.target.value)}>
            <option value="">Select…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.text}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Billing period"
          hint="A closed period takes no new billing; a locked one takes no writes at all."
        >
          <Select value={billingPeriodId} onChange={(e) => setBillingPeriodId(e.target.value)}>
            <option value="">Not in a period</option>
            {context.periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.reference} — {p.name} ({p.status})
              </option>
            ))}
          </Select>
        </Field>
        {!periodRule.ok && periodRule.rule ? (
          <Reasons reasons={[periodRule.rule]} tone="warning" title="That period refuses billing" />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Vendor invoice no." optional hint="As printed on their document.">
            <Input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              disabled={kind === "owner_billing"}
            />
          </Field>
          <Field label="Billing date" optional>
            <Input
              type="date"
              value={billingDate}
              onChange={(e) => setBillingDate(e.target.value)}
            />
          </Field>
          <Field
            label="Retainage %"
            optional
            hint="Overrides the SOV line rates on the generated lines."
          >
            <NumberInput
              value={retainagePercent}
              onChange={setRetainagePercent}
              precision={3}
              min={0}
              max={100}
              suffix="%"
              align="right"
            />
          </Field>
        </div>

        <label className="flex items-start gap-2 text-meta text-content-muted">
          <input
            type="checkbox"
            checked={generateLines}
            onChange={(e) => setGenerateLines(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Generate the continuation sheet from the schedule of values, snapshotting each line's
            previously-billed position. Unchecking leaves it empty for a hand-built invoice.
          </span>
        </label>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Totals per currency                                                 */
/* ------------------------------------------------------------------ */

interface CurrencyTotals {
  currency: string;
  count: number;
  gross: number;
  retainage: number;
  net: number;
  paid: number;
  outstanding: number;
}

function totalsByCurrency(rows: readonly InvoiceRow[]): CurrencyTotals[] {
  const buckets = new Map<string, CurrencyTotals>();
  for (const row of rows) {
    const key = row.currency.toUpperCase();
    const bucket = buckets.get(key) ?? {
      currency: key,
      count: 0,
      gross: 0,
      retainage: 0,
      net: 0,
      paid: 0,
      outstanding: 0,
    };
    bucket.count += 1;
    bucket.gross += row.totalCompletedAndStored;
    bucket.retainage += row.totalRetainage;
    bucket.net += row.currentPaymentDue;
    bucket.paid += row.amountPaid;
    bucket.outstanding += row.currentPaymentDue - row.amountPaid;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((b) => ({
      ...b,
      gross: Math.round(b.gross * 100) / 100,
      retainage: Math.round(b.retainage * 100) / 100,
      net: Math.round(b.net * 100) / 100,
      paid: Math.round(b.paid * 100) / 100,
      outstanding: Math.round(b.outstanding * 100) / 100,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export default function InvoicesTab({
  projectId,
  context,
  selectedInvoiceId,
  onSelectInvoice,
}: {
  projectId: string;
  context: InvoicingContext;
  selectedInvoiceId: string | null;
  onSelectInvoice: (id: string | null) => void;
}) {
  const [side, setSide] = useState<Side>("all");
  const [creating, setCreating] = useState(false);

  const invoices = useResource<ListResponse<InvoiceRow>>(
    `/api/v1/projects/${projectId}/invoices?page=1&pageSize=500`,
  );

  const rows = useMemo(() => {
    const all = invoices.data?.items ?? [];
    return side === "all" ? all : all.filter((i) => i.kind === side);
  }, [invoices.data, side]);

  const totals = useMemo(() => totalsByCurrency(rows), [rows]);

  const columns = useMemo<DataColumns<InvoiceRow>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        width: 120,
        sticky: "start",
      },
      {
        id: "kind",
        header: "Direction",
        accessor: "kind",
        type: "enum",
        width: 170,
        groupable: true,
        options: [
          {
            value: "owner_billing",
            text: KIND_LABEL["owner_billing"] ?? "Owner application",
            label: "Owner application (receivable)",
          },
          {
            value: "subcontractor_invoice",
            text: KIND_LABEL["subcontractor_invoice"] ?? "Subcontractor invoice",
            label: "Subcontractor invoice (payable)",
          },
        ],
        cell: (ctx) => (
          <Badge tone={ctx.row.kind === "owner_billing" ? "accent" : "neutral"} size="xs">
            {ctx.row.kind === "owner_billing" ? "Receivable" : "Payable"}
          </Badge>
        ),
      },
      {
        id: "counterparty",
        header: "Vendor / owner",
        accessor: (row: InvoiceRow) => context.counterparty(row),
        type: "text",
        width: 220,
      },
      {
        id: "invoiceNumber",
        header: "Their invoice no.",
        accessor: "invoiceNumber",
        type: "code",
        width: 140,
        defaultHidden: true,
      },
      {
        id: "period",
        header: "Period",
        accessor: (row: InvoiceRow) =>
          row.billingPeriodId
            ? (context.periodById.get(row.billingPeriodId)?.reference ?? row.billingPeriodId)
            : "",
        type: "code",
        width: 110,
        groupable: true,
        cell: (ctx) => {
          if (!ctx.row.billingPeriodId) {
            return <span className="text-content-subtle">not in a period</span>;
          }
          const period = context.periodById.get(ctx.row.billingPeriodId);
          if (!period) return ctx.row.billingPeriodId;
          return (
            <span className="flex items-center gap-1">
              {period.reference}
              {period.status !== "open" ? (
                <Badge tone={period.status === "locked" ? "neutral" : "warning"} size="xs">
                  {period.status}
                </Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: INVOICE_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: invoiceTone(s),
        })),
      },
      {
        id: "gross",
        header: "Gross (completed & stored)",
        accessor: "totalCompletedAndStored",
        type: "currency",
        width: 180,
        cell: (ctx) => money(ctx.row.totalCompletedAndStored, ctx.row.currency),
      },
      {
        id: "retainage",
        header: "Retainage held",
        headerTooltip: "The money everyone forgets. Held to date on this invoice.",
        accessor: "totalRetainage",
        type: "currency",
        width: 150,
        cell: (ctx) => money(ctx.row.totalRetainage, ctx.row.currency),
      },
      {
        id: "net",
        header: "Net due",
        accessor: "currentPaymentDue",
        type: "currency",
        width: 140,
        cell: (ctx) => money(ctx.row.currentPaymentDue, ctx.row.currency),
      },
      {
        id: "paid",
        header: "Paid",
        accessor: "amountPaid",
        type: "currency",
        width: 130,
        cell: (ctx) => money(ctx.row.amountPaid, ctx.row.currency),
      },
      {
        id: "outstanding",
        header: "Outstanding",
        accessor: (row: InvoiceRow) => row.currentPaymentDue - row.amountPaid,
        type: "currency",
        width: 140,
        cell: (ctx) =>
          money(ctx.row.currentPaymentDue - ctx.row.amountPaid, ctx.row.currency),
      },
      {
        id: "waiver",
        header: "Lien waiver",
        headerTooltip:
          "Whether a waiver is required on this invoice. Payment is blocked until one is received or verified.",
        accessor: (row: InvoiceRow) => (row.requiresLienWaiver === 1 ? "required" : "not required"),
        type: "enum",
        width: 130,
        options: [
          { value: "required", text: "Required", label: "Required" },
          { value: "not required", text: "Not required", label: "Not required" },
        ],
        cell: (ctx) =>
          ctx.row.requiresLienWaiver === 1 ? (
            <Badge tone="warning" size="xs">
              required
            </Badge>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "currency",
        header: "Currency",
        accessor: "currency",
        type: "text",
        width: 100,
        groupable: true,
      },
      {
        id: "billingDate",
        header: "Billing date",
        accessor: "billingDate",
        type: "date",
        width: 130,
      },
      { id: "dueDate", header: "Due", accessor: "dueDate", type: "date", width: 120 },
      {
        id: "retainagePercentWork",
        header: "Retainage %",
        accessor: "retainagePercentWork",
        type: "percent",
        width: 120,
        defaultHidden: true,
        cell: (ctx) => percent(ctx.row.retainagePercentWork),
      },
    ],
    [context],
  );

  const multiCurrency = totals.length > 1;

  return (
    <div className="space-y-3">
      <ErrorAlert message={invoices.error} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<Side>
          value={side}
          onChange={setSide}
          options={[
            { value: "all", label: "All", count: invoices.data?.items.length ?? 0 },
            {
              value: "owner_billing",
              label: "Owner applications",
              count: (invoices.data?.items ?? []).filter((i) => i.kind === "owner_billing").length,
            },
            {
              value: "subcontractor_invoice",
              label: "Subcontractor invoices",
              count: (invoices.data?.items ?? []).filter(
                (i) => i.kind === "subcontractor_invoice",
              ).length,
            },
          ]}
          aria-label="Which side of the ledger"
        />
        <Button onClick={() => setCreating(true)}>Raise invoice</Button>
      </div>

      <Card>
        <CardHeader
          title="Totals"
          subtitle={
            multiCurrency
              ? "One block per currency. These are never summed together — the platform holds no exchange rate."
              : "Across the invoices currently in view."
          }
        />
        <CardBody>
          {totals.length === 0 ? (
            <p className="text-meta text-content-muted">
              No invoices in view, so there is nothing to total. That is a fact about the filter,
              not a zero position.
            </p>
          ) : (
            <div className="space-y-2">
              {totals.map((bucket) => (
                <div
                  key={bucket.currency}
                  className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-6"
                >
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      Currency
                    </div>
                    <div className="text-body font-semibold text-content">{bucket.currency}</div>
                    <div className="text-2xs text-content-subtle">{bucket.count} invoice(s)</div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      Gross
                    </div>
                    <div className="tabular-nums text-content">
                      {money(bucket.gross, bucket.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      Retainage held
                    </div>
                    <div className="tabular-nums text-warning-fg">
                      {money(bucket.retainage, bucket.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">Net</div>
                    <div className="tabular-nums text-content">
                      {money(bucket.net, bucket.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">Paid</div>
                    <div className="tabular-nums text-content">
                      {money(bucket.paid, bucket.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      Outstanding
                    </div>
                    <div className="tabular-nums font-semibold text-content">
                      {money(bucket.outstanding, bucket.currency)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {side === "all" && totals.length > 0 ? (
        <Alert tone="info" variant="subtle" size="sm" title="Receivables and payables are both in view">
          The totals above mix money owed TO us with money we owe. Switch to one side to read a
          single position — they are the same arithmetic but opposite signs of the same ledger.
        </Alert>
      ) : null}

      <DataTable<InvoiceRow>
        tableId={`invoicing:invoices:${projectId}`}
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={invoices.loading}
        error={invoices.error}
        onRetry={invoices.reload}
        height={620}
        stickyHeader
        showFooter={!multiCurrency}
        filterRow
        savedViews
        exportFileName={`invoices-${projectId}`}
        searchPlaceholder="Search invoices…"
        aria-label="Invoice register"
        defaultSort={[{ id: "billingDate", desc: true }]}
        onRowClick={(ctx) => onSelectInvoice(ctx.row.id)}
        rowTone={(row) => invoiceTone(row.status)}
        builtInViews={[
          {
            id: "approved-unpaid",
            name: "Approved, unpaid",
            builtIn: true,
            state: {
              columnFilters: [{ id: "status", value: ["approved", "approved_as_noted"] }],
              sorting: [{ id: "outstanding", desc: true }],
            },
          },
          {
            id: "retainage",
            name: "Retainage held",
            builtIn: true,
            state: { sorting: [{ id: "retainage", desc: true }] },
          },
          {
            id: "waiver-required",
            name: "Waiver required",
            builtIn: true,
            state: { columnFilters: [{ id: "waiver", value: ["required"] }] },
          },
        ]}
        empty={{
          icon: IconInvoice,
          title: "No invoices",
          description:
            "Nothing has been billed on this project yet — in either direction. Raise an owner application or record a subcontractor invoice.",
          action: <Button onClick={() => setCreating(true)}>Raise an invoice</Button>,
        }}
      />

      <CreateInvoiceModal
        open={creating}
        onClose={() => setCreating(false)}
        projectId={projectId}
        context={context}
        onCreated={() => {
          invoices.reload();
          context.reload();
        }}
      />

      {selectedInvoiceId ? (
        <InvoiceDrawer
          invoiceId={selectedInvoiceId}
          onClose={() => onSelectInvoice(null)}
          onChanged={() => {
            invoices.reload();
            context.reload();
          }}
          context={context}
        />
      ) : null}

      <p className="text-2xs text-content-subtle">
        CSV export writes exactly what the table shows, including the currency column — an export
        that drops the currency is how a spreadsheet ends up summing dollars and euros.{" "}
        {invoices.data ? `${invoices.data.total} invoice(s) on this project.` : ""}
      </p>
    </div>
  );
}
