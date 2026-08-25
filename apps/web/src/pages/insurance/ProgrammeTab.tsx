/**
 * Programme (#795-796) — the same picture, company-wide.
 *
 * Every money figure here is grouped per currency and never summed across
 * them: a GBP 10m layer and a USD 10m layer are not GBP 20m of cover. Three
 * disclosures the API returns are printed verbatim rather than designed away:
 *
 *  · `cover.note` — when the requirement set is unknown, there is no gap count;
 *  · `bonds.headroomNote` — no bonding line limit exists anywhere in the data,
 *    so utilisation is shown without a denominator and no bar implies one;
 *  · `byType[].limitNote` — when a total is a floor rather than the programme
 *    limit, the row says so next to the number.
 */
import { useCallback, useEffect, useState } from "react";
import { INSURANCE_CLAIM_STATUSES } from "@constructos/shared";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, ErrorAlert, Spinner, Table, Td, Th } from "../../ui";
import { formatDate } from "../format";
import {
  CHART,
  CLAIM_STATUS_LABELS,
  COVER_GAP_REASON_LABELS,
  DETECTOR_LABELS,
  Disclosure,
  SectionTitle,
  StatCard,
  VENDOR_SOURCE_LABELS,
  bondTypeLabel,
  errMsg,
  fmtMoney,
  fmtNum,
  fmtPct,
  policyTypeLabel,
  type ExpiryReport,
  type InsuranceSummary,
} from "./insuranceShared";

