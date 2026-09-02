/**
 * THE COMMITMENT REGISTER — every subcontract and purchase order on the
 * project, on one virtualised grid.
 *
 * Two things make this more than a table of numbers:
 *
 *  · COMPLIANCE IS A COLUMN. The project compliance sweep is joined onto each
 *    row by commitment id, and the cell carries the finding's OWN sentence —
 *    "The general liability certificate expired on 2026-03-14 (164 days ago)
 *    — the vendor is uninsured for this cover today." A row whose vendor
 *    cannot be paid is painted at the rail, not left to a legend.
 *
 *  · TOTALS ARE PER CURRENCY. The footer aggregates would happily add a euro
 *    subcontract to a dollar one, so the money columns carry no footer at all;
 *    the per-currency rail above the grid is the total, and it says so.
 */
import { useMemo, useState } from "react";
import { Badge, Button, Card, CardBody, ErrorAlert, Field, Input, Select } from "../../ui";
import { DataTable, type DataColumns, type DataView } from "../../ui/data";
import type { Tone } from "../../ui/tokens";
import {
  COMPLIANCE_LABEL,
  ComplianceCell,
  CurrencyTotalsRail,
  KIND_LABEL,
  complianceTone,
  isoDate,
  money,
  statusToneOf,
  titleCase,
  type RegisterFilters,
} from "./shared";
import type {
  CommitmentListRow,
  CommitmentList,
  ComplianceReport,
  ComplianceResult,
  Vendor,
} from "./types";

const KINDS = ["subcontract", "purchase_order"] as const;
const STATUSES = [
  "draft",
  "out_for_bid",
  "out_for_signature",
  "approved",
  "complete",
  "terminated",
  "void",
] as const;

/** Row + the compliance position joined on. */
interface RegisterRow extends CommitmentListRow {
  compliance: ComplianceResult | undefined;
  complianceStatus: string;
  remaining: number;
}

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin:blocked",
    name: "Payment blocked",
    builtIn: true,
    state: { columnFilters: [{ id: "compliance", value: ["blocked"] }] },
  },
  {
    id: "builtin:subcontracts",
    name: "Subcontracts",
    builtIn: true,
    state: { columnFilters: [{ id: "kind", value: ["subcontract"] }] },
  },
  {
    id: "builtin:pos",
    name: "Purchase orders",
    builtIn: true,
    state: { columnFilters: [{ id: "kind", value: ["purchase_order"] }] },
  },
  {
    id: "builtin:buyout",
    name: "In buyout",
    builtIn: true,
    state: {
      columnFilters: [
        { id: "status", value: ["draft", "out_for_bid", "out_for_signature"] },
      ],
    },
  },
];

