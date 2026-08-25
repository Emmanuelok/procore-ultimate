/**
 * OAuth2 machine callers (#120) — client_credentials clients, their issued
 * tokens, and the operator's introspection tool.
 *
 * The scope builder is driven by GET /integrations/oauth/scopes, which returns
 * the platform's own tool/level vocabulary. That is the point of the design: a
 * machine caller is not a second permission system running beside the first, it
 * is an actor inside the existing one, so `rfis:standard` on a client means
 * exactly what `rfis:standard` means for a person.
 *
 * Two refusals get first-class rendering rather than a generic error toast:
 *   · escalation (403) — a client may never hold more than its creator does,
 *     and the API names each refused scope and what the creator actually holds;
 *   · introspection's deliberate blindness — unknown, expired, revoked and
 *     other-tenant tokens all answer {active:false} and are indistinguishable.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  ADMIN_ONLY_HINT,
  Caveat,
  CodeBlock,
  CopyButton,
  DefRow,
  Drawer,
  Mono,
  SecretRevealModal,
  asList,
  errorDetails,
  errorMessage,
  num,
  plural,
  type ClientCreateResponse,
  type IntrospectResponse,
  type OauthClientView,
  type OauthTokenRow,
  type ScopeCatalogue,
} from "./integrationsShared";

interface RefusedScope {
  scope: string;
  creatorHolds: string;
}

/** Pull the escalation detail out of a 403 without betting on the envelope. */
function refusalOf(err: unknown): { refused: RefusedScope[]; ceilingBasis: string | null } | null {
  const d = errorDetails(err);
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (!Array.isArray(o["refused"])) return null;
  const refused = (o["refused"] as unknown[])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      scope: String(r["scope"] ?? ""),
      creatorHolds: String(r["creatorHolds"] ?? "none"),
    }));
  return {
    refused,
    ceilingBasis: typeof o["ceilingBasis"] === "string" ? o["ceilingBasis"] : null,
  };
}

/** none is not a grantable level — it is the absence of one. */
const NOT_GRANTED = "";

