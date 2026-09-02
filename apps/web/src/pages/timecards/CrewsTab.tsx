/**
 * CREWS — and the dated membership that makes "who was in this crew on the
 * day of the incident" answerable a year later.
 *
 * Membership is a dated range, not a flag. Crews are re-formed constantly, and
 * a boolean `isActive` column would quietly rewrite history every time
 * somebody moved between gangs. The crew panel therefore shows two things
 * side by side: who was in the crew ON A CHOSEN DATE, and the whole membership
 * history with its ranges intact.
 *
 * The other thing a crew carries is its OVERTIME RULE, and this tab prints it
 * in words. There is no platform-wide default threshold and there never will
 * be: 8 hours a day is Californian, 40 a week is federal, 48 a week is the
 * Working Time Directive. A crew that records none of them cannot classify
 * hours at all, and the badge says exactly that rather than silently costing
 * its people under somebody else's agreement.
 */
import { useMemo } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  EmptyState,
  Input,
  SkeletonTable,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tooltip,
  Tr,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import type { Tone } from "../../ui/tokens";
import { IconUsers, IconWarning } from "../../ui/icons";
import {
  EM_DASH,
  LoadError,
  SectionHeading,
  isoDate,
  labelize,
  money,
  type CrewDetail,
  type CrewMember,
  type CrewRecord,
  type ListResponse,
  type Loadable,
} from "./timecardsShared";

