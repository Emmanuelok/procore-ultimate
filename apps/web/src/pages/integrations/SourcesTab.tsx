/**
 * Connector sources — the inbound half of the integration surface.
 *
 * Sources themselves belong to the ingestion module (an ingestion run is
 * always attributed to one), so this tab reads them and drives the pull; the
 * create/edit forms stay on the Ingestion workspace rather than being
 * duplicated into a second idiom here.
 *
 * The pull action is the honest part. A configured connector stages a run and
 * says so — nothing has entered the record, validation and commit are separate
 * ledgered steps. An unconfigured one answers 501, and that 501 is rendered as
 * setup guidance naming the exact environment variables and config keys, not as
 * a failure. Neither transport has ever spoken to a live vendor: the code and
 * its fixtures are real, the network route and the credentials are not.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiClientError, api } from "../../lib/api";
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
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  ADMIN_ONLY_HINT,
  Caveat,
  DefRow,
  Mono,
  SOURCE_KIND_LABELS,
  VerbatimBody,
  errorDetails,
  errorMessage,
  errorStatus,
  num,
  sourceKindTone,
  type ConnectorNotConfigured,
  type ConnectorPullResult,
  type ProjectPick,
  type SourceRow,
} from "./integrationsShared";

const CONNECTOR_KINDS = new Set(["procore", "aconex"]);

/** Datasets each connector can pull, per CONNECTOR_DATASETS in the API. */
const CONNECTOR_DATASETS: Record<string, string[]> = {
  procore: ["vendors", "rfis"],
  aconex: ["vendors", "rfis"],
};

interface PullOutcome {
  source: SourceRow;
  status: number | null;
  message: string;
  result: ConnectorPullResult | null;
  setup: ConnectorNotConfigured | null;
  raw: unknown;
}

