/** Automatic callout links a person should look at: unresolved targets and low-confidence readings (#263). */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, DataTable, EmptyState, Select, type DataColumns } from "../../ui";
import { IconLink } from "../../ui/icons";
import { api, ApiClientError } from "../../lib/api";
import { useResource } from "../../layouts/project/lib";
import { pct, type LinkReviewItem } from "./drawingsShared";
import type { ListResponse, SheetListItem } from "./types";

export default function LinksTab({ projectId, version, onChanged }: { projectId: string; version: number; onChanged: () => void }) {
  const review = useResource<ListResponse<LinkReviewItem>>(`/api/v1/projects/${projectId}/hyperlinks/review?_v=${version}`);
  const sheets = useResource<ListResponse<SheetListItem>>(`/api/v1/projects/${projectId}/sheets?pageSize=500&_v=${version}`);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(link: LinkReviewItem, action: "accept" | "reject") {
    setBusy(`${action}:${link.id}`);
    setError(null);
    try {
      const body: Record<string, unknown> = { action };
      const chosen = targets[link.id];
      if (action === "accept" && chosen) body["toSheetId"] = chosen;
      await api.post(`/api/v1/hyperlinks/${link.id}/review`, body);
      review.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The review action failed");
    } finally {
      setBusy(null);
    }
  }

  const items = review.data?.items ?? [];
  const columns = useMemo<DataColumns<LinkReviewItem>>(
    () => [
      { id: "from", header: "On sheet", accessor: (r) => r.from.number, type: "code", width: 150, mono: true, sticky: "start", cell: ({ row }) => <Link to={row.from.sheetId} className="text-brand-700 hover:underline">{row.from.number} <span className="text-ink-400">rev {row.from.revision}</span></Link> },
      { id: "label", header: "Callout", accessor: (r) => r.label ?? "", type: "text", width: 180, cell: ({ row }) => <span className="font-mono text-xs">{row.label ?? "—"}</span> },
      { id: "target", header: "Names", accessor: (r) => r.targetNumber ?? "", type: "code", width: 110, mono: true },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, cell: ({ row }) => <Badge tone={row.status === "unresolved" ? "danger" : "warning"} size="xs" dot>{row.status}</Badge> },
      { id: "confidence", header: "Confidence", accessor: (r) => r.confidence ?? 0, type: "number", align: "right", width: 100, cell: ({ row }) => pct(row.confidence) },
      { id: "reason", header: "Why it is here", accessor: "reason", type: "text", width: 320, truncate: true },
      {
        id: "actions",
        header: "",
        width: 360,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 py-0.5" onClick={(e) => e.stopPropagation()}>
            {row.status === "unresolved" ? (
              <Select value={targets[row.id] ?? ""} onChange={(e) => setTargets((p) => ({ ...p, [row.id]: e.target.value }))} className="w-44 py-1! text-xs">
                <option value="">Meant sheet…</option>
                {(sheets.data?.items ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.number}</option>
                ))}
              </Select>
            ) : null}
            <Button size="xs" disabled={busy !== null || (row.status === "unresolved" && !targets[row.id])} loading={busy === `accept:${row.id}`} onClick={() => void act(row, "accept")}>
              Accept
            </Button>
            <Button size="xs" variant="ghost" disabled={busy !== null} loading={busy === `reject:${row.id}`} onClick={() => void act(row, "reject")}>
              Reject
            </Button>
          </span>
        ),
      },
    ],
    [busy, targets, sheets.data],
  );

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger" title="Refused" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {review.error ? <Alert tone="danger" title="The link review list could not be loaded">{review.error}</Alert> : null}
      {!review.loading && items.length === 0 ? (
        <EmptyState icon={IconLink} title="No callout links need a decision" hint="Every automatic hyperlink either resolved to a sheet at good confidence or has been reviewed. Unresolved callouts also clear themselves when the missing sheet is uploaded or named." />
      ) : (
        <DataTable<LinkReviewItem> tableId="hyperlink-review" data={items} columns={columns} getRowId={(r) => r.id} loading={review.loading} height={520} stickyHeader gridLines toolbar={false} empty={{ title: "Nothing to review" }} aria-label="Hyperlink review" />
      )}
      <p className="text-xs text-ink-400">Accepting marks the link confirmed by a person; rejecting hides it from the viewer. A link's confidence is the regex reading's own estimate and never reaches 100%.</p>
    </div>
  );
}
