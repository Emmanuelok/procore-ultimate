/**
 * search.tsx — the ⌘K command palette.
 *
 * WHAT IT SEARCHES, HONESTLY
 * --------------------------
 * ConstructOS has no cross-record search endpoint. There is no
 * `GET /api/v1/search`; the only list route that accepts a free-text term is
 * `GET /api/v1/projects?search=`. So this palette searches exactly two things:
 *
 *   • navigation destinations — scored in the browser
 *   • projects — the first page held in memory, PLUS a live
 *     `/api/v1/projects?search=` query once you have typed two characters
 *
 * It does not search RFIs, submittals, drawings, documents or contracts, and
 * the empty state says so rather than implying a company-wide index exists.
 *
 * Built on <CommandMenu> from ../ui/overlays: portal, scrim, focus trap,
 * Escape and cmdk's fuzzy scoring all come from the primitive.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CommandGroup,
  CommandItem,
  CommandMenu,
  CommandShortcut,
  Kbd,
} from "../ui";
import {
  IconArrowUpRight,
  IconClock,
  IconDensity,
  IconKeyboard,
  IconLogout,
  IconMoon,
  IconProject,
  IconSearch,
  IconSun,
  IconSystem,
  type IconComponent,
} from "../ui/icons";
import { api } from "./api";
import { useAuth } from "./auth";
import { useShortcut, useShortcuts, MOD_LABEL } from "./shortcuts";
import { useTheme } from "./theme";
import { NAV_ITEMS, PROJECT_DESTINATIONS } from "../layouts/shell/nav";
import { useShellData, type ShellProject } from "../layouts/shell/shell-data";

/* ==========================================================================
   Recents
========================================================================== */

const RECENTS_KEY = "constructos:palette-recents";
const RECENTS_MAX = 6;

interface RecentEntry {
  /** "nav:/projects" or "project:prj_123" */
  id: string;
  kind: "nav" | "project";
  label: string;
  sublabel?: string;
  to: string;
}

function readRecents(): RecentEntry[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecentEntry).id === "string" &&
        typeof (entry as RecentEntry).to === "string" &&
        typeof (entry as RecentEntry).label === "string",
    );
  } catch {
    return [];
  }
}

function writeRecents(entries: readonly RecentEntry[]): void {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(entries.slice(0, RECENTS_MAX)));
  } catch {
    /* storage blocked — recents are a convenience, not a requirement */
  }
}

/* ==========================================================================
   Context
========================================================================== */

