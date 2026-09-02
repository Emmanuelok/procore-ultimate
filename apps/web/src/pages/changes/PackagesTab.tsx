/**
 * CHANGE ORDER PACKAGES — the execution point.
 *
 * Executing a package is the one operation in this module a correction cannot
 * undo, and it moves three ledgers inside a single transaction:
 *
 *   prime_contract   a PCCO row, appended SOV lines, and a budget change of
 *                    kind `owner_change` — revenue up
 *   commitment       a CCO row, appended SOV lines, and committed cost onto
 *                    the budget lines — cost up
 *
 * So nobody executes blind. Before the signature this screen states the
 * consequence in the plainest terms it can: the contract sum moves from X to
 * Y, the commitment from A to B, and these budget lines take the money. The
 * projection is labelled as a projection; the moment the server has executed,
 * the SERVER's figures replace it and are kept on the record.
 */
import { useMemo, useState } from "react";
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
  Textarea,
} from "../../ui";
import { Drawer, DrawerBody, DrawerFooter, Modal, toast } from "../../ui/overlays";
import { DataTable, DescriptionList, type DataColumns } from "../../ui/data";
import { IconApproval, IconChangeOrder, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  IdentityList,
  PanelSkeleton,
  Reasons,
  corTone,
  days,
  errorMessage,
  isoDate,
  isoDateTime,
  label,
  money,
  packageTone,
  pcoTone,
  refusalFrom,
  useResource,
  type ChangeChain,
  type ChangeContext,
  type ChangeLineRow,
  type CorRow,
  type ExecutionResult,
  type PackageDetail,
  type PackageRow,
  type PcoRow,
} from "./changesShared";

const PACKAGE_STATUSES = [
  "draft",
  "pending_pricing",
  "pending_in_house_review",
  "pending_owner_approval",
  "revise_and_resubmit",
  "approved",
  "executed",
  "rejected",
  "no_charge",
  "void",
] as const;

/* ------------------------------------------------------------------ */
/* The consequence, stated before the signature                        */
/* ------------------------------------------------------------------ */

interface ProjectedLeg {
  key: string;
  costCode: string | null;
  costType: string | null;
  budgetLineItemId: string | null;
  description: string;
  amount: number;
}

/**
 * What the execution will do to the budget, projected from the package's own
 * cost lines using the same weighting the server uses: revenue on the prime
 * side, cost on the commitment side, allocated pro rata to the package amount.
 *
 * This is a PROJECTION and is labelled as one. The server's own allocation is
 * authoritative and replaces this the moment the package executes.
 */
function projectLegs(
  lines: readonly ChangeLineRow[],
  target: number,
  side: "revenue" | "cost",
): { legs: ProjectedLeg[]; scale: number | null; reason: string | null } {
  const weightOf = (l: ChangeLineRow): number =>
    side === "revenue" ? l.revenueAmount + l.taxAmount : l.costAmount + l.taxAmount;
  const total = lines.reduce((sum, l) => sum + weightOf(l), 0);
  if (lines.length === 0) {
    return {
      legs: [],
      scale: null,
      reason:
        "The package's members carry no cost lines, so there is nothing to project the budget movement from.",
    };
  }
  if (Math.abs(total) < 0.005) {
    return {
      legs: [],
      scale: null,
      reason:
        "The cost lines behind this package weigh zero, so the allocation cannot be projected. The server will refuse an allocation it cannot make, rather than spreading the money evenly.",
    };
  }
  const scale = target / total;
  return {
    scale,
    reason: null,
    legs: lines.map((l) => ({
      key: l.id,
      costCode: l.costCode,
      costType: l.costType,
      budgetLineItemId: l.budgetLineItemId,
      description: l.description,
      amount: Math.round(weightOf(l) * scale * 100) / 100,
    })),
  };
}

