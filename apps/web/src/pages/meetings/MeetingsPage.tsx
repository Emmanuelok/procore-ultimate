/**
 * MEETINGS — module M20, routed at /projects/:projectId/meetings.
 *
 * The minutes are not the product. The ACTION ITEM is, and every tab here
 * exists to give one a defensible provenance.
 *
 *   Series        the recurring meeting a contract requires, and the rule that
 *                 produces the next date.
 *   Occurrences   each meeting, with its quorum and the state of its minutes.
 *   Carry-forward the report that names a project failing to decide: an item
 *                 carried three times has stopped being an agenda item.
 *   Actions       owners, dates, slippage kept as evidence, and promotion to
 *                 an obligation explained before it is offered.
 *
 * A meeting opens in a drawer over whichever tab you are on.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Select, Tabs } from "../../ui";
import { IconMeeting } from "../../ui/icons";
import { api } from "../../lib/api";
import ActionsTab from "./ActionsTab";
import CarryForwardTab from "./CarryForwardTab";
import MeetingDrawer from "./MeetingDrawer";
import OccurrencesTab from "./OccurrencesTab";
import SeriesTab from "./SeriesTab";
import {
  CARRY_THRESHOLD,
  EMPTY_ACTION_FILTERS,
  EMPTY_MEETING_FILTERS,
  MEETING_TYPES,
  count,
  titleCase,
  useAction,
  useActionItems,
  useMeetings,
  useOverdueReport,
  useProjectCarryForward,
  useSeries,
  useSeriesCarryForward,
  type ActionFilters,
  type MeetingFilters,
  type MeetingSeries,
} from "./meetingsShared";

type TabKey = "series" | "occurrences" | "carry" | "actions";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "series", label: "Series" },
  { value: "occurrences", label: "Occurrences" },
  { value: "carry", label: "Carry-forward" },
  { value: "actions", label: "Action items" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function MeetingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "occurrences";
  });
  const [meetingId, setMeetingId] = useState<string | null>(() => searchParams.get("meeting"));
  const [meetingFilters, setMeetingFilters] = useState<MeetingFilters>(EMPTY_MEETING_FILTERS);
  const [actionFilters, setActionFilters] = useState<ActionFilters>(EMPTY_ACTION_FILTERS);
  const [carrySeriesId, setCarrySeriesId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  /** Bumped by every write; every read depends on it. */
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const series = useSeries(projectId, version);
  const meetings = useMeetings(projectId, meetingFilters, version);
  const actions = useActionItems(projectId, actionFilters, version);
  const carry = useProjectCarryForward(projectId, version);
  const seriesCarry = useSeriesCarryForward(projectId, carrySeriesId || null, version);
  const overdue = useOverdueReport(projectId, version);

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const openMeeting = useCallback(
    (next: string | null) => {
      setMeetingId(next);
      const params = new URLSearchParams(searchParams);
      if (next) params.set("meeting", next);
      else params.delete("meeting");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const seriesItems = useMemo(() => series.data?.items ?? [], [series.data]);

  const overdueCount = overdue.data?.summary.overdue ?? 0;
  const overThreshold = carry.data?.summary.overThreshold ?? 0;

  if (!projectId) {
    return (
      <EmptyState
        icon={IconMeeting}
        title="No project in the route"
        hint="The meetings workspace is project-scoped. A series, its occurrences and the actions agreed in them all belong to one project, so this screen cannot render without knowing which."
      />
    );
  }

  const tabItems = TABS.map((t) => ({
    value: t.value,
    label: t.label,
    ...(t.value === "carry" && overThreshold > 0
      ? { count: overThreshold, tone: "danger" as const }
      : {}),
    ...(t.value === "actions" && overdueCount > 0
      ? { count: overdueCount, tone: "danger" as const }
      : {}),
  }));

  return (
    <div>
      <PageHeader
        icon={IconMeeting}
        title="Meetings"
        subtitle="Series, occurrences, agendas that carry forward, and the action items that are the actual product. An item carried three times is a project failing to decide, and this workspace says so out loud."
        meta={
          <>
            <span>
              {count(seriesItems.length)} series ·{" "}
              {count(meetings.data?.total ?? 0)} occurrence
              {(meetings.data?.total ?? 0) === 1 ? "" : "s"}
            </span>
            {overdue.data ? (
              <span className="flex items-center gap-1.5">
                <Badge tone={overdueCount > 0 ? "danger" : "success"} size="xs" dot>
                  {count(overdueCount)} overdue action{overdueCount === 1 ? "" : "s"}
                </Badge>
                <span>as at {overdue.data.asOf}</span>
              </span>
            ) : null}
            {overThreshold > 0 ? (
              <Badge tone="danger" size="xs" variant="solid">
                {count(overThreshold)} item{overThreshold === 1 ? "" : "s"} carried{" "}
                {CARRY_THRESHOLD}+ times
              </Badge>
            ) : null}
          </>
        }
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      {tab === "series" ? (
        <SeriesTab
          projectId={projectId}
          series={series}
          onChanged={refresh}
          onOpenSeries={(id) => {
            setCarrySeriesId(id);
            selectTab("carry");
          }}
          onOpenOccurrences={(id) => {
            setMeetingFilters({ ...EMPTY_MEETING_FILTERS, seriesId: id });
            selectTab("occurrences");
          }}
        />
      ) : tab === "occurrences" ? (
        <OccurrencesTab
          meetings={meetings}
          series={seriesItems}
          filters={meetingFilters}
          onFilters={setMeetingFilters}
          onOpenMeeting={openMeeting}
          onCreate={() => setCreateOpen(true)}
        />
      ) : tab === "carry" ? (
        <CarryForwardTab
          report={carry}
          seriesReport={seriesCarry}
          series={seriesItems}
          seriesId={carrySeriesId}
          onSeriesId={setCarrySeriesId}
          onOpenMeeting={openMeeting}
        />
      ) : (
        <ActionsTab
          projectId={projectId}
          actions={actions}
          overdueReport={overdue}
          series={seriesItems}
          filters={actionFilters}
          onFilters={setActionFilters}
          onMutated={refresh}
          onOpenMeeting={openMeeting}
        />
      )}

      <MeetingDrawer
        projectId={projectId}
        meetingId={meetingId}
        version={version}
        onClose={() => openMeeting(null)}
        onMutated={refresh}
      />

      <CreateMeetingModal
        open={createOpen}
        projectId={projectId}
        series={seriesItems}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          refresh();
          openMeeting(id);
        }}
      />
    </div>
  );
}

