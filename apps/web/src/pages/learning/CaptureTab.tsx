/**
 * Capture & review for one project — the whole lesson lifecycle, plus the
 * retrieval panel and the post-project reviews.
 *
 * draft → submitted → validated → published, with rejection back to the
 * author. Two rules from the API are surfaced rather than hidden:
 *
 *   · VALIDATION IS A SECOND PAIR OF EYES. Neither the author nor whoever
 *     submitted a lesson may validate it, and the server's 403 is rendered as
 *     the deliberate independence rule it is — not as an error the user has
 *     done something wrong to deserve.
 *   · Only a published lesson can be applied or retrieved. A draft is not
 *     organisational memory, and the UI never implies otherwise.
 */
import { useCallback, useEffect, useState } from "react";
import { LESSON_CATEGORIES, LESSON_STATUSES } from "@constructos/shared";
import { ApiClientError, api } from "../../lib/api";
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
import { formatDate } from "../format";
import ApplyModal from "./ApplyModal";
import type { ApplyOutcome } from "./ApplyModal";
import LessonDrawer from "./LessonDrawer";
import LessonForm from "./LessonForm";
import type { LessonBody } from "./LessonForm";
import RelevantPanel from "./RelevantPanel";
import ReviewsPanel from "./ReviewsPanel";
import {
  LoadError,
  NoteCard,
  SectionTitle,
  TagList,
  errorMessage,
  fmtInt,
  impactLabel,
  label,
  lessonStatusTone,
} from "./learningShared";
import type { Lesson, ListResponse, ProjectRow } from "./learningShared";

const MIN_REASON = 10;

