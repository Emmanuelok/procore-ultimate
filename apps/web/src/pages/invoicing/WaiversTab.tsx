/**
 * LIEN WAIVERS — the exposure that outlives the payment.
 *
 * Two fields on the document are legally decisive and neither is ever
 * inferred: the TYPE and the THROUGH DATE.
 *
 *   conditional    takes effect only when the payment clears
 *   unconditional  takes effect on signature, money or no money
 *   progress/final scope of the waiver
 *   throughDate    fixes exactly which work is waived
 *
 * Signing an unconditional waiver before the money lands is how a
 * subcontractor loses their lien rights, so this screen never abbreviates the
 * type to "waiver" and never hides the through date.
 *
 * The OUTSTANDING report leads with money that has already gone out against
 * unwaived work, because that exposure cannot be withdrawn — only chased.
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
  Stat,
  Textarea,
} from "../../ui";
import { Modal, toast } from "../../ui/overlays";
import { DataTable, type DataColumns } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconSignature, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CurrencyBlocks,
  LIEN_WAIVER_STATUSES,
  LIEN_WAIVER_TYPES,
  PanelSkeleton,
  Reasons,
  RefusalPanel,
  SATISFYING_WAIVER_STATUSES,
  errorMessage,
  isoDate,
  label,
  money,
  refusalFrom,
  useResource,
  waiverTone,
  type InvoicingContext,
  type LienWaiverRow,
  type ListResponse,
  type OutstandingWaiverReport,
  type ServerRefusal,
} from "./invoicingShared";

const WAIVER_TYPE_MEANING: Record<string, string> = {
  conditional_progress:
    "Takes effect only when this progress payment clears. Safe to issue before the money lands.",
  unconditional_progress:
    "Takes effect on signature whether or not the progress payment arrives.",
  conditional_final:
    "Waives all lien rights on this contract, but only once the final payment clears.",
  unconditional_final:
    "Waives all lien rights on signature, money or no money. The most dangerous form to sign early.",
};

/* ------------------------------------------------------------------ */
/* Raise a waiver                                                      */
/* ------------------------------------------------------------------ */

