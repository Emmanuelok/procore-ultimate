/**
 * AI workspace (spec Vol I #759-#774; Vol II Domain X) — grounded assistant
 * chat and search on the left; agent actions, the human-in-the-loop review
 * queue and the runs audit trail on the right.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
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
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

interface SearchResult {
  runId: string | null;
  answer: string | null;
  citations: { ref?: number; type: string; id: string; excerpt?: string }[];
  confidence: number | null | undefined;
}

interface ReviewItem {
  id: string;
  runId: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  confidence: number | null;
  status: string;
  createdAt: string;
}

interface RunItem {
  id: string;
  agentKind: string;
  model: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  createdAt: string;
}

interface RfiOption {
  id: string;
  number: number;
  subject: string;
}

interface SubmittalOption {
  id: string;
  number: number;
  title: string;
}

function reviewTone(status: string): string {
  if (status === "pending") return "blue";
  if (status === "approved") return "green";
  if (status === "rejected") return "red";
  return "gray";
}

function runTone(status: string): string {
  if (status === "succeeded") return "green";
  if (status === "failed") return "red";
  if (status === "refused") return "amber";
  return "gray";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AiPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}/ai`;

  const [aiDisabled, setAiDisabled] = useState(false);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Search
  const [query, setQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  // Agent actions
  const [logDate, setLogDate] = useState(todayIso());
  const [rfis, setRfis] = useState<RfiOption[]>([]);
  const [submittals, setSubmittals] = useState<SubmittalOption[]>([]);
  const [rfiId, setRfiId] = useState("");
  const [submittalId, setSubmittalId] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Review queue + runs
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null);
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);

  const markIfDisabled = useCallback((err: unknown): boolean => {
    if (err instanceof ApiClientError && err.status === 503) {
      setAiDisabled(true);
      return true;
    }
    return false;
  }, []);

  const loadQueues = useCallback(async () => {
    if (!projectId) return;
    setQueueError(null);
    try {
      const [rev, runList] = await Promise.all([
        api.get<ListResponse<ReviewItem>>(`${base}/review?pageSize=50`),
        api.get<ListResponse<RunItem>>(`/api/v1/ai/runs?projectId=${projectId}&pageSize=50`),
      ]);
      setReviews(rev.items);
      setRuns(runList.items);
    } catch (err) {
      setReviews([]);
      setRuns([]);
      setQueueError(err instanceof Error ? err.message : "Failed to load the review queue");
    }
  }, [base, projectId]);

  useEffect(() => {
    void loadQueues();
    if (!projectId) return;
    api
      .get<ListResponse<RfiOption>>(`/api/v1/projects/${projectId}/rfis?pageSize=100`)
      .then((r) => setRfis(r.items))
      .catch(() => setRfis([]));
    api
      .get<ListResponse<SubmittalOption>>(`/api/v1/projects/${projectId}/submittals?pageSize=100`)
      .then((r) => setSubmittals(r.items))
      .catch(() => setSubmittals([]));
  }, [loadQueues, projectId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendChat(e: FormEvent) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text || chatBusy || aiDisabled) return;
    setChatError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    setChatInput("");
    setChatBusy(true);
    try {
      const res = await api.post<{ runId: string; text: string }>(`${base}/assist`, {
        message: text,
      });
      setMessages((m) => [...m, { role: "assistant", text: res.text }]);
      void loadQueues();
    } catch (err) {
      if (!markIfDisabled(err)) {
        setChatError(err instanceof Error ? err.message : "The assistant failed to respond");
      }
    } finally {
      setChatBusy(false);
    }
  }

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2 || searchBusy || aiDisabled) return;
    setSearchBusy(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      const res = await api.post<SearchResult>(`${base}/search`, { query: q });
      setSearchResult(res);
      void loadQueues();
    } catch (err) {
      if (!markIfDisabled(err)) {
        setSearchError(err instanceof Error ? err.message : "Search failed");
      }
    } finally {
      setSearchBusy(false);
    }
  }

  async function runAction(kind: "daily" | "rfi" | "submittal") {
    if (aiDisabled) return;
    setActionBusy(kind);
    setActionMessage(null);
    setActionError(null);
    try {
      if (kind === "daily") {
        await api.post(`${base}/daily-log-draft`, { date: logDate });
        setActionMessage(`Daily log draft for ${logDate} queued for review.`);
      } else if (kind === "rfi") {
        await api.post(`${base}/rfi-evaluate`, { rfiId });
        setActionMessage("RFI evaluation queued for review.");
      } else {
        await api.post(`${base}/submittal-review`, { submittalId });
        setActionMessage("Submittal review queued for review.");
      }
      await loadQueues();
    } catch (err) {
      if (!markIfDisabled(err)) {
        setActionError(err instanceof Error ? err.message : "The agent run failed");
      }
    } finally {
      setActionBusy(null);
    }
  }

  async function decide(item: ReviewItem, decision: "approve" | "reject") {
    setDecisionBusy(item.id);
    setQueueError(null);
    // optimistic update
    setReviews((prev) =>
      (prev ?? []).map((r) =>
        r.id === item.id ? { ...r, status: decision === "approve" ? "approved" : "rejected" } : r,
      ),
    );
    try {
      await api.post(`/api/v1/ai/review/${item.id}/${decision}`, {});
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : `Failed to ${decision} the proposal`);
    } finally {
      setDecisionBusy(null);
      void loadQueues();
    }
  }

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="AI workspace"
        subtitle="Grounded agents with citations, a human approval gate, and a full run audit trail"
      />

      {aiDisabled ? (
        <Card className="mb-4 border-l-4 border-l-brand-500">
          <CardBody>
            <div className="text-sm font-semibold text-ink-900">AI is not configured</div>
            <p className="mt-1 text-sm text-ink-600">
              Set <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">ANTHROPIC_API_KEY</code>{" "}
              on the API to enable the assistant, grounded search and agent actions. The review queue
              and run audit below remain readable.
            </p>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ------------------------------ Left column ------------------------------ */}
        <div className="space-y-4">
          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">Assistant</div>
              <div className="mb-3 h-80 space-y-2 overflow-y-auto rounded-md border border-ink-100 bg-ink-50/40 p-3">
                {messages.length === 0 ? (
                  <p className="pt-24 text-center text-xs text-ink-400">
                    Ask about the platform or this project's state — the assistant is grounded in
                    live record counts and never fabricates record contents.
                  </p>
                ) : (
                  messages.map((m, i) => (
                    <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                      <div
                        className={
                          m.role === "user"
                            ? "max-w-[85%] rounded-lg rounded-br-sm bg-brand-600 px-3 py-2 text-sm text-white"
                            : "max-w-[85%] whitespace-pre-wrap rounded-lg rounded-bl-sm bg-white px-3 py-2 text-sm text-ink-800 shadow-sm ring-1 ring-ink-100"
                        }
                      >
                        {m.text}
                      </div>
                    </div>
                  ))
                )}
                {chatBusy ? (
                  <div className="flex justify-start">
                    <div className="rounded-lg bg-white px-3 py-2 text-sm text-ink-400 shadow-sm ring-1 ring-ink-100">
                      Thinking…
                    </div>
                  </div>
                ) : null}
                <div ref={chatEndRef} />
              </div>
              <ErrorAlert message={chatError} />
              <form onSubmit={sendChat} className="flex gap-2">
                <Input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={aiDisabled ? "AI is not configured" : "Ask the assistant…"}
                  disabled={aiDisabled || chatBusy}
                />
                <Button type="submit" disabled={aiDisabled || chatBusy || !chatInput.trim()}>
                  Send
                </Button>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">Grounded search</div>
              <form onSubmit={runSearch} className="flex gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    aiDisabled ? "AI is not configured" : "Search RFIs, submittals, documents, drawings…"
                  }
                  disabled={aiDisabled || searchBusy}
                />
                <Button type="submit" disabled={aiDisabled || searchBusy || query.trim().length < 2}>
                  {searchBusy ? "Searching…" : "Search"}
                </Button>
              </form>
              <ErrorAlert message={searchError} />
              {searchResult ? (
                <div className="mt-3 rounded-md border border-ink-100 p-3">
                  {searchResult.answer ? (
                    <p className="whitespace-pre-wrap text-sm text-ink-800">{searchResult.answer}</p>
                  ) : (
                    <p className="text-sm text-ink-500">
                      No grounded answer — the indexed records do not contain it.
                    </p>
                  )}
                  {searchResult.citations.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {searchResult.citations.map((c, i) => (
                        <span
                          key={i}
                          title={c.excerpt}
                          className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-mono text-xs text-brand-800 ring-1 ring-brand-200"
                        >
                          {c.type} #{c.id.slice(-6)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {typeof searchResult.confidence === "number" ? (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-xs text-ink-400">Confidence</span>
                      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-ink-100">
                        <div
                          className={`h-full ${
                            searchResult.confidence >= 0.7
                              ? "bg-emerald-500"
                              : searchResult.confidence >= 0.4
                                ? "bg-amber-500"
                                : "bg-red-500"
                          }`}
                          style={{ width: `${Math.round(searchResult.confidence * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-ink-500">
                        {Math.round(searchResult.confidence * 100)}%
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>
        </div>

        {/* ------------------------------ Right column ----------------------------- */}
        <div className="space-y-4">
          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">Agent actions</div>
              <p className="mb-3 text-xs text-ink-500">
                Every consequential proposal lands in the review queue — nothing touches an
                operational record until a human approves it.
              </p>
              {actionMessage ? (
                <div className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
                  {actionMessage}
                </div>
              ) : null}
              <ErrorAlert message={actionError} />
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Field label="Draft daily log">
                      <Input
                        type="date"
                        value={logDate}
                        onChange={(e) => setLogDate(e.target.value)}
                        disabled={aiDisabled}
                      />
                    </Field>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={aiDisabled || actionBusy !== null || !logDate}
                    onClick={() => void runAction("daily")}
                  >
                    {actionBusy === "daily" ? "Drafting…" : "Run"}
                  </Button>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Field label="Evaluate RFI">
                      <Select value={rfiId} onChange={(e) => setRfiId(e.target.value)} disabled={aiDisabled}>
                        <option value="">Choose an RFI…</option>
                        {rfis.map((r) => (
                          <option key={r.id} value={r.id}>
                            RFI-{String(r.number).padStart(3, "0")} — {r.subject.slice(0, 60)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={aiDisabled || actionBusy !== null || !rfiId}
                    onClick={() => void runAction("rfi")}
                  >
                    {actionBusy === "rfi" ? "Evaluating…" : "Run"}
                  </Button>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Field label="Review submittal">
                      <Select
                        value={submittalId}
                        onChange={(e) => setSubmittalId(e.target.value)}
                        disabled={aiDisabled}
                      >
                        <option value="">Choose a submittal…</option>
                        {submittals.map((s) => (
                          <option key={s.id} value={s.id}>
                            #{String(s.number).padStart(3, "0")} — {s.title.slice(0, 60)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={aiDisabled || actionBusy !== null || !submittalId}
                    onClick={() => void runAction("submittal")}
                  >
                    {actionBusy === "submittal" ? "Reviewing…" : "Run"}
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">Review queue</div>
              <ErrorAlert message={queueError} />
              {reviews === null ? (
                <Spinner />
              ) : reviews.length === 0 ? (
                <EmptyState
                  title="No proposals awaiting review"
                  hint="Run an agent action — its output will queue here for human approval."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-ink-100 text-sm">
                    <thead>
                      <tr>
                        <Th>Target</Th>
                        <Th>Summary</Th>
                        <Th>Conf.</Th>
                        <Th>Created</Th>
                        <Th />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {reviews.map((r) => (
                        <tr key={r.id} className="hover:bg-ink-50/60">
                          <Td className="whitespace-nowrap">
                            <Badge tone="violet">{humanize(r.targetType)}</Badge>
                          </Td>
                          <Td className="max-w-xs">
                            <span className="line-clamp-2 text-xs">{r.summary}</span>
                          </Td>
                          <Td className="tabular-nums text-xs">
                            {r.confidence !== null ? `${Math.round(r.confidence * 100)}%` : "—"}
                          </Td>
                          <Td className="whitespace-nowrap text-xs text-ink-500">
                            {formatDateTime(r.createdAt)}
                          </Td>
                          <Td className="whitespace-nowrap">
                            {r.status === "pending" ? (
                              <span className="flex gap-1.5">
                                <Button
                                  size="sm"
                                  disabled={decisionBusy === r.id}
                                  onClick={() => void decide(r, "approve")}
                                >
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  disabled={decisionBusy === r.id}
                                  onClick={() => void decide(r, "reject")}
                                >
                                  Reject
                                </Button>
                              </span>
                            ) : (
                              <Badge tone={reviewTone(r.status)}>{humanize(r.status)}</Badge>
                            )}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">Run audit</div>
              {runs === null ? (
                <Spinner />
              ) : runs.length === 0 ? (
                <p className="text-xs text-ink-400">No AI runs recorded for this project yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-ink-100 text-sm">
                    <thead>
                      <tr>
                        <Th>Agent</Th>
                        <Th>Status</Th>
                        <Th>Tokens in/out</Th>
                        <Th>Latency</Th>
                        <Th>Created</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {runs.map((r) => (
                        <tr key={r.id} className="hover:bg-ink-50/60">
                          <Td className="whitespace-nowrap font-mono text-xs">{r.agentKind}</Td>
                          <Td>
                            <Badge tone={runTone(r.status)}>{humanize(r.status)}</Badge>
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums text-xs">
                            {r.inputTokens ?? "—"} / {r.outputTokens ?? "—"}
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums text-xs">
                            {r.latencyMs !== null ? `${r.latencyMs} ms` : "—"}
                          </Td>
                          <Td className="whitespace-nowrap text-xs text-ink-500">
                            {formatDateTime(r.createdAt)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
