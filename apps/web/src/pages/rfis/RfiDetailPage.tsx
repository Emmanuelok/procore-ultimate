import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
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
import { impactTone, rfiLabel, todayIso, useCompanyUsers } from "./fieldShared";

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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface RespondForm {
  officialResponse: string;
  costImpact: string;
  scheduleImpact: string;
  scheduleImpactDays: string;
}

const emptyRespond: RespondForm = {
  officialResponse: "",
  costImpact: "tbd",
  scheduleImpact: "tbd",
  scheduleImpactDays: "",
};

export default function RfiDetailPage() {
  const { projectId, rfiId } = useParams<{ projectId: string; rfiId: string }>();
  const base = `/api/v1/projects/${projectId}/rfis/${rfiId}`;
  const { nameOf } = useCompanyUsers();

  const [rfi, setRfi] = useState<Rfi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [respondOpen, setRespondOpen] = useState(false);
  const [respondForm, setRespondForm] = useState<RespondForm>(emptyRespond);
  const [respondError, setRespondError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<Rfi>(base);
      setRfi(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the RFI");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doAction(path: string, body?: unknown) {
    setActionBusy(true);
    setError(null);
    try {
      const res = await api.post<Rfi>(`${base}/${path}`, body);
      setRfi(res);
      return true;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Action failed");
      return false;
    } finally {
      setActionBusy(false);
    }
  }

  async function onRespond(e: FormEvent) {
    e.preventDefault();
    setRespondError(null);
    setActionBusy(true);
    try {
      const payload: Record<string, unknown> = {
        officialResponse: respondForm.officialResponse.trim(),
        costImpact: respondForm.costImpact,
        scheduleImpact: respondForm.scheduleImpact,
      };
      if (respondForm.scheduleImpact === "yes" && respondForm.scheduleImpactDays !== "") {
        payload["scheduleImpactDays"] = Number(respondForm.scheduleImpactDays);
      }
      const res = await api.post<Rfi>(`${base}/respond`, payload);
      setRfi(res);
      setRespondOpen(false);
      setRespondForm(emptyRespond);
    } catch (err) {
      setRespondError(err instanceof ApiClientError ? err.message : "Failed to record response");
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!rfi) {
    return (
      <div>
        <ErrorAlert message={error ?? "RFI not found"} />
        <Link to={`/projects/${projectId}/rfis`} className="text-sm text-brand-700 hover:underline">
          ← Back to RFIs
        </Link>
      </div>
    );
  }

  const overdue = rfi.status === "open" && !!rfi.dueDate && rfi.dueDate < todayIso();

  return (
    <div>
      <div className="mb-1">
        <Link
          to={`/projects/${projectId}/rfis`}
          className="text-xs font-medium text-brand-700 hover:text-brand-800"
        >
          ← Back to RFIs
        </Link>
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-ink-400">{rfiLabel(rfi.number)}</span>
            <Badge tone={statusTone(rfi.status)}>{humanize(rfi.status)}</Badge>
            {overdue ? <Badge tone="red">Overdue</Badge> : null}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-ink-900">{rfi.subject}</h1>
        </div>
        <div className="flex items-center gap-2">
          {rfi.status === "draft" ? (
            <Button disabled={actionBusy} onClick={() => void doAction("issue")}>
              Issue
            </Button>
          ) : null}
          {rfi.status === "open" ? (
            <Button disabled={actionBusy} onClick={() => setRespondOpen(true)}>
              Respond
            </Button>
          ) : null}
          {rfi.status === "open" || rfi.status === "answered" ? (
            <Button variant="secondary" disabled={actionBusy} onClick={() => void doAction("close")}>
              Close
            </Button>
          ) : null}
          {rfi.status !== "closed" && rfi.status !== "void" ? (
            <Button
              variant="danger"
              disabled={actionBusy}
              onClick={() => {
                if (window.confirm("Void this RFI? This cannot be undone.")) void doAction("void");
              }}
            >
              Void
            </Button>
          ) : null}
        </div>
      </div>

      <ErrorAlert message={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardBody>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Question
              </h2>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">
                {rfi.question}
              </p>
            </CardBody>
          </Card>

          {rfi.proposedSolution ? (
            <Card>
              <CardBody>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Proposed solution
                </h2>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">
                  {rfi.proposedSolution}
                </p>
              </CardBody>
            </Card>
          ) : null}

          <Card className={rfi.officialResponse ? "ring-emerald-200" : ""}>
            <CardBody>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Official response
                </h2>
                {rfi.respondedAt ? (
                  <span className="text-xs text-ink-400">
                    {nameOf(rfi.respondedBy)} · {formatDateTime(rfi.respondedAt)}
                  </span>
                ) : null}
              </div>
              {rfi.officialResponse ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">
                  {rfi.officialResponse}
                </p>
              ) : (
                <p className="text-sm text-ink-400">
                  No official response yet.
                  {rfi.status === "open" ? " Use the Respond action to record one." : ""}
                </p>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardBody>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Details
              </h2>
              <dl className="space-y-2.5 text-sm">
                <MetaRow label="Assignee" value={nameOf(rfi.assigneeId)} />
                <MetaRow label="Ball in court" value={nameOf(rfi.ballInCourtId)} />
                <MetaRow
                  label="Due date"
                  value={
                    <span className={overdue ? "font-medium text-red-600" : ""}>
                      {formatDate(rfi.dueDate)}
                    </span>
                  }
                />
                <MetaRow
                  label="Cost impact"
                  value={<Badge tone={impactTone(rfi.costImpact)}>{rfi.costImpact.toUpperCase()}</Badge>}
                />
                <MetaRow
                  label="Schedule impact"
                  value={
                    <Badge tone={impactTone(rfi.scheduleImpact)}>
                      {rfi.scheduleImpact.toUpperCase()}
                      {rfi.scheduleImpact === "yes" && rfi.scheduleImpactDays !== null
                        ? ` · ${rfi.scheduleImpactDays}d`
                        : ""}
                    </Badge>
                  }
                />
                <MetaRow label="Created by" value={nameOf(rfi.createdBy)} />
                <MetaRow label="Created" value={formatDateTime(rfi.createdAt)} />
                <MetaRow label="Updated" value={formatDateTime(rfi.updatedAt)} />
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Distribution
              </h2>
              {rfi.distribution.length === 0 ? (
                <p className="text-sm text-ink-400">Nobody on the distribution list.</p>
              ) : (
                <ul className="space-y-1 text-sm text-ink-800">
                  {rfi.distribution.map((userId) => (
                    <li key={userId}>{nameOf(userId)}</li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal open={respondOpen} title="Record official response" onClose={() => setRespondOpen(false)} wide>
        <ErrorAlert message={respondError} />
        <form onSubmit={onRespond} className="space-y-4">
          <Field label="Official response">
            <Textarea
              required
              value={respondForm.officialResponse}
              onChange={(e) => setRespondForm((f) => ({ ...f, officialResponse: e.target.value }))}
              placeholder="The definitive answer to the question…"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Cost impact">
              <Select
                value={respondForm.costImpact}
                onChange={(e) => setRespondForm((f) => ({ ...f, costImpact: e.target.value }))}
              >
                <option value="tbd">TBD</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </Field>
            <Field label="Schedule impact">
              <Select
                value={respondForm.scheduleImpact}
                onChange={(e) => setRespondForm((f) => ({ ...f, scheduleImpact: e.target.value }))}
              >
                <option value="tbd">TBD</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </Field>
            {respondForm.scheduleImpact === "yes" ? (
              <Field label="Days impact">
                <Input
                  type="number"
                  min="0"
                  value={respondForm.scheduleImpactDays}
                  onChange={(e) =>
                    setRespondForm((f) => ({ ...f, scheduleImpactDays: e.target.value }))
                  }
                />
              </Field>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRespondOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={actionBusy}>
              {actionBusy ? "Saving…" : "Submit response"}
            </Button>
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
