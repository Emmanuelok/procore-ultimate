import { and, eq } from "drizzle-orm";
import { ingestedRecords, ingestionRuns, ingestionSources, projects } from "@constructos/db";
import { AppError, badRequest } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { MAX_ROWS_PER_RUN, datasetDef } from "./datasets.js";

/**
 * M6 — Procore / Aconex connectors (spec Vol III M6; Domain Y #1046; Vol I
 * §0.7 #130-133).
 *
 * WHAT IS HERE NOW
 * ----------------
 * The complete transport for both vendors behind an injected HTTP client:
 * credential resolution from the environment, the Procore OAuth2
 * client-credentials exchange, the Aconex Basic + application-key scheme, the
 * documented endpoint paths, page-by-page pagination, and pure mapping from
 * each vendor's payload into this platform's ingestion-dataset rows. A pull
 * stages a real ingestion run with per-row provenance; the operator then
 * validates and commits it through the existing routes.
 *
 * WHAT HAS AND HAS NOT BEEN PROVEN — read this before trusting it
 * --------------------------------------------------------------
 * PROVEN BY FIXTURES (integrations/connectors.test.ts): URL construction
 * including query parameters, the auth headers each vendor receives, the
 * OAuth2 token exchange request and its response parsing, page-walking and its
 * termination conditions, the page cap, error propagation on non-200s, and
 * every mapping function.
 *
 * NEVER EXERCISED AGAINST A LIVE VENDOR: all of it. This deployment has no
 * network route to procore.com or to any Aconex instance and holds no
 * credentials for either, and the fixtures below were AUTHORED from the
 * vendors' published API shapes rather than captured from live responses. Two
 * consequences follow honestly:
 *   - Field names and envelope shapes are our best reading of the published
 *     documentation. Where a shape is known to vary (Aconex's JSON rendering
 *     of its XML search envelopes, in particular) the extractor is deliberately
 *     tolerant of several documented forms rather than pretending to certainty.
 *   - The first run against a real tenant should be treated as a discovery
 *     exercise: expect to adjust field names, not architecture.
 *
 * When credentials and a route are absent the pull route returns 501 and names
 * the exact environment variables and config keys an operator must supply. It
 * does not half-succeed and it does not pretend.
 */

/* ------------------------------------------------------------------ */
/* Injectable HTTP client                                              */
/* ------------------------------------------------------------------ */

export interface ConnectorHttpResponse {
  status: number;
  json(): Promise<unknown>;
  /** lower-cased response headers, where the transport exposes them */
  headers?: Record<string, string>;
}

export interface ConnectorHttpClient {
  get(url: string, headers?: Record<string, string>): Promise<ConnectorHttpResponse>;
  post(
    url: string,
    body: string,
    headers?: Record<string, string>,
  ): Promise<ConnectorHttpResponse>;
}

