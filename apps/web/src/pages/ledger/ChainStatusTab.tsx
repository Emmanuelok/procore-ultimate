/**
 * Chain status — the verdict an auditor lives on.
 *
 * The headline is the classification itself with its specifics ("tail_truncated
 * at seal 4, expected 1,203 entries, found 1,180"), because the specifics are
 * the product; a red badge saying "problem" is not. Around it sit the things
 * that decide what the verdict is worth: which key signed, how stale the
 * newest seal is, and what a seal never proves at all.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiClientError, api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import { CopyButton } from "../assurance/assuranceShared";
import {
  ADMIN_ONLY_HINT,
  DerivedKeyNotice,
  KeyIdChip,
  LimitationsPanel,
  TimeCaveat,
  errorMessage,
  num,
  plural,
  useIsCompanyAdmin,
  useSealList,
  verdictMeta,
  type ChainVerdictResponse,
  type KeyRemedy,
  type KeysResponse,
  type RotateResponse,
  type SealCreateResponse,
  type SealView,
} from "./ledgerShared";

/** The 503 remedy the key module attaches when it refuses to seal. */
function remedyFrom(err: unknown): KeyRemedy | null {
  if (!(err instanceof ApiClientError)) return null;
  const body = err.details as { details?: { remedy?: unknown } } | undefined;
  const remedy = body?.details?.remedy;
  if (!remedy || typeof remedy !== "object") return null;
  const r = remedy as Record<string, unknown>;
  if (typeof r["variable"] !== "string") return null;
  return {
    generate: String(r["generate"] ?? ""),
    variable: String(r["variable"]),
    format: String(r["format"] ?? ""),
    note: String(r["note"] ?? ""),
  };
}

