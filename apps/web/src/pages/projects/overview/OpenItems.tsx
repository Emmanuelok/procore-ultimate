/**
 * Open items by tool — RFIs, submittals and punch, worst first.
 *
 * "Worst first" is a real ordering, not a guess: anything past its date leads,
 * then the nearest date, then the oldest record. Items with no date sink to the
 * bottom and are labelled "no date set" rather than being silently treated as
 * on time.
 */
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Badge } from "../../../ui";
import { IconPunch, IconRfi, IconSubmittal, type IconComponent } from "../../../ui/icons";
import { cx } from "../../../ui/cx";
import { toneClass, type Tone } from "../../../ui/tokens";
import {
  daysBetween,
  isoDateShort,
  titleCase,
  todayIso,
  type Loadable,
  type Paginated,
} from "../../../layouts/project/lib";
import Panel, { RowSkeleton } from "./Panel";
import type { PunchRow, RfiRow, SubmittalRow } from "./types";

const SHOWN = 6;

interface OpenItem {
  id: string;
  code: string;
  title: string;
  status: string;
  date: string | null;
  dateLabel: string;
  href: string;
  createdAt: string;
}

function urgency(item: OpenItem): number {
  if (!item.date) return Number.MAX_SAFE_INTEGER - 1;
  const days = daysBetween(todayIso(), item.date);
  return days ?? Number.MAX_SAFE_INTEGER - 1;
}

