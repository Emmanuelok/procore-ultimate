/**
 * Radar — the landing tab (#777-780, #794).
 *
 * The expiry engine's report, turned into one list ordered by urgency. What is
 * already past comes first, because the three things this workspace exists to
 * prevent have all already happened by the time they show a negative number:
 * a bond past its demand deadline, a policy that lapsed while people are on
 * site, and a claim whose notification period has run out.
 *
 * The honesty rule that governs this tab: when `coverRequirementsKnown` is
 * false there is NO all-clear. "0 gaps" is not rendered, the count reads
 * "unknown", and the API's `coverNote` is shown verbatim.
 */
import { useCallback, useEffect, useState } from "react";
import { POLICY_TYPES } from "@constructos/shared";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, EmptyState, ErrorAlert, Input, Spinner } from "../../ui";
import { formatDate } from "../format";
import type { InsuranceTabKey } from "./InsurancePage";
import {
  CHART,
  COVER_GAP_REASON_DETAIL,
  COVER_GAP_REASON_LABELS,
  DeadlineChip,
  Disclosure,
  REQUIRED_TYPES_SOURCE_TEXT,
  StatCard,
  VENDOR_SOURCE_LABELS,
  daysWord,
  errMsg,
  fmtMoney,
  policyTypeLabel,
  bondTypeLabel,
  type ClaimRow,
  type CoverGap,
  type ExpiryReport,
  type ListResponse,
} from "./insuranceShared";

const WINDOW_PRESETS = [7, 14, 30, 60, 90, 180, 365];

type Tone = "fatal" | "critical" | "warn" | "info";

interface ActionItem {
  key: string;
  rank: number;
  days: number | null;
  tone: Tone;
  category: string;
  title: string;
  detail: string;
  date: string | null;
  dateLabel: string;
  /** what the chip says when there is no countdown to show */
  unknownLabel?: string;
  target?: { tab: InsuranceTabKey; recordId?: string; vendorId?: string };
  fatal?: boolean;
}

const TONE_BAR: Record<Tone, string> = {
  fatal: "border-l-red-800 bg-red-50/70",
  critical: "border-l-red-500 bg-white",
  warn: "border-l-amber-500 bg-white",
  info: "border-l-ink-300 bg-white",
};

const TONE_CHIP: Record<Tone, string> = {
  fatal: "bg-red-900 text-red-50",
  critical: "bg-red-100 text-red-800",
  warn: "bg-amber-100 text-amber-800",
  info: "bg-ink-100 text-ink-700",
};

