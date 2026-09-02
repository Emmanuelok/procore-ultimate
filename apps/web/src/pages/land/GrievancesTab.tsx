/**
 * Community grievance redress mechanism (spec Domain J #569-574). Intake by
 * every channel including genuinely anonymous, a severity-driven SLA whose
 * clock is visible on every row, and closure that only counts when the
 * complainant says the resolution actually worked.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { GRIEVANCE_CHANNELS, GRIEVANCE_SEVERITIES, GRIEVANCE_STATUSES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { Donut, HBars, MonthlyBars, type Datum } from "./charts";
import {
  GRIEVANCE_RAIL,
  dueBadge,
  fmtNum,
  fmtShare,
  grievanceStatusTone,
  railIndex,
  severityTone,
  type GrievanceAnalytics,
  type GrievanceRow,
  type ListResponse,
  type UserLite,
} from "./landShared";

const CATEGORIES = [
  "land",
  "noise",
  "dust",
  "access",
  "employment",
  "conduct",
  "compensation",
  "other",
] as const;

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "red" | "amber" | "green";
}) {
  const cls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "green"
          ? "text-emerald-700"
          : "text-ink-900";
  return (
    <Card>
      <CardBody className="px-4 py-3">
        <div className={`text-xl font-bold tabular-nums ${cls}`}>{value}</div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
          {label}
        </div>
        {hint ? <div className="mt-1 text-xs text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

/**
 * Channel chip. An anonymous grievance wears a lock rather than a name,
 * because the point of the anonymous channel is that there is nothing to
 * show — not that the name field happens to be empty.
 */
function ChannelChip({ channel, anonymous }: { channel: string; anonymous: boolean }) {
  if (anonymous) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800"
        title="Anonymous intake — no identifying data is held on the record or in the ledger"
      >
        <span aria-hidden>🔒</span>
        {channel === "anonymous" ? "Anonymous" : `${humanize(channel)} · anonymous`}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-700">
      {humanize(channel)}
    </span>
  );
}

