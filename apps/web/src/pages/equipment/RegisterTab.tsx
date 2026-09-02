/**
 * THE PLANT REGISTER — what is on this project, or what the company owns and
 * hires, on one virtualised grid.
 *
 * The register is deliberately not a list of assets with a status column. Four
 * facts are joined onto every row because each of them is somebody's money or
 * somebody's licence:
 *
 *  · OUT OF CERTIFICATE. Painted at the rail, not left to a legend. On
 *    assigned plant with a statutory certificate that is the critical case.
 *  · HIRE STILL RUNNING PAST THE AGREED END. The API states it in a sentence;
 *    the sentence is what the row shows.
 *  · OFF-HIRE REQUESTED, MACHINE STILL HERE. The gap between those two dates
 *    is pure loss, and it is nobody's job until it is on a screen.
 *  · MAINTENANCE OVERDUE. On critical plant that is a stoppage waiting to be
 *    discovered by the thing it breaks.
 */
import { useMemo } from "react";
import { Badge, Button, Card, CardBody, EmptyState, SkeletonTable, Tooltip } from "../../ui";
import { DataTable, type DataColumns, type DataView } from "../../ui/data";
import type { Tone } from "../../ui/tokens";
import { IconEquipment, IconRefresh, IconWarning } from "../../ui/icons";
import {
  EQUIPMENT_STATUS_TONE,
  EM_DASH,
  LoadError,
  OWNERSHIP_LABEL,
  SectionHeading,
  UnlawfulOperationBanner,
  daysAgo,
  hours,
  isoDate,
  labelize,
  money,
  type EquipmentRecord,
  type ListResponse,
  type Loadable,
  type ProjectEquipmentResponse,
  type ProjectEquipmentRow,
  type Scope,
} from "./equipmentShared";

/** The union the grid renders: project rows carry an assignment, fleet rows do not. */
type RegisterRow = EquipmentRecord & { assignment?: { status: string; assignedFrom: string } | null };

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin:out-of-certificate",
    name: "Out of certificate",
    builtIn: true,
    state: { columnFilters: [{ id: "certificate", value: ["expired"] }] },
  },
  {
    id: "builtin:on-hire",
    name: "On hire",
    builtIn: true,
    state: { columnFilters: [{ id: "ownership", value: ["hired", "operator_hired", "leased"] }] },
  },
  {
    id: "builtin:critical",
    name: "Critical plant",
    builtIn: true,
    state: { columnFilters: [{ id: "isCritical", value: ["yes"] }] },
  },
];

