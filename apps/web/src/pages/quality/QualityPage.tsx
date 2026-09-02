/**
 * QUALITY workspace — module M22. Routed at /projects/:projectId/quality.
 *
 * One chain, end to end, and the tabs follow it in the order the work does:
 *
 *   Overview      what is stopping work today, and the figures — each one
 *                 stating its inputs or admitting it has none
 *   Plans         inspection and test plans, and their activity sequence
 *   Hold points   every intervention point on the project in one board,
 *                 ordered by consequence rather than by reference
 *   Checklists    the records made when a point is reached, item by item,
 *                 with numeric tolerances drawn rather than ticked
 *   Site records  concrete, welding and NDT, material certificates and the
 *                 calibration of the instruments every reading depends on
 *   NCRs          the disposition workflow — proposed by one person, approved
 *                 by another, and refused when they are the same person
 *   Concessions   every departure somebody agreed to, and when it expires
 *   Rework        what it cost to do it twice, split by cause and by where it
 *                 was caught — the cost of quality and first-time-right
 *   Commissioning systems as a hierarchy, with pre-functional and functional
 *                 test records and their witnesses
 *   Turnover      required artefacts against present ones. The gap leads.
 *   Closeout      the year after handover: defects liability, performance
 *                 guarantees and their LD exposure, training, spares, POE
 *   Audits        findings with requirement, evidence and conclusion, and the
 *                 ISO 9001 evidence pack assembled from what the platform holds
 *
 * Everything opens in a drawer over whichever tab you are on, so the register
 * keeps its place while one record is worked on. Every write bumps a version
 * counter that every read depends on, so a release recorded in a drawer moves
 * the overdue count on the overview without a manual refresh.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, PageHeader, Tabs } from "../../ui";
import { IconQuality } from "../../ui/icons";
import { api } from "../../lib/api";
import AuditsTab from "./AuditsTab";
import ChecklistDrawer from "./ChecklistDrawer";
import ChecklistsTab, { EMPTY_CHECKLIST_FILTERS, type ChecklistFilters } from "./ChecklistsTab";
import CloseoutTab, { type CloseoutSection } from "./CloseoutTab";
import CommissioningTab, { EMPTY_CX_FILTERS, type CxFilters } from "./CommissioningTab";
import ConcessionsTab from "./ConcessionsTab";
import HoldPointsTab, {
  EMPTY_HOLD_POINT_FILTERS,
  type HoldPointFilters,
} from "./HoldPointsTab";
import ItpDrawer from "./ItpDrawer";
import ItpsTab, { EMPTY_ITP_FILTERS, type ItpFilters } from "./ItpsTab";
import NcrDrawer from "./NcrDrawer";
import NcrsTab, { EMPTY_NCR_FILTERS, type NcrFilters } from "./NcrsTab";
import OverviewTab from "./OverviewTab";
import RecordsTab, { type RecordsSection } from "./RecordsTab";
import ReworkTab from "./ReworkTab";
import SystemDrawer from "./SystemDrawer";
import TurnoverDrawer from "./TurnoverDrawer";
import TurnoverTab from "./TurnoverTab";
import { plural, query, useCompanyUsers, useResource } from "./qualityShared";
import type {
  AuditFinding,
  Checklist,
  ChecklistTemplate,
  CloseoutSummary,
  Concession,
  ConcessionSummary,
  CostOfQuality,
  CxSystem,
  FirstTimeRight,
  HoldPointPage,
  IsoEvidence,
  Itp,
  Ncr,
  Paged,
  QualityAudit,
  QualitySummary,
  ReworkItem,
  ReworkSummary,
  TurnoverSummary,
} from "./types";

type TabKey =
  | "overview"
  | "itps"
  | "holdPoints"
  | "checklists"
  | "records"
  | "ncrs"
  | "concessions"
  | "rework"
  | "commissioning"
  | "turnover"
  | "closeout"
  | "audits";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "itps", label: "Plans" },
  { value: "holdPoints", label: "Hold points" },
  { value: "checklists", label: "Checklists" },
  { value: "records", label: "Site records" },
  { value: "ncrs", label: "NCRs" },
  { value: "concessions", label: "Concessions" },
  { value: "rework", label: "Rework" },
  { value: "commissioning", label: "Commissioning" },
  { value: "turnover", label: "Turnover" },
  { value: "closeout", label: "Closeout" },
  { value: "audits", label: "Audits" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function QualityPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const projectKey = projectId ?? "";
  const users = useCompanyUsers();

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "overview";
  });

  /** Bumped by every write anywhere in the workspace; every read depends on it. */
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const [itpFilters, setItpFilters] = useState<ItpFilters>(EMPTY_ITP_FILTERS);
  const [holdFilters, setHoldFilters] = useState<HoldPointFilters>(EMPTY_HOLD_POINT_FILTERS);
  const [checklistFilters, setChecklistFilters] =
    useState<ChecklistFilters>(EMPTY_CHECKLIST_FILTERS);
  const [ncrFilters, setNcrFilters] = useState<NcrFilters>(EMPTY_NCR_FILTERS);
  const [cxFilters, setCxFilters] = useState<CxFilters>(EMPTY_CX_FILTERS);
  const [recordsSection, setRecordsSection] = useState<RecordsSection>("concrete");
  const [closeoutSection, setCloseoutSection] = useState<CloseoutSection>("dlp");

  const [openItp, setOpenItp] = useState<string | null>(() => searchParams.get("itp"));
  const [openChecklist, setOpenChecklist] = useState<string | null>(() =>
    searchParams.get("checklist"),
  );
  const [openNcr, setOpenNcr] = useState<string | null>(() => searchParams.get("ncr"));
  const [openSystem, setOpenSystem] = useState<string | null>(() => searchParams.get("system"));
  const [openPackage, setOpenPackage] = useState<string | null>(() =>
    searchParams.get("package"),
  );

  const enabled = projectKey !== "";

  const summary = useResource<QualitySummary>(
    (signal) =>
      api.get<QualitySummary>(`/api/v1/projects/${projectKey}/quality/summary`, { signal }),
    [projectKey, version],
    enabled,
  );

  const itps = useResource<Paged<Itp>>(
    (signal) =>
      api.get<Paged<Itp>>(
        `/api/v1/projects/${projectKey}/itps?${query({
          page: 1,
          pageSize: 200,
          status: itpFilters.status,
          discipline: itpFilters.discipline,
          search: itpFilters.search,
        })}`,
        { signal },
      ),
    [projectKey, version, itpFilters.status, itpFilters.discipline, itpFilters.search],
    enabled,
  );

  const holdPoints = useResource<HoldPointPage>(
    (signal) =>
      api.get<HoldPointPage>(
        `/api/v1/projects/${projectKey}/hold-points?${query({
          page: 1,
          pageSize: 200,
          interventionPoint: holdFilters.interventionPoint,
          status: holdFilters.status,
          openOnly: holdFilters.openOnly,
        })}`,
        { signal },
      ),
    [
      projectKey,
      version,
      holdFilters.interventionPoint,
      holdFilters.status,
      holdFilters.openOnly,
    ],
    enabled,
  );

  /**
   * The same register again, but pinned to "every outstanding point" with no
   * user filters. The ITP register derives its "past their date" column from
   * this rather than from the filtered board — otherwise filtering the board
   * to `released` would quietly zero the overdue count on another tab.
   */
  const openHoldPoints = useResource<HoldPointPage>(
    (signal) =>
      api.get<HoldPointPage>(
        `/api/v1/projects/${projectKey}/hold-points?${query({
          page: 1,
          pageSize: 200,
          openOnly: "true",
        })}`,
        { signal },
      ),
    [projectKey, version],
    enabled,
  );

  const checklists = useResource<Paged<Checklist>>(
    (signal) =>
      api.get<Paged<Checklist>>(
        `/api/v1/projects/${projectKey}/checklists?${query({
          page: 1,
          pageSize: 200,
          status: checklistFilters.status,
          category: checklistFilters.category,
          result: checklistFilters.result,
          search: checklistFilters.search,
        })}`,
        { signal },
      ),
    [
      projectKey,
      version,
      checklistFilters.status,
      checklistFilters.category,
      checklistFilters.result,
      checklistFilters.search,
    ],
    enabled,
  );

  const templates = useResource<Paged<ChecklistTemplate>>(
    (signal) =>
      api.get<Paged<ChecklistTemplate>>(
        "/api/v1/companies/current/checklist-templates?page=1&pageSize=200",
        { signal },
      ),
    [version],
    enabled,
  );

  const ncrs = useResource<Paged<Ncr>>(
    (signal) =>
      api.get<Paged<Ncr>>(
        `/api/v1/projects/${projectKey}/ncrs?${query({
          page: 1,
          pageSize: 200,
          status: ncrFilters.status,
          severity: ncrFilters.severity,
          category: ncrFilters.category,
          disposition: ncrFilters.disposition,
          openOnly: ncrFilters.openOnly,
          search: ncrFilters.search,
        })}`,
        { signal },
      ),
    [
      projectKey,
      version,
      ncrFilters.status,
      ncrFilters.severity,
      ncrFilters.category,
      ncrFilters.disposition,
      ncrFilters.openOnly,
      ncrFilters.search,
    ],
    enabled,
  );

  const systems = useResource<Paged<CxSystem>>(
    (signal) =>
      api.get<Paged<CxSystem>>(
        `/api/v1/projects/${projectKey}/commissioning/systems?${query({
          page: 1,
          pageSize: 200,
          status: cxFilters.status,
          level: cxFilters.level,
          discipline: cxFilters.discipline,
          search: cxFilters.search,
        })}`,
        { signal },
      ),
    [projectKey, version, cxFilters.status, cxFilters.level, cxFilters.discipline, cxFilters.search],
    enabled,
  );

  const turnover = useResource<TurnoverSummary>(
    (signal) =>
      api.get<TurnoverSummary>(`/api/v1/projects/${projectKey}/turnover-packages-summary`, {
        signal,
      }),
    [projectKey, version],
    enabled,
  );

  /*
   * The registers added by the upgrade wave. Each one is loaded independently
   * so a failure in, say, the ISO evidence pack cannot blank the concession
   * register beside it — every panel fails alone, and a failed load is drawn
   * as a failure rather than as an empty register.
   */
  const concessions = useResource<Paged<Concession>>(
    (signal) =>
      api.get<Paged<Concession>>(
        `/api/v1/projects/${projectKey}/concessions?page=1&pageSize=200`,
        { signal },
      ),
    [projectKey, version],
    enabled,
  );

  const concessionSummary = useResource<ConcessionSummary>(
    (signal) =>
      api.get<ConcessionSummary>(`/api/v1/projects/${projectKey}/concessions-summary`, { signal }),
    [projectKey, version],
    enabled,
  );

  const rework = useResource<Paged<ReworkItem>>(
    (signal) =>
      api.get<Paged<ReworkItem>>(
        `/api/v1/projects/${projectKey}/rework-items?page=1&pageSize=200`,
        { signal },
      ),
    [projectKey, version],
    enabled,
  );

  const reworkSummary = useResource<ReworkSummary>(
    (signal) =>
      api.get<ReworkSummary>(`/api/v1/projects/${projectKey}/rework-summary`, { signal }),
    [projectKey, version],
    enabled,
  );

  const costOfQuality = useResource<CostOfQuality>(
    (signal) =>
      api.get<CostOfQuality>(`/api/v1/projects/${projectKey}/quality/cost-of-quality`, { signal }),
    [projectKey, version],
    enabled,
  );

  const firstTimeRight = useResource<FirstTimeRight>(
    (signal) =>
      api.get<FirstTimeRight>(`/api/v1/projects/${projectKey}/quality/first-time-right`, {
        signal,
      }),
    [projectKey, version],
    enabled,
  );

  const audits = useResource<Paged<QualityAudit>>(
    (signal) =>
      api.get<Paged<QualityAudit>>(
        `/api/v1/projects/${projectKey}/quality-audits?page=1&pageSize=200`,
        { signal },
      ),
    [projectKey, version],
    enabled,
  );

  const auditFindings = useResource<Paged<AuditFinding>>(
    (signal) =>
      api.get<Paged<AuditFinding>>(
        `/api/v1/projects/${projectKey}/audit-findings?page=1&pageSize=200`,
        { signal },
      ),
    [projectKey, version],
    enabled,
  );

  const isoEvidence = useResource<IsoEvidence>(
    (signal) =>
      api.get<IsoEvidence>(`/api/v1/projects/${projectKey}/iso9001-evidence`, { signal }),
    [projectKey, version],
    enabled,
  );

  const closeoutSummary = useResource<CloseoutSummary>(
    (signal) =>
      api.get<CloseoutSummary>(`/api/v1/projects/${projectKey}/closeout-summary`, { signal }),
    [projectKey, version],
    enabled,
  );

  function selectTab(next: TabKey) {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  }

  const openRecord = useCallback(
    (key: "itp" | "checklist" | "ncr" | "system" | "package", id: string | null) => {
      const setter =
        key === "itp"
          ? setOpenItp
          : key === "checklist"
            ? setOpenChecklist
            : key === "ncr"
              ? setOpenNcr
              : key === "system"
                ? setOpenSystem
                : setOpenPackage;
      setter(id);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (id) params.set(key, id);
          else params.delete(key);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const counts = useMemo(() => {
    const s = summary.data;
    const c = concessionSummary.data;
    const co = closeoutSummary.data;
    const findings = auditFindings.data?.items ?? [];
    return {
      holdPoints: s ? s.holdPoints.overdue : 0,
      ncrs: s ? s.ncrs.awaitingDispositionApproval + s.ncrs.overdue : 0,
      turnover: s ? s.turnover.gaps.length : 0,
      /* A concession about to lapse turns conforming work non-conforming again. */
      concessions: c ? c.expiring.length + c.expired : 0,
      /* Closeout leads with the two clocks nobody watches: the period and the guarantee. */
      closeout: co
        ? co.dlps.expiringWithin60Days.length +
          co.guarantees.notMet +
          co.dlps.handedOverPackagesWithoutAPeriod.length
        : 0,
      /* Only a major non-conformity still open earns a badge: a minor one is
         work, a major one is a finding somebody has to answer. */
      audits: findings.filter(
        (f) =>
          f.findingType === "major_nonconformity" &&
          !["verified", "closed", "rejected"].includes(f.status),
      ).length,
    };
  }, [summary.data, concessionSummary.data, closeoutSummary.data, auditFindings.data]);

  if (!projectId) {
    return (
      <Alert tone="danger" title="No project in the route">
        This workspace is project-scoped. An assurance record belongs to a project, and there is no
        honest way to show hold points, non-conformances or a turnover gap without knowing which
        project they belong to.
      </Alert>
    );
  }

  const s = summary.data;

  return (
    <div>
      <PageHeader
        icon={IconQuality}
        title="Quality"
        subtitle="Inspection and test plans, checklists, non-conformance and commissioning through to turnover. Work does not proceed past an unreleased hold point, a disposition is never approved by the person who proposed it, and a turnover gap is named rather than summarised."
        meta={
          s ? (
            <span>
              {s.itps.total} {plural(s.itps.total, "plan")} · {s.holdPoints.open} open{" "}
              {plural(s.holdPoints.open, "hold point")} · {s.ncrs.open} open{" "}
              {plural(s.ncrs.open, "NCR")} · {s.commissioning.systems}{" "}
              {plural(s.commissioning.systems, "system")} · {s.turnover.packages}{" "}
              {plural(s.turnover.packages, "turnover package")}
            </span>
          ) : null
        }
        tabs={
          <Tabs
            items={TABS.map((t) => ({
              value: t.value,
              label: t.label,
              ...(t.value === "holdPoints" && counts.holdPoints > 0
                ? { count: counts.holdPoints, tone: "danger" as const }
                : {}),
              ...(t.value === "ncrs" && counts.ncrs > 0
                ? { count: counts.ncrs, tone: "warning" as const }
                : {}),
              ...(t.value === "turnover" && counts.turnover > 0
                ? { count: counts.turnover, tone: "danger" as const }
                : {}),
              ...(t.value === "concessions" && counts.concessions > 0
                ? { count: counts.concessions, tone: "warning" as const }
                : {}),
              ...(t.value === "closeout" && counts.closeout > 0
                ? { count: counts.closeout, tone: "warning" as const }
                : {}),
              ...(t.value === "audits" && counts.audits > 0
                ? { count: counts.audits, tone: "danger" as const }
                : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "overview" ? (
        <OverviewTab summary={summary} projectId={projectId} onGoTo={selectTab} />
      ) : tab === "itps" ? (
        <ItpsTab
          itps={itps}
          holdPoints={openHoldPoints}
          filters={itpFilters}
          onFilters={setItpFilters}
          projectId={projectId}
          onOpen={(id) => openRecord("itp", id)}
          onMutated={refresh}
          onGoToHoldPoints={() => selectTab("holdPoints")}
        />
      ) : tab === "holdPoints" ? (
        <HoldPointsTab
          holdPoints={holdPoints}
          filters={holdFilters}
          onFilters={setHoldFilters}
          projectId={projectId}
          users={users}
          onMutated={refresh}
          onOpenItp={(id) => openRecord("itp", id)}
        />
      ) : tab === "checklists" ? (
        <ChecklistsTab
          checklists={checklists}
          templates={templates}
          filters={checklistFilters}
          onFilters={setChecklistFilters}
          projectId={projectId}
          onOpen={(id) => openRecord("checklist", id)}
          onMutated={refresh}
        />
      ) : tab === "records" ? (
        <RecordsTab
          section={recordsSection}
          onSection={setRecordsSection}
          projectId={projectId}
          version={version}
          onMutated={refresh}
        />
      ) : tab === "ncrs" ? (
        <NcrsTab
          ncrs={ncrs}
          filters={ncrFilters}
          onFilters={setNcrFilters}
          projectId={projectId}
          users={users}
          onOpen={(id) => openRecord("ncr", id)}
          onMutated={refresh}
        />
      ) : tab === "concessions" ? (
        <ConcessionsTab
          concessions={concessions}
          summary={concessionSummary}
          projectId={projectId}
          users={users}
          onMutated={refresh}
        />
      ) : tab === "rework" ? (
        <ReworkTab
          rework={rework}
          summary={reworkSummary}
          costOfQuality={costOfQuality}
          firstTimeRight={firstTimeRight}
          projectId={projectId}
          onMutated={refresh}
        />
      ) : tab === "commissioning" ? (
        <CommissioningTab
          systems={systems}
          filters={cxFilters}
          onFilters={setCxFilters}
          projectId={projectId}
          onOpen={(id) => openRecord("system", id)}
          onMutated={refresh}
        />
      ) : tab === "closeout" ? (
        <CloseoutTab
          section={closeoutSection}
          onSection={setCloseoutSection}
          projectId={projectId}
          version={version}
          users={users}
          onMutated={refresh}
        />
      ) : tab === "audits" ? (
        <AuditsTab
          audits={audits}
          findings={auditFindings}
          evidence={isoEvidence}
          projectId={projectId}
          users={users}
          onMutated={refresh}
        />
      ) : (
        <TurnoverTab
          summary={turnover}
          projectId={projectId}
          onOpen={(id) => openRecord("package", id)}
          onMutated={refresh}
        />
      )}

      <ItpDrawer
        itpId={openItp}
        projectId={projectId}
        users={users}
        onClose={() => openRecord("itp", null)}
        onMutated={refresh}
      />
      <ChecklistDrawer
        checklistId={openChecklist}
        projectId={projectId}
        users={users}
        onClose={() => openRecord("checklist", null)}
        onMutated={refresh}
      />
      <NcrDrawer
        ncrId={openNcr}
        projectId={projectId}
        users={users}
        onClose={() => openRecord("ncr", null)}
        onMutated={refresh}
      />
      <SystemDrawer
        systemId={openSystem}
        projectId={projectId}
        users={users}
        onClose={() => openRecord("system", null)}
        onMutated={refresh}
      />
      <TurnoverDrawer
        packageId={openPackage}
        projectId={projectId}
        users={users}
        onClose={() => openRecord("package", null)}
        onMutated={refresh}
      />
    </div>
  );
}
