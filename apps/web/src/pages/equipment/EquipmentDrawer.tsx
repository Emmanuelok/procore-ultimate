/**
 * ONE MACHINE — its certification position, its maintenance race, its hire
 * economics and where it has been.
 *
 * The drawer opens over whichever tab you were on, so the register keeps its
 * place while a machine is worked on. It leads with the two facts that stop
 * work: is this machine lawful to operate, and is it costing money for
 * nothing.
 */
import { useMemo } from "react";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  DescriptionList,
  Drawer,
  EmptyState,
  Skeleton,
  Timeline,
  Tooltip,
  type TimelineItem,
} from "../../ui";
import { IconWarning } from "../../ui/icons";
import {
  CERTIFICATE_TYPE_LABEL,
  EM_DASH,
  EQUIPMENT_STATUS_TONE,
  INTERVAL_KIND_LABEL,
  LoadError,
  MAINTENANCE_STATUS_LABEL,
  OWNERSHIP_LABEL,
  ReasonList,
  SectionHeading,
  certificateLabel,
  certificateTone,
  daysAgo,
  hours,
  isoDate,
  labelize,
  maintenanceTone,
  money,
  type EquipmentDetail,
  type Loadable,
} from "./equipmentShared";

export default function EquipmentDrawer({
  equipmentId,
  detail,
  onClose,
}: {
  equipmentId: string | null;
  detail: Loadable<EquipmentDetail>;
  onClose: () => void;
}) {
  const data = detail.data;

  const assignmentTimeline = useMemo<TimelineItem[]>(() => {
    if (!data) return [];
    return data.assignments.map((assignment) => ({
      id: assignment.id,
      title: `${labelize(assignment.status)} on ${assignment.projectId}`,
      timestamp: assignment.mobilisedAt ?? `${assignment.assignedFrom}T00:00:00Z`,
      description: `Assigned ${assignment.assignedFrom}${
        assignment.assignedTo ? ` to ${assignment.assignedTo}` : " — open-ended"
      }${assignment.returnedAt ? ` · returned ${isoDate(assignment.returnedAt)}` : ""}`,
      tone: assignment.status === "returned" ? "neutral" : "info",
      badge: assignment.approvedBy ? undefined : (
        <Tooltip content="This assignment carries no approval. Approval of the hire spend may never be the person who requested it — an unapproved mobilisation is cost nobody agreed to.">
          <span>
            <Badge tone="warning" size="xs">
              unapproved
            </Badge>
          </span>
        </Tooltip>
      ),
      body: assignment.damageOnReturnNote ? (
        <p className="text-meta text-danger-fg">{assignment.damageOnReturnNote}</p>
      ) : undefined,
    }));
  }, [data]);

  return (
    <Drawer
      open={equipmentId !== null}
      onClose={onClose}
      side="right"
      size="lg"
      title={
        data ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{data.reference}</span>
            <span className="truncate">{data.name}</span>
          </span>
        ) : (
          "Machine"
        )
      }
      description={
        data
          ? `${labelize(data.category)} · ${OWNERSHIP_LABEL[data.ownership] ?? labelize(data.ownership)} · assessed ${data.derived.asOf}`
          : undefined
      }
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : detail.loading && !data ? (
        <div className="space-y-3">
          <Skeleton height={80} />
          <Skeleton height={140} />
          <Skeleton height={200} />
        </div>
      ) : !data ? null : (
        <div className="space-y-4">
          <Headline detail={data} />

          <DescriptionList
            columns={2}
            size="sm"
            dividers
            items={[
              {
                label: "Status",
                value: (
                  <Badge tone={EQUIPMENT_STATUS_TONE[data.status] ?? "neutral"} size="xs" dot>
                    {labelize(data.status)}
                  </Badge>
                ),
              },
              { label: "Condition", value: labelize(data.condition) },
              { label: "Manufacturer", value: data.manufacturer ?? EM_DASH },
              { label: "Model", value: data.model ?? EM_DASH },
              { label: "Serial", value: data.serialNumber ?? EM_DASH, copyValue: data.serialNumber ?? "" },
              { label: "Registration", value: data.registrationNumber ?? EM_DASH },
              { label: "Asset tag", value: data.assetTag ?? EM_DASH },
              { label: "Capacity", value: data.capacity ?? EM_DASH },
              {
                label: "Meter",
                value:
                  data.currentMeterReading === null ? (
                    <Tooltip content="This machine's meter has never been read. A meter-based service interval has nothing to measure against, so those schedules read 'not scheduled' rather than 'due'.">
                      <span className="text-content-muted">Never read</span>
                    </Tooltip>
                  ) : (
                    <span className="tabular-nums">
                      {data.meterType === "hours"
                        ? hours(data.currentMeterReading, 0)
                        : `${data.currentMeterReading.toFixed(0)} ${labelize(data.meterType).toLowerCase()}`}
                    </span>
                  ),
                hint: data.lastMeterReadingAt ? `read ${isoDate(data.lastMeterReadingAt)}` : undefined,
              },
              {
                label: "Telematics",
                value: data.telematicsDeviceId ? (
                  <span>
                    {labelize(data.telematicsProvider)}{" "}
                    <span className="font-mono text-2xs text-content-subtle">
                      {data.telematicsDeviceId}
                    </span>
                  </span>
                ) : (
                  <span className="text-content-subtle italic">no device mapped</span>
                ),
                hint: data.telematicsLastSeenAt
                  ? `last seen ${isoDate(data.telematicsLastSeenAt)}`
                  : "the plant sheet is the only account of this machine's hours",
              },
              { label: "Location", value: data.locationText ?? EM_DASH, span: "full" },
            ]}
          />

          <HireEconomics detail={data} />

          <div>
            <SectionHeading
              title="Certificates"
              hint="The register exists to watch one column. A statutory certificate that has lapsed on plant in service is unlawful, uninsured operation."
            />
            {data.certificates.length === 0 ? (
              <EmptyState
                size="sm"
                tone={data.requiresCertification ? "danger" : "neutral"}
                title={
                  data.requiresCertification
                    ? "This machine requires certification and holds none"
                    : "No certificate is held for this machine"
                }
                hint={
                  data.requiresCertification
                    ? "The register says this machine may not be operated without a certificate, and no certificate has been filed against it. That is worse than an expired one: there is nothing at all to check."
                    : "Nothing on the register says this machine needs a certificate, and none has been filed. If that is wrong, the flag on the machine record is the thing to fix."
                }
              />
            ) : (
              <div className="space-y-2">
                {data.certificates.map((certificate) => {
                  const lapsed = daysAgo(certificate.validTo);
                  return (
                    <Card key={certificate.id}>
                      <CardBody className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-content">
                            {CERTIFICATE_TYPE_LABEL[certificate.certificateType] ??
                              labelize(certificate.certificateType)}
                          </span>
                          <Badge
                            tone={certificateTone(certificate.verdict)}
                            size="xs"
                            dot
                            variant={certificate.verdict.severity === "critical" ? "solid" : "subtle"}
                          >
                            {certificateLabel(certificate.verdict)}
                          </Badge>
                          {certificate.verdict.severity === "critical" ? (
                            <Badge tone="danger" size="xs" variant="solid" icon={IconWarning}>
                              Unlawful operation
                            </Badge>
                          ) : null}
                          {certificate.verifiedBy === null ? (
                            <Tooltip content="Nobody has independently verified that this certificate is genuine — and the verifier may never be whoever filed it.">
                              <span>
                                <Badge tone="warning" size="xs" variant="outline">
                                  unverified
                                </Badge>
                              </span>
                            </Tooltip>
                          ) : null}
                        </div>
                        <p className="text-2xs text-content-subtle">
                          {certificate.certificateNumber
                            ? `No. ${certificate.certificateNumber} · `
                            : ""}
                          valid {certificate.validFrom ?? "?"} to {certificate.validTo}
                          {certificate.verdict.status === "expired" && lapsed !== null
                            ? ` · lapsed ${lapsed} day(s) ago`
                            : ""}
                          {certificate.issuedByName ? ` · issued by ${certificate.issuedByName}` : ""}
                          {certificate.safeWorkingLoad ? ` · SWL ${certificate.safeWorkingLoad}` : ""}
                        </p>
                        {certificate.conditions ? (
                          <p className="text-meta text-warning-fg">{certificate.conditions}</p>
                        ) : null}
                      </CardBody>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <SectionHeading
              title="Maintenance"
              hint="Calendar and meter intervals race each other — whichever arrives first governs."
            />
            {data.maintenance.schedules.length === 0 ? (
              <EmptyState
                size="sm"
                title="No maintenance schedule exists for this machine"
                hint="Plant without a schedule is not plant without maintenance needs; it is plant whose maintenance needs are nobody's job. Nothing here will ever fall due, because nothing here has been set."
              />
            ) : (
              <div className="space-y-2">
                {data.maintenance.governing ? (
                  <Alert
                    tone={maintenanceTone(data.maintenance.governing.status)}
                    size="sm"
                    title={`Governing schedule: ${data.maintenance.governing.name}`}
                  >
                    {MAINTENANCE_STATUS_LABEL[data.maintenance.governing.status]}
                    {data.maintenance.governing.overdueBy
                      ? ` by ${data.maintenance.governing.overdueBy.value} ${data.maintenance.governing.overdueBy.unit}`
                      : data.maintenance.governing.nextDueAt
                        ? ` — next due ${data.maintenance.governing.nextDueAt}`
                        : ""}
                    . Across a machine&rsquo;s schedules the governing one is the worst status;
                    within a status, the one that arrives first.
                  </Alert>
                ) : null}
                {data.maintenance.schedules.map((schedule) => (
                  <Card key={schedule.scheduleId}>
                    <CardBody className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-content">{schedule.name}</span>
                        <Badge tone={maintenanceTone(schedule.status)} size="xs" dot>
                          {MAINTENANCE_STATUS_LABEL[schedule.status]}
                        </Badge>
                        {schedule.isStatutory ? (
                          <Badge tone="danger" size="xs" variant="outline">
                            Statutory
                          </Badge>
                        ) : null}
                        <Badge tone="neutral" size="xs" variant="outline">
                          {INTERVAL_KIND_LABEL[schedule.intervalKind] ??
                            labelize(schedule.intervalKind)}
                        </Badge>
                      </div>
                      <p className="text-2xs text-content-subtle">
                        {schedule.basis === "calendar" && schedule.nextDueAt
                          ? `Next due ${schedule.nextDueAt}${
                              schedule.daysRemaining !== null
                                ? ` (${schedule.daysRemaining} days)`
                                : ""
                            }`
                          : schedule.basis === "meter" && schedule.nextDueMeter !== null
                            ? `Next due at ${schedule.nextDueMeter.toFixed(0)}${
                                schedule.meterRemaining !== null
                                  ? ` (${schedule.meterRemaining.toFixed(0)} to run)`
                                  : ""
                              }${schedule.projectedDueAt ? ` · projected ${schedule.projectedDueAt}` : ""}`
                            : "This schedule cannot be placed on either clock."}
                      </p>
                      <ReasonList reasons={schedule.reasons} />
                    </CardBody>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div>
            <SectionHeading
              title="Where it has been"
              hint="Every posting of this machine to a project, with the mobilisation costs that are always forgotten until the invoice arrives."
            />
            {assignmentTimeline.length === 0 ? (
              <EmptyState
                size="sm"
                title="This machine has never been assigned to a project"
                hint="It is on the fleet register and has never been posted anywhere. That is either a machine in the yard, or a machine on a job that nobody recorded — and the second one is how plant goes missing."
              />
            ) : (
              <Timeline items={assignmentTimeline} timeFormat="absolute" aria-label="Assignment history" />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** The two facts that stop work, up front. */
function Headline({ detail }: { detail: EquipmentDetail }) {
  const critical = detail.certificates.filter(
    (certificate) => certificate.verdict.severity === "critical",
  );
  const notices: Array<{ tone: "danger" | "warning"; title: string; body: string }> = [];

  if (critical.length > 0) {
    notices.push({
      tone: "danger",
      title: "This machine is operating unlawfully",
      body: `${critical
        .map(
          (certificate) =>
            `${CERTIFICATE_TYPE_LABEL[certificate.certificateType] ?? labelize(certificate.certificateType)} expired ${certificate.validTo}`,
        )
        .join("; ")}. It is assigned to a project, its statutory certification has lapsed, and it is therefore uninsured. Stop the machine or produce a current certificate.`,
    });
  }
  if (detail.derived.hireOverrun) {
    notices.push({
      tone: "danger",
      title: "Still on hire past the agreed end",
      body: detail.derived.hireOverrun,
    });
  }
  if (detail.derived.offHireRequestedNotCollected) {
    notices.push({
      tone: "warning",
      title: "Off-hire requested, machine still here",
      body: `Off-hire was requested on ${isoDate(detail.offHireRequestedAt)} and the machine has not gone back. Every day between the request and the collection is charged unless the hire desk is held to the request date — chase collection and check the invoice stops there.`,
    });
  }
  if (detail.derived.maintenanceOverdue) {
    notices.push({
      tone: "warning",
      title: "A service is overdue",
      body: `The next service was due ${isoDate(detail.nextMaintenanceDue)}${
        detail.isCritical
          ? ". This is critical plant: a failure here stops the works, and an overdue service on it is an unpriced programme risk."
          : "."
      }`,
    });
  }

  if (notices.length === 0) {
    return (
      <Alert tone="success" size="sm" title="Nothing on this machine is stopping work today">
        Its certification is in date, its hire is inside the agreed term, and no service is overdue
        as at {detail.derived.asOf}.
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      {notices.map((notice) => (
        <Alert
          key={notice.title}
          tone={notice.tone}
          size="sm"
          title={notice.title}
          icon={notice.tone === "danger" ? IconWarning : undefined}
        >
          {notice.body}
        </Alert>
      ))}
    </div>
  );
}

/** What this machine costs, and what the platform cannot say about that. */
function HireEconomics({ detail }: { detail: EquipmentDetail }) {
  const noRate = detail.hireRateAmount === null || !detail.hireRateUnit;
  return (
    <div>
      <SectionHeading
        title="What it costs"
        hint="Every figure is in this machine's own currency. Nothing on this screen adds one currency to another."
      />
      {detail.derived.onHire && noRate ? (
        <Alert tone="warning" size="sm" title="No usable hire rate is recorded" className="mb-2">
          This machine is on hire and carries no rate the platform can turn into a day&rsquo;s cost.
          Its standing cost cannot be stated — which is exactly how idle plant stays invisible. The
          idle assessment will list it and report its cost as unavailable rather than as zero.
        </Alert>
      ) : null}
      <DescriptionList
        columns={2}
        size="sm"
        dividers
        items={[
          {
            label: "Held as",
            value: OWNERSHIP_LABEL[detail.ownership] ?? labelize(detail.ownership),
          },
          { label: "Currency", value: detail.currency },
          {
            label: "Hire rate",
            value: noRate ? (
              <span className="text-content-muted">Not recorded</span>
            ) : (
              <span className="tabular-nums">
                {money(detail.hireRateAmount, detail.currency, { fractionDigits: 2 })}
                <span className="text-content-subtle">
                  /{labelize(detail.hireRateUnit).toLowerCase()}
                </span>
              </span>
            ),
          },
          {
            label: "Standing rate",
            value:
              detail.idleRateAmount === null ? (
                <Tooltip content="No standing rate is agreed. A hire company with no agreed standing rate charges the full one, so idle hours are priced at the full hire rate rather than at an assumed discount — assuming otherwise understates the loss.">
                  <span className="text-content-muted">Not agreed — full rate applies</span>
                </Tooltip>
              ) : (
                <span className="tabular-nums">
                  {money(detail.idleRateAmount, detail.currency, { fractionDigits: 2 })}/hour
                </span>
              ),
          },
          {
            label: "Operator rate",
            value:
              detail.operatorRateAmount === null ? (
                <span className="text-content-muted">Not recorded</span>
              ) : (
                <span className="tabular-nums">
                  {money(detail.operatorRateAmount, detail.currency, { fractionDigits: 2 })}/hour
                </span>
              ),
          },
          {
            label: "Hire term",
            value: detail.derived.onHire
              ? `${detail.hireStartDate ?? "?"} → ${detail.hireEndDate ?? "open-ended"}`
              : EM_DASH,
          },
          { label: "Hire agreement", value: detail.hireAgreementRef ?? EM_DASH },
          {
            label: "Off-hire",
            value: detail.offHiredAt
              ? `Returned ${isoDate(detail.offHiredAt)}`
              : detail.offHireRequestedAt
                ? `Requested ${isoDate(detail.offHireRequestedAt)}, not collected`
                : detail.derived.onHire
                  ? "Still running"
                  : EM_DASH,
          },
        ]}
      />
    </div>
  );
}