function CreateMeetingModal({
  open,
  projectId,
  series,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  series: MeetingSeries[];
  onClose: () => void;
  onCreated: (meetingId: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [seriesId, setSeriesId] = useState("");
  const [meetingType, setMeetingType] = useState("progress");
  const [scheduledStart, setScheduledStart] = useState("");
  const [location, setLocation] = useState("");
  const [quorumRequired, setQuorumRequired] = useState("");
  const [objectionPeriodDays, setObjectionPeriodDays] = useState("7");

  async function submit() {
    const quorum = quorumRequired.trim() === "" ? null : Number(quorumRequired);
    const days = objectionPeriodDays.trim() === "" ? null : Number(objectionPeriodDays);
    const created = await run("create", () =>
      api.post<{ id: string }>(`/api/v1/projects/${projectId}/meetings`, {
        title: title.trim(),
        seriesId: seriesId || null,
        meetingType,
        scheduledStart: scheduledStart ? new Date(scheduledStart).toISOString() : null,
        location: location.trim() || null,
        quorumRequired: quorum !== null && Number.isFinite(quorum) ? quorum : null,
        objectionPeriodDays: days !== null && Number.isFinite(days) ? days : null,
      }),
    );
    if (created) {
      setTitle("");
      setScheduledStart("");
      setLocation("");
      onCreated(created.id);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule a meeting"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={title.trim().length === 0 || busy !== null}
            loading={busy === "create"}
            onClick={() => void submit()}
          >
            Schedule it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" size="sm" title="The meeting was refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <Alert tone="info" variant="subtle" size="sm" title="Attach it to a series if you can">
          A meeting inside a series inherits the standing agenda, the invitees and the quorum, and —
          crucially — carries the previous occurrence's unclosed items forward. A one-off meeting
          inherits nothing and nothing carries out of it, which is exactly how an unresolved item
          disappears.
        </Alert>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Series">
            <Select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
              <option value="">One-off, not in a series</option>
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.reference} · {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={meetingType} onChange={(e) => setMeetingType(e.target.value)}>
              {MEETING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scheduled start">
            <Input
              type="datetime-local"
              value={scheduledStart}
              onChange={(e) => setScheduledStart(e.target.value)}
            />
          </Field>
          <Field label="Location">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field
            label="Quorum required"
            hint="Blank means whether a quorum was met is simply not a fact this platform will hold for this meeting."
          >
            <Input
              type="number"
              min={1}
              value={quorumRequired}
              onChange={(e) => setQuorumRequired(e.target.value)}
            />
          </Field>
          <Field
            label="Objection period (days)"
            hint="Blank means nothing is ever deemed accepted — silence will carry no weight."
          >
            <Input
              type="number"
              min={0}
              max={90}
              value={objectionPeriodDays}
              onChange={(e) => setObjectionPeriodDays(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
