/**
 * API tokens — machine credentials for evidence-stream pushes (ADR 0014).
 *
 * The security model, made visible: the raw token (cok_ + 40 hex) exists in
 * exactly one place at exactly one moment — the create response, shown once
 * below with a copy control and a warning. The server keeps only a SHA-256
 * hash and the first 8 characters for display. Scopes are ingestion datasets
 * and nothing else on the platform.
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
  Caveat,
  asList,
  extractRawToken,
  type DatasetInfo,
  type TokenRow,
} from "./ingestionShared";

export default function TokensTab({ datasets }: { datasets: DatasetInfo[] | null }) {
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/ingestion/tokens?page=1&pageSize=100");
      setTokens(asList<TokenRow>(res).items);
    } catch (err) {
      setTokens((prev) => prev ?? []);
      setError(err instanceof Error ? err.message : "Failed to load API tokens");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------- create --------------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fScopes, setFScopes] = useState<string[]>([]);
  const [fExpiresAt, setFExpiresAt] = useState("");

  /** The raw token, held only in this component's state for the reveal modal. */
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function openCreate() {
    setFormError(null);
    setFName("");
    setFScopes([]);
    setFExpiresAt("");
    setCreateOpen(true);
  }

  function toggleScope(ds: string) {
    setFScopes((prev) => (prev.includes(ds) ? prev.filter((s) => s !== ds) : [...prev, ds]));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (fScopes.length === 0) {
      setFormError("Pick at least one dataset scope — a token that can push nothing is useless.");
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { name: fName.trim(), scopes: fScopes };
      if (fExpiresAt) payload["expiresAt"] = new Date(`${fExpiresAt}T23:59:59Z`).toISOString();
      const res = await api.post<unknown>("/api/v1/ingestion/tokens", payload);
      const raw = extractRawToken(res);
      setCreateOpen(false);
      await load();
      if (raw) {
        setCopied(false);
        setRevealed({ token: raw, name: fName.trim() });
      } else {
        setError(
          "The token was created but the response did not contain a recognisable raw token " +
            "(cok_ + 40 hex). It cannot be recovered — revoke it and create a new one.",
        );
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create the token");
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.token);
      setCopied(true);
    } catch {
      // Clipboard API can be unavailable (permissions, insecure context) —
      // the token stays visible for manual selection, so say so instead of failing silently.
      setCopied(false);
      window.alert("Automatic copy was blocked by the browser — select the token text and copy it manually.");
    }
  }

  /* ------------------------------- revoke --------------------------------- */

  async function onRevoke(t: TokenRow) {
    if (
      !window.confirm(
        `Revoke the token "${t.name}" (${t.tokenPrefix}…)?\n\nEvery push using it fails immediately. This cannot be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.post<unknown>(`/api/v1/ingestion/tokens/${t.id}/revoke`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke the token");
    }
  }

  /* -------------------------------- render -------------------------------- */

  const now = Date.now();
  const tokenState = (t: TokenRow): { label: string; tone: string } => {
    if (t.revokedAt) return { label: "Revoked", tone: "gray" };
    if (t.expiresAt && new Date(t.expiresAt).getTime() < now) return { label: "Expired", tone: "red" };
    return { label: "Active", tone: "green" };
  };

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          Machine credentials for independent evidence streams — turnstile logs, payroll exports —
          pushed straight into staging, validated and committed with full provenance.
        </p>
        <Button onClick={openCreate}>New token</Button>
      </div>

      {tokens === null ? (
        <Spinner label="Loading tokens…" />
      ) : tokens.length === 0 ? (
        <EmptyState
          title="No API tokens"
          hint="Create a token so an external system (a turnstile server, a payroll bureau) can push records into its scoped datasets — and nothing else."
          action={<Button onClick={openCreate}>New token</Button>}
        />
      ) : (
        <Table>
          <thead className="bg-ink-50">
            <tr>
              <Th>Name</Th>
              <Th>Prefix</Th>
              <Th>Scopes</Th>
              <Th>State</Th>
              <Th>Last used</Th>
              <Th>Expires</Th>
              <Th>Created</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50">
            {tokens.map((t) => {
              const state = tokenState(t);
              return (
                <tr key={t.id} className="hover:bg-ink-50">
                  <Td className="font-medium text-ink-900">{t.name}</Td>
                  <Td>
                    <span className="font-mono text-xs">{t.tokenPrefix}…</span>
                  </Td>
                  <Td>
                    <div className="flex max-w-xs flex-wrap gap-1">
                      {(t.scopes ?? []).map((s) => (
                        <Badge key={s} tone="violet">
                          {humanize(s)}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : <span className="text-ink-300">Never</span>}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {t.expiresAt ? formatDateTime(t.expiresAt) : <span className="text-ink-300">Never</span>}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(t.createdAt)}</Td>
                  <Td>
                    {!t.revokedAt ? (
                      <Button variant="danger" size="sm" onClick={() => void onRevoke(t)}>
                        Revoke
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-400">{formatDateTime(t.revokedAt)}</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {/* --------------------------- how pushes work --------------------------- */}
      <Card className="mt-5">
        <CardBody>
          <h3 className="text-sm font-semibold text-ink-900">How a machine push works</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            The external system calls the push endpoint with the raw token as a bearer credential —
            no user login involved. The server verifies the token's hash, checks it is neither
            revoked nor expired and that the dataset is in scope, then stages, validates and
            commits the batch in one pass as an implicit run. Rejected records are reported back
            with reasons, and the run appears in the Runs register like any other.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-ink-950 p-3 text-xs leading-relaxed text-ink-100">
{`POST /api/v1/ingestion/push/site_access
Authorization: Bearer cok_<your token>
Content-Type: application/json

{ "projectId": "<project id>", "records": [ { "workerReference": "B-1041", "accessDate": "2026-08-25", ... } ] }`}
          </pre>
        </CardBody>
      </Card>

      {/* ------------------------------- create -------------------------------- */}
      <Modal open={createOpen} title="New API token" onClose={() => setCreateOpen(false)}>
        <form onSubmit={onCreate} className="space-y-4">
          <ErrorAlert message={formError} />
          <Field label="Name" hint="Name the system that will hold this token, not a person.">
            <Input
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              required
              placeholder="e.g. North gate turnstile server"
            />
          </Field>
          <Field
            label="Dataset scopes"
            hint="The token can push into these datasets and nothing else on the platform."
          >
            <div className="space-y-1.5 rounded-md bg-ink-50 p-3">
              {datasets === null ? (
                <span className="text-xs text-ink-400">Loading datasets…</span>
              ) : datasets.length === 0 ? (
                <span className="text-xs text-red-700">
                  The dataset registry could not be loaded — scopes cannot be chosen.
                </span>
              ) : (
                datasets.map((d) => (
                  <label key={d.dataset} className="flex items-start gap-2 text-sm text-ink-800">
                    <input
                      type="checkbox"
                      checked={fScopes.includes(d.dataset)}
                      onChange={() => toggleScope(d.dataset)}
                      className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span>
                      {d.label}
                      <span className="block text-[11px] text-ink-400">{d.target}</span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </Field>
          <Field label="Expiry (optional)" hint="The token stops working at the end of this day (UTC). Leave empty for no expiry.">
            <Input type="date" value={fExpiresAt} onChange={(e) => setFExpiresAt(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !fName.trim()}>
              {busy ? "Creating…" : "Create token"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ----------------------------- reveal once ----------------------------- */}
      <Modal
        open={revealed !== null}
        title={revealed ? `Token created — ${revealed.name}` : "Token created"}
        onClose={() => setRevealed(null)}
      >
        {revealed ? (
          <div className="space-y-4">
            <Caveat tone="red">
              <span className="font-semibold">This is the only time this token will ever be shown.</span>{" "}
              The server stores only its SHA-256 hash and the first 8 characters. Copy it into the
              destination system's secret store now — once this dialog closes it is unrecoverable,
              and the only remedy is to revoke and re-issue.
            </Caveat>
            <div className="flex items-center gap-2">
              <code className="block flex-1 select-all break-all rounded-md bg-ink-950 p-3 font-mono text-sm text-emerald-300">
                {revealed.token}
              </code>
              <Button variant="secondary" onClick={() => void onCopy()}>
                {copied ? "Copied ✓" : "Copy"}
              </Button>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  if (
                    window.confirm(
                      "Close and discard the raw token? Make sure it is stored — it will never be shown again.",
                    )
                  ) {
                    setRevealed(null);
                  }
                }}
              >
                I have stored it — close
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
