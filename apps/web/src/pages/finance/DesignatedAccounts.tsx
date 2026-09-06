/**
 * Designated (special) account register and reconciliation — spec Vol II
 * Domain O (#735, #745).
 *
 * The account is an advance the financier expects to see reconciled: the
 * panel therefore leads with the two balances (ledger and bank) and the
 * difference between them, not with the transaction list. A difference
 * outside tolerance is stated as unreconciled — never rounded away — and the
 * server raises a signal for it.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DESIGNATED_ACCOUNT_ENTRY_KINDS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { fmtMoney, fmtNum } from "./financeShared";

interface AccountPosition {
  balance: number;
  openingBalance: number;
  advances: number;
  replenishments: number;
  eligibleExpenditure: number;
  ineligibleExpenditure: number;
  bankCharges: number;
  interestEarned: number;
  refunds: number;
  transfersOut: number;
  entryCount: number;
  outstandingAdvance: number;
  documentedPercent: number | null;
  ceilingHeadroom: number | null;
  overCeiling: boolean;
  basis: string;
}

interface AccountRow {
  id: string;
  facilityId: string;
  name: string;
  bankName: string | null;
  accountRef: string | null;
  currency: string;
  authorisedCeiling: number;
  openingBalance: number;
  openedOn: string | null;
  status: string;
  createdAt: string;
  position?: AccountPosition;
}

interface EntryRow {
  id: string;
  entryDate: string;
  kind: string;
  amount: number;
  description: string;
  reference: string | null;
  createdAt: string;
}

interface ReconciliationRow {
  id: string;
  periodEnd: string;
  statementBalance: number;
  computedBalance: number;
  difference: number;
  outcome: string;
  explanation: string | null;
  createdAt: string;
}

interface AccountDetail extends AccountRow {
  asAt: string;
  entries: EntryRow[];
  reconciliations: ReconciliationRow[];
  position: AccountPosition;
}

/** Money out is shown negative; money in positive. The kind decides. */
const INFLOW_KINDS = new Set(["advance", "replenishment", "interest_earned"]);

