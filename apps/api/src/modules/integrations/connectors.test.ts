import { describe, expect, it } from "vitest";
import {
  ACONEX_ENV,
  AconexConnector,
  PROCORE_DEFAULT_BASE_URL,
  PROCORE_DEFAULT_TOKEN_URL,
  PROCORE_ENV,
  ProcoreConnector,
  createFixtureHttpClient,
  extractAconexItems,
  notConfiguredError,
  procoreAccessToken,
  resolveAconexSettings,
  resolveProcoreSettings,
  type ConnectorHttpClient,
  type ConnectorHttpResponse,
} from "../ingestion/connectors.js";

/**
 * Connector transport tests (Vol I §0.7 #130-133).
 *
 * EVERYTHING HERE IS FIXTURE-DRIVEN AND NOTHING HERE HAS EVER TOUCHED A LIVE
 * VENDOR API. The fixtures were authored from Procore's and Aconex's published
 * request/response shapes, not captured from real traffic. What these tests
 * genuinely prove is that the code we wrote does what we intended: the right
 * URL with the right query parameters, the right auth headers, a correct
 * OAuth2 client-credentials exchange, page-walking that terminates, and
 * mapping into ingestion-dataset rows. What they cannot prove is that our
 * reading of the vendors' documentation is right. That is a credentials-and-
 * network gap, and it is stated rather than papered over.
 */

/** Wraps a fixture client so a test can assert on the headers each call got. */
function recording(inner: ConnectorHttpClient) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] =
    [];
  const client: ConnectorHttpClient = {
    async get(url, headers): Promise<ConnectorHttpResponse> {
      calls.push({ method: "GET", url, headers: headers ?? {} });
      return inner.get(url, headers);
    },
    async post(url, body, headers): Promise<ConnectorHttpResponse> {
      calls.push({ method: "POST", url, headers: headers ?? {}, body });
      return inner.post(url, body, headers);
    },
  };
  return { client, calls };
}

const TOKEN_FIXTURE = {
  access_token: "procore-access-token",
  token_type: "Bearer",
  expires_in: 7200,
  created_at: 1_700_000_000,
};

const procoreEnv = {
  [PROCORE_ENV.clientId]: "pc-client",
  [PROCORE_ENV.clientSecret]: "pc-secret",
} as NodeJS.ProcessEnv;

const aconexEnv = {
  [ACONEX_ENV.username]: "acx-user",
  [ACONEX_ENV.password]: "acx-pass",
  [ACONEX_ENV.applicationKey]: "acx-app-key",
  [ACONEX_ENV.baseUrl]: "https://uk1.aconex.example",
} as NodeJS.ProcessEnv;

/* ------------------------------------------------------------------ */
/* Credential resolution and the honest 501                            */
/* ------------------------------------------------------------------ */

describe("connector credential resolution", () => {
  it("names the exact missing env vars and config keys for Procore", () => {
    const readiness = resolveProcoreSettings({}, {});
    expect(readiness.ok).toBe(false);
    expect(readiness.settings).toBeNull();
    expect(readiness.missingEnv).toEqual([PROCORE_ENV.clientId, PROCORE_ENV.clientSecret]);
    expect(readiness.missingConfig).toEqual(["procoreCompanyId"]);
  });

  it("requires procoreProjectId only for project-scoped datasets", () => {
    const config = { procoreCompanyId: "9001" };
    expect(resolveProcoreSettings(procoreEnv, config).ok).toBe(true);
    const scoped = resolveProcoreSettings(procoreEnv, config, { requireProject: true });
    expect(scoped.ok).toBe(false);
    expect(scoped.missingConfig).toEqual(["procoreProjectId"]);
  });

  it("defaults the Procore hosts and lets a source override the base URL", () => {
    const withDefaults = resolveProcoreSettings(procoreEnv, { procoreCompanyId: "9001" });
    expect(withDefaults.settings?.baseUrl).toBe(PROCORE_DEFAULT_BASE_URL);
    expect(withDefaults.settings?.tokenUrl).toBe(PROCORE_DEFAULT_TOKEN_URL);
    const overridden = resolveProcoreSettings(
      { ...procoreEnv, [PROCORE_ENV.baseUrl]: "https://api.env.example" },
      { procoreCompanyId: "9001", baseUrl: "https://api.source.example/" },
    );
    // the per-source value wins over env, and a trailing slash is normalised
    expect(overridden.settings?.baseUrl).toBe("https://api.source.example");
  });

  it("requires a regional base URL for Aconex because there is no sane default", () => {
    const readiness = resolveAconexSettings({}, {});
    expect(readiness.missingEnv).toContain(ACONEX_ENV.baseUrl);
    expect(readiness.missingEnv).toContain(ACONEX_ENV.applicationKey);
    expect(readiness.missingConfig).toEqual(["aconexProjectId"]);
    expect(resolveAconexSettings(aconexEnv, { aconexProjectId: "PRJ1" }).ok).toBe(true);
  });

  it("turns an unconfigured connector into a 501 that names env vars, not a vague failure", () => {
    const err = notConfiguredError("procore", resolveProcoreSettings({}, {}));
    expect(err.statusCode).toBe(501);
    expect(err.message).toContain(PROCORE_ENV.clientId);
    expect(err.message).toContain("procoreCompanyId");
    expect(err.message).toContain("Nothing was fetched");
    const details = err.details as { missing: { env: string[]; config: string[] } };
    expect(details.missing.env).toContain(PROCORE_ENV.clientSecret);
    expect(details.missing.config).toEqual(["procoreCompanyId"]);
  });
});

