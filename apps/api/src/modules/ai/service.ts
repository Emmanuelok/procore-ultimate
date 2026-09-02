/**
 * modules/ai/service — the audited model invocation core.
 *
 * Every model call on the platform goes through `runAgent`, which is the one
 * place that:
 *   · refuses when there is no key (503 AiDisabled) — nothing non-AI depends
 *     on it, and the refusal shape is part of the contract;
 *   · enforces the tenant's per-kind authorisation and daily budget before
 *     spending anything (Vol II X #1022) and books the usage after;
 *   · persists an `ai_runs` row for EVERY outcome (succeeded / failed /
 *     refused), so a truncated answer or a parse failure is as auditable as a
 *     good one (Vol I #774, X #1021);
 *   · validates the model's citations against the records actually supplied
 *     and drops the rest, because a fabricated id in an audit trail is worse
 *     than no citation at all (X #1019);
 *   · scores the evidence the run was given and records the prompt version,
 *     so an output can be explained after the fact (X #1017/#1018, #1027).
 *
 * The Anthropic client is reached through a replaceable factory
 * (`setAiClientFactory`) so the whole fleet is testable without a key and
 * without network access — see agents.test.ts.
 *
 * Deliberately NOT here: what any individual agent asks for (agents/*),
 * how a proposal is applied or reversed (actions.ts), or scheduling
 * (schedules.ts).
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { aiRuns } from "@constructos/db";
import type { AgentRunSource } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { AppError } from "../../lib/errors.js";
import { computeEvidenceScore } from "./evidence.js";
import {
  bookUsage,
  budgetVerdict,
  loadEffectivePolicy,
  readUsage,
  usageDate,
  type EffectivePolicy,
} from "./policy.js";
import { recordRunMeta } from "./run-meta.js";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** 503 with error name "AiDisabled" (exact shape required by the spec). */
export function aiDisabledError(): AppError {
  const err = new AppError(503, "Set ANTHROPIC_API_KEY to enable AI features");
  err.name = "AiDisabled";
  return err;
}

/** 429 with error name "AiBudgetExceeded" (Vol II X #1022). */
export function aiBudgetError(message: string, details?: unknown): AppError {
  const err = new AppError(429, message, details);
  err.name = "AiBudgetExceeded";
  return err;
}

/** 403 with error name "AiAgentDisabled" — the tenant switched this kind off. */
export function aiAgentDisabledError(message: string): AppError {
  const err = new AppError(403, message);
  err.name = "AiAgentDisabled";
  return err;
}

function upstreamError(message: string): AppError {
  const err = new AppError(502, message);
  err.name = "AiUpstreamError";
  return err;
}

function parseFailureError(): AppError {
  const err = new AppError(
    502,
    "The AI model returned an unparseable response; the run was recorded as failed",
  );
  err.name = "AiParseError";
  return err;
}

function truncationError(): AppError {
  const err = new AppError(
    502,
    "The AI model's output was cut off at the token limit; the run was recorded as failed",
  );
  err.name = "AiTruncated";
  return err;
}

function ungroundedError(): AppError {
  const err = new AppError(
    422,
    "The AI model cited records that were not supplied; the run was recorded as failed rather than stored as grounded",
  );
  err.name = "AiUngrounded";
  return err;
}

function refusalError(explanation?: string | null): AppError {
  const err = new AppError(
    422,
    explanation
      ? `The AI model declined this request: ${explanation}`
      : "The AI model declined this request; the run was recorded as refused",
  );
  err.name = "AiRefused";
  return err;
}

/* ------------------------------------------------------------------ */
/* Client (injectable)                                                 */
/* ------------------------------------------------------------------ */

/** The request shape `runAgent` sends. Narrower than the SDK's on purpose. */
export interface AiRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  betas?: string[];
  fallbacks?: string;
}

/**
 * The slice of the Anthropic client the platform uses. Declared as a method
 * so a test double (and the real SDK) are both assignable.
 */
