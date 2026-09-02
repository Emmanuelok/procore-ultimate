/**
 * Ingestion sources — where external data comes from.
 *
 * Kinds: csv (manual uploads), procore / aconex (connector scaffolds), and
 * api_token (machine pushes). Two honesty rules are enforced visually:
 *   · config NEVER holds credentials — the form says so and the API rejects it;
 *   · the Procore/Aconex "Pull now" action shows the server's 501 response
 *     VERBATIM: this deployment has no route or credentials for either vendor,
 *     and the page does not pretend otherwise.
 */
import { useState, type FormEvent } from "react";
import { INGESTION_SOURCE_KINDS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  Caveat,
  SOURCE_KIND_LABELS,
  kindTone,
  type ProjectPick,
  type SourceRow,
} from "./ingestionShared";

interface PullOutcome {
  source: SourceRow;
  status: number | null;
  body: unknown;
  message: string;
}

export default function SourcesTab({
  sources,
  projects,
  onReload,
}: {
  sources: SourceRow[] | null;
  projects: ProjectPick[] | null;
  onReload: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const projectName = (id: string | null) =>
    id ? (projects?.find((p) => p.id === id)?.name ?? id) : "Company-wide";

  /* ---------------------------- create / edit ----------------------------- */

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SourceRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fKind, setFKind] = useState("csv");
  const [fProjectId, setFProjectId] = useState("");
  const [fConfig, setFConfig] = useState("");

  function openCreate() {
    setEditing(null);
    setFormError(null);
    setFName("");
    setFKind("csv");
    setFProjectId("");
    setFConfig("");
    setModalOpen(true);
  }

  function openEdit(s: SourceRow) {
    setEditing(s);
    setFormError(null);
    setFName(s.name);
    setFKind(s.kind);
    setFProjectId(s.projectId ?? "");
    setFConfig(
      s.config && Object.keys(s.config).length > 0 ? JSON.stringify(s.config, null, 2) : "",
    );
    setModalOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    let config: Record<string, unknown> | undefined;
    if (fConfig.trim()) {
      try {
        const parsed: unknown = JSON.parse(fConfig);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setFormError("Config must be a JSON object.");
          return;
        }
        config = parsed as Record<string, unknown>;
      } catch {
        setFormError("Config is not valid JSON.");
        return;
      }
    }

    setBusy(true);
    try {
      const payload: Record<string, unknown> = { name: fName.trim() };
      if (config !== undefined) payload["config"] = config;
      if (editing) {
        await api.patch<SourceRow>(`/api/v1/ingestion/sources/${editing.id}`, payload);
      } else {
        payload["kind"] = fKind;
        if (fProjectId) payload["projectId"] = fProjectId;
        await api.post<SourceRow>("/api/v1/ingestion/sources", payload);
      }
      setModalOpen(false);
      await onReload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save the source");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleActive(s: SourceRow) {
    setError(null);
    try {
      await api.patch<SourceRow>(`/api/v1/ingestion/sources/${s.id}`, {
        isActive: s.isActive !== 1,
      });
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update the source");
    }
  }

  /* -------------------------------- pull ---------------------------------- */

  const [pull, setPull] = useState<PullOutcome | null>(null);
  const [pulling, setPulling] = useState<string | null>(null);

  async function onPull(s: SourceRow) {
    setError(null);
    setPulling(s.id);
    try {
      const res = await api.post<unknown>(`/api/v1/ingestion/sources/${s.id}/pull`);
      // If the server ever answers 2xx (a real connector one day), show that too.
      setPull({ source: s, status: 200, body: res, message: "Pull accepted" });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setPull({ source: s, status: err.status, body: err.details, message: err.message });
      } else {
        setPull({
          source: s,
          status: null,
          body: null,
          message: err instanceof Error ? err.message : "Pull failed",
        });
      }
    } finally {
      setPulling(null);
    }
  }

  /**
   * Best-effort structured view of the 501 requirements body, if recognisable.
   * The server sends { details: { connector, required: { credentials, config }, note } };
   * the lists and the note are found wherever they sit so a re-shape degrades
   * gracefully — the verbatim body below is always the authority.
   */
  function requirementsOf(body: unknown): { credentials: string[]; config: string[]; note: string | null } | null {
    const scanLists = (v: unknown): Record<string, unknown> | null => {
      if (!v || typeof v !== "object") return null;
      const o = v as Record<string, unknown>;
      if (Array.isArray(o["credentials"]) || Array.isArray(o["config"])) return o;
      for (const val of Object.values(o)) {
        const hit = scanLists(val);
        if (hit) return hit;
      }
      return null;
    };
    const scanNote = (v: unknown): string | null => {
      if (!v || typeof v !== "object") return null;
      const o = v as Record<string, unknown>;
      if (typeof o["note"] === "string") return o["note"];
      for (const val of Object.values(o)) {
        const hit = scanNote(val);
        if (hit) return hit;
      }
      return null;
    };
    const o = scanLists(body);
    if (!o) return null;
    return {
      credentials: Array.isArray(o["credentials"]) ? (o["credentials"] as unknown[]).map(String) : [],
      config: Array.isArray(o["config"]) ? (o["config"] as unknown[]).map(String) : [],
      note: scanNote(body),
    };
  }

  /* -------------------------------- render -------------------------------- */

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-ink-500">
          Every ingestion run is attributed to a source. Connector sources (Procore, Aconex) are
          scaffolds in this deployment — their pull action reports exactly what would be needed.
        </p>
        <Button onClick={openCreate}>New source</Button>
      </div>

      {sources === null ? (
        <Spinner label="Loading sources…" />
      ) : sources.length === 0 ? (
        <EmptyState
          title="No ingestion sources yet"
          hint="Create a source to attribute imports to — a CSV export from a legacy system, a connector, or a machine token stream."
          action={<Button onClick={openCreate}>New source</Button>}
        />
      ) : (
        <Table>
          <thead className="bg-ink-50">
            <tr>
              <Th>Name</Th>
              <Th>Kind</Th>
              <Th>Scope</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50">
            {sources.map((s) => (
              <tr key={s.id} className="hover:bg-ink-50">
                <Td className="font-medium text-ink-900">{s.name}</Td>
                <Td>
                  <Badge tone={kindTone(s.kind)}>{SOURCE_KIND_LABELS[s.kind] ?? humanize(s.kind)}</Badge>
                </Td>
                <Td>{projectName(s.projectId)}</Td>
                <Td>
                  {s.isActive === 1 ? (
                    <Badge tone="green">Active</Badge>
                  ) : (
                    <Badge tone="gray">Inactive</Badge>
                  )}
                </Td>
                <Td className="whitespace-nowrap">{formatDateTime(s.createdAt)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    {s.kind === "procore" || s.kind === "aconex" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void onPull(s)}
                        disabled={pulling === s.id}
                      >
                        {pulling === s.id ? "Pulling…" : "Pull now"}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void onToggleActive(s)}>
                      {s.isActive === 1 ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* --------------------------- create / edit --------------------------- */}
      <Modal
        open={modalOpen}
        title={editing ? `Edit source — ${editing.name}` : "New ingestion source"}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <ErrorAlert message={formError} />
          <Field label="Name">
            <Input value={fName} onChange={(e) => setFName(e.target.value)} required placeholder="e.g. Legacy ERP export" />
          </Field>
          {!editing ? (
            <>
              <Field label="Kind">
                <Select value={fKind} onChange={(e) => setFKind(e.target.value)}>
                  {INGESTION_SOURCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {SOURCE_KIND_LABELS[k] ?? humanize(k)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Project scope" hint="Leave company-wide unless this source only ever feeds one project.">
                <Select value={fProjectId} onChange={(e) => setFProjectId(e.target.value)}>
                  <option value="">Company-wide</option>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}
          <Field
            label="Config (JSON, optional)"
            hint="Connector configuration only — base URLs, remote company/project ids, default column maps."
          >
            <Textarea
              value={fConfig}
              onChange={(e) => setFConfig(e.target.value)}
              placeholder='{ "baseUrl": "https://api.procore.com" }'
              className="font-mono text-xs"
            />
          </Field>
          <Caveat tone="red">
            Never put credentials in config. Secrets live in environment configuration and API
            tokens — the config column is stored in plain sight and the API will not treat it as a
            secret store.
          </Caveat>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !fName.trim()}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create source"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ pull result --------------------------- */}
      <Modal
        open={pull !== null}
        title={pull ? `Pull result — ${pull.source.name}` : "Pull result"}
        onClose={() => setPull(null)}
        wide
      >
        {pull ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Badge tone={pull.status === 501 ? "amber" : pull.status && pull.status < 300 ? "green" : "red"}>
                {pull.status !== null ? `HTTP ${pull.status}` : "No response"}
              </Badge>
              <span className="text-ink-700">{pull.message}</span>
            </div>

            {pull.status === 501 ? (
              <Caveat>
                Not implemented — and that is the honest answer. This deployment has no network
                route to {SOURCE_KIND_LABELS[pull.source.kind] ?? pull.source.kind} and holds no
                credentials for it. Nothing was fetched and nothing was staged. The server's
                response below names exactly what a real pull would require.
              </Caveat>
            ) : null}

            {(() => {
              const req = requirementsOf(pull.body);
              if (!req) return null;
              return (
                <div className="space-y-2 text-sm text-ink-700">
                  {req.credentials.length > 0 ? (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                        Credentials required
                      </div>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                        {req.credentials.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {req.config.length > 0 ? (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                        Config required
                      </div>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                        {req.config.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {req.note ? <p className="text-xs text-ink-500">{req.note}</p> : null}
                </div>
              );
            })()}

            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Response body, verbatim
              </div>
              <pre className="max-h-72 overflow-auto rounded-md bg-ink-950 p-3 text-xs leading-relaxed text-ink-100">
                {pull.body !== null && pull.body !== undefined
                  ? typeof pull.body === "string"
                    ? pull.body
                    : JSON.stringify(pull.body, null, 2)
                  : "(no body)"}
              </pre>
            </div>

            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setPull(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
