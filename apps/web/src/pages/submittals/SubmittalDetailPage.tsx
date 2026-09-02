/**
 * One submittal — the review chain (sequential positions, parallel groups),
 * the revision chain, distribution, and the actions the API says THIS user
 * may take (`permissions.canRespondStepIds`, `canResubmit`). A stranded
 * chain (every step answered, record still in review) is called out with a
 * one-click repair rather than left for someone to discover.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, ErrorAlert, Field, Input, Modal, Select, Spinner, Textarea, statusTone } from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import { DASH, daysLabel, errorMessage, riskTone, submittalLabel, useCompanyUsers, useFieldResource } from "../rfis/fieldShared";

interface ReviewStep {
  id: string;
  submittalId: string;
  position: number;
  reviewerId: string;
  isParallel: number;
  responseCode: string | null;
  comments: string | null;
  respondedAt: string | null;
  activatedAt: string | null;
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
  reviewAllowanceDays: number | null;
  submitByDate: string | null;
  responseCode: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  submittedAt: string | null;
  closedAt: string | null;
  previousId: string | null;
  supersededById: string | null;
  distribution: string[];
  fileIds: string[];
  isCloseout: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  risk: string;
  label: string;
  daysToSubmitBy: number | null;
  daysInCourt: number | null;
  reviewSteps: ReviewStep[];
  revisions: Revision[];
  stranded: boolean;
  currentPosition: number | null;
  permissions: { isAdmin: boolean; canRespondStepIds: string[]; canResubmit: boolean };
}

interface ResponseCode {
  code: string;
  label: string;
  isApproval: boolean;
  isResubmit: boolean;
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
  const codes = useFieldResource<{ items: ResponseCode[]; custom: boolean }>("/api/v1/submittal-response-codes");

  const [sub, setSub] = useState<Submittal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [stepsOpen, setStepsOpen] = useState(false);
  const [stepDrafts, setStepDrafts] = useState<StepDraft[]>([]);
  const [stepsError, setStepsError] = useState<string | null>(null);

  const [respondStep, setRespondStep] = useState<ReviewStep | null>(null);
  const [respondCode, setRespondCode] = useState("");
  const [respondComments, setRespondComments] = useState("");
  const [respondError, setRespondError] = useState<string | null>(null);

  const [resubmitOpen, setResubmitOpen] = useState(false);
  const [copyFiles, setCopyFiles] = useState(true);
  const [copyChain, setCopyChain] = useState(true);

  const [editOpen, setEditOpen] = useState(false);
  const [edit, setEdit] = useState({ requiredOnSite: "", leadTimeDays: "", ballInCourtId: "", distribution: [] as string[] });
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSub(await api.get<Submittal>(base));
    } catch (err) {
      setError(errorMessage(err, "Failed to load the submittal"));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function doAction(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<Submittal>(`${base}/${path}`, body);
      if (path === "resubmit") {
        navigate(`/projects/${projectId}/submittals/${res.id}`);
        return;
      }
      await load();
    } catch (err) {
      setError(errorMessage(err, "Action failed"));
    } finally {
      setBusy(false);
    }
  }

  function openStepsModal() {
    if (!sub) return;
    const pending = sub.reviewSteps.filter((s) => !s.responseCode);
    setStepDrafts(pending.length > 0 ? pending.map((s) => ({ reviewerId: s.reviewerId, position: String(s.position), isParallel: s.isParallel === 1 })) : [{ reviewerId: "", position: "0", isParallel: false }]);
    setStepsError(null);
    setStepsOpen(true);
  }

  async function onSaveSteps(e: FormEvent) {
    e.preventDefault();
    setStepsError(null);
    const steps = stepDrafts.filter((d) => d.reviewerId).map((d) => ({ reviewerId: d.reviewerId, position: Math.max(0, Number(d.position) || 0), isParallel: d.isParallel }));
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
      setStepsError(errorMessage(err, "Failed to save review chain"));
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
      await api.post(`${base}/steps/${respondStep.id}/respond`, payload);
      setRespondStep(null);
      setRespondComments("");
      await load();
    } catch (err) {
      setRespondError(errorMessage(err, "Failed to record response"));
    } finally {
      setBusy(false);
    }
  }

  function openEdit() {
    if (!sub) return;
    setEdit({ requiredOnSite: sub.requiredOnSite ?? "", leadTimeDays: sub.leadTimeDays === null ? "" : String(sub.leadTimeDays), ballInCourtId: sub.ballInCourtId ?? "", distribution: sub.distribution });
    setEditError(null);
    setEditOpen(true);
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setEditError(null);
    try {
      await api.patch(base, { requiredOnSite: edit.requiredOnSite || null, leadTimeDays: edit.leadTimeDays === "" ? null : Number(edit.leadTimeDays), ballInCourtId: edit.ballInCourtId || null, distribution: edit.distribution });
      setEditOpen(false);
      await load();
    } catch (err) {
      setEditError(errorMessage(err, "Failed to save"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!sub) {
    return (
      <div>
        <ErrorAlert message={error ?? "Submittal not found"} />
        <Link to={`/projects/${projectId}/submittals`} className="text-sm text-brand-700 hover:underline">← Back to submittals</Link>
      </div>
    );
  }

  const pendingSteps = sub.reviewSteps.filter((s) => !s.responseCode);
  const codeList = codes.data?.items ?? [];
  const editable = sub.status !== "closed" && sub.status !== "void" && sub.status !== "superseded";

  return (
    <div>
      <div className="mb-1">
        <Link to={`/projects/${projectId}/submittals`} className="text-xs font-medium text-brand-700 hover:text-brand-800">← Back to submittals</Link>
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-ink-400">SUB-{submittalLabel(sub.number, sub.revision)}</span>
            <Badge tone={statusTone(sub.status)}>{humanize(sub.status)}</Badge>
            {sub.responseCode ? <Badge tone={statusTone(sub.responseCode)}>{humanize(sub.responseCode)}</Badge> : null}
            {sub.risk !== "none" ? <Badge tone={riskTone(sub.risk)}>{humanize(sub.risk)}</Badge> : null}
            {sub.isCloseout === 1 ? <Badge tone="violet">Closeout</Badge> : null}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-ink-900">{sub.title}</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {sub.specSection ? `Spec ${sub.specSection} · ` : ""}{humanize(sub.submittalType)} · ball in court: {nameOf(sub.ballInCourtId)}
            {sub.daysInCourt !== null ? ` (${daysLabel(sub.daysInCourt)} in court)` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sub.status === "draft" || sub.status === "open" ? <Button disabled={busy} onClick={() => void doAction("submit")}>Submit for review</Button> : null}
          {sub.permissions.canResubmit ? <Button disabled={busy} onClick={() => setResubmitOpen(true)}>Resubmit (new revision)</Button> : null}
          {editable ? <Button variant="secondary" disabled={busy} onClick={openEdit}>Edit</Button> : null}
          {sub.status === "open" || sub.status === "responded" ? <Button variant="secondary" disabled={busy} onClick={() => void doAction("close")}>Close</Button> : null}
        </div>
      </div>

      <ErrorAlert message={error} />
      {sub.stranded ? (
        <Alert tone="danger" title="This review chain is stranded" className="mb-4" actions={<Button size="sm" disabled={busy} onClick={() => void doAction("recompute")}>Recompute</Button>}>
          Every step has responded but the record is still in review. Recompute finalises it from the recorded codes.
        </Alert>
      ) : null}
      {sub.supersededById ? (
        <Alert tone="info" className="mb-4">
          This revision has been superseded. <Link to={`/projects/${projectId}/submittals/${sub.supersededById}`} className="font-medium underline">Open the current revision</Link>.
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardBody>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Review chain</h2>
                {editable && sub.status !== "responded" ? (
                  <Button size="sm" variant="secondary" onClick={openStepsModal}>{pendingSteps.length > 0 ? "Edit pending steps" : "Set up review chain"}</Button>
                ) : null}
              </div>
              {sub.reviewSteps.length === 0 ? (
                <p className="text-sm text-ink-400">No reviewers routed yet. Set up the review chain before submitting; with no chain, submit simply opens the record.</p>
              ) : (
                <ol className="space-y-2">
                  {sub.reviewSteps.map((step) => {
                    const isCurrent = sub.status === "in_review" && !step.responseCode && step.position === sub.currentPosition;
                    const canRespond = sub.permissions.canRespondStepIds.includes(step.id);
                    return (
                      <li key={step.id} className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 ${isCurrent ? "border-brand-300 bg-brand-50/60" : "border-ink-100"}`}>
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">{step.position}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-ink-800">{nameOf(step.reviewerId)}</span>
                            {step.isParallel === 1 ? <Badge tone="violet" size="xs">Parallel</Badge> : null}
                            {step.responseCode ? <Badge tone={statusTone(step.responseCode)}>{humanize(step.responseCode)}</Badge> : <Badge tone={isCurrent ? "blue" : "gray"}>{isCurrent ? "Awaiting response" : "Pending"}</Badge>}
                          </div>
                          {step.comments ? <p className="mt-0.5 text-xs text-ink-500">{step.comments}</p> : null}
                          <p className="mt-0.5 text-xs text-ink-400">
                            {step.activatedAt ? `Activated ${formatDateTime(step.activatedAt)}` : ""}
                            {step.respondedAt ? ` · responded ${formatDateTime(step.respondedAt)}` : ""}
                          </p>
                        </div>
                        {isCurrent && canRespond ? (
                          <Button size="sm" onClick={() => { setRespondStep(step); setRespondCode(codeList[0]?.code ?? ""); setRespondComments(""); setRespondError(null); }}>Respond</Button>
                        ) : isCurrent ? (
                          <span className="text-xs text-ink-400">Waiting on {nameOf(step.reviewerId)}</span>
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
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-500">Revision chain</h2>
              {sub.revisions.length <= 1 ? <p className="text-sm text-ink-400">No other revisions.</p> : (
                <ol className="flex flex-wrap items-center gap-2">
                  {sub.revisions.map((rev, i) => (
                    <li key={rev.id} className="flex items-center gap-2">
                      {i > 0 ? <span className="text-ink-300">→</span> : null}
                      {rev.id === sub.id ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-brand-50 px-2.5 py-1.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-200">Rev {rev.revision} (this) <Badge tone={statusTone(rev.status)}>{humanize(rev.status)}</Badge></span>
                      ) : (
                        <Link to={`/projects/${projectId}/submittals/${rev.id}`} className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-brand-700 ring-1 ring-ink-200 hover:bg-ink-50">Rev {rev.revision} <Badge tone={statusTone(rev.status)}>{humanize(rev.status)}</Badge></Link>
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
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-500">Dates & scheduling</h2>
              <dl className="space-y-2.5 text-sm">
                <Row label="Required on site" value={formatDate(sub.requiredOnSite)} />
                <Row label="Lead time" value={sub.leadTimeDays !== null ? `${sub.leadTimeDays} days` : DASH} />
                <Row label="Review allowance" value={sub.reviewAllowanceDays !== null ? `${sub.reviewAllowanceDays} days` : DASH} />
                <Row label="Submit by" value={<span className={sub.risk === "late" ? "font-medium text-red-600" : sub.risk === "at_risk" ? "font-medium text-amber-600" : ""}>{formatDate(sub.submitByDate)}{sub.daysToSubmitBy !== null ? ` (${sub.daysToSubmitBy < 0 ? `${-sub.daysToSubmitBy}d ago` : `in ${sub.daysToSubmitBy}d`})` : ""}</span>} />
                <Row label="Submitted" value={formatDateTime(sub.submittedAt)} />
                <Row label="Responded" value={formatDateTime(sub.respondedAt)} />
                <Row label="Responded by" value={nameOf(sub.respondedBy)} />
                <Row label="Closed" value={formatDateTime(sub.closedAt)} />
                <Row label="Created by" value={nameOf(sub.createdBy)} />
                <Row label="Created" value={formatDateTime(sub.createdAt)} />
              </dl>
              <p className="mt-3 text-xs text-ink-400">Submit-by = required-on-site − lead time − review allowance. It is blank when there is no site date; nothing is invented.</p>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Distribution</h2>
              {sub.distribution.length === 0 ? <p className="text-sm text-ink-400">Nobody is notified on the final response.</p> : (
                <ul className="space-y-1 text-sm text-ink-800">{sub.distribution.map((id) => <li key={id}>{nameOf(id)}</li>)}</ul>
              )}
              {sub.fileIds.length > 0 ? <p className="mt-2 text-xs text-ink-400">{sub.fileIds.length} attached file{sub.fileIds.length === 1 ? "" : "s"}</p> : null}
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal open={stepsOpen} title="Review chain" onClose={() => setStepsOpen(false)} wide>
        <ErrorAlert message={stepsError} />
        <form onSubmit={onSaveSteps} className="space-y-4">
          <p className="text-xs text-ink-500">Steps run in position order; steps that share a position run in parallel. Responded steps are kept as history — only pending steps are replaced. Replacing the chain mid-review re-points ball-in-court and notifies the new reviewers.</p>
          <div className="space-y-2">
            {stepDrafts.map((d, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <div className="w-20"><Input type="number" min="0" value={d.position} onChange={(e) => setStepDrafts((rows) => rows.map((r, j) => (j === i ? { ...r, position: e.target.value } : r)))} /></div>
                <div className="min-w-48 flex-1">
                  <Select value={d.reviewerId} onChange={(e) => setStepDrafts((rows) => rows.map((r, j) => (j === i ? { ...r, reviewerId: e.target.value } : r)))}>
                    <option value="">Select reviewer…</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-ink-600"><input type="checkbox" checked={d.isParallel} onChange={(e) => setStepDrafts((rows) => rows.map((r, j) => (j === i ? { ...r, isParallel: e.target.checked } : r)))} /> Parallel</label>
                <Button variant="ghost" size="sm" onClick={() => setStepDrafts((rows) => rows.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setStepDrafts((rows) => [...rows, { reviewerId: "", position: String(rows.length > 0 ? (Number(rows[rows.length - 1]!.position) || 0) + 1 : 0), isParallel: false }])}>+ Add step</Button>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStepsOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save review chain"}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={respondStep !== null} title={`Respond as ${nameOf(respondStep?.reviewerId)}`} onClose={() => setRespondStep(null)}>
        <ErrorAlert message={respondError} />
        <form onSubmit={onRespond} className="space-y-4">
          <Field label="Response code" hint={codes.data?.custom ? "This company uses a custom response-code set." : "A resubmit code ends the review; approvals advance it."}>
            <Select value={respondCode} onChange={(e) => setRespondCode(e.target.value)}>
              {codeList.map((c) => <option key={c.code} value={c.code}>{c.label}{c.isResubmit ? " (resubmit)" : c.isApproval ? " (approval)" : ""}</option>)}
            </Select>
          </Field>
          <Field label="Comments" hint="An approval with no comments anywhere in the chain inside a business day is flagged for integrity review.">
            <Textarea value={respondComments} onChange={(e) => setRespondComments(e.target.value)} placeholder="Review comments…" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRespondStep(null)}>Cancel</Button>
            <Button type="submit" disabled={busy || !respondCode}>{busy ? "Saving…" : "Record response"}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={resubmitOpen} title="Resubmit as a new revision" onClose={() => setResubmitOpen(false)}>
        <div className="space-y-3 text-sm">
          <p className="text-ink-600">Creates Rev {sub.revision + 1} in draft and marks this revision superseded. This can only happen once per revision.</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={copyFiles} onChange={(e) => setCopyFiles(e.target.checked)} /> Carry the attached files forward</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={copyChain} onChange={(e) => setCopyChain(e.target.checked)} /> Copy the review chain as the new revision's routing</label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setResubmitOpen(false)}>Cancel</Button>
            <Button disabled={busy} onClick={() => { setResubmitOpen(false); void doAction("resubmit", { copyFiles, copyReviewChain: copyChain }); }}>Create revision</Button>
          </div>
        </div>
      </Modal>

      <Modal open={editOpen} title="Edit submittal" onClose={() => setEditOpen(false)} wide>
        <ErrorAlert message={editError} />
        <form onSubmit={onSaveEdit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Required on site"><Input type="date" value={edit.requiredOnSite} onChange={(e) => setEdit((d) => ({ ...d, requiredOnSite: e.target.value }))} /></Field>
            <Field label="Lead time (days)" hint="Changing either date re-computes submit-by."><Input type="number" min="0" value={edit.leadTimeDays} onChange={(e) => setEdit((d) => ({ ...d, leadTimeDays: e.target.value }))} /></Field>
            <Field label="Ball in court">
              <Select value={edit.ballInCourtId} onChange={(e) => setEdit((d) => ({ ...d, ballInCourtId: e.target.value }))}>
                <option value="">Nobody</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Field label="Distribution">
              <select multiple className="h-28 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm" value={edit.distribution} onChange={(e) => setEdit((d) => ({ ...d, distribution: Array.from(e.target.selectedOptions).map((o) => o.value) }))}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
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
