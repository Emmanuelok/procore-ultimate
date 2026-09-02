/**
 * EQUIPMENT, PLANT & MATERIALS — module M23. Routed at
 * /projects/:projectId/equipment.
 *
 * The register is built around the two questions that cost money and the two
 * independent evidence streams that answer them, and the tab order says so:
 *
 *   Idle on hire   what are we paying for that is not working — LEAD, because
 *                  it is the only tab with a number on it that somebody can
 *                  stop today
 *   Register       what is here, and is any of it unlawful to operate
 *   Certificates   the column the table exists for: validTo
 *   Maintenance    calendar against meter, whichever falls first
 *   Utilisation    where the hours went, and what the day cost
 *   Telematics     the machine's own account against the one a person typed
 *   Materials      what arrived, what was wrong with it, and whether the
 *                  compound's balance still reconciles
 *
 * PROJECT AND COMPANY. Plant belongs to the company and visits projects, so
 * the certificate and service history follows the machine rather than the job.
 * The idle assessment and the register therefore carry a scope switch; the
 * certificate and maintenance registers are company-wide by nature and say so.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, PageHeader, SegmentedControl, Tabs } from "../../ui";
import { IconEquipment } from "../../ui/icons";
import CertificatesTab from "./CertificatesTab";
import EquipmentDrawer from "./EquipmentDrawer";
import IdleTab from "./IdleTab";
import MaintenanceTab from "./MaintenanceTab";
import MaterialsTab from "./MaterialsTab";
import RegisterTab from "./RegisterTab";
import TelematicsTab from "./TelematicsTab";
import UtilisationTab from "./UtilisationTab";
import {
  DEFAULT_IDLE_QUERY,
  money,
  shiftDays,
  today,
  useCertificates,
  useCompanyFleet,
  useDeliveries,
  useDeliveryDetail,
  useEquipmentDetail,
  useEquipmentSummary,
  useIdleReport,
  useInvoiceMatch,
  useMaintenance,
  useMaterials,
  useProjectPlant,
  useStockLedger,
  useStockMovements,
  useTelematics,
  useUtilisationRows,
  useUtilisationSummary,
  type IdleQuery,
  type Scope,
} from "./equipmentShared";

type TabKey =
  | "idle"
  | "register"
  | "certificates"
  | "maintenance"
  | "utilisation"
  | "telematics"
  | "materials";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "idle", label: "Idle on hire" },
  { value: "register", label: "Plant register" },
  { value: "certificates", label: "Certificates" },
  { value: "maintenance", label: "Maintenance" },
  { value: "utilisation", label: "Utilisation" },
  { value: "telematics", label: "Telematics" },
  { value: "materials", label: "Materials" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((tab) => tab.value === value);

export default function EquipmentPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "idle";
  });
  const [scope, setScope] = useState<Scope>(() =>
    searchParams.get("scope") === "company" ? "company" : "project",
  );
  const [openMachine, setOpenMachine] = useState<string | null>(() =>
    searchParams.get("machine"),
  );
  const [idleQuery, setIdleQuery] = useState<IdleQuery>(DEFAULT_IDLE_QUERY);
  const [utilisationDays, setUtilisationDays] = useState(30);
  const [telematicsDays, setTelematicsDays] = useState(14);
  const [inServiceOnly, setInServiceOnly] = useState(true);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [materialItemId, setMaterialItemId] = useState<string | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);

  const utilisationTo = useMemo(() => today(), []);
  const utilisationFrom = useMemo(
    () => shiftDays(utilisationTo, -(utilisationDays - 1)),
    [utilisationTo, utilisationDays],
  );

  /* Reads. Each tab's data is fetched only while that tab is mounted, except
     the summary and the idle assessment, which feed the header. */
  const summary = useEquipmentSummary(projectId);
  const idle = useIdleReport(projectId, scope, idleQuery);
  const projectPlant = useProjectPlant(
    tab === "register" || tab === "idle" ? projectId : undefined,
  );
  const fleet = useCompanyFleet(tab === "register" && scope === "company");
  const certificates = useCertificates(inServiceOnly, tab === "certificates");
  const maintenance = useMaintenance(tab === "maintenance", criticalOnly);
  const utilisationSummary = useUtilisationSummary(
    projectId,
    utilisationFrom,
    utilisationTo,
    tab === "utilisation",
  );
  const utilisationRows = useUtilisationRows(
    projectId,
    utilisationFrom,
    utilisationTo,
    tab === "utilisation",
  );
  const telematics = useTelematics(projectId, telematicsDays, tab === "telematics");
  const deliveries = useDeliveries(projectId, tab === "materials");
  const invoiceMatch = useInvoiceMatch(projectId, tab === "materials");
  const materials = useMaterials(projectId, tab === "materials");
  const stockLedger = useStockLedger(projectId, materialItemId);
  const stockMovements = useStockMovements(projectId, materialItemId);
  const deliveryDetail = useDeliveryDetail(projectId, deliveryId);
  const machineDetail = useEquipmentDetail(openMachine);

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const selectScope = useCallback(
    (next: Scope) => {
      setScope(next);
      const params = new URLSearchParams(searchParams);
      params.set("scope", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const openMachineDrawer = useCallback(
    (equipmentId: string | null) => {
      setOpenMachine(equipmentId);
      const params = new URLSearchParams(searchParams);
      if (equipmentId) params.set("machine", equipmentId);
      else params.delete("machine");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  if (!projectId) {
    return (
      <Alert tone="danger" title="No project in the route">
        This workspace is project-scoped. It cannot show a plant register without knowing which
        project the plant is standing on — and the company fleet views it also offers are reached
        through a project, because a machine only costs a job money once it is assigned to one.
      </Alert>
    );
  }

  const idleCount = idle.data?.flaggedCount ?? 0;
  const criticalCertificates = certificates.data?.summary.expiredInServiceStatutory ?? 0;
  const outOfCertificate = projectPlant.data?.outOfCertificateCount ?? 0;
  const idleHeadline = headlineIdleCost(idle.data?.idleCostByCurrency);
  const scopeSwitchable = tab === "idle" || tab === "register";

  return (
    <div>
      <PageHeader
        icon={IconEquipment}
        title="Equipment, plant & materials"
        subtitle="A register that lists machines answers what we have got. This one answers what we are paying for that is not working, and whether any of it is lawful to operate."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            {summary.data ? (
              <span>
                {summary.data.plant.assignedMachines} machine
                {summary.data.plant.assignedMachines === 1 ? "" : "s"} on this project ·{" "}
                {summary.data.signals.open} open signal
                {summary.data.signals.open === 1 ? "" : "s"}
                {summary.data.signals.critical > 0
                  ? ` · ${summary.data.signals.critical} critical`
                  : ""}{" "}
                · assessed {summary.data.asOf}
              </span>
            ) : (
              <span>Reading the plant register…</span>
            )}
            {idleHeadline ? (
              <Badge tone="danger" size="sm" dot>
                {idleHeadline} standing
              </Badge>
            ) : null}
          </span>
        }
        actions={
          scopeSwitchable ? (
            <SegmentedControl<Scope>
              value={scope}
              onChange={selectScope}
              size="sm"
              aria-label="Register scope"
              options={[
                { value: "project", label: "This project" },
                { value: "company", label: "Company fleet" },
              ]}
            />
          ) : null
        }
        tabs={
          <Tabs
            items={TABS.map((entry) => ({
              value: entry.value,
              label: entry.label,
              ...(entry.value === "idle" && idleCount > 0
                ? { count: idleCount, tone: "danger" as const }
                : {}),
              ...(entry.value === "certificates" && criticalCertificates > 0
                ? { count: criticalCertificates, tone: "danger" as const }
                : {}),
              ...(entry.value === "register" && outOfCertificate > 0
                ? { count: outOfCertificate, tone: "danger" as const }
                : {}),
              ...(entry.value === "maintenance" && (maintenance.data?.summary.overdue ?? 0) > 0
                ? { count: maintenance.data?.summary.overdue, tone: "warning" as const }
                : {}),
              ...(entry.value === "materials" &&
              (summary.data?.deliveries.withDiscrepancy ?? 0) > 0
                ? { count: summary.data?.deliveries.withDiscrepancy, tone: "warning" as const }
                : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "idle" ? (
        <IdleTab
          report={idle}
          scope={scope}
          query={idleQuery}
          onQuery={setIdleQuery}
          onOpenMachine={openMachineDrawer}
        />
      ) : tab === "register" ? (
        <RegisterTab
          scope={scope}
          project={projectPlant}
          fleet={fleet}
          onOpenMachine={openMachineDrawer}
          onOpenCertificates={() => selectTab("certificates")}
        />
      ) : tab === "certificates" ? (
        <CertificatesTab
          register={certificates}
          inServiceOnly={inServiceOnly}
          onInServiceOnly={setInServiceOnly}
          onOpenMachine={openMachineDrawer}
        />
      ) : tab === "maintenance" ? (
        <MaintenanceTab
          register={maintenance}
          criticalOnly={criticalOnly}
          onCriticalOnly={setCriticalOnly}
          onOpenMachine={openMachineDrawer}
        />
      ) : tab === "utilisation" ? (
        <UtilisationTab
          summary={utilisationSummary}
          rows={utilisationRows}
          windowDays={utilisationDays}
          onWindowDays={setUtilisationDays}
          onOpenMachine={openMachineDrawer}
        />
      ) : tab === "telematics" ? (
        <TelematicsTab
          report={telematics}
          days={telematicsDays}
          onDays={setTelematicsDays}
          onOpenMachine={openMachineDrawer}
        />
      ) : (
        <MaterialsTab
          deliveries={deliveries}
          invoiceMatch={invoiceMatch}
          materials={materials}
          selectedItemId={materialItemId}
          onSelectItem={setMaterialItemId}
          ledger={stockLedger}
          movements={stockMovements}
          selectedDeliveryId={deliveryId}
          onSelectDelivery={setDeliveryId}
          deliveryDetail={deliveryDetail}
        />
      )}

      <EquipmentDrawer
        equipmentId={openMachine}
        detail={machineDetail}
        onClose={() => openMachineDrawer(null)}
      />
    </div>
  );
}

/** The single biggest currency bucket, for the page header. Never a sum. */
function headlineIdleCost(map: Record<string, number> | undefined): string | null {
  if (!map) return null;
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  if (!top || top[1] <= 0) return null;
  const [currency, value] = top;
  return entries.length > 1
    ? `${money(value, currency)} (+${entries.length - 1} more currency)`
    : money(value, currency);
}
