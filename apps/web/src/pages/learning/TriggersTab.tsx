/**
 * The mandatory-capture backlog for one project (#976-977).
 *
 * A trigger is an event another module already recorded — a dispute closed, a
 * claim settled, a variation over threshold — that raises an assurance
 * obligation only a lesson can discharge. This tab exists to make that
 * backlog impossible to ignore:
 *
 *   · age and overdue are shown per row, and old rows are coloured for it;
 *   · the sweep is manual as well as lazy, and reports exactly what it
 *     scanned, what it created, and the threshold it used with its source;
 *   · dismissal — the only exit other than a lesson — demands a reason of
 *     substance and records who gave it;
 *   · the rule registry is on the page, so "why am I being asked for this?"
 *     has an answer that does not require reading the source.
 */
import { useCallback, useEffect, useState } from "react";
import { LESSON_TRIGGER_KINDS } from "@constructos/shared";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatDateTime } from "../format";
import LessonDrawer from "./LessonDrawer";
import LessonForm from "./LessonForm";
import type { LessonBody } from "./LessonForm";
import {
  LoadError,
  NoteCard,
  SectionTitle,
  errorMessage,
  fmtInt,
  fmtNum,
  label,
  triggerStatusTone,
} from "./learningShared";
import type { Lesson, ProjectRow, SweepResult, TriggerRow, TriggerRule, TriggerListResponse } from "./learningShared";

const MIN_REASON = 10;

function ageClass(t: TriggerRow): string {
  if (t.status !== "open") return "tabular-nums text-ink-500";
  if (t.ageDays > 90) return "font-bold tabular-nums text-red-700";
  if (t.ageDays > 30) return "font-semibold tabular-nums text-orange-700";
  if (t.ageDays > 7) return "font-medium tabular-nums text-amber-700";
  return "tabular-nums text-ink-800";
}

