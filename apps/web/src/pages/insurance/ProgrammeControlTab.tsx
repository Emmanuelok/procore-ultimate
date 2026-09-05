/**
 * Programme control — the four registers the workspace had no surface for.
 *
 *   · Facilities   — the bonding line, and therefore headroom (#796)
 *   · Requirements — what the contract actually demands, per scope
 *   · Renewals     — the pipeline, measured against a lead time (#775)
 *   · Experience   — premium against claims incurred, per currency (#782)
 *
 * The honesty rules of this workspace hold here without exception. Headroom is
 * refused across currencies and a foreign-currency bond drawn against a line is
 * listed as excluded rather than converted at a rate nobody recorded. A loss
 * ratio with no premium behind it is "—" with the API's own reason printed next
 * to it. And an empty requirements register says in terms that this is not a
 * finding of compliance — the two are different answers and the page must never
 * let them look alike.
 */
import { useCallback, useEffect, useState } from "react";
import { BOND_TYPES, POLICY_TYPES } from "@constructos/shared";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Textarea,
} from "../../ui";
import { formatDate } from "../format";
import {
  Caveat,
  ConfirmStrip,
  DeadlineChip,
  Disclosure,
  Drawer,
  SectionTitle,
  StatCard,
  bondTypeLabel,
  errMsg,
  fmtMoney,
  fmtNum,
  fmtPct,
  policyTypeLabel,
} from "./insuranceShared";

/* ================================= Types ================================== */

interface FacilityUtilisation {
  facilityId: string;
  currency: string;
  limitAmount: number;
  drawnAmount: number;
  headroom: number | null;
  utilisationPct: number | null;
  bondCount: number;
  excludedForeignCurrency: { bondId: string; currency: string; amount: number }[];
  outsidePermittedTypes: string[];
  inForce: boolean | null;
  daysToReview: number | null;
  reasons: string[];
}

interface FacilityRow {
  id: string;
  number: string;
  name: string;
  provider: string;
  projectId: string | null;
  facilityReference: string | null;
  limitAmount: number;
  currency: string;
  permittedBondTypes: string[];
  commissionRatePct: number | null;
  collateralAmount: number | null;
  collateralNote: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  reviewDate: string | null;
  status: string;
  notes: string | null;
  utilisation: FacilityUtilisation;
  bonds: {
    id: string;
    number: string;
    bondType: string;
    status: string;
    amount: number;
    currency: string;
    currentAmount: number;
    expiryAt: string | null;
  }[];
}

interface FacilityList {
  items: FacilityRow[];
  total: number;
  page: number;
  pageSize: number;
  headroomByCurrency: {
    currency: string;
    limit: number;
    drawn: number;
    headroom: number;
    utilisationPct: number | null;
  }[];
  note: string | null;
}

interface RequirementRow {
  id: string;
  projectId: string | null;
  vendorId: string | null;
  policyType: string;
  requiredByClause: string;
  minimumLimit: number | null;
  limitBasis: string | null;
  currency: string;
  maximumDeductible: number | null;
  waiverOfSubrogation: number;
  additionalInsuredRequired: number;
  maintainMonthsAfterCompletion: number | null;
  territorialLimits: string | null;
  notes: string | null;
  status: string;
  waivedBy: string | null;
  waivedAt: string | null;
  waiverReason: string | null;
  scope?: string;
}

interface RequirementList {
  items: RequirementRow[];
  total: number;
  page: number;
  pageSize: number;
  note: string | null;
}

interface WordingFinding {
  code: string;
  severity: "critical" | "high" | "medium" | "low";
  requirementId: string;
  requiredByClause: string;
  policyType: string;
  policyId: string | null;
  policyNumber: string | null;
  detail: string;
}

interface WordingCheck {
  requirementId: string;
  policyType: string;
  requiredByClause: string;
  satisfiedBy: string | null;
  compliant: boolean;
  findings: WordingFinding[];
}

interface WordingReport {
  asOf: string;
  requirements: number;
  compliant: number;
  nonCompliant: number;
  checks: WordingCheck[];
  findingsBySeverity: { critical: number; high: number; medium: number; low: number };
  note: string;
}

interface PeriodGap {
  policyType: string;
  requiredByClause: string | null;
  uncoveredAtStartDays: number;
  uncoveredAtEndDays: number;
  policyNumber: string | null;
  policyPeriod: { start: string; end: string } | null;
  worksStart: string;
  worksEnd: string;
  key: string;
  detail: string;
}

interface PeriodReport {
  worksStart: string | null;
  worksEnd: string | null;
  requirements: number;
  gaps: PeriodGap[];
  reasons: string[];
}

