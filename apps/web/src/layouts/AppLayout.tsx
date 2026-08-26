/**
 * AppLayout — the application shell.
 *
 *   ┌───────────┬──────────────────────────────────────────┐
 *   │  Sidebar  │  TopBar: breadcrumbs · search · account   │
 *   │  (rail /  ├──────────────────────────────────────────┤
 *   │  expanded)│  <Outlet/> inside a page-level boundary   │
 *   └───────────┴──────────────────────────────────────────┘
 *
 * The shell owns: the collapsible grouped sidebar, the top bar, the mobile
 * navigation drawer, and the "/" binding that focuses the global search field.
 * The command palette itself lives in lib/search.tsx and the keyboard layer in
 * lib/shortcuts.tsx, both mounted at the app root.
 */
import { useCallback, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AppErrorBoundary } from "../ui";
import { useCommandPalette } from "../lib/search";
import { useShortcut } from "../lib/shortcuts";
import { MobileNav, Sidebar, useSidebarState } from "./shell/Sidebar";
import { TopBar } from "./shell/TopBar";

export default function AppLayout() {
  const { collapsed, toggle } = useSidebarState();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { openPalette } = useCommandPalette();
  const { pathname } = useLocation();

  useShortcut({
    id: "search.focus",
    label: "Focus the search field",
    group: "Search",
    keys: ["/"],
    combo: { key: "/" },
    run: () => searchRef.current?.focus(),
  });

  useShortcut({
    id: "view.sidebar",
    label: "Collapse or expand the sidebar",
    group: "View",
    keys: ["["],
    combo: { key: "[" },
    run: () => toggle(),
  });

  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-surface text-content">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <MobileNav open={mobileNavOpen} onOpenChange={setMobileNavOpen} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onOpenMobileNav={openMobileNav}
          onOpenPalette={openPalette}
          searchRef={searchRef}
        />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-content-max px-page-x py-page-y">
            <AppErrorBoundary
              resetKeys={[pathname]}
              variant="page"
              title="This page could not be rendered"
              description="The rest of the app is still running — use the navigation to move on, or reload to try again."
            >
              <Outlet />
            </AppErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
