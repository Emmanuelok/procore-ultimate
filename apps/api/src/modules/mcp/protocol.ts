/**
 * JSON-RPC 2.0 framing for the Model Context Protocol endpoint (#126-127).
 *
 * Everything in this file is PURE: parse a request, validate it against the
 * envelope rules, build a response or an error. No database, no Fastify, no
 * clock. That is what makes the protocol layer testable in milliseconds and
 * what keeps the transport (a single POST) separable from the semantics.
 *
 * The JSON-RPC rules that actually bite, and are therefore all enforced here:
 *  - `jsonrpc` must be exactly "2.0".
 *  - `id` may be a string, a number or absent. ABSENT MEANS NOTIFICATION and a
 *    notification gets NO response at all — not `null`, not an empty object.
 *  - A batch is an array; an empty array is itself an error (-32600).
 *  - An error response carries `code`, `message` and optionally `data`, and
 *    never a `result` alongside it.
 */

export const JSONRPC_VERSION = "2.0";

/** The reserved JSON-RPC error codes, plus the one application code we use. */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Application-level: the caller is authenticated but not permitted. */
  forbidden: -32001,
  /** Application-level: the capability is not present in this deployment. */
  unavailable: -32002,
} as const;

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: string;
  id?: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  result?: unknown;
  error?: RpcErrorBody;
}

export interface ParsedCall {
  id: RpcId;
  /** true when the caller sent no id: a notification expects no response */
  notification: boolean;
  method: string;
  params: Record<string, unknown>;
}

export type ParseOutcome =
  | { ok: true; call: ParsedCall }
  | { ok: false; id: RpcId; error: RpcErrorBody };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one JSON-RPC envelope. */
export function parseCall(raw: unknown): ParseOutcome {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      id: null,
      error: { code: RPC_ERRORS.invalidRequest, message: "A JSON-RPC request must be an object" },
    };
  }
  const rawId = raw["id"];
  const idPresent = Object.hasOwn(raw, "id") && rawId !== undefined;
  const id: RpcId =
    typeof rawId === "string" || typeof rawId === "number" ? rawId : idPresent ? null : null;
  if (idPresent && typeof rawId !== "string" && typeof rawId !== "number" && rawId !== null) {
    return {
      ok: false,
      id: null,
      error: { code: RPC_ERRORS.invalidRequest, message: "id must be a string, a number or null" },
    };
  }
  if (raw["jsonrpc"] !== JSONRPC_VERSION) {
    return {
      ok: false,
      id,
      error: { code: RPC_ERRORS.invalidRequest, message: 'jsonrpc must be exactly "2.0"' },
    };
  }
  const method = raw["method"];
  if (typeof method !== "string" || method === "") {
    return {
      ok: false,
      id,
      error: { code: RPC_ERRORS.invalidRequest, message: "method must be a non-empty string" },
    };
  }
  const params = raw["params"];
  if (params !== undefined && !isPlainObject(params)) {
    return {
      ok: false,
      id,
      error: {
        code: RPC_ERRORS.invalidParams,
        message: "params must be an object — positional params are not supported",
      },
    };
  }
  return {
    ok: true,
    call: {
      id,
      notification: !idPresent,
      method,
      params: (params as Record<string, unknown>) ?? {},
    },
  };
}

export function rpcResult(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcError(
  id: RpcId,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/**
 * Split a body into calls. Returns the batch flag so the caller can answer a
 * batch with an array and a single call with an object, which the spec
 * requires and clients do notice.
 */
export function splitBatch(
  body: unknown,
): { batch: boolean; calls: unknown[] } | { batch: false; calls: null } {
  if (Array.isArray(body)) return { batch: true, calls: body };
  return { batch: false, calls: [body] };
}

/**
 * Map an HTTP status the platform returned into the JSON-RPC error a client
 * should see. The mapping is deliberately lossy in one direction only: a 403
 * stays a permission error and never becomes "tool not found", because an MCP
 * client that retries a forbidden call as if it were a typo is worse than one
 * that reports the refusal.
 */
export function errorForStatus(status: number): number {
  if (status === 400 || status === 422) return RPC_ERRORS.invalidParams;
  if (status === 401 || status === 403) return RPC_ERRORS.forbidden;
  if (status === 404) return RPC_ERRORS.unavailable;
  return RPC_ERRORS.internal;
}
