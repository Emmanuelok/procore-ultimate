/**
 * Ghost-worker elimination (#669) and wage verification (#677): payroll days
 * claimed by the employer set against the independent site-access record, for
 * one period, with the money at risk stated in cash.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import ClaimVsEvidenceChart from "./ClaimVsEvidenceChart";
import {
  BRAND,
  BRAND_PALE,
  LoadError,
  RED,
  Stat,
  addDays,
  classificationTone,
  fmtMoney,
  fmtNum,
  isoToday,
  label,
  type ReconRow,
  type ReconSummary,
} from "./workforceShared";

/** First and last calendar day of the month before `iso`. */
function lastCalendarMonth(iso: string): { from: string; to: string } {
  const [y, m] = iso.split("-").map(Number) as [number, number, number];
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const mm = String(month).padStart(2, "0");
  // day 0 of the following month is the last day of this one
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, "0")}` };
}

export default function ReconcileTab({
  projectId,
  onMutate,
}: {
  projectId: string;
  onMutate: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const today = isoToday();
  const [periodStart, setPeriodStart] = useState(addDays(today, -30));
  const [periodEnd, setPeriodEnd] = useState(today);
  const [summary, setSummary] = useState<ReconSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useCallback(
    async (from: string, to: string) => {
      setError(null);
      setSummary(null);
      try {
        setSummary(
          await api.get<ReconSummary>(
            `${base}/workforce/reconciliations?from=${from}&to=${to}`,
          ),
        );
      } catch (err) {
        setSummary(null);
        setError(err instanceof Error ? err.message : "Failed to run the reconciliation");
      }
    },
    [base],
  );

  useEffect(() => {
    void preview(addDays(isoToday(), -30), isoToday());
  }, [preview]);

  async function onPreview() {
    setNotice(null);
    setBusy(true);
    await preview(periodStart, periodEnd);
    setBusy(false);
  }

  async function onCommit() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await api.post<ReconSummary>(`${base}/workforce/reconcile`, {
        periodStart,
        periodEnd,
      });
      setSummary(res);
      setNotice(
        res.signalsRaised === 0
          ? "Reconciliation re-run — every finding in this period was already on the signal register."
          : `Reconciliation committed — ${res.signalsRaised} signal${
              res.signalsRaised === 1 ? "" : "s"
            } raised for review.`,
      );
      onMutate();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Failed to commit the reconciliation.",
      );
    } finally {
      setBusy(false);
    }
  }

  const currency = summary?.rows[0]?.currency ?? "USD";
  const findings = summary ? summary.ghosts + summary.overclaims + summary.underpayments : 0;
  // one shared scale so the row bars are comparable down the whole table
  const maxDays = Math.max(
    1,
    ...(summary?.rows ?? []).map((r) => Math.max(r.daysClaimed, r.accessDays)),
  );

  return (
    <div>
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 py-3">
          <div className="w-44">
            <Field label="Period start">
              <Input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </Field>
          </div>
          <div className="w-44">
            <Field label="Period end">
              <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </Field>
          </div>
          <div className="flex items-center gap-2 pb-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="Set the period to the whole of last calendar month — the usual payroll cycle"
              onClick={() => {
                const { from, to } = lastCalendarMonth(isoToday());
                setPeriodStart(from);
                setPeriodEnd(to);
                setNotice(null);
                setBusy(true);
                void preview(from, to).finally(() => setBusy(false));
              }}
            >
              Last month
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                const to = isoToday();
                const from = addDays(to, -30);
                setPeriodStart(from);
                setPeriodEnd(to);
                setNotice(null);
                setBusy(true);
                void preview(from, to).finally(() => setBusy(false));
              }}
            >
              Last 30 days
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void onPreview()}>
              Preview
            </Button>
            <Button disabled={busy} onClick={() => void onCommit()}>
              {busy ? "Working…" : "Run & raise signals"}
            </Button>
          </div>
          <p className="pb-2 text-xs text-ink-400">
            Preview recomputes without writing. Running commits the findings to the signal
            register — re-running the same period never duplicates them.
          </p>
        </CardBody>
      </Card>

      <Card className="mb-4 ring-1 ring-brand-100">
        <CardBody className="py-3">
          <h3 className="text-sm font-semibold text-ink-900">
            What this reconciliation actually compares
          </h3>
          <p className="mt-1 max-w-4xl text-xs leading-relaxed text-ink-600">
            Two independent records of the same period are set against each other:{" "}
            <strong className="font-semibold text-ink-800">
              the days the employer claimed on payroll
            </strong>{" "}
            and{" "}
            <strong className="font-semibold text-ink-800">
              the distinct days that worker appears in the site-access record
            </strong>{" "}
            — turnstile, biometric or gate log, ingested separately from the payroll file. Where
            pay is claimed and no access record exists at all, that is a{" "}
            <strong className="font-semibold text-red-700">ghost worker</strong>. Where claimed
            days run more than 1.15× the evidenced days, that is an{" "}
            <strong className="font-semibold text-amber-700">overclaim</strong>. Separately, gross
            pay divided by days claimed is set against the worker&rsquo;s agreed daily rate: below
            95% of it, the worker is{" "}
            <strong className="font-semibold text-amber-700">underpaid</strong> — a finding{" "}
            <em>for</em> the worker, not against them.
          </p>
          <p className="mt-1.5 max-w-4xl text-xs leading-relaxed text-ink-500">
            Every finding is raised as an integrity <strong>signal</strong> on the project&rsquo;s
            signal register — the same spine as every other detection on this platform — where it
            is reviewed and dispositioned by someone other than the person who ran it. Nothing is
            deducted, withheld or accused automatically: the reconciliation states a discrepancy
            between two records and names it.
          </p>
        </CardBody>
      </Card>

      <ErrorAlert message={error} />
      {notice ? (
        <div className="mb-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800 ring-1 ring-brand-100">
          {notice}
        </div>
      ) : null}

      {summary === null && error ? (
        <LoadError message={error} onRetry={() => void preview(periodStart, periodEnd)} />
      ) : summary === null ? (
        <Spinner label="Reconciling payroll against site access…" />
      ) : summary.workers === 0 ? (
        <EmptyState
          title="No payroll in this period"
          hint="Ingest payroll entries and site-access records for the period, then reconcile. Nothing is inferred from an empty period."
        />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Workers paid" value={summary.workers} />
            <Stat
              label="Ghost workers"
              value={summary.ghosts}
              tone={summary.ghosts > 0 ? "red" : "green"}
              hint="Paid, never on site"
            />
            <Stat
              label="Overclaims"
              value={summary.overclaims}
              tone={summary.overclaims > 0 ? "amber" : "green"}
              hint="Beyond the 1.15× band"
            />
            <Stat
              label="Underpayments"
              value={summary.underpayments}
              tone={summary.underpayments > 0 ? "amber" : "green"}
              hint="Below 95% of the agreed rate"
            />
            <Stat
              label="Unmatched days"
              value={fmtNum(summary.totals.unmatchedDays, 1)}
              hint={`of ${fmtNum(summary.totals.daysClaimed, 1)} claimed`}
            />
            <Stat
              label="Value at risk"
              value={fmtMoney(summary.totals.valueAtRisk, currency)}
              tone={summary.totals.valueAtRisk > 0 ? "red" : "green"}
              emphasized
              hint={
                summary.totals.wageShortfall > 0
                  ? `+ ${fmtMoney(summary.totals.wageShortfall, currency)} owed to workers`
                  : undefined
              }
            />
          </div>

          <Card className="mb-4">
            <CardBody>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink-900">
                  Days claimed against days evidenced
                </h3>
                <span className="text-xs text-ink-400">
                  {summary.periodStart} → {summary.periodEnd}
                  {summary.persisted === false ? " · preview, nothing written" : ""}
                </span>
              </div>
              <ClaimVsEvidenceChart rows={summary.rows} />
            </CardBody>
          </Card>

          <Table>
            <thead>
              <tr>
                <Th>Worker</Th>
                <Th className="text-right">Claimed</Th>
                <Th className="text-right">Evidenced</Th>
                <Th>Claim vs evidence</Th>
                <Th className="text-right">Unmatched</Th>
                <Th className="text-right">Implied vs agreed rate</Th>
                <Th className="text-right">Gross</Th>
                <Th className="text-right">At risk</Th>
                <Th>Finding</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {summary.rows.map((r) => (
                <tr key={r.workerId} className={r.classification === "ok" ? undefined : "bg-ink-50/60"}>
                  <Td>
                    <span className="font-mono text-xs text-ink-500">{r.reference}</span>{" "}
                    <span className="text-ink-900">{r.fullName}</span>
                  </Td>
                  <Td className="text-right tabular-nums">{fmtNum(r.daysClaimed, 1)}</Td>
                  <Td className="text-right tabular-nums">{r.accessDays}</Td>
                  <Td>
                    <ClaimBar row={r} maxDays={maxDays} />
                  </Td>
                  <Td className="text-right tabular-nums">
                    {r.unmatchedDays > 0 ? (
                      <span className="font-semibold text-red-700">
                        {fmtNum(r.unmatchedDays, 1)}
                      </span>
                    ) : (
                      <span className="text-ink-300">0</span>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">
                    <div
                      className={
                        r.classification === "underpaid"
                          ? "font-semibold text-amber-700"
                          : "text-ink-800"
                      }
                    >
                      {r.impliedDailyRate === null ? "—" : fmtMoney(r.impliedDailyRate, r.currency)}
                    </div>
                    <div className="text-[11px] text-ink-400">
                      {r.agreedDailyRate === null ? (
                        <span title="No agreed rate on file — the wage check abstains for this worker">
                          no agreed rate
                        </span>
                      ) : (
                        <>agreed {fmtMoney(r.agreedDailyRate, r.currency)}</>
                      )}
                    </div>
                  </Td>
                  <Td className="text-right tabular-nums text-ink-700">
                    {fmtMoney(r.grossPay, r.currency)}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {r.valueAtRisk > 0 ? (
                      <span className="font-semibold text-red-700">
                        {fmtMoney(r.valueAtRisk, r.currency)}
                      </span>
                    ) : r.wageShortfall > 0 ? (
                      <span
                        className="font-medium text-amber-700"
                        title="Owed to the worker, not lost to the project"
                      >
                        −{fmtMoney(r.wageShortfall, r.currency)}
                      </span>
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </Td>
                  <Td>
                    <span title={r.reason}>
                      <Badge tone={classificationTone(r.classification)}>
                        {label(r.classification)}
                      </Badge>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-ink-400">
            {findings === 0
              ? "Every worker paid in this period is inside tolerance."
              : `${findings} finding${findings === 1 ? "" : "s"} — hover a finding badge for the full reasoning.`}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Row-level mini bar: days CLAIMED above days EVIDENCED, on one scale shared
 * by the whole table. The claimed bar's unevidenced tail is red because that
 * segment is precisely the attendance no independent record supports.
 */
function ClaimBar({ row, maxDays }: { row: ReconRow; maxDays: number }) {
  const W = 120;
  const H = 22;
  const BAR_H = 7;
  const w = (days: number) => (Math.min(days, maxDays) / maxDays) * W;
  const matched = Math.min(row.daysClaimed, row.accessDays);
  const matchedW = w(matched);
  const unmatchedW = Math.max(0, w(row.daysClaimed) - matchedW);
  const evidencedW = w(row.accessDays);
  const ratio = row.claimRatio === null ? "no evidenced day" : `${fmtNum(row.claimRatio, 2)}×`;
  const tip =
    `${fmtNum(row.daysClaimed, 1)} day(s) claimed against ${row.accessDays} evidenced — ` +
    `${ratio} the evidenced attendance. ${row.reason}`;

  return (
    <div className="flex items-center gap-2">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Claimed ${fmtNum(row.daysClaimed, 1)} days against ${row.accessDays} evidenced days`}
        className="shrink-0"
      >
        <title>{tip}</title>
        <rect x={0} y={2} width={W} height={BAR_H} fill="#f6f7f9" rx={1.5} />
        <rect
          x={0}
          y={2}
          width={Math.max(matchedW, row.daysClaimed > 0 ? 1 : 0)}
          height={BAR_H}
          fill={BRAND}
          rx={1.5}
        />
        {unmatchedW > 0 ? (
          <rect x={matchedW} y={2} width={unmatchedW} height={BAR_H} fill={RED} rx={1.5} />
        ) : null}
        <rect x={0} y={2 + BAR_H + 2} width={W} height={BAR_H} fill="#f6f7f9" rx={1.5} />
        <rect
          x={0}
          y={2 + BAR_H + 2}
          width={Math.max(evidencedW, row.accessDays > 0 ? 1 : 0)}
          height={BAR_H}
          fill={BRAND_PALE}
          rx={1.5}
        />
      </svg>
      <span
        className={
          row.claimRatio === null
            ? "text-[11px] font-semibold tabular-nums text-red-700"
            : row.claimRatio > 1.15
              ? "text-[11px] font-semibold tabular-nums text-amber-700"
              : "text-[11px] tabular-nums text-ink-400"
        }
      >
        {row.claimRatio === null ? "∞" : `${fmtNum(row.claimRatio, 2)}×`}
      </span>
    </div>
  );
}