interface CommandPaletteValue {
  open: boolean;
  openPalette: (initialQuery?: string) => void;
  closePalette: () => void;
  togglePalette: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteValue | null>(null);

const NOOP: CommandPaletteValue = {
  open: false,
  openPalette: () => undefined,
  closePalette: () => undefined,
  togglePalette: () => undefined,
};

export function useCommandPalette(): CommandPaletteValue {
  return useContext(CommandPaletteContext) ?? NOOP;
}

/* ==========================================================================
   Provider
========================================================================== */

interface ListResponse<T> {
  items: T[];
  total: number;
}

export function SearchProvider({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { theme, resolvedTheme, setTheme, density, toggleDensity } = useTheme();
  const { openHelp } = useShortcuts();
  const { projects: cachedProjects, projectsReady, projectsTotal } = useShellData();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [remote, setRemote] = useState<readonly ShellProject[]>([]);
  const [searching, setSearching] = useState(false);

  const openPalette = useCallback((initialQuery?: string) => {
    setSearch(initialQuery ?? "");
    setOpen(true);
  }, []);
  const closePalette = useCallback(() => setOpen(false), []);
  const togglePalette = useCallback(() => setOpen((value) => !value), []);

  useShortcut({
    id: "palette.open",
    label: "Open the command palette",
    group: "Search",
    keys: [MOD_LABEL, "K"],
    combo: { key: "k", mod: true },
    run: () => setOpen((value) => !value),
  });

  /* Load recents when the palette opens, so another tab's picks show up. */
  useEffect(() => {
    if (open) setRecents(readRecents());
  }, [open]);

  /* Live project search — the one free-text endpoint the API offers. */
  useEffect(() => {
    const term = search.trim();
    if (!open || term.length < 2) {
      setRemote([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .get<ListResponse<ShellProject>>(
          `/api/v1/projects?page=1&pageSize=20&search=${encodeURIComponent(term)}`,
        )
        .then((res) => {
          if (cancelled) return;
          setRemote(Array.isArray(res.items) ? res.items : []);
        })
        .catch(() => {
          if (!cancelled) setRemote([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      setSearching(false);
      window.clearTimeout(timer);
    };
  }, [open, search]);

  const remember = useCallback((entry: RecentEntry) => {
    setRecents((current) => {
      const next = [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, RECENTS_MAX);
      writeRecents(next);
      return next;
    });
  }, []);

  const go = useCallback(
    (to: string, entry?: RecentEntry) => {
      if (entry) remember(entry);
      setOpen(false);
      navigate(to);
    },
    [navigate, remember],
  );

  /* Cached page + live results, de-duplicated, cached first. */
  const projects = useMemo<readonly ShellProject[]>(() => {
    const seen = new Set<string>();
    const merged: ShellProject[] = [];
    for (const project of [...(cachedProjects ?? []), ...remote]) {
      if (seen.has(project.id)) continue;
      seen.add(project.id);
      merged.push(project);
    }
    return merged;
  }, [cachedProjects, remote]);

  const value = useMemo<CommandPaletteValue>(
    () => ({ open, openPalette, closePalette, togglePalette }),
    [open, openPalette, closePalette, togglePalette],
  );

  const truncated =
    projectsTotal !== null && cachedProjects !== null && projectsTotal > cachedProjects.length;

  /* The project the user is standing in, if any — its workspaces get their own
     group so the deep routes (budget, commitments, invoicing…) are reachable
     without walking the project tab bar. */
  const currentProjectId = useMemo(() => {
    const segments = pathname.split("/").filter(Boolean);
    return segments[0] === "projects" && segments[1] ? segments[1] : null;
  }, [pathname]);

  const currentProject = useMemo(
    () => (currentProjectId ? (projects.find((p) => p.id === currentProjectId) ?? null) : null),
    [currentProjectId, projects],
  );

  /* With no query, show the newest handful rather than every project the shell
     has cached — the palette must open instantly. Typing renders the full pool
     and cmdk scores it. */
  const browsing = search.trim().length === 0;
  const visibleProjects = useMemo(
    () => (browsing ? projects.slice(0, 8) : projects),
    [browsing, projects],
  );
  const projectsHeading = !projectsReady
    ? "Projects (loading…)"
    : browsing && projects.length > visibleProjects.length
      ? `Projects · newest ${visibleProjects.length}`
      : "Projects";

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {user ? (
        <CommandMenu
          open={open}
          onOpenChange={setOpen}
          search={search}
          onSearchChange={setSearch}
          label="Command palette"
          placeholder="Jump to a page or a project…"
          loading={searching}
          emptyMessage={<PaletteEmpty query={search} truncated={truncated} />}
          footer={<PaletteFooter />}
        >
          {search.trim().length === 0 && recents.length > 0 ? (
            <CommandGroup heading="Recent">
              {recents.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`recent ${entry.label} ${entry.sublabel ?? ""}`}
                  icon={entry.kind === "project" ? IconProject : iconForNav(entry.to)}
                  description={entry.sublabel}
                  trailing={<IconClock size={13} />}
                  onSelect={() => go(entry.to, entry)}
                >
                  {entry.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {currentProjectId ? (
            <CommandGroup heading={currentProject ? currentProject.name : "This project"}>
              {PROJECT_DESTINATIONS.map((destination) => {
                const to = destination.segment
                  ? `/projects/${currentProjectId}/${destination.segment}`
                  : `/projects/${currentProjectId}`;
                return (
                  <CommandItem
                    key={to}
                    value={`${destination.label} ${currentProject?.name ?? ""} project workspace`}
                    icon={IconArrowUpRight}
                    description={currentProject?.name ?? undefined}
                    onSelect={() =>
                      go(to, {
                        id: `nav:${to}`,
                        kind: "nav",
                        label: `${currentProject?.name ?? "Project"} · ${destination.label}`,
                        to,
                      })
                    }
                  >
                    {destination.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}

          <CommandGroup heading="Navigation">
            {NAV_ITEMS.map((item) => (
              <CommandItem
                key={item.to}
                value={`${item.label} ${item.description ?? ""} ${(item.keywords ?? []).join(" ")}`}
                keywords={item.keywords ? [...item.keywords] : undefined}
                icon={item.icon}
                description={item.description}
                onSelect={() =>
                  go(item.to, {
                    id: `nav:${item.to}`,
                    kind: "nav",
                    label: item.label,
                    ...(item.description ? { sublabel: item.description } : {}),
                    to: item.to,
                  })
                }
              >
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading={projectsHeading}>
            {visibleProjects.map((project) => (
              <CommandItem
                key={project.id}
                value={`${project.name} ${project.number ?? ""} ${project.id}`}
                keywords={project.number ? [project.number] : undefined}
                icon={IconProject}
                description={projectSubtitle(project)}
                onSelect={() =>
                  go(`/projects/${project.id}`, {
                    id: `project:${project.id}`,
                    kind: "project",
                    label: project.name,
                    ...(project.number ? { sublabel: `#${project.number}` } : {}),
                    to: `/projects/${project.id}`,
                  })
                }
              >
                {project.name}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading="Actions">
            <CommandItem
              value="toggle theme dark light appearance"
              icon={resolvedTheme === "dark" ? IconSun : IconMoon}
              description={`Currently ${theme === "system" ? `system (${resolvedTheme})` : resolvedTheme}`}
              onSelect={() => {
                setTheme(resolvedTheme === "dark" ? "light" : "dark");
                setOpen(false);
              }}
            >
              Switch to {resolvedTheme === "dark" ? "light" : "dark"} theme
            </CommandItem>
            <CommandItem
              value="use system theme appearance auto"
              icon={IconSystem}
              description="Follow the operating system"
              onSelect={() => {
                setTheme("system");
                setOpen(false);
              }}
            >
              Use the system theme
            </CommandItem>
            <CommandItem
              value="toggle density compact comfortable spacing"
              icon={IconDensity}
              description={`Currently ${density}`}
              onSelect={() => {
                toggleDensity();
                setOpen(false);
              }}
            >
              Switch to {density === "compact" ? "comfortable" : "compact"} density
            </CommandItem>
            <CommandItem
              value="keyboard shortcuts help cheatsheet"
              icon={IconKeyboard}
              shortcut="?"
              onSelect={() => {
                setOpen(false);
                openHelp();
              }}
            >
              Keyboard shortcuts
            </CommandItem>
            <CommandItem
              value="sign out log out logout"
              icon={IconLogout}
              destructive
              onSelect={() => {
                setOpen(false);
                logout();
                navigate("/login");
              }}
            >
              Sign out
            </CommandItem>
          </CommandGroup>
        </CommandMenu>
      ) : null}
    </CommandPaletteContext.Provider>
  );
}

/* ==========================================================================
   Pieces
========================================================================== */

function iconForNav(to: string): IconComponent {
  const match = NAV_ITEMS.find((item) => item.to === to);
  if (match) return match.icon;
  return to.startsWith("/projects/") ? IconArrowUpRight : IconSearch;
}

function projectSubtitle(project: ShellProject): string | undefined {
  const place = [project.city, project.country].filter(Boolean).join(", ");
  const number = project.number ? `#${project.number}` : "";
  const parts = [number, place].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function PaletteEmpty({ query, truncated }: { query: string; truncated: boolean }) {
  const term = query.trim();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-xl border border-border bg-surface-sunken text-content-subtle">
        <IconSearch size={18} />
      </span>
      <p className="text-body font-medium text-content">
        {term ? `Nothing matches “${term}”` : "Nothing to show"}
      </p>
      <p className="max-w-sm text-balance text-meta text-content-subtle">
        This palette searches <strong className="font-medium text-content-muted">pages</strong> and{" "}
        <strong className="font-medium text-content-muted">projects</strong> only — ConstructOS has
        no cross-record search API, so RFIs, submittals, drawings and documents are not indexed
        here. Open a project and search within its workspace instead.
      </p>
      {truncated ? (
        <p className="max-w-sm text-balance text-meta text-content-subtle">
          Project matches come from a live query, so projects beyond the first page are searchable.
        </p>
      ) : null}
    </div>
  );
}

function PaletteFooter() {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <Kbd keys={["↑", "↓"]} size="xs" />
          navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd size="xs">↵</Kbd>
          open
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd size="xs">Esc</Kbd>
          close
        </span>
      </span>
      <span className="hidden items-center gap-1.5 sm:flex">
        pages &amp; projects
        <CommandShortcut keys={`${MOD_LABEL}+K`} />
      </span>
    </div>
  );
}
