/**
 * RETENTION TRUSTS, PROJECT BANK ACCOUNTS AND ESCROW (spec Vol II F #381–385).
 *
 * The whole point of a retention trust is that the money is actually THERE.
 * So this screen leads with one question — is the account funded to what the
 * commitments say is being held? — and answers it with the arithmetic beside
 * it: balance (Σ signed movements) against retainage held (Σ commitments in
 * the SAME currency), with any commitment in another currency listed as
 * skipped rather than quietly converted.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
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
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { fmtMoney } from "./paymentsShared";

const ACCOUNT_KINDS = ["project_bank_account", "retention_trust", "escrow"] as const;
const MOVEMENT_KINDS = ["deposit", "release", "withdrawal", "interest", "adjustment"] as const;

interface Reconciliation {
  accountId: string;
  currency: string;
  balance: number;
  retainageHeld: number;
  skippedForCurrency: Array<{
    commitmentId: string;
    reference: string;
    currency: string;
  }>;
  shortfall: number;
  funded: boolean;
  basis: string;
}

interface Movement {
  id: string;
  kind: string;
  amount: number;
  reference: string | null;
  occurredAt: string;
  notes: string | null;
}

interface AccountRow {
  id: string;
  kind: string;
  name: string;
  bankReference: string | null;
  trustee: string | null;
  currency: string;
  status: string;
  openedAt: string | null;
  closedAt: string | null;
  notes: string | null;
  reconciliation: Reconciliation;
  movements?: Movement[];
}

export default function SecurityTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}/payment-security-accounts`;
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [underfunded, setUnderfunded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: AccountRow[]; underfunded: number }>(base);
      setRows(res.items);
      setUnderfunded(res.underfunded);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "The accounts could not be loaded.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Alert
        tone={underfunded > 0 ? "danger" : "info"}
        variant="subtle"
        title={
          underfunded > 0
            ? `${underfunded} account${underfunded === 1 ? " is" : "s are"} holding less than the retainage they secure`
            : "Every active account covers the retainage it secures"
        }
      >
        A trust that does not hold the money is not a trust. The balance is derived from its
        movements and compared with the retainage the commitments say is held — in the
        account&rsquo;s own currency only.
      </Alert>

      <ErrorAlert message={error} />

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          Open an account
        </Button>
      </div>

      {rows === null ? (
        <Spinner label="Loading the accounts…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No retention trust or project bank account on this project"
          hint="Where a regime requires retention to be held in trust, or the client pays through a project bank account, record it here so the funding can be proved."
          action={<Button onClick={() => setCreating(true)}>Open the first account</Button>}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((a) => (
            <Card key={a.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <span>{a.name}</span>
                    <Badge size="xs" tone={a.status === "active" ? "neutral" : "success"}>
                      {humanize(a.status)}
                    </Badge>
                  </span>
                }
                subtitle={`${humanize(a.kind)} · ${a.currency}${a.trustee ? ` · trustee ${a.trustee}` : ""}`}
                actions={
                  <Button size="xs" variant="secondary" onClick={() => setOpenId(a.id)}>
                    Movements
                  </Button>
                }
              />
              <CardBody className="space-y-2">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Figure label="Balance" value={fmtMoney(a.reconciliation.balance, a.currency)} />
                  <Figure
                    label="Retainage held"
                    value={fmtMoney(a.reconciliation.retainageHeld, a.currency)}
                  />
                  <Figure
                    label="Shortfall"
                    value={fmtMoney(a.reconciliation.shortfall, a.currency)}
                    tone={a.reconciliation.funded ? undefined : "danger"}
                  />
                </div>
                <Badge tone={a.reconciliation.funded ? "success" : "danger"} dot size="xs">
                  {a.reconciliation.funded ? "Funded" : "Under-funded"}
                </Badge>
                <p className="text-2xs text-content-subtle">{a.reconciliation.basis}</p>
                {a.reconciliation.skippedForCurrency.length > 0 ? (
                  <Alert
                    tone="warning"
                    size="sm"
                    variant="subtle"
                    title="Not counted — other currency"
                  >
                    {a.reconciliation.skippedForCurrency
                      .map((s) => `${s.reference} (${s.currency})`)
                      .join(", ")}{" "}
                    hold retainage in another currency and are deliberately not added to this
                    account&rsquo;s position.
                  </Alert>
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <CreateAccount
        open={creating}
        base={base}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void load();
        }}
      />

      <AccountDrawer
        accountId={openId}
        base={base}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div>
      <div className="text-label uppercase text-content-subtle">{label}</div>
      <div
        className={
          "mt-0.5 font-mono text-base font-semibold tabular-nums " +
          (tone === "danger" ? "text-danger-fg" : "text-content")
        }
      >
        {value}
      </div>
    </div>
  );
}

function CreateAccount({
  open,
  base,
  onClose,
  onCreated,
}: {
  open: boolean;
  base: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<string>("retention_trust");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [trustee, setTrustee] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(base, {
        kind,
        name: name.trim(),
        currency: currency.trim().toUpperCase() || "USD",
        ...(trustee.trim() ? { trustee: trustee.trim() } : {}),
        ...(bankReference.trim() ? { bankReference: bankReference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setName("");
      setTrustee("");
      setBankReference("");
      setNotes("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The account could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open a retention trust, project bank account or escrow"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? "Opening…" : "Open the account"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <Field label="Kind" required>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Retention trust — Barclays 1234"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Currency"
            hint="One currency per account; the reconciliation never converts."
          >
            <Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
          </Field>
          <Field label="Trustee">
            <Input value={trustee} onChange={(e) => setTrustee(e.target.value)} />
          </Field>
        </div>
        <Field label="Bank reference">
          <Input value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
        </Field>
        <Field label="Notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function AccountDrawer({
  accountId,
  base,
  onClose,
  onChanged,
}: {
  accountId: string | null;
  base: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<AccountRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("deposit");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setError(null);
    try {
      setData(await api.get<AccountRow>(`${base}/${accountId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The account could not be loaded.");
    }
  }, [accountId, base]);

  useEffect(() => {
    if (!accountId) {
      setData(null);
      return;
    }
    void load();
  }, [accountId, load]);

  async function record() {
    if (!accountId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/${accountId}/movements`, {
        kind,
        amount: Number(amount) || 0,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      setAmount("");
      setReference("");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The movement was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={accountId !== null}
      onClose={onClose}
      title={data ? `${data.name} — movements` : "Account movements"}
      size="lg"
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        {data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure
                label="Balance"
                value={fmtMoney(data.reconciliation.balance, data.currency)}
              />
              <Figure
                label="Retainage held"
                value={fmtMoney(data.reconciliation.retainageHeld, data.currency)}
              />
              <Figure
                label="Shortfall"
                value={fmtMoney(data.reconciliation.shortfall, data.currency)}
                tone={data.reconciliation.funded ? undefined : "danger"}
              />
            </div>

            {data.status === "active" ? (
              <Card>
                <CardBody className="grid items-end gap-3 sm:grid-cols-4">
                  <Field label="Movement">
                    <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                      {MOVEMENT_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {humanize(k)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={`Amount (${data.currency})`}>
                    <Input
                      value={amount}
                      inputMode="decimal"
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </Field>
                  <Field label="Reference">
                    <Input value={reference} onChange={(e) => setReference(e.target.value)} />
                  </Field>
                  <Button
                    disabled={busy || !Number.isFinite(Number(amount))}
                    onClick={() => void record()}
                  >
                    Record
                  </Button>
                </CardBody>
              </Card>
            ) : (
              <Alert tone="info" size="sm" title="This account is closed">
                Closed on {formatDate(data.closedAt)}. Its movements stay on the record.
              </Alert>
            )}

            {(data.movements ?? []).length === 0 ? (
              <EmptyState
                title="No movements yet"
                hint="The balance is zero until money arrives."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Kind</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Reference</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(data.movements ?? []).map((m) => (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap text-xs">{formatDate(m.occurredAt)}</Td>
                      <Td>{humanize(m.kind)}</Td>
                      <Td
                        className={
                          "whitespace-nowrap text-right font-mono tabular-nums " +
                          (m.amount < 0 ? "text-danger-fg" : "")
                        }
                      >
                        {fmtMoney(m.amount, data.currency)}
                      </Td>
                      <Td className="text-xs text-content-muted">{m.reference ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : (
          <Spinner label="Loading…" />
        )}
      </div>
    </Modal>
  );
}
