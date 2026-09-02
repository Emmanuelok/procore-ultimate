/**
 * PAYMENT RUNS (#586–594) — the batch the bank receives.
 *
 * A run is ONE currency and three acts by (at least) two people: gather,
 * approve, issue. It adds no money semantics of its own — every member goes
 * out through exactly the same core as a single payment, so the compliance
 * gate, the retainage allocation and the invoice settlement are the same code
 * path whether a cheque is cut alone or with forty others. When one member is
 * refused the run stops there and names it, and the payments already issued
 * stay issued: the screen says so rather than implying the batch rolled back.
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
  Th,
} from "../../ui";
import { RefusalPanel, isoDate, money, titleCase, useAction } from "./shared";

interface Candidate {
  id: string;
  reference: string;
  commitmentId: string;
  vendorId: string | null;
  amount: number;
  currency: string;
  approved: boolean;
  paymentDate: string | null;
  method: string;
}

interface RunRow {
  id: string;
  reference: string;
  name: string;
  status: string;
  currency: string;
  scheduledDate: string;
  paymentIds: string[];
  paymentCount: number;
  totalAmount: number;
  approvedBy: string | null;
  issuedBy: string | null;
  issuedAt: string | null;
  cancelReason: string | null;
  detail: Record<string, unknown>;
  payments?: Array<{
    id: string;
    reference: string;
    status: string;
    amount: number;
    currency: string;
    commitmentReference: string | null;
    vendorName: string | null;
  }>;
}

interface Remittance {
  paymentId: string;
  reference: string;
  status: string;
  vendorName: string | null;
  html: string;
}

function runTone(status: string): "neutral" | "info" | "warning" | "success" | "danger" {
  switch (status) {
    case "issued":
      return "success";
    case "approved":
      return "info";
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

export default function RunsTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}/payment-runs`;
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [byCurrency, setByCurrency] = useState<
    Array<{ currency: string; count: number; amount: number; unapproved: number }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, cand] = await Promise.all([
        api.get<{ items: RunRow[] }>(`${base}?page=1&pageSize=200`),
        api.get<{
          items: Candidate[];
          byCurrency: Array<{ currency: string; count: number; amount: number; unapproved: number }>;
        }>(`${base}/candidates`),
      ]);
      setRuns(list.items);
      setCandidates(cand.items);
      setByCurrency(cand.byCurrency);
    } catch (err) {
      setRuns([]);
      setError(err instanceof Error ? err.message : "The payment runs could not be loaded.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Alert tone="info" variant="subtle" size="sm" title="One run, one currency, two pairs of hands">
        A run gathers payments that are already scheduled and approved. Approving the run approves
        any member that is not yet approved — by somebody who did not schedule it — and issuing is a
        third act by a third person.
      </Alert>

      <ErrorAlert message={error} />

      {byCurrency.length > 0 ? (
        <Card>
          <CardHeader
            title="Waiting to be paid"
            subtitle="Scheduled payments not already inside a live run, per currency."
          />
          <CardBody className="grid gap-3 sm:grid-cols-3">
            {byCurrency.map((c) => (
              <div key={c.currency}>
                <div className="text-label uppercase text-content-subtle">{c.currency}</div>
                <div className="mt-0.5 font-mono text-base font-semibold tabular-nums">
                  {money(c.amount, c.currency)}
                </div>
                <div className="text-2xs text-content-subtle">
                  {c.count} payment{c.count === 1 ? "" : "s"}
                  {c.unapproved > 0 ? ` · ${c.unapproved} not yet approved` : ""}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" disabled={candidates.length === 0} onClick={() => setCreating(true)}>
          Build a run
        </Button>
      </div>

      {runs === null ? (
        <Spinner label="Loading payment runs…" />
      ) : runs.length === 0 ? (
        <EmptyState
          title="No payment runs on this project"
          hint={
            candidates.length === 0
              ? "Nothing is scheduled for payment, so there is no batch to build."
              : "Gather the scheduled payments into a batch so they leave together with a remittance each."
          }
          action={
            candidates.length > 0 ? (
              <Button onClick={() => setCreating(true)}>Build the first run</Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Ref</Th>
              <Th>Name</Th>
              <Th>Scheduled</Th>
              <Th className="text-right">Payments</Th>
              <Th className="text-right">Total</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runs.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer hover:bg-surface-hover"
                onClick={() => setOpenId(r.id)}
              >
                <Td className="whitespace-nowrap font-mono text-xs">{r.reference}</Td>
                <Td>{r.name}</Td>
                <Td className="whitespace-nowrap text-xs">{isoDate(r.scheduledDate)}</Td>
                <Td className="text-right tabular-nums">{r.paymentCount}</Td>
                <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                  {money(r.totalAmount, r.currency)}
                </Td>
                <Td>
                  <Badge tone={runTone(r.status)} dot size="xs">
                    {titleCase(r.status)}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <BuildRun
        open={creating}
        base={base}
        candidates={candidates}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void load();
        }}
      />

      <RunDrawer
        runId={openId}
        base={base}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    </div>
  );
}

function BuildRun({
  open,
  base,
  candidates,
  onClose,
  onCreated,
}: {
  open: boolean;
  base: string;
  candidates: Candidate[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const currencies = [...new Set(candidates.map((c) => c.currency))].sort();
  const [currency, setCurrency] = useState(currencies[0] ?? "USD");
  const [name, setName] = useState("");
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().slice(0, 10));
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const inCurrency = candidates.filter((c) => c.currency === currency);
  const total = inCurrency
    .filter((c) => selected.has(c.id))
    .reduce((s, c) => s + c.amount, 0);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    const done = await run("create", () =>
      api.post(base, {
        name: name.trim(),
        scheduledDate,
        currency,
        paymentIds: [...selected].filter((id) => inCurrency.some((c) => c.id === id)),
      }),
    );
    if (done !== null) {
      setName("");
      setSelected(new Set());
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Build a payment run"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || selected.size === 0 || busy !== null}
            onClick={() => void submit()}
          >
            Create the run ({money(total, currency)})
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} title="The run was refused" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Week 12 ACH run"
            />
          </Field>
          <Field label="Scheduled date" required>
            <Input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
            />
          </Field>
          <Field label="Currency" hint="A run is one currency; the others stay out of it.">
            <Select
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setSelected(new Set());
              }}
            >
              {(currencies.length > 0 ? currencies : ["USD"]).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {inCurrency.length === 0 ? (
          <EmptyState
            title={`Nothing scheduled in ${currency}`}
            hint="Only scheduled payments not already inside a live run can join a batch."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th> </Th>
                <Th>Payment</Th>
                <Th>Date</Th>
                <Th>Method</Th>
                <Th className="text-right">Amount</Th>
                <Th>Approved</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {inCurrency.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Include ${c.reference}`}
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                    />
                  </Td>
                  <Td className="font-mono text-xs">{c.reference}</Td>
                  <Td className="whitespace-nowrap text-xs">{isoDate(c.paymentDate)}</Td>
                  <Td className="text-xs">{titleCase(c.method)}</Td>
                  <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                    {money(c.amount, c.currency)}
                  </Td>
                  <Td>
                    <Badge size="xs" tone={c.approved ? "success" : "warning"}>
                      {c.approved ? "Approved" : "Not yet"}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Modal>
  );
}

function RunDrawer({
  runId,
  base,
  onClose,
  onChanged,
}: {
  runId: string | null;
  base: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [data, setData] = useState<RunRow | null>(null);
  const [remittances, setRemittances] = useState<Remittance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    setError(null);
    try {
      setData(await api.get<RunRow>(`${base}/${runId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The run could not be loaded.");
    }
  }, [base, runId]);

  useEffect(() => {
    if (!runId) {
      setData(null);
      setRemittances(null);
      return;
    }
    void load();
  }, [runId, load]);

  async function act(action: string, body?: unknown) {
    if (!runId) return;
    const done = await run(action, () => api.post(`${base}/${runId}/${action}`, body ?? {}));
    if (done !== null) {
      await load();
      onChanged();
    }
  }

  async function loadRemittances() {
    if (!runId) return;
    try {
      const res = await api.get<{ items: Remittance[] }>(`${base}/${runId}/remittances`);
      setRemittances(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The remittances could not be loaded.");
    }
  }

  const failure = data?.detail?.["failure"] as
    | { reference: string; message: string }
    | undefined;
  const issuedIds = (data?.detail?.["issuedPaymentIds"] as string[] | undefined) ?? [];

  return (
    <Modal
      open={runId !== null}
      onClose={onClose}
      title={data ? `${data.reference} — ${data.name}` : "Payment run"}
      size="xl"
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <RefusalPanel refusal={refusal} onDismiss={clear} title="The run was refused" />
        {!data ? (
          <Spinner label="Loading…" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={runTone(data.status)} dot>
                {titleCase(data.status)}
              </Badge>
              <span className="font-mono text-meta tabular-nums">
                {money(data.totalAmount, data.currency)}
              </span>
              <span className="text-meta text-content-muted">
                {data.paymentCount} payment{data.paymentCount === 1 ? "" : "s"} · scheduled{" "}
                {isoDate(data.scheduledDate)}
              </span>
            </div>

            {failure ? (
              <Alert tone="danger" title={`The run stopped at ${failure.reference}`}>
                <p>{failure.message}</p>
                <p className="mt-1">
                  {issuedIds.length} payment(s) went out before it and stay issued — a payment run
                  is not a transaction across the bank.
                </p>
              </Alert>
            ) : null}

            <Table>
              <thead>
                <tr>
                  <Th>Payment</Th>
                  <Th>Commitment</Th>
                  <Th>Vendor</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(data.payments ?? []).map((p) => (
                  <tr key={p.id}>
                    <Td className="font-mono text-xs">{p.reference}</Td>
                    <Td className="text-xs">{p.commitmentReference ?? "—"}</Td>
                    <Td className="text-xs">{p.vendorName ?? "—"}</Td>
                    <Td className="whitespace-nowrap text-right font-mono tabular-nums">
                      {money(p.amount, p.currency)}
                    </Td>
                    <Td>
                      <Badge size="xs" tone={p.status === "issued" ? "success" : "neutral"}>
                        {titleCase(p.status)}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <div className="flex flex-wrap gap-2">
              {data.status === "draft" ? (
                <Button size="sm" disabled={busy !== null} onClick={() => void act("approve")}>
                  Approve the run
                </Button>
              ) : null}
              {data.status === "approved" ? (
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Issue ${data.paymentCount} payment(s) totalling ${money(data.totalAmount, data.currency)}? Each is re-checked against the vendor's cover as it goes out.`,
                      )
                    ) {
                      void act("issue", { acknowledgeWarnings: true });
                    }
                  }}
                >
                  Issue the run
                </Button>
              ) : null}
              {data.status !== "issued" && data.status !== "cancelled" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    const reason = window.prompt(`Why is ${data.reference} cancelled?`);
                    if (reason?.trim()) void act("cancel", { reason: reason.trim() });
                  }}
                >
                  Cancel the run
                </Button>
              ) : null}
              {data.status === "issued" ? (
                <Button size="sm" variant="secondary" onClick={() => void loadRemittances()}>
                  Remittance advices
                </Button>
              ) : null}
            </div>

            {remittances ? (
              <div className="space-y-2">
                {remittances.map((r) => (
                  <details key={r.paymentId} className="rounded-md border border-border p-2">
                    <summary className="cursor-pointer text-meta">
                      {r.vendorName ?? "Vendor"} — {r.reference}
                    </summary>
                    <div
                      className="mt-2 overflow-x-auto text-2xs"
                      // eslint-disable-next-line react/no-danger
                      dangerouslySetInnerHTML={{ __html: r.html }}
                    />
                  </details>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
