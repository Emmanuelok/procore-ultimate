/**
 * THE SCHEDULE OF VALUES, and the identity it has to satisfy.
 *
 * The API's rule is that the schedule IS the commitment sum — `Σ
 * revisedScheduledValue = commitment.revisedCommitmentSum`, asserted on every
 * read and re-derived on every write. So this panel does three things:
 *
 *  1. States the identity, both sides of it, and whether it reconciles. When
 *     it does not, the discrepancy is named with its direction and size.
 *  2. Validates the same identity CLIENT-SIDE while the sheet is being edited,
 *     so a schedule that would not balance is caught before it is sent.
 *  3. Renders the server's refusal VERBATIM when a write is rejected anyway —
 *     "This commitment is approved. Its schedule of values is fixed — the
 *     commitment sum moves only through change orders from here." is a
 *     sentence a user can act on; "Invalid request" is not.
 *
 * After approval the money columns are frozen by the API. The grid reflects
 * that: `scheduledValue`, `quantity`, `unitRate` and `retainagePercent` stop
 * being editable, and the panel says why rather than letting someone type into
 * a cell whose value will be refused.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Modal,
  Spinner,
  Textarea,
} from "../../ui";
import { DataTable, type DataCellChange, type DataColumns } from "../../ui/data";
import { parseSovCsv } from "./CreateCommitmentModal";
import { RefusalPanel, money, titleCase, useAction, type Loadable } from "./shared";
import type { BuyoutRow, Commitment, SovLine, SovResponse } from "./types";

const CENT = 0.005;

export default function SovPanel({
  commitment,
  sov,
  buyoutRows,
  onChanged,
}: {
  commitment: Commitment;
  sov: Loadable<SovResponse>;
  buyoutRows: BuyoutRow[];
  onChanged: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [pending, setPending] = useState<Map<string, Partial<SovLine>>>(new Map());
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState(false);

  /* A fresh load discards any drafted edit — the sheet on screen must be the
     sheet the server holds, never a stale overlay of the two. */
  useEffect(() => {
    setPending(new Map());
  }, [sov.data]);

  const frozen = commitment.status === "approved" || commitment.status === "complete";
  const dead = commitment.status === "void" || commitment.status === "terminated";
  const lines = sov.data?.lines ?? [];
  const currency = sov.data?.currency ?? commitment.currency;

  /** The client-side identity, computed over the drafted sheet. */
  const draftTotal = useMemo(() => {
    let total = 0;
    for (const line of lines) {
      const patch = pending.get(line.id);
      const scheduled = patch?.scheduledValue ?? line.scheduledValue;
      total += scheduled + line.changeOrderValue;
    }
    return Number(total.toFixed(2));
  }, [lines, pending]);

  const identity = sov.data?.identity ?? null;
  const dirty = pending.size > 0;
  const draftDelta = identity ? Number((draftTotal - identity.commitmentSum).toFixed(2)) : 0;

  const budgetByLine = useMemo(() => {
    const map = new Map<string, BuyoutRow>();
    for (const row of buyoutRows) map.set(row.budgetLineItemId, row);
    return map;
  }, [buyoutRows]);

  const columns = useMemo<DataColumns<SovLine>>(
    () => [
      {
        id: "lineNumber",
        header: "#",
        accessor: "lineNumber",
        type: "code",
        width: 92,
        sticky: "start",
        mono: true,
        cell: ({ row }) => (
          <span className="flex items-center gap-1">
            <span className="font-mono">{row.lineNumber}</span>
            {row.isChangeOrderLine === 1 ? (
              <Badge tone="info" size="xs" variant="outline">
                CO
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "description",
        header: "Description",
        accessor: "description",
        type: "text",
        width: 300,
        editable: !frozen && !dead,
      },
      {
        id: "costCode",
        header: "Cost code",
        accessor: (row) => row.costCode ?? "",
        type: "code",
        width: 120,
        mono: true,
      },
      {
        id: "costType",
        header: "Cost type",
        accessor: (row) => titleCase(row.costType),
        type: "text",
        width: 120,
        defaultHidden: true,
      },
      {
        id: "budget",
        header: "Budget line",
        headerTooltip:
          "The budget line this commitment consumes. Committed cost on the budget is re-derived from these bindings on every consequential write.",
        accessor: (row) =>
          row.budgetLineItemId
            ? (budgetByLine.get(row.budgetLineItemId)?.costCode ?? row.budgetLineItemId)
            : "",
        type: "text",
        width: 210,
        truncate: false,
        cell: ({ row }) => {
          if (!row.budgetLineItemId) {
            return (
              <span className="text-2xs italic text-content-subtle">
                not bound to a budget line — this value will not appear in the buyout log
              </span>
            );
          }
          const budget = budgetByLine.get(row.budgetLineItemId);
          if (!budget) {
            return (
              <span className="text-2xs text-content-muted">
                <span className="font-mono">{row.budgetLineItemId}</span>
                <span className="block italic text-content-subtle">
                  not on the active budget, so no budget figure can be shown against it
                </span>
              </span>
            );
          }
          return (
            <span className="text-2xs">
              <span className="font-mono">{budget.costCode}</span> {budget.description}
              <span className="block text-content-subtle">
                budget {money(budget.revisedBudget, budget.currency)} · committed{" "}
                {money(budget.committed, budget.currency)}
              </span>
            </span>
          );
        },
      },
      {
        id: "scheduledValue",
        header: "Scheduled value",
        headerTooltip: frozen
          ? "Frozen: this commitment is approved, so the sum moves only through change orders."
          : "The original contract figure. Σ of this column plus the change-order column is the commitment sum.",
        accessor: "scheduledValue",
        type: "currency",
        currency,
        precision: 2,
        align: "right",
        width: 150,
        mono: true,
        aggregate: "sum",
        editable: !frozen && !dead,
        editor: { kind: "number", step: 0.01 },
        parse: (raw) => {
          const n = Number(raw.replace(/[^0-9.eE+-]/g, ""));
          return Number.isFinite(n) ? n : null;
        },
        validate: (value) =>
          typeof value === "number" && Number.isFinite(value)
            ? null
            : "A scheduled value must be a number.",
      },
      {
        id: "changeOrderValue",
        header: "Change orders",
        accessor: "changeOrderValue",
        type: "currency",
        currency,
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        signColor: true,
        aggregate: "sum",
      },
      {
        id: "revisedScheduledValue",
        header: "Revised value",
        accessor: "revisedScheduledValue",
        type: "currency",
        currency,
        precision: 2,
        align: "right",
        width: 150,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "totalCompletedAndStored",
        header: "Billed to date",
        accessor: "totalCompletedAndStored",
        type: "currency",
        currency,
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "percentComplete",
        header: "% complete",
        accessor: "percentComplete",
        type: "percent",
        align: "right",
        width: 120,
        progress: true,
        aggregate: "none",
      },
      {
        id: "balanceToFinish",
        header: "Balance to finish",
        accessor: "balanceToFinish",
        type: "currency",
        currency,
        precision: 2,
        align: "right",
        width: 150,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "retainagePercent",
        header: "Retainage %",
        accessor: "retainagePercent",
        type: "percent",
        align: "right",
        width: 120,
        editable: !frozen && !dead,
        editor: { kind: "number", min: 0, max: 100, step: 0.01 },
        parse: (raw) => {
          const n = Number(raw.replace(/[^0-9.eE+-]/g, ""));
          return Number.isFinite(n) ? n : null;
        },
        validate: (value) =>
          typeof value === "number" && value >= 0 && value <= 100
            ? null
            : "Retainage is a percentage between 0 and 100.",
      },
      {
        id: "retainageHeld",
        header: "Retainage held",
        accessor: "retainageHeld",
        type: "currency",
        currency,
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        aggregate: "sum",
      },
    ],
    [currency, frozen, dead, budgetByLine],
  );

  async function commitEdits(changes: ReadonlyArray<DataCellChange<SovLine>>) {
    const byRow = new Map<string, Record<string, unknown>>();
    for (const change of changes) {
      const patch = byRow.get(change.rowId) ?? {};
      patch[change.columnId] = change.value;
      byRow.set(change.rowId, patch);
    }
    for (const [lineId, patch] of byRow) {
      const ok = await run(`line:${lineId}`, () =>
        api.patch(`/api/v1/commitment-sov-lines/${lineId}`, patch),
      );
      if (ok === null) {
        /*
         * The grid drops its own buffer once the commit handler returns, so the
         * drafted identity has to be dropped with it — otherwise the card would
         * go on claiming "including edits not yet saved" for edits the server
         * has just refused and the grid has already discarded.
         */
        setPending(new Map());
        sov.reload();
        return;
      }
    }
    setPending(new Map());
    onChanged();
    sov.reload();
  }

  async function deleteLine(row: SovLine) {
    const ok = await run(`delete:${row.id}`, () =>
      api.del(`/api/v1/commitment-sov-lines/${row.id}`),
    );
    if (ok !== null) {
      sov.reload();
      onChanged();
    }
  }

  if (sov.loading && !sov.data) {
    return (
      <div className="py-10">
        <Spinner label="Loading the schedule of values…" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <RefusalPanel refusal={refusal} onDismiss={clear} title="This edit was refused" />

      {identity ? (
        <IdentityCard
          statement={identity.statement}
          sovTotal={dirty ? draftTotal : identity.sovTotal}
          commitmentSum={identity.commitmentSum}
          reconciles={dirty ? Math.abs(draftDelta) <= CENT : identity.reconciles}
          currency={currency}
          drafted={dirty}
        />
      ) : null}

      {frozen ? (
        <Alert tone="info" size="sm" title={`This commitment is ${commitment.status}`}>
          Its schedule of values is fixed. Scheduled value, quantity, unit rate and retainage are
          not editable here because the API refuses them — the commitment sum moves only through
          change orders once it is approved. Description, cost coding and the budget binding remain
          editable.
        </Alert>
      ) : null}
      {dead ? (
        <Alert tone="danger" size="sm" title={`This commitment is ${commitment.status}`}>
          Nothing on this schedule can be edited.
        </Alert>
      ) : null}

      {!frozen && !dead ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Add a line
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
            Replace from a spreadsheet…
          </Button>
        </div>
      ) : null}

      <DataTable<SovLine>
        tableId={`commitment-sov:${frozen ? "frozen" : "open"}`}
        data={lines}
        columns={columns}
        getRowId={(row) => row.id}
        loading={sov.loading}
        height={440}
        stickyHeader
        showFooter
        stickyFooter
        gridLines
        editable={!dead}
        bufferEdits
        onCommitEdits={commitEdits}
        /* Only a scheduled-value edit can move the identity, so only that one
           is mirrored into the drafted total. */
        onCellEdit={(change) => {
          if (change.columnId !== "scheduledValue" || typeof change.value !== "number") return;
          const value = change.value;
          setPending((prev) => {
            const next = new Map(prev);
            next.set(change.rowId, {
              ...(next.get(change.rowId) ?? {}),
              scheduledValue: value,
            });
            return next;
          });
        }}
        savedViews={false}
        exportFileName={`sov-${commitment.reference}`}
        rowActions={
          frozen || dead
            ? undefined
            : (row) => [
                {
                  id: "delete",
                  label: "Delete this line",
                  destructive: true,
                  disabled: row.totalCompletedAndStored !== 0 || row.isChangeOrderLine === 1,
                  onSelect: () => {
                    if (
                      !window.confirm(
                        `Delete line ${row.lineNumber}? The commitment sum falls by ${money(row.revisedScheduledValue, currency)}.`,
                      )
                    ) {
                      return;
                    }
                    void deleteLine(row);
                  },
                },
              ]
        }
        empty={{
          title: "This commitment has no schedule of values",
          description:
            "The commitment sum is the sum of its schedule, so an empty schedule is a sum of zero that nobody meant. The API refuses to approve one.",
        }}
        aria-label={`Schedule of values for ${commitment.reference}`}
      />

      {busy ? <p className="text-meta text-content-subtle">Saving {busy}…</p> : null}

      <AddLine
        open={adding}
        commitment={commitment}
        currency={currency}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          sov.reload();
          onChanged();
        }}
      />

      <ReplaceSchedule
        open={replacing}
        commitment={commitment}
        currency={currency}
        lineCount={lines.length}
        onClose={() => setReplacing(false)}
        onReplaced={() => {
          setReplacing(false);
          sov.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/** One more line on an editable schedule. The sum moves with it, by design. */
function AddLine({
  open,
  commitment,
  currency,
  onClose,
  onAdded,
}: {
  open: boolean;
  commitment: Commitment;
  currency: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [lineNumber, setLineNumber] = useState("");
  const [description, setDescription] = useState("");
  const [costCode, setCostCode] = useState("");
  const [scheduledValue, setScheduledValue] = useState("");

  const amount = Number(scheduledValue);
  const valid = description.trim().length > 0 && Number.isFinite(amount);

  async function submit() {
    const ok = await run("add", () =>
      api.post(`/api/v1/commitments/${commitment.id}/sov-lines`, {
        ...(lineNumber.trim() ? { lineNumber: lineNumber.trim() } : {}),
        description: description.trim(),
        ...(costCode.trim() ? { costCode: costCode.trim() } : {}),
        scheduledValue: amount,
      }),
    );
    if (ok !== null) {
      setLineNumber("");
      setDescription("");
      setCostCode("");
      setScheduledValue("");
      onAdded();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add a line to ${commitment.reference}`}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || busy !== null} onClick={() => void submit()}>
            Add the line
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} title="This line was refused" />
        <p className="text-meta text-content-subtle">
          The schedule IS the commitment sum, so adding{" "}
          {money(Number.isFinite(amount) ? amount : 0, currency)} here raises the sum by exactly
          that.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Line number" hint="Left blank, the next number is allocated.">
            <Input value={lineNumber} onChange={(e) => setLineNumber(e.target.value)} />
          </Field>
          <Field label="Cost code">
            <Input value={costCode} onChange={(e) => setCostCode(e.target.value)} />
          </Field>
        </div>
        <Field label="Description" required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={`Scheduled value (${currency})`} required>
          <Input
            value={scheduledValue}
            inputMode="decimal"
            onChange={(e) => setScheduledValue(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * A schedule of values arrives as a spreadsheet. Pasting it replaces the whole
 * schedule in one call — which the API refuses once anything has been billed,
 * so the refusal is shown verbatim rather than pre-empted.
 */
function ReplaceSchedule({
  open,
  commitment,
  currency,
  lineCount,
  onClose,
  onReplaced,
}: {
  open: boolean;
  commitment: Commitment;
  currency: string;
  lineCount: number;
  onClose: () => void;
  onReplaced: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [csv, setCsv] = useState("");
  const parsed = useMemo(
    () => parseSovCsv(csv, commitment.defaultRetainagePercent ?? 0),
    [csv, commitment.defaultRetainagePercent],
  );
  const total = parsed.lines.reduce((s, l) => s + l.scheduledValue, 0);

  async function submit() {
    const ok = await run("replace", () =>
      api.put(`/api/v1/commitments/${commitment.id}/sov`, {
        lines: parsed.lines,
      }),
    );
    if (ok !== null) {
      setCsv("");
      onReplaced();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Replace the schedule of values on ${commitment.reference}`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={parsed.lines.length === 0 || busy !== null}
            onClick={() => void submit()}
          >
            Replace {lineCount} line{lineCount === 1 ? "" : "s"} with {parsed.lines.length}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} title="The replacement was refused" />
        <Alert tone="warning" size="sm" title="This replaces every line">
          Every existing line is deleted and the pasted schedule is inserted, in one transaction.
          The API refuses it once any line has been billed against, or once a change order has
          appended a line.
        </Alert>
        <Field
          label="Paste the schedule"
          hint="One line per row: line, description, cost code, amount — or just description and amount. Comma or tab separated."
        >
          <Textarea rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} />
        </Field>
        {parsed.problems.length > 0 ? (
          <Alert
            tone="danger"
            size="sm"
            title={`${parsed.problems.length} row(s) could not be read`}
          >
            <ul className="list-disc pl-4">
              {parsed.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {parsed.lines.length > 0 ? (
          <p className="text-meta text-content-muted">
            {parsed.lines.length} line{parsed.lines.length === 1 ? "" : "s"} totalling{" "}
            <span className="font-mono tabular-nums">{money(total, currency)}</span> — that becomes
            the commitment sum.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * The identity, printed as arithmetic rather than as a tick. When it fails the
 * discrepancy is named — its size, its direction, and which side is which.
 */
export function IdentityCard({
  statement,
  sovTotal,
  commitmentSum,
  reconciles,
  currency,
  drafted,
}: {
  statement: string;
  sovTotal: number;
  commitmentSum: number;
  reconciles: boolean;
  currency: string;
  drafted?: boolean;
}) {
  const delta = Number((sovTotal - commitmentSum).toFixed(2));
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <code className="font-mono text-meta text-content-muted">{statement}</code>
          <Badge tone={reconciles ? "success" : "danger"} dot size="xs">
            {reconciles ? "Reconciles" : "Does not reconcile"}
          </Badge>
        </div>
        <div className="grid gap-2 text-meta sm:grid-cols-3">
          <figure>
            <figcaption className="text-content-subtle">Σ schedule of values</figcaption>
            <span className="font-mono text-base font-semibold tabular-nums">
              {money(sovTotal, currency)}
            </span>
            {drafted ? (
              <span className="block text-2xs text-content-subtle">
                including edits not yet saved
              </span>
            ) : null}
          </figure>
          <figure>
            <figcaption className="text-content-subtle">Commitment sum</figcaption>
            <span className="font-mono text-base font-semibold tabular-nums">
              {money(commitmentSum, currency)}
            </span>
          </figure>
          <figure>
            <figcaption className="text-content-subtle">Discrepancy</figcaption>
            <span
              className={
                "font-mono text-base font-semibold tabular-nums " +
                (reconciles ? "text-content" : "text-danger-fg")
              }
            >
              {money(delta, currency)}
            </span>
            {!reconciles ? (
              <span className="block text-2xs">
                The schedule {delta > 0 ? "over-states" : "under-states"} the commitment sum by{" "}
                {money(Math.abs(delta), currency)}.
              </span>
            ) : null}
          </figure>
        </div>
      </CardBody>
    </Card>
  );
}
