/**
 * The per-endpoint delivery log — the operator's evidence of what left the
 * platform and what the receiver said back.
 *
 * Two things this view has to be straight about:
 *
 *  · a manual retry re-sends IDENTICAL BYTES under an IDENTICAL SIGNATURE
 *    (the signed timestamp is fixed at enqueue, not per attempt), so a
 *    receiver that does not dedupe on x-constructos-delivery will process the
 *    event twice. The retry control says so before it fires;
 *  · the stored response body is truncated server-side to
 *    WEBHOOK_RESPONSE_BODY_LIMIT characters. What is shown is what was kept,
 *    not what the receiver sent.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import {
  ADMIN_ONLY_HINT,
  Caveat,
  CodeBlock,
  CopyButton,
  DELIVERY_STATUSES,
  DELIVERY_STATUS_LABELS,
  DefRow,
  Mono,
  asList,
  deliveryTone,
  errorMessage,
  num,
  type DeliveryRow,
  type DeliveryTuning,
  type EndpointView,
} from "./integrationsShared";

export default function DeliveryLog({
  endpoint,
  isAdmin,
  tuning,
  onEndpointChanged,
}: {
  endpoint: EndpointView;
  isAdmin: boolean;
  tuning: DeliveryTuning | null;
  onEndpointChanged: () => void;
}) {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const pageSize = 25;

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) qs.set("status", status);
      const res = await api.get<unknown>(
        `/api/v1/integrations/webhooks/${endpoint.id}/deliveries?${qs.toString()}`,
      );
      const list = asList<DeliveryRow>(res);
      setRows(list.items);
      setTotal(list.total);
    } catch (err) {
      setRows((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load the delivery log"));
    }
  }, [endpoint.id, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRetry(row: DeliveryRow) {
    if (
      !window.confirm(
        `Retry delivery ${row.id}?\n\n` +
          "The receiver gets the SAME bytes and the SAME x-constructos-signature as before — " +
          "the signed timestamp was fixed at enqueue and does not move. If the receiver does not " +
          "dedupe on the x-constructos-delivery header, it will process this event a second time.\n\n" +
          "The attempt budget is re-armed from zero; the attempt count it replaces is preserved " +
          "in the ledger.",
      )
    ) {
      return;
    }
    setRetrying(row.id);
    setError(null);
    try {
      await api.post<{ delivery: DeliveryRow | null }>(
        `/api/v1/integrations/webhooks/deliveries/${row.id}/retry`,
      );
      await load();
      // A retry that succeeds clears the endpoint's consecutive-failure run.
      onEndpointChanged();
    } catch (err) {
      setError(errorMessage(err, "Retry failed"));
    } finally {
      setRetrying(null);
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <ErrorAlert message={error} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-ink-500" htmlFor="delivery-status">
            Status
          </label>
          <Select
            id="delivery-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="w-56"
          >
            <option value="">All statuses</option>
            {DELIVERY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {DELIVERY_STATUS_LABELS[s] ?? s}
              </option>
            ))}
          </Select>
          <span className="text-xs text-ink-400">
            {num(total)} {total === 1 ? "delivery" : "deliveries"}
          </span>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {rows === null ? (
        <Spinner label="Loading deliveries…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={status ? `No ${DELIVERY_STATUS_LABELS[status] ?? status} deliveries` : "No deliveries yet"}
          hint={
            status
              ? "Clear the filter to see every delivery recorded for this endpoint."
              : "Nothing matching this endpoint's subscription has been appended to the ledger since it was created. Past ledger entries are never replayed — only appends made after the endpoint existed are delivered. Send a test ping to prove the transport end to end."
          }
        />
      ) : (
        <>
          <Table>
            <thead className="bg-ink-50">
              <tr>
                <Th>Queued</Th>
                <Th>Event</Th>
                <Th>Status</Th>
                <Th>Attempts</Th>
                <Th>Response</Th>
                <Th>Next attempt</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {rows.map((row) => {
                const open = expanded === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr className="hover:bg-ink-50">
                      <Td className="whitespace-nowrap">{formatDateTime(row.createdAt)}</Td>
                      <Td>
                        <span className="font-mono text-xs text-ink-800">{row.eventKind}</span>
                      </Td>
                      <Td>
                        <Badge tone={deliveryTone(row.status)}>
                          {DELIVERY_STATUS_LABELS[row.status] ?? row.status}
                        </Badge>
                      </Td>
                      <Td className="tabular-nums">
                        {row.attempts}
                        {tuning ? (
                          <span className="text-ink-400"> / {tuning.maxAttempts}</span>
                        ) : null}
                      </Td>
                      <Td>
                        {row.responseStatus !== null ? (
                          <span
                            className={
                              row.responseStatus >= 200 && row.responseStatus < 300
                                ? "font-mono text-xs text-emerald-700"
                                : "font-mono text-xs text-red-700"
                            }
                          >
                            HTTP {row.responseStatus}
                          </span>
                        ) : row.error ? (
                          <span className="text-xs text-red-700" title={row.error}>
                            no response
                          </span>
                        ) : (
                          <span className="text-ink-300">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-ink-500">
                        {row.status === "delivered"
                          ? formatDateTime(row.deliveredAt)
                          : row.nextAttemptAt
                            ? formatDateTime(row.nextAttemptAt)
                            : "—"}
                      </Td>
                      <Td>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpanded(open ? null : row.id)}
                          >
                            {open ? "Hide" : "Inspect"}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!isAdmin || row.status === "delivered" || retrying === row.id}
                            title={
                              !isAdmin
                                ? ADMIN_ONLY_HINT
                                : row.status === "delivered"
                                  ? "Already delivered — the API refuses (409) rather than duplicate it at the receiver."
                                  : "Re-send identical bytes and signature now."
                            }
                            onClick={() => void onRetry(row)}
                          >
                            {retrying === row.id ? "Retrying…" : "Retry"}
                          </Button>
                        </div>
                      </Td>
                    </tr>
                    {open ? (
                      <tr className="bg-ink-50/60">
                        <td colSpan={7} className="px-4 py-3">
                          <DeliveryDetail row={row} tuning={tuning} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>

          {pages > 1 ? (
            <div className="flex items-center justify-end gap-2 text-xs text-ink-500">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span>
                Page {page} of {pages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function DeliveryDetail({ row, tuning }: { row: DeliveryRow; tuning: DeliveryTuning | null }) {
  const bodyLimit = tuning?.responseBodyLimit ?? null;
  const body = row.responseBody ?? "";
  const looksTruncated = body.includes("…[truncated");
  return (
    <div className="space-y-3">
      <div className="rounded-md bg-white p-3 ring-1 ring-ink-100">
        <DefRow label="Delivery id">
          <span className="inline-flex items-center gap-2">
            <Mono>{row.id}</Mono>
            <CopyButton text={row.id} />
          </span>
          <span className="mt-0.5 block text-[11px] text-ink-400">
            Sent as <code className="font-mono">x-constructos-delivery</code>. This is the
            receiver's dedupe key — it is stable across every retry.
          </span>
        </DefRow>
        <DefRow label="Signature">
          <span className="inline-flex w-full items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-700">
              {row.signature}
            </span>
            <CopyButton text={row.signature} />
          </span>
          <span className="mt-0.5 block text-[11px] text-ink-400">
            Persisted at enqueue and re-sent byte-for-byte on every attempt.
          </span>
        </DefRow>
        {row.ledgerEntryId ? (
          <DefRow label="Ledger seq">
            <Mono>{row.ledgerEntryId}</Mono>
          </DefRow>
        ) : (
          <DefRow label="Origin">
            <span className="text-ink-600">
              Synthetic test ping — not produced by a ledger append.
            </span>
          </DefRow>
        )}
        {row.error ? (
          <DefRow label="Error">
            <span className="text-red-700">{row.error}</span>
          </DefRow>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Signed body (canonical JSON — the exact bytes sent)
          </div>
          <CodeBlock className="max-h-64">{JSON.stringify(row.payload, null, 2)}</CodeBlock>
          <p className="mt-1 text-[11px] text-ink-400">
            Rendered here with indentation for reading. The bytes on the wire are canonical JSON
            with sorted keys and no whitespace — recompute the HMAC over the raw request body, not
            over a re-serialised object.
          </p>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Receiver response
          </div>
          <pre className="max-h-64 overflow-auto rounded-md bg-ink-950 p-3 text-xs leading-relaxed text-ink-100">
            {body !== "" ? body : "(no body recorded)"}
          </pre>
          <p className="mt-1 text-[11px] text-ink-400">
            {looksTruncated
              ? "Truncated server-side — the marker above is the platform's, not the receiver's."
              : bodyLimit !== null
                ? `Stored response bodies are capped at ${num(bodyLimit)} characters (WEBHOOK_RESPONSE_BODY_LIMIT). A receiver's body is evidence, not storage.`
                : "Stored response bodies are capped server-side."}
          </p>
        </div>
      </div>

      {row.status === "exhausted" ? (
        <Caveat tone="red">
          This delivery used its whole attempt budget and was abandoned. Exhaustion — and only
          exhaustion — counts against the endpoint's consecutive-failure run; enough of them and the
          endpoint auto-disables. A manual retry re-arms the full budget.
        </Caveat>
      ) : null}
      {row.status === "skipped" ? (
        <Caveat>
          Skipped: the endpoint was disabled (or deleted) when this delivery came due, so nothing
          was sent. Events emitted while an endpoint is disabled are not queued for it — re-enabling
          does not backfill them.
        </Caveat>
      ) : null}
    </div>
  );
}
