/**
 * PAYMENTS AGAINST A COMMITMENT — the moment the compliance gate bites.
 *
 * Three acts by three people, and the panel keeps them apart because the API
 * does: schedule (createdBy), approve (approvedBy), issue (issuedBy). The
 * approver may not be the author; the issuer may not be the approver.
 *
 * At approve and at issue the API re-reads the vendor's insurance certificates
 * and bonds and either warns or REFUSES. When it refuses it sends a 409
 * carrying the findings themselves — which certificate, expired on which date,
 * how many days ago. Every one of those sentences is rendered here exactly as
 * sent. Softening "The general liability certificate expired on 2026-03-14
 * (164 days ago) — the vendor is uninsured for this cover today" into
 * "Compliance failed" would throw away the only part of it anyone can act on.
 */
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import {
  COMPLIANCE_LABEL,
  FindingList,
  RefusalPanel,
  complianceTone,
  isoDate,
  money,
  titleCase,
  useAction,
  useReason,
  type Loadable,
} from "./shared";
import type {
  Commitment,
  CommitmentPayment,
  CommitmentPosition,
  ComplianceResult,
  PaymentRegister,
} from "./types";

const METHODS = ["check", "ach", "wire", "credit_card", "cash", "joint_check", "other"] as const;

function paymentTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status) {
    case "cleared":
      return "success";
    case "issued":
      return "info";
    case "on_hold":
      return "warning";
    case "failed":
    case "voided":
      return "danger";
    default:
      return "neutral";
  }
}

