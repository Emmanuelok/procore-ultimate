/**
 * Timeline / ActivityFeed — the chronological record.
 *
 * `Timeline` is the primitive: a rail, a node per entry, and a body. It is used
 * for approval chains, revision history, and schedule milestones.
 *
 * `ActivityFeed` layers day bucketing and actor avatars on top — the audit
 * trail on a record page.
 */
import { Fragment, useMemo, type ReactNode } from "react";
import { cx } from "../cx";
import { IconCircle } from "../icons";
import { Avatar, Badge, type IconLike } from "../primitives";
import { tone as toneStyles, type Tone } from "../tokens";
import { formatDateTimeCell, formatDayBucket, formatRelativeTime, toDate } from "./format";
import { renderIconLike } from "./internals";

export interface TimelineActor {
  name: string;
  avatarUrl?: string | null;
  role?: string;
}

export interface TimelineItem {
  id: string;
  /** The headline. Strings are rendered as body text; nodes pass through. */
  title: ReactNode;
  description?: ReactNode;
  /** ISO string, epoch ms or Date. */
  timestamp?: string | number | Date | null;
  actor?: TimelineActor | string;
  icon?: IconLike;
  tone?: Tone;
  /** Small chip on the right of the headline. */
  badge?: ReactNode;
  /** Rich content under the headline — a diff, a quote, an attachment strip. */
  body?: ReactNode;
  /** Right-aligned actions revealed on hover. */
  actions?: ReactNode;
  /** Dims the entry (superseded revisions, withdrawn approvals). */
  muted?: boolean;
}

export interface TimelineProps {
  items: readonly TimelineItem[];
  /** `relative` shows "3 days ago"; `absolute` shows the full stamp. */
  timeFormat?: "relative" | "absolute";
  /** Drop the connecting rail — for short, non-sequential lists. */
  rail?: boolean;
  /** Tighter vertical rhythm. */
  compact?: boolean;
  className?: string;
  "aria-label"?: string;
  emptyText?: ReactNode;
}

export function Timeline({
  items,
  timeFormat = "relative",
  rail = true,
  compact = false,
  className,
  "aria-label": ariaLabel = "Timeline",
  emptyText = "No activity yet",
}: TimelineProps) {
  if (items.length === 0) {
    return (
      <p className={cx("py-6 text-center text-body text-content-subtle", className)}>{emptyText}</p>
    );
  }

  return (
    <ol aria-label={ariaLabel} className={cx("relative flex flex-col", className)}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const styles = toneStyles[item.tone ?? "neutral"];
        const actor = typeof item.actor === "string" ? { name: item.actor } : item.actor;

        return (
          <li
            key={item.id}
            className={cx(
              "group/entry relative flex gap-3",
              compact ? "pb-3" : "pb-4",
              last && "pb-0",
              item.muted && "opacity-60",
            )}
          >
            {/* rail + node */}
            <div className="relative flex w-6 shrink-0 flex-col items-center">
              <span
                className={cx(
                  "z-10 grid size-6 shrink-0 place-items-center rounded-full border",
                  item.icon
                    ? cx(styles.subtle, styles.border)
                    : cx("border-transparent", styles.subtle),
                )}
              >
                {item.icon ? (
                  renderIconLike(item.icon, 13)
                ) : (
                  <IconCircle size={7} className={cx("fill-current", styles.text)} />
                )}
              </span>
              {rail && !last ? (
                <span
                  aria-hidden="true"
                  className="absolute top-6 bottom-[-0.25rem] w-px bg-border"
                />
              ) : null}
            </div>

            {/* body */}
            <div className={cx("min-w-0 flex-1", compact ? "pb-0" : "pb-0.5")}>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {actor ? (
                  <span className="flex items-center gap-1.5">
                    <Avatar name={actor.name} src={actor.avatarUrl ?? null} size="2xs" />
                    <span className="text-body font-medium text-content">{actor.name}</span>
                  </span>
                ) : null}
                <span className="min-w-0 text-body text-content-muted">{item.title}</span>
                {item.badge ? <span className="shrink-0">{item.badge}</span> : null}
                <span className="flex-1" />
                {item.timestamp ? (
                  <time
                    dateTime={toDate(item.timestamp)?.toISOString()}
                    title={formatDateTimeCell(item.timestamp)}
                    className="shrink-0 text-meta tabular-nums text-content-subtle"
                  >
                    {timeFormat === "relative"
                      ? formatRelativeTime(item.timestamp)
                      : formatDateTimeCell(item.timestamp)}
                  </time>
                ) : null}
                {item.actions ? (
                  <span className="shrink-0 opacity-0 transition-opacity duration-fast group-hover/entry:opacity-100 focus-within:opacity-100">
                    {item.actions}
                  </span>
                ) : null}
              </div>

              {item.description ? (
                <p className="mt-0.5 text-meta text-content-subtle">{item.description}</p>
              ) : null}

              {item.body ? <div className="mt-2 min-w-0">{item.body}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ========================================================================== */
/* ActivityFeed                                                                */
/* ========================================================================== */

export interface ActivityFeedProps extends Omit<TimelineProps, "items"> {
  items: readonly TimelineItem[];
  /** Insert a sticky "Today / Yesterday / 12 March 2026" heading per day. */
  groupByDay?: boolean;
  /** Newest first. Default true. */
  descending?: boolean;
}

export function ActivityFeed({
  items,
  groupByDay = true,
  descending = true,
  className,
  ...rest
}: ActivityFeedProps) {
  const ordered = useMemo(() => {
    const list = [...items];
    list.sort((a, b) => {
      const timeA = toDate(a.timestamp)?.getTime() ?? 0;
      const timeB = toDate(b.timestamp)?.getTime() ?? 0;
      return descending ? timeB - timeA : timeA - timeB;
    });
    return list;
  }, [items, descending]);

  const buckets = useMemo(() => {
    if (!groupByDay) return [{ label: null as string | null, items: ordered }];
    const map = new Map<string, TimelineItem[]>();
    for (const item of ordered) {
      const label = item.timestamp ? formatDayBucket(item.timestamp) : "Undated";
      const bucket = map.get(label);
      if (bucket) bucket.push(item);
      else map.set(label, [item]);
    }
    return [...map.entries()].map(([label, entries]) => ({ label, items: entries }));
  }, [ordered, groupByDay]);

  return (
    <div className={cx("flex flex-col", className)}>
      {buckets.map((bucket, index) => (
        <Fragment key={bucket.label ?? index}>
          {bucket.label ? (
            <div className="sticky top-0 z-10 -mx-1 mb-2 bg-surface/90 px-1 py-1 backdrop-blur-sm">
              <h4 className="text-label uppercase text-content-subtle">{bucket.label}</h4>
            </div>
          ) : null}
          <Timeline {...rest} items={bucket.items} className={index > 0 ? "mt-1" : undefined} />
          {index < buckets.length - 1 ? <div className="h-4" /> : null}
        </Fragment>
      ))}
    </div>
  );
}

/** A ready-made badge for feed entries: "created", "approved", "rejected"… */
export function ActivityBadge({ action, tone: badgeTone }: { action: string; tone?: Tone }) {
  return (
    <Badge tone={badgeTone ?? "neutral"} size="xs" variant="outline">
      {action}
    </Badge>
  );
}
