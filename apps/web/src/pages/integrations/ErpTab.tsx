/**
 * ERP tab — mapping profiles and the AP/AR extract (#130-133, #582).
 *
 * ConstructOS speaks one canonical shape per feed; a profile declares which
 * canonical field lands in which column of a given finance system's import
 * file. This tab is where a company builds that profile and pulls the file.
 *
 * The honesty rules that shape the UI:
 *   · The canonical vocabulary is loaded from the API, never restated here, so
 *     a field this screen offers is a field the export can actually produce.
 *   · An extract that spans currencies says so, in the panel and in the file.
 *     Nothing is converted and nothing is summed across them.
 *   · A truncated extract says it is truncated and how to get the rest.
 *   · Nothing here posts to an ERP. The output is a file, and the tab says so
 *     rather than letting "integration" imply a live connection.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fetchBlobUrl } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import { Caveat, asList, errorMessage, type ProjectPick } from "./integrationsShared";

interface CanonicalField {
  key: string;
  label: string;
  type: string;
  description: string;
}

interface FieldMapEntry {
  target: string;
  source?: string;
  constant?: string;
}

interface Starter {
  key: string;
  system: string;
  feed: string;
  name: string;
  notes: string;
  fieldMap: FieldMapEntry[];
}

interface Catalogue {
  feeds: { feed: string; fields: CanonicalField[] }[];
  formats: string[];
  starters: Starter[];
  note: string;
}

interface ProfileRow {
  id: string;
  name: string;
  system: string;
  feed: string;
  format: string;
  notes: string | null;
  isActive: boolean;
  fieldMap: FieldMapEntry[];
  createdAt: string;
}

interface ExportResult {
  feed: string;
  generatedAt: string;
  profile: { id: string | null; name: string; system: string; notes: string | null };
  rowCount: number;
  truncated: boolean;
  currencies: string[];
  sandbox: boolean;
  caveats: string[];
  columns: string[];
  rows: Record<string, string | number | null>[];
}

const FEED_LABELS: Record<string, string> = {
  ap_invoices: "AP invoices",
  job_cost: "Job cost",
  payments: "Payments",
};

export default function ErpTab({
  isAdmin,
  projects,
}: {
  isAdmin: boolean;
  projects: ProjectPick[] | null;
}) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileRow[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState("");
  const [newStarter, setNewStarter] = useState("");

  const [projectId, setProjectId] = useState("");
  const [feed, setFeed] = useState("ap_invoices");
  const [profileId, setProfileId] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [result, setResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const loadCatalogue = useCallback(async () => {
    setCatalogueError(null);
    try {
      setCatalogue(await api.get<Catalogue>("/api/v1/integrations/erp/catalogue"));
    } catch (err) {
      setCatalogueError(errorMessage(err, "Failed to load the ERP field catalogue"));
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    setProfilesError(null);
    try {
      const res = await api.get<unknown>("/api/v1/integrations/erp/profiles?page=1&pageSize=100");
      setProfiles(asList<ProfileRow>(res).items);
    } catch (err) {
      setProfiles((prev) => prev ?? []);
      setProfilesError(errorMessage(err, "Failed to load export profiles"));
    }
  }, []);

  useEffect(() => {
    void loadCatalogue();
    void loadProfiles();
  }, [loadCatalogue, loadProfiles]);

  const starter = useMemo(
    () => catalogue?.starters.find((s) => s.key === newStarter) ?? null,
    [catalogue, newStarter],
  );

  const feedFields = useMemo(
    () => catalogue?.feeds.find((f) => f.feed === feed)?.fields ?? [],
    [catalogue, feed],
  );

  const usableProfiles = useMemo(
    () => (profiles ?? []).filter((p) => p.feed === feed && p.isActive),
    [profiles, feed],
  );

  async function onCreate() {
    if (!starter || newName.trim() === "") return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post("/api/v1/integrations/erp/profiles", {
        name: newName.trim(),
        system: starter.system,
        feed: starter.feed,
        starter: starter.key,
      });
      setNewName("");
      setNewStarter("");
      await loadProfiles();
    } catch (err) {
      setActionError(errorMessage(err, "Could not create the profile"));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(profile: ProfileRow) {
    if (!window.confirm(`Delete the export profile "${profile.name}"?`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.del(`/api/v1/integrations/erp/profiles/${profile.id}`);
      await loadProfiles();
    } catch (err) {
      setActionError(errorMessage(err, "Could not delete the profile"));
    } finally {
      setBusy(false);
    }
  }

  function exportQuery(format: "json" | "csv"): string {
    const params = new URLSearchParams();
    if (profileId) params.set("profileId", profileId);
    else params.set("feed", feed);
    params.set("format", format);
    if (periodFrom) params.set("periodFrom", periodFrom);
    if (periodTo) params.set("periodTo", periodTo);
    return params.toString();
  }

  async function onPreview() {
    if (!projectId) return;
    setRunning(true);
    setExportError(null);
    try {
      const res = await api.get<ExportResult>(
        `/api/v1/projects/${projectId}/integrations/erp/export?${exportQuery("json")}`,
      );
      setResult(res);
    } catch (err) {
      setResult(null);
      setExportError(errorMessage(err, "The extract failed"));
    } finally {
      setRunning(false);
    }
  }

  async function onDownload() {
    if (!projectId) return;
    setRunning(true);
    setExportError(null);
    try {
      const url = await fetchBlobUrl(
        `/api/v1/projects/${projectId}/integrations/erp/export?${exportQuery("csv")}`,
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${feed}-${projectId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errorMessage(err, "The CSV download failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <ErrorAlert message={catalogueError} />
      <ErrorAlert message={profilesError} />
      <ErrorAlert message={actionError} />

      {catalogue ? <Caveat tone="ink">{catalogue.note}</Caveat> : null}

      {/* ------------------------------ extract ----------------------------- */}
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">Extract</h2>
            <p className="text-xs text-ink-400">
              Reads the invoice register through the invoicing permission — this is not a wider
              door than the module it exports.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Project">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Select a project…</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Feed">
              <Select
                value={feed}
                onChange={(e) => {
                  setFeed(e.target.value);
                  setProfileId("");
                  setResult(null);
                }}
              >
                {(catalogue?.feeds ?? []).map((f) => (
                  <option key={f.feed} value={f.feed}>
                    {FEED_LABELS[f.feed] ?? f.feed}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Profile" hint="Unmapped renders the canonical column names.">
              <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                <option value="">Canonical (unmapped)</option>
                {usableProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.system})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Period from">
                <Input
                  type="date"
                  value={periodFrom}
                  onChange={(e) => setPeriodFrom(e.target.value)}
                />
              </Field>
              <Field label="Period to">
                <Input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
              </Field>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void onPreview()} disabled={!projectId || running}>
              {running ? "Working…" : "Preview"}
            </Button>
            <Button variant="secondary" onClick={() => void onDownload()} disabled={!projectId || running}>
              Download CSV
            </Button>
          </div>

          <ErrorAlert message={exportError} />

          {result ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <Badge tone="blue">{FEED_LABELS[result.feed] ?? result.feed}</Badge>
                <span>{result.profile.name}</span>
                <span>·</span>
                <span>{result.rowCount} row(s)</span>
                <span>·</span>
                <span>{formatDateTime(result.generatedAt)}</span>
                {result.currencies.length > 0 ? (
                  <>
                    <span>·</span>
                    <span>{result.currencies.join(", ")}</span>
                  </>
                ) : null}
              </div>

              {result.caveats.map((c) => (
                <Caveat key={c} tone={result.sandbox ? "red" : "amber"}>
                  {c}
                </Caveat>
              ))}

              {result.profile.notes ? (
                <p className="text-xs leading-relaxed text-ink-500">{result.profile.notes}</p>
              ) : null}

              {result.rowCount === 0 ? (
                <EmptyState
                  title="No rows in scope"
                  hint="Nothing in this project matches the feed and period. Widen the period, or check the invoice register."
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        {result.columns.map((c) => (
                          <Th key={c}>{c}</Th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 25).map((row, i) => (
                        <tr key={i}>
                          {result.columns.map((c) => (
                            <Td key={c} className="whitespace-nowrap">
                              {row[c] === null || row[c] === undefined ? (
                                <span className="text-ink-300" title="not held on this record">
                                  —
                                </span>
                              ) : (
                                String(row[c])
                              )}
                            </Td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {result.rows.length > 25 ? (
                    <p className="mt-2 text-xs text-ink-400">
                      Showing the first 25 of {result.rowCount} rows — the CSV carries all of them.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* ----------------------------- profiles ----------------------------- */}
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-ink-900">Mapping profiles</h2>
              <p className="text-xs text-ink-400">
                A profile renames and reorders the canonical fields into the columns a given
                finance system imports. It can hold a field back and supply a constant; it can
                never invent a figure.
              </p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Sage AP — Northgate"
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Start from">
              <Select
                value={newStarter}
                onChange={(e) => setNewStarter(e.target.value)}
                disabled={!isAdmin}
              >
                <option value="">Select a starter…</option>
                {(catalogue?.starters ?? []).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button
                onClick={() => void onCreate()}
                disabled={!isAdmin || busy || !starter || newName.trim() === ""}
              >
                Create profile
              </Button>
            </div>
          </div>

          {starter ? <Caveat tone="amber">{starter.notes}</Caveat> : null}

          {profiles === null ? (
            <Spinner label="Loading profiles…" />
          ) : profiles.length === 0 ? (
            <EmptyState
              title="No export profiles yet"
              hint="Create one from a starter above, then adjust its columns against the customer's own chart of accounts."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>System</Th>
                  <Th>Feed</Th>
                  <Th className="text-right">Columns</Th>
                  <Th>Created</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id}>
                    <Td>{p.name}</Td>
                    <Td>{p.system}</Td>
                    <Td>
                      <Badge tone="gray">{FEED_LABELS[p.feed] ?? p.feed}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">{p.fieldMap.length}</Td>
                    <Td className="whitespace-nowrap">{formatDateTime(p.createdAt)}</Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600"
                        disabled={!isAdmin || busy}
                        onClick={() => void onDelete(p)}
                      >
                        Delete
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* -------------------------- field reference ------------------------- */}
      <Card>
        <CardBody className="space-y-3">
          <div>
            <h2 className="text-base font-semibold text-ink-900">
              Canonical fields — {FEED_LABELS[feed] ?? feed}
            </h2>
            <p className="text-xs text-ink-400">
              The vocabulary a profile maps from, published by the API so this list cannot drift
              from what the export can produce.
            </p>
          </div>
          {feedFields.length === 0 ? (
            <Spinner label="Loading fields…" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Field</Th>
                  <Th>Label</Th>
                  <Th>Type</Th>
                  <Th>What it is</Th>
                </tr>
              </thead>
              <tbody>
                {feedFields.map((f) => (
                  <tr key={f.key}>
                    <Td className="font-mono text-xs">{f.key}</Td>
                    <Td>{f.label}</Td>
                    <Td>
                      <Badge tone="gray">{f.type}</Badge>
                    </Td>
                    <Td className="text-xs text-ink-600">{f.description}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
