/**
 * THE SCHEDULE OF VALUES — the AIA G703 continuation sheet.
 *
 * Columns are the form's columns, in the form's order: scheduled value,
 * previously billed, this period, stored materials, total completed and stored
 * to date, percent complete, balance to finish, retainage.
 *
 * WHAT IS EDITABLE, AND WHY THE REST IS NOT
 *
 * Description, cost coding, billing method, unit and retainage percent are
 * edited inline — none of them touches the identity `Σ SOV = contract sum`, so
 * the API takes them freely.
 *
 * SCHEDULED VALUE IS DIFFERENT. Moving value on one line has to take it from
 * another, or the sheet stops totalling the contract sum, and the API refuses
 * exactly that. So it is not an inline cell: it is a two-sided move that names
 * the line the value comes out of, with the resulting total checked here
 * before it is sent and the server's own refusal printed if it is refused
 * anyway. After execution the value moves only through an executed change
 * order, and the sheet says so instead of offering an editor that cannot work.
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
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { DataTable, type DataCellChange, type DataColumns } from "../../ui/data";
import {
  ComponentValue,
  RefusalPanel,
  SovIdentityCard,
  money,
  pct,
  titleCase,
  useAction,
  useCostCodes,
  type Loadable,
} from "./shared";
import type { ContractView, CostCodeRef, SovView, SovViewLine } from "./types";

const CENT = 0.005;

export default function SovTab({
  contract,
  sov,
  onChanged,
}: {
  contract: ContractView;
  sov: Loadable<SovView>;
  onChanged: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [moving, setMoving] = useState<SovViewLine | null>(null);
  const [building, setBuilding] = useState(false);
  const [addingLine, setAddingLine] = useState(false);
  const [deleting, setDeleting] = useState<SovViewLine | null>(null);
  const codes = useCostCodes(contract.projectId);

  const cur = contract.currency;
  const view = sov.data;
  const lines = view?.lines ?? [];
  const executed = contract.executed === 1;
  const billed = lines.some((l) => l.totalCompletedAndStored > 0.005 || l.previousBilled > 0.005);

  const columns = useMemo<DataColumns<SovViewLine>>(
    () => [
      {
        id: "lineNumber",
        header: "Item",
        group: "A",
        accessor: "lineNumber",
        type: "code",
        width: 96,
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
        header: "Description of work",
        group: "B",
        accessor: "description",
        type: "text",
        width: 280,
        editable: contract.status !== "void" && contract.status !== "terminated",
      },
      {
        id: "costCode",
        header: "Cost code",
        headerTooltip: "Bound to the project's cost-code list: the picker sends the code AND its id, so the budget mapping follows the label.",
        accessor: (row) => row.costCode ?? "",
        type: "code",
        width: 150,
        mono: true,
        cell: ({ row }) => (
          <select
            className="h-control-xs w-full rounded border border-border bg-surface px-1 font-mono text-xs"
            value={row.costCodeId ?? ""}
            disabled={contract.status === "void" || contract.status === "terminated"}
            aria-label={`Cost code for line ${row.lineNumber}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const code = (codes.data?.items ?? []).find((c) => c.id === e.target.value) ?? null;
              void run(`code:${row.id}`, () =>
                api.patch(`/api/v1/prime-contracts/${contract.id}/sov/lines/${row.id}`, {
                  costCodeId: code?.id ?? null,
                  costCode: code?.code ?? null,
                  ...(code?.costType ? { costType: code.costType } : {}),
                }),
              ).then((ok) => {
                if (ok !== null) {
                  sov.reload();
                  onChanged();
                }
              });
            }}
          >
            <option value="">{row.costCode ? `${row.costCode} (unbound)` : "—"}</option>
            {(codes.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.title}
              </option>
            ))}
          </select>
        ),
      },
      {
        id: "billingMethod",
        header: "Billing method",
        accessor: (row) => titleCase(row.billingMethod),
        type: "text",
        width: 150,
        defaultHidden: true,
      },
      {
        id: "scheduledValue",
        header: "Scheduled value",
        group: "C",
        headerTooltip: executed
          ? "Frozen: this contract is executed, so a line's value moves only through an executed change order."
          : "Base scope. Moving value here must take it from another line — use the Move value action.",
        accessor: "revisedScheduledValue",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 160,
        mono: true,
        aggregate: "sum",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {money(row.revisedScheduledValue, cur)}
            {row.changeOrderValue !== 0 ? (
              <span className="block text-2xs text-content-subtle">
                {money(row.scheduledValue, cur)} base {row.changeOrderValue > 0 ? "+" : "−"}{" "}
                {money(Math.abs(row.changeOrderValue), cur)} CO
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "previousBilled",
        header: "From previous application",
        group: "D",
        headerTooltip: "Column D — work completed on all prior certified applications.",
        accessor: "previousBilled",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 170,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "thisPeriodWork",
        header: "This period",
        group: "E",
        accessor: "thisPeriodWork",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "materialsPresentlyStored",
        header: "Materials presently stored",
        group: "F",
        headerTooltip: "Column F — on site, not yet incorporated into the work.",
        accessor: "materialsPresentlyStored",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 180,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "totalCompletedAndStored",
        header: "Total completed and stored to date",
        group: "G",
        headerTooltip: "Column G = D + E + F.",
        accessor: "totalCompletedAndStored",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 210,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "percentComplete",
        header: "%",
        group: "G ÷ C",
        headerTooltip:
          "G ÷ C. A line with a zero scheduled value has no percent complete — the API returns null with a reason rather than a fabricated 0.",
        accessor: (row) => row.percentComplete.value,
        type: "custom",
        align: "right",
        width: 130,
        truncate: false,
        cell: ({ row }) => (
          <ComponentValue
            component={row.percentComplete}
            render={(v) => <span className="font-mono tabular-nums">{pct(v, 1)}</span>}
            className="block text-right"
          />
        ),
        toCsv: ({ row }) =>
          row.percentComplete.value === null
            ? row.percentComplete.reasons.join(" ")
            : row.percentComplete.value,
      },
      {
        id: "balanceToFinish",
        header: "Balance to finish",
        group: "H",
        headerTooltip: "Column H = C − G.",
        accessor: "balanceToFinish",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 160,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "retainagePercent",
        header: "Retainage %",
        group: "I",
        accessor: "retainagePercent",
        type: "percent",
        align: "right",
        width: 120,
        editable: !executed,
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
        group: "I",
        accessor: "retainageHeld",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 150,
        mono: true,
        aggregate: "sum",
      },
      {
        id: "move",
        header: "",
        width: 190,
        sortable: false,
        interactive: true,
        exportable: false,
        cell: ({ row }) =>
          executed || row.isChangeOrderLine === 1 ? (
            <span className="text-2xs text-content-subtle">—</span>
          ) : (
            <span className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => setMoving(row)}>
                Move value
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDeleting(row)} disabled={row.totalCompletedAndStored > 0.005}>
                Delete
              </Button>
            </span>
          ),
      },
    ],
    [cur, executed, contract.status, codes.data, contract.id, run, sov, onChanged],
  );

  async function commitEdits(changes: ReadonlyArray<DataCellChange<SovViewLine>>) {
    const byRow = new Map<string, Record<string, unknown>>();
    for (const change of changes) {
      const patch = byRow.get(change.rowId) ?? {};
      patch[change.columnId] = change.value;
      byRow.set(change.rowId, patch);
    }
    for (const [lineId, patch] of byRow) {
      const ok = await run(`line:${lineId}`, () =>
        api.patch(`/api/v1/prime-contracts/${contract.id}/sov/lines/${lineId}`, patch),
      );
      if (ok === null) {
        /* The grid has already dropped its buffer, so pull the server's own
           values back rather than leaving a refused edit on screen. */
        sov.reload();
        return;
      }
    }
    sov.reload();
    onChanged();
  }

  if (sov.loading && !view) {
    return (
      <div className="py-12">
        <Spinner label="Loading the schedule of values…" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <RefusalPanel refusal={refusal} onDismiss={clear} />

      {view ? (
        <SovIdentityCard
          sovTotal={view.identity.sovTotal}
          contractSum={view.identity.contractSum}
          currency={view.currency}
          ok={view.identity.ok}
          message={view.identity.message}
          legs={view.identity.legs}
        />
      ) : null}

      {executed ? (
        <Alert tone="info" size="sm" title="This contract is executed">
          A signed schedule of values is part of the agreement. Line values move only through an
          executed change order, which APPENDS lines rather than editing these — that is what keeps
          the continuation sheet reconciling back to the contract both parties signed.
        </Alert>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setBuilding(true)} disabled={billed}>
            {lines.length === 0 ? "Build the schedule of values" : "Replace the whole sheet"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAddingLine(true)}>
            Add a line
          </Button>
          <span className="text-2xs text-content-subtle">
            {billed
              ? "A billed sheet cannot be replaced wholesale; add or move lines instead."
              : "The sheet is written in one transaction and must total the contract sum — or, before execution, may define it."}
          </span>
        </div>
      )}

      {view ? (
        <Card>
          <CardBody className="grid gap-4 sm:grid-cols-4">
            <Split label="Lines" value={String(view.totals.lineCount)} />
            <Split label="Base scope" value={money(view.totals.baseScope, view.currency)} />
            <Split
              label="Change-order scope"
              value={money(view.totals.changeOrderScope, view.currency)}
              hint="Appended by executed change orders."
            />
            <Split
              label="Σ revised scheduled value"
              value={money(view.totals.revisedScheduledValue, view.currency)}
              strong
            />
          </CardBody>
        </Card>
      ) : null}

      <DataTable<SovViewLine>
        tableId="prime-sov"
        data={lines}
        columns={columns}
        getRowId={(row) => row.id}
        loading={sov.loading}
        height={560}
        stickyHeader
        showFooter
        stickyFooter
        gridLines
        editable
        bufferEdits
        onCommitEdits={commitEdits}
        savedViews
        exportFileName={`g703-${contract.reference}`}
        defaultSort={[{ id: "lineNumber", desc: false }]}
        empty={{
          title: "This contract has no schedule of values",
          description:
            "A prime contract cannot be executed or billed against without one — the API refuses both, because there is nothing to bill against and nothing for a G703 to total. Build it above: paste lines, or add them one by one.",
        }}
        aria-label={`Schedule of values for ${contract.reference}`}
      />

      {busy ? <p className="text-meta text-content-subtle">Saving {busy}…</p> : null}

      <MoveValue
        open={moving !== null}
        line={moving}
        lines={lines}
        contract={contract}
        onClose={() => setMoving(null)}
        onMoved={() => {
          setMoving(null);
          sov.reload();
          onChanged();
        }}
      />
      <BuildSheet
        open={building}
        contract={contract}
        existing={lines}
        codes={codes.data?.items ?? []}
        onClose={() => setBuilding(false)}
        onBuilt={() => {
          setBuilding(false);
          sov.reload();
          onChanged();
        }}
      />
      <AddLine
        open={addingLine}
        contract={contract}
        lines={lines}
        codes={codes.data?.items ?? []}
        onClose={() => setAddingLine(false)}
        onAdded={() => {
          setAddingLine(false);
          sov.reload();
          onChanged();
        }}
      />
      <DeleteLine
        line={deleting}
        lines={lines}
        contract={contract}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          sov.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* Building the sheet                                                  */
/* ================================================================== */

interface DraftSovLine {
  lineNumber: string;
  description: string;
  scheduledValue: string;
  costCodeId: string;
  retainagePercent: string;
}

/** "01, Concrete, 400000, 03-100" per line — the paste format. */
function parsePasted(text: string): DraftSovLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      const cells = l.split(/\t|,/).map((c) => c.trim());
      return {
        lineNumber: cells[0] ?? "",
        description: cells[1] ?? "",
        scheduledValue: (cells[2] ?? "").replace(/[^0-9.\-]/g, ""),
        costCodeId: "",
        retainagePercent: "",
      };
    });
}

