/**
 * Schedule workspace — native CPM scheduling (spec Vol I §2.6 subset:
 * #351 creation/editing, #353 critical path, #354 typed dependencies,
 * #355-357 baselines & comparison, #358/#361 progress, #359 lookahead,
 * #371 DCMA-style health). Left: editable task table + per-task dependency
 * editor. Right: pure-SVG Gantt with baseline ghost bars. Below: baseline
 * compare, lookahead and schedule-health panels. All mutations recompute
 * server-side; the page refetches and flashes a subtle "recomputed" note.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useParams } from "react-router-dom";
import { DEPENDENCY_TYPES, TASK_CONSTRAINT_TYPES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Th,
} from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import GanttSvg from "./GanttSvg";
import QualityPanel from "./QualityPanel";
import {
  shortDate,
  type BaselineDetail,
  type BaselineRow,
  type BaselineTask,
  type CompareItem,
  type CompareResponse,
  type ComputeSummary,
  type DepRow,
  type LookaheadResponse,
  type QualityReport,
  type ScheduleDetail,
  type ScheduleRow,
  type TaskRow,
} from "./types";

/** Constraint types that require a date (mirrors the server rule). */
const DATED_CONSTRAINTS = ["start_no_earlier_than", "finish_no_later_than", "must_start_on"];

type Panel = "compare" | "lookahead" | "health";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError || err instanceof Error ? err.message : fallback;
}

/** Replace raw task ids in a server message (e.g. the 409 cycle body) with names. */
function withTaskNames(message: string, tasks: TaskRow[]): string {
  let out = message;
  for (const t of tasks) out = out.split(t.id).join(`“${t.name}”`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Inline cell editors — commit on blur / Enter, revert on Escape      */
/* ------------------------------------------------------------------ */

const inlineClass =
  "w-full rounded border-0 bg-transparent px-1 py-0.5 text-sm text-ink-800 ring-inset placeholder:text-ink-300 hover:bg-ink-50 focus:bg-white focus:ring-1 focus:ring-brand-500";

function InlineText({
  value,
  onCommit,
  className,
  placeholder,
  required,
  mono,
  label,
}: {
  value: string;
  onCommit: (next: string) => void;
  className?: string;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (required && !next) {
      setDraft(value);
      return;
    }
    if (next !== value) onCommit(next);
  };
  return (
    <input
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
      }}
      className={`${inlineClass} ${mono ? "font-mono text-xs" : ""} ${className ?? ""}`}
    />
  );
}

