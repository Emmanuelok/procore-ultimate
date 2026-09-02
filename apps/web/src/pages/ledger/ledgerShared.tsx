/**
 * Ledger anchoring & escrow workspace — shared types and honesty components
 * (module M1; API: apps/api/src/modules/anchoring).
 *
 * The module's guarantee is narrow and exact, and this file exists so the four
 * tabs state it the same way every time:
 *
 *   · A seal commits to `entryCount` and to a Merkle root over every entry
 *     hash, signed with an Ed25519 key whose private half never enters the
 *     database. That closes tail truncation and wholesale rewrite, which the
 *     hash chain alone cannot.
 *   · `derivedFromAuthSecret: true` means the signing key is held by the same
 *     operator that runs the application. The server sends a note saying so;
 *     it is rendered VERBATIM, in the reading flow, next to whatever tick it
 *     qualifies — never in a tooltip. A green tick without it is a lie.
 *   · `sealedAt` is the app server's clock. Seals prove ORDER, not wall-clock
 *     time, until a timestamp authority is configured.
 *   · A seal covers integrity, not accuracy, and entries newer than the last
 *     seal are covered by the hash chain alone until the next heartbeat.
 *
 * Per-entry hash-chain verification and object mutation history are the
 * assurance workspace's Ledger tab; this workspace is what commits to that
 * chain from outside it.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AnchorProvider, AnchorStatus, ChainVerdict } from "@constructos/shared";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Badge, Button, Card, CardBody } from "../../ui";
import { CopyButton, truncateMiddle } from "../assurance/assuranceShared";

/* ------------------------------------------------------------------ */
/* Response types — mirrored from the API module, field for field      */
/* ------------------------------------------------------------------ */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SealKeyInfo {
  keyId: string;
  algorithm: string;
  fingerprint: string | null;
  publicKeyPem: string | null;
  derivedFromAuthSecret: boolean;
  weakening: string | null;
  /** false when no public key for this id is on record — nothing can be checked */
  known: boolean;
}

/** The exact object that was signed. Canonicalize this to reproduce the bytes. */
export interface SealBody {
  companyId: string;
  sequence: number;
  fromEntrySeq: number;
  toEntrySeq: number;
  entryCount: number;
  headHash: string;
  merkleRoot: string;
  prevSealHash: string | null;
  sealedAt: string;
  keyId: string;
  algorithm: string;
}

export interface SealView {
  id: string;
  companyId: string;
  sequence: number;
  fromEntrySeq: number;
  toEntrySeq: number;
  entryCount: number;
  headHash: string;
  merkleRoot: string;
  prevSealHash: string | null;
  bodyHash: string;
  signature: string;
  keyId: string;
  algorithm: string;
  sealedAt: string;
  isHeartbeat: boolean;
  sealedBy: string | null;
  createdAt: string;
  body: SealBody;
  key: SealKeyInfo;
  derivedFromAuthSecret: boolean;
  weakening: string | null;
  /** the server's own sentence about what sealedAt is worth */
  timeCaveat: string;
}

export interface SealCreateResponse extends SealView {
  reused: boolean;
  entriesSinceLastSeal: number;
  note?: string;
}

export interface SealVerifyResult {
  sealId: string;
  sequence: number;
  verdict: ChainVerdict;
  ok: boolean;
  reason: string;
  checks: {
    bodyWellFormed: boolean;
    bodyError: string | null;
    bodyHashMatches: boolean;
    signatureValid: boolean;
    /** false when no public key is on record: nothing was checked either way */
    signatureCheckable: boolean;
    entriesPresent: boolean;
    entryCountSealed: number;
    entryCountNow: number;
    merkleRootMatches: boolean;
    recomputedMerkleRoot: string | null;
    headHashMatches: boolean;
  };
  key: {
    keyId: string;
    fingerprint: string | null;
    derivedFromAuthSecret: boolean;
    weakening: string | null;
  };
  limitations: string[];
}