export default function ChainStatusTab() {
  const isAdmin = useIsCompanyAdmin();

  const [verdict, setVerdict] = useState<ChainVerdictResponse | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [keys, setKeys] = useState<KeysResponse | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);

  const { seals, reload: reloadSeals } = useSealList(200);

  const loadVerdict = useCallback(async () => {
    setRefreshing(true);
    setVerdictError(null);
    try {
      setVerdict(await api.get<ChainVerdictResponse>("/api/v1/ledger/chain-verdict"));
    } catch (err) {
      setVerdictError(errorMessage(err, "Failed to read the chain verdict"));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    setKeysError(null);
    try {
      setKeys(await api.get<KeysResponse>("/api/v1/ledger/keys"));
    } catch (err) {
      setKeysError(errorMessage(err, "Failed to load the key register"));
    }
  }, []);

  useEffect(() => {
    void loadVerdict();
  }, [loadVerdict]);
  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  /* ------------------------------- seal now ------------------------------- */

  const [sealOpen, setSealOpen] = useState(false);
  const [sealForce, setSealForce] = useState(false);
  const [sealNote, setSealNote] = useState("");
  const [sealBusy, setSealBusy] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  const [sealRemedy, setSealRemedy] = useState<KeyRemedy | null>(null);
  const [sealResult, setSealResult] = useState<SealCreateResponse | null>(null);

  async function submitSeal(e: FormEvent) {
    e.preventDefault();
    setSealBusy(true);
    setSealError(null);
    setSealRemedy(null);
    try {
      const payload: Record<string, unknown> = {};
      if (sealForce) payload["force"] = true;
      if (sealNote.trim()) payload["note"] = sealNote.trim();
      const res = await api.post<SealCreateResponse>("/api/v1/ledger/seals", payload);
      setSealResult(res);
      setSealOpen(false);
      setSealNote("");
      setSealForce(false);
      await loadVerdict();
      await loadKeys();
      reloadSeals();
    } catch (err) {
      setSealError(errorMessage(err, "Sealing failed"));
      setSealRemedy(remedyFrom(err));
    } finally {
      setSealBusy(false);
    }
  }

  /* ------------------------------ key rotate ------------------------------ */

  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateRemedy, setRotateRemedy] = useState<KeyRemedy | null>(null);
  const [rotateResult, setRotateResult] = useState<RotateResponse | null>(null);

  async function registerKey() {
    setRotateBusy(true);
    setRotateError(null);
    setRotateRemedy(null);
    try {
      const res = await api.post<RotateResponse>("/api/v1/ledger/keys/rotate");
      setRotateResult(res);
      await loadKeys();
    } catch (err) {
      setRotateError(errorMessage(err, "Key registration failed"));
      setRotateRemedy(remedyFrom(err));
    } finally {
      setRotateBusy(false);
    }
  }

  if (!verdict && !verdictError) return <Spinner label="Classifying the chain…" />;

  return (
    <div className="space-y-4">
      <ErrorAlert message={verdictError} />

      {verdict ? (
        <>
          <VerdictHeadline
            verdict={verdict}
            refreshing={refreshing}
            onRefresh={() => void loadVerdict()}
          />

          <Card>
            <CardBody>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink-900">Sealed coverage</h3>
                <span className="text-xs text-ink-400">
                  positions in this company's chain, 1 → {num(verdict.entryCount)}
                </span>
              </div>
              <CoverageDiagram verdict={verdict} seals={seals} />
            </CardBody>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <HeartbeatPanel verdict={verdict} />
            </div>
            <Card>
              <CardBody>
                <h3 className="text-sm font-semibold text-ink-900">Seal the chain now</h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-500">
                  Commits to the current entry count and a Merkle root over every entry hash, signs
                  it with this deployment's Ed25519 key, and chains it to the previous seal. Sealing
                  is itself a ledgered act.
                </p>
                <div className="mt-3">
                  <Button
                    onClick={() => setSealOpen(true)}
                    disabled={!isAdmin}
                    title={isAdmin ? undefined : ADMIN_ONLY_HINT}
                  >
                    Seal now
                  </Button>
                </div>
                {!isAdmin ? (
                  <p className="mt-2 text-xs text-ink-400">{ADMIN_ONLY_HINT}</p>
                ) : null}
                <ErrorAlert message={sealError} />
                {sealRemedy ? <RemedyBlock remedy={sealRemedy} /> : null}
                {sealResult ? (
                  <div className="mt-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-900 ring-1 ring-brand-200">
                    {sealResult.reused ? (
                      <>
                        <span className="font-semibold">
                          No new seal — seal {sealResult.sequence} returned.
                        </span>{" "}
                        {sealResult.note}
                      </>
                    ) : (
                      <>
                        <span className="font-semibold">
                          Seal {sealResult.sequence} written.
                        </span>{" "}
                        {num(sealResult.entryCount)} entries committed;{" "}
                        {num(sealResult.entriesSinceLastSeal)} material{" "}
                        {plural(sealResult.entriesSinceLastSeal, "entry", "entries")} appended since
                        the previous seal.
                      </>
                    )}
                    <div className="mt-1">
                      <TimeCaveat caveat={sealResult.timeCaveat} />
                    </div>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          </div>

          <KeyCustodyCard
            keys={keys}
            error={keysError}
            isAdmin={isAdmin}
            busy={rotateBusy}
            onRegister={() => void registerKey()}
            rotateError={rotateError}
            rotateRemedy={rotateRemedy}
            rotateResult={rotateResult}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <LimitationsPanel limitations={verdict.limitations} />
            <StandingCaveats sealCount={verdict.sealCount} />
          </div>
        </>
      ) : null}

      <Modal open={sealOpen} title="Seal the chain" onClose={() => setSealOpen(false)}>
        {/* The failure path keeps this modal open, so the refusal — and the
            remedy a 503 carries — has to be readable from inside it. */}
        <ErrorAlert message={sealError} />
        {sealRemedy ? <RemedyBlock remedy={sealRemedy} /> : null}
        <form onSubmit={submitSeal} className="space-y-4">
          <p className="text-sm text-ink-600">
            A seal commits to the chain as it stands: its length, its Merkle root and its head hash,
            signed with a key whose private half is not in the database.
          </p>
          <Field
            label="Note"
            hint="Stored on the ledger entry this seal writes. Optional."
          >
            <Input
              value={sealNote}
              onChange={(e) => setSealNote(e.target.value)}
              placeholder="Pre-audit seal for FY26 Q3"
            />
          </Field>
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={sealForce}
              onChange={(e) => setSealForce(e.target.checked)}
            />
            <span>
              Force a new seal
              <span className="mt-0.5 block text-xs text-ink-500">
                Without this, if nothing material has been appended since the last seal and it is
                still inside the heartbeat interval, the existing seal is returned instead of
                signing an identical head again.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSealOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={sealBusy}>
              {sealBusy ? "Sealing…" : "Seal now"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The headline                                                        */
/* ------------------------------------------------------------------ */

function VerdictHeadline({
  verdict,
  refreshing,
  onRefresh,
}: {
  verdict: ChainVerdictResponse;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const meta = verdictMeta(verdict.verdict);
  const missing =
    verdict.sealedEntryCount !== null && verdict.entryCount < verdict.sealedEntryCount
      ? verdict.sealedEntryCount - verdict.entryCount
      : 0;

  return (
    <div className={`overflow-hidden rounded-lg border ${meta.card}`}>
      <div className={`h-1 w-full ${meta.accent}`} />
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span aria-hidden className={`text-3xl leading-none ${meta.heading}`}>
              {meta.glyph}
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className={`text-xl font-semibold ${meta.heading}`}>{meta.label}</h2>
                <span className="font-mono text-xs text-ink-500">{verdict.verdict}</span>
                {meta.broken ? <Badge tone="red">Critical finding</Badge> : null}
              </div>
              <p className={`mt-1 max-w-3xl text-sm leading-relaxed ${meta.body}`}>{meta.gist}</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Re-checking…" : "Re-check now"}
          </Button>
        </div>

        {/* The server's own reason, verbatim — it names the seal and the numbers. */}
        <p className={`mt-4 max-w-4xl text-sm leading-relaxed ${meta.heading}`}>
          {verdict.reason}
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Entries now" value={num(verdict.entryCount)} />
          <Fact
            label="Entries sealed"
            value={verdict.sealedEntryCount === null ? "—" : num(verdict.sealedEntryCount)}
            hint={
              verdict.latestSealSequence === null
                ? "no seal commits to a count"
                : `committed by seal ${verdict.latestSealSequence}`
            }
            tone={missing > 0 ? "red" : undefined}
          />
          <Fact label="Seals" value={num(verdict.sealCount)} />
          <Fact
            label="Signatures checked"
            value={`${num(verdict.signaturesChecked)} of ${num(verdict.sealCount)}`}
            hint={
              verdict.unknownKeyIds.length > 0
                ? `${verdict.unknownKeyIds.length} key id(s) not on record`
                : undefined
            }
            tone={verdict.signaturesChecked < verdict.sealCount ? "amber" : undefined}
          />
          {verdict.failedSealSequence !== null ? (
            <Fact
              label="Failed at seal"
              value={`#${verdict.failedSealSequence}`}
              tone="red"
            />
          ) : null}
          {verdict.failedEntrySeq !== null ? (
            <Fact
              label="Failed at entry"
              value={`seq ${num(verdict.failedEntrySeq)}`}
              hint="global ledger sequence"
              tone="red"
            />
          ) : null}
          {verdict.suspectRange ? (
            <Fact
              label="Suspect range"
              value={`seq ${num(verdict.suspectRange.fromEntrySeq)} – ${num(
                verdict.suspectRange.toEntrySeq,
              )}`}
              hint="the failure lies inside this range"
              tone="red"
            />
          ) : null}
          {missing > 0 ? (
            <Fact
              label="Missing entries"
              value={num(missing)}
              hint={`expected ${num(verdict.sealedEntryCount)}, found ${num(verdict.entryCount)}`}
              tone="red"
            />
          ) : null}
        </dl>

        {verdict.unknownKeyIds.length > 0 ? (
          <div className="mt-4 rounded-md bg-white/70 p-3 ring-1 ring-ink-200">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Key ids with no public key on record
            </div>
            <ul className="mt-1 space-y-0.5">
              {verdict.unknownKeyIds.map((k) => (
                <li key={k} className="font-mono text-xs text-ink-700">
                  {k}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-ink-500">
              The signatures of seals made under these key ids were not checked — neither passed nor
              failed. Register the current key below, or supply the public half out of band.
            </p>
          </div>
        ) : null}

        {verdict.notes.length > 0 ? (
          <ul className="mt-4 space-y-1.5">
            {verdict.notes.map((n, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-ink-700">
                <span aria-hidden className="mt-0.5 text-ink-400">
                  ▪
                </span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {verdict.key.derivedFromAuthSecret ? (
          <DerivedKeyNotice
            note={verdict.key.weakening}
            keyId={verdict.key.keyId}
            className="mt-4"
          />
        ) : null}

        {meta.broken ? (
          <div className="mt-4 rounded-md bg-white px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
            <span className="font-semibold">Preserve a database backup now, before investigating.</span>{" "}
            This is a finding about the record itself, not about anything recorded in it: until it is
            explained, every figure this tenant can produce is unsupported by its own audit trail.
          </div>
        ) : null}

        {verdict.signalRaised ? (
          <p className="mt-3 text-sm text-ink-700">
            A critical signal was raised for this finding (
            <span className="font-mono text-xs">{verdict.signalRaised}</span>) —{" "}
            <Link to="/assurance" className="text-brand-700 underline hover:text-brand-800">
              review it on Company assurance
            </Link>
            .
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "red" | "amber";
}) {
  const color =
    tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-ink-900";
  return (
    <div className="rounded-md bg-white/80 px-3 py-2 ring-1 ring-ink-100">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>{value}</dd>
      {hint ? <dd className="text-xs text-ink-400">{hint}</dd> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Coverage diagram — hand-rolled SVG                                  */
/* ------------------------------------------------------------------ */

/**
 * What the seals actually cover, by POSITION in this company's chain.
 *
 * Only positions are plotted. `failedEntrySeq`, `fromEntrySeq` and
 * `toEntrySeq` are global `ledger_entries.seq` values shared with every other
 * tenant, so they are not positions in this chain and plotting them here would
 * invent a location that does not exist. They are stated as numbers instead.
 */
function CoverageDiagram({
  verdict,
  seals,
}: {
  verdict: ChainVerdictResponse;
  seals: SealView[] | null;
}) {
  const W = 720;
  const H = 74;
  const barY = 18;
  const barH = 26;
  const sealed = verdict.sealedEntryCount ?? 0;
  const live = verdict.entryCount;
  const span = Math.max(sealed, live, 1);
  const x = (n: number) => (Math.max(0, Math.min(n, span)) / span) * W;

  const sealedWidth = x(Math.min(sealed, live));
  const tailWidth = live > sealed ? x(live) - x(sealed) : 0;
  const missingWidth = sealed > live ? x(sealed) - x(live) : 0;

  // Ticks: every seal when there are few, otherwise a readable subset that
  // always keeps the first and the newest.
  const list = [...(seals ?? [])].sort((a, b) => a.sequence - b.sequence);
  const step = Math.max(1, Math.ceil(list.length / 12));
  const ticks = list.filter((s, i) => i % step === 0 || i === list.length - 1);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[74px] w-full min-w-[520px]" role="img">
        <defs>
          <pattern id="ledger-tail" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="#fffbeb" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#f59e0b" strokeWidth="2" />
          </pattern>
          <pattern id="ledger-missing" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="#fef2f2" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#dc2626" strokeWidth="2" />
          </pattern>
        </defs>

        <rect x={0} y={barY} width={W} height={barH} fill="#f6f7f9" stroke="#ebedf1" />
        {sealedWidth > 0 ? (
          <rect x={0} y={barY} width={sealedWidth} height={barH} fill="#3380fc" />
        ) : null}
        {tailWidth > 0 ? (
          <rect x={x(sealed)} y={barY} width={tailWidth} height={barH} fill="url(#ledger-tail)" />
        ) : null}
        {missingWidth > 0 ? (
          <rect
            x={x(live)}
            y={barY}
            width={missingWidth}
            height={barH}
            fill="url(#ledger-missing)"
          />
        ) : null}
        <rect x={0} y={barY} width={W} height={barH} fill="none" stroke="#d3d8e0" />

        {ticks.map((s) => {
          const tx = x(s.entryCount);
          return (
            <g key={s.id}>
              <line
                x1={tx}
                y1={barY - 6}
                x2={tx}
                y2={barY + barH}
                stroke={s.isHeartbeat ? "#7f8ea4" : "#142456"}
                strokeWidth={1.25}
                strokeDasharray={s.isHeartbeat ? "3 2" : undefined}
              />
              <text
                x={Math.min(tx, W - 8)}
                y={barY - 9}
                textAnchor={tx > W - 24 ? "end" : "middle"}
                fontSize={9}
                fill={s.isHeartbeat ? "#5f708a" : "#142456"}
              >
                {s.sequence}
              </text>
            </g>
          );
        })}

        <text x={2} y={barY + barH + 14} fontSize={9.5} fill="#5f708a">
          1
        </text>
        <text x={W - 2} y={barY + barH + 14} textAnchor="end" fontSize={9.5} fill="#5f708a">
          {num(span)}
        </text>
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-500">
        <LegendSwatch color="#3380fc">
          Sealed prefix — {num(Math.min(sealed, live))}{" "}
          {plural(Math.min(sealed, live), "entry", "entries")} committed by a signature
        </LegendSwatch>
        {live > sealed ? (
          <LegendSwatch color="#f59e0b" hatched>
            Unsealed tail — {num(live - sealed)} {plural(live - sealed, "entry", "entries")} covered
            by the hash chain only until the next seal
          </LegendSwatch>
        ) : null}
        {sealed > live ? (
          <LegendSwatch color="#dc2626" hatched>
            Missing — {num(sealed - live)} sealed {plural(sealed - live, "entry", "entries")} are
            not in the chain
          </LegendSwatch>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-0 border-l border-ink-950" />
          explicit seal
          <span aria-hidden className="ml-2 inline-block h-3 w-0 border-l border-dashed border-ink-400" />
          heartbeat seal
        </span>
      </div>
      {seals === null ? (
        <p className="mt-1 text-xs text-ink-400">Loading seal positions…</p>
      ) : verdict.sealCount > seals.length ? (
        <p className="mt-1 text-xs text-ink-400">
          Showing the {num(seals.length)} newest seals of {num(verdict.sealCount)}.
        </p>
      ) : null}
    </div>
  );
}

function LegendSwatch({
  color,
  hatched,
  children,
}: {
  color: string;
  hatched?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-2.5 w-4 rounded-sm"
        style={
          hatched
            ? {
                backgroundImage: `repeating-linear-gradient(45deg, ${color}, ${color} 2px, transparent 2px, transparent 4px)`,
                border: `1px solid ${color}`,
              }
            : { backgroundColor: color }
        }
      />
      <span>{children}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Heartbeat                                                           */
/* ------------------------------------------------------------------ */

function HeartbeatPanel({ verdict }: { verdict: ChainVerdictResponse }) {
  const { intervalHours, newestSealAt, newestSealIsHeartbeat, overdue } = verdict.heartbeat;
  const elapsedMs = newestSealAt ? Date.now() - Date.parse(newestSealAt) : null;
  const elapsedHours = elapsedMs === null || Number.isNaN(elapsedMs) ? null : elapsedMs / 3_600_000;
  const frac =
    elapsedHours === null ? 0 : Math.max(0, Math.min(1, elapsedHours / Math.max(intervalHours, 0.01)));

  const W = 520;
  const H = 12;

  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Heartbeat</h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-500">
              A seal only bounds truncation up to the entries it covers. A heartbeat seal re-commits
              to the head every {num(intervalHours)} {plural(intervalHours, "hour", "hours")} even
              when nothing changed, so the window in which a tail could be cut invisibly is one
              interval rather than unbounded. There is no scheduler: the sweep runs on the reads
              that care about it, including this one.
            </p>
          </div>
          {overdue === null ? (
            <Badge tone="gray">Never sealed</Badge>
          ) : overdue ? (
            <Badge tone="amber">Overdue</Badge>
          ) : (
            <Badge tone="green">Within interval</Badge>
          )}
        </div>

        <div className="mt-3 overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-3 w-full min-w-[280px]" role="img">
            <rect x={0} y={0} width={W} height={H} rx={3} fill="#ebedf1" />
            <rect
              x={0}
              y={0}
              width={frac * W}
              height={H}
              rx={3}
              fill={overdue ? "#d97706" : "#3380fc"}
            />
            <line x1={W - 1} y1={0} x2={W - 1} y2={H} stroke="#5f708a" strokeWidth={2} />
          </svg>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Interval</dt>
            <dd className="text-sm font-semibold tabular-nums text-ink-900">
              {num(intervalHours)}h
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Newest seal</dt>
            <dd className="text-sm font-semibold text-ink-900">
              {newestSealAt ? formatDateTime(newestSealAt) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Age</dt>
            <dd className="text-sm font-semibold tabular-nums text-ink-900">
              {elapsedHours === null ? "—" : `${elapsedHours.toFixed(1)}h`}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Kind</dt>
            <dd className="text-sm font-semibold text-ink-900">
              {newestSealIsHeartbeat === null
                ? "—"
                : newestSealIsHeartbeat
                  ? "Heartbeat"
                  : "Explicit"}
            </dd>
          </div>
        </dl>

        <TimeCaveat className="mt-3" />
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Key custody                                                         */
/* ------------------------------------------------------------------ */

function KeyCustodyCard({
  keys,
  error,
  isAdmin,
  busy,
  onRegister,
  rotateError,
  rotateRemedy,
  rotateResult,
}: {
  keys: KeysResponse | null;
  error: string | null;
  isAdmin: boolean;
  busy: boolean;
  onRegister: () => void;
  rotateError: string | null;
  rotateRemedy: KeyRemedy | null;
  rotateResult: RotateResponse | null;
}) {
  const current = keys?.current ?? null;
  const rows = keys?.items ?? [];
  // Every distinct weakening note among registered keys, each shown once and
  // in full: an old seal keeps the weakening that applied when it was made.
  const registerNotes = Array.from(
    new Set(
      rows.flatMap((r) => (r.derivedFromAuthSecret && r.weakening ? [r.weakening] : [])),
    ),
  ).filter((n) => n !== current?.weakening);

  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Signing key custody</h3>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-500">
              A seal is worth exactly as much as the answer to one question: who could have made it?
              Only public halves are ever stored or shown — the private half lives in the process
              environment. Key ids prefixed <span className="font-mono">ank_</span> are configured
              keys; <span className="font-mono">ankd_</span> ids were derived from AUTH_SECRET.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={onRegister}
            disabled={!isAdmin || busy}
            title={isAdmin ? undefined : ADMIN_ONLY_HINT}
          >
            {busy ? "Registering…" : "Register current public key"}
          </Button>
        </div>

        <ErrorAlert message={error} />
        <ErrorAlert message={rotateError} />
        {rotateRemedy ? <RemedyBlock remedy={rotateRemedy} /> : null}
        {rotateResult ? (
          <div className="mt-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-900 ring-1 ring-brand-200">
            <span className="font-semibold">
              {rotateResult.created ? "Public key registered." : "Public key was already on record."}
            </span>{" "}
            {rotateResult.note}
            {rotateResult.retiredOtherKeys > 0 ? (
              <>
                {" "}
                {num(rotateResult.retiredOtherKeys)} other{" "}
                {plural(rotateResult.retiredOtherKeys, "key was", "keys were")} marked retired.
              </>
            ) : null}
          </div>
        ) : null}

        {keys?.unavailable ? (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3">
            <div className="text-sm font-semibold text-red-900">
              This deployment holds no signing key — nothing can be sealed
            </div>
            <p className="mt-1 text-sm leading-relaxed text-red-900">{keys.unavailable.reason}</p>
            <RemedyBlock remedy={keys.unavailable.remedy} bare />
          </div>
        ) : null}

        {current ? (
          <div className="mt-3 rounded-md bg-ink-50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Current key
              </span>
              <KeyIdChip keyId={current.keyId} />
              <Badge tone={current.registered ? "green" : "amber"}>
                {current.registered ? "On the key register" : "Not yet registered"}
              </Badge>
              <span className="text-xs text-ink-500">source: {current.source}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-500">fingerprint (sha256 of the SPKI DER)</span>
              <span className="break-all font-mono text-xs text-ink-800">{current.fingerprint}</span>
              <CopyButton text={current.fingerprint} />
            </div>
            <p className="mt-1 text-xs text-ink-500">
              This is the value a receipt holder must compare out of band, through a channel other
              than the one that gave them the receipt.
            </p>
            {!current.registered ? (
              <p className="mt-1 text-xs text-amber-700">
                Until it is registered, seals made under this key cannot be signature-checked by
                anyone reading the key register, and an escrow receipt cannot be issued for them.
              </p>
            ) : null}
            {current.derivedFromAuthSecret ? (
              <DerivedKeyNotice note={current.weakening} keyId={current.keyId} className="mt-3" />
            ) : null}
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="mt-3">
            <Table>
              <thead>
                <tr>
                  <Th>Key id</Th>
                  <Th>Algorithm</Th>
                  <Th>Fingerprint</Th>
                  <Th>Active from</Th>
                  <Th>Retired</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((k) => (
                  <tr key={k.id}>
                    <Td>
                      <KeyIdChip keyId={k.keyId} />
                    </Td>
                    <Td className="text-xs">{k.algorithm}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono text-xs text-ink-600" title={k.fingerprint}>
                          {k.fingerprint.slice(0, 16)}…
                        </span>
                        <CopyButton text={k.fingerprint} />
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-500">
                      {formatDateTime(k.activeFrom)}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-500">
                      {k.retiredAt ? formatDateTime(k.retiredAt) : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="mt-2 text-xs text-ink-500">
              Retirement is informational: seals already made under a retired key still verify, and
              verification looks keys up by key id regardless of retirement.
            </p>
            {registerNotes.map((n, i) => (
              <DerivedKeyNotice key={i} note={n} className="mt-3" />
            ))}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** The operator's remedy, field for field, exactly as the server phrased it. */
function RemedyBlock({ remedy, bare }: { remedy: KeyRemedy; bare?: boolean }) {
  return (
    <div className={bare ? "mt-2" : "mt-2 rounded-md bg-ink-50 p-3"}>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
        What the operator has to do
      </div>
      <dl className="mt-1 space-y-1.5 text-xs text-ink-700">
        {remedy.generate ? (
          <div>
            <dt className="text-ink-500">Generate</dt>
            <dd className="flex items-center gap-2">
              <code className="break-all rounded bg-ink-950 px-1.5 py-0.5 font-mono text-[11px] text-ink-100">
                {remedy.generate}
              </code>
              <CopyButton text={remedy.generate} />
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-ink-500">Variable</dt>
          <dd className="font-mono">{remedy.variable}</dd>
        </div>
        {remedy.format ? (
          <div>
            <dt className="text-ink-500">Format</dt>
            <dd>{remedy.format}</dd>
          </div>
        ) : null}
        {remedy.note ? (
          <div>
            <dt className="text-ink-500">Note</dt>
            <dd>{remedy.note}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Standing caveats                                                    */
/* ------------------------------------------------------------------ */

function StandingCaveats({ sealCount }: { sealCount: number }) {
  return (
    <Card>
      <CardBody>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
          What sealing is, and is not
        </h3>
        <ul className="mt-2 space-y-2 text-sm leading-relaxed text-ink-700">
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-ink-300">
              ▪
            </span>
            <span>
              The hash chain is tamper-evident against edits and nothing else. Deleting the last N
              entries leaves a chain that verifies perfectly, and so does a wholesale rewrite from
              genesis — both are available to whoever controls the database.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-ink-300">
              ▪
            </span>
            <span>
              A seal closes both, because it commits to the entry count and to a Merkle root over
              every entry hash, and is signed with a key whose private half never enters the
              database. Seals chain to each other, so removing an inconvenient one is as visible as
              editing an entry.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-ink-300">
              ▪
            </span>
            <span>
              A seal proves the record has not changed since it was sealed. It says nothing about
              whether any record was <span className="font-semibold">true</span> when written —
              integrity, not accuracy.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-ink-300">
              ▪
            </span>
            <span>
              {sealCount > 0
                ? "Entries appended since the newest seal are covered by the hash chain alone: a truncation confined to them is not yet detectable. The next heartbeat seal closes that window."
                : "With no seals at all, the entire chain is in that state: nothing outside the database commits to its length or its content."}
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 text-ink-300">
              ▪
            </span>
            <span>
              Per-entry hash verification and the mutation history of any object are on a project's
              Assurance → Ledger tab. This workspace is what commits to that chain from outside it.
            </span>
          </li>
        </ul>
      </CardBody>
    </Card>
  );
}
