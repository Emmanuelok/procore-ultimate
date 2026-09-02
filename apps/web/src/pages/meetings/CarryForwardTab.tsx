/**
 * CARRY-FORWARD — the report that names a project failing to decide.
 *
 * An unclosed item on occurrence N becomes a NEW row on N+1, with
 * `carriedFromItemId` pointing back and `carryCount` incremented. Five weeks of
 * "ongoing" is therefore a number, and the API exposes it precisely so it can
 * be looked at: a count nobody can query shames nobody.
 *
 * This screen is built around that number and nothing else. Items are ordered
 * by carry count descending, the API's own threshold of three is drawn as a
 * reference line on the distribution, and the empty state says whether there
 * is genuinely nothing carrying or simply nothing live to carry.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  BarChart,
  Button,
  Card,
  CardBody,
  ChartCard,
  DataTable,
  EmptyState,
  Field,
  Select,
  Skeleton,
  Stat,
  type DataColumns,
} from "../../ui";
import { IconCheckCircle, IconHistory } from "../../ui/icons";
import {
  CARRY_THRESHOLD,
  CarryBadge,
  EM_DASH,
  LoadError,
  ReasonList,
  count,
  titleCase,
  type Loadable,
  type MeetingSeries,
  type ProjectCarryForward,
  type SeriesCarryForward,
} from "./meetingsShared";

type ProjectItem = ProjectCarryForward["items"][number];

export default function CarryForwardTab({
  report,
  seriesReport,
  series,
  seriesId,
  onSeriesId,
  onOpenMeeting,
}: {
  report: Loadable<ProjectCarryForward>;
  seriesReport: Loadable<SeriesCarryForward>;
  series: MeetingSeries[];
  seriesId: string;
  onSeriesId: (next: string) => void;
  onOpenMeeting: (meetingId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const data = report.data;
  const seriesById = useMemo(() => new Map(series.map((s) => [s.id, s])), [series]);

  const rows = useMemo(() => {
    const items = data?.items ?? [];
    const filtered = seriesId ? items.filter((i) => i.seriesId === seriesId) : items;
    const scoped = showAll ? filtered : filtered.filter((i) => i.carryCount > 0);
    return scoped.slice().sort((a, b) => b.carryCount - a.carryCount);
  }, [data, seriesId, showAll]);

  /** The distribution: how many live items sit at each carry count. */
  const distribution = useMemo(() => {
    const buckets = new Map<number, number>();
    for (const i of data?.items ?? []) {
      if (seriesId && i.seriesId !== seriesId) continue;
      buckets.set(i.carryCount, (buckets.get(i.carryCount) ?? 0) + 1);
    }
    const max = Math.max(0, ...[...buckets.keys()]);
    const out: Array<{ carries: string; items: number }> = [];
    for (let n = 0; n <= max; n += 1) {
      out.push({ carries: n === 0 ? "First time" : `×${n}`, items: buckets.get(n) ?? 0 });
    }
    return out;
  }, [data, seriesId]);

  const columns = useMemo<DataColumns<ProjectItem>>(
    () => [
      {
        id: "carryCount",
        header: "Carried",
        headerTooltip: `The API raises a signal at ${CARRY_THRESHOLD} carries: at that point the item has stopped being an agenda item and become an undecided question.`,
        accessor: "carryCount",
        type: "number",
        align: "right",
        width: 130,
        sortDescFirst: true,
        aggregate: "max",
        cell: ({ row }) =>
          row.carryCount === 0 ? (
            <span className="text-2xs italic text-content-subtle">first time</span>
          ) : (
            <CarryBadge carryCount={row.carryCount} />
          ),
      },
      { id: "title", header: "Item", accessor: "title", type: "text", width: 320 },
      {
        id: "series",
        header: "Series",
        accessor: (row) => (row.seriesId ? (seriesById.get(row.seriesId)?.reference ?? "") : ""),
        type: "enum",
        width: 200,
        groupable: true,
        cell: ({ row }) => {
          const s = row.seriesId ? seriesById.get(row.seriesId) : undefined;
          return s ? (
            <span className="text-meta">
              <span className="font-mono text-2xs text-content-subtle">{s.reference}</span>{" "}
              {s.title}
            </span>
          ) : (
            <span className="italic text-content-subtle">one-off meeting</span>
          );
        },
      },
      {
        id: "status",
        header: "State",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "firstRaisedMeetingId",
        header: "First raised at",
        accessor: (row) => row.firstRaisedMeetingId ?? "",
        type: "code",
        width: 200,
        mono: true,
        cell: ({ row }) =>
          row.firstRaisedMeetingId ? (
            <button
              type="button"
              className="font-mono text-2xs text-accent-text underline"
              onClick={() => onOpenMeeting(row.firstRaisedMeetingId as string)}
            >
              {row.firstRaisedMeetingId}
            </button>
          ) : (
            <span className="italic text-content-subtle">unknown</span>
          ),
      },
    ],
    [seriesById, onOpenMeeting],
  );

  if (report.error) {
    return (
      <LoadError
        message={report.error}
        onRetry={report.reload}
        title="The carry-forward report could not be loaded"
      />
    );
  }

  if (report.loading && !data) {
    return (
      <div className="space-y-4">
        <Card>
          <CardBody className="grid gap-4 sm:grid-cols-4">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </CardBody>
        </Card>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const s = data.summary;
  const scopedSeries = seriesId ? seriesById.get(seriesId) : undefined;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Live agenda items"
            value={count(s.liveItems)}
            hint="Open items on the latest occurrence of each series."
          />
          <Stat
            label="Carried at least once"
            value={count(s.carriedItems)}
            tone={s.carriedItems > 0 ? "warning" : "neutral"}
            hint="Each one survived a meeting without being closed."
          />
          <Stat
            label={`Carried ${CARRY_THRESHOLD}+ times`}
            value={count(s.overThreshold)}
            tone={s.overThreshold > 0 ? "danger" : "success"}
            icon={IconHistory}
            hint="The API raises a signal on each of these, keyed on the root item so a chain shouts once."
          />
          <Stat
            label="Worst on the project"
            value={
              rows.length === 0 || (rows[0]?.carryCount ?? 0) === 0
                ? EM_DASH
                : `×${rows[0]?.carryCount ?? 0}`
            }
            tone={(rows[0]?.carryCount ?? 0) >= CARRY_THRESHOLD ? "danger" : "neutral"}
            hint={
              rows.length === 0
                ? "Nothing is carrying, so there is no worst case to report."
                : rows[0]?.title
            }
          />
        </CardBody>
      </Card>

      {s.overThreshold > 0 ? (
        <Alert
          tone="danger"
          icon={IconHistory}
          title={`${count(s.overThreshold)} item${s.overThreshold === 1 ? " has" : "s have"} been carried ${CARRY_THRESHOLD} times or more`}
        >
          An item that appears on four consecutive agendas without being closed is not an agenda
          item — it is a question the project keeps declining to answer. Give each one an owner and a
          date, escalate it, or record the decision not to decide it. Carrying it again is the only
          option that changes nothing.
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardBody className="grid gap-3 sm:grid-cols-2">
            <Field label="Scope to a series">
              <Select value={seriesId} onChange={(e) => onSeriesId(e.target.value)}>
                <option value="">Every series on the project</option>
                {series.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.reference} · {x.title}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show only carried items" : "Include items on their first outing"}
              </Button>
            </div>
            {scopedSeries && seriesReport.data ? (
              <div className="sm:col-span-2 rounded-lg border border-border bg-surface-sunken p-3">
                <p className="text-label uppercase text-content-subtle">
                  {seriesReport.data.seriesReference} · {seriesReport.data.seriesTitle}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-3 text-meta text-content-muted">
                  <span>{count(seriesReport.data.summary.liveItems)} live</span>
                  <span>{count(seriesReport.data.summary.carriedItems)} carried</span>
                  <span>worst ×{seriesReport.data.summary.maxCarryCount}</span>
                  <span>
                    average{" "}
                    {seriesReport.data.summary.averageCarryCount === null ? (
                      <span className="italic text-content-subtle">not available</span>
                    ) : (
                      seriesReport.data.summary.averageCarryCount
                    )}
                  </span>
                </div>
                <ReasonList reasons={seriesReport.data.summary.reasons} className="mt-1.5" />
              </div>
            ) : null}
          </CardBody>
        </Card>

        <ChartCard
          title="How long items survive"
          subtitle="Live agenda items by the number of times they have been carried."
          footnote={`The reference line is the platform's own threshold: at ${CARRY_THRESHOLD} carries a signal is raised against the root item.`}
        >
          <BarChart
            data={distribution}
            categoryKey="carries"
            series={[{ key: "items", label: "Items", tone: "warning" }]}
            height={220}
            valueFormat="number"
            references={[
              {
                x: `×${CARRY_THRESHOLD}`,
                label: "signal raised",
                tone: "danger",
              },
            ]}
            emptyMessage="No live agenda item exists on this project, so there is no distribution to draw — that is different from every item being closed."
            ariaLabel="Distribution of agenda items by carry count"
          />
        </ChartCard>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={IconCheckCircle}
          tone="success"
          title={
            s.liveItems === 0
              ? "There are no live agenda items to carry"
              : "Nothing has been carried forward"
          }
          hint={
            s.liveItems === 0
              ? "Every agenda item on this project is closed, or no occurrence has been held yet. An empty carry report with no live items is not the same as a project that decides quickly."
              : `All ${count(s.liveItems)} live items are on their first outing. Nothing has yet survived a meeting undecided.`
          }
        />
      ) : (
        <DataTable<ProjectItem>
          tableId="meeting-carry-forward"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={report.loading}
          height={480}
          stickyHeader
          gridLines
          filterRow
          savedViews
          exportFileName="carry-forward"
          searchPlaceholder="Search carried items…"
          defaultSort={[{ id: "carryCount", desc: true }]}
          rowTone={(row) =>
            row.carryCount >= CARRY_THRESHOLD
              ? "danger"
              : row.carryCount > 0
                ? "warning"
                : undefined
          }
          onRowClick={({ row }) => onOpenMeeting(row.meetingId)}
          rowActions={(row) => [
            {
              id: "meeting",
              label: "Open the occurrence it sits on",
              onSelect: () => onOpenMeeting(row.meetingId),
            },
          ]}
          empty={{
            title: "Nothing carried",
            description: "No live agenda item has survived an occurrence undecided.",
          }}
          emptyFiltered={{
            title: "No carried item matches these filters",
            description: "Clear the series or state filter.",
          }}
          aria-label="Carried agenda items"
        />
      )}
    </div>
  );
}
