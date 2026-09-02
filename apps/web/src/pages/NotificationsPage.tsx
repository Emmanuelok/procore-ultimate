import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Badge, Button, Card, EmptyState, ErrorAlert, PageHeader, Spinner } from "../ui";
import { dayLabel, formatTime, humanize } from "./format";

interface NotificationItem {
  id: string;
  kind?: string | null;
  title?: string | null;
  body?: string | null;
  readAt?: string | null;
  createdAt?: string | null;
  projectId?: string | null;
}

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function kindTone(kind: string | null | undefined): string {
  switch (kind) {
    case "overdue":
    case "signal":
      return "red";
    case "due_soon":
      return "amber";
    case "assignment":
    case "workflow_step":
      return "blue";
    case "ai_review":
      return "violet";
    case "status_change":
      return "green";
    default:
      return "gray";
  }
}

export default function NotificationsPage() {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = unreadOnly ? "?unread=true&pageSize=100" : "?pageSize=100";
      const res = await api.get<ListResponse<NotificationItem>>(`/api/v1/notifications${qs}`);
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load notifications");
    }
  }, [unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, NotificationItem[]>();
    for (const n of items ?? []) {
      const key = dayLabel(n.createdAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(n);
      else map.set(key, [n]);
    }
    return Array.from(map.entries());
  }, [items]);

  const unreadCount = (items ?? []).filter((n) => !n.readAt).length;

  async function markRead(n: NotificationItem) {
    if (n.readAt) return;
    setItems((prev) =>
      prev
        ? prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x))
        : prev,
    );
    try {
      await api.post(`/api/v1/notifications/${n.id}/read`);
    } catch {
      /* optimistic; refresh corrects drift */
    }
  }

  async function markAllRead() {
    setBusy(true);
    try {
      await api.post("/api/v1/notifications/read-all");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark all read");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle={
          unreadCount > 0 ? `${unreadCount} unread` : "You're up to date"
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setUnreadOnly((v) => !v)}
            >
              {unreadOnly ? "Show all" : "Unread only"}
            </Button>
            <Button size="sm" onClick={markAllRead} disabled={busy || unreadCount === 0}>
              Mark all read
            </Button>
          </>
        }
      />

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title={unreadOnly ? "No unread notifications" : "No notifications yet"}
          hint="Assignments, mentions, status changes and integrity signals will land here."
        />
      ) : (
        <div className="space-y-6">
          {groups.map(([day, list]) => (
            <div key={day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
                {day}
              </h2>
              <Card>
                <ul className="divide-y divide-ink-100">
                  {list.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => void markRead(n)}
                        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50 ${
                          n.readAt ? "" : "bg-brand-50/50"
                        }`}
                      >
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                            n.readAt ? "bg-ink-200" : "bg-brand-600"
                          }`}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block text-sm ${
                              n.readAt ? "text-ink-700" : "font-semibold text-ink-900"
                            }`}
                          >
                            {n.title || humanize(n.kind)}
                          </span>
                          {n.body ? (
                            <span className="mt-0.5 block truncate text-xs text-ink-500">
                              {n.body}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge tone={kindTone(n.kind)}>{humanize(n.kind)}</Badge>
                          <span className="text-xs text-ink-400">{formatTime(n.createdAt)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