/** The real transport. Only ever constructed when credentials exist. */
export function createFetchConnectorClient(timeoutMs = 30_000): ConnectorHttpClient {
  const toResponse = async (res: Response): Promise<ConnectorHttpResponse> => {
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: res.status,
      headers,
      json: async () => {
        if (text.trim() === "") return null;
        return JSON.parse(text) as unknown;
      },
    };
  };
  return {
    async get(url, headers) {
      return toResponse(
        await fetch(url, {
          method: "GET",
          headers: { accept: "application/json", ...(headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    },
    async post(url, body, headers) {
      return toResponse(
        await fetch(url, {
          method: "POST",
          body,
          headers: { accept: "application/json", ...(headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    },
  };
}

interface FixtureKey {
  method: string | null;
  path: string;
  query: [string, string][];
  raw: string;
}

function parseFixtureKey(raw: string): FixtureKey {
  const spaceIdx = raw.indexOf(" ");
  let method: string | null = null;
  let rest = raw;
  if (spaceIdx > 0 && /^[A-Z]+$/.test(raw.slice(0, spaceIdx))) {
    method = raw.slice(0, spaceIdx);
    rest = raw.slice(spaceIdx + 1);
  }
  const qIdx = rest.indexOf("?");
  const path = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const query: [string, string][] = [];
  if (qIdx !== -1) {
    for (const [k, v] of new URLSearchParams(rest.slice(qIdx + 1))) query.push([k, v]);
  }
  return { method, path, query, raw };
}

/**
 * Fixture-backed fake. A key is `[METHOD ]url-or-path-suffix[?params]`, and it
 * matches a request when the method agrees, the request path ends with the
 * key's path, and every parameter named in the key is present with that value.
 *
 * That last rule is what lets one fixture stand for a paginated endpoint: a key
 * of `/rest/v1.0/vendors?company_id=c1` answers page 1, page 2 and page 3 alike,
 * while a key that also pins `page=2` beats it for that page. Most specific
 * wins — matches are scored by how many parameters they pin.
 */
export function createFixtureHttpClient(
  fixtures: Record<string, unknown>,
): ConnectorHttpClient {
  const keys = Object.keys(fixtures).map(parseFixtureKey);

  const lookup = (method: string, url: string): unknown => {
    if (url in fixtures) return fixtures[url];
    const qIdx = url.indexOf("?");
    const reqPath = qIdx === -1 ? url : url.slice(0, qIdx);
    const reqQuery = new URLSearchParams(qIdx === -1 ? "" : url.slice(qIdx + 1));
    let best: { score: number; key: FixtureKey } | null = null;
    for (const key of keys) {
      if (key.method !== null && key.method !== method) continue;
      if (!reqPath.endsWith(key.path)) continue;
      if (!key.query.every(([k, v]) => reqQuery.get(k) === v)) continue;
      const score = key.query.length * 10 + (key.method ? 1 : 0) + key.path.length / 1000;
      if (!best || score > best.score) best = { score, key };
    }
    return best ? fixtures[best.key.raw] : undefined;
  };

  const respond = (hit: unknown): ConnectorHttpResponse =>
    hit === undefined
      ? { status: 404, json: async () => ({ error: "fixture not found" }), headers: {} }
      : { status: 200, json: async () => hit, headers: {} };

  return {
    async get(url) {
      return respond(lookup("GET", url));
    },
    async post(url) {
      return respond(lookup("POST", url));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Requirements — what a real pull needs                               */
/* ------------------------------------------------------------------ */

export interface ConnectorRequirements {
  connector: "procore" | "aconex";
  credentials: string[];
  config: string[];
  env: string[];
  note: string;
}

export const PROCORE_ENV = {
  clientId: "PROCORE_CLIENT_ID",
  clientSecret: "PROCORE_CLIENT_SECRET",
  baseUrl: "PROCORE_BASE_URL",
  tokenUrl: "PROCORE_TOKEN_URL",
} as const;

export const ACONEX_ENV = {
  username: "ACONEX_USERNAME",
  password: "ACONEX_PASSWORD",
  applicationKey: "ACONEX_APPLICATION_KEY",
  baseUrl: "ACONEX_BASE_URL",
} as const;

export const PROCORE_DEFAULT_BASE_URL = "https://api.procore.com";
export const PROCORE_DEFAULT_TOKEN_URL = "https://login.procore.com/oauth/token";

export const PROCORE_REQUIREMENTS: ConnectorRequirements = {
  connector: "procore",
  credentials: [
    `OAuth 2.0 client id for a Procore developer app — env ${PROCORE_ENV.clientId} ` +
      "(held in env, never in source config)",
    `OAuth 2.0 client secret — env ${PROCORE_ENV.clientSecret}`,
    "A service account (or installed-app grant) on the target Procore company, so the " +
      "client_credentials exchange returns a token with access to it",
  ],
  config: [
    "procoreCompanyId (the remote company id) — on the ingestion source's config",
    "procoreProjectId (the remote project id; required for project-scoped datasets such as rfis)",
    `baseUrl — optional per-source override of env ${PROCORE_ENV.baseUrl} ` +
      `(default ${PROCORE_DEFAULT_BASE_URL})`,
  ],
  env: [PROCORE_ENV.clientId, PROCORE_ENV.clientSecret, PROCORE_ENV.baseUrl, PROCORE_ENV.tokenUrl],
  note:
    "The transport, the OAuth2 exchange, pagination and the mapping are implemented and tested " +
    "against authored fixtures; none of it has ever spoken to Procore. What is missing is " +
    "credentials and a network route, not code.",
};

export const ACONEX_REQUIREMENTS: ConnectorRequirements = {
  connector: "aconex",
  credentials: [
    `Aconex API username — env ${ACONEX_ENV.username} (an OAuth token where the instance ` +
      "supports one; this connector implements the documented Basic scheme)",
    `Aconex API password — env ${ACONEX_ENV.password}`,
    `An Aconex application key issued for this integration — env ${ACONEX_ENV.applicationKey}`,
  ],
  config: [
    "aconexProjectId (the remote project id) — on the ingestion source's config",
    `baseUrl — the regional Aconex instance (e.g. https://uk1.aconex.co.uk); per-source ` +
      `override of env ${ACONEX_ENV.baseUrl}, which has no default because the host is regional`,
  ],
  env: [ACONEX_ENV.username, ACONEX_ENV.password, ACONEX_ENV.applicationKey, ACONEX_ENV.baseUrl],
  note:
    "The transport, pagination and mapping are implemented and tested against authored " +
    "fixtures; none of it has ever spoken to an Aconex instance. Aconex renders its XML search " +
    "envelopes to JSON differently between versions, so the extractor accepts several " +
    "documented shapes rather than claiming certainty about one.",
};

export function connectorRequirements(kind: string): ConnectorRequirements {
  return kind === "procore" ? PROCORE_REQUIREMENTS : ACONEX_REQUIREMENTS;
}

/* ------------------------------------------------------------------ */
/* Credential resolution                                               */
/* ------------------------------------------------------------------ */

export interface ProcoreSettings {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  tokenUrl: string;
  procoreCompanyId: string;
  procoreProjectId: string | null;
}

export interface AconexSettings {
  username: string;
  password: string;
  applicationKey: string;
  baseUrl: string;
  aconexProjectId: string;
}

export interface Readiness<T> {
  ok: boolean;
  missingEnv: string[];
  missingConfig: string[];
  settings: T | null;
}

const cfgString = (config: Record<string, unknown>, key: string): string | null => {
  const v = config[key];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number") return String(v);
  return null;
};

const envString = (env: NodeJS.ProcessEnv, key: string): string | null => {
  const v = env[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

export function resolveProcoreSettings(
  env: NodeJS.ProcessEnv,
  config: Record<string, unknown>,
  opts: { requireProject?: boolean } = {},
): Readiness<ProcoreSettings> {
  const missingEnv: string[] = [];
  const missingConfig: string[] = [];
  const clientId = envString(env, PROCORE_ENV.clientId);
  const clientSecret = envString(env, PROCORE_ENV.clientSecret);
  if (!clientId) missingEnv.push(PROCORE_ENV.clientId);
  if (!clientSecret) missingEnv.push(PROCORE_ENV.clientSecret);
  const baseUrl =
    cfgString(config, "baseUrl") ?? envString(env, PROCORE_ENV.baseUrl) ?? PROCORE_DEFAULT_BASE_URL;
  const tokenUrl = envString(env, PROCORE_ENV.tokenUrl) ?? PROCORE_DEFAULT_TOKEN_URL;
  const procoreCompanyId = cfgString(config, "procoreCompanyId");
  if (!procoreCompanyId) missingConfig.push("procoreCompanyId");
  const procoreProjectId = cfgString(config, "procoreProjectId");
  if (opts.requireProject && !procoreProjectId) missingConfig.push("procoreProjectId");

  const ok = missingEnv.length === 0 && missingConfig.length === 0;
  return {
    ok,
    missingEnv,
    missingConfig,
    settings: ok
      ? {
          clientId: clientId!,
          clientSecret: clientSecret!,
          baseUrl: baseUrl.replace(/\/+$/, ""),
          tokenUrl,
          procoreCompanyId: procoreCompanyId!,
          procoreProjectId,
        }
      : null,
  };
}

export function resolveAconexSettings(
  env: NodeJS.ProcessEnv,
  config: Record<string, unknown>,
): Readiness<AconexSettings> {
  const missingEnv: string[] = [];
  const missingConfig: string[] = [];
  const username = envString(env, ACONEX_ENV.username);
  const password = envString(env, ACONEX_ENV.password);
  const applicationKey = envString(env, ACONEX_ENV.applicationKey);
  if (!username) missingEnv.push(ACONEX_ENV.username);
  if (!password) missingEnv.push(ACONEX_ENV.password);
  if (!applicationKey) missingEnv.push(ACONEX_ENV.applicationKey);
  const baseUrl = cfgString(config, "baseUrl") ?? envString(env, ACONEX_ENV.baseUrl);
  if (!baseUrl) missingEnv.push(ACONEX_ENV.baseUrl);
  const aconexProjectId = cfgString(config, "aconexProjectId");
  if (!aconexProjectId) missingConfig.push("aconexProjectId");

  const ok = missingEnv.length === 0 && missingConfig.length === 0;
  return {
    ok,
    missingEnv,
    missingConfig,
    settings: ok
      ? {
          username: username!,
          password: password!,
          applicationKey: applicationKey!,
          baseUrl: baseUrl!.replace(/\/+$/, ""),
          aconexProjectId: aconexProjectId!,
        }
      : null,
  };
}

/** The 501 an operator sees when a connector is not configured. */
export function notConfiguredError(
  kind: "procore" | "aconex",
  readiness: Readiness<unknown>,
): AppError {
  const requirements = connectorRequirements(kind);
  const parts: string[] = [];
  if (readiness.missingEnv.length > 0) {
    parts.push(`environment variable(s) ${readiness.missingEnv.join(", ")}`);
  }
  if (readiness.missingConfig.length > 0) {
    parts.push(`ingestion source config key(s) ${readiness.missingConfig.join(", ")}`);
  }
  return new AppError(
    501,
    `${kind} pull is not configured in this deployment — missing ${parts.join(" and ")}. ` +
      "Nothing was fetched and nothing was staged. " +
      requirements.note,
    {
      connector: requirements.connector,
      required: { credentials: requirements.credentials, config: requirements.config },
      missing: { env: readiness.missingEnv, config: readiness.missingConfig },
      env: requirements.env,
      note: requirements.note,
    },
  );
}

/* ------------------------------------------------------------------ */
/* Pure mapping functions (fixture-tested)                             */
/* ------------------------------------------------------------------ */

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

function get(raw: unknown, key: string): unknown {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
}

/**
 * Procore `GET /rest/v1.0/vendors` item → "vendors" dataset row.
 * Procore fields: id, name, address, city, country_code, business_phone,
 * email_address, website, trade_name/trades[].
 */
export function mapProcoreVendor(raw: unknown): Record<string, unknown> {
  const trades = get(raw, "trades");
  const tradeCodes = Array.isArray(trades)
    ? trades
        .map((t) => str(get(t, "name")) ?? str(t))
        .filter((t): t is string => Boolean(t))
        .join(";")
    : undefined;
  const row: Record<string, unknown> = {};
  const put = (key: string, v: string | undefined) => {
    if (v !== undefined) row[key] = v;
  };
  put("name", str(get(raw, "name")));
  put("address", str(get(raw, "address")));
  put("city", str(get(raw, "city")));
  put("country", str(get(raw, "country_code")));
  put("phone", str(get(raw, "business_phone")));
  put("email", str(get(raw, "email_address")));
  put("website", str(get(raw, "website")));
  put("tradeCodes", tradeCodes);
  put("externalId", str(get(raw, "id")));
  return row;
}

/**
 * Procore `GET /rest/v1.0/projects/{id}/rfis` item → "rfis" dataset row.
 * Procore statuses (open/closed/draft) map onto this platform's RFI statuses;
 * anything unrecognised is left unset so the field-module default applies.
 */
export function mapProcoreRfi(raw: unknown): Record<string, unknown> {
  const questions = get(raw, "questions");
  const firstQuestion = Array.isArray(questions) ? questions[0] : undefined;
  const question =
    str(get(firstQuestion, "plain_text_body")) ??
    str(get(firstQuestion, "body")) ??
    str(get(raw, "question"));
  const statusRaw = str(get(raw, "status"))?.toLowerCase();
  const status =
    statusRaw === "open" || statusRaw === "closed" || statusRaw === "draft"
      ? statusRaw
      : undefined;
  const row: Record<string, unknown> = {};
  const put = (key: string, v: string | undefined) => {
    if (v !== undefined) row[key] = v;
  };
  put("subject", str(get(raw, "subject")));
  put("question", question);
  put("proposedSolution", str(get(raw, "proposed_solution")));
  put("status", status);
  put("dueDate", str(get(raw, "due_date")));
  put("externalId", str(get(raw, "id")));
  return row;
}

/**
 * Aconex directory `SearchResults > Organization` entry → "vendors" row.
 * Aconex fields: OrganizationId, OrganizationName, TradingName, Address1,
 * City, Country, Phone, Email.
 */
export function mapAconexOrganization(raw: unknown): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const put = (key: string, v: string | undefined) => {
    if (v !== undefined) row[key] = v;
  };
  put("name", str(get(raw, "OrganizationName")) ?? str(get(raw, "TradingName")));
  put("address", str(get(raw, "Address1")));
  put("city", str(get(raw, "City")));
  put("country", str(get(raw, "Country")));
  put("phone", str(get(raw, "Phone")));
  put("email", str(get(raw, "Email")));
  put("externalId", str(get(raw, "OrganizationId")));
  return row;
}

/**
 * Aconex mail item (Mail Type "RFI") → "rfis" dataset row. Aconex models
 * RFIs as correspondence, so Subject becomes the subject and the body text
 * the question.
 */
export function mapAconexMail(raw: unknown): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const put = (key: string, v: string | undefined) => {
    if (v !== undefined) row[key] = v;
  };
  put("subject", str(get(raw, "Subject")));
  put("question", str(get(raw, "Body")) ?? str(get(raw, "TextBody")));
  put("dueDate", str(get(raw, "ResponseDate")));
  put("externalId", str(get(raw, "MailId")) ?? str(get(raw, "MailNo")));
  return row;
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_MAX_PAGES = 50;

export interface PageOptions {
  pageSize?: number;
  maxPages?: number;
}

/** A `Link:` header carries `rel="next"` while more pages exist (Procore). */
function linkHeaderHasNext(headers: Record<string, string> | undefined): boolean | null {
  const link = headers?.["link"];
  if (typeof link !== "string" || link.trim() === "") return null;
  return /rel="?next"?/i.test(link);
}

/**
 * Walk pages until a short page arrives, the `Link` header says there is no
 * next page, or the cap is reached. The cap is not paranoia: an unbounded
 * page-walk against a vendor API is how an import turns into an outage, and a
 * truncated pull that says so is better than one that never returns.
 */
async function walkPages(
  fetchPage: (page: number, pageSize: number) => Promise<unknown[] | { items: unknown[]; more: boolean | null }>,
  opts: PageOptions,
): Promise<{ items: unknown[]; pages: number; truncated: boolean }> {
  const pageSize = Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE);
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const items: unknown[] = [];
  let pages = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage(page, pageSize);
    const pageItems = Array.isArray(result) ? result : result.items;
    const more = Array.isArray(result) ? null : result.more;
    pages += 1;
    items.push(...pageItems);
    if (pageItems.length < pageSize) return { items, pages, truncated: false };
    if (more === false) return { items, pages, truncated: false };
    if (items.length >= MAX_ROWS_PER_RUN) return { items, pages, truncated: true };
  }
  return { items, pages, truncated: true };
}

/* ------------------------------------------------------------------ */
/* Procore                                                             */
/* ------------------------------------------------------------------ */

export interface ProcoreConnectorConfig {
  baseUrl: string;
  procoreCompanyId: string;
  procoreProjectId?: string;
}

export interface ProcoreToken {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
}

/**
 * Procore OAuth 2.0 client-credentials exchange.
 *
 *   POST {tokenUrl}                      (default https://login.procore.com/oauth/token)
 *   content-type: application/x-www-form-urlencoded
 *   grant_type=client_credentials&client_id=…&client_secret=…
 *   → 200 {"access_token":"…","token_type":"Bearer","expires_in":7200,"created_at":…}
 *
 * The token is held only for the duration of a pull. Nothing about it is
 * written to the ingestion source's config — `assertNoCredentialKeys` in the
 * ingestion module refuses credentials in config on purpose, and this is the
 * other half of that rule.
 */
export async function procoreAccessToken(
  http: ConnectorHttpClient,
  settings: Pick<ProcoreSettings, "tokenUrl" | "clientId" | "clientSecret">,
): Promise<ProcoreToken> {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
  }).toString();
  const res = await http.post(settings.tokenUrl, form, {
    "content-type": "application/x-www-form-urlencoded",
  });
  if (res.status !== 200) {
    throw new Error(
      `Procore OAuth token request failed (${res.status}) — check ${PROCORE_ENV.clientId}/` +
        `${PROCORE_ENV.clientSecret} and that the app is installed on the target company`,
    );
  }
  const body = await res.json();
  const accessToken = str(get(body, "access_token"));
  if (!accessToken) throw new Error("Procore OAuth token response contained no access_token");
  const expiresRaw = get(body, "expires_in");
  return {
    accessToken,
    expiresIn: typeof expiresRaw === "number" ? expiresRaw : 7200,
    tokenType: str(get(body, "token_type")) ?? "Bearer",
  };
}

export class ProcoreConnector {
  constructor(
    private readonly http: ConnectorHttpClient,
    private readonly config: ProcoreConnectorConfig,
    /** bearer token resolved OUTSIDE stored config — credentials never live in source rows */
    private readonly accessToken: string,
  ) {}

  static requirements(): ConnectorRequirements {
    return PROCORE_REQUIREMENTS;
  }

  /** Exchange credentials for a token and return a ready connector. */
  static async connect(
    http: ConnectorHttpClient,
    settings: ProcoreSettings,
  ): Promise<ProcoreConnector> {
    const token = await procoreAccessToken(http, settings);
    return new ProcoreConnector(
      http,
      {
        baseUrl: settings.baseUrl,
        procoreCompanyId: settings.procoreCompanyId,
        ...(settings.procoreProjectId ? { procoreProjectId: settings.procoreProjectId } : {}),
      },
      token.accessToken,
    );
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      // Procore requires the company on every REST call; without it the API
      // answers 403 even with a valid token.
      "procore-company-id": this.config.procoreCompanyId,
      accept: "application/json",
    };
  }

  private async page(label: string, url: string): Promise<{ items: unknown[]; more: boolean | null }> {
    const res = await this.http.get(url, this.headers());
    if (res.status !== 200) throw new Error(`Procore ${label} request failed (${res.status})`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`Procore ${label} response is not an array`);
    return { items: body, more: linkHeaderHasNext(res.headers) };
  }

  /** Vendors of the remote company, mapped to the "vendors" dataset. */
  async pullVendors(opts: PageOptions = {}): Promise<Record<string, unknown>[]> {
    const walked = await walkPages(
      (page, pageSize) =>
        this.page(
          "vendors",
          `${this.config.baseUrl}/rest/v1.0/vendors?company_id=${encodeURIComponent(
            this.config.procoreCompanyId,
          )}&page=${page}&per_page=${pageSize}`,
        ),
      opts,
    );
    return walked.items.map(mapProcoreVendor);
  }

  /** RFIs of the remote project, mapped to the "rfis" dataset. */
  async pullRfis(opts: PageOptions = {}): Promise<Record<string, unknown>[]> {
    if (!this.config.procoreProjectId) throw new Error("procoreProjectId is required for RFIs");
    const walked = await walkPages(
      (page, pageSize) =>
        this.page(
          "RFIs",
          `${this.config.baseUrl}/rest/v1.0/projects/${encodeURIComponent(
            this.config.procoreProjectId!,
          )}/rfis?company_id=${encodeURIComponent(
            this.config.procoreCompanyId,
          )}&page=${page}&per_page=${pageSize}`,
        ),
      opts,
    );
    return walked.items.map(mapProcoreRfi);
  }
}

/* ------------------------------------------------------------------ */
/* Aconex                                                              */
/* ------------------------------------------------------------------ */

export interface AconexConnectorConfig {
  baseUrl: string;
  aconexProjectId: string;
}

/**
 * Aconex renders its XML search envelopes to JSON differently between
 * versions and regional instances, so rather than assert one shape this walks
 * the documented candidates: a bare array, `{Key: [...]}`, `{SearchResults:
 * {Key: [...]}}`, and `{<Anything>Search: {SearchResults: {Key: [...]}}}`. A
 * single object where a list is expected is normalised to a one-item list,
 * because the XML→JSON rendering collapses single-element sequences.
 */
export function extractAconexItems(body: unknown, itemKey: string): unknown[] | null {
  const asList = (v: unknown): unknown[] | null => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return [v];
    return null;
  };
  if (Array.isArray(body)) return body;
  const direct = get(body, itemKey) ?? get(body, `${itemKey}s`);
  if (direct !== undefined) return asList(direct);
  const searchResults = get(body, "SearchResults");
  if (searchResults !== undefined) {
    const inner = get(searchResults, itemKey);
    if (inner !== undefined) return asList(inner);
    return asList(searchResults);
  }
  if (body && typeof body === "object") {
    for (const value of Object.values(body as Record<string, unknown>)) {
      const nested = get(value, "SearchResults");
      if (nested !== undefined) {
        const inner = get(nested, itemKey);
        if (inner !== undefined) return asList(inner);
        return asList(nested);
      }
    }
  }
  return null;
}

export class AconexConnector {
  constructor(
    private readonly http: ConnectorHttpClient,
    private readonly config: AconexConnectorConfig,
    private readonly authorizationHeader: string,
    private readonly applicationKey?: string,
  ) {}

  static requirements(): ConnectorRequirements {
    return ACONEX_REQUIREMENTS;
  }

  /**
   * Aconex authenticates with HTTP Basic plus an application key issued for
   * the integration. There is no token exchange to perform — the credentials
   * travel on every request — which is why this factory is synchronous while
   * Procore's is not.
   */
  static connect(http: ConnectorHttpClient, settings: AconexSettings): AconexConnector {
    const basic = Buffer.from(`${settings.username}:${settings.password}`, "utf8").toString(
      "base64",
    );
    return new AconexConnector(
      http,
      { baseUrl: settings.baseUrl, aconexProjectId: settings.aconexProjectId },
      `Basic ${basic}`,
      settings.applicationKey,
    );
  }

  private headers(): Record<string, string> {
    return {
      authorization: this.authorizationHeader,
      accept: "application/json",
      ...(this.applicationKey ? { "x-application-key": this.applicationKey } : {}),
    };
  }

  private async page(
    label: string,
    url: string,
    itemKey: string,
  ): Promise<{ items: unknown[]; more: boolean | null }> {
    const res = await this.http.get(url, this.headers());
    if (res.status !== 200) throw new Error(`Aconex ${label} request failed (${res.status})`);
    const body = await res.json();
    const items = extractAconexItems(body, itemKey);
    if (items === null) {
      throw new Error(
        `Aconex ${label} response contained no ${itemKey} list in any documented envelope shape`,
      );
    }
    return { items, more: null };
  }

  /** Project directory organizations, mapped to the "vendors" dataset. */
  async pullOrganizations(opts: PageOptions = {}): Promise<Record<string, unknown>[]> {
    const walked = await walkPages(
      (page, pageSize) =>
        this.page(
          "directory",
          `${this.config.baseUrl}/api/projects/${encodeURIComponent(
            this.config.aconexProjectId,
          )}/directory/organizations?page_number=${page}&page_size=${pageSize}`,
          "Organization",
        ),
      opts,
    );
    return walked.items.map(mapAconexOrganization);
  }

  /** RFI-type mail, mapped to the "rfis" dataset. */
  async pullRfiMail(opts: PageOptions = {}): Promise<Record<string, unknown>[]> {
    const walked = await walkPages(
      (page, pageSize) =>
        this.page(
          "mail",
          `${this.config.baseUrl}/api/projects/${encodeURIComponent(
            this.config.aconexProjectId,
          )}/mail?search_query=${encodeURIComponent("mailtype:RFI")}` +
            `&page_number=${page}&page_size=${pageSize}` +
            `&return_fields=${encodeURIComponent("subject,mailno,sentdate,corrtype,tostaff")}`,
          "Mail",
        ),
      opts,
    );
    return walked.items.map(mapAconexMail);
  }
}

/* ------------------------------------------------------------------ */
/* The pull — staging a run from a vendor                              */
/* ------------------------------------------------------------------ */

/** Which datasets each connector can pull today. */
export const CONNECTOR_DATASETS = {
  procore: ["vendors", "rfis"],
  aconex: ["vendors", "rfis"],
} as const;

export interface ConnectorPullInput {
  db: Db;
  source: typeof ingestionSources.$inferSelect;
  companyId: string;
  actorId: string;
  body: unknown;
  env?: NodeJS.ProcessEnv;
  /** injected in tests; the real transport is built only when creds resolve */
  http?: ConnectorHttpClient;
}

export interface ConnectorPullResult {
  runId: string;
  connector: string;
  dataset: string;
  fetched: number;
  staged: number;
  projectId: string | null;
  nextStep: string;
  provenanceNote: string;
}

interface PullBody {
  dataset: string;
  projectId: string | null;
  pageSize?: number;
  maxPages?: number;
}

function readPullBody(raw: unknown): PullBody {
  const body = (raw ?? {}) as Record<string, unknown>;
  const dataset = typeof body["dataset"] === "string" ? body["dataset"] : "vendors";
  const projectId = typeof body["projectId"] === "string" ? body["projectId"] : null;
  const pageSize = typeof body["pageSize"] === "number" ? body["pageSize"] : undefined;
  const maxPages = typeof body["maxPages"] === "number" ? body["maxPages"] : undefined;
  return {
    dataset,
    projectId,
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
  };
}

/**
 * Pull from a configured vendor and stage the result as an ingestion run.
 *
 * The run lands in `staging` with per-row provenance, exactly as a CSV upload
 * would; the operator then drives the existing validate and commit routes. A
 * connector pull is not a privileged path into the record — it is another way
 * to fill the same staging area, and it passes through the same validation.
 *
 * Order matters here and is deliberate: the source-kind guards run first (so a
 * csv source gets a useful 400 rather than a credentials lecture), then
 * credential resolution (so an unconfigured deployment gets the honest 501
 * whatever else the request said), and only then dataset validation.
 */
export async function connectorPull(input: ConnectorPullInput): Promise<ConnectorPullResult> {
  const { db, source, companyId, actorId } = input;
  const env = input.env ?? process.env;
  const kind = source.kind;

  if (kind === "csv") {
    throw badRequest("csv sources take file uploads — POST /ingestion/runs");
  }
  if (kind === "api_token") {
    throw badRequest("api_token sources receive machine pushes — POST /ingestion/push/:dataset");
  }
  if (kind !== "procore" && kind !== "aconex") {
    throw badRequest(`No connector is implemented for source kind "${kind}"`);
  }
  if (source.isActive !== 1) throw badRequest("Ingestion source is deactivated");

  const config = (source.config ?? {}) as Record<string, unknown>;
  const body = readPullBody(input.body);
  const wantsProjectScope = body.dataset === "rfis";

  const readiness =
    kind === "procore"
      ? resolveProcoreSettings(env, config, { requireProject: wantsProjectScope })
      : resolveAconexSettings(env, config);
  if (!readiness.ok || !readiness.settings) throw notConfiguredError(kind, readiness);

  const def = datasetDef(body.dataset);
  const supported = CONNECTOR_DATASETS[kind] as readonly string[];
  if (!def || !supported.includes(body.dataset)) {
    throw badRequest(
      `The ${kind} connector can pull: ${supported.join(", ")}. Received "${body.dataset}".`,
    );
  }

  const projectId = body.projectId ?? source.projectId ?? null;
  if (def.requiresProject && !projectId) {
    throw badRequest(
      `dataset ${def.dataset} requires a projectId on the pull request (the ConstructOS ` +
        "project the pulled rows belong to)",
    );
  }
  if (projectId) {
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!row) throw badRequest("projectId is not a project in this company");
  }

  const http = input.http ?? createFetchConnectorClient();
  const pageOpts: PageOptions = {
    ...(body.pageSize !== undefined ? { pageSize: body.pageSize } : {}),
    ...(body.maxPages !== undefined ? { maxPages: body.maxPages } : {}),
  };

  let rows: Record<string, unknown>[];
  if (kind === "procore") {
    const settings = readiness.settings as ProcoreSettings;
    const connector = await ProcoreConnector.connect(http, settings);
    rows =
      body.dataset === "rfis"
        ? await connector.pullRfis(pageOpts)
        : await connector.pullVendors(pageOpts);
  } else {
    const settings = readiness.settings as AconexSettings;
    const connector = AconexConnector.connect(http, settings);
    rows =
      body.dataset === "rfis"
        ? await connector.pullRfiMail(pageOpts)
        : await connector.pullOrganizations(pageOpts);
  }

  const capped = rows.slice(0, MAX_ROWS_PER_RUN);
  const runId = newId("irn");
  await db.insert(ingestionRuns).values({
    id: runId,
    companyId,
    projectId,
    sourceId: source.id,
    dataset: def.dataset,
    status: "staging",
    fileName: `${kind}:${def.dataset}`,
    totalRows: capped.length,
    startedBy: actorId,
  });
  const inserts: (typeof ingestedRecords.$inferInsert)[] = capped.map((payload, i) => {
    const extRaw = payload["externalId"];
    return {
      id: newId("irc"),
      runId,
      companyId,
      rowNumber: i + 1,
      externalId: typeof extRaw === "string" && extRaw.trim() !== "" ? extRaw.trim() : null,
      payload,
      status: "staged",
    };
  });
  for (let i = 0; i < inserts.length; i += 500) {
    await db.insert(ingestedRecords).values(inserts.slice(i, i + 500));
  }

  await appendLedger(db, {
    companyId,
    actorId,
    action: "create",
    objectType: "ingestion_run",
    objectId: runId,
    projectId,
    payload: {
      via: "connector_pull",
      connector: kind,
      dataset: def.dataset,
      sourceId: source.id,
      projectId,
      fetched: rows.length,
      staged: capped.length,
      truncated: rows.length > capped.length,
    },
    storePayload: true,
  });

  return {
    runId,
    connector: kind,
    dataset: def.dataset,
    fetched: rows.length,
    staged: capped.length,
    projectId,
    nextStep: `POST /ingestion/runs/${runId}/validate, then /commit`,
    provenanceNote:
      `Rows were fetched from ${kind} and staged unvalidated. Nothing has entered the record ` +
      "yet — validation and commit are separate, explicit, ledgered steps. This connector has " +
      "never been exercised against a live vendor API; review the first pull's staged rows " +
      "before committing them.",
  };
}
