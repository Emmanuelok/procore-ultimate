/**
 * PROJECT WORKSPACE SHELL — everything under /projects/:projectId.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED
 *
 * A single wrapping row of 27 tabs, three lines deep on a laptop, with no
 * grouping and no way to grow. In its place:
 *
 *   ProjectHeader   sticky identity bar that CONDENSES on scroll — name,
 *                   number, stage, dates, contract value, percent complete,
 *                   a derived health verdict and the action menu.
 *   ProjectNav      a two-level collapsible sidebar of 30 destinations in the
 *                   seven groups a construction professional already uses,
 *                   with a filter box and an icons-only rail. Below `lg` it
 *                   moves into a drawer, so a phone gets the whole screen.
 *
 * The shell also owns the data every screen underneath needs — the project
 * record, the cross-tool counters, the open assurance signals and the
 * prime-contract position — and publishes them through
 * `useProjectWorkspace()` so a page never refetches what the header already
 * has.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Outlet, useLocation, useParams } from "react-router-dom";
import { Drawer, EmptyState, ErrorAlert } from "../ui";
import { useShortcut } from "../lib/shortcuts";
import { IconProject } from "../ui/icons";
import { ProjectWorkspaceProvider, useProjectWorkspace } from "./project/context";
import ProjectEditDrawer from "./project/ProjectEditDrawer";
import ProjectHeader from "./project/ProjectHeader";
import ProjectNav, { useProjectNavRail } from "./project/ProjectNav";

/** The nearest ancestor that actually scrolls, or the window. */
function scrollParentOf(node: HTMLElement | null): HTMLElement | Window {
  let current = node?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return window;
}

/**
 * True once the workspace has been scrolled. Hysteresis (condense at 24px,
 * release at 8px) stops the header flickering when a scroll lands on the
 * boundary. Finding the real scroll container means this works whether the app
 * shell scrolls the window or a `<main overflow-y-auto>`.
 */
function useCondensedOnScroll(anchor: RefObject<HTMLElement | null>): boolean {
  const [condensed, setCondensed] = useState(false);

  useEffect(() => {
    const scroller = scrollParentOf(anchor.current);
    let frame = 0;

    const read = () => {
      frame = 0;
      const top = scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop;
      setCondensed((current) => (current ? top > 8 : top > 24));
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(read);
    };

    read();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [anchor]);

  return condensed;
}

export default function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const { pathname } = useLocation();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const condensed = useCondensedOnScroll(anchorRef);

  const [rail, setRail] = useProjectNavRail();
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const base = `/projects/${projectId ?? ""}`;
  const trail = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\/+/, "") : "";
  const activeSegment = trail.split("/")[0] ?? "";

  // A route change closes the mobile section drawer; leaving it open over the
  // page you just navigated to is the classic mobile-nav bug.
  useEffect(() => {
    setSectionsOpen(false);
  }, [pathname]);

  const closeSections = useCallback(() => setSectionsOpen(false), []);

  // Mirrors the app shell's "[" for its own sidebar, so the two rails behave
  // the same way. `useShortcut` no-ops when no provider is mounted.
  useShortcut({
    id: "project.nav.rail",
    label: "Collapse or expand the project sections",
    group: "View",
    keys: ["]"],
    combo: { key: "]" },
    run: () => setRail(!rail),
  });

  if (!projectId) {
    return (
      <EmptyState
        icon={IconProject}
        title="No project selected"
        hint="This URL does not name a project. Pick one from the projects list."
      />
    );
  }

  return (
    <ProjectWorkspaceProvider projectId={projectId}>
      <div ref={anchorRef} className="min-w-0">
        <ProjectHeader
          condensed={condensed}
          activeSegment={activeSegment}
          onOpenSections={() => setSectionsOpen(true)}
          onEdit={() => setEditOpen(true)}
        />

        <ProjectLoadNotice />

        <div className="flex items-start gap-5 pt-4 xl:gap-6">
          <aside className="sticky top-16 hidden shrink-0 self-start lg:block">
            <ProjectNav
              activeSegment={activeSegment}
              rail={rail}
              onRailChange={setRail}
            />
          </aside>

          <div className="min-w-0 flex-1 pb-12">
            <Outlet />
          </div>
        </div>
      </div>

      <Drawer
        open={sectionsOpen}
        onClose={closeSections}
        side="left"
        size="sm"
        title="Project sections"
        description="Every tool on this project, grouped."
      >
        <ProjectNav
          activeSegment={activeSegment}
          variant="drawer"
          onNavigate={closeSections}
        />
      </Drawer>

      <ProjectEditDrawer open={editOpen} onClose={() => setEditOpen(false)} />
    </ProjectWorkspaceProvider>
  );
}

/**
 * The project record failing is a shell-level fact, not a page-level one: the
 * header can only show a name it does not have, so the reason belongs here,
 * once, above whatever page is mounted.
 */
function ProjectLoadNotice() {
  const { project, reloadProject } = useProjectWorkspace();
  if (!project.error) return null;
  return (
    <div className="pt-3">
      <ErrorAlert
        className="mb-0"
        title="This project could not be read"
        message={project.error}
        onRetry={reloadProject}
      />
    </div>
  );
}
