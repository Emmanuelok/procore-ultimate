/**
 * Per-project metric snapshots (#829-830, #853): compute a metric NOW from
 * the platform's real records and freeze value + inputs for audit; then —
 * as a separate, deliberate act — contribute that frozen figure to the
 * anonymized cross-company pool.
 *
 * Honesty rules kept here:
 *   · a 422 "cannot compute" lists the server's missing-input reasons
 *     VERBATIM — the platform never invents a number;
 *   · contribution is explained before it happens (what leaves the tenant,
 *     what never comes back) and is idempotent per snapshot.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ASSET_CLASSES } from "@constructos/shared";
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
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import {
  LoadError,
  computeFailureFrom,
  errorMessage,
  fmtNum,
  label,
} from "./benchmarksShared";
import type {
  ComputeFailure,
  ContributeResponse,
  ListResponse,
  MetricDef,
  SnapshotRow,
} from "./benchmarksShared";

export default function SnapshotsTab({
  projectId,
  metrics,
  minSampleN,
}: {
  projectId: string;
  metrics: MetricDef[] | null;
  minSampleN: number;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [computeMetric, setComputeMetric] = useState("");
  const [computing, setComputing] = useState(false);
  const [computeFailure, setComputeFailure] = useState<ComputeFailure | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [inputsFor, setInputsFor] = useState<SnapshotRow | null>(null);
  const [contributeFor, setContributeFor] = useState<SnapshotRow | null>(null);
  const [contributeNotice, setContributeNotice] = useState<string | null>(null);

  const metricName = useCallback(
    (key: string) => metrics?.find((m) => m.key === key)?.name ?? label(key),
    [metrics],
  );

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<ListResponse<SnapshotRow>>(
        `/api/v1/projects/${projectId}/benchmarks/snapshots?page=1&pageSize=100`,
      );
      setSnapshots(res.items);
      setTotal(res.total);
    } catch (err) {
      setSnapshots(null);
      setLoadError(errorMessage(err, "Failed to load snapshots"));
    }
  }, [projectId]);

  useEffect(() => {
    setSnapshots(null);
    setComputeFailure(null);
    setActionError(null);
    setContributeNotice(null);
    void load();
  }, [load]);

  async function compute() {
    if (!computeMetric) return;
    setComputing(true);
    setComputeFailure(null);
    setActionError(null);
    setContributeNotice(null);
    try {
      await api.post<SnapshotRow>(`/api/v1/projects/${projectId}/benchmarks/snapshots`, {
        metric: computeMetric,
      });
      await load();
    } catch (err) {
      const failure = computeFailureFrom(err, computeMetric);
      if (failure) setComputeFailure(failure);
      else setActionError(errorMessage(err, "Failed to compute the snapshot"));
    } finally {
      setComputing(false);
    }
  }

  if (loadError) return <LoadError message={loadError} onRetry={() => void load()} />;

  return (
    <div className="space-y-4">
      <ErrorAlert message={actionError} />

      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <div className="min-w-56">
            <Field label="Metric">
              <Select
                value={computeMetric}
                onChange={(e) => setComputeMetric(e.target.value)}
                disabled={!metrics}
              >
                <option value="">{metrics ? "Select a metric…" : "Loading metrics…"}</option>
                {(metrics ?? []).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name} ({m.unit})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button onClick={() => void compute()} disabled={!computeMetric || computing}>
            {computing ? "Computing…" : "Compute snapshot"}
          </Button>
          <p className="basis-full text-xs text-ink-400 sm:basis-auto sm:flex-1">
            Computes from the project's live records and freezes value + inputs for audit. Nothing
            leaves this company until the snapshot is explicitly contributed.
          </p>
        </CardBody>
      </Card>

      {computeFailure ? (
        <div className="rounded-md bg-amber-50 px-4 py-3 ring-1 ring-amber-200" role="alert">
          <p className="text-sm font-medium text-amber-900">
            {metricName(computeFailure.metric)} could not be computed — required inputs are
            missing. No value was stored or invented.
          </p>
          {computeFailure.reasons.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {computeFailure.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-amber-800">
                  <span aria-hidden className="mt-0.5">▪</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-amber-800">{computeFailure.message}</p>
          )}
          {computeFailure.inputs ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-amber-700">
                Inputs the computation read
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-white/70 p-2 text-[11px] leading-4 text-ink-700">
                {JSON.stringify(computeFailure.inputs, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {contributeNotice ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-100">
          {contributeNotice}
        </div>
      ) : null}

      {snapshots === null ? (
        <Spinner label="Loading snapshots…" />
      ) : snapshots.length === 0 ? (
        <EmptyState
          title="No snapshots for this project yet"
          hint="Compute a metric above to freeze the first auditable figure. Snapshots stay private to this company until contributed."
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Metric</Th>
                <Th>Value</Th>
                <Th>Computed</Th>
                <Th>Contribution</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <div className="font-medium text-ink-900">{metricName(s.metric)}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-ink-400">{s.metric}</div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <span className="font-semibold tabular-nums text-ink-900">
                      {fmtNum(s.value)}
                    </span>{" "}
                    <span className="text-xs text-ink-500">{s.unit}</span>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {formatDateTime(s.createdAt)}
                  </Td>
                  <Td>
                    {s.contributedSampleId ? (
                      <Badge tone="green">Contributed</Badge>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => setContributeFor(s)}>
                        Contribute…
                      </Button>
                    )}
                  </Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setInputsFor(s)}>
                      Inputs
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {total > snapshots.length ? (
            <p className="text-xs text-ink-400">
              Showing the {snapshots.length} most recent of {total} snapshots.
            </p>
          ) : null}
        </>
      )}

      <Modal
        open={inputsFor !== null}
        title={inputsFor ? `Inputs — ${metricName(inputsFor.metric)}` : "Inputs"}
        onClose={() => setInputsFor(null)}
        wide
      >
        {inputsFor ? (
          <div>
            <p className="mb-2 text-xs text-ink-500">
              The exact figures this snapshot was computed from, frozen at{" "}
              {formatDateTime(inputsFor.createdAt)} for auditability.
            </p>
            <pre className="max-h-96 overflow-auto rounded-md bg-ink-50 p-3 text-xs leading-5 text-ink-800">
              {JSON.stringify(inputsFor.inputs ?? {}, null, 2)}
            </pre>
          </div>
        ) : null}
      </Modal>

      {contributeFor ? (
        <ContributeDialog
          projectId={projectId}
          snapshot={contributeFor}
          metricName={metricName(contributeFor.metric)}
          minSampleN={minSampleN}
          onClose={() => setContributeFor(null)}
          onDone={(notice) => {
            setContributeFor(null);
            setContributeNotice(notice);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/* ----------------------------- Contribute dialog ---------------------------- */

