/**
 * COST LINES — the breakdown that travels the whole chain.
 *
 * The same line shape hangs off a change event, a PCO, an RFQ and a COR, so
 * this editor is written once and pointed at whichever base path owns it. Two
 * things it insists on:
 *
 *   COST TYPE IS NOT OPTIONAL in practice. Labour, material, equipment,
 *   subcontract and other are the five buckets a markup stack narrows to, and
 *   a stack that says "15% on labour only" cannot be applied over lines that
 *   never said which bucket they were in. The subtotal is therefore always
 *   shown split by cost type, not just as one number.
 *
 *   COST AND REVENUE ARE SEPARATE. `costAmount` is what it costs us,
 *   `revenueAmount` is what we bill. Margin on a change lives in the gap, and
 *   a single "amount" column would hide it.
 *
 * Every refusal the API returns is surfaced verbatim: the derivation refuses
 * an ambiguous price (a quantity and a rate that disagree with a stated cost)
 * rather than picking one, and the message names both figures.
 */
import { useCallback, useMemo, useState } from "react";
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
  Select,
} from "../../ui";
import { Modal, toast } from "../../ui/overlays";
import { DataTable, type DataColumns } from "../../ui/data";
import { NumberInput } from "../../ui/inputs";
import { IconCost, IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  COST_TYPES,
  COST_TYPE_LABEL,
  errorMessage,
  label,
  money,
  num,
  percent,
  type ChangeLineRow,
  type CostType,
  type LineTotals,
} from "./changesShared";

export interface CostLinesProps {
  /** e.g. `/api/v1/projects/p1/potential-change-orders/pco1` */
  basePath: string;
  lines: readonly ChangeLineRow[];
  totals: LineTotals | null;
  currency: string | null;
  /** Lines are frozen once the parent has been put to somebody. */
  editable: boolean;
  frozenReason?: string;
  onChanged: () => void;
  title?: string;
  subtitle?: string;
}

interface NewLine {
  description: string;
  costType: CostType;
  costCode: string;
  unit: string;
  quantity: number | null;
  unitRate: number | null;
  costAmount: number | null;
  markupPercent: number | null;
  taxPercent: number | null;
}

const EMPTY_LINE: NewLine = {
  description: "",
  costType: "labour",
  costCode: "",
  unit: "",
  quantity: null,
  unitRate: null,
  costAmount: null,
  markupPercent: null,
  taxPercent: null,
};

