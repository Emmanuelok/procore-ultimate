/**
 * CONTRACT CHANGES — and what executing one does to the sum and the schedule.
 *
 * Execution is the moment a change order becomes money, and it does two things
 * in one transaction: it raises the contract sum by exactly its amount, and it
 * APPENDS schedule-of-values lines worth exactly that amount. That is why the
 * continuation sheet keeps reconciling back to the contract both parties
 * signed — the originals are never edited.
 *
 * So the table shows, per change order, the sum before, the change, the sum
 * after, and after execution the lines it actually appended.
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
  RefusalPanel,
  isoDate,
  money,
  pct,
  statusToneOf,
  titleCase,
  useAction,
  useChangeAnalytics,
  useReason,
  type Loadable,
} from "./shared";
import type {
  ChangeExecution,
  ContractView,
  Paginated,
  PrimeChange,
  SovViewLine,
} from "./types";

const REASONS = [
  "client_request",
  "design_development",
  "design_error",
  "design_omission",
  "unforeseen_condition",
  "existing_condition",
  "code_compliance",
  "coordination_conflict",
  "allowance_reconciliation",
  "value_engineering",
  "weather",
  "owner_directed_acceleration",
  "other",
] as const;

interface DraftLine {
  key: string;
  sovLineId: string;
  description: string;
  amount: string;
}

export default function ChangesTab({
  contract,
  changes,
  sovLines,
  onChanged,
}: {
  contract: ContractView;
  changes: Loadable<Paginated<PrimeChange>>;
  sovLines: readonly SovViewLine[];
  onChanged: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog: reasonDialog } = useReason();
  const [composing, setComposing] = useState(false);
  const [lastExecution, setLastExecution] = useState<ChangeExecution | null>(null);

  const cur = contract.currency;
  const rows = changes.data?.items ?? [];
  const analytics = useChangeAnalytics(contract.id);

  async function act(change: PrimeChange, verb: string, path: string, body?: unknown) {
    const result = await run(`${verb}:${change.id}`, () =>
      api.post<ChangeExecution | PrimeChange>(
        `/api/v1/prime-contracts/${contract.id}/changes/${change.id}/${path}`,
        body ?? {},
      ),
    );
    if (result !== null) {
      if (verb === "execute" && result && "appendedLines" in result) {
        setLastExecution(result as ChangeExecution);
      }
      analytics.reload();
      changes.reload();
      onChanged();
    }
  }

  const columns = useMemo<DataColumns<PrimeChange>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        width: 130,
        sticky: "start",
        mono: true,
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 240 },
      {
        id: "reason",
        header: "Reason",
        accessor: (row) => titleCase(row.reason),
        type: "text",
        width: 170,
        defaultHidden: true,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 180,
        cell: ({ row }) => (
          <Badge tone={statusToneOf(row.status)} dot size="xs">
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 150,
        mono: true,
        signColor: true,
        aggregate: "none",
      },
      {
        id: "effect",
        header: "Effect on the contract sum",
        headerTooltip:
          "Only execution moves the sum, and it moves it by appending schedule-of-values lines worth exactly the change.",
        accessor: (row) => row.revisedContractSum,
        type: "custom",
        width: 320,
        truncate: false,
        sortable: false,
        cell: ({ row }) => <Effect change={row} currency={cur} />,
        toCsv: ({ row }) =>
          row.status === "executed"
            ? `${row.revisedContractSum - row.amount} + ${row.amount} = ${row.revisedContractSum}`
            : `not executed (${row.status})`,
      },
      {
        id: "scheduleImpactDays",
        header: "Days",
        accessor: "scheduleImpactDays",
        type: "number",
        align: "right",
        width: 80,
        aggregate: "none",
      },
      {
        id: "executedDate",
        header: "Executed",
        accessor: "executedDate",
        type: "date",
        width: 120,
        cell: ({ row }) => isoDate(row.executedDate),
      },
      {
        id: "actions",
        header: "",
        width: 280,
        sortable: false,
        interactive: true,
        exportable: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.status === "draft" || row.status === "revise_and_resubmit" ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => act(row, "submit", "submit")}
              >
                Submit
              </Button>
            ) : null}
            {row.status === "pending_owner_approval" ||
            row.status === "pending_in_house_review" ? (
              <>
                <Button
                  size="xs"
                  disabled={busy !== null}
                  onClick={() => act(row, "approve", "approve")}
                >
                  Approve
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={async () => {
                    const reason = await ask({
                      title: `Reject ${row.reference}?`,
                      description:
                        "A rejected change order stays on the log with its reason. The approver may be neither the author nor the submitter — the API enforces that separately.",
                      label: "Why is this change order rejected?",
                      confirmLabel: "Reject it",
                    });
                    if (!reason) return;
                    await act(row, "reject", "reject", { reason });
                  }}
                >
                  Reject
                </Button>
              </>
            ) : null}
            {row.status === "approved" ? (
              <Button
                size="xs"
                disabled={busy !== null || contract.executed !== 1}
                onClick={() => act(row, "execute", "execute")}
              >
                Execute
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [cur, busy, contract.executed],
  );

  return (
    <div className="space-y-3">
      {reasonDialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />

      {analytics.data ? (
        <Card>
          <CardBody>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Change order register</h3>
              <span className="text-2xs text-content-subtle">as at {analytics.data.asOf}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6 text-meta">
              <Bucket label="Executed" value={money(analytics.data.executed.amount, cur)} hint={`${analytics.data.executed.count} change order${analytics.data.executed.count === 1 ? "" : "s"}${analytics.data.executed.shareOfOriginal === null ? "" : ` · ${pct(analytics.data.executed.shareOfOriginal * 100, 1)} of the original sum`}`} />
              <Bucket label="Pending" value={money(analytics.data.pending.amount, cur)} hint={analytics.data.pending.oldestDays === null ? `${analytics.data.pending.count} pending` : `${analytics.data.pending.count} pending · oldest ${analytics.data.pending.oldestDays} days`} />
              <Bucket label="Schedule impact" value={`${analytics.data.executed.scheduleImpactDays} days`} hint="Σ executed schedule impact" />
              <Bucket label="Raise → submit" value={analytics.data.cycleTimeDays.createdToSubmitted === null ? "—" : `${analytics.data.cycleTimeDays.createdToSubmitted} days`} hint="mean cycle time" />
              <Bucket label="Submit → approve" value={analytics.data.cycleTimeDays.submittedToApproved === null ? "—" : `${analytics.data.cycleTimeDays.submittedToApproved} days`} hint="mean cycle time" />
              <Bucket label="Approve → execute" value={analytics.data.cycleTimeDays.approvedToExecuted === null ? "—" : `${analytics.data.cycleTimeDays.approvedToExecuted} days`} hint="mean cycle time" />
            </div>
            {analytics.data.byReason.length > 0 ? (
              <p className="mt-2 text-2xs text-content-subtle">
                By reason: {analytics.data.byReason.map((r) => `${titleCase(r.reason)} ${money(r.amount, cur)} (${r.count})`).join(" · ")}
              </p>
            ) : null}
            {analytics.data.reasons.length > 0 ? <p className="mt-1 text-2xs text-content-subtle">{analytics.data.reasons.join(" ")}</p> : null}
          </CardBody>
        </Card>
      ) : null}

      {lastExecution ? (
        <Alert
          tone="success"
          title={`${lastExecution.change.reference} executed`}
          onDismiss={() => setLastExecution(null)}
        >
          <p>
            The contract sum moved to{" "}
            <strong>{money(lastExecution.contract.revisedContractSum, cur)}</strong>, and{" "}
            {lastExecution.appendedLines.length} schedule-of-values line
            {lastExecution.appendedLines.length === 1 ? " was" : "s were"} appended worth exactly
            the change:
          </p>
          <ul className="mt-1 list-disc pl-4 text-meta">
            {lastExecution.appendedLines.map((l) => (
              <li key={l.id}>
                <span className="font-mono">{l.lineNumber}</span> ·{" "}
                {money(l.scheduledValue, cur)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-2xs">
            {lastExecution.budget.applied ? (
              <span className="block">
                The budget rose with it: {money(lastExecution.budget.amount, cur)} of owner-funded increase landed on {lastExecution.budget.linesMoved} budget line{lastExecution.budget.linesMoved === 1 ? "" : "s"} as an approved owner change ({lastExecution.budget.budgetChangeId}).
              </span>
            ) : (
              <span className="block">The budget was NOT funded: {lastExecution.budget.reasons.join(" ")}</span>
            )}{" "}
            Σ SOV is now {money(lastExecution.contract.sov.identity.sovTotal, cur)} against a
            contract sum of {money(lastExecution.contract.sov.identity.contractSum, cur)} —{" "}
            {lastExecution.contract.sov.identity.ok ? "balanced" : "NOT balanced"}.
          </p>
        </Alert>
      ) : null}

      <Card>
        <CardBody className="grid gap-3 sm:grid-cols-4">
          <Bucket
            label="Executed"
            value={money(contract.approvedChangeSum, cur)}
            hint="Inside the revised contract sum, with schedule lines to match."
          />
          <Bucket
            label="Pending"
            value={money(contract.pendingChangeSum, cur)}
            hint="Priced and unsigned — deliberately outside the sum."
          />
          <Bucket
            label="Draft"
            value={money(contract.draftChangeSum, cur)}
            hint="Not yet submitted."
          />
          <Bucket
            label="Revised contract sum"
            value={money(contract.revisedContractSum, cur)}
            hint="Original plus executed changes only."
            strong
          />
        </CardBody>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-meta text-content-subtle">
          {rows.length} change order{rows.length === 1 ? "" : "s"} on {contract.reference}
        </p>
        <Button
          size="sm"
          onClick={() => setComposing(true)}
          disabled={contract.status === "void" || contract.status === "terminated"}
        >
          Raise a change order
        </Button>
      </div>

      {rows.length === 0 && !changes.loading ? (
        <EmptyState
          title="No change orders on this contract"
          hint="An executed change order is the only thing that moves the contract sum after execution."
        />
      ) : (
        <DataTable<PrimeChange>
          tableId="prime-changes"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={changes.loading}
          height={420}
          stickyHeader
          gridLines
          savedViews={false}
          exportFileName={`changes-${contract.reference}`}
          defaultSort={[{ id: "reference", desc: true }]}
          aria-label={`Change orders on ${contract.reference}`}
        />
      )}

      <Compose
        open={composing}
        contract={contract}
        sovLines={sovLines}
        onClose={() => setComposing(false)}
        onCreated={() => {
          setComposing(false);
          changes.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function Bucket({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint: string;
  strong?: boolean;
}) {
  return (
    <div>
      <div className="text-label uppercase text-content-subtle">{label}</div>
      <div className={"mt-0.5 tabular-nums " + (strong ? "text-lg font-semibold" : "text-base font-semibold")}>
        {value}
      </div>
      <p className="mt-0.5 text-2xs text-content-subtle">{hint}</p>
    </div>
  );
}

function Effect({ change, currency }: { change: PrimeChange; currency: string }) {
  if (change.status !== "executed") {
    return (
      <span className="text-2xs text-content-subtle">
        Has not moved the contract sum. Only execution moves it, and this one is{" "}
        {titleCase(change.status).toLowerCase()}.
        {change.status !== "rejected" && change.status !== "void" ? (
          <span className="block">
            On execution it would raise the sum by {money(change.amount, currency)} and append
            schedule lines worth exactly that.
          </span>
        ) : null}
      </span>
    );
  }
  const before = Number((change.revisedContractSum - change.amount).toFixed(2));
  return (
    <span className="font-mono text-2xs tabular-nums">
      {money(before, currency)}
      <span className="mx-1 text-content-subtle">{change.amount >= 0 ? "+" : "−"}</span>
      {money(Math.abs(change.amount), currency)}
      <span className="mx-1 text-content-subtle">=</span>
      <span className="font-semibold">{money(change.revisedContractSum, currency)}</span>
      <span className="block font-sans text-content-subtle">
        {change.lines.length} allocation line{change.lines.length === 1 ? "" : "s"} appended to the
        schedule of values.
      </span>
    </span>
  );
}

function Compose({
  open,
  contract,
  sovLines,
  onClose,
  onCreated,
}: {
  open: boolean;
  contract: ContractView;
  sovLines: readonly SovViewLine[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const [days, setDays] = useState("0");
  const [lines, setLines] = useState<DraftLine[]>([
    { key: "l0", sovLineId: "", description: "", amount: "" },
  ]);

  const allocated = lines.reduce((sum, l) => {
    const n = Number(l.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  const problems: string[] = [];
  if (!title.trim()) problems.push("A change order needs a title.");
  for (const l of lines) {
    if (!l.description.trim()) problems.push("Every allocation line needs a description.");
    if (l.amount.trim() === "" || !Number.isFinite(Number(l.amount))) {
      problems.push("Every allocation line needs a numeric amount.");
    }
  }

  async function submit() {
    const created = await run("create", () =>
      api.post(`/api/v1/prime-contracts/${contract.id}/changes`, {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(reason ? { reason } : {}),
        scheduleImpactDays: Number.isFinite(Number(days)) ? Number(days) : 0,
        lines: lines.map((l) => ({
          ...(l.sovLineId ? { sovLineId: l.sovLineId } : {}),
          description: l.description.trim(),
          amount: Number(l.amount),
        })),
      }),
    );
    if (created !== null) {
      setTitle("");
      setDescription("");
      setReason("");
      setDays("0");
      setLines([{ key: "l0", sovLineId: "", description: "", amount: "" }]);
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Raise a change order on ${contract.reference}`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={problems.length > 0 || busy !== null}>
            Create as draft
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reason" optional>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Not stated</option>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Schedule impact (days)">
            <Input value={days} inputMode="numeric" onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        <Field label="Description" optional>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-label uppercase text-content-subtle">Allocation</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                setLines((prev) => [
                  ...prev,
                  {
                    key: `l${prev.length}${Date.now()}`,
                    sovLineId: "",
                    description: "",
                    amount: "",
                  },
                ])
              }
            >
              Add line
            </Button>
          </div>
          <p className="mb-2 text-2xs text-content-subtle">
            The allocation must account for the whole amount — the API refuses a change order whose
            lines do not total it. On execution each line becomes an appended schedule-of-values
            line, which is what keeps the continuation sheet balanced.
          </p>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={l.key} className="grid gap-2 sm:grid-cols-[1fr_2fr_140px_auto]">
                <Select
                  value={l.sovLineId}
                  aria-label="Related schedule line"
                  onChange={(e) =>
                    setLines((prev) =>
                      prev.map((x, xi) => (xi === i ? { ...x, sovLineId: e.target.value } : x)),
                    )
                  }
                >
                  <option value="">New scope</option>
                  {sovLines.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.lineNumber} — {s.description}
                    </option>
                  ))}
                </Select>
                <Input
                  value={l.description}
                  placeholder="What this line covers"
                  onChange={(e) =>
                    setLines((prev) =>
                      prev.map((x, xi) => (xi === i ? { ...x, description: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  value={l.amount}
                  placeholder="0.00"
                  inputMode="decimal"
                  onChange={(e) =>
                    setLines((prev) =>
                      prev.map((x, xi) => (xi === i ? { ...x, amount: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={lines.length === 1}
                  onClick={() => setLines((prev) => prev.filter((_, xi) => xi !== i))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-2 text-meta">
            Allocated:{" "}
            <span className="font-mono tabular-nums">{money(allocated, contract.currency)}</span>
          </p>
        </div>

        {problems.length > 0 ? (
          <Alert tone="warning" size="sm" title="Not ready to send">
            <ul className="list-disc pl-4">
              {[...new Set(problems)].map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