export default function RadarTab({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (tab: InsuranceTabKey, opts?: { recordId?: string; vendorId?: string }) => void;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [days, setDays] = useState(30);
  const [daysInput, setDaysInput] = useState("30");
  const [requiredTypes, setRequiredTypes] = useState<string[]>([]);
  const [report, setReport] = useState<ExpiryReport | null>(null);
  const [claims, setClaims] = useState<ClaimRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (requiredTypes.length > 0) params.set("requiredTypes", requiredTypes.join(","));
      const res = await api.get<ExpiryReport>(`${base}/insurance/expiring?${params}`);
      setReport(res);
    } catch (err) {
      setReport(null);
      setError(errMsg(err, "Failed to load the expiry radar"));
    } finally {
      setLoading(false);
    }
  }, [base, days, requiredTypes]);

  useEffect(() => {
    void load();
  }, [load]);

  /* The radar's own report says nothing about claims, and the claim
   * notification period is the deadline that kills claims outright — so the
   * outstanding notifications are pulled from the claims register alongside it
   * and labelled as coming from there. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setClaimsError(null);
      try {
        const res = await api.get<ListResponse<ClaimRow>>(
          `${base}/insurance/claims?notified=false&pageSize=200`,
        );
        if (!cancelled) setClaims(res.items);
      } catch (err) {
        if (!cancelled) {
          setClaims([]);
          setClaimsError(errMsg(err, "Failed to load outstanding claim notifications"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  function applyDays(raw: string) {
    setDaysInput(raw);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= 730) setDays(Math.round(n));
  }

  function toggleRequiredType(t: string) {
    setRequiredTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  const items = report ? buildActionList(report, claims ?? []) : [];
  const gapsUnknown = report ? !report.coverRequirementsKnown : false;
  const expiringCount = report
    ? report.policiesExpiring.length +
      report.certificatesExpiring.length +
      report.bondsExpiring.length
    : 0;

  return (
    <div>
      {/* ------------------------------ controls ------------------------------ */}
      <Card className="mb-4">
        <CardBody className="py-3">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">
                Window
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {WINDOW_PRESETS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setDays(d);
                      setDaysInput(String(d));
                    }}
                    className={
                      days === d
                        ? "rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white"
                        : "rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-ink-200 hover:bg-ink-50"
                    }
                  >
                    {d}d
                  </button>
                ))}
                <Input
                  type="number"
                  min={1}
                  max={730}
                  value={daysInput}
                  onChange={(e) => applyDays(e.target.value)}
                  className="ml-1 w-24"
                  aria-label="Days ahead (1-730)"
                />
              </div>
              <p className="mt-1 text-xs text-ink-400">
                Looking ahead {daysWord(days)}. Anything already past is shown whatever the window.
              </p>
            </div>

            <div className="grow" />
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Refresh
            </Button>
          </div>

          <details className="mt-3 border-t border-ink-100 pt-3">
            <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:text-brand-800">
              Cover requirement set{" "}
              {requiredTypes.length > 0
                ? `— ${requiredTypes.length} type(s) asserted for this query`
                : "— derived from the recorded programme"}
            </summary>
            <p className="mt-2 text-xs leading-relaxed text-ink-500">
              A cover gap can only be found against a set of policy types the supply chain is
              required to carry. Leave this empty and the API derives the set from policies that
              record a <code className="text-[11px]">requiredByClause</code>. Tick types here to
              assert a requirement set for this query instead — the report will say the requirement
              came from the query, not from the contract record.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {POLICY_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleRequiredType(t)}
                  className={
                    requiredTypes.includes(t)
                      ? "rounded-full bg-brand-600 px-2.5 py-1 text-xs font-medium text-white"
                      : "rounded-full bg-white px-2.5 py-1 text-xs font-medium text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50"
                  }
                >
                  {policyTypeLabel(t)}
                </button>
              ))}
              {requiredTypes.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setRequiredTypes([])}
                  className="rounded-full px-2.5 py-1 text-xs font-medium text-ink-500 underline hover:text-ink-800"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </details>
        </CardBody>
      </Card>

      <ErrorAlert message={error} />

      {loading && !report ? <Spinner label="Reading the expiry engine…" /> : null}

      {report ? (
        <>
          {/* ----------------------------- headline ----------------------------- */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard
              label="Needs action today"
              value={report.actionableCount}
              tone={
                report.actionableCount > 0 ? "red" : gapsUnknown ? "amber" : "green"
              }
              emphasized
              hint={
                gapsUnknown
                  ? "Lapsed policies, expired certificates and bonds past their demand deadline. Cover gaps are NOT included — they were not computed."
                  : "Lapsed policies, expired certificates, bonds past their demand deadline and cover gaps"
              }
              title="actionableCount — the four conditions the expiry engine treats as already wrong, not merely approaching. With no requirement set recorded, the cover-gap component of this count is absent rather than zero."
            />
            <StatCard
              label="Bonds past demand deadline"
              value={report.bondsPastDemandDeadline.length}
              tone={report.bondsPastDemandDeadline.length > 0 ? "red" : undefined}
              hint="Security that can no longer be called"
            />
            <StatCard
              label="Policies lapsed"
              value={report.policiesLapsed.length}
              tone={report.policiesLapsed.length > 0 ? "red" : undefined}
              hint="Period ended, still recorded in force"
            />
            <StatCard
              label="Cover gaps"
              value={gapsUnknown ? "unknown" : report.coverGaps.length}
              tone={gapsUnknown ? "amber" : report.coverGaps.length > 0 ? "red" : undefined}
              hint={
                gapsUnknown
                  ? "No requirement set is recorded — gaps cannot be computed"
                  : `${report.vendorsAtWork} vendor(s) at work tested against ${report.requiredTypes.length} required type(s)`
              }
            />
            <StatCard
              label="Certificates expired"
              value={report.certificatesExpired.length}
              tone={report.certificatesExpired.length > 0 ? "red" : undefined}
              hint="Still relied on, no longer valid"
            />
            <StatCard
              label={`Expiring in ${days}d`}
              value={expiringCount}
              tone={expiringCount > 0 ? "amber" : undefined}
              hint="Policies, certificates and bonds inside the window"
            />
          </div>

          {/* ------------------- the requirements-unknown state ------------------- */}
          {gapsUnknown ? (
            <div className="mb-4 rounded-lg border-l-4 border-l-amber-500 bg-amber-50 p-4 ring-1 ring-amber-200">
              <div className="text-sm font-semibold text-amber-900">
                The cover requirement set is unknown — supply-chain gaps have not been computed
              </div>
              <p className="mt-1 text-xs leading-relaxed text-amber-900">
                This is not an all-clear. Nothing on this page says the supply chain is insured; it
                says nobody has recorded what it is required to carry, so the question was not
                asked. {report.vendorsAtWork} vendor(s) are recorded as at work in this scope.
              </p>
              {report.coverNote ? (
                <div className="mt-2">
                  <Disclosure label="coverNote — returned verbatim by the API" tone="amber">
                    {report.coverNote}
                  </Disclosure>
                </div>
              ) : null}
              <p className="mt-2 text-xs text-amber-800">
                <span className="font-semibold">requiredTypesSource:</span>{" "}
                <code className="text-[11px]">{report.requiredTypesSource}</code> —{" "}
                {REQUIRED_TYPES_SOURCE_TEXT[report.requiredTypesSource] ?? ""}
              </p>
            </div>
          ) : (
            <div className="mb-4 rounded-lg bg-white p-3 text-xs leading-relaxed text-ink-600 ring-1 ring-ink-100">
              <span className="font-semibold text-ink-800">Requirement set:</span>{" "}
              {report.requiredTypes.map((t) => policyTypeLabel(t)).join(", ") || "none"} ·{" "}
              <span className="font-semibold text-ink-800">source</span>{" "}
              <code className="text-[11px]">{report.requiredTypesSource}</code> —{" "}
              {REQUIRED_TYPES_SOURCE_TEXT[report.requiredTypesSource] ?? ""} Tested against{" "}
              {report.vendorsAtWork} vendor(s) recorded as at work.
            </div>
          )}

          {/* --------------------------- expiry horizon --------------------------- */}
          <ExpiryHorizon report={report} windowDays={days} />

          {/* ---------------------------- action list ---------------------------- */}
          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-ink-900">
                Action list — most urgent first
              </h2>
              <span className="text-xs text-ink-400">
                as of {formatDate(report.asOf)} · window {report.windowDays} days
              </span>
            </div>

            {items.length === 0 ? (
              <EmptyState
                title="Nothing is running out inside this window"
                hint={
                  gapsUnknown
                    ? "Note that supply-chain cover gaps were NOT tested — no requirement set is recorded, so this list cannot include them."
                    : "Policies, certificates and bonds in this scope are all in date beyond the window, and no gap was found against the recorded requirement set."
                }
              />
            ) : (
              <div className="space-y-2">
                {items.map((item) => (
                  <div
                    key={item.key}
                    className={`flex flex-wrap items-start gap-3 rounded-lg border-l-4 p-3 shadow-sm ring-1 ring-ink-100 ${TONE_BAR[item.tone]}`}
                  >
                    <span
                      className={`inline-flex shrink-0 items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONE_CHIP[item.tone]}`}
                    >
                      {item.category}
                    </span>
                    <div className="min-w-[16rem] grow">
                      <div className="text-sm font-medium text-ink-900">{item.title}</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-ink-500">
                        {item.detail}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <div className="text-right">
                        <DeadlineChip
                          days={item.days}
                          fatal={item.fatal}
                          {...(item.unknownLabel ? { unknownLabel: item.unknownLabel } : {})}
                        />
                        {item.date ? (
                          <div className="mt-0.5 text-[11px] text-ink-400">
                            {item.dateLabel} {formatDate(item.date)}
                          </div>
                        ) : null}
                      </div>
                      {item.target ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const t = item.target;
                            if (!t) return;
                            const opts: { recordId?: string; vendorId?: string } = {};
                            if (t.recordId) opts.recordId = t.recordId;
                            if (t.vendorId) opts.vendorId = t.vendorId;
                            onOpen(t.tab, opts);
                          }}
                        >
                          Open
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ------------------------ past demand deadlines ------------------------ */}
          {report.bondsPastDemandDeadline.length > 0 ? (
            <div className="mt-6">
              <div className="rounded-lg border-l-4 border-red-800 bg-red-900 px-4 py-3 text-red-50">
                <div className="text-sm font-bold uppercase tracking-wide">
                  {report.bondsPastDemandDeadline.length} bond(s) past the last date a demand can be
                  made
                </div>
                <p className="mt-1 text-xs leading-relaxed text-red-100">
                  A demand under these bonds will not be honoured. The demand deadline — not expiry
                  — is the date the security dies, and it is commonly weeks earlier. The API refuses
                  to record a demand after it. Pursue the principal directly and record the missed
                  deadline as a loss.
                </p>
              </div>
              <div className="mt-2 space-y-2">
                {report.bondsPastDemandDeadline.map((b) => (
                  <div
                    key={b.bondId}
                    className="flex flex-wrap items-center gap-3 rounded-lg bg-white p-3 ring-1 ring-red-200"
                  >
                    <span className="font-mono text-xs text-ink-500">{b.number}</span>
                    <span className="text-sm font-medium text-ink-900">
                      {bondTypeLabel(b.bondType)}
                    </span>
                    <span className="text-xs text-ink-500">{b.guarantor}</span>
                    <span className="text-sm tabular-nums text-ink-800">
                      {fmtMoney(b.currentAmount, b.currency)}
                      {b.currentAmount !== b.amount ? (
                        <span className="ml-1 text-xs text-ink-400">
                          (face {fmtMoney(b.amount, b.currency)})
                        </span>
                      ) : null}
                    </span>
                    <div className="grow" />
                    <span className="text-xs text-ink-500">
                      deadline {formatDate(b.demandDeadline)}
                    </span>
                    <DeadlineChip days={b.daysRemaining} fatal />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onOpen("bonds", { recordId: b.bondId })}
                    >
                      Open
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* ------------------------------ cover gaps ------------------------------ */}
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-ink-900">
              Supply-chain cover gaps{" "}
              <span className="font-normal text-ink-400">
                — a party at work with no in-date evidence of a required policy type
              </span>
            </h2>
            {gapsUnknown ? (
              <Card>
                <CardBody>
                  <p className="text-sm text-ink-700">
                    Not computed. The requirement set is unknown, so no gap analysis was run — and
                    an empty list here would read as "all clear", which would be false.
                  </p>
                  {report.coverNote ? (
                    <div className="mt-2">
                      <Disclosure label="coverNote — returned verbatim by the API" tone="amber">
                        {report.coverNote}
                      </Disclosure>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ) : report.coverGaps.length === 0 ? (
              <Card>
                <CardBody className="text-sm text-ink-600">
                  No gap found for {report.vendorsAtWork} vendor(s) at work against{" "}
                  {report.requiredTypes.length} required type(s):{" "}
                  {report.requiredTypes.map((t) => policyTypeLabel(t)).join(", ")}. This is only as
                  wide as the requirement set — cover types nobody recorded as required were not
                  tested.
                </CardBody>
              </Card>
            ) : (
              <div className="space-y-2">
                {report.coverGaps.map((g) => (
                  <GapRow key={g.key} gap={g} onOpen={onOpen} tone="critical" />
                ))}
              </div>
            )}
          </div>

          {/* --------------------------- unverified cover --------------------------- */}
          {report.coverUnverified.length > 0 ? (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-ink-900">
                In date, never independently verified{" "}
                <span className="font-normal text-ink-400">
                  — evidence taken on trust from the party it protects
                </span>
              </h2>
              <div className="space-y-2">
                {report.coverUnverified.map((g) => (
                  <GapRow key={g.key} gap={g} onOpen={onOpen} tone="warn" />
                ))}
              </div>
            </div>
          ) : null}

          {/* --------------------- outstanding claim notifications --------------------- */}
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-ink-900">
              Claim notifications outstanding{" "}
              <span className="font-normal text-ink-400">
                — from the claims register, not the expiry report
              </span>
            </h2>
            <ErrorAlert message={claimsError} />
            {claims === null ? (
              <Spinner label="Reading the claims register…" />
            ) : claims.length === 0 ? (
              <Card>
                <CardBody className="text-sm text-ink-600">
                  Every recorded claim has been notified to its insurer.
                </CardBody>
              </Card>
            ) : (
              <div className="space-y-2">
                {claims
                  .slice()
                  .sort(
                    (a, b) =>
                      (a.daysToNotificationDue ?? 9_999) - (b.daysToNotificationDue ?? 9_999),
                  )
                  .map((c) => (
                    <div
                      key={c.id}
                      className={`flex flex-wrap items-center gap-3 rounded-lg border-l-4 p-3 shadow-sm ring-1 ring-ink-100 ${
                        c.daysToNotificationDue !== null && c.daysToNotificationDue < 0
                          ? "border-l-red-800 bg-red-50/70"
                          : c.notificationDueAt === null
                            ? "border-l-amber-500 bg-white"
                            : "border-l-red-400 bg-white"
                      }`}
                    >
                      <span className="font-mono text-xs text-ink-500">{c.number}</span>
                      <span className="min-w-[12rem] grow text-sm font-medium text-ink-900">
                        {c.title}
                      </span>
                      <span className="text-xs text-ink-500">
                        aware {formatDate(c.awareDate)} · due{" "}
                        {c.notificationDueAt ? formatDate(c.notificationDueAt) : "not computed"}
                      </span>
                      <DeadlineChip
                        days={c.daysToNotificationDue}
                        fatal
                        unknownLabel="no deadline computed"
                        unknownTitle="The policy records no notificationDays, so no deadline could be computed and no obligation exists. That is not the same as having time."
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onOpen("claims", { recordId: c.id })}
                      >
                        Open
                      </Button>
                    </div>
                  ))}
              </div>
            )}
            <p className="mt-2 text-xs leading-relaxed text-ink-500">
              Notification within the policy period is a condition precedent to liability in almost
              every wording. Where it is, a late notification is fatal to the claim however strong
              its merits, and the insurer need show no prejudice to decline.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------- gap row ---------------------------------- */

function GapRow({
  gap,
  tone,
  onOpen,
}: {
  gap: CoverGap;
  tone: Tone;
  onOpen: (tab: InsuranceTabKey, opts?: { recordId?: string; vendorId?: string }) => void;
}) {
  return (
    <div
      className={`flex flex-wrap items-start gap-3 rounded-lg border-l-4 p-3 shadow-sm ring-1 ring-ink-100 ${TONE_BAR[tone]}`}
    >
      <div className="min-w-[14rem] grow">
        <div className="text-sm font-medium text-ink-900">
          {gap.vendorName}{" "}
          <span className="font-normal text-ink-500">— {policyTypeLabel(gap.policyType)}</span>
        </div>
        <div className="mt-0.5 text-xs leading-relaxed text-ink-500">
          {COVER_GAP_REASON_DETAIL[gap.reason] ?? gap.reason} At work per{" "}
          {VENDOR_SOURCE_LABELS[gap.source] ?? gap.source}.
          {gap.lastValidTo ? ` Last certificate ran to ${formatDate(gap.lastValidTo)}.` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge tone={gap.reason === "unverified" ? "amber" : "red"}>
          {COVER_GAP_REASON_LABELS[gap.reason] ?? gap.reason}
        </Badge>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onOpen("certificates", { vendorId: gap.vendorId })}
        >
          Certificates
        </Button>
      </div>
    </div>
  );
}

/* --------------------------- the merged action list ------------------------ */

function buildActionList(report: ExpiryReport, outstandingClaims: ClaimRow[]): ActionItem[] {
  const items: ActionItem[] = [];

  for (const b of report.bondsPastDemandDeadline) {
    items.push({
      key: `bond-past-${b.bondId}`,
      rank: 0,
      days: b.daysRemaining,
      tone: "fatal",
      fatal: true,
      category: "Bond dead",
      title: `${b.number} — ${bondTypeLabel(b.bondType)} (${b.guarantor})`,
      detail: `The last date for making a demand has passed. ${fmtMoney(b.currentAmount, b.currency)} of security can no longer be called; a demand made now will not be honoured.`,
      date: b.demandDeadline,
      dateLabel: "demand deadline",
      target: { tab: "bonds", recordId: b.bondId },
    });
  }

  for (const c of outstandingClaims) {
    const overdue = c.daysToNotificationDue !== null && c.daysToNotificationDue < 0;
    if (!overdue && (c.daysToNotificationDue === null || c.daysToNotificationDue > 60)) continue;
    items.push({
      key: `claim-${c.id}`,
      rank: overdue ? 0 : 3,
      days: c.daysToNotificationDue,
      tone: overdue ? "fatal" : "critical",
      fatal: true,
      category: overdue ? "Notification missed" : "Notify insurer",
      title: `${c.number} — ${c.title}`,
      detail: overdue
        ? `The notification period computed from the aware date ${c.awareDate} has run out and the insurer has still not been told. Notification in time is normally a condition precedent to liability.`
        : `Not yet notified to the insurer. The clock runs from the aware date ${c.awareDate}, not the incident date.`,
      date: c.notificationDueAt,
      dateLabel: "notification due",
      target: { tab: "claims", recordId: c.id },
    });
  }

  for (const p of report.policiesLapsed) {
    items.push({
      key: `pol-lapsed-${p.policyId}`,
      rank: 1,
      days: p.daysRemaining,
      tone: "fatal",
      category: "Policy lapsed",
      title: `${p.number} — ${policyTypeLabel(p.policyType)} (${p.insurer})`,
      detail: `The policy period ended while the policy was still recorded in force. From ${p.periodEnd} the works are uninsured for this risk, and where the cover is a contractual requirement the lapse is itself a breach.`,
      date: p.periodEnd,
      dateLabel: "period ended",
      target: { tab: "policies", recordId: p.policyId },
    });
  }

  for (const g of report.coverGaps) {
    items.push({
      key: `gap-${g.key}`,
      rank: 2,
      days: null,
      tone: "critical",
      category: "Cover gap",
      title: `${g.vendorName} — ${policyTypeLabel(g.policyType)}`,
      detail: `${COVER_GAP_REASON_DETAIL[g.reason] ?? g.reason} At work per ${VENDOR_SOURCE_LABELS[g.source] ?? g.source}.`,
      date: g.lastValidTo,
      dateLabel: "last certificate to",
      unknownLabel: "open now",
      target: { tab: "certificates", vendorId: g.vendorId },
    });
  }

  for (const c of report.certificatesExpired) {
    items.push({
      key: `cert-expired-${c.certificateId}`,
      rank: 3,
      days: c.daysRemaining,
      tone: "critical",
      category: "Certificate expired",
      title: `${c.subjectName} — ${policyTypeLabel(c.policyType)}`,
      detail: `The certificate relied on for this party ran out on ${c.validTo} and is still recorded as active evidence.`,
      date: c.validTo,
      dateLabel: "valid to",
      target: { tab: "certificates", recordId: c.certificateId },
    });
  }

  for (const b of report.bondsExpiring) {
    items.push({
      key: `bond-exp-${b.bondId}`,
      rank: 4,
      days: b.daysRemaining,
      tone: "warn",
      fatal: true,
      category: b.demandDeadline ? "Demand deadline" : "Bond expiry",
      title: `${b.number} — ${bondTypeLabel(b.bondType)} (${b.guarantor})`,
      detail: b.demandDeadline
        ? `The last date for making a demand is approaching. After it the security is worthless, whatever the bond's expiry date says.`
        : `The bond expires inside the window. No demand deadline is recorded, so expiry is the operative date here.`,
      date: b.demandDeadline ?? b.expiryAt,
      dateLabel: b.demandDeadline ? "demand deadline" : "expires",
      target: { tab: "bonds", recordId: b.bondId },
    });
  }

  for (const p of report.policiesExpiring) {
    items.push({
      key: `pol-exp-${p.policyId}`,
      rank: 5,
      days: p.daysRemaining,
      tone: "warn",
      category: "Policy expiring",
      title: `${p.number} — ${policyTypeLabel(p.policyType)} (${p.insurer})`,
      detail: `Cover ends on ${p.periodEnd}. Renewal is recorded as a new policy with its own period — an expired policy cannot be re-activated.`,
      date: p.periodEnd,
      dateLabel: "period ends",
      target: { tab: "policies", recordId: p.policyId },
    });
  }

  for (const c of report.certificatesExpiring) {
    items.push({
      key: `cert-exp-${c.certificateId}`,
      rank: 6,
      days: c.daysRemaining,
      tone: "info",
      category: "Certificate expiring",
      title: `${c.subjectName} — ${policyTypeLabel(c.policyType)}`,
      detail: c.verified
        ? `Evidence runs out on ${c.validTo}. Collect the replacement before it does.`
        : `Evidence runs out on ${c.validTo}, and it was never independently verified.`,
      date: c.validTo,
      dateLabel: "valid to",
      target: { tab: "certificates", recordId: c.certificateId },
    });
  }

  for (const g of report.coverUnverified) {
    items.push({
      key: `unver-${g.key}`,
      rank: 7,
      days: null,
      tone: "info",
      category: "Unverified",
      title: `${g.vendorName} — ${policyTypeLabel(g.policyType)}`,
      detail: `In-date evidence exists but nobody independent of the party who submitted it has confirmed it.`,
      date: g.lastValidTo,
      dateLabel: "valid to",
      unknownLabel: "unverified",
      target: { tab: "certificates", vendorId: g.vendorId },
    });
  }

  return items.sort((a, b) => {
    const aPast = a.days !== null && a.days < 0 ? 0 : 1;
    const bPast = b.days !== null && b.days < 0 ? 0 : 1;
    if (aPast !== bPast) return aPast - bPast;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return (a.days ?? 9_999) - (b.days ?? 9_999);
  });
}

/* ---------------------------- the horizon chart ---------------------------- */

interface HorizonMark {
  days: number;
  label: string;
  fatal: boolean;
}

/**
 * Hand-rolled expiry horizon. Three lanes — policies, certificates, bonds —
 * with a gutter on the left for everything already past. The gutter is not to
 * scale on purpose: "past" is a category, not a distance, and stretching the
 * axis to fit a policy that lapsed two years ago would squash the fortnight
 * that actually matters.
 */
function ExpiryHorizon({ report, windowDays }: { report: ExpiryReport; windowDays: number }) {
  const lanes: { name: string; marks: HorizonMark[]; color: string }[] = [
    {
      name: "Policies",
      color: CHART.brand600,
      marks: [
        ...report.policiesLapsed.map((p) => ({
          days: p.daysRemaining,
          label: `${p.number} ${policyTypeLabel(p.policyType)} — lapsed ${p.periodEnd}`,
          fatal: true,
        })),
        ...report.policiesExpiring.map((p) => ({
          days: p.daysRemaining,
          label: `${p.number} ${policyTypeLabel(p.policyType)} — expires ${p.periodEnd}`,
          fatal: false,
        })),
      ],
    },
    {
      name: "Certificates",
      color: CHART.brand400,
      marks: [
        ...report.certificatesExpired.map((c) => ({
          days: c.daysRemaining,
          label: `${c.subjectName} ${policyTypeLabel(c.policyType)} — expired ${c.validTo}`,
          fatal: true,
        })),
        ...report.certificatesExpiring.map((c) => ({
          days: c.daysRemaining,
          label: `${c.subjectName} ${policyTypeLabel(c.policyType)} — valid to ${c.validTo}`,
          fatal: false,
        })),
      ],
    },
    {
      name: "Bonds",
      color: CHART.violet,
      marks: [
        ...report.bondsPastDemandDeadline.map((b) => ({
          days: b.daysRemaining ?? 0,
          label: `${b.number} ${bondTypeLabel(b.bondType)} — demand deadline passed ${b.demandDeadline ?? ""}`,
          fatal: true,
        })),
        ...report.bondsExpiring.map((b) => ({
          days: b.daysRemaining ?? 0,
          label: `${b.number} ${bondTypeLabel(b.bondType)} — ${b.demandDeadline ? `demand deadline ${b.demandDeadline}` : `expires ${b.expiryAt ?? ""}`}`,
          fatal: false,
        })),
      ],
    },
  ];

  const total = lanes.reduce((n, l) => n + l.marks.length, 0);
  if (total === 0) return null;

  const W = 720;
  const laneH = 34;
  const PAD = { top: 24, right: 18, bottom: 26, left: 92 };
  const gutterW = 64;
  const H = PAD.top + lanes.length * laneH + PAD.bottom;
  const plotX0 = PAD.left + gutterW + 10;
  const plotW = W - PAD.right - plotX0;
  const x = (days: number) => plotX0 + (Math.max(0, Math.min(windowDays, days)) / windowDays) * plotW;

  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) =>
    Math.round((windowDays / tickCount) * i),
  );

  return (
    <Card>
      <CardBody className="py-3">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
          Expiry horizon — next {daysWord(windowDays)}
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Expiry horizon: ${total} records expiring or already expired across policies, certificates and bonds`}
        >
          {/* the "already past" gutter — a category, not a distance */}
          <rect
            x={PAD.left}
            y={PAD.top - 8}
            width={gutterW}
            height={lanes.length * laneH + 8}
            fill="#fef2f2"
            stroke={CHART.red}
            strokeDasharray="3 2"
            strokeWidth={1}
            rx={3}
          />
          <text
            x={PAD.left + gutterW / 2}
            y={PAD.top - 12}
            textAnchor="middle"
            fontSize={9}
            fontWeight={700}
            fill={CHART.red}
          >
            ALREADY PAST
          </text>

          {/* x grid */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={PAD.top - 8}
                y2={PAD.top + lanes.length * laneH}
                stroke={CHART.ink100}
                strokeWidth={1}
              />
              <text
                x={x(t)}
                y={PAD.top + lanes.length * laneH + 14}
                textAnchor="middle"
                fontSize={9}
                fill={CHART.ink400}
              >
                {t === 0 ? "today" : `+${t}d`}
              </text>
            </g>
          ))}

          {lanes.map((lane, li) => {
            const cy = PAD.top + li * laneH + laneH / 2;
            return (
              <g key={lane.name}>
                <text
                  x={PAD.left - 8}
                  y={cy + 3}
                  textAnchor="end"
                  fontSize={10}
                  fontWeight={600}
                  fill={CHART.ink600}
                >
                  {lane.name}
                </text>
                <line
                  x1={plotX0}
                  x2={W - PAD.right}
                  y1={cy}
                  y2={cy}
                  stroke={CHART.ink100}
                  strokeWidth={1}
                />
                {lane.marks.map((m, i) => {
                  const past = m.days < 0;
                  const cx = past
                    ? PAD.left + 12 + ((i * 13) % Math.max(1, gutterW - 20))
                    : x(m.days);
                  return (
                    <circle
                      key={`${lane.name}-${i}`}
                      cx={cx}
                      cy={cy + (past ? ((i % 3) - 1) * 7 : ((i % 3) - 1) * 5)}
                      r={past || m.fatal ? 5 : 4}
                      fill={past ? CHART.red900 : m.fatal ? CHART.red : lane.color}
                      fillOpacity={past ? 1 : 0.85}
                      stroke="#fff"
                      strokeWidth={1}
                    >
                      <title>
                        {m.label}
                        {"\n"}
                        {m.days < 0
                          ? `${daysWord(m.days)} past`
                          : m.days === 0
                            ? "today"
                            : `in ${daysWord(m.days)}`}
                      </title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
        </svg>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-500">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: CHART.red900 }}
            />
            already past
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: CHART.brand600 }}
            />
            policy period ends
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: CHART.brand400 }}
            />
            certificate validity ends
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: CHART.violet }}
            />
            bond demand deadline (or expiry where none is recorded)
          </span>
        </div>
      </CardBody>
    </Card>
  );
}
