/**
 * Retrieval bound to the moment (#978, #983-987) — the module's differentiator.
 *
 * A lessons register with a search box is a register nobody reads. This panel
 * asks what you are doing right now (which tool, which category, which phase,
 * which tags) and ranks the published register against it — and every hit
 * carries the reasons it scored, with the points each reason contributed.
 *
 * The ranking being arguable is the feature, so the server's own description
 * of it is rendered verbatim underneath.
 */
import { useCallback, useState } from "react";
import { LESSON_CATEGORIES, TOOLS } from "@constructos/shared";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, Field, Input, Select, Spinner } from "../../ui";
import { formatDate } from "../format";
import ApplyModal from "./ApplyModal";
import type { ApplyOutcome } from "./ApplyModal";
import {
  NoteCard,
  REASON_LABEL,
  SectionTitle,
  TagList,
  errorMessage,
  fmtInt,
  impactLabel,
  label,
  parseTags,
} from "./learningShared";
import type { Lesson, ProjectRow, RelevantResponse } from "./learningShared";

export default function RelevantPanel({
  projectId,
  projects,
  onInspect,
  onApplied,
}: {
  projectId: string;
  projects: ProjectRow[] | null;
  onInspect: (lessonId: string) => void;
  onApplied: () => void;
}) {
  const [tool, setTool] = useState("");
  const [category, setCategory] = useState("");
  const [phase, setPhase] = useState("");
  const [tags, setTags] = useState("");
  const [limit, setLimit] = useState("10");

  const [result, setResult] = useState<RelevantResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyFor, setApplyFor] = useState<Lesson | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams();
      if (tool) params.set("tool", tool);
      if (category) params.set("category", category);
      if (phase.trim()) params.set("phase", phase.trim());
      const t = parseTags(tags);
      if (t.length > 0) params.set("tags", t.join(","));
      params.set("limit", limit);
      setResult(
        await api.get<RelevantResponse>(
          `/api/v1/projects/${projectId}/learning/relevant?${params.toString()}`,
        ),
      );
    } catch (err) {
      setResult(null);
      setError(errorMessage(err, "Failed to retrieve relevant lessons"));
    } finally {
      setLoading(false);
    }
  }, [projectId, tool, category, phase, tags, limit]);

  function applied(outcome: ApplyOutcome) {
    setApplyFor(null);
    setNotice(
      outcome.crossedProjectBoundary
        ? "Application recorded — the lesson crossed a project boundary. That is the only evidence the platform can offer that knowledge travelled."
        : "Application recorded on the lesson's own origin project. It counts as use, but not as the knowledge crossing a project boundary.",
    );
    onApplied();
    void run();
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionTitle hint="Describe the work in hand. The register is ranked against it deterministically, and every hit shows why it surfaced.">
          Relevant lessons — retrieval bound to the moment
        </SectionTitle>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Tool" hint="What you are working in.">
            <Select value={tool} onChange={(e) => setTool(e.target.value)}>
              <option value="">Any tool</option>
              {TOOLS.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Any category</option>
              {LESSON_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Phase">
            <Input
              value={phase}
              onChange={(e) => setPhase(e.target.value)}
              placeholder="e.g. fit-out"
              maxLength={60}
            />
          </Field>
          <Field label="Tags" hint="Comma separated.">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="mep, late-change"
              maxLength={400}
            />
          </Field>
          <Field label="Limit">
            <Select value={limit} onChange={(e) => setLimit(e.target.value)}>
              {["5", "10", "20", "50"].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={() => void run()} disabled={loading}>
            {loading ? "Retrieving…" : "Retrieve lessons"}
          </Button>
          <span className="text-xs text-ink-400">
            No model is involved — this is integer arithmetic over the inputs above.
          </span>
        </div>

        {error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-100">{error}</div>
        ) : null}
        {notice ? <NoteCard note={notice} tone="brand" /> : null}

        {loading ? <Spinner label="Ranking the published register…" /> : null}

        {result && !loading ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-600">
              <span>
                <span className="font-semibold tabular-nums text-ink-900">{fmtInt(result.matched)}</span>{" "}
                matched
              </span>
              <span>
                of{" "}
                <span className="font-semibold tabular-nums text-ink-900">{fmtInt(result.registerSize)}</span>{" "}
                published lesson{result.registerSize === 1 ? "" : "s"} in the register
              </span>
              <span className="text-xs text-ink-400">
                query: tool {result.query.tool ?? "any"} · category {result.query.category ?? "any"} · phase{" "}
                {result.query.phase ?? "any"} · tags{" "}
                {result.query.tags.length > 0 ? result.query.tags.join(", ") : "none"}
              </span>
            </div>

            {result.query.toolImpliesCategories.length > 0 ? (
              <p className="text-xs text-ink-500">
                The <span className="font-medium">{label(result.query.tool ?? "")}</span> tool implies the
                categories{" "}
                <span className="font-medium">
                  {result.query.toolImpliesCategories.map((c) => label(c)).join(", ")}
                </span>
                , which is where the tool-affinity points come from.
              </p>
            ) : null}

            {result.items.length === 0 ? (
              <p className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-600">
                {result.registerSize === 0
                  ? "The published register is empty, so there is nothing to retrieve. Capture, validate and publish a lesson first."
                  : "No published lesson scored against these inputs. Widen the tool, category, phase or tags — a nil result here is a real answer, not a failure."}
              </p>
            ) : (
              <ul className="space-y-3">
                {result.items.map((item) => (
                  <li key={item.lesson.id} className="rounded-lg bg-ink-50 p-3 ring-1 ring-ink-100">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <span className="font-mono text-xs text-ink-500">{item.lesson.number}</span>{" "}
                        <span className="font-medium text-ink-900">{item.lesson.title}</span>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Badge tone="blue">{label(item.lesson.category)}</Badge>
                          {item.lesson.phase ? <Badge tone="violet">{item.lesson.phase}</Badge> : null}
                          <span className="text-xs text-ink-500">
                            {impactLabel(
                              item.lesson.impactValue,
                              item.lesson.impactCurrency,
                              item.lesson.impactDays,
                            )}
                          </span>
                          <span className="text-xs text-ink-400">
                            applied {fmtInt(item.applicationCount)}×
                          </span>
                          <span className="text-xs text-ink-400">
                            published {formatDate(item.lesson.publishedAt)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex items-center rounded-full bg-brand-600 px-2.5 py-1 text-xs font-bold tabular-nums text-white"
                          title="Total relevance score"
                        >
                          {fmtInt(item.score)}
                        </span>
                        <Button size="sm" variant="secondary" onClick={() => onInspect(item.lesson.id)}>
                          Inspect
                        </Button>
                        <Button size="sm" onClick={() => setApplyFor(item.lesson)}>
                          Apply
                        </Button>
                      </div>
                    </div>

                    <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700">
                      <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                        Recommendation:{" "}
                      </span>
                      {item.lesson.recommendation}
                    </p>

                    <div className="mt-2">
                      <TagList tags={item.lesson.tags} />
                    </div>

                    <div className="mt-2 border-t border-ink-200 pt-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                        Why this surfaced
                      </p>
                      <ul className="mt-1 space-y-1">
                        {item.reasons.map((r, i) => (
                          <li key={`${r.code}-${i}`} className="flex items-start gap-2 text-xs text-ink-600">
                            <span className="mt-0.5 inline-flex min-w-9 justify-end font-bold tabular-nums text-brand-700">
                              +{r.points}
                            </span>
                            <span>
                              <span className="font-medium text-ink-800">
                                {REASON_LABEL[r.code] ?? r.code}
                              </span>{" "}
                              — {r.detail}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <NoteCard note={result.ranking} tone="ink" title="How the ranking works —" />
          </div>
        ) : null}
      </CardBody>

      {applyFor ? (
        <ApplyModal
          open
          lessonId={applyFor.id}
          lessonNumber={applyFor.number}
          lessonTitle={applyFor.title}
          originProjectId={applyFor.originProjectId}
          projects={projects}
          fixedProjectId={projectId}
          onClose={() => setApplyFor(null)}
          onApplied={applied}
        />
      ) : null}
    </Card>
  );
}