export default function CostLines({
  basePath,
  lines,
  totals,
  currency,
  editable,
  frozenReason,
  onChanged,
  title = "Cost lines",
  subtitle,
}: CostLinesProps) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<NewLine>(EMPTY_LINE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const set = <K extends keyof NewLine>(key: K, value: NewLine[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const addLine = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        description: form.description.trim(),
        costType: form.costType,
      };
      if (form.costCode.trim()) body["costCode"] = form.costCode.trim();
      if (form.unit.trim()) body["unit"] = form.unit.trim();
      if (form.quantity !== null) body["quantity"] = form.quantity;
      if (form.unitRate !== null) body["unitRate"] = form.unitRate;
      if (form.costAmount !== null) body["costAmount"] = form.costAmount;
      if (form.markupPercent !== null) {
        body["markupKind"] = "percent";
        body["markupPercent"] = form.markupPercent;
      }
      if (form.taxPercent !== null) body["taxPercent"] = form.taxPercent;
      await api.post(`${basePath}/lines`, body);
      toast.success("Cost line added.");
      setForm(EMPTY_LINE);
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "The line was refused"));
    } finally {
      setBusy(false);
    }
  }, [basePath, form, onChanged]);

  const deleteLine = useCallback(
    async (line: ChangeLineRow) => {
      setEditError(null);
      try {
        await api.del(`${basePath}/lines/${line.id}`);
        toast.success("Cost line removed.");
        onChanged();
      } catch (err) {
        setEditError(errorMessage(err, "The line could not be removed"));
      }
    },
    [basePath, onChanged],
  );

  const columns = useMemo<DataColumns<ChangeLineRow>>(
    () => [
      {
        id: "lineNumber",
        header: "#",
        accessor: (row: ChangeLineRow) => row.lineNumber ?? String(row.sortOrder),
        type: "code",
        width: 70,
      },
      {
        id: "description",
        header: "Description",
        accessor: "description",
        type: "text",
        width: 280,
        editable,
      },
      {
        id: "costCode",
        header: "Cost code",
        accessor: "costCode",
        type: "code",
        width: 120,
        editable,
      },
      {
        id: "costType",
        header: "Cost type",
        accessor: "costType",
        type: "enum",
        width: 130,
        groupable: true,
        options: COST_TYPES.map((t) => ({
          value: t,
          text: COST_TYPE_LABEL[t],
          label: COST_TYPE_LABEL[t],
        })),
        cell: (ctx) => label(ctx.row.costType),
        editable,
      },
      {
        id: "quantity",
        header: "Qty",
        accessor: "quantity",
        type: "number",
        precision: 4,
        width: 90,
        editable,
      },
      { id: "unit", header: "Unit", accessor: "unit", type: "text", width: 70, editable },
      {
        id: "unitRate",
        header: "Rate",
        accessor: "unitRate",
        type: "number",
        precision: 4,
        width: 100,
        editable,
      },
      {
        id: "costAmount",
        header: "Cost",
        accessor: "costAmount",
        type: "currency",
        width: 120,
        aggregate: "sum",
        editable,
        cell: (ctx) => money(ctx.row.costAmount, currency),
      },
      {
        id: "markupAmount",
        header: "Line markup",
        headerTooltip:
          "Markup applied on this line alone. The contract's overhead/profit/bond stack is applied over the whole COR, in order, and is shown on the COR.",
        accessor: "markupAmount",
        type: "currency",
        width: 130,
        aggregate: "sum",
        cell: (ctx) => (
          <span className="tabular-nums">
            {money(ctx.row.markupAmount, currency)}
            {ctx.row.markupPercent !== null ? (
              <span className="ml-1 text-2xs text-content-subtle">
                {percent(ctx.row.markupPercent, 3)}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "taxAmount",
        header: "Tax",
        accessor: "taxAmount",
        type: "currency",
        width: 110,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.taxAmount, currency),
      },
      {
        id: "revenueAmount",
        header: "Revenue",
        headerTooltip: "What we bill. Kept apart from cost, because that gap is the margin.",
        accessor: "revenueAmount",
        type: "currency",
        width: 120,
        aggregate: "sum",
        cell: (ctx) => money(ctx.row.revenueAmount, currency),
      },
      { id: "notes", header: "Notes", accessor: "notes", type: "text", width: 180, defaultHidden: true },
    ],
    [currency, editable],
  );

  const byType = totals?.costByType ?? {};
  const presentTypes = COST_TYPES.filter((t) => (byType[t] ?? 0) !== 0);

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={
          subtitle ??
          "Cost and revenue are separate columns on every line. The cost-type split below is what a markup stack narrows to."
        }
        icon={IconCost}
        actions={
          editable ? (
            <Button size="sm" icon={IconPlus} onClick={() => setAdding(true)}>
              Add line
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-3">
        <ErrorAlert message={editError} />
        {!editable && frozenReason ? (
          <Alert tone="info" variant="subtle" size="sm" title="These lines are frozen">
            {frozenReason}
          </Alert>
        ) : null}

        {lines.length === 0 ? (
          <EmptyState
            size="sm"
            title="No cost lines yet"
            hint="A priced position with nothing underneath it is a guess wearing a number — the API refuses to price one."
            action={
              editable ? (
                <Button size="sm" onClick={() => setAdding(true)}>
                  Add the first line
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <DataTable<ChangeLineRow>
              data={lines as ChangeLineRow[]}
              columns={columns}
              getRowId={(row) => row.id}
              maxHeight={360}
              stickyHeader
              showFooter
              flush
              density="compact"
              toolbar={false}
              aria-label="Cost lines"
              editable={editable}
              bufferEdits={false}
              onCellEdit={async (change) => {
                setEditError(null);
                try {
                  await api.patch(`${basePath}/lines/${change.rowId}`, {
                    [change.columnId]: change.value,
                  });
                  onChanged();
                  return true;
                } catch (err) {
                  setEditError(errorMessage(err, "The edit was refused"));
                  return false;
                }
              }}
              rowActions={
                editable
                  ? (row) => [
                      {
                        id: "delete",
                        label: "Remove line",
                        destructive: true,
                        onSelect: () => void deleteLine(row),
                      },
                    ]
                  : undefined
              }
            />

            {/* ---- cost by type: the base a markup stack narrows to ---- */}
            <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
              <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Cost by type
              </span>
              {presentTypes.length === 0 ? (
                <span className="text-meta text-content-muted">
                  No line carries a cost amount yet.
                </span>
              ) : (
                presentTypes.map((type) => (
                  <Badge key={type} tone="neutral" variant="outline" size="xs">
                    {COST_TYPE_LABEL[type]} {money(byType[type] ?? 0, currency)}
                  </Badge>
                ))
              )}
            </div>

            {totals ? (
              <div className="grid gap-2 border-t border-border-subtle pt-3 text-meta sm:grid-cols-4">
                <div>
                  <div className="text-2xs uppercase tracking-wide text-content-subtle">
                    Cost subtotal
                  </div>
                  <div className="tabular-nums text-content">
                    {money(totals.costSubtotal, currency)}
                  </div>
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wide text-content-subtle">
                    Line markup
                  </div>
                  <div className="tabular-nums text-content">
                    {money(totals.lineMarkupTotal, currency)}
                  </div>
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wide text-content-subtle">Tax</div>
                  <div className="tabular-nums text-content">
                    {money(totals.taxTotal, currency)}
                  </div>
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wide text-content-subtle">
                    Revenue / margin
                  </div>
                  <div className="tabular-nums text-content">
                    {money(totals.revenueSubtotal, currency)}
                    <span className="ml-1 text-2xs text-content-subtle">
                      margin {money(totals.margin, currency)}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardBody>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a cost line"
        description="State a quantity and a rate, or a flat cost. Stating both when they disagree is refused rather than reconciled silently."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void addLine()}
              loading={busy}
              disabled={!form.description.trim()}
            >
              Add line
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <ErrorAlert message={error} />
          <Field label="Description" required>
            <Input
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Additional rebar to thickened slab, grid E/4"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Cost type" required hint="The bucket a markup stack narrows to.">
              <Select
                value={form.costType}
                onChange={(e) => set("costType", e.target.value as CostType)}
              >
                {COST_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {COST_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Cost code" optional>
              <Input value={form.costCode} onChange={(e) => set("costCode", e.target.value)} />
            </Field>
            <Field label="Unit" optional>
              <Input
                value={form.unit}
                onChange={(e) => set("unit", e.target.value)}
                placeholder="t, m², hr"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Quantity" optional>
              <NumberInput
                value={form.quantity}
                onChange={(v) => set("quantity", v)}
                precision={4}
                align="right"
              />
            </Field>
            <Field label="Unit rate" optional>
              <NumberInput
                value={form.unitRate}
                onChange={(v) => set("unitRate", v)}
                precision={4}
                align="right"
              />
            </Field>
            <Field
              label="Cost amount"
              optional
              hint="Leave blank to let quantity × rate speak."
            >
              <NumberInput
                value={form.costAmount}
                onChange={(v) => set("costAmount", v)}
                precision={2}
                align="right"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Line markup %" optional>
              <NumberInput
                value={form.markupPercent}
                onChange={(v) => set("markupPercent", v)}
                precision={3}
                suffix="%"
                align="right"
              />
            </Field>
            <Field label="Tax %" optional>
              <NumberInput
                value={form.taxPercent}
                onChange={(v) => set("taxPercent", v)}
                precision={3}
                suffix="%"
                align="right"
              />
            </Field>
          </div>
          {form.quantity !== null && form.unitRate !== null ? (
            <Alert tone="info" variant="subtle" size="sm">
              Quantity × rate = {num(form.quantity * form.unitRate, 2)}. If you also state a cost
              amount and it disagrees, the API refuses the line and names both figures.
            </Alert>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
}
