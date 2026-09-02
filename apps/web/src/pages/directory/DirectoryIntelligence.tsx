/**
 * Directory intelligence: duplicate detection with an explanation and a
 * reversible merge (#11), and CSV import with a dry run before anything is
 * written (#77).
 *
 * Both views are deliberately explainable. A duplicate pair carries the
 * REASONS it was flagged and a confidence — never a bare score — and a merge
 * is journalled with what it re-pointed, so it can be undone. An import shows
 * every row-level finding before the commit button becomes meaningful, and a
 * row with an error is never written.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Skeleton,
  Stat,
  Table,
  Td,
  Th,
} from "../../ui";
import { IconRefresh, IconUpload } from "../../ui/icons";
import { formatDateTime } from "../format";
import {
  asList,
  errorMessage,
  humanize,
  num,
  type DuplicatePair,
  type ImportJob,
  type ImportPreview,
  type VendorMerge,
  type VendorPerformance,
} from "../admin/substrate";

export default function DirectoryIntelligenceTabs({ view }: { view: "duplicates" | "import" }) {
  return view === "duplicates" ? <DuplicatesView /> : <ImportView />;
}

/* ============================ Duplicates =============================== */

function DuplicatesView() {
  const [pairs, setPairs] = useState<DuplicatePair[] | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minConfidence, setMinConfidence] = useState("0.45");
  const [merges, setMerges] = useState<VendorMerge[] | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: DuplicatePair[]; total: number; scanned: number }>(
        `/api/v1/vendors/duplicates?minConfidence=${minConfidence}&limit=100`,
      );
      setPairs(res.items);
      setScanned(res.scanned);
    } catch (err) {
      setPairs([]);
      setScanned(null);
      setError(errorMessage(err, "Failed to scan for duplicates"));
    }
  }, [minConfidence]);

  const loadMerges = useCallback(async () => {
    setMergeError(null);
    try {
      const res = await api.get<unknown>("/api/v1/vendor-merges?pageSize=50");
      setMerges(asList<VendorMerge>(res).items);
    } catch (err) {
      setMerges([]);
      setMergeError(errorMessage(err, "Failed to load the merge journal"));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadMerges();
  }, [load, loadMerges]);

  async function merge(pair: DuplicatePair, direction: "aIntoB" | "bIntoA") {
    const from = direction === "aIntoB" ? pair.aVendor : pair.bVendor;
    const into = direction === "aIntoB" ? pair.bVendor : pair.aVendor;
    if (!from || !into) return;
    if (
      !window.confirm(
        `Merge "${from.name}" into "${into.name}"? Every commitment, bid, invoice, contact and certificate pointing at "${from.name}" is re-pointed. This is journalled and can be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await api.post<{ movements?: Array<{ table: string; rows: number }> }>(
        `/api/v1/vendors/${from.id}/merge`,
        { intoVendorId: into.id },
      );
      const moved = (res.movements ?? [])
        .filter((m) => m.rows > 0)
        .map((m) => `${m.rows} ${humanize(m.table).toLowerCase()}`)
        .join(", ");
      toast.success(`Merged — ${moved || "no references to move"}`);
      await load();
      await loadMerges();
    } catch (err) {
      setError(errorMessage(err, "Merge failed"));
    } finally {
      setBusy(false);
    }
  }

  async function undo(row: VendorMerge) {
    setBusy(true);
    try {
      await api.post(`/api/v1/vendor-merges/${row.id}/undo`, {});
      toast.success("Merge undone");
      await load();
      await loadMerges();
    } catch (err) {
      setMergeError(errorMessage(err, "Undo failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Candidate pairs" value={pairs === null ? "—" : num(pairs.length)} />
        <Stat label="Vendors scanned" value={num(scanned)} />
        <Stat
          label="Merges journalled"
          value={merges === null ? "—" : num(merges.length)}
          hint="Each can be undone inside its window"
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Minimum confidence" className="w-44">
          <Select
            size="sm"
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value)}
          >
            <option value="0.3">0.30 — broad</option>
            <option value="0.45">0.45 — default</option>
            <option value="0.7">0.70 — strong only</option>
          </Select>
        </Field>
        <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void load()}>
          Rescan
        </Button>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {pairs === null ? (
        <Skeleton className="h-40 w-full" />
      ) : pairs.length === 0 ? (
        <EmptyState
          title="No likely duplicates"
          hint={`Compared name (legal form stripped), tax id, registration number, email domain, phone and address across ${num(scanned)} vendors at this threshold.`}
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Vendor A</Th>
                <Th>Vendor B</Th>
                <Th>Confidence</Th>
                <Th>Why</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => (
                <tr key={`${p.a}-${p.b}`}>
                  <Td>
                    <button
                      type="button"
                      className="text-left font-medium text-content-strong hover:underline"
                      onClick={() => setInspect(p.a)}
                    >
                      {p.aVendor?.name ?? p.a}
                    </button>
                    <div className="text-2xs text-content-muted">
                      {p.aVendor?.city ?? ""} {p.aVendor?.taxId ? `· ${p.aVendor.taxId}` : ""}
                    </div>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      className="text-left font-medium text-content-strong hover:underline"
                      onClick={() => setInspect(p.b)}
                    >
                      {p.bVendor?.name ?? p.b}
                    </button>
                    <div className="text-2xs text-content-muted">
                      {p.bVendor?.city ?? ""} {p.bVendor?.taxId ? `· ${p.bVendor.taxId}` : ""}
                    </div>
                  </Td>
                  <Td>
                    <Badge
                      tone={p.confidence >= 0.75 ? "danger" : p.confidence >= 0.55 ? "warning" : "neutral"}
                    >
                      {p.confidence.toFixed(2)}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-content-muted">{p.reasons.join("; ")}</Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void merge(p, "aIntoB")}
                      >
                        A → B
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void merge(p, "bIntoA")}
                      >
                        B → A
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card>
        <div className="border-b border-border-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-content-strong">Merge journal</h3>
          <p className="mt-0.5 text-xs text-content-muted">
            What each merge re-pointed, and whether it can still be undone.
          </p>
        </div>
        <CardBody>
          <ErrorAlert message={mergeError} onRetry={() => void loadMerges()} />
          {merges === null ? (
            <Skeleton className="h-20 w-full" />
          ) : merges.length === 0 ? (
            <p className="text-xs text-content-muted">No merges have been performed.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Merged</Th>
                  <Th>Moved</Th>
                  <Th>When</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {merges.map((m) => {
                  const expired = Date.parse(m.undoDeadline) < Date.now();
                  return (
                    <tr key={m.id}>
                      <Td className="text-xs">
                        <span className="font-medium">{m.sourceName}</span> → {m.targetName}
                      </Td>
                      <Td className="text-2xs text-content-muted">
                        {(m.movements ?? [])
                          .filter((mv) => mv.rows > 0)
                          .map((mv) => `${humanize(mv.table)}: ${mv.rows}`)
                          .join(", ") || "nothing"}
                      </Td>
                      <Td>{formatDateTime(m.createdAt)}</Td>
                      <Td>
                        {m.undoneAt ? (
                          <Badge tone="neutral">Undone</Badge>
                        ) : expired ? (
                          <span className="text-2xs text-content-subtle">
                            Undo window closed
                          </span>
                        ) : (
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void undo(m)}
                          >
                            Undo
                          </Button>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <VendorPerformanceDrawer vendorId={inspect} onClose={() => setInspect(null)} />
    </div>
  );
}

function VendorPerformanceDrawer({
  vendorId,
  onClose,
}: {
  vendorId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<VendorPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vendorId) {
      setData(null);
      return;
    }
    setError(null);
    api
      .get<VendorPerformance>(`/api/v1/vendors/${vendorId}/performance`)
      .then(setData)
      .catch((err) => {
        setData(null);
        setError(errorMessage(err, "Failed to load vendor performance"));
      });
  }, [vendorId]);

  return (
    <Drawer
      open={vendorId !== null}
      onClose={onClose}
      size="md"
      title={data ? data.vendor.name : "Vendor"}
    >
      <div className="space-y-4 p-4">
        <ErrorAlert message={error} />
        {!data ? (
          error ? null : (
            <Skeleton className="h-40 w-full" />
          )
        ) : (
          <>
            <Alert tone="info" size="sm">
              Money is bucketed by currency and never summed across — a vendor working in two
              currencies has two totals, not one meaningless one.
            </Alert>

            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-content-subtle">
                Commitments
              </h4>
              {data.commitments.byCurrency.length === 0 ? (
                <p className="text-xs text-content-muted">None.</p>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {data.commitments.byCurrency.map((c) => (
                    <li key={c.currency}>
                      {c.currency}: {num(c.count)} worth{" "}
                      {new Intl.NumberFormat(undefined, {
                        style: "currency",
                        currency: c.currency,
                        maximumFractionDigits: 0,
                      }).format(c.value)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-2xs text-content-subtle">
                Total across currencies: — ({data.commitments.total.reasons.join("; ")})
              </p>
            </section>

            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-content-subtle">
                Invoices
              </h4>
              {data.invoices.byCurrencyAndStatus.length === 0 ? (
                <p className="text-xs text-content-muted">None.</p>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {data.invoices.byCurrencyAndStatus.map((r) => (
                    <li key={`${r.currency}-${r.status}`}>
                      {humanize(r.status)} · {r.currency}: {num(r.count)}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="grid gap-3 sm:grid-cols-2">
              <Stat label="Open NCRs" value={num(data.quality.openNcrs)} />
              <Stat label="Safety incidents" value={num(data.safety.incidents)} />
              <Stat label="Bid submissions" value={num(data.bidding.submissions)} />
              <Stat
                label="Insurance"
                value={num(data.insurance.certificates)}
                hint={
                  data.insurance.nextExpiry
                    ? `Next expiry ${formatDateTime(data.insurance.nextExpiry)}`
                    : "No expiry recorded"
                }
              />
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

/* ============================== Import ================================= */

const DATASETS = ["vendors", "contacts"] as const;

function ImportView() {
  const [dataset, setDataset] = useState<string>("vendors");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const res = await api.get<unknown>("/api/v1/imports?pageSize=50");
      setJobs(asList<ImportJob>(res).items);
    } catch {
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  async function downloadTemplate() {
    try {
      const text = await api.get<string>(`/api/v1/imports/${dataset}/template`);
      setCsv(typeof text === "string" ? text : JSON.stringify(text));
      setFileName(`${dataset}-template.csv`);
      toast.success("Template loaded into the editor — replace the hint row with your data");
    } catch (err) {
      setError(errorMessage(err, "Failed to fetch the template"));
    }
  }

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ImportPreview>(`/api/v1/imports/${dataset}/preview`, {
        csv,
        ...(fileName ? { fileName } : {}),
      });
      setPreview(res);
    } catch (err) {
      setPreview(null);
      setError(errorMessage(err, "The file could not be parsed"));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.post<{ created: number; updated: number }>(
        `/api/v1/directory/imports/${preview.id}/commit`,
        {},
      );
      toast.success(`${res.created} created, ${res.updated} updated`);
      setPreview(null);
      setCsv("");
      await loadJobs();
    } catch (err) {
      setError(errorMessage(err, "Commit failed"));
    } finally {
      setBusy(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  const rowErrors = new Map<number, string[]>();
  for (const e of preview?.errors ?? []) {
    const list = rowErrors.get(e.row) ?? [];
    list.push(`${e.severity === "warning" ? "warning" : "error"}: ${e.message}`);
    rowErrors.set(e.row, list);
  }

  return (
    <div className="space-y-4">
      <Alert tone="info" size="sm">
        Two steps, always. The preview parses and validates and writes nothing; the commit replays
        the rows that were reviewed. A row with an error against it is never written, and the row
        number is the one you see in your spreadsheet.
      </Alert>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Dataset" className="w-44">
              <Select size="sm" value={dataset} onChange={(e) => setDataset(e.target.value)}>
                {DATASETS.map((d) => (
                  <option key={d} value={d}>
                    {humanize(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Button size="sm" variant="secondary" onClick={() => void downloadTemplate()}>
              Load template
            </Button>
            <Field label="Or pick a file" className="w-64">
              <Input type="file" accept=".csv,text/csv" size="sm" onChange={onFile} />
            </Field>
          </div>

          <Field label="CSV" hint={fileName ? `From ${fileName}` : "Paste or load a template"}>
            <textarea
              className="h-40 w-full rounded border border-border-subtle bg-surface-default p-2 font-mono text-xs"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              spellCheck={false}
            />
          </Field>

          <div className="flex gap-2">
            <Button
              size="sm"
              leadingIcon={IconUpload}
              loading={busy && !preview}
              disabled={csv.trim().length === 0}
              onClick={() => void runPreview()}
            >
              Dry run
            </Button>
            {preview ? (
              <Button
                size="sm"
                loading={busy}
                disabled={preview.validCount === 0}
                onClick={() => void commit()}
              >
                Commit {num(preview.validCount)} valid row(s)
              </Button>
            ) : null}
          </div>

          <ErrorAlert message={error} />
        </CardBody>
      </Card>

      {preview ? (
        <Card>
          <div className="border-b border-border-subtle px-4 py-3">
            <h3 className="text-sm font-semibold text-content-strong">Dry run</h3>
            <p className="mt-0.5 text-xs text-content-muted">
              {num(preview.rowCount)} rows read · {num(preview.validCount)} writable ·{" "}
              {num(preview.errorCount)} with errors
            </p>
          </div>
          <CardBody>
            {preview.rows.length === 0 ? (
              <p className="text-xs text-content-muted">The file contained no data rows.</p>
            ) : (
              <div className="max-h-96 overflow-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Row</Th>
                      {preview.columns.map((c) => (
                        <Th key={c.key}>{c.label}</Th>
                      ))}
                      <Th>Findings</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => {
                      const findings = rowErrors.get(i + 2) ?? [];
                      const failed = findings.some((f) => f.startsWith("error"));
                      return (
                        <tr key={i} className={failed ? "bg-danger-subtle/30" : undefined}>
                          <Td className="font-mono text-2xs">{i + 2}</Td>
                          {preview.columns.map((c) => (
                            <Td key={c.key} className="max-w-40 truncate text-xs">
                              {row[c.key] ?? ""}
                            </Td>
                          ))}
                          <Td className="text-2xs">
                            {findings.length === 0 ? (
                              <Badge tone="success">Will write</Badge>
                            ) : (
                              <span className={failed ? "text-danger-text" : "text-warning-text"}>
                                {findings.join("; ")}
                              </span>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            )}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <div className="border-b border-border-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-content-strong">Import history</h3>
        </div>
        <CardBody>
          {jobs === null ? (
            <Skeleton className="h-20 w-full" />
          ) : jobs.length === 0 ? (
            <p className="text-xs text-content-muted">Nothing has been imported yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Dataset</Th>
                  <Th>File</Th>
                  <Th>Status</Th>
                  <Th>Result</Th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <Td>{formatDateTime(j.createdAt)}</Td>
                    <Td>{humanize(j.dataset)}</Td>
                    <Td className="max-w-40 truncate text-xs">{j.fileName ?? "—"}</Td>
                    <Td>
                      <Badge
                        tone={
                          j.status === "committed"
                            ? "success"
                            : j.status === "failed"
                              ? "danger"
                              : "info"
                        }
                      >
                        {humanize(j.status)}
                      </Badge>
                    </Td>
                    <Td className="text-xs text-content-muted">
                      {j.status === "committed"
                        ? `${num(j.createdCount)} created, ${num(j.updatedCount)} updated`
                        : `${num(j.validCount)} of ${num(j.rowCount)} valid`}
                    </Td>
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
