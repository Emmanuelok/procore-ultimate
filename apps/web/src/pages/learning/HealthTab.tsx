/**
 * Learning health (#976-979) — the company's honest scorecard.
 *
 * The headline is deliberately NOT the lesson count. A register can be fat
 * with documents nobody ever used; what this tab reports instead is
 *
 *   · whether mandatory capture is actually being discharged (capture rate),
 *   · how old the open-trigger backlog has been allowed to get, and
 *   · how many published lessons have never once been applied.
 *
 * Every figure is the server's; every note it sends is rendered verbatim.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, EmptyState, Spinner, Table, Td, Th } from "../../ui";
import { formatDate } from "../format";
import { BacklogAgeChart, StackedBar } from "./charts";
import type { BarSegment } from "./charts";
import {
  AGE_BUCKETS,
  KV,
  LoadError,
  NoteCard,
  SectionTitle,
  Stat,
  errorMessage,
  fmtInt,
  fmtPercent,
  impactLabel,
  label,
  lessonStatusTone,
  projectNameOf,
} from "./learningShared";
import type { LearningSummary, ProjectRow } from "./learningShared";

const STATUS_COLOR: Record<string, string> = {
  draft: "#d97706",
  submitted: "#7c3aed",
  validated: "#1d60f1",
  published: "#059669",
  superseded: "#7f8ea4",
  rejected: "#dc2626",
};

/** Plain words for the backlog, derived from the same numbers as the chart. */
function backlogVerdict(summary: LearningSummary): { tone: "bad" | "warn" | "good"; text: string } {
  const { openByAge, open, oldestOpenDays } = summary.triggers;
  const stale = (openByAge["31-90"] ?? 0) + (openByAge["90+"] ?? 0);
  const ancient = openByAge["90+"] ?? 0;
  if (open === 0) {
    return {
      tone: "good",
      text: "No capture trigger is open. Every event that made a lesson mandatory has been discharged by a lesson or explicitly dismissed with a reason.",
    };
  }
  if (ancient > 0) {
    return {
      tone: "bad",
      text: `${fmtInt(ancient)} capture trigger${ancient === 1 ? " has" : "s have"} been open for more than ninety days${
        oldestOpenDays === null ? "" : ` (the oldest for ${fmtInt(oldestOpenDays)} days)`
      }. Each one is an obligation raised by a real event — a dispute closed, a claim settled, a variation over threshold — that nobody has written up. This is what a lessons register looks like just before it stops being believed.`,
    };
  }
  if (stale > 0) {
    return {
      tone: "warn",
      text: `${fmtInt(stale)} capture trigger${stale === 1 ? " is" : "s are"} more than a month old. The people who were in the room are already forgetting the detail that makes a lesson worth writing.`,
    };
  }
  return {
    tone: "warn",
    text: `${fmtInt(open)} capture trigger${open === 1 ? " is" : "s are"} open and none has aged past a month. Discharge them while the events are still fresh.`,
  };
}