export interface ChainVerdictResponse {
  verdict: ChainVerdict;
  ok: boolean;
  entryCount: number;
  sealCount: number;
  latestSealSequence: number | null;
  sealedEntryCount: number | null;
  failedSealSequence: number | null;
  failedEntrySeq: number | null;
  suspectRange: { fromEntrySeq: number; toEntrySeq: number } | null;
  reason: string;
  signaturesChecked: number;
  unknownKeyIds: string[];
  notes: string[];
  key: { keyId: string | null; derivedFromAuthSecret: boolean; weakening: string | null };
  limitations: string[];
  companyId: string;
  heartbeat: {
    intervalHours: number;
    newestSealAt: string | null;
    newestSealIsHeartbeat: boolean | null;
    overdue: boolean | null;
  };
  signalRaised: string | null;
}

export interface KeyRow {
  id: string;
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
  fingerprint: string;
  activeFrom: string;
  retiredAt: string | null;
  derivedFromAuthSecret: boolean;
  weakening: string | null;
}

export interface CurrentKey {
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
  fingerprint: string;
  source: string;
  derivedFromAuthSecret: boolean;
  weakening: string | null;
  registered: boolean;
}

export interface KeyRemedy {
  generate: string;
  variable: string;
  format: string;
  note: string;
}

export interface KeysResponse {
  items: KeyRow[];
  current: CurrentKey | null;
  /** present when this deployment holds no signing key at all */
  unavailable: { reason: string; remedy: KeyRemedy } | null;
}

export interface RotateResponse {
  key: {
    id: string;
    keyId: string;
    algorithm: string;
    publicKeyPem: string;
    fingerprint: string;
    activeFrom: string;
    source: string;
    derivedFromAuthSecret: boolean;
    weakening: string | null;
  };
  created: boolean;
  retiredOtherKeys: number;
  note: string;
}

export interface ProviderRequirement {
  needs: string[];
  note: string;
}

export interface AnchorRow {
  id: string;
  companyId: string;
  sealId: string;
  provider: AnchorProvider;
  status: AnchorStatus;
  externalRef: string | null;
  proof: Record<string, unknown>;
  /** why an unavailable provider is unavailable — shown verbatim, as guidance */
  detail: string | null;
  requestedAt: string;
  confirmedAt: string | null;
  requirements?: ProviderRequirement;
}

export interface AnchorsResponse extends ListResponse<AnchorRow> {
  providers: Record<AnchorProvider, ProviderRequirement>;
}

export interface AnchorCreateResponse extends AnchorRow {
  requirements: ProviderRequirement;
  /** one sentence on how far this witness actually reaches */
  reach: string;
}

export interface AnchorConfirmResponse extends AnchorRow {
  note: string;
}

export interface ReceiptRow {
  id: string;
  companyId: string;
  sealId: string;
  recipientName: string;
  recipientRef: string | null;
  recipientUserId: string | null;
  receiptHash: string;
  purpose: string | null;
  issuedBy: string;
  issuedAt: string;
  lastVerifiedAt: string | null;
  lastVerdict: ChainVerdict | null;
  downloadUrl: string;
}

export interface IssueResponse {
  id: string;
  companyId: string;
  sealId: string;
  recipientName: string;
  recipientRef: string | null;
  recipientUserId: string | null;
  purpose: string | null;
  issuedAt: string;
  receiptHash: string;
  /** the self-contained document, exactly as handed over */
  document: Record<string, unknown>;
  downloadUrl: string;
  handover: string;
}