function InlineNumber({
  value,
  onCommit,
  min,
  max,
  className,
  label,
  suffix,
}: {
  value: number;
  onCommit: (next: number) => void;
  min: number;
  max: number;
  className?: string;
  label: string;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    if (clamped !== value) onCommit(clamped);
    else setDraft(String(value));
  };
  return (
    <span className="inline-flex items-center gap-0.5">
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={1}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(String(value));
        }}
        className={`${inlineClass} text-right tabular-nums ${className ?? "w-14"}`}
      />
      {suffix ? <span className="text-xs text-ink-400">{suffix}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Expanded task row — constraint + actual dates, draft with Save      */
/* ------------------------------------------------------------------ */

function TaskDetailsEditor({
  task,
  busy,
  onSave,
}: {
  task: TaskRow;
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [constraintType, setConstraintType] = useState(task.constraintType ?? "");
  const [constraintDate, setConstraintDate] = useState(task.constraintDate ?? "");
  const [actualStart, setActualStart] = useState(task.actualStart ?? "");
  const [actualFinish, setActualFinish] = useState(task.actualFinish ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setConstraintType(task.constraintType ?? "");
    setConstraintDate(task.constraintDate ?? "");
    setActualStart(task.actualStart ?? "");
    setActualFinish(task.actualFinish ?? "");
    setLocalError(null);
  }, [task]);

  const dirty =
    constraintType !== (task.constraintType ?? "") ||
    constraintDate !== (task.constraintDate ?? "") ||
    actualStart !== (task.actualStart ?? "") ||
    actualFinish !== (task.actualFinish ?? "");

  async function save() {
    setLocalError(null);
    if (constraintType && DATED_CONSTRAINTS.includes(constraintType) && !constraintDate) {
      setLocalError(`A constraint date is required for “${humanize(constraintType)}”.`);
      return;
    }
    if (actualFinish && !actualStart) {
      setLocalError("An actual finish requires an actual start.");
      return;
    }
    if (actualStart && actualFinish && actualFinish < actualStart) {
      setLocalError("The actual finish must be on or after the actual start.");
      return;
    }
    await onSave({
      constraintType: constraintType || null,
      constraintDate: constraintType && constraintDate ? constraintDate : null,
      actualStart: actualStart || null,
      actualFinish: actualFinish || null,
    });
  }

  return (
    <div className="space-y-2 bg-ink-50/70 px-4 py-3">
      {localError ? <div className="text-xs text-red-600">{localError}</div> : null}
      <div className="grid grid-cols-2 items-end gap-3 lg:grid-cols-5">
        <Field label="Constraint">
          <Select
            value={constraintType}
            onChange={(e) => setConstraintType(e.target.value)}
            className="py-1.5 text-xs"
          >
            <option value="">None (ASAP)</option>
            {TASK_CONSTRAINT_TYPES.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Constraint date">
          <Input
            type="date"
            value={constraintDate}
            onChange={(e) => setConstraintDate(e.target.value)}
            className="py-1.5 text-xs"
            disabled={!constraintType || !DATED_CONSTRAINTS.includes(constraintType)}
          />
        </Field>
        <Field label="Actual start">
          <Input
            type="date"
            value={actualStart}
            onChange={(e) => setActualStart(e.target.value)}
            className="py-1.5 text-xs"
          />
        </Field>
        <Field label="Actual finish">
          <Input
            type="date"
            value={actualFinish}
            onChange={(e) => setActualFinish(e.target.value)}
            className="py-1.5 text-xs"
          />
        </Field>
        <div className="flex items-center gap-2 pb-0.5">
          <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
            Save details
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-ink-400">
        Actuals pin the CPM pass — actual start pins the start, actual finish pins the finish and
        overrides duration. Duration 0 renders as a milestone.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dependency editor row (predecessor of the selected task)            */
/* ------------------------------------------------------------------ */

function DepEditorRow({
  dep,
  candidates,
  busy,
  onUpdate,
  onRemove,
}: {
  dep: DepRow;
  candidates: TaskRow[];
  busy: boolean;
  onUpdate: (next: { predecessorId: string; depType: string; lagDays: number }) => void;
  onRemove: () => void;
}) {
  const [lag, setLag] = useState(String(dep.lagDays));
  useEffect(() => setLag(String(dep.lagDays)), [dep.lagDays, dep.id]);

  const commitLag = () => {
    const n = Math.round(Number(lag));
    if (!Number.isFinite(n)) {
      setLag(String(dep.lagDays));
      return;
    }
    if (n !== dep.lagDays)
      onUpdate({ predecessorId: dep.predecessorId, depType: dep.depType, lagDays: n });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-40 flex-1">
        <Select
          value={dep.predecessorId}
          aria-label="Predecessor task"
          disabled={busy}
          onChange={(e) =>
            onUpdate({ predecessorId: e.target.value, depType: dep.depType, lagDays: dep.lagDays })
          }
          className="py-1.5 text-xs"
        >
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.wbsCode ? `${t.wbsCode} · ` : ""}
              {t.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-20">
        <Select
          value={dep.depType}
          aria-label="Dependency type"
          disabled={busy}
          onChange={(e) =>
            onUpdate({
              predecessorId: dep.predecessorId,
              depType: e.target.value,
              lagDays: dep.lagDays,
            })
          }
          className="py-1.5 text-xs"
        >
          {DEPENDENCY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-20">
        <Input
          type="number"
          step={1}
          value={lag}
          aria-label="Lag days"
          onChange={(e) => setLag(e.target.value)}
          onBlur={commitLag}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setLag(String(dep.lagDays));
          }}
          className="py-1.5 text-right text-xs tabular-nums"
        />
      </div>
      <span className="text-[11px] text-ink-400">d lag</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Variance badge (baseline compare)                                   */
/* ------------------------------------------------------------------ */

function varianceBadge(days: number | null) {
  if (days === null) return <span className="text-ink-300">—</span>;
  if (days === 0) return <Badge tone="green">on plan</Badge>;
  if (days > 0) return <Badge tone="red">+{days}d</Badge>;
  return <Badge tone="blue">{days}d</Badge>;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function SchedulePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;

  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScheduleDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  // subtle "recomputed" note after server-side auto-recompute
  const [recomputedNote, setRecomputedNote] = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );
  const flashRecomputed = useCallback(() => {
    setRecomputedNote(true);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setRecomputedNote(false), 2600);
  }, []);

  // create-schedule modal
  const [createOpen, setCreateOpen] = useState(false);
  const [schedName, setSchedName] = useState("");
  const [schedStart, setSchedStart] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);

  // capture-baseline modal
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [baselineName, setBaselineName] = useState("");

  // task table
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [addWbs, setAddWbs] = useState("");
  const [addName, setAddName] = useState("");
  const [addDuration, setAddDuration] = useState("5");

  // dependency editor
  const [depError, setDepError] = useState<string | null>(null);
  const [newDepPred, setNewDepPred] = useState("");
  const [newDepType, setNewDepType] = useState("FS");
  const [newDepLag, setNewDepLag] = useState("0");

  // baselines / compare
  const [baselines, setBaselines] = useState<BaselineRow[] | null>(null);
  const [selectedBaselineId, setSelectedBaselineId] = useState("");
  const [baselineDetail, setBaselineDetail] = useState<BaselineDetail | null>(null);
  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  // panels
  const [panel, setPanel] = useState<Panel>("compare");
  const [weeks, setWeeks] = useState<3 | 6>(3);
  const [lookahead, setLookahead] = useState<LookaheadResponse | null>(null);
  const [lookaheadLoading, setLookaheadLoading] = useState(false);
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  /* ------------------------------ loading ------------------------------ */

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .get<{ items: ScheduleRow[] }>(`${base}/schedules?pageSize=200`)
      .then((res) => {
        if (cancelled) return;
        setSchedules(res.items ?? []);
        setSelectedId((cur) => {
          if (cur && (res.items ?? []).some((s) => s.id === cur)) return cur;
          const active = (res.items ?? []).find((s) => s.isActive === 1);
          return active?.id ?? res.items?.[0]?.id ?? null;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setSchedules([]);
        setError(errMessage(err, "Failed to load schedules"));
      });
    return () => {
      cancelled = true;
    };
  }, [base, projectId, version]);

  // reset per-schedule state when the selected schedule changes
  useEffect(() => {
    setSelectedTaskId(null);
    setExpandedTaskId(null);
    setSelectedBaselineId("");
    setBaselineDetail(null);
    setCompare(null);
    setDepError(null);
    setLookahead(null);
    setQuality(null);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .get<ScheduleDetail>(`${base}/schedules/${selectedId}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          setError(errMessage(err, "Failed to load the schedule"));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, selectedId, version]);

  useEffect(() => {
    if (!selectedId) {
      setBaselines(null);
      return;
    }
    let cancelled = false;
    api
      .get<{ items: BaselineRow[] }>(`${base}/schedules/${selectedId}/baselines`)
      .then((res) => {
        if (!cancelled) setBaselines(res.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setBaselines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [base, selectedId, version]);

  // selected baseline → snapshot (Gantt ghosts) + compare (panel)
  useEffect(() => {
    if (!selectedId || !selectedBaselineId) {
      setBaselineDetail(null);
      setCompare(null);
      return;
    }
    let cancelled = false;
    setCompareLoading(true);
    Promise.all([
      api.get<BaselineDetail>(`${base}/schedule-baselines/${selectedBaselineId}`),
      api.get<CompareResponse>(
        `${base}/schedules/${selectedId}/baselines/${selectedBaselineId}/compare`,
      ),
    ])
      .then(([snap, cmp]) => {
        if (cancelled) return;
        setBaselineDetail(snap);
        setCompare(cmp);
      })
      .catch((err) => {
        if (cancelled) return;
        setBaselineDetail(null);
        setCompare(null);
        setError(errMessage(err, "Failed to load the baseline comparison"));
      })
      .finally(() => {
        if (!cancelled) setCompareLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, selectedId, selectedBaselineId, version]);

  useEffect(() => {
    if (!selectedId || panel !== "lookahead") return;
    let cancelled = false;
    setLookaheadLoading(true);
    api
      .get<LookaheadResponse>(`${base}/schedules/${selectedId}/lookahead?weeks=${weeks}`)
      .then((res) => {
        if (!cancelled) setLookahead(res);
      })
      .catch(() => {
        if (!cancelled) setLookahead(null);
      })
      .finally(() => {
        if (!cancelled) setLookaheadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, selectedId, panel, weeks, version]);

  useEffect(() => {
    if (!selectedId || panel !== "health") return;
    let cancelled = false;
    setQualityLoading(true);
    api
      .get<QualityReport>(`${base}/schedules/${selectedId}/quality`)
      .then((res) => {
        if (!cancelled) setQuality(res);
      })
      .catch(() => {
        if (!cancelled) setQuality(null);
      })
      .finally(() => {
        if (!cancelled) setQualityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, selectedId, panel, version]);

  /* ------------------------------ derived ------------------------------ */

  const tasks = detail?.tasks ?? [];
  const deps = detail?.dependencies ?? [];
  const criticalCount =
    detail?.summary?.criticalCount ?? tasks.filter((t) => t.isCritical === 1).length;

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );
  const predecessorDeps = useMemo(
    () => deps.filter((d) => d.successorId === selectedTaskId),
    [deps, selectedTaskId],
  );
  const baselineMap = useMemo(() => {
    const snapshot = baselineDetail?.snapshot;
    if (!Array.isArray(snapshot)) return null;
    return new Map<string, BaselineTask>(snapshot.map((s) => [s.taskId, s]));
  }, [baselineDetail]);

  const compareItems: CompareItem[] = compare?.items ?? compare?.tasks ?? [];

  /* ------------------------------ mutations ------------------------------ */

  /** Run a mutating call; the server recomputes CPM — refetch + flash a note. */
  const mutate = useCallback(
    async (
      fn: () => Promise<unknown>,
      fallback: string,
      opts?: { recomputes?: boolean },
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        bump();
        if (opts?.recomputes !== false) flashRecomputed();
        return true;
      } catch (err) {
        setError(errMessage(err, fallback));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [bump, flashRecomputed],
  );

  async function onCreateSchedule(e: FormEvent) {
    e.preventDefault();
    setModalError(null);
    setBusy(true);
    try {
      const created = await api.post<ScheduleRow>(`${base}/schedules`, {
        name: schedName.trim(),
        projectStart: schedStart,
      });
      setCreateOpen(false);
      setSchedName("");
      setSchedStart("");
      setSelectedId(created.id);
      bump();
    } catch (err) {
      setModalError(errMessage(err, "Failed to create the schedule."));
    } finally {
      setBusy(false);
    }
  }

  async function onCaptureBaseline(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setModalError(null);
    setBusy(true);
    try {
      await api.post<BaselineRow>(`${base}/schedules/${selectedId}/baselines`, {
        name: baselineName.trim(),
      });
      setBaselineOpen(false);
      setBaselineName("");
      bump();
      flashRecomputed();
    } catch (err) {
      setModalError(errMessage(err, "Failed to capture the baseline."));
    } finally {
      setBusy(false);
    }
  }

  async function onRecompute() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const summary = await api.post<ComputeSummary>(
        `${base}/schedules/${selectedId}/compute`,
      );
      if (summary.cycle && summary.cycle.length > 0) {
        setError(
          withTaskNames(`Dependency cycle detected: ${summary.cycle.join(", ")}`, tasks),
        );
      } else {
        flashRecomputed();
      }
      bump();
    } catch (err) {
      setError(errMessage(err, "Recompute failed."));
    } finally {
      setBusy(false);
    }
  }

  const patchTask = useCallback(
    (taskId: string, patch: Record<string, unknown>) =>
      mutate(
        () => api.patch(`${base}/schedule-tasks/${taskId}`, patch),
        "Failed to update the task.",
      ),
    [base, mutate],
  );

  async function onAddTask() {
    if (busy || !selectedId || !addName.trim()) return;
    const ok = await mutate(
      () =>
        api.post(`${base}/schedules/${selectedId}/tasks`, {
          name: addName.trim(),
          durationDays: Math.max(0, Math.round(Number(addDuration) || 0)),
          wbsCode: addWbs.trim() || null,
        }),
      "Failed to add the task.",
    );
    if (ok) {
      setAddName("");
      setAddWbs("");
    }
  }

  async function onDeleteTask(t: TaskRow) {
    if (!window.confirm(`Delete task “${t.name}”? Its dependencies are removed too.`)) return;
    const ok = await mutate(
      () => api.del(`${base}/schedule-tasks/${t.id}`),
      "Failed to delete the task.",
    );
    if (ok) {
      if (selectedTaskId === t.id) setSelectedTaskId(null);
      if (expandedTaskId === t.id) setExpandedTaskId(null);
    }
  }

  async function moveTask(index: number, delta: -1 | 1) {
    if (!selectedId) return;
    const ids = tasks.map((t) => t.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(j, 0, moved!);
    await mutate(
      () => api.post(`${base}/schedules/${selectedId}/tasks/reorder`, { orderedIds: next }),
      "Failed to reorder tasks.",
    );
  }

  async function onAddDependency(e: FormEvent) {
    e.preventDefault();
    if (!selectedId || !selectedTaskId || !newDepPred) return;
    setDepError(null);
    setBusy(true);
    try {
      await api.post(`${base}/schedules/${selectedId}/dependencies`, {
        predecessorId: newDepPred,
        successorId: selectedTaskId,
        depType: newDepType,
        lagDays: Math.round(Number(newDepLag) || 0),
      });
      setNewDepPred("");
      setNewDepType("FS");
      setNewDepLag("0");
      bump();
      flashRecomputed();
    } catch (err) {
      // the 409 body names the cycle members — surface it inline with names
      setDepError(withTaskNames(errMessage(err, "Failed to link the tasks."), tasks));
    } finally {
      setBusy(false);
    }
  }

  /** Edit an existing link: delete → recreate; restore the original if the new link is rejected. */
  async function onUpdateDependency(
    dep: DepRow,
    next: { predecessorId: string; depType: string; lagDays: number },
  ) {
    if (!selectedId) return;
    setDepError(null);
    setBusy(true);
    try {
      await api.del(`${base}/schedule-dependencies/${dep.id}`);
      try {
        await api.post(`${base}/schedules/${selectedId}/dependencies`, {
          predecessorId: next.predecessorId,
          successorId: dep.successorId,
          depType: next.depType,
          lagDays: next.lagDays,
        });
      } catch (err) {
        await api
          .post(`${base}/schedules/${selectedId}/dependencies`, {
            predecessorId: dep.predecessorId,
            successorId: dep.successorId,
            depType: dep.depType,
            lagDays: dep.lagDays,
          })
          .catch(() => undefined);
        throw err;
      }
      flashRecomputed();
    } catch (err) {
      setDepError(withTaskNames(errMessage(err, "Failed to update the link."), tasks));
    } finally {
      setBusy(false);
      bump();
    }
  }

  async function onRemoveDependency(dep: DepRow) {
    setDepError(null);
    await mutate(
      () => api.del(`${base}/schedule-dependencies/${dep.id}`),
      "Failed to remove the link.",
    );
  }

  /* ------------------------------ render ------------------------------ */

  const selectedSchedule = schedules?.find((s) => s.id === selectedId) ?? null;

  const panels: { key: Panel; label: string }[] = [
    { key: "compare", label: "Baseline compare" },
    { key: "lookahead", label: "Lookahead" },
    { key: "health", label: "Schedule health" },
  ];

  return (
    <div>
      <PageHeader
        title="Schedule"
        subtitle="Native CPM scheduling — critical path, baselines, lookahead and DCMA-style health"
        actions={
          <>
            {selectedId ? (
              <>
                <Button variant="secondary" disabled={busy} onClick={() => void onRecompute()}>
                  Recompute
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || tasks.length === 0}
                  onClick={() => {
                    setModalError(null);
                    setBaselineOpen(true);
                  }}
                >
                  Capture baseline
                </Button>
              </>
            ) : null}
            <Button
              onClick={() => {
                setModalError(null);
                setCreateOpen(true);
              }}
            >
              New schedule
            </Button>
          </>
        }
      />

      <ErrorAlert message={error} />

      {schedules === null ? (
        <Spinner />
      ) : schedules.length === 0 ? (
        <EmptyState
          title="No schedules yet"
          hint="Create a schedule, add tasks and link them with typed dependencies — the CPM engine computes dates, float and the critical path on every change."
          action={<Button onClick={() => setCreateOpen(true)}>Create the first schedule</Button>}
        />
      ) : (
        <>
          {/* --------------------------- header bar --------------------------- */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="w-72">
              <Select
                value={selectedId ?? ""}
                aria-label="Schedule"
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isActive === 1 ? " (active)" : ""}
                  </option>
                ))}
              </Select>
            </div>
            {selectedSchedule && selectedSchedule.isActive !== 1 ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    () => api.post(`${base}/schedules/${selectedSchedule.id}/activate`),
                    "Failed to activate the schedule.",
                    { recomputes: false },
                  )
                }
              >
                Make active
              </Button>
            ) : selectedSchedule ? (
              <Badge tone="green">Active</Badge>
            ) : null}

            {detail ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-ink-200">
                  Start <strong>{formatDate(detail.projectStart)}</strong>
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-ink-200">
                  Finish <strong>{formatDate(detail.computedFinish)}</strong>
                </span>
                <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-ink-200">
                  <strong>{detail.computedDurationDays ?? "—"}</strong> days
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 ring-1 ${
                    criticalCount > 0
                      ? "bg-red-50 text-red-700 ring-red-200"
                      : "bg-white ring-ink-200"
                  }`}
                >
                  <strong>{criticalCount}</strong> critical
                </span>
                <span
                  className="rounded-full bg-white px-2.5 py-1 text-ink-400 ring-1 ring-ink-200"
                  title={`Last computed ${formatDateTime(detail.lastComputedAt)}`}
                >
                  {tasks.length} task{tasks.length === 1 ? "" : "s"}
                </span>
              </div>
            ) : null}

            <span
              aria-live="polite"
              className={`text-xs font-medium text-emerald-600 transition-opacity duration-500 ${
                recomputedNote ? "opacity-100" : "opacity-0"
              }`}
            >
              ✓ CPM recomputed
            </span>
          </div>

          {detail === null && detailLoading ? (
            <Spinner />
          ) : detail === null ? (
            <EmptyState title="Schedule not found" hint="Pick another schedule above." />
          ) : (
            <>
              {/* --------------------------- main split --------------------------- */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                {/* LEFT — task table + dependency editor */}
                <div className="space-y-4 xl:col-span-5">
                  <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-ink-100">
                    <table className="min-w-full divide-y divide-ink-100 text-sm">
                      <thead>
                        <tr>
                          <Th className="w-8 px-2" />
                          <Th className="px-2">WBS</Th>
                          <Th>Task</Th>
                          <Th className="px-2 text-right">Dur</Th>
                          <Th className="px-2">Start</Th>
                          <Th className="px-2">Finish</Th>
                          <Th className="px-2 text-right">Float</Th>
                          <Th className="px-2 text-right">%</Th>
                          <Th className="w-20 px-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-100">
                        {tasks.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="px-4 py-8 text-center text-sm text-ink-400">
                              No tasks yet — add the first one below. Dates, float and the
                              critical path are computed for you.
                            </td>
                          </tr>
                        ) : null}
                        {tasks.map((t, i) => (
                          <SchedTaskRow
                            key={t.id}
                            task={t}
                            index={i}
                            last={i === tasks.length - 1}
                            selected={selectedTaskId === t.id}
                            expanded={expandedTaskId === t.id}
                            busy={busy}
                            onSelect={() => setSelectedTaskId(t.id)}
                            onToggleExpand={() =>
                              setExpandedTaskId((cur) => (cur === t.id ? null : t.id))
                            }
                            onPatch={(patch) => patchTask(t.id, patch)}
                            onDelete={() => void onDeleteTask(t)}
                            onMove={(d) => void moveTask(i, d)}
                          />
                        ))}
                        {/* add-task row */}
                        <tr className="bg-ink-50/50">
                          <td className="px-2 py-2 text-center text-ink-300">+</td>
                          <td className="px-2 py-2">
                            <Input
                              value={addWbs}
                              onChange={(e) => setAddWbs(e.target.value)}
                              placeholder="WBS"
                              aria-label="New task WBS code"
                              className="w-16 px-2 py-1 font-mono text-xs"
                            />
                          </td>
                          <td className="py-2 pr-2">
                            <Input
                              value={addName}
                              onChange={(e) => setAddName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void onAddTask();
                              }}
                              placeholder="New task name…"
                              aria-label="New task name"
                              className="px-2 py-1 text-sm"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <Input
                              type="number"
                              min={0}
                              step={1}
                              value={addDuration}
                              onChange={(e) => setAddDuration(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void onAddTask();
                              }}
                              aria-label="New task duration (days)"
                              className="w-14 px-2 py-1 text-right text-sm tabular-nums"
                            />
                          </td>
                          <td colSpan={4} className="px-2 py-2 text-xs text-ink-400">
                            0 = milestone
                          </td>
                          <td className="px-2 py-2 text-right">
                            <Button
                              size="sm"
                              disabled={busy || !addName.trim()}
                              onClick={() => void onAddTask()}
                            >
                              Add
                            </Button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* dependency editor for the selected task */}
                  <Card>
                    <CardBody className="space-y-3">
                      {selectedTask ? (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold text-ink-900">
                              Predecessors — {selectedTask.name}
                            </h3>
                            <span className="text-xs text-ink-400">
                              {predecessorDeps.length} link
                              {predecessorDeps.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          {depError ? (
                            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-100">
                              {depError}
                            </div>
                          ) : null}
                          {predecessorDeps.length === 0 ? (
                            <p className="text-xs text-ink-400">
                              No predecessors — this task starts at project start (or at its
                              constraint). Link it below to drive the network.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {predecessorDeps.map((d) => (
                                <DepEditorRow
                                  key={d.id}
                                  dep={d}
                                  candidates={tasks.filter((t) => t.id !== selectedTask.id)}
                                  busy={busy}
                                  onUpdate={(next) => void onUpdateDependency(d, next)}
                                  onRemove={() => void onRemoveDependency(d)}
                                />
                              ))}
                            </div>
                          )}
                          <form
                            onSubmit={onAddDependency}
                            className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3"
                          >
                            <div className="min-w-40 flex-1">
                              <Select
                                value={newDepPred}
                                aria-label="New predecessor task"
                                onChange={(e) => setNewDepPred(e.target.value)}
                                className="py-1.5 text-xs"
                              >
                                <option value="">Add predecessor…</option>
                                {tasks
                                  .filter((t) => t.id !== selectedTask.id)
                                  .map((t) => (
                                    <option key={t.id} value={t.id}>
                                      {t.wbsCode ? `${t.wbsCode} · ` : ""}
                                      {t.name}
                                    </option>
                                  ))}
                              </Select>
                            </div>
                            <div className="w-20">
                              <Select
                                value={newDepType}
                                aria-label="New dependency type"
                                onChange={(e) => setNewDepType(e.target.value)}
                                className="py-1.5 text-xs"
                              >
                                {DEPENDENCY_TYPES.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </Select>
                            </div>
                            <div className="w-20">
                              <Input
                                type="number"
                                step={1}
                                value={newDepLag}
                                aria-label="New dependency lag (days)"
                                onChange={(e) => setNewDepLag(e.target.value)}
                                className="py-1.5 text-right text-xs tabular-nums"
                              />
                            </div>
                            <span className="text-[11px] text-ink-400">d lag</span>
                            <Button type="submit" size="sm" disabled={busy || !newDepPred}>
                              Link
                            </Button>
                          </form>
                          <p className="text-[11px] text-ink-400">
                            FS finish→start · SS start→start · FF finish→finish · SF start→finish.
                            Negative lag = lead. Links that would create a cycle are rejected.
                          </p>
                        </>
                      ) : (
                        <p className="py-2 text-center text-xs text-ink-400">
                          Select a task (table row or Gantt bar) to edit its predecessors.
                        </p>
                      )}
                    </CardBody>
                  </Card>
                </div>

                {/* RIGHT — Gantt */}
                <div className="xl:col-span-7">
                  <Card>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
                      <h3 className="text-sm font-semibold text-ink-900">Gantt</h3>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-ink-400">Baseline overlay</span>
                        <div className="w-52">
                          <Select
                            value={selectedBaselineId}
                            aria-label="Baseline overlay"
                            onChange={(e) => setSelectedBaselineId(e.target.value)}
                            className="py-1.5 text-xs"
                            disabled={!baselines || baselines.length === 0}
                          >
                            <option value="">
                              {baselines && baselines.length > 0 ? "None" : "No baselines yet"}
                            </option>
                            {(baselines ?? []).map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </div>
                    </div>
                    {tasks.length === 0 ? (
                      <div className="p-6">
                        <EmptyState
                          title="Nothing to draw yet"
                          hint="Add tasks on the left — bars appear here as soon as the CPM engine has dates."
                        />
                      </div>
                    ) : (
                      <GanttSvg
                        tasks={tasks}
                        projectStart={detail.projectStart}
                        computedFinish={detail.computedFinish}
                        baseline={baselineMap}
                        baselineName={baselineDetail?.name ?? null}
                        selectedTaskId={selectedTaskId}
                        onSelectTask={(id) =>
                          setSelectedTaskId((cur) => (cur === id ? null : id))
                        }
                      />
                    )}
                  </Card>
                </div>
              </div>

              {/* --------------------------- panels --------------------------- */}
              <div className="mt-6 mb-4 flex flex-wrap gap-1 border-b border-ink-200">
                {panels.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPanel(p.key)}
                    className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                      panel === p.key
                        ? "border-brand-600 text-brand-700"
                        : "border-transparent text-ink-500 hover:text-ink-800"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* ------------------------- baseline compare ------------------------- */}
              {panel === "compare" ? (
                baselines === null ? (
                  <Spinner />
                ) : baselines.length === 0 ? (
                  <EmptyState
                    title="No baselines captured"
                    hint="Capture the as-planned programme so slippage can be measured against it — the immutable record delay forensics runs on."
                    action={
                      <Button
                        disabled={tasks.length === 0}
                        onClick={() => setBaselineOpen(true)}
                      >
                        Capture a baseline
                      </Button>
                    }
                  />
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="w-72">
                        <Select
                          value={selectedBaselineId}
                          aria-label="Baseline to compare"
                          onChange={(e) => setSelectedBaselineId(e.target.value)}
                        >
                          <option value="">Select a baseline…</option>
                          {baselines.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name} — {formatDateTime(b.capturedAt)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <span className="text-xs text-ink-400">
                        The selected baseline also draws ghost bars on the Gantt.
                      </span>
                    </div>

                    {compareLoading ? <Spinner label="Comparing…" /> : null}
                    {!compareLoading && selectedBaselineId && compare ? (
                      <>
                        <div
                          className={`rounded-md px-4 py-3 text-sm ring-1 ${
                            compare.header.completionMovementDays === null
                              ? "bg-ink-50 text-ink-600 ring-ink-200"
                              : compare.header.completionMovementDays > 0
                                ? "bg-red-50 text-red-800 ring-red-200"
                                : "bg-emerald-50 text-emerald-800 ring-emerald-200"
                          }`}
                        >
                          {compare.header.completionMovementDays === null ? (
                            <>Completion movement cannot be computed for this baseline.</>
                          ) : compare.header.completionMovementDays > 0 ? (
                            <>
                              <strong>
                                Completion slipped +{compare.header.completionMovementDays} days
                              </strong>{" "}
                              — {formatDate(compare.header.baselineFinish)} →{" "}
                              {formatDate(compare.header.currentFinish)}
                            </>
                          ) : compare.header.completionMovementDays < 0 ? (
                            <>
                              <strong>
                                Completion improved {compare.header.completionMovementDays} days
                              </strong>{" "}
                              — {formatDate(compare.header.baselineFinish)} →{" "}
                              {formatDate(compare.header.currentFinish)}
                            </>
                          ) : (
                            <>
                              <strong>Completion on plan</strong> —{" "}
                              {formatDate(compare.header.currentFinish)}
                            </>
                          )}
                        </div>

                        <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-ink-100">
                          <table className="min-w-full divide-y divide-ink-100 text-sm">
                            <thead>
                              <tr>
                                <Th>Task</Th>
                                <Th>Baseline</Th>
                                <Th>Current</Th>
                                <Th>Start var</Th>
                                <Th>Finish var</Th>
                                <Th className="text-right">Float Δ</Th>
                                <Th>Flags</Th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-ink-100">
                              {(compareItems ?? []).map((it) => (
                                <tr key={it.taskId} className="hover:bg-ink-50/60">
                                  <td className="px-4 py-2 font-medium text-ink-800">
                                    {it.name}
                                  </td>
                                  <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                                    {shortDate(it.baselineStart)} → {shortDate(it.baselineFinish)}
                                  </td>
                                  <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                                    {shortDate(it.currentStart)} → {shortDate(it.currentFinish)}
                                  </td>
                                  <td className="px-4 py-2">
                                    {varianceBadge(it.startVarianceDays)}
                                  </td>
                                  <td className="px-4 py-2">
                                    {varianceBadge(it.finishVarianceDays)}
                                  </td>
                                  <td className="px-4 py-2 text-right tabular-nums">
                                    {it.floatChange ?? "—"}
                                  </td>
                                  <td className="space-x-1 whitespace-nowrap px-4 py-2">
                                    {it.added ? <Badge tone="blue">added</Badge> : null}
                                    {it.removed ? <Badge tone="gray">removed</Badge> : null}
                                    {it.becameCritical ? (
                                      <Badge tone="red">became critical</Badge>
                                    ) : null}
                                    {it.droppedCritical ? (
                                      <Badge tone="green">left critical path</Badge>
                                    ) : null}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : null}
                    {!compareLoading && !selectedBaselineId ? (
                      <EmptyState
                        title="Pick a baseline"
                        hint="Select a baseline above to see completion movement and per-task variances."
                      />
                    ) : null}
                  </div>
                )
              ) : null}

              {/* ----------------------------- lookahead ----------------------------- */}
              {panel === "lookahead" ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="inline-flex overflow-hidden rounded-md ring-1 ring-ink-200">
                      {([3, 6] as const).map((w) => (
                        <button
                          key={w}
                          type="button"
                          onClick={() => setWeeks(w)}
                          className={`px-3 py-1.5 text-sm font-medium ${
                            weeks === w
                              ? "bg-brand-600 text-white"
                              : "bg-white text-ink-600 hover:bg-ink-50"
                          }`}
                        >
                          {w} weeks
                        </button>
                      ))}
                    </div>
                    {lookahead ? (
                      <span className="text-xs text-ink-400">
                        {formatDate(lookahead.from)} → {formatDate(lookahead.to)} ·{" "}
                        {lookahead.total} task{lookahead.total === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  {lookaheadLoading ? (
                    <Spinner />
                  ) : lookahead === null ? (
                    <EmptyState
                      title="Lookahead unavailable"
                      hint="The lookahead window could not be loaded."
                    />
                  ) : lookahead.items.length === 0 ? (
                    <EmptyState
                      title="Nothing in the window"
                      hint="No incomplete task starts or finishes inside the lookahead window."
                    />
                  ) : (
                    <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-ink-100">
                      <table className="min-w-full divide-y divide-ink-100 text-sm">
                        <thead>
                          <tr>
                            <Th>WBS</Th>
                            <Th>Task</Th>
                            <Th>Start</Th>
                            <Th>Finish</Th>
                            <Th className="text-right">Dur</Th>
                            <Th className="text-right">Float</Th>
                            <Th className="text-right">%</Th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {lookahead.items.map((t) => (
                            <tr
                              key={t.id}
                              className="cursor-pointer hover:bg-ink-50/60"
                              onClick={() => setSelectedTaskId(t.id)}
                            >
                              <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-500">
                                {t.wbsCode ?? "—"}
                              </td>
                              <td className="px-4 py-2 font-medium text-ink-800">
                                {t.name}{" "}
                                {t.isCritical === 1 ? <Badge tone="red">critical</Badge> : null}{" "}
                                {t.durationDays === 0 ? (
                                  <Badge tone="violet">milestone</Badge>
                                ) : null}
                              </td>
                              <td className="whitespace-nowrap px-4 py-2">
                                {formatDate(t.startDate)}
                              </td>
                              <td className="whitespace-nowrap px-4 py-2">
                                {formatDate(t.finishDate)}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums">
                                {t.durationDays}d
                              </td>
                              <td
                                className={`px-4 py-2 text-right tabular-nums ${
                                  (t.totalFloat ?? 0) < 0 ? "font-semibold text-red-600" : ""
                                }`}
                              >
                                {t.totalFloat ?? "—"}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums">
                                {Math.round(t.percentComplete)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : null}

              {/* ------------------------------ health ------------------------------ */}
              {panel === "health" ? (
                <QualityPanel
                  report={quality}
                  loading={qualityLoading}
                  tasks={tasks}
                  deps={deps}
                  onSelectTask={(id) => {
                    setSelectedTaskId(id);
                    setExpandedTaskId(id);
                  }}
                />
              ) : null}
            </>
          )}
        </>
      )}

      {/* ------------------------------ modals ------------------------------ */}

      <Modal open={createOpen} title="New schedule" onClose={() => setCreateOpen(false)}>
        <ErrorAlert message={modalError} />
        <form onSubmit={onCreateSchedule} className="space-y-4">
          <Field label="Schedule name">
            <Input
              required
              value={schedName}
              onChange={(e) => setSchedName(e.target.value)}
              placeholder="Master construction programme"
            />
          </Field>
          <Field label="Project start (CPM day 0)">
            <Input
              required
              type="date"
              value={schedStart}
              onChange={(e) => setSchedStart(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create schedule"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={baselineOpen} title="Capture baseline" onClose={() => setBaselineOpen(false)}>
        <ErrorAlert message={modalError} />
        <form onSubmit={onCaptureBaseline} className="space-y-4">
          <Field
            label="Baseline name"
            hint="Recomputes first, then snapshots every task's dates, float and criticality — an immutable as-planned record."
          >
            <Input
              required
              value={baselineName}
              onChange={(e) => setBaselineName(e.target.value)}
              placeholder="Contract baseline"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setBaselineOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Capturing…" : "Capture"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Task table row                                                      */
/* ------------------------------------------------------------------ */

function SchedTaskRow({
  task: t,
  index,
  last,
  selected,
  expanded,
  busy,
  onSelect,
  onToggleExpand,
  onPatch,
  onDelete,
  onMove,
}: {
  task: TaskRow;
  index: number;
  last: boolean;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  onPatch: (patch: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  return (
    <>
      <tr
        onClick={onSelect}
        className={`cursor-pointer ${selected ? "bg-brand-50/70" : "hover:bg-ink-50/60"}`}
      >
        <td className="px-2 py-1.5 text-center">
          <button
            type="button"
            aria-label={expanded ? `Collapse ${t.name}` : `Expand ${t.name}`}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            className="rounded px-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          >
            {expanded ? "▾" : "▸"}
          </button>
        </td>
        <td className="w-16 px-1 py-1.5">
          <InlineText
            value={t.wbsCode ?? ""}
            label={`WBS code of ${t.name}`}
            placeholder="—"
            mono
            onCommit={(v) => void onPatch({ wbsCode: v || null })}
          />
        </td>
        <td className="min-w-40 py-1.5 pr-1">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                t.isCritical === 1 ? "bg-red-600" : "bg-ink-200"
              }`}
              title={t.isCritical === 1 ? "On the critical path" : "Not critical"}
            />
            <InlineText
              value={t.name}
              label={`Name of task ${index + 1}`}
              required
              onCommit={(v) => void onPatch({ name: v })}
            />
            {t.durationDays === 0 ? (
              <span className="shrink-0 text-[10px] text-violet-600" title="Milestone">
                ◆
              </span>
            ) : null}
            {t.constraintType && t.constraintType !== "asap" ? (
              <span
                className="shrink-0 text-xs text-amber-600"
                title={`${humanize(t.constraintType)} ${formatDate(t.constraintDate)}`}
              >
                ⚓
              </span>
            ) : null}
          </span>
        </td>
        <td className="px-1 py-1.5 text-right">
          <InlineNumber
            value={t.durationDays}
            min={0}
            max={10000}
            label={`Duration of ${t.name} (days)`}
            onCommit={(v) => void onPatch({ durationDays: v })}
          />
        </td>
        <td
          className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-600"
          title={formatDate(t.actualStart ?? t.startDate)}
        >
          {shortDate(t.actualStart ?? t.startDate)}
          {t.actualStart ? <span className="ml-0.5 font-semibold text-emerald-600">A</span> : null}
        </td>
        <td
          className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-600"
          title={formatDate(t.actualFinish ?? t.finishDate)}
        >
          {shortDate(t.actualFinish ?? t.finishDate)}
          {t.actualFinish ? (
            <span className="ml-0.5 font-semibold text-emerald-600">A</span>
          ) : null}
        </td>
        <td
          className={`px-2 py-1.5 text-right text-xs tabular-nums ${
            (t.totalFloat ?? 0) < 0 ? "font-semibold text-red-600" : "text-ink-600"
          }`}
        >
          {t.totalFloat ?? "—"}
        </td>
        <td className="px-1 py-1.5 text-right">
          <InlineNumber
            value={Math.round(t.percentComplete)}
            min={0}
            max={100}
            className="w-12"
            label={`Percent complete of ${t.name}`}
            onCommit={(v) => void onPatch({ percentComplete: v })}
          />
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 text-right">
          <button
            type="button"
            className="px-0.5 text-ink-300 hover:text-ink-700 disabled:opacity-30"
            disabled={index === 0 || busy}
            onClick={(e) => {
              e.stopPropagation();
              onMove(-1);
            }}
            aria-label={`Move ${t.name} up`}
          >
            ↑
          </button>
          <button
            type="button"
            className="px-0.5 text-ink-300 hover:text-ink-700 disabled:opacity-30"
            disabled={last || busy}
            onClick={(e) => {
              e.stopPropagation();
              onMove(1);
            }}
            aria-label={`Move ${t.name} down`}
          >
            ↓
          </button>
          <button
            type="button"
            className="ml-1 px-0.5 text-ink-300 hover:text-red-600 disabled:opacity-30"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={`Delete ${t.name}`}
          >
            ✕
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={9} className="p-0">
            <TaskDetailsEditor task={t} busy={busy} onSave={onPatch} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
