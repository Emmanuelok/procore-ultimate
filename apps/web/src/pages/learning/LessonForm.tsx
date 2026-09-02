/**
 * The lesson capture form — used for a fresh draft, for editing a draft or
 * rejected lesson, and (pre-linked to its trigger) for capture-from-trigger.
 *
 * The field order is the argument: what happened, then why, then what to do
 * differently. A lesson without a recommendation is a story, so the server
 * requires one and so does this form.
 */
import { useState, type FormEvent } from "react";
import { LESSON_CATEGORIES, TOOLS } from "@constructos/shared";
import { Button, ErrorAlert, Field, Input, Select, Textarea } from "../../ui";
import { errorMessage, label, parseTags } from "./learningShared";
import type { EvidenceRef, Lesson } from "./learningShared";

export interface LessonBody {
  title: string;
  category: string;
  phase?: string | null;
  context?: string | null;
  whatHappened: string;
  rootCause?: string | null;
  recommendation: string;
  impactValue?: number | null;
  impactCurrency?: string | null;
  impactDays?: number | null;
  tags?: string[];
  evidenceRefs?: EvidenceRef[];
}

interface DraftRef {
  tool: string;
  recordId: string;
  label: string;
}

export default function LessonForm({
  initial,
  submitLabel,
  lockedEvidenceNote,
  onSubmit,
  onCancel,
}: {
  initial?: Lesson | null;
  submitLabel: string;
  /** shown when the caller adds a reference of its own (capture-from-trigger) */
  lockedEvidenceNote?: string;
  onSubmit: (body: LessonBody) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [category, setCategory] = useState<string>(initial?.category ?? "");
  const [phase, setPhase] = useState(initial?.phase ?? "");
  const [context, setContext] = useState(initial?.context ?? "");
  const [whatHappened, setWhatHappened] = useState(initial?.whatHappened ?? "");
  const [rootCause, setRootCause] = useState(initial?.rootCause ?? "");
  const [recommendation, setRecommendation] = useState(initial?.recommendation ?? "");
  const [impactValue, setImpactValue] = useState(
    initial?.impactValue === null || initial?.impactValue === undefined
      ? ""
      : String(initial.impactValue),
  );
  const [impactCurrency, setImpactCurrency] = useState(initial?.impactCurrency ?? "");
  const [impactDays, setImpactDays] = useState(
    initial?.impactDays === null || initial?.impactDays === undefined ? "" : String(initial.impactDays),
  );
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(", "));
  const [refs, setRefs] = useState<DraftRef[]>(
    (initial?.evidenceRefs ?? []).map((r) => ({
      tool: r.tool,
      recordId: r.recordId,
      label: r.label ?? "",
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currencyOk = impactCurrency.trim().length === 0 || impactCurrency.trim().length >= 3;
  const valid =
    title.trim().length > 0 &&
    category.length > 0 &&
    whatHappened.trim().length > 0 &&
    recommendation.trim().length > 0 &&
    currencyOk;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const numberOrNull = (raw: string): number | null => {
      const t = raw.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };
    const body: LessonBody = {
      title: title.trim(),
      category,
      phase: phase.trim() ? phase.trim() : null,
      context: context.trim() ? context.trim() : null,
      whatHappened: whatHappened.trim(),
      rootCause: rootCause.trim() ? rootCause.trim() : null,
      recommendation: recommendation.trim(),
      impactValue: numberOrNull(impactValue),
      impactCurrency: impactCurrency.trim().length >= 3 ? impactCurrency.trim().toUpperCase() : null,
      impactDays: (() => {
        const n = numberOrNull(impactDays);
        return n === null ? null : Math.trunc(n);
      })(),
      tags: parseTags(tagsText),
      evidenceRefs: refs
        .filter((r) => r.tool.trim() && r.recordId.trim())
        .map((r) => ({
          tool: r.tool.trim(),
          recordId: r.recordId.trim(),
          ...(r.label.trim() ? { label: r.label.trim() } : {}),
        })),
    };
    try {
      await onSubmit(body);
    } catch (err) {
      setError(errorMessage(err, "The lesson could not be saved"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorAlert message={error} />

      <Field label="Title *">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Say the lesson in one line"
          maxLength={300}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category *">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select a category…</option>
            {LESSON_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Phase"
          hint="Free text — whatever this organisation calls its phases. Matched exactly on retrieval."
        >
          <Input
            value={phase}
            onChange={(e) => setPhase(e.target.value)}
            placeholder="e.g. fit-out, commissioning"
            maxLength={60}
          />
        </Field>
      </div>

      <Field label="Context" hint="What was going on around this — enough for a stranger to place it.">
        <Textarea value={context} onChange={(e) => setContext(e.target.value)} rows={2} />
      </Field>

      <Field label="What happened *">
        <Textarea
          value={whatHappened}
          onChange={(e) => setWhatHappened(e.target.value)}
          rows={4}
          placeholder="The events, in the order they happened."
        />
      </Field>

      <Field label="Root cause" hint="Why it happened — not who.">
        <Textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} rows={3} />
      </Field>

      <Field label="Recommendation *" hint="What a future project should do differently. This is the part that gets retrieved.">
        <Textarea value={recommendation} onChange={(e) => setRecommendation(e.target.value)} rows={3} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Impact value" hint="What it cost or saved.">
          <Input
            type="number"
            step="any"
            value={impactValue}
            onChange={(e) => setImpactValue(e.target.value)}
            placeholder="e.g. 125000"
          />
        </Field>
        <Field label="Currency" hint="3-8 letters, e.g. GBP.">
          <Input
            value={impactCurrency}
            onChange={(e) => setImpactCurrency(e.target.value)}
            placeholder="GBP"
            maxLength={8}
          />
        </Field>
        <Field label="Impact (days)" hint="Whole days; negative if it saved time.">
          <Input
            type="number"
            step="1"
            value={impactDays}
            onChange={(e) => setImpactDays(e.target.value)}
            placeholder="e.g. 14"
          />
        </Field>
      </div>
      {!currencyOk ? (
        <p className="text-xs text-red-600">
          A currency code must be at least 3 characters, or left blank.
        </p>
      ) : null}

      <Field
        label="Tags"
        hint="Comma separated. Tags carry most of the precision in retrieval — a tag overlap is worth more than recency."
      >
        <Input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="late-design-change, mep-coordination"
        />
      </Field>

      {/* ----------------------------- evidence refs ---------------------------- */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-ink-600">Evidence references</span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setRefs((prev) => [...prev, { tool: "", recordId: "", label: "" }])}
          >
            Add reference
          </Button>
        </div>
        {lockedEvidenceNote ? (
          <p className="mb-2 rounded bg-brand-50 px-2 py-1.5 text-xs text-brand-800 ring-1 ring-brand-100">
            {lockedEvidenceNote}
          </p>
        ) : null}
        {refs.length === 0 ? (
          <p className="text-xs text-ink-400">
            None. A lesson anchored to the records it came from is far harder to argue with later.
          </p>
        ) : (
          <div className="space-y-2">
            {refs.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[9rem_10rem_1fr_auto]">
                <Select
                  value={r.tool}
                  onChange={(e) =>
                    setRefs((prev) => prev.map((x, j) => (j === i ? { ...x, tool: e.target.value } : x)))
                  }
                >
                  <option value="">Tool…</option>
                  {TOOLS.map((t) => (
                    <option key={t} value={t}>
                      {label(t)}
                    </option>
                  ))}
                </Select>
                <Input
                  value={r.recordId}
                  placeholder="Record id"
                  onChange={(e) =>
                    setRefs((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, recordId: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  value={r.label}
                  placeholder="Label (optional)"
                  onChange={(e) =>
                    setRefs((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRefs((prev) => prev.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
      {!valid ? (
        <p className="text-right text-xs text-ink-400">
          Title, category, what happened and a recommendation are all required.
        </p>
      ) : null}
    </form>
  );
}