export default function ProgrammeTab() {
  const [summary, setSummary] = useState<InsuranceSummary | null>(null);
  const [radar, setRadar] = useState<ExpiryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [radarError, setRadarError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSummary(await api.get<InsuranceSummary>("/api/v1/insurance/summary"));
    } catch (err) {
      setSummary(null);
      setError(errMsg(err, "Failed to load the company programme summary"));
    }
    setRadarError(null);
    try {
      setRadar(await api.get<ExpiryReport>("/api/v1/insurance/expiring?days=30"));
    } catch (err) {
      setRadar(null);
      setRadarError(errMsg(err, "Failed to load the company expiry radar"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !summary) {
    return (
      <div>
        <ErrorAlert message={error} />
        <Button variant="secondary" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!summary) return <Spinner label="Reading the company programme…" />;

  const gapsUnknown = !summary.cover.requirementsKnown;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-ink-500">
          Company-level view across every project. As of {formatDate(summary.asOf)}.
        </p>
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {/* -------------------------------- headline -------------------------------- */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Policies"
          value={summary.policies.total}
          hint={`${summary.policies.inForce} in force · ${summary.policies.companyLevel} company-level`}
        />
        <StatCard
          label="Expiring in 30d"
          value={summary.policies.expiringSoon}
          tone={summary.policies.expiringSoon > 0 ? "amber" : undefined}
        />
        <StatCard
          label="Certificates in date"
          value={`${summary.certificates.inDate}/${summary.certificates.total}`}
          hint={`${summary.certificates.verified} verified`}
          tone={
            summary.certificates.total > 0 && summary.certificates.verified === 0
              ? "amber"
              : undefined
          }
        />
        <StatCard
          label="Bonds outstanding"
          value={summary.bonds.outstanding}
          hint={`${summary.bonds.called} called · ${summary.bonds.released} released`}
        />
        <StatCard
          label="Past demand deadline"
          value={summary.bonds.pastDemandDeadline}
          tone={summary.bonds.pastDemandDeadline > 0 ? "red" : undefined}
          hint="Security that can no longer be called"
        />
        <StatCard
          label="Radar actionable"
          value={radar ? radar.actionableCount : "—"}
          tone={
            radar && radar.actionableCount > 0
              ? "red"
              : radar && !radar.coverRequirementsKnown
                ? "amber"
                : undefined
          }
          hint={
            radar && !radar.coverRequirementsKnown
              ? "Company-wide, 30-day window — cover gaps are not part of this count because they were not computed"
              : "Company-wide, 30-day window"
          }
        />
      </div>
      <ErrorAlert message={radarError} />

      {/* ------------------------------ cover by type ------------------------------ */}
      <SectionTitle
        hint="Policies the company carries, and certificates collected from others, by type."
      >
        Cover across the estate
      </SectionTitle>

      {gapsUnknown ? (
        <div className="mb-3 rounded-lg border-l-4 border-l-amber-500 bg-amber-50 p-4 ring-1 ring-amber-200">
          <div className="text-sm font-semibold text-amber-900">
            The cover requirement set is unknown — no gap analysis has been run
          </div>
          <p className="mt-1 text-xs leading-relaxed text-amber-900">
            The "required" column below reads <strong>unknown</strong> rather than "no", and there
            is no gap count to report. {summary.cover.vendorsAtWork} vendor(s) are recorded as at
            work across the estate; none of them has been tested against anything.
          </p>
          {summary.cover.note ? (
            <div className="mt-2">
              <Disclosure label="cover.note — returned verbatim by the API" tone="amber">
                {summary.cover.note}
              </Disclosure>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mb-2 text-xs text-ink-500">
          Requirement set: {summary.cover.requiredTypes.map((t) => policyTypeLabel(t)).join(", ")} ·
          tested against {summary.cover.vendorsAtWork} vendor(s) at work ·{" "}
          {summary.cover.gaps.length} gap(s), {summary.cover.unverified.length} unverified.
        </p>
      )}

      {summary.cover.byType.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-ink-500">
            No policies or certificates of any type are recorded in this company.
          </CardBody>
        </Card>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Policy type</Th>
              <Th>Required</Th>
              <Th className="text-right">Policies</Th>
              <Th className="text-right">Certificates</Th>
              <Th>Total limits (per currency)</Th>
              <Th>Covered</Th>
              <Th className="text-right">Gaps</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {summary.cover.byType.map((row) => (
              <tr key={row.policyType}>
                <Td className="whitespace-nowrap font-medium">
                  {policyTypeLabel(row.policyType)}
                </Td>
                <Td className="whitespace-nowrap">
                  {gapsUnknown ? (
                    <span
                      className="text-xs font-medium text-amber-700"
                      title="No requirement set is recorded, so whether this type is required is unknown — not 'no'."
                    >
                      unknown
                    </span>
                  ) : row.required ? (
                    <Badge tone="blue">required</Badge>
                  ) : (
                    <span className="text-xs text-ink-400">not required</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-right tabular-nums">
                  {row.activePolicies} in force
                  <div className="text-[11px] text-ink-400">{row.policies} recorded</div>
                </Td>
                <Td className="whitespace-nowrap text-right tabular-nums">
                  {row.certificatesInDate} in date
                  <div className="text-[11px] text-ink-400">
                    {row.certificatesVerified} verified of {row.certificates}
                  </div>
                </Td>
                <Td>
                  {row.totalLimits.length === 0 ? (
                    <span className="text-xs text-ink-400">no limit recorded</span>
                  ) : (
                    <div className="space-y-0.5">
                      {row.totalLimits.map((l) => (
                        <div key={l.currency} className="tabular-nums">
                          {fmtMoney(l.total, l.currency, 0)}
                        </div>
                      ))}
                    </div>
                  )}
                  {row.policiesWithoutLimit > 0 ? (
                    <div className="mt-0.5 text-[11px] font-medium text-amber-700">
                      {row.policiesWithoutLimit} in-force polic
                      {row.policiesWithoutLimit === 1 ? "y" : "ies"} record no limit
                    </div>
                  ) : null}
                  {row.limitNote ? (
                    <div className="mt-1 max-w-xs text-[11px] leading-relaxed text-amber-800">
                      <span className="font-semibold uppercase tracking-wide opacity-70">
                        limitNote:
                      </span>{" "}
                      {row.limitNote}
                    </div>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap">
                  {row.covered ? (
                    <Badge tone="green">yes</Badge>
                  ) : (
                    <Badge tone="red">nothing in force</Badge>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-right">
                  {gapsUnknown ? (
                    <span className="text-xs text-amber-700">unknown</span>
                  ) : row.gaps.length === 0 ? (
                    <span className="text-xs text-ink-400">0</span>
                  ) : (
                    <span className="font-semibold text-red-700">{row.gaps.length}</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* -------------------------------- cover gaps -------------------------------- */}
      {!gapsUnknown && (summary.cover.gaps.length > 0 || summary.cover.unverified.length > 0) ? (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardBody>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Gaps ({summary.cover.gaps.length})
              </div>
              {summary.cover.gaps.length === 0 ? (
                <p className="text-sm text-ink-500">None against the recorded requirement set.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {summary.cover.gaps.map((g) => (
                    <li key={g.key} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink-900">{g.vendorName}</span>
                      <span className="text-ink-500">{policyTypeLabel(g.policyType)}</span>
                      <Badge tone="red">{COVER_GAP_REASON_LABELS[g.reason] ?? g.reason}</Badge>
                      <span className="text-[11px] text-ink-400">
                        at work per {VENDOR_SOURCE_LABELS[g.source] ?? g.source}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                In date, unverified ({summary.cover.unverified.length})
              </div>
              {summary.cover.unverified.length === 0 ? (
                <p className="text-sm text-ink-500">None.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {summary.cover.unverified.map((g) => (
                    <li key={g.key} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink-900">{g.vendorName}</span>
                      <span className="text-ink-500">{policyTypeLabel(g.policyType)}</span>
                      <Badge tone="amber">never independently verified</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* ---------------------------------- bonds ---------------------------------- */}
      <SectionTitle hint="Security given and held, per currency. Nothing is summed across currencies.">
        Bonds outstanding
      </SectionTitle>

      <div className="mb-3 space-y-2">
        <Disclosure label="bonds.note — returned verbatim by the API" tone="ink">
          {summary.bonds.note}
        </Disclosure>
        <Disclosure label="bonds.headroomNote — returned verbatim by the API" tone="amber">
          {summary.bonds.headroomNote}
        </Disclosure>
      </div>

      {summary.bonds.aggregateExposure.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-ink-500">No bonds are outstanding.</CardBody>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {summary.bonds.aggregateExposure.map((agg) => (
              <Card key={agg.currency}>
                <CardBody className="py-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold text-ink-900">{agg.currency}</span>
                    <span className="text-xs text-ink-500">
                      {agg.count} bond{agg.count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <FaceVsCurrentBar
                    face={agg.faceAmount}
                    current={agg.currentExposure}
                    currency={agg.currency}
                  />
                </CardBody>
              </Card>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-500">
            Each bar compares current exposure with face value inside one currency — the only
            comparison that means anything here. The bars are not comparable with each other, and
            there is no total.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                By bond type
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Type</Th>
                    <Th>Currency</Th>
                    <Th className="text-right">Count</Th>
                    <Th className="text-right">Face</Th>
                    <Th className="text-right">Current</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {summary.bonds.outstandingByType.map((row) => (
                    <tr key={`${row.bondType}|${row.currency}`}>
                      <Td className="whitespace-nowrap">{bondTypeLabel(row.bondType)}</Td>
                      <Td className="whitespace-nowrap text-xs text-ink-500">{row.currency}</Td>
                      <Td className="text-right tabular-nums">{row.count}</Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">
                        {fmtMoney(row.faceAmount, row.currency, 0)}
                      </Td>
                      <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                        {fmtMoney(row.currentExposure, row.currency, 0)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                By guarantor
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Guarantor</Th>
                    <Th>Currency</Th>
                    <Th className="text-right">Count</Th>
                    <Th className="text-right">Current exposure</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {summary.bonds.byGuarantor.map((row) => (
                    <tr key={`${row.guarantor}|${row.currency}`}>
                      <Td>
                        <div className="text-sm text-ink-900">{row.guarantor}</div>
                        <div className="text-[11px] text-ink-400">
                          {row.bondTypes.map((t) => bondTypeLabel(t)).join(", ")}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-ink-500">{row.currency}</Td>
                      <Td className="text-right tabular-nums">{row.count}</Td>
                      <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                        {fmtMoney(row.currentExposure, row.currency, 0)}
                        <div className="text-[11px] font-normal text-ink-400">
                          face {fmtMoney(row.faceAmount, row.currency, 0)}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                No utilisation bar is drawn against a guarantor: there is no agreed facility limit
                recorded anywhere on the platform, so any bar would invent a denominator and imply
                headroom that nobody has measured.
              </p>
            </div>
          </div>
        </>
      )}

      {/* ---------------------------------- claims ---------------------------------- */}
      <SectionTitle hint="Reserve against settlement, per currency.">Claims</SectionTitle>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              By status — {summary.claims.total} claim{summary.claims.total === 1 ? "" : "s"}
            </div>
            <StatusBars byStatus={summary.claims.byStatus} />
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Notification discipline
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-ink-50 px-2 py-2">
                <div className="text-xl font-semibold tabular-nums text-ink-900">
                  {summary.claims.notificationsOutstanding}
                </div>
                <div className="text-[11px] text-ink-500">not yet notified</div>
              </div>
              <div
                className={`rounded-md px-2 py-2 ${
                  summary.claims.notificationsMissed > 0 ? "bg-red-900 text-red-50" : "bg-ink-50"
                }`}
              >
                <div className="text-xl font-semibold tabular-nums">
                  {summary.claims.notificationsMissed}
                </div>
                <div className="text-[11px] opacity-80">notified late</div>
              </div>
              <div className="rounded-md bg-amber-50 px-2 py-2">
                <div className="text-xl font-semibold tabular-nums text-amber-900">
                  {summary.claims.notificationDeadlineUnknown}
                </div>
                <div className="text-[11px] text-amber-800">no deadline computed</div>
              </div>
            </div>
            {summary.claims.note ? (
              <div className="mt-3">
                <Disclosure label="claims.note — returned verbatim by the API" tone="amber">
                  {summary.claims.note}
                </Disclosure>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4">
        {summary.claims.totals.length === 0 ? (
          <Card>
            <CardBody className="text-sm text-ink-500">No claims recorded.</CardBody>
          </Card>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Currency</Th>
                <Th className="text-right">Claims</Th>
                <Th className="text-right">Reserve</Th>
                <Th className="text-right">Settled</Th>
                <Th>Coverage of the figures</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {summary.claims.totals.map((t) => (
                <tr key={t.currency}>
                  <Td className="whitespace-nowrap font-medium">{t.currency}</Td>
                  <Td className="text-right tabular-nums">{t.claims}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {t.reserve === null ? (
                      <span className="text-xs text-ink-400">none set</span>
                    ) : (
                      fmtMoney(t.reserve, t.currency, 0)
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {t.settled === null ? (
                      <span className="text-xs text-ink-400">none settled</span>
                    ) : (
                      fmtMoney(t.settled, t.currency, 0)
                    )}
                  </Td>
                  <Td className="text-xs leading-relaxed text-ink-600">
                    Reserve covers {t.claimsWithReserve} of {t.claims} claim(s);{" "}
                    {t.claimsWithoutReserve} carr{t.claimsWithoutReserve === 1 ? "ies" : "y"} no
                    reserve at all. Settled figure covers {t.claimsSettled} claim(s). The two
                    columns are not a like-for-like comparison unless those counts match.
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      {/* --------------------------- obligations & signals --------------------------- */}
      <SectionTitle hint="Insurance obligations and the detectors this module owns.">
        Obligations and signals
      </SectionTitle>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Notification obligations
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded-md bg-brand-50 px-2 py-2">
                <div className="text-xl font-semibold tabular-nums text-brand-800">
                  {summary.obligations.open}
                </div>
                <div className="text-[11px] text-brand-700">open</div>
              </div>
              <div className="rounded-md bg-emerald-50 px-2 py-2">
                <div className="text-xl font-semibold tabular-nums text-emerald-800">
                  {summary.obligations.satisfied}
                </div>
                <div className="text-[11px] text-emerald-700">satisfied</div>
              </div>
              <div
                className={`rounded-md px-2 py-2 ${
                  summary.obligations.breached > 0 ? "bg-red-900 text-red-50" : "bg-ink-50"
                }`}
              >
                <div className="text-xl font-semibold tabular-nums">
                  {summary.obligations.breached}
                </div>
                <div className="text-[11px] opacity-80">breached</div>
              </div>
              <div className="rounded-md bg-ink-50 px-2 py-2">
                <div className="text-xl font-semibold tabular-nums text-ink-900">
                  {summary.obligations.total}
                </div>
                <div className="text-[11px] text-ink-500">total</div>
              </div>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-500">
              A breached notification obligation stays breached: settling the claim later does not
              rewrite the register.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Signals raised by this module
              </span>
              <span className="text-xs text-ink-500">
                {summary.signals.open} open of {summary.signals.total}
              </span>
            </div>
            <ul className="space-y-1 text-sm">
              {Object.entries(summary.signals.byDetector).map(([detector, n]) => (
                <li key={detector} className="flex items-center justify-between gap-3">
                  <span className="text-ink-700">{DETECTOR_LABELS[detector] ?? detector}</span>
                  <span
                    className={`tabular-nums ${n > 0 ? "font-semibold text-red-700" : "text-ink-400"}`}
                  >
                    {fmtNum(n)}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------- SVG bits -------------------------------- */

/**
 * Face against current exposure, inside one currency. Both numbers share a
 * denominator that actually exists (the face value), which is what makes this
 * bar honest where a utilisation bar against a surety would not be.
 */
function FaceVsCurrentBar({
  face,
  current,
  currency,
}: {
  face: number;
  current: number;
  currency: string;
}) {
  const W = 420;
  const H = 62;
  const left = 4;
  const right = W - 4;
  const width = right - left;
  const y = 22;
  const h = 20;
  const frac = face > 0 ? Math.max(0, Math.min(1, current / face)) : 0;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 h-auto w-full"
      role="img"
      aria-label={`Current exposure ${current} against face value ${face} ${currency}`}
    >
      <rect x={left} y={y} width={width} height={h} rx={3} fill={CHART.ink100} stroke={CHART.ink200} />
      <rect x={left} y={y} width={Math.max(2, width * frac)} height={h} rx={3} fill={CHART.brand600} />
      <text x={left} y={y - 6} fontSize={10} fontWeight={700} fill={CHART.ink600}>
        {fmtMoney(current, currency, 0)} current
      </text>
      <text x={right} y={y - 6} fontSize={10} textAnchor="end" fill={CHART.ink400}>
        face {fmtMoney(face, currency, 0)}
      </text>
      <text x={left} y={y + h + 13} fontSize={9} fill={CHART.ink400}>
        {fmtPct(frac * 100, 0)} of face value after triggered reductions
      </text>
    </svg>
  );
}

/** Claims by status — every status plotted, zeros included. */
function StatusBars({ byStatus }: { byStatus: Record<string, number> }) {
  const rows = INSURANCE_CLAIM_STATUSES.map((s) => ({
    status: s,
    n: byStatus[s] ?? 0,
  }));
  const max = Math.max(1, ...rows.map((r) => r.n));
  const W = 420;
  const rowH = 22;
  const H = rows.length * rowH + 10;
  const labelW = 120;
  const barLeft = labelW + 6;
  const barW = W - barLeft - 34;

  const fill: Record<string, string> = {
    notified: CHART.brand600,
    acknowledged: CHART.brand400,
    under_assessment: CHART.amber,
    accepted: CHART.emerald,
    repudiated: CHART.red,
    settled: CHART.brand900,
    withdrawn: CHART.ink300,
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Claims by status"
    >
      {rows.map((r, i) => {
        const y = i * rowH + 6;
        const w = (r.n / max) * barW;
        return (
          <g key={r.status}>
            <text x={labelW} y={y + 12} fontSize={10} textAnchor="end" fill={CHART.ink600}>
              {CLAIM_STATUS_LABELS[r.status] ?? r.status}
            </text>
            {r.n === 0 ? (
              <line
                x1={barLeft}
                x2={barLeft + 3}
                y1={y + 8}
                y2={y + 8}
                stroke={CHART.ink300}
                strokeWidth={8}
              />
            ) : (
              <rect
                x={barLeft}
                y={y + 2}
                width={Math.max(3, w)}
                height={13}
                rx={2}
                fill={fill[r.status] ?? CHART.brand600}
              />
            )}
            <text
              x={barLeft + Math.max(3, w) + 6}
              y={y + 12}
              fontSize={10}
              fill={r.n === 0 ? CHART.ink300 : CHART.ink600}
              className="tabular-nums"
            >
              {r.n}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
