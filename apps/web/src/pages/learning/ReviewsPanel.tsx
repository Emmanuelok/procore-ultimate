/**
 * Post-project reviews (#991).
 *
 * Two rules from the API are enforced in the UI rather than discovered by the
 * user hitting a 409:
 *
 *   · the transition graph is mirrored here, so only legal transitions are
 *     offered, `signed_off` is terminal, and `completed` cannot be reached
 *     without the date the review was held;
 *   · a signed-off review is frozen — editing and recomputing metrics are
 *     disabled with the reason shown, not left to fail.
 *
 * And the metrics panel keeps the module's central honesty rule: a metric the
 * platform cannot compute comes back null WITH reasons, and is rendered as
 * "not available" plus those reasons verbatim. Never as zero.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LESSON_CATEGORIES } from "@constructos/shared";
import { api } from "../../lib/api";
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
import { formatDate, formatDateTime } from "../format";
import {
  Drawer,
  KV,
  LoadError,
  NoteCard,
  REVIEW_TRANSITIONS,
  SectionTitle,
  errorMessage,
  fmtInt,
  fmtNum,
  label,
  reviewStatusTone,
} from "./learningShared";
import type {
  LessonListRow,
  ListResponse,
  Review,
  ReviewFinding,
  ReviewMetricsResult,
  ReviewParticipant,
  ReviewStatus,
} from "./learningShared";

const TRANSITION_LABEL: Record<ReviewStatus, string> = {
  scheduled: "Reschedule",
  in_progress: "Start",
  completed: "Complete",
  signed_off: "Sign off",
  cancelled: "Cancel review",
};

function transitionLabel(from: ReviewStatus, to: ReviewStatus): string {
  if (to === "in_progress" && from === "completed") return "Reopen";
  return TRANSITION_LABEL[to];
}

/* ------------------------------- metrics panel ------------------------------ */

