/**
 * AI workspace, project scope (Vol I #759–#774; Vol II Domain X).
 *
 * Left: the grounded assistant and document search. Right: the agent fleet
 * for this project, the human-in-the-loop review queue and the run audit.
 *
 * Three defects this page used to have, fixed here:
 *   · a reviewer could approve a proposal without ever seeing it — the queue
 *     rows now open the proposal, the current record and the citations
 *     (ReviewDrawer) before anything can be approved;
 *   · Reject sent no reason although the API ledgers one — the drawer asks;
 *   · the runs table pulled full prompts and model output for a five-column
 *     list — it now lists metadata and opens the content per run, behind that
 *     run's own project gate.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiClientError } from "../../lib/api";
import {
  Alert,
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
import { IconAi } from "../../ui/icons";
import { RunDetailDrawer } from "../agents/ActivityTab";
import ReviewDrawer from "../agents/ReviewDrawer";
import {
  CATEGORY_TONE,
  confidenceBand,
  errorMessage,
  formatDateTime,
  humanize,
  num,
  pct,
  REVIEW_STATUS_TONE,
  RUN_STATUS_TONE,
  type AgentDescriptor,
  type AgentListResponse,
  type AgentRunResult,
  type ReviewItem,
  type RunSummary,
} from "../agents/agentsShared";

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
  modelConfidence?: number | null;
  evidenceScore?: number | null;
  droppedCitations?: number;
  reason?: string;
  coverage?: string[];
  skipped?: string[];
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

/** The project's local day, not the browser's UTC slice. */
function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
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

  // Legacy agent actions
  const [logDate, setLogDate] = useState(todayIso());
  const [rfis, setRfis] = useState<RfiOption[]>([]);
  const [submittals, setSubmittals] = useState<SubmittalOption[]>([]);
  const [rfiId, setRfiId] = useState("");
  const [submittalId, setSubmittalId] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fleet
  const [agents, setAgents] = useState<AgentDescriptor[] | null>(null);
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [fleetKind, setFleetKind] = useState("");
  const [fleetBusy, setFleetBusy] = useState(false);
  const [fleetResult, setFleetResult] = useState<AgentRunResult | null>(null);

  // Queue + runs
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [openReviewId, setOpenReviewId] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const markIfDisabled = useCallback((err: unknown): boolean => {
    if (err instanceof ApiClientError && err.status === 503) {
      setAiDisabled(true);
      return true;
    }
    return false;
  }, []);

  const loadQueue = useCallback(async () => {
    if (!projectId) return;
    setQueueError(null);
    try {
      const rev = await api.get<ListResponse<ReviewItem>>(`${base}/review?pageSize=50`);
      setReviews(rev.items);
    } catch (err) {
      setReviews([]);
      setQueueError(errorMessage(err, "Failed to load the review queue"));
    }
  }, [base, projectId]);

  const loadRuns = useCallback(async () => {
    if (!projectId) return;
    setRunsError(null);
    try {
      const list = await api.get<ListResponse<RunSummary>>(
        `/api/v1/ai/runs?projectId=${projectId}&pageSize=25`,
      );
      setRuns(list.items);
    } catch (err) {
      setRuns([]);
      setRunsError(errorMessage(err, "Failed to load the run audit"));
    }
  }, [projectId]);

  const refresh = useCallback(() => {
    void loadQueue();
    void loadRuns();
  }, [loadQueue, loadRuns]);

  useEffect(() => {
    refresh();
    if (!projectId) return;
    api
      .get<ListResponse<RfiOption>>(`/api/v1/projects/${projectId}/rfis?pageSize=100&status=open`)
      .then((r) => setRfis(r.items))
      .catch(() => setRfis([]));
    api
      .get<ListResponse<SubmittalOption>>(`/api/v1/projects/${projectId}/submittals?pageSize=100`)
      .then((r) => setSubmittals(r.items))
      .catch(() => setSubmittals([]));
    api
      .get<AgentListResponse>("/api/v1/agents")
      .then((r) => {
        setAgents(r.items);
        if (!r.aiEnabled) setAiDisabled(true);
      })
      .catch((err: unknown) => setFleetError(errorMessage(err, "Agent fleet unavailable")));
  }, [refresh, projectId]);

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
      void loadRuns();
    } catch (err) {
      if (!markIfDisabled(err)) {
        setChatError(errorMessage(err, "The assistant failed to respond"));
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
      setSearchResult(await api.post<SearchResult>(`${base}/search`, { query: q }));
      void loadRuns();
    } catch (err) {
      if (!markIfDisabled(err)) setSearchError(errorMessage(err, "Search failed"));
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
        const res = await api.post<{ contentReviewed: boolean; documentsAttached: number }>(
          `${base}/submittal-review`,
          { submittalId },
        );
        setActionMessage(
          res.contentReviewed
            ? `Submittal reviewed against ${num(res.documentsAttached)} document(s) and the specification text.`
            : "Queued — but NO specification text or readable attachment was available, so the recommendation is not grounded in content.",
        );
      }
      refresh();
    } catch (err) {
      if (!markIfDisabled(err)) setActionError(errorMessage(err, "The agent run failed"));
    } finally {
      setActionBusy(null);
    }
  }

  async function runFleetAgent() {
    if (!fleetKind || aiDisabled) return;
    setFleetBusy(true);
    setFleetError(null);
    setFleetResult(null);
    try {
      const res = await api.post<AgentRunResult>(
        `/api/v1/projects/${projectId}/agents/${fleetKind}/run`,
        { params: {} },
      );
      setFleetResult(res);
      if (res.skipped) toast.message("Nothing to analyse", { description: res.summary });
      else toast.success(`${res.queued} proposal(s) queued for review`);
      refresh();
    } catch (err) {
      if (!markIfDisabled(err)) setFleetError(errorMessage(err, "The agent run failed"));
    } finally {
      setFleetBusy(false);
    }
  }

  if (!projectId) return null;

  const projectAgents = (agents ?? []).filter(
    (a) => a.runnable && a.enabled && (a.scope === "project" || a.scope === "both"),
  );
  const pending = (reviews ?? []).filter((r) => r.status === "pending").length;

  return (
    <div>
      <PageHeader
        title="AI workspace"
        icon={IconAi}
        subtitle="Grounded agents with validated citations, a human approval gate, and a full run audit trail"
      />

      {aiDisabled ? (
        <Alert tone="warning" title="AI is not configured" className="mb-4">
          Set <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> on the API to enable the
          assistant, grounded search and the agent fleet. The review queue and the run audit below
          remain readable — nothing non-AI depends on the key.
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ------------------------------ Left column ------------------------------ */}
        <div className="space-y-4">
          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">Assistant</div>
              <p className="mb-2 text-xs text-ink-500">
                One question at a time: the assistant has no conversation memory and no live record
                access, so it will not answer a follow-up from context it does not have.
              </p>
              <div className="mb-3 h-72 space-y-2 overflow-y-auto rounded-md border border-ink-100 bg-ink-50/40 p-3">
                {messages.length === 0 ? (
                  <p className="pt-20 text-center text-xs text-ink-400">
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
                      No grounded answer.{" "}
                      {searchResult.reason ?? "The indexed records do not contain it."}
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
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone={confidenceBand(searchResult.confidence).tone}>
                      Recorded confidence {pct(searchResult.confidence)}
                    </Badge>
                    {typeof searchResult.modelConfidence === "number" &&
                    searchResult.modelConfidence !== searchResult.confidence ? (
                      <span className="text-ink-500">
                        the model claimed {pct(searchResult.modelConfidence)}; the platform damped it
                        by the evidence
                      </span>
                    ) : null}
                    {searchResult.droppedCitations ? (
                      <Badge tone="danger">
                        {num(searchResult.droppedCitations)} invented citation(s) dropped
                      </Badge>
                    ) : null}
                  </div>
                  {searchResult.coverage?.length ? (
                    <p className="mt-2 text-xs text-ink-500">
                      Searched: {searchResult.coverage.map((c) => humanize(c)).join(", ")}.
                      {searchResult.skipped?.length
                        ? ` Not searched: ${searchResult.skipped.join("; ")}.`
                        : ""}
                    </p>
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
                operational record until a human with the owning tool approves it.
              </p>
              {actionMessage ? (
                <Alert tone="info" className="mb-3">
                  {actionMessage}
                </Alert>
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
                    <Field label="Evaluate RFI" hint="Only an open RFI can be answered.">
                      <Select value={rfiId} onChange={(e) => setRfiId(e.target.value)} disabled={aiDisabled}>
                        <option value="">Choose an open RFI…</option>
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
                    <Field
                      label="Review submittal"
                      hint="Reads the attached documents and the specification clause text."
                    >
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
              <div className="mb-2 text-sm font-semibold text-ink-900">Agent fleet</div>
              <p className="mb-2 text-xs text-ink-500">
                Monitors, drafters and analysts that read this project's real records. An agent with
                nothing to look at says so and does not call the model.
              </p>
              <ErrorAlert message={fleetError} />
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Field label="Agent">
                    <Select
                      value={fleetKind}
                      onChange={(e) => setFleetKind(e.target.value)}
                      disabled={aiDisabled || projectAgents.length === 0}
                    >
                      <option value="">Choose an agent…</option>
                      {projectAgents.map((a) => (
                        <option key={a.kind} value={a.kind}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Button
                  variant="secondary"
                  disabled={aiDisabled || fleetBusy || !fleetKind}
                  onClick={() => void runFleetAgent()}
                >
                  {fleetBusy ? "Running…" : "Run"}
                </Button>
              </div>
              {fleetKind ? (
                <p className="mt-2 text-xs text-ink-600">
                  {projectAgents.find((a) => a.kind === fleetKind)?.description}
                </p>
              ) : null}
              {fleetResult ? (
                <div className="mt-3 rounded-md border border-ink-100 p-3 text-xs text-ink-700">
                  <div className="mb-1 flex flex-wrap gap-1.5">
                    <Badge tone={fleetResult.skipped ? "neutral" : "success"}>
                      {fleetResult.skipped ? "Skipped — the model was not called" : "Run complete"}
                    </Badge>
                    {!fleetResult.skipped ? (
                      <>
                        <Badge tone="info">{num(fleetResult.queued)} queued</Badge>
                        {fleetResult.signals ? (
                          <Badge tone="warning">{num(fleetResult.signals)} signal(s) raised</Badge>
                        ) : null}
                        <Badge tone="neutral">evidence {pct(fleetResult.evidenceScore)}</Badge>
                        {fleetResult.droppedCitations ? (
                          <Badge tone="danger">
                            {num(fleetResult.droppedCitations)} invented citation(s) dropped
                          </Badge>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <p>{fleetResult.summary}</p>
                </div>
              ) : null}
              {agents === null && !fleetError ? <Spinner /> : null}
              <div className="mt-3 flex flex-wrap gap-1">
                {projectAgents.slice(0, 12).map((a) => (
                  <Badge key={a.kind} tone={CATEGORY_TONE[a.category] ?? "neutral"}>
                    {a.name}
                  </Badge>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-ink-900">Review queue</div>
                {pending > 0 ? <Badge tone="warning">{num(pending)} awaiting a human</Badge> : null}
              </div>
              <ErrorAlert message={queueError} />
              {reviews === null ? (
                <Spinner />
              ) : reviews.length === 0 ? (
                <EmptyState
                  title="No proposals awaiting review"
                  hint="Run an agent — its output queues here, and you read it before deciding."
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Target</Th>
                        <Th>Summary</Th>
                        <Th>Confidence</Th>
                        <Th>Raised</Th>
                        <Th />
                      </tr>
                    </thead>
                    <tbody>
                      {reviews.map((r) => {
                        const band = confidenceBand(r.confidence);
                        return (
                          <tr
                            key={r.id}
                            className="cursor-pointer hover:bg-ink-50/60"
                            onClick={() => setOpenReviewId(r.id)}
                          >
                            <Td className="whitespace-nowrap">
                              <Badge tone="info">{humanize(r.targetType)}</Badge>
                            </Td>
                            <Td className="max-w-xs">
                              <span className="line-clamp-2 text-xs">{r.summary}</span>
                            </Td>
                            <Td className="whitespace-nowrap text-xs">
                              <Badge tone={band.tone}>
                                {pct(r.confidence)} {band.label}
                              </Badge>
                            </Td>
                            <Td className="whitespace-nowrap text-xs text-ink-500">
                              {formatDateTime(r.createdAt)}
                            </Td>
                            <Td className="whitespace-nowrap">
                              {r.status === "pending" ? (
                                <Button size="sm" onClick={() => setOpenReviewId(r.id)}>
                                  Review…
                                </Button>
                              ) : (
                                <Badge tone={REVIEW_STATUS_TONE[r.status] ?? "neutral"}>
                                  {humanize(r.status)}
                                </Badge>
                              )}
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">Run audit</div>
              <ErrorAlert message={runsError} />
              {runs === null ? (
                <Spinner />
              ) : runs.length === 0 ? (
                <p className="text-xs text-ink-400">No AI runs recorded for this project yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Agent</Th>
                        <Th>Status</Th>
                        <Th>Evidence</Th>
                        <Th>Cited / supplied</Th>
                        <Th>Created</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr
                          key={r.id}
                          className="cursor-pointer hover:bg-ink-50/60"
                          onClick={() => setOpenRunId(r.id)}
                        >
                          <Td className="whitespace-nowrap font-mono text-xs">{r.agentKind}</Td>
                          <Td>
                            <Badge tone={RUN_STATUS_TONE[r.status] ?? "neutral"}>
                              {humanize(r.status)}
                            </Badge>
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums text-xs">
                            {pct(r.evidenceScore ?? null)}
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums text-xs">
                            {num(r.citationCount)} / {num(r.inputRefCount)}
                            {r.droppedCitations ? (
                              <Badge tone="danger" className="ml-1">
                                {r.droppedCitations} dropped
                              </Badge>
                            ) : null}
                          </Td>
                          <Td className="whitespace-nowrap text-xs text-ink-500">
                            {formatDateTime(r.createdAt)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <ReviewDrawer
        reviewId={openReviewId}
        onClose={() => setOpenReviewId(null)}
        onChanged={refresh}
      />
      <RunDetailDrawer runId={openRunId} onClose={() => setOpenRunId(null)} />
    </div>
  );
}
