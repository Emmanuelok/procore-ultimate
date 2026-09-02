/**
 * Seals — the register of signed commitments to this company's chain.
 *
 * Hashes are truncated in the table with a copy control and shown in full in
 * the detail view, because a truncated hash is a label and a full hash is
 * evidence. Every row says which key it was made under: an old seal keeps the
 * weakening that applied when it was made, so a seal signed under an `ankd_`
 * key stays weakened even after a real key is configured.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Modal,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import {
  CheckLine,
  DerivedKeyNotice,
  HashChipCopy,
  HashRow,
  JsonBlock,
  KeyIdChip,
  LimitationsPanel,
  Pager,
  TimeCaveat,
  VerdictBadge,
  errorMessage,
  num,
  verdictMeta,
  type ListResponse,
  type SealVerifyResult,
  type SealView,
} from "./ledgerShared";

const PAGE_SIZE = 20;

export default function SealsTab() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse<SealView> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SealView | null>(null);

  /** verify results by seal id — kept so the table shows what was checked */
  const [verified, setVerified] = useState<Record<string, SealVerifyResult>>({});
  const [verifyBusy, setVerifyBusy] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<SealView>>(
        `/api/v1/ledger/seals?page=${page}&pageSize=${PAGE_SIZE}`,
      );
      setData(res);
    } catch (err) {
      setData({ items: [], total: 0, page, pageSize: PAGE_SIZE });
      setError(errorMessage(err, "Failed to load the seal register"));
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const runVerify = useCallback(async (seal: SealView) => {
    setVerifyBusy(seal.id);
    setVerifyError(null);
    try {
      const res = await api.get<SealVerifyResult>(`/api/v1/ledger/seals/${seal.id}/verify`);
      setVerified((prev) => ({ ...prev, [seal.id]: res }));
    } catch (err) {
      setVerifyError(errorMessage(err, `Verification of seal ${seal.sequence} failed`));
    } finally {
      setVerifyBusy(null);
    }
  }, []);

  if (!data && !error) return <Spinner label="Loading seals…" />;

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />
      <ErrorAlert message={verifyError} />

      {items.length === 0 ? (
        <EmptyState
          title="No seals yet"
          hint="Nothing outside the database commits to this chain's length or content. Seal it from the Chain status tab."
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Seq</Th>
                <Th>Kind</Th>
                <Th>Covers (entry seq)</Th>
                <Th>Entries</Th>
                <Th>Head hash</Th>
                <Th>Merkle root</Th>
                <Th>Signed under</Th>
                <Th>Sealed at *</Th>
                <Th>Re-verify</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((s) => {
                const result = verified[s.id];
                return (
                  <tr key={s.id} className="hover:bg-ink-50/60">
                    <Td>
                      <button
                        type="button"
                        className="font-mono text-sm font-semibold text-brand-700 hover:text-brand-800"
                        onClick={() => setSelected(s)}
                      >
                        #{s.sequence}
                      </button>
                    </Td>
                    <Td>
                      <Badge tone={s.isHeartbeat ? "gray" : "blue"}>
                        {s.isHeartbeat ? "Heartbeat" : "Explicit"}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums text-xs text-ink-600">
                      {num(s.fromEntrySeq)} → {num(s.toEntrySeq)}
                    </Td>
                    <Td className="tabular-nums font-medium">{num(s.entryCount)}</Td>
                    <Td>
                      <HashChipCopy value={s.headHash} />
                    </Td>
                    <Td>
                      <HashChipCopy value={s.merkleRoot} />
                    </Td>
                    <Td>
                      <KeyIdChip keyId={s.keyId} />
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-500">
                      {formatDateTime(s.sealedAt)}
                    </Td>
                    <Td>
                      {result ? (
                        <button
                          type="button"
                          onClick={() => setSelected(s)}
                          className="inline-flex items-center gap-1"
                          title="Open the seal to read the full check list"
                        >
                          <VerdictBadge verdict={result.verdict} />
                        </button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={verifyBusy === s.id}
                          onClick={() => void runVerify(s)}
                        >
                          {verifyBusy === s.id ? "Checking…" : "Verify"}
                        </Button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>

          {/* One copy of the weakening note per page of seals, in full: the
              row badges say WHICH seals it applies to, this says what it means. */}
          {(() => {
            const derived = items.find((s) => s.derivedFromAuthSecret && s.weakening);
            return derived ? (
              <DerivedKeyNotice note={derived.weakening} keyId={derived.keyId} />
            ) : null;
          })()}

          <Card>
            <CardBody className="py-3">
              <TimeCaveat caveat={items[0]?.timeCaveat} />
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                Entry sequences are the global <span className="font-mono">ledger_entries.seq</span>{" "}
                and are shared with every tenant, so the covered range is not the same arithmetic as
                the entry count. The count is what a truncation is measured against.
              </p>
            </CardBody>
          </Card>

          <Pager
            page={data?.page ?? page}
            pageSize={data?.pageSize ?? PAGE_SIZE}
            total={data?.total ?? 0}
            noun="seal"
            onPage={setPage}
          />
        </>
      )}

      <Modal
        open={selected !== null}
        title={selected ? `Seal ${selected.sequence}` : ""}
        onClose={() => setSelected(null)}
        wide
      >
        {selected ? (
          <SealDetail
            seal={selected}
            result={verified[selected.id] ?? null}
            busy={verifyBusy === selected.id}
            onVerify={() => void runVerify(selected)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function SealDetail({
  seal,
  result,
  busy,
  onVerify,
}: {
  seal: SealView;
  result: SealVerifyResult | null;
  busy: boolean;
  onVerify: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={seal.isHeartbeat ? "gray" : "blue"}>
          {seal.isHeartbeat ? "Heartbeat seal" : "Explicit seal"}
        </Badge>
        <KeyIdChip keyId={seal.keyId} fingerprint={seal.key.fingerprint} />
        <span className="text-xs text-ink-500">{seal.algorithm}</span>
        <span className="font-mono text-xs text-ink-400">{seal.id}</span>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Small label="Entries committed" value={num(seal.entryCount)} />
        <Small label="From entry seq" value={num(seal.fromEntrySeq)} />
        <Small label="To entry seq" value={num(seal.toEntrySeq)} />
        <Small label="Sealed at" value={formatDateTime(seal.sealedAt)} />
      </dl>

      <TimeCaveat caveat={seal.timeCaveat} />

      {seal.derivedFromAuthSecret ? (
        <DerivedKeyNotice note={seal.weakening} keyId={seal.keyId} />
      ) : null}

      <div className="rounded-md bg-white p-3 ring-1 ring-ink-100">
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
          Committed values
        </h4>
        <HashRow label="Head hash" value={seal.headHash} hint="entryHash of the last entry at seal time" />
        <HashRow
          label="Merkle root"
          value={seal.merkleRoot}
          hint="over every entry hash in the chain at seal time"
        />
        <HashRow
          label="Previous seal hash"
          value={seal.prevSealHash}
          hint={
            seal.prevSealHash
              ? "the body hash of the seal before this one — this is what makes seal removal visible"
              : "null: this is seal 1, which must have no predecessor"
          }
        />
        <HashRow label="Body hash" value={seal.bodyHash} hint="sha256 of the canonical seal body" />
        <HashRow
          label="Signature"
          value={seal.signature}
          hint="base64 Ed25519 over the canonical body bytes"
        />
        {seal.key.fingerprint ? (
          <HashRow
            label="Key fingerprint"
            value={seal.key.fingerprint}
            hint="sha256 of the SPKI DER public key — the value to compare out of band"
          />
        ) : null}
      </div>

      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
          The exact object that was signed
        </h4>
        <p className="mb-2 text-xs text-ink-500">
          Canonicalize this (RFC 8785-style: keys sorted, no insignificant whitespace) and its
          sha256 is the body hash above; the signature is over those same bytes.
        </p>
        <JsonBlock value={seal.body} />
      </div>

      {seal.key.publicKeyPem ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Public key (SPKI PEM)
          </h4>
          <JsonBlock value={seal.key.publicKeyPem} />
        </div>
      ) : (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          No public key is on record for key id{" "}
          <span className="font-mono">{seal.keyId}</span>. This seal's signature cannot be checked
          by anyone — it has not failed, it has not been checked. Register the key from the Chain
          status tab.
        </div>
      )}

      <div className="rounded-md bg-ink-50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-ink-900">Re-verify against the live chain</h4>
            <p className="mt-0.5 text-xs text-ink-500">
              Recomputes the body hash, checks the signature, and confirms the entries this seal
              committed to are still present, unaltered, and produce the sealed Merkle root.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onVerify} disabled={busy}>
            {busy ? "Checking…" : result ? "Re-check" : "Verify"}
          </Button>
        </div>

        {result ? <VerifyResultBlock result={result} /> : null}
      </div>
    </div>
  );
}

function VerifyResultBlock({ result }: { result: SealVerifyResult }) {
  const meta = verdictMeta(result.verdict);
  const c = result.checks;
  return (
    <div className="mt-3 space-y-3">
      <div className={`rounded-md border p-3 ${meta.card}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden className={`text-lg ${meta.heading}`}>
            {meta.glyph}
          </span>
          <span className={`text-sm font-semibold ${meta.heading}`}>{meta.label}</span>
          <span className="font-mono text-xs text-ink-500">{result.verdict}</span>
        </div>
        <p className={`mt-1 text-sm leading-relaxed ${meta.heading}`}>{result.reason}</p>
      </div>

      <ul className="rounded-md bg-white p-3 ring-1 ring-ink-100">
        <CheckLine
          label="Seal body is well formed"
          state={c.bodyWellFormed}
          detail={c.bodyError ?? undefined}
        />
        <CheckLine
          label="Stored body hash matches the body"
          state={c.bodyHashMatches}
        />
        <CheckLine
          label="Ed25519 signature verifies"
          state={c.signatureCheckable ? c.signatureValid : null}
          detail={
            c.signatureCheckable
              ? undefined
              : "No public key is on record for this seal's key id, so the signature was NOT checked — this is neither a pass nor a failure."
          }
        />
        <CheckLine
          label="Sealed entries are still present"
          state={c.entriesPresent}
          detail={`sealed ${num(c.entryCountSealed)} · chain now holds ${num(c.entryCountNow)}${
            c.entryCountNow < c.entryCountSealed
              ? ` — ${num(c.entryCountSealed - c.entryCountNow)} missing`
              : ""
          }`}
        />
        <CheckLine
          label="Sealed prefix reproduces the Merkle root"
          state={c.merkleRootMatches}
          detail={
            c.merkleRootMatches
              ? undefined
              : `recomputed ${c.recomputedMerkleRoot ?? "nothing — the prefix is incomplete"}`
          }
        />
        <CheckLine label="Head hash still stands at the sealed position" state={c.headHashMatches} />
      </ul>

      {result.key.derivedFromAuthSecret ? (
        <DerivedKeyNotice note={result.key.weakening} keyId={result.key.keyId} />
      ) : null}

      <LimitationsPanel limitations={result.limitations} title="What this check does not say" />
    </div>
  );
}

function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-ink-50 px-3 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-ink-900">{value}</dd>
    </div>
  );
}