export default function RegisterTab({
  register,
  compliance,
  vendors,
  filters,
  onFilters,
  loading,
  error,
  onReload,
  onOpen,
}: {
  register: CommitmentList | null;
  compliance: ComplianceReport | null;
  vendors: Vendor[];
  filters: RegisterFilters;
  onFilters: (next: RegisterFilters) => void;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onOpen: (commitmentId: string) => void;
}) {
  const [showRail, setShowRail] = useState(true);

  const complianceById = useMemo(() => {
    const map = new Map<string, ComplianceResult>();
    for (const e of compliance?.entries ?? []) map.set(e.commitmentId, e.compliance);
    return map;
  }, [compliance]);

  const rows = useMemo<RegisterRow[]>(
    () =>
      (register?.items ?? []).map((c) => {
        const result = complianceById.get(c.id);
        return {
          ...c,
          compliance: result,
          complianceStatus: result?.status ?? "not_assessed",
          remaining: Number((c.revisedCommitmentSum - c.totalInvoiced).toFixed(2)),
        };
      }),
    [register, complianceById],
  );

  const columns = useMemo<DataColumns<RegisterRow>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      {
        id: "title",
        header: "Title",
        accessor: "title",
        type: "text",
        width: 260,
      },
      {
        id: "vendorName",
        header: "Vendor",
        accessor: (row) => row.vendorName ?? "",
        type: "text",
        width: 200,
        cell: ({ row }) =>
          row.vendorName ?? (
            <span className="italic text-content-subtle">no vendor bound</span>
          ),
      },
      {
        id: "kind",
        header: "Kind",
        accessor: "kind",
        type: "enum",
        width: 130,
        groupable: true,
        options: KINDS.map((k) => ({ value: k, text: KIND_LABEL[k] ?? k, label: KIND_LABEL[k] })),
        cell: ({ row }) => <Badge tone="neutral" size="xs">{KIND_LABEL[row.kind] ?? row.kind}</Badge>,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: STATUSES.map((s) => ({
          value: s,
          text: titleCase(s),
          label: titleCase(s),
          tone: statusToneOf(s),
        })),
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <Badge tone={statusToneOf(row.status)} dot size="xs">
              {titleCase(row.status)}
            </Badge>
            {row.executed === 1 ? (
              <Badge tone="success" variant="outline" size="xs">
                Executed
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "compliance",
        header: "Compliance",
        headerTooltip:
          "Read live from the insurance module's certificate and bond register at the moment this page loaded. A blocked commitment cannot have a payment issued against it.",
        accessor: "complianceStatus",
        type: "enum",
        width: 300,
        truncate: false,
        groupable: true,
        options: [
          { value: "blocked", text: COMPLIANCE_LABEL.blocked, label: COMPLIANCE_LABEL.blocked, tone: "danger" },
          { value: "warning", text: COMPLIANCE_LABEL.warning, label: COMPLIANCE_LABEL.warning, tone: "warning" },
          { value: "unknown", text: COMPLIANCE_LABEL.unknown, label: COMPLIANCE_LABEL.unknown, tone: "neutral" },
          { value: "compliant", text: COMPLIANCE_LABEL.compliant, label: COMPLIANCE_LABEL.compliant, tone: "success" },
          { value: "not_assessed", text: "Not assessed", label: "Not assessed", tone: "neutral" },
        ],
        cell: ({ row }) => <ComplianceCell result={row.compliance} />,
        toCsv: ({ row }) => {
          const r = row.compliance;
          if (!r) return "not assessed";
          const worst = r.blocking[0] ?? r.warnings[0] ?? null;
          return worst ? `${r.status}: ${worst.message}` : r.status;
        },
      },
      {
        id: "currency",
        header: "Ccy",
        accessor: "currency",
        type: "text",
        width: 70,
        groupable: true,
        align: "center",
      },
      moneyColumn("originalCommitmentSum", "Original sum"),
      moneyColumn("approvedChangeSum", "Approved changes", { signColor: true }),
      moneyColumn("revisedCommitmentSum", "Revised sum", { strong: true }),
      moneyColumn("totalInvoiced", "Invoiced to date"),
      moneyColumn("totalPaid", "Paid to date"),
      moneyColumn("remaining", "Remaining", {
        tooltip: "Revised commitment sum less invoiced to date, in the commitment's own currency.",
      }),
      moneyColumn("retainageHeld", "Retainage held"),
      {
        id: "estimatedCompletionDate",
        header: "Est. completion",
        accessor: "estimatedCompletionDate",
        type: "date",
        width: 140,
        defaultHidden: true,
        cell: ({ row }) => isoDate(row.estimatedCompletionDate),
      },
      {
        id: "paymentHold",
        header: "Hold",
        accessor: (row) => (row.paymentHold === 1 ? "On hold" : ""),
        type: "text",
        width: 220,
        defaultHidden: true,
        cell: ({ row }) =>
          row.paymentHold === 1 ? (
            <span className="text-2xs">
              <Badge tone="danger" size="xs" variant="solid">
                Hold
              </Badge>{" "}
              {row.complianceHoldReason ?? "No reason recorded."}
            </span>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
    ],
    [],
  );

  const buckets = register?.totalsByCurrency ?? [];

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} onRetry={onReload} />

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-4">
          <Field label="Kind">
            <Select
              value={filters.kind}
              onChange={(e) => onFilters({ ...filters, kind: e.target.value })}
            >
              <option value="">All kinds</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor">
            <Select
              value={filters.vendorId}
              onChange={(e) => onFilters({ ...filters, vendorId: e.target.value })}
            >
              <option value="">All vendors</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Search"
            hint="Matches the reference, the title and the scope of work."
          >
            <Input
              value={filters.q}
              placeholder="SC-0012, mechanical, …"
              onChange={(e) => onFilters({ ...filters, q: e.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      {showRail && buckets.length > 0 ? (
        <CurrencyTotalsRail buckets={buckets} mixed={register?.mixedCurrency ?? false} />
      ) : null}

      <ComplianceSummaryStrip report={compliance} />

      <DataTable<RegisterRow>
        tableId="commitments-register"
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        loadingRows={10}
        height={620}
        stickyHeader
        gridLines
        filterRow
        savedViews
        builtInViews={BUILT_IN_VIEWS}
        exportFileName="commitments-register"
        searchPlaceholder="Search the register…"
        defaultSort={[{ id: "reference", desc: false }]}
        rowTone={(row) => complianceRail(row.compliance)}
        onRowClick={({ row }) => onOpen(row.id)}
        rowActions={(row) => [
          { id: "open", label: "Open commitment", onSelect: () => onOpen(row.id) },
        ]}
        toolbarActions={
          <Button size="sm" variant="ghost" onClick={() => setShowRail((v) => !v)}>
            {showRail ? "Hide currency totals" : "Show currency totals"}
          </Button>
        }
        empty={{
          title: "No commitments on this project",
          description:
            "A commitment is a subcontract or a purchase order. Nothing has been bought here yet — the buyout log shows what the budget still expects to buy.",
        }}
        emptyFiltered={{
          title: "No commitment matches these filters",
          description: "Clear the kind, status or vendor filter to widen the register.",
        }}
        aria-label="Commitment register"
      />

      <p className="text-2xs text-content-subtle">
        Money columns carry no grand total. Adding a subcontract written in one currency to one
        written in another would produce a number nobody can spend, so the totals live in the
        per-currency rail above and stay separate there.
      </p>
    </div>
  );
}

/** Money columns share one shape and deliberately share one omission: no footer. */
function moneyColumn(
  id: keyof RegisterRow & string,
  header: string,
  options: { signColor?: boolean; strong?: boolean; tooltip?: string } = {},
) {
  return {
    id,
    header,
    ...(options.tooltip ? { headerTooltip: options.tooltip } : {}),
    accessor: id,
    type: "custom" as const,
    align: "right" as const,
    width: 150,
    mono: true,
    sortable: true,
    sortDescFirst: true,
    aggregate: "none" as const,
    ...(options.signColor ? { signColor: true } : {}),
    cell: ({ row, value }: { row: RegisterRow; value: unknown }) => (
      <span className={options.strong ? "font-semibold tabular-nums" : "tabular-nums"}>
        {money(typeof value === "number" ? value : null, row.currency)}
      </span>
    ),
    toCsv: ({ row, value }: { row: RegisterRow; value: unknown }) =>
      typeof value === "number" ? `${value} ${row.currency}` : "",
  };
}

function complianceRail(result: ComplianceResult | undefined): Tone | undefined {
  if (!result) return undefined;
  if (result.status === "compliant") return undefined;
  return complianceTone(result.status);
}

/** The register's headline: how many commitments cannot be paid right now. */
function ComplianceSummaryStrip({ report }: { report: ComplianceReport | null }) {
  if (!report) return null;
  const s = report.summary;
  if (s.total === 0) return null;
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label uppercase text-content-subtle">
            Compliance sweep, {report.asOf}
          </span>
          <Badge tone="danger" size="xs" variant={s.paymentBlocked > 0 ? "solid" : "subtle"}>
            {s.paymentBlocked} payment-blocked
          </Badge>
          <Badge tone="warning" size="xs">
            {s.warning} warned
          </Badge>
          <Badge tone="neutral" size="xs">
            {s.unknown} not asserted
          </Badge>
          <Badge tone="success" size="xs">
            {s.compliant} compliant
          </Badge>
          <span className="text-2xs text-content-subtle">of {s.total} live commitments</span>
        </div>
        {report.notes.map((note) => (
          <p key={note} className="text-2xs text-content-muted">
            {note}
          </p>
        ))}
      </CardBody>
    </Card>
  );
}