function MovementRow({
  what,
  from,
  to,
  currency,
  note,
}: {
  what: string;
  from: number | null;
  to: number | null;
  currency: string | null;
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border px-3 py-2">
      <span className="text-meta text-content-muted">{what}</span>
      <span className="flex items-baseline gap-2 text-body tabular-nums">
        {from === null ? (
          <span className="italic text-content-subtle">not available</span>
        ) : (
          <span className="text-content-muted">{money(from, currency)}</span>
        )}
        <span aria-hidden className="text-content-subtle">
          →
        </span>
        {to === null ? (
          <span className="italic text-content-subtle">not available</span>
        ) : (
          <span className="font-semibold text-content">{money(to, currency)}</span>
        )}
      </span>
      {note ? <span className="w-full text-2xs text-content-subtle">{note}</span> : null}
    </div>
  );
}

function ExecutionConsequence({
  pkg,
  lines,
  context,
}: {
  pkg: PackageRow;
  lines: readonly ChangeLineRow[];
  context: ChangeContext;
}) {
  const isPrime = pkg.kind === "prime_contract";
  const contract = pkg.primeContractId ? context.contractById.get(pkg.primeContractId) : undefined;
  const commitment = pkg.commitmentId
    ? context.commitmentById.get(pkg.commitmentId)
    : undefined;
  const currency = isPrime ? (contract?.currency ?? null) : (commitment?.currency ?? null);

  const projection = useMemo(
    () => projectLegs(lines, pkg.amount, isPrime ? "revenue" : "cost"),
    [lines, pkg.amount, isPrime],
  );

  const currentSum = isPrime
    ? (contract?.revisedContractSum ?? null)
    : (commitment?.revisedCommitmentSum ?? null);
  const nextSum = currentSum === null ? null : Math.round((currentSum + pkg.amount) * 100) / 100;

  /** Distinct budget lines / cost codes the allocation will land on. */
  const budgetTargets = useMemo(() => {
    const buckets = new Map<string, { name: string; amount: number; hasBudgetLine: boolean }>();
    for (const leg of projection.legs) {
      const key = leg.budgetLineItemId ?? leg.costCode ?? leg.costType ?? "unattributed";
      const name =
        leg.costCode ??
        (leg.budgetLineItemId ? `budget line ${leg.budgetLineItemId}` : null) ??
        (leg.costType ? `${label(leg.costType)} (no cost code)` : "Unattributed");
      const bucket = buckets.get(key) ?? {
        name,
        amount: 0,
        hasBudgetLine: leg.budgetLineItemId !== null,
      };
      bucket.amount = Math.round((bucket.amount + leg.amount) * 100) / 100;
      bucket.hasBudgetLine = bucket.hasBudgetLine || leg.budgetLineItemId !== null;
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }, [projection.legs]);

  return (
    <div className="space-y-3">
      <Alert
        tone="warning"
        variant="subtle"
        icon={IconWarning}
        title="This is the moment the money moves, and it cannot be edited out afterwards"
      >
        Executing {pkg.reference} writes {isPrime ? "a prime contract change" : "a commitment change"},
        appends schedule-of-values lines, and moves the budget — all in one transaction. A
        correction afterwards is a new, reversing change order, not an edit.
      </Alert>

      <div className="space-y-2">
        {isPrime ? (
          <MovementRow
            what={`Prime contract sum · ${contract?.reference ?? pkg.primeContractId ?? "contract"}`}
            from={currentSum}
            to={nextSum}
            currency={currency}
            note={
              contract
                ? `Original ${money(contract.originalContractSum, currency)} · approved changes to date ${money(contract.approvedChangeSum, currency)}`
                : "The contract behind this package could not be read, so the movement cannot be projected."
            }
          />
        ) : (
          <MovementRow
            what={`Commitment sum · ${commitment?.reference ?? pkg.commitmentId ?? "commitment"}`}
            from={currentSum}
            to={nextSum}
            currency={currency}
            note={
              commitment
                ? `Original ${money(commitment.originalCommitmentSum, currency)} · approved changes to date ${money(commitment.approvedChangeSum, currency)}`
                : "The commitment behind this package could not be read, so the movement cannot be projected."
            }
          />
        )}

        <div className="rounded-md border border-border px-3 py-2">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="text-meta text-content-muted">
              Budget lines that take the money
              {isPrime ? " (approved changes column)" : " (committed cost)"}
            </span>
            <span className="text-body font-semibold tabular-nums text-content">
              {money(pkg.amount, currency)}
            </span>
          </div>
          {projection.reason ? (
            <p className="text-2xs leading-snug text-content-muted">{projection.reason}</p>
          ) : budgetTargets.length === 0 ? (
            <p className="text-2xs text-content-muted">
              No cost code or budget line is attached to these lines, so the budget effect cannot be
              projected here. The server will report what it actually moved.
            </p>
          ) : (
            <ul className="space-y-1">
              {budgetTargets.map((target) => (
                <li
                  key={target.name}
                  className="flex items-baseline justify-between gap-2 text-meta"
                >
                  <span className="flex items-center gap-1.5 text-content">
                    {target.name}
                    {!target.hasBudgetLine ? (
                      <Badge tone="warning" size="xs">
                        no budget line
                      </Badge>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-content">
                    {money(target.amount, currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="text-2xs leading-snug text-content-subtle">
        Figures above are PROJECTED from the package's own cost lines using the same weighting the
        server uses — revenue on the prime side, cost on the commitment side, allocated pro rata.
        The server's own allocation is authoritative and is recorded on the package once executed.
        {projection.scale !== null && Math.abs(projection.scale - 1) > 0.0005
          ? ` The owner granted a different figure from the ask, so every line scales by ${(projection.scale * 100).toFixed(2)}%.`
          : ""}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* What actually happened                                              */
/* ------------------------------------------------------------------ */

function ExecutedRecord({
  result,
  currency,
}: {
  result: ExecutionResult;
  currency: string | null;
}) {
  return (
    <Card>
      <CardHeader
        title="What the execution actually moved"
        subtitle="The server's own figures, from the transaction that wrote them."
        icon={IconApproval}
        tone="success"
      />
      <CardBody className="space-y-3">
        <DescriptionList
          columns={3}
          items={[
            { label: "Executed amount", value: money(result.amount, result.currency) },
            {
              label: "Prime contract change",
              value: result.primeContractChangeReference ?? "—",
            },
            {
              label: "Commitment change",
              value: result.commitmentChangeReference ?? "—",
            },
          ]}
        />

        {result.contractSums ? (
          <div className="space-y-1.5">
            <p className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Prime contract sum after execution
            </p>
            <MovementRow
              what="Contract sum"
              from={
                Math.round(
                  (result.contractSums.revisedContractSum - result.amount) * 100,
                ) / 100
              }
              to={result.contractSums.revisedContractSum}
              currency={result.currency}
              note={`Original ${money(result.contractSums.originalContractSum, result.currency)} · approved changes ${money(result.contractSums.approvedChangeSum, result.currency)} · pending ${money(result.contractSums.pendingChangeSum, result.currency)}`}
            />
          </div>
        ) : null}

        {result.commitmentSums ? (
          <div className="space-y-1.5">
            <p className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Commitment sum after execution
            </p>
            <MovementRow
              what="Commitment sum"
              from={
                Math.round(
                  (result.commitmentSums.revisedCommitmentSum - result.amount) * 100,
                ) / 100
              }
              to={result.commitmentSums.revisedCommitmentSum}
              currency={result.currency}
              note={`Original ${money(result.commitmentSums.originalCommitmentSum, result.currency)} · approved changes ${money(result.commitmentSums.approvedChangeSum, result.currency)}`}
            />
          </div>
        ) : null}

        <Divider />

        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
            Budget
          </p>
          {result.budget.applied ? (
            <p className="text-meta text-content">
              {result.budget.linesMoved} budget line(s) moved by{" "}
              <span className="tabular-nums">{money(result.budget.amount, result.currency)}</span>
              {result.budget.budgetChangeId ? (
                <span className="text-content-subtle"> · change {result.budget.budgetChangeId}</span>
              ) : null}
            </p>
          ) : (
            <Reasons
              reasons={
                result.budget.reasons.length > 0
                  ? result.budget.reasons
                  : ["The budget was not moved and the server gave no reason."]
              }
              tone="warning"
              title="The budget was not moved"
            />
          )}
          {result.budget.forecastNotes.length > 0 ? (
            <Reasons reasons={result.budget.forecastNotes} tone="info" title="Forecast notes" />
          ) : null}
        </div>

        {result.legs.length > 0 ? (
          <div>
            <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Allocation, as executed
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-meta">
                <thead>
                  <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
                    <th className="py-1.5 pr-3 text-left font-semibold">Line</th>
                    <th className="py-1.5 pr-3 text-left font-semibold">Cost code</th>
                    <th className="py-1.5 pr-3 text-left font-semibold">Cost type</th>
                    <th className="py-1.5 text-right font-semibold">Allocated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {result.legs.map((leg) => (
                    <tr key={leg.key}>
                      <td className="py-1.5 pr-3 text-content">{leg.description}</td>
                      <td className="py-1.5 pr-3 text-content-muted">{leg.costCode ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-content-muted">{label(leg.costType)}</td>
                      <td className="py-1.5 text-right tabular-nums text-content">
                        {money(leg.amount, result.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <IdentityList identities={result.identities} currency={result.currency} />
        <p className="text-2xs text-content-subtle">
          Reported in {result.currency}
          {currency && currency !== result.currency
            ? ` — note the register shows this package in ${currency}.`
            : "."}
        </p>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreatePackageModal({
  open,
  onClose,
  projectId,
  chain,
  context,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  chain: ChangeChain;
  context: ChangeContext;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<"prime_contract" | "commitment">("prime_contract");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [signedDate, setSignedDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Prime packages execute what was GRANTED; commitment packages the position. */
  const primeMembers = useMemo(
    () =>
      chain.cors.filter(
        (c) =>
          !c.changeOrderPackageId && ["approved", "partially_approved"].includes(c.status),
      ),
    [chain.cors],
  );
  const commitmentMembers = useMemo(
    () =>
      chain.pcos.filter(
        (p) => !p.changeOrderPackageId && p.commitmentId && p.status === "approved",
      ),
    [chain.pcos],
  );

  const members: Array<CorRow | PcoRow> = kind === "prime_contract" ? primeMembers : commitmentMembers;

  const total = members
    .filter((m) => memberIds.includes(m.id))
    .reduce(
      (sum, m) => sum + ("approvedAmount" in m ? m.approvedAmount : m.amount),
      0,
    );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { kind, title: title.trim(), memberIds };
      if (description.trim()) body["description"] = description.trim();
      if (signedDate) body["signedDate"] = signedDate;
      await api.post(`/api/v1/projects/${projectId}/change-order-packages`, body);
      toast.success("Change order package raised.");
      setTitle("");
      setDescription("");
      setMemberIds([]);
      onCreated();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "The package was refused"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Raise a change order package"
      description="A package is what gets signed. Prime packages execute what the owner GRANTED; commitment packages execute the position agreed with the sub."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={!title.trim() || memberIds.length === 0}
          >
            Raise package
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorAlert message={error} />
        <Field label="Side of the ledger" required>
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as "prime_contract" | "commitment");
              setMemberIds([]);
            }}
          >
            <option value="prime_contract">Prime contract (PCCO) — revenue up</option>
            <option value="commitment">Commitment (CCO) — cost up</option>
          </Select>
        </Field>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Description" optional>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label={kind === "prime_contract" ? "Approved change order requests" : "Approved PCOs"}
          hint={
            kind === "prime_contract"
              ? "Only CORs the owner has decided and that are not already inside a package."
              : "Only approved PCOs against a commitment that are not already inside a package."
          }
        >
          {members.length === 0 ? (
            <EmptyState
              size="sm"
              title="Nothing eligible"
              hint={
                kind === "prime_contract"
                  ? "A COR must be approved or partially approved before it can be executed."
                  : "A PCO must be approved and attached to a commitment before it can be executed."
              }
            />
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {members.map((member) => {
                const amount = "approvedAmount" in member ? member.approvedAmount : member.amount;
                const cur =
                  "primeContractId" in member && kind === "prime_contract"
                    ? context.contractCurrency(member.primeContractId)
                    : context.commitmentCurrency(
                        "commitmentId" in member ? member.commitmentId : null,
                      );
                return (
                  <label
                    key={member.id}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-meta hover:bg-surface-hover"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={memberIds.includes(member.id)}
                        onChange={(e) =>
                          setMemberIds((prev) =>
                            e.target.checked
                              ? [...prev, member.id]
                              : prev.filter((id) => id !== member.id),
                          )
                        }
                      />
                      <span className="font-mono text-2xs text-content-subtle">
                        {member.reference}
                      </span>
                      <span className="text-content">{member.title}</span>
                      <Badge
                        tone={
                          "approvedAmount" in member
                            ? corTone(member.status)
                            : pcoTone(member.status)
                        }
                        size="xs"
                      >
                        {label(member.status)}
                      </Badge>
                    </span>
                    <span className="tabular-nums text-content">{money(amount, cur)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Signed date" optional>
            <Input
              type="date"
              value={signedDate}
              onChange={(e) => setSignedDate(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <p className="text-meta text-content-muted">
              Package total: <span className="tabular-nums text-content">{total.toFixed(2)}</span>.
              A package totalling zero is refused — a no-charge change is recorded on the PCO.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Detail + execution                                                  */
/* ------------------------------------------------------------------ */

function PackageDrawer({
  projectId,
  packageId,
  onClose,
  onChanged,
  context,
}: {
  projectId: string;
  packageId: string;
  onClose: () => void;
  onChanged: () => void;
  context: ChangeContext;
}) {
  const detail = useResource<PackageDetail>(
    `/api/v1/projects/${projectId}/change-order-packages/${packageId}`,
  );
  const pkg = detail.data?.package ?? null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [executeOpen, setExecuteOpen] = useState(false);
  const [executeConfirm, setExecuteConfirm] = useState("");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  const currency = pkg
    ? pkg.kind === "prime_contract"
      ? context.contractCurrency(pkg.primeContractId)
      : context.commitmentCurrency(pkg.commitmentId)
    : null;

  async function act(path: string, body?: unknown, success?: string) {
    setActionError(null);
    try {
      await api.post(
        `/api/v1/projects/${projectId}/change-order-packages/${packageId}/${path}`,
        body ?? {},
      );
      toast.success(success ?? "Done.");
      detail.reload();
      onChanged();
      return true;
    } catch (err) {
      const refusal = refusalFrom(err);
      setActionError(refusal ? refusal.message : errorMessage(err, "The action was refused"));
      return false;
    }
  }

  async function execute() {
    if (!pkg) return;
    setExecuting(true);
    setActionError(null);
    try {
      const response = await api.post<{ package: PackageRow; execution: ExecutionResult }>(
        `/api/v1/projects/${projectId}/change-order-packages/${packageId}/execute`,
        { expectedAmount: pkg.amount },
      );
      setResult(response.execution);
      toast.success(
        `${response.execution.reference} executed — ${money(response.execution.amount, response.execution.currency)} moved.`,
      );
      setExecuteOpen(false);
      setExecuteConfirm("");
      detail.reload();
      onChanged();
    } catch (err) {
      const refusal = refusalFrom(err);
      setActionError(
        refusal ? refusal.message : errorMessage(err, "The execution was refused"),
      );
    } finally {
      setExecuting(false);
    }
  }

  const executed = pkg?.status === "executed";

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={pkg ? `${pkg.reference} — ${pkg.title}` : "Change order package"}
      description={
        pkg
          ? `${pkg.kind === "prime_contract" ? "Prime contract change (PCCO)" : "Commitment change (CCO)"} · ${label(pkg.status)}`
          : undefined
      }
      icon={IconChangeOrder}
      footer={
        <DrawerFooter align="between">
          <span className="text-2xs text-content-subtle">
            Execution requires admin. It is the only operation here a correction cannot undo.
          </span>
          <span className="flex flex-wrap gap-2">
            {pkg && ["draft", "revise_and_resubmit"].includes(pkg.status) ? (
              <Button size="sm" variant="secondary" onClick={() => void act("submit", {}, "Submitted.")}>
                Submit
              </Button>
            ) : null}
            {pkg && ["pending_in_house_review", "pending_owner_approval"].includes(pkg.status) ? (
              <Button size="sm" onClick={() => void act("approve", {}, "Approved for execution.")}>
                Approve
              </Button>
            ) : null}
            {pkg && ["pending_in_house_review", "pending_owner_approval", "approved"].includes(pkg.status) ? (
              <Button size="sm" variant="danger" onClick={() => setRejecting(true)}>
                Reject
              </Button>
            ) : null}
            {pkg?.status === "approved" ? (
              <Button size="sm" onClick={() => setExecuteOpen(true)}>
                Execute…
              </Button>
            ) : null}
          </span>
        </DrawerFooter>
      }
    >
      <DrawerBody>
        {detail.loading && !detail.data ? (
          <PanelSkeleton rows={6} />
        ) : detail.error ? (
          <ErrorAlert message={detail.error} />
        ) : detail.data && pkg ? (
          <div className="space-y-4">
            <ErrorAlert message={actionError} />

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={packageTone(pkg.status)}>{label(pkg.status)}</Badge>
              <Badge tone="neutral" variant="outline">
                {pkg.kind === "prime_contract" ? "PCCO" : "CCO"}
              </Badge>
              <span className="text-body font-semibold tabular-nums text-content">
                {money(pkg.amount, currency)}
              </span>
              {pkg.scheduleImpactDays > 0 ? (
                <Badge tone="neutral" variant="outline">
                  {days(pkg.scheduleImpactDays)} time
                </Badge>
              ) : null}
            </div>

            {pkg.rejectionReason ? (
              <Alert tone="danger" variant="subtle" size="sm" title="Rejected">
                {pkg.rejectionReason}
              </Alert>
            ) : null}

            {executed ? (
              <Alert tone="success" variant="subtle" size="sm" title="Executed">
                Executed {isoDateTime(pkg.executedAt)}. Prime contract change{" "}
                {pkg.primeContractChangeId ?? "—"}, commitment change{" "}
                {pkg.commitmentChangeId ?? "—"}, budget change {pkg.budgetChangeId ?? "—"}.
              </Alert>
            ) : (
              <ExecutionConsequence pkg={pkg} lines={detail.data.lines} context={context} />
            )}

            {result ? <ExecutedRecord result={result} currency={currency} /> : null}

            <Card>
              <CardHeader
                title="Reconciliation"
                subtitle="Σ member positions must equal the package amount; once executed, so must the appended SOV lines."
              />
              <CardBody>
                {detail.data.identities.length === 0 ? (
                  <p className="text-meta text-content-muted">No identities returned.</p>
                ) : (
                  <IdentityList identities={detail.data.identities} currency={currency} />
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Members"
                subtitle={
                  pkg.kind === "prime_contract"
                    ? "Change order requests. The package executes what the owner GRANTED, never what was asked."
                    : "Potential change orders. The package executes the position agreed with the subcontractor."
                }
              />
              <CardBody>
                {detail.data.members.length === 0 ? (
                  <EmptyState size="sm" title="No members on this package" />
                ) : (
                  <ul className="space-y-1">
                    {detail.data.members.map((member) => {
                      const isCor = "approvedAmount" in member;
                      const amount = isCor
                        ? (member as CorRow).approvedAmount
                        : (member as PcoRow).amount;
                      return (
                        <li
                          key={member.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-meta"
                        >
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-2xs text-content-subtle">
                              {member.reference}
                            </span>
                            <span className="text-content">{member.title}</span>
                            <Badge
                              tone={isCor ? corTone(member.status) : pcoTone(member.status)}
                              size="xs"
                            >
                              {label(member.status)}
                            </Badge>
                          </span>
                          <span className="tabular-nums text-content">
                            {money(amount, currency)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Package dates"
                subtitle="Signed and executed are different dates and both matter."
              />
              <CardBody>
                <DescriptionList
                  columns={3}
                  items={[
                    { label: "Signed", value: isoDate(pkg.signedDate) },
                    { label: "Due", value: isoDate(pkg.dueDate) },
                    { label: "Executed", value: isoDateTime(pkg.executedAt) },
                  ]}
                />
              </CardBody>
            </Card>
          </div>
        ) : null}
      </DrawerBody>

      {/* ---- reject ---- */}
      <Modal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject this package"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!rejectReason.trim()}
              onClick={async () => {
                const ok = await act(
                  "reject",
                  { rejectionReason: rejectReason.trim() },
                  "Package rejected.",
                );
                if (ok) {
                  setRejecting(false);
                  setRejectReason("");
                }
              }}
            >
              Reject package
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea
            rows={4}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </Field>
      </Modal>

      {/* ---- execute: the consequence, restated, then a typed confirmation ---- */}
      <Modal
        open={executeOpen}
        onClose={() => setExecuteOpen(false)}
        title={pkg ? `Execute ${pkg.reference}?` : "Execute package"}
        description="Read the movement below before you sign. Nothing here can be edited afterwards — a mistake is corrected by a new, reversing change order."
        size="xl"
        dismissible={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setExecuteOpen(false)} disabled={executing}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={executing}
              disabled={pkg ? executeConfirm.trim() !== pkg.reference : true}
              onClick={() => void execute()}
            >
              Execute and move the money
            </Button>
          </>
        }
      >
        {pkg && detail.data ? (
          <div className="space-y-3">
            <ErrorAlert message={actionError} />
            <ExecutionConsequence pkg={pkg} lines={detail.data.lines} context={context} />
            <Field
              label={`Type ${pkg.reference} to confirm`}
              hint="Deliberate friction. This is the only irreversible action in change management."
              required
            >
              <Input
                value={executeConfirm}
                onChange={(e) => setExecuteConfirm(e.target.value)}
                placeholder={pkg.reference}
              />
            </Field>
            <p className="text-2xs text-content-subtle">
              The request states the amount you are executing ({money(pkg.amount, currency)}). If
              the package has moved since this screen loaded, the server refuses rather than
              executing a different figure.
            </p>
          </div>
        ) : null}
      </Modal>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export default function PackagesTab({
  projectId,
  chain,
  context,
  selectedPackageId,
  onSelectPackage,
}: {
  projectId: string;
  chain: ChangeChain;
  context: ChangeContext;
  selectedPackageId: string | null;
  onSelectPackage: (id: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);

  const currencyOf = (row: PackageRow): string | null =>
    row.kind === "prime_contract"
      ? context.contractCurrency(row.primeContractId)
      : context.commitmentCurrency(row.commitmentId);

  const columns = useMemo<DataColumns<PackageRow>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        width: 110,
        sticky: "start",
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 260 },
      {
        id: "kind",
        header: "Side",
        accessor: "kind",
        type: "enum",
        width: 160,
        groupable: true,
        options: [
          { value: "prime_contract", text: "Prime contract (PCCO)", label: "Prime contract (PCCO)" },
          { value: "commitment", text: "Commitment (CCO)", label: "Commitment (CCO)" },
        ],
        cell: (ctx) =>
          ctx.row.kind === "prime_contract" ? "Prime contract — revenue" : "Commitment — cost",
      },
      {
        id: "against",
        header: "Against",
        accessor: (row: PackageRow) =>
          row.kind === "prime_contract"
            ? (context.contractById.get(row.primeContractId ?? "")?.reference ?? "")
            : (context.commitmentById.get(row.commitmentId ?? "")?.reference ?? ""),
        type: "code",
        width: 130,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 170,
        groupable: true,
        options: PACKAGE_STATUSES.map((s) => ({
          value: s,
          text: label(s),
          label: label(s),
          tone: packageTone(s),
        })),
      },
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "currency",
        width: 140,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.amount, currencyOf(ctx.row)),
      },
      {
        id: "scheduleImpactDays",
        header: "Days",
        accessor: "scheduleImpactDays",
        type: "number",
        width: 90,
      },
      {
        id: "executedAt",
        header: "Executed",
        accessor: "executedAt",
        type: "datetime",
        width: 160,
        cell: (ctx) =>
          ctx.row.executedAt ? (
            isoDateTime(ctx.row.executedAt)
          ) : (
            <span className="text-content-subtle">not executed</span>
          ),
      },
      {
        id: "artifacts",
        header: "Wrote",
        headerTooltip:
          "What the execution transaction stamped onto the package: the contract change, the commitment change and the budget change.",
        accessor: (row: PackageRow) =>
          [row.primeContractChangeId, row.commitmentChangeId, row.budgetChangeId]
            .filter(Boolean)
            .length,
        type: "custom",
        width: 200,
        cell: (ctx) =>
          ctx.row.status !== "executed" ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {ctx.row.primeContractChangeId ? (
                <Badge tone="success" size="xs">
                  PCCO
                </Badge>
              ) : null}
              {ctx.row.commitmentChangeId ? (
                <Badge tone="success" size="xs">
                  CCO
                </Badge>
              ) : null}
              {ctx.row.budgetChangeId ? (
                <Badge tone="success" size="xs">
                  budget
                </Badge>
              ) : (
                <Badge tone="warning" size="xs">
                  no budget change
                </Badge>
              )}
            </span>
          ),
      },
    ],
    [context],
  );

  const mixed = context.currencies.length > 1;

  return (
    <div className="space-y-3">
      <ErrorAlert message={chain.error} />

      <Alert
        tone="warning"
        variant="subtle"
        size="sm"
        title="Execution moves three ledgers in one transaction"
      >
        A prime package writes a PCCO, appends prime SOV lines and moves the budget's approved-change
        column. A commitment package writes a CCO, appends commitment SOV lines and moves committed
        cost. All or nothing — a change order that raised the contract sum but failed to move the
        budget would be worse than one that never executed.
      </Alert>

      <DataTable<PackageRow>
        tableId={`changes:packages:${projectId}`}
        data={chain.packages}
        columns={columns}
        getRowId={(row) => row.id}
        loading={chain.loading}
        error={chain.error}
        onRetry={chain.reload}
        height={560}
        stickyHeader
        showFooter={!mixed}
        filterRow
        savedViews
        exportFileName={`change-order-packages-${projectId}`}
        searchPlaceholder="Search packages…"
        aria-label="Change order packages"
        defaultSort={[{ id: "reference", desc: true }]}
        onRowClick={(ctx) => onSelectPackage(ctx.row.id)}
        rowTone={(row) => packageTone(row.status)}
        empty={{
          icon: IconChangeOrder,
          title: "Nothing packaged for execution",
          description:
            "Approved on the owner side but never executed down to the commitment is the gap that leaves a contractor holding the cost.",
          action: <Button onClick={() => setCreating(true)}>Raise a package</Button>,
        }}
        toolbarActions={<Button onClick={() => setCreating(true)}>Raise package</Button>}
      />

      <CreatePackageModal
        open={creating}
        onClose={() => setCreating(false)}
        projectId={projectId}
        chain={chain}
        context={context}
        onCreated={() => {
          chain.reload();
          context.reload();
        }}
      />

      {selectedPackageId ? (
        <PackageDrawer
          projectId={projectId}
          packageId={selectedPackageId}
          onClose={() => onSelectPackage(null)}
          onChanged={() => {
            chain.reload();
            context.reload();
          }}
          context={context}
        />
      ) : null}
    </div>
  );
}