interface RenewalRow {
  policyId: string;
  number: string;
  projectId: string | null;
  policyType: string;
  insurer: string;
  periodEnd: string;
  daysToExpiry: number;
  renewalStatus: string;
  renewalOwnerId: string | null;
  renewalTargetDate: string | null;
  behindByDays: number | null;
  urgency: "overdue" | "critical" | "warning" | "on_track";
  reason: string;
}

interface RenewalReport {
  asOf: string;
  horizonDays: number;
  leadTimeDays: number;
  items: RenewalRow[];
  total: number;
  byUrgency: { overdue: number; critical: number; warning: number; on_track: number };
  note: string | null;
}

interface ExperienceBucket {
  currency: string;
  premiumWritten: number;
  premiumReturned: number;
  premiumNet: number;
  brokerFees: number;
  levies: number;
  claimsPaid: number;
  claimsReserved: number;
  claimsIncurred: number;
  claimCount: number;
  openClaimCount: number;
  lossRatioPct: number | null;
  reasons: string[];
}

interface ExperienceByType {
  policyType: string;
  byCurrency: ExperienceBucket[];
  note: string | null;
}

interface ExperienceReport {
  asOf: string;
  byCurrency: ExperienceBucket[];
  byPolicyType: ExperienceByType[];
  currencyMismatches: { premiumId: string; policyId: string }[];
  note: string | null;
  inputs: { premiumRows: number; claimRows: number };
}

const RENEWAL_STATUSES = [
  "not_started",
  "instructed",
  "quotes_requested",
  "quotes_received",
  "bound",
  "not_renewing",
] as const;

const RENEWAL_STATUS_LABELS: Record<string, string> = {
  not_started: "Not started",
  instructed: "Broker instructed",
  quotes_requested: "Quotes requested",
  quotes_received: "Quotes received",
  bound: "Bound",
  not_renewing: "Not renewing",
};

const URGENCY_TONE: Record<string, string> = {
  overdue: "bg-red-100 text-red-800 ring-red-200",
  critical: "bg-red-50 text-red-800 ring-red-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  on_track: "bg-emerald-50 text-emerald-800 ring-emerald-200",
};

const FINDING_TONE: Record<string, string> = {
  critical: "bg-red-100 text-red-900 ring-red-200",
  high: "bg-red-50 text-red-800 ring-red-200",
  medium: "bg-amber-50 text-amber-800 ring-amber-200",
  low: "bg-ink-50 text-ink-700 ring-ink-200",
};

const SUB_TABS = [
  { key: "facilities", label: "Bonding lines" },
  { key: "requirements", label: "Requirements" },
  { key: "renewals", label: "Renewals" },
  { key: "experience", label: "Experience" },
] as const;

type SubTab = (typeof SUB_TABS)[number]["key"];

/* ================================ The tab ================================= */

export default function ProgrammeControlTab({ projectId }: { projectId: string }) {
  const [sub, setSub] = useState<SubTab>("facilities");
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSub(t.key)}
            className={
              sub === t.key
                ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white"
                : "rounded-full bg-white px-3 py-1 text-xs font-medium text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {sub === "facilities" ? <FacilitiesPanel /> : null}
      {sub === "requirements" ? <RequirementsPanel projectId={projectId} /> : null}
      {sub === "renewals" ? <RenewalsPanel projectId={projectId} /> : null}
      {sub === "experience" ? <ExperiencePanel projectId={projectId} /> : null}
    </div>
  );
}

/* ============================== Facilities ================================ */