function ContributeDialog({
  projectId,
  snapshot,
  metricName,
  minSampleN,
  onClose,
  onDone,
}: {
  projectId: string;
  snapshot: SnapshotRow;
  metricName: string;
  minSampleN: number;
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const [assetClass, setAssetClass] = useState<string>("");
  const [region, setRegion] = useState("GB");
  const [dataYear, setDataYear] = useState("");
  const [methodology, setMethodology] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!assetClass || region.trim().length < 2) {
      setError("Asset class and a region of at least 2 characters are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<ContributeResponse>(
        `/api/v1/projects/${projectId}/benchmarks/snapshots/${snapshot.id}/contribute`,
        {
          assetClass,
          region: region.trim(),
          ...(dataYear.trim() ? { dataYear: Number(dataYear.trim()) } : {}),
          ...(methodology.trim() ? { methodology: methodology.trim() } : {}),
        },
      );
      onDone(
        res.alreadyContributed
          ? `This snapshot had already been contributed — no duplicate sample was created (contribution is idempotent per snapshot).`
          : `Contributed ${fmtNum(snapshot.value)} ${snapshot.unit} to the anonymized ${
              res.sample ? `${label(res.sample.assetClass)} / ${res.sample.region}` : ""
            } pool for ${metricName}. This company now has contributed access to that metric's distribution.`,
      );
    } catch (err) {
      setError(errorMessage(err, "Failed to contribute the snapshot"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={`Contribute — ${metricName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="rounded-md bg-ink-50 px-3 py-2 text-sm">
          <span className="font-semibold tabular-nums text-ink-900">{fmtNum(snapshot.value)}</span>{" "}
          <span className="text-ink-600">{snapshot.unit}</span>
          <span className="ml-2 text-xs text-ink-400">
            frozen {formatDateTime(snapshot.createdAt)}
          </span>
        </div>

        <div className="rounded-md bg-brand-50 px-3 py-2 text-xs leading-5 text-brand-900 ring-1 ring-brand-100">
          <p className="font-semibold">Anonymization — what leaves this company</p>
          <p className="mt-1">
            Only the value, unit, asset class, region, data year and methodology enter the shared
            pool. Your company and project identities are retained solely to enforce
            contribute-to-access and the minimum sample count — no read path ever returns them, to
            anyone, including you. Cells with fewer than {minSampleN} contributors publish nothing but
            their sample size. Contribution is permanent and unlocks this metric's contributed
            distribution for your company.
          </p>
        </div>

        <ErrorAlert message={error} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Asset class">
            <Select value={assetClass} onChange={(e) => setAssetClass(e.target.value)} required>
              <option value="">Select…</option>
              {ASSET_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Region" hint="e.g. GB — stored uppercase">
            <Input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              minLength={2}
              maxLength={40}
              required
            />
          </Field>
        </div>
        <Field label="Data year (optional)" hint="Defaults to the snapshot's year">
          <Input
            type="number"
            min={1990}
            max={2100}
            value={dataYear}
            onChange={(e) => setDataYear(e.target.value)}
            placeholder={String(new Date(snapshot.createdAt).getUTCFullYear())}
          />
        </Field>
        <Field
          label="Methodology (optional)"
          hint="Shown verbatim to everyone who reads the distribution — describe how the figure was measured, never who measured it"
        >
          <Textarea
            value={methodology}
            onChange={(e) => setMethodology(e.target.value)}
            maxLength={2000}
            placeholder="e.g. GFA measured to IPMS 2; cost is executed contract sums plus agreed variations"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !assetClass}>
            {submitting ? "Contributing…" : "Contribute anonymized sample"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
