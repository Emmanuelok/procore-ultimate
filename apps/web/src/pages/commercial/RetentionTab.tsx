/**
 * Retention tab (spec Vol II Domain B #254).
 *
 * The retention fund is real money the employer is holding. This tab says how
 * much is held per bill, what has already been released, and what has fallen
 * due — at taking-over and at the end of the Defects Notification Period —
 * with the reason the engine gives for each answer. Where the contract has no
 * taking-over date the answer is "not yet releasable, and here is why", never
 * a number.
 *
 * Releases (cash, or a bond substituted for the cash) are recorded here, which
 * is what makes the `commercial.retention-due` sweep's signal actionable.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { RETENTION_RELEASE_KINDS } from "@constructos/shared";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  money,
  parseNum,
  todayIso,
  type BoqRow,
  type RetentionPosition,
  type RetentionRegister,
  type RetentionReleaseRow,
} from "./commercialShared";

function releaseTone(kind: string): string {
  if (kind === "bond_substitution") return "violet";
  if (kind === "dnp_end") return "emerald";
  if (kind === "taking_over") return "blue";
  return "slate";
}

export default function RetentionTab({
  projectId,
  boqs,
  onMutate,
}: {
  projectId: string;
  boqs: BoqRow[] | null;
  onMutate?: () => void;
}) {
  const [register, setRegister] = useState<RetentionRegister | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<RetentionPosition | null>(null);
  const [openBlank, setOpenBlank] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<RetentionRegister>(`/api/v1/projects/${projectId}/retention`);
      setRegister({ items: res?.items ?? [], releases: res?.releases ?? [] });
    } catch (err) {
      setRegister({ items: [], releases: [] });
      setError(err instanceof Error ? err.message : "Failed to load the retention register");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const positions = register?.items ?? null;
  const releases = register?.releases ?? [];

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Retention held</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              Per bill, with the contract&rsquo;s percentage and cap applied, and the release
              schedule the contract provides.
            </p>
          </div>
          <Button size="sm" onClick={() => setOpenBlank(true)}>
            Record a release
          </Button>
        </div>
        <ErrorAlert message={error} />

        {positions === null ? (
          <Spinner />
        ) : positions.length === 0 ? (
          <EmptyState
            title="No retention position yet"
            hint="Retention appears once an application has been raised against a bill."
          />
        ) : (
          <div className="space-y-3">
            {positions.map((p) => (
              <Card key={p.boqId}>
                <CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-ink-900">{p.boqName}</div>
                      <div className="mt-0.5 text-xs text-ink-500">
                        {p.retentionPercent}% retention
                        {p.retentionCap != null
                          ? `, capped at ${money(p.retentionCap, p.currency)}`
                          : ", uncapped"}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => setReleasing(p)}>
                      Release
                    </Button>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-ink-400">Held</div>
                      <div className="tabular-nums">{money(p.retentionHeld, p.currency)}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-ink-400">Released</div>
                      <div className="tabular-nums">{money(p.released, p.currency)}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-ink-400">
                        First tranche
                      </div>
                      <div className="tabular-nums">
                        {money(p.firstTranche, p.currency)}
                        <span className="ml-1 text-xs text-ink-400">
                          {p.firstTrancheDate ? formatDate(p.firstTrancheDate) : "— no date"}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-ink-400">Balance</div>
                      <div className="tabular-nums">
                        {money(p.secondTranche, p.currency)}
                        <span className="ml-1 text-xs text-ink-400">
                          {p.secondTrancheDate ? formatDate(p.secondTrancheDate) : "— no date"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div
                    className={`mt-3 rounded-md p-2 text-sm ring-1 ${
                      p.dueNow > 0
                        ? "bg-amber-50 text-amber-900 ring-amber-100"
                        : "bg-ink-50 text-ink-600 ring-ink-100"
                    }`}
                  >
                    <span className="font-medium">
                      {p.dueNow > 0
                        ? `${money(p.dueNow, p.currency)} due for release now`
                        : "Nothing due for release yet"}
                    </span>
                    {p.reasons.length > 0 ? (
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {p.reasons.map((r) => (
                          <li key={r}>• {r}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink-900">Releases recorded</h2>
        {releases.length === 0 ? (
          <EmptyState
            title="No release recorded"
            hint="A release (or a bond substituted for the cash) is recorded against the bill it was held under."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Released on</Th>
                <Th>Basis</Th>
                <Th>Bill</Th>
                <Th className="text-right">Amount</Th>
                <Th>Bond reference</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {releases.map((r: RetentionReleaseRow) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">{formatDate(r.releasedOn)}</Td>
                  <Td>
                    <Badge tone={releaseTone(r.kind)}>{humanize(r.kind)}</Badge>
                  </Td>
                  <Td className="text-xs text-ink-500">
                    {(boqs ?? []).find((b) => b.id === r.boqId)?.name ?? r.boqId ?? "—"}
                  </Td>
                  <Td className="text-right font-medium tabular-nums">
                    {money(r.amount, r.currency)}
                  </Td>
                  <Td className="text-xs">{r.bondReference ?? "—"}</Td>
                  <Td className="max-w-sm truncate text-xs text-ink-500">{r.reason ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <ReleaseModal
        projectId={projectId}
        boqs={boqs}
        position={releasing}
        open={releasing !== null || openBlank}
        onClose={() => {
          setReleasing(null);
          setOpenBlank(false);
        }}
        onDone={() => {
          setReleasing(null);
          setOpenBlank(false);
          void load();
          onMutate?.();
        }}
      />
    </div>
  );
}

function ReleaseModal({
  projectId,
  boqs,
  position,
  open,
  onClose,
  onDone,
}: {
  projectId: string;
  boqs: BoqRow[] | null;
  position: RetentionPosition | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<string>("taking_over");
  const [amount, setAmount] = useState("");
  const [releasedOn, setReleasedOn] = useState(todayIso());
  const [boqId, setBoqId] = useState("");
  const [bondReference, setBondReference] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setKind("taking_over");
    setAmount(position && position.dueNow > 0 ? String(position.dueNow) : "");
    setBoqId(position?.boqId ?? boqs?.[0]?.id ?? "");
    setReleasedOn(todayIso());
    setBondReference("");
    setReason("");
  }, [open, position, boqs]);

  const currency =
    position?.currency ?? (boqs ?? []).find((b) => b.id === boqId)?.currency ?? "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = parseNum(amount);
    if (typeof value !== "number" || value <= 0) {
      setError("Enter the amount being released.");
      return;
    }
    if (!boqId) {
      setError("Name the bill the retention is held under, so the release carries its currency.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/retention/releases`, {
        kind,
        amount: value,
        releasedOn,
        boqId,
        ...(bondReference.trim() ? { bondReference: bondReference.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success("Retention release recorded");
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to record the release. Recording one needs commercial admin.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Record a retention release" onClose={onClose}>
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Basis">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {RETENTION_RELEASE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Released on">
            <Input
              type="date"
              value={releasedOn}
              onChange={(e) => setReleasedOn(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Bill"
          hint="The release takes the bill's currency; a release with no bill named is refused."
        >
          <Select value={boqId} onChange={(e) => setBoqId(e.target.value)}>
            <option value="">— choose a bill —</option>
            {(boqs ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.currency})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Amount${currency ? ` (${currency})` : ""}`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {kind === "bond_substitution" ? (
          <Field label="Bond reference" hint="Required when a bond replaces the cash retention.">
            <Input
              value={bondReference}
              onChange={(e) => setBondReference(e.target.value)}
            />
          </Field>
        ) : null}
        <Field label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Recording…" : "Record release"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
