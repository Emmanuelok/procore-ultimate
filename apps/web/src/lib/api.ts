/**
 * Minimal typed API client. Attaches the bearer token and tenant header,
 * refreshes the access token once on 401, and throws ApiClientError with the
 * server's message otherwise.
 */

const ACCESS_KEY = "constructos.access";
const REFRESH_KEY = "constructos.refresh";
const COMPANY_KEY = "constructos.company";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export const tokenStore = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  get companyId() {
    return localStorage.getItem(COMPANY_KEY);
  },
  set(tokens: { accessToken: string; refreshToken: string }) {
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  },
  setCompany(companyId: string) {
    localStorage.setItem(COMPANY_KEY, companyId);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(COMPANY_KEY);
  },
};

let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = tokenStore.refresh;
      if (!refreshToken) return false;
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { accessToken: string; refreshToken: string };
      tokenStore.set(body);
      return true;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export interface RequestOptions {
  /** raw body (e.g. FormData) — bypasses JSON serialization */
  raw?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  const access = tokenStore.access;
  if (access) headers["authorization"] = `Bearer ${access}`;
  const companyId = tokenStore.companyId;
  if (companyId) headers["x-company-id"] = companyId;

  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (options.raw) {
      payload = body as BodyInit;
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }

  const res = await fetch(path, { method, headers, body: payload, signal: options.signal });

  if (res.status === 401 && !retried && tokenStore.refresh) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(method, path, body, options, true);
    tokenStore.clear();
    window.location.assign("/login");
  }

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message =
      isJson && data && typeof data === "object" && "message" in data
        ? String((data as { message: unknown }).message)
        : `Request failed (${res.status})`;
    throw new ApiClientError(res.status, message, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>("POST", path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>("PUT", path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>("PATCH", path, body, options),
  del: <T>(path: string, options?: RequestOptions) =>
    request<T>("DELETE", path, undefined, options),
  /** Upload FormData (multipart). */
  upload: <T>(path: string, form: FormData, options?: RequestOptions) =>
    request<T>("POST", path, form, { ...options, raw: true }),
};

/** Build a download/view URL that carries auth via query is NOT supported —
 * use fetch + blob for file downloads. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const headers: Record<string, string> = {};
  const access = tokenStore.access;
  if (access) headers["authorization"] = `Bearer ${access}`;
  const companyId = tokenStore.companyId;
  if (companyId) headers["x-company-id"] = companyId;
  const res = await fetch(path, { headers });
  if (!res.ok) throw new ApiClientError(res.status, `Download failed (${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
