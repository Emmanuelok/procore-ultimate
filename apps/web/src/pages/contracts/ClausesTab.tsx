import { useMemo, useState } from "react";
import { CLAUSE_CATEGORIES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Alert,
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
  Textarea,
} from "../../ui";
import { humanize } from "../format";
import type { EffectiveClause, ParticularCondition } from "./contractsShared";

/**
 * Effective clause register: the standard form's library overlaid with the
 * contract's Particular Conditions (#201-202).
 *
 * The overlay is AUTHORITATIVE, not decorative — an amended time bar is what
 * the engine counts, and the card shows both the amended period and the
 * standard form's own so the change is visible rather than hidden. The editor
 * writes structured amendments (period, calendar, warning lead, deletion) so a
 * contract that departs from its form still produces correct deadlines.
 */
export default function ClausesTab({
  projectId,
  contractId,
  clauses,
  particularConditions,
  editable,
  onRaiseEvent,
  onChanged,
}: {
  projectId: string;
  contractId: string;
  clauses: EffectiveClause[];
  particularConditions: ParticularCondition[];
  editable: boolean;
  onRaiseEvent: (clauseRef: string) => void;
  onChanged: () => void;
}) {
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [amendedOnly, setAmendedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<EffectiveClause | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    let items = clauses;
    if (category) items = items.filter((c) => c.category === category);
    if (amendedOnly) items = items.filter((c) => c.amended);
    const needle = search.trim().toLowerCase();
    if (needle) {
      items = items.filter(
        (c) =>
          c.clauseRef.toLowerCase().includes(needle) ||
          c.title.toLowerCase().includes(needle) ||
          c.summary.toLowerCase().includes(needle),
      );
    }
    return items;
  }, [clauses, category, search, amendedOnly]);

  const amendedCount = clauses.filter((c) => c.amended).length;

  async function writeConditions(next: ParticularCondition[]) {
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/api/v1/projects/${projectId}/contracts/${contractId}`, {
        particularConditions: next,
      });
      setEditing(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to save the amendment");
    } finally {
      setBusy(false);
    }
  }

  const chip = (active: boolean) =>
    active
      ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
      : "rounded-full bg-white px-3 py-1 text-xs font-medium text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50";

  return (
    <div>
      <ErrorAlert message={error} />

      {amendedCount > 0 ? (
        <Alert tone="info" className="mb-4">
          {amendedCount} clause{amendedCount === 1 ? " is" : "s are"} amended by the Particular
          Conditions. Amended periods are what the time-bar engine counts — the standard-form period
          is shown alongside for comparison.
        </Alert>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" className={chip(category === "")} onClick={() => setCategory("")}>
          All
        </button>
        {CLAUSE_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={chip(category === c)}
            onClick={() => setCategory((prev) => (prev === c ? "" : c))}
          >
            {humanize(c)}
          </button>
        ))}
        <button
          type="button"
          className={chip(amendedOnly)}
          onClick={() => setAmendedOnly((v) => !v)}
        >
          Amended only
        </button>
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="w-64"
            placeholder="Search clauses…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {editable ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setEditing({
                  clauseRef: "",
                  title: "New Particular Condition",
                  summary: "",
                  category: "general",
                  noticeRequired: false,
                  amended: true,
                  amendment: "",
                })
              }
            >
              Add a Particular Condition
            </Button>
          ) : null}
        </div>
      </div>

      {clauses.length === 0 ? (
        <EmptyState
          title="No clause library for this form"
          hint="A bespoke contract carries no standard-form model. Add Particular Conditions with their own time bars, or state the bar on each event."
          action={
            editable ? (
              <Button
                onClick={() =>
                  setEditing({
                    clauseRef: "",
                    title: "New Particular Condition",
                    summary: "",
                    category: "general",
                    noticeRequired: false,
                    amended: true,
                    amendment: "",
                  })
                }
              >
                Add a Particular Condition
              </Button>
            ) : undefined
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="No clauses match" hint="Try another category or search term." />
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => (
            <Card key={c.clauseRef}>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-brand-700">
                        {c.clauseRef}
                      </span>
                      <span className="text-sm font-semibold text-ink-900">{c.title}</span>
                      {c.deleted ? (
                        <Badge tone="red">DELETED BY PC</Badge>
                      ) : c.amended ? (
                        <Badge tone="violet">AMENDED</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone="gray">{humanize(c.category)}</Badge>
                      {c.deleted ? null : c.timeBarDays ? (
                        <>
                          <Badge tone="red">
                            {c.timeBarDays}-{c.calendarBasis === "working" ? "working" : "calendar"}
                            -day notice
                          </Badge>
                          {c.libraryTimeBarDays != null &&
                          c.libraryTimeBarDays !== c.timeBarDays ? (
                            <Badge tone="gray">
                              standard form: {c.libraryTimeBarDays} days
                            </Badge>
                          ) : null}
                          {c.warnDaysBefore ? (
                            <Badge tone="amber">warns {c.warnDaysBefore}d ahead</Badge>
                          ) : null}
                        </>
                      ) : c.noticeRequired ? (
                        <Badge tone="amber">Notice required</Badge>
                      ) : null}
                      {c.noticeBy ? (
                        <Badge tone="blue">Notice by {humanize(c.noticeBy).toLowerCase()}</Badge>
                      ) : null}
                      {c.standingObligation ? (
                        <Badge tone="green">
                          Standing obligation — {humanize(c.standingObligation.party).toLowerCase()}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {editable ? (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                        {c.amended ? "Edit amendment" : "Amend"}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onRaiseEvent(c.clauseRef)}
                    >
                      Raise event under this clause
                    </Button>
                  </div>
                </div>

                <p className="mt-2 text-sm leading-relaxed text-ink-600">{c.summary}</p>

                {c.amended && c.amendment ? (
                  <div className="mt-3 rounded-md bg-violet-50 p-3 ring-1 ring-violet-100">
                    <button
                      type="button"
                      className="text-xs font-semibold uppercase tracking-wide text-violet-700 hover:text-violet-900"
                      onClick={() =>
                        setExpanded((m) => ({ ...m, [c.clauseRef]: !m[c.clauseRef] }))
                      }
                    >
                      Particular Condition {expanded[c.clauseRef] ? "▾" : "▸"}
                    </button>
                    {expanded[c.clauseRef] ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-violet-900">
                        {c.amendment}
                      </p>
                    ) : (
                      <p className="mt-1 truncate text-sm text-violet-800/70">{c.amendment}</p>
                    )}
                    {c.amended && c.timeBarDays == null && !c.deleted && c.libraryTimeBarDays ? (
                      <p className="mt-2 text-xs text-amber-800">
                        This amendment carries no structured period, so the engine is still counting
                        the standard form&rsquo;s {c.libraryTimeBarDays} days. Edit it to state the
                        amended period.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <AmendmentModal
        clause={editing}
        existing={particularConditions}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={writeConditions}
      />
    </div>
  );
}

function AmendmentModal({
  clause,
  existing,
  busy,
  onClose,
  onSave,
}: {
  clause: EffectiveClause | null;
  existing: ParticularCondition[];
  busy: boolean;
  onClose: () => void;
  onSave: (next: ParticularCondition[]) => Promise<void>;
}) {
  const current = clause ? existing.find((p) => p.clauseRef === clause.clauseRef) : undefined;
  const [clauseRef, setClauseRef] = useState(clause?.clauseRef ?? "");
  const [amendment, setAmendment] = useState(current?.amendment ?? "");
  const [timeBarDays, setTimeBarDays] = useState(
    current?.timeBarDays == null ? "" : String(current.timeBarDays),
  );
  const [calendarBasis, setCalendarBasis] = useState(current?.calendarBasis ?? "");
  const [warnDaysBefore, setWarnDaysBefore] = useState(
    current?.warnDaysBefore == null ? "" : String(current.warnDaysBefore),
  );
  const [deleted, setDeleted] = useState(current?.deleted ?? false);

  // reset the form whenever a different clause is opened
  const key = clause?.clauseRef ?? "";
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setClauseRef(clause?.clauseRef ?? "");
    setAmendment(current?.amendment ?? "");
    setTimeBarDays(current?.timeBarDays == null ? "" : String(current.timeBarDays));
    setCalendarBasis(current?.calendarBasis ?? "");
    setWarnDaysBefore(current?.warnDaysBefore == null ? "" : String(current.warnDaysBefore));
    setDeleted(current?.deleted ?? false);
  }

  function build(): ParticularCondition[] {
    const ref = clauseRef.trim();
    const next = existing.filter((p) => p.clauseRef !== ref && p.clauseRef !== clause?.clauseRef);
    const days = timeBarDays.trim();
    next.push({
      clauseRef: ref,
      amendment: amendment.trim(),
      ...(days ? { timeBarDays: Number(days) } : {}),
      ...(calendarBasis ? { calendarBasis: calendarBasis as "calendar" | "working" } : {}),
      ...(warnDaysBefore.trim() ? { warnDaysBefore: Number(warnDaysBefore) } : {}),
      ...(deleted ? { deleted: true } : {}),
    });
    return next;
  }

  return (
    <Modal
      open={clause !== null}
      title={
        clause?.clauseRef
          ? `Particular Condition — clause ${clause.clauseRef}`
          : "New Particular Condition"
      }
      onClose={onClose}
    >
      <p className="mb-3 text-xs text-ink-500">
        A structured amendment is what the engine acts on. Leave the period blank to record wording
        only — the standard form&rsquo;s period then still applies, and the clause is flagged so
        nobody assumes otherwise.
      </p>
      <div className="space-y-3">
        <Field label="Clause reference">
          <Input
            value={clauseRef}
            onChange={(e) => setClauseRef(e.target.value)}
            disabled={Boolean(clause?.clauseRef)}
            placeholder="20.2"
          />
        </Field>
        <Field label="Amendment text">
          <Textarea rows={4} value={amendment} onChange={(e) => setAmendment(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Time bar (days)">
            <Input
              value={timeBarDays}
              inputMode="numeric"
              onChange={(e) => setTimeBarDays(e.target.value)}
              disabled={deleted}
            />
          </Field>
          <Field label="Calendar">
            <Select
              value={calendarBasis}
              onChange={(e) => setCalendarBasis(e.target.value)}
              disabled={deleted}
            >
              <option value="">Contract default</option>
              <option value="calendar">Calendar days</option>
              <option value="working">Working days</option>
            </Select>
          </Field>
          <Field label="Warn (days before)">
            <Input
              value={warnDaysBefore}
              inputMode="numeric"
              onChange={(e) => setWarnDaysBefore(e.target.value)}
              disabled={deleted}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} />
          This clause is deleted by the Particular Conditions
        </label>
      </div>

      <div className="mt-5 flex justify-between gap-2">
        {current ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void onSave(existing.filter((p) => p.clauseRef !== clause?.clauseRef))
            }
          >
            Remove amendment
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !clauseRef.trim() || amendment.trim().length === 0}
            onClick={() => void onSave(build())}
          >
            {busy ? "Saving…" : "Save amendment"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
