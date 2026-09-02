/**
 * THE APPLICATION AND CERTIFICATE FOR PAYMENT — laid out as the certificate it
 * represents, not as a total with a number next to it.
 *
 * The nine numbered lines of a G702 exist because each one is derived from the
 * one above it, and the derivation is the document's whole value: an owner's
 * representative reads line 8 by checking lines 1 to 7. So every line here
 * carries its own arithmetic in the margin, and the identities the API
 * computed — line 1 + line 2 = line 3, Σ G703 column G = line 4, and the rest —
 * are printed underneath with both of their sides.
 *
 * Where the API says a figure is not derivable, "not available" and the reason
 * are printed. `percentComplete` on a zero-value line is the common case, and
 * a 0 there would be a factual claim that no work has been done.
 */
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Modal,
  Spinner,
  Textarea,
  useConfirm,
} from "../../ui";
import { DataTable, type DataCellChange, type DataColumns } from "../../ui/data";
import {
  ComponentValue,
  IdentityList,
  RefusalPanel,
  isoDate,
  money,
  pct,
  statusToneOf,
  titleCase,
  useAction,
  useReason,
  useReceipts,
  type Loadable,
} from "./shared";
import type { BillingView, ContractView, G703Line } from "./types";

export default function Certificate({
  contract,
  billing,
  onChanged,
  onBack,
}: {
  contract: ContractView;
  billing: Loadable<BillingView>;
  onChanged: () => void;
  onBack: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const { ask, dialog: reasonDialog } = useReason();
  const [submitting, setSubmitting] = useState(false);
  const [certifying, setCertifying] = useState(false);
  const [receiving, setReceiving] = useState(false);

  const view = billing.data;
  const receipts = useReceipts(contract.id, view?.application.id ?? null);

  async function act(verb: string, path: string, body?: unknown) {
    if (!view) return null;
    const done = await run(verb, () =>
      api.post(
        `/api/v1/prime-contracts/${contract.id}/billings/${view.application.id}/${path}`,
        body ?? {},
      ),
    );
    if (done !== null) {
      billing.reload();
      onChanged();
    }
    return done;
  }

  async function saveLines(changes: ReadonlyArray<DataCellChange<G703Line>>) {
    if (!view) return;
    const byLine = new Map<string, Record<string, unknown>>();
    for (const change of changes) {
      const row = view.g703.find((l) => l.id === change.rowId);
      if (!row?.primeContractSovLineId) continue;
      const patch = byLine.get(row.primeContractSovLineId) ?? {
        sovLineId: row.primeContractSovLineId,
      };
      patch[change.columnId] = change.value;
      byLine.set(row.primeContractSovLineId, patch);
    }
    if (byLine.size === 0) return;
    const done = await run("lines", () =>
      api.put(`/api/v1/prime-contracts/${contract.id}/billings/${view.application.id}/lines`, {
        lines: [...byLine.values()],
      }),
    );
    if (done !== null) {
      onChanged();
    }
    billing.reload();
  }

  const cur = view?.g702.currency ?? contract.currency;
  const editable = view?.application.status === "draft";

  const columns = useMemo<DataColumns<G703Line>>(
    () => [
      {
        id: "lineNumber",
        header: "Item",
        accessor: "lineNumber",
        type: "code",
        width: 90,
        sticky: "start",
        mono: true,
      },
      {
        id: "description",
        header: "Description of work",
        accessor: "description",
        type: "text",
        width: 260,
        cell: ({ row }) => (
          <span>
            {row.description}
            {row.source === "change_order" ? (
              <Badge tone="info" size="xs" variant="outline" className="ml-1">
                CO
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "scheduledValue",
        header: "C · Scheduled value",
        accessor: "scheduledValue",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 170,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "previousBilled",
        header: "D · Previous applications",
        accessor: "previousBilled",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 190,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "thisPeriodWork",
        header: "E · This period",
        headerTooltip: editable
          ? "Editable while the application is a draft. Enter the amount earned this period; the API re-derives the whole sheet from it."
          : "Frozen — this application has left the contractor's hands.",
        accessor: "thisPeriodWork",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 160,
        mono: true,
        aggregate: "sum",
        editable: editable === true,
        editor: { kind: "number", step: 0.01 },
        parse: (raw) => {
          const n = Number(raw.replace(/[^0-9.eE+-]/g, ""));
          return Number.isFinite(n) ? n : null;
        },
        validate: (value) =>
          typeof value === "number" && Number.isFinite(value)
            ? null
            : "This period's earned value must be a number.",
      },
      {
        id: "materialsPresentlyStored",
        header: "F · Stored materials",
        headerTooltip:
          "The BALANCE on site, not a delta. Editable while the application is a draft.",
        accessor: "materialsPresentlyStored",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 180,
        mono: true,
        aggregate: "sum",
        editable: editable === true,
        editor: { kind: "number", step: 0.01 },
        parse: (raw) => {
          const n = Number(raw.replace(/[^0-9.eE+-]/g, ""));
          return Number.isFinite(n) ? n : null;
        },
        validate: (value) =>
          typeof value === "number" && value >= 0
            ? null
            : "Stored materials cannot be negative.",
      },
      {
        id: "totalCompletedAndStored",
        header: "G · Total completed and stored",
        headerTooltip: "G = D + E + F.",
        accessor: "totalCompletedAndStored",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 220,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "percentComplete",
        header: "G ÷ C",
        accessor: "percentComplete",
        type: "percent",
        align: "right",
        width: 100,
        aggregate: "none",
        cell: ({ row }) =>
          row.scheduledValue === 0 ? (
            <span className="text-2xs italic text-content-subtle">
              undefined against a zero scheduled value
            </span>
          ) : (
            <span className="font-mono tabular-nums">{pct(row.percentComplete, 1)}</span>
          ),
      },
      {
        id: "balanceToFinish",
        header: "H · Balance to finish",
        accessor: "balanceToFinish",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 180,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "retainageHeldToDate",
        header: "I · Retainage",
        accessor: "retainageHeldToDate",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 150,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "retainageThisPeriod",
        header: "Retainage movement",
        headerTooltip: "Negative means retainage was released this period.",
        accessor: "retainageThisPeriod",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 170,
        mono: true,
        signColor: true,
        defaultHidden: true,
        aggregate: "sum",
      },
    ],
    [cur, editable],
  );

  if (billing.loading && !view) {
    return (
      <div className="py-12">
        <Spinner label="Loading the application…" />
      </div>
    );
  }
  if (billing.error) {
    return (
      <Alert tone="danger" title="This application could not be loaded">
        {billing.error}
      </Alert>
    );
  }
  if (!view) return null;

  const a = view.application;
  const g = view.g702;

  return (
    <div className="space-y-4">
      {dialog}
      {reasonDialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← All applications
        </Button>
        <span className="font-mono text-sm font-semibold">{a.reference}</span>
        <Badge tone={statusToneOf(a.status)} dot>
          {titleCase(a.status)}
        </Badge>
        <span className="text-2xs text-content-subtle">
          Application date {isoDate(a.applicationDate)} · period to {isoDate(a.periodTo)}
        </span>
        <span className="flex-1" />
        {a.status === "draft" ? (
          <Button size="sm" onClick={() => setSubmitting(true)} disabled={busy !== null}>
            Submit for certification
          </Button>
        ) : null}
        {a.status === "submitted" ? (
          <>
            <Button size="sm" onClick={() => setCertifying(true)} disabled={busy !== null}>
              Certify
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={async () => {
                const reason = await ask({
                  title: `Reject ${a.reference}?`,
                  description:
                    "A rejected application returns to the contractor with the reason attached. It can then be reopened as a draft, corrected and resubmitted.",
                  label: "Why is this application rejected?",
                  confirmLabel: "Reject it",
                });
                if (!reason) return;
                await act("reject", "reject", { reason });
              }}
            >
              Reject
            </Button>
          </>
        ) : null}
        {a.status === "rejected" || a.status === "submitted" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => act("reopen", "reopen")}
          >
            Reopen as draft
          </Button>
        ) : null}
        {a.status === "certified" || a.status === "partially_certified" ? (
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setReceiving(true)}>
            Record a receipt
          </Button>
        ) : null}
        {a.status === "draft" || a.status === "submitted" || a.status === "rejected" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={async () => {
              const reason = await ask({
                title: `Void ${a.reference}?`,
                description:
                  "The application and its owner invoice are marked void, and the this-period figures it mirrored onto the schedule of values are reset to the certified position. A certified application cannot be voided. Admin only.",
                label: "Why is this application void?",
                confirmLabel: "Void it",
                destructive: true,
              });
              if (!reason) return;
              await act("void", "void", { reason });
            }}
          >
            Void
          </Button>
        ) : null}
      </div>

      {a.status === "certified" || a.status === "partially_certified" || a.status === "paid" ? (
        <Card>
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Settlement</h3>
              {receipts.data ? (
                <span className="text-meta">
                  {money(receipts.data.paid, cur)} received of {money(receipts.data.certified, cur)} certified
                  {receipts.data.outstanding !== null && receipts.data.outstanding > 0.005 ? (
                    <Badge tone="warning" size="xs" className="ml-2">
                      {money(receipts.data.outstanding, cur)} outstanding
                    </Badge>
                  ) : (
                    <Badge tone="success" size="xs" className="ml-2">
                      settled
                    </Badge>
                  )}
                </span>
              ) : null}
            </div>
            {receipts.error ? <Alert tone="danger" size="sm" title="Receipts could not be loaded">{receipts.error}</Alert> : null}
            {(receipts.data?.items ?? []).length === 0 ? (
              <p className="text-2xs text-content-subtle">
                No receipt recorded yet. Each remittance from the owner is one receipt; the application is paid only when the receipts cover the certified amount.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle text-meta">
                {(receipts.data?.items ?? []).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                    <span>
                      <span className="font-mono">{r.reference}</span> · {isoDate(r.receivedDate)} · {titleCase(r.method)}
                      {r.paymentReference ? ` · ${r.paymentReference}` : ""}
                      {r.status === "void" ? (
                        <Badge tone="neutral" size="xs" className="ml-1">
                          void
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={"font-mono tabular-nums" + (r.status === "void" ? " line-through text-content-subtle" : "")}>{money(r.amount, cur)}</span>
                      {r.status !== "void" ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={async () => {
                            const reason = await ask({
                              title: `Void receipt ${r.reference}?`,
                              description: "A bounced or mis-keyed remittance is voided, never deleted; the application's settlement is re-derived from the receipts that remain.",
                              label: "Why is this receipt void?",
                              confirmLabel: "Void the receipt",
                              destructive: true,
                            });
                            if (!reason) return;
                            const done = await run("void-receipt", () => api.post(`/api/v1/owner-payment-receipts/${r.id}/void`, { reason }));
                            if (done !== null) {
                              receipts.reload();
                              billing.reload();
                              onChanged();
                            }
                          }}
                        >
                          Void
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ) : null}

      {a.status === "certified" || a.status === "partially_certified" ? (
        <Alert
          tone={a.status === "partially_certified" ? "warning" : "success"}
          title={
            a.status === "partially_certified"
              ? "Certified for less than was applied for"
              : "Certified in full"
          }
        >
          <p>
            Certified {money(a.certifiedAmount ?? a.currentPaymentDue, cur)} against{" "}
            {money(a.currentPaymentDue, cur)} applied for
            {a.certifiedAmount !== null && a.certifiedAmount < a.currentPaymentDue
              ? ` — a shortfall of ${money(a.currentPaymentDue - a.certifiedAmount, cur)}`
              : ""}
            {a.certifiedAt ? `, on ${isoDate(a.certifiedAt)}` : ""}.
          </p>
          {a.certificationNotes ? <p className="mt-1">{a.certificationNotes}</p> : null}
          <p className="mt-1 text-2xs">
            A certified application is a third party&rsquo;s determination and does not reopen. A
            correction is made on the next application, where line 7 carries what was certified
            before.
          </p>
        </Alert>
      ) : null}

      {a.status === "rejected" && a.rejectionReason ? (
        <Alert tone="danger" title="Rejected">
          {a.rejectionReason}
        </Alert>
      ) : null}

      <G702Sheet g702={g} application={a} reconciled={view.reconciled} />

      <IdentityList
        identities={view.identities}
        currency={cur}
        title="The certificate's own arithmetic, checked"
      />

      <div>
        <h3 className="mb-2 text-sm font-semibold">
          G703 continuation sheet
          {editable ? (
            <span className="ml-2 text-2xs font-normal text-content-subtle">
              Columns E and F are editable while this application is a draft. Everything else is
              derived — the API recomputes the whole sheet and the cover sheet from what you enter.
            </span>
          ) : (
            <span className="ml-2 text-2xs font-normal text-content-subtle">
              Frozen: this application is {titleCase(a.status).toLowerCase()}.
            </span>
          )}
        </h3>
        <DataTable<G703Line>
          tableId="prime-g703"
          data={view.g703}
          columns={columns}
          getRowId={(row) => row.id}
          loading={billing.loading}
          height={480}
          stickyHeader
          showFooter
          stickyFooter
          gridLines
          editable={editable === true}
          bufferEdits
          onCommitEdits={saveLines}
          savedViews={false}
          exportFileName={`g703-${a.reference}`}
          defaultSort={[{ id: "lineNumber", desc: false }]}
          empty={{
            title: "This application has no continuation sheet",
            description:
              "An application is populated from the contract's schedule of values when it is opened. An empty sheet means the schedule was empty.",
          }}
          aria-label={`G703 continuation sheet for ${a.reference}`}
        />
      </div>

      <SubmitDialog
        open={submitting}
        contractId={contract.id}
        applicationId={a.id}
        currentPaymentDue={money(a.currentPaymentDue, cur)}
        onClose={() => setSubmitting(false)}
        onDone={() => {
          setSubmitting(false);
          billing.reload();
          onChanged();
        }}
      />
      <CertifyDialog
        open={certifying}
        contractId={contract.id}
        applicationId={a.id}
        appliedFor={a.currentPaymentDue}
        currency={cur}
        onClose={() => setCertifying(false)}
        onDone={() => {
          setCertifying(false);
          billing.reload();
          onChanged();
        }}
      />
      <ReceiptDialog
        open={receiving}
        contractId={contract.id}
        applicationId={a.id}
        outstanding={receipts.data?.outstanding ?? (a.certifiedAmount ?? a.currentPaymentDue) - a.paidAmount}
        currency={cur}
        onClose={() => setReceiving(false)}
        onDone={() => {
          setReceiving(false);
          receipts.reload();
          billing.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/**
 * One remittance from the owner. Partial payments are the norm — an owner
 * short-pays a retention dispute, or pays in two wires — so the receipt is
 * the record and the application's settlement is derived from the receipts.
 */
function ReceiptDialog({
  open,
  contractId,
  applicationId,
  outstanding,
  currency,
  onClose,
  onDone,
}: {
  open: boolean;
  contractId: string;
  applicationId: string;
  outstanding: number;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("ach");
  const [reference, setReference] = useState("");
  const [bankReference, setBankReference] = useState("");
  const value = amount.trim() === "" ? outstanding : Number(amount);
  const over = Number.isFinite(value) && value - outstanding > 0.005;

  async function submit() {
    const done = await run("receipt", () =>
      api.post(`/api/v1/prime-contracts/${contractId}/billings/${applicationId}/receipts`, {
        ...(amount.trim() === "" ? {} : { amount: Number(amount) }),
        receivedDate: date,
        method,
        ...(reference.trim() ? { paymentReference: reference.trim() } : {}),
        ...(bankReference.trim() ? { bankReference: bankReference.trim() } : {}),
      }),
    );
    if (done !== null) {
      setAmount("");
      setReference("");
      setBankReference("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a receipt"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={over || !Number.isFinite(value) || value <= 0 || busy !== null}>
            Record {money(Number.isFinite(value) ? value : 0, currency)}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <p className="text-meta text-content-muted">
          Outstanding on this certificate: <strong>{money(outstanding, currency)}</strong>. Σ receipts may never exceed the certified amount; the application becomes paid only when they cover it.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Amount (${currency})`} hint="Leave blank to record the whole outstanding balance.">
            <Input value={amount} inputMode="decimal" placeholder={String(outstanding)} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Received on" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Method">
            <select className="h-control w-full rounded-md border border-border bg-surface px-2 text-body" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
              {["ach", "wire", "check", "card", "other"].map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payment reference" optional>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Bank reference" optional className="sm:col-span-2">
            <Input value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
          </Field>
        </div>
        {over ? (
          <Alert tone="danger" size="sm" title="More than is outstanding">
            The API refuses a receipt larger than the balance still due on the certificate.
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * The cover sheet. Nine numbered lines, each with the arithmetic that produced
 * it printed beside it, because that derivation is the document.
 */
function G702Sheet({
  g702,
  application,
  reconciled,
}: {
  g702: import("./types").G702;
  application: import("./types").PaymentApplication;
  reconciled: boolean;
}) {
  const cur = g702.currency;
  const rows: Array<{
    n: string;
    label: string;
    derivation: string;
    value: number;
    strong?: boolean;
    indent?: boolean;
  }> = [
    {
      n: "1",
      label: "Original contract sum",
      derivation: "as executed",
      value: g702.originalContractSum,
    },
    {
      n: "2",
      label: "Net change by change orders",
      derivation: "Σ executed change orders",
      value: g702.netChangeOrders,
    },
    {
      n: "3",
      label: "Contract sum to date",
      derivation: "line 1 + line 2",
      value: g702.contractSumToDate,
      strong: true,
    },
    {
      n: "4",
      label: "Total completed and stored to date",
      derivation: "Σ column G on the continuation sheet",
      value: g702.totalCompletedAndStored,
      strong: true,
    },
    {
      n: "",
      label: "of which work completed",
      derivation: "Σ columns D + E",
      value: g702.completedToDate,
      indent: true,
    },
    {
      n: "",
      label: "of which stored material",
      derivation: "Σ column F",
      value: g702.storedMaterials,
      indent: true,
    },
    {
      n: "5a",
      label: `Retainage on completed work at ${pct(g702.retainagePercentWork)}`,
      derivation: `${pct(g702.retainagePercentWork)} × work completed`,
      value: g702.retainageWork,
      indent: true,
    },
    {
      n: "5b",
      label: `Retainage on stored material at ${pct(g702.retainagePercentMaterials)}`,
      derivation: `${pct(g702.retainagePercentMaterials)} × stored material`,
      value: g702.retainageMaterials,
      indent: true,
    },
    {
      n: "5",
      label: "Total retainage",
      derivation: "line 5a + line 5b",
      value: g702.totalRetainage,
    },
    {
      n: "6",
      label: "Total earned less retainage",
      derivation: "line 4 − line 5",
      value: g702.totalEarnedLessRetainage,
      strong: true,
    },
    {
      n: "7",
      label: "Less previous certificates for payment",
      derivation: "sum of amounts certified on prior applications",
      value: g702.lessPreviousCertificates,
    },
    {
      n: "8",
      label: "Current payment due",
      derivation: "line 6 − line 7",
      value: g702.currentPaymentDue,
      strong: true,
    },
    {
      n: "9",
      label: "Balance to finish, including retainage",
      derivation: "line 3 − line 6",
      value: g702.balanceToFinishPlusRetainage,
      strong: true,
    },
  ];

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Application and certificate for payment — {application.reference}
          </h3>
          <Badge tone={reconciled ? "success" : "danger"} dot size="xs">
            {reconciled ? "Every identity reconciles" : "An identity does not reconcile"}
          </Badge>
        </div>

        <table className="w-full text-meta">
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={`${row.n}-${row.label}`}
                className={
                  "border-b border-border-subtle last:border-0 " +
                  (row.strong ? "font-semibold" : "")
                }
              >
                <td className="w-10 py-1.5 align-top font-mono text-content-subtle">{row.n}</td>
                <td className={"py-1.5 align-top " + (row.indent ? "pl-4" : "")}>
                  {row.label}
                  <span className="ml-2 font-mono text-2xs font-normal text-content-subtle">
                    {row.derivation}
                  </span>
                </td>
                <td className="w-44 py-1.5 text-right align-top font-mono tabular-nums">
                  {money(row.value, cur)}
                </td>
              </tr>
            ))}
            <tr>
              <td className="py-1.5" />
              <td className="py-1.5">
                Percent complete
                <span className="ml-2 font-mono text-2xs text-content-subtle">
                  line 4 ÷ line 3
                </span>
              </td>
              <td className="w-44 py-1.5 text-right align-top">
                <ComponentValue
                  component={g702.percentComplete}
                  render={(v) => <span className="font-mono tabular-nums">{pct(v)}</span>}
                  className="block text-right"
                />
              </td>
            </tr>
          </tbody>
        </table>

        <p className="text-2xs text-content-subtle">
          Every figure above is in {cur}. Line 7 is what previous certificates determined, not what
          was applied for — a certifier who certified less than was applied for makes the difference
          reappear here, which is exactly what the form is for.
        </p>

        {application.certifiedByContractorName ? (
          <p className="text-2xs text-content-muted">
            Certified by the contractor: {application.certifiedByContractorName}
            {application.contractorCertifiedAt
              ? ` on ${isoDate(application.contractorCertifiedAt)}`
              : ""}
            {application.notaryReference ? ` · notary ${application.notaryReference}` : ""}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function SubmitDialog({
  open,
  contractId,
  applicationId,
  currentPaymentDue,
  onClose,
  onDone,
}: {
  open: boolean;
  contractId: string;
  applicationId: string;
  currentPaymentDue: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [name, setName] = useState("");
  const [notary, setNotary] = useState("");

  async function submit() {
    const done = await run("submit", () =>
      api.post(`/api/v1/prime-contracts/${contractId}/billings/${applicationId}/submit`, {
        certifiedByContractorName: name.trim(),
        ...(notary.trim() ? { notaryReference: notary.trim() } : {}),
      }),
    );
    if (done !== null) {
      setName("");
      setNotary("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit this application for certification"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={name.trim().length === 0 || busy !== null}>
            Sign and submit
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <p className="text-meta text-content-muted">
          The application is recomputed from the schedule of values one more time as it is
          submitted, so what is sworn to is what the schedule says now — currently{" "}
          <strong>{currentPaymentDue}</strong> as the current payment due.
        </p>
        <Field
          label="Certified by (contractor's authorised signatory)"
          required
          hint="This is the sworn certification on the bottom half of a G702."
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Notary reference" optional>
          <Input value={notary} onChange={(e) => setNotary(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function CertifyDialog({
  open,
  contractId,
  applicationId,
  appliedFor,
  currency,
  onClose,
  onDone,
}: {
  open: boolean;
  contractId: string;
  applicationId: string;
  appliedFor: number;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [certifierName, setCertifierName] = useState("");
  const [documentHash, setDocumentHash] = useState("");

  const certified = amount.trim() === "" ? appliedFor : Number(amount);
  const over = Number.isFinite(certified) && certified - appliedFor > 0.005;
  const short = Number.isFinite(certified) && appliedFor - certified > 0.005;

  async function submit() {
    const done = await run("certify", () =>
      api.post(`/api/v1/prime-contracts/${contractId}/billings/${applicationId}/certify`, {
        ...(amount.trim() === "" ? {} : { certifiedAmount: Number(amount) }),
        ...(notes.trim() ? { certificationNotes: notes.trim() } : {}),
        ...(certifierName.trim()
          ? { certifier: { name: certifierName.trim(), ...(documentHash.trim() ? { documentHash: documentHash.trim() } : {}) } }
          : {}),
      }),
    );
    if (done !== null) {
      setAmount("");
      setNotes("");
      onDone();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Certify this application"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={over || busy !== null}>
            Certify
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <p className="text-meta text-content-muted">
          Applied for: <strong>{money(appliedFor, currency)}</strong>. A certifier may certify LESS
          than was applied for — that is what the form is for — but never more, and may be neither
          the author nor the submitter of the application. Certification also rolls the schedule of
          values forward: this period becomes previous, and retainage held moves.
        </p>
        <Field
          label={`Certified amount (${currency})`}
          optional
          hint="Leave blank to certify the full amount applied for."
        >
          <Input
            value={amount}
            inputMode="decimal"
            placeholder={String(appliedFor)}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        {over ? (
          <Alert tone="danger" size="sm" title="More than was applied for">
            The API refuses a certification above the amount applied for. Reduce it, or ask for a
            revised application.
          </Alert>
        ) : null}
        {short ? (
          <Alert tone="warning" size="sm" title="Partial certification">
            This will certify {money(certified, currency)} against {money(appliedFor, currency)}{" "}
            applied for — a shortfall of {money(appliedFor - certified, currency)}. The application
            is recorded as partially certified and the shortfall reappears on the next
            application&rsquo;s line 7.
          </Alert>
        ) : null}
        <Field label="Certification notes" optional>
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Signed by (owner / architect)" optional hint="The external certifier, recorded on the application and in the ledger.">
            <Input value={certifierName} onChange={(e) => setCertifierName(e.target.value)} />
          </Field>
          <Field label="Signed document hash" optional hint="sha-256 of the signed certificate, if one was received.">
            <Input value={documentHash} onChange={(e) => setDocumentHash(e.target.value)} className="font-mono" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
