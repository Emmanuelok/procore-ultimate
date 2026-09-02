/**
 * shell/TopBar.tsx — breadcrumbs, search, notifications, appearance, account.
 *
 * The breadcrumb trail is derived from the route rather than declared by each
 * page, so it can never fall out of step with where the user actually is.
 * Project ids are resolved to project names through the shell's cache.
 */
import {
  forwardRef,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import { Link, useLocation } from "react-router-dom";
import { Breadcrumbs, DropdownMenu, Kbd, Tooltip, type BreadcrumbItem } from "../../ui";
import { cx } from "../../ui/cx";
import {
  IconDensity,
  IconMenu,
  IconMoon,
  IconSearch,
  IconSun,
  IconSystem,
} from "../../ui/icons";
import { useTheme, type ThemePreference } from "../../lib/theme";
import { MOD_LABEL } from "../../lib/shortcuts";
import { NotificationsMenu } from "./NotificationsMenu";
import { UserMenu } from "./UserMenu";
import { segmentLabel } from "./nav";
import { useProjectName } from "./shell-data";

/* ==========================================================================
   Breadcrumbs
========================================================================== */

/** Ids look like `prj_a1b2`, `rfi_9f…` — a record id, not a page name. */
function looksLikeId(segment: string): boolean {
  return /^[a-z]{2,5}_[A-Za-z0-9]{4,}$/.test(segment);
}

function shortenId(segment: string): string {
  const tail = segment.split("_").slice(1).join("_");
  return tail.length > 8 ? `${tail.slice(0, 8)}…` : tail || segment;
}

function useCrumbs(): BreadcrumbItem[] {
  const { pathname } = useLocation();
  const segments = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);
  const projectId = segments[0] === "projects" && segments[1] ? segments[1] : undefined;
  const projectName = useProjectName(projectId);

  return useMemo(() => {
    if (segments.length === 0) return [{ label: "Dashboard" }];

    const items: BreadcrumbItem[] = [];
    let href = "";

    segments.forEach((segment, index) => {
      href += `/${segment}`;
      const isLast = index === segments.length - 1;
      const isProjectId = index === 1 && segments[0] === "projects";

      const text = isProjectId
        ? (projectName ?? shortenId(segment))
        : looksLikeId(segment)
          ? shortenId(segment)
          : segmentLabel(segment);

      items.push({
        label: isLast ? (
          text
        ) : (
          <Link
            to={href}
            className="rounded-xs transition-colors hover:text-content hover:underline underline-offset-2"
          >
            {text}
          </Link>
        ),
      });
    });

    return items;
  }, [segments, projectName]);
}

/* ==========================================================================
   Global search
========================================================================== */

export interface GlobalSearchProps {
  /** Opens the palette, optionally seeded with the first keystroke. */
  onOpen: (query?: string) => void;
}

export const GlobalSearch = forwardRef<HTMLInputElement, GlobalSearchProps>(
  function GlobalSearch({ onOpen }, ref) {
    const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen();
        return;
      }
      if (event.key.length === 1) {
        event.preventDefault();
        onOpen(event.key);
      }
    };

    return (
      <>
        <div className="relative hidden w-56 shrink-0 md:block lg:w-72">
          <IconSearch
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle"
          />
          <input
            ref={ref}
            type="text"
            readOnly
            value=""
            aria-label="Search pages and projects"
            placeholder="Search…"
            onMouseDown={(event) => {
              event.preventDefault();
              onOpen();
            }}
            onKeyDown={handleKeyDown}
            className={cx(
              "h-8 w-full cursor-pointer rounded-md border border-border bg-surface-sunken",
              "pl-8 pr-16 text-meta text-content placeholder:text-content-subtle",
              "transition-colors duration-fast hover:border-border-strong hover:bg-surface-hover",
              "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
          <Kbd
            keys={[MOD_LABEL, "K"]}
            size="xs"
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
          />
        </div>

        <button
          type="button"
          aria-label="Search pages and projects"
          onClick={() => onOpen()}
          className={cx(
            "grid size-8 shrink-0 place-items-center rounded-md text-content-muted md:hidden",
            "transition-colors duration-fast hover:bg-surface-hover hover:text-content",
            "focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <IconSearch size={17} />
        </button>
      </>
    );
  },
);

/* ==========================================================================
   Appearance
========================================================================== */

const THEME_LABEL: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const Glyph = resolvedTheme === "dark" ? IconMoon : IconSun;

  return (
    <DropdownMenu
      placement="bottom-end"
      width={184}
      trigger={
        <button
          type="button"
          aria-label={`Theme: ${THEME_LABEL[theme]}`}
          className={cx(
            "grid size-8 shrink-0 place-items-center rounded-md text-content-muted",
            "transition-colors duration-fast hover:bg-surface-hover hover:text-content",
            "focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <Glyph size={17} />
        </button>
      }
      items={[
        {
          type: "radio-group",
          label: "Appearance",
          value: theme,
          onValueChange: (next) => setTheme(next as ThemePreference),
          options: [
            { value: "light", label: "Light", icon: IconSun },
            { value: "dark", label: "Dark", icon: IconMoon },
            { value: "system", label: "System", icon: IconSystem },
          ],
        },
      ]}
    />
  );
}

function DensityToggle() {
  const { density, toggleDensity } = useTheme();
  const next = density === "compact" ? "comfortable" : "compact";

  return (
    <Tooltip content={`Density: ${density}`}>
      <button
        type="button"
        onClick={toggleDensity}
        aria-label={`Switch to ${next} density`}
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-md text-content-muted",
          "transition-colors duration-fast hover:bg-surface-hover hover:text-content",
          "focus-visible:ring-2 focus-visible:ring-ring",
          density === "compact" && "text-accent-text",
        )}
      >
        <IconDensity size={17} />
      </button>
    </Tooltip>
  );
}

/* ==========================================================================
   Bar
========================================================================== */

export interface TopBarProps {
  onOpenMobileNav: () => void;
  onOpenPalette: (query?: string) => void;
  searchRef: Ref<HTMLInputElement>;
}

export function TopBar({ onOpenMobileNav, onOpenPalette, searchRef }: TopBarProps) {
  const crumbs = useCrumbs();

  return (
    <header
      className={cx(
        "sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-2 border-b border-border px-3",
        "bg-surface-raised/85 supports-[backdrop-filter]:backdrop-blur-md",
      )}
    >
      <button
        type="button"
        aria-label="Open navigation"
        onClick={onOpenMobileNav}
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-md text-content-muted lg:hidden",
          "transition-colors duration-fast hover:bg-surface-hover hover:text-content",
          "focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <IconMenu size={17} />
      </button>

      <Breadcrumbs items={crumbs} maxItems={4} className="min-w-0 flex-1" />

      <GlobalSearch ref={searchRef} onOpen={onOpenPalette} />

      <div className="flex shrink-0 items-center gap-0.5">
        <NotificationsMenu />
        <ThemeToggle />
        <DensityToggle />
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <UserMenu />
      </div>
    </header>
  );
}
