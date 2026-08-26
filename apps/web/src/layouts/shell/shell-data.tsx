/**
 * shell/shell-data.tsx — the small amount of shared state the app chrome needs.
 *
 * Three consumers pull from here: the sidebar badges, the top-bar breadcrumbs
 * and the command palette. Each datum comes from a REAL endpoint, and each is
 * `null` until it is known. `null` means "not available" and renders as no
 * badge at all — never as a zero, because "nothing unread" and "we could not
 * ask" are different statements.
 *
 *   unreadNotifications  GET /api/v1/notifications/unread-count  → { count }
 *   openSignals          GET /api/v1/signals/stats               → { byDisposition }
 *   projects             GET /api/v1/projects                    → { items, total, … }
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";

/** Dispositions the API itself counts as open (modules/projects/index.ts). */
const OPEN_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"] as const;

const COUNT_REFRESH_MS = 60_000;
const PROJECT_PAGE_SIZE = 200;

export interface ShellProject {
  id: string;
  name: string;
  number: string | null;
  stage: string | null;
  city: string | null;
  country: string | null;
}

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface SignalStats {
  total: number;
  bySeverity: Record<string, number>;
  byDisposition: Record<string, number>;
}

export interface ShellDataValue {
  /** Unread in-app notifications, or null when the count is unavailable. */
  unreadNotifications: number | null;
  /** Signals in an open disposition, or null when unavailable. */
  openSignals: number | null;
  /** The company's projects, or null while loading / unavailable. */
  projects: readonly ShellProject[] | null;
  /** True once the project list has settled (loaded or failed). */
  projectsReady: boolean;
  /** Total projects on the server — larger than `projects.length` if truncated. */
  projectsTotal: number | null;
  refreshCounts: () => void;
  refreshProjects: () => void;
}

const FALLBACK: ShellDataValue = {
  unreadNotifications: null,
  openSignals: null,
  projects: null,
  projectsReady: false,
  projectsTotal: null,
  refreshCounts: () => undefined,
  refreshProjects: () => undefined,
};

const ShellDataContext = createContext<ShellDataValue | null>(null);

export function ShellDataProvider({ children }: { children: ReactNode }) {
  const { user, companyId } = useAuth();
  const authed = Boolean(user);

  const [unreadNotifications, setUnread] = useState<number | null>(null);
  const [openSignals, setOpenSignals] = useState<number | null>(null);
  const [projects, setProjects] = useState<readonly ShellProject[] | null>(null);
  const [projectsTotal, setProjectsTotal] = useState<number | null>(null);
  const [projectsReady, setProjectsReady] = useState(false);
  const [countTick, setCountTick] = useState(0);
  const [projectTick, setProjectTick] = useState(0);

  const refreshCounts = useCallback(() => setCountTick((n) => n + 1), []);
  const refreshProjects = useCallback(() => setProjectTick((n) => n + 1), []);

  /* -- counts ------------------------------------------------------------ */
  useEffect(() => {
    if (!authed) {
      setUnread(null);
      setOpenSignals(null);
      return;
    }
    let cancelled = false;

    const load = () => {
      api
        .get<{ count?: number }>("/api/v1/notifications/unread-count")
        .then((res) => {
          if (cancelled) return;
          const value = Number(res?.count);
          setUnread(Number.isFinite(value) ? value : null);
        })
        .catch(() => {
          if (!cancelled) setUnread(null);
        });

      api
        .get<SignalStats>("/api/v1/signals/stats")
        .then((res) => {
          if (cancelled) return;
          const byDisposition = res?.byDisposition;
          if (!byDisposition || typeof byDisposition !== "object") {
            setOpenSignals(null);
            return;
          }
          let open = 0;
          for (const key of OPEN_DISPOSITIONS) open += Number(byDisposition[key] ?? 0);
          setOpenSignals(Number.isFinite(open) ? open : null);
        })
        .catch(() => {
          if (!cancelled) setOpenSignals(null);
        });
    };

    load();
    const timer = window.setInterval(load, COUNT_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authed, companyId, countTick]);

  /* -- projects ---------------------------------------------------------- */
  useEffect(() => {
    if (!authed) {
      setProjects(null);
      setProjectsTotal(null);
      setProjectsReady(false);
      return;
    }
    let cancelled = false;
    setProjectsReady(false);
    api
      .get<ListResponse<ShellProject>>(`/api/v1/projects?page=1&pageSize=${PROJECT_PAGE_SIZE}`)
      .then((res) => {
        if (cancelled) return;
        setProjects(Array.isArray(res.items) ? res.items : []);
        setProjectsTotal(Number.isFinite(res.total) ? res.total : null);
        setProjectsReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setProjects(null);
        setProjectsTotal(null);
        setProjectsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authed, companyId, projectTick]);

  const value = useMemo<ShellDataValue>(
    () => ({
      unreadNotifications,
      openSignals,
      projects,
      projectsReady,
      projectsTotal,
      refreshCounts,
      refreshProjects,
    }),
    [
      unreadNotifications,
      openSignals,
      projects,
      projectsReady,
      projectsTotal,
      refreshCounts,
      refreshProjects,
    ],
  );

  return <ShellDataContext.Provider value={value}>{children}</ShellDataContext.Provider>;
}

export function useShellData(): ShellDataValue {
  return useContext(ShellDataContext) ?? FALLBACK;
}

/**
 * The display name for a project id — from the cached list where possible,
 * otherwise a single fetch. Returns `null` while unknown so callers can render
 * a skeleton instead of guessing.
 */
export function useProjectName(projectId: string | undefined): string | null {
  const { projects } = useShellData();
  const [fetched, setFetched] = useState<string | null>(null);
  const cache = useRef(new Map<string, string>());

  const fromList = useMemo(() => {
    if (!projectId || !projects) return null;
    return projects.find((project) => project.id === projectId)?.name ?? null;
  }, [projectId, projects]);

  useEffect(() => {
    if (!projectId || fromList) {
      // Never let the previous project's name linger under a new id.
      setFetched(null);
      return;
    }
    const cached = cache.current.get(projectId);
    if (cached) {
      setFetched(cached);
      return;
    }
    setFetched(null);
    let cancelled = false;
    api
      .get<{ name?: string }>(`/api/v1/projects/${projectId}`)
      .then((res) => {
        if (cancelled || !res?.name) return;
        cache.current.set(projectId, res.name);
        setFetched(res.name);
      })
      .catch(() => {
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, fromList]);

  return fromList ?? fetched;
}
