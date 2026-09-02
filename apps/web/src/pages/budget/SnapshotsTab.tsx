/**
 * SNAPSHOTS — immutable period captures, and the diff between any two.
 *
 * A snapshot is the answer to "what did the budget say at month end", relied on
 * months later in a claim. Three things follow, and this screen shows all
 * three rather than assuming them:
 *
 *  · The whole line set is FROZEN into the capture, not re-derived, so it
 *    survives later edits to cost codes, line splits and forecasts.
 *  · A sha-256 over the frozen payload is stored with it, and the API
 *    recomputes that hash on every read. `hashVerified: false` means the
 *    capture itself has been tampered with — so it is surfaced loudly rather
 *    than quietly trusted.
 *  · Once a period is captured, nothing may be back-dated into it. Plan
 *    amounts freeze and movements must be dated after the capture. That is why
 *    taking one is presented as a decision, not a button.
 *
 * The diff matches lines on their WBS COORDINATE (cost code × cost type)
 * rather than on row id: a line deleted and recreated at the same cost code is
 * the same line to a cost reviewer, and matching on id would report it as a
 * deletion plus an identical addition — exactly the noise that makes a
 * month-end diff unreadable.
 */
import { useEffect, useMemo, useState } from "react";
import { BUDGET_SNAPSHOT_KINDS, type BudgetSnapshotKind } from "@constructos/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Drawer,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  Tooltip,
  Tr,
  cx,
} from "../../ui";
import { IconPlus, IconVersion } from "../../ui/icons";
import { DatePicker } from "../../ui/inputs";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  SNAPSHOT_KIND_LABEL,
  SectionHeading,
  actorName,
  count,
  dateTime,
  errorMessage,
  isoDate,
  labelize,
  money,
  percent,
  today,
  useResource,
  type BudgetDetail,
  type ListResponse,
  type SnapshotDetail,
  type SnapshotDiffResponse,
  type SnapshotLine,
  type SnapshotSummary,
} from "./budgetShared";

const toIsoDate = (date: Date | null): string | null => {
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
};
const fromIsoDate = (value: string | null): Date | null =>
  value ? new Date(`${value}T00:00:00`) : null;

/** Field labels for the diff, in the API's own report order. */
const FIELD_LABEL: Record<string, string> = {
  originalBudget: "Original budget",
  budgetModifications: "Approved transfers",
  approvedChanges: "Approved changes",
  revisedBudget: "Revised budget",
  committedCost: "Committed",
  pendingCommitments: "Pending commitments",
  directCosts: "Direct cost",
  jobToDateCosts: "Spent (job to date)",
  forecastToComplete: "Forecast to complete",
  forecastFinal: "Forecast at completion",
  projectedOverUnder: "Variance",
  percentComplete: "Percent complete",
  originalBudgetTotal: "Original budget",
  budgetModificationsTotal: "Approved transfers",
  approvedChangesTotal: "Approved changes",
  pendingChangesTotal: "Pending changes",
  revisedBudgetTotal: "Revised budget",
  committedTotal: "Committed",
  pendingCommitmentsTotal: "Pending commitments",
  directCostsTotal: "Direct cost",
  jobToDateCostsTotal: "Spent (job to date)",
  forecastToCompleteTotal: "Forecast to complete",
  forecastFinalTotal: "Forecast at completion",
  varianceTotal: "Variance",
};

const isPercentField = (field: string): boolean => field === "percentComplete";

function fieldValue(field: string, value: number, currency: string): string {
  return isPercentField(field) ? percent(value) : money(value, currency);
}