/**
 * The whole base-scope sheet in one PUT. Before execution the sheet may
 * DEFINE the contract sum (bottom-up); otherwise it must total the sum the
 * contract already carries, and the running total is checked here before
 * the API checks it again.
 */
function BuildSheet({
  open,
  contract,
  existing,
  codes,
  onClose,
  onBuilt,
}: {
  open: boolean;
  contract: ContractView;
  existing: readonly SovViewLine[];
  codes: readonly CostCodeRef[];
  onClose: () => void;
  onBuilt: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [rows, setRows] = useState<DraftSovLine[]>([]);
  const [paste, setPaste] = useState("");
  const [syncContractSum, setSync] = useState(false);
  const cur = contract.currency;

  useEffect(() => {
    if (!open) return;
    const base = existing.filter((l) => l.isChangeOrderLine !== 1);
    setRows(
      base.length > 0
        ? base.map((l) => ({ lineNumber: l.lineNumber, description: l.description, scheduledValue: String(l.scheduledValue), costCodeId: l.costCodeId ?? "", retainagePercent: String(l.retainagePercent) }))
        : [{ lineNumber: "01", description: "", scheduledValue: "", costCodeId: "", retainagePercent: "" }],
    );
    setPaste("");
    setSync(contract.originalContractSum === 0);
  }, [open, existing, contract.originalContractSum]);

  const total = rows.reduce((s, r) => s + (Number(r.scheduledValue) || 0), 0);
  const coScope = existing.filter((l) => l.isChangeOrderLine === 1).reduce((s, l) => s + l.scheduledValue + l.changeOrderValue, 0);
  const target = contract.originalContractSum + contract.approvedChangeSum;
  const projected = Number((total + coScope).toFixed(2));
  const balances = syncContractSum || Math.abs(projected - target) <= 0.005;
  const problems: string[] = [];
  const numbers = new Set<string>();
  rows.forEach((r, i) => {
    if (r.lineNumber.trim() === "") problems.push(`Row ${i + 1} needs a line number.`);
    else if (numbers.has(r.lineNumber.trim())) problems.push(`Line number "${r.lineNumber}" appears twice.`);
    numbers.add(r.lineNumber.trim());
    if (r.description.trim() === "") problems.push(`Row ${i + 1} needs a description.`);
    if (!Number.isFinite(Number(r.scheduledValue)) || r.scheduledValue.trim() === "") problems.push(`Row ${i + 1} needs a numeric scheduled value.`);
  });
  if (!balances) problems.push(`The sheet totals ${money(projected, cur)} against a contract sum of ${money(target, cur)}. Tick "let the sheet define the sum" or fix the values.`);

  function update(i: number, patch: Partial<DraftSovLine>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    const done = await run("build", () =>
      api.put(`/api/v1/prime-contracts/${contract.id}/sov`, {
        syncContractSum,
        lines: rows.map((r, i) => {
          const code = codes.find((c) => c.id === r.costCodeId) ?? null;
          return {
            lineNumber: r.lineNumber.trim(),
            description: r.description.trim(),
            scheduledValue: Number(r.scheduledValue),
            sortOrder: i,
            ...(code ? { costCodeId: code.id, costCode: code.code, ...(code.costType ? { costType: code.costType } : {}) } : {}),
            ...(r.retainagePercent.trim() !== "" ? { retainagePercent: Number(r.retainagePercent) } : {}),
          };
        }),
      }),
    );
    if (done !== null) onBuilt();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={existing.length > 0 ? "Replace the schedule of values" : "Build the schedule of values"}
      description="Base scope only — change-order lines belong to their change orders and are left untouched. Written in one transaction; the API refuses a sheet that does not total the contract sum."
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={problems.length > 0 || rows.length === 0 || busy !== null}>
            Write {rows.length} line{rows.length === 1 ? "" : "s"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <Field label="Paste lines" optional hint="One per line: number, description, scheduled value — comma or tab separated. Replaces the rows below.">
          <Textarea
            rows={3}
            value={paste}
            placeholder={"01, General conditions, 100000\n02, Sitework, 250000"}
            onChange={(e) => setPaste(e.target.value)}
            onBlur={() => {
              if (paste.trim() !== "") setRows(parsePasted(paste));
            }}
          />
        </Field>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[80px_1fr_150px_180px_90px_auto]">
              <Input value={r.lineNumber} placeholder="01" onChange={(e) => update(i, { lineNumber: e.target.value })} aria-label="Line number" className="font-mono" />
              <Input value={r.description} placeholder="Description of work" onChange={(e) => update(i, { description: e.target.value })} aria-label="Description" />
              <Input value={r.scheduledValue} inputMode="decimal" placeholder="Scheduled value" onChange={(e) => update(i, { scheduledValue: e.target.value })} aria-label="Scheduled value" />
              <Select value={r.costCodeId} onChange={(e) => update(i, { costCodeId: e.target.value })} aria-label="Cost code">
                <option value="">No cost code</option>
                {codes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.title}
                  </option>
                ))}
              </Select>
              <Input value={r.retainagePercent} inputMode="decimal" placeholder={`${contract.defaultRetainagePercent}%`} onChange={(e) => update(i, { retainagePercent: e.target.value })} aria-label="Retainage percent" />
              <Button size="sm" variant="ghost" onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <Button size="xs" variant="ghost" onClick={() => setRows((prev) => [...prev, { lineNumber: String(prev.length + 1).padStart(2, "0"), description: "", scheduledValue: "", costCodeId: "", retainagePercent: "" }])}>
            Add a row
          </Button>
        </div>
        <Card>
          <CardBody className="space-y-1 text-meta">
            <div className="flex justify-between">
              <span className="text-content-subtle">Σ base scope</span>
              <span className="font-mono tabular-nums">{money(total, cur)}</span>
            </div>
            {coScope !== 0 ? (
              <div className="flex justify-between">
                <span className="text-content-subtle">+ change-order scope (untouched)</span>
                <span className="font-mono tabular-nums">{money(coScope, cur)}</span>
              </div>
            ) : null}
            <div className="flex justify-between">
              <span className="text-content-subtle">Contract sum</span>
              <span className="font-mono tabular-nums">{money(target, cur)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Identity</span>
              <Badge tone={balances ? "success" : "danger"} size="xs" dot>
                {syncContractSum ? "the sheet defines the sum" : balances ? "balances" : "does not balance"}
              </Badge>
            </div>
          </CardBody>
        </Card>
        <label className="flex items-center gap-2 text-meta">
          <input type="checkbox" checked={syncContractSum} onChange={(e) => setSync(e.target.checked)} />
          Let the sheet define the contract sum (bottom-up; only before execution)
        </label>
        {problems.length > 0 ? (
          <Alert tone="warning" size="sm" title="This sheet will not be accepted">
            <ul className="list-disc pl-4">
              {[...new Set(problems)].slice(0, 8).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

/** One new line. Either it fills scope already in the sum, or it raises the sum by exactly its value. */
function AddLine({
  open,
  contract,
  lines,
  codes,
  onClose,
  onAdded,
}: {
  open: boolean;
  contract: ContractView;
  lines: readonly SovViewLine[];
  codes: readonly CostCodeRef[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [lineNumber, setLineNumber] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [costCodeId, setCostCodeId] = useState("");
  const [raise, setRaise] = useState(true);
  const cur = contract.currency;
  const amount = Number(value);
  const sovTotal = lines.reduce((s, l) => s + l.scheduledValue + l.changeOrderValue, 0);
  const contractSum = contract.originalContractSum + contract.approvedChangeSum;
  const unallocated = Number((contractSum - sovTotal).toFixed(2));
  const valid = lineNumber.trim() !== "" && description.trim() !== "" && Number.isFinite(amount) && amount >= 0;
  const balancesWithout = Math.abs(unallocated - amount) <= 0.005;

  useEffect(() => {
    if (!open) return;
    setLineNumber(String(lines.length + 1).padStart(2, "0"));
    setDescription("");
    setValue("");
    setCostCodeId("");
    setRaise(unallocated <= 0.005);
  }, [open, lines.length, unallocated]);

  async function submit() {
    const code = codes.find((c) => c.id === costCodeId) ?? null;
    const done = await run("add-line", () =>
      api.post(`/api/v1/prime-contracts/${contract.id}/sov/lines`, {
        lineNumber: lineNumber.trim(),
        description: description.trim(),
        scheduledValue: amount,
        raiseContractSum: raise,
        ...(code ? { costCodeId: code.id, costCode: code.code, ...(code.costType ? { costType: code.costType } : {}) } : {}),
      }),
    );
    if (done !== null) onAdded();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a schedule-of-values line"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || busy !== null || (!raise && !balancesWithout)}>
            Add line
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Line number" required>
            <Input value={lineNumber} onChange={(e) => setLineNumber(e.target.value)} className="font-mono" />
          </Field>
          <Field label={`Scheduled value (${cur})`} required>
            <Input value={value} inputMode="decimal" onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Description" required className="sm:col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} autoFocus />
          </Field>
          <Field label="Cost code" optional className="sm:col-span-2">
            <Select value={costCodeId} onChange={(e) => setCostCodeId(e.target.value)}>
              <option value="">No cost code</option>
              {codes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-meta">
          <input type="checkbox" checked={raise} onChange={(e) => setRaise(e.target.checked)} disabled={contract.executed === 1} />
          This line brings new scope — raise the contract sum by exactly its value
        </label>
        <p className="text-2xs text-content-subtle">
          {unallocated > 0.005
            ? `${money(unallocated, cur)} of the contract sum is not yet allocated to a line; a line of exactly that value fills it without raising the sum.`
            : "The sheet already totals the contract sum, so a new line must raise the sum with it."}
        </p>
      </div>
    </Modal>
  );
}

/** Deleting a line: its value has to go somewhere — onto another base-scope line. */
function DeleteLine({
  line,
  lines,
  contract,
  onClose,
  onDeleted,
}: {
  line: SovViewLine | null;
  lines: readonly SovViewLine[];
  contract: ContractView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [absorbId, setAbsorbId] = useState("");
  const cur = contract.currency;
  const candidates = lines.filter((l) => line !== null && l.id !== line.id && l.isChangeOrderLine !== 1);
  const needsAbsorb = line !== null && line.scheduledValue > 0.005;

  async function submit() {
    if (!line) return;
    const done = await run("delete-line", () =>
      api.del(
        `/api/v1/prime-contracts/${contract.id}/sov/lines/${line.id}` +
          (absorbId ? `?absorbIntoLineId=${encodeURIComponent(absorbId)}` : ""),
      ),
    );
    if (done !== null) {
      setAbsorbId("");
      onDeleted();
    }
  }

  return (
    <Modal
      open={line !== null}
      onClose={onClose}
      title={line ? `Delete line ${line.lineNumber}?` : "Delete line"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} disabled={busy !== null || (needsAbsorb && absorbId === "")}>
            Delete the line
          </Button>
        </div>
      }
    >
      {line ? (
        <div className="space-y-3">
          <RefusalPanel refusal={refusal} onDismiss={clear} />
          <p className="text-meta text-content-muted">
            <span className="font-mono">{line.lineNumber}</span> {line.description} holds {money(line.scheduledValue, cur)}. Scope has to go somewhere — pick the base-scope line that absorbs it, so the sheet keeps totalling the contract sum.
          </p>
          {needsAbsorb ? (
            <Field label="Absorb its value into" required hint="Only base-scope lines can absorb; a change-order line belongs to its change order.">
              <Select value={absorbId} onChange={(e) => setAbsorbId(e.target.value)}>
                <option value="">Choose a line…</option>
                {candidates.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.lineNumber} — {l.description} ({money(l.scheduledValue, cur)})
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function Split({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div>
      <div className="text-label uppercase text-content-subtle">{label}</div>
      <div
        className={
          "mt-0.5 tabular-nums " + (strong ? "text-base font-semibold" : "text-sm font-medium")
        }
      >
        {value}
      </div>
      {hint ? <p className="mt-0.5 text-2xs text-content-subtle">{hint}</p> : null}
    </div>
  );
}

/**
 * Moving value between two lines. Scope has to come from somewhere: the API's
 * `absorbIntoLineId` is exactly that, and this dialog makes the counterparty
 * explicit rather than letting someone type a number and discover afterwards
 * that the sheet no longer totals the contract sum.
 */
function MoveValue({
  open,
  line,
  lines,
  contract,
  onClose,
  onMoved,
}: {
  open: boolean;
  line: SovViewLine | null;
  lines: readonly SovViewLine[];
  contract: ContractView;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [next, setNext] = useState("");
  const [absorbId, setAbsorbId] = useState("");

  const cur = contract.currency;
  const candidates = lines.filter(
    (l) => line !== null && l.id !== line.id && l.isChangeOrderLine !== 1,
  );
  const target = candidates.find((l) => l.id === absorbId) ?? null;
  const nextValue = Number(next);
  const valid = line !== null && Number.isFinite(nextValue);
  const delta = valid && line ? Number((nextValue - line.scheduledValue).toFixed(2)) : 0;
  const absorbAfter = target ? Number((target.scheduledValue - delta).toFixed(2)) : null;

  /* The identity, checked here before it is checked there. */
  const projectedTotal =
    line === null
      ? 0
      : Number(
          lines
            .reduce((sum, l) => {
              const base =
                l.id === line.id
                  ? nextValue
                  : target && l.id === target.id && absorbAfter !== null
                    ? absorbAfter
                    : l.scheduledValue;
              return sum + base + l.changeOrderValue;
            }, 0)
            .toFixed(2),
        );
  const contractSum = Number(
    (contract.originalContractSum + contract.approvedChangeSum).toFixed(2),
  );
  const balances = Math.abs(projectedTotal - contractSum) <= CENT;

  const problems: string[] = [];
  if (!valid) problems.push("Enter the new scheduled value for this line as a number.");
  if (line && !Number.isFinite(nextValue)) problems.push("The value must be numeric.");
  if (delta !== 0 && !target) {
    problems.push(
      "Pick the line the value moves out of. Scope has to come from somewhere, and without a counterparty the sheet would stop totalling the contract sum.",
    );
  }
  if (absorbAfter !== null && absorbAfter < -CENT) {
    problems.push(
      `${target?.lineNumber} holds ${money(target?.scheduledValue ?? 0, cur)}, which is less than the ${money(delta, cur)} being moved out of it.`,
    );
  }
  if (!balances) {
    problems.push(
      `The sheet would total ${money(projectedTotal, cur)} against a contract sum of ${money(contractSum, cur)}.`,
    );
  }

  async function submit() {
    if (!line) return;
    const done = await run("move", () =>
      api.patch(`/api/v1/prime-contracts/${contract.id}/sov/lines/${line.id}`, {
        scheduledValue: nextValue,
        ...(target ? { absorbIntoLineId: target.id } : {}),
      }),
    );
    if (done !== null) {
      setNext("");
      setAbsorbId("");
      onMoved();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={line ? `Move value on line ${line.lineNumber}` : "Move value"}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={problems.length > 0 || busy !== null}>
            Move the value
          </Button>
        </div>
      }
    >
      {line ? (
        <div className="space-y-3">
          <RefusalPanel refusal={refusal} onDismiss={clear} />
          <p className="text-meta text-content-muted">
            <span className="font-mono">{line.lineNumber}</span> {line.description} currently holds{" "}
            <span className="font-mono tabular-nums">{money(line.scheduledValue, cur)}</span> of
            base scope.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`New scheduled value (${cur})`} required>
              <Input
                value={next}
                inputMode="decimal"
                placeholder={String(line.scheduledValue)}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <Field
              label="Take the difference from"
              hint="Only base-scope lines can absorb. A change-order line belongs to its change order."
            >
              <Select value={absorbId} onChange={(e) => setAbsorbId(e.target.value)}>
                <option value="">Choose a line…</option>
                {candidates.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.lineNumber} — {l.description} ({money(l.scheduledValue, cur)})
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Card>
            <CardBody className="space-y-1 text-meta">
              <div className="flex justify-between">
                <span className="text-content-subtle">Movement</span>
                <span className="font-mono tabular-nums">
                  {delta >= 0 ? "+" : "−"}
                  {money(Math.abs(delta), cur)}
                </span>
              </div>
              {target && absorbAfter !== null ? (
                <div className="flex justify-between">
                  <span className="text-content-subtle">
                    {target.lineNumber} after the move
                  </span>
                  <span className="font-mono tabular-nums">{money(absorbAfter, cur)}</span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span className="text-content-subtle">Σ schedule after the move</span>
                <span className="font-mono tabular-nums">{money(projectedTotal, cur)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-content-subtle">Contract sum</span>
                <span className="font-mono tabular-nums">{money(contractSum, cur)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Identity</span>
                <Badge tone={balances ? "success" : "danger"} size="xs" dot>
                  {balances ? "balances" : "does not balance"}
                </Badge>
              </div>
            </CardBody>
          </Card>

          {problems.length > 0 ? (
            <Alert tone="warning" size="sm" title="This move will not be accepted">
              <ul className="list-disc pl-4">
                {[...new Set(problems)].map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
