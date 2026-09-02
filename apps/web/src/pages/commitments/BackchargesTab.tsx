/**
 * THE BACKCHARGE REGISTER, PROJECT-WIDE (#538).
 *
 * The per-commitment panel is where a backcharge is raised; this is where the
 * project sees the whole recovery position at once — how much is open against
 * which subcontractor, and therefore how much is RESERVED against their next
 * payment. Open recoveries are bucketed by currency and never added together.
 *
 * The register is deliberately read-and-navigate: a backcharge is issued,
 * disputed and settled against its own commitment, where the evidence and the
 * change order it raises live.
 */
import { useMemo } from "react";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  Spinner,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { isoDate, money, titleCase, useResource } from "./shared";

interface BackchargeRow {
  id: string;
  reference: string;
  commitmentId: string;
  vendorId: string | null;
  reasonCode: string;
  title: string;
  amount: number;
  currency: string;
  status: string;
  evidence: Array<{ type: string; id: string; label?: string }>;
  issuedAt: string | null;
  settledAt: string | null;
  createdAt: string;
}

interface Summary {
  openCount: number;
  openByCurrency: Array<{ currency: string; amount: number }>;
  commitmentsWithOpen: Array<{ id: string; reference: string }>;
  total: number;
}

function tone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status) {
    case "settled":
      return "success";
    case "issued":
      return "info";
    case "disputed":
      return "warning";
    case "void":
      return "danger";
    default:
      return "neutral";
  }
}

export default function BackchargesTab({
  projectId,
  onOpenCommitment,
}: {
  projectId: string;
  onOpenCommitment: (commitmentId: string) => void;
}) {
  const list = useResource<{ items: BackchargeRow[]; total: number }>(
    `/api/v1/projects/${projectId}/backcharges?page=1&pageSize=200`,
  );
  const summary = useResource<Summary>(`/api/v1/projects/${projectId}/backcharges/summary`);

  const refByCommitment = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of summary.data?.commitmentsWithOpen ?? []) map.set(c.id, c.reference);
    return map;
  }, [summary.data]);

  const columns = useMemo<DataColumns<BackchargeRow>>(
    () => [
      {
        id: "reference",
        header: "Ref",
        accessor: "reference",
        type: "code",
        width: 110,
        mono: true,
        sticky: "start",
      },
      {
        id: "title",
        header: "What is being recovered",
        accessor: "title",
        type: "text",
        width: 280,
      },
      {
        id: "reasonCode",
        header: "Reason",
        accessor: (r) => titleCase(r.reasonCode),
        type: "text",
        width: 180,
      },
      {
        id: "commitment",
        header: "Commitment",
        accessor: (r) => refByCommitment.get(r.commitmentId) ?? r.commitmentId,
        type: "custom",
        width: 140,
        cell: ({ row }) => (
          <button
            type="button"
            className="font-mono text-2xs text-accent-text underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onOpenCommitment(row.commitmentId);
            }}
          >
            {refByCommitment.get(row.commitmentId) ?? "open"}
          </button>
        ),
      },
      {
        id: "amount",
        header: "Amount",
        accessor: "amount",
        type: "custom",
        width: 140,
        align: "right",
        mono: true,
        cell: ({ row }) => <span>{money(row.amount, row.currency)}</span>,
      },
      {
        id: "evidence",
        header: "Evidence",
        accessor: (r) => r.evidence.length,
        type: "custom",
        width: 110,
        align: "right",
        cell: ({ row }) =>
          row.evidence.length === 0 ? (
            <span
              className="text-2xs text-warning-fg"
              title="A backcharge cannot be issued without evidence behind it."
            >
              none yet
            </span>
          ) : (
            <span className="text-2xs">{row.evidence.length}</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "custom",
        width: 120,
        cell: ({ row }) => (
          <Badge tone={tone(row.status)} dot size="xs">
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "issuedAt",
        header: "Issued",
        accessor: (r) => r.issuedAt ?? "",
        type: "custom",
        width: 120,
        cell: ({ row }) => <span className="text-2xs">{isoDate(row.issuedAt)}</span>,
      },
    ],
    [refByCommitment, onOpenCommitment],
  );

  const rows = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <Alert tone="info" variant="subtle" size="sm" title="An open backcharge holds money back">
        Issuing a backcharge raises a NEGATIVE change order that somebody else approves. Until it
        settles, its amount is reserved against the vendor&rsquo;s next payment — the payment route
        refuses anything that would breach the reserved ceiling and says by how much.
      </Alert>

      <ErrorAlert message={list.error ?? summary.error} />

      {summary.data ? (
        <Card>
          <CardHeader
            title="Open recovery"
            subtitle={`${summary.data.openCount} of ${summary.data.total} backcharge(s) are issued or disputed.`}
          />
          <CardBody className="grid gap-3 sm:grid-cols-3">
            {summary.data.openByCurrency.length === 0 ? (
              <p className="text-meta text-content-subtle">
                Nothing is open, so no payment is being held back.
              </p>
            ) : (
              summary.data.openByCurrency.map((c) => (
                <div key={c.currency}>
                  <div className="text-label uppercase text-content-subtle">
                    Reserved · {c.currency}
                  </div>
                  <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-warning-fg">
                    {money(c.amount, c.currency)}
                  </div>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      ) : null}

      {list.loading && !list.data ? (
        <Spinner label="Loading the backcharge register…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No backcharges on this project"
          hint="Cost recovered from a subcontractor — cleanup, damage, defective work — belongs on the record with its evidence, not as a deduction somebody remembers to make."
        />
      ) : (
        <DataTable<BackchargeRow>
          tableId="project-backcharges"
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          height={460}
          stickyHeader
          gridLines
          savedViews={false}
          exportFileName={`backcharges-${projectId}`}
          onRowClick={({ row }) => onOpenCommitment(row.commitmentId)}
          aria-label="Backcharge register"
        />
      )}
    </div>
  );
}