function fieldDelta(field: string, value: number, currency: string): string {
  return isPercentField(field)
    ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`
    : money(value, currency, { signed: true });
}

export interface SnapshotsTabProps {
  budget: BudgetDetail;
  currency: string;
  users: Map<string, string>;
  version: number;
  onChanged: () => void;
}

export default function SnapshotsTab({
  budget,
  currency,
  users,
  version,
  onChanged,
}: SnapshotsTabProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<SnapshotSummary | null>(null);
  const [localVersion, setLocalVersion] = useState(0);
  const [fromRef, setFromRef] = useState("");
  const [toRef, setToRef] = useState("");

  const snapshots = useResource<ListResponse<SnapshotSummary>>(
    (signal) =>
      api.get<ListResponse<SnapshotSummary>>(
        `/api/v1/budgets/${budget.id}/snapshots?page=1&pageSize=100`,
        { signal },
      ),
    [budget.id, version, localVersion],
  );

  const items = useMemo(() => snapshots.data?.items ?? [], [snapshots.data]);

  useEffect(() => {
    if (items.length < 2) {
      setFromRef("");
      setToRef("");
      return;
    }
    const [latest, previous] = items;
    if (latest && previous) {
      setToRef((current) => (current === "" ? latest.id : current));
      setFromRef((current) => (current === "" ? previous.id : current));
    }
  }, [items]);

  const diff = useResource<SnapshotDiffResponse>(
    (signal) =>
      api.get<SnapshotDiffResponse>(
        `/api/v1/budgets/${budget.id}/snapshots/diff?from=${encodeURIComponent(
          fromRef,
        )}&to=${encodeURIComponent(toRef)}`,
        { signal },
      ),
    [budget.id, fromRef, toRef, version, localVersion],
    fromRef !== "" && toRef !== "" && fromRef !== toRef,
  );

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading
          title="Period captures"
          hint="Immutable. Once a capture exists, plan amounts freeze and no movement may be dated on or before it — that is what keeps the capture true."
          actions={
            <Button
              leadingIcon={IconPlus}
              onClick={() => setCreateOpen(true)}
              disabled={budget.lineCount === 0}
              title={
                budget.lineCount === 0
                  ? "There is nothing to capture — this budget has no lines"
                  : "Capture this period"
              }
            >
              Capture period
            </Button>
          }
        />

        {snapshots.error ? (
          <LoadError
            message={snapshots.error}
            onRetry={snapshots.reload}
            title="Period captures could not be loaded"
          />
        ) : null}

        {snapshots.loading && items.length === 0 ? (
          <div className="skeleton h-40 rounded-lg" aria-hidden="true" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={IconVersion}
            title="No period has been captured"
            hint="A capture freezes the whole line set and its totals with a content hash, so the figure somebody signed at month end stays the figure they signed."
          />
        ) : (
          <Table dense stickyHeader>
            <thead>
              <tr>
                <Th>Ref</Th>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th>As at</Th>
                <Th>Period</Th>
                <Th numeric>Lines</Th>
                <Th numeric>Revised budget</Th>
                <Th numeric>Forecast at completion</Th>
                <Th>Captured</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((snapshot) => (
                <Tr key={snapshot.id} interactive onClick={() => setOpenId(snapshot.id)}>
                  <Td className="font-mono text-code">
                    {snapshot.reference}
                    {snapshot.void ? (
                      <Badge tone="neutral" size="xs" className="ml-1">
                        void
                      </Badge>
                    ) : null}
                  </Td>
                  <Td truncate>{snapshot.name}</Td>
                  <Td muted>{SNAPSHOT_KIND_LABEL[snapshot.kind] ?? labelize(snapshot.kind)}</Td>
                  <Td>{isoDate(snapshot.asOfDate)}</Td>
                  <Td muted>
                    {snapshot.periodStart && snapshot.periodEnd
                      ? `${snapshot.periodStart} → ${snapshot.periodEnd}`
                      : EM_DASH}
                  </Td>
                  <Td numeric>{count(snapshot.lineCount)}</Td>
                  <Td numeric>{money(snapshot.totals.revisedBudgetTotal ?? null, currency)}</Td>
                  <Td numeric>{money(snapshot.totals.forecastFinalTotal ?? null, currency)}</Td>
                  <Td muted>
                    {actorName(users, snapshot.capturedBy)}
                    <span className="block text-meta text-content-subtle">
                      {dateTime(snapshot.capturedAt)}
                    </span>
                  </Td>
                  <Td>
                    {snapshot.void ? null : (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          setVoiding(snapshot);
                        }}
                      >
                        Void
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <VoidSnapshotModal
        snapshot={voiding}
        onClose={() => setVoiding(null)}
        onVoided={() => {
          setVoiding(null);
          setLocalVersion((n) => n + 1);
          onChanged();
        }}
      />

      <section>
        <SectionHeading
          title="Compare two captures"
          hint="Lines are matched on their WBS coordinate, so a line recreated at the same cost code reads as a change rather than as a deletion plus an addition."
          actions={
            <>
              <Select
                value={fromRef}
                onChange={(event) => setFromRef(event.target.value)}
                size="sm"
                aria-label="Compare from"
                disabled={items.length < 2}
              >
                <option value="">From…</option>
                {items.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {snapshot.reference} · {snapshot.asOfDate}
                  </option>
                ))}
              </Select>
              <span className="text-content-subtle">→</span>
              <Select
                value={toRef}
                onChange={(event) => setToRef(event.target.value)}
                size="sm"
                aria-label="Compare to"
                disabled={items.length < 2}
              >
                <option value="">To…</option>
                {items.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {snapshot.reference} · {snapshot.asOfDate}
                  </option>
                ))}
              </Select>
            </>
          }
        />

        {items.length < 2 ? (
          <EmptyState
            title="A diff needs two captures"
            hint="Capture a second period and the line-by-line movement between them appears here."
          />
        ) : fromRef === toRef && fromRef !== "" ? (
          <Alert tone="info" size="sm">
            A diff needs two different captures.
          </Alert>
        ) : diff.error ? (
          <LoadError message={diff.error} onRetry={diff.reload} title="The diff could not be computed" />
        ) : diff.loading || !diff.data ? (
          <div className="skeleton h-48 rounded-lg" aria-hidden="true" />
        ) : (
          <DiffView diff={diff.data} currency={currency} />
        )}
      </section>

      <SnapshotDrawer
        snapshotId={openId}
        currency={currency}
        users={users}
        onClose={() => setOpenId(null)}
      />

      <CaptureModal
        open={createOpen}
        budget={budget}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          setLocalVersion((n) => n + 1);
          onChanged();
        }}
      />
    </div>
  );
}

/* ========================================================================== */
/* Diff                                                                        */
/* ========================================================================== */

function DiffView({ diff, currency }: { diff: SnapshotDiffResponse; currency: string }) {
  return (
    <div className="space-y-4">
      <Card variant="sunken">
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-meta text-content-subtle">From</p>
              <p className="text-body font-medium text-content">
                {diff.from.reference} · {diff.from.name}
              </p>
              <p className="text-meta text-content-subtle">
                As at {diff.from.asOfDate} · {count(diff.from.lineCount)} lines
              </p>
            </div>
            <div>
              <p className="text-meta text-content-subtle">To</p>
              <p className="text-body font-medium text-content">
                {diff.to.reference} · {diff.to.name}
              </p>
              <p className="text-meta text-content-subtle">
                As at {diff.to.asOfDate} · {count(diff.to.lineCount)} lines
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success" size="sm">
                {count(diff.addedCount)} added
              </Badge>
              <Badge tone="danger" size="sm">
                {count(diff.removedCount)} removed
              </Badge>
              <Badge tone="warning" size="sm">
                {count(diff.changedCount)} changed
              </Badge>
              <Badge tone="neutral" size="sm">
                {count(diff.unchangedCount)} unchanged
              </Badge>
            </div>
          </div>
        </CardBody>
      </Card>

      {diff.totals.length > 0 ? (
        <section>
          <h3 className="mb-2 text-label uppercase text-content-subtle">Totals that moved</h3>
          <Table dense>
            <thead>
              <tr>
                <Th>Figure</Th>
                <Th numeric>{diff.from.reference}</Th>
                <Th numeric>{diff.to.reference}</Th>
                <Th numeric>Movement</Th>
              </tr>
            </thead>
            <tbody>
              {diff.totals.map((total) => (
                <Tr key={total.field}>
                  <Td>{FIELD_LABEL[total.field] ?? total.field}</Td>
                  <Td numeric muted>
                    {money(total.from, currency)}
                  </Td>
                  <Td numeric>{money(total.to, currency)}</Td>
                  <Td numeric>
                    <span
                      className={cx(
                        "font-medium",
                        total.delta < 0 ? "text-danger-fg" : "text-success-fg",
                      )}
                    >
                      {money(total.delta, currency, { signed: true })}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : (
        <Alert tone="success" size="sm" title="No total moved between these two captures">
          Every stored total is identical in both captures.
        </Alert>
      )}

      {diff.changed.length > 0 ? (
        <section>
          <h3 className="mb-2 text-label uppercase text-content-subtle">
            Changed lines ({count(diff.changedCount)})
          </h3>
          <div className="space-y-2">
            {diff.changed.map((line) => (
              <Card key={`${line.costCode}-${line.costType}`} accent="warning">
                <CardBody className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-body text-content">
                      <span className="font-mono text-code">{line.costCode}</span>{" "}
                      <span className="text-content-subtle">{labelize(line.costType)}</span>{" "}
                      {line.description}
                    </p>
                    <Badge tone="warning" size="xs">
                      {line.fields.length} field{line.fields.length === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                    {line.fields.map((field) => (
                      <div
                        key={field.field}
                        className="flex items-baseline justify-between gap-2 text-meta"
                      >
                        <span className="text-content-subtle">
                          {FIELD_LABEL[field.field] ?? field.field}
                        </span>
                        <span className="tabular-nums text-content">
                          <span className="text-content-subtle line-through">
                            {fieldValue(field.field, field.from, currency)}
                          </span>{" "}
                          {fieldValue(field.field, field.to, currency)}{" "}
                          <span
                            className={cx(
                              "font-medium",
                              field.delta < 0 ? "text-danger-fg" : "text-success-fg",
                            )}
                          >
                            ({fieldDelta(field.field, field.delta, currency)})
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {diff.added.length > 0 ? (
        <DiffLineTable
          title={`Lines added (${count(diff.addedCount)})`}
          lines={diff.added}
          currency={currency}
          tone="success"
        />
      ) : null}

      {diff.removed.length > 0 ? (
        <DiffLineTable
          title={`Lines removed (${count(diff.removedCount)})`}
          lines={diff.removed}
          currency={currency}
          tone="danger"
        />
      ) : null}
    </div>
  );
}

function DiffLineTable({
  title,
  lines,
  currency,
  tone,
}: {
  title: string;
  lines: readonly SnapshotLine[];
  currency: string;
  tone: "success" | "danger";
}) {
  return (
    <section>
      <h3
        className={cx(
          "mb-2 text-label uppercase",
          tone === "success" ? "text-success-fg" : "text-danger-fg",
        )}
      >
        {title}
      </h3>
      <Table dense>
        <thead>
          <tr>
            <Th>Cost code</Th>
            <Th>Description</Th>
            <Th>Cost type</Th>
            <Th numeric>Revised budget</Th>
            <Th numeric>Forecast at completion</Th>
            <Th numeric>Variance</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <Tr key={`${line.costCode}-${line.costType}`}>
              <Td className="font-mono text-code">{line.costCode}</Td>
              <Td truncate>{line.description}</Td>
              <Td muted>{labelize(line.costType)}</Td>
              <Td numeric>{money(line.revisedBudget, currency)}</Td>
              <Td numeric>{money(line.forecastFinal, currency)}</Td>
              <Td numeric>{money(line.projectedOverUnder, currency, { signed: true })}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

/* ========================================================================== */
/* Drawer                                                                      */
/* ========================================================================== */

function SnapshotDrawer({
  snapshotId,
  currency,
  users,
  onClose,
}: {
  snapshotId: string | null;
  currency: string;
  users: Map<string, string>;
  onClose: () => void;
}) {
  const snapshot = useResource<SnapshotDetail>(
    (signal) => api.get<SnapshotDetail>(`/api/v1/budget-snapshots/${snapshotId}`, { signal }),
    [snapshotId ?? ""],
    snapshotId !== null,
  );

  const row = snapshot.data;

  return (
    <Drawer
      open={snapshotId !== null}
      onClose={onClose}
      size="xl"
      title={row ? `${row.reference} · ${row.name}` : "Period capture"}
      description={row ? `Frozen as at ${row.asOfDate}` : undefined}
      headerActions={
        row ? (
          <Tooltip
            content={
              row.hashVerified
                ? "The stored payload still hashes to the value recorded when it was captured."
                : "The stored payload no longer hashes to its recorded value. This capture has been altered since it was taken."
            }
          >
            <span>
              <Badge tone={row.hashVerified ? "success" : "danger"} size="sm" dot>
                {row.hashVerified ? "Hash verified" : "Hash MISMATCH"}
              </Badge>
            </span>
          </Tooltip>
        ) : undefined
      }
    >
      {snapshot.error ? (
        <LoadError
          message={snapshot.error}
          onRetry={snapshot.reload}
          title="This capture could not be loaded"
        />
      ) : null}
      {snapshot.loading && !row ? (
        <div className="skeleton h-64 rounded-lg" aria-hidden="true" />
      ) : null}

      {row ? (
        <div className="space-y-4">
          {!row.hashVerified ? (
            <Alert tone="danger" title="This capture does not match its content hash">
              <p>
                The stored payload hashes to <code className="font-mono">{row.recomputedContentHash.slice(0, 16)}…</code>{" "}
                but the capture records <code className="font-mono">{row.contentHash.slice(0, 16)}…</code>.
                A capture that no longer hashes to its recorded value has been tampered with, and
                saying so is the entire point of storing the hash.
              </p>
            </Alert>
          ) : null}

          <div className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-3">
            <Meta label="Kind" value={SNAPSHOT_KIND_LABEL[row.kind] ?? labelize(row.kind)} />
            <Meta label="As at" value={isoDate(row.asOfDate)} />
            <Meta
              label="Period"
              value={
                row.periodStart && row.periodEnd
                  ? `${row.periodStart} → ${row.periodEnd}`
                  : EM_DASH
              }
            />
            <Meta label="Lines frozen" value={count(row.lineCount)} />
            <Meta label="Captured by" value={actorName(users, row.capturedBy)} />
            <Meta label="Captured at" value={dateTime(row.capturedAt)} />
          </div>

          {row.notes ? (
            <p className="whitespace-pre-wrap text-body text-content-muted">{row.notes}</p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-4">
            <Figure label="Original" value={money(row.totals.originalBudgetTotal ?? null, currency)} />
            <Figure label="Revised" value={money(row.totals.revisedBudgetTotal ?? null, currency)} />
            <Figure
              label="Forecast at completion"
              value={money(row.totals.forecastFinalTotal ?? null, currency)}
            />
            <Figure label="Variance" value={money(row.totals.varianceTotal ?? null, currency, { signed: true })} />
          </div>

          <section>
            <h3 className="mb-2 text-label uppercase text-content-subtle">
              The frozen line set ({count(row.lines.length)})
            </h3>
            <div className="max-h-96 overflow-auto">
              <Table dense stickyHeader flush>
                <thead>
                  <tr>
                    <Th>Cost code</Th>
                    <Th>Description</Th>
                    <Th numeric>Original</Th>
                    <Th numeric>Revised</Th>
                    <Th numeric>Committed</Th>
                    <Th numeric>Spent</Th>
                    <Th>Method</Th>
                    <Th numeric>Forecast</Th>
                    <Th numeric>Variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {row.lines.map((line) => (
                    <Tr key={`${line.costCode}-${line.costType}`}>
                      <Td className="font-mono text-code">{line.costCode}</Td>
                      <Td truncate>{line.description}</Td>
                      <Td numeric muted>
                        {money(line.originalBudget, currency)}
                      </Td>
                      <Td numeric>{money(line.revisedBudget, currency)}</Td>
                      <Td numeric muted>
                        {money(line.committedCost, currency)}
                      </Td>
                      <Td numeric muted>
                        {money(line.jobToDateCosts, currency)}
                      </Td>
                      <Td muted>{labelize(line.forecastMethod)}</Td>
                      <Td numeric>{money(line.forecastFinal, currency)}</Td>
                      <Td numeric>
                        <span
                          className={
                            line.projectedOverUnder < 0 ? "text-danger-fg" : "text-success-fg"
                          }
                        >
                          {money(line.projectedOverUnder, currency, { signed: true })}
                        </span>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </section>

          <p className="break-all text-meta text-content-subtle">
            Content hash <code className="font-mono">{row.contentHash}</code>
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-meta text-content-subtle">{label}</p>
      <p className="text-body text-content">{value}</p>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="sunken">
      <CardBody className="py-3">
        <p className="text-label uppercase text-content-subtle">{label}</p>
        <p className="text-body font-semibold tabular-nums text-content">{value}</p>
      </CardBody>
    </Card>
  );
}

/* ========================================================================== */
/* Capture                                                                     */
/* ========================================================================== */

function CaptureModal({
  open,
  budget,
  onClose,
  onCreated,
}: {
  open: boolean;
  budget: BudgetDetail;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BudgetSnapshotKind>("monthly_close");
  const [asOf, setAsOf] = useState<Date | null>(() => fromIsoDate(today()));
  const [periodStart, setPeriodStart] = useState<Date | null>(null);
  const [periodEnd, setPeriodEnd] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const stamp = today();
    setName(`Month end ${stamp.slice(0, 7)}`);
    setKind("monthly_close");
    setAsOf(fromIsoDate(stamp));
    setPeriodStart(null);
    setPeriodEnd(null);
    setNotes("");
    setAcknowledged(false);
    setError(null);
  }, [open]);

  async function submit() {
    if (name.trim() === "") {
      setError("A capture needs a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        asOfDate: toIsoDate(asOf) ?? today(),
      };
      const start = toIsoDate(periodStart);
      const end = toIsoDate(periodEnd);
      if (start) body["periodStart"] = start;
      if (end) body["periodEnd"] = end;
      if (notes.trim() !== "") body["notes"] = notes.trim();
      await api.post(`/api/v1/budgets/${budget.id}/snapshots`, body);
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "The period could not be captured"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Capture this period"
      description="The whole line set and its totals are frozen with a content hash. This cannot be undone."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={!acknowledged}>
            Capture period
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} />
      <Alert tone="warning" title="What a capture does to this budget">
        <ul className="list-disc space-y-1 pl-4">
          <li>
            {count(budget.lineCount)} line{budget.lineCount === 1 ? "" : "s"} are frozen exactly as
            they stand, with a sha-256 over the payload.
          </li>
          <li>Plan amounts stop being editable — money then moves only through an approved change.</li>
          <li>
            No movement may be dated on or before the capture date, so a closed period cannot be
            rewritten.
          </li>
          <li>A capture cannot be deleted, and it cannot be back-dated behind an existing one.</li>
        </ul>
      </Alert>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Kind">
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value as BudgetSnapshotKind)}
          >
            {BUDGET_SNAPSHOT_KINDS.map((option) => (
              <option key={option} value={option}>
                {SNAPSHOT_KIND_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="As at" hint="The date the capture speaks for. It cannot be in the future — a capture closes every period up to its date.">
          <DatePicker value={asOf} onChange={setAsOf} aria-label="As at date" max={new Date()} />
        </Field>
        <Field label="Period start" optional>
          <DatePicker value={periodStart} onChange={setPeriodStart} aria-label="Period start" />
        </Field>
        <Field label="Period end" optional>
          <DatePicker value={periodEnd} onChange={setPeriodEnd} aria-label="Period end" />
        </Field>
        <Field label="Notes" optional className="sm:col-span-2">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
        </Field>
      </div>

      <Checkbox
        className="mt-3"
        checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)}
        label={`I understand this capture is immutable and freezes the plan amounts on ${budget.reference}.`}
      />
    </Modal>
  );
}

/**
 * Void a capture (budget admin, reason required). The row and its hash stay
 * — a capture that existed is evidence — but it stops freezing the plan and
 * closing the period, which is how a mistaken or future-dated capture is
 * undone without pretending it never happened.
 */
function VoidSnapshotModal({
  snapshot,
  onClose,
  onVoided,
}: {
  snapshot: SnapshotSummary | null;
  onClose: () => void;
  onVoided: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (snapshot) {
      setReason("");
      setError(null);
    }
  }, [snapshot]);

  async function submit() {
    if (!snapshot || reason.trim() === "") return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/v1/budget-snapshots/${snapshot.id}/void`, { reason: reason.trim() });
      onVoided();
    } catch (err) {
      setError(errorMessage(err, "The capture could not be voided"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={snapshot !== null}
      onClose={onClose}
      title={snapshot ? `Void ${snapshot.reference}?` : "Void capture"}
      description="The capture keeps its hashed row as evidence but stops guarding the period: plan amounts become editable again and movements may be dated after the previous live capture. Budget admin only."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={saving} disabled={reason.trim() === ""}>
            Void the capture
          </Button>
        </>
      }
    >
      <ErrorAlert message={error} />
      <Field label="Reason" required hint="Stored on the capture and in the ledger.">
        <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
