/**
 * BUDGET CHANGES — the only way money moves once a budget is locked.
 *
 * Two rules the API will not bend, and this screen exists to make both of them
 * obvious BEFORE a request is sent rather than only after it is refused:
 *
 *  BALANCE. A transfer, draw, adjustment or reallocation must net to zero
 *  across its legs. A movement that does not balance is not a transfer — it is
 *  an unfunded increase wearing a transfer's clothes, and it is the easiest way
 *  to inflate a budget without anyone signing for the money. Only an
 *  `owner_change` may move the total, and only behind an executed prime
 *  contract change order. The form validates this live and blocks submission;
 *  when the server refuses anyway, its wording is shown VERBATIM.
 *
 *  SEGREGATION OF DUTIES (ADR 0004). The approver may be neither the person who
 *  requested the movement nor the person who drafted it. When the API refuses
 *  on that ground it is presented here as the control working — a rule, in the
 *  platform's own words — never as an error the user did something wrong to
 *  cause.
 *
 * The movements ledger at the bottom is the audit answer to "how did this line
 * get from its original budget to today's figure": every approved leg in
 * effect order with the running balance it produced, plus the API's own proof
 * that the ledger reconstructs the stored revised total.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUDGET_CHANGE_KINDS,
  BUDGET_CHANGE_STATUSES,
  type BudgetChangeKind,
  type BudgetChangeStatus,
} from "@constructos/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  Tooltip,
  Tr,
  cx,
  useConfirm,
} from "../../ui";
import { IconChangeOrder, IconPlus, IconTrash } from "../../ui/icons";
import { DataTable } from "../../ui/data";
import type { DataColumns, DataOption } from "../../ui/data";
import { Combobox, DatePicker } from "../../ui/inputs";
import { api } from "../../lib/api";
import { MoneyField } from "./moneyInput";
import {
  CHANGE_KIND_LABEL,
  CHANGE_KIND_RULE,
  CHANGE_STATUS_TONE,
  LoadError,
  RefusalNotice,
  SectionHeading,
  actorName,
  count,
  dateTime,
  errorMessage,
  isForbidden,
  isoDate,
  labelize,
  loadAllLines,
  money,
  today,
  useResource,
  type BudgetChange,
  type BudgetChangeDetail,
  type BudgetDetail,
  type BudgetLine,
  type ChangeLeg,
  type ChangeOrderPackageRef,
  type ListResponse,
  type MovementsResponse,
} from "./budgetShared";

const CENT = 0.005;
const round2 = (n: number): number => Math.round(n * 100) / 100;

const toIsoDate = (date: Date | null): string | null => {
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
};
const fromIsoDate = (value: string | null): Date | null =>
  value ? new Date(`${value}T00:00:00`) : null;

interface DraftLeg {
  key: string;
  lineItemId: string | null;
  amount: number | null;
}

let legSeq = 0;
const newLeg = (): DraftLeg => ({ key: `leg-${(legSeq += 1)}`, lineItemId: null, amount: null });

export interface ChangesTabProps {
  budget: BudgetDetail;
  currency: string;
  users: Map<string, string>;
  version: number;
  onChanged: () => void;
}

export default function ChangesTab({
  budget,
  currency,
  users,
  version,
  onChanged,
}: ChangesTabProps) {
  const { confirm, dialog } = useConfirm();
  const [statusFilter, setStatusFilter] = useState<"" | BudgetChangeStatus>("");
  const [kindFilter, setKindFilter] = useState<"" | BudgetChangeKind>("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<BudgetChange | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [localVersion, setLocalVersion] = useState(0);
  const bump = useCallback(() => setLocalVersion((n) => n + 1), []);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: "1", pageSize: "200" });
    if (statusFilter) params.set("status", statusFilter);
    if (kindFilter) params.set("kind", kindFilter);
    return params.toString();
  }, [statusFilter, kindFilter]);

  const changes = useResource<ListResponse<BudgetChange>>(
    (signal) =>
      api.get<ListResponse<BudgetChange>>(`/api/v1/budgets/${budget.id}/changes?${query}`, {
        signal,
      }),
    [budget.id, query, version, localVersion],
  );

  const lines = useResource(
    (signal) => loadAllLines(budget.id, signal),
    [budget.id, version, localVersion],
  );

  const movements = useResource<MovementsResponse>(
    (signal) =>
      api.get<MovementsResponse>(`/api/v1/budgets/${budget.id}/movements`, { signal }),
    [budget.id, version, localVersion],
  );

  const allLines = useMemo(() => lines.data?.lines ?? [], [lines.data]);
  const lineById = useMemo(
    () => new Map(allLines.map((line) => [line.id, line])),
    [allLines],
  );

  const rows = changes.data?.items ?? [];

  const columns = useMemo<DataColumns<BudgetChange>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", width: 96, sticky: "start" },
      {
        id: "kind",
        header: "Kind",
        accessor: "kind",
        type: "enum",
        width: 148,
        options: BUDGET_CHANGE_KINDS.map<DataOption>((kind) => ({
          value: kind,
          text: CHANGE_KIND_LABEL[kind],
          label: CHANGE_KIND_LABEL[kind],
        })),
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 300 },
      {
        id: "amount",
        header: "Amount moved",
        accessor: "amount",
        type: "currency",
        currency,
        precision: 0,
        width: 150,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "netEffect",
        header: "Net effect",
        headerTooltip:
          "Zero for every kind except owner_change — nothing else may change the budget total.",
        accessor: "netEffect",
        type: "currency",
        currency,
        precision: 0,
        width: 140,
        mono: true,
        signColor: true,
        aggregate: "sum",
      },
      {
        id: "legs",
        header: "Legs",
        accessor: (change: BudgetChange) => change.lines.length,
        type: "number",
        width: 80,
        aggregate: "none",
      },
      { id: "effectiveDate", header: "Effective", accessor: "effectiveDate", type: "date", width: 124 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 148,
        options: BUDGET_CHANGE_STATUSES.map<DataOption>((status) => ({
          value: status,
          text: labelize(status),
          label: labelize(status),
          tone: CHANGE_STATUS_TONE[status],
        })),
      },
      {
        id: "requestedBy",
        header: "Requested by",
        accessor: (change: BudgetChange) => actorName(users, change.requestedBy),
        type: "text",
        width: 160,
      },
      {
        id: "approvedBy",
        header: "Approved by",
        accessor: (change: BudgetChange) => actorName(users, change.approvedBy),
        type: "text",
        width: 160,
      },
    ],
    [currency, users],
  );

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading
          title="Budget changes and transfers"
          hint="Every movement is a set of legs. Anything but an owner change must balance to zero across them, and nobody may approve their own request."
          actions={
            <>
              <Select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as "" | BudgetChangeStatus)}
                size="sm"
                aria-label="Filter by status"
              >
                <option value="">All statuses</option>
                {BUDGET_CHANGE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {labelize(status)}
                  </option>
                ))}
              </Select>
              <Select
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as "" | BudgetChangeKind)}
                size="sm"
                aria-label="Filter by kind"
              >
                <option value="">All kinds</option>
                {BUDGET_CHANGE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {CHANGE_KIND_LABEL[kind]}
                  </option>
                ))}
              </Select>
              <Button
                leadingIcon={IconPlus}
                onClick={() => {
                  setEditing(null);
                  setComposerOpen(true);
                }}
                disabled={budget.status === "closed"}
                title={
                  budget.status === "closed"
                    ? "A closed budget cannot take changes"
                    : "Raise a budget change"
                }
              >
                New change
              </Button>
            </>
          }
        />

        {changes.error ? (
          <LoadError
            message={changes.error}
            onRetry={changes.reload}
            title="Budget changes could not be loaded"
          />
        ) : null}

        <DataTable<BudgetChange>
          tableId="budget-changes"
          data={rows}
          columns={columns}
          getRowId={(change) => change.id}
          loading={changes.loading && rows.length === 0}
          density="compact"
          stickyHeader
          showFooter
          maxHeight={460}
          onRowClick={({ row }) => setOpenId(row.id)}
          exportFileName={`${budget.reference}-budget-changes`}
          searchPlaceholder="Search reference, title…"
          empty={{
            title: "No budget change has been raised",
            description:
              "Once this budget is locked, a budget change is the only way money moves on it. Until then, plan amounts can still be edited directly on the grid.",
            icon: IconChangeOrder,
          }}
          aria-label="Budget changes"
        />
      </section>

      <MovementsLedger
        movements={movements.data}
        loading={movements.loading}
        error={movements.error}
        onRetry={movements.reload}
        currency={currency}
        users={users}
      />

      <ChangeDrawer
        changeId={openId}
        currency={currency}
        users={users}
        lineById={lineById}
        canApprove={budget.status !== "closed"}
        onClose={() => setOpenId(null)}
        onEdit={(change) => {
          setOpenId(null);
          setEditing(change);
          setComposerOpen(true);
        }}
        onChanged={() => {
          bump();
          onChanged();
        }}
        confirm={confirm}
      />

      <ChangeComposer
        open={composerOpen}
        budget={budget}
        currency={currency}
        lines={allLines}
        existing={editing}
        onClose={() => {
          setComposerOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setComposerOpen(false);
          setEditing(null);
          bump();
          onChanged();
        }}
      />

      {dialog}
    </div>
  );
}

/* ========================================================================== */
/* Movements ledger                                                            */
/* ========================================================================== */