function RaiseWaiverModal({
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
  const [waiverType, setWaiverType] = useState<string>("conditional_progress");
  const [vendorId, setVendorId] = useState("");
  const [commitmentId, setCommitmentId] = useState("");
  const [throughDate, setThroughDate] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [tier, setTier] = useState<number | null>(1);
  const [claimantName, setClaimantName] = useState("");
  const [exceptions, setExceptions] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setRefusal(null);
    setError(null);
    try {
      const body: Record<string, unknown> = { waiverType, throughDate };
      if (vendorId) body["vendorId"] = vendorId;
      if (commitmentId) body["commitmentId"] = commitmentId;
      if (amount !== null) body["amount"] = amount;
      if (tier !== null) body["tier"] = tier;
      if (claimantName.trim()) body["claimantName"] = claimantName.trim();
      if (exceptions.trim()) body["exceptionsNoted"] = exceptions.trim();
      if (jurisdiction.trim()) body["jurisdiction"] = jurisdiction.trim();
      await api.post(`/api/v1/projects/${projectId}/lien-waivers`, body);
      toast.success("Lien waiver raised.");
      setThroughDate("");
      setAmount(null);
      onCreated();
      onClose();
    } catch (err) {
      const parsed = refusalFrom(err);
      if (parsed) setRefusal(parsed);
      else setError(errorMessage(err, "The waiver was refused"));
    } finally {
      setBusy(false);
    }
  }

  const unconditional = waiverType.startsWith("unconditional");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Raise a lien waiver"
      description="Type and through date are the two legally decisive fields and neither is inferred."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!throughDate}>
            Raise waiver
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <RefusalPanel refusal={refusal} />

        <Field label="Waiver type" required>
          <Select value={waiverType} onChange={(e) => setWaiverType(e.target.value)}>
            {LIEN_WAIVER_TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Alert tone={unconditional ? "warning" : "info"} variant="subtle" size="sm">
          {WAIVER_TYPE_MEANING[waiverType] ?? ""}
        </Alert>

        <Field
          label="Work performed through"
          required
          hint="Legally decisive: it fixes exactly which work is waived. Never inferred from an invoice period."
        >
          <Input
            type="date"
            value={throughDate}
            onChange={(e) => setThroughDate(e.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vendor" optional>
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Not stated</option>
              {context.vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Commitment" optional>
            <Select value={commitmentId} onChange={(e) => setCommitmentId(e.target.value)}>
              <option value="">Not stated</option>
              {context.commitments.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.reference} — {c.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount covered" optional>
            <NumberInput value={amount} onChange={setAmount} precision={2} align="right" min={0} />
          </Field>
          <Field
            label="Tier"
            hint="1 = direct subcontractor, 2 = their supplier, and so on down the chain."
          >
            <NumberInput value={tier} onChange={setTier} min={1} max={9} precision={0} />
          </Field>
          <Field label="Jurisdiction" optional hint="The statutory form depends on it.">
            <Input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
          </Field>
        </div>

        <Field label="Claimant name" optional>
          <Input value={claimantName} onChange={(e) => setClaimantName(e.target.value)} />
        </Field>
        <Field
          label="Exceptions noted"
          optional
          hint="Disputed amounts expressly NOT waived."
        >
          <Textarea rows={2} value={exceptions} onChange={(e) => setExceptions(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* The tab                                                             */
/* ------------------------------------------------------------------ */

export default function WaiversTab({
  projectId,
  context,
}: {
  projectId: string;
  context: InvoicingContext;
}) {
  const report = useResource<OutstandingWaiverReport>(
    `/api/v1/projects/${projectId}/lien-waivers/outstanding`,
  );
  const waivers = useResource<ListResponse<LienWaiverRow>>(
    `/api/v1/projects/${projectId}/lien-waivers?page=1&pageSize=300`,
  );
  const [raising, setRaising] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function transition(waiver: LienWaiverRow, path: string, body?: unknown) {
    setError(null);
    try {
      await api.post(`/api/v1/lien-waivers/${waiver.id}/${path}`, body ?? {});
      toast.success(`${waiver.reference} — ${label(path)}.`);
      waivers.reload();
      report.reload();
    } catch (err) {
      setError(errorMessage(err, "The transition was refused"));
    }
  }

  const columns = useMemo<DataColumns<LienWaiverRow>>(
    () => [
      {
        id: "reference",
        header: "Waiver",
        accessor: "reference",
        type: "code",
        width: 110,
        sticky: "start",
      },
      {
        id: "waiverType",
        header: "Type",
        headerTooltip:
          "Conditional waivers take effect only on payment clearing; unconditional ones on signature.",
        accessor: "waiverType",
        type: "enum",
        width: 190,
        groupable: true,
        options: LIEN_WAIVER_TYPES.map((t) => ({ value: t, text: label(t), label: label(t) })),
        cell: (ctx) => (
          <span className="flex flex-col">
            <span className="text-content">{label(ctx.row.waiverType)}</span>
            <span className="text-2xs text-content-subtle">
              {ctx.row.waiverType.startsWith("unconditional")
                ? "effective on signature"
                : "effective on payment"}
            </span>
          </span>
        ),
      },
      {
        id: "vendor",
        header: "Vendor",
        accessor: (row: LienWaiverRow) => context.vendorName(row.vendorId) ?? "",
        type: "text",
        width: 190,
      },
      {
        id: "tier",
        header: "Tier",
        headerTooltip:
          "1 = direct subcontractor. Second-tier suppliers are the classic route to a lien on a paid-in-full project.",
        accessor: "tier",
        type: "number",
        width: 80,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 140,
        groupable: true,
        options: LIEN_WAIVER_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: waiverTone(s),
        })),
        cell: (ctx) => (
          <span className="flex items-center gap-1">
            <Badge tone={waiverTone(ctx.row.status)} size="xs">
              {label(ctx.row.status)}
            </Badge>
            {(SATISFYING_WAIVER_STATUSES as readonly string[]).includes(ctx.row.status) ? (
              <Badge tone="success" size="xs">
                on file
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "throughDate",
        header: "Through",
        headerTooltip: "Work performed through this date is waived. Legally decisive.",
        accessor: "throughDate",
        type: "date",
        width: 120,
      },
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "currency",
        width: 140,
        cell: (ctx) => money(ctx.row.amount, ctx.row.currency),
      },
      { id: "currency", header: "Currency", accessor: "currency", type: "text", width: 90 },
      {
        id: "invoice",
        header: "Invoice",
        accessor: "invoiceId",
        type: "code",
        width: 120,
        cell: (ctx) =>
          ctx.row.invoiceId ?? <span className="text-content-subtle">not attached</span>,
      },
      {
        id: "exceptionsNoted",
        header: "Exceptions",
        headerTooltip: "Disputed amounts expressly NOT waived.",
        accessor: "exceptionsNoted",
        type: "text",
        width: 200,
        defaultHidden: true,
      },
      {
        id: "requestedAt",
        header: "Requested",
        accessor: "requestedAt",
        type: "datetime",
        width: 150,
        defaultHidden: true,
      },
    ],
    [context],
  );

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />
      <ErrorAlert message={report.error} />

      {report.loading && !report.data ? (
        <PanelSkeleton rows={4} />
      ) : report.data ? (
        <>
          <Card>
            <CardHeader
              title="Outstanding-waiver exposure"
              subtitle={`As at ${isoDate(report.data.asOf)}. Money already out of the door against unwaived work is listed first — it cannot be withdrawn, only chased.`}
              icon={IconSignature}
            />
            <CardBody className="space-y-3">
              <CurrencyBlocks
                blocks={report.data.exposureByCurrency}
                emptyTitle="No outstanding waiver exposure"
                emptyHint="Every invoice that requires a waiver has one on file. That is the position right now, not an unchecked zero."
                render={(block) => (
                  <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
                    <Stat
                      label={`Paid without a waiver (${block.currency})`}
                      value={money(block.paidWithoutWaiver, block.currency)}
                      size="sm"
                      tone={block.paidWithoutWaiver > 0 ? "danger" : "neutral"}
                      hint="already paid — exposure that cannot be withdrawn"
                    />
                    <Stat
                      label="Blocked from payment"
                      value={money(block.blockedFromPayment, block.currency)}
                      size="sm"
                      tone="warning"
                      hint="the gate is holding this money back"
                    />
                    <Stat label="Invoices" value={String(block.invoices)} size="sm" />
                  </div>
                )}
              />

              {report.data.untieredWarning ? (
                <Alert
                  tone="warning"
                  variant="subtle"
                  icon={IconWarning}
                  title="Every waiver on this project is tier 1"
                >
                  {report.data.untieredWarning}
                </Alert>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Invoices with no waiver on file"
              subtitle="Approved or paid, requires a waiver, and has none received, verified or explicitly excused."
            />
            <CardBody>
              {report.data.outstanding.length === 0 ? (
                <EmptyState
                  size="sm"
                  title="Nothing outstanding"
                  hint="Every invoice requiring a waiver has one on file."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[52rem] text-meta">
                    <thead>
                      <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
                        <th className="py-1.5 pr-3 text-left font-semibold">Invoice</th>
                        <th className="py-1.5 pr-3 text-left font-semibold">Vendor</th>
                        <th className="py-1.5 pr-3 text-left font-semibold">Exposure</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Already paid</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Blocked</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Days</th>
                        <th className="py-1.5 text-left font-semibold">Waivers raised</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {report.data.outstanding.map((row) => (
                        <tr
                          key={row.invoiceId}
                          className={
                            row.blocking === "paid_without_waiver"
                              ? "bg-danger-subtle/40 align-top"
                              : "align-top"
                          }
                        >
                          <td className="py-2 pr-3">
                            <span className="font-mono text-2xs text-content-subtle">
                              {row.reference}
                            </span>
                            <span className="mt-0.5 block text-2xs text-content-subtle">
                              {label(row.kind)} · {label(row.status)}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-content">
                            {row.vendorName ?? "not named"}
                          </td>
                          <td className="py-2 pr-3">
                            {row.blocking === "paid_without_waiver" ? (
                              <Badge tone="danger" size="xs" icon={IconWarning}>
                                paid without a waiver
                              </Badge>
                            ) : (
                              <Badge tone="warning" size="xs">
                                payment blocked
                              </Badge>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-content">
                            {money(row.paidUnwaived, row.currency)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-content">
                            {money(row.currentPaymentDue - row.amountPaid, row.currency)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-content-muted">
                            {row.daysOutstanding === null ? "—" : row.daysOutstanding}
                          </td>
                          <td className="py-2">
                            {row.waivers.length === 0 ? (
                              <span className="text-content-subtle">none raised</span>
                            ) : (
                              <span className="flex flex-wrap gap-1">
                                {row.waivers.map((w) => (
                                  <Badge key={w.id} tone={waiverTone(w.status)} size="xs">
                                    {w.reference} · {label(w.status)}
                                  </Badge>
                                ))}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          {report.data.inFlight.length > 0 ? (
            <Card>
              <CardHeader
                title="Waivers in the chain of custody"
                subtitle="Requested, sent or signed — but not yet in our hands. 'We have it somewhere' is not a defence."
              />
              <CardBody>
                <ul className="space-y-1">
                  {report.data.inFlight.map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-2xs text-content-subtle">
                          {row.reference}
                        </span>
                        <Badge tone={waiverTone(row.status)} size="xs">
                          {label(row.status)}
                        </Badge>
                        <span className="text-content">{row.vendorName ?? "vendor not named"}</span>
                        <span className="text-2xs text-content-subtle">
                          tier {row.tier} · through {isoDate(row.throughDate)}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        {row.daysSinceRequested !== null ? (
                          <Badge
                            tone={
                              row.daysSinceRequested > 21
                                ? "danger"
                                : row.daysSinceRequested > 10
                                  ? "warning"
                                  : "neutral"
                            }
                            size="xs"
                          >
                            {row.daysSinceRequested} d since requested
                          </Badge>
                        ) : null}
                        <span className="tabular-nums text-content">
                          {money(row.amount, row.currency)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}

      <DataTable<LienWaiverRow>
        tableId={`invoicing:waivers:${projectId}`}
        data={waivers.data?.items ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        loading={waivers.loading}
        error={waivers.error}
        onRetry={waivers.reload}
        height={520}
        stickyHeader
        filterRow
        savedViews
        exportFileName={`lien-waivers-${projectId}`}
        searchPlaceholder="Search waivers…"
        aria-label="Lien waivers"
        defaultSort={[{ id: "reference", desc: true }]}
        rowTone={(row) => waiverTone(row.status)}
        rowActions={(row) => [
          {
            id: "request",
            label: "Request from the vendor",
            disabled: row.status !== "draft",
            onSelect: () => void transition(row, "request"),
          },
          {
            id: "send",
            label: "Mark as sent",
            disabled: !["draft", "requested"].includes(row.status),
            onSelect: () => void transition(row, "send"),
          },
          {
            id: "receive",
            label: "Mark as received",
            disabled: row.status !== "signed",
            onSelect: () => void transition(row, "receive"),
          },
          {
            id: "verify",
            label: "Verify",
            disabled: row.status !== "received",
            onSelect: () => void transition(row, "verify"),
          },
          {
            id: "not-required",
            label: "Record as not required",
            disabled: (SATISFYING_WAIVER_STATUSES as readonly string[]).includes(row.status),
            onSelect: () => void transition(row, "not-required"),
          },
        ]}
        empty={{
          icon: IconSignature,
          title: "No lien waivers on this project",
          description:
            "Paying a subcontractor without a waiver leaves the project exposed to a lien for work already paid for.",
          action: <Button onClick={() => setRaising(true)}>Raise a waiver</Button>,
        }}
        toolbarActions={<Button onClick={() => setRaising(true)}>Raise waiver</Button>}
      />

      <Reasons
        reasons={[
          "A waiver is on file only when it is received, verified or explicitly recorded as not required. Requested, sent, even signed means the document is not in our hands.",
          "The lifecycle is a chain of custody — requested, sent, signed, received, verified — each with its own actor and timestamp.",
        ]}
        tone="neutral"
        title="What counts as on file"
      />

      <RaiseWaiverModal
        open={raising}
        onClose={() => setRaising(false)}
        projectId={projectId}
        context={context}
        onCreated={() => {
          waivers.reload();
          report.reload();
        }}
      />
    </div>
  );
}
