/**
 * PROGRESS BILLING — the register of applications for payment, and the S-curve
 * of what has actually been billed against what is scheduled.
 *
 * Opening an application snapshots the schedule of values into a continuation
 * sheet. Only one may be open at a time per contract: two drafts against one
 * schedule would each snapshot the same `previousBilled` and bill the same
 * work twice, and the API refuses the second. That refusal is shown as sent.
 *
 * The S-curve draws nothing it does not have. With no certified application
 * there is no actual curve, and the chart says why rather than drawing a flat
 * line at zero — which would be a claim that nothing has been billed.
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
  Spinner,
} from "../../ui";
import { ChartCard, SCurveChart } from "../../ui/charts";
import { DataTable, type DataColumns } from "../../ui/data";
import Certificate from "./Certificate";
import {
  RefusalPanel,
  isoDate,
  money,
  statusToneOf,
  titleCase,
  useAction,
  useBilling,
  type Loadable,
} from "./shared";
import type { ContractView, Paginated, PaymentApplication } from "./types";

export default function BillingTab({
  contract,
  billings,
  onChanged,
}: {
  contract: ContractView;
  billings: Loadable<Paginated<PaymentApplication>>;
  onChanged: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const billing = useBilling(contract.id, openId);
  const cur = contract.currency;
  const rows = billings.data?.items ?? [];

  /** Oldest first — an S-curve read right to left is not an S-curve. */
  const chronological = useMemo(
    () => [...rows].sort((a, b) => a.number - b.number),
    [rows],
  );

  const curve = useMemo(
    () =>
      chronological.map((a) => ({
        period: a.periodTo ?? a.applicationDate ?? a.reference,
        reference: a.reference,
        billed: a.totalCompletedAndStored,
        scheduled: a.contractSumToDate,
        certified: a.certifiedAmount,
      })),
    [chronological],
  );

  const columns = useMemo<DataColumns<PaymentApplication>>(
    () => [
      {
        id: "reference",
        header: "Application",
        accessor: "reference",
        type: "code",
        width: 140,
        sticky: "start",
        mono: true,
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
        id: "periodTo",
        header: "Period to",
        accessor: "periodTo",
        type: "date",
        width: 120,
        cell: ({ row }) => isoDate(row.periodTo),
      },
      {
        id: "contractSumToDate",
        header: "Contract sum to date",
        headerTooltip: "G702 line 3.",
        accessor: "contractSumToDate",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 180,
        mono: true,
        aggregate: "none",
      },
      {
        id: "totalCompletedAndStored",
        header: "Completed and stored",
        headerTooltip: "G702 line 4.",
        accessor: "totalCompletedAndStored",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 190,
        mono: true,
        aggregate: "none",
      },
      {
        id: "totalRetainage",
        header: "Retainage",
        headerTooltip: "G702 line 5.",
        accessor: "totalRetainage",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        aggregate: "none",
      },
      {
        id: "currentPaymentDue",
        header: "Current payment due",
        headerTooltip: "G702 line 8.",
        accessor: "currentPaymentDue",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 180,
        mono: true,
        aggregate: "none",
      },
      {
        id: "certifiedAmount",
        header: "Certified",
        accessor: (row) => row.certifiedAmount,
        type: "custom",
        align: "right",
        width: 190,
        truncate: false,
        cell: ({ row }) =>
          row.certifiedAmount === null ? (
            <span className="text-2xs italic text-content-subtle">
              not certified, so no certified amount exists
            </span>
          ) : (
            <span className="font-mono tabular-nums">
              {money(row.certifiedAmount, cur)}
              {row.certifiedAmount < row.currentPaymentDue ? (
                <span className="block text-2xs text-warning-fg">
                  short by {money(row.currentPaymentDue - row.certifiedAmount, cur)}
                </span>
              ) : null}
            </span>
          ),
        toCsv: ({ row }) => (row.certifiedAmount === null ? "not certified" : row.certifiedAmount),
      },
      {
        id: "paidAmount",
        header: "Paid",
        accessor: "paidAmount",
        type: "currency",
        currency: cur,
        precision: 2,
        align: "right",
        width: 140,
        mono: true,
        aggregate: "none",
      },
    ],
    [cur],
  );

  if (openId) {
    return (
      <Certificate
        contract={contract}
        billing={billing}
        onChanged={() => {
          billings.reload();
          onChanged();
        }}
        onBack={() => setOpenId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <RefusalPanel refusal={refusal} onDismiss={clear} />

      {contract.executed !== 1 ? (
        <Alert tone="warning" title="This contract is not executed">
          An unexecuted contract cannot be billed against — there is no signed schedule of values
          behind the claim. Record the execution on the Summary tab first.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-subtle">
          {rows.length} application{rows.length === 1 ? "" : "s"} against{" "}
          {contract.reference} · billed {money(contract.totalBilled, cur)} of{" "}
          {money(contract.revisedContractSum, cur)}
        </p>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          disabled={contract.executed !== 1 || busy !== null}
        >
          Open an application
        </Button>
      </div>

      <SCurve curve={curve} contract={contract} loading={billings.loading} />

      {rows.length === 0 && !billings.loading ? (
        <EmptyState
          title="No applications for payment yet"
          hint="An application snapshots the schedule of values for a period and computes the G702 from it. Nothing has been billed against this contract."
        />
      ) : billings.loading && rows.length === 0 ? (
        <div className="py-10">
          <Spinner label="Loading applications…" />
        </div>
      ) : (
        <DataTable<PaymentApplication>
          tableId="prime-billings"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={billings.loading}
          height={380}
          stickyHeader
          gridLines
          savedViews={false}
          exportFileName={`applications-${contract.reference}`}
          defaultSort={[{ id: "reference", desc: true }]}
          onRowClick={({ row }) => setOpenId(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Open the certificate", onSelect: () => setOpenId(row.id) },
          ]}
          aria-label={`Applications for payment against ${contract.reference}`}
        />
      )}

      <p className="text-2xs text-content-subtle">
        Money columns carry no total. Adding two applications together would double-count: each
        one&rsquo;s line 4 is cumulative to date, not a period figure.
      </p>

      <CreateApplication
        open={creating}
        contract={contract}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          billings.reload();
          onChanged();
          setOpenId(id);
        }}
      />
    </div>
  );
}

/**
 * Billed against scheduled, over the billing periods. A contract with no
 * applications has no curve, and the chart says so with the reason rather than
 * drawing a baseline.
 */
function SCurve({
  curve,
  contract,
  loading,
}: {
  curve: ReadonlyArray<{
    period: string;
    reference: string;
    billed: number;
    scheduled: number;
    certified: number | null;
  }>;
  contract: ContractView;
  loading: boolean;
}) {
  const cur = contract.currency;
  return (
    <ChartCard
      title="Billed against scheduled value"
      subtitle="Cumulative, by application period"
      metric={money(contract.totalBilled, cur)}
      metricCaption={`of ${money(contract.revisedContractSum, cur)} revised contract sum`}
      footnote="Every point is one application's cumulative total completed and stored to date (G702 line 4) against the contract sum in force for that application (line 3)."
    >
      <SCurveChart
        data={curve as ReadonlyArray<Record<string, unknown>>}
        keys={{ period: "period", planned: "scheduled", actual: "billed" }}
        labels={{ planned: "Scheduled value", actual: "Billed to date" }}
        valueFormat="currency"
        formatOptions={{ currency: cur }}
        target={contract.revisedContractSum}
        targetLabel="Revised contract sum"
        height={280}
        loading={loading}
        emptyTitle="No curve to draw"
        emptyMessage={
          contract.executed !== 1
            ? "This contract is not executed, so nothing can have been billed against it yet."
            : "No application for payment has been raised against this contract, so there is nothing billed to plot. A flat line at zero would be a claim about the project, not an absence of data."
        }
        ariaLabel={`Billed against scheduled value for ${contract.reference}`}
      />
    </ChartCard>
  );
}

function CreateApplication({
  open,
  contract,
  onClose,
  onCreated,
}: {
  open: boolean;
  contract: ContractView;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [billingDate, setBillingDate] = useState(today);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [dueDate, setDueDate] = useState("");

  async function submit() {
    const created = await run("create", () =>
      api.post<{ application: { id: string } }>(
        `/api/v1/prime-contracts/${contract.id}/billings`,
        {
          billingDate,
          ...(periodStart ? { periodStart } : {}),
          ...(periodEnd ? { periodEnd } : {}),
          ...(dueDate ? { dueDate } : {}),
        },
      ),
    );
    if (created !== null && created?.application?.id) onCreated(created.application.id);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Open an application against ${contract.reference}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!billingDate || busy !== null}>
            Open the application
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <p className="text-meta text-content-muted">
          The application is populated from the contract&rsquo;s schedule of values, and the
          schedule must balance to the contract sum before it can be opened. Only one application
          may be open at a time on a contract.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Billing date" required>
            <Input
              type="date"
              value={billingDate}
              onChange={(e) => setBillingDate(e.target.value)}
            />
          </Field>
          <Field label="Due date" optional>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Period start" optional>
            <Input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </Field>
          <Field label="Period end" optional>
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
