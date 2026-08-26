/**
 * THE INVOICE — the G702 cover sheet and the G703 continuation sheet.
 *
 * Billing entry is the one write that decides what a period is worth, and the
 * refusals it can earn are the point of the screen rather than an obstacle to
 * it. Two of them are checked here BEFORE the request goes out, so a biller
 * sees the problem while they are still typing:
 *
 *   OVER-BILLING   previousBilled + thisPeriodWork + materialsPresentlyStored
 *                  must not exceed the line's scheduled value. The overage is
 *                  named to the cent, exactly as the server names it.
 *   REGRESSION     percent complete cannot go backwards without a stated
 *                  credit reason.
 *
 * The client-side check is a convenience and never the authority: whatever the
 * server refuses is rendered VERBATIM, with the server's own figures, because
 * paraphrasing a refusal that names money to the cent throws away the only
 * part a biller can act on.
 *
 * RETAINAGE HELD TO DATE is printed at the top of the cover sheet, not buried
 * in a column. It is the money everyone forgets.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Stat,
  Textarea,
} from "../../ui";
import { ConfirmDialog, Drawer, DrawerBody, DrawerFooter, Modal, toast } from "../../ui/overlays";
import { DescriptionList } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconInvoice, IconPayment, IconSignature, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  ChecksList,
  PAYMENT_METHODS,
  PanelSkeleton,
  Reasons,
  RefusalPanel,
  SATISFYING_WAIVER_STATUSES,
  errorMessage,
  invoiceTone,
  isoDate,
  isoDateTime,
  label,
  money,
  num,
  paymentTone,
  percent,
  periodAcceptsBilling,
  refusalFrom,
  useResource,
  waiverTone,
  type InvoiceDetail as InvoiceDetailShape,
  type InvoiceLineRow,
  type InvoicePaymentsResponse,
  type InvoicingContext,
  type LienWaiverRow,
  type ServerRefusal,
  type WaiverGate,
} from "./invoicingShared";

const CENT = 0.005;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Client-side derivation — a preview of what the server will compute   */
/* ------------------------------------------------------------------ */

interface Draft {
  thisPeriodWork: number | null;
  materialsPresentlyStored: number | null;
  retainageReleased: number | null;
  creditReason: string;
}

interface DerivedLine {
  line: InvoiceLineRow;
  draft: Draft;
  thisPeriodWork: number;
  materialsPresentlyStored: number;
  totalCompletedAndStored: number;
  percentComplete: number;
  balanceToFinish: number;
  retainageThisPeriod: number;
  retainageHeldToDate: number;
  amount: number;
  /** local refusals, worded the way the server words them */
  problems: string[];
}

