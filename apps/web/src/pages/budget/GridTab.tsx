/**
 * THE BUDGET GRID — the cost report itself, and the screen this product is
 * judged on.
 *
 * The full column set the API computes is here, left to right, in the order a
 * construction cost report is read:
 *
 *   original + transfers + approved changes            = revised budget
 *   committed + pending commitments                    = obligated
 *   direct cost, spent (job to date)                   = incurred
 *   spent + forecast to complete                       = forecast at completion
 *   revised − forecast at completion                   = variance
 *
 * Three decisions worth stating:
 *
 *  · SUBTOTALS ARE REAL. Grouping runs in the grid engine over the FILTERED
 *    leaf rows, so a division subtotal and the sticky footer always agree with
 *    the rows actually on screen. Nothing is pre-aggregated on the client.
 *  · QUANTITY, UNIT RATE AND PROGRESS ARE NOT SUMMED. Adding tonnes to metres
 *    produces a number that looks like a fact, and a straight average of line
 *    percentages lets a $500 line outvote a $5m one. Those columns aggregate
 *    to nothing on purpose, and the footer says why.
 *  · EDITS ARE BUFFERED, NOT FIRED PER KEYSTROKE. Cells commit into a dirty
 *    buffer with keyboard navigation; "Commit" writes them line by line and
 *    surfaces each refusal with the line it belongs to. Plan columns stop
 *    being editable the moment the budget is locked or captured, because the
 *    API refuses them from that point and a cell you can type into but not
 *    save is a lie about what the platform will accept.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUDGET_LINE_KINDS,
  BUDGET_LINE_STATUSES,
  COST_TYPES,
  FORECAST_METHODS,
  type CostType,
  type ForecastMethod,
} from "@constructos/shared";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ErrorAlert,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Textarea,
  Tooltip,
  cx,
  useConfirm,
} from "../../ui";
import { IconPlus, IconWarning } from "../../ui/icons";
import { DataTable } from "../../ui/data";
import type {
  DataCellChange,
  DataColumns,
  DataOption,
  DataRowAction,
  DataView,
} from "../../ui/data";
import { Combobox, NumberInput } from "../../ui/inputs";
import { api } from "../../lib/api";
import ForecastLineModal from "./ForecastLineModal";
import LineDrawer from "./LineDrawer";
import { MoneyField } from "./moneyInput";
import {
  FORECAST_METHOD_HINT,
  FORECAST_METHOD_LABEL,
  LINE_KIND_LABEL,
  LINE_STATUS_TONE,
  LoadError,
  MethodBadge,
  ReasonList,
  VARIANCE_BAND_CLASS,
  VARIANCE_BAND_NOTE,
  count,
  errorMessage,
  labelize,
  loadAllLines,
  money,
  useResource,
  varianceBand,
  type BudgetDetail,
  type BudgetLine,
  type CostCodeOption,
} from "./budgetShared";

/* ========================================================================== */
/* Grouping                                                                    */
/* ========================================================================== */

type GroupMode = "none" | "division" | "division_code" | "wbs" | "cost_type" | "line_kind" | "sub_job";

const GROUP_OPTIONS: Array<{ value: GroupMode; label: string; title: string }> = [
  { value: "none", label: "Flat", title: "Every line, no subtotals" },
  { value: "division", label: "Division", title: "Roll up to the first WBS segment" },
  {
    value: "division_code",
    label: "Division → code",
    title: "Two levels of subtotal: division, then cost code",
  },
  { value: "wbs", label: "WBS path", title: "Roll up by the materialized WBS path" },
  { value: "cost_type", label: "Cost type", title: "Labour, material, equipment, subcontract" },
  { value: "line_kind", label: "Line kind", title: "Standard, contingency, allowance…" },
  { value: "sub_job", label: "Sub job", title: "The project's own sub-job / phase segment" },
];

const GROUPING: Record<GroupMode, string[]> = {
  none: [],
  division: ["division"],
  division_code: ["division", "costCode"],
  wbs: ["wbsPath"],
  cost_type: ["costType"],
  line_kind: ["lineKind"],
  sub_job: ["subJob"],
};