export default function DesignatedAccounts({
  base,
  facilityId,
  currency,
}: {
  base: string;
  facilityId: string;
  currency: string;
}) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: AccountRow[] }>(
        `${base}/facilities/${facilityId}/designated-accounts`,
      );
      setAccounts(res.items ?? []);
    } catch (err) {
      setAccounts([]);
      setError(err instanceof ApiClientError ? err.message : "Could not load designated accounts");
    }
  }, [base, facilityId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async () => {
    if (!openId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await api.get<AccountDetail>(`${base}/designated-accounts/${openId}`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the account");
    }
  }, [base, openId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  /* ------------------------------ create account ---------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState("");
  const [cBank, setCBank] = useState("");
  const [cRef, setCRef] = useState("");
  const [cCeiling, setCCeiling] = useState("");
  const [cOpening, setCOpening] = useState("0");
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createAccount(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      await api.post(`${base}/facilities/${facilityId}/designated-accounts`, {
        name: cName.trim(),
        authorisedCeiling: Number(cCeiling),
        openingBalance: Number(cOpening) || 0,
        ...(cBank.trim() ? { bankName: cBank.trim() } : {}),
        ...(cRef.trim() ? { accountRef: cRef.trim() } : {}),
      });
      setCreateOpen(false);
      setCName("");
      setCBank("");
      setCRef("");
      setCCeiling("");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Could not create the account");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- add entry -------------------------------- */

  const [entryOpen, setEntryOpen] = useState(false);
  const [eDate, setEDate] = useState("");
  const [eKind, setEKind] = useState<string>("advance");
  const [eAmount, setEAmount] = useState("");
  const [eDescription, setEDescription] = useState("");
  const [eReference, setEReference] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);

  async function addEntry(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setEntryError(null);
    setBusy(true);
    try {
      await api.post(`${base}/designated-accounts/${detail.id}/entries`, {
        entryDate: eDate,
        kind: eKind,
        amount: Number(eAmount),
        description: eDescription.trim(),
        ...(eReference.trim() ? { reference: eReference.trim() } : {}),
      });
      setEntryOpen(false);
      setEAmount("");
      setEDescription("");
      setEReference("");
      await Promise.all([load(), loadDetail()]);
    } catch (err) {
      setEntryError(err instanceof ApiClientError ? err.message : "Could not record the entry");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------- reconcile -------------------------------- */

  const [recOpen, setRecOpen] = useState(false);
  const [rPeriodEnd, setRPeriodEnd] = useState("");
  const [rStatement, setRStatement] = useState("");
  const [rTolerance, setRTolerance] = useState("");
  const [rExplanation, setRExplanation] = useState("");
  const [rEvidence, setREvidence] = useState("");
  const [recError, setRecError] = useState<string | null>(null);

  async function reconcile(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setRecError(null);
    setBusy(true);
    try {
      const ids = rEvidence
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      await api.post(`${base}/designated-accounts/${detail.id}/reconcile`, {
        periodEnd: rPeriodEnd,
        statementBalance: Number(rStatement),
        ...(rTolerance.trim() ? { tolerance: Number(rTolerance) } : {}),
        ...(rExplanation.trim() ? { explanation: rExplanation.trim() } : {}),
        ...(ids.length ? { evidenceIds: ids } : {}),
      });
      setRecOpen(false);
      setRStatement("");
      setRExplanation("");
      setREvidence("");
      await Promise.all([load(), loadDetail()]);
    } catch (err) {
      setRecError(err instanceof ApiClientError ? err.message : "Could not record the reconciliation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5">
      <CardBody>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Designated accounts</h3>
            <p className="text-xs text-ink-400">
              The advance the financier places at the borrower&rsquo;s disposal, and the period
              reconciliation that evidences it (#735, #745).
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            Open account
          </Button>
        </div>

        <ErrorAlert message={error} />

        {accounts === null ? (
          <Spinner />
        ) : accounts.length === 0 ? (
          <p className="py-3 text-center text-xs text-ink-400">
            No designated account is held under this facility.
          </p>
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setOpenId(a.id)}
                className="w-full rounded-md px-3 py-2 text-left ring-1 ring-ink-100 transition-colors hover:bg-ink-50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink-900">{a.name}</span>
                  {a.bankName ? (
                    <span className="text-xs text-ink-500">
                      {a.bankName}
                      {a.accountRef ? ` ${a.accountRef}` : ""}
                    </span>
                  ) : null}
                  <Badge tone={a.status === "active" ? "green" : "gray"}>
                    {humanize(a.status)}
                  </Badge>
                  {a.position?.overCeiling ? <Badge tone="red">above ceiling</Badge> : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-4 text-xs tabular-nums text-ink-600">
                  <span>
                    balance{" "}
                    <strong className="text-ink-900">
                      {fmtMoney(a.position?.balance ?? null, a.currency)}
                    </strong>
                  </span>
                  <span>
                    ceiling {fmtMoney(a.authorisedCeiling, a.currency)}
                  </span>
                  <span>
                    advance outstanding{" "}
                    {fmtMoney(a.position?.outstandingAdvance ?? null, a.currency)}
                  </span>
                  <span>
                    documented{" "}
                    {a.position?.documentedPercent === null ||
                    a.position?.documentedPercent === undefined
                      ? "—"
                      : `${fmtNum(a.position.documentedPercent)}%`}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ------------------------------ create modal ------------------------------ */}
        <Modal open={createOpen} title="Open a designated account" onClose={() => setCreateOpen(false)}>
          <ErrorAlert message={createError} />
          <form onSubmit={createAccount} className="space-y-4">
            <Field label="Account name">
              <Input required value={cName} onChange={(e) => setCName(e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Bank">
                <Input value={cBank} onChange={(e) => setCBank(e.target.value)} />
              </Field>
              <Field
                label="Account reference"
                hint="Last four digits or IBAN tail only — never the full number."
              >
                <Input value={cRef} onChange={(e) => setCRef(e.target.value)} placeholder="…4417" />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={`Authorised ceiling (${currency})`}>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={cCeiling}
                  onChange={(e) => setCCeiling(e.target.value)}
                />
              </Field>
              <Field label={`Opening balance (${currency})`}>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={cOpening}
                  onChange={(e) => setCOpening(e.target.value)}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Opening…" : "Open account"}
              </Button>
            </div>
          </form>
        </Modal>

        {/* ------------------------------ detail modal ------------------------------ */}
        <Modal
          open={openId !== null}
          title={detail ? detail.name : "Designated account"}
          onClose={() => setOpenId(null)}
          wide
        >
          {detail === null ? (
            <Spinner />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <div className="text-lg font-bold tabular-nums text-ink-900">
                    {fmtMoney(detail.position.balance, detail.currency)}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">Ledger balance</div>
                </div>
                <div>
                  <div
                    className={`text-lg font-bold tabular-nums ${
                      detail.position.overCeiling ? "text-red-700" : "text-ink-900"
                    }`}
                  >
                    {fmtMoney(detail.position.ceilingHeadroom, detail.currency)}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">
                    Ceiling headroom
                  </div>
                </div>
                <div>
                  <div className="text-lg font-bold tabular-nums text-ink-900">
                    {fmtMoney(detail.position.outstandingAdvance, detail.currency)}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">
                    Advance outstanding
                  </div>
                </div>
                <div>
                  <div className="text-lg font-bold tabular-nums text-ink-900">
                    {detail.position.documentedPercent === null
                      ? "—"
                      : `${fmtNum(detail.position.documentedPercent)}%`}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">Documented</div>
                </div>
              </div>
              <p className="text-xs leading-5 text-ink-400">{detail.position.basis}</p>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setEntryError(null);
                    setEDate(detail.asAt);
                    setEntryOpen(true);
                  }}
                >
                  Record entry
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setRecError(null);
                    setRPeriodEnd(detail.asAt);
                    setRecOpen(true);
                  }}
                >
                  Reconcile to bank
                </Button>
              </div>

              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Reconciliations
                </div>
                {detail.reconciliations.length === 0 ? (
                  <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
                    This account has never been reconciled against a bank statement.
                  </p>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Period end</Th>
                        <Th className="text-right">Bank</Th>
                        <Th className="text-right">Ledger</Th>
                        <Th className="text-right">Difference</Th>
                        <Th>Outcome</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {detail.reconciliations.map((r) => (
                        <tr key={r.id}>
                          <Td className="whitespace-nowrap text-xs">{formatDate(r.periodEnd)}</Td>
                          <Td className="text-right tabular-nums">
                            {fmtMoney(r.statementBalance, detail.currency)}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {fmtMoney(r.computedBalance, detail.currency)}
                          </Td>
                          <Td
                            className={`text-right tabular-nums ${
                              r.outcome === "reconciled" ? "text-ink-600" : "font-semibold text-red-700"
                            }`}
                          >
                            {fmtMoney(r.difference, detail.currency)}
                          </Td>
                          <Td>
                            <Badge tone={r.outcome === "reconciled" ? "green" : "red"}>
                              {humanize(r.outcome)}
                            </Badge>
                            {r.explanation ? (
                              <div className="mt-0.5 max-w-xs text-[11px] leading-4 text-ink-500">
                                {r.explanation}
                              </div>
                            ) : null}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </div>

              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Account ledger
                </div>
                {detail.entries.length === 0 ? (
                  <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
                    No movements recorded.
                  </p>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Date</Th>
                        <Th>Kind</Th>
                        <Th>Description</Th>
                        <Th className="text-right">Amount</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {detail.entries.map((en) => {
                        const inflow = INFLOW_KINDS.has(en.kind);
                        return (
                          <tr key={en.id}>
                            <Td className="whitespace-nowrap text-xs">{formatDate(en.entryDate)}</Td>
                            <Td className="text-xs">{humanize(en.kind)}</Td>
                            <Td className="text-xs">
                              {en.description}
                              {en.reference ? (
                                <span className="ml-1 text-ink-400">({en.reference})</span>
                              ) : null}
                            </Td>
                            <Td
                              className={`whitespace-nowrap text-right font-medium tabular-nums ${
                                inflow ? "text-emerald-700" : "text-ink-800"
                              }`}
                            >
                              {inflow ? "+" : "−"}
                              {fmtMoney(en.amount, detail.currency)}
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                )}
              </div>
            </div>
          )}
        </Modal>

        {/* ------------------------------- entry modal ------------------------------ */}
        <Modal open={entryOpen} title="Record account entry" onClose={() => setEntryOpen(false)}>
          <ErrorAlert message={entryError} />
          <form onSubmit={addEntry} className="space-y-4">
            <p className="text-xs leading-5 text-ink-500">
              Amounts are always positive — the kind decides whether the money went in or out, so a
              mistyped sign cannot turn expenditure into a deposit.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Date">
                <Input type="date" required value={eDate} onChange={(e) => setEDate(e.target.value)} />
              </Field>
              <Field label="Kind">
                <Select value={eKind} onChange={(e) => setEKind(e.target.value)}>
                  {DESIGNATED_ACCOUNT_ENTRY_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`Amount (${detail?.currency ?? currency})`}>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={eAmount}
                  onChange={(e) => setEAmount(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Description">
              <Input
                required
                value={eDescription}
                onChange={(e) => setEDescription(e.target.value)}
              />
            </Field>
            <Field label="Reference">
              <Input value={eReference} onChange={(e) => setEReference(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEntryOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Recording…" : "Record entry"}
              </Button>
            </div>
          </form>
        </Modal>

        {/* ---------------------------- reconcile modal ----------------------------- */}
        <Modal open={recOpen} title="Reconcile to the bank statement" onClose={() => setRecOpen(false)}>
          <ErrorAlert message={recError} />
          <form onSubmit={reconcile} className="space-y-4">
            <p className="text-xs leading-5 text-ink-500">
              A reconciliation records what was checked on a date and is not rewritten afterwards.
              A difference outside tolerance is recorded as unreconciled and raises a signal.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Period end">
                <Input
                  type="date"
                  required
                  value={rPeriodEnd}
                  onChange={(e) => setRPeriodEnd(e.target.value)}
                />
              </Field>
              <Field label={`Statement balance (${detail?.currency ?? currency})`}>
                <Input
                  type="number"
                  step="0.01"
                  required
                  value={rStatement}
                  onChange={(e) => setRStatement(e.target.value)}
                />
              </Field>
              <Field label="Tolerance" hint="Blank = 0.01.">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={rTolerance}
                  onChange={(e) => setRTolerance(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Explanation" hint="Required in practice whenever the difference is not nil.">
              <Textarea
                value={rExplanation}
                onChange={(e) => setRExplanation(e.target.value)}
                className="min-h-16 text-xs"
              />
            </Field>
            <Field label="Bank statement evidence ids" hint="Space or comma separated.">
              <Input value={rEvidence} onChange={(e) => setREvidence(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRecOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Reconciling…" : "Record reconciliation"}
              </Button>
            </div>
          </form>
        </Modal>
      </CardBody>
    </Card>
  );
}