export default function PaymentsPanel({
  commitment,
  compliance,
  position,
  payments,
  onChanged,
}: {
  commitment: Commitment;
  compliance: ComplianceResult;
  position: CommitmentPosition;
  payments: Loadable<PaymentRegister>;
  onChanged: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog: reasonDialog } = useReason();
  const [scheduling, setScheduling] = useState(false);
  /** The payment the issue dialog is open on — issuing is never a one-click act. */
  const [issuing, setIssuing] = useState<CommitmentPayment | null>(null);
  /** The compliance result the API returned alongside the last successful act. */
  const [lastCompliance, setLastCompliance] = useState<ComplianceResult | null>(null);

  const currency = payments.data?.currency ?? commitment.currency;
  const rows = payments.data?.items ?? [];
  const register = payments.data?.register ?? null;

  const blocked = compliance.blocking.length > 0;

  async function act(payment: CommitmentPayment, verb: string, path: string, body?: unknown) {
    const result = await run(`${verb}:${payment.id}`, () =>
      api.post<{ compliance?: ComplianceResult }>(
        `/api/v1/commitment-payments/${payment.id}/${path}`,
        body ?? {},
      ),
    );
    if (result !== null) {
      setLastCompliance(result?.compliance ?? null);
      payments.reload();
      onChanged();
    }
  }

  const columns = useMemo<DataColumns<CommitmentPayment>>(
    () => [
      {
        id: "reference",
        header: "Payment",
        accessor: "reference",
        type: "code",
        width: 150,
        sticky: "start",
        mono: true,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={paymentTone(row.status)} dot size="xs">
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "currency",
        currency,
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        aggregate: "none",
      },
      {
        id: "retainageReleasedAmount",
        header: "Retainage released",
        accessor: "retainageReleasedAmount",
        type: "currency",
        currency,
        precision: 2,
        align: "right",
        width: 160,
        mono: true,
        aggregate: "none",
      },
      {
        id: "method",
        header: "Method",
        accessor: (row) => titleCase(row.method),
        type: "text",
        width: 120,
      },
      {
        id: "paymentDate",
        header: "Payment date",
        accessor: "paymentDate",
        type: "date",
        width: 130,
        cell: ({ row }) => isoDate(row.paymentDate),
      },
      {
        id: "control",
        header: "Who did what",
        headerTooltip:
          "Approval releases the payment; issue cuts it. They are deliberately separate acts by separate people.",
        accessor: (row) => `${row.approvedBy ?? ""}|${row.issuedBy ?? ""}`,
        type: "custom",
        width: 230,
        truncate: false,
        sortable: false,
        cell: ({ row }) => (
          <span className="text-2xs text-content-muted">
            <span className="block">
              approved:{" "}
              {row.approvedBy ? (
                <span className="font-mono">{row.approvedBy}</span>
              ) : (
                <span className="italic text-content-subtle">not yet</span>
              )}
            </span>
            <span className="block">
              issued:{" "}
              {row.issuedBy ? (
                <span className="font-mono">{row.issuedBy}</span>
              ) : (
                <span className="italic text-content-subtle">not yet</span>
              )}
            </span>
          </span>
        ),
      },
      {
        id: "holdReason",
        header: "Hold reason",
        accessor: (row) => row.holdReason ?? "",
        type: "text",
        width: 280,
        truncate: false,
        cell: ({ row }) =>
          row.holdReason ? (
            <span className="whitespace-normal text-2xs text-danger-fg">{row.holdReason}</span>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "actions",
        header: "",
        width: 260,
        sortable: false,
        interactive: true,
        exportable: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.status === "scheduled" && !row.approvedBy ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => act(row, "approve", "approve")}
              >
                Approve
              </Button>
            ) : null}
            {row.status === "scheduled" && row.approvedBy ? (
              <Button size="xs" disabled={busy !== null} onClick={() => setIssuing(row)}>
                Issue
              </Button>
            ) : null}
            {row.status === "issued" ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => act(row, "clear", "clear")}
              >
                Mark cleared
              </Button>
            ) : null}
            {row.status === "on_hold" ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => act(row, "release", "release")}
              >
                Release hold
              </Button>
            ) : null}
            {row.status !== "cleared" && row.status !== "voided" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy !== null}
                onClick={async () => {
                  const reason = await ask({
                    title: `Void ${row.reference}?`,
                    description:
                      "A cleared payment can never be voided — the funds have settled and the record must survive. This one has not cleared. Voiding an issued payment also reverses the retainage it released.",
                    label: "Reason for voiding this payment",
                    confirmLabel: "Void the payment",
                    destructive: true,
                  });
                  if (!reason) return;
                  await act(row, "void", "void", { reason });
                }}
              >
                Void
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [currency, busy],
  );

  return (
    <div className="space-y-3">
      {reasonDialog}

      <PaymentGate commitment={commitment} compliance={compliance} />

      <RefusalPanel refusal={refusal} onDismiss={clear} />

      {lastCompliance && lastCompliance.warnings.length > 0 ? (
        <Alert tone="warning" title="This payment moved with compliance warnings recorded on it">
          <p>
            The API permitted the act and stamped the warnings onto the payment, so &ldquo;we knew
            and paid anyway&rdquo; is a fact on the record rather than a guess.
          </p>
          <FindingList findings={lastCompliance.warnings} />
        </Alert>
      ) : null}

      {register ? (
        <Card>
          <CardBody className="grid gap-3 sm:grid-cols-5">
            <Money label="Paid" value={register.paid} currency={currency} />
            <Money label="Scheduled" value={register.scheduled} currency={currency} />
            <Money label="On hold" value={register.onHold} currency={currency} tone="warning" />
            <Money label="Failed" value={register.failed} currency={currency} tone="danger" />
            <Money
              label="Retainage released"
              value={register.retainageReleasedPaid}
              currency={currency}
            />
          </CardBody>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <p className="text-meta text-content-subtle">
          Outstanding to pay:{" "}
          <span className="font-mono tabular-nums">
            {money(position.outstandingToPay, position.currency)}
          </span>{" "}
          — invoiced {money(position.totalInvoiced, position.currency)} less paid{" "}
          {money(position.totalPaid, position.currency)}.
        </p>
        <Button
          size="sm"
          onClick={() => setScheduling(true)}
          disabled={commitment.status !== "approved" && commitment.status !== "complete"}
        >
          Schedule a payment
        </Button>
      </div>

      {commitment.status !== "approved" && commitment.status !== "complete" ? (
        <p className="text-2xs text-content-subtle">
          A payment can only be scheduled against an approved commitment. This one is{" "}
          {titleCase(commitment.status).toLowerCase()} — paying against an unapproved subcontract is
          uncontrolled cost.
        </p>
      ) : null}

      {rows.length === 0 && !payments.loading ? (
        <EmptyState
          title="No payments against this commitment"
          hint="Nothing has been scheduled, approved or issued yet."
        />
      ) : (
        <DataTable<CommitmentPayment>
          tableId="commitment-payments"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={payments.loading}
          height={380}
          stickyHeader
          gridLines
          savedViews={false}
          exportFileName={`payments-${commitment.reference}`}
          defaultSort={[{ id: "reference", desc: true }]}
          rowTone={(row) => (row.status === "on_hold" ? "warning" : undefined)}
          aria-label={`Payments against ${commitment.reference}`}
        />
      )}

      <IssuePayment
        payment={issuing}
        compliance={compliance}
        currency={currency}
        busy={busy !== null}
        onClose={() => setIssuing(null)}
        onIssue={async (acknowledgeWarnings) => {
          const target = issuing;
          setIssuing(null);
          if (target) await act(target, "issue", "issue", { acknowledgeWarnings });
        }}
      />

      <SchedulePayment
        open={scheduling}
        commitment={commitment}
        currency={currency}
        blocked={blocked}
        onClose={() => setScheduling(false)}
        onCreated={(result) => {
          setScheduling(false);
          setLastCompliance(result);
          payments.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function Money({
  label,
  value,
  currency,
  tone,
}: {
  label: string;
  value: number;
  currency: string;
  tone?: "warning" | "danger";
}) {
  return (
    <div>
      <div className="text-label uppercase text-content-subtle">{label}</div>
      <div
        className={
          "mt-0.5 text-base font-semibold tabular-nums " +
          (tone === "danger"
            ? "text-danger-fg"
            : tone === "warning"
              ? "text-warning-fg"
              : "text-content")
        }
      >
        {money(value, currency)}
      </div>
    </div>
  );
}

/**
 * The gate, stated before anyone reaches for a button. A blocked commitment
 * says which findings block it and what would clear them; a warned one says
 * payment is permitted and the exposure is recorded.
 */
function PaymentGate({
  commitment,
  compliance,
}: {
  commitment: Commitment;
  compliance: ComplianceResult;
}) {
  const tone = complianceTone(compliance.status);
  const blocked = compliance.blocking.length > 0;
  return (
    <Alert
      tone={tone}
      title={`${COMPLIANCE_LABEL[compliance.status]} — the payment gate, assessed ${compliance.asOf}`}
    >
      {blocked ? (
        <p>
          Approving or issuing a payment against {commitment.reference} will be refused while these
          findings stand. The refusal is not advisory — it is a 409 from the API carrying the
          findings themselves.
        </p>
      ) : compliance.status === "warning" ? (
        <p>
          Payment is permitted. The warnings below are recorded against the payment when it is
          issued, so the exposure is on the record rather than in someone&rsquo;s memory.
        </p>
      ) : compliance.status === "unknown" ? (
        <p>{compliance.note}</p>
      ) : (
        <p>
          Every insurance and bond requirement recorded on this commitment is satisfied as at{" "}
          {compliance.asOf}.
        </p>
      )}
      {commitment.paymentHold === 1 ? (
        <p className="mt-2">
          <Badge tone="danger" variant="solid" size="xs">
            Manual hold
          </Badge>{" "}
          {commitment.complianceHoldReason ??
            "A payment hold is set on this commitment with no reason recorded."}{" "}
          A manual hold outranks every strictness setting, including &ldquo;off&rdquo;.
        </p>
      ) : null}
      <FindingList findings={compliance.blocking} heading="Blocking" />
      <FindingList findings={compliance.warnings} heading="Warnings" />
    </Alert>
  );
}

/**
 * ISSUING IS THE IRREVERSIBLE ACT, so it is never one click.
 *
 * The API stamps `acknowledgedWarnings` onto the payment and into the ledger
 * when the caller sends it — an assertion that the issuer SAW the exposure and
 * paid anyway. Sending that flag without showing the findings would make the
 * platform assert something untrue on the issuer's behalf, so this dialog
 * lists every warning verbatim and only enables the button once the issuer has
 * ticked the acknowledgement. With no warnings on file there is nothing to
 * acknowledge and the flag is not sent at all.
 */
function IssuePayment({
  payment,
  compliance,
  currency,
  busy,
  onClose,
  onIssue,
}: {
  payment: CommitmentPayment | null;
  compliance: ComplianceResult;
  currency: string;
  busy: boolean;
  onClose: () => void;
  onIssue: (acknowledgeWarnings: boolean) => void | Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const warnings = compliance.warnings;
  const needsAck = warnings.length > 0;
  const key = payment?.id ?? "none";

  return (
    <Modal
      key={key}
      open={payment !== null}
      onClose={onClose}
      title={payment ? `Issue ${payment.reference}?` : "Issue payment"}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || (needsAck && !acknowledged)}
            onClick={() => void onIssue(needsAck ? acknowledged : false)}
          >
            {busy ? "Issuing…" : "Issue the payment"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-meta text-content-muted">
          Issuing cuts the payment. The vendor&rsquo;s insurance, bonding and lien-waiver position
          is re-read at this moment and may refuse it outright.
        </p>
        {payment ? (
          <Card>
            <CardBody className="grid gap-3 sm:grid-cols-3">
              <Money label="Approved amount" value={payment.amount} currency={currency} />
              <Money
                label="Retainage released"
                value={payment.retainageReleasedAmount}
                currency={currency}
              />
              <div>
                <div className="text-label uppercase text-content-subtle">Approved by</div>
                <div className="mt-0.5 font-mono text-2xs">{payment.approvedBy ?? "—"}</div>
              </div>
            </CardBody>
          </Card>
        ) : null}
        {needsAck ? (
          <Alert
            tone="warning"
            title={`${warnings.length} compliance warning${warnings.length === 1 ? "" : "s"} stand against this vendor`}
          >
            <p>
              These do not block the payment, but issuing records on the payment and in the ledger
              that they were known at the moment the money moved.
            </p>
            <FindingList findings={warnings} />
            <label className="mt-3 flex items-start gap-2 text-meta">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I have read the warnings above and am issuing this payment anyway. Record my
                acknowledgement against the payment.
              </span>
            </label>
          </Alert>
        ) : (
          <p className="text-meta text-content-subtle">
            No compliance warnings are on file for this vendor as at {compliance.asOf}, so nothing
            is acknowledged on your behalf.
          </p>
        )}
      </div>
    </Modal>
  );
}

function SchedulePayment({
  open,
  commitment,
  currency,
  blocked,
  onClose,
  onCreated,
}: {
  open: boolean;
  commitment: Commitment;
  currency: string;
  blocked: boolean;
  onClose: () => void;
  onCreated: (compliance: ComplianceResult | null) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [amount, setAmount] = useState("");
  const [retainage, setRetainage] = useState("");
  const [method, setMethod] = useState<string>("check");
  const [paymentDate, setPaymentDate] = useState("");
  const [notes, setNotes] = useState("");

  const amountNumber = Number(amount);
  const retainageNumber = retainage.trim() === "" ? 0 : Number(retainage);
  const valid =
    Number.isFinite(amountNumber) &&
    amountNumber >= 0 &&
    Number.isFinite(retainageNumber) &&
    retainageNumber >= 0 &&
    (amountNumber > 0 || retainageNumber > 0);

  async function submit() {
    const result = await run("schedule", () =>
      api.post<{ compliance?: ComplianceResult; warnings?: string[] }>(
        `/api/v1/commitments/${commitment.id}/payments`,
        {
          amount: amountNumber,
          ...(retainageNumber > 0 ? { retainageReleasedAmount: retainageNumber } : {}),
          method,
          ...(paymentDate ? { paymentDate } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      ),
    );
    if (result !== null) {
      setAmount("");
      setRetainage("");
      setNotes("");
      onCreated(result?.compliance ?? null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Schedule a payment on ${commitment.reference}`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || busy !== null}>
            Schedule
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        {blocked ? (
          <Alert tone="danger" size="sm" title="This commitment is payment-blocked today">
            The payment will still be recorded, but the API creates it in the{" "}
            <strong>on_hold</strong> status with the blocking findings copied onto it as its hold
            reason. It cannot be approved or issued until they clear.
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Amount (${currency})`} required>
            <Input
              value={amount}
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field
            label={`Retainage released (${currency})`}
            optional
            hint="Released retainage is allocated back across the schedule of values when the payment is issued."
          >
            <Input
              value={retainage}
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => setRetainage(e.target.value)}
            />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment date" optional>
            <Input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Notes" optional>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="text-2xs text-content-subtle">
          The payment is denominated in {currency}, the commitment&rsquo;s own currency. The API
          refuses a payment in any other currency rather than converting it.
        </p>
      </div>
    </Modal>
  );
}
