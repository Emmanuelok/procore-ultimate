/**
 * The one door this module uses to reach an identity provider.
 *
 * Every outbound call in the OIDC flow — the discovery document, the JWKS,
 * the token exchange, userinfo — goes through this interface and nothing
 * calls `fetch` directly. That is not a testing convenience bolted on
 * afterwards: an authentication flow whose failure modes cannot be exercised
 * is an authentication flow whose failure modes are untested, and the
 * interesting cases here (a JWKS that rotates mid-flow, a token endpoint that
 * answers `invalid_grant`, a discovery URL that resolves to an HTML error
 * page) never happen on demand against a real provider.
 *
 * The production client is `createFetchSsoClient`. Tests register
 * `createStubSsoClient` on the database handle and drive the whole protocol
 * against fixtures authored from the OIDC Core / RFC 8414 / RFC 7636 specs.
 */
import type { Db } from "../../lib/db.js";

export interface SsoHttpResponse {
  status: number;
  body: string;
  /** lowercased header names; only the few we act on are guaranteed present */
  headers?: Record<string, string>;
}

export interface SsoHttpClient {
  get(url: string, headers?: Record<string, string>): Promise<SsoHttpResponse>;
  post(url: string, body: string, headers: Record<string, string>): Promise<SsoHttpResponse>;
}

export interface RecordedSsoCall {
  method: "GET" | "POST";
  url: string;
  /** form-encoded or JSON request body; null for GET */
  body: string | null;
  headers: Record<string, string>;
}

/**
 * The production transport. Bounded by a timeout and a body cap, and it
 * refuses to follow redirects: a token endpoint that 302s is a token endpoint
 * that has been tampered with, and silently chasing the hop would hand the
 * client secret to whatever answered.
 */
export function createFetchSsoClient(timeoutMs = 8_000, bodyLimit = 512_000): SsoHttpClient {
  const read = async (res: Response): Promise<SsoHttpResponse> => {
    let text = "";
    try {
      text = (await res.text()).slice(0, bodyLimit);
    } catch {
      text = "";
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: res.status, body: text, headers };
  };
  return {
    async get(url, headers = {}) {
      const res = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...headers },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return read(res);
    },
    async post(url, body, headers) {
      const res = await fetch(url, {
        method: "POST",
        body,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return read(res);
    },
  };
}

/**
 * Test transport: a scripted responder plus a call log. `respond` may return a
 * response or throw, so "the provider is unreachable" is as testable as "the
 * provider said no".
 */
export function createStubSsoClient(
  respond: (call: RecordedSsoCall) => SsoHttpResponse,
): SsoHttpClient & { calls: RecordedSsoCall[] } {
  const calls: RecordedSsoCall[] = [];
  return {
    calls,
    async get(url, headers = {}) {
      const call: RecordedSsoCall = { method: "GET", url, body: null, headers };
      calls.push(call);
      return respond(call);
    },
    async post(url, body, headers) {
      const call: RecordedSsoCall = { method: "POST", url, body, headers };
      calls.push(call);
      return respond(call);
    },
  };
}

/*
 * One client per database handle, exactly as the webhook dispatcher does it
 * (modules/integrations/dispatcher.ts). A test file may hold several apps at
 * once; a WeakMap keyed on the handle is both the right scope and
 * self-cleaning, and guarantees one app's stub never answers another's call.
 */
const clients = new WeakMap<object, SsoHttpClient>();

export function registerSsoHttpClient(db: Db, client: SsoHttpClient): void {
  clients.set(db as object, client);
}

export function clearSsoHttpClient(db: Db): void {
  clients.delete(db as object);
}

export function getSsoHttpClient(db: Db): SsoHttpClient | undefined {
  return clients.get(db as object);
}
