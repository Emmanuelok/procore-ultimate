/**
 * SAFETY workspace — spec Vol I §2.11 / module M21. Routed at
 * /projects/:projectId/safety.
 *
 *   Dashboard    leading indicators first, lagging second, and the published
 *                rates — which are refused, with reasons, wherever exposure
 *                hours are missing.
 *   Incidents    the register and the full report/investigate/close lifecycle,
 *                with the statutory determination and its live clock.
 *   Observations the board, with 5×5 risk scoring and work stoppages.
 *   Actions      one corrective-action register for the whole project, showing
 *                which level of the hierarchy of control was chosen.
 *   Inspections  performed against a versioned template, scored, with defects.
 *   Talks        toolbox talks and who was actually briefed.
 *   Programme    the documentary spine, sorted by what expires next.
 *
 * The header carries the two facts a project director needs before anything
 * else: is there a statutory notification we have missed, and is there one
 * whose classification nobody has settled. Both are read from the register,
 * never inferred.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, PageHeader, Tabs } from "../../ui";
import { IconSafety } from "../../ui/icons";
import { api } from "../../lib/api";
import ActionDrawer from "./ActionDrawer";
import {
  NewInspectionModal,
  NewProgrammeRecordModal,
  NewTalkModal,
  NewTemplateModal,
} from "./CreateModals";
import DevicesTab, {
  EMPTY_DEVICE_FILTERS,
  deviceQueryString,
  type DeviceFilters,
} from "./DevicesTab";
import ProgrammeDrawer from "./ProgrammeDrawer";
import RiskTab from "./RiskTab";
import StatutoryTab from "./StatutoryTab";
import ActionsTab, {
  EMPTY_ACTION_FILTERS,
  actionQueryString,
  type ActionFilters,
} from "./ActionsTab";
import DashboardTab from "./DashboardTab";
import IncidentDrawer from "./IncidentDrawer";
import IncidentsTab, {
  EMPTY_INCIDENT_FILTERS,
  incidentQueryString,
  type IncidentFilters,
} from "./IncidentsTab";
import InspectionDrawer from "./InspectionDrawer";
import InspectionsTab, {
  EMPTY_INSPECTION_FILTERS,
  inspectionQueryString,
  type InspectionFilters,
} from "./InspectionsTab";
import NewRecordModal, { type NewRecordKind } from "./NewRecordModal";
import ObservationDrawer from "./ObservationDrawer";
import ObservationsTab, {
  EMPTY_OBSERVATION_FILTERS,
  observationQueryString,
  type ObservationFilters,
} from "./ObservationsTab";
import ProgrammeTab, {
  EMPTY_PROGRAMME_FILTERS,
  programmeQueryString,
  type ProgrammeFilters,
} from "./ProgrammeTab";
import TalkDrawer from "./TalkDrawer";
import TalksTab, { EMPTY_TALK_FILTERS, talkQueryString, type TalkFilters } from "./TalksTab";
import {
  addDays,
  count,
  today,
  useCompanyUsers,
  useResource,
  useVendors,
  type ActionListResponse,
  type InspectionTemplate,
  type Paged,
  type ProgrammeRecord,
  type SafetyIncident,
  type SafetyInspection,
  type SafetyObservation,
  type SafetyStatistics,
  type SafetySummary,
  type SensorEvent,
  type ToolboxTalk,
} from "./safetyShared";

type TabKey =
  | "dashboard"
  | "incidents"
  | "observations"
  | "actions"
  | "inspections"
  | "talks"
  | "programme"
  | "devices"
  | "statutory"
  | "risk";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "dashboard", label: "Dashboard" },
  { value: "incidents", label: "Incidents" },
  { value: "observations", label: "Observations" },
  { value: "actions", label: "Corrective actions" },
  { value: "inspections", label: "Inspections" },
  { value: "talks", label: "Toolbox talks" },
  { value: "programme", label: "Programme" },
  { value: "devices", label: "Device alarms" },
  { value: "statutory", label: "Statutory forms" },
  { value: "risk", label: "Leading indicators" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function SafetyPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const projectKey = projectId ?? "";

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "dashboard";
  });

  /** Bumped by any write anywhere in the workspace; every read depends on it. */
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const [statsWindow, setStatsWindow] = useState(() => ({
    from: addDays(today(), -365),
    to: today(),
  }));

  const [incidentFilters, setIncidentFilters] = useState<IncidentFilters>(EMPTY_INCIDENT_FILTERS);
  const [observationFilters, setObservationFilters] = useState<ObservationFilters>(
    EMPTY_OBSERVATION_FILTERS,
  );
  const [actionFilters, setActionFilters] = useState<ActionFilters>(EMPTY_ACTION_FILTERS);
  const [inspectionFilters, setInspectionFilters] =
    useState<InspectionFilters>(EMPTY_INSPECTION_FILTERS);
  const [talkFilters, setTalkFilters] = useState<TalkFilters>(EMPTY_TALK_FILTERS);
  const [programmeFilters, setProgrammeFilters] =
    useState<ProgrammeFilters>(EMPTY_PROGRAMME_FILTERS);
  const [deviceFilters, setDeviceFilters] = useState<DeviceFilters>(EMPTY_DEVICE_FILTERS);

  const [openIncident, setOpenIncident] = useState<string | null>(() =>
    searchParams.get("incident"),
  );
  const [openObservation, setOpenObservation] = useState<string | null>(() =>
    searchParams.get("observation"),
  );
  const [openAction, setOpenAction] = useState<string | null>(() => searchParams.get("action"));
  const [openInspection, setOpenInspection] = useState<string | null>(() =>
    searchParams.get("inspection"),
  );
  const [openTalk, setOpenTalk] = useState<string | null>(() => searchParams.get("talk"));
  const [newRecord, setNewRecord] = useState<NewRecordKind | null>(null);
  const [openProgrammeRecord, setOpenProgrammeRecord] = useState<string | null>(() =>
    searchParams.get("record"),
  );
  const [creating, setCreating] = useState<
    "inspection" | "template" | "talk" | "programme" | null
  >(null);

  const users = useCompanyUsers();
  const vendors = useVendors();

  const enabled = projectKey !== "";

  const summary = useResource<SafetySummary>(
    (signal) =>
      api.get<SafetySummary>(`/api/v1/projects/${projectKey}/safety/summary`, { signal }),
    [projectKey, version],
    enabled,
  );

  const statistics = useResource<SafetyStatistics>(
    (signal) =>
      api.get<SafetyStatistics>(
        `/api/v1/projects/${projectKey}/safety/statistics?from=${statsWindow.from}&to=${statsWindow.to}`,
        { signal },
      ),
    [projectKey, version, statsWindow.from, statsWindow.to],
    enabled,
  );

  const incidents = useResource<Paged<SafetyIncident>>(
    (signal) =>
      api.get<Paged<SafetyIncident>>(
        `/api/v1/projects/${projectKey}/safety/incidents?${incidentQueryString(incidentFilters)}`,
        { signal },
      ),
    [projectKey, version, JSON.stringify(incidentFilters)],
    enabled,
  );

  const observations = useResource<Paged<SafetyObservation>>(
    (signal) =>
      api.get<Paged<SafetyObservation>>(
        `/api/v1/projects/${projectKey}/safety/observations?${observationQueryString(observationFilters)}`,
        { signal },
      ),
    [projectKey, version, JSON.stringify(observationFilters)],
    enabled,
  );

  const actions = useResource<ActionListResponse>(
    (signal) =>
      api.get<ActionListResponse>(
        `/api/v1/projects/${projectKey}/safety/corrective-actions?${actionQueryString(actionFilters)}`,
        { signal },
      ),
    [projectKey, version, JSON.stringify(actionFilters)],
    enabled,
  );

  const inspections = useResource<Paged<SafetyInspection>>(
    (signal) =>
      api.get<Paged<SafetyInspection>>(
        `/api/v1/projects/${projectKey}/safety/inspections?${inspectionQueryString(inspectionFilters)}`,
        { signal },
      ),
    [projectKey, version, JSON.stringify(inspectionFilters)],
    enabled,
  );

  const templates = useResource<Paged<InspectionTemplate>>(
    (signal) =>
      api.get<Paged<InspectionTemplate>>(
        "/api/v1/companies/current/safety/inspection-templates?page=1&pageSize=200",
        { signal },
      ),
    [version],
    enabled,
  );

  const talks = useResource<Paged<ToolboxTalk>>(
    (signal) =>
      api.get<Paged<ToolboxTalk>>(
        `/api/v1/projects/${projectKey}/safety/toolbox-talks?${talkQueryString(talkFilters)}`,
        { signal },
      ),
    [projectKey, version, JSON.stringify(talkFilters)],
    enabled,
  );

  const programme = useResource<Paged<ProgrammeRecord>>(
    (signal) =>
      api.get<Paged<ProgrammeRecord>>(
        `/api/v1/projects/${projectKey}/safety/programme-records?${programmeQueryString(programmeFilters)}`,
        { signal },
      ),
    [projectKey, version, JSON.stringify(programmeFilters)],
    enabled,
  );

  /**
   * Changing any filter returns the register to its first page.
   *
   * Without this a reader on page 4 who narrows the filter is shown "no rows"
   * for a register that has plenty — the emptiest possible lie a filtered view
   * can tell.
   */
  function withPageReset<T extends { page: string }>(
    current: T,
    set: (next: T) => void,
  ): (next: T) => void {
    return (next) => {
      const changedSomethingElse = Object.keys(next).some(
        (key) =>
          key !== "page" &&
          (next as Record<string, string>)[key] !== (current as Record<string, string>)[key],
      );
      set(changedSomethingElse ? { ...next, page: "1" } : next);
    };
  }

  const sensorEvents = useResource<Paged<SensorEvent>>(
    (signal) =>
      api.get<Paged<SensorEvent>>(
        `/api/v1/projects/${projectKey}/safety/sensor-events?${deviceQueryString(deviceFilters)}`,
        { signal },
      ),
    [projectKey, version, JSON.stringify(deviceFilters)],
    enabled,
  );

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams);
      if (value) params.set(key, value);
      else params.delete(key);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  /**
   * The two facts that outrank everything else on this screen.
   *
   * Read from the SUMMARY, which is unfiltered and unwindowed. They used to be
   * derived from `incidents.data.items` — the current tab's filtered first
   * page — so applying any incident filter that excluded the offending record,
   * or holding more than one page of incidents, silently removed the red
   * "statutory notification deadline has passed" banner from the whole
   * workspace while the duty was still live.
   */
  const alarm = useMemo(() => {
    const standing = summary.data?.statutory;
    return {
      missed: standing?.missedRefs ?? [],
      missedDuties: standing?.missedDuties ?? 0,
      unsettled: standing?.reviewRefs ?? [],
      awaiting: standing?.awaitingRefs ?? [],
      outstandingDuties: standing?.outstandingDuties ?? 0,
    };
  }, [summary.data]);

  if (!projectId) {
    return (
      <Alert tone="danger" title="No project in the route">
        The safety workspace is project-scoped. Reportability turns on the project's jurisdiction and
        every rate turns on the project's exposure hours, so neither can be computed without knowing
        which project this is.
      </Alert>
    );
  }

  const openActions = summary.data?.correctiveActions.overdue ?? 0;

  return (
    <div>
      <PageHeader
        icon={IconSafety}
        title="Safety"
        subtitle="Observations, incidents, corrective actions, inspections, briefings and the safety programme — with the statutory clock running where one applies."
        meta={
          summary.data ? (
            <>
              <span>
                {count(summary.data.incidents.total)} incidents ·{" "}
                {count(summary.data.observations.total)} observations ·{" "}
                {count(summary.data.correctiveActions.total)} actions
              </span>
              {summary.data.signals.open > 0 ? (
                <Badge tone="danger" size="sm" dot>
                  {count(summary.data.signals.open)} open safety signals
                </Badge>
              ) : null}
              <span>assessed {summary.data.asOf}</span>
            </>
          ) : null
        }
        tabs={
          <Tabs
            items={TABS.map((t) => ({
              value: t.value,
              label: t.label,
              ...(t.value === "incidents" && alarm.awaiting.length > 0
                ? { count: alarm.awaiting.length, tone: "danger" as const }
                : {}),
              ...(t.value === "actions" && openActions > 0
                ? { count: openActions, tone: "warning" as const }
                : {}),
            }))}
            value={tab}
            onChange={selectTab}
            aria-label="Safety sections"
          />
        }
      />

      {alarm.missed.length > 0 ? (
        <div className="mb-3">
          <Alert
            tone="danger"
            title={`${alarm.missedDuties} statutory notification deadline${alarm.missedDuties === 1 ? " has" : "s have"} passed`}
          >
            <p>
              {alarm.missed
                .slice(0, 4)
                .map((i) =>
                  i.regimes && i.regimes.length > 0
                    ? `${i.reference} (${i.regimes.join(", ")})`
                    : i.reference,
                )
                .join(", ")}
              {alarm.missed.length > 4 ? ` and ${alarm.missed.length - 4} more` : ""}. Failing to
              notify is an offence in its own right, separate from whatever caused the incident. The
              deadline does not stop mattering once it has passed — record the notification and the
              date it was actually made. An incident answerable to two authorities owes two
              notifications: discharging one discharges nothing of the other.
            </p>
          </Alert>
        </div>
      ) : null}

      {alarm.unsettled.length > 0 ? (
        <div className="mb-3">
          <Alert
            tone="warning"
            title={`${alarm.unsettled.length} determination${alarm.unsettled.length === 1 ? "" : "s"} awaiting a human decision`}
          >
            <p>
              The reportability engine could not decide at least one statutory test on the facts
              held for{" "}
              {alarm.unsettled
                .slice(0, 4)
                .map((i) => i.reference)
                .join(", ")}
              {alarm.unsettled.length > 4 ? ` and ${alarm.unsettled.length - 4} more` : ""}. An
              undecided test is not a negative result: answer the open questions on the incident
              before treating any of these as not reportable.
            </p>
          </Alert>
        </div>
      ) : null}

      {tab === "dashboard" ? (
        <DashboardTab
          statistics={statistics}
          summary={summary}
          hierarchy={actions.data?.hierarchyProfile ?? null}
          window={statsWindow}
          onWindow={setStatsWindow}
        />
      ) : tab === "incidents" ? (
        <IncidentsTab
          incidents={incidents}
          filters={incidentFilters}
          onFilters={withPageReset(incidentFilters, setIncidentFilters)}
          users={users}
          vendors={vendors}
          onOpen={(id) => {
            setOpenIncident(id);
            setParam("incident", id);
          }}
          onNew={() => setNewRecord("incident")}
        />
      ) : tab === "observations" ? (
        <ObservationsTab
          observations={observations}
          filters={observationFilters}
          onFilters={withPageReset(observationFilters, setObservationFilters)}
          users={users}
          onOpen={(id) => {
            setOpenObservation(id);
            setParam("observation", id);
          }}
          onNew={() => setNewRecord("observation")}
        />
      ) : tab === "actions" ? (
        <ActionsTab
          actions={actions}
          filters={actionFilters}
          onFilters={withPageReset(actionFilters, setActionFilters)}
          users={users}
          vendors={vendors}
          onOpen={(id) => {
            setOpenAction(id);
            setParam("action", id);
          }}
        />
      ) : tab === "inspections" ? (
        <InspectionsTab
          inspections={inspections}
          templates={templates}
          filters={inspectionFilters}
          onFilters={withPageReset(inspectionFilters, setInspectionFilters)}
          users={users}
          onOpen={(id) => {
            setOpenInspection(id);
            setParam("inspection", id);
          }}
          onNew={() => setCreating("inspection")}
          onNewTemplate={() => setCreating("template")}
        />
      ) : tab === "devices" ? (
        <DevicesTab
          projectId={projectKey}
          events={sensorEvents}
          filters={deviceFilters}
          onFilters={withPageReset(deviceFilters, setDeviceFilters)}
          users={users}
          onMutated={refresh}
        />
      ) : tab === "statutory" ? (
        <StatutoryTab
          projectId={projectKey}
          incidents={incidents}
          users={users}
          version={version}
          onMutated={refresh}
        />
      ) : tab === "risk" ? (
        <RiskTab projectId={projectKey} version={version} onMutated={refresh} />
      ) : tab === "talks" ? (
        <TalksTab
          talks={talks}
          filters={talkFilters}
          onFilters={withPageReset(talkFilters, setTalkFilters)}
          users={users}
          vendors={vendors}
          onOpen={(id) => {
            setOpenTalk(id);
            setParam("talk", id);
          }}
          onNew={() => setCreating("talk")}
        />
      ) : (
        <ProgrammeTab
          records={programme}
          filters={programmeFilters}
          onFilters={withPageReset(programmeFilters, setProgrammeFilters)}
          users={users}
          vendors={vendors}
          onOpen={(id) => {
            setOpenProgrammeRecord(id);
            setParam("record", id);
          }}
          onNew={() => setCreating("programme")}
        />
      )}

      <IncidentDrawer
        projectId={projectKey}
        incidentId={openIncident}
        users={users}
        vendors={vendors}
        onClose={() => {
          setOpenIncident(null);
          setParam("incident", null);
        }}
        onMutated={refresh}
      />

      <ObservationDrawer
        projectId={projectKey}
        observationId={openObservation}
        users={users}
        vendors={vendors}
        onClose={() => {
          setOpenObservation(null);
          setParam("observation", null);
        }}
        onMutated={refresh}
      />

      <ActionDrawer
        projectId={projectKey}
        actionId={openAction}
        users={users}
        vendors={vendors}
        onClose={() => {
          setOpenAction(null);
          setParam("action", null);
        }}
        onMutated={refresh}
      />

      <InspectionDrawer
        projectId={projectKey}
        inspectionId={openInspection}
        users={users}
        vendors={vendors}
        onClose={() => {
          setOpenInspection(null);
          setParam("inspection", null);
        }}
        onMutated={refresh}
      />

      <TalkDrawer
        projectId={projectKey}
        talkId={openTalk}
        users={users}
        vendors={vendors}
        onClose={() => {
          setOpenTalk(null);
          setParam("talk", null);
        }}
        onMutated={refresh}
      />

      <ProgrammeDrawer
        recordId={openProgrammeRecord}
        users={users}
        vendors={vendors}
        onClose={() => {
          setOpenProgrammeRecord(null);
          setParam("record", null);
        }}
        onMutated={refresh}
      />

      <NewInspectionModal
        projectId={projectKey}
        open={creating === "inspection"}
        templates={templates}
        onClose={() => setCreating(null)}
        onCreated={(id) => {
          setCreating(null);
          refresh();
          setOpenInspection(id);
          setParam("inspection", id);
        }}
      />

      <NewTemplateModal
        open={creating === "template"}
        onClose={() => setCreating(null)}
        onCreated={() => {
          setCreating(null);
          refresh();
        }}
      />

      <NewTalkModal
        projectId={projectKey}
        open={creating === "talk"}
        vendors={vendors}
        onClose={() => setCreating(null)}
        onCreated={(id) => {
          setCreating(null);
          refresh();
          setOpenTalk(id);
          setParam("talk", id);
        }}
      />

      <NewProgrammeRecordModal
        projectId={projectKey}
        open={creating === "programme"}
        vendors={vendors}
        onClose={() => setCreating(null)}
        onCreated={(id) => {
          setCreating(null);
          refresh();
          setOpenProgrammeRecord(id);
          setParam("record", id);
        }}
      />

      <NewRecordModal
        projectId={projectKey}
        kind={newRecord}
        onClose={() => setNewRecord(null)}
        onCreated={(kind, id) => {
          setNewRecord(null);
          refresh();
          if (kind === "incident") {
            setOpenIncident(id);
            setParam("incident", id);
          } else {
            setOpenObservation(id);
            setParam("observation", id);
          }
        }}
      />
    </div>
  );
}
