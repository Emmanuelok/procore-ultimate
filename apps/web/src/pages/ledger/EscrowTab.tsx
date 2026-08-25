/**
 * Escrow — handing a seal to a named third party, and checking one back.
 *
 * Escrow is what turns "we verified our own chain" into "someone else can
 * verify it". The receipt is self-contained: seal body, signature, public key,
 * fingerprint and the procedure in words, so the holder needs nothing from
 * this platform to check the signature.
 *
 * Verification never collapses into one pass/fail. `signatureValid`,
 * `key.recognized` and `scope` are three separate findings, and a receipt an
 * attacker manufactured with their own key is SELF-CONSISTENT: valid
 * signature, intact document, and only the key register catches it. So the
 * key finding is rendered as loudly as the signature one, with the out-of-band
 * comparison stated as the action it is.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import { CopyButton } from "../assurance/assuranceShared";
import {
  ADMIN_ONLY_HINT,
  DerivedKeyNotice,
  HashChipCopy,
  HashRow,
  JsonBlock,
  LimitationsPanel,
  Pager,
  VerdictBadge,
  errorMessage,
  num,
  sealLabel,
  useIsCompanyAdmin,
  useSealList,
  verdictMeta,
  type EscrowVerifyResponse,
  type IssueResponse,
  type ListResponse,
  type ReceiptRow,
} from "./ledgerShared";

const PAGE_SIZE = 20;

export default function EscrowTab() {
  const isAdmin = useIsCompanyAdmin();
  const { seals } = useSealList(200);

  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse<ReceiptRow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(
        await api.get<ListResponse<ReceiptRow>>(
          `/api/v1/ledger/escrow-receipts?page=${page}&pageSize=${PAGE_SIZE}`,
        ),
      );
    } catch (err) {
      setError(errorMessage(err, "Failed to load the escrow register"));
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  /* -------------------------------- issue -------------------------------- */

  const [sealId, setSealId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientRef, setRecipientRef] = useState("");
  const [recipientUserId, setRecipientUserId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueResponse | null>(null);

  const newestSealId = seals && seals.length > 0 ? (seals[0]?.id ?? "") : "";
  const effectiveSealId = sealId || newestSealId;

  async function issue(e: FormEvent) {
    e.preventDefault();
    if (!effectiveSealId) return;
    setIssueBusy(true);
    setIssueError(null);
    try {
      const payload: Record<string, unknown> = { recipientName: recipientName.trim() };
      if (recipientRef.trim()) payload["recipientRef"] = recipientRef.trim();
      if (recipientUserId.trim()) payload["recipientUserId"] = recipientUserId.trim();
      if (purpose.trim()) payload["purpose"] = purpose.trim();
      const res = await api.post<IssueResponse>(
        `/api/v1/ledger/seals/${effectiveSealId}/escrow`,
        payload,
      );
      setIssued(res);
      setRecipientName("");
      setRecipientRef("");
      setRecipientUserId("");
      setPurpose("");
      setPage(1);
      await load();
    } catch (err) {
      setIssueError(errorMessage(err, "Issuing the receipt failed"));
    } finally {
      setIssueBusy(false);
    }
  }

  /* ------------------------------- download ------------------------------- */

  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = useCallback(async (receiptId: string) => {
    setDownloadError(null);
    try {
      const url = await fetchBlobUrl(`/api/v1/ledger/escrow-receipts/${receiptId}/document`);
      const a = document.createElement("a");
      a.href = url;
      a.download = `constructos-escrow-receipt-${receiptId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(errorMessage(err, "Downloading the receipt document failed"));
    }
  }, []);

  /* -------------------------------- verify -------------------------------- */

  const [pasted, setPasted] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<EscrowVerifyResponse | null>(null);

  const loadIntoVerifier = useCallback(async (receiptId: string) => {
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const doc = await api.get<Record<string, unknown>>(
        `/api/v1/ledger/escrow-receipts/${receiptId}/document`,
      );
      setPasted(JSON.stringify(doc, null, 2));
    } catch (err) {
      setVerifyError(errorMessage(err, "Could not load that receipt document"));
    }
  }, []);

  async function runVerify(e: FormEvent) {
    e.preventDefault();
    setVerifyError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(pasted);
    } catch {
      setVerifyResult(null);
      setVerifyError("That is not valid JSON. Nothing was sent and nothing was verified.");
      return;
    }
    setVerifyBusy(true);
    try {
      const res = await api.post<EscrowVerifyResponse>("/api/v1/ledger/escrow/verify", parsed);
      setVerifyResult(res);
      await load();
    } catch (err) {
      setVerifyResult(null);
      setVerifyError(errorMessage(err, "Verification failed"));
    } finally {
      setVerifyBusy(false);
    }
  }

  if (!data && !error) return <Spinner label="Loading escrow receipts…" />;

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />
      <ErrorAlert message={downloadError} />

      {/* ------------------------------- issue ------------------------------ */}

      <Card>
        <CardBody>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-ink-900">Issue a receipt</h3>
            <p className="mt-0.5 max-w-4xl text-xs leading-relaxed text-ink-500">
              A receipt is a self-contained document: the seal body, its signature, the public key
              and fingerprint, and the verification procedure in words. Hand it to an auditor,
              lender, regulator or counterparty and they can later prove the chain they were shown
              is the chain that exists — or that it is not.
            </p>
          </div>
          <ErrorAlert message={issueError} />
          <form onSubmit={issue} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Seal">
              <Select value={effectiveSealId} onChange={(e) => setSealId(e.target.value)}>
                {(seals ?? []).length === 0 ? <option value="">No seals yet</option> : null}
                {(seals ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {sealLabel(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Recipient name" hint="Required — who holds this receipt.">
              <Input
                required
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                placeholder="Meridian Audit LLP"
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Recipient reference">
              <Input
                value={recipientRef}
                onChange={(e) => setRecipientRef(e.target.value)}
                placeholder="engagement MA-2026-0142"
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Recipient platform user id" hint="Optional — if they are also a user here.">
              <Input
                value={recipientUserId}
                onChange={(e) => setRecipientUserId(e.target.value)}
                placeholder="usr_…"
                className="font-mono"
                disabled={!isAdmin}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Purpose">
                <Input
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="FY26 statutory audit — evidence of ledger integrity at fieldwork start"
                  disabled={!isAdmin}
                />
              </Field>
            </div>
            <div className="sm:col-span-2 flex items-center gap-3">
              <Button
                type="submit"
                disabled={!isAdmin || issueBusy || !effectiveSealId || !recipientName.trim()}
                title={isAdmin ? undefined : ADMIN_ONLY_HINT}
              >
                {issueBusy ? "Issuing…" : "Issue receipt"}
              </Button>
              {!isAdmin ? <span className="text-xs text-ink-400">{ADMIN_ONLY_HINT}</span> : null}
            </div>
          </form>

          {issued ? (
            <div className="mt-4 rounded-md border border-brand-200 bg-brand-50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-brand-900">
                  Receipt issued to {issued.recipientName}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void download(issued.id)}>
                    Download document
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPasted(JSON.stringify(issued.document, null, 2))}
                  >
                    Load into the verifier
                  </Button>
                </div>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-brand-900">{issued.handover}</p>
              {(() => {
                const dk = documentKeyWeakening(issued.document);
                return dk.weakening ? (
                  <DerivedKeyNotice note={dk.weakening} keyId={dk.keyId} className="mt-2" />
                ) : null;
              })()}
              <div className="mt-2 rounded-md bg-white p-2 ring-1 ring-brand-100">
                <HashRow label="Receipt hash" value={issued.receiptHash} />
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-brand-900">
                  The exact document handed over
                </summary>
                <div className="mt-2">
                  <JsonBlock value={issued.document} />
                </div>
              </details>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------------ register ---------------------------- */}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink-900">Receipt register</h3>
        {items.length === 0 ? (
          <EmptyState
            title="No receipts issued"
            hint="A seal nobody else holds a copy of is still only your word for it. Issue one to a named third party."
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Issued</Th>
                  <Th>Recipient</Th>
                  <Th>Seal</Th>
                  <Th>Receipt hash</Th>
                  <Th>Purpose</Th>
                  <Th>Last presented back</Th>
                  <Th>Document</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((r) => {
                  const seal = (seals ?? []).find((s) => s.id === r.sealId) ?? null;
                  return (
                    <tr key={r.id} className="hover:bg-ink-50/60">
                      <Td className="whitespace-nowrap text-xs text-ink-500">
                        {formatDateTime(r.issuedAt)}
                      </Td>
                      <Td>
                        <div className="text-sm font-medium text-ink-900">{r.recipientName}</div>
                        {r.recipientRef ? (
                          <div className="text-xs text-ink-500">{r.recipientRef}</div>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap text-xs">
                        {seal ? (
                          <span className="inline-flex items-center gap-1.5">
                            #{seal.sequence} · {num(seal.entryCount)} entries
                            {seal.derivedFromAuthSecret ? (
                              <Badge tone="amber">ankd_ key</Badge>
                            ) : null}
                          </span>
                        ) : (
                          <span className="font-mono text-ink-500">{r.sealId}</span>
                        )}
                      </Td>
                      <Td>
                        <HashChipCopy value={r.receiptHash} />
                      </Td>
                      <Td className="max-w-xs text-xs text-ink-600">{r.purpose ?? "—"}</Td>
                      <Td className="whitespace-nowrap text-xs">
                        {r.lastVerifiedAt ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="text-ink-500">{formatDateTime(r.lastVerifiedAt)}</span>
                            <VerdictBadge verdict={r.lastVerdict} />
                          </span>
                        ) : (
                          <span className="text-ink-400">never</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onClick={() => void download(r.id)}>
                            Download
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void loadIntoVerifier(r.id)}
                          >
                            Verify
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {(() => {
              const derivedSeal =
                items
                  .map((r) => (seals ?? []).find((s) => s.id === r.sealId))
                  .find((s) => s?.derivedFromAuthSecret) ?? null;
              return derivedSeal ? (
                <DerivedKeyNotice
                  note={derivedSeal.weakening}
                  keyId={derivedSeal.keyId}
                  className="mt-3"
                />
              ) : null;
            })()}
            <Pager
              page={data?.page ?? page}
              pageSize={data?.pageSize ?? PAGE_SIZE}
              total={data?.total ?? 0}
              noun="receipt"
              onPage={setPage}
            />
          </>
        )}
      </div>

      {/* ------------------------------- verify ----------------------------- */}

      <Card>
        <CardBody>
          <h3 className="text-sm font-semibold text-ink-900">Verify a receipt</h3>
          <p className="mt-0.5 max-w-4xl text-xs leading-relaxed text-ink-500">
            Paste a receipt document — one issued here, or one a counterparty presents back — and it
            is checked against the live chain. A receipt issued for another company is checked as a
            document only: reading another tenant's chain to answer a question about their receipt
            would be a tenant-isolation breach.
          </p>
          <form onSubmit={runVerify} className="mt-3 space-y-3">
            <Textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder='{"documentType":"constructos.escrow-receipt","version":1,…}'
              className="min-h-40 font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={verifyBusy || pasted.trim().length === 0}>
                {verifyBusy ? "Verifying…" : "Verify document"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setPasted("");
                  setVerifyResult(null);
                  setVerifyError(null);
                }}
              >
                Clear
              </Button>
            </div>
          </form>
          <ErrorAlert message={verifyError} />
          {verifyResult ? <VerifyPanel result={verifyResult} /> : null}
        </CardBody>
      </Card>

      <OfflineVerificationCard />
    </div>
  );
}

/**
 * A receipt made under a derived key carries its own weakening note. Pull it
 * out of the document so it can be shown at full size rather than left for
 * the reader to find in the JSON.
 */
function documentKeyWeakening(doc: Record<string, unknown>): {
  keyId: string | null;
  weakening: string | null;
} {
  const key = doc["key"];
  if (!key || typeof key !== "object") return { keyId: null, weakening: null };
  const k = key as Record<string, unknown>;
  if (k["derivedFromAuthSecret"] !== true) return { keyId: null, weakening: null };
  return {
    keyId: typeof k["keyId"] === "string" ? k["keyId"] : null,
    weakening: typeof k["weakening"] === "string" ? k["weakening"] : null,
  };
}

/* ------------------------------------------------------------------ */
/* Verification result — three findings, never one                     */
/* ------------------------------------------------------------------ */

function VerifyPanel({ result }: { result: EscrowVerifyResponse }) {
  const meta = verdictMeta(result.verdict);
  const live = result.liveChain;
  const forgedButConsistent = result.receipt.signatureValid && !result.key.recognized;

  return (
    <div className="mt-4 space-y-4">
      <div className={`overflow-hidden rounded-lg border ${meta.card}`}>
        <div className={`h-1 w-full ${meta.accent}`} />
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span aria-hidden className={`text-2xl leading-none ${meta.heading}`}>
              {meta.glyph}
            </span>
            <span className={`text-lg font-semibold ${meta.heading}`}>{meta.label}</span>
            <span className="font-mono text-xs text-ink-500">{result.verdict}</span>
            <Badge tone={result.scope === "live_chain" ? "blue" : "amber"}>
              scope: {result.scope}
            </Badge>
          </div>
          <p className={`mt-2 max-w-4xl text-sm leading-relaxed ${meta.heading}`}>{result.reason}</p>
        </div>
      </div>

      {/* The three findings the API keeps apart, kept apart here. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Finding
          title="Signature"
          state={result.receipt.signatureValid}
          headline={
            result.receipt.signatureValid
              ? "Verifies under the key the receipt carries"
              : "Does not verify"
          }
          body={
            result.receipt.signatureValid
              ? "Ed25519 over the canonical seal body. This proves internal consistency: the document was signed by something holding the private half of the key printed inside it."
              : result.receipt.bodyError
                ? `The seal body in this receipt is malformed (${result.receipt.bodyError}), so no signature over it could be checked.`
                : "The document has been altered after issue, or it was never issued by anything holding that key."
          }
        />
        <Finding
          title="Key on the register"
          state={result.key.recognized}
          headline={
            result.key.recognized
              ? "Matches a key this platform published"
              : "NOT on this platform's key register"
          }
          body={
            result.key.recognized
              ? "The key id, fingerprint and public key in the receipt match the register held here."
              : "A receipt that carries its own key proves internal consistency only. An attacker can manufacture a whole receipt with their own key and it will show a valid signature. The key register is the only check that catches that — compare the fingerprint below against an independently obtained copy before relying on this document."
          }
          emphasize={forgedButConsistent}
        />
        <Finding
          title="Live chain"
          state={
            live.checked
              ? Boolean(live.entriesPresent && live.merkleRootMatches && live.headHashMatches)
              : null
          }
          headline={
            !live.checked
              ? "Not consulted"
              : live.entriesPresent && live.merkleRootMatches && live.headHashMatches
                ? "The sealed prefix is present and unaltered"
                : "The chain does not hold what was sealed"
          }
          body={
            live.checked
              ? `The chain now holds ${num(live.entriesNow)} entries against ${num(
                  live.entriesSealed,
                )} sealed.` +
                (live.verdict && live.verdict !== "intact"
                  ? ` The chain as a whole classifies as ${live.verdict} — a sound prefix does not vouch for the rest of it.`
                  : "")
              : (live.why ??
                "The receipt names a different company than this request's tenant context.")
          }
        />
      </div>

      {forgedButConsistent ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-3">
          <div className="text-sm font-semibold text-red-900">
            Self-consistent, and unrecognised. Compare the fingerprint out of band before relying on
            this.
          </div>
          <p className="mt-1 text-sm leading-relaxed text-red-900">
            The signature checks out against the key printed in this very document, which any forger
            can arrange. Ask the issuer for the fingerprint through a different channel than the one
            that delivered this receipt — a phone call, a signed letter, a published key page — and
            compare it character for character with the value below.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-xs text-red-900">
              {result.key.fingerprint}
            </span>
            <CopyButton text={result.key.fingerprint} />
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardBody>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              The document itself
            </h4>
            <dl className="mt-2 space-y-1.5 text-sm">
              <Line label="Receipt id" value={result.receipt.receiptId} mono />
              <Line label="Issued at" value={formatDateTime(result.receipt.issuedAt)} />
              <Line label="Issuer company" value={result.receipt.issuerCompanyId} mono />
              <Line label="Seal" value={`#${result.receipt.sealSequence}`} />
              <Line
                label="Document unaltered"
                value={result.receipt.intact ? "yes" : "NO — the receipt hash does not match"}
                tone={result.receipt.intact ? undefined : "red"}
              />
              <Line
                label="Body hash matches"
                value={result.receipt.bodyHashMatches ? "yes" : "no"}
                tone={result.receipt.bodyHashMatches ? undefined : "red"}
              />
              <Line
                label="Issued by this tenant"
                value={result.receipt.onRecord ? "yes, still on record here" : "not on record here"}
              />
              <Line
                label="Seal on record here"
                value={result.receipt.sealOnRecord ? "yes" : "no"}
              />
            </dl>
            {!result.receipt.intact ? (
              <div className="mt-2 rounded-md bg-ink-50 p-2">
                <HashRow
                  label="Recomputed receipt hash"
                  value={result.receipt.recomputedReceiptHash}
                  hint="Trust the seal fields, not the surrounding document."
                />
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              The live chain
            </h4>
            {live.checked ? (
              <dl className="mt-2 space-y-1.5 text-sm">
                <Line label="Entries sealed" value={num(live.entriesSealed)} />
                <Line
                  label="Entries now"
                  value={num(live.entriesNow)}
                  tone={
                    live.entriesNow !== undefined &&
                    live.entriesSealed !== undefined &&
                    live.entriesNow < live.entriesSealed
                      ? "red"
                      : undefined
                  }
                />
                <Line
                  label="Sealed entries present"
                  value={live.entriesPresent ? "yes" : "NO — sealed entries are missing"}
                  tone={live.entriesPresent ? undefined : "red"}
                />
                <Line
                  label="Merkle root reproduced"
                  value={live.merkleRootMatches ? "yes" : "no"}
                  tone={live.merkleRootMatches ? undefined : "red"}
                />
                <Line
                  label="Head hash still at the sealed position"
                  value={live.headHashMatches ? "yes" : "no"}
                  tone={live.headHashMatches ? undefined : "red"}
                />
                <div className="flex items-center gap-2 pt-1">
                  <dt className="text-xs text-ink-500">Whole-chain verdict</dt>
                  <dd>
                    <VerdictBadge verdict={live.verdict ?? null} />
                  </dd>
                </div>
                {live.recomputedMerkleRoot && !live.merkleRootMatches ? (
                  <div className="pt-1">
                    <HashRow label="Recomputed Merkle root" value={live.recomputedMerkleRoot} />
                  </div>
                ) : null}
              </dl>
            ) : (
              <div className="mt-2 rounded-md bg-amber-50 p-3 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-200">
                <div className="font-semibold">
                  scope: receipt_only — the live chain was not read
                </div>
                <p className="mt-1">{live.why}</p>
                <p className="mt-1">
                  Nothing here says whether that chain still contains what was sealed. Present this
                  receipt to the issuing tenant, or verify the key fingerprint out of band.
                </p>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {result.key.derivedFromAuthSecret ? (
        <DerivedKeyNotice note={result.key.weakening} keyId={result.key.keyId} />
      ) : null}

      <LimitationsPanel limitations={result.limitations} title="What this verification does not say" />

      <p className="text-xs text-ink-400">
        Verified at {formatDateTime(result.verifiedAt)}. Presenting a receipt is a consequential act
        and is itself recorded on the ledger.
      </p>
    </div>
  );
}

function Finding({
  title,
  state,
  headline,
  body,
  emphasize,
}: {
  title: string;
  state: boolean | null;
  headline: string;
  body: string;
  emphasize?: boolean;
}) {
  const tone =
    state === null
      ? "border-ink-200 bg-white"
      : state
        ? "border-emerald-300 bg-emerald-50"
        : "border-red-300 bg-red-50";
  const text =
    state === null ? "text-ink-700" : state ? "text-emerald-900" : "text-red-900";
  const glyph = state === null ? "–" : state ? "✓" : "✗";
  return (
    <div className={`rounded-lg border p-3 ${tone} ${emphasize ? "ring-2 ring-red-300" : ""}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</div>
      <div className={`mt-1 flex items-start gap-2 ${text}`}>
        <span aria-hidden className="text-lg leading-none">
          {glyph}
        </span>
        <span className="text-sm font-semibold leading-snug">{headline}</span>
      </div>
      <p className={`mt-1.5 text-xs leading-relaxed ${text}`}>{body}</p>
    </div>
  );
}

function Line({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "red";
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd
        className={`${mono ? "font-mono text-xs" : "text-sm"} ${
          tone === "red" ? "font-semibold text-red-700" : "text-ink-800"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Offline verification                                                */
/* ------------------------------------------------------------------ */

function OfflineVerificationCard() {
  const cmd = "pnpm --filter @constructos/api verify:receipt receipt.json";
  return (
    <Card>
      <CardBody>
        <h3 className="text-sm font-semibold text-ink-900">
          A counterparty does not need this platform
        </h3>
        <p className="mt-1 max-w-4xl text-sm leading-relaxed text-ink-600">
          The receipt is self-contained, and a standalone command-line verifier checks it entirely
          offline: it recomputes the receipt hash, recomputes the seal body hash from the eleven
          signed fields, and verifies the Ed25519 signature with the public key carried in the
          document. No access to this deployment is required, and any Ed25519 implementation will do
          if they would rather not run ours.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-ink-950 px-2 py-1 font-mono text-xs text-ink-100">
            {cmd}
          </code>
          <CopyButton text={cmd} />
        </div>
        <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-ink-600">
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-ink-300">
              ▪
            </span>
            <span>
              Offline verification proves the document is internally consistent and was signed by
              the holder of that key. It cannot tell the holder whether the key is ours — that is
              the fingerprint comparison, and it has to happen through a different channel than the
              one that delivered the receipt.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-ink-300">
              ▪
            </span>
            <span>
              Only the live check (pasting the document above, or the counterparty presenting it
              back to this tenant) can show whether the chain still contains what was sealed.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-ink-300">
              ▪
            </span>
            <span>
              A seal covers integrity, not accuracy: nothing in a receipt says a record was true when
              it was written, and nothing in it covers entries appended after the seal.
            </span>
          </li>
        </ul>
      </CardBody>
    </Card>
  );
}