function FacilitiesPanel() {
  const [data, setData] = useState<FacilityList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<FacilityRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<FacilityList>("/api/v1/insurance/facilities?pageSize=100"));
    } catch (err) {
      setData(null);
      setError(errMsg(err, "Failed to load the bonding facilities"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner />;
  if (error) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-3xl text-sm leading-relaxed text-ink-500">
          A bond is drawn against a line a surety or bank has agreed. Without the line recorded,
          headroom is not computable at all — you can list the bonds you have given but not the
          ceiling they sit under, and a tender is then bid on a hope.
        </p>
        <Button onClick={() => setCreating(true)}>Record a facility</Button>
      </div>

      {data.headroomByCurrency.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {data.headroomByCurrency.map((h) => (
            <StatCard
              key={h.currency}
              label={`Headroom · ${h.currency}`}
              value={fmtMoney(h.headroom, h.currency, 0)}
              tone={
                h.utilisationPct !== null && h.utilisationPct >= 90
                  ? "red"
                  : h.utilisationPct !== null && h.utilisationPct >= 70
                    ? "amber"
                    : "green"
              }
              hint={`${fmtMoney(h.drawn, h.currency, 0)} drawn of ${fmtMoney(h.limit, h.currency, 0)} · ${fmtPct(h.utilisationPct)}`}
              title="In-force facilities only, one currency at a time. Lines in different currencies are never added together."
              emphasized
            />
          ))}
        </div>
      ) : null}

      {data.note ? <Disclosure label="Why there is no headroom figure">{data.note}</Disclosure> : null}

      {data.items.length === 0 ? (
        <EmptyState
          title="No bonding line recorded"
          description="Record the facility your surety or bank has agreed, and every bond drawn against it will net off the line automatically."
        />
      ) : (
        <Card>
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Facility</Th>
                  <Th>Provider</Th>
                  <Th className="text-right">Limit</Th>
                  <Th className="text-right">Drawn</Th>
                  <Th className="text-right">Headroom</Th>
                  <Th>Status</Th>
                  <Th>Review</Th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((f) => (
                  <tr
                    key={f.id}
                    className="cursor-pointer hover:bg-ink-50"
                    onClick={() => setOpen(f)}
                  >
                    <Td>
                      <div className="font-medium text-ink-900">{f.number}</div>
                      <div className="text-xs text-ink-500">{f.name}</div>
                    </Td>
                    <Td>{f.provider}</Td>
                    <Td className="text-right tabular-nums">
                      {fmtMoney(f.limitAmount, f.currency, 0)}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {fmtMoney(f.utilisation.drawnAmount, f.currency, 0)}
                      <div className="text-xs text-ink-400">
                        {f.utilisation.bondCount} bond{f.utilisation.bondCount === 1 ? "" : "s"}
                      </div>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {f.utilisation.headroom === null ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        <span
                          className={
                            f.utilisation.headroom < 0
                              ? "font-semibold text-red-700"
                              : "text-ink-900"
                          }
                        >
                          {fmtMoney(f.utilisation.headroom, f.currency, 0)}
                        </span>
                      )}
                      <div className="text-xs text-ink-400">{fmtPct(f.utilisation.utilisationPct)}</div>
                    </Td>
                    <Td>
                      <Badge tone={f.status === "active" ? "green" : f.status === "closed" ? "gray" : "amber"}>
                        {f.status}
                      </Badge>
                    </Td>
                    <Td>
                      {f.reviewDate ? (
                        <DeadlineChip
                          days={f.utilisation.daysToReview}
                          suffix={formatDate(f.reviewDate)}
                        />
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      {creating ? (
        <FacilityForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      ) : null}
      {open ? (
        <FacilityDrawer
          facility={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function FacilityForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [limitAmount, setLimitAmount] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [reference, setReference] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [reviewDate, setReviewDate] = useState("");
  const [permitted, setPermitted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/insurance/facilities", {
        name,
        provider,
        limitAmount: Number(limitAmount),
        currency,
        facilityReference: reference || null,
        effectiveFrom: effectiveFrom || null,
        effectiveTo: effectiveTo || null,
        reviewDate: reviewDate || null,
        permittedBondTypes: permitted,
      });
      onSaved();
    } catch (err) {
      setError(errMsg(err, "Could not record the facility"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open title="Record a bonding facility" onClose={onClose}>
      <div className="space-y-3">
        {error ? <ErrorAlert message={error} /> : null}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Surety line 2026" />
        </Field>
        <Field label="Provider (surety, bank or insurer)">
          <Input value={provider} onChange={(e) => setProvider(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Limit">
            <Input
              type="number"
              value={limitAmount}
              onChange={(e) => setLimitAmount(e.target.value)}
            />
          </Field>
          <Field label="Currency" hint="One currency per line — headroom is never netted across two">
            <Input
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </Field>
        </div>
        <Field label="Facility reference">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Effective from">
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </Field>
          <Field label="Effective to">
            <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
          </Field>
          <Field label="Review date">
            <Input type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Permitted bond types" hint="Leave empty to permit any type">
          <div className="flex flex-wrap gap-1.5">
            {BOND_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() =>
                  setPermitted((prev) =>
                    prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                  )
                }
                className={
                  permitted.includes(t)
                    ? "rounded-full bg-brand-600 px-2.5 py-1 text-xs font-medium text-white"
                    : "rounded-full bg-white px-2.5 py-1 text-xs font-medium text-ink-600 ring-1 ring-ink-200"
                }
              >
                {bondTypeLabel(t)}
              </button>
            ))}
          </div>
        </Field>
        <div className="flex gap-2 pt-1">
          <Button onClick={() => void submit()} disabled={busy || !name || !provider || !limitAmount}>
            {busy ? "Saving…" : "Record facility"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

function FacilityDrawer({
  facility,
  onClose,
  onChanged,
}: {
  facility: FacilityRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const transition = async (status: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/insurance/facilities/${facility.id}/status`, { status });
      onChanged();
    } catch (err) {
      setError(errMsg(err, `Could not move the facility to ${status}`));
      setConfirmClose(false);
    } finally {
      setBusy(false);
    }
  };

  const u = facility.utilisation;
  return (
    <Drawer open wide title={`${facility.number} · ${facility.name}`} onClose={onClose}>
      <div className="space-y-4">
        {error ? <ErrorAlert message={error} /> : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Limit" value={fmtMoney(facility.limitAmount, facility.currency, 0)} />
          <StatCard label="Drawn" value={fmtMoney(u.drawnAmount, facility.currency, 0)} />
          <StatCard
            label="Headroom"
            value={u.headroom === null ? "—" : fmtMoney(u.headroom, facility.currency, 0)}
            tone={u.headroom !== null && u.headroom < 0 ? "red" : "green"}
            hint={fmtPct(u.utilisationPct)}
          />
        </div>

        {u.reasons.length > 0 ? (
          <div className="space-y-2">
            {u.reasons.map((r) => (
              <Disclosure key={r} label="What this figure does not include">
                {r}
              </Disclosure>
            ))}
          </div>
        ) : null}

        <SectionTitle>Bonds drawn against this line</SectionTitle>
        {facility.bonds.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing is drawn against this line.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Bond</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th className="text-right">Face</Th>
                <Th className="text-right">Current</Th>
                <Th>Expires</Th>
              </tr>
            </thead>
            <tbody>
              {facility.bonds.map((b) => (
                <tr key={b.id}>
                  <Td className="font-medium">{b.number}</Td>
                  <Td>{bondTypeLabel(b.bondType)}</Td>
                  <Td>
                    <Badge tone={b.status === "released" ? "gray" : "green"}>{b.status}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{fmtMoney(b.amount, b.currency, 0)}</Td>
                  <Td className="text-right tabular-nums">
                    {fmtMoney(b.currentAmount, b.currency, 0)}
                  </Td>
                  <Td>{b.expiryAt ? formatDate(b.expiryAt) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <SectionTitle>Facility</SectionTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-500">Provider</dt>
          <dd className="text-ink-900">{facility.provider}</dd>
          <dt className="text-ink-500">Reference</dt>
          <dd className="text-ink-900">{facility.facilityReference ?? "—"}</dd>
          <dt className="text-ink-500">Period</dt>
          <dd className="text-ink-900">
            {facility.effectiveFrom ? formatDate(facility.effectiveFrom) : "—"} →{" "}
            {facility.effectiveTo ? formatDate(facility.effectiveTo) : "—"}
          </dd>
          <dt className="text-ink-500">Commission</dt>
          <dd className="text-ink-900">{fmtPct(facility.commissionRatePct, 2)}</dd>
          <dt className="text-ink-500">Collateral</dt>
          <dd className="text-ink-900">
            {facility.collateralAmount === null
              ? "—"
              : fmtMoney(facility.collateralAmount, facility.currency, 0)}
          </dd>
          <dt className="text-ink-500">Permitted types</dt>
          <dd className="text-ink-900">
            {facility.permittedBondTypes.length === 0
              ? "Any"
              : facility.permittedBondTypes.map(bondTypeLabel).join(", ")}
          </dd>
        </dl>

        <div className="flex flex-wrap gap-2 border-t border-ink-200 pt-3">
          {facility.status === "draft" ? (
            <Button disabled={busy} onClick={() => void transition("active")}>
              Activate
            </Button>
          ) : null}
          {facility.status === "active" ? (
            <Button variant="secondary" disabled={busy} onClick={() => void transition("suspended")}>
              Suspend
            </Button>
          ) : null}
          {facility.status === "suspended" ? (
            <Button disabled={busy} onClick={() => void transition("active")}>
              Reinstate
            </Button>
          ) : null}
          {facility.status !== "closed" ? (
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmClose(true)}>
              Close
            </Button>
          ) : null}
        </div>
        {confirmClose ? (
          <ConfirmStrip
            message="Closing a facility is refused while any bond is still drawn against it — a closed line that still secures live bonds hides outstanding security."
            confirmLabel="Close the facility"
            busy={busy}
            onConfirm={() => void transition("closed")}
            onCancel={() => setConfirmClose(false)}
          />
        ) : null}
      </div>
    </Drawer>
  );
}

/* ============================= Requirements =============================== */

function RequirementsPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<RequirementList | null>(null);
  const [wording, setWording] = useState<WordingReport | null>(null);
  const [period, setPeriod] = useState<PeriodReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wordingError, setWordingError] = useState<string | null>(null);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [waiving, setWaiving] = useState<RequirementRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.get<RequirementList>(
          `/api/v1/projects/${projectId}/insurance/requirements?pageSize=100`,
        ),
      );
    } catch (err) {
      setData(null);
      setError(errMsg(err, "Failed to load the insurance requirements"));
    } finally {
      setLoading(false);
    }
    setWordingError(null);
    try {
      setWording(
        await api.get<WordingReport>(`/api/v1/projects/${projectId}/insurance/wording-checks`),
      );
    } catch (err) {
      setWording(null);
      setWordingError(errMsg(err, "Failed to test the wordings against the requirements"));
    }
    setPeriodError(null);
    try {
      setPeriod(
        await api.get<PeriodReport>(`/api/v1/projects/${projectId}/insurance/period-cover`),
      );
    } catch (err) {
      setPeriod(null);
      setPeriodError(errMsg(err, "Failed to compare the policy periods with the works"));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-3xl text-sm leading-relaxed text-ink-500">
          A requirement is a reading of a clause: a policy type, a limit and the endorsements the
          wording must contain. Until one is recorded the platform will say the answer is not known
          — never that the cover is compliant.
        </p>
        <Button onClick={() => setCreating(true)}>Record a requirement</Button>
      </div>

      {error ? <ErrorAlert message={error} onRetry={() => void load()} /> : null}
      {data?.note ? <Caveat>{data.note}</Caveat> : null}

      {data && data.items.length > 0 ? (
        <Card>
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Cover</Th>
                  <Th>Required by</Th>
                  <Th className="text-right">Minimum limit</Th>
                  <Th>Endorsements</Th>
                  <Th>Scope</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <Td className="font-medium text-ink-900">{policyTypeLabel(r.policyType)}</Td>
                    <Td className="text-ink-700">{r.requiredByClause}</Td>
                    <Td className="text-right tabular-nums">
                      {r.minimumLimit === null ? (
                        <span className="text-ink-400" title="No minimum limit recorded on this requirement">
                          —
                        </span>
                      ) : (
                        fmtMoney(r.minimumLimit, r.currency, 0)
                      )}
                    </Td>
                    <Td className="text-xs text-ink-600">
                      {[
                        r.waiverOfSubrogation === 1 ? "Waiver of subrogation" : null,
                        r.additionalInsuredRequired === 1 ? "Additional insured" : null,
                        r.maintainMonthsAfterCompletion !== null
                          ? `Maintain ${r.maintainMonthsAfterCompletion}m after completion`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </Td>
                    <Td>
                      <Badge tone={r.projectId ? "brand" : "gray"}>
                        {r.projectId ? "This project" : "Company standard"}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge tone={r.status === "required" ? "amber" : "gray"}>{r.status}</Badge>
                      {r.waiverReason ? (
                        <div className="mt-0.5 max-w-xs text-xs text-ink-500">{r.waiverReason}</div>
                      ) : null}
                    </Td>
                    <Td>
                      {r.status === "required" && r.projectId ? (
                        <Button variant="secondary" onClick={() => setWaiving(r)}>
                          Waive
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      ) : (
        <EmptyState
          title="No requirement recorded for this project"
          description="Record the cover the contract demands, clause by clause. Cover gaps, wording checks and payment holds are all measured against these rows."
        />
      )}

      <SectionTitle>Wording compliance</SectionTitle>
      {wordingError ? <ErrorAlert message={wordingError} /> : null}
      {wording ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <StatCard label="Requirements" value={fmtNum(wording.requirements)} />
            <StatCard label="Satisfied" value={fmtNum(wording.compliant)} tone="green" />
            <StatCard label="Not satisfied" value={fmtNum(wording.nonCompliant)} tone="red" />
            <StatCard
              label="Critical findings"
              value={fmtNum(wording.findingsBySeverity.critical)}
              tone={wording.findingsBySeverity.critical > 0 ? "red" : undefined}
            />
          </div>
          <Disclosure label="What this check can and cannot see">{wording.note}</Disclosure>
          {wording.checks
            .filter((c) => !c.compliant)
            .map((c) => (
              <Card key={c.requirementId}>
                <CardBody className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-ink-900">
                      {policyTypeLabel(c.policyType)}
                    </div>
                    <div className="text-xs text-ink-500">{c.requiredByClause}</div>
                  </div>
                  {c.findings.map((f, i) => (
                    <div
                      key={`${f.code}-${i}`}
                      className={`rounded-md px-3 py-2 text-xs leading-relaxed ring-1 ${FINDING_TONE[f.severity] ?? FINDING_TONE.low}`}
                    >
                      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide opacity-70">
                        {f.code.replace(/_/g, " ")}
                        {f.policyNumber ? ` · ${f.policyNumber}` : ""}
                      </span>
                      {f.detail}
                    </div>
                  ))}
                </CardBody>
              </Card>
            ))}
        </div>
      ) : null}

      <SectionTitle>Policy period against the works</SectionTitle>
      {periodError ? <ErrorAlert message={periodError} /> : null}
      {period ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-500">
            Works {period.worksStart ? formatDate(period.worksStart) : "—"} →{" "}
            {period.worksEnd ? formatDate(period.worksEnd) : "—"}
          </p>
          {period.reasons.map((r) => (
            <Disclosure key={r} label="Why no answer is given">
              {r}
            </Disclosure>
          ))}
          {period.gaps.length === 0 && period.reasons.length === 0 ? (
            <p className="text-sm text-emerald-700">
              Every required class of cover spans the works from start to finish.
            </p>
          ) : null}
          {period.gaps.map((g) => (
            <div
              key={g.key}
              className="rounded-md bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900 ring-1 ring-red-200"
            >
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide opacity-70">
                {policyTypeLabel(g.policyType)}
                {g.requiredByClause ? ` · ${g.requiredByClause}` : ""} ·{" "}
                {g.uncoveredAtStartDays}d at the start, {g.uncoveredAtEndDays}d at the end
              </span>
              {g.detail}
            </div>
          ))}
        </div>
      ) : null}

      {creating ? (
        <RequirementForm
          projectId={projectId}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      ) : null}
      {waiving ? (
        <WaiveForm
          projectId={projectId}
          requirement={waiving}
          onClose={() => setWaiving(null)}
          onSaved={() => {
            setWaiving(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function RequirementForm({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [policyType, setPolicyType] = useState<string>(POLICY_TYPES[0]);
  const [clause, setClause] = useState("");
  const [minimumLimit, setMinimumLimit] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [maximumDeductible, setMaximumDeductible] = useState("");
  const [waiver, setWaiver] = useState(false);
  const [additionalInsured, setAdditionalInsured] = useState(false);
  const [maintainMonths, setMaintainMonths] = useState("");
  const [territorial, setTerritorial] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/insurance/requirements`, {
        policyType,
        requiredByClause: clause,
        minimumLimit: minimumLimit ? Number(minimumLimit) : null,
        currency,
        maximumDeductible: maximumDeductible ? Number(maximumDeductible) : null,
        waiverOfSubrogation: waiver,
        additionalInsuredRequired: additionalInsured,
        maintainMonthsAfterCompletion: maintainMonths ? Number(maintainMonths) : null,
        territorialLimits: territorial || null,
      });
      onSaved();
    } catch (err) {
      setError(errMsg(err, "Could not record the requirement"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open title="Record an insurance requirement" onClose={onClose}>
      <div className="space-y-3">
        {error ? <ErrorAlert message={error} /> : null}
        <Field label="Cover required">
          <Select value={policyType} onChange={(e) => setPolicyType(e.target.value)}>
            {POLICY_TYPES.map((t) => (
              <option key={t} value={t}>
                {policyTypeLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Required by clause"
          hint="A requirement with no clause is an opinion — this is mandatory"
        >
          <Input value={clause} onChange={(e) => setClause(e.target.value)} placeholder="FIDIC 18.2" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Minimum limit">
            <Input
              type="number"
              value={minimumLimit}
              onChange={(e) => setMinimumLimit(e.target.value)}
            />
          </Field>
          <Field label="Currency">
            <Input
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Max deductible">
            <Input
              type="number"
              value={maximumDeductible}
              onChange={(e) => setMaximumDeductible(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Maintain (months after completion)">
          <Input
            type="number"
            value={maintainMonths}
            onChange={(e) => setMaintainMonths(e.target.value)}
          />
        </Field>
        <Field label="Territorial limits">
          <Input value={territorial} onChange={(e) => setTerritorial(e.target.value)} />
        </Field>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={waiver}
              onChange={(e) => setWaiver(e.target.checked)}
              className="rounded border-ink-300"
            />
            Waiver of subrogation required
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={additionalInsured}
              onChange={(e) => setAdditionalInsured(e.target.checked)}
              className="rounded border-ink-300"
            />
            Named as additional insured
          </label>
        </div>
        <div className="flex gap-2 pt-1">
          <Button onClick={() => void submit()} disabled={busy || !clause}>
            {busy ? "Saving…" : "Record requirement"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

function WaiveForm({
  projectId,
  requirement,
  onClose,
  onSaved,
}: {
  projectId: string;
  requirement: RequirementRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/api/v1/projects/${projectId}/insurance/requirements/${requirement.id}/waive`,
        { reason },
      );
      onSaved();
    } catch (err) {
      setError(errMsg(err, "Could not waive the requirement"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open title={`Waive ${policyTypeLabel(requirement.policyType)}`} onClose={onClose}>
      <div className="space-y-3">
        {error ? <ErrorAlert message={error} /> : null}
        <Caveat>
          Waiving is a decision, not an edit: it records who took it and why, and the requirement
          stops driving cover gaps and payment holds from that moment. A requirement that quietly
          stops existing is how a cover gap becomes invisible rather than accepted.
        </Caveat>
        <Field label="Reason" hint={`Required by ${requirement.requiredByClause}`}>
          <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button onClick={() => void submit()} disabled={busy || reason.trim().length === 0}>
            {busy ? "Recording…" : "Waive the requirement"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

/* =============================== Renewals ================================= */

function RenewalsPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<RenewalReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RenewalRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.get<RenewalReport>(`/api/v1/projects/${projectId}/insurance/renewals`),
      );
    } catch (err) {
      setData(null);
      setError(errMsg(err, "Failed to load the renewal pipeline"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner />;
  if (error) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-ink-500">
        Renewal is measured against a lead time, not the expiry date. A renewal started the week
        before expiry has already failed even though nothing has expired yet: terms harden and cover
        narrows in the last fortnight.
      </p>

      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="Expired, unrenewed" value={fmtNum(data.byUrgency.overdue)} tone="red" emphasized={data.byUrgency.overdue > 0} />
        <StatCard label="Past the lead time" value={fmtNum(data.byUrgency.critical)} tone="red" />
        <StatCard label="Inside the lead time" value={fmtNum(data.byUrgency.warning)} tone="amber" />
        <StatCard label="Still in time" value={fmtNum(data.byUrgency.on_track)} tone="green" />
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          title="Nothing in the renewal window"
          description={data.note ?? `No policy expires within ${data.horizonDays} days.`}
        />
      ) : (
        <Card>
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Policy</Th>
                  <Th>Insurer</Th>
                  <Th>Expires</Th>
                  <Th>Pipeline</Th>
                  <Th>Why</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.policyId}>
                    <Td>
                      <div className="font-medium text-ink-900">{r.number}</div>
                      <div className="text-xs text-ink-500">{policyTypeLabel(r.policyType)}</div>
                    </Td>
                    <Td>{r.insurer}</Td>
                    <Td>
                      <div>{formatDate(r.periodEnd)}</div>
                      <span
                        className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${URGENCY_TONE[r.urgency] ?? ""}`}
                      >
                        {r.daysToExpiry < 0
                          ? `${-r.daysToExpiry}d ago`
                          : `${r.daysToExpiry}d`}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={r.renewalStatus === "not_started" ? "red" : "amber"}>
                        {RENEWAL_STATUS_LABELS[r.renewalStatus] ?? r.renewalStatus}
                      </Badge>
                      {r.behindByDays !== null ? (
                        <div className="mt-0.5 text-xs font-medium text-red-700">
                          {r.behindByDays}d late
                        </div>
                      ) : null}
                    </Td>
                    <Td className="max-w-md text-xs leading-relaxed text-ink-600">{r.reason}</Td>
                    <Td>
                      <Button variant="secondary" onClick={() => setEditing(r)}>
                        Update
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      {editing ? (
        <RenewalForm
          projectId={projectId}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function RenewalForm({
  projectId,
  row,
  onClose,
  onSaved,
}: {
  projectId: string;
  row: RenewalRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState(row.renewalStatus);
  const [targetDate, setTargetDate] = useState(row.renewalTargetDate ?? "");
  const [renewedBy, setRenewedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/api/v1/projects/${projectId}/insurance/policies/${row.policyId}/renewal`,
        {
          renewalStatus: status,
          renewalTargetDate: targetDate || null,
          renewalNotes: notes || null,
          renewedByPolicyId: renewedBy || null,
        },
      );
      onSaved();
    } catch (err) {
      setError(errMsg(err, "Could not update the renewal"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open title={`Renewal · ${row.number}`} onClose={onClose}>
      <div className="space-y-3">
        {error ? <ErrorAlert message={error} /> : null}
        <p className="text-sm leading-relaxed text-ink-600">{row.reason}</p>
        <Field label="Pipeline stage">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {RENEWAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {RENEWAL_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Target date for binding">
          <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </Field>
        <Field
          label="Policy id of the renewal"
          hint="Required to mark this renewal bound — 'bound' with no successor is the state a lapse hides in"
        >
          <Input
            value={renewedBy}
            onChange={(e) => setRenewedBy(e.target.value)}
            placeholder="pol_…"
          />
        </Field>
        <Field label="Notes">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : "Update the renewal"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

/* ============================== Experience ================================ */

function ExperiencePanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ExperienceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.get<ExperienceReport>(`/api/v1/projects/${projectId}/insurance/experience`),
      );
    } catch (err) {
      setData(null);
      setError(errMsg(err, "Failed to load the claims experience"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner />;
  if (error) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-ink-500">
        Claims incurred over premium earned is the number that decides next year's renewal. It is
        computed per currency and never across, from {fmtNum(data.inputs.premiumRows)} premium
        movement{data.inputs.premiumRows === 1 ? "" : "s"} and {fmtNum(data.inputs.claimRows)} claim
        {data.inputs.claimRows === 1 ? "" : "s"}.
      </p>

      {data.byCurrency.length === 0 ? (
        <EmptyState
          title="No premium or claim recorded"
          description="Record the premium instalments against each policy — the loss ratio cannot be computed from the policy record alone, because premium is paid in instalments, adjusted at audit and partly returned."
        />
      ) : null}

      {data.byCurrency.map((b) => (
        <Card key={b.currency}>
          <CardBody className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-ink-900">{b.currency}</h3>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wide text-ink-400">Loss ratio</div>
                <div
                  className={`text-2xl font-semibold tabular-nums ${
                    b.lossRatioPct === null
                      ? "text-ink-400"
                      : b.lossRatioPct >= 100
                        ? "text-red-700"
                        : b.lossRatioPct >= 70
                          ? "text-amber-700"
                          : "text-emerald-700"
                  }`}
                >
                  {b.lossRatioPct === null ? "—" : fmtPct(b.lossRatioPct)}
                </div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard label="Written" value={fmtMoney(b.premiumWritten, b.currency, 0)} />
              <StatCard label="Returned" value={fmtMoney(b.premiumReturned, b.currency, 0)} />
              <StatCard label="Net premium" value={fmtMoney(b.premiumNet, b.currency, 0)} tone="brand" />
              <StatCard label="Claims paid" value={fmtMoney(b.claimsPaid, b.currency, 0)} />
              <StatCard label="Reserved" value={fmtMoney(b.claimsReserved, b.currency, 0)} />
              <StatCard
                label="Incurred"
                value={fmtMoney(b.claimsIncurred, b.currency, 0)}
                hint={`${b.claimCount} claim${b.claimCount === 1 ? "" : "s"}, ${b.openClaimCount} open`}
              />
            </div>
            {b.reasons.map((r) => (
              <Disclosure key={r} label="Why the ratio is not reported">
                {r}
              </Disclosure>
            ))}
          </CardBody>
        </Card>
      ))}

      {data.note ? <Disclosure label="What is counted but not valued">{data.note}</Disclosure> : null}
      {data.currencyMismatches.length > 0 ? (
        <Disclosure label="Data fault" tone="red">
          {data.currencyMismatches.length} premium row(s) are recorded in a different currency from
          their policy. They are bucketed by their own currency, so neither bucket is what the
          policy actually costs.
        </Disclosure>
      ) : null}

      {data.byPolicyType.length > 0 ? (
        <>
          <SectionTitle>By class of cover</SectionTitle>
          <Card>
            <CardBody className="p-0">
              <Table>
                <thead>
                  <tr>
                    <Th>Cover</Th>
                    <Th>Currency</Th>
                    <Th className="text-right">Net premium</Th>
                    <Th className="text-right">Incurred</Th>
                    <Th className="text-right">Loss ratio</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPolicyType.flatMap((t) =>
                    t.byCurrency.map((b) => (
                      <tr key={`${t.policyType}-${b.currency}`}>
                        <Td className="font-medium">{policyTypeLabel(t.policyType)}</Td>
                        <Td>{b.currency}</Td>
                        <Td className="text-right tabular-nums">
                          {fmtMoney(b.premiumNet, b.currency, 0)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {fmtMoney(b.claimsIncurred, b.currency, 0)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {b.lossRatioPct === null ? (
                            <span className="text-ink-400" title={b.reasons.join(" ")}>
                              —
                            </span>
                          ) : (
                            fmtPct(b.lossRatioPct)
                          )}
                        </Td>
                      </tr>
                    )),
                  )}
                </tbody>
              </Table>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
