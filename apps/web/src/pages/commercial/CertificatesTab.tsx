/**
 * Certificates tab — interim payment certificates with the certificate-vs-
 * application variance statement, the contractual due date and its basis, and
 * the two lifecycle moves the register needs to be truthful: WITHDRAW a
 * certificate that should not have been issued, and record PAYMENT so
 * "certified to date" can become "paid to date" (#179-180).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import {
  certTone,
  money,
  padNo,
  parseNum,
  todayIso,
  useCompanyUsers,
  type BoqRow,
  type CertificateRow,
  type ListResponse,
  type ValuationRow,
} from "./commercialShared";

export default function CertificatesTab({
  projectId,
  boqs,
  onMutate,
}: {
  projectId: string;
  boqs: BoqRow[] | null;
  onMutate?: () => void;
}) {
  const [rows, setRows] = useState<CertificateRow[] | null>(null);
  const [valuations, setValuations] = useState<ValuationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<CertificateRow | null>(null);
  const [paying, setPaying] = useState<CertificateRow | null>(null);
  const { nameOf } = useCompanyUsers();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [certs, vals] = await Promise.all([
        api.get<ListResponse<CertificateRow>>(
          `/api/v1/projects/${projectId}/certificates?pageSize=100`,
        ),
        api.get<ListResponse<ValuationRow>>(
          `/api/v1/projects/${projectId}/valuations?pageSize=100`,
        ),
      ]);
      setRows(certs?.items ?? []);
      setValuations(vals?.items ?? []);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load certificates");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const valById = useMemo(() => new Map(valuations.map((v) => [v.id, v])), [valuations]);
  const currencyFor = useCallback(
    (c: CertificateRow) => {
      if (c.currency) return c.currency;
      const val = valById.get(c.valuationId);
      return boqs?.find((b) => b.id === val?.boqId)?.currency ?? "USD";
    },
    [valById, boqs],
  );

  async function refresh() {
    await load();
    onMutate?.();
  }

  return (
    <div>
      <h2 className="mb-1 text-sm font-semibold text-ink-900">Payment certificates</h2>
      <p className="mb-4 text-xs text-ink-500">
        The due date is derived from the contract&rsquo;s payment clause; a certificate past it is
        flagged, because late payment carries interest and, after notice, a right to suspend.
      </p>
      <ErrorAlert message={error} />
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No certificates yet"
          hint="Certificates are issued from submitted valuations on the Valuations tab."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Valuation</Th>
              <Th className="text-right">Certified work</Th>
              <Th className="text-right">Materials</Th>
              <Th className="text-right">Sections</Th>
              <Th className="text-right">Net certified</Th>
              <Th className="text-right">Variance</Th>
              <Th>Due date</Th>
              <Th>Issued</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((c) => {
              const currency = currencyFor(c);
              const val = valById.get(c.valuationId);
              const variance = c.varianceFromApplication;
              return (
                <tr key={c.id} className="hover:bg-ink-50/60">
                  <Td className="whitespace-nowrap font-mono text-xs font-medium">
                    {padNo("PC", c.number)}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs">
                    {val ? padNo("VAL", val.number) : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">{money(c.certifiedWorkDone, currency)}</Td>
                  <Td className="text-right tabular-nums">{money(c.certifiedMaterials, currency)}</Td>
                  <Td className="text-right tabular-nums">
                    {money(c.certifiedSections, currency)}
                  </Td>
                  <Td className="text-right font-medium tabular-nums">
                    {money(c.netCertified, currency)}
                    {c.status === "paid" ? (
                      <span className="block text-xs font-normal text-emerald-700">
                        {money(c.paidAmount, currency)} paid
                      </span>
                    ) : null}
                  </Td>
                  <Td
                    className={
                      variance === 0
                        ? "text-right tabular-nums text-ink-400"
                        : variance > 0
                          ? "text-right font-medium tabular-nums text-emerald-600"
                          : "text-right font-medium tabular-nums text-red-600"
                    }
                  >
                    {variance === 0 ? "—" : `${variance > 0 ? "+" : ""}${money(variance, currency)}`}
                    {c.varianceReason ? (
                      <span className="ml-1 cursor-help text-ink-400" title={c.varianceReason}>
                        ⓘ
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {formatDate(c.dueDate)}
                    {c.overdue ? (
                      <Badge tone="red" className="ml-1">
                        Overdue
                      </Badge>
                    ) : null}
                    {c.dueDateBasis ? (
                      <span className="block max-w-[14rem] truncate text-[11px] text-ink-400" title={c.dueDateBasis}>
                        {c.dueDateBasis}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {nameOf(c.issuedBy)}
                    <span className="block">{formatDateTime(c.issuedAt)}</span>
                  </Td>
                  <Td>
                    <Badge tone={certTone(c.status)}>{humanize(c.status)}</Badge>
                    {c.withdrawnReason ? (
                      <span className="block max-w-[12rem] truncate text-[11px] text-ink-400" title={c.withdrawnReason}>
                        {c.withdrawnReason}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {c.status === "issued" ? (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="text-xs font-medium text-brand-700 hover:text-brand-900"
                          onClick={() => setPaying(c)}
                        >
                          Record payment
                        </button>
                        <button
                          type="button"
                          className="text-xs font-medium text-red-600 hover:text-red-800"
                          onClick={() => setWithdrawing(c)}
                        >
                          Withdraw
                        </button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <WithdrawModal
        cert={withdrawing}
        onClose={() => setWithdrawing(null)}
        onDone={async () => {
          setWithdrawing(null);
          await refresh();
        }}
      />
      <PaymentModal
        cert={paying}
        currency={paying ? currencyFor(paying) : "USD"}
        onClose={() => setPaying(null)}
        onDone={async () => {
          setPaying(null);
          await refresh();
        }}
      />
    </div>
  );
}

function WithdrawModal({
  cert,
  onClose,
  onDone,
}: {
  cert: CertificateRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open={cert !== null}
      title={cert ? `Withdraw ${padNo("PC", cert.number)}` : ""}
      onClose={onClose}
    >
      <ErrorAlert message={error} />
      <p className="mb-3 text-sm text-ink-600">
        The certificate stops counting anywhere and its application returns to submitted so a
        corrected certificate can be issued. The withdrawal is ledgered with the reason.
      </p>
      <Field label="Reason">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={busy || reason.trim().length < 3 || !cert}
          onClick={() => {
            if (!cert) return;
            setBusy(true);
            setError(null);
            api
              .post(`/api/v1/certificates/${cert.id}/withdraw`, { reason })
              .then(() => {
                setReason("");
                onDone();
              })
              .catch((err: unknown) =>
                setError(err instanceof ApiClientError ? err.message : "Failed to withdraw"),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Withdrawing…" : "Withdraw certificate"}
        </Button>
      </div>
    </Modal>
  );
}

function PaymentModal({
  cert,
  currency,
  onClose,
  onDone,
}: {
  cert: CertificateRow | null;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayIso());
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cert) setAmount(String(cert.netCertified));
  }, [cert]);

  const shortfall = cert ? cert.netCertified - (parseNum(amount) ?? 0) : 0;

  return (
    <Modal
      open={cert !== null}
      title={cert ? `Record payment of ${padNo("PC", cert.number)}` : ""}
      onClose={onClose}
    >
      <ErrorAlert message={error} />
      <div className="space-y-3">
        <Field label={`Amount paid (${currency})`}>
          <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Paid on">
          <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Payment reference">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      {cert && shortfall > 0.005 ? (
        <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-100">
          This is {money(shortfall, currency)} short of the certified{" "}
          {money(cert.netCertified, currency)}. The shortfall is recorded on the ledger entry.
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy || parseNum(amount) == null || !cert}
          onClick={() => {
            if (!cert) return;
            setBusy(true);
            setError(null);
            api
              .post(`/api/v1/certificates/${cert.id}/paid`, {
                amount: parseNum(amount),
                paidOn,
                reference: reference || null,
              })
              .then(() => {
                setReference("");
                onDone();
              })
              .catch((err: unknown) =>
                setError(err instanceof ApiClientError ? err.message : "Failed to record payment"),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Recording…" : "Record payment"}
        </Button>
      </div>
    </Modal>
  );
}
