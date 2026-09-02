/**
 * One RFI — the question, the draft responses queue and the official
 * answer (#311 response approval), references to prior RFIs (#316), and
 * the actions the API says THIS user may take (`permissions`). The
 * question is shown as locked once issued: an answered question that
 * changed underneath its answer is exactly the record this platform exists
 * to prevent.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, ErrorAlert, Field, Input, Modal, Select, Spinner, Textarea, statusTone } from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import { DASH, daysLabel, errorMessage, impactTone, rfiLabel, useCompanyUsers, useMe } from "./fieldShared";

interface DraftResponse {
  id: string;
  body: string;
  costImpact: string | null;
  scheduleImpact: string | null;
  scheduleImpactDays: number | null;
  status: string;
  authorId: string;
  adoptedBy: string | null;
  adoptedAt: string | null;
  createdAt: string;
}

interface Rfi {
  id: string;
  number: number;
  subject: string;
  question: string;
  proposedSolution: string | null;
  status: string;
  assigneeId: string | null;
  ballInCourtId: string | null;
  distribution: string[];
  dueDate: string | null;
  officialResponse: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  costImpact: string;
  scheduleImpact: string;
  scheduleImpactDays: number | null;
  issuedAt: string | null;
  isPrivate: number;
  source: string;
  sourceMeta: Record<string, unknown> | null;
  relatedRfiIds: string[];
  fileIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  responses: DraftResponse[];
  related: Array<{ id: string; number: number; subject: string; status: string }>;
  daysOverdue: number;
  ageDays: number;
  permissions: { canRespond: boolean; canAdopt: boolean; canVoid: boolean; canEditQuestion: boolean };
}

interface ResponseForm {
  body: string;
  costImpact: string;
  scheduleImpact: string;
  scheduleImpactDays: string;
}
const emptyResponse: ResponseForm = { body: "", costImpact: "tbd", scheduleImpact: "tbd", scheduleImpactDays: "" };

export default function RfiDetailPage() {
  const { projectId, rfiId } = useParams<{ projectId: string; rfiId: string }>();
  const base = `/api/v1/projects/${projectId}/rfis/${rfiId}`;
  const { users, nameOf } = useCompanyUsers();
  const me = useMe();

  const [rfi, setRfi] = useState<Rfi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [respondOpen, setRespondOpen] = useState<"official" | "draft" | null>(null);
  const [form, setForm] = useState<ResponseForm>(emptyResponse);
  const [formError, setFormError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [edit, setEdit] = useState({ assigneeId: "", ballInCourtId: "", dueDate: "", distribution: [] as string[], costImpact: "tbd", scheduleImpact: "tbd" });
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<Rfi>(base);
      setRfi(res);
    } catch (err) {
      setError(errorMessage(err, "Failed to load the RFI"));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doAction(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<Rfi>(`${base}/${path}`, body);
      setRfi(res);
    } catch (err) {
      setError(errorMessage(err, "Action failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitResponse(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const impacts: Record<string, unknown> = { costImpact: form.costImpact, scheduleImpact: form.scheduleImpact };
      if (form.scheduleImpact === "yes" && form.scheduleImpactDays !== "") impacts["scheduleImpactDays"] = Number(form.scheduleImpactDays);
      if (respondOpen === "official") {
        const res = await api.post<Rfi>(`${base}/respond`, { officialResponse: form.body.trim(), ...impacts });
        setRfi(res);
      } else {
        await api.post(`${base}/responses`, { body: form.body.trim(), ...impacts });
        await load();
      }
      setRespondOpen(null);
      setForm(emptyResponse);
    } catch (err) {
      setFormError(errorMessage(err, "Failed to record the response"));
    } finally {
      setBusy(false);
    }
  }

  function openEdit() {
    if (!rfi) return;
    setEdit({ assigneeId: rfi.assigneeId ?? "", ballInCourtId: rfi.ballInCourtId ?? "", dueDate: rfi.dueDate ?? "", distribution: rfi.distribution, costImpact: rfi.costImpact, scheduleImpact: rfi.scheduleImpact });
    setEditError(null);
    setEditOpen(true);
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setEditError(null);
    try {
      const res = await api.patch<Rfi>(base, {
        assigneeId: edit.assigneeId || null,
        ballInCourtId: edit.ballInCourtId || null,
        dueDate: edit.dueDate || null,
        distribution: edit.distribution,
        costImpact: edit.costImpact,
        scheduleImpact: edit.scheduleImpact,
      });
      setRfi(res);
      setEditOpen(false);
      await load();
    } catch (err) {
      setEditError(errorMessage(err, "Failed to save"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!rfi) {
    return (
      <div>
        <ErrorAlert message={error ?? "RFI not found"} />
        <Link to={`/projects/${projectId}/rfis`} className="text-sm text-brand-700 hover:underline">← Back to RFIs</Link>
      </div>
    );
  }

  const drafts = rfi.responses.filter((r) => r.status === "draft");
  const canEditMeta = rfi.status !== "closed" && rfi.status !== "void";

  return (
    <div>
      <div className="mb-1">
        <Link to={`/projects/${projectId}/rfis`} className="text-xs font-medium text-brand-700 hover:text-brand-800">← Back to RFIs</Link>
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-ink-400">{rfiLabel(rfi.number)}</span>
            <Badge tone={statusTone(rfi.status)}>{humanize(rfi.status)}</Badge>
            {rfi.daysOverdue > 0 ? <Badge tone="red">{daysLabel(rfi.daysOverdue)} overdue</Badge> : null}
            {rfi.isPrivate === 1 ? <Badge tone="gray">Private draft</Badge> : null}
            {rfi.source === "email" ? <Badge tone="blue">From email</Badge> : null}
            {rfi.status === "open" ? <span className="text-xs text-ink-400">open {daysLabel(rfi.ageDays)}</span> : null}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-ink-900">{rfi.subject}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rfi.status === "draft" ? <Button disabled={busy} onClick={() => void doAction("issue")}>Issue</Button> : null}
          {rfi.permissions.canRespond ? (
            <Button disabled={busy} onClick={() => { setForm(emptyResponse); setFormError(null); setRespondOpen("official"); }}>Record official response</Button>
          ) : rfi.status === "open" ? (
            <Button variant="secondary" disabled={busy} onClick={() => { setForm(emptyResponse); setFormError(null); setRespondOpen("draft"); }}>Propose a response</Button>
          ) : null}
          {canEditMeta ? <Button variant="secondary" disabled={busy} onClick={openEdit}>Edit</Button> : null}
          {rfi.status === "open" || rfi.status === "answered" ? (
            <Button variant="secondary" disabled={busy} onClick={() => void doAction("close")}>Close</Button>
          ) : null}
          {rfi.permissions.canVoid ? (
            <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm("Void this RFI? This cannot be undone.")) void doAction("void"); }}>Void</Button>
          ) : null}
        </div>
      </div>

      <ErrorAlert message={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardBody>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Question</h2>
                {!rfi.permissions.canEditQuestion ? <span className="text-xs text-ink-400">Locked since issue — void and reissue to change the question</span> : null}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{rfi.question}</p>
            </CardBody>
          </Card>

          {rfi.proposedSolution ? (
            <Card>
              <CardBody>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Proposed solution</h2>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{rfi.proposedSolution}</p>
              </CardBody>
            </Card>
          ) : null}

          <Card className={rfi.officialResponse ? "ring-emerald-200" : ""}>
            <CardBody>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Official response</h2>
                {rfi.respondedAt ? <span className="text-xs text-ink-400">{nameOf(rfi.respondedBy)} · {formatDateTime(rfi.respondedAt)}</span> : null}
              </div>
              {rfi.officialResponse ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{rfi.officialResponse}</p>
              ) : (
                <p className="text-sm text-ink-400">
                  No official response yet.
                  {rfi.status === "open" ? (rfi.permissions.canRespond ? " You hold the ball — record the answer or adopt a draft below." : " Only the ball-in-court holder records the official answer; anyone may propose a draft.") : ""}
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Draft responses</h2>
                <span className="text-xs text-ink-400">{drafts.length} awaiting adoption</span>
              </div>
              {rfi.responses.length === 0 ? (
                <p className="text-sm text-ink-400">No draft responses. A draft is proposed by anyone and adopted as the official answer by the creator or ball-in-court holder.</p>
              ) : (
                <ul className="space-y-2">
                  {rfi.responses.map((r) => (
                    <li key={r.id} className={`rounded-md border px-3 py-2 ${r.status === "adopted" ? "border-emerald-200 bg-emerald-50/50" : r.status === "discarded" ? "border-ink-100 opacity-60" : "border-ink-200"}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-ink-500">
                          {nameOf(r.authorId)} · {formatDateTime(r.createdAt)} · <Badge tone={statusTone(r.status)} size="xs">{humanize(r.status)}</Badge>
                          {r.costImpact ? <span className="ml-2">cost {r.costImpact.toUpperCase()}</span> : null}
                          {r.scheduleImpact ? <span className="ml-2">schedule {r.scheduleImpact.toUpperCase()}{r.scheduleImpactDays !== null ? ` (${r.scheduleImpactDays}d)` : ""}</span> : null}
                        </span>
                        {r.status === "draft" ? (
                          <span className="flex gap-1.5">
                            {rfi.permissions.canAdopt ? <Button size="sm" disabled={busy} onClick={() => void doAction(`responses/${r.id}/adopt`)}>Adopt as official</Button> : null}
                            {r.authorId === me.id || rfi.createdBy === me.id || me.isCompanyAdmin ? (
                              <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { await api.post(`${base}/responses/${r.id}/discard`); await load(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } }}>Discard</Button>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-ink-800">{r.body}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardBody>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-500">Details</h2>
              <dl className="space-y-2.5 text-sm">
                <MetaRow label="Assignee" value={nameOf(rfi.assigneeId)} />
                <MetaRow label="Ball in court" value={nameOf(rfi.ballInCourtId)} />
                <MetaRow label="Due date" value={<span className={rfi.daysOverdue > 0 ? "font-medium text-red-600" : ""}>{formatDate(rfi.dueDate)}</span>} />
                <MetaRow label="Issued" value={rfi.issuedAt ? formatDateTime(rfi.issuedAt) : DASH} />
                <MetaRow label="Cost impact" value={<Badge tone={impactTone(rfi.costImpact)}>{rfi.costImpact.toUpperCase()}</Badge>} />
                <MetaRow label="Schedule impact" value={<Badge tone={impactTone(rfi.scheduleImpact)}>{rfi.scheduleImpact.toUpperCase()}{rfi.scheduleImpact === "yes" && rfi.scheduleImpactDays !== null ? ` · ${rfi.scheduleImpactDays}d` : ""}</Badge>} />
                <MetaRow label="Created by" value={nameOf(rfi.createdBy)} />
                <MetaRow label="Created" value={formatDateTime(rfi.createdAt)} />
                <MetaRow label="Updated" value={formatDateTime(rfi.updatedAt)} />
                {rfi.source === "email" && rfi.sourceMeta ? <MetaRow label="Email from" value={String(rfi.sourceMeta["from"] ?? DASH)} /> : null}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Distribution</h2>
              {rfi.distribution.length === 0 ? <p className="text-sm text-ink-400">Nobody on the distribution list.</p> : (
                <ul className="space-y-1 text-sm text-ink-800">{rfi.distribution.map((userId) => <li key={userId}>{nameOf(userId)}</li>)}</ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Related RFIs</h2>
              {rfi.related.length === 0 ? <p className="text-sm text-ink-400">No prior RFIs referenced.</p> : (
                <ul className="space-y-1 text-sm">
                  {rfi.related.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <Link to={`/projects/${projectId}/rfis/${r.id}`} className="truncate text-brand-700 hover:underline">{rfiLabel(r.number)} {r.subject}</Link>
                      <Badge tone={statusTone(r.status)} size="xs">{humanize(r.status)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal open={respondOpen !== null} title={respondOpen === "official" ? "Record official response" : "Propose a draft response"} onClose={() => setRespondOpen(null)} wide>
        <ErrorAlert message={formError} />
        <form onSubmit={onSubmitResponse} className="space-y-4">
          {respondOpen === "draft" ? <p className="text-xs text-ink-500">A draft is visible to the RFI's parties and becomes the official answer only when the creator or ball-in-court holder adopts it.</p> : null}
          <Field label={respondOpen === "official" ? "Official response" : "Proposed response"}>
            <Textarea required value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} placeholder="The definitive answer to the question…" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Cost impact">
              <Select value={form.costImpact} onChange={(e) => setForm((f) => ({ ...f, costImpact: e.target.value }))}>
                <option value="tbd">TBD</option><option value="yes">Yes</option><option value="no">No</option>
              </Select>
            </Field>
            <Field label="Schedule impact">
              <Select value={form.scheduleImpact} onChange={(e) => setForm((f) => ({ ...f, scheduleImpact: e.target.value }))}>
                <option value="tbd">TBD</option><option value="yes">Yes</option><option value="no">No</option>
              </Select>
            </Field>
            {form.scheduleImpact === "yes" ? (
              <Field label="Days impact"><Input type="number" min="0" value={form.scheduleImpactDays} onChange={(e) => setForm((f) => ({ ...f, scheduleImpactDays: e.target.value }))} /></Field>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRespondOpen(null)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : respondOpen === "official" ? "Submit response" : "Propose"}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={editOpen} title="Edit RFI" onClose={() => setEditOpen(false)} wide>
        <ErrorAlert message={editError} />
        <form onSubmit={onSaveEdit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Assignee">
              <Select value={edit.assigneeId} onChange={(e) => setEdit((d) => ({ ...d, assigneeId: e.target.value }))}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Field label="Ball in court">
              <Select value={edit.ballInCourtId} onChange={(e) => setEdit((d) => ({ ...d, ballInCourtId: e.target.value }))}>
                <option value="">Nobody</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Field label="Due date"><Input type="date" value={edit.dueDate} onChange={(e) => setEdit((d) => ({ ...d, dueDate: e.target.value }))} /></Field>
            <Field label="Distribution">
              <select multiple className="h-28 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm" value={edit.distribution} onChange={(e) => setEdit((d) => ({ ...d, distribution: Array.from(e.target.selectedOptions).map((o) => o.value) }))}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
            <Field label="Cost impact">
              <Select value={edit.costImpact} onChange={(e) => setEdit((d) => ({ ...d, costImpact: e.target.value }))}>
                <option value="tbd">TBD</option><option value="yes">Yes</option><option value="no">No</option>
              </Select>
            </Field>
            <Field label="Schedule impact">
              <Select value={edit.scheduleImpact} onChange={(e) => setEdit((d) => ({ ...d, scheduleImpact: e.target.value }))}>
                <option value="tbd">TBD</option><option value="yes">Yes</option><option value="no">No</option>
              </Select>
            </Field>
          </div>
          <p className="text-xs text-ink-400">Every change is written to the ledger with its before/after values.</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-ink-400">{label}</dt>
      <dd className="text-right text-ink-800">{value}</dd>
    </div>
  );
}
