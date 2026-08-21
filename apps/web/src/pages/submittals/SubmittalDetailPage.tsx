import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SUBMITTAL_RESPONSES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  statusTone,
} from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import { submittalLabel, useCompanyUsers } from "../rfis/fieldShared";

interface ReviewStep {
  id: string;
  submittalId: string;
  position: number;
  reviewerId: string;
  isParallel: number;
  responseCode: string | null;
  comments: string | null;
  respondedAt: string | null;
}

interface Revision {
  id: string;
  revision: number;
  status: string;
  responseCode: string | null;
  createdAt: string;
}

interface Submittal {
  id: string;
  number: number;
  revision: number;
  title: string;
  specSection: string | null;
  submittalType: string;
  status: string;
  ballInCourtId: string | null;
  requiredOnSite: string | null;
  leadTimeDays: number | null;
  submitByDate: string | null;
  responseCode: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  previousId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  reviewSteps: ReviewStep[];
  revisions: Revision[];
}

interface StepDraft {
  reviewerId: string;
  position: string;
  isParallel: boolean;
}

export default function SubmittalDetailPage() {
  const { projectId, submittalId } = useParams<{ projectId: string; submittalId: string }>();
  const navigate = useNavigate();
  const base = `/api/v1/projects/${projectId}/submittals/${submittalId}`;
  const { users, nameOf } = useCompanyUsers();

  const [sub, setSub] = useState<Submittal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [stepsOpen, setStepsOpen] = useState(false);
  const [stepDrafts, setStepDrafts] = useState<StepDraft[]>([]);
  const [stepsError, setStepsError] = useState<string | null>(null);

  const [respondStep, setRespondStep] = useState<ReviewStep | null>(null);
  const [respondCode, setRespondCode] = useState<string>("approved");
  const [respondComments, setRespondComments] = useState("");
  const [respondError, setRespondError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<Submittal>(base);
      setSub(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the submittal");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function doAction(path: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<Submittal>(`${base}/${path}`);
      if (path === "resubmit") {
        navigate(`/projects/${projectId}/submittals/${res.id}`);
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function openStepsModal() {
    if (!sub) return;
    const pending = sub.reviewSteps.filter((s) => !s.responseCode);
    setStepDrafts(
      pending.length > 0
        ? pending.map((s) => ({
            reviewerId: s.reviewerId,
            position: String(s.position),
            isParallel: s.isParallel === 1,
          }))
        : [{ reviewerId: "", position: "1", isParallel: false }],
    );
    setStepsError(null);
    setStepsOpen(true);
  }

  async function onSaveSteps(e: FormEvent) {
    e.preventDefault();
    setStepsError(null);
    const steps = stepDrafts
      .filter((d) => d.reviewerId)
      .map((d) => ({
        reviewerId: d.reviewerId,
        position: Math.max(0, Number(d.position) || 0),
        isParallel: d.isParallel,
      }));
    if (steps.length === 0) {
      setStepsError("Add at least one reviewer.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`${base}/review-steps`, { steps });
      setStepsOpen(false);
      await load();
    } catch (err) {
      setStepsError(err instanceof ApiClientError ? err.message : "Failed to save review chain");
    } finally {
      setBusy(false);
    }
  }

  async function onRespond(e: FormEvent) {
    e.preventDefault();
    if (!respondStep) return;
    setRespondError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { responseCode: respondCode };
      if (respondComments.trim()) payload["comments"] = respondComments.trim();
      await api.post(`/api/v1/submittal-steps/${respondStep.id}/respond`, payload);
      setRespondStep(null);
      setRespondComments("");
      await load();
    } catch (err) {
      setRespondError(err instanceof ApiClientError ? err.message : "Failed to record response");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!sub) {
    return (
      <div>
        <ErrorAlert message={error ?? "Submittal not found"} />
        <Link
          to={`/projects/${projectId}/submittals`}
          className="text-sm text-brand-700 hover:underline"
        >
          ← Back to submittals
        </Link>
      </div>
    );
  }

  const pendingSteps = sub.reviewSteps.filter((s) => !s.responseCode);
  const currentPosition = pendingSteps.length > 0 ? pendingSteps[0]!.position : null;
  const canResubmit =
    sub.status === "responded" &&
    (sub.responseCode === "revise_and_resubmit" || sub.responseCode === "rejected");

  return (
    <div>
      <div className="mb-1">
        <Link
          to={`/projects/${projectId}/submittals`}
          className="text-xs font-medium text-brand-700 hover:text-brand-800"
        >
          ← Back to submittals
        </Link>
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-ink-400">
              SUB-{submittalLabel(sub.number, sub.revision)}
            </span>
            <Badge tone={statusTone(sub.status)}>{humanize(sub.status)}</Badge>
            {sub.responseCode ? (
              <Badge tone={statusTone(sub.responseCode)}>{humanize(sub.responseCode)}</Badge>
            ) : null}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-ink-900">{sub.title}</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {sub.specSection ? `Spec ${sub.specSection} · ` : ""}
            {humanize(sub.submittalType)} · ball in court: {nameOf(sub.ballInCourtId)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sub.status === "draft" || sub.status === "open" ? (
            <Button disabled={busy} onClick={() => void doAction("submit")}>
              Submit for review
            </Button>
          ) : null}
          {canResubmit ? (
            <Button disabled={busy} onClick={() => void doAction("resubmit")}>
              Resubmit (new revision)
            </Button>
          ) : null}
          {sub.status === "open" || sub.status === "responded" ? (
            <Button variant="secondary" disabled={busy} onClick={() => void doAction("close")}>
              Close
            </Button>
          ) : null}
        </div>
      </div>

      <ErrorAlert message={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardBody>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Review chain
                </h2>
                {sub.status !== "closed" && sub.status !== "void" ? (
                  <Button size="sm" variant="secondary" onClick={openStepsModal}>
                    {pendingSteps.length > 0 ? "Edit pending steps" : "Set up review chain"}
                  </Button>
                ) : null}
              </div>
              {sub.reviewSteps.length === 0 ? (
                <p className="text-sm text-ink-400">
                  No reviewers routed yet. Set up the review chain before submitting.
                </p>
              ) : (
                <ol className="space-y-2">
                  {sub.reviewSteps.map((step) => {
                    const isCurrent =
                      sub.status === "in_review" &&
                      !step.responseCode &&
                      step.position === currentPosition;
                    return (
                      <li
                        key={step.id}
                        className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 ${
                          isCurrent ? "border-brand-300 bg-brand-50/60" : "border-ink-100"
                        }`}
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">
                          {step.position}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-ink-800">
                              {nameOf(step.reviewerId)}
                            </span>
                            {step.isParallel === 1 ? <Badge tone="violet">Parallel</Badge> : null}
                            {step.responseCode ? (
                              <Badge tone={statusTone(step.responseCode)}>
                                {humanize(step.responseCode)}
                              </Badge>
                            ) : (
                              <Badge tone={isCurrent ? "blue" : "gray"}>
                                {isCurrent ? "Awaiting response" : "Pending"}
                              </Badge>
                            )}
                          </div>
                          {step.comments ? (
                            <p className="mt-0.5 text-xs text-ink-500">{step.comments}</p>
                          ) : null}
                          {step.respondedAt ? (
                            <p className="mt-0.5 text-xs text-ink-400">
                              Responded {formatDateTime(step.respondedAt)}
                            </p>
                          ) : null}
                        </div>
                        {isCurrent ? (
                          <Button
                            size="sm"
                            onClick={() => {
                              setRespondStep(step);
                              setRespondCode("approved");
                              setRespondComments("");
                              setRespondError(null);
                            }}
                          >
                            Respond
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Revision chain
              </h2>
              {sub.revisions.length <= 1 ? (
                <p className="text-sm text-ink-400">No other revisions.</p>
              ) : (
                <ol className="flex flex-wrap items-center gap-2">
                  {sub.revisions.map((rev, i) => (
                    <li key={rev.id} className="flex items-center gap-2">
                      {i > 0 ? <span className="text-ink-300">→</span> : null}
                      {rev.id === sub.id ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-brand-50 px-2.5 py-1.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-200">
                          Rev {rev.revision} (this)
                          <Badge tone={statusTone(rev.status)}>{humanize(rev.status)}</Badge>
                        </span>
                      ) : (
                        <Link
                          to={`/projects/${projectId}/submittals/${rev.id}`}
                          className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-brand-700 ring-1 ring-ink-200 hover:bg-ink-50"
                        >
                          Rev {rev.revision}
                          <Badge tone={statusTone(rev.status)}>{humanize(rev.status)}</Badge>
                        </Link>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardBody>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Dates & scheduling
              </h2>
              <dl className="space-y-2.5 text-sm">
                <Row label="Required on site" value={formatDate(sub.requiredOnSite)} />
                <Row
                  label="Lead time"
                  value={sub.leadTimeDays !== null ? `${sub.leadTimeDays} days` : "—"}
                />
                <Row label="Submit by" value={formatDate(sub.submitByDate)} />
                <Row label="Responded" value={formatDateTime(sub.respondedAt)} />
                <Row label="Responded by" value={nameOf(sub.respondedBy)} />
                <Row label="Created by" value={nameOf(sub.createdBy)} />
                <Row label="Created" value={formatDateTime(sub.createdAt)} />
                <Row label="Updated" value={formatDateTime(sub.updatedAt)} />
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal open={stepsOpen} title="Review chain" onClose={() => setStepsOpen(false)} wide>
        <ErrorAlert message={stepsError} />
        <form onSubmit={onSaveSteps} className="space-y-4">
          <p className="text-xs text-ink-500">
            Steps run in position order; steps that share a position run in parallel. Responded
            steps are kept as history — only pending steps are replaced.
          </p>
          <div className="space-y-2">
            {stepDrafts.map((d, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <div className="w-20">
                  <Input
                    type="number"
                    min="0"
                    value={d.position}
                    onChange={(e) =>
                      setStepDrafts((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, position: e.target.value } : r)),
                      )
                    }
                  />
                </div>
                <div className="min-w-48 flex-1">
                  <Select
                    value={d.reviewerId}
                    onChange={(e) =>
                      setStepDrafts((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, reviewerId: e.target.value } : r)),
                      )
                    }
                  >
                    <option value="">Select reviewer…</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-ink-600">
                  <input
                    type="checkbox"
                    checked={d.isParallel}
                    onChange={(e) =>
                      setStepDrafts((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, isParallel: e.target.checked } : r)),
                      )
                    }
                  />
                  Parallel
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStepDrafts((rows) => rows.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setStepDrafts((rows) => [
                ...rows,
                {
                  reviewerId: "",
                  position: String(
                    rows.length > 0 ? (Number(rows[rows.length - 1]!.position) || 0) + 1 : 1,
                  ),
                  isParallel: false,
                },
              ])
            }
          >
            + Add step
          </Button>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStepsOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save review chain"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={respondStep !== null}
        title={`Respond as ${nameOf(respondStep?.reviewerId)}`}
        onClose={() => setRespondStep(null)}
      >
        <ErrorAlert message={respondError} />
        <form onSubmit={onRespond} className="space-y-4">
          <Field label="Response code">
            <Select value={respondCode} onChange={(e) => setRespondCode(e.target.value)}>
              {SUBMITTAL_RESPONSES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Comments">
            <Textarea
              value={respondComments}
              onChange={(e) => setRespondComments(e.target.value)}
              placeholder="Optional review comments…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRespondStep(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Record response"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-ink-400">{label}</dt>
      <dd className="text-right text-ink-800">{value}</dd>
    </div>
  );
}