export default function HealthTab({
  projects,
  onInspectLesson,
  onOpenProjectTriggers,
}: {
  projects: ProjectRow[] | null;
  onInspectLesson: (lessonId: string) => void;
  onOpenProjectTriggers: (projectId: string) => void;
}) {
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSummary(await api.get<LearningSummary>("/api/v1/learning/summary"));
    } catch (err) {
      setSummary(null);
      setError(errorMessage(err, "Failed to load the learning summary"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (summary === null) return <Spinner label="Loading learning health…" />;

  const verdict = backlogVerdict(summary);
  const captureSegments: BarSegment[] = [
    {
      key: "discharged",
      label: "Discharged by a lesson",
      value: summary.captureRate.discharged,
      color: "#059669",
    },
    { key: "dismissed", label: "Dismissed with a reason", value: summary.captureRate.dismissed, color: "#7f8ea4" },
    { key: "open", label: "Still open", value: summary.captureRate.open, color: "#dc2626" },
  ];
  const statusSegments: BarSegment[] = Object.entries(summary.lessons.byStatus).map(([k, v]) => ({
    key: k,
    label: label(k),
    value: v,
    color: STATUS_COLOR[k] ?? "#7f8ea4",
  }));
  const kinds = Object.entries(summary.triggers.byKind).sort((a, b) => b[1] - a[1]);
  const neverApplied = summary.publishedNeverApplied;

  return (
    <div className="space-y-5">
      {/* --------------------------- headline stats --------------------------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Capture rate"
          value={fmtPercent(summary.captureRate.percent)}
          hint={`${fmtInt(summary.captureRate.discharged)} of ${fmtInt(summary.captureRate.raised)} triggers`}
          tone={
            summary.captureRate.percent === null
              ? "default"
              : summary.captureRate.percent >= 80
                ? "good"
                : "bad"
          }
        />
        <Stat
          label="Open triggers"
          value={fmtInt(summary.triggers.open)}
          hint="obligations awaiting a lesson"
          tone={summary.triggers.open > 0 ? "bad" : "good"}
        />
        <Stat
          label="Oldest open"
          value={summary.triggers.oldestOpenDays === null ? "—" : `${fmtInt(summary.triggers.oldestOpenDays)}d`}
          hint="days since the event"
          tone={
            summary.triggers.oldestOpenDays !== null && summary.triggers.oldestOpenDays > 30
              ? "bad"
              : "default"
          }
        />
        <Stat
          label="Published lessons"
          value={fmtInt(summary.lessons.published)}
          hint={`${fmtInt(summary.lessons.total)} in the register overall`}
        />
        <Stat
          label="Applications"
          value={fmtInt(summary.applications.total)}
          hint="lessons put to work on a record"
        />
        <Stat
          label="Crossed a project"
          value={fmtInt(summary.applications.crossProject)}
          hint="applied away from where it was learned"
          tone={
            summary.applications.total > 0 && summary.applications.crossProject === 0
              ? "bad"
              : summary.applications.crossProject > 0
                ? "good"
                : "default"
          }
        />
      </div>

      {/* ------------------------------ capture rate -------------------------- */}
      <Card>
        <CardBody>
          <SectionTitle hint="Mandatory capture is only real if the obligations it raises get discharged.">
            Capture rate
          </SectionTitle>
          <div className="mb-3 flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-bold tabular-nums text-ink-900">
              {fmtPercent(summary.captureRate.percent)}
            </span>
            <span className="text-sm text-ink-500">
              {fmtInt(summary.captureRate.discharged)} discharged of {fmtInt(summary.captureRate.raised)}{" "}
              raised
            </span>
          </div>
          <StackedBar segments={captureSegments} emptyLabel="No capture trigger has ever been raised" />
          <div className="mt-3">
            <NoteCard note={summary.captureRate.note} tone="ink" />
          </div>
        </CardBody>
      </Card>

      {/* --------------------------- backlog by age --------------------------- */}
      <Card>
        <CardBody>
          <SectionTitle hint="Open triggers by how long they have been open. Every bar is an event nobody has written up yet.">
            The capture backlog, aged
          </SectionTitle>
          <BacklogAgeChart
            buckets={summary.triggers.openByAge}
            oldestOpenDays={summary.triggers.oldestOpenDays}
          />
          <div className="mt-3">
            <NoteCard
              note={verdict.text}
              tone={verdict.tone === "bad" ? "red" : verdict.tone === "warn" ? "amber" : "brand"}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-ink-500">
            {AGE_BUCKETS.map((b) => (
              <span key={b}>
                <span className="font-semibold tabular-nums text-ink-800">
                  {fmtInt(summary.triggers.openByAge[b] ?? 0)}
                </span>{" "}
                open at {b} days
              </span>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* ------------------------- oldest open triggers ----------------------- */}
      <Card>
        <CardBody>
          <SectionTitle hint="The five that have waited longest. Named, so nobody can say they did not know.">
            Oldest open triggers
          </SectionTitle>
          {summary.triggers.oldestOpen.length === 0 ? (
            <p className="py-4 text-sm text-ink-500">
              Nothing is open. The backlog is empty — which is the only good state for this list.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Age</Th>
                  <Th>Kind</Th>
                  <Th>Project</Th>
                  <Th>Why capture became mandatory</Th>
                  <Th>Due</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {summary.triggers.oldestOpen.map((t) => (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap">
                      <span
                        className={
                          t.ageDays > 90
                            ? "font-bold tabular-nums text-red-700"
                            : t.ageDays > 30
                              ? "font-semibold tabular-nums text-orange-700"
                              : "tabular-nums text-ink-800"
                        }
                      >
                        {fmtInt(t.ageDays)}d
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Badge tone="amber">{label(t.kind)}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{projectNameOf(projects, t.projectId)}</Td>
                    <Td className="max-w-md text-xs text-ink-600">{t.rationale}</Td>
                    <Td className="whitespace-nowrap text-xs">{formatDate(t.dueAt)}</Td>
                    <Td className="whitespace-nowrap">
                      <Button size="sm" variant="secondary" onClick={() => onOpenProjectTriggers(t.projectId)}>
                        Open backlog
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* --------------------- published but never applied --------------------- */}
      <Card className={neverApplied.count > 0 ? "ring-2 ring-red-200" : undefined}>
        <CardBody>
          <SectionTitle hint="A published lesson nobody has applied is a document, not a change in practice.">
            Published but never applied
          </SectionTitle>
          <div className="mb-3 flex flex-wrap items-baseline gap-3">
            <span
              className={`text-3xl font-bold tabular-nums ${
                neverApplied.count > 0 ? "text-red-700" : "text-emerald-700"
              }`}
            >
              {fmtInt(neverApplied.count)}
            </span>
            <span className="text-sm text-ink-500">
              {neverApplied.percentOfPublished === null
                ? "no published lessons yet"
                : `${fmtPercent(neverApplied.percentOfPublished)} of the ${fmtInt(
                    summary.lessons.published,
                  )} published lessons have never been applied to a single record`}
            </span>
          </div>
          {neverApplied.lessons.length === 0 ? (
            <p className="text-sm text-ink-500">
              {summary.lessons.published === 0
                ? "Nothing is published yet, so nothing can have been applied."
                : "Every published lesson has been applied at least once."}
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Lesson</Th>
                  <Th>Category</Th>
                  <Th>Recorded impact</Th>
                  <Th>Published</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {neverApplied.lessons.map((l) => (
                  <tr key={l.lessonId}>
                    <Td>
                      <span className="font-mono text-xs text-ink-500">{l.number}</span>{" "}
                      <span className="font-medium text-ink-900">{l.title}</span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Badge tone="blue">{label(l.category)}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      {impactLabel(l.impactValue, l.impactCurrency, null)}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{formatDate(l.publishedAt)}</Td>
                    <Td className="whitespace-nowrap">
                      <Button size="sm" variant="secondary" onClick={() => onInspectLesson(l.lessonId)}>
                        Inspect
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {neverApplied.count > neverApplied.lessons.length ? (
            <p className="mt-2 text-xs text-ink-400">
              Showing the {fmtInt(neverApplied.lessons.length)} highest-impact of{" "}
              {fmtInt(neverApplied.count)}. The register tab lists them all.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------------ most applied -------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <SectionTitle hint="The lessons that actually changed what somebody did.">
              Most applied
            </SectionTitle>
            {summary.mostApplied.length === 0 ? (
              <EmptyState
                title="No lesson has ever been applied"
                hint="Applications are recorded against a specific later record. Until one exists, the platform has no evidence that any lesson changed practice."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Lesson</Th>
                    <Th>Applications</Th>
                    <Th>Projects</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {summary.mostApplied.map((l) => (
                    <tr key={l.lessonId}>
                      <Td>
                        <span className="font-mono text-xs text-ink-500">{l.number}</span>{" "}
                        <span className="font-medium text-ink-900">{l.title}</span>
                        <div className="mt-0.5">
                          <Badge tone="blue">{label(l.category)}</Badge>
                        </div>
                      </Td>
                      <Td className="tabular-nums font-semibold">{fmtInt(l.applications)}</Td>
                      <Td className="tabular-nums">{fmtInt(l.projects)}</Td>
                      <Td>
                        <Button size="sm" variant="secondary" onClick={() => onInspectLesson(l.lessonId)}>
                          Inspect
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardBody>
              <SectionTitle hint="Where the register sits in its own lifecycle. Only published lessons are retrievable or applicable.">
                Lessons by status
              </SectionTitle>
              <StackedBar segments={statusSegments} emptyLabel="No lesson has been captured yet" />
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(summary.lessons.byStatus).map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1">
                    <Badge tone={lessonStatusTone(k)}>{label(k)}</Badge>
                    <span className="text-xs font-semibold tabular-nums text-ink-700">{fmtInt(v)}</span>
                  </span>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <SectionTitle hint="Which rules have fired, ever — capture is driven by records other modules already write.">
                Triggers by kind
              </SectionTitle>
              {kinds.length === 0 ? (
                <p className="text-sm text-ink-500">
                  No trigger of any kind has been raised. Run a sweep from the Triggers tab against a
                  project to find out whether that is true or simply unscanned.
                </p>
              ) : (
                <div className="space-y-0.5">
                  {kinds.map(([kind, n]) => (
                    <KV key={kind} k={label(kind)} v={<span className="tabular-nums">{fmtInt(n)}</span>} />
                  ))}
                  <KV
                    k="Raised total"
                    v={<span className="font-semibold tabular-nums">{fmtInt(summary.triggers.raised)}</span>}
                  />
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