export default function RegisterTab({
  scope,
  project,
  fleet,
  onOpenMachine,
  onOpenCertificates,
}: {
  scope: Scope;
  project: Loadable<ProjectEquipmentResponse>;
  fleet: Loadable<ListResponse<EquipmentRecord>>;
  onOpenMachine: (equipmentId: string) => void;
  onOpenCertificates: () => void;
}) {
  const source = scope === "project" ? project : fleet;
  const asOf = scope === "project" ? project.data?.asOf : undefined;

  const rows = useMemo<RegisterRow[]>(() => {
    if (scope === "project") {
      return (project.data?.items ?? []).map((row: ProjectEquipmentRow) => ({
        ...row,
        assignment: row.assignment,
      }));
    }
    return (fleet.data?.items ?? []).map((row) => ({ ...row, assignment: null }));
  }, [scope, project.data, fleet.data]);

  const outOfCertificate = rows.filter((row) => row.derived.outOfCertificate);
  const hireOverruns = rows.filter((row) => row.derived.hireOverrun !== null);
  const uncollected = rows.filter((row) => row.derived.offHireRequestedNotCollected);
  const overdueMaintenance = rows.filter((row) => row.derived.maintenanceOverdue);

  const columns = useMemo<DataColumns<RegisterRow>>(
    () => [
      {
        id: "reference",
        header: "Plant",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      {
        id: "name",
        header: "Machine",
        accessor: "name",
        type: "text",
        width: 240,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{row.name}</span>
            {row.isCritical ? (
              <Tooltip content="Critical plant: a failure here stops the works, so its maintenance and certification are treated as project risks rather than fleet admin.">
                <span>
                  <Badge tone="highlight" size="xs" variant="outline">
                    Critical
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "category",
        header: "Category",
        accessor: "category",
        type: "enum",
        width: 150,
        groupable: true,
        cell: ({ row }) => <span className="text-content-muted">{labelize(row.category)}</span>,
      },
      {
        id: "ownership",
        header: "Held as",
        accessor: "ownership",
        type: "enum",
        width: 140,
        groupable: true,
        options: Object.entries(OWNERSHIP_LABEL).map(([value, label]) => ({
          value,
          label,
          text: label,
        })),
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {OWNERSHIP_LABEL[row.ownership] ?? labelize(row.ownership)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 165,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={EQUIPMENT_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "certificate",
        header: "Certification",
        headerTooltip:
          "The earliest certificate expiry held against this machine. An expired STATUTORY certificate on plant in service is unlawful operation, not overdue paperwork.",
        accessor: (row) =>
          row.derived.outOfCertificate
            ? "expired"
            : row.nextCertificateExpiry
              ? "valid"
              : "none",
        type: "enum",
        width: 190,
        options: [
          { value: "expired", label: "Out of certificate", text: "Out of certificate", tone: "danger" },
          { value: "valid", label: "In certificate", text: "In certificate", tone: "success" },
          { value: "none", label: "None held", text: "None held", tone: "neutral" },
        ],
        cell: ({ row }) => {
          if (row.derived.outOfCertificate) {
            const lapsed = daysAgo(row.nextCertificateExpiry);
            return (
              <Tooltip content="This machine's earliest certificate expiry has passed. If that certificate is statutory and the machine is assigned, it is operating unlawfully and uninsured.">
                <span>
                  <Badge tone="danger" size="xs" variant="solid" icon={IconWarning}>
                    Expired {isoDate(row.nextCertificateExpiry)}
                    {lapsed !== null ? ` · ${lapsed}d` : ""}
                  </Badge>
                </span>
              </Tooltip>
            );
          }
          if (!row.nextCertificateExpiry) {
            return (
              <span className="text-2xs text-content-subtle italic">
                {row.requiresCertification
                  ? "requires certification, none held"
                  : "no certificate held"}
              </span>
            );
          }
          return (
            <Badge tone="success" size="xs" variant="outline">
              To {isoDate(row.nextCertificateExpiry)}
            </Badge>
          );
        },
      },
      {
        id: "hire",
        header: "Hire",
        headerTooltip:
          "The agreed hire end, and whether the machine is still being charged past it.",
        accessor: (row) => row.hireEndDate ?? "",
        type: "text",
        width: 210,
        cell: ({ row }) => {
          if (!row.derived.onHire) {
            return <span className="text-2xs text-content-subtle">not on hire</span>;
          }
          if (row.derived.hireOverrun) {
            return (
              <Tooltip content={row.derived.hireOverrun}>
                <span>
                  <Badge tone="danger" size="xs" dot>
                    Past agreed end {isoDate(row.hireEndDate)}
                  </Badge>
                </span>
              </Tooltip>
            );
          }
          if (row.derived.offHireRequestedNotCollected) {
            return (
              <Tooltip content="Off-hire has been requested and the machine has not gone back. Every day between the request and the collection is charged unless the hire desk is held to the request date.">
                <span>
                  <Badge tone="warning" size="xs" dot>
                    Off-hire asked {isoDate(row.offHireRequestedAt)}
                  </Badge>
                </span>
              </Tooltip>
            );
          }
          return (
            <span className="text-2xs text-content-muted">
              {row.hireStartDate ? isoDate(row.hireStartDate) : EM_DASH} →{" "}
              {row.hireEndDate ? isoDate(row.hireEndDate) : "open-ended"}
            </span>
          );
        },
      },
      {
        id: "rate",
        header: "Hire rate",
        accessor: "hireRateAmount",
        type: "custom",
        align: "right",
        width: 155,
        aggregate: "none",
        cell: ({ row }) =>
          row.hireRateAmount === null || !row.hireRateUnit ? (
            <Tooltip content="No usable hire rate is recorded on this machine, so its standing cost cannot be stated. That is exactly how idle plant stays invisible.">
              <span className="text-content-muted">
                <Badge tone="warning" size="xs">
                  no rate
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">
              {money(row.hireRateAmount, row.currency, { fractionDigits: 2 })}
              <span className="text-content-subtle">/{labelize(row.hireRateUnit).toLowerCase()}</span>
            </span>
          ),
        toCsv: ({ row }) =>
          row.hireRateAmount === null ? "" : `${row.hireRateAmount} ${row.currency}/${row.hireRateUnit ?? "?"}`,
      },
      {
        id: "maintenance",
        header: "Next service",
        accessor: (row) => row.nextMaintenanceDue ?? "",
        type: "text",
        width: 160,
        cell: ({ row }) =>
          row.derived.maintenanceOverdue ? (
            <Badge tone="danger" size="xs" dot>
              Overdue {isoDate(row.nextMaintenanceDue)}
            </Badge>
          ) : row.nextMaintenanceDue ? (
            <span className="text-2xs text-content-muted">{isoDate(row.nextMaintenanceDue)}</span>
          ) : (
            <span className="text-2xs text-content-subtle italic">no schedule</span>
          ),
      },
      {
        id: "meter",
        header: "Meter",
        accessor: "currentMeterReading",
        type: "custom",
        align: "right",
        width: 140,
        aggregate: "none",
        defaultHidden: true,
        cell: ({ row }) =>
          row.currentMeterReading === null ? (
            <Tooltip content="This machine's meter has never been read. A machine with no meter reading cannot be said to be overdue on a meter-based service interval — and saying so anyway is how the real overdue machines get lost in the noise.">
              <span className="text-content-muted">
                <Badge tone="neutral" size="xs" variant="outline">
                  never read
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">
              {row.meterType === "hours"
                ? hours(row.currentMeterReading, 0)
                : `${row.currentMeterReading.toFixed(0)} ${labelize(row.meterType).toLowerCase()}`}
            </span>
          ),
      },
      {
        id: "telematics",
        header: "Telematics",
        accessor: (row) => (row.telematicsDeviceId ? "mapped" : "none"),
        type: "enum",
        width: 150,
        defaultHidden: true,
        cell: ({ row }) =>
          row.telematicsDeviceId ? (
            <Tooltip
              content={`${labelize(row.telematicsProvider)} · device ${row.telematicsDeviceId}${
                row.telematicsLastSeenAt ? ` · last seen ${isoDate(row.telematicsLastSeenAt)}` : ""
              }`}
            >
              <span>
                <Badge tone="success" size="xs" variant="outline">
                  Mapped
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="text-2xs text-content-subtle italic">no device mapped</span>
          ),
      },
      {
        id: "isCritical",
        header: "Critical",
        accessor: (row) => (row.isCritical ? "yes" : "no"),
        type: "enum",
        width: 110,
        defaultHidden: true,
        options: [
          { value: "yes", label: "Critical", text: "Critical", tone: "highlight" },
          { value: "no", label: "Standard", text: "Standard" },
        ],
      },
      {
        id: "assignment",
        header: "On site since",
        accessor: (row) => row.assignment?.assignedFrom ?? "",
        type: "text",
        width: 160,
        hideable: true,
        cell: ({ row }) =>
          row.assignment ? (
            <span className="text-2xs text-content-muted">
              {labelize(row.assignment.status)} · {isoDate(row.assignment.assignedFrom)}
            </span>
          ) : (
            <span className="text-2xs text-content-subtle">{EM_DASH}</span>
          ),
      },
    ],
    [],
  );

  if (source.error) return <LoadError message={source.error} onRetry={source.reload} />;
  if (source.loading && rows.length === 0) return <SkeletonTable rows={10} columns={7} />;

  return (
    <div className="space-y-4">
      <UnlawfulOperationBanner
        count={scope === "project" ? (project.data?.outOfCertificateCount ?? 0) : outOfCertificate.length}
        asOf={asOf}
        onOpen={onOpenCertificates}
      />

      <ExceptionStrip
        total={rows.length}
        outOfCertificate={outOfCertificate.length}
        hireOverruns={hireOverruns.length}
        uncollected={uncollected.length}
        overdueMaintenance={overdueMaintenance.length}
        scope={scope}
        asOf={asOf}
        note={scope === "project" ? (project.data?.outOfCertificateNote ?? null) : null}
        onReload={source.reload}
        loading={source.loading}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={IconEquipment}
          title={
            scope === "project"
              ? "No plant is assigned to this project"
              : "The company fleet register is empty"
          }
          hint={
            scope === "project"
              ? "The project register lists machines with a live assignment — requested, approved, mobilising or on site. Nothing has been posted here yet. Switch to the company fleet to see everything the business owns and hires, and assign a machine from there."
              : "No machine has been added to the fleet. Plant is registered once at company level and then assigned to projects, so the certificate and maintenance history follows the machine rather than being retyped on each job."
          }
        />
      ) : (
        <DataTable<RegisterRow>
          tableId={scope === "project" ? "equipment-register-project" : "equipment-register-fleet"}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={source.loading}
          height={640}
          stickyHeader
          gridLines
          filterRow
          savedViews
          builtInViews={BUILT_IN_VIEWS}
          exportFileName={scope === "project" ? "project-plant-register" : "company-fleet-register"}
          searchPlaceholder="Search plant by reference, name or asset tag…"
          defaultSort={[{ id: "reference", desc: false }]}
          rowTone={(row) => registerRail(row)}
          onRowClick={({ row }) => onOpenMachine(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Open the machine", onSelect: () => onOpenMachine(row.id) },
          ]}
          empty={{
            title: "No plant on the register",
            description: "Nothing has been registered against this scope.",
          }}
          emptyFiltered={{
            title: "No machine matches these filters",
            description: "Clear the category, ownership or status filter to widen the register.",
          }}
          aria-label={scope === "project" ? "Project plant register" : "Company fleet register"}
        />
      )}

      <p className="text-2xs text-content-subtle">
        Hire rates carry no grand total. A machine hired in one currency cannot be added to one
        hired in another without an FX rate and a date, neither of which belongs in a plant
        register — the idle tab reports the money, one currency at a time.
      </p>
    </div>
  );
}

function registerRail(row: RegisterRow): Tone | undefined {
  if (row.derived.outOfCertificate) return "danger";
  if (row.derived.hireOverrun) return "danger";
  if (row.derived.maintenanceOverdue) return "warning";
  if (row.derived.offHireRequestedNotCollected) return "warning";
  return undefined;
}

function ExceptionStrip({
  total,
  outOfCertificate,
  hireOverruns,
  uncollected,
  overdueMaintenance,
  scope,
  asOf,
  note,
  onReload,
  loading,
}: {
  total: number;
  outOfCertificate: number;
  hireOverruns: number;
  uncollected: number;
  overdueMaintenance: number;
  scope: Scope;
  asOf: string | undefined;
  note: string | null;
  onReload: () => void;
  loading: boolean;
}) {
  return (
    <Card>
      <CardBody className="space-y-2">
        <SectionHeading
          title={scope === "project" ? "Plant on this project" : "The company fleet"}
          hint={
            scope === "project"
              ? "Every machine with a live assignment to this project. Opening this register is what runs the certificate sweep — the read is the trigger, so the signals below exist because somebody looked."
              : "Every machine the company owns, hires or holds, wherever it is. Assignments move a machine to a project; the certificate and maintenance history stays with the machine."
          }
          actions={
            <Button size="sm" variant="ghost" icon={IconRefresh} loading={loading} onClick={onReload}>
              Re-sweep
            </Button>
          }
          className="mb-0"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" size="sm">
            {total} machine{total === 1 ? "" : "s"}
          </Badge>
          <Badge tone={outOfCertificate > 0 ? "danger" : "success"} size="sm" dot>
            {outOfCertificate} out of certificate
          </Badge>
          <Badge tone={hireOverruns > 0 ? "danger" : "neutral"} size="sm" dot={hireOverruns > 0}>
            {hireOverruns} past agreed hire end
          </Badge>
          <Badge tone={uncollected > 0 ? "warning" : "neutral"} size="sm" dot={uncollected > 0}>
            {uncollected} off-hired but not collected
          </Badge>
          <Badge
            tone={overdueMaintenance > 0 ? "warning" : "neutral"}
            size="sm"
            dot={overdueMaintenance > 0}
          >
            {overdueMaintenance} overdue a service
          </Badge>
          {asOf ? <span className="text-2xs text-content-subtle">assessed {asOf}</span> : null}
        </div>
        {note ? <p className="text-2xs text-danger-fg">{note}</p> : null}
      </CardBody>
    </Card>
  );
}
