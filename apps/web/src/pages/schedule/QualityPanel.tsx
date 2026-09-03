/**
 * Schedule health — DCMA 14-point-style metric cards with pass/fail badges,
 * failing-task chips (click to select the task in the workspace) and an
 * overall score ring.
 */
import { Badge, Card, CardBody, EmptyState, Spinner } from "../../ui";
import type { DepRow, QualityReport, TaskRow } from "./types";

const CHECK_LABELS: Record<string, string> = {
  missingPredecessors: "Missing predecessors",
  missingSuccessors: "Missing successors",
  leads: "Leads (negative lag)",
  lags: "Positive lags",
  fsRatio: "Finish-to-start ratio",
  hardConstraints: "Hard constraints",
  highFloat: "High float",
  negativeFloat: "Negative float",
  highDuration: "High duration",
  invalidProgress: "Invalid progress",
  invalidDates: "Invalid dates vs data date",
  resources: "Resource loading",
  missedTasks: "Missed tasks",
  criticalPathTest: "Critical path test",
  cpli: "Critical path length index",
  bei: "Baseline execution index",
};

function labelForKey(key: string): string {
  const known = CHECK_LABELS[key];
  if (known) return known;
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function ScoreRing({ score }: { score: number }) {
  const pct = Math.min(1, Math.max(0, score));
  const r = 40;
  const c = 2 * Math.PI * r;
  const color = pct >= 0.8 ? "#10b981" : pct >= 0.5 ? "#f59e0b" : "#dc2626";
  return (
    <svg width={104} height={104} viewBox="0 0 104 104" role="img" aria-label="Health score">
      <circle cx={52} cy={52} r={r} fill="none" stroke="#ebedf1" strokeWidth={10} />
      <circle
        cx={52}
        cy={52}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={10}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform="rotate(-90 52 52)"
      />
      <text
        x={52}
        y={58}
        textAnchor="middle"
        fontSize={22}
        fontWeight={600}
        fill={color}
      >
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

const MAX_CHIPS = 6;

export interface QualityPanelProps {
  report: QualityReport | null;
  loading: boolean;
  tasks: TaskRow[];
  deps: DepRow[];
  onSelectTask: (id: string) => void;
}

export default function QualityPanel({
  report,
  loading,
  tasks,
  deps,
  onSelectTask,
}: QualityPanelProps) {
  if (loading) return <Spinner label="Assessing schedule health…" />;
  if (!report) {
    return (
      <EmptyState
        title="Health check unavailable"
        hint="The quality report could not be loaded for this schedule."
      />
    );
  }

  const taskById = new Map(tasks.map((t) => [t.id, t] as const));
  const depById = new Map(deps.map((d) => [d.id, d] as const));
  const taskLabel = (id: string) => {
    const t = taskById.get(id);
    return t ? `${t.wbsCode ? `${t.wbsCode} ` : ""}${t.name}` : id;
  };
  const depLabel = (id: string) => {
    const d = depById.get(id);
    if (!d) return id;
    const p = taskById.get(d.predecessorId)?.name ?? d.predecessorId;
    const s = taskById.get(d.successorId)?.name ?? d.successorId;
    return `${p} → ${s} (${d.depType}${d.lagDays ? `${d.lagDays > 0 ? "+" : ""}${d.lagDays}` : ""})`;
  };

  const allChecks = Object.entries(report.checks ?? {});
  // A check that could not run is neither a pass nor a fail: it is reported
  // separately so the score is never computed over checks that never ran.
  const checks = allChecks.filter(([, c]) => c.applicable !== false);
  const skipped = allChecks.filter(([, c]) => c.applicable === false);
  const passed = report.passed ?? checks.filter(([, c]) => c.pass).length;
  const total = report.total ?? checks.length;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center gap-6 py-4">
          <ScoreRing score={report.score} />
          <div className="space-y-1">
            <div className="text-sm font-semibold text-ink-900">
              {passed} of {total} DCMA-style checks passed
            </div>
            <div className="text-xs text-ink-500">
              {report.taskCount} task{report.taskCount === 1 ? "" : "s"} ·{" "}
              {report.dependencyCount} dependenc{report.dependencyCount === 1 ? "y" : "ies"}
              {report.criticalPercent !== undefined ? (
                <>
                  {" "}
                  · {Math.round(report.criticalPercent * 100)}% of tasks on the critical path
                </>
              ) : null}
              {report.dataDate ? <> · data date {report.dataDate}</> : null}
              {report.baselineName ? <> · baseline “{report.baselineName}”</> : null}
            </div>
            <div className="text-xs text-ink-400">
              A defensible programme is the substrate for delay forensics — fix the failing
              checks before capturing a contract baseline.
            </div>
          </div>
        </CardBody>
      </Card>

      {checks.length === 0 ? (
        <EmptyState title="No checks returned" hint="Add tasks to run the health assessment." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {checks.map(([key, c]) => {
            const ids = c.ids ?? [];
            const shown = ids.slice(0, MAX_CHIPS);
            return (
              <Card key={key} className={c.pass ? "" : "ring-red-200"}>
                <CardBody className="space-y-2 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink-900">{labelForKey(key)}</span>
                    {c.pass ? <Badge tone="green">pass</Badge> : <Badge tone="red">fail</Badge>}
                  </div>
                  {c.threshold ? (
                    <div className="text-xs text-ink-400">{c.threshold}</div>
                  ) : null}
                  <div className="text-xs text-ink-600">
                    {c.value !== undefined && c.value !== null ? (
                      <>
                        {labelForKey(key).toLowerCase().includes("index")
                          ? c.value
                          : `${c.value}`}
                        {c.count > 0 ? " · " : null}
                      </>
                    ) : null}
                    {c.count} offender{c.count === 1 ? "" : "s"}
                    {c.ratio !== undefined && c.ratio !== null ? (
                      <> · {Math.round(c.ratio * 1000) / 10}%</>
                    ) : null}
                  </div>
                  {c.basis ? <div className="text-[11px] text-ink-400">{c.basis}</div> : null}
                  {shown.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {shown.map((id) =>
                        taskById.has(id) ? (
                          <button
                            key={id}
                            type="button"
                            onClick={() => onSelectTask(id)}
                            className="max-w-full truncate rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-700 ring-1 ring-red-100 hover:bg-red-100"
                            title={taskLabel(id)}
                          >
                            {taskLabel(id)}
                          </button>
                        ) : (
                          <span
                            key={id}
                            className="max-w-full truncate rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-600"
                            title={depLabel(id)}
                          >
                            {depLabel(id)}
                          </span>
                        ),
                      )}
                      {ids.length > MAX_CHIPS ? (
                        <span className="rounded-full px-1.5 py-0.5 text-[11px] text-ink-400">
                          +{ids.length - MAX_CHIPS} more
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {skipped.length > 0 ? (
        <Card>
          <CardBody className="space-y-2 py-3">
            <div className="text-sm font-medium text-ink-900">
              {skipped.length} check{skipped.length === 1 ? "" : "s"} could not run
            </div>
            <div className="text-xs text-ink-400">
              These are excluded from the score rather than counted as failures — a score over
              checks that never ran would misdescribe the programme.
            </div>
            <ul className="space-y-1">
              {skipped.map(([key, c]) => (
                <li key={key} className="text-xs text-ink-600">
                  <span className="font-medium text-ink-800">{labelForKey(key)}</span>
                  {c.basis ? <> — {c.basis}</> : null}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