function ItemsPanel({
  title,
  icon,
  items,
  total,
  loading,
  error,
  onRetry,
  href,
  emptyHint,
  overdueCount,
  footer,
}: {
  title: string;
  icon: IconComponent;
  items: OpenItem[];
  total: number | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  href: string;
  emptyHint: ReactNode;
  /** `null` = the overdue count could not be read. Never shown as zero. */
  overdueCount: number | null;
  footer?: ReactNode;
}) {
  const ordered = [...items].sort(
    (a, b) => urgency(a) - urgency(b) || a.createdAt.localeCompare(b.createdAt),
  );
  const shown = ordered.slice(0, SHOWN);

  return (
    <Panel
      title={title}
      icon={icon}
      tone={overdueCount !== null && overdueCount > 0 ? "warning" : "neutral"}
      subtitle={
        total === null
          ? overdueCount === null
            ? undefined
            : "count unavailable"
          : `${total} open${
              overdueCount === null
                ? " · overdue count unavailable"
                : overdueCount > 0
                  ? ` · ${overdueCount} past due`
                  : ""
            }`
      }
      actions={
        <Link
          to={href}
          className="rounded px-1 text-meta text-accent-text underline-offset-2 hover:underline"
        >
          Open all
        </Link>
      }
      loading={loading}
      error={error}
      onRetry={onRetry}
      isEmpty={ordered.length === 0}
      emptyTitle="Nothing open"
      emptyHint={emptyHint}
      skeleton={<RowSkeleton rows={4} />}
      bodyClassName="p-0"
      footer={
        ordered.length > shown.length
          ? `Showing the ${shown.length} most urgent of ${ordered.length} loaded.`
          : footer
      }
    >
      <ul className="divide-y divide-border-subtle">
        {shown.map((item) => {
          const days = item.date ? daysBetween(todayIso(), item.date) : null;
          const tone: Tone =
            days === null ? "neutral" : days < 0 ? "danger" : days <= 7 ? "warning" : "neutral";
          return (
            <li key={item.id}>
              <Link
                to={item.href}
                className="focus-ring flex items-center gap-3 px-card py-2 outline-none transition-colors duration-fast hover:bg-surface-hover"
              >
                <span className="w-12 shrink-0 truncate font-mono text-2xs text-content-subtle">
                  {item.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-meta text-content" title={item.title}>
                  {item.title}
                </span>
                <Badge tone={tone} size="xs" variant="subtle" className="shrink-0">
                  {item.date
                    ? days !== null && days < 0
                      ? `${Math.abs(days)}d late`
                      : `${item.dateLabel} ${isoDateShort(item.date)}`
                    : "no date set"}
                </Badge>
                <span
                  className={cx(
                    "hidden w-20 shrink-0 truncate text-right text-2xs sm:block",
                    toneClass("neutral", "text"),
                  )}
                >
                  {titleCase(item.status)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

export function OpenRfisPanel({
  rfis,
  open,
  overdue,
}: {
  rfis: Loadable<Paginated<RfiRow>>;
  open: number | null;
  overdue: number | null;
}) {
  const items: OpenItem[] = (rfis.data?.items ?? []).map((rfi) => ({
    id: rfi.id,
    code: `RFI-${String(rfi.number).padStart(3, "0")}`,
    title: rfi.subject,
    status: rfi.status,
    date: rfi.dueDate,
    dateLabel: "due",
    href: `rfis/${rfi.id}`,
    createdAt: rfi.createdAt,
  }));

  return (
    <ItemsPanel
      title="RFIs"
      icon={IconRfi}
      items={items}
      total={open}
      loading={rfis.loading && !rfis.data}
      error={rfis.error}
      onRetry={rfis.reload}
      href="rfis"
      overdueCount={overdue}
      emptyHint="No RFI on this project is open. Raise one from the RFI register when the design needs a decision."
    />
  );
}

/** The submittal statuses the field module itself counts as open. */
const OPEN_SUBMITTAL_STATUSES = ["open", "in_review", "responded"];

export function OpenSubmittalsPanel({
  submittals,
  open,
}: {
  submittals: Loadable<Paginated<SubmittalRow>>;
  open: number | null;
}) {
  const rows = (submittals.data?.items ?? []).filter((row) =>
    OPEN_SUBMITTAL_STATUSES.includes(row.status),
  );
  const items: OpenItem[] = rows.map((row) => ({
    id: row.id,
    code: `SUB-${String(row.number).padStart(3, "0")}${row.revision > 0 ? `.${row.revision}` : ""}`,
    title: row.title,
    status: row.status,
    date: row.submitByDate ?? row.requiredOnSite,
    dateLabel: row.submitByDate ? "submit by" : "on site",
    href: `submittals/${row.id}`,
    createdAt: row.createdAt,
  }));

  const overdue = items.filter((item) => {
    const days = item.date ? daysBetween(todayIso(), item.date) : null;
    return days !== null && days < 0;
  }).length;

  return (
    <ItemsPanel
      title="Submittals"
      icon={IconSubmittal}
      items={items}
      total={open}
      loading={submittals.loading && !submittals.data}
      error={submittals.error}
      onRetry={submittals.reload}
      href="submittals"
      overdueCount={overdue}
      emptyHint="No submittal on this project is awaiting action. Closed and voided submittals are excluded."
      footer="Dates are the computed submit-by date where one exists, otherwise the required-on-site date."
    />
  );
}

export function OpenPunchPanel({
  punch,
  open,
  overdue,
}: {
  punch: Loadable<Paginated<PunchRow>>;
  open: number | null;
  overdue: number | null;
}) {
  const items: OpenItem[] = (punch.data?.items ?? []).map((row) => ({
    id: row.id,
    code: `PL-${String(row.number).padStart(3, "0")}`,
    title: row.title,
    status: row.priority,
    date: row.dueDate,
    dateLabel: "due",
    href: "punch",
    createdAt: row.createdAt,
  }));

  return (
    <ItemsPanel
      title="Punch list"
      icon={IconPunch}
      items={items}
      total={open}
      loading={punch.loading && !punch.data}
      error={punch.error}
      onRetry={punch.reload}
      href="punch"
      overdueCount={overdue}
      emptyHint="No punch item on this project is open. Items in progress or ready for review are counted elsewhere."
      footer="Items with status “open” only. The right-hand column shows priority."
    />
  );
}
