/**
 * M6 — Procore / Aconex connector SCAFFOLDING (spec Vol III M6; Domain Y #1046).
 *
 * What this file honestly is: the typed shell of two vendor connectors — an
 * injectable HTTP client, the request paths each vendor documents, and PURE
 * mapping functions from each vendor's payload shape into this platform's
 * ingestion-dataset rows (unit-tested against fixtures).
 *
 * What it is NOT: a working integration. This deployment has no network route
 * to procore.com or aconex.com and holds no credentials for either. The pull
 * route in index.ts therefore returns 501 with the exact requirements listed
 * here, instead of pretending. When credentials and connectivity exist, the
 * `pull*` methods below become real by constructing the connector with a live
 * HTTP client — no mapping code changes.
 */

/* ------------------------------------------------------------------ */
/* Injectable HTTP client                                              */
/* ------------------------------------------------------------------ */

export interface ConnectorHttpResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface ConnectorHttpClient {
  get(url: string, headers?: Record<string, string>): Promise<ConnectorHttpResponse>;
}

/**
 * Fixture-backed fake for tests: serves canned JSON by exact URL, or by
 * matching the URL's path+query suffix. Unknown URLs get a 404.
 */
export function createFixtureHttpClient(
  fixtures: Record<string, unknown>,
): ConnectorHttpClient {
  return {
    async get(url) {
      const hit =
        url in fixtures
          ? fixtures[url]
          : Object.entries(fixtures).find(([k]) => url.endsWith(k))?.[1];
      if (hit === undefined) {
        return { status: 404, json: async () => ({ error: "fixture not found" }) };
      }
      return { status: 200, json: async () => hit };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Requirements — what a real pull would need                          */
/* ------------------------------------------------------------------ */

export interface ConnectorRequirements {
  connector: "procore" | "aconex";
  credentials: string[];
  config: string[];
  note: string;
}

export const PROCORE_REQUIREMENTS: ConnectorRequirements = {
  connector: "procore",
  credentials: [
    "OAuth 2.0 client id + client secret for a Procore developer app (held in env, never in source config)",
    "A service-account grant or an installed-app token for the target Procore company",
  ],
  config: [
    "baseUrl (e.g. https://api.procore.com)",
    "procoreCompanyId (the remote company id)",
    "procoreProjectId (the remote project id, for project-scoped pulls)",
  ],
  note:
    "This deployment has no network route to Procore and no credentials are configured. " +
    "Nothing was fetched and nothing was staged. The mapping functions are implemented and " +
    "tested against recorded fixtures; only the transport is missing.",
};

export const ACONEX_REQUIREMENTS: ConnectorRequirements = {
  connector: "aconex",
  credentials: [
    "Aconex API username + password (or OAuth token where the instance supports it), held in env",
    "An Aconex application key issued for this integration",
  ],
  config: [
    "baseUrl (the regional Aconex instance, e.g. https://uk1.aconex.co.uk)",
    "aconexProjectId (the remote project id)",
  ],
  note:
    "This deployment has no network route to Aconex and no credentials are configured. " +
    "Nothing was fetched and nothing was staged. The mapping functions are implemented and " +
    "tested against recorded fixtures; only the transport is missing.",
};

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
/* Connector shells                                                    */
/* ------------------------------------------------------------------ */

export interface ProcoreConnectorConfig {
  baseUrl: string;
  procoreCompanyId: string;
  procoreProjectId?: string;
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

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}` };
  }

  /** Vendors of the remote company, mapped to the "vendors" dataset. */
  async pullVendors(): Promise<Record<string, unknown>[]> {
    const url = `${this.config.baseUrl}/rest/v1.0/vendors?company_id=${this.config.procoreCompanyId}`;
    const res = await this.http.get(url, this.headers());
    if (res.status !== 200) throw new Error(`Procore vendors request failed (${res.status})`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("Procore vendors response is not an array");
    return body.map(mapProcoreVendor);
  }

  /** RFIs of the remote project, mapped to the "rfis" dataset. */
  async pullRfis(): Promise<Record<string, unknown>[]> {
    if (!this.config.procoreProjectId) throw new Error("procoreProjectId is required for RFIs");
    const url = `${this.config.baseUrl}/rest/v1.0/projects/${this.config.procoreProjectId}/rfis`;
    const res = await this.http.get(url, this.headers());
    if (res.status !== 200) throw new Error(`Procore RFIs request failed (${res.status})`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("Procore RFIs response is not an array");
    return body.map(mapProcoreRfi);
  }
}

export interface AconexConnectorConfig {
  baseUrl: string;
  aconexProjectId: string;
}

export class AconexConnector {
  constructor(
    private readonly http: ConnectorHttpClient,
    private readonly config: AconexConnectorConfig,
    private readonly authorizationHeader: string,
  ) {}

  static requirements(): ConnectorRequirements {
    return ACONEX_REQUIREMENTS;
  }

  private headers(): Record<string, string> {
    return { authorization: this.authorizationHeader };
  }

  /** Project directory organizations, mapped to the "vendors" dataset. */
  async pullOrganizations(): Promise<Record<string, unknown>[]> {
    const url = `${this.config.baseUrl}/api/projects/${this.config.aconexProjectId}/directory`;
    const res = await this.http.get(url, this.headers());
    if (res.status !== 200) throw new Error(`Aconex directory request failed (${res.status})`);
    const body = await res.json();
    const items = get(body, "Organizations");
    if (!Array.isArray(items)) throw new Error("Aconex directory response has no Organizations");
    return items.map(mapAconexOrganization);
  }

  /** RFI-type mail, mapped to the "rfis" dataset. */
  async pullRfiMail(): Promise<Record<string, unknown>[]> {
    const url = `${this.config.baseUrl}/api/projects/${this.config.aconexProjectId}/mail?mail_type=RFI`;
    const res = await this.http.get(url, this.headers());
    if (res.status !== 200) throw new Error(`Aconex mail request failed (${res.status})`);
    const body = await res.json();
    const items = get(body, "Mail");
    if (!Array.isArray(items)) throw new Error("Aconex mail response has no Mail array");
    return items.map(mapAconexMail);
  }
}