export default function CaptureTab({
  projectId,
  projects,
  canAdmin,
}: {
  projectId: string;
  projects: ProjectRow[] | null;
  canAdmin: boolean;
}) {
  const base = `/api/v1/projects/${projectId}/learning/lessons`;

  const [rows, setRows] = useState<Lesson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** the server's independence refusal (403), kept apart from ordinary errors */
  const [independence, setIndependence] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editFor, setEditFor] = useState<Lesson | null>(null);
  const [applyFor, setApplyFor] = useState<Lesson | null>(null);
  const [rejectFor, setRejectFor] = useState<Lesson | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [openLessonId, setOpenLessonId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      if (category) params.set("category", category);
      const res = await api.get<ListResponse<Lesson>>(`${base}?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setRows(null);
      setError(errorMessage(err, "Failed to load this project's lessons"));
    }
  }, [base, page, status, category]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One lifecycle POST. A 403 on validate or reject is the independence rule
   * and is rendered as such; a 403 on publish is an ordinary permission
   * refusal and must NOT be dressed up as one, so the two are kept apart.
   */
  async function act(lesson: Lesson, path: "submit" | "validate" | "publish", successNote: string) {
    setBusyId(lesson.id);
    setActionError(null);
    setIndependence(null);
    setNotice(null);
    try {
      await api.post(`${base}/${lesson.id}/${path}`);
      setNotice(successNote);
      await load();
    } catch (err) {
      const independenceRule = path === "validate";
      if (err instanceof ApiClientError && err.status === 403 && independenceRule) {
        setIndependence(err.message);
      } else {
        setActionError(errorMessage(err, "The action was refused"));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function create(body: LessonBody) {
    const created = await api.post<Lesson>(base, body);
    setCreateOpen(false);
    setNotice(
      `${created.number} saved as a draft. It is not organisational memory yet — submit it for validation, then publish it company-wide.`,
    );
    await load();
  }

  async function saveEdit(body: LessonBody) {
    if (!editFor) return;
    await api.patch<Lesson>(`${base}/${editFor.id}`, body);
    setEditFor(null);
    setNotice("Lesson updated.");
    await load();
  }

  async function reject() {
    if (!rejectFor || rejectReason.trim().length < MIN_REASON) return;
    setRejecting(true);
    setActionError(null);
    setIndependence(null);
    try {
      await api.post(`${base}/${rejectFor.id}/reject`, { reason: rejectReason.trim() });
      setRejectFor(null);
      setRejectReason("");
      setNotice("Lesson rejected and sent back to its author with your reason attached.");
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) setIndependence(err.message);
      else setActionError(errorMessage(err, "The rejection was refused"));
    } finally {
      setRejecting(false);
    }
  }

  function applied(outcome: ApplyOutcome) {
    setApplyFor(null);
    setNotice(
      outcome.crossedProjectBoundary
        ? "Application recorded — it crossed a project boundary."
        : "Application recorded on this lesson's own origin project, so it does not count as the knowledge crossing a project boundary.",
    );
    void load();
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-5">
      {/* -------------------- retrieval, before you write anything ------------- */}
      <RelevantPanel
        projectId={projectId}
        projects={projects}
        onInspect={(id) => setOpenLessonId(id)}
        onApplied={() => void load()}
      />

      {/* ------------------------------ the lifecycle ------------------------- */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SectionTitle hint="Every lesson this project has learned, in whatever state it has reached. Only published lessons are retrievable company-wide.">
              Lessons on this project
            </SectionTitle>
            <div className="flex items-end gap-2">
              <div className="min-w-36">
                <Field label="Status">
                  <Select
                    value={status}
                    onChange={(e) => {
                      setPage(1);
                      setStatus(e.target.value);
                    }}
                  >
                    <option value="">Any status</option>
                    {LESSON_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="min-w-40">
                <Field label="Category">
                  <Select
                    value={category}
                    onChange={(e) => {
                      setPage(1);
                      setCategory(e.target.value);
                    }}
                  >
                    <option value="">Any category</option>
                    {LESSON_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {label(c)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button onClick={() => setCreateOpen(true)}>Capture a lesson</Button>
            </div>
          </div>

          <ErrorAlert message={actionError} />
          {independence ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 ring-1 ring-amber-200" role="alert">
              <p className="text-sm font-semibold text-amber-900">
                Refused — and this is the rule working, not a bug.
              </p>
              <p className="mt-1 text-sm text-amber-800">{independence}</p>
              <p className="mt-1 text-xs text-amber-700">
                Validation is a second pair of eyes: neither the author of a lesson nor the person who
                submitted it may decide it. A register self-signed by its own authors is a filing cabinet.
                Ask a colleague to validate this one.
              </p>
            </div>
          ) : null}
          {notice ? <NoteCard note={notice} tone="brand" /> : null}

          {error ? (
            <LoadError message={error} onRetry={() => void load()} />
          ) : rows === null ? (
            <Spinner label="Loading lessons…" />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No lesson captured on this project yet"
              hint="Capture one directly, or discharge an open capture trigger from the Triggers tab — a trigger-linked lesson arrives with its evidence already attached."
              action={<Button onClick={() => setCreateOpen(true)}>Capture a lesson</Button>}
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Lesson</Th>
                    <Th>Category</Th>
                    <Th>Status</Th>
                    <Th>Impact</Th>
                    <Th>Tags</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rows.map((l) => (
                    <tr key={l.id}>
                      <Td>
                        <span className="font-mono text-xs text-ink-500">{l.number}</span>
                        <div className="font-medium text-ink-900">{l.title}</div>
                        <div className="text-xs text-ink-400">created {formatDate(l.createdAt)}</div>
                        {l.status === "rejected" && l.rejectionReason ? (
                          <div className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-800">
                            <span className="font-medium">Rejected:</span> {l.rejectionReason}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <Badge tone="blue">{label(l.category)}</Badge>
                        {l.phase ? <div className="mt-1 text-xs text-ink-500">{l.phase}</div> : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <Badge tone={lessonStatusTone(l.status)}>{label(l.status)}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {impactLabel(l.impactValue, l.impactCurrency, l.impactDays)}
                      </Td>
                      <Td className="max-w-40">
                        <TagList tags={l.tags} />
                      </Td>
                      <Td>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {(l.status === "draft" || l.status === "rejected") && (
                            <>
                              <Button size="sm" variant="secondary" onClick={() => setEditFor(l)}>
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                disabled={busyId === l.id}
                                onClick={() =>
                                  void act(
                                    l,
                                    "submit",
                                    `${l.number} submitted for validation. Someone other than you and its author must now validate it.`,
                                  )
                                }
                              >
                                Submit
                              </Button>
                            </>
                          )}
                          {l.status === "submitted" && (
                            <>
                              <Button
                                size="sm"
                                disabled={busyId === l.id}
                                onClick={() =>
                                  void act(
                                    l,
                                    "validate",
                                    `${l.number} validated. An admin can now publish it company-wide.`,
                                  )
                                }
                              >
                                Validate
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setRejectFor(l);
                                  setRejectReason("");
                                }}
                              >
                                Reject…
                              </Button>
                            </>
                          )}
                          {l.status === "validated" && (
                            <Button
                              size="sm"
                              disabled={busyId === l.id}
                              onClick={() =>
                                void act(
                                  l,
                                  "publish",
                                  `${l.number} published company-wide. It leaves this project (its origin is retained) and becomes retrievable and applicable everywhere.`,
                                )
                              }
                              title={canAdmin ? undefined : "Publishing requires admin rights on the learning tool"}
                            >
                              Publish
                            </Button>
                          )}
                          {l.status === "published" && (
                            <Button size="sm" onClick={() => setApplyFor(l)}>
                              Apply
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setOpenLessonId(l.id)}>
                            Inspect
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>

              <div className="flex items-center justify-between text-xs text-ink-500">
                <span>
                  {fmtInt(total)} lesson{total === 1 ? "" : "s"} · page {page} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
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
        </CardBody>
      </Card>

      {/* ------------------------------- reviews ------------------------------ */}
      <ReviewsPanel projectId={projectId} canAdmin={canAdmin} />

      {/* -------------------------------- modals ------------------------------ */}
      <Modal open={createOpen} title="Capture a lesson" onClose={() => setCreateOpen(false)} wide>
        <LessonForm submitLabel="Save draft" onSubmit={create} onCancel={() => setCreateOpen(false)} />
      </Modal>

      <Modal
        open={editFor !== null}
        title={editFor ? `Edit ${editFor.number}` : "Edit lesson"}
        onClose={() => setEditFor(null)}
        wide
      >
        {editFor ? (
          <>
            <p className="mb-3 text-xs text-ink-500">
              Only a draft or rejected lesson can be edited. Once it is validated or published, the way to
              change what the organisation believes is to supersede it with a new lesson.
            </p>
            <LessonForm
              initial={editFor}
              submitLabel="Save changes"
              onSubmit={saveEdit}
              onCancel={() => setEditFor(null)}
            />
          </>
        ) : null}
      </Modal>

      <Modal
        open={rejectFor !== null}
        title={rejectFor ? `Reject ${rejectFor.number}` : "Reject lesson"}
        onClose={() => setRejectFor(null)}
      >
        <p className="mb-3 text-sm text-ink-600">
          Rejection sends the lesson back to its author with your reason attached. The author cannot reject
          their own lesson — that would not be a review.
        </p>
        <ErrorAlert message={actionError} />
        <Field label="Reason *" hint={`At least ${MIN_REASON} characters.`}>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            maxLength={2000}
          />
        </Field>
        <p className="mt-1 text-xs text-ink-400">
          {rejectReason.trim().length} / {MIN_REASON} characters minimum
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRejectFor(null)} disabled={rejecting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void reject()}
            disabled={rejecting || rejectReason.trim().length < MIN_REASON}
          >
            {rejecting ? "Rejecting…" : "Reject lesson"}
          </Button>
        </div>
      </Modal>

      {applyFor ? (
        <ApplyModal
          open
          lessonId={applyFor.id}
          lessonNumber={applyFor.number}
          lessonTitle={applyFor.title}
          originProjectId={applyFor.originProjectId}
          projects={projects}
          fixedProjectId={projectId}
          onClose={() => setApplyFor(null)}
          onApplied={applied}
        />
      ) : null}

      {openLessonId ? (
        <LessonDrawer
          lessonId={openLessonId}
          projects={projects}
          canSupersede={canAdmin}
          onClose={() => setOpenLessonId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
