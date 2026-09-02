/**
 * TOOLBOX TALKS AND ATTENDANCE.
 *
 * The register answers two questions an inspector asks, and they are not the
 * same question:
 *
 *  1. Was the talk given? (delivered, by whom, on what date)
 *  2. Did the people who needed it actually attend, and did anybody check they
 *     understood it? Attendance is a signature; comprehension is a question
 *     asked and answered, and the two are counted separately here.
 *
 * The language the talk was delivered in and whether an interpreter was used
 * are shown on the row, because a briefing delivered in a language half the
 * crew does not speak is a briefing that did not happen.
 */
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Field,
  Input,
  Progress,
  Select,
  Tooltip,
  type DataColumns,
} from "../../ui";
import { IconMeeting } from "../../ui/icons";
import type { Tone } from "../../ui/tokens";
import {
  LoadError,
  TALK_STATUS_TONE,
  count,
  labelize,
  nameOf,
  type Paged,
  type Resource,
  type ToolboxTalk,
} from "./safetyShared";

export interface TalkFilters {
  category: string;
  status: string;
  from: string;
  to: string;
}

export const EMPTY_TALK_FILTERS: TalkFilters = { category: "", status: "", from: "", to: "" };

const CATEGORIES = [
  "ppe",
  "working_at_height",
  "housekeeping",
  "electrical",
  "excavation",
  "lifting_operations",
  "hot_works",
  "confined_space",
  "plant_and_equipment",
  "manual_handling",
  "hazardous_substances",
  "fire",
  "traffic_management",
  "temporary_works",
  "permit_compliance",
  "environmental",
  "welfare",
  "behaviour",
  "emergency_preparedness",
  "other",
];

const STATUSES = ["planned", "delivered", "verified", "cancelled"];

function rowRail(row: ToolboxTalk): Tone | undefined {
  if (row.attendanceShortfall !== null && row.attendanceShortfall > 0) return "warning";
  if (row.status === "delivered" && !row.verifiedBy) return "info";
  return undefined;
}

