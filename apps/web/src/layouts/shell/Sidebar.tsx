/**
 * shell/Sidebar.tsx — the primary navigation rail.
 *
 * Two shapes of the same list:
 *   expanded   15rem, section headers, labels, counters
 *   collapsed  3.5rem icon rail, tooltips, a dot instead of a number
 *
 * The collapsed flag is persisted (see useSidebarState) so the choice survives
 * a reload. Active state is painted by NavLink and reinforced with an accent
 * rail on the left edge so the current page reads instantly at either width.
 *
 * Badge counts come from real endpoints via <ShellDataProvider>. A `null`
 * count renders NOTHING — never a zero, which would be a claim we cannot make.
 */
import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Drawer, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import {
  IconSidebarCollapse,
  IconSidebarExpand,
  type IconComponent,
} from "../../ui/icons";
import { NAV_GROUPS, type NavBadgeKey, type NavItem } from "./nav";
import { useShellData } from "./shell-data";

const SIDEBAR_STORAGE_KEY = "constructos:sidebar-collapsed";

/* ==========================================================================
   Persisted collapse state
========================================================================== */

export function useSidebarState(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage blocked — the layout still works, it just will not persist */
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  return { collapsed, toggle };
}

/* ==========================================================================
   Brand
========================================================================== */

function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid size-7 shrink-0 place-items-center rounded-md",
        "bg-gradient-to-br from-accent to-accent-active text-accent-fg",
        "text-[0.8125rem] font-bold shadow-e1",
        className,
      )}
    >
      C
    </span>
  );
}

/* ==========================================================================
   Badge
========================================================================== */

function NavCount({ count, collapsed }: { count: number; collapsed: boolean }) {
  if (collapsed) {
    return (
      <span
        aria-hidden="true"
        className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent ring-2 ring-surface-raised"
      />
    );
  }
  return (
    <span
      className={cx(
        "ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1",
        "bg-accent-subtle text-2xs font-semibold tabular-nums text-accent-subtle-fg",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/* ==========================================================================
   Item
========================================================================== */

interface SidebarItemProps {
  item: NavItem;
  collapsed: boolean;
  count: number | null;
  onNavigate?: () => void;
}

function SidebarItem({ item, collapsed, count, onNavigate }: SidebarItemProps) {
  const Icon: IconComponent = item.icon;

  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          "group relative flex h-8 items-center rounded-md text-body outline-none transition-colors duration-fast",
          "focus-visible:ring-2 focus-visible:ring-ring",
          collapsed ? "w-8 justify-center" : "gap-2.5 px-2",
          isActive
            ? "bg-surface-selected font-medium text-accent-text"
            : "text-content-muted hover:bg-surface-hover hover:text-content",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={cx(
              "absolute -left-2 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-opacity duration-fast",
              isActive ? "opacity-100" : "opacity-0",
            )}
          />
          <Icon size={16} className="shrink-0" />
          {collapsed ? null : <span className="truncate">{item.label}</span>}
          {count !== null && count > 0 ? (
            <NavCount count={count} collapsed={collapsed} />
          ) : null}
        </>
      )}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip
      content={
        <span className="flex items-center gap-2">
          {item.label}
          {count !== null && count > 0 ? (
            <span className="tabular-nums text-content-subtle">{count}</span>
          ) : null}
        </span>
      }
      placement="right"
      sideOffset={10}
    >
      {link}
    </Tooltip>
  );
}

/* ==========================================================================
   Nav
========================================================================== */

export interface SidebarNavProps {
  collapsed: boolean;
  /** Called after any link is followed — closes the mobile drawer. */
  onNavigate?: () => void;
}

export function SidebarNav({ collapsed, onNavigate }: SidebarNavProps) {
  const { unreadNotifications, openSignals } = useShellData();

  const countFor = (key: NavBadgeKey | undefined): number | null => {
    if (key === "notifications") return unreadNotifications;
    if (key === "signals") return openSignals;
    return null;
  };

  return (
    <nav
      aria-label="Primary"
      className={cx(
        "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain py-2",
        collapsed ? "items-center px-3" : "px-3",
      )}
    >
      {NAV_GROUPS.map((group, index) => (
        <div key={group.id} className={cx("flex flex-col", collapsed ? "w-full items-center" : "")}>
          {collapsed ? (
            index === 0 ? null : (
              <span aria-hidden="true" className="my-1.5 h-px w-6 bg-border-subtle" />
            )
          ) : (
            <span
              className={cx(
                "px-2 pb-1 text-label uppercase text-content-subtle",
                index === 0 ? "pt-1" : "pt-4",
              )}
            >
              {group.label}
            </span>
          )}
          <ul className={cx("flex flex-col gap-0.5", collapsed ? "items-center" : "")}>
            {group.items.map((item) => (
              <li key={item.to} className={collapsed ? "" : "w-full"}>
                <SidebarItem
                  item={item}
                  collapsed={collapsed}
                  count={countFor(item.badge)}
                  {...(onNavigate ? { onNavigate } : {})}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/* ==========================================================================
   Desktop sidebar
========================================================================== */

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      data-collapsed={collapsed ? "" : undefined}
      className={cx(
        "hidden shrink-0 flex-col border-r border-border bg-surface-raised lg:flex",
        "transition-[width] duration-base ease-standard",
        collapsed ? "w-sidebar-collapsed" : "w-sidebar",
      )}
    >
      <div
        className={cx(
          "flex h-topbar shrink-0 items-center border-b border-border",
          collapsed ? "justify-center px-2" : "gap-2.5 px-3",
        )}
      >
        <BrandMark />
        {collapsed ? null : (
          <span className="flex min-w-0 flex-col leading-none">
            <span className="truncate text-body font-semibold text-content">ConstructOS</span>
            <span className="mt-1 truncate text-2xs uppercase tracking-[0.14em] text-content-subtle">
              Delivery · Assurance
            </span>
          </span>
        )}
      </div>

      <SidebarNav collapsed={collapsed} />

      <div className={cx("shrink-0 border-t border-border p-2", collapsed && "flex justify-center")}>
        <Tooltip
          content={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          placement={collapsed ? "right" : "top"}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            className={cx(
              "flex h-8 items-center rounded-md text-content-subtle transition-colors duration-fast",
              "hover:bg-surface-hover hover:text-content focus-visible:ring-2 focus-visible:ring-ring",
              collapsed ? "w-8 justify-center" : "w-full gap-2.5 px-2",
            )}
          >
            {collapsed ? <IconSidebarExpand size={16} /> : <IconSidebarCollapse size={16} />}
            {collapsed ? null : <span className="text-meta">Collapse</span>}
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

/* ==========================================================================
   Mobile drawer
========================================================================== */

export function MobileNav({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side="left"
      size="sm"
      unpaddedBody
      header={
        <div className="flex items-center gap-2.5 px-4 py-3">
          <BrandMark />
          <span className="text-body font-semibold text-content">ConstructOS</span>
        </div>
      }
      aria-label="Primary navigation"
    >
      <SidebarNav collapsed={false} onNavigate={() => onOpenChange(false)} />
    </Drawer>
  );
}
