/**
 * ONE COMMITMENT, in a drawer over the register.
 *
 * Everything the buy side needs to answer "where are we with this sub":
 * the scope and what it excludes, the dates, the retainage terms, the vendor,
 * the budget lines this commitment consumes — and the four panels that carry
 * the money: schedule of values, change orders, payments, compliance.
 *
 * The header carries the compliance state because that is the fact most likely
 * to stop somebody's day, and it carries it with the finding's own words.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  Field,
  Input,
  Modal,
  Spinner,
  Tabs,
  Textarea,
  useConfirm,
} from "../../ui";
import { DescriptionList, type DescriptionItem } from "../../ui/data";
import BackchargesPanel from "./BackchargesPanel";
import ChangesPanel from "./ChangesPanel";
import CloseoutPanel from "./CloseoutPanel";
import DocumentsPanel from "./DocumentsPanel";
import PaymentsPanel from "./PaymentsPanel";
import SovPanel from "./SovPanel";
import {
  COMPLIANCE_LABEL,
  CompliancePosition,
  Figure,
  KIND_LABEL,
  MoneyStat,
  RefusalPanel,
  complianceTone,
  isoDate,
  money,
  pct,
  statusToneOf,
  titleCase,
  useAction,
  useChanges,
  useCommitmentDetail,
  usePayments,
  useReason,
  useSov,
} from "./shared";
import type { BuyoutRow } from "./types";

type Panel =
  | "overview"
  | "sov"
  | "changes"
  | "payments"
  | "compliance"
  | "backcharges"
  | "closeout"
  | "documents";

export default function CommitmentDrawer({
  commitmentId,
  buyoutRows,
  onClose,
  onMutated,
}: {
  commitmentId: string | null;
  buyoutRows: BuyoutRow[];
  onClose: () => void;
  onMutated: () => void;
}) {
  const [panel, setPanel] = useState<Panel>("overview");
  const [editingHeader, setEditingHeader] = useState(false);
  const detail = useCommitmentDetail(commitmentId);
  const sov = useSov(commitmentId);
  const changes = useChanges(commitmentId);
  const payments = usePayments(commitmentId);
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const { ask, dialog: reasonDialog } = useReason();

  const data = detail.data;
  const commitment = data?.commitment ?? null;

  function reloadAll() {
    detail.reload();
    sov.reload();
    changes.reload();
    payments.reload();
    onMutated();
  }

  async function lifecycle(verb: string, path: string, body?: unknown) {
    if (!commitmentId) return;
    const done = await run(verb, () =>
      api.post(`/api/v1/commitments/${commitmentId}/${path}`, body ?? {}),
    );
    if (done !== null) reloadAll();
  }

  const tabs = useMemo(
    () => [
      { value: "overview" as const, label: "Overview" },
      {
        value: "sov" as const,
        label: "Schedule of values",
        count: data?.sovLines.length,
      },
      {
        value: "changes" as const,
        label: "Change orders",
        count: data?.changes.length,
      },
      {
        value: "payments" as const,
        label: "Payments",
        count: data?.payments.length,
      },
      {
        value: "compliance" as const,
        label: "Compliance",
        count: data ? data.compliance.blocking.length + data.compliance.warnings.length : undefined,
        tone: data ? complianceTone(data.compliance.status) : undefined,
      },
      { value: "backcharges" as const, label: "Backcharges" },
      { value: "closeout" as const, label: "Closeout" },
      { value: "documents" as const, label: "Contract documents" },
    ],
    [data],
  );

  return (
    <Drawer
      open={commitmentId !== null}
      onClose={onClose}
      size="xl"
      title={
        commitment ? (
          <span className="flex items-center gap-2">
            <span className="font-mono">{commitment.reference}</span>
            <span className="truncate">{commitment.title}</span>
          </span>
        ) : (
          "Commitment"
        )
      }
      description={
        commitment
          ? `${KIND_LABEL[commitment.kind] ?? commitment.kind} · ${data?.vendor?.name ?? "no vendor bound"} · ${commitment.currency}`
          : undefined
      }
      headerActions={
        commitment ? (
          <Badge tone={statusToneOf(commitment.status)} dot>
            {titleCase(commitment.status)}
          </Badge>
        ) : null
      }
    >
      {dialog}
      {reasonDialog}
      {detail.loading && !data ? (
        <div className="py-12">
          <Spinner label="Loading the commitment…" />
        </div>
      ) : detail.error ? (
        <Alert tone="danger" title="This commitment could not be loaded">
          {detail.error}
        </Alert>
      ) : data && commitment ? (
        <div className="space-y-4">
          <RefusalPanel refusal={refusal} onDismiss={clear} />

          <Alert
            tone={complianceTone(data.compliance.status)}
            variant="subtle"
            title={COMPLIANCE_LABEL[data.compliance.status]}
          >
            {data.compliance.blocking[0]?.message ??
              data.compliance.warnings[0]?.message ??
              data.compliance.note ??
              `No finding against the requirements recorded on this commitment, as at ${data.compliance.asOf}.`}
          </Alert>

          {!data.billable.billable && data.billable.reason ? (
            <Alert tone="warning" size="sm" title="Not billable">
              {data.billable.reason}
            </Alert>
          ) : null}

          <Card>
            <CardBody className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <MoneyStat
                label="Original sum"
                value={data.position.originalCommitmentSum}
                currency={data.position.currency}
                hint="Σ scheduled value on the schedule of values"
              />
              <MoneyStat
                label="Approved changes"
                value={data.position.approvedChangeSum}
                currency={data.position.currency}
              />
              <MoneyStat
                label="Revised sum"
                value={data.position.revisedCommitmentSum}
                currency={data.position.currency}
              />
              <MoneyStat
                label="Invoiced"
                value={data.position.totalInvoiced}
                currency={data.position.currency}
                hint={
                  <Figure
                    figure={data.position.percentInvoiced}
                    render={(v) => `${pct(v)} of the revised sum`}
                  />
                }
              />
              <MoneyStat
                label="Paid"
                value={data.position.totalPaid}
                currency={data.position.currency}
                hint={
                  <Figure
                    figure={data.position.percentPaid}
                    render={(v) => `${pct(v)} of the revised sum`}
                  />
                }
              />
            </CardBody>
          </Card>

          <LifecycleBar
            status={commitment.status}
            executed={commitment.executed === 1}
            paymentHold={commitment.paymentHold === 1}
            busy={busy}
            onEdit={() => setEditingHeader(true)}
            onOutForBid={() => lifecycle("out-for-bid", "out-for-bid")}
            onDelete={async () => {
              const ok = await confirm({
                title: `Delete ${commitment.reference}?`,
                description:
                  "A draft commitment with nothing against it can be deleted outright. Anything further along is voided or terminated instead, so the record survives.",
                destructive: true,
                confirmLabel: "Delete the draft",
              });
              if (!ok) return;
              const done = await run("delete", () =>
                api.del(`/api/v1/commitments/${commitment.id}`),
              );
              if (done !== null) {
                onMutated();
                onClose();
              }
            }}
            onSubmit={() => lifecycle("submit", "submit")}
            onApprove={() => lifecycle("approve", "approve")}
            onExecute={() => lifecycle("execute", "execute")}
            onComplete={() => lifecycle("complete", "complete")}
            onHold={async () => {
              const reason = await ask({
                title: `Hold payment on ${commitment.reference}?`,
                description:
                  "A manual hold outranks every strictness setting, including \u201coff\u201d — it is an instruction from a person, and no configuration should be able to overrule it quietly.",
                label: "Why is payment held?",
                confirmLabel: "Place the hold",
              });
              if (!reason) return;
              await lifecycle("hold", "hold", { reason });
            }}
            onReleaseHold={async () => {
              const ok = await confirm({
                title: "Release the payment hold?",
                description:
                  "Releasing a hold is an approval in everything but name — it is what lets money move again. The release is ledgered with your identity and the previous reason.",
                confirmLabel: "Release the hold",
                tone: "warning",
              });
              if (ok) await lifecycle("release-hold", "release-hold", {});
            }}
            onTerminate={async () => {
              const ok = await confirm({
                title: `Terminate ${commitment.reference}?`,
                description:
                  "Termination stops the commitment, puts payment on hold and keeps every record that money moved against. It cannot be undone.",
                destructive: true,
                confirmationText: commitment.reference,
                confirmationLabel: `Type ${commitment.reference} to confirm`,
                confirmLabel: "Terminate",
              });
              if (!ok) return;
              const reason = await ask({
                title: `Reason for terminating ${commitment.reference}`,
                label: "Reason for termination",
                confirmLabel: "Terminate",
                destructive: true,
              });
              if (!reason) return;
              await lifecycle("terminate", "terminate", { reason });
            }}
            onVoid={async () => {
              const ok = await confirm({
                title: `Void ${commitment.reference}?`,
                description:
                  "Voiding is only possible while nothing has been invoiced or paid. If money has moved the API refuses and asks you to terminate instead, so the record survives.",
                destructive: true,
                confirmationText: commitment.reference,
                confirmationLabel: `Type ${commitment.reference} to confirm`,
                confirmLabel: "Void",
              });
              if (!ok) return;
              const reason = await ask({
                title: `Reason for voiding ${commitment.reference}`,
                label: "Reason for voiding",
                confirmLabel: "Void",
                destructive: true,
              });
              if (!reason) return;
              await lifecycle("void", "void", { reason });
            }}
          />

          <EditHeader
            open={editingHeader}
            commitment={commitment}
            onClose={() => setEditingHeader(false)}
            onSaved={() => {
              setEditingHeader(false);
              reloadAll();
            }}
          />

          <Tabs items={tabs} value={panel} onChange={setPanel} size="sm" />

          {panel === "overview" ? (
            <Overview detail={data} buyoutRows={buyoutRows} />
          ) : panel === "sov" ? (
            <SovPanel
              commitment={commitment}
              sov={sov}
              buyoutRows={buyoutRows}
              onChanged={reloadAll}
            />
          ) : panel === "changes" ? (
            <ChangesPanel
              commitment={commitment}
              changes={changes}
              sovLines={data.sovLines}
              onChanged={reloadAll}
            />
          ) : panel === "payments" ? (
            <PaymentsPanel
              commitment={commitment}
              compliance={data.compliance}
              position={data.position}
              payments={payments}
              onChanged={reloadAll}
            />
          ) : panel === "compliance" ? (
            <CompliancePosition result={data.compliance} />
          ) : panel === "backcharges" ? (
            <BackchargesPanel commitment={commitment} onChanged={reloadAll} />
          ) : panel === "closeout" ? (
            <CloseoutPanel commitment={commitment} onChanged={reloadAll} />
          ) : (
            <DocumentsPanel commitment={commitment} onChanged={reloadAll} />
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

function LifecycleBar({
  status,
  executed,
  paymentHold,
  busy,
  onEdit,
  onOutForBid,
  onDelete,
  onSubmit,
  onApprove,
  onExecute,
  onComplete,
  onHold,
  onReleaseHold,
  onTerminate,
  onVoid,
}: {
  status: string;
  executed: boolean;
  paymentHold: boolean;
  busy: string | null;
  onEdit: () => void;
  onOutForBid: () => void;
  onDelete: () => void;
  onSubmit: () => void;
  onApprove: () => void;
  onExecute: () => void;
  onComplete: () => void;
  onHold: () => void;
  onReleaseHold: () => void;
  onTerminate: () => void;
  onVoid: () => void;
}) {
  const working = busy !== null;
  const dead = status === "void" || status === "terminated";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised/50 px-3 py-2">
      {!dead ? (
        <Button size="xs" variant="secondary" onClick={onEdit} disabled={working}>
          Edit header
        </Button>
      ) : null}
      {status === "draft" ? (
        <Button size="xs" variant="secondary" onClick={onOutForBid} disabled={working}>
          Send out for bid
        </Button>
      ) : null}
      {status === "draft" || status === "out_for_bid" ? (
        <Button size="xs" variant="secondary" onClick={onSubmit} disabled={working}>
          Send out for signature
        </Button>
      ) : null}
      {status === "draft" || status === "out_for_bid" || status === "out_for_signature" ? (
        <Button size="xs" onClick={onApprove} disabled={working}>
          Approve
        </Button>
      ) : null}
      {status === "approved" && !executed ? (
        <Button size="xs" onClick={onExecute} disabled={working}>
          Record execution
        </Button>
      ) : null}
      {status === "approved" ? (
        <Button size="xs" variant="secondary" onClick={onComplete} disabled={working}>
          Mark complete
        </Button>
      ) : null}
      {!dead ? (
        paymentHold ? (
          <Button size="xs" variant="secondary" onClick={onReleaseHold} disabled={working}>
            Release payment hold
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={onHold} disabled={working}>
            Hold payment
          </Button>
        )
      ) : null}
      <span className="flex-1" />
      {status === "draft" || status === "out_for_bid" || status === "out_for_signature" ? (
        <Button size="xs" variant="danger" onClick={onVoid} disabled={working}>
          Void
        </Button>
      ) : null}
      {status === "draft" ? (
        <Button size="xs" variant="danger" onClick={onDelete} disabled={working}>
          Delete draft
        </Button>
      ) : null}
      {!dead ? (
        <Button size="xs" variant="danger" onClick={onTerminate} disabled={working}>
          Terminate
        </Button>
      ) : null}
      {dead ? (
        <span className="text-2xs text-content-subtle">
          This commitment is {status}. Nothing further can be done to it.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The header a subcontract carries beside its money: title, scope, terms,
 * dates and retainage. The API refuses currency and vendor changes once the
 * commitment carries value, and refuses everything once it is void or
 * terminated — the refusal is shown verbatim rather than pre-empted here.
 */
