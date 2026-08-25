/**
 * Integrations workspace — the platform's edges (spec Vol I §0.7).
 *
 *   · Webhooks           — outbound: ledger events signed and POSTed out (#121)
 *   · Deliveries & health— is the queue flowing or piling up
 *   · OAuth clients      — inbound: machine callers with tool:level scopes (#120)
 *   · Signature reference— the receiver-side contract, in full
 *   · Sources            — inbound: vendor connectors and their pull
 *
 * Company scope, no project. The event catalogue and the scope vocabulary are
 * loaded once here and shared with every tab, as is the delivery-health read —
 * the signing contract it carries (key custody in particular) is a disclosure
 * that belongs on more than one tab and must not be fetched inconsistently.
 *
 * On roles: every mutation is owner/admin, and in this module the API gates the
 * READS the same way — only GET /integrations/events and
 * GET /integrations/oauth/scopes are open to members. Admin controls are
 * disabled rather than hidden, and a member is told plainly which reads the API
 * refused rather than being shown an empty page.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader } from "../../ui";
import HealthTab from "./HealthTab";
import OAuthTab from "./OAuthTab";
import SignatureTab from "./SignatureTab";
import SourcesTab from "./SourcesTab";
import WebhooksTab from "./WebhooksTab";
import {
  Caveat,
  TabBar,
  asList,
  errorMessage,
  errorStatus,
  useIsCompanyAdmin,
  type EventCatalogue,
  type ProjectPick,
  type ScopeCatalogue,
  type SourceRow,
  type WebhookStatusResponse,
} from "./integrationsShared";

const TABS = [
  { key: "webhooks", label: "Webhooks" },
  { key: "health", label: "Deliveries & health" },
  { key: "oauth", label: "OAuth clients" },
  { key: "signature", label: "Signature reference" },
  { key: "sources", label: "Sources" },
];

export default function IntegrationsPage() {
  const isAdmin = useIsCompanyAdmin();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "webhooks";
  });

  /* ------------------------ shared reference data ------------------------- */

  const [catalogue, setCatalogue] = useState<EventCatalogue | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [scopes, setScopes] = useState<ScopeCatalogue | null>(null);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const [status, setStatus] = useState<WebhookStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusForbidden, setStatusForbidden] = useState(false);
  const [projects, setProjects] = useState<ProjectPick[] | null>(null);
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  const loadCatalogue = useCallback(async () => {
    setCatalogueError(null);
    try {
      setCatalogue(await api.get<EventCatalogue>("/api/v1/integrations/events"));
    } catch (err) {
      setCatalogueError(errorMessage(err, "Failed to load the event catalogue"));
    }
  }, []);

  const loadScopes = useCallback(async () => {
    setScopesError(null);
    try {
      setScopes(await api.get<ScopeCatalogue>("/api/v1/integrations/oauth/scopes"));
    } catch (err) {
      setScopesError(errorMessage(err, "Failed to load the scope vocabulary"));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      setStatus(await api.get<WebhookStatusResponse>("/api/v1/integrations/webhooks/status"));
      setStatusForbidden(false);
    } catch (err) {
      const code = errorStatus(err);
      setStatusForbidden(code === 403 || code === 401);
      setStatusError(errorMessage(err, "Failed to read webhook delivery health"));
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await api.get<unknown>("/api/v1/projects?page=1&pageSize=200");
      setProjects(asList<ProjectPick>(res).items);
    } catch {
      // A missing project list only costs the optional project-scope picker;
      // it must not stop an operator configuring a company-wide endpoint.
      setProjects((prev) => prev ?? []);
    }
  }, []);

  const loadSources = useCallback(async () => {
    setSourcesError(null);
    try {
      const res = await api.get<unknown>("/api/v1/ingestion/sources?page=1&pageSize=100");
      setSources(asList<SourceRow>(res).items);
    } catch (err) {
      setSources((prev) => prev ?? []);
      setSourcesError(errorMessage(err, "Failed to load ingestion sources"));
    }
  }, []);

  useEffect(() => {
    void loadCatalogue();
    void loadScopes();
    void loadStatus();
    void loadProjects();
    void loadSources();
  }, [loadCatalogue, loadScopes, loadStatus, loadProjects, loadSources]);

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Integrations"
        subtitle="The platform's edges — signed outbound webhooks off the ledger, OAuth2 machine callers governed by the same scopes people are, and vendor connectors"
      />

      {!isAdmin ? (
        <div className="mb-4">
          <Caveat tone="amber">
            <span className="font-semibold">You are not an owner or admin of this company.</span>{" "}
            Actions below are visible but disabled. In this module the API also gates the{" "}
            <em>reads</em> at owner/admin — endpoint lists, delivery logs, OAuth clients, issued
            tokens and delivery health will all answer 403. The two exceptions, which you can read,
            are the event catalogue and the scope vocabulary; the Signature reference tab is
            documentation and works for everyone.
          </Caveat>
        </div>
      ) : null}

      {statusForbidden && isAdmin ? (
        <div className="mb-4">
          <Caveat tone="red">
            Delivery health could not be read despite your role ({statusError}). Tuning values and
            the signing key's custody are unavailable, so the Signature reference falls back to
            documented defaults rather than the values actually in force.
          </Caveat>
        </div>
      ) : null}

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "webhooks" ? (
        <WebhooksTab
          isAdmin={isAdmin}
          catalogue={catalogue}
          catalogueError={catalogueError}
          projects={projects}
          keySource={status?.signing.keySource ?? null}
          tuning={status?.delivery ?? null}
          onStatusChanged={() => void loadStatus()}
        />
      ) : null}

      {tab === "health" ? (
        <HealthTab status={status} statusError={statusError} onReload={() => void loadStatus()} />
      ) : null}

      {tab === "oauth" ? (
        <OAuthTab isAdmin={isAdmin} scopes={scopes} scopesError={scopesError} />
      ) : null}

      {tab === "signature" ? <SignatureTab status={status} /> : null}

      {tab === "sources" ? (
        <SourcesTab
          isAdmin={isAdmin}
          sources={sources}
          sourcesError={sourcesError}
          projects={projects}
          onReload={() => void loadSources()}
        />
      ) : null}
    </div>
  );
}