export interface AiClientLike {
  beta: {
    messages: {
      create(params: AiRequest): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
}

export type AiClientFactory = (app: FastifyInstance) => AiClientLike | null;

const clients = new WeakMap<object, AiClientLike>();
let clientFactory: AiClientFactory | null = null;

/**
 * Replace how the client is obtained. Tests install a fake here and set
 * `app.appConfig.ANTHROPIC_API_KEY` so the fleet runs end to end with no key
 * and no network. Pass null to restore the real SDK.
 */
export function setAiClientFactory(factory: AiClientFactory | null): void {
  clientFactory = factory;
}

export function aiEnabled(app: FastifyInstance): boolean {
  return Boolean(app.appConfig.ANTHROPIC_API_KEY);
}

/** Lazily build one client per app instance; null when AI is disabled. */
export function getAiClient(app: FastifyInstance): AiClientLike | null {
  if (clientFactory) return clientFactory(app);
  const apiKey = app.appConfig.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  let client = clients.get(app.appConfig);
  if (!client) {
    client = new Anthropic({ apiKey }) as unknown as AiClientLike;
    clients.set(app.appConfig, client);
  }
  return client;
}

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                          */
/* ------------------------------------------------------------------ */

/**
 * Tolerant JSON extractor: strips markdown fences, then parses from the
 * first "{" to the last "}". Throws when no parseable object is present.
 */
export function extractJson(raw: string): unknown {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(text.slice(start, end + 1));
}

/** A ~`window`-char snippet centred on the first case-insensitive match. */
export function snippetAround(text: string, query: string, window = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const idx = clean.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return clean.slice(0, window);
  const start = Math.max(0, idx - Math.floor(window / 2));
  return clean.slice(start, start + window);
}

/** Escape LIKE/ILIKE metacharacters in user-supplied search input. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One numbered evidence snippet handed to the search agent. */
export interface SearchCandidate {
  type: string;
  id: string;
  label: string;
  snippet: string;
}

/** Render candidates as a numbered block the model must cite from. */
export function renderSnippets(candidates: SearchCandidate[]): string {
  return candidates
    .map(
      (c, i) =>
        `[${i + 1}] type=${c.type} id=${c.id} — ${c.label}\n${c.snippet}`,
    )
    .join("\n\n");
}

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Stable short hash of a prompt template — the run's `promptVersion`. */
export function promptVersion(system: string): string {
  return createHash("sha256").update(system).digest("hex").slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* Citation validation (#1019)                                         */
/* ------------------------------------------------------------------ */

export interface InputRef {
  type: string;
  id: string;
}

export interface CitationVerdict {
  kept: unknown[];
  dropped: unknown[];
}

/**
 * Keep only the citations that name a record actually supplied to the model.
 *
 * Citations shaped `{type,id}` are checked against `inputRefs`; anything of
 * another shape (the briefing agent cites snippet NUMBERS, for instance) is
 * left alone, because this function cannot know what it refers to and
 * silently deleting it would be a different kind of dishonesty.
 */
export function validateCitations(raw: unknown, inputRefs: InputRef[]): CitationVerdict {
  if (!Array.isArray(raw)) return { kept: [], dropped: [] };
  const allowed = new Set(inputRefs.map((r) => `${r.type}:${r.id}`));
  const byId = new Set(inputRefs.map((r) => r.id));
  const kept: unknown[] = [];
  const dropped: unknown[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      kept.push(c);
      continue;
    }
    const rec = c as Record<string, unknown>;
    const type = rec["type"];
    const id = rec["id"];
    if (typeof type !== "string" || typeof id !== "string") {
      kept.push(c);
      continue;
    }
    // A right id under a mistyped type is a type/id mix-up, not a fabrication:
    // keep it, corrected, rather than throwing away a real reference.
    if (allowed.has(`${type}:${id}`)) kept.push(c);
    else if (byId.has(id)) {
      const corrected = inputRefs.find((r) => r.id === id)!;
      kept.push({ ...rec, type: corrected.type });
    } else dropped.push(c);
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------------ */
/* Cost estimation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Micro-units of USD per token, by model family. This is an ESTIMATE and is
 * always returned alongside its basis so no page can render it as a fact the
 * platform holds. Unknown models fall back to the most expensive entry so a
 * budget is never silently under-counted.
 */
const MODEL_RATES: Array<{ prefix: string; inputMicros: number; outputMicros: number }> = [
  { prefix: "claude-opus", inputMicros: 15, outputMicros: 75 },
  { prefix: "claude-sonnet", inputMicros: 3, outputMicros: 15 },
  { prefix: "claude-haiku", inputMicros: 1, outputMicros: 5 },
];

export function estimateCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { micros: number; basis: string } {
  const rate = MODEL_RATES.find((r) => model.startsWith(r.prefix)) ?? MODEL_RATES[0]!;
  return {
    micros: Math.round(inputTokens * rate.inputMicros + outputTokens * rate.outputMicros),
    basis: `${rate.prefix}: ${rate.inputMicros} µUSD/input token, ${rate.outputMicros} µUSD/output token`,
  };
}

/* ------------------------------------------------------------------ */
/* runAgent                                                            */
/* ------------------------------------------------------------------ */

export interface RunAgentOptions<T> {
  app: FastifyInstance;
  /** present for a user-initiated run; omitted for a scheduled/system run */
  req?: FastifyRequest;
  /** required when `req` is absent */
  companyId?: string;
  /** null for a system actor (scheduled runs) */
  actorId?: string | null;
  source?: AgentRunSource;
  sourceRef?: string | null;
  agentKind: string;
  projectId?: string | null;
  system: string;
  /** plain text or content blocks (e.g. image + instruction) */
  user: string | Anthropic.Beta.BetaContentBlockParam[];
  /** provenance of every record fed into the prompt */
  inputRefs: InputRef[];
  maxTokens?: number;
  /** when set, the output is JSON-extracted + validated against this schema */
  schema?: z.ZodType<T>;
  /** fail the run when no citation survives validation */
  requireCitations?: boolean;
  agentVersion?: string;
  dataCategories?: string[];
  /** characters of grounded context in the prompt (feeds the evidence score) */
  contextChars?: number;
  /** the policy already resolved by the caller, to avoid a second lookup */
  policy?: EffectivePolicy;
}

export interface RunAgentResult<T> {
  runId: string;
  text: string;
  json?: T;
  grounding: {
    citations: unknown[];
    dropped: number;
    evidenceScore: number | null;
    inputRefs: number;
  };
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
  policy: EffectivePolicy;
}

const PROMPT_PERSIST_LIMIT = 20_000;
const AGENT_VERSION = "2026.09";

/**
 * Invoke the model once, measure latency and always persist an aiRuns row
 * (succeeded / failed / refused) so every invocation is auditable.
 */
export async function runAgent<T = unknown>(
  opts: RunAgentOptions<T>,
): Promise<RunAgentResult<T>> {
  const { app, req } = opts;
  const companyId = opts.companyId ?? req?.companyId;
  if (!companyId) throw new AppError(500, "runAgent needs a company context");
  const actorId = opts.actorId !== undefined ? opts.actorId : (req?.user?.id ?? null);
  const source: AgentRunSource = opts.source ?? (req ? "user" : "system");

  const client = getAiClient(app);
  if (!client) throw aiDisabledError();

  /* ---- authorisation + budget, BEFORE anything is spent (#1022) ---- */
  const policy = opts.policy ?? (await loadEffectivePolicy(app, companyId, opts.agentKind));
  if (!policy.enabled) {
    throw aiAgentDisabledError(
      `The "${opts.agentKind}" agent is disabled for this company by policy`,
    );
  }
  const today = usageDate(new Date());
  const usedToday = await readUsage(app.db, companyId, today, opts.agentKind);
  const verdict = budgetVerdict(policy, usedToday);
  if (!verdict.allowed) throw aiBudgetError(verdict.reason, verdict.detail);

  const model = app.appConfig.AI_MODEL;
  const runId = newId("airun");
  const version = promptVersion(opts.system);
  const promptText =
    typeof opts.user === "string"
      ? opts.user
      : opts.user
          .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text")
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .join("\n");

  const baseRow = {
    id: runId,
    companyId,
    projectId: opts.projectId ?? null,
    agentKind: opts.agentKind,
    model,
    // ai_runs.requested_by is NOT NULL: a system run is recorded as "system"
    // rather than borrowing a person's identity.
    requestedBy: actorId ?? "system",
    inputRefs: opts.inputRefs as unknown[],
    prompt: promptText.slice(0, PROMPT_PERSIST_LIMIT),
  };

  const evidence = computeEvidenceScore({
    inputRefs: opts.inputRefs,
    contextChars: opts.contextChars ?? promptText.length,
    citationsRequired: opts.requireCitations ?? false,
  });

  const writeMeta = async (extra: {
    citationCount: number;
    droppedCitations: number;
  }): Promise<void> => {
    await recordRunMeta(app.db, {
      runId,
      companyId,
      projectId: opts.projectId ?? null,
      agentKind: opts.agentKind,
      promptVersion: version,
      agentVersion: opts.agentVersion ?? AGENT_VERSION,
      source,
      sourceRef: opts.sourceRef ?? null,
      evidenceScore: evidence.score,
      evidenceBasis: evidence.basis,
      citationCount: extra.citationCount,
      droppedCitations: extra.droppedCitations,
      inputRefCount: opts.inputRefs.length,
      dataCategories: opts.dataCategories ?? [],
    });
  };

  const started = Date.now();
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await app.db.insert(aiRuns).values({
      ...baseRow,
      latencyMs: Date.now() - started,
      status: "failed",
      error: message.slice(0, 2000),
    });
    await writeMeta({ citationCount: 0, droppedCitations: 0 });
    await bookUsage(app.db, companyId, today, opts.agentKind, {
      runs: 1,
      failures: 1,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
    });
    throw upstreamError(`AI model call failed: ${message.slice(0, 300)}`);
  }

  const latencyMs = Date.now() - started;
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const cost = estimateCostMicros(model, inputTokens, outputTokens);
  const usage = { inputTokens, outputTokens };

  const book = (failed: boolean) =>
    bookUsage(app.db, companyId, today, opts.agentKind, {
      runs: 1,
      failures: failed ? 1 : 0,
      inputTokens,
      outputTokens,
      costMicros: cost.micros,
    });

  if (response.stop_reason === "refusal") {
    const explanation = response.stop_details?.explanation ?? null;
    await app.db.insert(aiRuns).values({
      ...baseRow,
      ...usage,
      latencyMs,
      output: text || null,
      status: "refused",
      error: explanation,
    });
    await writeMeta({ citationCount: 0, droppedCitations: 0 });
    await book(true);
    throw refusalError(explanation);
  }

  // A truncated answer is not a succeeded run: the JSON is usually invalid
  // and, for a prose agent, the last sentence is simply missing.
  if (response.stop_reason === "max_tokens") {
    await app.db.insert(aiRuns).values({
      ...baseRow,
      ...usage,
      latencyMs,
      output: text || null,
      status: "failed",
      error: `Output truncated at max_tokens (${opts.maxTokens ?? 16000})`,
    });
    await writeMeta({ citationCount: 0, droppedCitations: 0 });
    await book(true);
    throw truncationError();
  }

  let json: T | undefined;
  if (opts.schema) {
    try {
      json = opts.schema.parse(extractJson(text));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await app.db.insert(aiRuns).values({
        ...baseRow,
        ...usage,
        latencyMs,
        output: text,
        status: "failed",
        error: `Output parse failure: ${message.slice(0, 1800)}`,
      });
      await writeMeta({ citationCount: 0, droppedCitations: 0 });
      await book(true);
      throw parseFailureError();
    }
  }

  const rawCitations = json && typeof json === "object"
    ? (json as { citations?: unknown }).citations
    : undefined;
  const { kept, dropped } = validateCitations(rawCitations, opts.inputRefs);
  // The model's own object is corrected in place so what the queue stores and
  // what the UI renders as a chip are the validated set, not the claimed one.
  if (Array.isArray(rawCitations) && json && typeof json === "object") {
    (json as { citations?: unknown }).citations = kept;
  }

  if (opts.requireCitations && kept.length === 0) {
    await app.db.insert(aiRuns).values({
      ...baseRow,
      ...usage,
      latencyMs,
      output: text,
      outputJson: json ?? null,
      citations: [],
      status: "failed",
      error:
        dropped.length > 0
          ? `Every citation named a record that was not supplied (${dropped.length} dropped)`
          : "The agent returned no citations but its output requires them",
    });
    await writeMeta({ citationCount: 0, droppedCitations: dropped.length });
    await book(true);
    throw ungroundedError();
  }

  await app.db.insert(aiRuns).values({
    ...baseRow,
    ...usage,
    latencyMs,
    output: text,
    outputJson: json ?? null,
    citations: kept,
    status: "succeeded",
  });
  await writeMeta({ citationCount: kept.length, droppedCitations: dropped.length });
  await book(false);

  return {
    runId,
    text,
    json,
    grounding: {
      citations: kept,
      dropped: dropped.length,
      evidenceScore: evidence.score,
      inputRefs: opts.inputRefs.length,
    },
    usage: { inputTokens, outputTokens, costMicros: cost.micros },
    policy,
  };
}