function SweepReport({
  sweep,
  heading,
  hint,
}: {
  sweep: SweepResult;
  heading: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md bg-ink-50 px-3 py-2 ring-1 ring-ink-200">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{heading}</p>
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-700">
        <span>
          <span className="font-semibold tabular-nums text-ink-900">{fmtInt(sweep.scanned)}</span> qualifying
          record{sweep.scanned === 1 ? "" : "s"} scanned
        </span>
        <span>
          <span className="font-semibold tabular-nums text-emerald-700">{fmtInt(sweep.created)}</span> new
          trigger{sweep.created === 1 ? "" : "s"} raised
        </span>
        <span>
          <span className="font-semibold tabular-nums text-ink-900">{fmtInt(sweep.alreadyOpen)}</span> already
          materialized
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-600">
        Variation threshold used:{" "}
        <span className="font-semibold tabular-nums text-ink-900">{fmtNum(sweep.threshold.value, 2)}</span>{" "}
        <span className="text-ink-500">(source: {sweep.threshold.source})</span>
      </p>
      {sweep.note ? <p className="mt-1 text-xs text-ink-600">{sweep.note}</p> : null}
      {sweep.createdTriggerIds.length > 0 ? (
        <p className="mt-1 font-mono text-[11px] text-ink-400">
          {sweep.createdTriggerIds.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

export default function TriggersTab({
  projectId,
  projects,
  canSupersede,
}: {
  projectId: string;
  projects: ProjectRow[] | null;
  canSupersede: boolean;
}) {
  const [status, setStatus] = useState<string>("open");
  const [kind, setKind] = useState<string>("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [rows, setRows] = useState<TriggerRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [readSweep, setReadSweep] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [manualSweep, setManualSweep] = useState<SweepResult | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const [rules, setRules] = useState<TriggerRule[] | null>(null);
  const [rulesNote, setRulesNote] = useState<string | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);

  const [captureFor, setCaptureFor] = useState<TriggerRow | null>(null);
  const [dismissFor, setDismissFor] = useState<TriggerRow | null>(null);
  const [dismissReason, setDismissReason] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [openLessonId, setOpenLessonId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      if (kind) params.set("kind", kind);
      const res = await api.get<TriggerListResponse>(
        `/api/v1/projects/${projectId}/learning/triggers?${params.toString()}`,
      );
      setRows(res.items);
      setTotal(res.total);
      setReadSweep(res.sweep ?? null);
    } catch (err) {
      setRows(null);
      setError(errorMessage(err, "Failed to load the capture backlog"));
    }
  }, [projectId, status, kind, page]);

  const loadRules = useCallback(async () => {
    setRulesError(null);
    try {
      const res = await api.get<{ rules: TriggerRule[]; note: string }>(
        "/api/v1/learning/triggers/rules",
      );
      setRules(res.rules);
      setRulesNote(res.note);
    } catch (err) {
      setRules(null);
      setRulesError(errorMessage(err, "Failed to load the trigger rule registry"));
    }
  }, []);

  useEffect(() => {
    setNotice(null);
    setActionError(null);
    void load();
  }, [load]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  async function sweep() {
    setSweeping(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await api.post<SweepResult>(`/api/v1/projects/${projectId}/learning/triggers/sweep`);
      setManualSweep(res);
      await load();
    } catch (err) {
      setActionError(errorMessage(err, "The sweep did not run"));
    } finally {
      setSweeping(false);
    }
  }

  async function captureLesson(body: LessonBody) {
    if (!captureFor) return;
    const res = await api.post<{ lesson: Lesson; trigger: TriggerRow }>(
      `/api/v1/projects/${projectId}/learning/triggers/${captureFor.id}/capture`,
      body,
    );
    setCaptureFor(null);
    setNotice(
      `${res.lesson.number} captured as a draft and the trigger is discharged — its obligation is satisfied. Submit it for validation from the Capture & review tab; a lesson is not organisational memory until it is published.`,
    );
    await load();
  }

  async function dismiss() {
    if (!dismissFor || dismissReason.trim().length < MIN_REASON) return;
    setDismissing(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/learning/triggers/${dismissFor.id}/dismiss`, {
        reason: dismissReason.trim(),
      });
      setDismissFor(null);
      setDismissReason("");
      setNotice(
        "Trigger dismissed. The obligation is waived, not satisfied — the distinction survives in the assurance register, and the dismissal is counted against the capture rate.",
      );
      await load();
    } catch (err) {
      setActionError(errorMessage(err, "The trigger could not be dismissed"));
    } finally {
      setDismissing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <ErrorAlert message={actionError} />
      {notice ? <NoteCard note={notice} tone="brand" /> : null}

      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <div className="min-w-44">
            <Field label="Status">
              <Select
                value={status}
                onChange={(e) => {
                  setPage(1);
                  setStatus(e.target.value);
                }}
              >
                <option value="open">Open (the backlog)</option>
                <option value="captured">Captured</option>
                <option value="dismissed">Dismissed</option>
                <option value="">Any status</option>
              </Select>
            </Field>
          </div>
          <div className="min-w-52">
            <Field label="Kind">
              <Select
                value={kind}
                onChange={(e) => {
                  setPage(1);
                  setKind(e.target.value);
                }}
              >
                <option value="">Any kind</option>
                {LESSON_TRIGGER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button onClick={() => void sweep()} disabled={sweeping}>
            {sweeping ? "Sweeping…" : "Run sweep now"}
          </Button>
          <p className="basis-full text-xs text-ink-400 lg:basis-auto lg:flex-1">
            The sweep also runs lazily whenever this list is read — a backlog that is out of date is worse
            than no backlog. Running it by hand shows you exactly what it scanned and created.
          </p>
        </CardBody>
      </Card>

      {manualSweep ? <SweepReport sweep={manualSweep} heading="Manual sweep" /> : null}
      {readSweep ? (
        <SweepReport
          sweep={readSweep}
          heading="Sweep performed by loading this list"
          hint={
            manualSweep
              ? "This ran after the manual sweep above, which is why it created nothing: one trigger per (kind, source record) per project, forever."
              : undefined
          }
        />
      ) : null}

      {error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner label="Sweeping and loading triggers…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={status === "open" ? "No open capture triggers on this project" : "No triggers match"}
          hint={
            status === "open"
              ? "Either nothing qualifying has happened yet, or every trigger has been discharged by a lesson or dismissed with a reason. The rule registry below lists what would fire one."
              : "Widen the filters to see the rest of the backlog."
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Age</Th>
                <Th>Kind</Th>
                <Th>Why capture is mandatory</Th>
                <Th>Source record</Th>
                <Th>Due</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((t) => (
                <tr key={t.id} className={t.overdue ? "bg-red-50/40" : undefined}>
                  <Td className="whitespace-nowrap">
                    <span className={ageClass(t)}>{fmtInt(t.ageDays)}d</span>
                    {t.overdue ? (
                      <div className="mt-0.5">
                        <Badge tone="red">Overdue</Badge>
                      </div>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Badge tone="amber">{label(t.kind)}</Badge>
                  </Td>
                  <Td className="max-w-md text-xs text-ink-700">
                    {t.rationale}
                    {t.status === "dismissed" && t.dismissedReason ? (
                      <div className="mt-1 rounded bg-ink-50 px-2 py-1 text-[11px] text-ink-600">
                        <span className="font-medium">Dismissed:</span> {t.dismissedReason}
                        {t.dismissedBy ? <span className="text-ink-400"> — {t.dismissedBy}</span> : null}
                      </div>
                    ) : null}
                  </Td>
                  <Td className="max-w-56 text-xs">
                    {t.sourceRef ? (
                      <>
                        <Badge tone="gray">{label(t.sourceRef.tool ?? "")}</Badge>{" "}
                        <span className="text-ink-700">{t.sourceRef.label || t.sourceRef.recordId}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {formatDate(t.dueAt)}
                    <div className="text-[11px] text-ink-400">raised {formatDate(t.raisedAt)}</div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Badge tone={triggerStatusTone(t.status)}>{label(t.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {t.status === "open" ? (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => setCaptureFor(t)}>
                          Capture lesson
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setDismissFor(t);
                            setDismissReason("");
                          }}
                        >
                          Dismiss…
                        </Button>
                      </div>
                    ) : t.lessonId ? (
                      <Button size="sm" variant="secondary" onClick={() => setOpenLessonId(t.lessonId)}>
                        View lesson
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-400">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="flex items-center justify-between text-xs text-ink-500">
            <span>
              {fmtInt(total)} trigger{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ------------------------------ rule registry ----------------------------- */}
      <Card>
        <CardBody>
          <SectionTitle hint="What makes a lesson mandatory, which records each rule reads, and how long you have.">
            What fires mandatory capture
          </SectionTitle>
          {rulesError ? (
            <LoadError message={rulesError} onRetry={() => void loadRules()} />
          ) : rules === null ? (
            <Spinner label="Loading the rule registry…" />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Rule</Th>
                    <Th>Kind</Th>
                    <Th>Reads</Th>
                    <Th>Due within</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rules.map((r) => (
                    <tr key={r.kind}>
                      <Td className="whitespace-nowrap font-medium">{r.name}</Td>
                      <Td className="whitespace-nowrap">
                        <Badge tone="gray">{r.kind}</Badge>
                      </Td>
                      <Td className="text-xs text-ink-600">{r.reads}</Td>
                      <Td className="whitespace-nowrap tabular-nums">{fmtInt(r.dueDays)} days</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="mt-3">
                <NoteCard note={rulesNote} tone="ink" />
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {/* -------------------------- capture from trigger -------------------------- */}
      <Modal
        open={captureFor !== null}
        title={captureFor ? `Capture the lesson — ${label(captureFor.kind)}` : "Capture the lesson"}
        onClose={() => setCaptureFor(null)}
        wide
      >
        {captureFor ? (
          <>
            <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
              <p className="font-medium">{captureFor.rationale}</p>
              <p className="mt-1 text-xs">
                Raised {formatDateTime(captureFor.raisedAt)} · due {formatDate(captureFor.dueAt)} ·{" "}
                {fmtInt(captureFor.ageDays)} days open. Saving this lesson discharges the trigger and
                satisfies its obligation.
              </p>
            </div>
            <LessonForm
              submitLabel="Capture lesson"
              lockedEvidenceNote={
                captureFor.sourceRef
                  ? `The triggering record (${captureFor.sourceRef.label || captureFor.sourceRef.recordId}) is attached as evidence automatically — you do not need to add it here.`
                  : undefined
              }
              onSubmit={captureLesson}
              onCancel={() => setCaptureFor(null)}
            />
          </>
        ) : null}
      </Modal>

      {/* -------------------------------- dismissal ------------------------------- */}
      <Modal
        open={dismissFor !== null}
        title="Dismiss this trigger"
        onClose={() => setDismissFor(null)}
      >
        <p className="mb-3 text-sm text-ink-600">
          Dismissal is the only way out of a capture trigger other than writing the lesson, and it is
          deliberately expensive: your name and your reason are recorded on the trigger and in the ledger,
          the obligation is <em>waived</em> rather than satisfied, and the dismissal counts against the
          company's capture rate.
        </p>
        {dismissFor ? (
          <p className="mb-3 rounded bg-ink-50 px-3 py-2 text-xs text-ink-700">{dismissFor.rationale}</p>
        ) : null}
        <ErrorAlert message={actionError} />
        <Field label="Reason *" hint={`At least ${MIN_REASON} characters — an unrecorded decision is not a decision.`}>
          <Textarea
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value)}
            rows={3}
            maxLength={2000}
          />
        </Field>
        <p className="mt-1 text-xs text-ink-400">
          {dismissReason.trim().length} / {MIN_REASON} characters minimum
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDismissFor(null)} disabled={dismissing}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void dismiss()}
            disabled={dismissing || dismissReason.trim().length < MIN_REASON}
          >
            {dismissing ? "Dismissing…" : "Dismiss trigger"}
          </Button>
        </div>
      </Modal>

      {openLessonId ? (
        <LessonDrawer
          lessonId={openLessonId}
          projects={projects}
          canSupersede={canSupersede}
          onClose={() => setOpenLessonId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
