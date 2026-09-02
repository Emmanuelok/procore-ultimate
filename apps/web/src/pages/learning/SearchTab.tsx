/**
 * Natural-language search over the published register.
 *
 * The endpoint ALWAYS runs deterministic keyword search and only ever adds an
 * AI-synthesised answer on top, so this tab is built the same way round: the
 * deterministic results and their matched terms are the spine of the page,
 * and the answer sits above them as an addition.
 *
 * When the mode comes back "deterministic" the server's note names exactly
 * what is missing — an unset ANTHROPIC_API_KEY, or the failure of the model
 * call. That note is shown verbatim and prominently. A degraded search is
 * never presented as a full one.
 */
import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, Field, Input, Select, Spinner } from "../../ui";
import { formatDate } from "../format";
import LessonDrawer from "./LessonDrawer";
import {
  NoteCard,
  SectionTitle,
  TagList,
  errorMessage,
  fmtInt,
  fmtNum,
  impactLabel,
  label,
} from "./learningShared";
import type { ProjectRow, SearchResponse } from "./learningShared";

export default function SearchTab({
  projects,
  canSupersede,
}: {
  projects: ProjectRow[] | null;
  canSupersede: boolean;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState("10");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openLessonId, setOpenLessonId] = useState<string | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.post<SearchResponse>("/api/v1/learning/search", {
        query: query.trim(),
        limit: Number(limit),
      });
      setResult(res);
      setAsked(query.trim());
    } catch (err) {
      setResult(null);
      setError(errorMessage(err, "The search failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <SectionTitle hint="Ask the register a question. Keyword search always runs; the AI layer only ever adds an answer with citations back to lesson ids.">
            Search the published register
          </SectionTitle>
          <form onSubmit={run} className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <Field label="Question">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. what have we learned about late MEP design changes?"
                  maxLength={500}
                />
              </Field>
            </div>
            <div className="w-28">
              <Field label="Limit">
                <Select value={limit} onChange={(e) => setLimit(e.target.value)}>
                  {["5", "10", "25"].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="submit" disabled={query.trim().length < 2 || loading}>
              {loading ? "Searching…" : "Search"}
            </Button>
          </form>
        </CardBody>
      </Card>

      {error ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-100">{error}</div>
      ) : null}

      {loading ? <Spinner label="Searching the register…" /> : null}

      {result && !loading ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {result.mode === "ai" ? (
              <Badge tone="green">AI answer + keyword results</Badge>
            ) : (
              <Badge tone="amber">Deterministic keyword search only</Badge>
            )}
            <span className="text-xs text-ink-500">
              AI layer {result.aiAvailable ? "configured" : "not configured"} · register holds{" "}
              {fmtInt(result.registerSize)} published lesson{result.registerSize === 1 ? "" : "s"} ·{" "}
              {fmtInt(result.results.length)} result{result.results.length === 1 ? "" : "s"}
            </span>
            {result.runId ? (
              <span className="font-mono text-[11px] text-ink-400">run {result.runId}</span>
            ) : null}
          </div>

          {/* The note is the honesty contract — always shown, always verbatim. */}
          <NoteCard
            note={result.note}
            tone={result.mode === "ai" ? "ink" : "amber"}
            title={result.mode === "ai" ? undefined : "Degraded search —"}
          />

          {result.mode === "ai" ? (
            <Card>
              <CardBody>
                <SectionTitle hint="Synthesised strictly from the cited lessons below. The result list underneath is unaffected by it.">
                  Answer
                </SectionTitle>
                {result.answer ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{result.answer}</p>
                ) : (
                  <p className="text-sm text-ink-600">
                    The AI layer declined to answer from these lessons — it returned no answer rather than
                    inventing one. The keyword results below still stand.
                  </p>
                )}
                {result.confidence !== null ? (
                  <p className="mt-2 text-xs text-ink-500">
                    Model-reported confidence:{" "}
                    <span className="font-semibold tabular-nums text-ink-800">
                      {fmtNum(result.confidence, 2)}
                    </span>{" "}
                    (0-1, self-assessed — not a measurement)
                  </p>
                ) : null}

                <div className="mt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Citations</p>
                  {result.citations.length === 0 ? (
                    <p className="mt-1 text-sm text-ink-500">
                      None. Any citation to a lesson that was not in the prompt is dropped rather than shown.
                    </p>
                  ) : (
                    <ul className="mt-1 space-y-2">
                      {result.citations.map((c) => (
                        <li key={c.lessonId} className="rounded-md bg-brand-50 px-3 py-2 ring-1 ring-brand-100">
                          <button
                            type="button"
                            onClick={() => setOpenLessonId(c.lessonId)}
                            className="text-left text-sm font-medium text-brand-800 hover:underline"
                          >
                            <span className="font-mono text-xs">{c.number}</span> — {c.title}
                          </button>
                          {c.excerpt ? (
                            <p className="mt-1 whitespace-pre-wrap text-xs text-ink-600">“{c.excerpt}”</p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardBody>
              <SectionTitle hint="Ranked by term matches, weighted by field, with prior applications breaking ties.">
                Keyword results{asked ? ` for “${asked}”` : ""}
              </SectionTitle>
              {result.results.length === 0 ? (
                <p className="text-sm text-ink-600">
                  {result.registerSize === 0
                    ? "The published register is empty — there is nothing to search. Capture, validate and publish a lesson first."
                    : "No published lesson matched those terms. That is a real answer about the register, not a failure of the search."}
                </p>
              ) : (
                <ul className="space-y-3">
                  {result.results.map((r) => (
                    <li key={r.lesson.id} className="rounded-lg bg-ink-50 p-3 ring-1 ring-ink-100">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <span className="font-mono text-xs text-ink-500">{r.lesson.number}</span>{" "}
                          <span className="font-medium text-ink-900">{r.lesson.title}</span>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <Badge tone="blue">{label(r.lesson.category)}</Badge>
                            {r.lesson.phase ? <Badge tone="violet">{r.lesson.phase}</Badge> : null}
                            <span className="text-xs text-ink-500">
                              {impactLabel(
                                r.lesson.impactValue,
                                r.lesson.impactCurrency,
                                r.lesson.impactDays,
                              )}
                            </span>
                            <span className="text-xs text-ink-400">
                              published {formatDate(r.lesson.publishedAt)}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-flex items-center rounded-full bg-ink-700 px-2.5 py-1 text-xs font-bold tabular-nums text-white"
                            title="Keyword score"
                          >
                            {fmtNum(r.score, 1)}
                          </span>
                          <Button size="sm" variant="secondary" onClick={() => setOpenLessonId(r.lesson.id)}>
                            Inspect
                          </Button>
                        </div>
                      </div>

                      <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700">
                        <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                          Recommendation:{" "}
                        </span>
                        {r.lesson.recommendation}
                      </p>

                      <div className="mt-2">
                        <TagList tags={r.lesson.tags} />
                      </div>

                      <div className="mt-2 border-t border-ink-200 pt-2 text-xs text-ink-600">
                        <p>{r.why}</p>
                        <p className="mt-1">
                          <span className="font-medium text-ink-700">Matched terms:</span>{" "}
                          {r.matchedTerms.length > 0 ? r.matchedTerms.join(", ") : "—"}
                          <span className="mx-2 text-ink-300">|</span>
                          <span className="font-medium text-ink-700">Fields:</span>{" "}
                          {r.matchedFields.length > 0 ? r.matchedFields.map((f) => label(f)).join(", ") : "—"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}

      {!result && !loading && !error ? (
        <Card>
          <CardBody>
            <p className="text-sm text-ink-600">
              Search runs over <span className="font-medium">published</span> lessons only. Drafts,
              submitted and rejected lessons are invisible here by design — a lesson that has not been
              validated by a second pair of eyes is not something the organisation knows.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {openLessonId ? (
        <LessonDrawer
          lessonId={openLessonId}
          projects={projects}
          canSupersede={canSupersede}
          onClose={() => setOpenLessonId(null)}
          onChanged={() => undefined}
        />
      ) : null}
    </div>
  );
}