export default function TalksTab({
  talks,
  filters,
  onFilters,
  users,
  vendors,
  onOpen,
}: {
  talks: Resource<Paged<ToolboxTalk>>;
  filters: TalkFilters;
  onFilters: (next: TalkFilters) => void;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const rows = talks.data?.items ?? [];
  const [showLanguage, setShowLanguage] = useState(true);

  const columns = useMemo<DataColumns<ToolboxTalk>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 110,
        mono: true,
      },
      { id: "title", header: "Talk", accessor: "title", type: "text", width: 260 },
      {
        id: "category",
        header: "Category",
        accessor: "category",
        type: "enum",
        width: 180,
        groupable: true,
        options: CATEGORIES.map((c) => ({ value: c, text: labelize(c), label: labelize(c) })),
        cell: ({ row }) => labelize(row.category),
      },
      {
        id: "talkDate",
        header: "Date",
        accessor: "talkDate",
        type: "date",
        width: 130,
        sortDescFirst: true,
      },
      {
        id: "presenter",
        header: "Presenter",
        accessor: (row) =>
          row.presenterName ?? (row.presenterId ? nameOf(users, row.presenterId) : ""),
        type: "text",
        width: 170,
      },
      {
        id: "vendor",
        header: "Crew briefed",
        accessor: (row) => (row.vendorId ? nameOf(vendors, row.vendorId) : ""),
        type: "text",
        width: 180,
        cell: ({ row }) =>
          row.vendorId ? (
            nameOf(vendors, row.vendorId)
          ) : (
            <span className="text-content-subtle">no subcontractor named</span>
          ),
      },
      {
        id: "attendance",
        header: "Attendance",
        headerTooltip:
          "Attendees recorded against the expected headcount. A shortfall is the operatives who were meant to be briefed and were not.",
        accessor: (row) => row.attendeeCount,
        type: "custom",
        width: 180,
        align: "left",
        cell: ({ row }) => {
          const expected = row.expectedAttendeeCount;
          if (expected === null || expected === 0) {
            return (
              <Tooltip content="No expected headcount was recorded, so attendance cannot be measured against anything — only counted.">
                <span className="text-meta tabular-nums text-content">
                  {count(row.attendeeCount)} attended
                </span>
              </Tooltip>
            );
          }
          const pct = Math.min(100, (row.attendeeCount / expected) * 100);
          return (
            <span className="block w-full">
              <span className="block text-meta tabular-nums text-content">
                {count(row.attendeeCount)} of {count(expected)}
              </span>
              <Progress
                value={pct}
                max={100}
                size="xs"
                tone={pct >= 100 ? "success" : pct >= 80 ? "warning" : "danger"}
              />
            </span>
          );
        },
        toCsv: ({ row }) =>
          `${row.attendeeCount}${row.expectedAttendeeCount ? ` of ${row.expectedAttendeeCount}` : ""}`,
      },
      {
        id: "language",
        header: "Delivered in",
        headerTooltip:
          "A briefing delivered in a language half the crew does not speak is a briefing that did not happen. An inspector asks this.",
        accessor: (row) => row.language ?? "",
        type: "text",
        width: 170,
        defaultHidden: !showLanguage,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            {row.language ? (
              <Badge tone="neutral" size="xs" variant="outline">
                {row.language}
              </Badge>
            ) : (
              <span className="text-2xs text-content-subtle">not recorded</span>
            )}
            {row.interpreterUsed ? (
              <Badge tone="info" size="xs">
                Interpreter
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: TALK_STATUS_TONE[s],
        })),
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <Badge tone={TALK_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
              {labelize(row.status)}
            </Badge>
            {row.status === "delivered" && !row.verifiedBy ? (
              <Tooltip content="Delivered but not verified. Verification is by somebody other than the presenter — a talk evidenced only by the presenter's own word is the weakest record there is.">
                <span>
                  <Badge tone="warning" size="xs" variant="outline">
                    unverified
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "relatedIncidentId",
        header: "Prompted by",
        accessor: (row) => (row.relatedIncidentId ? "Incident" : row.relatedObservationId ? "Observation" : ""),
        type: "enum",
        width: 140,
        cell: ({ row }) =>
          row.relatedIncidentId ? (
            <Badge tone="danger" size="xs" variant="outline">
              An incident
            </Badge>
          ) : row.relatedObservationId ? (
            <Badge tone="warning" size="xs" variant="outline">
              An observation
            </Badge>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
    ],
    [users, vendors, showLanguage],
  );

  return (
    <div className="space-y-4">
      {talks.error ? (
        <LoadError
          message={talks.error}
          onRetry={talks.reload}
          title="The toolbox talk register could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-4">
          <Field label="Category">
            <Select
              value={filters.category}
              onChange={(e) => onFilters({ ...filters, category: e.target.value })}
            >
              <option value="">Every category</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
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
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => onFilters({ ...filters, from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => onFilters({ ...filters, to: e.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <DataTable<ToolboxTalk>
        tableId="safety-toolbox-talks"
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={talks.loading}
        height={580}
        stickyHeader
        gridLines
        filterRow
        savedViews
        exportFileName="safety-toolbox-talks"
        searchPlaceholder="Search talks…"
        defaultSort={[{ id: "talkDate", desc: true }]}
        rowTone={rowRail}
        onRowClick={({ row }) => onOpen(row.id)}
        toolbarActions={
          <Button size="sm" variant="ghost" onClick={() => setShowLanguage((v) => !v)}>
            {showLanguage ? "Hide language column" : "Show language column"}
          </Button>
        }
        empty={{
          icon: IconMeeting,
          title: "No toolbox talk has been recorded on this project",
          description:
            "A talk linked back to the incident or observation that prompted it is the evidence that a lesson reached the people it concerned. Without any, the lessons register has no delivery record at all.",
        }}
        emptyFiltered={{
          title: "No talk matches these filters",
          description: "Widen the category, status or date range.",
        }}
        aria-label="Toolbox talk register"
      />
    </div>
  );
}

export function talkQueryString(filters: TalkFilters): string {
  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (filters.category) params.set("category", filters.category);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params.toString();
}
