/**
 * Evidence multi-select for the land workspace. Compensation — to a
 * landowner or to a household — cannot be recorded without evidence that the
 * money reached the beneficiary (#554, #567), so this picker is the only way
 * those payments get keyed in.
 */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Spinner } from "../../ui";
import { formatDate, humanize } from "../format";
import type { EvidenceRow, ListResponse } from "./landShared";

export default function EvidencePicker({
  projectId,
  selected,
  onChange,
}: {
  projectId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [items, setItems] = useState<EvidenceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<ListResponse<EvidenceRow>>(
          `/api/v1/projects/${projectId}/evidence?pageSize=100`,
        );
        if (!cancelled) setItems(res.items);
      } catch (err) {
        if (!cancelled) {
          setItems([]);
          setError(err instanceof Error ? err.message : "Failed to load evidence");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  if (items === null) return <Spinner label="Loading evidence…" />;
  if (error) {
    return (
      <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-100">
        {error}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-ink-200 px-3 py-4 text-center text-xs text-ink-400">
        No evidence captured in this project yet. Ingest the payment record — bank transaction,
        signed receipt, beneficiary-verified disbursement — in the Assurance workspace first.
        Compensation cannot be recorded without it.
      </div>
    );
  }

  return (
    <div>
      <div className="max-h-56 overflow-y-auto rounded-md ring-1 ring-ink-200">
        <ul className="divide-y divide-ink-100">
          {items.map((ev) => {
            const checked = selected.includes(ev.id);
            return (
              <li key={ev.id}>
                <label
                  className={`flex cursor-pointer items-start gap-2.5 px-3 py-2 text-sm hover:bg-ink-50 ${
                    checked ? "bg-brand-50/60" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                    checked={checked}
                    onChange={() => toggle(ev.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="blue">{humanize(ev.kind)}</Badge>
                      <span className="truncate text-xs font-medium text-ink-800">{ev.source}</span>
                    </span>
                    <span className="mt-0.5 block text-[11px] text-ink-400">
                      {formatDate(ev.capturedAt ?? ev.ingestedAt)} · hash{" "}
                      <span className="font-mono">{ev.contentHash.slice(0, 12)}…</span>
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
        <span>
          {selected.length} selected
          {selected.length === 0 ? (
            <span className="ml-1.5 font-medium text-amber-700">
              — compensation must be evidenced
            </span>
          ) : null}
        </span>
        {selected.length > 0 ? (
          <button
            type="button"
            className="font-medium text-brand-700 hover:text-brand-800"
            onClick={() => onChange([])}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