const GROUP_STORAGE_KEY = "constructos.budget.grid.group";

/** The first segment of the materialized WBS path — the classic division. */
function divisionOf(line: BudgetLine): string {
  const path = line.wbsPath ?? "";
  const head = path.split("/").filter(Boolean)[0];
  if (head) return head;
  const code = line.costCode.split(/[.\-/]/)[0];
  return code ?? line.costCode;
}

const COST_TYPE_OPTIONS: DataOption[] = COST_TYPES.map((value) => ({
  value,
  text: labelize(value),
  label: labelize(value),
}));

const LINE_KIND_OPTIONS: DataOption[] = BUDGET_LINE_KINDS.map((value) => ({
  value,
  text: LINE_KIND_LABEL[value],
  label: LINE_KIND_LABEL[value],
}));

const LINE_STATUS_OPTIONS: DataOption[] = BUDGET_LINE_STATUSES.map((value) => ({
  value,
  text: labelize(value),
  label: labelize(value),
  tone: LINE_STATUS_TONE[value],
}));

const METHOD_OPTIONS: DataOption[] = FORECAST_METHODS.map((value) => ({
  value,
  text: FORECAST_METHOD_LABEL[value],
  label: FORECAST_METHOD_LABEL[value],
}));

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin:cost-report",
    name: "Cost report",
    builtIn: true,
    state: {
      columnVisibility: {},
      sorting: [{ id: "costCode", desc: false }],
    },
  },
  {
    id: "builtin:overruns",
    name: "Overruns first",
    builtIn: true,
    state: {
      sorting: [{ id: "projectedOverUnder", desc: false }],
    },
  },
  {
    id: "builtin:forecast-review",
    name: "Forecast review",
    builtIn: true,
    state: {
      columnVisibility: {
        budgetModifications: false,
        approvedChanges: false,
        pendingBudgetChanges: false,
        committedCost: false,
        pendingCommitments: false,
        directCosts: false,
      },
      sorting: [{ id: "forecastFinal", desc: true }],
    },
  },
];

/* ========================================================================== */
/* Editing                                                                     */
/* ========================================================================== */

/** columnId → the PATCH field it writes, with the conversion it needs. */
const EDITABLE_FIELDS: Record<string, (value: unknown) => unknown> = {
  description: (value) => (typeof value === "string" ? value : ""),
  originalBudget: (value) => (typeof value === "number" ? value : 0),
  quantity: (value) => (typeof value === "number" ? value : null),
  unitRate: (value) => (typeof value === "number" ? value : null),
  directCosts: (value) => (typeof value === "number" ? value : 0),
  jobToDateCosts: (value) => (typeof value === "number" ? value : 0),
  // The grid shows progress as 0–100; the API stores the fraction.
  percentComplete: (value) =>
    typeof value === "number" ? Math.min(1, Math.max(0, value / 100)) : 0,
  forecastToComplete: (value) => (typeof value === "number" ? Math.max(0, value) : 0),
  forecastMethod: (value) => (typeof value === "string" ? value : "remaining_budget"),
  notes: (value) => (typeof value === "string" && value !== "" ? value : null),
};

interface SaveFailure {
  costCode: string;
  message: string;
}

/* ========================================================================== */
/* Tab                                                                         */
/* ========================================================================== */

export interface GridTabProps {
  budget: BudgetDetail;
  currency: string;
  users: Map<string, string>;
  version: number;
  onChanged: () => void;
}

