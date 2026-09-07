/**
 * MEASURING WHAT AN APPLIED LESSON ACTUALLY DID (#979, #981-984).
 *
 * A lessons register that counts applications and stops there reports impact
 * it has not measured. The API has always carried the outcome fields and the
 * segregation rule that goes with them — the person who applied a lesson may
 * not also certify that it worked — and the web app had no way to record one,
 * so every application sat at `unknown` forever and the health scorecard's
 * "measured" column could only ever read zero.
 *
 * `unknown` stays the default and is a real answer. "Made it worse" is on the
 * list for the same reason: a register that can only record success is a
 * marketing document.
 */
import { useState } from "react";
import { api } from "../../lib/api";
import { Button, ErrorAlert, Field, Input, Select, Textarea } from "../../ui";
import {
  Drawer,
  LESSON_OUTCOMES,
  LESSON_OUTCOME_LABELS,
  errorMessage,
  type LessonApplication,
} from "./learningShared";

export default function OutcomeForm({
  application,
  onClose,
  onSaved,
}: {
  application: LessonApplication;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [outcome, setOutcome] = useState(application.outcome ?? "unknown");
  const [note, setNote] = useState(application.outcomeNote ?? "");
  const [value, setValue] = useState(
    application.outcomeValue === null ? "" : String(application.outcomeValue),
  );
  const [currency, setCurrency] = useState(application.outcomeCurrency ?? "GBP");
  const [days, setDays] = useState(
    application.outcomeDays === null ? "" : String(application.outcomeDays),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/api/v1/projects/${application.projectId}/learning/applications/${application.id}/outcome`,
        {
          outcome,
          outcomeNote: note.trim() || null,
          outcomeValue: value.trim() === "" ? null : Number(value),
          outcomeCurrency: value.trim() === "" ? null : currency,
          outcomeDays: days.trim() === "" ? null : Number(days),
        },
      );
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not record the outcome"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open title="What happened after this lesson was applied?" onClose={onClose}>
      <div className="space-y-3">
        {error ? <ErrorAlert message={error} /> : null}
        <p className="text-sm leading-relaxed text-ink-500">
          The platform refuses this to the person who applied the lesson. A measured outcome is the
          second pair of eyes the module is built on: ask the person who felt the effect, or the
          project's reviewer.
        </p>
        <div className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-700">
          <span className="font-medium">What was done: </span>
          {application.action}
        </div>
        <Field label="Outcome">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {LESSON_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {LESSON_OUTCOME_LABELS[o] ?? o}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="What was observed?"
          hint="The evidence for the answer above, not a restatement of it."
        >
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Value avoided">
            <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field
            label="Currency"
            hint="A money outcome needs its currency — the API refuses a bare number"
          >
            <Input
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Days avoided">
            <Input type="number" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Recording…" : "Record the outcome"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
