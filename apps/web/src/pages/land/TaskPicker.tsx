/**
 * Blocking-task multi-select (#591). A parcel is mapped to the schedule tasks
 * it holds up, which is what turns the land register from a filing cabinet
 * into a programme control: the moment a task's planned start crosses the
 * horizon while its land is still in acquisition, the workspace says so.
 *
 * Tasks come from the project's active schedule by default — an archived
 * baseline's task ids are still selectable through the schedule switcher, but
 * the active one is what the countdown is computed against.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Input, Select, Spinner } from "../../ui";
import { formatDate } from "../format";
import type {
  ListResponse,
  ScheduleLite,
  ScheduleTaskLite,
  TaskOption,
} from "./landShared";

export default function TaskPicker({
  projectId,
  selected,
  onChange,
}: {
  projectId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [schedules, setSchedules] = useState<ScheduleLite[] | null>(null);
  const [scheduleId, setScheduleId] = useState("");
  const [tasks, setTasks] = useState<TaskOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.get<ListResponse<ScheduleLite>>(`${base}/schedules?pageSize=20`);
        if (cancelled) return;
        const items = list.items ?? [];
        setSchedules(items);
        const active = items.find((s) => s.isActive === 1) ?? items[0];
        setScheduleId(active?.id ?? "");
        if (!active) setTasks([]);
      } catch (err) {
        if (cancelled) return;
        setSchedules([]);
        setTasks([]);
        setError(err instanceof Error ? err.message : "Failed to load schedules");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  useEffect(() => {
    if (!scheduleId || schedules === null) return;
    let cancelled = false;
    setTasks(null);
    void (async () => {
      try {
        const detail = await api.get<{ tasks: ScheduleTaskLite[] }>(
          `${base}/schedules/${scheduleId}`,
        );
        if (cancelled) return;
        const schedule = schedules.find((s) => s.id === scheduleId);
        setTasks(
          (detail.tasks ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            startDate: t.startDate ?? null,
            scheduleName: schedule?.name ?? "Schedule",
            isActiveSchedule: schedule?.isActive === 1,
          })),
        );
      } catch (err) {
        if (cancelled) return;
        setTasks([]);
        setError(err instanceof Error ? err.message : "Failed to load the schedule's tasks");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, scheduleId, schedules]);

  const visible = useMemo(() => {
    if (tasks === null) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter((t) => t.name.toLowerCase().includes(needle));
  }, [tasks, search]);

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  if (schedules === null) return <Spinner label="Loading schedules…" />;

  if (schedules.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-ink-200 px-3 py-4 text-center text-xs text-ink-400">
        {error ??
          "This project has no schedule yet. Once one exists, map each parcel to the works it blocks and the workspace will count down to the day the programme meets the land."}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {schedules.length > 1 ? (
          <Select
            className="w-56"
            value={scheduleId}
            onChange={(e) => setScheduleId(e.target.value)}
            aria-label="Schedule"
          >
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.isActive === 1 ? " (active)" : ""}
              </option>
            ))}
          </Select>
        ) : null}
        <Input
          className="w-52 flex-1"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter tasks…"
          aria-label="Filter tasks"
        />
      </div>

      {tasks === null ? (
        <Spinner label="Loading tasks…" />
      ) : tasks.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink-200 px-3 py-4 text-center text-xs text-ink-400">
          This schedule has no tasks yet.
        </div>
      ) : (
        <div className="max-h-48 overflow-y-auto rounded-md ring-1 ring-ink-200">
          <ul className="divide-y divide-ink-100">
            {visible.map((t) => {
              const checked = selected.includes(t.id);
              return (
                <li key={t.id}>
                  <label
                    className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-ink-50 ${
                      checked ? "bg-brand-50/60" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                      checked={checked}
                      onChange={() => toggle(t.id)}
                    />
                    <span className="min-w-0 flex-1 truncate text-ink-800">{t.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-400">
                      {formatDate(t.startDate)}
                    </span>
                  </label>
                </li>
              );
            })}
            {visible.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-ink-400">
                No task matches “{search}”.
              </li>
            ) : null}
          </ul>
        </div>
      )}

      <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
        <span>
          {selected.length} task{selected.length === 1 ? "" : "s"} blocked by this parcel
        </span>
        {selected.length > 0 ? (
          <button
            type="button"
            className="font-medium text-brand-700 hover:text-brand-800"
            onClick={() => onChange([])}
          >
            Clear
          </button>
        ) : null}
      </div>
      {tasks !== null && tasks.length > 0 && schedules.find((s) => s.id === scheduleId)?.isActive !== 1 ? (
        <p className="mt-1 text-xs text-amber-700">
          <Badge tone="amber">Not the active schedule</Badge>{" "}
          The programme countdown is computed against the active schedule.
        </p>
      ) : null}
    </div>
  );
}
