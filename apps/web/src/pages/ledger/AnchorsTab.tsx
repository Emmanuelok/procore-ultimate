/**
 * Anchors — witnessing a seal somewhere this deployment does not control.
 *
 * Two honesty rules govern this whole tab:
 *
 *  · A provider that cannot reach anywhere records `unavailable` with a detail
 *    naming the exact environment variable and URL it needs. That detail is
 *    rendered VERBATIM as configuration guidance, never flattened into a
 *    generic "failed".
 *  · A successful OpenTimestamps submission records `pending`, not `anchored`,
 *    because a calendar receipt is not yet a Bitcoin attestation. Pending is
 *    never rendered as done.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ANCHOR_PROVIDERS, type AnchorProvider } from "@constructos/shared";
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
  Textarea,
} from "../../ui";
import { formatDateTime } from "../format";
import {
  ADMIN_ONLY_HINT,
  ANCHOR_STATUS_MEANING,
  JsonBlock,
  PROVIDER_LABEL,
  Pager,
  anchorStatusTone,
  errorMessage,
  num,
  sealLabel,
  useIsCompanyAdmin,
  useSealList,
  type AnchorConfirmResponse,
  type AnchorCreateResponse,
  type AnchorRow,
  type AnchorsResponse,
  type ProviderRequirement,
  type SealView,
} from "./ledgerShared";

const PAGE_SIZE = 20;

export default function AnchorsTab() {
  const isAdmin = useIsCompanyAdmin();
  const { seals } = useSealList(200);

  const [page, setPage] = useState(1);
  const [providerFilter, setProviderFilter] = useState<"" | AnchorProvider>("");
  const [data, setData] = useState<AnchorsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (providerFilter) params.set("provider", providerFilter);
      setData(await api.get<AnchorsResponse>(`/api/v1/ledger/anchors?${params}`));
    } catch (err) {
      setError(errorMessage(err, "Failed to load anchor submissions"));
    }
  }, [page, providerFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const sealById = useMemo(() => {
    const map = new Map<string, SealView>();
    for (const s of seals ?? []) map.set(s.id, s);
    return map;
  }, [seals]);

  /* ------------------------------ submitting ------------------------------ */

  const [anchorOpen, setAnchorOpen] = useState(false);
  const [provider, setProvider] = useState<AnchorProvider>("local_signed");
  const [sealId, setSealId] = useState("");
  const [cpName, setCpName] = useState("");
  const [cpRef, setCpRef] = useState("");
  const [cpNote, setCpNote] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<AnchorCreateResponse | null>(null);

  const newestSealId = seals && seals.length > 0 ? seals[0]?.id ?? "" : "";
  const effectiveSealId = sealId || newestSealId;

  function openAnchor(p: AnchorProvider) {
    setProvider(p);
    setSubmitError(null);
    setAnchorOpen(true);
  }

  async function submitAnchor(e: FormEvent) {
    e.preventDefault();
    if (!effectiveSealId) return;
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      const payload: Record<string, unknown> = { provider };
      if (provider === "counterparty") {
        if (cpName.trim()) payload["counterpartyName"] = cpName.trim();
        if (cpRef.trim()) payload["counterpartyRef"] = cpRef.trim();
        if (cpNote.trim()) payload["note"] = cpNote.trim();
      }
      const res = await api.post<AnchorCreateResponse>(
        `/api/v1/ledger/seals/${effectiveSealId}/anchor`,
        payload,
      );
      setSubmitted(res);
      setAnchorOpen(false);
      setCpName("");
      setCpRef("");
      setCpNote("");
      setPage(1);
      await load();
    } catch (err) {
      setSubmitError(errorMessage(err, "The anchor submission failed"));
    } finally {
      setSubmitBusy(false);
    }
  }

  /* ------------------------------ confirming ------------------------------ */

  const [confirmRow, setConfirmRow] = useState<AnchorRow | null>(null);
  const [externalRef, setExternalRef] = useState("");
  const [acknowledgedBy, setAcknowledgedBy] = useState("");
  const [confirmNote, setConfirmNote] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<AnchorConfirmResponse | null>(null);

  async function submitConfirm(e: FormEvent) {
    e.preventDefault();
    if (!confirmRow) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      const payload: Record<string, unknown> = { externalRef: externalRef.trim() };
      if (acknowledgedBy.trim()) payload["acknowledgedBy"] = acknowledgedBy.trim();
      if (confirmNote.trim()) payload["note"] = confirmNote.trim();
      const res = await api.post<AnchorConfirmResponse>(
        `/api/v1/ledger/anchors/${confirmRow.id}/confirm`,
        payload,
      );
      setConfirmed(res);
      setConfirmRow(null);
      setExternalRef("");
      setAcknowledgedBy("");
      setConfirmNote("");
      await load();
    } catch (err) {
      setConfirmError(errorMessage(err, "Recording the acknowledgement failed"));
    } finally {
      setConfirmBusy(false);
    }
  }

  const [proofRow, setProofRow] = useState<AnchorRow | null>(null);

  if (!data && !error) return <Spinner label="Loading anchor submissions…" />;

  const providers = data?.providers ?? null;
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />
      <ErrorAlert message={submitError} />

      {submitted ? (
        <SubmittedBanner result={submitted} onDismiss={() => setSubmitted(null)} />
      ) : null}
      {confirmed ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          <span className="font-semibold">
            Acknowledgement recorded — {PROVIDER_LABEL[confirmed.provider]} anchor is now{" "}
            {confirmed.status}.
          </span>{" "}
          {confirmed.note}
          <button
            type="button"
            className="ml-2 text-xs underline"
            onClick={() => setConfirmed(null)}
          >
            dismiss
          </button>
        </div>
      ) : null}

      {/* ---------------------------- providers ---------------------------- */}

      <div>
        <div className="mb-2">
          <h3 className="text-sm font-semibold text-ink-900">Providers</h3>
          <p className="mt-0.5 max-w-4xl text-xs leading-relaxed text-ink-500">
            Ordered by how far outside this deployment the witness actually reaches. A provider with
            nowhere to reach records the attempt and what is missing — it does not fabricate a
            proof, and an anchor that lies about where it reached is worse than an absent one.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {ANCHOR_PROVIDERS.map((p) => (
            <ProviderCard
              key={p}
              provider={p}
              requirement={providers?.[p] ?? null}
              disabled={!isAdmin || !effectiveSealId}
              disabledHint={
                !isAdmin
                  ? ADMIN_ONLY_HINT
                  : "There is no seal to anchor yet — seal the chain first."
              }
              onAnchor={() => openAnchor(p)}
            />
          ))}
        </div>
      </div>

      {/* --------------------------- status legend -------------------------- */}

      <Card>
        <CardBody>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            What each status means
          </h3>
          <ul className="mt-2 space-y-2">
            {(Object.keys(ANCHOR_STATUS_MEANING) as (keyof typeof ANCHOR_STATUS_MEANING)[]).map(
              (s) => (
                <li key={s} className="flex items-start gap-2 text-sm text-ink-700">
                  <span className="mt-0.5 w-24 shrink-0">
                    <Badge tone={anchorStatusTone(s)}>{s}</Badge>
                  </span>
                  <span className="leading-relaxed">{ANCHOR_STATUS_MEANING[s]}</span>
                </li>
              ),
            )}
          </ul>
        </CardBody>
      </Card>

      {/* --------------------------- submissions ---------------------------- */}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink-900">Submissions</h3>
        <div className="w-64">
          <Field label="Provider">
            <Select
              value={providerFilter}
              onChange={(e) => {
                setProviderFilter(e.target.value as "" | AnchorProvider);
                setPage(1);
              }}
            >
              <option value="">All providers</option>
              {ANCHOR_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="No anchor submissions"
          hint="Anchoring hands a seal's body hash to a witness outside this deployment. Start with the local signature, and use a counterparty when you have one."
        />
      ) : (
        <>
          <div className="space-y-3">
            {items.map((row) => (
              <AnchorCard
                key={row.id}
                row={row}
                seal={sealById.get(row.sealId) ?? null}
                canConfirm={isAdmin}
                onConfirm={() => {
                  setConfirmError(null);
                  setExternalRef(row.externalRef ?? "");
                  setConfirmRow(row);
                }}
                onProof={() => setProofRow(row)}
              />
            ))}
          </div>
          <Pager
            page={data?.page ?? page}
            pageSize={data?.pageSize ?? PAGE_SIZE}
            total={data?.total ?? 0}
            noun="submission"
            onPage={setPage}
          />
        </>
      )}

      {/* ------------------------------ modals ------------------------------ */}

      <Modal
        open={anchorOpen}
        title={`Anchor with ${PROVIDER_LABEL[provider]}`}
        onClose={() => setAnchorOpen(false)}
      >
        <ErrorAlert message={submitError} />
        <form onSubmit={submitAnchor} className="space-y-4">
          <Field label="Seal" hint="The seal's body hash is the value being witnessed.">
            <Select value={effectiveSealId} onChange={(e) => setSealId(e.target.value)}>
              {(seals ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {sealLabel(s)}
                </option>
              ))}
            </Select>
          </Field>

          {provider === "counterparty" ? (
            <>
              <Field
                label="Counterparty name"
                hint="Required. Without a named third party this provider records itself unavailable rather than pretending."
              >
                <Input
                  value={cpName}
                  onChange={(e) => setCpName(e.target.value)}
                  placeholder="Meridian Audit LLP"
                />
              </Field>
              <Field label="Their reference" hint="Optional until they acknowledge receipt.">
                <Input
                  value={cpRef}
                  onChange={(e) => setCpRef(e.target.value)}
                  placeholder="MA-2026-0142"
                />
              </Field>
              <Field label="Note">
                <Textarea value={cpNote} onChange={(e) => setCpNote(e.target.value)} />
              </Field>
              <p className="text-xs leading-relaxed text-ink-500">
                This records the intent to hand the seal over. It becomes real when they return a
                reference — issue them an escrow receipt from the Escrow tab, send it, then record
                their acknowledgement here.
              </p>
            </>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAnchorOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitBusy || !effectiveSealId}>
              {submitBusy ? "Submitting…" : "Submit anchor"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={confirmRow !== null}
        title="Record a counterparty acknowledgement"
        onClose={() => setConfirmRow(null)}
      >
        <ErrorAlert message={confirmError} />
        <form onSubmit={submitConfirm} className="space-y-4">
          <p className="text-sm text-ink-600">
            Only counterparty anchors are confirmed by hand. The other providers are confirmed by
            their own response, and claiming otherwise here would fabricate a proof.
          </p>
          <Field label="Their reference" hint="Required — what the counterparty returned.">
            <Input
              required
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              placeholder="MA-2026-0142"
            />
          </Field>
          <Field label="Acknowledged by">
            <Input
              value={acknowledgedBy}
              onChange={(e) => setAcknowledgedBy(e.target.value)}
              placeholder="R. Okonjo, engagement partner"
            />
          </Field>
          <Field label="Note">
            <Textarea value={confirmNote} onChange={(e) => setConfirmNote(e.target.value)} />
          </Field>
          <p className="text-xs leading-relaxed text-ink-500">
            This is recorded as acknowledged by this platform's operator. The counterparty's own
            copy of the escrow receipt, not this row, is what makes the anchor independent.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmRow(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={confirmBusy || !externalRef.trim()}>
              {confirmBusy ? "Recording…" : "Record acknowledgement"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={proofRow !== null}
        title={proofRow ? `Proof — ${PROVIDER_LABEL[proofRow.provider]}` : ""}
        onClose={() => setProofRow(null)}
        wide
      >
        {proofRow ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-600">
              Whatever the provider returned that a third party can re-verify, exactly as stored. An{" "}
              <span className="font-mono text-xs">unavailable</span> submission carries no proof —
              only the attempt and what was required — because there is none.
            </p>
            <JsonBlock value={proofRow.proof} />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function ProviderCard({
  provider,
  requirement,
  disabled,
  disabledHint,
  onAnchor,
}: {
  provider: AnchorProvider;
  requirement: ProviderRequirement | null;
  disabled: boolean;
  disabledHint: string;
  onAnchor: () => void;
}) {
  return (
    <Card>
      <CardBody className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-ink-900">{PROVIDER_LABEL[provider]}</div>
            <div className="font-mono text-[11px] text-ink-400">{provider}</div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onAnchor}
            disabled={disabled}
            title={disabled ? disabledHint : undefined}
          >
            Anchor a seal
          </Button>
        </div>
        {requirement ? (
          <>
            <p className="mt-2 text-xs leading-relaxed text-ink-600">{requirement.note}</p>
            <div className="mt-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                Requires
              </div>
              <ul className="mt-1 space-y-1">
                {requirement.needs.map((n, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-ink-600">
                    <span aria-hidden className="mt-0.5 text-ink-300">
                      ▪
                    </span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <p className="mt-2 text-xs text-ink-400">Requirements load with the submission list.</p>
        )}
      </CardBody>
    </Card>
  );
}

function SubmittedBanner({
  result,
  onDismiss,
}: {
  result: AnchorCreateResponse;
  onDismiss: () => void;
}) {
  const tone =
    result.status === "anchored"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
      : result.status === "pending"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : result.status === "failed"
          ? "border-red-300 bg-red-50 text-red-900"
          : "border-ink-300 bg-ink-50 text-ink-800";
  return (
    <div className={`rounded-md border p-3 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">
            {PROVIDER_LABEL[result.provider]} — {result.status}
          </span>
          <Badge tone={anchorStatusTone(result.status)}>{result.status}</Badge>
          {result.status === "pending" ? (
            <span className="text-xs">not anchored yet</span>
          ) : null}
        </div>
        <button type="button" className="text-xs underline" onClick={onDismiss}>
          dismiss
        </button>
      </div>
      {result.detail ? <p className="mt-1.5 text-sm leading-relaxed">{result.detail}</p> : null}
      <p className="mt-1.5 text-sm leading-relaxed">{result.reach}</p>
      {result.externalRef ? (
        <p className="mt-1 break-all font-mono text-xs">ref {result.externalRef}</p>
      ) : null}
    </div>
  );
}

function AnchorCard({
  row,
  seal,
  canConfirm,
  onConfirm,
  onProof,
}: {
  row: AnchorRow;
  seal: SealView | null;
  canConfirm: boolean;
  onConfirm: () => void;
  onProof: () => void;
}) {
  const confirmable = row.provider === "counterparty" && row.status !== "anchored";
  // A local_signed proof records which key witnessed it. When that key was
  // derived from AUTH_SECRET the proof's own `detail` below carries the
  // weakening note verbatim; this badge makes it impossible to skim past.
  const derivedProof = row.proof["derivedFromAuthSecret"] === true;
  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink-900">
              {PROVIDER_LABEL[row.provider]}
            </span>
            <Badge tone={anchorStatusTone(row.status)}>{row.status}</Badge>
            {row.status === "pending" ? (
              <span className="text-xs text-amber-700">submitted, not yet witnessed</span>
            ) : null}
            {derivedProof ? <Badge tone="amber">witnessed by a derived key</Badge> : null}
            <span className="text-xs text-ink-500">
              {seal
                ? `seal ${seal.sequence} · ${num(seal.entryCount)} entries`
                : `seal ${row.sealId}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-400">{formatDateTime(row.requestedAt)}</span>
            <Button size="sm" variant="ghost" onClick={onProof}>
              Proof
            </Button>
            {confirmable ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={onConfirm}
                disabled={!canConfirm}
                title={canConfirm ? undefined : ADMIN_ONLY_HINT}
              >
                Record acknowledgement
              </Button>
            ) : null}
          </div>
        </div>

        {/* The provider's own words. Never paraphrased: for an unavailable
            submission this names the exact variable and URL to configure. */}
        {row.detail ? (
          <p
            className={`mt-2 rounded-md p-2.5 text-sm leading-relaxed ${
              row.status === "unavailable"
                ? "bg-ink-50 text-ink-700 ring-1 ring-ink-200"
                : "text-ink-700"
            }`}
          >
            {row.detail}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-500">
          {row.externalRef ? (
            <span className="break-all">
              ref <span className="font-mono text-ink-700">{row.externalRef}</span>
            </span>
          ) : (
            <span>no external reference</span>
          )}
          <span>
            confirmed {row.confirmedAt ? formatDateTime(row.confirmedAt) : "—"}
          </span>
          <span className="font-mono text-ink-400">{row.id}</span>
        </div>

        {row.status === "unavailable" && row.requirements ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-ink-600">
              What this provider requires
            </summary>
            <ul className="mt-1 space-y-1">
              {row.requirements.needs.map((n, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-ink-600">
                  <span aria-hidden className="mt-0.5 text-ink-300">
                    ▪
                  </span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}
