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
import { Alert, Badge, Button, PageHeader, SegmentedControl, Tabs } from "../../ui";
import { IconEquipment } from "../../ui/icons";
import CertificatesTab from "./CertificatesTab";
import {
  AssignPlantModal,
  AssignmentActionModal,
  CertificateModal,
  DeliveryModal,
  DeviceMapModal,
  MaintenanceRecordModal,
  MaintenanceScheduleModal,
  OffHireModal,
  ReadingModal,
  ReceiveDeliveryModal,
  RegisterPlantModal,
  StockMovementModal,
  UtilisationModal,
} from "./EquipmentForms";
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
  useMaterialSupply,
  useMaterials,
  useProjectPlant,
  useCompanyProjects,
  useResource,
  useSupplierScorecard,
  useTelematicsDevices,
  useTelematicsIntelligence,
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
  /** which write form is open — the module's whole write side lives here */
  const [form, setForm] = useState<
    | "register"
    | "assign"
    | "utilisation"
    | "certificate"
    | "stock"
    | "schedule"
    | "maintenance"
    | "reading"
    | "device"
    | "delivery"
    | "receive"
    | "offhire"
    | "assignment"
    | null
  >(null);
  /** which assignment transition the AssignmentActionModal is running */
  const [assignmentAction, setAssignmentAction] = useState<
    "approve" | "mobilise" | "demobilise" | "cancel" | "transfer" | null
  >(null);
  const [assignmentId, setAssignmentId] = useState<string | null>(null);

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
  const fleet = useCompanyFleet(
    (tab === "register" && scope === "company") || form === "assign" || form === "utilisation",
  );
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
  const materials = useMaterials(projectId, tab === "materials" || form === "stock");
  const supply = useMaterialSupply(projectId, tab === "materials");
  const scorecard = useSupplierScorecard(tab === "materials");
  const devices = useTelematicsDevices(tab === "telematics" || form === "device");
  const companyProjects = useCompanyProjects(form === "assignment");
  const machineSchedules = useMachineSchedules(openMachine, form === "maintenance");
  const intelligence = useTelematicsIntelligence(projectId, telematicsDays, tab === "telematics");
  const stockLedger = useStockLedger(projectId, materialItemId);
  const stockMovements = useStockMovements(projectId, materialItemId);
  const deliveryDetail = useDeliveryDetail(projectId, deliveryId);
  const machineDetail = useEquipmentDetail(openMachine);

  /** After any write, re-read the views that could have changed. */
  const refresh = useCallback(() => {
    summary.reload();
    idle.reload();
    projectPlant.reload();
    fleet.reload();
    certificates.reload();
    maintenance.reload();
    utilisationSummary.reload();
    utilisationRows.reload();
    materials.reload();
    stockLedger.reload();
    stockMovements.reload();
    machineDetail.reload();
  }, [
    summary,
    idle,
    projectPlant,
    fleet,
    certificates,
    maintenance,
    utilisationSummary,
    utilisationRows,
    materials,
    stockLedger,
    stockMovements,
    machineDetail,
  ]);

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
          <div className="flex flex-wrap items-center gap-2">
            {scopeSwitchable ? (
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
            ) : null}
            {tab === "materials" ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setForm("delivery")}>
                  Book a delivery
                </Button>
                {deliveryId ? (
                  <Button size="sm" variant="secondary" onClick={() => setForm("receive")}>
                    Receive
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => setForm("stock")}>
                  Move stock
                </Button>
              </>
            ) : null}
            {tab === "telematics" ? (
              <Button size="sm" variant="secondary" onClick={() => setForm("device")}>
                Map a device
              </Button>
            ) : null}
            {tab === "maintenance" && openMachine ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setForm("schedule")}>
                  Add schedule
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setForm("maintenance")}>
                  Record a service
                </Button>
              </>
            ) : null}
            {openMachine ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setForm("reading")}>
                  Add a reading
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setForm("offhire")}>
                  Off-hire
                </Button>
              </>
            ) : null}
            {tab === "utilisation" || tab === "idle" ? (
              <Button size="sm" variant="secondary" onClick={() => setForm("utilisation")}>
                Record a day
              </Button>
            ) : null}
            {tab === "certificates" && openMachine ? (
              <Button size="sm" variant="secondary" onClick={() => setForm("certificate")}>
                Add certificate
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setForm("assign")}>
              Assign plant
            </Button>
            <Button size="sm" variant="primary" onClick={() => setForm("register")}>
              Register plant
            </Button>
          </div>
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
          onAssignmentAction={(assignment, equipmentId, action) => {
            setAssignmentId(assignment);
            setAssignmentAction(action);
            openMachineDrawer(equipmentId);
            setForm("assignment");
          }}
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
          projectId={projectId}
          summary={utilisationSummary}
          rows={utilisationRows}
          windowDays={utilisationDays}
          onWindowDays={setUtilisationDays}
          onOpenMachine={openMachineDrawer}
        />
      ) : tab === "telematics" ? (
        <TelematicsTab
          report={telematics}
          intelligence={intelligence}
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
          supply={supply}
          scorecard={scorecard}
        />
      )}

      <EquipmentDrawer
        equipmentId={openMachine}
        detail={machineDetail}
        onClose={() => openMachineDrawer(null)}
      />

      <RegisterPlantModal
        open={form === "register"}
        onClose={() => setForm(null)}
        onDone={refresh}
      />
      <AssignPlantModal
        open={form === "assign"}
        onClose={() => setForm(null)}
        onDone={refresh}
        projectId={projectId}
        fleet={fleet.data?.items ?? []}
      />
      <UtilisationModal
        open={form === "utilisation"}
        onClose={() => setForm(null)}
        onDone={refresh}
        projectId={projectId}
        fleet={projectPlant.data?.items ?? fleet.data?.items ?? []}
        defaultEquipmentId={openMachine}
      />
      {openMachine ? (
        <CertificateModal
          open={form === "certificate"}
          onClose={() => setForm(null)}
          onDone={refresh}
          equipmentId={openMachine}
          equipmentLabel={machineDetail.data?.reference ?? "this machine"}
        />
      ) : null}
      <StockMovementModal
        open={form === "stock"}
        onClose={() => setForm(null)}
        onDone={refresh}
        projectId={projectId}
        materials={materials.data?.items ?? []}
        defaultItemId={materialItemId}
      />
      <MaintenanceScheduleModal
        open={form === "schedule"}
        onClose={() => setForm(null)}
        onDone={refresh}
        equipmentId={openMachine}
        machineLabel={machineDetail.data?.reference ?? "this machine"}
      />
      <MaintenanceRecordModal
        open={form === "maintenance"}
        onClose={() => setForm(null)}
        onDone={refresh}
        equipmentId={openMachine}
        machineLabel={machineDetail.data?.reference ?? "this machine"}
        schedules={machineSchedules.data?.items ?? []}
      />
      <ReadingModal
        open={form === "reading"}
        onClose={() => setForm(null)}
        onDone={refresh}
        equipmentId={openMachine}
        machineLabel={machineDetail.data?.reference ?? "this machine"}
        projectId={projectId}
      />
      <OffHireModal
        open={form === "offhire"}
        onClose={() => setForm(null)}
        onDone={refresh}
        equipmentId={openMachine}
        machineLabel={machineDetail.data?.reference ?? "this machine"}
      />
      <DeviceMapModal
        open={form === "device"}
        onClose={() => setForm(null)}
        onDone={refresh}
        fleet={fleet.data?.items ?? []}
        devices={devices.data?.items ?? []}
      />
      <DeliveryModal
        open={form === "delivery"}
        onClose={() => setForm(null)}
        onDone={refresh}
        projectId={projectId}
        materials={materials.data?.items ?? []}
      />
      {deliveryDetail.data ? (
        <ReceiveDeliveryModal
          open={form === "receive"}
          onClose={() => setForm(null)}
          onDone={refresh}
          projectId={projectId}
          delivery={deliveryDetail.data}
        />
      ) : null}
      <AssignmentActionModal
        open={form === "assignment"}
        action={assignmentAction}
        onClose={() => {
          setForm(null);
          setAssignmentAction(null);
        }}
        onDone={refresh}
        projectId={projectId}
        assignmentId={assignmentId}
        machineLabel={machineDetail.data?.reference ?? "this machine"}
        projects={(companyProjects.data?.items ?? []).filter((entry) => entry.id !== projectId)}
      />
    </div>
  );
}

/**
 * The schedules on ONE machine, for the "which service is this closing"
 * picker. A maintenance record with no schedule is a repair; a record against
 * a schedule is the thing that moves the next due date, which is why the
 * picker has to be populated from the machine and not typed.
 */
function useMachineSchedules(
  equipmentId: string | null,
  enabled: boolean,
): { data: { items: Array<{ scheduleId: string; name: string }> } | null } {
  const res = useResource<{ items: Array<{ id: string; name: string }> }>(
    enabled && equipmentId
      ? `/api/v1/companies/current/equipment/${equipmentId}/maintenance-schedules`
      : null,
  );
  return {
    data: res.data
      ? { items: res.data.items.map((s) => ({ scheduleId: s.id, name: s.name })) }
      : null,
  };
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
