import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { aiRuns } from "@constructos/db";
import type { AiAgentKind } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { AppError } from "../../lib/errors.js";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** 503 with error name "AiDisabled" (exact shape required by the spec). */
export function aiDisabledError(): AppError {
  const err = new AppError(503, "Set ANTHROPIC_API_KEY to enable AI features");
  err.name = "AiDisabled";
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
/* Client                                                              */
/* ------------------------------------------------------------------ */

const clients = new WeakMap<object, Anthropic>();

export function aiEnabled(app: FastifyInstance): boolean {
  return Boolean(app.appConfig.ANTHROPIC_API_KEY);
}

/** Lazily build one client per app instance; null when AI is disabled. */
export function getAiClient(app: FastifyInstance): Anthropic | null {
  const apiKey = app.appConfig.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  let client = clients.get(app.appConfig);
  if (!client) {
    client = new Anthropic({ apiKey });
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

/* ------------------------------------------------------------------ */
/* runAgent — the audited model invocation core                        */
/* ------------------------------------------------------------------ */

export interface InputRef {
  type: string;
  id: string;
}

export interface RunAgentOptions<T> {
  app: FastifyInstance;
  req: FastifyRequest;
  agentKind: AiAgentKind;
  projectId?: string | null;
  system: string;
  /** plain text or content blocks (e.g. image + instruction) */
  user: string | Anthropic.Beta.BetaContentBlockParam[];
  /** provenance of every record fed into the prompt */
  inputRefs: InputRef[];
  maxTokens?: number;
  /** when set, the output is JSON-extracted + validated against this schema */
  schema?: z.ZodType<T>;
}

export interface RunAgentResult<T> {
  runId: string;
  text: string;
  json?: T;
}

const PROMPT_PERSIST_LIMIT = 20_000;

/**
 * Invoke the model once, measure latency and always persist an aiRuns row
 * (succeeded / failed / refused) so every invocation is auditable.
 */
export async function runAgent<T = unknown>(
  opts: RunAgentOptions<T>,
): Promise<RunAgentResult<T>> {
  const { app, req } = opts;
  const client = getAiClient(app);
  if (!client) throw aiDisabledError();

  const companyId = req.companyId!;
  const model = app.appConfig.AI_MODEL;
  const runId = newId("airun");
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
    requestedBy: req.user!.id,
    inputRefs: opts.inputRefs as unknown[],
    prompt: promptText.slice(0, PROMPT_PERSIST_LIMIT),
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
    throw upstreamError(`AI model call failed: ${message.slice(0, 300)}`);
  }

  const latencyMs = Date.now() - started;
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

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
    throw refusalError(explanation);
  }

  let json: T | undefined;
  let citations: unknown[] = [];
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
      throw parseFailureError();
    }
    const cited = (json as { citations?: unknown }).citations;
    if (Array.isArray(cited)) citations = cited;
  }

  await app.db.insert(aiRuns).values({
    ...baseRow,
    ...usage,
    latencyMs,
    output: text,
    outputJson: json ?? null,
    citations,
    status: "succeeded",
  });

  return { runId, text, json };
}
