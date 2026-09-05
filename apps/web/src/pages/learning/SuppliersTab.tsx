/**
 * CROSS-PROJECT SUPPLIER PERFORMANCE (#987-989).
 *
 * A vendor's record on one job is an anecdote. The same record across eleven
 * is knowledge, and this tab is where the organisation reads it back.
 *
 * The design is built around one rule: a dimension with no records shows "—"
 * with the reason, never a zero and never a green tick. Rows sort worst-first
 * because a supplier scorecard read as a leaderboard is a scorecard read from
 * the wrong end, and every score opens to the counts and the arithmetic it
 * came from, so a supplier arguing with it has something to argue with.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Card, CardBody, EmptyState, Spinner } from "../../ui";
import {
  LoadError,
  NoteCard,
  SUPPLIER_DIMENSIONS,
  SectionTitle,
  errorMessage,
  scoreTone,
  type SupplierDimension,
  type SupplierPerformanceResponse,
  type SupplierScore,
} from "./learningShared";

function ScoreCell({ dim }: { dim: SupplierDimension }) {
  return (
    <div>
      <span className={`text-sm font-semibold tabular-nums ${scoreTone(dim.score)}`}>
        {dim.score === null ? "—" : dim.score}
      </span>
      <span className="ml-1 text-[11px] text-ink-400">
        {dim.observations === 0 ? "no records" : `${dim.observations} rec.`}
      </span>
    </div>
  );
}

function SupplierRow({ row }: { row: SupplierScore }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-ink-100 first:border-t-0">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left hover:bg-ink-50"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`w-12 text-lg font-bold tabular-nums ${scoreTone(row.composite)}`}>
          {row.composite === null ? "—" : row.composite}
        </span>
        <span className="min-w-48 flex-1 text-sm font-medium text-ink-900">{row.vendorName}</span>
        {SUPPLIER_DIMENSIONS.map((d) => (
          <span key={d.key} className="w-36">
            <span className="block text-[11px] uppercase tracking-wide text-ink-400">
              {d.label}
            </span>
            <ScoreCell dim={row[d.key]} />
          </span>
        ))}
      </button>
      {open ? (
        <div className="space-y-2 bg-ink-50 px-3 py-3 text-xs">
          {SUPPLIER_DIMENSIONS.map((d) => (
            <div key={d.key}>
              <p className="font-semibold text-ink-700">
                {d.label} —{" "}
                <span className={scoreTone(row[d.key].score)}>
                  {row[d.key].score === null ? "not scored" : row[d.key].score}
                </span>
              </p>
              <p className="text-ink-600">{row[d.key].basis}</p>
              {Object.keys(row[d.key].counts).length > 0 ? (
                <p className="mt-0.5 font-mono text-[11px] text-ink-500">
                  {Object.entries(row[d.key].counts)
                    .map(([k, v]) => `${k}=${v}`)
                    .join("  ")}
                </p>
              ) : null}
            </div>
          ))}
          <div>
            <p className="font-semibold text-ink-700">Why this reads as it does</p>
            <ul className="list-disc space-y-0.5 pl-4 text-ink-600">
              {row.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default function SuppliersTab() {
  const [data, setData] = useState<SupplierPerformanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(
        await api.get<SupplierPerformanceResponse>("/api/v1/learning/supplier-performance"),
      );
    } catch (err) {
      setData(null);
      setError(errorMessage(err, "Failed to load supplier performance"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!data) return <Spinner label="Assembling the scorecard…" />;

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionTitle hint="Assembled from acts the platform already recorded — insurance certificates, meeting actions the vendor owned, and non-conformances raised against them. Worst first.">
          Supplier performance across projects
        </SectionTitle>

        {data.scope === "restricted" ? (
          <NoteCard
            tone="amber"
            title="Restricted view"
            note={
              "You hold learning on some projects and not others, so this scorecard is assembled " +
              "only from the projects you can open. A supplier's record elsewhere in the company " +
              "is not counted here, and its absence is not evidence."
            }
          />
        ) : null}

        {data.items.length === 0 ? (
          <EmptyState
            title="Nothing to score"
            hint={data.note ?? "No vendor in this company has any record the scorecard reads."}
          />
        ) : (
          <>
            <ul className="rounded-lg border border-ink-100">
              {data.items.map((row) => (
                <SupplierRow key={row.vendorId} row={row} />
              ))}
            </ul>
            {data.sources ? (
              <div className="text-xs text-ink-500">
                <p className="font-semibold text-ink-600">What each score is read from</p>
                <ul className="list-disc pl-4">
                  {data.sources.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {data.note ? <p className="text-xs text-ink-400">{data.note}</p> : null}
            <p className="text-xs text-ink-400">As at {data.asOf}.</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
