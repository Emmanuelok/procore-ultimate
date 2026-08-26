/**
 * The project workspace context.
 *
 * The shell loads the three things every screen under /projects/:projectId
 * needs — the project record, the cross-tool counters, and the open assurance
 * signals — once, and hands them down. Pages read them with
 * `useProjectWorkspace()` instead of refetching, so opening the overview does
 * not ask the server for the same project three times.
 *
 * The health indicator is DERIVED, never invented. It is a statement about the
 * assurance signals this platform raised on this project, and `health.basis`
 * says so in words that go straight into a tooltip. When the signals cannot be
 * read, health is "Not rated" with the reason — it is never quietly green.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Tone } from "../../ui/tokens";
import {
  OPEN_SIGNAL_DISPOSITIONS,
  useResource,
  type Loadable,
  type Paginated,
  type PrimeContractSummary,
  type ProjectRecord,
  type ProjectSummary,
  type SignalRow,
} from "./lib";

export type HealthLevel = "on_track" | "watch" | "off_track" | "unrated";

export interface ProjectHealth {
  level: HealthLevel;
  label: string;
  tone: Tone;
  /** Verbatim explanation of what the verdict was computed from. */
  basis: string;
  counts: { open: number; critical: number; high: number; medium: number } | null;
}

export interface ProjectWorkspaceValue {
  projectId: string;
  project: Loadable<ProjectRecord>;
  summary: Loadable<ProjectSummary>;
  signals: Loadable<Paginated<SignalRow>>;
  /** The prime-contract position, bucketed by currency. */
  contracts: Loadable<PrimeContractSummary>;
  /** Open signals only, worst first. */
  openSignals: SignalRow[];
  health: ProjectHealth;
  /** Refetch the project record, counters and signals. */
  reloadProject: () => void;
}

const ProjectWorkspaceContext = createContext<ProjectWorkspaceValue | null>(null);

const SIGNAL_PAGE = 200;

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function deriveHealth(
  signals: Loadable<Paginated<SignalRow>>,
  open: SignalRow[],
): ProjectHealth {
  if (signals.loading) {
    return {
      level: "unrated",
      label: "Rating…",
      tone: "neutral",
      basis: "Reading the assurance signals raised on this project.",
      counts: null,
    };
  }
  if (signals.error || !signals.data) {
    return {
      level: "unrated",
      label: "Not rated",
      tone: "neutral",
      basis:
        "The assurance signals for this project could not be read" +
        (signals.error ? ` — ${signals.error}` : "") +
        ", so no health verdict is shown. An unreadable signal register is not a healthy one.",
      counts: null,
    };
  }

  const critical = open.filter((s) => s.severity === "critical").length;
  const high = open.filter((s) => s.severity === "high").length;
  const medium = open.filter((s) => s.severity === "medium").length;
  const truncated = signals.data.total > signals.data.items.length;
  const scope =
    `Derived from the ${open.length} open assurance signal${open.length === 1 ? "" : "s"} ` +
    `on this project (dispositions: new, under review, confirmed, escalated)` +
    (truncated
      ? `, read from the ${signals.data.items.length} most recent of ${signals.data.total} signals.`
      : ".") +
    " It is a detector verdict, not a manually entered RAG rating.";

  if (critical + high > 0) {
    return {
      level: "off_track",
      label: "Off track",
      tone: "danger",
      basis: `${critical} critical and ${high} high-severity signals are open. ${scope}`,
      counts: { open: open.length, critical, high, medium },
    };
  }
  if (medium > 0) {
    return {
      level: "watch",
      label: "At risk",
      tone: "warning",
      basis: `${medium} medium-severity signal${medium === 1 ? " is" : "s are"} open. ${scope}`,
      counts: { open: open.length, critical, high, medium },
    };
  }
  return {
    level: "on_track",
    label: "On track",
    tone: "success",
    basis: `No medium, high or critical assurance signal is open. ${scope}`,
    counts: { open: open.length, critical, high, medium },
  };
}

export function ProjectWorkspaceProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const project = useResource<ProjectRecord>(`/api/v1/projects/${projectId}`);
  const summary = useResource<ProjectSummary>(`/api/v1/projects/${projectId}/summary`);
  const signals = useResource<Paginated<SignalRow>>(
    `/api/v1/projects/${projectId}/signals?page=1&pageSize=${SIGNAL_PAGE}`,
  );
  const contracts = useResource<PrimeContractSummary>(
    `/api/v1/projects/${projectId}/prime-contracts/summary`,
  );

  const openSignals = useMemo(() => {
    const items = signals.data?.items ?? [];
    return items
      .filter((s) => OPEN_SIGNAL_DISPOSITIONS.includes(s.disposition))
      .sort(
        (a, b) =>
          (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
          b.createdAt.localeCompare(a.createdAt),
      );
  }, [signals.data]);

  const health = useMemo(() => deriveHealth(signals, openSignals), [signals, openSignals]);

  const value = useMemo<ProjectWorkspaceValue>(
    () => ({
      projectId,
      project,
      summary,
      signals,
      contracts,
      openSignals,
      health,
      reloadProject: () => {
        project.reload();
        summary.reload();
        signals.reload();
        contracts.reload();
      },
    }),
    [projectId, project, summary, signals, contracts, openSignals, health],
  );

  return (
    <ProjectWorkspaceContext.Provider value={value}>{children}</ProjectWorkspaceContext.Provider>
  );
}

export function useProjectWorkspace(): ProjectWorkspaceValue {
  const value = useContext(ProjectWorkspaceContext);
  if (!value) {
    throw new Error("useProjectWorkspace must be used inside the project workspace shell");
  }
  return value;
}
