/**
 * WAGE AND WORKING-TIME COMPLIANCE (Domain M #678-682) and the THREE-WAY
 * LABOUR POSITION.
 *
 * The jurisdiction is chosen, never defaulted. Eight hours a day is
 * Californian, forty-eight a week is the Working Time Directive, and running a
 * Gulf payroll under either produces findings against an employer that are
 * simply wrong — so the picker is the first control on the screen and every
 * finding carries the instrument its limit came from.
 *
 * The labour position sets three independent statements about the same days
 * against each other: what the site APPROVED (timecards), what the employer
 * says was PAID (payroll), and what the turnstile RECORDED. A missing leg
 * shows as missing. Nothing here turns an absent payroll file into "paid
 * nothing", because that would accuse a real, named person.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import {
  LoadError,
  Stat,
  addDays,
  fmtMoney,
  fmtNum,
  isoToday,
  label,
  severityTone,
} from "./workforceShared";

interface Jurisdiction {
  key: string;
  name: string;
  citation: string;
  maxWeeklyHours: number | null;
  maxDailyHours: number | null;
  maxConsecutiveWorkDays: number | null;
  wagePaymentDueDays: number | null;
  maxDeductionPercent: number | null;
  minimumWage: { amount: number; currency: string; unit: string; rateAsOf: string } | null;
  recruitmentFeesProhibited: boolean;
}

interface Finding {
  detector: string;
  severity: string;
  title: string;
  explanation: string;
  citation: string;
  indicator: string | null;
  amountAtRisk: number | null;
  currency: string | null;
  reference: string;
  vendorId: string | null;
}

interface ComplianceResult {
  jurisdiction: Jurisdiction | null;
  periodStart: string;
  periodEnd: string;
  workers: number;
  findings: Finding[];
  reasons: string[];
  signalsRaised?: number;
  flagsRaised?: number;
}

interface PositionRow {
  workerId: string;
  reference: string;
  fullName: string;
  vendorName: string | null;
  approvedHours: number;
  pendingHours: number;
  paidHours: number | null;
  paidDays: number;
  grossPay: number | null;
  payrollCurrency: string | null;
  accessDays: number;
  hoursDifference: number | null;
  impliedHourlyRate: number | null;
  crewHourlyRate: number | null;
  status: string;
  reasons: string[];
}

interface PositionResult {
  periodStart: string;
  periodEnd: string;
  workers: number;
  rows: PositionRow[];
  findings: Array<{
    detector: string;
    severity: string;
    reference: string;
    title: string;
    explanation: string;
    amountAtRisk: number | null;
    currency: string | null;
  }>;
  moneyAtRisk: Array<{ currency: string; overpaid: number; unpaid: number }>;
  totals: {
    approvedHours: number;
    paidHours: number | null;
    accessDays: number;
    workersAwaitingPayroll: number;
  };
  reasons: string[];
  method: string;
}

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "gray"> = {
  reconciled: "green",
  paid_over_approved: "red",
  approved_not_paid: "red",
  rate_below_crew: "amber",
  awaiting_payroll: "gray",
  not_comparable: "gray",
};

export default function ComplianceTab({ projectId }: { projectId: string }) {
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[] | null>(null);
  const [jurisdiction, setJurisdiction] = useState("gb");
  const [to, setTo] = useState(isoToday());
  const [from, setFrom] = useState(addDays(isoToday(), -30));
  const [compliance, setCompliance] = useState<ComplianceResult | null>(null);
  const [position, setPosition] = useState<PositionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: Jurisdiction[] }>("/api/v1/workforce/jurisdictions")
      .then((res) => setJurisdictions(res.items))
      .catch(() => setJurisdictions([]));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setBusy("load");
    try {
      const [c, p] = await Promise.all([
        api.get<ComplianceResult>(
          `/api/v1/projects/${projectId}/workforce/compliance?jurisdiction=${jurisdiction}&periodStart=${from}&periodEnd=${to}`,
        ),
        api.get<PositionResult>(
          `/api/v1/projects/${projectId}/workforce/labour-position?from=${from}&to=${to}`,
        ),
      ]);
      setCompliance(c);
      setPosition(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "This assessment could not be run.");
    } finally {
      setBusy(null);
    }
  }, [projectId, jurisdiction, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  async function persist() {
    setBusy("run");
    setError(null);
    try {
      const res = await api.post<ComplianceResult>(
        `/api/v1/projects/${projectId}/workforce/compliance/run`,
        { jurisdiction, periodStart: from, periodEnd: to },
      );
      setCompliance(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The run could not be persisted.");
    } finally {
      setBusy(null);
    }
  }

  const j = compliance?.jurisdiction ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field
              label="Jurisdiction"
              hint="Never defaulted: a limit borrowed from another country produces findings that are simply wrong."
            >
              <Select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
                {(jurisdictions ?? []).map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <div className="flex items-end gap-2">
              <Button variant="secondary" loading={busy === "load"} onClick={() => void load()}>
                Replay
              </Button>
              <Button variant="primary" loading={busy === "run"} onClick={persist}>
                Run &amp; record
              </Button>
            </div>
          </div>
          {j ? (
            <p className="text-meta text-content-muted">
              <strong>{j.name}</strong> ·{" "}
              {j.maxWeeklyHours !== null ? `${j.maxWeeklyHours} h/week` : "no weekly cap"} ·{" "}
              {j.maxDailyHours !== null ? `${j.maxDailyHours} h/day` : "no daily cap"} ·{" "}
              {j.maxConsecutiveWorkDays !== null
                ? `rest day after ${j.maxConsecutiveWorkDays} days`
                : "no rest-day rule"}{" "}
              ·{" "}
              {j.wagePaymentDueDays !== null
                ? `wages due within ${j.wagePaymentDueDays} days`
                : "no statutory payment window"}
              {j.minimumWage
                ? ` · minimum ${j.minimumWage.currency} ${j.minimumWage.amount}/${j.minimumWage.unit} as at ${j.minimumWage.rateAsOf}`
                : " · no minimum wage in the library"}
              <br />
              <span className="italic">{j.citation}</span>
            </p>
          ) : null}
        </CardBody>
      </Card>

      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}

      {compliance ? (
        <Card>
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-body font-medium">Working time and wages</h3>
              <span className="text-meta text-content-muted">
                {compliance.workers} worker(s) assessed
                {compliance.signalsRaised !== undefined
                  ? ` · ${compliance.signalsRaised} signal(s) raised, ${compliance.flagsRaised ?? 0} risk flag(s)`
                  : " · replayed, nothing persisted"}
              </span>
            </div>
            {compliance.reasons.length > 0 ? (
              <Alert tone="info" title="What could not be assessed, and why">
                <ul className="list-disc space-y-1 pl-4 text-meta">
                  {compliance.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {compliance.findings.length === 0 ? (
              <EmptyState
                title="No findings in this window"
                description="Nothing in the hours or the payroll breached the limits this jurisdiction sets. That is a statement about what was measured, not a clean bill of health for what was not."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Worker</Th>
                    <Th>Finding</Th>
                    <Th>Basis</Th>
                    <Th align="right">At risk</Th>
                  </tr>
                </thead>
                <tbody>
                  {compliance.findings.map((f, i) => (
                    <tr key={i}>
                      <Td>
                        <span className="font-mono text-meta">{f.reference}</span>
                      </Td>
                      <Td>
                        <div className="space-y-1">
                          <Badge tone={severityTone(f.severity)}>{label(f.detector)}</Badge>
                          <p className="text-meta">{f.title}</p>
                          <p className="text-2xs text-content-muted">{f.explanation}</p>
                        </div>
                      </Td>
                      <Td className="max-w-[20rem] text-2xs text-content-muted">{f.citation}</Td>
                      <Td align="right">
                        {f.amountAtRisk !== null && f.currency
                          ? fmtMoney(f.amountAtRisk, f.currency)
                          : "—"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      ) : busy === "load" ? (
        <Spinner />
      ) : null}

      {position ? (
        <Card>
          <CardBody className="space-y-3">
            <h3 className="text-body font-medium">Labour position — approved, paid, present</h3>
            <p className="text-meta text-content-muted">{position.method}</p>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Approved hours" value={fmtNum(position.totals.approvedHours, 1)} />
              <Stat
                label="Paid hours"
                value={
                  position.totals.paidHours === null
                    ? "Not available"
                    : fmtNum(position.totals.paidHours, 1)
                }
                hint={
                  position.totals.paidHours === null
                    ? "at least one worker has no comparable payroll hours"
                    : undefined
                }
              />
              <Stat
                label="Awaiting payroll"
                value={String(position.totals.workersAwaitingPayroll)}
              />
              <Stat
                label="Findings"
                value={String(position.findings.length)}
                tone={position.findings.length > 0 ? "red" : "green"}
              />
            </div>
            {position.moneyAtRisk.length > 0 ? (
              <div className="flex flex-wrap gap-3">
                {position.moneyAtRisk.map((m) => (
                  <div key={m.currency} className="rounded-md border border-border px-3 py-2">
                    <div className="text-2xs uppercase tracking-wide text-content-muted">
                      {m.currency}
                    </div>
                    <div className="text-meta">
                      paid over approved {fmtMoney(m.overpaid, m.currency)} · approved but unpaid{" "}
                      {fmtMoney(m.unpaid, m.currency)}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {position.reasons.length > 0 ? (
              <Alert tone="info" title="Why some totals are stated as unknown">
                <ul className="list-disc space-y-1 pl-4 text-meta">
                  {position.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {position.rows.length === 0 ? (
              <EmptyState title="No workers on this project" description="" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Worker</Th>
                    <Th>Employer</Th>
                    <Th align="right">Approved h</Th>
                    <Th align="right">Paid h</Th>
                    <Th align="right">Difference</Th>
                    <Th align="right">Access days</Th>
                    <Th align="right">Implied rate</Th>
                    <Th>Position</Th>
                  </tr>
                </thead>
                <tbody>
                  {position.rows.map((r) => (
                    <tr key={r.workerId}>
                      <Td>
                        <span className="font-mono text-meta">{r.reference}</span>{" "}
                        <span className="text-content-muted">{r.fullName}</span>
                      </Td>
                      <Td>{r.vendorName ?? "—"}</Td>
                      <Td align="right">{fmtNum(r.approvedHours, 1)}</Td>
                      <Td align="right">
                        {r.paidHours === null ? (
                          <span className="text-content-muted">Not available</span>
                        ) : (
                          fmtNum(r.paidHours, 1)
                        )}
                      </Td>
                      <Td align="right">
                        {r.hoursDifference === null
                          ? "—"
                          : `${r.hoursDifference > 0 ? "+" : ""}${fmtNum(r.hoursDifference, 1)}`}
                      </Td>
                      <Td align="right">{r.accessDays}</Td>
                      <Td align="right">
                        {r.impliedHourlyRate === null
                          ? "—"
                          : fmtMoney(r.impliedHourlyRate, r.payrollCurrency ?? "USD")}
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONE[r.status] ?? "gray"}>{label(r.status)}</Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