/* ------------------------------------------------------------------ */
/* Procore transport                                                   */
/* ------------------------------------------------------------------ */

describe("Procore transport", () => {
  it("performs the client_credentials exchange as a form POST", async () => {
    const { client, calls } = recording(
      createFixtureHttpClient({ "POST /oauth/token": TOKEN_FIXTURE }),
    );
    const token = await procoreAccessToken(client, {
      tokenUrl: PROCORE_DEFAULT_TOKEN_URL,
      clientId: "pc-client",
      clientSecret: "pc-secret",
    });
    expect(token.accessToken).toBe("procore-access-token");
    expect(token.expiresIn).toBe(7200);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.body ?? "");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("pc-client");
    expect(form.get("client_secret")).toBe("pc-secret");
  });

  it("names the credentials env vars when the token exchange is rejected", async () => {
    const http = createFixtureHttpClient({});
    await expect(
      procoreAccessToken(http, {
        tokenUrl: PROCORE_DEFAULT_TOKEN_URL,
        clientId: "x",
        clientSecret: "y",
      }),
    ).rejects.toThrow(new RegExp(PROCORE_ENV.clientId));
  });

  it("sends the bearer token and the company header on every REST call", async () => {
    const { client, calls } = recording(
      createFixtureHttpClient({
        "POST /oauth/token": TOKEN_FIXTURE,
        "/rest/v1.0/vendors": [{ id: 1, name: "Alpha" }],
      }),
    );
    const connector = await ProcoreConnector.connect(client, {
      clientId: "pc-client",
      clientSecret: "pc-secret",
      baseUrl: "https://api.procore.example",
      tokenUrl: PROCORE_DEFAULT_TOKEN_URL,
      procoreCompanyId: "9001",
      procoreProjectId: null,
    });
    await connector.pullVendors();
    const restCall = calls.find((c) => c.url.includes("/rest/v1.0/vendors"))!;
    expect(restCall.headers["authorization"]).toBe("Bearer procore-access-token");
    expect(restCall.headers["procore-company-id"]).toBe("9001");
    expect(restCall.url).toContain("company_id=9001");
    expect(restCall.url).toContain("per_page=");
  });

  it("walks pages until a short page arrives", async () => {
    const full = Array.from({ length: 2 }, (_, i) => ({ id: i + 1, name: `Vendor ${i + 1}` }));
    const { client, calls } = recording(
      createFixtureHttpClient({
        "/rest/v1.0/vendors?page=1": full,
        "/rest/v1.0/vendors?page=2": full,
        "/rest/v1.0/vendors?page=3": [{ id: 5, name: "Last" }],
      }),
    );
    const connector = new ProcoreConnector(
      client,
      { baseUrl: "https://api.procore.example", procoreCompanyId: "9001" },
      "tok",
    );
    const rows = await connector.pullVendors({ pageSize: 2 });
    expect(rows).toHaveLength(5);
    expect(rows.at(-1)).toEqual({ name: "Last", externalId: "5" });
    // three pages requested, then it stopped — it did not keep asking forever
    expect(calls).toHaveLength(3);
  });

  it("stops at the page cap and does not run away", async () => {
    const full = [{ id: 1 }, { id: 2 }];
    const { client, calls } = recording(
      createFixtureHttpClient({ "/rest/v1.0/vendors": full }),
    );
    const connector = new ProcoreConnector(
      client,
      { baseUrl: "https://api.procore.example", procoreCompanyId: "9001" },
      "tok",
    );
    const rows = await connector.pullVendors({ pageSize: 2, maxPages: 3 });
    expect(calls).toHaveLength(3);
    expect(rows).toHaveLength(6);
  });

  it("maps project RFIs and refuses without a remote project id", async () => {
    const http = createFixtureHttpClient({
      "/rest/v1.0/projects/44/rfis": [
        {
          id: 77,
          subject: "Rebar spacing",
          status: "Open",
          due_date: "2026-03-01",
          proposed_solution: "Use 150mm",
          questions: [{ plain_text_body: "Confirm spacing at grid B3" }],
        },
      ],
    });
    const connector = new ProcoreConnector(
      http,
      { baseUrl: "https://api.procore.example", procoreCompanyId: "9001", procoreProjectId: "44" },
      "tok",
    );
    expect(await connector.pullRfis()).toEqual([
      {
        subject: "Rebar spacing",
        question: "Confirm spacing at grid B3",
        proposedSolution: "Use 150mm",
        status: "open",
        dueDate: "2026-03-01",
        externalId: "77",
      },
    ]);
    const noProject = new ProcoreConnector(
      http,
      { baseUrl: "https://api.procore.example", procoreCompanyId: "9001" },
      "tok",
    );
    await expect(noProject.pullRfis()).rejects.toThrow(/procoreProjectId is required/);
  });

  it("propagates a non-200 as an error naming the status", async () => {
    const connector = new ProcoreConnector(
      createFixtureHttpClient({}),
      { baseUrl: "https://api.procore.example", procoreCompanyId: "9001" },
      "tok",
    );
    await expect(connector.pullVendors()).rejects.toThrow(/vendors request failed \(404\)/);
  });
});

