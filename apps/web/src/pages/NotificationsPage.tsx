/**
 * The notification centre (Vol I §0.5 #93–#103).
 *
 *   · Inbox        — the feed, server-paginated, filterable by kind and
 *                    project, with "mark all read" scoped to the filter
 *   · Digest       — what my daily/weekly digest would contain right now
 *   · Preferences  — per-kind channels, digest cadence, project and tool
 *                    muting (#93–#97)
 *
 * Three findings this page closes:
 *   • the unread count came from the FIRST PAGE of rows, so "Mark all read"
 *     was disabled while older unread items existed and the bell disagreed
 *     with the page. The count now comes from GET /notifications/unread-count,
 *     which is the same source the shell badges from.
 *   • the list loaded pageSize=100 with no pagination and silently hid the
 *     rest.
 *   • marking read never told the shell, so the sidebar badge stayed stale
 *     for up to 60s. `refreshCounts()` is called after every mutation.
 *
 * Every panel fails alone, and a number the API did not return renders "—".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useShellData } from "../layouts/shell/shell-data";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Tabs,
} from "../ui";
import { Pagination } from "../ui/data";
import { IconBell, IconCheck, IconRefresh } from "../ui/icons";
import { dayLabel, formatDateTime, formatTime } from "./format";
import {
  asList,
  errorMessage,
  humanize,
  num,
  type DigestSummary,
  type NotificationPreferences,
  type NotificationRow,
  type UnreadCount,
} from "./admin/substrate";

const PAGE_SIZE = 25;

type TabKey = "inbox" | "digest" | "preferences";

function kindTone(kind: string | null | undefined) {
  switch (kind) {
    case "overdue":
    case "signal":
    case "escalation":
      return "danger" as const;
    case "due_soon":
      return "warning" as const;
    case "assignment":
    case "workflow_step":
    case "mention":
      return "info" as const;
    case "ai_review":
      return "highlight" as const;
    case "status_change":
      return "success" as const;
    default:
      return "neutral" as const;
  }
}

export default function NotificationsPage() {
  const [tab, setTab] = useState<TabKey>("inbox");
  const { refreshCounts } = useShellData();

  /* The authoritative unread count — not derived from the visible page. */
  const [unread, setUnread] = useState<UnreadCount | null>(null);
  const [unreadError, setUnreadError] = useState<string | null>(null);
  const loadUnread = useCallback(async () => {
    setUnreadError(null);
    try {
      setUnread(await api.get<UnreadCount>("/api/v1/notifications/unread-count"));
    } catch (err) {
      setUnread(null);
      setUnreadError(errorMessage(err, "Failed to load the unread count"));
    }
  }, []);

  useEffect(() => {
    void loadUnread();
  }, [loadUnread]);

  const afterMutation = useCallback(() => {
    void loadUnread();
    refreshCounts();
  }, [loadUnread, refreshCounts]);

  return (
    <div>
      <PageHeader
        title="Notifications"
        icon={IconBell}
        subtitle="Assignments, mentions, approvals, deadlines and integrity signals — and the rules that decide which of them reach you"
      />

      {unreadError ? (
        <Alert tone="warning" size="sm" className="mb-4">
          {unreadError} — the count below is unavailable, not zero.
        </Alert>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Unread"
          value={unread ? num(unread.count) : "—"}
          hint={unread ? undefined : "Count unavailable"}
          tone={unread && unread.count > 0 ? "info" : "neutral"}
        />
        <Stat
          label="Unread kinds"
          value={unread ? num(Object.keys(unread.byKind).length) : "—"}
          hint="Distinct kinds waiting on you"
        />
        <Stat
          label="Loudest kind"
          value={
            unread && Object.keys(unread.byKind).length > 0
              ? humanize(
                  Object.entries(unread.byKind).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
                )
              : "—"
          }
          hint={unread && unread.count === 0 ? "Nothing outstanding" : undefined}
        />
      </div>

      <div className="mb-4">
        <Tabs
          items={[
            { value: "inbox" as const, label: "Inbox", count: unread?.count },
            { value: "digest" as const, label: "Digest" },
            { value: "preferences" as const, label: "Preferences" },
          ]}
          value={tab}
          onChange={setTab}
          aria-label="Notification sections"
        />
      </div>

      {tab === "inbox" ? <InboxTab unread={unread} onChanged={afterMutation} /> : null}
      {tab === "digest" ? <DigestTab /> : null}
      {tab === "preferences" ? <PreferencesTab /> : null}
    </div>
  );
}

/* ============================== Inbox ================================== */

function InboxTab({
  unread,
  onChanged,
}: {
  unread: UnreadCount | null;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<NotificationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [kind, setKind] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shell = useShellData();
  const projects = shell.projects ?? [];

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (unreadOnly) params.set("unread", "true");
      if (kind) params.set("kind", kind);
      if (projectId) params.set("projectId", projectId);
      const res = await api.get<unknown>(`/api/v1/notifications?${params.toString()}`);
      const list = asList<NotificationRow>(res);
      setItems(list.items);
      setTotal(list.total);
    } catch (err) {
      setItems([]);
      setError(errorMessage(err, "Failed to load notifications"));
    }
  }, [page, unreadOnly, kind, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [unreadOnly, kind, projectId]);

  const groups = useMemo(() => {
    const map = new Map<string, NotificationRow[]>();
    for (const n of items ?? []) {
      const key = dayLabel(n.createdAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(n);
      else map.set(key, [n]);
    }
    return Array.from(map.entries());
  }, [items]);

  const kindOptions = useMemo(() => {
    const fromCounts = Object.keys(unread?.byKind ?? {});
    const fromRows = (items ?? []).map((n) => n.kind).filter((k): k is string => Boolean(k));
    return [...new Set([...fromCounts, ...fromRows])].sort();
  }, [unread, items]);

  async function markRead(n: NotificationRow) {
    if (n.readAt) return;
    setItems((prev) =>
      prev ? prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) : prev,
    );
    try {
      await api.post(`/api/v1/notifications/${n.id}/read`);
      onChanged();
    } catch {
      /* optimistic; the next load corrects any drift */
    }
  }

  async function markAllRead() {
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      if (kind) body["kind"] = kind;
      if (projectId) body["projectId"] = projectId;
      const res = await api.post<{ updated: number }>("/api/v1/notifications/read-all", body);
      toast.success(
        `${res.updated} notification${res.updated === 1 ? "" : "s"} marked read${
          kind ? ` in ${humanize(kind)}` : ""
        }`,
      );
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to mark notifications read"));
    } finally {
      setBusy(false);
    }
  }

  const nothingUnread = unread !== null && unread.count === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Kind" className="w-52">
          <Select value={kind} onChange={(e) => setKind(e.target.value)} size="sm">
            <option value="">All kinds</option>
            {kindOptions.map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
                {unread?.byKind[k] ? ` (${unread.byKind[k]} unread)` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Project" className="w-60">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} size="sm">
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" size="sm" onClick={() => setUnreadOnly((v) => !v)}>
          {unreadOnly ? "Show all" : "Unread only"}
        </Button>
        <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void load()}>
          Refresh
        </Button>
        <Button
          size="sm"
          leadingIcon={IconCheck}
          onClick={() => void markAllRead()}
          disabled={busy || nothingUnread}
          title={
            nothingUnread
              ? "Nothing unread"
              : kind || projectId
                ? "Marks everything matching the current filter"
                : "Marks everything read"
          }
        >
          {kind || projectId ? "Mark filtered read" : "Mark all read"}
        </Button>
        <span className="ml-auto text-2xs text-content-subtle">
          {num(total)} notification{total === 1 ? "" : "s"}
        </span>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {items === null ? (
        <Card>
          <CardBody className="space-y-2">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </CardBody>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={IconBell}
          title={unreadOnly ? "No unread notifications" : "No notifications match"}
          hint={
            kind || projectId || unreadOnly
              ? "Clear the filters to see the whole feed."
              : "Assignments, mentions, approvals, deadlines and integrity signals will land here."
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map(([day, list]) => (
            <div key={day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-subtle">
                {day}
              </h2>
              <Card>
                <ul className="divide-y divide-border-subtle">
                  {list.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => void markRead(n)}
                        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised ${
                          n.readAt ? "" : "bg-surface-sunken"
                        }`}
                      >
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                            n.readAt ? "bg-border-strong" : "bg-accent-solid"
                          }`}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block text-sm ${
                              n.readAt ? "text-content-default" : "font-semibold text-content-strong"
                            }`}
                          >
                            {n.title || humanize(n.kind)}
                          </span>
                          {n.body ? (
                            <span className="mt-0.5 block truncate text-xs text-content-muted">
                              {n.body}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge tone={kindTone(n.kind)}>{humanize(n.kind)}</Badge>
                          <span
                            className="text-xs text-content-subtle"
                            title={formatDateTime(n.createdAt)}
                          >
                            {formatTime(n.createdAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ))}
          {total > PAGE_SIZE ? (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
              size="sm"
              itemNoun="notifications"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ============================== Digest ================================= */

function DigestTab() {
  const [days, setDays] = useState(1);
  const [digest, setDigest] = useState<DigestSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDigest(await api.get<DigestSummary>(`/api/v1/me/notification-digest?days=${days}`));
    } catch (err) {
      setDigest(null);
      setError(errorMessage(err, "Failed to build the digest preview"));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Window" hint="How far back the digest looks" className="w-44">
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} size="sm">
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </Select>
        </Field>
        <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void load()}>
          Rebuild
        </Button>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {loading && !digest ? (
        <Skeleton className="h-40 w-full" />
      ) : !digest ? null : digest.total === 0 ? (
        <EmptyState
          title="Nothing new in this window"
          hint={`Between ${formatDateTime(digest.since)} and ${formatDateTime(digest.until)} nothing was raised for you. That is the digest — not an empty page.`}
        />
      ) : (
        <div className="space-y-4">
          <Alert tone="info" size="sm">
            <strong>{digest.subject}</strong> — this is exactly what the daily or weekly digest
            would carry, grouped by project then kind. It is composed on read and sends nothing.
          </Alert>
          {digest.sections.map((section) => (
            <Card key={section.projectId ?? "company"}>
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <h3 className="text-sm font-semibold text-content-strong">
                  {section.projectName ?? (section.projectId ? section.projectId : "Company-wide")}
                </h3>
                <Badge tone="neutral">{num(section.total)}</Badge>
              </div>
              <CardBody className="space-y-3">
                {section.byKind.map((group) => (
                  <div key={group.kind}>
                    <div className="mb-1 flex items-center gap-2">
                      <Badge tone={kindTone(group.kind)}>{humanize(group.kind)}</Badge>
                      <span className="text-2xs text-content-subtle">{num(group.count)}</span>
                    </div>
                    <ul className="space-y-1 pl-1">
                      {group.items.map((item) => (
                        <li key={item.id} className="text-xs text-content-muted">
                          <span className="text-content-default">{item.title}</span>
                          {item.body ? <span> — {item.body}</span> : null}
                        </li>
                      ))}
                      {group.count > group.items.length ? (
                        <li className="text-2xs text-content-subtle">
                          + {num(group.count - group.items.length)} more of this kind
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ))}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================ Preferences ============================== */

function PreferencesTab() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const shell = useShellData();
  const projects = shell.projects ?? [];

  const load = useCallback(async () => {
    setError(null);
    try {
      setPrefs(await api.get<NotificationPreferences>("/api/v1/me/notification-preferences"));
    } catch (err) {
      setPrefs(null);
      setError(errorMessage(err, "Failed to load your notification preferences"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Partial<NotificationPreferences>) {
    if (!prefs) return;
    setSaving(true);
    try {
      const body = {
        defaultChannel: patch.defaultChannel ?? prefs.defaultChannel,
        digest: patch.digest ?? prefs.digest,
        kinds: patch.kinds ?? prefs.kinds,
        mutedProjectIds: patch.mutedProjectIds ?? prefs.mutedProjectIds,
        mutedTools: patch.mutedTools ?? prefs.mutedTools,
      };
      const next = await api.put<NotificationPreferences>(
        "/api/v1/me/notification-preferences",
        body,
      );
      // The PUT answers with the stored row but without the catalogue; keep
      // the one we already have rather than blanking the form.
      setPrefs({ ...next, catalogue: prefs.catalogue });
      toast.success("Notification preferences saved");
    } catch (err) {
      setError(errorMessage(err, "Failed to save preferences"));
    } finally {
      setSaving(false);
    }
  }

  if (error && !prefs) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (!prefs) return <Skeleton className="h-64 w-full" />;

  const channels = prefs.catalogue?.channels ?? ["in_app", "email", "none"];
  const digests = prefs.catalogue?.digests ?? ["off", "daily", "weekly"];
  const kinds = prefs.catalogue?.kinds ?? [];

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />
      <Alert tone="info" size="sm">
        Urgent kinds — escalations, integrity signals and review requests — are always delivered
        in-app regardless of these settings. Muting a project cannot silence them.
      </Alert>

      <Card>
        <div className="border-b border-border-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-content-strong">Delivery</h3>
        </div>
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label="Default channel" hint="Used for any kind you have not overridden">
            <Select
              value={prefs.defaultChannel}
              disabled={saving}
              onChange={(e) => void save({ defaultChannel: e.target.value })}
            >
              {channels.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Digest"
            hint={
              prefs.lastDigestAt
                ? `Last digest ${formatDateTime(prefs.lastDigestAt)}`
                : "No digest has been produced yet"
            }
          >
            <Select
              value={prefs.digest}
              disabled={saving}
              onChange={(e) => void save({ digest: e.target.value })}
            >
              {digests.map((d) => (
                <option key={d} value={d}>
                  {d === "off" ? "Deliver as it happens" : humanize(d)}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <div className="border-b border-border-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-content-strong">Per kind</h3>
          <p className="mt-0.5 text-xs text-content-muted">
            {num(kinds.length)} kinds the platform raises. "None" suppresses a kind entirely
            except where it is urgent.
          </p>
        </div>
        <CardBody>
          {kinds.length === 0 ? (
            <EmptyState
              title="Kind catalogue unavailable"
              hint="The API did not return the list of notification kinds, so no per-kind control can be shown."
              bordered={false}
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {kinds.map((k) => (
                <label
                  key={k}
                  className="flex items-center justify-between gap-2 rounded border border-border-subtle px-2 py-1.5"
                >
                  <span className="truncate text-xs text-content-default">{humanize(k)}</span>
                  <Select
                    size="xs"
                    className="w-28"
                    value={prefs.kinds[k] ?? prefs.defaultChannel}
                    disabled={saving}
                    onChange={(e) =>
                      void save({ kinds: { ...prefs.kinds, [k]: e.target.value } })
                    }
                  >
                    {channels.map((c) => (
                      <option key={c} value={c}>
                        {humanize(c)}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <div className="border-b border-border-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-content-strong">Muted projects</h3>
          <p className="mt-0.5 text-xs text-content-muted">
            Ordinary notifications from these projects are suppressed. Escalations still arrive.
          </p>
        </div>
        <CardBody>
          {projects.length === 0 ? (
            <p className="text-xs text-content-muted">
              No projects are visible to you, so there is nothing to mute.
            </p>
          ) : (
            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => {
                const muted = prefs.mutedProjectIds.includes(p.id);
                return (
                  <label key={p.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={muted}
                      disabled={saving}
                      onChange={() =>
                        void save({
                          mutedProjectIds: muted
                            ? prefs.mutedProjectIds.filter((id) => id !== p.id)
                            : [...prefs.mutedProjectIds, p.id],
                        })
                      }
                    />
                    <span className="truncate text-content-default">{p.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
