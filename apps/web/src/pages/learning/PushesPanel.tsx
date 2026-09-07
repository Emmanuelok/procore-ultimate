/**
 * CROSS-PROJECT RELEVANCE PUSHES (#985-986).
 *
 * The failure a lessons register is built to prevent is not "we did not write
 * it down" — it is "we wrote it down and the next project never saw it".
 * Retrieval that waits to be searched for is retrieval that does not happen,
 * so the platform pushes newly published lessons at the projects its
 * deterministic ranker says they apply to.
 *
 * A push is only worth something if it can be answered, and the three answers
 * are deliberately asymmetric: acknowledging is free, applying must name the
 * application record that proves it, and dismissing must say why. A dismissal
 * without a reason is an unrecorded decision — and that answer, "this does
 * not apply here because…", is itself worth keeping.
 */
import { useCallback, useEffect, useState } from "react";
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
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { formatDateTime } from "../format";
import {
  Drawer,
  LoadError,
  SectionTitle,
  errorMessage,
  fmtInt,
  label,
  type ListResponse,
} from "./learningShared";

interface PushRow {
  id: string;
  lessonId: string;
  projectId: string;
  score: number | null;
  reasons: { code: string; detail?: string; weight?: number }[] | null;
  status: string;
  respondedBy: string | null;
  respondedAt: string | null;
  responseReason: string | null;
  applicationId: string | null;
  pushedAt: string;
  lesson: {
    id: string;
    number: string;
    title: string;
    category: string;
    recommendation: string;
    impactValue: number | null;
    impactCurrency: string | null;
  } | null;
}

const STATUS_TONE: Record<string, string> = {
  pushed: "amber",
  acknowledged: "blue",
  applied: "green",
  dismissed: "gray",
};

export default function PushesPanel({
  projectId,
  onInspectLesson,
}: {
  projectId: string;
  onInspectLesson: (lessonId: string) => void;
}) {
  const [data, setData] = useState<ListResponse<PushRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [responding, setResponding] = useState<PushRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.get<ListResponse<PushRow>>(
          `/api/v1/projects/${projectId}/learning/pushes?pageSize=100`,
        ),
      );
    } catch (err) {
      setData(null);
      setError(errorMessage(err, "Failed to load the lessons pushed at this project"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner />;
  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!data) return null;

  const unanswered = data.items.filter((p) => p.status === "pushed");

  return (
    <div className="space-y-4">
      <SectionTitle hint="Lessons the ranker says apply to this project, pushed rather than waiting to be searched for. Every push can be answered, and every answer is kept.">
        Pushed at this project
      </SectionTitle>

      {unanswered.length > 0 ? (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          {fmtInt(unanswered.length)} push{unanswered.length === 1 ? "" : "es"} nobody has answered.
          An unanswered push is indistinguishable from a lesson nobody sent: the register cannot
          tell whether it was read and rejected or never opened.
        </div>
      ) : null}

      {data.items.length === 0 ? (
        <EmptyState
          title="Nothing has been pushed here"
          description="Published lessons are pushed at the projects the deterministic ranker scores as relevant — by category, phase, project type and tags. Nothing has scored high enough for this project yet."
        />
      ) : (
        <ul className="space-y-2">
          {data.items.map((p) => (
            <li key={p.id}>
              <Card>
                <CardBody className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[p.status] ?? "gray"}>{label(p.status)}</Badge>
                    {p.lesson ? (
                      <button
                        type="button"
                        onClick={() => onInspectLesson(p.lesson!.id)}
                        className="font-mono text-xs text-brand-700 hover:underline"
                      >
                        {p.lesson.number}
                      </button>
                    ) : null}
                    <span className="text-sm font-medium text-ink-900">
                      {p.lesson?.title ?? "(the lesson has been removed)"}
                    </span>
                    <span className="flex-1" />
                    <span className="text-xs tabular-nums text-ink-500">
                      relevance {p.score === null ? "—" : p.score.toFixed(2)}
                    </span>
                  </div>

                  {p.lesson ? (
                    <p className="text-sm leading-relaxed text-ink-700">
                      {p.lesson.recommendation}
                    </p>
                  ) : null}

                  {p.reasons && p.reasons.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {p.reasons.map((r, i) => (
                        <li
                          key={`${r.code}-${i}`}
                          className="rounded-full bg-ink-50 px-2 py-0.5 text-xs text-ink-600 ring-1 ring-ink-200"
                          title={r.detail}
                        >
                          {label(r.code)}
                          {r.detail ? `: ${r.detail}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                    <span>pushed {formatDateTime(p.pushedAt)}</span>
                    {p.respondedAt ? (
                      <>
                        <span>·</span>
                        <span>answered {formatDateTime(p.respondedAt)}</span>
                      </>
                    ) : null}
                    {p.responseReason ? (
                      <>
                        <span>·</span>
                        <span className="text-ink-700">{p.responseReason}</span>
                      </>
                    ) : null}
                    <span className="flex-1" />
                    {p.status === "pushed" ? (
                      <Button variant="secondary" onClick={() => setResponding(p)}>
                        Answer it
                      </Button>
                    ) : null}
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {responding ? (
        <RespondForm
          projectId={projectId}
          push={responding}
          onClose={() => setResponding(null)}
          onSaved={() => {
            setResponding(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function RespondForm({
  projectId,
  push,
  onClose,
  onSaved,
}: {
  projectId: string;
  push: PushRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState("acknowledged");
  const [reason, setReason] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/learning/pushes/${push.id}/respond`, {
        status,
        reason: reason.trim() || null,
        applicationId: applicationId.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not record the answer"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open title={`Answer: ${push.lesson?.title ?? "lesson"}`} onClose={onClose}>
      <div className="space-y-3">
        {error ? <ErrorAlert message={error} /> : null}
        <Field label="What is the answer?">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="acknowledged">Read it — no change needed yet</option>
            <option value="applied">Applied it — and here is the record</option>
            <option value="dismissed">It does not apply here</option>
          </Select>
        </Field>
        {status === "applied" ? (
          <Field
            label="Application id"
            hint="Applying a lesson without naming the record that proves it is a claim, not evidence — the API refuses it."
          >
            <Input
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
              placeholder="lap_…"
            />
          </Field>
        ) : null}
        <Field
          label={status === "dismissed" ? "Why does it not apply?" : "Note (optional)"}
          hint={
            status === "dismissed"
              ? "Required. A dismissal without a reason is an unrecorded decision, and this answer is itself worth keeping."
              : undefined
          }
        >
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button
            onClick={() => void submit()}
            disabled={
              busy ||
              (status === "dismissed" && reason.trim().length === 0) ||
              (status === "applied" && applicationId.trim().length === 0)
            }
          >
            {busy ? "Recording…" : "Record the answer"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
