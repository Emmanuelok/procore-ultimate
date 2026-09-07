/**
 * Assurance actions (spec Vol I #415).
 *
 * A gate condition gates the decision; an assurance action is the follow-up
 * work a review leaves behind, owned by a named person with a due date that
 * lives on the obligation register. Closing one requires evidence of what
 * was done, and the closer may not be the owner — an action nobody but its
 * owner ever looked at is not assurance.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ASSURANCE_ACTION_PRIORITIES, ASSURANCE_ACTION_STATUSES } from "@constructos/shared";
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
import { DueBadge, SectionTitle, useUsers, type ListResponse } from "./governanceShared";

interface AssuranceAction {
  id: string;
  number: number;
  gateReviewId: string | null;
  source: string;
  title: string;
  description: string | null;
  priority: string;
  ownerId: string | null;
  dueDate: string | null;
  status: string;
  obligationId: string | null;
  evidenceIds: string[];
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
  createdBy: string;
  createdAt: string;
  daysToDue: number | null;
}

function statusTone(status: string): string {
  switch (status) {
    case "done":
      return "green";
    case "overdue":
      return "red";
    case "in_progress":
      return "blue";
    case "cancelled":
      return "gray";
    default:
      return "amber";
  }
}

function priorityTone(priority: string): string {
  switch (priority) {
    case "critical":
      return "red";
    case "essential":
      return "amber";
    default:
      return "gray";
  }
}

export default function AssuranceActionsTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const { users, nameOf } = useUsers();

  const [items, setItems] = useState<AssuranceAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = statusFilter ? `?status=${statusFilter}&pageSize=200` : "?pageSize=200";
      const res = await api.get<ListResponse<AssuranceAction>>(`${base}/assurance-actions${qs}`);
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof ApiClientError ? err.message : "Could not load assurance actions");
    }
  }, [base, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  /* --------------------------------- create --------------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [cTitle, setCTitle] = useState("");
  const [cDescription, setCDescription] = useState("");
  const [cPriority, setCPriority] = useState<string>("recommended");
  const [cOwner, setCOwner] = useState("");
  const [cDue, setCDue] = useState("");
  const [cSource, setCSource] = useState<string>("assurance_review");
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      await api.post(`${base}/assurance-actions`, {
        title: cTitle.trim(),
        source: cSource,
        priority: cPriority,
        ...(cDescription.trim() ? { description: cDescription.trim() } : {}),
        ...(cOwner ? { ownerId: cOwner } : {}),
        ...(cDue ? { dueDate: cDue } : {}),
      });
      setCreateOpen(false);
      setCTitle("");
      setCDescription("");
      setCOwner("");
      setCDue("");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Could not raise the action");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- close ---------------------------------- */

  const [closeFor, setCloseFor] = useState<AssuranceAction | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [closeEvidence, setCloseEvidence] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);

  async function close(e: FormEvent) {
    e.preventDefault();
    if (!closeFor) return;
    setCloseError(null);
    setCloseBusy(true);
    try {
      const ids = closeEvidence
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api.post(`${base}/assurance-actions/${closeFor.id}/close`, {
        note: closeNote.trim(),
        ...(ids.length ? { evidenceIds: ids } : {}),
      });
      setCloseFor(null);
      setCloseNote("");
      setCloseEvidence("");
      await load();
    } catch (err) {
      setCloseError(err instanceof ApiClientError ? err.message : "Could not close the action");
    } finally {
      setCloseBusy(false);
    }
  }

  async function setStatus(action: AssuranceAction, status: string) {
    setError(null);
    try {
      await api.patch(`${base}/assurance-actions/${action.id}`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not update the action");
    }
  }

  const open = (items ?? []).filter((a) => a.status !== "done" && a.status !== "cancelled");
  const overdue = open.filter((a) => a.status === "overdue" || (a.daysToDue ?? 1) < 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-4">
          <div>
            <div className="text-xl font-bold tabular-nums text-ink-900">{open.length}</div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Open</div>
          </div>
          <div>
            <div
              className={`text-xl font-bold tabular-nums ${
                overdue.length > 0 ? "text-red-700" : "text-ink-900"
              }`}
            >
              {overdue.length}
            </div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Overdue</div>
          </div>
          <div>
            <div className="text-xl font-bold tabular-nums text-ink-900">
              {(items ?? []).filter((a) => a.priority === "critical").length}
            </div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Critical</div>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-44">
            <Field label="Status">
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All</option>
                {ASSURANCE_ACTION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="mb-0.5">
            Raise action
          </Button>
        </div>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner label="Loading assurance actions…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No assurance actions"
          hint="Gate reviews and independent assurance reviews leave recommendations behind. Raise them here so they carry an owner, a due date and an obligation."
          action={<Button onClick={() => setCreateOpen(true)}>Raise the first action</Button>}
        />
      ) : (
        <Card>
          <CardBody>
            <Table>
              <thead>
                <tr>
                  <Th>No.</Th>
                  <Th>Action</Th>
                  <Th>Priority</Th>
                  <Th>Owner</Th>
                  <Th>Due</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((a) => (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                      AA-{String(a.number).padStart(3, "0")}
                    </Td>
                    <Td>
                      <div className="text-sm font-medium text-ink-900">{a.title}</div>
                      {a.description ? (
                        <div className="mt-0.5 line-clamp-2 max-w-md text-xs text-ink-500">
                          {a.description}
                        </div>
                      ) : null}
                      <div className="mt-0.5 text-[11px] text-ink-400">
                        {humanize(a.source)}
                        {a.gateReviewId ? " · from a gate review" : ""}
                        {a.obligationId ? " · on the obligation register" : ""}
                      </div>
                      {a.status === "done" && a.closeNote ? (
                        <div className="mt-0.5 text-[11px] text-emerald-700">
                          Closed {formatDate(a.closedAt)} by {nameOf(a.closedBy)} — {a.closeNote}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={priorityTone(a.priority)}>{humanize(a.priority)}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{nameOf(a.ownerId)}</Td>
                    <Td className="whitespace-nowrap">
                      {a.status === "done" || a.status === "cancelled" ? (
                        <span className="text-xs text-ink-400">
                          {a.dueDate ? formatDate(a.dueDate) : "—"}
                        </span>
                      ) : (
                        <DueBadge days={a.daysToDue} />
                      )}
                    </Td>
                    <Td>
                      <Badge tone={statusTone(a.status)}>{humanize(a.status)}</Badge>
                    </Td>
                    <Td className="text-right">
                      {a.status === "done" || a.status === "cancelled" ? null : (
                        <div className="flex justify-end gap-1.5">
                          {a.status === "open" ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void setStatus(a, "in_progress")}
                            >
                              Start
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            onClick={() => {
                              setCloseError(null);
                              setCloseNote("");
                              setCloseEvidence("");
                              setCloseFor(a);
                            }}
                          >
                            Close
                          </Button>
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      {/* --------------------------------- modals --------------------------------- */}

      <Modal open={createOpen} title="Raise assurance action" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={create} className="space-y-4">
          <Field label="Title">
            <Input required value={cTitle} onChange={(e) => setCTitle(e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea
              value={cDescription}
              onChange={(e) => setCDescription(e.target.value)}
              className="min-h-20"
              placeholder="What must be done, and what would count as done…"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Source">
              <Select value={cSource} onChange={(e) => setCSource(e.target.value)}>
                <option value="assurance_review">Assurance review</option>
                <option value="gate_review">Gate review</option>
                <option value="audit">Audit</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={cPriority} onChange={(e) => setCPriority(e.target.value)}>
                {ASSURANCE_ACTION_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {humanize(p)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner">
              <Select value={cOwner} onChange={(e) => setCOwner(e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due date" hint="Creates an obligation when the owner is named.">
              <Input type="date" value={cDue} onChange={(e) => setCDue(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Raising…" : "Raise action"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={closeFor !== null}
        title={closeFor ? `Close AA-${String(closeFor.number).padStart(3, "0")}` : "Close action"}
        onClose={() => setCloseFor(null)}
      >
        <ErrorAlert message={closeError} />
        <form onSubmit={close} className="space-y-4">
          <SectionTitle>What was done</SectionTitle>
          <Field label="Closure note" hint="Required — the record of what satisfied the action.">
            <Textarea
              required
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value)}
              className="min-h-20"
            />
          </Field>
          <Field label="Evidence ids" hint="Space or comma separated — optional.">
            <Input value={closeEvidence} onChange={(e) => setCloseEvidence(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCloseFor(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={closeBusy}>
              {closeBusy ? "Closing…" : "Close action"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
