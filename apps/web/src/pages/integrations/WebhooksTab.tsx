/**
 * Webhook endpoints — the outbound half of the integration surface (#121).
 *
 * An endpoint is a standing instruction to carry facts about this tenant's
 * record to a host outside it, so this tab is written to make the consequences
 * legible rather than tidy:
 *
 *  · the signing secret is shown ONCE, at creation, and never again;
 *  · a non-https URL is flagged at creation with the API's own words;
 *  · egress is stated plainly on the create form — endpoint URLs are not
 *    restricted to an allowlist;
 *  · a fingerprint mismatch (master-key rotation) is an actionable warning
 *    naming what happened, not a red dot;
 *  · an auto-disabled endpoint shows the dispatcher's disabledReason verbatim,
 *    with the re-enable control immediately beside it.
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
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import DeliveryLog from "./DeliveryLog";
import EventKindPicker, { EventKindSummary } from "./EventKindPicker";
import {
  ADMIN_ONLY_HINT,
  Caveat,
  CopyButton,
  DefRow,
  Drawer,
  EgressNotice,
  FingerprintWarning,
  Mono,
  SecretRevealModal,
  SharedCustodyNotice,
  VerbatimBody,
  asList,
  deliveryTone,
  errorMessage,
  num,
  plural,
  type DeliveryTuning,
  type EndpointCreateResponse,
  type EndpointDetailResponse,
  type EndpointView,
  type EventCatalogue,
  type KeySource,
  type ProjectPick,
  type TestPingResponse,
} from "./integrationsShared";

export default function WebhooksTab({
  isAdmin,
  catalogue,
  catalogueError,
  projects,
  keySource,
  tuning,
  onStatusChanged,
}: {
  isAdmin: boolean;
  catalogue: EventCatalogue | null;
  catalogueError: string | null;
  projects: ProjectPick[] | null;
  keySource: KeySource | null;
  tuning: DeliveryTuning | null;
  onStatusChanged: () => void;
}) {
  const [endpoints, setEndpoints] = useState<EndpointView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/integrations/webhooks?page=1&pageSize=100");
      setEndpoints(asList<EndpointView>(res).items);
    } catch (err) {
      setEndpoints((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load webhook endpoints"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const projectName = (id: string | null) =>
    id ? (projects?.find((p) => p.id === id)?.name ?? id) : "Every project";

  /* ---------------------------- create / edit ----------------------------- */

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EndpointView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fUrl, setFUrl] = useState("");
  const [fProjectId, setFProjectId] = useState("");
  const [fKinds, setFKinds] = useState<string[]>([]);
  const [fActive, setFActive] = useState(true);

  /** The 201 body — the only moment the signing secret exists in a response. */
  const [created, setCreated] = useState<EndpointCreateResponse | null>(null);

  function openCreate() {
    setEditing(null);
    setFormError(null);
    setFName("");
    setFUrl("");
    setFProjectId("");
    setFKinds([]);
    setFActive(true);
    setFormOpen(true);
  }

  function openEdit(e: EndpointView) {
    setEditing(e);
    setFormError(null);
    setFName(e.name);
    setFUrl(e.url);
    setFProjectId(e.projectId ?? "");
    setFKinds(e.eventKinds ?? []);
    setFActive(e.isActive);
    setFormOpen(true);
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      if (editing) {
        const body: Record<string, unknown> = {
          name: fName.trim(),
          url: fUrl.trim(),
          eventKinds: fKinds,
          projectId: fProjectId === "" ? null : fProjectId,
          active: fActive,
        };
        await api.patch<EndpointView>(`/api/v1/integrations/webhooks/${editing.id}`, body);
        setFormOpen(false);
        await load();
      } else {
        const body: Record<string, unknown> = {
          name: fName.trim(),
          url: fUrl.trim(),
          eventKinds: fKinds,
          active: fActive,
        };
        if (fProjectId !== "") body["projectId"] = fProjectId;
        const res = await api.post<EndpointCreateResponse>("/api/v1/integrations/webhooks", body);
        setFormOpen(false);
        await load();
        onStatusChanged();
        setCreated(res);
      }
    } catch (err) {
      setFormError(errorMessage(err, "Failed to save the endpoint"));
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------- enable / disable ---------------------------- */

  async function onToggleActive(e: EndpointView) {
    if (
      !e.isActive &&
      !window.confirm(
        `Re-enable "${e.name}"?\n\n` +
          "This clears the consecutive-failure run and the disabled reason — an explicit " +
          "statement that the receiver is fixed. Events emitted while it was disabled were never " +
          "queued and will NOT be backfilled.",
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.patch<EndpointView>(`/api/v1/integrations/webhooks/${e.id}`, {
        active: !e.isActive,
      });
      await load();
      onStatusChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to change the endpoint state"));
    }
  }

  /* -------------------------------- delete -------------------------------- */

  const [deleted, setDeleted] = useState<{ endpointId: string; deliveriesDeleted: number } | null>(
    null,
  );

  async function onDelete(e: EndpointView) {
    if (
      !window.confirm(
        `Delete the endpoint "${e.name}"?\n\n` +
          "Its entire delivery log is deleted with it — the evidence of what left the platform " +
          "for this receiver goes too (the ledger entries remain). The signing secret cannot be " +
          "recovered or re-issued; a replacement endpoint gets a different one.\n\nThis cannot be undone.",
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await api.del<{ deleted: boolean; endpointId: string; deliveriesDeleted: number }>(
        `/api/v1/integrations/webhooks/${e.id}`,
      );
      if (detail?.endpoint.id === e.id) setDetail(null);
      await load();
      onStatusChanged();
      setDeleted({ endpointId: res.endpointId, deliveriesDeleted: res.deliveriesDeleted });
    } catch (err) {
      setError(errorMessage(err, "Failed to delete the endpoint"));
    }
  }

  /* ------------------------------- test ping ------------------------------ */

  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    endpoint: EndpointView;
    ok: boolean;
    response: TestPingResponse | null;
    message: string;
    raw: unknown;
  } | null>(null);

  async function onTest(e: EndpointView) {
    setTesting(e.id);
    setError(null);
    try {
      const res = await api.post<TestPingResponse>(
        `/api/v1/integrations/webhooks/${e.id}/test`,
        {},
      );
      setTestResult({
        endpoint: e,
        ok: res.delivery?.status === "delivered",
        response: res,
        message:
          res.delivery?.status === "delivered"
            ? "The receiver accepted the ping."
            : "The ping was attempted and did not succeed.",
        raw: res,
      });
      await load();
      onStatusChanged();
    } catch (err) {
      setTestResult({
        endpoint: e,
        ok: false,
        response: null,
        message: errorMessage(err, "The test ping could not be sent"),
        raw: err instanceof Error ? { message: err.message } : null,
      });
    } finally {
      setTesting(null);
    }
  }

  /* ------------------------------- detail --------------------------------- */

  const [detail, setDetail] = useState<EndpointDetailResponse | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const openDetail = useCallback(async (id: string) => {
    setDetailBusy(true);
    setError(null);
    try {
      setDetail(await api.get<EndpointDetailResponse>(`/api/v1/integrations/webhooks/${id}`));
    } catch (err) {
      setError(errorMessage(err, "Failed to load the endpoint"));
    } finally {
      setDetailBusy(false);
    }
  }, []);

  /* -------------------------------- render -------------------------------- */

  const rotated = (endpoints ?? []).filter((e) => !e.secretFingerprintMatches);
  const autoDisabled = (endpoints ?? []).filter((e) => !e.isActive && e.disabledReason);

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />

      <SharedCustodyNotice keySource={keySource} />

      {rotated.length > 0 ? (
        <Caveat tone="red">
          <span className="font-semibold">
            {num(rotated.length)} {plural(rotated.length, "endpoint", "endpoints")} can no longer
            reproduce {plural(rotated.length, "its", "their")} signing secret.
          </span>{" "}
          The HKDF master key changed after {plural(rotated.length, "it was", "they were")} created,
          so what is signed now no longer matches what the receiver holds. Every verification on
          their side fails, silently, while the delivery log reports the sends as attempted. Open
          the affected {plural(rotated.length, "endpoint", "endpoints")} below —{" "}
          {rotated.map((e) => e.name).join(", ")}.
        </Caveat>
      ) : null}

      {autoDisabled.length > 0 ? (
        <Caveat tone="amber">
          <span className="font-semibold">
            {num(autoDisabled.length)} disabled {plural(autoDisabled.length, "endpoint", "endpoints")}.
          </span>{" "}
          Nothing is being queued for {plural(autoDisabled.length, "it", "them")}, and events
          emitted while disabled are lost to {plural(autoDisabled.length, "it", "them")} for good —
          re-enabling does not backfill. The dispatcher's reason is shown verbatim on each row.
        </Caveat>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-ink-500">
          Endpoints subscribe to this company's hash-chained ledger: every consequential mutation
          is already observed there, so the event vocabulary cannot drift from the record. Each
          delivery is signed HMAC-SHA256 under a secret derived for that endpoint alone — see the
          Signature reference tab for the receiver-side contract.
        </p>
        <Button onClick={openCreate} disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_HINT}>
          New endpoint
        </Button>
      </div>

      {endpoints === null ? (
        <Spinner label="Loading endpoints…" />
      ) : endpoints.length === 0 ? (
        <EmptyState
          title="No webhook endpoints"
          hint="Create one to have ledger events delivered to an external system. Nothing leaves the tenant until you nominate a URL here."
          action={
            <Button onClick={openCreate} disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_HINT}>
              New endpoint
            </Button>
          }
        />
      ) : (
        <Table>
          <thead className="bg-ink-50">
            <tr>
              <Th>Endpoint</Th>
              <Th>Subscription</Th>
              <Th>Scope</Th>
              <Th>State</Th>
              <Th>Failures</Th>
              <Th>Last delivery</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50">
            {endpoints.map((e) => (
              <tr key={e.id} className="align-top hover:bg-ink-50">
                <Td>
                  <button
                    type="button"
                    className="text-left font-medium text-brand-700 hover:underline"
                    onClick={() => void openDetail(e.id)}
                  >
                    {e.name}
                  </button>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span
                      className="block max-w-xs truncate font-mono text-[11px] text-ink-500"
                      title={e.url}
                    >
                      {e.url}
                    </span>
                    {e.url.startsWith("http://") ? (
                      <Badge tone="amber">
                        <span title="Signed payloads travel in clear text on this endpoint.">
                          http
                        </span>
                      </Badge>
                    ) : null}
                  </span>
                  {!e.secretFingerprintMatches ? (
                    <span className="mt-1 block text-[11px] font-medium text-red-700">
                      Secret unreproducible — master key rotated since creation
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <EventKindSummary eventKinds={e.eventKinds ?? []} />
                </Td>
                <Td className="text-xs text-ink-600">{projectName(e.projectId)}</Td>
                <Td>
                  {e.isActive ? (
                    <Badge tone="green">Active</Badge>
                  ) : (
                    <Badge tone="gray">Disabled</Badge>
                  )}
                  {!e.isActive && e.disabledReason ? (
                    <span className="mt-1 block max-w-sm text-[11px] leading-snug text-ink-500">
                      {e.disabledReason}
                    </span>
                  ) : null}
                </Td>
                <Td className="tabular-nums">
                  {e.failureCount > 0 ? (
                    <span className="font-medium text-red-700" title="Consecutive exhausted deliveries">
                      {e.failureCount}
                      {tuning ? (
                        <span className="text-ink-400"> / {tuning.failureThreshold}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-ink-400">0</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-xs">
                  {e.lastDeliveryAt ? (
                    <>
                      {formatDateTime(e.lastDeliveryAt)}
                      {e.lastStatus ? (
                        <span className="mt-0.5 block">
                          <Badge tone={deliveryTone(e.lastStatus)}>{e.lastStatus}</Badge>
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-ink-300">Never</span>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => void openDetail(e.id)}>
                      Deliveries
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!isAdmin || !e.isActive || testing === e.id}
                      title={
                        !isAdmin
                          ? ADMIN_ONLY_HINT
                          : !e.isActive
                            ? "The API refuses (409) to test a disabled endpoint — re-enable it first."
                            : "Send a synthetic ping now and show the receiver's answer."
                      }
                      onClick={() => void onTest(e)}
                    >
                      {testing === e.id ? "Sending…" : "Test"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!isAdmin}
                      title={isAdmin ? undefined : ADMIN_ONLY_HINT}
                      onClick={() => openEdit(e)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant={e.isActive ? "ghost" : "primary"}
                      size="sm"
                      disabled={!isAdmin}
                      title={isAdmin ? undefined : ADMIN_ONLY_HINT}
                      onClick={() => void onToggleActive(e)}
                    >
                      {e.isActive ? "Disable" : "Re-enable"}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={!isAdmin}
                      title={isAdmin ? undefined : ADMIN_ONLY_HINT}
                      onClick={() => void onDelete(e)}
                    >
                      Delete
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ------------------------- create / edit form -------------------------- */}
      <Modal
        open={formOpen}
        wide
        title={editing ? `Edit endpoint — ${editing.name}` : "New webhook endpoint"}
        onClose={() => setFormOpen(false)}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <ErrorAlert message={formError} />

          {!editing ? <EgressNotice /> : null}

          <Field label="Name" hint="Name the receiving system, not a person.">
            <Input
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              required
              placeholder="e.g. Finance ERP event bridge"
            />
          </Field>

          <Field
            label="Delivery URL"
            hint="An absolute http:// or https:// URL. The API POSTs signed canonical JSON to it, unattended."
          >
            <Input
              value={fUrl}
              onChange={(e) => setFUrl(e.target.value)}
              required
              placeholder="https://receiver.example.com/constructos/events"
              className="font-mono text-xs"
            />
          </Field>
          {fUrl.trim().startsWith("http://") ? (
            <Caveat tone="red">
              <span className="font-semibold">That is an http:// URL.</span> Signed payloads will
              travel in clear text. The signature proves origin and integrity but not
              confidentiality — anyone on the path reads the object ids, actor ids and hashes. Use
              https:// in production.
            </Caveat>
          ) : null}

          <Field
            label="Project scope"
            hint="Leave company-wide unless this receiver should only ever learn about one project."
          >
            <Select value={fProjectId} onChange={(e) => setFProjectId(e.target.value)}>
              <option value="">Every project (company-wide)</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <span className="mb-1 block text-xs font-medium text-ink-600">Event subscription</span>
            <EventKindPicker
              value={fKinds}
              onChange={setFKinds}
              catalogue={catalogue}
              catalogueError={catalogueError}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-ink-800">
            <input
              type="checkbox"
              checked={fActive}
              onChange={(e) => setFActive(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            Active — deliver events to this endpoint
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !isAdmin || !fName.trim() || !fUrl.trim()}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create endpoint"}
            </Button>
          </div>
          {!editing ? (
            <p className="text-[11px] text-ink-400">
              The signing secret is generated on save and shown once, immediately, in the next
              dialog. Have the receiver's secret store open.
            </p>
          ) : (
            <p className="text-[11px] text-ink-400">
              Editing never re-issues the secret. The secret is bound to the endpoint id, so a URL
              or subscription change keeps the receiver's existing key working.
            </p>
          )}
        </form>
      </Modal>

      {/* --------------------------- show-once secret -------------------------- */}
      <SecretRevealModal
        open={created !== null}
        title={created ? `Endpoint created — ${created.endpoint.name}` : "Endpoint created"}
        warning={created?.secretWarning ?? ""}
        secretLabel="Signing secret (HMAC key for this endpoint)"
        secret={created?.secret ?? ""}
        onClose={() => setCreated(null)}
      >
        {created ? (
          <div className="space-y-3">
            {created.insecureTransport ? (
              <Caveat tone="red">
                <span className="font-semibold">Insecure transport.</span>{" "}
                {created.insecureTransport}
              </Caveat>
            ) : null}

            <SharedCustodyNotice keySource={created.signing.keySource} />

            <div className="rounded-md bg-ink-50 p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                What the receiver has to implement
              </div>
              <dl className="space-y-1 text-xs text-ink-700">
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 text-ink-400">Algorithm</dt>
                  <dd className="font-mono">{created.signing.algorithm}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 text-ink-400">String to sign</dt>
                  <dd className="font-mono break-all">{created.signing.stringToSign}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 text-ink-400">Header format</dt>
                  <dd className="font-mono break-all">{created.signing.signatureHeaderFormat}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 text-ink-400">Dedupe on</dt>
                  <dd className="font-mono">{created.signing.headers.delivery}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                {created.signing.verify}
              </p>
              <p className="mt-1 text-[11px] text-ink-400">
                The full contract, with worked verification code, is on the Signature reference tab.
              </p>
            </div>

            <div className="rounded-md bg-ink-50 p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Fingerprint held by the platform
              </div>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-600">
                  {created.endpoint.secretFingerprint}
                </span>
                <CopyButton text={created.endpoint.secretFingerprint} />
              </div>
              <p className="mt-1 text-[11px] text-ink-400">
                The database stores this sha256 and nothing else. It lets you confirm later that
                the value you saved is still the value in force; it cannot be turned back into the
                secret.
              </p>
            </div>
          </div>
        ) : null}
      </SecretRevealModal>

      {/* ------------------------------ test result ---------------------------- */}
      <Modal
        open={testResult !== null}
        wide
        title={testResult ? `Test ping — ${testResult.endpoint.name}` : "Test ping"}
        onClose={() => setTestResult(null)}
      >
        {testResult ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={testResult.ok ? "green" : "red"}>
                {testResult.response?.delivery?.status ?? "not sent"}
              </Badge>
              {(() => {
                const code = testResult.response?.delivery?.responseStatus ?? null;
                if (code === null) return null;
                return (
                  <Badge tone={code >= 200 && code < 300 ? "green" : "red"}>HTTP {code}</Badge>
                );
              })()}
              <span className="text-ink-700">{testResult.message}</span>
            </div>

            <Caveat tone="ink">
              A test ping is dispatched synchronously — the result above is the actual HTTP exchange
              that just happened, not a queued intention. It carries the same headers and the same
              string-to-sign as a real delivery, with event kind{" "}
              <code className="font-mono">ping</code>: a receiver that can verify this can verify
              everything. It is recorded in the delivery log like any other delivery.
            </Caveat>

            {(() => {
              const ping = testResult.response?.delivery ?? null;
              if (!ping) return <VerbatimBody body={testResult.raw} label="What the API said" />;
              return (
                <div className="rounded-md bg-ink-50 p-3">
                  <DefRow label="Delivery id">
                    <span className="inline-flex items-center gap-2">
                      <Mono>{ping.id}</Mono>
                      <CopyButton text={ping.id} />
                    </span>
                  </DefRow>
                  <DefRow label="Attempts">
                    <span className="tabular-nums">{ping.attempts}</span>
                  </DefRow>
                  {ping.error ? (
                    <DefRow label="Error">
                      <span className="text-red-700">{ping.error}</span>
                    </DefRow>
                  ) : null}
                  <DefRow label="Response body">
                    <pre className="max-h-48 overflow-auto rounded bg-ink-950 p-2 text-[11px] text-ink-100">
                      {ping.responseBody || "(empty)"}
                    </pre>
                  </DefRow>
                </div>
              );
            })()}

            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setTestResult(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* -------------------------- delete confirmation ------------------------ */}
      <Modal
        open={deleted !== null}
        title="Endpoint deleted"
        onClose={() => setDeleted(null)}
      >
        {deleted ? (
          <div className="space-y-3 text-sm text-ink-700">
            <p>
              Endpoint <Mono>{deleted.endpointId}</Mono> is gone, along with{" "}
              <strong>{num(deleted.deliveriesDeleted)}</strong>{" "}
              {plural(deleted.deliveriesDeleted, "delivery record", "delivery records")}.
            </p>
            <Caveat>
              The deletion itself is in the ledger, with the endpoint name, URL and the count of
              deliveries removed — but the delivery bodies and receiver responses are not
              recoverable. A new endpoint to the same URL is a different endpoint with a different
              secret.
            </Caveat>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setDeleted(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ------------------------------- detail -------------------------------- */}
      <Drawer
        open={detail !== null || detailBusy}
        wide
        title={detail ? detail.endpoint.name : "Endpoint"}
        onClose={() => setDetail(null)}
      >
        {detailBusy && !detail ? (
          <Spinner label="Loading endpoint…" />
        ) : detail ? (
          <div className="space-y-4">
            <FingerprintWarning endpoint={detail.endpoint} />

            {!detail.endpoint.isActive && detail.endpoint.disabledReason ? (
              <div className="rounded-md bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800">
                  Disabled — reason recorded by the dispatcher, verbatim
                </div>
                <p className="text-xs leading-relaxed text-amber-900">
                  {detail.endpoint.disabledReason}
                </p>
                <div className="mt-2">
                  <Button
                    size="sm"
                    disabled={!isAdmin}
                    title={isAdmin ? undefined : ADMIN_ONLY_HINT}
                    onClick={async () => {
                      await onToggleActive(detail.endpoint);
                      await openDetail(detail.endpoint.id);
                    }}
                  >
                    Re-enable this endpoint
                  </Button>
                </div>
              </div>
            ) : null}

            <Card>
              <CardBody>
                <DefRow label="URL">
                  <span className="inline-flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 break-all font-mono text-xs">
                      {detail.endpoint.url}
                    </span>
                    <CopyButton text={detail.endpoint.url} />
                  </span>
                </DefRow>
                <DefRow label="Subscription">
                  <EventKindSummary eventKinds={detail.endpoint.eventKinds ?? []} />
                </DefRow>
                <DefRow label="Project scope">{projectName(detail.endpoint.projectId)}</DefRow>
                <DefRow label="State">
                  {detail.endpoint.isActive ? (
                    <Badge tone="green">Active</Badge>
                  ) : (
                    <Badge tone="gray">Disabled</Badge>
                  )}
                </DefRow>
                <DefRow label="Consecutive failures">
                  <span className="tabular-nums">
                    {detail.endpoint.failureCount}
                    {tuning ? ` of ${tuning.failureThreshold} before auto-disable` : ""}
                  </span>
                </DefRow>
                <DefRow label="Deliveries recorded">
                  <span className="tabular-nums">{num(detail.deliveryCount)}</span>
                </DefRow>
                <DefRow label="Secret fingerprint">
                  <span className="inline-flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                      {detail.endpoint.secretFingerprint}
                    </span>
                    <CopyButton text={detail.endpoint.secretFingerprint} />
                  </span>
                  <span className="mt-0.5 block text-[11px] text-ink-400">
                    {detail.endpoint.secretFingerprintMatches
                      ? "Matches the secret derivable from the current master key — the value shown at creation is still the value in force."
                      : "Does NOT match the current master key. See the warning above."}
                  </span>
                </DefRow>
                <DefRow label="Created">
                  {formatDateTime(detail.endpoint.createdAt)} by{" "}
                  <Mono>{detail.endpoint.createdBy}</Mono>
                </DefRow>
              </CardBody>
            </Card>

            <SharedCustodyNotice keySource={detail.signing.keySource} />

            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink-900">Delivery log</h3>
              <DeliveryLog
                endpoint={detail.endpoint}
                isAdmin={isAdmin}
                tuning={tuning}
                onEndpointChanged={() => {
                  void load();
                  void openDetail(detail.endpoint.id);
                  onStatusChanged();
                }}
              />
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
