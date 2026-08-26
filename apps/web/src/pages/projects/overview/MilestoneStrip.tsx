/**
 * The milestone strip — the schedule reduced to the dates people quote.
 *
 * A milestone in this schema is a zero-duration activity (`durationDays === 0`),
 * which is how the CPM engine models it. Nothing here is inferred: a schedule
 * with no zero-duration activities gets an empty state that says exactly that
 * and how to fix it, rather than a strip of invented dates.
 */
import { Link } from "react-router-dom";
import { Badge, Skeleton } from "../../../ui";
import { IconMilestone } from "../../../ui/icons";
import { cx } from "../../../ui/cx";
import { toneClass, type Tone } from "../../../ui/tokens";
import {
  daysBetween,
  isoDate,
  todayIso,
  type Loadable,
  type Paginated,
} from "../../../layouts/project/lib";
import Panel from "./Panel";
import { activeSchedule } from "./hooks";
import type { ScheduleDetail, ScheduleRow, ScheduleTaskRow } from "./types";

type MilestoneState = "complete" | "late" | "due" | "upcoming";

interface Milestone {
  task: ScheduleTaskRow;
  date: string | null;
  state: MilestoneState;
  daysAway: number | null;
}

const STATE_TONE: Record<MilestoneState, Tone> = {
  complete: "success",
  late: "danger",
  due: "warning",
  upcoming: "neutral",
};

const STATE_LABEL: Record<MilestoneState, string> = {
  complete: "Achieved",
  late: "Missed",
  due: "Due",
  upcoming: "Planned",
};

export interface MilestoneStripProps {
  schedules: Loadable<Paginated<ScheduleRow>>;
  detail: Loadable<ScheduleDetail>;
  className?: string;
}

export default function MilestoneStrip({ schedules, detail, className }: MilestoneStripProps) {
  const schedule = activeSchedule(schedules.data);
  const today = todayIso();

  const milestones: Milestone[] = (detail.data?.tasks ?? [])
    .filter((task) => task.durationDays === 0)
    .map((task) => {
      const date = task.actualFinish ?? task.finishDate ?? task.startDate;
      const daysAway = daysBetween(today, date);
      let state: MilestoneState;
      if (task.actualFinish) state = "complete";
      else if (daysAway === null) state = "upcoming";
      else if (daysAway < 0) state = "late";
      else if (daysAway <= 14) state = "due";
      else state = "upcoming";
      return { task, date, state, daysAway };
    })
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

  const loading = schedules.loading || (schedule !== null && detail.loading && !detail.data);
  const error = schedules.error ?? detail.error;

  const emptyHint = !schedule
    ? "No schedule has been created on this project. Build one in Schedule and its milestones will appear here."
    : `The active schedule “${schedule.name}” holds ${detail.data?.tasks.length ?? 0} activities, but none of them is a milestone. A milestone is a zero-duration activity — mark the key dates that way and they will appear on this strip.`;

  const achieved = milestones.filter((m) => m.state === "complete").length;
  const late = milestones.filter((m) => m.state === "late").length;

  return (
    <Panel
      className={className}
      title="Milestones"
      subtitle={
        schedule
          ? `${schedule.name}${schedule.computedFinish ? ` · computed finish ${isoDate(schedule.computedFinish)}` : " · not yet computed"}`
          : "Key dates from the active schedule"
      }
      icon={IconMilestone}
      loading={loading}
      error={error}
      onRetry={detail.reload}
      isEmpty={milestones.length === 0}
      emptyTitle={schedule ? "No milestones on the active schedule" : "No schedule yet"}
      emptyHint={emptyHint}
      skeleton={
        <div className="flex gap-6">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="w-40 space-y-2">
              <Skeleton height={10} width="55%" radius="sm" />
              <Skeleton height={12} width="90%" radius="sm" />
              <Skeleton height={10} width="40%" radius="sm" />
            </div>
          ))}
        </div>
      }
      actions={
        milestones.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <Badge tone="success" size="xs" variant="subtle">
              {achieved} achieved
            </Badge>
            {late > 0 ? (
              <Badge tone="danger" size="xs" variant="subtle">
                {late} missed
              </Badge>
            ) : null}
            <Link
              to="schedule"
              className="rounded px-1 text-meta text-accent-text underline-offset-2 hover:underline"
            >
              Open schedule
            </Link>
          </div>
        ) : null
      }
      bodyClassName="px-0 pb-0"
      footer={
        milestones.length > 0
          ? "A milestone is a zero-duration activity on the active schedule. Dates are the CPM-computed finish, or the actual finish once one is recorded."
          : undefined
      }
    >
      <div className="overflow-x-auto px-card pb-card">
        <ol className="flex min-w-max items-stretch">
          {milestones.map((milestone, index) => (
            <li
              key={milestone.task.id}
              className="relative flex w-[11.5rem] shrink-0 flex-col px-3 first:pl-0"
            >
              {/* rail */}
              <div className="relative mb-2.5 flex h-4 items-center">
                {index > 0 ? (
                  <span aria-hidden="true" className="absolute left-0 right-1/2 h-px bg-border" />
                ) : null}
                {index < milestones.length - 1 ? (
                  <span aria-hidden="true" className="absolute left-1/2 right-0 h-px bg-border" />
                ) : null}
                <span
                  aria-hidden="true"
                  className={cx(
                    "relative z-10 mx-auto grid size-3.5 place-items-center rounded-[3px] border-2 rotate-45",
                    toneClass(STATE_TONE[milestone.state], "border"),
                    milestone.state === "upcoming"
                      ? "bg-surface-raised"
                      : toneClass(STATE_TONE[milestone.state], "dot"),
                  )}
                />
              </div>

              <div className="min-w-0 text-center">
                <div className="truncate text-2xs font-medium tabular-nums text-content-muted">
                  {isoDate(milestone.date)}
                </div>
                <div
                  className="mt-0.5 line-clamp-2 text-meta font-medium text-content"
                  title={milestone.task.name}
                >
                  {milestone.task.name}
                </div>
                <div className="mt-1 flex items-center justify-center gap-1">
                  <Badge tone={STATE_TONE[milestone.state]} size="xs" variant="subtle" dot>
                    {STATE_LABEL[milestone.state]}
                  </Badge>
                </div>
                {milestone.daysAway !== null && milestone.state !== "complete" ? (
                  <div className="mt-1 text-2xs text-content-subtle">
                    {milestone.daysAway < 0
                      ? `${Math.abs(milestone.daysAway)} day${Math.abs(milestone.daysAway) === 1 ? "" : "s"} late`
                      : `in ${milestone.daysAway} day${milestone.daysAway === 1 ? "" : "s"}`}
                  </div>
                ) : null}
                {milestone.task.isCritical === 1 ? (
                  <div className="mt-1 text-2xs font-medium text-danger-fg">On critical path</div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
