/**
 * shell/NotificationsMenu.tsx — the bell and its popover.
 *
 * Every byte here is real: the list is GET /api/v1/notifications, the counter
 * is GET /api/v1/notifications/unread-count, "mark read" is
 * POST /api/v1/notifications/:id/read and "mark all read" is
 * POST /api/v1/notifications/read-all.
 *
 * Linking through: a notification carries `projectId`, `recordType` and
 * `recordId`. Only the record types that have a route in App.tsx are linked to
 * their record; everything else lands on the project it belongs to, and a
 * notification with no project opens the notifications page. We never invent a
 * deep link that would 404.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, EmptyState, Popover, Skeleton } from "../../ui";
import { cx } from "../../ui/cx";
import { formatRelativeTime } from "../../ui/data-table/format";
import { IconBell, IconInbox } from "../../ui/icons";
import { api } from "../../lib/api";
import { useShellData } from "./shell-data";

interface NotificationItem {
  id: string;
  kind?: string | null;
  title?: string | null;
  body?: string | null;
  readAt?: string | null;
  createdAt?: string | null;
  projectId?: string | null;
  recordType?: string | null;
  recordId?: string | null;
}

interface ListResponse<T> {
  items: T[];
  total: number;
}

/** recordType → the project sub-route that actually exists in App.tsx. */
const RECORD_ROUTES: Readonly<Record<string, { segment: string; detail: boolean }>> = {
  rfi: { segment: "rfis", detail: true },
  submittal: { segment: "submittals", detail: true },
  punch: { segment: "punch", detail: false },
  punch_item: { segment: "punch", detail: false },
  daily_log: { segment: "daily-logs", detail: false },
  invoice: { segment: "invoicing", detail: false },
  payment_claim: { segment: "payments", detail: false },
  benefit: { segment: "governance", detail: false },
  claim: { segment: "disputes", detail: false },
  sensor: { segment: "twin", detail: false },
};

export function notificationHref(item: NotificationItem): string {
  if (!item.projectId) return "/notifications";
  const route = item.recordType ? RECORD_ROUTES[item.recordType] : undefined;
  if (!route) return `/projects/${item.projectId}`;
  if (route.detail && item.recordId) {
    return `/projects/${item.projectId}/${route.segment}/${item.recordId}`;
  }
  return `/projects/${item.projectId}/${route.segment}`;
}

function kindTone(kind: string | null | undefined): string {
  switch (kind) {
    case "overdue":
    case "signal":
      return "danger";
    case "due_soon":
      return "warning";
    case "assignment":
    case "workflow_step":
      return "info";
    case "ai_review":
      return "highlight";
    case "status_change":
      return "success";
    default:
      return "neutral";
  }
}

function humanizeKind(kind: string | null | undefined): string {
  if (!kind) return "Update";
  return kind
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function NotificationsMenu() {
  const navigate = useNavigate();
  const { unreadNotifications, refreshCounts } = useShellData();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<NotificationItem>>(
        "/api/v1/notifications?page=1&pageSize=10",
      );
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Could not load notifications");
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const markRead = useCallback(
    async (item: NotificationItem) => {
      if (item.readAt) return;
      setItems((current) =>
        current
          ? current.map((entry) =>
              entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry,
            )
          : current,
      );
      try {
        await api.post(`/api/v1/notifications/${item.id}/read`);
      } catch {
        /* optimistic — the next open reconciles */
      }
      refreshCounts();
    },
    [refreshCounts],
  );

  const markAllRead = useCallback(async () => {
    setBusy(true);
    try {
      await api.post("/api/v1/notifications/read-all");
      await load();
      refreshCounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark everything read");
    } finally {
      setBusy(false);
    }
  }, [load, refreshCounts]);

  const unreadHere = (items ?? []).filter((item) => !item.readAt).length;
  const badgeCount = unreadNotifications;

  const trigger = (
    <button
      type="button"
      aria-label={
        badgeCount !== null && badgeCount > 0
          ? `Notifications, ${badgeCount} unread`
          : "Notifications"
      }
      className={cx(
        "relative grid size-8 shrink-0 place-items-center rounded-md text-content-muted",
        "transition-colors duration-fast hover:bg-surface-hover hover:text-content",
        "focus-visible:ring-2 focus-visible:ring-ring",
        open && "bg-surface-hover text-content",
      )}
    >
      <IconBell size={17} />
      {badgeCount !== null && badgeCount > 0 ? (
        <span
          className={cx(
            "absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1",
            "bg-accent text-[0.625rem] font-semibold tabular-nums text-accent-fg ring-2 ring-surface-raised",
          )}
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      ) : null}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      placement="bottom-end"
      width={380}
      padded={false}
      role="dialog"
      aria-label="Notifications"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-2 text-body font-medium text-content">
          Notifications
          {badgeCount !== null && badgeCount > 0 ? (
            <Badge tone="accent" size="xs">
              {badgeCount} unread
            </Badge>
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void markAllRead()}
          disabled={busy || unreadHere === 0}
        >
          Mark all read
        </Button>
      </div>

      <div className="max-h-[26rem] overflow-y-auto overscroll-contain">
        {items === null ? (
          <ul className="divide-y divide-border-subtle" aria-busy="true">
            {[0, 1, 2, 3].map((row) => (
              <li key={row} className="flex gap-2.5 px-3 py-2.5">
                <Skeleton className="mt-1.5 size-2 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4 rounded" />
                  <Skeleton className="h-3 w-1/3 rounded" />
                </div>
              </li>
            ))}
          </ul>
        ) : error ? (
          <div className="p-3">
            <EmptyState
              size="sm"
              tone="danger"
              title="Notifications did not load"
              hint={error}
              action={
                <Button size="xs" variant="secondary" onClick={() => void load()}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : items.length === 0 ? (
          <div className="p-3">
            <EmptyState
              size="sm"
              icon={IconInbox}
              title="Nothing yet"
              hint="Assignments, mentions, status changes and integrity signals land here."
            />
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    void markRead(item);
                    setOpen(false);
                    navigate(notificationHref(item));
                  }}
                  className={cx(
                    "flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors duration-fast",
                    "hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
                    item.readAt ? "" : "bg-accent-subtle/40",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      item.readAt ? "bg-border-strong" : "bg-accent",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cx(
                        "block truncate text-body",
                        item.readAt ? "text-content-muted" : "font-medium text-content",
                      )}
                    >
                      {item.title || humanizeKind(item.kind)}
                    </span>
                    {item.body ? (
                      <span className="mt-0.5 block truncate text-meta text-content-subtle">
                        {item.body}
                      </span>
                    ) : null}
                    <span className="mt-1 flex items-center gap-1.5">
                      <Badge tone={kindTone(item.kind)} size="xs">
                        {humanizeKind(item.kind)}
                      </Badge>
                      <span className="text-meta text-content-subtle">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-3 py-2">
        <Button
          variant="ghost"
          size="xs"
          fullWidth
          onClick={() => {
            setOpen(false);
            navigate("/notifications");
          }}
        >
          Open notification centre
        </Button>
      </div>
    </Popover>
  );
}
