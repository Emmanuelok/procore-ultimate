/**
 * TAX & STATUTORY DEDUCTIONS — spec Vol II Domain Q (#798–807, #816–820),
 * routed at /projects/:projectId/tax.
 *
 * One idea runs through every tab: a tax figure is only worth what the rule
 * behind it is worth, so every number on screen sits next to the rule that
 * produced it, the assumptions it rests on and the confidence that follows.
 *
 *   Overview         the regime this project sits under and the tenant's own
 *                    position in it; the regime library as reference
 *   Registrations    what the tenant, its vendors and entities hold, and who
 *                    verified it with the authority (a second person)
 *   Determinations   the register of engine decisions with their citations;
 *                    what-if determinations; bulk runs for an invoice;
 *                    human overrides that never edit history
 *   Certificates     deduction statements per payment, issued by a second
 *                    person
 *   Returns          periods, their aggregates by currency, due dates that are
 *                    assurance obligations
 *   PE exposure      days-in-country per entity against the treaty threshold
 *   Risks            the signals the sweeps raise, and vendor coverage
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge, PageHeader, Stat, Tabs } from "../../ui";
import { IconFinance } from "../../ui/icons";
import CertificatesTab from "./CertificatesTab";
import DeterminationsTab from "./DeterminationsTab";
import OverviewTab from "./OverviewTab";
import PeExposureTab from "./PeExposureTab";
import PeriodsTab from "./PeriodsTab";
import RegistrationsTab from "./RegistrationsTab";
import RisksTab from "./RisksTab";
import { count, ReasonList, titleCase, useSummary } from "./taxShared";

type TabKey = "overview" | "registrations" | "determinations" | "certificates" | "periods" | "pe" | "risks";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "registrations", label: "Registrations" },
  { value: "determinations", label: "Determinations" },
  { value: "certificates", label: "Certificates" },
  { value: "periods", label: "Returns" },
  { value: "pe", label: "PE exposure" },
  { value: "risks", label: "Risks" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function TaxPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return isTabKey(t) ? t : "overview";
  });

  const selectTab = useCallback(
    (key: TabKey) => {
      setTab(key);
      setSearchParams({ tab: key }, { replace: true });
    },
    [setSearchParams],
  );

  const summary = useSummary(projectId ?? "");
  const s = summary.data;

  if (!projectId) return null;

  const tabItems = TABS.map((t) => {
    if (t.value === "risks" && s && s.openRiskSignals > 0) return { ...t, count: s.openRiskSignals, tone: "danger" as const };
    if (t.value === "periods" && s && s.periods.overdue > 0) return { ...t, count: s.periods.overdue, tone: "danger" as const };
    if (t.value === "pe" && s && s.peExposures.breached + s.peExposures.approaching > 0) {
      return { ...t, count: s.peExposures.breached + s.peExposures.approaching, tone: "warning" as const };
    }
    if (t.value === "certificates" && s && s.certificates.draft > 0) return { ...t, count: s.certificates.draft, tone: "warning" as const };
    return t;
  });

  return (
    <div>
      <PageHeader
        icon={IconFinance}
        title="Tax & Statutory Deductions"
        subtitle="VAT/GST treatment, reverse charges, CIS/RCT/WHT deductions, returns and permanent-establishment exposure — every figure with the rule that produced it"
        meta={
          s ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={s.regime ? "info" : "warning"} size="xs">
                {s.regime ? `Regime: ${s.regime.toUpperCase()}` : "No regime resolved"}
              </Badge>
              <span className="text-2xs text-content-subtle">
                {s.regimeSource === "profile"
                  ? "from the project tax profile"
                  : s.regimeSource === "project_country"
                    ? "derived from the project country — save a profile to record the tenant's own registrations"
                    : "save a profile on the Overview tab"}
              </span>
            </span>
          ) : null
        }
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Current determinations"
          value={s ? count(s.determinations.current) : "—"}
          hint={s ? `${count(s.determinations.reverseCharged)} reverse-charged · ${count(s.determinations.overridden)} overridden` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Low-confidence"
          value={s ? count(s.determinations.lowConfidence) : "—"}
          tone={s && s.determinations.lowConfidence > 0 ? "warning" : undefined}
          hint="Determinations resting on assumptions"
          loading={summary.loading}
        />
        <Stat
          label="Certificates issued"
          value={s ? count(s.certificates.issued) : "—"}
          hint={s ? `${count(s.certificates.draft)} awaiting a second person` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Returns overdue"
          value={s ? count(s.periods.overdue) : "—"}
          tone={s && s.periods.overdue > 0 ? "danger" : undefined}
          hint={s ? `${count(s.periods.dueSoon)} due within 14 days` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="PE exposures"
          value={s ? count(s.peExposures.total) : "—"}
          tone={s && s.peExposures.breached > 0 ? "danger" : s && s.peExposures.approaching > 0 ? "warning" : undefined}
          hint={s ? `${count(s.peExposures.breached)} breached · ${count(s.peExposures.approaching)} approaching` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Open tax risks"
          value={s ? count(s.openRiskSignals) : "—"}
          tone={s && s.openRiskSignals > 0 ? "danger" : undefined}
          hint="Signals raised by the sweeps"
          loading={summary.loading}
        />
      </div>

      {s && s.byCurrency.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2 text-meta text-content-muted">
          {s.byCurrency.map((b) => (
            <span key={b.currency} className="rounded-md border border-border bg-surface-raised px-2.5 py-1">
              <span className="font-semibold text-content">{b.currency}</span> · withholding determined{" "}
              {b.withholdingDetermined.toLocaleString(undefined, { minimumFractionDigits: 2 })} · issued{" "}
              {b.withheldIssued.toLocaleString(undefined, { minimumFractionDigits: 2 })} · self-accounted VAT{" "}
              {b.selfAccountedVat.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          ))}
          <span className="self-center text-2xs text-content-subtle">Bucketed by currency; never summed across.</span>
        </div>
      ) : null}
      {summary.error ? (
        <div className="mb-4 text-meta text-danger-text">Summary unavailable: {summary.error}</div>
      ) : s && s.reasons.length > 0 ? (
        <ReasonList reasons={s.reasons} className="mb-4" />
      ) : null}

      {tab === "overview" ? <OverviewTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "registrations" ? <RegistrationsTab onChanged={summary.reload} /> : null}
      {tab === "determinations" ? <DeterminationsTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "certificates" ? <CertificatesTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "periods" ? <PeriodsTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "pe" ? <PeExposureTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "risks" ? <RisksTab projectId={projectId} onChanged={summary.reload} /> : null}
      <span className="sr-only">{titleCase(tab)}</span>
    </div>
  );
}