export default function GridTab({ budget, currency, users, version, onChanged }: GridTabProps) {
  const { confirm, dialog } = useConfirm();
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    try {
      const stored = window.localStorage.getItem(GROUP_STORAGE_KEY);
      if (stored && stored in GROUPING) return stored as GroupMode;
    } catch {
      /* storage is a convenience, never a requirement */
    }
    return "division_code";
  });
  const [overrunsOnly, setOverrunsOnly] = useState(false);
  const [openLineId, setOpenLineId] = useState<string | null>(null);
  const [forecastLine, setForecastLine] = useState<BudgetLine | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<SaveFailure[]>([]);
  const [notices, setNotices] = useState<string[]>([]);

  useEffect(() => {
    try {
      window.localStorage.setItem(GROUP_STORAGE_KEY, groupMode);
    } catch {
      /* ignore */
    }
  }, [groupMode]);

  const lines = useResource(
    (signal) => loadAllLines(budget.id, signal),
    [budget.id, version],
    true,
  );

  const allLines = useMemo(() => lines.data?.lines ?? [], [lines.data]);
  const rows = useMemo(
    () => (overrunsOnly ? allLines.filter((line) => line.projectedOverUnder < 0) : allLines),
    [allLines, overrunsOnly],
  );

  const planEditable = budget.planEditable;
  const closed = budget.status === "closed";
  const lineEditable = useCallback(
    (line: BudgetLine) => !closed && line.status !== "locked" && line.status !== "void",
    [closed],
  );
  const planCellEditable = useCallback(
    (line: BudgetLine) => planEditable && lineEditable(line),
    [planEditable, lineEditable],
  );

  const columns = useMemo<DataColumns<BudgetLine>>(
    () => [
      {
        id: "costCode",
        header: "Cost code",
        accessor: "costCode",
        type: "code",
        width: 132,
        sticky: "start",
        mono: true,
        groupable: true,
        aggregate: "none",
      },
      {
        id: "description",
        header: "Description",
        accessor: "description",
        type: "text",
        width: 280,
        editable: (line) => lineEditable(line),
        validate: (value) =>
          typeof value === "string" && value.trim() !== "" ? null : "A line needs a description.",
      },
      {
        id: "division",
        header: "Division",
        headerTooltip: "The first segment of the line's materialized WBS path.",
        accessor: (line: BudgetLine) => divisionOf(line),
        type: "text",
        width: 110,
        groupable: true,
        aggregate: "none",
      },
      {
        id: "costType",
        header: "Cost type",
        accessor: "costType",
        type: "enum",
        options: COST_TYPE_OPTIONS,
        width: 128,
        groupable: true,
        aggregate: "none",
      },
      {
        id: "lineKind",
        header: "Line kind",
        accessor: "lineKind",
        type: "enum",
        options: LINE_KIND_OPTIONS,
        width: 132,
        groupable: true,
        aggregate: "none",
        defaultHidden: true,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        options: LINE_STATUS_OPTIONS,
        width: 112,
        groupable: true,
        aggregate: "none",
        defaultHidden: true,
      },
      {
        id: "wbsPath",
        header: "WBS path",
        accessor: "wbsPath",
        type: "text",
        width: 168,
        mono: true,
        groupable: true,
        aggregate: "none",
        defaultHidden: true,
      },
      {
        id: "subJob",
        header: "Sub job",
        accessor: "subJob",
        type: "text",
        width: 140,
        groupable: true,
        aggregate: "none",
        defaultHidden: true,
      },
      {
        id: "unit",
        header: "Unit",
        accessor: "unit",
        type: "text",
        width: 84,
        aggregate: "none",
        defaultHidden: true,
      },
      {
        id: "quantity",
        header: "Quantity",
        headerTooltip:
          "Not totalled: adding tonnes to metres produces a number that looks like a fact.",
        accessor: "quantity",
        type: "number",
        precision: 2,
        width: 112,
        aggregate: "none",
        defaultHidden: true,
        editable: (line) => planCellEditable(line),
        editor: { kind: "number", step: 0.01 },
      },
      {
        id: "unitRate",
        header: "Unit rate",
        headerTooltip:
          "A measured line's budget is quantity × unit rate; the API refuses an original budget that disagrees with the extension.",
        accessor: "unitRate",
        type: "currency",
        currency,
        precision: 2,
        width: 120,
        aggregate: "none",
        defaultHidden: true,
        editable: (line) => planCellEditable(line),
        editor: { kind: "number", step: 0.01 },
      },
      moneyColumn({
        id: "originalBudget",
        header: "Original",
        currency,
        tooltip: "Frozen at lock. After that it moves only through an approved budget change.",
        editable: planCellEditable,
      }),
      moneyColumn({
        id: "budgetModifications",
        header: "Transfers",
        currency,
        signColor: true,
        tooltip: "Net of approved transfers and contingency draws in and out of this line.",
      }),
      moneyColumn({
        id: "approvedChanges",
        header: "Approved changes",
        currency,
        signColor: true,
        tooltip: "Owner-funded increases, each behind an executed prime contract change order.",
      }),
      moneyColumn({
        id: "pendingBudgetChanges",
        header: "Pending changes",
        currency,
        signColor: true,
        tooltip:
          "Exposure only. A pending transfer is deliberately NOT part of the revised budget — including it is how a project talks itself into spending money nobody has approved.",
      }),
      moneyColumn({
        id: "revisedBudget",
        header: "Revised budget",
        currency,
        tooltip: "Original + transfers + approved changes.",
        emphasis: true,
      }),
      moneyColumn({
        id: "committedCost",
        header: "Committed",
        currency,
        tooltip: "Approved commitments, including executed commitment change orders.",
      }),
      moneyColumn({
        id: "pendingCommitments",
        header: "Pending commitments",
        currency,
        defaultHidden: true,
        tooltip: "Draft / out-for-signature commitments not yet executed.",
      }),
      moneyColumn({
        id: "directCosts",
        header: "Direct cost",
        currency,
        tooltip: "Cost booked outside a commitment — labour, equipment, expenses.",
        editable: lineEditable,
      }),
      moneyColumn({
        id: "jobToDateCosts",
        header: "Spent (JTD)",
        currency,
        tooltip: "Everything actually incurred: invoiced commitment cost plus direct cost.",
        editable: lineEditable,
      }),
      {
        id: "percentComplete",
        header: "% complete",
        headerTooltip:
          "Not averaged into subtotals: a straight average of line percentages would let a small line outvote a large one.",
        accessor: (line: BudgetLine) => Math.round(line.percentComplete * 1000) / 10,
        type: "percent",
        precision: 1,
        progress: true,
        width: 132,
        aggregate: "none",
        editable: (line) => lineEditable(line),
        editor: { kind: "number", min: 0, max: 100, step: 1 },
        validate: (value) =>
          typeof value === "number" && value >= 0 && value <= 100
            ? null
            : "Progress is a percentage between 0 and 100.",
        footer: (
          <Tooltip content="Progress is deliberately not aggregated: a straight average of line percentages would let a $500 line outvote a $5m one.">
            <span className="text-meta text-content-subtle">not aggregated</span>
          </Tooltip>
        ),
      },
      {
        id: "forecastMethod",
        header: "Method",
        headerTooltip:
          "How the forecast was derived. Recorded per line so a reader always knows whether they are looking at an estimator's judgement or a formula.",
        accessor: "forecastMethod",
        type: "enum",
        options: METHOD_OPTIONS,
        width: 156,
        aggregate: "none",
        editable: (line) => lineEditable(line),
        editor: { kind: "select", options: METHOD_OPTIONS },
        cell: (ctx) => <MethodBadge method={ctx.row.forecastMethod} />,
      },
      moneyColumn({
        id: "forecastToComplete",
        header: "Forecast to complete",
        currency,
        tooltip: "The remaining cost, by the line's own method.",
        editable: lineEditable,
      }),
      moneyColumn({
        id: "forecastFinal",
        header: "Forecast at completion",
        currency,
        tooltip: "Spent to date + forecast to complete.",
        emphasis: true,
      }),
      {
        id: "projectedOverUnder",
        header: "Variance",
        headerTooltip:
          "Revised budget − forecast at completion. Positive is favourable; negative is an overrun, shaded by its size relative to the line's own budget.",
        accessor: "projectedOverUnder",
        type: "currency",
        currency,
        width: 156,
        align: "right",
        mono: true,
        aggregate: "sum",
        sortDescFirst: false,
        cell: (ctx) => <VarianceCell line={ctx.row} currency={currency} />,
        aggregatedCell: (ctx) => {
          const value = typeof ctx.value === "number" ? ctx.value : null;
          if (value === null) return null;
          return (
            <span
              className={cx(
                "tabular-nums font-semibold",
                value < 0 ? "text-danger-fg" : value > 0 ? "text-success-fg" : "text-content-muted",
              )}
            >
              {money(value, currency, { signed: true })}
            </span>
          );
        },
      },
      {
        id: "notes",
        header: "Notes",
        accessor: "notes",
        type: "text",
        width: 240,
        aggregate: "none",
        defaultHidden: true,
        editable: (line) => lineEditable(line),
        editor: { kind: "textarea" },
      },
      {
        id: "updatedAt",
        header: "Updated",
        accessor: "updatedAt",
        type: "datetime",
        width: 168,
        aggregate: "none",
        defaultHidden: true,
      },
    ],
    [currency, lineEditable, planCellEditable],
  );

  const rowActions = useCallback(
    (line: BudgetLine): ReadonlyArray<DataRowAction<BudgetLine>> => [
      {
        id: "open",
        label: "Open line",
        onSelect: () => setOpenLineId(line.id),
      },
      {
        id: "forecast",
        label: "Record a forecast",
        onSelect: () => setForecastLine(line),
      },
      {
        id: "delete",
        label: "Delete line",
        destructive: true,
        onSelect: () => {
          void (async () => {
            const ok = await confirm({
              title: `Delete ${line.costCode}?`,
              description:
                "The line and its forecast history are removed. A line that carries budget movements cannot be deleted — void those changes first, or close the line instead.",
              confirmLabel: "Delete line",
              destructive: true,
            });
            if (!ok) return;
            try {
              await api.del(`/api/v1/budget-lines/${line.id}`);
              lines.reload();
              onChanged();
            } catch (err) {
              setFailures([
                { costCode: line.costCode, message: errorMessage(err, "The line was not deleted") },
              ]);
            }
          })();
        },
      },
    ],
    [confirm, lines, onChanged],
  );

  const commitEdits = useCallback(
    async (changes: ReadonlyArray<DataCellChange<BudgetLine>>) => {
      const byRow = new Map<string, { line: BudgetLine; patch: Record<string, unknown> }>();
      for (const change of changes) {
        const convert = EDITABLE_FIELDS[change.columnId];
        if (!convert) continue;
        const entry = byRow.get(change.rowId) ?? { line: change.row, patch: {} };
        entry.patch[change.columnId] = convert(change.value);
        byRow.set(change.rowId, entry);
      }
      if (byRow.size === 0) return;

      setSaving(true);
      const nextFailures: SaveFailure[] = [];
      const nextNotices: string[] = [];
      for (const [lineId, entry] of byRow) {
        try {
          const updated = await api.patch<BudgetLine>(
            `/api/v1/budget-lines/${lineId}`,
            entry.patch,
          );
          if (updated.forecastNotice && updated.forecastNotice.length > 0) {
            for (const reason of updated.forecastNotice) {
              nextNotices.push(`${entry.line.costCode}: ${reason}`);
            }
          }
        } catch (err) {
          nextFailures.push({
            costCode: entry.line.costCode,
            message: errorMessage(err, "This line was not saved"),
          });
        }
      }
      setFailures(nextFailures);
      setNotices(nextNotices);
      setSaving(false);
      lines.reload();
      onChanged();
    },
    [lines, onChanged],
  );

  const grouping = GROUPING[groupMode];

  return (
    <div className="space-y-3">
      {lines.error ? (
        <LoadError
          message={lines.error}
          onRetry={lines.reload}
          title="The budget lines could not be loaded"
        />
      ) : null}

      {!planEditable && !closed ? (
        <Alert tone="info" size="sm" title="Plan amounts are frozen on this budget">
          {budget.lockedAt
            ? `${budget.reference} was locked, so the original budget, quantities and unit rates are no longer editable here — the API refuses them. Money moves through an approved budget change from now on.`
            : `${budget.reference} has been captured as at ${budget.lastSnapshot?.asOfDate ?? "a period close"}, so plan amounts are frozen to keep that capture true. Actuals, progress and forecasts still move.`}
        </Alert>
      ) : null}

      {closed ? (
        <Alert tone="warning" size="sm" title="This budget is closed">
          Nothing on the grid can be edited.
        </Alert>
      ) : null}

      {failures.length > 0 ? (
        <Alert
          tone="danger"
          title={`${failures.length} line${failures.length === 1 ? "" : "s"} were not saved`}
          icon={IconWarning}
          onDismiss={() => setFailures([])}
        >
          <ul className="space-y-1">
            {failures.map((failure, index) => (
              <li key={index}>
                <span className="font-mono text-code">{failure.costCode}</span> — {failure.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {notices.length > 0 ? (
        <Alert
          tone="warning"
          title="Some forecasts kept their previous figure"
          onDismiss={() => setNotices([])}
        >
          <p>
            A stored cost column is never quietly replaced with a number its inputs do not support.
            The platform's own reasons:
          </p>
          <ReasonList reasons={notices} className="mt-2" />
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label uppercase text-content-subtle">Roll up by</p>
          <SegmentedControl<GroupMode>
            value={groupMode}
            onChange={setGroupMode}
            size="sm"
            aria-label="Group the budget"
            className="mt-1"
            options={GROUP_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              title: option.title,
            }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={overrunsOnly ? "secondary" : "ghost"}
            onClick={() => setOverrunsOnly((previous) => !previous)}
            title="Show only lines whose forecast at completion exceeds their revised budget"
          >
            {overrunsOnly ? "Showing overruns only" : "Overruns only"}
          </Button>
          <Button
            leadingIcon={IconPlus}
            onClick={() => setAddOpen(true)}
            disabled={!planEditable}
            title={
              planEditable
                ? "Add a line to this budget"
                : "Plan amounts are frozen on this budget, so no new line can be added"
            }
          >
            Add line
          </Button>
        </div>
      </div>

      <DataTable<BudgetLine>
        tableId="budget-grid"
        data={rows}
        columns={columns}
        getRowId={(line) => line.id}
        loading={lines.loading && allLines.length === 0}
        loadingRows={14}
        height={640}
        density="compact"
        stickyHeader
        stickyFooter
        showFooter
        gridLines
        zebra
        filterRow
        grouping={grouping}
        onGroupingChange={(next) => {
          const match = (Object.keys(GROUPING) as GroupMode[]).find(
            (mode) => GROUPING[mode].join(",") === next.join(","),
          );
          if (match) setGroupMode(match);
        }}
        defaultExpanded
        editable={!closed}
        bufferEdits
        onCommitEdits={commitEdits}
        builtInViews={BUILT_IN_VIEWS}
        exportFileName={`${budget.reference}-cost-report`}
        searchPlaceholder="Search cost code, description, sub job…"
        onRowClick={({ row }) => setOpenLineId(row.id)}
        rowActions={rowActions}
        rowTone={(line) => (line.projectedOverUnder < 0 ? "danger" : undefined)}
        empty={{
          title: "This budget has no lines yet",
          description:
            "A budget line is one WBS coordinate — cost code × cost type. Every commitment, change order and invoice on this project codes back to one, so this is where the cost report starts.",
        }}
        emptyFiltered={{
          title: "No line matches these filters",
          description: "Clear the filters to see the whole cost report again.",
        }}
        aria-label={`Budget line items for ${budget.reference}`}
        caption={`Budget line items for ${budget.reference}`}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-meta text-content-subtle">
        <span>
          {count(rows.length)} of {count(allLines.length)} line
          {allLines.length === 1 ? "" : "s"} · all figures in {currency}
          {saving ? " · saving…" : ""}
        </span>
        <span>
          Subtotals and the footer are summed over the rows actually on screen — never a
          pre-aggregated figure from somewhere else.
        </span>
      </div>

      <LineDrawer
        lineId={openLineId}
        currency={currency}
        users={users}
        onClose={() => setOpenLineId(null)}
        onForecast={(lineId) => {
          const line = allLines.find((candidate) => candidate.id === lineId) ?? null;
          setOpenLineId(null);
          setForecastLine(line);
        }}
      />

      <ForecastLineModal
        open={forecastLine !== null}
        budgetId={budget.id}
        currency={currency}
        line={forecastLine}
        onClose={() => setForecastLine(null)}
        onSaved={() => {
          setForecastLine(null);
          lines.reload();
          onChanged();
        }}
      />

      <AddLineModal
        open={addOpen}
        budget={budget}
        currency={currency}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          lines.reload();
          onChanged();
        }}
      />

      {dialog}
    </div>
  );
}

/* ========================================================================== */
/* Cells                                                                       */
/* ========================================================================== */

/**
 * The variance cell. Sign decides the colour; SIZE RELATIVE TO THE LINE'S OWN
 * BUDGET decides the weight, because a $900 overrun on a $1,000 line and a
 * $900 overrun on a $4m line are not the same fact.
 */
function VarianceCell({ line, currency }: { line: BudgetLine; currency: string }) {
  const band = varianceBand(line.projectedOverUnder, line.revisedBudget);
  return (
    <Tooltip content={VARIANCE_BAND_NOTE[band]}>
      <span
        className={cx(
          "inline-flex items-center justify-end rounded px-1.5 py-0.5 tabular-nums",
          VARIANCE_BAND_CLASS[band],
        )}
      >
        {money(line.projectedOverUnder, currency, { signed: true })}
      </span>
    </Tooltip>
  );
}

interface MoneyColumnSpec {
  id: keyof BudgetLine & string;
  header: string;
  currency: string;
  tooltip?: string;
  signColor?: boolean;
  emphasis?: boolean;
  defaultHidden?: boolean;
  editable?: (line: BudgetLine) => boolean;
}

/** Every money column in the cost report, defined once. */
function moneyColumn(spec: MoneyColumnSpec): DataColumns<BudgetLine>[number] {
  const canEdit = spec.editable;
  return {
    id: spec.id,
    header: spec.header,
    headerTooltip: spec.tooltip,
    accessor: spec.id,
    type: "currency",
    currency: spec.currency,
    precision: 2,
    align: "right",
    width: 152,
    mono: true,
    aggregate: "sum",
    signColor: spec.signColor ?? false,
    defaultHidden: spec.defaultHidden ?? false,
    cellClassName: spec.emphasis ? "font-semibold" : undefined,
    editable: canEdit ? (line: BudgetLine) => canEdit(line) : false,
    editor: { kind: "number", step: 1 },
    parse: (raw: string) => {
      const cleaned = raw.replace(/[^0-9.eE+-]/g, "");
      const parsed = Number(cleaned);
      return Number.isFinite(parsed) ? parsed : null;
    },
    validate: (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? null : "This must be a number.",
  };
}

/* ========================================================================== */
/* Add line                                                                    */
/* ========================================================================== */

function AddLineModal({
  open,
  budget,
  currency,
  onClose,
  onCreated,
}: {
  open: boolean;
  budget: BudgetDetail;
  currency: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [costCode, setCostCode] = useState<string | null>(null);
  const [costType, setCostType] = useState<CostType>("subcontract");
  const [description, setDescription] = useState("");
  const [lineKind, setLineKind] = useState<string>("standard");
  const [measured, setMeasured] = useState(false);
  const [unit, setUnit] = useState("");
  const [quantity, setQuantity] = useState<number | null>(null);
  const [unitRate, setUnitRate] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<ForecastMethod>("remaining_budget");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codes = useResource<{ items: CostCodeOption[]; total: number }>(
    (signal) =>
      api.get<{ items: CostCodeOption[]; total: number }>(
        `/api/v1/projects/${budget.projectId}/cost-codes`,
        { signal },
      ),
    [budget.projectId],
    open,
  );

  useEffect(() => {
    if (!open) return;
    setCostCode(null);
    setCostType("subcontract");
    setDescription("");
    setLineKind("standard");
    setMeasured(false);
    setUnit("");
    setQuantity(null);
    setUnitRate(null);
    setAmount(null);
    setMethod("remaining_budget");
    setNotes("");
    setError(null);
  }, [open]);

  const options = useMemo(
    () =>
      (codes.data?.items ?? []).map((code) => ({
        value: code.code,
        label: `${code.code} — ${code.title}`,
        description: code.source === "project" ? "Project override" : "Company standard",
        keywords: [code.title, code.division ?? ""],
      })),
    [codes.data],
  );

  const extended =
    measured && quantity !== null && unitRate !== null
      ? Math.round(quantity * unitRate * 100) / 100
      : null;

  async function submit() {
    if (!costCode) {
      setError("A budget line must bind to the project's cost-code list.");
      return;
    }
    if (description.trim() === "") {
      setError("A budget line needs a description.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        costCode,
        costType,
        description: description.trim(),
        lineKind,
        forecastMethod: method,
      };
      if (measured) {
        body["unit"] = unit.trim() === "" ? null : unit.trim();
        body["quantity"] = quantity;
        body["unitRate"] = unitRate;
      } else if (amount !== null) {
        body["originalBudget"] = amount;
      }
      if (notes.trim() !== "") body["notes"] = notes.trim();
      await api.post(`/api/v1/budgets/${budget.id}/lines`, body);
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "The line could not be created"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Add a budget line"
      description="One line per WBS coordinate — cost code × cost type. The API holds exactly one."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Add line
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} />
      {codes.error ? (
        <ErrorAlert message={`Cost codes could not be loaded: ${codes.error}`} onRetry={codes.reload} />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Cost code"
          required
          hint="Bound to the project's cost-code list; the budget never defines a parallel structure."
        >
          <Combobox
            value={costCode}
            onChange={(next) => setCostCode(next)}
            options={options}
            placeholder={codes.loading ? "Loading cost codes…" : "Search cost codes…"}
            emptyMessage="No cost code matches. Create it in the project's cost-code list first."
          />
        </Field>
        <Field label="Cost type" required>
          <Select value={costType} onChange={(event) => setCostType(event.target.value as CostType)}>
            {COST_TYPES.map((option) => (
              <option key={option} value={option}>
                {labelize(option)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" required className="sm:col-span-2">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Reinforced concrete — cores and shear walls"
          />
        </Field>
        <Field label="Line kind">
          <Select value={lineKind} onChange={(event) => setLineKind(event.target.value)}>
            {BUDGET_LINE_KINDS.map((option) => (
              <option key={option} value={option}>
                {LINE_KIND_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Forecast method" hint={FORECAST_METHOD_HINT[method]}>
          <Select value={method} onChange={(event) => setMethod(event.target.value as ForecastMethod)}>
            {FORECAST_METHODS.map((option) => (
              <option key={option} value={option}>
                {FORECAST_METHOD_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>

        <div className="sm:col-span-2">
          <Checkbox
            checked={measured}
            onChange={(event) => setMeasured(event.target.checked)}
            label="This is a measured line (quantity × unit rate)"
            description="A measured line's budget is its extension; the API refuses an amount that disagrees with it."
          />
        </div>

        {measured ? (
          <>
            <Field label="Unit">
              <Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="m³" />
            </Field>
            <Field label="Quantity">
              <NumberInput value={quantity} onChange={setQuantity} min={0} step={1} precision={2} />
            </Field>
            <Field label="Unit rate">
              <MoneyField value={unitRate} onChange={setUnitRate} currency={currency} />
            </Field>
            <Field label="Extends to" hint="A measured line's budget is its extension.">
              <p className="pt-2 text-body font-medium tabular-nums text-content">
                {extended === null ? "—" : money(extended, currency)}
              </p>
            </Field>
          </>
        ) : (
          <Field label="Original budget" className="sm:col-span-2">
            <MoneyField value={amount} onChange={setAmount} currency={currency} />
          </Field>
        )}

        <Field label="Notes" optional className="sm:col-span-2">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
        </Field>
      </div>

      <p className="mt-3 text-meta text-content-subtle">
        <Badge tone="neutral" size="xs" variant="outline">
          {budget.currency}
        </Badge>{" "}
        Amounts are stored in the budget's currency and are never converted.
      </p>
    </Modal>
  );
}
