/**
 * THE FEEDBACK LOOP, MADE VISIBLE (#981–984).
 *
 * A company estimates a job, builds it, and then estimates the next job from
 * the same library of opinions it started with. This tab is where the outturn
 * comes back: what an element actually cost per unit, what an activity
 * actually took, and — the number nobody publishes — how wrong the estimate
 * was, in a direction and a percentage.
 *
 * Three rules the design refuses to break:
 *   · A proposal is a proposal. Nothing computed here is in the library until
 *     a named person accepts it, so every row carries its status and its
 *     sample rather than presenting itself as fact.
 *   · A thin sample says so. `sufficient` is folded into the server's note and
 *     the note is rendered verbatim; a p80 from two observations is shown with
 *     the sentence that says it comes from two observations.
 *   · No estimate means no accuracy. An entry with nothing to compare against
 *     shows "—", never a flattering 0%.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
} from "../../ui";
import { formatDate } from "../format";
import {
  LoadError,
  NoteCard,
  SectionTitle,
  Stat,
  biasLabel,
  biasTone,
  errorMessage,
  fmtInt,
  fmtNum,
  label,
  libraryStatusTone,
  type DurationLibraryEntry,
  type LibraryAccuracy,
  type LibraryRebuildResult,
  type ListResponse,
  type RateLibraryEntry,
  type RiskRealisationResponse,
} from "./learningShared";

type LibraryKind = "rates" | "durations";

const STATUS_OPTIONS = ["", "proposed", "accepted", "rejected", "superseded"];

export default function LibrariesTab({ canAdmin }: { canAdmin: boolean }) {
  const [kind, setKind] = useState<LibraryKind>("rates");
  const [status, setStatus] = useState("proposed");
  const [code, setCode] = useState("");

  const [rates, setRates] = useState<ListResponse<RateLibraryEntry> | null>(null);
  const [durations, setDurations] = useState<ListResponse<DurationLibraryEntry> | null>(null);
  const [accuracy, setAccuracy] = useState<LibraryAccuracy | null>(null);
  const [realisations, setRealisations] = useState<RiskRealisationResponse | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rebuild, setRebuild] = useState<LibraryRebuildResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (status) params.set("status", status);
      if (code.trim()) params.set("code", code.trim());
      const [r, d, a, rr] = await Promise.all([
        api.get<ListResponse<RateLibraryEntry>>(`/api/v1/learning/libraries/rates?${params}`),
        api.get<ListResponse<DurationLibraryEntry>>(
          `/api/v1/learning/libraries/durations?${params}`,
        ),
        api.get<LibraryAccuracy>("/api/v1/learning/libraries/accuracy"),
        api.get<RiskRealisationResponse>("/api/v1/learning/risk-realisations?pageSize=100"),
      ]);
      setRates(r);
      setDurations(d);
      setAccuracy(a);
      setRealisations(rr);
    } catch (err) {
      setError(errorMessage(err, "Failed to load the libraries"));
    } finally {
      setLoading(false);
    }
  }, [status, code]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runRebuild() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.post<LibraryRebuildResult>("/api/v1/learning/libraries/rebuild", {});
      setRebuild(res);
      setNotice(
        `Rebuilt from outturn: ${res.rates.proposals} rate proposal(s) and ` +
          `${res.durations.proposals} duration proposal(s). Nothing has entered the library — ` +
          "each proposal still needs accepting.",
      );
      await load();
    } catch (err) {
      setNotice(errorMessage(err, "The rebuild was refused"));
    } finally {
      setBusy(false);
    }
  }

  async function decide(entryKind: LibraryKind, id: string, decision: "accept" | "reject") {
    setBusy(true);
    setNotice(null);
    try {
      await api.post(`/api/v1/learning/libraries/${entryKind}/${id}/${decision}`, {});
      setNotice(
        decision === "accept"
          ? "Accepted. The entry is now what this company prices and plans against, recorded against your name."
          : "Rejected. The sweep will not propose this key again.",
      );
      await load();
    } catch (err) {
      setNotice(errorMessage(err, "The decision was refused"));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !rates) return <Spinner label="Loading the libraries…" />;
  if (error) return <LoadError message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4">
      {/* ------------------------------ accuracy ------------------------------ */}
      {accuracy ? (
        <div>
          <SectionTitle hint={accuracy.basis}>Estimate accuracy — the company's own bias</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Rate bias (median)"
              value={
                <span className={biasTone(accuracy.rates.medianBias)}>
                  {biasLabel(accuracy.rates.medianBias)}
                </span>
              }
              hint={`${fmtInt(accuracy.rates.comparable)} comparable · ${fmtInt(
                accuracy.rates.notComparable,
              )} with no estimate`}
            />
            <Stat
              label="Rate bias (p80)"
              value={
                <span className={biasTone(accuracy.rates.p80Bias)}>
                  {biasLabel(accuracy.rates.p80Bias)}
                </span>
              }
              hint="Four in five elements came in below this"
            />
            <Stat
              label="Duration bias (median)"
              value={
                <span className={biasTone(accuracy.durations.medianBias)}>
                  {biasLabel(accuracy.durations.medianBias)}
                </span>
              }
              hint={`${fmtInt(accuracy.durations.comparable)} comparable · ${fmtInt(
                accuracy.durations.notComparable,
              )} with no plan`}
            />
            <Stat
              label="Optimistic share"
              value={
                accuracy.rates.optimisticShare === null
                  ? "—"
                  : `${Math.round(accuracy.rates.optimisticShare * 100)}%`
              }
              hint="Rate entries where outturn beat the estimate"
              tone={
                accuracy.rates.optimisticShare !== null && accuracy.rates.optimisticShare > 0.6
                  ? "bad"
                  : "default"
              }
            />
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <NoteCard note={accuracy.rates.reason} />
            <NoteCard note={accuracy.durations.reason} />
          </div>
        </div>
      ) : null}

      {/* ------------------------------ controls ------------------------------ */}
      <Card>
        <CardBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Library">
              <Select value={kind} onChange={(e) => setKind(e.target.value as LibraryKind)}>
                <option value="rates">Rates (per element)</option>
                <option value="durations">Durations (per activity)</option>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s || "all"} value={s}>
                    {s ? label(s) : "Any status"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Code contains">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={kind === "rates" ? "E10" : "A100"}
                maxLength={80}
              />
            </Field>
            <div className="flex items-end">
              {canAdmin ? (
                <Button onClick={() => void runRebuild()} disabled={busy}>
                  {busy ? "Rebuilding…" : "Rebuild from outturn"}
                </Button>
              ) : (
                <p className="text-xs text-ink-400">
                  Rebuilding and accepting are company-admin acts. You can read the library.
                </p>
              )}
            </div>
          </div>
          {notice ? <NoteCard note={notice} tone="brand" /> : null}
          {rebuild && rebuild.reasons.length > 0
            ? rebuild.reasons.map((r) => <NoteCard key={r} note={r} />)
            : null}
        </CardBody>
      </Card>

      {/* ------------------------------ the entries --------------------------- */}
      {kind === "rates" ? (
        <RateTable
          rows={rates?.items ?? []}
          canAdmin={canAdmin}
          busy={busy}
          onDecide={(id, d) => void decide("rates", id, d)}
        />
      ) : (
        <DurationTable
          rows={durations?.items ?? []}
          canAdmin={canAdmin}
          busy={busy}
          onDecide={(id, d) => void decide("durations", id, d)}
        />
      )}

      {/* --------------------------- risk realisation ------------------------- */}
      <div>
        <SectionTitle hint="A risk register is a set of predictions. These are the ones that came true, with what the register had said about them at the time.">
          Risk realisation — was the register calibrated?
        </SectionTitle>
        {(realisations?.stats.length ?? 0) === 0 ? (
          <EmptyState
            title="No risk has been recorded as realised"
            hint="Realisations are captured automatically when a register marks a risk realised, and by hand when the cost is known. Until then, nothing can be said about how well this company predicts."
          />
        ) : (
          <div className="space-y-2">
            {realisations!.stats.map((stat) => (
              <Card key={stat.category}>
                <CardBody className="space-y-2">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="text-sm font-semibold text-ink-900">
                      {label(stat.category)}
                    </span>
                    <span className="text-xs text-ink-500">
                      {fmtInt(stat.realised)} realised
                    </span>
                    <span className="text-xs text-ink-500">
                      mean predicted probability{" "}
                      <span className="font-semibold tabular-nums text-ink-800">
                        {stat.meanPredictedProbability === null
                          ? "—"
                          : fmtNum(stat.meanPredictedProbability, 2)}
                      </span>
                    </span>
                  </div>
                  <p className="text-xs text-ink-600">{stat.reason}</p>
                  {stat.impactByCurrency.length > 0 ? (
                    <ul className="flex flex-wrap gap-3 text-xs">
                      {stat.impactByCurrency.map((c) => (
                        <li key={c.currency} className="rounded bg-ink-50 px-2 py-1 ring-1 ring-ink-100">
                          <span className="font-mono text-[11px] text-ink-500">{c.currency}</span>{" "}
                          median realised{" "}
                          <span className="font-semibold tabular-nums text-ink-900">
                            {fmtNum(c.medianRealised, 0)}
                          </span>{" "}
                          vs predicted{" "}
                          <span className="font-semibold tabular-nums text-ink-900">
                            {c.medianPredicted === null ? "—" : fmtNum(c.medianPredicted, 0)}
                          </span>{" "}
                          <span className={biasTone(c.bias)}>{biasLabel(c.bias)}</span>
                          <span className="ml-1 text-ink-400">n={c.n}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-ink-400">
                      No realised impact has been recorded for this category, so the size of what
                      happened is not available — only that it happened.
                    </p>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function Decisions({
  status,
  canAdmin,
  busy,
  onDecide,
}: {
  status: string;
  canAdmin: boolean;
  busy: boolean;
  onDecide: (decision: "accept" | "reject") => void;
}) {
  if (status !== "proposed") {
    return <span className="text-xs text-ink-400">{label(status)}</span>;
  }
  if (!canAdmin) return <span className="text-xs text-ink-400">awaiting a company admin</span>;
  return (
    <span className="flex gap-1">
      <Button size="sm" disabled={busy} onClick={() => onDecide("accept")}>
        Accept
      </Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide("reject")}>
        Reject
      </Button>
    </span>
  );
}

function EntryShell({
  code,
  description,
  status,
  sampleSize,
  projects,
  computedAt,
  note,
  children,
  actions,
}: {
  code: string;
  description: string | null;
  status: string;
  sampleSize: number;
  projects: string[];
  computedAt: string;
  note: string | null;
  children: ReactNode;
  actions: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-ink-100 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <button
          type="button"
          className="min-w-56 flex-1 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="font-mono text-xs font-semibold text-ink-900">{code}</span>{" "}
          <Badge tone={libraryStatusTone(status)}>{label(status)}</Badge>
          <span className="ml-2 text-xs text-ink-500">{description ?? "no description"}</span>
        </button>
        {children}
        <span className="w-24 text-xs text-ink-500">
          n={fmtInt(sampleSize)}
          <span className="ml-1 text-ink-400">/{projects.length} proj.</span>
        </span>
        <span className="w-40 text-right">{actions}</span>
      </div>
      {open ? (
        <div className="space-y-1 bg-ink-50 px-3 py-2 text-xs text-ink-600">
          {note ? <p className="whitespace-pre-wrap">{note}</p> : null}
          <p className="text-ink-400">
            Computed {formatDate(computedAt)} from {projects.length} project
            {projects.length === 1 ? "" : "s"}.
          </p>
        </div>
      ) : null}
    </li>
  );
}

function RateTable({
  rows,
  canAdmin,
  busy,
  onDecide,
}: {
  rows: RateLibraryEntry[];
  canAdmin: boolean;
  busy: boolean;
  onDecide: (id: string, decision: "accept" | "reject") => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No rate entries for this filter"
        hint="Rates are computed from CERTIFIED valuation lines only — what was priced is not outturn. If nothing appears, either no valuation has been certified or the rebuild has not run."
      />
    );
  }
  return (
    <Card>
      <ul>
        {rows.map((row) => (
          <EntryShell
            key={row.id}
            code={`${row.elementCode} / ${row.unit} / ${row.currency}`}
            description={row.description}
            status={row.status}
            sampleSize={row.sampleSize}
            projects={row.sourceProjectIds}
            computedAt={row.computedAt}
            note={row.note}
            actions={
              <Decisions
                status={row.status}
                canAdmin={canAdmin}
                busy={busy}
                onDecide={(d) => onDecide(row.id, d)}
              />
            }
          >
            <span className="w-28">
              <span className="block text-[11px] uppercase tracking-wide text-ink-400">median</span>
              <span className="text-sm font-semibold tabular-nums text-ink-900">
                {fmtNum(row.medianRate, 2)}
              </span>
            </span>
            <span className="w-24">
              <span className="block text-[11px] uppercase tracking-wide text-ink-400">p80</span>
              <span className="text-sm tabular-nums text-ink-700">{fmtNum(row.p80Rate, 2)}</span>
            </span>
            <span className="w-28">
              <span className="block text-[11px] uppercase tracking-wide text-ink-400">priced</span>
              <span className="text-sm tabular-nums text-ink-700">
                {row.estimatedRate === null ? "—" : fmtNum(row.estimatedRate, 2)}
              </span>
            </span>
            <span className="w-24">
              <span className="block text-[11px] uppercase tracking-wide text-ink-400">bias</span>
              <span className={`text-sm font-semibold tabular-nums ${biasTone(row.accuracyRatio)}`}>
                {biasLabel(row.accuracyRatio)}
              </span>
            </span>
          </EntryShell>
        ))}
      </ul>
    </Card>
  );
}

function DurationTable({
  rows,
  canAdmin,
  busy,
  onDecide,
}: {
  rows: DurationLibraryEntry[];
  canAdmin: boolean;
  busy: boolean;
  onDecide: (id: string, decision: "accept" | "reject") => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No duration entries for this filter"
        hint="Durations come from activities with BOTH an actual start and an actual finish. A task still running has not taken any time yet, and counting it would teach the library that everything finishes early."
      />
    );
  }
  return (
    <Card>
      <ul>
        {rows.map((row) => (
          <EntryShell
            key={row.id}
            code={row.activityCode}
            description={row.description}
            status={row.status}
            sampleSize={row.sampleSize}
            projects={row.sourceProjectIds}
            computedAt={row.computedAt}
            note={row.note}
            actions={
              <Decisions
                status={row.status}
                canAdmin={canAdmin}
                busy={busy}
                onDecide={(d) => onDecide(row.id, d)}
              />
            }
          >
            <span className="w-28">
              <span className="block text-[11px] uppercase tracking-wide text-ink-400">
                median days
              </span>
              <span className="text-sm font-semibold tabular-nums text-ink-900">
                {fmtNum(row.medianDays, 1)}
              </span>
            </span>
            <span className="w-24">
              <span className="block text-[11px] uppercase tracking-wide text-ink-400">p80</span>
              <span className="text-sm tabular-nums text-ink-700">{fmtNum(row.p80Days, 1)}</span>
            </span>
            <span className="w-28">
              <span className="block text-[11px] uppercase tracking-wide text-ink-400">planned</span>
              <span className="text-sm tabular-nums text-ink-700">
                {row.plannedDays === null ? "—" : fmtNum(row.plannedDays, 1)}
              </span>
            </span>
            <span className="w-24">
              <span className="block text-[11px] uppercase tracking-wide text-ink-400">bias</span>
              <span className={`text-sm font-semibold tabular-nums ${biasTone(row.accuracyRatio)}`}>
                {biasLabel(row.accuracyRatio)}
              </span>
            </span>
          </EntryShell>
        ))}
      </ul>
    </Card>
  );
}
