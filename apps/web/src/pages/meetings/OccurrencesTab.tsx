/**
 * OCCURRENCES — every meeting on the project, scheduled or held.
 *
 * The two columns worth looking at before any other are QUORUM and MINUTES.
 * Quorum decides whether the decisions taken in the room bind; the minutes
 * state decides whether anybody is deemed to have accepted them. Both are
 * reported, never inferred: an occurrence with no quorum requirement shows
 * "not asserted", not a green tick.
 */
import { useMemo } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  Select,
  Tooltip,
  type DataColumns,
} from "../../ui";
import { IconMeeting, IconPlus } from "../../ui/icons";
import {
  EMPTY_MEETING_FILTERS,
  LoadError,
  MEETING_STATUSES,
  MEETING_STATUS_TONE,
  MEETING_TYPES,
  count,
  dateTime,
  titleCase,
  type Loadable,
  type Meeting,
  type MeetingFilters,
  type MeetingSeries,
  type Paginated,
} from "./meetingsShared";

export default function OccurrencesTab({
  meetings,
  series,
  filters,
  onFilters,
  onOpenMeeting,
  onCreate,
}: {
  meetings: Loadable<Paginated<Meeting>>;
  series: MeetingSeries[];
  filters: MeetingFilters;
  onFilters: (next: MeetingFilters) => void;
  onOpenMeeting: (meetingId: string) => void;
  onCreate: () => void;
}) {
  const rows = meetings.data?.items ?? [];
  const seriesById = useMemo(() => new Map(series.map((s) => [s.id, s])), [series]);

  const columns = useMemo<DataColumns<Meeting>>(
    () => [
      {
        id: "reference",
        header: "Meeting",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 110,
        mono: true,
      },
      {
        id: "title",
        header: "Title",
        accessor: "title",
        type: "text",
        width: 260,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{row.title}</span>
            {row.occurrenceNumber !== null ? (
              <Badge tone="neutral" size="xs" variant="outline">
                No. {row.occurrenceNumber}
              </Badge>
            ) : (
              <Badge tone="neutral" size="xs" variant="outline">
                One-off
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "seriesId",
        header: "Series",
        accessor: (row) => (row.seriesId ? (seriesById.get(row.seriesId)?.reference ?? "") : ""),
        type: "enum",
        width: 150,
        groupable: true,
        cell: ({ row }) => {
          const s = row.seriesId ? seriesById.get(row.seriesId) : undefined;
          return s ? (
            <span className="text-meta">
              <span className="font-mono text-2xs text-content-subtle">{s.reference}</span>{" "}
              {s.title}
            </span>
          ) : (
            <Tooltip content="A one-off meeting has no previous occurrence, so nothing carries into it and nothing carries out of it.">
              <span className="italic text-content-subtle">not in a series</span>
            </Tooltip>
          );
        },
      },
      {
        id: "scheduledStart",
        header: "Scheduled",
        accessor: (row) => row.scheduledStart ?? "",
        type: "text",
        width: 190,
        sortDescFirst: true,
        cell: ({ row }) => dateTime(row.scheduledStart),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 160,
        groupable: true,
        options: MEETING_STATUSES.map((s) => ({
          value: s,
          text: titleCase(s),
          label: titleCase(s),
          tone: MEETING_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={MEETING_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "quorum",
        header: "Quorum",
        headerTooltip:
          "Whether the counting attendance reached the number the series requires. With no requirement recorded, this platform does not hold the fact and says so.",
        accessor: (row) =>
          row.quorumRequired === null ? "not_asserted" : row.quorumMet === 1 ? "met" : "not_met",
        type: "enum",
        width: 160,
        groupable: true,
        options: [
          { value: "met", text: "Met", label: "Met", tone: "success" },
          { value: "not_met", text: "Not met", label: "Not met", tone: "danger" },
          {
            value: "not_asserted",
            text: "Not asserted",
            label: "Not asserted",
            tone: "neutral",
          },
        ],
        cell: ({ row }) =>
          row.quorumRequired === null ? (
            <Tooltip content="No quorum is required for this meeting, so whether one was met is not a fact this platform holds. Set a quorum on the series or the occurrence to have it checked.">
              <span>
                <Badge tone="neutral" size="xs">
                  Not asserted
                </Badge>
              </span>
            </Tooltip>
          ) : row.quorumMet === 1 ? (
            <Badge tone="success" size="xs" dot>
              Met ({count(row.quorumRequired)} required)
            </Badge>
          ) : (
            <Badge tone="danger" size="xs" variant="solid" dot>
              Not met ({count(row.quorumRequired)} required)
            </Badge>
          ),
      },
      {
        id: "attendeeCount",
        header: "Attendees",
        accessor: "attendeeCount",
        type: "number",
        align: "right",
        width: 100,
        aggregate: "sum",
      },
      {
        id: "openActionItemCount",
        header: "Open actions",
        accessor: "openActionItemCount",
        type: "number",
        align: "right",
        width: 130,
        aggregate: "sum",
        cell: ({ row }) => (
          <span
            className={
              row.openActionItemCount > 0
                ? "font-semibold tabular-nums text-warning-fg"
                : "tabular-nums text-content-subtle"
            }
          >
            {count(row.openActionItemCount)} of {count(row.actionItemCount)}
          </span>
        ),
      },
      {
        id: "minutes",
        header: "Minutes",
        accessor: (row) =>
          row.approvedAt
            ? "approved"
            : row.minutesIssuedAt
              ? "issued"
              : row.minutesBody
                ? "drafted"
                : "none",
        type: "enum",
        width: 210,
        groupable: true,
        cell: ({ row }) =>
          row.approvedAt ? (
            <Badge tone="success" size="xs">
              Signed off {row.approvedAt.slice(0, 10)}
            </Badge>
          ) : row.minutesIssuedAt ? (
            <span className="min-w-0 py-0.5">
              <Badge tone="accent" size="xs" dot>
                Issued {row.minutesIssuedAt.slice(0, 10)}
              </Badge>
              <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-subtle">
                {row.objectionPeriodDays === null
                  ? "No objection period recorded, so nothing is deemed accepted."
                  : `${row.objectionPeriodDays}-day objection period.`}
              </p>
            </span>
          ) : row.minutesBody ? (
            <Badge tone="warning" size="xs">
              Draft
            </Badge>
          ) : (
            <span className="italic text-content-subtle">not written</span>
          ),
      },
      {
        id: "aiDrafted",
        header: "Drafted by",
        accessor: (row) => (row.aiDrafted === 1 ? "ai" : "human"),
        type: "enum",
        width: 130,
        defaultHidden: true,
        cell: ({ row }) =>
          row.aiDrafted === 1 ? (
            <Badge tone="warning" size="xs">
              AI draft
            </Badge>
          ) : (
            <span className="text-meta text-content-subtle">a person</span>
          ),
      },
    ],
    [seriesById],
  );

  return (
    <div className="space-y-4">
      {meetings.error ? (
        <LoadError
          message={meetings.error}
          onRetry={meetings.reload}
          title="The occurrences could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-4">
          <Field label="Series">
            <Select
              value={filters.seriesId}
              onChange={(e) => onFilters({ ...filters, seriesId: e.target.value })}
            >
              <option value="">Every series</option>
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.reference} · {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every status</option>
              {MEETING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type">
            <Select
              value={filters.meetingType}
              onChange={(e) => onFilters({ ...filters, meetingType: e.target.value })}
            >
              <option value="">Every type</option>
              {MEETING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end gap-2">
            <Button icon={IconPlus} onClick={onCreate}>
              New meeting
            </Button>
            {filters.seriesId || filters.status || filters.meetingType ? (
              <Button variant="ghost" onClick={() => onFilters(EMPTY_MEETING_FILTERS)}>
                Clear
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {!meetings.loading && rows.length === 0 ? (
        <EmptyState
          icon={IconMeeting}
          title={
            filters.seriesId || filters.status || filters.meetingType
              ? "No occurrence matches these filters"
              : "No meeting has been held or scheduled on this project"
          }
          hint={
            filters.seriesId || filters.status || filters.meetingType
              ? "The filters above exclude every occurrence. Clear them to see the rest."
              : "Occurrences are generated from a series, or created one at a time. Until one exists there is no agenda to carry forward, no attendance to check a quorum against, and no meeting for an action item to trace back to."
          }
          action={
            <Button icon={IconPlus} onClick={onCreate}>
              Schedule a meeting
            </Button>
          }
        />
      ) : (
        <DataTable<Meeting>
          tableId="meeting-occurrences"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={meetings.loading}
          height={600}
          rowHeight={52}
          stickyHeader
          gridLines
          filterRow
          savedViews
          builtInViews={[
            {
              id: "builtin:awaiting-minutes",
              name: "Held, minutes not issued",
              builtIn: true,
              state: { columnFilters: [{ id: "status", value: ["held", "minutes_draft"] }] },
            },
            {
              id: "builtin:no-quorum",
              name: "Quorum not met",
              builtIn: true,
              state: { columnFilters: [{ id: "quorum", value: ["not_met"] }] },
            },
          ]}
          exportFileName="meetings"
          searchPlaceholder="Search meetings…"
          defaultSort={[{ id: "scheduledStart", desc: true }]}
          rowTone={(row) =>
            row.status === "cancelled"
              ? "neutral"
              : row.quorumRequired !== null && row.quorumMet !== 1 && row.status !== "scheduled"
                ? "danger"
                : row.openActionItemCount > 0
                  ? "warning"
                  : undefined
          }
          onRowClick={({ row }) => onOpenMeeting(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Open meeting", onSelect: () => onOpenMeeting(row.id) },
          ]}
          empty={{
            title: "No meeting on this project",
            description: "Generate occurrences from a series, or schedule a one-off.",
          }}
          emptyFiltered={{
            title: "No occurrence matches these filters",
            description: "Widen the series, status or type filter.",
          }}
          aria-label="Meeting occurrences"
        />
      )}
    </div>
  );
}
