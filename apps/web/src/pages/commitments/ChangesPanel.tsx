/**
 * COMMITMENT CHANGE ORDERS — and, more usefully, what each one does to the
 * commitment sum.
 *
 * The API's rule is that a change order moves the sum EXACTLY ONCE, at
 * approval: approval writes the allocation onto the schedule of values and the
 * commitment sum follows from the schedule. Execution records the signed
 * paperwork and moves nothing. So every row here shows the arithmetic —
 * sum before, the change, sum after — for the changes that have settled, and
 * says plainly that a draft or pending change has not moved anything yet.
 *
 * Approval is deliberately hard: the author may not approve their own change
 * order, and the API refuses with a 403 naming the control. When that happens
 * the refusal is shown as the control WORKING, not as an error to route
 * around.
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
  changeArithmetic,
  isoDate,
  money,
  statusToneOf,
  titleCase,
  useAction,
  useReason,
  type Loadable,
} from "./shared";
import type { ChangeRegister, Commitment, CommitmentChange, SovLine } from "./types";

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

export default function ChangesPanel({
  commitment,
  changes,
  sovLines,
  onChanged,
}: {
  commitment: Commitment;
  changes: Loadable<ChangeRegister>;
  sovLines: SovLine[];
  onChanged: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog: reasonDialog } = useReason();
  const [composing, setComposing] = useState(false);

  const currency = changes.data?.currency ?? commitment.currency;
  const rows = changes.data?.items ?? [];
  const register = changes.data?.register ?? null;

  async function act(change: CommitmentChange, verb: string, path: string, body?: unknown) {
    const done = await run(`${verb}:${change.id}`, () =>
      api.post(`/api/v1/commitment-changes/${change.id}/${path}`, body ?? {}),
    );
    if (done !== null) {
      changes.reload();
      onChanged();
    }
  }

  const columns = useMemo<DataColumns<CommitmentChange>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        width: 150,
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
        width: 170,
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
        currency,
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        signColor: true,
        aggregate: "none",
      },
      {
        id: "movement",
        header: "Effect on the commitment sum",
        headerTooltip:
          "A change order moves the sum exactly once, at approval. Execution records the signed paperwork and moves nothing.",
        accessor: (row) => row.revisedCommitmentSum,
        type: "custom",
        width: 330,
        truncate: false,
        sortable: false,
        cell: ({ row }) => <Movement change={row} currency={currency} />,
        toCsv: ({ row }) => {
          const a = changeArithmetic(row, currency);
          return a.settled ? `${a.before} + ${a.delta} = ${a.after}` : `not yet moved (${row.status})`;
        },
      },
      {
        id: "scheduleImpactDays",
        header: "Days",
        accessor: "scheduleImpactDays",
        type: "number",
        align: "right",
        width: 84,
        aggregate: "none",
      },
      {
        id: "requestedDate",
        header: "Requested",
        accessor: "requestedDate",
        type: "date",
        width: 120,
        cell: ({ row }) => isoDate(row.requestedDate),
      },
      {
        id: "actions",
        header: "",
        width: 300,
        sortable: false,
        interactive: true,
        exportable: false,
        cell: ({ row }) => (
          <ChangeActions
            change={row}
            busy={busy}
            onSubmit={() => act(row, "submit", "submit")}
            onApprove={() => act(row, "approve", "approve")}
            onExecute={() => act(row, "execute", "execute")}
            onReject={async () => {
              const reason = await ask({
                title: `Reject ${row.reference}?`,
                description:
                  "A rejected change order stays on the register with its reason attached. The approver may be neither the author nor the submitter — the API enforces that here too.",
                label: "Why is this change order rejected?",
                confirmLabel: "Reject it",
              });
              if (!reason) return;
              await act(row, "reject", "reject", { reason });
            }}
            onVoid={async () => {
              const reason = await ask({
                title: `Void ${row.reference}?`,
                description:
                  "A voided change order stays on the register with its reason. An approved or executed one cannot be voided at all — it is reversed by a negative change order instead, so the register stays a history rather than a current opinion.",
                label: "Reason for voiding this change order",
                confirmLabel: "Void it",
                destructive: true,
              });
              if (!reason) return;
              await act(row, "void", "void", { reason });
            }}
          />
        ),
      },
    ],
    [currency, busy],
  );

  return (
    <div className="space-y-3">
      {reasonDialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />

      {register ? (
        <Card>
          <CardBody className="grid gap-3 sm:grid-cols-4">
            <Bucket
              label="Inside the sum"
              value={money(register.committed, currency)}
              hint="Approved and executed — already in the revised commitment sum."
              tone="success"
            />
            <Bucket
              label="Pending"
              value={money(register.pending, currency)}
              hint="Priced but unsigned. Exposure, deliberately outside the sum."
              tone="warning"
            />
            <Bucket
              label="Draft"
              value={money(register.draft, currency)}
              hint="Not yet submitted for review."
            />
            <Bucket
              label="Dead"
              value={money(register.dead, currency)}
              hint="Rejected, no-charge or void. Never becomes money."
            />
          </CardBody>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <p className="text-meta text-content-subtle">
          {rows.length} change order{rows.length === 1 ? "" : "s"} on {commitment.reference}
        </p>
        <Button
          size="sm"
          onClick={() => setComposing(true)}
          disabled={commitment.status === "void" || commitment.status === "terminated"}
        >
          Raise a change order
        </Button>
      </div>

      {rows.length === 0 && !changes.loading ? (
        <EmptyState
          title="No change orders on this commitment"
          hint="A change order is the only way the commitment sum moves once the commitment is approved."
        />
      ) : (
        <DataTable<CommitmentChange>
          tableId="commitment-changes"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={changes.loading}
          height={400}
          stickyHeader
          gridLines
          savedViews={false}
          exportFileName={`changes-${commitment.reference}`}
          defaultSort={[{ id: "reference", desc: true }]}
          aria-label={`Change orders on ${commitment.reference}`}
        />
      )}

      <ComposeChange
        open={composing}
        commitment={commitment}
        sovLines={sovLines}
        currency={currency}
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
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "success" | "warning";
}) {
  return (
    <div>
      <div className="text-label uppercase text-content-subtle">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
      <p className="mt-0.5 text-2xs text-content-subtle">{hint}</p>
      {tone ? (
        <Badge tone={tone} size="xs" className="mt-1">
          {tone === "success" ? "counted" : "not counted"}
        </Badge>
      ) : null}
    </div>
  );
}

/** The arithmetic a settled change order performed, spelled out. */
function Movement({ change, currency }: { change: CommitmentChange; currency: string }) {
  const a = changeArithmetic(change, currency);
  if (!a.settled) {
    return (
      <span className="text-2xs text-content-subtle">
        Has not moved the commitment sum. A change order moves it at approval, and this one is{" "}
        {titleCase(change.status).toLowerCase()}.
        {change.status !== "rejected" && change.status !== "void" ? (
          <span className="block">
            If approved it would move the sum by {money(change.amount, currency)}.
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="font-mono text-2xs tabular-nums">
      {money(a.before, currency)}
      <span className="mx-1 text-content-subtle">{a.delta >= 0 ? "+" : "−"}</span>
      {money(Math.abs(a.delta), currency)}
      <span className="mx-1 text-content-subtle">=</span>
      <span className="font-semibold">{money(a.after, currency)}</span>
      {change.status === "executed" ? (
        <span className="block font-sans text-content-subtle">
          Executed {isoDate(change.executedDate)} — the paperwork, not a second movement.
        </span>
      ) : null}
    </span>
  );
}

function ChangeActions({
  change,
  busy,
  onSubmit,
  onApprove,
  onExecute,
  onReject,
  onVoid,
}: {
  change: CommitmentChange;
  busy: string | null;
  onSubmit: () => void;
  onApprove: () => void;
  onExecute: () => void;
  onReject: () => void;
  onVoid: () => void;
}) {
  const pending =
    change.status === "pending_in_house_review" || change.status === "pending_owner_approval";
  const editable = change.status === "draft" || change.status === "revise_and_resubmit";
  const working = busy !== null && busy.endsWith(change.id);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {editable ? (
        <Button size="xs" variant="secondary" onClick={onSubmit} disabled={working}>
          Submit
        </Button>
      ) : null}
      {pending ? (
        <>
          <Button size="xs" onClick={onApprove} disabled={working}>
            Approve
          </Button>
          <Button size="xs" variant="ghost" onClick={onReject} disabled={working}>
            Reject
          </Button>
        </>
      ) : null}
      {change.status === "approved" ? (
        <Button size="xs" variant="secondary" onClick={onExecute} disabled={working}>
          Record execution
        </Button>
      ) : null}
      {change.status !== "approved" &&
      change.status !== "executed" &&
      change.status !== "void" ? (
        <Button size="xs" variant="ghost" onClick={onVoid} disabled={working}>
          Void
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Raising a change order. The allocation is the point: the API refuses to
 * approve a change order with no line allocation, because approving one could
 * not post the value to a cost code or onto the schedule of values.
 */
function ComposeChange({
  open,
  commitment,
  sovLines,
  currency,
  onClose,
  onCreated,
}: {
  open: boolean;
  commitment: Commitment;
  sovLines: SovLine[];
  currency: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState<string>("");
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
  if (lines.length === 0) problems.push("A change order needs at least one allocation line.");
  for (const l of lines) {
    if (!l.description.trim()) problems.push("Every allocation line needs a description.");
    if (l.amount.trim() === "" || !Number.isFinite(Number(l.amount))) {
      problems.push("Every allocation line needs a numeric amount.");
    }
  }

  async function submit() {
    const body = {
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(reason ? { reason } : {}),
      scheduleImpactDays: Number.isFinite(Number(days)) ? Number(days) : 0,
      lines: lines.map((l) => ({
        ...(l.sovLineId ? { sovLineId: l.sovLineId } : {}),
        description: l.description.trim(),
        amount: Number(l.amount),
      })),
    };
    const created = await run("create", () =>
      api.post(`/api/v1/commitments/${commitment.id}/changes`, body),
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
      title={`Raise a change order on ${commitment.reference}`}
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
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
            <Input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Description" optional>
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
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
                  { key: `l${prev.length}${Date.now()}`, sovLineId: "", description: "", amount: "" },
                ])
              }
            >
              Add line
            </Button>
          </div>
          <p className="mb-2 text-2xs text-content-subtle">
            Pick an existing schedule line to load the change onto it, or leave it unbound to
            append a new schedule line for genuinely new scope. The unbound choice is what keeps
            the original schedule of values readable as the original.
          </p>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={l.key} className="grid gap-2 sm:grid-cols-[1fr_2fr_140px_auto]">
                <Select
                  value={l.sovLineId}
                  onChange={(e) =>
                    setLines((prev) =>
                      prev.map((x, xi) => (xi === i ? { ...x, sovLineId: e.target.value } : x)),
                    )
                  }
                  aria-label="Schedule of values line"
                >
                  <option value="">New scope (append a line)</option>
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
                  onClick={() => setLines((prev) => prev.filter((_, xi) => xi !== i))}
                  disabled={lines.length === 1}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-2 text-meta">
            Allocated: <span className="font-mono tabular-nums">{money(allocated, currency)}</span>{" "}
            — the change order's amount is derived from this allocation, so the two cannot disagree.
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
