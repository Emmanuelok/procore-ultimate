/**
 * The review queue: everything an agent proposed and nobody has decided yet.
 *
 * Clicking a row opens the proposal itself — see ReviewDrawer. The table
 * shows only what is safe to show in a list (summary, target, confidence,
 * age) and marks stale items so a queue that has been ignored looks ignored.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Badge, ErrorAlert, Field, Select } from "../../ui";
import { DataTable, Pagination, type DataColumns } from "../../ui/data";
import {
  asList,
  confidenceBand,
  errorMessage,
  formatDateTime,
  humanize,
  pct,
  REVIEW_STATUS_TONE,
  type ReviewItem,
} from "./agentsShared";
import ReviewDrawer from "./ReviewDrawer";

const PAGE_SIZE = 50;

export default function QueueTab({
  base = "/api/v1/ai/review",
  onChanged,
  nonce = 0,
}: {
  /** company-wide by default; the project workspace passes its own path */
  base?: string;
  onChanged?: () => void;
  nonce?: number;
}) {
  const [rows, setRows] = useState<ReviewItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("pending");
  const [stale, setStale] = useState(false);
  const [staleAfterDays, setStaleAfterDays] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set("status", status);
      if (stale) params.set("stale", "1");
      const res = await api.get<unknown>(`${base}?${params.toString()}`);
      const list = asList<ReviewItem>(res);
      setRows(list.items);
      setTotal(list.total);
      const days = (res as { staleAfterDays?: number }).staleAfterDays;
      if (typeof days === "number") setStaleAfterDays(days);
    } catch (err) {
      setError(errorMessage(err, "Failed to load the review queue"));
      setRows((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [base, page, status, stale]);

  useEffect(() => {
    void load();
  }, [load, nonce]);
  useEffect(() => {
    setPage(1);
  }, [status, stale]);

  const columns = useMemo<DataColumns<ReviewItem>>(
    () => [
      {
        id: "createdAt",
        header: "Raised",
        accessor: "createdAt",
        width: 160,
        cell: ({ row }) => <span className="text-ink-600">{formatDateTime(row.createdAt)}</span>,
      },
      {
        id: "targetType",
        header: "Proposes",
        accessor: "targetType",
        width: 180,
        cell: ({ row }) => <Badge tone="info">{humanize(row.targetType)}</Badge>,
      },
      { id: "summary", header: "Summary", accessor: "summary", width: 420 },
      {
        id: "confidence",
        header: "Confidence",
        accessor: "confidence",
        width: 130,
        cell: ({ row }) => {
          const band = confidenceBand(row.confidence);
          return (
            <Badge tone={band.tone}>
              {pct(row.confidence)} {band.label}
            </Badge>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        width: 120,
        cell: ({ row }) => (
          <Badge tone={REVIEW_STATUS_TONE[row.status] ?? "neutral"}>{humanize(row.status)}</Badge>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Status" className="w-48">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="superseded">Superseded</option>
            <option value="reverted">Reverted</option>
            <option value="">All</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-xs text-ink-600">
          <input
            type="checkbox"
            checked={stale}
            onChange={(e) => setStale(e.target.checked)}
            className="size-3.5"
          />
          Only proposals nobody decided
          {staleAfterDays ? ` within ${staleAfterDays} days` : ""}
        </label>
      </div>
      <ErrorAlert message={error} />
      <DataTable<ReviewItem>
        tableId="agent-review-queue"
        data={rows ?? []}
        columns={columns}
        loading={loading && !rows}
        height={520}
        stickyHeader
        onRowClick={({ row }) => setOpenId(row.id)}
        empty={{
          title: status === "pending" ? "Nothing is waiting for a human" : "No proposals here",
          description:
            "Agents propose; a person with the owning tool's standard level decides. Open a proposal to read it before approving.",
        }}
        aria-label="AI review queue"
      />
      {total > PAGE_SIZE ? (
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} size="sm" itemNoun="proposals" />
      ) : null}

      <ReviewDrawer
        reviewId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          void load();
          onChanged?.();
        }}
      />
    </div>
  );
}