export default function OAuthTab({
  isAdmin,
  scopes,
  scopesError,
}: {
  isAdmin: boolean;
  scopes: ScopeCatalogue | null;
  scopesError: string | null;
}) {
  const [clients, setClients] = useState<OauthClientView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/integrations/oauth/clients?page=1&pageSize=100");
      setClients(asList<OauthClientView>(res).items);
    } catch (err) {
      setClients((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load OAuth clients"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------------------- create / edit ----------------------------- */

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OauthClientView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{
    refused: RefusedScope[];
    ceilingBasis: string | null;
  } | null>(null);
  const [fName, setFName] = useState("");
  const [fTtl, setFTtl] = useState("3600");
  const [fGrants, setFGrants] = useState<Record<string, string>>({});

  const [created, setCreated] = useState<ClientCreateResponse | null>(null);

  function grantsFromScopes(list: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of list) {
      const idx = raw.lastIndexOf(":");
      if (idx === -1) continue;
      out[raw.slice(0, idx)] = raw.slice(idx + 1);
    }
    return out;
  }

  function scopesFromGrants(g: Record<string, string>): string[] {
    return Object.entries(g)
      .filter(([, level]) => level !== NOT_GRANTED)
      .map(([tool, level]) => `${tool}:${level}`)
      .sort();
  }

  function openCreate() {
    setEditing(null);
    setFormError(null);
    setRefusal(null);
    setFName("");
    setFTtl("3600");
    setFGrants({});
    setFormOpen(true);
  }

  function openEdit(c: OauthClientView) {
    setEditing(c);
    setFormError(null);
    setRefusal(null);
    setFName(c.name);
    setFTtl(String(c.tokenTtlSeconds));
    setFGrants(grantsFromScopes(c.scopes ?? []));
    setFormOpen(true);
  }

  const selectedScopes = scopesFromGrants(fGrants);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    setRefusal(null);
    if (selectedScopes.length === 0) {
      setFormError(
        "Grant at least one tool:level scope. A client with no scopes cannot be issued a usable " +
          "token — the token endpoint refuses with invalid_scope.",
      );
      return;
    }
    setBusy(true);
    try {
      const ttl = Number(fTtl);
      if (editing) {
        await api.patch<OauthClientView>(`/api/v1/integrations/oauth/clients/${editing.id}`, {
          name: fName.trim(),
          scopes: selectedScopes,
          tokenTtlSeconds: ttl,
        });
        setFormOpen(false);
        await load();
      } else {
        const res = await api.post<ClientCreateResponse>("/api/v1/integrations/oauth/clients", {
          name: fName.trim(),
          scopes: selectedScopes,
          tokenTtlSeconds: ttl,
        });
        setFormOpen(false);
        await load();
        setCreated(res);
      }
    } catch (err) {
      setRefusal(refusalOf(err));
      setFormError(errorMessage(err, "Failed to save the client"));
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- revoke -------------------------------- */

  const [revoked, setRevoked] = useState<{ name: string; tokensRevoked: number } | null>(null);

  async function onRevoke(c: OauthClientView) {
    if (
      !window.confirm(
        `Revoke the client "${c.name}" (${c.clientId})?\n\n` +
          "Every live access token it holds is revoked in the same breath — a credential that " +
          "keeps working for another hour is not revoked. Any system using it starts failing " +
          "immediately.\n\nThis cannot be undone; issue a new client instead.",
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await api.post<{ client: OauthClientView; tokensRevoked: number }>(
        `/api/v1/integrations/oauth/clients/${c.id}/revoke`,
      );
      await load();
      setRevoked({ name: c.name, tokensRevoked: res.tokensRevoked });
      if (tokenClient?.id === c.id) await openTokens(c);
    } catch (err) {
      setError(errorMessage(err, "Failed to revoke the client"));
    }
  }

  async function onToggleActive(c: OauthClientView) {
    setError(null);
    try {
      await api.patch<OauthClientView>(`/api/v1/integrations/oauth/clients/${c.id}`, {
        active: !c.isActive,
      });
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to change the client state"));
    }
  }

  /* -------------------------------- tokens -------------------------------- */

  const [tokenClient, setTokenClient] = useState<OauthClientView | null>(null);
  const [tokens, setTokens] = useState<OauthTokenRow[] | null>(null);
  const [tokenCount, setTokenCount] = useState<number | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const openTokens = useCallback(async (c: OauthClientView) => {
    setTokenClient(c);
    setTokens(null);
    setTokenCount(null);
    setTokenError(null);
    try {
      const res = await api.get<unknown>(
        `/api/v1/integrations/oauth/clients/${c.id}/tokens?page=1&pageSize=100`,
      );
      setTokens(asList<OauthTokenRow>(res).items);
    } catch (err) {
      setTokens([]);
      setTokenError(errorMessage(err, "Failed to load issued tokens"));
    }
    try {
      // Addressed by the PUBLIC client_id rather than the row id, because the
      // route accepts either — and the public id is the one an operator has in
      // front of them when they are chasing a credential.
      const detail = await api.get<{ client: OauthClientView; tokenCount: number }>(
        `/api/v1/integrations/oauth/clients/${encodeURIComponent(c.clientId)}`,
      );
      setTokenCount(detail.tokenCount);
    } catch {
      setTokenCount(null);
    }
  }, []);

  async function onRevokeToken(t: OauthTokenRow) {
    if (
      !window.confirm(
        `Revoke access token ${t.id}?\n\nThe holder's next call fails. Its scopes were fixed at ` +
          "issue, so narrowing the client alone would not have stopped it.",
      )
    ) {
      return;
    }
    setTokenError(null);
    try {
      await api.post(`/api/v1/integrations/oauth/tokens/${t.id}/revoke`);
      if (tokenClient) await openTokens(tokenClient);
    } catch (err) {
      setTokenError(errorMessage(err, "Failed to revoke the token"));
    }
  }

  /* ----------------------------- introspection ---------------------------- */

  const [introspectOpen, setIntrospectOpen] = useState(false);
  const [introspectToken, setIntrospectToken] = useState("");
  const [introspectBusy, setIntrospectBusy] = useState(false);
  const [introspectResult, setIntrospectResult] = useState<IntrospectResponse | null>(null);
  const [introspectError, setIntrospectError] = useState<string | null>(null);

  async function onIntrospect(ev: FormEvent) {
    ev.preventDefault();
    setIntrospectBusy(true);
    setIntrospectError(null);
    setIntrospectResult(null);
    try {
      setIntrospectResult(
        await api.post<IntrospectResponse>("/api/v1/integrations/oauth/introspect", {
          token: introspectToken.trim(),
        }),
      );
    } catch (err) {
      setIntrospectError(errorMessage(err, "Introspection failed"));
    } finally {
      setIntrospectBusy(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  const now = Date.now();
  const clientState = (c: OauthClientView): { label: string; tone: string } => {
    if (c.revokedAt) return { label: "Revoked", tone: "red" };
    if (!c.isActive) return { label: "Deactivated", tone: "gray" };
    return { label: "Active", tone: "green" };
  };

  const tokenState = (t: OauthTokenRow): { label: string; tone: string } => {
    if (t.revokedAt) return { label: "Revoked", tone: "gray" };
    if (new Date(t.expiresAt).getTime() < now) return { label: "Expired", tone: "amber" };
    return { label: "Live", tone: "green" };
  };

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-ink-500">
          Machine callers authenticate with the client_credentials grant and carry{" "}
          <code className="font-mono text-xs">tool:level</code> scopes from the same vocabulary
          people are governed by, so they pass through the platform's ordinary permission checks
          rather than around them.
        </p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setIntrospectResult(null);
              setIntrospectError(null);
              setIntrospectToken("");
              setIntrospectOpen(true);
            }}
            disabled={!isAdmin}
            title={isAdmin ? undefined : ADMIN_ONLY_HINT}
          >
            Introspect a token
          </Button>
          <Button onClick={openCreate} disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_HINT}>
            New client
          </Button>
        </div>
      </div>

      {clients === null ? (
        <Spinner label="Loading clients…" />
      ) : clients.length === 0 ? (
        <EmptyState
          title="No OAuth clients"
          hint="Create one to let an external system call this API unattended, holding no more authority than the person who created it."
          action={
            <Button onClick={openCreate} disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_HINT}>
              New client
            </Button>
          }
        />
      ) : (
        <Table>
          <thead className="bg-ink-50">
            <tr>
              <Th>Client</Th>
              <Th>Scopes</Th>
              <Th>Token TTL</Th>
              <Th>State</Th>
              <Th>Last token issued</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50">
            {clients.map((c) => {
              const state = clientState(c);
              return (
                <tr key={c.id} className="align-top hover:bg-ink-50">
                  <Td>
                    <span className="font-medium text-ink-900">{c.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <span className="font-mono text-[11px] text-ink-500">{c.clientId}</span>
                      <CopyButton text={c.clientId} />
                    </span>
                  </Td>
                  <Td>
                    <div className="flex max-w-sm flex-wrap gap-1">
                      {(c.scopes ?? []).length === 0 ? (
                        <span className="text-xs text-ink-400">none</span>
                      ) : (
                        (c.scopes ?? []).map((s) => (
                          <span
                            key={s}
                            className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 font-mono text-[11px] text-violet-800"
                          >
                            {s}
                          </span>
                        ))
                      )}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums text-xs">
                    {num(c.tokenTtlSeconds)} s
                  </Td>
                  <Td>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    {c.revokedAt ? (
                      <span className="mt-0.5 block text-[11px] text-ink-400">
                        {formatDateTime(c.revokedAt)}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {c.lastUsedAt ? (
                      formatDateTime(c.lastUsedAt)
                    ) : (
                      <span className="text-ink-300">Never</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void openTokens(c)}>
                        Tokens
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!isAdmin || !!c.revokedAt}
                        title={
                          c.revokedAt
                            ? "Revoked clients cannot be edited."
                            : isAdmin
                              ? undefined
                              : ADMIN_ONLY_HINT
                        }
                        onClick={() => openEdit(c)}
                      >
                        Edit scopes
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!isAdmin || !!c.revokedAt}
                        title={isAdmin ? undefined : ADMIN_ONLY_HINT}
                        onClick={() => void onToggleActive(c)}
                      >
                        {c.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={!isAdmin || !!c.revokedAt}
                        title={
                          c.revokedAt ? "Already revoked." : isAdmin ? undefined : ADMIN_ONLY_HINT
                        }
                        onClick={() => void onRevoke(c)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {/* --------------------------- the token endpoint ------------------------ */}
      <Card>
        <CardBody>
          <h3 className="text-sm font-semibold text-ink-900">How a machine caller gets a token</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            The client exchanges its id and secret for a bearer token at the token endpoint, then
            calls the API with it. The token carries the scopes it was issued with — later widening
            or narrowing of the client does not retroactively change a token already in the wild,
            which is why revoking a token (or the client) is the only way to take authority back
            before it expires.
          </p>
          <CodeBlock>{`curl -u '<client_id>:<client_secret>' \\
  -d grant_type=client_credentials \\
  https://<host>/api/v1/oauth/token

# → { "access_token": "...", "token_type": "Bearer", "expires_in": 3600, "scope": "rfis:read ..." }

curl -H 'Authorization: Bearer <access_token>' \\
     -H 'x-company-id: <company id>' \\
     https://<host>/api/v1/rfis`}</CodeBlock>
          <p className="mt-2 text-[11px] text-ink-400">
            The token endpoint answers a bad client id, a wrong secret, a revoked client and a
            deactivated client with one indistinguishable <code className="font-mono">invalid_client</code>{" "}
            — deliberately, so it cannot be used to discover which client ids exist.
          </p>
        </CardBody>
      </Card>

      {/* ---------------------------- create / edit ---------------------------- */}
      <Modal
        open={formOpen}
        wide
        title={editing ? `Edit client — ${editing.name}` : "New OAuth client"}
        onClose={() => setFormOpen(false)}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <ErrorAlert message={formError} />

          {refusal && refusal.refused.length > 0 ? (
            <Caveat tone="red">
              <span className="font-semibold">
                Refused: a machine client may not be granted more than its creator holds.
              </span>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {refusal.refused.map((r) => (
                  <li key={r.scope}>
                    <code className="font-mono">{r.scope}</code> — you hold{" "}
                    <strong>{r.creatorHolds}</strong> on that tool
                  </li>
                ))}
              </ul>
              {refusal.ceilingBasis ? (
                <p className="mt-1">Your ceiling was computed from: {refusal.ceilingBasis}.</p>
              ) : null}
              <p className="mt-1">
                Otherwise minting a client would be a privilege-escalation primitive: create a
                client with authority you lack, then act through it.
              </p>
            </Caveat>
          ) : null}

          <Field label="Name" hint="Name the calling system, not a person.">
            <Input
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              required
              placeholder="e.g. Nightly cost-sync worker"
            />
          </Field>

          <Field
            label="Access token lifetime (seconds)"
            hint="Between 60 and 86400. Shorter means a stolen token expires sooner; it also means more token requests."
          >
            <Input
              type="number"
              min={60}
              max={86400}
              value={fTtl}
              onChange={(e) => setFTtl(e.target.value)}
              required
            />
          </Field>

          <div>
            <span className="mb-1 block text-xs font-medium text-ink-600">
              Scopes ({selectedScopes.length} selected)
            </span>
            {scopesError ? (
              <Caveat tone="red">
                The scope catalogue could not be loaded: {scopesError}. Scopes cannot be chosen
                safely without it.
              </Caveat>
            ) : scopes === null ? (
              <Spinner label="Loading the scope vocabulary…" />
            ) : (
              <ScopeBuilder
                tools={scopes.tools}
                levels={scopes.levels}
                grants={fGrants}
                onChange={setFGrants}
              />
            )}
            {scopes ? (
              <div className="mt-2 space-y-2">
                {selectedScopes.length > 0 ? (
                  <div className="rounded-md bg-ink-50 px-3 py-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                      Scope string the token will carry
                    </div>
                    <code className="mt-0.5 block break-all font-mono text-xs text-ink-800">
                      {selectedScopes.join(" ")}
                    </code>
                  </div>
                ) : null}
                <Caveat tone="ink">
                  <span className="font-semibold">Format: {scopes.format}.</span> {scopes.note}
                </Caveat>
              </div>
            ) : null}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !isAdmin || !fName.trim()}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create client"}
            </Button>
          </div>
          {!editing ? (
            <p className="text-[11px] text-ink-400">
              The client secret is generated on save and shown once, immediately, in the next
              dialog.
            </p>
          ) : (
            <p className="text-[11px] text-ink-400">
              Editing scopes never re-issues the secret — and never changes a token already issued.
              Tokens carry the scopes they were minted with; revoke them if the narrowing has to
              take effect now.
            </p>
          )}
        </form>
      </Modal>

      {/* --------------------------- show-once secret -------------------------- */}
      <SecretRevealModal
        open={created !== null}
        title={created ? `Client created — ${created.client.name}` : "Client created"}
        warning={created?.secretWarning ?? ""}
        secretLabel="Client secret"
        secret={created?.clientSecret ?? ""}
        onClose={() => setCreated(null)}
      >
        {created ? (
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Client id (not secret — safe to log)
              </div>
              <div className="flex items-center gap-2">
                <code className="block flex-1 select-all break-all rounded-md bg-ink-50 p-2 font-mono text-xs text-ink-800">
                  {created.clientId}
                </code>
                <CopyButton text={created.clientId} />
              </div>
            </div>

            <div className="rounded-md bg-ink-50 p-3">
              <DefRow label="Token endpoint">
                <Mono>{created.tokenEndpoint}</Mono>
              </DefRow>
              <DefRow label="Grant type">
                <Mono>{created.grantType}</Mono>
              </DefRow>
              <DefRow label="Scopes">
                <span className="font-mono text-xs">
                  {(created.client.scopes ?? []).join(" ") || "none"}
                </span>
              </DefRow>
              <DefRow label="Token lifetime">
                <span className="tabular-nums">{num(created.client.tokenTtlSeconds)} seconds</span>
              </DefRow>
            </div>

            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Example, exactly as the API returned it
              </div>
              <CodeBlock>{created.example}</CodeBlock>
            </div>

            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                The same call with this client's real values
              </div>
              <CodeBlock>{`curl -u '${created.clientId}:${created.clientSecret}' \\
  -d grant_type=client_credentials \\
  https://<host>${created.tokenEndpoint}`}</CodeBlock>
              <p className="mt-1 text-[11px] text-ink-400">
                Assembled here in your browser from the response above — it contains the secret, so
                it is as sensitive as the secret itself. Do not paste it into a shell history you
                keep.
              </p>
            </div>
          </div>
        ) : null}
      </SecretRevealModal>

      {/* ------------------------------- revoked ------------------------------- */}
      <Modal open={revoked !== null} title="Client revoked" onClose={() => setRevoked(null)}>
        {revoked ? (
          <div className="space-y-3 text-sm text-ink-700">
            <p>
              <strong>{revoked.name}</strong> is revoked, and{" "}
              <strong>{num(revoked.tokensRevoked)}</strong> live access{" "}
              {plural(revoked.tokensRevoked, "token was", "tokens were")} revoked with it.
            </p>
            <Caveat>
              Anything still calling with those credentials now fails on its next request. The
              revocation, the client id and the token count are in the ledger.
            </Caveat>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setRevoked(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* -------------------------------- tokens ------------------------------- */}
      <Drawer
        open={tokenClient !== null}
        wide
        title={tokenClient ? `Issued tokens — ${tokenClient.name}` : "Issued tokens"}
        onClose={() => setTokenClient(null)}
      >
        {tokenClient ? (
          <div className="space-y-3">
            <ErrorAlert message={tokenError} />
            <div className="rounded-md bg-ink-50 p-3">
              <DefRow label="Client id">
                <span className="inline-flex items-center gap-2">
                  <Mono>{tokenClient.clientId}</Mono>
                  <CopyButton text={tokenClient.clientId} />
                </span>
              </DefRow>
              <DefRow label="Client scopes">
                <span className="font-mono text-xs">
                  {(tokenClient.scopes ?? []).join(" ") || "none"}
                </span>
              </DefRow>
              <DefRow label="Tokens ever issued">
                {tokenCount === null ? (
                  <span className="text-ink-400">—</span>
                ) : (
                  <span className="tabular-nums">
                    {num(tokenCount)}
                    {tokens && tokenCount > tokens.length ? (
                      <span className="ml-2 text-xs text-ink-500">
                        showing the {num(tokens.length)} most recent
                      </span>
                    ) : null}
                  </span>
                )}
              </DefRow>
            </div>

            {tokens === null ? (
              <Spinner label="Loading tokens…" />
            ) : tokens.length === 0 ? (
              <EmptyState
                title="No tokens issued"
                hint="This client has never completed a client_credentials exchange."
              />
            ) : (
              <Table>
                <thead className="bg-ink-50">
                  <tr>
                    <Th>Token</Th>
                    <Th>Scopes at issue</Th>
                    <Th>State</Th>
                    <Th>Issued</Th>
                    <Th>Expires</Th>
                    <Th>Last used</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {tokens.map((t) => {
                    const st = tokenState(t);
                    return (
                      <tr key={t.id} className="hover:bg-ink-50">
                        <Td>
                          <Mono>{t.id}</Mono>
                        </Td>
                        <Td>
                          <div className="flex max-w-xs flex-wrap gap-1">
                            {(t.scopes ?? []).map((s) => (
                              <span
                                key={s}
                                className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 font-mono text-[11px] text-violet-800"
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        </Td>
                        <Td>
                          <Badge tone={st.tone}>{st.label}</Badge>
                        </Td>
                        <Td className="whitespace-nowrap text-xs">{formatDateTime(t.issuedAt)}</Td>
                        <Td className="whitespace-nowrap text-xs">{formatDateTime(t.expiresAt)}</Td>
                        <Td className="whitespace-nowrap text-xs">
                          {t.lastUsedAt ? (
                            formatDateTime(t.lastUsedAt)
                          ) : (
                            <span className="text-ink-300">Never</span>
                          )}
                        </Td>
                        <Td>
                          {t.revokedAt ? (
                            <span className="text-[11px] text-ink-400">
                              {formatDateTime(t.revokedAt)}
                            </span>
                          ) : (
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={!isAdmin}
                              title={isAdmin ? undefined : ADMIN_ONLY_HINT}
                              onClick={() => void onRevokeToken(t)}
                            >
                              Revoke
                            </Button>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}

            <Caveat tone="ink">
              The token values themselves are not here and cannot be: only a sha256 of each is
              stored. A row is the record that a token exists, what it may do and when it dies —
              never the credential. Scopes shown are the ones fixed at issue, which may be narrower
              than the client's current scopes if it requested a subset.
            </Caveat>
          </div>
        ) : null}
      </Drawer>

      {/* ----------------------------- introspection --------------------------- */}
      <Modal
        open={introspectOpen}
        wide
        title="Introspect an access token"
        onClose={() => setIntrospectOpen(false)}
      >
        <form onSubmit={onIntrospect} className="space-y-4">
          <p className="text-xs leading-relaxed text-ink-500">
            An incident-response tool, not a client-facing endpoint: paste a bearer token someone
            handed you and find out whether it is live and what it can do. Answers are RFC 7662
            shaped.
          </p>
          <Field label="Access token">
            <Input
              value={introspectToken}
              onChange={(e) => setIntrospectToken(e.target.value)}
              required
              placeholder="the raw bearer token"
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIntrospectOpen(false)}>
              Close
            </Button>
            <Button type="submit" disabled={introspectBusy || !introspectToken.trim() || !isAdmin}>
              {introspectBusy ? "Checking…" : "Introspect"}
            </Button>
          </div>

          <ErrorAlert message={introspectError} />

          {introspectResult ? (
            introspectResult.active ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge tone="green">active</Badge>
                  <span className="text-sm text-ink-700">This token is live and usable now.</span>
                </div>
                <div className="rounded-md bg-ink-50 p-3">
                  <DefRow label="Client">
                    {introspectResult.client_name}{" "}
                    <Mono>({introspectResult.client_id})</Mono>
                  </DefRow>
                  <DefRow label="Scope">
                    <span className="font-mono text-xs">{introspectResult.scope}</span>
                  </DefRow>
                  <DefRow label="Token type">
                    <Mono>{introspectResult.token_type}</Mono>
                  </DefRow>
                  <DefRow label="Issued">
                    {introspectResult.iat
                      ? formatDateTime(new Date(introspectResult.iat * 1000).toISOString())
                      : "—"}
                  </DefRow>
                  <DefRow label="Expires">
                    {introspectResult.exp
                      ? formatDateTime(new Date(introspectResult.exp * 1000).toISOString())
                      : "—"}
                  </DefRow>
                  <DefRow label="Last used">
                    {introspectResult.last_used_at
                      ? formatDateTime(introspectResult.last_used_at)
                      : "Never"}
                  </DefRow>
                  <DefRow label="Token id">
                    <Mono>{introspectResult.token_id}</Mono>
                  </DefRow>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge tone="gray">inactive</Badge>
                  <span className="text-sm text-ink-700">This token will not authenticate.</span>
                </div>
                <Caveat>
                  <span className="font-semibold">
                    &ldquo;Inactive&rdquo; is deliberately uninformative.
                  </span>{" "}
                  A token that never existed, one that expired, one that was revoked, one whose
                  client was revoked or deactivated, and one belonging to a different company all
                  return exactly this. Introspection must not become an oracle for other tenants,
                  so the API refuses to say which case you are in — check the issued-token list for
                  the client you suspect instead.
                </Caveat>
              </div>
            )
          ) : null}
        </form>
      </Modal>
    </div>
  );
}

/* ---------------------------- the scope builder --------------------------- */

function ScopeBuilder({
  tools,
  levels,
  grants,
  onChange,
}: {
  tools: string[];
  levels: string[];
  grants: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = tools.filter((t) => t.includes(filter.trim().toLowerCase()));
  const granted = tools.filter((t) => (grants[t] ?? NOT_GRANTED) !== NOT_GRANTED);

  function set(tool: string, level: string) {
    const next = { ...grants };
    if (level === NOT_GRANTED) delete next[tool];
    else next[tool] = level;
    onChange(next);
  }

  return (
    <div className="rounded-md ring-1 ring-ink-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 bg-ink-50 px-3 py-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tools…"
          className="max-w-xs"
        />
        <div className="flex items-center gap-2 text-xs text-ink-500">
          <span>
            {num(granted.length)} of {num(tools.length)} tools granted
          </span>
          {granted.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => onChange({})}>
              Clear all
            </Button>
          ) : null}
        </div>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="min-w-full divide-y divide-ink-100 text-xs">
          <thead className="sticky top-0 bg-white">
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">
                Tool
              </th>
              <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">
                Not granted
              </th>
              {levels.map((l) => (
                <th
                  key={l}
                  className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500"
                >
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50">
            {shown.map((tool) => {
              const current = grants[tool] ?? NOT_GRANTED;
              return (
                <tr key={tool} className={current !== NOT_GRANTED ? "bg-brand-50/50" : undefined}>
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-[11px] text-ink-800">{tool}</span>
                    <span className="block text-[10px] text-ink-400">{humanize(tool)}</span>
                  </td>
                  {[NOT_GRANTED, ...levels].map((level) => (
                    <td key={level || "none"} className="px-3 py-1.5">
                      <input
                        type="radio"
                        name={`scope-${tool}`}
                        checked={current === level}
                        onChange={() => set(tool, level)}
                        className="h-3.5 w-3.5 border-ink-300 text-brand-600 focus:ring-brand-500"
                        aria-label={level === NOT_GRANTED ? `${tool} not granted` : `${tool}:${level}`}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={levels.length + 2} className="px-3 py-4 text-center text-ink-400">
                  No tool matches &ldquo;{filter}&rdquo;.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