function EditHeader({
  open,
  commitment,
  onClose,
  onSaved,
}: {
  open: boolean;
  commitment: NonNullable<ReturnType<typeof useCommitmentDetail>["data"]>["commitment"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState(commitment.title);
  const [scope, setScope] = useState(commitment.scopeOfWork ?? "");
  const [terms, setTerms] = useState(
    commitment.paymentTermsDays === null ? "" : String(commitment.paymentTermsDays),
  );
  const [retainage, setRetainage] = useState(String(commitment.defaultRetainagePercent));
  const [start, setStart] = useState(commitment.startDate ?? "");
  const [end, setEnd] = useState(commitment.estimatedCompletionDate ?? "");

  useEffect(() => {
    if (!open) return;
    setTitle(commitment.title);
    setScope(commitment.scopeOfWork ?? "");
    setTerms(commitment.paymentTermsDays === null ? "" : String(commitment.paymentTermsDays));
    setRetainage(String(commitment.defaultRetainagePercent));
    setStart(commitment.startDate ?? "");
    setEnd(commitment.estimatedCompletionDate ?? "");
  }, [open, commitment]);

  async function save() {
    const body: Record<string, unknown> = {
      title: title.trim(),
      scopeOfWork: scope.trim() || null,
      paymentTermsDays: terms.trim() === "" ? null : Number(terms),
      defaultRetainagePercent: Number(retainage) || 0,
      startDate: start.trim() || null,
      estimatedCompletionDate: end.trim() || null,
    };
    const ok = await run("patch", () => api.patch(`/api/v1/commitments/${commitment.id}`, body));
    if (ok !== null) onSaved();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${commitment.reference}`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!title.trim() || busy !== null} onClick={() => void save()}>
            Save the header
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} title="This edit was refused" />
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Scope of work">
          <Textarea rows={4} value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment terms (days)">
            <Input value={terms} inputMode="numeric" onChange={(e) => setTerms(e.target.value)} />
          </Field>
          <Field label="Default retainage %">
            <Input
              value={retainage}
              inputMode="decimal"
              onChange={(e) => setRetainage(e.target.value)}
            />
          </Field>
          <Field label="Start date">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Estimated completion">
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/** Scope, terms, dates, vendor — and the budget this commitment consumes. */
function Overview({
  detail,
  buyoutRows,
}: {
  detail: NonNullable<ReturnType<typeof useCommitmentDetail>["data"]>;
  buyoutRows: BuyoutRow[];
}) {
  const c = detail.commitment;
  const budgetById = useMemo(() => {
    const map = new Map<string, BuyoutRow>();
    for (const row of buyoutRows) map.set(row.budgetLineItemId, row);
    return map;
  }, [buyoutRows]);

  /** What this commitment consumes, per budget line, from its own schedule. */
  const consumption = useMemo(() => {
    const byLine = new Map<string, number>();
    let unbound = 0;
    for (const line of detail.sovLines) {
      if (!line.budgetLineItemId) {
        unbound += line.revisedScheduledValue;
        continue;
      }
      byLine.set(
        line.budgetLineItemId,
        (byLine.get(line.budgetLineItemId) ?? 0) + line.revisedScheduledValue,
      );
    }
    return {
      rows: [...byLine.entries()].map(([id, value]) => ({
        id,
        value,
        budget: budgetById.get(id),
      })),
      unbound: Number(unbound.toFixed(2)),
    };
  }, [detail.sovLines, budgetById]);

  const items: DescriptionItem[] = [
    { label: "Vendor", value: detail.vendor?.name ?? "no vendor bound" },
    { label: "Vendor status", value: titleCase(detail.vendor?.status) },
    { label: "Kind", value: KIND_LABEL[c.kind] ?? c.kind },
    { label: "Pricing", value: titleCase(c.pricingType) },
    { label: "Currency", value: c.currency },
    {
      label: "Default retainage",
      value: `${pct(c.defaultRetainagePercent)} withheld on new schedule lines`,
    },
    {
      label: "Retainage held / released",
      value: `${money(c.retainageHeld, c.currency)} held · ${money(c.retainageReleased, c.currency)} released`,
    },
    {
      label: "Payment terms",
      value: c.paymentTermsDays === null ? "not recorded" : `${c.paymentTermsDays} days`,
    },
    {
      label: "Lien waiver",
      value: c.requiresLienWaiver === 1 ? "required" : "not required",
    },
    { label: "Contract date", value: isoDate(c.contractDate) },
    { label: "Start", value: isoDate(c.startDate) },
    {
      label: "Estimated completion",
      value: isoDate(c.estimatedCompletionDate),
    },
    { label: "Actual completion", value: isoDate(c.actualCompletionDate) },
    {
      label: "Signed contract received",
      value: isoDate(c.signedContractReceivedDate),
    },
    {
      label: "Executed",
      value: c.executed === 1 ? isoDate(c.executionDate) : "not executed",
    },
  ];
  if (c.kind === "purchase_order") {
    items.push(
      { label: "Ship to", value: c.shipTo ?? "not recorded" },
      { label: "Ship via", value: c.shipVia ?? "not recorded" },
      { label: "Delivery date", value: isoDate(c.deliveryDate) },
      {
        label: "Tax",
        value:
          c.taxable === 1
            ? `${pct(c.taxPercent)} on taxable lines`
            : "this purchase order is not taxable",
      },
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <DescriptionList items={items} columns={3} layout="stacked" size="sm" />
        </CardBody>
      </Card>

      <ProseBlock title="Scope of work" body={c.scopeOfWork} />
      <div className="grid gap-3 md:grid-cols-2">
        <ProseBlock title="Inclusions" body={c.inclusions} />
        <ProseBlock title="Exclusions" body={c.exclusions} />
      </div>
      <ProseBlock title="Description" body={c.description} />

      <Card>
        <CardBody className="space-y-2">
          <h3 className="text-sm font-semibold">Budget this commitment consumes</h3>
          <p className="text-2xs text-content-subtle">
            Every schedule-of-values line carries a budget line, and committed cost on the budget is
            re-derived from those bindings. A line with no binding is money that will never appear
            in the buyout log — which is why it is named here rather than hidden.
          </p>
          {consumption.rows.length === 0 && consumption.unbound === 0 ? (
            <p className="text-meta text-content-subtle">
              This commitment has no schedule of values, so it consumes no budget yet.
            </p>
          ) : (
            <table className="w-full text-meta">
              <thead>
                <tr className="border-b border-border text-left text-content-subtle">
                  <th className="py-1 font-medium">Budget line</th>
                  <th className="py-1 text-right font-medium">This commitment</th>
                  <th className="py-1 text-right font-medium">Revised budget</th>
                  <th className="py-1 text-right font-medium">Committed (all)</th>
                </tr>
              </thead>
              <tbody>
                {consumption.rows.map((row) => (
                  <tr key={row.id} className="border-b border-border-subtle last:border-0">
                    <td className="py-1">
                      {row.budget ? (
                        <>
                          <span className="font-mono">{row.budget.costCode}</span>{" "}
                          {row.budget.description}
                        </>
                      ) : (
                        <span className="text-content-subtle">
                          <span className="font-mono">{row.id}</span> — not on the active budget, so
                          no budget figure is available for it
                        </span>
                      )}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums">
                      {money(row.value, c.currency)}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums">
                      {row.budget ? (
                        money(row.budget.revisedBudget, row.budget.currency)
                      ) : (
                        <span className="italic text-content-subtle">not available</span>
                      )}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums">
                      {row.budget ? (
                        money(row.budget.committed, row.budget.currency)
                      ) : (
                        <span className="italic text-content-subtle">not available</span>
                      )}
                    </td>
                  </tr>
                ))}
                {consumption.unbound !== 0 ? (
                  <tr>
                    <td className="py-1 text-warning-fg">Not bound to any budget line</td>
                    <td className="py-1 text-right font-mono tabular-nums text-warning-fg">
                      {money(consumption.unbound, c.currency)}
                    </td>
                    <td className="py-1 text-right text-content-subtle">—</td>
                    <td className="py-1 text-right text-content-subtle">—</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-1.5">
          <h3 className="text-sm font-semibold">Identities checked on this commitment</h3>
          {detail.position.reconciliation.checks.map((check) => (
            <div
              key={check.identity}
              className="flex flex-wrap items-baseline justify-between gap-2 text-2xs"
            >
              <code className="font-mono text-content-muted">{check.identity}</code>
              <span className="font-mono tabular-nums">
                {money(check.left, c.currency)} vs {money(check.right, c.currency)}
                <Badge tone={check.reconciles ? "success" : "danger"} size="xs" className="ml-2">
                  {check.reconciles ? "ok" : `off by ${money(check.delta, c.currency)}`}
                </Badge>
              </span>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function ProseBlock({ title, body }: { title: string; body: string | null }) {
  return (
    <Card>
      <CardBody>
        <h3 className="text-sm font-semibold">{title}</h3>
        {body ? (
          <p className="mt-1 whitespace-pre-wrap text-meta text-content-muted">{body}</p>
        ) : (
          <p className="mt-1 text-meta italic text-content-subtle">
            Nothing is recorded here. That is not the same as nothing being agreed — it means this
            field is empty on the record.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
