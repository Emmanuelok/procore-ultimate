/**
 * CONTRACT CLAUSE AND PROCUREMENT ROUTE PERFORMANCE (#987-988).
 *
 * The company already knows which clause it keeps arguing about — one war
 * story at a time, in the heads of the people who were there. Every dispute,
 * forensic claim, variation and materialised obligation already carries the
 * clause it came from, so this tab reads them back across every project the
 * caller can open and puts an `n` beside the anecdote.
 *
 * The presentation rules are the workspace's, applied to money:
 *   · amounts are listed PER CURRENCY and never added together, because one
 *     confident wrong total is worse than three honest figures;
 *   · a ratio the records cannot support shows "—" with the server's reason,
 *     never 0% (a clause where nobody recorded what was awarded is unknown,
 *     not a total loss);
 *   · a route with too few projects is shown WITH its counts and flagged as
 *     indicative, rather than hidden — hiding it would make the register look
 *     complete when it is thin.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Card, CardBody, EmptyState, Field, Select, Spinner } from "../../ui";
import {
  LoadError,
  NoteCard,
  SectionTitle,
  errorMessage,
  moneyBuckets,
  ratioPercent,
  type ClausePerformanceResponse,
  type ClauseRow,
  type ProcurementRouteResponse,
  type RouteRow,
} from "./learningShared";

function Reasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-600">
      {reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map);
  if (entries.length === 0) return "—";
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}

function ClauseCard({ row }: { row: ClauseRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-ink-100 first:border-t-0">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left hover:bg-ink-50"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="min-w-28 font-mono text-sm font-semibold text-ink-900">{row.clause}</span>
        <Badge tone={row.contractFamily === "unrecorded" ? "gray" : "blue"}>
          {row.contractFamily}
        </Badge>
        <span className="w-28 text-xs text-ink-600">
          <span className="block text-[11px] uppercase tracking-wide text-ink-400">Disputes</span>
          <span className="tabular-nums">
            {row.disputes} <span className="text-ink-400">({row.disputesResolved} resolved)</span>
          </span>
        </span>
        <span className="w-24 text-xs text-ink-600">
          <span className="block text-[11px] uppercase tracking-wide text-ink-400">Projects</span>
          <span className="tabular-nums">{row.projects}</span>
        </span>
        <span className="w-28 text-xs text-ink-600">
          <span className="block text-[11px] uppercase tracking-wide text-ink-400">Recovery</span>
          <span className="tabular-nums">{ratioPercent(row.recoveryRatio)}</span>
        </span>
        <span className="w-28 text-xs text-ink-600">
          <span className="block text-[11px] uppercase tracking-wide text-ink-400">
            Obligation breach
          </span>
          <span className="tabular-nums">{ratioPercent(row.breachRate)}</span>
        </span>
        <span className="min-w-40 flex-1 text-xs text-ink-500">{row.basis}</span>
      </button>
      {open ? (
        <div className="grid gap-3 bg-ink-50 px-3 py-3 text-xs sm:grid-cols-2">
          <div>
            <p className="font-semibold text-ink-700">Claimed</p>
            <p className="text-ink-600">{moneyBuckets(row.amountClaimed)}</p>
            <p className="mt-2 font-semibold text-ink-700">Awarded / assessed</p>
            <p className="text-ink-600">{moneyBuckets(row.amountAwarded)}</p>
            <p className="mt-1 text-ink-400">
              {row.recoveryObservations === 0
                ? "No dispute on this clause records both a claimed and an awarded figure."
                : `Recovery computed over ${row.recoveryObservations} dispute(s) where both figures exist.`}
            </p>
          </div>
          <div>
            <p className="font-semibold text-ink-700">Variations under this clause</p>
            <p className="text-ink-600">
              {row.variations} · {moneyBuckets(row.variationValue)} ·{" "}
              {row.variationTimeImpactDays === null
                ? "no time impact recorded"
                : `${row.variationTimeImpactDays} day(s) mean time impact`}
            </p>
            <p className="mt-2 font-semibold text-ink-700">Obligations</p>
            <p className="text-ink-600">
              {row.obligations} materialised, {row.obligationsBreached} breached
            </p>
            <p className="mt-2 font-semibold text-ink-700">Forensic claims</p>
            <p className="text-ink-600">{row.forensicClaims}</p>
          </div>
          <div>
            <p className="font-semibold text-ink-700">Outcomes</p>
            <p className="font-mono text-[11px] text-ink-600">{counts(row.disputeOutcomes)}</p>
            <p className="mt-2 font-semibold text-ink-700">Root causes</p>
            <p className="font-mono text-[11px] text-ink-600">{counts(row.disputeRootCauses)}</p>
          </div>
          <div>
            <p className="font-semibold text-ink-700">Read this carefully</p>
            <Reasons reasons={row.reasons} />
          </div>
        </div>
      ) : null}
    </li>
  );
}

function RouteCard({ row }: { row: RouteRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-ink-100 first:border-t-0">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left hover:bg-ink-50"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="min-w-44 text-sm font-medium text-ink-900">{row.route}</span>
        {row.reliable ? null : <Badge tone="amber">indicative</Badge>}
        <span className="w-24 text-xs text-ink-600">
          <span className="block text-[11px] uppercase tracking-wide text-ink-400">Projects</span>
          <span className="tabular-nums">{row.projects}</span>
        </span>
        <span className="w-32 text-xs text-ink-600">
          <span className="block text-[11px] uppercase tracking-wide text-ink-400">
            Outturn variance
          </span>
          <span className="tabular-nums">
            {row.outturnVariancePercent === null ? "—" : `${row.outturnVariancePercent}%`}
          </span>
        </span>
        <span className="w-28 text-xs text-ink-600">
          <span className="block text-[11px] uppercase tracking-wide text-ink-400">
            Variations / project
          </span>
          <span className="tabular-nums">{row.variationsPerProject ?? "—"}</span>
        </span>
        <span className="w-28 text-xs text-ink-600">
          <span className="block text-[11px] uppercase tracking-wide text-ink-400">
            Dispute rate
          </span>
          <span className="tabular-nums">{ratioPercent(row.disputeRate)}</span>
        </span>
      </button>
      {open ? (
        <div className="grid gap-3 bg-ink-50 px-3 py-3 text-xs sm:grid-cols-2">
          <div>
            <p className="font-semibold text-ink-700">Contract sums</p>
            <p className="text-ink-600">{moneyBuckets(row.contractSum)}</p>
            <p className="mt-2 font-semibold text-ink-700">Agreed variation value</p>
            <p className="text-ink-600">{moneyBuckets(row.agreedVariationValue)}</p>
            <p className="mt-1 text-ink-400">
              Variance is the mean of each project&rsquo;s own ratio, so no figure crosses a
              currency ({row.outturnObservations} of {row.projects} project(s) qualified).
            </p>
          </div>
          <div>
            <p className="font-semibold text-ink-700">Disputes</p>
            <p className="text-ink-600">
              {row.disputes} on {row.disputedProjects} of {row.projects} project(s)
            </p>
            <p className="mt-2 font-semibold text-ink-700">Basis</p>
            <p className="text-ink-600">{row.basis}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="font-semibold text-ink-700">Read this carefully</p>
            <Reasons reasons={row.reasons} />
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default function ContractsTab() {
  const [clauses, setClauses] = useState<ClausePerformanceResponse | null>(null);
  const [routes, setRoutes] = useState<ProcurementRouteResponse | null>(null);
  const [clauseError, setClauseError] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [family, setFamily] = useState("");
  const [minDisputes, setMinDisputes] = useState("0");

  /* Each panel fails alone: a broken clause query must not blank the routes. */
  const loadClauses = useCallback(async () => {
    setClauseError(null);
    try {
      const params = new URLSearchParams({ minDisputes, limit: "100" });
      if (family) params.set("contractFamily", family);
      setClauses(
        await api.get<ClausePerformanceResponse>(
          `/api/v1/learning/clause-performance?${params.toString()}`,
        ),
      );
    } catch (err) {
      setClauses(null);
      setClauseError(errorMessage(err, "Failed to load clause performance"));
    }
  }, [family, minDisputes]);

  const loadRoutes = useCallback(async () => {
    setRouteError(null);
    try {
      setRoutes(
        await api.get<ProcurementRouteResponse>("/api/v1/learning/procurement-routes"),
      );
    } catch (err) {
      setRoutes(null);
      setRouteError(errorMessage(err, "Failed to load procurement route performance"));
    }
  }, []);

  useEffect(() => {
    void loadClauses();
  }, [loadClauses]);
  useEffect(() => {
    void loadRoutes();
  }, [loadRoutes]);

  const families = clauses
    ? [...new Set(clauses.items.map((i) => i.contractFamily))].sort()
    : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SectionTitle hint="Read from the clause references already on disputes, forensic claims, variations and obligations. Frequency is not fault — a clause that appears often may be the clause under which claims are correctly notified.">
              Clause performance
            </SectionTitle>
            <div className="flex items-end gap-2">
              <div className="min-w-44">
                <Field label="Contract form">
                  <Select value={family} onChange={(e) => setFamily(e.target.value)}>
                    <option value="">Any form</option>
                    {families.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="min-w-40">
                <Field label="Minimum disputes">
                  <Select value={minDisputes} onChange={(e) => setMinDisputes(e.target.value)}>
                    <option value="0">Any</option>
                    <option value="1">1 or more</option>
                    <option value="2">2 or more</option>
                    <option value="5">5 or more</option>
                  </Select>
                </Field>
              </div>
            </div>
          </div>

          {clauseError ? (
            <LoadError message={clauseError} onRetry={() => void loadClauses()} />
          ) : !clauses ? (
            <Spinner label="Reading the clause history…" />
          ) : (
            <>
              {clauses.scope === "restricted" ? (
                <NoteCard
                  tone="amber"
                  title="Restricted view"
                  note={
                    "This is assembled only from the projects you can open. A clause's record " +
                    "elsewhere in the company is not counted here, and its absence is not evidence."
                  }
                />
              ) : null}
              {clauses.truncated ? (
                <NoteCard
                  tone="amber"
                  title="Built from a sample"
                  note="At least one source hit the scan limit, so this report is a sample of the register rather than the whole of it."
                />
              ) : null}
              {clauses.items.length === 0 ? (
                <EmptyState
                  title="No clause history to read"
                  hint={
                    clauses.reasons[0] ??
                    "No dispute, claim, variation or obligation in the projects you can open carries a clause reference."
                  }
                />
              ) : (
                <ul className="rounded-lg border border-ink-100">
                  {clauses.items.map((row) => (
                    <ClauseCard key={row.key} row={row} />
                  ))}
                </ul>
              )}
              <div className="text-xs text-ink-500">
                <p className="font-semibold text-ink-600">Records with no clause reference</p>
                <p>
                  {clauses.unattributed.disputes} dispute(s),{" "}
                  {clauses.unattributed.forensicClaims} forensic claim(s),{" "}
                  {clauses.unattributed.variations} variation(s),{" "}
                  {clauses.unattributed.obligations} obligation(s) could not be attributed to a
                  clause. That is a gap in what was recorded, not evidence those clauses caused
                  nothing.
                </p>
              </div>
              <Reasons reasons={clauses.reasons} />
              <p className="text-xs text-ink-400">As at {clauses.asOf}.</p>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <SectionTitle hint="The route is read from the opportunity each project was won through; the contract sum and currency come from the project's largest contract.">
            Procurement route performance
          </SectionTitle>
          {routeError ? (
            <LoadError message={routeError} onRetry={() => void loadRoutes()} />
          ) : !routes ? (
            <Spinner label="Comparing routes…" />
          ) : routes.items.length === 0 ? (
            <EmptyState
              title="No route to compare"
              hint={routes.reasons[0] ?? "No live project is visible to you."}
            />
          ) : (
            <>
              <ul className="rounded-lg border border-ink-100">
                {routes.items.map((row) => (
                  <RouteCard key={row.route} row={row} />
                ))}
              </ul>
              {routes.sources ? (
                <div className="text-xs text-ink-500">
                  <p className="font-semibold text-ink-600">What each figure is read from</p>
                  <ul className="list-disc pl-4">
                    {routes.sources.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <Reasons reasons={routes.reasons} />
              <p className="text-xs text-ink-400">
                A route is called indicative below {routes.minProjects} projects. As at{" "}
                {routes.asOf}.
              </p>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
