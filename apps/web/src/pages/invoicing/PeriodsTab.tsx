/**
 * BILLING PERIODS — the month, as an object.
 *
 * A period defines the window subs may submit in, the date work is billed
 * THROUGH, and when the owner application goes out. Its three states are a
 * rule, not an error condition, and this screen states the rule up front:
 *
 *   open    billing is accepted
 *   closed  no NEW billing; the month is settled but can be reopened
 *   locked  no writes at all, ever; the figures are the citable basis of a
 *           published cost report and are never reopened
 *
 * Closing over an invoice that is still mid-flight strands it — it can neither
 * be approved into the closed period nor moved out of it silently — so the
 * server names those invoices and refuses. Forcing the close is possible and
 * says exactly what it stranded.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Textarea,
} from "../../ui";
import { ConfirmDialog, Drawer, DrawerBody, Modal, toast } from "../../ui/overlays";
import { DataTable, DescriptionList, type DataColumns } from "../../ui/data";
import { IconCalendar, IconLock } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  BILLING_PERIOD_STATUSES,
  PanelSkeleton,
  Reasons,
  RefusalPanel,
  errorMessage,
  invoiceTone,
  isoDate,
  isoDateTime,
  label,
  money,
  periodTone,
  refusalFrom,
  useResource,
  type BillingPeriodRow,
  type CurrentPeriodResponse,
  type InvoicingContext,
  type PeriodDetail,
  type ServerRefusal,
} from "./invoicingShared";

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreatePeriodModal({
  open,
  onClose,
  projectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [billingDate, setBillingDate] = useState("");
  const [submitStart, setSubmitStart] = useState("");
  const [submitEnd, setSubmitEnd] = useState("");
  const [ownerBillingDate, setOwnerBillingDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), startDate, endDate };
      if (billingDate) body["billingDate"] = billingDate;
      if (submitStart) body["subcontractorSubmitStart"] = submitStart;
      if (submitEnd) body["subcontractorSubmitEnd"] = submitEnd;
      if (ownerBillingDate) body["ownerBillingDate"] = ownerBillingDate;
      if (dueDate) body["dueDate"] = dueDate;
      await api.post(`/api/v1/projects/${projectId}/billing-periods`, body);
      toast.success("Billing period opened.");
      setName("");
      onCreated();
      onClose();
    } catch (err) {
      const parsed = refusalFrom(err);
      if (parsed) setRefusal(parsed);
      else setError(errorMessage(err, "The period could not be opened"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open a billing period"
      description="Periods must not overlap — overlapping periods let the same work be billed twice, and the server refuses them by name."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={!name.trim() || !startDate || !endDate}
          >
            Open period
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <RefusalPanel refusal={refusal} />
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="March 2026"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Start" required>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="End" required>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          <Field
            label="Billed through"
            optional
            hint="The date every SOV line measures to. Defaults to the end date."
          >
            <Input
              type="date"
              value={billingDate}
              onChange={(e) => setBillingDate(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Subs may submit from" optional>
            <Input
              type="date"
              value={submitStart}
              onChange={(e) => setSubmitStart(e.target.value)}
            />
          </Field>
          <Field label="Subs must submit by" optional>
            <Input type="date" value={submitEnd} onChange={(e) => setSubmitEnd(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Owner application due out" optional>
            <Input
              type="date"
              value={ownerBillingDate}
              onChange={(e) => setOwnerBillingDate(e.target.value)}
            />
          </Field>
          <Field label="Payment due" optional>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function PeriodDrawer({
  periodId,
  onClose,
  onChanged,
  context,
}: {
  periodId: string;
  onClose: () => void;
  onChanged: () => void;
  context: InvoicingContext;
}) {
  const detail = useResource<PeriodDetail>(`/api/v1/billing-periods/${periodId}`);
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [forceClose, setForceClose] = useState(false);
  const [locking, setLocking] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [stranded, setStranded] = useState<string[] | null>(null);

  const period = detail.data;

  async function act(path: string, body?: unknown, success?: string) {
    setError(null);
    setRefusal(null);
    try {
      const response = await api.post<{ strandedInvoices?: Array<{ reference: string }> }>(
        `/api/v1/billing-periods/${periodId}/${path}`,
        body ?? {},
      );
      toast.success(success ?? "Done.");
      if (response && Array.isArray(response.strandedInvoices) && response.strandedInvoices.length) {
        setStranded(response.strandedInvoices.map((i) => i.reference));
      }
      detail.reload();
      onChanged();
      return true;
    } catch (err) {
      const parsed = refusalFrom(err);
      if (parsed) setRefusal(parsed);
      else setError(errorMessage(err, "The action was refused"));
      return false;
    }
  }

  /** Per-currency billed totals, from the invoices the period actually holds. */
  const byCurrency = useMemo(() => {
    const buckets = new Map<
      string,
      { currency: string; owner: number; sub: number; retainage: number; count: number }
    >();
    for (const invoice of period?.invoices ?? []) {
      const key = invoice.currency.toUpperCase();
      const bucket = buckets.get(key) ?? {
        currency: key,
        owner: 0,
        sub: 0,
        retainage: 0,
        count: 0,
      };
      if (invoice.kind === "owner_billing") bucket.owner += invoice.totalCompletedAndStored;
      else bucket.sub += invoice.totalCompletedAndStored;
      bucket.retainage += invoice.totalRetainage;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }, [period]);

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={period ? `${period.reference} — ${period.name}` : "Billing period"}
      description={
        period
          ? `${label(period.status)} · billed through ${isoDate(period.billingDate)}`
          : undefined
      }
      icon={IconCalendar}
    >
      <DrawerBody>
        {detail.loading && !detail.data ? (
          <PanelSkeleton rows={5} />
        ) : detail.error ? (
          <ErrorAlert message={detail.error} />
        ) : period ? (
          <div className="space-y-4">
            <ErrorAlert message={error} />
            <RefusalPanel refusal={refusal} />
            {stranded ? (
              <Reasons
                reasons={[
                  `Closed with force. These invoices were stranded in the closed period and can no longer move: ${stranded.join(", ")}.`,
                ]}
                tone="warning"
                title="Invoices stranded by the forced close"
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={periodTone(period.status)}>{label(period.status)}</Badge>
              {period.status === "locked" ? (
                <Badge tone="neutral" icon={IconLock} variant="outline">
                  frozen {isoDateTime(period.lockedAt)}
                </Badge>
              ) : null}
              {period.status === "closed" ? (
                <span className="text-2xs text-content-subtle">
                  closed {isoDateTime(period.closedAt)}
                </span>
              ) : null}
            </div>

            <Alert
              tone={period.status === "open" ? "info" : "warning"}
              variant="subtle"
              size="sm"
              title={
                period.status === "open"
                  ? "This period accepts billing"
                  : period.status === "closed"
                    ? "A closed period takes no new billing"
                    : "A locked period takes no writes at all"
              }
            >
              {period.status === "open"
                ? "Invoices may be raised, submitted and approved into it."
                : period.status === "closed"
                  ? "That is the rule, not an error: it is what makes this month's cost report reproducible a year from now. Reopen it, or bill into the next period."
                  : "Locking is one-way and only from closed. Everything downstream — the cost report, the budget snapshot, the owner's certified position — is allowed to assume these figures never move again."}
            </Alert>

            <Card>
              <CardHeader title="Dates" subtitle="Every one of them is load-bearing." />
              <CardBody>
                <DescriptionList
                  columns={3}
                  items={[
                    { label: "Period", value: `${isoDate(period.startDate)} – ${isoDate(period.endDate)}` },
                    {
                      label: "Billed through",
                      value: isoDate(period.billingDate),
                      hint: "what every SOV line measures to",
                    },
                    { label: "Owner application due", value: isoDate(period.ownerBillingDate) },
                    {
                      label: "Sub submission window",
                      value:
                        period.subcontractorSubmitStart || period.subcontractorSubmitEnd
                          ? `${isoDate(period.subcontractorSubmitStart)} – ${isoDate(period.subcontractorSubmitEnd)}`
                          : "not set",
                    },
                    { label: "Payment due", value: isoDate(period.dueDate) },
                    { label: "Invoices", value: String(period.invoiceCount) },
                  ]}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Billed in this period"
                subtitle="One block per currency. Nothing is summed across them."
              />
              <CardBody>
                {byCurrency.length === 0 ? (
                  <EmptyState
                    size="sm"
                    title="No invoices in this period"
                    hint="Nothing has been billed into it yet. That is a fact about the period, not a zero."
                  />
                ) : (
                  <div className="space-y-3">
                    {byCurrency.map((bucket) => (
                      <div key={bucket.currency} className="rounded-md border border-border p-3">
                        <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                          {bucket.currency} · {bucket.count} invoice(s)
                        </div>
                        <DescriptionList
                          columns={3}
                          size="sm"
                          items={[
                            {
                              label: "Owner applications",
                              value: money(bucket.owner, bucket.currency),
                            },
                            {
                              label: "Subcontractor invoices",
                              value: money(bucket.sub, bucket.currency),
                            },
                            {
                              label: "Retainage held",
                              value: money(bucket.retainage, bucket.currency),
                            },
                          ]}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Invoices in this period"
                subtitle="An invoice that is neither approved nor rejected blocks the close."
              />
              <CardBody>
                {period.invoices.length === 0 ? (
                  <EmptyState size="sm" title="No invoices" />
                ) : (
                  <ul className="space-y-1">
                    {period.invoices.map((invoice) => (
                      <li
                        key={invoice.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-2xs text-content-subtle">
                            {invoice.reference}
                          </span>
                          <span className="text-content">
                            {invoice.kind === "owner_billing"
                              ? "Owner application"
                              : (context.vendorName(invoice.vendorId) ?? "Subcontractor")}
                          </span>
                          <Badge tone={invoiceTone(invoice.status)} size="xs">
                            {label(invoice.status)}
                          </Badge>
                        </span>
                        <span className="tabular-nums text-content">
                          {money(invoice.currentPaymentDue, invoice.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {period.status === "open" ? (
                <>
                  <Button size="sm" onClick={() => setClosing(true)}>
                    Close period
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void act("recalculate", {}, "Rollups re-derived.")}
                  >
                    Recalculate rollups
                  </Button>
                </>
              ) : null}
              {period.status === "closed" ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setReopening(true)}>
                    Reopen
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setLocking(true)}>
                    Lock permanently
                  </Button>
                </>
              ) : null}
              {period.status === "locked" ? (
                <p className="text-meta text-content-muted">
                  A locked period is never reopened. Open a new period instead.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </DrawerBody>

      <ConfirmDialog
        open={closing}
        onClose={() => {
          setClosing(false);
          setForceClose(false);
        }}
        title="Close this billing period?"
        description="Closing stops new billing. The server refuses to close over invoices that are still mid-flight and names them; closing with force strands them deliberately and records which ones."
        confirmLabel={forceClose ? "Close with force" : "Close period"}
        tone={forceClose ? "danger" : "warning"}
        onConfirm={async () => {
          const ok = await act(
            "close",
            forceClose ? { force: true } : {},
            "Billing period closed.",
          );
          if (ok) {
            setClosing(false);
            setForceClose(false);
          }
          return ok;
        }}
      >
        <label className="mt-2 flex items-start gap-2 text-meta text-content-muted">
          <input
            type="checkbox"
            checked={forceClose}
            onChange={(e) => setForceClose(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Close even though invoices are still mid-flight. They will be stranded — neither
            approvable into this period nor movable out of it — and the close records exactly which.
          </span>
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={locking}
        onClose={() => setLocking(false)}
        title="Lock this period permanently?"
        description="Locking is one-way. Nothing in this period can ever be written again, and the whole platform is allowed to treat these figures as fixed. This is what makes a published monthly cost report citable — and it cannot be undone."
        destructive
        confirmLabel="Lock permanently"
        confirmationText={period?.reference}
        confirmationLabel={`Type ${period?.reference ?? "the reference"} to confirm`}
        onConfirm={async () => {
          const ok = await act("lock", {}, "Billing period locked.");
          if (ok) setLocking(false);
          return ok;
        }}
      />

      <Modal
        open={reopening}
        onClose={() => setReopening(false)}
        title="Reopen this billing period"
        description="Reopening a closed month changes numbers people may already have reported. The reason is required and goes on the ledger."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReopening(false)}>
              Cancel
            </Button>
            <Button
              disabled={!reopenReason.trim()}
              onClick={async () => {
                const ok = await act(
                  "reopen",
                  { reason: reopenReason.trim() },
                  "Billing period reopened.",
                );
                if (ok) {
                  setReopening(false);
                  setReopenReason("");
                }
              }}
            >
              Reopen period
            </Button>
          </>
        }
      >
        <Field label="Why is it being reopened?" required>
          <Textarea
            rows={4}
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
          />
        </Field>
      </Modal>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export default function PeriodsTab({
  projectId,
  context,
  selectedPeriodId,
  onSelectPeriod,
}: {
  projectId: string;
  context: InvoicingContext;
  selectedPeriodId: string | null;
  onSelectPeriod: (id: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);
  const current = useResource<CurrentPeriodResponse>(
    `/api/v1/projects/${projectId}/billing-periods/current`,
  );

  /**
   * The stored period rollups are summed across every currency billed into the
   * period, so they only carry a currency when the project bills in exactly
   * one. Otherwise they are rendered with the currency named as unknown rather
   * than labelled with a currency they are not actually in.
   */
  const rollupCurrency = context.currencies.length === 1 ? (context.currencies[0] ?? null) : null;

  const columns = useMemo<DataColumns<BillingPeriodRow>>(
    () => [
      {
        id: "reference",
        header: "Period",
        accessor: "reference",
        type: "code",
        width: 100,
        sticky: "start",
      },
      { id: "name", header: "Name", accessor: "name", type: "text", width: 180 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 110,
        groupable: true,
        options: BILLING_PERIOD_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: periodTone(s),
        })),
      },
      { id: "startDate", header: "Start", accessor: "startDate", type: "date", width: 120 },
      { id: "endDate", header: "End", accessor: "endDate", type: "date", width: 120 },
      {
        id: "billingDate",
        header: "Billed through",
        headerTooltip: "The cutoff every schedule-of-values line measures to.",
        accessor: "billingDate",
        type: "date",
        width: 140,
      },
      {
        id: "submitWindow",
        header: "Sub submission window",
        accessor: (row: BillingPeriodRow) =>
          row.subcontractorSubmitStart ?? row.subcontractorSubmitEnd ?? "",
        type: "text",
        width: 200,
        cell: (ctx) =>
          ctx.row.subcontractorSubmitStart || ctx.row.subcontractorSubmitEnd ? (
            `${isoDate(ctx.row.subcontractorSubmitStart)} – ${isoDate(ctx.row.subcontractorSubmitEnd)}`
          ) : (
            <span className="text-content-subtle">not set</span>
          ),
      },
      {
        id: "ownerBillingDate",
        header: "Owner app due",
        accessor: "ownerBillingDate",
        type: "date",
        width: 130,
      },
      {
        id: "invoiceCount",
        header: "Invoices",
        accessor: "invoiceCount",
        type: "number",
        width: 100,
        aggregate: "sum",
      },
      {
        id: "ownerBilledAmount",
        header: "Owner billed",
        headerTooltip:
          "A period rollup, stored per period across every currency billed into it. It carries a currency only when the project bills in exactly one — otherwise the per-currency split inside the period is the figure to read.",
        accessor: "ownerBilledAmount",
        type: "currency",
        width: 140,
        cell: (ctx) => money(ctx.row.ownerBilledAmount, rollupCurrency),
      },
      {
        id: "subcontractorBilledAmount",
        header: "Sub billed",
        accessor: "subcontractorBilledAmount",
        type: "currency",
        width: 140,
        defaultHidden: true,
        cell: (ctx) => money(ctx.row.subcontractorBilledAmount, rollupCurrency),
      },
      {
        id: "retainageHeldAmount",
        header: "Retainage held",
        accessor: "retainageHeldAmount",
        type: "currency",
        width: 140,
        cell: (ctx) => money(ctx.row.retainageHeldAmount, rollupCurrency),
      },
    ],
    [rollupCurrency],
  );

  return (
    <div className="space-y-3">
      <ErrorAlert message={context.error} />

      <Card>
        <CardHeader
          title="The period billing lands in right now"
          subtitle="What a 'bill now' action would use, and why."
          actions={<Button onClick={() => setCreating(true)}>Open a period</Button>}
        />
        <CardBody>
          {current.loading && !current.data ? (
            <PanelSkeleton rows={2} />
          ) : current.error ? (
            <ErrorAlert message={current.error} />
          ) : current.data ? (
            <div className="space-y-2">
              {current.data.period ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={periodTone(current.data.period.status)}>
                    {current.data.period.reference}
                  </Badge>
                  <span className="text-body text-content">{current.data.period.name}</span>
                  <span className="text-meta text-content-muted">
                    billed through {isoDate(current.data.period.billingDate)} ·{" "}
                    {current.data.openCount} open period(s)
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onSelectPeriod(current.data!.period!.id)}
                  >
                    Open
                  </Button>
                </div>
              ) : (
                <p className="text-body text-content">No open billing period.</p>
              )}
              <Reasons reasons={current.data.reasons} tone="warning" />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {context.currencies.length > 1 ? (
        <Reasons
          reasons={[
            `This project bills in ${context.currencies.join(", ")}. The period rollup columns below are stored per period across all of them; the per-currency split is inside each period.`,
          ]}
          tone="warning"
          title="Mixed currency"
        />
      ) : null}

      <DataTable<BillingPeriodRow>
        tableId={`invoicing:periods:${projectId}`}
        data={context.periods}
        columns={columns}
        getRowId={(row) => row.id}
        loading={context.loading}
        error={context.error}
        onRetry={context.reload}
        height={520}
        stickyHeader
        filterRow
        savedViews
        exportFileName={`billing-periods-${projectId}`}
        searchPlaceholder="Search periods…"
        aria-label="Billing periods"
        defaultSort={[{ id: "reference", desc: true }]}
        onRowClick={(ctx) => onSelectPeriod(ctx.row.id)}
        rowTone={(row) => periodTone(row.status)}
        empty={{
          icon: IconCalendar,
          title: "No billing periods",
          description:
            "Nothing can be billed until a period exists. Periods must not overlap — that is what stops the same work being billed twice.",
          action: <Button onClick={() => setCreating(true)}>Open the first period</Button>,
        }}
        toolbarActions={<Button onClick={() => setCreating(true)}>Open period</Button>}
      />

      <CreatePeriodModal
        open={creating}
        onClose={() => setCreating(false)}
        projectId={projectId}
        onCreated={() => {
          context.reload();
          current.reload();
        }}
      />

      {selectedPeriodId ? (
        <PeriodDrawer
          periodId={selectedPeriodId}
          onClose={() => onSelectPeriod(null)}
          onChanged={() => {
            context.reload();
            current.reload();
          }}
          context={context}
        />
      ) : null}
    </div>
  );
}
