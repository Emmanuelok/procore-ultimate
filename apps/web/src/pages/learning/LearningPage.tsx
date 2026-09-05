/**
 * Organisational learning & knowledge capture — spec Vol II Domain W
 * (#976-994) / module M12.
 *
 * Lessons registers fail for two reasons, and every tab here exists to attack
 * one of them:
 *
 *   · Health   — the company scorecard: capture rate, and the open-trigger
 *                backlog aged into buckets so that letting it rot is visible.
 *   · Register — the company-wide register, defaulting to PUBLISHED, with the
 *                per-lesson impact view: did this ever cross a project?
 *   · Triggers — the project's mandatory-capture backlog, its sweep, and the
 *                rule registry that says what fires capture and why.
 *   · Capture  — the lesson lifecycle, retrieval bound to the moment, and
 *                post-project reviews with metrics read from real records.
 *   · Pushed   — the lessons the ranker sent AT this project (#985-986), and
 *                the answer each one got: read, applied with the record that
 *                proves it, or dismissed with the reason it does not apply.
 *   · Search   — natural language over the published register, honest about
 *                whether it is running in AI or deterministic mode.
 *
 * Company scope. The project selector is held here so that switching between
 * Triggers and Capture keeps the same project in hand.
 */
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { EmptyState, ErrorAlert, Field, PageHeader, Select, Spinner } from "../../ui";
import CaptureTab from "./CaptureTab";
import HealthTab from "./HealthTab";
import RegisterTab from "./RegisterTab";
import SearchTab from "./SearchTab";
import PushesPanel from "./PushesPanel";
import TriggersTab from "./TriggersTab";
import { TabBar, projectLabel, useProjects } from "./learningShared";

const TABS = [
  { key: "health", label: "Health" },
  { key: "register", label: "Register" },
  { key: "triggers", label: "Triggers" },
  { key: "capture", label: "Capture & review" },
  { key: "pushes", label: "Pushed here" },
  { key: "search", label: "Search" },
];

const PROJECT_TABS = new Set(["triggers", "capture", "pushes"]);

export default function LearningPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "health";
  });
  const [projectId, setProjectId] = useState("");
  /** hand-off from Health → Register: open this lesson's drawer on arrival */
  const [focusLessonId, setFocusLessonId] = useState<string | null>(null);

  const { projects, error: projectsError } = useProjects();
  const { company } = useAuth();
  /**
   * Company owners and admins bypass tool-level permission checks server-side,
   * and supersede is restricted to them outright. Everything else is still
   * offered to everyone — a member may hold admin rights on the learning tool
   * alone — and any refusal the server returns is surfaced verbatim rather
   * than pre-empted here.
   */
  const canAdmin = company?.role === "owner" || company?.role === "admin";

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  const inspectLesson = useCallback(
    (lessonId: string) => {
      setFocusLessonId(lessonId);
      setTab("register");
      setSearchParams({ tab: "register" }, { replace: true });
    },
    [setSearchParams],
  );

  const openProjectTriggers = useCallback(
    (id: string) => {
      setProjectId(id);
      setTab("triggers");
      setSearchParams({ tab: "triggers" }, { replace: true });
    },
    [setSearchParams],
  );

  const needsProject = PROJECT_TABS.has(tab);

  return (
    <div>
      <PageHeader
        title="Organisational learning"
        subtitle="Capture made mandatory by triggers off real events, retrieval ranked against the work in hand with its reasons shown, and every lesson measured by whether it ever crossed a project boundary"
      />

      <ErrorAlert message={projectsError} />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {needsProject ? (
        <div className="mb-4">
          {projects === null ? (
            <Spinner label="Loading projects…" />
          ) : projects.length === 0 ? (
            <EmptyState
              title="No projects in this company"
              hint="Capture triggers and post-project reviews are per-project. Create a project first, then come back."
            />
          ) : (
            <div className="max-w-md">
              <Field label="Project">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Select a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {projectLabel(p)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
      ) : null}

      {tab === "health" ? (
        <HealthTab
          projects={projects}
          onInspectLesson={inspectLesson}
          onOpenProjectTriggers={openProjectTriggers}
        />
      ) : null}

      {tab === "register" ? (
        <RegisterTab
          projects={projects}
          canSupersede={canAdmin}
          focusLessonId={focusLessonId}
          onFocusConsumed={() => setFocusLessonId(null)}
        />
      ) : null}

      {tab === "triggers" ? (
        projectId ? (
          <TriggersTab projectId={projectId} projects={projects} canSupersede={canAdmin} />
        ) : projects && projects.length > 0 ? (
          <EmptyState
            title="Pick a project"
            hint="The capture backlog is per-project: triggers are raised off that project's disputes, claims, variations, delay events, signals and gates."
          />
        ) : null
      ) : null}

      {tab === "capture" ? (
        projectId ? (
          <CaptureTab projectId={projectId} projects={projects} canAdmin={canAdmin} />
        ) : projects && projects.length > 0 ? (
          <EmptyState
            title="Pick a project"
            hint="Lessons are captured on a project and only leave it when they are published company-wide."
          />
        ) : null
      ) : null}

      {tab === "pushes" ? (
        projectId ? (
          <PushesPanel projectId={projectId} onInspectLesson={inspectLesson} />
        ) : projects && projects.length > 0 ? (
          <EmptyState
            title="Pick a project"
            hint="A push is a lesson the ranker says applies to one project, sent to it rather than waiting to be searched for. Answering a push — read, applied, or does not apply and here is why — is what closes the loop."
          />
        ) : null
      ) : null}

      {tab === "search" ? <SearchTab projects={projects} canSupersede={canAdmin} /> : null}
    </div>
  );
}
