/**
 * The whole lesson, plus the two things a register normally hides: whether it
 * was ever used, and whether the use crossed a project boundary.
 *
 *   · the record itself, with its evidence references and its trigger origin
 *     (which event made capturing it mandatory in the first place);
 *   · the impact report (#979) — projects reached, cross-project applications,
 *     outcomes recorded, and the server's own verdict rendered verbatim;
 *   · supersession, in both directions;
 *   · apply, which is how a lesson stops being a document.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, formatDateTime } from "../format";
import ApplyModal from "./ApplyModal";
import OutcomeForm from "./OutcomeForm";
import type { ApplyOutcome } from "./ApplyModal";
import {
  Drawer,
  KV,
  LESSON_OUTCOME_LABELS,
  LoadError,
  NoteCard,
  Prose,
  RefLine,
  SectionTitle,
  TagList,
  errorMessage,
  fmtInt,
  impactLabel,
  label,
  lessonStatusTone,
  projectNameOf,
  triggerStatusTone,
} from "./learningShared";
import type {
  LessonApplication,
  LessonDetail,
  LessonImpact,
  LessonListRow,
  ListResponse,
  ProjectRow,
} from "./learningShared";

export default function LessonDrawer({
  lessonId,
  projects,
  canSupersede,
  onClose,
  onChanged,
}: {
  lessonId: string;
  projects: ProjectRow[] | null;
  /** company owner/admin — the server enforces this too, and its refusal is surfaced */
  canSupersede: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lesson, setLesson] = useState<LessonDetail | null>(null);
  const [impact, setImpact] = useState<LessonImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [applyOpen, setApplyOpen] = useState(false);
  const [measuring, setMeasuring] = useState<LessonApplication | null>(null);
  const [supersedeOpen, setSupersedeOpen] = useState(false);
  const [candidates, setCandidates] = useState<LessonListRow[] | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const [superseding, setSuperseding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setLesson(await api.get<LessonDetail>(`/api/v1/learning/lessons/${lessonId}`));
    } catch (err) {
      setLesson(null);
      setError(errorMessage(err, "Failed to load the lesson"));
    }
  }, [lessonId]);

  const loadImpact = useCallback(async () => {
    setImpactError(null);
    try {
      setImpact(await api.get<LessonImpact>(`/api/v1/learning/lessons/${lessonId}/impact`));
    } catch (err) {
      setImpact(null);
      setImpactError(errorMessage(err, "Failed to load the impact report"));
    }
  }, [lessonId]);

  useEffect(() => {
    setLesson(null);
    setImpact(null);
    setNotice(null);
    setActionError(null);
    void load();
    void loadImpact();
  }, [load, loadImpact]);

  async function openSupersede() {
    setSupersedeOpen(true);
    setActionError(null);
    if (candidates !== null) return;
    try {
      const res = await api.get<ListResponse<LessonListRow>>(
        "/api/v1/learning/lessons?page=1&pageSize=200&status=published",
      );
      setCandidates(res.items);
    } catch (err) {
      setCandidates([]);
      setActionError(errorMessage(err, "Failed to load candidate lessons"));
    }
  }

  async function supersede() {
    if (!replacementId) return;
    setSuperseding(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/learning/lessons/${lessonId}/supersede`, {
        supersededById: replacementId,
      });
      setSupersedeOpen(false);
      setReplacementId("");
      setNotice("This lesson is now superseded. It stays in the register; it is no longer retrievable.");
      await load();
      await loadImpact();
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, "The lesson could not be superseded"));
    } finally {
      setSuperseding(false);
    }
  }

  function onApplied(outcome: ApplyOutcome) {
    setApplyOpen(false);
    setNotice(
      outcome.crossedProjectBoundary
        ? "Application recorded — and it crossed a project boundary. This is the first-class evidence that the knowledge travelled."
        : "Application recorded on the lesson's own origin project. Worth having, but it is not evidence that the knowledge crossed a project boundary.",
    );
    void load();
    void loadImpact();
    onChanged();
  }

  const body = (() => {
    if (error) return <LoadError message={error} onRetry={() => void load()} />;
    if (lesson === null) return <Spinner label="Loading lesson…" />;

    return (
      <div className="space-y-4">
        <ErrorAlert message={actionError} />
        {notice ? <NoteCard note={notice} tone="brand" /> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={lessonStatusTone(lesson.status)}>{label(lesson.status)}</Badge>
          <Badge tone="blue">{label(lesson.category)}</Badge>
          {lesson.phase ? <Badge tone="violet">{lesson.phase}</Badge> : null}
          <span className="text-xs text-ink-400">
            {fmtInt(lesson.applicationCount)} application{lesson.applicationCount === 1 ? "" : "s"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {lesson.status === "published" ? (
            <Button size="sm" onClick={() => setApplyOpen(true)}>
              Apply this lesson
            </Button>
          ) : null}
          {lesson.status === "published" ? (
            <Button size="sm" variant="secondary" onClick={() => void openSupersede()} disabled={!canSupersede}>
              Supersede…
            </Button>
          ) : null}
        </div>
        {lesson.status === "published" && !canSupersede ? (
          <p className="text-xs text-ink-400">
            Superseding rewrites what the organisation believes, so it is restricted to company owners and
            admins.
          </p>
        ) : null}

        {/* ------------------------------ the record ----------------------------- */}
        <Card>
          <CardBody className="space-y-1">
            <SectionTitle>The record</SectionTitle>
            <KV k="Number" v={<span className="font-mono">{lesson.number}</span>} />
            <KV k="Origin project" v={projectNameOf(projects, lesson.originProjectId)} />
            <KV
              k="Current scope"
              v={
                lesson.projectId === null
                  ? "Company-wide (published lessons leave the project)"
                  : projectNameOf(projects, lesson.projectId)
              }
            />
            <KV k="Recorded impact" v={impactLabel(lesson.impactValue, lesson.impactCurrency, lesson.impactDays)} />
            <KV k="Tags" v={<TagList tags={lesson.tags} />} />
            <KV k="Created" v={formatDateTime(lesson.createdAt)} />
            <KV k="Submitted" v={lesson.submittedAt ? formatDateTime(lesson.submittedAt) : "—"} />
            <KV
              k="Validated"
              v={
                lesson.validatedAt
                  ? `${formatDateTime(lesson.validatedAt)} by ${lesson.validatedBy ?? "—"}`
                  : "—"
              }
            />
            <KV k="Published" v={lesson.publishedAt ? formatDateTime(lesson.publishedAt) : "—"} />
          </CardBody>
        </Card>

        {lesson.rejectionReason ? (
          <NoteCard note={lesson.rejectionReason} tone="red" title="Rejected —" />
        ) : null}

        {lesson.supersededBy ? (
          <NoteCard
            tone="amber"
            note={`Superseded by ${lesson.supersededBy.number} — ${lesson.supersededBy.title}. This lesson is kept for the record but is no longer what the organisation believes.`}
          />
        ) : null}

        <Card>
          <CardBody className="space-y-3">
            <div>
              <SectionTitle>Context</SectionTitle>
              <Prose text={lesson.context} />
            </div>
            <div>
              <SectionTitle>What happened</SectionTitle>
              <Prose text={lesson.whatHappened} />
            </div>
            <div>
              <SectionTitle>Root cause</SectionTitle>
              <Prose text={lesson.rootCause} />
            </div>
            <div>
              <SectionTitle>Recommendation</SectionTitle>
              <Prose text={lesson.recommendation} />
            </div>
            <div>
              <SectionTitle>Evidence references</SectionTitle>
              <RefLine refs={lesson.evidenceRefs} />
            </div>
          </CardBody>
        </Card>

        {/* ---------------------------- trigger origin --------------------------- */}
        <Card>
          <CardBody>
            <SectionTitle hint="Whether this lesson was written because something made it mandatory, or because somebody chose to.">
              Trigger origin
            </SectionTitle>
            {lesson.trigger === null ? (
              <p className="text-sm text-ink-500">
                No capture trigger is linked to this lesson — it was captured voluntarily rather than to
                discharge an obligation.
              </p>
            ) : (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="amber">{label(lesson.trigger.kind)}</Badge>
                  <Badge tone={triggerStatusTone(lesson.trigger.status)}>
                    {label(lesson.trigger.status)}
                  </Badge>
                </div>
                <KV k="Why it fired" v={<span className="text-sm">{lesson.trigger.rationale}</span>} />
                <KV k="Raised" v={formatDateTime(lesson.trigger.raisedAt)} />
                <KV k="Due" v={formatDate(lesson.trigger.dueAt)} />
                <KV k="Closed" v={lesson.trigger.closedAt ? formatDateTime(lesson.trigger.closedAt) : "—"} />
                <KV
                  k="Source record"
                  v={
                    lesson.trigger.sourceRef ? (
                      <span className="text-xs">
                        <Badge tone="gray">{label(lesson.trigger.sourceRef.tool ?? "")}</Badge>{" "}
                        {lesson.trigger.sourceRef.label || lesson.trigger.sourceRef.recordId}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
                <KV
                  k="Obligation"
                  v={
                    lesson.trigger.obligationId ? (
                      <span className="font-mono text-xs">{lesson.trigger.obligationId}</span>
                    ) : (
                      "none raised"
                    )
                  }
                />
              </div>
            )}
          </CardBody>
        </Card>

        {/* -------------------------------- impact -------------------------------- */}
        <Card>
          <CardBody>
            <SectionTitle hint="Did this lesson ever change anything, anywhere else?">Impact</SectionTitle>
            {impactError ? (
              <LoadError message={impactError} onRetry={() => void loadImpact()} />
            ) : impact === null ? (
              <Spinner label="Loading impact…" />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <div className="text-xl font-bold tabular-nums text-ink-900">
                      {fmtInt(impact.applicationCount)}
                    </div>
                    <div className="text-xs uppercase tracking-wide text-ink-400">Applications</div>
                  </div>
                  <div>
                    <div
                      className={`text-xl font-bold tabular-nums ${
                        impact.crossProjectApplicationCount > 0 ? "text-emerald-700" : "text-red-700"
                      }`}
                    >
                      {fmtInt(impact.crossProjectApplicationCount)}
                    </div>
                    <div className="text-xs uppercase tracking-wide text-ink-400">Cross-project</div>
                  </div>
                  <div>
                    <div className="text-xl font-bold tabular-nums text-ink-900">
                      {fmtInt(impact.projectsReached)}
                    </div>
                    <div className="text-xs uppercase tracking-wide text-ink-400">Projects reached</div>
                  </div>
                  <div>
                    <div className="text-xl font-bold tabular-nums text-ink-900">
                      {fmtInt(impact.outcomesRecorded)}
                    </div>
                    <div className="text-xs uppercase tracking-wide text-ink-400">Outcomes recorded</div>
                  </div>
                </div>

                <div
                  className={`rounded-md px-3 py-2 text-sm font-medium ring-1 ${
                    impact.crossedProjectBoundary
                      ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
                      : "bg-red-50 text-red-900 ring-red-200"
                  }`}
                >
                  {impact.crossedProjectBoundary
                    ? "This lesson crossed a project boundary."
                    : "This lesson has not crossed a project boundary."}
                </div>

                <NoteCard note={impact.note} tone="ink" />

                {impact.projects.length > 0 ? (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Project</Th>
                        <Th>Applications</Th>
                        <Th>First</Th>
                        <Th>Last</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {impact.projects.map((p) => (
                        <tr key={p.projectId}>
                          <Td>
                            {p.projectName ?? projectNameOf(projects, p.projectId)}{" "}
                            {p.isOriginProject ? <Badge tone="gray">origin</Badge> : <Badge tone="green">crossed</Badge>}
                          </Td>
                          <Td className="tabular-nums">{fmtInt(p.applications)}</Td>
                          <Td className="whitespace-nowrap text-xs">{formatDate(p.firstAppliedAt)}</Td>
                          <Td className="whitespace-nowrap text-xs">{formatDate(p.lastAppliedAt)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : null}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ----------------------------- applications ---------------------------- */}
        <Card>
          <CardBody>
            <SectionTitle>Applications</SectionTitle>
            {lesson.applications.length === 0 ? (
              <p className="text-sm text-ink-500">
                None recorded.{" "}
                {lesson.status === "published"
                  ? "Nobody has yet said this lesson changed what they did."
                  : "Only published lessons can be applied."}
              </p>
            ) : (
              <ul className="space-y-3">
                {lesson.applications.map((a) => (
                  <li key={a.id} className="rounded-md bg-ink-50 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                      <span>{formatDateTime(a.appliedAt)}</span>
                      <span>·</span>
                      <span>{projectNameOf(projects, a.projectId)}</span>
                      {a.projectId !== lesson.originProjectId ? (
                        <Badge tone="green">crossed a project</Badge>
                      ) : (
                        <Badge tone="gray">origin project</Badge>
                      )}
                    </div>
                    {a.appliedTo ? (
                      <div className="mt-1 text-xs text-ink-600">
                        <Badge tone="gray">{label(a.appliedTo.tool ?? "")}</Badge>{" "}
                        {a.appliedTo.label || a.appliedTo.recordId}
                      </div>
                    ) : null}
                    <p className="mt-1 whitespace-pre-wrap text-sm text-ink-800">{a.action}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <Badge
                        tone={
                          a.outcome === "avoided"
                            ? "green"
                            : a.outcome === "partially_avoided"
                              ? "amber"
                              : a.outcome === "counterproductive"
                                ? "red"
                                : "gray"
                        }
                      >
                        {LESSON_OUTCOME_LABELS[a.outcome ?? "unknown"] ?? "Not yet measured"}
                      </Badge>
                      {a.outcomeValue !== null ? (
                        <span className="text-xs tabular-nums text-ink-600">
                          {a.outcomeCurrency ?? ""} {a.outcomeValue}
                        </span>
                      ) : null}
                      {a.outcomeDays !== null ? (
                        <span className="text-xs tabular-nums text-ink-600">
                          {a.outcomeDays} day(s)
                        </span>
                      ) : null}
                      {a.measuredAt ? (
                        <span className="text-xs text-ink-400">
                          measured {formatDateTime(a.measuredAt)}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setMeasuring(a)}
                        className="rounded bg-white px-2 py-0.5 text-xs font-medium text-ink-700 ring-1 ring-ink-200 hover:bg-ink-50"
                      >
                        {a.outcome && a.outcome !== "unknown" ? "Revise" : "Record"} the outcome
                      </button>
                    </div>
                    {a.outcomeNote ? (
                      <p className="mt-1 whitespace-pre-wrap text-xs text-ink-600">
                        <span className="font-medium">Observed:</span> {a.outcomeNote}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs italic text-ink-400">
                        No outcome has been measured, so this application counts towards the
                        register's reach and towards nothing else. An application nobody measured
                        is not evidence that the lesson worked.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    );
  })();

  return (
    <>
      <Drawer
        open
        wide
        onClose={onClose}
        title={
          lesson ? (
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs text-ink-500">{lesson.number}</span>
              <span>{lesson.title}</span>
            </span>
          ) : (
            "Lesson"
          )
        }
      >
        {body}
      </Drawer>

      {measuring ? (
        <OutcomeForm
          application={measuring}
          onClose={() => setMeasuring(null)}
          onSaved={() => {
            setMeasuring(null);
            void load();
            void loadImpact();
            onChanged();
          }}
        />
      ) : null}

      {lesson ? (
        <ApplyModal
          open={applyOpen}
          lessonId={lesson.id}
          lessonNumber={lesson.number}
          lessonTitle={lesson.title}
          originProjectId={lesson.originProjectId}
          projects={projects}
          onClose={() => setApplyOpen(false)}
          onApplied={onApplied}
        />
      ) : null}

      <Modal
        open={supersedeOpen}
        title="Supersede this lesson"
        onClose={() => setSupersedeOpen(false)}
      >
        <p className="mb-3 text-sm text-ink-600">
          The replacement must itself be published. This lesson becomes <em>superseded</em>: it stays in
          the register, and stops being retrieved as current practice.
        </p>
        <ErrorAlert message={actionError} />
        <Field label="Superseded by">
          <Select
            value={replacementId}
            onChange={(e) => setReplacementId(e.target.value)}
            disabled={candidates === null}
          >
            <option value="">
              {candidates === null ? "Loading published lessons…" : "Select a published lesson…"}
            </option>
            {(candidates ?? [])
              .filter((c) => c.id !== lessonId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.number} — {c.title}
                </option>
              ))}
          </Select>
        </Field>
        {candidates !== null && candidates.filter((c) => c.id !== lessonId).length === 0 ? (
          <p className="mt-2 text-xs text-ink-500">
            There is no other published lesson to supersede this one with.
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setSupersedeOpen(false)} disabled={superseding}>
            Cancel
          </Button>
          <Button onClick={() => void supersede()} disabled={!replacementId || superseding}>
            {superseding ? "Superseding…" : "Supersede"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
