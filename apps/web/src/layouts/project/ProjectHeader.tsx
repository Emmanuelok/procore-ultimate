/**
 * ProjectHeader — the identity bar of the project workspace.
 *
 * It carries the eight things a delivery lead checks before doing anything
 * else: name, number, stage, key dates, contract value, percent complete,
 * health, and the actions. It is sticky, and it CONDENSES rather than eating
 * the viewport — past the first scroll it collapses to a 3.5rem identity strip
 * and the meta rail folds away, so a drawing or a 5,000-row grid gets the
 * screen back.
 *
 * Every figure here is sourced or absent. Contract value and percent complete
 * come from the prime-contract position and are reported PER CURRENCY; a
 * project holding a USD and a EUR prime gets "2 currencies" and a link, never
 * a total nobody can spend. Health is derived from the open assurance signals
 * and says so in its tooltip.
 */
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Breadcrumbs,
  Button,
  DropdownMenu,
  IconButton,
  Progress,
  Skeleton,
  Tooltip,
  toast,
  type MenuItemSpec,
} from "../../ui";
import {
  IconAlert,
  IconBudget,
  IconCalendar,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconEdit,
  IconGantt,
  IconLink,
  IconLocation,
  IconMenu,
  IconMore,
  IconProject,
  IconRefresh,
  IconRfi,
  IconTarget,
  type IconComponent,
} from "../../ui/icons";
import { cx } from "../../ui/cx";
import { toneClass } from "../../ui/tokens";
import { useProjectWorkspace } from "./context";
import { navItemForPath } from "./nav";
import {
  DASH,
  Figure,
  daysBetween,
  isoDate,
  money,
  pct,
  stageLabel,
  stageTone,
  todayIso,
  type PrimeContractCurrencyGroup,
} from "./lib";

export interface ProjectHeaderProps {
  condensed: boolean;
  /** Path segment under /projects/:projectId — "" on the overview. */
  activeSegment: string;
  /** Opens the section drawer (small screens only). */
  onOpenSections: () => void;
  onEdit: () => void;
}