export default function CrewsTab({
  crews,
  selectedCrewId,
  onSelectCrew,
  detail,
  onDate,
  onDateChange,
}: {
  crews: Loadable<ListResponse<CrewRecord>>;
  selectedCrewId: string | null;
  onSelectCrew: (crewId: string | null) => void;
  detail: Loadable<CrewDetail>;
  onDate: string;
  onDateChange: (next: string) => void;
}) {
  const rows = useMemo(() => crews.data?.items ?? [], [crews.data]);
  const unruled = rows.filter((crew) => !crew.canClassifyHours);

  const columns = useMemo<DataColumns<CrewRecord>>(
    () => [
      {
        id: "reference",
        header: "Crew",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 108,
        mono: true,
      },
      { id: "name", header: "Name", accessor: "name", type: "text", width: 220 },
      {
        id: "trade",
        header: "Trade",
        accessor: (row) => row.trade ?? "",
        type: "enum",
        width: 150,
        groupable: true,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={crewTone(row.status)} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "currentHeadcount",
        header: "Headcount",
        headerTooltip:
          "Derived from today's live memberships, never incremented. A counter that is incremented drifts; a counter that is derived cannot.",
        accessor: "currentHeadcount",
        type: "number",
        align: "right",
        width: 130,
        aggregate: "sum",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.currentHeadcount}
            {row.headcountTarget !== null ? (
              <span className="text-content-subtle"> / {row.headcountTarget}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "overtimeRule",
        header: "Overtime rule",
        headerTooltip:
          "The rule that classifies this crew's hours. A crew with no threshold recorded produces a REFUSAL from the classifier, not a guess.",
        accessor: (row) => row.overtimeRule.kind,
        type: "enum",
        width: 260,
        options: [
          { value: "daily", label: "Daily ladder", text: "Daily ladder" },
          { value: "weekly", label: "Weekly ladder", text: "Weekly ladder" },
          { value: "none", label: "No overtime", text: "No overtime" },
        ],
        cell: ({ row }) => (
          <Tooltip content={<span className="block max-w-sm">{row.overtimeRuleExplanation}</span>}>
            <span className="flex flex-wrap items-center gap-1">
              <Badge
                tone={row.canClassifyHours ? "info" : "danger"}
                size="xs"
                variant="outline"
              >
                {row.overtimeRule.kind === "weekly"
                  ? "Weekly"
                  : row.overtimeRule.kind === "none"
                    ? "No overtime"
                    : "Daily"}
              </Badge>
              {row.overtimeRule.thresholdHours !== null ? (
                <span className="text-2xs text-content-muted">
                  over {row.overtimeRule.thresholdHours} h
                </span>
              ) : row.overtimeRule.kind !== "none" ? (
                <Badge tone="danger" size="xs" icon={IconWarning}>
                  no threshold
                </Badge>
              ) : null}
            </span>
          </Tooltip>
        ),
      },
      {
        id: "active",
        header: "Active",
        accessor: (row) => row.activeFrom ?? "",
        type: "text",
        width: 190,
        cell: ({ row }) => (
          <span className="text-2xs text-content-muted">
            {row.activeFrom ?? "open"} → {row.activeTo ?? "open"}
          </span>
        ),
      },
    ],
    [],
  );

  if (crews.error) return <LoadError message={crews.error} onRetry={crews.reload} />;
  if (crews.loading && rows.length === 0) return <SkeletonTable rows={6} columns={6} />;

  return (
    <div className="space-y-4">
      {unruled.length > 0 ? (
        <Alert
          tone="danger"
          icon={IconWarning}
          title={`${unruled.length} crew${unruled.length === 1 ? "" : "s"} cannot classify hours`}
        >
          These crews record no overtime threshold, so the platform refuses to split their hours
          rather than guessing at one. There is no platform-wide default and there never will be:
          8 hours a day is Californian, 40 a week is federal, 48 a week is the Working Time
          Directive, and a crew whose agreement says none of those must not be silently costed
          under one of them. Cards for these crews must arrive with an explicit split — which is
          recorded as an assertion, not a derivation.
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={IconUsers}
          title="No crews on this project"
          hint="A crew is what carries the pay rule and the dated membership that makes 'who was in this gang that day' answerable. Without one, every timecard must arrive with its split already made by hand, and nothing on the platform stands behind that split."
        />
      ) : (
        <DataTable<CrewRecord>
          tableId="timecards-crews"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={crews.loading}
          height={Math.min(420, 140 + rows.length * 40)}
          stickyHeader
          gridLines
          filterRow
          exportFileName="crews"
          searchPlaceholder="Search crews…"
          rowTone={(row) => (row.canClassifyHours ? undefined : ("danger" as Tone))}
          onRowClick={({ row }) => onSelectCrew(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Show the membership", onSelect: () => onSelectCrew(row.id) },
          ]}
          empty={{ title: "No crews" }}
          aria-label="Crews"
        />
      )}

      {selectedCrewId ? (
        <CrewPanel
          detail={detail}
          onDate={onDate}
          onDateChange={onDateChange}
          onClose={() => onSelectCrew(null)}
        />
      ) : rows.length > 0 ? (
        <p className="text-2xs text-content-subtle">
          Select a crew to see who was in it on a chosen date, and the whole membership history with
          its ranges intact.
        </p>
      ) : null}
    </div>
  );
}

function CrewPanel({
  detail,
  onDate,
  onDateChange,
  onClose,
}: {
  detail: Loadable<CrewDetail>;
  onDate: string;
  onDateChange: (next: string) => void;
  onClose: () => void;
}) {
  if (detail.error) return <LoadError message={detail.error} onRetry={detail.reload} />;
  if (detail.loading && !detail.data) return <SkeletonTable rows={5} columns={4} />;
  const crew = detail.data;
  if (!crew) return null;

  return (
    <Card>
      <CardBody className="space-y-4">
        <SectionHeading
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{crew.reference}</span>
              <span>{crew.name}</span>
              <Badge tone={crewTone(crew.status)} size="xs" dot>
                {labelize(crew.status)}
              </Badge>
            </span>
          }
          hint={crew.description ?? undefined}
          className="mb-0"
          actions={
            <span className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                <span className="text-2xs uppercase tracking-wide text-content-subtle">
                  Membership on
                </span>
                <Input
                  type="date"
                  size="sm"
                  value={onDate}
                  onChange={(event) => onDateChange(event.target.value)}
                  aria-label="Membership as-at date"
                  className="w-40"
                />
              </label>
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </span>
          }
        />

        <Alert
          tone={crew.canClassifyHours ? "info" : "danger"}
          size="sm"
          title="How this crew's hours are classified"
        >
          {crew.overtimeRuleExplanation}
        </Alert>

        <DescriptionList
          columns={4}
          size="sm"
          items={[
            {
              label: `Headcount on ${crew.asOf}`,
              value: (
                <span className="text-display-xs font-semibold tabular-nums">
                  {crew.headcountOnDate}
                </span>
              ),
              hint: `${crew.currentHeadcount} today`,
            },
            { label: "Timecards raised", value: String(crew.timecardCount) },
            {
              label: "Standard day",
              value:
                crew.standardHoursPerDay === null
                  ? EM_DASH
                  : `${crew.standardHoursPerDay} h`,
            },
            {
              label: "Approval tiers",
              value: String(crew.config.approvalLevels),
              hint: `variance tolerance ±${crew.config.varianceToleranceHours} h`,
            },
          ]}
        />

        <div>
          <SectionHeading
            title={`In the crew on ${crew.asOf}`}
            hint="Membership is a dated range. This is the historical question — who was in this gang on the day — and it stays answerable because nothing here is a flag."
          />
          {crew.members.length === 0 ? (
            <EmptyState
              size="sm"
              title={`Nobody was in this crew on ${crew.asOf}`}
              hint="No membership range covers that date. The crew may have formed later, disbanded earlier, or simply had nobody attributed to it that day — which is a different fact from an empty crew today."
            />
          ) : (
            <MemberTable members={crew.members} showRange={false} />
          )}
        </div>

        <div>
          <SectionHeading
            title="Membership history"
            hint="Every range this crew has ever held, in date order. A worker who moved between gangs appears in both, each with its own window."
          />
          {crew.memberHistory.length === 0 ? (
            <EmptyState
              size="sm"
              title="No membership has ever been recorded"
              hint="This crew exists on the register and has never had anybody attributed to it. Cards raised against it will carry its pay rule but no membership rate."
            />
          ) : (
            <MemberTable members={crew.memberHistory} showRange />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function MemberTable({
  members,
  showRange,
}: {
  members: readonly CrewMember[];
  showRange: boolean;
}) {
  return (
    <Table dense tableClassName="min-w-[560px] text-meta">
        <THead>
          <Tr>
            <Th>Worker</Th>
            <Th>Role</Th>
            <Th>Classification</Th>
            {showRange ? (
              <Th>In the crew</Th>
            ) : null}
            <Th align="right">Rate</Th>
          </Tr>
        </THead>
        <TBody>
          {members.map((member) => (
            <Tr key={member.id}>
              <Td>
                <div className="text-content">{member.workerName ?? member.workerId}</div>
                <div className="font-mono text-2xs text-content-subtle">
                  {member.workerReference ?? EM_DASH}
                </div>
              </Td>
              <Td>
                <Badge tone="neutral" size="xs" variant="outline">
                  {labelize(member.roleInCrew)}
                </Badge>
              </Td>
              <Td className="text-content-muted">
                {member.classification ?? (
                  <Tooltip content="No prevailing-wage classification is recorded on this membership. Where a jurisdiction sets rates by classification, that is the field the rate comes from.">
                    <span className="italic text-content-subtle">none recorded</span>
                  </Tooltip>
                )}
              </Td>
              {showRange ? (
                <Td className="text-content-muted">
                  {isoDate(member.fromDate)} →{" "}
                  {member.toDate ? (
                    isoDate(member.toDate)
                  ) : (
                    <span className="text-success-fg">still in</span>
                  )}
                </Td>
              ) : null}
              <Td align="right" numeric>
                {member.hourlyRate === null ? (
                  <Tooltip content="This membership carries no rate. Cards for this worker will fall back to the worker register's agreed rate, and where that is absent too the card's cost is null rather than zero.">
                    <span className="text-content-muted">no rate</span>
                  </Tooltip>
                ) : (
                  `${money(member.hourlyRate, member.currency)}/h`
                )}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
  );
}

function crewTone(status: string): Tone {
  switch (status) {
    case "active":
      return "success";
    case "forming":
      return "info";
    case "inactive":
      return "warning";
    default:
      return "neutral";
  }
}
