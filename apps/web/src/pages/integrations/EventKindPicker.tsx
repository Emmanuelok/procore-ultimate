/**
 * The subscription editor, built around the wildcard grammar the API accepts:
 *
 *     []            every kind (an empty list is not "none")
 *     "*"           every kind
 *     "rfi.*"       every action on that object type
 *     "*.create"    that action on every object type
 *     "rfi.create"  exactly that kind
 *
 * The catalogue driving it comes from GET /integrations/events, which is
 * DERIVED FROM THIS TENANT'S LEDGER — so a kind nobody here has ever produced
 * simply is not in it. That is a property worth showing rather than hiding
 * (honesty rule 6): the API's note is rendered verbatim, an empty catalogue is
 * explained instead of reading as "no events exist", and a subscription that
 * currently matches nothing is labelled as waiting rather than as broken.
 */
import { useMemo, useState } from "react";
import { Badge, Button, Input } from "../../ui";
import { formatDateTime } from "../format";
import {
  Caveat,
  isValidSubscription,
  matchesEventKind,
  num,
  plural,
  type EventCatalogue,
} from "./integrationsShared";

export default function EventKindPicker({
  value,
  onChange,
  catalogue,
  catalogueError,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  catalogue: EventCatalogue | null;
  catalogueError: string | null;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  /*
   * "Every kind" and "explicit list" are two intentions that an empty array
   * cannot distinguish — the API reads [] as EVERY kind, not as none. So the
   * intention is tracked here, and the one dangerous combination (explicit
   * mode with nothing selected, which would silently save as "everything") is
   * called out rather than papered over with a seeded default.
   */
  const [explicit, setExplicit] = useState(value.length > 0 && !value.includes("*"));
  const everything = !explicit;
  const explicitButEmpty = explicit && value.length === 0;

  const toggle = (entry: string) => {
    if (disabled) return;
    onChange(value.includes(entry) ? value.filter((v) => v !== entry) : [...value, entry]);
  };

  /* What the current selection actually selects, against the tenant's own
   * catalogue. This is the honest preview: it answers "will anything ever be
   * delivered" without pretending the catalogue is exhaustive. */
  const preview = useMemo(() => {
    const events = catalogue?.events ?? [];
    const selected = events.filter((e) => matchesEventKind(value, e.eventKind));
    const volume = selected.reduce((sum, e) => sum + e.count, 0);
    const waiting = value.filter(
      (sub) => !events.some((e) => matchesEventKind([sub], e.eventKind)),
    );
    return { total: events.length, selected: selected.length, volume, waiting };
  }, [catalogue, value]);

  function addCustom() {
    const entry = custom.trim().toLowerCase();
    if (entry === "") return;
    if (!isValidSubscription(entry)) {
      setCustomError(
        `"${entry}" is not a well-formed subscription. The API accepts "objectType.action", ` +
          '"objectType.*", "*.action" or "*" — lower-case letters, digits and underscores only.',
      );
      return;
    }
    setCustomError(null);
    setCustom("");
    if (!value.includes(entry)) onChange([...value, entry]);
  }

  return (
    <div className="space-y-3">
      {/* -------------------------- everything toggle -------------------------- */}
      <label className="flex items-start gap-2 rounded-md bg-ink-50 p-3 text-sm text-ink-800">
        <input
          type="checkbox"
          checked={everything}
          disabled={disabled}
          onChange={(e) => {
            setExplicit(!e.target.checked);
            onChange([]);
          }}
          className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
        />
        <span>
          <span className="font-medium">Deliver every kind</span>
          <span className="block text-[11px] text-ink-500">
            Sends an empty <code className="font-mono">eventKinds</code> list. Every ledger append
            in this company — including object types that do not exist yet — is delivered to this
            endpoint as soon as it is first written.
          </span>
        </span>
      </label>

      {!everything ? (
        <>
          {explicitButEmpty ? (
            <Caveat tone="red">
              <span className="font-semibold">Nothing is selected.</span> Saving now stores an empty{" "}
              <code className="font-mono">eventKinds</code> list, and the API reads an empty list as{" "}
              <strong>every kind</strong> — not as none. Pick at least one subscription below, or
              tick &ldquo;Deliver every kind&rdquo; above so the intention is recorded deliberately.
            </Caveat>
          ) : null}

          {/* ----------------------------- selection ---------------------------- */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Subscribed ({value.length})
            </div>
            {value.length === 0 ? (
              <p className="text-xs text-ink-400">
                Nothing selected yet — pick wildcards or exact kinds below.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {value.map((v) => {
                  const waits = preview.waiting.includes(v);
                  return (
                    <button
                      key={v}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggle(v)}
                      title={
                        waits
                          ? "No event of this kind has been recorded in this tenant yet — the subscription waits."
                          : "Remove this subscription"
                      }
                      className={
                        waits
                          ? "inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-mono text-xs text-amber-900 hover:bg-amber-200"
                          : "inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 font-mono text-xs text-brand-800 hover:bg-brand-200"
                      }
                    >
                      {v}
                      {waits ? <span className="not-italic">· waiting</span> : null}
                      <span aria-hidden>✕</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ----------------------------- wildcards ---------------------------- */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Wildcards
            </div>
            {catalogue === null ? (
              <p className="text-xs text-ink-400">Loading the event catalogue…</p>
            ) : (
              <div className="space-y-2">
                <WildcardRow
                  label="All actions on one object type"
                  entries={catalogue.objectTypes.map((t) => `${t}.*`)}
                  value={value}
                  onToggle={toggle}
                  disabled={disabled}
                  empty="No object type has been recorded in this tenant's ledger yet."
                />
                <WildcardRow
                  label="One action across every object type"
                  entries={catalogue.actions.map((a) => `*.${a}`)}
                  value={value}
                  onToggle={toggle}
                  disabled={disabled}
                  empty="The ledger action vocabulary is empty — that would be a platform fault."
                />
              </div>
            )}
          </div>

          {/* --------------------------- exact kinds ---------------------------- */}
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Exact kinds recorded in this tenant
              </span>
              {catalogue ? (
                <span className="text-[11px] text-ink-400">
                  {num(catalogue.events.length)} {plural(catalogue.events.length, "kind", "kinds")}
                </span>
              ) : null}
            </div>
            {catalogue === null ? (
              <p className="text-xs text-ink-400">Loading…</p>
            ) : catalogue.events.length === 0 ? (
              <Caveat>
                This tenant's ledger has recorded nothing yet, so the catalogue is empty.{" "}
                <strong>That does not mean no events exist.</strong> Type a kind below — the
                subscription is stored and waits for the first matching append.
              </Caveat>
            ) : (
              <div className="max-h-64 overflow-auto rounded-md ring-1 ring-ink-100">
                <table className="min-w-full divide-y divide-ink-100 text-xs">
                  <thead className="sticky top-0 bg-ink-50">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">
                        Kind
                      </th>
                      <th className="px-3 py-1.5 text-right font-semibold uppercase tracking-wide text-ink-500">
                        Recorded
                      </th>
                      <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">
                        Last seen
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-50 bg-white">
                    {catalogue.events.map((e) => {
                      const explicit = value.includes(e.eventKind);
                      const covered = matchesEventKind(value, e.eventKind);
                      return (
                        <tr key={e.eventKind} className={covered ? "bg-brand-50/50" : undefined}>
                          <td className="px-3 py-1.5">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={explicit}
                                disabled={disabled}
                                onChange={() => toggle(e.eventKind)}
                                className="h-3.5 w-3.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                              />
                              <span className="font-mono text-[11px] text-ink-800">
                                {e.eventKind}
                              </span>
                              {covered && !explicit ? (
                                <span
                                  className="text-[10px] text-brand-600"
                                  title="Already covered by a wildcard you selected"
                                >
                                  via wildcard
                                </span>
                              ) : null}
                            </label>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-ink-600">
                            {num(e.count)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-ink-500">
                            {e.lastSeenAt ? formatDateTime(e.lastSeenAt) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ------------------------- a kind not yet seen ----------------------- */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Subscribe to a kind this tenant has not produced yet
            </div>
            <div className="flex gap-2">
              <Input
                value={custom}
                disabled={disabled}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                placeholder="e.g. variation.create, contract.*, *.delete"
                className="font-mono text-xs"
              />
              <Button variant="secondary" onClick={addCustom} disabled={disabled}>
                Add
              </Button>
            </div>
            {customError ? (
              <p className="mt-1 text-xs text-red-700">{customError}</p>
            ) : (
              <p className="mt-1 text-[11px] text-ink-400">
                Accepted and stored. It simply waits — no delivery happens until this tenant first
                writes a ledger entry of that kind.
              </p>
            )}
          </div>
        </>
      ) : null}

      {/* ------------------------------ preview -------------------------------- */}
      {catalogue ? (
        <div className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-700">
          <span className="font-medium">
            {everything
              ? `Matches all ${num(preview.total)} ${plural(preview.total, "kind", "kinds")} in the catalogue`
              : `Matches ${num(preview.selected)} of ${num(preview.total)} ${plural(preview.total, "kind", "kinds")} in the catalogue`}
          </span>
          {preview.selected > 0 ? (
            <span className="text-ink-500">
              {" "}
              — {num(preview.volume)} ledger {plural(preview.volume, "entry", "entries")} would have
              matched historically (past entries are <em>not</em> replayed; only appends made after
              the endpoint exists are delivered).
            </span>
          ) : null}
          {preview.waiting.length > 0 ? (
            <div className="mt-1 text-amber-800">
              {num(preview.waiting.length)}{" "}
              {plural(preview.waiting.length, "subscription matches", "subscriptions match")} nothing
              in the catalogue yet ({preview.waiting.join(", ")}) — stored and waiting, not an error.
            </div>
          ) : null}
          {!everything && preview.selected === 0 && preview.waiting.length === 0 ? (
            <div className="mt-1 text-amber-800">
              Nothing selected: an endpoint with an explicit but non-matching subscription list
              receives nothing at all.
            </div>
          ) : null}
        </div>
      ) : null}

      {/* --------------------- the catalogue's own caveat ---------------------- */}
      {catalogueError ? (
        <Caveat tone="red">
          The event catalogue could not be loaded: {catalogueError}. Subscriptions can still be
          typed by hand above — the API validates the grammar on save.
        </Caveat>
      ) : catalogue ? (
        <Caveat tone="ink">
          <span className="font-semibold">
            Catalogue derived from {catalogue.derivedFrom}, not a curated list.
          </span>{" "}
          {catalogue.note}
        </Caveat>
      ) : null}
    </div>
  );
}

function WildcardRow({
  label,
  entries,
  value,
  onToggle,
  disabled,
  empty,
}: {
  label: string;
  entries: string[];
  value: string[];
  onToggle: (entry: string) => void;
  disabled?: boolean;
  empty: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-ink-400">{label}</div>
      {entries.length === 0 ? (
        <p className="text-[11px] text-ink-400">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onToggle("*")}
            className={
              value.includes("*")
                ? "rounded-full bg-brand-600 px-2 py-0.5 font-mono text-xs text-white"
                : "rounded-full bg-ink-100 px-2 py-0.5 font-mono text-xs text-ink-700 hover:bg-ink-200"
            }
            title="Every kind — equivalent to an empty subscription list"
          >
            *
          </button>
          {entries.map((entry) => (
            <button
              key={entry}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(entry)}
              className={
                value.includes(entry)
                  ? "rounded-full bg-brand-600 px-2 py-0.5 font-mono text-xs text-white"
                  : "rounded-full bg-ink-100 px-2 py-0.5 font-mono text-xs text-ink-700 hover:bg-ink-200"
              }
            >
              {entry}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact read-only rendering of an endpoint's subscription list. */
export function EventKindSummary({ eventKinds }: { eventKinds: string[] }) {
  if (!eventKinds || eventKinds.length === 0) {
    return (
      <Badge tone="violet">
        <span title="Empty eventKinds — every ledger append in this company">Every kind</span>
      </Badge>
    );
  }
  const shown = eventKinds.slice(0, 4);
  return (
    <div className="flex max-w-xs flex-wrap gap-1" title={eventKinds.join(", ")}>
      {shown.map((k) => (
        <span
          key={k}
          className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 font-mono text-[11px] text-ink-700"
        >
          {k}
        </span>
      ))}
      {eventKinds.length > shown.length ? (
        <span className="text-[11px] text-ink-400">+{eventKinds.length - shown.length}</span>
      ) : null}
    </div>
  );
}