export default function ProjectHeader({
  condensed,
  activeSegment,
  onOpenSections,
  onEdit,
}: ProjectHeaderProps) {
  const navigate = useNavigate();
  const { projectId, project, contracts, health, reloadProject } = useProjectWorkspace();

  const record = project.data;
  const groups = contracts.data?.groups ?? [];
  const single: PrimeContractCurrencyGroup | null = groups.length === 1 ? groups[0]! : null;
  const section = navItemForPath(activeSegment);

  const remaining = daysBetween(todayIso(), record?.finishDate ?? null);

  const menuItems: MenuItemSpec[] = [
    {
      id: "edit",
      label: "Edit project details",
      icon: IconEdit,
      onSelect: onEdit,
    },
    {
      id: "copy-link",
      label: "Copy link to this project",
      icon: IconLink,
      onSelect: () => {
        void navigator.clipboard
          ?.writeText(window.location.href)
          .then(() => toast.success("Link copied"))
          .catch(() => toast.error("The browser refused clipboard access"));
      },
    },
    {
      id: "copy-id",
      label: "Copy project ID",
      icon: IconCopy,
      description: projectId,
      onSelect: () => {
        void navigator.clipboard
          ?.writeText(projectId)
          .then(() => toast.success("Project ID copied"))
          .catch(() => toast.error("The browser refused clipboard access"));
      },
    },
    { id: "sep-1", type: "separator" },
    { id: "go-budget", label: "Open Budget", icon: IconBudget, onSelect: () => navigate("budget") },
    {
      id: "go-schedule",
      label: "Open Schedule",
      icon: IconGantt,
      onSelect: () => navigate("schedule"),
    },
    { id: "go-rfis", label: "Open RFIs", icon: IconRfi, onSelect: () => navigate("rfis") },
    { id: "sep-2", type: "separator" },
    {
      id: "refresh",
      label: "Refresh project data",
      icon: IconRefresh,
      shortcut: "R",
      onSelect: reloadProject,
    },
    {
      id: "all-projects",
      label: "All projects",
      icon: IconProject,
      onSelect: () => navigate("/projects"),
    },
  ];

  return (
    <header
      className={cx(
        // Bleeds to the page gutters with the shell's own padding token — the
        // same trick PageHeader uses — so content scrolls UNDER the bar rather
        // than through the gutters either side of it.
        "sticky top-0 z-30 -mx-page-x bg-surface/90 px-page-x backdrop-blur",
        "transition-shadow duration-base",
        condensed && "border-b border-border shadow-e1",
      )}
    >
      {/* -------------------------------------------------------- breadcrumb */}
      <div
        className={cx(
          "overflow-hidden transition-all duration-base ease-standard",
          condensed ? "max-h-0 opacity-0" : "max-h-8 pt-3 opacity-100",
        )}
      >
        <Breadcrumbs
          items={[
            { label: "Projects", icon: IconProject, onClick: () => navigate("/projects") },
            {
              label: record?.name ?? "Project",
              onClick: () => navigate(`/projects/${projectId}`),
            },
            ...(section && section.to !== "" ? [{ label: section.label }] : []),
          ]}
        />
      </div>

      {/* ---------------------------------------------------------- identity */}
      <div
        className={cx(
          "flex items-center justify-between gap-3 transition-[height] duration-base ease-standard",
          condensed ? "h-14" : "h-16",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            leadingIcon={IconMenu}
            aria-label="Open project sections"
            className="lg:hidden"
            onClick={onOpenSections}
          />

          {project.loading && !record ? (
            <div className="flex items-center gap-2">
              <Skeleton width={200} height={22} radius="md" />
              <Skeleton width={92} height={18} radius="full" />
            </div>
          ) : (
            <>
              <h1
                className={cx(
                  "min-w-0 truncate font-semibold tracking-[-0.015em] text-content",
                  "transition-[font-size] duration-base ease-standard",
                  condensed ? "text-base" : "text-xl",
                )}
                title={record?.name ?? undefined}
              >
                {record?.name ?? (project.error ? "Project unavailable" : "Untitled project")}
              </h1>

              {record?.number ? (
                <span className="shrink-0 rounded border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-content-muted">
                  {record.number}
                </span>
              ) : null}

              {record ? (
                <Badge tone={stageTone(record.stage)} size="xs" dot className="shrink-0">
                  {stageLabel(record.stage)}
                </Badge>
              ) : null}

              <Tooltip content={health.basis} maxWidth={360} placement="bottom">
                <span
                  tabIndex={0}
                  className={cx(
                    "focus-ring inline-flex shrink-0 cursor-help items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium outline-none",
                    toneClass(health.tone, "subtle"),
                    toneClass(health.tone, "border"),
                  )}
                >
                  {health.level === "on_track" ? (
                    <IconCheckCircle size={11} aria-hidden="true" />
                  ) : health.level === "unrated" ? (
                    <IconClock size={11} aria-hidden="true" />
                  ) : (
                    <IconAlert size={11} aria-hidden="true" />
                  )}
                  {health.label}
                </span>
              </Tooltip>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {condensed && single ? (
            <div className="mr-1 hidden items-center gap-2 md:flex">
              <span className="text-meta tabular-nums text-content-muted">
                {money(single.revisedContractSum, single.currency, { compact: true })}
              </span>
              {/* Only when it is known. The reasons for an unknown percentage
                  belong on the overview, not squeezed into a 56px strip. */}
              {single.percentComplete.value !== null ? (
                <span className="text-meta font-medium tabular-nums text-content">
                  {pct(single.percentComplete.value, 1)} billed
                </span>
              ) : null}
            </div>
          ) : null}
          <Button variant="secondary" size="sm" leadingIcon={IconEdit} onClick={onEdit}>
            Edit
          </Button>
          <DropdownMenu
            items={menuItems}
            placement="bottom-end"
            trigger={<IconButton icon={IconMore} label="Project actions" size="sm" />}
          />
        </div>
      </div>

      {/* --------------------------------------------------------- meta rail */}
      <div
        className={cx(
          "overflow-hidden transition-all duration-base ease-standard",
          condensed ? "max-h-0 opacity-0" : "max-h-24 pb-3 opacity-100",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border-subtle pt-2.5">
          <MetaItem
            icon={IconLocation}
            label="Location"
            value={
              record
                ? [record.city, record.country].filter(Boolean).join(", ") || DASH
                : undefined
            }
            loading={project.loading && !record}
          />
          <MetaItem
            icon={IconCalendar}
            label="Start"
            value={record ? isoDate(record.startDate) : undefined}
            loading={project.loading && !record}
          />
          <MetaItem
            icon={IconTarget}
            label="Finish"
            value={record ? isoDate(record.finishDate) : undefined}
            hint={
              remaining === null
                ? record && !record.finishDate
                  ? "no finish date recorded"
                  : undefined
                : remaining >= 0
                  ? `${remaining} day${remaining === 1 ? "" : "s"} remaining`
                  : `${Math.abs(remaining)} day${Math.abs(remaining) === 1 ? "" : "s"} past`
            }
            hintTone={remaining !== null && remaining < 0 ? "danger" : undefined}
            loading={project.loading && !record}
          />

          <ContractValueMeta />

          <PercentCompleteMeta />
        </div>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */

function MetaItem({
  icon: Glyph,
  label,
  value,
  hint,
  hintTone,
  loading = false,
  children,
}: {
  icon: IconComponent;
  label: string;
  value?: ReactNode;
  hint?: ReactNode;
  hintTone?: "danger" | "warning";
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Glyph size={14} aria-hidden="true" className="shrink-0 text-content-disabled" />
      <div className="min-w-0">
        <div className="text-label uppercase leading-none text-content-subtle">{label}</div>
        <div className="mt-1 flex items-baseline gap-1.5 text-meta text-content">
          {loading ? (
            <Skeleton width={84} height={12} radius="sm" />
          ) : (
            (children ?? <span className="truncate tabular-nums">{value ?? DASH}</span>)
          )}
          {hint && !loading ? (
            <span
              className={cx(
                "truncate text-2xs",
                hintTone ? toneClass(hintTone === "danger" ? "danger" : "warning", "text") : "text-content-subtle",
              )}
            >
              {hint}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Contract value. One currency → the revised contract sum. More than one →
 * the count and a pointer, because summing them would be a fabrication. No
 * prime contract → the value typed on the project record, labelled as such.
 */
function ContractValueMeta() {
  const { project, contracts } = useProjectWorkspace();
  const groups = contracts.data?.groups ?? [];
  const record = project.data;

  if (contracts.loading && !contracts.data) {
    return <MetaItem icon={IconBudget} label="Contract value" loading />;
  }

  if (groups.length === 1) {
    const group = groups[0]!;
    return (
      <MetaItem icon={IconBudget} label="Contract value" hint={`revised · ${group.currency}`}>
        <span className="font-semibold tabular-nums">
          {money(group.revisedContractSum, group.currency)}
        </span>
      </MetaItem>
    );
  }

  if (groups.length > 1) {
    return (
      <MetaItem
        icon={IconBudget}
        label="Contract value"
        hint={contracts.data?.combinedRevisedContractSum.reasons[0]}
      >
        <Tooltip
          maxWidth={380}
          content={
            contracts.data?.combinedRevisedContractSum.reasons.join(" ") ??
            "Contract sums are never summed across currencies."
          }
        >
          <span tabIndex={0} className="focus-ring cursor-help font-semibold outline-none">
            {groups.map((g) => `${g.currency} ${money(g.revisedContractSum, g.currency, { compact: true })}`).join("  ·  ")}
          </span>
        </Tooltip>
      </MetaItem>
    );
  }

  // No prime contract on this project.
  return (
    <MetaItem
      icon={IconBudget}
      label="Contract value"
      hint={
        record?.value === null || record?.value === undefined
          ? "no prime contract and no value on the project record"
          : `project record · ${record.currency} · no prime contract raised`
      }
    >
      {record?.value === null || record?.value === undefined ? (
        <span className="italic text-content-subtle">not available</span>
      ) : (
        <span className="font-semibold tabular-nums">{money(record.value, record.currency)}</span>
      )}
    </MetaItem>
  );
}

/** Percent complete = billed against the revised contract sum, per currency. */
function PercentCompleteMeta() {
  const { contracts } = useProjectWorkspace();
  const groups = contracts.data?.groups ?? [];

  if (contracts.loading && !contracts.data) {
    return <MetaItem icon={IconCheckCircle} label="Complete" loading />;
  }

  if (groups.length === 0) {
    return (
      <MetaItem
        icon={IconCheckCircle}
        label="Complete"
        hint="no prime contract, so nothing has been billed against one"
      >
        <span className="italic text-content-subtle">not available</span>
      </MetaItem>
    );
  }

  if (groups.length > 1) {
    return (
      <MetaItem
        icon={IconCheckCircle}
        label="Complete"
        hint="reported per currency on the overview"
      >
        <span className="tabular-nums">
          {groups
            .map((g) => `${g.currency} ${g.percentComplete.value === null ? DASH : pct(g.percentComplete.value, 1)}`)
            .join("  ·  ")}
        </span>
      </MetaItem>
    );
  }

  const group = groups[0]!;
  return (
    <MetaItem icon={IconCheckCircle} label="Complete" hint={`billed · ${group.currency}`}>
      <span className="flex items-center gap-2">
        <Figure
          figure={group.percentComplete}
          render={(value) => (
            <>
              <span className="font-semibold tabular-nums">{pct(value, 1)}</span>
              <Progress
                value={Math.max(0, Math.min(100, value))}
                size="xs"
                tone="accent"
                className="w-20"
                aria-label="Percent of the revised contract sum billed"
              />
            </>
          )}
        />
      </span>
    </MetaItem>
  );
}
