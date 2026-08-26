/**
 * RFQ TO SUBCONTRACTORS — how a PCO gets a real number.
 *
 * The comparison is deliberately blunt about what it does NOT know. With no
 * returned quote the lowest is `null` with a reason, not 0.00 — a screen that
 * renders 0.00 for "nobody has answered" is how a PM signs a change order
 * believing it was competitively priced.
 *
 * Coverage is printed beside the numbers: requested, responded, outstanding,
 * declined. The commonest cause of a change order stalling is a sub who never
 * answered, and that has to be visible as a count and a number of days, not
 * as a memory.
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
  Select,
  Textarea,
} from "../../ui";
import { ConfirmDialog, Drawer, DrawerBody, Modal, toast } from "../../ui/overlays";
import { DataTable, type DataColumns } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconSend, IconVendor } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  ComponentValue,
  PanelSkeleton,
  QUOTE_REQUEST_STATUSES,
  Reasons,
  days,
  daysSince,
  errorMessage,
  isoDate,
  label,
  money,
  num,
  quoteTone,
  useResource,
  type ChangeChain,
  type ChangeContext,
  type PcoDetail,
  type QuoteComparison,
  type QuoteRow,
} from "./changesShared";

/* ------------------------------------------------------------------ */
/* Issue an RFQ                                                        */
/* ------------------------------------------------------------------ */