function derive(line: InvoiceLineRow, draft: Draft): DerivedLine {
  const thisPeriodWork = r2(draft.thisPeriodWork ?? line.thisPeriodWork);
  const materialsPresentlyStored = r2(
    draft.materialsPresentlyStored ?? line.materialsPresentlyStored,
  );
  const retainageReleased = r2(draft.retainageReleased ?? line.retainageReleased);
  const totalCompletedAndStored = r2(
    line.previousBilled + thisPeriodWork + materialsPresentlyStored,
  );
  const previousTotal = r2(line.previousBilled + line.previousStoredMaterials);
  const problems: string[] = [];

  const overage = r2(totalCompletedAndStored - line.scheduledValue);
  if (overage > CENT) {
    problems.push(
      `Line ${line.lineNumber} (${line.description}) bills ${num(totalCompletedAndStored)} against a scheduled value of ${num(line.scheduledValue)} — over by ${num(overage)}. Raise a change order before billing past the schedule of values.`,
    );
  }
  const regression = r2(previousTotal - totalCompletedAndStored);
  if (regression > CENT && !draft.creditReason.trim()) {
    problems.push(
      `Line ${line.lineNumber} (${line.description}) moves backwards from ${num(previousTotal)} to ${num(totalCompletedAndStored)} — a credit of ${num(regression)}. Percent complete cannot regress without a stated credit reason.`,
    );
  }
  if (materialsPresentlyStored < -CENT) {
    problems.push(
      `Line ${line.lineNumber}: stored materials would fall to ${num(materialsPresentlyStored)}. Materials on site cannot be negative.`,
    );
  }

  const rate = line.retainagePercent / 100;
  const thisPeriodStored = r2(materialsPresentlyStored - line.previousStoredMaterials);
  const grossRetainage = r2(rate * totalCompletedAndStored);
  if (retainageReleased - grossRetainage > CENT) {
    problems.push(
      `Line ${line.lineNumber}: a release of ${num(retainageReleased)} exceeds the ${num(grossRetainage)} of retainage this line has accrued — over by ${num(r2(retainageReleased - grossRetainage))}.`,
    );
  }
  const retainageThisPeriod = r2(rate * (thisPeriodWork + thisPeriodStored));

  return {
    line,
    draft,
    thisPeriodWork,
    materialsPresentlyStored,
    totalCompletedAndStored,
    percentComplete:
      Math.abs(line.scheduledValue) < CENT
        ? 0
        : Math.round((totalCompletedAndStored / line.scheduledValue) * 1000000) / 10000,
    balanceToFinish: r2(line.scheduledValue - totalCompletedAndStored),
    retainageThisPeriod,
    retainageHeldToDate: r2(grossRetainage - retainageReleased),
    amount: r2(thisPeriodWork + thisPeriodStored - retainageThisPeriod + retainageReleased),
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* Continuation sheet                                                  */
/* ------------------------------------------------------------------ */

function ContinuationSheet({
  invoice,
  editable,
  frozenReason,
  onSave,
  saving,
  refusal,
}: {
  invoice: InvoiceDetailShape;
  editable: boolean;
  frozenReason: string | null;
  onSave: (payload: Array<Record<string, unknown>>) => Promise<boolean>;
  saving: boolean;
  refusal: ServerRefusal | null;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  useEffect(() => {
    setDrafts({});
  }, [invoice.id, invoice.updatedAt]);

  const draftFor = useCallback(
    (line: InvoiceLineRow): Draft =>
      drafts[line.id] ?? {
        thisPeriodWork: null,
        materialsPresentlyStored: null,
        retainageReleased: null,
        creditReason: "",
      },
    [drafts],
  );

  const setDraft = (lineId: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({
      ...prev,
      [lineId]: {
        ...(prev[lineId] ?? {
          thisPeriodWork: null,
          materialsPresentlyStored: null,
          retainageReleased: null,
          creditReason: "",
        }),
        ...patch,
      },
    }));

  const derived = useMemo(
    () => invoice.lines.map((line) => derive(line, draftFor(line))),
    [invoice.lines, draftFor],
  );

  const dirty = Object.keys(drafts).length > 0;
  const problems = derived.flatMap((d) => d.problems);

  const totals = useMemo(() => {
    const scheduled = derived.reduce((s, d) => s + d.line.scheduledValue, 0);
    const previous = derived.reduce((s, d) => s + d.line.previousBilled, 0);
    const work = derived.reduce((s, d) => s + d.thisPeriodWork, 0);
    const stored = derived.reduce((s, d) => s + d.materialsPresentlyStored, 0);
    const completed = derived.reduce((s, d) => s + d.totalCompletedAndStored, 0);
    const retainageHeld = derived.reduce((s, d) => s + d.retainageHeldToDate, 0);
    const net = derived.reduce((s, d) => s + d.amount, 0);
    return {
      scheduled: r2(scheduled),
      previous: r2(previous),
      work: r2(work),
      stored: r2(stored),
      completed: r2(completed),
      retainageHeld: r2(retainageHeld),
      net: r2(net),
      balance: r2(scheduled - completed),
    };
  }, [derived]);

  const contractOverage = r2(totals.completed - invoice.revisedContractSum);

  async function save() {
    const payload = Object.entries(drafts).map(([lineId, draft]) => {
      const body: Record<string, unknown> = { lineId };
      if (draft.thisPeriodWork !== null) body["thisPeriodWork"] = draft.thisPeriodWork;
      if (draft.materialsPresentlyStored !== null) {
        body["materialsPresentlyStored"] = draft.materialsPresentlyStored;
      }
      if (draft.retainageReleased !== null) body["retainageReleased"] = draft.retainageReleased;
      if (draft.creditReason.trim()) body["creditReason"] = draft.creditReason.trim();
      return body;
    });
    const ok = await onSave(payload);
    if (ok) setDrafts({});
    return ok;
  }

  return (
    <Card>
      <CardHeader
        title="Continuation sheet (G703)"
        subtitle="Drawn from the schedule of values. Previous billed is snapshotted at creation, so a change order landing next week cannot retroactively change what this invoice says."
        actions={
          editable ? (
            <Button
              size="sm"
              onClick={() => void save()}
              loading={saving}
              disabled={!dirty || problems.length > 0}
            >
              Save billing entry
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-3">
        {!editable && frozenReason ? (
          <Alert tone="info" variant="subtle" size="sm" title="This sheet is not editable">
            {frozenReason}
          </Alert>
        ) : null}

        <RefusalPanel refusal={refusal} title="The server refused this billing entry" />

        {problems.length > 0 ? (
          <Reasons
            reasons={problems}
            tone="danger"
            title={`${problems.length} line(s) would be refused — fix them before saving`}
          />
        ) : null}

        {contractOverage > CENT ? (
          <Alert
            tone="danger"
            variant="subtle"
            icon={IconWarning}
            title="This billing exceeds the revised contract sum"
          >
            The lines total {money(totals.completed, invoice.currency)} against a revised contract
            sum of {money(invoice.revisedContractSum, invoice.currency)} — over by{" "}
            {money(contractOverage, invoice.currency)}. A G703 whose lines each fit but whose total
            does not is still an over-billing, and the server refuses it.
          </Alert>
        ) : null}

        {invoice.lines.length === 0 ? (
          <EmptyState
            size="sm"
            title="No continuation sheet"
            hint="An invoice with no lines asks for money without saying what for — the server refuses to submit one."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[74rem] text-meta">
              <thead>
                <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
                  <th className="py-1.5 pr-2 text-left font-semibold">#</th>
                  <th className="py-1.5 pr-3 text-left font-semibold">Description</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Scheduled value</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Previous billed</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">This period</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Stored materials</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Completed &amp; stored</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">%</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Balance to finish</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Retainage held</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Released</th>
                  <th className="py-1.5 text-right font-semibold">Net this period</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {derived.map((row) => (
                  <tr
                    key={row.line.id}
                    className={row.problems.length > 0 ? "bg-danger-subtle/40 align-top" : "align-top"}
                  >
                    <td className="py-1.5 pr-2 font-mono text-2xs text-content-subtle">
                      {row.line.lineNumber}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className="text-content">{row.line.description}</span>
                      <span className="mt-0.5 block text-2xs text-content-subtle">
                        {row.line.costCode ? `${row.line.costCode} · ` : ""}
                        {label(row.line.source)} · {label(row.line.billingMethod)}
                        {row.line.retainagePercent > 0
                          ? ` · retainage ${percent(row.line.retainagePercent)}`
                          : " · no retainage"}
                      </span>
                      {row.problems.length > 0 ? (
                        <span className="mt-1 block text-2xs leading-snug text-danger-fg">
                          {row.problems.join(" ")}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-content">
                      {money(row.line.scheduledValue, invoice.currency)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-content-muted">
                      {money(row.line.previousBilled, invoice.currency)}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {editable ? (
                        <NumberInput
                          value={row.draft.thisPeriodWork ?? row.line.thisPeriodWork}
                          onChange={(v) => setDraft(row.line.id, { thisPeriodWork: v })}
                          precision={2}
                          align="right"
                          size="sm"
                          showStepper={false}
                          aria-label={`Work billed this period on line ${row.line.lineNumber}`}
                        />
                      ) : (
                        <span className="tabular-nums text-content">
                          {money(row.line.thisPeriodWork, invoice.currency)}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {editable ? (
                        <NumberInput
                          value={
                            row.draft.materialsPresentlyStored ?? row.line.materialsPresentlyStored
                          }
                          onChange={(v) => setDraft(row.line.id, { materialsPresentlyStored: v })}
                          precision={2}
                          align="right"
                          size="sm"
                          showStepper={false}
                          aria-label={`Materials presently stored on line ${row.line.lineNumber}`}
                        />
                      ) : (
                        <span className="tabular-nums text-content">
                          {money(row.line.materialsPresentlyStored, invoice.currency)}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-medium text-content">
                      {money(row.totalCompletedAndStored, invoice.currency)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-content-muted">
                      {percent(row.percentComplete, 1)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-content-muted">
                      {money(row.balanceToFinish, invoice.currency)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-content">
                      {money(row.retainageHeldToDate, invoice.currency)}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {editable ? (
                        <NumberInput
                          value={row.draft.retainageReleased ?? row.line.retainageReleased}
                          onChange={(v) => setDraft(row.line.id, { retainageReleased: v })}
                          precision={2}
                          align="right"
                          size="sm"
                          showStepper={false}
                          min={0}
                          aria-label={`Retainage released on line ${row.line.lineNumber}`}
                        />
                      ) : (
                        <span className="tabular-nums text-content">
                          {money(row.line.retainageReleased, invoice.currency)}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-content">
                      {money(row.amount, invoice.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border font-medium">
                <tr>
                  <td />
                  <td className="py-2 pr-3 text-content">Totals</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-content">
                    {money(totals.scheduled, invoice.currency)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-content">
                    {money(totals.previous, invoice.currency)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-content">
                    {money(totals.work, invoice.currency)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-content">
                    {money(totals.stored, invoice.currency)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-content">
                    {money(totals.completed, invoice.currency)}
                  </td>
                  <td />
                  <td className="py-2 pr-3 text-right tabular-nums text-content">
                    {money(totals.balance, invoice.currency)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-content">
                    {money(totals.retainageHeld, invoice.currency)}
                  </td>
                  <td />
                  <td className="py-2 text-right tabular-nums text-content">
                    {money(totals.net, invoice.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* credit reasons for any line moving backwards */}
        {derived
          .filter(
            (row) =>
              r2(row.line.previousBilled + row.line.previousStoredMaterials) -
                row.totalCompletedAndStored >
              CENT,
          )
          .map((row) => (
            <Field
              key={`credit-${row.line.id}`}
              label={`Credit reason for line ${row.line.lineNumber}`}
              required
              hint="This line bills less than it did last period. A credit without a stated reason is how a G703 stops reconciling."
            >
              <Input
                value={row.draft.creditReason}
                onChange={(e) => setDraft(row.line.id, { creditReason: e.target.value })}
                disabled={!editable}
              />
            </Field>
          ))}

        {dirty ? (
          <p className="text-2xs text-content-subtle">
            Unsaved billing entry on {Object.keys(drafts).length} line(s). Everything above is
            computed locally as a preview; the server recomputes it and refuses anything it does not
            agree with, naming the figures.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Lien waivers on this invoice                                        */
/* ------------------------------------------------------------------ */

function WaiverPanel({
  invoiceId,
  currency,
  onChanged,
}: {
  invoiceId: string;
  currency: string;
  onChanged: () => void;
}) {
  const data = useResource<{ invoiceId: string; gate: WaiverGate; waivers: LienWaiverRow[] }>(
    `/api/v1/invoices/${invoiceId}/lien-waivers`,
  );

  return (
    <Card>
      <CardHeader
        title="Lien waivers"
        subtitle="A waiver counts as on file only when it is received, verified or explicitly not required. Requested, sent — even signed — means the document is not in our hands."
        icon={IconSignature}
      />
      <CardBody className="space-y-3">
        {data.loading && !data.data ? (
          <PanelSkeleton rows={2} />
        ) : data.error ? (
          <ErrorAlert message={data.error} />
        ) : data.data ? (
          <>
            {!data.data.gate.required ? (
              <Alert tone="neutral" variant="subtle" size="sm">
                This invoice does not require a lien waiver.
              </Alert>
            ) : data.data.gate.satisfied ? (
              <Alert tone="success" variant="subtle" size="sm" title="Waiver on file">
                Payment is not blocked by the waiver gate.
              </Alert>
            ) : (
              <Alert
                tone="danger"
                variant="subtle"
                icon={IconWarning}
                title="Paying this invoice is blocked — no lien waiver is on file"
              >
                <ul className="ml-4 mt-1 list-disc space-y-1">
                  {data.data.gate.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
                <p className="mt-2">
                  Paying anyway is possible with a stated reason — the payment is then recorded ON
                  HOLD, the money does not move, and the exposure stays on the outstanding-waiver
                  report.
                </p>
              </Alert>
            )}

            {data.data.waivers.length === 0 ? (
              <p className="text-meta text-content-muted">
                No waiver has been raised against this invoice.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.data.waivers.map((waiver) => (
                  <li
                    key={waiver.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-2xs text-content-subtle">
                        {waiver.reference}
                      </span>
                      <Badge tone={waiverTone(waiver.status)} size="xs">
                        {label(waiver.status)}
                      </Badge>
                      <Badge
                        tone={waiver.waiverType.startsWith("unconditional") ? "warning" : "neutral"}
                        variant="outline"
                        size="xs"
                      >
                        {label(waiver.waiverType)}
                      </Badge>
                      <span className="text-2xs text-content-subtle">
                        tier {waiver.tier} · through {isoDate(waiver.throughDate)}
                      </span>
                      {(SATISFYING_WAIVER_STATUSES as readonly string[]).includes(waiver.status) ? (
                        <Badge tone="success" size="xs">
                          on file
                        </Badge>
                      ) : null}
                    </span>
                    <span className="tabular-nums text-content">
                      {money(waiver.amount, waiver.currency || currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Button size="xs" variant="ghost" onClick={() => { data.reload(); onChanged(); }}>
              Refresh waiver status
            </Button>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

function PaymentsPanel({
  invoice,
  onChanged,
}: {
  invoice: InvoiceDetailShape;
  onChanged: () => void;
}) {
  const data = useResource<InvoicePaymentsResponse>(`/api/v1/invoices/${invoice.id}/payments`);
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<string>("check");
  const [reference, setReference] = useState("");
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const payable = data.data?.payable ?? null;

  async function pay() {
    if (amount === null) return;
    setBusy(true);
    setRefusal(null);
    setError(null);
    setWarnings([]);
    try {
      const body: Record<string, unknown> = { amount, method };
      if (reference.trim()) body["transactionReference"] = reference.trim();
      if (override) {
        body["overrideMissingWaiver"] = true;
        body["overrideReason"] = overrideReason.trim();
      }
      const response = await api.post<{ warnings?: string[] }>(
        `/api/v1/invoices/${invoice.id}/payments`,
        body,
      );
      setWarnings(response.warnings ?? []);
      toast.success(
        response.warnings && response.warnings.length > 0
          ? "Payment recorded ON HOLD — the money has not moved."
          : "Payment recorded.",
      );
      setPaying(false);
      setAmount(null);
      setOverride(false);
      setOverrideReason("");
      data.reload();
      onChanged();
    } catch (err) {
      const parsed = refusalFrom(err);
      if (parsed) setRefusal(parsed);
      else setError(errorMessage(err, "The payment was refused"));
    } finally {
      setBusy(false);
    }
  }

  const waiverBlocked = refusal?.control === "lien_waiver_required";

  return (
    <Card>
      <CardHeader
        title="Payments"
        subtitle="Money moves only against an approved invoice, and never by the person who submitted it."
        icon={IconPayment}
        actions={
          <Button
            size="sm"
            disabled={!["approved", "approved_as_noted"].includes(invoice.status)}
            onClick={() => {
              setAmount(payable);
              setPaying(true);
            }}
          >
            Record a payment
          </Button>
        }
      />
      <CardBody className="space-y-3">
        {warnings.length > 0 ? (
          <Reasons reasons={warnings} tone="danger" title="Recorded on hold, not paid" />
        ) : null}

        <DescriptionList
          columns={3}
          size="sm"
          items={[
            {
              label: "Current payment due",
              value: money(invoice.currentPaymentDue, invoice.currency),
            },
            { label: "Paid to date", value: money(invoice.amountPaid, invoice.currency) },
            {
              label: "Outstanding",
              value: money(invoice.outstanding, invoice.currency),
            },
          ]}
        />

        {data.loading && !data.data ? (
          <PanelSkeleton rows={2} />
        ) : data.error ? (
          <ErrorAlert message={data.error} />
        ) : data.data && data.data.payments.length > 0 ? (
          <ul className="space-y-1">
            {data.data.payments.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-2xs text-content-subtle">
                    {payment.reference}
                  </span>
                  <Badge tone={paymentTone(payment.status)} size="xs">
                    {label(payment.status)}
                  </Badge>
                  <span className="text-content-subtle">{label(payment.method)}</span>
                  <span className="text-content-subtle">{isoDate(payment.paymentDate)}</span>
                  {payment.holdReason ? (
                    <span className="w-full text-2xs text-danger-fg">{payment.holdReason}</span>
                  ) : null}
                </span>
                <span className="tabular-nums text-content">
                  {money(payment.amount, payment.currency)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-meta text-content-muted">
            Nothing has been paid against this invoice.
          </p>
        )}
      </CardBody>

      <Modal
        open={paying}
        onClose={() => setPaying(false)}
        title={`Record a payment against ${invoice.reference}`}
        description="A payment larger than what is still payable is refused, with the overage named."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPaying(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void pay()}
              loading={busy}
              disabled={amount === null || (override && !overrideReason.trim())}
              variant={override ? "danger" : "primary"}
            >
              {override ? "Record on hold anyway" : "Record payment"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <ErrorAlert message={error} />
          <RefusalPanel refusal={refusal} />

          {waiverBlocked ? (
            <Alert
              tone="danger"
              variant="subtle"
              icon={IconWarning}
              title="This is a real financial exposure, not a form validation"
            >
              Money paid against unwaived work cannot be withdrawn — only chased. If you pay anyway,
              the payment is recorded ON HOLD: the money does not move and the exposure stays on the
              outstanding-waiver report until the signed waiver arrives.
            </Alert>
          ) : null}

          <Field
            label={`Amount (${invoice.currency})`}
            required
            hint={payable !== null ? `Still payable: ${money(payable, invoice.currency)}` : undefined}
          >
            <NumberInput value={amount} onChange={setAmount} precision={2} align="right" min={0} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {label(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference" optional>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>

          <label className="flex items-start gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Pay even though the required lien waiver is missing. The payment will be recorded on
              hold and an explicit reason is required — an unexplained override is
              indistinguishable from an oversight.
            </span>
          </label>
          {override ? (
            <Field label="Why is this being overridden?" required>
              <Textarea
                rows={3}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
            </Field>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* The invoice drawer                                                  */
/* ------------------------------------------------------------------ */

export default function InvoiceDrawer({
  invoiceId,
  onClose,
  onChanged,
  context,
}: {
  invoiceId: string;
  onClose: () => void;
  onChanged: () => void;
  context: InvoicingContext;
}) {
  const detail = useResource<InvoiceDetailShape>(`/api/v1/invoices/${invoiceId}`);
  const invoice = detail.data;

  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);
  const [lineRefusal, setLineRefusal] = useState<ServerRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [reason, setReason] = useState("");
  const [approving, setApproving] = useState(false);
  const [approvedAmount, setApprovedAmount] = useState<number | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [voiding, setVoiding] = useState(false);

  const period = invoice?.billingPeriodId
    ? context.periodById.get(invoice.billingPeriodId)
    : undefined;
  const periodRule = periodAcceptsBilling(period);

  const editable =
    invoice !== null && ["draft", "revise_and_resubmit"].includes(invoice.status) && periodRule.ok;

  const frozenReason = !invoice
    ? null
    : !periodRule.ok
      ? periodRule.rule
      : !["draft", "revise_and_resubmit"].includes(invoice.status)
        ? `This invoice is "${label(invoice.status)}". A submitted invoice's continuation sheet is frozen — it is the document the money is claimed on.`
        : null;

  async function act(path: string, body?: unknown, success?: string) {
    setError(null);
    setRefusal(null);
    try {
      await api.post(`/api/v1/invoices/${invoiceId}/${path}`, body ?? {});
      toast.success(success ?? "Done.");
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

  const saveLines = useCallback(
    async (payload: Array<Record<string, unknown>>) => {
      setSaving(true);
      setLineRefusal(null);
      try {
        await api.put(`/api/v1/invoices/${invoiceId}/lines`, { lines: payload });
        toast.success("Billing entry saved.");
        detail.reload();
        onChanged();
        return true;
      } catch (err) {
        const parsed = refusalFrom(err);
        if (parsed) setLineRefusal(parsed);
        else setError(errorMessage(err, "The billing entry was refused"));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [invoiceId, detail, onChanged],
  );

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={invoice ? `${invoice.reference}${invoice.title ? ` — ${invoice.title}` : ""}` : "Invoice"}
      description={
        invoice
          ? `${invoice.kind === "owner_billing" ? "Owner application for payment" : "Subcontractor invoice"} · ${context.counterparty(invoice)} · ${label(invoice.status)}`
          : undefined
      }
      icon={IconInvoice}
      footer={
        <DrawerFooter align="between">
          <span className="text-2xs text-content-subtle">
            The approver is never the author or the submitter. A refusal here is the control
            working, not a bug.
          </span>
          <span className="flex flex-wrap gap-2">
            {invoice && ["draft", "revise_and_resubmit"].includes(invoice.status) ? (
              <Button size="sm" onClick={() => void act("submit", {}, "Invoice submitted.")}>
                Submit
              </Button>
            ) : null}
            {invoice?.status === "submitted" ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void act("review", {}, "Marked under review.")}
              >
                Mark under review
              </Button>
            ) : null}
            {invoice && ["submitted", "under_review"].includes(invoice.status) ? (
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    setApprovedAmount(null);
                    setReviewNotes("");
                    setApproving(true);
                  }}
                >
                  Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setRevising(true)}>
                  Send back
                </Button>
                <Button size="sm" variant="danger" onClick={() => setRejecting(true)}>
                  Reject
                </Button>
              </>
            ) : null}
            {invoice && !["paid", "void"].includes(invoice.status) && invoice.amountPaid === 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setVoiding(true)}>
                Void
              </Button>
            ) : null}
          </span>
        </DrawerFooter>
      }
    >
      <DrawerBody>
        {detail.loading && !detail.data ? (
          <PanelSkeleton rows={8} />
        ) : detail.error ? (
          <ErrorAlert message={detail.error} />
        ) : invoice ? (
          <div className="space-y-4">
            <ErrorAlert message={error} />
            <RefusalPanel refusal={refusal} />

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={invoiceTone(invoice.status)}>{label(invoice.status)}</Badge>
              <Badge tone="neutral" variant="outline">
                {invoice.kind === "owner_billing" ? "Owner application" : "Subcontractor invoice"}
              </Badge>
              {invoice.invoiceNumber ? (
                <span className="text-2xs text-content-subtle">
                  vendor invoice no. {invoice.invoiceNumber}
                </span>
              ) : null}
              <span className="text-2xs text-content-subtle">{invoice.currency}</span>
            </div>

            {!periodRule.ok && periodRule.rule ? (
              <Alert
                tone="warning"
                variant="subtle"
                size="sm"
                title="The billing period this invoice sits in is not accepting billing"
              >
                {periodRule.rule}
              </Alert>
            ) : null}

            {invoice.rejectionReason ? (
              <Alert tone="danger" variant="subtle" size="sm" title="Rejected">
                {invoice.rejectionReason}
              </Alert>
            ) : null}
            {invoice.reviewNotes ? (
              <Alert tone="info" variant="subtle" size="sm" title="Review notes">
                {invoice.reviewNotes}
              </Alert>
            ) : null}

            {/* ---- retainage, first, because it is the money everyone forgets ---- */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Retainage held to date"
                value={money(invoice.totalRetainage, invoice.currency)}
                hint={`${percent(invoice.retainagePercentWork)} on work · ${percent(invoice.retainagePercentMaterials)} on materials`}
                tone="warning"
              />
              <Stat
                label="Retainage released"
                value={money(invoice.retainageReleased, invoice.currency)}
              />
              <Stat
                label="Current payment due"
                value={money(invoice.currentPaymentDue, invoice.currency)}
              />
              <Stat
                label="Outstanding"
                value={money(invoice.outstanding, invoice.currency)}
                hint={`paid ${money(invoice.amountPaid, invoice.currency)}`}
              />
            </div>

            {/* ---- the G702 cover sheet ---- */}
            <Card>
              <CardHeader
                title="Cover sheet (G702)"
                subtitle="Stored rather than computed on read: an invoice is a legal document and must say tomorrow exactly what it said the day it was certified."
              />
              <CardBody className="space-y-3">
                <DescriptionList
                  columns={3}
                  items={[
                    {
                      label: "Original contract sum",
                      value: money(invoice.originalContractSum, invoice.currency),
                    },
                    {
                      label: "Net change orders",
                      value: money(invoice.netChangeOrders, invoice.currency),
                    },
                    {
                      label: "Revised contract sum",
                      value: money(invoice.revisedContractSum, invoice.currency),
                    },
                    {
                      label: "Completed to date",
                      value: money(invoice.completedToDate, invoice.currency),
                    },
                    {
                      label: "Stored materials",
                      value: money(invoice.storedMaterials, invoice.currency),
                    },
                    {
                      label: "Total completed & stored",
                      value: money(invoice.totalCompletedAndStored, invoice.currency),
                    },
                    {
                      label: "Retainage on work",
                      value: money(invoice.retainageWork, invoice.currency),
                    },
                    {
                      label: "Retainage on materials",
                      value: money(invoice.retainageMaterials, invoice.currency),
                    },
                    {
                      label: "Total retainage",
                      value: money(invoice.totalRetainage, invoice.currency),
                    },
                    {
                      label: "Total earned less retainage",
                      value: money(invoice.totalEarnedLessRetainage, invoice.currency),
                    },
                    {
                      label: "Less previous payments",
                      value: money(invoice.previousPaymentsAmount, invoice.currency),
                    },
                    {
                      label: "Balance to finish + retainage",
                      value: money(invoice.balanceToFinishPlusRetainage, invoice.currency),
                    },
                  ]}
                />
                <Divider />
                <div>
                  <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                    Every G702 identity, checked against the stored columns
                  </p>
                  <ChecksList
                    checks={invoice.reconciliation.checks}
                    currency={invoice.currency}
                  />
                  {!invoice.reconciliation.reconciles ? (
                    <Alert tone="danger" variant="subtle" size="sm" className="mt-2">
                      At least one identity does not hold. The failing row above names it and the
                      amount it is out by.
                    </Alert>
                  ) : null}
                </div>
              </CardBody>
            </Card>

            <ContinuationSheet
              invoice={invoice}
              editable={editable}
              frozenReason={frozenReason}
              onSave={saveLines}
              saving={saving}
              refusal={lineRefusal}
            />

            <WaiverPanel
              invoiceId={invoice.id}
              currency={invoice.currency}
              onChanged={onChanged}
            />

            <PaymentsPanel invoice={invoice} onChanged={onChanged} />

            <Card>
              <CardHeader
                title="Approval trail"
                subtitle="Author, submitter, reviewer and approver are four distinct roles. The API refuses to let one person be more than one of them."
              />
              <CardBody>
                <DescriptionList
                  columns={2}
                  size="sm"
                  items={[
                    { label: "Raised by", value: invoice.createdBy },
                    { label: "Submitted", value: isoDateTime(invoice.submittedAt) },
                    { label: "Submitted by", value: invoice.submittedBy ?? "—" },
                    { label: "Reviewed", value: isoDateTime(invoice.reviewedAt) },
                    { label: "Reviewed by", value: invoice.reviewedBy ?? "—" },
                    { label: "Approved", value: isoDateTime(invoice.approvedAt) },
                    { label: "Approved by", value: invoice.approvedBy ?? "—" },
                    { label: "Billing date", value: isoDate(invoice.billingDate) },
                    { label: "Due", value: isoDate(invoice.dueDate) },
                    {
                      label: "Billing period",
                      value: period ? `${period.reference} — ${period.name}` : "not in a period",
                    },
                  ]}
                />
              </CardBody>
            </Card>
          </div>
        ) : null}
      </DrawerBody>

      {/* ---- approve ---- */}
      <Modal
        open={approving}
        onClose={() => setApproving(false)}
        title={invoice ? `Approve ${invoice.reference}` : "Approve invoice"}
        description="Approval is what rolls the schedule of values forward. Certifying less than was applied for requires a stated reason — an unexplained reduction is a dispute waiting to happen."
        footer={
          <>
            <Button variant="ghost" onClick={() => setApproving(false)}>
              Cancel
            </Button>
            <Button
              disabled={approvedAmount !== null && !reviewNotes.trim()}
              onClick={async () => {
                const body: Record<string, unknown> = {};
                if (approvedAmount !== null) {
                  body["approvedAmount"] = approvedAmount;
                  body["asNoted"] = true;
                }
                if (reviewNotes.trim()) body["reviewNotes"] = reviewNotes.trim();
                const ok = await act("approve", body, "Invoice approved.");
                if (ok) setApproving(false);
              }}
            >
              Approve
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <RefusalPanel refusal={refusal} />
          {invoice ? (
            <Alert tone="info" variant="subtle" size="sm">
              Applied for: <strong>{money(invoice.currentPaymentDue, invoice.currency)}</strong>.
              Leave the amount blank to approve in full. An approver may certify less than was asked
              for, never more.
            </Alert>
          ) : null}
          <Field
            label={`Approve a different amount${invoice ? ` (${invoice.currency})` : ""}`}
            optional
            hint="Leave blank to approve as applied for."
          >
            <NumberInput
              value={approvedAmount}
              onChange={setApprovedAmount}
              precision={2}
              align="right"
              min={0}
            />
          </Field>
          <Field
            label="Review notes"
            required={approvedAmount !== null}
            hint={
              approvedAmount !== null
                ? "Required: you are certifying a different figure from the one applied for."
                : undefined
            }
          >
            <Textarea
              rows={3}
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
            />
          </Field>
        </div>
      </Modal>

      {/* ---- reject / revise ---- */}
      <Modal
        open={rejecting || revising}
        onClose={() => {
          setRejecting(false);
          setRevising(false);
        }}
        title={rejecting ? "Reject this invoice" : "Send this invoice back for revision"}
        description={
          rejecting
            ? "A rejection always carries a reason. Rejected invoices are excluded from every rollup."
            : "The common case: the numbers are wrong, not the claim. The invoice goes back to draft with your reason attached."
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setRejecting(false);
                setRevising(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant={rejecting ? "danger" : "primary"}
              disabled={!reason.trim()}
              onClick={async () => {
                const ok = await act(
                  rejecting ? "reject" : "revise",
                  { reason: reason.trim() },
                  rejecting ? "Invoice rejected." : "Sent back for revision.",
                );
                if (ok) {
                  setRejecting(false);
                  setRevising(false);
                  setReason("");
                }
              }}
            >
              {rejecting ? "Reject invoice" : "Send back"}
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Modal>

      {/* ---- void ---- */}
      <ConfirmDialog
        open={voiding}
        onClose={() => setVoiding(false)}
        title="Void this invoice?"
        description="Voiding removes the invoice from every rollup. An invoice with money paid against it cannot be voided, and neither can an approved one — approval has already rolled the schedule of values forward, and the way out of that is a credit on the next application, not a void."
        destructive
        confirmLabel="Void invoice"
        onConfirm={async () => {
          const ok = await act("void", { reason: reason.trim() || "Voided" }, "Invoice voided.");
          if (ok) setVoiding(false);
          return ok;
        }}
      >
        <Field label="Reason" required>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </Drawer>
  );
}