function MetricsPanel({
  metrics,
  computing,
  canCompute,
  frozenReason,
  onCompute,
}: {
  metrics: Partial<ReviewMetricsResult> | null;
  computing: boolean;
  canCompute: boolean;
  frozenReason: string | null;
  onCompute: () => void;
}) {
  const rows = metrics && Array.isArray(metrics.metrics) ? metrics.metrics : null;
  return (
    <Card>
      <CardBody>
        <SectionTitle hint="Computed from the project's own records, not from the room's memory.">
          Review metrics
        </SectionTitle>

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Button onClick={onCompute} disabled={!canCompute || computing}>
            {computing ? "Computing…" : rows ? "Recompute metrics" : "Compute metrics"}
          </Button>
          {metrics?.computedAt ? (
            <span className="text-xs text-ink-500">
              last computed {formatDateTime(metrics.computedAt)}
              {metrics.currency ? ` · currency ${metrics.currency}` : ""}
            </span>
          ) : null}
        </div>

        {frozenReason ? <NoteCard note={frozenReason} tone="amber" /> : null}

        {rows === null ? (
          <p className="mt-2 text-sm text-ink-500">
            No metrics computed yet. Computing reads the project's contracts, variations, schedule,
            signals, obligations, RFIs, punch items and lessons — and reports what it cannot read.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {metrics?.unavailable && metrics.unavailable.length > 0 ? (
              <NoteCard
                tone="amber"
                note={`${metrics.unavailable.length} of ${rows.length} metrics could not be computed from this project's records: ${metrics.unavailable.join(", ")}. Each one is listed below with the reason it is unavailable. None of them is zero.`}
              />
            ) : null}

            <Table>
              <thead>
                <tr>
                  <Th>Metric</Th>
                  <Th>Value</Th>
                  <Th>Why / inputs</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((m) => (
                  <tr key={m.key} className={m.value === null ? "bg-amber-50/40" : undefined}>
                    <Td>
                      <div className="font-medium text-ink-900">{m.name}</div>
                      <div className="font-mono text-[11px] text-ink-400">{m.key}</div>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {m.value === null ? (
                        <Badge tone="amber">Not available</Badge>
                      ) : (
                        <span className="text-sm font-semibold tabular-nums text-ink-900">
                          {fmtNum(m.value, 2)}{" "}
                          <span className="text-xs font-normal text-ink-500">{m.unit}</span>
                        </span>
                      )}
                    </Td>
                    <Td>
                      {m.reasons.length > 0 ? (
                        <ul className="space-y-1">
                          {m.reasons.map((r, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-xs text-amber-900">
                              <span aria-hidden className="mt-0.5">
                                ▪
                              </span>
                              <span>{r}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {m.inputs && Object.keys(m.inputs).length > 0 ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs font-medium text-ink-500">
                            Inputs the computation read
                          </summary>
                          <pre className="mt-1 overflow-x-auto rounded bg-ink-50 p-2 text-[11px] leading-4 text-ink-700">
                            {JSON.stringify(m.inputs, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            {metrics?.methodology ? (
              <NoteCard note={metrics.methodology} tone="ink" title="Methodology —" />
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/* -------------------------------- the drawer -------------------------------- */

function ReviewDrawer({
  projectId,
  reviewId,
  canAdmin,
  onClose,
  onChanged,
}: {
  projectId: string;
  reviewId: string;
  canAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/learning/reviews/${reviewId}`;
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [computing, setComputing] = useState(false);
  const [fresh, setFresh] = useState<ReviewMetricsResult | null>(null);

  /* edit buffers */
  const [title, setTitle] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [heldAt, setHeldAt] = useState("");
  const [facilitator, setFacilitator] = useState("");
  const [wentWell, setWentWell] = useState("");
  const [didNot, setDidNot] = useState("");
  const [participants, setParticipants] = useState<ReviewParticipant[]>([]);
  const [findings, setFindings] = useState<ReviewFinding[]>([]);

  const [transitionTo, setTransitionTo] = useState<ReviewStatus | null>(null);
  const [transitionHeldAt, setTransitionHeldAt] = useState("");
  const [transitionNote, setTransitionNote] = useState("");

  /** published lessons, so a finding can be tied to the lesson it produced */
  const [published, setPublished] = useState<LessonListRow[] | null>(null);

  const hydrate = useCallback((r: Review) => {
    setReview(r);
    setTitle(r.title);
    setScheduledFor(r.scheduledFor ?? "");
    setHeldAt(r.heldAt ?? "");
    setFacilitator(r.facilitator ?? "");
    setWentWell(r.whatWentWell ?? "");
    setDidNot(r.whatDidNot ?? "");
    setParticipants(Array.isArray(r.participants) ? r.participants : []);
    setFindings(Array.isArray(r.findings) ? r.findings : []);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      hydrate(await api.get<Review>(base));
    } catch (err) {
      setReview(null);
      setError(errorMessage(err, "Failed to load the review"));
    }
  }, [base, hydrate]);

  useEffect(() => {
    setNotice(null);
    setActionError(null);
    setFresh(null);
    void load();
  }, [load]);

  /* A finding that becomes a lesson is the point of holding the review. */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api.get<ListResponse<LessonListRow>>(
          "/api/v1/learning/lessons?page=1&pageSize=200&status=published",
        );
        if (live) setPublished(res.items);
      } catch {
        if (live) setPublished([]);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const frozen = review?.status === "signed_off";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!review || frozen) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.patch<Review>(base, {
        title: title.trim(),
        scheduledFor: scheduledFor ? scheduledFor : null,
        heldAt: heldAt ? heldAt : null,
        facilitator: facilitator.trim() ? facilitator.trim() : null,
        whatWentWell: wentWell.trim() ? wentWell.trim() : null,
        whatDidNot: didNot.trim() ? didNot.trim() : null,
        participants: participants
          .filter((p) => p.name.trim())
          .map((p) => ({
            /* userId is not editable here, but it must survive a save */
            ...(p.userId ? { userId: p.userId } : {}),
            name: p.name.trim(),
            role: p.role?.trim() ? p.role.trim() : null,
          })),
        /* category is optional-but-not-nullable on the server: omit it rather
           than sending null, which the schema would reject outright. */
        findings: findings
          .filter((f) => f.text.trim())
          .map((f) => ({
            ...(f.id ? { id: f.id } : {}),
            text: f.text.trim(),
            ...(f.category ? { category: f.category } : {}),
            lessonId: f.lessonId ?? null,
          })),
      });
      hydrate(updated);
      setNotice("Saved.");
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, "The review could not be saved"));
    } finally {
      setBusy(false);
    }
  }

  async function transition() {
    if (!review || !transitionTo) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.post<Review>(`${base}/transition`, {
        to: transitionTo,
        ...(transitionTo === "completed" && transitionHeldAt ? { heldAt: transitionHeldAt } : {}),
        ...(transitionNote.trim() ? { note: transitionNote.trim() } : {}),
      });
      hydrate(updated);
      setTransitionTo(null);
      setTransitionHeldAt("");
      setTransitionNote("");
      setNotice(`Review is now ${label(updated.status)}.`);
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, "The transition was refused"));
    } finally {
      setBusy(false);
    }
  }

  async function signOff() {
    if (!review) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.post<Review>(`${base}/sign-off`);
      hydrate(updated);
      setNotice(
        "Signed off. The review is frozen: its findings and its metrics are now the figures that were signed for.",
      );
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, "Sign-off was refused"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!review) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.del(base);
      onChanged();
      onClose();
    } catch (err) {
      setActionError(errorMessage(err, "The review could not be deleted"));
      setBusy(false);
    }
  }

  async function computeMetrics() {
    if (!review) return;
    setComputing(true);
    setActionError(null);
    try {
      const res = await api.post<ReviewMetricsResult>(`${base}/compute-metrics`);
      setFresh(res);
      await load();
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, "Metrics could not be computed"));
    } finally {
      setComputing(false);
    }
  }

  const body = (() => {
    if (error) return <LoadError message={error} onRetry={() => void load()} />;
    if (review === null) return <Spinner label="Loading review…" />;

    const from = review.status;
    const allowed = REVIEW_TRANSITIONS[from] ?? [];

    return (
      <div className="space-y-4">
        <ErrorAlert message={actionError} />
        {notice ? <NoteCard note={notice} tone="brand" /> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={reviewStatusTone(review.status)}>{label(review.status)}</Badge>
          {review.signedOffAt ? (
            <span className="text-xs text-ink-500">
              signed off {formatDateTime(review.signedOffAt)} by {review.signedOffBy ?? "—"}
            </span>
          ) : null}
        </div>

        {/* ------------------------------ transitions ---------------------------- */}
        <Card>
          <CardBody>
            <SectionTitle hint="Only the transitions the server allows from this state are offered.">
              Status
            </SectionTitle>
            {allowed.length === 0 ? (
              <NoteCard
                tone="ink"
                note={
                  from === "signed_off"
                    ? "Signed off is terminal. This review cannot be moved to any other status, edited, or recomputed."
                    : "There is no transition available from this status."
                }
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {allowed.map((to) => {
                  const needsHeld = to === "completed" && !review.heldAt;
                  return (
                    <Button
                      key={to}
                      size="sm"
                      variant={to === "cancelled" ? "secondary" : "primary"}
                      disabled={busy}
                      onClick={() => {
                        setTransitionTo(to);
                        setTransitionHeldAt(review.heldAt ?? "");
                        setTransitionNote("");
                      }}
                      title={
                        needsHeld
                          ? "Completing a review requires the date it was held — you will be asked for it"
                          : undefined
                      }
                    >
                      {transitionLabel(from, to)}
                    </Button>
                  );
                })}
                {from === "completed" ? (
                  <Button size="sm" onClick={() => void signOff()} disabled={busy || !canAdmin}>
                    Sign off
                  </Button>
                ) : null}
              </div>
            )}
            {from === "completed" && !canAdmin ? (
              <p className="mt-2 text-xs text-ink-400">
                Sign-off is an admin action; the server will refuse it for anyone else.
              </p>
            ) : null}
            {(from === "scheduled" || from === "cancelled") && canAdmin ? (
              <div className="mt-3 border-t border-ink-100 pt-3">
                <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy}>
                  Delete review
                </Button>
                <p className="mt-1 text-xs text-ink-400">
                  Only a scheduled or cancelled review can be deleted — once it holds findings and
                  metrics, cancel it instead.
                </p>
              </div>
            ) : null}
          </CardBody>
        </Card>

        {/* -------------------------------- the record --------------------------- */}
        <Card>
          <CardBody>
            <SectionTitle>Review record</SectionTitle>
            {frozen ? (
              <div className="mb-3">
                <NoteCard
                  tone="amber"
                  note="This review is signed off and therefore frozen. Editing is disabled here because the server refuses it — reopening is not possible either, sign-off is terminal."
                />
              </div>
            ) : null}
            <form onSubmit={save} className="space-y-3">
              <Field label="Title">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={frozen} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Scheduled for">
                  <Input
                    type="date"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                    disabled={frozen}
                  />
                </Field>
                <Field label="Held at" hint="Required before a review can be completed.">
                  <Input
                    type="date"
                    value={heldAt}
                    onChange={(e) => setHeldAt(e.target.value)}
                    disabled={frozen}
                  />
                </Field>
                <Field label="Facilitator">
                  <Input
                    value={facilitator}
                    onChange={(e) => setFacilitator(e.target.value)}
                    disabled={frozen}
                  />
                </Field>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-600">Participants</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={frozen}
                    onClick={() => setParticipants((p) => [...p, { name: "", role: "" }])}
                  >
                    Add participant
                  </Button>
                </div>
                {participants.length === 0 ? (
                  <p className="text-xs text-ink-400">None recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {participants.map((p, i) => (
                      <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                        <Input
                          value={p.name}
                          placeholder="Name"
                          disabled={frozen}
                          onChange={(e) =>
                            setParticipants((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                            )
                          }
                        />
                        <Input
                          value={p.role ?? ""}
                          placeholder="Role"
                          disabled={frozen}
                          onChange={(e) =>
                            setParticipants((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)),
                            )
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={frozen}
                          onClick={() => setParticipants((prev) => prev.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Field label="What went well">
                <Textarea
                  value={wentWell}
                  onChange={(e) => setWentWell(e.target.value)}
                  rows={3}
                  disabled={frozen}
                />
              </Field>
              <Field label="What did not">
                <Textarea
                  value={didNot}
                  onChange={(e) => setDidNot(e.target.value)}
                  rows={3}
                  disabled={frozen}
                />
              </Field>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-600">Findings</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={frozen}
                    onClick={() => setFindings((f) => [...f, { text: "", category: null }])}
                  >
                    Add finding
                  </Button>
                </div>
                {findings.length === 0 ? (
                  <p className="text-xs text-ink-400">
                    None. A finding that never becomes a lesson stays inside this review.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {findings.map((f, i) => (
                      <div key={f.id ?? i} className="grid gap-2 sm:grid-cols-[1fr_9rem_11rem_auto]">
                        <Textarea
                          value={f.text}
                          rows={2}
                          placeholder="What the review found"
                          disabled={frozen}
                          onChange={(e) =>
                            setFindings((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                            )
                          }
                        />
                        <Select
                          value={f.category ?? ""}
                          disabled={frozen}
                          onChange={(e) =>
                            setFindings((prev) =>
                              prev.map((x, j) =>
                                j === i ? { ...x, category: e.target.value || null } : x,
                              ),
                            )
                          }
                        >
                          <option value="">No category</option>
                          {LESSON_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {label(c)}
                            </option>
                          ))}
                        </Select>
                        <Select
                          value={f.lessonId ?? ""}
                          disabled={frozen || published === null}
                          title="Link the published lesson this finding produced"
                          onChange={(e) =>
                            setFindings((prev) =>
                              prev.map((x, j) =>
                                j === i ? { ...x, lessonId: e.target.value || null } : x,
                              ),
                            )
                          }
                        >
                          <option value="">
                            {published === null ? "Loading lessons…" : "No lesson linked"}
                          </option>
                          {(published ?? []).map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.number} — {l.title}
                            </option>
                          ))}
                        </Select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={frozen}
                          onClick={() => setFindings((prev) => prev.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <Button type="submit" disabled={frozen || busy}>
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        {/* --------------------------------- metrics ------------------------------ */}
        <MetricsPanel
          metrics={fresh ?? review.metrics ?? null}
          computing={computing}
          canCompute={!frozen}
          frozenReason={
            frozen
              ? "Metrics cannot be recomputed on a signed-off review — the figures on it are the ones that were signed for."
              : null
          }
          onCompute={() => void computeMetrics()}
        />

        <Card>
          <CardBody className="space-y-0.5">
            <SectionTitle>Provenance</SectionTitle>
            <KV k="Created" v={formatDateTime(review.createdAt)} />
            <KV k="Created by" v={<span className="font-mono text-xs">{review.createdBy}</span>} />
            <KV k="Updated" v={formatDateTime(review.updatedAt)} />
          </CardBody>
        </Card>
      </div>
    );
  })();

  return (
    <>
      <Drawer open wide onClose={onClose} title={review ? review.title : "Post-project review"}>
        {body}
      </Drawer>

      <Modal
        open={transitionTo !== null}
        title={
          review && transitionTo
            ? `${transitionLabel(review.status, transitionTo)} — ${label(review.status)} → ${label(transitionTo)}`
            : "Change status"
        }
        onClose={() => setTransitionTo(null)}
      >
        <ErrorAlert message={actionError} />
        {transitionTo === "completed" ? (
          <Field
            label="Held at *"
            hint="A review cannot be completed without the date it was actually held — the server requires it."
          >
            <Input
              type="date"
              value={transitionHeldAt}
              onChange={(e) => setTransitionHeldAt(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="mt-3">
          <Field label="Note" hint="Recorded in the ledger with the transition.">
            <Textarea
              value={transitionNote}
              onChange={(e) => setTransitionNote(e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setTransitionTo(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void transition()}
            disabled={busy || (transitionTo === "completed" && !transitionHeldAt)}
          >
            {busy ? "Applying…" : "Confirm"}
          </Button>
        </div>
      </Modal>
    </>
  );
}

/* --------------------------------- the panel -------------------------------- */

export default function ReviewsPanel({
  projectId,
  canAdmin,
}: {
  projectId: string;
  canAdmin: boolean;
}) {
  const [rows, setRows] = useState<Review[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newScheduled, setNewScheduled] = useState("");
  const [newFacilitator, setNewFacilitator] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "50" });
      if (status) params.set("status", status);
      const res = await api.get<ListResponse<Review>>(
        `/api/v1/projects/${projectId}/learning/reviews?${params.toString()}`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setRows(null);
      setError(errorMessage(err, "Failed to load post-project reviews"));
    }
  }, [projectId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.post<Review>(`/api/v1/projects/${projectId}/learning/reviews`, {
        title: newTitle.trim(),
        scheduledFor: newScheduled || null,
        facilitator: newFacilitator.trim() || null,
      });
      setCreateOpen(false);
      setNewTitle("");
      setNewScheduled("");
      setNewFacilitator("");
      await load();
      setOpenId(created.id);
    } catch (err) {
      setCreateError(errorMessage(err, "The review could not be created"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionTitle hint="A review whose numbers come from the room's memory is a feelings exercise. These read the project's records.">
            Post-project reviews
          </SectionTitle>
          <div className="flex items-end gap-2">
            <div className="min-w-40">
              <Field label="Status">
                <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Any status</option>
                  {(["scheduled", "in_progress", "completed", "signed_off", "cancelled"] as ReviewStatus[]).map(
                    (s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ),
                  )}
                </Select>
              </Field>
            </div>
            <Button onClick={() => setCreateOpen(true)}>Schedule review</Button>
          </div>
        </div>

        {error ? (
          <LoadError message={error} onRetry={() => void load()} />
        ) : rows === null ? (
          <Spinner label="Loading reviews…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No post-project review on this project"
            hint="Schedule one to hold the conversation against computed figures rather than recollection."
            action={<Button onClick={() => setCreateOpen(true)}>Schedule review</Button>}
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Review</Th>
                  <Th>Status</Th>
                  <Th>Scheduled</Th>
                  <Th>Held</Th>
                  <Th>Findings</Th>
                  <Th>Metrics</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => {
                  const computed = r.metrics && Array.isArray(r.metrics.metrics) ? r.metrics.metrics : null;
                  const unavailable = r.metrics?.unavailable?.length ?? 0;
                  return (
                    <tr key={r.id}>
                      <Td>
                        <div className="font-medium text-ink-900">{r.title}</div>
                        {r.facilitator ? (
                          <div className="text-xs text-ink-400">facilitator {r.facilitator}</div>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <Badge tone={reviewStatusTone(r.status)}>{label(r.status)}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap text-xs">{formatDate(r.scheduledFor)}</Td>
                      <Td className="whitespace-nowrap text-xs">{formatDate(r.heldAt)}</Td>
                      <Td className="tabular-nums">{fmtInt(Array.isArray(r.findings) ? r.findings.length : 0)}</Td>
                      <Td className="whitespace-nowrap text-xs">
                        {computed === null ? (
                          <span className="text-ink-400">not computed</span>
                        ) : (
                          <span>
                            {fmtInt(computed.length - unavailable)} of {fmtInt(computed.length)} computed
                            {unavailable > 0 ? (
                              <span className="text-amber-700"> · {fmtInt(unavailable)} unavailable</span>
                            ) : null}
                          </span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <Button size="sm" variant="secondary" onClick={() => setOpenId(r.id)}>
                          Open
                        </Button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <p className="text-xs text-ink-500">
              {fmtInt(total)} review{total === 1 ? "" : "s"} on this project.
            </p>
          </>
        )}
      </CardBody>

      <Modal open={createOpen} title="Schedule a post-project review" onClose={() => setCreateOpen(false)}>
        <form onSubmit={create} className="space-y-3">
          <ErrorAlert message={createError} />
          <Field label="Title *">
            <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={300} />
          </Field>
          <Field label="Scheduled for">
            <Input type="date" value={newScheduled} onChange={(e) => setNewScheduled(e.target.value)} />
          </Field>
          <Field label="Facilitator">
            <Input value={newFacilitator} onChange={(e) => setNewFacilitator(e.target.value)} maxLength={200} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" disabled={!newTitle.trim() || creating}>
              {creating ? "Scheduling…" : "Schedule"}
            </Button>
          </div>
        </form>
      </Modal>

      {openId ? (
        <ReviewDrawer
          projectId={projectId}
          reviewId={openId}
          canAdmin={canAdmin}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </Card>
  );
}