/** The five rail states a grievance walks (#572-573), off-rail states noted. */
function LifecycleRail({ g }: { g: GrievanceRow }) {
  const reached = railIndex(g);
  const offRail = g.status === "escalated" || g.status === "rejected";
  return (
    <div>
      <ol className="flex flex-wrap items-center gap-y-2">
        {GRIEVANCE_RAIL.map((stage, i) => {
          const done = i <= reached;
          const current = i === reached && !offRail;
          return (
            <li key={stage} className="flex items-center">
              <div className="flex flex-col items-center gap-1">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ring-2 ${
                    current
                      ? "bg-brand-600 text-white ring-brand-200"
                      : done
                        ? "bg-brand-100 text-brand-800 ring-brand-100"
                        : "bg-white text-ink-300 ring-ink-200"
                  }`}
                  aria-current={current ? "step" : undefined}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span
                  className={`px-1 text-[11px] ${
                    current ? "font-semibold text-brand-700" : done ? "text-ink-600" : "text-ink-300"
                  }`}
                >
                  {humanize(stage)}
                </span>
              </div>
              {i < GRIEVANCE_RAIL.length - 1 ? (
                <span
                  aria-hidden
                  className={`mx-1 mb-4 h-0.5 w-6 rounded ${
                    i < reached ? "bg-brand-300" : "bg-ink-200"
                  }`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {offRail ? (
        <p className="mt-2 text-xs text-ink-500">
          Currently <Badge tone={grievanceStatusTone(g.status)}>{humanize(g.status)}</Badge> — off
          the standard rail; the marker shows the last stage actually reached.
        </p>
      ) : null}
    </div>
  );
}

export default function GrievancesTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [rows, setRows] = useState<GrievanceRow[] | null>(null);
  const [analytics, setAnalytics] = useState<GrievanceAnalytics | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selected, setSelected] = useState<GrievanceRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ pageSize: "200" });
      if (statusFilter) qs.set("status", statusFilter);
      if (severityFilter) qs.set("severity", severityFilter);
      if (categoryFilter) qs.set("category", categoryFilter);
      if (overdueOnly) qs.set("overdue", "true");
      const [list, an] = await Promise.all([
        api.get<ListResponse<GrievanceRow>>(`${base}/grievances?${qs.toString()}`),
        api.get<GrievanceAnalytics>(`${base}/grievances/analytics`),
      ]);
      setRows(list.items);
      setAnalytics(an);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load the grievance register");
    }
  }, [base, statusFilter, severityFilter, categoryFilter, overdueOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<ListResponse<UserLite>>("/api/v1/company/users?pageSize=200");
        if (!cancelled) setUsers(res.items ?? []);
      } catch {
        // the assignee picker degrades to showing the raw id
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const userName = (id: string | null) =>
    id === null ? null : (users.find((u) => u.id === id)?.name ?? id);

  /* --------------------------------- intake -------------------------------- */

  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<string>("in_person");
  const [anonymous, setAnonymous] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [category, setCategory] = useState<string>("dust");
  const [severity, setSeverity] = useState<string>("medium");
  const [description, setDescription] = useState("");
  const [receivedAt, setReceivedAt] = useState("");

  const anonymousEffective = anonymous || channel === "anonymous";

  function openIntake() {
    setIntakeError(null);
    setChannel("in_person");
    setAnonymous(false);
    setName("");
    setContact("");
    setCategory("dust");
    setSeverity("medium");
    setDescription("");
    setReceivedAt(new Date().toISOString().slice(0, 10));
    setIntakeOpen(true);
  }

  /** Toggling anonymity does not merely hide the PII fields — it clears them. */
  function setAnonymousFlag(next: boolean) {
    setAnonymous(next);
    if (next) {
      setName("");
      setContact("");
    }
  }

  function setChannelValue(next: string) {
    setChannel(next);
    if (next === "anonymous") {
      setName("");
      setContact("");
    }
  }

  async function onIntake(e: FormEvent) {
    e.preventDefault();
    setIntakeError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        channel,
        isAnonymous: anonymousEffective,
        category,
        severity,
        description: description.trim(),
        receivedAt,
      };
      if (!anonymousEffective) {
        if (name.trim()) payload["complainantName"] = name.trim();
        if (contact.trim()) payload["complainantContact"] = contact.trim();
      }
      await api.post(`${base}/grievances`, payload);
      setIntakeOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setIntakeError(
        err instanceof ApiClientError ? err.message : "Failed to record the grievance.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- actions -------------------------------- */

  const [actError, setActError] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [escalationReason, setEscalationReason] = useState("");
  const [assignee, setAssignee] = useState("");
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [satisfied, setSatisfied] = useState<"yes" | "no" | "">("");
  const [verifyNote, setVerifyNote] = useState("");

  function openGrievance(g: GrievanceRow) {
    setActError(null);
    setResolution("");
    setEscalationReason("");
    setAssignee(g.assigneeId ?? "");
    setSelected(g);
  }

  const reload = useCallback(
    async (id: string) => {
      try {
        setSelected(await api.get<GrievanceRow>(`${base}/grievances/${id}`));
      } catch {
        setSelected(null);
      }
      await load();
      onChanged();
    },
    [base, load, onChanged],
  );

  async function act(path: string, body?: unknown) {
    if (!selected) return;
    setActError(null);
    setBusy(true);
    try {
      await api.post(`${base}/grievances/${selected.id}/${path}`, body ?? {});
      await reload(selected.id);
    } catch (err) {
      setActError(err instanceof ApiClientError ? err.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    if (!selected || satisfied === "") return;
    setActError(null);
    setBusy(true);
    try {
      await api.post(`${base}/grievances/${selected.id}/verify-closure`, {
        complainantSatisfied: satisfied === "yes",
        note: verifyNote.trim() || null,
      });
      setVerifyOpen(false);
      await reload(selected.id);
    } catch (err) {
      setActError(
        err instanceof ApiClientError ? err.message : "Failed to record the closure verification.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render -------------------------------- */

  const severityData: Datum[] = analytics
    ? GRIEVANCE_SEVERITIES.map((s) => ({
        key: s,
        label: humanize(s),
        value: analytics.bySeverity[s] ?? 0,
        tone: s === "critical" ? ("red" as const) : s === "high" ? ("amber" as const) : undefined,
      }))
    : [];

  const categoryData: Datum[] = analytics
    ? CATEGORIES.map((c) => ({
        key: c,
        label: humanize(c),
        value: analytics.byCategory[c] ?? 0,
      }))
    : [];

  const channelData: Datum[] = analytics
    ? GRIEVANCE_CHANNELS.map((c) => ({
        key: c,
        label: humanize(c),
        value: analytics.byChannel[c] ?? 0,
      }))
    : [];

  const anyFilter = Boolean(statusFilter || severityFilter || categoryFilter || overdueOnly);

  return (
    <div className="space-y-4">
      {/* ------------------------------ analytics strip --------------------------- */}
      {analytics ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Total received" value={analytics.total} />
            <Stat label="Open" value={analytics.open} />
            <Stat
              label="Open & overdue"
              value={analytics.openOverdue}
              hint="past the published SLA"
              tone={analytics.openOverdue > 0 ? "red" : "green"}
            />
            <Stat
              label="Median days to resolve"
              value={
                analytics.medianDaysToResolve === null
                  ? "—"
                  : fmtNum(analytics.medianDaysToResolve, 1)
              }
              hint={`SLA compliance ${fmtShare(analytics.slaComplianceRate)}`}
            />
            <Stat
              label="Satisfaction rate"
              value={fmtShare(analytics.satisfactionRate)}
              hint={`${analytics.verifiedClosures} closure${
                analytics.verifiedClosures === 1 ? "" : "s"
              } verified`}
              tone={
                analytics.satisfactionRate !== null && analytics.satisfactionRate < 0.6
                  ? "amber"
                  : undefined
              }
            />
            <Stat
              label="Anonymous share"
              value={fmtShare(analytics.anonymousShare)}
              hint={
                analytics.total > 0 && analytics.anonymousCount === 0
                  ? "no anonymous intake at all"
                  : `${analytics.anonymousCount} of ${analytics.total}`
              }
              tone={analytics.total >= 10 && analytics.anonymousCount === 0 ? "amber" : undefined}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardBody>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">
                  By category <span className="font-normal text-ink-400">(#571)</span>
                </h3>
                <HBars ariaLabel="Grievances by category" data={categoryData} labelWidth={116} />
                <h3 className="mb-2 mt-4 text-sm font-semibold text-ink-900">By severity</h3>
                <HBars ariaLabel="Grievances by severity" data={severityData} labelWidth={90} />
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">
                  By intake channel <span className="font-normal text-ink-400">(#570)</span>
                </h3>
                <Donut
                  ariaLabel="Grievances by intake channel"
                  data={channelData}
                  centerLabel="grievances"
                  emptyNote="No grievances recorded yet."
                />
                {analytics.total >= 10 && analytics.anonymousCount === 0 ? (
                  <p className="mt-3 text-xs text-amber-700">
                    Not one grievance has arrived anonymously. A healthy mechanism sees some — a
                    zero usually means the anonymous route is unpublished or not trusted.
                  </p>
                ) : null}
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">
                  Received by month <span className="font-normal text-ink-400">(#574)</span>
                </h3>
                <MonthlyBars byMonth={analytics.byMonth} />
                {analytics.reopened > 0 ? (
                  <p className="mt-2 text-xs">
                    <span className="font-semibold text-amber-700">
                      {analytics.reopened} reopened
                    </span>{" "}
                    <span className="text-ink-500">
                      after the complainant rejected the resolution — those cannot be laundered out
                      of the closed count (#573).
                    </span>
                  </p>
                ) : null}
              </CardBody>
            </Card>
          </div>
        </>
      ) : null}

      {/* --------------------------------- filters -------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-44"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {GRIEVANCE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
          <Select
            className="w-36"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            aria-label="Filter by severity"
          >
            <option value="">All severities</option>
            {GRIEVANCE_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
          <Select
            className="w-40"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-ink-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
              checked={overdueOnly}
              onChange={(e) => setOverdueOnly(e.target.checked)}
            />
            Overdue only
          </label>
        </div>
        <Button onClick={openIntake}>Record grievance</Button>
      </div>

      <ErrorAlert message={error} />

      {rows === null ? (
        <Spinner label="Loading the grievance register…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilter ? "No grievances match this filter" : "No grievances recorded"}
          hint={
            anyFilter
              ? "Clear the filters to see the whole register."
              : "A grievance mechanism with no entries is usually not a quiet community — it is an unpublished channel. Record intake from every route, including anonymous."
          }
          action={
            anyFilter ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setStatusFilter("");
                  setSeverityFilter("");
                  setCategoryFilter("");
                  setOverdueOnly(false);
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button onClick={openIntake}>Record the first grievance</Button>
            )
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Ref</Th>
              <Th>Severity</Th>
              <Th>Category</Th>
              <Th>Channel</Th>
              <Th>Received</Th>
              <Th>Resolve by</Th>
              <Th>Status</Th>
              <Th>Assignee</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((g) => {
              const due = dueBadge(g);
              return (
                <tr
                  key={g.id}
                  className={g.overdue ? "bg-red-50/50 hover:bg-red-50" : "hover:bg-ink-50"}
                >
                  <Td>
                    <button
                      type="button"
                      className="font-medium text-brand-700 hover:text-brand-800"
                      onClick={() => openGrievance(g)}
                    >
                      GRV-{g.number}
                    </button>
                  </Td>
                  <Td>
                    <Badge tone={severityTone(g.severity)}>{humanize(g.severity)}</Badge>
                  </Td>
                  <Td>{humanize(g.category)}</Td>
                  <Td>
                    <ChannelChip channel={g.channel} anonymous={g.isAnonymous} />
                  </Td>
                  <Td className="tabular-nums">{formatDate(g.receivedAt)}</Td>
                  <Td className="whitespace-nowrap">
                    <span title={g.resolveDueAt ? `Due ${g.resolveDueAt}` : undefined}>
                      <Badge tone={due.tone}>{due.label}</Badge>
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={grievanceStatusTone(g.status)}>{humanize(g.status)}</Badge>
                  </Td>
                  <Td className="max-w-[10rem] truncate text-xs text-ink-500">
                    {userName(g.assigneeId) ?? "—"}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {/* ------------------------------ intake modal ----------------------------- */}
      <Modal
        open={intakeOpen}
        title="Record a community grievance"
        onClose={() => setIntakeOpen(false)}
        wide
      >
        <ErrorAlert message={intakeError} />
        <form onSubmit={onIntake} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Channel">
              <Select value={channel} onChange={(e) => setChannelValue(e.target.value)}>
                {GRIEVANCE_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Severity" hint="Sets the SLA clock.">
              <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {GRIEVANCE_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Received on" hint="The date the community raised it.">
              <Input
                type="date"
                required
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </Field>
          </div>

          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
              checked={anonymousEffective}
              disabled={channel === "anonymous"}
              onChange={(e) => setAnonymousFlag(e.target.checked)}
            />
            <span>
              <span className="font-medium">Anonymous</span> — no identifying data is stored, on
              the record or in the ledger
              {channel === "anonymous" ? (
                <span className="text-ink-400"> (implied by the anonymous channel)</span>
              ) : null}
            </span>
          </label>

          {!anonymousEffective ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Complainant name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Contact">
                <Input
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="Phone or village address"
                />
              </Field>
            </div>
          ) : (
            <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500">
              Name and contact are withheld and anything already typed has been cleared. Closure
              verification for an anonymous grievance runs through the community liaison route
              rather than direct contact — the mechanism still has to close it with someone.
            </p>
          )}

          <Field label="What was raised">
            <Textarea
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Dust from the haul road is entering the compound and settling on drying grain."
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIntakeOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Recording…" : "Record grievance"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------- row drawer ------------------------------- */}
      <Modal
        open={selected !== null}
        title={selected ? `GRV-${selected.number}` : ""}
        onClose={() => {
          setSelected(null);
          setActError(null);
        }}
        wide
      >
        {selected ? (
          <div className="space-y-4">
            <ErrorAlert message={actError} />

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={severityTone(selected.severity)}>{humanize(selected.severity)}</Badge>
              <Badge tone="gray">{humanize(selected.category)}</Badge>
              <ChannelChip channel={selected.channel} anonymous={selected.isAnonymous} />
              {(() => {
                const due = dueBadge(selected);
                return <Badge tone={due.tone}>{due.label}</Badge>;
              })()}
            </div>

            <div className="rounded-lg bg-ink-50/70 px-4 py-3">
              <LifecycleRail g={selected} />
            </div>

            <p className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700">
              {selected.description}
            </p>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              {[
                ["Received", formatDate(selected.receivedAt)],
                ["Acknowledge by", formatDate(selected.acknowledgeDueAt)],
                ["Resolve by", formatDate(selected.resolveDueAt)],
                [
                  "Complainant",
                  selected.isAnonymous ? "Anonymous" : (selected.complainantName ?? "—"),
                ],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs uppercase tracking-wide text-ink-400">{k}</dt>
                  <dd className="tabular-nums text-ink-800">{v}</dd>
                </div>
              ))}
            </dl>

            {selected.sla ? (
              <p className="text-xs text-ink-500">
                <span className="font-medium text-ink-700">{humanize(selected.severity)}</span>{" "}
                standard: acknowledge in {selected.sla.acknowledgeDays}d, resolve in{" "}
                {selected.sla.resolveDays}d. {selected.sla.rationale}
              </p>
            ) : null}

            {selected.resolution ? (
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Resolution offered
                </h4>
                <p className="text-sm text-ink-700">{selected.resolution}</p>
              </div>
            ) : null}

            {selected.complainantSatisfied === false ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                The complainant rejected the previous resolution, so the grievance was reopened
                into investigation. The reopen is on the ledger and stays in the reopened count
                (#573).
              </p>
            ) : null}

            {/* ------------------------------ per-state acts ----------------------------- */}
            <div className="space-y-3 border-t border-ink-100 pt-3">
              {selected.status === "received" ? (
                <div>
                  <Button size="sm" disabled={busy} onClick={() => void act("acknowledge")}>
                    Acknowledge receipt
                  </Button>
                  <p className="mt-1 text-xs text-ink-400">
                    Tells the complainant the grievance landed and who is handling it — due{" "}
                    {formatDate(selected.acknowledgeDueAt)}.
                  </p>
                </div>
              ) : null}

              {!["resolved", "closed_verified", "rejected"].includes(selected.status) ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Assign to">
                    <Select
                      className="w-56"
                      value={assignee}
                      onChange={(e) => setAssignee(e.target.value)}
                    >
                      <option value="">Select a handler…</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !assignee || assignee === selected.assigneeId}
                    onClick={() => void act("assign", { assigneeId: assignee })}
                  >
                    {selected.assigneeId ? "Reassign" : "Assign"}
                  </Button>
                  {users.length === 0 ? (
                    <p className="text-xs text-ink-400">
                      No company directory available to this account.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {!["resolved", "closed_verified", "rejected"].includes(selected.status) ? (
                <>
                  <Field label="Resolution offered">
                    <Textarea
                      className="min-h-16"
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                      placeholder="Haul road watered twice daily and the speed limit reduced to 20 km/h past the compound."
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busy || resolution.trim().length === 0}
                      title={
                        resolution.trim().length === 0
                          ? "Describe what is actually being offered before recording a resolution"
                          : undefined
                      }
                      onClick={() => void act("resolve", { resolution: resolution.trim() })}
                    >
                      Record resolution
                    </Button>
                    {selected.status !== "escalated" ? (
                      <>
                        <Input
                          className="w-64"
                          placeholder="Escalation reason"
                          value={escalationReason}
                          onChange={(e) => setEscalationReason(e.target.value)}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy || escalationReason.trim().length === 0}
                          onClick={() => void act("escalate", { reason: escalationReason.trim() })}
                        >
                          Escalate
                        </Button>
                      </>
                    ) : null}
                  </div>
                </>
              ) : null}

              {selected.status === "resolved" ? (
                <div className="rounded-md bg-brand-50/70 px-3 py-3">
                  <p className="mb-2 text-sm text-ink-700">
                    Closure is verified{" "}
                    <span className="font-medium">with the complainant</span>. A resolution nobody
                    has accepted is not a closed grievance.
                  </p>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setSatisfied("");
                      setVerifyNote("");
                      setVerifyOpen(true);
                    }}
                  >
                    Verify closure
                  </Button>
                </div>
              ) : null}

              {selected.status === "closed_verified" ? (
                <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  Closed on {formatDate(selected.verifiedAt)} with the complainant confirming the
                  resolution worked. The SLA obligation is satisfied.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* --------------------------- verify-closure modal -------------------------- */}
      <Modal
        open={verifyOpen}
        title={selected ? `Verify closure of GRV-${selected.number}` : "Verify closure"}
        onClose={() => setVerifyOpen(false)}
      >
        <form onSubmit={onVerify} className="space-y-4">
          <p className="text-sm text-ink-600">
            {selected?.isAnonymous
              ? "This grievance was raised anonymously, so verification runs through the community liaison who carried it. Record what they reported back."
              : "Go back to the complainant with what was actually done and ask them."}
          </p>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink-800">
              Was the complainant satisfied with the resolution?
            </legend>
            <div className="space-y-2">
              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-sm ring-1 ${
                  satisfied === "yes"
                    ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
                    : "ring-ink-200 hover:bg-ink-50"
                }`}
              >
                <input
                  type="radio"
                  name="satisfied"
                  className="mt-0.5 h-4 w-4 border-ink-300 text-brand-600 focus:ring-brand-500"
                  checked={satisfied === "yes"}
                  onChange={() => setSatisfied("yes")}
                />
                <span>
                  <span className="font-medium">Yes — the resolution worked.</span>
                  <span className="mt-0.5 block text-xs opacity-80">
                    The grievance closes as verified and its SLA obligation is satisfied.
                  </span>
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-sm ring-1 ${
                  satisfied === "no"
                    ? "bg-amber-50 text-amber-900 ring-amber-200"
                    : "ring-ink-200 hover:bg-ink-50"
                }`}
              >
                <input
                  type="radio"
                  name="satisfied"
                  className="mt-0.5 h-4 w-4 border-ink-300 text-brand-600 focus:ring-brand-500"
                  checked={satisfied === "no"}
                  onChange={() => setSatisfied("no")}
                />
                <span>
                  <span className="font-medium">No — the complainant is not satisfied.</span>
                  <span className="mt-0.5 block text-xs opacity-80">
                    The grievance <span className="font-medium">reopens into investigation</span>,
                    the rejected resolution and the reopen go on the ledger, and it counts as
                    reopened in the analytics. The obligation is not satisfied.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <Field label="Note" hint="What the complainant said, and who spoke to them.">
            <Textarea
              className="min-h-16"
              value={verifyNote}
              onChange={(e) => setVerifyNote(e.target.value)}
              placeholder="Visited the compound with the community liaison on 12 May; the household confirmed the watering has stopped the dust."
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setVerifyOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={satisfied === "no" ? "danger" : "primary"}
              disabled={busy || satisfied === ""}
              title={satisfied === "" ? "Answer the question first" : undefined}
            >
              {busy
                ? "Recording…"
                : satisfied === "no"
                  ? "Reopen the grievance"
                  : "Close as verified"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