export interface EscrowVerifyResponse {
  verdict: ChainVerdict;
  ok: boolean;
  scope: "live_chain" | "receipt_only";
  reason: string;
  receipt: {
    receiptId: string;
    issuedAt: string;
    issuerCompanyId: string;
    sealId: string;
    sealSequence: number;
    onRecord: boolean;
    sealOnRecord: boolean;
    intact: boolean;
    recomputedReceiptHash: string;
    bodyHashMatches: boolean;
    signatureValid: boolean;
    bodyError: string | null;
  };
  key: {
    keyId: string;
    fingerprint: string;
    /** the receipt's key matches a key this platform has published */
    recognized: boolean;
    derivedFromAuthSecret: boolean;
    weakening: string | null;
  };
  liveChain: {
    checked: boolean;
    why?: string;
    entriesNow?: number;
    entriesSealed?: number;
    entriesPresent?: boolean;
    merkleRootMatches?: boolean;
    headHashMatches?: boolean;
    recomputedMerkleRoot?: string | null;
    verdict?: ChainVerdict | null;
  };
  limitations: string[];
  verifiedAt: string;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Counts are the product here — 1203 and 1,203 read differently under stress. */
export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Owner/admin gates every mutation. Non-admins see the controls, disabled. */
export function useIsCompanyAdmin(): boolean {
  const { company } = useAuth();
  return company?.role === "owner" || company?.role === "admin";
}

export const ADMIN_ONLY_HINT =
  "Owner or admin role required. Reading the record — including this verdict — is open to " +
  "every company member, assurance roles included.";

/* ------------------------------------------------------------------ */
/* Verdicts — six of them, each with its own face                      */
/* ------------------------------------------------------------------ */

export interface VerdictMeta {
  label: string;
  /** what the verdict asserts, in one line, without softening it */
  gist: string;
  glyph: string;
  /** true for the four verdicts that are findings about the record itself */
  broken: boolean;
  badge: string;
  card: string;
  accent: string;
  heading: string;
  body: string;
}

export const VERDICT_META: Record<ChainVerdict, VerdictMeta> = {
  intact: {
    label: "Chain intact",
    gist:
      "Every seal verifies, the seal chain is contiguous from 1, and the sealed entries are " +
      "present, unaltered, and reproduce the sealed Merkle root.",
    glyph: "✓",
    broken: false,
    badge: "green",
    card: "border-emerald-300 bg-emerald-50",
    accent: "bg-emerald-500",
    heading: "text-emerald-900",
    body: "text-emerald-900/90",
  },
  no_seals: {
    label: "No seals",
    gist:
      "Nothing outside the database commits to this chain's length or content. The hash chain " +
      "verifies internally, and would go on verifying after a truncation or a rewrite.",
    glyph: "◌",
    broken: false,
    badge: "amber",
    card: "border-dashed border-ink-300 bg-white",
    accent: "bg-ink-400",
    heading: "text-ink-900",
    body: "text-ink-600",
  },
  tail_truncated: {
    label: "Tail truncated",
    gist:
      "Entries a seal committed to are gone. The remaining chain still verifies internally — " +
      "that is exactly the attack sealing exists to catch.",
    glyph: "✂",
    broken: true,
    badge: "red",
    card: "border-red-300 bg-red-50",
    accent: "bg-red-600",
    heading: "text-red-900",
    body: "text-red-900/90",
  },
  entry_altered: {
    label: "Entry altered",
    gist:
      "A ledger row inside a sealed range no longer hashes to what was sealed. Either the row " +
      "was edited, or the history in the database is not the history that was sealed.",
    glyph: "✎",
    broken: true,
    badge: "red",
    card: "border-orange-300 bg-orange-50",
    accent: "bg-orange-600",
    heading: "text-orange-900",
    body: "text-orange-900/90",
  },
  seal_forged: {
    label: "Seal does not verify",
    gist:
      "A seal's signature fails under the key it names: the seal body was edited after signing, " +
      "or the seal was produced by something that does not hold the signing key.",
    glyph: "✗",
    broken: true,
    badge: "violet",
    card: "border-violet-300 bg-violet-50",
    accent: "bg-violet-600",
    heading: "text-violet-900",
    body: "text-violet-900/90",
  },
  seal_broken: {
    label: "Seal chain broken",
    gist:
      "The seals no longer link: one has been removed or relinked. Seals are chained to each " +
      "other precisely so that removing an inconvenient one is as visible as editing an entry.",
    glyph: "↯",
    broken: true,
    badge: "violet",
    card: "border-rose-300 bg-rose-50",
    accent: "bg-rose-600",
    heading: "text-rose-900",
    body: "text-rose-900/90",
  },
};

export function verdictMeta(verdict: ChainVerdict | string | null | undefined): VerdictMeta {
  if (verdict && verdict in VERDICT_META) return VERDICT_META[verdict as ChainVerdict];
  return {
    label: String(verdict ?? "unknown"),
    gist: "This verdict is not one the workspace knows how to interpret.",
    glyph: "?",
    broken: false,
    badge: "gray",
    card: "border-ink-300 bg-white",
    accent: "bg-ink-400",
    heading: "text-ink-900",
    body: "text-ink-600",
  };
}

export function VerdictBadge({ verdict }: { verdict: ChainVerdict | string | null | undefined }) {
  if (!verdict) return <span className="text-xs text-ink-400">—</span>;
  const meta = verdictMeta(verdict);
  return (
    <Badge tone={meta.badge}>
      <span aria-hidden className="mr-1">
        {meta.glyph}
      </span>
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* Honesty components                                                  */
/* ------------------------------------------------------------------ */

/**
 * The derived-key note, VERBATIM and in the reading flow (honesty rule 1).
 * It is not decoration around a tick: it is the qualification that makes the
 * tick true, so it is rendered at full size wherever such a tick appears.
 */
export function DerivedKeyNotice({
  note,
  keyId,
  className,
}: {
  note: string | null | undefined;
  keyId?: string | null;
  className?: string;
}) {
  if (!note) return null;
  return (
    <div
      role="note"
      className={`rounded-md border border-amber-300 bg-amber-50 p-3 ${className ?? ""}`}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-amber-700">
          ⚠
        </span>
        <span className="text-sm font-semibold text-amber-900">
          Signed with a key derived from AUTH_SECRET — the operator of this deployment holds it
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-amber-900">{note}</p>
      {keyId ? (
        <p className="mt-1.5 font-mono text-xs text-amber-800">
          key id {keyId} — the <span className="font-semibold">ankd_</span> prefix records the
          weakening permanently, so a seal made months ago still reports the weakening that applied
          when it was made.
        </p>
      ) : null}
    </div>
  );
}

/** A key id, with which kind of key it is stated rather than implied. */
export function KeyIdChip({
  keyId,
  fingerprint,
}: {
  keyId: string | null | undefined;
  fingerprint?: string | null;
}) {
  if (!keyId) return <span className="text-xs text-ink-400">no key</span>;
  const derived = keyId.startsWith("ankd_");
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-xs text-ink-700">{keyId}</span>
      <Badge tone={derived ? "amber" : "green"}>
        {derived ? "derived from AUTH_SECRET" : "configured key"}
      </Badge>
      {fingerprint ? (
        <span className="font-mono text-[11px] text-ink-400" title={fingerprint}>
          fp {truncateMiddle(fingerprint, 6)}
        </span>
      ) : null}
    </span>
  );
}

/** The server's sealedAt caveat, verbatim (honesty rule 3). */
export function TimeCaveat({ caveat, className }: { caveat?: string; className?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-ink-500 ${className ?? ""}`}>
      <span aria-hidden className="mr-1">
        ◷
      </span>
      {caveat ??
        "sealedAt is this application's clock. Until an RFC 3161 anchor succeeds, a seal proves " +
          "ORDER (it came after the previous seal), not wall-clock time."}
    </p>
  );
}

/** Every limitation the server sent, in full, none paraphrased. */
export function LimitationsPanel({
  limitations,
  title = "What this verdict does not say",
}: {
  limitations: string[] | null | undefined;
  title?: string;
}) {
  if (!limitations || limitations.length === 0) return null;
  return (
    <Card>
      <CardBody>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
        <ul className="mt-2 space-y-2">
          {limitations.map((l, i) => (
            <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-ink-700">
              <span aria-hidden className="mt-0.5 text-ink-300">
                ▪
              </span>
              <span>{l}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * A single check. Three states, never two: an unchecked check is not a pass
 * and not a failure, and collapsing it into either would be a lie.
 */
export function CheckLine({
  label,
  state,
  detail,
}: {
  label: string;
  state: boolean | null;
  detail?: ReactNode;
}) {
  const glyph = state === null ? "?" : state ? "✓" : "✗";
  const tone =
    state === null ? "text-ink-400" : state ? "text-emerald-600" : "text-red-600";
  return (
    <li className="flex items-start gap-2 py-1">
      <span aria-hidden className={`mt-0.5 w-4 text-center font-semibold ${tone}`}>
        {glyph}
      </span>
      <span className="flex-1">
        <span className={state === null ? "text-sm text-ink-500" : "text-sm text-ink-800"}>
          {label}
        </span>
        {detail ? <span className="mt-0.5 block text-xs text-ink-500">{detail}</span> : null}
      </span>
    </li>
  );
}

/** A hash, truncated with a copy control — the table form. */
export function HashChipCopy({ value, keep = 6 }: { value: string | null | undefined; keep?: number }) {
  if (!value) return <span className="text-xs text-ink-400">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs text-ink-600" title={value}>
        {truncateMiddle(value, keep)}
      </span>
      <CopyButton text={value} />
    </span>
  );
}

/** A hash in full — the detail form. Never truncated here. */
export function HashRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null | undefined;
  hint?: string;
}) {
  return (
    <div className="border-b border-ink-100 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</span>
        {value ? <CopyButton text={value} /> : null}
      </div>
      <div className="mt-1 break-all font-mono text-xs text-ink-800">{value ?? "—"}</div>
      {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  noun,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
      <span>
        {num(total)} {noun}
        {total === 1 ? "" : "s"} · page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/** JSON exactly as the server sent it, for the objects that ARE the product. */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div className={className}>
      <div className="mb-1 flex justify-end">
        <CopyButton text={text} />
      </div>
      <pre className="max-h-80 overflow-auto rounded-md bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-100">
        {text}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data hooks                                                          */
/* ------------------------------------------------------------------ */

/**
 * The seal register, newest first, for pickers and for the coverage diagram.
 * `GET /ledger/seals` also runs the heartbeat sweep, which is intended: the
 * platform has no scheduler, so the reads that care about heartbeats are what
 * keep the truncation window bounded.
 */
export function useSealList(pageSize = 200): {
  seals: SealView[] | null;
  total: number;
  error: string | null;
  reload: () => void;
} {
  const [seals, setSeals] = useState<SealView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<SealView>>(
        `/api/v1/ledger/seals?page=1&pageSize=${pageSize}`,
      );
      setSeals(res.items);
      setTotal(res.total);
    } catch (err) {
      setSeals((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load the seal register"));
    }
  }, [pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  return { seals, total, error, reload: () => void load() };
}

export function sealLabel(seal: SealView): string {
  return `Seal ${seal.sequence} · ${num(seal.entryCount)} entries · ${
    seal.isHeartbeat ? "heartbeat" : "explicit"
  }`;
}

/** Provider names as an operator would say them. */
export const PROVIDER_LABEL: Record<AnchorProvider, string> = {
  local_signed: "Local signature",
  rfc3161: "RFC 3161 timestamp authority",
  opentimestamps: "OpenTimestamps calendar",
  counterparty: "Named counterparty",
};

/**
 * Anchor status tones. `pending` is deliberately NOT green: an OpenTimestamps
 * calendar receipt is a submission, not a Bitcoin attestation, and a
 * counterparty anchor is aspirational until they acknowledge it.
 */
export function anchorStatusTone(status: AnchorStatus | string): string {
  switch (status) {
    case "anchored":
      return "green";
    case "pending":
      return "amber";
    case "failed":
      return "red";
    case "unavailable":
      return "gray";
    default:
      return "gray";
  }
}

export const ANCHOR_STATUS_MEANING: Record<AnchorStatus, string> = {
  anchored: "A witness outside this database holds the seal, and the proof is recorded here.",
  pending:
    "Submitted but not yet witnessed. A fresh OpenTimestamps calendar receipt commits the digest " +
    "to that calendar and is not yet a Bitcoin attestation; a counterparty anchor is pending " +
    "until they return an acknowledgement reference. Pending is not done.",
  unavailable:
    "Nothing was witnessed anywhere. The submission records the attempt and exactly what is " +
    "missing — read the detail as configuration guidance, not as a failure of the ledger.",
  failed:
    "The provider was reachable and refused the request. No proof was issued, so nothing is " +
    "anchored.",
};