/* ------------------------------------------------------------------ */
/* Aconex transport                                                    */
/* ------------------------------------------------------------------ */

describe("Aconex transport", () => {
  it("authenticates with Basic plus the application key", async () => {
    const { client, calls } = recording(
      createFixtureHttpClient({
        "/directory/organizations": {
          SearchResults: {
            Organization: [
              {
                OrganizationId: "ORG-1",
                OrganizationName: "Sub Alpha Ltd",
                City: "Leeds",
                Country: "GB",
                Email: "ops@alpha.example",
              },
            ],
          },
        },
      }),
    );
    const connector = AconexConnector.connect(client, {
      username: "acx-user",
      password: "acx-pass",
      applicationKey: "acx-app-key",
      baseUrl: "https://uk1.aconex.example",
      aconexProjectId: "PRJ1",
    });
    const rows = await connector.pullOrganizations();
    expect(rows).toEqual([
      {
        name: "Sub Alpha Ltd",
        city: "Leeds",
        country: "GB",
        email: "ops@alpha.example",
        externalId: "ORG-1",
      },
    ]);
    const call = calls[0]!;
    const expectedBasic = Buffer.from("acx-user:acx-pass", "utf8").toString("base64");
    expect(call.headers["authorization"]).toBe(`Basic ${expectedBasic}`);
    expect(call.headers["x-application-key"]).toBe("acx-app-key");
    expect(call.url).toContain("page_number=1");
    expect(call.url).toContain("page_size=");
  });

  it("pulls RFI-type mail with the documented search query", async () => {
    const { client, calls } = recording(
      createFixtureHttpClient({
        "/mail": {
          MailSearch: {
            SearchResults: {
              Mail: [
                { MailId: "M-1", Subject: "RFI 12", Body: "Confirm invert level" },
                { MailNo: "M-2", Subject: "RFI 13", TextBody: "Clarify falls" },
              ],
            },
          },
        },
      }),
    );
    const connector = AconexConnector.connect(client, {
      username: "u",
      password: "p",
      applicationKey: "k",
      baseUrl: "https://uk1.aconex.example",
      aconexProjectId: "PRJ1",
    });
    const rows = await connector.pullRfiMail();
    expect(rows).toEqual([
      { subject: "RFI 12", question: "Confirm invert level", externalId: "M-1" },
      { subject: "RFI 13", question: "Clarify falls", externalId: "M-2" },
    ]);
    expect(decodeURIComponent(calls[0]!.url)).toContain("search_query=mailtype:RFI");
  });

  it("accepts every documented envelope shape and refuses an unrecognisable one", () => {
    const item = { OrganizationId: "1" };
    expect(extractAconexItems([item], "Organization")).toEqual([item]);
    expect(extractAconexItems({ Organization: [item] }, "Organization")).toEqual([item]);
    expect(extractAconexItems({ SearchResults: { Organization: [item] } }, "Organization")).toEqual([
      item,
    ]);
    expect(
      extractAconexItems(
        { OrganizationSearch: { SearchResults: { Organization: [item] } } },
        "Organization",
      ),
    ).toEqual([item]);
    // an XML→JSON rendering collapses a single-element sequence to an object
    expect(extractAconexItems({ SearchResults: { Organization: item } }, "Organization")).toEqual([
      item,
    ]);
    expect(extractAconexItems({ nothing: true }, "Organization")).toBeNull();
  });

  it("reports an unusable response rather than staging nothing silently", async () => {
    const connector = AconexConnector.connect(
      createFixtureHttpClient({ "/directory/organizations": { unexpected: "shape" } }),
      {
        username: "u",
        password: "p",
        applicationKey: "k",
        baseUrl: "https://uk1.aconex.example",
        aconexProjectId: "PRJ1",
      },
    );
    await expect(connector.pullOrganizations()).rejects.toThrow(
      /no Organization list in any documented envelope shape/,
    );
  });
});
