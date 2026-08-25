/**
 * Record that a published lesson was actually applied to a later record
 * (#979) — the only evidence the platform can ever offer that learning
 * changed practice.
 *
 * `crossedProjectBoundary` is computed by the server, not asserted here, and
 * the result is reported either way: applying a lesson on the project that
 * learned it is worth recording, but it is not evidence that the knowledge
 * travelled, and this modal says so.
 */
import { useState, type FormEvent } from "react";
import { TOOLS } from "@constructos/shared";
import { api } from "../../lib/api";
import { Button, ErrorAlert, Field, Input, Modal, Select, Textarea } from "../../ui";
import { errorMessage, label, projectLabel } from "./learningShared";
import type { LessonApplication, ProjectRow } from "./learningShared";

export interface ApplyOutcome {
  application: LessonApplication;
  crossedProjectBoundary: boolean;
}

export default function ApplyModal({
  open,
  lessonNumber,
  lessonTitle,
  lessonId,
  originProjectId,
  projects,
  fixedProjectId,
  onClose,
  onApplied,
}: {
  open: boolean;
  lessonNumber: string;
  lessonTitle: string;
  lessonId: string;
  originProjectId: string | null;
  projects: ProjectRow[] | null;
  /** when the caller already has a project in hand (the Capture tab) */
  fixedProjectId?: string;
  onClose: () => void;
  onApplied: (outcome: ApplyOutcome) => void;
}) {
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [tool, setTool] = useState("");
  const [recordId, setRecordId] = useState("");
  const [recordLabel, setRecordLabel] = useState("");
  const [action, setAction] = useState("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveProject = fixedProjectId ?? projectId;
  const valid =
    effectiveProject.length > 0 && tool.length > 0 && recordId.trim().length > 0 && action.trim().length > 0;
  const wouldCross = effectiveProject.length > 0 && effectiveProject !== originProjectId;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ApplyOutcome>(
        `/api/v1/projects/${effectiveProject}/learning/lessons/${lessonId}/apply`,
        {
          appliedTo: {
            tool,
            recordId: recordId.trim(),
            ...(recordLabel.trim() ? { label: recordLabel.trim() } : {}),
          },
          action: action.trim(),
          ...(outcomeNote.trim() ? { outcomeNote: outcomeNote.trim() } : {}),
        },
      );
      onApplied(res);
      setTool("");
      setRecordId("");
      setRecordLabel("");
      setAction("");
      setOutcomeNote("");
    } catch (err) {
      setError(errorMessage(err, "The application could not be recorded"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={`Apply ${lessonNumber}`} onClose={onClose} wide>
      <p className="mb-3 text-sm text-ink-600">
        <span className="font-medium text-ink-900">{lessonTitle}</span> — bind this lesson to the specific
        record where it changed what you did. Only published lessons can be applied.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <ErrorAlert message={error} />

        {fixedProjectId ? null : (
          <Field label="Applied on project *" hint="Applying it away from where it was learned is the point.">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Select a project…</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {projectLabel(p)}
                  {p.id === originProjectId ? " (origin project)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {effectiveProject && !wouldCross ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
            This is the project the lesson was learned on. The application will be recorded, but it will
            not count as the knowledge crossing a project boundary.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Tool *">
            <Select value={tool} onChange={(e) => setTool(e.target.value)}>
              <option value="">Select…</option>
              {TOOLS.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Record id *" hint="The record this lesson shaped.">
            <Input value={recordId} onChange={(e) => setRecordId(e.target.value)} maxLength={64} />
          </Field>
        </div>

        <Field label="Record label">
          <Input
            value={recordLabel}
            onChange={(e) => setRecordLabel(e.target.value)}
            placeholder="e.g. VO-0042 — early MEP coordination workshop"
            maxLength={300}
          />
        </Field>

        <Field label="What you did differently *">
          <Textarea value={action} onChange={(e) => setAction(e.target.value)} rows={3} />
        </Field>

        <Field label="Outcome so far" hint="Optional, and honest: an outcome recorded later is worth more than one guessed now.">
          <Textarea value={outcomeNote} onChange={(e) => setOutcomeNote(e.target.value)} rows={2} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || busy}>
            {busy ? "Recording…" : "Record application"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