function MovementsLedger({
  movements,
  loading,
  error,
  onRetry,
  currency,
  users,
}: {
  movements: MovementsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  currency: string;
  users: Map<string, string>;
}) {
  return (
    <section>
      <SectionHeading
        title="Movements audit"
        hint="Every approved leg in effect order, with the running balance it produced. Derived from the change records themselves — not a second copy that can drift."
        actions={
          movements ? (
            <Tooltip
              content={
                movements.reconcilesToRevisedTotal
                  ? "Replaying every approved leg from the original budgets reproduces the stored revised total exactly."
                  : "Replaying the legs does NOT reproduce the stored revised total. The budget needs recalculating."
              }
            >
              <span>
                <Badge tone={movements.reconcilesToRevisedTotal ? "success" : "danger"} size="sm" dot>
                  {movements.reconcilesToRevisedTotal
                    ? "Ledger reconciles"
                    : "Ledger does not reconcile"}
                </Badge>
              </span>
            </Tooltip>
          ) : null
        }
      />

      {error ? (
        <LoadError message={error} onRetry={onRetry} title="The movements ledger could not be loaded" />
      ) : null}

      {movements ? (
        <div className="mb-3 flex flex-wrap gap-6 text-meta text-content-muted">
          <span>
            Opening total{" "}
            <span className="font-medium tabular-nums text-content">
              {money(movements.openingTotal, currency)}
            </span>
          </span>
          <span>
            Closing total{" "}
            <span className="font-medium tabular-nums text-content">
              {money(movements.closingTotal, currency)}
            </span>
          </span>
          <span>
            Stored revised total{" "}
            <span className="font-medium tabular-nums text-content">
              {money(movements.storedRevisedTotal, currency)}
            </span>
          </span>
          <span>{count(movements.movementCount)} movements</span>
        </div>
      ) : null}

      {loading && !movements ? (
        <div className="skeleton h-40 rounded-lg" aria-hidden="true" />
      ) : movements && movements.movements.length === 0 ? (
        <EmptyState
          title="No approved movement yet"
          hint="Nothing has moved on this budget. The moment a change is approved, every leg appears here with the balance it produced."
        />
      ) : movements ? (
        <Table dense stickyHeader className="max-h-96 overflow-y-auto">
          <thead>
            <tr>
              <Th>Ref</Th>
              <Th>Effective</Th>
              <Th>Kind</Th>
              <Th>Cost code</Th>
              <Th numeric>Amount</Th>
              <Th numeric>Line balance after</Th>
              <Th numeric>Budget total after</Th>
              <Th>Approved by</Th>
            </tr>
          </thead>
          <tbody>
            {movements.movements.map((movement, index) => (
              <Tr key={`${movement.changeId}-${movement.lineItemId}-${index}`}>
                <Td className="font-mono text-code">{movement.reference}</Td>
                <Td>{isoDate(movement.effectiveDate)}</Td>
                <Td>{CHANGE_KIND_LABEL[movement.kind]}</Td>
                <Td className="font-mono text-code">
                  {movement.costCode}
                  <span className="ml-1 text-content-subtle">{labelize(movement.costType)}</span>
                </Td>
                <Td numeric>
                  <span
                    className={cx(
                      movement.amount < 0 ? "text-danger-fg" : "text-success-fg",
                      "font-medium",
                    )}
                  >
                    {money(movement.amount, currency, { signed: true })}
                  </span>
                </Td>
                <Td numeric>{money(movement.lineBalanceAfter, currency)}</Td>
                <Td numeric>{money(movement.budgetTotalAfter, currency)}</Td>
                <Td muted>{actorName(users, movement.approvedBy)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </section>
  );
}

/* ========================================================================== */
/* Change drawer                                                               */
/* ========================================================================== */

type ConfirmFn = (options: {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  tone?: "warning" | "danger" | "accent";
}) => Promise<boolean>;

function ChangeDrawer({
  changeId,
  currency,
  users,
  lineById,
  canApprove,
  onClose,
  onEdit,
  onChanged,
  confirm,
}: {
  changeId: string | null;
  currency: string;
  users: Map<string, string>;
  lineById: Map<string, BudgetLine>;
  canApprove: boolean;
  onClose: () => void;
  onEdit: (change: BudgetChange) => void;
  onChanged: () => void;
  confirm: ConfirmFn;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ title: string; message: string } | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [localVersion, setLocalVersion] = useState(0);

  const change = useResource<BudgetChangeDetail>(
    (signal) => api.get<BudgetChangeDetail>(`/api/v1/budget-changes/${changeId}`, { signal }),
    [changeId ?? "", localVersion],
    changeId !== null,
  );

  useEffect(() => {
    setError(null);
    setRefusal(null);
    setRejectOpen(false);
    setRejectReason("");
  }, [changeId]);

  const row = change.data;

  async function act(key: string, run: () => Promise<unknown>, refusalTitle: string) {
    setBusy(key);
    setError(null);
    setRefusal(null);
    try {
      await run();
      setLocalVersion((n) => n + 1);
      onChanged();
    } catch (err) {
      if (isForbidden(err)) {
        setRefusal({
          title: "Segregation of duties",
          message: errorMessage(err, "This approval was refused."),
        });
      } else {
        const status = (err as { status?: number }).status;
        if (status === 409 || status === 400) {
          setRefusal({
            title: refusalTitle,
            message: errorMessage(err, "The platform refused this."),
          });
        } else {
          setError(errorMessage(err, "That action could not be completed"));
        }
      }
    } finally {
      setBusy(null);
    }
  }

  const status = row?.status;

  return (
    <Drawer
      open={changeId !== null}
      onClose={onClose}
      size="lg"
      title={row ? `${row.reference} · ${row.title}` : "Budget change"}
      description={row ? CHANGE_KIND_LABEL[row.kind] : undefined}
      headerActions={
        row ? (
          <Badge tone={CHANGE_STATUS_TONE[row.status]} size="sm" dot>
            {labelize(row.status)}
          </Badge>
        ) : undefined
      }
      footer={
        row ? (
          <div className="flex flex-wrap items-center gap-2">
            {status === "draft" ? (
              <>
                <Button variant="secondary" onClick={() => onEdit(row)}>
                  Edit
                </Button>
                <Button
                  loading={busy === "submit"}
                  onClick={() =>
                    void act(
                      "submit",
                      () => api.post(`/api/v1/budget-changes/${row.id}/submit`, {}),
                      "This movement cannot be submitted",
                    )
                  }
                >
                  Submit for approval
                </Button>
              </>
            ) : null}
            {status === "pending_approval" && canApprove ? (
              <>
                <Button
                  loading={busy === "approve"}
                  onClick={() =>
                    void (async () => {
                      const ok = await confirm({
                        title: `Approve ${row.reference}?`,
                        description:
                          "Approving applies every leg to the budget immediately. An approved movement cannot be voided afterwards — reversing it takes another change, so both sides stay on the record.",
                        confirmLabel: "Approve movement",
                        tone: "warning",
                      });
                      if (!ok) return;
                      await act(
                        "approve",
                        () => api.post(`/api/v1/budget-changes/${row.id}/approve`, {}),
                        "This movement cannot be approved",
                      );
                    })()
                  }
                >
                  Approve
                </Button>
                <Button variant="secondary" onClick={() => setRejectOpen(true)}>
                  Reject
                </Button>
              </>
            ) : null}
            {status === "draft" || status === "pending_approval" ? (
              <Button
                variant="ghost"
                leadingIcon={IconTrash}
                loading={busy === "void"}
                onClick={() =>
                  void (async () => {
                    const ok = await confirm({
                      title: `Void ${row.reference}?`,
                      description:
                        "Voiding leaves the record in place as evidence — a refused transfer is evidence, not a deleted row — and releases any pending exposure it was holding on the lines.",
                      confirmLabel: "Void movement",
                      destructive: true,
                    });
                    if (!ok) return;
                    await act(
                      "void",
                      () => api.post(`/api/v1/budget-changes/${row.id}/void`, {}),
                      "This movement cannot be voided",
                    );
                  })()
                }
              >
                Void
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {change.error ? (
        <LoadError
          message={change.error}
          onRetry={change.reload}
          title="This budget change could not be loaded"
        />
      ) : null}
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {refusal ? (
        <div className="mb-3">
          <RefusalNotice
            title={refusal.title}
            message={refusal.message}
            onDismiss={() => setRefusal(null)}
          />
        </div>
      ) : null}

      {row ? (
        <div className="space-y-4">
          <Card variant={row.balance.error ? "raised" : "sunken"} accent={row.balance.error ? "danger" : undefined}>
            <CardBody>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-label uppercase text-content-subtle">Amount moved</p>
                  <p className="text-display-xs font-semibold tabular-nums text-content">
                    {money(row.balance.amount, currency)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-label uppercase text-content-subtle">Net effect on the budget</p>
                  <p
                    className={cx(
                      "text-display-xs font-semibold tabular-nums",
                      row.balance.net === 0 ? "text-content" : "text-warning-fg",
                    )}
                  >
                    {money(row.balance.net, currency, { signed: true })}
                  </p>
                </div>
              </div>
              <p className="mt-2 text-meta text-content-muted">{CHANGE_KIND_RULE[row.kind]}</p>
              {row.balance.error ? (
                <Alert tone="danger" size="sm" className="mt-3" title="These legs are not a legal movement">
                  {row.balance.error}
                </Alert>
              ) : (
                <Badge tone="success" size="xs" className="mt-3">
                  {row.balance.balances ? "Balances to zero" : "Funded increase"}
                </Badge>
              )}
            </CardBody>
          </Card>

          <section>
            <h3 className="mb-2 text-label uppercase text-content-subtle">Legs</h3>
            <Table dense flush>
              <thead>
                <tr>
                  <Th>Cost code</Th>
                  <Th>Description</Th>
                  <Th>Cost type</Th>
                  <Th numeric>Amount</Th>
                  <Th numeric>Revised budget now</Th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((leg) => {
                  const line = lineById.get(leg.lineItemId);
                  return (
                    <Tr key={leg.lineItemId}>
                      <Td className="font-mono text-code">{leg.costCode || line?.costCode}</Td>
                      <Td truncate>{line?.description ?? "—"}</Td>
                      <Td muted>{labelize(leg.costType)}</Td>
                      <Td numeric>
                        <span
                          className={cx(
                            "font-medium",
                            leg.amount < 0 ? "text-danger-fg" : "text-success-fg",
                          )}
                        >
                          {money(leg.amount, currency, { signed: true })}
                        </span>
                      </Td>
                      <Td numeric muted>
                        {line ? money(line.revisedBudget, currency) : "—"}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </section>

          <section>
            <h3 className="mb-2 text-label uppercase text-content-subtle">Approval trail</h3>
            <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-2">
              <Entry label="Drafted by" value={actorName(users, row.createdBy)} />
              <Entry label="Drafted at" value={dateTime(row.createdAt)} />
              <Entry label="Requested by" value={actorName(users, row.requestedBy)} />
              <Entry label="Requested at" value={dateTime(row.requestedAt)} />
              <Entry label="Approved by" value={actorName(users, row.approvedBy)} />
              <Entry label="Approved at" value={dateTime(row.approvedAt)} />
              {row.rejectedBy ? (
                <>
                  <Entry label="Rejected by" value={actorName(users, row.rejectedBy)} />
                  <Entry label="Rejected at" value={dateTime(row.rejectedAt)} />
                </>
              ) : null}
            </dl>
            {row.rejectionReason ? (
              <Alert tone="danger" size="sm" className="mt-3" title="Rejection reason">
                {row.rejectionReason}
              </Alert>
            ) : null}
            {row.status === "approved" ? (
              <Alert tone="info" size="sm" className="mt-3" title="This movement is final">
                An approved budget movement cannot be voided — the money has moved. Raise a
                reversing change so both sides stay on the record.
              </Alert>
            ) : null}
          </section>

          <section>
            <h3 className="mb-2 text-label uppercase text-content-subtle">Detail</h3>
            <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-2">
              <Entry label="Effective date" value={isoDate(row.effectiveDate)} />
              <Entry label="Source" value={`${row.sourceType ?? "manual"}${row.sourceId ? ` · ${row.sourceId}` : ""}`} />
            </dl>
            {row.reason ? (
              <p className="mt-2 whitespace-pre-wrap text-body text-content">{row.reason}</p>
            ) : null}
            {row.description ? (
              <p className="mt-2 whitespace-pre-wrap text-body text-content-muted">
                {row.description}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject this movement"
        description="A rejection is recorded with its reason, so a refused transfer is evidence rather than a deleted row."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={rejectReason.trim() === ""}
              loading={busy === "reject"}
              onClick={() =>
                void (async () => {
                  if (!row) return;
                  await act(
                    "reject",
                    () =>
                      api.post(`/api/v1/budget-changes/${row.id}/reject`, {
                        reason: rejectReason.trim(),
                      }),
                    "This movement cannot be rejected",
                  );
                  setRejectOpen(false);
                  setRejectReason("");
                })()
              }
            >
              Reject movement
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            rows={3}
            placeholder="Why this movement should not proceed"
          />
        </Field>
      </Modal>
    </Drawer>
  );
}

function Entry({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-meta text-content-subtle">{label}</dt>
      <dd className="text-body text-content">{value}</dd>
    </div>
  );
}

/* ========================================================================== */
/* Composer                                                                    */
/* ========================================================================== */

function ChangeComposer({
  open,
  budget,
  currency,
  lines,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  budget: BudgetDetail;
  currency: string;
  lines: readonly BudgetLine[];
  existing: BudgetChange | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<BudgetChangeKind>("transfer");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [effective, setEffective] = useState<Date | null>(() => fromIsoDate(today()));
  const [mode, setMode] = useState<"simple" | "legs">("simple");
  const [fromLine, setFromLine] = useState<string | null>(null);
  const [toLine, setToLine] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [legs, setLegs] = useState<DraftLeg[]>(() => [newLeg(), newLeg()]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const packages = useResource<ListResponse<ChangeOrderPackageRef>>(
    (signal) =>
      api.get<ListResponse<ChangeOrderPackageRef>>(
        // Only an EXECUTED prime-contract package can fund an owner change; the
        // list is filtered to exactly what the API will accept.
        `/api/v1/projects/${budget.projectId}/change-order-packages?page=1&pageSize=100&kind=prime_contract&status=executed`,
        { signal },
      ),
    [budget.projectId],
    open && kind === "owner_change",
  );

  useEffect(() => {
    if (!open) return;
    if (existing) {
      setKind(existing.kind);
      setTitle(existing.title);
      setReason(existing.reason ?? "");
      setEffective(fromIsoDate(existing.effectiveDate));
      setSourceId(existing.sourceId);
      const existingLegs = existing.lines.map((leg) => ({
        key: `leg-${leg.lineItemId}`,
        lineItemId: leg.lineItemId,
        amount: leg.amount,
      }));
      if (existingLegs.length === 2) {
        const source = existingLegs.find((leg) => (leg.amount ?? 0) < 0);
        const destination = existingLegs.find((leg) => (leg.amount ?? 0) > 0);
        if (source && destination) {
          setMode("simple");
          setFromLine(source.lineItemId);
          setToLine(destination.lineItemId);
          setAmount(Math.abs(source.amount ?? 0));
          setLegs(existingLegs);
        } else {
          setMode("legs");
          setLegs(existingLegs);
        }
      } else {
        setMode("legs");
        setLegs(existingLegs.length > 0 ? existingLegs : [newLeg(), newLeg()]);
      }
    } else {
      setKind("transfer");
      setTitle("");
      setReason("");
      setEffective(fromIsoDate(today()));
      setMode("simple");
      setFromLine(null);
      setToLine(null);
      setAmount(null);
      setLegs([newLeg(), newLeg()]);
      setSourceId(null);
    }
    setError(null);
    setRefusal(null);
  }, [open, existing]);

  const lineOptions = useMemo(
    () =>
      lines.map((line) => ({
        value: line.id,
        label: `${line.costCode} · ${line.description}`,
        description: `${labelize(line.costType)} · revised ${money(line.revisedBudget, currency)}`,
        keywords: [line.costCode, line.description, line.subJob ?? ""],
      })),
    [lines, currency],
  );

  const lineById = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);

  /** The legs as they will actually be sent, whichever entry mode is in use. */
  const resolvedLegs = useMemo<Array<{ lineItemId: string; amount: number }>>(() => {
    if (mode === "simple") {
      if (!fromLine || !toLine || amount === null || amount <= 0) return [];
      return [
        { lineItemId: fromLine, amount: -Math.abs(amount) },
        { lineItemId: toLine, amount: Math.abs(amount) },
      ];
    }
    return legs
      .filter((leg) => leg.lineItemId !== null && leg.amount !== null && leg.amount !== 0)
      .map((leg) => ({ lineItemId: leg.lineItemId as string, amount: leg.amount as number }));
  }, [mode, fromLine, toLine, amount, legs]);

  const net = round2(resolvedLegs.reduce((sum, leg) => sum + leg.amount, 0));
  const moved = round2(
    resolvedLegs.filter((leg) => leg.amount > 0).reduce((sum, leg) => sum + leg.amount, 0),
  );
  const mustBalance = kind !== "owner_change";
  const duplicateLine =
    new Set(resolvedLegs.map((leg) => leg.lineItemId)).size !== resolvedLegs.length;
  const contingencySources =
    kind !== "contingency_draw"
      ? true
      : resolvedLegs
          .filter((leg) => leg.amount < 0)
          .every((leg) => lineById.get(leg.lineItemId)?.lineKind === "contingency");

  /** Client-side verdict, worded the way the API words its own refusal. */
  const verdict = useMemo<string | null>(() => {
    if (title.trim() === "") return "A budget change needs a title.";
    if (resolvedLegs.length === 0) {
      return "A budget change must move at least one line.";
    }
    if (duplicateLine) {
      return "A line appears on more than one leg — net the movement into a single leg so the audit trail reads unambiguously.";
    }
    if (mustBalance && Math.abs(net) > CENT) {
      return `A ${kind} must balance to zero across its lines — these legs net to ${net.toFixed(
        2,
      )}. Money moved out of one line has to land in another.`;
    }
    if (mustBalance) {
      const hasSource = resolvedLegs.some((leg) => leg.amount < 0);
      const hasDestination = resolvedLegs.some((leg) => leg.amount > 0);
      if (!hasSource || !hasDestination) {
        return `A ${kind} needs at least one source leg (negative) and one destination leg.`;
      }
    }
    if (!mustBalance && Math.abs(net) <= CENT) {
      return "An owner_change must change the budget total; a net-zero movement is a transfer and should be recorded as one.";
    }
    if (kind === "owner_change" && !sourceId) {
      return "An owner_change is the downstream effect of an executed prime contract change order — pick the change order package behind it. Money does not enter a budget without a signed instrument behind it.";
    }
    if (!contingencySources) {
      return "A contingency_draw must source from a line of kind 'contingency'. Record a movement between working lines as a transfer.";
    }
    return null;
  }, [title, resolvedLegs, duplicateLine, mustBalance, net, kind, sourceId, contingencySources]);

  async function submit() {
    if (verdict) {
      setError(verdict);
      return;
    }
    setSaving(true);
    setError(null);
    setRefusal(null);
    try {
      const body: Record<string, unknown> = {
        kind,
        title: title.trim(),
        lines: resolvedLegs,
        effectiveDate: toIsoDate(effective) ?? today(),
      };
      if (reason.trim() !== "") body["reason"] = reason.trim();
      if (kind === "owner_change") {
        body["sourceType"] = "change_order_package";
        body["sourceId"] = sourceId;
      }
      if (existing) {
        await api.patch(`/api/v1/budget-changes/${existing.id}`, body);
      } else {
        await api.post(`/api/v1/budgets/${budget.id}/changes`, body);
      }
      onSaved();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 400 || status === 409) {
        setRefusal(errorMessage(err, "The platform refused this movement."));
      } else {
        setError(errorMessage(err, "The budget change could not be saved"));
      }
    } finally {
      setSaving(false);
    }
  }

  const packageOptions = useMemo(
    () =>
      (packages.data?.items ?? []).map((pkg) => ({
        value: pkg.id,
        label: `${pkg.reference} · ${pkg.title}`,
        description: `${labelize(pkg.status)} PCCO · ${money(pkg.amount, currency)}`,
      })),
    [packages.data, currency],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={existing ? `Edit ${existing.reference}` : "New budget change"}
      description="Legs are the movement. Everything but an owner change must net to zero across them."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={verdict !== null}>
            {existing ? "Save change" : "Create as draft"}
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {refusal ? (
        <div className="mb-3">
          <RefusalNotice
            title="The platform refused this movement"
            message={refusal}
            onDismiss={() => setRefusal(null)}
          />
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" hint={CHANGE_KIND_RULE[kind]}>
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value as BudgetChangeKind)}
          >
            {BUDGET_CHANGE_KINDS.map((option) => (
              <option key={option} value={option}>
                {CHANGE_KIND_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Effective date" hint="A movement cannot be dated into a captured period.">
          <DatePicker value={effective} onChange={setEffective} aria-label="Effective date" />
        </Field>
        <Field label="Title" required className="sm:col-span-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Move contingency to cover concrete overrun"
          />
        </Field>
        {kind === "owner_change" ? (
          <Field
            label="Change order package"
            required
            className="sm:col-span-2"
            hint="An owner change exists only as the downstream effect of an executed prime contract change order."
          >
            <Combobox
              value={sourceId}
              onChange={(next) => setSourceId(next)}
              options={packageOptions}
              placeholder={packages.loading ? "Loading packages…" : "Search executed prime-contract packages…"}
              emptyMessage="No executed prime-contract package on this project. Execute the change order first; a draft or commitment package cannot fund the budget."
            />
          </Field>
        ) : null}
        <Field label="Reason" optional className="sm:col-span-2">
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          size="xs"
          variant={mode === "simple" ? "secondary" : "ghost"}
          onClick={() => setMode("simple")}
        >
          Two-leg transfer
        </Button>
        <Button
          size="xs"
          variant={mode === "legs" ? "secondary" : "ghost"}
          onClick={() => setMode("legs")}
        >
          Multiple legs
        </Button>
      </div>

      {mode === "simple" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="From line" hint="The source. Its budget goes down.">
            <Combobox
              value={fromLine}
              onChange={(next) => setFromLine(next)}
              options={lineOptions}
              placeholder="Search budget lines…"
            />
          </Field>
          <Field label="To line" hint="The destination. Its budget goes up.">
            <Combobox
              value={toLine}
              onChange={(next) => setToLine(next)}
              options={lineOptions}
              placeholder="Search budget lines…"
            />
          </Field>
          <Field label="Amount">
            <MoneyField
              value={amount}
              onChange={setAmount}
              currency={currency}
              aria-label="Amount to move"
            />
          </Field>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {legs.map((leg, index) => (
            <div key={leg.key} className="grid gap-2 sm:grid-cols-[1fr_200px_auto]">
              <Combobox
                value={leg.lineItemId}
                onChange={(next) =>
                  setLegs((previous) =>
                    previous.map((entry) =>
                      entry.key === leg.key ? { ...entry, lineItemId: next } : entry,
                    ),
                  )
                }
                options={lineOptions}
                placeholder={`Budget line ${index + 1}…`}
              />
              <MoneyField
                value={leg.amount}
                onChange={(next) =>
                  setLegs((previous) =>
                    previous.map((entry) =>
                      entry.key === leg.key ? { ...entry, amount: next } : entry,
                    ),
                  )
                }
                currency={currency}
                allowNegative
                aria-label={`Leg ${index + 1} amount`}
              />
              <Button
                variant="ghost"
                iconOnly
                aria-label="Remove leg"
                disabled={legs.length <= 2}
                onClick={() =>
                  setLegs((previous) => previous.filter((entry) => entry.key !== leg.key))
                }
              >
                <IconTrash size={15} />
              </Button>
            </div>
          ))}
          <Button
            size="xs"
            variant="ghost"
            leadingIcon={IconPlus}
            onClick={() => setLegs((previous) => [...previous, newLeg()])}
          >
            Add a leg
          </Button>
          <p className="text-meta text-content-subtle">
            Negative amounts are sources, positive are destinations.
          </p>
        </div>
      )}

      <Card variant="sunken" className="mt-4">
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-label uppercase text-content-subtle">Amount moved</p>
              <p className="text-body font-semibold tabular-nums text-content">
                {money(moved, currency)}
              </p>
            </div>
            <div>
              <p className="text-label uppercase text-content-subtle">Net across the legs</p>
              <p
                className={cx(
                  "text-body font-semibold tabular-nums",
                  mustBalance
                    ? Math.abs(net) <= CENT
                      ? "text-success-fg"
                      : "text-danger-fg"
                    : Math.abs(net) > CENT
                      ? "text-success-fg"
                      : "text-danger-fg",
                )}
              >
                {money(net, currency, { signed: true })}
              </p>
            </div>
            <div className="min-w-48 flex-1">
              {verdict ? (
                <p className="text-meta text-danger-fg">{verdict}</p>
              ) : (
                <p className="text-meta text-success-fg">
                  {mustBalance
                    ? "These legs balance. The movement is legal to raise."
                    : "This owner change moves the budget total, which is what an owner change is for."}
                </p>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      <p className="mt-3 text-meta text-content-subtle">
        Created as a draft. It holds no exposure until it is submitted, and it moves nothing until
        somebody other than its author approves it.
      </p>
    </Modal>
  );
}

/** Kept for the leg shape the API returns, so the composer and drawer agree. */
export type { ChangeLeg };