function IssueRfqModal({
  open,
  onClose,
  projectId,
  pcoId,
  context,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  pcoId: string;
  context: ChangeContext;
  onIssued: () => void;
}) {
  const [vendorId, setVendorId] = useState("");
  const [title, setTitle] = useState("");
  const [scopeDescription, setScope] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [copyPcoLines, setCopyPcoLines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { vendorId, copyPcoLines };
      if (title.trim()) body["title"] = title.trim();
      if (scopeDescription.trim()) body["scopeDescription"] = scopeDescription.trim();
      if (dueDate) body["dueDate"] = dueDate;
      await api.post(
        `/api/v1/projects/${projectId}/potential-change-orders/${pcoId}/quote-requests`,
        body,
      );
      toast.success("Quote request raised.");
      setVendorId("");
      setTitle("");
      setScope("");
      onIssued();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "The quote request was refused"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request a quote"
      description="The scope goes out to the subcontractor with a due date. Their answer becomes the PCO's quoted amount when it is accepted."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!vendorId}>
            Raise RFQ
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <Field label="Subcontractor" required>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Select a vendor…</option>
            {context.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" optional>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Scope sent out" optional>
          <Textarea rows={4} value={scopeDescription} onChange={(e) => setScope(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Quote due by" optional hint="Days outstanding are measured from this.">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Cost breakdown">
            <label className="flex items-center gap-2 text-meta text-content-muted">
              <input
                type="checkbox"
                checked={copyPcoLines}
                onChange={(e) => setCopyPcoLines(e.target.checked)}
              />
              Send the PCO's own breakdown out with the request
            </label>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Record a returned quote                                             */
/* ------------------------------------------------------------------ */

function RecordQuoteModal({
  open,
  onClose,
  projectId,
  quote,
  currency,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  quote: QuoteRow | null;
  currency: string | null;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState<number | null>(null);
  const [impactDays, setImpactDays] = useState<number | null>(null);
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!quote || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { quotedAmount: amount };
      if (impactDays !== null) body["quotedScheduleImpactDays"] = impactDays;
      if (validUntil) body["quoteValidUntil"] = validUntil;
      if (notes.trim()) body["quoteNotes"] = notes.trim();
      await api.post(`/api/v1/projects/${projectId}/quote-requests/${quote.id}/quote`, body);
      toast.success(`Quote recorded against ${quote.reference}.`);
      setAmount(null);
      setImpactDays(null);
      setNotes("");
      onRecorded();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "The quote could not be recorded"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={quote ? `Record the quote returned on ${quote.reference}` : "Record a quote"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={amount === null}>
            Record quote
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <Field label={`Quoted amount${currency ? ` (${currency})` : ""}`} required>
          <NumberInput value={amount} onChange={setAmount} precision={2} align="right" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Days claimed by the sub" optional>
            <NumberInput
              value={impactDays}
              onChange={setImpactDays}
              min={0}
              precision={0}
              suffix="d"
            />
          </Field>
          <Field
            label="Quote valid until"
            optional
            hint="An expired quote cannot be accepted — the API refuses to bind a sub to a lapsed price."
          >
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes / qualifications" optional>
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

function ComparisonDrawer({
  projectId,
  pcoId,
  onClose,
  onChanged,
  context,
}: {
  projectId: string;
  pcoId: string;
  onClose: () => void;
  onChanged: () => void;
  context: ChangeContext;
}) {
  const comparison = useResource<QuoteComparison>(
    `/api/v1/projects/${projectId}/potential-change-orders/${pcoId}/quote-comparison`,
  );
  const pcoDetail = useResource<PcoDetail>(
    `/api/v1/projects/${projectId}/potential-change-orders/${pcoId}`,
  );
  const [issuing, setIssuing] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The comparison is scoped to one PCO, and a PCO's currency is the currency
   * of the commitment it prices — read from the record, never assumed from the
   * project. When neither a commitment nor a contract is attached the figures
   * are printed with the currency named as unknown rather than guessed.
   */
  const currency =
    context.commitmentCurrency(pcoDetail.data?.pco.commitmentId ?? null) ??
    context.contractCurrency(pcoDetail.data?.pco.primeContractId ?? null);

  const data = comparison.data;

  async function accept(quoteId: string) {
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/quote-requests/${quoteId}/accept`, {});
      toast.success("Quote accepted — it is now the PCO's position.");
      comparison.reload();
      onChanged();
      return true;
    } catch (err) {
      setError(errorMessage(err, "The quote could not be accepted"));
      return false;
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={data ? `Quote comparison — ${data.reference}` : "Quote comparison"}
      description="Side by side, ranked cheapest first, with the coverage of the tender printed beside it."
      icon={IconVendor}
      headerActions={
        <Button size="sm" icon={IconSend} onClick={() => setIssuing(true)}>
          Request another quote
        </Button>
      }
    >
      <DrawerBody>
        {comparison.loading && !data ? (
          <PanelSkeleton rows={5} />
        ) : comparison.error ? (
          <ErrorAlert message={comparison.error} />
        ) : data ? (
          <div className="space-y-4">
            <ErrorAlert message={error} />

            <Alert tone="info" variant="subtle" size="sm" title="Recommendation">
              {data.recommendation}
            </Alert>

            <Card>
              <CardHeader
                title="Coverage"
                subtitle="How much of the tender actually came back. This is the number that says whether 'competitively priced' is a fact or a hope."
              />
              <CardBody>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {(
                    [
                      ["Requested", data.coverage.requested],
                      ["Responded", data.coverage.responded],
                      ["Outstanding", data.coverage.outstanding],
                      ["Declined", data.coverage.declined],
                      ["Accepted", data.coverage.accepted],
                    ] as const
                  ).map(([name, value]) => (
                    <div key={name}>
                      <div className="text-2xs uppercase tracking-wide text-content-subtle">
                        {name}
                      </div>
                      <div className="text-h4 tabular-nums text-content">{value}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid gap-3 border-t border-border-subtle pt-3 sm:grid-cols-4">
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      Our estimate
                    </div>
                    <div className="tabular-nums text-content">
                      {money(data.estimatedAmount, currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      Lowest
                    </div>
                    <ComponentValue component={data.lowest} currency={currency} />
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      Highest
                    </div>
                    <ComponentValue component={data.highest} currency={currency} />
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">
                      Spread
                    </div>
                    <ComponentValue component={data.spread} currency={currency} />
                  </div>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Quotes, side by side"
                subtitle="Rank 1 is the cheapest quote that actually came back. A vendor who has not answered has no rank — they are not cheap, they are absent."
              />
              <CardBody className="overflow-x-auto">
                {data.quotes.length === 0 ? (
                  <EmptyState
                    size="sm"
                    title="No RFQ has been issued against this PCO"
                    hint="Our own estimate is the only number on the record. That is a position, not a price."
                    action={
                      <Button size="sm" onClick={() => setIssuing(true)}>
                        Request a quote
                      </Button>
                    }
                  />
                ) : (
                  <table className="w-full min-w-[52rem] text-meta">
                    <thead>
                      <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
                        <th className="py-1.5 pr-3 text-left font-semibold">Rank</th>
                        <th className="py-1.5 pr-3 text-left font-semibold">Vendor</th>
                        <th className="py-1.5 pr-3 text-left font-semibold">RFQ</th>
                        <th className="py-1.5 pr-3 text-left font-semibold">Status</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Quoted</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">vs estimate</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">vs lowest</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Days claimed</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Turnaround</th>
                        <th className="py-1.5 text-right font-semibold" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {data.quotes.map((quote) => (
                        <tr key={quote.id} className="align-top">
                          <td className="py-2 pr-3 tabular-nums text-content">
                            {quote.rank ?? "—"}
                          </td>
                          <td className="py-2 pr-3 text-content">
                            {quote.vendorName ?? "Vendor not named"}
                          </td>
                          <td className="py-2 pr-3 font-mono text-2xs text-content-subtle">
                            {quote.reference}
                          </td>
                          <td className="py-2 pr-3">
                            <Badge tone={quoteTone(quote.status)} size="xs">
                              {label(quote.status)}
                            </Badge>
                            {quote.expired ? (
                              <Badge tone="warning" size="xs" className="ml-1">
                                expired {isoDate(quote.quoteValidUntil)}
                              </Badge>
                            ) : null}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-content">
                            {quote.quotedAmount === null ? (
                              <span className="text-content-subtle italic">no answer</span>
                            ) : (
                              money(quote.quotedAmount, currency)
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            <ComponentValue
                              component={quote.varianceAgainstEstimate}
                              currency={currency}
                            />
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            <ComponentValue
                              component={quote.varianceAgainstLowest}
                              currency={currency}
                            />
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-content">
                            {quote.quotedScheduleImpactDays === null
                              ? "—"
                              : days(quote.quotedScheduleImpactDays)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-content">
                            {quote.turnaroundDays === null ? "—" : `${num(quote.turnaroundDays, 1)} d`}
                          </td>
                          <td className="py-2 text-right">
                            {quote.status === "quoted" && !quote.expired ? (
                              <Button size="xs" onClick={() => setAccepting(quote.id)}>
                                Select
                              </Button>
                            ) : quote.status === "accepted" ? (
                              <Badge tone="success" size="xs">
                                selected
                              </Badge>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardBody>
            </Card>
          </div>
        ) : null}
      </DrawerBody>

      <IssueRfqModal
        open={issuing}
        onClose={() => setIssuing(false)}
        projectId={projectId}
        pcoId={pcoId}
        context={context}
        onIssued={() => {
          comparison.reload();
          onChanged();
        }}
      />

      <ConfirmDialog
        open={accepting !== null}
        onClose={() => setAccepting(null)}
        title="Select this quote?"
        description="Accepting writes the subcontractor's number onto the PCO as both the quoted amount and the position carried forward. Our own estimate stays beside it, so the variance is still visible after the fact. One PCO carries one price — every other quote on this PCO is superseded."
        confirmLabel="Select this quote"
        onConfirm={async () => {
          if (!accepting) return false;
          const ok = await accept(accepting);
          if (ok) setAccepting(null);
          return ok;
        }}
      />
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export default function QuotesTab({
  projectId,
  chain,
  context,
  comparisonPcoId,
  onOpenComparison,
}: {
  projectId: string;
  chain: ChangeChain;
  context: ChangeContext;
  comparisonPcoId: string | null;
  onOpenComparison: (pcoId: string | null) => void;
}) {
  const [recording, setRecording] = useState<QuoteRow | null>(null);

  const pcoById = useMemo(() => new Map(chain.pcos.map((p) => [p.id, p])), [chain.pcos]);

  const currencyOf = (row: QuoteRow): string | null => {
    const pco = row.potentialChangeOrderId ? pcoById.get(row.potentialChangeOrderId) : undefined;
    return (
      context.commitmentCurrency(row.commitmentId ?? pco?.commitmentId ?? null) ??
      context.contractCurrency(pco?.primeContractId ?? null)
    );
  };

  const columns = useMemo<DataColumns<QuoteRow>>(
    () => [
      {
        id: "reference",
        header: "RFQ",
        accessor: "reference",
        type: "code",
        width: 110,
        sticky: "start",
      },
      {
        id: "vendor",
        header: "Subcontractor",
        accessor: (row: QuoteRow) => context.vendorName(row.vendorId) ?? "",
        type: "text",
        width: 200,
        cell: (ctx) =>
          context.vendorName(ctx.row.vendorId) ?? (
            <span className="text-content-subtle">not named</span>
          ),
      },
      {
        id: "pco",
        header: "Against PCO",
        accessor: (row: QuoteRow) =>
          row.potentialChangeOrderId
            ? (pcoById.get(row.potentialChangeOrderId)?.reference ?? row.potentialChangeOrderId)
            : "",
        type: "code",
        width: 120,
      },
      { id: "title", header: "Scope", accessor: "title", type: "text", width: 240 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        options: QUOTE_REQUEST_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: quoteTone(s),
        })),
      },
      {
        id: "quotedAmount",
        header: "Quoted",
        accessor: "quotedAmount",
        type: "currency",
        width: 130,
        cell: (ctx) =>
          ctx.row.quotedAmount === null ? (
            <span className="text-content-subtle italic" title="The subcontractor has not answered.">
              no answer
            </span>
          ) : (
            money(ctx.row.quotedAmount, currencyOf(ctx.row))
          ),
      },
      {
        id: "quotedScheduleImpactDays",
        header: "Days claimed",
        accessor: "quotedScheduleImpactDays",
        type: "number",
        width: 120,
      },
      { id: "dueDate", header: "Quote due", accessor: "dueDate", type: "date", width: 120 },
      {
        id: "outstanding",
        header: "Days outstanding",
        headerTooltip:
          "Measured from the day the RFQ was sent. The commonest cause of a change order stalling is a sub who never answered.",
        accessor: (row: QuoteRow) =>
          row.sentAt && !row.respondedAt ? (daysSince(row.sentAt) ?? null) : null,
        type: "number",
        width: 140,
        cell: (ctx) => {
          if (ctx.row.respondedAt) return <span className="text-content-subtle">answered</span>;
          if (!ctx.row.sentAt) return <span className="text-content-subtle">not sent</span>;
          const outstanding = daysSince(ctx.row.sentAt);
          if (outstanding === null) return <span className="text-content-subtle">—</span>;
          return (
            <Badge tone={outstanding > 14 ? "danger" : outstanding > 7 ? "warning" : "neutral"} size="xs">
              {outstanding} d
            </Badge>
          );
        },
      },
      {
        id: "quoteValidUntil",
        header: "Valid until",
        accessor: "quoteValidUntil",
        type: "date",
        width: 120,
        cell: (ctx) =>
          ctx.row.quoteValidUntil ? (
            <span className={ctx.row.expired ? "text-warning-fg" : undefined}>
              {isoDate(ctx.row.quoteValidUntil)}
            </span>
          ) : (
            "—"
          ),
      },
    ],
    [context, pcoById],
  );

  return (
    <div className="space-y-3">
      <ErrorAlert message={chain.error} />

      <Alert tone="info" variant="subtle" size="sm" title="An RFQ is raised against a PCO">
        A quote with nothing to attach to has nothing to become. Open a PCO and request a quote from
        there, or use the comparison below on a PCO that already has one.
      </Alert>

      <DataTable<QuoteRow>
        tableId={`changes:quotes:${projectId}`}
        data={chain.quotes}
        columns={columns}
        getRowId={(row) => row.id}
        loading={chain.loading}
        onRetry={chain.reload}
        height={560}
        stickyHeader
        filterRow
        savedViews
        exportFileName={`quote-requests-${projectId}`}
        searchPlaceholder="Search RFQs…"
        aria-label="Quote requests"
        defaultSort={[{ id: "reference", desc: true }]}
        rowTone={(row) => quoteTone(row.status)}
        rowActions={(row) => [
          {
            id: "compare",
            label: "Compare quotes on this PCO",
            disabled: !row.potentialChangeOrderId,
            onSelect: () => {
              if (row.potentialChangeOrderId) onOpenComparison(row.potentialChangeOrderId);
            },
          },
          {
            id: "send",
            label: "Mark as sent",
            disabled: row.status !== "draft",
            onSelect: () => {
              void api
                .post(`/api/v1/projects/${projectId}/quote-requests/${row.id}/send`, {})
                .then(() => {
                  toast.success(`${row.reference} sent.`);
                  chain.reload();
                })
                .catch((err: unknown) =>
                  toast.error(errorMessage(err, "The RFQ could not be sent")),
                );
            },
          },
          {
            id: "record",
            label: "Record the returned quote",
            disabled: !["sent", "viewed", "quoted"].includes(row.status),
            onSelect: () => setRecording(row),
          },
        ]}
        empty={{
          icon: IconVendor,
          title: "No quote requests",
          description:
            "Our own estimate is the only number on the record until a subcontractor answers.",
        }}
      />

      <RecordQuoteModal
        open={recording !== null}
        onClose={() => setRecording(null)}
        projectId={projectId}
        quote={recording}
        currency={recording ? currencyOf(recording) : null}
        onRecorded={chain.reload}
      />

      {comparisonPcoId ? (
        <ComparisonDrawer
          projectId={projectId}
          pcoId={comparisonPcoId}
          onClose={() => onOpenComparison(null)}
          onChanged={chain.reload}
          context={context}
        />
      ) : null}

      <Reasons
        reasons={[
          "A quote comparison with no returned quotes reports its lowest as unavailable, not as zero. Zero would read as a free change.",
        ]}
        tone="neutral"
      />
    </div>
  );
}
