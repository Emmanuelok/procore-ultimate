/**
 * Labour-rights indicator register (#671-675). Every indicator raised — from
 * an audit, an inspection, a detector or the worker's own report — sits here
 * with its signal, until somebody records what was actually done about it.
 */
import { useCallback, useEffect, useState } from "react";
import { LABOUR_RISK_INDICATORS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
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
import { formatDate } from "../format";
import {
  IndicatorBadge,
  LoadError,
  label,
  severityTone,
  type ListResponse,
  type RiskFlagRow,
  type VendorRow,
} from "./workforceShared";

export default function IndicatorsTab({
  projectId,
  vendors,
  onMutate,
}: {
  projectId: string;
  vendors: VendorRow[];
  onMutate: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [rows, setRows] = useState<RiskFlagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indicator, setIndicator] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ pageSize: "200" });
    if (indicator) params.set("indicator", indicator);
    if (vendorId) params.set("vendorId", vendorId);
    if (openOnly) params.set("open", "true");
    try {
      const res = await api.get<ListResponse<RiskFlagRow>>(
        `${base}/labour-risk-flags?${params.toString()}`,
      );
      setRows(res.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load the indicator register");
    }
  }, [base, indicator, vendorId, openOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const [resolving, setResolving] = useState<RiskFlagRow | null>(null);
  const [resolution, setResolution] = useState("");
  const [resolveError, setResolveError] = useState<string | null>(null);

  async function onResolve() {
    if (!resolving || !resolution.trim()) return;
    setBusy(true);
    setResolveError(null);
    try {
      await api.post(`${base}/labour-risk-flags/${resolving.id}/resolve`, {
        resolution: resolution.trim(),
      });
      setResolving(null);
      setResolution("");
      await load();
      onMutate();
    } catch (err) {
      setResolveError(
        err instanceof ApiClientError ? err.message : "Failed to resolve the indicator.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 py-3">
          <div className="w-56">
            <Field label="Indicator">
              <Select value={indicator} onChange={(e) => setIndicator(e.target.value)}>
                <option value="">All indicators</option>
                {LABOUR_RISK_INDICATORS.map((i) => (
                  <option key={i} value={i}>
                    {label(i)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-52">
            <Field label="Employer">
              <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">All employers</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(e) => setOpenOnly(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            Open only
          </label>
        </CardBody>
      </Card>

      <ErrorAlert message={error} />

      {rows !== null && rows.length === 0 && error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner label="Loading labour-rights indicators…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={openOnly ? "No open indicators" : "No indicators raised"}
          hint="Indicators are raised from the worker register, welfare inspections, labour audits and the worker voice channel. Each one also lands on the signal register for independent review."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Raised</Th>
              <Th>Indicator</Th>
              <Th>Subject</Th>
              <Th>Source</Th>
              <Th>Severity</Th>
              <Th>Detail</Th>
              <Th>State</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((f) => (
              <tr key={f.id}>
                <Td className="whitespace-nowrap tabular-nums text-ink-600">
                  {formatDate(f.createdAt)}
                </Td>
                <Td>
                  <IndicatorBadge indicator={f.indicator} />
                </Td>
                <Td className="text-ink-800">
                  {f.workerId ? (
                    <>
                      <span className="font-mono text-xs text-ink-500">
                        {f.workerReference ?? "worker"}
                      </span>{" "}
                      {f.workerName ?? ""}
                    </>
                  ) : (
                    (f.vendorName ?? "Subcontractor")
                  )}
                </Td>
                <Td className="text-ink-600">{label(f.source)}</Td>
                <Td>
                  <Badge tone={severityTone(f.severity)}>{label(f.severity)}</Badge>
                </Td>
                <Td className="max-w-xs text-xs text-ink-600">
                  {f.detail ?? <span className="text-ink-300">—</span>}
                </Td>
                <Td>
                  {f.resolvedAt ? (
                    <span title={f.resolution ?? undefined}>
                      <Badge tone="green">Resolved</Badge>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setResolveError(null);
                        setResolution("");
                        setResolving(f);
                      }}
                    >
                      Resolve
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={resolving !== null}
        title={resolving ? `Resolve — ${label(resolving.indicator)}` : "Resolve"}
        onClose={() => setResolving(null)}
      >
        <ErrorAlert message={resolveError} />
        <div className="space-y-3">
          <p className="text-xs text-ink-500">
            Record what was actually done. The signal is not deleted — it stays on the register
            with this note against it.
          </p>
          <Field label="Resolution">
            <Input
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="Passports returned to all 14 workers and safe-storage lockers issued"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setResolving(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !resolution.trim()} onClick={() => void onResolve()}>
              {busy ? "Saving…" : "Resolve"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