/** Read the 501 body defensively — the verbatim body below is the authority. */
function setupOf(details: unknown): ConnectorNotConfigured | null {
  if (!details || typeof details !== "object") return null;
  const o = details as Record<string, unknown>;
  const required = (o["required"] ?? {}) as Record<string, unknown>;
  const missing = (o["missing"] ?? {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : [];
  const hasAnything =
    o["connector"] !== undefined ||
    required["credentials"] !== undefined ||
    missing["env"] !== undefined;
  if (!hasAnything) return null;
  return {
    connector: String(o["connector"] ?? "connector"),
    required: {
      credentials: strings(required["credentials"]),
      config: strings(required["config"]),
    },
    missing: { env: strings(missing["env"]), config: strings(missing["config"]) },
    env: strings(o["env"]),
    note: typeof o["note"] === "string" ? o["note"] : "",
  };
}

function isPullResult(res: unknown): ConnectorPullResult | null {
  if (!res || typeof res !== "object") return null;
  const o = res as Record<string, unknown>;
  if (typeof o["runId"] !== "string") return null;
  return {
    runId: o["runId"],
    connector: String(o["connector"] ?? ""),
    dataset: String(o["dataset"] ?? ""),
    fetched: Number(o["fetched"] ?? 0),
    staged: Number(o["staged"] ?? 0),
    projectId: typeof o["projectId"] === "string" ? o["projectId"] : null,
    nextStep: String(o["nextStep"] ?? ""),
    provenanceNote: String(o["provenanceNote"] ?? ""),
  };
}

export default function SourcesTab({
  isAdmin,
  sources,
  sourcesError,
  projects,
  onReload,
}: {
  isAdmin: boolean;
  sources: SourceRow[] | null;
  sourcesError: string | null;
  projects: ProjectPick[] | null;
  onReload: () => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const projectName = (id: string | null) =>
    id ? (projects?.find((p) => p.id === id)?.name ?? id) : "Company-wide";

  /* -------------------------------- pull ---------------------------------- */

  const [pullSource, setPullSource] = useState<SourceRow | null>(null);
  const [pDataset, setPDataset] = useState("vendors");
  const [pProjectId, setPProjectId] = useState("");
  const [pPageSize, setPPageSize] = useState("");
  const [pMaxPages, setPMaxPages] = useState("");
  const [pulling, setPulling] = useState(false);
  const [outcome, setOutcome] = useState<PullOutcome | null>(null);

  function openPull(s: SourceRow) {
    setPullSource(s);
    setPDataset(CONNECTOR_DATASETS[s.kind]?.[0] ?? "vendors");
    setPProjectId(s.projectId ?? "");
    setPPageSize("");
    setPMaxPages("");
  }

  async function onPull(ev: FormEvent) {
    ev.preventDefault();
    if (!pullSource) return;
    const s = pullSource;
    setPulling(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { dataset: pDataset };
      if (pProjectId) body["projectId"] = pProjectId;
      if (pPageSize.trim() !== "") body["pageSize"] = Number(pPageSize);
      if (pMaxPages.trim() !== "") body["maxPages"] = Number(pMaxPages);
      const res = await api.post<unknown>(`/api/v1/ingestion/sources/${s.id}/pull`, body);
      setPullSource(null);
      setOutcome({
        source: s,
        status: 200,
        message: "The connector answered and the rows were staged.",
        result: isPullResult(res),
        setup: null,
        raw: res,
      });
      onReload();
    } catch (err) {
      const status = errorStatus(err);
      const details = errorDetails(err);
      setPullSource(null);
      setOutcome({
        source: s,
        status,
        message: errorMessage(err, "The pull failed"),
        result: null,
        setup: status === 501 ? setupOf(details) : null,
        raw: err instanceof ApiClientError ? err.details : null,
      });
    } finally {
      setPulling(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  const connectorSources = (sources ?? []).filter((s) => CONNECTOR_KINDS.has(s.kind));

  return (
    <div className="space-y-4">
      <ErrorAlert message={error ?? sourcesError} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-ink-500">
          A source is where external data comes from, and every ingestion run is attributed to one.
          Connector sources (Procore, Aconex) can be pulled from here; CSV sources take file
          uploads and API-token sources receive machine pushes, both on the Ingestion workspace.
        </p>
        <Button
          variant="secondary"
          onClick={onReload}
          title="Re-read the source list from the ingestion module"
        >
          Refresh
        </Button>
      </div>

      <Caveat tone="amber">
        <span className="font-semibold">
          Neither connector transport has ever been exercised against a live vendor.
        </span>{" "}
        The OAuth exchange, pagination, extraction and field mapping are implemented and tested
        against authored fixtures — what is missing is credentials and a network route, not code.
        Treat the first successful pull as discovery: inspect the staged rows before committing
        them, because the first contact with a real tenant's data is where a fixture-shaped
        assumption breaks.
      </Caveat>

      {sources === null ? (
        <Spinner label="Loading sources…" />
      ) : sources.length === 0 ? (
        <EmptyState
          title="No ingestion sources"
          hint="Sources are created on the Ingestion workspace, where they are attached to imports."
          action={
            <Button variant="secondary" onClick={() => navigate("/ingestion?tab=sources")}>Open Ingestion → Sources</Button>
          }
        />
      ) : (
        <Table>
          <thead className="bg-ink-50">
            <tr>
              <Th>Source</Th>
              <Th>Kind</Th>
              <Th>Scope</Th>
              <Th>State</Th>
              <Th>Config keys</Th>
              <Th>Created</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50">
            {sources.map((s) => {
              const isConnector = CONNECTOR_KINDS.has(s.kind);
              const configKeys = Object.keys(s.config ?? {});
              return (
                <tr key={s.id} className="align-top hover:bg-ink-50">
                  <Td className="font-medium text-ink-900">{s.name}</Td>
                  <Td>
                    <Badge tone={sourceKindTone(s.kind)}>
                      {SOURCE_KIND_LABELS[s.kind] ?? humanize(s.kind)}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-ink-600">{projectName(s.projectId)}</Td>
                  <Td>
                    {s.isActive === 1 ? (
                      <Badge tone="green">Active</Badge>
                    ) : (
                      <Badge tone="gray">Inactive</Badge>
                    )}
                  </Td>
                  <Td>
                    {configKeys.length === 0 ? (
                      <span className="text-xs text-ink-300">none</span>
                    ) : (
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {configKeys.map((k) => (
                          <span
                            key={k}
                            className="inline-flex items-center rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-700"
                          >
                            {k}
                          </span>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{formatDateTime(s.createdAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {isConnector ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!isAdmin || s.isActive !== 1}
                          title={
                            !isAdmin
                              ? ADMIN_ONLY_HINT
                              : s.isActive !== 1
                                ? "The source is deactivated — the API refuses the pull."
                                : "Attempt a pull now and show exactly what the connector answered."
                          }
                          onClick={() => openPull(s)}
                        >
                          Pull now
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={() => navigate("/ingestion?tab=sources")}>
                          Edit in Ingestion
                        </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {connectorSources.length === 0 && (sources ?? []).length > 0 ? (
        <Card>
          <CardBody>
            <h3 className="text-sm font-semibold text-ink-900">No connector sources configured</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Only <code className="font-mono">procore</code> and{" "}
              <code className="font-mono">aconex</code> sources can be pulled. Create one on the
              Ingestion workspace, put the remote ids in its config (never credentials — the config
              column is stored in plain sight), then set the vendor environment variables. The pull
              action here will name exactly which ones are missing.
            </p>
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => navigate("/ingestion?tab=sources")}>
                  Open Ingestion → Sources
                </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* -------------------------------- pull form ---------------------------- */}
      <Modal
        open={pullSource !== null}
        title={pullSource ? `Pull from ${pullSource.name}` : "Pull"}
        onClose={() => setPullSource(null)}
      >
        {pullSource ? (
          <form onSubmit={onPull} className="space-y-4">
            <Field
              label="Dataset"
              hint="What to fetch. The connector maps vendor records into the platform's dataset registry."
            >
              <Select value={pDataset} onChange={(e) => setPDataset(e.target.value)}>
                {(CONNECTOR_DATASETS[pullSource.kind] ?? ["vendors"]).map((d) => (
                  <option key={d} value={d}>
                    {humanize(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Project"
              hint="Which ConstructOS project the pulled rows belong to. Required for project-scoped datasets such as RFIs."
            >
              <Select value={pProjectId} onChange={(e) => setPProjectId(e.target.value)}>
                <option value="">Use the source's own scope</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Page size (optional)">
                <Input
                  type="number"
                  min={1}
                  value={pPageSize}
                  onChange={(e) => setPPageSize(e.target.value)}
                  placeholder="connector default"
                />
              </Field>
              <Field label="Max pages (optional)" hint="Cap a first exploratory pull.">
                <Input
                  type="number"
                  min={1}
                  value={pMaxPages}
                  onChange={(e) => setPMaxPages(e.target.value)}
                  placeholder="connector default"
                />
              </Field>
            </div>
            <Caveat tone="ink">
              A pull stages rows and stops. It is not a privileged path into the record: the staged
              run goes through the same validation and the same explicit commit as a CSV upload, and
              nothing is written to the record until you commit it on the Ingestion workspace.
            </Caveat>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPullSource(null)} disabled={pulling}>
                Cancel
              </Button>
              <Button type="submit" disabled={pulling || !isAdmin}>
                {pulling ? "Pulling…" : "Pull now"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* ------------------------------ pull outcome --------------------------- */}
      <Modal
        open={outcome !== null}
        wide
        title={outcome ? `Pull result — ${outcome.source.name}` : "Pull result"}
        onClose={() => setOutcome(null)}
      >
        {outcome ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge
                tone={
                  outcome.status === 501
                    ? "amber"
                    : outcome.status !== null && outcome.status < 300
                      ? "green"
                      : "red"
                }
              >
                {outcome.status !== null ? `HTTP ${outcome.status}` : "No response"}
              </Badge>
              <span className="text-ink-700">{outcome.message}</span>
            </div>

            {/* ---- configured: a staged run ---- */}
            {outcome.result ? (
              <>
                <div className="rounded-md bg-ink-50 p-3">
                  <DefRow label="Run id">
                    <Mono>{outcome.result.runId}</Mono>
                  </DefRow>
                  <DefRow label="Connector">{outcome.result.connector}</DefRow>
                  <DefRow label="Dataset">{outcome.result.dataset}</DefRow>
                  <DefRow label="Fetched">
                    <span className="tabular-nums">{num(outcome.result.fetched)}</span>
                  </DefRow>
                  <DefRow label="Staged">
                    <span className="tabular-nums">{num(outcome.result.staged)}</span>
                    {outcome.result.fetched > outcome.result.staged ? (
                      <span className="ml-2 text-xs text-amber-700">
                        truncated at the per-run cap — {num(outcome.result.fetched - outcome.result.staged)}{" "}
                        rows were dropped
                      </span>
                    ) : null}
                  </DefRow>
                  <DefRow label="Project">
                    {outcome.result.projectId
                      ? projectName(outcome.result.projectId)
                      : "Company-wide"}
                  </DefRow>
                  <DefRow label="Next step">
                    <Mono>{outcome.result.nextStep}</Mono>
                  </DefRow>
                </div>
                {outcome.result.provenanceNote ? (
                  <Caveat tone="amber">{outcome.result.provenanceNote}</Caveat>
                ) : null}
                <div className="flex justify-start">
                  <Button variant="secondary" size="sm" onClick={() => navigate("/ingestion?tab=runs")}>
                      Open the staged run in Ingestion
                    </Button>
                </div>
              </>
            ) : null}

            {/* ---- not configured: setup guidance, not a failure ---- */}
            {outcome.status === 501 ? (
              <>
                <Caveat tone="amber">
                  <span className="font-semibold">
                    Not implemented in this deployment — and that is the honest answer.
                  </span>{" "}
                  Nothing was fetched and nothing was staged. The connector code exists and is
                  tested; what is absent is credentials and a network route. Below is exactly what
                  this deployment needs before a pull can happen.
                </Caveat>

                {outcome.setup ? (
                  <div className="space-y-3">
                    {outcome.setup.missing.env.length > 0 ? (
                      <div className="rounded-md bg-red-50 p-3 ring-1 ring-red-200">
                        <div className="text-xs font-semibold uppercase tracking-wide text-red-800">
                          Environment variables that are not set
                        </div>
                        <ul className="mt-1.5 space-y-1">
                          {outcome.setup.missing.env.map((v) => (
                            <li key={v}>
                              <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs text-red-900">
                                {v}
                              </code>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-[11px] leading-relaxed text-red-800">
                          Set these in the API process's environment and restart it. They are read
                          from the environment on every pull — never from the source's config
                          column, which is stored in plain sight and is not a secret store.
                        </p>
                      </div>
                    ) : null}

                    {outcome.setup.missing.config.length > 0 ? (
                      <div className="rounded-md bg-amber-50 p-3 ring-1 ring-amber-200">
                        <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                          Config keys missing from this source
                        </div>
                        <ul className="mt-1.5 space-y-1">
                          {outcome.setup.missing.config.map((v) => (
                            <li key={v}>
                              <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs text-amber-900">
                                {v}
                              </code>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-[11px] leading-relaxed text-amber-800">
                          These are remote identifiers, not secrets. Add them to the source's config
                          JSON on the Ingestion workspace.
                        </p>
                        <div className="mt-2">
                          <Button variant="secondary" size="sm" onClick={() => navigate("/ingestion?tab=sources")}>
                              Edit this source's config
                            </Button>
                        </div>
                      </div>
                    ) : null}

                    {outcome.setup.required.credentials.length > 0 ? (
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                          Credentials a real pull requires
                        </div>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-700">
                          {outcome.setup.required.credentials.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {outcome.setup.required.config.length > 0 ? (
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                          Config a real pull requires
                        </div>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-700">
                          {outcome.setup.required.config.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {outcome.setup.env.length > 0 ? (
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                          Every environment variable this connector reads
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {outcome.setup.env.map((v) => (
                            <code
                              key={v}
                              className={
                                outcome.setup?.missing.env.includes(v)
                                  ? "rounded bg-red-100 px-1.5 py-0.5 font-mono text-[11px] text-red-900"
                                  : "rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[11px] text-emerald-900"
                              }
                              title={
                                outcome.setup?.missing.env.includes(v)
                                  ? "Not set in this deployment"
                                  : "Set, or has a default"
                              }
                            >
                              {v}
                            </code>
                          ))}
                        </div>
                        <p className="mt-1 text-[11px] text-ink-400">
                          Red = reported missing by this pull. Green = set, or covered by a
                          documented default.
                        </p>
                      </div>
                    ) : null}

                    {outcome.setup.note ? (
                      <Caveat tone="ink">
                        <span className="font-semibold">The connector's own note:</span>{" "}
                        {outcome.setup.note}
                      </Caveat>
                    ) : null}
                  </div>
                ) : (
                  <Caveat tone="red">
                    The 501 body did not carry a recognisable requirements block. The verbatim
                    response below is the authority.
                  </Caveat>
                )}
              </>
            ) : null}

            {/* ---- anything else ---- */}
            {outcome.status !== 501 && !outcome.result ? (
              <Caveat tone="red">
                This is not the &ldquo;not configured&rdquo; refusal — the request was rejected for
                another reason. The verbatim body below carries the API's own explanation.
              </Caveat>
            ) : null}

            <VerbatimBody body={outcome.raw} />

            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setOutcome(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
